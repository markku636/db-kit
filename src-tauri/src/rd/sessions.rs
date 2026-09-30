//! 側欄「遠端桌面」的資料模型與持久化（`remote_desktops.json`）。
//!
//! 慣例同 `ssh/sessions.rs`：非機密欄位寫磁碟（原子寫入）、密碼一律進 OS keychain（`kc_*`），
//! `RdSession` **刻意沒有密碼欄位**，序列化怎麼寫都不可能把機密落地。
//! 與 SSH 主機分檔而不是在 `SshSession` 加 protocol 欄位：兩邊的欄位幾乎不重疊（金鑰 / 跳板機 / 終端選項
//! 對遠端桌面沒意義），硬塞會讓兩邊的舊檔相容與對話框都變複雜。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::store;

/// 磁碟檔名。
pub const SESSIONS_FILE: &str = "remote_desktops.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RdProtocol {
    #[default]
    Rdp,
    Vnc,
    Rustdesk,
}

impl RdProtocol {
    /// `port == 0` 時用的預設值（RustDesk 為 Direct IP 的 21118）。
    pub fn default_port(self) -> u16 {
        match self {
            RdProtocol::Rdp => 3389,
            RdProtocol::Vnc => 5900,
            RdProtocol::Rustdesk => 21118,
        }
    }
}

/// 畫面尺寸跟分頁的關係（前端解讀；RDP 端 `remote` 會送動態解析度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RdResizeMode {
    #[default]
    Scale,
    Remote,
    None,
}

/// VNC 認證偏好；見 `rd::vnc::auth::VncSecurityPref`（同一組值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum VncSecurity {
    #[default]
    Auto,
    None,
    Vnc,
    Ard,
    Plain,
}

/// 連線選項。全部 `#[serde(default)]`：舊檔 / 前端漏欄位都能讀。`ui` 是前端偏好，後端只存。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RdOptions {
    pub resize_mode: RdResizeMode,
    /// RDP 色深（16 / 24 / 32）。
    pub color_depth: u8,
    /// RDP 固定解析度；0 = 跟分頁大小。
    pub width: u16,
    pub height: u16,
    /// RDP 網路層級驗證（CredSSP / NLA）。
    pub nla: bool,
    pub view_only: bool,
    pub clipboard: bool,
    pub vnc_security: VncSecurity,
    pub vnc_shared: bool,
    /// RustDesk ID 伺服器（hbbs，`host[:port]`）；空 = 公開伺服器。
    pub rustdesk_server: String,
    /// RustDesk ID 伺服器的公鑰（base64）。
    pub rustdesk_key: String,
    /// 強制走中繼伺服器。
    pub rustdesk_relay: bool,
    /// RustDesk 中繼伺服器（hbbr）；空 = 用 ID 伺服器告知的。
    pub rustdesk_relay_server: String,
    /// 0 → 20 秒。
    pub connect_timeout_secs: u32,
    pub ui: BTreeMap<String, String>,
}

impl Default for RdOptions {
    fn default() -> Self {
        Self {
            resize_mode: RdResizeMode::Scale,
            color_depth: 32,
            width: 0,
            height: 0,
            nla: true,
            view_only: false,
            clipboard: true,
            vnc_security: VncSecurity::Auto,
            vnc_shared: true,
            rustdesk_server: String::new(),
            rustdesk_key: String::new(),
            rustdesk_relay: false,
            rustdesk_relay_server: String::new(),
            connect_timeout_secs: 0,
            ui: BTreeMap::new(),
        }
    }
}

impl RdOptions {
    pub fn connect_timeout(&self) -> std::time::Duration {
        let s = if self.connect_timeout_secs == 0 { 20 } else { self.connect_timeout_secs };
        std::time::Duration::from_secs(u64::from(s))
    }
}

