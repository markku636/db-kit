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

/// App 層級設定檔名（非連線設定）。存啟動鎖定的設定與介面語言，未來可擴充其他全域偏好。
pub const APP_SETTINGS_FILE: &str = "app_settings.json";

/// App 全域設定（磁碟格式，`read_json` / `write_json` 讀寫）。
///
/// `startup_password_hash` 存的是 **Argon2id PHC 字串**（含參數 + salt），不是明文密碼——
/// 單向雜湊，磁碟外洩也無法還原密碼。用途是「啟動閘門」：擋別人打開 GUI，
/// **不加密連線機密**（機密仍在 OS keychain，`dbk` CLI 不受影響）。
///
/// `biometric_unlock` 與密碼**互相獨立**：任一啟用即進入鎖定狀態，兩個都開就是兩種解法。
/// 它只是一個布林旗標，不是金鑰 —— 這與整體安全模型一致（閘門，不是加密），
/// 能改這個檔的人本來就能把密碼雜湊一起刪掉。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub startup_password_hash: Option<String>,
    /// 介面語言碼（`"zh-TW"` / `"en"`）；GUI 與 dbk CLI 共用。舊檔無此欄 → `None`（走預設 zh-TW）。
    #[serde(default)]
    pub lang: Option<String>,
    /// 生物辨識解鎖（Windows Hello / Touch ID）是否啟用。舊檔無此欄 → `false`。
    #[serde(default)]
    pub biometric_unlock: bool,
    /// 閒置多久（分鐘）自動重新鎖定；`0` / 舊檔無此欄 = 關閉。
    ///
    /// 存在後端而非前端 localStorage：它是鎖定設定的一部分，跟著密碼雜湊一起走才不會出現
    /// 「換了設定檔但自動鎖定還留在舊機器的瀏覽器儲存區」這種半套狀態。
    #[serde(default)]
    pub auto_lock_minutes: u32,
}

/// 側欄連線群組。`id` 穩定不變（重新命名不影響歸屬），`name` 是顯示名稱。
///
/// 群組刻意做成獨立實體而非「從連線標籤推導」：空群組要能存在——先建群組再把連線拖進去，
/// 以及「刪除群組」才有意義（推導式的群組一沒成員就自己消失，談不上刪除）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnGroup {
    pub id: String,
    pub name: String,
}

/// 連線設定檔（磁碟格式）。
///
/// v1 → v2 只是加欄位（`groups` 與各連線的 `group_id`），兩邊都有 `#[serde(default)]`：
/// v1 舊檔讀進來就是「全部未分組」，不需要 migration。
#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionsFile {
    #[serde(default = "schema_v1")]
    pub version: u32,
    /// 側欄群組，陣列順序＝顯示順序。
    #[serde(default)]
    pub groups: Vec<ConnGroup>,
    #[serde(default)]
    pub connections: Vec<PersistedConnection>,
}

fn schema_v1() -> u32 {
    1
}

/// 寫檔用的 schema 版號。讀取仍接受 v1（缺 `groups` / `group_id` → 視為未分組）。
const SCHEMA_VERSION: u32 = 2;

impl Default for ConnectionsFile {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            groups: Vec::new(),
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
    /// 外部 gateway 驅動的非機密設定（driver / base_url …）。
    #[serde(default)]
    pub options: std::collections::BTreeMap<String, String>,
    /// 所屬側欄群組（`ConnGroup::id`）；`None` = 未分組。
    ///
    /// 刻意只存在磁碟層、不進 `ConnectionConfig`：分組純屬側欄排版，驅動與連線邏輯都不讀它。
    /// 因此「編輯連線」存檔（`upsert_in`）不會攜帶群組，由 `upsert_in` 保留既有值，
    /// 只有 `save_layout_in`（拖曳 / 群組操作）能改動。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
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
            // 群組不隨連線設定往返（見 group_id 欄位說明）；upsert_in 會補回既有值。
            group_id: None,
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
        .ok_or_else(|| AppError::Storage(t!("無法取得使用者設定目錄").into()))?;
    Ok(base.join("dev.dbkit.app"))
}

#[cfg(feature = "gui")]
pub fn app_config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(tf!("無法取得設定目錄：{e}", e = e)))
}

// ---- 檔案讀寫（path-based 內層，GUI 與 CLI 共用）----

async fn ensure_dir_at(dir: &Path) -> AppResult<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::Storage(tf!("建立設定目錄失敗：{e}", e = e)))
}

/// 載入全部已存連線。檔案不存在或解析失敗都回空清單（優雅降級）。
pub async fn load_all_in(dir: &Path) -> AppResult<Vec<PersistedConnection>> {
    Ok(load_file_in(dir).await?.connections)
}

