use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 連線字串（URL / DSN / ADO.NET）解析統一落點。GUI `parse_connection_url` 指令與
/// dbk CLI `--url` 共用；不可 feature-gate（slim CLI 依賴）。
pub mod conn_url;
pub mod limits;
pub mod mongo;
pub mod mssql;
pub mod mysql;
pub mod oracle;
pub mod postgres;
pub mod redis;
pub mod sqlite;

/// 外部 gateway 驅動分派層（泛用擴充點）。實際的外部驅動（可能為私有外掛）以 trait object 接入；
/// 未編入任何外部驅動時 `connect_external` 回 Unsupported。
pub mod external;

/// Kafka 驅動（一等公民；以 rdkafka 接入）。僅在 `kafka` feature 開啟時編入，
/// 讓 slim CLI（`--no-default-features`）免除 librdkafka（CMake/C/OpenSSL）建置負擔。
#[cfg(feature = "kafka")]
pub mod kafka;
/// RabbitMQ 驅動（lapin AMQP + Management REST）。於 `rabbitmq` feature 開啟時編入。
#[cfg(feature = "rabbitmq")]
pub mod rabbitmq;

/// Elasticsearch / OpenSearch 驅動（一等公民；以 reqwest REST 接入）。僅在 `elastic` feature
/// 開啟時編入，讓 slim CLI（`--no-default-features`）免除 reqwest / rustls 相依。
#[cfg(feature = "elastic")]
pub mod elastic;

/// 資料庫範式。UI 與操作邏輯依此分流。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Mysql,
    /// MariaDB：與 MySQL 線協定相容，後端完全共用 `MysqlDriver`（薄別名）；
    /// 前端另立類型以利標示（版本徽章、預設值、色標）。
    Mariadb,
    Postgres,
    Mongo,
    Redis,
    Sqlite,
    Mssql,
    /// Oracle：唯一需要原生 DLL（Instant Client，執行期載入）的類型。實作見 `db::oracle`。
    Oracle,
    /// Kafka：訊息代理（非 SQL）。以 rdkafka 接入；具體驅動於 `kafka` feature 開啟時編入 `db::kafka`。
    /// UI 將 cluster→database、topic→table、messages→rows 做最小映射，其餘能力走 `kafka_*` 指令。
    Kafka,
    /// Elasticsearch / OpenSearch：搜尋引擎（非 SQL）。以 REST 接入；具體驅動於 `elastic` feature
    /// 開啟時編入 `db::elastic`。UI 將 cluster→database、index→table、document→row 做最小映射，
    /// 其餘能力走 `es_*` 指令。OpenSearch 與 ES REST 相容，連線時自動偵測 flavor。
    Elastic,
    /// RabbitMQ：訊息佇列（AMQP 0-9-1，非 SQL）。以 lapin + Management REST 接入；具體驅動於
    /// `rabbitmq` feature 開啟時編入 `db::rabbitmq`。UI 將 vhost→database、queue→table 做最小映射，
    /// 其餘能力（peek / publish / purge）走 `rabbitmq_*` 指令。
    RabbitMq,
    /// 外部 web gateway（非真實連線；透過 HTTP 下 SQL）。實作見 `db::external`。
    External,
}

impl DbKind {
    #[allow(dead_code)] // 保留工具方法：kind → 小寫字串（與 serde 序列化一致），供日後記錄 / 診斷用
    pub fn as_str(&self) -> &'static str {
        match self {
            DbKind::Mysql => "mysql",
            DbKind::Mariadb => "mariadb",
            DbKind::Postgres => "postgres",
            DbKind::Mongo => "mongo",
            DbKind::Redis => "redis",
            DbKind::Sqlite => "sqlite",
            DbKind::Mssql => "mssql",
            DbKind::Oracle => "oracle",
            DbKind::Kafka => "kafka",
            DbKind::Elastic => "elastic",
            DbKind::RabbitMq => "rabbitmq",
            DbKind::External => "external",
        }
    }

    /// 備份檔副檔名（與前端 BackupDialog 的 toolHint 對齊）。
    pub fn backup_ext(&self) -> &'static str {
        match self {
            DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres => ".sql",
            DbKind::Mongo => ".archive",
            DbKind::Redis => ".rdb",
            DbKind::Sqlite => ".db",
            DbKind::Mssql => ".bacpac",
            DbKind::Oracle => ".dmp",
            DbKind::Kafka => "", // Kafka 不支援備份
            DbKind::Elastic => "", // Elasticsearch 不支援備份
            DbKind::RabbitMq => "", // RabbitMQ 不支援備份
            DbKind::External => "",
        }
    }
}

/// SSH Tunnel 認證方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthMethod {
    #[default]
    Password,
    Key,
}

/// 使用者填寫的連線設定。密碼與 SSH secret 存於 OS keychain，不寫入磁碟；
/// 連線時於後端 hydrate 回來（見 `store::kc_get` / commands hydrate）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// 關聯式：預設資料庫；可空。
    #[serde(default)]
    pub database: Option<String>,
    /// 連線池上限。
    #[serde(default = "default_max_conns")]
    pub max_connections: u32,

    // ---- SSH Tunnel（可選；SQLite 不適用）----
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    /// 0 → 在使用點視為 22。
    #[serde(default)]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_username: String,
    #[serde(default)]
    pub ssh_auth_method: SshAuthMethod,
    /// keychain only，不寫入磁碟。
    #[serde(default)]
    pub ssh_password: String,
    #[serde(default)]
    pub ssh_private_key_path: String,
    /// keychain only，不寫入磁碟。
    #[serde(default)]
    pub ssh_passphrase: String,

    // ---- 外部 gateway 驅動（DbKind::External）----
    /// driver-specific 非機密設定（如外部驅動的 driver / base_url / env / insecure）。
    /// ⚠️ 此 map 以「明文」寫入 connections.json — 嚴禁放 API key / token / 密碼等機密；
    /// 機密一律走專屬欄位（password / ssh_* / otp_secret，存 OS keychain）。
    #[serde(default)]
    pub options: std::collections::BTreeMap<String, String>,
    /// TOTP secret（如 2FA gateway）；存 OS keychain，不落地磁碟。
    #[serde(default)]
    pub otp_secret: String,
}

fn default_max_conns() -> u32 {
    5
}

/// 連線目前狀態，供 UI 監控用（呼應規劃文件 3.5 防呆機制）。
#[derive(Debug, Clone, Serialize)]
pub struct PoolStatus {
    pub size: u32,
    pub idle: u32,
    pub in_use: u32,
}

/// 查詢結果：欄位名 + 列（每格為字串，NULL 為 None）。
#[derive(Debug, Default, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub rows_affected: u64,
    /// 已達 row cap 截斷：實際符合列數 ≥ rows.len()（前端據此顯示「已截斷」而非誤報總數）。
    pub truncated: bool,
}

/// 表 / 視圖的基本資訊（連線樹展開用）。
#[derive(Debug, Clone, Serialize)]
pub struct TableInfo {
    pub name: String,
    /// "table" 或 "view"
    pub kind: String,
}

/// 索引定義（「結構」分頁的索引區用）。
#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

/// 外鍵（含約束名，供結構分頁顯示與刪除）。
#[derive(Debug, Clone, Serialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

