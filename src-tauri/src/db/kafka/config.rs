//! ConnectionConfig → rdkafka `ClientConfig` 映射（bootstrap / 安全協定 / SASL / TLS）。
//!
//! 非機密設定存於 `config.options`（`kafka_*` 前綴，明文寫入 connections.json）；
//! SASL 帳密沿用 top-level `username` / `password`（後者由 keychain hydrate）。

use rdkafka::ClientConfig;

use crate::db::ConnectionConfig;

/// 讀取某個 `kafka_*` option（去空白），不存在或空字串回 None。
fn opt<'a>(cfg: &'a ConnectionConfig, key: &str) -> Option<&'a str> {
    cfg.options.get(key).map(|s| s.trim()).filter(|s| !s.is_empty())
}

/// 由連線設定組出 bootstrap.servers 字串。
///
/// 規則（依序）：
/// 1. `options["kafka_bootstrap"]`（明確多 broker，如 `h1:9092,h2:9092`）
/// 2. 若 `host` 本身已含 `,` 或 `:`（使用者在「主機」欄直接填 broker 清單）→ 原樣使用
/// 3. 否則 `host:port`
pub fn bootstrap_servers(cfg: &ConnectionConfig) -> String {
    if let Some(b) = opt(cfg, "kafka_bootstrap") {
        return b.to_string();
    }
    let host = cfg.host.trim();
    if host.contains(',') || host.contains(':') {
        host.to_string()
    } else {
        format!("{}:{}", host, cfg.port)
    }
}

/// 是否顯示內部主題（`__consumer_offsets` 等）。預設隱藏。
pub fn show_internal(cfg: &ConnectionConfig) -> bool {
    matches!(opt(cfg, "kafka_show_internal"), Some("1") | Some("true"))
}

/// 若連線設定了 `kafka_sr_url`，建立 Schema Registry 用戶端。
/// SR 帳密目前存於 options（明文）；TODO：移至 keychain。
pub fn schema_registry(cfg: &ConnectionConfig) -> Option<super::schema::SchemaRegistry> {
    let url = opt(cfg, "kafka_sr_url")?;
    let user = opt(cfg, "kafka_sr_user").map(String::from);
    let pass = opt(cfg, "kafka_sr_password").map(String::from);
    super::schema::SchemaRegistry::new(url, user, pass).ok()
}

/// 建立共用的 `ClientConfig` 模板（給 admin / producer / consumer 各自 create）。
///
/// consumer 於分頁讀 / tail 時另覆寫 `group.id` 等；此模板提供連線與安全設定。
pub fn build_client_config(cfg: &ConnectionConfig) -> ClientConfig {
    let mut cc = ClientConfig::new();
    cc.set("bootstrap.servers", bootstrap_servers(cfg));
    cc.set("client.id", "db-kit");
    // 預設 group.id（僅 metadata / 非提交式 consumer 用；分頁讀與 tail 會覆寫成唯一值）。
    cc.set("group.id", "db-kit");

    let protocol = opt(cfg, "kafka_security_protocol").unwrap_or("PLAINTEXT");
    cc.set("security.protocol", protocol);

    if protocol.starts_with("SASL") {
        if let Some(mech) = opt(cfg, "kafka_sasl_mechanism") {
            cc.set("sasl.mechanism", mech);
        }
        if !cfg.username.trim().is_empty() {
            cc.set("sasl.username", cfg.username.trim());
        }
        if !cfg.password.is_empty() {
            cc.set("sasl.password", &cfg.password);
        }
    }

    // TLS 設定（僅在以 kafka-tls feature 建置、librdkafka 具 ssl 能力時於執行期生效；
    // 無 ssl 能力的建置若設 SSL/SASL_SSL 協定，會在 connect 時由 librdkafka 明確報錯）。
    if protocol.ends_with("SSL") {
        if let Some(ca) = opt(cfg, "kafka_ssl_ca") {
            cc.set("ssl.ca.location", ca);
        }
        if let Some(cert) = opt(cfg, "kafka_ssl_cert") {
            cc.set("ssl.certificate.location", cert);
        }
        if let Some(key) = opt(cfg, "kafka_ssl_key") {
            cc.set("ssl.key.location", key);
        }
        if matches!(opt(cfg, "kafka_ssl_insecure"), Some("1") | Some("true")) {
            cc.set("enable.ssl.certificate.verification", "false");
        }
    }

    cc
}
