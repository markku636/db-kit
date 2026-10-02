//! FTP / FTPS 客戶端（suppaftp 12，tokio + rustls/ring）：檔案面板的 FTP 主機。
//!
//! 與 SFTP 共用前端的檔案面板與 `ssh_sftp_*` 命令（`FileClient` 分派），這裡只管協定本身。
//!
//! 連線模型：
//! - 一條「瀏覽」控制連線（`FtpClient::browse`）負責列目錄、改名、刪除、預覽。閒置一陣子之後先 `NOOP`
//!   探一下，被伺服器踢掉就在下一個操作前自動重連（密碼與信任過的憑證都還在記憶體裡）。
//! - 每個傳輸工作另開自己的控制連線（`FtpClient::transfer_session`），傳大檔時照樣可以瀏覽。同時開的
//!   傳輸連線有上限（`MAX_TRANSFER_SESSIONS`），多的排隊，免得踩到伺服器「每個 IP 幾條連線」的限制。
//!   取消時直接丟掉那條連線，不必等伺服器回 `ABOR`。
//!
//! 斷點續傳與 SFTP 同一套語意（`OnConflict::Resume`、本機 `.part`、比對結尾 `RESUME_VERIFY`）：
//! - 下載：`REST <offset>` + `RETR`。從 `.part` 結尾往前一段開始要，先收到的那一段與 `.part` 的結尾比對，
//!   對得上就在同一條資料連線上接著收——不必為了比對多開一次連線。
//! - 上傳：`REST` + `RETR` 讀遠端已有部分的結尾比對，對得上就 `APPE` 接著寫。
//!   伺服器不支援 `REST`（回 5xx）時退回從頭傳。
//!
//! FTPS 憑證：先照 OS 憑證庫驗；不在信任鏈上（自簽、內網 CA、用 IP 連）時，把憑證的 SHA-256 指紋
//! 交給 host key 對話框讓使用者決定（TOFU），記在 known_hosts 的 `ftps://host:port`，之後指紋變了會警告。
//! 資料連線用同一份 TLS 設定，所以也走同一個指紋，並共用 session cache（伺服器常要求資料連線沿用
//! 控制連線的 TLS session）。

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine as _;
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};
use suppaftp::list::{File as ListFile, FileType as ListFileType, ListParser};
use suppaftp::tokio::{AsyncRustlsConnector, AsyncRustlsFtpStream};
use suppaftp::types::FileType;
use suppaftp::{FtpError, Mode, Status};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_rustls::rustls;

use super::auth::{decide_host_key, AuthPrompt, AuthPromptKind, AuthUi, PromptItem, TargetOrigin};
use super::known_hosts::KnownHostsStore;
use super::runtime::SshConnInfo;
use super::sessions::{FtpOptions, FtpTls, SshSession};
use super::sftp::{
    basename, decode_text, is_root_like, mode_string, part_path, remote_join, resolve_local_target, resume_from,
    Kind, OnConflict, ProgressFn, RemoteFs, ResumeFrom, SftpEntry, SftpText, CANCEL_TICK, CHUNK, PROGRESS_EVERY,
    READ_SMALL_MAX, RESUME_VERIFY, WRITE_TEXT_MAX,
};
use crate::error::{AppError, AppResult};

type Ftp = AsyncRustlsFtpStream;

/// 單一 FTP 請求的逾時；傳輸中一段時間收不到 / 送不出資料也用這個值判定斷線。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 瀏覽連線閒置超過這麼久，下一個操作前先 `NOOP` 探一下（伺服器常在幾分鐘後踢掉閒置的連線）。
const IDLE_PROBE: Duration = Duration::from_secs(45);
/// `NOOP` 探測的逾時。
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 撥號的預設預算（主機設定的「連線逾時」為 0 時）。
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 主動模式等伺服器連回來的時間。
const ACTIVE_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// 登入失敗後重新問密碼的次數。
const MAX_PASSWORD_TRIES: usize = 3;
/// 列目錄時用 `CWD` 試探 symlink 目標是不是資料夾的上限（每個要一次來回）。
const SYMLINK_PROBE_MAX: usize = 64;
/// 同一台主機同時開的傳輸連線上限；多的排隊。
pub const MAX_TRANSFER_SESSIONS: usize = 2;
/// host key 對話框的「金鑰類型」欄。
const CERT_KEY_TYPE: &str = "X.509";

// ---- 連線目標 ----

/// 一次 FTP 連線需要的全部資料。密碼只活在記憶體。
#[derive(Debug, Clone)]
pub struct FtpTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub opts: FtpOptions,
    pub connect_timeout: Duration,
    pub origin: TargetOrigin,
    /// 使用者信任過的伺服器憑證指紋（不在信任鏈上時用）。`connect_and_login` 從 known_hosts 讀、
    /// 或問過使用者之後填上；之後的重連 / 傳輸連線都認這一顆。
    pub pinned_cert: Option<String>,
}

impl FtpTarget {
    /// 從已存主機組目標；密碼由呼叫端從 keychain（或對話框）補上。
    pub fn from_session(s: &SshSession, password: Option<String>) -> Self {
        let port = match s.port {
            0 if s.ftp.tls == FtpTls::Implicit => 990,
            0 => 21,
            p => p,
        };
        Self {
            host: s.host.trim().to_string(),
            port,
            username: s.username.trim().to_string(),
            password: password.unwrap_or_default(),
            opts: s.ftp,
            connect_timeout: match s.options.connect_timeout_secs {
                0 => DEFAULT_CONNECT_TIMEOUT,
                n => Duration::from_secs(u64::from(n)),
            },
            origin: TargetOrigin::Session(s.id.clone()),
            pinned_cert: None,
        }
    }

    /// 登入用的帳號：沒填 = 匿名。
    pub fn user(&self) -> &str {
        if self.username.is_empty() {
            "anonymous"
        } else {
            &self.username
        }
    }

    /// 匿名登入（`anonymous` / `ftp`）不必問密碼；密碼欄照慣例送一個 email 樣式的字串。
    pub fn is_anonymous(&self) -> bool {
        self.user().eq_ignore_ascii_case("anonymous") || self.user().eq_ignore_ascii_case("ftp")
    }

    fn login_password(&self) -> &str {
        if self.password.is_empty() && self.is_anonymous() {
            "anonymous@"
        } else {
            &self.password
        }
    }

    /// 顯示用 `user@host`。
    pub fn label(&self) -> String {
        format!("{}@{}", self.user(), self.host)
    }

    /// known_hosts 的鍵：與 SSH 的 `host:port` 分開（同一台機器 22 / 21 埠可能都有）。
    pub fn cert_host_id(&self) -> String {
        format!("ftps://{}:{}", self.host, self.port)
    }

    fn secure(&self) -> bool {
        self.opts.tls != FtpTls::None
    }
}

// ---- TLS ----

/// OS 憑證庫（第一次用到才載；Windows 上讀一次要一點時間）。讀不到的憑證略過。
static NATIVE_ROOTS: Lazy<Arc<rustls::RootCertStore>> = Lazy::new(|| {
    let mut roots = rustls::RootCertStore::empty();
    for c in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(c);
    }
    Arc::new(roots)
});

/// 憑證指紋：`SHA256:<base64>`，與 SSH host key 指紋同一種寫法。
pub fn cert_fingerprint(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest))
}

