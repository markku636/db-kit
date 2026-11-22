import { describe, it, expect } from "vitest";
import type { Params } from "./i18n";
import type { QueryResult } from "./api";
import { formatRedisConsoleLines, recordRedisConsoleHistory } from "./redisConsoleFormat";

// 測試用的 t：身份 fallback + 簡單插值（與 i18n.interpolate 的行為一致）。
const t = (key: string, params?: Params) =>
  params ? key.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : key)) : key;

const res = (rows: (string | null)[][], truncated?: boolean): Pick<QueryResult, "rows" | "truncated"> => ({
  rows, truncated,
});

describe("formatRedisConsoleLines", () => {
  it("prints one line per returned value, with (nil) for null", () => {
    expect(formatRedisConsoleLines(res([["a"], [null], ["3"]]), t)).toEqual(["a", "(nil)", "3"]);
  });

  it("prints a neutral message for empty results instead of SQL-style rows affected", () => {
    // LRANGE missing 0 -1 / SMEMBERS 空集合：Redis 的 rows_affected 永遠是 0。
    expect(formatRedisConsoleLines(res([]), t)).toEqual(["（無結果）"]);
  });

  it("warns when the backend truncated the result at the row cap", () => {
    // HGETALL 五千欄的 hash 只會拿到 1000 列，不明講就像完整資料。
    const rows = Array.from({ length: 1000 }, (_, i) => [`f${i}`]);
    expect(formatRedisConsoleLines(res(rows, true), t)).toEqual([
      ...rows.map((r) => r[0]),
      "（結果已達上限，僅顯示前 1000 列）",
    ]);
  });

  it("does not warn when truncation is false or absent", () => {
    expect(formatRedisConsoleLines(res([["x"]], false), t)).toEqual(["x"]);
    expect(formatRedisConsoleLines(res([["x"]]), t)).toEqual(["x"]);
  });
});

describe("recordRedisConsoleHistory", () => {
  it("appends a command and deduplicates consecutive repeats", () => {
    expect(recordRedisConsoleHistory([], "GET a")).toEqual(["GET a"]);
    expect(recordRedisConsoleHistory(["GET a"], "GET a")).toEqual(["GET a"]);
    // 回傳新陣列，不改動傳入的歷史（React state 不變性）。
    const h = ["GET a"];
    expect(recordRedisConsoleHistory(h, "SET a 1")).toEqual(["GET a", "SET a 1"]);
    expect(h).toEqual(["GET a"]);
  });
});
