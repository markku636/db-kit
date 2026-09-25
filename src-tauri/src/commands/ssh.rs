//! SSH 終端機 / SFTP / 已存主機的 Tauri command（薄包裝）+ `TauriUi`。
//!
//! 這是整個 SSH 功能唯一碰 Tauri 的地方：`AppHandle::emit` 發生命週期事件、`ipc::Channel` 串流終端輸出、
//! `State<AppState>` 拿 `SshRuntime`。邏輯都在 `crate::ssh`。
//!
//! 事件：`ssh-hostkey-prompt`、`ssh-auth-prompt`、`ssh-term-exit`、`ssh-conn-closed`、`ssh-sftp-progress`。
//! 前端只用 `conn_id` / `term_id` / `prompt_id` / `transfer_id` 過濾。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::ssh::auth::{
    connect_and_auth, AuthPrompt, AuthPromptKind, AuthUi, HostKeyDecision, HostKeyQuestion,
    PromptItem, SshTarget, SshTargetRef, TargetOrigin,
};
use crate::ssh::known_hosts::{HostKeyStatus, KnownHostsStore};
use crate::ssh::runtime::{PromptAnswer, SshConn, SshConnInfo, SshRuntime};
use crate::ssh::sessions::{self, SshFolder, SshSession, SshSessionsFile};
use crate::ssh::sftp::{self as sftp_mod, OnConflict, ProgressFn, SftpClient, SftpEntry, SftpText};
use crate::ssh::terminal::{decode_b64_input, TermEvent, TermHandle, TermOpen, TermSink};
use crate::store;

/// host key / 認證對話框的等待上限。擋在 russh 的 event loop 裡，與撥號逾時分開計。
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);

// ---- 事件 payload ----

#[derive(Clone, Serialize)]
struct SshHostKeyPrompt {
    prompt_id: String,
    conn_id: String,
    host_id: String,
    key_type: String,
    fingerprint: String,
    /// `"new"` | `"changed"`
    status: &'static str,
    old_fingerprint: Option<String>,
}

#[derive(Clone, Serialize)]
struct SshAuthPromptEvent {
    prompt_id: String,
    conn_id: String,
    kind: AuthPromptKind,
    name: String,
    instructions: String,
    prompts: Vec<PromptItem>,
}

#[derive(Clone, Serialize)]
struct TermExit {
    term_id: String,
    status: Option<u32>,
    signal: Option<String>,
}

