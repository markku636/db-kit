//! 廠商專屬方言：Oracle（JDBC thin / EZConnect / TNS descriptor）、
//! Elasticsearch（http(s) URL / Elastic Cloud ID）、Kafka（client properties 區塊）。
//!
//! 這些格式的共同點是「不是標準 URL，且各家語法自成一套」，硬塞進 `standard` 只會把它的
//! 單一流程炸成一堆 if。每個 `try_*` 偵測不到就回 None，由 `parse_url` 往下一個偵測器落。
//!
//! 只發各 driver 真的會讀、**且前端表單有對應欄位**的 options 鍵——前端 `buildOptions`
//! 每次存檔都重建整個 options 物件，沒有表單 state 的鍵會被靜默丟棄（見模組 doc）。

use crate::db::conn_url::kv::{tokenize, Sep};
use crate::db::conn_url::params::{falsy, pct_decode, set_host_port};
use crate::db::conn_url::{decode_cloud_id, Parsed};
use crate::db::DbKind;

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

/// `jdbc:oracle:thin:@…` / `jdbc:oracle:oci:@…`。呼叫端已剝掉 `jdbc:` 並確認 dialect 是 oracle，
/// 故傳入的是 `oracle:thin:@…`。driver 型別（thin / oci）對本 app 無差別，只取 `@` 之後的目標。
pub(super) fn try_jdbc_oracle(after_jdbc: &str) -> Option<Parsed> {
    let target = after_jdbc.split_once('@')?.1.trim();
    if target.is_empty() {
        return None;
    }
    Some(parse_oracle_target(target))
}

/// Oracle 連線目標的四種寫法（`connect_type` 的值對齊 oracle.rs:124 的讀法）：
/// - `//host:port/service` 或 `host:port/service` → service name；**不發** `connect_type`
///   （service 是預設值，對齊前端 buildOptions 的「service 時省略」）
/// - `host:port:SID` → `connect_type=sid`
/// - `(DESCRIPTION=…)` → 解 descriptor
/// - 其餘單一 token → TNS 別名（`connect_type=tns`）
pub(super) fn parse_oracle_target(target: &str) -> Parsed {
    let t = target.trim();
    if let Some(p) = try_tns(t) {
        return p;
    }

    let mut p = Parsed {
        kind: Some(DbKind::Oracle),
        ..Default::default()
    };
    let body = t.strip_prefix("//").unwrap_or(t);

    // EZConnect：`host[:port]/service`
    if let Some((hostport, service)) = body.split_once('/') {
        set_host_port(&mut p, hostport);
        let service = service.trim();
        if !service.is_empty() {
            p.database = Some(service.to_string());
        }
        return p;
    }

    let segs: Vec<&str> = body.split(':').collect();
    match segs.as_slice() {
        // `host:port:SID`（JDBC thin 的舊式寫法）
        [host, port, sid] if !host.is_empty() => {
            p.host = Some(host.to_string());
            p.port = port.parse::<u16>().ok();
            let sid = sid.trim();
            if !sid.is_empty() {
                p.database = Some(sid.to_string());
                p.options.insert("connect_type".into(), "sid".into());
            }
            p
        }
        // `host:port` —— 只有位址、沒有服務名（使用者得自己補）
        [host, port] if !host.is_empty() && port.parse::<u16>().is_ok() => {
            set_host_port(&mut p, body);
            p
        }
        // 單一 token（也可能是 `host` 而非別名，但 Oracle 慣例上 `@NAME` 就是 TNS 別名）
        _ => tns_alias(body),
    }
}

fn tns_alias(alias: &str) -> Parsed {
    let mut p = Parsed {
        kind: Some(DbKind::Oracle),
        ..Default::default()
    };
    p.database = Some(alias.trim().to_string());
    p.options.insert("connect_type".into(), "tns".into());
    p
}

/// 看起來是 TNS descriptor 就一定給出結果：解得出 HOST 就填欄位，解不出就整段當 TNS 別名。
///
/// 「解不開也能用」是刻意的——descriptor 字串本身就是合法的連線目標，oracle.rs 的 tns 分支
/// （`"tns" => Ok(target)`）會把 database 原樣交給 driver，不必先解析成功。
pub(super) fn try_tns(s: &str) -> Option<Parsed> {
    let t = s.trim();
    if !t.starts_with('(') || !t.to_ascii_uppercase().contains("(DESCRIPTION") {
        return None;
    }
    Some(parse_tns_descriptor(t).unwrap_or_else(|| tns_alias(t)))
}

