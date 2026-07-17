import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type DbKind = "mysql" | "mariadb" | "postgres" | "mongo" | "redis" | "sqlite" | "mssql" | "oracle" | "kafka" | "elastic" | "rabbitmq" | "external";

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
  // 外部 gateway 驅動（kind === "external"）
  options?: Record<string, string>;
  otp_secret?: string;
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  rows_affected: number;
  /// 後端已達 row cap 截斷：實際符合列數 ≥ rows.length（顯示「已截斷」而非誤報總數）。
  truncated?: boolean;
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
  comment?: string;
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
  modified?: string | null; // 最後修改時間（MySQL）
  deterministic?: boolean | null; // 具決定性（MySQL 函式）
  comment?: string | null; // 註解（MySQL）
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  ref_table: string;
  ref_column: string;
}

export interface PagedData {
  columns: string[];
  rows: (string | null)[][];
  total_rows: number;
  page: number;
  page_size: number;
  primary_key: string[];
  // 每列主鍵的精確定位值（Mongo：_id 的 canonical extended JSON）；其他 driver 為空。
  row_ids?: string[];
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
  count?: boolean;     // 是否計算總列數；純翻頁時可設 false 沿用前次快取（缺省 true）
}

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown" | "xlsx";

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

// 多結果集匯出（「全部匯出」）的單組 payload：sql 為產生該結果集的原語句（分節標題 / JSON 附帶）。
export interface ResultSetPayload {
  sql?: string | null;
  columns: string[];
  rows: (string | null)[][];
}

export interface ImportOptions {
  delimiter?: string | null;
  has_header?: boolean;
  empty_as_null?: boolean;
  columns?: string[] | null;
  stop_on_error?: boolean;
  trim?: boolean; // 去除每格前後空白
}

export interface ImportResult {
  imported: number;
  failed: number;
  errors: string[];
}

// 匯入預覽：檔案的欄名 + 前幾列 + 總列數（供匯入前檢視 / 對應欄位）。
export interface ImportPreview {
  columns: string[];
  rows: string[][];
  total_rows: number;
}

// 資料傳輸（Data Transfer）：把來源表資料複製到目標表（可跨連線 / 跨庫）。
export interface TransferOptions {
  stop_on_error?: boolean;
  create_table?: boolean; // 目標表不存在時沿用來源 DDL 自動建立（限同種類）
}
export interface TransferResult {
  transferred: number;
  failed: number;
  columns: string[];          // 實際傳輸的欄位（來源 ∩ 目標）
  skipped_columns: string[];  // 來源有、目標無 → 略過
  created: boolean;           // 本次是否自動建立了目標表
  errors: string[];
}

export interface ColumnStats {
  total: number;
  non_null: number;
  distinct: number;
  min: string | null;
  max: string | null;
  // ---- Mongo 專用（SQL 種類為 0 / 空陣列；前端以 types.length 判斷是否為 Mongo 統計）----
  missing: number;
  null_count: number;
  types: [string, number][];
  top_values: [string, number][];
  distinct_capped: boolean;
  sampled: number;
}

// ---- MongoDB 專屬 DTO（監控 / 進階索引 / validation）----
export interface MongoIndexStat { name: string; ops: number; since: string; host: string }
export interface MongoIndexOptions {
  unique?: boolean;
  sparse?: boolean;
  hidden?: boolean;
  expire_after_secs?: number | null;
  partial_filter_json?: string | null;
}
export interface MongoValidation { validator_json: string; level: string; action: string }
export interface MongoOp {
  opid: string; op: string; ns: string; secs_running: number;
  client: string; desc: string; command_json: string;
  active: boolean; waiting_for_lock: boolean;
}
export interface MongoProfile { level: number; slow_ms: number }
export interface MongoSlowQuery {
  ts: string; op: string; ns: string; millis: number; plan_summary: string;
  keys_examined: number; docs_examined: number; nreturned: number; command_json: string;
}

// DDL 結構編輯（與後端 serde tag="op" 對齊）
export type AlterOp =
  | { op: "add_column"; name: string; data_type: string; nullable: boolean; default?: string | null }
  | { op: "drop_column"; name: string }
  | { op: "rename_column"; old: string; new: string }
  | { op: "modify_column"; name: string; data_type: string; nullable: boolean }
  | { op: "set_default"; name: string; default?: string | null };

// SQL 自動完成：整庫每張表的欄名（schema_columns 一次載回，供批次補全）。
export interface TableColumns { table: string; columns: string[] }

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

// Redis 鍵名清單（供鍵樹建構）。truncated 表示達上限、可能仍有更多鍵。
export interface RedisKeys {
  keys: string[];
  truncated: boolean;
}

// 大型集合鍵的分頁讀取結果（hash/set/zset 游標式；list LRANGE 視窗）。
// cursor === 0 表示已掃描完成；total 為集合總長（-1 表未知）。
export interface KeyPage {
  type_: string;
  ttl: number;
  total: number;
  cursor: number;
  fields: string[];
  members: string[];
  scores: number[];
  value_bytes: number; // string：值總位元組數（STRLEN）；非 string 為 -1
  truncated: boolean;  // string：members[0] 僅為前段預覽（值過大且未要求完整載入）
}

// SLOWLOG 單筆。
export interface SlowLogEntry {
  id: number;
  time: number;        // Unix 秒
  duration_us: number; // 微秒
  command: string;
  client: string;
  client_name: string;
}

// CLIENT LIST 單筆。
export interface ClientInfo {
  id: string;
  addr: string;
  name: string;
  age: string;
  idle: string;
  db: string;
  cmd: string;
  flags: string;
}

