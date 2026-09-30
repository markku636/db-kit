// 一條 RustDesk 連線的封包：登入、之後把畫面轉給 db-kit、把輸入轉給對方。
//
// 流程照 RustDesk 官方用戶端（rustdesk/rustdesk 的 src/client.rs、src/client/io_loop.rs，AGPL-3.0）：
// 1. 接上對方：Direct IP 是 TCP 連 `host:21118`，沒有 ID 伺服器可以驗對方的公鑰，官方用戶端此時送一則空訊息、
//    以不加密的方式繼續（`secure_connection` 的 no-sign 分支）；經 ID 伺服器時見 rendezvous.rs 與 main.rs 的
//    `secure_handshake`（驗過對方的公鑰就加密）。
// 2. 對方送 `Hash { salt, challenge }` → 回 `LoginRequest`，密碼欄是 `sha256(sha256(密碼 + salt) + challenge)`
//    （`handle_hash`）；沒有密碼就送空的，由對方在畫面上按「接受」。
// 3. `LoginResponse`：`peer_info`（成功，帶螢幕清單）或 `error`（密碼錯等）。
// 4. 之後對方持續送 `VideoFrame`（VP9 / VP8 / AV1 其一，由我們在 `OptionMessage.supported_decoding` 宣告能解的），
//    `TestDelay` 要原樣回（不回對方會以為斷線）。
//
// SPDX-License-Identifier: AGPL-3.0-only

use std::time::Duration;

use protobuf::{EnumOrUnknown, Message as _, MessageField};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWrite;

use crate::codec::write_frame;
use crate::proto::message::{
    key_event, login_response, message, misc, video_frame, ControlKey, EncodedVideoFrames, KeyEvent, KeyboardMode,
    LoginRequest, Message, Misc, MouseEvent, OptionMessage, SupportedDecoding,
};
use crate::proto::message::option_message::BoolOption;
use crate::proto::message::supported_decoding::PreferCodec;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);

/// 影像編碼（送給 db-kit 的代碼）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Codec {
    Vp9 = 1,
    Vp8 = 2,
    Av1 = 3,
    H264 = 4,
    H265 = 5,
}

/// 一張編碼後的畫面。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub codec: Codec,
    pub key: bool,
    pub display: u8,
    pub pts: i64,
    pub data: Vec<u8>,
}

/// 登入成功時的對方資訊。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PeerInfo {
    pub hostname: String,
    pub username: String,
    pub platform: String,
    pub version: String,
    pub current_display: i32,
    pub displays: Vec<Display>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Display {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub name: String,
}

/// 能解哪些編碼（db-kit 依 WebView 的 `VideoDecoder.isConfigSupported` 決定後告訴我們）。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct Decoders {
    #[serde(default = "yes")]
    pub vp9: bool,
    #[serde(default)]
    pub vp8: bool,
    #[serde(default)]
    pub av1: bool,
}

fn yes() -> bool {
    true
}

impl Default for Decoders {
    fn default() -> Self {
        Self { vp9: true, vp8: false, av1: false }
    }
}

/// 密碼證明：`sha256(sha256(password + salt) + challenge)`（沒有密碼 → 空）。
pub fn password_proof(password: &str, salt: &str, challenge: &str) -> Vec<u8> {
    if password.is_empty() {
        return Vec::new();
    }
    let mut h = Sha256::new();
    h.update(password.as_bytes());
    h.update(salt.as_bytes());
    let first = h.finalize();
    let mut h = Sha256::new();
    h.update(first);
    h.update(challenge.as_bytes());
    h.finalize().to_vec()
}

pub fn login_request(peer: &str, proof: Vec<u8>, dec: Decoders, session_id: u64, my_name: &str) -> Message {
    let decoding = SupportedDecoding {
        ability_vp9: i32::from(dec.vp9),
        ability_vp8: i32::from(dec.vp8),
        ability_av1: i32::from(dec.av1),
        // H.264 / H.265 要對方有硬體編碼器，而且 WebView 解 H.265 不一定行：不宣告。
        ability_h264: 0,
        ability_h265: 0,
        prefer: EnumOrUnknown::new(if dec.vp9 { PreferCodec::VP9 } else if dec.av1 { PreferCodec::AV1 } else { PreferCodec::VP8 }),
        ..Default::default()
    };
    let option = OptionMessage {
        supported_decoding: MessageField::some(decoding),
        // 游標由 db-kit 這端畫（本機游標），不請對方另送游標圖。
        show_remote_cursor: EnumOrUnknown::new(BoolOption::No),
        ..Default::default()
    };
    let lr = LoginRequest {
        username: peer.to_string(),
        password: proof.into(),
        my_id: "db-kit".into(),
        my_name: my_name.to_string(),
        // 鍵盤送 PC 掃描碼（Windows 的 position code），所以自稱 Windows。
        my_platform: "Windows".into(),
        option: MessageField::some(option),
        session_id,
        version: "1.4.2".into(),
        ..Default::default()
    };
    let mut m = Message::new();
    m.set_login_request(lr);
    m
}

