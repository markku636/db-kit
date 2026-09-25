//! 側欄「SSH 主機」的資料模型與持久化（`ssh_sessions.json`）。
//!
//! 與 `store.rs` 的連線設定同一套慣例：非機密欄位寫磁碟（原子寫入）、密碼 / 私鑰密語一律進 OS
//! keychain（`kc_*`），`SshSession` **刻意沒有密碼欄位**，所以序列化怎麼寫都不可能把機密落地。
//! 實際 IO 收斂到 `*_in` 函式（吃 `&Path`），GUI 的 command 只是薄轉接。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::store;

/// 磁碟檔名。
pub const SESSIONS_FILE: &str = "ssh_sessions.json";

/// 認證方式。`keyboard_interactive` 是 OTP / PAM 那種由伺服器出題的互動式認證；
/// `agent` 走 ssh-agent（Unix `SSH_AUTH_SOCK`、Windows OpenSSH agent named pipe 或 Pageant）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthKind {
    #[default]
    Password,
    Key,
    Agent,
    KeyboardInteractive,
}

/// 終端機選項。全部 `#[serde(default)]`：舊檔 / 前端漏欄位都能讀。
///
/// `ui` 是字型 / 配色 / scrollback 這類純前端偏好，後端只負責存，不解讀。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshTermOptions {
    /// `TERM` 環境變數，送給 `request_pty`。
    #[serde(default = "default_term")]
    pub term: String,
    /// v1 只存不轉碼（UI 永遠以 UTF-8 收發）。
    #[serde(default = "default_encoding")]
    pub encoding: String,
    /// shell 開好後自動送出的第一行指令（會補 `\r`）。
    #[serde(default)]
    pub startup_command: String,
    /// keepalive 秒數；0 = 不送。
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u32,
    /// TCP + banner + KEX 的預算；0 → 20 秒。
    #[serde(default)]
    pub connect_timeout_secs: u32,
    /// 額外的遠端環境變數（`set_env`；伺服器 `AcceptEnv` 沒放行的會被忽略）。
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub ui: BTreeMap<String, String>,
}

fn default_term() -> String {
    "xterm-256color".into()
}
fn default_encoding() -> String {
    "utf-8".into()
}
fn default_keepalive() -> u32 {
    30
}

impl Default for SshTermOptions {
    fn default() -> Self {
        Self {
            term: default_term(),
            encoding: default_encoding(),
            startup_command: String::new(),
            keepalive_secs: default_keepalive(),
            connect_timeout_secs: 0,
            env: BTreeMap::new(),
            ui: BTreeMap::new(),
        }
    }
}

/// 一台已存的 SSH 主機。沒有密碼 / 密語欄位（見模組說明）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshSession {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth: SshAuthKind,
    #[serde(default)]
    pub private_key_path: String,
    /// 所屬資料夾（`SshFolder::id`）；`None` = 未分類。
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub options: SshTermOptions,
}

fn default_port() -> u16 {
    22
}

/// 側欄資料夾。`parent_id` 讓資料夾可巢狀；指向不存在資料夾的一律歸零。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshFolder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// 磁碟格式。陣列順序 = 側欄顯示順序。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshSessionsFile {
    #[serde(default = "schema_v1")]
    pub version: u32,
    #[serde(default)]
    pub folders: Vec<SshFolder>,
    #[serde(default)]
    pub sessions: Vec<SshSession>,
}

fn schema_v1() -> u32 {
    1
}

const SCHEMA_VERSION: u32 = 1;

impl Default for SshSessionsFile {
    fn default() -> Self {
        Self { version: SCHEMA_VERSION, folders: Vec::new(), sessions: Vec::new() }
    }
}

// ---- keychain 帳號名（service 沿用 store 的 "db-kit"）----

/// 密碼。帶 `.sshsess` 後綴，與 DB 連線的 `{id}` / `{id}.ssh` 不會撞名。
pub fn session_password_account(id: &str) -> String {
    format!("{id}.sshsess")
}

/// 私鑰密語。
pub fn session_passphrase_account(id: &str) -> String {
    format!("{id}.sshsess-passphrase")
}

// ---- 持久化 ----

/// 讀整份檔。不存在 → 預設空表；損毀 → Err（不要默默當成空表，下次存檔會把使用者的清單蓋掉）。
pub async fn load_in(dir: &Path) -> AppResult<SshSessionsFile> {
    store::read_json_in(dir, SESSIONS_FILE).await
}

