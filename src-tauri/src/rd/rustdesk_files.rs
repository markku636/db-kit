// RustDesk 檔案傳輸：另開一條 RustDesk 連線（輔助程式 `connect` 帶 `file_transfer: true`，對方不送畫面），
// 讓檔案面板（SftpPanel + `ssh_sftp_*` 命令）把它當成第三種檔案後端，跟 SFTP / FTP 共用瀏覽、上下傳、
// 衝突處理與傳輸清單。協定與單檔上下傳由輔助程式做（rustdesk-bridge/src/files.rs），這裡只負責：
// - 指令編號（`req`）與輔助程式事件的對應（`fs_dir` / `fs_done` / `fs_err`；傳輸中的 `fs_progress`）；
// - 檔案面板的 POSIX 路徑 ↔ 對方的路徑：Windows 對方是 `C:\Users\me`，面板顯示成 `/C:/Users/me`，
//   根目錄 `/` 是磁碟機清單（官方對方收到 `/` 就回磁碟機）；
// - RustDesk 沒有的操作：stat（列上一層找）、遞迴刪除（先列整棵刪檔，再刪空資料夾）、改權限（不支援）、
//   小檔讀寫（下載 / 上傳一個暫存檔）。
//
// 對方的 RustDesk 1.4.9 列不存在的資料夾時不回應（沒有錯誤），列目錄因此有逾時。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc;

use super::rustdesk::{json_of, write_json, Connected, Output};
use crate::error::{AppError, AppResult};
use crate::ssh::sftp::{
    decode_text, part_path, remote_join, resolve_local_target, Kind, OnConflict, ProgressFn, RemoteFs, SftpEntry, SftpText,
    WRITE_TEXT_MAX,
};

/// 列目錄等多久（對方 1.4.9 對不存在的資料夾不回應）。
const LS_TIMEOUT: Duration = Duration::from_secs(15);
/// 建資料夾 / 刪除 / 改名等多久。
const OP_TIMEOUT: Duration = Duration::from_secs(60);
/// 傳輸中多久沒有任何進度就當成斷了。
const STALL_TIMEOUT: Duration = Duration::from_secs(120);

fn rd_err(msg: impl Into<String>) -> AppError {
    AppError::Rd(msg.into())
}

/// 面板路徑 → Windows 對方的路徑。`/` = 磁碟機清單；`/C:` → `C:\`；`/C:/Users/me` → `C:\Users\me`。
pub fn win_to_peer(ui: &str) -> String {
    let t = ui.trim_start_matches('/').trim_end_matches('/');
    if t.is_empty() {
        return "/".into();
    }
    let mut s = t.replace('/', "\\");
    if s.len() == 2 && s.ends_with(':') {
        s.push('\\');
    }
    s
}

/// Windows 對方的路徑 → 面板路徑（`win_to_peer` 的反方向）。
pub fn win_to_ui(peer: &str) -> String {
    let s = peer.replace('\\', "/");
    let s = s.trim_matches('/');
    if s.is_empty() {
        "/".into()
    } else {
        format!("/{s}")
    }
}

fn parent_of(path: &str) -> String {
    let t = path.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => t[..i].to_string(),
    }
}