/// 解出畫面（一則 VideoFrame 可能帶好幾張）。未宣告的編碼（RGB / YUV / H.26x）略過。
pub fn frames_of(vf: &crate::proto::message::VideoFrame) -> Vec<Frame> {
    let display = vf.display.clamp(0, 255) as u8;
    let (codec, list): (Codec, &EncodedVideoFrames) = match &vf.union {
        Some(video_frame::Union::Vp9s(f)) => (Codec::Vp9, f),
        Some(video_frame::Union::Vp8s(f)) => (Codec::Vp8, f),
        Some(video_frame::Union::Av1s(f)) => (Codec::Av1, f),
        Some(video_frame::Union::H264s(f)) => (Codec::H264, f),
        Some(video_frame::Union::H265s(f)) => (Codec::H265, f),
        _ => return Vec::new(),
    };
    list.frames
        .iter()
        .map(|f| Frame { codec, key: f.key, display, pts: f.pts, data: f.data.to_vec() })
        .collect()
}

/// 對方送來的東西，整理成 db-kit 需要的事件。
#[derive(Debug)]
pub enum Incoming {
    /// 要登入：salt / challenge。
    Hash { salt: String, challenge: String },
    LoggedIn(PeerInfo),
    LoginError(String),
    Frames(Vec<Frame>),
    /// 要原樣回的封包（TestDelay）。
    Echo(Message),
    Closed(String),
    Ignore,
}

pub fn classify(data: &[u8]) -> Incoming {
    let Ok(m) = Message::parse_from_bytes(data) else { return Incoming::Ignore };
    match m.union {
        Some(message::Union::Hash(h)) => Incoming::Hash { salt: h.salt, challenge: h.challenge },
        Some(message::Union::LoginResponse(lr)) => match lr.union {
            Some(login_response::Union::PeerInfo(pi)) => Incoming::LoggedIn(PeerInfo {
                hostname: pi.hostname.clone(),
                username: pi.username.clone(),
                platform: pi.platform.clone(),
                version: pi.version.clone(),
                current_display: pi.current_display,
                displays: pi
                    .displays
                    .iter()
                    .map(|d| Display { x: d.x, y: d.y, width: d.width, height: d.height, name: d.name.clone() })
                    .collect(),
            }),
            Some(login_response::Union::Error(e)) => Incoming::LoginError(e),
            _ => Incoming::Ignore,
        },
        Some(message::Union::VideoFrame(vf)) => Incoming::Frames(frames_of(&vf)),
        Some(message::Union::TestDelay(t)) if !t.from_client => {
            let mut out = Message::new();
            out.set_test_delay(t);
            Incoming::Echo(out)
        }
        Some(message::Union::Misc(ms)) => match ms.union {
            Some(misc::Union::CloseReason(r)) => Incoming::Closed(r),
            _ => Incoming::Ignore,
        },
        _ => Incoming::Ignore,
    }
}

/// db-kit 送來的輸入 → 要送給對方的封包。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Command {
    /// `mask` = 型別（0 移動、1 按下、2 放開、3 滾輪）| 按鍵 << 3（1 左、2 右、4 中）；滾輪時 x / y 是捲動量。
    Mouse { mask: i32, x: i32, y: i32 },
    /// PC 掃描碼（擴充鍵 OR 0xE000，跟 Windows 用戶端送的一樣）。
    Key { down: bool, scancode: u32 },
    CtrlAltDel,
    Refresh,
}

pub fn command_message(c: &Command) -> Message {
    let mut m = Message::new();
    match c {
        Command::Mouse { mask, x, y } => {
            m.set_mouse_event(MouseEvent { mask: *mask, x: *x, y: *y, ..Default::default() });
        }
        Command::Key { down, scancode } => {
            let mut k = KeyEvent { down: *down, mode: EnumOrUnknown::new(KeyboardMode::Map), ..Default::default() };
            k.union = Some(key_event::Union::Chr(*scancode));
            m.set_key_event(k);
        }
        Command::CtrlAltDel => {
            let mut k = KeyEvent { down: true, press: true, mode: EnumOrUnknown::new(KeyboardMode::Legacy), ..Default::default() };
            k.union = Some(key_event::Union::ControlKey(EnumOrUnknown::new(ControlKey::CtrlAltDel)));
            m.set_key_event(k);
        }
        Command::Refresh => {
            let mut misc = Misc::new();
            misc.set_refresh_video(true);
            m.set_misc(misc);
        }
    }
    m
}

