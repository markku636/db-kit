//! 精簡 WebSocket 用戶端（RFC 6455），只服務 Kubernetes 的 exec / port-forward 串流。
//!
//! 交握走既有 reqwest（`Connection: Upgrade` + `Upgrade: websocket`，取回 `reqwest::Upgraded`），
//! 這樣 TLS / 用戶端憑證 / SSH 通道的 `resolve` 釘選全部沿用同一個 `Client`，不另起 TLS 堆疊。
//! 之後在 upgraded 連線上自己收發幀：用戶端送出的幀一律遮罩（mask）、支援分片重組、
//! 回應 ping、收到 close 即結束。
//!
//! Kubernetes 的 channel 協定（`v4.channel.k8s.io`）：每則 binary 訊息第一個位元組是 channel 編號，
//! 其後是該 channel 的資料。exec：0 stdin、1 stdout、2 stderr、3 錯誤（Status JSON）、4 resize；
//! port-forward：每個埠兩條 channel（資料 2i、錯誤 2i+1），每條 channel 的第一則訊息是 2-byte 埠號。

use base64::Engine as _;
use reqwest::header::{HeaderValue, CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, SEC_WEBSOCKET_VERSION, UPGRADE};
use reqwest::RequestBuilder;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};

use crate::error::{AppError, AppResult};

/// K8s 串流子協定（v4：error channel 帶 Status JSON，resize 為 channel 4）。
pub const CHANNEL_PROTOCOL: &str = "v4.channel.k8s.io";

const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

/// 單則訊息上限（防呆：log / exec 輸出每幀通常 < 32 KiB）。
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

/// 收到的一則完整訊息。
#[derive(Debug, PartialEq, Eq)]
pub enum Message {
    Binary(Vec<u8>),
    Text(String),
    /// 對端關閉（code、原因）。
    Close(Option<u16>, String),
}

