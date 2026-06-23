// 純函式工具：查詢歷史 / 收藏 / 結果序列化 / SQL 多語句切分 / 跨資料庫識別字跳脫。
// 抽離自 App.tsx / TableView.tsx 以便單元測試（見 sql.test.ts）且不依賴 React / Tauri。
import type { DbKind, QueryResult } from "./api";

// ---- 跨資料庫識別字 / 字面值跳脫（MySQL / PostgreSQL / SQLite 一致性關鍵）----
// 識別字：PostgreSQL 用雙引號，其餘（MySQL / SQLite）用反引號；內部引號加倍轉義。
export function quoteIdent(kind: DbKind, id: string): string {
  return kind === "postgres" ? `"${id.replace(/"/g, '""')}"` : `\`${id.replace(/`/g, "``")}\``;
}
// 限定名：SQLite 不加 schema / db 前綴；MySQL / PostgreSQL 為 db.table（PG 之 db 即 schema）。
export function qualifiedName(kind: DbKind, db: string, table: string): string {
  return kind === "sqlite" ? quoteIdent(kind, table) : `${quoteIdent(kind, db)}.${quoteIdent(kind, table)}`;
}
// SQL 字串字面值：NULL → NULL，其餘以單引號包裹並轉義內部單引號。
// MySQL 預設把反斜線當字串轉義字元，故需加倍（否則含 \ 的值會被誤解，如 \b = 退格）；
// PostgreSQL（standard_conforming_strings）與 SQLite 視 \ 為字面字元，不可加倍（否則多出反斜線）。
export function sqlLiteral(kind: DbKind, v: string | null): string {
  if (v === null) return "NULL";
  const escaped =
    kind === "mysql" ? v.replace(/\\/g, "\\\\").replace(/'/g, "''") : v.replace(/'/g, "''");
  return `'${escaped}'`;
}

// ---- 設計表結構（table designer）：由欄位定義組出 CREATE TABLE ----
export interface NewColumn {
  name: string;
  type: string; // 例：VARCHAR(50) / INT / TIMESTAMP / SERIAL
  notNull: boolean;
  pk: boolean;
  unique: boolean;
  default: string; // 空字串 = 無預設
}

// 組 CREATE TABLE。識別字以 quoteIdent 跳脫（防注入）；型別 / 預設值為原樣插值（DDL 無法參數化，
// 由使用者對自己的資料庫負責，與 ALTER TABLE ADD COLUMN 一致）。PK 以表級 PRIMARY KEY(...) 表示，
// 支援複合主鍵；UNIQUE 以欄級約束。空欄位（無名稱）會被略過。
export function buildCreateTable(
  kind: DbKind,
  db: string,
  table: string,
  columns: NewColumn[],
): string {
  const qi = (id: string) => quoteIdent(kind, id);
  const cols = columns.filter((c) => c.name.trim() && c.type.trim());
  const lines: string[] = [];
  for (const c of cols) {
    let def = `${qi(c.name.trim())} ${c.type.trim()}`;
    if (c.notNull) def += " NOT NULL";
    if (c.unique && !c.pk) def += " UNIQUE";
    if (c.default.trim()) def += ` DEFAULT ${c.default.trim()}`;
    lines.push(def);
  }
  const pks = cols.filter((c) => c.pk).map((c) => qi(c.name.trim()));
  if (pks.length) lines.push(`PRIMARY KEY (${pks.join(", ")})`);
  return `CREATE TABLE ${qualifiedName(kind, db, table.trim())} (\n  ${lines.join(",\n  ")}\n);`;
}

// ---- 資料表生命週期 DDL（drop / truncate / rename / drop database）----

export function buildDropTable(kind: DbKind, db: string, table: string): string {
  return `DROP TABLE ${qualifiedName(kind, db, table)};`;
}

