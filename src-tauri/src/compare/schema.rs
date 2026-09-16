//! 結構快照模型與擷取：把一個資料庫（schema）的表 / 視圖 / 程序完整讀成 `DbSchema`。
//!
//! 只用既有 manager 方法（`list_tables` / `table_columns` / `table_indexes` / `list_foreign_keys` /
//! `table_ddl` / `list_routines` / `routine_definition`），不新增 driver trait 方法；
//! 每張表四個查詢以 `tokio::join!` 並行，單表失敗記進 `warnings` 而不中斷整庫擷取。
//!
//! 同時放跨引擎比對用的正規化函式（型別 / 預設值 / 定義文字），diff 與 ddl 兩邊共用。

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::sqlgen::quote_ident;
use crate::db::{ColumnInfo, DbKind, ForeignKeyInfo, IndexInfo, RoutineInfo};
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

fn yes() -> bool {
    true
}

/// 單一資料表 / 視圖的完整結構。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TableSchema {
    /// 與 `list_tables` 回的名稱一致（MSSQL 非 dbo 為 `schema.table`）。
    pub name: String,
    /// "table" | "view"（與 TableInfo.kind 同）。
    pub kind: String,
    #[serde(default)]
    pub columns: Vec<ColumnInfo>,
    #[serde(default)]
    pub indexes: Vec<IndexInfo>,
    /// driver 回的扁平（單欄）配對；複合外鍵以 `group_fks` 摺疊。
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyInfo>,
    #[serde(default)]
    pub ddl: Option<String>,
    /// true = DDL 是 driver 從 catalog 合成的（PG / MSSQL 表），不含索引 / 外鍵；
    /// 同步時這些要另外補語句。
    #[serde(default)]
    pub ddl_synthesized: bool,
    /// 擷取時的單表問題（如 Oracle DDL 權限不足），不阻擋整庫。
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// 程序 / 函式 / 觸發器 + 其定義文字。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutineSchema {
    pub info: RoutineInfo,
    #[serde(default)]
    pub definition: Option<String>,
}

/// 一個資料庫（schema）的結構快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbSchema {
    pub kind: DbKind,
    pub database: String,
    pub captured_at_ms: i64,
    /// 顯示用標籤（如「prod-mysql / shop」），不含任何祕密。
    #[serde(default)]
    pub label: String,
    /// kind == "table"
    #[serde(default)]
    pub tables: Vec<TableSchema>,
    /// kind == "view"：只有 columns + ddl。
    #[serde(default)]
    pub views: Vec<TableSchema>,
    #[serde(default)]
    pub routines: Vec<RoutineSchema>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl DbSchema {
    pub fn table(&self, name: &str) -> Option<&TableSchema> {
        self.tables.iter().find(|t| t.name == name)
    }
    pub fn view(&self, name: &str) -> Option<&TableSchema> {
        self.views.iter().find(|t| t.name == name)
    }
}

/// 擷取選項。
#[derive(Debug, Clone, Deserialize)]
pub struct CaptureOptions {
    #[serde(default = "yes")]
    pub include_ddl: bool,
    #[serde(default = "yes")]
    pub include_routines: bool,
    #[serde(default = "yes")]
    pub include_views: bool,
    /// 只擷取這些表 / 視圖（None = 全部）。
    #[serde(default)]
    pub tables: Option<Vec<String>>,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self { include_ddl: true, include_routines: true, include_views: true, tables: None }
    }
}

/// 複合外鍵（由扁平配對摺疊；driver 皆 ORDER BY 約束名、欄位序）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// 把 driver 的單欄配對依約束名摺疊成複合外鍵（保留首次出現順序）。
pub fn group_fks(flat: &[ForeignKeyInfo]) -> Vec<ForeignKey> {
    let mut out: Vec<ForeignKey> = Vec::new();
    for f in flat {
        if let Some(fk) = out.iter_mut().find(|x| x.name == f.name && x.ref_table == f.ref_table) {
            fk.columns.push(f.column.clone());
            fk.ref_columns.push(f.ref_column.clone());
        } else {
            out.push(ForeignKey {
                name: f.name.clone(),
                columns: vec![f.column.clone()],
                ref_table: f.ref_table.clone(),
                ref_columns: vec![f.ref_column.clone()],
            });
        }
    }
    out
}

