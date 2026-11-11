use std::time::Duration;

use bb8::Pool;
use bb8_tiberius::ConnectionManager;
use tiberius::{AuthMethod, ColumnType, Config, EncryptionLevel};

use crate::db::{
    filter_op_sql, fmt_bytes, group_table_columns, CellEdit, ColumnInfo, ColumnStats, ConnectionConfig, DataQuery,
    DatabaseDriver, ErColumn, ErModel, ErRelation, ErTable, Filter, ForeignKeyInfo, IndexInfo,
    PagedData, PoolStatus, QueryResult, RoutineInfo, RowDelete, RowInsert, Sort, SortDir, TableColumns, TableInfo,
};
use crate::error::{AppError, AppResult};

/// Microsoft SQL Server 驅動（TDS，透過 tiberius + bb8 連線池）。
/// schema 三層模型映射：database 節點＝真實 DB（sys.databases）；table 名內嵌 schema
/// （dbo 表回裸名、非 dbo 回 `schema.table`），SQL 一律用三部式限定 `[db].[schema].[table]`。
pub struct MssqlDriver {
    pool: Pool<ConnectionManager>,
    #[allow(dead_code)]
    default_db: Option<String>,
    /// 執行中互動查詢（query_capped / query_multi_capped）所在工作階段的 `@@SPID`。
    /// cancel_query 據此以「另一條」連線送 `KILL <spid>`（比照 postgres.rs 的 running）。
    running: parking_lot::Mutex<std::collections::HashSet<i16>>,
}

/// 查詢期間把 SPID 留在 `running` 內，drop 時自動移除（含失敗 / 被 KILL / 外層逾時丟棄 future）。
struct RunningGuard<'a> {
    set: &'a parking_lot::Mutex<std::collections::HashSet<i16>>,
    spid: i16,
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.set.lock().remove(&self.spid);
    }
}

/// 問出該連線的工作階段 ID（`@@SPID` 為 smallint）。
async fn session_spid(conn: &mut bb8_tiberius::rt::Client) -> AppResult<i16> {
    let row = conn
        .simple_query("SELECT @@SPID")
        .await
        .map_err(|e| AppError::Query(e.to_string()))?
        .into_row()
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
    row.and_then(|r| r.get::<i16, _>(0)).ok_or_else(|| AppError::Query("@@SPID".into()))
}

impl MssqlDriver {
    fn track(&self, spid: i16) -> RunningGuard<'_> {
        self.running.lock().insert(spid);
        RunningGuard { set: &self.running, spid }
    }

    /// 開一條**不經連線池**的專屬連線（bb8 `dedicated_connection`）。交易、變數、暫存表都是連線狀態：
    /// 預存程序整合測試的一個情境要在同一條連線上從 BEGIN TRAN 跑到 ROLLBACK，結束即丟棄，
    /// 不能也不該回池（池裡的連線每次 `get()` 都可能是另一條）。
    pub(crate) async fn dedicated_client(&self) -> AppResult<bb8_tiberius::rt::Client> {
        self.pool.dedicated_connection().await.map_err(|e| AppError::Connect(e.to_string()))
    }

    /// 估計執行計畫（SHOWPLAN_XML）：不實際執行查詢。SET SHOWPLAN_XML 是工作階段狀態、而且必須單獨成一個批次，
    /// 所以開一條專屬連線：ON → 送查詢（回一列 XML）→ 連線用完即丟（不必再 OFF，也不會污染池）。
    pub(crate) async fn showplan_xml(&self, sql: &str) -> AppResult<String> {
        let mut c = self.dedicated_client().await?;
        c.simple_query("SET SHOWPLAN_XML ON")
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
            .into_results()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let rows = c
            .simple_query(sql)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
            .into_first_result()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        rows.first()
            .and_then(|r| cell_to_string(r, 0))
            .ok_or_else(|| AppError::Query(t!("沒有取得執行計畫").into()))
    }

    /// 取回結果集所有列（第一個 result set）。
    async fn query_rows(&self, sql: &str) -> AppResult<Vec<tiberius::Row>> {
        let mut conn = self.pool.get().await.map_err(|e| AppError::Query(e.to_string()))?;
        let stream = conn.query(sql, &[]).await.map_err(|e| AppError::Query(e.to_string()))?;
        stream.into_first_result().await.map_err(|e| AppError::Query(e.to_string()))
    }

    /// 取回第一個結果集的列，截斷於 cap（0 = 不限），回傳 (rows, 是否截斷)。
    /// 達 cap 後「繼續 drain 剩餘封包但不儲存」— tiberius stream 提早 drop 會讓連線的
    /// TDS 協定狀態殘留，回 bb8 池後污染後續查詢；drain 完才能安全還池。
    async fn query_rows_capped(&self, sql: &str, cap: usize) -> AppResult<(Vec<tiberius::Row>, bool)> {
        use futures::TryStreamExt;
        let mut conn = self.pool.get().await.map_err(|e| AppError::Query(e.to_string()))?;
        // 只給互動查詢用：登記 SPID，cancel_query 才有目標可 KILL。
        let spid = session_spid(&mut conn).await?;
        let _guard = self.track(spid);
        let mut stream = conn.query(sql, &[]).await.map_err(|e| AppError::Query(e.to_string()))?;
        let mut rows: Vec<tiberius::Row> = Vec::new();
        let mut truncated = false;
        while let Some(item) = stream.try_next().await.map_err(|e| AppError::Query(e.to_string()))? {
            if let tiberius::QueryItem::Row(row) = item {
                // 與 into_first_result 對齊：只取第一個結果集，其餘 drain 不儲存。
                if row.result_index() != 0 {
                    continue;
                }
                if cap > 0 && rows.len() >= cap {
                    truncated = true;
                    continue;
                }
                rows.push(row);
            }
        }
        Ok((rows, truncated))
    }

    /// 取回「所有」結果集，每集各自截斷於 cap（0 = 不限）。達 cap 後續封包照樣 drain 但不儲存
    /// —— 與 query_rows_capped 相同的 TDS 紀律：stream 未讀完就還池會污染後續查詢。
    /// 以 Metadata item 開格，空結果集也保有欄位頭；result_index 防禦性補格。
    async fn query_sets_capped(&self, sql: &str, cap: usize) -> AppResult<Vec<QueryResult>> {
        use futures::TryStreamExt;
        let mut conn = self.pool.get().await.map_err(|e| AppError::Query(e.to_string()))?;
        let spid = session_spid(&mut conn).await?;
        let _guard = self.track(spid);
        let mut stream = conn.query(sql, &[]).await.map_err(|e| AppError::Query(e.to_string()))?;
        let mut sets: Vec<QueryResult> = Vec::new();
        while let Some(item) = stream.try_next().await.map_err(|e| AppError::Query(e.to_string()))? {
            match item {
                tiberius::QueryItem::Metadata(meta) => sets.push(QueryResult {
                    columns: meta.columns().iter().map(|c| c.name().to_string()).collect(),
                    rows: vec![],
                    rows_affected: 0,
                    truncated: false,
                }),
                tiberius::QueryItem::Row(row) => {
                    let idx = row.result_index() as usize;
                    while sets.len() <= idx {
                        sets.push(QueryResult {
                            columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                            rows: vec![],
                            rows_affected: 0,
                            truncated: false,
                        });
                    }
                    let set = &mut sets[idx];
                    if cap > 0 && set.rows.len() >= cap {
                        set.truncated = true;
                        continue;
                    }
                    let cells = (0..set.columns.len()).map(|i| cell_to_string(&row, i)).collect();
                    set.rows.push(cells);
                }
            }
        }
        Ok(sets)
    }

    /// 執行寫入語句，回傳受影響列數。
    async fn exec(&self, sql: &str) -> AppResult<u64> {
        let mut conn = self.pool.get().await.map_err(|e| AppError::Query(e.to_string()))?;
        let res = conn.execute(sql, &[]).await.map_err(|e| AppError::Query(e.to_string()))?;
        Ok(res.rows_affected().iter().sum())
    }

    /// 互動查詢的寫入語句：同 exec，但登記 SPID 讓長時間的 UPDATE / DELETE 也能取消。
    async fn exec_tracked(&self, sql: &str) -> AppResult<u64> {
        let mut conn = self.pool.get().await.map_err(|e| AppError::Query(e.to_string()))?;
        let spid = session_spid(&mut conn).await?;
        let _guard = self.track(spid);
        let res = conn.execute(sql, &[]).await.map_err(|e| AppError::Query(e.to_string()))?;
        Ok(res.rows_affected().iter().sum())
    }

    /// 檢視 / 程序 / 函式 / 觸發器的原始碼；不是這類模組（例如資料表）回 None。
    ///
    /// 不用 `OBJECT_DEFINITION(OBJECT_ID(N'[db].[s].[o]'))`：OBJECT_ID 吃三部式名稱沒問題，
    /// OBJECT_DEFINITION 卻只在「目前資料庫」裡找那個 object_id——連線預設庫是 master、
    /// 在樹上點別的庫的程序，就一律「取不到定義」。改查該庫自己的 sys.sql_modules。
    async fn module_definition(&self, database: &str, schema: &str, name: &str) -> AppResult<Option<String>> {
        let db = esc(database);
        let obj = object_literal(database, schema, name);
        let rows = self
            .query_rows(&format!("SELECT m.definition FROM [{db}].sys.sql_modules m WHERE m.object_id = OBJECT_ID({obj})"))
            .await?;
        Ok(rows.first().and_then(|r| get_str(r, 0)))
    }

    /// 本表主鍵欄位（依 key_ordinal）。
    async fn primary_key(&self, database: &str, schema: &str, table: &str) -> AppResult<Vec<String>> {
        let db = esc(database);
        let obj = object_literal(database, schema, table);
        let sql = format!(
            "SELECT c.name FROM [{db}].sys.indexes i \
             JOIN [{db}].sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
             JOIN [{db}].sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
             WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID({obj}) \
             ORDER BY ic.key_ordinal"
        );
        let rows = self.query_rows(&sql).await?;
        Ok(rows.iter().filter_map(|r| get_str(r, 0)).collect())
    }
}

