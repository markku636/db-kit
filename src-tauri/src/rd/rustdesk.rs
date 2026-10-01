//! RustDesk 相容連線：啟動獨立的輔助程式 `dbk-rustdesk-bridge`、經 stdin / stdout 跟它交換訊息。
//!
//! 協定實作（取自 RustDesk，AGPL-3.0）全部在那個程式裡（repo 的 `rustdesk-bridge/`，獨立發行、獨立授權）；
//! db-kit 這邊只啟動子程序、轉送訊息，不連結它的程式碼，所以本體維持 MIT。
//!
//! 訊息格式（兩個方向相同）：`[u32 長度（LE，不含這 4 bytes）][u8 型別][內容]`。
//! - 型別 1：JSON（db-kit → bridge：`connect` / `mouse` / `key` / `ctrl_alt_del` / `refresh`；bridge → db-kit：事件）。
//! - 型別 2（bridge → db-kit）：影像 `[u8 codec][u8 key][u8 display][u8 保留][i64 pts]` + 仍是 VP9 / VP8 / AV1 的位元流。
//!
//! 給前端的 Channel 訊息 = `[u8 型別][內容]`（拿掉長度）：影像在 WebView 裡用 WebCodecs 解，JSON 事件照轉。

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use super::runtime::{AuthAnswer, RdCtl};
use crate::error::{AppError, AppResult};

pub const BRIDGE_NAME: &str = "dbk-rustdesk-bridge";
pub const TYPE_JSON: u8 = 1;
/// 單則上限（一張 4K 關鍵畫面也遠低於此）。
const MAX_MSG: usize = 128 * 1024 * 1024;

/// 給前端的輸出（一則 Channel 訊息）。
pub type Sink = std::sync::Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// 輔助程式的位置：`DBKIT_RUSTDESK_BRIDGE` 環境變數（開發 / 測試），否則主程式旁邊
/// （Tauri 的 `externalBin` 打包後就放在那裡，名稱去掉 target triple）。
pub fn bridge_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("DBKIT_RUSTDESK_BRIDGE").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join(format!("{BRIDGE_NAME}{}", std::env::consts::EXE_SUFFIX));
    p.exists().then_some(p)
}

/// 經 ID 伺服器連線的設定（輔助程式 `connect` 指令的 `rendezvous` 欄位）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Rendezvous {
    /// ID 伺服器（`host[:port]`，預設埠 21116）；空 = RustDesk 公開伺服器。
    pub server: String,
    /// 中繼伺服器；空 = 用 ID 伺服器告知的（再沒有就是 ID 伺服器的主機 + 21117）。
    pub relay: String,
    /// ID 伺服器的公鑰（base64）。
    pub key: String,
    pub force_relay: bool,
}

/// 連線參數（密碼經 stdin 傳，不放命令列）。
#[derive(Clone)]
pub struct RustdeskParams {
    pub host: String,
    pub port: u16,
    pub password: String,
    /// 有值 = `host` 是對方的 RustDesk ID，經 ID 伺服器找人；None = Direct IP（直接連 `host:port`）。
    pub rendezvous: Option<Rendezvous>,
}

impl std::fmt::Debug for RustdeskParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RustdeskParams")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("rendezvous", &self.rendezvous)
            .finish()
    }
}

/// 對方欄填的是 RustDesk ID（要經 ID 伺服器）還是位址（Direct IP）。照官方用戶端：IP 位址與網域是
/// Direct IP，其他都是 ID（數字 ID，或自訂的英數 ID）；db-kit 的埠另有欄位，所以有 `.` / `:` 就算位址。
pub fn is_rustdesk_id(host: &str) -> bool {
    let h = normalize_id(host);
    !h.is_empty() && !h.contains('.') && !h.contains(':') && !h.eq_ignore_ascii_case("localhost")
}

