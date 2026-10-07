// RustDesk 輸入的細節，照官方用戶端（flutter/lib/models/input_model.dart、src/keyboard.rs、src/client.rs）：
// - 每個按鍵帶本機 CapsLock / NumLock 的狀態（`add_lock_modes_modifiers`）：對方會先把自己的鎖定鍵切成一樣再按。
//   不帶 = 對方當成都沒開，數字鍵盤變成方向鍵、CapsLock 打不出大寫——登入畫面的密碼 / PIN 會打錯。
// - 滑鼠事件帶按著的修飾鍵（`send_mouse`）：對方按下滑鼠前會把修飾鍵整理成跟這個一樣，沒帶的會被放開，
//   Ctrl / Shift + 點選就變成單純的點選。
// - 畫面失去焦點時放開還按著的鍵（`release_remote_keys`；Alt 再補按一次）：Alt+Tab 切走後對方的 Alt 不會卡住。
// - 按著一顆滑鼠鍵再按另一顆時，瀏覽器只給 pointermove（`button` 是變化的那顆），官方也是從按鍵狀態的變化判斷。

/** 鎖定鍵狀態（`KeyboardEvent` / `MouseEvent` 都有 getModifierState）。 */
export function lockModes(e: { getModifierState(key: string): boolean }): { caps: boolean; num: boolean } {
  return { caps: e.getModifierState("CapsLock"), num: e.getModifierState("NumLock") };
}

/** 滑鼠事件要帶的修飾鍵（只放按著的，JSON 小一點）。 */
export function mouseModifiers(e: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): {
  alt?: true; ctrl?: true; shift?: true; meta?: true;
} {
  const m: { alt?: true; ctrl?: true; shift?: true; meta?: true } = {};
  if (e.altKey) m.alt = true;
  if (e.ctrlKey) m.ctrl = true;
  if (e.shiftKey) m.shift = true;
  if (e.metaKey) m.meta = true;
  return m;
}

/**
 * 翻譯模式（官方 `translate_keyboard_mode` / `try_fill_unicode`）：這個按鍵打得出字 → 送那個字（本機鍵盤配置的結果，
 * 對方照字打、不管它自己的配置）；方向鍵、Enter、F1、Ctrl+C 這類 → null（照位置送）。AltGr 組出的字（歐洲鍵盤的 @ €）也算字。
 */
export function translatedChar(e: {
  key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; getModifierState(key: string): boolean;
}): string | null {
  if ([...e.key].length !== 1) return null; // "Enter" / "ArrowLeft" / "Dead" / "Process"（輸入法）
  if (!e.getModifierState("AltGraph") && (e.ctrlKey || e.altKey || e.metaKey)) return null;
  return e.key;
}

/** DOM 的 `button`（0 左 1 中 2 右 3 上一頁 4 下一頁）在 `buttons` 裡的位元。 */
const DOM_BUTTONS_BIT = [1, 4, 2, 8, 16];

/** pointermove 帶著按鍵變化（`button` ≥ 0）：那顆是按下還是放開；一般移動 → null。 */
export function chordedChange(button: number, buttons: number): "down" | "up" | null {
  if (!Number.isInteger(button) || button < 0 || button > 4) return null;
  return buttons & DOM_BUTTONS_BIT[button] ? "down" : "up";
}

const ALT = 0x38;
const ALT_GR = 0xe038;

/** 修飾鍵：事件旗標 → 左右兩顆的掃描碼（第一顆 = 補按時送的）。 */
const MODIFIERS: { flag: "shiftKey" | "ctrlKey" | "altKey" | "metaKey"; scancodes: number[] }[] = [
  { flag: "shiftKey", scancodes: [0x2a, 0x36] },
  { flag: "ctrlKey", scancodes: [0x1d, 0xe01d] },
  { flag: "altKey", scancodes: [ALT, ALT_GR] },
  { flag: "metaKey", scancodes: [0xe05b, 0xe05c] },
];

export function isModifierScancode(sc: number): boolean {
  return MODIFIERS.some((m) => m.scancodes.includes(sc));
}

/**
 * 一般鍵送出前，讓對方按著的修飾鍵跟這個按鍵事件的旗標一致：沒送過按下的補按、還按著但其實放開了的放開。
 * 本機的注音 / 拼音輸入法會吃掉單獨按的 Shift（拿來切中英），畫面收不到 Shift 的 keydown / keyup，
 * 下一個鍵的 shiftKey 卻是 true——不補的話 Shift+2 在對方變成 2、Shift+A 變成 a。
 * （官方用戶端是用系統層的鍵盤 hook 收鍵，不經過輸入法。）
 */
export function modifierFixes(
  held: HeldKeys,
  e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
): { scancode: number; down: boolean }[] {
  const out: { scancode: number; down: boolean }[] = [];
  for (const m of MODIFIERS) {
    const down = m.scancodes.filter((sc) => held.has(sc));
    if (e[m.flag] && !down.length) out.push({ scancode: m.scancodes[0], down: true });
    else if (!e[m.flag]) for (const sc of down) out.push({ scancode: sc, down: false });
  }
  return out;
}

/** 送給對方、還沒放開的鍵（掃描碼）。 */
export class HeldKeys {
  private readonly held = new Set<number>();

  update(scancode: number, down: boolean): void {
    if (down) this.held.add(scancode);
    else this.held.delete(scancode);
  }

  has(scancode: number): boolean {
    return this.held.has(scancode);
  }

  clear(): void {
    this.held.clear();
  }

  /** 放開全部要送的按鍵（依序）；Alt / AltGr 放開後再按一下放開（官方 `release_remote_keys_for_events`）。清空。 */
  releaseAll(): { scancode: number; down: boolean }[] {
    const out: { scancode: number; down: boolean }[] = [];
    for (const sc of this.held) {
      out.push({ scancode: sc, down: false });
      if (sc === ALT || sc === ALT_GR) out.push({ scancode: sc, down: true }, { scancode: sc, down: false });
    }
    this.held.clear();
    return out;
  }
}