#[async_trait::async_trait]
impl DatabaseDriver for MssqlDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let mut c = Config::new();
        c.host(&config.host);
        c.port(config.port);
        if let Some(db) = &config.database {
            if !db.is_empty() {
                c.database(db);
            }
        }
        c.authentication(AuthMethod::sql_server(&config.username, &config.password));
        // encrypt 預設開啟；trust_server_certificate 跳過憑證驗證（自簽 / 開發用）。
        let encrypt = config.options.get("encrypt").map(|v| v != "false").unwrap_or(true);
        c.encryption(if encrypt { EncryptionLevel::Required } else { EncryptionLevel::Off });
        if config.options.get("trust_server_certificate").map(|v| v == "true").unwrap_or(false) {
            c.trust_cert();
        } else if let Some(ca) = config.options.get("trust_cert_ca").filter(|s| !s.is_empty()) {
            // 自簽 / 私有 CA：信任指定 CA 憑證檔（PEM），仍驗證伺服器憑證鏈（優先序低於全信任）。
            c.trust_cert_ca(ca);
        }

        let mgr = ConnectionManager::new(c);
        let pool = Pool::builder()
            .max_size(config.max_connections.max(1))
            .connection_timeout(Duration::from_secs(10))
            .idle_timeout(Some(Duration::from_secs(300)))
            .max_lifetime(Some(Duration::from_secs(1800)))
            .build(mgr)
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;

        let driver = Self {
            pool,
            default_db: config.database.clone().filter(|d| !d.is_empty()),
            running: Default::default(),
        };
        driver.ping().await?;
        Ok(driver)
    }

    async fn ping(&self) -> AppResult<()> {
        self.query_rows("SELECT 1").await.map(|_| ())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        // state = 0 表 ONLINE。系統庫（master/model/msdb/tempdb）由前端 isSystemDatabase 隱藏。
        let rows = self
            .query_rows("SELECT name FROM sys.databases WHERE state = 0 ORDER BY name")
            .await?;
        Ok(rows.iter().filter_map(|r| get_str(r, 0)).collect())
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let db = esc(database);
        let sql = format!(
            "SELECT s.name, t.name, 'table' FROM [{db}].sys.tables t \
                 JOIN [{db}].sys.schemas s ON t.schema_id = s.schema_id \
             UNION ALL \
             SELECT s.name, v.name, 'view' FROM [{db}].sys.views v \
                 JOIN [{db}].sys.schemas s ON v.schema_id = s.schema_id \
             ORDER BY 1, 2"
        );
        let rows = self.query_rows(&sql).await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let sch = get_str(r, 0)?;
                let nm = get_str(r, 1)?;
                let kind = get_str(r, 2).unwrap_or_else(|| "table".to_string());
                // dbo 表回裸名；非 dbo 回 schema.table（供三部式定位）。
                let name = if sch == "dbo" { nm } else { format!("{sch}.{nm}") };
                Some(TableInfo { name, kind })
            })
            .collect())
    }

    async fn table_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let (schema, tbl) = split_schema_table(table);
        let db = esc(database);
        let obj = object_literal(database, &schema, &tbl);
        // 型別要帶長度 / 精度：只回 sys.types.name 的話，結構比對看不出 nvarchar(50) → nvarchar(200)，
        // 而且 compare 的 ALTER COLUMN 會照抄成 `ALTER COLUMN [c] nvarchar`——T-SQL 省略長度等於
        // nvarchar(1)，一句同步就把欄位截成 1 個字元。與 PG（format_type）/ Oracle 的回法對齊。
        let sql = format!(
            "SELECT c.name, ty.name, c.is_nullable, c.is_identity, dc.definition, c.max_length, c.precision, c.scale \
             FROM [{db}].sys.columns c \
             JOIN [{db}].sys.types ty ON c.user_type_id = ty.user_type_id \
             LEFT JOIN [{db}].sys.default_constraints dc ON c.default_object_id = dc.object_id \
             WHERE c.object_id = OBJECT_ID({obj}) \
             ORDER BY c.column_id"
        );
        let rows = self.query_rows(&sql).await?;
        let pk = self.primary_key(database, &schema, &tbl).await.unwrap_or_default();
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = get_str(r, 0)?;
                let data_type = mssql_type_str(
                    &get_str(r, 1).unwrap_or_default(),
                    r.try_get::<i16, _>(5).ok().flatten().unwrap_or(0),
                    r.try_get::<u8, _>(6).ok().flatten().unwrap_or(0),
                    r.try_get::<u8, _>(7).ok().flatten().unwrap_or(0),
                );
                let nullable = r.try_get::<bool, _>(2).ok().flatten().unwrap_or(true);
                let is_identity = r.try_get::<bool, _>(3).ok().flatten().unwrap_or(false);
                let default = get_str(r, 4);
                let key = if pk.contains(&name) { "PRI".to_string() } else { String::new() };
                Some(ColumnInfo {
                    name,
                    data_type,
                    nullable,
                    key,
                    default,
                    extra: if is_identity { "identity".to_string() } else { String::new() },
                    comment: String::new(),
                })
            })
            .collect())
    }

    async fn schema_columns(&self, database: &str) -> AppResult<Vec<TableColumns>> {
        // 一次取回整庫（表 + 視圖）欄名。表名組法必須與 list_tables 一致——dbo 回裸名、
        // 非 dbo 回 `schema.table`——否則前端無法把欄位對回樹上的節點。
        // 排序鍵用 schema/表名，與 list_tables 的 ORDER BY 1,2 對齊，group_table_columns 才分得對。
        let db = esc(database);
        let sql = format!(
            "SELECT s.name, o.name, c.name FROM [{db}].sys.columns c \
                 JOIN [{db}].sys.objects o ON o.object_id = c.object_id \
                 JOIN [{db}].sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('U','V') \
             ORDER BY s.name, o.name, c.column_id"
        );
        let rows = self.query_rows(&sql).await?;
        Ok(group_table_columns(rows.iter().filter_map(|r| {
            let sch = get_str(r, 0)?;
            let obj = get_str(r, 1)?;
            let col = get_str(r, 2)?;
            let table = if sch == "dbo" { obj } else { format!("{sch}.{obj}") };
            Some((table, col))
        })))
    }

    async fn table_data(&self, database: &str, table: &str, query: &DataQuery) -> AppResult<PagedData> {
        let (schema, tbl) = split_schema_table(table);
        let qualified = qualified_name(database, &schema, &tbl);
        let where_sql = build_where(&query.filters, query.match_any);

        let total = if query.count {
            // COUNT_BIG：超過 21 億列的表 COUNT(*) 會算術溢位（錯誤 8115），整頁打不開。
            let sql = format!("SELECT COUNT_BIG(*) FROM {qualified} {where_sql}");
            let rows = self.query_rows(&sql).await?;
            rows.first()
                .and_then(|r| r.try_get::<i64, _>(0).ok().flatten())
                .unwrap_or(0)
                .max(0) as u64
        } else {
            0
        };

        let order = build_order(&query.sorts);
        let offset = (query.page as u64).saturating_mul(query.page_size as u64);
        let sql = format!(
            "SELECT * FROM {qualified} {where_sql} {order} OFFSET {offset} ROWS FETCH NEXT {} ROWS ONLY",
            query.page_size
        );
        let rows = self.query_rows(&sql).await?;

        // 欄名取自結果集（無列時回退到 table_columns）。
        let columns: Vec<String> = if let Some(r0) = rows.first() {
            r0.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            self.table_columns(database, table)
                .await?
                .into_iter()
                .map(|c| c.name)
                .collect()
        };
        let data_rows: Vec<Vec<Option<String>>> = rows
            .iter()
            .map(|r| (0..columns.len()).map(|i| cell_to_string(r, i)).collect())
            .collect();
        let primary_key = self.primary_key(database, &schema, &tbl).await.unwrap_or_default();

        Ok(PagedData {
            columns,
            rows: data_rows,
            total_rows: total,
            page: query.page,
            page_size: query.page_size,
            primary_key,
            row_ids: Vec::new(),
        })
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        self.query_capped(sql, 0).await
    }

    async fn query_capped(&self, sql: &str, cap: usize) -> AppResult<QueryResult> {
        if batch_returns_rows(sql) {
            let (rows, truncated) = self.query_rows_capped(sql, cap).await?;
            let columns: Vec<String> = rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let data = rows
                .iter()
                .map(|r| (0..columns.len()).map(|i| cell_to_string(r, i)).collect())
                .collect();
            Ok(QueryResult { columns, rows: data, rows_affected: 0, truncated })
        } else {
            let n = self.exec_tracked(sql).await?;
            Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: n, truncated: false })
        }
    }

    async fn query_multi_capped(&self, sql: &str, cap: usize) -> AppResult<Vec<QueryResult>> {
        if !batch_returns_rows(sql) {
            let n = self.exec_tracked(sql).await?;
            return Ok(vec![QueryResult { columns: vec![], rows: vec![], rows_affected: n, truncated: false }]);
        }
        let sets = self.query_sets_capped(sql, cap).await?;
        if sets.is_empty() {
            // 至少一筆不變量（無任何 Metadata/Row 的極端情況）。
            return Ok(vec![QueryResult::default()]);
        }
        Ok(sets)
    }

    /// SQL Server 沒有「只中止當前語句」的 T-SQL（MySQL `KILL QUERY` / PG `pg_cancel_backend` 的對應物是
    /// TDS attention 封包，tiberius 不支援），只能 `KILL <spid>` 結束整個工作階段：未提交的交易會回滾。
    /// 互動查詢本來就是每次從池裡借一條、不跨查詢保留交易，所以代價只是那條連線——
    /// 被 KILL 的連線還池後，bb8 預設的 test_on_check_out（`SELECT 1`）會把它淘汰，不會污染下一個查詢。
    /// 需要 `ALTER ANY CONNECTION` 權限；沒有時把伺服器的錯誤訊息原樣回給前端。
    async fn cancel_query(&self) -> AppResult<usize> {
        let spids: Vec<i16> = self.running.lock().iter().copied().collect();
        if spids.is_empty() {
            return Ok(0); // 查詢已結束或尚未送達 DB —— 不是錯誤
        }
        // 走不經池的專屬連線：池滿（max_connections 小、全卡在長查詢上）時從池裡借會一直等到逾時。
        let mut conn = self.dedicated_client().await?;
        let mut sent = 0usize;
        for spid in spids {
            // 送出前再確認一次：查詢可能剛好結束，SPID 已還池給別的查詢用。
            if !self.running.lock().contains(&spid) {
                continue;
            }
            conn.simple_query(format!("KILL {spid}"))
                .await
                .map_err(|e| AppError::Query(e.to_string()))?
                .into_results()
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            sent += 1;
        }
        Ok(sent)
    }

    async fn update_cell(&self, database: &str, table: &str, edit: &CellEdit) -> AppResult<u64> {
        let (schema, tbl) = split_schema_table(table);
        let qualified = qualified_name(database, &schema, &tbl);
        let set_val = match &edit.new_value {
            Some(v) => lit(v),
            None => "NULL".to_string(),
        };
        let where_sql = pk_where(&edit.pk_columns, &edit.pk_values)?;
        let sql = format!(
            "UPDATE {qualified} SET [{}] = {set_val} WHERE {where_sql}",
            esc(&edit.column)
        );
        self.exec(&sql).await
    }

    async fn insert_row(&self, database: &str, table: &str, row: &RowInsert) -> AppResult<u64> {
        if row.columns.len() != row.values.len() {
            return Err(AppError::Query(t!("欄位與值數量不符").to_string()));
        }
        let (schema, tbl) = split_schema_table(table);
        let qualified = qualified_name(database, &schema, &tbl);
        let cols: Vec<String> = row.columns.iter().map(|c| format!("[{}]", esc(c))).collect();
        let vals: Vec<String> = row
            .values
            .iter()
            .map(|v| v.as_ref().map(|s| lit(s)).unwrap_or_else(|| "NULL".to_string()))
            .collect();
        let sql = format!(
            "INSERT INTO {qualified} ({}) VALUES ({})",
            cols.join(", "),
            vals.join(", ")
        );
        self.exec(&sql).await
    }

    async fn delete_row(&self, database: &str, table: &str, del: &RowDelete) -> AppResult<u64> {
        let (schema, tbl) = split_schema_table(table);
        let qualified = qualified_name(database, &schema, &tbl);
        let where_sql = pk_where(&del.pk_columns, &del.pk_values)?;
        let sql = format!("DELETE FROM {qualified} WHERE {where_sql}");
        self.exec(&sql).await
    }

    async fn table_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        let (schema, tbl) = split_schema_table(table);
        let db = esc(database);
        let obj = object_literal(database, &schema, &tbl);
        let sql = format!(
            "SELECT i.name, c.name, i.is_unique, i.is_primary_key \
             FROM [{db}].sys.indexes i \
             JOIN [{db}].sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
             JOIN [{db}].sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
             WHERE i.object_id = OBJECT_ID({obj}) AND i.type > 0 \
             ORDER BY i.name, ic.key_ordinal"
        );
        let rows = self.query_rows(&sql).await?;
        // 依索引名聚合欄位（保持順序）。
        let mut out: Vec<IndexInfo> = Vec::new();
        for r in &rows {
            let name = match get_str(r, 0) {
                Some(n) => n,
                None => continue,
            };
            let col = get_str(r, 1).unwrap_or_default();
            let unique = r.try_get::<bool, _>(2).ok().flatten().unwrap_or(false);
            let primary = r.try_get::<bool, _>(3).ok().flatten().unwrap_or(false);
            if let Some(existing) = out.iter_mut().find(|i| i.name == name) {
                existing.columns.push(col);
            } else {
                out.push(IndexInfo { name, columns: vec![col], unique, primary });
            }
        }
        Ok(out)
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        let (schema, tbl) = split_schema_table(table);
        let db = esc(database);
        let obj = object_literal(database, &schema, &tbl);
        let sql = format!(
            "SELECT fk.name, pc.name, rs.name, rt.name, rc.name \
             FROM [{db}].sys.foreign_keys fk \
             JOIN [{db}].sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id \
             JOIN [{db}].sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id \
             JOIN [{db}].sys.tables rt ON fkc.referenced_object_id = rt.object_id \
             JOIN [{db}].sys.schemas rs ON rt.schema_id = rs.schema_id \
             JOIN [{db}].sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id \
             WHERE fk.parent_object_id = OBJECT_ID({obj}) \
             ORDER BY fk.name, fkc.constraint_column_id"
        );
        let rows = self.query_rows(&sql).await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = get_str(r, 0)?;
                let column = get_str(r, 1)?;
                let ref_schema = get_str(r, 2).unwrap_or_else(|| "dbo".to_string());
                let ref_tbl = get_str(r, 3)?;
                let ref_column = get_str(r, 4)?;
                let ref_table = if ref_schema == "dbo" { ref_tbl } else { format!("{ref_schema}.{ref_tbl}") };
                Some(ForeignKeyInfo { name, column, ref_table, ref_column })
            })
            .collect())
    }

    async fn list_routines(&self, database: &str) -> AppResult<Vec<RoutineInfo>> {
        let db = esc(database);
        // 預存程序 / 函式。型別碼清單與 `routine_type_of` 必須同步：查出來卻對不上的列會被略過。
        let sql = format!(
            "SELECT s.name, o.name, o.type, CONVERT(NVARCHAR(30), o.modify_date, 120) \
             FROM [{db}].sys.objects o JOIN [{db}].sys.schemas s ON o.schema_id = s.schema_id \
             WHERE o.type IN ({types}) AND o.is_ms_shipped = 0 \
             ORDER BY o.type, o.name",
            types = ROUTINE_TYPE_CODES.iter().map(|c| format!("'{c}'")).collect::<Vec<_>>().join(",")
        );
        let mut out = Vec::new();
        for r in &self.query_rows(&sql).await? {
            let sch = get_str(r, 0).unwrap_or_else(|| "dbo".to_string());
            let nm = match get_str(r, 1) {
                Some(n) => n,
                None => continue,
            };
            let ty = get_str(r, 2).unwrap_or_default();
            let Some(routine_type) = routine_type_of(&ty) else { continue };
            out.push(RoutineInfo {
                name: schema_qualified(&sch, nm),
                routine_type: routine_type.to_string(),
                parent: None,
                signature: None,
                modified: get_str(r, 3),
                deterministic: None,
                comment: None,
            });
        }
        // 觸發器（掛在資料表上）。DML 觸發器的 schema 跟著父表，DROP TRIGGER 需要它，
        // 所以名稱與程序 / 函式一樣以 `schema.name` 表示（dbo 省略）。
        let tsql = format!(
            "SELECT s.name, t.name, OBJECT_NAME(t.parent_id, DB_ID(N'{db_raw}')), CONVERT(NVARCHAR(30), t.modify_date, 120) \
             FROM [{db}].sys.triggers t \
             JOIN [{db}].sys.objects o ON o.object_id = t.object_id \
             JOIN [{db}].sys.schemas s ON s.schema_id = o.schema_id \
             WHERE t.is_ms_shipped = 0 AND t.parent_class = 1 ORDER BY t.name",
            db_raw = database.replace('\'', "''")
        );
        if let Ok(trows) = self.query_rows(&tsql).await {
            for r in &trows {
                let sch = get_str(r, 0).unwrap_or_else(|| "dbo".to_string());
                if let Some(nm) = get_str(r, 1) {
                    out.push(RoutineInfo {
                        name: schema_qualified(&sch, nm),
                        routine_type: "trigger".to_string(),
                        parent: get_str(r, 2),
                        signature: None,
                        modified: get_str(r, 3),
                        deterministic: None,
                        comment: None,
                    });
                }
            }
        }
        Ok(out)
    }

    async fn routine_definition(&self, database: &str, name: &str, _routine_type: &str) -> AppResult<String> {
        let (schema, obj_name) = split_schema_table(name);
        self.module_definition(database, &schema, &obj_name)
            .await?
            .ok_or_else(|| AppError::Query(t!("取不到定義（可能無權限或物件不存在）").to_string()))
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        let (schema, tbl) = split_schema_table(table);
        let obj = object_literal(database, &schema, &tbl);
        // 檢視 / 程序 / 函式：直接回其定義。
        if let Some(def) = self.module_definition(database, &schema, &tbl).await? {
            return Ok(def);
        }
        // 資料表：從 sys.columns 重建 CREATE TABLE（欄位 + PK）。
        let db = esc(database);
        // seed / increment 是 sql_variant（tiberius 解不了），先轉成字串；計算欄位要輸出 `AS (運算式)`，
        // 照抄型別會變成一個普通欄位，重建出來的表少了公式、資料也不再自動算。
        let sql = format!(
            "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, dc.definition, \
                    CAST(ic.seed_value AS NVARCHAR(64)), CAST(ic.increment_value AS NVARCHAR(64)), \
                    cc.definition, cc.is_persisted \
             FROM [{db}].sys.columns c \
             JOIN [{db}].sys.types ty ON c.user_type_id = ty.user_type_id \
             LEFT JOIN [{db}].sys.default_constraints dc ON c.default_object_id = dc.object_id \
             LEFT JOIN [{db}].sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
             LEFT JOIN [{db}].sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
             WHERE c.object_id = OBJECT_ID({obj}) ORDER BY c.column_id"
        );
        let rows = self.query_rows(&sql).await?;
        if rows.is_empty() {
            return Err(AppError::Query(t!("找不到資料表欄位").to_string()));
        }
        let mut lines: Vec<String> = Vec::new();
        for r in &rows {
            let type_str = mssql_type_str(
                &get_str(r, 1).unwrap_or_default(),
                r.try_get::<i16, _>(2).ok().flatten().unwrap_or(0),
                r.try_get::<u8, _>(3).ok().flatten().unwrap_or(0),
                r.try_get::<u8, _>(4).ok().flatten().unwrap_or(0),
            );
            let identity = r.try_get::<bool, _>(6).ok().flatten().unwrap_or(false).then(|| {
                (get_str(r, 8).unwrap_or_else(|| "1".into()), get_str(r, 9).unwrap_or_else(|| "1".into()))
            });
            let computed = get_str(r, 10).map(|d| (d, r.try_get::<bool, _>(11).ok().flatten().unwrap_or(false)));
            lines.push(ddl_column_line(&DdlColumn {
                name: &get_str(r, 0).unwrap_or_default(),
                type_str: &type_str,
                nullable: r.try_get::<bool, _>(5).ok().flatten().unwrap_or(true),
                identity,
                default: get_str(r, 7),
                computed,
            }));
        }
        let pk = self.primary_key(database, &schema, &tbl).await.unwrap_or_default();
        if !pk.is_empty() {
            let cols = pk.iter().map(|c| format!("[{}]", esc(c))).collect::<Vec<_>>().join(", ");
            lines.push(format!("  PRIMARY KEY ({cols})"));
        }
        Ok(format!(
            "CREATE TABLE {} (\n{}\n);",
            qualified_name(database, &schema, &tbl),
            lines.join(",\n")
        ))
    }

    async fn er_model(&self, database: &str) -> AppResult<ErModel> {
        let tables = self.list_tables(database).await?;
        let mut er_tables = Vec::new();
        let mut relations = Vec::new();
        for t in &tables {
            if t.kind != "table" {
                continue;
            }
            let cols = self.table_columns(database, &t.name).await.unwrap_or_default();
            let fks = self.list_foreign_keys(database, &t.name).await.unwrap_or_default();
            let fk_cols: std::collections::HashSet<&str> = fks.iter().map(|f| f.column.as_str()).collect();
            er_tables.push(ErTable {
                name: t.name.clone(),
                columns: cols
                    .iter()
                    .map(|c| ErColumn {
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        pk: c.key == "PRI",
                        fk: fk_cols.contains(c.name.as_str()),
                    })
                    .collect(),
            });
            for f in fks {
                relations.push(ErRelation {
                    from_table: t.name.clone(),
                    from_column: f.column,
                    to_table: f.ref_table,
                    to_column: f.ref_column,
                });
            }
        }
        Ok(ErModel { tables: er_tables, relations })
    }

    async fn column_stats(&self, database: &str, table: &str, column: &str) -> AppResult<ColumnStats> {
        let (schema, tbl) = split_schema_table(table);
        let q = qualified_name(database, &schema, &tbl);
        let col = format!("[{}]", esc(column));
        let rows = self
            .query_rows(&format!("SELECT COUNT_BIG(*), COUNT_BIG({col}), COUNT_BIG(DISTINCT {col}) FROM {q}"))
            .await?;
        let r = rows.first().ok_or_else(|| AppError::Query(t!("欄位統計無結果").to_string()))?;
        let total = r.try_get::<i64, _>(0).ok().flatten().unwrap_or(0) as u64;
        let non_null = r.try_get::<i64, _>(1).ok().flatten().unwrap_or(0) as u64;
        let distinct = r.try_get::<i64, _>(2).ok().flatten().unwrap_or(0) as u64;
        // MIN / MAX best-effort（text / image / xml 等型別不支援聚合）。
        let (min, max) = match self
            .query_rows(&format!(
                "SELECT CAST(MIN({col}) AS NVARCHAR(4000)), CAST(MAX({col}) AS NVARCHAR(4000)) FROM {q}"
            ))
            .await
        {
            Ok(mr) => {
                let m = mr.first();
                (m.and_then(|r| get_str(r, 0)), m.and_then(|r| get_str(r, 1)))
            }
            Err(_) => (None, None),
        };
        Ok(ColumnStats { total, non_null, distinct, min, max, ..Default::default() })
    }

    async fn table_info(&self, database: &str, table: &str) -> AppResult<Vec<(String, String)>> {
        let (schema, tbl) = split_schema_table(table);
        let db = esc(database);
        let obj = object_literal(database, &schema, &tbl);
        let sql = format!(
            "SELECT SUM(p.rows), SUM(a.total_pages) * 8 * 1024 \
             FROM [{db}].sys.partitions p \
             JOIN [{db}].sys.allocation_units a ON p.partition_id = a.container_id \
             WHERE p.object_id = OBJECT_ID({obj}) AND p.index_id IN (0, 1)"
        );
        let mut out = Vec::new();
        if let Ok(rows) = self.query_rows(&sql).await {
            if let Some(r) = rows.first() {
                if let Some(n) = r.try_get::<i64, _>(0).ok().flatten() {
                    out.push((t!("列數（估計）").to_string(), n.to_string()));
                }
                if let Some(b) = r.try_get::<i64, _>(1).ok().flatten() {
                    out.push((t!("資料大小").to_string(), fmt_bytes(b)));
                }
            }
        }
        Ok(out)
    }

    async fn explain(&self, sql: &str) -> AppResult<QueryResult> {
        // 走專屬連線（用完即丟）。以前借池裡的連線 SET SHOWPLAN_XML ON：查詢一失敗就從 `?` 提早返回、
        // 沒機會 OFF；就算成功，OFF 的結果串流也沒讀完。那條連線回池後仍在 SHOWPLAN 模式，
        // 之後借到它的查詢都只會拿到執行計畫、不會真的執行（bb8 的 SELECT 1 檢查也照樣通過）。
        let plan = self.showplan_xml(sql).await?;
        Ok(QueryResult {
            columns: vec!["ShowPlanXML".to_string()],
            rows: vec![vec![Some(plan)]],
            rows_affected: 0,
            truncated: false,
        })
    }

    async fn exec_ddl(&self, sql: &str) -> AppResult<()> {
        let mut conn = self.pool.get().await.map_err(|e| AppError::Query(e.to_string()))?;
        conn.simple_query(sql)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
            .into_results()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(())
    }

    async fn create_database(&self, name: &str) -> AppResult<()> {
        self.exec(&format!("CREATE DATABASE [{}]", esc(name))).await.map(|_| ())
    }

    async fn drop_database(&self, name: &str) -> AppResult<()> {
        if MSSQL_SYSTEM_DBS.contains(&name.to_lowercase().as_str()) {
            return Err(AppError::Query(tf!("系統資料庫「{name}」不可刪除", name = name)));
        }
        self.exec(&format!("DROP DATABASE [{}]", esc(name))).await.map(|_| ())
    }

    async fn create_index(
        &self,
        database: &str,
        table: &str,
        name: &str,
        columns: &[String],
        unique: bool,
    ) -> AppResult<()> {
        let (schema, tbl) = split_schema_table(table);
        let q = qualified_name(database, &schema, &tbl);
        let cols = columns.iter().map(|c| format!("[{}]", esc(c))).collect::<Vec<_>>().join(", ");
        let uniq = if unique { "UNIQUE " } else { "" };
        self.exec(&format!("CREATE {uniq}INDEX [{}] ON {q} ({cols})", esc(name))).await.map(|_| ())
    }

    async fn drop_index(&self, database: &str, table: &str, index: &str) -> AppResult<()> {
        let (schema, tbl) = split_schema_table(table);
        let q = qualified_name(database, &schema, &tbl);
        // MSSQL 的 DROP INDEX 需帶表名。
        self.exec(&format!("DROP INDEX [{}] ON {q}", esc(index))).await.map(|_| ())
    }

    fn pool_status(&self) -> PoolStatus {
        let st = self.pool.state();
        PoolStatus {
            size: st.connections,
            idle: st.idle_connections,
            in_use: st.connections.saturating_sub(st.idle_connections),
        }
    }

    async fn close(&self) {
        // bb8 pool 於 drop 時清理連線；無顯式 close。
    }
}

