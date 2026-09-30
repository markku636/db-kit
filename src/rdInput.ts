// RDP 分頁的輸入編碼（前端 → 後端）：把 DOM 的鍵盤 / 滑鼠 / 滾輪事件壓成固定 8 位元組的紀錄，
// 攢一批再一次走 IPC 送給後端，由後端翻成 RDP 的 fast-path 輸入事件。
//
// 為什麼不直接每個事件 invoke 一次：滑鼠移動一秒可以上百次，每次 invoke 都要 JSON 序列化 + 跨行程，
// 延遲與 CPU 都吃不消；固定長度的二進位紀錄讓後端不用解析，也讓連續的移動能在前端先合併成一筆。
//
// 線上格式（little-endian，每筆 8 bytes）：
//   [u8 op][u8 flags][u16 a][u16 b][u16 c]
// 各 op 的欄位意義見 `RdInputOp`。
//
// 鍵盤送「掃描碼」而不是字元：遠端 Windows 用自己的鍵盤配置解讀，這樣 Ctrl / Alt 組合鍵、
// 遊戲式按住不放、輸入法切換都跟實體鍵盤一致。認不出來的鍵（`scancodeForCode` 回 null）
// 由呼叫端改走 UNICODE_DOWN / UNICODE_UP 送字元。

/** 紀錄的 op 碼；數值與後端 `rd::rdp::input` 一致，改動要兩邊同步。 */
export const RdInputOp = {
  /** a = 掃描碼；延伸鍵 OR 上 0xE000（例：右 Ctrl = 0xE01D）。 */
  KEY_DOWN: 1,
  KEY_UP: 2,
  /** a = x、b = y（遠端桌面像素座標）。 */
  MOUSE_MOVE: 3,
  /** a = 按鍵（0 左、1 中、2 右、3 X1、4 X2）、b = x、c = y。 */
  BUTTON_DOWN: 4,
  BUTTON_UP: 5,
  /** flags bit0 = 水平；a = 有號 i16 位移（以 u16 存；一格 120）、b = x、c = y。 */
  WHEEL: 6,
  /** a = UTF-16 code unit（掃描碼表認不出的字元，例如輸入法組好的字）。 */
  UNICODE_DOWN: 7,
  UNICODE_UP: 8,
  /** 放開所有按住的鍵與滑鼠鍵（分頁失焦時送，避免遠端卡著 Ctrl / Alt）。 */
  RELEASE_ALL: 9,
  /** flags = 鎖定鍵狀態（見 `RdLockFlag`）；對映 RDP 的 Synchronize 事件。 */
  SYNC_LOCKS: 10,
} as const;
export type RdInputOp = (typeof RdInputOp)[keyof typeof RdInputOp];

/** SYNC_LOCKS 的 flags 位元；對映 MS-RDPBCGR TS_SYNC_EVENT 的 toggleFlags。 */
export const RdLockFlag = {
  SCROLL: 1,
  NUM: 2,
  CAPS: 4,
  KANA: 8,
} as const;

/** WHEEL 的 flags：bit0 = 水平滾動。 */
export const RD_WHEEL_HORIZONTAL = 1;

/** 每筆紀錄的位元組數。 */
export const RD_INPUT_RECORD_SIZE = 8;

/** 延伸鍵（E0 前綴）的標記位元。 */
const E0 = 0xe000;

/**
 * Pause/Break 的特殊值。這顆鍵在 set-1 沒有單一掃描碼，硬體送的是 `E1 1D 45 E1 9D C5`
 * （按下即放開、沒有獨立的 break code）；RDP 端要送 KBDFLAGS_EXTENDED1 + 0x1D，再送 0x45。
 * 前端只傳這個記號值，後端看到 0xE11D 自己展開成完整序列（KEY_UP 時什麼都不送）。
 */
export const RD_SCANCODE_PAUSE = 0xe11d;

