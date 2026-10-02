//! 遠端桌面：分頁內嵌的 RDP / VNC，以及 RustDesk 相容連線（協定在獨立的 AGPL 輔助程式裡，見 repo 的 `rustdesk-bridge/README.md`）。
//!
//! 同 `ssh/`，整個 `rd/` **不依賴 Tauri**；GUI 事件 / IPC channel 只在 `commands/rd.rs` 出現。模組分工：
//!
//! - `sessions`：側欄「遠端桌面」的持久化（`remote_desktops.json`）與 keychain 帳號名。
//! - `runtime`：`RdRuntime`——活著的連線 / 待答提示的登記簿，以及連線任務收的控制訊息 `RdCtl`。
//! - `keygrab`：全螢幕時攔 Win / Alt+Tab / Alt+F4 / Ctrl+Esc 轉給遠端（Windows 低階鍵盤 hook）。
//! - `rustdesk`：RustDesk 相容連線——啟動獨立的 AGPL 輔助程式 `dbk-rustdesk-bridge`，經 stdin / stdout 轉送。
//! - `transport`：撥號（直連 TCP，或經已存 SSH 主機的 direct-tcpip）。
//! - `recording`：錄影的檔案端（前端 MediaRecorder 錄分頁畫面，一段一段交過來寫檔）。
//! - `vnc`：RFB 認證（None / VNC 密碼 / Apple ARD / VeNCrypt Plain）與對 noVNC 的假握手；認證完就是純位元組轉送。
//! - `rdp`：IronRDP 連線（TLS → 憑證 TOFU → CredSSP）、工作階段迴圈、畫面差異區塊的打包與輸入轉換。

pub mod keygrab;
pub mod recording;
pub mod runtime;
pub mod rustdesk;
pub mod rustdesk_files;
pub mod sessions;
pub mod transport;

#[cfg(feature = "vnc")]
pub mod vnc;

#[cfg(feature = "rdp")]
pub mod rdp;

#[cfg(test)]
mod it_tests;

#[cfg_attr(not(feature = "gui"), allow(unused_imports))]
pub use runtime::RdRuntime;
