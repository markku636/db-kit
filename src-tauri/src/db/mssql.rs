use std::time::Duration;

use bb8::Pool;
use bb8_tiberius::ConnectionManager;
use tiberius::{AuthMethod, ColumnType, Config, EncryptionLevel};

use crate::db::{
    filter_op_sql, fmt_bytes, CellEdit, ColumnInfo, ColumnStats, ConnectionConfig, DataQuery,
    DatabaseDriver, ErColumn, ErModel, ErRelation, ErTable, Filter, ForeignKeyInfo, IndexInfo,
    PagedData, PoolStatus, QueryResult, RoutineInfo, RowDelete, RowInsert, Sort, SortDir, TableInfo,
};
use crate::error::{AppError, AppResult};

/// Microsoft SQL Server 驅動（TDS，透過 tiberius + bb8 連線池）。
/// schema 三層模型映射：database 節點＝真實 DB（sys.databases）；table 名內嵌 schema
/// （dbo 表回裸名、非 dbo 回 `schema.table`），SQL 一律用三部式限定 `[db].[schema].[table]`。
pub struct MssqlDriver {
    pool: Pool<ConnectionManager>,
    #[allow(dead_code)]
    default_db: Option<String>,
}

impl MssqlDriver {
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
        let sql = format!(
            "SELECT c.name, ty.name, c.is_nullable, c.is_identity, dc.definition \
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
                let data_type = get_str(r, 1).unwrap_or_default();
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

    async fn table_data(&self, database: &str, table: &str, query: &DataQuery) -> AppResult<PagedData> {
        let (schema, tbl) = split_schema_table(table);
        let qualified = qualified_name(database, &schema, &tbl);
        let where_sql = build_where(&query.filters, query.match_any);

        let total = if query.count {
            let sql = format!("SELECT COUNT(*) FROM {qualified} {where_sql}");
            let rows = self.query_rows(&sql).await?;
            rows.first()
                .and_then(|r| r.try_get::<i32, _>(0).ok().flatten())
                .unwrap_or(0) as u64
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
        let head = sql.trim_start();
        let is_read = starts_ci(head, "select") || starts_ci(head, "with") || starts_ci(head, "exec") || starts_ci(head, "show");
        if is_read {
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
            let n = self.exec(sql).await?;
            Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: n, truncated: false })
        }
    }

