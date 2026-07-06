use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column, PgPool, Row, TypeInfo, ValueRef};
use std::time::Duration;

use crate::db::{
    classify_match, collect_relations, filter_op_sql, finalize_hits, fmt_bytes, like_contains, make_snippet,
    op_needs_value, sqlx_db_message, AlterOp, CellEdit, ColumnInfo, ColumnStats, ConnectionConfig, DataQuery, DatabaseDriver,
    ErColumn, ErModel, ErTable, Filter, ForeignKeyInfo, IndexInfo, PagedData, PoolStatus, QueryResult, RoutineInfo,
    RowDelete, RowInsert, SearchHit, SearchOptions, Sort, SortDir, TableInfo, ValidationReport,
};
use crate::error::{AppError, AppResult};

/// PostgreSQL 驅動。與 MySQL 共用 sqlx，差異：
/// - 佔位符為 $1, $2…（非 ?）
/// - 識別字以雙引號包裹
/// - schema 概念：list_databases 回傳 schema 清單（public 等）
pub struct PostgresDriver {
    pool: PgPool,
    /// 帶 SET search_path 前綴查詢的 session 連線快取（MRU 一條）：改過 search_path 的連線
    /// 不得回池，但同前綴且 60 秒內用過即重用（免 acquire + SET + 重建連線）。
    /// 異前綴 / 閒置過久 / 查詢出錯 → drop 關閉。close() 時一併清空。
    switched: tokio::sync::Mutex<Option<SwitchedConn>>,
}

/// 已改 search_path（detach 出池）的連線 + 其 SET 語句與最後使用時刻。
struct SwitchedConn {
    set_stmt: String,
    conn: sqlx::postgres::PgConnection,
    last_used: std::time::Instant,
}

