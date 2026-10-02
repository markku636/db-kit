// dbk-rustdesk-bridge：db-kit 的 RustDesk 相容連線輔助程式（AGPL-3.0，獨立程式；見 README.md）。
//
// db-kit 啟動它、從 stdin 送一則 `connect`，之後：
// - stdin 來的 JSON 指令（滑鼠 / 鍵盤 / 重送畫面）轉成 RustDesk 封包送給對方；
// - 對方送來的畫面原封不動（仍是 VP9 / VP8 / AV1 位元流）從 stdout 交給 db-kit，事件則是 JSON。
// stdin 關閉 = db-kit 要斷線，程式結束。
//
// 兩種接法：`rendezvous` 欄位有值 = 用 RustDesk ID 經 ID 伺服器（rendezvous.rs，直連打洞或中繼），
// 否則是 Direct IP（直接 TCP 連 `host:port`）。
//
// SPDX-License-Identifier: AGPL-3.0-only

mod codec;
mod crypto;
mod files;
mod ipc;
mod keymap;
mod rendezvous;
mod session;

mod proto {
    include!(concat!(env!("OUT_DIR"), "/protos/mod.rs"));
}

use std::time::Duration;

use protobuf::Message as _;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use codec::FrameReader;
use crypto::Cipher;
use proto::message::{message, Message, PublicKey};
use session::{Command, Decoders, Incoming};

/// 第一則指令。
#[derive(Debug, serde::Deserialize)]
struct Connect {
    #[serde(default)]
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    /// 登入用的對方識別：經 ID 伺服器時是對方 ID；Direct IP 時就是位址（跟官方用戶端一樣）；空 = 用 host。
    #[serde(default)]
    peer: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    decoders: Decoders,
    #[serde(default)]
    my_name: String,
    /// 有值 = 用 `peer`（RustDesk ID）經 ID 伺服器連線。
    #[serde(default)]
    rendezvous: Option<rendezvous::Params>,
    /// 本機識別碼（base64，db-kit 第一次用時隨機產生）：使用者勾「信任這台裝置」時送給對方記住。空 = 不提供。
    #[serde(default)]
    hwid: String,
    /// 之前對這台勾過「信任這台裝置」：登入時就帶 hwid，對方認得就不再問驗證碼。
    #[serde(default)]
    trusted: bool,
    /// 傳檔連線（另一條連線，不收畫面；指令見 files.rs）。
    #[serde(default)]
    file_transfer: bool,
}

fn default_port() -> u16 {
    21118
}

/// 加密握手等對方第一則訊息的時間（官方 `READ_TIMEOUT`）。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(18);

/// 登入要用的東西 + 接上的方式（給 `connected` 事件）。
struct Login {
    peer_id: String,
    password: String,
    decoders: Decoders,
    my_name: String,
    /// ID 伺服器簽過名的對方公鑰（`PunchHoleResponse.pk` / `RelayResponse.pk`）；空 = 沒辦法驗 → 不加密。
    signed_id_pk: Vec<u8>,
    /// ID 伺服器的公鑰（驗 `signed_id_pk` 用）。
    server_key: String,
    /// `ip` / `direct` / `lan` / `relay`。
    route: &'static str,
    /// 見 `Connect.hwid` / `Connect.trusted`。
    hwid: Vec<u8>,
    trusted: bool,
    /// 見 `Connect.file_transfer`。
    file_transfer: bool,
}

impl Login {
    fn new(peer_id: String, password: String, decoders: Decoders, my_name: String) -> Self {
        Self {
            peer_id,
            password,
            decoders,
            my_name,
            signed_id_pk: Vec::new(),
            server_key: String::new(),
            route: "ip",
            hwid: Vec::new(),
            trusted: false,
            file_transfer: false,
        }
    }

    fn request(&self, proof: Vec<u8>, session_id: u64) -> Message {
        let hwid = if self.trusted { &self.hwid[..] } else { &[] };
        let mut m = session::login_request(&self.peer_id, proof, self.decoders, session_id, &self.my_name, hwid);
        if self.file_transfer {
            session::as_file_transfer(&mut m);
        }
        m
    }
}

/// 失敗：`code` 讓 db-kit 翻譯（沒有 = 用 `message` 原文）。
struct Fail {
    code: Option<&'static str>,
    message: String,
}

impl From<String> for Fail {
    fn from(message: String) -> Self {
        Self { code: None, message }
    }
}

impl From<rendezvous::Fail> for Fail {
    fn from(f: rendezvous::Fail) -> Self {
        Self { code: Some(f.code), message: f.message }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let code = match run(stdin, &mut stdout).await {
        Ok(()) => 0,
        Err(e) => {
            let _ = ipc::write_json(&mut stdout, &json!({ "type": "error", "code": e.code, "message": e.message })).await;
            1
        }
    };
    std::process::exit(code);
}

async fn run<I, O>(stdin: I, stdout: &mut O) -> Result<(), Fail>
where
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
{
    // 1. 等 connect。
    let mut stdin = ipc::MsgReader::new(stdin);
    let first = stdin.next().await.map_err(|e| e.to_string())?;
    let Some(ipc::HostMsg::Json(v)) = first else { return Ok(()) };
    let c: Connect = serde_json::from_value(v).map_err(|e| format!("bad connect: {e}"))?;
    let peer_id = if c.peer.is_empty() { c.host.clone() } else { c.peer.clone() };
    let mut login = Login::new(peer_id, c.password, c.decoders, c.my_name);
    // 格式不對就當沒有（只是少了「信任這台裝置」，不該讓連線失敗）。
    login.hwid = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, c.hwid.trim()).unwrap_or_default();
    login.trusted = c.trusted && !login.hwid.is_empty();
    login.file_transfer = c.file_transfer;
    let tcp = match &c.rendezvous {
        Some(rp) => {
            let est = rendezvous::connect(&login.peer_id, rp).await?;
            login.signed_id_pk = est.signed_id_pk;
            login.server_key = rp.key();
            login.route = est.route;
            est.stream
        }
        None => {
            let addr = format!("{}:{}", c.host, c.port);
            let tcp = tokio::time::timeout(session::CONNECT_TIMEOUT, TcpStream::connect(&addr))
                .await
                .map_err(|_| format!("connect {addr}: timed out"))?
                .map_err(|e| format!("connect {addr}: {e}"))?;
            let _ = tcp.set_nodelay(true);
            tcp
        }
    };
    Ok(drive(tcp, &mut stdin, stdout, &login).await?)
}

/// 送一則空訊息（官方：不加密時告訴對方「不做金鑰交換」）。
async fn send_empty<W: AsyncWrite + Unpin>(w: &mut W) -> Result<(), String> {
    codec::write_frame(w, &[]).await.map_err(|e| e.to_string())
}

/// 跟對方的加密握手（`secure_connection`）。
///
/// 驗得過 ID 伺服器簽的對方公鑰時：等對方的 `SignedId`（對方用自己的簽章金鑰簽的「ID + 一次性 box 公鑰」），
/// 產生對稱金鑰封給它（`PublicKey`），之後雙向加密。驗不過 / 沒有簽章（Direct IP、ID 伺服器沒設 Key）時照官方
/// 送一則空訊息、不加密繼續。回傳 `(送出用, 收進用, 握手時讀到但不是 SignedId 的訊息)`。
async fn secure_handshake<R, W>(
    reader: &mut FrameReader<R>,
    w: &mut W,
    login: &Login,
) -> Result<(Option<Cipher>, Option<Cipher>, Option<Vec<u8>>), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let sign_pk = (!login.signed_id_pk.is_empty())
        .then(|| crypto::server_key(&login.server_key))
        .flatten()
        .and_then(|k| crypto::decode_id_pk(&login.signed_id_pk, &k))
        .filter(|(id, _)| *id == login.peer_id)
        .map(|(_, pk)| pk);
    let Some(sign_pk) = sign_pk else {
        send_empty(w).await?;
        return Ok((None, None, None));
    };
    let first = tokio::time::timeout(HANDSHAKE_TIMEOUT, reader.next())
        .await
        .map_err(|_| "handshake timed out".to_string())?
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Reset by the peer".to_string())?;
    let si = match Message::parse_from_bytes(&first) {
        Ok(Message { union: Some(message::Union::SignedId(si)), .. }) => si,
        // 對方沒走加密：跟官方一樣回空訊息、不加密；那則訊息照常處理（官方會丟掉它）。
        _ => {
            send_empty(w).await?;
            return Ok((None, None, Some(first)));
        }
    };
    match crypto::decode_id_pk(&si.id, &sign_pk) {
        Some((id, their_box_pk)) if id == login.peer_id => {
            let (our_pk, sealed, key) = crypto::seal_symmetric_key(their_box_pk);
            let mut m = Message::new();
            // kx_version 不填 = 0（兩個方向同一把金鑰）；新版對方宣告 1 時仍接受 0。
            m.set_public_key(PublicKey {
                asymmetric_value: our_pk.to_vec().into(),
                symmetric_value: sealed.into(),
                ..Default::default()
            });
            session::send(w, &m).await.map_err(|e| e.to_string())?;
            Ok((Some(Cipher::new(&key)), Some(Cipher::new(&key)), None))
        }
        Some(_) => {
            send_empty(w).await?;
            Ok((None, None, None))
        }
        None => {
            // 官方：pk 對不上就退回不加密（送空的 PublicKey）。
            let mut m = Message::new();
            m.set_public_key(PublicKey::new());
            session::send(w, &m).await.map_err(|e| e.to_string())?;
            Ok((None, None, None))
        }
    }
}

