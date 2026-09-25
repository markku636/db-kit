//! SSH：DB 連線的 port-forward tunnel、Xshell 風格的終端機（PTY shell）與 SFTP。
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
//! - `runtime`：`SshRuntime`——活著的連線 / 終端 / SFTP / 待答提示 / 傳輸旗標的登記簿。

pub mod auth;
pub mod known_hosts;
pub mod runtime;
pub mod sessions;
pub mod sftp;
pub mod terminal;
mod tunnel;

#[cfg(test)]
mod it_tests;

// `SshRuntime` 只有 GUI 的 AppState 用；slim CLI build 不引用，別讓它變成 warning。
#[cfg_attr(not(feature = "gui"), allow(unused_imports))]
pub use runtime::SshRuntime;
pub use tunnel::{open_tunnel, TunnelGuard};
