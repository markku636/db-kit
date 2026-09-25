//! SFTP 子系統（russh-sftp 3.0）：目錄瀏覽、建 / 改名 / 刪、小檔預覽、上下傳與取消。
//!
//! 同一條 SSH 連線上再開一條 session channel 跑 `sftp` subsystem，不必再認證。`SftpSession`
//! 的方法全是 `&self`，`SftpClient` 放進 `Arc` 讓多個 command 共用。
//!
//! 路徑安全：伺服器回的檔名是**不可信資料**（惡意 / 壞掉的伺服器可以回 `..` 或含 `/` 的名字），
//! 遞迴刪除與列表都經 `remote_join` 過濾；刪除另外拒絕根目錄 / 目前目錄這類「整台機器」的目標。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures::StreamExt;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::runtime::SshConn;
use crate::error::{AppError, AppResult};

/// 上下傳的區塊大小。
pub const CHUNK: usize = 128 * 1024;
/// 進度回報的最小間隔。
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// `read_small` 的絕對上限（前端預覽用，不是下載）。
pub const READ_SMALL_MAX: u64 = 1024 * 1024;
/// 傳輸中檢查取消旗標的間隔（伺服器停住時也能在這個時間內取消）。
const CANCEL_TICK: Duration = Duration::from_millis(200);
/// 每個 SFTP 請求的逾時（秒）。
const REQUEST_TIMEOUT_SECS: u64 = 30;
/// 列目錄時同時查 symlink 目標的上限。
const SYMLINK_STAT_CONCURRENCY: usize = 16;

/// 目錄項目 / stat 結果。`mtime` 為 epoch 秒；`mode` 是 `drwxr-xr-x` 字串。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// symlink 的目標是不是目錄（不是 symlink → `None`；目標讀不到 → `None`）。
    pub link_target_is_dir: Option<bool>,
    pub size: u64,
    pub mtime: Option<u64>,
    pub permissions: Option<u32>,
    pub mode: String,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

/// `read_small` 的結果。
///
/// `lossy` / `binary` 是給編輯器的安全閥：內容不是乾淨的 UTF-8 時，畫面上看到的是轉換過的字
/// （無效位元組變成 U+FFFD），照這份存回去就會把原檔弄壞——前端遇到這兩個旗標只給唯讀檢視。
#[derive(Debug, Clone, Serialize)]
pub struct SftpText {
    pub text: String,
    pub truncated: bool,
    pub size: u64,
    /// 內容有無效的 UTF-8（已以 U+FFFD 取代）。截斷在多位元組字元中間不算。
    pub lossy: bool,
    /// 前 8 KiB 內有 NUL 位元組：幾乎可以確定不是文字檔。
    pub binary: bool,
}

/// `write_text` 一次寫入的上限。編輯器只給 ≤ 1 MiB 的檔案編輯，這裡留一點貼上內容的餘裕。
pub const WRITE_TEXT_MAX: usize = 2 * 1024 * 1024;

/// 資料夾遞迴傳輸一次最多處理的項目數（檔案 + 資料夾）。誤點到 `/usr` 這種樹時先擋下來，
/// 而不是掃好幾分鐘、塞滿本機磁碟才發現。
pub const TREE_MAX_ENTRIES: usize = 20_000;

/// 資料夾遞迴傳輸的計畫：先整棵掃完（算總大小給進度條），再依序建資料夾、傳檔案。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TreePlan {
    /// 要建立的資料夾（相對於根，已清理過的路徑段；根本身是空陣列，不列在這裡）。
    pub dirs: Vec<Vec<String>>,
    /// 要傳的檔案：(來源完整路徑, 目的相對路徑段, 大小)。
    pub files: Vec<(String, Vec<String>, u64)>,
    /// 略過的項目數（指向資料夾的 symlink、特殊檔）。
    pub skipped: usize,
}

impl TreePlan {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.2).sum()
    }

    /// 項目總數（資料夾 + 檔案），給 `TREE_MAX_ENTRIES` 比對。
    pub fn len(&self) -> usize {
        self.dirs.len() + self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty() && self.files.is_empty()
    }

    /// 把一棵子樹併進來，放在 `name` 這一段底下（批次傳輸：每個選取的資料夾是結果裡的一個子資料夾）。
    pub fn absorb(&mut self, name: &str, sub: TreePlan) {
        let prefixed = |seg: Vec<String>| std::iter::once(name.to_string()).chain(seg).collect::<Vec<_>>();
        self.dirs.push(vec![name.to_string()]);
        self.dirs.extend(sub.dirs.into_iter().map(prefixed));
        self.files.extend(sub.files.into_iter().map(|(p, seg, sz)| (p, prefixed(seg), sz)));
        self.skipped += sub.skipped;
    }
}

/// 批次傳輸時，目的地已有同名項目怎麼辦。只看最上層：資料夾一旦決定合併，裡面的同名檔一律覆蓋
/// （Xftp 的「全部覆蓋」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnConflict {
    /// 有任何同名就整批不開始。前端先查過沒有衝突時用這個：查完到開始之間被別人建了同名項目，
    /// 也不會默默覆蓋。
    #[default]
    Fail,
    /// 同名檔案取代、同名資料夾合併。
    Overwrite,
    /// 同名的項目整個略過，只傳其餘的。
    Skip,
}

/// 批次傳輸完成後的摘要（變成完成事件的訊息，前端接在「已下載 …」後面）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BatchSummary {
    pub files: usize,
    /// 因 `OnConflict::Skip` 略過的最上層項目。
    pub skipped_existing: usize,
    /// 略過的 symlink（指向資料夾 / 讀不到目標）與裝置檔、FIFO、socket。
    pub skipped_special: usize,
}

impl BatchSummary {
    pub fn message(&self) -> Option<String> {
        match (self.skipped_existing, self.skipped_special) {
            (0, 0) => None,
            (a, 0) => Some(tf!("略過 {n} 個同名項目", n = a)),
            (0, b) => Some(tf!("略過 {n} 個連結或特殊檔案", n = b)),
            (a, b) => Some(tf!("略過 {a} 個同名項目、{b} 個連結或特殊檔案", a = a, b = b)),
        }
    }
}

/// 下載前的同名檢查：`names`（遠端檔名）裡哪些在 `local_dir` 已經有了。用與 `download_many`
/// 同一套檔名轉換（`sanitize_local_filename`），前端不必自己猜 Windows 會把名字改成什麼。
pub async fn local_conflicts(local_dir: &Path, names: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for n in names {
        if tokio::fs::try_exists(local_dir.join(sanitize_local_filename(n))).await.unwrap_or(false) {
            out.push(n.clone());
        }
    }
    out
}

