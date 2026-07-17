//! 連線字串解析統一落點（GUI「貼上連線字串」指令與 dbk CLI `--url` 共用）。
//!
//! 支援格式：
//! - 標準 URL / DSN：`scheme://[user[:pass]@]host[:port][/db][?k=v&…][#fragment]`
//!   （userinfo / database / query 值做 percent-decode；IPv6 host 以方括號 `[::1]:5432`）
//! - `mongodb+srv://`（DNS SRV，不帶 port）與 `rediss://`（TLS）
//! - JDBC：開頭 `jdbc:` 剝掉後照常解析（`jdbc:sqlserver://host;databaseName=db;…`）
//! - ADO.NET：無 scheme 且含 `;` + `=` → `Server=host,port;Database=db;User ID=u;…`（視為 MSSQL）
//! - sqlite：`sqlite:path` / `sqlite://path` / 純檔案路徑（Windows 磁碟機字首 `C:` 不誤判為 scheme）
//!
//! query 參數依 kind 映射到各 driver 實際讀取的 options 鍵（見 `apply_query_param`）；
//! 未知參數靜默忽略。

use std::collections::BTreeMap;

use crate::db::DbKind;
use crate::error::{AppError, AppResult};

/// URL / DSN 解析結果。欄位皆可選：None = 字串中未提供（CLI 沿用旗標 / 預設值、
/// GUI 前端保留欄位現值）。直接序列化回前端（snake_case 欄位名，與 ConnectionConfig / api.ts
/// 對齊；kind 沿 DbKind 的 lowercase serde）。
#[derive(Debug, Default, serde::Serialize)]
pub struct Parsed {
    pub kind: Option<DbKind>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    /// 已映射成各 driver 讀取的 options 鍵（如 ssl_mode / ssl_ca / mongo_srv / redis_tls）。
    pub options: BTreeMap<String, String>,
}

/// 已知 scheme → DbKind 對照（單一事實來源：`split_scheme` 與 `parse_url` 共用；
/// 未來新增類型（elasticsearch / amqp…）只需在此加一列）。
fn scheme_kind(s: &str) -> Option<DbKind> {
    match s {
        "mysql" => Some(DbKind::Mysql),
        "mariadb" => Some(DbKind::Mariadb),
        "postgres" | "postgresql" => Some(DbKind::Postgres),
        "mongodb" | "mongodb+srv" | "mongo" => Some(DbKind::Mongo),
        "redis" | "rediss" => Some(DbKind::Redis),
        "mssql" | "sqlserver" => Some(DbKind::Mssql),
        "oracle" => Some(DbKind::Oracle),
        "kafka" => Some(DbKind::Kafka),
        "elasticsearch" | "opensearch" | "elastic" => Some(DbKind::Elastic),
        "amqp" | "amqps" => Some(DbKind::RabbitMq),
        "sqlite" => Some(DbKind::Sqlite),
        _ => None,
    }
}

/// 取出 scheme：先試 `scheme://`，再試 `scheme:`（僅限已知 scheme，避免把 Windows 磁碟機 `C:` 當 scheme）。
pub fn split_scheme(url: &str) -> (Option<String>, String) {
    if let Some((s, r)) = url.split_once("://") {
        return (Some(s.to_ascii_lowercase()), r.to_string());
    }
    if let Some((s, r)) = url.split_once(':') {
        let s = s.to_ascii_lowercase();
        if scheme_kind(&s).is_some() {
            return (Some(s), r.to_string());
        }
    }
    (None, url.to_string())
}

