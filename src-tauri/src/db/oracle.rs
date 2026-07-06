use std::sync::Arc;
use std::time::Duration;

use oracle::pool::{CloseMode, Pool, PoolBuilder};
use oracle::sql_type::OracleType;

use crate::db::{
    bytes_to_display, filter_op_sql, op_needs_value, validate_column_spec, AlterOp, CellEdit, ColumnInfo,
    ColumnStats, ConnectionConfig, DataQuery, DatabaseDriver, ErColumn, ErModel, ErRelation, ErTable, Filter,
    ForeignKeyInfo, IndexInfo, PagedData, PoolStatus, QueryResult, RoutineInfo, RowDelete, RowInsert,
    SearchHit, SearchOptions, Sort, SortDir, TableInfo, ValidationReport,
};
use crate::error::{AppError, AppResult};

/// Oracle 驅動（rust-oracle / ODPI-C）。
///
/// 與其他純 Rust 驅動的差異：
/// - **同步 API**：所有 DB 呼叫以 `spawn_blocking` 移到 blocking thread，不阻塞 tokio runtime。
/// - **執行期原生相依**：需 Oracle Instant Client（oci.dll），於首次連線時 LoadLibrary；
///   不裝也能編譯 / 啟動，只有連 Oracle 時才需要（見 `ensure_client`）。
/// - **schema 對映**：list_databases 回傳 schema（使用者帳號）清單，`database` 參數即 owner —
///   與 PostgreSQL 驅動的 schema 語意一致。
/// - **識別字策略**：exact-case + 全程雙引號 —— 目錄查回什麼就綁什麼、產生 SQL 一律加引號，
///   混大小寫識別字免額外處理（Oracle 未加引號會折成大寫）。
/// - **最低伺服器版本 12c**：分頁用 `OFFSET … ROWS FETCH NEXT … ROWS ONLY`。
pub struct OracleDriver {
    pool: Arc<Pool>,
    /// 登入帳號（大寫 = 預設 schema）；list_databases 保證包含。
    username: String,
}

// ---- Instant Client 偵測 / 初始化（process-wide，一次性）----

/// 成功初始化時使用的 client 目錄（None = 走 PATH）。ODPI-C 初始化為 process-wide，
/// 之後換目錄需重啟——據此在不一致時給明確錯誤而非默默沿用。
static CLIENT_DIR: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);

const CLIENT_DOWNLOAD_URL: &str = "https://www.oracle.com/database/technologies/instant-client/downloads.html";

/// 由 ORACLE_HOME 探測 client 函式庫目錄（Windows: oci.dll；Linux/macOS: libclntsh）。
fn probe_oracle_home() -> Option<String> {
    let home = std::env::var("ORACLE_HOME").ok().filter(|s| !s.trim().is_empty())?;
    let lib = if cfg!(windows) {
        "oci.dll"
    } else if cfg!(target_os = "macos") {
        "libclntsh.dylib"
    } else {
        "libclntsh.so"
    };
    let base = std::path::PathBuf::from(home.trim());
    for cand in [base.clone(), base.join("bin"), base.join("lib")] {
        if cand.join(lib).exists() {
            return Some(cand.to_string_lossy().into_owned());
        }
    }
    None
}

/// 確保 ODPI-C 已以正確的 client 目錄初始化。探測順序：連線 options 的 client_dir >
/// ORACLE_HOME > PATH（不指定目錄）。失敗**不快取**——使用者裝好 client 後重試即可，免重啟。
fn ensure_client(explicit: Option<&str>) -> AppResult<()> {
    let requested = explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(probe_oracle_home);

    let mut used = CLIENT_DIR.lock();
    if oracle::InitParams::is_initialized() {
        // 已初始化：僅在「明確要求了不同目錄」時報錯（process-wide 限制，換目錄需重啟）。
        if let (Some(req), cur) = (&requested, &*used) {
            if cur.as_deref() != Some(req.as_str()) {
                return Err(AppError::Connect(format!(
                    "Oracle client 已以「{}」初始化；變更 client 目錄需重新啟動應用程式",
                    cur.as_deref().unwrap_or("PATH")
                )));
            }
        }
        return Ok(());
    }

    let mut params = oracle::InitParams::new();
    params
        .load_error_url(CLIENT_DOWNLOAD_URL)
        .map_err(|e| AppError::Connect(e.to_string()))?;
    if let Some(dir) = &requested {
        params
            .oracle_client_lib_dir(dir.as_str())
            .map_err(|e| AppError::Connect(format!("client 目錄無效：{e}")))?;
    }
    match params.init() {
        Ok(_) => {
            *used = requested;
            Ok(())
        }
        Err(e) => Err(AppError::Connect(friendly_ora_error(&e))),
    }
}

/// DPI-1047（找不到 client 函式庫 / 架構不符）轉成可行動的繁中訊息；其餘原樣。
fn friendly_ora_error(e: &oracle::Error) -> String {
    let msg = e.to_string();
    if msg.contains("DPI-1047") {
        format!(
            "找不到 Oracle Instant Client（或架構不符，需 64 位元）。\n\
             請安裝 Instant Client Basic / Basic Light 並將其目錄加入 PATH，\
             或在連線設定的「Instant Client 目錄」填入路徑後重試。\n\
             下載：{CLIENT_DOWNLOAD_URL}\n（{msg}）"
        )
    } else {
        msg
    }
}

