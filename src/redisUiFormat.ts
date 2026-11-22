// Redis 畫面的純函式（無 React / DOM 相依，node 環境可直接單測）。

export const REDIS_PATTERN_HISTORY_KEY = "dbkit:redisPatternHistory";

/** ARDM 的 search history：記住最近用過的 MATCH 樣式，最新的排最前，最多 20 條；`*` 不記。 */
export function recordRedisPattern(history: readonly string[], pattern: string): string[] {
  const p = pattern.trim();
  if (!p || p === "*") return [...history];
  return [p, ...history.filter((h) => h !== p)].slice(0, 20);
}

/**
 * TTL 秒數轉可讀字串（仿 ARDM）：-1 永不過期，其餘拆成 d/h/m/s。
 * 單位用語言中立的縮寫（與 uptime 一致），「無到期」由呼叫端用 t() 處理。
 */
export function fmtRedisTtl(ttl: number): string {
  if (!Number.isFinite(ttl) || ttl < 0) return ""; // 呼叫端顯示 t("無到期")
  if (ttl === 0) return "0s";
  const d = Math.floor(ttl / 86400);
  const h = Math.floor((ttl % 86400) / 3600);
  const m = Math.floor((ttl % 3600) / 60);
  const s = Math.floor(ttl % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 連線設定裡選的 DB 索引要當主控台預設 DB；設定不存在 / 不在清單裡則退回第一個（通常 0）。 */
export function effectiveRedisDb(configured: string | null | undefined, available: readonly string[]): string {
  const c = (configured ?? "").trim();
  if (c && available.includes(c)) return c;
  return available[0] ?? "0";
}

/** INFO uptime 轉可讀字串；剛啟動不到一分鐘要顯示秒數，不能 show “0m”。 */
export function fmtUptime(secsStr?: string): string {
  const secs = Number(secsStr);
  if (!Number.isFinite(secs) || secs <= 0) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m === 0) return `${Math.floor(secs)}s`;
  return `${m}m`;
}

// 數字片段用自然排序：user:2 要排在 user:10 前面；sensitivity: base 避免大小寫
// 依機器 locale 亂掉（本機排序結果不該因作業系統語系而不同）。
const SEG_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function compareSegments(a: string, b: string): number {
  return SEG_COLLATOR.compare(a, b);
}