// 大鍵掃描單筆。
export interface BigKey {
  key: string;
  type_: string;
  bytes: number; // -1 表伺服器未回 MEMORY USAGE
  ttl: number;
}

// Pub/Sub 推播訊息（後端事件 `redis-pubsub` 的 payload）。
export interface PubSubMessage {
  conn_id: string;
  channel: string;
  pattern: string | null;
  payload: string;
}

// 訂閱後端推播的 Pub/Sub 訊息（僅回呼符合 connId 的訊息）。回傳取消監聽函式。
export function onRedisPubSub(connId: string, cb: (m: PubSubMessage) => void): Promise<UnlistenFn> {
  return listen<PubSubMessage>("redis-pubsub", (e) => {
    if (e.payload.conn_id === connId) cb(e.payload);
  });
}

// 訂閱 Pub/Sub 背景任務錯誤（payload 為字串）。回傳取消監聽函式。
export function onRedisPubSubError(cb: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>("redis-pubsub-error", (e) => cb(e.payload));
}

// ---- AI 助手（本機 claude CLI）----

// claude CLI 偵測結果（決定是否顯示安裝 / 登入提示）。
export interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  logged_in: boolean;
  path: string | null;
}

// 助手模式：advise = 純問答 / 產生腳本文字（唯讀）；agent = 可寫腳本檔到工作資料夾。
// generate：一次性 NL→查詢語句生成（零工具、單回合、無 session）。
export type AgentMode = "advise" | "agent" | "generate";

// 後端 `claude-stream` 事件 payload（依 kind 取用欄位）。
export interface AgentEvent {
  req_id: string;
  kind: "system" | "text" | "tool" | "result" | "error" | "done";
  text?: string | null;
  session_id?: string | null;
  model?: string | null;
  tool?: string | null;
  is_error?: boolean | null;
  duration_ms?: number | null;
  code?: number | null;
}

