import { describe, it, expect, beforeEach } from "vitest";

// node 測試環境無 localStorage，提供最小記憶體實作。
const __mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in __mem ? __mem[k] : null),
  setItem: (k: string, v: string) => { __mem[k] = String(v); },
  removeItem: (k: string) => { delete __mem[k]; },
  clear: () => { for (const k of Object.keys(__mem)) delete __mem[k]; },
  key: () => null,
  length: 0,
} as unknown as Storage;

const {
  SESSION_KEY, MAX_QUERY_TABS, isQueryTabId, normalizeSession,
  loadSession, persistSession, saveQueryTabSession,
} = await import("./session");

const DEFAULT = { queryTabs: ["__query__"], activeQueryTab: "__query__" };

beforeEach(() => {
  localStorage.removeItem(SESSION_KEY);
  loadSession(); // 重設模組層的 lastActiveQueryTab 記憶，各案例互不干擾
});

describe("isQueryTabId", () => {
  it("接受 home 與 :2 起跳的分頁 id", () => {
    expect(isQueryTabId("__query__")).toBe(true);
    expect(isQueryTabId("__query__:2")).toBe(true);
    expect(isQueryTabId("__query__:10")).toBe(true);
  });

  it("擋掉 nextQueryTabId 產不出來的 id（:0 / :1 / 前導零）與表分頁鍵", () => {
    for (const bad of ["__query__:0", "__query__:1", "__query__:02", "__query__:", "c1:db:users", "", "query"]) {
      expect(isQueryTabId(bad)).toBe(false);
    }
    expect(isQueryTabId(null)).toBe(false);
    expect(isQueryTabId(3)).toBe(false);
  });
});

describe("normalizeSession", () => {
  it("存檔損毀（非物件 / queryTabs 非陣列）退回預設的單一 home 分頁", () => {
    for (const junk of [null, undefined, "x", 5, [], {}, { queryTabs: "__query__" }]) {
      expect(normalizeSession(junk)).toEqual(DEFAULT);
    }
  });

  it("濾掉非法 id 並去重，順序照存檔", () => {
    expect(normalizeSession({ queryTabs: ["__query__:3", "bad", "__query__", "__query__:3", null] }))
      .toEqual({ queryTabs: ["__query__:3", "__query__"], activeQueryTab: "__query__:3" });
  });

  it("截到分頁數上限", () => {
    const many = ["__query__", ...Array.from({ length: 80 }, (_, i) => `__query__:${i + 2}`)];
    expect(normalizeSession({ queryTabs: many }).queryTabs).toHaveLength(MAX_QUERY_TABS);
  });

  it("active 還原；不在清單內（或本身非法）則退回第一個", () => {
    const tabs = ["__query__", "__query__:2"];
    expect(normalizeSession({ queryTabs: tabs, activeQueryTab: "__query__:2" }).activeQueryTab).toBe("__query__:2");
    expect(normalizeSession({ queryTabs: tabs, activeQueryTab: "__query__:9" }).activeQueryTab).toBe("__query__");
    expect(normalizeSession({ queryTabs: tabs, activeQueryTab: "c1:db:t" }).activeQueryTab).toBe("__query__");
    expect(normalizeSession({ queryTabs: tabs }).activeQueryTab).toBe("__query__");
  });

  it("空陣列是使用者「全部關閉」的真實選擇，照實還原（不當成損毀）", () => {
    expect(normalizeSession({ queryTabs: [], activeQueryTab: "__query__" }))
      .toEqual({ queryTabs: [], activeQueryTab: null });
  });
});

describe("loadSession / persistSession", () => {
  it("沒有存檔 → 預設；壞 JSON → 預設", () => {
    expect(loadSession()).toEqual(DEFAULT);
    localStorage.setItem(SESSION_KEY, "{not json");
    expect(loadSession()).toEqual(DEFAULT);
  });

  it("往返：存進去的分頁清單原樣還原", () => {
    const s = { queryTabs: ["__query__", "__query__:2", "__query__:5"], activeQueryTab: "__query__:5" };
    persistSession(s);
    expect(loadSession()).toEqual(s);
  });
});

describe("saveQueryTabSession", () => {
  it("記下作用中的查詢分頁", () => {
    saveQueryTabSession(["__query__", "__query__:2"], "__query__:2");
    expect(loadSession().activeQueryTab).toBe("__query__:2");
  });

  it("切去表分頁不覆寫「停在哪個查詢分頁」", () => {
    saveQueryTabSession(["__query__", "__query__:2"], "__query__:2");
    saveQueryTabSession(["__query__", "__query__:2"], "c1:db:users"); // 去看一張表
    expect(loadSession()).toEqual({ queryTabs: ["__query__", "__query__:2"], activeQueryTab: "__query__:2" });
  });

  it("記住的分頁被關掉後退回第一個；全關光則為 null", () => {
    saveQueryTabSession(["__query__", "__query__:2"], "__query__:2");
    saveQueryTabSession(["__query__"], "c1:db:users"); // :2 已關閉，作用中在表分頁
    expect(loadSession().activeQueryTab).toBe("__query__");
    saveQueryTabSession([], null);
    expect(loadSession()).toEqual({ queryTabs: [], activeQueryTab: null });
  });
});
