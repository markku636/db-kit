// 純函式工具：查詢歷史 / 收藏 / 結果序列化 / SQL 多語句切分 / 跨資料庫識別字跳脫。
// 抽離自 App.tsx / TableView.tsx 以便單元測試（見 sql.test.ts）且不依賴 React / Tauri。
import type { DbKind, QueryResult, RoutineInfo } from "./api";

// MariaDB 為 MySQL fork，SQL 方言一致：所有 SQL 生成共用 mysql 分支。
// 集中成一個 predicate，避免每個 builder 各自比對兩個字串（漏改即產出錯誤方言）。
export const isMysqlFamily = (kind: DbKind | null | undefined): boolean =>
  kind === "mysql" || kind === "mariadb";

// ---- 跨資料庫識別字 / 字面值跳脫（MySQL / PostgreSQL / SQLite 一致性關鍵）----
// 識別字：PostgreSQL 用雙引號，SQL Server 用 [方括號]（] 加倍），其餘（MySQL / MariaDB / SQLite）用反引號；內部引號加倍轉義。
export function quoteIdent(kind: DbKind, id: string): string {
  if (kind === "postgres" || kind === "oracle") return `"${id.replace(/"/g, '""')}"`;
  if (kind === "mssql") return `[${id.replace(/]/g, "]]")}]`;
  return `\`${id.replace(/`/g, "``")}\``;
}
// 限定名：SQLite 不加 schema / db 前綴；SQL Server 為三部式 [db].[schema].[table]（table 可能內嵌 schema.）；
// MySQL / PostgreSQL 為 db.table（PG 之 db 即 schema）。
export function qualifiedName(kind: DbKind, db: string, table: string): string {
  if (kind === "sqlite") return quoteIdent(kind, table);
  if (kind === "mssql") {
    const dot = table.indexOf(".");
    const schema = dot >= 0 ? table.slice(0, dot) : "dbo";
    const tbl = dot >= 0 ? table.slice(dot + 1) : table;
    return `${quoteIdent(kind, db)}.${quoteIdent(kind, schema)}.${quoteIdent(kind, tbl)}`;
  }
  return `${quoteIdent(kind, db)}.${quoteIdent(kind, table)}`;
}
// SQL 字串字面值：NULL → NULL，其餘以單引號包裹並轉義內部單引號。
// MySQL（與 external gateway，講 MySQL 方言）預設把反斜線當字串轉義字元，故需加倍——否則像 `a\`
// 這種以反斜線結尾的值會變成 `'a\'`，反斜線把結尾引號轉義掉而衝出字串字面值（資料錯誤甚至注入）；
// PostgreSQL（standard_conforming_strings）與 SQLite 視 \ 為字面字元，不可加倍（否則多出反斜線）。
export function sqlLiteral(kind: DbKind, v: string | null): string {
  if (v === null) return "NULL";
  // SQL Server：Unicode 字面值加 N 前綴、只加倍單引號（反斜線非 T-SQL 轉義字元）。
  if (kind === "mssql") return `N'${v.replace(/'/g, "''")}'`;
  const mysqlLike = isMysqlFamily(kind) || kind === "external";
  const escaped = mysqlLike ? v.replace(/\\/g, "\\\\").replace(/'/g, "''") : v.replace(/'/g, "''");
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
  // MariaDB 與 MySQL 同組（JSON 在 MariaDB 為 LONGTEXT 別名，語法仍可用）。
  mariadb: ["INT AUTO_INCREMENT", "INT", "BIGINT", "DECIMAL(10,2)", "TEXT", "VARCHAR(255)", "TINYINT(1)", "DATE", "DATETIME", "TIMESTAMP", "JSON"],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"],
  mssql: ["INT IDENTITY(1,1)", "INT", "BIGINT", "DECIMAL(18,2)", "NVARCHAR(255)", "NVARCHAR(MAX)", "VARCHAR(255)", "BIT", "DATE", "DATETIME2", "DATETIMEOFFSET", "UNIQUEIDENTIFIER", "MONEY"],
  oracle: ["NUMBER GENERATED AS IDENTITY", "NUMBER", "NUMBER(10)", "NUMBER(10,2)", "VARCHAR2(255)", "NVARCHAR2(255)", "CLOB", "CHAR(1)", "DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "RAW(16)", "BLOB"],
  // 非 SQL（mongo / redis）不會用到型別下拉，但需滿足 Record<DbKind> 完整性。
  mongo: [],
  redis: [],
  external: [], // 外部 gateway 唯讀，不建表
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
  if (isMysqlFamily(kind)) return ["information_schema", "mysql", "performance_schema", "sys"].includes(n);
  if (kind === "mongo") return ["admin", "config", "local"].includes(n);
  if (kind === "mssql") return ["master", "model", "msdb", "tempdb"].includes(n);
  if (kind === "oracle") {
    // Oracle 維護的系統 schema（12c+ 後端已用 oracle_maintained 排除；此為 11g 降級時的前端保險）。
    return [
      "sys", "system", "outln", "xdb", "ctxsys", "mdsys", "ordsys", "orddata", "ordplugins",
      "olapsys", "dbsnmp", "appqossys", "wmsys", "lbacsys", "dvsys", "dvf", "gsmadmin_internal",
      "audsys", "ojvmsys", "anonymous", "ggsys", "dbsfwuser", "remote_scheduler_agent",
      "si_informtn_schema", "mddata", "dip", "xs$null", "sys$umf",
    ].includes(n);
  }
  return false;
}

// 「切換目前資料庫 / schema」語句：MySQL / 外部 gateway 用 USE；PostgreSQL 用 SET search_path；
// SQLite（單檔）/ Mongo / Redis 無此概念回 null。供查詢面板的「目前資料庫」選擇器與側欄「新增查詢」共用，
// 確保兩處「把後續查詢限定到某資料庫」的語法一致。識別字以 quoteIdent 跳脫（防注入）。
export function buildUseDatabase(kind: DbKind, db: string): string | null {
  if (!db) return null;
  if (isMysqlFamily(kind) || kind === "external") return `USE ${quoteIdent("mysql", db)}`;
  if (kind === "mssql") return `USE ${quoteIdent("mssql", db)}`;
  if (kind === "postgres") return `SET search_path TO ${quoteIdent("postgres", db)}`;
  return null;
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
  if (isMysqlFamily(kind)) {
    return `RENAME TABLE ${qualifiedName(kind, db, oldName)} TO ${qualifiedName(kind, db, newName)};`;
  }
  return `ALTER TABLE ${qualifiedName(kind, db, oldName)} RENAME TO ${quoteIdent(kind, newName)};`;
}

// 複製資料表結構（送往查詢編輯器供檢視後執行）。MySQL：CREATE TABLE … LIKE；PG：LIKE … INCLUDING ALL；
// SQLite 無 LIKE，退化為 CREATE TABLE … AS SELECT … WHERE 0（僅複製欄位，不含 PK / 約束 / 索引）。
export function buildDuplicateTable(kind: DbKind, db: string, src: string, dst: string): string {
  const from = qualifiedName(kind, db, src);
  const to = qualifiedName(kind, db, dst);
  if (isMysqlFamily(kind)) return `CREATE TABLE ${to} LIKE ${from};`;
  if (kind === "postgres") return `CREATE TABLE ${to} (LIKE ${from} INCLUDING ALL);`;
  // Oracle 無布林字面值，WHERE 0 非法 → 用 1 = 0。
  if (kind === "oracle") return `CREATE TABLE ${to} AS SELECT * FROM ${from} WHERE 1 = 0;`;
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
    if (kind === "postgres") return `SELECT * FROM ${q}(${a})`;
    // Oracle 23c 前 SELECT 必須有 FROM 子句。
    if (kind === "oracle") return `SELECT ${q}(${a}) AS result FROM DUAL`;
    return `SELECT ${q}(${a}) AS result`;
  }
  return `CALL ${q}(${a})`;
}