/// URL / DSN / ADO.NET 解析：`scheme://[user[:pass]@]host[:port][/db][?k=v&…]`。
/// sqlite 特例：`sqlite:path` / `sqlite://path` 或直接給檔案路徑 → database = path（不需 url crate）。
/// 回 Err 僅於「明確給了 scheme 但不認得且無 kind hint」（給使用者清楚錯誤而非默默全空）。
pub fn parse_url(url: &str, kind_hint: Option<DbKind>) -> AppResult<Parsed> {
    let url = url.trim();

    // JDBC：只支援 `jdbc:sqlserver://…`。其他 dialect（`jdbc:oracle:thin:@…`、`jdbc:postgresql://…`）
    // 內層語法各異，剝掉 `jdbc:` 前綴後會被誤解析成錯誤欄位，故明確報錯而非默默亂解。
    let url = if let Some(rest) = strip_prefix_ci(url, "jdbc:") {
        let dialect = rest.split([':', '/']).next().unwrap_or("").to_ascii_lowercase();
        if dialect != "sqlserver" {
            return Err(AppError::Connect(tf!(
                "不支援的連線字串格式：{scheme}",
                scheme = format!("jdbc:{dialect}")
            )));
        }
        rest
    } else {
        url
    };

    let (scheme, rest) = split_scheme(url);

    // 無 scheme 且長得像 ADO.NET（分號分隔的 key=value，且至少命中一個 ADO 識別鍵）→ 視為 MSSQL。
    // kind hint 指向其他資料庫時不誤判（如 sqlite 檔案路徑）。
    if scheme.is_none()
        && matches!(kind_hint, None | Some(DbKind::Mssql))
        && looks_like_ado(url)
    {
        return Ok(parse_ado(url));
    }

    // scheme → DbKind（單一事實來源見 `scheme_kind`）。已給 scheme 但不認得且無 hint → 明確報錯。
    let kind = match scheme.as_deref() {
        Some(s) => match scheme_kind(s) {
            Some(k) => Some(k),
            None => match kind_hint {
                Some(k) => Some(k),
                None => {
                    return Err(AppError::Connect(tf!(
                        "不支援的連線字串格式：{scheme}",
                        scheme = s
                    )))
                }
            },
        },
        None => kind_hint,
    };

    // sqlite：去掉 scheme 後整段當檔案路徑（路徑可含 ? / #，不做 query 切割）。
    if matches!(kind, Some(DbKind::Sqlite)) {
        let path = if scheme.is_some() { rest } else { url.to_string() };
        return Ok(Parsed {
            kind,
            database: Some(path),
            ..Default::default()
        });
    }

    let mut p = Parsed {
        kind,
        ..Default::default()
    };

    // 先切掉 #fragment，再切出 ?query——query 不屬於 database（舊版 bug：`?sslmode=require`
    // 會被吃進 database 欄）。
    let mut rest = rest;
    let mut fragment: Option<String> = None;
    if let Some(pos) = rest.find('#') {
        fragment = Some(rest[pos + 1..].to_string());
        rest.truncate(pos);
    }
    let mut query: Option<String> = None;
    if let Some(pos) = rest.find('?') {
        query = Some(rest[pos + 1..].to_string());
        rest.truncate(pos);
    }

    // 切出 /db（query / fragment 已移除；剩下 authority[;ado-params][/db]）。
    let (authority, db) = match rest.split_once('/') {
        Some((a, d)) => (
            a.to_string(),
            if d.is_empty() { None } else { Some(pct_decode(d)) },
        ),
        None => (rest, None),
    };
    if db.is_some() {
        p.database = db;
    }

    // 切出 user[:pass]@（userinfo 需 percent-decode；密碼常含 @ / : / ; / % 等符號）。
    // 必須在 MSSQL 分號參數切割之前抽出，否則密碼裡的 `;k=v` 會被誤當成 ADO 參數而截斷主機。
    let mut hostport = if let Some((userinfo, hp)) = authority.rsplit_once('@') {
        match userinfo.split_once(':') {
            Some((u, pw)) => {
                p.username = Some(pct_decode(u));
                p.password = Some(pct_decode(pw));
            }
            None => p.username = Some(pct_decode(userinfo)),
        }
        hp.to_string()
    } else {
        authority
    };

    // MSSQL：`host:1433;databaseName=db;encrypt=true` 的分號 key=value 參數（JDBC 慣用形式）。
    // 只作用於 host 段（userinfo 已抽出），無 `=` 的分號段不動。databaseName 覆寫上面的 /db。
    if matches!(p.kind, Some(DbKind::Mssql)) {
        if let Some((head, params)) = hostport
            .split_once(';')
            .filter(|(_, params)| params.contains('='))
            .map(|(head, params)| (head.to_string(), params.to_string()))
        {
            apply_ado_pairs(&mut p, params.split(';'));
            hostport = head;
        }
    }

    // 切出 host[:port]。IPv6 以方括號包裹（`[::1]:5432`）——裸 `rsplit(':')` 會切壞，先處理。
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
        p.host = Some(hostport);
    } else {
        match hostport.rsplit_once(':') {
            Some((h, port_str)) if !h.is_empty() => {
                p.host = Some(h.to_string());
                p.port = port_str.parse::<u16>().ok();
            }
            _ => {
                if !hostport.is_empty() {
                    p.host = Some(hostport);
                }
            }
        }
    }

    // scheme 衍生選項：值格式沿用各 driver 現行讀法
    // （mongo.rs build_mongo_uri 讀 mongo_srv=="1"；redis.rs 讀 redis_tls=="true"）。
    if scheme.as_deref() == Some("mongodb+srv") {
        // SRV：port 由 DNS SRV 記錄決定，不填（即使使用者誤帶也忽略）。
        p.port = None;
        p.options.insert("mongo_srv".into(), "1".into());
    }
    if scheme.as_deref() == Some("rediss") {
        p.options.insert("redis_tls".into(), "true".into());
    }
    // 本 app 的 redis TLS URL 方言：`#insecure` fragment（見 db/redis.rs）→ 略過憑證驗證。
    if matches!(p.kind, Some(DbKind::Redis)) && fragment.as_deref() == Some("insecure") {
        p.options.insert("redis_tls_insecure".into(), "true".into());
    }
    // RabbitMQ：amqps → TLS；URL path 段（database）為 vhost，改存 rabbitmq_vhost 供前端欄位還原
    // （CloudAMQP `amqps://user:pass@host/vhost`；vhost 常等於 username）。
    if matches!(p.kind, Some(DbKind::RabbitMq)) {
        if scheme.as_deref() == Some("amqps") {
            p.options.insert("rabbitmq_tls".into(), "1".into());
        }
        if let Some(vhost) = p.database.take() {
            p.options.insert("rabbitmq_vhost".into(), vhost);
        }
    }

    // query 參數 → per-kind options 映射（未知參數靜默忽略）。
    if let Some(q) = query {
        for (k, v) in parse_query_pairs(&q) {
            apply_query_param(&mut p, &k, &v);
        }
    }

    Ok(p)
}

