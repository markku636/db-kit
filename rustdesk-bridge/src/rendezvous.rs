// 用 RustDesk ID 連線：經 ID 伺服器（hbbs）找到對方，先試直連（TCP 打洞），不行就經中繼伺服器（hbbr）。
//
// 流程照 RustDesk 官方用戶端（rustdesk/rustdesk 的 src/client.rs `_start_inner` / `connect` / `request_relay` /
// `create_relay`，AGPL-3.0）；ID 伺服器那端的行為對照 rustdesk/rustdesk-server 的 src/rendezvous_server.rs：
// 1. TCP 連 ID 伺服器（預設埠 21116），送 `PunchHoleRequest { id, licence_key = 伺服器公鑰, force_relay }`。
//    ID 伺服器一連上會先送一則 `KeyExchange`；官方用戶端沒有登入帳號時不做這段加密（`legacy_secure` 為假），
//    直接略過它，這裡一樣。
// 2. 回覆有兩種：
//    - `PunchHoleResponse`：失敗（ID 不存在 / 不在線上 / Key 不符）或對方位址 + 對方簽過名的公鑰 + 中繼伺服器。
//      拿到位址就從同一個本機埠（SO_REUSEADDR）直接 TCP 連過去——對方收到 PunchHole 時已經往我們的位址打過洞；
//      連不上就改走中繼（`request_relay`）。
//    - `RelayResponse`：對方決定走中繼（強制中繼、對稱式 NAT），已經在中繼伺服器上等，直接 `create_relay`。
// 3. `request_relay`：另開一條到 ID 伺服器的連線送 `RequestRelay { id, uuid, relay_server }`，等對方回
//    `RelayResponse`；`create_relay`：連中繼伺服器（預設埠 21117）送 `RequestRelay { licence_key, id, uuid }`，
//    中繼伺服器把同一個 uuid 的兩端接在一起，之後就是跟對方的直接串流。
// 回傳的 `signed_id_pk` 是 ID 伺服器簽過名的「對方 ID + 對方簽章公鑰」，接下來跟對方的加密握手要用
// （見 main.rs 的 `secure_handshake`）。
//
// SPDX-License-Identifier: AGPL-3.0-only

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

use protobuf::{EnumOrUnknown, Message as _};
use tokio::net::{TcpSocket, TcpStream};

use crate::codec::{read_frame, write_frame};
use crate::proto::rendezvous::{
    punch_hole_response, rendezvous_message, ConnType, NatType, PunchHoleRequest, RendezvousMessage, RequestRelay,
};

pub const RENDEZVOUS_PORT: u16 = 21116;
pub const RELAY_PORT: u16 = 21117;
/// 公開伺服器（hbb_common 的 `config::RENDEZVOUS_SERVERS`）。
pub const PUBLIC_SERVER: &str = "rs-ny.rustdesk.com";
/// 官方的 `CONNECT_TIMEOUT` / `READ_TIMEOUT`。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(18);
/// 宣告的用戶端版本（ID 伺服器 / 對方依版本決定功能；跟 session.rs 的登入一致）。
const VERSION: &str = "1.4.2";

/// db-kit 送來的 ID 伺服器設定（`connect` 指令的 `rendezvous` 欄位）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct Params {
    /// ID 伺服器（`host` / `host:port`）；空 = 公開伺服器。
    pub server: String,
    /// 中繼伺服器；空 = 用 ID 伺服器回的，再沒有就是 ID 伺服器的主機 + 21117。
    pub relay: String,
    /// ID 伺服器的公鑰（base64）；空且用公開伺服器時用公開伺服器的公鑰。
    pub key: String,
    pub force_relay: bool,
}

impl Params {
    pub fn server_addr(&self) -> String {
        let s = self.server.trim();
        check_port(if s.is_empty() { PUBLIC_SERVER } else { s }, RENDEZVOUS_PORT)
    }

    /// 送給伺服器的 `licence_key`、也是驗簽章用的公鑰。
    pub fn key(&self) -> String {
        let k = self.key.trim();
        if k.is_empty() && self.server.trim().is_empty() {
            crate::crypto::PUBLIC_SERVER_KEY.to_string()
        } else {
            k.to_string()
        }
    }

    /// ID 伺服器沒給中繼伺服器時的退路。
    fn fallback_relay(&self) -> String {
        let r = self.relay.trim();
        if !r.is_empty() {
            return r.to_string();
        }
        host_of(&self.server_addr())
    }
}

