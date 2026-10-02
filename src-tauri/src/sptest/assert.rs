//! 斷言：期望值 vs 實際輸出，以及「兩份輸出」互比（基線 / 跨引擎差分）。
//!
//! 值的相等以 `compare::normalize` 為底（`1.0` = `1`、bit = boolean、日期字串各家寫法），
//! 再加本模組的容差（浮點相對誤差、datetime 毫秒容差、尾空白、零日期）與欄名匹配
//! （`CustomerID` ≈ `customer_id`）。列的配對沿用表格驅動 DB 測試的慣例：預設不比列序、
//! 以未標 `?` 的欄當 key、多出 / 缺少的列分開報。

use std::collections::BTreeMap;
use std::str::FromStr;

use bigdecimal::BigDecimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::errclass::classify;
use super::inspect::norm_param;
use super::model::{split_value_only, CountOrChanges, CountOrRows, Defaults, EffectExpect, ErrorExpect, Row};
use super::report::StepOutcome;
use super::session::{DbErr, ResultSet};
use super::snapshot::{norm_table_name, TableEffect};
use crate::compare::normalize::{norm_datetime, normalize_cell, CompareMode};
use crate::db::DbKind;

#[derive(Debug, Clone)]
pub struct CmpOpts {
    pub ordered: bool,
    pub ignore_trailing_spaces: bool,
    pub case_insensitive_text: bool,
    pub null_equals_empty: bool,
    pub zero_date_as_null: bool,
    pub float_rel_tol: f64,
    pub float_abs_tol: f64,
    pub datetime_tol_ms: i64,
    pub mask_columns: Vec<String>,
}

impl CmpOpts {
    pub fn from_defaults(d: &Defaults) -> CmpOpts {
        CmpOpts {
            ordered: d.ordered,
            ignore_trailing_spaces: d.ignore_trailing_spaces,
            case_insensitive_text: d.case_insensitive_text,
            null_equals_empty: d.null_equals_empty,
            zero_date_as_null: d.zero_date_as_null,
            float_rel_tol: d.float_rel_tol,
            float_abs_tol: d.float_abs_tol,
            datetime_tol_ms: d.datetime_tol_ms,
            mask_columns: d.mask_columns.clone(),
        }
    }

    /// `mask_columns` 是否遮住這欄（`Col` 或 `Table.Col`，大小寫不分）。
    pub fn is_masked(&self, table: Option<&str>, col: &str) -> bool {
        self.mask_columns.iter().any(|m| match m.rsplit_once('.') {
            Some((t, c)) => table.map(|tb| norm_col(tb) == norm_col(t)).unwrap_or(false) && norm_col(c) == norm_col(col),
            None => norm_col(m) == norm_col(col),
        })
    }
}

