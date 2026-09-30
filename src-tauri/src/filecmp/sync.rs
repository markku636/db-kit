//! 資料夾比對的同步：照前端給的操作清單（複製 → / 複製 ← / 刪左 / 刪右）執行。
//!
//! 四種組合（本機↔本機、本機↔遠端、遠端↔本機、遠端↔遠端）共用同一條路：先把資料夾展開成
//! 「要建的資料夾 + 要複製的檔案」，算好總量給進度條，再一個一個檔複製。遠端↔遠端沒有直接的
//! 伺服器對伺服器複製，經本機暫存檔中轉。
//!
//! 複製完把目的檔的修改時間設成來源的時間（FTP 做不到就算了）：否則重新比對時每個剛複製的檔
//! 都會因為時間不同又被標成不同。單一項目失敗不中斷整批，記在報告裡；取消則立即停。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::scan::{scan, ScanOpts, SCAN_MAX_ENTRIES};
use super::side::SideFs;
use crate::error::{AppError, AppResult};
use crate::ssh::sftp::{OnConflict, ProgressFn, RemoteFs};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    CopyLr,
    CopyRl,
    DeleteLeft,
    DeleteRight,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncOp {
    pub kind: OpKind,
    /// 複製的來源 / 刪除的目標在那一邊的相對路徑。
    pub src: String,
    /// 複製的目的相對路徑（大小寫不敏感對齊時可能與 `src` 大小寫不同）；刪除不用。
    #[serde(default)]
    pub dst: Option<String>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncProgress {
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_items: usize,
    pub total_items: usize,
    pub current: String,
}

#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    pub copied: usize,
    pub deleted: usize,
    /// 失敗的項目：(相對路徑, 錯誤訊息)。
    pub failed: Vec<(String, String)>,
    /// 有幾個複製的檔沒能保留修改時間（FTP）。前端據此提示「重新比對可能仍顯示時間不同」。
    pub mtime_not_kept: usize,
}

pub struct Endpoint<'a> {
    pub fs: &'a SideFs,
    pub root: &'a str,
}

enum Task {
    Mkdir { to_right: bool, rel: String },
    Copy { to_right: bool, src: String, dst: String, size: u64, mtime: Option<u64> },
    Delete { left: bool, rel: String, is_dir: bool },
}

fn parent_rel(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

fn join_rel(base: &str, rel: &str) -> String {
    if base.is_empty() {
        rel.to_string()
    } else {
        format!("{base}/{rel}")
    }
}

pub struct Syncer<'a> {
    pub left: Endpoint<'a>,
    pub right: Endpoint<'a>,
    pub excludes: &'a [String],
    /// 遠端↔遠端中轉用的暫存資料夾。
    pub temp: PathBuf,
    pub cancel: &'a AtomicBool,
    pub progress: Arc<dyn Fn(SyncProgress) + Send + Sync>,
    left_tfs: Option<Arc<dyn RemoteFs>>,
    right_tfs: Option<Arc<dyn RemoteFs>>,
    made_dirs: HashSet<(bool, String)>,
}

impl<'a> Syncer<'a> {
    pub fn new(
        left: Endpoint<'a>,
        right: Endpoint<'a>,
        excludes: &'a [String],
        temp: PathBuf,
        cancel: &'a AtomicBool,
        progress: Arc<dyn Fn(SyncProgress) + Send + Sync>,
    ) -> Self {
        Self { left, right, excludes, temp, cancel, progress, left_tfs: None, right_tfs: None, made_dirs: HashSet::new() }
    }

