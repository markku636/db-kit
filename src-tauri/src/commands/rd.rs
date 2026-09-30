//! 遠端桌面（RDP / VNC）的 Tauri command（薄包裝）+ 提示轉接 `RdUi`。
//!
//! 整個遠端桌面功能唯一碰 Tauri 的地方；協定邏輯都在 `crate::rd`。
//!
//! 事件：`rd-cert-prompt`、`rd-auth-prompt`、`rd-conn-closed`。經 SSH 連線時，SSH 端的 host key / 密碼提示
//! 沿用 `ssh-hostkey-prompt` / `ssh-auth-prompt`（conn_id 同遠端桌面的 conn_id），前端同一個分頁接。
//!
//! 資料通道：
//! - 後端 → 前端：`rd_connect` 的 `on_output` Channel（`InvokeResponseBody::Raw`）。VNC 是原始 RFB 位元組
//!   （假握手之後的一切），RDP 是 `rd::rdp::frames` 的 record。
//! - 前端 → 後端：`rd_write`（VNC 位元組）/ `rd_input`（RDP 輸入紀錄）走 raw body + `x-rd-conn` header，
//!   不經 JSON / base64（滑鼠移動一秒上百次）。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, watch};

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::rd::runtime::{AuthAnswer, CertDecision, PromptAnswer, RdConn, RdConnInfo, RdCtl, RdOrigin, RdRuntime};
use crate::rd::sessions::{self, RdFolder, RdProtocol, RdSession, RdSessionsFile, VncSecurity};
use crate::rd::transport::{self, Dialed};
use crate::ssh::auth::{connect_and_auth, SshTargetRef};
use crate::ssh::known_hosts::{HostKeyStatus, KnownHostsStore};
use crate::store;

/// 對話框等待上限（同 SSH）。
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);
/// 認證失敗後重問的次數上限（RFB / NLA 失敗時伺服器會斷線，每次都得重撥）。
const MAX_AUTH_TRIES: usize = 3;

// ---- 事件 payload ----

#[derive(Clone, Serialize)]
struct CertPromptEvent {
    prompt_id: String,
    conn_id: String,
    host_id: String,
    fingerprint: String,
    subject: String,
    /// `"new"` | `"changed"`
    status: &'static str,
    old_fingerprint: Option<String>,
}

#[derive(Clone, Serialize)]
struct AuthPromptEvent {
    prompt_id: String,
    conn_id: String,
    need_username: bool,
    username: String,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct ConnClosed {
    conn_id: String,
    reason: Option<String>,
}

// ---- RdUi：提示 → 事件 + oneshot ----

#[derive(Clone)]
struct RdUi {
    app: AppHandle,
    rt: Arc<RdRuntime>,
    conn_id: String,
}

impl RdUi {
    async fn ask<F>(&self, emit: F) -> Option<PromptAnswer>
    where
        F: FnOnce(&str) -> tauri::Result<()>,
    {
        let (tx, rx) = oneshot::channel();
        let prompt_id = self.rt.register_prompt(&self.conn_id, tx);
        if emit(&prompt_id).is_err() {
            self.rt.drop_prompt(&prompt_id);
            return None;
        }
        match tokio::time::timeout(PROMPT_TIMEOUT, rx).await {
            Ok(Ok(a)) => Some(a),
            _ => {
                self.rt.drop_prompt(&prompt_id);
                None
            }
        }
    }

