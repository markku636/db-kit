import { describe, it, expect, beforeEach } from "vitest";
import { QUERY_SQL_PREFIX, sqlStoreKey, parseSqlStoreKey, pruneQueryDrafts } from "./queryDrafts";

// node 測試環境無 localStorage：最小記憶體實作（需支援 length / key(i) 供掃描）。
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

describe("sqlStoreKey / parseSqlStoreKey", () => {
  it("home 分頁沿用不帶後綴的舊鍵；其餘分頁接 :<tabId>", () => {
    expect(sqlStoreKey("c1")).toBe(`${QUERY_SQL_PREFIX}c1`);
    expect(sqlStoreKey("c1", "__query__")).toBe(`${QUERY_SQL_PREFIX}c1`);
    expect(sqlStoreKey("c1", "__query__:2")).toBe(`${QUERY_SQL_PREFIX}c1:__query__:2`);
  });

  it("往返：組出來的鍵能反解回 connId / tabId", () => {
    expect(parseSqlStoreKey(sqlStoreKey("c1"))).toEqual({ connId: "c1", tabId: "__query__" });
    expect(parseSqlStoreKey(sqlStoreKey("c1", "__query__:12"))).toEqual({ connId: "c1", tabId: "__query__:12" });
    // uuid 形狀的 connId 也不受影響
    const uuid = "3f2c1b7e-9a1d-4e0b-8c2a-5d6e7f8a9b0c";
    expect(parseSqlStoreKey(sqlStoreKey(uuid, "__query__:3"))).toEqual({ connId: uuid, tabId: "__query__:3" });
  });

  it("非草稿鍵一律回 null，不會被誤刪", () => {
    expect(parseSqlStoreKey("db-kit:session")).toBeNull();
    expect(parseSqlStoreKey("db-kit:queryDb:c1")).toBeNull();
    expect(parseSqlStoreKey("db-kit:queryHistory")).toBeNull();
    expect(parseSqlStoreKey(QUERY_SQL_PREFIX)).toBeNull();               // 沒有 connId
    expect(parseSqlStoreKey(`${QUERY_SQL_PREFIX}:__query__:2`)).toBeNull(); // connId 為空
  });

  it("形狀對不上 nextQueryTabId 產物的後綴（:0 / :1 / 前導零 / 重複 home）回 null", () => {
    expect(parseSqlStoreKey(`${QUERY_SQL_PREFIX}c1:__query__:0`)).toBeNull();
    expect(parseSqlStoreKey(`${QUERY_SQL_PREFIX}c1:__query__:1`)).toBeNull();
    expect(parseSqlStoreKey(`${QUERY_SQL_PREFIX}c1:__query__:02`)).toBeNull();
    expect(parseSqlStoreKey(`${QUERY_SQL_PREFIX}c1:__query__`)).toBeNull();
  });
});

describe("pruneQueryDrafts", () => {
  it("刪掉不在開啟清單裡的分頁草稿（跨所有連線），保留仍開著的", () => {
    storage.setItem(sqlStoreKey("c1"), "home c1");
    storage.setItem(sqlStoreKey("c1", "__query__:2"), "tab2 c1");
    storage.setItem(sqlStoreKey("c2", "__query__:2"), "tab2 c2");
    storage.setItem(sqlStoreKey("c1", "__query__:3"), "tab3 c1");
    const removed = pruneQueryDrafts(["__query__", "__query__:3"], storage);
    expect(removed.map((d) => [d.connId, d.tabId, d.sql]).sort()).toEqual([
      ["c1", "__query__:2", "tab2 c1"],
      ["c2", "__query__:2", "tab2 c2"],
    ]);
    expect(storage.getItem(sqlStoreKey("c1"))).toBe("home c1");
    expect(storage.getItem(sqlStoreKey("c1", "__query__:3"))).toBe("tab3 c1");
    expect(storage.getItem(sqlStoreKey("c1", "__query__:2"))).toBeNull();
    expect(storage.getItem(sqlStoreKey("c2", "__query__:2"))).toBeNull();
  });

  it("home 分頁關掉時也會清掉舊鍵草稿", () => {
    storage.setItem(sqlStoreKey("c1"), "home c1");
    storage.setItem(sqlStoreKey("c1", "__query__:2"), "tab2 c1");
    const removed = pruneQueryDrafts(["__query__:2"], storage);
    expect(removed).toEqual([{ connId: "c1", tabId: "__query__", sql: "home c1" }]);
    expect(storage.getItem(sqlStoreKey("c1"))).toBeNull();
    expect(storage.getItem(sqlStoreKey("c1", "__query__:2"))).toBe("tab2 c1");
  });

  it("全部關光 → 所有草稿都清掉；其他 db-kit 鍵不受影響", () => {
    storage.setItem(sqlStoreKey("c1"), "home c1");
    storage.setItem(sqlStoreKey("c1", "__query__:2"), "tab2 c1");
    storage.setItem("db-kit:session", "{}");
    storage.setItem("db-kit:queryDb:c1", "mydb");
    storage.setItem("db-kit:queryHistory", "[]");
    expect(pruneQueryDrafts([], storage)).toHaveLength(2);
    expect(storage.length).toBe(3);
    expect(storage.getItem("db-kit:session")).toBe("{}");
    expect(storage.getItem("db-kit:queryDb:c1")).toBe("mydb");
    expect(storage.getItem("db-kit:queryHistory")).toBe("[]");
  });

  it("沒有可清的就回空陣列、不動任何鍵", () => {
    storage.setItem(sqlStoreKey("c1"), "home c1");
    expect(pruneQueryDrafts(["__query__"], storage)).toEqual([]);
    expect(storage.getItem(sqlStoreKey("c1"))).toBe("home c1");
  });

  it("多筆連續刪除不會因索引位移而漏掉（先收集鍵再刪）", () => {
    for (let i = 2; i <= 20; i++) storage.setItem(sqlStoreKey("c1", `__query__:${i}`), `tab${i}`);
    expect(pruneQueryDrafts(["__query__"], storage)).toHaveLength(19);
    expect(storage.length).toBe(0);
  });
});