async fn save_in(dir: &Path, file: &SshSessionsFile) -> AppResult<()> {
    store::write_json_in(dir, SESSIONS_FILE, file).await
}

/// 指向不存在資料夾的 `folder_id` 歸零，不留孤兒參照。
fn valid_folder(folders: &[SshFolder], id: &Option<String>) -> Option<String> {
    id.as_ref().filter(|f| folders.iter().any(|x| &x.id == *f)).cloned()
}

/// 新增或更新單筆主機。既有的就地取代（陣列順序即側欄順序，改個設定不該跳到最後）。
///
/// `folder_id` 採用傳入值（編輯對話框有「資料夾」欄位，新增時也靠它落到目前資料夾），
/// 但指向不存在資料夾的一律歸零。
pub async fn upsert_in(dir: &Path, session: SshSession) -> AppResult<()> {
    let mut file = load_in(dir).await?;
    let mut s = session;
    s.folder_id = valid_folder(&file.folders, &s.folder_id);
    match file.sessions.iter().position(|x| x.id == s.id) {
        Some(i) => file.sessions[i] = s,
        None => file.sessions.push(s),
    }
    file.version = SCHEMA_VERSION;
    save_in(dir, &file).await
}

/// 刪除主機（不存在則不動檔案）。keychain 的兩個帳號由呼叫端刪。
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

