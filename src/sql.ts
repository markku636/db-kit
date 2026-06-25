// 純函式工具：查詢歷史 / 收藏 / 結果序列化 / SQL 多語句切分 / 跨資料庫識別字跳脫。
// 抽離自 App.tsx / TableView.tsx 以便單元測試（見 sql.test.ts）且不依賴 React / Tauri。
import type { DbKind, QueryResult, RoutineInfo } from "./api";

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

// 常見型別快捷：供建表 / 新增欄位的型別下拉選單與 datalist 提示，選後仍可手動微調（如 VARCHAR 長度）。
// 由 CreateTableDialog 與 TableView（AddColumnForm）共用，集中於此避免重複。
export const TYPE_PRESETS: Record<DbKind, string[]> = {
  postgres: ["SERIAL", "BIGSERIAL", "INT", "BIGINT", "NUMERIC(10,2)", "TEXT", "VARCHAR(255)", "BOOLEAN", "DATE", "TIMESTAMPTZ", "UUID", "JSONB"],
  mysql: ["INT AUTO_INCREMENT", "INT", "BIGINT", "DECIMAL(10,2)", "TEXT", "VARCHAR(255)", "TINYINT(1)", "DATE", "DATETIME", "TIMESTAMP", "JSON"],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"],
  // 非 SQL（mongo / redis）不會用到型別下拉，但需滿足 Record<DbKind> 完整性。
  mongo: [],
  redis: [],
};

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

// 清空資料表（DELETE 全部列）：可復原（在交易內）、觸發 trigger、不重設自增。對標 Navicat「清空資料表」。
// 與 buildTruncateTable（TRUNCATE，快但不可復原 / 不觸發 trigger）區分；SQLite 兩者皆為 DELETE。
export function buildDeleteAllRows(kind: DbKind, db: string, table: string): string {
  return `DELETE FROM ${qualifiedName(kind, db, table)};`;
}

// 由欄位 / 列資料組出字面值 INSERT 語句（供「傾印 SQL（含資料）」/ 資料字典之外的匯出）。
// 識別字以 quoteIdent 跳脫、值以 sqlLiteral 跳脫，皆為方言感知（與後端 export sql 的 MySQL 固定方言不同，
// 此處可正確產生 PG / SQLite 的傾印）。columns 為欄名、rows 為對齊欄序的字串 / null 值。
export function buildInsertValues(
  kind: DbKind,
  db: string,
  table: string,
  columns: string[],
  rows: (string | null)[][],
): string {
  const qtbl = qualifiedName(kind, db, table);
  const collist = columns.map((c) => quoteIdent(kind, c)).join(", ");
  return rows
    .map((r) => `INSERT INTO ${qtbl} (${collist}) VALUES (${r.map((v) => sqlLiteral(kind, v)).join(", ")});`)
    .join("\n");
}