impl Default for CmpOpts {
    fn default() -> Self {
        CmpOpts::from_defaults(&Defaults::default())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Difference {
    pub kind: String,
    #[serde(rename = "where")]
    pub location: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Difference {
    pub fn new(kind: &str, location: impl Into<String>, expected: Option<String>, actual: Option<String>) -> Difference {
        Difference { kind: kind.into(), location: location.into(), expected, actual, note: None }
    }

    pub fn with_note(mut self, note: impl Into<String>) -> Difference {
        self.note = Some(note.into());
        self
    }

    pub fn summary(&self) -> String {
        match (&self.expected, &self.actual) {
            (Some(e), Some(a)) => format!("{}: expected {e}, got {a}", self.location),
            (Some(e), None) => format!("{}: expected {e}", self.location),
            (None, Some(a)) => format!("{}: got {a}", self.location),
            (None, None) => self.note.clone().map(|n| format!("{}: {n}", self.location)).unwrap_or_else(|| self.location.clone()),
        }
    }
}

// ---------------------------------------------------------------------------
// 欄名 / 值
// ---------------------------------------------------------------------------

fn norm_col(s: &str) -> String {
    s.trim().trim_start_matches('@').chars().filter(|c| *c != '_').flat_map(|c| c.to_lowercase()).collect()
}

/// 精確 → 大小寫不分 → 去底線不分。
pub fn find_col(columns: &[String], name: &str) -> Option<usize> {
    columns
        .iter()
        .position(|c| c == name)
        .or_else(|| columns.iter().position(|c| c.eq_ignore_ascii_case(name)))
        .or_else(|| {
            let want = norm_col(name);
            columns.iter().position(|c| norm_col(c) == want)
        })
}

fn is_zero_date(s: &str) -> bool {
    s.starts_with("0000-00-00")
}

fn parse_dt_ms(s: &str) -> Option<i64> {
    let n = norm_datetime(s)?;
    let dt = chrono::NaiveDateTime::parse_from_str(&n, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(&n, "%Y-%m-%d %H:%M:%S"))
        .ok()?;
    Some(dt.and_utc().timestamp_millis())
}

fn text_eq(a: &str, b: &str, o: &CmpOpts) -> bool {
    let (a, b) = if o.ignore_trailing_spaces { (a.trim_end(), b.trim_end()) } else { (a, b) };
    if o.case_insensitive_text { a.eq_ignore_ascii_case(b) } else { a == b }
}

fn looks_json(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with('{') || t.starts_with('[')
}

/// 兩個儲存格字串是否相等（型別由值推斷：數字 → 布林 → 日期時間 → JSON → 文字）。
pub fn cells_equal_ext(a: Option<&str>, b: Option<&str>, o: &CmpOpts) -> bool {
    let a = a.filter(|s| !(o.zero_date_as_null && is_zero_date(s)));
    let b = b.filter(|s| !(o.zero_date_as_null && is_zero_date(s)));
    let a = if o.null_equals_empty && a == Some("") { None } else { a };
    let b = if o.null_equals_empty && b == Some("") { None } else { b };
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => {
            if x == y {
                return true;
            }
            if let (Ok(da), Ok(db)) = (BigDecimal::from_str(x.trim()), BigDecimal::from_str(y.trim())) {
                if da == db {
                    return true;
                }
                if let (Ok(fa), Ok(fb)) = (x.trim().parse::<f64>(), y.trim().parse::<f64>()) {
                    let diff = (fa - fb).abs();
                    let scale = fa.abs().max(fb.abs());
                    return diff <= o.float_abs_tol || diff <= scale * o.float_rel_tol;
                }
                return false;
            }
            let (na, nb) = (normalize_cell(CompareMode::Bool, x, false), normalize_cell(CompareMode::Bool, y, false));
            let is_b = |s: &str| s == "true" || s == "false";
            if is_b(&na) && is_b(&nb) {
                return na == nb;
            }
            if let (Some(ta), Some(tb)) = (parse_dt_ms(x), parse_dt_ms(y)) {
                return (ta - tb).abs() <= o.datetime_tol_ms;
            }
            if looks_json(x) && looks_json(y) {
                return normalize_cell(CompareMode::Json, x, false) == normalize_cell(CompareMode::Json, y, false);
            }
            text_eq(x, y, o)
        }
        _ => false,
    }
}

/// 期望值（JSON）vs 實際儲存格。
pub fn value_matches(exp: &Value, act: Option<&str>, o: &CmpOpts) -> bool {
    match exp {
        Value::Null => act.is_none() || (o.null_equals_empty && act == Some("")) || act.map(|a| o.zero_date_as_null && is_zero_date(a)).unwrap_or(false),
        Value::Bool(b) => act.map(|a| normalize_cell(CompareMode::Bool, a, false) == if *b { "true" } else { "false" }).unwrap_or(false),
        Value::Number(n) => cells_equal_ext(Some(&n.to_string()), act, o),
        Value::String(s) => cells_equal_ext(Some(s), act, o),
        Value::Object(m) => {
            if let Some(inner) = m.get("not") {
                return !value_matches(inner, act, o);
            }
            if m.contains_key("type") {
                let vs = match m.get("value") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Null) | None => return act.is_none(),
                    Some(v) => v.to_string(),
                };
                return cells_equal_ext(Some(&vs), act, o);
            }
            act.map(|a| normalize_cell(CompareMode::Json, a, false) == normalize_cell(CompareMode::Json, &exp.to_string(), false)).unwrap_or(false)
        }
        Value::Array(_) => act.map(|a| normalize_cell(CompareMode::Json, a, false) == normalize_cell(CompareMode::Json, &exp.to_string(), false)).unwrap_or(false),
    }
}

pub fn expected_display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "NULL".into(),
        other => other.to_string(),
    }
}

pub fn actual_display(a: Option<&str>) -> String {
    a.map(|s| s.to_string()).unwrap_or_else(|| "NULL".into())
}

fn row_display(columns: &[String], row: &[Option<String>]) -> String {
    let parts: Vec<String> = columns.iter().zip(row).map(|(c, v)| format!("{c}={}", actual_display(v.as_deref()))).collect();
    format!("{{{}}}", parts.join(", "))
}

fn exp_row_display(row: &Row) -> String {
    let parts: Vec<String> = row.iter().map(|(c, v)| format!("{c}={}", expected_display(v))).collect();
    format!("{{{}}}", parts.join(", "))
}

// ---------------------------------------------------------------------------
// 列集合
// ---------------------------------------------------------------------------