/// 先照信任鏈驗；不過的話，指紋等於使用者信任過的那顆也放行。拒絕時把指紋留給呼叫端去問使用者。
#[derive(Debug)]
struct PinningVerifier {
    webpki: Option<Arc<rustls::client::WebPkiServerVerifier>>,
    pinned: Option<String>,
    /// 被拒絕的伺服器憑證指紋（只在拒絕時寫）。
    rejected: Arc<parking_lot::Mutex<Option<String>>>,
    algs: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl rustls::client::danger::ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let fp = cert_fingerprint(end_entity.as_ref());
        if self.pinned.as_deref() == Some(fp.as_str()) {
            return Ok(rustls::client::danger::ServerCertVerified::assertion());
        }
        let r = match &self.webpki {
            Some(v) => v.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now),
            None => Err(rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)),
        };
        if r.is_err() {
            *self.rejected.lock() = Some(fp);
        }
        r
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// 一條連線（控制 + 它的資料連線）用的 TLS connector，與「被拒絕的指紋」的回報槽。
fn tls_connector(pinned: Option<String>) -> AppResult<(AsyncRustlsConnector, Arc<parking_lot::Mutex<Option<String>>>)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    // OS 憑證庫是空的（極少見）→ 沒有信任鏈可驗，全部走指紋。
    let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(NATIVE_ROOTS.clone(), provider.clone())
        .build()
        .ok();
    let rejected = Arc::new(parking_lot::Mutex::new(None));
    let verifier = Arc::new(PinningVerifier {
        webpki,
        pinned,
        rejected: rejected.clone(),
        algs: provider.signature_verification_algorithms,
    });
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::Ftp(tf!("TLS 設定錯誤：{e}", e = e)))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    Ok((AsyncRustlsConnector::from(connector), rejected))
}

// ---- 撥號與登入 ----

/// 伺服器宣告的功能（`FEAT`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Feats {
    /// `MLST` / `MLSD`：機器可讀的列表（大小、時間、權限都精確），沒有才退回解析 `LIST`。
    mlsd: bool,
}

/// `open_stream` 失敗的原因：需要問使用者的兩種單獨分出來。
#[derive(Debug)]
enum OpenError {
    /// 憑證不在信任鏈上、也不是信任過的那顆（附指紋）。
    CertUntrusted(String),
    /// 帳號密碼被拒（附伺服器的訊息）。
    Auth(String),
    Other(AppError),
}

impl From<AppError> for OpenError {
    fn from(e: AppError) -> Self {
        OpenError::Other(e)
    }
}

impl OpenError {
    /// 沒有人可以問（重連 / 傳輸連線）時的錯誤。
    fn into_app(self, t: &FtpTarget) -> AppError {
        match self {
            OpenError::CertUntrusted(_) => AppError::Ftp(tf!(
                "{host} 的 TLS 憑證與先前信任的不同，已拒絕連線",
                host = t.cert_host_id()
            )),
            OpenError::Auth(m) => AppError::Ftp(tf!("登入失敗：{msg}", msg = m)),
            OpenError::Other(e) => e,
        }
    }
}

/// 在 `budget` 內完成，否則回「連線逾時」。
async fn within<T>(budget: Duration, fut: impl std::future::Future<Output = Result<T, OpenError>>) -> Result<T, OpenError> {
    tokio::time::timeout(budget, fut)
        .await
        .unwrap_or_else(|_| Err(OpenError::Other(AppError::Ftp(t!("連線逾時").into()))))
}

/// 撥號 +（FTPS）TLS + 登入 + 傳輸設定。不發問：密碼與信任的憑證都已在 `t` 裡。
async fn open_stream(t: &FtpTarget) -> Result<(Ftp, Feats), OpenError> {
    let addr: SocketAddr = within(t.connect_timeout, async {
        tokio::net::lookup_host((t.host.as_str(), t.port))
            .await
            .map_err(|e| AppError::Ftp(tf!("找不到主機 {host}：{e}", host = t.host, e = e)))?
            .next()
            .ok_or_else(|| OpenError::Other(AppError::Ftp(tf!("找不到主機 {host}", host = t.host))))
    })
    .await?;
    let tls = if t.secure() { Some(tls_connector(t.pinned_cert.clone())?) } else { None };
    // TLS 握手失敗時，若是憑證被拒就回 `CertUntrusted`（呼叫端會去問使用者），其餘照一般錯誤。
    let tls_fail = |e: FtpError, rejected: &Arc<parking_lot::Mutex<Option<String>>>| match rejected.lock().take() {
        Some(fp) => OpenError::CertUntrusted(fp),
        None => OpenError::Other(map_err(e)),
    };
    let mut ftp = within(t.connect_timeout, async move {
        match (t.opts.tls, tls) {
            (FtpTls::Implicit, Some((connector, rejected))) => {
                Ftp::connect_secure_implicit(addr, connector, &t.host).await.map_err(|e| tls_fail(e, &rejected))
            }
            (tls_mode, tls) => {
                let tcp = tokio::net::TcpStream::connect(addr)
                    .await
                    .map_err(|e| AppError::Ftp(tf!("無法連線到 {host}：{e}", host = t.host, e = e)))?;
                let _ = tcp.set_nodelay(true);
                let ftp = Ftp::connect_with_stream(tcp).await.map_err(map_err)?;
                match (tls_mode, tls) {
                    (FtpTls::Explicit, Some((connector, rejected))) => {
                        ftp.into_secure(connector, &t.host).await.map_err(|e| match e {
                            // 伺服器不接受 AUTH TLS：說清楚，不要只丟一行 5xx。
                            FtpError::UnexpectedResponse(ref r) if r.status != Status::AuthOk && rejected.lock().is_none() => {
                                OpenError::Other(AppError::Ftp(tf!(
                                    "伺服器不支援 FTPS（AUTH TLS 被拒：{msg}）",
                                    msg = response_text(r)
                                )))
                            }
                            e => tls_fail(e, &rejected),
                        })
                    }
                    _ => Ok(ftp),
                }
            }
        }
    })
    .await?;
    if t.opts.active {
        ftp = ftp.active_mode(ACTIVE_ACCEPT_TIMEOUT);
    } else if addr.is_ipv6() {
        ftp.set_mode(Mode::ExtendedPassive);
    } else {
        // PASV 回的位址常是伺服器的內網 IP（NAT 後面）：一律改連控制連線的那個 IP。
        ftp.set_mode(Mode::Passive);
        ftp.set_passive_nat_workaround(true);
    }
    within(REQUEST_TIMEOUT, async move {
        match ftp.login(t.user(), t.login_password()).await {
            Ok(()) => {}
            Err(FtpError::UnexpectedResponse(r))
                if matches!(r.status, Status::NotLoggedIn | Status::InvalidCredentials | Status::LoginNeedAccount) =>
            {
                return Err(OpenError::Auth(response_text(&r)));
            }
            Err(e) => return Err(OpenError::Other(map_err(e))),
        }
        ftp.transfer_type(FileType::Binary).await.map_err(map_err)?;
        let mut feats = Feats::default();
        if let Ok(f) = ftp.feat().await {
            feats.mlsd = f.keys().any(|k| k.eq_ignore_ascii_case("MLST"));
            if f.keys().any(|k| k.eq_ignore_ascii_case("UTF8")) {
                // 有的伺服器要先打開才用 UTF-8 回檔名；不支援就算了。
                let _ = ftp.opts("UTF8", Some("ON")).await;
            }
        }
        Ok((ftp, feats))
    })
    .await
}

/// 問密碼（同 SSH 的密碼對話框）。`None` = 使用者取消。
async fn ask_password(t: &FtpTarget, conn_id: &str, ui: &dyn AuthUi) -> AppResult<String> {
    let answers = ui
        .prompt(AuthPrompt {
            conn_id: conn_id.to_string(),
            kind: AuthPromptKind::Password,
            name: String::new(),
            instructions: tf!("請輸入 {label} 的密碼", label = t.label()),
            prompts: vec![PromptItem { prompt: t!("密碼").to_string(), echo: false }],
        })
        .await
        .ok_or(AppError::SshCancelled)?;
    Ok(answers.into_iter().next().unwrap_or_default())
}