#[derive(Clone, Serialize)]
struct ConnClosed {
    conn_id: String,
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
struct SftpProgress {
    transfer_id: String,
    done: u64,
    total: Option<u64>,
    /// `"running"` | `"done"` | `"error"` | `"cancelled"`
    state: &'static str,
    message: Option<String>,
}

// ---- TauriUi ----

/// 把 `AuthUi` 的兩個問題變成事件 + `oneshot`：產 `prompt_id`、發事件、等 `ssh_hostkey_answer` /
/// `ssh_auth_answer` 回填。逾時、或 `ssh_disconnect` 把待答提示丟掉 → 視為使用者取消。
struct TauriUi {
    app: AppHandle,
    rt: Arc<SshRuntime>,
    conn_id: String,
}

impl TauriUi {
    async fn ask<F>(&self, emit: F) -> Option<PromptAnswer>
    where
        F: FnOnce(&str) -> tauri::Result<()>,
    {
        let (tx, rx) = oneshot::channel();
        let prompt_id = self.rt.register_prompt(&self.conn_id, tx);
        if let Err(e) = emit(&prompt_id) {
            eprintln!("[ssh] 發送提示事件失敗：{e}");
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
}

#[async_trait]
impl AuthUi for TauriUi {
    async fn host_key(&self, q: HostKeyQuestion) -> HostKeyDecision {
        let (status, old_fingerprint) = match &q.status {
            HostKeyStatus::Changed { old } => ("changed", Some(old.clone())),
            _ => ("new", None),
        };
        let answer = self
            .ask(|prompt_id| {
                self.app.emit(
                    "ssh-hostkey-prompt",
                    SshHostKeyPrompt {
                        prompt_id: prompt_id.to_string(),
                        conn_id: q.conn_id.clone(),
                        host_id: q.host_id.clone(),
                        key_type: q.key_type.clone(),
                        fingerprint: q.fingerprint.clone(),
                        status,
                        old_fingerprint: old_fingerprint.clone(),
                    },
                )
            })
            .await;
        match answer {
            Some(PromptAnswer::HostKey(d)) => d,
            _ => HostKeyDecision::Reject,
        }
    }

    async fn prompt(&self, q: AuthPrompt) -> Option<Vec<String>> {
        let answer = self
            .ask(|prompt_id| {
                self.app.emit(
                    "ssh-auth-prompt",
                    SshAuthPromptEvent {
                        prompt_id: prompt_id.to_string(),
                        conn_id: q.conn_id.clone(),
                        kind: q.kind,
                        name: q.name.clone(),
                        instructions: q.instructions.clone(),
                        prompts: q.prompts.clone(),
                    },
                )
            })
            .await;
        match answer {
            Some(PromptAnswer::Auth(a)) => a,
            _ => None,
        }
    }
}

// ---- 目標解析 ----

/// 前端的 `SshTargetRef` → 帶憑證的 `SshTarget`（憑證從 keychain 補；不回傳前端）。
async fn resolve_target(app: &AppHandle, r: SshTargetRef) -> AppResult<SshTarget> {
    match r {
        SshTargetRef::Session { id } => {
            let dir = store::app_config_dir(app)?;
            let file = sessions::load_in(&dir).await?;
            let s = file
                .sessions
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| AppError::Ssh(tf!("找不到 SSH 主機：{id}", id = id)))?;
            let pw = store::kc_get(&sessions::session_password_account(&id));
            let pp = store::kc_get(&sessions::session_passphrase_account(&id));
            Ok(SshTarget::from_session(&s, pw, pp))
        }
        SshTargetRef::Connection { id } => {
            let cfg = store::load_connection(app, &id).await?;
            SshTarget::from_connection(&cfg)
        }
        SshTargetRef::AdHoc { session, password, passphrase } => {
            // 對話框「測試連線」：留空 = 用 keychain 裡存的（與連線對話框「留空 = 不變更」同語意）。
            let pw = password
                .filter(|p| !p.is_empty())
                .or_else(|| store::kc_get(&sessions::session_password_account(&session.id)));
            let pp = passphrase
                .filter(|p| !p.is_empty())
                .or_else(|| store::kc_get(&sessions::session_passphrase_account(&session.id)));
            let mut t = SshTarget::from_session(&session, pw, pp);
            t.origin = TargetOrigin::AdHoc;
            Ok(t)
        }
    }
}

// ---- 已存主機 ----

/// 全部已存主機與資料夾。永不含密碼（型別上就沒有）。
#[tauri::command]
pub async fn ssh_sessions_list(app: AppHandle) -> AppResult<SshSessionsFile> {
    sessions::load_in(&store::app_config_dir(&app)?).await
}

/// 新增 / 更新主機。`password` / `passphrase` 非空 → 寫 keychain；空 / null = 保留舊值（鏡射 `save_connection`）。
#[tauri::command]
pub async fn ssh_session_save(
    app: AppHandle,
    session: SshSession,
    password: Option<String>,
    passphrase: Option<String>,
) -> AppResult<()> {
    if session.host.trim().is_empty() {
        return Err(AppError::Ssh(t!("未填寫 SSH 主機").into()));
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        store::kc_set(&sessions::session_password_account(&session.id), &p)?;
    }
    if let Some(p) = passphrase.filter(|p| !p.is_empty()) {
        store::kc_set(&sessions::session_passphrase_account(&session.id), &p)?;
    }
    sessions::upsert_in(&store::app_config_dir(&app)?, session).await
}

/// 刪除主機：先斷開它開著的連線，再刪檔 + keychain 兩個帳號。
#[tauri::command]
pub async fn ssh_session_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let rt = state.ssh.clone();
    for cid in rt.conn_ids_for(&TargetOrigin::Session(id.clone())) {
        rt.disconnect(&cid).await;
    }
    sessions::remove_in(&store::app_config_dir(&app)?, &id).await?;
    store::kc_delete(&sessions::session_password_account(&id));
    store::kc_delete(&sessions::session_passphrase_account(&id));
    Ok(())
}

/// 側欄排版的一筆：主機 id + 所屬資料夾。
#[derive(Debug, Deserialize)]
pub struct SshPlacement {
    pub id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[tauri::command]
pub async fn ssh_sessions_layout_save(
    app: AppHandle,
    folders: Vec<SshFolder>,
    order: Vec<SshPlacement>,
) -> AppResult<()> {
    let order: Vec<(String, Option<String>)> =
        order.into_iter().map(|p| (p.id, p.folder_id)).collect();
    sessions::save_layout_in(&store::app_config_dir(&app)?, folders, &order).await
}

/// keychain 是否存有此主機的密碼（不回傳密碼本身）。
#[tauri::command]
pub fn ssh_has_stored_password(id: String) -> bool {
    store::kc_get(&sessions::session_password_account(&id))
        .map(|p| !p.is_empty())
        .unwrap_or(false)
}

// ---- 連線 ----

/// 建立連線並認證。`conn_id` 由前端產生（uuid），這樣 prompt 事件在回傳前就能被對上。
/// 期間的 host key / 密碼 / OTP 提示走事件，由 `ssh_hostkey_answer` / `ssh_auth_answer` 回答。
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    target: SshTargetRef,
) -> AppResult<SshConnInfo> {
    let rt = state.ssh.clone();
    // 同 id 已存在（前端沿用 id 重連）→ 先關舊的。
    rt.disconnect(&conn_id).await;
    let t = resolve_target(&app, target).await?;
    let ui = Arc::new(TauriUi { app: app.clone(), rt: rt.clone(), conn_id: conn_id.clone() });
    let connected = connect_and_auth(&t, &conn_id, ui, KnownHostsStore::default_path()).await?;
    let conn = Arc::new(SshConn::new(conn_id.clone(), &t, connected));
    let info = conn.info.clone();
    let on_closed = {
        let app = app.clone();
        let rt = rt.clone();
        let conn = conn.clone();
        Box::new(move |reason: Option<String>| {
            rt.forget_conn(&conn);
            let _ = app.emit(
                "ssh-conn-closed",
                ConnClosed { conn_id: conn.id.clone(), reason },
            );
        })
    };
    if let Err(e) = rt.insert_conn(conn.clone(), on_closed) {
        let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
        return Err(e);
    }
    Ok(info)
}

/// 對話框「測試連線」：連線 + 認證 + 斷線（含 prompt）。
#[tauri::command]
pub async fn ssh_test(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    target: SshTargetRef,
) -> AppResult<()> {
    let rt = state.ssh.clone();
    let t = resolve_target(&app, target).await?;
    let ui = Arc::new(TauriUi { app: app.clone(), rt, conn_id: conn_id.clone() });
    let c = connect_and_auth(&t, &conn_id, ui, KnownHostsStore::default_path()).await?;
    let _ = c.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
    Ok(())
}

/// 關閉所有終端 / SFTP 後斷線。連線中（待答提示）呼叫 → 提示被丟掉，`ssh_connect` 以 `SshCancelled` 結束。
#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, conn_id: String) -> AppResult<()> {
    state.ssh.disconnect(&conn_id).await;
    Ok(())
}

