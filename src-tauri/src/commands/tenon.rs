//! Opt-in Tenon directory. Secrets stay in the OS credential store and native transport.
use super::AppState;
use crate::{
    error::{AppError, AppResult},
    rd::{rustdesk, sessions::RdSession},
    store,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, State};
const FILE: &str = "tenon.json";
static LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static ACTIVE: Lazy<parking_lot::Mutex<HashSet<String>>> = Lazy::new(Default::default);
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub url: String,
    pub auto_sync: bool,
    pub profile: String,
}
#[derive(Serialize)]
pub struct Status {
    pub config: Config,
    pub signed_in: bool,
}
fn err(message: impl Into<String>) -> AppError {
    AppError::Rd(message.into())
}
fn account(c: &Config) -> String {
    format!("tenon.{}", c.profile)
}
fn status(c: Config) -> Status {
    let signed_in = c.enabled && store::kc_get(&account(&c)).is_some();
    Status { config: c, signed_in }
}
pub fn normalize_url(s: &str) -> AppResult<String> {
    let u = reqwest::Url::parse(s.trim()).map_err(|_| err("請輸入有效的 Tenon HTTPS 網址"))?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || !matches!(u.path(), "" | "/")
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err(err("Tenon 網址必須是 HTTPS，且不含帳密、路徑或查詢參數"));
    }
    Ok(u.as_str().trim_end_matches('/').to_owned())
}
fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| err("無法建立 Tenon 連線"))
}
async fn send(c: &Config, path: &str, token: Option<&str>, body: Option<Value>) -> AppResult<Value> {
    if !c.enabled {
        return Err(err("Tenon 整合尚未啟用"));
    }
    let url = format!("{}{path}", normalize_url(&c.url)?);
    let mut request = if let Some(body) = body { client()?.post(url).json(&body) } else { client()?.get(url) };
    if let Some(token) = token {
        request = request.bearer_auth(token)
    }
    let mut response = request.send().await.map_err(|_| err("連不到 Tenon，請確認網址、網路與 HTTPS 憑證"))?;
    let code = response.status();
    if code == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| err("讀取 Tenon 回應失敗"))? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err(err("Tenon 回應過大"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !code.is_success() {
        if code == reqwest::StatusCode::UNAUTHORIZED {
            store::kc_delete(&account(c));
        }
        let message = value["error"]
            .as_str()
            .filter(|s| s.len() < 512)
            .unwrap_or("Tenon 拒絕請求，請確認服務已啟用及帳號已獲授權");
        return Err(err(format!("{message} ({})", code.as_u16())));
    }
    if value.is_null() {
        return Err(err("Tenon 回應格式不正確"));
    }
    Ok(value)
}
async fn enabled(app: &AppHandle) -> AppResult<Config> {
    let c: Config = store::read_json(app, FILE).await?;
    if !c.enabled {
        return Err(err("Tenon 整合尚未啟用"));
    }
    normalize_url(&c.url)?;
    Ok(c)
}
fn credential(c: &Config) -> AppResult<String> {
    store::kc_get(&account(c)).filter(|s| !s.is_empty()).ok_or_else(|| err("請先登入 Tenon"))
}
async fn disconnect(state: &AppState) {
    let ids: Vec<_> = ACTIVE.lock().drain().collect();
    for id in ids {
        state.rd.disconnect(&id).await;
        if let Some(files) = state.rd.remove_files(&id) {
            files.shutdown().await;
        }
    }
}
#[tauri::command]
pub async fn tenon_status(app: AppHandle) -> AppResult<Status> {
    let _guard = LOCK.lock().await;
    Ok(status(store::read_json(&app, FILE).await?))
}
#[tauri::command]
pub async fn tenon_config_set(app: AppHandle, state: State<'_, AppState>, mut config: Config) -> AppResult<Status> {
    let _guard = LOCK.lock().await;
    if config.enabled {
        config.url = normalize_url(&config.url)?;
    } else {
        config.url = normalize_url(&config.url).unwrap_or_default();
    }
    let old: Config = store::read_json(&app, FILE).await?;
    if old.enabled != config.enabled || old.url != config.url {
        disconnect(&state).await;
        if old.enabled {
            if let Ok(token) = credential(&old) {
                let _ = send(&old, "/api/dbkit/logout", Some(&token), Some(json!({}))).await;
            }
        }
        store::kc_delete(&account(&old));
        config.profile = uuid::Uuid::new_v4().to_string();
    } else {
        config.profile = old.profile;
    }
    if !config.enabled {
        config.auto_sync = false;
    }
    store::write_json(&app, FILE, &config).await?;
    Ok(status(config))
}
#[tauri::command]
pub async fn tenon_login(
    app: AppHandle,
    state: State<'_, AppState>,
    username: String,
    password: String,
    code: String,
) -> AppResult<Status> {
    let _guard = LOCK.lock().await;
    let mut c = enabled(&app).await?;
    disconnect(&state).await;
    if let Ok(token) = credential(&c) {
        let _ = send(&c, "/api/dbkit/logout", Some(&token), Some(json!({}))).await;
    }
    store::kc_delete(&account(&c));
    c.profile = uuid::Uuid::new_v4().to_string();
    store::write_json(&app, FILE, &c).await?;
    let v =
        send(&c, "/api/dbkit/login", None, Some(json!({"username":username,"password":password,"code":code}))).await?;
    let token = v["token"]
        .as_str()
        .filter(|s| s.starts_with("dbk_") && s.len() < 256)
        .ok_or_else(|| err("Tenon 未回傳有效登入憑證"))?;
    if let Err(e) = store::kc_set(&account(&c), token) {
        let _ = send(&c, "/api/dbkit/logout", Some(token), Some(json!({}))).await;
        return Err(e);
    }
    Ok(status(c))
}
#[tauri::command]
pub async fn tenon_logout(app: AppHandle, state: State<'_, AppState>) -> AppResult<Status> {
    let _guard = LOCK.lock().await;
    let mut c: Config = store::read_json(&app, FILE).await?;
    disconnect(&state).await;
    let result = if c.enabled {
        if let Ok(token) = credential(&c) {
            send(&c, "/api/dbkit/logout", Some(&token), Some(json!({}))).await.map(|_| ())
        } else {
            Ok(())
        }
    } else {
        Ok(())
    };
    store::kc_delete(&account(&c));
    c.profile = uuid::Uuid::new_v4().to_string();
    store::write_json(&app, FILE, &c).await?;
    result.map_err(|_| err("本機已登出並中斷連線；伺服器撤銷失敗，請管理者撤銷登入或等待 24 小時到期"))?;
    Ok(status(c))
}
#[tauri::command]
pub async fn tenon_directory(app: AppHandle) -> AppResult<Value> {
    let _guard = LOCK.lock().await;
    let c = enabled(&app).await?;
    send(&c, "/api/dbkit/directory", Some(&credential(&c)?), None).await
}
pub fn managed(s: &RdSession) -> bool {
    s.options.ui.contains_key("tenon_profile")
}
pub async fn connection_guard(s: &RdSession) -> Option<tokio::sync::MutexGuard<'static, ()>> {
    if managed(s) {
        Some(LOCK.lock().await)
    } else {
        None
    }
}
pub async fn verify(app: &AppHandle, s: &RdSession) -> AppResult<()> {
    if !managed(s) {
        return Ok(());
    }
    let c = enabled(app).await?;
    if s.options.ui.get("tenon_profile") != Some(&c.profile) {
        return Err(err("Tenon 設定或登入已變更，請從目錄重新開啟裝置"));
    }
    credential(&c)?;
    Ok(())
}
pub async fn ticket(app: &AppHandle, s: &RdSession, conn_id: &str) -> AppResult<rustdesk::Rendezvous> {
    let _guard = LOCK.lock().await;
    verify(app, s).await?;
    let c = enabled(app).await?;
    let v = send(&c, "/api/dbkit/ticket", Some(&credential(&c)?), Some(json!({"id":s.host}))).await?;
    let ticket =
        v["ticket"].as_str().filter(|s| s.len() <= 128 && !s.is_empty()).ok_or_else(|| err("Tenon 未回傳連線授權"))?;
    let key = v["server_key"]
        .as_str()
        .filter(|s| s.len() <= 256 && !s.is_empty())
        .ok_or_else(|| err("Tenon 未回傳伺服器公鑰"))?;
    ACTIVE.lock().insert(conn_id.to_owned());
    // Old helpers that don't understand `tenon` must fail, never fall back to a public ID server.
    Ok(rustdesk::Rendezvous {
        server: "tenon-authenticated.invalid:0".into(),
        key: key.into(),
        tenon: Some(rustdesk::TenonTransport {
            url: format!("{}/api/dbkit/ws", c.url.replacen("https://", "wss://", 1)),
            ticket: ticket.into(),
        }),
        ..Default::default()
    })
}
pub fn forget(id: &str) {
    ACTIVE.lock().remove(id);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_and_https_only() {
        assert!(!Config::default().enabled);
        assert!(!Config::default().auto_sync);
        for url in [
            "http://localhost",
            "https://user:secret@example.com",
            "https://example.com/path",
            "https://example.com?token=secret",
            "https://example.com#x",
        ] {
            assert!(normalize_url(url).is_err(), "{url}");
        }
        assert_eq!(normalize_url(" https://example.com/ ").unwrap(), "https://example.com");
    }
}