/// 第一次連線：需要時問密碼、問要不要信任憑證（同 SSH 的 host key 對話框）。
/// 回傳補好密碼 / 信任指紋的目標，與已經登入好的那條控制連線（交給第一個開的瀏覽工作階段用）。
pub async fn connect_and_login(
    t: &FtpTarget,
    conn_id: &str,
    ui: &dyn AuthUi,
    store: &KnownHostsStore,
) -> AppResult<(FtpTarget, FtpInitial)> {
    let mut t = t.clone();
    if t.secure() {
        // 讀不到 known_hosts 不在這裡擋：驗證失敗時 `decide_host_key` 會 fail-closed。
        t.pinned_cert = store.load().ok().and_then(|m| m.get(&t.cert_host_id()).cloned());
    }
    if t.password.is_empty() && !t.is_anonymous() && ui.can_prompt() {
        t.password = ask_password(&t, conn_id, ui).await?;
    }
    let mut password_tries = 0;
    loop {
        match open_stream(&t).await {
            Ok((ftp, feats)) => return Ok((t, FtpInitial { ftp, feats })),
            Err(OpenError::CertUntrusted(fp)) => {
                // 已經信任的這顆還是被拒（不該發生）：不要一直問下去。
                if t.pinned_cert.as_deref() == Some(fp.as_str()) {
                    return Err(OpenError::CertUntrusted(fp).into_app(&t));
                }
                decide_host_key(store, conn_id, &t.cert_host_id(), CERT_KEY_TYPE, &fp, ui).await?;
                t.pinned_cert = Some(fp);
            }
            Err(OpenError::Auth(msg)) => {
                password_tries += 1;
                if !ui.can_prompt() || password_tries > MAX_PASSWORD_TRIES {
                    return Err(AppError::Ftp(tf!("登入失敗：{msg}", msg = msg)));
                }
                t.password = ask_password(&t, conn_id, ui).await?;
            }
            Err(OpenError::Other(e)) => return Err(e),
        }
    }
}

/// `connect_and_login` 登入好的那條控制連線。
pub struct FtpInitial {
    ftp: Ftp,
    feats: Feats,
}

// ---- 登記簿裡的「連線」 ----

/// 一台已登入的 FTP 主機（`SshRuntime` 裡與 `SshConn` 並列）。FTP 沒有 SSH 那種多工的單一連線：
/// 這裡存的是重新撥號需要的資料，實際的控制連線由各個 `FtpSession` 自己開、自己關。
pub struct FtpConn {
    pub id: String,
    pub info: SshConnInfo,
    pub origin: TargetOrigin,
    pub target: Arc<FtpTarget>,
    /// 登入時那條控制連線：第一個開的瀏覽工作階段直接拿去用，不必再登入一次。
    initial: parking_lot::Mutex<Option<FtpInitial>>,
    /// 傳輸連線的名額（見 `MAX_TRANSFER_SESSIONS`）。
    slots: Arc<Semaphore>,
}

impl FtpConn {
    pub fn new(id: String, target: FtpTarget, initial: FtpInitial) -> Self {
        Self {
            info: SshConnInfo {
                conn_id: id.clone(),
                host: target.host.clone(),
                port: target.port,
                username: target.user().to_string(),
            },
            id,
            origin: target.origin.clone(),
            target: Arc::new(target),
            initial: parking_lot::Mutex::new(Some(initial)),
            slots: Arc::new(Semaphore::new(MAX_TRANSFER_SESSIONS)),
        }
    }
}

// ---- 一條控制連線 ----

struct Slot {
    ftp: Option<Ftp>,
    feats: Feats,
    last: Instant,
}

impl Slot {
    fn ftp(&mut self) -> &mut Ftp {
        self.ftp.as_mut().expect("FtpSession::ready 保證有連線")
    }
}

/// 一條 FTP 控制連線；一次只做一件事（FTP 本來就是這樣），斷了下一個操作前自動重連。
pub struct FtpSession {
    target: Arc<FtpTarget>,
    slot: tokio::sync::Mutex<Slot>,
    /// 傳輸連線佔用的名額，隨這條連線一起釋放。
    _permit: Option<OwnedSemaphorePermit>,
}

impl FtpSession {
    fn new(target: Arc<FtpTarget>, initial: Option<FtpInitial>, permit: Option<OwnedSemaphorePermit>) -> Self {
        let (ftp, feats) = match initial {
            Some(i) => (Some(i.ftp), i.feats),
            None => (None, Feats::default()),
        };
        Self { target, slot: tokio::sync::Mutex::new(Slot { ftp, feats, last: Instant::now() }), _permit: permit }
    }

