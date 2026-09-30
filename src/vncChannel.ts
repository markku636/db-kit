// 讓 noVNC 跑在 Tauri IPC 上的「假 WebSocket」。
//
// noVNC 1.7 的 `new RFB(target, urlOrChannel)` 可以吃一個現成的通道物件（原本給 RTCDataChannel 用）：
// Websock.attach 只檢查物件上（自有或原型上）有沒有 send / close / binaryType / onerror / onmessage /
// onopen / protocol / readyState，readyState 可以是 RTCDataChannel 的字串 "connecting" | "open" |
// "closing" | "closed"。我們的 VNC 連線由後端（Rust）開 TCP（可能經 SSH 通道），位元組經 IPC 往返，
// 所以做一個長得像 WebSocket 的轉接器，讓 noVNC 的 RFB 協定實作原封不動地用。
//
// 兩個踩過的坑：
//   1. noVNC 的 flush() 是 `send(new Uint8Array(this._sQ.buffer, 0, len))`，而 _sQ 會被重複使用；
//      send() 必須當場 `.slice()` 複製，否則 IPC 真正送出時內容已被下一則訊息覆蓋。
//   2. RFB 對「已經 open 的通道」是在 setTimeout 之後才 attach 並掛上 onmessage；
//      這之間到的資料（伺服器一連上就送的 ProtocolVersion）若直接丟給 null handler 就沒了，
//      握手會卡死。所以 onmessage 做成 accessor：還沒有 handler 時先暫存，掛上後在 microtask 補送。
//
// 寫入走有序佇列：同時最多一個 io.write 在路上，期間 send 的位元組併成一塊，等前一個完成再送——
// 保證順序，也把 noVNC 一次送出的多個小訊息（指標事件、按鍵）合併成一次 IPC。

export type VncReadyState = "connecting" | "open" | "closing" | "closed";

/** 後端 I/O：寫入要照呼叫順序完成；reject 視為連線斷了。 */
export interface VncChannelIo {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface VncOpenEvent {
  type: "open";
}
export interface VncMessageEvent {
  type: "message";
  data: ArrayBuffer;
}
export interface VncCloseEvent {
  type: "close";
  /** 1000 = 正常關閉、1006 = 異常中斷（沿用 WebSocket 的碼，noVNC 會顯示在斷線原因裡）。 */
  code: number;
  reason: string;
  wasClean: boolean;
}
export interface VncErrorEvent {
  type: "error";
  message: string;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export class VncChannel {
  binaryType = "arraybuffer";
  protocol = "";
  readyState: VncReadyState = "connecting";
  onopen: ((e: VncOpenEvent) => void) | null = null;
  onclose: ((e: VncCloseEvent) => void) | null = null;
  onerror: ((e: VncErrorEvent) => void) | null = null;

  private io: VncChannelIo;
  private messageHandler: ((e: VncMessageEvent) => void) | null = null;
  /** 還沒 open、或還沒有 onmessage 時收到的資料，照順序暫存。 */
  private inbox: ArrayBuffer[] = [];
  private draining = false;
  private flushScheduled = false;
  /** 等著寫出的位元組（writing 期間 send 進來的）。 */
  private outbox: Uint8Array[] = [];
  private writing = false;
  /** 使用者呼叫過 close()：等佇列寫完再關後端。 */
  private closeRequested = false;

  constructor(io: VncChannelIo) {
    this.io = io;
  }

  get onmessage(): ((e: VncMessageEvent) => void) | null {
    return this.messageHandler;
  }

  set onmessage(fn: ((e: VncMessageEvent) => void) | null) {
    this.messageHandler = fn;
    // 補送暫存資料排到 microtask：noVNC 掛 onmessage 時 attach 還沒做完（onopen / onclose 還沒掛），
    // 同步送進去會在 RFB 狀態還沒準備好時就開始解析。
    if (fn && this.inbox.length && this.readyState === "open" && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        this.drainInbox();
      });
    }
  }

  // ---- noVNC 呼叫的 WebSocket 介面 ----

  /** 複製後排進寫入佇列；closing / closed 時什麼都不做。 */
  send(data: ArrayBuffer | Uint8Array): void {
    if (this.readyState === "closing" || this.readyState === "closed" || this.closeRequested) return;
    const copy = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
    if (!copy.length) return;
    this.outbox.push(copy);
    this.pump();
  }

  /** 使用者（noVNC disconnect）要關：先把已 send 的寫完，再關後端，最後觸發 onclose。 */
  close(): void {
    if (this.readyState === "closing" || this.readyState === "closed") return;
    this.readyState = "closing";
    this.closeRequested = true;
    if (!this.writing) this.closeIo();
  }

  // ---- 我們的程式碼（後端事件）呼叫的驅動介面 ----

  /** 後端連上了：狀態轉 open、觸發 onopen，再依序補送 open 之前收到的資料。 */
  markOpen(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this.onopen?.({ type: "open" });
    this.drainInbox();
  }

  /** 後端送來一塊資料。還沒 open 或還沒有 handler 就先暫存；關閉後丟棄。 */
  deliver(data: ArrayBuffer): void {
    if (this.readyState === "closed") return;
    this.inbox.push(data);
    this.drainInbox();
  }

  /**
   * 連線結束（後端回報斷線、寫入失敗、或我們自己 close 完成）。只觸發一次；
   * 不乾淨的結束先觸發 onerror 再 onclose（與瀏覽器 WebSocket 的順序相同）。
   */
  markClosed(reason?: string, clean = true): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.inbox = [];
    this.outbox = [];
    const msg = reason ?? "";
    if (!clean) this.onerror?.({ type: "error", message: msg });
    this.onclose?.({ type: "close", code: clean ? 1000 : 1006, reason: msg, wasClean: clean });
  }

  // ---- 內部 ----

  private drainInbox(): void {
    if (this.draining) return; // handler 裡又 deliver：交給外層迴圈照順序送
    this.draining = true;
    try {
      while (this.inbox.length && this.readyState === "open" && this.messageHandler) {
        const data = this.inbox.shift()!;
        this.messageHandler({ type: "message", data });
      }
    } finally {
      this.draining = false;
    }
  }

  private pump(): void {
    if (this.writing || !this.outbox.length || this.readyState === "closed") return;
    const bytes = concat(this.outbox);
    this.outbox = [];
    this.writing = true;
    let p: Promise<void>;
    try {
      p = this.io.write(bytes);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      () => {
        this.writing = false;
        if (this.readyState === "closed") return;
        if (this.outbox.length) this.pump();
        else if (this.closeRequested) this.closeIo();
      },
      (e) => {
        this.writing = false;
        this.markClosed(errorMessage(e), false);
      },
    );
  }

  private closeIo(): void {
    if (this.readyState === "closed") return;
    let p: Promise<void>;
    try {
      p = this.io.close();
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      () => this.markClosed(undefined, true),
      (e) => this.markClosed(errorMessage(e), false),
    );
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
