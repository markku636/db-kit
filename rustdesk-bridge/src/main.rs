// dbk-rustdesk-bridge：db-kit 的 RustDesk 相容連線輔助程式（AGPL-3.0，獨立程式；見 README.md）。
//
// db-kit 啟動它、從 stdin 送一則 `connect`，之後：
// - stdin 來的 JSON 指令（滑鼠 / 鍵盤 / 重送畫面）轉成 RustDesk 封包送給對方；
// - 對方送來的畫面原封不動（仍是 VP9 / VP8 / AV1 位元流）從 stdout 交給 db-kit，事件則是 JSON。
// stdin 關閉 = db-kit 要斷線，程式結束。
//
// SPDX-License-Identifier: AGPL-3.0-only

mod codec;
mod ipc;
mod session;

mod proto {
    include!(concat!(env!("OUT_DIR"), "/protos/mod.rs"));
}


use serde_json::json;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use session::{Command, Decoders, Incoming};

/// 第一則指令。
#[derive(Debug, serde::Deserialize)]
struct Connect {
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    /// 登入用的對方識別（Direct IP 時就是位址，跟官方用戶端一樣）；空 = 用 host。
    #[serde(default)]
    peer: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    decoders: Decoders,
    #[serde(default)]
    my_name: String,
}

fn default_port() -> u16 {
    21118
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let code = match run(&mut stdin, &mut stdout).await {
        Ok(()) => 0,
        Err(e) => {
            let _ = ipc::write_json(&mut stdout, &json!({ "type": "error", "message": e })).await;
            1
        }
    };
    std::process::exit(code);
}

async fn run<I, O>(stdin: &mut I, stdout: &mut O) -> Result<(), String>
where
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
{
    // 1. 等 connect。
    let first = ipc::read_msg(stdin).await.map_err(|e| e.to_string())?;
    let Some(ipc::HostMsg::Json(v)) = first else { return Ok(()) };
    let c: Connect = serde_json::from_value(v).map_err(|e| format!("bad connect: {e}"))?;
    let addr = format!("{}:{}", c.host, c.port);
    let tcp = tokio::time::timeout(session::CONNECT_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| format!("connect {addr}: timed out"))?
        .map_err(|e| format!("connect {addr}: {e}"))?;
    let _ = tcp.set_nodelay(true);
    let peer_id = if c.peer.is_empty() { c.host.clone() } else { c.peer.clone() };
    drive(tcp, stdin, stdout, &peer_id, &c.password, c.decoders, &c.my_name).await
}