/// 是否為可做結構比對的 SQL 引擎。
pub fn supports_schema_compare(kind: DbKind) -> bool {
    matches!(
        kind,
        DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres | DbKind::Sqlite | DbKind::Mssql | DbKind::Oracle
    )
}

/// 同一「族」（MySQL 與 MariaDB 方言 / DDL 相容，互比可產生可用 DDL）。
pub fn same_family(a: DbKind, b: DbKind) -> bool {
    let fam = |k: DbKind| if k == DbKind::Mariadb { DbKind::Mysql } else { k };
    fam(a) == fam(b)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 擷取整庫結構。`on_progress(done, total)` 於每張表完成後呼叫（total = 表 + 視圖數）。
pub async fn capture(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
    label: &str,
    opts: &CaptureOptions,
    on_progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
) -> AppResult<DbSchema> {
    let kind = manager.kind(id)?;
    if !supports_schema_compare(kind) {
        return Err(AppError::Unsupported(t!("此資料庫種類不支援結構比對").into()));
    }

    let mut all = manager.list_tables(id, database).await?;
    if let Some(only) = &opts.tables {
        all.retain(|t| only.iter().any(|n| n == &t.name));
    }
    if !opts.include_views {
        all.retain(|t| t.kind != "view");
    }
    let total = all.len();

    let mut schema = DbSchema {
        kind,
        database: database.to_string(),
        captured_at_ms: now_ms(),
        label: label.to_string(),
        tables: Vec::new(),
        views: Vec::new(),
        routines: Vec::new(),
        warnings: Vec::new(),
    };

    for (i, t) in all.iter().enumerate() {
        let is_view = t.kind == "view";
        let ts = if is_view {
            capture_view(manager, id, kind, database, &t.name, opts).await
        } else {
            capture_table(manager, id, kind, database, &t.name, opts).await
        };
        if is_view {
            schema.views.push(ts);
        } else {
            schema.tables.push(ts);
        }
        if let Some(cb) = on_progress {
            cb(i + 1, total);
        }
    }

    if opts.include_routines {
        match manager.list_routines(id, database).await {
            Ok(list) => {
                for info in list {
                    let definition = match manager
                        .routine_definition(id, database, &info.name, &info.routine_type)
                        .await
                    {
                        Ok(d) => Some(d),
                        Err(e) => {
                            schema.warnings.push(tf!(
                                "無法取得 {name} 的定義：{err}",
                                name = info.name,
                                err = e.to_string()
                            ));
                            None
                        }
                    };
                    schema.routines.push(RoutineSchema { info, definition });
                }
            }
            // 不支援程序的引擎（trait 預設 Unsupported）：靜默略過；其他錯誤記 warning。
            Err(AppError::Unsupported(_)) => {}
            Err(e) => schema.warnings.push(tf!("無法列出程序 / 函式：{err}", err = e.to_string())),
        }
    }

    // 決定性輸出：依名稱排序，讓快照可 diff、測試可斷言。
    schema.tables.sort_by(|a, b| a.name.cmp(&b.name));
    schema.views.sort_by(|a, b| a.name.cmp(&b.name));
    schema.routines.sort_by(|a, b| {
        (a.info.routine_type.as_str(), a.info.name.as_str())
            .cmp(&(b.info.routine_type.as_str(), b.info.name.as_str()))
    });
    Ok(schema)
}

async fn capture_table(
    manager: &ConnectionManager,
    id: &str,
    kind: DbKind,
    database: &str,
    table: &str,
    opts: &CaptureOptions,
) -> TableSchema {
    let mut ts = TableSchema { name: table.to_string(), kind: "table".into(), ..Default::default() };
    let (cols, idx, fks, ddl) = tokio::join!(
        manager.table_columns(id, database, table),
        manager.table_indexes(id, database, table),
        manager.list_foreign_keys(id, database, table),
        async {
            if opts.include_ddl {
                Some(manager.table_ddl(id, database, table).await)
            } else {
                None
            }
        }
    );
    match cols {
        Ok(c) => ts.columns = c,
        Err(e) => ts.warnings.push(tf!("欄位：{err}", err = e.to_string())),
    }
    match idx {
        Ok(i) => ts.indexes = i,
        Err(AppError::Unsupported(_)) => {}
        Err(e) => ts.warnings.push(tf!("索引：{err}", err = e.to_string())),
    }
    match fks {
        Ok(f) => ts.foreign_keys = f,
        Err(AppError::Unsupported(_)) => {}
        Err(e) => ts.warnings.push(tf!("外鍵：{err}", err = e.to_string())),
    }
    match ddl {
        Some(Ok(d)) => {
            ts.ddl = Some(d);
            // PG / MSSQL 的表 DDL 由 driver 從 catalog 重建，不含索引 / 外鍵。
            ts.ddl_synthesized = matches!(kind, DbKind::Postgres | DbKind::Mssql);
        }
        Some(Err(e)) => ts.warnings.push(tf!("DDL：{err}", err = e.to_string())),
        None => {}
    }
    ts
}

async fn capture_view(
    manager: &ConnectionManager,
    id: &str,
    kind: DbKind,
    database: &str,
    view: &str,
    opts: &CaptureOptions,
) -> TableSchema {
    let mut ts = TableSchema { name: view.to_string(), kind: "view".into(), ..Default::default() };
    match manager.table_columns(id, database, view).await {
        Ok(c) => ts.columns = c,
        Err(e) => ts.warnings.push(tf!("欄位：{err}", err = e.to_string())),
    }
    if !opts.include_ddl {
        return ts;
    }
    let ddl = if kind == DbKind::Postgres {
        // PG 的 table_ddl 對視圖會合成一個假的 CREATE TABLE；改問 pg_get_viewdef。
        let lit = format!("{}.{}", quote_ident(kind, database), quote_ident(kind, view)).replace('\'', "''");
        let sql = format!("SELECT pg_get_viewdef(to_regclass('{lit}'), true)");
        manager.query(id, &sql).await.and_then(|r| {
            r.rows
                .first()
                .and_then(|row| row.first().cloned().flatten())
                // 名稱用**裸名**：限定到 schema 的話，兩側 schema 不同時定義文字永遠不相等，
                // 視圖會被判成「每次都有差異」而無法收斂（同步時 ddl::rewrite_view_ddl 會自行限定到目標）。
                .map(|body| format!("CREATE OR REPLACE VIEW {} AS\n{body}", quote_ident(kind, view)))
                .ok_or_else(|| AppError::Query(t!("找不到視圖定義").into()))
        })
    } else {
        manager.table_ddl(id, database, view).await
    };
    match ddl {
        // MySQL 在「連線的預設資料庫 != 視圖所屬資料庫」時，會把庫名寫進視圖名與本體的每個表參照
        // （同庫時則不寫）。不剝掉的話：同一個視圖會因「從哪條連線擷取」而被判成不同，
        // 而且同步出去的視圖仍讀來源庫的資料表。
        Ok(d) => ts.ddl = Some(strip_db_qualifier(kind, database, &d)),
        Err(e) => ts.warnings.push(tf!("DDL：{err}", err = e.to_string())),
    }
    ts
}

/// 去掉 MySQL 視圖 / 程序 DDL 裡的 `` `db`. `` 限定名，讓定義與「從哪條連線擷取」無關。
pub fn strip_db_qualifier(kind: DbKind, db: &str, s: &str) -> String {
    if !matches!(kind, DbKind::Mysql | DbKind::Mariadb) || db.is_empty() {
        return s.to_string();
    }
    s.replace(&format!("`{db}`."), "")
}

// ---------------------------------------------------------------------------
// 正規化（diff 與 ddl 共用）
// ---------------------------------------------------------------------------

/// 折疊空白 + 小寫。
fn fold(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()
}

/// 型別正規化：同引擎內把等價寫法收斂到同一字串，跨引擎比對時再退到「型別家族」。
pub fn normalize_type(kind: DbKind, s: &str) -> String {
    let mut t = fold(s);
    match kind {
        DbKind::Mysql | DbKind::Mariadb => {
            // 整數顯示寬度（int(11)）在 8.0.19 起不再回報；去掉才不會 5.7 vs 8.0 假差異。
            for base in ["tinyint", "smallint", "mediumint", "bigint", "int"] {
                if let Some(rest) = t.strip_prefix(base) {
                    if rest.starts_with('(') {
                        if let Some(close) = rest.find(')') {
                            // tinyint(1) 是 MySQL 的 boolean 慣例，保留以便與 bool 對照。
                            if !(base == "tinyint" && &rest[..=close] == "(1)") {
                                t = format!("{base}{}", &rest[close + 1..]);
                            }
                        }
                    }
                    break;
                }
            }
            t = t.replace("integer", "int");
            if t == "bool" || t == "boolean" {
                t = "tinyint(1)".into();
            }
        }
        DbKind::Postgres => {
            t = t
                .replace("character varying", "varchar")
                .replace("timestamp without time zone", "timestamp")
                .replace("timestamp with time zone", "timestamptz")
                .replace("time without time zone", "time")
                .replace("double precision", "float8");
            t = match t.as_str() {
                "integer" | "int4" => "int".into(),
                "int8" => "bigint".into(),
                "int2" => "smallint".into(),
                "boolean" => "bool".into(),
                "character" | "bpchar" => "char".into(),
                _ => t,
            };
        }
        DbKind::Mssql => {
            t = t.replace("nvarchar", "varchar").replace("nchar", "char");
        }
        DbKind::Oracle => {
            t = t.replace("varchar2", "varchar").replace("nvarchar2", "varchar");
        }
        _ => {}
    }
    t
}

/// 型別家族（跨引擎比對時只在家族不同才算差異）。
pub fn type_family(kind: DbKind, s: &str) -> &'static str {
    let t = normalize_type(kind, s);
    let base = t.split(['(', ' ']).next().unwrap_or("");
    match base {
        "tinyint" if t.starts_with("tinyint(1)") => "bool",
        "bool" | "boolean" | "bit" => "bool",
        "int" | "integer" | "smallint" | "tinyint" | "mediumint" | "bigint" | "serial" | "bigserial" => "int",
        "decimal" | "numeric" | "number" | "money" | "smallmoney" => "decimal",
        "float" | "float4" | "float8" | "real" | "double" | "binary_float" | "binary_double" => "float",
        "date" => "date",
        "time" | "datetime" | "datetime2" | "smalldatetime" | "timestamp" | "timestamptz" | "datetimeoffset" => "datetime",
        "blob" | "tinyblob" | "mediumblob" | "longblob" | "bytea" | "binary" | "varbinary" | "image" | "raw" => "blob",
        "json" | "jsonb" => "json",
        "uuid" | "uniqueidentifier" => "uuid",
        _ => "text",
    }
}