#[async_trait::async_trait]
impl DatabaseDriver for PostgresDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let db = config.database.clone().unwrap_or_else(|| "postgres".to_string());
        // typed builder 而非字串內插 URL：密碼含 @ / ? # % 等符號不需 percent-encode。
        // ssl_mode 由 options 帶入（Cargo 已開 sqlx tls-rustls-ring-native-roots）；
        // require 只加密不驗證憑證鏈，verify-ca / verify-full 才驗證（UI 標籤同此語意）。
        let ssl_mode = match config.options.get("ssl_mode").map(String::as_str) {
            Some("disable") => PgSslMode::Disable,
            Some("require") => PgSslMode::Require,
            Some("verify-ca") => PgSslMode::VerifyCa,
            Some("verify-full") => PgSslMode::VerifyFull,
            _ => PgSslMode::Prefer,
        };
        let opts = PgConnectOptions::new()
            .host(&config.host)
            .port(config.port)
            .username(&config.username)
            .password(&config.password)
            .database(&db)
            .ssl_mode(ssl_mode);

        let pool = PgPoolOptions::new()
            .max_connections(config.max_connections)
            .min_connections(0)
            .idle_timeout(Duration::from_secs(300))
            .max_lifetime(Duration::from_secs(1800))
            .acquire_timeout(Duration::from_secs(10))
            // 取得前健康檢查：逾時啟用時一律 ping（髒連線淘汰）；否則僅閒置 ≥60 秒才 ping
            //（比照 mysql.rs — 省掉每次取用的 round-trip）。
            .test_before_acquire(false)
            .before_acquire(|conn, meta| {
                Box::pin(async move {
                    if crate::db::limits::timeout_ms() > 0 || meta.idle_for.as_secs() >= 60 {
                        use sqlx::Connection;
                        return Ok(conn.ping().await.is_ok());
                    }
                    Ok(true)
                })
            })
            // DB 端第一層查詢逾時：新建實體連線時讀當下全域設定（0 = 不設）。
            // 逾時錯誤 57014，連線可續用且伺服器端真的停止執行。設定變更只影響之後
            // 新建的連線；既有連線靠外層 tokio 兜底 + max_lifetime（30 分）自然輪替。
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    let ms = crate::db::limits::timeout_ms();
                    if ms > 0 {
                        sqlx::query(&format!("SET statement_timeout = {ms}"))
                            .execute(&mut *conn)
                            .await?;
                    }
                    Ok(())
                })
            })
            .connect_with(opts)
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;

        let driver = Self { pool, switched: tokio::sync::Mutex::new(None) };
        driver.ping().await?;
        Ok(driver)
    }

    async fn ping(&self) -> AppResult<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Connect(e.to_string()))
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        // PG 以 schema 對應 MySQL 的「資料庫」層級，列出非系統 schema。
        let rows = sqlx::query(
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('pg_catalog','information_schema') \
             AND schema_name NOT LIKE 'pg_%' ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .collect())
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        // database 此處即 schema 名。
        let rows = sqlx::query(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_schema = $1 ORDER BY table_name",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name: String = r.try_get(0).ok()?;
                let ttype: String = r.try_get(1).unwrap_or_default();
                let kind = if ttype.eq_ignore_ascii_case("VIEW") {
                    "view"
                } else {
                    "table"
                };
                Some(TableInfo { name, kind: kind.to_string() })
            })
            .collect())
    }

    async fn table_columns(
        &self,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        // 欄位定義。一併取 is_generated / is_identity / identity_generation，以標示產生欄與
        // GENERATED ALWAYS AS IDENTITY 欄（兩者皆不可由使用者明確賦值；資料產生會據此預設排除）。
        // 註解經 col_description 取得；以 attname 對 join（而非 ordinal_position 對 attnum），
        // 避免表曾 DROP COLUMN 後兩者編號錯位。
        let col_rows = sqlx::query(
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
                    c.is_generated, c.is_identity, c.identity_generation, \
                    col_description(pgc.oid, pga.attnum) \
             FROM information_schema.columns c \
             LEFT JOIN pg_catalog.pg_namespace pgn ON pgn.nspname = c.table_schema \
             LEFT JOIN pg_catalog.pg_class pgc ON pgc.relnamespace = pgn.oid AND pgc.relname = c.table_name \
             LEFT JOIN pg_catalog.pg_attribute pga ON pga.attrelid = pgc.oid AND pga.attname = c.column_name \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;

        // 主鍵欄位集合（標記 key=PRI）
        let pk = self.primary_key(database, table).await?;

        Ok(col_rows
            .iter()
            .map(|r| {
                let name: String = r.try_get(0).unwrap_or_default();
                let key = if pk.contains(&name) { "PRI" } else { "" };
                // extra 以含 "generated" 關鍵字的描述標示產生欄 / 身分欄（前端 isAuto 以此預設排除，
                // 結構檢視也直接顯示）。GENERATED BY DEFAULT AS IDENTITY 可明確賦值，故不標示。
                let is_generated: String = r.try_get(4).unwrap_or_default();
                let is_identity: String = r.try_get(5).unwrap_or_default();
                let identity_gen: String = r.try_get::<Option<String>, _>(6).ok().flatten().unwrap_or_default();
                let extra = if is_generated.eq_ignore_ascii_case("ALWAYS") {
                    "generated stored".to_string()
                } else if is_identity.eq_ignore_ascii_case("YES") && identity_gen.eq_ignore_ascii_case("ALWAYS") {
                    "generated always as identity".to_string()
                } else {
                    String::new()
                };
                ColumnInfo {
                    name: name.clone(),
                    data_type: r.try_get(1).unwrap_or_default(),
                    nullable: r
                        .try_get::<String, _>(2)
                        .map(|v| v.eq_ignore_ascii_case("YES"))
                        .unwrap_or(false),
                    key: key.to_string(),
                    default: r.try_get(3).ok(),
                    extra,
                    comment: r.try_get::<Option<String>, _>(7).ok().flatten().unwrap_or_default(),
                }
            })
            .collect())
    }

    async fn table_data(
        &self,
        database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        let q_tbl = format!("{}.{}", quote_ident(database), quote_ident(table));
        let offset = query.page.saturating_mul(query.page_size);
        let page_size = query.page_size;

        // 只有當篩選含排序運算子（>,>=,<,<=）時，才需欄位型別來決定是否做原生轉型比較；
        // 其餘情況省下這次 information_schema 查詢（避免每次翻頁都多打一次 metadata）。
        let col_types = if query.filters.iter().any(|f| is_ordering_op(&f.op)) {
            self.column_type_map(database, table).await.unwrap_or_default()
        } else {
            std::collections::HashMap::new()
        };

        // PG 用 $N；從 $1 起編號。
        let (where_sql, bind_values) = build_where(&query.filters, 1, query.match_any, &col_types)?;
        let order_sql = build_order(&query.sorts);

        // 純翻頁時前端傳 count=false 直接略過 COUNT（沿用前次快取），比照 mssql / mongo。
        let total: i64 = if query.count {
            let count_sql = format!("SELECT COUNT(*) FROM {q_tbl}{where_sql}");
            let mut cq = sqlx::query_scalar::<_, i64>(&count_sql);
            for v in &bind_values {
                cq = cq.bind(v.clone());
            }
            cq.fetch_one(&self.pool)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?
        } else {
            0
        };

        let data_sql = format!(
            "SELECT * FROM {q_tbl}{where_sql}{order_sql} LIMIT {page_size} OFFSET {offset}"
        );
        let mut dq = sqlx::query(&data_sql);
        for v in &bind_values {
            dq = dq.bind(v.clone());
        }
        let rows = dq
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;

        let result = rows_to_result(&rows);
        Ok(PagedData {
            columns: result.columns,
            rows: result.rows,
            total_rows: total as u64,
            page: query.page,
            page_size,
            primary_key: self.primary_key(database, table).await?,
            row_ids: Vec::new(),
        })
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        self.query_capped(sql, 0).await
    }

    async fn query_capped(&self, sql: &str, cap: usize) -> AppResult<QueryResult> {
        // 「目前資料庫」選擇器會在語句前帶入 `SET search_path TO "x";`。search_path 是 session 層級
        // 狀態，若與後續查詢落在 pool 的不同連線上會失效。偵測到開頭 SET search_path 時，取「同一條」
        // 連線先 SET 再執行剩餘語句；該連線改過 search_path 後不放回 pool（detach 後 drop），避免污染其他查詢。
        if let Some((set_stmt, rest)) = split_leading_set_search_path(sql) {
            // 先嘗試重用快取連線（同 SET 語句、60 秒內用過）；否則棄舊建新（比照 mysql.rs 切庫快取）。
            let cached = {
                let mut cache = self.switched.lock().await;
                match cache.take() {
                    Some(sc)
                        if sc.set_stmt == set_stmt
                            && sc.last_used.elapsed() < Duration::from_secs(60) =>
                    {
                        Some(sc.conn)
                    }
                    _ => None, // 異前綴 / 過期的快取連線在此 drop 關閉
                }
            };
            let mut conn: sqlx::postgres::PgConnection = match cached {
                Some(c) => c,
                None => {
                    let pooled = self
                        .pool
                        .acquire()
                        .await
                        .map_err(|e| AppError::Query(e.to_string()))?;
                    // 立刻 detach 出池：改過 search_path 的連線不得回池。
                    let mut owned = pooled.detach();
                    sqlx::query(&set_stmt)
                        .execute(&mut owned)
                        .await
                        .map_err(|e| AppError::Query(e.to_string()))?;
                    owned
                }
            };
            let t = rest.trim_start().to_ascii_lowercase();
            let is_read = t.starts_with("select")
                || t.starts_with("show")
                || t.starts_with("explain")
                || t.starts_with("table")
                || t.starts_with("with")
                || t.contains("returning");
            let out = if is_read {
                fetch_rows_capped(&mut conn, &rest, cap)
                    .await
                    .map(|(rows, truncated)| {
                        let mut r = rows_to_result(&rows);
                        r.truncated = truncated;
                        r
                    })
            } else {
                sqlx::query(&rest)
                    .execute(&mut conn)
                    .await
                    .map(|res| QueryResult { columns: vec![], rows: vec![], rows_affected: res.rows_affected(), truncated: false })
                    .map_err(|e| AppError::Query(e.to_string()))
            };
            if out.is_ok() {
                // 成功 → 放回快取供同前綴下一查詢重用。
                *self.switched.lock().await = Some(SwitchedConn {
                    set_stmt,
                    conn,
                    last_used: std::time::Instant::now(),
                });
            } // 失敗 → conn 在此 drop（狀態不明，不快取）
            return out;
        }

        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_read = trimmed.starts_with("select")
            || trimmed.starts_with("show")
            || trimmed.starts_with("explain")
            || trimmed.starts_with("table")
            || trimmed.starts_with("with");

        // 寫入語句若帶 RETURNING（PG 支援），改走 fetch 取回回傳列（致敬 DataGrip / DBeaver
        // 顯示 RETURNING 結果）；無 RETURNING 則 execute 取 rows_affected。
        if is_read || trimmed.contains("returning") {
            let (rows, truncated) = fetch_rows_capped(&self.pool, sql, cap).await?;
            let mut result = rows_to_result(&rows);
            result.truncated = truncated;
            Ok(result)
        } else {
            let res = sqlx::query(sql)
                .execute(&self.pool)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: res.rows_affected(),
                truncated: false,
            })
        }
    }

    async fn update_cell(
        &self,
        database: &str,
        table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64> {
        if edit.pk_columns.is_empty() {
            return Err(AppError::Query("此表無主鍵，無法安全更新".to_string()));
        }
        if edit.pk_columns.len() != edit.pk_values.len() {
            return Err(AppError::Query("主鍵欄位與值數量不符".to_string()));
        }
        if edit.pk_values.iter().any(|v| v.is_none()) {
            return Err(AppError::Query("主鍵值為 NULL，無法定位該列".to_string()));
        }

        let q_tbl = format!("{}.{}", quote_ident(database), quote_ident(table));
        let q_col = quote_ident(&edit.column);

        // 新值轉成目標欄位型別（嚴格型別：text 不會隱式轉 int / uuid / bool…）。
        let udt = self.column_udt_map(database, table).await.unwrap_or_default();
        let set_ph = bind_placeholder(1, &edit.column, &udt);

        // PG 用 $1, $2… 佔位符。$1 為新值，主鍵從 $2 起。
        // 主鍵比對把欄位轉 text（pk::text = $n）：等值比較正確，且不需逐型別轉換，
        // 整數 / UUID 等主鍵也能定位（否則 integer = text 報錯，無法更新該列）。
        let where_clause = edit
            .pk_columns
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{}::text = ${}", quote_ident(c), i + 2))
            .collect::<Vec<_>>()
            .join(" AND ");

        let sql = format!("UPDATE {q_tbl} SET {q_col} = {set_ph} WHERE {where_clause}");
        let mut q = sqlx::query(&sql).bind(edit.new_value.clone());
        for v in &edit.pk_values {
            q = q.bind(v.clone());
        }
        let res = q
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(res.rows_affected())
    }

    async fn insert_row(
        &self,
        database: &str,
        table: &str,
        row: &RowInsert,
    ) -> AppResult<u64> {
        if row.columns.is_empty() {
            return Err(AppError::Query("未提供任何欄位".to_string()));
        }
        if row.columns.len() != row.values.len() {
            return Err(AppError::Query("欄位與值數量不符".to_string()));
        }
        let q_tbl = format!("{}.{}", quote_ident(database), quote_ident(table));
        let cols = row
            .columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        // 把 text 參數轉成各欄位的實際型別（嚴格型別不會把 text 隱式轉成 int / uuid / bool…）。
        let udt = self.column_udt_map(database, table).await.unwrap_or_default();
        let placeholders = row
            .columns
            .iter()
            .enumerate()
            .map(|(i, c)| bind_placeholder(i + 1, c, &udt))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("INSERT INTO {q_tbl} ({cols}) VALUES ({placeholders})");
        let mut q = sqlx::query(&sql);
        for v in &row.values {
            q = q.bind(v.clone());
        }
        let res = q
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(res.rows_affected())
    }

    async fn delete_row(
        &self,
        database: &str,
        table: &str,
        del: &RowDelete,
    ) -> AppResult<u64> {
        if del.pk_columns.is_empty() {
            return Err(AppError::Query("此表無主鍵，無法安全刪除".to_string()));
        }
        if del.pk_columns.len() != del.pk_values.len() {
            return Err(AppError::Query("主鍵欄位與值數量不符".to_string()));
        }
        if del.pk_values.iter().any(|v| v.is_none()) {
            return Err(AppError::Query("主鍵值為 NULL，無法定位該列".to_string()));
        }
        let q_tbl = format!("{}.{}", quote_ident(database), quote_ident(table));
        // 主鍵比對把欄位轉 text（pk::text = $n），整數 / UUID 等主鍵亦可定位
        // （否則 integer = text 報錯，無法刪除該列）。
        let where_clause = del
            .pk_columns
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{}::text = ${}", quote_ident(c), i + 1))
            .collect::<Vec<_>>()
            .join(" AND ");
        let sql = format!("DELETE FROM {q_tbl} WHERE {where_clause}");
        let mut q = sqlx::query(&sql);
        for v in &del.pk_values {
            q = q.bind(v.clone());
        }
        let res = q
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(res.rows_affected())
    }

    fn pool_status(&self) -> PoolStatus {
        let size = self.pool.size();
        let idle = self.pool.num_idle() as u32;
        PoolStatus {
            size,
            idle,
            in_use: size.saturating_sub(idle),
        }
    }

    async fn explain(&self, sql: &str) -> AppResult<QueryResult> {
        let rows = sqlx::query(&format!("EXPLAIN {sql}"))
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows_to_result(&rows))
    }

    async fn column_stats(&self, database: &str, table: &str, column: &str) -> AppResult<ColumnStats> {
        let qt = format!("{}.{}", quote_ident(database), quote_ident(table));
        let qc = quote_ident(column);
        let sql = format!("SELECT COUNT(*), COUNT({qc}), COUNT(DISTINCT {qc}) FROM {qt}");
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        // 範圍（best-effort）：MIN/MAX 對某些型別（如 json）可能報錯，失敗則略過。
        let (min, max) = match sqlx::query(&format!("SELECT MIN({qc}), MAX({qc}) FROM {qt}"))
            .fetch_one(&self.pool)
            .await
        {
            Ok(r) => (cell_to_string(&r, 0), cell_to_string(&r, 1)),
            Err(_) => (None, None),
        };
        Ok(ColumnStats {
            total: row.try_get::<i64, _>(0).unwrap_or(0) as u64,
            non_null: row.try_get::<i64, _>(1).unwrap_or(0) as u64,
            distinct: row.try_get::<i64, _>(2).unwrap_or(0) as u64,
            min,
            max,
            ..Default::default()
        })
    }

    async fn create_database(&self, name: &str) -> AppResult<()> {
        // PG 連線樹列出 schema；「新增資料庫」對應 CREATE SCHEMA（在目前連線的資料庫內）。
        let sql = format!("CREATE SCHEMA {}", quote_ident(name));
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn drop_database(&self, name: &str) -> AppResult<()> {
        // 後端硬性護欄：系統 schema 一律拒絕（pg_* 與 information_schema）。
        // public 為使用者預設工作 schema，前端以 type-to-confirm 加強確認，此處不硬擋（容許刻意刪除重建）。
        if name.starts_with("pg_") || name.eq_ignore_ascii_case("information_schema") {
            return Err(AppError::Query(format!("拒絕刪除 PostgreSQL 系統 schema「{name}」")));
        }
        // PG「刪除資料庫」對應 DROP SCHEMA … CASCADE（連帶其表 / 物件）。
        let sql = format!("DROP SCHEMA {} CASCADE", quote_ident(name));
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn list_routines(&self, database: &str) -> AppResult<Vec<RoutineInfo>> {
        let mut out = Vec::new();
        // 函式 / 程序（pg_proc.prokind：f=function、p=procedure；需 PG 11+）。
        // 取 identity arguments 以消除重載歧義（刪除指定重載需完整簽章）。
        let rows = sqlx::query(
            "SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, \
             pg_get_function_identity_arguments(p.oid) \
             FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid \
             WHERE n.nspname = $1 AND p.prokind IN ('f','p') ORDER BY p.proname",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        for r in &rows {
            if let (Ok(name), Ok(rt)) = (r.try_get::<String, _>(0), r.try_get::<String, _>(1)) {
                let sig = r.try_get::<String, _>(2).ok();
                out.push(RoutineInfo { name, routine_type: rt, parent: None, signature: sig, modified: None, deterministic: None, comment: None });
            }
        }
        // 觸發器（排除內部 tgisinternal）；附所屬資料表（刪除觸發器需要）。
        let trows = sqlx::query(
            "SELECT t.tgname, c.relname FROM pg_trigger t \
             JOIN pg_class c ON t.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid \
             WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        for r in &trows {
            if let Ok(name) = r.try_get::<String, _>(0) {
                out.push(RoutineInfo { name, routine_type: "trigger".into(), parent: r.try_get::<String, _>(1).ok(), signature: None, modified: None, deterministic: None, comment: None });
            }
        }
        Ok(out)
    }

    async fn routine_definition(&self, database: &str, name: &str, routine_type: &str) -> AppResult<String> {
        // 重載函式以 LIMIT 1 取其一（MVP）。
        let sql = if routine_type == "trigger" {
            "SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t \
             JOIN pg_class c ON t.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid \
             WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal LIMIT 1"
        } else {
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
             JOIN pg_namespace n ON p.pronamespace = n.oid \
             WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1"
        };
        let row = sqlx::query(sql)
            .bind(database)
            .bind(name)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        match row {
            Some(r) => r.try_get::<String, _>(0).map_err(|e| AppError::Query(e.to_string())),
            None => Err(AppError::Query(format!("找不到「{name}」的定義"))),
        }
    }

    async fn search_objects(&self, opts: &SearchOptions) -> AppResult<Vec<SearchHit>> {
        if opts.term.is_empty() || opts.no_scope() {
            return Ok(vec![]);
        }
        let pattern = like_contains(&opts.term);
        let limit = format!(" LIMIT {}", opts.cap());

        // 各物件型別查詢彼此獨立，改以 tokio::join! 並行送出（共用連線池，最多 max_connections 條同時），
        // 縮短大型 schema / 全庫搜尋延遲。停用的型別 / 比對範圍回空 Vec；命中分類共用 classify_match。

        // 1. 資料表 / 視圖（名稱 + 註解，經 pg_class / obj_description）。
        let tables = async {
            let mut out: Vec<SearchHit> = Vec::new();
            if opts.wants_type("table") || opts.wants_type("view") {
                let mut cols: Vec<&str> = Vec::new();
                if opts.match_names {
                    cols.push("c.relname");
                }
                if opts.match_comments {
                    cols.push("obj_description(c.oid)");
                }
                if !cols.is_empty() {
                    let mut idx = 1usize;
                    let (sf, sb) = pg_schema_filter("n.nspname", &opts.databases, &mut idx);
                    let like = pg_like_or(&cols, &mut idx);
                    let sql = format!(
                        "SELECT n.nspname, c.relname, c.relkind, obj_description(c.oid) \
                         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                         WHERE c.relkind IN ('r','p','v','m'){sf} AND {like}{limit}"
                    );
                    for r in self.run_search(&sql, &sb, &pattern, cols.len()).await? {
                        let relkind: String = r.try_get(2).unwrap_or_default();
                        let otype = if relkind == "v" || relkind == "m" { "view" } else { "table" };
                        if !opts.wants_type(otype) {
                            continue;
                        }
                        let name: String = r.try_get(1).unwrap_or_default();
                        let comment = r.try_get::<Option<String>, _>(3).ok().flatten().unwrap_or_default();
                        let (m, snip) = match classify_match(opts, &name, None, Some(&comment)) {
                            Some(v) => v,
                            None => continue,
                        };
                        out.push(SearchHit {
                            database: r.try_get(0).unwrap_or_default(),
                            object_type: otype.into(),
                            object_name: name,
                            parent: None,
                            matched_in: m.into(),
                            snippet: snip,
                            extra: None,
                        });
                    }
                }
            }
            Ok::<_, AppError>(out)
        };

        // 2. 視圖定義內文（pg_get_viewdef）。
        let views_def = async {
            let mut out: Vec<SearchHit> = Vec::new();
            if opts.match_definitions && opts.wants_type("view") {
                let mut idx = 1usize;
                let (sf, sb) = pg_schema_filter("n.nspname", &opts.databases, &mut idx);
                let like = pg_like_or(&["pg_get_viewdef(c.oid)"], &mut idx);
                let sql = format!(
                    "SELECT n.nspname, c.relname, pg_get_viewdef(c.oid) \
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE c.relkind IN ('v','m'){sf} AND {like}{limit}"
                );
                for r in self.run_search(&sql, &sb, &pattern, 1).await? {
                    let def: String = r.try_get(2).unwrap_or_default();
                    if !opts.hit(&def) {
                        continue;
                    }
                    out.push(SearchHit {
                        database: r.try_get(0).unwrap_or_default(),
                        object_type: "view".into(),
                        object_name: r.try_get(1).unwrap_or_default(),
                        parent: None,
                        matched_in: "definition".into(),
                        snippet: make_snippet(&def, &opts.term, opts.case_sensitive),
                        extra: None,
                    });
                }
            }
            Ok::<_, AppError>(out)
        };

        // 3. 欄位（名稱 + 註解；資料型別放 extra）。
        let columns = async {
            let mut out: Vec<SearchHit> = Vec::new();
            if opts.wants_type("column") {
                let mut cols: Vec<&str> = Vec::new();
                if opts.match_names {
                    cols.push("a.attname");
                }
                if opts.match_comments {
                    cols.push("col_description(c.oid, a.attnum)");
                }
                if !cols.is_empty() {
                    let mut idx = 1usize;
                    let (sf, sb) = pg_schema_filter("n.nspname", &opts.databases, &mut idx);
                    let like = pg_like_or(&cols, &mut idx);
                    let sql = format!(
                        "SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), \
                                col_description(c.oid, a.attnum) \
                         FROM pg_attribute a \
                         JOIN pg_class c ON c.oid = a.attrelid \
                         JOIN pg_namespace n ON n.oid = c.relnamespace \
                         WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m'){sf} \
                           AND {like}{limit}"
                    );
                    for r in self.run_search(&sql, &sb, &pattern, cols.len()).await? {
                        let name: String = r.try_get(2).unwrap_or_default();
                        let comment = r.try_get::<Option<String>, _>(4).ok().flatten().unwrap_or_default();
                        let (m, snip) = match classify_match(opts, &name, None, Some(&comment)) {
                            Some(v) => v,
                            None => continue,
                        };
                        let ctype: String = r.try_get(3).unwrap_or_default();
                        out.push(SearchHit {
                            database: r.try_get(0).unwrap_or_default(),
                            object_type: "column".into(),
                            object_name: name,
                            parent: r.try_get(1).ok(),
                            matched_in: m.into(),
                            snippet: snip,
                            extra: if ctype.is_empty() { None } else { Some(ctype) },
                        });
                    }
                }
            }
            Ok::<_, AppError>(out)
        };

        // 4. 函式 / 程序（名稱 + 定義內文 + 註解；引數簽章放 extra）。
        let routines = async {
            let mut out: Vec<SearchHit> = Vec::new();
            if opts.wants_type("procedure") || opts.wants_type("function") {
                let mut cols: Vec<&str> = Vec::new();
                if opts.match_names {
                    cols.push("p.proname");
                }
                if opts.match_definitions {
                    cols.push("pg_get_functiondef(p.oid)");
                }
                if opts.match_comments {
                    cols.push("obj_description(p.oid)");
                }
                if !cols.is_empty() {
                    let mut idx = 1usize;
                    let (sf, sb) = pg_schema_filter("n.nspname", &opts.databases, &mut idx);
                    let like = pg_like_or(&cols, &mut idx);
                    let sql = format!(
                        "SELECT n.nspname, p.proname, \
                                CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, \
                                pg_get_functiondef(p.oid), obj_description(p.oid), \
                                pg_get_function_identity_arguments(p.oid) \
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                         WHERE p.prokind IN ('f','p'){sf} AND {like}{limit}"
                    );
                    for r in self.run_search(&sql, &sb, &pattern, cols.len()).await? {
                        let rtype: String = r.try_get(2).unwrap_or_default();
                        if !opts.wants_type(&rtype) {
                            continue;
                        }
                        let name: String = r.try_get(1).unwrap_or_default();
                        let def = r.try_get::<Option<String>, _>(3).ok().flatten();
                        let comment = r.try_get::<Option<String>, _>(4).ok().flatten();
                        let (m, snip) = match classify_match(opts, &name, def.as_deref(), comment.as_deref()) {
                            Some(v) => v,
                            None => continue,
                        };
                        let sig = r.try_get::<Option<String>, _>(5).ok().flatten().filter(|s| !s.is_empty());
                        out.push(SearchHit {
                            database: r.try_get(0).unwrap_or_default(),
                            object_type: rtype,
                            object_name: name,
                            parent: None,
                            matched_in: m.into(),
                            snippet: snip,
                            extra: sig,
                        });
                    }
                }
            }
            Ok::<_, AppError>(out)
        };

        // 5. 觸發器（名稱 + 定義內文）。
        let triggers = async {
            let mut out: Vec<SearchHit> = Vec::new();
            if opts.wants_type("trigger") {
                let mut cols: Vec<&str> = Vec::new();
                if opts.match_names {
                    cols.push("t.tgname");
                }
                if opts.match_definitions {
                    cols.push("pg_get_triggerdef(t.oid)");
                }
                if !cols.is_empty() {
                    let mut idx = 1usize;
                    let (sf, sb) = pg_schema_filter("n.nspname", &opts.databases, &mut idx);
                    let like = pg_like_or(&cols, &mut idx);
                    let sql = format!(
                        "SELECT n.nspname, t.tgname, c.relname, pg_get_triggerdef(t.oid) \
                         FROM pg_trigger t \
                         JOIN pg_class c ON c.oid = t.tgrelid \
                         JOIN pg_namespace n ON n.oid = c.relnamespace \
                         WHERE NOT t.tgisinternal{sf} AND {like}{limit}"
                    );
                    for r in self.run_search(&sql, &sb, &pattern, cols.len()).await? {
                        let name: String = r.try_get(1).unwrap_or_default();
                        let def = r.try_get::<Option<String>, _>(3).ok().flatten();
                        let (m, snip) = match classify_match(opts, &name, def.as_deref(), None) {
                            Some(v) => v,
                            None => continue,
                        };
                        out.push(SearchHit {
                            database: r.try_get(0).unwrap_or_default(),
                            object_type: "trigger".into(),
                            object_name: name,
                            parent: r.try_get(2).ok(),
                            matched_in: m.into(),
                            snippet: snip,
                            extra: None,
                        });
                    }
                }
            }
            Ok::<_, AppError>(out)
        };

        // 6. 索引（僅名稱）。
        let indexes = async {
            let mut out: Vec<SearchHit> = Vec::new();
            if opts.wants_type("index") && opts.match_names {
                let mut idx = 1usize;
                let (sf, sb) = pg_schema_filter("schemaname", &opts.databases, &mut idx);
                let like = pg_like_or(&["indexname"], &mut idx);
                let sql = format!(
                    "SELECT schemaname, tablename, indexname FROM pg_indexes \
                     WHERE true{sf} AND {like}{limit}"
                );
                for r in self.run_search(&sql, &sb, &pattern, 1).await? {
                    let name: String = r.try_get(2).unwrap_or_default();
                    if !opts.hit(&name) {
                        continue;
                    }
                    out.push(SearchHit {
                        database: r.try_get(0).unwrap_or_default(),
                        object_type: "index".into(),
                        object_name: name,
                        parent: r.try_get(1).ok(),
                        matched_in: "name".into(),
                        snippet: None,
                        extra: None,
                    });
                }
            }
            Ok::<_, AppError>(out)
        };

        // 7. 外鍵（僅名稱）。
        let fks = async {
            let mut out: Vec<SearchHit> = Vec::new();
            if opts.wants_type("foreign_key") && opts.match_names {
                let mut idx = 1usize;
                let (sf, sb) = pg_schema_filter("tc.table_schema", &opts.databases, &mut idx);
                let like = pg_like_or(&["tc.constraint_name"], &mut idx);
                let sql = format!(
                    "SELECT tc.table_schema, tc.table_name, tc.constraint_name \
                     FROM information_schema.table_constraints tc \
                     WHERE tc.constraint_type = 'FOREIGN KEY'{sf} AND {like}{limit}"
                );
                for r in self.run_search(&sql, &sb, &pattern, 1).await? {
                    let name: String = r.try_get(2).unwrap_or_default();
                    if !opts.hit(&name) {
                        continue;
                    }
                    out.push(SearchHit {
                        database: r.try_get(0).unwrap_or_default(),
                        object_type: "foreign_key".into(),
                        object_name: name,
                        parent: r.try_get(1).ok(),
                        matched_in: "name".into(),
                        snippet: None,
                        extra: None,
                    });
                }
            }
            Ok::<_, AppError>(out)
        };

        // 並行送出全部區段查詢（tokio::join! 在同一 task 內並行 poll，無需 Send）。
        let (r1, r2, r3, r4, r5, r6, r7) =
            tokio::join!(tables, views_def, columns, routines, triggers, indexes, fks);
        let mut hits: Vec<SearchHit> = Vec::new();
        for r in [r1, r2, r3, r4, r5, r6, r7] {
            hits.extend(r?);
        }
        Ok(finalize_hits(hits, opts))
    }

    async fn exec_ddl(&self, sql: &str) -> AppResult<()> {
        // 簡單查詢協定：可靠處理 CREATE FUNCTION/TRIGGER（含 $$ dollar-quoting 內部 ;）。
        use sqlx::Executor;
        self.pool
            .execute(sql)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn validate_ddl(&self, _database: &str, sql: &str) -> AppResult<ValidationReport> {
        // PostgreSQL 的 DDL 具交易性：在交易內試行 CREATE（plpgsql 程序體在建立時即做語法檢查），
        // 再一律 ROLLBACK 丟棄。固定於同一連線（begin 取得後綁定），避免簡單協定散落到不同連線。
        use sqlx::Executor;
        let mut tx = self.pool.begin().await.map_err(|e| AppError::Query(e.to_string()))?;
        let res = (&mut *tx).execute(sql).await;
        let _ = tx.rollback().await; // 不論成敗都回滾，不留任何物件
        match res {
            Ok(_) => Ok(ValidationReport::passed()),
            // PG 訊息常含 "at or near \"…\""；位置（行號）需另解析 protocol position，MVP 先以訊息為主。
            Err(e) => Ok(ValidationReport::failed(sqlx_db_message(&e), None)),
        }
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        // 單欄外鍵情境正確；複合外鍵的 column/ref_column 配對為近似（MVP）。
        let rows = sqlx::query(
            "SELECT tc.constraint_name, kcu.column_name, ccu.table_name, ccu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
             JOIN information_schema.constraint_column_usage ccu \
               ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema \
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2 \
             ORDER BY tc.constraint_name",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                Some(ForeignKeyInfo {
                    name: r.try_get::<String, _>(0).ok()?,
                    column: r.try_get::<String, _>(1).ok()?,
                    ref_table: r.try_get::<String, _>(2).ok()?,
                    ref_column: r.try_get::<String, _>(3).ok()?,
                })
            })
            .collect())
    }

    async fn table_info(&self, database: &str, table: &str) -> AppResult<Vec<(String, String)>> {
        let row = sqlx::query(
            "SELECT c.reltuples::bigint, pg_total_relation_size(c.oid), pg_relation_size(c.oid), \
             pg_indexes_size(c.oid), obj_description(c.oid) \
             FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid \
             WHERE n.nspname = $1 AND c.relname = $2",
        )
        .bind(database)
        .bind(table)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out = Vec::new();
        if let Some(r) = row {
            if let Ok(rows) = r.try_get::<i64, _>(0) {
                if rows >= 0 {
                    out.push(("列數（估計）".into(), rows.to_string()));
                }
            }
            if let Ok(sz) = r.try_get::<i64, _>(1) {
                out.push(("總大小".into(), fmt_bytes(sz)));
            }
            if let Ok(sz) = r.try_get::<i64, _>(2) {
                out.push(("資料大小".into(), fmt_bytes(sz)));
            }
            if let Ok(sz) = r.try_get::<i64, _>(3) {
                out.push(("索引大小".into(), fmt_bytes(sz)));
            }
            if let Ok(Some(c)) = r.try_get::<Option<String>, _>(4) {
                if !c.is_empty() {
                    out.push(("註解".into(), c));
                }
            }
        }
        Ok(out)
    }

    async fn alter_table(&self, database: &str, table: &str, op: &AlterOp) -> AppResult<()> {
        let q_tbl = format!("{}.{}", quote_ident(database), quote_ident(table));
        let ddl = match op {
            AlterOp::AddColumn { name, data_type, nullable, default } => {
                crate::db::validate_column_spec(data_type, default.as_deref())?;
                let nn = if *nullable { "" } else { " NOT NULL" };
                let def = default.as_ref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default();
                format!("ALTER TABLE {q_tbl} ADD COLUMN {} {data_type}{nn}{def}", quote_ident(name))
            }
            AlterOp::DropColumn { name } => {
                format!("ALTER TABLE {q_tbl} DROP COLUMN {}", quote_ident(name))
            }
            AlterOp::RenameColumn { old, new } => format!(
                "ALTER TABLE {q_tbl} RENAME COLUMN {} TO {}",
                quote_ident(old),
                quote_ident(new)
            ),
            AlterOp::ModifyColumn { name, data_type, nullable } => {
                crate::db::validate_column_spec(data_type, None)?;
                // PG 型別轉換需 USING 轉型；一條 ALTER TABLE 內逗號串多個 ALTER COLUMN（型別 + 可空）。
                let qc = quote_ident(name);
                let null_clause = if *nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                format!(
                    "ALTER TABLE {q_tbl} ALTER COLUMN {qc} TYPE {data_type} USING {qc}::{data_type}, ALTER COLUMN {qc} {null_clause}"
                )
            }
            AlterOp::SetDefault { name, default } => match default {
                Some(v) => {
                    crate::db::validate_column_spec("x", Some(v))?;
                    format!("ALTER TABLE {q_tbl} ALTER COLUMN {} SET DEFAULT {v}", quote_ident(name))
                }
                None => format!("ALTER TABLE {q_tbl} ALTER COLUMN {} DROP DEFAULT", quote_ident(name)),
            },
        };
        sqlx::query(&ddl)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(())
    }

    async fn er_model(&self, database: &str) -> AppResult<ErModel> {
        let fk_rows = sqlx::query(
            "SELECT tc.table_name, kcu.column_name, ccu.table_name, ccu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
             JOIN information_schema.constraint_column_usage ccu \
               ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema \
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        let (relations, fk_cols) =
            collect_relations(&fk_rows, |r, i| r.try_get::<String, _>(i).ok());
        let mut tables = Vec::new();
        for t in self.list_tables(database).await? {
            let cols = self.table_columns(database, &t.name).await?;
            let er_cols = cols
                .into_iter()
                .map(|c| ErColumn {
                    pk: c.key == "PRI",
                    fk: fk_cols.contains(&(t.name.clone(), c.name.clone())),
                    name: c.name,
                    data_type: c.data_type,
                })
                .collect();
            tables.push(ErTable { name: t.name, columns: er_cols });
        }
        Ok(ErModel { tables, relations })
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        // PG 無 SHOW CREATE TABLE；以 information_schema 欄位 + 主鍵重建（盡力而為，
        // 不含索引 / 外鍵 / 約束等進階定義）。
        let cols = self.table_columns(database, table).await?;
        if cols.is_empty() {
            return Err(AppError::Query("找不到該表的欄位".into()));
        }
        let pk = self.primary_key(database, table).await?;
        let mut lines: Vec<String> = cols
            .iter()
            .map(|c| {
                let nn = if c.nullable { "" } else { " NOT NULL" };
                let def = c
                    .default
                    .as_ref()
                    .map(|d| format!(" DEFAULT {d}"))
                    .unwrap_or_default();
                format!("    {} {}{}{}", quote_ident(&c.name), c.data_type, nn, def)
            })
            .collect();
        if !pk.is_empty() {
            let pk_cols = pk.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
            lines.push(format!("    PRIMARY KEY ({pk_cols})"));
        }
        let q_tbl = format!("{}.{}", quote_ident(database), quote_ident(table));
        Ok(format!("CREATE TABLE {q_tbl} (\n{}\n);", lines.join(",\n")))
    }

    async fn table_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        let rows = sqlx::query(
            "SELECT i.relname AS index_name, a.attname AS column_name, \
                    ix.indisunique, ix.indisprimary, \
                    array_position(ix.indkey::int2[], a.attnum) AS ord \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey::int2[]) \
             WHERE n.nspname = $1 AND t.relname = $2 \
             ORDER BY i.relname, ord",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out: Vec<IndexInfo> = Vec::new();
        for r in &rows {
            let name: String = r.try_get(0).unwrap_or_default();
            let col: String = r.try_get(1).unwrap_or_default();
            let unique: bool = r.try_get(2).unwrap_or(false);
            let primary: bool = r.try_get(3).unwrap_or(false);
            if let Some(ix) = out.iter_mut().find(|x| x.name == name) {
                ix.columns.push(col);
            } else {
                out.push(IndexInfo { name, columns: vec![col], unique, primary });
            }
        }
        Ok(out)
    }

    async fn drop_index(&self, database: &str, _table: &str, index: &str) -> AppResult<()> {
        // PG 索引位於 schema 命名空間（database 此處即 schema）。
        let sql = format!("DROP INDEX {}.{}", quote_ident(database), quote_ident(index));
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
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
            return Err(AppError::Query("請至少選擇一個欄位".into()));
        }
        let cols = columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        let uniq = if unique { "UNIQUE " } else { "" };
        let sql = format!(
            "CREATE {uniq}INDEX {} ON {}.{} ({cols})",
            quote_ident(name),
            quote_ident(database),
            quote_ident(table)
        );
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn close(&self) {
        // 先丟棄快取的 search_path 連線（detach 出池的連線不歸 pool 管，需自行釋放）。
        *self.switched.lock().await = None;
        self.pool.close().await;
    }
}

