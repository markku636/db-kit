// Redis 畫面的純函式（無 React / DOM 相依，node 環境可直接單測）。

/** MONITOR 輸出上限（仿 ARDM：一直捲不完會吃爆記憶體）。 */
export const REDIS_MONITOR_MAX_LINES = 500;

/** 慢查詢過濾：指令 / 用戶端字串 + 最小耗時（毫秒）。 */
export function slowLogMatches(
  e: { command: string; client: string; client_name: string; duration_us: number },
  filter: string,
  minMs: number,
): boolean {
  if (minMs > 0 && e.duration_us < minMs * 1000) return false;
  return monitorLineMatches(`${e.command} ${e.client} ${e.client_name}`, filter);
}

/** 解析 `ACL LIST` 的一行：`user NAME on ...` → 使用者名稱與是否啟用；壞行不顯示。 */
export function parseAclLine(line: string): { name: string; enabled: boolean } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3 || parts[0].toLowerCase() !== "user") return null;
  return { name: parts[1], enabled: parts[2].toLowerCase() === "on" };
}

/** Pub/Sub 訊息過濾：比對頻道、樣式與內容（不分大小寫）。 */
export function pubSubLineMatches(line: { channel: string; pattern: string | null; payload: string }, filter: string): boolean {
  return monitorLineMatches(`${line.channel} ${line.pattern ?? ""} ${line.payload}`, filter);
}

/** 新的一行進來，保留最後 cap 行。 */
export function appendMonitorLine(lines: readonly string[], line: string, cap = REDIS_MONITOR_MAX_LINES): string[] {
  return [...lines, line].slice(-cap);
}

/** MONITOR 濾字串：比對整行（不分大小寫）。 */
export function monitorLineMatches(line: string, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  return !f || line.toLowerCase().includes(f);
}

/**
 * 解析主控台指令的 DB 前綴（`3:GET k`、`3 : GET k`、` 3 : FLUSHDB`）。
 * 大小寫無關不適用（數字），容忍冒號前後空白；最多 18 位避免後端 i64 溢位。
 * 回 null 表示沒有前綴（或前綴不合法，呼叫端不該把它當 DB 0 偷送）。
 */
export function parseRedisDbPrefix(input: string): { db: string; rest: string } | null {
  const m = /^\s*(\d{1,18})\s*:\s*([\s\S]*)$/.exec(input);
  if (!m) return null;
  return { db: m[1], rest: m[2] };
}

/** DB 輸入框的值：合法回原字串（最多 18 位），不合法回 null（呼叫端不送出）。 */
export function normalizeRedisDbInput(raw: string): string | null {
  const s = raw.trim();
  return /^\d{1,18}$/.test(s) ? s : null;
}

/** 鍵樹自動重整間隔（毫秒）；0 = 關閉。只接受預設的幾檔，避免打到過小值把 Redis 掃爆。 */
export function normalizeAutoRefreshMs(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return [0, 5000, 15000, 30000].includes(n) ? n : 0;
}

export const redisExpandedKey = (connId: string, db?: string) => `dbkit:redisExpanded:${connId}:${db ?? ""}`;

/** 讀回展開的資料夾路徑（壞資料當空）。 */
/**
 * 後端把非 UTF-8 鍵名顯示成 `\xHH`；字面反斜線會被跳脫成 `\\`。
 * 所以 `\xHH` 前面有偶數個連續反斜線時才是真的二進位轉義——這種鍵名拿去當
 * 一般字串操作會打到不存在的鍵，介面要當成「僅供檢視」。
 */
export function hasBinaryKeyEscape(name: string): boolean {
  for (let i = 0; i < name.length - 3; i++) {
    if (name[i] !== "\\") continue;
    const x = name[i + 1];
    if (x !== "x" && x !== "X") continue;
    if (!/[0-9a-fA-F]{2}/.test(name.slice(i + 2, i + 4))) continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && name[j] === "\\"; j--) slashes++;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

export function loadExpandedPaths(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}

export const REDIS_PATTERN_HISTORY_KEY = "dbkit:redisPatternHistory";
export const redisPatternHistoryKey = (connId: string, db?: string) => `${REDIS_PATTERN_HISTORY_KEY}:${connId}:${db ?? ""}`;

/** ARDM 的 search history：記住最近用過的 MATCH 樣式，最新的排最前，最多 20 條；`*` 不記。 */
export function recordRedisPattern(history: readonly string[], pattern: string): string[] {
  const p = pattern.trim();
  if (!p || p === "*") return [...history];
  return [p, ...history.filter((h) => h !== p)].slice(0, 20);
}

/**
 * 以載入時的 TTL 與已過秒數算剩餘 TTL，最低 0；-1（永不過期）維持 -1。
 */
export function remainingTtl(base: number, elapsedSecs: number): number {
  if (!Number.isFinite(base) || base < 0) return -1;
  return Math.max(0, base - Math.max(0, Math.floor(elapsedSecs)));
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
