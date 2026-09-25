// 鍵盤事件的「誰該收」判定（計畫 §3.5）。
// 終端機分頁開著時，多數快捷鍵（Ctrl+C / Ctrl+L / Ctrl+W / Tab / 方向鍵…）都該進 shell，
// 只有少數 app 層級的組合鍵保留給 app。兩端共用同一份規則：
// - window 級 keydown handler 開頭：`if (inTerminal(e) && !isAppReserved(e)) return;`
// - xterm 端：`term.attachCustomKeyEventHandler((ev) => !isAppReserved(ev))`（回 false = 不進 shell、照常冒泡）。

/** 判定所需的最小結構（KeyboardEvent 與測試用的普通物件都符合）。 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** 事件目標是否在 xterm 內（含其隱藏的 textarea）。target 不是元素或沒有 closest 一律 false。 */
export function inTerminal(e: Event | { target?: unknown } | null | undefined): boolean {
  const target = e?.target as { closest?: (sel: string) => unknown } | null | undefined;
  if (!target || typeof target.closest !== "function") return false;
  try {
    return !!target.closest(".xterm");
  } catch {
    return false;
  }
}

// Ctrl/Cmd+Shift+<字母>：新終端 T、關分頁 W、搜尋列 F、複製 C、貼上 V。
const SHIFT_LETTERS = new Set(["t", "w", "f", "c", "v"]);
const SHIFT_CODES = new Set(["KeyT", "KeyW", "KeyF", "KeyC", "KeyV"]);
// Ctrl/Cmd+= / + / − / 0：全域字級縮放（modalChrome），終端縮放就是它。
const ZOOM_KEYS = new Set(["=", "+", "-", "0"]);
const ZOOM_CODES = new Set(["NumpadAdd", "NumpadSubtract", "Equal", "Minus", "Digit0", "Numpad0"]);

/**
 * 是否為保留給 app 的組合鍵：Ctrl/Cmd+Shift+T / W / F / C / V、Ctrl+Tab / Ctrl+Shift+Tab、
 * Ctrl/Cmd+= / + / − / 0（含數字鍵盤加減）、F1。其餘（含 Ctrl+L / Ctrl+W / Ctrl+T / Ctrl+K / Ctrl+C /
 * Ctrl+數字 / Tab / 方向鍵）一律進 shell。
 * 帶 Alt 的組合不算（AltGr 在歐洲鍵盤會同時報 ctrlKey+altKey，那是在打字，不是快捷鍵）。
 */
export function isAppReserved(ev: KeyLike): boolean {
  const key = ev.key ?? "";
  if (key === "F1") return true;
  if (ev.altKey) return false;
  if (ev.ctrlKey && key === "Tab") return true;
  const mod = ev.ctrlKey || ev.metaKey;
  if (!mod) return false;
  if (ev.shiftKey) {
    if (SHIFT_LETTERS.has(key.toLowerCase()) || (ev.code !== undefined && SHIFT_CODES.has(ev.code))) return true;
  }
  if (ZOOM_KEYS.has(key) || (ev.code !== undefined && ZOOM_CODES.has(ev.code))) return true;
  return false;
}