/// 讀整份設定檔（連線 + 群組）。檔案不存在或解析失敗 → 空的預設值（與既有行為一致）。
pub async fn load_file_in(dir: &Path) -> AppResult<ConnectionsFile> {
    let path = dir.join(CONNECTIONS_FILE);
    match tokio::fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice::<ConnectionsFile>(&bytes) {
            Ok(f) => Ok(f),
            Err(e) => {
                eprintln!("[store] connections.json 解析失敗，忽略：{e}");
                Ok(ConnectionsFile::default())
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ConnectionsFile::default()),
        Err(e) => Err(AppError::Storage(tf!("讀取連線設定失敗：{e}", e = e))),
    }
}

/// 原子寫入整份設定檔：先寫 `.tmp` 再 rename，避免中途崩潰損毀檔案。
pub async fn save_file_in(dir: &Path, file: &ConnectionsFile) -> AppResult<()> {
    ensure_dir_at(dir).await?;
    let path = dir.join(CONNECTIONS_FILE);
    let tmp = dir.join(format!("{CONNECTIONS_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(file)
        .map_err(|e| AppError::Storage(tf!("序列化連線設定失敗：{e}", e = e)))?;
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| AppError::Storage(tf!("寫入連線設定失敗：{e}", e = e)))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| AppError::Storage(tf!("更新連線設定失敗：{e}", e = e)))?;
    Ok(())
}

/// 只換掉連線清單，保留既有群組定義。
///
/// 讀一次再寫的理由：呼叫端（CLI 的匯入、刪除…）拿到的是 `Vec<PersistedConnection>`，
/// 沒有群組資訊；若直接以預設值寫回，使用者的群組會在每次存連線時被默默清掉。
pub async fn save_all_in(dir: &Path, conns: &[PersistedConnection]) -> AppResult<()> {
    let groups = load_file_in(dir).await?.groups;
    save_file_in(
        dir,
        &ConnectionsFile {
            version: SCHEMA_VERSION,
            groups,
            connections: conns.to_vec(),
        },
    )
    .await
}

/// 新增或更新單筆連線。
///
/// 既有連線就地取代（不是移到清單尾端）：陣列順序即側欄顯示順序，改個密碼就讓連線跳到最後
/// 會把使用者拖好的排序打亂。群組同理由既有值保留——編輯連線的表單根本沒有群組欄位。
pub async fn upsert_in(dir: &Path, conn: PersistedConnection) -> AppResult<()> {
    let mut file = load_file_in(dir).await?;
    match file.connections.iter().position(|c| c.id == conn.id) {
        Some(i) => {
            let group_id = file.connections[i].group_id.clone();
            file.connections[i] = PersistedConnection { group_id, ..conn };
        }
        None => file.connections.push(conn),
    }
    file.version = SCHEMA_VERSION;
    save_file_in(dir, &file).await
}

/// 套用側欄排版：群組清單（順序＝顯示順序）+ 連線順序與歸屬，單次原子寫入。
///
/// `order` 是前端算好的完整結果；沒被列到的連線（前端狀態落後於磁碟時可能發生）原樣接在
/// 尾端，不會被丟掉。指向不存在群組的 `group_id` 一律歸零成未分組，避免留下孤兒參照。
pub async fn save_layout_in(
    dir: &Path,
    groups: Vec<ConnGroup>,
    order: &[(String, Option<String>)],
) -> AppResult<()> {
    let mut file = load_file_in(dir).await?;
    let valid = |g: &Option<String>| -> Option<String> {
        g.as_ref()
            .filter(|id| groups.iter().any(|x| &x.id == *id))
            .cloned()
    };

    let mut remaining = std::mem::take(&mut file.connections);
    let mut sorted: Vec<PersistedConnection> = Vec::with_capacity(remaining.len());
    for (id, group_id) in order {
        if let Some(i) = remaining.iter().position(|c| &c.id == id) {
            let mut c = remaining.remove(i);
            c.group_id = valid(group_id);
            sorted.push(c);
        }
    }
    for mut c in remaining {
        c.group_id = valid(&c.group_id);
        sorted.push(c);
    }

    file.version = SCHEMA_VERSION;
    file.groups = groups;
    file.connections = sorted;
    save_file_in(dir, &file).await
}

/// 讀取設定目錄下的 JSON 檔。檔案不存在回 `T::default()`。
pub async fn read_json_in<T: DeserializeOwned + Default>(dir: &Path, file: &str) -> AppResult<T> {
    let path = dir.join(file);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<T>(&bytes)
            .map_err(|e| AppError::Storage(tf!("解析 {file} 失敗：{e}", file = file, e = e))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(AppError::Storage(tf!("讀取 {file} 失敗：{e}", file = file, e = e))),
    }
}

