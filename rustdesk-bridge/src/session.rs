// 一條 RustDesk 連線的封包：登入、之後把畫面轉給 db-kit、把輸入轉給對方。
//
// 流程照 RustDesk 官方用戶端（rustdesk/rustdesk 的 src/client.rs、src/client/io_loop.rs，AGPL-3.0）：
// 1. 接上對方：Direct IP 是 TCP 連 `host:21118`，沒有 ID 伺服器可以驗對方的公鑰，官方用戶端此時送一則空訊息、
//    以不加密的方式繼續（`secure_connection` 的 no-sign 分支）；經 ID 伺服器時見 rendezvous.rs 與 main.rs 的
//    `secure_handshake`（驗過對方的公鑰就加密）。
// 2. 對方送 `Hash { salt, challenge }` → 回 `LoginRequest`，密碼欄是 `sha256(sha256(密碼 + salt) + challenge)`
//    （`handle_hash`）；沒有密碼就送空的，由對方在畫面上按「接受」。
// 3. `LoginResponse`：`peer_info`（成功，帶螢幕清單）或 `error`（密碼錯等）。對方開了雙重驗證時 error 是
//    `2FA Required`，連線不斷：在同一條連線送 `Auth2FA { code }`（官方 `send2fa`），錯了回 `Wrong 2FA Code`。
//    對方允許「信任這台裝置」時（`enable_trusted_devices`）`Auth2FA.hwid` 帶本機識別碼，對方記下來；之後
//    `LoginRequest.hwid` 帶同一個就不再問驗證碼。對方設成只能按「接受」時回 `No Password Access`，連線也不斷，
//    對方按了接受就直接回 `peer_info`。
// 4. 之後對方持續送 `VideoFrame`（VP9 / VP8 / AV1 其一，由我們在 `OptionMessage.supported_decoding` 宣告能解的），
//    `TestDelay` 要原樣回（不回對方會以為斷線）。
// 5. 多螢幕：切到某個螢幕 = `SwitchDisplay` + `CaptureDisplays { set: [它] }` + 要那個螢幕的關鍵畫面；
//    看全部 = `CaptureDisplays { set: [全部] }`，之後每張 `VideoFrame.display` 標明是哪個螢幕的（官方
//    `session_switch_display`）。對方換了螢幕 / 解析度回 `Misc.SwitchDisplay`，插拔螢幕送新的 `PeerInfo`。
// 6. 工具列的其他功能（官方 `src/client.rs` / `ui_session_interface.rs`）：畫質（`OptionMessage.image_quality`）、
//    偏好的編碼（`supported_decoding.prefer`）、封鎖對方輸入 / 停用剪貼簿 / 結束後鎖定（`OptionMessage` 的開關）、
//    鎖定畫面（`ControlKey::LockScreen`）、重新啟動對方（`Misc.restart_remote_device`）、剪貼簿（`Clipboard`，
//    對方送來的可能是 zstd 壓縮的）、把文字打過去（`KeyEvent.seq`）、聊天（`Misc.chat_message`）、
//    告知對方正在錄影（`Misc.client_record_status`）。對方的權限（`Misc.permission_info`）一開始只送被關掉的。
//
// SPDX-License-Identifier: AGPL-3.0-only

use std::time::Duration;

use protobuf::{EnumOrUnknown, Message as _, MessageField};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWrite;

use crate::codec::write_frame;
use crate::keymap;
use crate::proto::message::{
    back_notification, key_event, login_response, message, misc, permission_info, video_frame, Auth2FA,
    CaptureDisplays, ChatMessage, Clipboard, ClipboardFormat, ControlKey, DisplayInfo, EncodedVideoFrames,
    ImageQuality, KeyEvent, KeyboardMode, LoginRequest, Message, Misc, MouseEvent, OptionMessage, SupportedDecoding,
    SwitchDisplay,
};
use crate::proto::message::option_message::BoolOption;
use crate::proto::message::supported_decoding::PreferCodec;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);

/// 對方要雙重驗證碼 / 驗證碼錯（官方 `REQUIRE_2FA` / `LOGIN_MSG_2FA_WRONG`）。
pub const REQUIRE_2FA: &str = "2FA Required";
pub const WRONG_2FA: &str = "Wrong 2FA Code";
/// 對方只接受在畫面上按「接受」、不收密碼（官方 `LOGIN_MSG_NO_PASSWORD_ACCESS`）：連線不斷，等對方按。
pub const NO_PASSWORD_ACCESS: &str = "No Password Access";

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

impl From<&DisplayInfo> for Display {
    fn from(d: &DisplayInfo) -> Self {
        Self { x: d.x, y: d.y, width: d.width, height: d.height, name: d.name.clone() }
    }
}

/// 對方告知某個螢幕現在的位置與大小（切過去之後、或那個螢幕換了解析度）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DisplayChanged {
    pub display: i32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 一次最多看幾個螢幕（防呆：db-kit 的 bug 不該讓對方開一堆擷取）。
const MAX_DISPLAYS: usize = 16;
/// 對方剪貼簿解壓縮後的上限（官方 `MAX_DECOMPRESSED_SIZE` 是 256 MB；這裡只收文字，16 MB 很夠）。
const MAX_CLIPBOARD: usize = 16 * 1024 * 1024;

/// 對方的訊息框（官方 `MessageBox`：`msgtype` 如 `info` / `error` / `nook-nocancel-hasclose`；`text` 是英文）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MsgBox {
    pub msgtype: String,
    pub title: String,
    pub text: String,
}

fn permission_name(p: permission_info::Permission) -> &'static str {
    use permission_info::Permission as P;
    match p {
        P::Keyboard => "keyboard",
        P::Clipboard => "clipboard",
        P::Audio => "audio",
        P::File => "file",
        P::Restart => "restart",
        P::Recording => "recording",
        P::BlockInput => "block_input",
        P::PrivacyMode => "privacy_mode",
    }
}

/// zstd 解壓縮（官方 `hbb_common::compress::decompress`；純 Rust 的解碼器，不需要 libzstd）。
fn zstd_decompress(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut src = data;
    let dec = ruzstd::decoding::StreamingDecoder::new(&mut src).ok()?;
    let mut out = Vec::new();
    dec.take(MAX_CLIPBOARD as u64 + 1).read_to_end(&mut out).ok()?;
    (out.len() <= MAX_CLIPBOARD).then_some(out)
}

/// 剪貼簿裡的文字（只收 `Text` 格式；RTF / HTML / 圖片略過）。
fn clipboard_text(cb: &Clipboard) -> Option<String> {
    if cb.format.enum_value() != Ok(ClipboardFormat::Text) {
        return None;
    }
    let raw = if cb.compress { zstd_decompress(&cb.content)? } else { cb.content.to_vec() };
    String::from_utf8(raw).ok().filter(|s| !s.is_empty())
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

/// `hwid`：之前對這台勾過「信任這台裝置」才帶（官方只在 `trust-this-device` 開著時帶）；空 = 不帶。
pub fn login_request(peer: &str, proof: Vec<u8>, dec: Decoders, session_id: u64, my_name: &str, hwid: &[u8]) -> Message {
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
        hwid: hwid.to_vec().into(),
        ..Default::default()
    };
    let mut m = Message::new();
    m.set_login_request(lr);
    m
}