/// `Sec-WebSocket-Accept` 的期望值。
pub fn accept_key(key: &str) -> String {
    let mut h = Sha1::new();
    h.update(key.as_bytes());
    h.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

/// 發出 upgrade 請求並驗證交握，回傳原始雙向串流。`rb` 須為 GET 且已帶認證標頭。
pub async fn connect(rb: RequestBuilder, protocol: &str) -> AppResult<reqwest::Upgraded> {
    let key_bytes: [u8; 16] = rand::random();
    let key = base64::engine::general_purpose::STANDARD.encode(key_bytes);
    let resp = rb
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header(SEC_WEBSOCKET_VERSION, "13")
        .header(SEC_WEBSOCKET_KEY, key.as_str())
        .header(SEC_WEBSOCKET_PROTOCOL, protocol)
        .send()
        .await
        .map_err(crate::db::http_tls::http_err)?;
    if resp.status() != reqwest::StatusCode::SWITCHING_PROTOCOLS {
        return Err(super::api::status_error(resp).await);
    }
    let expected = accept_key(&key);
    let got = resp.headers().get(SEC_WEBSOCKET_ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("");
    if got != expected {
        return Err(AppError::Connect(t!("WebSocket 交握失敗：伺服器回應的 Sec-WebSocket-Accept 不正確").into()));
    }
    let proto = resp.headers().get(SEC_WEBSOCKET_PROTOCOL).cloned().unwrap_or(HeaderValue::from_static(""));
    if proto.as_bytes() != protocol.as_bytes() {
        return Err(AppError::Connect(tf!(
            "API server 不支援串流子協定 {p}（回應：{got}）；叢集版本可能太舊",
            p = protocol,
            got = String::from_utf8_lossy(proto.as_bytes())
        )));
    }
    resp.upgrade().await.map_err(crate::db::http_tls::http_err)
}

/// 讀端：拆幀、重組分片。ping 需要回 pong，交給呼叫端（回傳 `Pong` 待送）。
pub struct WsReader<R> {
    inner: R,
}

/// 讀一則訊息的結果：訊息本身，或必須回送的控制幀（pong）。
pub enum Read {
    Msg(Message),
    Ping(Vec<u8>),
}

impl<R: AsyncRead + Unpin> WsReader<R> {
    pub fn new(inner: R) -> Self {
        WsReader { inner }
    }

    /// 讀下一則訊息（EOF → `Close(None)`）。
    pub async fn next(&mut self) -> std::io::Result<Read> {
        let mut assembled: Vec<u8> = Vec::new();
        let mut msg_op: Option<u8> = None;
        loop {
            let mut h = [0u8; 2];
            match self.inner.read_exact(&mut h).await {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(Read::Msg(Message::Close(None, String::new())));
                }
                Err(e) => return Err(e),
            }
            let fin = h[0] & 0x80 != 0;
            let op = h[0] & 0x0F;
            let masked = h[1] & 0x80 != 0;
            let mut len = (h[1] & 0x7F) as u64;
            if len == 126 {
                let mut b = [0u8; 2];
                self.inner.read_exact(&mut b).await?;
                len = u16::from_be_bytes(b) as u64;
            } else if len == 127 {
                let mut b = [0u8; 8];
                self.inner.read_exact(&mut b).await?;
                len = u64::from_be_bytes(b);
            }
            if len as usize > MAX_MESSAGE || assembled.len() + len as usize > MAX_MESSAGE {
                return Err(std::io::Error::other("websocket message too large"));
            }
            let mut mask = [0u8; 4];
            if masked {
                self.inner.read_exact(&mut mask).await?;
            }
            let mut payload = vec![0u8; len as usize];
            self.inner.read_exact(&mut payload).await?;
            if masked {
                apply_mask(&mut payload, mask);
            }
            match op {
                OP_PING => return Ok(Read::Ping(payload)),
                OP_PONG => continue,
                OP_CLOSE => {
                    let code = (payload.len() >= 2).then(|| u16::from_be_bytes([payload[0], payload[1]]));
                    let reason = if payload.len() > 2 { String::from_utf8_lossy(&payload[2..]).into_owned() } else { String::new() };
                    return Ok(Read::Msg(Message::Close(code, reason)));
                }
                OP_TEXT | OP_BINARY => {
                    msg_op = Some(op);
                    assembled = payload;
                }
                OP_CONT => {
                    if msg_op.is_none() {
                        return Err(std::io::Error::other("websocket continuation without start"));
                    }
                    assembled.extend_from_slice(&payload);
                }
                _ => return Err(std::io::Error::other(format!("websocket opcode {op}"))),
            }
            if fin {
                let data = std::mem::take(&mut assembled);
                return Ok(Read::Msg(match msg_op {
                    Some(OP_TEXT) => Message::Text(String::from_utf8_lossy(&data).into_owned()),
                    _ => Message::Binary(data),
                }));
            }
        }
    }
}

/// 寫端：送出遮罩過的幀。
pub struct WsWriter<W> {
    inner: W,
}

impl<W: AsyncWrite + Unpin> WsWriter<W> {
    pub fn new(inner: W) -> Self {
        WsWriter { inner }
    }

    pub async fn send_binary(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.send_frame(OP_BINARY, data).await
    }

    pub async fn send_pong(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.send_frame(OP_PONG, data).await
    }

    /// 送 close（1000 正常關閉）；失敗不重要（對端可能已斷）。
    pub async fn close(&mut self) {
        let _ = self.send_frame(OP_CLOSE, &1000u16.to_be_bytes()).await;
        let _ = self.inner.shutdown().await;
    }

    async fn send_frame(&mut self, op: u8, data: &[u8]) -> std::io::Result<()> {
        let frame = encode_frame(op, data, rand::random());
        self.inner.write_all(&frame).await?;
        self.inner.flush().await
    }
}

/// 組一個用戶端幀（FIN=1、mask=1）。
pub fn encode_frame(op: u8, data: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 14);
    out.push(0x80 | op);
    let len = data.len();
    if len < 126 {
        out.push(0x80 | len as u8);
    } else if len <= u16::MAX as usize {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    let start = out.len();
    out.extend_from_slice(data);
    apply_mask(&mut out[start..], mask);
    out
}

fn apply_mask(buf: &mut [u8], mask: [u8; 4]) {
    for (i, b) in buf.iter_mut().enumerate() {
        *b ^= mask[i & 3];
    }
}

/// 把 upgraded 連線拆成讀 / 寫兩端。
pub fn split<S: AsyncRead + AsyncWrite>(s: S) -> (WsReader<ReadHalf<S>>, WsWriter<WriteHalf<S>>) {
    let (r, w) = tokio::io::split(s);
    (WsReader::new(r), WsWriter::new(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_key_rfc_example() {
        // RFC 6455 §1.3 的範例。
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    /// 伺服器端幀（不遮罩）。
    fn server_frame(fin: bool, op: u8, data: &[u8]) -> Vec<u8> {
        let mut v = vec![if fin { 0x80 } else { 0 } | op];
        if data.len() < 126 {
            v.push(data.len() as u8);
        } else {
            v.push(126);
            v.extend_from_slice(&(data.len() as u16).to_be_bytes());
        }
        v.extend_from_slice(data);
        v
    }

    #[tokio::test]
    async fn reads_frames_fragments_and_ping() {
        let mut bytes = server_frame(true, OP_BINARY, &[1, b'h', b'i']);
        bytes.extend(server_frame(false, OP_BINARY, &[2, b'a']));
        bytes.extend(server_frame(true, OP_CONT, b"bc"));
        bytes.extend(server_frame(true, OP_PING, b"p"));
        let big = vec![7u8; 300];
        bytes.extend(server_frame(true, OP_BINARY, &big));
        bytes.extend(server_frame(true, OP_CLOSE, &[0x03, 0xE8, b'o', b'k']));
        let mut r = WsReader::new(&bytes[..]);
        let Read::Msg(m) = r.next().await.unwrap() else { panic!() };
        assert_eq!(m, Message::Binary(vec![1, b'h', b'i']));
        let Read::Msg(m) = r.next().await.unwrap() else { panic!() };
        assert_eq!(m, Message::Binary(vec![2, b'a', b'b', b'c']));
        assert!(matches!(r.next().await.unwrap(), Read::Ping(p) if p == b"p"));
        let Read::Msg(m) = r.next().await.unwrap() else { panic!() };
        assert_eq!(m, Message::Binary(big));
        let Read::Msg(m) = r.next().await.unwrap() else { panic!() };
        assert_eq!(m, Message::Close(Some(1000), "ok".into()));
        let Read::Msg(m) = r.next().await.unwrap() else { panic!() };
        assert_eq!(m, Message::Close(None, String::new()));
    }

    #[test]
    fn encodes_masked_frames() {
        let f = encode_frame(OP_BINARY, b"abc", [1, 2, 3, 4]);
        assert_eq!(f[0], 0x82);
        assert_eq!(f[1], 0x80 | 3);
        assert_eq!(&f[2..6], &[1, 2, 3, 4]);
        assert_eq!(&f[6..], &[b'a' ^ 1, b'b' ^ 2, b'c' ^ 3]);
        let long = encode_frame(OP_BINARY, &vec![0u8; 70000], [0; 4]);
        assert_eq!(long[1], 0x80 | 127);
        assert_eq!(u64::from_be_bytes(long[2..10].try_into().unwrap()), 70000);
        let mid = encode_frame(OP_BINARY, &vec![0u8; 200], [0; 4]);
        assert_eq!((mid[1], u16::from_be_bytes([mid[2], mid[3]])), (0x80 | 126, 200));
    }
}