    /// 拿到一條可用的連線：閒置太久先探一下，沒有（或探不到）就重連。
    async fn ready(&self) -> AppResult<tokio::sync::MutexGuard<'_, Slot>> {
        let mut g = self.slot.lock().await;
        if g.ftp.is_some() && g.last.elapsed() > IDLE_PROBE {
            let alive = matches!(tokio::time::timeout(PROBE_TIMEOUT, g.ftp().noop()).await, Ok(Ok(())));
            if !alive {
                g.ftp = None;
            }
        }
        if g.ftp.is_none() {
            let (ftp, feats) = open_stream(&self.target).await.map_err(|e| e.into_app(&self.target))?;
            g.ftp = Some(ftp);
            g.feats = feats;
        }
        g.last = Instant::now();
        Ok(g)
    }

    /// 送 `QUIT` 並關掉連線（不在乎伺服器怎麼回）。
    async fn quit(&self) {
        let mut g = self.slot.lock().await;
        if let Some(mut ftp) = g.ftp.take() {
            let _ = tokio::time::timeout(PROBE_TIMEOUT, ftp.quit()).await;
        }
    }

    // ---- 目錄 / 屬性 ----

    async fn pwd(&self) -> AppResult<String> {
        let mut g = self.ready().await?;
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().pwd()).await;
        let p = settle(&mut g, r)?;
        Ok(if p.is_empty() { "/".to_string() } else { p })
    }

    /// 列目錄（不含 `.` / `..`）：有 `MLSD` 用 `MLSD`，否則 `CWD` 進去再 `LIST`（不帶路徑參數，
    /// 名字有空白、開頭是 `-` 的資料夾也不會被伺服器當成 `ls` 的參數）。檔名是**不可信資料**，未驗證。
    async fn raw_list(&self, dir: &str) -> AppResult<Vec<Item>> {
        let mut g = self.ready().await?;
        if g.feats.mlsd {
            let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().mlsd(Some(dir))).await;
            let lines = settle(&mut g, r)?;
            return Ok(lines.iter().filter_map(|l| parse_mlsx_line(l)).collect());
        }
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().cwd(dir)).await;
        settle(&mut g, r)?;
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().list(None)).await;
        let lines = settle(&mut g, r)?;
        Ok(lines.iter().filter_map(|l| parse_list_line(l)).collect())
    }

    /// 能不能 `CWD` 進去（symlink 指的是不是資料夾）。
    async fn is_dir(&self, path: &str) -> bool {
        let Ok(mut g) = self.ready().await else {
            return false;
        };
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().cwd(path)).await;
        settle(&mut g, r).is_ok()
    }

    /// `SIZE`（二進位模式）；伺服器不支援 / 是資料夾 → `None`。
    async fn size(&self, path: &str) -> Option<u64> {
        let mut g = self.ready().await.ok()?;
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().size(path)).await;
        settle(&mut g, r).ok().map(|n| n as u64)
    }

    async fn list_dir(&self, path: &str) -> AppResult<Vec<SftpEntry>> {
        let dir = if path.trim().is_empty() { "/" } else { path.trim() };
        let mut out = Vec::new();
        for it in self.raw_list(dir).await? {
            let Ok(full) = remote_join(dir, &it.name) else {
                eprintln!("[ftp] 略過伺服器回的可疑檔名：{:?}", it.name);
                continue;
            };
            out.push(it.into_entry(full));
        }
        // symlink 目標：FTP 沒有 stat，只能 CWD 試試看（一個一個來，數量太多就不查）。
        let mut probed = 0;
        for e in out.iter_mut().filter(|e| e.is_symlink) {
            if probed >= SYMLINK_PROBE_MAX {
                break;
            }
            probed += 1;
            e.link_target_is_dir = Some(self.is_dir(&e.path).await);
        }
        Ok(out)
    }

    /// 單一路徑的屬性（不跟 symlink；symlink 另查目標是不是資料夾）。
    async fn stat(&self, path: &str) -> AppResult<SftpEntry> {
        let path = path.trim();
        if is_root_like(path) && path.starts_with('/') {
            return Ok(dir_entry("/", "/"));
        }
        let mlst = { self.ready().await?.feats.mlsd };
        let found = if mlst {
            let mut g = self.ready().await?;
            let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().mlst(Some(path))).await;
            settle(&mut g, r).ok().and_then(|l| parse_mlsx_line(&l)).map(|mut it| {
                it.name = basename(path).to_string();
                it
            })
        } else {
            let (parent, name) = split_parent(path);
            self.raw_list(&parent).await.ok().and_then(|items| items.into_iter().find(|it| it.name == name))
        };
        let mut e = match found {
            Some(it) => it.into_entry(path.to_string()),
            // 上層列不出來（沒有權限）但本身進得去：當成資料夾。
            None if self.is_dir(path).await => dir_entry(basename(path), path),
            None => return Err(AppError::Ftp(t!("找不到檔案或目錄").into())),
        };
        if e.is_symlink {
            e.link_target_is_dir = Some(self.is_dir(path).await);
        }
        Ok(e)
    }

    async fn mkdir(&self, path: &str) -> AppResult<()> {
        let mut g = self.ready().await?;
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().mkdir(path)).await;
        settle(&mut g, r)
    }

    async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        let mut g = self.ready().await?;
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().rename(from, to)).await;
        settle(&mut g, r)
    }

    async fn rm(&self, path: &str) -> AppResult<()> {
        let mut g = self.ready().await?;
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().rm(path)).await;
        settle(&mut g, r)
    }

    async fn rmdir(&self, path: &str) -> AppResult<()> {
        let mut g = self.ready().await?;
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().rmdir(path)).await;
        settle(&mut g, r)
    }

    /// 刪除。目錄需 `recursive`（client 端 DFS：檔案邊走邊刪、目錄後序刪）。拒絕根目錄 / 目前目錄。
    async fn remove(&self, path: &str, recursive: bool) -> AppResult<()> {
        if is_root_like(path) {
            return Err(AppError::Ftp(t!("拒絕刪除根目錄或目前目錄").into()));
        }
        let e = self.stat(path).await?;
        // symlink 指向目錄也只刪連結本身，絕不跟進去。
        if !e.is_dir {
            return self.rm(path).await;
        }
        if !recursive {
            return self.rmdir(path).await;
        }
        let mut stack = vec![path.to_string()];
        let mut dirs: Vec<String> = Vec::new();
        while let Some(d) = stack.pop() {
            dirs.push(d.clone());
            for it in self.raw_list(&d).await? {
                let p = remote_join(&d, &it.name).map_err(|_| {
                    AppError::Ftp(tf!("伺服器回傳可疑的檔名，已中止刪除：{name}", name = it.name))
                })?;
                if it.kind == Kind::Dir {
                    stack.push(p);
                } else {
                    self.rm(&p).await?;
                }
            }
        }
        for d in dirs.iter().rev() {
            self.rmdir(d).await?;
        }
        Ok(())
    }

    // ---- 小檔讀寫（預覽 / 編輯器）----

    async fn read_small(&self, path: &str, max: u64) -> AppResult<SftpText> {
        let cap = if max == 0 { READ_SMALL_MAX } else { max.min(READ_SMALL_MAX) } as usize;
        let size = self.size(path).await.unwrap_or(0);
        let mut g = self.ready().await?;
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().retr_as_stream(path)).await;
        let mut stream = settle(&mut g, r)?;
        let mut buf: Vec<u8> = Vec::with_capacity(cap.min(size as usize + 1));
        let mut chunk = vec![0u8; CHUNK];
        let never = AtomicBool::new(false);
        let mut eof = false;
        while buf.len() <= cap {
            let n = match read_chunk(&mut stream, &mut chunk, &never).await {
                Ok(n) => n,
                Err(e) => {
                    g.ftp = None;
                    return Err(e);
                }
            };
            if n == 0 {
                eof = true;
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        if eof {
            let r = tokio::time::timeout(REQUEST_TIMEOUT, stream.finish()).await;
            settle(&mut g, r)?;
        } else {
            // 只要前面一段：直接丟掉這條連線（下個操作重連），比 ABOR 可靠——伺服器剛好送完時
            // ABOR 的回覆會跟傳輸完成的回覆錯開，整條控制連線就對不上了。
            drop(stream);
            g.ftp = None;
        }
        let truncated = buf.len() > cap;
        buf.truncate(cap);
        Ok(decode_text(buf, truncated, size))
    }

    /// 把編輯器的內容寫回遠端。`create_new` = 新增檔案（已存在即失敗）；否則檔案必須還在
    /// （編輯途中被刪掉就回錯，而不是默默重建一個）。FTP 沒有原子的「不存在才建立」，先查再寫。
    async fn write_text(&self, path: &str, content: &str, create_new: bool) -> AppResult<SftpEntry> {
        if content.len() > WRITE_TEXT_MAX {
            return Err(AppError::Ftp(tf!(
                "內容太大，無法在編輯器存檔（上限 {max} MiB）",
                max = WRITE_TEXT_MAX / (1024 * 1024)
            )));
        }
        let exists = self.stat(path).await.is_ok();
        if create_new && exists {
            return Err(AppError::Ftp(tf!("遠端檔案已存在：{path}", path = path)));
        }
        if !create_new && !exists {
            return Err(AppError::Ftp(t!("找不到檔案或目錄").into()));
        }
        {
            let mut g = self.ready().await?;
            let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().put_with_stream(path)).await;
            let mut stream = settle(&mut g, r)?;
            if let Err(e) = write_chunk(&mut stream, content.as_bytes(), &AtomicBool::new(false)).await {
                g.ftp = None;
                return Err(e);
            }
            // finish 會等伺服器的 226：磁碟滿 / 權限這類錯誤在這裡才浮出來，不能吞掉。
            drain_unread(&mut stream).await;
            let r = tokio::time::timeout(REQUEST_TIMEOUT, stream.finish()).await;
            settle(&mut g, r)?;
        }
        self.stat(path).await
    }

    /// `SITE CHMOD`（多數 Unix 上的伺服器支援；Windows 上的通常不支援）。
    async fn chmod(&self, path: &str, mode: u32) -> AppResult<SftpEntry> {
        {
            let mut g = self.ready().await?;
            let cmd = format!("CHMOD {:o} {}", mode & 0o7777, path);
            let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().site(cmd)).await;
            settle(&mut g, r)?;
        }
        self.stat(path).await
    }

    // ---- 續傳比對 ----

    /// 從 `start` 開始 `RETR`（`start > 0` 先 `REST`）。伺服器不接受 `REST` 就從頭，回傳實際的起點。
    async fn retr_from(&self, g: &mut Slot, path: &str, start: u64) -> AppResult<(suppaftp::tokio::TransferStream<suppaftp::tokio::AsyncRustlsStream>, u64)> {
        let mut at = start;
        if at > 0 {
            let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().resume_transfer(at as usize)).await;
            if settle(g, r).is_err() {
                at = 0;
                if g.ftp.is_none() {
                    return Err(AppError::Ftp(t!("FTP 連線已中斷").into()));
                }
            }
        }
        let r = tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().retr_as_stream(path)).await;
        Ok((settle(g, r)?, at))
    }

    /// 遠端 `path` 在 `[end - n, end)` 這一段是否與 `local` 同一段相同（`n` = `RESUME_VERIFY` 與 `end` 取小）。
    /// 讀完就丟掉這條連線（見 `read_small`），下個操作重連。任何錯誤都當不相同。
    async fn tail_matches(&self, path: &str, local: &mut tokio::fs::File, end: u64) -> bool {
        let n = end.min(RESUME_VERIFY);
        let start = end - n;
        let mut want = vec![0u8; n as usize];
        if local.seek(std::io::SeekFrom::Start(start)).await.is_err() || local.read_exact(&mut want).await.is_err() {
            return false;
        }
        let Ok(mut g) = self.ready().await else {
            return false;
        };
        let got = match self.retr_from(&mut g, path, start).await {
            Ok((mut stream, at)) if at == start => read_exact_n(&mut stream, n as usize).await.ok(),
            _ => None,
        };
        g.ftp = None;
        got.as_deref() == Some(want.as_slice())
    }

    // ---- 單檔上下傳 ----

    async fn download_file(
        &self,
        remote: &str,
        local: &Path,
        on_conflict: OnConflict,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<PathBuf> {
        let local = resolve_local_target(local, remote).await;
        let existing = tokio::fs::metadata(&local).await.ok();
        if existing.is_some() {
            match on_conflict {
                OnConflict::Fail => {
                    return Err(AppError::Ftp(tf!("本機檔案已存在：{path}", path = local.display())));
                }
                OnConflict::Skip => return Ok(local),
                OnConflict::Overwrite | OnConflict::Resume => {}
            }
        }
        let total = self.size(remote).await;
        if on_conflict == OnConflict::Resume {
            if let Some(m) = existing.as_ref().filter(|m| m.is_file()) {
                if resume_from(m.len(), total) == ResumeFrom::Done {
                    let same = match tokio::fs::File::open(&local).await {
                        Ok(mut lf) => self.tail_matches(remote, &mut lf, m.len()).await,
                        Err(_) => false,
                    };
                    if same {
                        progress(m.len(), Some(m.len()));
                        return Ok(local);
                    }
                }
            }
        }
        if let Some(dir) = local.parent() {
            if !dir.as_os_str().is_empty() {
                tokio::fs::create_dir_all(dir).await.map_err(local_err)?;
            }
        }
        let part = part_path(&local);
        // 上次失敗留下的 `.part` 比遠端小：從它的結尾往前一段開始要，拿那一段比對。
        let have = match tokio::fs::metadata(&part).await {
            Ok(m) if m.is_file() => match resume_from(m.len(), total) {
                ResumeFrom::At(h) => h,
                _ => 0,
            },
            _ => 0,
        };
        let verify = have.min(RESUME_VERIFY);
        let mut g = self.ready().await?;
        let (mut stream, at) = self.retr_from(&mut g, remote, have - verify).await?;
        let mut offset = 0;
        if have > 0 && at == have - verify {
            let same = match read_exact_n(&mut stream, verify as usize).await {
                Ok(got) => part_tail(&part, have, verify).await.is_some_and(|want| want == got),
                Err(_) => false,
            };
            if same {
                offset = have;
            } else {
                // 對不上（遠端改過）：丟掉這條資料連線，從頭再要一次。
                drop(stream);
                g.ftp = None;
                drop(g);
                g = self.ready().await?;
                stream = self.retr_from(&mut g, remote, 0).await?.0;
            }
        } else if at > 0 {
            // 沒有要續傳卻不是從頭（不該發生）：保險起見從頭。
            drop(stream);
            g.ftp = None;
            drop(g);
            g = self.ready().await?;
            stream = self.retr_from(&mut g, remote, 0).await?.0;
        }
        let mut lf = if offset > 0 {
            tokio::fs::OpenOptions::new().append(true).open(&part).await.map_err(local_err)?
        } else {
            tokio::fs::File::create(&part).await.map_err(local_err)?
        };
        let mut buf = vec![0u8; CHUNK];
        let mut done = offset;
        let mut last = Instant::now();
        progress(done, total);
        let result: AppResult<()> = async {
            loop {
                // 資料一直來的時候 read_chunk 不會停下來看旗標：每一塊之前自己看一次。
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::SshCancelled);
                }
                let n = read_chunk(&mut stream, &mut buf, cancel).await?;
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
        let result = match result {
            // 資料收完了還要等伺服器的 226：傳輸中途被伺服器中止（磁碟 / 權限）在這裡才知道。
            Ok(()) => {
                let r = tokio::time::timeout(REQUEST_TIMEOUT, stream.finish()).await;
                settle(&mut g, r)
            }
            Err(e) => {
                drop(stream);
                g.ftp = None;
                Err(e)
            }
        };
        if let Err(e) = result {
            // 取消 = 使用者要停下來；一個位元組都沒收到也沒有可以續傳的東西。其餘（斷線、逾時…）留著。
            if matches!(e, AppError::SshCancelled) || done == 0 {
                let _ = tokio::fs::remove_file(&part).await;
            }
            return Err(e);
        }
        tokio::fs::rename(&part, &local).await.map_err(local_err)?;
        progress(done, total.or(Some(done)));
        Ok(local)
    }

    /// 續傳上傳：遠端已有的同名檔與本機來源比，決定略過 / 接著寫 / 從頭。讀不到、對不上都從頭。
    async fn remote_resume_point(&self, remote: &str, lf: &mut tokio::fs::File, total: Option<u64>) -> ResumeFrom {
        let Some(have) = self.size(remote).await else {
            return ResumeFrom::Start;
        };
        let r = resume_from(have, total);
        if r == ResumeFrom::Start {
            return r;
        }
        if self.tail_matches(remote, lf, have).await {
            r
        } else {
            ResumeFrom::Start
        }
    }

    async fn upload_file(
        &self,
        local: &Path,
        remote: &str,
        on_conflict: OnConflict,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        let mut lf = tokio::fs::File::open(local).await.map_err(local_err)?;
        let total = lf.metadata().await.ok().map(|m| m.len());
        let fresh_only = matches!(on_conflict, OnConflict::Fail | OnConflict::Skip);
        if fresh_only && self.stat(remote).await.is_ok() {
            if on_conflict == OnConflict::Skip {
                return Ok(());
            }
            return Err(AppError::Ftp(tf!("遠端檔案已存在：{path}", path = remote)));
        }
        let offset = match on_conflict {
            OnConflict::Resume => match self.remote_resume_point(remote, &mut lf, total).await {
                ResumeFrom::Done => {
                    let t = total.unwrap_or(0);
                    progress(t, Some(t));
                    return Ok(());
                }
                ResumeFrom::At(o) => o,
                ResumeFrom::Start => 0,
            },
            _ => 0,
        };
        lf.seek(std::io::SeekFrom::Start(offset)).await.map_err(local_err)?;
        let mut g = self.ready().await?;
        let r = if offset > 0 {
            tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().append_with_stream(remote)).await
        } else {
            tokio::time::timeout(REQUEST_TIMEOUT, g.ftp().put_with_stream(remote)).await
        };
        let mut stream = settle(&mut g, r)?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = offset;
        let mut last = Instant::now();
        progress(done, total);
        let result: AppResult<()> = async {
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::SshCancelled);
                }
                let n = lf.read(&mut buf).await.map_err(local_err)?;
                if n == 0 {
                    break;
                }
                write_chunk(&mut stream, &buf[..n], cancel).await?;
                done += n as u64;
                if last.elapsed() >= PROGRESS_EVERY {
                    progress(done, total);
                    last = Instant::now();
                }
            }
            Ok(())
        }
        .await;
        let result = match result {
            // finish 關掉資料連線並等 226；寫入錯誤（磁碟滿、配額）在這裡浮出。
            Ok(()) => {
                drain_unread(&mut stream).await;
                let r = tokio::time::timeout(REQUEST_TIMEOUT, stream.finish()).await;
                settle(&mut g, r)
            }
            Err(e) => {
                drop(stream);
                g.ftp = None;
                Err(e)
            }
        };
        drop(g);
        match result {
            Ok(()) => {
                progress(done, total.or(Some(done)));
                Ok(())
            }
            Err(e) => {
                // 同 SFTP：取消或什麼都沒寫進去才刪；斷線時多半刪不到，留著正好給續傳。
                if matches!(e, AppError::SshCancelled) || done == 0 {
                    let _ = self.rm(remote).await;
                }
                Err(e)
            }
        }
    }
}

