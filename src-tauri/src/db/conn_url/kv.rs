//! key=value 形式的連線字串：ADO.NET / JDBC 的分號分隔參數。
//!
//! 與 URL 路徑的分工：URL 走 `standard`，本模組處理「無 scheme 但由 `key=value` 組成」的方言。
//! 每個偵測器都要求字串**不含 `://`**（由 `parse_url` 的 scheme 判斷保證），這是避免誤判的前提。

use crate::db::conn_url::params::{apply_mssql_kv, set_host_port, strip_prefix_ci};
use crate::db::conn_url::Parsed;
use crate::db::DbKind;

/// `key=value` 序列的分隔字元。
pub(super) enum Sep {
    /// libpq keyword/value：空白分隔。
    Whitespace,
    /// ADO.NET / JDBC / properties：分號或換行分隔。
    Semicolon,
}

impl Sep {
    fn matches(&self, c: char) -> bool {
        match self {
            Sep::Whitespace => c.is_whitespace(),
            Sep::Semicolon => matches!(c, ';' | '\n' | '\r'),
        }
    }
}

/// 依分隔字元切段，但引號（`'` / `"`）內的分隔字元不切，且支援 `\` 轉義。
/// libpq 的 `password='a b'` 與 JAAS 的 `username="k" password="s";` 都靠這個。
fn split_respecting_quotes(s: &str, sep: &Sep) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == '\\' {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                } else if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => {
                if c == '\'' || c == '"' {
                    quote = Some(c);
                } else if sep.matches(c) {
                    if !cur.trim().is_empty() {
                        out.push(cur.trim().to_string());
                    }
                    cur.clear();
                } else {
                    cur.push(c);
                }
            }
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// `key=value` 切詞：key 正規化為小寫，value 保留字面值（不 percent-decode——KV 方言慣例）。
/// 回 None 表示「至少有一段不含 `=`」，呼叫端據此判定整串不是 KV 字串
/// （例：`Data Source=h;…` 以空白切會得到無 `=` 的 `Data`，因此不會被誤判成 libpq）。
pub(super) fn tokenize(s: &str, sep: Sep) -> Option<Vec<(String, String)>> {
    let parts = split_respecting_quotes(s, &sep);
    if parts.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(parts.len());
    for part in parts {
        let (k, v) = part.split_once('=')?;
        out.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    Some(out)
}

/// libpq 專屬鍵：與 ADO.NET 的識別鍵完全不重疊，故可當成判別依據。
const LIBPQ_MARKERS: &[&str] = &[
    "host",
    "hostaddr",
    "dbname",
    "sslmode",
    "sslrootcert",
    "application_name",
];

/// libpq keyword/value DSN：`host=localhost port=5432 dbname=app user=u password=p sslmode=require`
/// （psql / PGSERVICE 慣用形式）。視為 Postgres。
///
/// 判別條件（皆須成立，任一不符即回 None 交給下一個偵測器）：
/// 1. 不含 `://`（由 `parse_url` 的 scheme 判斷保證，這裡再擋一次）
/// 2. kind hint 為 None 或 Postgres
/// 3. 切出 ≥2 段，且**每一段**都是 `key=value`
/// 4. 至少命中一個 libpq 專屬鍵
pub(super) fn try_libpq_kv(s: &str, hint: Option<DbKind>) -> Option<Parsed> {
    if s.contains("://") || !matches!(hint, None | Some(DbKind::Postgres)) {
        return None;
    }
    let toks = tokenize(s, Sep::Whitespace)?;
    if toks.len() < 2 {
        return None;
    }
    if !toks.iter().any(|(k, _)| LIBPQ_MARKERS.contains(&k.as_str())) {
        return None;
    }

    let mut p = Parsed {
        kind: Some(DbKind::Postgres),
        ..Default::default()
    };
    let mut port: Option<u16> = None;
    for (k, v) in &toks {
        if v.is_empty() {
            continue;
        }
        match k.as_str() {
            // hostaddr 是 IP 直連，host 優先（同時給時 host 才是憑證驗證用的名稱）。
            "host" => p.host = Some(v.clone()),
            "hostaddr" if p.host.is_none() => p.host = Some(v.clone()),
            "port" => port = v.parse::<u16>().ok(),
            "dbname" => p.database = Some(v.clone()),
            "user" => p.username = Some(v.clone()),
            "password" => p.password = Some(v.clone()),
            // postgres.rs 讀小寫 ssl_mode（disable/require/verify-ca/verify-full）。
            "sslmode" => {
                p.options.insert("ssl_mode".into(), v.to_ascii_lowercase());
            }
            "sslrootcert" => {
                p.options.insert("ssl_ca".into(), v.clone());
            }
            // application_name / connect_timeout / options 等無對應 driver 選項，靜默忽略。
            _ => {}
        }
    }
    // host 可能自帶 `:port`（非標準但常見）；port= 明確給值時以它為準。
    if let Some(h) = p.host.take() {
        set_host_port(&mut p, &h);
    }
    if port.is_some() {
        p.port = port;
    }
    Some(p)
}

/// ADO.NET 連線字串（`Server=…;Database=…;User ID=…;Password=…`）→ MSSQL。
pub(super) fn parse_ado(s: &str) -> Parsed {
    let mut p = Parsed {
        kind: Some(DbKind::Mssql),
        ..Default::default()
    };
    apply_ado_pairs(&mut p, s.split(';'));
    p
}

/// 套用 ADO.NET / JDBC 的分號 key=value 參數（key 大小寫不拘、可含空白；未知鍵靜默忽略）。
/// 值不做 percent-decode（ADO.NET 慣例為字面值）。
pub(super) fn apply_ado_pairs<'a>(p: &mut Parsed, pairs: impl Iterator<Item = &'a str>) {
    for pair in pairs {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        let key = k.trim().to_ascii_lowercase();
        let v = v.trim();
        match key.as_str() {
            // `tcp:host,port`（Azure 慣用）/ `host,port` / `host`。
            "server" | "data source" | "address" | "addr" | "network address" => {
                let s = strip_prefix_ci(v, "tcp:").unwrap_or(v);
                match s.split_once(',') {
                    Some((h, port)) => {
                        if !h.trim().is_empty() {
                            p.host = Some(h.trim().to_string());
                        }
                        p.port = port.trim().parse::<u16>().ok();
                    }
                    None => {
                        if !s.trim().is_empty() {
                            p.host = Some(s.trim().to_string());
                        }
                    }
                }
            }
            "user id" | "uid" | "user" => p.username = Some(v.to_string()),
            "password" | "pwd" => p.password = Some(v.to_string()),
            // database / encrypt / trust 走與 URL query 共用的映射（避免雙份實作漂移）。
            _ => apply_mssql_kv(p, &key, v),
        }
    }
}

