//! 連線設定持久化 + OS keychain 加密。
//!
//! - 非 secret 欄位寫入 `<app_config_dir>/connections.json`（原子寫入：temp + rename）。
//! - 密碼 / SSH 密碼 / SSH passphrase 一律存進 OS keychain，永不落地磁碟、永不回傳前端。
//! - 連線時於後端從 keychain hydrate 回 `ConnectionConfig`。
//!
//! 路徑解析分兩條：GUI 透過 Tauri 的 `AppHandle::app_config_dir()`（gated `gui` feature）；
//! CLI / headless 透過 `headless_config_dir()`（`dirs::config_dir()/<identifier>`）。兩者指向
//! 同一目錄與同一 keychain service，故 CLI 與 GUI 共用同一份連線設定。實際 IO 收斂到 `*_in`
//! 內層函式（吃 `&Path`），AppHandle 版本只是薄轉接。

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
#[cfg(feature = "gui")]
use tauri::{AppHandle, Manager};

use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::error::{AppError, AppResult};

const KEYCHAIN_SERVICE: &str = "db-kit";
const CONNECTIONS_FILE: &str = "connections.json";

/// App 層級設定檔名（非連線設定）。目前僅存啟動密碼的 Argon2 雜湊，未來可擴充其他全域偏好。
pub const APP_SETTINGS_FILE: &str = "app_settings.json";

/// App 全域設定（磁碟格式，`read_json` / `write_json` 讀寫）。
///
/// `startup_password_hash` 存的是 **Argon2id PHC 字串**（含參數 + salt），不是明文密碼——
/// 單向雜湊，磁碟外洩也無法還原密碼。用途是「啟動閘門」：擋別人打開 GUI，
/// **不加密連線機密**（機密仍在 OS keychain，`dbk` CLI 不受影響）。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub startup_password_hash: Option<String>,
}

/// 連線設定檔（磁碟格式）。
#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionsFile {
    #[serde(default = "schema_v1")]
    pub version: u32,
    #[serde(default)]
    pub connections: Vec<PersistedConnection>,
}

fn schema_v1() -> u32 {
    1
}

impl Default for ConnectionsFile {
    fn default() -> Self {
        Self {
            version: 1,
            connections: Vec::new(),
        }
    }
}

/// 存到磁碟的連線設定 — 刻意不含任何 secret（密碼 / passphrase 一律進 keychain）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedConnection {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default = "default_max_conns_pub")]
    pub max_connections: u32,

    // SSH（非 secret）
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default)]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_username: String,
    #[serde(default)]
    pub ssh_auth_method: SshAuthMethod,
    #[serde(default)]
    pub ssh_private_key_path: String,
    /// 外部 gateway 驅動的非機密設定（driver / base_url / env …）。
    #[serde(default)]
    pub options: std::collections::BTreeMap<String, String>,
}

fn default_max_conns_pub() -> u32 {
    5
}

impl From<&ConnectionConfig> for PersistedConnection {
    fn from(c: &ConnectionConfig) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            kind: c.kind,
            host: c.host.clone(),
            port: c.port,
            username: c.username.clone(),
            database: c.database.clone(),
            max_connections: c.max_connections,
            ssh_enabled: c.ssh_enabled,
            ssh_host: c.ssh_host.clone(),
            ssh_port: c.ssh_port,
            ssh_username: c.ssh_username.clone(),
            ssh_auth_method: c.ssh_auth_method,
            ssh_private_key_path: c.ssh_private_key_path.clone(),
            options: c.options.clone(),
        }
    }
}

impl PersistedConnection {
    /// 組回 `ConnectionConfig`，secret 欄位先留空（由 keychain hydrate 補）。
    pub fn to_config(&self) -> ConnectionConfig {
        ConnectionConfig {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind,
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            password: String::new(),
            database: self.database.clone(),
            max_connections: self.max_connections,
            ssh_enabled: self.ssh_enabled,
            ssh_host: self.ssh_host.clone(),
            ssh_port: self.ssh_port,
            ssh_username: self.ssh_username.clone(),
            ssh_auth_method: self.ssh_auth_method,
            ssh_password: String::new(),
            ssh_private_key_path: self.ssh_private_key_path.clone(),
            ssh_passphrase: String::new(),
            options: self.options.clone(),
            otp_secret: String::new(),
        }
    }
}

// ---- 設定目錄解析 ----

/// CLI / headless 模式的設定目錄：與 Tauri 的 `app_config_dir()` 同路徑
/// （`dirs::config_dir()/<identifier>`），讓 CLI 與 GUI 共用同一份 connections.json + keychain。
/// identifier 取自 `tauri.conf.json`（`dev.dbkit.app`），變更時需同步此處。
pub fn headless_config_dir() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Storage("無法取得使用者設定目錄".into()))?;
    Ok(base.join("dev.dbkit.app"))
}

#[cfg(feature = "gui")]
fn app_config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(format!("無法取得設定目錄：{e}")))
}

// ---- 檔案讀寫（path-based 內層，GUI 與 CLI 共用）----

async fn ensure_dir_at(dir: &Path) -> AppResult<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::Storage(format!("建立設定目錄失敗：{e}")))
}

