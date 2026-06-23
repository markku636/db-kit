import { invoke } from "@tauri-apps/api/core";

export type DbKind = "mysql" | "postgres" | "mongo" | "redis" | "sqlite";

export type SshAuthMethod = "password" | "key";

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string | null;
  max_connections?: number;
  // SSH Tunnel（可選；SQLite 不適用）。密碼 / passphrase 存於 keychain，載入時為空字串。
  ssh_enabled?: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_username?: string;
  ssh_auth_method?: SshAuthMethod;
  ssh_password?: string;
  ssh_private_key_path?: string;
  ssh_passphrase?: string;
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  rows_affected: number;
}

export interface PoolStatus {
  size: number;
  idle: number;
  in_use: number;
}

export interface TableInfo {
  name: string;
  kind: string; // "table" | "view"
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  key: string;
  default: string | null;
  extra: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface RoutineInfo {
  name: string;
  routine_type: string; // "procedure" | "function" | "trigger"
  parent: string | null; // 觸發器所屬資料表
  signature: string | null; // PG 函式 / 程序引數型別簽章（重載消歧用）
}

export interface PagedData {
  columns: string[];
  rows: (string | null)[][];
  total_rows: number;
  page: number;
  page_size: number;
  primary_key: string[];
}

export interface CellEdit {
  column: string;
  new_value: string | null;
  pk_columns: string[];
  pk_values: (string | null)[];
}

export type SortDir = "asc" | "desc";

export interface Filter {
  column: string;
  op: string; // "=", "!=", ">", ">=", "<", "<=", "like", "is_null", "is_not_null"
  value?: string | null;
}

export interface Sort {
  column: string;
  dir: SortDir;
}

export interface DataQuery {
  page: number;
  page_size: number;
  filters: Filter[];
  sorts: Sort[];
  match_any?: boolean; // false = AND（預設）、true = OR
}

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown";

export interface ExportOptions {
  format: ExportFormat;
  include_header?: boolean;
  delimiter?: string | null;
  null_text?: string | null;
  sql_table?: string | null;
  all_rows?: boolean;
  bom?: boolean;
}

export interface ExportResult {
  path: string;
  rows: number;
  bytes: number;
  format: string;
}

export interface ImportOptions {
  delimiter?: string | null;
  has_header?: boolean;
  empty_as_null?: boolean;
  columns?: string[] | null;
  stop_on_error?: boolean;
}

export interface ImportResult {
  imported: number;
  failed: number;
  errors: string[];
}

export interface ColumnStats {
  total: number;
  non_null: number;
  distinct: number;
  min: string | null;
  max: string | null;
}

// DDL 結構編輯（與後端 serde tag="op" 對齊）
export type AlterOp =
  | { op: "add_column"; name: string; data_type: string; nullable: boolean; default?: string | null }
  | { op: "drop_column"; name: string }
  | { op: "rename_column"; old: string; new: string };

// ER 圖模型
export interface ErColumn { name: string; data_type: string; pk: boolean; fk: boolean }
export interface ErTable { name: string; columns: ErColumn[] }
export interface ErRelation { from_table: string; from_column: string; to_table: string; to_column: string }
export interface ErModel { tables: ErTable[]; relations: ErRelation[] }

export interface RowInsert {
  columns: string[];
  values: (string | null)[];
}

export interface RowDelete {
  pk_columns: string[];
  pk_values: (string | null)[];
}

export interface KeyDetail {
  key: string;
  type_: string;
  ttl: number;
  entries: string[];
  fields: string[];
  scores: number[];
}

// Redis 鍵結構編輯（與後端 serde tag="action" 對齊）
export type KeyEdit =
  | { action: "list_set"; index: number; value: string }
  | { action: "list_push"; value: string; front: boolean }
  | { action: "list_remove"; value: string; count: number }
  | { action: "set_add"; member: string }
  | { action: "set_remove"; member: string }
  | { action: "zset_add"; member: string; score: number }
  | { action: "zset_remove"; member: string }
  | { action: "hash_set"; field: string; value: string }
  | { action: "hash_remove"; field: string }
  | { action: "rename"; new_key: string };

// Redis 伺服器狀態（INFO 解析後的分區）；items 為 [欄位, 值] 二元陣列。
export interface ServerInfoSection {
  name: string;
  items: [string, string][];
}

export interface BackupResult {
  path: string;
  bytes: number;
  method: string;
}

export type Cadence =
  | { type: "every_minutes"; minutes: number }
  | { type: "every_hours"; hours: number }
  | { type: "daily_at"; hour: number; minute: number };

export type BackupStatus = "ok" | "failed";

export interface BackupSchedule {
  id: string;
  connection_id: string;
  database: string;
  target_dir: string;
  cadence: Cadence;
  enabled: boolean;
  last_run?: string | null;
  next_run?: string | null;
  retention_count?: number | null;
  created_at?: string | null;
}

export interface BackupHistoryEntry {
  id: string;
  schedule_id?: string | null;
  connection_id: string;
  connection_name: string;
  database: string;
  kind: DbKind;
  path: string;
  bytes: number;
  method: string;
  status: BackupStatus;
  error?: string | null;
  started_at: string;
  finished_at: string;
}

export interface AppError {
  kind: string;
  message: string;
}

// 連線類型的顯示資料（色標呼應規劃文件）
export const KIND_META: Record<DbKind, { label: string; color: string; defaultPort: number; fileBased?: boolean }> = {
  mysql: { label: "MySQL", color: "#3b82f6", defaultPort: 3306 },
  postgres: { label: "PostgreSQL", color: "#6366f1", defaultPort: 5432 },
  mongo: { label: "MongoDB", color: "#22c55e", defaultPort: 27017 },
  redis: { label: "Redis", color: "#ef4444", defaultPort: 6379 },
  sqlite: { label: "SQLite", color: "#f59e0b", defaultPort: 0, fileBased: true },
};

// 後端 command 包裝
export const api = {
  testConnection: (config: ConnectionConfig) =>
    invoke<void>("test_connection", { config }),
  connect: (config: ConnectionConfig) => invoke<void>("connect", { config }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  // 連線設定持久化（密碼存 keychain，磁碟不含密碼）
  listSavedConnections: () =>
    invoke<ConnectionConfig[]>("list_saved_connections"),
  saveConnection: (config: ConnectionConfig) =>
    invoke<void>("save_connection", { config }),
  removeSavedConnection: (id: string) =>
    invoke<void>("remove_saved_connection", { id }),
  listDatabases: (id: string) => invoke<string[]>("list_databases", { id }),
  listTables: (id: string, database: string) =>
    invoke<TableInfo[]>("list_tables", { id, database }),
  tableColumns: (id: string, database: string, table: string) =>
    invoke<ColumnInfo[]>("table_columns", { id, database, table }),
  tableData: (id: string, database: string, table: string, query: DataQuery) =>
    invoke<PagedData>("table_data", { id, database, table, query }),
  runQuery: (id: string, sql: string) =>
    invoke<QueryResult>("run_query", { id, sql }),
  saveTextFile: (path: string, content: string) =>
    invoke<void>("save_text_file", { path, content }),
  updateCell: (id: string, database: string, table: string, edit: CellEdit) =>
    invoke<number>("update_cell", { id, database, table, edit }),
  insertRow: (id: string, database: string, table: string, row: RowInsert) =>
    invoke<number>("insert_row", { id, database, table, row }),
  deleteRow: (id: string, database: string, table: string, del: RowDelete) =>
    invoke<number>("delete_row", { id, database, table, del }),
  poolStatus: (id: string) => invoke<PoolStatus>("pool_status", { id }),
  pingConnection: (id: string) => invoke<number>("ping_connection", { id }),
  columnStats: (id: string, database: string, table: string, column: string) =>
    invoke<ColumnStats>("column_stats", { id, database, table, column }),
  tableInfo: (id: string, database: string, table: string) =>
    invoke<[string, string][]>("table_info", { id, database, table }),
  createCollection: (id: string, database: string, name: string) =>
    invoke<void>("create_collection", { id, database, name }),
  createDatabase: (id: string, name: string) => invoke<void>("create_database", { id, name }),
  dropCollection: (id: string, database: string, name: string) =>
    invoke<void>("drop_collection", { id, database, name }),
  dropDatabase: (id: string, name: string) => invoke<void>("drop_database", { id, name }),
  listRoutines: (id: string, database: string) =>
    invoke<RoutineInfo[]>("list_routines", { id, database }),
  routineDefinition: (id: string, database: string, name: string, routineType: string) =>
    invoke<string>("routine_definition", { id, database, name, routineType }),
  execDdl: (id: string, sql: string) => invoke<void>("exec_ddl", { id, sql }),
  keyDetail: (id: string, database: string, key: string) =>
    invoke<KeyDetail | null>("key_detail", { id, database, key }),
  keyEdit: (id: string, database: string, key: string, edit: KeyEdit) =>
    invoke<number>("key_edit", { id, database, key, edit }),
  exportTable: (id: string, database: string, table: string, query: DataQuery, options: ExportOptions, outPath: string) =>
    invoke<ExportResult>("export_table", { id, database, table, query, options, outPath }),
  importCsv: (id: string, database: string, table: string, path: string, options: ImportOptions) =>
    invoke<ImportResult>("import_csv", { id, database, table, path, options }),
  schemaDump: (id: string, database: string) => invoke<string>("schema_dump", { id, database }),
  explainQuery: (id: string, sql: string) =>
    invoke<QueryResult>("explain_query", { id, sql }),
  alterTable: (id: string, database: string, table: string, op: AlterOp) =>
    invoke<void>("alter_table", { id, database, table, op }),
  erModel: (id: string, database: string) =>
    invoke<ErModel>("er_model", { id, database }),
  tableDdl: (id: string, database: string, table: string) =>
    invoke<string>("table_ddl", { id, database, table }),
  tableIndexes: (id: string, database: string, table: string) =>
    invoke<IndexInfo[]>("table_indexes", { id, database, table }),
  dropIndex: (id: string, database: string, table: string, index: string) =>
    invoke<void>("drop_index", { id, database, table, index }),
  createIndex: (id: string, database: string, table: string, name: string, columns: string[], unique: boolean) =>
    invoke<void>("create_index", { id, database, table, name, columns, unique }),
  serverInfo: (id: string) =>
    invoke<ServerInfoSection[]>("server_info", { id }),
  backupDetectCli: (kind: DbKind) =>
    invoke<boolean>("backup_detect_cli", { kind }),
  backupRun: (config: ConnectionConfig, database: string, outPath: string) =>
    invoke<BackupResult>("backup_run", { config, database, outPath }),
  backupRestore: (config: ConnectionConfig, database: string, inPath: string) =>
    invoke<void>("backup_restore", { config, database, inPath }),
  // 排程備份 + 歷史
  listSchedules: () => invoke<BackupSchedule[]>("list_schedules"),
  saveSchedule: (schedule: BackupSchedule) =>
    invoke<BackupSchedule>("save_schedule", { schedule }),
  removeSchedule: (scheduleId: string) =>
    invoke<void>("remove_schedule", { scheduleId }),
  toggleSchedule: (scheduleId: string, enabled: boolean) =>
    invoke<BackupSchedule>("toggle_schedule", { scheduleId, enabled }),
  runScheduleNow: (scheduleId: string) =>
    invoke<BackupHistoryEntry>("run_schedule_now", { scheduleId }),
  listBackupHistory: () =>
    invoke<BackupHistoryEntry[]>("list_backup_history"),
  restoreFromHistory: (entryId: string) =>
    invoke<void>("restore_from_history", { entryId }),
  clearHistory: () => invoke<void>("clear_history"),
};