// 視圖以 DROP VIEW 刪除（DROP TABLE 對 view 在三種 SQL 皆報錯）。
export function buildDropView(kind: DbKind, db: string, table: string): string {
  return `DROP VIEW ${qualifiedName(kind, db, table)};`;
}

// 系統資料庫 / schema：前端據此隱藏刪除項，後端亦硬性拒絕（雙重防護）。public 不算系統（可刻意刪重建）。
// PG 的 pg_ 前綴比對須大小寫敏感，與後端 starts_with("pg_") 一致；否則引號保留大小寫的使用者 schema
// （如 "PG_data"）會被前端誤判為系統而隱藏刪除（後端其實允許）→ 過度封鎖。
export function isSystemDatabase(kind: DbKind, name: string): boolean {
  if (kind === "postgres") return name.startsWith("pg_") || name.toLowerCase() === "information_schema";
  const n = name.toLowerCase();
  if (kind === "mysql") return ["information_schema", "mysql", "performance_schema", "sys"].includes(n);
  if (kind === "mongo") return ["admin", "config", "local"].includes(n);
  return false;
}

// 清空：SQLite 無 TRUNCATE，改用 DELETE FROM（仍清空全表）。
export function buildTruncateTable(kind: DbKind, db: string, table: string): string {
  const q = qualifiedName(kind, db, table);
  return kind === "sqlite" ? `DELETE FROM ${q};` : `TRUNCATE TABLE ${q};`;
}

// 重新命名：MySQL 用 RENAME TABLE（新名同 schema 限定）；PG / SQLite 用 ALTER TABLE … RENAME TO。
// （刪除資料庫 / schema 走後端 drop_database，與 create_database 對稱，故此處不再組 SQL。）
export function buildRenameTable(kind: DbKind, db: string, oldName: string, newName: string): string {
  if (kind === "mysql") {
    return `RENAME TABLE ${qualifiedName(kind, db, oldName)} TO ${qualifiedName(kind, db, newName)};`;
  }
  return `ALTER TABLE ${qualifiedName(kind, db, oldName)} RENAME TO ${quoteIdent(kind, newName)};`;
}

// 複製資料表結構（送往查詢編輯器供檢視後執行）。MySQL：CREATE TABLE … LIKE；PG：LIKE … INCLUDING ALL；
// SQLite 無 LIKE，退化為 CREATE TABLE … AS SELECT … WHERE 0（僅複製欄位，不含 PK / 約束 / 索引）。
export function buildDuplicateTable(kind: DbKind, db: string, src: string, dst: string): string {
  const from = qualifiedName(kind, db, src);
  const to = qualifiedName(kind, db, dst);
  if (kind === "mysql") return `CREATE TABLE ${to} LIKE ${from};`;
  if (kind === "postgres") return `CREATE TABLE ${to} (LIKE ${from} INCLUDING ALL);`;
  // SQLite：AS SELECT 僅複製欄位定義（不含主鍵 / 約束 / 索引），請依需要自行補上。
  return `CREATE TABLE ${to} AS SELECT * FROM ${from} WHERE 0;`;
}

// 建立視圖：CREATE VIEW <qualified> AS <select>（三種 SQL 同語法）。
export function buildCreateView(kind: DbKind, db: string, name: string, select: string): string {
  return `CREATE VIEW ${qualifiedName(kind, db, name.trim())} AS\n${select.trim()};`;
}

// 刪除外鍵：MySQL → DROP FOREIGN KEY；PostgreSQL → DROP CONSTRAINT。
export function buildDropForeignKey(kind: DbKind, db: string, table: string, name: string): string {
  const clause = kind === "mysql" ? "DROP FOREIGN KEY" : "DROP CONSTRAINT";
  return `ALTER TABLE ${qualifiedName(kind, db, table)} ${clause} ${quoteIdent(kind, name)};`;
}

