//! SSH 撥號 + 認證（tunnel / 終端機 / SFTP 共用）。
//!
//! - `SshTarget`：一次連線需要的全部資料（主機、帳號、憑證、終端選項），由已存主機 / DB 連線 /
//!   臨時輸入三種來源組成。
//! - `AuthUi`：需要人回答的兩件事——host key 要不要信任、密碼 / 私鑰密語 / keyboard-interactive
//!   的答案。tunnel 與 CLI 用 `SilentUi`（TOFU 自動接受、不會發問）；GUI 用 `commands/ssh.rs` 的
//!   `TauriUi`（走事件 + oneshot）。
//! - `DbkHandler`：russh client handler，做 host key 驗證與斷線通知。
//! - `connect_and_auth`：撥號 → host key → 依 `plan_auth` 逐步認證，全失敗回 `AppError::SshAuth`。
//!
//! 安全備註：`check_server_key` 讀取 / 持久化 known_hosts 失敗時一律「拒絕連線」（fail-closed），
//! 不退回「信任任意金鑰」；指紋不符（可能中間人）預設拒絕，只有使用者在對話框明確接受才放行。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, AuthResult, DisconnectReason, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{MethodKind, MethodSet};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::keys::{self, KeyError};
use super::known_hosts::{HostKeyStatus, KnownHostsStore};
use super::sessions::{SshAuthKind, SshSession, SshTermOptions};
use crate::db::{ConnectionConfig, SshAuthMethod};
use crate::error::{AppError, AppResult};

/// TCP + banner + KEX 的預設預算（`connect_timeout_secs == 0` 時）。避免黑洞 bastion
/// （接受 TCP 但不完成 banner/KEX）無限阻塞 connect 路徑。host key 對話框的等待**不算在內**。
pub const SSH_DIAL_TIMEOUT: Duration = Duration::from_secs(20);

/// 單一認證來回（送出憑證 → 伺服器回覆）的逾時；使用者填對話框的時間不算在內。
const AUTH_STEP_TIMEOUT: Duration = Duration::from_secs(20);

/// 撥號預算的計時粒度。
const DIAL_TICK: Duration = Duration::from_millis(200);

// ---- 目標 ----

/// 這條連線是從哪裡來的（刪除主機 / 連線時要能找出它開的 live 連線）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetOrigin {
    Session(String),
    Connection(String),
    AdHoc,
}

/// 一次連線需要的全部資料。密碼 / 密語只活在記憶體。
#[derive(Debug, Clone)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuthKind,
    pub password: String,
    /// 私鑰檔路徑，或金鑰庫參照 `keystore:<id>`。
    pub private_key_path: String,
    /// OpenSSH 使用者憑證；空 = 找私鑰旁邊的 `<私鑰>-cert.pub`。
    pub certificate_path: String,
    pub passphrase: String,
    pub term: SshTermOptions,
    pub origin: TargetOrigin,
}

impl SshTarget {
    /// 從已存主機組目標；密碼 / 密語由呼叫端從 keychain（或對話框）補上。
    pub fn from_session(s: &SshSession, password: Option<String>, passphrase: Option<String>) -> Self {
        Self {
            host: s.host.trim().to_string(),
            port: if s.port == 0 { 22 } else { s.port },
            username: s.username.clone(),
            auth: s.auth,
            password: password.unwrap_or_default(),
            private_key_path: s.private_key_path.clone(),
            certificate_path: s.certificate_path.clone(),
            passphrase: passphrase.unwrap_or_default(),
            term: s.options.clone(),
            origin: TargetOrigin::Session(s.id.clone()),
        }
    }

    /// 從 DB 連線的 SSH tunnel 設定組目標（右鍵「開啟 SSH 終端機」與 tunnel 本身共用）。
    /// `cfg` 應已 hydrate 過 keychain（`store::load_connection`）。
    pub fn from_connection(cfg: &ConnectionConfig) -> AppResult<Self> {
        if !cfg.ssh_enabled {
            return Err(AppError::Ssh(t!("此連線未啟用 SSH").into()));
        }
        if cfg.ssh_host.trim().is_empty() {
            return Err(AppError::Ssh(t!("未填寫 SSH 主機").into()));
        }
        Ok(Self {
            host: cfg.ssh_host.trim().to_string(),
            port: if cfg.ssh_port == 0 { 22 } else { cfg.ssh_port },
            username: cfg.ssh_username.clone(),
            auth: match cfg.ssh_auth_method {
                SshAuthMethod::Password => SshAuthKind::Password,
                SshAuthMethod::Key => SshAuthKind::Key,
            },
            password: cfg.ssh_password.clone(),
            private_key_path: cfg.ssh_private_key_path.clone(),
            certificate_path: String::new(),
            passphrase: cfg.ssh_passphrase.clone(),
            term: SshTermOptions::default(),
            origin: TargetOrigin::Connection(cfg.id.clone()),
        })
    }

