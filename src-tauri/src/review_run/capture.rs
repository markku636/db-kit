//! 擷取層：連線上下文、表結構與鍵、依述詞 / 鍵 / 整表抓列，以及結構快照。
//!
//! 所有送往資料庫的擷取查詢都先過 `cli::guard::read_only_violation`（嚴格版，連 EXPLAIN 內層都查）。
//! 述詞是從使用者語句原文切出來的——切錯的機率再低，也不能讓「備份」本身變成一次寫入。

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::codec::{self, column_ref, select_expr, ColumnSpec};
use super::names::{resolve_name, ObjRef};
use crate::compare::schema::{self as cschema, CaptureOptions, DbSchema};
use crate::db::sqlgen::{qualified, quote_ident, sql_literal};
use crate::db::DbKind;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 連線上下文
// ---------------------------------------------------------------------------

/// 執行 / 擷取時的資料庫脈絡。未限定的表名解析到 `database`；MySQL / PG 以前綴語句切換，
/// 與查詢分頁送出語句的方式一致（驅動會把前綴切出來、在同一條連線上先切再跑）。
#[derive(Debug, Clone, Serialize)]
pub struct ExecContext {
    pub kind: DbKind,
    pub database: String,
    /// `USE …` / `SET search_path TO …`；None = 不加前綴。
    pub prefix: Option<String>,
}

impl ExecContext {
    pub async fn resolve(mgr: &ConnectionManager, id: &str, requested: &str) -> AppResult<ExecContext> {
        let kind = mgr.kind(id)?;
        let requested = requested.trim();
        let scalar = |sql: &'static str| async move {
            let q = mgr.query_capped(id, sql, 1).await?;
            Ok::<String, AppError>(q.rows.first().and_then(|r| r.first().cloned().flatten()).unwrap_or_default())
        };
        let (database, prefix) = match kind {
            DbKind::Mysql | DbKind::Mariadb => {
                if requested.is_empty() {
                    (scalar("SELECT DATABASE()").await?, None)
                } else {
                    (requested.to_string(), Some(format!("USE {}", quote_ident(kind, requested))))
                }
            }
            DbKind::Postgres => {
                if requested.is_empty() {
                    (scalar("SELECT current_schema()").await?, None)
                } else {
                    (requested.to_string(), Some(format!("SET search_path TO {}", quote_ident(kind, requested))))
                }
            }
            // SQL Server 的查詢分頁不加 USE 前綴（驅動不切，會變成整批送出並改掉池中連線的預設庫），
            // 未限定的表名落在連線的預設資料庫——以伺服器回報為準，而不是 UI 選中的那個庫。
            DbKind::Mssql => (scalar("SELECT DB_NAME()").await?, None),
            DbKind::Oracle => (scalar("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL").await?, None),
            DbKind::Sqlite => ("main".to_string(), None),
            _ => return Err(AppError::Unsupported(t!("此連線種類不支援審查並執行").into())),
        };
        if database.is_empty() && kind != DbKind::Sqlite {
            return Err(AppError::Query(t!("無法判斷目前的資料庫，請先選擇資料庫").into()));
        }
        Ok(ExecContext { kind, database, prefix })
    }

    pub fn with_prefix(&self, sql: &str) -> String {
        match &self.prefix {
            Some(p) => format!("{p};\n{sql}"),
            None => sql.to_string(),
        }
    }
}

/// 送出前的唯讀檢查（擷取查詢一律過這關）。
fn guard_read_only(sql: &str) -> AppResult<()> {
    match crate::cli::guard::read_only_violation(sql, true) {
        None => Ok(()),
        Some(_) => Err(AppError::Query(tf!("擷取查詢未通過唯讀檢查，已中止：{sql}", sql = sql))),
    }
}

