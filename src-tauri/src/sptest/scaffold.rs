//! 從程序盤點產生測試檔骨架（`dbk sp-test init` 與 GUI「新檔」共用）。
//!
//! 目標是「打開就能跑」：前置資料（fixture `base`）依程序本文讀寫到的表與它們的外鍵父表排好順序，
//! 自動編號欄寫 `">>符號"` 回填、外鍵欄引用父表的符號、NOT NULL 又沒預設值的欄填型別樣本；
//! 呼叫參數名稱對得上符號（`CustomerID` ≈ `customer_id`）就引用、OUT 參數擷取成符號。
//! 程序本文裡每個 THROW / RAISERROR / SIGNAL / RAISE EXCEPTION 各產生一個 `skip` 的錯誤情境，
//! 讓「還沒測到的錯誤分支」一眼可見——使用者改好參數、拿掉 `skip` 就是一個錯誤路徑測試。
//!
//! 期望值刻意不猜：happy path 先跑一次看實際輸出，再用 GUI 的「採用實際值」或 `--mode record` 定下來。

use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Map, Value};

use super::inspect::{self, norm_param, ParamMode, RoutineSig};
use super::snapshot;
use crate::db::sqlgen::sql_literal;
use crate::db::stmt::code_only;
use crate::db::DbKind;
use crate::error::AppResult;
use crate::manager::ConnectionManager;

#[derive(Debug, Clone, Default)]
pub struct ScaffoldColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub has_default: bool,
    pub identity: bool,
    pub writable: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ScaffoldFk {
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

#[derive(Debug, Clone, Default)]
pub struct ScaffoldTable {
    pub name: String,
    pub columns: Vec<ScaffoldColumn>,
    pub fks: Vec<ScaffoldFk>,
}

/// 程序本文裡的一個「主動拋錯」分支。
#[derive(Debug, Clone, PartialEq)]
pub struct ErrorBranch {
    pub message: String,
    pub code: Option<i64>,
}

pub struct ScaffoldInput<'a> {
    pub kind: DbKind,
    pub database: &'a str,
    pub routine: &'a str,
    pub sig: &'a RoutineSig,
    /// 已依外鍵排好序（父表在前）。
    pub seed_tables: &'a [ScaffoldTable],
    pub breaks_wrapping: bool,
    pub errors: &'a [ErrorBranch],
}

fn engine_name(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Mssql => "mssql",
        DbKind::Postgres => "postgres",
        DbKind::Mariadb => "mariadb",
        _ => "mysql",
    }
}