impl PostgresDriver {
    /// SQL Search 共用：執行一段已組好的搜尋查詢。
    /// 綁定順序為「schema 過濾值」（$1…）在前、LIKE 樣式（重複 like_count 次）在後，
    /// 對應 SQL 中 `$n` 的編號順序（schema filter 先佔號，like_or 接續）。
    async fn run_search(
        &self,
        sql: &str,
        schema_binds: &[String],
        pattern: &str,
        like_count: usize,
    ) -> AppResult<Vec<PgRow>> {
        let mut q = sqlx::query(sql);
        for b in schema_binds {
            q = q.bind(b.clone());
        }
        for _ in 0..like_count {
            q = q.bind(pattern);
        }
        q.fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn primary_key(&self, schema: &str, table: &str) -> AppResult<Vec<String>> {
        // 以 to_regclass 安全解析 schema.table（傳完整限定名字串）。
        let qualified = format!("{}.{}", quote_ident(schema), quote_ident(table));
        let sql = "SELECT a.attname \
                   FROM pg_index i \
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
                   WHERE i.indrelid = to_regclass($1) AND i.indisprimary \
                   ORDER BY array_position(i.indkey, a.attnum)";
        let rows = sqlx::query(sql)
            .bind(qualified)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .collect())
    }

    /// 欄位名（小寫）→ information_schema data_type。供 build_where 決定排序運算子是否做原生轉型。
    /// 輕量查詢（不含主鍵 join），僅在篩選含排序運算子時呼叫。
    async fn column_type_map(
        &self,
        schema: &str,
        table: &str,
    ) -> AppResult<std::collections::HashMap<String, String>> {
        let rows = sqlx::query(
            "SELECT column_name, data_type FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let n: String = r.try_get(0).ok()?;
                let t: String = r.try_get(1).ok()?;
                Some((n.to_ascii_lowercase(), t))
            })
            .collect())
    }

    /// 欄位名（小寫）→ `udt_name`（底層型別名，如 int4 / uuid / jsonb / timestamptz / _int4）。
    /// 供寫入路徑（INSERT VALUES / UPDATE SET）把 text 參數轉成欄位型別——PostgreSQL 嚴格型別
    /// 不會把 text 隱式轉成 int / uuid / bool 等，否則 `column "id" is of type integer but
    /// expression is of type text`，導致非文字欄位無法插入 / 更新。
    async fn column_udt_map(
        &self,
        schema: &str,
        table: &str,
    ) -> AppResult<std::collections::HashMap<String, String>> {
        let rows = sqlx::query(
            "SELECT column_name, udt_name FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let n: String = r.try_get(0).ok()?;
                let t: String = r.try_get(1).ok()?;
                Some((n.to_ascii_lowercase(), t))
            })
            .collect())
    }
}