    /// known_hosts 的鍵，與 tunnel 舊版格式相同（`host:port`）。
    pub fn host_id(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// 顯示用 `user@host`。
    pub fn label(&self) -> String {
        format!("{}@{}", self.username, self.host)
    }

    /// 撥號預算。
    pub fn connect_timeout(&self) -> Duration {
        if self.term.connect_timeout_secs == 0 {
            SSH_DIAL_TIMEOUT
        } else {
            Duration::from_secs(u64::from(self.term.connect_timeout_secs))
        }
    }
}

/// 前端指定連線目標的方式（`ssh_connect` / `ssh_test` 的 `target` 參數）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshTargetRef {
    /// 已存主機：密碼 / 密語從 keychain 取。
    Session { id: String },
    /// DB 連線的 tunnel 設定：憑證從 keychain 取。
    Connection { id: String },
    /// 對話框「測試連線」等尚未存檔的輸入。
    AdHoc {
        session: SshSession,
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

// ---- 發問介面 ----

/// host key 對話框的答案。`accept_save` 寫入 known_hosts、`accept_once` 只放行這次。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyDecision {
    AcceptSave,
    AcceptOnce,
    Reject,
}

/// 「要不要信任這把 host key」。`status` 只會是 `New` 或 `Changed`（`Known` 不會問）。
#[derive(Debug, Clone)]
pub struct HostKeyQuestion {
    pub conn_id: String,
    pub host_id: String,
    pub key_type: String,
    pub fingerprint: String,
    pub status: HostKeyStatus,
}

/// 認證提示的種類；前端據此決定對話框樣式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthPromptKind {
    Password,
    Passphrase,
    KeyboardInteractive,
}

/// 一個輸入欄；`echo == false` 是密碼欄。
#[derive(Debug, Clone, Serialize)]
pub struct PromptItem {
    pub prompt: String,
    pub echo: bool,
}

/// 一次認證提示（可能多欄，keyboard-interactive 由伺服器決定）。
#[derive(Debug, Clone)]
pub struct AuthPrompt {
    pub conn_id: String,
    pub kind: AuthPromptKind,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<PromptItem>,
}

/// 認證期間需要人回答的介面。實作者：`SilentUi`（tunnel / CLI）、`TauriUi`（GUI）。
#[async_trait]
pub trait AuthUi: Send + Sync {
    /// host key 是新的或變了：要不要信任。
    async fn host_key(&self, q: HostKeyQuestion) -> HostKeyDecision;
    /// 密碼 / 密語 / keyboard-interactive。回 `None` = 使用者取消（整個連線以 `SshCancelled` 結束）。
    async fn prompt(&self, q: AuthPrompt) -> Option<Vec<String>>;
    /// 能否向使用者發問。`SilentUi` 回 `false`：需要發問的步驟直接略過，不假裝成「使用者取消」。
    fn can_prompt(&self) -> bool {
        true
    }
}

/// 不發問的實作：新主機 TOFU 自動記住（= 舊版 tunnel 行為）、指紋變更一律拒絕、不會問密碼。
pub struct SilentUi;

#[async_trait]
impl AuthUi for SilentUi {
    async fn host_key(&self, q: HostKeyQuestion) -> HostKeyDecision {
        match q.status {
            HostKeyStatus::New => HostKeyDecision::AcceptSave,
            HostKeyStatus::Known => HostKeyDecision::AcceptOnce,
            HostKeyStatus::Changed { .. } => {
                eprintln!(
                    "[ssh] host key 與已記錄指紋不符，拒絕連線（可能遭中間人攻擊）：{}",
                    q.host_id
                );
                HostKeyDecision::Reject
            }
        }
    }

    async fn prompt(&self, _q: AuthPrompt) -> Option<Vec<String>> {
        None
    }

    fn can_prompt(&self) -> bool {
        false
    }
}

// ---- host key 判定 ----

/// 決定要不要信任這把 host key（`check_server_key` 的主體，抽出來好測）。
/// `Ok(())` = 放行；`Err` = 拒絕，錯誤會由 `connect_and_auth` 原樣回給呼叫端。
pub(crate) async fn decide_host_key(
    store: &KnownHostsStore,
    conn_id: &str,
    host_id: &str,
    key_type: &str,
    fingerprint: &str,
    ui: &dyn AuthUi,
) -> AppResult<()> {
    // 讀取失敗（檔案損毀 / 解析錯誤等）→ fail-closed 拒絕，不可退回「信任任意金鑰」。
    let status = match store.check(host_id, fingerprint) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[ssh] 無法讀取 known_hosts，為防中間人而拒絕連線：{e}");
            return Err(AppError::SshHostKey(tf!(
                "無法讀取 known_hosts，為防中間人而拒絕連線：{e}",
                e = e
            )));
        }
    };
    if status == HostKeyStatus::Known {
        return Ok(());
    }
    let changed = matches!(status, HostKeyStatus::Changed { .. });
    let q = HostKeyQuestion {
        conn_id: conn_id.to_string(),
        host_id: host_id.to_string(),
        key_type: key_type.to_string(),
        fingerprint: fingerprint.to_string(),
        status,
    };
    match ui.host_key(q).await {
        HostKeyDecision::AcceptSave => store.record(host_id, fingerprint).map_err(|e| {
            // 無法持久化則拒絕（避免下次又重新信任任意金鑰）。
            eprintln!("[ssh] 無法保存 host key 指紋，為防下次重新信任而拒絕連線：{e}");
            AppError::SshHostKey(tf!("無法保存 host key 指紋：{e}", e = e))
        }),
        HostKeyDecision::AcceptOnce => Ok(()),
        // 有人在看對話框 → 是「使用者取消」；沒人可問（tunnel）→ 是主機金鑰錯誤，要讓它浮出來。
        HostKeyDecision::Reject if ui.can_prompt() => Err(AppError::SshCancelled),
        HostKeyDecision::Reject if changed => Err(AppError::SshHostKey(tf!(
            "{host} 的主機金鑰與已記錄的指紋不符，已拒絕連線（可能遭中間人攻擊）",
            host = host_id
        ))),
        HostKeyDecision::Reject => Err(AppError::SshHostKey(tf!(
            "未信任 {host} 的主機金鑰",
            host = host_id
        ))),
    }
}

