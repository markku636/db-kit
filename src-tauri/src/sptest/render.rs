//! SQL 渲染：測試檔的值 → 各方言字面值；符號代入；每個 step 在各引擎要送的語句。
//!
//! 代入一律是**字面值替換**而非 bind：三個引擎的簡單協定都不帶參數，而且 MSSQL 的 OUTPUT 變數與
//! 結果集要在同一個 batch 裡才拿得到。注入面只在測試檔本身，可接受。

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::inspect::{ParamMode, RoutineKind, RoutineSig};
use super::model::{capture_name, reference_name, Defaults, Row};
use crate::db::sqlgen::{qualified, quote_ident, sql_literal};
use crate::db::DbKind;
use crate::review_run::capture::{whole_table_select_sql, TableMeta};

// ---------------------------------------------------------------------------
// 符號表
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct Symbols {
    map: BTreeMap<String, Value>,
    /// 符號是從哪一欄擷取的（`>>sym` 的來源欄；檔案層 symbols / cases 的輸入值沒有）。
    cols: BTreeMap<String, String>,
}

impl Symbols {
    pub fn new() -> Symbols {
        Symbols::default()
    }

    pub fn extend(&mut self, extra: &BTreeMap<String, Value>) {
        for (k, v) in extra {
            self.map.insert(k.clone(), v.clone());
            self.cols.remove(k);
        }
    }

    pub fn set(&mut self, name: &str, v: Value) {
        self.map.insert(name.to_string(), v);
        self.cols.remove(name);
    }

    /// 從引擎擷取的值：記下來源欄，基線 / 差分比對才知道哪些欄的這個值其實是「同一筆資料」。
    pub fn set_col(&mut self, name: &str, v: Value, col: &str) {
        self.map.insert(name.to_string(), v);
        self.cols.insert(name.to_string(), col.to_string());
    }

    pub fn columns(&self) -> BTreeMap<String, String> {
        self.cols.clone()
    }

    pub fn get(&self, name: &str) -> Option<&Value> {
        self.map.get(name)
    }

    pub fn names(&self) -> impl Iterator<Item = &String> {
        self.map.keys()
    }

    /// 純量符號的字串形式（結果集符號不算）。存進每步輸出，供基線 / 差分比對把值換回符號名。
    pub fn scalars(&self) -> BTreeMap<String, String> {
        self.map
            .iter()
            .filter_map(|(k, v)| match v {
                Value::String(s) => Some((k.clone(), s.clone())),
                Value::Number(n) => Some((k.clone(), n.to_string())),
                Value::Bool(b) => Some((k.clone(), b.to_string())),
                _ => None,
            })
            .collect()
    }
}

/// 擷取到的儲存格 → 符號值：純整數存成數字（代入 SQL 時不加引號，PG 多載才不會歧義），其餘存字串。
pub fn cell_to_value(cell: Option<&str>) -> Value {
    match cell {
        None => Value::Null,
        Some(s) => {
            let t = s.trim();
            let is_int = !t.is_empty()
                && t.len() <= 18
                && t.trim_start_matches('-').chars().all(|c| c.is_ascii_digit())
                && (t == "0" || !t.trim_start_matches('-').starts_with('0'));
            match (is_int, t.parse::<i64>()) {
                (true, Ok(n)) => Value::from(n),
                _ => Value::String(s.to_string()),
            }
        }
    }
}

/// 結果集 → 符號值（物件陣列），給 `compare` 與 `<<sym.col`。
pub fn set_to_value(columns: &[String], rows: &[Vec<Option<String>>]) -> Value {
    Value::Array(
        rows.iter()
            .map(|r| {
                let mut o = Map::new();
                for (i, c) in columns.iter().enumerate() {
                    o.insert(c.clone(), cell_to_value(r.get(i).and_then(|v| v.as_deref())));
                }
                Value::Object(o)
            })
            .collect(),
    )
}

