// RustDesk 傳檔（`connect` 帶 `file_transfer: true` 的連線）：照官方用戶端 `src/client/io_loop.rs` 的檔案部分與
// `libs/base/src/fs.rs`（AGPL-3.0）。本機的檔案由這個輔助程式直接讀寫，db-kit 只收進度與結果。
//
// 協定（對方的回覆用 job id 對應；列目錄 `ReadDir` 的回覆 id 一律是 0，照送出的順序對）：
// - 列目錄：`FileAction.read_dir` → `FileResponse.dir`（或 `error`，id 0）。`path` 空的 = 對方的家目錄，回覆帶實際路徑。
// - 建資料夾 / 刪檔 / 刪空資料夾 / 改名（只能改同一層的名字）：`create` / `remove_file` / `remove_dir` / `rename`
//   → `done` 或 `error`（同一個 id）。對方的 `remove_dir` 只刪空的資料夾，裡面有檔案要先一個一個刪。
// - 下載（對方 → 這端）：`send { path }` → 對方回 `dir`（這次要傳的檔案；單一檔案時一筆、名字空的）→ 每個檔案先送
//   `digest`，這端回 `send_confirm`（這裡一律從頭寫：要不要覆蓋 db-kit 已經決定好了）→ 一塊一塊的 `block`
//   （最多 128 KB，可能是 zstd 壓縮的）→ 檔案結尾一個空的 `block` → 全部完成送 `done`。
// - 上傳（這端 → 對方）：`receive { path, files }` 宣告 → 這端送 `digest` → 對方回 `send_confirm`（略過 = 對方已有一樣的檔案，
//   或從某個位置開始）或回 `digest`（對方已有不一樣的同名檔，要我們決定：一律覆蓋）→ 這端送 `block`…、空的 `block`、`done`
//   → 對方回 `done`。
//
// db-kit 傳整個資料夾時自己展開、一個檔案一個工作，所以這裡只做單一檔案的上傳 / 下載。
// 下載先寫 `<檔名>.part`，完成才改名（跟 db-kit 的 SFTP / FTP 一樣），中途失敗 / 取消就刪掉。
//
// SPDX-License-Identifier: AGPL-3.0-only

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::proto::message::{
    file_action, file_response, file_transfer_send_confirm_request, FileAction, FileDirCreate, FileDirectory, FileEntry,
    FileRemoveDir, FileRemoveFile, FileRename, FileResponse, FileTransferBlock, FileTransferCancel, FileTransferDigest,
    FileTransferDone, FileTransferReceiveRequest, FileTransferSendConfirmRequest, FileTransferSendRequest, FileType,
    Message, ReadAllFiles, ReadDir,
};

/// 一塊最多多大（官方 `BUF_SIZE`）。
pub const BLOCK: usize = 128 * 1024;
/// 解壓縮後最多多大（一塊原本 128 KB，留點餘裕；防對方送來解不完的東西）。
const MAX_BLOCK: usize = 1024 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// db-kit 的傳檔指令。`req` 是 db-kit 自己的編號，事件照它回報。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum FsCommand {
    FsLs {
        req: u64,
        path: String,
        #[serde(default)]
        hidden: bool,
    },
    /// 整棵資料夾裡的檔案（不含資料夾本身；名字是相對路徑）：刪資料夾前先刪裡面的檔案用。
    FsAll { req: u64, path: String },
    FsMkdir { req: u64, path: String },
    FsRm { req: u64, path: String },
    /// 刪資料夾（對方只刪得掉空的，含裡面的空資料夾）。
    FsRmdir { req: u64, path: String },
    /// `new_name` 是新的名字（不是路徑）。
    FsRename { req: u64, path: String, new_name: String },
    FsDownload { req: u64, remote: String, local: String },
    FsUpload { req: u64, local: String, remote: String },
    FsCancel { req: u64 },
}

/// 這一步要送給對方的封包與要回報給 db-kit 的事件。
#[derive(Default)]
pub struct Out {
    pub send: Vec<Message>,
    pub events: Vec<Value>,
}

impl Out {
    fn event(v: Value) -> Self {
        Out { send: Vec::new(), events: vec![v] }
    }
    fn send(m: Message) -> Self {
        Out { send: vec![m], events: Vec::new() }
    }
}

