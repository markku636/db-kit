import { describe, it, expect, beforeEach } from "vitest";
import { togglePin, isPinned, removePinsForConn, loadPins, persistPins, PINS_KEY, type PinnedTable } from "./pins";

const __mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in __mem ? __mem[k] : null),
  setItem: (k: string, v: string) => { __mem[k] = String(v); },
  removeItem: (k: string) => { delete __mem[k]; },
  clear: () => { for (const k of Object.keys(__mem)) delete __mem[k]; },
  key: () => null,
  length: 0,
} as unknown as Storage;

const p = (connId: string, db: string, table: string, kind = "table"): PinnedTable => ({ connId, db, table, kind });

describe("pinned tables（常用資料表）", () => {
  beforeEach(() => localStorage.removeItem(PINS_KEY));

  it("togglePin：加入 / 移除、isPinned 判定（以 connId+db+table 為鍵）", () => {
    let list: PinnedTable[] = [];
    list = togglePin(list, p("c1", "shop", "orders"));
    expect(isPinned(list, p("c1", "shop", "orders"))).toBe(true);
    expect(list).toHaveLength(1);
    // 同鍵再切換 → 移除。
    list = togglePin(list, p("c1", "shop", "orders"));
    expect(isPinned(list, p("c1", "shop", "orders"))).toBe(false);
    expect(list).toHaveLength(0);
    // 不同庫同表名 → 視為不同釘選。
    list = togglePin(togglePin(list, p("c1", "shop", "orders")), p("c1", "warehouse", "orders"));
    expect(list).toHaveLength(2);
  });

  it("removePinsForConn：刪除某連線的所有釘選", () => {
    const list = [p("c1", "a", "t1"), p("c1", "a", "t2"), p("c2", "b", "t3")];
    expect(removePinsForConn(list, "c1")).toEqual([p("c2", "b", "t3")]);
  });

  it("persist / load 往返；過濾損毀項與非陣列", () => {
    persistPins([p("c1", "shop", "orders", "view")]);
    expect(loadPins()).toEqual([p("c1", "shop", "orders", "view")]);
    localStorage.setItem(PINS_KEY, JSON.stringify([{ connId: "c", db: "d", table: "t" }, { bad: 1 }, null, "x"]));
    expect(loadPins()).toEqual([p("c", "d", "t")]); // kind 缺省補 table
    localStorage.setItem(PINS_KEY, "{not json");
    expect(loadPins()).toEqual([]);
  });
});