    /// 帳號 / 密碼對話框。`None` = 取消。
    async fn creds(&self, need_username: bool, username: &str, error: Option<String>) -> Option<AuthAnswer> {
        let a = self
            .ask(|prompt_id| {
                self.app.emit(
                    "rd-auth-prompt",
                    AuthPromptEvent {
                        prompt_id: prompt_id.to_string(),
                        conn_id: self.conn_id.clone(),
                        need_username,
                        username: username.to_string(),
                        error: error.clone(),
                    },
                )
            })
            .await;
        match a {
            Some(PromptAnswer::Auth(a)) => a,
            _ => None,
        }
    }
}

#[cfg(feature = "rdp")]
#[async_trait]
impl crate::rd::rdp::CertUi for RdUi {
    async fn ask(&self, q: crate::rd::rdp::cert::CertQuestion) -> CertDecision {
        let (status, old) = match &q.status {
            HostKeyStatus::Changed { old } => ("changed", Some(old.clone())),
            _ => ("new", None),
        };
        let a = RdUi::ask(self, |prompt_id| {
            self.app.emit(
                "rd-cert-prompt",
                CertPromptEvent {
                    prompt_id: prompt_id.to_string(),
                    conn_id: self.conn_id.clone(),
                    host_id: q.host_id.clone(),
                    fingerprint: q.fingerprint.clone(),
                    subject: q.subject.clone(),
                    status,
                    old_fingerprint: old.clone(),
                },
            )
        })
        .await;
        match a {
            Some(PromptAnswer::Cert(d)) => d,
            _ => CertDecision::Reject,
        }
    }
}

/// VNC 認證過程中才知道要不要帳號（ARD / VeNCrypt）：對話框在那時才問，答案記下來給「記住密碼」用。
#[cfg(feature = "vnc")]
struct VncAsk<'a> {
    ui: &'a RdUi,
    username: String,
    answered: parking_lot::Mutex<Option<AuthAnswer>>,
}

#[cfg(feature = "vnc")]
#[async_trait]
impl crate::rd::vnc::auth::VncCredSource for VncAsk<'_> {
    async fn creds(&self, need_username: bool, error: Option<String>) -> Option<crate::rd::vnc::auth::VncCreds> {
        let a = self.ui.creds(need_username, &self.username, error).await?;
        *self.answered.lock() = Some(a.clone());
        Some(crate::rd::vnc::auth::VncCreds { username: a.username, password: a.password })
    }
}

// ---- 目標解析 ----

/// 前端指定連線目標的方式。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RdTargetRef {
    Session { id: String },
    AdHoc {
        session: RdSession,
        #[serde(default)]
        password: Option<String>,
    },
}

struct Resolved {
    session: RdSession,
    password: Option<String>,
    origin: RdOrigin,
}

async fn resolve(app: &AppHandle, r: RdTargetRef) -> AppResult<Resolved> {
    match r {
        RdTargetRef::Session { id } => {
            let file = sessions::load_in(&store::app_config_dir(app)?).await?;
            let s = file
                .sessions
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| AppError::Rd(tf!("找不到遠端桌面主機：{id}", id = id)))?;
            let password = store::kc_get(&sessions::session_password_account(&id)).filter(|p| !p.is_empty());
            Ok(Resolved { session: s, password, origin: RdOrigin::Session(id) })
        }
        RdTargetRef::AdHoc { session, password } => {
            // 對話框「測試連線」：留空 = 用 keychain 裡存的（同 SSH）。
            let password = password
                .filter(|p| !p.is_empty())
                .or_else(|| store::kc_get(&sessions::session_password_account(&session.id)))
                .filter(|p| !p.is_empty());
            Ok(Resolved { session, password, origin: RdOrigin::AdHoc })
        }
    }
}

/// 撥號：直連或經 SSH（SSH 的提示走 `TauriUi`，conn_id 共用）。
async fn dial(app: &AppHandle, state: &AppState, conn_id: &str, s: &RdSession) -> AppResult<Dialed> {
    let port = s.effective_port();
    match s.via_ssh() {
        None => transport::dial_direct(&s.host, port, s.options.connect_timeout()).await,
        Some(ssh_id) => {
            // 已存主機清單裡也有 FTP 主機（`protocol = ftp`）：只有 SSH 能當轉接。
            let t = match super::ssh::resolve_target(app, SshTargetRef::Session { id: ssh_id.to_string() }).await? {
                super::ssh::Resolved::Ssh(t) => t,
                super::ssh::Resolved::Ftp(_) => {
                    return Err(AppError::Rd(t!("選的轉接主機是 FTP 主機；經主機轉接只能用 SSH 主機").into()))
                }
            };
            let ui = Arc::new(super::ssh::TauriUi::new(app.clone(), state.ssh.clone(), conn_id.to_string()));
            let c = connect_and_auth(&t, conn_id, ui, KnownHostsStore::default_path()).await?;
            transport::dial_via_ssh(c, &s.host, port).await
        }
    }
}

