//! 遠端桌面錄影的檔案端：前端用 MediaRecorder 錄分頁畫面（WebM），每秒交一段過來，這裡依序寫進檔案。
//!
//! - 邊錄邊寫，不在記憶體裡累積；錄到一半 App 當掉，已寫的部分仍是播得動的 WebM。
//! - 檔案一律放在錄影資料夾（系統「影片」資料夾底下的 `db-kit`，沒有就退到下載 / 家目錄），檔名由這裡決定
//!   （主機名稱 + 時間）；前端給不了任意路徑，「在資料夾中顯示」也只開這個資料夾。
//! - 截圖（PNG）同樣做法，放在系統「圖片」資料夾底下的 `db-kit`。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::error::{AppError, AppResult};

struct Open {
    path: PathBuf,
    file: std::fs::File,
}

fn open_files() -> &'static Mutex<HashMap<String, Open>> {
    static FILES: OnceLock<Mutex<HashMap<String, Open>>> = OnceLock::new();
    FILES.get_or_init(Default::default)
}

/// 錄影資料夾。
pub fn dir() -> AppResult<PathBuf> {
    let base = dirs::video_dir()
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)
        .ok_or_else(|| AppError::Rd(t!("找不到可以存放錄影的資料夾").into()))?;
    Ok(base.join("db-kit"))
}

/// 檔名用的主機名稱：拿掉路徑分隔與 Windows 不收的字元，太長截掉；空的叫 `remote`。
pub fn safe_name(name: &str) -> String {
    let s: String = name
        .trim()
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .take(60)
        .collect();
    let s = s.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    if s.is_empty() {
        "remote".into()
    } else {
        s
    }
}

/// 在 `dir`（已存在）開一個新檔 `<主機>_<時間>.<ext>`（同一秒已有就加 `-2`、`-3`…；不覆蓋既有檔案）。
fn create_unique(dir: &Path, name: &str, stamp: &str, ext: &str) -> std::io::Result<(PathBuf, std::fs::File)> {
    let base = format!("{}_{}", safe_name(name), stamp);
    let mut n = 1;
    loop {
        let path = dir.join(if n == 1 { format!("{base}.{ext}") } else { format!("{base}-{n}.{ext}") });
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(f) => return Ok((path, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 100 => n += 1,
            Err(e) => return Err(e),
        }
    }
}

/// 開一個新的錄影檔（`<主機>_<年月日-時分秒>.webm`；同一秒已有就加 `-2`、`-3`…）。回傳 (id, 路徑)。
pub fn start_in(dir: &Path, name: &str, stamp: &str) -> AppResult<(String, PathBuf)> {
    std::fs::create_dir_all(dir).map_err(|e| AppError::Rd(tf!("無法建立錄影資料夾：{e}", e = e)))?;
    let (path, file) =
        create_unique(dir, name, stamp, "webm").map_err(|e| AppError::Rd(tf!("無法建立錄影檔：{e}", e = e)))?;
    let id = uuid::Uuid::new_v4().to_string();
    open_files().lock().unwrap().insert(id.clone(), Open { path: path.clone(), file });
    Ok((id, path))
}

pub fn start(name: &str) -> AppResult<(String, PathBuf)> {
    start_in(&dir()?, name, &chrono::Local::now().format("%Y%m%d-%H%M%S").to_string())
}

/// 接著寫一段。
pub fn write(id: &str, bytes: &[u8]) -> AppResult<()> {
    let mut files = open_files().lock().unwrap();
    let f = files.get_mut(id).ok_or_else(|| AppError::Rd(t!("錄影已經結束").into()))?;
    f.file.write_all(bytes).map_err(|e| AppError::Rd(tf!("寫入錄影檔失敗：{e}", e = e)))
}

/// 結束：關檔，回傳路徑。什麼都沒錄到（0 bytes）就刪掉、回 None。
pub fn stop(id: &str) -> AppResult<Option<PathBuf>> {
    let Some(mut f) = open_files().lock().unwrap().remove(id) else { return Ok(None) };
    let _ = f.file.flush();
    let empty = f.file.metadata().map(|m| m.len() == 0).unwrap_or(false);
    drop(f.file);
    if empty {
        let _ = std::fs::remove_file(&f.path);
        return Ok(None);
    }
    Ok(Some(f.path))
}

/// 截圖資料夾。
pub fn shots_dir() -> AppResult<PathBuf> {
    let base = dirs::picture_dir()
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)
        .ok_or_else(|| AppError::Rd(t!("找不到可以存放截圖的資料夾").into()))?;
    Ok(base.join("db-kit"))
}

