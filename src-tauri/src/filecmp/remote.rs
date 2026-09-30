//! 不經 GUI 開一條檔案工作階段（`dbk diff` / `dbk sync` 的遠端那一邊）。
//!
//! 只支援已存的主機（GUI 裡建好的 SSH / SFTP / FTP 主機）：帳密照主機設定從 keychain 取，
//! 跳板機照設定串起來。CLI 不能跳對話框，所以用 `SilentUi`——新主機 TOFU 記住 host key、
//! 指紋變了一律拒絕、需要當場輸入密碼 / OTP 的主機會連不上（請先在 GUI 存好密碼或改用金鑰）。

use std::path::Path;
use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::ssh::auth::{connect_and_auth, resolve_jump_chain, SilentUi, SshTarget};
use crate::ssh::files::FileClient;
use crate::ssh::ftp::{self, FtpClient, FtpConn, FtpTarget};
use crate::ssh::known_hosts::KnownHostsStore;
use crate::ssh::runtime::SshConn;
use crate::ssh::sessions::{self, HostProtocol, SshSession, SshSessionsFile};
use crate::ssh::sftp::SftpClient;
use crate::store;

/// 開好的遠端：檔案工作階段 + 登入後的家目錄。`_conn` 讓底下的 SSH 連線跟著活到用完為止。
pub struct RemoteOpen {
    pub client: Arc<FileClient>,
    pub home: String,
    pub label: String,
    _conn: Option<Arc<SshConn>>,
}

fn secrets(id: &str) -> (Option<String>, Option<String>) {
    (
        store::kc_get(&sessions::session_password_account(id)),
        store::kc_get(&sessions::session_passphrase_account(id)),
    )
}

/// 依 id、名稱（大小寫不敏感）或 `user@host` 找已存主機。
pub fn find_host<'a>(file: &'a SshSessionsFile, q: &str) -> Option<&'a SshSession> {
    let q = q.trim();
    let ql = q.to_lowercase();
    file.sessions
        .iter()
        .find(|s| s.id == q)
        .or_else(|| file.sessions.iter().find(|s| s.name.to_lowercase() == ql))
        .or_else(|| file.sessions.iter().find(|s| format!("{}@{}", s.username, s.host).to_lowercase() == ql))
        .or_else(|| file.sessions.iter().find(|s| s.host.to_lowercase() == ql))
}

pub async fn open_saved_host(config_dir: &Path, name_or_id: &str) -> AppResult<RemoteOpen> {
    let file = sessions::load_in(config_dir).await?;
    let s = find_host(&file, name_or_id)
        .cloned()
        .ok_or_else(|| AppError::Ssh(tf!("找不到 SSH 主機：{id}", id = name_or_id)))?;
    let conn_id = format!("cli-{}", uuid::Uuid::new_v4());
    let (pw, pp) = secrets(&s.id);
    let label = if s.name.trim().is_empty() { format!("{}@{}", s.username, s.host) } else { s.name.clone() };
    if s.protocol == HostProtocol::Ftp {
        let t = FtpTarget::from_session(&s, pw);
        let (t, initial) = ftp::connect_and_login(&t, &conn_id, &SilentUi, &KnownHostsStore::default_path()).await?;
        let fc = FtpConn::new(conn_id, t, initial);
        let (client, home) = FtpClient::open(&fc).await?;
        return Ok(RemoteOpen { client: Arc::new(FileClient::Ftp(Arc::new(client))), home, label, _conn: None });
    }
    let mut t = SshTarget::from_session(&s, pw, pp);
    t.jump = resolve_jump_chain(&file, &s.id, s.jump_session_id.as_deref(), secrets)?;
    let connected = connect_and_auth(&t, &conn_id, Arc::new(SilentUi), KnownHostsStore::default_path()).await?;
    let conn = Arc::new(SshConn::new(conn_id, &t, connected));
    let (client, home) = SftpClient::open(&conn).await?;
    Ok(RemoteOpen { client: Arc::new(FileClient::Sftp(Arc::new(client))), home, label, _conn: Some(conn) })
}

/// 遠端路徑的 `~` → 家目錄。
pub fn expand_home(path: &str, home: &str) -> String {
    let p = path.trim();
    if p.is_empty() || p == "~" {
        return if home.is_empty() { ".".into() } else { home.to_string() };
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return format!("{}/{}", home.trim_end_matches('/'), rest);
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home() {
        assert_eq!(expand_home("~", "/home/u"), "/home/u");
        assert_eq!(expand_home("", "/home/u"), "/home/u");
        assert_eq!(expand_home("~/app", "/home/u/"), "/home/u/app");
        assert_eq!(expand_home("/var/www", "/home/u"), "/var/www");
    }
}
