//! `RdRuntime`：活著的遠端桌面連線與待答提示的登記簿（`AppState.rd`）。
//!
//! 每條連線是一個背景任務（協定迴圈），外界只透過 `RdCtl` 跟它說話（輸入、ack、resize、關閉），
//! 任務結束時經 `watch` 留下原因。鎖都是 `parking_lot::Mutex`，**絕不跨 `.await`**。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use super::sessions::RdProtocol;
use crate::error::{AppError, AppResult};

/// 同時存活的遠端桌面連線上限。
pub const MAX_CONNS: usize = 16;

/// 主動斷線後等任務自己收尾的時間；超過就 abort（伺服器不回應 graceful shutdown 時不能卡住）。
#[cfg(not(test))]
const CLOSE_GRACE: Duration = Duration::from_secs(3);
#[cfg(test)]
const CLOSE_GRACE: Duration = Duration::from_millis(200);

/// 回給前端的連線資訊（`rd_connect` 的回傳）。
#[derive(Debug, Clone, Serialize)]
pub struct RdConnInfo {
    pub conn_id: String,
    pub protocol: RdProtocol,
    pub width: u16,
    pub height: u16,
    /// 實際採用的安全層（`nla` / `tls` / `vnc-auth` / `ard` …），前端顯示「未加密」徽章用。
    pub security: String,
    pub encrypted: bool,
}

/// 送給連線任務的控制訊息。
#[derive(Debug)]
pub enum RdCtl {
    /// VNC：noVNC 送出的原始 RFB 位元組（已過假握手，照順序轉給伺服器）。
    Write(Vec<u8>),
    /// RDP：前端的輸入紀錄（每筆 8 bytes，格式見 `rdp::input`）。
    Input(Vec<u8>),
    /// RDP：前端畫完第 `seq` 張，可以送下一張。
    Ack(u32),
    /// RDP：請遠端改解析度（動態解析度 / 進出全螢幕）。
    Resize { width: u16, height: u16, scale: u32 },
    /// RDP：整張重送（分頁從隱藏切回來、前端 canvas 重建）。
    Refresh,
    /// 送組合鍵（`ctrl_alt_del` / `win` / …；VNC 由 noVNC 自己送，這裡只給 RDP）。
    Keys(String),
    /// 把本機剪貼簿文字交給遠端（RDP 經 CLIPRDR；VNC 由 noVNC 自己送）。
    Clipboard(String),
    /// 主動斷線。
    Close,
}

/// 連線從哪來（刪除已存主機時要一併斷掉它開著的連線）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RdOrigin {
    Session(String),
    AdHoc,
}

pub struct RdConn {
    pub id: String,
    pub origin: RdOrigin,
    /// 連線資訊（協定：輸入作業系統密碼只給 RustDesk 連線）。
    pub info: RdConnInfo,
    pub ctl: mpsc::UnboundedSender<RdCtl>,
    /// 任務結束時變成 `Some(原因)`；sender 消失也代表已關。
    pub closed: watch::Receiver<Option<String>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl RdConn {
    pub fn new(
        id: String,
        origin: RdOrigin,
        info: RdConnInfo,
        ctl: mpsc::UnboundedSender<RdCtl>,
        closed: watch::Receiver<Option<String>>,
        task: JoinHandle<()>,
    ) -> Self {
        Self { id, origin, info, ctl, closed, task: Mutex::new(Some(task)) }
    }

    /// 把控制訊息丟給任務；任務已結束（channel 關了）→ 錯誤。
    pub fn send(&self, msg: RdCtl) -> AppResult<()> {
        self.ctl
            .send(msg)
            .map_err(|_| AppError::Rd(t!("遠端桌面連線已關閉").into()))
    }
}

/// 對話框的答案。
#[derive(Debug)]
pub enum PromptAnswer {
    Cert(CertDecision),
    /// `None` = 使用者取消。
    Auth(Option<AuthAnswer>),
}

/// RDP 伺服器憑證對話框的答案（同 SSH host key 的三種）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CertDecision {
    AcceptSave,
    AcceptOnce,
    Reject,
}

/// 帳號 / 密碼對話框的答案。
#[derive(Debug, Clone, Deserialize)]
pub struct AuthAnswer {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// 記住密碼（寫 keychain；只有已存主機才有意義）。
    #[serde(default)]
    pub remember: bool,
}

struct PendingPrompt {
    conn_id: String,
    tx: oneshot::Sender<PromptAnswer>,
}