/// 連上之後的主迴圈（泛型 stream：測試用 duplex 當對方）。
async fn drive<S, I, O>(
    peer: S,
    stdin: &mut I,
    stdout: &mut O,
    peer_id: &str,
    password: &str,
    decoders: Decoders,
    my_name: &str,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
{
    let (mut pr, mut pw) = tokio::io::split(peer);
    // Direct IP：沒有可驗證的對方金鑰，照官方用戶端送一則空訊息、不加密繼續（見 session.rs 開頭）。
    codec::write_frame(&mut pw, &[]).await.map_err(|e| e.to_string())?;

    let session_id: u64 = {
        use std::hash::{BuildHasher, Hasher};
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(std::process::id() as u64);
        h.finish()
    };
    let mut logged_in = false;
    let login_deadline = tokio::time::Instant::now() + session::LOGIN_TIMEOUT;

    loop {
        let wait_login = async {
            if logged_in {
                std::future::pending::<()>().await
            } else {
                tokio::time::sleep_until(login_deadline).await
            }
        };
        tokio::select! {
            data = session::recv(&mut pr) => {
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
                        let proof = session::password_proof(password, &salt, &challenge);
                        let m = session::login_request(peer_id, proof, decoders, session_id, my_name);
                        session::send(&mut pw, &m).await.map_err(|e| e.to_string())?;
                        if password.is_empty() {
                            emit(stdout, json!({ "type": "waiting_accept" })).await?;
                        }
                    }
                    Incoming::LoggedIn(pi) => {
                        logged_in = true;
                        emit(stdout, json!({ "type": "connected", "peer": pi })).await?;
                    }
                    Incoming::LoginError(e) => {
                        emit(stdout, json!({ "type": "login_error", "message": e })).await?;
                        return Ok(());
                    }
                    Incoming::Frames(frames) => {
                        for f in frames {
                            ipc::write_video(stdout, &f).await.map_err(|e| e.to_string())?;
                        }
                    }
                    Incoming::Echo(m) => {
                        session::send(&mut pw, &m).await.map_err(|e| e.to_string())?;
                    }
                    Incoming::Closed(reason) => {
                        emit(stdout, json!({ "type": "closed", "reason": reason })).await?;
                        return Ok(());
                    }
                    Incoming::Ignore => {}
                }
            }
            msg = ipc::read_msg(stdin) => {
                match msg {
                    Ok(Some(ipc::HostMsg::Json(v))) => {
                        // 格式不對的指令略過（db-kit 的 bug 不該讓連線斷掉）。
                        if let Ok(c) = serde_json::from_value::<Command>(v) {
                            if logged_in {
                                session::send(&mut pw, &session::command_message(&c)).await.map_err(|e| e.to_string())?;
                            }
                        }
                    }
                    Ok(Some(ipc::HostMsg::Other)) => {}
                    // stdin 關了：db-kit 要斷線。
                    Ok(None) | Err(_) => return Ok(()),
                }
            }
            _ = wait_login => {
                emit(stdout, json!({ "type": "login_error", "message": "login timed out" })).await?;
                return Ok(());
            }
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
        login_response, message, EncodedVideoFrame, EncodedVideoFrames, Hash, LoginResponse, Message, PeerInfo,
        VideoFrame,
    };
    use protobuf::Message as _;

    async fn send_peer<W: AsyncWrite + Unpin>(w: &mut W, m: &Message) {
        session::send(w, m).await.unwrap();
    }

    /// 端到端：假的 RustDesk 被控端（duplex）↔ drive ↔ 假的 db-kit（兩條 duplex 當 stdin / stdout）。
    #[tokio::test]
    async fn login_then_video_then_input() {
        let (ours, mut theirs) = tokio::io::duplex(1 << 20);
        let (mut host_in_w, mut host_in_r) = tokio::io::duplex(1 << 20);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(async move {
            drive(ours, &mut host_in_r, &mut host_out_w, "10.0.0.5", "pw", Decoders::default(), "pc").await
        });

        // 被控端：先收到空訊息
        let first = codec::read_frame(&mut theirs).await.unwrap().unwrap();
        assert!(first.is_empty(), "Direct IP 先送空訊息");
        // 出題
        let mut m = Message::new();
        m.set_hash(Hash { salt: "salt".into(), challenge: "chal".into(), ..Default::default() });
        send_peer(&mut theirs, &m).await;
        // 收到登入：密碼證明正確
        let lr = Message::parse_from_bytes(&codec::read_frame(&mut theirs).await.unwrap().unwrap()).unwrap();
        let Some(message::Union::LoginRequest(lr)) = lr.union else { panic!("expect login") };
        assert_eq!(&lr.password[..], &session::password_proof("pw", "salt", "chal")[..]);
        assert_eq!(lr.username, "10.0.0.5");
        // 登入成功
        let mut m = Message::new();
        let mut resp = LoginResponse::new();
        let mut pi = PeerInfo::new();
        pi.hostname = "office-pc".into();
        resp.union = Some(login_response::Union::PeerInfo(pi));
        m.set_login_response(resp);
        send_peer(&mut theirs, &m).await;
        match ipc::read_msg(&mut host_out_r).await.unwrap() {
            Some(ipc::HostMsg::Json(v)) => {
                assert_eq!(v["type"], "connected");
                assert_eq!(v["peer"]["hostname"], "office-pc");
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

    /// 對真的 RustDesk 被控端（tests/docker，Direct IP、密碼 dbkit123）：登入、收到 VP9 關鍵畫面。
    /// `cargo test -- --ignored real_peer`；`DBKIT_RUSTDESK_IT_HOST` 可改目標。
    #[tokio::test]
    #[ignore]
    async fn real_peer_login_and_first_frame() {
        let host = std::env::var("DBKIT_RUSTDESK_IT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let tcp = TcpStream::connect((host.as_str(), 21118)).await.expect("connect peer");
        let (_host_in_w, mut host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(8 << 20);
        let h = host.clone();
        let task = tokio::spawn(async move {
            drive(tcp, &mut host_in_r, &mut host_out_w, &h, "dbkit123", Decoders { vp9: true, vp8: true, av1: false }, "it").await
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        let (mut connected, mut key_frame) = (None, None);
        while tokio::time::Instant::now() < deadline && (connected.is_none() || key_frame.is_none()) {
            let Ok(Ok(Some(raw))) = tokio::time::timeout(std::time::Duration::from_secs(10), ipc::read_raw(&mut host_out_r)).await else {
                break;
            };
            if raw[0] == ipc::OUT_JSON {
                let v: serde_json::Value = serde_json::from_slice(&raw[1..]).unwrap();
                assert_ne!(v["type"], "login_error", "{v}");
                if v["type"] == "connected" {
                    connected = Some(v);
                }
            } else if raw[0] == ipc::OUT_VIDEO && raw[2] == 1 {
                key_frame = Some((raw[1], raw.len()));
            }
        }
        let v = connected.expect("30 秒內要登入成功");
        assert!(v["peer"]["displays"].as_array().is_some_and(|d| !d.is_empty()), "{v}");
        let (codec, len) = key_frame.expect("30 秒內要收到關鍵畫面");
        assert!(codec == 1 || codec == 2, "VP9 / VP8：{codec}");
        assert!(len > 100, "畫面有內容：{len} bytes");
        task.abort();
    }

    #[tokio::test]
    async fn wrong_password_reports_login_error() {
        let (ours, mut theirs) = tokio::io::duplex(1 << 16);
        let (_host_in_w, mut host_in_r) = tokio::io::duplex(1 << 16);
        let (mut host_out_w, mut host_out_r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(async move {
            drive(ours, &mut host_in_r, &mut host_out_w, "h", "bad", Decoders::default(), "").await
        });
        let _ = codec::read_frame(&mut theirs).await.unwrap();
        let mut m = Message::new();
        m.set_hash(Hash { salt: "s".into(), challenge: "c".into(), ..Default::default() });
        send_peer(&mut theirs, &m).await;
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