/// 分號 KV 的位址 / 資料庫識別鍵（ADO.NET + Npgsql 聯集）。至少命中一個才視為連線字串，
/// 避免把任意含 `;`+`=` 的文字（含 `;` 的檔案路徑、Kafka properties）誤判。
const SEMICOLON_MARKERS: &[&str] = &[
    "server",
    "data source",
    "address",
    "addr",
    "network address",
    "database",
    "initial catalog",
    "databasename",
    "host",
];

/// MSSQL 專屬鍵：命中任一即判為 MSSQL（即使同時有 `host=`）。
const MSSQL_MARKERS: &[&str] = &[
    "initial catalog",
    "databasename",
    "trustservercertificate",
    "trust server certificate",
    "encrypt",
    "integrated security",
    "multisubnetfailover",
    "applicationintent",
    "persist security info",
    "column encryption setting",
];

/// 分號分隔的 key=value 連線字串（ADO.NET / Npgsql）。
///
/// 分類規則（Npgsql 的 `Host=…;Database=…` 原先被 ADO 偵測器吃下判成 MSSQL，而 `host` 不在
/// ADO 的 server 別名表裡 → kind 錯且 host 為空，卻回報成功。這是這裡要修的核心 bug）：
/// 1. 命中任一 MSSQL 專屬鍵 → MSSQL
/// 2. 否則有 `host=` 且無 `server=` → Postgres（Npgsql 的正規鍵）
/// 3. 否則 → MSSQL（維持現狀，確保既有 `Server=…` 字串行為完全不變）
///
/// kind hint 指向 MSSQL / Postgres 時直接採用（CLI `--kind` 是使用者明說的）；
/// 指向其他資料庫時回 None 不誤判（如含 `;` 的 sqlite 檔案路徑）。
pub(super) fn try_semicolon_kv(s: &str, hint: Option<DbKind>) -> Option<Parsed> {
    if s.contains("://") || !s.contains(';') {
        return None;
    }
    let keys: Vec<String> = s
        .split(';')
        .filter_map(|seg| seg.split_once('='))
        .map(|(k, _)| k.trim().to_ascii_lowercase())
        .collect();
    if !keys.iter().any(|k| SEMICOLON_MARKERS.contains(&k.as_str())) {
        return None;
    }

    let kind = match hint {
        Some(DbKind::Mssql) => DbKind::Mssql,
        Some(DbKind::Postgres) => DbKind::Postgres,
        Some(_) => return None,
        None => {
            if keys.iter().any(|k| MSSQL_MARKERS.contains(&k.as_str())) {
                DbKind::Mssql
            } else if keys.iter().any(|k| k == "host") && !keys.iter().any(|k| k == "server") {
                DbKind::Postgres
            } else {
                DbKind::Mssql
            }
        }
    };

    Some(match kind {
        DbKind::Postgres => parse_npgsql(s),
        _ => parse_ado(s),
    })
}