/// 使用者勾了「記住密碼」且是已存主機 → 寫 keychain。
fn remember(origin: &RdOrigin, a: &AuthAnswer) {
    if let (RdOrigin::Session(id), true) = (origin, a.remember) {
        if !a.password.is_empty() {
            let _ = store::kc_set(&sessions::session_password_account(id), &a.password);
        }
    }
}

// ---- 已存主機 ----

#[tauri::command]
pub async fn rd_sessions_list(app: AppHandle) -> AppResult<RdSessionsFile> {
    sessions::load_in(&store::app_config_dir(&app)?).await
}

/// 新增 / 更新主機。`password` 非空 → 寫 keychain；空 / null = 保留舊值。
#[tauri::command]
pub async fn rd_session_save(app: AppHandle, session: RdSession, password: Option<String>) -> AppResult<()> {
    if session.host.trim().is_empty() {
        return Err(AppError::Rd(t!("未填寫遠端主機").into()));
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        store::kc_set(&sessions::session_password_account(&session.id), &p)?;
    }
    sessions::upsert_in(&store::app_config_dir(&app)?, session).await
}

/// 刪除主機：先斷開它開著的連線，再刪檔 + keychain。
#[tauri::command]
pub async fn rd_session_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let rt = state.rd.clone();
    for cid in rt.conn_ids_for(&RdOrigin::Session(id.clone())) {
        rt.disconnect(&cid).await;
    }
    sessions::remove_in(&store::app_config_dir(&app)?, &id).await?;
    store::kc_delete(&sessions::session_password_account(&id));
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct RdPlacement {
    pub id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[tauri::command]
pub async fn rd_sessions_layout_save(app: AppHandle, folders: Vec<RdFolder>, order: Vec<RdPlacement>) -> AppResult<()> {
    let order: Vec<(String, Option<String>)> = order.into_iter().map(|p| (p.id, p.folder_id)).collect();
    sessions::save_layout_in(&store::app_config_dir(&app)?, folders, &order).await
}

#[tauri::command]
pub fn rd_has_stored_password(id: String) -> bool {
    store::kc_get(&sessions::session_password_account(&id)).is_some_and(|p| !p.is_empty())
}

/// 讀 `.rdp` 檔的原始位元組（mstsc 存成 UTF-16LE，解碼在前端 `rdpFile.ts`）。
#[tauri::command]
pub async fn rd_read_rdp_file(path: String) -> AppResult<Vec<u8>> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| AppError::Rd(tf!("無法讀取檔案：{e}", e = e)))?;
    // .rdp 檔只有幾 KB；擋掉誤選的大檔。
    if meta.len() > 1024 * 1024 {
        return Err(AppError::Rd(t!("檔案太大，不像是 .rdp 連線檔").into()));
    }
    tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Rd(tf!("無法讀取檔案：{e}", e = e)))
}

// ---- 連線 ----

type SinkFn = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// 一次成功的連線：資訊 + 控制通道 + 結束通知 + 工作階段任務。每次嘗試各自建通道，失敗的那幾次直接丟掉。
struct Started {
    info: RdConnInfo,
    ctl: mpsc::UnboundedSender<RdCtl>,
    closed: watch::Receiver<Option<String>>,
    task: tokio::task::JoinHandle<()>,
}

