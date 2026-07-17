//! ConnectionConfig → AMQP URI 與 Management URL 映射。
//!
//! 非機密設定存於 `config.options`（`rabbitmq_*` 前綴，明文寫入 connections.json）；
//! AMQP / Management 帳密沿用 top-level `username` / `password`（後者由 keychain hydrate）。
//!
//! - AMQP：`amqp://user:pass@host:5672/vhost`；`rabbitmq_tls` → `amqps://…:5671`。
//!   userinfo 與 vhost 皆 percent-encode（vhost `/` → `%2F`）。
//! - Management：`rabbitmq_mgmt_url` 覆寫，否則 `http(s)://{host}:15672`（scheme 依 TLS）。

use crate::db::ConnectionConfig;

/// 讀取某個 `rabbitmq_*` option（去空白），不存在或空字串回 None。
fn opt<'a>(cfg: &'a ConnectionConfig, key: &str) -> Option<&'a str> {
    cfg.options.get(key).map(|s| s.trim()).filter(|s| !s.is_empty())
}

/// bool option（"1" / "true" 為真）。
fn opt_bool(cfg: &ConnectionConfig, key: &str) -> bool {
    matches!(opt(cfg, key), Some("1") | Some("true"))
}

/// 是否走 TLS（amqps / https mgmt）。
pub fn is_tls(cfg: &ConnectionConfig) -> bool {
    opt_bool(cfg, "rabbitmq_tls")
}

/// 主機（去空白；空則 localhost）。
fn host(cfg: &ConnectionConfig) -> &str {
    let h = cfg.host.trim();
    if h.is_empty() {
        "localhost"
    } else {
        h
    }
}

/// vhost：`rabbitmq_vhost` option 覆寫，否則 `database` 欄（連線字串 path 段落此），否則預設 `/`。
pub fn vhost(cfg: &ConnectionConfig) -> String {
    if let Some(v) = opt(cfg, "rabbitmq_vhost") {
        return v.to_string();
    }
    match cfg.database.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(db) => db.to_string(),
        None => "/".to_string(),
    }
}

/// percent-encode（RFC 3986 unreserved 之外全部編碼；`/` → `%2F`）。
/// 供 AMQP URI 的 userinfo / vhost 段與 Management REST 的 vhost / name 路徑段共用。
pub fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 組出 AMQP 連線 URI：`amqp[s]://[user[:pass]@]host:port/vhost`。
pub fn amqp_uri(cfg: &ConnectionConfig) -> String {
    let tls = is_tls(cfg);
    let scheme = if tls { "amqps" } else { "amqp" };
    let port = if cfg.port != 0 {
        cfg.port
    } else if tls {
        5671
    } else {
        5672
    };
    let mut auth = String::new();
    let user = cfg.username.trim();
    if !user.is_empty() {
        auth.push_str(&pct_encode(user));
        if !cfg.password.is_empty() {
            auth.push(':');
            auth.push_str(&pct_encode(&cfg.password));
        }
        auth.push('@');
    }
    format!(
        "{scheme}://{auth}{}:{port}/{}",
        host(cfg),
        pct_encode(&vhost(cfg))
    )
}

/// 組出 Management REST base URL：`rabbitmq_mgmt_url` 覆寫，否則 `http(s)://host:15672`。
pub fn mgmt_url(cfg: &ConnectionConfig) -> String {
    if let Some(u) = opt(cfg, "rabbitmq_mgmt_url") {
        return u.trim_end_matches('/').to_string();
    }
    let scheme = if is_tls(cfg) { "https" } else { "http" };
    format!("{scheme}://{}:15672", host(cfg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbKind;

    fn cfg() -> ConnectionConfig {
        ConnectionConfig {
            id: "t".into(),
            name: "t".into(),
            kind: DbKind::RabbitMq,
            host: "mq.example.com".into(),
            port: 0,
            username: "guest".into(),
            password: "guest".into(),
            database: None,
            max_connections: 5,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_username: String::new(),
            ssh_auth_method: Default::default(),
            ssh_password: String::new(),
            ssh_private_key_path: String::new(),
            ssh_passphrase: String::new(),
            options: Default::default(),
            otp_secret: String::new(),
        }
    }

    #[test]
    fn amqp_uri_default_vhost_encoded() {
        let c = cfg();
        // 預設 vhost "/" 須編碼成 %2F；預設 port 5672。
        assert_eq!(
            amqp_uri(&c),
            "amqp://guest:guest@mq.example.com:5672/%2F"
        );
    }

    #[test]
    fn amqp_uri_named_vhost_from_database() {
        let mut c = cfg();
        c.database = Some("prod".into());
        assert_eq!(
            amqp_uri(&c),
            "amqp://guest:guest@mq.example.com:5672/prod"
        );
    }

    #[test]
    fn amqp_uri_tls_uses_amqps_and_5671() {
        let mut c = cfg();
        c.options.insert("rabbitmq_tls".into(), "true".into());
        assert_eq!(
            amqp_uri(&c),
            "amqps://guest:guest@mq.example.com:5671/%2F"
        );
    }

    #[test]
    fn amqp_uri_percent_encodes_credentials() {
        let mut c = cfg();
        c.username = "us er".into();
        c.password = "p@ss/w:rd".into();
        assert_eq!(
            amqp_uri(&c),
            "amqp://us%20er:p%40ss%2Fw%3Ard@mq.example.com:5672/%2F"
        );
    }

    #[test]
    fn amqp_uri_no_userinfo_when_username_empty() {
        let mut c = cfg();
        c.username = String::new();
        c.password = String::new();
        assert_eq!(amqp_uri(&c), "amqp://mq.example.com:5672/%2F");
    }

    #[test]
    fn amqp_uri_explicit_port_wins() {
        let mut c = cfg();
        c.port = 5673;
        assert_eq!(
            amqp_uri(&c),
            "amqp://guest:guest@mq.example.com:5673/%2F"
        );
    }

    #[test]
    fn vhost_prefers_option_over_database() {
        let mut c = cfg();
        c.database = Some("fromdb".into());
        c.options.insert("rabbitmq_vhost".into(), "fromopt".into());
        assert_eq!(vhost(&c), "fromopt");
    }

    #[test]
    fn mgmt_url_default_and_override() {
        let mut c = cfg();
        assert_eq!(mgmt_url(&c), "http://mq.example.com:15672");
        c.options.insert("rabbitmq_tls".into(), "1".into());
        assert_eq!(mgmt_url(&c), "https://mq.example.com:15672");
        c.options
            .insert("rabbitmq_mgmt_url".into(), "http://proxy:8080/rmq/".into());
        assert_eq!(mgmt_url(&c), "http://proxy:8080/rmq");
    }

    #[test]
    fn pct_encode_slash_and_unreserved() {
        assert_eq!(pct_encode("/"), "%2F");
        assert_eq!(pct_encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(pct_encode("a/b"), "a%2Fb");
    }
}
