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
use serde::Serialize;
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
#[derive(Debug, Clone, Serialize)]
pub struct SftpText {
    pub text: String,
    pub truncated: bool,
    pub size: u64,
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
                    async move { (i, self.inner.metadata(p).await.ok().map(|m| m.is_dir())) }
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
            e.link_target_is_dir = self.inner.metadata(path.to_string()).await.ok().map(|m| m.is_dir());
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
        if md.is_dir() && !md.is_symlink() {
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
                    if m.is_dir() && !m.is_symlink() {
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
        Ok(SftpText { text: String::from_utf8_lossy(&buf).into_owned(), truncated, size })
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
}

// ---- 屬性 / 路徑工具（純函式，可測）----

fn entry_from(name: String, path: String, md: &FileAttributes) -> SftpEntry {
    let permissions = md.permissions;
    SftpEntry {
        name,
        path,
        is_dir: md.is_dir(),
        is_symlink: md.is_symlink(),
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