// ---- russh handler ----

/// russh client handler：host key 驗證 + 斷線通知。
pub struct DbkHandler {
    conn_id: String,
    host_id: String,
    store: KnownHostsStore,
    ui: Arc<dyn AuthUi>,
    /// host key 被拒的精確原因。russh 只會回一個籠統的 `UnknownKey`，`connect_and_auth` 從這裡取回。
    hostkey_error: Arc<parking_lot::Mutex<Option<AppError>>>,
    /// 正在等對話框：撥號預算的計時暫停（使用者看對話框的時間不該算成連線逾時）。
    prompting: Arc<AtomicBool>,
    /// 連線結束時寫入原因（`Some`），runtime 據此發 `ssh-conn-closed`。
    closed: watch::Sender<Option<String>>,
}

impl client::Handler for DbkHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        // 指紋維持 SHA256 字串（與舊版 `fingerprint(Default::default())` 相同格式），舊檔可直接沿用。
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = server_public_key.algorithm().as_str().to_string();
        self.prompting.store(true, Ordering::Relaxed);
        let r = decide_host_key(
            &self.store,
            &self.conn_id,
            &self.host_id,
            &key_type,
            &fp,
            self.ui.as_ref(),
        )
        .await;
        self.prompting.store(false, Ordering::Relaxed);
        match r {
            Ok(()) => Ok(true),
            Err(e) => {
                *self.hostkey_error.lock() = Some(e);
                Ok(false)
            }
        }
    }

    async fn disconnected(&mut self, reason: DisconnectReason<Self::Error>) -> Result<(), Self::Error> {
        let (text, result) = match reason {
            DisconnectReason::ReceivedDisconnect(info) => {
                let msg = if info.message.trim().is_empty() {
                    format!("{:?}", info.reason_code)
                } else {
                    info.message
                };
                (msg, Ok(()))
            }
            DisconnectReason::Error(e) => (e.to_string(), Err(e)),
        };
        // send_replace：就算沒人在聽（連線早已被 runtime 忘掉）也不算錯。
        self.closed.send_replace(Some(text));
        result
    }
}

// ---- 認證計畫 ----

/// 一個認證步驟。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStep {
    Agent,
    Key,
    Password,
    KeyboardInteractive,
}

impl AuthStep {
    fn label(self) -> &'static str {
        match self {
            AuthStep::Agent => t!("ssh-agent"),
            AuthStep::Key => t!("公鑰"),
            AuthStep::Password => t!("密碼"),
            AuthStep::KeyboardInteractive => t!("鍵盤互動"),
        }
    }
}

/// 純函式：依目標與 agent 是否可用排出認證順序（與 OpenSSH client 相同：agent → 金鑰檔 → 密碼 → KI）。
///
/// - `Agent`：明確選 agent，或 agent 可用且有指定金鑰檔（金鑰可能已載入 agent，可省掉密語）。
/// - `Key`：有指定金鑰檔。
/// - `Password` / `KeyboardInteractive`：明確選的才排；伺服器在 `Failure` 裡點名 KI 時
///   `connect_and_auth` 會動態補上（例如 PAM + OTP）。
pub fn plan_auth(t: &SshTarget, agent_available: bool) -> Vec<AuthStep> {
    let has_key = !t.private_key_path.trim().is_empty();
    let mut v = Vec::with_capacity(3);
    if t.auth == SshAuthKind::Agent || (agent_available && has_key) {
        v.push(AuthStep::Agent);
    }
    if has_key {
        v.push(AuthStep::Key);
    }
    if t.auth == SshAuthKind::Password {
        v.push(AuthStep::Password);
    }
    if t.auth == SshAuthKind::KeyboardInteractive {
        v.push(AuthStep::KeyboardInteractive);
    }
    v
}

/// 已完成撥號與認證的連線。`closed` 在連線結束時變成 `Some(原因)`。
pub struct Connected {
    pub handle: client::Handle<DbkHandler>,
    pub closed: watch::Receiver<Option<String>>,
}

/// 一個步驟的結果。
enum StepOutcome {
    Success,
    /// 這一步根本沒送到伺服器（agent 不在、金鑰讀不到…）。
    Skipped(String),
    /// 伺服器拒絕；`partial` = 憑證被接受但還要再一種。
    Failed { remaining: MethodSet, partial: bool },
}

