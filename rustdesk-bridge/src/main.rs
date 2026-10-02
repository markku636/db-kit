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
mod ipc;
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
        }
    }

    fn request(&self, proof: Vec<u8>, session_id: u64) -> Message {
        let hwid = if self.trusted { &self.hwid[..] } else { &[] };
        session::login_request(&self.peer_id, proof, self.decoders, session_id, &self.my_name, hwid)
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
                        Ok(Some(ipc::HostMsg::Json(v))) => {
                            // 格式不對的指令略過（db-kit 的 bug 不該讓連線斷掉）。
                            if let Ok(c) = serde_json::from_value::<Command>(v) {
                                if logged_in {
                                    session::send_sealed(&mut pw, &session::command_message(&c), &mut tx)
                                        .await
                                        .map_err(|e| e.to_string())?;
                                }
                            }
                        }
                        Ok(Some(ipc::HostMsg::Other)) => {}
                        // stdin 關了：db-kit 要斷線。
                        Ok(None) | Err(_) => return Ok(()),
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
            Incoming::Echo(m) => {
                session::send_sealed(&mut pw, &m, &mut tx).await.map_err(|e| e.to_string())?;
            }
            Incoming::Closed(reason) => {
                emit(stdout, json!({ "type": "closed", "reason": reason })).await?;
                return Ok(());
            }
            Incoming::Ignore => {}
        }
    }
}

async fn emit<O: AsyncWrite + Unpin>(stdout: &mut O, v: serde_json::Value) -> Result<(), String> {
    ipc::write_json(stdout, &v).await.map_err(|e| e.to_string())
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