fn base_of(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

fn kind_of(kind: &str) -> Kind {
    match kind {
        "dir" | "dir_link" | "drive" => Kind::Dir,
        _ => Kind::File,
    }
}

/// 一條 RustDesk 傳檔連線。
pub struct RdFileClient {
    pub conn_id: String,
    /// 對方的家目錄（面板路徑）。
    pub home: String,
    windows: bool,
    stdin: tokio::sync::Mutex<ChildStdin>,
    waiters: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>>,
    next_req: AtomicU64,
    /// 連線結束的原因（`None` = 還連著）。
    closed: Arc<Mutex<Option<String>>>,
    child: tokio::sync::Mutex<Option<Child>>,
    reader: tokio::task::JoinHandle<()>,
    /// 經 SSH 轉接時的本地轉發任務。
    fwd: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for RdFileClient {
    fn drop(&mut self) {
        self.reader.abort();
        if let Some(f) = &self.fwd {
            f.abort();
        }
    }
}

impl RdFileClient {
    /// 接手登入好的輔助程式：起讀事件的任務、問家目錄。
    pub async fn start(conn_id: String, c: Connected, fwd: Option<tokio::task::JoinHandle<()>>) -> AppResult<Arc<Self>> {
        let (child, stdin, out, hello) = c.into_io();
        let windows = json_of(&hello).is_some_and(|v| v["peer"]["platform"] == "Windows");
        let waiters: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>> = Arc::default();
        let closed: Arc<Mutex<Option<String>>> = Arc::default();
        let reader = tokio::spawn(read_events(out, waiters.clone(), closed.clone()));
        let mut client = RdFileClient {
            conn_id,
            home: "/".into(),
            windows,
            stdin: tokio::sync::Mutex::new(stdin),
            waiters,
            next_req: AtomicU64::new(1),
            closed,
            child: tokio::sync::Mutex::new(Some(child)),
            reader,
            fwd,
        };
        let v = client.call(json!({ "t": "fs_ls", "path": "", "hidden": false }), LS_TIMEOUT).await?;
        client.home = client.to_ui(v["path"].as_str().unwrap_or("/"));
        Ok(Arc::new(client))
    }

    /// 結束傳檔連線（關掉輔助程式）。
    pub async fn shutdown(&self) {
        if let Some(mut c) = self.child.lock().await.take() {
            let _ = c.kill().await;
        }
    }

    fn to_peer(&self, ui: &str) -> String {
        if self.windows {
            win_to_peer(ui)
        } else {
            ui.to_string()
        }
    }

    fn to_ui(&self, peer: &str) -> String {
        if self.windows {
            win_to_ui(peer)
        } else if peer.is_empty() {
            "/".into()
        } else {
            peer.to_string()
        }
    }

    fn peer_join(&self, dir: &str, name: &str) -> String {
        let sep = if self.windows { '\\' } else { '/' };
        if dir.ends_with(sep) {
            format!("{dir}{name}")
        } else {
            format!("{dir}{sep}{name}")
        }
    }

    /// 送一個指令，回傳收這個指令事件的接收端。
    async fn request(&self, mut cmd: Value) -> AppResult<(u64, mpsc::UnboundedReceiver<Value>)> {
        if let Some(r) = self.closed.lock().clone() {
            return Err(rd_err(tf!("RustDesk 傳檔連線已中斷：{e}", e = r)));
        }
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        cmd["req"] = json!(req);
        let (tx, rx) = mpsc::unbounded_channel();
        self.waiters.lock().insert(req, tx);
        let mut w = self.stdin.lock().await;
        if write_json(&mut *w, &cmd).await.is_err() {
            self.waiters.lock().remove(&req);
            return Err(rd_err(t!("RustDesk 連線元件意外結束")));
        }
        Ok((req, rx))
    }

    fn done(&self, req: u64) {
        self.waiters.lock().remove(&req);
    }

    fn gone(&self) -> AppError {
        let r = self.closed.lock().clone().unwrap_or_default();
        rd_err(tf!("RustDesk 傳檔連線已中斷：{e}", e = r))
    }

    /// 等這個指令的結果（`fs_dir` / `fs_done`；`fs_err` → 錯誤）。
    async fn call(&self, cmd: Value, timeout: Duration) -> AppResult<Value> {
        let (req, mut rx) = self.request(cmd).await?;
        let r = tokio::time::timeout(timeout, async {
            loop {
                match rx.recv().await {
                    Some(v) if v["type"] == "fs_progress" => continue,
                    Some(v) if v["type"] == "fs_err" => break Err(rd_err(v["error"].as_str().unwrap_or_default())),
                    Some(v) => break Ok(v),
                    None => break Err(self.gone()),
                }
            }
        })
        .await;
        self.done(req);
        r.unwrap_or_else(|_| Err(rd_err(t!("對方的 RustDesk 沒有回應（資料夾可能不存在或沒有權限）"))))
    }

    /// 上傳 / 下載：轉發進度、看取消旗標；取消時請輔助程式停掉這個工作。
    async fn transfer(&self, cmd: Value, progress: &ProgressFn, cancel: &AtomicBool) -> AppResult<Value> {
        let (req, mut rx) = self.request(cmd).await?;
        let mut last = tokio::time::Instant::now();
        let result = loop {
            if cancel.load(Ordering::Relaxed) {
                let mut w = self.stdin.lock().await;
                let _ = write_json(&mut *w, &json!({ "t": "fs_cancel", "req": req })).await;
                break Err(AppError::SshCancelled);
            }
            match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
                Ok(Some(v)) if v["type"] == "fs_progress" => {
                    last = tokio::time::Instant::now();
                    progress(v["done"].as_u64().unwrap_or(0), v["total"].as_u64());
                }
                Ok(Some(v)) if v["type"] == "fs_err" => break Err(rd_err(v["error"].as_str().unwrap_or_default())),
                Ok(Some(v)) => break Ok(v),
                Ok(None) => break Err(self.gone()),
                Err(_) if last.elapsed() > STALL_TIMEOUT => {
                    let mut w = self.stdin.lock().await;
                    let _ = write_json(&mut *w, &json!({ "t": "fs_cancel", "req": req })).await;
                    break Err(rd_err(t!("對方的 RustDesk 沒有回應（傳輸停住了）")));
                }
                Err(_) => {}
            }
        };
        self.done(req);
        result
    }

    /// 對方的目錄（面板路徑）。
    async fn ls(&self, ui_dir: &str) -> AppResult<(String, Vec<Value>)> {
        let v = self.call(json!({ "t": "fs_ls", "path": self.to_peer(ui_dir), "hidden": true }), LS_TIMEOUT).await?;
        let entries = v["entries"].as_array().cloned().unwrap_or_default();
        Ok((self.to_ui(v["path"].as_str().unwrap_or(ui_dir)), entries))
    }

    fn entry(&self, dir: &str, e: &Value) -> Option<SftpEntry> {
        let name = e["name"].as_str()?;
        // 對方給的名字要是單純一段（擋 `..` / 路徑分隔字元）；磁碟機（`C:`）例外。
        let path = if e["kind"] == "drive" { format!("/{}", name.trim_end_matches(['\\', '/'])) } else { remote_join(dir, name).ok()? };
        let is_dir = kind_of(e["kind"].as_str().unwrap_or("file")) == Kind::Dir;
        let is_link = matches!(e["kind"].as_str(), Some("dir_link" | "file_link"));
        Some(SftpEntry {
            name: base_of(&path).to_string(),
            path,
            is_dir,
            is_symlink: is_link,
            link_target_is_dir: is_link.then_some(is_dir),
            size: e["size"].as_u64().unwrap_or(0),
            mtime: e["mtime"].as_u64().filter(|t| *t > 0),
            permissions: None,
            mode: String::new(),
            uid: None,
            gid: None,
            owner: None,
            group: None,
        })
    }

    pub async fn list_dir(&self, path: &str) -> AppResult<Vec<SftpEntry>> {
        let (dir, entries) = self.ls(path).await?;
        let mut out: Vec<SftpEntry> = entries.iter().filter_map(|e| self.entry(&dir, e)).collect();
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    /// RustDesk 沒有 stat：列上一層找同名的。根目錄與磁碟機本身是資料夾。
    pub async fn stat(&self, path: &str) -> AppResult<SftpEntry> {
        let p = path.trim_end_matches('/');
        let is_drive = self.windows && p.trim_start_matches('/').len() == 2 && p.ends_with(':');
        if p.is_empty() || is_drive {
            let p = if p.is_empty() { "/".to_string() } else { p.to_string() };
            return Ok(SftpEntry {
                name: base_of(&p).to_string(),
                path: p,
                is_dir: true,
                is_symlink: false,
                link_target_is_dir: None,
                size: 0,
                mtime: None,
                permissions: None,
                mode: String::new(),
                uid: None,
                gid: None,
                owner: None,
                group: None,
            });
        }
        let name = base_of(p);
        let parent = parent_of(p);
        self.list_dir(&parent)
            .await?
            .into_iter()
            .find(|e| e.name == name)
            .ok_or_else(|| rd_err(tf!("找不到：{path}", path = path)))
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        self.call(json!({ "t": "fs_mkdir", "path": self.to_peer(path) }), OP_TIMEOUT).await.map(|_| ())
    }

    /// RustDesk 只能在同一個資料夾裡改名（官方 `rename_file` 只收新名字）。
    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if parent_of(from) != parent_of(to) {
            return Err(rd_err(t!("RustDesk 只能在同一個資料夾裡改名，不能搬到別的資料夾")));
        }
        let new_name = base_of(to);
        if new_name.is_empty() {
            return Err(rd_err(t!("新的名稱不能是空的")));
        }
        self.call(json!({ "t": "fs_rename", "path": self.to_peer(from), "new_name": new_name }), OP_TIMEOUT).await.map(|_| ())
    }

    /// 刪除。資料夾：對方只刪得掉空的，所以 `recursive` 時先列出整棵、一個一個刪檔，再刪資料夾（含裡面的空資料夾）。
    pub async fn remove(&self, path: &str, recursive: bool) -> AppResult<()> {
        let st = self.stat(path).await?;
        let peer = self.to_peer(path);
        if !st.is_dir || st.is_symlink {
            return self.call(json!({ "t": "fs_rm", "path": peer }), OP_TIMEOUT).await.map(|_| ());
        }
        if recursive {
            let v = self.call(json!({ "t": "fs_all", "path": peer }), OP_TIMEOUT).await?;
            for e in v["entries"].as_array().cloned().unwrap_or_default() {
                let Some(name) = e["name"].as_str() else { continue };
                // 對方給的相對路徑：擋掉往上跳的。
                if name.split(['/', '\\']).any(|s| s == ".." || s.is_empty()) {
                    continue;
                }
                self.call(json!({ "t": "fs_rm", "path": self.peer_join(&peer, name) }), OP_TIMEOUT).await?;
            }
        }
        self.call(json!({ "t": "fs_rmdir", "path": peer }), OP_TIMEOUT).await.map(|_| ())
    }

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!("db-kit-rd-{}", uuid::Uuid::new_v4()))
    }

    /// 小檔：下載到暫存檔再讀（給檔案面板的檢視 / 編輯器）。
    pub async fn read_small(&self, path: &str, max: u64) -> AppResult<SftpText> {
        let st = self.stat(path).await?;
        let tmp = Self::temp_path();
        let noop: ProgressFn = Box::new(|_, _| {});
        let r = self
            .transfer(
                json!({ "t": "fs_download", "remote": self.to_peer(path), "local": tmp.to_string_lossy() }),
                &noop,
                &AtomicBool::new(false),
            )
            .await;
        let bytes = match r {
            Ok(_) => tokio::fs::read(&tmp).await.map_err(|e| rd_err(e.to_string())),
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_file(&tmp).await;
        let mut buf = bytes?;
        let truncated = buf.len() as u64 > max;
        buf.truncate(max as usize);
        Ok(decode_text(buf, truncated, st.size))
    }

    /// 小檔：寫進暫存檔再上傳覆蓋。`create_new` = 新檔（已有同名就失敗）。
    pub async fn write_text(&self, path: &str, content: &str, create_new: bool) -> AppResult<SftpEntry> {
        if content.len() > WRITE_TEXT_MAX {
            return Err(rd_err(t!("內容太大，無法直接存檔")));
        }
        if create_new && self.stat(path).await.is_ok() {
            return Err(rd_err(tf!("遠端檔案已存在：{path}", path = path)));
        }
        let tmp = Self::temp_path();
        tokio::fs::write(&tmp, content.as_bytes()).await.map_err(|e| rd_err(e.to_string()))?;
        let noop: ProgressFn = Box::new(|_, _| {});
        let r = self
            .transfer(
                json!({ "t": "fs_upload", "local": tmp.to_string_lossy(), "remote": self.to_peer(path) }),
                &noop,
                &AtomicBool::new(false),
            )
            .await;
        let _ = tokio::fs::remove_file(&tmp).await;
        r?;
        self.stat(path).await
    }
}