/// 由 `udt_name` 組出安全的型別轉換後綴（`$1::<cast>`）。只允許識別字字元
/// （字母 / 數字 / 底線），避免把異常型別名拼進 SQL；不合法則回 None（退回純 text 綁定）。
fn pg_cast_suffix(udt: &str) -> Option<String> {
    if !udt.is_empty() && udt.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        Some(udt.to_string())
    } else {
        None
    }
}

/// 寫入路徑用：`${idx}` 或（已知欄位型別時）`${idx}::<udt>`。
fn bind_placeholder(
    idx: usize,
    column: &str,
    udt_map: &std::collections::HashMap<String, String>,
) -> String {
    match udt_map.get(&column.to_ascii_lowercase()).and_then(|u| pg_cast_suffix(u)) {
        Some(cast) => format!("${idx}::{cast}"),
        None => format!("${idx}"),
    }
}

/// PG 識別字以雙引號包裹，轉義內部雙引號。
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// SQL Search：建構 schema 過濾子句與綁定值，並推進 `$n` 編號。
/// 指定 databases → `AND {col} IN ($n, …)`（值另以參數綁定）；否則排除系統 schema。
fn pg_schema_filter(col: &str, dbs: &Option<Vec<String>>, idx: &mut usize) -> (String, Vec<String>) {
    match dbs {
        Some(list) if !list.is_empty() => {
            let phs: Vec<String> = list
                .iter()
                .map(|_| {
                    let p = format!("${idx}");
                    *idx += 1;
                    p
                })
                .collect();
            (format!(" AND {col} IN ({})", phs.join(", ")), list.clone())
        }
        _ => (
            format!(" AND {col} NOT IN ('pg_catalog','information_schema') AND {col} NOT LIKE 'pg_%'"),
            Vec::new(),
        ),
    }
}

