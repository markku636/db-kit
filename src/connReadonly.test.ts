import { describe, it, expect, beforeEach } from "vitest";
import { isReadonly, setReadonlyFlag, loadReadonly, persistReadonly, persistedReadonly, formatRemaining, READONLY_KEY, type ReadonlyMap } from "./connReadonly";

const __mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in __mem ? __mem[k] : null),
  setItem: (k: string, v: string) => { __mem[k] = String(v); },
  removeItem: (k: string) => { delete __mem[k]; },
  clear: () => { for (const k of Object.keys(__mem)) delete __mem[k]; },
  key: () => null,
  length: 0,
} as unknown as Storage;

describe("連線唯讀模式（connReadonly）", () => {
  beforeEach(() => localStorage.removeItem(READONLY_KEY));

  it("setReadonlyFlag / isReadonly：設定與清除、不改原 map", () => {
    const a: ReadonlyMap = {};
    const b = setReadonlyFlag(a, "c1", true);
    expect(isReadonly(b, "c1")).toBe(true);
    expect(a).toEqual({});
    expect(isReadonly(b, "c2")).toBe(false);
    expect(isReadonly(b, null)).toBe(false);
    // 清除。
    expect(setReadonlyFlag(b, "c1", false)).toEqual({});
  });

  it("persist / load 往返；過濾非 true 值與損毀存檔", () => {
    persistReadonly({ c1: true });
    expect(loadReadonly()).toEqual({ c1: true });
    localStorage.setItem(READONLY_KEY, JSON.stringify({ a: true, b: false, c: 1, d: "x" }));
    expect(loadReadonly()).toEqual({ a: true });
    localStorage.setItem(READONLY_KEY, "[1,2]");
    expect(loadReadonly()).toEqual({});
    localStorage.setItem(READONLY_KEY, "{bad");
    expect(loadReadonly()).toEqual({});
  });
});

describe("暫時解鎖", () => {
  it("persistedReadonly：暫時解鎖中的連線在存檔裡仍是唯讀", () => {
    expect(persistedReadonly({ a: true }, { b: Date.now() + 1000 })).toEqual({ a: true, b: true });
  });
  it("formatRemaining：m:ss、不出負數", () => {
    expect(formatRemaining(299_001)).toBe("5:00");
    expect(formatRemaining(61_000)).toBe("1:01");
    expect(formatRemaining(-5)).toBe("0:00");
  });
});