/// ID 常被寫成 `123 456 789`：去掉空白。
pub fn normalize_id(host: &str) -> String {
    host.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 給輔助程式的第一則指令。
fn connect_command(p: &RustdeskParams) -> serde_json::Value {
    let mut v = json!({
        "t": "connect",
        "host": p.host,
        "port": p.port,
        "password": p.password,
        "decoders": { "vp9": true, "vp8": true, "av1": false },
        "my_name": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default(),
    });
    if let Some(r) = &p.rendezvous {
        v["peer"] = json!(p.host);
        v["rendezvous"] = json!(r);
    }
    v
}

pub async fn read_msg<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_le_bytes(len) as usize;
    if n == 0 || n > MAX_MSG {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad bridge message length"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

pub async fn write_json<W: AsyncWrite + Unpin>(w: &mut W, v: &serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(v).map_err(std::io::Error::other)?;
    write_typed(w, TYPE_JSON, &body).await
}

async fn write_typed<W: AsyncWrite + Unpin>(w: &mut W, ty: u8, body: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(5 + body.len());
    buf.extend_from_slice(&((body.len() + 1) as u32).to_le_bytes());
    buf.push(ty);
    buf.extend_from_slice(body);
    w.write_all(&buf).await?;
    w.flush().await
}

fn json_of(msg: &[u8]) -> Option<serde_json::Value> {
    (msg.first() == Some(&TYPE_JSON)).then(|| serde_json::from_slice(&msg[1..]).ok()).flatten()
}

/// 輔助程式的輸出（`None` = 結束了）。
type Output = mpsc::Receiver<std::io::Result<Vec<u8>>>;

/// 輔助程式的輸出交給專門的 task 讀：`read_msg` 不是取消安全的，直接放進 `select!` 跟前端的輸入一起等，
/// 輸入先到時讀到一半的訊息會掉，後面的長度標頭就全錯了。
fn spawn_reader<R: AsyncRead + Unpin + Send + 'static>(mut r: R) -> Output {
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        loop {
            let m = read_msg(&mut r).await;
            let end = !matches!(m, Ok(Some(_)));
            if let Some(m) = m.transpose() {
                if tx.send(m).await.is_err() {
                    break;
                }
            }
            if end {
                break;
            }
        }
    });
    rx
}

/// 已連上（登入完成）的輔助程式。
pub struct Connected {
    child: Child,
    stdin: ChildStdin,
    out: Output,
    /// 等對方按接受的期間使用者輸入、登入成功的密碼（呼叫端決定要不要記住）。
    pub answered: Option<AuthAnswer>,
    /// 登入成功的那則事件（前端要從裡面拿螢幕清單）。
    pub hello: Vec<u8>,
    /// 目前螢幕的大小（沒有資訊時 0）。
    pub size: (u16, u16),
    /// 跟對方之間有加密（經 ID 伺服器、驗過對方公鑰時）。
    pub secure: bool,
    /// `ip`（Direct IP）/ `direct`（打洞直連）/ `lan` / `relay`（經中繼伺服器）。
    pub route: String,
}

/// 啟動輔助程式並登入。密碼錯 → `RdAuth`（呼叫端重問密碼再來）。
///
/// 沒給密碼時輔助程式先送空密碼的登入、回 `waiting_accept`（對方畫面跳出「接受」）：這時跟官方用戶端一樣
/// 同時問密碼（`ask_password`），兩邊誰先好就用誰——對方按了接受，問到一半的對話框就收掉；先問到密碼就
/// 用同一條連線補送登入。在對話框按取消 = 不連了。
///
/// 對方開了雙重驗證（`need_2fa`）：問驗證碼（`ask_2fa(上一個錯了)`），在同一條連線送出；錯了再問。
pub async fn connect<F, Fut, G, GFut>(
    p: &RustdeskParams,
    timeout: Duration,
    ask_password: F,
    ask_2fa: G,
) -> AppResult<Connected>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<AuthAnswer>>,
    G: FnMut(bool) -> GFut,
    GFut: Future<Output = Option<String>>,
{
    let path = bridge_path().ok_or_else(|| {
        AppError::Rd(t!("找不到 RustDesk 連線元件（dbk-rustdesk-bridge），請重新安裝 db-kit").into())
    })?;
    let mut cmd = Command::new(&path);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不要閃一個主控台視窗
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Rd(tf!("無法啟動 RustDesk 連線元件：{e}", e = e)))?;
    let mut stdin = child.stdin.take().ok_or_else(|| AppError::Rd("bridge stdin".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::Rd("bridge stdout".into()))?;
    let mut out = spawn_reader(stdout);
    write_json(&mut stdin, &connect_command(p))
        .await
        .map_err(|e| AppError::Rd(tf!("RustDesk 連線元件沒有回應：{e}", e = e)))?;

    // 等登入結果（對方可能要在畫面上按「接受」，所以時間給長一點）。
    match wait_login(&mut out, &mut stdin, timeout, ask_password, ask_2fa).await {
        Ok(l) => Ok(Connected {
            child,
            stdin,
            out,
            answered: l.answered,
            hello: l.hello,
            size: l.size,
            secure: l.secure,
            route: l.route,
        }),
        Err(e) => {
            let _ = child.kill().await;
            Err(e)
        }
    }
}

