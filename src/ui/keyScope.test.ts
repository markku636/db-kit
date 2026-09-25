import { describe, it, expect } from "vitest";
import { inTerminal, isAppReserved, type KeyLike } from "./keyScope";

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods,
});
const ctrl = (key: string, extra: Partial<KeyLike> = {}) => k(key, { ctrlKey: true, ...extra });
const meta = (key: string, extra: Partial<KeyLike> = {}) => k(key, { metaKey: true, ...extra });

describe("isAppReserved：保留給 app 的組合鍵", () => {
  it("Ctrl/Cmd+Shift+T / W / F / C / V", () => {
    for (const key of ["T", "W", "F", "C", "V"]) {
      expect(isAppReserved(ctrl(key, { shiftKey: true })), key).toBe(true);
      expect(isAppReserved(meta(key, { shiftKey: true })), key).toBe(true);
    }
    // 某些鍵盤配置 key 不是字母時靠 code
    expect(isAppReserved(ctrl("Т", { shiftKey: true, code: "KeyT" }))).toBe(true);
  });

  it("Ctrl+Tab / Ctrl+Shift+Tab", () => {
    expect(isAppReserved(ctrl("Tab"))).toBe(true);
    expect(isAppReserved(ctrl("Tab", { shiftKey: true }))).toBe(true);
  });

  it("Ctrl/Cmd+= / + / − / 0 含數字鍵盤加減", () => {
    for (const key of ["=", "+", "-", "0"]) {
      expect(isAppReserved(ctrl(key)), key).toBe(true);
      expect(isAppReserved(meta(key)), key).toBe(true);
    }
    expect(isAppReserved(ctrl("+", { shiftKey: true }))).toBe(true);
    expect(isAppReserved(ctrl("Add", { code: "NumpadAdd" }))).toBe(true);
    expect(isAppReserved(ctrl("Subtract", { code: "NumpadSubtract" }))).toBe(true);
  });

  it("F1（不論修飾鍵）", () => {
    expect(isAppReserved(k("F1"))).toBe(true);
  });
});

describe("isAppReserved：其餘全進 shell", () => {
  it("Ctrl+L / W / T / K / C / D / Z / R（無 Shift）", () => {
    for (const key of ["l", "w", "t", "k", "c", "d", "z", "r", "n"]) {
      expect(isAppReserved(ctrl(key)), key).toBe(false);
    }
  });

  it("Ctrl+數字、Tab、方向鍵、純字母、Shift 單獨", () => {
    for (let i = 1; i <= 9; i++) expect(isAppReserved(ctrl(String(i)))).toBe(false);
    expect(isAppReserved(k("Tab"))).toBe(false);
    expect(isAppReserved(k("Tab", { shiftKey: true }))).toBe(false);
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(isAppReserved(k(key))).toBe(false);
    }
    expect(isAppReserved(k("a"))).toBe(false);
    expect(isAppReserved(k("T", { shiftKey: true }))).toBe(false);
  });

  it("帶 Alt（AltGr 打字）不算保留鍵", () => {
    expect(isAppReserved(ctrl("0", { altKey: true }))).toBe(false);
    expect(isAppReserved(ctrl("T", { shiftKey: true, altKey: true }))).toBe(false);
  });
});

describe("inTerminal", () => {
  it("target.closest('.xterm') 命中才算", () => {
    const hit = { target: { closest: (sel: string) => (sel === ".xterm" ? {} : null) } };
    const miss = { target: { closest: () => null } };
    expect(inTerminal(hit)).toBe(true);
    expect(inTerminal(miss)).toBe(false);
  });

  it("沒有 target / 非元素 / closest 丟例外 一律 false", () => {
    expect(inTerminal(null)).toBe(false);
    expect(inTerminal({})).toBe(false);
    expect(inTerminal({ target: null })).toBe(false);
    expect(inTerminal({ target: "text" })).toBe(false);
    expect(inTerminal({ target: { closest: () => { throw new Error("x"); } } })).toBe(false);
  });
});