/// 使用者回答 host key 對話框。
#[tauri::command]
pub fn ssh_hostkey_answer(
    state: State<'_, AppState>,
    prompt_id: String,
    decision: HostKeyDecision,
) -> AppResult<()> {
    state.ssh.answer_prompt(&prompt_id, PromptAnswer::HostKey(decision))
}

/// 使用者回答密碼 / 密語 / keyboard-interactive；`answers == null` = 取消。
#[tauri::command]
pub fn ssh_auth_answer(
    state: State<'_, AppState>,
    prompt_id: String,
    answers: Option<Vec<String>>,
) -> AppResult<()> {
    state.ssh.answer_prompt(&prompt_id, PromptAnswer::Auth(answers))
}

// ---- 終端機 ----

/// 開 PTY shell。輸出走 `on_output`（`InvokeResponseBody::Raw` = 原始位元組，前端拿到 `ArrayBuffer`），
/// 後端已合併 ≤ 16 KiB / 8 ms 一送；結束發 `ssh-term-exit`。
#[tauri::command]
pub async fn ssh_term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    cols: u32,
    rows: u32,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<String> {
    let rt = state.ssh.clone();
    let conn = rt.conn(&conn_id)?;
    let term_id = uuid::Uuid::new_v4().to_string();
    // TermSink 把「怎麼送到前端」封在這一個閉包：要退回 emit + base64 只改這裡。
    let sink: TermSink = {
        let app = app.clone();
        let tid = term_id.clone();
        Arc::new(move |ev| match ev {
            TermEvent::Data(bytes) => {
                let _ = on_output.send(InvokeResponseBody::Raw(bytes));
            }
            TermEvent::Exit { status, signal } => {
                let _ = app.emit("ssh-term-exit", TermExit { term_id: tid.clone(), status, signal });
            }
        })
    };
    let o = &conn.term_opts;
    let term = TermHandle::open(
        conn.clone(),
        TermOpen {
            cols,
            rows,
            term: o.term.clone(),
            env: o.env.clone(),
            startup_command: o.startup_command.clone(),
        },
        sink,
    )
    .await?;
    let term = Arc::new(term);
    conn.channel_opened();
    if let Err(e) = rt.insert_term(term_id.clone(), term.clone()) {
        term.close().await;
        conn.channel_closed();
        return Err(e);
    }
    Ok(term_id)
}

