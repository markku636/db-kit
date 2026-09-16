//! 跨引擎值正規化：讓 `1.0`/`1.00`、`1`/`true`、`2024-01-01T00:00:00Z`/`2024-01-01 00:00:00`
//! 這類「同值不同字」在比對時相等。
//!
//! 所有值在 driver 邊界都已是 `Option<String>`（見 `cell_to_string`），這裡依欄位宣告型別推出
//! 一個 `CompareMode`，再把兩側字串收斂到典型形式後比較；解析失敗一律退回原字串比對，
//! 不會因為正規化而把不同的值判成相同。

use std::borrow::Cow;
use std::cmp::Ordering;
use std::hash::{Hash, Hasher};
use std::str::FromStr;

use bigdecimal::BigDecimal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareMode {
    Text,
    /// CHAR(n)：MySQL 讀出時去尾空白、PG / MSSQL / Oracle 補滿 → 一律 rtrim。
    CharPad,
    /// 整數 / DECIMAL / NUMBER：以 BigDecimal 正規化（去尾零）。
    Numeric,
    /// 單精度浮點：兩側先四捨五入到 f32 再比。
    Float32,
    Bool,
    DateTime,
    Json,
    /// BLOB / bytea 等：原字串比對（driver 以 0x… 呈現，跨引擎多半不可比）。
    Raw,
}

fn base_type(t: &str) -> String {
    t.trim().to_ascii_lowercase().split(['(', ' ']).next().unwrap_or("").to_string()
}

/// 這個宣告型別是否為布林（含 MySQL 的 tinyint(1) 慣例、MSSQL 的 bit）。
/// 產生 DML 時要看的是**目標欄位**是不是布林——`infer_mode` 只要任一側是布林就回 Bool，
/// 拿它當寫入依據會把 `'Y'/'N'` 這類非布林目標寫成 1/0。
pub fn is_bool_type(t: &str) -> bool {
    let full = t.trim().to_ascii_lowercase().replace(' ', "");
    matches!(base_type(t).as_str(), "bool" | "boolean" | "bit") || full.starts_with("tinyint(1)")
}

fn is_bool(t: &str) -> bool {
    is_bool_type(t)
}

fn is_numeric(t: &str) -> bool {
    matches!(
        base_type(t).as_str(),
        "int" | "integer" | "int2" | "int4" | "int8" | "smallint" | "tinyint" | "mediumint" | "bigint"
            | "serial" | "bigserial" | "smallserial" | "decimal" | "numeric" | "number" | "money" | "smallmoney"
            | "double" | "float8" | "binary_double" | "dec" | "fixed"
    )
}

fn is_float32(t: &str) -> bool {
    let b = base_type(t);
    // MySQL `float` 為 4 bytes；PG `real`/`float4`；MSSQL `real`；Oracle `binary_float`。
    // MSSQL / PG 的 `float` 為雙精度，這裡把 `float` 一律當單精度是保守選擇（誤差容忍較大）。
    matches!(b.as_str(), "float" | "float4" | "real" | "binary_float")
}

fn is_datetime(t: &str) -> bool {
    matches!(
        base_type(t).as_str(),
        "date" | "time" | "datetime" | "datetime2" | "smalldatetime" | "timestamp" | "timestamptz"
            | "datetimeoffset" | "timetz"
    )
}

fn is_charpad(t: &str) -> bool {
    // PostgreSQL 的 information_schema 把 varchar 叫 "character varying"，而 base_type 以空白切詞
    // 只會留下 "character" → 每個 PG varchar 都被當成定長 CHAR 而兩側 rtrim，
    // varchar 的尾空白差異就此靜默漏報（連主鍵的典型化也一起被 rtrim）。
    // base_type 的空白切詞是為 "timestamp without time zone" / "double precision" 而存在，不能動，
    // 所以在這裡擋掉這一種拼法。
    if t.trim().to_ascii_lowercase().starts_with("character varying") {
        return false;
    }
    matches!(base_type(t).as_str(), "char" | "nchar" | "character" | "bpchar")
}