/// 一台已存的遠端桌面主機。沒有密碼欄位（見模組說明）。RustDesk 的 `host` 是對方 ID 或 Direct IP 位址。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RdSession {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub protocol: RdProtocol,
    pub host: String,
    /// 0 = 協定預設。
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub domain: String,
    /// 經哪台已存 SSH 主機（`SshSession::id`）的 direct-tcpip 連過去；`None` = 直連。
    #[serde(default)]
    pub via_ssh_session_id: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub options: RdOptions,
}

impl RdSession {
    pub fn effective_port(&self) -> u16 {
        if self.port == 0 { self.protocol.default_port() } else { self.port }
    }

    /// 顯示 / log 用：`user@host:port`（沒帳號就省略）。
    #[allow(dead_code)]
    pub fn label(&self) -> String {
        let hp = format!("{}:{}", self.host, self.effective_port());
        if self.username.is_empty() { hp } else { format!("{}@{hp}", self.username) }
    }

    /// 經 SSH 的設定（空字串視同未設定）。
    pub fn via_ssh(&self) -> Option<&str> {
        self.via_ssh_session_id.as_deref().filter(|s| !s.is_empty())
    }
}

/// 側欄資料夾（同 `SshFolder` 的語意；分開存，兩棵樹互不影響）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RdFolder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// 磁碟格式。陣列順序 = 側欄顯示順序。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RdSessionsFile {
    #[serde(default = "schema_v1")]
    pub version: u32,
    #[serde(default)]
    pub folders: Vec<RdFolder>,
    #[serde(default)]
    pub sessions: Vec<RdSession>,
}

fn schema_v1() -> u32 {
    1
}

/// v2：側欄照陣列順序顯示（可拖曳排序）；v1 固定依名稱排序顯示。
const SCHEMA_VERSION: u32 = 2;

impl Default for RdSessionsFile {
    fn default() -> Self {
        Self { version: SCHEMA_VERSION, folders: Vec::new(), sessions: Vec::new() }
    }
}

/// keychain 帳號名（service 沿用 store 的 "db-kit"）。`.rdsess` 後綴與 DB 連線 / SSH 主機不會撞名。
pub fn session_password_account(id: &str) -> String {
    format!("{id}.rdsess")
}

// ---- 持久化 ----

/// 讀整份檔。不存在 → 預設空表；損毀 → Err（不要默默當成空表，下次存檔會把使用者的清單蓋掉）。
pub async fn load_in(dir: &Path) -> AppResult<RdSessionsFile> {
    let mut file: RdSessionsFile = store::read_json_in(dir, SESSIONS_FILE).await?;
    migrate(&mut file);
    Ok(file)
}

/// v1 → v2：v1 的側欄固定依名稱排序顯示，v2 起照陣列順序（使用者拖曳排序）。第一次讀到 v1 就先依
/// 名稱排好（穩定排序），升級後畫面上的順序不變；下一次寫檔時一併寫成 v2。
fn migrate(file: &mut RdSessionsFile) {
    if file.version < 2 {
        file.sessions.sort_by(|a, b| {
            store::natural_label_cmp(
                &store::host_label(&a.name, &a.username, &a.host),
                &store::host_label(&b.name, &b.username, &b.host),
            )
        });
        file.version = SCHEMA_VERSION;
    }
}

async fn save_in(dir: &Path, file: &RdSessionsFile) -> AppResult<()> {
    store::write_json_in(dir, SESSIONS_FILE, file).await
}

fn valid_folder(folders: &[RdFolder], id: &Option<String>) -> Option<String> {
    id.as_ref().filter(|f| folders.iter().any(|x| &x.id == *f)).cloned()
}

/// 新增或更新單筆主機。既有的就地取代；指向不存在資料夾的 `folder_id` 歸零。
pub async fn upsert_in(dir: &Path, session: RdSession) -> AppResult<()> {
    let mut file = load_in(dir).await?;
    let mut s = session;
    s.folder_id = valid_folder(&file.folders, &s.folder_id);
    if s.via_ssh_session_id.as_deref() == Some("") {
        s.via_ssh_session_id = None;
    }
    match file.sessions.iter().position(|x| x.id == s.id) {
        Some(i) => file.sessions[i] = s,
        None => file.sessions.push(s),
    }
    file.version = SCHEMA_VERSION;
    save_in(dir, &file).await
}