/// 識別字跳脫：`]` → `]]`（供包在 [方括號] 內）。
fn esc(id: &str) -> String {
    id.replace(']', "]]")
}

/// 字串字面值：`N'...'`，單引號加倍。數字 / 日期等亦以字串傳入，由 SQL Server 隱式轉型。
fn lit(v: &str) -> String {
    format!("N'{}'", v.replace('\'', "''"))
}

/// 拆 `schema.table`：無點號預設 dbo。
fn split_schema_table(table: &str) -> (String, String) {
    match table.split_once('.') {
        Some((s, t)) => (s.to_string(), t.to_string()),
        None => ("dbo".to_string(), table.to_string()),
    }
}

/// `split_schema_table` 的反向：dbo 省略、其餘 schema 以 `schema.name` 呈現（樹狀 / 右鍵 / DROP 共用同一種寫法）。
fn schema_qualified(schema: &str, name: String) -> String {
    if schema == "dbo" { name } else { format!("{schema}.{name}") }
}

/// `list_routines` 要撈的 `sys.objects.type` 型別碼（程序 + 函式）。
/// P = T-SQL 程序、PC = CLR 程序；FN / IF / TF = T-SQL 標量 / 內嵌資料表 / 多語句資料表函式，
/// FS / FT = CLR 標量 / 資料表函式，AF = CLR 聚合函式。X（擴充程序）/ RF（複寫篩選程序）刻意不列：
/// 前者已棄用且只會在 master，後者是複寫內部物件，不是使用者要維護的東西。
const ROUTINE_TYPE_CODES: &[&str] = &["P", "PC", "FN", "IF", "TF", "FS", "FT", "AF"];