/// 截圖請求（官方 `ScreenshotRequest`）：對方從 `display` 的下一張畫面擷取，回 `ScreenshotResponse { sid, data: PNG }`。
pub fn screenshot_request(display: i32, sid: String) -> Message {
    let mut m = Message::new();
    m.set_screenshot_request(crate::proto::message::ScreenshotRequest { display, sid, ..Default::default() });
    m
}

/// 改成傳檔連線（官方 `ConnType::FILE_TRANSFER`：`LoginRequest.file_transfer`）：對方不送畫面，只處理檔案動作。
pub fn as_file_transfer(m: &mut Message) {
    if let Some(message::Union::LoginRequest(lr)) = m.union.as_mut() {
        lr.set_file_transfer(crate::proto::message::FileTransfer { dir: String::new(), show_hidden: false, ..Default::default() });
    }
}

/// 雙重驗證碼（驗證器 App 常顯示成 `123 456`，空白拿掉）。`hwid` 空 = 不要對方「信任這台裝置」；
/// 有值 = 請對方記住這台（對方的 `add_trusted_device`，認的是 hwid + `my_id` / `my_name` / `my_platform`）。
pub fn auth_2fa(code: &str, hwid: &[u8]) -> Message {
    let code = code.chars().filter(|c| !c.is_whitespace()).collect();
    let mut m = Message::new();
    m.set_auth_2fa(Auth2FA { code, hwid: hwid.to_vec().into(), ..Default::default() });
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
    /// 要雙重驗證碼：連線還在，等 `Auth2FA`。`wrong` = 上一個驗證碼錯了（`WRONG_2FA`）；`trust` = 對方允許
    /// 「信任這台裝置」（只有 `REQUIRE_2FA` 那則會帶，官方用戶端也只在那時更新）。
    Need2fa { wrong: bool, trust: bool },
    /// 對方只接受按「接受」（`NO_PASSWORD_ACCESS`）：連線還在，等對方按。
    NoPasswordAccess,
    Frames(Vec<Frame>),
    /// 對方的螢幕清單變了（插拔螢幕、改排列）：登入後另送的 `PeerInfo`。
    Displays(Vec<Display>),
    /// 對方換了螢幕 / 那個螢幕換了解析度（`Misc.SwitchDisplay`）。
    DisplayChanged(DisplayChanged),
    /// 要原樣回的封包（TestDelay）；`delay` = 對方量到的上一次來回延遲（毫秒），`bitrate` = 對方目前的目標位元率。
    Echo { msg: Message, delay: u32, bitrate: u32 },
    /// 對方給這條連線的權限變了（一開始只送被關掉的）。
    Permission { name: &'static str, enabled: bool },
    /// 對方複製了文字。
    Clipboard(String),
    Chat(String),
    /// 封鎖 / 解除封鎖對方輸入的結果。
    BlockInput { on: bool, ok: bool },
    MsgBox(MsgBox),
    Closed(String),
    /// 傳檔連線上對方的回覆（files.rs 處理）。
    FileResponse(crate::proto::message::FileResponse),
    /// 傳檔：上傳時對方回的 `send_confirm`。
    FileAction(crate::proto::message::FileAction),
    /// 對方的游標圖（RGBA，已解壓縮、驗過大小；官方 `decode_cursor_data`）。`id` 是字串（u64 在 JS 裡會失真）。
    CursorData(Cursor),
    /// 對方換成之前送過的那張游標圖。
    CursorId(String),
    /// 對方游標的位置（開了「顯示對方游標」才送）。
    CursorPosition { x: i32, y: i32 },
    /// 對方的游標 / 焦點視窗移到另一個螢幕（開了「跟著對方游標 / 視窗」時，官方 `follow_current_display`）。
    FollowDisplay(i32),
    /// 截圖的結果（`sid` 是我們送的編號；`msg` 非空 = 失敗原因；`data` 是 PNG）。
    Screenshot { sid: String, msg: String, data: Vec<u8> },
    Ignore,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub id: String,
    pub hotx: i32,
    pub hoty: i32,
    pub width: i32,
    pub height: i32,
    pub rgba: Vec<u8>,
}

/// 游標圖最大邊長（官方 `MAX_CURSOR_SIZE`）。
const MAX_CURSOR: i32 = 512;

/// 解游標圖：大小、熱點要合理，RGBA 是 zstd 壓縮的（官方 `decode_cursor_data`）。不合理的丟掉。
fn cursor_of(cd: &crate::proto::message::CursorData) -> Option<Cursor> {
    use std::io::Read;
    if !(1..=MAX_CURSOR).contains(&cd.width) || !(1..=MAX_CURSOR).contains(&cd.height) {
        return None;
    }
    if !(0..cd.width).contains(&cd.hotx) || !(0..cd.height).contains(&cd.hoty) {
        return None;
    }
    let expected = cd.width as usize * cd.height as usize * 4;
    let mut src = &cd.colors[..];
    let dec = ruzstd::decoding::StreamingDecoder::new(&mut src).ok()?;
    let mut rgba = Vec::with_capacity(expected);
    dec.take(expected as u64 + 1).read_to_end(&mut rgba).ok()?;
    (rgba.len() == expected).then(|| Cursor { id: cd.id.to_string(), hotx: cd.hotx, hoty: cd.hoty, width: cd.width, height: cd.height, rgba })
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
                displays: pi.displays.iter().map(Display::from).collect(),
            }),
            Some(login_response::Union::Error(e)) if e == REQUIRE_2FA || e == WRONG_2FA => {
                Incoming::Need2fa { wrong: e == WRONG_2FA, trust: lr.enable_trusted_devices }
            }
            Some(login_response::Union::Error(e)) if e == NO_PASSWORD_ACCESS => Incoming::NoPasswordAccess,
            Some(login_response::Union::Error(e)) => Incoming::LoginError(e),
            _ => Incoming::Ignore,
        },
        Some(message::Union::VideoFrame(vf)) => Incoming::Frames(frames_of(&vf)),
        Some(message::Union::FileResponse(fr)) => Incoming::FileResponse(fr),
        Some(message::Union::FileAction(fa)) => Incoming::FileAction(fa),
        Some(message::Union::CursorData(cd)) => cursor_of(&cd).map_or(Incoming::Ignore, Incoming::CursorData),
        Some(message::Union::CursorId(id)) => Incoming::CursorId(id.to_string()),
        Some(message::Union::CursorPosition(p)) => Incoming::CursorPosition { x: p.x, y: p.y },
        Some(message::Union::ScreenshotResponse(r)) => Incoming::Screenshot { sid: r.sid, msg: r.msg, data: r.data.to_vec() },
        Some(message::Union::PeerInfo(pi)) => Incoming::Displays(pi.displays.iter().map(Display::from).collect()),
        Some(message::Union::TestDelay(t)) if !t.from_client => {
            let (delay, bitrate) = (t.last_delay, t.target_bitrate);
            let mut msg = Message::new();
            msg.set_test_delay(t);
            Incoming::Echo { msg, delay, bitrate }
        }
        Some(message::Union::Clipboard(cb)) => clipboard_text(&cb).map_or(Incoming::Ignore, Incoming::Clipboard),
        Some(message::Union::MultiClipboards(mc)) => {
            mc.clipboards.iter().find_map(clipboard_text).map_or(Incoming::Ignore, Incoming::Clipboard)
        }
        Some(message::Union::MessageBox(mb)) => {
            Incoming::MsgBox(MsgBox { msgtype: mb.msgtype, title: mb.title, text: mb.text })
        }
        Some(message::Union::Misc(ms)) => match ms.union {
            Some(misc::Union::CloseReason(r)) => Incoming::Closed(r),
            Some(misc::Union::FollowCurrentDisplay(d)) => Incoming::FollowDisplay(d),
            Some(misc::Union::SwitchDisplay(sd)) => Incoming::DisplayChanged(DisplayChanged {
                display: sd.display,
                x: sd.x,
                y: sd.y,
                width: sd.width,
                height: sd.height,
            }),
            Some(misc::Union::PermissionInfo(p)) => match p.permission.enum_value() {
                Ok(perm) => Incoming::Permission { name: permission_name(perm), enabled: p.enabled },
                Err(_) => Incoming::Ignore,
            },
            Some(misc::Union::ChatMessage(c)) if !c.text.is_empty() => Incoming::Chat(c.text),
            Some(misc::Union::BackNotification(n)) => match n.union {
                Some(back_notification::Union::BlockInputState(s)) => {
                    use back_notification::BlockInputState as B;
                    match s.enum_value() {
                        Ok(B::BlkOnSucceeded) => Incoming::BlockInput { on: true, ok: true },
                        Ok(B::BlkOnFailed) => Incoming::BlockInput { on: true, ok: false },
                        Ok(B::BlkOffSucceeded) => Incoming::BlockInput { on: false, ok: true },
                        Ok(B::BlkOffFailed) => Incoming::BlockInput { on: false, ok: false },
                        _ => Incoming::Ignore,
                    }
                }
                _ => Incoming::Ignore,
            },
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
    /// `alt` / `ctrl` / `shift` / `meta` = 本機這時按著的修飾鍵（官方 `send_mouse` 的 modifiers）：對方按下滑鼠前
    /// 會把修飾鍵整理成跟這個一樣（`fix_modifiers`），沒帶的會被放開——Ctrl / Shift + 點選就失效。
    Mouse {
        mask: i32,
        x: i32,
        y: i32,
        #[serde(default)]
        alt: bool,
        #[serde(default)]
        ctrl: bool,
        #[serde(default)]
        shift: bool,
        #[serde(default)]
        meta: bool,
    },
    /// PC 掃描碼（擴充鍵 OR 0xE000）；送出前換成對方系統的鍵碼（keymap.rs）。`caps` / `num` = 本機的
    /// CapsLock / NumLock 開著沒（字母鍵帶 CapsLock、數字鍵盤帶 NumLock，對方照這個同步）。
    Key {
        down: bool,
        scancode: u32,
        #[serde(default)]
        caps: bool,
        #[serde(default)]
        num: bool,
    },
    CtrlAltDel,
    Refresh,
    /// 要看哪些螢幕（`PeerInfo.displays` 的索引）：一個 = 切到那個螢幕；多個 = 同時看（每張畫面帶 display）。
    Displays { set: Vec<i32> },
    /// 畫質：`best`（最佳畫質）/ `balanced`（平衡）/ `low`（最佳反應）。
    Quality { level: String },
    /// 偏好的編碼（`auto` / `vp9` / `vp8` / `av1`）+ 這端能解哪些；`i444` = 要真彩（4:4:4，官方 `i444` + `prefer_chroma`），
    /// 這端的 VP9 / AV1 解得了 4:4:4 時 db-kit 才會帶。
    Codec {
        prefer: String,
        #[serde(flatten)]
        decoders: Decoders,
        #[serde(default)]
        i444: bool,
    },
    /// 連線中的開關：`block_input`（封鎖對方的鍵盤滑鼠）/ `disable_clipboard` / `lock_after_session_end` /
    /// `show_remote_cursor`（對方送游標位置）/ `follow_remote_cursor` / `follow_remote_window`（對方游標 / 焦點換螢幕時通知）。
    Toggle { name: String, on: bool },
    /// 鎖定對方的畫面（Win+L）。
    LockScreen,
    /// 重新啟動對方的電腦。
    Restart,
    /// 本機複製的文字 → 對方的剪貼簿。
    Clipboard { text: String },
    /// 把文字直接打過去（對方的登入畫面這類不能貼上的地方也行）。
    TypeText { text: String },
    Chat { text: String },
    /// 告知對方：這端開始 / 停止錄影（對方畫面會顯示正在錄影）。
    Record { on: bool },
    /// 翻譯模式的一個字（本機鍵盤配置打出來的字，`KeyboardMode::Translate` + `seq`；對方先放開 Shift 再打）。
    Char { text: String },
    /// 輸入作業系統密碼：整段打過去再按 Enter（官方 `_input_os_password`；叫出密碼框的點擊由 db-kit 先送）。
    OsPassword { text: String },
}