/// SQL Search：由欄位 / 運算式清單組 ILIKE-OR 片段（case-insensitive），並推進 `$n` 編號。
/// PG 標準字串中單一反斜線即 `'\'`，故 ESCAPE 子句為 `ESCAPE '\'`。
fn pg_like_or(cols: &[&str], idx: &mut usize) -> String {
    let parts: Vec<String> = cols
        .iter()
        .map(|c| {
            let p = format!("{c} ILIKE ${idx} ESCAPE '\\'");
            *idx += 1;
            p
        })
        .collect();
    format!("({})", parts.join(" OR "))
}

/// 排序運算子（其字典序行為對數值 / 時間欄位不正確）。
fn is_ordering_op(op: &str) -> bool {
    matches!(op, ">" | ">=" | "<" | "<=")
}

/// information_schema 的 data_type → 可安全 `::cast` 的 PG 內部型別名（單字、無空白）。
/// 僅涵蓋「以 text 比較會出錯」的數值 / 時間型別；其餘（text / json / uuid / bytea / enum…）
/// 回 None，沿用 `col::text` 比較（等值 / LIKE / 文字排序皆正確）。
fn pg_native_cast(data_type: &str) -> Option<&'static str> {
    match data_type.to_ascii_lowercase().as_str() {
        "smallint" => Some("int2"),
        "integer" => Some("int4"),
        "bigint" => Some("int8"),
        "numeric" | "decimal" => Some("numeric"),
        "real" => Some("float4"),
        "double precision" => Some("float8"),
        "date" => Some("date"),
        "timestamp without time zone" => Some("timestamp"),
        "timestamp with time zone" => Some("timestamptz"),
        "time without time zone" => Some("time"),
        "time with time zone" => Some("timetz"),
        _ => None,
    }
}