    async fn query_multi_capped(&self, sql: &str, cap: usize) -> AppResult<Vec<QueryResult>> {
        let head = sql.trim_start();
        let is_read = starts_ci(head, "select") || starts_ci(head, "with") || starts_ci(head, "exec") || starts_ci(head, "show");
        if !is_read {
            let n = self.exec(sql).await?;
            return Ok(vec![QueryResult { columns: vec![], rows: vec![], rows_affected: n, truncated: false }]);
        }
        let sets = self.query_sets_capped(sql, cap).await?;
        if sets.is_empty() {
            // 至少一筆不變量（無任何 Metadata/Row 的極端情況）。
            return Ok(vec![QueryResult::default()]);
        }
        Ok(sets)
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
        // 預存程序 / 函式。
        let sql = format!(
            "SELECT s.name, o.name, o.type, CONVERT(NVARCHAR(30), o.modify_date, 120) \
             FROM [{db}].sys.objects o JOIN [{db}].sys.schemas s ON o.schema_id = s.schema_id \
             WHERE o.type IN ('P','FN','IF','TF','AF') AND o.is_ms_shipped = 0 \
             ORDER BY o.type, o.name"
        );
        let mut out = Vec::new();
        for r in &self.query_rows(&sql).await? {
            let sch = get_str(r, 0).unwrap_or_else(|| "dbo".to_string());
            let nm = match get_str(r, 1) {
                Some(n) => n,
                None => continue,
            };
            let ty = get_str(r, 2).unwrap_or_default();
            let routine_type = if ty.trim() == "P" { "procedure" } else { "function" };
            let name = if sch == "dbo" { nm } else { format!("{sch}.{nm}") };
            out.push(RoutineInfo {
                name,
                routine_type: routine_type.to_string(),
                parent: None,
                signature: None,
                modified: get_str(r, 3),
                deterministic: None,
                comment: None,
            });
        }
        // 觸發器（掛在資料表上）。
        let tsql = format!(
            "SELECT t.name, OBJECT_NAME(t.parent_id, DB_ID(N'{db_raw}')), CONVERT(NVARCHAR(30), t.modify_date, 120) \
             FROM [{db}].sys.triggers t WHERE t.is_ms_shipped = 0 AND t.parent_class = 1 ORDER BY t.name",
            db_raw = database.replace('\'', "''")
        );
        if let Ok(trows) = self.query_rows(&tsql).await {
            for r in &trows {
                if let Some(nm) = get_str(r, 0) {
                    out.push(RoutineInfo {
                        name: nm,
                        routine_type: "trigger".to_string(),
                        parent: get_str(r, 1),
                        signature: None,
                        modified: get_str(r, 2),
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
        let obj = object_literal(database, &schema, &obj_name);
        let rows = self.query_rows(&format!("SELECT OBJECT_DEFINITION(OBJECT_ID({obj}))")).await?;
        rows.first()
            .and_then(|r| get_str(r, 0))
            .ok_or_else(|| AppError::Query(t!("取不到定義（可能無權限或物件不存在）").to_string()))
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        let (schema, tbl) = split_schema_table(table);
        let obj = object_literal(database, &schema, &tbl);
        // 檢視 / 程序 / 函式：直接回其定義。
        if let Some(def) = self
            .query_rows(&format!("SELECT OBJECT_DEFINITION(OBJECT_ID({obj}))"))
            .await?
            .first()
            .and_then(|r| get_str(r, 0))
        {
            return Ok(def);
        }
        // 資料表：從 sys.columns 重建 CREATE TABLE（欄位 + PK）。
        let db = esc(database);
        let sql = format!(
            "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, dc.definition \
             FROM [{db}].sys.columns c \
             JOIN [{db}].sys.types ty ON c.user_type_id = ty.user_type_id \
             LEFT JOIN [{db}].sys.default_constraints dc ON c.default_object_id = dc.object_id \
             WHERE c.object_id = OBJECT_ID({obj}) ORDER BY c.column_id"
        );
        let rows = self.query_rows(&sql).await?;
        if rows.is_empty() {
            return Err(AppError::Query(t!("找不到資料表欄位").to_string()));
        }
        let mut lines: Vec<String> = Vec::new();
        for r in &rows {
            let name = get_str(r, 0).unwrap_or_default();
            let ty = get_str(r, 1).unwrap_or_default();
            let max_len = r.try_get::<i16, _>(2).ok().flatten().unwrap_or(0);
            let precision = r.try_get::<u8, _>(3).ok().flatten().unwrap_or(0);
            let scale = r.try_get::<u8, _>(4).ok().flatten().unwrap_or(0);
            let nullable = r.try_get::<bool, _>(5).ok().flatten().unwrap_or(true);
            let identity = r.try_get::<bool, _>(6).ok().flatten().unwrap_or(false);
            let default = get_str(r, 7);
            let type_str = mssql_type_str(&ty, max_len, precision, scale);
            let mut def = format!("  [{}] {type_str}", esc(&name));
            if identity {
                def.push_str(" IDENTITY(1,1)");
            }
            def.push_str(if nullable { " NULL" } else { " NOT NULL" });
            if let Some(d) = default {
                def.push_str(&format!(" DEFAULT {d}"));
            }
            lines.push(def);
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
        let mut conn = self.pool.get().await.map_err(|e| AppError::Query(e.to_string()))?;
        // SET SHOWPLAN_XML ON：回傳估計執行計畫 XML（不真的執行查詢）；須為獨立批次並 consume 結果。
        conn.simple_query("SET SHOWPLAN_XML ON")
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
            .into_results()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let plan = {
            let stream = conn.query(sql, &[]).await.map_err(|e| AppError::Query(e.to_string()))?;
            let rows = stream.into_first_result().await.map_err(|e| AppError::Query(e.to_string()))?;
            rows.first().and_then(|r| get_str(r, 0)).unwrap_or_default()
        };
        // 關閉，避免污染回收到 pool 的連線（consume 結果；失敗時 pool 的 is_valid 檢查會汰換）。
        let _ = conn.simple_query("SET SHOWPLAN_XML OFF").await;
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

/// 三部式限定名 `[db].[schema].[table]`。
fn qualified_name(db: &str, schema: &str, table: &str) -> String {
    format!("[{}].[{}].[{}]", esc(db), esc(schema), esc(table))
}

/// 供 OBJECT_ID() 用的字串字面值 `N'[db].[schema].[table]'`。
fn object_literal(db: &str, schema: &str, table: &str) -> String {
    lit(&format!("[{}].[{}].[{}]", esc(db), esc(schema), esc(table)))
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
        "datetime2" | "time" | "datetimeoffset" if scale > 0 => format!("{ty}({scale})"),
        _ => ty.to_string(),
    }
}

fn starts_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix)
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

/// tiberius 型別 → 顯示字串。依 ColumnType 精準分派 try_get。NULL / 取值失敗回 None。
fn cell_to_string(row: &tiberius::Row, idx: usize) -> Option<String> {
    let col = row.columns().get(idx)?;
    match col.column_type() {
        ColumnType::Bit | ColumnType::Bitn => {
            row.try_get::<bool, _>(idx).ok().flatten().map(|v| v.to_string())
        }
        ColumnType::Int1 => row.try_get::<u8, _>(idx).ok().flatten().map(|v| v.to_string()),
        ColumnType::Int2 => row.try_get::<i16, _>(idx).ok().flatten().map(|v| v.to_string()),
        ColumnType::Int4 => row.try_get::<i32, _>(idx).ok().flatten().map(|v| v.to_string()),
        ColumnType::Int8 => row.try_get::<i64, _>(idx).ok().flatten().map(|v| v.to_string()),
        ColumnType::Intn => row
            .try_get::<i64, _>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string())
            .or_else(|| row.try_get::<i32, _>(idx).ok().flatten().map(|v| v.to_string()))
            .or_else(|| row.try_get::<i16, _>(idx).ok().flatten().map(|v| v.to_string()))
            .or_else(|| row.try_get::<u8, _>(idx).ok().flatten().map(|v| v.to_string())),
        ColumnType::Float4 => row.try_get::<f32, _>(idx).ok().flatten().map(|v| v.to_string()),
        ColumnType::Float8 | ColumnType::Floatn => {
            row.try_get::<f64, _>(idx).ok().flatten().map(|v| v.to_string())
        }
        ColumnType::Money | ColumnType::Money4 => row
            .try_get::<f64, _>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string())
            .or_else(|| row.try_get::<tiberius::numeric::Numeric, _>(idx).ok().flatten().map(|v| v.to_string())),
        ColumnType::Decimaln | ColumnType::Numericn => row
            .try_get::<tiberius::numeric::Numeric, _>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        ColumnType::Guid => row.try_get::<uuid::Uuid, _>(idx).ok().flatten().map(|v| v.to_string()),
        ColumnType::Daten => {
            row.try_get::<chrono::NaiveDate, _>(idx).ok().flatten().map(|v| v.to_string())
        }
        ColumnType::Timen => {
            row.try_get::<chrono::NaiveTime, _>(idx).ok().flatten().map(|v| v.to_string())
        }
        ColumnType::Datetime | ColumnType::Datetime4 | ColumnType::Datetimen | ColumnType::Datetime2 => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .ok()
            .flatten()
            .map(|v| v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        ColumnType::DatetimeOffsetn => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string()),
        ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image => row
            .try_get::<&[u8], _>(idx)
            .ok()
            .flatten()
            .map(crate::db::bytes_to_display),
        ColumnType::Null => None,
        // NVarchar / NChar / BigVarChar / BigChar / Text / NText / Xml / Udt / SSVariant → 字串。
        _ => row.try_get::<&str, _>(idx).ok().flatten().map(|v| v.to_string()),
    }
}
