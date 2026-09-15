//! 共用小工具：host/port 切割、query 參數 → 各 driver options 鍵的映射、percent-decode、
//! 布林寬鬆判定。由 `standard`（URL 路徑）與 `kv`（ADO.NET 路徑）共用，避免雙份實作漂移。

use crate::db::conn_url::Parsed;
use crate::db::DbKind;

/// 切出 host[:port] 並寫進 `p`。
/// IPv6 以方括號包裹（`[::1]:5432`）——裸 `rsplit(':')` 會切壞，先處理。
/// host 做 percent-decode（`%2Fvar%2Frun` 這類 unix socket 路徑寫法）；port 切割在解碼**之前**，
/// 否則 `%3A` 解成 `:` 會被誤當成埠分隔。
pub(super) fn set_host_port(p: &mut Parsed, hostport: &str) {
    // 多主機清單（`h1:9092,h2:9092`）。Mongo 取第一個 seed——build_mongo_uri 一定會接
    // `:{port}`，整段逗號清單塞進 host 會組出 `h1:27017,h2:27017:27017`；replica set 其餘成員
    // 由 driver 自 seed 發現，功能等價。其餘類型（Kafka bootstrap 清單、MSSQL `host,port`）
    // 維持原樣保留的現行行為。
    if hostport.contains(',') {
        if matches!(p.kind, Some(DbKind::Mongo)) {
            // 取出的 seed 必然不含 `,`，遞迴只會再走一層。
            let first = hostport.split(',').next().unwrap_or(hostport).trim();
            return set_host_port(p, first);
        }
        p.host = Some(pct_decode(hostport));
        return;
    }

    if let Some(bracketed) = hostport.strip_prefix('[') {
        if let Some((h, after)) = bracketed.split_once(']') {
            if !h.is_empty() {
                p.host = Some(h.to_string());
            }
            if let Some(port_str) = after.strip_prefix(':') {
                p.port = port_str.parse::<u16>().ok();
            }
        }
    } else if hostport.matches(':').count() > 1 {
        // 無方括號的裸 IPv6（無 port，如 `redis://::1`）：整段視為 host。
        p.host = Some(hostport.to_string());
    } else {
        match hostport.rsplit_once(':') {
            Some((h, port_str)) if !h.is_empty() => {
                p.host = Some(pct_decode(h));
                p.port = port_str.parse::<u16>().ok();
            }
            _ => {
                if !hostport.is_empty() {
                    p.host = Some(pct_decode(hostport));
                }
            }
        }
    }
}

/// query string → (key, value) 清單（值 percent-decode；無 `=` 的段視為空值 flag）。
pub(super) fn parse_query_pairs(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (k.trim().to_string(), pct_decode(v)),
            None => (pair.trim().to_string(), String::new()),
        })
        .collect()
}