/// 建立連線並認證，成功後起工作階段任務。`conn_id` 由前端產生，這樣提示事件在回傳前就對得上。
/// `width` / `height` 是分頁可用的像素（RDP 用來決定初始解析度；VNC 不用），`scale` 是 devicePixelRatio × 100。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rd_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    target: RdTargetRef,
    width: u16,
    height: u16,
    scale: u32,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<RdConnInfo> {
    let rt = state.rd.clone();
    rt.disconnect(&conn_id).await;
    if rt.at_capacity(&conn_id) {
        return Err(AppError::Rd(tf!("同時開啟的遠端桌面連線已達上限（{n}）", n = crate::rd::runtime::MAX_CONNS)));
    }
    let r = resolve(&app, target).await?;
    let ui = RdUi { app: app.clone(), rt: rt.clone(), conn_id: conn_id.clone() };
    let sink: SinkFn = Arc::new(move |b| {
        let _ = on_output.send(InvokeResponseBody::Raw(b));
    });

    let started = match r.session.protocol {
        RdProtocol::Rdp => connect_rdp(&app, &state, &ui, &r, &conn_id, width, height, scale, sink).await?,
        RdProtocol::Vnc => connect_vnc(&app, &state, &ui, &r, &conn_id, sink).await?,
        RdProtocol::Rustdesk => connect_rustdesk(&app, &state, &ui, &r, &conn_id, sink).await?,
    };

    let Started { info, ctl, closed, task } = started;
    let conn = Arc::new(RdConn::new(conn_id.clone(), r.origin, info.clone(), ctl, closed, task));
    let on_closed = {
        let app = app.clone();
        let rt = rt.clone();
        let conn = conn.clone();
        Box::new(move |reason: Option<String>| {
            rt.forget_conn(&conn);
            let reason = reason.filter(|r| !r.is_empty());
            let _ = app.emit("rd-conn-closed", ConnClosed { conn_id: conn.id.clone(), reason });
        })
    };
    if let Err(e) = rt.insert_conn(conn.clone(), on_closed) {
        let _ = conn.send(RdCtl::Close);
        return Err(e);
    }
    Ok(info)
}

/// 任務結束時把原因寫進 watch（空字串 = 使用者自己斷的，事件裡轉成 null）。
fn finish(closed: watch::Sender<Option<String>>, reason: Option<String>) {
    let _ = closed.send(Some(reason.unwrap_or_default()));
}