/// 撥號 + host key + 認證。`conn_id` 只用來標記發給 UI 的提示。
pub async fn connect_and_auth(
    t: &SshTarget,
    conn_id: &str,
    ui: Arc<dyn AuthUi>,
    store: KnownHostsStore,
) -> AppResult<Connected> {
    if t.host.trim().is_empty() {
        return Err(AppError::Ssh(t!("未填寫 SSH 主機").into()));
    }
    if t.username.trim().is_empty() {
        return Err(AppError::Ssh(t!("未填寫 SSH 使用者名稱").into()));
    }

    let config = Arc::new(client::Config {
        keepalive_interval: (t.term.keepalive_secs > 0)
            .then(|| Duration::from_secs(u64::from(t.term.keepalive_secs))),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let hostkey_error = Arc::new(parking_lot::Mutex::new(None));
    let prompting = Arc::new(AtomicBool::new(false));
    let (closed_tx, closed_rx) = watch::channel(None);
    let handler = DbkHandler {
        conn_id: conn_id.to_string(),
        host_id: t.host_id(),
        store,
        ui: ui.clone(),
        hostkey_error: hostkey_error.clone(),
        prompting: prompting.clone(),
        closed: closed_tx,
    };

    // 1. 撥號（TCP + banner + KEX + host key）。預算只計「沒在等對話框」的時間：
    //    host key 提示擋在 russh 的 event loop 裡，使用者想多久都不該被算成逾時。
    let connect = client::connect(config, (t.host.as_str(), t.port), handler);
    tokio::pin!(connect);
    let budget = t.connect_timeout();
    let mut spent = Duration::ZERO;
    let dialed = loop {
        tokio::select! {
            r = &mut connect => break r,
            _ = tokio::time::sleep(DIAL_TICK) => {
                if !prompting.load(Ordering::Relaxed) {
                    spent += DIAL_TICK;
                    if spent >= budget {
                        return Err(AppError::Ssh(t!("SSH 連線逾時").into()));
                    }
                }
            }
        }
    };
    let mut handle = match dialed {
        Ok(h) => h,
        Err(e) => {
            // host key 被拒時 russh 只回籠統的 UnknownKey；換成 handler 記下的精確原因。
            if let Some(err) = hostkey_error.lock().take() {
                return Err(err);
            }
            return Err(AppError::Ssh(tf!("SSH 連線失敗：{e}", e = e)));
        }
    };

    // 2. 認證。
    let has_key = !t.private_key_path.trim().is_empty();
    let mut agent = if t.auth == SshAuthKind::Agent || has_key {
        match connect_agent().await {
            Ok(a) => Some(a),
            Err(e) => {
                if t.auth == SshAuthKind::Agent {
                    eprintln!("[ssh] 無法連接 ssh-agent：{e}");
                }
                None
            }
        }
    } else {
        None
    };
    // RSA 金鑰用伺服器支援的最佳 hash（rsa-sha2-512 / 256）；OpenSSH ≥ 8.8 預設拒絕 SHA-1 的 ssh-rsa。
    let rsa_hash: Option<HashAlg> =
        match tokio::time::timeout(Duration::from_secs(3), handle.best_supported_rsa_hash()).await {
            Ok(Ok(h)) => h.flatten(),
            _ => None,
        };

    let mut steps = plan_auth(t, agent.is_some());
    let mut ki_planned = steps.contains(&AuthStep::KeyboardInteractive);
    let mut rejected: Vec<&'static str> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut partial = false;
    let mut i = 0;
    while i < steps.len() {
        let step = steps[i];
        i += 1;
        let outcome = match step {
            AuthStep::Agent => step_agent(&mut handle, t, agent.as_mut(), rsa_hash).await?,
            AuthStep::Key => step_key(&mut handle, t, conn_id, ui.as_ref(), rsa_hash).await?,
            AuthStep::Password => step_password(&mut handle, t, conn_id, ui.as_ref()).await?,
            AuthStep::KeyboardInteractive => {
                step_keyboard_interactive(&mut handle, t, conn_id, ui.as_ref()).await?
            }
        };
        match outcome {
            StepOutcome::Success => return Ok(Connected { handle, closed: closed_rx }),
            StepOutcome::Skipped(reason) => {
                eprintln!("[ssh] 略過 {} 認證：{reason}", step.label());
                skipped.push(format!("{}：{reason}", step.label()));
            }
            StepOutcome::Failed { remaining, partial: p } => {
                rejected.push(step.label());
                partial |= p;
                // 伺服器點名 keyboard-interactive（PAM / OTP）而我們沒排它 → 補在最後，只補一次。
                if !ki_planned && ui.can_prompt() && remaining.contains(&MethodKind::KeyboardInteractive)
                {
                    steps.push(AuthStep::KeyboardInteractive);
                    ki_planned = true;
                }
            }
        }
    }

    let detail = if rejected.is_empty() {
        if skipped.is_empty() {
            t!("沒有可用的認證方式").to_string()
        } else {
            tf!("沒有可用的認證方式（{detail}）", detail = skipped.join("；"))
        }
    } else if partial {
        tf!(
            "伺服器接受了 {methods} 但要求進一步認證",
            methods = rejected.join(" / ")
        )
    } else {
        tf!(
            "伺服器拒絕了 {methods} 認證（帳號 / 密碼 / 金鑰不正確）",
            methods = rejected.join(" / ")
        )
    };
    // 有步驟被拒、也有步驟根本沒送出（例如私鑰密語不對、金鑰庫找不到）：兩者都講，
    // 否則使用者只看到「密碼被拒」，不知道其實是私鑰那一步沒成行。
    let detail = if !rejected.is_empty() && !skipped.is_empty() {
        tf!("{detail}；另外略過：{skipped}", detail = detail, skipped = skipped.join("；"))
    } else {
        detail
    };
    Err(AppError::SshAuth(detail))
}

fn map_auth_result(r: AuthResult) -> StepOutcome {
    match r {
        AuthResult::Success => StepOutcome::Success,
        AuthResult::Failure { remaining_methods, partial_success } => StepOutcome::Failed {
            remaining: remaining_methods,
            partial: partial_success,
        },
    }
}

/// 把 russh 的傳輸錯誤 / 逾時包成 AppError（伺服器「拒絕」不走這裡，那是 `StepOutcome::Failed`）。
async fn timed<F, T, E>(fut: F) -> AppResult<T>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    match tokio::time::timeout(AUTH_STEP_TIMEOUT, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(AppError::Ssh(tf!("SSH 認證失敗：{e}", e = e))),
        Err(_) => Err(AppError::Ssh(t!("SSH 認證逾時").into())),
    }
}

/// ssh-agent：逐把試——一般公鑰，以及 agent 裡的 OpenSSH 憑證（`ssh-add` 時私鑰旁邊有 `-cert.pub`
/// 就會一起載入）。
async fn step_agent(
    handle: &mut client::Handle<DbkHandler>,
    t: &SshTarget,
    agent: Option<&mut DynAgent>,
    rsa_hash: Option<HashAlg>,
) -> AppResult<StepOutcome> {
    let Some(agent) = agent else {
        return Ok(StepOutcome::Skipped(t!("找不到 ssh-agent").to_string()));
    };
    let ids = match agent.request_identities().await {
        Ok(v) => v,
        Err(e) => {
            return Ok(StepOutcome::Skipped(tf!("ssh-agent 讀取金鑰清單失敗：{e}", e = e)));
        }
    };
    let mut last: Option<StepOutcome> = None;
    for id in ids {
        let r = match id {
            AgentIdentity::PublicKey { key, .. } => {
                let hash = if key.algorithm().is_rsa() { rsa_hash } else { None };
                tokio::time::timeout(
                    AUTH_STEP_TIMEOUT,
                    handle.authenticate_publickey_with(t.username.clone(), key, hash, agent),
                )
                .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                let hash = if certificate.algorithm().is_rsa() { rsa_hash } else { None };
                tokio::time::timeout(
                    AUTH_STEP_TIMEOUT,
                    handle.authenticate_certificate_with(t.username.clone(), certificate, hash, agent),
                )
                .await
            }
        };
        match r {
            Ok(Ok(AuthResult::Success)) => return Ok(StepOutcome::Success),
            Ok(Ok(fail)) => {
                let o = map_auth_result(fail);
                // 憑證被接受但還要再一種（金鑰 + OTP）：不必再試其他把。
                let stop = matches!(o, StepOutcome::Failed { partial: true, .. });
                last = Some(o);
                if stop {
                    break;
                }
            }
            Ok(Err(e)) => {
                // 單把簽章失敗（agent 拒簽 / 金鑰鎖住）：記錄後試下一把。
                eprintln!("[ssh] ssh-agent 簽章失敗：{e}");
            }
            Err(_) => return Err(AppError::Ssh(t!("SSH 認證逾時").into())),
        }
    }
    Ok(last.unwrap_or_else(|| StepOutcome::Skipped(t!("ssh-agent 沒有任何金鑰").to_string())))
}

/// 私鑰（檔案，或金鑰庫的 `keystore:<id>`）。讀不到、格式不能用 → 略過並說明原因；受密語保護 →
/// 先用存的密語，沒存或不對就問（最多三次，與 OpenSSH 相同）。
///
/// 有 OpenSSH 憑證（主機指定，或私鑰旁邊的 `<私鑰>-cert.pub`）就先用憑證試，伺服器不收（CA 不受信任、
/// 主體不符、過期）再用金鑰本身試——順序與 OpenSSH 一致。
async fn step_key(
    handle: &mut client::Handle<DbkHandler>,
    t: &SshTarget,
    conn_id: &str,
    ui: &dyn AuthUi,
    rsa_hash: Option<HashAlg>,
) -> AppResult<StepOutcome> {
    let shown = t.private_key_path.trim();
    let path = match keys::resolve_key_path(shown) {
        Ok(p) => p,
        Err(e) => return Ok(StepOutcome::Skipped(e.message())),
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => return Ok(StepOutcome::Skipped(tf!("讀取 SSH 私鑰失敗：{e}", e = e))),
    };
    let mut pass: Option<String> = (!t.passphrase.is_empty()).then(|| t.passphrase.clone());
    let mut asked = 0;
    let key = loop {
        match keys::load_private_key(&bytes, pass.as_deref()) {
            Ok((k, _, _)) => break k,
            Err(e @ (KeyError::NeedPassphrase | KeyError::BadPassphrase(_))) if ui.can_prompt() && asked < 3 => {
                asked += 1;
                let instructions = if matches!(e, KeyError::NeedPassphrase) {
                    tf!("私鑰 {path} 受密語保護", path = shown)
                } else {
                    tf!("密語不正確，請再輸入一次（{path}）", path = shown)
                };
                let answers = ui
                    .prompt(AuthPrompt {
                        conn_id: conn_id.to_string(),
                        kind: AuthPromptKind::Passphrase,
                        name: String::new(),
                        instructions,
                        prompts: vec![PromptItem { prompt: t!("私鑰密語").to_string(), echo: false }],
                    })
                    .await;
                let Some(answers) = answers else {
                    return Err(AppError::SshCancelled);
                };
                pass = Some(answers.into_iter().next().unwrap_or_default());
            }
            Err(e) => return Ok(StepOutcome::Skipped(tf!("讀取 SSH 私鑰失敗：{e}", e = e.message()))),
        }
    };
    match keys::find_certificate(&path, &t.certificate_path) {
        Ok(Some((cpath, cert))) if cert.public_key() == key.public_key().key_data() => {
            let r = timed(handle.authenticate_openssh_cert(t.username.clone(), Arc::new(key.clone()), cert)).await?;
            match map_auth_result(r) {
                StepOutcome::Failed { partial: false, .. } => {
                    eprintln!("[ssh] 伺服器不接受憑證 {}，改用金鑰本身", cpath.display());
                }
                o => return Ok(o),
            }
        }
        Ok(Some((cpath, _))) => eprintln!("[ssh] 憑證 {} 簽的不是這把私鑰，略過", cpath.display()),
        Ok(None) => {}
        Err(e) => eprintln!("[ssh] {}", e.message()),
    }
    // 非 RSA 金鑰 `new` 會自行忽略 hash。
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash);
    let r = timed(handle.authenticate_publickey(t.username.clone(), key)).await?;
    Ok(map_auth_result(r))
}