fn build_where(
    filters: &[Filter],
    start_idx: usize,
    match_any: bool,
    col_types: &std::collections::HashMap<String, String>,
) -> AppResult<(String, Vec<Option<String>>)> {
    if filters.is_empty() {
        return Ok((String::new(), vec![]));
    }
    let mut clauses = Vec::new();
    let mut binds = Vec::new();
    let mut idx = start_idx;
    for f in filters {
        let op = filter_op_sql(&f.op)
            .ok_or_else(|| AppError::Query(format!("不支援的運算子：{}", f.op)))?;
        let col = quote_ident(&f.column);
        if op_needs_value(&f.op) {
            // 值一律以 text 綁定，但 PostgreSQL 嚴格型別不會把 text 隱式轉成
            // int / numeric / bool / date 等做比較（會報 operator does not exist:
            // integer = text）。預設將欄位轉 text 後比較，使任意型別的篩選都可運作。
            //
            // 但 >,>=,<,<= 以 text 比較會變字典序（'10' < '2'），對數值 / 時間欄位是錯的。
            // 故當運算子為排序類、且欄位為已知數值 / 時間型別時，改為把「參數」轉成該型別
            // 做原生比較（仍走參數化綁定，無注入風險）；型別不明或非數值/時間 → 退回 text 比較。
            let native = if is_ordering_op(&f.op) {
                col_types.get(&f.column.to_ascii_lowercase()).and_then(|t| pg_native_cast(t))
            } else {
                None
            };
            match native {
                Some(cast) => clauses.push(format!("{col} {op} ${idx}::{cast}")),
                None => clauses.push(format!("{col}::text {op} ${idx}")),
            }
            binds.push(f.value.clone());
            idx += 1;
        } else {
            clauses.push(format!("{col} {op}"));
        }
    }
    let connector = if match_any { " OR " } else { " AND " };
    Ok((format!(" WHERE {}", clauses.join(connector)), binds))
}