/// 預設值正規化：去 PG 型別轉換、統一 NULL 表示、大小寫、序列表達式。
/// 空字串視同「無預設值」（SQLite 的 PRAGMA 與部分 driver 以 "" 表示 NULL）。
pub fn normalize_default(kind: DbKind, d: Option<&str>) -> Option<String> {
    let s = d?.trim();
    if s.is_empty() {
        return None;
    }
    let mut v = s.to_string();
    if kind == DbKind::Postgres {
        // 'abc'::character varying → 'abc'
        if let Some(pos) = v.find("::") {
            if v.starts_with('\'') || v.chars().next().is_some_and(|c| c.is_ascii_digit() || c == '-') {
                v = v[..pos].to_string();
            }
        }
        if v.starts_with("nextval(") {
            return Some("nextval(…)".into());
        }
    }
    if kind == DbKind::Mssql {
        // ((0)) / ('abc') 的多層括號。
        while v.starts_with('(') && v.ends_with(')') && v.len() >= 2 {
            v = v[1..v.len() - 1].to_string();
        }
    }
    let low = v.to_ascii_lowercase();
    if low == "null" {
        return None;
    }
    // MariaDB 10.2+ 把 NULL 預設值回成字面 'NULL' 字串。
    if low == "'null'" && matches!(kind, DbKind::Mariadb | DbKind::Mysql) {
        return None;
    }
    if low.starts_with("current_timestamp") || low == "now()" || low == "getdate()" || low == "systimestamp" || low == "sysdate" {
        return Some("current_timestamp".into());
    }
    Some(v.trim().to_string())
}

