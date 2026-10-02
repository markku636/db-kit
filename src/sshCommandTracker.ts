// 終端機「剛剛執行了哪條指令」：使用者按 Enter 時從 xterm 畫面讀出提示符後面的那一段，等回顯完再讀一次補齊，
// 交給呼叫端記進 SSH 操作紀錄。為什麼從畫面讀、不記鍵盤（密碼提示下打的字不會回顯）見 sshOpLog.ts。
//
// 提示符在哪裡結束：這一行第一次按鍵時游標的位置（那時提示符已經印完、使用者還沒打字）。認不出來時
// （先打字才出現提示符、Ctrl+L 重畫、非 bracketed 的多行貼上留下的尾巴）退而用常見的提示符結尾切。
// 全螢幕程式（vim / less / top，alternate screen）裡按的鍵不是指令，不記。
import type { IMarker, Terminal } from "@xterm/xterm";
import {
  classifyInput, isSecretPrompt, logicalEnd, logicalStart, pickLater, readSpan, stripPrompt, textBeforeCursor, type SshOpSource,
} from "./sshOpLog";

export interface TrackedCommand<C> {
  text: string;
  /** 按下 Enter（或送出）的時間。 */
  ts: number;
  source: SshOpSource;
  /** 按下 Enter 當下的 `snapshot()`（例如終端機所在的資料夾）：指令本身可能是 cd，回顯完再取就變了。 */
  ctx: C;
}

/** 回顯最多等多久，之後就用已經讀到的。 */
const ECHO_WAIT_MS = 2000;
const POLL_MS = 100;
/** bracketed paste 的多行指令最多讀幾列。 */
const MAX_ROWS = 200;

interface InputStart {
  marker: IMarker;
  col: number;
  /** 這一行裡有含換行的 bracketed paste：指令跨好幾列（不是自動折行）。 */
  multiRow: boolean;
}

export class CommandTracker<C> {
  private start: InputStart | null = null;
  /** 這一行的起點已經不準：下一次 Enter 用退路。 */
  private unknownStart = false;
  private readonly timers = new Set<number>();
  private disposed = false;

  constructor(
    private readonly term: Terminal,
    private readonly emit: (c: TrackedCommand<C>) => void,
    private readonly snapshot: () => C,
  ) {}

  /** xterm `onData`（使用者的鍵盤 / 貼上），在送往後端之前呼叫。 */
  onInput(data: string): void {
    if (this.disposed) return;
    if (this.term.buffer.active.type === "alternate") {
      this.reset();
      return;
    }
    if (data === "\x03" || data === "\x04") {
      // Ctrl+C / Ctrl+D：這一行作廢，下一行重新找起點。
      this.reset();
      return;
    }
    if (data === "\x0c") {
      // Ctrl+L：畫面重畫、提示符跑到最上面，記下來的起點對不上了。
      this.start?.marker.dispose();
      this.start = null;
      this.unknownStart = true;
      return;
    }
    const a = classifyInput(data);
    if (a.kind === "report") return;
    if (a.kind === "enter") {
      this.captureEnter();
      return;
    }
    if (a.kind === "paste" && !a.bracketed) {
      // 沒有 bracketed paste：每一行一貼進去就執行了。照貼上的內容記（畫面還來不及回顯）；
      // 第一行接在使用者已經打的字後面。在密碼提示上貼的（複製密碼時常連換行一起）不記。
      if (!this.atSecretPrompt()) {
        const typed = this.typedSoFar();
        const ts = Date.now();
        const ctx = this.snapshot();
        a.lines.forEach((line, i) => {
          const text = (i === 0 ? typed + line : line).trim();
          if (text && !(i === 0 && /^\s/.test(typed + line))) this.emit({ text, ts, source: "paste", ctx });
        });
      }
      this.reset();
      this.unknownStart = !!a.rest;
      return;
    }
    if (!this.start && !this.unknownStart) {
      const marker = this.term.registerMarker(0);
      if (marker) this.start = { marker, col: this.term.buffer.normal.cursorX, multiRow: false };
    }
    if (this.start && a.kind === "paste" && a.lines.length) this.start.multiRow = true;
  }

