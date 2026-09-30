//! 檔案 / 資料夾 / 二進位比對核心（不依賴 Tauri；GUI 的 command 在 `commands/filecmp.rs`）。
//!
//! 與資料庫的 `compare` 模組無關：這裡比的是檔案系統。兩邊各是「本機」或「一條已開的檔案工作階段」
//! （SFTP / FTP，見 `ssh::files::FileClient`），四種組合共用同一套掃描、比對、同步：
//!
//! - `side`：一邊的檔案系統操作（列目錄、建資料夾、刪除、設時間），本機與遠端各一種實作。
//! - `scan`：整棵樹掃成扁平清單（相對路徑 + 大小 + 修改時間），套排除規則與數量上限。
//! - `diff`：兩份清單依相對路徑對齊，給每個項目一個狀態（相同 / 不同 / 只在左 / 只在右…）。
//! - `sync`：照前端給的操作清單（複製 → / ← / 刪除）執行，保留來源的修改時間。
//! - `binary`：兩個本機檔的逐位元組比對（差異區段）與分頁讀取，給十六進位比對視圖。
//! - `content`：內容比對與遠端檔下載到暫存（GUI 與 dbk 共用）。
//! - `remote`：不經 GUI 開已存主機的檔案工作階段（dbk 的遠端那一邊）。
//! - `linediff`：行 diff 與 unified 輸出（dbk diff 的文字比對）。
//! - `plan`：同步規則（鏡像 / 更新）→ 操作清單（`dbk sync` 用；GUI 在前端算，規則相同）。
//! - `sessions`：已存的比對（GUI 與 dbk 共用的 compare_sessions.json）。
//! - `text`：本機文字檔的讀寫（存檔時比對 mtime，避免蓋掉別人剛改的內容）。
//!
//! 遠端的「檔案內容」一律先下載到暫存資料夾再比：內容比對、二進位比對、文字比對都只需要處理本機檔。

pub mod binary;
pub mod content;
pub mod diff;
pub mod glob;
pub mod linediff;
pub mod plan;
pub mod remote;
pub mod scan;
pub mod sessions;
pub mod side;
pub mod sync;
pub mod text;

use std::path::PathBuf;

/// 比對用的暫存根目錄（遠端檔下載到這裡再比）。每個比對分頁一個子資料夾，分頁關掉時整個刪掉。
pub fn temp_root() -> PathBuf {
    std::env::temp_dir().join("db-kit-compare")
}

/// 分頁鍵 → 暫存子資料夾名：只留英數、`-`、`_`（分頁鍵裡有 `:`，Windows 不能當檔名）。
pub fn scope_dir(scope: &str) -> PathBuf {
    let clean: String = scope
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    temp_root().join(if clean.is_empty() { "default".to_string() } else { clean })
}

/// 本機檔的修改時間（epoch 秒）。拿不到（檔案系統不支援）就是 `None`。
pub fn mtime_secs(md: &std::fs::Metadata) -> Option<u64> {
    md.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_dir_is_filename_safe() {
        let p = scope_dir("__cmp__:1234-abcd");
        assert!(p.ends_with("__cmp___1234-abcd"), "{}", p.display());
        assert!(scope_dir("").ends_with("default"));
    }
}
