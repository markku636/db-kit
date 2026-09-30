//! 比對的一邊：本機檔案系統，或一條已開的檔案工作階段（SFTP / FTP）。
//!
//! 路徑一律是「根 + 相對路徑」：相對路徑用 `/` 分段（兩邊一致，也是前端看到的樣子），
//! 每一段都驗過（拒空、`.`、`..`、分隔字元），前端傳回來的相對路徑因此不能跳出根。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use super::mtime_secs;
use crate::error::{AppError, AppResult};
use crate::ssh::files::FileClient;
use crate::ssh::sftp::{is_root_like, remote_join, remote_join_segments};

pub enum SideFs {
    Local,
    Remote(Arc<FileClient>),
}

/// 列目錄的一個項目（已決定好是資料夾還是檔案；symlink 已跟過，指向資料夾的不列）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

/// 一個相對路徑段是否可用（前端傳回來的相對路徑逐段檢查）。
fn valid_segment(s: &str) -> bool {
    !(s.is_empty() || s == "." || s == ".." || s.contains('/') || s.contains('\\') || s.contains('\0'))
}

/// 相對路徑（`a/b/c`）→ 路徑段。空字串 = 根本身。
pub fn segments(rel: &str) -> AppResult<Vec<String>> {
    if rel.is_empty() {
        return Ok(Vec::new());
    }
    let segs: Vec<String> = rel.split('/').map(str::to_string).collect();
    if segs.iter().any(|s| !valid_segment(s)) {
        return Err(AppError::Compare(tf!("無效的相對路徑：{rel}", rel = rel)));
    }
    Ok(segs)
}

pub fn local_join(root: &str, rel: &str) -> AppResult<PathBuf> {
    let mut p = PathBuf::from(root);
    for s in segments(rel)? {
        p.push(s);
    }
    Ok(p)
}

fn local_err(e: std::io::Error, path: &Path) -> AppError {
    AppError::Compare(tf!("{path}：{e}", path = path.display(), e = e))
}

impl SideFs {
    pub fn is_local(&self) -> bool {
        matches!(self, SideFs::Local)
    }

    /// 根 + 相對路徑 → 這一邊的完整路徑字串。
    pub fn join(&self, root: &str, rel: &str) -> AppResult<String> {
        match self {
            SideFs::Local => Ok(local_join(root, rel)?.display().to_string()),
            SideFs::Remote(_) => {
                let segs = segments(rel)?;
                if segs.is_empty() {
                    Ok(root.to_string())
                } else {
                    remote_join_segments(root, &segs)
                }
            }
        }
    }

    /// 列目錄。回傳（項目, 略過數）：略過的是指向資料夾的 symlink（可能繞回自己）、讀不到目標的
    /// symlink、特殊檔、以及本機不是合法 UTF-8 的檔名。
    pub async fn list(&self, dir: &str) -> AppResult<(Vec<Entry>, usize)> {
        match self {
            SideFs::Local => list_local(Path::new(dir)).await,
            SideFs::Remote(c) => {
                let mut out = Vec::new();
                let mut skipped = 0;
                for e in c.list_dir(dir).await? {
                    if e.is_symlink {
                        match e.link_target_is_dir {
                            Some(false) => {}
                            _ => {
                                skipped += 1;
                                continue;
                            }
                        }
                    }
                    out.push(Entry { name: e.name, is_dir: e.is_dir && !e.is_symlink, size: e.size, mtime: e.mtime });
                }
                Ok((out, skipped))
            }
        }
    }

    /// 單一路徑的屬性；不存在回 `None`。
    pub async fn stat(&self, path: &str) -> AppResult<Option<Entry>> {
        match self {
            SideFs::Local => match tokio::fs::metadata(path).await {
                Ok(md) => Ok(Some(Entry {
                    name: file_name(path),
                    is_dir: md.is_dir(),
                    size: if md.is_dir() { 0 } else { md.len() },
                    mtime: mtime_secs(&md),
                })),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(local_err(e, Path::new(path))),
            },
            SideFs::Remote(c) => match c.stat(path).await {
                Ok(e) => Ok(Some(Entry {
                    name: e.name,
                    is_dir: e.is_dir || e.link_target_is_dir == Some(true),
                    size: e.size,
                    mtime: e.mtime,
                })),
                // 遠端的「不存在」沒有穩定的錯誤碼可認（SFTP 狀態碼已被本地化成訊息、FTP 是 550 文字），
                // 任何錯誤都當成不存在：呼叫端接下來的建立 / 上傳若真有問題會自己報錯。
                Err(_) => Ok(None),
            },
        }
    }