/// 由連線設定組 connect string。`database` 欄為連線目標（服務名稱 / SID / TNS 別名，非 schema），
/// options.connect_type 決定解讀方式：service（預設，EZConnect）/ sid（完整 descriptor）/ tns（別名）。
fn build_connect_string(cfg: &ConnectionConfig) -> AppResult<String> {
    let target = cfg.database.clone().unwrap_or_default();
    let target = target.trim().to_string();
    if target.is_empty() {
        return Err(AppError::Connect(
            "Oracle 連線需在「資料庫」欄填入服務名稱（Service Name）/ SID / TNS 別名".into(),
        ));
    }
    match cfg.options.get("connect_type").map(String::as_str).unwrap_or("service") {
        // EZConnect 無法表達 SID → 用完整 descriptor（含連線逾時）。
        "sid" => Ok(format!(
            "(DESCRIPTION=(CONNECT_TIMEOUT=10)(ADDRESS=(PROTOCOL=TCP)(HOST={})(PORT={}))(CONNECT_DATA=(SID={})))",
            cfg.host, cfg.port, target
        )),
        // TNS 別名：由 tnsnames.ora 解析（TNS_ADMIN 或 client 目錄下）。
        "tns" => Ok(target),
        _ => Ok(format!("//{}:{}/{}", cfg.host, cfg.port, target)),
    }
}

// ---- 識別字 / 字面值 / 條件組裝（exact-case + 雙引號策略）----

/// 雙引號識別字（內部 `"` 加倍）。一律加引號：目錄查回的 exact-case 名稱原樣可用。
fn q(id: &str) -> String {
    format!("\"{}\"", id.replace('"', "\"\""))
}

fn qualified(owner: &str, table: &str) -> String {
    format!("{}.{}", q(owner), q(table))
}

/// 字串字面值：單引號加倍（Oracle 無反斜線轉義）。
fn lit(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

fn build_where(filters: &[Filter], match_any: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    for f in filters {
        let Some(op) = filter_op_sql(&f.op) else { continue };
        let col = q(&f.column);
        if op_needs_value(&f.op) {
            parts.push(format!("{col} {op} {}", lit(f.value.as_deref().unwrap_or(""))));
        } else {
            parts.push(format!("{col} {op}"));
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(if match_any { " OR " } else { " AND " }))
    }
}

fn build_order(sorts: &[Sort]) -> String {
    if sorts.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = sorts
        .iter()
        .map(|s| format!("{} {}", q(&s.column), match s.dir { SortDir::Asc => "ASC", SortDir::Desc => "DESC" }))
        .collect();
    format!(" ORDER BY {}", parts.join(", "))
}

/// 主鍵定位 WHERE（無主鍵 / 主鍵含 NULL 拒絕，避免影響多列）。
fn pk_where(pk_columns: &[String], pk_values: &[Option<String>]) -> AppResult<String> {
    if pk_columns.is_empty() {
        return Err(AppError::Query("此表無主鍵，拒絕就地編輯（避免影響多列）".into()));
    }
    let mut parts: Vec<String> = Vec::new();
    for (c, v) in pk_columns.iter().zip(pk_values.iter()) {
        match v {
            Some(val) => parts.push(format!("{} = {}", q(c), lit(val))),
            None => return Err(AppError::Query("主鍵值為 NULL，無法安全定位該列".into())),
        }
    }
    Ok(parts.join(" AND "))
}

// ---- 型別轉換 ----

/// 單格顯示上限（位元組）：CLOB 等巨型值截斷（與 mongo 的 CELL_CAP 一致）。
const CELL_CAP: usize = 4096;

fn cap_cell(s: String) -> String {
    if s.len() <= CELL_CAP {
        return s;
    }
    let mut end = CELL_CAP;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let extra = s.len() - end;
    format!("{}…⟪+{extra} bytes⟫", &s[..end])
}

/// SqlValue → 顯示字串。NUMBER 系走 ODPI 的數字→文字轉換（保精度，避免 f64 往返）；
/// 二進位走 bytes_to_display；其餘型別 String 是通用轉換（ODPI-C 可將幾乎所有型別轉文字）。
fn cell_to_string(v: &oracle::SqlValue, otype: &OracleType) -> Option<String> {
    if v.is_null().unwrap_or(true) {
        return None;
    }
    let s = match otype {
        OracleType::BLOB | OracleType::Raw(_) | OracleType::LongRaw | OracleType::BFILE => v
            .get::<Vec<u8>>()
            .map(|b| bytes_to_display(&b))
            .unwrap_or_else(|_| "<unrenderable>".into()),
        // DATE 帶時間成分，統一 "YYYY-MM-DD HH:MM:SS"（避免 NLS_DATE_FORMAT 影響顯示）。
        OracleType::Date => v
            .get::<chrono::NaiveDateTime>()
            .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
            .or_else(|_| v.get::<String>())
            .unwrap_or_else(|_| "<unrenderable>".into()),
        _ => v.get::<String>().unwrap_or_else(|_| "<unrenderable>".into()),
    };
    Some(cap_cell(s))
}

/// 執行 SELECT 並收集為 QueryResult（欄名 + 型別感知的字串格）。
fn rows_to_result_conn(conn: &oracle::Connection, sql: &str) -> AppResult<QueryResult> {
    let rows = conn.query(sql, &[]).map_err(|e| AppError::Query(e.to_string()))?;
    let infos: Vec<(String, OracleType)> = rows
        .column_info()
        .iter()
        .map(|c| (c.name().to_string(), c.oracle_type().clone()))
        .collect();
    let mut out_rows: Vec<Vec<Option<String>>> = Vec::new();
    for r in rows {
        let row = r.map_err(|e| AppError::Query(e.to_string()))?;
        let vals = row.sql_values();
        out_rows.push(
            infos
                .iter()
                .enumerate()
                .map(|(i, (_, t))| vals.get(i).and_then(|v| cell_to_string(v, t)))
                .collect(),
        );
    }
    Ok(QueryResult {
        columns: infos.into_iter().map(|(n, _)| n).collect(),
        rows: out_rows,
        rows_affected: 0,
    })
}

/// 目錄欄位組型別顯示字串（VARCHAR2(50) / NUMBER(10,2) / 裸 NUMBER…）。
fn oracle_type_str(
    dt: &str,
    data_length: Option<i64>,
    char_length: Option<i64>,
    precision: Option<i64>,
    scale: Option<i64>,
) -> String {
    let up = dt.to_uppercase();
    match up.as_str() {
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" | "RAW" => {
            match char_length.filter(|n| *n > 0).or(data_length).filter(|n| *n > 0) {
                Some(n) => format!("{up}({n})"),
                None => up,
            }
        }
        "NUMBER" => match (precision.filter(|p| *p > 0), scale.unwrap_or(0)) {
            (Some(p), s) if s != 0 => format!("NUMBER({p},{s})"),
            (Some(p), _) => format!("NUMBER({p})"),
            _ => "NUMBER".into(),
        },
        // TIMESTAMP(6) / INTERVAL… 目錄已含精度字樣，原樣。
        _ => dt.to_string(),
    }
}