/// 預存程序 / 函式 / 觸發器（routine browser 用）。
#[derive(Debug, Clone, Serialize)]
pub struct RoutineInfo {
    pub name: String,
    pub routine_type: String, // "procedure" | "function" | "trigger"
    /// 觸發器所屬資料表（procedure / function 為 None）。PG 刪除觸發器需此資訊。
    pub parent: Option<String>,
    /// PG 函式 / 程序的引數型別簽章（如 "integer, text"），用於消除重載歧義刪除。其餘為 None。
    pub signature: Option<String>,
    /// 最後修改時間（MySQL routines / triggers；其餘 None）。對標 Navicat 函式檢視「修改日期」。
    #[serde(default)]
    pub modified: Option<String>,
    /// 是否具決定性（僅 MySQL 函式有意義；其餘 None）。
    #[serde(default)]
    pub deterministic: Option<bool>,
    /// 註解（MySQL routines；其餘 None）。
    #[serde(default)]
    pub comment: Option<String>,
}

/// DDL 語法驗證結果（前端 SQL 編輯器「驗證」按鈕用）。
/// - `ok`：未發現語法錯誤（略過時亦為 true，代表「不阻擋執行」）。
/// - `validated`：伺服器是否實際送引擎驗證；false = 略過（如 MySQL 觸發器、無權限），原因見 `caveat`。
/// - `message` / `line`：`ok=false` 時的引擎錯誤訊息與（可解析時的）行號。
#[derive(Debug, Clone, Serialize)]
pub struct ValidationReport {
    pub ok: bool,
    pub validated: bool,
    pub message: Option<String>,
    pub line: Option<u32>,
    pub caveat: Option<String>,
}

impl ValidationReport {
    /// 驗證通過（引擎接受該語句）。
    pub fn passed() -> Self {
        Self { ok: true, validated: true, message: None, line: None, caveat: None }
    }
    /// 引擎回報語法錯誤。
    pub fn failed(message: String, line: Option<u32>) -> Self {
        Self { ok: false, validated: true, message: Some(message), line, caveat: None }
    }
    /// 無法安全驗證而略過（不阻擋執行；以 caveat 告知使用者原因）。
    pub fn skipped(caveat: String) -> Self {
        Self { ok: true, validated: false, message: None, line: None, caveat: Some(caveat) }
    }
}

/// 欄位定義（「結構」分頁用）。
#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,    // PRI / UNI / MUL / 空
    pub default: Option<String>,
    pub extra: String,  // auto_increment 等
    #[serde(default)]
    pub comment: String, // 欄位註解（MySQL COLUMN_COMMENT；其餘暫為空）
}

/// 整個資料庫「每張表的欄名」批次結果（供 SQL 自動完成一次載入整庫欄位，減少往返）。
#[derive(Debug, Clone, Serialize)]
pub struct TableColumns {
    pub table: String,
    pub columns: Vec<String>,
}

/// 分頁資料結果（「資料」分頁用）。含總列數以渲染分頁器。
#[derive(Debug, Default, Serialize)]
pub struct PagedData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub total_rows: u64,
    pub page: u32,
    pub page_size: u32,
    /// 此表的主鍵欄位名（供前端判斷是否可編輯、組 WHERE 條件用）。
    #[serde(default)]
    pub primary_key: Vec<String>,
    /// 每列主鍵的精確定位值（目前 Mongo 用：_id 的 canonical extended JSON，
    /// 供非 ObjectId/String 型別 _id 正確定位）。與 rows 對齊；其他 driver 為空。
    #[serde(default)]
    pub row_ids: Vec<String>,
}

/// 單一儲存格的更新請求。
///
/// 以主鍵定位列：pk_values 是「主鍵欄位名 → 目前值」的清單。
/// 若該列任一主鍵值為 NULL，視為無法安全定位，後端拒絕更新。
#[derive(Debug, Clone, Deserialize)]
pub struct CellEdit {
    pub column: String,
    pub new_value: Option<String>,
    pub pk_columns: Vec<String>,
    pub pk_values: Vec<Option<String>>,
}

/// 新增列請求：欄位名 → 值。未列出的欄位交由 DB 預設值處理。
#[derive(Debug, Clone, Deserialize)]
pub struct RowInsert {
    pub columns: Vec<String>,
    pub values: Vec<Option<String>>,
}

/// 刪除列請求：以主鍵定位。
#[derive(Debug, Clone, Deserialize)]
pub struct RowDelete {
    pub pk_columns: Vec<String>,
    pub pk_values: Vec<Option<String>>,
}

/// Redis 鍵的詳細內容（鍵值型專屬）。type_ 決定 entries 的語意：
/// - string：entries 為單一 [value]
/// - list：entries 為有序元素 [v0, v1, ...]
/// - set：entries 為成員
/// - zset：entries 為 "member" 與 score 交錯，或見 scores
/// - hash：fields 與 entries 平行（field -> value）
#[derive(Debug, Clone, Serialize)]
pub struct KeyDetail {
    pub key: String,
    pub type_: String,
    pub ttl: i64,
    pub entries: Vec<String>,
    /// hash 用：欄位名（與 entries 對齊）
    #[serde(default)]
    pub fields: Vec<String>,
    /// zset 用：分數（與 entries 對齊）
    #[serde(default)]
    pub scores: Vec<f64>,
}

/// Redis 鍵的單筆結構編輯。`action` 標籤分流到各型別操作。
/// string 值編輯仍走既有 `update_cell`，不在此列。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum KeyEdit {
    /// LSET：以索引就地改 list 元素。
    ListSet { index: i64, value: String },
    /// LPUSH（front=true）/ RPUSH：新增 list 元素。
    ListPush {
        value: String,
        #[serde(default)]
        front: bool,
    },
    /// LREM：依值移除 list 元素（count 預設 1）。
    ListRemove {
        value: String,
        #[serde(default = "one_i64")]
        count: i64,
    },
    /// SADD：新增 set 成員。
    SetAdd { member: String },
    /// SREM：移除 set 成員。
    SetRemove { member: String },
    /// ZADD：新增 / 覆寫 zset 成員分數。
    ZsetAdd { member: String, score: f64 },
    /// ZREM：移除 zset 成員。
    ZsetRemove { member: String },
    /// HSET：新增 / 覆寫 hash 欄位值。
    HashSet { field: String, value: String },
    /// HDEL：移除 hash 欄位。
    HashRemove { field: String },
    /// RENAME：將鍵改名（key 識別變更，非元素編輯）。
    Rename { new_key: String },
}

/// 伺服器狀態：Redis `INFO` 解析後的一個分區（如 Server / Memory / Clients）。
/// items 為該區段的 (欄位, 值) 清單，序列化為 JSON 的二元陣列。
#[derive(Debug, Clone, Serialize)]
pub struct ServerInfoSection {
    pub name: String,
    pub items: Vec<(String, String)>,
}

// ---- MongoDB 專屬 DTO（監控 / 進階索引 / validation；經 mongo_* 專屬命令使用）----

/// $indexStats 單筆：索引名 + 自統計起（重啟即重置）的存取次數。
#[derive(Debug, Clone, Serialize)]
pub struct MongoIndexStat {
    pub name: String,
    pub ops: u64,
    /// 統計起始時間（RFC3339）。
    pub since: String,
    pub host: String,
}

