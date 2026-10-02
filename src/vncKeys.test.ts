import { describe, expect, it } from "vitest";
import { MAIN_ROWS, NAV_ROWS } from "./vkLayout";
import { keysymForChar, keysymsForText, vncKeyForScancode, XK } from "./vncKeys";

describe("vncKeyForScancode", () => {
  it("字母看 Shift 與 CapsLock", () => {
    expect(vncKeyForScancode(0x1e, false, false)).toEqual([0x61, "KeyA"]); // a
    expect(vncKeyForScancode(0x1e, true, false)).toEqual([0x41, "KeyA"]); // A
    expect(vncKeyForScancode(0x1e, false, true)).toEqual([0x41, "KeyA"]); // CapsLock → A
    expect(vncKeyForScancode(0x1e, true, true)).toEqual([0x61, "KeyA"]); // 兩個都開 → a
    expect(vncKeyForScancode(0x32, false, false)).toEqual([0x6d, "KeyM"]);
  });

  it("數字與標點只看 Shift", () => {
    expect(vncKeyForScancode(0x02, false, false)).toEqual([0x31, "Digit1"]);
    expect(vncKeyForScancode(0x02, true, false)).toEqual([0x21, "Digit1"]); // !
    expect(vncKeyForScancode(0x02, false, true)).toEqual([0x31, "Digit1"]); // CapsLock 不影響數字
    expect(vncKeyForScancode(0x0b, true, false)).toEqual([0x29, "Digit0"]); // )
    expect(vncKeyForScancode(0x28, true, false)).toEqual([0x22, "Quote"]); // "
    expect(vncKeyForScancode(0x39, false, false)).toEqual([0x20, "Space"]);
  });

  it("系統鍵與功能鍵", () => {
    expect(vncKeyForScancode(0xe05b, false, false)).toEqual([XK.Super_L, "MetaLeft"]);
    expect(vncKeyForScancode(0x0f, false, false)).toEqual([XK.Tab, "Tab"]);
    expect(vncKeyForScancode(0x3e, false, false)).toEqual([0xffc1, "F4"]);
    expect(vncKeyForScancode(0x57, false, false)).toEqual([0xffc8, "F11"]);
    expect(vncKeyForScancode(0x58, false, false)).toEqual([0xffc9, "F12"]);
    expect(vncKeyForScancode(0xe053, false, false)).toEqual([XK.Delete, "Delete"]);
    expect(vncKeyForScancode(0xe11d, false, false)).toEqual([XK.Pause, "Pause"]);
    expect(vncKeyForScancode(0x7f, false, false)).toBeNull();
  });

  it("虛擬鍵盤上的每一顆鍵都認得", () => {
    const missing = [...MAIN_ROWS, ...NAV_ROWS].flat().filter((k) => !k.gap && !vncKeyForScancode(k.sc, false, false));
    expect(missing.map((k) => k.l)).toEqual([]);
  });

  it("虛擬鍵盤印的 Shift 字跟送出去的一樣", () => {
    for (const k of [...MAIN_ROWS, ...NAV_ROWS].flat()) {
      if (!k.s) continue;
      expect(String.fromCharCode(vncKeyForScancode(k.sc, true, false)![0])).toBe(k.s);
    }
  });
});

describe("keysymsForText", () => {
  it("ASCII、換行、Tab；大寫與 Shift 符號標要按 Shift", () => {
    expect(keysymsForText("Ab1!\r\n\t")).toEqual([
      [0x41, true], [0x62, false], [0x31, false], [0x21, true], [XK.Return, false], [XK.Tab, false],
    ]);
    expect(keysymsForText("~_{\"?")).toEqual([[0x7e, true], [0x5f, true], [0x7b, true], [0x22, true], [0x3f, true]]);
  });

  it("Latin-1 用碼位，其他用 Unicode keysym，emoji 不拆開", () => {
    expect(keysymForChar(0xe9)).toBe(0xe9); // é
    expect(keysymsForText("中")).toEqual([[0x01004e2d, false]]);
    expect(keysymsForText("😀")).toEqual([[0x0101f600, false]]);
  });

  it("其他控制字元略過", () => {
    expect(keysymsForText("a\u0007b")).toEqual([[0x61, false], [0x62, false]]);
  });
});
