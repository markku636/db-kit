// Redis 畫面的純函式（無 React / DOM 相依，node 環境可直接單測）。

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