/// ADO.NET 連線字串（`Server=…;Database=…;User ID=…;Password=…`）→ MSSQL。
fn parse_ado(s: &str) -> Parsed {
    let mut p = Parsed {
        kind: Some(DbKind::Mssql),
        ..Default::default()
    };
    apply_ado_pairs(&mut p, s.split(';'));
    p
}

/// 套用 ADO.NET / JDBC 的分號 key=value 參數（key 大小寫不拘、可含空白；未知鍵靜默忽略）。
/// 值不做 percent-decode（ADO.NET 慣例為字面值）。
fn apply_ado_pairs<'a>(p: &mut Parsed, pairs: impl Iterator<Item = &'a str>) {
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

/// MSSQL 的 database / encrypt / trust 鍵映射：ADO.NET 分號參數與 URL query 共用同一份實作。
/// key 須為小寫；值格式沿 mssql.rs 讀法（encrypt!="false" 為開啟，非明確布林不寫入以免誤關）。
fn apply_mssql_kv(p: &mut Parsed, key: &str, value: &str) {
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

/// 是否為 ADO.NET 連線字串：分號分隔的 key=value，且至少命中一個 ADO 識別鍵（位址或資料庫）。
/// 避免把任意含 `;`+`=` 的文字（Kafka properties、含 `;` 的檔案路徑）誤判成 MSSQL 連線。
fn looks_like_ado(s: &str) -> bool {
    s.split(';').any(|pair| {
        pair.split_once('=').is_some_and(|(k, _)| {
            matches!(
                k.trim().to_ascii_lowercase().as_str(),
                "server"
                    | "data source"
                    | "address"
                    | "addr"
                    | "network address"
                    | "database"
                    | "initial catalog"
                    | "databasename"
            )
        })
    })
}

/// query string → (key, value) 清單（值 percent-decode；無 `=` 的段視為空值 flag）。
fn parse_query_pairs(q: &str) -> Vec<(String, String)> {
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
fn apply_query_param(p: &mut Parsed, key: &str, value: &str) {
    let k = key.to_ascii_lowercase();
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
        Some(DbKind::Mssql) => apply_mssql_kv(p, &k, value),
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
fn truthy(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "true" | "1" | "yes")
}

fn falsy(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "false" | "0" | "no")
}

/// 大小寫不敏感的前綴剝除（`jdbc:` / `tcp:` 等）。
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Parsed {
        parse_url(url, None).expect("應可解析")
    }

    fn opt<'a>(p: &'a Parsed, k: &str) -> Option<&'a str> {
        p.options.get(k).map(String::as_str)
    }

    // ---- 各 scheme 基本解析 ----

    #[test]
    fn mysql_full_url() {
        let p = parse("mysql://user:pass@localhost:3306/mydb");
        assert_eq!(p.kind, Some(DbKind::Mysql));
        assert_eq!(p.host.as_deref(), Some("localhost"));
        assert_eq!(p.port, Some(3306));
        assert_eq!(p.username.as_deref(), Some("user"));
        assert_eq!(p.password.as_deref(), Some("pass"));
        assert_eq!(p.database.as_deref(), Some("mydb"));
        assert!(p.options.is_empty());
    }

    #[test]
    fn mariadb_and_postgresql_aliases() {
        assert_eq!(parse("mariadb://h/db").kind, Some(DbKind::Mariadb));
        assert_eq!(parse("postgresql://h/db").kind, Some(DbKind::Postgres));
        assert_eq!(parse("sqlserver://h").kind, Some(DbKind::Mssql));
        assert_eq!(parse("oracle://sys:pw@h:1521/XEPDB1").database.as_deref(), Some("XEPDB1"));
        assert_eq!(parse("kafka://broker:9092").port, Some(9092));
    }

    // ---- query string 不進 database（舊版 bug 回歸測試）----

    #[test]
    fn query_not_eaten_into_database() {
        let p = parse("postgres://u:p@h:5432/app?sslmode=require");
        assert_eq!(p.database.as_deref(), Some("app"));
        assert_eq!(opt(&p, "ssl_mode"), Some("require"));
    }

    #[test]
    fn query_without_path_leaves_database_none() {
        let p = parse("postgres://h?sslmode=require");
        assert_eq!(p.database, None);
        assert_eq!(p.host.as_deref(), Some("h"));
        assert_eq!(opt(&p, "ssl_mode"), Some("require"));
    }

    // ---- percent-decode ----

    #[test]
    fn userinfo_percent_decoded() {
        // 密碼含 %40（@）與 %3A（:）。
        let p = parse("mysql://us%2Fer:p%40ss%3Aw0rd@h:3306/my%20db");
        assert_eq!(p.username.as_deref(), Some("us/er"));
        assert_eq!(p.password.as_deref(), Some("p@ss:w0rd"));
        assert_eq!(p.database.as_deref(), Some("my db"));
    }

    #[test]
    fn pct_decode_keeps_invalid_sequences() {
        assert_eq!(pct_decode("a%zzb"), "a%zzb"); // 非 hex → 原樣
        assert_eq!(pct_decode("tail%4"), "tail%4"); // 截尾 → 原樣
        assert_eq!(pct_decode("a+b"), "a+b"); // `+` 不當空白
        assert_eq!(pct_decode("%41%42"), "AB");
    }

    // ---- IPv6 ----

    #[test]
    fn ipv6_bracketed_host_with_port() {
        let p = parse("postgres://[::1]:5432/db");
        assert_eq!(p.host.as_deref(), Some("::1"));
        assert_eq!(p.port, Some(5432));
        assert_eq!(p.database.as_deref(), Some("db"));
    }

    #[test]
    fn ipv6_bracketed_host_without_port() {
        let p = parse("redis://user:pw@[2001:db8::1]/0");
        assert_eq!(p.host.as_deref(), Some("2001:db8::1"));
        assert_eq!(p.port, None);
        assert_eq!(p.database.as_deref(), Some("0"));
    }

    #[test]
    fn ipv6_bare_host_treated_whole() {
        let p = parse("redis://::1");
        assert_eq!(p.host.as_deref(), Some("::1"));
        assert_eq!(p.port, None);
    }

    // ---- mongodb+srv / rediss ----

    #[test]
    fn mongodb_srv_sets_option_and_drops_port() {
        let p = parse("mongodb+srv://u:p@cluster0.example.mongodb.net/mydb?authSource=admin");
        assert_eq!(p.kind, Some(DbKind::Mongo));
        assert_eq!(p.host.as_deref(), Some("cluster0.example.mongodb.net"));
        assert_eq!(p.port, None); // SRV 不帶 port
        assert_eq!(p.database.as_deref(), Some("mydb"));
        assert_eq!(opt(&p, "mongo_srv"), Some("1"));
        assert_eq!(opt(&p, "mongo_auth_source"), Some("admin"));
    }

    #[test]
    fn rediss_sets_tls_option() {
        let p = parse("rediss://:secret@cache.example.com:6380/2");
        assert_eq!(p.kind, Some(DbKind::Redis));
        assert_eq!(opt(&p, "redis_tls"), Some("true")); // redis.rs 讀 "true"
        assert_eq!(p.password.as_deref(), Some("secret"));
        assert_eq!(p.database.as_deref(), Some("2"));
        assert_eq!(p.port, Some(6380));
    }

    #[test]
    fn rediss_insecure_fragment_maps_to_option() {
        let p = parse("rediss://h:6380/0#insecure");
        assert_eq!(opt(&p, "redis_tls_insecure"), Some("true"));
        assert_eq!(p.database.as_deref(), Some("0")); // fragment 不進 database
    }

    // ---- mongo query 參數映射 ----

    #[test]
    fn mongo_query_params_mapped() {
        let p = parse(
            "mongodb://h:27017/app?tls=true&replicaSet=rs0&directConnection=true\
             &tlsCAFile=%2Fetc%2Fca.pem&tlsAllowInvalidCertificates=true&unknownParam=x",
        );
        assert_eq!(opt(&p, "mongo_tls"), Some("1")); // mongo.rs 讀 "1"
        assert_eq!(opt(&p, "mongo_replica_set"), Some("rs0"));
        assert_eq!(opt(&p, "mongo_direct"), Some("1"));
        assert_eq!(opt(&p, "mongo_tls_ca"), Some("/etc/ca.pem"));
        assert_eq!(opt(&p, "mongo_tls_insecure"), Some("1"));
        assert!(!p.options.contains_key("unknownParam")); // 未知參數靜默忽略
        assert_eq!(p.database.as_deref(), Some("app"));
    }

    // ---- mysql / postgres SSL 參數 ----

    #[test]
    fn mysql_ssl_params_normalized_lowercase() {
        let p = parse("mysql://h/db?ssl-mode=VERIFY_CA&ssl-ca=C%3A%5Cca.pem");
        assert_eq!(opt(&p, "ssl_mode"), Some("verify_ca"));
        assert_eq!(opt(&p, "ssl_ca"), Some("C:\\ca.pem"));
        // 容錯無連字號寫法。
        let p2 = parse("mysql://h/db?sslmode=REQUIRED");
        assert_eq!(opt(&p2, "ssl_mode"), Some("required"));
    }

    #[test]
    fn postgres_sslrootcert_maps_to_ssl_ca() {
        let p = parse("postgres://h/db?sslmode=verify-full&sslrootcert=/etc/ca.pem");
        assert_eq!(opt(&p, "ssl_mode"), Some("verify-full")); // 直通不改寫
        assert_eq!(opt(&p, "ssl_ca"), Some("/etc/ca.pem"));
    }

    // ---- ADO.NET / JDBC（mssql）----

    #[test]
    fn ado_net_connection_string() {
        let p = parse(
            "Server=tcp:db.example.com,1433;Database=mydb;User ID=sa;Password=p@ss;\
             Encrypt=True;TrustServerCertificate=true",
        );
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("db.example.com"));
        assert_eq!(p.port, Some(1433));
        assert_eq!(p.database.as_deref(), Some("mydb"));
        assert_eq!(p.username.as_deref(), Some("sa"));
        assert_eq!(p.password.as_deref(), Some("p@ss")); // ADO 值為字面值，不 pct-decode
        assert_eq!(opt(&p, "encrypt"), Some("true"));
        assert_eq!(opt(&p, "trust_server_certificate"), Some("true"));
    }

    #[test]
    fn ado_net_alternate_keys() {
        let p = parse("Data Source=host2;Initial Catalog=cat;UID=u;PWD=pw;Encrypt=no");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("host2"));
        assert_eq!(p.database.as_deref(), Some("cat"));
        assert_eq!(p.username.as_deref(), Some("u"));
        assert_eq!(p.password.as_deref(), Some("pw"));
        assert_eq!(opt(&p, "encrypt"), Some("false"));
    }

    #[test]
    fn jdbc_sqlserver_prefix_stripped() {
        let p = parse("jdbc:sqlserver://host:1433;databaseName=db;encrypt=false");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("host"));
        assert_eq!(p.port, Some(1433));
        assert_eq!(p.database.as_deref(), Some("db"));
        assert_eq!(opt(&p, "encrypt"), Some("false"));
    }

    #[test]
    fn sqlserver_semicolon_params() {
        let p = parse("sqlserver://host;database=x;encrypt=true");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("host"));
        assert_eq!(p.database.as_deref(), Some("x"));
        assert_eq!(opt(&p, "encrypt"), Some("true"));
    }

    #[test]
    fn mssql_query_params() {
        let p = parse("mssql://sa:pw@h:1433?database=mydb&encrypt=true&trustServerCertificate=true");
        assert_eq!(p.database.as_deref(), Some("mydb"));
        assert_eq!(opt(&p, "encrypt"), Some("true"));
        assert_eq!(opt(&p, "trust_server_certificate"), Some("true"));
    }

    #[test]
    fn mssql_password_with_semicolon_survives() {
        // 密碼含 `;x=1`：分號參數切割須在 userinfo 抽出之後，否則 host 會被截成 "sa"（回歸）。
        let p = parse("mssql://sa:pa;x=1@dbhost/mydb");
        assert_eq!(p.host.as_deref(), Some("dbhost"));
        assert_eq!(p.username.as_deref(), Some("sa"));
        assert_eq!(p.password.as_deref(), Some("pa;x=1"));
        assert_eq!(p.database.as_deref(), Some("mydb"));
    }

    // ---- 誤判防呆 ----

    #[test]
    fn non_ado_semicolon_text_not_misclassified() {
        // Kafka properties / 含分號的檔案路徑：有 `;`+`=` 但無 ADO 識別鍵 → 不判成 MSSQL。
        assert_eq!(
            parse_url("bootstrap.servers=h:9092;security.protocol=SSL", None).unwrap().kind,
            None
        );
        assert_eq!(parse_url("C:\\data\\app;ver=2.db", None).unwrap().kind, None);
        // 反例：含 Server= 識別鍵仍正確判為 MSSQL。
        assert_eq!(
            parse_url("Server=h;Integrated Security=true", None).unwrap().kind,
            Some(DbKind::Mssql)
        );
    }

    #[test]
    fn jdbc_non_sqlserver_dialect_rejected() {
        // jdbc: 只支援 sqlserver；oracle thin 等剝殼後會亂解析，須明確報錯。
        let err = parse_url("jdbc:oracle:thin:@//dbhost:1521/XEPDB1", None).unwrap_err();
        assert!(err.message().contains("jdbc:oracle"), "錯誤應含 dialect：{}", err.message());
        assert!(parse_url("jdbc:postgresql://h/db", None).is_err());
    }

    #[test]
    fn postgres_sslmode_normalized_lowercase() {
        // 大寫 sslmode（部分工具輸出）須正規化，否則前端 Select 無對應、driver 落到 Prefer。
        let p = parse("postgres://u:p@h:5432/db?sslmode=REQUIRE");
        assert_eq!(opt(&p, "ssl_mode"), Some("require"));
    }

    // ---- sqlite / 路徑不誤判 ----

    #[test]
    fn sqlite_scheme_forms() {
        assert_eq!(parse("sqlite:app.db").database.as_deref(), Some("app.db"));
        assert_eq!(
            parse("sqlite:///data/app.db").database.as_deref(),
            Some("/data/app.db")
        );
        // sqlite 路徑整段保留（? 不當 query 切）。
        assert_eq!(
            parse("sqlite:C:\\data\\app.db").database.as_deref(),
            Some("C:\\data\\app.db")
        );
    }

    #[test]
    fn windows_path_not_treated_as_scheme() {
        // `C:` 不在已知 scheme 清單 → 無 scheme；搭配 kind hint 時整段為檔案路徑。
        let p = parse_url("C:\\data\\app.db", Some(DbKind::Sqlite)).unwrap();
        assert_eq!(p.kind, Some(DbKind::Sqlite));
        assert_eq!(p.database.as_deref(), Some("C:\\data\\app.db"));
        // 無 hint：kind 判不出（不 Err、不誤判成其他 kind）。
        let p2 = parse_url("C:\\data\\app.db", None).unwrap();
        assert_eq!(p2.kind, None);
    }

    // ---- 未知 scheme ----

    #[test]
    fn unknown_scheme_errors_without_hint() {
        let err = parse_url("weird://h:1/x", None).unwrap_err();
        assert!(err.message().contains("weird"), "錯誤應含 scheme 名：{}", err.message());
        // 有 hint 時沿用 hint（CLI --kind 搭配非標準 URL 的行為不回歸）。
        let p = parse_url("weird://h:1/x", Some(DbKind::Mysql)).unwrap();
        assert_eq!(p.kind, Some(DbKind::Mysql));
        assert_eq!(p.host.as_deref(), Some("h"));
    }

    // ---- 其他回歸 ----

    #[test]
    fn bare_hostport_with_hint() {
        let p = parse_url("localhost:5433", Some(DbKind::Postgres)).unwrap();
        assert_eq!(p.kind, Some(DbKind::Postgres));
        assert_eq!(p.host.as_deref(), Some("localhost"));
        assert_eq!(p.port, Some(5433));
    }

    #[test]
    fn userinfo_without_password() {
        let p = parse("postgres://alice@h/db");
        assert_eq!(p.username.as_deref(), Some("alice"));
        assert_eq!(p.password, None);
    }
}