/// 連上之後的主迴圈（泛型 stream：測試用 duplex 當對方）。
async fn drive<S, I, O>(peer: S, stdin: &mut ipc::MsgReader<I>, stdout: &mut O, login: &Login) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
{
    let (pr, mut pw) = tokio::io::split(peer);
    let mut pr = FrameReader::new(pr);
    let (mut tx, mut rx, mut pending) = secure_handshake(&mut pr, &mut pw, login).await?;
    let secure = tx.is_some();

    let session_id: u64 = {
        use std::hash::{BuildHasher, Hasher};
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(std::process::id() as u64);
        h.finish()
    };
    let mut logged_in = false;
    let mut login_deadline = tokio::time::Instant::now() + session::LOGIN_TIMEOUT;
    // 對方的登入挑戰：沒密碼先送空的等對方按接受，期間 db-kit 問到密碼再用同一題重送登入（官方 `handle_login_from_ui`）。
    let mut hash: Option<(String, String)> = None;
    // 對方回了 `2FA Required`：連線留著，等 db-kit 問到驗證碼（`{"t":"2fa"}`）再送。
    let mut awaiting_2fa = false;
    // 對方允許「信任這台裝置」（`2FA Required` 那則帶的；`Wrong 2FA Code` 不帶，沿用）。
    let mut trust_offered = false;
    // 登入後才知道的對方資訊（送 Ctrl+Alt+Del 要看對方是不是 Windows）。
    let mut peer = session::PeerCtx::default();
    // 傳檔連線的工作（列目錄 / 上傳 / 下載…，見 files.rs）。
    let mut files = login.file_transfer.then(files::Files::new);
    // 截圖：我們送的編號 → 存檔路徑（對方回的編號不當路徑用：沒要過的截圖不寫檔）。
    // 等對方回覆的截圖（session id）。
    let mut shots: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut shot_seq: u32 = 0;

    loop {
        // 兩個讀取端都是取消安全的（select! 另一邊先好時，讀到一半的封包不會掉）。
        let data = if let Some(p) = pending.take() {
            Ok(Some(p))
        } else {
            let wait_login = {
                let (logged_in, deadline) = (logged_in, login_deadline);
                async move {
                    if logged_in {
                        std::future::pending::<()>().await
                    } else {
                        tokio::time::sleep_until(deadline).await
                    }
                }
            };
            tokio::select! {
                data = pr.next() => data,
                msg = stdin.next() => {
                    match msg {
                        Ok(Some(ipc::HostMsg::Json(v))) if v["t"] == "login" => {
                            let password = v["password"].as_str().unwrap_or_default();
                            if let (Some((salt, challenge)), false) = (&hash, logged_in || password.is_empty()) {
                                let proof = session::password_proof(password, salt, challenge);
                                let m = login.request(proof, session_id);
                                session::send_sealed(&mut pw, &m, &mut tx).await.map_err(|e| e.to_string())?;
                                login_deadline = tokio::time::Instant::now() + session::LOGIN_TIMEOUT;
                            }
                        }
                        Ok(Some(ipc::HostMsg::Json(v))) if v["t"] == "2fa" => {
                            let code = v["code"].as_str().unwrap_or_default();
                            if awaiting_2fa && !logged_in && !code.trim().is_empty() {
                                // `trust` = 使用者勾了「信任這台裝置」（官方 `send2fa(code, trust_this_device)`）。
                                let hwid = if v["trust"] == true { &login.hwid[..] } else { &[] };
                                session::send_sealed(&mut pw, &session::auth_2fa(code, hwid), &mut tx).await.map_err(|e| e.to_string())?;
                                login_deadline = tokio::time::Instant::now() + session::LOGIN_TIMEOUT;
                            }
                        }
                        Ok(Some(ipc::HostMsg::Json(v))) if v["t"] == "screenshot" => {
                            // 官方 `ScreenshotRequest`：對方從那個螢幕的下一張畫面擷取、編成 PNG 回來（db-kit 存檔）。
                            if logged_in {
                                shot_seq += 1;
                                let sid = format!("dbk-{shot_seq}");
                                shots.insert(sid.clone());
                                let display = v["display"].as_i64().unwrap_or(0) as i32;
                                session::send_sealed(&mut pw, &session::screenshot_request(display, sid), &mut tx).await.map_err(|e| e.to_string())?;
                            }
                        }
                        Ok(Some(ipc::HostMsg::Json(v))) if files.is_some() && v["t"].as_str().is_some_and(|t| t.starts_with("fs_")) => {
                            if let (Ok(c), true, Some(f)) = (serde_json::from_value::<files::FsCommand>(v), logged_in, files.as_mut()) {
                                let out = f.command(c).await;
                                flush_files(out, &mut pw, &mut tx, stdout).await?;
                            }
                        }
                        Ok(Some(ipc::HostMsg::Json(v))) => {
                            // 格式不對的指令略過（db-kit 的 bug 不該讓連線斷掉）。
                            if let Ok(c) = serde_json::from_value::<Command>(v) {
                                if logged_in {
                                    for m in session::command_messages(&c, &peer) {
                                        session::send_sealed(&mut pw, &m, &mut tx).await.map_err(|e| e.to_string())?;
                                    }
                                }
                            }
                        }
                        Ok(Some(ipc::HostMsg::Other)) => {}
                        // stdin 關了：db-kit 要斷線。
                        Ok(None) | Err(_) => {
                            if let Some(f) = files.as_mut() {
                                f.close().await;
                            }
                            return Ok(());
                        }
                    }
                    continue;
                }
                // 上傳：每輪送一塊（送完才回來收對方的封包，對方的確認 / 錯誤不會被擋住太久）。
                _ = std::future::ready(()), if logged_in && files.as_ref().is_some_and(|f| f.has_upload_work()) => {
                    if let Some(f) = files.as_mut() {
                        let out = f.upload_step().await;
                        flush_files(out, &mut pw, &mut tx, stdout).await?;
                    }
                    continue;
                }
                _ = wait_login => {
                    emit(stdout, json!({ "type": "login_error", "message": "login timed out" })).await?;
                    return Ok(());
                }
            }
        };
        let data = data.and_then(|d| match (d, rx.as_mut()) {
            (Some(d), Some(c)) => c.open(d).map(Some),
            (d, _) => Ok(d),
        });
        let data = match data {
            Ok(Some(d)) => d,
            Ok(None) => {
                emit(stdout, json!({ "type": "closed", "reason": "remote closed the connection" })).await?;
                return Ok(());
            }
            Err(e) => {
                emit(stdout, json!({ "type": "closed", "reason": e.to_string() })).await?;
                return Ok(());
            }
        };
        match session::classify(&data) {
            Incoming::Hash { salt, challenge } => {
                let proof = session::password_proof(&login.password, &salt, &challenge);
                let m = login.request(proof, session_id);
                session::send_sealed(&mut pw, &m, &mut tx).await.map_err(|e| e.to_string())?;
                if login.password.is_empty() {
                    emit(stdout, json!({ "type": "waiting_accept" })).await?;
                }
                hash = Some((salt, challenge));
            }
            Incoming::LoggedIn(pi) => {
                logged_in = true;
                peer.platform = pi.platform.clone();
                emit(stdout, json!({ "type": "connected", "peer": pi, "secure": secure, "route": login.route })).await?;
            }
            Incoming::LoginError(e) => {
                emit(stdout, json!({ "type": "login_error", "message": e })).await?;
                return Ok(());
            }
            Incoming::Need2fa { wrong, trust } => {
                awaiting_2fa = true;
                if !wrong {
                    trust_offered = trust;
                }
                // 使用者要去翻驗證器 App：從現在起重新計時。
                login_deadline = tokio::time::Instant::now() + session::LOGIN_TIMEOUT;
                let trust = trust_offered && !login.hwid.is_empty();
                emit(stdout, json!({ "type": "need_2fa", "wrong": wrong, "trust": trust })).await?;
            }
            Incoming::NoPasswordAccess => {
                // 密碼對這台沒用：對方畫面已跳出連線請求，按了接受就會回 peer_info（或要驗證碼）。
                login_deadline = tokio::time::Instant::now() + session::LOGIN_TIMEOUT;
                emit(stdout, json!({ "type": "waiting_accept", "click_only": true })).await?;
            }
            Incoming::Frames(frames) => {
                for f in frames {
                    ipc::write_video(stdout, &f).await.map_err(|e| e.to_string())?;
                }
            }
            Incoming::Displays(displays) if logged_in => {
                emit(stdout, json!({ "type": "displays", "displays": displays })).await?;
            }
            Incoming::DisplayChanged(d) if logged_in => {
                let mut v = json!(d);
                v["type"] = json!("switch_display");
                emit(stdout, v).await?;
            }
            Incoming::Displays(_) | Incoming::DisplayChanged(_) => {}
            Incoming::Echo { msg, delay, bitrate } => {
                session::send_sealed(&mut pw, &msg, &mut tx).await.map_err(|e| e.to_string())?;
                if logged_in {
                    emit(stdout, json!({ "type": "delay", "ms": delay, "bitrate": bitrate })).await?;
                }
            }
            // 權限一開始（登入回覆之後）就會送，這時已經登入了。
            Incoming::Permission { name, enabled } => {
                emit(stdout, json!({ "type": "permission", "name": name, "enabled": enabled })).await?;
            }
            Incoming::Clipboard(text) if logged_in => {
                emit(stdout, json!({ "type": "clipboard", "text": text })).await?;
            }
            Incoming::Chat(text) if logged_in => {
                emit(stdout, json!({ "type": "chat", "text": text })).await?;
            }
            Incoming::BlockInput { on, ok } => {
                emit(stdout, json!({ "type": "block_input", "on": on, "ok": ok })).await?;
            }
            Incoming::MsgBox(mb) if logged_in => {
                let mut v = json!(mb);
                v["type"] = json!("msgbox");
                emit(stdout, v).await?;
            }
            Incoming::Clipboard(_) | Incoming::Chat(_) | Incoming::MsgBox(_) => {}
            Incoming::Closed(reason) => {
                if let Some(f) = files.as_mut() {
                    f.close().await;
                }
                emit(stdout, json!({ "type": "closed", "reason": reason })).await?;
                return Ok(());
            }
            Incoming::FileResponse(fr) if logged_in => {
                if let Some(f) = files.as_mut() {
                    let out = f.on_response(fr).await;
                    flush_files(out, &mut pw, &mut tx, stdout).await?;
                }
            }
            Incoming::FileAction(fa) if logged_in => {
                if let Some(f) = files.as_mut() {
                    let out = f.on_action(fa).await;
                    flush_files(out, &mut pw, &mut tx, stdout).await?;
                }
            }
            Incoming::FileResponse(_) | Incoming::FileAction(_) => {}
            Incoming::CursorData(c) if logged_in => {
                let rgba = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &c.rgba);
                emit(stdout, json!({ "type": "cursor_data", "id": c.id, "hotx": c.hotx, "hoty": c.hoty, "width": c.width, "height": c.height, "rgba": rgba })).await?;
            }
            Incoming::CursorId(id) if logged_in => emit(stdout, json!({ "type": "cursor_id", "id": id })).await?,
            Incoming::CursorPosition { x, y } if logged_in => emit(stdout, json!({ "type": "cursor_position", "x": x, "y": y })).await?,
            Incoming::FollowDisplay(d) if logged_in => emit(stdout, json!({ "type": "follow_display", "display": d })).await?,
            Incoming::CursorData(_) | Incoming::CursorId(_) | Incoming::CursorPosition { .. } | Incoming::FollowDisplay(_) => {}
            Incoming::Screenshot { sid, msg, data } => {
                if shots.remove(&sid) {
                    if !msg.is_empty() {
                        emit(stdout, json!({ "type": "screenshot", "error": msg })).await?;
                    } else if data.is_empty() {
                        emit(stdout, json!({ "type": "screenshot", "error": "empty screenshot" })).await?;
                    } else {
                        let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
                        emit(stdout, json!({ "type": "screenshot", "png": png })).await?;
                    }
                }
            }
            Incoming::Ignore => {}
        }
    }
}