/// `sys.objects.type`（char(2)，有尾空白）→ 本專案的 routine 種類。
/// 明列兩邊的正向對應，不寫成「不是 P 就是 function」——那種寫法在型別碼清單一擴充
///（例如補進 PC）就會把 CLR 程序當成函式；對不上的碼回 None，呼叫端略過。
fn routine_type_of(ty: &str) -> Option<&'static str> {
    match ty.trim() {
        "P" | "PC" => Some("procedure"),
        "FN" | "IF" | "TF" | "FS" | "FT" | "AF" => Some("function"),
        _ => None,
    }
}

/// 三部式限定名 `[db].[schema].[table]`。
fn qualified_name(db: &str, schema: &str, table: &str) -> String {
    format!("[{}].[{}].[{}]", esc(db), esc(schema), esc(table))
}

/// 供 OBJECT_ID() 用的字串字面值 `N'[db].[schema].[table]'`。
fn object_literal(db: &str, schema: &str, table: &str) -> String {
    lit(&format!("[{}].[{}].[{}]", esc(db), esc(schema), esc(table)))
}

/// `table_ddl` 一個欄位的素材。
struct DdlColumn<'a> {
    name: &'a str,
    type_str: &'a str,
    nullable: bool,
    /// (seed, increment)
    identity: Option<(String, String)>,
    default: Option<String>,
    /// (運算式, 是否 PERSISTED)
    computed: Option<(String, bool)>,
}

