use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub mod mongo;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod sqlite;

/// 資料庫範式。UI 與操作邏輯依此分流。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Mysql,
    Postgres,
    Mongo,
    Redis,
    Sqlite,
}

impl DbKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            DbKind::Mysql => "mysql",
            DbKind::Postgres => "postgres",
            DbKind::Mongo => "mongo",
            DbKind::Redis => "redis",
            DbKind::Sqlite => "sqlite",
        }
    }

    /// 備份檔副檔名（與前端 BackupDialog 的 toolHint 對齊）。
    pub fn backup_ext(&self) -> &'static str {
        match self {
            DbKind::Mysql | DbKind::Postgres => ".sql",
            DbKind::Mongo => ".archive",
            DbKind::Redis => ".rdb",
            DbKind::Sqlite => ".db",
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

/// 預存程序 / 函式 / 觸發器（routine browser 用）。
#[derive(Debug, Clone, Serialize)]
pub struct RoutineInfo {
    pub name: String,
    pub routine_type: String, // "procedure" | "function" | "trigger"
    /// 觸發器所屬資料表（procedure / function 為 None）。PG 刪除觸發器需此資訊。
    pub parent: Option<String>,
    /// PG 函式 / 程序的引數型別簽章（如 "integer, text"），用於消除重載歧義刪除。其餘為 None。
    pub signature: Option<String>,
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

/// 欄位資料剖析（致敬 Navicat / DataGrip）：總列數 / 非空 / 相異值數 + 最小 / 最大（範圍）。
/// min / max 為 best-effort：某些型別（如 JSON）不支援 MIN/MAX 時為 None。
#[derive(Debug, Clone, Serialize, Default)]
pub struct ColumnStats {
    pub total: u64,
    pub non_null: u64,
    pub distinct: u64,
    pub min: Option<String>,
    pub max: Option<String>,
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
#[derive(Debug, Clone, Default, Deserialize)]
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

    /// 分頁讀取表資料（「資料」分頁用），支援篩選與排序。
    async fn table_data(
        &self,
        database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData>;

    /// 執行查詢。
    async fn query(&self, sql: &str) -> AppResult<QueryResult>;

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
        Err(AppError::Unsupported("此資料庫不支援鍵結構編輯".into()))
    }

    /// 查詢計畫分析（EXPLAIN）。非關聯式預設 Unsupported。
    async fn explain(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::Unsupported("此資料庫不支援查詢計畫分析".into()))
    }

    /// 欄位資料剖析（總數 / 非空 / 相異）。非關聯式預設 Unsupported。
    async fn column_stats(
        &self,
        _database: &str,
        _table: &str,
        _column: &str,
    ) -> AppResult<ColumnStats> {
        Err(AppError::Unsupported("此資料庫不支援欄位統計".into()))
    }

    /// 建立集合（MongoDB）。關聯式 / 其他預設 Unsupported（請改用 CREATE TABLE）。
    async fn create_collection(&self, _database: &str, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported("此資料庫不支援建立集合（請用設計表結構建表）".into()))
    }

    /// 建立資料庫 / schema。MySQL → CREATE DATABASE、PostgreSQL → CREATE SCHEMA、
    /// MongoDB → 以建立首個集合具現化。預設 Unsupported（如 SQLite 為單檔）。
    async fn create_database(&self, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported("此資料庫不支援新增資料庫".into()))
    }

    /// 刪除集合（MongoDB）。關聯式請改用 DROP TABLE。預設 Unsupported。
    async fn drop_collection(&self, _database: &str, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported("此資料庫不支援刪除集合".into()))
    }

    /// 刪除資料庫 / schema。MySQL → DROP DATABASE、PostgreSQL → DROP SCHEMA CASCADE、
    /// MongoDB → Database::drop。SQLite 單檔不支援。
    async fn drop_database(&self, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported("此資料庫不支援刪除資料庫".into()))
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
        Err(AppError::Unsupported("此資料庫不支援預存程序 / 觸發器".into()))
    }

    /// 執行 DDL（CREATE PROCEDURE / TRIGGER 等編譯語句）。以簡單查詢協定送出整段——
    /// MySQL 的 prepared 協定不支援 CREATE PROCEDURE，且內部 ; 不可被前端切句。SQL 專用。
    async fn exec_ddl(&self, _sql: &str) -> AppResult<()> {
        Err(AppError::Unsupported("此資料庫不支援此操作".into()))
    }

    /// 結構編輯（DDL：ALTER TABLE）。非關聯式預設 Unsupported。
    async fn alter_table(&self, _database: &str, _table: &str, _op: &AlterOp) -> AppResult<()> {
        Err(AppError::Unsupported("此資料庫不支援結構編輯".into()))
    }

    /// ER 圖模型（表 + 外鍵關係）。非關聯式預設 Unsupported。
    async fn er_model(&self, _database: &str) -> AppResult<ErModel> {
        Err(AppError::Unsupported("此資料庫不支援 ER 圖".into()))
    }

    /// 取得建表 DDL（MySQL `SHOW CREATE TABLE`、SQLite sqlite_master、PG 以欄位重建）。
    /// 非關聯式預設 Unsupported。
    async fn table_ddl(&self, _database: &str, _table: &str) -> AppResult<String> {
        Err(AppError::Unsupported("此資料庫不支援建表 DDL".into()))
    }

    /// 取得表 / 集合的索引清單。預設回空（不支援的資料庫即顯示「無索引」）。
    async fn table_indexes(&self, _database: &str, _table: &str) -> AppResult<Vec<IndexInfo>> {
        Ok(vec![])
    }

    /// 刪除索引。預設 Unsupported（前端僅對關聯式顯示此操作）。
    async fn drop_index(&self, _database: &str, _table: &str, _index: &str) -> AppResult<()> {
        Err(AppError::Unsupported("此資料庫不支援刪除索引".into()))
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
        Err(AppError::Unsupported("此資料庫不支援建立索引".into()))
    }

    /// 伺服器狀態（Redis INFO 等）。非鍵值型預設 Unsupported。
    async fn server_info(&self) -> AppResult<Vec<ServerInfoSection>> {
        Err(AppError::Unsupported("此資料庫不支援伺服器狀態".into()))
    }

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
        return Err(AppError::Query("請指定欄位型別".into()));
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
            "欄位型別含不允許的字元（; -- /* 或換行）".into(),
        ));
    }
    if let Some(d) = default {
        if bad(d) {
            return Err(AppError::Query(
                "預設值含不允許的字元（; -- /* 或換行）".into(),
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
