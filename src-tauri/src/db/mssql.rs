use std::time::Duration;

use bb8::Pool;
use bb8_tiberius::ConnectionManager;
use tiberius::{AuthMethod, ColumnType, Config, EncryptionLevel};

use crate::db::{
    filter_op_sql, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, Filter, PagedData,
    PoolStatus, QueryResult, RowDelete, RowInsert, CellEdit, Sort, SortDir, TableInfo,
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
        let head = sql.trim_start();
        let is_read = starts_ci(head, "select") || starts_ci(head, "with") || starts_ci(head, "exec") || starts_ci(head, "show");
        if is_read {
            let rows = self.query_rows(sql).await?;
            let columns: Vec<String> = rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let data = rows
                .iter()
                .map(|r| (0..columns.len()).map(|i| cell_to_string(r, i)).collect())
                .collect();
            Ok(QueryResult { columns, rows: data, rows_affected: 0 })
        } else {
            let n = self.exec(sql).await?;
            Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: n })
        }
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
            return Err(AppError::Query("欄位與值數量不符".to_string()));
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
        return Err(AppError::Query("缺少主鍵，無法定位列".to_string()));
    }
    let mut parts = Vec::with_capacity(cols.len());
    for (c, v) in cols.iter().zip(vals.iter()) {
        match v {
            Some(val) => parts.push(format!("[{}] = {}", esc(c), lit(val))),
            None => return Err(AppError::Query("主鍵值為 NULL，無法安全定位列".to_string())),
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