#[async_trait]
impl RemoteFs for FtpSession {
    fn fail_kind(&self) -> fn(String) -> AppError {
        AppError::Ftp
    }

    async fn read_dir_kinds(&self, dir: &str) -> AppResult<Vec<(String, Kind, u64)>> {
        Ok(self.raw_list(dir).await?.into_iter().map(|it| (it.name, it.kind, it.size)).collect())
    }

    async fn kind_follow(&self, path: &str) -> AppResult<(Kind, u64)> {
        let e = self.stat(path).await?;
        if e.is_symlink {
            return Ok(if e.link_target_is_dir == Some(true) {
                (Kind::Dir, 0)
            } else {
                (Kind::File, self.size(path).await.unwrap_or(e.size))
            });
        }
        Ok((entry_kind(&e), e.size))
    }

    async fn kind_nofollow(&self, path: &str) -> AppResult<Kind> {
        Ok(entry_kind(&self.stat(path).await?))
    }

    async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    async fn create_dir(&self, path: &str) -> AppResult<()> {
        self.mkdir(path).await
    }

    async fn download(
        &self,
        remote: &str,
        local: &Path,
        on_conflict: OnConflict,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<PathBuf> {
        self.download_file(remote, local, on_conflict, progress, cancel).await
    }

    async fn upload(
        &self,
        local: &Path,
        remote: &str,
        on_conflict: OnConflict,
        progress: ProgressFn,
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        self.upload_file(local, remote, on_conflict, progress, cancel).await
    }
}

// ---- 檔案面板的 FTP 工作階段 ----

/// 檔案面板的一個 FTP 工作階段（對應 SFTP 的 `SftpClient`）：一條瀏覽連線，傳輸時另開連線。
pub struct FtpClient {
    pub conn_id: String,
    target: Arc<FtpTarget>,
    slots: Arc<Semaphore>,
    browse: FtpSession,
}

impl FtpClient {
    /// 開瀏覽連線（第一個開的直接用登入時那條），回 `(client, home)`；`home` 是登入後的 `PWD`。
    pub async fn open(conn: &FtpConn) -> AppResult<(Self, String)> {
        let initial = conn.initial.lock().take();
        let browse = FtpSession::new(conn.target.clone(), initial, None);
        let home = browse.pwd().await?;
        Ok((Self { conn_id: conn.id.clone(), target: conn.target.clone(), slots: conn.slots.clone(), browse }, home))
    }

