use sqlx::mysql::{MySqlPoolOptions, MySqlRow};
use sqlx::{Column, MySqlPool, Row, TypeInfo, ValueRef};
use std::time::Duration;

use crate::db::{
    collect_relations, filter_op_sql, fmt_bytes, op_needs_value, AlterOp, CellEdit, ColumnInfo, ColumnStats,
    ConnectionConfig, DataQuery, DatabaseDriver, ErColumn, ErModel, ErTable, Filter, ForeignKeyInfo, IndexInfo,
    PagedData, PoolStatus, QueryResult, RoutineInfo, RowDelete, RowInsert, Sort, SortDir, TableInfo,
};
use crate::error::{AppError, AppResult};

/// MySQL 驅動：包一個 sqlx 連線池。
///
/// 連線生命週期（呼應規劃 3.5）：
/// - max_connections / idle_timeout / max_lifetime 由 pool 管理
/// - test_before_acquire 在取得連線前做健康檢查，淘汰殭屍連線
/// - Drop / close 時 drain pool
pub struct MysqlDriver {
    pool: MySqlPool,
    /// 連線時的預設資料庫；drop_database 用以阻擋刪除「使用中的預設庫」（會使連線後續查詢失效）。
    default_db: Option<String>,
}

/// MySQL 系統資料庫（不可刪除）。
const MYSQL_SYSTEM_DBS: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