/// CREATE TABLE 裡的一行欄位定義。計算欄位沒有型別、NULL 與 DEFAULT，只有 `AS (運算式)`。
fn ddl_column_line(c: &DdlColumn) -> String {
    let name = esc(c.name);
    if let Some((expr, persisted)) = &c.computed {
        return format!("  [{name}] AS {expr}{}", if *persisted { " PERSISTED" } else { "" });
    }
    let mut def = format!("  [{name}] {}", c.type_str);
    if let Some((seed, inc)) = &c.identity {
        def.push_str(&format!(" IDENTITY({seed},{inc})"));
    }
    def.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
    if let Some(d) = &c.default {
        def.push_str(&format!(" DEFAULT {d}"));
    }
    def
}

/// 系統資料庫（drop 護欄）。
const MSSQL_SYSTEM_DBS: &[&str] = &["master", "model", "msdb", "tempdb"];

/// 依 sys.columns 的 max_length / precision / scale 組型別字串（含長度 / 精度），供 table_ddl 重建。
fn mssql_type_str(ty: &str, max_length: i16, precision: u8, scale: u8) -> String {
    match ty.to_lowercase().as_str() {
        // nchar / nvarchar 的 max_length 以位元組計（每字元 2 bytes）；-1 = MAX。
        "nvarchar" | "nchar" => {
            if max_length == -1 { format!("{ty}(MAX)") } else { format!("{ty}({})", max_length / 2) }
        }
        "varchar" | "char" | "binary" | "varbinary" => {
            if max_length == -1 { format!("{ty}(MAX)") } else { format!("{ty}({max_length})") }
        }
        "decimal" | "numeric" => format!("{ty}({precision},{scale})"),
        // 省略精度等於預設的 7：`datetime2(0)` 若寫成 `datetime2`，重建 / 同步出來的欄位就從秒變成 100ns，
        // 型別比對也看不出差異。所以只有 7 能省略，0 也要寫出來。
        "datetime2" | "time" | "datetimeoffset" if scale != 7 => format!("{ty}({scale})"),
        _ => ty.to_string(),
    }
}

