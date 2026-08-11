// 結構快取的純函式層：把後端落地的快照轉成 CodeMirror 的 SQLNamespace、判斷是否過期、
// 決定哪些資料庫種類值得快取。無 React、無 Tauri，故可完整單元測試（vitest 為 node 環境）。
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { CachedSchema, ConnectionConfig, DbKind, TableColumns } from "./api";
import { isProdConn } from "./api";

/**
 * 有「結構」概念、值得做自動完成與快取的資料庫種類。
 *
 * 刻意只有這六種，不是十一種：
 * - Mongo 的「欄位」是抽樣既有文件推導出來的，那是資料不是結構，會隨每次寫入變動。
 * - Redis 的 list_tables 回的是 SCAN 出來的鍵名前綴——同樣是資料，且驅動端本來就有
 *   60 秒的行程內快照，落地反而是退步。
 * - Kafka / Elasticsearch / RabbitMQ 是主題 / 索引 / 佇列，沒有欄位層級的結構可補全。
 *
 * 把它們一起做進來，只會得到一份塞滿過期鍵名前綴的快取——比沒有快取更糟。
 */
export const SCHEMA_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite", "oracle", "external"];

export function shouldCacheKind(kind: DbKind | undefined): boolean {
  return !!kind && SCHEMA_KINDS.includes(kind);
}

/** 超過這個天數就在 UI 標成「已過期」（僅提示，不自動重抓）。 */
export const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 快取是否該被視為過期。
 * updated_at_ms 為 0 / 負數 / 未來時間一律當成過期——寧可提醒使用者按一下重新整理，
 * 也不要拿一份來歷不明的結構假裝新鮮。
 */
export function isStale(updatedAtMs: number, now = Date.now(), days = STALE_DAYS): boolean {
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return true;
  const age = now - updatedAtMs;
  return age < 0 || age > days * DAY_MS;
}

/**
 * 這個連線可不可以把結構寫到磁碟。
 * 正式環境（options.prod）預設不寫，除非該連線明確開啟 options.schema_cache = "on"。
 * 後端同樣會再擋一次——這裡只是避免白跑一趟查詢，真正的保證在後端。
 */
export function schemaCacheAllowed(config: ConnectionConfig | undefined): boolean {
  if (!config) return false;
  if (!isProdConn(config)) return true;
  return config.options?.schema_cache === "on";
}

/**
 * 把快照轉成 CodeMirror lang-sql 的 SQLNamespace（表名 → 欄名清單）。
 *
 * 沒有欄位的表仍要放進去（值為空陣列），否則 FROM / JOIN 後就補不到那張表——
 * 「表名補得到、欄名還沒載好」是本功能刻意保留的中間狀態。
 */
export function toSqlNamespace(tables: TableColumns[] | undefined): SQLNamespace {
  const ns: Record<string, string[]> = {};
  for (const t of tables ?? []) {
    if (!t || typeof t.table !== "string" || !t.table) continue;
    ns[t.table] = Array.isArray(t.columns) ? t.columns.filter((c) => typeof c === "string") : [];
  }
  return ns as SQLNamespace;
}

/** 一個資料庫的表結構（多庫 namespace 的輸入單位）。 */
export interface DbTables {
  database: string;
  tables: TableColumns[];
}

/**
 * 多庫版 namespace：目前庫的表放頂層（裸名），其餘各庫各掛一層巢狀。
 *
 * ```
 * { orders: [...], users: [...],          // 目前庫 → 裸名（行為與單庫時完全相同）
 *   other_db: { customers: [...] } }      // 額外庫 → 只以 other_db.customers 出現
 * ```
 *
 * 額外庫的表**刻意不進裸名池**：`FROM ` 一按就湧出十個庫的表，比沒有提示更糟。
 * 巢狀形態是 @codemirror/lang-sql 原生支援的，所以 `other_db.` → 表名、
 * `other_db.customers.` → 欄名、乃至 `FROM other_db.customers c` 之後的 `c.`（內建
 * source 自己解析別名）全都不必我們動手。
 *
 * 庫名與目前庫的**表名**撞名時，表名優先——打字時參照裸表名遠比參照別的庫常見，
 * 而被讓開的庫仍可用完整限定名執行，只是少了提示。
 */
export function toMultiDbSqlNamespace(
  primary: TableColumns[] | undefined,
  others: DbTables[] | undefined,
): SQLNamespace {
  const ns = toSqlNamespace(primary) as Record<string, unknown>;
  for (const o of others ?? []) {
    if (!o || typeof o.database !== "string" || !o.database) continue;
    // lang-sql 把鍵名裡未跳脫的 `.` 當成層級分隔；庫名含點時跳脫，才不會被拆成兩層。
    const key = o.database.replace(/\./g, "\\.");
    if (Object.prototype.hasOwnProperty.call(ns, key)) continue; // 撞名 → 表名優先
    ns[key] = toSqlNamespace(o.tables);
  }
  return ns as SQLNamespace;
}

/**
 * 把後端回來的東西整成可信的 CachedSchema，或 null。
 *
 * 快取檔可能被手改、可能是舊版格式、可能寫到一半斷電。這一層負責讓「壞掉的快取」
 * 退化成「沒有快取」，而不是讓整個自動完成炸掉。
 */
export function sanitizeCachedSchema(raw: unknown): CachedSchema | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<CachedSchema>;
  if (typeof o.database !== "string") return null;
  const tables: TableColumns[] = Array.isArray(o.tables)
    ? o.tables
        .filter((t): t is TableColumns => !!t && typeof (t as TableColumns).table === "string")
        .map((t) => ({
          table: t.table,
          columns: Array.isArray(t.columns) ? t.columns.filter((c) => typeof c === "string") : [],
        }))
    : [];
  const at = typeof o.updated_at_ms === "number" && Number.isFinite(o.updated_at_ms) ? o.updated_at_ms : 0;
  return { database: o.database, updated_at_ms: at, tables };
}

/**
 * 用新快照取代舊的——但**空的不覆蓋非空的**。
 *
 * 權限不足、連線剛斷、查到一半逾時，這些常常表現為「成功回傳 0 張表」。照單全收就會把
 * 使用者本來好用的提示清成空白，那比留著舊資料糟得多。後端 merge_database 有同一條規則。
 */
export function mergeCachedSchema(prev: CachedSchema | null, next: CachedSchema | null): CachedSchema | null {
  if (!next) return prev;
  if (next.tables.length === 0 && prev && prev.tables.length > 0) return prev;
  return next;
}

/**
 * 兩份表清單內容是否相同（順序敏感）。
 *
 * 背景重抓通常抓回一模一樣的東西。若照樣換上新物件，CodeMirror 的擴充套件會整組重建，
 * 而重建要把整個 namespace 走一遍——五千張表就是使用者打字打到一半卡一下。
 * 內容沒變就沿用舊物件，那一下就不會發生。長度先擋掉絕大多數情況，故實務上是 O(1)。
 */
export function sameTables(a: TableColumns[] | undefined, b: TableColumns[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].table !== b[i].table) return false;
    const ca = a[i].columns;
    const cb = b[i].columns;
    if (ca.length !== cb.length) return false;
    for (let j = 0; j < ca.length; j += 1) if (ca[j] !== cb[j]) return false;
  }
  return true;
}

/** 統計摘要用：把位元組數變成人看得懂的字串。 */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