/// 進度回呼：`(已完成位元組, 總大小)`。
pub type ProgressFn = Box<dyn Fn(u64, Option<u64>) + Send + Sync>;

pub struct SftpClient {
    pub conn_id: String,
    inner: SftpSession,
}

impl SftpClient {
    /// 在既有連線上開 sftp subsystem，回 `(client, home)`；`home` 是 `.` 的絕對路徑。
    pub async fn open(conn: &SshConn) -> AppResult<(Self, String)> {
        let ch = conn
            .handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Sftp(tf!("開啟 SSH 通道失敗：{e}", e = e)))?;
        ch.request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Sftp(tf!("要求 sftp 子系統失敗：{e}", e = e)))?;
        let inner = SftpSession::new(ch.into_stream()).await.map_err(map_err)?;
        inner.set_timeout(REQUEST_TIMEOUT_SECS);
        let home = inner.canonicalize(".").await.map_err(map_err)?;
        Ok((Self { conn_id: conn.id.clone(), inner }, home))
    }

    pub async fn close(&self) {
        let _ = self.inner.close().await;
    }

    /// 列目錄（不含 `.` / `..`）。symlink 會再查一次目標好讓前端知道能不能「進入」。
    pub async fn list_dir(&self, path: &str) -> AppResult<Vec<SftpEntry>> {
        let dir = if path.trim().is_empty() { "." } else { path.trim() };
        let rd = self.inner.read_dir(dir.to_string()).await.map_err(map_err)?;
        let mut out: Vec<SftpEntry> = Vec::new();
        for e in rd {
            let name = e.file_name();
            let full = match remote_join(dir, &name) {
                Ok(p) => p,
                Err(_) => {
                    eprintln!("[sftp] 略過伺服器回的可疑檔名：{name:?}");
                    continue;
                }
            };
            out.push(entry_from(name, full, &e.metadata()));
        }
        // symlink 目標：並行查，數量多也不會一個個排隊。
        let links: Vec<usize> = out
            .iter()
            .enumerate()
            .filter(|(_, e)| e.is_symlink)
            .map(|(i, _)| i)
            .collect();
        if !links.is_empty() {
            let resolved: Vec<(usize, Option<bool>)> = futures::stream::iter(links)
                .map(|i| {
                    let p = out[i].path.clone();
                    async move { (i, self.inner.metadata(p).await.ok().map(|m| kind_of(&m) == Kind::Dir)) }
                })
                .buffer_unordered(SYMLINK_STAT_CONCURRENCY)
                .collect()
                .await;
            for (i, v) in resolved {
                out[i].link_target_is_dir = v;
            }
        }
        Ok(out)
    }

    /// 單一路徑的屬性（lstat；symlink 另查目標）。
    pub async fn stat(&self, path: &str) -> AppResult<SftpEntry> {
        let md = self.inner.symlink_metadata(path.to_string()).await.map_err(map_err)?;
        let mut e = entry_from(basename(path).to_string(), path.to_string(), &md);
        if e.is_symlink {
            e.link_target_is_dir = self.inner.metadata(path.to_string()).await.ok().map(|m| kind_of(&m) == Kind::Dir);
        }
        Ok(e)
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        self.inner.create_dir(path.to_string()).await.map_err(map_err)
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        self.inner.rename(from.to_string(), to.to_string()).await.map_err(map_err)
    }

    /// 刪除。目錄需 `recursive`（client 端 DFS：檔案邊走邊刪、目錄後序刪）。
    /// 拒絕根目錄 / 目前目錄 / 會往上走到根的路徑。
    pub async fn remove(&self, path: &str, recursive: bool) -> AppResult<()> {
        if is_root_like(path) {
            return Err(AppError::Sftp(t!("拒絕刪除根目錄或目前目錄").into()));
        }
        let md = self.inner.symlink_metadata(path.to_string()).await.map_err(map_err)?;
        // symlink 指向目錄也只刪連結本身，絕不跟進去。
        if kind_of(&md) == Kind::Dir {
            if !recursive {
                return self.inner.remove_dir(path.to_string()).await.map_err(map_err);
            }
            let mut stack = vec![path.to_string()];
            let mut dirs: Vec<String> = Vec::new();
            while let Some(d) = stack.pop() {
                dirs.push(d.clone());
                let rd = self.inner.read_dir(d.clone()).await.map_err(map_err)?;
                for e in rd {
                    let name = e.file_name();
                    let p = remote_join(&d, &name).map_err(|_| {
                        AppError::Sftp(tf!("伺服器回傳可疑的檔名，已中止刪除：{name}", name = name))
                    })?;
                    let m = e.metadata();
                    if kind_of(&m) == Kind::Dir {
                        stack.push(p);
                    } else {
                        self.inner.remove_file(p).await.map_err(map_err)?;
                    }
                }
            }
            for d in dirs.iter().rev() {
                self.inner.remove_dir(d.clone()).await.map_err(map_err)?;
            }
            Ok(())
        } else {
            self.inner.remove_file(path.to_string()).await.map_err(map_err)
        }
    }

    /// 讀小檔（預覽用）：最多 `max`（≤ 1 MiB）位元組，超過標 `truncated`；非 UTF-8 以 lossy 轉。
    pub async fn read_small(&self, path: &str, max: u64) -> AppResult<SftpText> {
        let cap = if max == 0 { READ_SMALL_MAX } else { max.min(READ_SMALL_MAX) } as usize;
        let size = self
            .inner
            .metadata(path.to_string())
            .await
            .map_err(map_err)?
            .size
            .unwrap_or(0);
        let mut f = self.inner.open(path.to_string()).await.map_err(map_err)?;
        let mut buf: Vec<u8> = Vec::with_capacity(cap.min(size as usize + 1));
        let mut chunk = vec![0u8; CHUNK];
        let mut truncated = false;
        while buf.len() <= cap {
            let n = f.read(&mut chunk).await.map_err(io_err)?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        if buf.len() > cap {
            buf.truncate(cap);
            truncated = true;
        }
        let _ = f.close().await;
        Ok(decode_text(buf, truncated, size))
    }

    /// 把編輯器的內容寫回遠端（Xftp 的「編輯」存檔）。
    ///
    /// 直接覆寫原檔（`WRITE | TRUNCATE`）而不是寫暫存檔再改名：改名會換掉 inode，
    /// 檔案的擁有者 / 群組 / 權限都變成「目前這個使用者的預設值」，改一行 nginx.conf 就把
    /// 權限弄亂。`create_new` = 新增檔案（已存在即失敗，不會蓋掉別人的檔）；否則檔案必須還在
    /// （不帶 CREATE：編輯途中被刪掉就回錯，而不是默默重建一個）。回傳寫完後的屬性。
    pub async fn write_text(&self, path: &str, content: &str, create_new: bool) -> AppResult<SftpEntry> {
        if content.len() > WRITE_TEXT_MAX {
            return Err(AppError::Sftp(tf!(
                "內容太大，無法在編輯器存檔（上限 {max} MiB）",
                max = WRITE_TEXT_MAX / (1024 * 1024)
            )));
        }
        let flags = if create_new {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE
        } else {
            OpenFlags::WRITE | OpenFlags::TRUNCATE
        };
        let mut f = self.inner.open_with_flags(path.to_string(), flags).await.map_err(map_err)?;
        f.write_all(content.as_bytes()).await.map_err(io_err)?;
        // close 會等所有寫入的 ack：磁碟滿 / 權限這類錯誤在這裡才浮出來，不能吞掉。
        f.close().await.map_err(io_err)?;
        self.stat(path).await
    }

    /// 變更權限位元（chmod）。只送 `permissions` 一個屬性，擁有者與時間都不動；
    /// 型別位元（目錄 / 檔案）由伺服器決定，這裡只收 `0o7777` 以內的部分。回傳變更後的屬性。
    pub async fn chmod(&self, path: &str, mode: u32) -> AppResult<SftpEntry> {
        let attrs = FileAttributes { permissions: Some(mode & 0o7777), ..FileAttributes::empty() };
        self.inner.set_metadata(path.to_string(), attrs).await.map_err(map_err)?;
        self.stat(path).await
    }

    /// 下載到本機。先寫 `<local>.part` 再 rename，取消 / 失敗不留半成品。
    /// `local` 若是既有目錄，檔名取遠端 basename（經 `sanitize_local_filename`）。
    pub async fn download(
        &self,
        remote: &str,
        local: &Path,
        overwrite: bool,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<PathBuf> {
        let local = resolve_local_target(local, remote).await;
        if !overwrite && tokio::fs::try_exists(&local).await.unwrap_or(false) {
            return Err(AppError::Sftp(tf!("本機檔案已存在：{path}", path = local.display())));
        }
        let mut rf = self.inner.open(remote.to_string()).await.map_err(map_err)?;
        let total = rf.metadata().await.ok().and_then(|m| m.size);
        if let Some(dir) = local.parent() {
            if !dir.as_os_str().is_empty() {
                tokio::fs::create_dir_all(dir).await.map_err(local_err)?;
            }
        }
        let part = part_path(&local);
        let mut lf = tokio::fs::File::create(&part).await.map_err(local_err)?;
        let mut buf = vec![0u8; CHUNK];
        let mut done: u64 = 0;
        let mut last = Instant::now();
        progress(0, total);
        let result: AppResult<()> = async {
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::SshCancelled);
                }
                let n = tokio::select! {
                    r = rf.read(&mut buf) => r.map_err(io_err)?,
                    _ = tokio::time::sleep(CANCEL_TICK) => continue,
                };
                if n == 0 {
                    break;
                }
                lf.write_all(&buf[..n]).await.map_err(local_err)?;
                done += n as u64;
                if last.elapsed() >= PROGRESS_EVERY {
                    progress(done, total);
                    last = Instant::now();
                }
            }
            lf.flush().await.map_err(local_err)?;
            Ok(())
        }
        .await;
        drop(lf);
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        tokio::fs::rename(&part, &local).await.map_err(local_err)?;
        progress(done, total.or(Some(done)));
        Ok(local)
    }

    /// 上傳本機檔。`!overwrite` 時遠端已存在即失敗（開檔加 `EXCLUDE` 防競態）。
    /// 取消 / 失敗時刪掉寫到一半的遠端檔。
    pub async fn upload(
        &self,
        local: &Path,
        remote: &str,
        overwrite: bool,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        let mut lf = tokio::fs::File::open(local).await.map_err(local_err)?;
        let total = lf.metadata().await.ok().map(|m| m.len());
        if !overwrite && self.inner.try_exists(remote.to_string()).await.unwrap_or(false) {
            return Err(AppError::Sftp(tf!("遠端檔案已存在：{path}", path = remote)));
        }
        let flags = if overwrite {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
        } else {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE
        };
        let mut rf = self.inner.open_with_flags(remote.to_string(), flags).await.map_err(map_err)?;
        let mut buf = vec![0u8; CHUNK];
        let mut done: u64 = 0;
        let mut last = Instant::now();
        progress(0, total);
        let result: AppResult<()> = async {
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::SshCancelled);
                }
                let n = lf.read(&mut buf).await.map_err(local_err)?;
                if n == 0 {
                    break;
                }
                tokio::select! {
                    r = rf.write_all(&buf[..n]) => r.map_err(io_err)?,
                    _ = async {
                        // 伺服器停住時也要能取消：等寫入的同時定期看旗標。
                        loop {
                            tokio::time::sleep(CANCEL_TICK).await;
                            if cancel.load(Ordering::Relaxed) { break; }
                        }
                    } => return Err(AppError::SshCancelled),
                }
                done += n as u64;
                if last.elapsed() >= PROGRESS_EVERY {
                    progress(done, total);
                    last = Instant::now();
                }
            }
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                // close 會等所有寫入的 ack；寫入錯誤在這裡浮出。
                rf.close().await.map_err(io_err)?;
                progress(done, total.or(Some(done)));
                Ok(())
            }
            Err(e) => {
                drop(rf);
                let _ = self.inner.remove_file(remote.to_string()).await;
                Err(e)
            }
        }
    }

    /// 整個遠端資料夾下載（Xftp 把資料夾拖下來）。`local` 若是既有資料夾就放進去
    /// （`local/<遠端資料夾名>`），否則當成目的資料夾本身——與單檔下載同一套語意。
    ///
    /// 先整棵掃完再傳：進度條才有總量；掃描超過 `TREE_MAX_ENTRIES` 直接擋下。指向資料夾的
    /// symlink 一律略過（可能繞回自己形成無限迴圈），指向檔案的照常下載目標內容。
    /// 取消 / 失敗時已完成的檔案保留（與 Xftp 相同），進行中那個檔的 `.part` 由 `download` 清掉。
    pub async fn download_tree(
        &self,
        remote_dir: &str,
        local: &Path,
        overwrite: bool,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<PathBuf> {
        let local_root = match tokio::fs::metadata(local).await {
            Ok(m) if m.is_dir() => local.join(sanitize_local_filename(basename(remote_dir))),
            _ => local.to_path_buf(),
        };
        if !overwrite && tokio::fs::try_exists(&local_root).await.unwrap_or(false) {
            return Err(AppError::Sftp(tf!("本機已有同名資料夾：{path}", path = local_root.display())));
        }
        let plan = self.plan_remote_tree(remote_dir, cancel).await?;
        tokio::fs::create_dir_all(&local_root).await.map_err(local_err)?;
        self.run_download_plan(&plan, &local_root, progress, cancel).await?;
        Ok(local_root)
    }

    /// 整個本機資料夾上傳到 `remote_root`（遠端的新資料夾完整路徑）。已存在且 `!overwrite` 即失敗；
    /// `overwrite` 時合併進去（同名檔覆蓋、既有資料夾沿用）。本機的 symlink 一律略過。
    pub async fn upload_tree(
        &self,
        local_dir: &Path,
        remote_root: &str,
        overwrite: bool,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<String> {
        if !overwrite && self.inner.try_exists(remote_root.to_string()).await.unwrap_or(false) {
            return Err(AppError::Sftp(tf!("遠端已有同名項目：{path}", path = remote_root)));
        }
        let plan = plan_local_tree(local_dir, cancel).await?;
        self.ensure_remote_dir(remote_root).await?;
        self.run_upload_plan(&plan, remote_root, progress, cancel).await?;
        Ok(remote_root.to_string())
    }

    /// 多選下載（檔案 / 資料夾混合）到同一個本機資料夾 `local_dir`，每個項目成為其中的
    /// `<名稱>`。整批是一個工作：先把所有項目規劃完（算總量、擋超量），再依序傳——不會同時開
    /// 幾十個檔案 handle，進度條與取消也只有一個。
    ///
    /// 最上層的項目跟著 symlink 走（使用者點的就是它）；樹裡面指向資料夾的 symlink 照樣略過。
    pub async fn download_many(
        &self,
        remotes: &[String],
        local_dir: &Path,
        on_conflict: OnConflict,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<BatchSummary> {
        let mut plan = TreePlan::default();
        let mut sum = BatchSummary::default();
        for r in remotes {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::SshCancelled);
            }
            let name = sanitize_local_filename(basename(r));
            let target = local_dir.join(&name);
            if tokio::fs::try_exists(&target).await.unwrap_or(false) {
                match on_conflict {
                    OnConflict::Skip => {
                        sum.skipped_existing += 1;
                        continue;
                    }
                    OnConflict::Fail => {
                        return Err(AppError::Sftp(tf!("本機已有同名項目：{path}", path = target.display())));
                    }
                    OnConflict::Overwrite => {}
                }
            }
            let md = match self.inner.metadata(r.clone()).await {
                Ok(m) => m,
                // 指向不存在目標的 symlink：略過，不讓整批失敗
                Err(e) => {
                    let dangling = self
                        .inner
                        .symlink_metadata(r.clone())
                        .await
                        .map(|m| kind_of(&m) == Kind::Symlink)
                        .unwrap_or(false);
                    if dangling {
                        sum.skipped_special += 1;
                        continue;
                    }
                    return Err(map_err(e));
                }
            };
            match kind_of(&md) {
                Kind::Dir => {
                    let sub = self.plan_remote_tree(r, cancel).await?;
                    plan.absorb(&name, sub);
                }
                Kind::File => plan.files.push((r.clone(), vec![name], md.size.unwrap_or(0))),
                Kind::Symlink | Kind::Other => sum.skipped_special += 1,
            }
            if plan.len() > TREE_MAX_ENTRIES {
                return Err(too_many_entries());
            }
        }
        sum.skipped_special += plan.skipped;
        sum.files = plan.files.len();
        tokio::fs::create_dir_all(local_dir).await.map_err(local_err)?;
        self.run_download_plan(&plan, local_dir, progress, cancel).await?;
        Ok(sum)
    }

    /// 多選上傳（本機檔案 / 資料夾混合）到遠端資料夾 `remote_dir`。與 `download_many` 同一套：
    /// 先規劃、再依序傳，一個工作、一條進度。
    pub async fn upload_many(
        &self,
        locals: &[PathBuf],
        remote_dir: &str,
        on_conflict: OnConflict,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<BatchSummary> {
        let mut plan = TreePlan::default();
        let mut sum = BatchSummary::default();
        for l in locals {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::SshCancelled);
            }
            // 非 UTF-8 的本機檔名在遠端沒有對應的寫法：略過
            let (Some(name), Some(local)) = (l.file_name().and_then(|n| n.to_str()), l.to_str()) else {
                sum.skipped_special += 1;
                continue;
            };
            let target = remote_join(remote_dir, name)?;
            if self.inner.try_exists(target.clone()).await.unwrap_or(false) {
                match on_conflict {
                    OnConflict::Skip => {
                        sum.skipped_existing += 1;
                        continue;
                    }
                    OnConflict::Fail => {
                        return Err(AppError::Sftp(tf!("遠端已有同名項目：{path}", path = target)));
                    }
                    OnConflict::Overwrite => {}
                }
            }
            let md = tokio::fs::metadata(l).await.map_err(local_err)?;
            if md.is_dir() {
                let sub = plan_local_tree(l, cancel).await?;
                plan.absorb(name, sub);
            } else if md.is_file() {
                plan.files.push((local.to_string(), vec![name.to_string()], md.len()));
            } else {
                sum.skipped_special += 1;
            }
            if plan.len() > TREE_MAX_ENTRIES {
                return Err(too_many_entries());
            }
        }
        sum.skipped_special += plan.skipped;
        sum.files = plan.files.len();
        self.run_upload_plan(&plan, remote_dir, progress, cancel).await?;
        Ok(sum)
    }

    /// 依計畫建本機資料夾、依序下載；進度合併成一條（每個檔的進度加上前面檔案的總量）。
    /// 計畫裡的檔一律覆蓋：最上層的同名已由呼叫端處理過（`overwrite` / `OnConflict`）。
    /// 取消 / 失敗時已完成的檔案保留（與 Xftp 相同），進行中那個檔的 `.part` 由 `download` 清掉。
    async fn run_download_plan(
        &self,
        plan: &TreePlan,
        local_root: &Path,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        for d in &plan.dirs {
            tokio::fs::create_dir_all(join_segments(local_root, d)).await.map_err(local_err)?;
        }
        let total = plan.total_bytes();
        let progress = std::sync::Arc::new(progress);
        (*progress)(0, Some(total));
        let mut base = 0u64;
        for (remote, rel, size) in &plan.files {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::SshCancelled);
            }
            let p = progress.clone();
            let b = base;
            self.download(remote, &join_segments(local_root, rel), true, Box::new(move |d, _| (*p)(b + d, Some(total))), cancel)
                .await?;
            base += size;
        }
        (*progress)(total.max(base), Some(total.max(base)));
        Ok(())
    }

    /// 依計畫建遠端資料夾（父資料夾先建；已存在的沿用）、依序上傳。其餘同 `run_download_plan`。
    async fn run_upload_plan(
        &self,
        plan: &TreePlan,
        remote_root: &str,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        for d in &plan.dirs {
            self.ensure_remote_dir(&remote_join_segments(remote_root, d)?).await?;
        }
        let total = plan.total_bytes();
        let progress = std::sync::Arc::new(progress);
        (*progress)(0, Some(total));
        let mut base = 0u64;
        for (local, rel, size) in &plan.files {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::SshCancelled);
            }
            let p = progress.clone();
            let b = base;
            let remote = remote_join_segments(remote_root, rel)?;
            self.upload(Path::new(local), &remote, true, Box::new(move |d, _| (*p)(b + d, Some(total))), cancel)
                .await?;
            base += size;
        }
        (*progress)(total.max(base), Some(total.max(base)));
        Ok(())
    }

    /// 遠端資料夾存在就沿用；不存在就建；同名的是檔案則回錯（不能把檔案當資料夾合併）。
    async fn ensure_remote_dir(&self, path: &str) -> AppResult<()> {
        match self.inner.symlink_metadata(path.to_string()).await {
            Ok(m) if kind_of(&m) == Kind::Dir => Ok(()),
            Ok(_) => Err(AppError::Sftp(tf!("遠端已有同名檔案，無法建立資料夾：{path}", path = path))),
            Err(_) => self.inner.create_dir(path.to_string()).await.map_err(map_err),
        }
    }

    /// 掃描遠端資料夾樹（DFS）。伺服器回的檔名是不可信資料：經 `remote_join` 驗過才用，
    /// 本機端的路徑段再經 `sanitize_local_filename` 清成 Windows 也合法的名字。
    async fn plan_remote_tree(&self, root: &str, cancel: &AtomicBool) -> AppResult<TreePlan> {
        let mut plan = TreePlan::default();
        let mut stack: Vec<(String, Vec<String>)> = vec![(root.to_string(), Vec::new())];
        let mut seen = 0usize;
        while let Some((dir, rel)) = stack.pop() {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::SshCancelled);
            }
            let rd = self.inner.read_dir(dir.clone()).await.map_err(map_err)?;
            for e in rd {
                let name = e.file_name();
                let Ok(full) = remote_join(&dir, &name) else {
                    plan.skipped += 1;
                    continue;
                };
                seen += 1;
                if seen > TREE_MAX_ENTRIES {
                    return Err(too_many_entries());
                }
                let mut seg = rel.clone();
                seg.push(sanitize_local_filename(&name));
                let md = e.metadata();
                match kind_of(&md) {
                    Kind::Symlink => match self.inner.metadata(full.clone()).await {
                        Ok(t) if kind_of(&t) == Kind::File => plan.files.push((full, seg, t.size.unwrap_or(0))),
                        _ => plan.skipped += 1,
                    },
                    Kind::Dir => {
                        plan.dirs.push(seg.clone());
                        stack.push((full, seg));
                    }
                    // 裝置檔 / FIFO / socket：下載沒有意義，讀了還可能卡住
                    Kind::Other => plan.skipped += 1,
                    Kind::File => plan.files.push((full, seg, md.size.unwrap_or(0))),
                }
            }
        }
        plan.dirs.sort_by_key(|d| d.len()); // 父資料夾先建
        Ok(plan)
    }
}