/**
 * KeyboardEvent.code → PC/AT set-1 掃描碼。
 * 出處：W3C「UI Events KeyboardEvent code Values」附錄的 code ↔ scancode 對照，
 * 與 Microsoft「Keyboard Scan Code Specification」（scancode.doc，Appendix C 的 set-1 欄）交叉核對；
 * FreeRDP `libfreerdp/locale/keyboard.c`、Apache Guacamole 的 RDP keymap 也是同一張表。
 * 用 code 而不是 key：code 是實體鍵位置，跟使用者本機的鍵盤配置無關，正好對上「遠端自己解讀配置」。
 */
const SCANCODES: Readonly<Record<string, number>> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  // 0x54 是 Alt+PrintScreen（SysRq）的硬體碼，瀏覽器不會單獨給 code。
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  NumpadEqual: 0x59,
  F13: 0x64,
  F14: 0x65,
  F15: 0x66,
  F16: 0x67,
  F17: 0x68,
  F18: 0x69,
  F19: 0x6a,
  F20: 0x6b,
  F21: 0x6c,
  F22: 0x6d,
  F23: 0x6e,
  // 日文 / 韓文鍵盤。Lang1 / Lang2 在韓文鍵盤是 Hangul（한/영）/ Hanja（한자）。
  KanaMode: 0x70,
  Lang2: 0x71,
  Lang1: 0x72,
  IntlRo: 0x73,
  F24: 0x76,
  Convert: 0x79,
  NonConvert: 0x7b,
  IntlYen: 0x7d,
  NumpadComma: 0x7e,

  // ---- 延伸鍵（E0 前綴）----
  MediaTrackPrevious: E0 | 0x10,
  MediaTrackNext: E0 | 0x19,
  NumpadEnter: E0 | 0x1c,
  ControlRight: E0 | 0x1d,
  AudioVolumeMute: E0 | 0x20,
  LaunchApp2: E0 | 0x21,
  MediaPlayPause: E0 | 0x22,
  MediaStop: E0 | 0x24,
  AudioVolumeDown: E0 | 0x2e,
  AudioVolumeUp: E0 | 0x30,
  BrowserHome: E0 | 0x32,
  NumpadDivide: E0 | 0x35,
  PrintScreen: E0 | 0x37,
  AltRight: E0 | 0x38,
  Home: E0 | 0x47,
  ArrowUp: E0 | 0x48,
  PageUp: E0 | 0x49,
  ArrowLeft: E0 | 0x4b,
  ArrowRight: E0 | 0x4d,
  End: E0 | 0x4f,
  ArrowDown: E0 | 0x50,
  PageDown: E0 | 0x51,
  Insert: E0 | 0x52,
  Delete: E0 | 0x53,
  MetaLeft: E0 | 0x5b,
  MetaRight: E0 | 0x5c,
  // 舊版 Firefox（< 118）把 Win 鍵叫 OSLeft / OSRight。
  OSLeft: E0 | 0x5b,
  OSRight: E0 | 0x5c,
  ContextMenu: E0 | 0x5d,
  Power: E0 | 0x5e,
  Sleep: E0 | 0x5f,
  WakeUp: E0 | 0x63,
  BrowserSearch: E0 | 0x65,
  BrowserFavorites: E0 | 0x66,
  BrowserRefresh: E0 | 0x67,
  BrowserStop: E0 | 0x68,
  BrowserForward: E0 | 0x69,
  BrowserBack: E0 | 0x6a,
  LaunchApp1: E0 | 0x6b,
  LaunchMail: E0 | 0x6c,
  MediaSelect: E0 | 0x6d,

  Pause: RD_SCANCODE_PAUSE,
};

/** KeyboardEvent.code → set-1 掃描碼（延伸鍵含 0xE000）；認不出來回 null（呼叫端改送 Unicode）。 */
export function scancodeForCode(code: string): number | null {
  return Object.prototype.hasOwnProperty.call(SCANCODES, code) ? SCANCODES[code] : null;
}