// 組 routine 的 DROP 語句（刪除 / 先刪後建用）。
// PG 函式 / 程序帶引數簽章以消除重載歧義（PG 對重載函式無簽章的 DROP 會報 "is not unique"）。
export function buildDropRoutine(kind: DbKind, db: string, r: RoutineInfo): string {
  const t = r.routine_type;
  if (isMysqlFamily(kind)) {
    const kw = t === "procedure" ? "PROCEDURE" : t === "function" ? "FUNCTION" : t === "event" ? "EVENT" : "TRIGGER";
    return `DROP ${kw} IF EXISTS ${qualifiedName(kind, db, r.name)}`;
  }
  if (kind === "postgres") {
    if (t === "trigger") return `DROP TRIGGER IF EXISTS ${quoteIdent(kind, r.name)} ON ${qualifiedName(kind, db, r.parent ?? "")}`;
    const sig = r.signature ?? "";
    return `DROP ${t === "procedure" ? "PROCEDURE" : "FUNCTION"} IF EXISTS ${qualifiedName(kind, db, r.name)}(${sig})`;
  }
  if (kind === "oracle") {
    // Oracle 無 IF EXISTS（23c 前）；觸發器不帶 schema 前綴表。
    const kw = t === "procedure" ? "PROCEDURE" : t === "function" ? "FUNCTION" : "TRIGGER";
    return `DROP ${kw} ${qualifiedName(kind, db, r.name)}`;
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
  const clause = isMysqlFamily(kind) ? "DROP FOREIGN KEY" : "DROP CONSTRAINT";
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

// 由某列主鍵產生「定位此列」的 SELECT（致敬 Navicat「Copy as SELECT」）：供精準重查 / 分享單列，
// 唯讀連線亦可用（不寫入）。WHERE 用主鍵定位（呼叫端確保有主鍵）。
export function buildRowSelect(
  kind: DbKind,
  table: string,
  pkCols: string[],
  pkVals: (string | null)[],
): string {
  const qi = (id: string) => quoteIdent(kind, id);
  const where = pkCols.map((c, i) => `${qi(c)} = ${sqlLiteral(kind, pkVals[i])}`).join(" AND ");
  return `SELECT * FROM ${qi(table)} WHERE ${where};`;
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

// ---- 視覺化查詢建構器（Visual Query Builder，致敬 Navicat 的 SQL Builder）----
// 由 QueryBuilder.tsx 的視覺狀態組出 SELECT 語句。純函式、跨方言（MySQL / PostgreSQL / SQLite），
// 識別字以 quoteIdent 跳脫、值以 sqlLiteral 跳脫（數字字面值原樣），可單元測試。
export type QbAgg = "" | "COUNT" | "COUNT_DISTINCT" | "SUM" | "AVG" | "MIN" | "MAX";
export type QbJoinType = "INNER" | "LEFT" | "RIGHT" | "FULL";
export type QbConj = "AND" | "OR";

export interface QbTable { name: string; alias?: string }
export interface QbColumn { table: string; column: string; agg?: QbAgg; alias?: string }
export interface QbJoin { type: QbJoinType; leftTable: string; leftCol: string; rightTable: string; rightCol: string }
// stringCol：此欄是否為「非數值型別」（字串 / 日期 / 布林…），是則值恆加引號（避免 `text = 5` 在 PG 型別錯）。
export interface QbCond { table: string; column: string; op: string; value?: string; conj?: QbConj; stringCol?: boolean }
// HAVING：以聚合（或欄位）為左運算元的群組後篩選。agg 空白＝直接以欄位比較。
export interface QbHaving { agg?: QbAgg; table: string; column: string; op: string; value?: string; conj?: QbConj; stringCol?: boolean }

// 由資料型別字串判斷是否「非數值」（供查詢建構器決定條件值是否加引號）。
// 第一個型別字（int / varchar / timestamp…）不在數值集合即視為字串型（恆加引號）。
const NUMERIC_TYPE_TOKENS = new Set([
  "int", "integer", "tinyint", "smallint", "mediumint", "bigint", "int2", "int4", "int8",
  "decimal", "numeric", "number", "dec", "float", "float4", "float8", "double", "real",
  "serial", "bigserial", "smallserial",
]);
export function isStringLikeType(dataType: string): boolean {
  const tok = (dataType.trim().toLowerCase().match(/^[a-z_]+/) || [""])[0];
  return !NUMERIC_TYPE_TOKENS.has(tok);
}
export interface QbOrder { table: string; column: string; dir: "ASC" | "DESC" }
export interface QbSpec {
  db: string;
  baseTable: string;
  tables: QbTable[];
  columns: QbColumn[];
  joins: QbJoin[];
  conds: QbCond[];
  havings?: QbHaving[];
  orders: QbOrder[];
  distinct?: boolean;
  limit?: number | null;
  offset?: number | null;
}

// 聚合表達式：agg 空白回傳欄位參照本身，否則包上聚合函式。
function qbAggExpr(agg: QbAgg | undefined, ref: string): string {
  switch (agg) {
    case "COUNT": return `COUNT(${ref})`;
    case "COUNT_DISTINCT": return `COUNT(DISTINCT ${ref})`;
    case "SUM": return `SUM(${ref})`;
    case "AVG": return `AVG(${ref})`;
    case "MIN": return `MIN(${ref})`;
    case "MAX": return `MAX(${ref})`;
    default: return ref;
  }
}

// 是否為純數字字面值（整數 / 小數 / 負號）——是則 WHERE / IN 不加引號（當數值比較）。
function isNumericLiteral(v: string): boolean {
  const t = v.trim();
  // 嚴格十進位，且以 Number 最短往返一致才當數字——排除前導零（007）、尾隨零小數（1.50）、
  // 超精度大整數等「看似數字實為字串」者，避免 zero-padded 代碼被當數值而比錯 / PG 型別錯。
  return /^-?\d+(\.\d+)?$/.test(t) && String(Number(t)) === t;
}

// 單一條件值 → SQL 片段（數字原樣、其餘字串字面值）。
function qbValueSql(kind: DbKind, v: string): string {
  const t = v.trim();
  return isNumericLiteral(t) ? t : sqlLiteral(kind, t);
}

// 依運算子決定條件值寫法：LIKE 系列恆為字串字面值（即使值看似數字——LIKE 需字串樣式，
// 否則 PostgreSQL 會型別錯）；其餘走 qbValueSql（數字原樣 / 字串字面值）。
function qbOperandValue(kind: DbKind, op: string, v: string, stringCol?: boolean): string {
  const u = op.trim().toUpperCase();
  if (stringCol || u === "LIKE" || u === "NOT LIKE" || u === "ILIKE" || u === "NOT ILIKE") return sqlLiteral(kind, v.trim());
  return qbValueSql(kind, v);
}

/**
 * 由視覺建構規格組出 SELECT 語句（單行，呼叫端可再以 formatSql 美化）。
 * - 多表時欄位以「表別名/表名.欄名」限定，避免歧義。
 * - 有聚合欄位時，自動以其餘未聚合的顯示欄位 GROUP BY（Navicat 風）。
 * - WHERE 由左至右以各條件自身的 AND/OR 串接（首條的連接詞忽略）。
 * 回傳空字串表規格不完整（無基底表）。
 */
export function buildSelectQuery(kind: DbKind, spec: QbSpec): string {
  if (!spec.baseTable) return "";
  const qi = (id: string) => quoteIdent(kind, id);
  // 表名 → 參照（有別名用別名，否則用表名本身）。
  const refOf = (table: string) => {
    const t = spec.tables.find((x) => x.name === table);
    return t?.alias?.trim() ? t.alias.trim() : table;
  };
  const qcol = (table: string, column: string) => `${qi(refOf(table))}.${qi(column)}`;
  const multi = spec.tables.length > 1;
  // 欄位參照：單表時可省略表前綴，多表時必加（避免歧義）。
  const colRef = (table: string, column: string) => (multi ? qcol(table, column) : qi(column));

  // SELECT 清單
  const selectExprs: string[] = [];
  for (const c of spec.columns) {
    let expr = qbAggExpr(c.agg, colRef(c.table, c.column));
    if (c.alias?.trim()) expr += ` AS ${qi(c.alias.trim())}`;
    selectExprs.push(expr);
  }
  const selectList = selectExprs.length ? selectExprs.join(", ") : "*";

  // FROM（基底表）+ JOIN
  const fromOf = (table: string) => {
    const t = spec.tables.find((x) => x.name === table);
    const base = qualifiedName(kind, spec.db, table);
    return t?.alias?.trim() ? `${base} AS ${qi(t.alias.trim())}` : base;
  };
  let body = `FROM ${fromOf(spec.baseTable)}`;
  const inFrom = new Set<string>([spec.baseTable]);
  for (const j of spec.joins) {
    if (!j.leftTable || !j.leftCol || !j.rightTable || !j.rightCol) continue;
    body += ` ${j.type} JOIN ${fromOf(j.rightTable)} ON ${qcol(j.leftTable, j.leftCol)} = ${qcol(j.rightTable, j.rightCol)}`;
    inFrom.add(j.rightTable);
  }
  // 已選但未被 JOIN 連上的表，以 CROSS JOIN 併入 FROM——否則其欄位會引用未在 FROM 的表而產生無效 SQL。
  for (const t of spec.tables) {
    if (!inFrom.has(t.name)) {
      body += ` CROSS JOIN ${fromOf(t.name)}`;
      inFrom.add(t.name);
    }
  }

  // WHERE
  const valid = spec.conds.filter((c) => c.table && c.column && c.op);
  if (valid.length) {
    const parts: string[] = [];
    valid.forEach((c, i) => {
      const ref = colRef(c.table, c.column);
      const op = c.op.toUpperCase();
      let frag: string;
      if (op === "IS NULL" || op === "IS NOT NULL") {
        frag = `${ref} ${op}`;
      } else if (op === "IN" || op === "NOT IN") {
        const items = (c.value ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => (c.stringCol ? sqlLiteral(kind, s) : qbValueSql(kind, s)));
        frag = `${ref} ${op} (${items.join(", ")})`;
      } else {
        frag = `${ref} ${op} ${qbOperandValue(kind, op, c.value ?? "", c.stringCol)}`;
      }
      parts.push(i === 0 ? frag : `${c.conj ?? "AND"} ${frag}`);
    });
    body += ` WHERE ${parts.join(" ")}`;
  }

  // GROUP BY（有聚合時，以未聚合的顯示欄位分組）
  const hasAgg = spec.columns.some((c) => c.agg);
  if (hasAgg) {
    const grp = spec.columns.filter((c) => !c.agg).map((c) => colRef(c.table, c.column));
    if (grp.length) body += ` GROUP BY ${grp.join(", ")}`;
  }

  // HAVING（群組後篩選；左運算元為聚合表達式或欄位）
  const havings = (spec.havings ?? []).filter((h) => h.table && h.column && h.op);
  if (havings.length) {
    const parts: string[] = [];
    havings.forEach((h, i) => {
      const expr = qbAggExpr(h.agg, colRef(h.table, h.column));
      const op = h.op.toUpperCase();
      const frag =
        op === "IS NULL" || op === "IS NOT NULL"
          ? `${expr} ${op}`
          // 有聚合（COUNT/SUM…）時左運算元為數值，值用數字原樣；無聚合（純欄位）則依 stringCol。
          : `${expr} ${op} ${qbOperandValue(kind, op, h.value ?? "", h.agg ? false : h.stringCol)}`;
      parts.push(i === 0 ? frag : `${h.conj ?? "AND"} ${frag}`);
    });
    body += ` HAVING ${parts.join(" ")}`;
  }

  // ORDER BY
  const orders = spec.orders.filter((o) => o.table && o.column);
  if (orders.length) {
    body += ` ORDER BY ${orders.map((o) => `${colRef(o.table, o.column)} ${o.dir}`).join(", ")}`;
  }

  // LIMIT / OFFSET（三大關聯式方言皆支援 `LIMIT n OFFSET m`）
  if (spec.limit != null && spec.limit > 0) body += ` LIMIT ${Math.floor(spec.limit)}`;
  if (spec.offset != null && spec.offset > 0) body += ` OFFSET ${Math.floor(spec.offset)}`;

  return `SELECT ${spec.distinct ? "DISTINCT " : ""}${selectList} ${body};`;
}

// SQL 關鍵字（子句 / 運算子 / DML / DDL）。刻意不含型別名（date/text/timestamp…）與常見欄名，
// 避免把欄位 / 識別字誤改大小寫。供「關鍵字大寫 / 小寫」轉換。
const SQL_KEYWORDS = [
  "select", "from", "where", "and", "or", "not", "null", "is", "in", "like", "ilike", "between",
  "join", "inner", "left", "right", "full", "outer", "cross", "on", "using",
  "group", "by", "having", "order", "asc", "desc", "limit", "offset",
  "union", "intersect", "except", "all", "distinct", "as",
  "insert", "into", "values", "update", "set", "delete",
  "create", "table", "view", "index", "drop", "alter", "add", "column", "rename", "to",
  "primary", "key", "foreign", "references", "unique", "default", "constraint", "check", "cascade",
  "case", "when", "then", "else", "end", "exists", "any", "some",
  "with", "returning", "truncate", "replace", "if", "begin", "commit", "rollback",
  "grant", "revoke", "on", "use", "explain", "analyze",
];
const KW_RE = new RegExp(`\\b(${SQL_KEYWORDS.join("|")})\\b`, "gi");

// 內部：切出「程式碼 / 字串・註解」段（與 formatSql 同策略：保留字串 / 行 / 區塊註解 / $$ 內容不變）。
function sqlCodeSegments(sql: string): { code: boolean; v: string }[] {
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
      while (j < n) { if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } j++; break; } j++; }
      segs.push({ code: false, v: sql.slice(i, j) }); i = j; continue;
    }
    if (two === "--") { flush(); let j = i; while (j < n && sql[j] !== "\n") j++; segs.push({ code: false, v: sql.slice(i, j) }); i = j; continue; }
    if (two === "/*") { flush(); let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "*/") j++; j = Math.min(n, j + 2); segs.push({ code: false, v: sql.slice(i, j) }); i = j; continue; }
    if (two === "$$") { flush(); let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "$$") j++; j = Math.min(n, j + 2); segs.push({ code: false, v: sql.slice(i, j) }); i = j; continue; }
    code += ch; i++;
  }
  flush();
  return segs;
}