fn too_many_entries() -> AppError {
    AppError::Sftp(tf!(
        "資料夾內的項目超過 {max} 個，請改用終端機（例如 tar）處理",
        max = TREE_MAX_ENTRIES
    ))
}

/// 掃描本機資料夾樹。symlink 一律略過（Windows 的 junction 同理，可能指回上層）；
/// 名稱不是合法 UTF-8 的也略過（遠端路徑是字串，轉不過去）。
pub async fn plan_local_tree(root: &Path, cancel: &AtomicBool) -> AppResult<TreePlan> {
    let mut plan = TreePlan::default();
    let mut stack: Vec<(PathBuf, Vec<String>)> = vec![(root.to_path_buf(), Vec::new())];
    let mut seen = 0usize;
    while let Some((dir, rel)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::SshCancelled);
        }
        let mut rd = tokio::fs::read_dir(&dir).await.map_err(local_err)?;
        while let Some(e) = rd.next_entry().await.map_err(local_err)? {
            seen += 1;
            if seen > TREE_MAX_ENTRIES {
                return Err(too_many_entries());
            }
            let Some(name) = e.file_name().to_str().map(str::to_string) else {
                plan.skipped += 1;
                continue;
            };
            if remote_join("/", &name).is_err() {
                plan.skipped += 1;
                continue;
            }
            let ft = e.file_type().await.map_err(local_err)?;
            let mut seg = rel.clone();
            seg.push(name);
            if ft.is_symlink() {
                plan.skipped += 1;
            } else if ft.is_dir() {
                plan.dirs.push(seg.clone());
                stack.push((e.path(), seg));
            } else if ft.is_file() {
                let size = e.metadata().await.map(|m| m.len()).unwrap_or(0);
                plan.files.push((e.path().to_string_lossy().into_owned(), seg, size));
            } else {
                plan.skipped += 1;
            }
        }
    }
    plan.dirs.sort_by_key(|d| d.len());
    Ok(plan)
}