fn starts_ci(s: &str, kw: &str) -> bool {
    s.trim_start().to_ascii_lowercase().starts_with(kw)
}

fn ora_q(e: oracle::Error) -> AppError {
    AppError::Query(e.to_string())
}

impl OracleDriver {
    /// 所有 DB 呼叫的共用入口：blocking thread 上取連線（autocommit on）執行閉包。
    async fn with_conn<T, F>(&self, f: F) -> AppResult<T>
    where
        F: FnOnce(&oracle::Connection) -> AppResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let pool = Arc::clone(&self.pool);
        tokio::task::spawn_blocking(move || {
            let mut conn = pool.get().map_err(|e| AppError::Query(friendly_ora_error(&e)))?;
            // autocommit：單語句工具語意（DML 立即生效；DDL 本就隱式 commit）。
            conn.set_autocommit(true);
            f(&conn)
        })
        .await
        .map_err(|e| AppError::Query(format!("背景執行緒失敗：{e}")))?
    }

    /// 主鍵欄位（依約束位置排序）。
    async fn primary_key(&self, owner: &str, table: &str) -> AppResult<Vec<String>> {
        let owner = owner.to_string();
        let table = table.to_string();
        self.with_conn(move |conn| {
            let rows = conn
                .query(
                    "SELECT cc.column_name FROM all_constraints c \
                     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
                     WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'P' \
                     ORDER BY cc.position",
                    &[&owner, &table],
                )
                .map_err(ora_q)?;
            let mut out = Vec::new();
            for r in rows {
                if let Ok(row) = r {
                    if let Ok(name) = row.get::<usize, String>(0) {
                        out.push(name);
                    }
                }
            }
            Ok(out)
        })
        .await
    }
}