/// 期望列 vs 結果集。`key` 空 → 以未標 `?` 的欄當 key。`masked`：只比 NULL 與否的欄。
pub fn check_rows(loc: &str, expected: &[Row], set: &ResultSet, ordered: bool, key: &[String], masked: &[String], o: &CmpOpts) -> Vec<Difference> {
    let mut diffs = Vec::new();
    // 期望用到的欄 → 結果集欄位索引
    let mut cols: Vec<(String, bool, Option<usize>)> = Vec::new(); // (名, value_only, idx)
    for row in expected {
        for (c, _) in row {
            let (name, value_only) = split_value_only(c);
            if cols.iter().any(|(n, _, _)| n.eq_ignore_ascii_case(name)) {
                continue;
            }
            let idx = find_col(&set.columns, name);
            if idx.is_none() && (!set.rows.is_empty() || !set.columns.is_empty()) {
                diffs.push(Difference::new("missing_column", format!("{loc} / {name}"), Some(name.into()), None).with_note(tf!("結果集沒有這個欄（有：{cols}）", cols = set.columns.join(", "))));
            }
            cols.push((name.to_string(), value_only, idx));
        }
    }
    let is_masked = |name: &str| masked.iter().any(|m| norm_col(m) == norm_col(name)) || o.is_masked(None, name);
    let is_key = |name: &str, value_only: bool| {
        if !key.is_empty() {
            key.iter().any(|k| norm_col(k) == norm_col(name))
        } else {
            !value_only && !is_masked(name)
        }
    };
    let cell_ok = |exp: &Value, idx: Option<usize>, act_row: &[Option<String>], name: &str| -> bool {
        let act = idx.and_then(|i| act_row.get(i)).and_then(|v| v.as_deref());
        if is_masked(name) {
            return exp.is_null() == act.is_none() || (!exp.is_null() && act.is_some());
        }
        value_matches(exp, act, o)
    };
    let col_of = |c: &str| -> (String, bool, Option<usize>) {
        let (name, vo) = split_value_only(c);
        cols.iter().find(|(n, _, _)| n.eq_ignore_ascii_case(name)).cloned().unwrap_or((name.to_string(), vo, None))
    };

    if ordered {
        let n = expected.len().max(set.rows.len());
        for i in 0..n {
            match (expected.get(i), set.rows.get(i)) {
                (Some(exp), Some(act)) => {
                    for (c, v) in exp {
                        let (name, _, idx) = col_of(c);
                        if idx.is_none() {
                            continue;
                        }
                        if !cell_ok(v, idx, act, &name) {
                            let a = idx.and_then(|i| act.get(i)).and_then(|v| v.as_deref());
                            diffs.push(Difference::new("cell", format!("{loc} / row {i} / {name}"), Some(expected_display(v)), Some(actual_display(a))));
                        }
                    }
                }
                (Some(exp), None) => diffs.push(Difference::new("missing_row", format!("{loc} / row {i}"), Some(exp_row_display(exp)), None)),
                (None, Some(act)) => diffs.push(Difference::new("surplus_row", format!("{loc} / row {i}"), None, Some(row_display(&set.columns, act)))),
                (None, None) => {}
            }
        }
        return diffs;
    }

    let mut used = vec![false; set.rows.len()];
    for (ei, exp) in expected.iter().enumerate() {
        let key_cols: Vec<(String, Option<usize>, &Value)> = exp
            .iter()
            .map(|(c, v)| {
                let (name, vo, idx) = col_of(c);
                (name, vo, idx, v)
            })
            .filter(|(name, vo, _, _)| is_key(name, *vo))
            .map(|(name, _, idx, v)| (name, idx, v))
            .collect();
        let found = set.rows.iter().enumerate().find(|(ai, act)| !used[*ai] && key_cols.iter().all(|(name, idx, v)| idx.is_some() && cell_ok(v, *idx, act, name)));
        match found {
            Some((ai, act)) => {
                used[ai] = true;
                for (c, v) in exp {
                    let (name, _, idx) = col_of(c);
                    if idx.is_none() {
                        continue;
                    }
                    if !cell_ok(v, idx, act, &name) {
                        let a = idx.and_then(|i| act.get(i)).and_then(|v| v.as_deref());
                        diffs.push(Difference::new("cell", format!("{loc} / row {ei} / {name}"), Some(expected_display(v)), Some(actual_display(a))));
                    }
                }
            }
            None => diffs.push(Difference::new("missing_row", format!("{loc} / row {ei}"), Some(exp_row_display(exp)), None)),
        }
    }
    for (ai, act) in set.rows.iter().enumerate() {
        if !used[ai] {
            diffs.push(Difference::new("surplus_row", format!("{loc} / row {ai}"), None, Some(row_display(&set.columns, act))));
        }
    }
    // 一列都配不上但列數相同：多半是某個 key 欄的值寫錯，逐位置比會報成 cell（指出哪一欄），
    // 比「缺一列 + 多一列」好讀得多。
    if !diffs.is_empty()
        && expected.len() == set.rows.len()
        && diffs.iter().all(|d| d.kind == "missing_row" || d.kind == "surplus_row")
        && diffs.iter().filter(|d| d.kind == "missing_row").count() == expected.len()
    {
        return check_rows(loc, expected, set, true, key, masked, o);
    }
    diffs
}

pub fn check_count(loc: &str, count: usize, set: &ResultSet) -> Vec<Difference> {
    if set.rows.len() == count && !set.truncated {
        vec![]
    } else {
        vec![Difference::new("count", loc, Some(count.to_string()), Some(if set.truncated { format!("≥{}", set.rows.len()) } else { set.rows.len().to_string() }))]
    }
}

pub fn check_scalar(kind: &str, loc: &str, exp: &Value, act: Option<&str>, o: &CmpOpts) -> Vec<Difference> {
    if value_matches(exp, act, o) {
        vec![]
    } else {
        vec![Difference::new(kind, loc, Some(expected_display(exp)), Some(actual_display(act)))]
    }
}

/// OUT 參數（鍵以 `norm_param` 對應）。
pub fn check_out(expected: &Row, out: &BTreeMap<String, Option<String>>, o: &CmpOpts) -> Vec<Difference> {
    let mut diffs = Vec::new();
    for (name, exp) in expected {
        let want = norm_param(name);
        match out.iter().find(|(k, _)| norm_param(k) == want) {
            Some((_, act)) => diffs.extend(check_scalar("out", &format!("out / {name}"), exp, act.as_deref(), o)),
            None => diffs.push(Difference::new("out", format!("out / {name}"), Some(expected_display(exp)), None).with_note(t!("沒有這個 OUT 參數"))),
        }
    }
    diffs
}

