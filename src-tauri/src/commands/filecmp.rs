//! 檔案 / 資料夾 / 二進位比對的 command（核心在 `crate::filecmp`）。
//!
//! 兩邊的來源以 `SideSpec` 傳進來：本機路徑，或已開的檔案工作階段（`sftp_id`，SFTP / FTP 皆可，
//! 前端用同一套 `ssh_connect` + `ssh_sftp_open` 開好）。長工作（掃描、內容比對、同步）帶前端產生的
//! `job_id`，進度走 `fcmp-progress` 事件，`fcmp_cancel(job_id)` 取消。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::filecmp::binary::{self, BinDiff};
use crate::filecmp::content::{self, ContentPair, ContentResult};
use crate::filecmp::diff::{align, AlignOpts, Row};
use crate::filecmp::scan::{scan, ScanOpts, SCAN_MAX_ENTRIES};
use crate::filecmp::sessions::{self, SessionsFile};
use crate::filecmp::side::SideFs;
use crate::filecmp::sync::{Endpoint, SyncOp, SyncProgress, SyncReport, Syncer};
use crate::filecmp::text::{self, CmpStat, CmpText};
use crate::filecmp::{scope_dir, temp_root};
use crate::ssh::sftp::OnConflict;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SideSpec {
    Local { path: String },
    Remote { sftp_id: String, path: String },
}

fn resolve(state: &AppState, spec: &SideSpec) -> AppResult<(SideFs, String)> {
    match spec {
        SideSpec::Local { path } => Ok((SideFs::Local, path.clone())),
        SideSpec::Remote { sftp_id, path } => Ok((SideFs::Remote(state.ssh.sftp(sftp_id)?), path.clone())),
    }
}

// ---- 工作登記（取消用）----

static JOBS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// 登記一個工作；離開 scope 時自動註銷。
struct Job {
    id: String,
    cancel: Arc<AtomicBool>,
}

impl Job {
    fn new(id: &str) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        JOBS.lock().insert(id.to_string(), cancel.clone());
        Self { id: id.to_string(), cancel }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        JOBS.lock().remove(&self.id);
    }
}

#[tauri::command]
pub fn fcmp_cancel(job_id: String) {
    if let Some(c) = JOBS.lock().get(&job_id) {
        c.store(true, Ordering::Relaxed);
    }
}

#[derive(Clone, Serialize)]
struct FcmpProgress<'a> {
    job_id: &'a str,
    /// "scan" / "content" / "sync"
    phase: &'static str,
    done: u64,
    total: Option<u64>,
    /// 同步：已完成 / 全部的項目數與目前處理中的相對路徑。
    items: Option<(usize, usize)>,
    current: Option<String>,
    /// 掃描：左右各掃到幾個項目。
    left: Option<usize>,
    right: Option<usize>,
}

// ---- 資料夾比對 ----

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct FolderOpts {
    pub excludes: Vec<String>,
    #[serde(flatten)]
    pub align: AlignOpts,
}