#[cfg(feature = "rdp")]
#[allow(clippy::too_many_arguments)]
async fn connect_rdp(
    app: &AppHandle,
    state: &AppState,
    ui: &RdUi,
    r: &Resolved,
    conn_id: &str,
    width: u16,
    height: u16,
    scale: u32,
    sink: SinkFn,
) -> AppResult<Started> {
    use crate::rd::rdp;
    let s = &r.session;
    let o = &s.options;
    let (w, h) = if o.width > 0 && o.height > 0 { (o.width, o.height) } else { (width, height) };
    let mut params = rdp::RdpParams {
        host: s.host.clone(),
        port: s.effective_port(),
        username: s.username.clone(),
        password: r.password.clone().unwrap_or_default(),
        domain: s.domain.clone(),
        width: w,
        height: h,
        scale,
        color_depth: u32::from(o.color_depth),
        nla: o.nla,
        view_only: o.view_only,
        clipboard: o.clipboard,
    };
    let mut error: Option<String> = None;
    for attempt in 0..MAX_AUTH_TRIES {
        // NLA 要在連上之前就有帳密；沒存就先問（失敗重試時帶上次的錯誤）。
        if params.password.is_empty() || params.username.is_empty() || error.is_some() {
            let Some(a) = ui.creds(params.username.is_empty() || error.is_some(), &params.username, error.take()).await
            else {
                return Err(AppError::RdCancelled);
            };
            if !a.username.is_empty() {
                // `DOMAIN\user` 在對話框裡打也拆得開。
                match a.username.split_once('\\') {
                    Some((d, u)) => {
                        params.domain = d.to_string();
                        params.username = u.to_string();
                    }
                    None => params.username = a.username.clone(),
                }
            }
            params.password = a.password.clone();
            remember(&r.origin, &a);
        }
        // 經 SSH 的那段在主 runtime 撥（russh 的提示走 TauriUi）；直連的 TCP 交給 RDP 執行緒自己撥。
        let pre = match s.via_ssh() {
            Some(_) => Some(dial(app, state, conn_id, s).await?),
            None => None,
        };
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let (closed_tx, closed_rx) = watch::channel(None);
        let (res_tx, res_rx) = oneshot::channel::<AppResult<RdConnInfo>>();
        let (host, port, timeout) = (s.host.clone(), s.effective_port(), o.connect_timeout());
        let (params2, ui2, sink2, cid) = (params.clone(), ui.clone(), sink.clone(), conn_id.to_string());
        let short: String = conn_id.chars().take(8).collect();
        let done = rdp::run_on_own_thread(format!("rdp-{short}"), move || async move {
            let dialed = match pre {
                Some(d) => d,
                None => match transport::dial_direct(&host, port, timeout).await {
                    Ok(d) => d,
                    Err(e) => {
                        let _ = res_tx.send(Err(e));
                        return;
                    }
                },
            };
            let store = rdp::cert::default_store();
            match rdp::connect(dialed, &params2, &store, &ui2).await {
                Err(e) => {
                    let _ = res_tx.send(Err(e));
                }
                Ok(c) => {
                    let (dw, dh) = c.desktop_size();
                    let info = RdConnInfo {
                        conn_id: cid,
                        protocol: RdProtocol::Rdp,
                        width: dw,
                        height: dh,
                        security: c.security.to_string(),
                        encrypted: true,
                    };
                    if res_tx.send(Ok(info)).is_err() {
                        return; // 前端已經不等了
                    }
                    let reason = rdp::run(c, ctl_rx, sink2).await;
                    finish(closed_tx, reason);
                }
            }
        });
        let task = tokio::spawn(async move {
            let _ = done.await;
        });
        match res_rx.await {
            Ok(Ok(info)) => return Ok(Started { info, ctl: ctl_tx, closed: closed_rx, task }),
            Ok(Err(AppError::RdAuth(e))) if attempt + 1 < MAX_AUTH_TRIES => error = Some(e),
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(AppError::Rd(t!("RDP 連線執行緒意外結束").into())),
        }
    }
    Err(AppError::RdAuth(t!("認證失敗次數過多").into()))
}

#[cfg(not(feature = "rdp"))]
#[allow(clippy::too_many_arguments)]
async fn connect_rdp(
    _: &AppHandle,
    _: &AppState,
    _: &RdUi,
    _: &Resolved,
    _: &str,
    _: u16,
    _: u16,
    _: u32,
    _: SinkFn,
) -> AppResult<Started> {
    Err(AppError::Rd(t!("這個版本未內建 RDP").into()))
}