/// 進階索引選項（mongo_create_index 輸入；trait 的 create_index 仍為簡單路徑）。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct MongoIndexOptions {
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub sparse: bool,
    /// 隱藏索引（查詢計畫不用、仍維護；MongoDB 4.4+）。
    #[serde(default)]
    pub hidden: bool,
    /// TTL 秒數（僅單一日期欄位索引有意義；由伺服器驗證）。
    #[serde(default)]
    pub expire_after_secs: Option<u64>,
    /// 部分索引條件（partialFilterExpression，JSON 字串）。
    #[serde(default)]
    pub partial_filter_json: Option<String>,
}

/// 集合驗證規則（validator JSON Schema + level / action）。
#[derive(Debug, Clone, Serialize)]
pub struct MongoValidation {
    /// canonical extended JSON（美化）；空字串＝未設定。
    pub validator_json: String,
    /// off | moderate | strict
    pub level: String,
    /// warn | error
    pub action: String,
}

/// 進行中操作（$currentOp）。opid 用字串以相容 sharded（"shard01:123"）。
#[derive(Debug, Clone, Serialize)]
pub struct MongoOp {
    pub opid: String,
    pub op: String,
    pub ns: String,
    pub secs_running: i64,
    pub client: String,
    pub desc: String,
    /// 指令內容（relaxed extJSON，4KB 截斷）。
    pub command_json: String,
    pub active: bool,
    pub waiting_for_lock: bool,
}

/// Profiler 設定（per-database）。
#[derive(Debug, Clone, Serialize)]
pub struct MongoProfile {
    /// 0=關、1=僅慢查詢、2=全部操作（正式環境慎用）。
    pub level: i32,
    pub slow_ms: i64,
}

/// system.profile 慢查詢摘要。
#[derive(Debug, Clone, Serialize)]
pub struct MongoSlowQuery {
    pub ts: String,
    pub op: String,
    pub ns: String,
    pub millis: i64,
    pub plan_summary: String,
    pub keys_examined: i64,
    pub docs_examined: i64,
    pub nreturned: i64,
    /// 指令內容（relaxed extJSON，4KB 截斷）。
    pub command_json: String,
}

/// 鍵名清單（供鍵樹建構）。純 SCAN 取名，不含 type/ttl。
/// truncated 表示達到 limit 上限、可能仍有更多鍵未回。
#[derive(Debug, Clone, Serialize)]
pub struct RedisKeys {
    pub keys: Vec<String>,
    pub truncated: bool,
}

/// 大型集合型鍵的分頁讀取結果（致敬 Another Redis Desktop Manager 的成員分頁）。
/// hash/set/zset 走游標式 HSCAN/SSCAN/ZSCAN；list 以 cursor 當 LRANGE 視窗起點。
/// cursor==0 表示已掃描完成（無更多）；total 為集合總長（LLEN/HLEN/SCARD/ZCARD），-1 表未知。
#[derive(Debug, Clone, Serialize)]
pub struct KeyPage {
    pub type_: String,
    pub ttl: i64,
    pub total: i64,
    pub cursor: u64,
    /// hash 用：欄位名（與 members 對齊）。
    pub fields: Vec<String>,
    /// list/set/zset：元素 / 成員；hash：值；string：單一值。
    pub members: Vec<String>,
    /// zset 用：分數（與 members 對齊）。
    pub scores: Vec<f64>,
    /// string 用：值的總位元組數（STRLEN）；非 string 為 -1。
    #[serde(default)]
    pub value_bytes: i64,
    /// string 用：members[0] 僅為前段預覽（值超過閾值且未要求完整載入）。
    #[serde(default)]
    pub truncated: bool,
}

/// SLOWLOG GET 單筆（慢查詢日誌）。
#[derive(Debug, Clone, Serialize)]
pub struct SlowLogEntry {
    pub id: i64,
    /// 發生時間（Unix 秒）。
    pub time: i64,
    /// 執行耗時（微秒）。
    pub duration_us: i64,
    pub command: String,
    pub client: String,
    pub client_name: String,
}

/// CLIENT LIST 單筆（用戶端連線）。
#[derive(Debug, Clone, Serialize)]
pub struct ClientInfo {
    pub id: String,
    pub addr: String,
    pub name: String,
    pub age: String,
    pub idle: String,
    pub db: String,
    pub cmd: String,
    pub flags: String,
}

/// 大鍵掃描單筆（SCAN 取樣 + MEMORY USAGE）。
#[derive(Debug, Clone, Serialize)]
pub struct BigKey {
    pub key: String,
    pub type_: String,
    /// 記憶體用量（位元組）；-1 表伺服器未回（如舊版無 MEMORY USAGE）。
    pub bytes: i64,
    pub ttl: i64,
}

/// 欄位資料剖析（致敬 Navicat / DataGrip）：總列數 / 非空 / 相異值數 + 最小 / 最大（範圍）。
/// min / max 為 best-effort：某些型別（如 JSON）不支援 MIN/MAX 時為 None。
#[derive(Debug, Clone, Serialize, Default)]
pub struct ColumnStats {
    pub total: u64,
    pub non_null: u64,
    pub distinct: u64,
    pub min: Option<String>,
    pub max: Option<String>,
    // ---- 以下為 Mongo（無固定 schema）專用；SQL 驅動留 Default（前端以 types 是否為空分流顯示）----
    /// 欄位「不存在」的文件數（與 null 區分：Mongo 文件可整個缺欄位）。
    pub missing: u64,
    /// 值為 BSON null 的文件數。
    pub null_count: u64,
    /// BSON 型別分布（型別名, 文件數），依數量降冪——混型欄位的核心資訊。
    pub types: Vec<(String, u64)>,
    /// Top-10 值與出現次數（值以顯示字串呈現）。
    pub top_values: Vec<(String, u64)>,
    /// distinct 達估算上限（1000），實際相異值數 ≥ 回報值。
    pub distinct_capped: bool,
    /// >0 表示統計基於 $sample 抽樣的文件數（大集合防慢查詢）；0 = 全量統計。
    pub sampled: u64,
}

fn one_i64() -> i64 {
    1
}

/// DDL 結構編輯操作（關聯式專屬）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum AlterOp {
    /// 新增欄位。
    AddColumn {
        name: String,
        #[serde(default)]
        data_type: String,
        #[serde(default)]
        nullable: bool,
        #[serde(default)]
        default: Option<String>,
    },
    /// 刪除欄位。
    DropColumn { name: String },
    /// 改欄位名稱。
    RenameColumn { old: String, new: String },
    /// 改欄位型別 / 可空。
    ModifyColumn {
        name: String,
        data_type: String,
        #[serde(default)]
        nullable: bool,
    },
    /// 設定 / 清除欄位預設值（default = None 表示 DROP DEFAULT）。
    SetDefault {
        name: String,
        #[serde(default)]
        default: Option<String>,
    },
}

/// ER 圖：欄位節點。
#[derive(Debug, Clone, Serialize)]
pub struct ErColumn {
    pub name: String,
    pub data_type: String,
    pub pk: bool,
    pub fk: bool,
}