fn effect_set(columns: &[String], rows: &[Vec<Option<String>>]) -> ResultSet {
    ResultSet { columns: columns.to_vec(), rows: rows.to_vec(), truncated: false }
}

/// 副作用期望。`strict`：有變化但沒列在期望裡的表 → 差異。
pub fn check_effects(expected: &BTreeMap<String, EffectExpect>, strict: bool, effects: &[TableEffect], kind: DbKind, database: &str, o: &CmpOpts) -> Vec<Difference> {
    let mut diffs = Vec::new();
    let mut named: Vec<String> = Vec::new();
    for (table, exp) in expected {
        let key = norm_table_name(kind, database, table);
        named.push(key.clone());
        let Some(e) = effects.iter().find(|e| e.table == key) else {
            diffs.push(Difference::new("effect", format!("effects / {table}"), Some("snapshot".into()), None).with_note(t!("這張表不在快照清單裡（snapshot 設定或盤點沒抓到）")));
            continue;
        };
        let loc = |what: &str| format!("effects / {table} / {what}");
        match &exp.inserted {
            Some(CountOrRows::Count(n)) if e.inserted.len() != *n => {
                diffs.push(Difference::new("effect", loc("inserted"), Some(n.to_string()), Some(e.inserted.len().to_string())))
            }
            Some(CountOrRows::Rows(rows)) => diffs.extend(check_rows(&loc("inserted"), rows, &effect_set(&e.columns, &e.inserted), false, &[], &e.masked_cols, o)),
            _ => {}
        }
        match &exp.deleted {
            Some(CountOrRows::Count(n)) if e.deleted.len() != *n => {
                diffs.push(Difference::new("effect", loc("deleted"), Some(n.to_string()), Some(e.deleted.len().to_string())))
            }
            Some(CountOrRows::Rows(rows)) => diffs.extend(check_rows(&loc("deleted"), rows, &effect_set(&e.columns, &e.deleted), false, &[], &e.masked_cols, o)),
            _ => {}
        }
        match &exp.updated {
            Some(CountOrChanges::Count(n)) if e.updated.len() != *n => {
                diffs.push(Difference::new("effect", loc("updated"), Some(n.to_string()), Some(e.updated.len().to_string())))
            }
            Some(CountOrChanges::Changes(changes)) => {
                let afters: Vec<Vec<Option<String>>> = e.updated.iter().map(|(_, a)| a.clone()).collect();
                let after_rows: Vec<Row> = changes.iter().map(|c| c.after.clone()).collect();
                diffs.extend(check_rows(&loc("updated"), &after_rows, &effect_set(&e.columns, &afters), false, &[], &e.masked_cols, o));
                // before：以 after 的 key 找到那一對，再比 before
                for (ci, c) in changes.iter().enumerate() {
                    let Some(before_exp) = &c.before else { continue };
                    let key_cols: Vec<(String, &Value)> = c.after.iter().filter(|(k, _)| !split_value_only(k).1).map(|(k, v)| (split_value_only(k).0.to_string(), v)).collect();
                    let pair = e.updated.iter().find(|(_, a)| key_cols.iter().all(|(k, v)| find_col(&e.columns, k).map(|i| value_matches(v, a.get(i).and_then(|x| x.as_deref()), o)).unwrap_or(false)));
                    if let Some((before, _)) = pair {
                        diffs.extend(check_rows(&loc(&format!("updated[{ci}].before")), std::slice::from_ref(before_exp), &effect_set(&e.columns, std::slice::from_ref(before)), true, &[], &e.masked_cols, o));
                    }
                }
            }
            _ => {}
        }
    }
    if strict {
        for e in effects.iter().filter(|e| !e.is_empty() && !named.contains(&e.table)) {
            diffs.push(
                Difference::new("effect_strict", format!("effects / {}", e.table), Some("no change".into()), Some(format!("+{} ~{} -{}", e.inserted.len(), e.updated.len(), e.deleted.len())))
                    .with_note(t!("effects_strict：這張表有變化但期望沒列出")),
            );
        }
    }
    diffs
}

/// 預期錯誤 vs 實際錯誤。
pub fn check_error(exp: &ErrorExpect, err: Option<&DbErr>, kind: DbKind) -> Vec<Difference> {
    let Some(err) = err else {
        return vec![Difference::new("expectation", "error", Some(exp.class.map(|c| c.as_str().to_string()).or_else(|| exp.code.as_ref().map(expected_display)).unwrap_or_else(|| "error".into())), None).with_note(t!("預期出錯但沒有錯誤"))];
    };
    let mut diffs = Vec::new();
    let class = classify(kind, err.number, err.sqlstate.as_deref());
    if let Some(want) = exp.class {
        if want != class {
            diffs.push(Difference::new("error_class", "error", Some(want.as_str().into()), Some(class.as_str().into())).with_note(err.message.clone()));
        }
    }
    if let Some(code) = &exp.code {
        let ok = match code {
            Value::Number(n) => err.number.map(|x| x.to_string()) == Some(n.to_string()),
            Value::String(s) => err.sqlstate.as_deref() == Some(s.as_str()) || err.number.map(|x| x.to_string()).as_deref() == Some(s.as_str()),
            _ => false,
        };
        if !ok {
            let actual = match (&err.number, &err.sqlstate) {
                (Some(n), Some(s)) => format!("{n} / {s}"),
                (Some(n), None) => n.to_string(),
                (None, Some(s)) => s.clone(),
                (None, None) => "?".into(),
            };
            diffs.push(Difference::new("error_code", "error", Some(expected_display(code)), Some(actual)).with_note(err.message.clone()));
        }
    }
    if let Some(sub) = &exp.message_contains {
        if !err.message.to_ascii_lowercase().contains(&sub.to_ascii_lowercase()) {
            diffs.push(Difference::new("error_message", "error", Some(sub.clone()), Some(err.message.clone())));
        }
    }
    diffs
}

