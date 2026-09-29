//! `SshRuntime`：活著的 SSH 連線 / 終端 / SFTP / 待答提示 / 傳輸旗標的登記簿（`AppState.ssh`）。
//!
//! 連線語意同 Xshell：每個 `ssh_connect` 一條 `Handle`（新分頁 = 新連線）；同分頁的 SFTP 與額外
//! channel 從同一條 `Arc<Handle>` 開，不再問密碼 / OTP。
//!
//! FTP 主機另外登記在 `ftp_conns`（`FtpConn`：重新撥號需要的資料；控制連線由各工作階段自己開）。
//! 它的檔案面板工作階段與 SFTP 放在同一張 `sftps` 表（`FileClient`），前端不必分。
//!
//! 鎖都是 `parking_lot::Mutex`，**絕不跨 `.await`**：拿到 `Arc` 就放鎖，IO 在鎖外做。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

use super::auth::{self, HostKeyDecision, TargetOrigin};
use super::sessions::SshTermOptions;
use super::files::FileClient;
use super::ftp::FtpConn;
use super::terminal::TermHandle;
use crate::error::{AppError, AppResult};

/// 同時存活的連線上限（每個終端分頁一條）。
pub const MAX_CONNS: usize = 32;
/// 同時存活的終端上限。
pub const MAX_TERMS: usize = 64;

/// 回給前端的連線資訊。
#[derive(Debug, Clone, Serialize)]
pub struct SshConnInfo {
    pub conn_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

/// 一條已認證的連線。
pub struct SshConn {
    pub id: String,
    /// `user@host`，log 用。
    pub label: String,
    pub info: SshConnInfo,
    pub origin: TargetOrigin,
    /// 終端選項（TERM / env / 啟動指令）：`ssh_term_open` 沒有選項參數，從這裡取。
    pub term_opts: SshTermOptions,
    pub handle: Arc<russh::client::Handle<auth::DbkHandler>>,
    /// 開著的 channel 數（終端 + SFTP）。最後一個關掉時自動 disconnect。
    pub channels: AtomicUsize,
    /// 連線結束時變成 `Some(原因)`；sender 消失（session 任務結束）也代表已關。
    pub closed: watch::Receiver<Option<String>>,
    /// 經跳板機連上時的跳板機連線（一路到最外層）：目標連線的 TCP 就是它上面的通道，必須一起活著、一起關。
    pub jump: Option<Box<auth::Connected>>,
}

impl SshConn {
    /// 把剛認證完的連線包成登記簿用的型別。
    pub fn new(id: String, t: &auth::SshTarget, c: auth::Connected) -> Self {
        Self {
            id: id.clone(),
            label: t.label(),
            info: SshConnInfo {
                conn_id: id,
                host: t.host.clone(),
                port: t.port,
                username: t.username.clone(),
            },
            origin: t.origin.clone(),
            term_opts: t.term.clone(),
            handle: Arc::new(c.handle),
            channels: AtomicUsize::new(0),
            closed: c.closed,
            jump: c.jump,
        }
    }

    /// 開了一條 channel（終端 / SFTP）。
    pub fn channel_opened(&self) {
        self.channels.fetch_add(1, Ordering::Relaxed);
    }

    /// 關了一條 channel；回傳是否已經一條都不剩（呼叫端據此自動 disconnect）。
    pub fn channel_closed(&self) -> bool {
        let prev = self.channels.fetch_sub(1, Ordering::Relaxed);
        prev <= 1
    }
}

/// 對話框的答案。
#[derive(Debug)]
pub enum PromptAnswer {
    HostKey(HostKeyDecision),
    /// `None` = 使用者取消。
    Auth(Option<Vec<String>>),
}

struct PendingPrompt {
    conn_id: String,
    tx: oneshot::Sender<PromptAnswer>,
}

struct Transfer {
    conn_id: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct SshRuntime {
    conns: Mutex<HashMap<String, Arc<SshConn>>>,
    terms: Mutex<HashMap<String, Arc<TermHandle>>>,
    /// 已登入的 FTP 主機（conn_id 與 `conns` 同一個命名空間，前端產的 uuid）。
    ftp_conns: Mutex<HashMap<String, Arc<FtpConn>>>,
    sftps: Mutex<HashMap<String, Arc<FileClient>>>,
    /// sftp_id → 開它的 SFTP 獨立視窗標籤（主視窗開的不記）。視窗關掉時收掉它開的通道。
    sftp_owners: Mutex<HashMap<String, String>>,
    prompts: Mutex<HashMap<String, PendingPrompt>>,
    transfers: Mutex<HashMap<String, Transfer>>,
}

impl SshRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    // ---- 連線 ----