#[async_trait::async_trait]
impl DatabaseDriver for MysqlDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let db = config.database.clone().unwrap_or_default();
        let url = format!(
            "mysql://{user}:{pass}@{host}:{port}/{db}",
            user = config.username,
            pass = config.password,
            host = config.host,
            port = config.port,
            db = db,
        );

        let pool = MySqlPoolOptions::new()
            .max_connections(config.max_connections)
            .min_connections(0)
            .idle_timeout(Duration::from_secs(300)) // 閒置 5 分鐘回收
            .max_lifetime(Duration::from_secs(1800)) // 連線最長存活 30 分鐘
            .acquire_timeout(Duration::from_secs(10))
            .test_before_acquire(true) // 取得前健康檢查
            .connect(&url)
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;

        let default_db = config.database.clone().filter(|s| !s.is_empty());
        let driver = Self { pool, default_db };
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
        // 用 information_schema.SCHEMATA（SCHEMA_NAME 為 varchar，可穩定解碼成 String）；
        // 不用 `SHOW DATABASES`——其欄位在 sqlx-mysql 常被當成 binary，try_get::<String> 會失敗
        // 而被 .ok() 默默丟棄，導致整個資料庫清單變空（連線樹展不開）。
        let rows = sqlx::query(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows.iter().filter_map(|r| str_col(r, 0)).collect())
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        // information_schema 統一取表與視圖。
        let sql = "SELECT TABLE_NAME, TABLE_TYPE \
                   FROM information_schema.TABLES \
                   WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME";
        let rows = sqlx::query(sql)
            .bind(database)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = str_col(r, 0)?;
                let ttype = str_col(r, 1).unwrap_or_default();
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
        let sql = "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, \
                   COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT \
                   FROM information_schema.COLUMNS \
                   WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                   ORDER BY ORDINAL_POSITION";
        let rows = sqlx::query(sql)
            .bind(database)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .map(|r| ColumnInfo {
                name: str_col(r, 0).unwrap_or_default(),
                data_type: str_col(r, 1).unwrap_or_default(),
                nullable: str_col(r, 2)
                    .map(|v| v.eq_ignore_ascii_case("YES"))
                    .unwrap_or(false),
                key: str_col(r, 3).unwrap_or_default(),
                default: str_col(r, 4),
                extra: str_col(r, 5).unwrap_or_default(),
                comment: str_col(r, 6).unwrap_or_default(),
            })
            .collect())
    }

    async fn table_data(
        &self,
        database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        let q_db = quote_ident(database);
        let q_tbl = quote_ident(table);
        let offset = query.page.saturating_mul(query.page_size);
        let page_size = query.page_size;

        // 組 WHERE（運算子白名單檢查；值以 ? 綁定）
        let (where_sql, bind_values) = build_where(&query.filters, query.match_any)?;
        // 組 ORDER BY（只允許識別字，方向限定）
        let order_sql = build_order(&query.sorts);

        // 總列數（套用相同篩選）
        let count_sql = format!("SELECT COUNT(*) FROM {q_db}.{q_tbl}{where_sql}");
        let mut cq = sqlx::query_scalar::<_, i64>(&count_sql);
        for v in &bind_values {
            cq = cq.bind(v.clone());
        }
        let total: i64 = cq
            .fetch_one(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;

        let data_sql = format!(
            "SELECT * FROM {q_db}.{q_tbl}{where_sql}{order_sql} LIMIT {page_size} OFFSET {offset}"
        );
        let mut dq = sqlx::query(&data_sql);
        for v in &bind_values {
            dq = dq.bind(v.clone());
        }
        let rows = dq
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;

        let primary_key = self.primary_key(database, table).await?;

        let result = rows_to_result(&rows);
        Ok(PagedData {
            columns: result.columns,
            rows: result.rows,
            total_rows: total as u64,
            page: query.page,
            page_size,
            primary_key,
        })
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_read = trimmed.starts_with("select")
            || trimmed.starts_with("show")
            || trimmed.starts_with("describe")
            || trimmed.starts_with("explain");

        if is_read {
            let rows = sqlx::query(sql)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            Ok(rows_to_result(&rows))
        } else {
            let res = sqlx::query(sql)
                .execute(&self.pool)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: res.rows_affected(),
            })
        }
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

    async fn update_cell(
        &self,
        database: &str,
        table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64> {
        if edit.pk_columns.is_empty() {
            return Err(AppError::Query(
                "此表無主鍵，無法安全更新".to_string(),
            ));
        }
        if edit.pk_columns.len() != edit.pk_values.len() {
            return Err(AppError::Query("主鍵欄位與值數量不符".to_string()));
        }
        // 任一主鍵值為 NULL 則拒絕（無法以 = 安全比對）。
        if edit.pk_values.iter().any(|v| v.is_none()) {
            return Err(AppError::Query(
                "主鍵值為 NULL，無法定位該列".to_string(),
            ));
        }

        let q_db = quote_ident(database);
        let q_tbl = quote_ident(table);
        let q_col = quote_ident(&edit.column);

        let where_clause = edit
            .pk_columns
            .iter()
            .map(|c| format!("{} = ?", quote_ident(c)))
            .collect::<Vec<_>>()
            .join(" AND ");

        let sql = format!(
            "UPDATE {q_db}.{q_tbl} SET {q_col} = ? WHERE {where_clause}"
        );

        // 綁定：先 SET 值，再各主鍵值。以字串綁定，交由 MySQL 隱式轉型。
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
        let q_db = quote_ident(database);
        let q_tbl = quote_ident(table);
        let cols = row
            .columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = vec!["?"; row.values.len()].join(", ");
        let sql = format!("INSERT INTO {q_db}.{q_tbl} ({cols}) VALUES ({placeholders})");
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
        let q_db = quote_ident(database);
        let q_tbl = quote_ident(table);
        let where_clause = del
            .pk_columns
            .iter()
            .map(|c| format!("{} = ?", quote_ident(c)))
            .collect::<Vec<_>>()
            .join(" AND ");
        let sql = format!("DELETE FROM {q_db}.{q_tbl} WHERE {where_clause}");
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
        })
    }

    async fn create_database(&self, name: &str) -> AppResult<()> {
        // 識別字無法參數化；以反引號跳脫防注入。
        let sql = format!("CREATE DATABASE {}", quote_ident(name));
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn drop_database(&self, name: &str) -> AppResult<()> {
        // 後端硬性護欄：系統庫一律拒絕；使用中的預設庫亦拒絕（drop 後連線預設 schema 失效）。
        if MYSQL_SYSTEM_DBS.iter().any(|s| s.eq_ignore_ascii_case(name)) {
            return Err(AppError::Query(format!("拒絕刪除 MySQL 系統資料庫「{name}」")));
        }
        if self.default_db.as_deref() == Some(name) {
            return Err(AppError::Query(format!(
                "「{name}」是此連線使用中的預設資料庫，無法刪除；請改用其他連線或先變更連線預設庫"
            )));
        }
        let sql = format!("DROP DATABASE {}", quote_ident(name));
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn list_routines(&self, database: &str) -> AppResult<Vec<RoutineInfo>> {
        let mut out = Vec::new();
        let rows = sqlx::query(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE, \
             DATE_FORMAT(LAST_ALTERED, '%Y-%m-%d %H:%i:%s'), IS_DETERMINISTIC, ROUTINE_COMMENT \
             FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        for r in &rows {
            if let Some(name) = str_col(r, 0) {
                let rt = str_col(r, 1).unwrap_or_default().to_lowercase(); // procedure | function
                // 決定性僅對函式有意義；程序不顯示。
                let deterministic = if rt == "function" {
                    str_col(r, 3).map(|s| s.eq_ignore_ascii_case("yes"))
                } else {
                    None
                };
                out.push(RoutineInfo {
                    name,
                    routine_type: rt,
                    parent: None,
                    signature: None,
                    modified: str_col(r, 2),
                    deterministic,
                    comment: str_col(r, 4).filter(|s| !s.is_empty()),
                });
            }
        }
        let trows = sqlx::query(
            "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, DATE_FORMAT(CREATED, '%Y-%m-%d %H:%i:%s') \
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        for r in &trows {
            if let Some(name) = str_col(r, 0) {
                out.push(RoutineInfo {
                    name,
                    routine_type: "trigger".into(),
                    parent: str_col(r, 1),
                    signature: None,
                    modified: str_col(r, 2),
                    deterministic: None,
                    comment: None,
                });
            }
        }
        // 事件（MySQL 事件排程器）。
        let erows = sqlx::query(
            "SELECT EVENT_NAME, DATE_FORMAT(LAST_ALTERED, '%Y-%m-%d %H:%i:%s'), EVENT_COMMENT \
             FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        for r in &erows {
            if let Some(name) = str_col(r, 0) {
                out.push(RoutineInfo {
                    name,
                    routine_type: "event".into(),
                    parent: None,
                    signature: None,
                    modified: str_col(r, 1),
                    deterministic: None,
                    comment: str_col(r, 2).filter(|s| !s.is_empty()),
                });
            }
        }
        Ok(out)
    }

    async fn routine_definition(&self, database: &str, name: &str, routine_type: &str) -> AppResult<String> {
        let qn = format!("{}.{}", quote_ident(database), quote_ident(name));
        let stmt = match routine_type {
            "procedure" => format!("SHOW CREATE PROCEDURE {qn}"),
            "function" => format!("SHOW CREATE FUNCTION {qn}"),
            "trigger" => format!("SHOW CREATE TRIGGER {qn}"),
            "event" => format!("SHOW CREATE EVENT {qn}"),
            _ => return Err(AppError::Query(format!("未知的程序類型「{routine_type}」"))),
        };
        // SHOW CREATE EVENT 的定義在第 4 欄（index 3）；其餘在第 3 欄（index 2）。
        let def_idx = if routine_type == "event" { 3 } else { 2 };
        let row = sqlx::query(&stmt)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        str_col(&row, def_idx).ok_or_else(|| AppError::Query("無法取得定義（可能權限不足）".into()))
    }

    async fn exec_ddl(&self, sql: &str) -> AppResult<()> {
        // 簡單查詢協定（COM_QUERY）：支援 CREATE PROCEDURE / TRIGGER（prepared 協定不支援）。
        use sqlx::Executor;
        self.pool
            .execute(sql)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        let rows = sqlx::query(
            "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
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
                    name: str_col(r, 0)?,
                    column: str_col(r, 1)?,
                    ref_table: str_col(r, 2)?,
                    ref_column: str_col(r, 3)?,
                })
            })
            .collect())
    }

    async fn table_info(&self, database: &str, table: &str) -> AppResult<Vec<(String, String)>> {
        // 數值欄 CAST 成 CHAR 以統一用 str_col 解碼（避免 unsigned bigint 型別不符）。
        let row = sqlx::query(
            "SELECT ENGINE, CAST(TABLE_ROWS AS CHAR), CAST(DATA_LENGTH AS CHAR), \
             CAST(INDEX_LENGTH AS CHAR), TABLE_COLLATION, CAST(CREATE_TIME AS CHAR), TABLE_COMMENT \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        )
        .bind(database)
        .bind(table)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out = Vec::new();
        if let Some(r) = row {
            let push_str = |out: &mut Vec<(String, String)>, label: &str, idx: usize| {
                if let Some(v) = str_col(&r, idx) {
                    if !v.is_empty() {
                        out.push((label.to_string(), v));
                    }
                }
            };
            push_str(&mut out, "引擎", 0);
            push_str(&mut out, "列數（估計）", 1);
            if let Some(b) = str_col(&r, 2).and_then(|s| s.parse::<i64>().ok()) {
                out.push(("資料大小".into(), fmt_bytes(b)));
            }
            if let Some(b) = str_col(&r, 3).and_then(|s| s.parse::<i64>().ok()) {
                out.push(("索引大小".into(), fmt_bytes(b)));
            }
            push_str(&mut out, "排序規則", 4);
            push_str(&mut out, "建立時間", 5);
            push_str(&mut out, "註解", 6);
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
                let nn = if *nullable { " NULL" } else { " NOT NULL" };
                format!("ALTER TABLE {q_tbl} MODIFY COLUMN {} {data_type}{nn}", quote_ident(name))
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
            "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        let (relations, fk_cols) = collect_relations(&fk_rows, |r, i| str_col(r, i));
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
        // SHOW CREATE TABLE 回兩欄：Table 名、Create Table 語句（取第 2 欄）。
        let sql = format!("SHOW CREATE TABLE {}.{}", quote_ident(database), quote_ident(table));
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        str_col(&row, 1)
            .map(|ddl| format!("{ddl};"))
            .ok_or_else(|| AppError::Query("無法取得建表語句".into()))
    }

    async fn table_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        // information_schema.STATISTICS 的型別比 SHOW INDEX 穩定（varchar / bigint）。
        let rows = sqlx::query(
            "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out: Vec<IndexInfo> = Vec::new();
        for r in &rows {
            let name = str_col(r, 0).unwrap_or_default();
            let col = str_col(r, 1).unwrap_or_default();
            let non_unique = r
                .try_get::<i64, _>(2)
                .or_else(|_| r.try_get::<i32, _>(2).map(|v| v as i64))
                .unwrap_or(1);
            if let Some(ix) = out.iter_mut().find(|x| x.name == name) {
                ix.columns.push(col);
            } else {
                out.push(IndexInfo {
                    unique: non_unique == 0,
                    primary: name == "PRIMARY",
                    columns: vec![col],
                    name,
                });
            }
        }
        Ok(out)
    }

    async fn drop_index(&self, database: &str, table: &str, index: &str) -> AppResult<()> {
        let sql = format!(
            "DROP INDEX {} ON {}.{}",
            quote_ident(index),
            quote_ident(database),
            quote_ident(table)
        );
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
        self.pool.close().await;
    }
}

impl MysqlDriver {
    /// 取得表的主鍵欄位（依序）。無主鍵則回空。
    async fn primary_key(&self, database: &str, table: &str) -> AppResult<Vec<String>> {
        let sql = "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
                   WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                   AND CONSTRAINT_NAME = 'PRIMARY' \
                   ORDER BY ORDINAL_POSITION";
        let rows = sqlx::query(sql)
            .bind(database)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows.iter().filter_map(|r| str_col(r, 0)).collect())
    }
}