/// xterm `onData` / `onBinary` 的輸入（base64）。
#[tauri::command]
pub async fn ssh_term_write(state: State<'_, AppState>, term_id: String, data_b64: String) -> AppResult<()> {
    let term = state.ssh.term(&term_id)?;
    term.write(&decode_b64_input(&data_b64)?).await
}

/// 送一行（補 `\r`）。AI「送到終端機」與命令列輸入條專用，獨立命令便於稽核。
#[tauri::command]
pub async fn ssh_term_send_line(state: State<'_, AppState>, term_id: String, line: String) -> AppResult<()> {
    let term = state.ssh.term(&term_id)?;
    term.send_line(&line).await
}

#[tauri::command]
pub async fn ssh_term_resize(state: State<'_, AppState>, term_id: String, cols: u32, rows: u32) -> AppResult<()> {
    let term = state.ssh.term(&term_id)?;
    term.resize(cols, rows).await
}

/// 關終端。該連線一條 channel 都不剩 → 自動 disconnect（watcher 會發 `ssh-conn-closed`）。
#[tauri::command]
pub async fn ssh_term_close(state: State<'_, AppState>, term_id: String) -> AppResult<()> {
    let rt = state.ssh.clone();
    let Some(term) = rt.remove_term(&term_id) else {
        return Ok(());
    };
    term.close().await;
    if let Ok(conn) = rt.conn(&term.conn_id) {
        if conn.channel_closed() {
            rt.disconnect(&conn.id).await;
        }
    }
    Ok(())
}

// ---- SFTP ----

#[derive(Clone, Serialize)]
pub struct SftpOpened {
    pub sftp_id: String,
    pub home: String,
}

/// 同一條連線開 sftp subsystem（不再問密碼）。
#[tauri::command]
pub async fn ssh_sftp_open(state: State<'_, AppState>, conn_id: String) -> AppResult<SftpOpened> {
    let rt = state.ssh.clone();
    let conn = rt.conn(&conn_id)?;
    let (client, home) = SftpClient::open(&conn).await?;
    let sftp_id = uuid::Uuid::new_v4().to_string();
    conn.channel_opened();
    rt.insert_sftp(sftp_id.clone(), Arc::new(client));
    Ok(SftpOpened { sftp_id, home })
}