  /** 游標所在那一行、游標前面的字像不像密碼提示（命令列輸入條送出前看這個決定記不記歷史）。 */
  atSecretPrompt(): boolean {
    const buf = this.term.buffer.normal;
    return isSecretPrompt(textBeforeCursor(buf, buf.baseY + buf.cursorY, buf.cursorX));
  }

  /**
   * 命令列輸入條 / AI / App 自己送出的一行（不經過 onData）。在密碼提示上送的是密碼，不記；
   * 全螢幕程式裡送的不是 shell 指令，也不記。
   */
  noteSent(line: string, source: SshOpSource): void {
    if (this.disposed) return;
    const secret = this.atSecretPrompt();
    const alt = this.term.buffer.active.type === "alternate";
    this.reset();
    if (secret || alt) return;
    const text = line.replace(/\r\n?/g, "\n").trim();
    if (text) this.emit({ text, ts: Date.now(), source, ctx: this.snapshot() });
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.reset();
  }

  private reset(): void {
    this.start?.marker.dispose();
    this.start = null;
    this.unknownStart = false;
  }

  /** 這一行已經打了（而且回顯了）的字。 */
  private typedSoFar(): string {
    const s = this.start;
    if (!s || s.marker.isDisposed) return "";
    const buf = this.term.buffer.normal;
    const row = buf.baseY + buf.cursorY;
    if (logicalStart(buf, s.marker.line) !== logicalStart(buf, row)) return "";
    return readSpan(buf, s.marker.line, s.col, row);
  }

  private captureEnter(): void {
    const buf = this.term.buffer.normal;
    const ts = Date.now();
    const ctx = this.snapshot();
    const cursorRow = buf.baseY + buf.cursorY;
    const s = this.start;
    const unknown = this.unknownStart;
    this.start = null;
    this.unknownStart = false;

    let anchor: IMarker | undefined;
    let col = 0;
    let fallback = true;
    if (s && !s.marker.isDisposed && s.marker.line >= 0) {
      const ok = s.multiRow
        ? s.marker.line <= cursorRow && cursorRow - s.marker.line <= MAX_ROWS
        : logicalStart(buf, s.marker.line) === logicalStart(buf, cursorRow);
      if (ok && !unknown) {
        anchor = s.marker;
        col = s.col;
        fallback = false;
      } else {
        s.marker.dispose();
      }
    }
    if (!anchor) anchor = this.term.registerMarker(logicalStart(buf, cursorRow) - cursorRow);
    if (!anchor) return;
    const a = anchor;
    // 提示符 = 指令起點前面的字（退路時就是游標前的整行——在密碼提示上打的字不會回顯，所以只剩提示本身）。
    const prompt = fallback ? textBeforeCursor(buf, cursorRow, buf.cursorX) : textBeforeCursor(buf, a.line, col);
    if (isSecretPrompt(prompt)) {
      a.dispose();
      return;
    }
    const span = cursorRow - a.line;
    const read = (): string | null => {
      if (a.isDisposed || a.line < 0) return null;
      const raw = readSpan(buf, a.line, col, logicalEnd(buf, a.line + span));
      return fallback ? stripPrompt(raw) : raw;
    };
    const atEnter = read() ?? "";
    const finish = (later: string | null) => {
      a.dispose();
      const raw = pickLater(atEnter, later);
      // 以空白開頭的指令不記：shell 的 ignorespace 慣例（HISTCONTROL / HIST_IGNORE_SPACE），使用者刻意不留紀錄。
      if (!fallback && /^\s/.test(raw)) return;
      const text = raw.trim();
      if (text) this.emit({ text, ts, source: "keyboard", ctx });
    };
    // 等這一行回顯完：游標離開這一行（shell 回了換行）、切進全螢幕程式、或等太久。
    const poll = () => {
      if (this.disposed) {
        a.dispose();
        return;
      }
      const moved = this.term.buffer.active.type === "alternate" || a.isDisposed
        || buf.baseY + buf.cursorY > a.line + span;
      if (moved || Date.now() - ts >= ECHO_WAIT_MS) {
        finish(read());
        return;
      }
      const id = window.setTimeout(() => {
        this.timers.delete(id);
        poll();
      }, POLL_MS);
      this.timers.add(id);
    };
    poll();
  }
}