/// 讀輔助程式的事件，照 `req` 分給等待的人；連線結束時記下原因、叫醒所有人。
async fn read_events(mut out: Output, waiters: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>>, closed: Arc<Mutex<Option<String>>>) {
    let reason = loop {
        match out.recv().await {
            Some(Ok(m)) => {
                let Some(v) = json_of(&m) else { continue };
                if v["type"] == "closed" || v["type"] == "error" {
                    break v["reason"].as_str().or(v["message"].as_str()).unwrap_or_default().to_string();
                }
                if let Some(req) = v["req"].as_u64() {
                    if let Some(tx) = waiters.lock().get(&req) {
                        let _ = tx.send(v);
                    }
                }
            }
            Some(Err(e)) => break e.to_string(),
            None => break t!("RustDesk 連線元件意外結束").to_string(),
        }
    };
    *closed.lock() = Some(if reason.is_empty() { t!("遠端主機關閉了連線").to_string() } else { reason });
    // 丟掉所有傳送端：等待中的人收到 None → 回報連線中斷。
    waiters.lock().clear();
}

#[async_trait]
impl RemoteFs for RdFileClient {
    fn fail_kind(&self) -> fn(String) -> AppError {
        AppError::Rd
    }

    async fn read_dir_kinds(&self, dir: &str) -> AppResult<Vec<(String, Kind, u64)>> {
        let (_, entries) = self.ls(dir).await?;
        Ok(entries
            .iter()
            .filter(|e| e["kind"] != "drive")
            .filter_map(|e| {
                let name = e["name"].as_str()?.to_string();
                let kind = match e["kind"].as_str() {
                    Some("dir") => Kind::Dir,
                    Some("dir_link" | "file_link") => Kind::Symlink,
                    _ => Kind::File,
                };
                Some((name, kind, e["size"].as_u64().unwrap_or(0)))
            })
            .collect())
    }

