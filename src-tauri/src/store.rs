//! 連線設定持久化 + OS keychain 加密。
//!
//! - 非 secret 欄位寫入 `<app_config_dir>/connections.json`（原子寫入：temp + rename）。
//! - 密碼 / SSH 密碼 / SSH passphrase 一律存進 OS keychain，永不落地磁碟、永不回傳前端。
//! - 連線時於後端從 keychain hydrate 回 `ConnectionConfig`。

use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::error::{AppError, AppResult};

const KEYCHAIN_SERVICE: &str = "db-kit";
const CONNECTIONS_FILE: &str = "connections.json";

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

// ---- 檔案讀寫 ----

fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(format!("無法取得設定目錄：{e}")))?;
    Ok(dir.join(CONNECTIONS_FILE))
}

async fn ensure_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(format!("無法取得設定目錄：{e}")))?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Storage(format!("建立設定目錄失敗：{e}")))?;
    Ok(dir)
}

/// 載入全部已存連線。檔案不存在或解析失敗都回空清單（優雅降級）。
pub async fn load_all(app: &AppHandle) -> AppResult<Vec<PersistedConnection>> {
    let path = config_path(app)?;
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
pub async fn save_all(app: &AppHandle, conns: &[PersistedConnection]) -> AppResult<()> {
    let dir = ensure_dir(app).await?;
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

pub async fn upsert(app: &AppHandle, conn: PersistedConnection) -> AppResult<()> {
    let mut all = load_all(app).await?;
    all.retain(|c| c.id != conn.id);
    all.push(conn);
    save_all(app, &all).await
}

// ---- 通用 JSON 讀寫（供排程器的 schedules.json / history.json 重用）----

/// 讀取 app config 目錄下的 JSON 檔。檔案不存在回 `T::default()`。
pub async fn read_json<T: DeserializeOwned + Default>(app: &AppHandle, file: &str) -> AppResult<T> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(format!("無法取得設定目錄：{e}")))?;
    let path = dir.join(file);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<T>(&bytes)
            .map_err(|e| AppError::Storage(format!("解析 {file} 失敗：{e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(AppError::Storage(format!("讀取 {file} 失敗：{e}"))),
    }
}

/// 原子寫入 app config 目錄下的 JSON 檔（temp + rename）。
pub async fn write_json<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> AppResult<()> {
    let dir = ensure_dir(app).await?;
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

pub async fn remove(app: &AppHandle, id: &str) -> AppResult<()> {
    let mut all = load_all(app).await?;
    let before = all.len();
    all.retain(|c| c.id != id);
    if all.len() != before {
        save_all(app, &all).await?;
    }
    Ok(())
}

/// 載入單一連線並補上密碼（供排程器 fire 時使用）。找不到回 `NotFound`。
pub async fn load_connection(app: &AppHandle, id: &str) -> AppResult<ConnectionConfig> {
    let all = load_all(app).await?;
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