fn build_order(sorts: &[Sort]) -> String {
    if sorts.is_empty() {
        return String::new();
    }
    let parts = sorts
        .iter()
        .map(|s| {
            let dir = match s.dir {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            };
            format!("{} {}", quote_ident(&s.column), dir)
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(" ORDER BY {parts}")
}

/// 偵測並切出開頭的 `SET search_path TO ...;`（「目前資料庫」選擇器帶入）。回傳 (SET 語句, 剩餘語句)；
/// 無開頭 SET search_path、或其後沒有可執行語句時回 None。
fn split_leading_set_search_path(sql: &str) -> Option<(String, String)> {
    let t = sql.trim_start();
    if !t.to_ascii_lowercase().starts_with("set search_path") {
        return None;
    }
    let semi = t.find(';')?;
    let set_stmt = t[..semi].trim().to_string();
    let rest = t[semi + 1..].trim().to_string();
    if rest.is_empty() {
        return None;
    }
    Some((set_stmt, rest))
}

/// 以 stream 逐列收集查詢結果，達 cap 即停（cap=0 不限），回傳 (rows, 是否截斷)。
/// PG 線協定（simple/extended query）無法中途叫停結果集，sqlx 於 stream drop 時清理；
/// 守住的是本端記憶體、IPC 與前端渲染量。
async fn fetch_rows_capped<'e, E>(executor: E, sql: &str, cap: usize) -> AppResult<(Vec<PgRow>, bool)>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    use futures::TryStreamExt;
    let mut stream = sqlx::query(sql).fetch(executor);
    let mut rows: Vec<PgRow> = Vec::new();
    let mut truncated = false;
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|e| AppError::Query(e.to_string()))?
    {
        if cap > 0 && rows.len() >= cap {
            truncated = true;
            break;
        }
        rows.push(row);
    }
    Ok((rows, truncated))
}