/// 這個**批次**會不會回結果集（→ 走 fetch 串流；否則走 execute 取受影響列數）。
///
/// 前端依 `GO` 把整個批次一次送來（DECLARE 的變數、暫存表、交易都要在同一個批次裡），
/// 所以不能只看第一個關鍵字：`DECLARE @n int = 1; SELECT @n`、`SET NOCOUNT ON; SELECT …`、
/// `IF EXISTS (…) SELECT …`、`UPDATE … OUTPUT inserted.*` 都會回列，開頭卻不是 SELECT。
/// 只看開頭的話它們全走 execute，結果集被丟掉，使用者只看到「影響 0 列」。
///
/// 掃描規則（去掉註解與字面值後、只看括號外的字詞）：
/// - `SELECT` / `EXEC` 會回列——但 `INSERT … SELECT`、`INSERT … EXEC` 是寫入的一部分，
///   `INSERT … VALUES (…)` 之後的 SELECT 才是新語句；`DECLARE c CURSOR FOR SELECT` 不回列。
/// - DML 的 `OUTPUT` 子句會回列。
/// - `CREATE / ALTER PROCEDURE|FUNCTION|VIEW|TRIGGER` 的本體是定義、不是現在要執行的查詢，
///   T-SQL 規定它獨佔整個批次，看到就停。
///
/// tiberius 的串流取不到受影響列數，所以兩邊都能走的批次（例如 `UPDATE …; SELECT …`）
/// 選擇保住結果集；純寫入批次照舊回列數。
fn batch_returns_rows(sql: &str) -> bool {
    let code = tsql_code_only(sql).to_ascii_lowercase();
    let toks = tsql_tokens(&code);
    let mut depth = 0usize;
    // 目前所在語句的種類（只追 SELECT 判讀需要的那幾種）。
    let mut cur: &str = "";
    let mut insert_values = false;
    for (i, t) in toks.iter().enumerate() {
        match *t {
            "(" => depth += 1,
            ")" => depth = depth.saturating_sub(1),
            ";" if depth == 0 => {
                cur = "";
                insert_values = false;
            }
            _ if depth > 0 => {}
            "select" | "exec" | "execute" => {
                let part_of_write = (cur == "insert" && !insert_values) || cur == "cursor";
                if !part_of_write {
                    return true;
                }
            }
            "output" if matches!(cur, "insert" | "update" | "delete" | "merge") => return true,
            "insert" => {
                cur = "insert";
                insert_values = false;
            }
            "values" if cur == "insert" => insert_values = true,
            "update" | "delete" | "merge" => cur = t,
            "cursor" => cur = "cursor",
            "create" | "alter" => {
                let next = toks[i + 1..].iter().find(|w| !matches!(**w, "or" | "alter"));
                if next.is_some_and(|w| matches!(*w, "procedure" | "proc" | "function" | "view" | "trigger")) {
                    return false;
                }
                cur = "create";
            }
            "declare" | "if" | "else" | "begin" | "end" | "while" | "print" | "use" | "return" | "drop"
            | "truncate" | "commit" | "rollback" | "go" => {
                cur = "";
                insert_values = false;
            }
            _ => {}
        }
    }
    false
}