fn join_segments(root: &Path, seg: &[String]) -> PathBuf {
    let mut p = root.to_path_buf();
    for s in seg {
        p.push(s);
    }
    p
}

/// 遠端根路徑 + 相對路徑段；每一段都經 `remote_join` 驗過（拒 `..`、`/`、NUL）。
pub fn remote_join_segments(root: &str, seg: &[String]) -> AppResult<String> {
    let mut p = root.to_string();
    for s in seg {
        p = remote_join(&p, s)?;
    }
    Ok(p)
}

// ---- 屬性 / 路徑工具（純函式，可測）----

/// 讀到的位元組 → `SftpText`。截斷時若剛好切在多位元組字元中間，把那半個字元丟掉
/// （那不是檔案壞掉，只是我們停在那裡），不要讓它變成 U+FFFD 又把 `lossy` 誤標成 true。
fn decode_text(mut buf: Vec<u8>, truncated: bool, size: u64) -> SftpText {
    let binary = buf.iter().take(8 * 1024).any(|&b| b == 0);
    let lossy = match std::str::from_utf8(&buf) {
        Ok(_) => false,
        Err(e) if truncated && e.error_len().is_none() => {
            let valid = e.valid_up_to();
            buf.truncate(valid);
            false
        }
        Err(_) => true,
    };
    SftpText { text: String::from_utf8_lossy(&buf).into_owned(), truncated, size, lossy, binary }
}