fn rows_to_result(rows: &[PgRow]) -> QueryResult {
    if rows.is_empty() {
        return QueryResult::default();
    }
    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    let mut out_rows = Vec::with_capacity(rows.len());
    for row in rows {
        let mut cells = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            cells.push(cell_to_string(row, i));
        }
        out_rows.push(cells);
    }
    QueryResult {
        columns,
        rows: out_rows,
        rows_affected: 0,
        truncated: false,
    }
}

fn cell_to_string(row: &PgRow, idx: usize) -> Option<String> {
    if let Ok(raw) = row.try_get_raw(idx) {
        if raw.is_null() {
            return None;
        }
    }
    let type_name = row
        .columns()
        .get(idx)
        .map(|c| c.type_info().name().to_string())
        .unwrap_or_default();

    match type_name.to_ascii_uppercase().as_str() {
        "INT2" | "SMALLINT" => row.try_get::<i16, _>(idx).ok().map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        "INT4" | "INT" | "INTEGER" => row.try_get::<i32, _>(idx).ok().map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        "INT8" | "BIGINT" => row.try_get::<i64, _>(idx).ok().map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        "FLOAT4" | "REAL" => row.try_get::<f32, _>(idx).ok().map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        "FLOAT8" | "DOUBLE PRECISION" => row.try_get::<f64, _>(idx).ok().map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        "BOOL" | "BOOLEAN" => row.try_get::<bool, _>(idx).ok().map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        _ => string_fallback(row, idx),
    }
}

fn string_fallback(row: &PgRow, idx: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return Some(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<bool, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<bigdecimal::BigDecimal, _>(idx) {
        return Some(v.to_string());
    }
    // TIMESTAMP → NaiveDateTime；TIMESTAMPTZ → DateTime<Utc>（過去版本漏了帶時區的
    // 時間戳，導致 created_at 之類欄位顯示 <unrenderable>）。
    if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(idx) {
        return Some(v.format("%Y-%m-%d %H:%M:%S%.f").to_string());
    }
    if let Ok(v) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(idx) {
        return Some(v.format("%Y-%m-%d %H:%M:%S%.f UTC").to_string());
    }
    if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<uuid::Uuid, _>(idx) {
        return Some(v.to_string());
    }
    // JSON / JSONB（sqlx json 特性）。
    if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return Some(crate::db::bytes_to_display(&v));
    }
    Some("<unrenderable>".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn pg_cast_suffix_rejects_non_identifier_types() {
        // 正常型別名（識別字字元）→ 接受。
        assert_eq!(pg_cast_suffix("int4").as_deref(), Some("int4"));
        assert_eq!(pg_cast_suffix("timestamptz").as_deref(), Some("timestamptz"));
        assert_eq!(pg_cast_suffix("my_enum").as_deref(), Some("my_enum"));
        assert_eq!(pg_cast_suffix("_int4").as_deref(), Some("_int4")); // 陣列內部型別名
        // 含空白 / 標點 / 注入字元 → 拒絕（退回純 text 綁定，避免拼進 SQL）。
        assert_eq!(pg_cast_suffix(""), None);
        assert_eq!(pg_cast_suffix("int4; DROP TABLE x"), None);
        assert_eq!(pg_cast_suffix("a-b"), None);
        assert_eq!(pg_cast_suffix("text)"), None);
        assert_eq!(pg_cast_suffix("double precision"), None); // 含空白 → 拒絕
    }

    #[test]
    fn pg_native_cast_only_numeric_and_temporal() {
        assert_eq!(pg_native_cast("integer"), Some("int4"));
        assert_eq!(pg_native_cast("bigint"), Some("int8"));
        assert_eq!(pg_native_cast("numeric"), Some("numeric"));
        assert_eq!(pg_native_cast("timestamp with time zone"), Some("timestamptz"));
        assert_eq!(pg_native_cast("date"), Some("date"));
        // 文字 / json / uuid 等 → None（沿用 col::text 比較）。
        assert_eq!(pg_native_cast("text"), None);
        assert_eq!(pg_native_cast("jsonb"), None);
        assert_eq!(pg_native_cast("uuid"), None);
    }

    #[test]
    fn bind_placeholder_casts_known_types_only() {
        let mut m = HashMap::new();
        m.insert("id".to_string(), "int4".to_string());
        m.insert("name".to_string(), "text".to_string());
        assert_eq!(bind_placeholder(1, "id", &m), "$1::int4");
        assert_eq!(bind_placeholder(2, "name", &m), "$2::text");
        // 大小寫不敏感的欄位查找。
        assert_eq!(bind_placeholder(3, "ID", &m), "$3::int4");
        // 未知欄位 → 無轉型（純 $n，text 綁定）。
        assert_eq!(bind_placeholder(4, "missing", &m), "$4");
    }

    #[test]
    fn is_ordering_op_matches_only_range_operators() {
        for op in [">", ">=", "<", "<="] {
            assert!(is_ordering_op(op), "{op} 應為排序運算子");
        }
        for op in ["=", "!=", "like", "is_null", "is_not_null"] {
            assert!(!is_ordering_op(op), "{op} 不應為排序運算子");
        }
    }
}