/// 定義文字（視圖 / 程序）正規化：去 DEFINER、折疊空白、去尾分號、統一大小寫。
pub fn normalize_text(kind: DbKind, s: &str) -> String {
    let mut t = s.to_string();
    if matches!(kind, DbKind::Mysql | DbKind::Mariadb) {
        // CREATE DEFINER=`root`@`%` PROCEDURE → CREATE PROCEDURE
        if let Some(start) = t.find("DEFINER=") {
            if let Some(rel) = t[start..].find(char::is_whitespace) {
                t.replace_range(start..start + rel + 1, "");
            }
        }
        // 視圖前綴 ALGORITHM=... SQL SECURITY ... 屬雜訊。
        t = t.replace("ALGORITHM=UNDEFINED ", "").replace("SQL SECURITY DEFINER ", "");
    }
    if kind == DbKind::Oracle {
        if let Some(rest) = t.trim_start().strip_prefix("CREATE OR REPLACE ") {
            t = format!("CREATE {rest}");
        }
    }
    // 識別字引號（` " [ ]）不是語意：同一個視圖 / 程序經同步重建後多半只差在有沒有加引號。
    t = t.replace(['`', '"', '[', ']'], "");
    let mut f = fold(&t);
    while f.ends_with(';') || f.ends_with(' ') {
        f.pop();
    }
    f
}