/// 登入成功（`connected` 事件）。
struct LoggedIn {
    hello: Vec<u8>,
    size: (u16, u16),
    secure: bool,
    route: String,
    answered: Option<AuthAnswer>,
}

/// 讀輔助程式的事件直到登入有結果；`waiting_accept` 時問密碼、`need_2fa` 時問驗證碼（見 `connect`）。
/// `timeout` 從開始等、以及每次要驗證碼時重新起算（使用者要去翻驗證器 App）。
async fn wait_login<W, F, Fut, G, GFut>(
    out: &mut Output,
    stdin: &mut W,
    timeout: Duration,
    ask_password: F,
    mut ask_2fa: G,
) -> AppResult<LoggedIn>
where
    W: AsyncWrite + Unpin,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<AuthAnswer>>,
    G: FnMut(bool) -> GFut,
    GFut: Future<Output = Option<String>>,
{
    let mut ask = Some(ask_password);
    let mut asking: Option<Pin<Box<Fut>>> = None;
    let mut asking_2fa: Option<Pin<Box<GFut>>> = None;
    let mut answered = None;
    let mut deadline = tokio::time::Instant::now() + timeout;
    let gone = || AppError::Rd(t!("RustDesk 連線元件意外結束").into());
    loop {
        let answer = async {
            match asking.as_mut() {
                Some(f) => f.await,
                None => std::future::pending().await,
            }
        };
        let code = async {
            match asking_2fa.as_mut() {
                Some(f) => f.await,
                None => std::future::pending().await,
            }
        };
        let msg = tokio::select! {
            m = out.recv() => m,
            a = answer => {
                asking = None;
                let Some(a) = a else { return Err(AppError::RdCancelled) };
                // 空密碼 = 繼續等對方按接受。
                if !a.password.is_empty() {
                    write_json(stdin, &json!({ "t": "login", "password": a.password })).await.map_err(|_| gone())?;
                    answered = Some(a);
                }
                continue;
            }
            c = code => {
                asking_2fa = None;
                let Some(c) = c else { return Err(AppError::RdCancelled) };
                if c.trim().is_empty() {
                    asking_2fa = Some(Box::pin(ask_2fa(false)));
                } else {
                    write_json(stdin, &json!({ "t": "2fa", "code": c })).await.map_err(|_| gone())?;
                }
                continue;
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(AppError::Rd(t!("RustDesk 連線逾時（對方沒有回應，或沒有在畫面上按接受）").into()));
            }
        };
        let msg = match msg {
            Some(Ok(m)) => m,
            Some(Err(e)) => return Err(AppError::Rd(e.to_string())),
            None => return Err(gone()),
        };
        let Some(v) = json_of(&msg) else { continue };
        match v["type"].as_str() {
            Some("connected") => {
                let cur = v["peer"]["current_display"].as_u64().unwrap_or(0) as usize;
                let d = &v["peer"]["displays"][cur];
                let size = (d["width"].as_u64().unwrap_or(0) as u16, d["height"].as_u64().unwrap_or(0) as u16);
                let secure = v["secure"].as_bool().unwrap_or(false);
                let route = v["route"].as_str().unwrap_or("ip").to_string();
                return Ok(LoggedIn { hello: msg, size, secure, route, answered });
            }
            Some("waiting_accept") => {
                if let Some(f) = ask.take() {
                    asking = Some(Box::pin(f()));
                }
            }
            Some("need_2fa") => {
                // 密碼已過（或對方按了接受）：還開著的密碼對話框收掉，改問驗證碼。
                asking = None;
                ask = None;
                asking_2fa = Some(Box::pin(ask_2fa(v["wrong"].as_bool().unwrap_or(false))));
                deadline = tokio::time::Instant::now() + timeout;
            }
            Some("login_error") => {
                let m = v["message"].as_str().unwrap_or_default();
                // 錯太多次被對方暫時封鎖：再問密碼也沒用。
                return Err(if is_locked_out(m) {
                    AppError::Rd(login_error_text(m))
                } else {
                    AppError::RdAuth(login_error_text(m))
                });
            }
            Some("error") | Some("closed") => {
                let m = v["message"].as_str().or(v["reason"].as_str()).unwrap_or_default();
                return Err(AppError::Rd(bridge_error_text(v["code"].as_str(), m)));
            }
            _ => {}
        }
    }
}

