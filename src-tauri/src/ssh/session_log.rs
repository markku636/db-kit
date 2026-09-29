//! 終端機工作階段記錄檔：前端把收到的輸出去完 ANSI、處理完 \r 重寫之後，大約每秒追加一次。
//! 這裡只負責寫檔（開始時清空、之後追加），不碰內容。

use std::path::Path;

use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};

/// 寫記錄檔：`truncate` = 開始記錄（清空重寫），否則追加到檔尾。檔案不存在就建立。
pub async fn write(path: &Path, text: &str, truncate: bool) -> AppResult<()> {
    let mut opts = tokio::fs::OpenOptions::new();
    opts.create(true).write(true);
    if truncate {
        opts.truncate(true);
    } else {
        opts.append(true);
    }
    let err = |e: std::io::Error| AppError::Storage(tf!("寫入記錄檔 {path} 失敗：{e}", path = path.display(), e = e));
    let mut f = opts.open(path).await.map_err(err)?;
    f.write_all(text.as_bytes()).await.map_err(err)?;
    f.flush().await.map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn truncate_then_append() {
        let dir = std::env::temp_dir().join(format!("dbkit-sesslog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("s.log");
        write(&p, "# header\n", true).await.unwrap();
        write(&p, "line 1\n", false).await.unwrap();
        write(&p, "line 2\n", false).await.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "# header\nline 1\nline 2\n");
        // 重新開始記錄會清空
        write(&p, "# again\n", true).await.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "# again\n");
        // 路徑不存在的資料夾 → 錯誤而不是 panic
        assert!(write(&dir.join("no/such/dir/x.log"), "x", true).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
