//! 本機系統剪貼簿的文字讀寫：SSH 終端機的複製 / 貼上、各處的「複製」、遠端桌面的剪貼簿同步共用。
//!
//! 在後端做，不用 webview 的 `navigator.clipboard`：
//! - Linux（WebKitGTK）：讀取一律被拒；有的版本連 `navigator.clipboard` 都沒有，寫入就安靜地什麼都沒做。
//! - macOS（WKWebView）：讀取會在游標旁跳出「貼上」小選單、要再點一下；寫入只能在按鍵 / 點擊的當下，
//!   先等後端拿資料（例如建表 SQL）再寫就被拒。
//! - Windows（WebView2）：讀取會跳權限詢問。
//!
//! Linux（X11；Wayland 下經 XWayland）剪貼簿裡的文字是由「複製的那個程式」自己供應的：arboard 的
//! `Clipboard` 一放掉，寫進去的文字就只剩剪貼簿管理員（有的話）接手的那份，沒有就跟著消失。所以 Linux
//! 整個 App 共用一個一直留著的 `Clipboard`，關閉 App 時才放掉（arboard 會在那時交給剪貼簿管理員）；
//! Windows / macOS 由系統保存內容，每次開一個、用完就放。

use crate::error::{AppError, AppResult};

/// 讀剪貼簿的文字；沒有文字（空的、或放的是圖片 / 檔案）回空字串。
pub fn read_text() -> AppResult<String> {
    with_clipboard(|c| match c.get_text() {
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        r => r,
    })
    .map_err(|e| AppError::Clipboard(tf!("無法讀取剪貼簿：{e}", e = e)))
}

/// 把文字寫進剪貼簿。
pub fn write_text(text: String) -> AppResult<()> {
    with_clipboard(|c| c.set_text(text)).map_err(|e| AppError::Clipboard(tf!("無法寫入剪貼簿：{e}", e = e)))
}

#[cfg(target_os = "linux")]
static SHARED: parking_lot::Mutex<Option<arboard::Clipboard>> = parking_lot::Mutex::new(None);

#[cfg(target_os = "linux")]
fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>) -> Result<T, arboard::Error> {
    let mut slot = SHARED.lock();
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new()?);
    }
    let r = f(slot.as_mut().expect("clipboard just opened"));
    // 跟 X server 的連線斷了（例如 XWayland 重啟）就丟掉，下次重開一個，不要一直卡在壞掉的那個。
    if matches!(r, Err(arboard::Error::ClipboardNotSupported | arboard::Error::Unknown { .. })) {
        *slot = None;
    }
    r
}

#[cfg(not(target_os = "linux"))]
fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>) -> Result<T, arboard::Error> {
    f(&mut arboard::Clipboard::new()?)
}

/// 關閉 App 時呼叫：Linux 放掉共用的 `Clipboard`，讓 arboard 把 App 複製的文字交給剪貼簿管理員，關掉後還貼得到。
pub fn release() {
    #[cfg(target_os = "linux")]
    drop(SHARED.lock().take());
}

/// 讀剪貼簿的文字（沒有文字回空字串）。不在主執行緒讀：別的程式占著剪貼簿時 arboard 會重試，
/// X11 也要等擁有者回應，介面不該跟著卡住。
#[tauri::command]
pub async fn clipboard_read_text() -> AppResult<String> {
    tokio::task::spawn_blocking(read_text).await.map_err(|e| AppError::Clipboard(e.to_string()))?
}

/// 把文字寫進剪貼簿。
#[tauri::command]
pub fn clipboard_write_text(text: String) -> AppResult<()> {
    write_text(text)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn xclip_out() -> String {
        let out = Command::new("xclip").args(["-o", "-selection", "clipboard"]).output().expect("xclip");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn xclip_in(text: &str) {
        let mut child = Command::new("xclip")
            .args(["-i", "-selection", "clipboard"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("xclip");
        child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
        child.wait().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    /// 跟別的程式互通（Ubuntu 上 SSH 終端機的複製 / 貼上）。要有 X server 與 xclip：
    /// `xvfb-run cargo test --lib -- --ignored clipboard::tests`
    #[test]
    #[ignore]
    fn round_trips_with_other_x11_programs() {
        write_text("db-kit 複製的 ls -la".into()).unwrap();
        assert_eq!(xclip_out(), "db-kit 複製的 ls -la", "別的程式貼得到 App 複製的文字");
        // 第二次讀：內容由一直留著的 Clipboard 供應，不會讀一次就沒了。
        assert_eq!(xclip_out(), "db-kit 複製的 ls -la");
        assert_eq!(read_text().unwrap(), "db-kit 複製的 ls -la", "自己複製的自己也讀得到");

        xclip_in("別的程式複製的 echo hi");
        assert_eq!(read_text().unwrap(), "別的程式複製的 echo hi", "App 貼得到別的程式複製的文字");

        write_text("再複製一次".into()).unwrap();
        assert_eq!(xclip_out(), "再複製一次", "別的程式複製過之後，App 再複製照樣蓋過去");
    }
}