/// 載入全部已存連線。檔案不存在或解析失敗都回空清單（優雅降級）。
pub async fn load_all_in(dir: &Path) -> AppResult<Vec<PersistedConnection>> {
    let path = dir.join(CONNECTIONS_FILE);
    match tokio::fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice::<ConnectionsFile>(&bytes) {
            Ok(f) => Ok(f.connections),
            Err(e) => {
                eprintln!("[store] connections.json 解析失敗，忽略：{e}");
                Ok(Vec::new())
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(AppError::Storage(format!("讀取連線設定失敗：{e}"))),
    }
}

/// 原子寫入：先寫 `.tmp` 再 rename，避免中途崩潰損毀檔案。
pub async fn save_all_in(dir: &Path, conns: &[PersistedConnection]) -> AppResult<()> {
    ensure_dir_at(dir).await?;
    let path = dir.join(CONNECTIONS_FILE);
    let tmp = dir.join(format!("{CONNECTIONS_FILE}.tmp"));
    let file = ConnectionsFile {
        version: 1,
        connections: conns.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|e| AppError::Storage(format!("序列化連線設定失敗：{e}")))?;
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| AppError::Storage(format!("寫入連線設定失敗：{e}")))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| AppError::Storage(format!("更新連線設定失敗：{e}")))?;
    Ok(())
}

pub async fn upsert_in(dir: &Path, conn: PersistedConnection) -> AppResult<()> {
    let mut all = load_all_in(dir).await?;
    all.retain(|c| c.id != conn.id);
    all.push(conn);
    save_all_in(dir, &all).await
}

/// 讀取設定目錄下的 JSON 檔。檔案不存在回 `T::default()`。
pub async fn read_json_in<T: DeserializeOwned + Default>(dir: &Path, file: &str) -> AppResult<T> {
    let path = dir.join(file);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<T>(&bytes)
            .map_err(|e| AppError::Storage(format!("解析 {file} 失敗：{e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(AppError::Storage(format!("讀取 {file} 失敗：{e}"))),
    }
}

/// 原子寫入設定目錄下的 JSON 檔（temp + rename）。
pub async fn write_json_in<T: Serialize>(dir: &Path, file: &str, value: &T) -> AppResult<()> {
    ensure_dir_at(dir).await?;
    let path = dir.join(file);
    let tmp = dir.join(format!("{file}.tmp"));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Storage(format!("序列化 {file} 失敗：{e}")))?;
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| AppError::Storage(format!("寫入 {file} 失敗：{e}")))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| AppError::Storage(format!("更新 {file} 失敗：{e}")))?;
    Ok(())
}

pub async fn remove_in(dir: &Path, id: &str) -> AppResult<()> {
    let mut all = load_all_in(dir).await?;
    let before = all.len();
    all.retain(|c| c.id != id);
    if all.len() != before {
        save_all_in(dir, &all).await?;
    }
    Ok(())
}

/// 載入單一連線並補上密碼（從 keychain hydrate）。找不到回 `NotFound`。
pub async fn load_connection_in(dir: &Path, id: &str) -> AppResult<ConnectionConfig> {
    let all = load_all_in(dir).await?;
    let p = all
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::NotFound(id.to_string()))?;
    let mut cfg = p.to_config();
    cfg.password = kc_get(id).unwrap_or_default();
    cfg.otp_secret = kc_get(&otp_account(id)).unwrap_or_default();
    if cfg.ssh_enabled {
        cfg.ssh_password = kc_get(&ssh_account(id)).unwrap_or_default();
        cfg.ssh_passphrase = kc_get(&ssh_passphrase_account(id)).unwrap_or_default();
    }
    Ok(cfg)
}

// ---- AppHandle 薄轉接（GUI 專用）----

#[cfg(feature = "gui")]
pub async fn load_all(app: &AppHandle) -> AppResult<Vec<PersistedConnection>> {
    load_all_in(&app_config_dir(app)?).await
}

#[cfg(feature = "gui")]
pub async fn upsert(app: &AppHandle, conn: PersistedConnection) -> AppResult<()> {
    upsert_in(&app_config_dir(app)?, conn).await
}

#[cfg(feature = "gui")]
pub async fn read_json<T: DeserializeOwned + Default>(app: &AppHandle, file: &str) -> AppResult<T> {
    read_json_in(&app_config_dir(app)?, file).await
}

#[cfg(feature = "gui")]
pub async fn write_json<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> AppResult<()> {
    write_json_in(&app_config_dir(app)?, file, value).await
}

#[cfg(feature = "gui")]
pub async fn remove(app: &AppHandle, id: &str) -> AppResult<()> {
    remove_in(&app_config_dir(app)?, id).await
}

/// 載入單一連線並補上密碼（供排程器 fire 時使用）。找不到回 `NotFound`。
#[cfg(feature = "gui")]
pub async fn load_connection(app: &AppHandle, id: &str) -> AppResult<ConnectionConfig> {
    load_connection_in(&app_config_dir(app)?, id).await
}

// ---- keychain ----

pub fn ssh_account(id: &str) -> String {
    format!("{id}.ssh")
}

pub fn ssh_passphrase_account(id: &str) -> String {
    format!("{id}.ssh-passphrase")
}

/// 外部 gateway 驅動的 OTP secret keychain account。
pub fn otp_account(id: &str) -> String {
    format!("{id}.otp")
}

/// 寫入 keychain。secret 為空字串時視為「刪除該項」。
pub fn kc_set(account: &str, secret: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| AppError::Storage(format!("keychain 開啟失敗：{e}")))?;
    if secret.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry
        .set_password(secret)
        .map_err(|e| AppError::Storage(format!("keychain 寫入失敗：{e}")))?;
    Ok(())
}

/// 讀取 keychain。不存在或任何錯誤都回 None（不洩漏 secret，僅記 account）。
pub fn kc_get(account: &str) -> Option<String> {
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[store] keychain 開啟失敗 ({account})：{e}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(p) => Some(p),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            eprintln!("[store] keychain 讀取失敗 ({account})：{e}");
            None
        }
    }
}

pub fn kc_delete(account: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        let _ = entry.delete_credential();
    }
}
