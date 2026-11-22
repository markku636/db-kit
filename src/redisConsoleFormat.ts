import type { QueryResult } from "./api";
import type { Params } from "./i18n";

type T = (key: string, params?: Params) => string;

/**
 * Redis 主控台的輸出格式化（純函式，便於測試）。
 *
 * Redis 的 query 通道永遠回傳「一列一個值」，rows_affected 固定是 0：空結果印
 * 「(已執行；影響 0 列)」是 SQL 的用語，在 Redis 毫無意義，改印「(無結果)」。
 * 後端 query_capped 又會在到達 row cap 時截斷並設 truncated；不告訴使用者的話，
 * HGETALL 一個五千欄的 hash 只看到一千行，看起來就像完整的資料。
 */
export function formatRedisConsoleLines(
  res: Pick<QueryResult, "rows" | "truncated">,
  t: T,
): string[] {
  const lines: string[] = res.rows.map((r) => r[0] ?? "(nil)");
  if (lines.length === 0) lines.push(t("（無結果）"));
  if (res.truncated) lines.push(t("（結果已達上限，僅顯示前 {n} 列）", { n: res.rows.length }));
  return lines;
}

/** 指令歷史：連續相同的指令不重複記（↑ 連按兩次仍只回到同一條）。 */
export function recordRedisConsoleHistory(history: readonly string[], cmd: string): string[] {
  return history[history.length - 1] === cmd ? [...history] : [...history, cmd];
}