/** DOM MouseEvent.button → 紀錄的按鍵編號（3 = 上一頁鍵 → X1、4 = 下一頁鍵 → X2）；其他回 null。 */
export function mouseButtonFromDom(button: number): number | null {
  return Number.isInteger(button) && button >= 0 && button <= 4 ? button : null;
}

/** 鎖定鍵狀態 → SYNC_LOCKS 的 flags。傳進來的通常是 KeyboardEvent / MouseEvent。 */
export function lockFlagsFromEvent(e: { getModifierState(key: string): boolean }): number {
  let f = 0;
  if (e.getModifierState("ScrollLock")) f |= RdLockFlag.SCROLL;
  if (e.getModifierState("NumLock")) f |= RdLockFlag.NUM;
  if (e.getModifierState("CapsLock")) f |= RdLockFlag.CAPS;
  return f;
}

// ---------------------------------------------------------------------------
// 滾輪
// ---------------------------------------------------------------------------

/** 一格滾輪的位移量（Windows WHEEL_DELTA）。 */
export const WHEEL_NOTCH = 120;
/** 像素模式下多少像素算一格：Chrome / Edge 在 Windows 上一格正好給 100px。 */
export const WHEEL_PIXELS_PER_NOTCH = 100;
/** 行模式：Firefox 一格給 3 行，所以一行 = 40。 */
const WHEEL_PER_LINE = WHEEL_NOTCH / 3;
/** 頁模式（少見，系統設成「一次捲一頁」時）：一頁當三格。 */
const WHEEL_PER_PAGE = WHEEL_NOTCH * 3;

export interface DomWheelLike {
  deltaY: number;
  deltaX: number;
  /** 0 = 像素、1 = 行、2 = 頁（WheelEvent.DOM_DELTA_*）。 */
  deltaMode: number;
}

/**
 * 換成 RDP 的正負號慣例（與 Windows WM_MOUSEWHEEL / WM_MOUSEHWHEEL 相同）：
 * 垂直正值 = 往上（滾輪推離使用者）、水平正值 = 往右。DOM 的 deltaY 正值是往下，所以垂直要反號。
 */
function normalizeWheel(e: DomWheelLike): { v: number; h: number } {
  const k = e.deltaMode === 1 ? WHEEL_PER_LINE : e.deltaMode === 2 ? WHEEL_PER_PAGE : WHEEL_NOTCH / WHEEL_PIXELS_PER_NOTCH;
  return { v: -(e.deltaY || 0) * k, h: (e.deltaX || 0) * k };
}

/**
 * DOM 滾輪事件 → 以「一格 120」計的位移（取整數，正負號見 `normalizeWheel`）。
 * 無狀態：像素模式的小位移（觸控板）會被四捨五入吃掉，要累積請用 `WheelAccumulator`。
 */
export function wheelDeltaFromDom(e: DomWheelLike): { v: number; h: number } {
  const n = normalizeWheel(e);
  return { v: Math.round(n.v) || 0, h: Math.round(n.h) || 0 };
}

/**
 * 把零碎的滾輪位移累積成整格（±120 的倍數）。觸控板一次只給幾個像素，
 * 直接送小數值給遠端，很多程式（舊的 Win32 控制項、xrdp 轉 X11 按鈕）會當成整格或乾脆忽略；
 * 累積到一格再送，行為就跟實體滾輪一致。方向反轉時丟掉餘數，反向捲動才不會先「還債」而顯得遲鈍。
 */
export class WheelAccumulator {
  private v = 0;
  private h = 0;

  /** 餵一個 DOM 滾輪事件，回傳這次該送出的位移（皆為 120 的倍數，可能是 0）。 */
  push(e: DomWheelLike): { v: number; h: number } {
    const n = normalizeWheel(e);
    this.v = accumulate(this.v, n.v);
    this.h = accumulate(this.h, n.h);
    const v = wholeNotches(this.v);
    const h = wholeNotches(this.h);
    this.v -= v;
    this.h -= h;
    return { v, h };
  }