// 新增外鍵：ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY(col) REFERENCES refTable(refCol)（MySQL / PG 同語法）。
export function buildAddForeignKey(
  kind: DbKind,
  db: string,
  table: string,
  name: string,
  column: string,
  refTable: string,
  refColumn: string,
): string {
  const qi = (id: string) => quoteIdent(kind, id);
  return (
    `ALTER TABLE ${qualifiedName(kind, db, table)} ADD CONSTRAINT ${qi(name.trim())} ` +
    `FOREIGN KEY (${qi(column.trim())}) REFERENCES ${qualifiedName(kind, db, refTable.trim())} (${qi(refColumn.trim())});`
  );
}

// 由某列產生 UPDATE / DELETE 範本（送往編輯器供檢視）。表名以 quoteIdent（與 copyRowInsert 一致，不限定 db），
// 值以 sqlLiteral 跨方言跳脫。WHERE 用主鍵定位（呼叫端確保有主鍵）。
export function buildRowUpdate(
  kind: DbKind,
  table: string,
  columns: string[],
  values: (string | null)[],
  pkCols: string[],
  pkVals: (string | null)[],
): string {
  const qi = (id: string) => quoteIdent(kind, id);
  const sets = columns.map((c, i) => `${qi(c)} = ${sqlLiteral(kind, values[i])}`).join(", ");
  const where = pkCols.map((c, i) => `${qi(c)} = ${sqlLiteral(kind, pkVals[i])}`).join(" AND ");
  return `UPDATE ${qi(table)} SET ${sets} WHERE ${where};`;
}

export function buildRowDelete(
  kind: DbKind,
  table: string,
  pkCols: string[],
  pkVals: (string | null)[],
): string {
  const qi = (id: string) => quoteIdent(kind, id);
  const where = pkCols.map((c, i) => `${qi(c)} = ${sqlLiteral(kind, pkVals[i])}`).join(" AND ");
  return `DELETE FROM ${qi(table)} WHERE ${where};`;
}

// ---- MySQL 使用者管理：'user'@'host' 為兩段字串字面值（非反引號識別字）----
// 帳號規格 'user'@'host'：MySQL 以字串字面值表示帳號與來源主機，皆需單引號跳脫（防注入）。
export function mysqlAccount(name: string, host: string): string {
  return `${sqlLiteral("mysql", name)}@${sqlLiteral("mysql", host)}`;
}
// 建立使用者；password 為空字串時不設密碼（CREATE USER 不接 IDENTIFIED BY ''，故省略子句）。
export function buildCreateUser(name: string, host: string, password: string): string {
  const base = `CREATE USER ${mysqlAccount(name, host)}`;
  return password ? `${base} IDENTIFIED BY ${sqlLiteral("mysql", password)}` : base;
}
// 刪除使用者。
export function buildDropUser(name: string, host: string): string {
  return `DROP USER ${mysqlAccount(name, host)}`;
}
// 修改密碼（ALTER USER ... IDENTIFIED BY）。
export function buildAlterUserPassword(name: string, host: string, password: string): string {
  return `ALTER USER ${mysqlAccount(name, host)} IDENTIFIED BY ${sqlLiteral("mysql", password)}`;
}
// 鎖定 / 解鎖帳號（MySQL 5.7.6+）。
export function buildSetUserLock(name: string, host: string, locked: boolean): string {
  return `ALTER USER ${mysqlAccount(name, host)} ACCOUNT ${locked ? "LOCK" : "UNLOCK"}`;
}
// 查詢帳號清單（含資源限制 / SSL / 超級權限）；對標 Navicat 使用者檢視欄位。
export function userListSql(): string {
  return (
    "SELECT User, Host, " +
    "IF(ssl_type='', '無', ssl_type) AS ssl_type, " +
    "max_questions, max_updates, max_connections, max_user_connections, " +
    "Super_priv, account_locked " +
    "FROM mysql.user ORDER BY User, Host"
  );
}
// 查詢單一帳號的授權（SHOW GRANTS）。
export function showGrantsSql(name: string, host: string): string {
  return `SHOW GRANTS FOR ${mysqlAccount(name, host)}`;
}