// 把 SQL 關鍵字統一轉大寫 / 小寫（字串 / 註解內不動，識別字 / 型別名不動）。
export function transformKeywordCase(sql: string, upper: boolean): string {
  return sqlCodeSegments(sql)
    .map((s) => (s.code ? s.v.replace(KW_RE, (m) => (upper ? m.toUpperCase() : m.toLowerCase())) : s.v))
    .join("");
}

// 由欄名 + 一組值組出 `col IN ('a', 'b', …)`（致敬 Navicat「Copy as IN」），供貼進 WHERE 過濾。
// 去重、方言感知跳脫；**一律字串字面值**——值來自欄位實際資料、型別未知，數值欄會把 '1' 隱式
// 轉型比較（MySQL / PostgreSQL / SQLite 皆然），文字欄則精確相符，避免 `text IN (1)` 在 PG 型別錯。
// NULL 以 `col IS NULL` 並聯（IN 不含 NULL）。
export function buildInClause(kind: DbKind, column: string, values: (string | null)[]): string {
  const col = quoteIdent(kind, column);
  const seen = new Set<string>();
  const items: string[] = [];
  let hasNull = false;
  for (const v of values) {
    if (v === null) { hasNull = true; continue; }
    if (seen.has(v)) continue;
    seen.add(v);
    items.push(sqlLiteral(kind, v));
  }
  const inPart = items.length ? `${col} IN (${items.join(", ")})` : "";
  if (hasNull) return inPart ? `(${inPart} OR ${col} IS NULL)` : `${col} IS NULL`;
  return inPart || `${col} IN (NULL)`; // 無值（理論上不會發生）→ 給合法但無相符的條件
}