/// 送指令時要知道的對方資訊。
#[derive(Debug, Clone, Default)]
pub struct PeerCtx {
    /// `Windows` / `Linux` / `Mac OS` / `Android`（`PeerInfo.platform`）。
    pub platform: String,
}

/// 對方是 Windows（還不知道時也當 Windows：db-kit 送的本來就是 Windows 的掃描碼）。
fn is_windows(peer: &PeerCtx) -> bool {
    peer.platform.is_empty() || peer.platform == "Windows"
}

fn option_message(o: OptionMessage) -> Message {
    misc_message(|m| m.set_option(o))
}

fn bool_option(on: bool) -> EnumOrUnknown<BoolOption> {
    EnumOrUnknown::new(if on { BoolOption::Yes } else { BoolOption::No })
}

/// 能解的編碼 + 偏好（官方 `update_supported_decodings`）。偏好的那個解不了就用自動。
/// `i444` = 要真彩：宣告 VP9 / AV1 解得了 4:4:4、偏好 I444（對方編得出來才會用）。
pub fn supported_decoding(dec: Decoders, prefer: &str, i444: bool) -> SupportedDecoding {
    let prefer = match prefer {
        "vp9" if dec.vp9 => PreferCodec::VP9,
        "vp8" if dec.vp8 => PreferCodec::VP8,
        "av1" if dec.av1 => PreferCodec::AV1,
        _ => PreferCodec::Auto,
    };
    SupportedDecoding {
        ability_vp9: i32::from(dec.vp9),
        ability_vp8: i32::from(dec.vp8),
        ability_av1: i32::from(dec.av1),
        // H.264 / H.265 要對方有硬體編碼器，而且 WebView 解 H.265 不一定行：不宣告。
        ability_h264: 0,
        ability_h265: 0,
        prefer: EnumOrUnknown::new(prefer),
        i444: MessageField::some(crate::proto::message::CodecAbility { vp9: i444 && dec.vp9, av1: i444 && dec.av1, ..Default::default() }),
        prefer_chroma: EnumOrUnknown::new(if i444 { crate::proto::message::Chroma::I444 } else { crate::proto::message::Chroma::I420 }),
        ..Default::default()
    }
}

