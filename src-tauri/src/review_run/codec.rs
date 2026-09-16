//! 無損取值與還原：前像查詢的 SELECT 運算式 ↔ 回滾腳本的 SQL 字面值，依方言與欄位型別成對定義。
//!
//! 為什麼不直接 `SELECT *`：driver 的 `cell_to_string` 是給**畫面**用的，會為了顯示而丟資訊——
//! 二進位只留前 64 bytes（`bytes_to_display`）、合法 UTF-8 的 BLOB 直接變成字串、Oracle CLOB
//! 截在 4 KB、MySQL TIMESTAMP 帶 " UTC" 後綴、認不得的型別變成 `<unrenderable>`。拿那些字串去
//! 產 INSERT，回滾腳本會「成功執行」並寫回一堆壞值，而且沒有任何徵兆。
//!
//! 所以每個欄位在 SELECT 端就改寫成「文字形式可無損往返」的運算式（HEX / `::text` / ISO 8601 /
//! `TO_CHAR(..., 固定格式)`），再由對應的 codec 還原成字面值。做不到無損的型別（sql_variant、
//! 超長 LOB、Oracle 物件型別）明確標 `Unsupported`，由上層把該列的回滾標成不完整。

use serde::{Deserialize, Serialize};

use crate::db::sqlgen::{quote_ident, sql_literal};
use crate::db::{ColumnInfo, DbKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Codec {
    /// 一般字串：`'…'`（MySQL 加倍反斜線、MSSQL 加 N 前綴）。
    Text,
    /// 數值：看起來是數字就不加引號，否則（NaN / Infinity / money 字樣）加引號交給伺服器轉型。
    Number,
    /// 十六進位字串 → MySQL / SQLite `X'…'`、Oracle `HEXTORAW('…')`。
    Hex,
    /// MSSQL `CONVERT(varchar(max), c, 1)` 的 `0x…` → 原樣輸出。
    MssqlBinary,
    /// MySQL 空間型別：`srid:hex(WKB)` → `ST_GeomFromWKB(X'…', srid)`。
    MysqlGeometry,
    /// MSSQL geography / geometry：`srid|WKT` → `geography::STGeomFromText(N'…', srid)`。
    MssqlGeography,
    MssqlGeometry,
    /// Oracle DATE：`YYYY-MM-DD HH24:MI:SS` → `TO_DATE(…)`。
    OracleDate,
    /// Oracle TIMESTAMP：`… .FF9` → `TO_TIMESTAMP(…)`。
    OracleTimestamp,
    /// Oracle TIMESTAMP WITH [LOCAL] TIME ZONE：`… TZH:TZM` → `TO_TIMESTAMP_TZ(…)`。
    OracleTimestampTz,
    /// Oracle BLOB：`h:hex` → `TO_BLOB(HEXTORAW(…))`；`L:長度` = 太長，無法以字面值還原。
    OracleBlob,
    /// Oracle CLOB / NCLOB：`s:文字` → `TO_CLOB('…')`；`L:長度` = 太長。
    OracleClob,
    /// SQLite 動態型別：`i:` / `r:` / `t:` / `b:` 前綴標出儲存類別。
    SqliteTagged,
    /// 無法無損往返（值非 NULL 時該列回滾不完整）。
    Unsupported,
}

/// 欄位的擷取 / 還原規格。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnSpec {
    pub name: String,
    pub data_type: String,
    pub codec: Codec,
    /// false：產生欄 / 計算欄 / rowversion——INSERT 與 UPDATE 都不能指定值。
    pub writable: bool,
    /// 自動編號（MSSQL identity 要 IDENTITY_INSERT、PG GENERATED ALWAYS 要 OVERRIDING SYSTEM VALUE）。
    pub identity: bool,
    /// `identity` 是否為「一律產生」（PG / Oracle 的 GENERATED ALWAYS）。
    #[serde(default)]
    pub identity_always: bool,
}

fn base_type(t: &str) -> String {
    let lower = t.trim().to_ascii_lowercase();
    let cut = lower.find('(').unwrap_or(lower.len());
    lower[..cut].trim().to_string()
}

