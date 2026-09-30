//! 內容比對與遠端檔下載（GUI 的 `fcmp_content_check` / `cmp_fetch` 與 `dbk diff` 共用）。
//!
//! 遠端的檔一律先下載到暫存資料夾再比：SFTP / FTP 沒有「伺服器端算雜湊」的通用做法，
//! 逐位元組比對也需要兩邊的內容都在本機。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;

use super::binary;
use super::side::SideFs;
use crate::error::{AppError, AppResult};
use crate::ssh::files::FileClient;
use crate::ssh::sftp::{basename, sanitize_local_filename, OnConflict};

/// 遠端檔 → `dir` 底下的本機副本（檔名保留原本的副檔名，前面加一段 uuid 避免同名互蓋）。
pub async fn fetch_into(c: &FileClient, remote: &str, dir: &Path, cancel: &AtomicBool) -> AppResult<PathBuf> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| AppError::Compare(e.to_string()))?;
    let name = format!("{}-{}", &uuid::Uuid::new_v4().to_string()[..8], sanitize_local_filename(basename(remote)));
    let local = dir.join(name);
    let fs = c.transfer_fs(cancel).await?;
    fs.download(remote, &local, OnConflict::Overwrite, Box::new(|_, _| {}), cancel)
        .await
        .map_err(|e| if matches!(e, AppError::SshCancelled) { AppError::CompareCancelled } else { e })
}

/// 一邊某個檔的本機路徑：本機直接用；遠端先下載到 `dir`（第二項 = 用完要刪）。
pub async fn local_copy(fs: &SideFs, path: &str, dir: &Path, cancel: &AtomicBool) -> AppResult<(PathBuf, bool)> {
    match fs {
        SideFs::Local => Ok((PathBuf::from(path), false)),
        SideFs::Remote(c) => Ok((fetch_into(c, path, dir, cancel).await?, true)),
    }
}

#[derive(Debug, Clone)]
pub struct ContentPair {
    pub key: String,
    pub left: String,
    pub right: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContentResult {
    pub key: String,
    /// `None` = 讀不到（見 `error`）。
    pub equal: Option<bool>,
    pub error: Option<String>,
}

/// 逐一比對內容（`left` / `right` 是相對於各自根的路徑）。單一檔失敗不中斷，記在結果裡；取消則整批回錯。
/// `progress(已完成, 全部, 目前的鍵)`。暫存資料夾 `dir` 用完整個刪掉。
pub async fn check_pairs(
    lf: &SideFs,
    lroot: &str,
    rf: &SideFs,
    rroot: &str,
    pairs: Vec<ContentPair>,
    dir: &Path,
    cancel: &Arc<AtomicBool>,
    progress: &(dyn Fn(usize, usize, &str) + Send + Sync),
) -> AppResult<Vec<ContentResult>> {
    let total = pairs.len();
    let mut out = Vec::with_capacity(total);
    let r = async {
        for (i, p) in pairs.into_iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::CompareCancelled);
            }
            progress(i, total, &p.key);
            let r = pair_equal(lf, lroot, rf, rroot, &p, dir, cancel).await;
            match r {
                Ok(eq) => out.push(ContentResult { key: p.key, equal: Some(eq), error: None }),
                Err(AppError::CompareCancelled) | Err(AppError::SshCancelled) => return Err(AppError::CompareCancelled),
                Err(e) => out.push(ContentResult { key: p.key, equal: None, error: Some(e.message()) }),
            }
        }
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_dir_all(dir).await;
    r.map(|_| out)
}

async fn pair_equal(
    lf: &SideFs,
    lroot: &str,
    rf: &SideFs,
    rroot: &str,
    p: &ContentPair,
    dir: &Path,
    cancel: &Arc<AtomicBool>,
) -> AppResult<bool> {
    let a = lf.join(lroot, &p.left)?;
    let b = rf.join(rroot, &p.right)?;
    let (la, ta) = local_copy(lf, &a, dir, cancel).await?;
    let res = async {
        let (lb, tb) = local_copy(rf, &b, dir, cancel).await?;
        let c = cancel.clone();
        let (la2, lb2) = (la.clone(), lb.clone());
        let eq = tokio::task::spawn_blocking(move || binary::files_equal(&la2, &lb2, &c))
            .await
            .map_err(|e| AppError::Compare(e.to_string()))?;
        if tb {
            let _ = tokio::fs::remove_file(&lb).await;
        }
        eq
    }
    .await;
    if ta {
        let _ = tokio::fs::remove_file(&la).await;
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn check_local_pairs() {
        let base = std::env::temp_dir().join(format!("dbk-content-{}", uuid::Uuid::new_v4()));
        let (l, r) = (base.join("l"), base.join("r"));
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(l.join("same"), b"abc").unwrap();
        std::fs::write(r.join("same"), b"abc").unwrap();
        std::fs::write(l.join("diff"), b"abc").unwrap();
        std::fs::write(r.join("diff"), b"abd").unwrap();
        let pairs = ["same", "diff", "missing"]
            .iter()
            .map(|k| ContentPair { key: k.to_string(), left: k.to_string(), right: k.to_string() })
            .collect();
        let cancel = Arc::new(AtomicBool::new(false));
        let res = check_pairs(
            &SideFs::Local,
            &l.display().to_string(),
            &SideFs::Local,
            &r.display().to_string(),
            pairs,
            &base.join("tmp"),
            &cancel,
            &|_, _, _| {},
        )
        .await
        .unwrap();
        assert_eq!(res[0].equal, Some(true));
        assert_eq!(res[1].equal, Some(false));
        assert!(res[2].equal.is_none() && res[2].error.is_some());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