/// ER 圖：表節點。
#[derive(Debug, Clone, Serialize)]
pub struct ErTable {
    pub name: String,
    pub columns: Vec<ErColumn>,
}

/// ER 圖：外鍵關係（from 表的欄位 → to 表的欄位）。
#[derive(Debug, Clone, Serialize)]
pub struct ErRelation {
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
}

/// ER 圖模型。
#[derive(Debug, Clone, Serialize, Default)]
pub struct ErModel {
    pub tables: Vec<ErTable>,
    pub relations: Vec<ErRelation>,
}

/// 位元組數轉人類可讀（table_info 大小欄共用）。
pub(crate) fn fmt_bytes(b: i64) -> String {
    let f = b as f64;
    if f >= 1_073_741_824.0 {
        format!("{:.2} GB", f / 1_073_741_824.0)
    } else if f >= 1_048_576.0 {
        format!("{:.2} MB", f / 1_048_576.0)
    } else if f >= 1024.0 {
        format!("{:.1} KB", f / 1024.0)
    } else {
        format!("{b} B")
    }
}

/// 從 sqlx 錯誤取出資料庫端訊息（去除 sqlx 外層包裝），供語法驗證回報。各 SQL driver 共用。
pub(crate) fn sqlx_db_message(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(db) => db.message().to_string(),
        other => other.to_string(),
    }
}

/// 由 [from_table, from_col, to_table, to_col] 四欄的列建出關係清單與 FK 欄集合（各 SQL driver 共用）。
pub(crate) fn collect_relations<R>(
    rows: &[R],
    get: impl Fn(&R, usize) -> Option<String>,
) -> (Vec<ErRelation>, std::collections::HashSet<(String, String)>) {
    let mut relations = Vec::new();
    let mut fk_cols = std::collections::HashSet::new();
    for r in rows {
        let ft = get(r, 0).unwrap_or_default();
        let fc = get(r, 1).unwrap_or_default();
        let tt = get(r, 2).unwrap_or_default();
        let tc = get(r, 3).unwrap_or_default();
        if !ft.is_empty() && !tt.is_empty() {
            fk_cols.insert((ft.clone(), fc.clone()));
            relations.push(ErRelation {
                from_table: ft,
                from_column: fc,
                to_table: tt,
                to_column: tc,
            });
        }
    }
    (relations, fk_cols)
}

/// 排序方向。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

/// 單一欄位的篩選條件。運算子限定白名單，值以參數綁定。
#[derive(Debug, Clone, Deserialize)]
pub struct Filter {
    pub column: String,
    /// "=", "!=", ">", ">=", "<", "<=", "like", "is_null", "is_not_null"
    pub op: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// 排序設定。
#[derive(Debug, Clone, Deserialize)]
pub struct Sort {
    pub column: String,
    pub dir: SortDir,
}

/// table_data 的查詢選項（分頁 + 篩選 + 排序）。
#[derive(Debug, Clone, Deserialize)]
pub struct DataQuery {
    pub page: u32,
    pub page_size: u32,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sorts: Vec<Sort>,
    /// 多個篩選條件的連接方式：false = AND（預設）、true = OR。
    #[serde(default)]
    pub match_any: bool,
    /// 是否計算總列數。純翻頁時前端可設 false 沿用前次快取總數，
    /// 避免大表 / Mongo 每翻一頁都重算 count（缺省 true，向後相容舊前端）。
    #[serde(default = "default_true")]
    pub count: bool,
}

fn default_true() -> bool {
    true
}

impl Default for DataQuery {
    fn default() -> Self {
        Self { page: 0, page_size: 0, filters: Vec::new(), sorts: Vec::new(), match_any: false, count: true }
    }
}

/// SQL Search（全資料庫物件搜尋，致敬 Red Gate SQL Search）的單筆命中結果。
/// 不只比對名稱，也比對 view / procedure / function / trigger 的「定義內文」。
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    /// 命中所在的資料庫 / schema（MySQL=db、PG=schema、SQLite="main"、Mongo=db、Redis=db index）。
    pub database: String,
    /// 物件型別：table|view|column|index|procedure|function|trigger|foreign_key|collection|key。
    pub object_type: String,
    /// 物件名稱。
    pub object_name: String,
    /// 所屬資料表 / 集合（column / index / trigger / foreign_key 適用；其餘為 None）。
    pub parent: Option<String>,
    /// 命中位置：name|definition|comment。供前端標示「在哪裡找到」。
    pub matched_in: String,
    /// 定義內文命中時的前後文片段（供前端高亮）；其餘為 None。
    pub snippet: Option<String>,
    /// 補充資訊（如欄位資料型別、PG 函式引數簽章）；純顯示用。
    pub extra: Option<String>,
}

/// SQL Search 選項（前端傳入；serde 欄位與 api.ts 對齊）。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SearchOptions {
    /// 搜尋字串（子字串比對）。
    pub term: String,
    /// 限定資料庫 / schema 清單；None / 空 → 全部（排除系統庫）。
    #[serde(default)]
    pub databases: Option<Vec<String>>,
    /// 限定物件型別；None / 空 → 全部型別。
    #[serde(default)]
    pub types: Option<Vec<String>>,
    /// 比對物件名稱。
    #[serde(default)]
    pub match_names: bool,
    /// 比對定義內文（view / routine / trigger body）。
    #[serde(default)]
    pub match_definitions: bool,
    /// 比對註解。
    #[serde(default)]
    pub match_comments: bool,
    /// 區分大小寫。
    #[serde(default)]
    pub case_sensitive: bool,
    /// 結果上限（每段查詢與整體共用）；None → 預設 500。
    #[serde(default)]
    pub limit: Option<usize>,
    /// 僅比對整個單字（word-boundary；`_` / 數字視為單字字元的一部分）。
    #[serde(default)]
    pub whole_word: bool,
    /// 啟用萬用字元 `*`（任意長度，含空）與 `?`（單一字元）。
    #[serde(default)]
    pub wildcards: bool,
}

impl SearchOptions {
    /// 整體與每段查詢的結果上限（夾在合理範圍）。
    pub fn cap(&self) -> usize {
        self.limit.unwrap_or(500).clamp(1, 5000)
    }

    /// 是否納入此物件型別（types 為 None / 空 → 全納）。
    pub fn wants_type(&self, t: &str) -> bool {
        match &self.types {
            Some(v) if !v.is_empty() => v.iter().any(|x| x == t),
            _ => true,
        }
    }

    /// 文字是否含搜尋詞（依 case_sensitive；以原始 term 比對，不含 LIKE 跳脫）。
    /// 委派 `matches()`；whole_word / wildcards 皆關時等同舊版 `contains` 行為。
    pub fn hit(&self, text: &str) -> bool {
        self.matches(text)
    }

