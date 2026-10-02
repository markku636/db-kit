// 虛擬鍵盤的鍵位（美式配置，set-1 掃描碼）。獨立成純資料模組：VirtualKeyboard 畫它，vncKeys 的測試拿它核對每顆鍵都送得出去。
import { RD_SCANCODE_PAUSE } from "./rdInput";

const E0 = 0xe000;

export interface VKey {
  /** 顯示的字；`s` = 按住 Shift 時顯示的字。 */
  l: string;
  s?: string;
  sc: number;
  /** 寬度（一般鍵 = 1）。 */
  w?: number;
  /** 修飾鍵：按一下按住、再按一下放開。 */
  mod?: boolean;
  /** 空白（不是鍵，只佔位）。 */
  gap?: boolean;
}

const k = (l: string, sc: number, w?: number, s?: string): VKey => ({ l, sc, w, s });
const mod = (l: string, sc: number, w: number): VKey => ({ l, sc, w, mod: true });
const gap = (w: number): VKey => ({ l: "", sc: 0, w, gap: true });
const row = (chars: string, shifted: string, first: number): VKey[] =>
  [...chars].map((c, i) => k(c.toUpperCase(), first + i, 1, shifted[i] !== c.toUpperCase() ? shifted[i] : undefined));

/** 主鍵盤（每列寬 15）。 */
export const MAIN_ROWS: VKey[][] = [
  [k("Esc", 0x01), gap(1), ...["F1", "F2", "F3", "F4"].map((f, i) => k(f, 0x3b + i)), gap(0.5),
    ...["F5", "F6", "F7", "F8"].map((f, i) => k(f, 0x3f + i)), gap(0.5),
    k("F9", 0x43), k("F10", 0x44), k("F11", 0x57), k("F12", 0x58)],
  [k("`", 0x29, 1, "~"), ...[..."1234567890"].map((c, i) => k(c, 0x02 + i, 1, "!@#$%^&*()"[i])), k("-", 0x0c, 1, "_"), k("=", 0x0d, 1, "+"),
    k("Backspace", 0x0e, 2)],
  [k("Tab", 0x0f, 1.5), ...row("qwertyuiop", "QWERTYUIOP", 0x10), k("[", 0x1a, 1, "{"), k("]", 0x1b, 1, "}"), k("\\", 0x2b, 1.5, "|")],
  [k("CapsLock", 0x3a, 1.75), ...row("asdfghjkl", "ASDFGHJKL", 0x1e), k(";", 0x27, 1, ":"), k("'", 0x28, 1, "\""), k("Enter", 0x1c, 2.25)],
  [mod("Shift", 0x2a, 2.25), ...row("zxcvbnm", "ZXCVBNM", 0x2c), k(",", 0x33, 1, "<"), k(".", 0x34, 1, ">"), k("/", 0x35, 1, "?"),
    mod("Shift", 0x36, 2.75)],
  [mod("Ctrl", 0x1d, 1.25), mod("Win", E0 | 0x5b, 1.25), mod("Alt", 0x38, 1.25), k("Space", 0x39, 6.25), mod("AltGr", E0 | 0x38, 1.25),
    mod("Win", E0 | 0x5c, 1.25), k("Menu", E0 | 0x5d, 1.25), mod("Ctrl", E0 | 0x1d, 1.25)],
];

/** 編輯鍵與方向鍵（每列寬 3，跟主鍵盤同列對齊）。 */
export const NAV_ROWS: VKey[][] = [
  [k("PrtSc", E0 | 0x37), k("ScrLk", 0x46), k("Pause", RD_SCANCODE_PAUSE)],
  [k("Ins", E0 | 0x52), k("Home", E0 | 0x47), k("PgUp", E0 | 0x49)],
  [k("Del", E0 | 0x53), k("End", E0 | 0x4f), k("PgDn", E0 | 0x51)],
  [gap(3)],
  [gap(1), k("↑", E0 | 0x48), gap(1)],
  [k("←", E0 | 0x4b), k("↓", E0 | 0x50), k("→", E0 | 0x4d)],
];