/// TNS descriptor：
/// `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=s)))`
///
/// 只取**第一組** ADDRESS 的 HOST / PORT（多位址的 failover 清單本 app 無欄位可存），
/// 以及 CONNECT_DATA 的 SERVICE_NAME 或 SID。抓不到 HOST → None（呼叫端 `try_tns` 會退回別名）。
fn parse_tns_descriptor(s: &str) -> Option<Parsed> {
    let upper = s.to_ascii_uppercase();
    if !upper.contains("(DESCRIPTION") {
        return None;
    }
    let host = paren_value(&upper, s, "HOST")?;
    let mut p = Parsed {
        kind: Some(DbKind::Oracle),
        host: Some(host),
        ..Default::default()
    };
    p.port = paren_value(&upper, s, "PORT").and_then(|v| v.parse::<u16>().ok());
    if let Some(svc) = paren_value(&upper, s, "SERVICE_NAME") {
        p.database = Some(svc);
    } else if let Some(sid) = paren_value(&upper, s, "SID") {
        p.database = Some(sid);
        p.options.insert("connect_type".into(), "sid".into());
    }
    Some(p)
}

/// 從 `(KEY=value)` 取出 value：key 比對用全大寫版 `upper`，取值則回原始 `orig` 以保留大小寫。
/// 兩者索引可互通——`to_ascii_uppercase` 只動 ASCII，不改變位元組長度。
fn paren_value(upper: &str, orig: &str, key: &str) -> Option<String> {
    let needle = format!("({key}=");
    let at = upper.find(&needle)?;
    let start = at + needle.len();
    let end = orig[start..].find(')')? + start;
    let v = orig[start..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

// ---------------------------------------------------------------------------
// Elasticsearch / OpenSearch
// ---------------------------------------------------------------------------

/// `http(s)://[user[:pass]@]host[:port][/path]` → Elasticsearch / OpenSearch。
///
/// `host` 刻意存**完整 URL**（去掉 userinfo 與尾斜線）：elastic/config.rs 的 `build_base_url`
/// 對開頭是 `http(s)://` 的 host 原樣採用並忽略 port 與 es_tls，前端的 `esHostIsUrl` 也走同一套
/// 慣例（連 Cloud ID 展開後填的都是完整 URL）。因此：
/// - **不發** `es_tls`（scheme 已在 host 裡，前端也會因 esHostIsUrl 短路而丟掉）
/// - `database` 一律 None（elastic 是 noDatabase）
/// - `es_auth` **只在 URL 真的帶帳密時**才發 `basic`；沒帶就不發。發 `"none"` 會害使用者
///   之後手動補的帳密被 `build()` 的 usesAuth 判定為不需認證而清空存檔。
pub(super) fn parse_elastic_url(scheme: &str, rest: &str) -> Parsed {
    let mut p = Parsed {
        kind: Some(DbKind::Elastic),
        ..Default::default()
    };
    // fragment 對連線無意義；query 保留在 URL 內（雲端控制台複製的網址常帶參數，砍掉反而失真）。
    let body = rest.split('#').next().unwrap_or(rest);

    let (userinfo, hostpart) = match body.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, body),
    };
    if let Some(u) = userinfo {
        match u.split_once(':') {
            Some((user, pass)) => {
                p.username = Some(pct_decode(user));
                p.password = Some(pct_decode(pass));
            }
            None => p.username = Some(pct_decode(u)),
        }
        p.options.insert("es_auth".into(), "basic".into());
    }

    // port 純顯示用（driver 對完整 URL 的 host 會忽略它）；IPv6 的 `[::1]:9200` 也切得對。
    let hostonly = hostpart.split('/').next().unwrap_or(hostpart);
    if let Some((_, port)) = hostonly.rsplit_once(':') {
        p.port = port.parse::<u16>().ok();
    }
    p.host = Some(format!("{scheme}://{}", hostpart.trim_end_matches('/')));
    p
}