/// 以反引號包裹識別字，並轉義內部反引號，防止 SQL 注入。
fn quote_ident(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

/// 穩健讀取字串欄位：先試 String，失敗則以 bytes 解碼。
/// sqlx-mysql 對部分 information_schema 欄位（如 SCHEMATA.SCHEMA_NAME）會回 binary，
/// 直接 try_get::<String> 會失敗——若再用 .ok() 默默丟棄，整個清單就變空。
fn str_col(row: &MySqlRow, idx: usize) -> Option<String> {
    row.try_get::<String, _>(idx).ok().or_else(|| {
        row.try_get::<Vec<u8>, _>(idx)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    })
}

/// 組 WHERE 子句（MySQL `?` 佔位符）。回傳 (sql_片段, 需綁定的值)。
/// sql_片段含前導空白與 " WHERE "，無篩選則為空字串。
fn build_where(filters: &[Filter], match_any: bool) -> AppResult<(String, Vec<Option<String>>)> {
    if filters.is_empty() {
        return Ok((String::new(), vec![]));
    }
    let mut clauses = Vec::new();
    let mut binds = Vec::new();
    for f in filters {
        let op = filter_op_sql(&f.op)
            .ok_or_else(|| AppError::Query(format!("不支援的運算子：{}", f.op)))?;
        let col = quote_ident(&f.column);
        if op_needs_value(&f.op) {
            clauses.push(format!("{col} {op} ?"));
            binds.push(f.value.clone());
        } else {
            clauses.push(format!("{col} {op}"));
        }
    }
    let connector = if match_any { " OR " } else { " AND " };
    Ok((format!(" WHERE {}", clauses.join(connector)), binds))
}

/// 組 ORDER BY 子句（識別字 + 方向，無值綁定）。
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

/// 將 MySQL 列轉成字串格. 盡量以文字呈現，型別細節留待後續加強。
fn rows_to_result(rows: &[MySqlRow]) -> QueryResult {
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
    }
}