// ---------------------------------------------------------------------------
// 兩份輸出互比（基線 / 跨引擎）
// ---------------------------------------------------------------------------

pub fn set_to_rows(set: &ResultSet, skip: &[String]) -> Vec<Row> {
    set.rows
        .iter()
        .map(|r| {
            let mut row = Row::new();
            for (i, c) in set.columns.iter().enumerate() {
                if skip.iter().any(|m| norm_col(m) == norm_col(c)) {
                    continue;
                }
                row.insert(c.clone(), r.get(i).and_then(|v| v.as_deref()).map(|s| Value::String(s.to_string())).unwrap_or(Value::Null));
            }
            row
        })
        .collect()
}

/// 兩份列集合互比：先以 `key`（主鍵；空 = 所有未遮罩欄）配對；若只配不上但列數相同，改成排序後逐位置比，
/// 這樣「同一列某欄不同」會報成 cell 而不是一對 missing / surplus。
fn rows_diff(loc: &str, a: &ResultSet, b: &ResultSet, key: &[String], masked: &[String], o: &CmpOpts) -> Vec<Difference> {
    let rows = set_to_rows(a, masked);
    let d = check_rows(loc, &rows, b, o.ordered, key, masked, o);
    if d.is_empty() || o.ordered || a.rows.len() != b.rows.len() || !d.iter().all(|x| x.kind == "missing_row" || x.kind == "surplus_row") {
        return d;
    }
    // 部分列配得上、部分配不上：排序後逐位置比，讓剩下的差異也落到欄位。
    let sort = |s: &ResultSet| -> ResultSet {
        let mut c = s.clone();
        c.rows.sort();
        c
    };
    let (sa, sb) = (sort(a), sort(b));
    check_rows(loc, &set_to_rows(&sa, masked), &sb, true, &[], masked, o)
}

/// 這一欄的這個值可不可以換成符號：只換從引擎擷取的符號（有來源欄），且欄名對得上、或兩邊都是 *id 欄。
/// 否則 `cid = 1` 會把 `qty = 1` 也換掉，兩邊 identity 不同時就誤報。
fn symbol_for<'a>(col: &str, v: &str, syms: &'a BTreeMap<String, String>, cols: &BTreeMap<String, String>) -> Option<&'a String> {
    let is_id = |c: &str| {
        let n = norm_col(c);
        n == "id" || n.ends_with("id")
    };
    syms.iter().find(|(name, sv)| {
        if sv.as_str() != v {
            return false;
        }
        match cols.get(*name) {
            Some(src) => norm_col(src) == norm_col(col) || norm_param(src) == norm_param(col) || (is_id(src) && is_id(col)),
            None => false,
        }
    }).map(|(n, _)| n)
}

/// 等於某符號值的儲存格換成 `<符號名>`：兩邊各自以自己的符號表換，同名符號就相等。
fn symbolize(set: &ResultSet, syms: &BTreeMap<String, String>, cols: &BTreeMap<String, String>) -> ResultSet {
    if syms.is_empty() || cols.is_empty() {
        return set.clone();
    }
    let mut out = set.clone();
    for row in &mut out.rows {
        for (i, cell) in row.iter_mut().enumerate() {
            let Some(col) = out.columns.get(i) else { continue };
            if let Some(v) = cell.as_deref() {
                if let Some(name) = symbol_for(col, v, syms, cols) {
                    *cell = Some(format!("<{name}>"));
                }
            }
        }
    }
    out
}

fn symbolize_cell(col: &str, v: Option<&str>, syms: &BTreeMap<String, String>, cols: &BTreeMap<String, String>) -> Option<String> {
    v.map(|s| symbol_for(col, s, syms, cols).map(|n| format!("<{n}>")).unwrap_or_else(|| s.to_string()))
}

