//! SSH：DB 連線的 port-forward tunnel、Xshell 風格的終端機（PTY shell）與 SFTP；以及共用檔案面板的 FTP / FTPS。
//!
//! 整個 `ssh/` **不依賴 Tauri**（`--no-default-features` 可編可測）；GUI 事件 / IPC channel 只在
//! `commands/ssh.rs` 出現。模組分工：
//!
//! - `known_hosts`：host key 指紋（TOFU）存讀，`ssh_known_hosts.json` 格式與舊版相同。
//! - `auth`：`SshTarget`（一次連線需要的全部資料）、`AuthUi`（host key / 密碼 / OTP 的發問介面）、
//!   `DbkHandler`（russh handler）、`connect_and_auth`（撥號 + 逐步認證）、`plan_auth`（純函式）。
//! - `tunnel`：既有的 `direct-tcpip` 轉發（`open_tunnel` / `TunnelGuard`，行為不變）。
//! - `sessions`：側欄「SSH 主機」的持久化（`ssh_sessions.json`）與 keychain 帳號名。
//! - `terminal`：PTY shell channel、輸出合併、resize / close。
//! - `sftp`：SFTP 子系統（russh-sftp）、路徑安全、上下傳與取消。
//! - `session_log`：終端機工作階段記錄檔（開始時清空、之後追加）。
//! - `host_import`：從 ~/.ssh/config 與 .xsh 工作階段檔讀出可匯入的主機（只讀，不寫）。
//! - `keys`：使用者金鑰——各種私鑰格式的辨識與載入、OpenSSH 憑證、App 內金鑰庫（`keystore:<id>`）。
//! - `runtime`：`SshRuntime`——活著的連線 / 終端 / SFTP / 待答提示 / 傳輸旗標的登記簿。
//! - `sftp_window`：SFTP 獨立視窗的視窗標籤與網址。
//! - `ftp`：FTP / FTPS 客戶端（檔案面板的 FTP 主機；斷點續傳走 REST / APPE）。
//! - `files`：`FileClient`——檔案面板的後端（SFTP 或 FTP），`ssh_sftp_*` 命令照協定分派。

pub mod auth;
pub mod files;
pub mod ftp;
pub mod host_import;
pub mod keys;
pub mod known_hosts;
pub mod runtime;
pub mod session_log;
pub mod sessions;
pub mod sftp;
pub mod sftp_window;
pub mod terminal;
mod tunnel;

#[cfg(test)]
mod ftp_it_tests;
#[cfg(test)]
mod it_tests;

// `SshRuntime` 只有 GUI 的 AppState 用；slim CLI build 不引用，別讓它變成 warning。
#[cfg_attr(not(feature = "gui"), allow(unused_imports))]
pub use runtime::SshRuntime;
pub use tunnel::{open_tunnel, TunnelGuard};
