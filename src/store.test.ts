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
const { QUERY_SQL_PREFIX, sqlStoreKey } = await import("./queryDrafts");
const { loadQueryHistory } = await import("./sql");
type ConnectionConfig = import("./api").ConnectionConfig;

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

describe("關閉查詢分頁 → 清掉該分頁草稿（所有連線）並存進歷史；新開同號分頁拿到乾淨狀態", () => {
  const conns = [{ id: "c1", name: "本機 MySQL" }] as unknown as ConnectionConfig[];
  const draftKeys = () => {
    const ks: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(QUERY_SQL_PREFIX)) ks.push(k); }
    return ks.sort();
  };
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ tabs: [], connections: conns, activeTabKey: "__query__:2", queryTabs: ["__query__", "__query__:2", "__query__:3"] });
    localStorage.setItem(sqlStoreKey("c1"), "SELECT 'home'");
    localStorage.setItem(sqlStoreKey("c1", "__query__:2"), "SELECT 'tab2 on c1'");
    localStorage.setItem(sqlStoreKey("c2", "__query__:2"), "SELECT 'tab2 on c2'");
    localStorage.setItem(sqlStoreKey("c1", "__query__:3"), "SELECT 'tab3'");
  });

  it("單關：只清該分頁（含其他連線下的同號草稿），其餘分頁草稿原樣保留", () => {
    s().closeQueryTab("__query__:2");
    expect(draftKeys()).toEqual([sqlStoreKey("c1"), sqlStoreKey("c1", "__query__:3")].sort());
    expect(localStorage.getItem(sqlStoreKey("c1"))).toBe("SELECT 'home'");
    expect(localStorage.getItem(sqlStoreKey("c1", "__query__:3"))).toBe("SELECT 'tab3'");
  });

  it("清掉的草稿進查詢歷史（帶連線名；連線已不存在則不帶），誤關救得回來", () => {
    s().closeQueryTab("__query__:2");
    const hist = loadQueryHistory();
    expect(hist.map((h) => h.sql).sort()).toEqual(["SELECT 'tab2 on c1'", "SELECT 'tab2 on c2'"]);
    expect(hist.find((h) => h.sql === "SELECT 'tab2 on c1'")?.connName).toBe("本機 MySQL");
    expect(hist.find((h) => h.sql === "SELECT 'tab2 on c2'")?.connName).toBeUndefined();
  });

  it("關掉再新增（Ctrl+N / +）拿到回收的同號 id，但不再有舊草稿", () => {
    s().closeQueryTab("__query__:2");
    s().addQueryTab();
    expect(s().queryTabs).toEqual(["__query__", "__query__:3", "__query__:2"]);
    expect(localStorage.getItem(sqlStoreKey("c1", "__query__:2"))).toBeNull();
    expect(localStorage.getItem(sqlStoreKey("c2", "__query__:2"))).toBeNull();
  });

  it("關其他：只留下指定分頁的草稿", () => {
    s().closeOtherQueryTabs("__query__:3");
    expect(draftKeys()).toEqual([sqlStoreKey("c1", "__query__:3")]);
  });

  it("全部關閉：草稿全清（含 home 的舊鍵）", () => {
    s().closeAllQueryTabs();
    expect(draftKeys()).toEqual([]);
    expect(loadQueryHistory()).toHaveLength(4);
  });

  it("只是切換分頁 / 開表分頁不會動到任何草稿（重開 app 才還原得回來）", () => {
    const before = draftKeys();
    s().setActiveTab("__query__");
    s().openTable("c1", "db", "t1");
    s().setActiveTab("__query__:3");
    expect(draftKeys()).toEqual(before);
    expect(loadQueryHistory()).toEqual([]);
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

// 工作階段還原的接線：store 的分頁 mutation 是否真的寫回 db-kit:session。
// session.ts 自己的正規化 / 還原規則另有 session.test.ts 覆蓋，這裡只驗「有接上」。
describe("工作階段持久化（訂閱寫回）", () => {
  const saved = () => JSON.parse(localStorage.getItem("db-kit:session") || "null");

  it("新增 / 切換 / 關閉查詢分頁都會寫回存檔", () => {
    s().addQueryTab();
    expect(saved()).toEqual({ queryTabs: ["__query__", "__query__:2"], activeQueryTab: "__query__:2" });
    s().setActiveTab("__query__");
    expect(saved().activeQueryTab).toBe("__query__");
    s().closeQueryTab("__query__:2");
    expect(saved()).toEqual({ queryTabs: ["__query__"], activeQueryTab: "__query__" });
  });

  it("開表分頁不會把記住的查詢分頁換成表分頁鍵（表分頁不還原）", () => {
    s().addQueryTab();
    s().openTable("c1", "db", "users");
    expect(s().activeTabKey).toBe("c1:db:users");
    expect(saved()).toEqual({ queryTabs: ["__query__", "__query__:2"], activeQueryTab: "__query__:2" });
  });

  it("全部關閉查詢分頁後存檔為空清單（下次啟動照實還原）", () => {
    s().addQueryTab();
    s().closeAllQueryTabs();
    expect(saved()).toEqual({ queryTabs: [], activeQueryTab: null });
  });
});