/// `a`（基線 / 來源）vs `b`（實際 / 目標）。`ErrorClass::Other` 不比訊息，只比類別。
pub fn outcome_diff(a: &StepOutcome, b: &StepOutcome, la: &str, lb: &str, o: &CmpOpts) -> Vec<Difference> {
    let mut diffs = Vec::new();
    match (&a.error, &b.error) {
        (None, None) => {}
        (Some(ea), Some(eb)) => {
            if ea.class != eb.class {
                diffs.push(Difference::new("error_class", "error", Some(format!("{la}: {}", ea.class.as_str())), Some(format!("{lb}: {}", eb.class.as_str()))).with_note(format!("{} | {}", ea.message, eb.message)));
            }
        }
        (Some(ea), None) => diffs.push(Difference::new("error_one_side", "error", Some(format!("{la}: {}", ea.class.as_str())), Some(format!("{lb}: ok"))).with_note(ea.message.clone())),
        (None, Some(eb)) => diffs.push(Difference::new("error_one_side", "error", Some(format!("{la}: ok")), Some(format!("{lb}: {}", eb.class.as_str()))).with_note(eb.message.clone())),
    }
    // 遮罩 = 使用者指定 + 兩邊記下的 identity / 時間預設值欄名；符號值換成符號名。
    let mut mask: Vec<String> = o.mask_columns.iter().chain(a.masked_cols.iter()).chain(b.masked_cols.iter()).cloned().collect();
    mask.sort();
    mask.dedup();
    if a.error.is_none() && b.error.is_none() {
        if a.result_sets.len() != b.result_sets.len() {
            diffs.push(Difference::new("result_set_count", "result_sets", Some(a.result_sets.len().to_string()), Some(b.result_sets.len().to_string())));
        }
        for (i, (sa, sb)) in a.result_sets.iter().zip(&b.result_sets).enumerate() {
            let (sa, sb) = (symbolize(sa, &a.symbols, &a.symbol_cols), symbolize(sb, &b.symbols, &b.symbol_cols));
            diffs.extend(rows_diff(&format!("set {i}"), &sa, &sb, &[], &mask, o).into_iter().map(|d| retag(d, la, lb)));
        }
        for (name, va) in &a.out {
            let want = norm_param(name);
            match b.out.iter().find(|(k, _)| norm_param(k) == want) {
                Some((kb, vb)) => {
                    let (xa, xb) = (symbolize_cell(name, va.as_deref(), &a.symbols, &a.symbol_cols), symbolize_cell(kb, vb.as_deref(), &b.symbols, &b.symbol_cols));
                    if !cells_equal_ext(xa.as_deref(), xb.as_deref(), o) {
                        diffs.push(Difference::new("out", format!("out / {name}"), Some(actual_display(va.as_deref())), Some(actual_display(vb.as_deref()))));
                    }
                }
                None => diffs.push(Difference::new("out", format!("out / {name}"), Some(actual_display(va.as_deref())), None).with_note(tf!("{side} 沒有這個 OUT 參數", side = lb))),
            }
        }
        if let (Some(ra), Some(rb)) = (&a.return_code, &b.return_code) {
            if !cells_equal_ext(Some(ra), Some(rb), o) {
                diffs.push(Difference::new("return_code", "return_code", Some(ra.clone()), Some(rb.clone())));
            }
        }
    }
    // 副作用：兩邊都錯時也比（來源留下部分列、目標整個回滾是真實差異）。
    for ea in &a.effects {
        let Some(eb) = b.effects.iter().find(|e| e.table == ea.table) else {
            if !ea.is_empty() {
                diffs.push(Difference::new("effect", format!("effects / {}", ea.table), Some(format!("+{} ~{} -{}", ea.inserted.len(), ea.updated.len(), ea.deleted.len())), None).with_note(tf!("{side} 沒有這張表的快照", side = lb)));
            }
            continue;
        };
        let loc = |w: &str| format!("effects / {} / {w}", ea.table);
        let mut masked: Vec<String> = ea.masked_cols.iter().chain(eb.masked_cols.iter()).chain(mask.iter()).cloned().collect();
        masked.sort();
        masked.dedup();
        // 主鍵當列 key（被遮罩的 identity 主鍵除外），同一列的欄位差異才會報成 cell。
        let key: Vec<String> = ea.key.iter().filter(|k| !masked.iter().any(|m| norm_col(m) == norm_col(k))).cloned().collect();
        let sym_a = |cols: &[String], rows: &[Vec<Option<String>>]| symbolize(&effect_set(cols, rows), &a.symbols, &a.symbol_cols);
        let sym_b = |cols: &[String], rows: &[Vec<Option<String>>]| symbolize(&effect_set(cols, rows), &b.symbols, &b.symbol_cols);
        if ea.inserted.len() != eb.inserted.len() {
            diffs.push(Difference::new("effect", loc("inserted"), Some(ea.inserted.len().to_string()), Some(eb.inserted.len().to_string())));
        } else if !ea.inserted.is_empty() {
            diffs.extend(rows_diff(&loc("inserted"), &sym_a(&ea.columns, &ea.inserted), &sym_b(&eb.columns, &eb.inserted), &key, &masked, o).into_iter().map(|d| retag(d, la, lb)));
        }
        if ea.deleted.len() != eb.deleted.len() {
            diffs.push(Difference::new("effect", loc("deleted"), Some(ea.deleted.len().to_string()), Some(eb.deleted.len().to_string())));
        } else if !ea.deleted.is_empty() {
            diffs.extend(rows_diff(&loc("deleted"), &sym_a(&ea.columns, &ea.deleted), &sym_b(&eb.columns, &eb.deleted), &key, &masked, o).into_iter().map(|d| retag(d, la, lb)));
        }
        if ea.updated.len() != eb.updated.len() {
            diffs.push(Difference::new("effect", loc("updated"), Some(ea.updated.len().to_string()), Some(eb.updated.len().to_string())));
        } else if !ea.updated.is_empty() {
            let afters_a: Vec<Vec<Option<String>>> = ea.updated.iter().map(|(_, x)| x.clone()).collect();
            let afters_b: Vec<Vec<Option<String>>> = eb.updated.iter().map(|(_, x)| x.clone()).collect();
            diffs.extend(rows_diff(&loc("updated"), &sym_a(&ea.columns, &afters_a), &sym_b(&eb.columns, &afters_b), &key, &masked, o).into_iter().map(|d| retag(d, la, lb)));
        }
    }
    diffs
}