/// 檔案型別只看 S_IFMT（`0o170000`）那 4 個位元。**不要用** russh-sftp 的 `FileAttributes::is_dir()`
/// / `is_symlink()`：那是 bit-contains，socket（`0o140000`）與區塊裝置（`0o060000`）都「包含」DIR
/// 位元，會被當成資料夾——列表顯示成資料夾、遞迴刪除 / 整包下載還會對它 read_dir 而整批失敗。
/// 伺服器沒給型別位元（沒有 permissions，或只給權限位元）時當一般檔案。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Dir,
    File,
    Symlink,
    Other,
}

pub fn kind_of_mode(perm: Option<u32>) -> Kind {
    match perm.map(|p| p & 0o170000) {
        Some(0o040000) => Kind::Dir,
        Some(0o120000) => Kind::Symlink,
        Some(0o100000) | Some(0) | None => Kind::File,
        Some(_) => Kind::Other,
    }
}

fn kind_of(md: &FileAttributes) -> Kind {
    kind_of_mode(md.permissions)
}

fn entry_from(name: String, path: String, md: &FileAttributes) -> SftpEntry {
    let permissions = md.permissions;
    let kind = kind_of(md);
    SftpEntry {
        name,
        path,
        is_dir: kind == Kind::Dir,
        is_symlink: kind == Kind::Symlink,
        link_target_is_dir: None,
        size: md.size.unwrap_or(0),
        mtime: md.mtime.map(u64::from),
        permissions,
        mode: permissions.map(mode_string).unwrap_or_else(|| "----------".to_string()),
        uid: md.uid,
        gid: md.gid,
        owner: md.user.clone(),
        group: md.group.clone(),
    }
}

