use sqlx::sqlite::{SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row, SqlitePool, TypeInfo, ValueRef};
use std::time::Duration;

use crate::db::{
    filter_op_sql, finalize_hits, make_snippet, op_needs_value, sqlx_db_message, AlterOp, CellEdit,
    ColumnInfo, ColumnStats, ConnectionConfig, DataQuery, DatabaseDriver, ErColumn, ErModel, ErRelation, ErTable,
    Filter, IndexInfo, PagedData, PoolStatus, QueryResult, RoutineInfo, RowDelete, RowInsert, SearchHit,
    SearchOptions, Sort, SortDir, TableInfo, ValidationReport,
};
use crate::error::{AppError, AppResult};

/// SQLite 驅動。與 MySQL 共用同一套 trait，差異在：
/// - 無 host/port，連線目標是檔案路徑（取自 config.database）
/// - 只有單一資料庫（檔案本身），list_databases 回傳 "main"
pub struct SqliteDriver {
    pool: SqlitePool,
}

#[async_trait::async_trait]
impl DatabaseDriver for SqliteDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        // SQLite 路徑放在 database 欄位；空則用記憶體資料庫。
        let path = config
            .database
            .clone()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ":memory:".to_string());

        // 已存在的檔案才開啟，不自動建立（唯讀檢視語意較安全）。
        let url = if path == ":memory:" {
            "sqlite::memory:".to_string()
        } else {
            format!("sqlite://{path}?mode=rwc")
        };

        let pool = SqlitePoolOptions::new()
            .max_connections(config.max_connections.max(1))
            .idle_timeout(Duration::from_secs(300))
            .acquire_timeout(Duration::from_secs(10))
            .test_before_acquire(true)
            .connect(&url)
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;

        let driver = Self { pool };
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
        // SQLite 單檔即一個資料庫，固定回傳 main。
        Ok(vec!["main".to_string()])
    }

    async fn list_tables(&self, _database: &str) -> AppResult<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name: String = r.try_get(0).ok()?;
                let ttype: String = r.try_get(1).unwrap_or_default();
                Some(TableInfo { name, kind: ttype })
            })
            .collect())
    }

    // SQLite 無預存程序 / 函式，僅有觸發器（存於 sqlite_master）。
    async fn list_routines(&self, _database: &str) -> AppResult<Vec<RoutineInfo>> {
        let rows = sqlx::query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name: String = r.try_get(0).ok()?;
                Some(RoutineInfo { name, routine_type: "trigger".into(), parent: r.try_get::<String, _>(1).ok(), signature: None, modified: None, deterministic: None, comment: None })
            })
            .collect())
    }

    async fn routine_definition(&self, _database: &str, name: &str, _routine_type: &str) -> AppResult<String> {
        let row = sqlx::query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
            .bind(name)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        match row {
            Some(r) => r.try_get::<String, _>(0).map_err(|e| AppError::Query(e.to_string())),
            None => Err(AppError::Query(tf!("找不到觸發器「{name}」", name = name))),
        }
    }

    async fn search_objects(&self, opts: &SearchOptions) -> AppResult<Vec<SearchHit>> {
        if opts.term.is_empty() || opts.no_scope() {
            return Ok(vec![]);
        }
        // SQLite 僅單一邏輯庫 "main"；若指定的 databases 不含 main 則無結果。
        if let Some(list) = &opts.databases {
            if !list.is_empty() && !list.iter().any(|d| d == "main") {
                return Ok(vec![]);
            }
        }
        let pattern = opts.like_pattern();
        let mut hits: Vec<SearchHit> = Vec::new();

        let classify = |name: &str, def: Option<&str>| -> Option<(&'static str, Option<String>)> {
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
            None
        };

        // 1. sqlite_master：表 / 視圖 / 觸發器 / 索引（名稱；view/trigger 另比對 sql 定義內文）。
        let mut conds: Vec<&str> = Vec::new();
        if opts.match_names {
            conds.push("name LIKE ? ESCAPE '\\'");
        }
        if opts.match_definitions {
            conds.push("(type IN ('view','trigger') AND sql LIKE ? ESCAPE '\\')");
        }
        if !conds.is_empty() {
            let sql = format!(
                "SELECT type, name, tbl_name, sql FROM sqlite_master \
                 WHERE type IN ('table','view','trigger','index') AND name NOT LIKE 'sqlite_%' AND ({})",
                conds.join(" OR ")
            );
            let mut q = sqlx::query(&sql);
            for _ in 0..conds.len() {
                q = q.bind(pattern.clone());
            }
            let rows = q
                .fetch_all(&self.pool)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            for r in &rows {
                let otype: String = r.try_get(0).unwrap_or_default();
                if !opts.wants_type(&otype) {
                    continue;
                }
                let name: String = r.try_get(1).unwrap_or_default();
                let tbl: Option<String> = r.try_get(2).ok();
                let def: Option<String> = if otype == "view" || otype == "trigger" {
                    r.try_get::<Option<String>, _>(3).ok().flatten()
                } else {
                    None
                };
                let (m, snip) = match classify(&name, def.as_deref()) {
                    Some(v) => v,
                    None => continue,
                };
                let parent = if otype == "trigger" || otype == "index" { tbl } else { None };
                hits.push(SearchHit {
                    database: "main".into(),
                    object_type: otype,
                    object_name: name,
                    parent,
                    matched_in: m.into(),
                    snippet: snip,
                    extra: None,
                });
            }
        }

        // 2. 欄位（名稱；SQLite 無欄位註解）。逐表 PRAGMA table_info。
        if opts.wants_type("column") && opts.match_names {
            let tlist = sqlx::query(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
            )
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
            for tr in &tlist {
                let table: String = match tr.try_get(0) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let cols = sqlx::query(&format!("PRAGMA table_info({})", quote_ident(&table)))
                    .fetch_all(&self.pool)
                    .await
                    .map_err(|e| AppError::Query(e.to_string()))?;
                for c in &cols {
                    let cname: String = c.try_get(1).unwrap_or_default();
                    if !opts.hit(&cname) {
                        continue;
                    }
                    let ctype: String = c.try_get(2).unwrap_or_default();
                    hits.push(SearchHit {
                        database: "main".into(),
                        object_type: "column".into(),
                        object_name: cname,
                        parent: Some(table.clone()),
                        matched_in: "name".into(),
                        snippet: None,
                        extra: if ctype.is_empty() { None } else { Some(ctype) },
                    });
                }
            }
        }

        Ok(finalize_hits(hits, opts))
    }

    async fn exec_ddl(&self, sql: &str) -> AppResult<()> {
        use sqlx::Executor;
        self.pool
            .execute(sql)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn validate_ddl(&self, _database: &str, sql: &str) -> AppResult<ValidationReport> {
        // SQLite 的 DDL 具交易性：交易內試行 CREATE TRIGGER（建立時即檢查所引用的表 / 欄），再 ROLLBACK。
        use sqlx::Executor;
        let mut tx = self.pool.begin().await.map_err(|e| AppError::Query(e.to_string()))?;
        let res = (&mut *tx).execute(sql).await;
        let _ = tx.rollback().await;
        match res {
            Ok(_) => Ok(ValidationReport::passed()),
            Err(e) => Ok(ValidationReport::failed(sqlx_db_message(&e), None)),
        }
    }

    async fn table_columns(
        &self,
        _database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        // PRAGMA table_info 不支援參數綁定，需手動轉義表名。
        let sql = format!("PRAGMA table_info({})", quote_ident(table));
        let rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        // 欄位順序：cid, name, type, notnull, dflt_value, pk
        Ok(rows
            .iter()
            .map(|r| {
                let notnull: i64 = r.try_get(3).unwrap_or(0);
                let pk: i64 = r.try_get(5).unwrap_or(0);
                ColumnInfo {
                    name: r.try_get(1).unwrap_or_default(),
                    data_type: r.try_get(2).unwrap_or_default(),
                    nullable: notnull == 0,
                    key: if pk > 0 { "PRI".to_string() } else { String::new() },
                    default: r.try_get(4).ok(),
                    extra: String::new(),
                    comment: String::new(),
                }
            })
            .collect())
    }

    async fn table_data(
        &self,
        _database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        let q_tbl = quote_ident(table);
        let offset = query.page.saturating_mul(query.page_size);
        let page_size = query.page_size;

        let (where_sql, bind_values) = build_where(&query.filters, query.match_any)?;
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
            primary_key: self.primary_key(table).await?,
            row_ids: Vec::new(),
        })
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        self.query_capped(sql, 0).await
    }

    async fn query_capped(&self, sql: &str, cap: usize) -> AppResult<QueryResult> {
        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_read = trimmed.starts_with("select")
            || trimmed.starts_with("pragma")
            || trimmed.starts_with("explain");

        // 寫入語句若帶 RETURNING（SQLite 3.35+ 支援），改走 fetch 取回回傳列。
        if is_read || trimmed.contains("returning") {
            use futures::TryStreamExt;
            let mut stream = sqlx::query(sql).fetch(&self.pool);
            let mut rows: Vec<SqliteRow> = Vec::new();
            let mut truncated = false;
            // 逐列取到 cap 即停（cap=0 不限）；SQLite 為本地檔，早停真的省 I/O。
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
        _database: &str,
        table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64> {
        if edit.pk_columns.is_empty() {
            return Err(AppError::Query(t!("此表無主鍵，無法安全更新").to_string()));
        }
        if edit.pk_columns.len() != edit.pk_values.len() {
            return Err(AppError::Query(t!("主鍵欄位與值數量不符").to_string()));
        }
        if edit.pk_values.iter().any(|v| v.is_none()) {
            return Err(AppError::Query(t!("主鍵值為 NULL，無法定位該列").to_string()));
        }

        let q_tbl = quote_ident(table);
        let q_col = quote_ident(&edit.column);
        let where_clause = edit
            .pk_columns
            .iter()
            .map(|c| format!("{} = ?", quote_ident(c)))
            .collect::<Vec<_>>()
            .join(" AND ");

        let sql = format!("UPDATE {q_tbl} SET {q_col} = ? WHERE {where_clause}");
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
        _database: &str,
        table: &str,
        row: &RowInsert,
    ) -> AppResult<u64> {
        if row.columns.is_empty() {
            return Err(AppError::Query(t!("未提供任何欄位").to_string()));
        }
        if row.columns.len() != row.values.len() {
            return Err(AppError::Query(t!("欄位與值數量不符").to_string()));
        }
        let q_tbl = quote_ident(table);
        let cols = row
            .columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = vec!["?"; row.values.len()].join(", ");
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
        _database: &str,
        table: &str,
        del: &RowDelete,
    ) -> AppResult<u64> {
        if del.pk_columns.is_empty() {
            return Err(AppError::Query(t!("此表無主鍵，無法安全刪除").to_string()));
        }
        if del.pk_columns.len() != del.pk_values.len() {
            return Err(AppError::Query(t!("主鍵欄位與值數量不符").to_string()));
        }
        if del.pk_values.iter().any(|v| v.is_none()) {
            return Err(AppError::Query(t!("主鍵值為 NULL，無法定位該列").to_string()));
        }
        let q_tbl = quote_ident(table);
        let where_clause = del
            .pk_columns
            .iter()
            .map(|c| format!("{} = ?", quote_ident(c)))
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

    async fn explain(&self, sql: &str) -> AppResult<QueryResult> {
        let rows = sqlx::query(&format!("EXPLAIN QUERY PLAN {sql}"))
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(rows_to_result(&rows))
    }

    async fn column_stats(&self, _database: &str, table: &str, column: &str) -> AppResult<ColumnStats> {
        // SQLite 不加 db 前綴。
        let qt = quote_ident(table);
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
            ..Default::default()
        })
    }

    async fn alter_table(&self, _database: &str, table: &str, op: &AlterOp) -> AppResult<()> {
        let q_tbl = quote_ident(table);
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
            // SQLite 無法直接改欄位型別 / 預設（需重建表）；明確回報不支援。
            AlterOp::ModifyColumn { .. } => {
                return Err(AppError::Unsupported(
                    t!("SQLite 不支援直接修改欄位型別（需重建資料表）").into(),
                ))
            }
            AlterOp::SetDefault { .. } => {
                return Err(AppError::Unsupported(
                    t!("SQLite 不支援直接修改欄位預設值（需重建資料表）").into(),
                ))
            }
        };
        sqlx::query(&ddl)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(())
    }

    async fn er_model(&self, database: &str) -> AppResult<ErModel> {
        let tlist = self.list_tables(database).await?;
        let mut relations = Vec::new();
        let mut fk_cols: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
        for t in &tlist {
            // PRAGMA foreign_key_list 欄位：id, seq, table, from, to, ...
            let rows = sqlx::query(&format!("PRAGMA foreign_key_list({})", quote_ident(&t.name)))
                .fetch_all(&self.pool)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            for r in &rows {
                let to_table: String = r.try_get(2).unwrap_or_default();
                let from_col: String = r.try_get(3).unwrap_or_default();
                let to_col: String = r.try_get(4).unwrap_or_default();
                if !to_table.is_empty() {
                    fk_cols.insert((t.name.clone(), from_col.clone()));
                    relations.push(ErRelation {
                        from_table: t.name.clone(),
                        from_column: from_col,
                        to_table,
                        to_column: to_col,
                    });
                }
            }
        }
        let mut tables = Vec::new();
        for t in &tlist {
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
            tables.push(ErTable { name: t.name.clone(), columns: er_cols });
        }
        Ok(ErModel { tables, relations })
    }

    async fn table_indexes(&self, _database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        let list = sqlx::query(&format!("PRAGMA index_list({})", quote_ident(table)))
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out = Vec::new();
        for r in &list {
            let name: String = r.try_get(1).unwrap_or_default();
            let unique = r.try_get::<i64, _>(2).unwrap_or(0) == 1;
            let origin: String = r.try_get(3).unwrap_or_default(); // pk / u / c
            let info = sqlx::query(&format!("PRAGMA index_info({})", quote_ident(&name)))
                .fetch_all(&self.pool)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            // 用 unwrap_or_default 而非 filter_map：運算式索引欄位的 name 為 NULL，
            // 若丟棄會使多欄索引的欄位數對不上（以空字串占位保留位置）。
            let columns: Vec<String> =
                info.iter().map(|ir| ir.try_get::<String, _>(2).unwrap_or_default()).collect();
            out.push(IndexInfo { primary: origin == "pk", unique, columns, name });
        }
        Ok(out)
    }

    async fn drop_index(&self, _database: &str, _table: &str, index: &str) -> AppResult<()> {
        // SQLite 索引名為資料庫全域，不需表限定。
        let sql = format!("DROP INDEX {}", quote_ident(index));
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn create_index(
        &self,
        _database: &str,
        table: &str,
        name: &str,
        columns: &[String],
        unique: bool,
    ) -> AppResult<()> {
        if columns.is_empty() {
            return Err(AppError::Query(t!("請至少選擇一個欄位").into()));
        }
        let cols = columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        let uniq = if unique { "UNIQUE " } else { "" };
        let sql = format!(
            "CREATE {uniq}INDEX {} ON {} ({cols})",
            quote_ident(name),
            quote_ident(table)
        );
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn table_ddl(&self, _database: &str, table: &str) -> AppResult<String> {
        // sqlite_master 直接存放原始建表 / 視圖語句。
        let row = sqlx::query("SELECT sql FROM sqlite_master WHERE name = ? AND sql IS NOT NULL")
            .bind(table)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        match row {
            Some(r) => r
                .try_get::<String, _>(0)
                .map(|ddl| format!("{ddl};"))
                .map_err(|e| AppError::Query(e.to_string())),
            None => Err(AppError::Query(t!("找不到該表的建表語句").into())),
        }
    }

    async fn close(&self) {
        self.pool.close().await;
    }
}

impl SqliteDriver {
    /// 從 PRAGMA table_info 取主鍵欄位（pk > 0），依 pk 序號排列。
    async fn primary_key(&self, table: &str) -> AppResult<Vec<String>> {
        let sql = format!("PRAGMA table_info({})", quote_ident(table));
        let rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        // 收集 (pk_index, name)，pk_index > 0 表示是主鍵的第幾欄。
        let mut pks: Vec<(i64, String)> = rows
            .iter()
            .filter_map(|r| {
                let pk: i64 = r.try_get(5).ok()?;
                if pk > 0 {
                    let name: String = r.try_get(1).ok()?;
                    Some((pk, name))
                } else {
                    None
                }
            })
            .collect();
        pks.sort_by_key(|(idx, _)| *idx);
        Ok(pks.into_iter().map(|(_, n)| n).collect())
    }
}

/// 以雙引號包裹識別字（SQLite 標準），轉義內部雙引號。
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// 組 WHERE 子句（`?` 佔位符）。回傳 (sql_片段, 需綁定的值)。
fn build_where(filters: &[Filter], match_any: bool) -> AppResult<(String, Vec<Option<String>>)> {
    if filters.is_empty() {
        return Ok((String::new(), vec![]));
    }
    let mut clauses = Vec::new();
    let mut binds = Vec::new();
    for f in filters {
        let op = filter_op_sql(&f.op)
            .ok_or_else(|| AppError::Query(tf!("不支援的運算子：{op}", op = f.op)))?;
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

fn rows_to_result(rows: &[SqliteRow]) -> QueryResult {
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

/// SQLite 為動態型別，依儲存類別嘗試讀取。
fn cell_to_string(row: &SqliteRow, idx: usize) -> Option<String> {
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
        "INTEGER" => row
            .try_get::<i64, _>(idx)
            .ok()
            .map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        "REAL" => row
            .try_get::<f64, _>(idx)
            .ok()
            .map(|v| v.to_string())
            .or_else(|| string_fallback(row, idx)),
        _ => string_fallback(row, idx),
    }
}

fn string_fallback(row: &SqliteRow, idx: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return Some(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return Some(crate::db::bytes_to_display(&v));
    }
    Some("<unrenderable>".to_string())
}