    pub async fn close(&self) {
        self.browse.quit().await;
    }

    /// 傳輸用的控制連線：等到有空的名額才開（等待中可以取消），連好才回，連不上的錯誤在這裡浮出。
    pub async fn transfer_session(&self, cancel: &AtomicBool) -> AppResult<FtpSession> {
        // 同一個 acquire 等到底（重建會失去排隊的位置）。
        let acquire = self.slots.clone().acquire_owned();
        tokio::pin!(acquire);
        let permit = loop {
            tokio::select! {
                p = &mut acquire => {
                    break p.map_err(|_| AppError::Ftp(t!("FTP 連線已中斷").into()))?;
                }
                _ = tokio::time::sleep(CANCEL_TICK) => {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(AppError::SshCancelled);
                    }
                }
            }
        };
        let s = FtpSession::new(self.target.clone(), None, Some(permit));
        drop(s.ready().await?);
        Ok(s)
    }

    pub async fn list_dir(&self, path: &str) -> AppResult<Vec<SftpEntry>> {
        self.browse.list_dir(path).await
    }

    pub async fn stat(&self, path: &str) -> AppResult<SftpEntry> {
        self.browse.stat(path).await
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        self.browse.mkdir(path).await
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        self.browse.rename(from, to).await
    }

    pub async fn remove(&self, path: &str, recursive: bool) -> AppResult<()> {
        self.browse.remove(path, recursive).await
    }

    pub async fn read_small(&self, path: &str, max: u64) -> AppResult<SftpText> {
        self.browse.read_small(path, max).await
    }

    pub async fn write_text(&self, path: &str, content: &str, create_new: bool) -> AppResult<SftpEntry> {
        self.browse.write_text(path, content, create_new).await
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> AppResult<SftpEntry> {
        self.browse.chmod(path, mode).await
    }
}

// ---- 傳輸的讀寫（逾時 + 取消）----

/// 讀一塊資料。伺服器停住時每 `CANCEL_TICK` 看一次取消旗標；超過 `REQUEST_TIMEOUT` 沒有資料當斷線。
async fn read_chunk<R: AsyncRead + Unpin>(r: &mut R, buf: &mut [u8], cancel: &AtomicBool) -> AppResult<usize> {
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let fut = r.read(buf);
    tokio::pin!(fut);
    loop {
        tokio::select! {
            res = &mut fut => return res.map_err(io_err),
            _ = tokio::time::sleep(CANCEL_TICK) => {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::SshCancelled);
                }
                if Instant::now() >= deadline {
                    return Err(AppError::Ftp(t!("FTP 傳輸逾時（伺服器沒有回應）").into()));
                }
            }
        }
    }
}

/// 寫一塊資料；逾時與取消同 `read_chunk`。
async fn write_chunk<W: AsyncWrite + Unpin>(w: &mut W, data: &[u8], cancel: &AtomicBool) -> AppResult<()> {
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let fut = w.write_all(data);
    tokio::pin!(fut);
    loop {
        tokio::select! {
            res = &mut fut => return res.map_err(io_err),
            _ = tokio::time::sleep(CANCEL_TICK) => {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::SshCancelled);
                }
                if Instant::now() >= deadline {
                    return Err(AppError::Ftp(t!("FTP 傳輸逾時（伺服器沒有回應）").into()));
                }
            }
        }
    }
}

/// 上傳收尾（`finish`）前讀掉伺服器在資料連線上送來、還沒讀的東西（TLS 1.3 的 session ticket）。
/// 不讀的話，關閉 socket 時接收緩衝區裡還有資料，作業系統會送 RST 而不是 FIN——伺服器還沒讀完的上傳
/// 資料會被丟掉，回 426（檔案越大越明顯）。只收當下已經到的，不等。
async fn drain_unread<R: AsyncRead + Unpin>(r: &mut R) {
    let mut sink = [0u8; 512];
    while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(20), r.read(&mut sink)).await {
        if n == 0 {
            break;
        }
    }
}

/// 讀剛好 `n` 個位元組（不夠就錯）。
async fn read_exact_n<R: AsyncRead + Unpin>(r: &mut R, n: usize) -> AppResult<Vec<u8>> {
    let mut out = vec![0u8; n];
    let mut filled = 0;
    let never = AtomicBool::new(false);
    while filled < n {
        let k = read_chunk(r, &mut out[filled..], &never).await?;
        if k == 0 {
            return Err(AppError::Ftp(t!("已到檔案結尾").into()));
        }
        filled += k;
    }
    Ok(out)
}

/// `.part` 在 `[have - n, have)` 的內容。
async fn part_tail(part: &Path, have: u64, n: u64) -> Option<Vec<u8>> {
    let mut f = tokio::fs::File::open(part).await.ok()?;
    f.seek(std::io::SeekFrom::Start(have - n)).await.ok()?;
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf).await.ok()?;
    Some(buf)
}

// ---- 列表解析（純函式，可測）----

/// 一個列表項目（`MLSD` / `LIST` 解析的結果）。`name` 未驗證。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Item {
    name: String,
    kind: Kind,
    size: u64,
    mtime: Option<u64>,
    /// 權限位元（`0o7777` 以內）；伺服器沒給就是 `None`。
    perm: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
    owner: Option<String>,
    group: Option<String>,
}

impl Item {
    fn into_entry(self, path: String) -> SftpEntry {
        let type_bits = match self.kind {
            Kind::Dir => 0o040000,
            Kind::Symlink => 0o120000,
            Kind::File | Kind::Other => 0o100000,
        };
        SftpEntry {
            name: self.name,
            path,
            is_dir: self.kind == Kind::Dir,
            is_symlink: self.kind == Kind::Symlink,
            link_target_is_dir: None,
            size: self.size,
            mtime: self.mtime,
            permissions: self.perm.map(|p| p | type_bits),
            mode: mode_string(self.perm.unwrap_or(0) | type_bits),
            uid: self.uid,
            gid: self.gid,
            owner: self.owner,
            group: self.group,
        }
    }
}

fn dir_entry(name: &str, path: &str) -> SftpEntry {
    Item {
        name: name.to_string(),
        kind: Kind::Dir,
        size: 0,
        mtime: None,
        perm: None,
        uid: None,
        gid: None,
        owner: None,
        group: None,
    }
    .into_entry(path.to_string())
}