// 訂閱某次問答的串流事件（僅回呼符合 reqId 者）。回傳取消監聽函式。
export function onClaudeStream(reqId: string, cb: (e: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>("claude-stream", (e) => {
    if (e.payload.req_id === reqId) cb(e.payload);
  });
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

// DDL 語法驗證結果（與後端 ValidationReport 對齊）。
// ok：未發現語法錯誤（或略過時為 true）；validated：伺服器是否實際驗證；
// 略過時（MySQL 觸發器 / 無權限）validated=false，caveat 說明原因。
export interface ValidationReport {
  ok: boolean;
  validated: boolean;
  message: string | null;
  line: number | null;
  caveat: string | null;
}

// SQL Search（全資料庫物件搜尋）單筆命中。與後端 SearchHit 對齊。
export interface SearchHit {
  database: string;
  // table|view|column|index|procedure|function|trigger|foreign_key|collection|key
  object_type: string;
  object_name: string;
  parent?: string | null; // 所屬資料表 / 集合（column / index / trigger / fk）
  matched_in: string;     // name|definition|comment
  snippet?: string | null; // 定義 / 註解命中的前後文片段（供高亮）
  extra?: string | null;   // 資料型別 / 引數簽章 等補充
}

// SQL Search 選項。與後端 SearchOptions（serde）對齊。
export interface SearchOptions {
  term: string;
  databases?: string[] | null; // null / 省略 → 全部（排除系統庫）
  types?: string[] | null;     // null / 省略 → 全部型別
  match_names?: boolean;
  match_definitions?: boolean;
  match_comments?: boolean;
  case_sensitive?: boolean;
  whole_word?: boolean;  // 詞界比對（後端以單字邊界實作；qland 忽略、mssql 未支援）
  wildcards?: boolean;   // 萬用字元（* → 任意長度、? → 單一字元；後端轉錨定 LIKE，redis 原生 glob）
  limit?: number | null;
}

// ---- Kafka（一等公民）DTO ----

export interface KafkaBroker { id: number; host: string; port: number }
export interface KafkaClusterInfo {
  bootstrap: string;
  broker_count: number;
  brokers: KafkaBroker[];
  orig_broker_id: number;
  cluster_id: string | null;
  /** 控制器 broker id；-1 表未知。 */
  controller_id: number;
  /** 排除內部主題的主題數；內部主題另計。 */
  topic_count: number;
  internal_topic_count: number;
  partition_count: number;
  /** ISR < replicas 的分區數。 */
  under_replicated: number;
  /** leader == -1 的分區數。 */
  offline_partitions: number;
  librdkafka_version: string;
}
export interface KafkaTopic {
  name: string;
  partitions: number;
  replication: number;
  internal: boolean;
}

// Elasticsearch / OpenSearch DTO（欄位對齊後端 db/elastic/dto.rs 的 snake_case serde）。
export interface EsClusterHealth {
  cluster_name: string;
  status: string; // green / yellow / red
  flavor: string; // elasticsearch / opensearch
  version: string;
  number_of_nodes: number;
  number_of_data_nodes: number;
  active_primary_shards: number;
  active_shards: number;
  relocating_shards: number;
  unassigned_shards: number;
}
export interface EsIndexInfo {
  index: string;
  health: string;
  status: string;
  docs_count: number;
  docs_deleted: number;
  store_size: string;
  pri: number;
  rep: number;
}
export interface EsNodeInfo {
  name: string;
  version: string;
  roles: string;
  heap_percent: string;
  cpu: string;
}

// RabbitMQ DTO（欄位對齊後端 db/rabbitmq/dto.rs 的 snake_case serde）。
export interface RabbitOverview {
  rabbitmq_version: string;
  erlang_version: string;
  node: string;
  queue_total: number;
  connection_total: number;
  consumer_total: number;
  messages_ready: number;
  messages_unacked: number;
  publish_rate: number;
  deliver_rate: number;
}
export interface RabbitQueue {
  name: string;
  vhost: string;
  queue_type: string; // classic | quorum | stream
  state: string;
  messages: number;
  messages_ready: number;
  messages_unacked: number;
  consumers: number;
  durable: boolean;
  auto_delete: boolean;
  memory: number;
}
export interface RabbitExchange {
  name: string;
  exchange_type: string;
  durable: boolean;
  auto_delete: boolean;
}
export interface RabbitMessage {
  payload: string;
  properties: string; // JSON 字串
  routing_key: string;
  exchange: string;
  redelivered: boolean;
  message_count: number;
}
export interface RabbitPublishResult {
  confirmed: boolean;
}
export interface KafkaPartitionInfo {
  partition: number;
  leader: number;
  replicas: number[];
  isr: number[];
  low: number;
  high: number;
}
export interface KafkaHeader { key: string; value: string }
export interface KafkaMessage {
  conn_id: string;
  topic: string;
  partition: number;
  offset: number;
  timestamp: number; // epoch ms；-1 未知
  key: string | null;
  value: string | null;
  headers: KafkaHeader[];
  key_encoding: "string" | "json" | "avro" | "protobuf" | "binary";
  value_encoding: "string" | "json" | "avro" | "protobuf" | "binary";
  value_bytes: number;
  truncated: boolean;
  schema_id?: number | null;
}
// 消費起點（對齊後端 KafkaStart，serde tag = "type"）。
export type KafkaStartPosition =
  | { type: "beginning" }
  | { type: "end" }
  | { type: "offset"; offset: number }
  | { type: "timestamp"; ts: number };
export interface KafkaScanOptions {
  max_scan: number;
  max_wait_ms?: number | null;
}
export interface KafkaConsumeQuery {
  partition: number | null; // null = 全部分區
  start: KafkaStartPosition;
  limit: number;
  filter?: string | null;
  /** 反序列化覆寫："string" | "json" | "hex" | "avro"；null = 自動。 */
  key_deser?: string | null;
  value_deser?: string | null;
  /** 搜尋更多：掃描直到命中 limit 筆或掃到上限。null = 舊行為。 */
  scan?: KafkaScanOptions | null;
  /** JS 篩選運算式（與子字串 filter 為 AND）；需 kafka-js。null = 不用。 */
  js_filter?: string | null;
}
export interface KafkaConsumeResult {
  messages: KafkaMessage[];
  scanned: number;
  matched: number;
  reached_end: boolean;
  eval_errors: number;
  elapsed_ms: number;
}
/** kafka-scan-progress 事件 payload。 */
export interface KafkaScanProgress {
  conn_id: string;
  topic: string;
  scanned: number;
  matched: number;
}
export interface KafkaProduceRequest {
  topic: string;
  partition?: number | null;
  key?: string | null;
  value?: string | null;
  headers: KafkaHeader[];
  /** value 序列化："raw"（預設）| "avro"（以 SR schema 編碼）。 */
  value_format?: string | null;
  /** value_format="avro" 時的 subject（預設 "{topic}-value"）。 */
  value_subject?: string | null;
}
export interface KafkaProduceResult { partition: number; offset: number }
export interface KafkaBatchResult { sent: number; failed: number; first_error?: string | null }
export interface KafkaCsvProduceOptions {
  topic: string;
  delimiter?: string | null;
  has_header: boolean;
  key_column?: string | null;
  value_column?: string | null;
  partition?: number | null;
}
/** kafka-produce-progress 事件 payload。 */
export interface KafkaProduceProgress { conn_id: string; sent: number; failed: number; total: number }
export interface KafkaConfigEntry {
  name: string;
  value: string;
  source: string;
  is_default: boolean;
  is_sensitive: boolean;
}
export interface KafkaCreateTopicSpec {
  name: string;
  partitions: number;
  replication: number;
  config: KafkaHeader[]; // {key,value} 當設定 k/v
}
export interface KafkaDeleteRecordsResult {
  partition: number;
  /** 刪除後的新 low watermark；-1 表該分區失敗（見 error）。 */
  low_watermark: number;
  error?: string | null;
}
export interface KafkaConsumerGroup {
  group_id: string;
  state: string;
  protocol: string;
  members: number;
}
export interface KafkaGroupMember {
  member_id: string;
  client_id: string;
  host: string;
  assignments: string[]; // "topic:partition"
}
export interface KafkaGroupOffset {
  topic: string;
  partition: number;
  current: number;
  log_end: number;
  lag: number;
}
export interface KafkaGroupDetail {
  group_id: string;
  state: string;
  members: KafkaGroupMember[];
  offsets: KafkaGroupOffset[];
}
// 位移重設目標（對齊後端 KafkaResetTarget；比消費起點多一個 shift）。
export type KafkaResetTarget = KafkaStartPosition | { type: "shift"; by: number };
/** 預覽 / 套用共用的每分區位移計畫列。target=null = 略過（如 shift 遇無已提交位移）。 */
export interface KafkaOffsetPlanRow {
  partition: number;
  /** -1 = 無已提交位移。 */
  current: number;
  target: number | null;
  low: number;
  high: number;
}
export interface KafkaOffsetReset {
  group: string;
  topic: string;
  target: KafkaResetTarget;
  partitions?: number[] | null;
}
export interface KafkaHealthItem {
  severity: "high" | "medium" | "info";
  kind: "rf1" | "offline" | "urp" | "under_min_isr" | "group_lag";
  target: string;
  detail: string;
  value: number;
}
export interface KafkaHealthReport {
  scanned_at: number;
  items: KafkaHealthItem[];
  topics_total: number;
  partitions_total: number;
}
export interface KafkaMonitorConfig {
  enabled: boolean;
  interval_secs: number;
  topics: string[];
  groups: string[];
}
export interface KafkaHealthCounts { brokers: number; partitions: number; offline: number; urp: number }
export interface KafkaSample {
  ts: number;
  topic_end: Record<string, number>;
  group_lag: Record<string, number>;
  health: KafkaHealthCounts;
}
export interface KafkaMonitorStatus { running: boolean; config?: KafkaMonitorConfig | null }
export interface KafkaAlertRule {
  id: string;
  connection_id: string;
  enabled: boolean;
  scope: "topic" | "group" | "cluster";
  target: string;
  metric: "lag" | "produce_rate" | "offline" | "urp";
  op: "gt" | "lt";
  threshold: number;
  for_ticks: number;
}
export interface KafkaAlertEvent {
  id: string;
  rule_id: string;
  connection_id: string;
  fired_at: number;
  message: string;
  value: number;
}
export interface KafkaSchemaSubject { subject: string; versions: number[]; latest: number }
export interface KafkaCompatibility { level: string; inherited: boolean }
export interface KafkaCompatCheck { compatible: boolean; messages: string[] }
export interface KafkaConnectTask { id: number; state: string; worker_id: string; trace?: string | null }
export interface KafkaConnector {
  name: string;
  connector_type: string;
  state: string;
  worker_id: string;
  tasks: KafkaConnectTask[];
}
export interface KafkaConnectPlugin { class: string; kind: string; version: string }
export interface KafkaConnectValidation { error_count: number; errors: KafkaHeader[] }
export interface KafkaAclBinding {
  resource_type: string; // topic | group | cluster | transactional_id | any
  name: string;
  pattern_type: string; // literal | prefixed | any
  principal: string;
  host: string;
  operation: string;
  permission: string; // allow | deny | any
}
export interface KafkaSchema {
  subject: string;
  version: number;
  id: number;
  schema_type: string;
  schema: string;
}

// 訂閱 live-tail 訊息（僅回呼符合 connId 者）。回傳取消監聽函式。
export function onKafkaMessage(connId: string, cb: (m: KafkaMessage) => void): Promise<UnlistenFn> {
  return listen<KafkaMessage>("kafka-message", (e) => {
    if (e.payload.conn_id === connId) cb(e.payload);
  });
}
// 訂閱 Kafka 背景任務錯誤（payload 為字串）。回傳取消監聽函式。
export function onKafkaError(cb: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>("kafka-error", (e) => cb(e.payload));
}
// 訂閱掃描進度（僅回呼符合 connId 者）。回傳取消監聽函式。
export function onKafkaScanProgress(connId: string, cb: (p: KafkaScanProgress) => void): Promise<UnlistenFn> {
  return listen<KafkaScanProgress>("kafka-scan-progress", (e) => {
    if (e.payload.conn_id === connId) cb(e.payload);
  });
}
// 訂閱 CSV 發佈進度（僅回呼符合 connId 者）。回傳取消監聽函式。
export function onKafkaProduceProgress(connId: string, cb: (p: KafkaProduceProgress) => void): Promise<UnlistenFn> {
  return listen<KafkaProduceProgress>("kafka-produce-progress", (e) => {
    if (e.payload.conn_id === connId) cb(e.payload);
  });
}
// 訂閱背景取樣的新樣本（僅回呼符合 connId 者）。回傳取消監聽函式。
export function onKafkaMetrics(connId: string, cb: (s: KafkaSample) => void): Promise<UnlistenFn> {
  return listen<{ conn_id: string; sample: KafkaSample }>("kafka-metrics", (e) => {
    if (e.payload.conn_id === connId) cb(e.payload.sample);
  });
}
// 訂閱告警觸發（全域；payload 為事件）。回傳取消監聽函式。
export function onKafkaAlert(cb: (e: KafkaAlertEvent) => void): Promise<UnlistenFn> {
  return listen<KafkaAlertEvent>("kafka-alert", (e) => cb(e.payload));
}

// 連線類型分類（新增連線對話框的分組選擇器用；種類將達 12+，靠分類維持可掃視性）。
export type KindCategory = "relational" | "document" | "kv" | "queue" | "search" | "other";

// 分類顯示順序與標籤（繁中字串即 i18n key，渲染時過 t()）。
export const KIND_CATEGORIES: { id: KindCategory; label: string }[] = [
  { id: "relational", label: "關聯式" },
  { id: "document", label: "文件" },
  { id: "kv", label: "鍵值" },
  { id: "queue", label: "訊息佇列" },
  { id: "search", label: "搜尋引擎" },
  { id: "other", label: "其他" },
];

// 連線類型的顯示資料（色標呼應規劃文件）
// category 為必填：新增 kind 時 TS 會強制選一個分類（KindPicker 依此分組）。
// noDatabase：無「資料庫」概念的類型（kafka 等），ConnectionDialog 據此隱藏 database 欄。
export const KIND_META: Record<DbKind, { label: string; color: string; defaultPort: number; category: KindCategory; fileBased?: boolean; external?: boolean; noDatabase?: boolean }> = {
  mysql: { label: "MySQL", color: "#3b82f6", defaultPort: 3306, category: "relational" },
  // MariaDB：後端共用 MySQL driver（線協定相容），前端獨立類型（teal 不與 mysql 藍撞色）。
  mariadb: { label: "MariaDB", color: "#14b8a6", defaultPort: 3306, category: "relational" },
  postgres: { label: "PostgreSQL", color: "#6366f1", defaultPort: 5432, category: "relational" },
  mongo: { label: "MongoDB", color: "#22c55e", defaultPort: 27017, category: "document" },
  redis: { label: "Redis", color: "#ef4444", defaultPort: 6379, category: "kv" },
  sqlite: { label: "SQLite", color: "#f59e0b", defaultPort: 0, category: "relational", fileBased: true },
  mssql: { label: "SQL Server", color: "#0ea5e9", defaultPort: 1433, category: "relational" },
  // Oracle：orange-500（品牌紅 #f80000 與 Redis 紅撞色，取最近的空缺色相）。
  oracle: { label: "Oracle", color: "#f97316", defaultPort: 1521, category: "relational" },
  // Kafka：cyan-700（與 sky-500 mssql / violet external 區隔）。
  kafka: { label: "Kafka", color: "#0891b2", defaultPort: 9092, category: "queue", noDatabase: true },
  // Elasticsearch / OpenSearch（單一類型，flavor 連線時自動偵測）：yellow-500 呼應 Elastic 品牌黃。
  elastic: { label: "Elasticsearch", color: "#eab308", defaultPort: 9200, category: "search", noDatabase: true },
  // RabbitMQ：pink-500（現有色相唯一空缺；品牌橘與 oracle #f97316 撞色不用）。
  rabbitmq: { label: "RabbitMQ", color: "#ec4899", defaultPort: 5672, category: "queue", noDatabase: true },
  external: { label: "External", color: "#8b5cf6", defaultPort: 0, category: "other", external: true },
};

// parse_connection_url 的回傳：連線字串解析結果（欄位皆可缺；options 為 per-kind 映射後的鍵值）。
export interface ParsedUrl {
  kind: DbKind | null;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  database: string | null;
  options: Record<string, string>;
}

// 後端 command 包裝
export const api = {
  testConnection: (config: ConnectionConfig) =>
    invoke<void>("test_connection", { config }),
  connect: (config: ConnectionConfig) => invoke<void>("connect", { config }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  // 清除外部 gateway 等驅動的查詢快取（供「重新整理」強制重抓）。
  clearCache: (id: string) => invoke<void>("clear_cache", { id }),
  // 介面語言同步給後端：Rust 錯誤訊息與 dbk CLI 共用 app_settings.json 的 lang。
  // 後端 command 尚未上線時會 reject —— 呼叫端（i18n.setLang）已 catch，不擋 UI 切換。
  setLang: (lang: string) => invoke<void>("set_lang", { lang }),
  // 啟動密碼（app-lock 閘門）：Argon2 雜湊存後端 app_settings.json，明文不落地、不入 keychain。
  hasStartupPassword: () => invoke<boolean>("has_startup_password"),
  verifyStartupPassword: (password: string) =>
    invoke<boolean>("verify_startup_password", { password }),
  // current 為 null 表首次設定；已有密碼時須傳目前密碼驗證。
  setStartupPassword: (current: string | null, next: string) =>
    invoke<void>("set_startup_password", { current, next }),
  clearStartupPassword: (current: string) =>
    invoke<void>("clear_startup_password", { current }),
  // 加密匯出 / 匯入連線（含密碼；passphrase 派生金鑰 + AES-256-GCM）。回傳筆數。
  exportConnectionsEncrypted: (path: string, passphrase: string) =>
    invoke<number>("export_connections_encrypted", { path, passphrase }),
  importConnectionsEncrypted: (path: string, passphrase: string) =>
    invoke<number>("import_connections_encrypted", { path, passphrase }),
  // 解析連線字串（mysql:// postgres:// mongodb+srv:// rediss:// sqlserver:// / ADO.NET 等）→ 填表用。
  parseConnectionUrl: (url: string) => invoke<ParsedUrl>("parse_connection_url", { url }),
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
  schemaColumns: (id: string, database: string) =>
    invoke<TableColumns[]>("schema_columns", { id, database }),
  tableData: (id: string, database: string, table: string, query: DataQuery) =>
    invoke<PagedData>("table_data", { id, database, table, query }),
  runQuery: (id: string, sql: string, maxRows?: number) =>
    invoke<QueryResult>("run_query", { id, sql, maxRows: maxRows ?? null }),
  // 多結果集查詢：單語句 EXEC/CALL 多結果集、或 external gateway 整批多 SELECT。
  // 後端保證至少 1 元素；未覆寫的驅動回單元素陣列，與 runQuery 等價。
  runQueryMulti: (id: string, sql: string, maxRows?: number) =>
    invoke<QueryResult[]>("run_query_multi", { id, sql, maxRows: maxRows ?? null }),
  // 後端重新執行查詢直接寫檔（不受互動 row cap 限制、rows 不經 IPC）：截斷結果的完整匯出用。
  exportQuery: (id: string, sql: string, options: ExportOptions, outPath: string) =>
    invoke<ExportResult>("export_query", { id, sql, options, outPath }),
  // 查詢防護（row cap / 逾時）全域設定；啟動與設定變更時呼叫，持久化在 localStorage。
  setQueryGuard: (maxRows: number, timeoutMs: number) =>
    invoke<void>("set_query_guard", { maxRows, timeoutMs }),
  saveTextFile: (path: string, content: string) =>
    invoke<void>("save_text_file", { path, content }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
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
  listForeignKeys: (id: string, database: string, table: string) =>
    invoke<ForeignKeyInfo[]>("list_foreign_keys", { id, database, table }),
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
  searchObjects: (id: string, options: SearchOptions) =>
    invoke<SearchHit[]>("search_objects", { id, options }),
  execDdl: (id: string, sql: string) => invoke<void>("exec_ddl", { id, sql }),
  // DDL 語法驗證（不持久化）：PG/SQLite 交易回滾、MySQL 暫存名稱試建。database 供 MySQL 試建用 schema。
  validateDdl: (id: string, database: string, sql: string) =>
    invoke<ValidationReport>("validate_ddl", { id, database, sql }),
  keyDetail: (id: string, database: string, key: string) =>
    invoke<KeyDetail | null>("key_detail", { id, database, key }),
  keyEdit: (id: string, database: string, key: string, edit: KeyEdit) =>
    invoke<number>("key_edit", { id, database, key, edit }),
  exportTable: (id: string, database: string, table: string, query: DataQuery, options: ExportOptions, outPath: string) =>
    invoke<ExportResult>("export_table", { id, database, table, query, options, outPath }),
  // 匯出已備妥的查詢結果（欄 + 列）到檔案；走後端同一套 render，支援 xlsx 等二進位格式。
  exportRows: (columns: string[], rows: (string | null)[][], options: ExportOptions, outPath: string) =>
    invoke<ExportResult>("export_rows", { columns, rows, options, outPath }),
  // 一次匯出多個結果集（多語句批次的「全部匯出」）：xlsx 單檔多工作表、
  // markdown / json / sql 單檔分節、csv / tsv 編號多檔（{base}-1..-N）。
  exportRowsMulti: (sets: ResultSetPayload[], options: ExportOptions, outPath: string) =>
    invoke<ExportResult>("export_rows_multi", { sets, options, outPath }),
  importCsv: (id: string, database: string, table: string, path: string, options: ImportOptions) =>
    invoke<ImportResult>("import_csv", { id, database, table, path, options }),
  // 匯入預覽（讀檔解析欄名 + 前幾列，不寫入）。
  importPreview: (path: string, options: ImportOptions) =>
    invoke<ImportPreview>("import_preview", { path, options }),
  // Excel (.xlsx/.xls) 匯入：取第一張工作表，與 CSV 匯入共用後端寫入邏輯。
  importExcel: (id: string, database: string, table: string, path: string, options: ImportOptions) =>
    invoke<ImportResult>("import_excel", { id, database, table, path, options }),
  schemaDump: (id: string, database: string) => invoke<string>("schema_dump", { id, database }),
  // 資料傳輸：把來源表資料複製到目標表（同名欄位交集；目標表需先存在）。
  transferTable: (
    srcId: string, srcDb: string, srcTable: string,
    dstId: string, dstDb: string, dstTable: string,
    options: TransferOptions,
  ) => invoke<TransferResult>("transfer_table", { srcId, srcDb, srcTable, dstId, dstDb, dstTable, options }),
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
  redisKeys: (id: string, database: string, pattern: string, limit: number) =>
    invoke<RedisKeys>("redis_keys", { id, database, pattern, limit }),
  // 大型集合鍵成員分頁（cursor 起點、count 每頁筆數、filter 成員/欄位過濾）。
  redisKeyPage: (id: string, database: string, key: string, cursor: number, count: number, filter: string, full = false) =>
    invoke<KeyPage>("redis_key_page", { id, database, key, cursor, count, filter, full }),
  // 文件型（Mongo）：整份文件 JSON 檢視 / 取代。docId 為該列 _id 的 canonical extended JSON。
  documentGet: (id: string, database: string, table: string, docId: string) =>
    invoke<string>("document_get", { id, database, table, docId }),
  documentReplace: (id: string, database: string, table: string, docId: string, docJson: string) =>
    invoke<number>("document_replace", { id, database, table, docId, docJson }),
  // ---- MongoDB 專屬：監控 / 進階索引 / validation ----
  mongoIndexStats: (id: string, database: string, collection: string) =>
    invoke<MongoIndexStat[]>("mongo_index_stats", { id, database, collection }),
  mongoCreateIndex: (id: string, database: string, collection: string, name: string, keys: [string, string][], options: MongoIndexOptions) =>
    invoke<void>("mongo_create_index", { id, database, collection, name, keys, options }),
  mongoGetValidation: (id: string, database: string, collection: string) =>
    invoke<MongoValidation>("mongo_get_validation", { id, database, collection }),
  mongoSetValidation: (id: string, database: string, collection: string, validatorJson: string, level: string, action: string) =>
    invoke<void>("mongo_set_validation", { id, database, collection, validatorJson, level, action }),
  mongoDbStats: (id: string, database: string) =>
    invoke<[string, string][]>("mongo_db_stats", { id, database }),
  mongoCurrentOps: (id: string) => invoke<MongoOp[]>("mongo_current_ops", { id }),
  mongoKillOp: (id: string, opid: string) => invoke<void>("mongo_kill_op", { id, opid }),
  mongoProfileGet: (id: string, database: string) =>
    invoke<MongoProfile>("mongo_profile_get", { id, database }),
  mongoProfileSet: (id: string, database: string, level: number, slowMs: number) =>
    invoke<MongoProfile>("mongo_profile_set", { id, database, level, slowMs }),
  mongoSlowQueries: (id: string, database: string, limit: number) =>
    invoke<MongoSlowQuery[]>("mongo_slow_queries", { id, database, limit }),
  redisSlowlog: (id: string, count: number) =>
    invoke<SlowLogEntry[]>("redis_slowlog", { id, count }),
  redisClients: (id: string) => invoke<ClientInfo[]>("redis_clients", { id }),
  redisClientKill: (id: string, clientId: string) =>
    invoke<void>("redis_client_kill", { id, clientId }),
  redisBigKeys: (id: string, database: string, sample: number, top: number) =>
    invoke<BigKey[]>("redis_big_keys", { id, database, sample, top }),
  redisPublish: (id: string, channel: string, message: string) =>
    invoke<number>("redis_publish", { id, channel, message }),
  redisSubscribe: (id: string, channels: string[], patterns: string[]) =>
    invoke<void>("redis_subscribe", { id, channels, patterns }),
  redisUnsubscribe: (id: string) => invoke<void>("redis_unsubscribe", { id }),
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

  // ---- Kafka（一等公民）----
  kafkaTopics: (id: string) => invoke<KafkaTopic[]>("kafka_topics", { id }),
  kafkaClusterInfo: (id: string) => invoke<KafkaClusterInfo>("kafka_cluster_info", { id }),
  kafkaTopicPartitions: (id: string, topic: string) =>
    invoke<KafkaPartitionInfo[]>("kafka_topic_partitions", { id, topic }),
  kafkaConsume: (id: string, topic: string, query: KafkaConsumeQuery) =>
    invoke<KafkaConsumeResult>("kafka_consume", { id, topic, query }),
  /** 取消 Kafka 長跑工作（kind 如 "scan" / "csv"）。 */
  kafkaJobCancel: (id: string, kind: string) =>
    invoke<void>("kafka_job_cancel", { id, kind }),
  kafkaTailStart: (id: string, topic: string, partition: number | null, start: KafkaStartPosition, jsFilter?: string | null) =>
    invoke<void>("kafka_tail_start", { id, topic, partition, start, jsFilter: jsFilter ?? null }),
  kafkaTailStop: (id: string) => invoke<void>("kafka_tail_stop", { id }),
  kafkaProduce: (id: string, req: KafkaProduceRequest) =>
    invoke<KafkaProduceResult>("kafka_produce", { id, req }),
  kafkaProduceBatch: (id: string, reqs: KafkaProduceRequest[]) =>
    invoke<KafkaBatchResult>("kafka_produce_batch", { id, reqs }),
  kafkaProduceCsv: (id: string, path: string, options: KafkaCsvProduceOptions) =>
    invoke<KafkaBatchResult>("kafka_produce_csv", { id, path, options }),
  kafkaConsumerGroups: (id: string) => invoke<KafkaConsumerGroup[]>("kafka_consumer_groups", { id }),
  kafkaGroupDetail: (id: string, group: string) =>
    invoke<KafkaGroupDetail>("kafka_group_detail", { id, group }),
  /** 刪除消費者群組（須 Empty；已提交位移一併刪除）。 */
  kafkaDeleteGroup: (id: string, group: string) =>
    invoke<void>("kafka_delete_group", { id, group }),
  /** 預覽位移重設（不檢查群組狀態、不 commit）。 */
  kafkaPreviewResetOffsets: (id: string, reset: KafkaOffsetReset) =>
    invoke<KafkaOffsetPlanRow[]>("kafka_preview_reset", { id, reset }),
  kafkaResetOffsets: (id: string, reset: KafkaOffsetReset) =>
    invoke<KafkaOffsetPlanRow[]>("kafka_reset_offsets", { id, reset }),
  kafkaCreateTopic: (id: string, spec: KafkaCreateTopicSpec) =>
    invoke<void>("kafka_create_topic", { id, spec }),
  kafkaDeleteTopic: (id: string, topic: string) =>
    invoke<void>("kafka_delete_topic", { id, topic }),
  kafkaTopicConfig: (id: string, topic: string) =>
    invoke<KafkaConfigEntry[]>("kafka_topic_config", { id, topic }),
  kafkaBrokerConfig: (id: string, brokerId: number) =>
    invoke<KafkaConfigEntry[]>("kafka_broker_config", { id, brokerId }),
  /** value = null 表示還原該鍵為預設。 */
  kafkaSetTopicConfig: (id: string, topic: string, key: string, value: string | null) =>
    invoke<void>("kafka_set_topic_config", { id, topic, key, value }),
  /** newTotal 為新「總數」（Kafka 分區只能增不能減）。 */
  kafkaAddPartitions: (id: string, topic: string, newTotal: number) =>
    invoke<void>("kafka_add_partitions", { id, topic, newTotal }),
  /** 刪除訊息：partitions=null 全分區；before=null 清到 high watermark（全清）。 */
  kafkaDeleteRecords: (id: string, topic: string, partitions: number[] | null, before: number | null) =>
    invoke<KafkaDeleteRecordsResult[]>("kafka_delete_records", { id, topic, partitions, before }),
  kafkaHealthScan: (id: string) => invoke<KafkaHealthReport>("kafka_health_scan", { id }),
  kafkaMonitorStart: (id: string, config: KafkaMonitorConfig) => invoke<void>("kafka_monitor_start", { id, config }),
  kafkaMonitorStop: (id: string) => invoke<void>("kafka_monitor_stop", { id }),
  kafkaMonitorStatus: (id: string) => invoke<KafkaMonitorStatus>("kafka_monitor_status", { id }),
  kafkaMetricsHistory: (id: string) => invoke<KafkaSample[]>("kafka_metrics_history", { id }),
  kafkaAlertRulesList: (connectionId: string) => invoke<KafkaAlertRule[]>("kafka_alert_rules_list", { connectionId }),
  kafkaAlertRuleSave: (rule: KafkaAlertRule) => invoke<void>("kafka_alert_rule_save", { rule }),
  kafkaAlertRuleRemove: (ruleId: string) => invoke<void>("kafka_alert_rule_remove", { ruleId }),
  kafkaAlertHistory: () => invoke<KafkaAlertEvent[]>("kafka_alert_history"),
  kafkaAlertHistoryClear: () => invoke<void>("kafka_alert_history_clear"),
  kafkaAlertTest: (message: string) => invoke<void>("kafka_alert_test", { message }),
  kafkaSchemaSubjects: (id: string) => invoke<KafkaSchemaSubject[]>("kafka_schema_subjects", { id }),
  kafkaSchema: (id: string, subject: string, version: number) =>
    invoke<KafkaSchema>("kafka_schema", { id, subject, version }),
  kafkaSchemaRegister: (id: string, subject: string, schema: string, schemaType: string) =>
    invoke<number>("kafka_schema_register", { id, subject, schema, schemaType }),
  kafkaSchemaCompatCheck: (id: string, subject: string, schema: string, schemaType: string) =>
    invoke<KafkaCompatCheck>("kafka_schema_compat_check", { id, subject, schema, schemaType }),
  kafkaSchemaCompatGet: (id: string, subject: string | null) =>
    invoke<KafkaCompatibility>("kafka_schema_compat_get", { id, subject }),
  kafkaSchemaCompatSet: (id: string, subject: string | null, level: string) =>
    invoke<void>("kafka_schema_compat_set", { id, subject, level }),
  kafkaSchemaDeleteSubject: (id: string, subject: string) =>
    invoke<number[]>("kafka_schema_delete_subject", { id, subject }),
  kafkaSchemaDeleteVersion: (id: string, subject: string, version: number) =>
    invoke<number>("kafka_schema_delete_version", { id, subject, version }),
  kafkaConnectList: (id: string) => invoke<KafkaConnector[]>("kafka_connect_list", { id }),
  kafkaConnectConfig: (id: string, name: string) => invoke<Record<string, unknown>>("kafka_connect_config", { id, name }),
  kafkaConnectPause: (id: string, name: string) => invoke<void>("kafka_connect_pause", { id, name }),
  kafkaConnectResume: (id: string, name: string) => invoke<void>("kafka_connect_resume", { id, name }),
  kafkaConnectRestart: (id: string, name: string, includeTasks: boolean, onlyFailed: boolean) =>
    invoke<void>("kafka_connect_restart", { id, name, includeTasks, onlyFailed }),
  kafkaConnectRestartTask: (id: string, name: string, task: number) =>
    invoke<void>("kafka_connect_restart_task", { id, name, task }),
  kafkaConnectDelete: (id: string, name: string) => invoke<void>("kafka_connect_delete", { id, name }),
  kafkaConnectPutConfig: (id: string, name: string, config: Record<string, unknown>) =>
    invoke<void>("kafka_connect_put_config", { id, name, config }),
  kafkaConnectPlugins: (id: string) => invoke<KafkaConnectPlugin[]>("kafka_connect_plugins", { id }),
  kafkaConnectValidate: (id: string, cls: string, config: Record<string, unknown>) =>
    invoke<KafkaConnectValidation>("kafka_connect_validate", { id, class: cls, config }),
  kafkaAclsList: (id: string, filter: KafkaAclBinding) => invoke<KafkaAclBinding[]>("kafka_acls_list", { id, filter }),
  kafkaAclsCreate: (id: string, bindings: KafkaAclBinding[]) => invoke<KafkaAclBinding[]>("kafka_acls_create", { id, bindings }),
  kafkaAclsDelete: (id: string, filter: KafkaAclBinding) => invoke<KafkaAclBinding[]>("kafka_acls_delete", { id, filter }),

  // Elasticsearch / OpenSearch：叢集健康、index / 節點清單、mapping、刪 index（唯讀瀏覽 + DSL 查詢）。
  esClusterHealth: (id: string) => invoke<EsClusterHealth>("es_cluster_health", { id }),
  esIndices: (id: string) => invoke<EsIndexInfo[]>("es_indices", { id }),
  esNodes: (id: string) => invoke<EsNodeInfo[]>("es_nodes", { id }),
  esMapping: (id: string, index: string) => invoke<string>("es_mapping", { id, index }),
  esDeleteIndex: (id: string, index: string) => invoke<void>("es_delete_index", { id, index }),

  // RabbitMQ：總覽、佇列 / exchange 清單、佇列詳情、訊息 peek、發布、清空、刪除佇列。
  rabbitmqOverview: (id: string) => invoke<RabbitOverview>("rabbitmq_overview", { id }),
  rabbitmqQueues: (id: string) => invoke<RabbitQueue[]>("rabbitmq_queues", { id }),
  rabbitmqExchanges: (id: string) => invoke<RabbitExchange[]>("rabbitmq_exchanges", { id }),
  rabbitmqQueueDetail: (id: string, queue: string) => invoke<RabbitQueue>("rabbitmq_queue_detail", { id, queue }),
  /** peek：basic.get N 則，requeue=true 會重新入列（標記 redelivered）。 */
  rabbitmqPeek: (id: string, queue: string, count: number, requeue: boolean) =>
    invoke<RabbitMessage[]>("rabbitmq_peek", { id, queue, count, requeue }),
  rabbitmqPublish: (id: string, exchange: string, routingKey: string, payload: string, persistent: boolean) =>
    invoke<RabbitPublishResult>("rabbitmq_publish", { id, exchange, routingKey, payload, persistent }),
  rabbitmqPurge: (id: string, queue: string) => invoke<void>("rabbitmq_purge", { id, queue }),
  rabbitmqDeleteQueue: (id: string, queue: string) => invoke<void>("rabbitmq_delete_queue", { id, queue }),

  // AI 助手：偵測 claude CLI / 送出問答（串流走 onClaudeStream）/ 取消。
  claudeDetect: () => invoke<ClaudeStatus>("claude_detect"),
  claudeSend: (args: {
    reqId: string;
    prompt: string;
    sessionId?: string | null;
    model?: string | null;
    mode?: AgentMode | null;
  }) =>
    invoke<void>("claude_send", {
      reqId: args.reqId,
      prompt: args.prompt,
      sessionId: args.sessionId ?? null,
      model: args.model ?? null,
      mode: args.mode ?? null,
    }),
  claudeCancel: (reqId: string) => invoke<void>("claude_cancel", { reqId }),
  openAgentWorkspace: () => invoke<void>("open_agent_workspace"),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
};