/// 嘗試以常見型別讀取單一儲存格並轉成字串；NULL 回傳 None。
fn cell_to_string(row: &MySqlRow, idx: usize) -> Option<String> {
    // NULL 偵測
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

    // 依宣告型別嘗試對應 Rust 型別，失敗則退回字串。
    // 註：unsigned 整數的 type_info 名稱帶 " UNSIGNED" 後綴，故以 starts_with 比對。
    let base = type_name
        .split_whitespace()
        .next()
        .unwrap_or(type_name.as_str());
    match base {
        "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" => {
            // 先試 i64，溢位（unsigned bigint）再試 u64。
            row.try_get::<i64, _>(idx)
                .ok()
                .map(|v| v.to_string())
                .or_else(|| row.try_get::<u64, _>(idx).ok().map(|v| v.to_string()))
                .or_else(|| string_fallback(row, idx))
        }
        "FLOAT" | "DOUBLE" => row
            .try_get::<f64, _>(idx)
            .ok()
            .map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        "DECIMAL" => string_fallback(row, idx),
        "BOOLEAN" | "BOOL" => row
            .try_get::<bool, _>(idx)
            .ok()
            .map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        _ => string_fallback(row, idx),
    }
}

fn string_fallback(row: &MySqlRow, idx: usize) -> Option<String> {
    // 依序嘗試常見可轉字串的型別。
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return Some(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<u64, _>(idx) {
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
    // DATETIME → NaiveDateTime；TIMESTAMP → DateTime<Utc>（過去版本漏了 TIMESTAMP，
    // 導致 created_at 之類欄位顯示 <unrenderable>）。
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
    // JSON 欄位（sqlx json 特性）。
    if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return Some(crate::db::bytes_to_display(&v));
    }
    Some("<unrenderable>".to_string())
}