/// 送一段字串的上限（`KeyEvent.seq` / 剪貼簿）：太長的貼上對方要打很久，剪貼簿則是防呆。
const MAX_TEXT: usize = 1024 * 1024;

fn misc_message(f: impl FnOnce(&mut Misc)) -> Message {
    let mut misc = Misc::new();
    f(&mut misc);
    let mut m = Message::new();
    m.set_misc(misc);
    m
}

/// 換螢幕的封包（照官方 `session_switch_display`）：
/// - 一個：`SwitchDisplay`（對方把「目前螢幕」換過去、回一則 `SwitchDisplay` 帶位置大小）
///   + `CaptureDisplays { set }`（我們自稱 1.2.4 以上，對方不會自己停掉舊螢幕的擷取，要我們說）；
/// - 多個：只有 `CaptureDisplays { set }`；
/// - 再對每個螢幕要一張關鍵畫面（那個螢幕本來就在擷取時對方不會重送，畫面會停在舊的）。
fn display_messages(wanted: &[i32]) -> Vec<Message> {
    let mut set: Vec<i32> = Vec::new();
    for &d in wanted {
        if d >= 0 && !set.contains(&d) && set.len() < MAX_DISPLAYS {
            set.push(d);
        }
    }
    let mut out = Vec::new();
    if let [one] = set[..] {
        out.push(misc_message(|m| m.set_switch_display(SwitchDisplay { display: one, ..Default::default() })));
    }
    if !set.is_empty() {
        out.push(misc_message(|m| m.set_capture_displays(CaptureDisplays { set: set.clone(), ..Default::default() })));
    }
    for d in set {
        out.push(misc_message(|m| m.set_refresh_video_display(d)));
    }
    out
}