/// 連不上的原因。`code` 讓 db-kit 翻成使用者看得懂的句子；`message` 是原文。
#[derive(Debug)]
pub struct Fail {
    pub code: &'static str,
    pub message: String,
}

impl Fail {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// 跟對方接上的串流（還沒做加密握手）。
pub struct Established {
    pub stream: TcpStream,
    pub signed_id_pk: Vec<u8>,
    /// `direct` / `lan` / `relay`。
    pub route: &'static str,
}

/// `check_port`：沒寫埠就補上預設值（IPv6 要加中括號）。
pub fn check_port(host: &str, port: u16) -> String {
    let h = host.trim();
    if h.starts_with('[') {
        return if h.contains("]:") { h.to_string() } else { format!("{h}:{port}") };
    }
    match h.matches(':').count() {
        0 => format!("{h}:{port}"),
        1 => h.to_string(),
        _ => format!("[{h}]:{port}"),
    }
}

/// `host:port` → host（給「ID 伺服器的主機 + 21117」用）。
fn host_of(addr: &str) -> String {
    if let Some(rest) = addr.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return format!("[{}]", &rest[..end]);
        }
    }
    addr.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or_else(|| addr.to_string())
}

/// hbb_common 的 `AddrMangle::decode`（IPv4 位址混了時間戳記；18 bytes = IPv6 + 埠）。
pub fn decode_addr(bytes: &[u8]) -> Option<SocketAddr> {
    if bytes.len() > 16 {
        if bytes.len() != 18 {
            return None;
        }
        let port = u16::from_le_bytes([bytes[16], bytes[17]]);
        let ip: [u8; 16] = bytes[..16].try_into().ok()?;
        return Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(ip)), port));
    }
    let mut padded = [0u8; 16];
    padded[..bytes.len()].copy_from_slice(bytes);
    let number = u128::from_le_bytes(padded);
    let tm = (number >> 17) & (u32::MAX as u128);
    let ip = ((number >> 49).wrapping_sub(tm) as u32).to_le_bytes();
    let port = (number & 0xFF_FFFF).wrapping_sub(tm & 0xFFFF) as u16;
    Some(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]), port)))
}

async fn send(stream: &mut TcpStream, m: &RendezvousMessage) -> std::io::Result<()> {
    let bytes = m.write_to_bytes().map_err(std::io::Error::other)?;
    write_frame(stream, &bytes).await
}

/// 下一則不是 `KeyExchange` 的訊息（`get_next_nonkeyexchange_msg`）；逾時 / 斷線 → None。
async fn next_msg(stream: &mut TcpStream, wait: Duration) -> Option<rendezvous_message::Union> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let bytes = tokio::time::timeout_at(deadline, read_frame(stream)).await.ok()?.ok()??;
        let Ok(m) = RendezvousMessage::parse_from_bytes(&bytes) else { continue };
        match m.union {
            Some(rendezvous_message::Union::KeyExchange(_)) | None => continue,
            Some(u) => return Some(u),
        }
    }
}

async fn connect_tcp(addr: &str, what: &'static str) -> Result<TcpStream, Fail> {
    let s = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| Fail::new(what, format!("connect {addr}: timed out")))?
        .map_err(|e| Fail::new(what, format!("connect {addr}: {e}")))?;
    let _ = s.set_nodelay(true);
    Ok(s)
}