#[cfg(feature = "vnc")]
async fn connect_vnc(
    app: &AppHandle,
    state: &AppState,
    ui: &RdUi,
    r: &Resolved,
    conn_id: &str,
    sink: SinkFn,
) -> AppResult<Started> {
    use crate::rd::vnc::{auth, pump};
    let s = &r.session;
    let pref = match s.options.vnc_security {
        VncSecurity::Auto => auth::VncSecurityPref::Auto,
        VncSecurity::None => auth::VncSecurityPref::None,
        VncSecurity::Vnc => auth::VncSecurityPref::Vnc,
        VncSecurity::Ard => auth::VncSecurityPref::Ard,
        VncSecurity::Plain => auth::VncSecurityPref::Plain,
    };
    let mut creds = r
        .password
        .clone()
        .map(|p| auth::VncCreds { username: s.username.clone(), password: p });
    let mut error: Option<String> = None;
    for attempt in 0..MAX_AUTH_TRIES {
        if let Some(e) = error.take() {
            // 上一次被拒：重問（帶錯誤訊息；有帳號的就再要帳號）。
            let need_user = !s.username.is_empty() || creds.as_ref().is_some_and(|c| !c.username.is_empty());
            let Some(a) = ui.creds(need_user, &s.username, Some(e)).await else {
                return Err(AppError::RdCancelled);
            };
            remember(&r.origin, &a);
            creds = Some(auth::VncCreds { username: a.username, password: a.password });
        }
        let Dialed { mut stream, ssh, .. } = dial(app, state, conn_id, s).await?;
        let ask = VncAsk { ui, username: s.username.clone(), answered: parking_lot::Mutex::new(None) };
        let res = tokio::time::timeout(
            s.options.connect_timeout() + PROMPT_TIMEOUT,
            auth::client_handshake(&mut stream, pref, creds.clone(), &ask),
        )
        .await
        .unwrap_or_else(|_| Err(AppError::Rd(t!("VNC 握手逾時").into())));
        if let Some(a) = ask.answered.lock().take() {
            remember(&r.origin, &a);
            creds = Some(auth::VncCreds { username: a.username, password: a.password });
        }
        match res {
            Ok(out) => {
                let info = RdConnInfo {
                    conn_id: conn_id.to_string(),
                    protocol: RdProtocol::Vnc,
                    width: 0,
                    height: 0,
                    security: out.security.to_string(),
                    encrypted: out.encrypted,
                };
                let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
                let (closed_tx, closed_rx) = watch::channel(None);
                let sink = sink.clone();
                let task = tokio::spawn(async move {
                    let reason = pump::run(stream, ssh, ctl_rx, sink).await;
                    finish(closed_tx, reason);
                });
                return Ok(Started { info, ctl: ctl_tx, closed: closed_rx, task });
            }
            Err(e) => {
                if let Some(h) = ssh {
                    h.close().await;
                }
                match e {
                    AppError::RdAuth(msg) if attempt + 1 < MAX_AUTH_TRIES => error = Some(msg),
                    e => return Err(e),
                }
            }
        }
    }
    Err(AppError::RdAuth(t!("認證失敗次數過多").into()))
}

#[cfg(not(feature = "vnc"))]
async fn connect_vnc(_: &AppHandle, _: &AppState, _: &RdUi, _: &Resolved, _: &str, _: SinkFn) -> AppResult<Started> {
    Err(AppError::Rd(t!("這個版本未內建 VNC").into()))
}