/// 依 driver 回的 `ColumnInfo` 決定規格。`computed`：由方言專屬查詢補上的「不可寫」欄名。
pub fn column_spec(kind: DbKind, col: &ColumnInfo, computed: &[String]) -> ColumnSpec {
    let bt = base_type(&col.data_type);
    let extra = col.extra.to_ascii_lowercase();
    let mut spec = ColumnSpec {
        name: col.name.clone(),
        data_type: col.data_type.clone(),
        codec: Codec::Text,
        writable: !computed.iter().any(|c| c == &col.name),
        identity: false,
        identity_always: false,
    };
    match kind {
        DbKind::Mysql | DbKind::Mariadb => {
            spec.codec = match bt.as_str() {
                "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => Codec::Hex,
                "bit" | "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal" | "numeric"
                | "float" | "double" | "real" | "year" => Codec::Number,
                "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring" | "multipolygon"
                | "geometrycollection" | "geomcollection" => Codec::MysqlGeometry,
                _ => Codec::Text,
            };
            // DEFAULT_GENERATED（MySQL 8 的運算式預設值，如 CURRENT_TIMESTAMP）仍可寫。
            if extra.contains("virtual generated") || extra.contains("stored generated") || extra.contains("persistent generated") {
                spec.writable = false;
            }
            spec.identity = extra.contains("auto_increment");
        }
        DbKind::Postgres => {
            // PG 一律 `::text`：每個型別的文字輸出就是它的標準輸入格式（bytea 的 \x…、陣列、
            // timestamptz 含時區位移），天生可往返。只需決定要不要加引號。
            spec.codec = match bt.as_str() {
                "smallint" | "integer" | "bigint" | "numeric" | "decimal" | "real" | "double precision" | "int2"
                | "int4" | "int8" | "float4" | "float8" | "smallserial" | "serial" | "bigserial" => Codec::Number,
                _ => Codec::Text,
            };
            if extra.contains("generated stored") {
                spec.writable = false;
            }
            if extra.contains("identity") {
                spec.identity = true;
                spec.identity_always = true;
            }
        }
        DbKind::Mssql => {
            spec.codec = match bt.as_str() {
                "binary" | "varbinary" | "image" | "timestamp" | "rowversion" => Codec::MssqlBinary,
                "tinyint" | "smallint" | "int" | "bigint" | "decimal" | "numeric" | "float" | "real" | "money"
                | "smallmoney" | "bit" => Codec::Number,
                "geography" => Codec::MssqlGeography,
                "geometry" => Codec::MssqlGeometry,
                "sql_variant" => Codec::Unsupported,
                _ => Codec::Text,
            };
            if bt == "timestamp" || bt == "rowversion" {
                spec.writable = false;
            }
            spec.identity = extra.contains("identity");
        }
        DbKind::Oracle => {
            let upper = col.data_type.to_ascii_uppercase();
            spec.codec = if upper.starts_with("TIMESTAMP") && upper.contains("TIME ZONE") {
                Codec::OracleTimestampTz
            } else if upper.starts_with("TIMESTAMP") {
                Codec::OracleTimestamp
            } else {
                match bt.as_str() {
                    "number" | "float" | "binary_float" | "binary_double" | "integer" => Codec::Number,
                    "date" => Codec::OracleDate,
                    "raw" => Codec::Hex,
                    "blob" => Codec::OracleBlob,
                    "clob" | "nclob" => Codec::OracleClob,
                    "varchar2" | "nvarchar2" | "char" | "nchar" | "varchar" => Codec::Text,
                    // LONG / LONG RAW / BFILE / XMLTYPE / SDO_GEOMETRY / 物件型別 / ROWID / INTERVAL…
                    "interval day" | "interval year" => Codec::Text,
                    _ => Codec::Unsupported,
                }
            };
            if extra.contains("identity") {
                spec.identity = true;
            }
        }
        DbKind::Sqlite => {
            spec.codec = Codec::SqliteTagged;
        }
        _ => {}
    }
    spec
}