/// query 參數 → 各 driver 實際讀取的 options 鍵（per kind；未知參數靜默忽略）。
/// 值格式沿用各 driver 現行讀法：mongo_* 布林用 "1"、mssql / redis 布林用 "true"。
pub(super) fn apply_query_param(p: &mut Parsed, key: &str, value: &str) {
    let k = key.to_ascii_lowercase();

    // 通用憑證 / 資料庫參數：JDBC 慣用把帳密放 query（`jdbc:mysql://h/db?user=u&password=p`），
    // libpq URL 也接受 `?dbname=`。一律讓 userinfo / path 優先——URL 已寫明的不被 query 覆蓋，
    // 且命中後直接 return，不再落到 per-kind 分支（那裡沒有同名鍵，不會漏事）。
    match k.as_str() {
        "user" | "username" | "uid" if p.username.is_none() => {
            p.username = Some(value.to_string());
            return;
        }
        "password" | "pwd" if p.password.is_none() => {
            p.password = Some(value.to_string());
            return;
        }
        "dbname" if p.database.is_none() => {
            p.database = Some(value.to_string());
            return;
        }
        _ => {}
    }

    match p.kind {
        Some(DbKind::Postgres) => match k.as_str() {
            // postgres.rs 讀 ssl_mode，詞彙同 libpq（disable/require/verify-ca/verify-full，小寫）；
            // 部分工具會輸出大寫（REQUIRE），前端 Select 與 driver match 皆只認小寫，故正規化。
            "sslmode" => {
                p.options.insert("ssl_mode".into(), value.to_ascii_lowercase());
            }
            "sslrootcert" => {
                p.options.insert("ssl_ca".into(), value.to_string());
            }
            _ => {}
        },
        Some(DbKind::Mysql) | Some(DbKind::Mariadb) => match k.as_str() {
            // mysql.rs 讀 ssl_mode（disabled/required/verify_ca/verify_identity，小寫）；
            // JDBC 慣用大寫（REQUIRED / VERIFY_CA）故正規化小寫。容錯無連字號寫法。
            "ssl-mode" | "sslmode" | "ssl_mode" => {
                p.options.insert("ssl_mode".into(), value.to_ascii_lowercase());
            }
            "ssl-ca" | "ssl_ca" | "sslca" => {
                p.options.insert("ssl_ca".into(), value.to_string());
            }
            _ => {}
        },
        Some(DbKind::Mongo) => match k.as_str() {
            // mongo URI 選項鍵大小寫不敏感（driver 亦然）；值格式對齊 build_mongo_uri 讀法。
            "authsource" => {
                p.options.insert("mongo_auth_source".into(), value.to_string());
            }
            "tls" | "ssl" if truthy(value) => {
                p.options.insert("mongo_tls".into(), "1".into());
            }
            "replicaset" => {
                p.options.insert("mongo_replica_set".into(), value.to_string());
            }
            "directconnection" if truthy(value) => {
                p.options.insert("mongo_direct".into(), "1".into());
            }
            "tlscafile" => {
                p.options.insert("mongo_tls_ca".into(), value.to_string());
            }
            "tlsallowinvalidcertificates" if truthy(value) => {
                p.options.insert("mongo_tls_insecure".into(), "1".into());
            }
            _ => {}
        },
        Some(DbKind::Redis) => match k.as_str() {
            // redis.rs 的 connect 不讀 config.database，但它是 DB 索引的落點：
            // CLI（cli/dispatch.rs）以 `args.database.or(cfg.database)` 取用，GUI 側欄也顯示它。
            "db" | "database" => {
                p.database = Some(value.to_string());
            }
            // redis.rs 讀 redis_tls=="true"（非 mongo 系的 "1"）。
            "ssl" | "tls" if truthy(value) => {
                p.options.insert("redis_tls".into(), "true".into());
            }
            _ => {}
        },
        Some(DbKind::Mssql) => apply_mssql_kv(p, &k, value),
        _ => {}
    }
}

/// MSSQL 的 database / encrypt / trust 鍵映射：ADO.NET 分號參數與 URL query 共用同一份實作。
/// key 須為小寫；值格式沿 mssql.rs 讀法（encrypt!="false" 為開啟，非明確布林不寫入以免誤關）。
pub(super) fn apply_mssql_kv(p: &mut Parsed, key: &str, value: &str) {
    match key {
        // databaseName 為 JDBC sqlserver 的慣用鍵。
        "database" | "initial catalog" | "databasename" => {
            p.database = Some(value.to_string());
        }
        "encrypt" => {
            if truthy(value) {
                p.options.insert("encrypt".into(), "true".into());
            } else if falsy(value) {
                p.options.insert("encrypt".into(), "false".into());
            }
        }
        "trustservercertificate" | "trust server certificate" if truthy(value) => {
            p.options
                .insert("trust_server_certificate".into(), "true".into());
        }
        _ => {}
    }
}

/// percent-decoding（`%XX` → byte；非法序列原樣保留；不把 `+` 當空白——密碼字面值優先）。
/// 與 mongo.rs 的 `pct_encode` 互為對偶；解出的 bytes 以 UTF-8 lossy 轉回字串。
pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex_val(b[i + 1]), hex_val(b[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// 連線字串布林值的寬鬆判定（大小寫不拘）。
pub(super) fn truthy(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "true" | "1" | "yes")
}

pub(super) fn falsy(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "false" | "0" | "no")
}

/// 大小寫不敏感的前綴剝除（`jdbc:` / `tcp:` 等）。
pub(super) fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}