/// `ls -l` 風格的 `drwxr-xr-x`（含 setuid / setgid / sticky）。
pub fn mode_string(perm: u32) -> String {
    let kind = match perm & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        0o020000 => 'c',
        0o060000 => 'b',
        0o010000 => 'p',
        0o140000 => 's',
        _ => '-',
    };
    let mut s = String::with_capacity(10);
    s.push(kind);
    let triple = |s: &mut String, shift: u32, special: u32, special_char: char| {
        let bits = (perm >> shift) & 0o7;
        s.push(if bits & 0o4 != 0 { 'r' } else { '-' });
        s.push(if bits & 0o2 != 0 { 'w' } else { '-' });
        let x = bits & 0o1 != 0;
        let sp = perm & special != 0;
        s.push(match (x, sp) {
            (true, true) => special_char,
            (false, true) => special_char.to_ascii_uppercase(),
            (true, false) => 'x',
            (false, false) => '-',
        });
    };
    triple(&mut s, 6, 0o4000, 's');
    triple(&mut s, 3, 0o2000, 's');
    triple(&mut s, 0, 0o1000, 't');
    s
}

/// `dir` + `name`。`name` 必須是單一路徑段：拒空、`.`、`..`、含 `/` 或 NUL。
pub fn remote_join(dir: &str, name: &str) -> AppResult<String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(AppError::Sftp(tf!("無效的檔名：{name}", name = name)));
    }
    Ok(if dir.is_empty() || dir == "." {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    })
}

/// 最後一段路徑；`/` 回 `/`。
pub fn basename(path: &str) -> &str {
    let t = path.trim_end_matches('/');
    if t.is_empty() {
        return if path.starts_with('/') { "/" } else { path };
    }
    t.rsplit('/').next().unwrap_or(t)
}

/// 路徑是否等於根 / 目前目錄 / 往上走到根以外（刪除一律拒絕這類目標）。
pub fn is_root_like(path: &str) -> bool {
    let t = path.trim();
    if t.is_empty() {
        return true;
    }
    let mut stack: Vec<&str> = Vec::new();
    for c in t.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                if stack.pop().is_none() {
                    return true;
                }
            }
            other => stack.push(other),
        }
    }
    stack.is_empty()
}

/// Windows 也能用的本機檔名：去 `<>:"/\|?*` 與控制字元、尾端點 / 空白，保留名（CON、NUL、COM1…）前綴 `_`。
pub fn sanitize_local_filename(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    let reserved = RESERVED.contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        s.insert(0, '_');
    }
    if s.is_empty() {
        "_".to_string()
    } else {
        s
    }
}