/// T-SQL 版的「只留程式碼」：註解、字串、`"識別字"`、`[識別字]` 各換成一個空白。
///
/// 不能沿用 `stmt::code_only`：它照 MySQL 規則把 `#` 當行註解（T-SQL 的 `#temp` 暫存表名
/// 會把後半個批次吃掉）、把字串裡的 `\` 當跳脫（`'C:\backup\'` 的結尾引號會被吞掉）。
/// T-SQL 的區塊註解可巢狀。
fn tsql_code_only(sql: &str) -> String {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out: Vec<u8> = Vec::with_capacity(n);
    let mut i = 0;
    // 跳到成對結尾（疊寫兩次代表字面上的一個，如 `''`、`]]`），回傳結尾之後的位置。
    let skip_quoted = |mut j: usize, close: u8| -> usize {
        while j < n {
            if b[j] == close {
                if j + 1 < n && b[j + 1] == close {
                    j += 2;
                    continue;
                }
                return j + 1;
            }
            j += 1;
        }
        n
    };
    while i < n {
        let c = b[i];
        let next = if i + 1 < n { b[i + 1] } else { 0 };
        let skipped_to = match c {
            b'\'' => Some(skip_quoted(i + 1, b'\'')),
            b'"' => Some(skip_quoted(i + 1, b'"')),
            b'[' => Some(skip_quoted(i + 1, b']')),
            b'-' if next == b'-' => Some(b[i..].iter().position(|&x| x == b'\n').map_or(n, |p| i + p)),
            b'/' if next == b'*' => {
                let mut depth = 1;
                let mut j = i + 2;
                while j < n && depth > 0 {
                    if b[j] == b'/' && j + 1 < n && b[j + 1] == b'*' {
                        depth += 1;
                        j += 2;
                    } else if b[j] == b'*' && j + 1 < n && b[j + 1] == b'/' {
                        depth -= 1;
                        j += 2;
                    } else {
                        j += 1;
                    }
                }
                Some(j)
            }
            _ => None,
        };
        match skipped_to {
            Some(j) => {
                out.push(b' ');
                i = j;
            }
            None => {
                out.push(c);
                i += 1;
            }
        }
    }
    // 略過的區段起訖都是 ASCII，保留下來的位元組仍是合法 UTF-8。
    String::from_utf8(out).unwrap_or_default()
}

/// `tsql_code_only` 之後的 T-SQL 粗切詞：字詞（含 `@` `#` `_` `$`）與 `(` `)` `;` 各成一個 token，其餘略過。
fn tsql_tokens(code: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let b = code.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_alphanumeric() || matches!(c, b'_' | b'@' | b'#' | b'$') || c >= 0x80 {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'@' | b'#' | b'$') || b[i] >= 0x80) {
                i += 1;
            }
            out.push(&code[s..i]);
            continue;
        }
        if matches!(c, b'(' | b')' | b';') {
            out.push(&code[i..i + 1]);
        }
        i += 1;
    }
    out
}

fn get_str(row: &tiberius::Row, idx: usize) -> Option<String> {
    row.try_get::<&str, _>(idx).ok().flatten().map(|s| s.to_string())
}