/// 刪除主機（不存在則不動檔案）。keychain 由呼叫端刪。
pub async fn remove_in(dir: &Path, id: &str) -> AppResult<()> {
    let mut file = load_in(dir).await?;
    let before = file.sessions.len();
    file.sessions.retain(|s| s.id != id);
    if file.sessions.len() != before {
        file.version = SCHEMA_VERSION;
        save_in(dir, &file).await?;
    }
    Ok(())
}

/// 套用側欄排版：資料夾清單 + 主機順序與歸屬，單次原子寫入（語意同 `ssh::sessions::save_layout_in`）。
pub async fn save_layout_in(
    dir: &Path,
    folders: Vec<RdFolder>,
    order: &[(String, Option<String>)],
) -> AppResult<()> {
    let mut file = load_in(dir).await?;
    let ids: Vec<String> = folders.iter().map(|f| f.id.clone()).collect();
    let folders: Vec<RdFolder> = folders
        .into_iter()
        .map(|mut f| {
            f.parent_id = f.parent_id.filter(|p| p != &f.id && ids.contains(p));
            f
        })
        .collect();

    let mut remaining = std::mem::take(&mut file.sessions);
    let mut sorted: Vec<RdSession> = Vec::with_capacity(remaining.len());
    for (id, folder_id) in order {
        if let Some(i) = remaining.iter().position(|s| &s.id == id) {
            let mut s = remaining.remove(i);
            s.folder_id = valid_folder(&folders, folder_id);
            sorted.push(s);
        }
    }
    for mut s in remaining {
        s.folder_id = valid_folder(&folders, &s.folder_id);
        sorted.push(s);
    }

    file.version = SCHEMA_VERSION;
    file.folders = folders;
    file.sessions = sorted;
    save_in(dir, &file).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbkit-rdsess-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sess(id: &str, protocol: RdProtocol) -> RdSession {
        RdSession {
            id: id.into(),
            name: id.to_uppercase(),
            protocol,
            host: format!("{id}.example"),
            port: 0,
            username: "admin".into(),
            domain: String::new(),
            via_ssh_session_id: None,
            folder_id: None,
            options: RdOptions::default(),
        }
    }

    #[tokio::test]
    async fn roundtrip_and_no_secret_keys() {
        let dir = tmpdir();
        assert_eq!(load_in(&dir).await.unwrap(), RdSessionsFile::default());
        let mut s = sess("a", RdProtocol::Vnc);
        s.options.vnc_security = VncSecurity::Ard;
        s.options.ui.insert("fullscreen".into(), "1".into());
        upsert_in(&dir, s.clone()).await.unwrap();
        let f = load_in(&dir).await.unwrap();
        assert_eq!(f.sessions, vec![s]);
        let json = serde_json::to_string(&f).unwrap();
        for k in ["password", "passphrase", "secret"] {
            assert!(!json.contains(k), "{k} 不該出現在 remote_desktops.json：{json}");
        }
        assert!(json.contains("\"protocol\":\"vnc\""), "{json}");
        assert!(json.contains("\"vnc_security\":\"ard\""), "{json}");
    }

    #[test]
    fn minimal_json_fills_defaults() {
        let f: RdSessionsFile =
            serde_json::from_str(r#"{"sessions":[{"id":"x","host":"h"}]}"#).unwrap();
        let s = &f.sessions[0];
        assert_eq!(s.protocol, RdProtocol::Rdp);
        assert_eq!(s.effective_port(), 3389);
        assert!(s.options.nla);
        assert_eq!(s.options.color_depth, 32);
        assert_eq!(s.options.connect_timeout(), std::time::Duration::from_secs(20));
        let o: RdOptions = serde_json::from_str(r#"{"nla":false}"#).unwrap();
        assert!(!o.nla && o.clipboard, "部分欄位：其餘走預設");
    }

    #[test]
    fn ports_and_labels() {
        let mut s = sess("m", RdProtocol::Vnc);
        assert_eq!(s.effective_port(), 5900);
        s.port = 5901;
        assert_eq!(s.label(), "admin@m.example:5901");
        s.username.clear();
        assert_eq!(s.label(), "m.example:5901");
        assert_eq!(RdProtocol::Rustdesk.default_port(), 21118);
        s.via_ssh_session_id = Some(String::new());
        assert_eq!(s.via_ssh(), None);
    }

    #[tokio::test]
    async fn corrupt_file_is_error() {
        let dir = tmpdir();
        std::fs::write(dir.join(SESSIONS_FILE), b"{ nope").unwrap();
        assert!(load_in(&dir).await.is_err());
    }

    #[tokio::test]
    async fn upsert_layout_remove() {
        let dir = tmpdir();
        save_layout_in(&dir, vec![RdFolder { id: "f".into(), name: "F".into(), parent_id: None }], &[])
            .await
            .unwrap();
        for id in ["a", "b", "c"] {
            upsert_in(&dir, sess(id, RdProtocol::Rdp)).await.unwrap();
        }
        let mut b2 = sess("b", RdProtocol::Rdp);
        b2.folder_id = Some("ghost".into());
        b2.via_ssh_session_id = Some(String::new());
        upsert_in(&dir, b2).await.unwrap();
        save_layout_in(
            &dir,
            vec![RdFolder { id: "f".into(), name: "F".into(), parent_id: Some("f".into()) }],
            &[("c".into(), Some("f".into()))],
        )
        .await
        .unwrap();
        let f = load_in(&dir).await.unwrap();
        let ids: Vec<&str> = f.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["c", "a", "b"]);
        assert_eq!(f.sessions[0].folder_id.as_deref(), Some("f"));
        assert_eq!(f.sessions[2].folder_id, None, "孤兒歸零");
        assert_eq!(f.sessions[2].via_ssh_session_id, None, "空字串視同未設定");
        assert_eq!(f.folders[0].parent_id, None, "自指歸零");
        remove_in(&dir, "a").await.unwrap();
        remove_in(&dir, "a").await.unwrap();
        assert_eq!(load_in(&dir).await.unwrap().sessions.len(), 2);
    }

    #[test]
    fn keychain_account_does_not_collide() {
        assert_eq!(session_password_account("x"), "x.rdsess");
        assert_ne!(session_password_account("x"), crate::ssh::sessions::session_password_account("x"));
        assert_ne!(session_password_account("x"), store::ssh_account("x"));
    }

    /// 同 SSH：v1 檔先依名稱排好一次，之後照存檔順序。
    #[tokio::test]
    async fn v1_file_sorted_by_label_then_manual_order_sticks() {
        let dir = tmpdir();
        let (mut b, mut a) = (sess("b", RdProtocol::Rdp), sess("a", RdProtocol::Vnc));
        b.name = "office-10".into();
        a.name = "Office-9".into();
        let v1 = serde_json::json!({ "version": 1, "folders": [], "sessions": [b, a] });
        std::fs::write(dir.join(SESSIONS_FILE), v1.to_string()).unwrap();

        let f = load_in(&dir).await.unwrap();
        let ids: Vec<&str> = f.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(f.version, SCHEMA_VERSION);

        let order: Vec<(String, Option<String>)> = ["b", "a"].iter().map(|i| (i.to_string(), None)).collect();
        save_layout_in(&dir, vec![], &order).await.unwrap();
        let ids: Vec<String> = load_in(&dir).await.unwrap().sessions.into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["b", "a"]);
    }
}