#[derive(Default)]
pub struct RdRuntime {
    conns: Mutex<HashMap<String, Arc<RdConn>>>,
    prompts: Mutex<HashMap<String, PendingPrompt>>,
    /// RustDesk 傳檔連線（檔案面板經 `ssh_sftp_open` 拿它開）。
    files: Mutex<HashMap<String, Arc<super::rustdesk_files::RdFileClient>>>,
    /// RustDesk 畫面連線登入成功時用的密碼（只在記憶體）：開傳檔連線時不必再問一次。連線結束就丟掉。
    passwords: Mutex<HashMap<String, String>>,
}

impl RdRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    // ---- RustDesk 傳檔 ----

    pub fn insert_files(&self, id: String, c: Arc<super::rustdesk_files::RdFileClient>) {
        self.files.lock().insert(id, c);
    }

    pub fn files(&self, id: &str) -> Option<Arc<super::rustdesk_files::RdFileClient>> {
        self.files.lock().get(id).cloned()
    }

    pub fn remove_files(&self, id: &str) -> Option<Arc<super::rustdesk_files::RdFileClient>> {
        self.files.lock().remove(id)
    }

    pub fn cache_password(&self, conn_id: &str, password: String) {
        self.passwords.lock().insert(conn_id.to_string(), password);
    }

    pub fn cached_password(&self, conn_id: &str) -> Option<String> {
        self.passwords.lock().get(conn_id).cloned()
    }

    // ---- 連線 ----

    /// 目前的連線數是否已達上限（`rd_connect` 撥號前先擋，免得連上了才被拒）。
    pub fn at_capacity(&self, id: &str) -> bool {
        let g = self.conns.lock();
        g.len() >= MAX_CONNS && !g.contains_key(id)
    }

    /// 登記連線並起 watcher：任務結束時（不論原因）呼叫 `on_closed(原因)`。
    pub fn insert_conn(
        &self,
        conn: Arc<RdConn>,
        on_closed: Box<dyn FnOnce(Option<String>) + Send + 'static>,
    ) -> AppResult<()> {
        {
            let mut g = self.conns.lock();
            if g.len() >= MAX_CONNS && !g.contains_key(&conn.id) {
                return Err(AppError::Rd(tf!("同時開啟的遠端桌面連線已達上限（{n}）", n = MAX_CONNS)));
            }
            g.insert(conn.id.clone(), conn.clone());
        }
        let mut closed = conn.closed.clone();
        tokio::spawn(async move {
            let reason = loop {
                if let Some(r) = closed.borrow_and_update().clone() {
                    break Some(r);
                }
                if closed.changed().await.is_err() {
                    break None;
                }
            };
            on_closed(reason);
        });
        Ok(())
    }

    pub fn conn(&self, id: &str) -> AppResult<Arc<RdConn>> {
        self.conns
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Rd(t!("遠端桌面連線不存在或已關閉").into()))
    }

    pub fn conn_ids_for(&self, origin: &RdOrigin) -> Vec<String> {
        self.conns
            .lock()
            .values()
            .filter(|c| &c.origin == origin)
            .map(|c| c.id.clone())
            .collect()
    }

    /// watcher 通知連線結束：從登記簿拿掉（只拿同一條，重連沿用 id 時舊的遲來通知不能踢掉新的）。
    pub fn forget_conn(&self, conn: &Arc<RdConn>) {
        let mut g = self.conns.lock();
        if g.get(&conn.id).is_some_and(|c| Arc::ptr_eq(c, conn)) {
            g.remove(&conn.id);
            self.passwords.lock().remove(&conn.id);
        }
    }

    /// 主動斷線：丟掉待答提示、請任務收尾，逾時就 abort。已不存在則 no-op。
    pub async fn disconnect(&self, id: &str) {
        self.cancel_prompts_for(id);
        let conn = self.conns.lock().remove(id);
        self.passwords.lock().remove(id);
        let Some(conn) = conn else { return };
        let _ = conn.ctl.send(RdCtl::Close);
        let task = conn.task.lock().take();
        if let Some(mut task) = task {
            if tokio::time::timeout(CLOSE_GRACE, &mut task).await.is_err() {
                task.abort();
            }
        }
    }

    pub async fn shutdown_all(&self) {
        let ids: Vec<String> = self.conns.lock().keys().cloned().collect();
        for id in ids {
            self.disconnect(&id).await;
        }
    }

    // ---- 待答提示 ----

    pub fn register_prompt(&self, conn_id: &str, tx: oneshot::Sender<PromptAnswer>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.prompts
            .lock()
            .insert(id.clone(), PendingPrompt { conn_id: conn_id.to_string(), tx });
        id
    }

    pub fn answer_prompt(&self, prompt_id: &str, answer: PromptAnswer) -> AppResult<()> {
        let p = self
            .prompts
            .lock()
            .remove(prompt_id)
            .ok_or_else(|| AppError::Rd(t!("找不到待回答的遠端桌面提示（可能已逾時）").into()))?;
        let _ = p.tx.send(answer);
        Ok(())
    }

    pub fn drop_prompt(&self, prompt_id: &str) {
        self.prompts.lock().remove(prompt_id);
    }

    /// 斷線時丟掉該連線的待答提示：等待端收到 `RecvError` → 視為使用者取消。
    pub fn cancel_prompts_for(&self, conn_id: &str) {
        self.prompts.lock().retain(|_, p| p.conn_id != conn_id);
    }

    #[cfg(test)]
    pub fn pending_prompts(&self) -> usize {
        self.prompts.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str) -> RdConnInfo {
        RdConnInfo {
            conn_id: id.into(),
            protocol: RdProtocol::Vnc,
            width: 800,
            height: 600,
            security: "vnc-auth".into(),
            encrypted: false,
        }
    }

    /// 起一條假連線：任務收到 Close 就結束並留下原因。
    fn fake_conn(id: &str, origin: RdOrigin) -> Arc<RdConn> {
        let (tx, mut rx) = mpsc::unbounded_channel::<RdCtl>();
        let (ctx, crx) = watch::channel(None);
        let task = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if matches!(m, RdCtl::Close) {
                    break;
                }
            }
            let _ = ctx.send(Some("bye".into()));
        });
        Arc::new(RdConn::new(id.into(), origin, info(id), tx, crx, task))
    }

    #[tokio::test]
    async fn insert_disconnect_emits_closed_once() {
        let rt = Arc::new(RdRuntime::new());
        let c = fake_conn("c1", RdOrigin::Session("s1".into()));
        let (tx, rx) = oneshot::channel();
        let rt2 = rt.clone();
        let c2 = c.clone();
        rt.insert_conn(
            c.clone(),
            Box::new(move |r| {
                rt2.forget_conn(&c2);
                let _ = tx.send(r);
            }),
        )
        .unwrap();
        assert!(rt.conn("c1").is_ok());
        assert_eq!(rt.conn_ids_for(&RdOrigin::Session("s1".into())), vec!["c1"]);
        assert!(rt.conn_ids_for(&RdOrigin::AdHoc).is_empty());
        rt.disconnect("c1").await;
        assert_eq!(rx.await.unwrap().as_deref(), Some("bye"));
        assert!(rt.conn("c1").is_err());
        assert!(c.send(RdCtl::Refresh).is_err(), "任務結束後送控制訊息 → 錯誤");
        rt.disconnect("c1").await; // no-op
    }

    #[tokio::test]
    async fn stuck_task_is_aborted() {
        let rt = RdRuntime::new();
        let (tx, _rx) = mpsc::unbounded_channel::<RdCtl>();
        let (_ctx, crx) = watch::channel(None);
        let task = tokio::spawn(async { std::future::pending::<()>().await });
        let c = Arc::new(RdConn::new("s".into(), RdOrigin::AdHoc, info("s"), tx, crx, task));
        rt.insert_conn(c, Box::new(|_| {})).unwrap();
        rt.disconnect("s").await; // 不能卡住（CLOSE_GRACE 後 abort；測試版 200 ms）
        assert!(rt.conn("s").is_err());
    }

    #[tokio::test]
    async fn prompt_broker_roundtrip_and_cancel() {
        let rt = RdRuntime::new();
        let (tx, rx) = oneshot::channel();
        let id = rt.register_prompt("c1", tx);
        rt.answer_prompt(&id, PromptAnswer::Cert(CertDecision::AcceptOnce)).unwrap();
        assert!(matches!(rx.await, Ok(PromptAnswer::Cert(CertDecision::AcceptOnce))));
        assert!(rt.answer_prompt(&id, PromptAnswer::Auth(None)).is_err(), "重複回答");
        let (tx, rx) = oneshot::channel();
        let _ = rt.register_prompt("c2", tx);
        rt.cancel_prompts_for("other");
        assert_eq!(rt.pending_prompts(), 1);
        rt.cancel_prompts_for("c2");
        assert_eq!(rt.pending_prompts(), 0);
        assert!(rx.await.is_err());
    }

    #[test]
    fn capacity_check() {
        let rt = RdRuntime::new();
        assert!(!rt.at_capacity("x"));
    }
}