/// 把值渲染成「目標引擎吃得下」的字面值。
///
/// 目前只處理布林：driver 讀 MySQL TINYINT(1)（sqlx 型別名為 BOOLEAN）、MSSQL bit 與 PG boolean
/// 都會給 "true"/"false"，但 MySQL 的 TINYINT(1) 不吃 `'true'`（1366 Incorrect integer value），
/// 連 MySQL → MySQL 的同步都會整批失敗；更糟的是 `WHERE flag = 'true'` 在 MySQL 會被靜默轉成 0
/// 而更新到錯的列。`1`/`0` 則五種引擎皆可。非布林目標或解析不出布林時一律原樣輸出，不自作主張。
pub fn render_for_target(dst_type: &str, v: Option<&str>) -> Option<String> {
    let s = v?;
    if !is_bool_type(dst_type) {
        return Some(s.to_string());
    }
    match norm_bool(s) {
        Some("true") => Some("1".into()),
        Some("false") => Some("0".into()),
        _ => Some(s.to_string()),
    }
}

fn is_json(t: &str) -> bool {
    base_type(t).contains("json")
}

fn is_raw(t: &str) -> bool {
    let b = base_type(t);
    matches!(
        b.as_str(),
        "blob" | "tinyblob" | "mediumblob" | "longblob" | "bytea" | "binary" | "varbinary" | "image" | "raw"
            | "long_raw" | "geometry" | "point" | "polygon" | "linestring"
    ) || b.contains("binary")
}

/// 由兩側欄位型別推出比對模式。優先序：Bool > Json > Raw > DateTime > Float32 > Numeric > CharPad > Text。
pub fn infer_mode(src_type: &str, dst_type: &str) -> CompareMode {
    let any = |f: fn(&str) -> bool| f(src_type) || f(dst_type);
    if any(is_bool) {
        return CompareMode::Bool;
    }
    if any(is_json) {
        return CompareMode::Json;
    }
    if any(is_raw) {
        return CompareMode::Raw;
    }
    if any(is_datetime) {
        return CompareMode::DateTime;
    }
    if any(is_float32) {
        return CompareMode::Float32;
    }
    if is_numeric(src_type) && is_numeric(dst_type) {
        return CompareMode::Numeric;
    }
    if any(is_charpad) {
        return CompareMode::CharPad;
    }
    CompareMode::Text
}

fn norm_bool(v: &str) -> Option<&'static str> {
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "t" | "true" | "y" | "yes" | "on" => Some("true"),
        "0" | "f" | "false" | "n" | "no" | "off" => Some("false"),
        _ => None,
    }
}

fn norm_numeric(v: &str) -> Option<String> {
    let d = BigDecimal::from_str(v.trim()).ok()?;
    Some(d.normalized().to_string())
}

fn norm_f32(v: &str) -> Option<String> {
    let f: f64 = v.trim().parse().ok()?;
    let f = f as f32;
    if f == 0.0 {
        return Some("0".into());
    }
    Some(format!("{f}"))
}

/// 各引擎常見的日期時間字串 → `YYYY-MM-DD HH:MM:SS[.fff]`（UTC；有時區資訊時先轉 UTC）。
fn norm_datetime(v: &str) -> Option<String> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime};
    let s = v.trim();
    let fmt_naive = |d: NaiveDateTime| {
        let base = d.format("%Y-%m-%d %H:%M:%S").to_string();
        let frac = d.format("%.f").to_string(); // ".123000" 或 ""
        let frac = frac.trim_end_matches('0');
        if frac.is_empty() || frac == "." { base } else { format!("{base}{frac}") }
    };
    // 帶時區。
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(fmt_naive(dt.naive_utc()));
    }
    for f in ["%Y-%m-%d %H:%M:%S%.f%:z", "%Y-%m-%d %H:%M:%S%.f %:z", "%Y-%m-%d %H:%M:%S%.f%z", "%Y-%m-%dT%H:%M:%S%.f%z"] {
        if let Ok(dt) = DateTime::parse_from_str(s, f) {
            return Some(fmt_naive(dt.naive_utc()));
        }
    }
    // 不帶時區。
    for f in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, f) {
            return Some(fmt_naive(d));
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(fmt_naive(d.and_hms_opt(0, 0, 0)?));
    }
    // 純時間。
    if let Ok(t) = NaiveTime::parse_from_str(s, "%H:%M:%S%.f") {
        let base = t.format("%H:%M:%S").to_string();
        let frac = t.format("%.f").to_string();
        let frac = frac.trim_end_matches('0');
        return Some(if frac.is_empty() || frac == "." { base } else { format!("{base}{frac}") });
    }
    None
}