fn build_where(filters: &[Filter], match_any: bool) -> String {
    if filters.is_empty() {
        return String::new();
    }
    let joiner = if match_any { " OR " } else { " AND " };
    let parts: Vec<String> = filters
        .iter()
        .filter_map(|f| {
            let op = filter_op_sql(&f.op)?;
            let col = format!("[{}]", esc(&f.column));
            match f.op.as_str() {
                "is_null" | "is_not_null" => Some(format!("{col} {op}")),
                _ => {
                    let v = f.value.as_deref().unwrap_or("");
                    Some(format!("{col} {op} {}", lit(v)))
                }
            }
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", parts.join(joiner))
    }
}

fn build_order(sorts: &[Sort]) -> String {
    // OFFSET/FETCH 必須有 ORDER BY；無排序時用 (SELECT NULL) 佔位。
    if sorts.is_empty() {
        return "ORDER BY (SELECT NULL)".to_string();
    }
    let parts: Vec<String> = sorts
        .iter()
        .map(|s| {
            let dir = match s.dir {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            };
            format!("[{}] {}", esc(&s.column), dir)
        })
        .collect();
    format!("ORDER BY {}", parts.join(", "))
}

/// 以主鍵欄位 / 值組 WHERE 子句。任一主鍵值為 NULL 視為無法安全定位。
fn pk_where(cols: &[String], vals: &[Option<String>]) -> AppResult<String> {
    if cols.is_empty() {
        return Err(AppError::Query(t!("缺少主鍵，無法定位列").to_string()));
    }
    let mut parts = Vec::with_capacity(cols.len());
    for (c, v) in cols.iter().zip(vals.iter()) {
        match v {
            Some(val) => parts.push(format!("[{}] = {}", esc(c), lit(val))),
            None => return Err(AppError::Query(t!("主鍵值為 NULL，無法安全定位列").to_string())),
        }
    }
    Ok(parts.join(" AND "))
}

/// tiberius 的一格 → 顯示字串。NULL 回 None。
///
/// 直接看解碼後的 `ColumnData`，不靠 `ColumnType` 猜該用哪個型別 `try_get`：
/// 以前可為 NULL 的 `real` 欄位宣告型別是 Floatn、資料卻是 F32，`try_get::<f64>` 失敗 → 整欄顯示 NULL；
/// `xml` 欄位是 ColumnData::Xml，`try_get::<&str>` 也失敗 → 一樣是 NULL；`datetimeoffset` 被換算成 UTC
/// 並印成 `… UTC`，原本的時區沒了、字串也無法再寫回。
pub(crate) fn cell_to_string(row: &tiberius::Row, idx: usize) -> Option<String> {
    let (col, data) = row.cells().nth(idx)?;
    let is_money = matches!(col.column_type(), ColumnType::Money | ColumnType::Money4);
    column_data_to_string(data, is_money)
}

/// `cell_to_string` 的純函式核心（可單元測試，不需要連線）。`is_money`：money / smallmoney
/// 在 TDS 上解成 F64，只能從欄位型別得知；照 SSMS 顯示 4 位小數，避免 `0.1 + 0.2` 式的二進位尾數。
fn column_data_to_string(data: &tiberius::ColumnData<'static>, is_money: bool) -> Option<String> {
    use tiberius::{ColumnData as Cd, FromSql};
    match data {
        Cd::U8(v) => v.map(|x| x.to_string()),
        Cd::I16(v) => v.map(|x| x.to_string()),
        Cd::I32(v) => v.map(|x| x.to_string()),
        Cd::I64(v) => v.map(|x| x.to_string()),
        Cd::F32(v) => v.map(|x| x.to_string()),
        Cd::F64(v) if is_money => v.map(|x| format!("{x:.4}")),
        Cd::F64(v) => v.map(|x| x.to_string()),
        Cd::Bit(v) => v.map(|x| x.to_string()),
        Cd::String(v) => v.as_ref().map(|s| s.to_string()),
        Cd::Guid(v) => v.map(|g| g.to_string()),
        Cd::Binary(v) => v.as_ref().map(|b| crate::db::bytes_to_display(b)),
        Cd::Numeric(v) => v.map(|n| n.to_string()),
        Cd::Xml(v) => v.as_ref().map(|x| x.to_string()),
        Cd::DateTime(_) | Cd::SmallDateTime(_) | Cd::DateTime2(_) => chrono::NaiveDateTime::from_sql(data)
            .ok()
            .flatten()
            .map(|v| v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        Cd::Date(_) => chrono::NaiveDate::from_sql(data).ok().flatten().map(|v| v.to_string()),
        Cd::Time(_) => chrono::NaiveTime::from_sql(data).ok().flatten().map(|v| v.to_string()),
        // 保留原本的時區位移（SQL Server 能直接吃回 `2024-01-02 10:00:00 +08:00`）。
        Cd::DateTimeOffset(_) => chrono::DateTime::<chrono::FixedOffset>::from_sql(data)
            .ok()
            .flatten()
            .map(|v| v.format("%Y-%m-%d %H:%M:%S%.f %:z").to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routine_type_of_maps_procedure_codes_including_clr() {
        // sys.objects.type 是 char(2)：T-SQL 程序回來是 "P "（尾空白）。
        assert_eq!(routine_type_of("P "), Some("procedure"));
        assert_eq!(routine_type_of("P"), Some("procedure"));
        assert_eq!(routine_type_of("PC"), Some("procedure"));
    }

    #[test]
    fn routine_type_of_maps_every_function_flavor() {
        for code in ["FN", "IF", "TF", "FS", "FT", "AF"] {
            assert_eq!(routine_type_of(code), Some("function"), "{code}");
        }
    }

    #[test]
    fn routine_type_of_rejects_unknown_codes_instead_of_defaulting_to_function() {
        // 以前是「不是 P 就是 function」：資料表 / 檢視 / 觸發器 / 空字串全會被貼上函式標籤。
        for code in ["U ", "V ", "TR", "X ", "RF", "", "  "] {
            assert_eq!(routine_type_of(code), None, "{code:?}");
        }
    }

    #[test]
    fn query_type_codes_all_have_a_mapping() {
        // 查詢 IN (...) 清單與對應表脫鉤時，撈出來的列會被 `continue` 悄悄吞掉；這裡釘住兩者同步。
        for code in ROUTINE_TYPE_CODES {
            assert!(routine_type_of(code).is_some(), "{code} 在 IN 清單裡卻沒有對應");
        }
    }

    #[test]
    fn schema_qualified_omits_dbo_only() {
        assert_eq!(schema_qualified("dbo", "sp_x".into()), "sp_x");
        assert_eq!(schema_qualified("sales", "sp_x".into()), "sales.sp_x");
        // 與 split_schema_table 互為反向。
        assert_eq!(split_schema_table("sales.sp_x"), ("sales".to_string(), "sp_x".to_string()));
        assert_eq!(split_schema_table("sp_x"), ("dbo".to_string(), "sp_x".to_string()));
    }

    #[test]
    fn batch_returns_rows_plain_reads_and_writes() {
        assert!(batch_returns_rows("SELECT * FROM t"));
        assert!(batch_returns_rows("-- 註解
WITH c AS (SELECT 1 AS x) SELECT * FROM c"));
        assert!(batch_returns_rows("EXEC sp_who2"));
        assert!(!batch_returns_rows("UPDATE t SET a = 1 WHERE id = 2"));
        assert!(!batch_returns_rows("DELETE FROM t WHERE id IN (SELECT id FROM u)"));
        assert!(!batch_returns_rows("INSERT INTO t (a) SELECT a FROM u UNION SELECT 2"));
        assert!(!batch_returns_rows("INSERT INTO t EXEC dbo.p"));
    }

    #[test]
    fn batch_returns_rows_sees_select_after_procedural_head() {
        // 前端依 GO 整批送來：開頭不是 SELECT 也可能回列。
        assert!(batch_returns_rows("DECLARE @n int = 1;
SELECT @n"));
        assert!(batch_returns_rows("SET NOCOUNT ON
SELECT 1"));
        assert!(batch_returns_rows("IF EXISTS (SELECT 1 FROM t) SELECT 'yes'"));
        assert!(batch_returns_rows("INSERT INTO t VALUES (1)
SELECT SCOPE_IDENTITY()"));
        assert!(batch_returns_rows("UPDATE t SET a = 1; SELECT * FROM t"));
        assert!(batch_returns_rows("UPDATE t SET a = 1 OUTPUT inserted.* WHERE id = 1"));
        assert!(!batch_returns_rows("IF EXISTS (SELECT 1 FROM t) DELETE FROM t"));
        assert!(!batch_returns_rows("BEGIN TRAN; UPDATE t SET a = 1; COMMIT"));
    }

    #[test]
    fn batch_returns_rows_ignores_module_bodies_cursors_and_literals() {
        assert!(!batch_returns_rows("CREATE PROCEDURE dbo.p AS BEGIN SELECT 1; END"));
        assert!(!batch_returns_rows("CREATE OR ALTER VIEW v AS SELECT 1 AS x"));
        assert!(!batch_returns_rows("ALTER FUNCTION f() RETURNS TABLE AS RETURN (SELECT 1 AS x)"));
        assert!(!batch_returns_rows("DECLARE c CURSOR FOR SELECT id FROM t"));
        assert!(!batch_returns_rows("UPDATE t SET note = 'select * from x' -- select"));
        // T-SQL 字串結尾的反斜線不是跳脫：後面的 SELECT 要看得到。
        assert!(batch_returns_rows(r"UPDATE t SET p = 'C:\backup\'; SELECT 1"));
        assert!(batch_returns_rows("CREATE TABLE #x (a int); SELECT * FROM #x"));
    }

    #[test]
    fn ddl_column_line_keeps_identity_seed_and_computed_formula() {
        let base = || DdlColumn { name: "id", type_str: "bigint", nullable: false, identity: None, default: None, computed: None };
        assert_eq!(
            ddl_column_line(&DdlColumn { identity: Some(("1000".into(), "5".into())), ..base() }),
            "  [id] bigint IDENTITY(1000,5) NOT NULL"
        );
        let total = DdlColumn { name: "total", computed: Some(("([qty]*[price])".into(), true)), ..base() };
        assert_eq!(ddl_column_line(&total), "  [total] AS ([qty]*[price]) PERSISTED");
        let d = DdlColumn { name: "a]b", type_str: "nvarchar(10)", nullable: true, default: Some("(N'x')".into()), ..base() };
        assert_eq!(ddl_column_line(&d), "  [a]]b] nvarchar(10) NULL DEFAULT (N'x')");
    }

    #[test]
    fn mssql_type_str_writes_non_default_time_scale() {
        assert_eq!(mssql_type_str("datetime2", 8, 27, 7), "datetime2");
        assert_eq!(mssql_type_str("datetime2", 6, 19, 0), "datetime2(0)");
        assert_eq!(mssql_type_str("time", 5, 12, 3), "time(3)");
        assert_eq!(mssql_type_str("datetimeoffset", 10, 34, 7), "datetimeoffset");
        assert_eq!(mssql_type_str("nvarchar", -1, 0, 0), "nvarchar(MAX)");
        assert_eq!(mssql_type_str("nvarchar", 100, 0, 0), "nvarchar(50)");
    }

    #[test]
    fn column_data_to_string_handles_types_that_used_to_show_null() {
        use std::borrow::Cow;
        use tiberius::ColumnData as Cd;
        // 可為 NULL 的 real：宣告型別 Floatn、資料是 F32（以前 try_get::<f64> 失敗 → 顯示 NULL）。
        assert_eq!(column_data_to_string(&Cd::F32(Some(1.5)), false).as_deref(), Some("1.5"));
        assert_eq!(column_data_to_string(&Cd::F32(None), false), None);
        // xml 欄位（以前 try_get::<&str> 失敗 → 顯示 NULL）。
        let xml = tiberius::xml::XmlData::new("<a>1</a>");
        assert_eq!(column_data_to_string(&Cd::Xml(Some(Cow::Owned(xml))), false).as_deref(), Some("<a>1</a>"));
        // money 照 SSMS 顯示四位小數。
        assert_eq!(column_data_to_string(&Cd::F64(Some(12.5)), true).as_deref(), Some("12.5000"));
        assert_eq!(column_data_to_string(&Cd::F64(Some(12.5)), false).as_deref(), Some("12.5"));
    }

    #[test]
    fn column_data_to_string_keeps_datetimeoffset_offset() {
        use tiberius::time::{Date, DateTime2, DateTimeOffset, Time};
        use tiberius::ColumnData as Cd;
        // TDS 存的是 UTC 時間與位移：2024-01-02 02:00 UTC、+480 分鐘 → 當地 10:00 +08:00。
        let days = chrono::NaiveDate::from_ymd_opt(2024, 1, 2).unwrap().signed_duration_since(chrono::NaiveDate::from_ymd_opt(1, 1, 1).unwrap()).num_days() as u32;
        let utc_2am = Time::new(2 * 3600 * 10_000_000, 7);
        let dto = DateTimeOffset::new(DateTime2::new(Date::new(days), utc_2am), 480);
        assert_eq!(
            column_data_to_string(&Cd::DateTimeOffset(Some(dto)), false).as_deref(),
            Some("2024-01-02 10:00:00 +08:00")
        );
    }
}
