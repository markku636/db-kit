import { describe, it, expect, beforeEach, vi } from "vitest";

// uiFont 模組載入當下就會讀 localStorage 並寫 CSS 變數（見該檔的 create() 初始化），
// 所以 stub 必須早於 import 生效 —— vi.hoisted 會被提到所有 import 之前執行。
const { mem, cssVars } = vi.hoisted(() => {
  const mem: Record<string, string> = {};
  const cssVars: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = String(v); },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
    key: () => null,
    length: 0,
  } as unknown as Storage;
  globalThis.document = {
    documentElement: {
      style: { setProperty: (k: string, v: string) => { cssVars[k] = v; } },
    },
  } as unknown as Document;
  return { mem, cssVars };
});

import {
  UI_FONT_KEY, UI_FONT_DEFAULT, UI_FONT_MIN, UI_FONT_MAX, UI_FONT_STEPS,
  clampUiFontSize, readStoredUiFontSize, applyUiFontSize, useUiFont,
} from "./uiFont";

describe("全域介面字級（uiFont）", () => {
  beforeEach(() => {
    localStorage.removeItem(UI_FONT_KEY);
    useUiFont.setState({ size: UI_FONT_DEFAULT });
  });

  it("clampUiFontSize：夾到 min/max、取整、非數字回預設", () => {
    expect(clampUiFontSize(16)).toBe(16);
    expect(clampUiFontSize(UI_FONT_MIN - 5)).toBe(UI_FONT_MIN);
    expect(clampUiFontSize(UI_FONT_MAX + 99)).toBe(UI_FONT_MAX);
    expect(clampUiFontSize(17.4)).toBe(17);
    expect(clampUiFontSize(17.6)).toBe(18);
    // NaN / Infinity（如 Number("abc")）不該被 Math.max 夾成邊界值，要回預設。
    expect(clampUiFontSize(Number("abc"))).toBe(UI_FONT_DEFAULT);
    expect(clampUiFontSize(Infinity)).toBe(UI_FONT_DEFAULT);
  });

  it("readStoredUiFontSize：無 / 損毀 / 超出範圍一律回預設", () => {
    expect(readStoredUiFontSize()).toBe(UI_FONT_DEFAULT);
    localStorage.setItem(UI_FONT_KEY, "not-a-number");
    expect(readStoredUiFontSize()).toBe(UI_FONT_DEFAULT);
    localStorage.setItem(UI_FONT_KEY, "");
    expect(readStoredUiFontSize()).toBe(UI_FONT_DEFAULT);
    // 超出範圍視為不可信（可能是舊版 / 手改），回預設而非夾邊界。
    localStorage.setItem(UI_FONT_KEY, String(UI_FONT_MAX + 1));
    expect(readStoredUiFontSize()).toBe(UI_FONT_DEFAULT);
    localStorage.setItem(UI_FONT_KEY, String(UI_FONT_MIN - 1));
    expect(readStoredUiFontSize()).toBe(UI_FONT_DEFAULT);
    localStorage.setItem(UI_FONT_KEY, "20");
    expect(readStoredUiFontSize()).toBe(20);
  });

  it("applyUiFontSize：寫進 <html> 的 --ui-font-size", () => {
    applyUiFontSize(18);
    expect(cssVars["--ui-font-size"]).toBe("18px");
  });

  it("setSize：夾範圍、套用 CSS 變數、寫回 localStorage", () => {
    useUiFont.getState().setSize(20);
    expect(useUiFont.getState().size).toBe(20);
    expect(cssVars["--ui-font-size"]).toBe("20px");
    expect(mem[UI_FONT_KEY]).toBe("20");
    // 超界輸入夾回邊界，存的也是夾過的值（重開 app 才讀得回來）。
    useUiFont.getState().setSize(999);
    expect(useUiFont.getState().size).toBe(UI_FONT_MAX);
    expect(mem[UI_FONT_KEY]).toBe(String(UI_FONT_MAX));
  });

  it("UI_FONT_STEPS：遞增、不重複、都在合法範圍內、且含預設值", () => {
    expect(UI_FONT_STEPS).toEqual([...UI_FONT_STEPS].sort((a, b) => a - b));
    expect(new Set(UI_FONT_STEPS).size).toBe(UI_FONT_STEPS.length);
    expect(UI_FONT_STEPS.every((n) => n >= UI_FONT_MIN && n <= UI_FONT_MAX)).toBe(true);
    // 沒有預設值這一段，使用者就回不到出廠外觀。
    expect(UI_FONT_STEPS).toContain(UI_FONT_DEFAULT);
    // 刻度本身即為合法值（clamp 不該改動任何一段）。
    expect(UI_FONT_STEPS.map(clampUiFontSize)).toEqual([...UI_FONT_STEPS]);
  });
});