pub async fn send<W: AsyncWrite + Unpin>(w: &mut W, m: &Message) -> std::io::Result<()> {
    let bytes = m.write_to_bytes().map_err(std::io::Error::other)?;
    write_frame(w, &bytes).await
}

/// 加密握手完成後（`tx` 有值）每個封包先 secretbox 再加長度標頭。
pub async fn send_sealed<W: AsyncWrite + Unpin>(
    w: &mut W,
    m: &Message,
    tx: &mut Option<crate::crypto::Cipher>,
) -> std::io::Result<()> {
    let bytes = m.write_to_bytes().map_err(std::io::Error::other)?;
    match tx {
        Some(c) => write_frame(w, &c.seal(&bytes)).await,
        None => write_frame(w, &bytes).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::message::{EncodedVideoFrame, Hash, LoginResponse, TestDelay, VideoFrame};

    #[test]
    fn password_proof_matches_reference() {
        // 照 handle_hash 的兩步 sha256 逐步重算一次（獨立路徑）。
        let first = Sha256::digest(b"secret123salt");
        let mut h = Sha256::new();
        h.update(first);
        h.update(b"chal");
        assert_eq!(password_proof("secret123", "salt", "chal"), h.finalize().to_vec());
        assert!(password_proof("", "salt", "chal").is_empty(), "沒密碼 → 空（對方按接受）");
    }

    #[test]
    fn login_request_declares_decoders_and_platform() {
        let m = login_request("192.168.1.5", vec![1, 2], Decoders { vp9: true, vp8: false, av1: true }, 7, "pc");
        let bytes = m.write_to_bytes().unwrap();
        assert!(Message::parse_from_bytes(&bytes).is_ok(), "序列化再解回來");
        let Some(message::Union::LoginRequest(lr)) = m.union else { panic!() };
        assert_eq!(lr.username, "192.168.1.5");
        assert_eq!(&lr.password[..], &[1, 2]);
        assert_eq!(lr.my_platform, "Windows");
        let d = lr.option.supported_decoding.clone().unwrap();
        assert_eq!((d.ability_vp9, d.ability_vp8, d.ability_av1, d.ability_h264), (1, 0, 1, 0));
        assert_eq!(d.prefer.enum_value(), Ok(PreferCodec::VP9));
    }

    #[test]
    fn classify_hash_login_video_testdelay() {
        let mut m = Message::new();
        m.set_hash(Hash { salt: "s".into(), challenge: "c".into(), ..Default::default() });
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Hash { ref salt, ref challenge } if salt == "s" && challenge == "c"));

        let mut m = Message::new();
        let mut lr = LoginResponse::new();
        lr.set_error("Wrong Password".into());
        m.set_login_response(lr);
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::LoginError(ref e) if e == "Wrong Password"));

        let mut m = Message::new();
        let mut vf = VideoFrame { display: 1, ..Default::default() };
        vf.set_vp9s(EncodedVideoFrames {
            frames: vec![EncodedVideoFrame { data: vec![9, 9].into(), key: true, pts: 42, ..Default::default() }],
            ..Default::default()
        });
        m.set_video_frame(vf);
        match classify(&m.write_to_bytes().unwrap()) {
            Incoming::Frames(f) => assert_eq!(f, vec![Frame { codec: Codec::Vp9, key: true, display: 1, pts: 42, data: vec![9, 9] }]),
            x => panic!("{x:?}"),
        }

        let mut m = Message::new();
        m.set_test_delay(TestDelay { time: 5, from_client: false, ..Default::default() });
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Echo(_)));
        assert!(matches!(classify(b"\xff\xff\xff"), Incoming::Ignore), "壞封包不致命");
    }

    #[test]
    fn commands_encode() {
        let m = command_message(&Command::Key { down: true, scancode: 0xE05B });
        let Some(message::Union::KeyEvent(k)) = m.union else { panic!() };
        assert_eq!(k.union, Some(key_event::Union::Chr(0xE05B)));
        assert_eq!(k.mode.enum_value(), Ok(KeyboardMode::Map));
        let c: Command = serde_json::from_str(r#"{"t":"mouse","mask":9,"x":10,"y":20}"#).unwrap();
        let m = command_message(&c);
        assert!(matches!(m.union, Some(message::Union::MouseEvent(ref e)) if e.mask == 9 && e.x == 10));
        let m = command_message(&Command::Refresh);
        assert!(matches!(m.union, Some(message::Union::Misc(_))));
    }
}
