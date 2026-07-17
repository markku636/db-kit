//! ConnectionConfig → EsClient 參數（base URL / 認證 / TLS）。
//!
//! 非機密設定存於 `config.options`（`es_*` 前綴，明文寫入 connections.json）；
//! 認證帳密沿用 top-level `username` / `password`（後者由 keychain hydrate）。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use super::client::{EsAuth, EsClientParams};
use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};

/// 讀取某個 `es_*` option（去空白），不存在或空字串回 None。
fn opt<'a>(cfg: &'a ConnectionConfig, key: &str) -> Option<&'a str> {
    cfg.options.get(key).map(|s| s.trim()).filter(|s| !s.is_empty())
}

/// bool option（"1" / "true" 為真）。
fn opt_bool(cfg: &ConnectionConfig, key: &str) -> bool {
    matches!(opt(cfg, key), Some("1") | Some("true"))
}

/// 是否在索引清單顯示隱藏索引（`.` 開頭，如 `.kibana`）。預設隱藏。
pub fn show_hidden(cfg: &ConnectionConfig) -> bool {
    opt_bool(cfg, "es_show_hidden")
}

/// 解 Elastic Cloud 的 `cloud_id`：`name:base64(host$es_uuid$kibana_uuid)`。
///
/// 回傳 `(host, es_uuid)`，供組出 `https://{es_uuid}.{host}` 的叢集端點。
/// 格式不符（無 `:`、base64 解不開、欄位不足或缺 host/es_uuid）→ None。
pub fn decode_cloud_id(cloud_id: &str) -> Option<(String, String)> {
    let (_name, b64) = cloud_id.trim().split_once(':')?;
    let decoded = STANDARD.decode(b64.trim()).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let mut parts = text.split('$');
    let host = parts.next()?.trim();
    let es_uuid = parts.next()?.trim();
    if host.is_empty() || es_uuid.is_empty() {
        return None;
    }
    Some((host.to_string(), es_uuid.to_string()))
}

/// API key 編碼：Elasticsearch 的 `Authorization: ApiKey <value>` 需 base64(id:key)。
///
/// - 使用者填的值含 `:` 且**非**合法 base64 → 視為原始 `id:key`，自行 base64 編碼。
/// - 否則（不含 `:`，或已是合法 base64）→ 原樣當作已編碼值。
pub fn encode_api_key(raw: &str) -> String {
    let raw = raw.trim();
    if raw.contains(':') && STANDARD.decode(raw).is_err() {
        STANDARD.encode(raw)
    } else {
        raw.to_string()
    }
}

/// 由連線設定推導認證方式。
///
/// - `es_auth == "apikey"` → API key（金鑰材料取自 password，經 `encode_api_key`）。
/// - `es_auth == "none"` → 不帶認證。
/// - 其餘（含未設）：username 非空 → Basic；否則不帶認證。
fn build_auth(cfg: &ConnectionConfig) -> EsAuth {
    match opt(cfg, "es_auth") {
        Some("apikey") => EsAuth::ApiKey(encode_api_key(&cfg.password)),
        Some("none") => EsAuth::None,
        _ => {
            let user = cfg.username.trim();
            if user.is_empty() {
                EsAuth::None
            } else {
                EsAuth::Basic {
                    user: user.to_string(),
                    pass: cfg.password.clone(),
                }
            }
        }
    }
}

/// 組出叢集 base URL。
///
/// 優先序：
/// 1. `es_cloud_id` → `https://{es_uuid}.{host}`（Elastic Cloud）。
/// 2. host 以 `http://` / `https://` 開頭 → 整段當 base URL（忽略 port / es_tls）。
/// 3. 否則 `{scheme}://{host}:{port}`；scheme 依 `es_tls`，port 預設 9200。
fn build_base_url(cfg: &ConnectionConfig) -> AppResult<String> {
    if let Some(cloud_id) = opt(cfg, "es_cloud_id") {
        let (host, es_uuid) = decode_cloud_id(cloud_id).ok_or_else(|| {
            AppError::Connect(t!("Elastic Cloud cloud_id 格式無法解析").into())
        })?;
        return Ok(format!("https://{es_uuid}.{host}"));
    }
    let host = cfg.host.trim();
    if host.starts_with("http://") || host.starts_with("https://") {
        return Ok(host.trim_end_matches('/').to_string());
    }
    let scheme = if opt_bool(cfg, "es_tls") { "https" } else { "http" };
    let port = if cfg.port == 0 { 9200 } else { cfg.port };
    Ok(format!("{scheme}://{host}:{port}"))
}