fn action(f: impl FnOnce(&mut FileAction)) -> Message {
    let mut a = FileAction::new();
    f(&mut a);
    let mut m = Message::new();
    m.set_file_action(a);
    m
}

fn response(f: impl FnOnce(&mut FileResponse)) -> Message {
    let mut r = FileResponse::new();
    f(&mut r);
    let mut m = Message::new();
    m.set_file_response(r);
    m
}

fn confirm_from_start(id: i32, file_num: i32) -> Message {
    action(|a| {
        a.set_send_confirm(FileTransferSendConfirmRequest {
            id,
            file_num,
            union: Some(file_transfer_send_confirm_request::Union::OffsetBlk(0)),
            ..Default::default()
        })
    })
}

fn err_event(req: u64, e: impl std::fmt::Display) -> Value {
    json!({ "type": "fs_err", "req": req, "error": e.to_string() })
}

fn kind_name(t: FileType) -> &'static str {
    match t {
        FileType::Dir => "dir",
        FileType::DirLink => "dir_link",
        FileType::DirDrive => "drive",
        FileType::File => "file",
        FileType::FileLink => "file_link",
    }
}

/// 對方的目錄 → db-kit 的事件。
pub fn dir_event(req: u64, d: &FileDirectory) -> Value {
    let entries: Vec<Value> = d
        .entries
        .iter()
        .map(|e| {
            json!({
                "name": e.name,
                "kind": kind_name(e.entry_type.enum_value().unwrap_or(FileType::File)),
                "size": e.size,
                "mtime": e.modified_time,
                "hidden": e.is_hidden,
            })
        })
        .collect();
    json!({ "type": "fs_dir", "req": req, "path": d.path, "entries": entries })
}