  reset(): void {
    this.v = 0;
    this.h = 0;
  }
}

function accumulate(acc: number, delta: number): number {
  if (delta === 0) return acc;
  // 方向反轉：舊餘數作廢。
  if ((acc > 0 && delta < 0) || (acc < 0 && delta > 0)) return delta;
  return acc + delta;
}

function wholeNotches(x: number): number {
  const n = Math.trunc(x / WHEEL_NOTCH) * WHEEL_NOTCH;
  return n || 0; // 把 -0 收成 0
}

// ---------------------------------------------------------------------------
// 編碼器
// ---------------------------------------------------------------------------

function u16(n: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(n) || 0));
}

function i16(n: number): number {
  const v = Math.max(-0x8000, Math.min(0x7fff, Math.round(n) || 0));
  return v & 0xffff;
}

/**
 * 把輸入事件攢成一串 8-byte 紀錄，呼叫端在 requestAnimationFrame / 計時器裡 `take()` 一次送出。
 * 連續的 MOUSE_MOVE 只留最後一筆（前一筆也是移動時就地覆寫）：中間的座標遠端用不到，
 * 而按鍵 / 按鈕之間的移動會保留，確保「移到 A 按下、移到 B 放開」的拖曳順序不變。
 */
export class RdInputEncoder {
  private buf = new Uint8Array(RD_INPUT_RECORD_SIZE * 64);
  private view = new DataView(this.buf.buffer);
  private len = 0;
  /** 最後一筆是否為移動（決定要不要就地合併）。 */
  private lastWasMove = false;

  private push(op: number, flags: number, a: number, b: number, c: number): void {
    let off: number;
    if (op === RdInputOp.MOUSE_MOVE && this.lastWasMove) {
      off = this.len - RD_INPUT_RECORD_SIZE;
    } else {
      if (this.len + RD_INPUT_RECORD_SIZE > this.buf.length) {
        const next = new Uint8Array(this.buf.length * 2);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
        this.view = new DataView(next.buffer);
      }
      off = this.len;
      this.len += RD_INPUT_RECORD_SIZE;
    }
    this.lastWasMove = op === RdInputOp.MOUSE_MOVE;
    this.view.setUint8(off, op);
    this.view.setUint8(off + 1, flags & 0xff);
    this.view.setUint16(off + 2, a & 0xffff, true);
    this.view.setUint16(off + 4, b & 0xffff, true);
    this.view.setUint16(off + 6, c & 0xffff, true);
  }

  /** 送實體鍵；code 認不出來回 false（不寫任何紀錄，呼叫端改走 `unicode`）。 */
  key(down: boolean, code: string): boolean {
    const sc = scancodeForCode(code);
    if (sc === null) return false;
    this.push(down ? RdInputOp.KEY_DOWN : RdInputOp.KEY_UP, 0, sc, 0, 0);
    return true;
  }

  /** 直接送掃描碼（後端鍵盤 hook 攔到的系統鍵已經是 set-1 掃描碼，不經 KeyboardEvent.code）。 */
  scancode(down: boolean, sc: number): void {
    this.push(down ? RdInputOp.KEY_DOWN : RdInputOp.KEY_UP, 0, sc & 0xffff, 0, 0);
  }

  /** 送一個 UTF-16 code unit（代理對要拆成兩次呼叫）。 */
  unicode(down: boolean, codeUnit: number): void {
    this.push(down ? RdInputOp.UNICODE_DOWN : RdInputOp.UNICODE_UP, 0, codeUnit & 0xffff, 0, 0);
  }

  move(x: number, y: number): void {
    this.push(RdInputOp.MOUSE_MOVE, 0, u16(x), u16(y), 0);
  }

  button(down: boolean, btn: number, x: number, y: number): void {
    this.push(down ? RdInputOp.BUTTON_DOWN : RdInputOp.BUTTON_UP, 0, btn, u16(x), u16(y));
  }