/// 經 ID 伺服器接上對方。
pub async fn connect(peer_id: &str, p: &Params) -> Result<Established, Fail> {
    let rs = p.server_addr();
    let key = p.key();
    let mut socket = connect_tcp(&rs, "rendezvous_connect").await?;
    let my_addr = socket.local_addr().map_err(|e| Fail::new("rendezvous_connect", e.to_string()))?;
    let start = Instant::now();

    let mut req = RendezvousMessage::new();
    req.set_punch_hole_request(PunchHoleRequest {
        id: peer_id.to_string(),
        // 強制中繼時官方用戶端自稱對稱式 NAT（對方就不會嘗試打洞）。
        nat_type: EnumOrUnknown::new(if p.force_relay { NatType::SYMMETRIC } else { NatType::UNKNOWN_NAT }),
        licence_key: key.clone(),
        conn_type: EnumOrUnknown::new(ConnType::DEFAULT_CONN),
        version: VERSION.into(),
        force_relay: p.force_relay,
        ..Default::default()
    });

    // 最多試 3 次，每次等久一點（官方：i * 3 秒，不能超過 ID 伺服器的連線逾時）。
    let mut punched = None;
    for i in 1..=3u64 {
        send(&mut socket, &req).await.map_err(|e| Fail::new("rendezvous_connect", e.to_string()))?;
        let Some(msg) = next_msg(&mut socket, Duration::from_secs(i * 3)).await else { continue };
        match msg {
            rendezvous_message::Union::PunchHoleResponse(ph) => {
                if ph.socket_addr.is_empty() {
                    if !ph.other_failure.is_empty() {
                        return Err(Fail::new("other", ph.other_failure));
                    }
                    use punch_hole_response::Failure;
                    return Err(match ph.failure.enum_value() {
                        Ok(Failure::ID_NOT_EXIST) => Fail::new("id_not_exist", "ID does not exist"),
                        Ok(Failure::OFFLINE) => Fail::new("offline", "Remote desktop is offline"),
                        Ok(Failure::LICENSE_MISMATCH) => Fail::new("key_mismatch", "Key mismatch"),
                        Ok(Failure::LICENSE_OVERUSE) => Fail::new("key_overuse", "Key overuse"),
                        _ => Fail::new("other", "other punch hole failure"),
                    });
                }
                let is_local = ph.is_local();
                let symmetric = ph.nat_type() == NatType::SYMMETRIC;
                let addr = decode_addr(&ph.socket_addr);
                punched = Some((addr, ph.pk.to_vec(), ph.relay_server.clone(), is_local, symmetric));
                break;
            }
            rendezvous_message::Union::RelayResponse(rr) => {
                // 對方已經在中繼伺服器上等（強制中繼 / 對稱式 NAT）。
                let signed = rr.pk().to_vec();
                let relay = if rr.relay_server.is_empty() { p.fallback_relay() } else { rr.relay_server.clone() };
                let stream = create_relay(peer_id, &rr.uuid, &relay, &key).await?;
                return Ok(Established { stream, signed_id_pk: signed, route: "relay" });
            }
            _ => {}
        }
    }
    drop(socket);
    let Some((peer_addr, signed, relay_server, is_local, symmetric)) = punched else {
        return Err(Fail::new("rendezvous_timeout", "Failed to connect via rendezvous server"));
    };
    let relay_server = if relay_server.is_empty() { p.fallback_relay() } else { relay_server };

    // 直連：區網 / 對稱式 NAT 只給 1 秒（打洞多半沒用），否則照官方：打洞花的時間 × 6，至少 1 秒。
    if !p.force_relay {
        if let Some(peer_addr) = peer_addr.filter(|a| a.port() != 0) {
            let used = start.elapsed();
            let wait = if is_local || symmetric {
                Duration::from_secs(1)
            } else {
                (used * 6).clamp(Duration::from_secs(1), CONNECT_TIMEOUT)
            };
            if let Ok(stream) = connect_from(my_addr, peer_addr, wait).await {
                return Ok(Established { stream, signed_id_pk: signed, route: if is_local { "lan" } else { "direct" } });
            }
        }
    }
    let stream = request_relay(peer_id, &relay_server, &rs, !signed.is_empty(), &key).await?;
    Ok(Established { stream, signed_id_pk: signed, route: "relay" })
}

/// 從跟 ID 伺服器那條連線同一個本機位址撥出去（TCP 打洞）；綁不上就用任意埠。
async fn connect_from(local: SocketAddr, peer: SocketAddr, wait: Duration) -> std::io::Result<TcpStream> {
    let dial = |bind: bool| async move {
        let socket = if peer.is_ipv4() { TcpSocket::new_v4()? } else { TcpSocket::new_v6()? };
        if bind && local.is_ipv4() == peer.is_ipv4() {
            socket.set_reuseaddr(true)?;
            socket.bind(local)?;
        }
        socket.connect(peer).await
    };
    let fut = async {
        match dial(true).await {
            Ok(s) => Ok(s),
            Err(_) => dial(false).await,
        }
    };
    let s = tokio::time::timeout(wait, fut)
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "direct connect timed out"))??;
    let _ = s.set_nodelay(true);
    Ok(s)
}

