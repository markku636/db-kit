//! 盤點：預存程序的簽名（參數名 / 型別 / 方向、程序或函式、是否回結果集）與**寫入目標表**。
//!
//! 簽名決定 harness 怎麼呼叫（MSSQL 要 DECLARE OUTPUT 變數的型別、PG 要知道是 CALL 還是 SELECT、
//! MySQL 的 OUT 走 `@var`）；寫入目標決定 `snapshot: "auto"` 要在呼叫前後快照哪些表。
//! MSSQL 有 `sys.dm_sql_referenced_entities` 連 `is_updated` 都告訴你；PG 的 `pg_depend` 看不進
//! plpgsql 本文、MySQL 沒有依賴目錄，兩者只能掃本文——掃到的名字一律對回 `list_tables`，掃錯不會進快照。

use std::collections::{BTreeSet, HashSet};

use serde::{Deserialize, Serialize};

use crate::db::sqlgen::sql_literal;
use crate::db::stmt::code_only;
use crate::db::DbKind;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamMode {
    In,
    Out,
    InOut,
}

impl ParamMode {
    pub fn is_output(self) -> bool {
        !matches!(self, ParamMode::In)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamInfo {
    /// 引擎的原名（MSSQL 含 `@`）。
    pub name: String,
    pub data_type: String,
    pub mode: ParamMode,
    pub ordinal: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineKind {
    Procedure,
    Function,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutineSig {
    /// 容器（MSSQL schema / PG schema / MySQL database）。
    pub schema: String,
    pub name: String,
    pub kind: RoutineKind,
    pub params: Vec<ParamInfo>,
    /// 函式回集合（PG `proretset` / `RETURNS TABLE`、MSSQL TVF）。
    pub returns_set: bool,
    pub return_type: Option<String>,
}

impl RoutineSig {
    /// 以正規化名稱找參數（忽略大小寫、`@`、`p_` 前綴與底線）。
    pub fn find_param(&self, given: &str) -> Option<&ParamInfo> {
        let want = norm_param(given);
        self.params.iter().find(|p| norm_param(&p.name) == want)
    }
}

/// 參數名正規化：`@CustomerID` / `p_customer_id` / `customer_id` 都收斂成 `customerid`，
/// 讓同一份測試檔在來源引擎與 PG 版本之間不必重寫參數名。
pub fn norm_param(name: &str) -> String {
    let s = name.trim().trim_start_matches('@').to_ascii_lowercase();
    let s = s.strip_prefix("p_").or_else(|| s.strip_prefix("in_")).or_else(|| s.strip_prefix("io_")).unwrap_or(&s);
    s.chars().filter(|c| *c != '_').collect()
}

/// `schema.name` / `name` → (schema, name)；沒給 schema 時用引擎的預設容器。
pub fn split_routine(kind: DbKind, database: &str, given: &str) -> (String, String) {
    let g = given.trim().trim_matches(|c| c == '[' || c == ']' || c == '"' || c == '`');
    match g.split_once('.') {
        Some((s, n)) => (
            s.trim_matches(|c| c == '[' || c == ']' || c == '"' || c == '`').to_string(),
            n.trim_matches(|c| c == '[' || c == ']' || c == '"' || c == '`').to_string(),
        ),
        None => match kind {
            DbKind::Mssql => ("dbo".to_string(), g.to_string()),
            _ => (database.to_string(), g.to_string()),
        },
    }
}

fn mssql_type(type_name: &str, max_length: i64, precision: i64, scale: i64) -> String {
    let t = type_name.to_ascii_lowercase();
    match t.as_str() {
        "nvarchar" | "nchar" => {
            if max_length < 0 { format!("{t}(MAX)") } else { format!("{t}({})", max_length / 2) }
        }
        "varchar" | "char" | "varbinary" | "binary" => {
            if max_length < 0 { format!("{t}(MAX)") } else { format!("{t}({max_length})") }
        }
        "decimal" | "numeric" => format!("{t}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{t}({scale})"),
        _ => t,
    }
}

/// 讀取簽名。
pub async fn routine_sig(mgr: &ConnectionManager, id: &str, kind: DbKind, database: &str, given: &str) -> AppResult<RoutineSig> {
    let (schema, name) = split_routine(kind, database, given);
    match kind {
        DbKind::Mssql => {
            let db = database.replace(']', "]]");
            let obj = sql_literal(kind, Some(&format!("[{}].[{}].[{}]", database, schema, name)));
            let q = mgr
                .query_capped(
                    id,
                    &format!(
                        "SELECT o.type, p.name, TYPE_NAME(p.user_type_id), p.max_length, p.precision, p.scale, p.is_output, p.parameter_id \
                         FROM [{db}].sys.objects o LEFT JOIN [{db}].sys.parameters p ON p.object_id = o.object_id \
                         WHERE o.object_id = OBJECT_ID({obj}) ORDER BY p.parameter_id"
                    ),
                    0,
                )
                .await?;
            if q.rows.is_empty() {
                return Err(AppError::NotFound(tf!("找不到預存程序 {name}", name = given)));
            }
            let cell = |r: &Vec<Option<String>>, i: usize| r.get(i).cloned().flatten();
            let ty = cell(&q.rows[0], 0).unwrap_or_default();
            let rkind = if ty.trim() == "P" || ty.trim() == "PC" { RoutineKind::Procedure } else { RoutineKind::Function };
            let mut params = Vec::new();
            let mut return_type = None;
            for r in &q.rows {
                let Some(pname) = cell(r, 1) else { continue };
                let ordinal: i32 = cell(r, 7).and_then(|s| s.parse().ok()).unwrap_or(0);
                let data_type = mssql_type(
                    &cell(r, 2).unwrap_or_default(),
                    cell(r, 3).and_then(|s| s.parse().ok()).unwrap_or(0),
                    cell(r, 4).and_then(|s| s.parse().ok()).unwrap_or(0),
                    cell(r, 5).and_then(|s| s.parse().ok()).unwrap_or(0),
                );
                if ordinal == 0 {
                    return_type = Some(data_type);
                    continue;
                }
                let is_out = matches!(cell(r, 6).as_deref(), Some("true") | Some("1"));
                params.push(ParamInfo { name: pname, data_type, mode: if is_out { ParamMode::InOut } else { ParamMode::In }, ordinal });
            }
            let returns_set = matches!(ty.trim(), "IF" | "TF" | "FT");
            Ok(RoutineSig { schema, name, kind: rkind, params, returns_set, return_type })
        }
        DbKind::Postgres => {
            let q = mgr
                .query_capped(
                    id,
                    &format!(
                        "SELECT p.prokind::text, p.proretset::text, pg_get_function_result(p.oid), \
                                array_to_string(p.proargnames, '|'), array_to_string(p.proargmodes::text[], '|'), \
                                (SELECT string_agg(format_type(t, NULL), '|' ORDER BY ord) \
                                   FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS u(t, ord)) \
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                         WHERE n.nspname = {} AND p.proname = {} ORDER BY p.oid LIMIT 1",
                        sql_literal(kind, Some(&schema)),
                        sql_literal(kind, Some(&name))
                    ),
                    1,
                )
                .await?;
            let Some(r) = q.rows.first() else {
                return Err(AppError::NotFound(tf!("找不到預存程序 {name}", name = given)));
            };
            let cell = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
            let rkind = if cell(0) == "p" { RoutineKind::Procedure } else { RoutineKind::Function };
            let returns_set = matches!(cell(1).as_str(), "t" | "true");
            let names: Vec<String> = if cell(3).is_empty() { vec![] } else { cell(3).split('|').map(|s| s.to_string()).collect() };
            let modes: Vec<String> = if cell(4).is_empty() { vec![] } else { cell(4).split('|').map(|s| s.to_string()).collect() };
            let types: Vec<String> = if cell(5).is_empty() { vec![] } else { cell(5).split('|').map(|s| s.to_string()).collect() };
            let mut params = Vec::new();
            for (i, ty) in types.iter().enumerate() {
                let mode = match modes.get(i).map(|s| s.as_str()) {
                    Some("o") => ParamMode::Out,
                    Some("b") => ParamMode::InOut,
                    // table 欄（RETURNS TABLE）不是參數。
                    Some("t") => continue,
                    _ => ParamMode::In,
                };
                let pname = names.get(i).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| format!("${}", i + 1));
                params.push(ParamInfo { name: pname, data_type: ty.clone(), mode, ordinal: i as i32 + 1 });
            }
            // 函式的 OUT 參數是回傳欄位，不是呼叫端要給的東西。
            if rkind == RoutineKind::Function {
                params.retain(|p| p.mode != ParamMode::Out);
            }
            Ok(RoutineSig { schema, name, kind: rkind, params, returns_set, return_type: Some(cell(2)) })
        }
        DbKind::Mysql | DbKind::Mariadb => {
            let q = mgr
                .query_capped(
                    id,
                    &format!(
                        "SELECT r.ROUTINE_TYPE, p.PARAMETER_NAME, p.DTD_IDENTIFIER, p.PARAMETER_MODE, p.ORDINAL_POSITION \
                         FROM information_schema.ROUTINES r LEFT JOIN information_schema.PARAMETERS p \
                           ON p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA AND p.SPECIFIC_NAME = r.ROUTINE_NAME AND p.ROUTINE_TYPE = r.ROUTINE_TYPE \
                         WHERE r.ROUTINE_SCHEMA = {} AND r.ROUTINE_NAME = {} ORDER BY p.ORDINAL_POSITION",
                        sql_literal(kind, Some(&schema)),
                        sql_literal(kind, Some(&name))
                    ),
                    0,
                )
                .await?;
            if q.rows.is_empty() {
                return Err(AppError::NotFound(tf!("找不到預存程序 {name}", name = given)));
            }
            let cell = |r: &Vec<Option<String>>, i: usize| r.get(i).cloned().flatten();
            let rkind = if cell(&q.rows[0], 0).unwrap_or_default().eq_ignore_ascii_case("procedure") {
                RoutineKind::Procedure
            } else {
                RoutineKind::Function
            };
            let mut params = Vec::new();
            let mut return_type = None;
            for r in &q.rows {
                let ordinal: i32 = cell(r, 4).and_then(|s| s.parse().ok()).unwrap_or(0);
                let data_type = cell(r, 2).unwrap_or_default();
                if ordinal == 0 {
                    if !data_type.is_empty() {
                        return_type = Some(data_type);
                    }
                    continue;
                }
                let Some(pname) = cell(r, 1) else { continue };
                let mode = match cell(r, 3).unwrap_or_default().to_ascii_uppercase().as_str() {
                    "OUT" => ParamMode::Out,
                    "INOUT" => ParamMode::InOut,
                    _ => ParamMode::In,
                };
                params.push(ParamInfo { name: pname, data_type, mode, ordinal });
            }
            Ok(RoutineSig { schema, name, kind: rkind, params, returns_set: false, return_type })
        }
        other => Err(AppError::Unsupported(tf!("預存程序測試尚不支援 {kind}", kind = format!("{other:?}")))),
    }
}

/// 寫入目標表（含被呼叫程序與目標表上的 DML 觸發器，遞迴 ≤ 5 層）。回傳與 `list_tables` 同形的表名。
pub async fn write_targets(mgr: &ConnectionManager, id: &str, kind: DbKind, database: &str, given: &str) -> AppResult<Vec<String>> {
    let tables: Vec<String> = mgr.list_tables(id, database).await?.into_iter().map(|t| t.name).collect();
    let mut out: BTreeSet<String> = BTreeSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: Vec<String> = vec![given.to_string()];
    let mut depth = 0;
    while !queue.is_empty() && depth < 5 {
        let mut next = Vec::new();
        for routine in queue.drain(..) {
            let key = routine.to_ascii_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let (schema, name) = split_routine(kind, database, &routine);
            let (writes, callees) = match kind {
                DbKind::Mssql => match mssql_referenced(mgr, id, database, &schema, &name).await {
                    Ok(v) => v,
                    Err(_) => scan_body(mgr, id, kind, database, &routine, &tables).await?,
                },
                _ => scan_body(mgr, id, kind, database, &routine, &tables).await?,
            };
            for w in writes {
                if let Some(t) = resolve_table(kind, database, &w, &tables) {
                    // 表上的 DML 觸發器也會寫別的表。
                    for trig in triggers_of(mgr, id, kind, database, &t).await.unwrap_or_default() {
                        next.push(trig);
                    }
                    out.insert(t);
                }
            }
            next.extend(callees);
        }
        queue = next;
        depth += 1;
    }
    Ok(out.into_iter().collect())
}

/// MSSQL：`sys.dm_sql_referenced_entities` 要在目標庫的脈絡下跑，借 `[db].sys.sp_executesql` 切過去。
async fn mssql_referenced(
    mgr: &ConnectionManager,
    id: &str,
    database: &str,
    schema: &str,
    name: &str,
) -> AppResult<(Vec<String>, Vec<String>)> {
    let db = database.replace(']', "]]");
    let inner = format!(
        "SELECT ISNULL(r.referenced_schema_name, N'dbo'), r.referenced_entity_name, CAST(r.is_updated AS INT), o.type \
         FROM sys.dm_sql_referenced_entities(N'{}.{}', 'OBJECT') r LEFT JOIN sys.objects o ON o.object_id = r.referenced_id \
         WHERE r.referenced_minor_id = 0",
        schema.replace('\'', "''"),
        name.replace('\'', "''")
    );
    let sql = format!("EXEC [{db}].sys.sp_executesql N'{}'", inner.replace('\'', "''"));
    let q = mgr.query_capped(id, &sql, 0).await?;
    let mut writes = Vec::new();
    let mut callees = Vec::new();
    for r in &q.rows {
        let cell = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
        let full = format!("{}.{}", cell(0), cell(1));
        match cell(3).trim() {
            "U" if cell(2) == "1" => writes.push(full),
            "P" | "PC" | "TR" | "FN" | "IF" | "TF" => callees.push(full),
            _ => {}
        }
    }
    Ok((writes, callees))
}

/// PG / MySQL（或 MSSQL 的 fallback）：掃程序本文找 INSERT / UPDATE / DELETE / MERGE / TRUNCATE 的目標與 CALL。
async fn scan_body(
    mgr: &ConnectionManager,
    id: &str,
    kind: DbKind,
    database: &str,
    routine: &str,
    _tables: &[String],
) -> AppResult<(Vec<String>, Vec<String>)> {
    let (_, name) = split_routine(kind, database, routine);
    let routines = mgr.list_routines(id, database).await?;
    let rt = routines
        .iter()
        .find(|r| r.name.eq_ignore_ascii_case(&name) || r.name.eq_ignore_ascii_case(routine))
        .map(|r| r.routine_type.clone())
        .unwrap_or_else(|| "procedure".into());
    let def = match mgr.routine_definition(id, database, &name, &rt).await {
        Ok(d) => d,
        Err(_) => match mgr.routine_definition(id, database, routine, &rt).await {
            Ok(d) => d,
            Err(_) => return Ok((vec![], vec![])),
        },
    };
    Ok(scan_sql_targets(&code_only(&def)))
}

/// 純文字掃描：回（寫入目標, 被呼叫者）。名字保留原樣（含 schema 前綴），由呼叫端對回實際表。
pub fn scan_sql_targets(code: &str) -> (Vec<String>, Vec<String>) {
    let words: Vec<&str> = code.split(|c: char| c.is_whitespace() || c == '(' || c == ';' || c == ',').filter(|w| !w.is_empty()).collect();
    let mut writes = Vec::new();
    let mut callees = Vec::new();
    let ident = |w: &str| -> Option<String> {
        let w = w.trim_matches(|c| c == '"' || c == '`' || c == '[' || c == ']');
        let ok = w.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '$' || c == '"' || c == '`' || c == '[' || c == ']');
        if w.is_empty() || !ok || w.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true) {
            return None;
        }
        Some(w.replace(['"', '`', '[', ']'], ""))
    };
    let mut i = 0;
    while i < words.len() {
        let w = words[i].to_ascii_uppercase();
        let next = |k: usize| words.get(i + k).copied().unwrap_or("");
        match w.as_str() {
            "INSERT" | "REPLACE" => {
                // INSERT INTO t / INSERT IGNORE INTO t / INSERT t（MySQL 可省 INTO）
                let mut j = 1;
                while matches!(next(j).to_ascii_uppercase().as_str(), "INTO" | "IGNORE" | "LOW_PRIORITY" | "DELAYED" | "HIGH_PRIORITY") {
                    j += 1;
                }
                if let Some(t) = ident(next(j)) {
                    writes.push(t);
                }
            }
            "UPDATE" => {
                // 跳過 `ON DUPLICATE KEY UPDATE col` 與 `FOR UPDATE`。
                let prev = if i > 0 { words[i - 1].to_ascii_uppercase() } else { String::new() };
                if prev != "KEY" && prev != "FOR" {
                    if let Some(t) = ident(next(1)) {
                        writes.push(t);
                    }
                }
            }
            "DELETE" => {
                let j = if next(1).eq_ignore_ascii_case("FROM") { 2 } else { 1 };
                if let Some(t) = ident(next(j)) {
                    writes.push(t);
                }
            }
            "MERGE" => {
                let j = if next(1).eq_ignore_ascii_case("INTO") { 2 } else { 1 };
                if let Some(t) = ident(next(j)) {
                    writes.push(t);
                }
            }
            "TRUNCATE" => {
                let j = if next(1).eq_ignore_ascii_case("TABLE") { 2 } else { 1 };
                if let Some(t) = ident(next(j)) {
                    writes.push(t);
                }
            }
            "CALL" | "PERFORM" | "EXEC" | "EXECUTE" => {
                if let Some(t) = ident(next(1)) {
                    // EXEC @rc = proc / EXEC sp_executesql 這種跳過。
                    if !t.starts_with('@') && !t.eq_ignore_ascii_case("sp_executesql") {
                        callees.push(t);
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    (writes, callees)
}

/// 掃出來的名字對回 `list_tables`（大小寫不敏感；MSSQL 的 `dbo.` 可省、PG / MySQL 的庫名前綴可省）。
pub fn resolve_table(kind: DbKind, database: &str, given: &str, tables: &[String]) -> Option<String> {
    let g = given.trim().trim_start_matches('#');
    if g.is_empty() {
        return None;
    }
    let candidates: Vec<String> = {
        let mut v = vec![g.to_string()];
        if let Some((pre, rest)) = g.split_once('.') {
            match kind {
                DbKind::Mssql if pre.eq_ignore_ascii_case("dbo") => v.push(rest.to_string()),
                DbKind::Mssql => {}
                _ if pre.eq_ignore_ascii_case(database) => v.push(rest.to_string()),
                _ => {}
            }
        } else if matches!(kind, DbKind::Mssql) {
            v.push(format!("dbo.{g}"));
        }
        v
    };
    for c in candidates {
        if let Some(t) = tables.iter().find(|t| t.eq_ignore_ascii_case(&c)) {
            return Some(t.clone());
        }
    }
    None
}

/// 表上的 DML 觸發器名（供遞迴掃本文）。
async fn triggers_of(mgr: &ConnectionManager, id: &str, _kind: DbKind, database: &str, table: &str) -> AppResult<Vec<String>> {
    let routines = mgr.list_routines(id, database).await?;
    Ok(routines
        .into_iter()
        .filter(|r| r.routine_type == "trigger")
        .filter(|r| r.parent.as_deref().map(|p| p.eq_ignore_ascii_case(table)).unwrap_or(false))
        .map(|r| r.name)
        .collect())
}

/// 程序本文是否含交易控制 / 隱式 commit 的 DDL（`auto` 模式據此決定能不能包在外層交易裡跑）。
pub fn body_breaks_wrapping(kind: DbKind, body: &str) -> bool {
    let code = code_only(body).to_ascii_uppercase();
    let has = |w: &str| code.split(|c: char| !c.is_alphanumeric() && c != '_').any(|t| t == w);
    match kind {
        DbKind::Mssql => has("ROLLBACK"),
        DbKind::Postgres => has("COMMIT") || has("ROLLBACK"),
        DbKind::Mysql | DbKind::Mariadb => {
            has("COMMIT")
                || has("ROLLBACK")
                || code.contains("START TRANSACTION")
                || has("ALTER")
                || has("DROP")
                || has("TRUNCATE")
                || code.contains("LOCK TABLES")
                || (code.contains("CREATE TABLE") && !code.contains("CREATE TEMPORARY TABLE"))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_normalization() {
        assert_eq!(norm_param("@CustomerID"), "customerid");
        assert_eq!(norm_param("p_customer_id"), "customerid");
        assert_eq!(norm_param("customer_id"), "customerid");
        assert_eq!(norm_param("in_qty"), "qty");
    }

    #[test]
    fn routine_split() {
        assert_eq!(split_routine(DbKind::Mssql, "db", "usp_x"), ("dbo".into(), "usp_x".into()));
        assert_eq!(split_routine(DbKind::Mssql, "db", "[sales].[usp_x]"), ("sales".into(), "usp_x".into()));
        assert_eq!(split_routine(DbKind::Postgres, "sptest", "usp_x"), ("sptest".into(), "usp_x".into()));
        assert_eq!(split_routine(DbKind::Mysql, "sptest", "other.usp_x"), ("other".into(), "usp_x".into()));
    }

    #[test]
    fn scans_write_targets_and_callees() {
        let code = "BEGIN INSERT INTO sptest.orders (a) VALUES (1); UPDATE products SET stock = 1 WHERE id = 1; \
                    DELETE FROM audit_log WHERE 1=0; INSERT INTO x SELECT 1 ON DUPLICATE KEY UPDATE y = 2; \
                    CALL sptest.usp_other(1); EXEC dbo.usp_child @a = 1; MERGE INTO m USING s ON 1=1; END";
        let (w, c) = scan_sql_targets(code);
        assert_eq!(w, vec!["sptest.orders", "products", "audit_log", "x", "m"]);
        assert_eq!(c, vec!["sptest.usp_other", "dbo.usp_child"]);
    }

    #[test]
    fn resolves_names() {
        let tables = vec!["orders".to_string(), "sales.items".to_string()];
        assert_eq!(resolve_table(DbKind::Mssql, "db", "dbo.orders", &tables), Some("orders".into()));
        assert_eq!(resolve_table(DbKind::Mssql, "db", "sales.items", &tables), Some("sales.items".into()));
        assert_eq!(resolve_table(DbKind::Postgres, "sptest", "sptest.orders", &tables), Some("orders".into()));
        assert_eq!(resolve_table(DbKind::Mysql, "sptest", "Orders", &tables), Some("orders".into()));
        assert_eq!(resolve_table(DbKind::Mysql, "sptest", "nope", &tables), None);
    }

    #[test]
    fn wrapping_detection() {
        assert!(body_breaks_wrapping(DbKind::Postgres, "BEGIN INSERT INTO t VALUES (1); COMMIT; END"));
        assert!(!body_breaks_wrapping(DbKind::Postgres, "BEGIN INSERT INTO t VALUES (1); -- COMMIT\n END"));
        assert!(body_breaks_wrapping(DbKind::Mysql, "BEGIN CREATE TABLE x (a int); END"));
        assert!(!body_breaks_wrapping(DbKind::Mysql, "BEGIN CREATE TEMPORARY TABLE x (a int); END"));
        assert!(!body_breaks_wrapping(DbKind::Mssql, "BEGIN TRAN; INSERT INTO t VALUES (1); COMMIT;"));
        assert!(body_breaks_wrapping(DbKind::Mssql, "IF @@ERROR <> 0 ROLLBACK;"));
    }
}