#[derive(Serialize)]
pub struct FolderDiff {
    pub rows: Vec<Row>,
    pub left_count: usize,
    pub right_count: usize,
    pub skipped: usize,
    /// 讀不到的資料夾：(那一邊 "left" / "right", 相對路徑, 錯誤訊息)。
    pub errors: Vec<(&'static str, String, String)>,
}

/// 兩邊同時掃描，再依相對路徑對齊。
#[tauri::command]
pub async fn fcmp_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    left: SideSpec,
    right: SideSpec,
    opts: FolderOpts,
) -> AppResult<FolderDiff> {
    let (lf, lroot) = resolve(&state, &left)?;
    let (rf, rroot) = resolve(&state, &right)?;
    let job = Job::new(&job_id);
    let counts = Arc::new(Mutex::new((0usize, 0usize)));
    let emit = {
        let app = app.clone();
        let job_id = job_id.clone();
        let counts = counts.clone();
        move || {
            let (l, r) = *counts.lock();
            let _ = app.emit(
                "fcmp-progress",
                FcmpProgress {
                    job_id: &job_id,
                    phase: "scan",
                    done: (l + r) as u64,
                    total: None,
                    items: None,
                    current: None,
                    left: Some(l),
                    right: Some(r),
                },
            );
        }
    };
    let (e1, e2) = (emit.clone(), emit);
    let (c1, c2) = (counts.clone(), counts);
    let sopts = ScanOpts { excludes: &opts.excludes, max_entries: SCAN_MAX_ENTRIES };
    let on_left = move |n: usize| {
        c1.lock().0 = n;
        e1();
    };
    let on_right = move |n: usize| {
        c2.lock().1 = n;
        e2();
    };
    let (a, b) = tokio::join!(
        scan(&lf, &lroot, &sopts, &job.cancel, &on_left),
        scan(&rf, &rroot, &sopts, &job.cancel, &on_right),
    );
    let (a, b) = (a?, b?);
    let rows = align(&a.nodes, &b.nodes, &opts.align);
    let mut errors: Vec<(&'static str, String, String)> = Vec::new();
    errors.extend(a.errors.into_iter().map(|(p, m)| ("left", p, m)));
    errors.extend(b.errors.into_iter().map(|(p, m)| ("right", p, m)));
    Ok(FolderDiff { rows, left_count: a.nodes.len(), right_count: b.nodes.len(), skipped: a.skipped + b.skipped, errors })
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContentPairArg {
    pub key: String,
    pub left: String,
    pub right: String,
}

/// 逐一比對內容（大小相同、需要確認內容的那些檔）。單一檔失敗不中斷，記在結果裡。
#[tauri::command]
pub async fn fcmp_content_check(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    scope: String,
    left: SideSpec,
    right: SideSpec,
    pairs: Vec<ContentPairArg>,
) -> AppResult<Vec<ContentResult>> {
    let (lf, lroot) = resolve(&state, &left)?;
    let (rf, rroot) = resolve(&state, &right)?;
    let job = Job::new(&job_id);
    let dir = scope_dir(&scope).join(format!("content-{}", uuid::Uuid::new_v4()));
    let pairs = pairs.into_iter().map(|p| ContentPair { key: p.key, left: p.left, right: p.right }).collect();
    let progress = |done: usize, total: usize, key: &str| {
        let _ = app.emit(
            "fcmp-progress",
            FcmpProgress {
                job_id: &job_id,
                phase: "content",
                done: done as u64,
                total: Some(total as u64),
                items: None,
                current: Some(key.to_string()),
                left: None,
                right: None,
            },
        );
    };
    content::check_pairs(&lf, &lroot, &rf, &rroot, pairs, &dir, &job.cancel, &progress).await
}

#[tauri::command]
pub async fn fcmp_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    scope: String,
    left: SideSpec,
    right: SideSpec,
    excludes: Vec<String>,
    ops: Vec<SyncOp>,
) -> AppResult<SyncReport> {
    let (lf, lroot) = resolve(&state, &left)?;
    let (rf, rroot) = resolve(&state, &right)?;
    let job = Job::new(&job_id);
    let progress = {
        let app = app.clone();
        let job_id = job_id.clone();
        Arc::new(move |p: SyncProgress| {
            let _ = app.emit(
                "fcmp-progress",
                FcmpProgress {
                    job_id: &job_id,
                    phase: "sync",
                    done: p.done_bytes,
                    total: Some(p.total_bytes),
                    items: Some((p.done_items, p.total_items)),
                    current: Some(p.current),
                    left: None,
                    right: None,
                },
            );
        })
    };
    let mut syncer = Syncer::new(
        Endpoint { fs: &lf, root: &lroot },
        Endpoint { fs: &rf, root: &rroot },
        &excludes,
        scope_dir(&scope),
        &job.cancel,
        progress,
    );
    syncer.run(&ops).await
}

// ---- 單一檔案（文字 / 二進位比對）----

#[tauri::command]
pub async fn cmp_local_stat(path: String) -> AppResult<CmpStat> {
    text::stat(Path::new(&path)).await
}

#[tauri::command]
pub async fn cmp_local_read_text(path: String, max_bytes: u64) -> AppResult<CmpText> {
    text::read(Path::new(&path), max_bytes).await
}

#[tauri::command]
pub async fn cmp_local_write_text(path: String, content: String, expected_mtime: Option<u64>) -> AppResult<CmpStat> {
    text::write(Path::new(&path), &content, expected_mtime).await
}

#[derive(Serialize)]
pub struct Fetched {
    /// 暫存資料夾裡的本機副本。
    pub local: String,
    /// 遠端檔當下的屬性（存檔回去時用來偵測別人是否改過）。
    pub size: u64,
    pub mtime: Option<u64>,
}

/// 把遠端檔下載到這個比對分頁的暫存資料夾（`scope` = 分頁鍵）。
#[tauri::command]
pub async fn cmp_fetch(state: State<'_, AppState>, job_id: String, scope: String, sftp_id: String, remote: String) -> AppResult<Fetched> {
    let c = state.ssh.sftp(&sftp_id)?;
    let job = Job::new(&job_id);
    let st = c.stat(&remote).await?;
    if st.is_dir || st.link_target_is_dir == Some(true) {
        return Err(AppError::Compare(tf!("這是資料夾，不是檔案：{path}", path = remote)));
    }
    let local = content::fetch_into(&c, &remote, &scope_dir(&scope), &job.cancel).await?;
    Ok(Fetched { local: local.display().to_string(), size: st.size, mtime: st.mtime })
}

/// 把本機檔（通常是暫存副本）上傳回遠端。`expected_mtime` / `expected_size` 給了就先檢查遠端
/// 在開啟之後有沒有被別人改過，改過就回 `CompareConflict`（前端問過使用者再不帶 expected 重送）。
#[tauri::command]
pub async fn cmp_put(
    state: State<'_, AppState>,
    job_id: String,
    sftp_id: String,
    local: String,
    remote: String,
    expected_mtime: Option<u64>,
    expected_size: Option<u64>,
) -> AppResult<CmpStat> {
    let c = state.ssh.sftp(&sftp_id)?;
    let job = Job::new(&job_id);
    if expected_mtime.is_some() || expected_size.is_some() {
        if let Ok(cur) = c.stat(&remote).await {
            let moved = expected_mtime.is_some_and(|m| cur.mtime.is_some_and(|c| c != m))
                || expected_size.is_some_and(|s| cur.size != s);
            if moved {
                return Err(AppError::CompareConflict(tf!("檔案在開啟之後已被修改：{path}", path = remote)));
            }
        }
    }
    let fs = c.transfer_fs(&job.cancel).await?;
    fs.upload(Path::new(&local), &remote, OnConflict::Overwrite, Box::new(|_, _| {}), &job.cancel)
        .await
        .map_err(|e| if matches!(e, AppError::SshCancelled) { AppError::CompareCancelled } else { e })?;
    let st = c.stat(&remote).await?;
    Ok(CmpStat { exists: true, is_dir: false, size: st.size, mtime: st.mtime })
}

/// 比對分頁關掉：刪掉它的暫存資料夾。
#[tauri::command]
pub async fn cmp_release(scope: String) -> AppResult<()> {
    let dir = scope_dir(&scope);
    // 只刪暫存根底下的東西（scope_dir 已清過字元，這裡再保險一次）。
    if dir.starts_with(temp_root()) {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn fcmp_binary_diff(job_id: String, a: String, b: String) -> AppResult<BinDiff> {
    let job = Job::new(&job_id);
    let cancel = job.cancel.clone();
    tokio::task::spawn_blocking(move || binary::diff_files(Path::new(&a), Path::new(&b), &cancel))
        .await
        .map_err(|e| AppError::Compare(e.to_string()))?
}

/// 讀一段位元組；回傳原始 bytes（前端拿到 ArrayBuffer，不經 JSON 陣列）。
#[tauri::command]
pub async fn fcmp_read_bytes(path: String, offset: u64, len: u64) -> AppResult<Response> {
    let bytes = tokio::task::spawn_blocking(move || binary::read_bytes(Path::new(&path), offset, len))
        .await
        .map_err(|e| AppError::Compare(e.to_string()))??;
    Ok(Response::new(bytes))
}


// ---- 已存的比對（compare_sessions.json，與 dbk 共用）----

#[tauri::command]
pub async fn cmp_sessions_load(app: AppHandle) -> AppResult<SessionsFile> {
    sessions::load_in(&crate::store::app_config_dir(&app)?).await
}

#[tauri::command]
pub async fn cmp_sessions_save(app: AppHandle, file: SessionsFile) -> AppResult<()> {
    sessions::save_in(&crate::store::app_config_dir(&app)?, &file).await
}