/// `<local>.part`（副檔名之後再接，不覆蓋原副檔名）。
fn part_path(local: &Path) -> PathBuf {
    let mut s = local.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// `local` 是既有目錄 → 接上遠端檔名；否則原樣。
async fn resolve_local_target(local: &Path, remote: &str) -> PathBuf {
    match tokio::fs::metadata(local).await {
        Ok(m) if m.is_dir() => local.join(sanitize_local_filename(basename(remote))),
        _ => local.to_path_buf(),
    }
}

// ---- 錯誤對映 ----

/// russh-sftp 的錯誤 → `AppError::Sftp`（狀態碼對映成本地化訊息）。
pub fn map_err(e: SftpError) -> AppError {
    let msg = match &e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => t!("找不到檔案或目錄").to_string(),
            StatusCode::PermissionDenied => t!("權限不足").to_string(),
            StatusCode::OpUnsupported => t!("伺服器不支援此操作").to_string(),
            StatusCode::NoConnection | StatusCode::ConnectionLost => {
                t!("SFTP 連線已中斷").to_string()
            }
            StatusCode::Eof => t!("已到檔案結尾").to_string(),
            StatusCode::BadMessage => t!("SFTP 協定錯誤").to_string(),
            StatusCode::Ok | StatusCode::Failure => {
                let m = s.error_message.trim();
                if m.is_empty() || m.eq_ignore_ascii_case("failure") {
                    t!("操作失敗（伺服器未說明原因；常見為檔案已存在或目錄非空）").to_string()
                } else {
                    m.to_string()
                }
            }
        },
        SftpError::Timeout => t!("SFTP 操作逾時").to_string(),
        SftpError::IO(s) => tf!("SFTP I/O 錯誤：{e}", e = s),
        other => tf!("SFTP 錯誤：{e}", e = other),
    };
    AppError::Sftp(msg)
}

/// 遠端檔案讀寫（`File` 的 AsyncRead / AsyncWrite 把 SFTP 狀態包成 io::Error）。
fn io_err(e: std::io::Error) -> AppError {
    AppError::Sftp(tf!("SFTP I/O 錯誤：{e}", e = e))
}