fn entry_kind(e: &SftpEntry) -> Kind {
    if e.is_symlink {
        Kind::Symlink
    } else if e.is_dir {
        Kind::Dir
    } else {
        Kind::File
    }
}

/// `/a/b/c` → (`/a/b`, `c`)；`c` → (`.`, `c`)；`/c` → (`/`, `c`)。
fn split_parent(path: &str) -> (String, String) {
    let t = path.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) => ("/".to_string(), t[1..].to_string()),
        Some(i) => (t[..i].to_string(), t[i + 1..].to_string()),
        None => (".".to_string(), t.to_string()),
    }
}

/// `MLSD` / `MLST` 的一行：`type=file;size=12;modify=20240102030405;UNIX.mode=0644; name`。
/// `cdir` / `pdir`（`.` / `..`）回 `None`。事實名稱不分大小寫。
fn parse_mlsx_line(line: &str) -> Option<Item> {
    let line = line.trim_end_matches(['\r', '\n']);
    let (facts, name) = line.split_once(' ')?;
    if name.is_empty() {
        return None;
    }
    let mut it = Item {
        // MLST 回的是完整路徑：只取最後一段（呼叫端會再蓋掉）。
        name: name.to_string(),
        kind: Kind::File,
        size: 0,
        mtime: None,
        perm: None,
        uid: None,
        gid: None,
        owner: None,
        group: None,
    };
    for fact in facts.split(';').filter(|f| !f.is_empty()) {
        let Some((k, v)) = fact.split_once('=') else {
            continue;
        };
        match k.to_ascii_lowercase().as_str() {
            "type" => {
                let v = v.to_ascii_lowercase();
                it.kind = match v.as_str() {
                    "file" => Kind::File,
                    "dir" => Kind::Dir,
                    "cdir" | "pdir" => return None,
                    _ if v.starts_with("os.unix=slink") || v.starts_with("os.unix=symlink") => Kind::Symlink,
                    _ if v.starts_with("os.unix=") => Kind::Other,
                    _ => Kind::File,
                };
            }
            "size" | "sizd" => it.size = v.parse().unwrap_or(0),
            "modify" => it.mtime = parse_mlsx_time(v),
            "unix.mode" => it.perm = u32::from_str_radix(v.trim_start_matches("0o"), 8).ok().map(|m| m & 0o7777),
            "unix.uid" => it.uid = v.parse().ok(),
            "unix.gid" => it.gid = v.parse().ok(),
            "unix.owner" => it.owner = Some(v.to_string()),
            "unix.group" => it.group = Some(v.to_string()),
            _ => {}
        }
    }
    Some(it)
}

/// `YYYYMMDDHHMMSS[.sss]`（UTC）→ epoch 秒。
fn parse_mlsx_time(v: &str) -> Option<u64> {
    let head = v.get(..14)?;
    let t = chrono::NaiveDateTime::parse_from_str(head, "%Y%m%d%H%M%S").ok()?;
    u64::try_from(t.and_utc().timestamp()).ok()
}

/// `LIST` 的一行：Unix `ls -l` 格式或 DOS / IIS 格式；`total 12` 這類說明行與看不懂的行回 `None`。
fn parse_list_line(line: &str) -> Option<Item> {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Ok(f) = ListParser::parse_posix(line) {
        // 權限、擁有者自己取：suppaftp 會丟掉 setuid / sticky 位元，擁有者也只認數字。
        let mut cols = line.split_whitespace();
        let perm = cols.next().and_then(|m| mode_from_ls(m));
        let _links = cols.next();
        let owner = cols.next().map(str::to_string);
        let group = cols.next().map(str::to_string);
        return Some(Item {
            kind: list_kind(&f),
            size: f.size() as u64,
            mtime: epoch_secs(f.modified()),
            perm,
            uid: f.uid(),
            gid: f.gid(),
            owner: owner.filter(|o| o.parse::<u32>().is_err()),
            group: group.filter(|g| g.parse::<u32>().is_err()),
            name: f.name().to_string(),
        });
    }
    let f = ListParser::parse_dos(line).ok()?;
    Some(Item {
        kind: list_kind(&f),
        size: f.size() as u64,
        mtime: epoch_secs(f.modified()),
        perm: None,
        uid: None,
        gid: None,
        owner: None,
        group: None,
        name: f.name().to_string(),
    })
}

fn list_kind(f: &ListFile) -> Kind {
    match f.file_type() {
        ListFileType::Directory => Kind::Dir,
        ListFileType::Symlink(_) => Kind::Symlink,
        ListFileType::File => Kind::File,
    }
}

fn epoch_secs(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()).filter(|&s| s > 0)
}

/// `drwxr-sr-t` → 權限位元（含 setuid / setgid / sticky）。格式不對 → `None`。
fn mode_from_ls(s: &str) -> Option<u32> {
    let c: Vec<char> = s.chars().collect();
    if c.len() < 10 {
        return None;
    }
    let mut m = 0u32;
    for (i, &ch) in c[1..10].iter().enumerate() {
        let bit = 1 << (8 - i);
        match (i % 3, ch) {
            (_, '-') => {}
            (0, 'r') | (1, 'w') | (2, 'x') => m |= bit,
            (2, 's') | (2, 't') => m |= bit | special_bit(i),
            (2, 'S') | (2, 'T') => m |= special_bit(i),
            _ => return None,
        }
    }
    Some(m)
}

/// 第 `i` 個權限字元（`x` 那一欄）對應的特殊位元：擁有者 → setuid、群組 → setgid、其他 → sticky。
fn special_bit(i: usize) -> u32 {
    match i / 3 {
        0 => 0o4000,
        1 => 0o2000,
        _ => 0o1000,
    }
}

// ---- 錯誤對映 ----

/// 伺服器回覆去掉狀態碼（多行回覆取最後一行）。
fn response_text(r: &suppaftp::types::Response) -> String {
    let s = String::from_utf8_lossy(&r.body);
    let last = s.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("").trim();
    let msg = if last.len() > 4 && last.as_bytes()[..3].iter().all(u8::is_ascii_digit) { &last[4..] } else { last };
    msg.trim().to_string()
}

/// 連線層級的錯誤：這條控制連線不能再用了（下一個操作重連）。
fn is_fatal(e: &FtpError) -> bool {
    match e {
        FtpError::UnexpectedResponse(r) => r.status == Status::NotAvailable,
        FtpError::InvalidAddress(_) => false,
        _ => true,
    }
}

/// 帶逾時的請求結果 → `AppResult`；連線層級的錯誤 / 逾時把連線標成壞的。
fn settle<T>(g: &mut Slot, r: Result<Result<T, FtpError>, tokio::time::error::Elapsed>) -> AppResult<T> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => {
            if is_fatal(&e) {
                g.ftp = None;
            }
            Err(map_err(e))
        }
        Err(_) => {
            g.ftp = None;
            Err(AppError::Ftp(t!("FTP 操作逾時").into()))
        }
    }
}

/// suppaftp 的錯誤 → `AppError::Ftp`（常見的回覆碼換成本地化說明，後面附伺服器原話）。
pub fn map_err(e: FtpError) -> AppError {
    let msg = match &e {
        FtpError::UnexpectedResponse(r) => {
            let server = response_text(r);
            let hint: Option<&str> = match r.status {
                Status::NotLoggedIn | Status::InvalidCredentials => Some(t!("未登入或帳號密碼錯誤")),
                Status::FileUnavailable | Status::RequestFileActionIgnored => Some(t!("找不到檔案或目錄，或權限不足")),
                Status::ExceededStorage => Some(t!("伺服器空間不足")),
                Status::BadFilename => Some(t!("伺服器不接受這個檔名")),
                Status::NotAvailable => Some(t!("伺服器關閉了連線")),
                Status::CannotOpenDataConnection => {
                    Some(t!("無法建立資料連線（可在主機設定切換主動 / 被動模式）"))
                }
                Status::BadCommand | Status::NotImplemented | Status::NotImplementedParameter => {
                    Some(t!("伺服器不支援此操作"))
                }
                _ => None,
            };
            match (hint, server.is_empty()) {
                (Some(h), true) => h.to_string(),
                (Some(h), false) => format!("{h}（{server}）"),
                (None, false) => server,
                (None, true) => tf!("伺服器回覆 {code}", code = r.status.code()),
            }
        }
        FtpError::ConnectionError(io) => tf!("FTP 連線錯誤：{e}", e = io),
        FtpError::SecureError(s) => tf!("TLS 錯誤：{e}", e = s),
        FtpError::BadResponse => t!("FTP 協定錯誤（伺服器的回覆格式不正確）").to_string(),
        FtpError::InvalidAddress(a) => tf!("伺服器回傳的資料連線位址無效：{e}", e = a),
        FtpError::DataConnectionAlreadyOpen => t!("FTP 資料連線忙碌中").to_string(),
    };
    AppError::Ftp(msg)
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Ftp(tf!("FTP 連線錯誤：{e}", e = e))
}