    /// 登記連線並起一個 watcher：連線結束時（不論誰關的、怎麼關的）呼叫 `on_closed(原因)`。
    /// 呼叫端的 `on_closed` 應 `forget_conn` 並發 `ssh-conn-closed`。
    pub fn insert_conn(
        &self,
        conn: Arc<SshConn>,
        on_closed: Box<dyn FnOnce(Option<String>) + Send + 'static>,
    ) -> AppResult<JoinHandle<()>> {
        let id = conn.id.clone();
        {
            let mut g = self.conns.lock();
            if g.len() >= MAX_CONNS && !g.contains_key(&id) {
                return Err(AppError::Ssh(tf!("同時開啟的 SSH 連線已達上限（{n}）", n = MAX_CONNS)));
            }
            g.insert(id, conn.clone());
        }
        let mut closed = conn.closed.clone();
        Ok(tokio::spawn(async move {
            let reason = loop {
                if let Some(r) = closed.borrow_and_update().clone() {
                    break Some(r);
                }
                if closed.changed().await.is_err() {
                    // sender 隨 session 任務消失：連線已經沒了，只是沒留原因。
                    break None;
                }
            };
            on_closed(reason);
        }))
    }

    pub fn conn(&self, id: &str) -> AppResult<Arc<SshConn>> {
        self.conns
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Ssh(t!("SSH 連線不存在或已關閉").into()))
    }

    /// 某來源（已存主機 / DB 連線）目前開著的連線 id（SSH 與 FTP）。
    pub fn conn_ids_for(&self, origin: &TargetOrigin) -> Vec<String> {
        let mut ids: Vec<String> =
            self.conns.lock().values().filter(|c| &c.origin == origin).map(|c| c.id.clone()).collect();
        ids.extend(self.ftp_conns.lock().values().filter(|c| &c.origin == origin).map(|c| c.id.clone()));
        ids
    }

    /// 登記一台已登入的 FTP 主機（與 SSH 連線共用上限）。
    pub fn insert_ftp_conn(&self, conn: Arc<FtpConn>) -> AppResult<()> {
        let open = self.conns.lock().len();
        let mut g = self.ftp_conns.lock();
        if open + g.len() >= MAX_CONNS && !g.contains_key(&conn.id) {
            return Err(AppError::Ftp(tf!("同時開啟的連線已達上限（{n}）", n = MAX_CONNS)));
        }
        g.insert(conn.id.clone(), conn);
        Ok(())
    }

    pub fn ftp_conn(&self, id: &str) -> Option<Arc<FtpConn>> {
        self.ftp_conns.lock().get(id).cloned()
    }

    /// 連線結束了（watcher 通知）：從登記簿拿掉。只在登記的還是**同一條**時才拿——
    /// 前端重連可能沿用同一個 conn_id，舊連線遲來的關閉通知不能把新連線踢掉。
    /// 終端 / SFTP 會各自收到 Close 而結束，不在這裡動。
    pub fn forget_conn(&self, conn: &Arc<SshConn>) {
        let mut g = self.conns.lock();
        if g.get(&conn.id).is_some_and(|c| Arc::ptr_eq(c, conn)) {
            g.remove(&conn.id);
        }
    }

    /// 主動斷線：取消待答提示、關掉終端 / SFTP / 傳輸，再送 disconnect。已不存在則 no-op。
    /// watcher 不 abort：連線真的結束時它會照常發 `ssh-conn-closed`，前端只認這一個事件。
    pub async fn disconnect(&self, id: &str) {
        self.cancel_prompts_for(id);
        let conn = self.conns.lock().remove(id);
        // FTP：沒有可以送 disconnect 的連線，關掉工作階段（各自的控制連線）就是斷線。
        self.ftp_conns.lock().remove(id);
        for t in self.take_transfers_for(id) {
            t.store(true, Ordering::Relaxed);
        }
        for term in self.take_terms_for(id) {
            term.close().await;
        }
        for sftp in self.take_sftps_for(id) {
            sftp.close().await;
        }
        if let Some(conn) = conn {
            let _ = conn
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
            // 目標關了再關跳板機（由內而外）。
            let mut hop = conn.jump.as_deref();
            while let Some(j) = hop {
                let _ = j.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
                hop = j.jump.as_deref();
            }
        }
    }