fn mtime_of(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

fn decompress(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut src = data;
    let dec = ruzstd::decoding::StreamingDecoder::new(&mut src).ok()?;
    let mut out = Vec::new();
    dec.take(MAX_BLOCK as u64 + 1).read_to_end(&mut out).ok()?;
    (out.len() <= MAX_BLOCK).then_some(out)
}

fn part_path(target: &std::path::Path) -> PathBuf {
    let mut s = target.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

struct Download {
    req: u64,
    target: PathBuf,
    part: PathBuf,
    mtime: u64,
    total: u64,
    done: u64,
    file: Option<tokio::fs::File>,
    last: Instant,
}

#[derive(Debug, PartialEq, Eq)]
enum UpState {
    /// 送了 digest，等對方說從哪開始。
    WaitConfirm,
    Sending,
    /// 都送完了，等對方回 done。
    WaitDone,
}

struct Upload {
    req: u64,
    local: PathBuf,
    total: u64,
    done: u64,
    state: UpState,
    file: Option<tokio::fs::File>,
    last: Instant,
}

/// 一條傳檔連線上的所有工作。
pub struct Files {
    next_id: i32,
    /// 列目錄的回覆沒有 id（都是 0）：用回覆帶的路徑對（要的是空路徑 = 家目錄，回覆帶的是實際路徑），錯誤沒有路徑才照順序。
    /// 對方在登入後也會主動送一次家目錄（官方 `read_dir(dir)`），沒人要的就略過。
    ls: VecDeque<(u64, String)>,
    /// 建資料夾 / 刪除 / 改名 / 列整棵：job id → req。
    simple: HashMap<i32, u64>,
    downloads: HashMap<i32, Download>,
    /// 上傳照開始的順序一個一個送（對方也是一個一個收）。
    uploads: Vec<(i32, Upload)>,
}

impl Default for Files {
    fn default() -> Self {
        Self::new()
    }
}

impl Files {
    pub fn new() -> Self {
        Files { next_id: 1, ls: VecDeque::new(), simple: HashMap::new(), downloads: HashMap::new(), uploads: Vec::new() }
    }

    fn id(&mut self) -> i32 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        id
    }

    fn job_of(&self, req: u64) -> Option<i32> {
        self.simple
            .iter()
            .find(|(_, r)| **r == req)
            .map(|(id, _)| *id)
            .or_else(|| self.downloads.iter().find(|(_, d)| d.req == req).map(|(id, _)| *id))
            .or_else(|| self.uploads.iter().find(|(_, u)| u.req == req).map(|(id, _)| *id))
    }

    pub async fn command(&mut self, c: FsCommand) -> Out {
        match c {
            FsCommand::FsLs { req, path, hidden } => {
                self.ls.push_back((req, path.clone()));
                Out::send(action(|a| a.set_read_dir(ReadDir { path, include_hidden: hidden, ..Default::default() })))
            }
            FsCommand::FsAll { req, path } => {
                let id = self.id();
                self.simple.insert(id, req);
                Out::send(action(|a| a.set_all_files(ReadAllFiles { id, path, include_hidden: true, ..Default::default() })))
            }
            FsCommand::FsMkdir { req, path } => {
                let id = self.id();
                self.simple.insert(id, req);
                Out::send(action(|a| a.set_create(FileDirCreate { id, path, ..Default::default() })))
            }
            FsCommand::FsRm { req, path } => {
                let id = self.id();
                self.simple.insert(id, req);
                Out::send(action(|a| a.set_remove_file(FileRemoveFile { id, path, file_num: 0, ..Default::default() })))
            }
            FsCommand::FsRmdir { req, path } => {
                let id = self.id();
                self.simple.insert(id, req);
                Out::send(action(|a| a.set_remove_dir(FileRemoveDir { id, path, recursive: true, ..Default::default() })))
            }
            FsCommand::FsRename { req, path, new_name } => {
                let id = self.id();
                self.simple.insert(id, req);
                Out::send(action(|a| a.set_rename(FileRename { id, path, new_name, ..Default::default() })))
            }
            FsCommand::FsDownload { req, remote, local } => {
                let id = self.id();
                let target = PathBuf::from(local);
                let part = part_path(&target);
                self.downloads.insert(
                    id,
                    Download { req, target, part, mtime: 0, total: 0, done: 0, file: None, last: Instant::now() },
                );
                Out::send(action(|a| {
                    a.set_send(FileTransferSendRequest { id, path: remote, include_hidden: true, file_num: 0, ..Default::default() })
                }))
            }
            FsCommand::FsUpload { req, local, remote } => {
                let local = PathBuf::from(local);
                let meta = match tokio::fs::metadata(&local).await {
                    Ok(m) if m.is_file() => m,
                    Ok(_) => return Out::event(err_event(req, "not a file")),
                    Err(e) => return Out::event(err_event(req, e)),
                };
                let (total, mtime) = (meta.len(), mtime_of(&meta));
                let id = self.id();
                let entry = FileEntry {
                    entry_type: FileType::File.into(),
                    size: total,
                    modified_time: mtime,
                    ..Default::default()
                };
                let receive = action(|a| {
                    a.set_receive(FileTransferReceiveRequest {
                        id,
                        path: remote,
                        files: vec![entry],
                        file_num: 0,
                        total_size: total,
                        ..Default::default()
                    })
                });
                let digest = response(|r| {
                    r.set_digest(FileTransferDigest { id, file_num: 0, last_modified: mtime, file_size: total, ..Default::default() })
                });
                self.uploads.push((
                    id,
                    Upload { req, local, total, done: 0, state: UpState::WaitConfirm, file: None, last: Instant::now() },
                ));
                Out { send: vec![receive, digest], events: vec![progress(req, 0, total)] }
            }
            FsCommand::FsCancel { req } => {
                let Some(id) = self.job_of(req) else { return Out::default() };
                self.simple.remove(&id);
                if let Some(mut d) = self.downloads.remove(&id) {
                    d.file.take();
                    let _ = tokio::fs::remove_file(&d.part).await;
                }
                self.uploads.retain(|(i, _)| *i != id);
                Out::send(action(|a| a.set_cancel(FileTransferCancel { id, ..Default::default() })))
            }
        }
    }

    /// 對方送來的 `FileResponse`。
    pub async fn on_response(&mut self, fr: FileResponse) -> Out {
        match fr.union {
            Some(file_response::Union::Dir(d)) if d.id == 0 => {
                let pos = self.ls.iter().position(|(_, p)| *p == d.path).or_else(|| self.ls.iter().position(|(_, p)| p.is_empty()));
                match pos.and_then(|i| self.ls.remove(i)) {
                    Some((req, _)) => Out::event(dir_event(req, &d)),
                    None => Out::default(),
                }
            }
            Some(file_response::Union::Dir(d)) => {
                if let Some(req) = self.simple.remove(&d.id) {
                    return Out::event(dir_event(req, &d));
                }
                // 下載：這次要傳的檔案清單（單一檔案一筆、名字空的）。
                if let Some(dl) = self.downloads.get_mut(&d.id) {
                    match &d.entries[..] {
                        [one] if one.name.is_empty() => {
                            dl.total = one.size;
                            dl.mtime = one.modified_time;
                            return Out::event(progress(dl.req, 0, dl.total));
                        }
                        _ => {
                            let req = dl.req;
                            self.downloads.remove(&d.id);
                            let id = d.id;
                            return Out {
                                send: vec![action(|a| a.set_cancel(FileTransferCancel { id, ..Default::default() }))],
                                events: vec![err_event(req, "not a file")],
                            };
                        }
                    }
                }
                Out::default()
            }
            Some(file_response::Union::Digest(dg)) => {
                // 下載：對方要開始送這個檔：一律從頭（覆不覆蓋 db-kit 已經決定了）。
                if self.downloads.contains_key(&dg.id) {
                    return Out::send(confirm_from_start(dg.id, dg.file_num));
                }
                // 上傳：對方已有不一樣的同名檔，要我們決定：覆蓋（db-kit 已經決定了）。
                if let Some((_, up)) = self.uploads.iter_mut().find(|(i, _)| *i == dg.id) {
                    if up.state == UpState::WaitConfirm {
                        if let Err(e) = up.open(0).await {
                            let req = up.req;
                            self.uploads.retain(|(i, _)| *i != dg.id);
                            return Out::event(err_event(req, e));
                        }
                    }
                    return Out::send(confirm_from_start(dg.id, dg.file_num));
                }
                Out::default()
            }
            Some(file_response::Union::Block(b)) => {
                let Some(dl) = self.downloads.get_mut(&b.id) else { return Out::default() };
                match dl.write(&b).await {
                    Ok(Some(ev)) => Out::event(ev),
                    Ok(None) => Out::default(),
                    Err(e) => {
                        let req = dl.req;
                        let id = b.id;
                        if let Some(mut d) = self.downloads.remove(&id) {
                            d.file.take();
                            let _ = tokio::fs::remove_file(&d.part).await;
                        }
                        Out {
                            send: vec![action(|a| a.set_cancel(FileTransferCancel { id, ..Default::default() }))],
                            events: vec![err_event(req, e)],
                        }
                    }
                }
            }
            Some(file_response::Union::Done(d)) => {
                if let Some(req) = self.simple.remove(&d.id) {
                    return Out::event(json!({ "type": "fs_done", "req": req }));
                }
                if let Some(dl) = self.downloads.remove(&d.id) {
                    let req = dl.req;
                    return match dl.finish().await {
                        Ok(ev) => Out::event(ev),
                        Err(e) => Out::event(err_event(req, e)),
                    };
                }
                if let Some(pos) = self.uploads.iter().position(|(i, _)| *i == d.id) {
                    let (_, up) = self.uploads.remove(pos);
                    return Out::event(json!({ "type": "fs_done", "req": up.req, "bytes": up.done }));
                }
                Out::default()
            }
            Some(file_response::Union::Error(e)) => {
                if e.id == 0 {
                    return match self.ls.pop_front() {
                        Some((req, _)) => Out::event(err_event(req, &e.error)),
                        None => Out::default(),
                    };
                }
                if let Some(req) = self.simple.remove(&e.id) {
                    return Out::event(err_event(req, &e.error));
                }
                if let Some(mut dl) = self.downloads.remove(&e.id) {
                    dl.file.take();
                    let _ = tokio::fs::remove_file(&dl.part).await;
                    return Out::event(err_event(dl.req, &e.error));
                }
                if let Some(pos) = self.uploads.iter().position(|(i, _)| *i == e.id) {
                    let (_, up) = self.uploads.remove(pos);
                    return Out::event(err_event(up.req, &e.error));
                }
                Out::default()
            }
            _ => Out::default(),
        }
    }

    /// 對方送來的 `FileAction`（上傳時對方回的 `send_confirm`）。
    pub async fn on_action(&mut self, fa: FileAction) -> Out {
        let Some(file_action::Union::SendConfirm(c)) = fa.union else { return Out::default() };
        let Some((_, up)) = self.uploads.iter_mut().find(|(i, _)| *i == c.id) else { return Out::default() };
        if up.state != UpState::WaitConfirm {
            return Out::default();
        }
        match c.union {
            // 對方已有一模一樣的檔案：不必傳，直接收尾。
            Some(file_transfer_send_confirm_request::Union::Skip(true)) => {
                up.state = UpState::WaitDone;
                up.done = up.total;
                let id = c.id;
                Out {
                    send: vec![response(|r| r.set_done(FileTransferDone { id, file_num: 1, ..Default::default() }))],
                    events: vec![progress(up.req, up.total, up.total)],
                }
            }
            Some(file_transfer_send_confirm_request::Union::OffsetBlk(n)) => match up.open(n).await {
                Ok(()) => Out::default(),
                Err(e) => {
                    let req = up.req;
                    self.uploads.retain(|(i, _)| *i != c.id);
                    Out::event(err_event(req, e))
                }
            },
            _ => match up.open(0).await {
                Ok(()) => Out::default(),
                Err(e) => {
                    let req = up.req;
                    self.uploads.retain(|(i, _)| *i != c.id);
                    Out::event(err_event(req, e))
                }
            },
        }
    }

    /// 有上傳正在送資料（主迴圈每輪送一塊，中間照樣收對方的封包）。
    pub fn has_upload_work(&self) -> bool {
        self.uploads.iter().any(|(_, u)| u.state == UpState::Sending)
    }

    /// 送下一塊；檔案讀完 → 空的 block + done，等對方回 done。
    pub async fn upload_step(&mut self) -> Out {
        let Some(pos) = self.uploads.iter().position(|(_, u)| u.state == UpState::Sending) else { return Out::default() };
        let (id, up) = &mut self.uploads[pos];
        let id = *id;
        let Some(f) = up.file.as_mut() else { return Out::default() };
        let mut buf = vec![0u8; BLOCK];
        let mut n = 0;
        while n < BLOCK {
            match f.read(&mut buf[n..]).await {
                Ok(0) => break,
                Ok(k) => n += k,
                Err(e) => {
                    let req = up.req;
                    self.uploads.remove(pos);
                    return Out {
                        send: vec![response(|r| {
                            r.set_error(crate::proto::message::FileTransferError { id, error: e.to_string(), file_num: 0, ..Default::default() })
                        })],
                        events: vec![err_event(req, e)],
                    };
                }
            }
        }
        buf.truncate(n);
        let block = response(|r| r.set_block(FileTransferBlock { id, file_num: 0, data: buf.into(), compressed: false, ..Default::default() }));
        if n > 0 {
            up.done += n as u64;
            let mut out = Out::send(block);
            if up.last.elapsed() >= PROGRESS_EVERY {
                up.last = Instant::now();
                out.events.push(progress(up.req, up.done, up.total));
            }
            return out;
        }
        // 讀完：空的 block 代表這個檔案結束（官方 `read` 也是這樣），再告訴對方整個工作完成。
        up.file.take();
        up.state = UpState::WaitDone;
        Out {
            send: vec![block, response(|r| r.set_done(FileTransferDone { id, file_num: 1, ..Default::default() }))],
            events: vec![progress(up.req, up.done, up.total)],
        }
    }

    /// 連線結束：還沒寫完的下載刪掉 `.part`。
    pub async fn close(&mut self) {
        for (_, mut d) in self.downloads.drain() {
            d.file.take();
            let _ = tokio::fs::remove_file(&d.part).await;
        }
    }
}

fn progress(req: u64, done: u64, total: u64) -> Value {
    json!({ "type": "fs_progress", "req": req, "done": done, "total": total })
}

impl Download {
    /// 寫一塊；回傳要回報的進度（節流過）。
    async fn write(&mut self, b: &FileTransferBlock) -> std::io::Result<Option<Value>> {
        if b.file_num != 0 {
            return Err(std::io::Error::other("unexpected file number"));
        }
        if self.file.is_none() {
            if let Some(dir) = self.target.parent().filter(|d| !d.as_os_str().is_empty()) {
                tokio::fs::create_dir_all(dir).await?;
            }
            self.file = Some(tokio::fs::File::create(&self.part).await?);
        }
        let data = if b.compressed {
            decompress(&b.data).ok_or_else(|| std::io::Error::other("bad compressed block"))?
        } else {
            b.data.to_vec()
        };
        if let Some(f) = self.file.as_mut() {
            f.write_all(&data).await?;
        }
        self.done += data.len() as u64;
        if self.last.elapsed() >= PROGRESS_EVERY {
            self.last = Instant::now();
            return Ok(Some(progress(self.req, self.done, self.total.max(self.done))));
        }
        Ok(None)
    }

    /// 對方說完成了：關檔、`.part` 改成正式檔名、照對方的修改時間。
    async fn finish(mut self) -> std::io::Result<Value> {
        if self.file.is_none() {
            // 空檔案可能一塊都沒有。
            if let Some(dir) = self.target.parent().filter(|d| !d.as_os_str().is_empty()) {
                tokio::fs::create_dir_all(dir).await?;
            }
            self.file = Some(tokio::fs::File::create(&self.part).await?);
        }
        if let Some(mut f) = self.file.take() {
            f.flush().await?;
            f.sync_all().await.ok();
        }
        tokio::fs::rename(&self.part, &self.target).await?;
        if self.mtime > 0 {
            if let Ok(f) = std::fs::File::options().write(true).open(&self.target) {
                let _ = f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(self.mtime));
            }
        }
        Ok(json!({
            "type": "fs_done",
            "req": self.req,
            "path": self.target.to_string_lossy(),
            "bytes": self.done,
        }))
    }
}