#[async_trait::async_trait]
impl DatabaseDriver for OracleDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let cfg = config.clone();
        let username = cfg.username.to_uppercase();
        // 整段（client init + pool 建立 + 健康檢查）都在 blocking thread；外層 timeout 當保險
        //（EZConnect/descriptor 已各自帶 10s 連線逾時，逾時後 blocking thread 自行結束）。
        let join = tokio::task::spawn_blocking(move || -> AppResult<Pool> {
            ensure_client(cfg.options.get("client_dir").map(String::as_str))?;
            let connect_string = build_connect_string(&cfg)?;
            let pool = PoolBuilder::new(cfg.username.clone(), cfg.password.clone(), connect_string)
                .max_connections(cfg.max_connections.max(1))
                .build()
                .map_err(|e| AppError::Connect(friendly_ora_error(&e)))?;
            let conn = pool.get().map_err(|e| AppError::Connect(friendly_ora_error(&e)))?;
            conn.query_row("SELECT 1 FROM DUAL", &[])
                .map_err(|e| AppError::Connect(e.to_string()))?;
            Ok(pool)
        });
        let pool = match tokio::time::timeout(Duration::from_secs(30), join).await {
            Err(_) => return Err(AppError::Connect("Oracle 連線逾時（30 秒）".into())),
            Ok(Err(e)) => return Err(AppError::Connect(format!("背景執行緒失敗：{e}"))),
            Ok(Ok(r)) => r?,
        };
        Ok(Self { pool: Arc::new(pool), username })
    }

    async fn ping(&self) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.query_row("SELECT 1 FROM DUAL", &[])
                .map(|_| ())
                .map_err(|e| AppError::Connect(e.to_string()))
        })
        .await
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        // Oracle 的「資料庫」＝schema（使用者帳號）。12c+ 以 oracle_maintained 排除系統帳號；
        // 11g 無此欄位（ORA-00904）→ 退回全列（前端 isSystemDatabase 另有大寫系統清單過濾）。
        let me = self.username.clone();
        self.with_conn(move |conn| {
            let rows = conn
                .query(
                    "SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username",
                    &[],
                )
                .or_else(|_| conn.query("SELECT username FROM all_users ORDER BY username", &[]))
                .map_err(ora_q)?;
            let mut out: Vec<String> = Vec::new();
            for r in rows {
                if let Ok(row) = r {
                    if let Ok(name) = row.get::<usize, String>(0) {
                        out.push(name);
                    }
                }
            }
            // 登入 schema 必在清單（權限受限時 all_users 仍看得到自己，此為保險）。
            if !out.contains(&me) {
                out.insert(0, me);
            }
            Ok(out)
        })
        .await
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let owner = database.to_string();
        self.with_conn(move |conn| {
            // BIN$%：回收站（DROP 後未 PURGE）的殘留，不顯示。
            let rows = conn
                .query(
                    "SELECT table_name, 'table' FROM all_tables WHERE owner = :1 AND table_name NOT LIKE 'BIN$%' \
                     UNION ALL \
                     SELECT view_name, 'view' FROM all_views WHERE owner = :1 \
                     ORDER BY 1",
                    &[&owner],
                )
                .map_err(ora_q)?;
            let mut out = Vec::new();
            for r in rows {
                let row = r.map_err(ora_q)?;
                out.push(TableInfo {
                    name: row.get::<usize, String>(0).unwrap_or_default(),
                    kind: row.get::<usize, String>(1).unwrap_or_else(|_| "table".into()),
                });
            }
            Ok(out)
        })
        .await
    }

    async fn table_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let pk = self.primary_key(database, table).await.unwrap_or_default();
        let owner = database.to_string();
        let tbl = table.to_string();
        self.with_conn(move |conn| {
            // identity_column 為 12c+；ORA-00904 時退回不含該欄的查詢。
            // 註：data_default 為 LONG 欄位，rust-oracle 以 String 讀取（超長預設值可能截斷，僅供顯示）。
            let with_identity =
                "SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.data_precision, c.data_scale, \
                        c.nullable, c.data_default, cm.comments, c.identity_column \
                 FROM all_tab_columns c \
                 LEFT JOIN all_col_comments cm ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name \
                 WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id";
            let without_identity =
                "SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.data_precision, c.data_scale, \
                        c.nullable, c.data_default, cm.comments, 'NO' \
                 FROM all_tab_columns c \
                 LEFT JOIN all_col_comments cm ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name \
                 WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id";
            let rows = conn
                .query(with_identity, &[&owner, &tbl])
                .or_else(|_| conn.query(without_identity, &[&owner, &tbl]))
                .map_err(ora_q)?;
            let mut out = Vec::new();
            for r in rows {
                let row = r.map_err(ora_q)?;
                let name: String = row.get::<usize, String>(0).unwrap_or_default();
                let dt: String = row.get::<usize, String>(1).unwrap_or_default();
                let get_i = |i: usize| row.get::<usize, i64>(i).ok();
                let data_type = oracle_type_str(&dt, get_i(2), get_i(3), get_i(4), get_i(5));
                let nullable = row.get::<usize, String>(6).map(|v| v == "Y").unwrap_or(true);
                let default: Option<String> = row.get::<usize, String>(7).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                let comment = row.get::<usize, String>(8).unwrap_or_default();
                let identity = row.get::<usize, String>(9).map(|v| v == "YES").unwrap_or(false);
                let key = if pk.contains(&name) { "PRI" } else { "" };
                out.push(ColumnInfo {
                    name,
                    data_type,
                    nullable,
                    key: key.to_string(),
                    default,
                    extra: if identity { "identity".into() } else { String::new() },
                    comment,
                });
            }
            Ok(out)
        })
        .await
    }

    async fn table_data(&self, database: &str, table: &str, query: &DataQuery) -> AppResult<PagedData> {
        let pk = self.primary_key(database, table).await.unwrap_or_default();
        let owner = database.to_string();
        let tbl = table.to_string();
        let dq = query.clone();
        self.with_conn(move |conn| {
            let target = qualified(&owner, &tbl);
            let where_ = build_where(&dq.filters, dq.match_any);
            let total = if dq.count {
                conn.query_row(&format!("SELECT COUNT(*) FROM {target}{where_}"), &[])
                    .map_err(ora_q)?
                    .get::<usize, i64>(0)
                    .unwrap_or(0)
                    .max(0) as u64
            } else {
                0
            };
            let order = build_order(&dq.sorts);
            let offset = dq.page as u64 * dq.page_size as u64;
            // OFFSET/FETCH：12c+（本驅動的最低支援版本）。Oracle 不要求 ORDER BY 也可用。
            let sql = format!(
                "SELECT * FROM {target}{where_}{order} OFFSET {offset} ROWS FETCH NEXT {} ROWS ONLY",
                dq.page_size
            );
            let res = rows_to_result_conn(conn, &sql)?;
            Ok(PagedData {
                columns: res.columns,
                rows: res.rows,
                total_rows: total,
                page: dq.page,
                page_size: dq.page_size,
                primary_key: pk,
                row_ids: vec![],
            })
        })
        .await
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        // Oracle 對一般 SQL 不接受尾端分號（PL/SQL 區塊除外——那類請走 exec_ddl / RoutinesDialog）。
        let sql = sql.trim().trim_end_matches(';').trim().to_string();
        self.with_conn(move |conn| {
            if starts_ci(&sql, "select") || starts_ci(&sql, "with") {
                rows_to_result_conn(conn, &sql)
            } else {
                let stmt = conn.execute(&sql, &[]).map_err(ora_q)?;
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    rows_affected: stmt.row_count().unwrap_or(0),
                })
            }
        })
        .await
    }

    async fn update_cell(&self, database: &str, table: &str, edit: &CellEdit) -> AppResult<u64> {
        let target = qualified(database, table);
        let set = match &edit.new_value {
            Some(v) => format!("{} = {}", q(&edit.column), lit(v)),
            None => format!("{} = NULL", q(&edit.column)),
        };
        let where_ = pk_where(&edit.pk_columns, &edit.pk_values)?;
        let sql = format!("UPDATE {target} SET {set} WHERE {where_}");
        self.with_conn(move |conn| {
            let stmt = conn.execute(&sql, &[]).map_err(ora_q)?;
            Ok(stmt.row_count().unwrap_or(0))
        })
        .await
    }

    async fn insert_row(&self, database: &str, table: &str, row: &RowInsert) -> AppResult<u64> {
        if row.columns.len() != row.values.len() {
            return Err(AppError::Query("欄位與值數量不符".into()));
        }
        if row.columns.is_empty() {
            return Err(AppError::Query("至少需一個欄位".into()));
        }
        let cols: Vec<String> = row.columns.iter().map(|c| q(c)).collect();
        let vals: Vec<String> = row
            .values
            .iter()
            .map(|v| match v {
                Some(s) => lit(s),
                None => "NULL".into(),
            })
            .collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            qualified(database, table),
            cols.join(", "),
            vals.join(", ")
        );
        self.with_conn(move |conn| {
            let stmt = conn.execute(&sql, &[]).map_err(ora_q)?;
            Ok(stmt.row_count().unwrap_or(0))
        })
        .await
    }

    async fn delete_row(&self, database: &str, table: &str, del: &RowDelete) -> AppResult<u64> {
        let where_ = pk_where(&del.pk_columns, &del.pk_values)?;
        let sql = format!("DELETE FROM {} WHERE {where_}", qualified(database, table));
        self.with_conn(move |conn| {
            let stmt = conn.execute(&sql, &[]).map_err(ora_q)?;
            Ok(stmt.row_count().unwrap_or(0))
        })
        .await
    }

    // ---- 結構 / 洞察（phase 2）----

    async fn table_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        let owner = database.to_string();
        let tbl = table.to_string();
        self.with_conn(move |conn| {
            let rows = conn
                .query(
                    "SELECT i.index_name, ic.column_name, i.uniqueness, \
                            CASE WHEN c.constraint_name IS NULL THEN 0 ELSE 1 END \
                     FROM all_indexes i \
                     JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name \
                     LEFT JOIN all_constraints c ON c.owner = i.table_owner AND c.table_name = i.table_name \
                          AND c.index_name = i.index_name AND c.constraint_type = 'P' \
                     WHERE i.table_owner = :1 AND i.table_name = :2 \
                     ORDER BY i.index_name, ic.column_position",
                    &[&owner, &tbl],
                )
                .map_err(ora_q)?;
            // 逐列聚合（同名索引的欄位串接）。
            let mut out: Vec<IndexInfo> = Vec::new();
            for r in rows {
                let row = r.map_err(ora_q)?;
                let name: String = row.get::<usize, String>(0).unwrap_or_default();
                let col: String = row.get::<usize, String>(1).unwrap_or_default();
                let unique = row.get::<usize, String>(2).map(|u| u == "UNIQUE").unwrap_or(false);
                let primary = row.get::<usize, i64>(3).map(|v| v == 1).unwrap_or(false);
                match out.last_mut() {
                    Some(last) if last.name == name => last.columns.push(col),
                    _ => out.push(IndexInfo { name, columns: vec![col], unique, primary }),
                }
            }
            Ok(out)
        })
        .await
    }

    async fn create_index(
        &self,
        database: &str,
        table: &str,
        name: &str,
        columns: &[String],
        unique: bool,
    ) -> AppResult<()> {
        if columns.is_empty() {
            return Err(AppError::Query("索引至少需一個欄位".into()));
        }
        let cols: Vec<String> = columns.iter().map(|c| q(c)).collect();
        let sql = format!(
            "CREATE {}INDEX {} ON {} ({})",
            if unique { "UNIQUE " } else { "" },
            qualified(database, name),
            qualified(database, table),
            cols.join(", ")
        );
        self.with_conn(move |conn| conn.execute(&sql, &[]).map(|_| ()).map_err(ora_q)).await
    }

    async fn drop_index(&self, database: &str, _table: &str, index: &str) -> AppResult<()> {
        // Oracle DROP INDEX 不帶表名。
        let sql = format!("DROP INDEX {}", qualified(database, index));
        self.with_conn(move |conn| conn.execute(&sql, &[]).map(|_| ()).map_err(ora_q)).await
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        let owner = database.to_string();
        let tbl = table.to_string();
        self.with_conn(move |conn| {
            let rows = conn
                .query(
                    "SELECT c.constraint_name, cc.column_name, rc.table_name, rcc.column_name \
                     FROM all_constraints c \
                     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
                     JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name \
                     JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name \
                          AND rcc.position = cc.position \
                     WHERE c.constraint_type = 'R' AND c.owner = :1 AND c.table_name = :2 \
                     ORDER BY c.constraint_name, cc.position",
                    &[&owner, &tbl],
                )
                .map_err(ora_q)?;
            let mut out = Vec::new();
            for r in rows {
                let row = r.map_err(ora_q)?;
                out.push(ForeignKeyInfo {
                    name: row.get::<usize, String>(0).unwrap_or_default(),
                    column: row.get::<usize, String>(1).unwrap_or_default(),
                    ref_table: row.get::<usize, String>(2).unwrap_or_default(),
                    ref_column: row.get::<usize, String>(3).unwrap_or_default(),
                });
            }
            Ok(out)
        })
        .await
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        let owner = database.to_string();
        let tbl = table.to_string();
        self.with_conn(move |conn| {
            // DBMS_METADATA（需 SELECT_CATALOG_ROLE 或物件擁有者）；表失敗再試視圖。
            let get = |otype: &str| -> Result<String, oracle::Error> {
                conn.query_row(
                    "SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM DUAL",
                    &[&otype, &tbl, &owner],
                )
                .and_then(|row| row.get::<usize, String>(0))
            };
            get("TABLE")
                .or_else(|_| get("VIEW"))
                .map(|s| s.trim().to_string())
                .map_err(|e| AppError::Query(format!("取得 DDL 失敗（需物件擁有者或 SELECT_CATALOG_ROLE）：{e}")))
        })
        .await
    }

    async fn list_routines(&self, database: &str) -> AppResult<Vec<RoutineInfo>> {
        let owner = database.to_string();
        self.with_conn(move |conn| {
            let rows = conn
                .query(
                    "SELECT o.object_name, LOWER(o.object_type), TO_CHAR(o.last_ddl_time, 'YYYY-MM-DD HH24:MI:SS'), \
                            t.table_name \
                     FROM all_objects o \
                     LEFT JOIN all_triggers t ON t.owner = o.owner AND t.trigger_name = o.object_name AND o.object_type = 'TRIGGER' \
                     WHERE o.owner = :1 AND o.object_type IN ('PROCEDURE', 'FUNCTION', 'TRIGGER') \
                     ORDER BY o.object_type, o.object_name",
                    &[&owner],
                )
                .map_err(ora_q)?;
            let mut out = Vec::new();
            for r in rows {
                let row = r.map_err(ora_q)?;
                out.push(RoutineInfo {
                    name: row.get::<usize, String>(0).unwrap_or_default(),
                    routine_type: row.get::<usize, String>(1).unwrap_or_default(),
                    parent: row.get::<usize, String>(3).ok(),
                    signature: None,
                    modified: row.get::<usize, String>(2).ok(),
                    deterministic: None,
                    comment: None,
                });
            }
            Ok(out)
        })
        .await
    }

    async fn routine_definition(
        &self,
        database: &str,
        name: &str,
        routine_type: &str,
    ) -> AppResult<String> {
        let owner = database.to_string();
        let nm = name.to_string();
        let rtype = routine_type.to_uppercase();
        self.with_conn(move |conn| {
            let rows = conn
                .query(
                    "SELECT text FROM all_source WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY line",
                    &[&owner, &nm, &rtype],
                )
                .map_err(ora_q)?;
            let mut body = String::new();
            for r in rows {
                if let Ok(row) = r {
                    if let Ok(line) = row.get::<usize, String>(0) {
                        body.push_str(&line);
                    }
                }
            }
            if body.trim().is_empty() {
                return Err(AppError::Query("找不到原始碼（權限不足或物件不存在）".into()));
            }
            // all_source 內容以 "PROCEDURE name …" 開頭，補 CREATE OR REPLACE 成可執行 DDL。
            Ok(format!("CREATE OR REPLACE {}", body.trim_start()))
        })
        .await
    }

    async fn explain(&self, sql: &str) -> AppResult<QueryResult> {
        let stmt_sql = sql.trim().trim_end_matches(';').trim().to_string();
        if stmt_sql.is_empty() {
            return Err(AppError::Query("沒有可解釋的語句".into()));
        }
        // EXPLAIN PLAN 寫入 session 的 PLAN_TABLE，DBMS_XPLAN.DISPLAY 讀最近一筆——
        // 兩步必須在「同一條連線」（with_conn 的同一閉包）內完成。
        self.with_conn(move |conn| {
            conn.execute(&format!("EXPLAIN PLAN FOR {stmt_sql}"), &[])
                .map_err(ora_q)?;
            // 文字 grid 呈現（比照 MSSQL SHOWPLAN 的結果格慣例，不走 JSON 視覺樹）。
            rows_to_result_conn(conn, "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())")
        })
        .await
    }

    async fn er_model(&self, database: &str) -> AppResult<ErModel> {
        let owner = database.to_string();
        self.with_conn(move |conn| {
            // 三段 owner 級查詢一次組出 ER：欄位、主鍵、外鍵關係。
            let mut tables: Vec<ErTable> = Vec::new();
            {
                let rows = conn
                    .query(
                        "SELECT c.table_name, c.column_name, c.data_type FROM all_tab_columns c \
                         JOIN all_tables t ON t.owner = c.owner AND t.table_name = c.table_name \
                         WHERE c.owner = :1 AND c.table_name NOT LIKE 'BIN$%' \
                         ORDER BY c.table_name, c.column_id",
                        &[&owner],
                    )
                    .map_err(ora_q)?;
                for r in rows {
                    let row = r.map_err(ora_q)?;
                    let tname: String = row.get::<usize, String>(0).unwrap_or_default();
                    let col = ErColumn {
                        name: row.get::<usize, String>(1).unwrap_or_default(),
                        data_type: row.get::<usize, String>(2).unwrap_or_default(),
                        pk: false,
                        fk: false,
                    };
                    match tables.last_mut() {
                        Some(last) if last.name == tname => last.columns.push(col),
                        _ => tables.push(ErTable { name: tname, columns: vec![col] }),
                    }
                }
            }
            // 主鍵標記
            {
                let rows = conn
                    .query(
                        "SELECT c.table_name, cc.column_name FROM all_constraints c \
                         JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
                         WHERE c.owner = :1 AND c.constraint_type = 'P'",
                        &[&owner],
                    )
                    .map_err(ora_q)?;
                for r in rows {
                    let row = r.map_err(ora_q)?;
                    let (t, c): (String, String) = (
                        row.get::<usize, String>(0).unwrap_or_default(),
                        row.get::<usize, String>(1).unwrap_or_default(),
                    );
                    if let Some(tb) = tables.iter_mut().find(|x| x.name == t) {
                        if let Some(col) = tb.columns.iter_mut().find(|x| x.name == c) {
                            col.pk = true;
                        }
                    }
                }
            }
            // 外鍵關係 + fk 標記
            let mut relations: Vec<ErRelation> = Vec::new();
            {
                let rows = conn
                    .query(
                        "SELECT c.table_name, cc.column_name, rc.table_name, rcc.column_name \
                         FROM all_constraints c \
                         JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
                         JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name \
                         JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name \
                              AND rcc.position = cc.position \
                         WHERE c.constraint_type = 'R' AND c.owner = :1",
                        &[&owner],
                    )
                    .map_err(ora_q)?;
                for r in rows {
                    let row = r.map_err(ora_q)?;
                    let rel = ErRelation {
                        from_table: row.get::<usize, String>(0).unwrap_or_default(),
                        from_column: row.get::<usize, String>(1).unwrap_or_default(),
                        to_table: row.get::<usize, String>(2).unwrap_or_default(),
                        to_column: row.get::<usize, String>(3).unwrap_or_default(),
                    };
                    if let Some(tb) = tables.iter_mut().find(|x| x.name == rel.from_table) {
                        if let Some(col) = tb.columns.iter_mut().find(|x| x.name == rel.from_column) {
                            col.fk = true;
                        }
                    }
                    relations.push(rel);
                }
            }
            Ok(ErModel { tables, relations })
        })
        .await
    }

    async fn column_stats(&self, database: &str, table: &str, column: &str) -> AppResult<ColumnStats> {
        let target = qualified(database, table);
        let col = q(column);
        self.with_conn(move |conn| {
            let row = conn
                .query_row(
                    &format!("SELECT COUNT(*), COUNT({col}), COUNT(DISTINCT {col}) FROM {target}"),
                    &[],
                )
                .map_err(ora_q)?;
            let total = row.get::<usize, i64>(0).unwrap_or(0).max(0) as u64;
            let non_null = row.get::<usize, i64>(1).unwrap_or(0).max(0) as u64;
            let distinct = row.get::<usize, i64>(2).unwrap_or(0).max(0) as u64;
            // MIN/MAX best-effort（LOB 等型別不支援聚合 → None）。
            let (min, max) = match conn.query_row(
                &format!("SELECT TO_CHAR(MIN({col})), TO_CHAR(MAX({col})) FROM {target}"),
                &[],
            ) {
                Ok(r) => (r.get::<usize, String>(0).ok(), r.get::<usize, String>(1).ok()),
                Err(_) => (None, None),
            };
            Ok(ColumnStats { total, non_null, distinct, min, max, ..Default::default() })
        })
        .await
    }

    async fn table_info(&self, database: &str, table: &str) -> AppResult<Vec<(String, String)>> {
        let owner = database.to_string();
        let tbl = table.to_string();
        self.with_conn(move |conn| {
            let mut out: Vec<(String, String)> = Vec::new();
            if let Ok(row) = conn.query_row(
                "SELECT num_rows, TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI:SS'), tablespace_name \
                 FROM all_tables WHERE owner = :1 AND table_name = :2",
                &[&owner, &tbl],
            ) {
                if let Ok(n) = row.get::<usize, i64>(0) {
                    out.push(("列數（統計估計）".into(), n.to_string()));
                }
                if let Ok(t) = row.get::<usize, String>(1) {
                    out.push(("統計時間".into(), t));
                }
                if let Ok(ts) = row.get::<usize, String>(2) {
                    out.push(("表空間".into(), ts));
                }
            }
            if let Ok(row) = conn.query_row(
                "SELECT comments FROM all_tab_comments WHERE owner = :1 AND table_name = :2",
                &[&owner, &tbl],
            ) {
                if let Ok(c) = row.get::<usize, String>(0) {
                    if !c.trim().is_empty() {
                        out.push(("註解".into(), c));
                    }
                }
            }
            Ok(out)
        })
        .await
    }

    async fn search_objects(&self, opts: &SearchOptions) -> AppResult<Vec<SearchHit>> {
        if opts.term.is_empty() {
            return Ok(vec![]);
        }
        let opts = opts.clone();
        let default_owner = self.username.clone();
        self.with_conn(move |conn| {
            // 名稱 / 註解在 Rust 端以 opts.hit 比對（與 Mongo 相同策略），避免 SQL 樣式語意分歧；
            // definitions（all_source / all_views 的 LONG）不掃——前端 supportsDefs 未含 oracle。
            let owners: Vec<String> = match &opts.databases {
                Some(list) if !list.is_empty() => list.clone(),
                _ => vec![default_owner],
            };
            let mut hits: Vec<SearchHit> = Vec::new();
            for owner in &owners {
                if opts.match_names {
                    // 表 / 視圖 / routines：all_objects 一次撈。
                    if let Ok(rows) = conn.query(
                        "SELECT object_name, LOWER(object_type) FROM all_objects \
                         WHERE owner = :1 AND object_type IN ('TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'INDEX') \
                         AND object_name NOT LIKE 'BIN$%'",
                        &[owner],
                    ) {
                        for r in rows.flatten() {
                            let name: String = r.get::<usize, String>(0).unwrap_or_default();
                            let otype: String = r.get::<usize, String>(1).unwrap_or_default();
                            if opts.wants_type(&otype) && opts.hit(&name) {
                                hits.push(SearchHit {
                                    database: owner.clone(),
                                    object_type: otype,
                                    object_name: name,
                                    parent: None,
                                    matched_in: "name".into(),
                                    snippet: None,
                                    extra: None,
                                });
                            }
                        }
                    }
                    if opts.wants_type("column") {
                        if let Ok(rows) = conn.query(
                            "SELECT table_name, column_name, data_type FROM all_tab_columns \
                             WHERE owner = :1 AND table_name NOT LIKE 'BIN$%'",
                            &[owner],
                        ) {
                            for r in rows.flatten() {
                                let tname: String = r.get::<usize, String>(0).unwrap_or_default();
                                let cname: String = r.get::<usize, String>(1).unwrap_or_default();
                                if opts.hit(&cname) {
                                    hits.push(SearchHit {
                                        database: owner.clone(),
                                        object_type: "column".into(),
                                        object_name: cname,
                                        parent: Some(tname),
                                        matched_in: "name".into(),
                                        snippet: None,
                                        extra: r.get::<usize, String>(2).ok(),
                                    });
                                }
                            }
                        }
                    }
                }
                if opts.match_comments && (opts.wants_type("table") || opts.wants_type("view")) {
                    if let Ok(rows) = conn.query(
                        "SELECT table_name, comments FROM all_tab_comments \
                         WHERE owner = :1 AND comments IS NOT NULL",
                        &[owner],
                    ) {
                        for r in rows.flatten() {
                            let tname: String = r.get::<usize, String>(0).unwrap_or_default();
                            let comment: String = r.get::<usize, String>(1).unwrap_or_default();
                            if opts.hit(&comment) {
                                hits.push(SearchHit {
                                    database: owner.clone(),
                                    object_type: "table".into(),
                                    object_name: tname,
                                    parent: None,
                                    matched_in: "comment".into(),
                                    snippet: Some(comment),
                                    extra: None,
                                });
                            }
                        }
                    }
                }
            }
            Ok(crate::db::finalize_hits(hits, &opts))
        })
        .await
    }

    async fn exec_ddl(&self, sql: &str) -> AppResult<()> {
        // 整段不切句直接執行（RoutinesDialog 的 CREATE OR REPLACE … END; 內含分號）。
        let sql = sql.trim().to_string();
        self.with_conn(move |conn| conn.execute(&sql, &[]).map(|_| ()).map_err(ora_q)).await
    }

    async fn validate_ddl(&self, _database: &str, _sql: &str) -> AppResult<ValidationReport> {
        // Oracle DDL 隱式 commit，無法以「交易 + rollback」安全試行；DBMS_SQL.PARSE 對 DDL 會直接執行。
        Ok(ValidationReport::skipped("Oracle DDL 隱式提交，無法安全試行驗證；將直接執行".into()))
    }

    async fn alter_table(&self, database: &str, table: &str, op: &AlterOp) -> AppResult<()> {
        let target = qualified(database, table);
        let sql = match op {
            AlterOp::AddColumn { name, data_type, nullable, default } => {
                validate_column_spec(data_type, default.as_deref())?;
                let def = default
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| format!(" DEFAULT {s}"))
                    .unwrap_or_default();
                let nn = if *nullable { "" } else { " NOT NULL" };
                format!("ALTER TABLE {target} ADD ({} {}{def}{nn})", q(name), data_type.trim())
            }
            AlterOp::DropColumn { name } => format!("ALTER TABLE {target} DROP COLUMN {}", q(name)),
            AlterOp::RenameColumn { old, new } => {
                format!("ALTER TABLE {target} RENAME COLUMN {} TO {}", q(old), q(new))
            }
            AlterOp::ModifyColumn { name, data_type, nullable } => {
                validate_column_spec(data_type, None)?;
                // 註：MODIFY 帶 NULL/NOT NULL 時，若目前已是該狀態 Oracle 會報 ORA-01442/01451——
                // 屬引擎語意，原樣呈現即可。
                let nn = if *nullable { " NULL" } else { " NOT NULL" };
                format!("ALTER TABLE {target} MODIFY ({} {}{nn})", q(name), data_type.trim())
            }
            _ => return Err(AppError::Unsupported("Oracle 尚未支援此結構操作".into())),
        };
        self.with_conn(move |conn| conn.execute(&sql, &[]).map(|_| ()).map_err(ora_q)).await
    }

    async fn create_database(&self, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported(
            "Oracle 的資料庫＝schema（使用者帳號）；請由 DBA 以 CREATE USER 管理".into(),
        ))
    }

    async fn drop_database(&self, _name: &str) -> AppResult<()> {
        Err(AppError::Unsupported(
            "Oracle 的 schema 即使用者帳號，請由 DBA 以 DROP USER 管理（本工具不代理此高風險操作）".into(),
        ))
    }

    fn pool_status(&self) -> PoolStatus {
        // ODPI-C 本地屬性讀取（無網路往返），同步呼叫成本可忽略。
        let open = self.pool.open_count().unwrap_or(0);
        let busy = self.pool.busy_count().unwrap_or(0);
        PoolStatus { size: open, idle: open.saturating_sub(busy), in_use: busy }
    }

    async fn close(&self) {
        let pool = Arc::clone(&self.pool);
        // Force：中斷仍在使用的連線，避免 disconnect 卡在忙碌連線上。
        let _ = tokio::task::spawn_blocking(move || pool.close(&CloseMode::Force)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{build_connect_string, build_where, lit, oracle_type_str, pk_where, q};
    use crate::db::{ConnectionConfig, DbKind, Filter};

    fn cfg(database: Option<&str>, connect_type: Option<&str>) -> ConnectionConfig {
        let mut options = std::collections::BTreeMap::new();
        if let Some(ct) = connect_type {
            options.insert("connect_type".to_string(), ct.to_string());
        }
        ConnectionConfig {
            id: "t".into(),
            name: "t".into(),
            kind: DbKind::Oracle,
            host: "db.example".into(),
            port: 1521,
            username: "scott".into(),
            password: "tiger".into(),
            database: database.map(String::from),
            max_connections: 5,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_username: String::new(),
            ssh_auth_method: Default::default(),
            ssh_password: String::new(),
            ssh_private_key_path: String::new(),
            ssh_passphrase: String::new(),
            options,
            otp_secret: String::new(),
        }
    }

    #[test]
    fn connect_string_service_sid_tns() {
        assert_eq!(
            build_connect_string(&cfg(Some("ORCLPDB1"), None)).unwrap(),
            "//db.example:1521/ORCLPDB1"
        );
        let sid = build_connect_string(&cfg(Some("orcl"), Some("sid"))).unwrap();
        assert!(sid.contains("(SID=orcl)") && sid.contains("(HOST=db.example)") && sid.contains("(PORT=1521)"));
        assert_eq!(build_connect_string(&cfg(Some("MYTNS"), Some("tns"))).unwrap(), "MYTNS");
        assert!(build_connect_string(&cfg(None, None)).is_err());
        assert!(build_connect_string(&cfg(Some("  "), None)).is_err());
    }

    #[test]
    fn quoting_and_literals() {
        assert_eq!(q("EMP"), "\"EMP\"");
        assert_eq!(q("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(lit("O'Brien"), "'O''Brien'");
        // Oracle 無反斜線轉義：反斜線原樣保留。
        assert_eq!(lit("a\\b"), "'a\\b'");
    }

    #[test]
    fn type_display() {
        assert_eq!(oracle_type_str("VARCHAR2", Some(50), Some(50), None, None), "VARCHAR2(50)");
        assert_eq!(oracle_type_str("NUMBER", None, None, Some(10), Some(2)), "NUMBER(10,2)");
        assert_eq!(oracle_type_str("NUMBER", None, None, Some(10), Some(0)), "NUMBER(10)");
        assert_eq!(oracle_type_str("NUMBER", None, None, None, None), "NUMBER");
        assert_eq!(oracle_type_str("TIMESTAMP(6)", None, None, None, None), "TIMESTAMP(6)");
    }

    #[test]
    fn pk_where_guards() {
        assert!(pk_where(&[], &[]).is_err()); // 無主鍵
        assert!(pk_where(&["ID".into()], &[None]).is_err()); // 主鍵 NULL
        assert_eq!(
            pk_where(&["ID".into(), "K".into()], &[Some("1".into()), Some("x'y".into())]).unwrap(),
            "\"ID\" = '1' AND \"K\" = 'x''y'"
        );
    }

    #[test]
    fn where_builder() {
        let filters = vec![
            Filter { column: "NAME".into(), op: "like".into(), value: Some("a%".into()) },
            Filter { column: "AGE".into(), op: "is_null".into(), value: None },
        ];
        assert_eq!(build_where(&filters, false), " WHERE \"NAME\" LIKE 'a%' AND \"AGE\" IS NULL");
        assert_eq!(build_where(&filters, true), " WHERE \"NAME\" LIKE 'a%' OR \"AGE\" IS NULL");
        assert_eq!(build_where(&[], false), "");
    }
}