// 資料表權限 GRANT / REVOKE 範本（送往查詢編輯器供使用者填入帳號後執行）。對標 Navicat「設定權限」。
// 僅 MySQL / PostgreSQL（SQLite 無使用者 / 權限概念）。帳號以註解占位，由使用者替換為真實 user / role。
export function buildGrantTemplate(kind: DbKind, db: string, table: string): string {
  const q = qualifiedName(kind, db, table);
  if (kind === "postgres") {
    return [
      `-- 資料表權限範本（PostgreSQL）：請將 <role> 換成實際角色名後執行。`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO <role>;`,
      `-- 唯讀：GRANT SELECT ON ${q} TO <role>;`,
      `-- 全部權限：GRANT ALL PRIVILEGES ON ${q} TO <role>;`,
      `-- 收回：REVOKE ALL PRIVILEGES ON ${q} FROM <role>;`,
    ].join("\n");
  }
  // MySQL：帳號為 'user'@'host' 形式。
  return [
    `-- 資料表權限範本（MySQL）：請將 'user'@'host' 換成實際帳號後執行。`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO 'user'@'%';`,
    `-- 唯讀：GRANT SELECT ON ${q} TO 'user'@'%';`,
    `-- 全部權限：GRANT ALL PRIVILEGES ON ${q} TO 'user'@'%';`,
    `-- 收回：REVOKE ALL PRIVILEGES ON ${q} FROM 'user'@'%';`,
    `FLUSH PRIVILEGES;`,
  ].join("\n");
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

// 將來源表全部資料插入目標表（複製含資料時，接在 buildDuplicateTable 之後）。
export function buildInsertAllRows(kind: DbKind, db: string, src: string, dst: string): string {
  return `INSERT INTO ${qualifiedName(kind, db, dst)} SELECT * FROM ${qualifiedName(kind, db, src)};`;
}

// 建立視圖：CREATE VIEW <qualified> AS <select>（三種 SQL 同語法）。
export function buildCreateView(kind: DbKind, db: string, name: string, select: string): string {
  return `CREATE VIEW ${qualifiedName(kind, db, name.trim())} AS\n${select.trim()};`;
}

// 取得既有視圖的 SELECT 定義（供「設計檢視」載入）。MySQL 走 information_schema.VIEWS（僅含 SELECT，
// 無 CREATE 前綴，免解析）；PostgreSQL 走 pg_get_viewdef。db / 名稱以字面值跳脫（防注入）。
export function viewDefinitionSql(kind: DbKind, db: string, view: string): string {
  if (kind === "postgres") {
    const ref = `${quoteIdent("postgres", db)}.${quoteIdent("postgres", view)}`;
    return `SELECT pg_get_viewdef(${sqlLiteral("postgres", ref)}::regclass, true) AS def`;
  }
  return `SELECT VIEW_DEFINITION AS def FROM information_schema.VIEWS ` +
    `WHERE TABLE_SCHEMA = ${sqlLiteral("mysql", db)} AND TABLE_NAME = ${sqlLiteral("mysql", view)}`;
}

// 以 CREATE OR REPLACE VIEW 改寫視圖定義（MySQL / PostgreSQL 皆支援）。
export function buildReplaceView(kind: DbKind, db: string, name: string, select: string): string {
  return `CREATE OR REPLACE VIEW ${qualifiedName(kind, db, name.trim())} AS\n${select.trim()};`;
}

// 取得資料表選項（MySQL）：引擎 / 註解 / AUTO_INCREMENT / 定序，供 TableProperties 編輯前回填。
export function tableOptionsSql(db: string, table: string): string {
  return "SELECT ENGINE, TABLE_COMMENT, AUTO_INCREMENT, TABLE_COLLATION FROM information_schema.TABLES " +
    `WHERE TABLE_SCHEMA = ${sqlLiteral("mysql", db)} AND TABLE_NAME = ${sqlLiteral("mysql", table)}`;
}
// 轉換資料表字元集 / 定序（CONVERT TO，會重寫所有文字欄位）。charset / collation 為關鍵字（呼叫端以白名單 /
// SHOW COLLATION 結果確保安全）；collation 留空則用該字元集預設。
export function buildConvertCharset(db: string, table: string, charset: string, collation: string): string {
  const coll = collation.trim() ? ` COLLATE ${collation.trim()}` : "";
  return `ALTER TABLE ${qualifiedName("mysql", db, table)} CONVERT TO CHARACTER SET ${charset}${coll}`;
}
// 取得資料庫預設字元集 / 定序（MySQL），供資料庫屬性回填。
export function databaseOptionsSql(db: string): string {
  return "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA " +
    `WHERE SCHEMA_NAME = ${sqlLiteral("mysql", db)}`;
}
// 變更資料庫預設字元集 / 定序（ALTER DATABASE；僅影響日後新表，不轉換既有資料）。
export function buildAlterDatabaseCharset(db: string, charset: string, collation: string): string {
  const coll = collation.trim() ? ` COLLATE ${collation.trim()}` : "";
  return `ALTER DATABASE ${quoteIdent("mysql", db)} CHARACTER SET ${charset}${coll}`;
}
// ---- 結構比對（schema compare）：純函式 diff，供單元測試 ----
// 以「來源」為基準比對名稱清單：onlyInSource = 來源有目標無（需在目標建立）；onlyInTarget 反之；common = 兩邊皆有。
export interface NameDiff { onlyInSource: string[]; onlyInTarget: string[]; common: string[] }
export function diffNameLists(source: string[], target: string[]): NameDiff {
  const s = new Set(source), t = new Set(target);
  return {
    onlyInSource: [...new Set(source)].filter((n) => !t.has(n)).sort(),
    onlyInTarget: [...new Set(target)].filter((n) => !s.has(n)).sort(),
    common: [...new Set(source)].filter((n) => t.has(n)).sort(),
  };
}
// 欄位比對：以來源為基準。added = 來源有目標無；removed = 目標有來源無；changed = 兩邊同名但型別 / 可空不同。
export interface SchemaColumn { name: string; data_type: string; nullable: boolean }
export interface ColumnDiff {
  added: string[];
  removed: string[];
  changed: { name: string; source: string; target: string }[];
}
// 產生「目標補欄位」的 ALTER ADD COLUMN（同步用；僅型別 + 可空，不含預設 / 註解，由使用者檢視後補上）。
export function buildAddColumnsDdl(kind: DbKind, db: string, table: string, cols: SchemaColumn[]): string {
  return cols
    .map((c) => `ALTER TABLE ${qualifiedName(kind, db, table)} ADD COLUMN ${quoteIdent(kind, c.name)} ${c.data_type}${c.nullable ? "" : " NOT NULL"};`)
    .join("\n");
}
// 產生型別 / 可空變更的同步 DDL（依來源欄位）。MySQL：MODIFY COLUMN；PostgreSQL：ALTER COLUMN TYPE + SET/DROP NOT NULL。
// 不保留預設 / 註解（MySQL MODIFY 特性），由使用者檢視後補上。
export function buildModifyColumnsDdl(kind: DbKind, db: string, table: string, cols: SchemaColumn[]): string {
  const q = qualifiedName(kind, db, table);
  return cols.map((c) => {
    const id = quoteIdent(kind, c.name);
    if (kind === "postgres") {
      const nn = c.nullable ? "DROP NOT NULL" : "SET NOT NULL";
      return `ALTER TABLE ${q} ALTER COLUMN ${id} TYPE ${c.data_type} USING ${id}::${c.data_type}, ALTER COLUMN ${id} ${nn};`;
    }
    return `ALTER TABLE ${q} MODIFY COLUMN ${id} ${c.data_type}${c.nullable ? "" : " NOT NULL"};`;
  }).join("\n");
}
export function diffColumns(source: SchemaColumn[], target: SchemaColumn[]): ColumnDiff {
  const tByName = new Map(target.map((c) => [c.name, c]));
  const sByName = new Map(source.map((c) => [c.name, c]));
  const fmt = (c: SchemaColumn) => `${c.data_type}${c.nullable ? " NULL" : " NOT NULL"}`;
  const added = source.filter((c) => !tByName.has(c.name)).map((c) => c.name).sort();
  const removed = target.filter((c) => !sByName.has(c.name)).map((c) => c.name).sort();
  const changed: ColumnDiff["changed"] = [];
  for (const c of source) {
    const o = tByName.get(c.name);
    if (o && fmt(c) !== fmt(o)) changed.push({ name: c.name, source: fmt(c), target: fmt(o) });
  }
  changed.sort((a, b) => a.name.localeCompare(b.name));
  return { added, removed, changed };
}

// 資料庫內各表大小報表（MySQL）：依資料 + 索引大小由大到小，協助找出佔空間的表。
export function tableSizesSql(db: string): string {
  return (
    "SELECT TABLE_NAME AS table_name, TABLE_ROWS AS rows_est, " +
    "ROUND(DATA_LENGTH/1024/1024, 2) AS data_mb, ROUND(INDEX_LENGTH/1024/1024, 2) AS index_mb, " +
    "ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024, 2) AS total_mb, ENGINE AS engine " +
    `FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${sqlLiteral("mysql", db)} AND TABLE_TYPE = 'BASE TABLE' ` +
    "ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC"
  );
}
// 變更資料表選項（MySQL）：依有變動的欄位組合單一 ALTER TABLE。engine 為關鍵字（呼叫端以白名單下拉確保安全）；
// comment 為字面值跳脫；autoIncrement 取整數插值。無任何變動回 null。
export function buildAlterTableOptions(
  db: string,
  table: string,
  opts: { engine?: string; comment?: string; autoIncrement?: number },
): string | null {
  const parts: string[] = [];
  if (opts.engine) parts.push(`ENGINE = ${opts.engine}`);
  if (opts.comment !== undefined) parts.push(`COMMENT = ${sqlLiteral("mysql", opts.comment)}`);
  if (opts.autoIncrement !== undefined && Number.isFinite(opts.autoIncrement))
    parts.push(`AUTO_INCREMENT = ${Math.floor(opts.autoIncrement)}`);
  if (parts.length === 0) return null;
  return `ALTER TABLE ${qualifiedName("mysql", db, table)} ${parts.join(", ")}`;
}

// 資料表維護（MySQL）：ANALYZE / CHECK / OPTIMIZE / REPAIR TABLE，皆回傳狀態結果集。
export type TableMaintenanceOp = "ANALYZE" | "CHECK" | "OPTIMIZE" | "REPAIR";
export function buildTableMaintenance(op: TableMaintenanceOp, db: string, table: string): string {
  return `${op} TABLE ${qualifiedName("mysql", db, table)}`;
}

// 呼叫 routine（執行函式 / 預存程序）：函式以 SELECT、程序以 CALL。
// 引數為使用者輸入的原樣字串（自行加引號 / 型別，如 42, 'abc'），不再跳脫（呼叫端負責），與 DDL 一致。
export function buildRoutineCall(kind: DbKind, db: string, name: string, routineType: string, args: string): string {
  const q = qualifiedName(kind, db, name);
  const a = args.trim();
  if (routineType === "function") {
    return kind === "postgres" ? `SELECT * FROM ${q}(${a})` : `SELECT ${q}(${a}) AS result`;
  }
  return `CALL ${q}(${a})`;
}

// 組 routine 的 DROP 語句（刪除 / 先刪後建用）。
// PG 函式 / 程序帶引數簽章以消除重載歧義（PG 對重載函式無簽章的 DROP 會報 "is not unique"）。
export function buildDropRoutine(kind: DbKind, db: string, r: RoutineInfo): string {
  const t = r.routine_type;
  if (kind === "mysql") {
    const kw = t === "procedure" ? "PROCEDURE" : t === "function" ? "FUNCTION" : t === "event" ? "EVENT" : "TRIGGER";
    return `DROP ${kw} IF EXISTS ${qualifiedName(kind, db, r.name)}`;
  }
  if (kind === "postgres") {
    if (t === "trigger") return `DROP TRIGGER IF EXISTS ${quoteIdent(kind, r.name)} ON ${qualifiedName(kind, db, r.parent ?? "")}`;
    const sig = r.signature ?? "";
    return `DROP ${t === "procedure" ? "PROCEDURE" : "FUNCTION"} IF EXISTS ${qualifiedName(kind, db, r.name)}(${sig})`;
  }
  return `DROP TRIGGER IF EXISTS ${quoteIdent(kind, r.name)}`;
}

// 重新命名索引：MySQL → ALTER TABLE … RENAME INDEX；PostgreSQL → ALTER INDEX（索引為 schema 物件）。
// SQLite 無 ALTER INDEX RENAME，呼叫端僅對 MySQL / PG 顯示。
export function buildRenameIndex(kind: DbKind, db: string, table: string, oldName: string, newName: string): string {
  if (kind === "postgres") {
    return `ALTER INDEX ${qualifiedName(kind, db, oldName)} RENAME TO ${quoteIdent(kind, newName.trim())};`;
  }
  return `ALTER TABLE ${qualifiedName(kind, db, table)} RENAME INDEX ${quoteIdent(kind, oldName)} TO ${quoteIdent(kind, newName.trim())};`;
}

// 建立全文索引（MySQL；用於 MATCH … AGAINST 文字搜尋）。一般 / 唯一索引仍走後端 create_index。
export function buildCreateFulltextIndex(db: string, table: string, name: string, columns: string[]): string {
  const cols = columns.map((c) => quoteIdent("mysql", c)).join(", ");
  return `CREATE FULLTEXT INDEX ${quoteIdent("mysql", name.trim())} ON ${qualifiedName("mysql", db, table)} (${cols})`;
}

// 刪除外鍵：MySQL → DROP FOREIGN KEY；PostgreSQL → DROP CONSTRAINT。
export function buildDropForeignKey(kind: DbKind, db: string, table: string, name: string): string {
  const clause = kind === "mysql" ? "DROP FOREIGN KEY" : "DROP CONSTRAINT";
  return `ALTER TABLE ${qualifiedName(kind, db, table)} ${clause} ${quoteIdent(kind, name)};`;
}

// 新增外鍵：ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY(col) REFERENCES refTable(refCol)（MySQL / PG 同語法）。
// onDelete / onUpdate 為參照動作（NO ACTION / CASCADE / SET NULL / RESTRICT / SET DEFAULT），留空則不輸出該子句。
// 動作為關鍵字（呼叫端以下拉白名單確保安全），原樣插值。
export function buildAddForeignKey(
  kind: DbKind,
  db: string,
  table: string,
  name: string,
  column: string,
  refTable: string,
  refColumn: string,
  onDelete = "",
  onUpdate = "",
): string {
  const qi = (id: string) => quoteIdent(kind, id);
  const od = onDelete.trim() ? ` ON DELETE ${onDelete.trim()}` : "";
  const ou = onUpdate.trim() ? ` ON UPDATE ${onUpdate.trim()}` : "";
  return (
    `ALTER TABLE ${qualifiedName(kind, db, table)} ADD CONSTRAINT ${qi(name.trim())} ` +
    `FOREIGN KEY (${qi(column.trim())}) REFERENCES ${qualifiedName(kind, db, refTable.trim())} (${qi(refColumn.trim())})${od}${ou};`
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
// 設定帳號 SSL 需求（ALTER USER … REQUIRE {NONE|SSL|X509}）。mode 為白名單關鍵字。
export function buildAlterUserSsl(name: string, host: string, mode: string): string {
  return `ALTER USER ${mysqlAccount(name, host)} REQUIRE ${mode}`;
}
// 設定帳號資源限制（ALTER USER … WITH …，對標 Navicat 使用者每小時限制 / 最大連線；0 = 無限制）。
// 各值為非負整數（呼叫端以數字輸入確保安全），原樣插值。無任何項目回 null。
export function buildAlterUserLimits(
  name: string,
  host: string,
  limits: { queries?: number; updates?: number; connections?: number; userConnections?: number },
): string | null {
  const parts: string[] = [];
  if (limits.queries !== undefined) parts.push(`MAX_QUERIES_PER_HOUR ${Math.max(0, Math.floor(limits.queries))}`);
  if (limits.updates !== undefined) parts.push(`MAX_UPDATES_PER_HOUR ${Math.max(0, Math.floor(limits.updates))}`);
  if (limits.connections !== undefined) parts.push(`MAX_CONNECTIONS_PER_HOUR ${Math.max(0, Math.floor(limits.connections))}`);
  if (limits.userConnections !== undefined) parts.push(`MAX_USER_CONNECTIONS ${Math.max(0, Math.floor(limits.userConnections))}`);
  if (parts.length === 0) return null;
  return `ALTER USER ${mysqlAccount(name, host)} WITH ${parts.join(" ")}`;
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
// GRANT/REVOKE 範圍：無 db → 全域 *.*；有 db 無 table → `db`.*；有 db+table → `db`.`table`。
// 識別字以反引號跳脫（防注入）；權限關鍵字（SELECT 等）為原樣插值（非識別字，不可加引號）。
export function grantScope(db: string | null, table: string | null): string {
  if (!db) return "*.*";
  const dbq = quoteIdent("mysql", db);
  return table ? `${dbq}.${quoteIdent("mysql", table)}` : `${dbq}.*`;
}
// 授予權限：GRANT priv[, priv] ON scope TO 'user'@'host'（可選 WITH GRANT OPTION 轉授）。
export function buildGrant(privs: string[], scope: string, name: string, host: string, withGrantOption = false): string {
  const base = `GRANT ${privs.join(", ")} ON ${scope} TO ${mysqlAccount(name, host)}`;
  return withGrantOption ? `${base} WITH GRANT OPTION` : base;
}
// 撤銷權限：REVOKE priv[, priv] ON scope FROM 'user'@'host'。
export function buildRevoke(privs: string[], scope: string, name: string, host: string): string {
  return `REVOKE ${privs.join(", ")} ON ${scope} FROM ${mysqlAccount(name, host)}`;
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
// 移除所有成對括號內的內容（保留 depth-0 文字），供「危險語句」偵測排除子查詢。
// 例：UPDATE t SET a=(SELECT … WHERE …) 的 WHERE 在子查詢內，去括號後頂層才看得出沒有 WHERE。
function stripParens(s: string): string {
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out;
}

// Redis 破壞性指令：FLUSHALL（清空所有 DB）/ FLUSHDB（清空目前 DB），無法復原，需確認。
// 容許可選的 "N:" 資料庫前綴（查詢編輯器語法），如 "1: FLUSHDB"。
export function isDangerousRedisCommand(cmd: string): boolean {
  const c = cmd.replace(/^\s*\d+\s*:\s*/, "").trim();
  return /^(flushall|flushdb)\b/i.test(c);
}

export function isDangerousStatement(sql: string): boolean {
  const code = stripCode(sql).toLowerCase().trim();
  if (/^truncate\b/.test(code)) return true;
  // WHERE 只計頂層（去掉子查詢括號）——否則 UPDATE t SET a=(SELECT…WHERE…) 會被誤判為安全卻其實改全表。
  // 反向不會誤報：真正的頂層 WHERE 子句永遠不在括號內，去括號後仍在。
  if (/^(update|delete)\b/.test(code) && !/\bwhere\b/.test(stripParens(code))) return true;
  return false;
}

export function fmtElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// ---- 輕量結構檢查（SQL 編輯器即時 lint）----
// 只回報「在任何合法 SQL 都必為錯」的結構問題：未配對括號、未結束的字串 / 識別字 /
// 註解 / $$ 區塊。刻意不做關鍵字或語意判斷（那會在預存程序程序體 BEGIN…END /
// CASE…END / IF…END IF 上誤報），完整語法驗證交給後端 validate_ddl（資料庫引擎）。
// 位置以「字元位移」回報，與 CodeMirror 文件位移一致。
export interface SqlLintMark {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
}

export function lintSqlStructure(sql: string): SqlLintMark[] {
  const marks: SqlLintMark[] = [];
  const parens: number[] = []; // 未配對 '(' 的位置堆疊
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    // 字串（'）/ 識別字（" 或 `）：內部相同引號加倍視為轉義。
    if (ch === "'" || ch === '"' || ch === "`") {
      const start = i;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; } // 加倍轉義
          j++; closed = true; break;
        }
        j++;
      }
      if (!closed) {
        const label = ch === "'" ? "字串" : ch === '"' ? '識別字（"）' : "識別字（`）";
        marks.push({ from: start, to: n, severity: "error", message: `未結束的${label}` });
        return marks; // 之後無法可靠掃描，提前結束
      }
      i = j;
      continue;
    }
    if (two === "--") { let j = i; while (j < n && sql[j] !== "\n") j++; i = j; continue; }
    if (two === "/*") {
      const start = i;
      let j = i + 2;
      while (j < n && sql.slice(j, j + 2) !== "*/") j++;
      if (j >= n) { marks.push({ from: start, to: n, severity: "error", message: "未結束的區塊註解 /* */" }); return marks; }
      i = j + 2;
      continue;
    }
    // PostgreSQL dollar-quoting：$$ 或 $tag$（需有對應結束標記）。
    if (ch === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const start = i;
        let j = i + tag.length;
        let closed = false;
        while (j < n) { if (sql.startsWith(tag, j)) { j += tag.length; closed = true; break; } j++; }
        if (!closed) { marks.push({ from: start, to: n, severity: "error", message: `未結束的 ${tag} 區塊` }); return marks; }
        i = j;
        continue;
      }
    }
    if (ch === "(") { parens.push(i); i++; continue; }
    if (ch === ")") {
      if (parens.length === 0) marks.push({ from: i, to: i + 1, severity: "error", message: "多餘的右括號「)」" });
      else parens.pop();
      i++;
      continue;
    }
    i++;
  }
  for (const p of parens) marks.push({ from: p, to: p + 1, severity: "error", message: "未配對的左括號「(」" });
  return marks;
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

// 一條語句在原字串中的位移範圍（text 已去除前後空白）。
export interface SqlStatementSpan {
  text: string;
  from: number;
  to: number;
}

// 與 splitSqlStatements 同套字串 / 註解 / dollar-quote 規則，但保留每條語句在原字串中的位移，
// 供「執行游標所在語句」定位（DataGrip / DBeaver 的 Ctrl+Enter 行為）。
export function splitSqlStatementsWithRanges(sql: string): SqlStatementSpan[] {
  const out: SqlStatementSpan[] = [];
  let inS = false, inD = false, inBack = false, lineC = false, blockC = false;
  let dollar: string | null = null;
  let segStart = 0; // 目前語句（含前導空白）的起點
  const push = (end: number) => {
    // [segStart, end) 為一條語句（不含分號）；trim 兩端空白得到真正範圍。
    let a = segStart, b = end;
    while (a < b && /\s/.test(sql[a])) a++;
    while (b > a && /\s/.test(sql[b - 1])) b--;
    if (b > a) out.push({ text: sql.slice(a, b), from: a, to: b });
  };
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (dollar) {
      if (ch === "$" && sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = null; }
      continue;
    }
    if (lineC) { if (ch === "\n") lineC = false; continue; }
    if (blockC) { if (ch === "*" && nx === "/") { i++; blockC = false; } continue; }
    if (inS) { if (ch === "'") { if (nx === "'") i++; else inS = false; } continue; }
    if (inD) { if (ch === '"') { if (nx === '"') i++; else inD = false; } continue; }
    if (inBack) { if (ch === "`") inBack = false; continue; }
    if (ch === "-" && nx === "-") { lineC = true; continue; }
    if (ch === "/" && nx === "*") { blockC = true; i++; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === "`") { inBack = true; continue; }
    if (ch === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) { dollar = m[0]; i += dollar.length - 1; continue; }
    }
    if (ch === ";") { push(i); segStart = i + 1; continue; }
  }
  push(sql.length);
  return out;
}