    /// 建資料夾（含所有上層；已存在就沿用）。`root` 本身必須已存在。
    pub async fn mkdir_all(&self, root: &str, rel: &str) -> AppResult<()> {
        match self {
            SideFs::Local => {
                let p = local_join(root, rel)?;
                tokio::fs::create_dir_all(&p).await.map_err(|e| local_err(e, &p))
            }
            SideFs::Remote(c) => {
                let mut cur = root.to_string();
                for s in segments(rel)? {
                    cur = remote_join(&cur, &s)?;
                    match c.stat(&cur).await {
                        Ok(e) if e.is_dir || e.link_target_is_dir == Some(true) => {}
                        Ok(_) => {
                            return Err(AppError::Compare(tf!("已有同名檔案，無法建立資料夾：{path}", path = cur)));
                        }
                        Err(_) => c.mkdir(&cur).await?,
                    }
                }
                Ok(())
            }
        }
    }

    /// 刪除（資料夾整個刪）。拒絕根目錄這類目標：相對路徑空白 = 比對的根本身，一律不刪。
    pub async fn remove(&self, root: &str, rel: &str, is_dir: bool) -> AppResult<()> {
        if rel.is_empty() {
            return Err(AppError::Compare(t!("不能刪除比對的根資料夾").into()));
        }
        let path = self.join(root, rel)?;
        match self {
            SideFs::Local => {
                let p = Path::new(&path);
                let r = if is_dir { tokio::fs::remove_dir_all(p).await } else { tokio::fs::remove_file(p).await };
                match r {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(local_err(e, p)),
                }
            }
            SideFs::Remote(c) => {
                if is_root_like(&path) {
                    return Err(AppError::Compare(t!("不能刪除比對的根資料夾").into()));
                }
                c.remove(&path, is_dir).await
            }
        }
    }

    /// 設定修改時間（盡力而為：設不了就算了，回 `false`）。
    pub async fn set_mtime(&self, path: &str, mtime: u64) -> bool {
        match self {
            SideFs::Local => set_local_mtime(Path::new(path), mtime).is_ok(),
            SideFs::Remote(c) => c.set_mtime(path, mtime).await.unwrap_or(false),
        }
    }
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn set_local_mtime(path: &Path, mtime: u64) -> std::io::Result<()> {
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime);
    std::fs::OpenOptions::new().write(true).open(path)?.set_modified(t)
}

async fn list_local(dir: &Path) -> AppResult<(Vec<Entry>, usize)> {
    let mut rd = tokio::fs::read_dir(dir).await.map_err(|e| local_err(e, dir))?;
    let mut out = Vec::new();
    let mut skipped = 0;
    while let Some(de) = rd.next_entry().await.map_err(|e| local_err(e, dir))? {
        let Ok(name) = de.file_name().into_string() else {
            skipped += 1;
            continue;
        };
        let Ok(ft) = de.file_type().await else {
            skipped += 1;
            continue;
        };
        // symlink / junction：跟著走看目標；指向資料夾的略過（可能繞回自己形成無限迴圈），
        // 指向檔案的當成那個檔案。
        let md = if ft.is_symlink() {
            match tokio::fs::metadata(de.path()).await {
                Ok(m) if m.is_file() => m,
                _ => {
                    skipped += 1;
                    continue;
                }
            }
        } else {
            match de.metadata().await {
                Ok(m) => m,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            }
        };
        if md.is_dir() {
            out.push(Entry { name, is_dir: true, size: 0, mtime: mtime_secs(&md) });
        } else if md.is_file() {
            out.push(Entry { name, is_dir: false, size: md.len(), mtime: mtime_secs(&md) });
        } else {
            skipped += 1;
        }
    }
    Ok((out, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_reject_traversal() {
        assert_eq!(segments("").unwrap(), Vec::<String>::new());
        assert_eq!(segments("a/b").unwrap(), vec!["a", "b"]);
        assert!(segments("a/../b").is_err());
        assert!(segments("/a").is_err());
        assert!(segments("a//b").is_err());
        assert!(segments("a\\b").is_err());
        assert!(segments(".").is_err());
    }

    #[tokio::test]
    async fn local_list_mkdir_remove() {
        let dir = std::env::temp_dir().join(format!("dbk-side-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.display().to_string();
        let fs = SideFs::Local;
        fs.mkdir_all(&root, "x/y").await.unwrap();
        std::fs::write(dir.join("x").join("f.txt"), b"hello").unwrap();
        let (mut items, skipped) = fs.list(&fs.join(&root, "x").unwrap()).await.unwrap();
        items.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(skipped, 0);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "f.txt");
        assert!(!items[0].is_dir);
        assert_eq!(items[0].size, 5);
        assert!(items[1].is_dir);

        let f = fs.join(&root, "x/f.txt").unwrap();
        assert!(fs.set_mtime(&f, 1_700_000_000).await);
        assert_eq!(fs.stat(&f).await.unwrap().unwrap().mtime, Some(1_700_000_000));

        assert!(fs.remove(&root, "", true).await.is_err());
        fs.remove(&root, "x", true).await.unwrap();
        assert!(fs.stat(&fs.join(&root, "x").unwrap()).await.unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