    /// 權威比對器：依 wildcards / whole_word 分派。
    /// - `wildcards && 有 * 或 ?` → 錨定 glob 比對（`*`任意長度、`?`單一字元）
    /// - 否則 `whole_word` → 詞界比對（needle 左右須為非單字字元或字串邊界）
    /// - 否則 → 子字串包含（與舊版 `hit` byte-identical）
    /// 大小寫：!case_sensitive 時兩邊皆轉小寫（與舊版一致；轉小寫不改變字元的單字類別，
    /// 故詞界與 glob 語意不受影響）。
    fn matches(&self, text: &str) -> bool {
        if self.term.is_empty() {
            return false;
        }
        use std::borrow::Cow;
        let (hay, needle) = if self.case_sensitive {
            (Cow::Borrowed(text), Cow::Borrowed(self.term.as_str()))
        } else {
            (Cow::Owned(text.to_lowercase()), Cow::Owned(self.term.to_lowercase()))
        };
        if self.wildcards && has_glob_meta(&self.term) {
            let pattern: Vec<char> = needle.chars().collect();
            let subject: Vec<char> = hay.chars().collect();
            glob_match_anchored(&pattern, &subject)
        } else if self.whole_word {
            whole_word_contains(&hay, &needle)
        } else {
            hay.contains(needle.as_ref())
        }
    }

    /// SQL 粗篩樣式（各 driver 的 LIKE / ILIKE 綁定值）。
    /// - `wildcards && 有 * 或 ?` → 錨定 `glob_to_like`（不加前後 `%`）
    /// - 否則 → `like_contains`（`%…%`，整字模式亦同——仍為 Rust 比對的超集）
    pub(crate) fn like_pattern(&self) -> String {
        if self.wildcards && has_glob_meta(&self.term) {
            glob_to_like(&self.term)
        } else {
            like_contains(&self.term)
        }
    }

    /// 是否完全沒有任何比對範圍被啟用（前端理應至少開一項，後端防呆）。
    pub fn no_scope(&self) -> bool {
        !self.match_names && !self.match_definitions && !self.match_comments
    }
}