fn retag(mut d: Difference, la: &str, lb: &str) -> Difference {
    if let Some(e) = d.expected.take() {
        d.expected = Some(format!("{la}: {e}"));
    }
    if let Some(a) = d.actual.take() {
        d.actual = Some(format!("{lb}: {a}"));
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn set(cols: &[&str], rows: &[&[Option<&str>]]) -> ResultSet {
        ResultSet {
            columns: cols.iter().map(|c| c.to_string()).collect(),
            rows: rows.iter().map(|r| r.iter().map(|c| c.map(|s| s.to_string())).collect()).collect(),
            truncated: false,
        }
    }

    fn rows(json: &str) -> Vec<Row> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn value_equivalences() {
        let o = CmpOpts::default();
        assert!(value_matches(&json!(1), Some("1.0"), &o));
        assert!(value_matches(&json!("12.5"), Some("12.50"), &o));
        assert!(value_matches(&json!(true), Some("1"), &o));
        assert!(value_matches(&json!(false), Some("f"), &o));
        assert!(value_matches(&json!("2024-01-02 03:04:05"), Some("2024-01-02T03:04:05.003"), &o));
        assert!(!value_matches(&json!("2024-01-02 03:04:05"), Some("2024-01-02 03:04:06"), &o));
        assert!(value_matches(&json!("abc "), Some("abc"), &o));
        assert!(value_matches(&json!(null), None, &o));
        assert!(!value_matches(&json!(null), Some(""), &o));
        assert!(value_matches(&json!({"not": "X"}), Some("Y"), &o));
        assert!(!value_matches(&json!({"not": "X"}), Some("X"), &o));
        assert!(value_matches(&json!({"type": "decimal", "value": "25"}), Some("25.00"), &o));
        assert!(value_matches(&json!({"a": 1, "b": [1, 2]}), Some("{\"b\":[1,2],\"a\":1.0}"), &o));
        assert!(value_matches(&json!(null), Some("0000-00-00 00:00:00"), &o));
        assert!(value_matches(&json!(0.1), Some("0.10000000001"), &o));
        assert!(!value_matches(&json!(0.1), Some("0.11"), &o));
        let ci = CmpOpts { case_insensitive_text: true, ..CmpOpts::default() };
        assert!(value_matches(&json!("Ann"), Some("ANN"), &ci));
        assert!(!value_matches(&json!("Ann"), Some("ANN"), &o));
    }

    #[test]
    fn column_lookup() {
        let cols: Vec<String> = ["CustomerID".to_string(), "total".into()].to_vec();
        assert_eq!(find_col(&cols, "customer_id"), Some(0));
        assert_eq!(find_col(&cols, "TOTAL"), Some(1));
        assert_eq!(find_col(&cols, "nope"), None);
    }

    #[test]
    fn unordered_matching_reports_three_kinds() {
        let o = CmpOpts::default();
        let s = set(&["id", "name", "amount"], &[&[Some("1"), Some("a"), Some("9.99")], &[Some("2"), Some("b"), Some("1.00")], &[Some("3"), Some("c"), Some("2.00")]]);
        let exp = rows(r#"[{"id": 2, "name": "b"}, {"id": 1, "amount?": "10.00"}, {"id": 4, "name": "d"}]"#);
        let d = check_rows("set 0", &exp, &s, false, &[], &[], &o);
        let kinds: Vec<&str> = d.iter().map(|d| d.kind.as_str()).collect();
        assert_eq!(kinds, ["cell", "missing_row", "surplus_row"], "{d:?}");
        assert_eq!(d[0].location, "set 0 / row 1 / amount");
        assert!(d[2].actual.as_deref().unwrap().contains("id=3"));
    }

    #[test]
    fn ordered_matching() {
        let o = CmpOpts::default();
        let s = set(&["rank"], &[&[Some("1")], &[Some("2")]]);
        assert!(check_rows("s", &rows(r#"[{"rank": 1}, {"rank": 2}]"#), &s, true, &[], &[], &o).is_empty());
        let d = check_rows("s", &rows(r#"[{"rank": 2}, {"rank": 1}]"#), &s, true, &[], &[], &o);
        assert_eq!(d.len(), 2);
        assert!(check_rows("s", &rows(r#"[{"rank": 2}, {"rank": 1}]"#), &s, false, &[], &[], &o).is_empty());
    }

    #[test]
    fn missing_column_is_reported_once() {
        let o = CmpOpts::default();
        let s = set(&["id"], &[&[Some("1")]]);
        let d = check_rows("s", &rows(r#"[{"id": 1, "nope": 2}]"#), &s, false, &[], &[], &o);
        assert_eq!(d.iter().filter(|d| d.kind == "missing_column").count(), 1);
    }

    #[test]
    fn masked_columns_compare_nullness_only() {
        let o = CmpOpts::default();
        let s = set(&["order_id", "qty"], &[&[Some("101"), Some("2")]]);
        assert!(check_rows("s", &rows(r#"[{"order_id": 999, "qty": 2}]"#), &s, false, &[], &["order_id".into()], &o).is_empty());
        assert_eq!(check_rows("s", &rows(r#"[{"order_id": null, "qty": 2}]"#), &s, false, &[], &["order_id".into()], &o).len(), 1);
    }

    #[test]
    fn effects_counts_rows_and_strict() {
        let o = CmpOpts::default();
        let effects = vec![
            TableEffect {
                table: "orders".into(),
                columns: vec!["order_id".into(), "qty".into()],
                key: vec!["order_id".into()],
                inserted: vec![vec![Some("101".into()), Some("2".into())]],
                updated: vec![],
                deleted: vec![],
                incomplete: false,
                keyless: false,
                masked_cols: vec!["order_id".into()],
            },
            TableEffect {
                table: "products".into(),
                columns: vec!["product_id".into(), "stock".into()],
                key: vec!["product_id".into()],
                inserted: vec![],
                updated: vec![(vec![Some("5".into()), Some("10".into())], vec![Some("5".into()), Some("8".into())])],
                deleted: vec![],
                incomplete: false,
                keyless: false,
                masked_cols: vec![],
            },
        ];
        let exp: BTreeMap<String, EffectExpect> = serde_json::from_str(
            r#"{"dbo.orders": {"inserted": [{"qty": 2}]}, "products": {"updated": [{"before": {"stock": 10}, "after": {"product_id": 5, "stock": 8}}]}}"#,
        )
        .unwrap();
        assert!(check_effects(&exp, true, &effects, DbKind::Mssql, "sptest", &o).is_empty());
        let exp: BTreeMap<String, EffectExpect> = serde_json::from_str(r#"{"orders": {"inserted": 2}}"#).unwrap();
        let d = check_effects(&exp, true, &effects, DbKind::Mssql, "sptest", &o);
        assert_eq!(d.iter().map(|d| d.kind.as_str()).collect::<Vec<_>>(), ["effect", "effect_strict"]);
        let exp: BTreeMap<String, EffectExpect> = serde_json::from_str(r#"{"audit": {"inserted": 1}}"#).unwrap();
        let d = check_effects(&exp, false, &effects, DbKind::Mssql, "sptest", &o);
        assert_eq!(d[0].kind, "effect");
        assert!(d[0].note.as_deref().unwrap().contains("快照"));
    }

    #[test]
    fn error_expectations() {
        let exp: ErrorExpect = serde_json::from_str(r#"{"class": "user_raised", "code": 50001, "message_contains": "customer"}"#).unwrap();
        let err = DbErr { number: Some(50001), sqlstate: None, message: "Customer not found".into() };
        assert!(check_error(&exp, Some(&err), DbKind::Mssql).is_empty());
        let d = check_error(&exp, None, DbKind::Mssql);
        assert_eq!(d[0].kind, "expectation");
        let wrong = DbErr { number: Some(2627), sqlstate: None, message: "dup".into() };
        let d = check_error(&exp, Some(&wrong), DbKind::Mssql);
        assert_eq!(d.iter().map(|d| d.kind.as_str()).collect::<Vec<_>>(), ["error_class", "error_code", "error_message"]);
        let exp: ErrorExpect = serde_json::from_str(r#"{"code": "23505"}"#).unwrap();
        let pg = DbErr { number: None, sqlstate: Some("23505".into()), message: "dup".into() };
        assert!(check_error(&exp, Some(&pg), DbKind::Postgres).is_empty());
    }

    #[test]
    fn outcome_diff_cross_engine() {
        let o = CmpOpts::default();
        let a = StepOutcome {
            kind: "call".into(),
            result_sets: vec![set(&["order_id", "qty", "total"], &[&[Some("101"), Some("2"), Some("25.00")]])],
            out: BTreeMap::from([("NewBalance".to_string(), Some("12.5".to_string()))]),
            return_code: Some("0".into()),
            effects: vec![TableEffect { table: "products".into(), columns: vec!["product_id".into(), "stock".into()], key: vec!["product_id".into()], inserted: vec![], updated: vec![(vec![Some("5".into()), Some("10".into())], vec![Some("5".into()), Some("8".into())])], deleted: vec![], incomplete: false, keyless: false, masked_cols: vec![] }],
            ..Default::default()
        };
        let mut b = StepOutcome {
            kind: "call".into(),
            result_sets: vec![set(&["order_id", "qty", "total"], &[&[Some("1000"), Some("2"), Some("25.0")]])],
            out: BTreeMap::from([("p_new_balance".to_string(), Some("12.50".to_string()))]),
            return_code: None,
            effects: a.effects.clone(),
            ..Default::default()
        };
        // identity 不同：result set 的 order_id 要靠 mask_columns 遮
        let masked = CmpOpts { mask_columns: vec!["order_id".into()], ..o.clone() };
        assert!(outcome_diff(&a, &b, "mssql", "postgres", &masked).is_empty(), "{:?}", outcome_diff(&a, &b, "mssql", "postgres", &masked));
        b.effects[0].updated[0].1[1] = Some("10".into());
        let d = outcome_diff(&a, &b, "mssql", "postgres", &masked);
        assert_eq!(d[0].kind, "cell");
        assert!(d[0].location.starts_with("effects / products / updated"));
        b.error = Some(super::super::report::ErrInfo { code: Some("P0001".into()), class: super::super::errclass::ErrorClass::UserRaised, message: "x".into() });
        let d = outcome_diff(&a, &b, "mssql", "postgres", &masked);
        assert_eq!(d[0].kind, "error_one_side");
    }
}