// 壓縮 SQL 成單行：程式碼段內多重空白 / 換行收斂為單一空白；行註解移除（單行化會吃掉後續），
// 字串 / 區塊註解 / $$ 內容原樣保留。與 formatSql（展開換行）互補。
export function minifySql(sql: string): string {
  let out = "";
  for (const seg of sqlCodeSegments(sql)) {
    if (!seg.code) {
      // 行註解 → 收成單一空白（且不與既有結尾空白重複）；字串 / 區塊註解 / $$ 原樣保留。
      if (seg.v.startsWith("--")) { if (!out.endsWith(" ")) out += " "; }
      else out += seg.v;
      continue;
    }
    let v = seg.v.replace(/\s+/g, " ");
    if (out.endsWith(" ")) v = v.replace(/^ +/, ""); // 邊界去重（只動程式碼段，不碰字串內容）
    out += v;
  }
  return out.trim();
}

// 具名參數（`:name`）萃取 / 代入（致敬 Navicat 的參數化查詢）。在「程式碼」段才認，
// 字串 / 註解內的 `:name` 不算；PostgreSQL 型別轉換 `::type` 不誤判為參數。
const PARAM_RE = /:{1,2}([a-zA-Z_]\w*)/g;

// 取出 SQL 內所有具名參數（依出現順序、去重）。
export function extractNamedParams(sql: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const seg of sqlCodeSegments(sql)) {
    if (!seg.code) continue;
    PARAM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PARAM_RE.exec(seg.v))) {
      if (m[0].startsWith("::")) continue; // PG 型別轉換，非參數
      if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
    }
  }
  return names;
}