/// 把使用者輸入轉成 LIKE 子字串樣式（前後加 `%`），並以反斜線跳脫 LIKE 萬用字元
/// （`\` `%` `_`），使其字面比對。各 driver 的 SQL 需搭配對應的 `ESCAPE '\'`（PG / SQLite）
/// 或 `ESCAPE '\\'`（MySQL 字串字面值）。
pub(crate) fn like_contains(term: &str) -> String {
    let mut s = String::with_capacity(term.len() + 2);
    s.push('%');
    for c in term.chars() {
        if c == '\\' || c == '%' || c == '_' {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}

/// 單字字元判定：英數（Unicode）或底線。用於詞界比對（`_` / 數字視為單字的一部分，
/// 對齊 Redgate SQL Search「非英數為邊界、`_` 為單字字元」的語意）。
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// term 是否含 glob 中介字元（`*` / `?`）。以原始 term 判斷（大小寫不影響）。
fn has_glob_meta(term: &str) -> bool {
    term.contains('*') || term.contains('?')
}

/// 整字比對：needle 必須以「非單字字元 / 字串邊界」為左右界出現於 hay。
/// 空 needle 一律不命中。呼叫端已負責大小寫正規化（兩者皆已轉小寫或皆原樣）。
fn whole_word_contains(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    for (idx, _) in hay.match_indices(needle) {
        let left_ok = hay[..idx].chars().next_back().map_or(true, |c| !is_word_char(c));
        let right_ok = hay[idx + needle.len()..].chars().next().map_or(true, |c| !is_word_char(c));
        if left_ok && right_ok {
            return true;
        }
    }
    false
}

/// 錨定 glob 比對（整個字串須符合）：`*` = 任意長度（含空）、`?` = 剛好一個字元。
/// 以 char slice 運作以支援 Unicode。經典線性回溯法（star / mark 記錄回溯點）。
fn glob_match_anchored(pattern: &[char], text: &[char]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(sp) = star {
            p = sp + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

/// 把使用者 glob 轉成錨定 LIKE 樣式（不加前後 `%`）：`*`→`%`、`?`→`_`，
/// 字面 `% _ \` 以單一反斜線跳脫（與 `like_contains` 的 escape 字元一致，
/// 沿用各 driver 既有的 `ESCAPE '\'` / `ESCAPE '\\'` 子句）。
fn glob_to_like(term: &str) -> String {
    let mut s = String::with_capacity(term.len() + 2);
    for c in term.chars() {
        match c {
            '*' => s.push('%'),
            '?' => s.push('_'),
            '\\' | '%' | '_' => {
                s.push('\\');
                s.push(c);
            }
            _ => s.push(c),
        }
    }
    s
}

/// 由定義內文取命中處的前後文片段（供前端顯示與高亮）。
/// 以 case 模式找出第一個命中位置，截取前後約 60 字的視窗，並把連續空白 / 換行壓成單一空白。
pub(crate) fn make_snippet(text: &str, term: &str, case_sensitive: bool) -> Option<String> {
    if term.is_empty() {
        return None;
    }
    let hay = if case_sensitive { text.to_string() } else { text.to_lowercase() };
    let needle = if case_sensitive { term.to_string() } else { term.to_lowercase() };
    let byte_pos = hay.find(&needle)?;
    let char_pos = hay[..byte_pos].chars().count();
    let chars: Vec<char> = text.chars().collect();
    const WIN: usize = 60;
    let start = char_pos.saturating_sub(WIN);
    let end = (char_pos + needle.chars().count() + WIN).min(chars.len());
    let window: String = chars[start..end].iter().collect();
    let collapsed = window.split_whitespace().collect::<Vec<_>>().join(" ");
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < chars.len() { "…" } else { "" };
    Some(format!("{prefix}{collapsed}{suffix}"))
}

/// 由候選的 (名稱 / 定義 / 註解) 依 name → definition → comment 優先序判定命中位置與片段。
/// 回 None 表示在啟用的比對範圍內均未命中（含 case-sensitive 精修後落空）。
/// 各 driver 共用（自由函式而非閉包，方便在 tokio::join! 的多個並行區段中呼叫）。
pub(crate) fn classify_match(
    opts: &SearchOptions,
    name: &str,
    def: Option<&str>,
    comment: Option<&str>,
) -> Option<(&'static str, Option<String>)> {
    if opts.match_names && opts.hit(name) {
        return Some(("name", None));
    }
    if opts.match_definitions {
        if let Some(d) = def {
            if opts.hit(d) {
                return Some(("definition", make_snippet(d, &opts.term, opts.case_sensitive)));
            }
        }
    }
    if opts.match_comments {
        if let Some(c) = comment {
            if !c.is_empty() && opts.hit(c) {
                return Some(("comment", make_snippet(c, &opts.term, opts.case_sensitive)));
            }
        }
    }
    None
}

/// 物件型別的顯示排序權重（結果分組順序）。
fn search_type_rank(t: &str) -> u8 {
    match t {
        "table" => 0,
        "view" => 1,
        "column" => 2,
        "index" => 3,
        "procedure" => 4,
        "function" => 5,
        "trigger" => 6,
        "foreign_key" => 7,
        "collection" => 8,
        "key" => 9,
        _ => 10,
    }
}

/// matched_in 的優先序（去重時保留較具資訊的命中）。
fn matched_in_rank(m: &str) -> u8 {
    match m {
        "name" => 0,
        "definition" => 1,
        "comment" => 2,
        _ => 3,
    }
}

/// 相關性權重（同型別內排序用，越小越相關）：
/// 名稱完全符合 → 名稱開頭符合 → 名稱包含 → 註解命中 → 僅定義內文命中。
fn relevance_rank(h: &SearchHit, opts: &SearchOptions) -> u8 {
    if h.matched_in != "name" {
        return if h.matched_in == "comment" { 3 } else { 4 };
    }
    let (name, term) = if opts.case_sensitive {
        (h.object_name.clone(), opts.term.clone())
    } else {
        (h.object_name.to_lowercase(), opts.term.to_lowercase())
    };
    if name == term {
        0
    } else if name.starts_with(&term) {
        1
    } else {
        2
    }
}

/// 各 driver 收集完命中後的共用收尾：依 (型別, 資料庫, 所屬, 名稱) 去重（同物件保留
/// 較高優先序的 matched_in），排序，並截斷到整體上限。
pub(crate) fn finalize_hits(hits: Vec<SearchHit>, opts: &SearchOptions) -> Vec<SearchHit> {
    use std::collections::HashMap;
    let mut map: HashMap<(String, String, String, String), SearchHit> = HashMap::new();
    for h in hits {
        let key = (
            h.object_type.clone(),
            h.database.clone(),
            h.parent.clone().unwrap_or_default(),
            h.object_name.clone(),
        );
        match map.get(&key) {
            Some(existing) if matched_in_rank(&existing.matched_in) <= matched_in_rank(&h.matched_in) => {}
            _ => {
                map.insert(key, h);
            }
        }
    }
    let mut out: Vec<SearchHit> = map.into_values().collect();
    // 排序：先依型別分組（呼應前端分組顯示），同型別內依相關性（完全符合 > 開頭 > 含 > 註解 > 定義），
    // 再以資料庫 / 所屬 / 名稱穩定排序。
    out.sort_by(|a, b| {
        search_type_rank(&a.object_type)
            .cmp(&search_type_rank(&b.object_type))
            .then_with(|| relevance_rank(a, opts).cmp(&relevance_rank(b, opts)))
            .then_with(|| a.database.cmp(&b.database))
            .then_with(|| a.parent.cmp(&b.parent))
            .then_with(|| a.object_name.cmp(&b.object_name))
    });
    out.truncate(opts.cap());
    out
}

/// 統一驅動介面。各資料庫實作此 trait，差異吸收在 driver 層。
///
/// 注意：MongoDB / Redis 的 query 介面在 P4 / P5 會擴充專屬方法，
/// 此處先定義關聯式共用的能力。
#[async_trait::async_trait]
pub trait DatabaseDriver: Send + Sync {
    /// 建立連線池並做一次健康檢查。
    async fn connect(config: &ConnectionConfig) -> AppResult<Self>
    where
        Self: Sized;

    /// 健康檢查（殭屍連線偵測）。
    async fn ping(&self) -> AppResult<()>;

    /// 列出資料庫 / schema。
    async fn list_databases(&self) -> AppResult<Vec<String>>;

    /// 列出指定資料庫中的表與視圖（連線樹展開用）。
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>>;

    /// 取得表的欄位定義（「結構」分頁用）。
    async fn table_columns(&self, database: &str, table: &str)
        -> AppResult<Vec<ColumnInfo>>;

    /// 一次載入整個資料庫「所有表的欄名」，供 SQL 自動完成批次補全。
    /// 預設實作：逐表呼叫 table_columns（sequential，個別表失敗略過）。
    /// gateway 型 driver（qland）覆寫為單一分頁 information_schema 查詢，
    /// 大幅減少往返並尊重同帳號查詢併發上限。
    async fn schema_columns(&self, database: &str) -> AppResult<Vec<TableColumns>> {
        let tables = self.list_tables(database).await?;
        let mut out = Vec::with_capacity(tables.len());
        for t in tables {
            let columns = self
                .table_columns(database, &t.name)
                .await
                .map(|cols| cols.into_iter().map(|c| c.name).collect())
                .unwrap_or_default();
            out.push(TableColumns { table: t.name, columns });
        }
        Ok(out)
    }

    /// 分頁讀取表資料（「資料」分頁用），支援篩選與排序。
    async fn table_data(
        &self,
        database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData>;

    /// 執行查詢。
    async fn query(&self, sql: &str) -> AppResult<QueryResult>;

    /// 執行查詢並將結果列數截斷於 cap（0 = 不限）。預設實作退回 query()（不截斷），
    /// 各 driver 漸進覆寫以真正在 fetch 端截斷（守住記憶體 / IPC / 前端渲染量）。
    /// 截斷時設 QueryResult::truncated = true。
    async fn query_capped(&self, sql: &str, _cap: usize) -> AppResult<QueryResult> {
        self.query(sql).await
    }

    /// 執行查詢並回傳「所有」結果集（多語句批次 / 預存程序多結果集）。
    /// 預設實作包一層 query_capped —— 單結果集驅動與外部 Dyn 驅動不覆寫即編譯通過。
    /// 不變量：至少回 1 個元素。cap 對每個結果集「各自」截斷（0 = 不限），截斷者設 truncated。
    async fn query_multi_capped(&self, sql: &str, cap: usize) -> AppResult<Vec<QueryResult>> {
        Ok(vec![self.query_capped(sql, cap).await?])
    }

    /// 更新單一儲存格（寫回 DB）。以主鍵定位列。
    async fn update_cell(
        &self,
        database: &str,
        table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64>;

    /// 新增一列。
    async fn insert_row(
        &self,
        database: &str,
        table: &str,
        row: &RowInsert,
    ) -> AppResult<u64>;

    /// 刪除一列（以主鍵定位）。
    async fn delete_row(
        &self,
        database: &str,
        table: &str,
        del: &RowDelete,
    ) -> AppResult<u64>;

    /// 連線池狀態。
    fn pool_status(&self) -> PoolStatus;

    /// 鍵值型專屬：取得單一鍵的詳細內容。非 Redis 預設回 None。
    async fn key_detail(&self, _database: &str, _key: &str) -> AppResult<Option<KeyDetail>> {
        Ok(None)
    }

    /// 鍵值型專屬：對單一鍵做結構編輯（List/Set/ZSet/Hash 元素增刪改）。
    /// 非鍵值型資料庫預設回 Unsupported。
    async fn key_edit(&self, _database: &str, _key: &str, _edit: &KeyEdit) -> AppResult<u64> {
        Err(AppError::Unsupported(t!("此資料庫不支援鍵結構編輯").into()))
    }

    /// 查詢計畫分析（EXPLAIN）。非關聯式預設 Unsupported。
    async fn explain(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::Unsupported(t!("此資料庫不支援查詢計畫分析").into()))
    }

    /// 資料表統計（引擎 / 列數估計 / 大小 / 排序規則 / 註解…）。回傳 (標籤, 值) 清單，
    /// 各資料庫種類自填可得項目；預設回空（不擋屬性其他區塊）。
    async fn table_info(&self, _database: &str, _table: &str) -> AppResult<Vec<(String, String)>> {
        Ok(vec![])
    }

    /// 列出本表外鍵（含約束名，供刪除）。非關聯式 / SQLite 預設回空。
    async fn list_foreign_keys(&self, _database: &str, _table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        Ok(vec![])
    }

    /// 欄位資料剖析（總數 / 非空 / 相異）。非關聯式預設 Unsupported。
    async fn column_stats(
        &self,
        _database: &str,
        _table: &str,
        _column: &str,
    ) -> AppResult<ColumnStats> {
        Err(AppError::Unsupported(t!("此資料庫不支援欄位統計").into()))
    }

    /// 建立集合（MongoDB）。關聯式 / 其他預設 Unsupported（請改用 CREATE TABLE）。
    async fn create_collection(&self, _database: &str, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported(t!("此資料庫不支援建立集合（請用設計表結構建表）").into()))
    }

    /// 建立資料庫 / schema。MySQL → CREATE DATABASE、PostgreSQL → CREATE SCHEMA、
    /// MongoDB → 以建立首個集合具現化。預設 Unsupported（如 SQLite 為單檔）。
    async fn create_database(&self, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported(t!("此資料庫不支援新增資料庫").into()))
    }

    /// 刪除集合（MongoDB）。關聯式請改用 DROP TABLE。預設 Unsupported。
    async fn drop_collection(&self, _database: &str, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported(t!("此資料庫不支援刪除集合").into()))
    }

    /// 刪除資料庫 / schema。MySQL → DROP DATABASE、PostgreSQL → DROP SCHEMA CASCADE、
    /// MongoDB → Database::drop。SQLite 單檔不支援。
    async fn drop_database(&self, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported(t!("此資料庫不支援刪除資料庫").into()))
    }

    /// 列出資料庫 / schema 內的預存程序 / 函式 / 觸發器。非關聯式預設回空清單。
    async fn list_routines(&self, _database: &str) -> AppResult<Vec<RoutineInfo>> {
        Ok(vec![])
    }

    /// 取得某預存程序 / 函式 / 觸發器的建立 DDL。routine_type ∈ procedure|function|trigger。
    async fn routine_definition(
        &self,
        _database: &str,
        _name: &str,
        _routine_type: &str,
    ) -> AppResult<String> {
        Err(AppError::Unsupported(t!("此資料庫不支援預存程序 / 觸發器").into()))
    }

    /// 全資料庫物件搜尋（SQL Search）。比對名稱 / 定義內文 / 註解，跨所有資料庫 / schema。
    /// 非關聯式預設回 Unsupported（Mongo / Redis 另以名稱層級覆寫）。
    async fn search_objects(&self, _opts: &SearchOptions) -> AppResult<Vec<SearchHit>> {
        Err(AppError::Unsupported(t!("此資料庫不支援物件搜尋").into()))
    }

    /// 執行 DDL（CREATE PROCEDURE / TRIGGER 等編譯語句）。以簡單查詢協定送出整段——
    /// MySQL 的 prepared 協定不支援 CREATE PROCEDURE，且內部 ; 不可被前端切句。SQL 專用。
    async fn exec_ddl(&self, _sql: &str) -> AppResult<()> {
        Err(AppError::Unsupported(t!("此資料庫不支援此操作").into()))
    }

    /// 驗證 DDL 語法而不持久化變更。PG / SQLite 以交易回滾試行；MySQL 以暫存名稱試建後刪除
    /// （觸發器 / 事件無法安全試建，回 skipped）。`database` 供 MySQL 試建時的 schema。
    /// 預設（Mongo / Redis）回 Unsupported。回 Err 代表「無法執行驗證」（連線等問題）；
    /// 語法錯誤本身是成功回傳的 `ValidationReport{ ok: false }`。
    async fn validate_ddl(&self, _database: &str, _sql: &str) -> AppResult<ValidationReport> {
        Err(AppError::Unsupported(t!("此資料庫不支援語法驗證").into()))
    }

    /// 結構編輯（DDL：ALTER TABLE）。非關聯式預設 Unsupported。
    async fn alter_table(&self, _database: &str, _table: &str, _op: &AlterOp) -> AppResult<()> {
        Err(AppError::Unsupported(t!("此資料庫不支援結構編輯").into()))
    }

    /// ER 圖模型（表 + 外鍵關係）。非關聯式預設 Unsupported。
    async fn er_model(&self, _database: &str) -> AppResult<ErModel> {
        Err(AppError::Unsupported(t!("此資料庫不支援 ER 圖").into()))
    }

    /// 取得建表 DDL（MySQL `SHOW CREATE TABLE`、SQLite sqlite_master、PG 以欄位重建）。
    /// 非關聯式預設 Unsupported。
    async fn table_ddl(&self, _database: &str, _table: &str) -> AppResult<String> {
        Err(AppError::Unsupported(t!("此資料庫不支援建表 DDL").into()))
    }

    /// 取得表 / 集合的索引清單。預設回空（不支援的資料庫即顯示「無索引」）。
    async fn table_indexes(&self, _database: &str, _table: &str) -> AppResult<Vec<IndexInfo>> {
        Ok(vec![])
    }

    /// 刪除索引。預設 Unsupported（前端僅對關聯式顯示此操作）。
    async fn drop_index(&self, _database: &str, _table: &str, _index: &str) -> AppResult<()> {
        Err(AppError::Unsupported(t!("此資料庫不支援刪除索引").into()))
    }

    /// 建立索引。預設 Unsupported。
    async fn create_index(
        &self,
        _database: &str,
        _table: &str,
        _name: &str,
        _columns: &[String],
        _unique: bool,
    ) -> AppResult<()> {
        Err(AppError::Unsupported(t!("此資料庫不支援建立索引").into()))
    }

    /// 伺服器狀態（Redis INFO 等）。非鍵值型預設 Unsupported。
    async fn server_info(&self) -> AppResult<Vec<ServerInfoSection>> {
        Err(AppError::Unsupported(t!("此資料庫不支援伺服器狀態").into()))
    }

    /// 鍵值型：列出符合 pattern 的鍵名（純 SCAN，供鍵樹建構）。
    /// limit 為回傳上限。非鍵值型預設 Unsupported。
    async fn scan_keys(
        &self,
        _database: &str,
        _pattern: &str,
        _limit: usize,
    ) -> AppResult<RedisKeys> {
        Err(AppError::Unsupported(t!("此資料庫不支援鍵掃描").into()))
    }

    /// 文件型：以主鍵取回整份文件的 canonical extended JSON（美化）。非文件型預設 Unsupported。
    async fn document_get(&self, _database: &str, _table: &str, _id: &str) -> AppResult<String> {
        Err(AppError::Unsupported(t!("此資料庫不支援文件檢視").into()))
    }

    /// 文件型：以主鍵用整份 extended JSON 文件取代（保真巢狀 / ObjectId / Date 等）。回傳受影響文件數。
    async fn document_replace(
        &self,
        _database: &str,
        _table: &str,
        _id: &str,
        _doc_json: &str,
    ) -> AppResult<u64> {
        Err(AppError::Unsupported(t!("此資料庫不支援文件取代").into()))
    }

    /// 清除此驅動的查詢快取（若有）。預設 no-op；有快取的驅動（如外部 gateway）覆寫，
    /// 供前端「重新整理」強制重抓而非吃快取。
    async fn clear_cache(&self) {}

    /// 優雅關閉：drain 連線池。
    async fn close(&self);
}

/// 允許的篩選運算子白名單 → SQL 片段（不含值，值另以參數綁定）。
/// 回傳 None 表示運算子不被允許。
pub fn filter_op_sql(op: &str) -> Option<&'static str> {
    match op {
        "=" => Some("="),
        "!=" => Some("<>"),
        ">" => Some(">"),
        ">=" => Some(">="),
        "<" => Some("<"),
        "<=" => Some("<="),
        "like" => Some("LIKE"),
        "is_null" => Some("IS NULL"),
        "is_not_null" => Some("IS NOT NULL"),
        _ => None,
    }
}