    fn side(&self, left: bool) -> &Endpoint<'a> {
        if left {
            &self.left
        } else {
            &self.right
        }
    }

    fn check_cancel(&self) -> AppResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(AppError::CompareCancelled)
        } else {
            Ok(())
        }
    }

    /// 遠端那一邊的傳輸用檔案系統（FTP 另開一條連線），每邊只開一次。
    async fn tfs(&mut self, left: bool) -> AppResult<Arc<dyn RemoteFs>> {
        let slot = if left { &self.left_tfs } else { &self.right_tfs };
        if let Some(t) = slot {
            return Ok(t.clone());
        }
        let SideFs::Remote(c) = self.side(left).fs else {
            return Err(AppError::Compare("not a remote side".into()));
        };
        let t = c.transfer_fs(self.cancel).await?;
        if left {
            self.left_tfs = Some(t.clone());
        } else {
            self.right_tfs = Some(t.clone());
        }
        Ok(t)
    }

    /// 操作清單 → 具體工作（資料夾展開成底下所有的資料夾與檔案）。
    async fn plan(&self, ops: &[SyncOp]) -> AppResult<Vec<Task>> {
        let mut tasks = Vec::new();
        let mut deletes = Vec::new();
        for op in ops {
            self.check_cancel()?;
            match op.kind {
                OpKind::DeleteLeft | OpKind::DeleteRight => deletes.push(Task::Delete {
                    left: op.kind == OpKind::DeleteLeft,
                    rel: op.src.clone(),
                    is_dir: op.is_dir,
                }),
                OpKind::CopyLr | OpKind::CopyRl => {
                    let to_right = op.kind == OpKind::CopyLr;
                    // 複製到右邊 = 來源在左邊。
                    let src_side = self.side(to_right);
                    let dst = op.dst.clone().unwrap_or_else(|| op.src.clone());
                    let src_path = src_side.fs.join(src_side.root, &op.src)?;
                    if op.is_dir {
                        tasks.push(Task::Mkdir { to_right, rel: dst.clone() });
                        let opts = ScanOpts { excludes: self.excludes, max_entries: SCAN_MAX_ENTRIES };
                        let sub = scan(src_side.fs, &src_path, &opts, self.cancel, &|_| {}).await?;
                        for n in sub.nodes {
                            if n.is_dir {
                                tasks.push(Task::Mkdir { to_right, rel: join_rel(&dst, &n.rel) });
                            } else {
                                tasks.push(Task::Copy {
                                    to_right,
                                    src: join_rel(&op.src, &n.rel),
                                    dst: join_rel(&dst, &n.rel),
                                    size: n.size,
                                    mtime: n.mtime,
                                });
                            }
                        }
                    } else {
                        let st = src_side
                            .fs
                            .stat(&src_path)
                            .await?
                            .ok_or_else(|| AppError::Compare(tf!("來源已不存在：{path}", path = src_path)))?;
                        tasks.push(Task::Copy { to_right, src: op.src.clone(), dst, size: st.size, mtime: st.mtime });
                    }
                }
            }
        }
        // 先複製、後刪除：複製途中失敗 / 取消時，還沒刪到任何東西。
        tasks.extend(deletes);
        Ok(tasks)
    }

    pub async fn run(&mut self, ops: &[SyncOp]) -> AppResult<SyncReport> {
        let tasks = self.plan(ops).await?;
        let total_bytes: u64 = tasks.iter().map(|t| if let Task::Copy { size, .. } = t { *size } else { 0 }).sum();
        let total_items = tasks.len();
        let mut report = SyncReport::default();
        let mut done_bytes = 0u64;
        for (i, task) in tasks.iter().enumerate() {
            self.check_cancel()?;
            let current = match task {
                Task::Mkdir { rel, .. } | Task::Delete { rel, .. } => rel.clone(),
                Task::Copy { dst, .. } => dst.clone(),
            };
            (self.progress)(SyncProgress { done_bytes, total_bytes, done_items: i, total_items, current: current.clone() });
            let r = match task {
                Task::Mkdir { to_right, rel } => self.ensure_dir(!*to_right, rel).await,
                Task::Copy { to_right, src, dst, size, mtime } => {
                    let base = done_bytes;
                    let total = total_bytes;
                    let progress = self.progress.clone();
                    let (items, cur) = (i, current.clone());
                    let pf: ProgressFn = Box::new(move |d, _| {
                        progress(SyncProgress {
                            done_bytes: base + d,
                            total_bytes: total,
                            done_items: items,
                            total_items,
                            current: cur.clone(),
                        })
                    });
                    let r = self.copy_file(*to_right, src, dst, *mtime, pf).await;
                    done_bytes += size;
                    match r {
                        Ok(kept) => {
                            report.copied += 1;
                            if !kept {
                                report.mtime_not_kept += 1;
                            }
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }
                Task::Delete { left, rel, is_dir } => {
                    let side = self.side(*left);
                    let r = side.fs.remove(side.root, rel, *is_dir).await;
                    if r.is_ok() {
                        report.deleted += 1;
                    }
                    r
                }
            };
            match r {
                Ok(()) => {}
                Err(AppError::CompareCancelled) | Err(AppError::SshCancelled) => return Err(AppError::CompareCancelled),
                Err(e) => report.failed.push((current, e.message())),
            }
        }
        (self.progress)(SyncProgress { done_bytes, total_bytes, done_items: total_items, total_items, current: String::new() });
        Ok(report)
    }

    /// 目的那一邊的資料夾（含上層）。`on_left` = 建在左邊。
    async fn ensure_dir(&mut self, on_left: bool, rel: &str) -> AppResult<()> {
        if rel.is_empty() || self.made_dirs.contains(&(on_left, rel.to_string())) {
            return Ok(());
        }
        let side = self.side(on_left);
        // 同名的是檔案（型別不同的項目被複製過來）：先刪掉那個檔，資料夾才建得起來。
        let path = side.fs.join(side.root, rel)?;
        if let Some(e) = side.fs.stat(&path).await? {
            if !e.is_dir {
                side.fs.remove(side.root, rel, false).await?;
            }
        }
        side.fs.mkdir_all(side.root, rel).await?;
        // 上層也都建好了。
        let mut p = rel;
        loop {
            self.made_dirs.insert((on_left, p.to_string()));
            p = parent_rel(p);
            if p.is_empty() {
                break;
            }
        }
        Ok(())
    }

    /// 複製一個檔。回傳是否保留了修改時間。
    async fn copy_file(&mut self, to_right: bool, src: &str, dst: &str, mtime: Option<u64>, progress: ProgressFn) -> AppResult<bool> {
        let from_left = to_right;
        self.ensure_dir(!to_right, parent_rel(dst)).await?;
        let (src_path, dst_path) = {
            let s = self.side(from_left);
            let d = self.side(!from_left);
            (s.fs.join(s.root, src)?, d.fs.join(d.root, dst)?)
        };
        // 目的地是同名資料夾（型別不同）：整個換成檔案。
        {
            let d = self.side(!from_left);
            if let Some(e) = d.fs.stat(&dst_path).await? {
                if e.is_dir {
                    d.fs.remove(d.root, dst, true).await?;
                }
            }
        }
        let src_local = self.side(from_left).fs.is_local();
        let dst_local = self.side(!from_left).fs.is_local();
        let cancel = self.cancel;
        match (src_local, dst_local) {
            (true, true) => {
                tokio::fs::copy(&src_path, &dst_path)
                    .await
                    .map_err(|e| AppError::Compare(tf!("{path}：{e}", path = dst_path, e = e)))?;
                if let Ok(md) = tokio::fs::metadata(&dst_path).await {
                    progress(md.len(), Some(md.len()));
                }
            }
            (true, false) => {
                let t = self.tfs(!from_left).await?;
                t.upload(Path::new(&src_path), &dst_path, OnConflict::Overwrite, progress, cancel).await?;
            }
            (false, true) => {
                let t = self.tfs(from_left).await?;
                t.download(&src_path, Path::new(&dst_path), OnConflict::Overwrite, progress, cancel).await?;
            }
            (false, false) => {
                tokio::fs::create_dir_all(&self.temp).await.map_err(|e| AppError::Compare(e.to_string()))?;
                let tmp = self.temp.join(format!("relay-{}", uuid::Uuid::new_v4()));
                let down = self.tfs(from_left).await?;
                let up = self.tfs(!from_left).await?;
                // 進度只給上傳那一段（下載完成前進度條停在原處，比來回跳兩次好懂）。
                let r = async {
                    down.download(&src_path, &tmp, OnConflict::Overwrite, Box::new(|_, _| {}), cancel).await?;
                    up.upload(&tmp, &dst_path, OnConflict::Overwrite, progress, cancel).await
                }
                .await;
                let _ = tokio::fs::remove_file(&tmp).await;
                r?;
            }
        }
        Ok(match mtime {
            Some(m) => self.side(!from_left).fs.set_mtime(&dst_path, m).await,
            None => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filecmp::diff::{align, AlignOpts, Status};

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbk-sync-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn mirror_local_to_local_then_rescan_is_same() {
        let (l, r, tmp) = (tmpdir("l"), tmpdir("r"), tmpdir("t"));
        std::fs::create_dir_all(l.join("src/deep")).unwrap();
        std::fs::write(l.join("src/a.txt"), b"left a").unwrap();
        std::fs::write(l.join("src/deep/b.txt"), b"bbb").unwrap();
        std::fs::write(l.join("changed.txt"), b"new content").unwrap();
        std::fs::write(r.join("changed.txt"), b"old").unwrap();
        std::fs::write(r.join("extra.txt"), b"only right").unwrap();
        // 型別不同：左邊是檔案、右邊是資料夾
        std::fs::write(l.join("kind"), b"file").unwrap();
        std::fs::create_dir_all(r.join("kind/inner")).unwrap();

        let (ls, rs) = (l.display().to_string(), r.display().to_string());
        let (lf, rf) = (SideFs::Local, SideFs::Local);
        let cancel = AtomicBool::new(false);
        let seen = Arc::new(parking_lot::Mutex::new(0usize));
        let s2 = seen.clone();
        let mut sy = Syncer::new(
            Endpoint { fs: &lf, root: &ls },
            Endpoint { fs: &rf, root: &rs },
            &[],
            tmp.clone(),
            &cancel,
            Arc::new(move |_p| *s2.lock() += 1),
        );
        let ops = vec![
            SyncOp { kind: OpKind::CopyLr, src: "src".into(), dst: None, is_dir: true },
            SyncOp { kind: OpKind::CopyLr, src: "changed.txt".into(), dst: None, is_dir: false },
            SyncOp { kind: OpKind::CopyLr, src: "kind".into(), dst: None, is_dir: false },
            SyncOp { kind: OpKind::DeleteRight, src: "extra.txt".into(), dst: None, is_dir: false },
        ];
        let rep = sy.run(&ops).await.unwrap();
        assert!(rep.failed.is_empty(), "{:?}", rep.failed);
        assert_eq!((rep.copied, rep.deleted, rep.mtime_not_kept), (4, 1, 0));
        assert!(*seen.lock() > 0);
        assert_eq!(std::fs::read(r.join("src/deep/b.txt")).unwrap(), b"bbb");
        assert_eq!(std::fs::read(r.join("kind")).unwrap(), b"file");
        assert!(!r.join("extra.txt").exists());

        // 重新掃描：全部相同（修改時間也保留了）
        let opts = ScanOpts { excludes: &[], max_entries: 1000 };
        let a = scan(&lf, &ls, &opts, &cancel, &|_| {}).await.unwrap();
        let b = scan(&rf, &rs, &opts, &cancel, &|_| {}).await.unwrap();
        let rows = align(&a.nodes, &b.nodes, &AlignOpts::default());
        assert!(rows.iter().all(|r| r.status == Status::Same), "{rows:#?}");

        for d in [l, r, tmp] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }

    #[tokio::test]
    async fn refuses_to_delete_root_and_traversal() {
        let (l, r) = (tmpdir("l"), tmpdir("r"));
        let (ls, rs) = (l.display().to_string(), r.display().to_string());
        let (lf, rf) = (SideFs::Local, SideFs::Local);
        let cancel = AtomicBool::new(false);
        let mut sy = Syncer::new(
            Endpoint { fs: &lf, root: &ls },
            Endpoint { fs: &rf, root: &rs },
            &[],
            std::env::temp_dir(),
            &cancel,
            Arc::new(|_| {}),
        );
        let rep = sy
            .run(&[
                SyncOp { kind: OpKind::DeleteLeft, src: "".into(), dst: None, is_dir: true },
                SyncOp { kind: OpKind::DeleteLeft, src: "../x".into(), dst: None, is_dir: true },
            ])
            .await
            .unwrap();
        assert_eq!(rep.failed.len(), 2);
        assert!(l.exists());
        for d in [l, r] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }
}