// 將 SQL 內的具名參數代入值（數字原樣、其餘字串字面值；方言感知）。未提供值的參數保持原樣。
export function substituteNamedParams(kind: DbKind, sql: string, values: Record<string, string>): string {
  return sqlCodeSegments(sql)
    .map((seg) => {
      if (!seg.code) return seg.v;
      return seg.v.replace(PARAM_RE, (full, name: string) => {
        if (full.startsWith("::") || !(name in values)) return full;
        const v = values[name];
        return isNumericLiteral(v) ? v.trim() : sqlLiteral(kind, v);
      });
    })
    .join("");
}

// 是否為「寫入 / DDL」語句（供唯讀連線攔截）。略過開頭的空白 / 行 / 區塊註解後，
// 檢查第一個關鍵字是否為會改動資料 / 結構者。SELECT / SHOW / EXPLAIN / WITH(…SELECT) 等視為唯讀。
export function isWriteStatement(sql: string): boolean {
  // 去掉開頭的空白與註解。
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("--")) { const nl = t.indexOf("\n"); s = nl === -1 ? "" : t.slice(nl + 1); continue; }
    if (t.startsWith("/*")) { const e = t.indexOf("*/"); s = e === -1 ? "" : t.slice(e + 2); continue; }
    s = t;
    break;
  }
  // PostgreSQL 可寫 CTE：`WITH x AS (DELETE/UPDATE/INSERT …) …` 起始為 WITH，第一關鍵字看不出寫入。
  // 唯讀守門寧可多擋：起始為 WITH 且含寫入字樣即視為寫入。
  if (/^with\b/i.test(s)) return /\b(insert|update|delete|merge)\b/i.test(s);
  return /^(insert|update|delete|replace|merge|upsert|create|alter|drop|truncate|rename|grant|revoke|comment|call|do|set|lock|begin|start|commit|rollback|savepoint|vacuum|reindex|cluster|copy|load|import)\b/i.test(s);
}

// 把建構的查詢包成 `SELECT COUNT(*) … FROM (<查詢>) _sub`，用以得知「這查詢會回多少列」。
// 計數時略去 LIMIT / OFFSET / ORDER BY（不影響列數、且部分方言子查詢不允許 ORDER 無 LIMIT）。
export function buildCountQuery(kind: DbKind, spec: QbSpec): string {
  const inner = buildSelectQuery(kind, { ...spec, limit: null, offset: null, orders: [] }).replace(/;\s*$/, "");
  if (!inner) return "";
  return `SELECT COUNT(*) AS total FROM (${inner}) AS _sub;`;
}