impl Upload {
    /// 對方說從第 `offset_blk` 塊開始（新檔案 = 0）。
    async fn open(&mut self, offset_blk: u32) -> std::io::Result<()> {
        let mut f = tokio::fs::File::open(&self.local).await?;
        let offset = offset_blk as u64 * BLOCK as u64;
        if offset > 0 {
            f.seek(std::io::SeekFrom::Start(offset)).await?;
        }
        self.done = offset.min(self.total);
        self.file = Some(f);
        self.state = UpState::Sending;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_msg(id: i32, path: &str, entries: Vec<FileEntry>) -> FileResponse {
        let mut r = FileResponse::new();
        r.set_dir(FileDirectory { id, path: path.into(), entries, ..Default::default() });
        r
    }

    fn sent_action(m: &Message) -> FileAction {
        match &m.union {
            Some(crate::proto::message::message::Union::FileAction(a)) => a.clone(),
            x => panic!("{x:?}"),
        }
    }

    fn sent_response(m: &Message) -> FileResponse {
        match &m.union {
            Some(crate::proto::message::message::Union::FileResponse(r)) => r.clone(),
            x => panic!("{x:?}"),
        }
    }

    #[tokio::test]
    async fn listing_matches_requests_in_order() {
        let mut f = Files::new();
        let o = f.command(FsCommand::FsLs { req: 7, path: "".into(), hidden: false }).await;
        assert!(matches!(sent_action(&o.send[0]).union, Some(file_action::Union::ReadDir(ref r)) if r.path.is_empty()));
        f.command(FsCommand::FsLs { req: 8, path: "/nope".into(), hidden: false }).await;
        let entry = FileEntry { name: "a.txt".into(), entry_type: FileType::File.into(), size: 3, modified_time: 9, ..Default::default() };
        let o = f.on_response(dir_msg(0, "/root", vec![entry])).await;
        assert_eq!(o.events[0]["req"], 7);
        assert_eq!(o.events[0]["path"], "/root");
        assert_eq!(o.events[0]["entries"][0], json!({ "name": "a.txt", "kind": "file", "size": 3, "mtime": 9, "hidden": false }));
        let mut e = FileResponse::new();
        e.set_error(crate::proto::message::FileTransferError { id: 0, error: "Not exists".into(), file_num: -1, ..Default::default() });
        let o = f.on_response(e).await;
        assert_eq!((o.events[0]["type"].as_str(), o.events[0]["req"].as_u64()), (Some("fs_err"), Some(8)));
    }

    /// 對方登入後主動送的家目錄（沒人要）不會錯配到後面的請求。
    #[tokio::test]
    async fn unsolicited_home_listing_is_not_misrouted() {
        let mut f = Files::new();
        f.command(FsCommand::FsLs { req: 1, path: "".into(), hidden: false }).await;
        f.command(FsCommand::FsLs { req: 2, path: "/tmp".into(), hidden: false }).await;
        // 主動送的家目錄 → 給要家目錄的 req 1
        let o = f.on_response(dir_msg(0, "/root", vec![])).await;
        assert_eq!(o.events[0]["req"], 1);
        // req 1 自己的回覆（又一份家目錄）→ 沒人要了，略過
        let o = f.on_response(dir_msg(0, "/root", vec![])).await;
        assert!(o.events.is_empty());
        // /tmp → req 2
        let o = f.on_response(dir_msg(0, "/tmp", vec![])).await;
        assert_eq!(o.events[0]["req"], 2);
    }

    #[tokio::test]
    async fn simple_ops_reply_by_job_id() {
        let mut f = Files::new();
        let o = f.command(FsCommand::FsMkdir { req: 1, path: "/tmp/x".into() }).await;
        let Some(file_action::Union::Create(c)) = sent_action(&o.send[0]).union else { panic!() };
        let o2 = f.command(FsCommand::FsRename { req: 2, path: "/tmp/a".into(), new_name: "b".into() }).await;
        let Some(file_action::Union::Rename(r)) = sent_action(&o2.send[0]).union else { panic!() };
        assert_ne!(c.id, r.id);
        let mut done = FileResponse::new();
        done.set_done(FileTransferDone { id: r.id, ..Default::default() });
        let o = f.on_response(done).await;
        assert_eq!((o.events[0]["type"].as_str(), o.events[0]["req"].as_u64()), (Some("fs_done"), Some(2)));
        let mut err = FileResponse::new();
        err.set_error(crate::proto::message::FileTransferError { id: c.id, error: "Permission denied".into(), ..Default::default() });
        let o = f.on_response(err).await;
        assert_eq!(o.events[0]["error"], "Permission denied");
    }

    #[tokio::test]
    async fn download_writes_part_then_renames() {
        let dir = std::env::temp_dir().join(format!("dbk-rd-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let target = dir.join("sub").join("out.bin");
        let mut f = Files::new();
        let o = f.command(FsCommand::FsDownload { req: 5, remote: "/r/out.bin".into(), local: target.to_string_lossy().into() }).await;
        let Some(file_action::Union::Send(s)) = sent_action(&o.send[0]).union else { panic!() };
        let id = s.id;
        let entry = FileEntry { name: "".into(), entry_type: FileType::File.into(), size: 6, modified_time: 1_600_000_000, ..Default::default() };
        f.on_response(dir_msg(id, "/r/out.bin", vec![entry])).await;
        let mut dg = FileResponse::new();
        dg.set_digest(FileTransferDigest { id, file_num: 0, file_size: 6, ..Default::default() });
        let o = f.on_response(dg).await;
        let Some(file_action::Union::SendConfirm(c)) = sent_action(&o.send[0]).union else { panic!() };
        assert_eq!(c.offset_blk(), 0, "一律從頭");
        for chunk in [&b"abc"[..], &b"def"[..], &b""[..]] {
            let mut b = FileResponse::new();
            b.set_block(FileTransferBlock { id, file_num: 0, data: chunk.to_vec().into(), ..Default::default() });
            f.on_response(b).await;
        }
        assert!(part_path(&target).exists() && !target.exists(), "完成前寫在 .part");
        let mut done = FileResponse::new();
        done.set_done(FileTransferDone { id, file_num: 1, ..Default::default() });
        let o = f.on_response(done).await;
        assert_eq!(o.events[0]["type"], "fs_done");
        assert_eq!(std::fs::read(&target).unwrap(), b"abcdef");
        assert!(!part_path(&target).exists());
        let mt = std::fs::metadata(&target).unwrap().modified().unwrap();
        assert_eq!(mt.duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs(), 1_600_000_000, "照對方的修改時間");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn download_error_removes_part() {
        let dir = std::env::temp_dir().join(format!("dbk-rd-dle-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("x.bin");
        let mut f = Files::new();
        let o = f.command(FsCommand::FsDownload { req: 1, remote: "/x".into(), local: target.to_string_lossy().into() }).await;
        let Some(file_action::Union::Send(s)) = sent_action(&o.send[0]).union else { panic!() };
        let mut b = FileResponse::new();
        b.set_block(FileTransferBlock { id: s.id, file_num: 0, data: b"zz".to_vec().into(), ..Default::default() });
        f.on_response(b).await;
        assert!(part_path(&target).exists());
        let mut e = FileResponse::new();
        e.set_error(crate::proto::message::FileTransferError { id: s.id, error: "boom".into(), ..Default::default() });
        let o = f.on_response(e).await;
        assert_eq!(o.events[0]["error"], "boom");
        assert!(!part_path(&target).exists(), "失敗刪掉 .part");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn upload_sends_blocks_after_confirm() {
        let dir = std::env::temp_dir().join(format!("dbk-rd-up-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let src = dir.join("in.bin");
        let data: Vec<u8> = (0..(BLOCK + 10)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &data).unwrap();
        let mut f = Files::new();
        let o = f.command(FsCommand::FsUpload { req: 3, local: src.to_string_lossy().into(), remote: "/r/in.bin".into() }).await;
        let Some(file_action::Union::Receive(r)) = sent_action(&o.send[0]).union else { panic!() };
        assert_eq!((r.path.as_str(), r.files.len(), r.total_size), ("/r/in.bin", 1, data.len() as u64));
        assert!(r.files[0].name.is_empty(), "單一檔案：名字空的");
        assert!(matches!(sent_response(&o.send[1]).union, Some(file_response::Union::Digest(_))));
        assert!(!f.has_upload_work(), "等對方確認");
        // 對方：沒有這個檔，從頭
        let mut a = FileAction::new();
        a.set_send_confirm(FileTransferSendConfirmRequest {
            id: r.id,
            union: Some(file_transfer_send_confirm_request::Union::OffsetBlk(0)),
            ..Default::default()
        });
        f.on_action(a).await;
        let mut got = Vec::new();
        let mut done_sent = false;
        while f.has_upload_work() {
            for m in f.upload_step().await.send {
                match sent_response(&m).union {
                    Some(file_response::Union::Block(b)) => got.extend_from_slice(&b.data),
                    Some(file_response::Union::Done(_)) => done_sent = true,
                    x => panic!("{x:?}"),
                }
            }
        }
        assert_eq!(got, data);
        assert!(done_sent);
        let mut d = FileResponse::new();
        d.set_done(FileTransferDone { id: r.id, ..Default::default() });
        let o = f.on_response(d).await;
        assert_eq!((o.events[0]["type"].as_str(), o.events[0]["req"].as_u64()), (Some("fs_done"), Some(3)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn upload_overwrites_when_peer_asks() {
        let dir = std::env::temp_dir().join(format!("dbk-rd-up2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let src = dir.join("in.txt");
        std::fs::write(&src, b"hi").unwrap();
        let mut f = Files::new();
        let o = f.command(FsCommand::FsUpload { req: 1, local: src.to_string_lossy().into(), remote: "/r/in.txt".into() }).await;
        let Some(file_action::Union::Receive(r)) = sent_action(&o.send[0]).union else { panic!() };
        // 對方已有不一樣的同名檔：回 digest 要我們決定 → 覆蓋
        let mut dg = FileResponse::new();
        dg.set_digest(FileTransferDigest { id: r.id, file_num: 0, is_upload: true, ..Default::default() });
        let o = f.on_response(dg).await;
        let Some(file_action::Union::SendConfirm(c)) = sent_action(&o.send[0]).union else { panic!() };
        assert_eq!(c.offset_blk(), 0);
        assert!(f.has_upload_work());
        // 對方已有一模一樣的：略過、直接完成
        let o = f.command(FsCommand::FsUpload { req: 2, local: src.to_string_lossy().into(), remote: "/r/same.txt".into() }).await;
        let Some(file_action::Union::Receive(r2)) = sent_action(&o.send[0]).union else { panic!() };
        let mut a = FileAction::new();
        a.set_send_confirm(FileTransferSendConfirmRequest {
            id: r2.id,
            union: Some(file_transfer_send_confirm_request::Union::Skip(true)),
            ..Default::default()
        });
        let o = f.on_action(a).await;
        assert!(matches!(sent_response(&o.send[0]).union, Some(file_response::Union::Done(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