/// 原子寫入設定目錄下的 JSON 檔（temp + rename）。
pub async fn write_json_in<T: Serialize>(dir: &Path, file: &str, value: &T) -> AppResult<()> {
    ensure_dir_at(dir).await?;
    let path = dir.join(file);
    let tmp = dir.join(format!("{file}.tmp"));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Storage(tf!("序列化 {file} 失敗：{e}", file = file, e = e)))?;
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| AppError::Storage(tf!("寫入 {file} 失敗：{e}", file = file, e = e)))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| AppError::Storage(tf!("更新 {file} 失敗：{e}", file = file, e = e)))?;
    Ok(())
}

/// 原子寫入設定目錄下的 JSON 檔，但**不做 pretty 縮排**（temp + rename）。
/// 給機器產生、體積可觀的資料用（結構快取：一個大 schema 的 pretty 縮排要多吃約五成空間，
/// 而且沒人會去手讀它）。人會編輯 / 想 diff 的設定檔請continue 用 `write_json_in`。
pub async fn write_json_compact_in<T: Serialize>(dir: &Path, file: &str, value: &T) -> AppResult<()> {
    ensure_dir_at(dir).await?;
    let path = dir.join(file);
    let tmp = dir.join(format!("{file}.tmp"));
    // 錯誤訊息刻意與 write_json_in 逐字相同——zh 原文即 i18n key，共用等於免再翻一次。
    let bytes = serde_json::to_vec(value)
        .map_err(|e| AppError::Storage(tf!("序列化 {file} 失敗：{e}", file = file, e = e)))?;
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| AppError::Storage(tf!("寫入 {file} 失敗：{e}", file = file, e = e)))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| AppError::Storage(tf!("更新 {file} 失敗：{e}", file = file, e = e)))?;
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
pub async fn load_groups(app: &AppHandle) -> AppResult<Vec<ConnGroup>> {
    Ok(load_file_in(&app_config_dir(app)?).await?.groups)
}