// ---- 查詢歷史（localStorage，最近在前，去重，上限 200）----
// v2：條目帶執行時間與連線名（顯示相對時間 / 標記來源）。舊格式（string[]）讀取時自動升級，
// at=0 於 UI 顯示為「較早」。
export const QUERY_HISTORY_KEY = "db-kit:queryHistory";
const QUERY_HISTORY_CAP = 200;

export interface QueryHistoryEntry {
  sql: string;
  /** epoch ms；0 = 舊格式遷移（時間不明） */
  at: number;
  /** 執行當下的連線名稱（顯示用；可能已改名 / 刪除） */
  connName?: string;
}

export function loadQueryHistory(): QueryHistoryEntry[] {
  try {
    const raw = localStorage.getItem(QUERY_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x): QueryHistoryEntry | null => {
        if (typeof x === "string") return { sql: x, at: 0 }; // 舊格式（string[]）遷移
        if (x && typeof x.sql === "string") {
          return {
            sql: x.sql,
            at: typeof x.at === "number" ? x.at : 0,
            connName: typeof x.connName === "string" ? x.connName : undefined,
          };
        }
        return null;
      })
      .filter((x): x is QueryHistoryEntry => x !== null);
  } catch {
    return [];
  }
}

export function pushQueryHistory(prev: QueryHistoryEntry[], q: string, connName?: string): QueryHistoryEntry[] {
  const trimmed = q.trim();
  if (!trimmed) return prev;
  const entry: QueryHistoryEntry = { sql: trimmed, at: Date.now(), connName };
  const next = [entry, ...prev.filter((x) => x.sql !== trimmed)].slice(0, QUERY_HISTORY_CAP);
  try {
    localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 忽略寫入失敗 */
  }
  return next;
}

/** 相對時間（歷史下拉顯示）：剛剛 / N 分鐘前 / N 小時前 / N 天前；at=0 顯示「較早」。 */
export function fmtRelativeTime(at: number, now = Date.now()): string {
  if (!at) return "較早";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "剛剛";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
}

// ---- 收藏查詢（具名，localStorage）----
export const SAVED_QUERIES_KEY = "db-kit:savedQueries";
export interface SavedQuery {
  name: string;        // 全域唯一鍵（沿用既有語意；重新命名時檢查衝突）
  sql: string;
  desc?: string;       // 說明 / 備註
  group?: string;      // 分組標籤；空 / undefined = 「未分組」
  createdAt?: number;  // 建立 epoch ms
  updatedAt?: number;  // 更新 epoch ms
}
// 讀取時過濾損壞項（name/sql 必為字串），並保留合法的選填欄位（型別不符則丟棄該欄，不丟整筆）。
export function loadSavedQueries(): SavedQuery[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SAVED_QUERIES_KEY) || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.name === "string" && typeof x.sql === "string")
      .map(sanitizeSavedQuery);
  } catch {
    return [];
  }
}
// 只保留合法欄位：desc/group 需為（非空）字串、createdAt/updatedAt 需為數字。
function sanitizeSavedQuery(x: { name: string; sql: string; desc?: unknown; group?: unknown; createdAt?: unknown; updatedAt?: unknown }): SavedQuery {
  const sq: SavedQuery = { name: x.name, sql: x.sql };
  if (typeof x.desc === "string") sq.desc = x.desc;
  if (typeof x.group === "string" && x.group.trim()) sq.group = x.group;
  if (typeof x.createdAt === "number") sq.createdAt = x.createdAt;
  if (typeof x.updatedAt === "number") sq.updatedAt = x.updatedAt;
  return sq;
}
export function persistSavedQueries(list: SavedQuery[]) {
  try {
    localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(list));
  } catch {
    /* 忽略寫入失敗 */
  }
}

