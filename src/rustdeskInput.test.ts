import { describe, expect, it } from "vitest";
import {
  chordedChange, HeldKeys, isModifierScancode, lockModes, modifierFixes, mouseModifiers, translatedChar,
} from "./rustdeskInput";

describe("rustdeskInput", () => {
  it("帶本機的 CapsLock / NumLock 狀態", () => {
    const ev = (on: string[]) => ({ getModifierState: (k: string) => on.includes(k) });
    expect(lockModes(ev([]))).toEqual({ caps: false, num: false });
    expect(lockModes(ev(["CapsLock", "NumLock"]))).toEqual({ caps: true, num: true });
    expect(lockModes(ev(["NumLock", "ScrollLock"]))).toEqual({ caps: false, num: true });
  });

  it("滑鼠事件只帶按著的修飾鍵", () => {
    expect(mouseModifiers({ altKey: false, ctrlKey: false, shiftKey: false, metaKey: false })).toEqual({});
    expect(mouseModifiers({ altKey: false, ctrlKey: true, shiftKey: true, metaKey: false })).toEqual({ ctrl: true, shift: true });
    expect(mouseModifiers({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: true })).toEqual({ alt: true, meta: true });
  });

  it("按著一顆再按另一顆：從 buttons 判斷那顆是按下還是放開", () => {
    expect(chordedChange(-1, 1)).toBeNull(); // 一般移動
    expect(chordedChange(2, 1 | 2)).toBe("down"); // 按著左鍵再按右鍵
    expect(chordedChange(2, 1)).toBe("up"); // 右鍵放開
    expect(chordedChange(1, 4)).toBe("down"); // 中鍵是 buttons 的 4
    expect(chordedChange(0, 0)).toBe("up");
    expect(chordedChange(5, 32)).toBeNull();
  });

  it("翻譯模式：打得出字的鍵送字，快捷鍵 / 功能鍵照位置送", () => {
    const ev = (key: string, mods: { ctrl?: boolean; alt?: boolean; meta?: boolean; altGr?: boolean } = {}) => ({
      key, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta,
      getModifierState: (k: string) => k === "AltGraph" && !!mods.altGr,
    });
    expect(translatedChar(ev("a"))).toBe("a");
    expect(translatedChar(ev("A"))).toBe("A"); // Shift 已經算進去
    expect(translatedChar(ev("é"))).toBe("é");
    expect(translatedChar(ev(" "))).toBe(" ");
    expect(translatedChar(ev("😀"))).toBe("😀"); // 一個字（兩個 UTF-16）
    expect(translatedChar(ev("c", { ctrl: true }))).toBeNull(); // Ctrl+C
    expect(translatedChar(ev("Tab", { alt: true }))).toBeNull();
    expect(translatedChar(ev("@", { ctrl: true, alt: true, altGr: true }))).toBe("@"); // AltGr+Q（德文鍵盤）
    for (const k of ["Enter", "ArrowLeft", "F1", "Dead", "Process", "Shift"]) expect(translatedChar(ev(k))).toBeNull();
  });

  it("失去焦點：放開還按著的鍵，Alt 再補按一下", () => {
    const h = new HeldKeys();
    h.update(0x1d, true); // Ctrl
    h.update(0x38, true); // Alt
    h.update(0x0f, true); // Tab
    h.update(0x0f, false);
    expect(h.releaseAll()).toEqual([
      { scancode: 0x1d, down: false },
      { scancode: 0x38, down: false },
      { scancode: 0x38, down: true },
      { scancode: 0x38, down: false },
    ]);
    expect(h.releaseAll()).toEqual([]);
    h.update(0xe038, true);
    h.clear();
    expect(h.releaseAll()).toEqual([]);
  });

  it("修飾鍵跟著按鍵事件的旗標：輸入法吃掉的 Shift 補按、沒收到放開的補放", () => {
    const ev = (mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
      shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta,
    });
    const h = new HeldKeys();
    // 注音輸入法吃掉 Shift 的 keydown：2 的事件 shiftKey 是 true → 先補按左 Shift
    expect(modifierFixes(h, ev({ shift: true }))).toEqual([{ scancode: 0x2a, down: true }]);
    h.update(0x2a, true);
    expect(modifierFixes(h, ev({ shift: true }))).toEqual([]);
    // Shift 的 keyup 也被吃掉：下一個鍵沒按 Shift → 放開
    expect(modifierFixes(h, ev())).toEqual([{ scancode: 0x2a, down: false }]);
    h.update(0x2a, false);
    // 右 Shift 按著也算按著；放開時放開實際按著的那顆
    h.update(0x36, true);
    expect(modifierFixes(h, ev({ shift: true }))).toEqual([]);
    expect(modifierFixes(h, ev())).toEqual([{ scancode: 0x36, down: false }]);
    h.clear();
    // AltGr（Windows 送 Ctrl + 右 Alt）：都按著就不動
    h.update(0x1d, true);
    h.update(0xe038, true);
    expect(modifierFixes(h, ev({ ctrl: true, alt: true }))).toEqual([]);
    h.clear();
    expect(modifierFixes(h, ev({ ctrl: true, meta: true }))).toEqual([
      { scancode: 0x1d, down: true },
      { scancode: 0xe05b, down: true },
    ]);
    expect([0x2a, 0x36, 0x1d, 0xe01d, 0x38, 0xe038, 0xe05b, 0xe05c].every(isModifierScancode)).toBe(true);
    expect([0x03, 0x1e, 0x3a, 0x1c].some(isModifierScancode)).toBe(false);
  });
});