async fn emit<O: AsyncWrite + Unpin>(stdout: &mut O, v: serde_json::Value) -> Result<(), String> {
    ipc::write_json(stdout, &v).await.map_err(|e| e.to_string())
}

/// 傳檔這一步的結果：封包送給對方、事件交給 db-kit。
async fn flush_files<W, O>(out: files::Out, pw: &mut W, tx: &mut Option<crypto::Cipher>, stdout: &mut O) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
    O: AsyncWrite + Unpin,
{
    for m in &out.send {
        session::send_sealed(pw, m, tx).await.map_err(|e| e.to_string())?;
    }
    for v in out.events {
        emit(stdout, v).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::message::{
        login_response, EncodedVideoFrame, EncodedVideoFrames, Hash, LoginResponse, PeerInfo, SignedId, VideoFrame,
    };
    use ed25519_dalek::{Signer, SigningKey};

    async fn send_peer<W: AsyncWrite + Unpin>(w: &mut W, m: &Message) {
        session::send(w, m).await.unwrap();
    }

    fn direct(peer_id: &str, password: &str, decoders: Decoders, my_name: &str) -> Login {
        Login::new(peer_id.into(), password.into(), decoders, my_name.into())
    }

    fn logged_in_msg(hostname: &str) -> Message {
        let mut m = Message::new();
        let mut resp = LoginResponse::new();
        let mut pi = PeerInfo::new();
        pi.hostname = hostname.into();
        resp.union = Some(login_response::Union::PeerInfo(pi));
        m.set_login_response(resp);
        m
    }

    fn hash_msg(salt: &str, challenge: &str) -> Message {
        let mut m = Message::new();
        m.set_hash(Hash { salt: salt.into(), challenge: challenge.into(), ..Default::default() });
        m
    }

    /// 端到端：假的 RustDesk 被控端（duplex）↔ drive ↔ 假的 db-kit（兩條 duplex 當 stdin / stdout）。
    #[tokio::test]
    async fn login_then_video_then_input() {
        let (ours, mut theirs) = tokio::io::duplex(1 << 20);
        let (mut host_in_w, host_in_r) = tokio::io::duplex(1 << 20);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(ours, &mut stdin, &mut host_out_w, &direct("10.0.0.5", "pw", Decoders::default(), "pc")).await
        });

        // 被控端：先收到空訊息
        let first = codec::read_frame(&mut theirs).await.unwrap().unwrap();
        assert!(first.is_empty(), "Direct IP 先送空訊息");
        // 出題
        send_peer(&mut theirs, &hash_msg("salt", "chal")).await;
        // 收到登入：密碼證明正確
        let lr = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        let Some(message::Union::LoginRequest(lr)) = lr.union else { panic!("expect login") };
        assert_eq!(&lr.password[..], &session::password_proof("pw", "salt", "chal")[..]);
        assert_eq!(lr.username, "10.0.0.5");
        // 登入成功
        send_peer(&mut theirs, &logged_in_msg("office-pc")).await;
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => {
                assert_eq!(v["type"], "connected");
                assert_eq!(v["peer"]["hostname"], "office-pc");
                assert_eq!((v["secure"].as_bool(), v["route"].as_str()), (Some(false), Some("ip")));
            }
            x => panic!("{x:?}"),
        }
        // 畫面：原封不動轉出去
        let mut m = Message::new();
        let mut vf = VideoFrame::new();
        vf.set_vp9s(EncodedVideoFrames {
            frames: vec![EncodedVideoFrame { data: vec![1, 2, 3].into(), key: true, pts: 99, ..Default::default() }],
            ..Default::default()
        });
        m.set_video_frame(vf);
        send_peer(&mut theirs, &m).await;
        let raw = ipc::read_raw(&mut host_out_r).await.unwrap().unwrap();
        assert_eq!(raw[0], ipc::OUT_VIDEO);
        assert_eq!(&raw[1..5], &[1, 1, 0, 0], "codec VP9、關鍵畫面、display 0");
        assert_eq!(i64::from_le_bytes(raw[5..13].try_into().unwrap()), 99);
        assert_eq!(&raw[13..], &[1, 2, 3]);
        // db-kit 的按鍵 → 對方收到 KeyEvent
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "key", "down": true, "scancode": 30 })).await.unwrap();
        let k = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        assert!(matches!(k.union, Some(message::Union::KeyEvent(_))));
        // 切到第 2 個螢幕 → 對方依序收到 SwitchDisplay / CaptureDisplays / RefreshVideoDisplay
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "displays", "set": [1] })).await.unwrap();
        let mut got = Vec::new();
        for _ in 0..3 {
            let m = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
            let Some(message::Union::Misc(ms)) = m.union else { panic!("expect misc") };
            got.push(ms.union.unwrap());
        }
        assert!(matches!(&got[..], [
            proto::message::misc::Union::SwitchDisplay(s),
            proto::message::misc::Union::CaptureDisplays(c),
            proto::message::misc::Union::RefreshVideoDisplay(1),
        ] if s.display == 1 && c.set == [1]), "{got:?}");
        // 對方回報切過去的螢幕位置大小 → 事件 switch_display
        let mut m = Message::new();
        let mut misc = proto::message::Misc::new();
        misc.set_switch_display(proto::message::SwitchDisplay { display: 1, x: 1920, y: 0, width: 1280, height: 1024, ..Default::default() });
        m.set_misc(misc);
        send_peer(&mut theirs, &m).await;
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => {
                assert_eq!(v, json!({ "type": "switch_display", "display": 1, "x": 1920, "y": 0, "width": 1280, "height": 1024 }));
            }
            x => panic!("{x:?}"),
        }
        // 插拔螢幕：對方送新的 PeerInfo → 事件 displays
        let mut m = Message::new();
        let mut pi = PeerInfo::new();
        pi.displays = vec![proto::message::DisplayInfo { width: 1920, height: 1080, ..Default::default() }];
        m.set_peer_info(pi);
        send_peer(&mut theirs, &m).await;
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => {
                assert_eq!(v["type"], "displays");
                assert_eq!(v["displays"].as_array().map(Vec::len), Some(1));
                assert_eq!(v["displays"][0]["width"], 1920);
            }
            x => panic!("{x:?}"),
        }
        // stdin 關閉 → 結束
        drop(host_in_w);
        assert!(task.await.unwrap().is_ok());
    }

    /// 經 ID 伺服器：ID 伺服器簽了對方的簽章公鑰 → 對方送 SignedId → 我們封金鑰回去 → 之後雙向加密。
    /// 被控端這邊用 crypto_box / secretbox 自己解（獨立於 crypto::Cipher 的路徑再驗一次格式）。
    #[tokio::test]
    async fn id_connection_negotiates_encryption() {
        use crypto_box::aead::AeadInPlace;
        use crypto_secretbox::KeyInit;
        let server_sk = SigningKey::from_bytes(&[11u8; 32]);
        let peer_sign = SigningKey::from_bytes(&[22u8; 32]);
        let peer_box = crypto_box::SecretKey::from([33u8; 32]);
        let sign = |sk: &SigningKey, id: &str, pk: &[u8]| {
            let msg = crate::proto::rendezvous::IdPk { id: id.into(), pk: pk.to_vec().into(), ..Default::default() }
                .write_to_bytes()
                .unwrap();
            let mut s = sk.sign(&msg).to_bytes().to_vec();
            s.extend_from_slice(&msg);
            s
        };
        let mut login = direct("123456789", "pw", Decoders::default(), "pc");
        login.signed_id_pk = sign(&server_sk, "123456789", peer_sign.verifying_key().as_bytes());
        login.server_key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, server_sk.verifying_key().as_bytes());
        login.route = "relay";

        let (ours, mut theirs) = tokio::io::duplex(1 << 20);
        let (host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(ours, &mut stdin, &mut host_out_w, &login).await
        });

        // 對方先送 SignedId
        let mut m = Message::new();
        m.set_signed_id(SignedId { id: sign(&peer_sign, "123456789", peer_box.public_key().as_bytes()).into(), ..Default::default() });
        send_peer(&mut theirs, &m).await;
        // 收到 PublicKey：用 box 私鑰解出對稱金鑰（MAC 在前）
        let pk = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        let Some(message::Union::PublicKey(pk)) = pk.union else { panic!("expect PublicKey") };
        assert_eq!(pk.kx_version, 0);
        let their: [u8; 32] = pk.asymmetric_value.to_vec().try_into().unwrap();
        let b = crypto_box::SalsaBox::new(&crypto_box::PublicKey::from(their), &peer_box);
        let mut key = pk.symmetric_value[16..].to_vec();
        b.decrypt_in_place_detached(&[0u8; 24].into(), b"", &mut key, pk.symmetric_value[..16].into()).unwrap();
        let key: [u8; 32] = key.try_into().unwrap();
        let sb = crypto_secretbox::XSalsa20Poly1305::new(&key.into());
        let nonce = |seq: u64| {
            let mut n = [0u8; 24];
            n[..8].copy_from_slice(&seq.to_le_bytes());
            n
        };
        let seal = |seq: u64, m: &Message| {
            let mut buf = m.write_to_bytes().unwrap();
            let tag = sb.encrypt_in_place_detached(&nonce(seq).into(), b"", &mut buf).unwrap();
            let mut out = tag.to_vec();
            out.extend_from_slice(&buf);
            out
        };
        let open = |seq: u64, data: Vec<u8>| {
            let mut buf = data[16..].to_vec();
            sb.decrypt_in_place_detached(&nonce(seq).into(), b"", &mut buf, data[..16].into()).unwrap();
            Message::parse_from_bytes(&buf).unwrap()
        };
        // 加密的出題 → 加密的登入
        codec::write_frame(&mut theirs, &seal(1, &hash_msg("s", "c"))).await.unwrap();
        let lr = open(1, codec::read_frame(&mut theirs).await.unwrap().unwrap());
        let Some(message::Union::LoginRequest(lr)) = lr.union else { panic!("expect login") };
        assert_eq!(lr.username, "123456789", "登入用對方 ID");
        assert_eq!(&lr.password[..], &session::password_proof("pw", "s", "c")[..]);
        codec::write_frame(&mut theirs, &seal(2, &logged_in_msg("home-pc"))).await.unwrap();
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => {
                assert_eq!(v["type"], "connected");
                assert_eq!((v["secure"].as_bool(), v["route"].as_str()), (Some(true), Some("relay")));
            }
            x => panic!("{x:?}"),
        }
        drop(host_in_w);
        assert!(task.await.unwrap().is_ok());
    }

    /// 簽章對不上（ID 伺服器 Key 填錯）→ 不加密，但照樣連得上。
    #[tokio::test]
    async fn bad_server_signature_falls_back_to_plain() {
        let mut login = direct("123456789", "", Decoders::default(), "pc");
        login.signed_id_pk = vec![1u8; 100];
        login.server_key = crypto::PUBLIC_SERVER_KEY.into();
        let (ours, mut theirs) = tokio::io::duplex(1 << 16);
        let (_host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(ours, &mut stdin, &mut host_out_w, &login).await
        });
        assert!(codec::read_frame(&mut theirs).await.unwrap().unwrap().is_empty(), "不加密 → 空訊息");
        send_peer(&mut theirs, &hash_msg("s", "c")).await;
        let _login = codec::read_frame(&mut theirs).await.unwrap().unwrap();
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => assert_eq!(v["type"], "waiting_accept"),
            x => panic!("{x:?}"),
        }
        task.abort();
    }

    /// 沒密碼：先送空的登入（對方畫面跳出「接受」）、告訴 db-kit 在等；db-kit 問到密碼後用同一題重送登入。
    #[tokio::test]
    async fn password_entered_while_waiting_for_accept() {
        let (ours, mut theirs) = tokio::io::duplex(1 << 16);
        let (mut host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(ours, &mut stdin, &mut host_out_w, &direct("123456789", "", Decoders::default(), "pc")).await
        });
        let _ = codec::read_frame(&mut theirs).await.unwrap();
        send_peer(&mut theirs, &hash_msg("s", "c")).await;
        let lr = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        let Some(message::Union::LoginRequest(first)) = lr.union else { panic!("expect login") };
        assert!(first.password.is_empty(), "先送空密碼，讓對方按接受");
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => assert_eq!(v["type"], "waiting_accept"),
            x => panic!("{x:?}"),
        }
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "login", "password": "pw" })).await.unwrap();
        let lr = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        let Some(message::Union::LoginRequest(second)) = lr.union else { panic!("expect login") };
        assert_eq!(&second.password[..], &session::password_proof("pw", "s", "c")[..], "同一題的密碼證明");
        assert_eq!((second.session_id, second.username.as_str()), (first.session_id, "123456789"), "同一個工作階段");
        send_peer(&mut theirs, &logged_in_msg("home-pc")).await;
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => assert_eq!(v["type"], "connected"),
            x => panic!("{x:?}"),
        }
        // 登入後再送 login：不再重送登入
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "login", "password": "pw" })).await.unwrap();
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "refresh" })).await.unwrap();
        let m = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        assert!(matches!(m.union, Some(message::Union::Misc(_))), "下一則是 refresh，不是登入：{m:?}");
        drop(host_in_w);
        assert!(task.await.unwrap().is_ok());
    }

    fn login_error_msg(e: &str) -> Message {
        let mut m = Message::new();
        let mut resp = LoginResponse::new();
        resp.set_error(e.into());
        m.set_login_response(resp);
        m
    }

    /// 對方開了雙重驗證：密碼對了回 `2FA Required`，連線不斷；db-kit 送驗證碼 → `Auth2FA`，錯了可以再送。
    #[tokio::test]
    async fn two_factor_code_on_the_same_connection() {
        let (ours, mut theirs) = tokio::io::duplex(1 << 16);
        let (mut host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(ours, &mut stdin, &mut host_out_w, &direct("h", "pw", Decoders::default(), "pc")).await
        });
        let _ = codec::read_frame(&mut theirs).await.unwrap();
        send_peer(&mut theirs, &hash_msg("s", "c")).await;
        let m = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        assert!(matches!(m.union, Some(message::Union::LoginRequest(_))), "{m:?}");
        send_peer(&mut theirs, &login_error_msg(session::REQUIRE_2FA)).await;
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => assert_eq!((v["type"].as_str(), v["wrong"].as_bool()), (Some("need_2fa"), Some(false))),
            x => panic!("{x:?}"),
        }
        for (code, reply) in [("111 111", login_error_msg(session::WRONG_2FA)), ("123456", logged_in_msg("pc"))] {
            ipc::write_host_json(&mut host_in_w, &json!({ "t": "2fa", "code": code })).await.unwrap();
            let m = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
            let Some(message::Union::Auth2fa(a)) = m.union else { panic!("expect Auth2FA: {m:?}") };
            assert_eq!(a.code, code.replace(' ', ""));
            send_peer(&mut theirs, &reply).await;
            match ipc::read_msg(&mut host_out_r).await.unwrap() {
                Some(ipc::HostMsg::Json(v)) if code == "123456" => assert_eq!(v["type"], "connected"),
                Some(ipc::HostMsg::Json(v)) => assert_eq!((v["type"].as_str(), v["wrong"].as_bool()), (Some("need_2fa"), Some(true))),
                x => panic!("{x:?}"),
            }
        }
        // 登入後再送 2fa：不送出去
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "2fa", "code": "000000" })).await.unwrap();
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "refresh" })).await.unwrap();
        let m = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        assert!(matches!(m.union, Some(message::Union::Misc(_))), "下一則是 refresh：{m:?}");
        drop(host_in_w);
        assert!(task.await.unwrap().is_ok());
    }

    async fn next_json<R: AsyncRead + Unpin>(r: &mut R) -> serde_json::Value {
        match ipc::read_msg(r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => v,
            x => panic!("{x:?}"),
        }
    }

    async fn next_peer_msg<R: AsyncRead + Unpin>(r: &mut R) -> Message {
        Message::parse_from_bytes(&codec::read_frame(r).await.unwrap().unwrap()).unwrap()
    }

    /// 信任這台裝置（官方 `send2fa(code, trust_this_device)`）：對方允許時 `need_2fa` 帶 `trust`（驗證碼錯了那則
    /// 不帶也沿用）；沒勾 → `Auth2FA` 不帶 hwid，勾了才帶。之前信任過（`trusted`）→ 登入時就帶 hwid。
    #[tokio::test]
    async fn trust_this_device_sends_hwid() {
        for trusted in [false, true] {
            let (ours, mut theirs) = tokio::io::duplex(1 << 16);
            let (mut host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
            let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 16);
            let task = tokio::spawn(async move {
                let mut stdin = ipc::MsgReader::new(host_in_r);
                let mut login = direct("h", "pw", Decoders::default(), "pc");
                login.hwid = vec![7; 32];
                login.trusted = trusted;
                drive(ours, &mut stdin, &mut host_out_w, &login).await
            });
            let _ = codec::read_frame(&mut theirs).await.unwrap();
            send_peer(&mut theirs, &hash_msg("s", "c")).await;
            let Some(message::Union::LoginRequest(lr)) = next_peer_msg(&mut theirs).await.union else { panic!() };
            assert_eq!(lr.hwid.is_empty(), !trusted, "信任過才在登入帶 hwid");
            let mut need = login_error_msg(session::REQUIRE_2FA);
            need.mut_login_response().enable_trusted_devices = true;
            send_peer(&mut theirs, &need).await;
            let v = next_json(&mut host_out_r).await;
            assert_eq!((v["type"].as_str(), v["trust"].as_bool()), (Some("need_2fa"), Some(true)));
            for (code, trust, reply) in [("111111", false, login_error_msg(session::WRONG_2FA)), ("123456", true, logged_in_msg("pc"))] {
                ipc::write_host_json(&mut host_in_w, &json!({ "t": "2fa", "code": code, "trust": trust })).await.unwrap();
                let Some(message::Union::Auth2fa(a)) = next_peer_msg(&mut theirs).await.union else { panic!("expect Auth2FA") };
                assert_eq!((a.code.as_str(), a.hwid.is_empty()), (code, !trust), "勾了才帶 hwid");
                send_peer(&mut theirs, &reply).await;
                let v = next_json(&mut host_out_r).await;
                if trust {
                    assert_eq!(v["type"], "connected");
                } else {
                    assert_eq!((v["wrong"].as_bool(), v["trust"].as_bool()), (Some(true), Some(true)), "錯了那則沿用 trust");
                }
            }
            drop(host_in_w);
            assert!(task.await.unwrap().is_ok());
        }
    }

    /// 對方設成只能按「接受」（`No Password Access`）：不是登入失敗，連線留著等對方按；按了就連上。
    #[tokio::test]
    async fn no_password_access_waits_for_accept() {
        let (ours, mut theirs) = tokio::io::duplex(1 << 16);
        let (host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(ours, &mut stdin, &mut host_out_w, &direct("h", "pw", Decoders::default(), "pc")).await
        });
        let _ = codec::read_frame(&mut theirs).await.unwrap();
        send_peer(&mut theirs, &hash_msg("s", "c")).await;
        let _ = next_peer_msg(&mut theirs).await;
        send_peer(&mut theirs, &login_error_msg(session::NO_PASSWORD_ACCESS)).await;
        let v = next_json(&mut host_out_r).await;
        assert_eq!((v["type"].as_str(), v["click_only"].as_bool()), (Some("waiting_accept"), Some(true)));
        send_peer(&mut theirs, &logged_in_msg("pc")).await;
        assert_eq!(next_json(&mut host_out_r).await["type"], "connected");
        drop(host_in_w);
        assert!(task.await.unwrap().is_ok());
    }

    /// 對真的 RustDesk 被控端（tests/docker，Direct IP、密碼 dbkit123）：登入、收到 VP9 關鍵畫面。
    /// `cargo test -- --ignored real_peer`；`DBKIT_RUSTDESK_IT_HOST` 可改目標。
    #[tokio::test]
    #[ignore]
    async fn real_peer_login_and_first_frame() {
        let host = std::env::var("DBKIT_RUSTDESK_IT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let tcp = TcpStream::connect((host.as_str(), 21118)).await.expect("connect peer");
        let login = direct(&host, "dbkit123", Decoders { vp9: true, vp8: true, av1: false }, "it");
        expect_login_and_key_frame(tcp, login, false).await;
    }

    /// 對真的兩個螢幕的 RustDesk 被控端（Xvfb 2048×768 用 `xrandr --setmonitor` 切成左右兩個 1024×768）：
    /// 切到螢幕 2 → 對方回報螢幕 2 的位置、送螢幕 2 的關鍵畫面；所有螢幕 → 兩個螢幕都送；再切回螢幕 1。
    /// `cargo test -- --ignored real_peer_switch`；`DBKIT_RUSTDESK_IT_HOST` / `DBKIT_RUSTDESK_IT_PORT` 改目標。
    #[tokio::test]
    #[ignore]
    async fn real_peer_switch_displays() {
        use std::collections::BTreeSet;
        let host = std::env::var("DBKIT_RUSTDESK_IT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port: u16 = std::env::var("DBKIT_RUSTDESK_IT_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(21118);
        let tcp = TcpStream::connect((host.as_str(), port)).await.expect("connect peer");
        let login = direct(&host, "dbkit123", Decoders { vp9: true, vp8: true, av1: false }, "it");
        let (mut host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(8 << 20);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(tcp, &mut stdin, &mut host_out_w, &login).await
        });
        // 讀到 `done` 說好為止（逾時 = None）；順便記下每個螢幕收到的關鍵畫面。
        async fn until<R: AsyncRead + Unpin>(
            r: &mut R,
            keys: &mut BTreeSet<u8>,
            mut done: impl FnMut(&serde_json::Value, &BTreeSet<u8>) -> bool,
        ) -> Option<serde_json::Value> {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                let Ok(Ok(Some(raw))) = tokio::time::timeout(left, ipc::read_raw(r)).await else { return None };
                let v = if raw[0] == ipc::OUT_JSON {
                    let v: serde_json::Value = serde_json::from_slice(&raw[1..]).unwrap();
                    eprintln!("event: {v}");
                    assert!(v["type"] != "closed" && v["type"] != "login_error", "{v}");
                    v
                } else {
                    if raw[2] == 1 && keys.insert(raw[3]) {
                        eprintln!("key frame from display {}", raw[3]);
                    }
                    serde_json::Value::Null
                };
                if done(&v, keys) {
                    return Some(v);
                }
            }
        }
        let mut keys = BTreeSet::new();
        let mut hello = None;
        until(&mut host_out_r, &mut keys, |v, k| {
            if v["type"] == "connected" {
                hello = Some(v.clone());
            }
            hello.is_some() && !k.is_empty()
        })
        .await
        .expect("時限內要登入並收到第一張畫面");
        let hello = hello.unwrap();
        let displays = hello["peer"]["displays"].as_array().cloned().unwrap_or_default();
        assert!(displays.len() >= 2, "對方要有兩個螢幕：{hello}");
        let current = hello["peer"]["current_display"].as_u64().unwrap_or(0) as u8;
        assert_eq!(keys.iter().copied().collect::<Vec<_>>(), [current], "一開始只送目前的螢幕");

        keys.clear();
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "displays", "set": [1] })).await.unwrap();
        let mut moved = None;
        until(&mut host_out_r, &mut keys, |v, k| {
            if v["type"] == "switch_display" {
                moved = Some(v.clone());
            }
            moved.is_some() && k.contains(&1)
        })
        .await
        .expect("切到螢幕 2：要收到位置大小與它的關鍵畫面");
        let moved = moved.unwrap();
        assert_eq!(moved["display"], 1, "{moved}");
        assert_eq!((&moved["x"], &moved["y"], &moved["width"], &moved["height"]), (&displays[1]["x"], &displays[1]["y"], &displays[1]["width"], &displays[1]["height"]), "位置大小跟清單裡的螢幕 2 一樣：{moved}");

        keys.clear();
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "displays", "set": [0, 1] })).await.unwrap();
        until(&mut host_out_r, &mut keys, |_, k| k.contains(&0) && k.contains(&1))
            .await
            .expect("所有螢幕：兩個螢幕都要送關鍵畫面");

        keys.clear();
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "displays", "set": [0] })).await.unwrap();
        until(&mut host_out_r, &mut keys, |_, k| k.contains(&0)).await.expect("切回螢幕 1");
        // 只看螢幕 1 之後，對方不該再送螢幕 2 的畫面（讓螢幕 2 動起來也一樣）。
        let mut late = BTreeSet::new();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), until(&mut host_out_r, &mut late, |_, _| false)).await;
        assert!(!late.contains(&1), "切回螢幕 1 後還收到螢幕 2 的關鍵畫面");
        task.abort();
    }

    /// 對真的 RustDesk 被控端（Linux，Direct IP、密碼 dbkit123）驗工具列的功能：
    /// - 換編碼成 VP8 → 之後的畫面是 VP8；
    /// - 對方定時量延遲 → `delay` 事件；
    /// - 封鎖輸入（Linux 對方不支援）→ `block_input` 事件帶失敗；
    /// - 剪貼簿：本機 → 對方（用 `docker exec … xclip -o` 讀對方的剪貼簿）、對方 → 本機（`xclip -i` 寫進去 → `clipboard` 事件）；
    /// - 聊天送得出去、連線不斷。
    ///
    /// `DBKIT_RUSTDESK_IT_PORT`（預設 21118）、`DBKIT_RUSTDESK_IT_CONTAINER`（被控端容器名，要裝 xclip；沒給就不驗剪貼簿）。
    /// `cargo test -- --ignored real_peer_toolbar --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_peer_toolbar_features() {
        let host = std::env::var("DBKIT_RUSTDESK_IT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port: u16 = std::env::var("DBKIT_RUSTDESK_IT_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(21118);
        let container = std::env::var("DBKIT_RUSTDESK_IT_CONTAINER").ok().filter(|c| !c.is_empty());
        let tcp = TcpStream::connect((host.as_str(), port)).await.expect("connect peer");
        let login = direct(&host, "dbkit123", Decoders { vp9: true, vp8: true, av1: false }, "it");
        let (mut host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(8 << 20);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(tcp, &mut stdin, &mut host_out_w, &login).await
        });
        /// 讀到 `done` 說好為止（逾時 = None）。`v` 是事件（影像時是 Null），`codec` 是影像的編碼（事件時 0）。
        async fn until<R: AsyncRead + Unpin>(
            r: &mut R,
            secs: u64,
            mut done: impl FnMut(&serde_json::Value, u8) -> bool,
        ) -> Option<serde_json::Value> {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(secs);
            loop {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                let Ok(Ok(Some(raw))) = tokio::time::timeout(left, ipc::read_raw(r)).await else { return None };
                let (v, codec) = if raw[0] == ipc::OUT_JSON {
                    let v: serde_json::Value = serde_json::from_slice(&raw[1..]).unwrap();
                    if v["type"] != "delay" {
                        eprintln!("event: {v}");
                    }
                    assert!(v["type"] != "closed" && v["type"] != "login_error", "{v}");
                    (v, 0)
                } else {
                    (serde_json::Value::Null, raw[1])
                };
                if done(&v, codec) {
                    return Some(v);
                }
            }
        }
        let docker = |args: &[&str], stdin: Option<&str>| {
            let mut c = std::process::Command::new("docker");
            c.args(args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
            let mut child = c.spawn().expect("docker");
            if let Some(s) = stdin {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
            }
            let out = child.wait_with_output().expect("docker");
            String::from_utf8_lossy(&out.stdout).to_string()
        };

        let mut platform = String::new();
        until(&mut host_out_r, 40, |v, codec| {
            if v["type"] == "connected" {
                platform = v["peer"]["platform"].as_str().unwrap_or_default().to_string();
            }
            !platform.is_empty() && codec != 0
        })
        .await
        .expect("時限內要登入並收到畫面");
        eprintln!("peer platform = {platform}");

        // 換成 VP8：對方重設編碼器，之後的畫面是 VP8（codec 2）。讓畫面動起來才會有新畫面。
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "codec", "prefer": "vp8", "vp9": true, "vp8": true, "av1": false })).await.unwrap();
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "refresh" })).await.unwrap();
        until(&mut host_out_r, 20, |_, codec| codec == 2).await.expect("換成 VP8 後要收到 VP8 畫面");
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "quality", "level": "low" })).await.unwrap();

        // 對方每隔一陣子量一次延遲
        let d = until(&mut host_out_r, 20, |v, _| v["type"] == "delay").await.expect("要收到 delay");
        assert!(d["ms"].is_u64(), "{d}");

        // 封鎖輸入：Linux 對方做不到 → 回失敗；Windows 對方成功後再解除
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "toggle", "name": "block_input", "on": true })).await.unwrap();
        let b = until(&mut host_out_r, 10, |v, _| v["type"] == "block_input").await;
        eprintln!("block_input → {b:?}");
        if platform == "Windows" {
            assert_eq!(b.as_ref().map(|b| &b["ok"]), Some(&json!(true)));
            ipc::write_host_json(&mut host_in_w, &json!({ "t": "toggle", "name": "block_input", "on": false })).await.unwrap();
        } else if let Some(b) = b {
            assert_eq!(b["ok"], false, "{b}");
        }

        ipc::write_host_json(&mut host_in_w, &json!({ "t": "chat", "text": "db-kit 整合測試" })).await.unwrap();

        if let Some(c) = container.as_deref() {
            // 本機 → 對方
            let text = format!("db-kit 剪貼簿 {}", std::process::id());
            ipc::write_host_json(&mut host_in_w, &json!({ "t": "clipboard", "text": text })).await.unwrap();
            let mut got = String::new();
            for _ in 0..20 {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                got = docker(&["exec", "-e", "DISPLAY=:0", c, "xclip", "-o", "-selection", "clipboard"], None);
                if got == text {
                    break;
                }
            }
            assert_eq!(got, text, "對方的剪貼簿要是送過去的文字");
            // 對方 → 本機
            let theirs = format!("對方複製 {}", std::process::id());
            // 先存檔再交給 xclip（背景工作的 stdin 會被 sh 接到 /dev/null）；xclip 自己會留在背景提供剪貼簿。
            docker(&["exec", "-i", "-e", "DISPLAY=:0", c, "sh", "-c", "cat > /tmp/clip.txt && xclip -i -selection clipboard /tmp/clip.txt >/dev/null 2>&1"], Some(&theirs));
            let v = until(&mut host_out_r, 15, |v, _| v["type"] == "clipboard").await.expect("對方複製 → 要收到 clipboard 事件");
            assert_eq!(v["text"], theirs.as_str());
        } else {
            eprintln!("沒有 DBKIT_RUSTDESK_IT_CONTAINER：略過剪貼簿");
        }

        // 還連著：再要一張畫面收得到
        ipc::write_host_json(&mut host_in_w, &json!({ "t": "refresh" })).await.unwrap();
        until(&mut host_out_r, 15, |_, codec| codec != 0).await.expect("連線還在");
        task.abort();
    }

    /// 對真的 Linux 被控端（Xvfb + 左上角一個 80x24 的 xterm、沒有視窗管理員）實際操作：
    /// - 打字：db-kit 送的是 PC 掃描碼，要換成 Linux 的鍵碼才打得出對的字（Shift 也要對）；
    /// - CapsLock / NumLock：帶著本機狀態，對方照著切（數字鍵盤要打得出數字）；
    /// - 連點兩下：xterm 雙擊會選取一個字（PRIMARY 選取區），讀得到 = 對方收到的是雙擊。
    ///
    /// 結果用 `docker exec` 讀檔 / 讀選取區驗證：`DBKIT_RUSTDESK_IT_PORT`、`DBKIT_RUSTDESK_IT_CONTAINER`（必填，要有 xclip）。
    /// `cargo test -- --ignored real_peer_keyboard_and_mouse --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_peer_keyboard_and_mouse() {
        let host = std::env::var("DBKIT_RUSTDESK_IT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port: u16 = std::env::var("DBKIT_RUSTDESK_IT_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(21118);
        let container = std::env::var("DBKIT_RUSTDESK_IT_CONTAINER").expect("DBKIT_RUSTDESK_IT_CONTAINER");
        let tcp = TcpStream::connect((host.as_str(), port)).await.expect("connect peer");
        let login = direct(&host, "dbkit123", Decoders { vp9: true, vp8: true, av1: false }, "it");
        let (mut w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut out) = tokio::io::duplex(8 << 20);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(tcp, &mut stdin, &mut host_out_w, &login).await
        });
        // 一直讀輸出（不讀的話 duplex 塞滿，連線元件就卡住）；登入後回報對方系統。
        let (plat_tx, plat_rx) = tokio::sync::oneshot::channel::<String>();
        let reader = tokio::spawn(async move {
            let mut plat_tx = Some(plat_tx);
            while let Ok(Some(raw)) = ipc::read_raw(&mut out).await {
                if raw[0] != ipc::OUT_JSON {
                    continue;
                }
                let v: serde_json::Value = serde_json::from_slice(&raw[1..]).unwrap();
                assert!(v["type"] != "closed" && v["type"] != "login_error", "{v}");
                if v["type"] == "connected" {
                    if let Some(tx) = plat_tx.take() {
                        let _ = tx.send(v["peer"]["platform"].as_str().unwrap_or_default().to_string());
                    }
                }
            }
        });
        let platform = tokio::time::timeout(std::time::Duration::from_secs(40), plat_rx).await.expect("時限內要登入").unwrap();
        eprintln!("peer platform = {platform}");
        let docker = |cmd: &str| {
            let out = std::process::Command::new("docker")
                .args(["exec", "-e", "DISPLAY=:0", &container, "sh", "-c", cmd])
                .output()
                .expect("docker");
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        let pause = |ms: u64| tokio::time::sleep(std::time::Duration::from_millis(ms));

        /// 一個字元 → (掃描碼, 要不要 Shift)；美式鍵盤。
        fn scancode_of(c: char) -> (u32, bool) {
            const ROWS: [(&str, u32); 4] = [("1234567890-=", 0x02), ("qwertyuiop[]", 0x10), ("asdfghjkl;'", 0x1E), ("zxcvbnm,./", 0x2C)];
            const SHIFTED: [(&str, u32); 4] = [("!@#$%^&*()_+", 0x02), ("QWERTYUIOP{}", 0x10), ("ASDFGHJKL:\"", 0x1E), ("ZXCVBNM<>?", 0x2C)];
            match c {
                ' ' => return (0x39, false),
                '\n' => return (0x1C, false),
                _ => {}
            }
            for (shift, rows) in [(false, ROWS), (true, SHIFTED)] {
                for (row, base) in rows {
                    if let Some(i) = row.chars().position(|x| x == c) {
                        return (base + i as u32, shift);
                    }
                }
            }
            panic!("{c:?}");
        }
        async fn key<W: AsyncWrite + Unpin>(w: &mut W, sc: u32, down: bool, caps: bool, num: bool) {
            ipc::write_host_json(w, &json!({ "t": "key", "down": down, "scancode": sc, "caps": caps, "num": num })).await.unwrap();
        }
        async fn type_str<W: AsyncWrite + Unpin>(w: &mut W, s: &str) {
            for c in s.chars() {
                let (sc, shift) = scancode_of(c);
                if shift {
                    key(w, 0x2A, true, false, false).await;
                }
                key(w, sc, true, false, false).await;
                key(w, sc, false, false, false).await;
                if shift {
                    key(w, 0x2A, false, false, false).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        }
        async fn mouse<W: AsyncWrite + Unpin>(w: &mut W, mask: i32, x: i32, y: i32) {
            ipc::write_host_json(w, &json!({ "t": "mouse", "mask": mask, "x": x, "y": y })).await.unwrap();
        }

        // 沒有視窗管理員：鍵盤跟著游標，先把游標移進 xterm。
        mouse(&mut w, 0, 200, 150).await;
        pause(300).await;
        docker("rm -f /tmp/kb.txt /tmp/caps.txt /tmp/num.txt /tmp/nonum.txt");

        // 1. 打字（含 Shift：大寫字母與 Shift + 數字的符號；單引號裡 bash 不展開 !）
        type_str(&mut w, "echo 'Ab1-X!@#$%' >/tmp/kb.txt\n").await;
        pause(800).await;
        assert_eq!(docker("cat /tmp/kb.txt").trim_end(), "Ab1-X!@#$%", "打出來的字要對（Linux 鍵碼、Shift）");

        // 1b. 編輯鍵：打 "echo abcd"，← ← 回到 c 前面，Delete 刪掉 c、Backspace 刪掉 b → "ad"
        docker("rm -f /tmp/edit.txt");
        type_str(&mut w, "echo abcd").await;
        for sc in [0xE04B, 0xE04B, 0xE053, 0x0E] {
            key(&mut w, sc, true, false, false).await;
            key(&mut w, sc, false, false, false).await;
            pause(30).await;
        }
        key(&mut w, 0xE04F, true, false, false).await; // End
        key(&mut w, 0xE04F, false, false, false).await;
        type_str(&mut w, " >/tmp/edit.txt\n").await;
        pause(800).await;
        assert_eq!(docker("cat /tmp/edit.txt").trim_end(), "ad", "←、Delete、Backspace、End 都要有作用");

        // 1c. 翻譯模式：一個一個字送（seq），按著 Shift 也照字打；輸入作業系統密碼：整段打完自動按 Enter。
        docker("rm -f /tmp/tr.txt /tmp/os.txt");
        type_str(&mut w, "echo ").await;
        key(&mut w, 0x2A, true, false, false).await; // 按著 Shift：對方會先放開再打字，小寫的 r 不會變大寫
        for c in ["T", "r", "1", "@"] {
            ipc::write_host_json(&mut w, &json!({ "t": "char", "text": c })).await.unwrap();
            pause(30).await;
        }
        key(&mut w, 0x2A, false, false, false).await;
        type_str(&mut w, " >/tmp/tr.txt\n").await;
        pause(800).await;
        assert_eq!(docker("cat /tmp/tr.txt").trim_end(), "Tr1@", "翻譯模式照字打");
        ipc::write_host_json(&mut w, &json!({ "t": "os_password", "text": "echo osok >/tmp/os.txt" })).await.unwrap();
        pause(1000).await;
        assert_eq!(docker("cat /tmp/os.txt").trim_end(), "osok", "輸入作業系統密碼：打完要按 Enter");

        // 2. CapsLock：本機開著 → 字母是大寫（對方先開 CapsLock 再按、按完還原）
        type_str(&mut w, "echo ").await;
        for sc in [0x10, 0x11] {
            // q w
            key(&mut w, sc, true, true, false).await;
            key(&mut w, sc, false, true, false).await;
        }
        type_str(&mut w, " >/tmp/caps.txt\n").await;
        pause(800).await;
        assert_eq!(docker("cat /tmp/caps.txt").trim_end(), "QW", "CapsLock 開著要打出大寫");

        // 3. 數字鍵盤：本機 NumLock 開著 → 打出數字
        type_str(&mut w, "echo ").await;
        for sc in [0x4F, 0x50, 0x51] {
            key(&mut w, sc, true, false, true).await;
            key(&mut w, sc, false, false, true).await;
        }
        type_str(&mut w, " >/tmp/num.txt\n").await;
        pause(800).await;
        assert_eq!(docker("cat /tmp/num.txt").trim_end(), "123", "NumLock 開著，數字鍵盤要打出數字");
        //    NumLock 關著 → 數字鍵盤是 End / ↓ / PgDn，不會打出數字（跟本機一樣）
        type_str(&mut w, "echo x").await;
        for sc in [0x4F, 0x50] {
            key(&mut w, sc, true, false, false).await;
            key(&mut w, sc, false, false, false).await;
        }
        type_str(&mut w, " >/tmp/nonum.txt\n").await;
        pause(800).await;
        assert_eq!(docker("cat /tmp/nonum.txt").trim_end(), "x", "NumLock 關著不該打出數字");

        // 4. 連點兩下：畫面填滿同一個字，雙擊第 2 行第 4 欄（字型 6x13、內容從 (13,13) 開始）→ 選取那個字。
        type_str(&mut w, "clear; printf 'dbkitword %.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16\n").await;
        pause(800).await;
        docker("printf '' | xclip -i -selection primary");
        let (x, y) = (13 + 3 * 6 + 3, 13 + 13 + 6);
        mouse(&mut w, 0, x, y).await;
        pause(100).await;
        for _ in 0..2 {
            mouse(&mut w, 1 | (1 << 3), x, y).await;
            mouse(&mut w, 2 | (1 << 3), x, y).await;
            pause(60).await;
        }
        pause(600).await;
        assert_eq!(docker("xclip -o -selection primary"), "dbkitword", "雙擊要選取一個字");

        task.abort();
        reader.abort();
    }

    /// 對真的 Linux 被控端開傳檔連線（`file_transfer`）：列家目錄、建資料夾、上傳、下載、改名、覆蓋、刪除，
    /// 內容用 `docker exec … sha256sum` 與本機比對。`DBKIT_RUSTDESK_IT_PORT`、`DBKIT_RUSTDESK_IT_CONTAINER`（必填）。
    /// `cargo test -- --ignored real_peer_file_transfer --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_peer_file_transfer() {
        let host = std::env::var("DBKIT_RUSTDESK_IT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port: u16 = std::env::var("DBKIT_RUSTDESK_IT_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(21118);
        let container = std::env::var("DBKIT_RUSTDESK_IT_CONTAINER").expect("DBKIT_RUSTDESK_IT_CONTAINER");
        let tcp = TcpStream::connect((host.as_str(), port)).await.expect("connect peer");
        let mut login = direct(&host, "dbkit123", Decoders::default(), "it");
        login.file_transfer = true;
        let (mut w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut out) = tokio::io::duplex(8 << 20);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(tcp, &mut stdin, &mut host_out_w, &login).await
        });
        let docker = |cmd: &str| {
            let o = std::process::Command::new("docker").args(["exec", &container, "sh", "-c", cmd]).output().expect("docker");
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };
        /// 等某個 req 的結果（fs_dir / fs_done / fs_err）；中間的 fs_progress 算數量。
        async fn wait<R: AsyncRead + Unpin>(r: &mut R, req: u64) -> (serde_json::Value, usize) {
            let mut progress = 0;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
            loop {
                let raw = tokio::time::timeout_at(deadline, ipc::read_raw(r))
                    .await
                    .unwrap_or_else(|_| panic!("等 req {req} 的結果逾時"))
                    .unwrap()
                    .expect("連線結束");
                if raw[0] != ipc::OUT_JSON {
                    continue;
                }
                let v: serde_json::Value = serde_json::from_slice(&raw[1..]).unwrap();
                assert!(v["type"] != "closed" && v["type"] != "login_error", "{v}");
                if v["type"] != "delay" && v["type"] != "fs_progress" {
                    eprintln!("event: {}", v.to_string().chars().take(200).collect::<String>());
                }
                if v["req"] == req {
                    if v["type"] == "fs_progress" {
                        progress += 1;
                        continue;
                    }
                    return (v, progress);
                }
            }
        }
        // 登入
        loop {
            let raw = tokio::time::timeout(std::time::Duration::from_secs(40), ipc::read_raw(&mut out)).await.expect("登入逾時").unwrap().unwrap();
            if raw[0] == ipc::OUT_JSON {
                let v: serde_json::Value = serde_json::from_slice(&raw[1..]).unwrap();
                assert!(v["type"] != "login_error", "{v}");
                if v["type"] == "connected" {
                    eprintln!("connected: platform {}", v["peer"]["platform"]);
                    break;
                }
            }
        }
        async fn send<W: AsyncWrite + Unpin>(w: &mut W, v: serde_json::Value) {
            ipc::write_host_json(w, &v).await.unwrap();
        }
        docker("rm -rf /tmp/dbk-ft");

        // 家目錄
        send(&mut w, json!({ "t": "fs_ls", "req": 1, "path": "" })).await;
        let (v, _) = wait(&mut out, 1).await;
        assert_eq!(v["type"], "fs_dir", "{v}");
        eprintln!("home = {}", v["path"]);
        assert!(v["path"].as_str().is_some_and(|p| p.starts_with('/')), "{v}");
        // （不存在的資料夾：RustDesk 1.4.9 不回應——沒有 fs_dir 也沒有 fs_err，db-kit 後端用逾時處理。）
        // 建資料夾
        send(&mut w, json!({ "t": "fs_mkdir", "req": 3, "path": "/tmp/dbk-ft" })).await;
        assert_eq!(wait(&mut out, 3).await.0["type"], "fs_done");
        assert_eq!(docker("test -d /tmp/dbk-ft && echo yes"), "yes");

        // 上傳 300 KB（跨好幾塊）
        let local_dir = std::env::temp_dir().join(format!("dbk-ft-it-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&local_dir);
        std::fs::create_dir_all(&local_dir).unwrap();
        let src = local_dir.join("up.bin");
        let data: Vec<u8> = (0..300_000u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
        std::fs::write(&src, &data).unwrap();
        let sha = |b: &[u8]| {
            use sha2::Digest;
            sha2::Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect::<String>()
        };
        send(&mut w, json!({ "t": "fs_upload", "req": 4, "local": src.to_string_lossy(), "remote": "/tmp/dbk-ft/up.bin" })).await;
        let (v, prog) = wait(&mut out, 4).await;
        assert_eq!(v["type"], "fs_done", "{v}");
        eprintln!("upload progress events: {prog}");
        assert_eq!(docker("sha256sum /tmp/dbk-ft/up.bin | cut -d' ' -f1"), sha(&data), "對方收到的內容要一樣");

        // 列出來看得到大小
        send(&mut w, json!({ "t": "fs_ls", "req": 5, "path": "/tmp/dbk-ft" })).await;
        let (v, _) = wait(&mut out, 5).await;
        let e = v["entries"].as_array().unwrap().iter().find(|e| e["name"] == "up.bin").cloned().expect("up.bin");
        assert_eq!((e["kind"].as_str(), e["size"].as_u64()), (Some("file"), Some(data.len() as u64)));

        // 下載回來
        let dst = local_dir.join("down.bin");
        send(&mut w, json!({ "t": "fs_download", "req": 6, "remote": "/tmp/dbk-ft/up.bin", "local": dst.to_string_lossy() })).await;
        let (v, _) = wait(&mut out, 6).await;
        assert_eq!(v["type"], "fs_done", "{v}");
        assert_eq!(std::fs::read(&dst).unwrap(), data, "下載回來的內容要一樣");
        assert!(!local_dir.join("down.bin.part").exists());

        // 改名、覆蓋上傳（對方已有不一樣的同名檔）
        send(&mut w, json!({ "t": "fs_rename", "req": 7, "path": "/tmp/dbk-ft/up.bin", "new_name": "up2.bin" })).await;
        assert_eq!(wait(&mut out, 7).await.0["type"], "fs_done");
        assert_eq!(docker("ls /tmp/dbk-ft"), "up2.bin");
        let small = local_dir.join("small.txt");
        std::fs::write(&small, b"overwritten\n").unwrap();
        send(&mut w, json!({ "t": "fs_upload", "req": 8, "local": small.to_string_lossy(), "remote": "/tmp/dbk-ft/up2.bin" })).await;
        assert_eq!(wait(&mut out, 8).await.0["type"], "fs_done");
        assert_eq!(docker("cat /tmp/dbk-ft/up2.bin"), "overwritten", "覆蓋對方已有的檔案");
        // 空檔案
        let empty = local_dir.join("empty.txt");
        std::fs::write(&empty, b"").unwrap();
        send(&mut w, json!({ "t": "fs_upload", "req": 9, "local": empty.to_string_lossy(), "remote": "/tmp/dbk-ft/empty.txt" })).await;
        assert_eq!(wait(&mut out, 9).await.0["type"], "fs_done");
        assert_eq!(docker("stat -c %s /tmp/dbk-ft/empty.txt"), "0");
        let dst_empty = local_dir.join("empty-down.txt");
        send(&mut w, json!({ "t": "fs_download", "req": 10, "remote": "/tmp/dbk-ft/empty.txt", "local": dst_empty.to_string_lossy() })).await;
        assert_eq!(wait(&mut out, 10).await.0["type"], "fs_done");
        assert_eq!(std::fs::metadata(&dst_empty).unwrap().len(), 0);

        // 整棵列出 → 刪檔 → 刪資料夾
        send(&mut w, json!({ "t": "fs_all", "req": 11, "path": "/tmp/dbk-ft" })).await;
        let (v, _) = wait(&mut out, 11).await;
        let mut names: Vec<String> = v["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["empty.txt", "up2.bin"], "{v}");
        for (i, n) in names.iter().enumerate() {
            send(&mut w, json!({ "t": "fs_rm", "req": 20 + i as u64, "path": format!("/tmp/dbk-ft/{n}") })).await;
            assert_eq!(wait(&mut out, 20 + i as u64).await.0["type"], "fs_done");
        }
        send(&mut w, json!({ "t": "fs_rmdir", "req": 30, "path": "/tmp/dbk-ft" })).await;
        assert_eq!(wait(&mut out, 30).await.0["type"], "fs_done");
        assert_eq!(docker("test -e /tmp/dbk-ft && echo still || echo gone"), "gone");

        let _ = std::fs::remove_dir_all(&local_dir);
        task.abort();
    }

    /// 對真的 Linux 被控端：游標圖（`cursor_data`，RGBA 大小對得上）、截圖（PNG 寫到指定路徑）、
    /// 真彩（要了 4:4:4 之後對方送的 VP9 關鍵畫面是 profile 1）。`DBKIT_IT_SAVE_444=<檔案>` 會把那張 4:4:4 關鍵畫面
    /// 存下來（給前端用 WebCodecs 驗證解得出來）。`DBKIT_RUSTDESK_IT_PORT`（預設 21118）。
    /// `cargo test -- --ignored real_peer_display_and_cursor --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_peer_display_and_cursor() {
        let host = std::env::var("DBKIT_RUSTDESK_IT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port: u16 = std::env::var("DBKIT_RUSTDESK_IT_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(21118);
        let tcp = TcpStream::connect((host.as_str(), port)).await.expect("connect peer");
        let login = direct(&host, "dbkit123", Decoders { vp9: true, vp8: true, av1: false }, "it");
        let (mut w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut out) = tokio::io::duplex(32 << 20);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(tcp, &mut stdin, &mut host_out_w, &login).await
        });
        /// 讀到 `done` 說好為止；`v` 是事件（影像時 Null），`raw` 是整則訊息。
        async fn until<R: AsyncRead + Unpin>(
            r: &mut R,
            secs: u64,
            mut done: impl FnMut(&serde_json::Value, &[u8]) -> bool,
        ) -> Option<(serde_json::Value, Vec<u8>)> {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(secs);
            loop {
                let Ok(Ok(Some(raw))) = tokio::time::timeout_at(deadline, ipc::read_raw(r)).await else { return None };
                let v = if raw[0] == ipc::OUT_JSON { serde_json::from_slice(&raw[1..]).unwrap() } else { serde_json::Value::Null };
                assert!(v["type"] != "closed" && v["type"] != "login_error", "{v}");
                if done(&v, &raw) {
                    return Some((v, raw));
                }
            }
        }
        async fn send<W: AsyncWrite + Unpin>(w: &mut W, v: serde_json::Value) {
            ipc::write_host_json(w, &v).await.unwrap();
        }
        until(&mut out, 40, |v, _| v["type"] == "connected").await.expect("登入");

        // 游標圖：游標移到 xterm 上（I 形游標），對方送 cursor_data
        send(&mut w, json!({ "t": "mouse", "mask": 0, "x": 5, "y": 700 })).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        send(&mut w, json!({ "t": "mouse", "mask": 0, "x": 200, "y": 150 })).await;
        let (c, _) = until(&mut out, 15, |v, _| v["type"] == "cursor_data").await.expect("要收到游標圖");
        let (wd, ht) = (c["width"].as_u64().unwrap(), c["height"].as_u64().unwrap());
        let rgba = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, c["rgba"].as_str().unwrap()).unwrap();
        eprintln!("cursor {} {wd}x{ht} hot ({},{})", c["id"], c["hotx"], c["hoty"]);
        assert_eq!(rgba.len() as u64, wd * ht * 4);
        assert!(c["id"].is_string());

        // 顯示對方游標：對方開始送游標位置
        send(&mut w, json!({ "t": "toggle", "name": "show_remote_cursor", "on": true })).await;
        send(&mut w, json!({ "t": "mouse", "mask": 0, "x": 300, "y": 200 })).await;
        let pos = until(&mut out, 10, |v, _| v["type"] == "cursor_position").await;
        eprintln!("cursor_position: {:?}", pos.as_ref().map(|p| p.0.clone()));

        // 截圖
        send(&mut w, json!({ "t": "screenshot", "display": 0 })).await;
        let (s, _) = until(&mut out, 20, |v, _| v["type"] == "screenshot").await.expect("截圖結果");
        assert!(s["error"].is_null(), "{s}");
        let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s["png"].as_str().expect("png")).unwrap();
        assert!(png.starts_with(b"\x89PNG"), "要是 PNG");
        eprintln!("screenshot {} bytes", png.len());

        // 真彩：要 4:4:4 → 對方的 VP9 關鍵畫面是 profile 1
        send(&mut w, json!({ "t": "codec", "prefer": "vp9", "vp9": true, "vp8": true, "av1": false, "i444": true })).await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        send(&mut w, json!({ "t": "refresh" })).await;
        let profile_of = |raw: &[u8]| -> Option<u8> {
            // [2][codec][key][display][保留][pts 8][資料]：VP9 關鍵畫面的第一個位元組 = frame_marker(2) + profile 低位 / 高位
            (raw[0] == ipc::OUT_VIDEO && raw[1] == 1 && raw[2] == 1 && raw.len() > 13).then(|| {
                let b = raw[13];
                ((b >> 5) & 1) | (((b >> 4) & 1) << 1)
            })
        };
        let (_, key) = until(&mut out, 20, |_, raw| profile_of(raw) == Some(1)).await.expect("要收到 profile 1（4:4:4）的 VP9 關鍵畫面");
        eprintln!("4:4:4 keyframe {} bytes", key.len() - 13);
        if let Ok(p) = std::env::var("DBKIT_IT_SAVE_444") {
            std::fs::write(&p, &key[13..]).unwrap();
            eprintln!("saved to {p}");
        }
        // 換回 4:2:0
        send(&mut w, json!({ "t": "codec", "prefer": "vp9", "vp9": true, "vp8": true, "av1": false })).await;
        send(&mut w, json!({ "t": "refresh" })).await;
        until(&mut out, 20, |_, raw| profile_of(raw) == Some(0)).await.expect("換回 profile 0");
        task.abort();
    }

    /// 對真的 ID 伺服器 + 中繼伺服器 + 被控端（tests/docker/compose.yml）：用 ID 連、加密、收到關鍵畫面。
    /// `DBKIT_RUSTDESK_IT_ID`（對方 ID）、`DBKIT_RUSTDESK_IT_SERVER`（預設 127.0.0.1）、`DBKIT_RUSTDESK_IT_KEY`、
    /// `DBKIT_RUSTDESK_IT_PASSWORD`（預設 dbkit123）、`DBKIT_RUSTDESK_IT_RELAY=1` 強制中繼。
    #[tokio::test]
    #[ignore]
    async fn real_id_server_login_and_first_frame() {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let id = std::env::var("DBKIT_RUSTDESK_IT_ID").expect("DBKIT_RUSTDESK_IT_ID");
        let rp = rendezvous::Params {
            server: env("DBKIT_RUSTDESK_IT_SERVER", "127.0.0.1"),
            relay: env("DBKIT_RUSTDESK_IT_RELAY_SERVER", ""),
            key: env("DBKIT_RUSTDESK_IT_KEY", ""),
            force_relay: env("DBKIT_RUSTDESK_IT_RELAY", "") == "1",
        };
        let est = match rendezvous::connect(&id, &rp).await {
            Ok(e) => e,
            Err(f) => panic!("{}: {}", f.code, f.message),
        };
        eprintln!("route = {}, signed pk = {} bytes", est.route, est.signed_id_pk.len());
        let mut login = direct(&id, &env("DBKIT_RUSTDESK_IT_PASSWORD", "dbkit123"), Decoders { vp9: true, vp8: true, av1: false }, "it");
        login.signed_id_pk = est.signed_id_pk;
        login.server_key = rp.key();
        login.route = est.route;
        let want_secure = !rp.key().is_empty();
        expect_login_and_key_frame(est.stream, login, want_secure).await;
    }

    /// 只走到登入前：經 ID 伺服器接上、加密握手、收到對方的登入挑戰（Hash）就斷線，不送登入請求——
    /// 對方畫面不會跳出連線請求。用來確認 ID 伺服器 / Key / 打洞或中繼 / 加密都通，又不打擾對方。
    /// 環境變數同 `real_id_server_login_and_first_frame`（不需要密碼）。
    #[tokio::test]
    #[ignore]
    async fn real_id_server_until_login_challenge() {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let id = std::env::var("DBKIT_RUSTDESK_IT_ID").expect("DBKIT_RUSTDESK_IT_ID");
        let rp = rendezvous::Params {
            server: env("DBKIT_RUSTDESK_IT_SERVER", "127.0.0.1"),
            relay: env("DBKIT_RUSTDESK_IT_RELAY_SERVER", ""),
            key: env("DBKIT_RUSTDESK_IT_KEY", ""),
            force_relay: env("DBKIT_RUSTDESK_IT_RELAY", "") == "1",
        };
        let t0 = tokio::time::Instant::now();
        let est = match rendezvous::connect(&id, &rp).await {
            Ok(e) => e,
            Err(f) => panic!("{}: {}", f.code, f.message),
        };
        eprintln!("route = {}, signed pk = {} bytes, {:?}", est.route, est.signed_id_pk.len(), t0.elapsed());
        let mut login = direct(&id, "", Decoders::default(), "it");
        login.signed_id_pk = est.signed_id_pk;
        login.server_key = rp.key();
        let (pr, mut pw) = tokio::io::split(est.stream);
        let mut pr = FrameReader::new(pr);
        let (tx, mut rx, pending) = secure_handshake(&mut pr, &mut pw, &login).await.expect("加密握手");
        eprintln!("secure = {}, {:?}", tx.is_some(), t0.elapsed());
        let first = match pending {
            Some(p) => p,
            None => tokio::time::timeout(std::time::Duration::from_secs(20), pr.next())
                .await
                .expect("20 秒內要收到對方的第一則訊息")
                .expect("讀取")
                .expect("對方關了連線"),
        };
        let first = match rx.as_mut() {
            Some(c) => c.open(first).expect("解密（金鑰 / 序號對得上）"),
            None => first,
        };
        match session::classify(&first) {
            Incoming::Hash { salt, challenge } => {
                eprintln!("login challenge: salt {} chars, challenge {} chars, {:?}", salt.len(), challenge.len(), t0.elapsed())
            }
            x => panic!("第一則要是登入挑戰（Hash）：{x:?}"),
        }
        assert_eq!(tx.is_some(), !rp.key().is_empty(), "有 Key 就要加密");
    }

    async fn expect_login_and_key_frame(tcp: TcpStream, login: Login, want_secure: bool) {
        let (_host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(8 << 20);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(tcp, &mut stdin, &mut host_out_w, &login).await
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(40);
        let (mut connected, mut key_frame) = (None, None);
        while tokio::time::Instant::now() < deadline && (connected.is_none() || key_frame.is_none()) {
            let Ok(Ok(Some(raw))) = tokio::time::timeout(std::time::Duration::from_secs(15), ipc::read_raw(&mut host_out_r)).await else {
                break;
            };
            if raw[0] == ipc::OUT_JSON {
                let v: serde_json::Value = serde_json::from_slice(&raw[1..]).unwrap();
                eprintln!("event: {}", v["type"]);
                assert_ne!(v["type"], "login_error", "{v}");
                assert_ne!(v["type"], "closed", "{v}");
                if v["type"] == "connected" {
                    connected = Some(v);
                }
            } else if raw[0] == ipc::OUT_VIDEO && raw[2] == 1 {
                key_frame = Some((raw[1], raw.len()));
            }
        }
        let v = connected.expect("時限內要登入成功");
        assert!(v["peer"]["displays"].as_array().is_some_and(|d| !d.is_empty()), "{v}");
        assert_eq!(v["secure"].as_bool(), Some(want_secure), "{v}");
        let (codec, len) = key_frame.expect("時限內要收到關鍵畫面");
        assert!(codec == 1 || codec == 2, "VP9 / VP8：{codec}");
        assert!(len > 100, "畫面有內容：{len} bytes");
        task.abort();
    }

    #[tokio::test]
    async fn wrong_password_reports_login_error() {
        let (ours, mut theirs) = tokio::io::duplex(1 << 16);
        let (_host_in_w, host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(async move {
            let mut stdin = ipc::MsgReader::new(host_in_r);
            drive(ours, &mut stdin, &mut host_out_w, &direct("h", "bad", Decoders::default(), "")).await
        });
        let _ = codec::read_frame(&mut theirs).await.unwrap();
        send_peer(&mut theirs, &hash_msg("s", "c")).await;
        let _ = codec::read_frame(&mut theirs).await.unwrap();
        let mut m = Message::new();
        let mut resp = LoginResponse::new();
        resp.set_error("Wrong Password".into());
        m.set_login_response(resp);
        send_peer(&mut theirs, &m).await;
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => assert_eq!((v["type"].as_str(), v["message"].as_str()), (Some("login_error"), Some("Wrong Password"))),
            x => panic!("{x:?}"),
        }
        assert!(task.await.unwrap().is_ok());
    }
}