// 純函式（對標 upsertSnippet / removeSnippet，可單測、不依賴 React / Tauri）：
// upsert：同名 → 原位覆蓋（保留原 createdAt）；新名 → prepend（維持 recency-first）。
export function upsertSavedQuery(list: SavedQuery[], sq: SavedQuery): SavedQuery[] {
  const idx = list.findIndex((x) => x.name === sq.name);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = { ...sq, createdAt: list[idx].createdAt ?? sq.createdAt };
    return next;
  }
  return [sq, ...list];
}
// 編輯（可含重新命名）：同名 → 原位覆蓋；改名 → 移除舊名後以新名 upsert（保留原 createdAt）。
// 若新名撞到另一筆既有收藏，upsert 會原位覆蓋該筆（呼叫端應先以 uiConfirm 取得同意）。
export function updateSavedQuery(list: SavedQuery[], oldName: string, sq: SavedQuery): SavedQuery[] {
  if (oldName === sq.name) return upsertSavedQuery(list, sq);
  const old = list.find((x) => x.name === oldName);
  const merged: SavedQuery = { ...sq, createdAt: old?.createdAt ?? sq.createdAt };
  return upsertSavedQuery(list.filter((x) => x.name !== oldName), merged);
}
export function removeSavedQuery(list: SavedQuery[], name: string): SavedQuery[] {
  return list.filter((x) => x.name !== name);
}
// 陣列搬移（同清單內 from → to；越界或相同則原樣回傳）。管理視窗上 / 下移用。
export function reorderSavedQueries(list: SavedQuery[], from: number, to: number): SavedQuery[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
// 導出去重、排序後的分組名清單（未分組不列入）。供 datalist 與側欄 / 管理視窗分組。
export function savedQueryGroups(list: SavedQuery[]): string[] {
  const set = new Set<string>();
  for (const q of list) if (q.group && q.group.trim()) set.add(q.group.trim());
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ---- SQL 片段庫（Snippets，致敬 Navicat 的程式碼片段）----
// 編輯器自動完成（輸入名稱即可展開）+ 工具列管理。內建常用片段，使用者可新增 / 覆蓋。
export const SNIPPETS_KEY = "db-kit:snippets";
export interface SqlSnippet {
  name: string; // 觸發名 / 顯示名（自動完成的 label）
  body: string; // 展開內容（純 SQL）
  desc?: string; // 說明（自動完成的 detail）
  builtin?: boolean; // 來自內建（UI 不提供刪除；可被同名使用者片段覆蓋）
}

// 內建片段：方言相容度高的常用骨架，`table_name` / `column_name` 等為佔位符，展開後自行替換。
export const BUILTIN_SNIPPETS: SqlSnippet[] = [
  { name: "sel100", body: "SELECT *\nFROM table_name\nLIMIT 100;", desc: "查詢前 100 筆" },
  { name: "count", body: "SELECT COUNT(*) AS n\nFROM table_name;", desc: "計數" },
  { name: "distinct", body: "SELECT DISTINCT column_name\nFROM table_name;", desc: "去重欄位值" },
  { name: "dups", body: "SELECT column_name, COUNT(*) AS n\nFROM table_name\nGROUP BY column_name\nHAVING COUNT(*) > 1\nORDER BY n DESC;", desc: "找重複值" },
  { name: "groupcount", body: "SELECT column_name, COUNT(*) AS n\nFROM table_name\nGROUP BY column_name\nORDER BY n DESC\nLIMIT 20;", desc: "分組計數 Top 20" },
  { name: "between", body: "SELECT *\nFROM table_name\nWHERE created_at BETWEEN '2024-01-01' AND '2024-12-31';", desc: "日期區間" },
  { name: "ins", body: "INSERT INTO table_name (col1, col2)\nVALUES (val1, val2);", desc: "插入列" },
  { name: "upd", body: "UPDATE table_name\nSET col1 = val1\nWHERE id = 0;", desc: "更新列" },
  { name: "del", body: "DELETE FROM table_name\nWHERE id = 0;", desc: "刪除列" },
  { name: "join", body: "SELECT a.*, b.*\nFROM table_a AS a\nJOIN table_b AS b ON a.id = b.a_id;", desc: "內連接" },
  { name: "leftjoin", body: "SELECT a.*, b.*\nFROM table_a AS a\nLEFT JOIN table_b AS b ON a.id = b.a_id;", desc: "左連接" },
  { name: "antijoin", body: "SELECT a.*\nFROM table_a AS a\nLEFT JOIN table_b AS b ON a.id = b.a_id\nWHERE b.a_id IS NULL;", desc: "反連接（找 a 中無對應 b 者）" },
  { name: "exists", body: "SELECT *\nFROM table_a AS a\nWHERE EXISTS (\n  SELECT 1 FROM table_b AS b WHERE b.a_id = a.id\n);", desc: "存在子查詢" },
  { name: "case", body: "SELECT\n  CASE\n    WHEN condition1 THEN 'A'\n    WHEN condition2 THEN 'B'\n    ELSE 'C'\n  END AS label\nFROM table_name;", desc: "CASE WHEN 條件分類" },
  { name: "paginate", body: "SELECT *\nFROM table_name\nORDER BY id\nLIMIT 50 OFFSET 0;", desc: "分頁（LIMIT/OFFSET）" },
];

// 純函式：合併使用者片段與內建（同名以使用者為準），依名稱排序。供單元測試。
export function mergeSnippets(user: SqlSnippet[]): SqlSnippet[] {
  const byName = new Map<string, SqlSnippet>();
  for (const s of BUILTIN_SNIPPETS) byName.set(s.name, { ...s, builtin: true });
  for (const s of user) {
    const name = s.name.trim();
    if (name) byName.set(name, { name, body: s.body, desc: s.desc, builtin: false });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSnippets(): SqlSnippet[] {
  let user: SqlSnippet[] = [];
  try {
    const arr = JSON.parse(localStorage.getItem(SNIPPETS_KEY) || "[]");
    if (Array.isArray(arr)) {
      user = arr.filter((x) => x && typeof x.name === "string" && typeof x.body === "string");
    }
  } catch {
    /* 忽略損毀的存檔 */
  }
  return mergeSnippets(user);
}

// 只持久化「與內建不同」的片段（使用者新增 / 覆蓋）；內建未改不存，避免污染。
export function persistSnippets(list: SqlSnippet[]) {
  const builtin = new Map(BUILTIN_SNIPPETS.map((s) => [s.name, s.body]));
  const user = list
    .filter((s) => builtin.get(s.name) !== s.body)
    .map((s) => ({ name: s.name, body: s.body, desc: s.desc }));
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(user));
  } catch {
    /* 忽略寫入失敗 */
  }
}

// 純函式：新增 / 覆蓋一個片段（同名覆蓋），名稱排序。
export function upsertSnippet(list: SqlSnippet[], snip: SqlSnippet): SqlSnippet[] {
  const others = list.filter((s) => s.name !== snip.name);
  return [...others, { ...snip, builtin: false }].sort((a, b) => a.name.localeCompare(b.name));
}

// 純函式：移除一個片段（依名稱）。
export function removeSnippet(list: SqlSnippet[], name: string): SqlSnippet[] {
  return list.filter((s) => s.name !== name);
}

// ---- SQL 資料庫（收藏查詢 + 片段）匯出 / 匯入 ----
// 純 JSON 信封（無機密，不加密，異於連線匯出的 AES 流程）；savedQueries 與 snippets 在檔內各自分開。
export const SQL_LIBRARY_KIND = "db-kit-sql-library";
export interface SqlLibraryBundle {
  version: number;    // 目前為 1
  kind: string;       // 固定 SQL_LIBRARY_KIND，匯入時辨識
  exportedAt: number; // epoch ms（由呼叫端帶入，保持純函式可測）
  savedQueries: SavedQuery[];
  snippets: { name: string; body: string; desc?: string }[]; // 僅使用者片段（不含 builtin）
}

// 建立匯出信封。snippets 傳入合併後清單，內部只挑「與 builtin 不同」者（同 persistSnippets 邏輯）。
export function buildSqlLibraryBundle(savedQueries: SavedQuery[], snippets: SqlSnippet[], exportedAt: number): SqlLibraryBundle {
  const builtin = new Map(BUILTIN_SNIPPETS.map((s) => [s.name, s.body]));
  const userSnippets = snippets
    .filter((s) => builtin.get(s.name) !== s.body)
    .map((s) => (s.desc ? { name: s.name, body: s.body, desc: s.desc } : { name: s.name, body: s.body }));
  return { version: 1, kind: SQL_LIBRARY_KIND, exportedAt, savedQueries, snippets: userSnippets };
}

// 解析匯入檔（容錯）：非 JSON / 結構全錯 → 丟出 Error（呼叫端顯示 toast）。
// 相容：亦接受「純 SavedQuery[] 陣列」（極早期或手工檔）。
export function parseSqlLibraryBundle(text: string): { savedQueries: SavedQuery[]; snippets: SqlSnippet[] } {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("檔案不是合法的 JSON");
  }
  const rawQueries = Array.isArray(data) ? data : data?.savedQueries;
  const rawSnippets = Array.isArray(data) ? [] : data?.snippets;
  if (!Array.isArray(rawQueries) && !Array.isArray(rawSnippets)) {
    throw new Error("檔案內容不是 db-kit SQL 庫格式");
  }
  const savedQueries: SavedQuery[] = Array.isArray(rawQueries)
    ? rawQueries.filter((x) => x && typeof x.name === "string" && typeof x.sql === "string").map(sanitizeSavedQuery)
    : [];
  const snippets: SqlSnippet[] = Array.isArray(rawSnippets)
    ? rawSnippets
        .filter((x) => x && typeof x.name === "string" && typeof x.body === "string")
        .map((x) => (typeof x.desc === "string" ? { name: x.name, body: x.body, desc: x.desc } : { name: x.name, body: x.body }))
    : [];
  return { savedQueries, snippets };
}

// 合併匯入的收藏查詢到既有清單。overwrite=true → 同名以匯入者覆蓋（保留原 createdAt）；false → 略過同名。
export function mergeSavedQueries(existing: SavedQuery[], incoming: SavedQuery[], overwrite: boolean): SavedQuery[] {
  const result = existing.slice();
  const indexByName = new Map(result.map((q, i) => [q.name, i]));
  for (const q of incoming) {
    const idx = indexByName.get(q.name);
    if (idx === undefined) {
      indexByName.set(q.name, result.length);
      result.push(q);
    } else if (overwrite) {
      result[idx] = { ...q, createdAt: result[idx].createdAt ?? q.createdAt };
    }
  }
  return result;
}

// 計算匯入時的同名衝突數（供 UI 提示「M 筆同名，是否覆蓋」）。
export function countSavedQueryConflicts(existing: SavedQuery[], incoming: SavedQuery[]): number {
  const names = new Set(existing.map((q) => q.name));
  return incoming.reduce((n, q) => (names.has(q.name) ? n + 1 : n), 0);
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

// 移除 SQL 註解（-- 行註解 / /* */ 區塊註解），但保留字串與識別字內容
//（其內部出現的 -- 與 /* 不是註解）。供 hasExecutableSql 判斷一段去掉註解後是否還剩內容。
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) { if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } j++; break; } j++; }
      out += sql.slice(i, j); i = j; continue;
    }
    if (two === "--") { let j = i; while (j < n && sql[j] !== "\n") j++; i = j; continue; }
    if (two === "/*") { let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "*/") j++; i = Math.min(n, j + 2); continue; }
    out += ch; i++;
  }
  return out;
}