/// 運算子是否需要綁定值（is_null / is_not_null 不需要）。
pub fn op_needs_value(op: &str) -> bool {
    !matches!(op, "is_null" | "is_not_null")
}

/// 驗證 ADD COLUMN 的型別與預設值。型別 / 預設值在 DDL 中無法參數綁定（只能字串插值），
/// 故阻擋語句終止符與註解以防 DDL 注入（堆疊語句 / 註解），其餘（含 ENUM/DECIMAL 的括號與逗號、
/// 字串字面值、CURRENT_TIMESTAMP 等關鍵字、函式預設值）放行。
/// 註：在「操作者已持有資料庫憑證」的桌面工具模型下，這是縱深防禦兼防止誤植造成的損壞。
pub(crate) fn validate_column_spec(data_type: &str, default: Option<&str>) -> AppResult<()> {
    let dt = data_type.trim();
    if dt.is_empty() {
        return Err(AppError::Query(t!("請指定欄位型別").into()));
    }
    let bad = |s: &str| {
        s.contains(';')
            || s.contains("--")
            || s.contains("/*")
            || s.contains("*/")
            || s.chars().any(|c| c == '\0' || c == '\n' || c == '\r')
    };
    if bad(dt) {
        return Err(AppError::Query(
            t!("欄位型別含不允許的字元（; -- /* 或換行）").into(),
        ));
    }
    if let Some(d) = default {
        if bad(d) {
            return Err(AppError::Query(
                t!("預設值含不允許的字元（; -- /* 或換行）").into(),
            ));
        }
    }
    Ok(())
}