/// RustDesk：啟動 AGPL 輔助程式登入。對方欄是 RustDesk ID → 經 ID 伺服器（直連打洞或中繼）；
/// 是位址 → Direct IP，經 SSH 時先開一個本機轉送埠給它撥。
async fn connect_rustdesk(
    app: &AppHandle,
    state: &AppState,
    ui: &RdUi,
    r: &Resolved,
    conn_id: &str,
    sink: SinkFn,
) -> AppResult<Started> {
    use crate::rd::rustdesk;
    let s = &r.session;
    if s.host.trim().is_empty() {
        return Err(AppError::Rd(t!("未填寫遠端主機").into()));
    }
    let rendezvous = rustdesk::is_rustdesk_id(&s.host).then(|| rustdesk::Rendezvous {
        server: s.options.rustdesk_server.trim().to_string(),
        relay: s.options.rustdesk_relay_server.trim().to_string(),
        key: s.options.rustdesk_key.trim().to_string(),
        force_relay: s.options.rustdesk_relay,
    });
    // ID 連線要連 ID 伺服器、再連它指定的中繼伺服器或對方，沒辦法只轉接一條連線。
    if rendezvous.is_some() && s.via_ssh().is_some() {
        return Err(AppError::Rd(
            t!("用 RustDesk ID 連線不能經 SSH 主機轉接：請改填對方電腦的 IP 位址（Direct IP），或取消「經 SSH 主機連線」").into(),
        ));
    }
    let mut password = r.password.clone().unwrap_or_default();
    let mut error: Option<String> = None;
    for attempt in 0..MAX_AUTH_TRIES {
        if let Some(e) = error.take() {
            let Some(a) = ui.creds(false, "", Some(e)).await else { return Err(AppError::RdCancelled) };
            remember(&r.origin, &a);
            password = a.password;
        }
        let (host, port, fwd) = match (&rendezvous, s.via_ssh()) {
            (Some(_), _) => (rustdesk::normalize_id(&s.host), 0, None),
            (None, Some(_)) => {
                let d = dial(app, state, conn_id, s).await?;
                let (port, task) = crate::rd::transport::local_forward(d).await?;
                ("127.0.0.1".to_string(), port, Some(task))
            }
            (None, None) => (s.host.clone(), s.effective_port(), None),
        };
        let p = rustdesk::RustdeskParams { host, port, password: password.clone(), rendezvous: rendezvous.clone() };
        match rustdesk::connect(&p, s.options.connect_timeout() + PROMPT_TIMEOUT).await {
            Ok(c) => {
                // Direct IP 跟官方用戶端一樣不加密（沒有 ID 伺服器可以驗對方的金鑰）；經 SSH 時外層加密。
                // 經 ID 伺服器時，驗得過對方公鑰（有填對 ID 伺服器的 Key）就是端到端加密。
                let (security, encrypted) = match (&rendezvous, fwd.is_some()) {
                    (Some(_), _) if c.secure => ("rustdesk-secure", true),
                    (Some(_), _) => ("rustdesk-id", false),
                    (None, true) => ("rustdesk-ssh", true),
                    (None, false) => ("rustdesk-direct", false),
                };
                let info = RdConnInfo {
                    conn_id: conn_id.to_string(),
                    protocol: RdProtocol::Rustdesk,
                    width: c.size.0,
                    height: c.size.1,
                    security: security.into(),
                    encrypted,
                };
                let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
                let (closed_tx, closed_rx) = watch::channel(None);
                let task = tokio::spawn(async move {
                    let reason = rustdesk::run(c, ctl_rx, sink).await;
                    if let Some(f) = fwd {
                        f.abort();
                    }
                    finish(closed_tx, reason);
                });
                return Ok(Started { info, ctl: ctl_tx, closed: closed_rx, task });
            }
            Err(e) => {
                if let Some(f) = fwd {
                    f.abort();
                }
                match e {
                    AppError::RdAuth(msg) if attempt + 1 < MAX_AUTH_TRIES => error = Some(msg),
                    e => return Err(e),
                }
            }
        }
    }
    Err(AppError::RdAuth(t!("認證失敗次數過多").into()))
}

#[tauri::command]
pub async fn rd_disconnect(state: State<'_, AppState>, conn_id: String) -> AppResult<()> {
    state.rd.disconnect(&conn_id).await;
    Ok(())
}

#[tauri::command]
pub fn rd_cert_answer(state: State<'_, AppState>, prompt_id: String, decision: CertDecision) -> AppResult<()> {
    state.rd.answer_prompt(&prompt_id, PromptAnswer::Cert(decision))
}

/// `answer == null` = 取消。
#[tauri::command]
pub fn rd_auth_answer(state: State<'_, AppState>, prompt_id: String, answer: Option<AuthAnswer>) -> AppResult<()> {
    state.rd.answer_prompt(&prompt_id, PromptAnswer::Auth(answer))
}

/// raw body 的 command：conn_id 在 `x-rd-conn` header。
fn raw_body(request: &Request<'_>) -> AppResult<(String, Vec<u8>)> {
    let id = request
        .headers()
        .get("x-rd-conn")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Rd("missing x-rd-conn header".into()))?
        .to_string();
    match request.body() {
        InvokeBody::Raw(b) => Ok((id, b.clone())),
        InvokeBody::Json(_) => Err(AppError::Rd("expected a raw body".into())),
    }
}

/// VNC：noVNC 送出的位元組。
#[tauri::command]
pub fn rd_write(state: State<'_, AppState>, request: Request<'_>) -> AppResult<()> {
    let (id, bytes) = raw_body(&request)?;
    state.rd.conn(&id)?.send(RdCtl::Write(bytes))
}