/// 對方的防暴力破解（官方 `check_failure`）：一分鐘內錯超過 6 次、或累計超過 30 次。
fn is_locked_out(m: &str) -> bool {
    m.starts_with("Too many wrong attempts") || m == "Please try 1 minute later"
}

/// 對方回的登入錯誤 → 使用者看得懂的句子（原文附在後面，方便查）。
fn login_error_text(m: &str) -> String {
    match m {
        "Wrong Password" => t!("RustDesk 密碼錯誤").into(),
        "No Password Access" | "Password Required" => t!("對方要求輸入密碼").into(),
        // 輔助程式會把這兩個轉成 `need_2fa`；舊版輔助程式才會當成登入錯誤送來。
        "2FA Required" => t!("對方的 RustDesk 開啟了雙重驗證（2FA），需要輸入驗證碼").into(),
        "Wrong 2FA Code" => t!("雙重驗證碼錯誤").into(),
        "Please try 1 minute later" => t!("密碼或驗證碼錯誤次數太多，對方暫時拒絕登入：請一分鐘後再試").into(),
        _ if m.starts_with("Too many wrong attempts") => {
            t!("密碼或驗證碼錯誤次數太多，對方的 RustDesk 已封鎖這台電腦的登入：請對方重新啟動 RustDesk 後再試").into()
        }
        // 輔助程式自己的登入逾時（session.rs `LOGIN_TIMEOUT`）。
        "login timed out" => t!("對方一直沒有回應登入：沒有人在對方畫面上按「接受」。請輸入對方的 RustDesk 密碼").into(),
        _ if m.contains("denied") || m.contains("Denied") => tf!("對方拒絕了連線：{m}", m = m),
        _ => m.to_string(),
    }
}

/// 輔助程式的錯誤（`code` 見 rustdesk-bridge/src/rendezvous.rs）→ 使用者看得懂的句子；沒有 code = 原文。
fn bridge_error_text(code: Option<&str>, m: &str) -> String {
    match code {
        Some("id_not_exist") => t!("找不到這個 RustDesk ID：請確認 ID 沒有打錯，而且這裡的 ID 伺服器跟對方 RustDesk 設定的是同一台").into(),
        Some("offline") => t!("對方不在線上：對方電腦沒開 RustDesk，或它連不到 ID 伺服器").into(),
        Some("key_mismatch") => t!("ID 伺服器拒絕連線：Key 不符。請在連線設定填入 ID 伺服器的公鑰（跟對方 RustDesk 設定的 Key 相同）").into(),
        Some("key_overuse") => t!("ID 伺服器拒絕連線：這個 Key 的使用量已達上限").into(),
        Some("rendezvous_connect") => tf!("連不到 ID 伺服器：{m}", m = m),
        Some("rendezvous_timeout") => t!("ID 伺服器沒有回應（對方可能剛離線，稍後再試）").into(),
        Some("relay_connect") => tf!("連不到中繼伺服器：{m}", m = m),
        Some("relay_refused") => tf!("中繼伺服器拒絕連線：{m}", m = m),
        Some("relay_failed") => tf!("經中繼伺服器連線失敗：{m}", m = m),
        _ => m.to_string(),
    }
}