/// 前像 SELECT 的單欄運算式。`col` 為已加引號（可含限定詞）的欄位參照。
pub fn select_expr(kind: DbKind, spec: &ColumnSpec, col: &str) -> String {
    let bt = base_type(&spec.data_type);
    match (kind, spec.codec) {
        (DbKind::Mysql | DbKind::Mariadb, Codec::Hex) => format!("HEX({col})"),
        (DbKind::Mysql | DbKind::Mariadb, Codec::MysqlGeometry) => {
            format!("CONCAT(ST_SRID({col}), ':', HEX(ST_AsWKB({col})))")
        }
        // BIT 轉整數；其餘數值與日期時間一律轉字元——TIMESTAMP 的文字形式跟著 session time_zone
        //（sqlx 連線固定 +00:00，回滾腳本檔頭會 SET 回同一個時區）。
        (DbKind::Mysql | DbKind::Mariadb, Codec::Number) if bt == "bit" => format!("CAST({col} AS UNSIGNED)"),
        (DbKind::Mysql | DbKind::Mariadb, _) => match bt.as_str() {
            "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum" | "set" => col.to_string(),
            _ => format!("CAST({col} AS CHAR)"),
        },
        (DbKind::Postgres, _) => format!("({col})::text"),
        (DbKind::Mssql, Codec::MssqlBinary) => format!("CONVERT(varchar(max), CONVERT(varbinary(max), {col}), 1)"),
        (DbKind::Mssql, Codec::MssqlGeography | Codec::MssqlGeometry) => {
            // T-SQL 的 CONCAT 把 NULL 當空字串：不先判 NULL 會拿到 '|' 而不是 NULL。
            format!("CASE WHEN {col} IS NULL THEN NULL ELSE CONCAT({col}.STSrid, '|', {col}.AsTextZM()) END")
        }
        (DbKind::Mssql, Codec::Number) => match bt.as_str() {
            // style 3：17 位有效數字，float 可無損往返（SQL Server 2016+）。
            "float" | "real" => format!("CONVERT(varchar(40), {col}, 3)"),
            // style 2：money 四位小數、不帶千分位。
            "money" | "smallmoney" => format!("CONVERT(varchar(40), {col}, 2)"),
            _ => format!("CAST({col} AS varchar(60))"),
        },
        (DbKind::Mssql, _) => match bt.as_str() {
            // ISO 8601：不受 SET LANGUAGE / DATEFORMAT 影響（'2024-01-02 00:00' 在某些語系會讀成 2 月 1 日）。
            "datetime" | "datetime2" | "smalldatetime" => format!("CONVERT(varchar(40), {col}, 126)"),
            // 121 保留原始時區位移（127 會轉成 UTC 的 Z，+08:00 就丟了）；datetimeoffset 的 ODBC 格式不受語系影響。
            "datetimeoffset" => format!("CONVERT(varchar(40), {col}, 121)"),
            "date" => format!("CONVERT(varchar(10), {col}, 23)"),
            "time" => format!("CAST({col} AS varchar(20))"),
            "uniqueidentifier" => format!("CAST({col} AS varchar(36))"),
            "hierarchyid" => format!("{col}.ToString()"),
            "sql_variant" => format!("CAST({col} AS nvarchar(max))"),
            "xml" | "text" | "ntext" => format!("CAST({col} AS nvarchar(max))"),
            _ => col.to_string(),
        },
        (DbKind::Oracle, Codec::Number) => {
            format!("TO_CHAR({col}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')")
        }
        (DbKind::Oracle, Codec::OracleDate) => format!("TO_CHAR({col}, 'YYYY-MM-DD HH24:MI:SS')"),
        (DbKind::Oracle, Codec::OracleTimestamp) => format!("TO_CHAR({col}, 'YYYY-MM-DD HH24:MI:SS.FF9')"),
        (DbKind::Oracle, Codec::OracleTimestampTz) => format!("TO_CHAR({col}, 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM')"),
        (DbKind::Oracle, Codec::Hex) => format!("RAWTOHEX({col})"),
        // SQL 層的 VARCHAR2 上限 4000 bytes：BLOB 2000 bytes → 4000 個 hex 字元；CLOB 1000 字元 × 最多 4 bytes。
        (DbKind::Oracle, Codec::OracleBlob) => format!(
            "CASE WHEN {col} IS NULL THEN NULL WHEN DBMS_LOB.GETLENGTH({col}) <= 2000 THEN 'h:' || RAWTOHEX(DBMS_LOB.SUBSTR({col}, 2000, 1)) ELSE 'L:' || DBMS_LOB.GETLENGTH({col}) END"
        ),
        (DbKind::Oracle, Codec::OracleClob) => format!(
            "CASE WHEN {col} IS NULL THEN NULL WHEN DBMS_LOB.GETLENGTH({col}) <= 1000 THEN 's:' || DBMS_LOB.SUBSTR({col}, 1000, 1) ELSE 'L:' || DBMS_LOB.GETLENGTH({col}) END"
        ),
        (DbKind::Oracle, Codec::Unsupported) => format!("CASE WHEN {col} IS NULL THEN NULL ELSE 'unsupported' END"),
        (DbKind::Oracle, _) => col.to_string(),
        (DbKind::Sqlite, _) => format!(
            "CASE typeof({col}) WHEN 'integer' THEN 'i:' || {col} WHEN 'real' THEN 'r:' || printf('%.17g', {col}) WHEN 'text' THEN 't:' || {col} WHEN 'blob' THEN 'b:' || hex({col}) END"
        ),
        _ => col.to_string(),
    }
}