    /// App 關閉：全部斷線。
    pub async fn shutdown_all(&self) {
        let mut ids: Vec<String> = self.conns.lock().keys().cloned().collect();
        ids.extend(self.ftp_conns.lock().keys().cloned());
        for id in ids {
            self.disconnect(&id).await;
        }
    }

    // ---- 終端 ----

    pub fn insert_term(&self, id: String, term: Arc<TermHandle>) -> AppResult<()> {
        let mut g = self.terms.lock();
        if g.len() >= MAX_TERMS {
            return Err(AppError::Ssh(tf!("同時開啟的終端機已達上限（{n}）", n = MAX_TERMS)));
        }
        g.insert(id, term);
        Ok(())
    }

    pub fn term(&self, id: &str) -> AppResult<Arc<TermHandle>> {
        self.terms
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Ssh(t!("終端機不存在或已關閉").into()))
    }

    pub fn remove_term(&self, id: &str) -> Option<Arc<TermHandle>> {
        self.terms.lock().remove(id)
    }

    fn take_terms_for(&self, conn_id: &str) -> Vec<Arc<TermHandle>> {
        let mut g = self.terms.lock();
        let ids: Vec<String> = g
            .iter()
            .filter(|(_, t)| t.conn_id == conn_id)
            .map(|(k, _)| k.clone())
            .collect();
        ids.into_iter().filter_map(|k| g.remove(&k)).collect()
    }

    // ---- SFTP ----

    pub fn insert_sftp(&self, id: String, sftp: Arc<FileClient>) {
        self.sftps.lock().insert(id, sftp);
    }

    pub fn sftp(&self, id: &str) -> AppResult<Arc<FileClient>> {
        self.sftps
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Sftp(t!("SFTP 工作階段不存在或已關閉").into()))
    }

    pub fn remove_sftp(&self, id: &str) -> Option<Arc<FileClient>> {
        self.sftp_owners.lock().remove(id);
        self.sftps.lock().remove(id)
    }

    /// 記下這條 SFTP 通道是哪個 SFTP 獨立視窗開的。
    pub fn set_sftp_owner(&self, sftp_id: &str, owner: &str) {
        self.sftp_owners.lock().insert(sftp_id.to_string(), owner.to_string());
    }

    /// 某個視窗開的 SFTP 通道（還開著的）。
    pub fn sftp_ids_owned_by(&self, owner: &str) -> Vec<String> {
        self.sftp_owners
            .lock()
            .iter()
            .filter(|(_, o)| o.as_str() == owner)
            .map(|(k, _)| k.clone())
            .collect()
    }

    fn take_sftps_for(&self, conn_id: &str) -> Vec<Arc<FileClient>> {
        let mut g = self.sftps.lock();
        let ids: Vec<String> = g
            .iter()
            .filter(|(_, s)| s.conn_id() == conn_id)
            .map(|(k, _)| k.clone())
            .collect();
        let taken = ids.iter().filter_map(|k| g.remove(k)).collect();
        drop(g);
        let mut owners = self.sftp_owners.lock();
        for k in &ids {
            owners.remove(k);
        }
        taken
    }

    // ---- 待答提示 ----

    /// 登記一個等待中的對話框，回 `prompt_id`。
    pub fn register_prompt(&self, conn_id: &str, tx: oneshot::Sender<PromptAnswer>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.prompts
            .lock()
            .insert(id.clone(), PendingPrompt { conn_id: conn_id.to_string(), tx });
        id
    }

    /// 前端回答了。找不到（逾時 / 已取消 / 重複回答）→ 錯誤。
    pub fn answer_prompt(&self, prompt_id: &str, answer: PromptAnswer) -> AppResult<()> {
        let p = self
            .prompts
            .lock()
            .remove(prompt_id)
            .ok_or_else(|| AppError::Ssh(t!("找不到待回答的 SSH 提示（可能已逾時）").into()))?;
        // 收端已經放棄（逾時）不算錯，前端只是晚了一步。
        let _ = p.tx.send(answer);
        Ok(())
    }

    /// 逾時 / 放棄等待時把登記撤掉。
    pub fn drop_prompt(&self, prompt_id: &str) {
        self.prompts.lock().remove(prompt_id);
    }

    /// 斷線時把該連線的待答提示全部丟掉：等待端收到 `RecvError` → 視為使用者取消。
    pub fn cancel_prompts_for(&self, conn_id: &str) {
        self.prompts.lock().retain(|_, p| p.conn_id != conn_id);
    }

    /// 目前有沒有待答提示（測試 / 除錯用）。
    pub fn pending_prompts(&self) -> usize {
        self.prompts.lock().len()
    }

    // ---- 傳輸 ----

    pub fn register_transfer(&self, conn_id: &str) -> (String, Arc<AtomicBool>) {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        self.transfers.lock().insert(
            id.clone(),
            Transfer { conn_id: conn_id.to_string(), cancel: cancel.clone() },
        );
        (id, cancel)
    }

    pub fn cancel_transfer(&self, id: &str) {
        if let Some(t) = self.transfers.lock().get(id) {
            t.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn finish_transfer(&self, id: &str) {
        self.transfers.lock().remove(id);
    }

    fn take_transfers_for(&self, conn_id: &str) -> Vec<Arc<AtomicBool>> {
        let mut g = self.transfers.lock();
        let ids: Vec<String> = g
            .iter()
            .filter(|(_, t)| t.conn_id == conn_id)
            .map(|(k, _)| k.clone())
            .collect();
        ids.into_iter().filter_map(|k| g.remove(&k)).map(|t| t.cancel).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prompt_broker_roundtrip_and_cancel() {
        let rt = SshRuntime::new();
        let (tx, rx) = oneshot::channel();
        let id = rt.register_prompt("c1", tx);
        assert_eq!(rt.pending_prompts(), 1);
        rt.answer_prompt(&id, PromptAnswer::HostKey(HostKeyDecision::AcceptOnce)).unwrap();
        assert!(matches!(rx.await, Ok(PromptAnswer::HostKey(HostKeyDecision::AcceptOnce))));
        assert!(rt.answer_prompt(&id, PromptAnswer::Auth(None)).is_err(), "重複回答");

        let (tx, rx) = oneshot::channel();
        let _ = rt.register_prompt("c2", tx);
        rt.cancel_prompts_for("other");
        assert_eq!(rt.pending_prompts(), 1, "別的連線不受影響");
        rt.cancel_prompts_for("c2");
        assert_eq!(rt.pending_prompts(), 0);
        assert!(rx.await.is_err(), "sender 被丟掉 → 等待端視為取消");
    }

    #[test]
    fn transfer_flags() {
        let rt = SshRuntime::new();
        let (id, flag) = rt.register_transfer("c1");
        assert!(!flag.load(Ordering::Relaxed));
        rt.cancel_transfer(&id);
        assert!(flag.load(Ordering::Relaxed));
        rt.finish_transfer(&id);
        rt.cancel_transfer(&id); // 已結束：no-op
        let (_, f2) = rt.register_transfer("c1");
        for f in rt.take_transfers_for("c1") {
            f.store(true, Ordering::Relaxed);
        }
        assert!(f2.load(Ordering::Relaxed), "斷線時整條連線的傳輸都取消");
    }

    #[test]
    fn sftp_owner_bookkeeping() {
        let rt = SshRuntime::new();
        rt.set_sftp_owner("s1", "sftp-a");
        rt.set_sftp_owner("s2", "sftp-a");
        rt.set_sftp_owner("s3", "sftp-b");
        let mut a = rt.sftp_ids_owned_by("sftp-a");
        a.sort();
        assert_eq!(a, vec!["s1", "s2"]);
        assert!(rt.sftp_ids_owned_by("main").is_empty());
        rt.remove_sftp("s1");
        assert_eq!(rt.sftp_ids_owned_by("sftp-a"), vec!["s2"], "關掉的通道不再算在視窗名下");
    }

    #[tokio::test]
    async fn disconnect_unknown_is_noop() {
        let rt = SshRuntime::new();
        rt.disconnect("nope").await;
        rt.shutdown_all().await;
        assert!(rt.conn("nope").is_err());
        assert!(rt.term("nope").is_err());
        assert!(matches!(rt.sftp("nope"), Err(AppError::Sftp(_))));
    }
}