/// 讀取 CA 憑證：option 值為 PEM 內文（含 BEGIN CERTIFICATE）直接用；否則視為檔案路徑讀取。
/// option 鍵 `es_ssl_ca` 與前端 ConnectionDialog / 設計契約一致。
fn build_ca_pem(cfg: &ConnectionConfig) -> AppResult<Option<Vec<u8>>> {
    let Some(v) = opt(cfg, "es_ssl_ca") else {
        return Ok(None);
    };
    if v.contains("BEGIN CERTIFICATE") {
        return Ok(Some(v.as_bytes().to_vec()));
    }
    // 視為檔案路徑。
    let bytes = std::fs::read(v)
        .map_err(|e| AppError::Connect(tf!("讀取 CA 憑證檔失敗：{e}", e = e)))?;
    Ok(Some(bytes))
}

/// 由連線設定組出 EsClient 建構參數。
pub fn build_params(cfg: &ConnectionConfig) -> AppResult<EsClientParams> {
    Ok(EsClientParams {
        base_url: build_base_url(cfg)?,
        auth: build_auth(cfg),
        ca_pem: build_ca_pem(cfg)?,
        // 鍵名 es_ssl_insecure 與前端 ConnectionDialog / 設計契約一致。
        insecure: opt_bool(cfg, "es_ssl_insecure"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    #[test]
    fn decode_cloud_id_extracts_host_and_es_uuid() {
        // name:base64("host$es_uuid$kibana_uuid")
        let inner = "us-central1.gcp.cloud.es.io$abc123deadbeef$kibana987";
        let encoded = STANDARD.encode(inner);
        let cloud_id = format!("my-deployment:{encoded}");
        let (host, es_uuid) = decode_cloud_id(&cloud_id).expect("should decode");
        assert_eq!(host, "us-central1.gcp.cloud.es.io");
        assert_eq!(es_uuid, "abc123deadbeef");
    }

    #[test]
    fn decode_cloud_id_without_kibana_uuid_ok() {
        let inner = "example.com$es_uuid_only";
        let encoded = STANDARD.encode(inner);
        let cloud_id = format!("dep:{encoded}");
        let got = decode_cloud_id(&cloud_id);
        assert_eq!(got, Some(("example.com".to_string(), "es_uuid_only".to_string())));
    }

    #[test]
    fn decode_cloud_id_rejects_malformed() {
        assert_eq!(decode_cloud_id("no-colon-here"), None);
        assert_eq!(decode_cloud_id("name:not-valid-base64!!!"), None);
        // base64 of a string without '$' separator → missing es_uuid.
        let one = STANDARD.encode("onlyhost");
        assert_eq!(decode_cloud_id(&format!("n:{one}")), None);
        // empty host.
        let emptyhost = STANDARD.encode("$es_uuid");
        assert_eq!(decode_cloud_id(&format!("n:{emptyhost}")), None);
    }

    #[test]
    fn encode_api_key_encodes_raw_id_key() {
        // "id:key" contains ':' and is not valid base64 → encode.
        let got = encode_api_key("myId:mySecretKey");
        assert_eq!(got, STANDARD.encode("myId:mySecretKey"));
    }

    #[test]
    fn encode_api_key_passes_through_already_encoded() {
        // A valid base64 value (no ':') is treated as already-encoded.
        let already = STANDARD.encode("someId:someKey");
        assert_eq!(encode_api_key(&already), already);
    }

    #[test]
    fn encode_api_key_passes_through_plain_token_without_colon() {
        // No ':' → returned as-is even if not base64-ish.
        assert_eq!(encode_api_key("plaintoken"), "plaintoken");
    }
}