fn is_plain_number(v: &str) -> bool {
    let s = v.strip_prefix('-').unwrap_or(v);
    let (mant, exp) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let mut parts = mant.splitn(2, '.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    let int_ok = digits(int) || (int.is_empty() && frac.is_some_and(digits));
    let frac_ok = frac.map_or(true, |f| f.is_empty() || digits(f));
    let exp_ok = exp.map_or(true, |e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)));
    int_ok && frac_ok && exp_ok
}

fn is_digits(v: &str) -> bool {
    !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())
}

fn is_hex(v: &str) -> bool {
    v.len() % 2 == 0 && v.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 值能否以字面值無損還原（None = NULL 一律可以）。
pub fn restorable(spec: &ColumnSpec, v: Option<&str>) -> bool {
    let Some(v) = v else { return true };
    match spec.codec {
        Codec::Unsupported => false,
        Codec::Hex => is_hex(v),
        // 空的 varbinary 經 CONVERT(…, 1) 回來是空字串，不是 "0x"。
        Codec::MssqlBinary => v.is_empty() || (v.starts_with("0x") && is_hex(&v[2..])),
        Codec::MysqlGeometry => v.split_once(':').is_some_and(|(srid, hex)| is_digits(srid) && !hex.is_empty() && is_hex(hex)),
        Codec::MssqlGeography | Codec::MssqlGeometry => v.split_once('|').is_some_and(|(srid, wkt)| is_digits(srid) && !wkt.is_empty()),
        Codec::OracleBlob => v.strip_prefix("h:").is_some_and(is_hex),
        Codec::OracleClob => v.starts_with("s:"),
        Codec::SqliteTagged => {
            matches!(v.get(..2), Some("i:" | "r:" | "t:")) || v.strip_prefix("b:").is_some_and(is_hex)
        }
        _ => true,
    }
}

/// 值 → SQL 字面值。呼叫前應先確認 `restorable`；不可還原的值會退回 NULL 並由呼叫端註記。
pub fn literal(kind: DbKind, spec: &ColumnSpec, v: Option<&str>) -> String {
    let Some(v) = v else { return "NULL".to_string() };
    if !restorable(spec, Some(v)) {
        return "NULL".to_string();
    }
    let quoted = |s: &str| sql_literal(kind, Some(s));
    match spec.codec {
        Codec::Text => quoted(v),
        Codec::Number => {
            // 負零（-0 / -0.0）不加引號會被解析成整數 0，浮點欄位的正負號就丟了。
            let negative_zero = v.starts_with('-') && v.bytes().all(|b| matches!(b, b'-' | b'0' | b'.' | b'e' | b'E' | b'+'));
            if is_plain_number(v) && !negative_zero {
                v.to_string()
            } else {
                quoted(v)
            }
        }
        Codec::Hex => match kind {
            DbKind::Oracle => format!("HEXTORAW('{v}')"),
            DbKind::Postgres => format!("'\\x{v}'"),
            DbKind::Mssql => format!("0x{v}"),
            _ => format!("X'{v}'"),
        },
        Codec::MssqlBinary if v.is_empty() => "0x".to_string(),
        Codec::MssqlBinary => v.to_string(),
        Codec::MysqlGeometry => {
            let (srid, hex) = v.split_once(':').unwrap_or(("0", v));
            format!("ST_GeomFromWKB(X'{hex}', {srid})")
        }
        Codec::MssqlGeography | Codec::MssqlGeometry => {
            let (srid, wkt) = v.split_once('|').unwrap_or(("0", v));
            let ty = if spec.codec == Codec::MssqlGeography { "geography" } else { "geometry" };
            format!("{ty}::STGeomFromText({}, {srid})", quoted(wkt))
        }
        Codec::OracleDate => format!("TO_DATE({}, 'YYYY-MM-DD HH24:MI:SS')", quoted(v)),
        Codec::OracleTimestamp => format!("TO_TIMESTAMP({}, 'YYYY-MM-DD HH24:MI:SS.FF9')", quoted(v)),
        Codec::OracleTimestampTz => format!("TO_TIMESTAMP_TZ({}, 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM')", quoted(v)),
        Codec::OracleBlob => {
            let hex = &v[2..];
            if hex.is_empty() {
                "EMPTY_BLOB()".to_string()
            } else {
                format!("TO_BLOB(HEXTORAW('{hex}'))")
            }
        }
        Codec::OracleClob => format!("TO_CLOB({})", quoted(&v[2..])),
        Codec::SqliteTagged => {
            let body = &v[2..];
            match &v[..2] {
                "i:" => body.to_string(),
                "r:" if is_plain_number(body) => shortest_float(body).unwrap_or_else(|| body.to_string()),
                // SQLite 沒有 Inf 字面值；9e999 溢位成 Inf 是官方文件給的寫法。
                "r:" if body.eq_ignore_ascii_case("inf") => "9e999".to_string(),
                "r:" if body.eq_ignore_ascii_case("-inf") => "-9e999".to_string(),
                "r:" => quoted(body),
                "b:" => format!("X'{body}'"),
                _ => quoted(body),
            }
        }
        Codec::Unsupported => "NULL".to_string(),
    }
}

/// 浮點數的最短可往返寫法（`0.1` 而非 `0.10000000000000001`；極大 / 極小值用指數）。
fn shortest_float(body: &str) -> Option<String> {
    let f: f64 = body.trim().parse().ok()?;
    if !f.is_finite() {
        return None;
    }
    Some(format!("{f:?}"))
}

/// 給人看的值（diff.md / 註解）：去掉 codec 的內部前綴，二進位以 0x 顯示。與字面值無關，不可拿來產 SQL。
pub fn display(spec: &ColumnSpec, v: Option<&str>) -> String {
    let Some(v) = v else { return "NULL".to_string() };
    match spec.codec {
        Codec::Hex => format!("0x{v}"),
        Codec::MysqlGeometry => v.split_once(':').map(|(srid, hex)| format!("SRID {srid} WKB 0x{hex}")).unwrap_or_else(|| v.to_string()),
        Codec::MssqlGeography | Codec::MssqlGeometry => v.split_once('|').map(|(srid, wkt)| format!("{wkt} (SRID {srid})")).unwrap_or_else(|| v.to_string()),
        Codec::OracleBlob => match v.strip_prefix("h:") {
            Some(hex) => format!("0x{hex}"),
            None => format!("<BLOB {} bytes>", v.trim_start_matches("L:")),
        },
        Codec::OracleClob => match v.strip_prefix("s:") {
            Some(text) => text.to_string(),
            None => format!("<CLOB {} chars>", v.trim_start_matches("L:")),
        },
        Codec::SqliteTagged => match v.get(..2) {
            Some("b:") => format!("0x{}", &v[2..]),
            Some("r:") => shortest_float(&v[2..]).unwrap_or_else(|| v[2..].to_string()),
            Some("i:" | "t:") => v[2..].to_string(),
            _ => v.to_string(),
        },
        _ => v.to_string(),
    }
}

/// 兩個擷取值是否相同（同一個 codec 產出的文字形式直接比）。
pub fn same_value(a: Option<&str>, b: Option<&str>) -> bool {
    a == b
}

/// 已加引號的欄位參照（可帶限定詞）。
pub fn column_ref(kind: DbKind, qualifier: Option<&str>, name: &str) -> String {
    match qualifier {
        Some(q) if !q.is_empty() => format!("{q}.{}", quote_ident(kind, name)),
        _ => quote_ident(kind, name),
    }
}

/// 回滾腳本檔頭：把 session 設回擷取時的狀態，值的文字形式才會被同樣解讀。
pub fn script_preamble(kind: DbKind) -> Vec<String> {
    match kind {
        // sqlx 的 MySQL 連線固定 time_zone '+00:00'：TIMESTAMP 是以 UTC 文字擷取的。
        DbKind::Mysql | DbKind::Mariadb => vec!["SET NAMES utf8mb4".into(), "SET time_zone = '+00:00'".into()],
        // sqlx 的 PG 連線固定 DateStyle ISO / TimeZone UTC；bytea 的 '\x…' 需要 standard_conforming_strings。
        DbKind::Postgres => vec![
            "SET standard_conforming_strings = on".into(),
            "SET DateStyle = 'ISO, MDY'".into(),
            "SET TimeZone = 'UTC'".into(),
        ],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, extra: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: extra.into(),
            comment: String::new(),
        }
    }

    fn roundtrip(kind: DbKind, ty: &str, extra: &str, v: Option<&str>) -> (String, String) {
        let s = column_spec(kind, &col("c", ty, extra), &[]);
        (select_expr(kind, &s, "`c`"), literal(kind, &s, v))
    }

    #[test]
    fn mysql_binary_bit_geometry_and_text() {
        let (sel, lit) = roundtrip(DbKind::Mysql, "varbinary(16)", "", Some("00FF10"));
        assert_eq!((sel.as_str(), lit.as_str()), ("HEX(`c`)", "X'00FF10'"));
        let (sel, lit) = roundtrip(DbKind::Mysql, "bit(8)", "", Some("5"));
        assert_eq!((sel.as_str(), lit.as_str()), ("CAST(`c` AS UNSIGNED)", "5"));
        let (sel, lit) = roundtrip(DbKind::Mysql, "point", "", Some("4326:0101"));
        assert!(sel.starts_with("CONCAT(ST_SRID"));
        assert_eq!(lit, "ST_GeomFromWKB(X'0101', 4326)");
        let (sel, lit) = roundtrip(DbKind::Mysql, "timestamp(3)", "DEFAULT_GENERATED", Some("2024-01-02 03:04:05.678"));
        assert_eq!((sel.as_str(), lit.as_str()), ("CAST(`c` AS CHAR)", "'2024-01-02 03:04:05.678'"));
        let (sel, lit) = roundtrip(DbKind::Mysql, "varchar(20)", "", Some("a\\b'c"));
        assert_eq!((sel.as_str(), lit.as_str()), ("`c`", "'a\\\\b''c'"));
        let (_, lit) = roundtrip(DbKind::Mysql, "decimal(10,2)", "", Some("-12.50"));
        assert_eq!(lit, "-12.50");
        // 產生欄不可寫；DEFAULT_GENERATED 可寫。
        assert!(!column_spec(DbKind::Mysql, &col("g", "int", "VIRTUAL GENERATED"), &[]).writable);
        assert!(column_spec(DbKind::Mysql, &col("g", "timestamp", "DEFAULT_GENERATED on update CURRENT_TIMESTAMP"), &[]).writable);
        // 截斷 / 非 hex 的值不可還原。
        let s = column_spec(DbKind::Mysql, &col("b", "blob", ""), &[]);
        assert!(!restorable(&s, Some("0xff… (100 bytes)")));
        assert_eq!(literal(DbKind::Mysql, &s, Some("zz")), "NULL");
    }

    #[test]
    fn postgres_casts_everything_to_text() {
        let (sel, lit) = roundtrip(DbKind::Postgres, "bytea", "", Some("\\x00ff"));
        assert_eq!(sel, "(`c`)::text");
        assert_eq!(lit, "'\\x00ff'");
        let (_, lit) = roundtrip(DbKind::Postgres, "double precision", "", Some("NaN"));
        assert_eq!(lit, "'NaN'");
        let (_, lit) = roundtrip(DbKind::Postgres, "integer", "", Some("42"));
        assert_eq!(lit, "42");
        let s = column_spec(DbKind::Postgres, &col("id", "bigint", "generated always as identity"), &[]);
        assert!(s.identity && s.identity_always && s.writable);
        assert!(!column_spec(DbKind::Postgres, &col("g", "integer", "generated stored"), &[]).writable);
    }

    #[test]
    fn mssql_iso_dates_binary_and_computed() {
        let (sel, lit) = roundtrip(DbKind::Mssql, "datetime2(7)", "", Some("2024-01-02T03:04:05.1234567"));
        assert_eq!(sel, "CONVERT(varchar(40), `c`, 126)");
        assert_eq!(lit, "N'2024-01-02T03:04:05.1234567'");
        let (sel, lit) = roundtrip(DbKind::Mssql, "varbinary(max)", "", Some("0x00FF"));
        assert!(sel.contains(", 1)"));
        assert_eq!(lit, "0x00FF");
        let (_, lit) = roundtrip(DbKind::Mssql, "geography", "", Some("4326|POINT (1 2)"));
        assert_eq!(lit, "geography::STGeomFromText(N'POINT (1 2)', 4326)");
        let s = column_spec(DbKind::Mssql, &col("v", "sql_variant", ""), &[]);
        assert!(!restorable(&s, Some("1")));
        assert!(restorable(&s, None));
        assert!(!column_spec(DbKind::Mssql, &col("rv", "rowversion", ""), &[]).writable);
        assert!(!column_spec(DbKind::Mssql, &col("calc", "int", ""), &["calc".to_string()]).writable);
        assert!(column_spec(DbKind::Mssql, &col("id", "int", "identity"), &[]).identity);
    }

    #[test]
    fn oracle_formats_and_lobs() {
        let (sel, lit) = roundtrip(DbKind::Oracle, "DATE", "", Some("2024-01-02 03:04:05"));
        assert!(sel.starts_with("TO_CHAR("));
        assert_eq!(lit, "TO_DATE('2024-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS')");
        let (_, lit) = roundtrip(DbKind::Oracle, "TIMESTAMP(6) WITH TIME ZONE", "", Some("2024-01-02 03:04:05.000000000 +08:00"));
        assert!(lit.starts_with("TO_TIMESTAMP_TZ("));
        let (_, lit) = roundtrip(DbKind::Oracle, "BLOB", "", Some("h:00FF"));
        assert_eq!(lit, "TO_BLOB(HEXTORAW('00FF'))");
        let s = column_spec(DbKind::Oracle, &col("c", "CLOB", ""), &[]);
        assert!(!restorable(&s, Some("L:50000")));
        assert_eq!(literal(DbKind::Oracle, &s, Some("s:hi'")), "TO_CLOB('hi''')");
        assert!(!restorable(&column_spec(DbKind::Oracle, &col("x", "XMLTYPE", ""), &[]), Some("unsupported")));
    }

    #[test]
    fn sqlite_tagged_values() {
        let s = column_spec(DbKind::Sqlite, &col("c", "", ""), &[]);
        assert_eq!(literal(DbKind::Sqlite, &s, Some("i:42")), "42");
        assert_eq!(literal(DbKind::Sqlite, &s, Some("r:0.10000000000000001")), "0.1");
        assert_eq!(literal(DbKind::Sqlite, &s, Some("r:1.0000000000000001e+300")), "1e300");
        assert_eq!(display(&s, Some("t:中文")), "中文");
        assert_eq!(display(&s, Some("b:CAFE")), "0xCAFE");
        assert_eq!(display(&s, Some("r:99.989999999999995")), "99.99");
        assert_eq!(literal(DbKind::Sqlite, &s, Some("t:it's")), "'it''s'");
        assert_eq!(literal(DbKind::Sqlite, &s, Some("b:CAFE")), "X'CAFE'");
        assert_eq!(literal(DbKind::Sqlite, &s, Some("r:inf")), "9e999");
        assert!(!restorable(&s, Some("oops")));
    }

    #[test]
    fn plain_number_detection() {
        for ok in ["0", "-1", "3.14", ".5", "1e10", "-2.5E-3", "10."] {
            assert!(is_plain_number(ok), "{ok}");
        }
        for bad in ["", "-", "1.2.3", "0x10", "NaN", "Infinity", "1e", "$1.00", "1,000"] {
            assert!(!is_plain_number(bad), "{bad}");
        }
    }
}
