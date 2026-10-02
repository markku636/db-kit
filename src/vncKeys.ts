// VNC 的按鍵換算：RFB 的 KeyEvent 送的是 X11 keysym（「打出哪個字」），不是鍵位。
//
// - `vncKeyForScancode`：虛擬鍵盤與全螢幕鍵盤攔截給的是 set-1 掃描碼（rdInput.ts 那張表），這裡換成
//   [keysym, KeyboardEvent.code]。code 交給 noVNC——伺服器支援 QEMU 延伸按鍵事件時 noVNC 會改送掃描碼。
//   字母 / 數字 / 標點要看 Shift（與 CapsLock）決定送哪個 keysym：伺服器會照 keysym 自己補 / 放 Shift，
//   Shift 按著卻送小寫 a，有的伺服器會打出 a 而不是 A。
// - `keysymsForText`：「把剪貼簿文字送到遠端」逐字打過去（Latin-1 直接用碼位，其他字用 Unicode keysym）。
// keysym 數值出處：X.Org `keysymdef.h`。
import { RD_SCANCODE_PAUSE } from "./rdInput";

const E0 = 0xe000;

export const XK = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Pause: 0xff13, Scroll_Lock: 0xff14, Escape: 0xff1b,
  Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Page_Up: 0xff55, Page_Down: 0xff56, End: 0xff57,
  Print: 0xff61, Insert: 0xff63, Menu: 0xff67, Num_Lock: 0xff7f, F1: 0xffbe,
  Shift_L: 0xffe1, Shift_R: 0xffe2, Control_L: 0xffe3, Control_R: 0xffe4, Caps_Lock: 0xffe5,
  Alt_L: 0xffe9, Alt_R: 0xffea, Super_L: 0xffeb, Super_R: 0xffec, Delete: 0xffff,
} as const;

/** 印得出字的鍵：[code, 平常, 按著 Shift]（美式配置，跟虛擬鍵盤上印的一樣）。 */
const PRINTABLE: Record<number, [string, string, string]> = {
  0x29: ["Backquote", "`", "~"], 0x0c: ["Minus", "-", "_"], 0x0d: ["Equal", "=", "+"],
  0x1a: ["BracketLeft", "[", "{"], 0x1b: ["BracketRight", "]", "}"], 0x2b: ["Backslash", "\\", "|"],
  0x27: ["Semicolon", ";", ":"], 0x28: ["Quote", "'", "\""], 0x33: ["Comma", ",", "<"], 0x34: ["Period", ".", ">"],
  0x35: ["Slash", "/", "?"], 0x39: ["Space", " ", " "],
};
for (const [i, c] of [..."1234567890"].entries()) PRINTABLE[0x02 + i] = [`Digit${c}`, c, "!@#$%^&*()"[i]];
const LETTER_ROWS: [string, number][] = [["qwertyuiop", 0x10], ["asdfghjkl", 0x1e], ["zxcvbnm", 0x2c]];
for (const [chars, first] of LETTER_ROWS) {
  for (const [i, c] of [...chars].entries()) PRINTABLE[first + i] = [`Key${c.toUpperCase()}`, c, c.toUpperCase()];
}

/** 不印字的鍵：[code, keysym]。 */
const SPECIAL: Record<number, [string, number]> = {
  0x01: ["Escape", XK.Escape], 0x0e: ["Backspace", XK.BackSpace], 0x0f: ["Tab", XK.Tab], 0x1c: ["Enter", XK.Return],
  0x3a: ["CapsLock", XK.Caps_Lock], 0x45: ["NumLock", XK.Num_Lock], 0x46: ["ScrollLock", XK.Scroll_Lock],
  0x2a: ["ShiftLeft", XK.Shift_L], 0x36: ["ShiftRight", XK.Shift_R], 0x1d: ["ControlLeft", XK.Control_L],
  [E0 | 0x1d]: ["ControlRight", XK.Control_R], 0x38: ["AltLeft", XK.Alt_L], [E0 | 0x38]: ["AltRight", XK.Alt_R],
  [E0 | 0x5b]: ["MetaLeft", XK.Super_L], [E0 | 0x5c]: ["MetaRight", XK.Super_R], [E0 | 0x5d]: ["ContextMenu", XK.Menu],
  [E0 | 0x37]: ["PrintScreen", XK.Print], [RD_SCANCODE_PAUSE]: ["Pause", XK.Pause],
  [E0 | 0x52]: ["Insert", XK.Insert], [E0 | 0x53]: ["Delete", XK.Delete], [E0 | 0x47]: ["Home", XK.Home],
  [E0 | 0x4f]: ["End", XK.End], [E0 | 0x49]: ["PageUp", XK.Page_Up], [E0 | 0x51]: ["PageDown", XK.Page_Down],
  [E0 | 0x48]: ["ArrowUp", XK.Up], [E0 | 0x50]: ["ArrowDown", XK.Down], [E0 | 0x4b]: ["ArrowLeft", XK.Left],
  [E0 | 0x4d]: ["ArrowRight", XK.Right],
};
// F1–F10 是 0x3b–0x44，F11 / F12 是 0x57 / 0x58；keysym 連號。
for (let i = 0; i < 10; i++) SPECIAL[0x3b + i] = [`F${i + 1}`, XK.F1 + i];
SPECIAL[0x57] = ["F11", XK.F1 + 10];
SPECIAL[0x58] = ["F12", XK.F1 + 11];

/** 一個字元 → keysym（不含換行 / Tab，那兩個由 `keysymsForText` 處理）。 */
export function keysymForChar(cp: number): number {
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 | cp;
}

/**
 * set-1 掃描碼 → [keysym, code]；認不得回 null。`shift` / `caps` = 目前 Shift 是否按著、CapsLock 是否開著
 * （CapsLock 只影響字母，跟一般鍵盤一樣）。
 */
export function vncKeyForScancode(sc: number, shift: boolean, caps: boolean): [number, string] | null {
  const p = PRINTABLE[sc];
  if (p) {
    const letter = p[0].startsWith("Key");
    const upper = letter ? shift !== caps : shift;
    return [(upper ? p[2] : p[1]).codePointAt(0)!, p[0]];
  }
  const s = SPECIAL[sc];
  return s ? [s[1], s[0]] : null;
}

export const isShiftScancode = (sc: number) => sc === 0x2a || sc === 0x36;
export const CAPS_SCANCODE = 0x3a;

/** 美式鍵盤要按 Shift 才打得出的字。 */
const SHIFTED = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:\"<>?"]);

/**
 * 文字 → 一串 [keysym, 要不要按著 Shift]（\r 略過，\n = Enter，\t = Tab；以 code point 為單位，emoji 不會拆成兩半）。
 * 要 Shift 的字照實體鍵盤打字那樣包一層 Shift（noVNC 自己送按鍵也是這樣）：Xvnc / macOS 會自己補 Shift，
 * 但 QEMU 這類照鍵位換算的伺服器不會，不包的話大寫會變小寫、! 會變 1。
 */
export function keysymsForText(text: string): [number, boolean][] {
  const out: [number, boolean][] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 13) continue;
    if (cp === 10) out.push([XK.Return, false]);
    else if (cp === 9) out.push([XK.Tab, false]);
    else if (cp >= 0x20) out.push([keysymForChar(cp), SHIFTED.has(ch)]);
  }
  return out;
}