/// 密碼：沒存 → 問一次（不能問就送空密碼，維持舊版 tunnel 行為）。
async fn step_password(
    handle: &mut client::Handle<DbkHandler>,
    t: &SshTarget,
    conn_id: &str,
    ui: &dyn AuthUi,
) -> AppResult<StepOutcome> {
    let password = if !t.password.is_empty() {
        t.password.clone()
    } else if ui.can_prompt() {
        let answers = ui
            .prompt(AuthPrompt {
                conn_id: conn_id.to_string(),
                kind: AuthPromptKind::Password,
                name: String::new(),
                instructions: tf!("請輸入 {label} 的密碼", label = t.label()),
                prompts: vec![PromptItem { prompt: t!("密碼").to_string(), echo: false }],
            })
            .await;
        let Some(answers) = answers else {
            return Err(AppError::SshCancelled);
        };
        answers.into_iter().next().unwrap_or_default()
    } else {
        String::new()
    };
    let r = timed(handle.authenticate_password(t.username.clone(), password)).await?;
    Ok(map_auth_result(r))
}

/// keyboard-interactive：伺服器出題 → 問使用者 → 回答，直到成功 / 失敗。
///
/// 伺服器只出一題不回顯（典型的 PAM 密碼）且我們有存密碼時，先自動填一次——
/// 不少主機關掉 `PasswordAuthentication` 只留 KI，使用者存了密碼就該直接進得去。
async fn step_keyboard_interactive(
    handle: &mut client::Handle<DbkHandler>,
    t: &SshTarget,
    conn_id: &str,
    ui: &dyn AuthUi,
) -> AppResult<StepOutcome> {
    let mut resp =
        timed(handle.authenticate_keyboard_interactive_start(t.username.clone(), None::<String>))
            .await?;
    let mut auto_password_used = false;
    loop {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(StepOutcome::Success),
            KeyboardInteractiveAuthResponse::Failure { remaining_methods, partial_success } => {
                return Ok(StepOutcome::Failed {
                    remaining: remaining_methods,
                    partial: partial_success,
                });
            }
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if prompts.len() == 1
                    && !prompts[0].echo
                    && !t.password.is_empty()
                    && !auto_password_used
                {
                    auto_password_used = true;
                    vec![t.password.clone()]
                } else if !ui.can_prompt() {
                    return Ok(StepOutcome::Skipped(
                        t!("伺服器要求互動輸入，但目前模式無法詢問使用者").to_string(),
                    ));
                } else {
                    let q = AuthPrompt {
                        conn_id: conn_id.to_string(),
                        kind: AuthPromptKind::KeyboardInteractive,
                        name,
                        instructions,
                        prompts: prompts
                            .into_iter()
                            .map(|p| PromptItem { prompt: p.prompt, echo: p.echo })
                            .collect(),
                    };
                    let n = q.prompts.len();
                    let Some(mut a) = ui.prompt(q).await else {
                        return Err(AppError::SshCancelled);
                    };
                    // 答案數必須與題數一致，否則伺服器會直接判失敗。
                    a.resize(n, String::new());
                    a
                };
                resp = timed(handle.authenticate_keyboard_interactive_respond(answers)).await?;
            }
        }
    }
}

