//! 標準 URL / DSN 主體：`[user[:pass]@]host[:port][/db][?k=v&…][#fragment]`（scheme 已由
//! `parse_url` 切掉並解析成 kind）。
//!
//! 命名為 `standard` 而非 `url`：`parse_url` 內有同名的 `url` 區域變數，`url::` 路徑會讓人誤讀。

use crate::db::conn_url::params::{apply_query_param, parse_query_pairs, pct_decode, set_host_port};
use crate::db::conn_url::{kv, Parsed, SchemeFlags};
use crate::db::DbKind;

/// 解析 scheme 之後的餘下部分。不回 Err——scheme 層的錯誤（未知 scheme、不支援的 jdbc dialect）
/// 已在 `parse_url` 擋掉，這裡任何解不出的欄位一律留 None 交給呼叫端補預設。
pub(super) fn parse(kind: Option<DbKind>, flags: SchemeFlags, rest: String) -> Parsed {
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
            kv::apply_ado_pairs(&mut p, params.split(';'));
            hostport = head;
        }
    }

    set_host_port(&mut p, &hostport);

    // scheme 衍生選項：值格式沿用各 driver 現行讀法
    // （mongo.rs build_mongo_uri 讀 mongo_srv=="1"；redis.rs 讀 redis_tls=="true"）。
    if flags.srv {
        // SRV：port 由 DNS SRV 記錄決定，不填（即使使用者誤帶也忽略）。
        p.port = None;
        p.options.insert("mongo_srv".into(), "1".into());
    }
    // TLS 旗標的 options 鍵依 kind 而異（redis 系用 "true"、rabbitmq 用 "1"）。
    if flags.tls {
        match p.kind {
            Some(DbKind::Redis) => {
                p.options.insert("redis_tls".into(), "true".into());
            }
            Some(DbKind::RabbitMq) => {
                p.options.insert("rabbitmq_tls".into(), "1".into());
            }
            _ => {}
        }
    }
    // 本 app 的 redis TLS URL 方言：`#insecure` fragment（見 db/redis.rs）→ 略過憑證驗證。
    if matches!(p.kind, Some(DbKind::Redis)) && fragment.as_deref() == Some("insecure") {
        p.options.insert("redis_tls_insecure".into(), "true".into());
    }
    // RabbitMQ：URL path 段（database）為 vhost，改存 rabbitmq_vhost 供前端欄位還原
    // （CloudAMQP `amqps://user:pass@host/vhost`；vhost 常等於 username）。
    if matches!(p.kind, Some(DbKind::RabbitMq)) {
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

    p
}
