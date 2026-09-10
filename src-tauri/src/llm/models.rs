//! 取模型清單：`GET {base}/models`。
//!
//! 兩家的形狀一樣（`{ "data": [{ "id": ... }] }`），Ollama 原生 API 則是 `{ "models": [{ "name": ... }] }`，
//! 兩種都收。抓不到就回空陣列 —— UI 退回手填模型名，不當成錯誤（很多自架端點根本沒有這支）。

use super::{LlmConfig, LlmKind};

const TIMEOUT_SECS: u64 = 10;

pub async fn list(http: &reqwest::Client, kind: LlmKind, base_url: Option<&str>) -> Vec<String> {
    let cfg = LlmConfig::resolve(kind, base_url, None);
    if cfg.base.is_empty() {
        return Vec::new();
    }
    let url = format!("{}/models", cfg.base);
    let mut req = http.get(&url).timeout(std::time::Duration::from_secs(TIMEOUT_SECS));
    if let Some(k) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
        req = req.header("authorization", format!("Bearer {k}"));
        if kind == LlmKind::Anthropic {
            req = req.header("x-api-key", k).header("anthropic-version", "2023-06-01");
        }
    }
    let Ok(resp) = req.send().await else { return Vec::new() };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(v) = resp.json::<serde_json::Value>().await else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    let arr = v.get("data").and_then(|d| d.as_array()).or_else(|| v.get("models").and_then(|d| d.as_array()));
    if let Some(items) = arr {
        for it in items {
            let id = it
                .get("id")
                .and_then(|i| i.as_str())
                .or_else(|| it.get("name").and_then(|n| n.as_str()))
                .unwrap_or("");
            if !id.is_empty() {
                out.push(id.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}