// ---------------------------------------------------------------------------
// 表結構與鍵
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    Primary,
    /// 沒有主鍵，改用全為 NOT NULL 的唯一索引。
    Unique,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableMeta {
    pub database: String,
    /// 與 `list_tables` 同形（MSSQL 非 dbo 為 `schema.table`）。
    pub table: String,
    pub columns: Vec<ColumnSpec>,
    pub key: Vec<String>,
    pub key_kind: KeyKind,
}

impl TableMeta {
    pub fn qualified(&self, kind: DbKind) -> String {
        qualified(kind, &self.database, &self.table)
    }
    pub fn spec(&self, name: &str) -> Option<&ColumnSpec> {
        self.columns.iter().find(|c| c.name == name)
    }
    pub fn key_indexes(&self) -> Vec<usize> {
        self.key.iter().filter_map(|k| self.columns.iter().position(|c| &c.name == k)).collect()
    }
}

/// 解析語句裡的表參照到實際存在的表名。回 None = 找不到（CREATE TABLE 之前、或打錯字）。
pub async fn resolve_table(mgr: &ConnectionManager, id: &str, ctx: &ExecContext, obj: &ObjRef) -> AppResult<Option<(String, String)>> {
    let db = obj.db_or(&ctx.database).to_string();
    let tables = mgr.list_tables(id, &db).await?;
    Ok(resolve_name(&obj.name, tables.iter().map(|t| t.name.as_str())).map(|n| (db, n)))
}

pub async fn table_meta(mgr: &ConnectionManager, id: &str, kind: DbKind, database: &str, table: &str) -> AppResult<TableMeta> {
    let cols = mgr.table_columns(id, database, table).await?;
    if cols.is_empty() {
        return Err(AppError::Query(tf!("讀不到資料表 {table} 的欄位", table = table)));
    }
    let computed = non_writable_columns(mgr, id, kind, database, table).await;
    let columns: Vec<ColumnSpec> = cols.iter().map(|c| codec::column_spec(kind, c, &computed.0)).collect();
    let mut columns = columns;
    for c in columns.iter_mut() {
        if computed.1.iter().any(|n| n == &c.name) {
            c.identity = true;
            c.identity_always = true;
        }
    }
    let pk: Vec<String> = cols.iter().filter(|c| c.key == "PRI").map(|c| c.name.clone()).collect();
    if !pk.is_empty() {
        return Ok(TableMeta { database: database.into(), table: table.into(), columns, key: pk, key_kind: KeyKind::Primary });
    }
    // 沒有主鍵：找一個所有欄位都 NOT NULL 的唯一索引（NULL 在唯一索引裡可重複，定位不到單一列）。
    if let Ok(idx) = mgr.table_indexes(id, database, table).await {
        for ix in idx.iter().filter(|i| i.unique) {
            let all_not_null = ix.columns.iter().all(|c| cols.iter().any(|ci| &ci.name == c && !ci.nullable));
            if !ix.columns.is_empty() && all_not_null {
                return Ok(TableMeta {
                    database: database.into(),
                    table: table.into(),
                    columns,
                    key: ix.columns.clone(),
                    key_kind: KeyKind::Unique,
                });
            }
        }
    }
    Ok(TableMeta { database: database.into(), table: table.into(), columns, key: vec![], key_kind: KeyKind::None })
}