// ---- ssh-agent ----

/// 各平台 agent 連線統一成同一型別，`plan_auth` / `step_agent` 不必知道底下是 socket、named pipe 還是 Pageant。
pub type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

/// Unix：`SSH_AUTH_SOCK`。
#[cfg(unix)]
pub async fn connect_agent() -> Result<DynAgent, String> {
    AgentClient::connect_env().await.map(|c| c.dynamic()).map_err(|e| e.to_string())
}

/// Windows：先 OpenSSH agent 的 named pipe，再 Pageant。
///
/// `connect_named_pipe` 遇到 `ERROR_PIPE_BUSY` 會無限重試，故包 3 秒逾時；
/// 兩者都不在就回錯，由呼叫端 fall through 到下一個認證步驟。
#[cfg(windows)]
pub async fn connect_agent() -> Result<DynAgent, String> {
    const PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
    let pipe_err = match tokio::time::timeout(
        Duration::from_secs(3),
        AgentClient::connect_named_pipe(PIPE),
    )
    .await
    {
        Ok(Ok(c)) => return Ok(c.dynamic()),
        Ok(Err(e)) => e.to_string(),
        Err(_) => t!("等待 OpenSSH agent named pipe 逾時").to_string(),
    };
    match AgentClient::connect_pageant().await {
        Ok(c) => Ok(c.dynamic()),
        Err(e) => Err(tf!("OpenSSH agent：{a}；Pageant：{b}", a = pipe_err, b = e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbKind;
    use std::path::PathBuf;

    fn target(auth: SshAuthKind, key: &str) -> SshTarget {
        SshTarget {
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth,
            password: String::new(),
            private_key_path: key.into(),
            certificate_path: String::new(),
            passphrase: String::new(),
            term: SshTermOptions::default(),
            origin: TargetOrigin::AdHoc,
        }
    }

    #[test]
    fn plan_auth_orders_steps() {
        use AuthStep::*;
        assert_eq!(plan_auth(&target(SshAuthKind::Password, ""), false), vec![Password]);
        assert_eq!(plan_auth(&target(SshAuthKind::Password, ""), true), vec![Password]);
        assert_eq!(plan_auth(&target(SshAuthKind::Key, "k"), false), vec![Key]);
        assert_eq!(plan_auth(&target(SshAuthKind::Key, "k"), true), vec![Agent, Key]);
        assert_eq!(plan_auth(&target(SshAuthKind::Key, "  "), false), vec![], "沒有金鑰路徑 = 無步驟");
        assert_eq!(plan_auth(&target(SshAuthKind::Agent, ""), false), vec![Agent]);
        assert_eq!(plan_auth(&target(SshAuthKind::Agent, "k"), true), vec![Agent, Key]);
        assert_eq!(
            plan_auth(&target(SshAuthKind::KeyboardInteractive, ""), true),
            vec![KeyboardInteractive]
        );
        assert_eq!(
            plan_auth(&target(SshAuthKind::Password, "k"), true),
            vec![Agent, Key, Password]
        );
    }

    fn conn() -> ConnectionConfig {
        ConnectionConfig {
            id: "c1".into(),
            name: "c1".into(),
            kind: DbKind::Mysql,
            host: "db".into(),
            port: 3306,
            username: "root".into(),
            password: String::new(),
            database: None,
            max_connections: 5,
            ssh_enabled: true,
            ssh_host: " bastion ".into(),
            ssh_port: 0,
            ssh_username: "ops".into(),
            ssh_auth_method: SshAuthMethod::Key,
            ssh_password: String::new(),
            ssh_private_key_path: "/k".into(),
            ssh_passphrase: "pp".into(),
            options: Default::default(),
            otp_secret: String::new(),
        }
    }

    #[test]
    fn from_connection_maps_fields() {
        let t = SshTarget::from_connection(&conn()).unwrap();
        assert_eq!(t.host, "bastion");
        assert_eq!(t.port, 22, "0 → 22");
        assert_eq!(t.username, "ops");
        assert_eq!(t.auth, SshAuthKind::Key);
        assert_eq!(t.private_key_path, "/k");
        assert_eq!(t.passphrase, "pp");
        assert_eq!(t.host_id(), "bastion:22");
        assert_eq!(t.label(), "ops@bastion");
        assert_eq!(t.origin, TargetOrigin::Connection("c1".into()));
        assert_eq!(t.connect_timeout(), SSH_DIAL_TIMEOUT);

        let mut c = conn();
        c.ssh_auth_method = SshAuthMethod::Password;
        c.ssh_port = 2222;
        let t = SshTarget::from_connection(&c).unwrap();
        assert_eq!(t.auth, SshAuthKind::Password);
        assert_eq!(t.port, 2222);

        let mut c = conn();
        c.ssh_enabled = false;
        assert!(matches!(SshTarget::from_connection(&c), Err(AppError::Ssh(_))));
        let mut c = conn();
        c.ssh_host = "  ".into();
        assert!(matches!(SshTarget::from_connection(&c), Err(AppError::Ssh(_))));
    }

    #[test]
    fn from_session_uses_options_and_secrets() {
        let mut s = SshSession {
            id: "s1".into(),
            name: "web".into(),
            host: "web.example".into(),
            port: 0,
            username: "deploy".into(),
            auth: SshAuthKind::Password,
            private_key_path: String::new(),
            certificate_path: String::new(),
            folder_id: None,
            options: SshTermOptions::default(),
        };
        s.options.connect_timeout_secs = 5;
        let t = SshTarget::from_session(&s, Some("pw".into()), None);
        assert_eq!(t.port, 22);
        assert_eq!(t.password, "pw");
        assert_eq!(t.passphrase, "");
        assert_eq!(t.connect_timeout(), Duration::from_secs(5));
        assert_eq!(t.origin, TargetOrigin::Session("s1".into()));
    }

    #[test]
    fn target_ref_deserializes_tagged() {
        let r: SshTargetRef = serde_json::from_str(r#"{"kind":"session","id":"s1"}"#).unwrap();
        assert!(matches!(r, SshTargetRef::Session { id } if id == "s1"));
        let r: SshTargetRef = serde_json::from_str(r#"{"kind":"connection","id":"c1"}"#).unwrap();
        assert!(matches!(r, SshTargetRef::Connection { id } if id == "c1"));
        let r: SshTargetRef = serde_json::from_str(
            r#"{"kind":"ad_hoc","session":{"id":"x","host":"h"},"password":"p"}"#,
        )
        .unwrap();
        match r {
            SshTargetRef::AdHoc { session, password, passphrase } => {
                assert_eq!(session.host, "h");
                assert_eq!(password.as_deref(), Some("p"));
                assert_eq!(passphrase, None);
            }
            _ => panic!("ad_hoc"),
        }
        let d: HostKeyDecision = serde_json::from_str("\"accept_save\"").unwrap();
        assert_eq!(d, HostKeyDecision::AcceptSave);
    }

    // ---- host key 判定 ----

    fn tmp_store() -> KnownHostsStore {
        let d = std::env::temp_dir().join(format!("dbkit-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        KnownHostsStore::at(d.join("ssh_known_hosts.json"))
    }

    /// 固定答案的 UI，順便記錄有沒有被問。
    struct FixedUi {
        answer: HostKeyDecision,
        asked: std::sync::Mutex<Vec<HostKeyStatus>>,
    }

    impl FixedUi {
        fn new(answer: HostKeyDecision) -> Arc<Self> {
            Arc::new(Self { answer, asked: std::sync::Mutex::new(Vec::new()) })
        }
    }

    #[async_trait]
    impl AuthUi for FixedUi {
        async fn host_key(&self, q: HostKeyQuestion) -> HostKeyDecision {
            self.asked.lock().unwrap().push(q.status);
            self.answer
        }
        async fn prompt(&self, _q: AuthPrompt) -> Option<Vec<String>> {
            None
        }
    }

    async fn decide(store: &KnownHostsStore, fp: &str, ui: &dyn AuthUi) -> AppResult<()> {
        decide_host_key(store, "c", "h:22", "ssh-ed25519", fp, ui).await
    }

    #[tokio::test]
    async fn silent_ui_is_tofu_and_rejects_changes() {
        let store = tmp_store();
        decide(&store, "SHA256:a", &SilentUi).await.unwrap();
        assert_eq!(store.check("h:22", "SHA256:a").unwrap(), HostKeyStatus::Known, "TOFU 記住");
        decide(&store, "SHA256:a", &SilentUi).await.unwrap();
        let err = decide(&store, "SHA256:b", &SilentUi).await.unwrap_err();
        assert!(matches!(err, AppError::SshHostKey(_)), "{err:?}");
        assert_eq!(store.check("h:22", "SHA256:a").unwrap(), HostKeyStatus::Known, "拒絕時不覆寫");
    }

    #[tokio::test]
    async fn interactive_ui_accept_once_does_not_persist() {
        let store = tmp_store();
        let ui = FixedUi::new(HostKeyDecision::AcceptOnce);
        decide(&store, "SHA256:a", ui.as_ref()).await.unwrap();
        assert_eq!(store.check("h:22", "SHA256:a").unwrap(), HostKeyStatus::New, "只放行這次");
        assert_eq!(ui.asked.lock().unwrap().as_slice(), &[HostKeyStatus::New]);
    }

    #[tokio::test]
    async fn interactive_ui_accept_save_overwrites_changed() {
        let store = tmp_store();
        store.record("h:22", "SHA256:old").unwrap();
        let ui = FixedUi::new(HostKeyDecision::AcceptSave);
        decide(&store, "SHA256:new", ui.as_ref()).await.unwrap();
        assert_eq!(store.check("h:22", "SHA256:new").unwrap(), HostKeyStatus::Known);
        assert_eq!(
            ui.asked.lock().unwrap().as_slice(),
            &[HostKeyStatus::Changed { old: "SHA256:old".into() }]
        );
        // 已知的不會再問
        decide(&store, "SHA256:new", ui.as_ref()).await.unwrap();
        assert_eq!(ui.asked.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn interactive_reject_is_cancelled() {
        let store = tmp_store();
        let ui = FixedUi::new(HostKeyDecision::Reject);
        let err = decide(&store, "SHA256:a", ui.as_ref()).await.unwrap_err();
        assert!(matches!(err, AppError::SshCancelled), "{err:?}");
    }

    /// known_hosts 損毀：不問、不信、直接拒絕（fail-closed）。
    #[tokio::test]
    async fn corrupt_known_hosts_fails_closed_without_asking() {
        let d = std::env::temp_dir().join(format!("dbkit-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let p: PathBuf = d.join("ssh_known_hosts.json");
        std::fs::write(&p, b"garbage").unwrap();
        let store = KnownHostsStore::at(p);
        let ui = FixedUi::new(HostKeyDecision::AcceptSave);
        let err = decide(&store, "SHA256:a", ui.as_ref()).await.unwrap_err();
        assert!(matches!(err, AppError::SshHostKey(_)), "{err:?}");
        assert!(ui.asked.lock().unwrap().is_empty(), "讀不到清單就不該問使用者");
    }
}