// 保守 SQL 格式化：把語句切成「程式碼」與「逐字保留片段」（字串 '...'、識別字 "..."/`...`、
// 行 / 區塊註解、PG $$），只對程式碼片段重排空白並於主要子句前換行。因僅變動字面值外的空白，
// 不改變語意（SQL 對字面值外的空白不敏感），最差只是排版不美而非破壞查詢。不改關鍵字大小寫。
export function formatSql(sql: string): string {
  const segs: { code: boolean; v: string }[] = [];
  let code = "";
  let i = 0;
  const n = sql.length;
  const flush = () => { if (code) { segs.push({ code: true, v: code }); code = ""; } };
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (ch === "'" || ch === '"' || ch === "`") {
      flush();
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } j++; break; }
        j++;
      }
      segs.push({ code: false, v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (two === "--") { flush(); let j = i; while (j < n && sql[j] !== "\n") j++; segs.push({ code: false, v: sql.slice(i, j) }); i = j; continue; }
    if (two === "/*") { flush(); let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "*/") j++; j = Math.min(n, j + 2); segs.push({ code: false, v: sql.slice(i, j) }); i = j; continue; }
    if (two === "$$") { flush(); let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "$$") j++; j = Math.min(n, j + 2); segs.push({ code: false, v: sql.slice(i, j) }); i = j; continue; }
    code += ch;
    i++;
  }
  flush();

  // 多字關鍵字（group by / left join…）整體比對，避免二次換行。
  const CLAUSE = /\s*\b(select|from|where|group\s+by|order\s+by|having|limit|offset|union\s+all|union|values|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join|join|set)\b/gi;
  const out = segs
    .map((s) => {
      if (!s.code) return s.v;
      let c = s.v.replace(/\s+/g, " ");
      c = c.replace(CLAUSE, (_m, kw: string) => "\n" + kw.replace(/\s+/g, " "));
      c = c.replace(/\s+\b(and|or|on)\b/gi, (_m, kw: string) => "\n  " + kw);
      return c;
    })
    .join("");
  return out.replace(/[ \t]+\n/g, "\n").replace(/^\s+/, "").trim();
}

// ---- 查詢歷史（localStorage，最近在前，去重，上限 50）----
export const QUERY_HISTORY_KEY = "at-kit:queryHistory";
const QUERY_HISTORY_CAP = 50;

export function loadQueryHistory(): string[] {
  try {
    const raw = localStorage.getItem(QUERY_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushQueryHistory(prev: string[], q: string): string[] {
  const trimmed = q.trim();
  if (!trimmed) return prev;
  const next = [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, QUERY_HISTORY_CAP);
  try {
    localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 忽略寫入失敗 */
  }
  return next;
}

// ---- 收藏查詢（具名，localStorage）----
export const SAVED_QUERIES_KEY = "at-kit:savedQueries";
export interface SavedQuery {
  name: string;
  sql: string;
}
export function loadSavedQueries(): SavedQuery[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SAVED_QUERIES_KEY) || "[]");
    return Array.isArray(arr)
      ? arr.filter((x) => x && typeof x.name === "string" && typeof x.sql === "string")
      : [];
  } catch {
    return [];
  }
}
export function persistSavedQueries(list: SavedQuery[]) {
  try {
    localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(list));
  } catch {
    /* 忽略寫入失敗 */
  }
}