/// db-kit 的一個指令 → 要送給對方的封包（換螢幕要好幾則；不認得的開關 / 畫質 → 不送）。
pub fn command_messages(c: &Command, peer: &PeerCtx) -> Vec<Message> {
    let mut m = Message::new();
    match c {
        Command::Mouse { mask, x, y, alt, ctrl, shift, meta } => {
            let mut e = MouseEvent { mask: *mask, x: *x, y: *y, ..Default::default() };
            for (on, ck) in [(alt, ControlKey::Alt), (shift, ControlKey::Shift), (ctrl, ControlKey::Control), (meta, ControlKey::Meta)] {
                if *on {
                    e.modifiers.push(EnumOrUnknown::new(ck));
                }
            }
            m.set_mouse_event(e);
        }
        // 官方 `windows_peer_special_key`：Windows 沒有 Pause 的掃描碼，改送舊式的 Pause 控制鍵。
        Command::Key { down, scancode: keymap::SCANCODE_PAUSE, .. } if is_windows(peer) => {
            let mut k = KeyEvent { down: *down, mode: EnumOrUnknown::new(KeyboardMode::Legacy), ..Default::default() };
            k.union = Some(key_event::Union::ControlKey(EnumOrUnknown::new(ControlKey::Pause)));
            m.set_key_event(k);
        }
        Command::Key { down, scancode, caps, num } => {
            let sc = *scancode;
            // 對方系統沒有這顆鍵：不送（送原碼會變成別的鍵）。
            let Some(code) = keymap::peer_keycode(sc, &peer.platform) else { return Vec::new() };
            let mut k = KeyEvent { down: *down, mode: EnumOrUnknown::new(KeyboardMode::Map), ..Default::default() };
            k.union = Some(key_event::Union::Chr(code));
            if *caps && keymap::is_letter(sc) {
                k.modifiers.push(EnumOrUnknown::new(ControlKey::CapsLock));
            }
            if *num && keymap::is_numpad(sc) {
                k.modifiers.push(EnumOrUnknown::new(ControlKey::NumLock));
            }
            m.set_key_event(k);
        }
        // 官方 `event_ctrl_alt_del`：Windows 用 CtrlAltDel 控制鍵（對方走 SAS）；其他系統送 Ctrl+Alt+Delete 組合。
        Command::CtrlAltDel if is_windows(peer) => {
            let mut k = KeyEvent { down: true, press: true, mode: EnumOrUnknown::new(KeyboardMode::Legacy), ..Default::default() };
            k.union = Some(key_event::Union::ControlKey(EnumOrUnknown::new(ControlKey::CtrlAltDel)));
            m.set_key_event(k);
        }
        Command::CtrlAltDel => {
            let mut k = KeyEvent { press: true, mode: EnumOrUnknown::new(KeyboardMode::Legacy), ..Default::default() };
            k.union = Some(key_event::Union::ControlKey(EnumOrUnknown::new(ControlKey::Delete)));
            k.modifiers = vec![EnumOrUnknown::new(ControlKey::Alt), EnumOrUnknown::new(ControlKey::Control)];
            m.set_key_event(k);
        }
        Command::Refresh => m = misc_message(|misc| misc.set_refresh_video(true)),
        Command::Displays { set } => return display_messages(set),
        Command::Quality { level } => {
            let q = match level.as_str() {
                "best" => ImageQuality::Best,
                "balanced" => ImageQuality::Balanced,
                "low" => ImageQuality::Low,
                _ => return Vec::new(),
            };
            m = option_message(OptionMessage { image_quality: EnumOrUnknown::new(q), ..Default::default() });
        }
        Command::Codec { prefer, decoders, i444 } => {
            m = option_message(OptionMessage {
                supported_decoding: MessageField::some(supported_decoding(*decoders, prefer, *i444)),
                ..Default::default()
            });
        }
        Command::Toggle { name, on } => {
            let mut o = OptionMessage::new();
            match name.as_str() {
                "block_input" => o.block_input = bool_option(*on),
                "disable_clipboard" => o.disable_clipboard = bool_option(*on),
                "lock_after_session_end" => o.lock_after_session_end = bool_option(*on),
                "show_remote_cursor" => o.show_remote_cursor = bool_option(*on),
                "follow_remote_cursor" => o.follow_remote_cursor = bool_option(*on),
                "follow_remote_window" => o.follow_remote_window = bool_option(*on),
                _ => return Vec::new(),
            }
            m = option_message(o);
        }
        Command::LockScreen => {
            let mut k = KeyEvent { down: true, mode: EnumOrUnknown::new(KeyboardMode::Legacy), ..Default::default() };
            k.union = Some(key_event::Union::ControlKey(EnumOrUnknown::new(ControlKey::LockScreen)));
            m.set_key_event(k);
        }
        Command::Restart => m = misc_message(|misc| misc.set_restart_remote_device(true)),
        Command::Clipboard { text } if !text.is_empty() && text.len() <= MAX_TEXT => {
            m.set_clipboard(Clipboard {
                compress: false,
                content: text.as_bytes().to_vec().into(),
                format: EnumOrUnknown::new(ClipboardFormat::Text),
                ..Default::default()
            });
        }
        Command::TypeText { text } if !text.is_empty() && text.len() <= MAX_TEXT => {
            let mut k = KeyEvent::new();
            k.set_seq(text.clone());
            m.set_key_event(k);
        }
        Command::Chat { text } if !text.is_empty() && text.len() <= MAX_TEXT => {
            m = misc_message(|misc| misc.set_chat_message(ChatMessage { text: text.clone(), ..Default::default() }));
        }
        // 官方 `try_fill_unicode`：翻譯模式下打得出字的鍵送那個字（只送按下）。
        Command::Char { text } if !text.is_empty() && text.chars().count() <= 8 => {
            let mut k = KeyEvent { down: true, mode: EnumOrUnknown::new(KeyboardMode::Translate), ..Default::default() };
            k.set_seq(text.clone());
            m.set_key_event(k);
        }
        Command::OsPassword { text } if !text.is_empty() && text.len() <= MAX_TEXT => {
            let mut k = KeyEvent { press: true, mode: EnumOrUnknown::new(KeyboardMode::Legacy), ..Default::default() };
            k.set_seq(text.clone());
            let mut enter = KeyEvent { press: true, mode: EnumOrUnknown::new(KeyboardMode::Legacy), ..Default::default() };
            enter.set_control_key(ControlKey::Return);
            let mut m2 = Message::new();
            m.set_key_event(k);
            m2.set_key_event(enter);
            return vec![m, m2];
        }
        Command::Clipboard { .. } | Command::TypeText { .. } | Command::Chat { .. } | Command::Char { .. } | Command::OsPassword { .. } => {
            return Vec::new()
        }
        Command::Record { on } => m = misc_message(|misc| misc.set_client_record_status(*on)),
    }
    vec![m]
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
        let m = login_request("192.168.1.5", vec![1, 2], Decoders { vp9: true, vp8: false, av1: true }, 7, "pc", &[]);
        let bytes = m.write_to_bytes().unwrap();
        assert!(Message::parse_from_bytes(&bytes).is_ok(), "序列化再解回來");
        let Some(message::Union::LoginRequest(lr)) = m.union else { panic!() };
        assert_eq!(lr.username, "192.168.1.5");
        assert_eq!(&lr.password[..], &[1, 2]);
        assert_eq!(lr.my_platform, "Windows");
        assert!(lr.hwid.is_empty(), "沒信任過 → 不帶 hwid");
        let m = login_request("h", vec![], Decoders::default(), 7, "pc", &[7; 32]);
        assert!(matches!(m.union, Some(message::Union::LoginRequest(ref lr)) if lr.hwid[..] == [7; 32]));
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

        for (e, trust, want) in [
            (REQUIRE_2FA, true, (false, true)),
            (REQUIRE_2FA, false, (false, false)),
            (WRONG_2FA, false, (true, false)),
        ] {
            let mut m = Message::new();
            let mut lr = LoginResponse { enable_trusted_devices: trust, ..Default::default() };
            lr.set_error(e.into());
            m.set_login_response(lr);
            match classify(&m.write_to_bytes().unwrap()) {
                Incoming::Need2fa { wrong, trust } => assert_eq!((wrong, trust), want, "{e}"),
                x => panic!("{e}：不是登入失敗 {x:?}"),
            }
        }

        let mut m = Message::new();
        let mut lr = LoginResponse::new();
        lr.set_error(NO_PASSWORD_ACCESS.into());
        m.set_login_response(lr);
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::NoPasswordAccess), "只能按接受：不是登入失敗");

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
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Echo { .. }));
        assert!(matches!(classify(b"\xff\xff\xff"), Incoming::Ignore), "壞封包不致命");
    }

    fn one(c: &Command) -> Message {
        let mut v = command_messages(c, &PeerCtx::default());
        assert_eq!(v.len(), 1, "{c:?}");
        v.remove(0)
    }

    #[test]
    fn commands_encode() {
        let c: Command = serde_json::from_str(r#"{"t":"key","down":true,"scancode":57435}"#).unwrap();
        let m = one(&c);
        let Some(message::Union::KeyEvent(k)) = m.union else { panic!() };
        assert_eq!(k.union, Some(key_event::Union::Chr(0xE05B)));
        assert_eq!(k.mode.enum_value(), Ok(KeyboardMode::Map));
        assert!(k.modifiers.is_empty());
        let c: Command = serde_json::from_str(r#"{"t":"mouse","mask":9,"x":10,"y":20}"#).unwrap();
        let m = one(&c);
        assert!(matches!(m.union, Some(message::Union::MouseEvent(ref e)) if e.mask == 9 && e.x == 10 && e.modifiers.is_empty()));
        let m = one(&Command::Refresh);
        assert!(matches!(m.union, Some(message::Union::Misc(ref ms)) if ms.refresh_video()));
        let m = auth_2fa(" 123 456 ", &[]);
        assert!(matches!(m.union, Some(message::Union::Auth2fa(ref a)) if a.code == "123456" && a.hwid.is_empty()));
        let m = auth_2fa("123456", &[1, 2, 3]);
        assert!(matches!(m.union, Some(message::Union::Auth2fa(ref a)) if a.hwid[..] == [1, 2, 3]), "信任這台裝置 → 帶 hwid");
    }

    fn miscs(c: &str) -> Vec<misc::Union> {
        let c: Command = serde_json::from_str(c).unwrap();
        command_messages(&c, &PeerCtx::default())
            .into_iter()
            .map(|m| {
                // 每則都要能序列化（真的會送出去）
                let m = Message::parse_from_bytes(&m.write_to_bytes().unwrap()).unwrap();
                match m.union {
                    Some(message::Union::Misc(ms)) => ms.union.unwrap(),
                    x => panic!("{x:?}"),
                }
            })
            .collect()
    }

    fn key_event(c: &str, platform: &str) -> KeyEvent {
        let c: Command = serde_json::from_str(c).unwrap();
        let mut v = command_messages(&c, &PeerCtx { platform: platform.into() });
        assert_eq!(v.len(), 1);
        match v.remove(0).union {
            Some(message::Union::KeyEvent(k)) => k,
            x => panic!("{x:?}"),
        }
    }

    fn mods(k: &KeyEvent) -> Vec<ControlKey> {
        k.modifiers.iter().map(|m| m.enum_value().unwrap()).collect()
    }

    /// 官方 `_map_keyboard_mode` + `add_lock_modes_modifiers`：鍵碼依對方系統換算；字母帶 CapsLock、數字鍵盤帶 NumLock。
    #[test]
    fn keys_follow_peer_platform_and_lock_modes() {
        // A（0x1E = 30）
        let k = key_event(r#"{"t":"key","down":true,"scancode":30,"caps":true,"num":true}"#, "Windows");
        assert_eq!((k.chr(), mods(&k)), (0x1E, vec![ControlKey::CapsLock]), "字母只帶 CapsLock");
        let k = key_event(r#"{"t":"key","down":true,"scancode":30,"caps":true}"#, "Linux");
        assert_eq!((k.chr(), mods(&k)), (38, vec![ControlKey::CapsLock]), "Linux 的 A 是 38");
        let k = key_event(r#"{"t":"key","down":false,"scancode":30}"#, "Mac OS");
        assert_eq!((k.chr(), k.down, mods(&k)), (0, false, vec![]), "macOS 的 A 是 0；CapsLock 沒開不帶");
        // 數字鍵盤 1（0x4F = 79）：NumLock 開著才帶，不帶 CapsLock
        let k = key_event(r#"{"t":"key","down":true,"scancode":79,"caps":true,"num":true}"#, "Windows");
        assert_eq!((k.chr(), mods(&k)), (0x4F, vec![ControlKey::NumLock]));
        let k = key_event(r#"{"t":"key","down":true,"scancode":79,"num":false}"#, "Windows");
        assert!(k.modifiers.is_empty(), "NumLock 關著 = 對方也關掉（數字鍵盤當方向鍵）");
        // 主鍵盤的 1 / Enter：都不帶
        for sc in [2, 28] {
            let k = key_event(&format!(r#"{{"t":"key","down":true,"scancode":{sc},"caps":true,"num":true}}"#), "Windows");
            assert!(k.modifiers.is_empty(), "{sc}");
        }
        // Pause：Windows 對方送舊式控制鍵；Linux 送 127
        let k = key_event(r#"{"t":"key","down":true,"scancode":57629}"#, "Windows");
        assert_eq!((k.control_key(), k.down, k.mode.enum_value()), (ControlKey::Pause, true, Ok(KeyboardMode::Legacy)));
        let k = key_event(r#"{"t":"key","down":true,"scancode":57629}"#, "Linux");
        assert_eq!(k.chr(), 127);
        // 對方系統沒有的鍵：不送
        let c: Command = serde_json::from_str(r#"{"t":"key","down":true,"scancode":70}"#).unwrap();
        assert!(command_messages(&c, &PeerCtx { platform: "Mac OS".into() }).is_empty(), "macOS 沒有 ScrollLock");
    }

    /// 翻譯模式的字（官方 `try_fill_unicode`）與輸入作業系統密碼（官方 `_input_os_password`：seq + Enter）。
    #[test]
    fn translate_char_and_os_password() {
        let k = key_event(r#"{"t":"char","text":"é"}"#, "Linux");
        assert_eq!((k.seq(), k.down, k.mode.enum_value()), ("é", true, Ok(KeyboardMode::Translate)));
        let c: Command = serde_json::from_str(r#"{"t":"char","text":""}"#).unwrap();
        assert!(command_messages(&c, &PeerCtx::default()).is_empty(), "空字不送");

        let c: Command = serde_json::from_str(r#"{"t":"os_password","text":"P@ss 1"}"#).unwrap();
        let msgs = command_messages(&c, &PeerCtx { platform: "Linux".into() });
        let keys: Vec<KeyEvent> = msgs
            .into_iter()
            .map(|m| match Message::parse_from_bytes(&m.write_to_bytes().unwrap()).unwrap().union {
                Some(message::Union::KeyEvent(k)) => k,
                x => panic!("{x:?}"),
            })
            .collect();
        assert_eq!(keys.len(), 2);
        assert_eq!((keys[0].seq(), keys[0].press, keys[0].mode.enum_value()), ("P@ss 1", true, Ok(KeyboardMode::Legacy)));
        assert_eq!((keys[1].control_key(), keys[1].press), (ControlKey::Return, true), "打完按 Enter");
        let c: Command = serde_json::from_str(r#"{"t":"os_password","text":""}"#).unwrap();
        assert!(command_messages(&c, &PeerCtx::default()).is_empty());
    }

    /// 官方 `send_mouse`：滑鼠事件帶著按住的修飾鍵（對方按下前照這個整理修飾鍵）。
    #[test]
    fn mouse_carries_modifiers() {
        let c: Command = serde_json::from_str(r#"{"t":"mouse","mask":9,"x":1,"y":2,"ctrl":true,"shift":true}"#).unwrap();
        let Some(message::Union::MouseEvent(e)) = one(&c).union else { panic!() };
        let got: Vec<ControlKey> = e.modifiers.iter().map(|m| m.enum_value().unwrap()).collect();
        assert_eq!(got, vec![ControlKey::Shift, ControlKey::Control]);
        let c: Command = serde_json::from_str(r#"{"t":"mouse","mask":10,"x":1,"y":2,"alt":true,"meta":true}"#).unwrap();
        let Some(message::Union::MouseEvent(e)) = one(&c).union else { panic!() };
        let got: Vec<ControlKey> = e.modifiers.iter().map(|m| m.enum_value().unwrap()).collect();
        assert_eq!(got, vec![ControlKey::Alt, ControlKey::Meta]);
    }

    /// 官方 `event_ctrl_alt_del`：Windows → CtrlAltDel 控制鍵；Linux / macOS → Delete + Ctrl / Alt。
    #[test]
    fn ctrl_alt_del_depends_on_peer_platform() {
        for p in ["Windows", ""] {
            let k = key_event(r#"{"t":"ctrl_alt_del"}"#, p);
            assert_eq!(k.control_key(), ControlKey::CtrlAltDel, "{p}");
            assert!(k.modifiers.is_empty());
        }
        let k = key_event(r#"{"t":"ctrl_alt_del"}"#, "Linux");
        assert_eq!(k.control_key(), ControlKey::Delete);
        assert!(k.press && !k.down);
        let mods: Vec<_> = k.modifiers.iter().map(|m| m.enum_value().unwrap()).collect();
        assert!(mods.contains(&ControlKey::Control) && mods.contains(&ControlKey::Alt), "{mods:?}");
        let k = key_event(r#"{"t":"lock_screen"}"#, "Windows");
        assert_eq!((k.control_key(), k.down, k.mode.enum_value()), (ControlKey::LockScreen, true, Ok(KeyboardMode::Legacy)));
        let k = key_event(r#"{"t":"type_text","text":"P@ss 密碼"}"#, "Windows");
        assert_eq!(k.seq(), "P@ss 密碼", "整段字串交給對方打（官方 `input_string`）");
    }

    fn option_of(c: &str) -> Option<OptionMessage> {
        match miscs(c).pop()? {
            misc::Union::Option(o) => Some(o),
            x => panic!("{x:?}"),
        }
    }

    /// 畫質 / 編碼 / 開關都是 Misc.option；不認得的值什麼都不送。
    #[test]
    fn options_encode() {
        let o = option_of(r#"{"t":"quality","level":"low"}"#).unwrap();
        assert_eq!(o.image_quality.enum_value(), Ok(ImageQuality::Low));
        assert_eq!(option_of(r#"{"t":"quality","level":"best"}"#).unwrap().image_quality.enum_value(), Ok(ImageQuality::Best));
        assert!(option_of(r#"{"t":"quality","level":"ultra"}"#).is_none());

        let o = option_of(r#"{"t":"codec","prefer":"vp8","vp9":true,"vp8":true,"av1":false}"#).unwrap();
        let d = o.supported_decoding.unwrap();
        assert_eq!((d.ability_vp9, d.ability_vp8, d.ability_av1, d.prefer.enum_value()), (1, 1, 0, Ok(PreferCodec::VP8)));
        let d = option_of(r#"{"t":"codec","prefer":"av1","vp9":true}"#).unwrap().supported_decoding.unwrap();
        assert_eq!(d.prefer.enum_value(), Ok(PreferCodec::Auto), "偏好的解不了 → 自動");

        let o = option_of(r#"{"t":"toggle","name":"block_input","on":true}"#).unwrap();
        assert_eq!(o.block_input.enum_value(), Ok(BoolOption::Yes));
        let o = option_of(r#"{"t":"toggle","name":"disable_clipboard","on":false}"#).unwrap();
        assert_eq!((o.disable_clipboard.enum_value(), o.block_input.enum_value()), (Ok(BoolOption::No), Ok(BoolOption::NotSet)));
        let o = option_of(r#"{"t":"toggle","name":"lock_after_session_end","on":true}"#).unwrap();
        assert_eq!(o.lock_after_session_end.enum_value(), Ok(BoolOption::Yes));
        assert!(option_of(r#"{"t":"toggle","name":"privacy_mode","on":true}"#).is_none(), "沒做的開關不送");

        assert!(matches!(miscs(r#"{"t":"restart"}"#)[..], [misc::Union::RestartRemoteDevice(true)]));
        assert!(matches!(&miscs(r#"{"t":"chat","text":"hi"}"#)[..], [misc::Union::ChatMessage(c)] if c.text == "hi"));
        assert!(miscs(r#"{"t":"chat","text":""}"#).is_empty());
        assert!(matches!(miscs(r#"{"t":"record","on":true}"#)[..], [misc::Union::ClientRecordStatus(true)]));
    }

    /// 本機的剪貼簿文字 → `Clipboard`（不壓縮；對方看 `compress` 決定要不要解）。
    #[test]
    fn clipboard_to_peer() {
        let c: Command = serde_json::from_str(r#"{"t":"clipboard","text":"複製的 text"}"#).unwrap();
        let v = command_messages(&c, &PeerCtx::default());
        let Some(message::Union::Clipboard(cb)) = v[0].union.clone() else { panic!("{v:?}") };
        assert!(!cb.compress);
        assert_eq!(cb.format.enum_value(), Ok(ClipboardFormat::Text));
        assert_eq!(std::str::from_utf8(&cb.content).unwrap(), "複製的 text");
        let c = Command::Clipboard { text: String::new() };
        assert!(command_messages(&c, &PeerCtx::default()).is_empty(), "空的不送");
        let c = Command::Clipboard { text: "x".repeat(MAX_TEXT + 1) };
        assert!(command_messages(&c, &PeerCtx::default()).is_empty(), "太大的不送");
    }

    /// 對方的剪貼簿：官方用 zstd 壓縮（壓得比較小才壓）；MultiClipboards 取第一個文字；圖片略過。
    #[test]
    fn clipboard_from_peer() {
        let text = "對方複製的一段文字 ".repeat(50);
        let packed = ruzstd::encoding::compress_to_vec(text.as_bytes(), ruzstd::encoding::CompressionLevel::Fastest);
        assert!(packed.len() < text.len());
        let cb = |compress: bool, content: Vec<u8>, format: ClipboardFormat| Clipboard {
            compress,
            content: content.into(),
            format: EnumOrUnknown::new(format),
            ..Default::default()
        };
        let mut m = Message::new();
        m.set_clipboard(cb(true, packed.clone(), ClipboardFormat::Text));
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Clipboard(ref t) if *t == text));
        let mut m = Message::new();
        m.set_clipboard(cb(false, b"plain".to_vec(), ClipboardFormat::Text));
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Clipboard(ref t) if t == "plain"));

        let mut m = Message::new();
        m.set_multi_clipboards(crate::proto::message::MultiClipboards {
            clipboards: vec![cb(false, vec![1, 2, 3], ClipboardFormat::ImageRgba), cb(true, packed, ClipboardFormat::Text)],
            ..Default::default()
        });
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Clipboard(ref t) if *t == text));

        let mut m = Message::new();
        m.set_clipboard(cb(true, b"not zstd".to_vec(), ClipboardFormat::Text));
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Ignore), "壞的壓縮資料不致命");
        let mut m = Message::new();
        m.set_clipboard(cb(false, vec![0xff, 0xfe], ClipboardFormat::Text));
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Ignore), "不是 UTF-8 → 略過");
    }

    /// 游標圖（zstd 壓縮的 RGBA；大小 / 熱點不合理的丟掉）、游標 id / 位置、跟著換螢幕、截圖回覆。
    #[test]
    fn classify_cursor_and_screenshot() {
        use crate::proto::message::{CursorData, CursorPosition, ScreenshotResponse};
        // ruzstd 只會解：用「原樣區塊」手做一個 zstd frame（magic + 單一 raw block）。
        fn zstd_raw(data: &[u8]) -> Vec<u8> {
            let mut f = vec![0x28, 0xB5, 0x2F, 0xFD, 0x20, data.len() as u8];
            let n = data.len() as u32;
            let hdr = (n << 3) | 1; // last block、raw
            f.extend_from_slice(&hdr.to_le_bytes()[..3]);
            f.extend_from_slice(data);
            f
        }
        let rgba: Vec<u8> = (0..2 * 2 * 4).map(|i| i as u8).collect();
        let mut m = Message::new();
        m.set_cursor_data(CursorData { id: 18446744073709551615, hotx: 1, hoty: 0, width: 2, height: 2, colors: zstd_raw(&rgba).into(), ..Default::default() });
        match classify(&m.write_to_bytes().unwrap()) {
            Incoming::CursorData(c) => {
                assert_eq!((c.id.as_str(), c.hotx, c.width, c.height), ("18446744073709551615", 1, 2, 2), "id 用字串：u64 在 JS 會失真");
                assert_eq!(c.rgba, rgba);
            }
            x => panic!("{x:?}"),
        }
        // 熱點在圖外 / 太大 / 解出來長度不對：丟掉
        for (w, h, hx, colors) in [(2, 2, 5, zstd_raw(&rgba)), (600, 2, 0, zstd_raw(&rgba)), (3, 3, 0, zstd_raw(&rgba))] {
            let mut m = Message::new();
            m.set_cursor_data(CursorData { id: 1, hotx: hx, width: w, height: h, colors: colors.into(), ..Default::default() });
            assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Ignore), "{w}x{h} hot {hx}");
        }
        let mut m = Message::new();
        m.set_cursor_id(42);
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::CursorId(ref id) if id == "42"));
        let mut m = Message::new();
        m.set_cursor_position(CursorPosition { x: -5, y: 9, ..Default::default() });
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::CursorPosition { x: -5, y: 9 }));
        let m = misc_message(|ms| ms.set_follow_current_display(1));
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::FollowDisplay(1)));
        let mut m = Message::new();
        m.set_screenshot_response(ScreenshotResponse { sid: "dbk-1".into(), data: vec![0x89, b'P'].into(), ..Default::default() });
        assert!(matches!(classify(&m.write_to_bytes().unwrap()), Incoming::Screenshot { ref sid, ref data, .. } if sid == "dbk-1" && data == &[0x89, b'P']));
        assert!(matches!(screenshot_request(2, "s".into()).union, Some(message::Union::ScreenshotRequest(ref r)) if r.display == 2 && r.sid == "s"));
    }

    /// 真彩：宣告 VP9 / AV1 解得了 4:4:4、偏好 I444；新開關（顯示對方游標、跟著對方游標 / 視窗）。
    #[test]
    fn true_color_and_cursor_toggles() {
        let o = option_of(r#"{"t":"codec","prefer":"auto","vp9":true,"vp8":true,"av1":false,"i444":true}"#).unwrap();
        let d = o.supported_decoding.unwrap();
        assert_eq!((d.i444.vp9, d.i444.av1, d.prefer_chroma.enum_value()), (true, false, Ok(crate::proto::message::Chroma::I444)));
        let o = option_of(r#"{"t":"codec","prefer":"auto","vp9":true,"vp8":true,"av1":true}"#).unwrap();
        let d = o.supported_decoding.unwrap();
        assert_eq!((d.i444.vp9, d.prefer_chroma.enum_value()), (false, Ok(crate::proto::message::Chroma::I420)), "沒要真彩");
        let o = option_of(r#"{"t":"toggle","name":"show_remote_cursor","on":true}"#).unwrap();
        assert_eq!(o.show_remote_cursor.enum_value(), Ok(BoolOption::Yes));
        let o = option_of(r#"{"t":"toggle","name":"follow_remote_cursor","on":true}"#).unwrap();
        assert_eq!(o.follow_remote_cursor.enum_value(), Ok(BoolOption::Yes));
        let o = option_of(r#"{"t":"toggle","name":"follow_remote_window","on":false}"#).unwrap();
        assert_eq!(o.follow_remote_window.enum_value(), Ok(BoolOption::No));
    }

    /// 權限、聊天、封鎖輸入的結果、訊息框、延遲。
    #[test]
    fn classify_session_events() {
        use crate::proto::message::{BackNotification, PermissionInfo};
        let msg = |f: &dyn Fn(&mut Misc)| {
            let mut misc = Misc::new();
            f(&mut misc);
            let mut m = Message::new();
            m.set_misc(misc);
            m.write_to_bytes().unwrap()
        };
        let p = msg(&|m| {
            m.set_permission_info(PermissionInfo {
                permission: EnumOrUnknown::new(permission_info::Permission::BlockInput),
                enabled: false,
                ..Default::default()
            })
        });
        assert!(matches!(classify(&p), Incoming::Permission { name: "block_input", enabled: false }));
        let c = msg(&|m| m.set_chat_message(ChatMessage { text: "在嗎".into(), ..Default::default() }));
        assert!(matches!(classify(&c), Incoming::Chat(ref t) if t == "在嗎"));
        let b = msg(&|m| {
            let mut n = BackNotification::new();
            n.set_block_input_state(back_notification::BlockInputState::BlkOnFailed);
            m.set_back_notification(n)
        });
        assert!(matches!(classify(&b), Incoming::BlockInput { on: true, ok: false }));

        let mut m = Message::new();
        m.set_message_box(crate::proto::message::MessageBox {
            msgtype: "error".into(),
            title: "Restart".into(),
            text: "No permission".into(),
            ..Default::default()
        });
        match classify(&m.write_to_bytes().unwrap()) {
            Incoming::MsgBox(b) => assert_eq!((b.msgtype.as_str(), b.text.as_str()), ("error", "No permission")),
            x => panic!("{x:?}"),
        }

        let mut m = Message::new();
        m.set_test_delay(TestDelay { time: 5, from_client: false, last_delay: 42, target_bitrate: 3000, ..Default::default() });
        match classify(&m.write_to_bytes().unwrap()) {
            Incoming::Echo { msg, delay, bitrate } => {
                assert_eq!((delay, bitrate), (42, 3000));
                assert!(matches!(msg.union, Some(message::Union::TestDelay(ref t)) if t.time == 5), "原樣回");
            }
            x => panic!("{x:?}"),
        }
    }

    /// 切到一個螢幕：SwitchDisplay + 只擷取它 + 要它的關鍵畫面（官方 `session_switch_display` 的順序）。
    #[test]
    fn switching_to_one_display() {
        let v = miscs(r#"{"t":"displays","set":[1]}"#);
        assert_eq!(v.len(), 3, "{v:?}");
        assert!(matches!(&v[0], misc::Union::SwitchDisplay(s) if s.display == 1 && s.width == 0 && s.height == 0), "不要求改解析度");
        assert!(matches!(&v[1], misc::Union::CaptureDisplays(c) if c.set == [1] && c.add.is_empty() && c.sub.is_empty()));
        assert!(matches!(&v[2], misc::Union::RefreshVideoDisplay(1)));
    }

    /// 看全部：只有 CaptureDisplays（不換「目前螢幕」），每個都要一張關鍵畫面；重複 / 負數丟掉。
    #[test]
    fn showing_all_displays() {
        let v = miscs(r#"{"t":"displays","set":[0,1,1,-1,2]}"#);
        assert_eq!(v.len(), 4, "{v:?}");
        assert!(matches!(&v[0], misc::Union::CaptureDisplays(c) if c.set == [0, 1, 2]));
        assert!(matches!(&v[1..], [misc::Union::RefreshVideoDisplay(0), misc::Union::RefreshVideoDisplay(1), misc::Union::RefreshVideoDisplay(2)]));
        assert!(miscs(r#"{"t":"displays","set":[]}"#).is_empty(), "空的 = 什麼都不送（對方會把擷取全停掉）");
        let many = (0..40).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        assert_eq!(miscs(&format!(r#"{{"t":"displays","set":[{many}]}}"#)).len(), 1 + MAX_DISPLAYS);
    }

    /// 對方的螢幕變動：插拔螢幕送 PeerInfo（新清單）、換螢幕 / 換解析度送 Misc.SwitchDisplay。
    #[test]
    fn classify_display_changes() {
        let mut m = Message::new();
        let mut pi = crate::proto::message::PeerInfo::new();
        pi.displays = vec![
            DisplayInfo { x: 0, y: 0, width: 1920, height: 1080, name: "\\\\.\\DISPLAY1".into(), ..Default::default() },
            DisplayInfo { x: -1280, y: 0, width: 1280, height: 1024, name: "\\\\.\\DISPLAY2".into(), ..Default::default() },
        ];
        m.set_peer_info(pi);
        match classify(&m.write_to_bytes().unwrap()) {
            Incoming::Displays(d) => {
                assert_eq!(d.len(), 2);
                assert_eq!((d[1].x, d[1].width, d[1].height), (-1280, 1280, 1024), "左邊的螢幕 x 是負的");
            }
            x => panic!("{x:?}"),
        }
        let mut m = Message::new();
        let mut misc = Misc::new();
        misc.set_switch_display(SwitchDisplay { display: 1, x: -1280, y: 0, width: 1280, height: 1024, ..Default::default() });
        m.set_misc(misc);
        match classify(&m.write_to_bytes().unwrap()) {
            Incoming::DisplayChanged(c) => assert_eq!(c, DisplayChanged { display: 1, x: -1280, y: 0, width: 1280, height: 1024 }),
            x => panic!("{x:?}"),
        }
    }
}