/// Npgsql（.NET 的 Postgres driver）分號字串：
/// `Host=pg;Port=5432;Database=app;Username=u;Password=p;SSL Mode=Require`。
///
/// 刻意**不**走 `apply_ado_pairs`：那條路對未知鍵會 fall through 到 `apply_mssql_kv`，
/// 會把 MSSQL 的 encrypt / trust_server_certificate 寫到 Postgres 的 Parsed 上。
fn parse_npgsql(s: &str) -> Parsed {
    let mut p = Parsed {
        kind: Some(DbKind::Postgres),
        ..Default::default()
    };
    let Some(toks) = tokenize(s, Sep::Semicolon) else {
        return p;
    };
    let mut port: Option<u16> = None;
    for (k, v) in &toks {
        if v.is_empty() {
            continue;
        }
        match k.as_str() {
            "host" | "server" => p.host = Some(v.clone()),
            "port" => port = v.parse::<u16>().ok(),
            "database" => p.database = Some(v.clone()),
            "username" | "user id" | "userid" | "uid" | "user" => p.username = Some(v.clone()),
            "password" | "pwd" => p.password = Some(v.clone()),
            "ssl mode" | "sslmode" => {
                if let Some(m) = npgsql_ssl_mode(v) {
                    p.options.insert("ssl_mode".into(), m.into());
                }
            }
            "root certificate" | "sslrootcert" => {
                p.options.insert("ssl_ca".into(), v.clone());
            }
            _ => {}
        }
    }
    if let Some(h) = p.host.take() {
        set_host_port(&mut p, &h);
    }
    if port.is_some() {
        p.port = port;
    }
    p
}

/// Npgsql 的 `SSL Mode` 詞彙（PascalCase）→ postgres.rs 讀的小寫 libpq 詞彙。
/// `Allow` / `Prefer` 無對應（driver 預設即 prefer）→ None，不寫入 options 以免誤鎖模式。
fn npgsql_ssl_mode(v: &str) -> Option<&'static str> {
    match v.to_ascii_lowercase().as_str() {
        "disable" => Some("disable"),
        "require" => Some("require"),
        "verifyca" | "verify-ca" => Some("verify-ca"),
        "verifyfull" | "verify-full" => Some("verify-full"),
        _ => None,
    }
}
