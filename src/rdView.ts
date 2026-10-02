// RdPane 驅動協定畫面（RdpView / VncView）的共同介面。
import type { RdConnInfo } from "./rdTypes";

export interface RdViewHandle {
  /** 撥號前：換成這次的 conn id，丟掉上一條連線的畫面 / 輸入狀態。 */
  reset(connId: string): void;
  /** 後端 Channel 送來的一則訊息（RDP = rdFrames record；VNC = RFB 位元組）。 */
  output(buf: ArrayBuffer): void;
  /** `rd_connect` 成功回來。 */
  connected(info: RdConnInfo): void;
  /** 連線結束（後端 `rd-conn-closed` 或使用者斷線）。 */
  disconnected(): void;
  /** 工具列組合鍵：`ctrl_alt_del` / `win` / `alt_tab` / `ctrl_esc` / `print_screen`。 */
  combo(name: string): void;
  /** 把本機剪貼簿文字交給遠端。 */
  paste(text: string): void;
  focus(): void;
  /** 整張重畫（RDP 請後端重送；VNC 向伺服器要一張完整畫面）。 */
  refresh(): void;
  desktopSize(): { w: number; h: number };
  /** 後端鍵盤 hook 攔到的系統鍵（set-1 掃描碼；擴充鍵 OR 0xE000）。 */
  rawKey(scancode: number, down: boolean): void;
  /** 多螢幕：換成看這幾個螢幕（RustDesk；一個 = 切過去，多個 = 一起看）。 */
  showDisplays?(set: number[]): void;
  /** RustDesk 工具列的「動作」：`ctrl_alt_del` / `lock_screen` / `restart` / `refresh`。 */
  action?(name: "ctrl_alt_del" | "lock_screen" | "restart" | "refresh"): void;
  /** RustDesk：封鎖 / 解除封鎖對方的鍵盤滑鼠。 */
  setBlockInput?(on: boolean): void;
  /** RustDesk：傳聊天訊息給對方。 */
  sendChat?(text: string): void;
  /** 錄影（錄這端看到的畫面；`name` 是主機名稱，只用來取檔名）。 */
  startRecording?(name: string): Promise<void>;
  stopRecording?(): Promise<void>;
  /** 截圖存成 PNG（`name` 只用來取檔名）；回傳存檔路徑，畫面還沒出來 → null。 */
  screenshot?(name: string): Promise<string | null>;
  /** VNC 的電源操作（XVP：QEMU / Proxmox / XenServer 這類虛擬機主控台才有）。 */
  power?(op: "shutdown" | "reboot" | "reset"): void;
  /** RustDesk「輸入作業系統密碼」：叫出密碼框、打過去再按 Enter；`password` 不給 = 用這台主機存的。 */
  inputOsPassword?(password?: string): Promise<void>;
}

/** Tauri Channel 的 raw 訊息在真 App 是 ArrayBuffer；verify-ui 的假後端可能送 Uint8Array / number[]。 */
export function toArrayBuffer(buf: unknown): ArrayBuffer {
  if (buf instanceof ArrayBuffer) return buf;
  if (ArrayBuffer.isView(buf)) {
    const v = buf as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(buf)) return new Uint8Array(buf as number[]).buffer;
  return new ArrayBuffer(0);
}