/// 將二進位欄位（BLOB / BYTEA / BINARY）轉成可顯示字串。
/// 若整段為合法 UTF-8 則原樣呈現；否則以 `0x…` 十六進位預覽（上限 64 bytes，
/// 並標註總長度），避免 `from_utf8_lossy` 產生一堆替換字元的雜訊。
pub(crate) fn bytes_to_display(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => {
            const CAP: usize = 64;
            let mut hex = String::with_capacity(2 + CAP * 2 + 16);
            hex.push_str("0x");
            for byte in b.iter().take(CAP) {
                hex.push_str(&format!("{:02x}", byte));
            }
            if b.len() > CAP {
                hex.push_str(&format!("… ({} bytes)", b.len()));
            }
            hex
        }
    }
}

#[cfg(test)]
mod search_match_tests {
    use super::*;

    /// 建一個只設 term / 旗標的 SearchOptions（其餘 Default）。
    fn opts(term: &str, whole_word: bool, wildcards: bool, case_sensitive: bool) -> SearchOptions {
        SearchOptions {
            term: term.into(),
            whole_word,
            wildcards,
            case_sensitive,
            ..Default::default()
        }
    }

    #[test]
    fn plain_contains_is_default_behavior() {
        // 兩旗標關 = 舊 contains 行為（大小寫不敏感）。
        let o = opts("cust", false, false, false);
        assert!(o.hit("customers"));
        assert!(o.hit("cust_id"));
        assert!(o.hit("ACCT_CUST"));
        assert!(!o.hit("client"));
    }

    #[test]
    fn case_sensitive_contains() {
        let o = opts("Cust", false, false, true);
        assert!(o.hit("Customers"));
        assert!(!o.hit("customers"));
    }

    #[test]
    fn whole_word_respects_boundaries() {
        let o = opts("cust", true, false, false);
        assert!(!o.hit("customers")); // 右界為單字字元 → 不命中
        assert!(!o.hit("cust_id")); // `_` 為單字字元 → 不命中
        assert!(!o.hit("mycust")); // 左界為單字字元 → 不命中
        assert!(o.hit("cust")); // 完整字
        assert!(o.hit("cust id")); // 空白為邊界
        assert!(o.hit("cust-id")); // `-` 為邊界
        assert!(o.hit("[cust]")); // 標點為邊界
    }

    #[test]
    fn whole_word_case_insensitive() {
        let o = opts("cust", true, false, false);
        assert!(o.hit("CUST")); // 轉小寫後為完整字
        assert!(!o.hit("CUSTOMERS"));
    }

    #[test]
    fn wildcards_anchored_glob() {
        let star = opts("cust*", false, true, false);
        assert!(star.hit("customers")); // 前綴
        assert!(star.hit("cust")); // `*` 可為空
        assert!(!star.hit("mycust")); // 錨定：非前綴不命中

        let contains = opts("*tomer*", false, true, false);
        assert!(contains.hit("customers"));
        assert!(!contains.hit("client"));

        let q = opts("customer?id", false, true, false);
        assert!(q.hit("customer_id")); // `?` 比中底線
        assert!(q.hit("customerXid"));
        assert!(!q.hit("customerid")); // `?` 須剛好一字元

        let wp = opts("wp_?sers", false, true, false);
        assert!(wp.hit("wp_users"));
        assert!(!wp.hit("wp_sers"));
    }

    #[test]
    fn wildcards_off_treats_meta_literally() {
        // wildcards 關時，`*` / `?` 視為字面字元（走 contains）。
        let o = opts("a*b", false, false, false);
        assert!(o.hit("xa*by"));
        assert!(!o.hit("axxb"));
    }

    #[test]
    fn bare_star_matches_any_nonempty() {
        let o = opts("*", false, true, false);
        assert!(o.hit("anything"));
        assert!(o.hit(""));
    }

    #[test]
    fn wildcards_take_precedence_over_whole_word() {
        // 兩旗標都開：有 meta → glob 勝。
        let glob = opts("cust*", true, true, false);
        assert!(glob.hit("customers"));
        // 無 meta → whole_word 生效。
        let ww = opts("cust", true, true, false);
        assert!(!ww.hit("customers"));
        assert!(ww.hit("cust"));
    }

    #[test]
    fn like_pattern_backward_compatible() {
        // 兩旗標關 → 與 like_contains 完全相同。
        let o = opts("a%b_c", false, false, false);
        assert_eq!(o.like_pattern(), like_contains("a%b_c"));
        // wildcards 開且有 meta → glob_to_like（錨定、不加 %）。
        let g = opts("cust*", false, true, false);
        assert_eq!(g.like_pattern(), "cust%");
        let q = opts("wp_?x", false, true, false);
        assert_eq!(q.like_pattern(), r"wp\__x"); // `_` 跳脫、`?`→`_`
    }

    #[test]
    fn empty_term_never_hits() {
        assert!(!opts("", false, false, false).hit("anything"));
        assert!(!opts("", true, true, false).hit("anything"));
    }

    #[test]
    fn unicode_word_boundary() {
        // 中日文等英數字元不應被錯誤切界。
        let o = opts("金流", true, false, false);
        assert!(o.hit("金流")); // 完整
        assert!(o.hit("[金流]"));
        assert!(!o.hit("金流服務")); // 右界為單字字元
    }
}