// 一段 SQL 去掉註解 / 空白後是否仍有可執行內容。純註解 / 空白（如尾端的 `-- 註記`）若送往資料庫
// 會得到「Query was empty」之類語法錯誤，故多語句切分與「執行游標所在語句」皆據此略過這類片段。
export function hasExecutableSql(sql: string): boolean {
  return stripSqlComments(sql).trim().length > 0;
}

// 以分號切分多條 SQL，但略過字串字面量（' " `）、註解（-- 行、/* */ 區塊）
// 與 PostgreSQL dollar-quoting（$$ … $$ / $tag$ … $tag$，函式 / DO 區塊本體常含分號）內的分號。
// 純註解 / 空白片段（如尾端的 `-- 註記`）會被濾除——它們不是可執行語句，送 DB 會報空查詢錯誤。
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
  return out.filter(hasExecutableSql);
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
  // 略過純註解 / 空白片段（與 splitSqlStatements 一致），使「執行游標所在語句」落在真正可執行的語句上。
  return out.filter((s) => hasExecutableSql(s.text));
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

// 把框選矩形組成 Markdown 表格（含表頭列）。NULL → 空字串；`|` / 換行跳脫，供貼進文件 / PR。
export function rectToMarkdown(
  getCell: (r: number, c: number) => string | null,
  rows: number[],
  cols: number[],
  header: (c: number) => string,
): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = `| ${cols.map((c) => esc(header(c))).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => esc(getCell(r, c) ?? "")).join(" | ")} |`).join("\n");
  return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
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