  /**
   * 滾輪；delta 用 Windows 慣例（垂直正值往上、水平正值往右，一格 120），超出 i16 會被夾住。
   * RDP 的 wheel 欄位只有 9 bits（±255），大位移由後端切成多筆送出。delta 為 0 不寫紀錄。
   */
  wheel(delta: number, horizontal: boolean, x: number, y: number): void {
    if (!Math.round(delta)) return;
    this.push(RdInputOp.WHEEL, horizontal ? RD_WHEEL_HORIZONTAL : 0, i16(delta), u16(x), u16(y));
  }

  releaseAll(): void {
    this.push(RdInputOp.RELEASE_ALL, 0, 0, 0, 0);
  }

  syncLocks(flags: number): void {
    this.push(RdInputOp.SYNC_LOCKS, flags & 0x0f, 0, 0, 0);
  }

  /** 目前攢了幾筆（測試 / 決定要不要排程送出用）。 */
  get pending(): number {
    return this.len / RD_INPUT_RECORD_SIZE;
  }

  /** 取出並清空目前攢的紀錄；沒有東西回 null。回傳的是複本，之後的寫入不會改到它。 */
  take(): Uint8Array | null {
    if (!this.len) return null;
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    this.lastWasMove = false;
    return out;
  }
}

// ---------------------------------------------------------------------------
// 工具列組合鍵
// ---------------------------------------------------------------------------

type ComboStep = readonly [code: string, down: boolean];

/**
 * 工具列上的組合鍵：這些鍵本機作業系統會先攔走（Ctrl+Alt+Del、Win、Alt+Tab…），
 * 使用者在分頁裡按不出去，只能從按鈕送。一律用左側的修飾鍵，放開順序與按下相反。
 */
export const COMBOS = {
  ctrlAltDel: [
    ["ControlLeft", true],
    ["AltLeft", true],
    ["Delete", true],
    ["Delete", false],
    ["AltLeft", false],
    ["ControlLeft", false],
  ],
  win: [
    ["MetaLeft", true],
    ["MetaLeft", false],
  ],
  altTab: [
    ["AltLeft", true],
    ["Tab", true],
    ["Tab", false],
    ["AltLeft", false],
  ],
  ctrlEsc: [
    ["ControlLeft", true],
    ["Escape", true],
    ["Escape", false],
    ["ControlLeft", false],
  ],
  printScreen: [
    ["PrintScreen", true],
    ["PrintScreen", false],
  ],
} as const satisfies Record<string, readonly ComboStep[]>;

export type RdComboName = keyof typeof COMBOS;

/** 組合鍵 → 可直接送給後端的紀錄。 */
export function encodeCombo(name: RdComboName): Uint8Array {
  const enc = new RdInputEncoder();
  for (const [code, down] of COMBOS[name]) enc.key(down, code);
  return enc.take() ?? new Uint8Array(0);
}

// ---------------------------------------------------------------------------
// 解碼（測試與 Playwright shim 用；正式路徑只有後端會解）
// ---------------------------------------------------------------------------

export interface RdInputRecord {
  op: number;
  flags: number;
  a: number;
  b: number;
  c: number;
}

/** 把紀錄串拆回物件；長度不是 8 的倍數就丟錯（代表前後端格式對不上）。 */
export function decodeRdInput(bytes: Uint8Array): RdInputRecord[] {
  if (bytes.length % RD_INPUT_RECORD_SIZE !== 0) {
    throw new Error(`RDP 輸入紀錄長度 ${bytes.length} 不是 ${RD_INPUT_RECORD_SIZE} 的倍數`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: RdInputRecord[] = [];
  for (let off = 0; off < bytes.length; off += RD_INPUT_RECORD_SIZE) {
    out.push({
      op: dv.getUint8(off),
      flags: dv.getUint8(off + 1),
      a: dv.getUint16(off + 2, true),
      b: dv.getUint16(off + 4, true),
      c: dv.getUint16(off + 6, true),
    });
  }
  return out;
}