/// 本機檔案系統錯誤。
fn local_err(e: std::io::Error) -> AppError {
    AppError::Sftp(tf!("本機檔案錯誤：{e}", e = e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_plan_absorb_prefixes_segments() {
        let sub = TreePlan {
            dirs: vec![vec!["css".into()]],
            files: vec![
                ("/r/site/index.html".into(), vec!["index.html".into()], 12),
                ("/r/site/css/a.css".into(), vec!["css".into(), "a.css".into()], 3),
            ],
            skipped: 1,
        };
        let mut plan = TreePlan::default();
        assert!(plan.is_empty());
        plan.files.push(("/r/notes.txt".into(), vec!["notes.txt".into()], 5));
        plan.absorb("site", sub);
        assert_eq!(plan.dirs, vec![vec!["site".to_string()], vec!["site".to_string(), "css".to_string()]]);
        assert_eq!(plan.files[1].1, vec!["site".to_string(), "index.html".to_string()]);
        assert_eq!(plan.files[2].1, vec!["site".to_string(), "css".to_string(), "a.css".to_string()]);
        assert_eq!(plan.skipped, 1);
        assert_eq!(plan.len(), 5);
        assert_eq!(plan.total_bytes(), 20);
    }

    #[test]
    fn batch_summary_messages() {
        assert_eq!(BatchSummary::default().message(), None);
        let m = BatchSummary { files: 3, skipped_existing: 2, skipped_special: 0 }.message().unwrap();
        assert!(m.contains('2'), "{m}");
        let m = BatchSummary { files: 0, skipped_existing: 0, skipped_special: 7 }.message().unwrap();
        assert!(m.contains('7'), "{m}");
        let m = BatchSummary { files: 0, skipped_existing: 1, skipped_special: 4 }.message().unwrap();
        assert!(m.contains('1') && m.contains('4'), "{m}");
    }

    #[test]
    fn on_conflict_deserializes_snake_case() {
        assert_eq!(serde_json::from_str::<OnConflict>("\"skip\"").unwrap(), OnConflict::Skip);
        assert_eq!(serde_json::from_str::<OnConflict>("\"overwrite\"").unwrap(), OnConflict::Overwrite);
        assert_eq!(serde_json::from_str::<OnConflict>("\"fail\"").unwrap(), OnConflict::Fail);
        assert!(serde_json::from_str::<OnConflict>("\"Skip\"").is_err());
    }

    #[tokio::test]
    async fn local_conflicts_uses_sanitized_names() {
        let dir = std::env::temp_dir().join(format!("dbkit-conflicts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        std::fs::write(dir.join(sanitize_local_filename("b:c.txt")), b"x").unwrap();
        let names: Vec<String> = ["a.txt", "logs", "b:c.txt", "zzz"].iter().map(|s| s.to_string()).collect();
        let got = local_conflicts(&dir, &names).await;
        assert_eq!(got, vec!["a.txt".to_string(), "logs".to_string(), "b:c.txt".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kind_uses_exact_type_bits() {
        assert_eq!(kind_of_mode(Some(0o040755)), Kind::Dir);
        assert_eq!(kind_of_mode(Some(0o120777)), Kind::Symlink);
        assert_eq!(kind_of_mode(Some(0o100644)), Kind::File);
        // bit-contains 會把這兩個當成資料夾（0o140000 / 0o060000 都含 0o040000）
        assert_eq!(kind_of_mode(Some(0o140755)), Kind::Other);
        assert_eq!(kind_of_mode(Some(0o060660)), Kind::Other);
        assert_eq!(kind_of_mode(Some(0o020620)), Kind::Other);
        assert_eq!(kind_of_mode(Some(0o010644)), Kind::Other);
        // 沒有型別位元 → 一般檔案
        assert_eq!(kind_of_mode(Some(0o644)), Kind::File);
        assert_eq!(kind_of_mode(None), Kind::File);
        let mut md = FileAttributes::empty();
        md.permissions = Some(0o140755);
        let e = entry_from("S.gpg-agent".into(), "/home/u/S.gpg-agent".into(), &md);
        assert!(!e.is_dir && !e.is_symlink);
        assert_eq!(e.mode, "srwxr-xr-x");
    }

    #[test]
    fn mode_strings() {
        assert_eq!(mode_string(0o40755), "drwxr-xr-x");
        assert_eq!(mode_string(0o100644), "-rw-r--r--");
        assert_eq!(mode_string(0o120777), "lrwxrwxrwx");
        assert_eq!(mode_string(0o104755), "-rwsr-xr-x", "setuid");
        assert_eq!(mode_string(0o102644), "-rw-r-Sr--", "setgid 無 x");
        assert_eq!(mode_string(0o41777), "drwxrwxrwt", "sticky");
        assert_eq!(mode_string(0o644), "-rw-r--r--", "沒有型別位元 → 檔案");
        assert_eq!(mode_string(0o20620), "crw--w----");
    }

    #[test]
    fn remote_join_rejects_traversal() {
        assert_eq!(remote_join("/home/u", "a.txt").unwrap(), "/home/u/a.txt");
        assert_eq!(remote_join("/", "a").unwrap(), "/a");
        assert_eq!(remote_join("", "a").unwrap(), "a");
        assert_eq!(remote_join(".", "a").unwrap(), "a");
        for bad in ["", ".", "..", "a/b", "a\0b", "../x"] {
            assert!(matches!(remote_join("/d", bad), Err(AppError::Sftp(_))), "{bad:?}");
        }
    }

    #[test]
    fn basename_and_root_like() {
        assert_eq!(basename("/home/u/x.txt"), "x.txt");
        assert_eq!(basename("/home/u/"), "u");
        assert_eq!(basename("/"), "/");
        assert_eq!(basename("x"), "x");
        for p in ["", "/", ".", "..", "/.", "//", "/home/..", "a/..", "a/../..", " / "] {
            assert!(is_root_like(p), "{p:?} 應被視為根");
        }
        for p in ["/home", "/home/u", "x", "./x", "/a/../b", "a/b/.."] {
            assert!(!is_root_like(p), "{p:?} 不是根");
        }
    }

    #[test]
    fn sanitize_filenames() {
        assert_eq!(sanitize_local_filename("con"), "_con");
        assert_eq!(sanitize_local_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_local_filename("com1"), "_com1");
        assert_eq!(sanitize_local_filename("com0"), "com0");
        assert_eq!(sanitize_local_filename("lpt9.log"), "_lpt9.log");
        assert_eq!(sanitize_local_filename("console"), "console", "只擋完全相符的保留名");
        assert_eq!(sanitize_local_filename("a<b>c:d\"e/f\\g|h?i*j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_local_filename("trailing. . "), "trailing");
        assert_eq!(sanitize_local_filename("tab\tx"), "tab_x");
        assert_eq!(sanitize_local_filename(""), "_");
        assert_eq!(sanitize_local_filename("..."), "_");
        assert_eq!(sanitize_local_filename("正常.txt"), "正常.txt");
    }

    #[test]
    fn decode_text_flags() {
        let t = decode_text("hello\n世界".as_bytes().to_vec(), false, 12);
        assert_eq!(t.text, "hello\n世界");
        assert!(!t.lossy && !t.binary && !t.truncated);

        // 截斷在「界」（3 bytes）中間：丟掉那半個字，不算 lossy。
        let mut cut = "ab界".as_bytes().to_vec();
        cut.truncate(4);
        let t = decode_text(cut, true, 99);
        assert_eq!(t.text, "ab");
        assert!(!t.lossy, "截斷不是檔案壞掉");

        // 同樣的半個字但沒有截斷 → 檔案本身就是壞的 UTF-8。
        let mut bad = "ab界".as_bytes().to_vec();
        bad.truncate(4);
        let t = decode_text(bad, false, 4);
        assert!(t.lossy);
        assert!(t.text.contains('\u{FFFD}'));

        // Big5 / Latin-1 這類非 UTF-8 → lossy。
        let t = decode_text(vec![0xa7, 0x41, 0x61], false, 3);
        assert!(t.lossy);

        // NUL → binary（前 8 KiB 內才看）。
        let t = decode_text(b"ELF\0\x01\x02".to_vec(), false, 6);
        assert!(t.binary);
        let mut late = vec![b'a'; 9000];
        late.push(0);
        assert!(!decode_text(late, false, 9001).binary, "8 KiB 之後的 NUL 不看");
    }

    #[test]
    fn tree_path_helpers() {
        let seg = vec!["a".to_string(), "b.txt".to_string()];
        assert_eq!(remote_join_segments("/home/u/dst", &seg).unwrap(), "/home/u/dst/a/b.txt");
        assert_eq!(remote_join_segments("/", &seg).unwrap(), "/a/b.txt");
        assert!(remote_join_segments("/x", &["..".to_string()]).is_err(), "不可信的路徑段要擋");
        assert!(remote_join_segments("/x", &["a/b".to_string()]).is_err());
        assert_eq!(join_segments(Path::new("C:/dl"), &seg), PathBuf::from("C:/dl").join("a").join("b.txt"));
        let plan = TreePlan { dirs: vec![], files: vec![("r".into(), vec![], 5), ("s".into(), vec![], 7)], skipped: 0 };
        assert_eq!(plan.total_bytes(), 12);
    }

    #[tokio::test]
    async fn plan_local_tree_walks_nested_dirs() {
        let root = std::env::temp_dir().join(format!("dbkit-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub/deeper")).unwrap();
        std::fs::write(root.join("top.txt"), b"12345").unwrap();
        std::fs::write(root.join("sub/mid.txt"), b"123").unwrap();
        std::fs::write(root.join("sub/deeper/leaf.bin"), [0u8; 10]).unwrap();
        let plan = plan_local_tree(&root, &AtomicBool::new(false)).await.unwrap();
        assert_eq!(plan.total_bytes(), 18);
        assert_eq!(plan.files.len(), 3);
        assert_eq!(plan.dirs, vec![vec!["sub".to_string()], vec!["sub".to_string(), "deeper".to_string()]], "父資料夾先建");
        let mut rels: Vec<String> = plan.files.iter().map(|f| f.1.join("/")).collect();
        rels.sort();
        assert_eq!(rels, vec!["sub/deeper/leaf.bin", "sub/mid.txt", "top.txt"]);
        // 取消旗標一開始就立起來 → 不掃
        assert!(matches!(plan_local_tree(&root, &AtomicBool::new(true)).await, Err(AppError::SshCancelled)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn part_path_appends() {
        assert_eq!(part_path(Path::new("C:/x/a.tar.gz")), PathBuf::from("C:/x/a.tar.gz.part"));
    }

    #[test]
    fn map_status_codes() {
        use russh_sftp::protocol::Status;
        let st = |code: StatusCode, msg: &str| {
            map_err(SftpError::Status(Status {
                id: 1,
                status_code: code,
                error_message: msg.into(),
                language_tag: String::new(),
            }))
        };
        assert!(matches!(st(StatusCode::NoSuchFile, "x"), AppError::Sftp(_)));
        match st(StatusCode::Failure, "Directory not empty") {
            AppError::Sftp(m) => assert_eq!(m, "Directory not empty"),
            e => panic!("{e:?}"),
        }
        match st(StatusCode::Failure, "Failure") {
            AppError::Sftp(m) => assert!(m.contains("伺服器未說明原因"), "{m}"),
            e => panic!("{e:?}"),
        }
        assert!(matches!(map_err(SftpError::Timeout), AppError::Sftp(_)));
    }
}