/// 方言專屬的「不可寫欄」查詢（driver 的 ColumnInfo 沒帶）：
/// 回傳（計算欄 / 虛擬欄，一律產生的 identity 欄）。失敗一律當作沒有——最壞情況是回滾 INSERT 被伺服器拒絕，
/// 而不是擷取整個失敗。
async fn non_writable_columns(mgr: &ConnectionManager, id: &str, kind: DbKind, database: &str, table: &str) -> (Vec<String>, Vec<String>) {
    let names = |sql: String| async move {
        mgr.query_capped(id, &sql, 0)
            .await
            .map(|q| q.rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    match kind {
        DbKind::Mssql => {
            let (schema, tbl) = match table.split_once('.') {
                Some((s, t)) => (s.to_string(), t.to_string()),
                None => ("dbo".to_string(), table.to_string()),
            };
            let obj = format!("{}.{}.{}", quote_ident(kind, database), quote_ident(kind, &schema), quote_ident(kind, &tbl));
            let sql = format!(
                "SELECT c.name FROM {}.sys.columns c WHERE c.object_id = OBJECT_ID({}) AND c.is_computed = 1",
                quote_ident(kind, database),
                sql_literal(kind, Some(&obj))
            );
            (names(sql).await, vec![])
        }
        DbKind::Oracle => {
            let owner = sql_literal(kind, Some(database));
            let t = sql_literal(kind, Some(table));
            let virt = names(format!(
                "SELECT column_name FROM all_tab_cols WHERE owner = {owner} AND table_name = {t} AND virtual_column = 'YES' AND hidden_column = 'NO'"
            ))
            .await;
            let always = names(format!(
                "SELECT column_name FROM all_tab_identity_cols WHERE owner = {owner} AND table_name = {t} AND generation_type = 'ALWAYS'"
            ))
            .await;
            (virt, always)
        }
        _ => (vec![], vec![]),
    }
}

// ---------------------------------------------------------------------------
// 列快照
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSnapshot {
    pub meta: TableMeta,
    /// 值的順序與 `meta.columns` 相同；文字形式由 codec 決定（見 codec.rs）。
    pub rows: Vec<Vec<Option<String>>>,
    /// 符合的列超過上限，只抓到前 N 列——這份快照不能拿來產生完整回滾。
    pub truncated: bool,
    /// 表在擷取當下不存在（DROP 之後 / CREATE 之前）。
    #[serde(default)]
    pub missing: bool,
    pub method: String,
    pub captured_at_ms: i64,
}

impl TableSnapshot {
    pub fn empty(meta: TableMeta, method: &str, missing: bool) -> TableSnapshot {
        TableSnapshot { meta, rows: vec![], truncated: false, missing, method: method.into(), captured_at_ms: now_ms() }
    }
}

fn select_list(kind: DbKind, meta: &TableMeta, qualifier: Option<&str>) -> String {
    meta.columns
        .iter()
        .map(|c| select_expr(kind, c, &column_ref(kind, qualifier, &c.name)))
        .collect::<Vec<_>>()
        .join(", ")
}

async fn fetch_rows(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    sql: &str,
    cap: usize,
    width: usize,
) -> AppResult<(Vec<Vec<Option<String>>>, bool)> {
    guard_read_only(sql)?;
    // cap + 1：多抓一列才分得出「剛好 cap 列」與「超過 cap 列」。
    let q = mgr.query_capped(id, &ctx.with_prefix(sql), cap.saturating_add(1)).await?;
    // 沒有列時部分驅動（SQLite）拿不到欄位清單，只在有列時核對欄數。
    if !q.rows.is_empty() && q.columns.len() != width {
        return Err(AppError::Query(tf!(
            "擷取查詢回傳的欄數不符（預期 {want}，實得 {got}）",
            want = width,
            got = q.columns.len()
        )));
    }
    let mut rows = q.rows;
    let truncated = rows.len() > cap || q.truncated;
    rows.truncate(cap);
    Ok((rows, truncated))
}

/// 依鍵去重（JOIN / USING fan-out 會讓同一列出現多次）。沒有鍵時不動。
pub fn dedupe_by_key(meta: &TableMeta, rows: &mut Vec<Vec<Option<String>>>) {
    let idx = meta.key_indexes();
    if idx.is_empty() {
        return;
    }
    let mut seen = std::collections::HashSet::new();
    rows.retain(|r| seen.insert(idx.iter().map(|&i| r[i].clone()).collect::<Vec<_>>()));
}

/// 述詞擷取：`SELECT <目標表欄位> FROM {source} [WHERE {predicate}]`。
pub async fn capture_predicate(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    meta: &TableMeta,
    target: &ObjRef,
    source: &str,
    predicate: Option<&str>,
    fanout: bool,
    cap: usize,
) -> AppResult<TableSnapshot> {
    let sql = predicate_select_sql(ctx.kind, meta, target, source, predicate, fanout);
    let (mut rows, truncated) = fetch_rows(mgr, id, ctx, &sql, cap, meta.columns.len()).await?;
    if fanout {
        dedupe_by_key(meta, &mut rows);
    }
    Ok(TableSnapshot { meta: meta.clone(), rows, truncated, missing: false, method: "predicate".into(), captured_at_ms: now_ms() })
}

pub fn predicate_select_sql(kind: DbKind, meta: &TableMeta, target: &ObjRef, source: &str, predicate: Option<&str>, fanout: bool) -> String {
    // 單表時欄位不加限定詞最保險；有 JOIN 才需要（否則同名欄位會 ambiguous）。
    let qualifier = if fanout || target.alias.is_some() { Some(target.column_qualifier(kind)) } else { None };
    let mut sql = format!("SELECT {} FROM {source}", select_list(kind, meta, qualifier.as_deref()));
    if let Some(p) = predicate {
        sql.push_str(" WHERE ");
        sql.push_str(p);
    }
    sql
}

pub fn predicate_count_sql(source: &str, predicate: Option<&str>) -> String {
    match predicate {
        Some(p) => format!("SELECT COUNT(*) FROM {source} WHERE {p}"),
        None => format!("SELECT COUNT(*) FROM {source}"),
    }
}

/// 整表擷取。
pub async fn capture_whole(mgr: &ConnectionManager, id: &str, ctx: &ExecContext, meta: &TableMeta, cap: usize) -> AppResult<TableSnapshot> {
    let sql = format!("SELECT {} FROM {}", select_list(ctx.kind, meta, None), meta.qualified(ctx.kind));
    let (rows, truncated) = fetch_rows(mgr, id, ctx, &sql, cap, meta.columns.len()).await?;
    Ok(TableSnapshot { meta: meta.clone(), rows, truncated, missing: false, method: "whole_table".into(), captured_at_ms: now_ms() })
}

/// 依鍵值擷取（`keys` 為 SQL 字面值 / 運算式，順序同 `meta.key`）。分批送出，Oracle 的 IN 清單上限是 1000。
pub async fn capture_by_keys(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    meta: &TableMeta,
    keys: &[Vec<String>],
    method: &str,
) -> AppResult<TableSnapshot> {
    const CHUNK: usize = 200;
    let kind = ctx.kind;
    let mut rows = Vec::new();
    for chunk in keys.chunks(CHUNK) {
        let sql = format!(
            "SELECT {} FROM {} WHERE {}",
            select_list(kind, meta, None),
            meta.qualified(kind),
            keys_predicate(kind, &meta.key, chunk)
        );
        // 鍵唯一：每個鍵最多一列，上限取批次大小即可。
        let (mut part, _) = fetch_rows(mgr, id, ctx, &sql, chunk.len(), meta.columns.len()).await?;
        rows.append(&mut part);
    }
    Ok(TableSnapshot { meta: meta.clone(), rows, truncated: false, missing: false, method: method.into(), captured_at_ms: now_ms() })
}

/// `k IN (…)`（單欄）或 `(a = … AND b = …) OR …`（複合鍵）。NULL 鍵以 IS NULL 比對。
pub fn keys_predicate(kind: DbKind, key: &[String], values: &[Vec<String>]) -> String {
    if key.len() == 1 {
        let col = quote_ident(kind, &key[0]);
        let (nulls, vals): (Vec<&Vec<String>>, Vec<&Vec<String>>) = values.iter().partition(|v| v[0].eq_ignore_ascii_case("NULL"));
        let mut parts = Vec::new();
        if !vals.is_empty() {
            parts.push(format!("{col} IN ({})", vals.iter().map(|v| v[0].as_str()).collect::<Vec<_>>().join(", ")));
        }
        if !nulls.is_empty() {
            parts.push(format!("{col} IS NULL"));
        }
        return parts.join(" OR ");
    }
    values
        .iter()
        .map(|v| {
            let conds = key
                .iter()
                .zip(v)
                .map(|(k, lit)| {
                    let col = quote_ident(kind, k);
                    if lit.eq_ignore_ascii_case("NULL") {
                        format!("{col} IS NULL")
                    } else {
                        format!("{col} = {lit}")
                    }
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            format!("({conds})")
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// 快照裡每列的鍵字面值（供依鍵擷取後像用）。有不可還原的鍵值時回 None。
pub fn snapshot_key_literals(kind: DbKind, snap: &TableSnapshot) -> Option<Vec<Vec<String>>> {
    let idx = snap.meta.key_indexes();
    if idx.is_empty() || idx.len() != snap.meta.key.len() {
        return None;
    }
    let mut out = Vec::with_capacity(snap.rows.len());
    for r in &snap.rows {
        let mut lits = Vec::with_capacity(idx.len());
        for &i in &idx {
            let spec = &snap.meta.columns[i];
            if !codec::restorable(spec, r[i].as_deref()) {
                return None;
            }
            lits.push(codec::literal(kind, spec, r[i].as_deref()));
        }
        out.push(lits);
    }
    Some(out)
}

/// 單欄整數鍵的目前最大值（INSERT 用自動編號時，以「大於它」找出新增的列）。
pub async fn max_key(mgr: &ConnectionManager, id: &str, ctx: &ExecContext, meta: &TableMeta) -> AppResult<Option<String>> {
    let col = quote_ident(ctx.kind, &meta.key[0]);
    let sql = format!("SELECT MAX({col}) FROM {}", meta.qualified(ctx.kind));
    guard_read_only(&sql)?;
    let q = mgr.query_capped(id, &ctx.with_prefix(&sql), 1).await?;
    Ok(q.rows.first().and_then(|r| r.first().cloned().flatten()))
}

pub async fn capture_key_range(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    meta: &TableMeta,
    after: Option<&str>,
    cap: usize,
) -> AppResult<TableSnapshot> {
    let col = quote_ident(ctx.kind, &meta.key[0]);
    let mut sql = format!("SELECT {} FROM {}", select_list(ctx.kind, meta, None), meta.qualified(ctx.kind));
    if let Some(v) = after {
        // 只接受純整數，避免把奇怪的值拼進 SQL。
        let n: i128 = v.trim().parse().map_err(|_| AppError::Query(tf!("主鍵最大值不是整數：{v}", v = v)))?;
        sql.push_str(&format!(" WHERE {col} > {n}"));
    }
    let (rows, truncated) = fetch_rows(mgr, id, ctx, &sql, cap, meta.columns.len()).await?;
    Ok(TableSnapshot { meta: meta.clone(), rows, truncated, missing: false, method: "key_range".into(), captured_at_ms: now_ms() })
}

pub async fn count(mgr: &ConnectionManager, id: &str, ctx: &ExecContext, sql: &str) -> AppResult<u64> {
    guard_read_only(sql)?;
    let q = mgr.query_capped(id, &ctx.with_prefix(sql), 1).await?;
    let v = q.rows.first().and_then(|r| r.first().cloned().flatten()).unwrap_or_default();
    v.trim().parse::<f64>().map(|f| f as u64).map_err(|_| AppError::Query(tf!("無法解讀列數：{v}", v = v)))
}

// ---------------------------------------------------------------------------
// 結構快照
// ---------------------------------------------------------------------------

/// 擷取範圍（已解析成實際名稱）。
#[derive(Debug, Clone, Default)]
pub struct SchemaTargets {
    pub tables: Vec<String>,
    pub views: Vec<String>,
    pub routines: Vec<String>,
    pub all_tables: bool,
}

/// 整庫模式下允許擷取的表數上限：每張表 4 個查詢，再多就不是「備份前順手做」的等級了。
pub const MAX_ALL_TABLES: usize = 300;

pub async fn capture_schema(mgr: &ConnectionManager, id: &str, database: &str, targets: &SchemaTargets) -> AppResult<DbSchema> {
    let mut filter: Vec<String> = Vec::new();
    filter.extend(targets.tables.iter().cloned());
    filter.extend(targets.views.iter().cloned());
    let opts = CaptureOptions {
        include_ddl: true,
        include_routines: !targets.routines.is_empty(),
        include_views: !targets.views.is_empty() || targets.all_tables,
        tables: if targets.all_tables { None } else { Some(filter) },
    };
    let mut s = cschema::capture(mgr, id, database, database, &opts, None).await?;
    if targets.all_tables {
        s.views.clear();
    }
    if !targets.routines.is_empty() {
        s.routines.retain(|r| targets.routines.iter().any(|n| n.eq_ignore_ascii_case(&r.info.name)));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_run::codec::Codec;

    fn meta(kind: DbKind) -> TableMeta {
        let spec = |n: &str, codec: Codec| ColumnSpec {
            name: n.into(),
            data_type: if codec == Codec::Text { "varchar(10)".into() } else { "int".into() },
            codec,
            writable: true,
            identity: false,
            identity_always: false,
        };
        let _ = kind;
        TableMeta {
            database: "shop".into(),
            table: "orders".into(),
            columns: vec![spec("id", Codec::Number), spec("note", Codec::Text)],
            key: vec!["id".into()],
            key_kind: KeyKind::Primary,
        }
    }

    #[test]
    fn predicate_select_qualifies_only_when_needed() {
        let m = meta(DbKind::Mysql);
        let t = crate::review_run::names::parse_obj_ref(DbKind::Mysql, "orders").unwrap();
        assert_eq!(
            predicate_select_sql(DbKind::Mysql, &m, &t, "orders", Some("id > 1"), false),
            "SELECT CAST(`id` AS CHAR), `note` FROM orders WHERE id > 1"
        );
        let t = crate::review_run::names::parse_obj_ref(DbKind::Mysql, "orders o").unwrap();
        assert_eq!(
            predicate_select_sql(DbKind::Mysql, &m, &t, "orders o JOIN u ON u.id = o.uid", Some("u.x = 1"), true),
            "SELECT CAST(o.`id` AS CHAR), o.`note` FROM orders o JOIN u ON u.id = o.uid WHERE u.x = 1"
        );
    }

    #[test]
    fn keys_predicate_shapes() {
        let single = keys_predicate(DbKind::Postgres, &["id".into()], &[vec!["1".into()], vec!["NULL".into()], vec!["2".into()]]);
        assert_eq!(single, "\"id\" IN (1, 2) OR \"id\" IS NULL");
        let composite = keys_predicate(DbKind::Mssql, &["a".into(), "b".into()], &[vec!["1".into(), "N'x'".into()]]);
        assert_eq!(composite, "([a] = 1 AND [b] = N'x')");
    }

    #[test]
    fn key_literals_refuse_unrestorable_keys() {
        let mut m = meta(DbKind::Mysql);
        m.columns[0].codec = Codec::Hex;
        let snap = TableSnapshot { meta: m, rows: vec![vec![Some("zz".into()), None]], truncated: false, missing: false, method: "t".into(), captured_at_ms: 0 };
        assert!(snapshot_key_literals(DbKind::Mysql, &snap).is_none());
    }

    #[test]
    fn dedupe_keeps_first_occurrence_per_key() {
        let m = meta(DbKind::Mysql);
        let mut rows = vec![
            vec![Some("1".into()), Some("a".into())],
            vec![Some("1".into()), Some("a".into())],
            vec![Some("2".into()), Some("b".into())],
        ];
        dedupe_by_key(&m, &mut rows);
        assert_eq!(rows.len(), 2);
    }
}