/// 把 `"<<sym"` / `"<<sym.col"` 換成符號值；`{"not": v}` 遞迴；其餘原樣。`">>sym"` 不在此處理。
pub fn resolve_value(v: &Value, syms: &Symbols) -> Result<Value, String> {
    if let Some((name, col)) = reference_name(v) {
        let base = syms.get(name).ok_or_else(|| tf!("未定義的符號 {name}", name = name))?;
        return match col {
            None => Ok(base.clone()),
            Some(c) => match base {
                Value::Array(rows) => rows
                    .first()
                    .and_then(|r| r.get(c))
                    .cloned()
                    .ok_or_else(|| tf!("符號 {name} 沒有欄位 {col}", name = name, col = c)),
                Value::Object(o) => o.get(c).cloned().ok_or_else(|| tf!("符號 {name} 沒有欄位 {col}", name = name, col = c)),
                _ => Err(tf!("符號 {name} 不是結果集，不能取欄位 {col}", name = name, col = c)),
            },
        };
    }
    if let Value::Object(o) = v {
        if let Some(inner) = o.get("not") {
            let mut m = Map::new();
            m.insert("not".into(), resolve_value(inner, syms)?);
            return Ok(Value::Object(m));
        }
    }
    Ok(v.clone())
}

// ---------------------------------------------------------------------------
// 字面值
// ---------------------------------------------------------------------------

/// JSON 值 → 該方言的 SQL 字面值。
pub fn literal(kind: DbKind, v: &Value) -> Result<String, String> {
    Ok(match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => match kind {
            DbKind::Postgres => if *b { "TRUE".into() } else { "FALSE".into() },
            _ => if *b { "1".into() } else { "0".into() },
        },
        Value::Number(n) => n.to_string(),
        Value::String(s) => sql_literal(kind, Some(s)),
        Value::Object(o) => typed_literal(kind, o)?,
        Value::Array(_) => return Err(t!("陣列不能當 SQL 字面值").into()),
    })
}

fn typed_literal(kind: DbKind, o: &Map<String, Value>) -> Result<String, String> {
    let Some(t) = o.get("type").and_then(|v| v.as_str()) else {
        return Err(t!("物件值只接受 {\"type\", \"value\"} 或 {\"not\": …}").into());
    };
    let s = match o.get("value") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Null) | None => return Ok("NULL".into()),
        Some(other) => other.to_string(),
    };
    let q = |s: &str| sql_literal(kind, Some(s));
    Ok(match t.to_ascii_lowercase().as_str() {
        "decimal" | "number" | "numeric" => {
            if s.trim().parse::<f64>().is_err() {
                return Err(tf!("{v} 不是數字", v = s));
            }
            match kind {
                DbKind::Postgres => format!("{}::numeric", q(&s)),
                _ => s.trim().to_string(),
            }
        }
        "datetime" | "timestamp" => match kind {
            DbKind::Mssql => format!("CAST({} AS DATETIME2)", q(&s)),
            DbKind::Postgres => format!("{}::timestamp", q(&s)),
            _ => format!("TIMESTAMP {}", q(&s)),
        },
        "date" => match kind {
            DbKind::Mssql => format!("CAST({} AS DATE)", q(&s)),
            DbKind::Postgres => format!("{}::date", q(&s)),
            _ => format!("DATE {}", q(&s)),
        },
        "uuid" => match kind {
            DbKind::Mssql => format!("CAST({} AS UNIQUEIDENTIFIER)", q(&s)),
            DbKind::Postgres => format!("{}::uuid", q(&s)),
            _ => q(&s),
        },
        "bytes" => {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|_| t!("bytes 必須是 base64").to_string())?;
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            match kind {
                DbKind::Mssql => format!("0x{hex}"),
                DbKind::Postgres => format!("'\\x{hex}'::bytea"),
                _ => format!("X'{hex}'"),
            }
        }
        "json" => match kind {
            DbKind::Mssql => q(&s),
            DbKind::Postgres => format!("{}::jsonb", q(&s)),
            _ => format!("CAST({} AS JSON)", q(&s)),
        },
        "text" | "string" => q(&s),
        other => return Err(tf!("未知的型別標記 {t}", t = other)),
    })
}

// ---------------------------------------------------------------------------
// SQL 內 `@name` 代入
// ---------------------------------------------------------------------------