/// 表 DDL 正規化（只在 MySQL / Oracle 這類回真實 DDL 的引擎有意義）：去 AUTO_INCREMENT=n 與儲存子句。
pub fn normalize_ddl(kind: DbKind, s: &str) -> String {
    let mut t = s.to_string();
    if matches!(kind, DbKind::Mysql | DbKind::Mariadb) {
        t = strip_auto_increment(&t);
    }
    if kind == DbKind::Oracle {
        // SEGMENT CREATION / PCTFREE / TABLESPACE … 隨環境變動。
        for kw in ["SEGMENT CREATION", "PCTFREE", "PCTUSED", "INITRANS", "MAXTRANS", "STORAGE(", "TABLESPACE", "NOCOMPRESS", "LOGGING"] {
            if let Some(pos) = t.find(kw) {
                t.truncate(pos);
            }
        }
    }
    fold(&t)
}

/// 去掉 MySQL DDL 尾端 `AUTO_INCREMENT=123 `（每次寫入都在變，不是結構差異）。
pub fn strip_auto_increment(ddl: &str) -> String {
    let mut out = String::with_capacity(ddl.len());
    let mut rest = ddl;
    while let Some(pos) = rest.find("AUTO_INCREMENT=") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + "AUTO_INCREMENT=".len()..];
        let digits = after.chars().take_while(|c| c.is_ascii_digit()).count();
        let mut tail = &after[digits..];
        if tail.starts_with(' ') {
            tail = &tail[1..];
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fk(name: &str, col: &str, rt: &str, rc: &str) -> ForeignKeyInfo {
        ForeignKeyInfo { name: name.into(), column: col.into(), ref_table: rt.into(), ref_column: rc.into() }
    }

    #[test]
    fn group_fks_folds_composite() {
        let flat = vec![fk("fk_a", "x", "t", "id"), fk("fk_a", "y", "t", "id2"), fk("fk_b", "z", "u", "id")];
        let g = group_fks(&flat);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].columns, vec!["x", "y"]);
        assert_eq!(g[0].ref_columns, vec!["id", "id2"]);
        assert_eq!(g[1].name, "fk_b");
    }

    #[test]
    fn normalize_type_collapses_equivalents() {
        assert_eq!(normalize_type(DbKind::Mysql, "int(11)"), "int");
        assert_eq!(normalize_type(DbKind::Mysql, "INT(11) unsigned"), "int unsigned");
        assert_eq!(normalize_type(DbKind::Mysql, "tinyint(1)"), "tinyint(1)");
        assert_eq!(normalize_type(DbKind::Mysql, "tinyint(4)"), "tinyint");
        assert_eq!(normalize_type(DbKind::Mysql, "boolean"), "tinyint(1)");
        assert_eq!(normalize_type(DbKind::Postgres, "character varying"), "varchar");
        assert_eq!(normalize_type(DbKind::Postgres, "integer"), "int");
        assert_eq!(normalize_type(DbKind::Postgres, "timestamp without time zone"), "timestamp");
        assert_eq!(normalize_type(DbKind::Mssql, "nvarchar"), "varchar");
        assert_eq!(normalize_type(DbKind::Oracle, "VARCHAR2"), "varchar");
    }

    #[test]
    fn type_family_maps_cross_engine() {
        assert_eq!(type_family(DbKind::Mysql, "tinyint(1)"), "bool");
        assert_eq!(type_family(DbKind::Postgres, "boolean"), "bool");
        assert_eq!(type_family(DbKind::Mysql, "bigint unsigned"), "int");
        assert_eq!(type_family(DbKind::Postgres, "numeric"), "decimal");
        assert_eq!(type_family(DbKind::Mysql, "decimal(10,2)"), "decimal");
        assert_eq!(type_family(DbKind::Mssql, "datetime2"), "datetime");
        assert_eq!(type_family(DbKind::Postgres, "text"), "text");
    }

    #[test]
    fn normalize_default_handles_dialect_noise() {
        assert_eq!(normalize_default(DbKind::Postgres, Some("'abc'::character varying")), Some("'abc'".into()));
        assert_eq!(normalize_default(DbKind::Postgres, Some("nextval('t_id_seq'::regclass)")), Some("nextval(…)".into()));
        assert_eq!(normalize_default(DbKind::Mssql, Some("((0))")), Some("0".into()));
        assert_eq!(normalize_default(DbKind::Mariadb, Some("'NULL'")), None);
        assert_eq!(normalize_default(DbKind::Mysql, Some("NULL")), None);
        assert_eq!(normalize_default(DbKind::Mysql, Some("CURRENT_TIMESTAMP")), Some("current_timestamp".into()));
        assert_eq!(normalize_default(DbKind::Postgres, Some("now()")), Some("current_timestamp".into()));
        assert_eq!(normalize_default(DbKind::Mysql, None), None);
    }

    #[test]
    fn normalize_text_strips_definer_and_whitespace() {
        let a = "CREATE DEFINER=`root`@`%` PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND;";
        let b = "CREATE PROCEDURE p() BEGIN SELECT 1; END";
        assert_eq!(normalize_text(DbKind::Mysql, a), normalize_text(DbKind::Mysql, b));
        assert_eq!(normalize_text(DbKind::Oracle, "CREATE OR REPLACE FUNCTION f"), "create function f");
    }

    #[test]
    fn strip_auto_increment_removes_counter() {
        let ddl = "CREATE TABLE `t` (\n  `id` int\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4";
        assert_eq!(strip_auto_increment(ddl), "CREATE TABLE `t` (\n  `id` int\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        // 欄位屬性的 AUTO_INCREMENT（無 =）不受影響。
        assert_eq!(strip_auto_increment("`id` int AUTO_INCREMENT"), "`id` int AUTO_INCREMENT");
    }

    #[test]
    fn schema_json_round_trip_with_defaults() {
        let s = DbSchema {
            kind: DbKind::Sqlite,
            database: "main".into(),
            captured_at_ms: 1,
            label: String::new(),
            tables: vec![TableSchema { name: "t".into(), kind: "table".into(), ..Default::default() }],
            views: vec![],
            routines: vec![],
            warnings: vec![],
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: DbSchema = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tables[0].name, "t");
        // 缺欄位也能載（前向相容）。
        let minimal: DbSchema = serde_json::from_str(r#"{"kind":"mysql","database":"d","captured_at_ms":0}"#).unwrap();
        assert!(minimal.tables.is_empty());
    }
}