/// JSON 鍵排序後重序列化（PG jsonb 會重排鍵）。
fn norm_json(v: &str) -> Option<String> {
    let val: serde_json::Value = serde_json::from_str(v).ok()?;
    let mut out = String::new();
    canon_json(&val, &mut out);
    Some(out)
}

fn canon_json(v: &serde_json::Value, out: &mut String) {
    use serde_json::Value;
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                canon_json(&m[*k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canon_json(x, out);
            }
            out.push(']');
        }
        Value::Number(n) => {
            // 1.0 與 1 視為同值。
            match n.as_f64().and_then(|f| BigDecimal::from_str(&f.to_string()).ok()) {
                Some(d) => out.push_str(&d.normalized().to_string()),
                None => out.push_str(&n.to_string()),
            }
        }
        other => out.push_str(&other.to_string()),
    }
}

/// 單一值正規化。解析失敗回原字串（借用，不配置）。
pub fn normalize_cell<'a>(mode: CompareMode, v: &'a str, trim_ws: bool) -> Cow<'a, str> {
    let owned = match mode {
        CompareMode::Bool => norm_bool(v).map(|s| s.to_string()),
        CompareMode::Numeric => norm_numeric(v),
        CompareMode::Float32 => norm_f32(v),
        CompareMode::DateTime => norm_datetime(v),
        CompareMode::Json => norm_json(v),
        CompareMode::CharPad => Some(v.trim_end_matches(' ').to_string()),
        CompareMode::Text => {
            if trim_ws {
                Some(v.trim_end().to_string())
            } else {
                None
            }
        }
        CompareMode::Raw => None,
    };
    match owned {
        Some(s) => Cow::Owned(s),
        None => Cow::Borrowed(v),
    }
}

/// 兩格是否相等。`null_eq_empty`：NULL 與空字串視為相同（Oracle 的 `''` 即 NULL）。
pub fn cells_equal(
    mode: CompareMode,
    a: Option<&str>,
    b: Option<&str>,
    null_eq_empty: bool,
    trim_ws: bool,
) -> bool {
    let a = if null_eq_empty && a == Some("") { None } else { a };
    let b = if null_eq_empty && b == Some("") { None } else { b };
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => {
            if x == y {
                return true;
            }
            normalize_cell(mode, x, trim_ws) == normalize_cell(mode, y, trim_ws)
        }
        _ => false,
    }
}

/// 主鍵的典型形式（各欄已正規化；None 保留為 NULL）。
pub type CanonKey = Vec<Option<String>>;

pub fn canon_key(row: &[Option<String>], idx: &[usize], modes: &[CompareMode], trim_ws: bool) -> CanonKey {
    idx.iter()
        .zip(modes)
        .map(|(i, m)| row.get(*i).cloned().flatten().map(|v| normalize_cell(*m, &v, trim_ws).into_owned()))
        .collect()
}

/// 主鍵比較：數值模式以 BigDecimal 比大小，其餘以位元組序；NULL 排最前。
pub fn cmp_key(a: &CanonKey, b: &CanonKey, modes: &[CompareMode]) -> Ordering {
    for (i, m) in modes.iter().enumerate() {
        let (x, y) = (a.get(i).and_then(|v| v.as_deref()), b.get(i).and_then(|v| v.as_deref()));
        let o = match (x, y) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            (Some(p), Some(q)) => {
                if *m == CompareMode::Numeric {
                    match (BigDecimal::from_str(p), BigDecimal::from_str(q)) {
                        (Ok(dp), Ok(dq)) => dp.cmp(&dq),
                        _ => p.cmp(q),
                    }
                } else {
                    p.cmp(q)
                }
            }
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

fn hash_with_seed(seed: u64, k: &CanonKey) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut h);
    for v in k {
        match v {
            Some(s) => {
                1u8.hash(&mut h);
                s.hash(&mut h);
            }
            None => 0u8.hash(&mut h),
        }
    }
    h.finish()
}