#[tauri::command]
pub async fn ssh_sftp_close(state: State<'_, AppState>, sftp_id: String) -> AppResult<()> {
    let rt = state.ssh.clone();
    let Some(sftp) = rt.remove_sftp(&sftp_id) else {
        return Ok(());
    };
    sftp.close().await;
    if let Ok(conn) = rt.conn(&sftp.conn_id) {
        if conn.channel_closed() {
            rt.disconnect(&conn.id).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_sftp_list(state: State<'_, AppState>, sftp_id: String, path: String) -> AppResult<Vec<SftpEntry>> {
    let sftp = state.ssh.sftp(&sftp_id)?;
    sftp.list_dir(&path).await
}

#[tauri::command]
pub async fn ssh_sftp_stat(state: State<'_, AppState>, sftp_id: String, path: String) -> AppResult<SftpEntry> {
    let sftp = state.ssh.sftp(&sftp_id)?;
    sftp.stat(&path).await
}

#[tauri::command]
pub async fn ssh_sftp_mkdir(state: State<'_, AppState>, sftp_id: String, path: String) -> AppResult<()> {
    let sftp = state.ssh.sftp(&sftp_id)?;
    sftp.mkdir(&path).await
}

#[tauri::command]
pub async fn ssh_sftp_rename(state: State<'_, AppState>, sftp_id: String, from: String, to: String) -> AppResult<()> {
    let sftp = state.ssh.sftp(&sftp_id)?;
    sftp.rename(&from, &to).await
}

#[tauri::command]
pub async fn ssh_sftp_remove(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    recursive: bool,
) -> AppResult<()> {
    let sftp = state.ssh.sftp(&sftp_id)?;
    sftp.remove(&path, recursive).await
}

/// 讀小檔預覽：最多 `max_bytes`（上限 1 MiB；0 = 上限），超過標 `truncated`。
#[tauri::command]
pub async fn ssh_sftp_read_text(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    max_bytes: u64,
) -> AppResult<SftpText> {
    let sftp = state.ssh.sftp(&sftp_id)?;
    sftp.read_small(&path, max_bytes).await
}

/// 把編輯器內容寫回遠端（Xftp「編輯」的存檔）。`create_new` = 新增檔案（已存在即失敗）。
/// 回傳寫完後的屬性，前端拿 mtime / size 當下一次存檔的衝突基準。
#[tauri::command]
pub async fn ssh_sftp_write_text(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    content: String,
    create_new: bool,
) -> AppResult<SftpEntry> {
    let sftp = state.ssh.sftp(&sftp_id)?;
    sftp.write_text(&path, &content, create_new).await
}

/// chmod：只改權限位元（`0o7777` 以內）。回傳變更後的屬性。
#[tauri::command]
pub async fn ssh_sftp_chmod(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    mode: u32,
) -> AppResult<SftpEntry> {
    let sftp = state.ssh.sftp(&sftp_id)?;
    sftp.chmod(&path, mode).await
}

/// 進度追蹤 + 收尾事件，上下傳共用。
struct TransferReporter {
    app: AppHandle,
    transfer_id: String,
    done: Arc<AtomicU64>,
    total: Arc<parking_lot::Mutex<Option<u64>>>,
}

impl TransferReporter {
    fn new(app: AppHandle, transfer_id: String) -> Self {
        Self {
            app,
            transfer_id,
            done: Arc::new(AtomicU64::new(0)),
            total: Arc::new(parking_lot::Mutex::new(None)),
        }
    }

    fn emit(&self, state: &'static str, message: Option<String>) {
        let _ = self.app.emit(
            "ssh-sftp-progress",
            SftpProgress {
                transfer_id: self.transfer_id.clone(),
                done: self.done.load(Ordering::Relaxed),
                total: *self.total.lock(),
                state,
                message,
            },
        );
    }

    fn progress_fn(&self) -> ProgressFn {
        let app = self.app.clone();
        let tid = self.transfer_id.clone();
        let done = self.done.clone();
        let total = self.total.clone();
        Box::new(move |d, t| {
            done.store(d, Ordering::Relaxed);
            *total.lock() = t;
            let _ = app.emit(
                "ssh-sftp-progress",
                SftpProgress { transfer_id: tid.clone(), done: d, total: t, state: "running", message: None },
            );
        })
    }

    fn finish(&self, r: AppResult<Option<String>>) {
        match r {
            Ok(msg) => self.emit("done", msg),
            Err(AppError::SshCancelled) => self.emit("cancelled", None),
            Err(e) => self.emit("error", Some(e.message())),
        }
    }
}

/// 下載到本機（`local` 是既有目錄時用遠端檔名）。立即回 `transfer_id`，進度走 `ssh-sftp-progress`。
#[tauri::command]
pub async fn ssh_sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    remote: String,
    local: String,
    overwrite: bool,
) -> AppResult<String> {
    let rt = state.ssh.clone();
    let sftp = rt.sftp(&sftp_id)?;
    let (transfer_id, cancel) = rt.register_transfer(&sftp.conn_id);
    let reporter = TransferReporter::new(app, transfer_id.clone());
    let tid = transfer_id.clone();
    tauri::async_runtime::spawn(async move {
        let progress = reporter.progress_fn();
        // 資料夾（或指向資料夾的 symlink）整棵下載；其餘照單檔。前端不必分兩條命令。
        let is_dir = sftp
            .stat(&remote)
            .await
            .map(|e| (e.is_dir && !e.is_symlink) || e.link_target_is_dir == Some(true))
            .unwrap_or(false);
        let r = if is_dir {
            sftp.download_tree(&remote, Path::new(&local), overwrite, progress, &cancel).await
        } else {
            sftp.download(&remote, Path::new(&local), overwrite, progress, &cancel).await
        }
        .map(|p| Some(p.display().to_string()));
        reporter.finish(r);
        rt.finish_transfer(&tid);
    });
    Ok(transfer_id)
}

/// 上傳本機檔。立即回 `transfer_id`，進度走 `ssh-sftp-progress`。
#[tauri::command]
pub async fn ssh_sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    local: String,
    remote: String,
    overwrite: bool,
) -> AppResult<String> {
    let rt = state.ssh.clone();
    let sftp = rt.sftp(&sftp_id)?;
    let (transfer_id, cancel) = rt.register_transfer(&sftp.conn_id);
    let reporter = TransferReporter::new(app, transfer_id.clone());
    let tid = transfer_id.clone();
    tauri::async_runtime::spawn(async move {
        let progress = reporter.progress_fn();
        // 本機資料夾 → 整棵上傳到 `remote`（遠端新資料夾的完整路徑）；其餘照單檔。
        let is_dir = tokio::fs::metadata(&local).await.map(|m| m.is_dir()).unwrap_or(false);
        let r = if is_dir {
            sftp.upload_tree(Path::new(&local), &remote, overwrite, progress, &cancel).await
        } else {
            sftp.upload(Path::new(&local), &remote, overwrite, progress, &cancel).await.map(|_| remote.clone())
        }
        .map(Some);
        reporter.finish(r);
        rt.finish_transfer(&tid);
    });
    Ok(transfer_id)
}

/// 多選下載（Xftp 多選拖到本機）：檔案 / 資料夾混合，全部放進 `local_dir`。整批一個 transfer、
/// 依序傳、進度合併；`on_conflict` 決定本機已有同名項目時覆蓋 / 略過 / 整批不開始。
/// 完成事件的 `message` 是略過項目的摘要（沒有略過就是 null）。
#[tauri::command]
pub async fn ssh_sftp_download_many(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    remotes: Vec<String>,
    local_dir: String,
    on_conflict: OnConflict,
) -> AppResult<String> {
    let rt = state.ssh.clone();
    let sftp = rt.sftp(&sftp_id)?;
    let (transfer_id, cancel) = rt.register_transfer(&sftp.conn_id);
    let reporter = TransferReporter::new(app, transfer_id.clone());
    let tid = transfer_id.clone();
    tauri::async_runtime::spawn(async move {
        let r = sftp
            .download_many(&remotes, Path::new(&local_dir), on_conflict, reporter.progress_fn(), &cancel)
            .await
            .map(|s| s.message());
        reporter.finish(r);
        rt.finish_transfer(&tid);
    });
    Ok(transfer_id)
}

/// 多選上傳：本機檔案 / 資料夾混合，全部放進遠端的 `remote_dir`。其餘同 `ssh_sftp_download_many`。
#[tauri::command]
pub async fn ssh_sftp_upload_many(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    locals: Vec<String>,
    remote_dir: String,
    on_conflict: OnConflict,
) -> AppResult<String> {
    let rt = state.ssh.clone();
    let sftp = rt.sftp(&sftp_id)?;
    let (transfer_id, cancel) = rt.register_transfer(&sftp.conn_id);
    let reporter = TransferReporter::new(app, transfer_id.clone());
    let tid = transfer_id.clone();
    tauri::async_runtime::spawn(async move {
        let locals: Vec<std::path::PathBuf> = locals.into_iter().map(Into::into).collect();
        let r = sftp
            .upload_many(&locals, &remote_dir, on_conflict, reporter.progress_fn(), &cancel)
            .await
            .map(|s| s.message());
        reporter.finish(r);
        rt.finish_transfer(&tid);
    });
    Ok(transfer_id)
}

/// 下載前的同名檢查：`names` 裡哪些在 `local_dir` 已經有了（與實際下載同一套檔名轉換）。
#[tauri::command]
pub async fn ssh_sftp_local_conflicts(local_dir: String, names: Vec<String>) -> AppResult<Vec<String>> {
    Ok(sftp_mod::local_conflicts(Path::new(&local_dir), &names).await)
}

#[tauri::command]
pub fn ssh_sftp_cancel(state: State<'_, AppState>, transfer_id: String) -> AppResult<()> {
    state.ssh.cancel_transfer(&transfer_id);
    Ok(())
}