fn new_uuid() -> String {
    use crypto_box::aead::rand_core::RngCore;
    let mut b = [0u8; 16];
    crypto_box::aead::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// 請 ID 伺服器叫對方到中繼伺服器來（`request_relay`）。每次都開新連線：ID 伺服器用來源位址認人。
async fn request_relay(peer_id: &str, relay: &str, rs: &str, secure: bool, key: &str) -> Result<TcpStream, Fail> {
    let mut uuid = String::new();
    let mut refused = None;
    let mut ok = false;
    for _ in 1..=3 {
        let mut socket = connect_tcp(rs, "rendezvous_connect").await?;
        uuid = new_uuid();
        let mut m = RendezvousMessage::new();
        m.set_request_relay(RequestRelay {
            id: peer_id.to_string(),
            uuid: uuid.clone(),
            relay_server: relay.to_string(),
            secure,
            ..Default::default()
        });
        send(&mut socket, &m).await.map_err(|e| Fail::new("relay_failed", e.to_string()))?;
        if let Some(rendezvous_message::Union::RelayResponse(rr)) = next_msg(&mut socket, CONNECT_TIMEOUT).await {
            if !rr.refuse_reason.is_empty() {
                refused = Some(rr.refuse_reason);
                break;
            }
            ok = true;
            break;
        }
    }
    if let Some(r) = refused {
        return Err(Fail::new("relay_refused", r));
    }
    if !ok {
        return Err(Fail::new("relay_failed", "Timeout"));
    }
    create_relay(peer_id, &uuid, relay, key).await
}

/// 連中繼伺服器、報上 uuid（`create_relay`）；之後這條連線就接到對方。
async fn create_relay(peer_id: &str, uuid: &str, relay: &str, key: &str) -> Result<TcpStream, Fail> {
    let addr = check_port(relay, RELAY_PORT);
    let mut conn = connect_tcp(&addr, "relay_connect").await?;
    let mut m = RendezvousMessage::new();
    m.set_request_relay(RequestRelay {
        licence_key: key.to_string(),
        id: peer_id.to_string(),
        uuid: uuid.to_string(),
        conn_type: EnumOrUnknown::new(ConnType::DEFAULT_CONN),
        ..Default::default()
    });
    send(&mut conn, &m).await.map_err(|e| Fail::new("relay_connect", e.to_string()))?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// hbb_common `AddrMangle::encode` 的 IPv4 分支（照抄，時間戳記固定），確認解得回來。
    fn encode_v4(addr: SocketAddrV4, tm: u32) -> Vec<u8> {
        let tm = tm as u128;
        let ip = u32::from_le_bytes(addr.ip().octets()) as u128;
        let port = addr.port() as u128;
        let v = ((ip + tm) << 49) | (tm << 17) | (port + (tm & 0xFFFF));
        let bytes = v.to_le_bytes();
        let n = bytes.iter().rev().take_while(|b| **b == 0).count();
        bytes[..16 - n].to_vec()
    }

    #[test]
    fn addr_mangle_roundtrip() {
        for (ip, port, tm) in [([1, 2, 3, 4], 21118, 123_456_789u32), ([192, 168, 1, 5], 1, u32::MAX), ([10, 0, 0, 1], 65535, 0)] {
            let a = SocketAddrV4::new(Ipv4Addr::from(ip), port);
            assert_eq!(decode_addr(&encode_v4(a, tm)), Some(SocketAddr::V4(a)), "{a} tm={tm}");
        }
        let mut v6 = Ipv6Addr::LOCALHOST.octets().to_vec();
        v6.extend_from_slice(&21118u16.to_le_bytes());
        assert_eq!(decode_addr(&v6), Some("[::1]:21118".parse().unwrap()));
        assert_eq!(decode_addr(&[0u8; 17]), None);
    }

    #[test]
    fn ports_and_defaults() {
        assert_eq!(check_port("rd.example.com", 21116), "rd.example.com:21116");
        assert_eq!(check_port("rd.example.com:3000", 21116), "rd.example.com:3000");
        assert_eq!(check_port("::1", 21116), "[::1]:21116");
        assert_eq!(check_port("[::1]", 21117), "[::1]:21117");
        assert_eq!(check_port("[::1]:9", 21117), "[::1]:9");
        let p = Params::default();
        assert_eq!(p.server_addr(), "rs-ny.rustdesk.com:21116");
        assert_eq!(p.key(), crate::crypto::PUBLIC_SERVER_KEY, "公開伺服器 → 公開伺服器的公鑰");
        let p = Params { server: "proxy.example.com".into(), ..Default::default() };
        assert_eq!(p.key(), "", "自架伺服器沒填 Key 就不送");
        assert_eq!(p.fallback_relay(), "proxy.example.com");
        let p = Params { server: "proxy.example.com:3000".into(), relay: "relay.example.com".into(), ..Default::default() };
        assert_eq!(p.fallback_relay(), "relay.example.com");
        assert_eq!(host_of("[::1]:21116"), "[::1]");
    }

    #[test]
    fn uuid_format() {
        let u = new_uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert_ne!(u, new_uuid());
    }
}