/// 工作階段：輔助程式的輸出轉給前端；前端的輸入（`rd_write` 的 JSON）轉給輔助程式。
/// 回傳結束原因（`None` = 使用者自己斷的）。
pub async fn run(c: Connected, mut ctl: mpsc::UnboundedReceiver<RdCtl>, sink: Sink) -> Option<String> {
    let Connected { mut child, mut stdin, mut out, hello, .. } = c;
    sink(hello);
    let reason = loop {
        tokio::select! {
            msg = out.recv() => match msg {
                Some(Ok(m)) => {
                    if let Some(v) = json_of(&m) {
                        if v["type"] == "closed" || v["type"] == "error" {
                            let r = v["reason"].as_str().or(v["message"].as_str()).unwrap_or_default().to_string();
                            break Some(if r.is_empty() { t!("遠端主機關閉了連線").to_string() } else { r });
                        }
                    }
                    sink(m);
                }
                Some(Err(_)) | None => break Some(t!("RustDesk 連線元件意外結束").to_string()),
            },
            m = ctl.recv() => {
                let cmd = match m {
                    // 前端直接送 JSON 指令（mouse / key），原樣轉。
                    Some(RdCtl::Write(bytes)) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                        Ok(v) => Some(v),
                        Err(_) => None,
                    },
                    Some(RdCtl::Keys(name)) if name == "ctrl_alt_del" => Some(json!({ "t": "ctrl_alt_del" })),
                    Some(RdCtl::Refresh) => Some(json!({ "t": "refresh" })),
                    Some(RdCtl::Close) | None => break None,
                    Some(_) => None,
                };
                if let Some(v) = cmd {
                    if write_json(&mut stdin, &v).await.is_err() {
                        break Some(t!("RustDesk 連線元件意外結束").to_string());
                    }
                }
            }
        }
    };
    // 關 stdin = 請它結束；等一下，還不走就砍掉。
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    reason
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn framing_roundtrip() {
        let mut buf = Vec::new();
        write_json(&mut buf, &json!({ "t": "refresh" })).await.unwrap();
        assert_eq!(&buf[..4], &((buf.len() - 4) as u32).to_le_bytes());
        let mut r = &buf[..];
        let m = read_msg(&mut r).await.unwrap().unwrap();
        assert_eq!(json_of(&m).unwrap()["t"], "refresh");
        assert!(read_msg(&mut r).await.unwrap().is_none());
    }

    fn event(v: serde_json::Value) -> std::io::Result<Vec<u8>> {
        let mut m = vec![TYPE_JSON];
        m.extend(serde_json::to_vec(&v).unwrap());
        Ok(m)
    }

    fn answer(pw: &str) -> AuthAnswer {
        AuthAnswer { username: String::new(), password: pw.into(), remember: true }
    }

    const T: Duration = Duration::from_secs(5);

    fn no_2fa(_: bool) -> std::future::Ready<Option<String>> {
        panic!("不該問驗證碼")
    }

    /// 等對方按接受時問到密碼 → 同一條連線補送 `login`；登入成功帶回輸入的密碼（給「記住密碼」）。
    #[tokio::test]
    async fn password_asked_while_waiting_for_accept() {
        let (tx, mut out) = mpsc::channel(8);
        let (mut stdin, mut bridge_in) = tokio::io::duplex(1 << 16);
        tx.send(event(json!({ "type": "waiting_accept" }))).await.unwrap();
        let bridge = tokio::spawn(async move {
            let m = read_msg(&mut bridge_in).await.unwrap().unwrap();
            let v = json_of(&m).unwrap();
            assert_eq!((v["t"].as_str(), v["password"].as_str()), (Some("login"), Some("pw")));
            tx.send(event(json!({ "type": "connected", "peer": { "current_display": 0, "displays": [{ "width": 1920, "height": 1080 }] }, "secure": true, "route": "relay" }))).await.unwrap();
        });
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let l = wait_login(&mut out, &mut stdin, T, || {
            asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Some(answer("pw")) }
        }, no_2fa)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
        bridge.await.unwrap();
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!((l.size, l.secure, l.route.as_str()), ((1920, 1080), true, "relay"));
        assert_eq!(l.answered.map(|a| a.password).as_deref(), Some("pw"));
    }

    /// 對方先按了接受：問到一半的密碼對話框收掉，照樣連上；沒有輸入密碼 → 不記住任何東西。
    #[tokio::test]
    async fn accepted_before_password_entered() {
        let (tx, mut out) = mpsc::channel(8);
        let (mut stdin, _bridge_in) = tokio::io::duplex(1 << 16);
        tx.send(event(json!({ "type": "waiting_accept" }))).await.unwrap();
        tx.send(event(json!({ "type": "connected", "peer": {}, "route": "lan" }))).await.unwrap();
        let l = wait_login(&mut out, &mut stdin, T, || std::future::pending::<Option<AuthAnswer>>(), no_2fa).await.unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(l.route, "lan");
        assert!(l.answered.is_none());
    }

    #[tokio::test]
    async fn cancelling_the_password_prompt_cancels_the_connection() {
        let (tx, mut out) = mpsc::channel(8);
        let (mut stdin, _bridge_in) = tokio::io::duplex(1 << 16);
        tx.send(event(json!({ "type": "waiting_accept" }))).await.unwrap();
        let r = wait_login(&mut out, &mut stdin, T, || async { None }, no_2fa).await;
        assert!(matches!(r, Err(AppError::RdCancelled)));
        drop(tx);
    }

    /// 有給密碼（沒有 `waiting_accept`）就不問；輔助程式的輸出結束 → 錯誤而不是卡住。
    #[tokio::test]
    async fn no_prompt_without_waiting_accept() {
        let (tx, mut out) = mpsc::channel(8);
        let (mut stdin, _bridge_in) = tokio::io::duplex(1 << 16);
        tx.send(event(json!({ "type": "login_error", "message": "login timed out" }))).await.unwrap();
        let r = wait_login(&mut out, &mut stdin, T, || async { panic!("不該問密碼") }, no_2fa).await;
        assert!(matches!(r, Err(AppError::RdAuth(ref m)) if m.contains("接受")), "{:?}", r.err());
        drop(tx);
        let r = wait_login(&mut out, &mut stdin, T, || async { None }, no_2fa).await;
        assert!(matches!(r, Err(AppError::Rd(_))));
    }

    /// 對方開了雙重驗證：還開著的密碼對話框收掉、改問驗證碼，送到同一條連線；錯了帶「錯了」再問一次。
    #[tokio::test]
    async fn two_factor_code_asked_and_resent_when_wrong() {
        let (tx, mut out) = mpsc::channel(8);
        let (mut stdin, mut bridge_in) = tokio::io::duplex(1 << 16);
        tx.send(event(json!({ "type": "waiting_accept" }))).await.unwrap();
        tx.send(event(json!({ "type": "need_2fa", "wrong": false }))).await.unwrap();
        let bridge = tokio::spawn(async move {
            for (code, reply) in [("111111", json!({ "type": "need_2fa", "wrong": true })), ("222222", json!({ "type": "connected", "peer": {} }))] {
                let v = json_of(&read_msg(&mut bridge_in).await.unwrap().unwrap()).unwrap();
                assert_eq!((v["t"].as_str(), v["code"].as_str()), (Some("2fa"), Some(code)));
                tx.send(event(reply)).await.unwrap();
            }
        });
        let asked = std::sync::Mutex::new(Vec::new());
        let l = wait_login(&mut out, &mut stdin, T, || std::future::pending::<Option<AuthAnswer>>(), |wrong| {
            let mut a = asked.lock().unwrap();
            a.push(wrong);
            std::future::ready(Some(if a.len() == 1 { "111111" } else { "222222" }.to_string()))
        })
        .await
        .unwrap_or_else(|e| panic!("{e}"));
        bridge.await.unwrap();
        assert_eq!(*asked.lock().unwrap(), [false, true]);
        assert!(l.answered.is_none(), "驗證碼不是密碼，不記住");
    }

    #[tokio::test]
    async fn cancelling_the_2fa_prompt_cancels_the_connection() {
        let (tx, mut out) = mpsc::channel(8);
        let (mut stdin, _bridge_in) = tokio::io::duplex(1 << 16);
        tx.send(event(json!({ "type": "need_2fa", "wrong": false }))).await.unwrap();
        let r = wait_login(&mut out, &mut stdin, T, || async { None }, |_| async { None }).await;
        assert!(matches!(r, Err(AppError::RdCancelled)), "{:?}", r.err());
    }

    /// 錯太多次被對方暫時封鎖：一般錯誤（不再重問密碼），說清楚要等多久。
    #[tokio::test]
    async fn lockout_is_not_a_password_retry() {
        let (tx, mut out) = mpsc::channel(8);
        let (mut stdin, _bridge_in) = tokio::io::duplex(1 << 16);
        tx.send(event(json!({ "type": "login_error", "message": "Please try 1 minute later" }))).await.unwrap();
        let r = wait_login(&mut out, &mut stdin, T, || async { None }, no_2fa).await;
        assert!(matches!(r, Err(AppError::Rd(ref m)) if m.contains("一分鐘")), "{:?}", r.err());
    }

    /// 讀取 task：每則訊息原樣轉、結束時關掉 channel（也驗證讀到一半不會因為接收端在 select! 裡被取消而掉資料）。
    #[tokio::test]
    async fn reader_task_forwards_whole_messages() {
        let (mut w, r) = tokio::io::duplex(64);
        let mut out = spawn_reader(r);
        let big = json!({ "t": "x".repeat(1000) });
        let writer = tokio::spawn(async move {
            for _ in 0..20 {
                write_json(&mut w, &big).await.unwrap();
            }
        });
        let mut got = 0;
        loop {
            tokio::select! {
                m = out.recv() => match m {
                    Some(Ok(m)) => {
                        assert_eq!(json_of(&m).unwrap()["t"].as_str().map(str::len), Some(1000));
                        got += 1;
                    }
                    Some(Err(e)) => panic!("{e}"),
                    None => break,
                },
                // 一直有另一邊先好、把 recv 取消掉
                _ = tokio::task::yield_now() => {}
            }
        }
        writer.await.unwrap();
        assert_eq!(got, 20);
    }

    #[test]
    fn login_errors_are_readable() {
        assert_eq!(login_error_text("Wrong Password"), "RustDesk 密碼錯誤");
        assert_eq!(login_error_text("weird"), "weird");
        assert!(login_error_text("2FA Required").contains("雙重驗證"));
        assert!(is_locked_out("Too many wrong attempts for IPv6 prefix /64") && !is_locked_out("Wrong Password"));
        assert!(login_error_text("Too many wrong attempts").contains("封鎖"));
        assert!(bridge_error_text(Some("key_mismatch"), "Key mismatch").contains("Key"));
        assert!(bridge_error_text(Some("relay_connect"), "connect x: timed out").ends_with("connect x: timed out"));
        assert_eq!(bridge_error_text(None, "raw"), "raw");
        assert_eq!(bridge_error_text(Some("future_code"), "raw"), "raw", "不認得的 code → 原文");
    }

    #[test]
    fn id_or_address() {
        for id in ["216830407", "216 830 407", "my_office-pc"] {
            assert!(is_rustdesk_id(id), "{id}");
        }
        for addr in ["192.168.1.5", "rd.example.com", "::1", "fe80::1", "localhost", "LOCALHOST", "", "  "] {
            assert!(!is_rustdesk_id(addr), "{addr}");
        }
        assert_eq!(normalize_id(" 216 830 407 "), "216830407");
    }

    #[test]
    fn connect_command_carries_rendezvous_only_for_ids() {
        let mut p = RustdeskParams { host: "10.0.0.5".into(), port: 21118, password: "pw".into(), rendezvous: None };
        let v = connect_command(&p);
        assert_eq!((v["host"].as_str(), v["port"].as_u64()), (Some("10.0.0.5"), Some(21118)));
        assert!(v.get("rendezvous").is_none() && v.get("peer").is_none(), "Direct IP：沒有 rendezvous");
        p.host = "216830407".into();
        p.rendezvous = Some(Rendezvous { server: "proxy.example.com".into(), key: "K=".into(), force_relay: true, ..Default::default() });
        let v = connect_command(&p);
        assert_eq!(v["peer"], "216830407");
        assert_eq!(v["rendezvous"], json!({ "server": "proxy.example.com", "relay": "", "key": "K=", "force_relay": true }));
        assert!(!format!("{p:?}").contains("pw"), "Debug 不印密碼");
    }

    #[test]
    fn env_override_wins() {
        std::env::set_var("DBKIT_RUSTDESK_BRIDGE", "C:/x/bridge.exe");
        assert_eq!(bridge_path(), Some(PathBuf::from("C:/x/bridge.exe")));
        std::env::remove_var("DBKIT_RUSTDESK_BRIDGE");
    }
}