/// 表名去掉 schema 前綴（`dbo.orders` → `orders`）：測試檔的表名不帶 schema 時依連線解析，跨引擎才通用。
fn short_table(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

/// 自動編號欄的符號名：欄名本身；叫 `id` 的欄改成 `<表>_id`，免得兩張表撞名。
fn identity_symbol(table: &str, col: &str) -> String {
    if col.eq_ignore_ascii_case("id") {
        format!("{}_id", short_table(table).to_ascii_lowercase())
    } else {
        col.to_string()
    }
}

/// `varchar(4)` → `Some(4)`；`varchar(max)` / 無長度 → `None`。
fn type_len(dt: &str) -> Option<usize> {
    let open = dt.find('(')?;
    let inner = &dt[open + 1..dt[open..].find(')').map(|i| open + i)?];
    inner.split(',').next()?.trim().parse().ok()
}

/// 型別樣本值。`for_param`：參數用小數量（1），seed 用寬鬆的庫存量（10），下單一類的程序才不會一跑就庫存不足。
fn sample_value(data_type: &str, for_param: bool) -> Value {
    let dt = data_type.trim().to_ascii_lowercase();
    let base = dt.split('(').next().unwrap_or("").trim();
    if base == "bit" || base.starts_with("bool") || dt.starts_with("tinyint(1)") {
        return Value::Bool(true);
    }
    if base.contains("int") || base == "serial" || base == "bigserial" {
        return json!(if for_param { 1 } else { 10 });
    }
    if ["decimal", "numeric", "money", "smallmoney", "real", "float", "double", "double precision", "number"].contains(&base) {
        return Value::String("10.00".into());
    }
    if base == "date" {
        return Value::String("2026-01-01".into());
    }
    if base.starts_with("datetime") || base.starts_with("timestamp") || base == "smalldatetime" {
        return Value::String("2026-01-01 00:00:00".into());
    }
    if base.starts_with("time") {
        return Value::String("12:00:00".into());
    }
    if base == "uniqueidentifier" || base == "uuid" {
        return Value::String("00000000-0000-0000-0000-000000000001".into());
    }
    if base == "json" || base == "jsonb" {
        return json!({"type": "json", "value": "{}"});
    }
    if base.contains("binary") || base == "bytea" || base.contains("blob") || base == "image" {
        return json!({"type": "bytes", "value": "AA=="});
    }
    let mut s = "test".to_string();
    if let Some(n) = type_len(&dt) {
        s.truncate(n.max(1));
    }
    Value::String(s)
}

/// 參數在測試檔裡的鍵：去掉 MSSQL 的 `@`（`params` 依正規化名稱對簽名，寫哪種風格都行）。
fn param_key(name: &str) -> String {
    name.trim_start_matches('@').to_string()
}

/// 錯誤訊息 → 情境 id 片段：ASCII 英數字以外換成底線，最多 40 字。
fn slug(msg: &str) -> String {
    let mut out = String::new();
    for c in msg.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_end_matches('_').to_string()
}

/// 依外鍵排序：父表在前（Kahn；環狀依賴就照原順序收尾）。
pub fn order_seed(tables: Vec<ScaffoldTable>) -> Vec<ScaffoldTable> {
    let names: Vec<String> = tables.iter().map(|t| t.name.to_ascii_lowercase()).collect();
    let mut placed: Vec<bool> = vec![false; tables.len()];
    let mut order: Vec<usize> = Vec::new();
    loop {
        let mut progressed = false;
        for (i, t) in tables.iter().enumerate() {
            if placed[i] {
                continue;
            }
            let ready = t.fks.iter().all(|fk| {
                let r = fk.ref_table.to_ascii_lowercase();
                r == names[i] || !names.contains(&r) || names.iter().enumerate().any(|(j, n)| *n == r && placed[j])
            });
            if ready {
                placed[i] = true;
                order.push(i);
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    for (i, p) in placed.iter().enumerate() {
        if !p {
            order.push(i);
        }
    }
    let mut slots: Vec<Option<ScaffoldTable>> = tables.into_iter().map(Some).collect();
    order.into_iter().filter_map(|i| slots[i].take()).collect()
}

/// 程序本文裡主動拋出的錯誤（訊息 + 錯誤號）。只認字串字面值的訊息；組字串的動態訊息略過。
pub fn error_branches(kind: DbKind, body: &str) -> Vec<ErrorBranch> {
    let code = strip_line_comments(body);
    let upper = code.to_ascii_uppercase();
    let mut out: Vec<ErrorBranch> = Vec::new();
    let mut push = |b: ErrorBranch| {
        if !b.message.is_empty() && !out.iter().any(|x| x.message == b.message) {
            out.push(b);
        }
    };
    let find_all = |needle: &str| -> Vec<usize> { upper.match_indices(needle).map(|(i, _)| i).collect() };
    match kind {
        DbKind::Mssql => {
            for i in find_all("THROW") {
                // THROW 50001, N'msg', 1
                let rest = &code[i + 5..];
                let num: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
                if num.is_empty() {
                    continue; // 單獨的 THROW; 是 rethrow
                }
                if let Some(msg) = first_string_literal(rest) {
                    push(ErrorBranch { message: msg, code: num.parse().ok() });
                }
            }
            for i in find_all("RAISERROR") {
                if let Some(msg) = first_string_literal(&code[i + 9..]) {
                    push(ErrorBranch { message: msg, code: None });
                }
            }
        }
        DbKind::Postgres => {
            for i in find_all("RAISE EXCEPTION") {
                let rest = &code[i + 15..];
                if rest.trim_start().starts_with('\'') {
                    if let Some(msg) = first_string_literal(rest) {
                        push(ErrorBranch { message: msg, code: None });
                    }
                }
            }
        }
        _ => {
            for i in find_all("SIGNAL") {
                let end = upper[i..].find(';').map(|e| i + e).unwrap_or(upper.len());
                let stmt = &code[i..end];
                let su = &upper[i..end];
                let Some(m) = su.find("MESSAGE_TEXT") else { continue };
                let Some(msg) = first_string_literal(&stmt[m..]) else { continue };
                let errno = su.find("MYSQL_ERRNO").and_then(|e| {
                    let after = stmt[e + 11..].trim_start().trim_start_matches('=').trim_start();
                    after.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
                });
                push(ErrorBranch { message: msg, code: errno });
            }
        }
    }
    out
}

fn strip_line_comments(s: &str) -> String {
    s.lines().map(|l| l.split("--").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

/// `… N'it''s' …` → `it's`（第一個單引號字串）。
fn first_string_literal(s: &str) -> Option<String> {
    let start = s.find('\'')?;
    let mut out = String::new();
    let mut chars = s[start + 1..].chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            if chars.peek() == Some(&'\'') {
                chars.next();
                out.push('\'');
                continue;
            }
            return Some(out);
        }
        out.push(c);
    }
    None
}

/// 只被 INSERT（沒被 UPDATE / DELETE / MERGE）的表：程序自己會新增列，不必先灌前置資料。
pub fn insert_only_targets(code: &str) -> HashSet<String> {
    let words: Vec<String> = code
        .split(|c: char| c.is_whitespace() || c == '(' || c == ';' || c == ',')
        .filter(|w| !w.is_empty())
        .map(|w| w.trim_matches(|c| c == '"' || c == '`' || c == '[' || c == ']').replace(['"', '`', '[', ']'], ""))
        .collect();
    let mut inserted = HashSet::new();
    let mut modified = HashSet::new();
    for (i, w) in words.iter().enumerate() {
        let up = w.to_ascii_uppercase();
        let at = |k: usize| words.get(i + k).map(|s| short_table(s).to_ascii_lowercase()).unwrap_or_default();
        match up.as_str() {
            "INSERT" => {
                let mut j = 1;
                while words.get(i + j).map(|s| matches!(s.to_ascii_uppercase().as_str(), "INTO" | "IGNORE")).unwrap_or(false) {
                    j += 1;
                }
                inserted.insert(at(j));
            }
            "UPDATE" => {
                let prev = if i > 0 { words[i - 1].to_ascii_uppercase() } else { String::new() };
                if prev != "KEY" && prev != "FOR" {
                    modified.insert(at(1));
                }
            }
            "DELETE" => {
                let j = if words.get(i + 1).map(|s| s.eq_ignore_ascii_case("FROM")).unwrap_or(false) { 2 } else { 1 };
                modified.insert(at(j));
            }
            "MERGE" => {
                let j = if words.get(i + 1).map(|s| s.eq_ignore_ascii_case("INTO")).unwrap_or(false) { 2 } else { 1 };
                modified.insert(at(j));
            }
            _ => {}
        }
    }
    inserted.retain(|t| !t.is_empty() && !modified.contains(t));
    inserted
}

/// 本文提到的表（逐字比對 `list_tables`；`dbo.x` / `sptest.x` / `x` 都算）。依出現順序、不重複。
pub fn referenced_tables(code: &str, tables: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in code.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.' || c == '$')) {
        if w.is_empty() {
            continue;
        }
        let short = short_table(w);
        if let Some(t) = tables.iter().find(|t| t.eq_ignore_ascii_case(w) || short_table(t).eq_ignore_ascii_case(short)) {
            if !out.contains(t) {
                out.push(t.clone());
            }
        }
    }
    out
}

/// 組出骨架（純函式；`scaffold` 負責蒐集輸入）。
pub fn build(inp: &ScaffoldInput<'_>) -> Value {
    // 1. fixture base：每張表一列
    let mut symbols: BTreeMap<String, String> = BTreeMap::new(); // 正規化欄名 → 符號
    let mut table_sym: BTreeMap<String, (String, String)> = BTreeMap::new(); // 表（小寫短名）→（自動編號欄, 符號）
    let mut used: HashSet<String> = HashSet::new();
    let mut steps: Vec<Value> = Vec::new();
    for t in inp.seed_tables {
        let mut row = Map::new();
        for c in &t.columns {
            if c.identity {
                let mut sym = identity_symbol(&t.name, &c.name);
                while !used.insert(sym.clone()) {
                    sym.push('2');
                }
                row.insert(c.name.clone(), Value::String(format!(">>{sym}")));
                symbols.entry(norm_param(&c.name)).or_insert_with(|| sym.clone());
                symbols.entry(norm_param(&sym)).or_insert_with(|| sym.clone());
                table_sym.insert(short_table(&t.name).to_ascii_lowercase(), (c.name.clone(), sym));
                continue;
            }
            if !c.writable {
                continue;
            }
            let parent = t.fks.iter().find(|fk| fk.column.eq_ignore_ascii_case(&c.name)).and_then(|fk| {
                table_sym
                    .get(&short_table(&fk.ref_table).to_ascii_lowercase())
                    .filter(|(col, _)| col.eq_ignore_ascii_case(&fk.ref_column))
                    .map(|(_, sym)| sym.clone())
            });
            if let Some(sym) = parent {
                row.insert(c.name.clone(), Value::String(format!("<<{sym}")));
            } else if !c.nullable && !c.has_default {
                row.insert(c.name.clone(), sample_value(&c.data_type, false));
            }
        }
        if !row.is_empty() {
            steps.push(json!({"insert": short_table(&t.name), "rows": [Value::Object(row)]}));
        }
    }

    // 2. 呼叫參數
    let mut params = Map::new();
    for p in &inp.sig.params {
        let key = param_key(&p.name);
        let v = match p.mode {
            ParamMode::Out | ParamMode::InOut => Value::String(format!(">>{}", key.trim_start_matches("p_"))),
            ParamMode::In => match symbols.get(&norm_param(&p.name)) {
                Some(sym) => Value::String(format!("<<{sym}")),
                None => sample_value(&p.data_type, true),
            },
        };
        params.insert(key, v);
    }
    let has_base = !steps.is_empty();
    let uses = if has_base { json!(["base"]) } else { json!([]) };
    let wrap_skip = inp.breaks_wrapping.then(|| t!("程序內含 COMMIT / ROLLBACK 或會隱式 commit 的 DDL，無法包在交易裡跑（見文件「限制」）").to_string());

    let mut happy = json!({
        "id": "happy_path",
        "description": t!("TODO：先按執行看實際輸出，再用「採用實際值」（或 --mode record）把期望定下來"),
        "use": uses,
        "steps": [{"call": inp.routine, "params": Value::Object(params.clone())}],
    });
    if let Some(r) = &wrap_skip {
        happy["skip"] = Value::String(r.clone());
    }
    let mut scenarios = vec![happy];

    // 3. 每個錯誤分支一個 skip 的情境
    let mut ids: HashSet<String> = HashSet::from(["happy_path".to_string()]);
    for (i, e) in inp.errors.iter().enumerate() {
        let s = slug(&e.message);
        let mut id = if s.is_empty() { format!("error_{}", i + 1) } else { format!("error_{s}") };
        while !ids.insert(id.clone()) {
            id.push('2');
        }
        let mut expect = Map::new();
        expect.insert("class".into(), Value::String("user_raised".into()));
        if let Some(c) = e.code {
            expect.insert("code".into(), json!(c));
        }
        expect.insert("message_contains".into(), Value::String(e.message.clone()));
        scenarios.push(json!({
            "id": id,
            "description": tf!("TODO：調整參數或前置資料，讓程序走到「{msg}」這個分支", msg = e.message),
            "skip": wrap_skip.clone().unwrap_or_else(|| t!("TODO：改好參數後拿掉 skip").to_string()),
            "use": uses,
            "steps": [{"call": inp.routine, "params": Value::Object(params.clone()), "expect_error": Value::Object(expect)}],
        }));
    }

    let mut file = Map::new();
    file.insert("version".into(), json!(1));
    file.insert("target".into(), json!({"kind": engine_name(inp.kind), "database": inp.database}));
    file.insert("routine".into(), Value::String(inp.routine.to_string()));
    if has_base {
        file.insert("fixtures".into(), json!({"base": {"description": t!("自動產生：程序讀寫到的表與外鍵父表各一列"), "steps": steps}}));
    }
    file.insert("scenarios".into(), Value::Array(scenarios));
    Value::Object(file)
}

/// PG 的 `GENERATED BY DEFAULT AS IDENTITY`：driver 的欄位資訊只標「一律產生」的那種（BY DEFAULT 可明確賦值），
/// 但骨架要知道它是自動編號才會寫 `">>符號"` 回填，而不是塞一個樣本數字。
async fn pg_identity_cols(mgr: &ConnectionManager, id: &str, schema: &str, table: &str) -> Vec<String> {
    let sql = format!(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = {} AND table_name = {} AND is_identity = 'YES'",
        sql_literal(DbKind::Postgres, Some(schema)),
        sql_literal(DbKind::Postgres, Some(table))
    );
    mgr.query_capped(id, &sql, 0).await.map(|q| q.rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect()).unwrap_or_default()
}

/// 連線蒐集輸入後產生骨架。
pub async fn scaffold(mgr: &ConnectionManager, id: &str, kind: DbKind, database: &str, routine: &str) -> AppResult<Value> {
    let sig = inspect::routine_sig(mgr, id, kind, database, routine).await?;
    let (_, name) = inspect::split_routine(kind, database, routine);
    let rt = match sig.kind {
        inspect::RoutineKind::Procedure => "procedure",
        inspect::RoutineKind::Function => "function",
    };
    let definition = match mgr.routine_definition(id, database, &name, rt).await {
        Ok(d) => d,
        Err(_) => mgr.routine_definition(id, database, routine, rt).await.unwrap_or_default(),
    };
    let code = code_only(&definition);
    let all_tables: Vec<String> = mgr.list_tables(id, database).await?.into_iter().map(|t| t.name).collect();
    let insert_only = insert_only_targets(&code);
    let mut wanted: Vec<String> = referenced_tables(&code, &all_tables)
        .into_iter()
        .filter(|t| !insert_only.contains(&short_table(t).to_ascii_lowercase()))
        .collect();
    // 外鍵父表（最多三層）
    let mut fks_of: BTreeMap<String, Vec<ScaffoldFk>> = BTreeMap::new();
    let mut i = 0;
    let mut depth_end = wanted.len();
    let mut depth = 0;
    while i < wanted.len() {
        let t = wanted[i].clone();
        let fks: Vec<ScaffoldFk> = mgr
            .list_foreign_keys(id, database, &snapshot::driver_table_name(kind, database, &t))
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|f| ScaffoldFk { column: f.column, ref_table: f.ref_table, ref_column: f.ref_column })
            .collect();
        if depth < 3 {
            for fk in &fks {
                if let Some(rt) = inspect::resolve_table(kind, database, &fk.ref_table, &all_tables) {
                    if !wanted.contains(&rt) {
                        wanted.push(rt);
                    }
                }
            }
        }
        fks_of.insert(t, fks);
        i += 1;
        if i == depth_end {
            depth += 1;
            depth_end = wanted.len();
        }
    }
    let mut tables: Vec<ScaffoldTable> = Vec::new();
    for t in &wanted {
        let Ok(tr) = snapshot::load_table(mgr, id, kind, database, t).await else { continue };
        let infos = mgr.table_columns(id, database, &snapshot::driver_table_name(kind, database, t)).await.unwrap_or_default();
        let pg_identity = if kind == DbKind::Postgres { pg_identity_cols(mgr, id, database, &snapshot::driver_table_name(kind, database, t)).await } else { vec![] };
        let columns = tr
            .meta
            .columns
            .iter()
            .map(|c| {
                let info = infos.iter().find(|i| i.name.eq_ignore_ascii_case(&c.name));
                ScaffoldColumn {
                    name: c.name.clone(),
                    data_type: info.map(|i| i.data_type.clone()).unwrap_or_else(|| c.data_type.clone()),
                    nullable: info.map(|i| i.nullable).unwrap_or(true),
                    has_default: info.map(|i| i.default.as_deref().map(|d| !d.trim().is_empty()).unwrap_or(false)).unwrap_or(false),
                    identity: c.identity || tr.identity_cols.iter().chain(pg_identity.iter()).any(|x| x.eq_ignore_ascii_case(&c.name)),
                    writable: c.writable,
                }
            })
            .collect();
        // 外鍵的父表名也正規化成 list_tables 的寫法，排序才對得上。
        let fks = fks_of
            .remove(t)
            .unwrap_or_default()
            .into_iter()
            .map(|mut fk| {
                if let Some(rt) = inspect::resolve_table(kind, database, &fk.ref_table, &all_tables) {
                    fk.ref_table = rt;
                }
                fk
            })
            .collect();
        tables.push(ScaffoldTable { name: t.clone(), columns, fks });
    }
    let seed = order_seed(tables);
    let errors = error_branches(kind, &definition);
    Ok(build(&ScaffoldInput {
        kind,
        database,
        routine,
        sig: &sig,
        seed_tables: &seed,
        breaks_wrapping: inspect::body_breaks_wrapping(kind, &definition),
        errors: &errors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sptest::inspect::{ParamInfo, RoutineKind};
    use crate::sptest::model::{self, TestFile};

    fn col(name: &str, dt: &str, nullable: bool, has_default: bool, identity: bool) -> ScaffoldColumn {
        ScaffoldColumn { name: name.into(), data_type: dt.into(), nullable, has_default, identity, writable: true }
    }

    fn shop() -> Vec<ScaffoldTable> {
        vec![
            ScaffoldTable {
                name: "dbo.orders".into(),
                columns: vec![
                    col("order_id", "int", false, false, true),
                    col("customer_id", "int", false, false, false),
                    col("product_id", "int", false, false, false),
                    col("qty", "int", false, false, false),
                    col("status", "nvarchar(20)", false, true, false),
                ],
                fks: vec![
                    ScaffoldFk { column: "customer_id".into(), ref_table: "dbo.customers".into(), ref_column: "customer_id".into() },
                    ScaffoldFk { column: "product_id".into(), ref_table: "dbo.products".into(), ref_column: "product_id".into() },
                ],
            },
            ScaffoldTable {
                name: "dbo.products".into(),
                columns: vec![col("product_id", "int", false, false, true), col("name", "nvarchar(50)", false, false, false), col("price", "decimal(12,2)", false, false, false), col("stock", "int", false, false, false)],
                fks: vec![],
            },
            ScaffoldTable {
                name: "dbo.customers".into(),
                columns: vec![col("customer_id", "int", false, false, true), col("name", "char(2)", false, false, false), col("is_active", "bit", false, true, false), col("note", "nvarchar(200)", true, false, false)],
                fks: vec![],
            },
        ]
    }

    fn sig() -> RoutineSig {
        RoutineSig {
            schema: "dbo".into(),
            name: "usp_cancel_order".into(),
            kind: RoutineKind::Procedure,
            params: vec![
                ParamInfo { name: "@OrderID".into(), data_type: "int".into(), mode: ParamMode::In, ordinal: 1 },
                ParamInfo { name: "@Reason".into(), data_type: "nvarchar(100)".into(), mode: ParamMode::In, ordinal: 2 },
                ParamInfo { name: "@Refund".into(), data_type: "decimal(12,2)".into(), mode: ParamMode::Out, ordinal: 3 },
            ],
            returns_set: false,
            return_type: None,
        }
    }

    #[test]
    fn seeds_parents_first_and_links_foreign_keys() {
        let seed = order_seed(shop());
        let names: Vec<&str> = seed.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names.last(), Some(&"dbo.orders"), "{names:?}");
        let errors = vec![ErrorBranch { message: "order not found".into(), code: Some(50004) }, ErrorBranch { message: "order not cancellable".into(), code: Some(50006) }];
        let s = sig();
        let v = build(&ScaffoldInput { kind: DbKind::Mssql, database: "sales", routine: "usp_cancel_order", sig: &s, seed_tables: &seed, breaks_wrapping: false, errors: &errors });
        let steps = v["fixtures"]["base"]["steps"].as_array().unwrap();
        let orders = steps.iter().find(|s| s["insert"] == "orders").unwrap();
        let row = &orders["rows"][0];
        assert_eq!(row["order_id"], ">>order_id");
        assert_eq!(row["customer_id"], "<<customer_id");
        assert_eq!(row["product_id"], "<<product_id");
        assert_eq!(row["qty"], 10);
        assert!(row.get("status").is_none(), "有預設值的欄不填");
        let cust = &steps.iter().find(|s| s["insert"] == "customers").unwrap()["rows"][0];
        assert_eq!(cust["name"], "te", "char(2) 截斷");
        assert!(cust.get("note").is_none() && cust.get("is_active").is_none());
        let price = &steps.iter().find(|s| s["insert"] == "products").unwrap()["rows"][0]["price"];
        assert_eq!(price, "10.00");
        // 參數：名稱對得上符號就引用；OUT 擷取
        let call = &v["scenarios"][0]["steps"][0];
        assert_eq!(call["params"]["OrderID"], "<<order_id");
        assert_eq!(call["params"]["Reason"], "test");
        assert_eq!(call["params"]["Refund"], ">>Refund");
        // 錯誤分支情境
        let sc = v["scenarios"].as_array().unwrap();
        assert_eq!(sc.len(), 3);
        assert_eq!(sc[1]["id"], "error_order_not_found");
        assert_eq!(sc[1]["steps"][0]["expect_error"]["code"], 50004);
        assert!(sc[1]["skip"].is_string());
        // 產出的檔案本身要能解析、驗證通過
        let f: TestFile = serde_json::from_value(v).unwrap();
        assert!(model::validate(&f).is_empty(), "{:?}", model::validate(&f));
    }

    #[test]
    fn breaks_wrapping_skips_everything_and_no_tables_means_no_fixture() {
        let s = sig();
        let v = build(&ScaffoldInput { kind: DbKind::Postgres, database: "public", routine: "p", sig: &s, seed_tables: &[], breaks_wrapping: true, errors: &[] });
        assert!(v.get("fixtures").is_none());
        assert!(v["scenarios"][0]["skip"].as_str().unwrap().contains("COMMIT"));
        assert_eq!(v["scenarios"][0]["use"], json!([]));
        assert_eq!(v["target"]["kind"], "postgres");
        let f: TestFile = serde_json::from_value(v).unwrap();
        assert!(model::validate(&f).is_empty());
    }

    #[test]
    fn finds_error_branches_per_engine() {
        let ms = "IF @x IS NULL THROW 50001, N'customer not found', 1;\n-- THROW 50009, 'commented', 1;\nBEGIN CATCH THROW; END CATCH\nRAISERROR('it''s bad', 16, 1);";
        assert_eq!(
            error_branches(DbKind::Mssql, ms),
            vec![ErrorBranch { message: "customer not found".into(), code: Some(50001) }, ErrorBranch { message: "it's bad".into(), code: None }]
        );
        let my = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'qty must be positive', MYSQL_ERRNO = 50005;\nSIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no errno';";
        assert_eq!(
            error_branches(DbKind::Mysql, my),
            vec![ErrorBranch { message: "qty must be positive".into(), code: Some(50005) }, ErrorBranch { message: "no errno".into(), code: None }]
        );
        let pg = "IF v IS NULL THEN RAISE EXCEPTION 'product not found'; END IF; RAISE EXCEPTION USING MESSAGE = 'dyn'; RAISE NOTICE 'hi';";
        assert_eq!(error_branches(DbKind::Postgres, pg), vec![ErrorBranch { message: "product not found".into(), code: None }]);
    }

    #[test]
    fn insert_only_and_referenced() {
        let code = "INSERT INTO dbo.orders (a) VALUES (1); UPDATE dbo.products SET stock = 1; SELECT * FROM dbo.customers c JOIN dbo.orders o ON 1=1; INSERT INTO audit_log VALUES (1); DELETE FROM audit_log";
        let only = insert_only_targets(code);
        assert!(only.contains("orders"));
        assert!(!only.contains("products") && !only.contains("audit_log"));
        let tables = vec!["dbo.customers".to_string(), "dbo.orders".into(), "dbo.products".into(), "dbo.audit_log".into(), "dbo.unused".into()];
        assert_eq!(referenced_tables(code, &tables), vec!["dbo.orders", "dbo.products", "dbo.customers", "dbo.audit_log"]);
    }

    #[test]
    fn samples() {
        assert_eq!(sample_value("tinyint(1)", false), json!(true));
        assert_eq!(sample_value("bigint", true), json!(1));
        assert_eq!(sample_value("numeric(12,2)", false), json!("10.00"));
        assert_eq!(sample_value("datetime2(7)", false), json!("2026-01-01 00:00:00"));
        assert_eq!(sample_value("varchar(max)", false), json!("test"));
        assert_eq!(sample_value("uniqueidentifier", false), json!("00000000-0000-0000-0000-000000000001"));
        assert_eq!(slug("Customer not found / inactive!"), "customer_not_found_inactive");
        assert_eq!(identity_symbol("dbo.orders", "id"), "orders_id");
    }
}
