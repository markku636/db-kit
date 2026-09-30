//! 檔案面板的後端：SFTP（SSH 連線上的子系統）或 FTP / FTPS。
//!
//! 前端的檔案面板、傳輸清單、續傳重試都只認 `sftp_id` 與 `ssh_sftp_*` 命令；登記簿裡存的是
//! `FileClient`，命令照協定分派到 `SftpClient` / `FtpClient`。資料夾 / 多選傳輸的規劃與進度合併在
//! `sftp` 模組對 `RemoteFs` 的泛型函式裡，兩種協定共用。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use super::ftp::FtpClient;
use super::sftp::{RemoteFs, SftpClient, SftpEntry, SftpText};
use crate::error::AppResult;

pub enum FileClient {
    Sftp(Arc<SftpClient>),
    Ftp(Arc<FtpClient>),
}

impl FileClient {
    /// 所屬連線（`SshConn` 或 `FtpConn` 的 id）。
    pub fn conn_id(&self) -> &str {
        match self {
            FileClient::Sftp(c) => &c.conn_id,
            FileClient::Ftp(c) => &c.conn_id,
        }
    }

    pub async fn close(&self) {
        match self {
            FileClient::Sftp(c) => c.close().await,
            FileClient::Ftp(c) => c.close().await,
        }
    }

    /// 傳輸用的檔案系統：SFTP 就是同一條通道（請求本來就能並行）；FTP 另開一條控制連線，
    /// 等到有空的傳輸名額才開（等待中可以取消）。
    pub async fn transfer_fs(&self, cancel: &AtomicBool) -> AppResult<Arc<dyn RemoteFs>> {
        match self {
            FileClient::Sftp(c) => Ok(c.clone()),
            FileClient::Ftp(c) => Ok(Arc::new(c.transfer_session(cancel).await?)),
        }
    }

    pub async fn list_dir(&self, path: &str) -> AppResult<Vec<SftpEntry>> {
        match self {
            FileClient::Sftp(c) => c.list_dir(path).await,
            FileClient::Ftp(c) => c.list_dir(path).await,
        }
    }

    pub async fn stat(&self, path: &str) -> AppResult<SftpEntry> {
        match self {
            FileClient::Sftp(c) => c.stat(path).await,
            FileClient::Ftp(c) => c.stat(path).await,
        }
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        match self {
            FileClient::Sftp(c) => c.mkdir(path).await,
            FileClient::Ftp(c) => c.mkdir(path).await,
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        match self {
            FileClient::Sftp(c) => c.rename(from, to).await,
            FileClient::Ftp(c) => c.rename(from, to).await,
        }
    }

    pub async fn remove(&self, path: &str, recursive: bool) -> AppResult<()> {
        match self {
            FileClient::Sftp(c) => c.remove(path, recursive).await,
            FileClient::Ftp(c) => c.remove(path, recursive).await,
        }
    }

    pub async fn read_small(&self, path: &str, max: u64) -> AppResult<SftpText> {
        match self {
            FileClient::Sftp(c) => c.read_small(path, max).await,
            FileClient::Ftp(c) => c.read_small(path, max).await,
        }
    }

    pub async fn write_text(&self, path: &str, content: &str, create_new: bool) -> AppResult<SftpEntry> {
        match self {
            FileClient::Sftp(c) => c.write_text(path, content, create_new).await,
            FileClient::Ftp(c) => c.write_text(path, content, create_new).await,
        }
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> AppResult<SftpEntry> {
        match self {
            FileClient::Sftp(c) => c.chmod(path, mode).await,
            FileClient::Ftp(c) => c.chmod(path, mode).await,
        }
    }

    /// 設定修改時間。FTP 沒有通用的做法（MFMT 不是每台伺服器都有），回 `false` 表示沒設。
    pub async fn set_mtime(&self, path: &str, mtime: u64) -> AppResult<bool> {
        match self {
            FileClient::Sftp(c) => c.set_mtime(path, mtime).await.map(|_| true),
            FileClient::Ftp(_) => Ok(false),
        }
    }
}