// 計算框選範圍的統計（Excel 狀態列手感）：總格數、數值格數、加總 / 平均 / 最小 / 最大。
// 僅將可解析為有限數字的值納入數值統計（先移除千分位逗號）；空字串 / NULL 不計入數值。
export function rangeStats(values: (string | null)[]): {
  count: number;
  numCount: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
} {
  let numCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v === null || v.trim() === "") continue;
    const n = Number(v.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    numCount++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return {
    count: values.length,
    numCount,
    sum,
    avg: numCount ? sum / numCount : 0,
    min: numCount ? min : 0,
    max: numCount ? max : 0,
  };
}

// 將矩形範圍的儲存格擷取為 TSV（供資料表「區塊複製」）。getCell 取值（含待套用編輯），
// rows / cols 為要納入的列索引 / 欄索引清單（已依可見欄序排好）。純函式，便於單元測試。
export function rectToTsv(
  getCell: (r: number, c: number) => string | null,
  rows: number[],
  cols: number[],
): string {
  return rows.map((r) => cols.map((c) => getCell(r, c) ?? "").join("\t")).join("\n");
}

// 解析剪貼簿的表格文字（TSV / 多行）為二維字串陣列，供資料表「區塊貼上」。
// 去除尾端單一換行（避免多出一列空白）；單一純文字回傳 1×1。
export function parseClipboardGrid(text: string): string[][] {
  const t = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return t.split("\n").map((line) => line.split("\t"));
}

// 回傳游標位移所在的語句文字；游標落在語句之間的空白時取後一條。無可辨識語句回 null。
export function statementAtOffset(sql: string, offset: number): string | null {
  const spans = splitSqlStatementsWithRanges(sql);
  if (spans.length === 0) return null;
  for (const s of spans) {
    if (offset >= s.from && offset <= s.to) return s.text;
  }
  const after = spans.find((s) => s.from >= offset);
  return (after ?? spans[spans.length - 1]).text;
}
