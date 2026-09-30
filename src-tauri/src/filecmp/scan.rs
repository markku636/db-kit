//! 把一邊的資料夾樹掃成扁平清單。先整棵掃完再比對：對齊需要兩邊完整的清單，
//! 使用者也要先看到總數才知道同步要做多少事。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use super::glob::excluded;
use super::side::SideFs;
use crate::error::{AppError, AppResult};

/// 一次比對一邊最多掃幾個項目（檔案 + 資料夾）。誤選到 `/` 或整顆磁碟時先擋下來，而不是掃好幾分鐘。
pub const SCAN_MAX_ENTRIES: usize = 200_000;

/// 掃到的一個項目。`rel` 是相對於根、以 `/` 分段的路徑（根本身不列）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Node {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

#[derive(Debug, Default, Serialize)]
pub struct ScanResult {
    pub nodes: Vec<Node>,
    /// 略過的項目數（指向資料夾的 symlink、特殊檔、不合法的檔名；排除規則命中的不算）。
    pub skipped: usize,
    /// 讀不到的資料夾（權限不足等）：(相對路徑, 錯誤訊息)。整次掃描不因此失敗。
    pub errors: Vec<(String, String)>,
}

pub struct ScanOpts<'a> {
    pub excludes: &'a [String],
    pub max_entries: usize,
}

/// 深度優先掃描 `root`。`progress(已掃項目數)` 每讀完一個資料夾呼叫一次。
/// 根讀不到直接回錯；更深的資料夾讀不到記在 `errors` 裡繼續。
pub async fn scan(
    fs: &SideFs,
    root: &str,
    opts: &ScanOpts<'_>,
    cancel: &AtomicBool,
    progress: &(dyn Fn(usize) + Send + Sync),
) -> AppResult<ScanResult> {
    let mut res = ScanResult::default();
    let mut stack: Vec<String> = vec![String::new()];
    while let Some(rel) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::CompareCancelled);
        }
        let dir = fs.join(root, &rel)?;
        let (items, skipped) = match fs.list(&dir).await {
            Ok(v) => v,
            Err(e) if rel.is_empty() => return Err(e),
            Err(e) => {
                res.errors.push((rel.clone(), e.message()));
                continue;
            }
        };
        res.skipped += skipped;
        for it in items {
            let child = if rel.is_empty() { it.name.clone() } else { format!("{rel}/{}", it.name) };
            if excluded(opts.excludes, &it.name, &child) {
                continue;
            }
            if it.is_dir {
                stack.push(child.clone());
            }
            res.nodes.push(Node { rel: child, name: it.name, is_dir: it.is_dir, size: it.size, mtime: it.mtime });
            if res.nodes.len() > opts.max_entries {
                return Err(AppError::Compare(tf!(
                    "項目超過 {max} 個，請改選範圍較小的資料夾或加上排除規則",
                    max = opts.max_entries
                )));
            }
        }
        progress(res.nodes.len());
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scans_tree_with_excludes_and_cap() {
        let dir = std::env::temp_dir().join(format!("dbk-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src/sub")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("src/a.rs"), b"a").unwrap();
        std::fs::write(dir.join("src/sub/b.log"), b"bb").unwrap();
        std::fs::write(dir.join("node_modules/pkg/x.js"), b"x").unwrap();
        let root = dir.display().to_string();
        let ex = vec!["node_modules".to_string(), "*.log".to_string()];
        let cancel = AtomicBool::new(false);
        let r = scan(&SideFs::Local, &root, &ScanOpts { excludes: &ex, max_entries: 100 }, &cancel, &|_| {})
            .await
            .unwrap();
        let mut rels: Vec<_> = r.nodes.iter().map(|n| n.rel.as_str()).collect();
        rels.sort();
        assert_eq!(rels, vec!["src", "src/a.rs", "src/sub"]);

        let err = scan(&SideFs::Local, &root, &ScanOpts { excludes: &[], max_entries: 3 }, &cancel, &|_| {}).await;
        assert!(matches!(err, Err(AppError::Compare(_))));

        cancel.store(true, Ordering::Relaxed);
        let err = scan(&SideFs::Local, &root, &ScanOpts { excludes: &[], max_entries: 100 }, &cancel, &|_| {}).await;
        assert!(matches!(err, Err(AppError::CompareCancelled)));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