// ---- 結果序列化（複製 / 匯出）----
export function resultToTsv(r: QueryResult): string {
  const head = r.columns.join("\t");
  const body = r.rows.map((row) => row.map((c) => c ?? "").join("\t")).join("\n");
  return body ? `${head}\n${body}` : head;
}
export function resultToJson(r: QueryResult): string {
  return JSON.stringify(
    r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i] ?? null]))),
    null,
    2
  );
}
// RFC4180 風格 CSV：含逗號 / 引號 / 換行的欄位以雙引號包裹並轉義。
export function resultToCsv(r: QueryResult): string {
  const esc = (v: string | null) => {
    const s = v ?? "";
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = r.columns.map(esc).join(",");
  const body = r.rows.map((row) => row.map(esc).join(",")).join("\n");
  return body ? `${head}\n${body}` : head;
}
// Markdown 表格（貼到 GitHub / 文件 / 聊天友善）：| 分隔，跳脫內含 | 與換行。
export function resultToMarkdown(r: QueryResult): string {
  if (r.columns.length === 0) return "";
  const esc = (v: string | null) => (v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const header = `| ${r.columns.map(esc).join(" | ")} |`;
  const sep = `| ${r.columns.map(() => "---").join(" | ")} |`;
  const rows = r.rows.map((row) => `| ${row.map(esc).join(" | ")} |`);
  return [header, sep, ...rows].join("\n");
}
// 把字串 / 識別字 / 註解 / $$ 區塊以空白取代，留下「程式碼」供關鍵字判斷（避免字面值內的字誤判）。
function stripCode(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) { if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } j++; break; } j++; }
      out += " "; i = j; continue;
    }
    if (two === "--") { let j = i; while (j < n && sql[j] !== "\n") j++; out += " "; i = j; continue; }
    if (two === "/*") { let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "*/") j++; out += " "; i = Math.min(n, j + 2); continue; }
    if (two === "$$") { let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "$$") j++; out += " "; i = Math.min(n, j + 2); continue; }
    out += ch; i++;
  }
  return out;
}

// 危險語句偵測（防手滑）：無 WHERE 的 UPDATE / DELETE，或 TRUNCATE。在字面值 / 註解外判斷關鍵字。
export function isDangerousStatement(sql: string): boolean {
  const code = stripCode(sql).toLowerCase().trim();
  if (/^truncate\b/.test(code)) return true;
  if (/^(update|delete)\b/.test(code) && !/\bwhere\b/.test(code)) return true;
  return false;
}

export function fmtElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// 以分號切分多條 SQL，但略過字串字面量（' " `）、註解（-- 行、/* */ 區塊）
// 與 PostgreSQL dollar-quoting（$$ … $$ / $tag$ … $tag$，函式 / DO 區塊本體常含分號）內的分號。
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inS = false, inD = false, inBack = false, lineC = false, blockC = false;
  let dollar: string | null = null; // 作用中的 $tag$ 結束標記
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (dollar) {
      // dollar-quote 內：原樣複製，遇到相同結束標記才離開。
      if (ch === "$" && sql.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length - 1;
        dollar = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (lineC) { cur += ch; if (ch === "\n") lineC = false; continue; }
    if (blockC) { cur += ch; if (ch === "*" && nx === "/") { cur += nx; i++; blockC = false; } continue; }
    if (inS) { cur += ch; if (ch === "'") { if (nx === "'") { cur += nx; i++; } else inS = false; } continue; }
    if (inD) { cur += ch; if (ch === '"') { if (nx === '"') { cur += nx; i++; } else inD = false; } continue; }
    if (inBack) { cur += ch; if (ch === "`") inBack = false; continue; }
    if (ch === "-" && nx === "-") { lineC = true; cur += ch; continue; }
    if (ch === "/" && nx === "*") { blockC = true; cur += ch + nx; i++; continue; }
    if (ch === "'") { inS = true; cur += ch; continue; }
    if (ch === '"') { inD = true; cur += ch; continue; }
    if (ch === "`") { inBack = true; cur += ch; continue; }
    if (ch === "$") {
      // PostgreSQL dollar-quote 開頭標記 $$ 或 $tag$（$1 之類參數不符，會落到一般字元）。
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) { dollar = m[0]; cur += dollar; i += dollar.length - 1; continue; }
    }
    if (ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