fn local_err(e: std::io::Error) -> AppError {
    AppError::Ftp(tf!("本機檔案錯誤：{e}", e = e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mlsd_lines() {
        let it = parse_mlsx_line("type=file;size=1234;modify=20240102030405;UNIX.mode=0644;UNIX.owner=deploy; a b.txt").unwrap();
        assert_eq!(it.name, "a b.txt", "檔名可以有空白");
        assert_eq!(it.kind, Kind::File);
        assert_eq!(it.size, 1234);
        assert_eq!(it.perm, Some(0o644));
        assert_eq!(it.owner.as_deref(), Some("deploy"));
        assert_eq!(it.mtime, Some(1_704_164_645));
        let d = parse_mlsx_line("Type=dir;Modify=20240102030405.123;Perm=el; logs").unwrap();
        assert_eq!(d.kind, Kind::Dir, "事實名稱不分大小寫、時間可帶毫秒");
        assert_eq!(d.mtime, Some(1_704_164_645));
        assert!(parse_mlsx_line("type=cdir;modify=20240102030405; .").is_none());
        assert!(parse_mlsx_line("type=pdir; ..").is_none());
        assert_eq!(parse_mlsx_line("type=OS.unix=slink:/etc;size=4; etc").unwrap().kind, Kind::Symlink);
        assert_eq!(parse_mlsx_line("type=OS.unix=blkdev; sda").unwrap().kind, Kind::Other);
        assert_eq!(parse_mlsx_line("UNIX.mode=04755;type=file; su").unwrap().perm, Some(0o4755));
        assert!(parse_mlsx_line("garbage").is_none());
    }

    #[test]
    fn list_lines_posix_and_dos() {
        let it = parse_list_line("-rw-r--r--    1 deploy   www          42 Jan  2  2024 index.html").unwrap();
        assert_eq!(it.name, "index.html");
        assert_eq!(it.kind, Kind::File);
        assert_eq!(it.size, 42);
        assert_eq!(it.perm, Some(0o644));
        assert_eq!(it.owner.as_deref(), Some("deploy"));
        assert_eq!(it.group.as_deref(), Some("www"));
        assert!(it.mtime.is_some());

        let d = parse_list_line("drwxr-sr-t    2 1000     1000         4096 Mar 10 12:30 shared").unwrap();
        assert_eq!(d.kind, Kind::Dir);
        assert_eq!(d.perm, Some(0o3755), "setgid + sticky 要留著");
        assert_eq!((d.uid, d.owner.as_deref()), (Some(1000), None), "數字擁有者放 uid");

        let l = parse_list_line("lrwxrwxrwx    1 root     root            7 Jan  2  2024 bin -> usr/bin").unwrap();
        assert_eq!(l.kind, Kind::Symlink);
        assert_eq!(l.name, "bin", "symlink 的目標不算在檔名裡");

        let dos = parse_list_line("10-19-20  03:19PM       <DIR>          pub").unwrap();
        assert_eq!((dos.kind, dos.name.as_str(), dos.perm), (Kind::Dir, "pub", None));
        let dos = parse_list_line("04-08-14  03:09PM                  403 readme.txt").unwrap();
        assert_eq!((dos.kind, dos.size), (Kind::File, 403));

        assert!(parse_list_line("total 12").is_none());
    }

    #[test]
    fn ls_mode_strings_roundtrip() {
        for m in [0o644, 0o755, 0o4755, 0o2644, 0o1777, 0o000, 0o7777] {
            let s = mode_string(0o100000 | m);
            assert_eq!(mode_from_ls(&s), Some(m), "{s}");
        }
        assert_eq!(mode_from_ls("-rw-r--r"), None, "太短");
        assert_eq!(mode_from_ls("-rwzr--r--"), None, "看不懂的字元");
    }

    #[test]
    fn entries_get_type_bits_and_mode() {
        let e = parse_list_line("-rwxr-x---    1 u g 5 Jan  2  2024 run.sh").unwrap().into_entry("/x/run.sh".into());
        assert_eq!(e.permissions, Some(0o100750));
        assert_eq!(e.mode, "-rwxr-x---");
        let e = parse_list_line("10-19-20  03:19PM       <DIR>          pub").unwrap().into_entry("/pub".into());
        assert!(e.is_dir);
        assert_eq!(e.permissions, None, "DOS 格式沒有權限");
        assert_eq!(e.mode, "d---------");
    }

    #[test]
    fn split_parent_paths() {
        assert_eq!(split_parent("/a/b/c"), ("/a/b".to_string(), "c".to_string()));
        assert_eq!(split_parent("/c"), ("/".to_string(), "c".to_string()));
        assert_eq!(split_parent("/a/b/"), ("/a".to_string(), "b".to_string()));
        assert_eq!(split_parent("c"), (".".to_string(), "c".to_string()));
    }

    #[test]
    fn response_text_strips_codes() {
        let r = |code: Status, body: &str| suppaftp::types::Response::new(code, body.as_bytes().to_vec());
        assert_eq!(response_text(&r(Status::FileUnavailable, "550 Failed to open file.\r\n")), "Failed to open file.");
        assert_eq!(response_text(&r(Status::NotLoggedIn, "530-Login\r\n530 incorrect.\r\n")), "incorrect.");
        assert_eq!(response_text(&r(Status::NotLoggedIn, "530\r\n")), "530");
        match map_err(FtpError::UnexpectedResponse(r(Status::ExceededStorage, "552 Quota exceeded\r\n"))) {
            AppError::Ftp(m) => assert!(m.contains("Quota exceeded"), "{m}"),
            e => panic!("{e:?}"),
        }
        assert!(is_fatal(&FtpError::BadResponse));
        assert!(!is_fatal(&FtpError::UnexpectedResponse(r(Status::FileUnavailable, "550 x"))));
        assert!(is_fatal(&FtpError::UnexpectedResponse(r(Status::NotAvailable, "421 bye"))));
    }

    #[test]
    fn target_defaults() {
        let mut s: SshSession = serde_json::from_value(serde_json::json!({
            "id": "f1", "host": " ftp.example ", "port": 0, "protocol": "ftp"
        }))
        .unwrap();
        let t = FtpTarget::from_session(&s, None);
        assert_eq!((t.host.as_str(), t.port), ("ftp.example", 21));
        assert!(t.is_anonymous(), "沒填帳號 = 匿名");
        assert_eq!(t.login_password(), "anonymous@");
        assert_eq!(t.cert_host_id(), "ftps://ftp.example:21");
        s.ftp.tls = FtpTls::Implicit;
        assert_eq!(FtpTarget::from_session(&s, None).port, 990);
        s.username = "deploy".into();
        let t = FtpTarget::from_session(&s, Some("pw".into()));
        assert!(!t.is_anonymous());
        assert_eq!(t.login_password(), "pw");
        assert_eq!(t.label(), "deploy@ftp.example");
    }

    #[test]
    fn fingerprint_format() {
        let fp = cert_fingerprint(b"not really a certificate");
        assert!(fp.starts_with("SHA256:"), "{fp}");
        assert!(!fp.ends_with('='), "與 SSH 指紋一樣不帶 padding");
        assert_eq!(fp, cert_fingerprint(b"not really a certificate"));
    }
}