/// RDP：輸入紀錄（8 bytes 一筆）。
#[tauri::command]
pub fn rd_input(state: State<'_, AppState>, request: Request<'_>) -> AppResult<()> {
    let (id, bytes) = raw_body(&request)?;
    state.rd.conn(&id)?.send(RdCtl::Input(bytes))
}

#[tauri::command]
pub fn rd_frame_ack(state: State<'_, AppState>, conn_id: String, seq: u32) -> AppResult<()> {
    state.rd.conn(&conn_id)?.send(RdCtl::Ack(seq))
}

#[tauri::command]
pub fn rd_resize(state: State<'_, AppState>, conn_id: String, width: u16, height: u16, scale: u32) -> AppResult<()> {
    state.rd.conn(&conn_id)?.send(RdCtl::Resize { width, height, scale })
}

#[tauri::command]
pub fn rd_refresh(state: State<'_, AppState>, conn_id: String) -> AppResult<()> {
    state.rd.conn(&conn_id)?.send(RdCtl::Refresh)
}

/// 工具列組合鍵（`ctrl_alt_del` / `win` / `alt_tab` / `ctrl_esc` / `print_screen` / `alt_f4`）。
#[tauri::command]
pub fn rd_send_keys(state: State<'_, AppState>, conn_id: String, combo: String) -> AppResult<()> {
    state.rd.conn(&conn_id)?.send(RdCtl::Keys(combo))
}

/// 本機剪貼簿的文字交給遠端（RDP 經 CLIPRDR；VNC 由 noVNC 自己送 ClientCutText，不走這裡）。
#[tauri::command]
pub fn rd_clipboard_set(state: State<'_, AppState>, conn_id: String, text: String) -> AppResult<()> {
    state.rd.conn(&conn_id)?.send(RdCtl::Clipboard(text))
}

/// 讀本機系統剪貼簿的文字（沒有文字 / 讀不到 → null）。給遠端桌面的剪貼簿同步與「把剪貼簿文字送到遠端」用：
/// 在後端讀，webview 的 `navigator.clipboard.readText()` 會跳權限詢問並搶走遠端畫面的焦點。
#[tauri::command]
pub fn rd_clipboard_read() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok().filter(|t| !t.is_empty())
}

/// 把遠端複製的文字寫進本機系統剪貼簿。
#[tauri::command]
pub fn rd_clipboard_write(text: String) -> AppResult<()> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| AppError::Rd(tf!("無法寫入剪貼簿：{e}", e = e)))
}

#[derive(Clone, Serialize)]
struct GrabKeyEvent {
    conn_id: String,
    scancode: u16,
    down: bool,
}

/// 全螢幕時攔系統按鍵（Win / Alt+Tab / Alt+F4 / Ctrl+Esc）轉給這條連線；`conn_id = null` = 停止攔截。
/// 攔到的鍵經 `rd-grab-key` 事件交給前端（RDP 轉掃描碼、VNC 轉 keysym）。只有 Windows 真的攔得到，其他平台 no-op。
#[tauri::command]
pub fn rd_keyboard_grab(app: AppHandle, conn_id: Option<String>) {
    if conn_id.is_some() {
        crate::rd::keygrab::set_sink(Box::new(move |id, key| {
            let _ = app.emit("rd-grab-key", GrabKeyEvent { conn_id: id.to_string(), scancode: key.scancode, down: key.down });
        }));
    }
    crate::rd::keygrab::set_target(conn_id);
}

/// 視窗全螢幕（WebView2 的 HTML Fullscreen API 只會填滿 webview，不會蓋掉視窗框與工作列）。
#[tauri::command]
pub fn rd_set_fullscreen(window: tauri::Window, on: bool) -> AppResult<()> {
    window
        .set_fullscreen(on)
        .map_err(|e| AppError::Rd(tf!("無法切換全螢幕：{e}", e = e)))
}