/// 128 位鍵雜湊（兩個不同 seed 的 64 位拼接；DefaultHasher 以固定 key 建立，跨執行決定性）。
pub fn key_hash128(k: &CanonKey) -> u128 {
    ((hash_with_seed(0x9E37_79B9_7F4A_7C15, k) as u128) << 64) | hash_with_seed(0xD1B5_4A32_D192_ED03, k) as u128
}

/// 整列（共同欄位）雜湊：每格先正規化，NULL / 空字串依 `null_eq_empty` 收斂。
pub fn row_hash(vals: &[Option<String>], modes: &[CompareMode], trim_ws: bool, null_eq_empty: bool) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for (v, m) in vals.iter().zip(modes) {
        let v = v.as_deref();
        let v = if null_eq_empty && v == Some("") { None } else { v };
        match v {
            Some(s) => {
                1u8.hash(&mut h);
                normalize_cell(*m, s, trim_ws).hash(&mut h);
            }
            None => 0u8.hash(&mut h),
        }
    }
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_mode_precedence() {
        assert_eq!(infer_mode("tinyint(1)", "boolean"), CompareMode::Bool);
        assert_eq!(infer_mode("bit", "int"), CompareMode::Bool);
        assert_eq!(infer_mode("json", "text"), CompareMode::Json);
        assert_eq!(infer_mode("jsonb", "varchar(100)"), CompareMode::Json);
        assert_eq!(infer_mode("bytea", "blob"), CompareMode::Raw);
        assert_eq!(infer_mode("datetime", "timestamp without time zone"), CompareMode::DateTime);
        assert_eq!(infer_mode("float", "real"), CompareMode::Float32);
        assert_eq!(infer_mode("decimal(10,2)", "numeric"), CompareMode::Numeric);
        assert_eq!(infer_mode("int(11)", "bigint"), CompareMode::Numeric);
        assert_eq!(infer_mode("char(10)", "varchar(10)"), CompareMode::CharPad);
        assert_eq!(infer_mode("varchar(10)", "text"), CompareMode::Text);
        // PG 的 varchar 拼作 "character varying"，不可被當成定長 CHAR（否則尾空白差異會靜默漏報）；
        // 真正的 PG CHAR 拼作 "character"，仍須是 CharPad。
        assert_eq!(infer_mode("varchar(20)", "character varying"), CompareMode::Text);
        assert_eq!(infer_mode("character varying(20)", "text"), CompareMode::Text);
        assert_eq!(infer_mode("char(10)", "character"), CompareMode::CharPad);
        assert_eq!(infer_mode("char(10)", "character varying"), CompareMode::CharPad);
        // 一側數值、一側文字 → 文字比對（不假設可轉）。
        assert_eq!(infer_mode("int", "varchar(10)"), CompareMode::Text);
    }

    #[test]
    fn numeric_and_bool_equivalence() {
        assert!(cells_equal(CompareMode::Numeric, Some("1.0"), Some("1.00"), false, false));
        assert!(cells_equal(CompareMode::Numeric, Some("1"), Some("1.000"), false, false));
        assert!(cells_equal(CompareMode::Numeric, Some("-0.50"), Some("-.5"), false, false));
        assert!(!cells_equal(CompareMode::Numeric, Some("1.01"), Some("1.1"), false, false));
        assert!(cells_equal(CompareMode::Bool, Some("1"), Some("true"), false, false));
        assert!(cells_equal(CompareMode::Bool, Some("f"), Some("0"), false, false));
        assert!(!cells_equal(CompareMode::Bool, Some("1"), Some("0"), false, false));
        assert!(cells_equal(CompareMode::Float32, Some("0.1"), Some("0.10000000149011612"), false, false));
    }

    #[test]
    fn datetime_variants_collapse() {
        let a = normalize_cell(CompareMode::DateTime, "2024-01-02 03:04:05", false);
        assert_eq!(a, "2024-01-02 03:04:05");
        assert_eq!(normalize_cell(CompareMode::DateTime, "2024-01-02T03:04:05", false), a);
        assert_eq!(normalize_cell(CompareMode::DateTime, "2024-01-02 03:04:05.000", false), a);
        assert_eq!(normalize_cell(CompareMode::DateTime, "2024-01-02T03:04:05Z", false), a);
        assert_eq!(normalize_cell(CompareMode::DateTime, "2024-01-02 05:04:05+02:00", false), a);
        assert_eq!(normalize_cell(CompareMode::DateTime, "2024-01-02 03:04:05.120", false), "2024-01-02 03:04:05.12");
        assert_eq!(normalize_cell(CompareMode::DateTime, "2024-01-02", false), "2024-01-02 00:00:00");
        assert_eq!(normalize_cell(CompareMode::DateTime, "not a date", false), "not a date");
    }

    #[test]
    fn charpad_json_and_null_rules() {
        assert!(cells_equal(CompareMode::CharPad, Some("ab   "), Some("ab"), false, false));
        assert!(!cells_equal(CompareMode::Text, Some("ab   "), Some("ab"), false, false));
        assert!(cells_equal(CompareMode::Text, Some("ab   "), Some("ab"), false, true));
        assert!(cells_equal(CompareMode::Json, Some(r#"{"b":1,"a":[1,2.0]}"#), Some(r#"{"a":[1,2],"b":1.0}"#), false, false));
        assert!(!cells_equal(CompareMode::Text, None, Some(""), false, false));
        assert!(cells_equal(CompareMode::Text, None, Some(""), true, false));
        assert!(cells_equal(CompareMode::Text, None, None, false, false));
    }

    #[test]
    fn render_for_target_only_rewrites_boolean_destinations() {
        // 目標是布林 → 一律 1/0（MySQL TINYINT(1) 不吃 'true'）。
        assert_eq!(render_for_target("tinyint(1)", Some("true")).as_deref(), Some("1"));
        assert_eq!(render_for_target("boolean", Some("false")).as_deref(), Some("0"));
        assert_eq!(render_for_target("bit", Some("t")).as_deref(), Some("1"));
        assert_eq!(render_for_target("tinyint(1)", Some("1")).as_deref(), Some("1"));
        // 目標不是布林 → 原樣（PG boolean → Oracle CHAR(1) 的 'Y'/'N' 不該被寫成 1/0，
        // 讓它照舊在目標端大聲失敗，而不是靜默寫入語意錯誤的值）。
        assert_eq!(render_for_target("varchar(10)", Some("true")).as_deref(), Some("true"));
        assert_eq!(render_for_target("char(1)", Some("true")).as_deref(), Some("true"));
        // 解析不出布林 → 原樣（如 MySQL BIT(8)）。
        assert_eq!(render_for_target("bit", Some("0x0A")).as_deref(), Some("0x0A"));
        assert_eq!(render_for_target("tinyint(1)", None), None);
    }

    #[test]
    fn key_compare_and_hash() {
        let modes = [CompareMode::Numeric];
        let k = |v: &str| vec![Some(v.to_string())];
        assert_eq!(cmp_key(&k("9"), &k("10"), &modes), Ordering::Less);
        assert_eq!(cmp_key(&k("10"), &k("10.0"), &modes), Ordering::Equal);
        let text = [CompareMode::Text];
        assert_eq!(cmp_key(&k("9"), &k("10"), &text), Ordering::Greater);
        assert_eq!(cmp_key(&vec![None], &k("a"), &text), Ordering::Less);
        assert_eq!(key_hash128(&k("a")), key_hash128(&k("a")));
        assert_ne!(key_hash128(&k("a")), key_hash128(&k("b")));
        assert_ne!(key_hash128(&vec![None]), key_hash128(&k("")));
        // canon_key 先正規化：1.0 與 1 同鍵。
        let row = vec![Some("1.0".to_string()), Some("x".to_string())];
        assert_eq!(canon_key(&row, &[0], &modes, false), k("1"));
        let r1 = row_hash(&[Some("1.0".into()), Some("t".into())], &[CompareMode::Numeric, CompareMode::Bool], false, false);
        let r2 = row_hash(&[Some("1".into()), Some("true".into())], &[CompareMode::Numeric, CompareMode::Bool], false, false);
        assert_eq!(r1, r2);
    }
}