/// 把 SQL 裡的 `@name`（name 在符號表內）換成字面值。跳過字串 / 識別字引號 / 註解；`@@x` 不碰
/// （MSSQL 系統變數）；不在符號表內的 `@x` 原樣保留（MySQL 使用者變數、MSSQL 區域變數都是合法語法）。
pub fn substitute_sql(kind: DbKind, sql: &str, syms: &Symbols) -> Result<String, String> {
    let b = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i] as char;
        // 註解
        if c == '-' && b.get(i + 1) == Some(&b'-') {
            let end = sql[i..].find('\n').map(|p| i + p).unwrap_or(b.len());
            out.push_str(&sql[i..end]);
            i = end;
            continue;
        }
        if c == '/' && b.get(i + 1) == Some(&b'*') {
            let end = sql[i + 2..].find("*/").map(|p| i + 2 + p + 2).unwrap_or(b.len());
            out.push_str(&sql[i..end]);
            i = end;
            continue;
        }
        // 引號區段（'…'、"…"、`…`、[…]）
        let close = match c {
            '\'' => Some('\''),
            '"' => Some('"'),
            '`' => Some('`'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(close) = close {
            let mut j = i + 1;
            while j < b.len() {
                if b[j] as char == close {
                    // '' / "" / `` 為跳脫；]] 亦同
                    if b.get(j + 1) == Some(&(close as u8)) {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            let end = (j + 1).min(b.len());
            out.push_str(&sql[i..end]);
            i = end;
            continue;
        }
        if c == '@' {
            let prev_at = i > 0 && b[i - 1] == b'@';
            let next_at = b.get(i + 1) == Some(&b'@');
            if !prev_at && !next_at {
                let mut j = i + 1;
                while j < b.len() && ((b[j] as char).is_alphanumeric() || b[j] == b'_') {
                    j += 1;
                }
                let name = &sql[i + 1..j];
                if !name.is_empty() {
                    if let Some(v) = syms.get(name) {
                        out.push_str(&literal(kind, v)?);
                        i = j;
                        continue;
                    }
                }
            }
        }
        out.push(c);
        i += c.len_utf8();
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 交易骨架
// ---------------------------------------------------------------------------

/// 開場：切到目標庫（PG 為 search_path）、設鎖等待 / 語句逾時、開交易。每個元素一個 batch。
pub fn open_stmts(kind: DbKind, database: &str, d: &Defaults) -> Vec<String> {
    match kind {
        DbKind::Mssql => vec![
            format!("USE {}", quote_ident(kind, database)),
            format!("SET NOCOUNT ON; SET XACT_ABORT OFF; SET LOCK_TIMEOUT {}; BEGIN TRAN;", d.lock_timeout_ms),
        ],
        DbKind::Postgres => vec![format!(
            "BEGIN; SET LOCAL search_path TO {}, public; SET LOCAL lock_timeout = '{}ms'; SET LOCAL statement_timeout = '{}ms';",
            quote_ident(kind, database),
            d.lock_timeout_ms,
            d.statement_timeout_ms
        )],
        _ => vec![
            format!("SET SESSION innodb_lock_wait_timeout = {}", (d.lock_timeout_ms / 1000).max(1)),
            format!("SET SESSION max_execution_time = {}", d.statement_timeout_ms),
            "SET time_zone = '+00:00'".into(),
            "SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO')".into(),
            format!("USE {}", quote_ident(kind, database)),
            "START TRANSACTION".into(),
        ],
    }
}

/// 收場：一律 ROLLBACK。
pub fn close_stmt(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Mssql => "IF @@TRANCOUNT > 0 ROLLBACK TRAN",
        _ => "ROLLBACK",
    }
}

pub fn savepoint_stmt(kind: DbKind, name: &str) -> String {
    match kind {
        DbKind::Mssql => format!("SAVE TRANSACTION {name}"),
        _ => format!("SAVEPOINT {name}"),
    }
}

pub fn rollback_to_stmt(kind: DbKind, name: &str) -> String {
    match kind {
        DbKind::Mssql => format!("IF XACT_STATE() = 1 AND @@TRANCOUNT > 0 ROLLBACK TRANSACTION {name}"),
        _ => format!("ROLLBACK TO SAVEPOINT {name}"),
    }
}

/// 呼叫後查交易狀態（只有 MSSQL 有必要：SP 內的 ROLLBACK 會把外層交易整個滾掉）。
pub fn tx_state_stmt(kind: DbKind) -> Option<&'static str> {
    match kind {
        DbKind::Mssql => Some("SELECT @@TRANCOUNT AS tc, XACT_STATE() AS xs"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 表名
// ---------------------------------------------------------------------------

/// 測試檔裡的表名 → 限定名。MSSQL 交給 `qualified`（會處理 `schema.table`）；PG / MySQL 若帶 `x.y`
/// 就當作 schema / 庫已指定。
pub fn qualify_table(kind: DbKind, database: &str, table: &str) -> String {
    let t = table.trim();
    if matches!(kind, DbKind::Mssql) {
        return qualified(kind, database, t);
    }
    match t.split_once('.') {
        Some((s, n)) => format!("{}.{}", quote_ident(kind, s), quote_ident(kind, n)),
        None => qualified(kind, database, t),
    }
}

// ---------------------------------------------------------------------------
// 語句與角色
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    /// 執行即可，結果不看。
    Setup,
    /// 第一列的欄 → 符號（欄名, 符號名）。
    Capture(Vec<(String, String)>),
    /// 程序本身的結果集。
    Call,
    /// 一列，欄 = OUT 參數名。
    OutFetch,
}

#[derive(Debug, Clone)]
pub struct Stmt {
    pub sql: String,
    pub role: Role,
}

/// `insert` step 的語句。回傳值有 `">>sym"` 的欄不寫入、改由引擎回填（identity / default）。
pub fn insert_stmts(kind: DbKind, database: &str, table: &str, row: &Row, syms: &Symbols, identity_insert: bool) -> Result<Vec<Stmt>, String> {
    let q = qualify_table(kind, database, table);
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    let mut captures: Vec<(String, String)> = Vec::new();
    for (c, v) in row {
        if let Some(sym) = capture_name(v) {
            captures.push((c.clone(), sym.to_string()));
            continue;
        }
        cols.push(quote_ident(kind, c));
        vals.push(literal(kind, &resolve_value(v, syms)?)?);
    }
    let col_list = cols.join(", ");
    let val_list = vals.join(", ");
    let mut stmts = Vec::new();
    match kind {
        DbKind::Mssql => {
            let output = if captures.is_empty() {
                String::new()
            } else {
                format!(
                    " OUTPUT {}",
                    captures.iter().map(|(c, _)| format!("inserted.{} AS {}", quote_ident(kind, c), quote_ident(kind, c))).collect::<Vec<_>>().join(", ")
                )
            };
            let core = if cols.is_empty() {
                format!("INSERT INTO {q}{output} DEFAULT VALUES")
            } else {
                format!("INSERT INTO {q} ({col_list}){output} VALUES ({val_list})")
            };
            let sql = if identity_insert {
                format!("SET IDENTITY_INSERT {q} ON; {core}; SET IDENTITY_INSERT {q} OFF;")
            } else {
                core
            };
            stmts.push(Stmt { sql, role: if captures.is_empty() { Role::Setup } else { Role::Capture(captures) } });
        }
        DbKind::Postgres => {
            let returning = if captures.is_empty() {
                String::new()
            } else {
                format!(" RETURNING {}", captures.iter().map(|(c, _)| quote_ident(kind, c)).collect::<Vec<_>>().join(", "))
            };
            let overriding = if identity_insert { " OVERRIDING SYSTEM VALUE" } else { "" };
            let sql = if cols.is_empty() {
                format!("INSERT INTO {q} DEFAULT VALUES{returning}")
            } else {
                format!("INSERT INTO {q} ({col_list}){overriding} VALUES ({val_list}){returning}")
            };
            stmts.push(Stmt { sql, role: if captures.is_empty() { Role::Setup } else { Role::Capture(captures) } });
        }
        _ => {
            let sql = if cols.is_empty() { format!("INSERT INTO {q} () VALUES ()") } else { format!("INSERT INTO {q} ({col_list}) VALUES ({val_list})") };
            stmts.push(Stmt { sql, role: Role::Setup });
            if !captures.is_empty() {
                if captures.len() > 1 {
                    return Err(t!("MySQL 的 insert 只能擷取一個自動產生欄（LAST_INSERT_ID）").into());
                }
                let (c, _) = &captures[0];
                stmts.push(Stmt { sql: format!("SELECT LAST_INSERT_ID() AS {}", quote_ident(kind, c)), role: Role::Capture(captures) });
            }
        }
    }
    Ok(stmts)
}

/// `call` step 的語句計畫。
#[derive(Debug, Clone)]
pub struct CallPlan {
    pub stmts: Vec<Stmt>,
    /// OUT 欄名（OutFetch 列的欄）→ 符號名。
    pub out_captures: Vec<(String, String)>,
    /// OutFetch 列的欄名順序（= 參數名，不含 `@`）。
    pub out_names: Vec<String>,
}

/// 把測試檔的 params 對到簽名：回每個簽名參數的（資訊, 給定值, 擷取符號）。
fn bind_params<'a>(sig: &'a RoutineSig, params: &Row, syms: &Symbols) -> Result<Vec<(&'a super::inspect::ParamInfo, Option<Value>, Option<String>)>, String> {
    let mut given: Vec<(String, &Value)> = params.iter().map(|(k, v)| (k.clone(), v)).collect();
    let mut out = Vec::new();
    for p in &sig.params {
        let want = super::inspect::norm_param(&p.name);
        let pos = given.iter().position(|(k, _)| super::inspect::norm_param(k) == want);
        match pos {
            Some(i) => {
                let (_, v) = given.remove(i);
                if let Some(sym) = capture_name(v) {
                    if !p.mode.is_output() {
                        return Err(tf!("參數 {name} 不是 OUT 參數，不能擷取", name = p.name));
                    }
                    out.push((p, None, Some(sym.to_string())));
                } else {
                    out.push((p, Some(resolve_value(v, syms)?), None));
                }
            }
            None => out.push((p, None, None)),
        }
    }
    if let Some((k, _)) = given.first() {
        return Err(tf!("簽名裡沒有參數 {name}", name = k));
    }
    Ok(out)
}

pub fn call_plan(kind: DbKind, database: &str, sig: &RoutineSig, params: &Row, syms: &Symbols) -> Result<CallPlan, String> {
    let bound = bind_params(sig, params, syms)?;
    let qname = match kind {
        DbKind::Mssql => format!("{}.{}.{}", quote_ident(kind, database), quote_ident(kind, &sig.schema), quote_ident(kind, &sig.name)),
        _ => format!("{}.{}", quote_ident(kind, &sig.schema), quote_ident(kind, &sig.name)),
    };
    let mut stmts = Vec::new();
    let mut out_captures = Vec::new();
    let mut out_names = Vec::new();
    match kind {
        DbKind::Mssql => {
            if sig.kind == RoutineKind::Function {
                let args = bound.iter().map(|(_, v, _)| v.as_ref().map(|v| literal(kind, v)).unwrap_or(Ok("DEFAULT".into()))).collect::<Result<Vec<_>, _>>()?;
                let sql = if sig.returns_set {
                    format!("SELECT * FROM {qname}({})", args.join(", "))
                } else {
                    format!("SELECT {qname}({}) AS result", args.join(", "))
                };
                stmts.push(Stmt { sql, role: Role::Call });
                return Ok(CallPlan { stmts, out_captures, out_names });
            }
            let mut decl = vec!["@__rc INT".to_string()];
            let mut inits = Vec::new();
            let mut assigns = Vec::new();
            let mut tail = Vec::new();
            for (i, (p, v, cap)) in bound.iter().enumerate() {
                let pname = p.name.trim_start_matches('@');
                if p.mode.is_output() {
                    let var = format!("@__o{i}");
                    decl.push(format!("{var} {}", p.data_type));
                    if let Some(v) = v {
                        inits.push(format!("SET {var} = {};", literal(kind, v)?));
                    }
                    assigns.push(format!("@{pname} = {var} OUTPUT"));
                    tail.push(format!("{var} AS {}", quote_ident(kind, pname)));
                    out_names.push(pname.to_string());
                    if let Some(sym) = cap {
                        out_captures.push((pname.to_string(), sym.clone()));
                    }
                } else if let Some(v) = v {
                    assigns.push(format!("@{pname} = {}", literal(kind, v)?));
                }
            }
            let sql = format!(
                "DECLARE {}; {} SELECT N'__dbk_begin' AS __dbk_marker; EXEC @__rc = {qname} {}; SELECT N'__dbk_end' AS __dbk_marker, @__rc AS __rc{};",
                decl.join(", "),
                inits.join(" "),
                assigns.join(", "),
                tail.iter().map(|t| format!(", {t}")).collect::<String>()
            );
            stmts.push(Stmt { sql, role: Role::Call });
        }
        DbKind::Postgres => {
            let named = sig.params.iter().all(|p| !p.name.starts_with('$'));
            let mut args = Vec::new();
            for (p, v, _) in &bound {
                let lit = match (p.mode, v) {
                    (ParamMode::Out, _) => "NULL".to_string(),
                    (_, Some(v)) => literal(kind, v)?,
                    (ParamMode::InOut, None) => "NULL".to_string(),
                    (ParamMode::In, None) => {
                        if named {
                            continue; // 省略 → 用預設值
                        }
                        "NULL".to_string()
                    }
                };
                args.push(if named { format!("{} => {lit}", quote_ident(kind, &p.name)) } else { lit });
            }
            let arg_list = args.join(", ");
            match sig.kind {
                RoutineKind::Procedure => {
                    let has_out = bound.iter().any(|(p, _, _)| p.mode.is_output());
                    for (p, _, cap) in &bound {
                        if p.mode.is_output() {
                            out_names.push(p.name.clone());
                            if let Some(sym) = cap {
                                out_captures.push((p.name.clone(), sym.clone()));
                            }
                        }
                    }
                    stmts.push(Stmt { sql: format!("CALL {qname}({arg_list})"), role: if has_out { Role::OutFetch } else { Role::Call } });
                }
                RoutineKind::Function => {
                    let rt = sig.return_type.clone().unwrap_or_default().to_ascii_uppercase();
                    let set_like = sig.returns_set || rt.starts_with("TABLE") || rt.starts_with("SETOF") || rt == "RECORD";
                    let sql = if set_like {
                        format!("SELECT * FROM {qname}({arg_list})")
                    } else {
                        format!("SELECT {qname}({arg_list}) AS result")
                    };
                    stmts.push(Stmt { sql, role: Role::Call });
                }
            }
        }
        _ => {
            if sig.kind == RoutineKind::Function {
                let args = bound.iter().map(|(_, v, _)| v.as_ref().map(|v| literal(kind, v)).unwrap_or(Ok("NULL".into()))).collect::<Result<Vec<_>, _>>()?;
                stmts.push(Stmt { sql: format!("SELECT {qname}({}) AS result", args.join(", ")), role: Role::Call });
                return Ok(CallPlan { stmts, out_captures, out_names });
            }
            let mut args = Vec::new();
            let mut fetch = Vec::new();
            for (i, (p, v, cap)) in bound.iter().enumerate() {
                if p.mode.is_output() {
                    let var = format!("@__o{i}");
                    let init = match v {
                        Some(v) => literal(kind, v)?,
                        None => "NULL".into(),
                    };
                    stmts.push(Stmt { sql: format!("SET {var} = {init}"), role: Role::Setup });
                    args.push(var.clone());
                    fetch.push(format!("{var} AS {}", quote_ident(kind, &p.name)));
                    out_names.push(p.name.clone());
                    if let Some(sym) = cap {
                        out_captures.push((p.name.clone(), sym.clone()));
                    }
                } else {
                    args.push(match v {
                        Some(v) => literal(kind, v)?,
                        None => "NULL".into(),
                    });
                }
            }
            stmts.push(Stmt { sql: format!("CALL {qname}({})", args.join(", ")), role: Role::Call });
            if !fetch.is_empty() {
                stmts.push(Stmt { sql: format!("SELECT {}", fetch.join(", ")), role: Role::OutFetch });
            }
        }
    }
    Ok(CallPlan { stmts, out_captures, out_names })
}

/// 整表快照（依主鍵排序，讓基線檔案穩定）。
pub fn snapshot_select(kind: DbKind, meta: &TableMeta) -> String {
    let mut sql = whole_table_select_sql(kind, meta);
    if !meta.key.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(&meta.key.iter().map(|k| quote_ident(kind, k)).collect::<Vec<_>>().join(", "));
    }
    sql
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sptest::inspect::{ParamInfo, ParamMode, RoutineKind};
    use serde_json::json;

    fn syms() -> Symbols {
        let mut s = Symbols::new();
        s.set("pid", json!(5));
        s.set("name", json!("O'Brien"));
        s.set("last", json!([{"total": "25.00", "qty": 2}]));
        s
    }

    #[test]
    fn literals_per_dialect() {
        assert_eq!(literal(DbKind::Mssql, &json!(true)).unwrap(), "1");
        assert_eq!(literal(DbKind::Postgres, &json!(false)).unwrap(), "FALSE");
        assert_eq!(literal(DbKind::Mysql, &json!(12.5)).unwrap(), "12.5");
        assert_eq!(literal(DbKind::Mssql, &json!("a'b")).unwrap(), "N'a''b'");
        assert_eq!(literal(DbKind::Postgres, &json!({"type": "datetime", "value": "2024-01-02 03:04:05"})).unwrap(), "'2024-01-02 03:04:05'::timestamp");
        assert_eq!(literal(DbKind::Mssql, &json!({"type": "date", "value": "2024-01-02"})).unwrap(), "CAST(N'2024-01-02' AS DATE)");
        assert_eq!(literal(DbKind::Mysql, &json!({"type": "bytes", "value": "AQI="})).unwrap(), "X'0102'");
        assert_eq!(literal(DbKind::Postgres, &json!({"type": "bytes", "value": "AQI="})).unwrap(), "'\\x0102'::bytea");
        assert_eq!(literal(DbKind::Postgres, &json!({"type": "decimal", "value": "12.50"})).unwrap(), "'12.50'::numeric");
        assert!(literal(DbKind::Mysql, &json!([1])).is_err());
        assert!(literal(DbKind::Mysql, &json!({"type": "nope", "value": "x"})).is_err());
    }

    #[test]
    fn resolves_symbols() {
        let s = syms();
        assert_eq!(resolve_value(&json!("<<pid"), &s).unwrap(), json!(5));
        assert_eq!(resolve_value(&json!("<<last.total"), &s).unwrap(), json!("25.00"));
        assert_eq!(resolve_value(&json!({"not": "<<pid"}), &s).unwrap(), json!({"not": 5}));
        assert!(resolve_value(&json!("<<nope"), &s).is_err());
        assert!(resolve_value(&json!("<<pid.x"), &s).is_err());
        assert_eq!(cell_to_value(Some("101")), json!(101));
        assert_eq!(cell_to_value(Some("007")), json!("007"));
        assert_eq!(cell_to_value(Some("12.50")), json!("12.50"));
        assert_eq!(cell_to_value(None), Value::Null);
    }

    #[test]
    fn substitutes_only_known_symbols_outside_quotes() {
        let s = syms();
        let sql = "SELECT '@pid' AS lit, [x@pid] AS id, @pid AS v, @@TRANCOUNT AS tc, @unknown AS u -- @pid\nFROM t WHERE n = @name";
        let out = substitute_sql(DbKind::Mssql, sql, &s).unwrap();
        assert_eq!(out, "SELECT '@pid' AS lit, [x@pid] AS id, 5 AS v, @@TRANCOUNT AS tc, @unknown AS u -- @pid\nFROM t WHERE n = N'O''Brien'");
        let out = substitute_sql(DbKind::Mysql, "SELECT @pid, `a@pid`, \"s@pid\", /* @pid */ @pid", &s).unwrap();
        assert_eq!(out, "SELECT 5, `a@pid`, \"s@pid\", /* @pid */ 5");
    }

    #[test]
    fn insert_shapes() {
        let s = syms();
        let row: Row = serde_json::from_str(r#"{"product_id": ">>newpid", "name": "<<name", "stock": 10}"#).unwrap();
        let ms = insert_stmts(DbKind::Mssql, "sptest", "dbo.products", &row, &s, false).unwrap();
        assert_eq!(ms[0].sql, "INSERT INTO [sptest].[dbo].[products] ([name], [stock]) OUTPUT inserted.[product_id] AS [product_id] VALUES (N'O''Brien', 10)");
        assert_eq!(ms[0].role, Role::Capture(vec![("product_id".into(), "newpid".into())]));
        let pg = insert_stmts(DbKind::Postgres, "sptest", "products", &row, &s, false).unwrap();
        assert_eq!(pg[0].sql, "INSERT INTO \"sptest\".\"products\" (\"name\", \"stock\") VALUES ('O''Brien', 10) RETURNING \"product_id\"");
        let my = insert_stmts(DbKind::Mysql, "sptest", "products", &row, &s, false).unwrap();
        // MySQL 的 sql_literal 把單引號加倍（不是反斜線跳脫），反斜線本身才加倍。
        assert_eq!(my[0].sql, "INSERT INTO `sptest`.`products` (`name`, `stock`) VALUES ('O''Brien', 10)");
        assert_eq!(my[1].sql, "SELECT LAST_INSERT_ID() AS `product_id`");
    }

    fn sig(kind: RoutineKind, params: Vec<(&str, &str, ParamMode)>) -> RoutineSig {
        RoutineSig {
            schema: "dbo".into(),
            name: "usp_x".into(),
            kind,
            params: params.into_iter().enumerate().map(|(i, (n, t, m))| ParamInfo { name: n.into(), data_type: t.into(), mode: m, ordinal: i as i32 + 1 }).collect(),
            returns_set: false,
            return_type: None,
        }
    }

    #[test]
    fn call_shapes() {
        let s = syms();
        let params: Row = serde_json::from_str(r#"{"CustomerID": "<<pid", "Delta": "12.50", "NewBalance": ">>bal"}"#).unwrap();
        let ms = sig(RoutineKind::Procedure, vec![("@CustomerID", "int", ParamMode::In), ("@Delta", "decimal(12,2)", ParamMode::In), ("@NewBalance", "decimal(12,2)", ParamMode::InOut)]);
        let plan = call_plan(DbKind::Mssql, "sptest", &ms, &params, &s).unwrap();
        assert_eq!(
            plan.stmts[0].sql,
            "DECLARE @__rc INT, @__o2 decimal(12,2);  SELECT N'__dbk_begin' AS __dbk_marker; EXEC @__rc = [sptest].[dbo].[usp_x] @CustomerID = 5, @Delta = N'12.50', @NewBalance = @__o2 OUTPUT; SELECT N'__dbk_end' AS __dbk_marker, @__rc AS __rc, @__o2 AS [NewBalance];"
        );
        assert_eq!(plan.out_captures, vec![("NewBalance".to_string(), "bal".to_string())]);

        let mut pg = sig(RoutineKind::Procedure, vec![("p_customer_id", "integer", ParamMode::In), ("p_delta", "numeric", ParamMode::In), ("p_new_balance", "numeric", ParamMode::InOut)]);
        pg.schema = "sptest".into();
        let plan = call_plan(DbKind::Postgres, "sptest", &pg, &params, &s).unwrap();
        assert_eq!(plan.stmts[0].sql, "CALL \"sptest\".\"usp_x\"(\"p_customer_id\" => 5, \"p_delta\" => '12.50', \"p_new_balance\" => NULL)");
        assert_eq!(plan.stmts[0].role, Role::OutFetch);
        assert_eq!(plan.out_names, vec!["p_new_balance"]);

        let mut my = sig(RoutineKind::Procedure, vec![("p_customer_id", "int", ParamMode::In), ("p_delta", "decimal(12,2)", ParamMode::In), ("p_new_balance", "decimal(12,2)", ParamMode::Out)]);
        my.schema = "sptest".into();
        let plan = call_plan(DbKind::Mysql, "sptest", &my, &params, &s).unwrap();
        assert_eq!(plan.stmts[0].sql, "SET @__o2 = NULL");
        assert_eq!(plan.stmts[1].sql, "CALL `sptest`.`usp_x`(5, '12.50', @__o2)");
        assert_eq!(plan.stmts[2].sql, "SELECT @__o2 AS `p_new_balance`");
        assert_eq!(plan.stmts[2].role, Role::OutFetch);

        let bad: Row = serde_json::from_str(r#"{"Nope": 1}"#).unwrap();
        assert!(call_plan(DbKind::Mysql, "sptest", &my, &bad, &s).is_err());
        let bad: Row = serde_json::from_str(r#"{"CustomerID": ">>x"}"#).unwrap();
        assert!(call_plan(DbKind::Mssql, "sptest", &ms, &bad, &s).is_err());
    }

    #[test]
    fn function_shapes() {
        let s = syms();
        let params: Row = serde_json::from_str(r#"{"p_customer_id": 1, "p_product_id": "<<pid", "p_qty": 2}"#).unwrap();
        let mut f = sig(RoutineKind::Function, vec![("p_customer_id", "integer", ParamMode::In), ("p_product_id", "integer", ParamMode::In), ("p_qty", "integer", ParamMode::In)]);
        f.schema = "sptest".into();
        f.returns_set = true;
        let plan = call_plan(DbKind::Postgres, "sptest", &f, &params, &s).unwrap();
        assert_eq!(plan.stmts[0].sql, "SELECT * FROM \"sptest\".\"usp_x\"(\"p_customer_id\" => 1, \"p_product_id\" => 5, \"p_qty\" => 2)");
        assert_eq!(plan.stmts[0].role, Role::Call);
    }

    #[test]
    fn frames() {
        let d = Defaults::default();
        assert_eq!(open_stmts(DbKind::Mssql, "sptest", &d)[0], "USE [sptest]");
        assert!(open_stmts(DbKind::Postgres, "sptest", &d)[0].contains("search_path TO \"sptest\""));
        assert!(open_stmts(DbKind::Mysql, "sptest", &d).iter().any(|s| s == "START TRANSACTION"));
        assert_eq!(close_stmt(DbKind::Postgres), "ROLLBACK");
        assert_eq!(rollback_to_stmt(DbKind::Mysql, "s1"), "ROLLBACK TO SAVEPOINT s1");
        assert_eq!(qualify_table(DbKind::Postgres, "sptest", "other.t"), "\"other\".\"t\"");
        assert_eq!(qualify_table(DbKind::Mssql, "db", "sales.t"), "[db].[sales].[t]");
    }
}