    async fn kind_follow(&self, path: &str) -> AppResult<(Kind, u64)> {
        let st = self.stat(path).await?;
        Ok((if st.is_dir { Kind::Dir } else { Kind::File }, st.size))
    }

    async fn kind_nofollow(&self, path: &str) -> AppResult<Kind> {
        let st = self.stat(path).await?;
        Ok(if st.is_symlink {
            Kind::Symlink
        } else if st.is_dir {
            Kind::Dir
        } else {
            Kind::File
        })
    }

    async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    async fn create_dir(&self, path: &str) -> AppResult<()> {
        self.mkdir(path).await
    }

    /// 單檔下載：本機目標與同名處理跟 SFTP / FTP 一樣；續傳（`Resume`）當成重新下載。
    async fn download(
        &self,
        remote: &str,
        local: &Path,
        on_conflict: OnConflict,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<PathBuf> {
        let local = resolve_local_target(local, remote).await;
        if tokio::fs::metadata(&local).await.is_ok() {
            match on_conflict {
                OnConflict::Fail => return Err(rd_err(tf!("本機檔案已存在：{path}", path = local.display()))),
                OnConflict::Skip => return Ok(local),
                OnConflict::Overwrite | OnConflict::Resume => {}
            }
        }
        let r = self
            .transfer(
                json!({ "t": "fs_download", "remote": self.to_peer(remote), "local": local.to_string_lossy() }),
                &progress,
                cancel,
            )
            .await;
        if r.is_err() {
            // 輔助程式失敗 / 取消時會自己刪 `.part`；連線斷掉時這裡補刪。
            let _ = tokio::fs::remove_file(part_path(&local)).await;
        }
        r.map(|_| local)
    }

    /// 單檔上傳：對方已有同名檔時照 `on_conflict`（`Resume`：大小一樣就當傳完了，否則重傳）。
    async fn upload(
        &self,
        local: &Path,
        remote: &str,
        on_conflict: OnConflict,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        let size = tokio::fs::metadata(local).await.map_err(|e| rd_err(e.to_string()))?.len();
        if let Ok(st) = self.stat(remote).await {
            if st.is_dir {
                return Err(rd_err(tf!("遠端已有同名的資料夾：{path}", path = remote)));
            }
            match on_conflict {
                OnConflict::Fail => return Err(rd_err(tf!("遠端檔案已存在：{path}", path = remote))),
                OnConflict::Skip => return Ok(()),
                OnConflict::Resume if st.size == size => {
                    progress(size, Some(size));
                    return Ok(());
                }
                _ => {}
            }
        }
        self.transfer(json!({ "t": "fs_upload", "local": local.to_string_lossy(), "remote": self.to_peer(remote) }), &progress, cancel)
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_round_trip() {
        assert_eq!(win_to_peer("/"), "/");
        assert_eq!(win_to_peer(""), "/");
        assert_eq!(win_to_peer("/C:"), "C:\\");
        assert_eq!(win_to_peer("/C:/"), "C:\\");
        assert_eq!(win_to_peer("/C:/Users/me"), "C:\\Users\\me");
        assert_eq!(win_to_ui("C:\\Users\\me"), "/C:/Users/me");
        assert_eq!(win_to_ui("C:\\"), "/C:");
        assert_eq!(win_to_ui("/"), "/");
        for p in ["/C:/Users/me", "/D:", "/"] {
            assert_eq!(win_to_ui(&win_to_peer(p)), p);
        }
    }

    #[test]
    fn parents_and_names() {
        assert_eq!(parent_of("/tmp/a.txt"), "/tmp");
        assert_eq!(parent_of("/a"), "/");
        assert_eq!(parent_of("/"), "/");
        assert_eq!(parent_of("/C:/Users/"), "/C:");
        assert_eq!(base_of("/tmp/a.txt"), "a.txt");
        assert_eq!(base_of("/C:"), "C:");
    }
}