/// 套用側欄排版：資料夾清單（順序 = 顯示順序）+ 主機順序與歸屬，單次原子寫入。
///
/// `order` 是前端算好的完整結果；沒被列到的主機原樣接在尾端，不會被丟掉。
/// 主機的 `folder_id` 與資料夾的 `parent_id` 指向不存在資料夾時一律歸零。
pub async fn save_layout_in(
    dir: &Path,
    folders: Vec<SshFolder>,
    order: &[(String, Option<String>)],
) -> AppResult<()> {
    let mut file = load_in(dir).await?;
    let ids: Vec<String> = folders.iter().map(|f| f.id.clone()).collect();
    let folders: Vec<SshFolder> = folders
        .into_iter()
        .map(|mut f| {
            // 自己指向自己也算孤兒（會讓樹無限遞迴）。
            f.parent_id = f
                .parent_id
                .filter(|p| p != &f.id && ids.contains(p));
            f
        })
        .collect();

    let mut remaining = std::mem::take(&mut file.sessions);
    let mut sorted: Vec<SshSession> = Vec::with_capacity(remaining.len());
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
        let d = std::env::temp_dir().join(format!("dbkit-sshsess-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sess(id: &str) -> SshSession {
        SshSession {
            id: id.into(),
            name: id.to_uppercase(),
            host: format!("{id}.example"),
            port: 22,
            username: "deploy".into(),
            auth: SshAuthKind::Key,
            private_key_path: "C:/keys/id_ed25519".into(),
            folder_id: None,
            options: SshTermOptions::default(),
        }
    }

    fn folder(id: &str) -> SshFolder {
        SshFolder { id: id.into(), name: id.to_uppercase(), parent_id: None }
    }

    #[tokio::test]
    async fn roundtrip_and_no_secret_keys() {
        let dir = tmpdir();
        assert_eq!(load_in(&dir).await.unwrap(), SshSessionsFile::default(), "不存在 = 空表");
        let mut s = sess("a");
        s.options.startup_command = "tmux a".into();
        s.options.env.insert("LANG".into(), "C.UTF-8".into());
        upsert_in(&dir, s.clone()).await.unwrap();
        let f = load_in(&dir).await.unwrap();
        assert_eq!(f.sessions, vec![s]);
        assert_eq!(f.version, 1);

        // 序列化結果不可含任何密碼 / 密語鍵（型別上根本沒有這些欄位，這裡是防止未來有人加）。
        let json = serde_json::to_string(&f).unwrap();
        for k in ["password", "passphrase", "secret"] {
            assert!(!json.contains(k), "{k} 不該出現在 ssh_sessions.json：{json}");
        }
        assert!(json.contains("\"auth\":\"key\""), "enum 走 snake_case：{json}");
    }

    /// 舊 schema / 精簡 JSON：缺欄位全部走預設，不能讀不出來。
    #[test]
    fn minimal_json_fills_defaults() {
        let f: SshSessionsFile = serde_json::from_str(
            r#"{"sessions":[{"id":"x","host":"h"}]}"#,
        )
        .unwrap();
        assert_eq!(f.version, 1);
        let s = &f.sessions[0];
        assert_eq!(s.port, 22);
        assert_eq!(s.auth, SshAuthKind::Password);
        assert_eq!(s.options.term, "xterm-256color");
        assert_eq!(s.options.keepalive_secs, 30);
        assert_eq!(s.options.connect_timeout_secs, 0);
        assert_eq!(s.folder_id, None);
        let ki: SshAuthKind = serde_json::from_str("\"keyboard_interactive\"").unwrap();
        assert_eq!(ki, SshAuthKind::KeyboardInteractive);
    }

    /// 損毀的檔案是錯誤，不是空表——否則下一次存檔會把使用者的清單蓋掉。
    #[tokio::test]
    async fn corrupt_file_is_error() {
        let dir = tmpdir();
        std::fs::write(dir.join(SESSIONS_FILE), b"{ nope").unwrap();
        assert!(load_in(&dir).await.is_err());
    }

    #[tokio::test]
    async fn upsert_keeps_position_and_validates_folder() {
        let dir = tmpdir();
        save_layout_in(&dir, vec![folder("prod")], &[]).await.unwrap();
        upsert_in(&dir, sess("a")).await.unwrap();
        upsert_in(&dir, sess("b")).await.unwrap();
        upsert_in(&dir, sess("c")).await.unwrap();
        // 更新 a：留在原位；folder 指向存在的資料夾 → 套用
        let mut a2 = sess("a");
        a2.name = "A2".into();
        a2.folder_id = Some("prod".into());
        upsert_in(&dir, a2).await.unwrap();
        // 更新 b：指向不存在的資料夾 → 歸零
        let mut b2 = sess("b");
        b2.folder_id = Some("ghost".into());
        upsert_in(&dir, b2).await.unwrap();
        let f = load_in(&dir).await.unwrap();
        let ids: Vec<&str> = f.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(f.sessions[0].name, "A2");
        assert_eq!(f.sessions[0].folder_id.as_deref(), Some("prod"));
        assert_eq!(f.sessions[1].folder_id, None);
    }

    #[tokio::test]
    async fn remove_is_idempotent() {
        let dir = tmpdir();
        upsert_in(&dir, sess("a")).await.unwrap();
        remove_in(&dir, "a").await.unwrap();
        remove_in(&dir, "a").await.unwrap();
        assert!(load_in(&dir).await.unwrap().sessions.is_empty());
    }

    /// 排版：依 order 重排、未列到的接尾端、孤兒 folder_id / parent_id 歸零、自指歸零。
    #[tokio::test]
    async fn layout_reorders_and_zeroes_orphans() {
        let dir = tmpdir();
        for id in ["a", "b", "c"] {
            upsert_in(&dir, sess(id)).await.unwrap();
        }
        let folders = vec![
            folder("f1"),
            SshFolder { id: "f2".into(), name: "F2".into(), parent_id: Some("f1".into()) },
            SshFolder { id: "f3".into(), name: "F3".into(), parent_id: Some("nope".into()) },
            SshFolder { id: "f4".into(), name: "F4".into(), parent_id: Some("f4".into()) },
        ];
        save_layout_in(
            &dir,
            folders,
            &[
                ("c".into(), Some("f2".into())),
                ("a".into(), Some("ghost".into())),
                ("zzz".into(), None), // 不存在的 id：忽略
            ],
        )
        .await
        .unwrap();
        let f = load_in(&dir).await.unwrap();
        let ids: Vec<&str> = f.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["c", "a", "b"], "未列到的 b 接在尾端");
        assert_eq!(f.sessions[0].folder_id.as_deref(), Some("f2"));
        assert_eq!(f.sessions[1].folder_id, None, "孤兒歸零");
        let parent = |id: &str| f.folders.iter().find(|x| x.id == id).unwrap().parent_id.clone();
        assert_eq!(parent("f2").as_deref(), Some("f1"));
        assert_eq!(parent("f3"), None);
        assert_eq!(parent("f4"), None, "自指視為孤兒");
    }

    #[test]
    fn keychain_accounts_do_not_collide_with_db_connections() {
        assert_eq!(session_password_account("x"), "x.sshsess");
        assert_eq!(session_passphrase_account("x"), "x.sshsess-passphrase");
        assert_ne!(session_password_account("x"), store::ssh_account("x"));
        assert_ne!(session_passphrase_account("x"), store::ssh_passphrase_account("x"));
    }
}