/// 存一張截圖（`<主機>_<年月日-時分秒>.png`）。只收 PNG。回傳路徑。
pub fn save_shot_in(dir: &Path, name: &str, stamp: &str, png: &[u8]) -> AppResult<PathBuf> {
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::Rd("not a PNG image".into()));
    }
    std::fs::create_dir_all(dir).map_err(|e| AppError::Rd(tf!("無法建立截圖資料夾：{e}", e = e)))?;
    let (path, mut file) =
        create_unique(dir, name, stamp, "png").map_err(|e| AppError::Rd(tf!("截圖存檔失敗：{e}", e = e)))?;
    if let Err(e) = file.write_all(png) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(AppError::Rd(tf!("截圖存檔失敗：{e}", e = e)));
    }
    Ok(path)
}

pub fn save_shot(name: &str, png: &[u8]) -> AppResult<PathBuf> {
    save_shot_in(&shots_dir()?, name, &chrono::Local::now().format("%Y%m%d-%H%M%S").to_string(), png)
}

/// 前端用 `encodeURIComponent` 放進 header 的主機名稱（header 只收 ASCII）。解不出來的部分原樣留著。
pub fn decode_header_name(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 「在資料夾中顯示」只接受錄影 / 截圖資料夾裡的檔案（不讓這支變成任意路徑開啟器）。回傳要開的資料夾。
pub fn reveal_target(dirs: &[PathBuf], path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    let parent = p.parent().map(Path::to_path_buf).unwrap_or_default();
    let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !dirs.iter().any(|d| same(&parent, d)) {
        return Err(AppError::Rd(t!("不是錄影資料夾裡的檔案").into()));
    }
    Ok(parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbkit-rec-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn names_are_safe() {
        assert_eq!(safe_name("office-pc"), "office-pc");
        assert_eq!(safe_name(r#"a/b\c:d*e?"f<g>h|"#), "a_b_c_d_e__f_g_h_");
        assert_eq!(safe_name("  ..  "), "remote");
        assert_eq!(safe_name("辦公室電腦"), "辦公室電腦");
        assert_eq!(safe_name(&"x".repeat(200)).chars().count(), 60);
    }

    #[test]
    fn write_in_order_then_stop() {
        let d = tmp("order");
        let (id, path) = start_in(&d, "office-pc", "20261002-120000").unwrap();
        assert_eq!(path.file_name().unwrap(), "office-pc_20261002-120000.webm");
        write(&id, b"abc").unwrap();
        write(&id, b"def").unwrap();
        assert_eq!(stop(&id).unwrap().as_deref(), Some(path.as_path()));
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
        assert!(write(&id, b"x").is_err(), "結束後不能再寫");
        assert_eq!(stop(&id).unwrap(), None, "重複結束不出錯");
        // 同一秒再錄一次 → 不覆蓋
        let (id2, p2) = start_in(&d, "office-pc", "20261002-120000").unwrap();
        assert_eq!(p2.file_name().unwrap(), "office-pc_20261002-120000-2.webm");
        // 什麼都沒錄到 → 刪掉
        assert_eq!(stop(&id2).unwrap(), None);
        assert!(!p2.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn reveal_only_inside_the_folder() {
        let d = tmp("reveal");
        let shots = tmp("reveal-shots");
        let (id, path) = start_in(&d, "h", "1").unwrap();
        write(&id, b"x").unwrap();
        stop(&id).unwrap();
        let shot = save_shot_in(&shots, "h", "1", PNG).unwrap();
        let both = [d.clone(), shots.clone()];
        assert!(reveal_target(&both, path.to_str().unwrap()).is_ok());
        assert!(reveal_target(&both, shot.to_str().unwrap()).is_ok());
        assert!(reveal_target(&[d.clone()], shot.to_str().unwrap()).is_err(), "沒列出的資料夾不收");
        assert!(reveal_target(&both, std::env::temp_dir().join("x.webm").to_str().unwrap()).is_err());
        assert!(reveal_target(&both, "C:/Windows/notepad.exe").is_err());
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&shots);
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn screenshots_are_png_and_never_overwrite() {
        let d = tmp("shots");
        let p1 = save_shot_in(&d, "mac/mini", "20261002-120000", PNG).unwrap();
        assert_eq!(p1.file_name().unwrap(), "mac_mini_20261002-120000.png");
        assert_eq!(std::fs::read(&p1).unwrap(), PNG);
        let p2 = save_shot_in(&d, "mac/mini", "20261002-120000", PNG).unwrap();
        assert_eq!(p2.file_name().unwrap(), "mac_mini_20261002-120000-2.png");
        assert!(save_shot_in(&d, "x", "1", b"GIF89a").is_err(), "不是 PNG 不存");
        assert!(!d.join("x_1.png").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn header_names_are_percent_decoded() {
        assert_eq!(decode_header_name("mac-mini"), "mac-mini");
        assert_eq!(decode_header_name("%E8%BE%A6%E5%85%AC%E5%AE%A4%20pc"), "辦公室 pc");
        assert_eq!(decode_header_name("100%"), "100%");
        assert_eq!(decode_header_name("a%zzb%4"), "a%zzb%4");
    }
}