#[cfg(feature = "gui")]
pub async fn save_layout(
    app: &AppHandle,
    groups: Vec<ConnGroup>,
    order: &[(String, Option<String>)],
) -> AppResult<()> {
    save_layout_in(&app_config_dir(app)?, groups, order).await
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
        .map_err(|e| AppError::Storage(tf!("keychain 開啟失敗：{e}", e = e)))?;
    if secret.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry
        .set_password(secret)
        .map_err(|e| AppError::Storage(tf!("keychain 寫入失敗：{e}", e = e)))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(id: &str) -> PersistedConnection {
        PersistedConnection {
            id: id.into(),
            name: id.into(),
            kind: DbKind::Sqlite,
            host: "127.0.0.1".into(),
            port: 0,
            username: String::new(),
            database: None,
            max_connections: 5,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_username: String::new(),
            ssh_auth_method: SshAuthMethod::default(),
            ssh_private_key_path: String::new(),
            options: Default::default(),
            group_id: None,
        }
    }

    fn group(id: &str) -> ConnGroup {
        ConnGroup { id: id.into(), name: id.to_uppercase() }
    }

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbkit-store-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// v1 舊檔（無 groups / group_id）要能照讀，全部視為未分組。
    #[tokio::test]
    async fn reads_v1_file_as_ungrouped() {
        let dir = tmpdir();
        std::fs::write(
            dir.join(CONNECTIONS_FILE),
            r#"{"version":1,"connections":[
                 {"id":"a","name":"a","kind":"sqlite","host":"h","port":0,"username":""}]}"#,
        )
        .unwrap();
        let f = load_file_in(&dir).await.unwrap();
        assert!(f.groups.is_empty());
        assert_eq!(f.connections.len(), 1);
        assert_eq!(f.connections[0].group_id, None);
    }

    /// 編輯連線要就地更新，不能把它擠到清單尾端（陣列順序＝側欄順序），且群組要留著。
    #[tokio::test]
    async fn upsert_keeps_position_and_group() {
        let dir = tmpdir();
        save_file_in(
            &dir,
            &ConnectionsFile {
                version: SCHEMA_VERSION,
                groups: vec![group("g1")],
                connections: vec![
                    PersistedConnection { group_id: Some("g1".into()), ..conn("a") },
                    conn("b"),
                    conn("c"),
                ],
            },
        )
        .await
        .unwrap();

        // 模擬「編輯連線」存檔：group_id 為 None（前端表單不帶群組）。
        let mut edited = conn("a");
        edited.name = "renamed".into();
        upsert_in(&dir, edited).await.unwrap();

        let f = load_file_in(&dir).await.unwrap();
        assert_eq!(
            f.connections.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"],
            "就地更新，順序不變"
        );
        assert_eq!(f.connections[0].name, "renamed");
        assert_eq!(f.connections[0].group_id.as_deref(), Some("g1"), "群組保留");
    }

    /// save_layout_in：套用新順序與歸屬；未列到的連線接在尾端不遺失。
    #[tokio::test]
    async fn save_layout_applies_order_and_keeps_unlisted() {
        let dir = tmpdir();
        save_all_in(&dir, &[conn("a"), conn("b"), conn("c")]).await.unwrap();

        save_layout_in(
            &dir,
            vec![group("g1")],
            &[("c".into(), Some("g1".into())), ("a".into(), None)],
        )
        .await
        .unwrap();

        let f = load_file_in(&dir).await.unwrap();
        assert_eq!(
            f.connections.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"],
            "未列到的 b 接在尾端"
        );
        assert_eq!(f.connections[0].group_id.as_deref(), Some("g1"));
        assert_eq!(f.connections[1].group_id, None);
        assert_eq!(f.version, SCHEMA_VERSION);
    }

    /// 刪除群組（新清單不含它）→ 指向它的連線自動歸零成未分組，不留孤兒參照。
    #[tokio::test]
    async fn dropping_a_group_ungroups_its_members() {
        let dir = tmpdir();
        save_layout_in(&dir, vec![group("g1")], &[]).await.unwrap();
        save_all_in(&dir, &[PersistedConnection { group_id: Some("g1".into()), ..conn("a") }])
            .await
            .unwrap();

        // 新排版不再包含 g1。
        save_layout_in(&dir, vec![], &[("a".into(), Some("g1".into()))]).await.unwrap();

        let f = load_file_in(&dir).await.unwrap();
        assert!(f.groups.is_empty());
        assert_eq!(f.connections[0].group_id, None, "孤兒 group_id 歸零");
    }

    /// 存連線不得清掉群組定義（save_all_in 只換連線清單）。
    #[tokio::test]
    async fn save_all_preserves_groups() {
        let dir = tmpdir();
        save_layout_in(&dir, vec![group("g1"), group("g2")], &[]).await.unwrap();
        save_all_in(&dir, &[conn("a")]).await.unwrap();

        let f = load_file_in(&dir).await.unwrap();
        assert_eq!(f.groups.len(), 2, "群組定義保留");
    }

    /// 舊版 app_settings.json（沒有生物辨識 / 閒置鎖定欄位）讀進來必須是「都沒開」。
    /// 這兩個欄位若少了 `#[serde(default)]`，升級後第一次啟動就會整份設定讀失敗
    /// ——連語言與既有的啟動密碼一起消失。
    #[tokio::test]
    async fn app_settings_reads_pre_biometric_file() {
        let dir = tmpdir();
        std::fs::write(
            dir.join(APP_SETTINGS_FILE),
            r#"{"startup_password_hash":"$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA","lang":"ja"}"#,
        )
        .unwrap();

        let s: AppSettings = read_json_in(&dir, APP_SETTINGS_FILE).await.unwrap();
        assert!(s.startup_password_hash.is_some(), "舊有的啟動密碼必須保住");
        assert_eq!(s.lang.as_deref(), Some("ja"));
        assert!(!s.biometric_unlock, "缺欄 → 未啟用");
        assert_eq!(s.auto_lock_minutes, 0, "缺欄 → 關閉");
    }

    /// 新欄位寫得出去也讀得回來（且不影響既有欄位）。
    #[tokio::test]
    async fn app_settings_roundtrips_lock_fields() {
        let dir = tmpdir();
        let s = AppSettings {
            startup_password_hash: None,
            lang: Some("zh-TW".into()),
            biometric_unlock: true,
            auto_lock_minutes: 15,
        };
        write_json_in(&dir, APP_SETTINGS_FILE, &s).await.unwrap();

        let back: AppSettings = read_json_in(&dir, APP_SETTINGS_FILE).await.unwrap();
        assert!(back.biometric_unlock);
        assert_eq!(back.auto_lock_minutes, 15);
        assert_eq!(back.lang.as_deref(), Some("zh-TW"));
        assert!(back.startup_password_hash.is_none());
    }

    /// 完全沒有設定檔時＝沒有任何鎖。
    #[tokio::test]
    async fn app_settings_defaults_to_unlocked() {
        let dir = tmpdir();
        let s: AppSettings = read_json_in(&dir, APP_SETTINGS_FILE).await.unwrap();
        assert!(s.startup_password_hash.is_none());
        assert!(!s.biometric_unlock);
        assert_eq!(s.auto_lock_minutes, 0);
    }
}
