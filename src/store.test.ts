import { describe, it, expect, beforeEach, vi } from "vitest";

// vitest 跑在 node 環境（無 jsdom）：store 模組載入時會經 loadReadonly / loadSavedQueries /
// loadSnippets 讀 localStorage，先補一份 in-memory 版本再 import。
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}
vi.stubGlobal("localStorage", new MemoryStorage());

const { useStore, nextQueryTabId } = await import("./store");

const s = () => useStore.getState();

// 每個案例從乾淨的分頁狀態開始（只重設本檔關心的欄位，其餘保留 store 預設）。
beforeEach(() => {
  useStore.setState({ tabs: [], activeTabKey: null, queryTabs: ["__query__"] });
});

const openTwoTables = () => {
  s().openTable("c1", "db", "t1");
  s().openTable("c1", "db", "t2");
};

describe("nextQueryTabId", () => {
  it("沒有 home 時先補 home（全部關光後按「+」回到乾淨的 __query__）", () => {
    expect(nextQueryTabId([])).toBe("__query__");
    expect(nextQueryTabId(["__query__:3"])).toBe("__query__");
  });

  it("有 home 時往 :2、:3 找空號（跳過已佔用的）", () => {
    expect(nextQueryTabId(["__query__"])).toBe("__query__:2");
    expect(nextQueryTabId(["__query__", "__query__:2"])).toBe("__query__:3");
    expect(nextQueryTabId(["__query__", "__query__:3"])).toBe("__query__:2");
  });
});

describe("closeQueryTab — 第一個「查詢」分頁也能關", () => {
  it("只有一個查詢分頁、且有表分頁時，關掉它 → 落在最後一個表分頁", () => {
    openTwoTables();
    s().setActiveTab("__query__");
    s().closeQueryTab("__query__");
    expect(s().queryTabs).toEqual([]);
    expect(s().activeTabKey).toBe("c1:db:t2");
  });

  it("沒有表分頁時也能關到零 → activeTabKey 為 null（主區顯示空狀態）", () => {
    s().closeQueryTab("__query__");
    expect(s().queryTabs).toEqual([]);
    expect(s().activeTabKey).toBeNull();
  });

  it("關掉作用中的查詢分頁 → 切到相鄰的查詢分頁", () => {
    s().addQueryTab(); // __query__:2，並設為作用中
    expect(s().activeTabKey).toBe("__query__:2");
    s().closeQueryTab("__query__:2");
    expect(s().queryTabs).toEqual(["__query__"]);
    expect(s().activeTabKey).toBe("__query__");
  });

  it("關掉非作用中的分頁 → 停在原本的分頁上", () => {
    s().addQueryTab();
    s().setActiveTab("__query__:2");
    s().closeQueryTab("__query__");
    expect(s().queryTabs).toEqual(["__query__:2"]);
    expect(s().activeTabKey).toBe("__query__:2");
  });

  it("不存在的 id 不動狀態", () => {
    s().closeQueryTab("__query__:9");
    expect(s().queryTabs).toEqual(["__query__"]);
  });

  it("關到零後「+」可回到乾淨的 home", () => {
    s().closeQueryTab("__query__");
    s().addQueryTab();
    expect(s().queryTabs).toEqual(["__query__"]);
    expect(s().activeTabKey).toBe("__query__");
  });
});

describe("closeAllQueryTabs / closeOtherQueryTabs", () => {
  it("全部關閉查詢 → 查詢分頁歸零；在表分頁上時不動作用中分頁", () => {
    openTwoTables();
    s().addQueryTab();
    s().setActiveTab("c1:db:t1");
    s().closeAllQueryTabs();
    expect(s().queryTabs).toEqual([]);
    expect(s().activeTabKey).toBe("c1:db:t1");
  });

  it("全部關閉查詢（人在查詢分頁上）→ 落在最後一個表分頁", () => {
    openTwoTables();
    s().setActiveTab("__query__");
    s().closeAllQueryTabs();
    expect(s().activeTabKey).toBe("c1:db:t2");
  });

  it("關閉其他查詢 → 只留指定的那個", () => {
    s().addQueryTab();
    s().addQueryTab();
    s().closeOtherQueryTabs("__query__:2");
    expect(s().queryTabs).toEqual(["__query__:2"]);
    expect(s().activeTabKey).toBe("__query__:2");
  });
});

describe("closeTab — 表分頁關光後的落點", () => {
  it("退回第一個查詢分頁", () => {
    openTwoTables();
    s().closeTab("c1:db:t2");
    expect(s().activeTabKey).toBe("c1:db:t1");
    s().closeTab("c1:db:t1");
    expect(s().activeTabKey).toBe("__query__");
  });

  it("查詢分頁也已關光時 → null，不會指向不存在的分頁", () => {
    openTwoTables();
    s().closeQueryTab("__query__");
    s().closeAllTabs();
    expect(s().tabs).toEqual([]);
    expect(s().queryTabs).toEqual([]);
    expect(s().activeTabKey).toBeNull();
  });
});

describe("requestQuery — 查詢分頁被關光時仍能承接 SQL", () => {
  it("沒有查詢分頁時現開一個並帶入 pendingSql", () => {
    openTwoTables();
    s().closeQueryTab("__query__");
    s().requestQuery("select 1");
    expect(s().queryTabs).toEqual(["__query__"]);
    expect(s().activeTabKey).toBe("__query__");
    expect(s().pendingSql).toBe("select 1");
  });

  it("已在某個查詢分頁上 → 留在原分頁", () => {
    s().addQueryTab();
    s().setActiveTab("__query__:2");
    s().requestQuery("select 2");
    expect(s().activeTabKey).toBe("__query__:2");
    expect(s().pendingSql).toBe("select 2");
  });
});

describe("markDisconnected", () => {
  it("關掉該連線的表分頁後仍有落點（查詢分頁已關光時退回其他連線的表分頁）", () => {
    s().openTable("c1", "db", "t1");
    s().openTable("c2", "db", "t2");
    s().closeQueryTab("__query__");
    s().setActiveTab("c1:db:t1");
    s().markDisconnected("c1");
    expect(s().tabs.map((t) => t.key)).toEqual(["c2:db:t2"]);
    expect(s().activeTabKey).toBe("c2:db:t2");
  });
});
