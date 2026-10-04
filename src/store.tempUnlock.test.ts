import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// store 模組載入時會讀 localStorage：先放一個記憶體版。
const mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => { mem[k] = String(v); },
  removeItem: (k: string) => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
  key: () => null,
  length: 0,
} as Storage;

const { useStore } = await import("./store");
const { READONLY_KEY } = await import("./connReadonly");
const saved = () => JSON.parse(localStorage.getItem(READONLY_KEY) ?? "{}");

describe("唯讀連線暫時解鎖", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.getState().setConnReadonly("c1", true);
  });
  afterEach(() => {
    useStore.getState().setConnReadonly("c1", false);
    vi.useRealTimers();
  });

  it("解鎖期間可寫、存檔仍是唯讀；時間到自動鎖回", () => {
    useStore.getState().tempUnlockConn("c1", 60_000);
    expect(useStore.getState().readonlyConns.c1).toBeUndefined();
    expect(useStore.getState().tempUnlocks.c1).toBeGreaterThan(Date.now());
    expect(saved().c1).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(useStore.getState().readonlyConns.c1).toBe(true);
    expect(useStore.getState().tempUnlocks.c1).toBeUndefined();
  });

  it("解鎖期間改別條連線的唯讀，不會把暫時解鎖寫進存檔", () => {
    useStore.getState().tempUnlockConn("c1", 60_000);
    useStore.getState().setConnReadonly("c2", true);
    expect(saved()).toEqual({ c1: true, c2: true });
    useStore.getState().setConnReadonly("c2", false);
  });

  it("立即鎖回會取消計時器；明確關閉唯讀會取代暫時解鎖", () => {
    useStore.getState().tempUnlockConn("c1", 60_000);
    useStore.getState().relockConn("c1");
    expect(useStore.getState().readonlyConns.c1).toBe(true);
    useStore.getState().tempUnlockConn("c1", 60_000);
    useStore.getState().setConnReadonly("c1", false);
    vi.advanceTimersByTime(60_000);
    expect(useStore.getState().readonlyConns.c1).toBeUndefined();
    expect(saved().c1).toBeUndefined();
  });

  it("不是唯讀的連線不能「暫時解鎖」", () => {
    useStore.getState().tempUnlockConn("c9", 60_000);
    expect(useStore.getState().tempUnlocks.c9).toBeUndefined();
  });
});
