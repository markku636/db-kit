//! 文字比對的本機檔讀寫。遠端檔先下載到暫存資料夾，所以這裡只處理本機路徑。

use std::path::Path;

use serde::Serialize;

use super::mtime_secs;
use crate::error::{AppError, AppResult};
use crate::ssh::sftp::decode_text;

/// 文字比對一次最多讀多大的檔。再大的檔在編輯器裡逐行比對也跑不動，改用二進位比對。
pub const TEXT_MAX: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct CmpText {
    pub text: String,
    pub truncated: bool,
    pub size: u64,
    pub mtime: Option<u64>,
    /// 有無效的 UTF-8（已以 U+FFFD 取代）。
    pub lossy: bool,
    /// 前 8 KiB 有 NUL：幾乎可以確定不是文字檔。
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CmpStat {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

fn io_err(path: &Path, e: std::io::Error) -> AppError {
    AppError::Compare(tf!("{path}：{e}", path = path.display(), e = e))
}

pub async fn stat(path: &Path) -> AppResult<CmpStat> {
    match tokio::fs::metadata(path).await {
        Ok(md) => Ok(CmpStat {
            exists: true,
            is_dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() },
            mtime: mtime_secs(&md),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(CmpStat { exists: false, is_dir: false, size: 0, mtime: None })
        }
        Err(e) => Err(io_err(path, e)),
    }
}

/// 讀文字檔（最多 `max`，0 = 上限）。超過標 `truncated`：比對視圖會提示「只比了前面一段」並禁止存檔。
pub async fn read(path: &Path, max: u64) -> AppResult<CmpText> {
    use tokio::io::AsyncReadExt;
    let cap = if max == 0 { TEXT_MAX } else { max.min(TEXT_MAX) };
    let md = tokio::fs::metadata(path).await.map_err(|e| io_err(path, e))?;
    if md.is_dir() {
        return Err(AppError::Compare(tf!("這是資料夾，不是檔案：{path}", path = path.display())));
    }
    let f = tokio::fs::File::open(path).await.map_err(|e| io_err(path, e))?;
    let mut buf = Vec::with_capacity(md.len().min(cap) as usize);
    f.take(cap + 1).read_to_end(&mut buf).await.map_err(|e| io_err(path, e))?;
    let truncated = buf.len() as u64 > cap;
    buf.truncate(cap as usize);
    let t = decode_text(buf, truncated, md.len());
    Ok(CmpText { text: t.text, truncated: t.truncated, size: t.size, mtime: mtime_secs(&md), lossy: t.lossy, binary: t.binary })
}

/// 寫回文字檔。`expected_mtime` 給了就先檢查：檔案在開啟之後被別人改過（時間對不上）就拒絕，
/// 回 `CompareConflict`，前端問使用者要不要照樣覆蓋（再呼叫一次、不帶 expected）。
/// 先寫同目錄的暫存檔再 rename，寫到一半失敗不會留下半個檔。
pub async fn write(path: &Path, content: &str, expected_mtime: Option<u64>) -> AppResult<CmpStat> {
    if let Some(exp) = expected_mtime {
        let cur = stat(path).await?;
        if cur.exists && cur.mtime.is_some_and(|m| m != exp) {
            return Err(AppError::CompareConflict(tf!(
                "檔案在開啟之後已被修改：{path}",
                path = path.display()
            )));
        }
    }
    let tmp = path.with_extension(format!(
        "{}dbk-save",
        path.extension().map(|e| format!("{}.", e.to_string_lossy())).unwrap_or_default()
    ));
    tokio::fs::write(&tmp, content.as_bytes()).await.map_err(|e| io_err(path, e))?;
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(io_err(path, e));
    }
    stat(path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_write_with_conflict_check() {
        let dir = std::env::temp_dir().join(format!("dbk-text-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.txt");
        std::fs::write(&p, "line1\nline2\n").unwrap();
        let r = read(&p, 0).await.unwrap();
        assert_eq!(r.text, "line1\nline2\n");
        assert!(!r.truncated && !r.binary && !r.lossy);
        let r2 = read(&p, 3).await.unwrap();
        assert_eq!((r2.text.as_str(), r2.truncated), ("lin", true));

        let st = write(&p, "new", r.mtime).await.unwrap();
        assert_eq!(st.size, 3);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "new");
        // 別人改過（mtime 對不上）→ 衝突
        let e = write(&p, "x", Some(1)).await;
        assert!(matches!(e, Err(AppError::CompareConflict(_))));
        write(&p, "forced", None).await.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "forced");
        // 暫存檔不留下
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