/// Elastic Cloud ID：`deployment-name:base64(host$es_uuid$kibana_uuid)`。
///
/// 判別依據是「右半段 base64 解得開、且解出來含 `$`」——一般的 `name:value` 解不開
/// （`app.db` 的 `.` 不在 base64 字母表內），所以誤判機率趨零。
pub(super) fn try_cloud_id(s: &str, hint: Option<DbKind>) -> Option<Parsed> {
    if !matches!(hint, None | Some(DbKind::Elastic)) {
        return None;
    }
    // 單一 token 且恰好一個 `:`（Cloud ID 不含空白，也不會有第二個冒號）。
    if s.contains("://") || s.split_whitespace().count() != 1 {
        return None;
    }
    let (name, b64) = s.split_once(':')?;
    if name.is_empty() || b64.contains(':') {
        return None;
    }
    let (host, es_uuid) = decode_cloud_id(s)?;
    Some(Parsed {
        kind: Some(DbKind::Elastic),
        host: Some(format!("https://{es_uuid}.{host}")),
        ..Default::default()
    })
}

// ---------------------------------------------------------------------------
// Kafka
// ---------------------------------------------------------------------------

/// Kafka client properties 的識別鍵（點號鍵與 libpq / ADO.NET 的鍵完全不重疊）。
const KAFKA_MARKERS: &[&str] = &[
    "bootstrap.servers",
    "metadata.broker.list",
    "security.protocol",
    "sasl.mechanism",
    "sasl.mechanisms",
    "sasl.jaas.config",
];

/// Confluent Cloud / Kafka client properties 區塊（換行或 `;` 分隔的 `key=value`）。
///
/// 只映射有表單欄位的鍵：protocol / mechanism / CA / 略過驗證，帳密走 top-level username /
/// password（SASL 帳密即連線帳密，見 kafka/config.rs）。`bootstrap.servers` 存進 `host`
/// 而非 `kafka_bootstrap`——後者沒有表單 state，存檔會被丟掉，而 kafka/config.rs 對含 `,`
/// 或 `:` 的 host 本來就原樣採用。
pub(super) fn try_kafka_properties(s: &str, hint: Option<DbKind>) -> Option<Parsed> {
    if !matches!(hint, None | Some(DbKind::Kafka)) {
        return None;
    }
    // properties 檔允許 `#` / `!` 開頭的註解行；tokenize 要求每段都是 key=value，先濾掉。
    let cleaned = s
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('!'))
        .collect::<Vec<_>>()
        .join("\n");
    let toks = tokenize(&cleaned, Sep::Semicolon)?;
    if !toks.iter().any(|(k, _)| KAFKA_MARKERS.contains(&k.as_str())) {
        return None;
    }

    let mut p = Parsed {
        kind: Some(DbKind::Kafka),
        ..Default::default()
    };
    for (k, v) in &toks {
        if v.is_empty() {
            continue;
        }
        match k.as_str() {
            "bootstrap.servers" | "metadata.broker.list" => p.host = Some(v.clone()),
            // 前端 Select 的值是大寫（PLAINTEXT / SASL_SSL…），kafka/config.rs 亦比大寫。
            "security.protocol" => {
                p.options
                    .insert("kafka_security_protocol".into(), v.to_ascii_uppercase());
            }
            "sasl.mechanism" | "sasl.mechanisms" => {
                p.options
                    .insert("kafka_sasl_mechanism".into(), v.to_ascii_uppercase());
            }
            "sasl.username" => p.username = Some(v.clone()),
            "sasl.password" => p.password = Some(v.clone()),
            // Java 客戶端把帳密包在 JAAS 設定字串裡。
            "sasl.jaas.config" => {
                if let Some(u) = jaas_field(v, "username") {
                    p.username = Some(u);
                }
                if let Some(pw) = jaas_field(v, "password") {
                    p.password = Some(pw);
                }
            }
            "ssl.ca.location" | "ssl.truststore.location" => {
                p.options.insert("kafka_ssl_ca".into(), v.clone());
            }
            "enable.ssl.certificate.verification" if falsy(v) => {
                p.options.insert("kafka_ssl_insecure".into(), "1".into());
            }
            _ => {}
        }
    }
    Some(p)
}

/// 從 JAAS 設定字串取出某個欄位：
/// `org.apache.kafka.common.security.plain.PlainLoginModule required username="K" password="S";`
///
/// 注意 `tokenize` 會把引號吃掉（引號內的 `;` 才不會被當分隔），所以到這裡多半已是
/// `… username=K password=S` 的形式；兩種都接。
fn jaas_field(v: &str, key: &str) -> Option<String> {
    let at = v.to_ascii_lowercase().find(key)?;
    let rest = v[at + key.len()..].trim_start().strip_prefix('=')?.trim_start();
    let val = match rest.strip_prefix('"') {
        Some(q) => q.split('"').next()?,
        None => rest.split([' ', ';', '\n']).next()?,
    };
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}
