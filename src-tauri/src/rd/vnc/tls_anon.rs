//! VeNCrypt 的匿名 TLS（TLSNone / TLSVnc / TLSPlain）——TigerVNC 這類伺服器預設就是這種。
//!
//! 匿名 TLS 沒有憑證（GnuTLS 的 ANON-ECDH），rustls 不支援，所以這裡做一個只夠用的 TLS 1.2 用戶端：
//! - 金鑰交換：ECDH_anon，曲線只用 X25519（TigerVNC 1.15 / GnuTLS 3.8 實測挑的就是它；DH_anon 伺服器不收）。
//! - 加密套件：`TLS_ECDH_anon_WITH_AES_256_CBC_SHA`（0xC019）/ `..._AES_128_CBC_SHA`（0xC018）。
//!   紀錄層是 TLS 1.2 的 MAC-then-encrypt：HMAC-SHA1 → 補 padding → AES-CBC，每筆紀錄帶明確 IV。
//! - PRF：TLS 1.2 的 P_SHA256；伺服器同意時用 extended master secret（RFC 7627）。
//! - 兩邊的 Finished 都驗；MAC / padding 不對就斷線。
//!
//! 匿名 TLS 只防被動竊聽、擋不了中間人（沒有憑證可以驗對方是誰），UI 會標「未驗證伺服器」；
//! 要防中間人得用 X509 子型別（`tls_x509`）或經 SSH 主機連線。
//!
//! 握手完成後回一條普通的串流（`tokio::io::duplex` 的一端）：背景 task 負責加解密轉送，
//! 上層（TLS 裡面的 VNC 認證、之後的 pump）照舊讀寫，不知道底下有 TLS。

use aes::cipher::{generic_array::GenericArray, BlockDecrypt, BlockEncrypt, KeyInit};
use curve25519_dalek::montgomery::MontgomeryPoint;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::auth::fill_random;
use crate::error::{AppError, AppResult};
use crate::rd::transport::BoxStream;

const CT_CCS: u8 = 20;
const CT_ALERT: u8 = 21;
const CT_HANDSHAKE: u8 = 22;
const CT_APP: u8 = 23;

const HS_HELLO_REQUEST: u8 = 0;
const HS_CLIENT_HELLO: u8 = 1;
const HS_SERVER_HELLO: u8 = 2;
const HS_CERTIFICATE: u8 = 11;
const HS_SERVER_KEY_EXCHANGE: u8 = 12;
const HS_SERVER_HELLO_DONE: u8 = 14;
const HS_CLIENT_KEY_EXCHANGE: u8 = 16;
const HS_FINISHED: u8 = 20;

const TLS10: [u8; 2] = [3, 1];
const TLS12: [u8; 2] = [3, 3];

const SUITE_AES128: u16 = 0xC018;
const SUITE_AES256: u16 = 0xC019;
/// TLS_EMPTY_RENEGOTIATION_INFO_SCSV：告訴伺服器我們懂安全重新協商（不做重新協商）。
const SCSV_RENEGOTIATION: u16 = 0x00FF;

const EXT_SUPPORTED_GROUPS: u16 = 10;
const EXT_EC_POINT_FORMATS: u16 = 11;
const EXT_SIGNATURE_ALGORITHMS: u16 = 13;
const EXT_EXTENDED_MASTER_SECRET: u16 = 23;
const GROUP_X25519: u16 = 29;

/// 一筆紀錄的明文上限（RFC 5246 §6.2.1）；收的時候多留加密的餘裕。
const MAX_PLAIN: usize = 16384;
const MAX_RECORD: usize = MAX_PLAIN + 2048;
const MAC_LEN: usize = 20;
const BLOCK: usize = 16;
const DUPLEX_BUF: usize = 256 * 1024;

/// 匿名 TLS 握手。成功回傳（加解密好的串流, 選到的加密套件名稱）。
pub async fn connect(mut sock: BoxStream) -> AppResult<(BoxStream, &'static str)> {
    let mut transcript = Vec::new();
    let mut client_random = [0u8; 32];
    fill_random(&mut client_random);

    let ch = handshake_msg(HS_CLIENT_HELLO, &client_hello_body(&client_random));
    transcript.extend_from_slice(&ch);
    write_record(&mut sock, CT_HANDSHAKE, TLS10, &ch).await?;
    sock.flush().await.map_err(io_err)?;

    // 伺服器那一輪：ServerHello → ServerKeyExchange → ServerHelloDone（匿名，沒有 Certificate）。
    let mut hs = HsBuf::default();
    let (ty, raw) = hs.next(&mut sock).await?;
    expect(ty, HS_SERVER_HELLO)?;
    transcript.extend_from_slice(&raw);
    let sh = parse_server_hello(&raw[4..])?;

    let (ty, raw) = hs.next(&mut sock).await?;
    if ty == HS_CERTIFICATE {
        return Err(fail("the server sent a certificate (not anonymous TLS)"));
    }
    expect(ty, HS_SERVER_KEY_EXCHANGE)?;
    transcript.extend_from_slice(&raw);
    let server_pub = parse_server_key_exchange(&raw[4..])?;

    let (ty, raw) = hs.next(&mut sock).await?;
    expect(ty, HS_SERVER_HELLO_DONE)?;
    transcript.extend_from_slice(&raw);
    if !hs.buf.is_empty() {
        return Err(fail("unexpected handshake data after ServerHelloDone"));
    }

    // X25519：私鑰 32 bytes 亂數（mul_*_clamped 會照 RFC 7748 夾好）。全零的共享密鑰 = 對方給了小階點，拒絕。
    let mut sk = [0u8; 32];
    fill_random(&mut sk);
    let client_pub = MontgomeryPoint::mul_base_clamped(sk).to_bytes();
    let shared = MontgomeryPoint(server_pub).mul_clamped(sk).to_bytes();
    if shared == [0u8; 32] {
        return Err(fail("invalid server key share"));
    }

    let mut cke_body = vec![32u8];
    cke_body.extend_from_slice(&client_pub);
    let cke = handshake_msg(HS_CLIENT_KEY_EXCHANGE, &cke_body);
    transcript.extend_from_slice(&cke);

    let master = if sh.ems {
        prf(&shared, b"extended master secret", &Sha256::digest(&transcript), 48)
    } else {
        prf(&shared, b"master secret", &[client_random, sh.random].concat(), 48)
    };
    let key_len = if sh.suite == SUITE_AES128 { 16 } else { 32 };
    // RFC 5246 §6.3：client MAC、server MAC、client key、server key（CBC 的 IV 每筆明送，不從這裡拿）。
    let kb = prf(&master, b"key expansion", &[sh.random, client_random].concat(), 2 * MAC_LEN + 2 * key_len);
    let (c_mac, rest) = kb.split_at(MAC_LEN);
    let (s_mac, rest) = rest.split_at(MAC_LEN);
    let (c_key, s_key) = rest.split_at(key_len);
    let mut wr = Dir::new(c_key, c_mac);
    let mut rd = Dir::new(s_key, s_mac);

    write_record(&mut sock, CT_HANDSHAKE, TLS12, &cke).await?;
    write_record(&mut sock, CT_CCS, TLS12, &[1]).await?;
    let verify = prf(&master, b"client finished", &Sha256::digest(&transcript), 12);
    let fin = handshake_msg(HS_FINISHED, &verify);
    transcript.extend_from_slice(&fin);
    let sealed = wr.seal(CT_HANDSHAKE, &fin);
    write_record(&mut sock, CT_HANDSHAKE, TLS12, &sealed).await?;
    sock.flush().await.map_err(io_err)?;

    // 伺服器的 ChangeCipherSpec + 加密的 Finished。
    let (ty, p) = read_record(&mut sock).await?;
    match ty {
        CT_CCS if p == [1] => {}
        CT_ALERT => return Err(alert_err(&p)),
        _ => return Err(fail("expected ChangeCipherSpec")),
    }
    let (ty, p) = read_record(&mut sock).await?;
    let plain = rd.open(ty, &p)?;
    if ty == CT_ALERT {
        return Err(alert_err(&plain));
    }
    if ty != CT_HANDSHAKE || plain.len() != 16 || plain[0] != HS_FINISHED || plain[1..4] != [0, 0, 12] {
        return Err(fail("expected Finished"));
    }
    let expected = prf(&master, b"server finished", &Sha256::digest(&transcript), 12);
    if !ct_eq(&plain[4..], &expected) {
        return Err(fail("the server's Finished does not match"));
    }

    let name = if sh.suite == SUITE_AES128 {
        "TLS_ECDH_anon_WITH_AES_128_CBC_SHA"
    } else {
        "TLS_ECDH_anon_WITH_AES_256_CBC_SHA"
    };
    Ok((spawn_relay(sock, rd, wr), name))
}

/// 握手後的轉送：一個 task 解伺服器的紀錄交給上層，另一個把上層寫的切成紀錄加密送出。
/// 上層關掉 → 送 close_notify、收掉讀的那個 task；伺服器關掉 / 紀錄驗不過 → 上層讀到 EOF。
fn spawn_relay(sock: BoxStream, mut rd: Dir, mut wr: Dir) -> BoxStream {
    let (app, inner) = tokio::io::duplex(DUPLEX_BUF);
    let (mut sock_r, mut sock_w) = tokio::io::split(sock);
    let (mut in_r, mut in_w) = tokio::io::split(inner);
    let reader = tokio::spawn(async move {
        loop {
            let Ok((ty, p)) = read_record(&mut sock_r).await else { break };
            let Ok(plain) = rd.open(ty, &p) else { break };
            match ty {
                CT_APP => {
                    if in_w.write_all(&plain).await.is_err() {
                        break;
                    }
                }
                CT_ALERT => break,
                // 握手後的 HelloRequest（要求重新協商）之類：不理（我們不做重新協商）。
                _ => {}
            }
        }
        let _ = in_w.shutdown().await;
    });
    tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_PLAIN];
        loop {
            match in_r.read(&mut buf).await {
                Ok(n) if n > 0 => {
                    let rec = wr.seal(CT_APP, &buf[..n]);
                    if write_record(&mut sock_w, CT_APP, TLS12, &rec).await.is_err() {
                        break;
                    }
                }
                _ => {
                    // close_notify（warning, 0）
                    let rec = wr.seal(CT_ALERT, &[1, 0]);
                    let _ = write_record(&mut sock_w, CT_ALERT, TLS12, &rec).await;
                    let _ = sock_w.shutdown().await;
                    break;
                }
            }
        }
        reader.abort();
    });
    Box::new(app)
}

// ---- 握手訊息 ----

fn handshake_msg(ty: u8, body: &[u8]) -> Vec<u8> {
    let n = body.len() as u32;
    let mut m = vec![ty, (n >> 16) as u8, (n >> 8) as u8, n as u8];
    m.extend_from_slice(body);
    m
}

fn client_hello_body(random: &[u8; 32]) -> Vec<u8> {
    let mut b = TLS12.to_vec();
    b.extend_from_slice(random);
    b.push(0); // session id：不續用
    let suites = [SUITE_AES256, SUITE_AES128, SCSV_RENEGOTIATION];
    b.extend_from_slice(&((suites.len() * 2) as u16).to_be_bytes());
    for s in suites {
        b.extend_from_slice(&s.to_be_bytes());
    }
    b.extend_from_slice(&[1, 0]); // 壓縮：只有 null
    let mut ext = Vec::new();
    let mut add = |ty: u16, data: &[u8]| {
        ext.extend_from_slice(&ty.to_be_bytes());
        ext.extend_from_slice(&(data.len() as u16).to_be_bytes());
        ext.extend_from_slice(data);
    };
    add(EXT_SUPPORTED_GROUPS, &[0, 2, (GROUP_X25519 >> 8) as u8, GROUP_X25519 as u8]);
    add(EXT_EC_POINT_FORMATS, &[1, 0]);
    // 匿名用不到簽章，但有些伺服器沒收到這個擴充會拒絕 TLS 1.2 的 ClientHello。
    add(EXT_SIGNATURE_ALGORITHMS, &[0, 6, 4, 1, 4, 3, 8, 4]);
    add(EXT_EXTENDED_MASTER_SECRET, &[]);
    b.extend_from_slice(&(ext.len() as u16).to_be_bytes());
    b.extend_from_slice(&ext);
    b
}

struct ServerHello {
    random: [u8; 32],
    suite: u16,
    ems: bool,
}

fn parse_server_hello(b: &[u8]) -> AppResult<ServerHello> {
    let mut r = Reader(b);
    let ver = r.u16()?;
    if ver != 0x0303 {
        return Err(fail(&format!("the server chose TLS version {ver:#06x} (need TLS 1.2)")));
    }
    let random: [u8; 32] = r.take(32)?.try_into().unwrap();
    let sid = r.u8()? as usize;
    r.take(sid)?;
    let suite = r.u16()?;
    if suite != SUITE_AES128 && suite != SUITE_AES256 {
        return Err(fail(&format!("the server chose cipher suite {suite:#06x}")));
    }
    if r.u8()? != 0 {
        return Err(fail("the server chose compression"));
    }
    let mut ems = false;
    if !r.0.is_empty() {
        let len = r.u16()? as usize;
        let mut e = Reader(r.take(len)?);
        while !e.0.is_empty() {
            let ty = e.u16()?;
            let len = e.u16()? as usize;
            e.take(len)?;
            ems |= ty == EXT_EXTENDED_MASTER_SECRET;
        }
    }
    Ok(ServerHello { random, suite, ems })
}

/// ECDH_anon 的 ServerKeyExchange：named_curve(3) + 曲線 + 公鑰（沒有簽章）。
fn parse_server_key_exchange(b: &[u8]) -> AppResult<[u8; 32]> {
    let mut r = Reader(b);
    if r.u8()? != 3 {
        return Err(fail("unsupported ECDH parameters"));
    }
    let group = r.u16()?;
    if group != GROUP_X25519 {
        return Err(fail(&format!("the server chose curve {group}")));
    }
    if r.u8()? != 32 {
        return Err(fail("bad X25519 key length"));
    }
    Ok(r.take(32)?.try_into().unwrap())
}

struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> AppResult<&'a [u8]> {
        if self.0.len() < n {
            return Err(fail("truncated handshake message"));
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }
    fn u8(&mut self) -> AppResult<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> AppResult<u16> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
}

/// 握手訊息的緩衝：一筆紀錄可能裝好幾則訊息，一則訊息也可能跨紀錄。
#[derive(Default)]
struct HsBuf {
    buf: Vec<u8>,
}

impl HsBuf {
    /// 下一則握手訊息（型別, 含 4 bytes 標頭的原始內容）。HelloRequest 略過（不算進 transcript）。
    async fn next<S: AsyncRead + Unpin>(&mut self, s: &mut S) -> AppResult<(u8, Vec<u8>)> {
        loop {
            if self.buf.len() >= 4 {
                let len = u32::from_be_bytes([0, self.buf[1], self.buf[2], self.buf[3]]) as usize;
                if self.buf.len() >= 4 + len {
                    let raw: Vec<u8> = self.buf.drain(..4 + len).collect();
                    if raw[0] == HS_HELLO_REQUEST {
                        continue;
                    }
                    return Ok((raw[0], raw));
                }
                if len > 64 * 1024 {
                    return Err(fail("handshake message too long"));
                }
            }
            let (ty, p) = read_record(s).await?;
            match ty {
                CT_HANDSHAKE => self.buf.extend_from_slice(&p),
                CT_ALERT => return Err(alert_err(&p)),
                _ => return Err(fail("unexpected record during the handshake")),
            }
        }
    }
}

fn expect(got: u8, want: u8) -> AppResult<()> {
    if got == want {
        Ok(())
    } else {
        Err(fail(&format!("unexpected handshake message {got} (expected {want})")))
    }
}

// ---- 紀錄層 ----

async fn read_record<S: AsyncRead + Unpin>(s: &mut S) -> AppResult<(u8, Vec<u8>)> {
    let mut h = [0u8; 5];
    s.read_exact(&mut h).await.map_err(io_err)?;
    let len = u16::from_be_bytes([h[3], h[4]]) as usize;
    if h[1] != 3 || len > MAX_RECORD {
        return Err(fail("bad TLS record header"));
    }
    let mut p = vec![0u8; len];
    s.read_exact(&mut p).await.map_err(io_err)?;
    Ok((h[0], p))
}

async fn write_record<S: AsyncWrite + Unpin>(s: &mut S, ty: u8, ver: [u8; 2], payload: &[u8]) -> AppResult<()> {
    let mut rec = Vec::with_capacity(5 + payload.len());
    rec.push(ty);
    rec.extend_from_slice(&ver);
    rec.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    rec.extend_from_slice(payload);
    s.write_all(&rec).await.map_err(io_err)
}

enum Aes {
    A128(aes::Aes128),
    A256(aes::Aes256),
}

impl Aes {
    fn encrypt(&self, b: &mut [u8]) {
        let b = GenericArray::from_mut_slice(b);
        match self {
            Aes::A128(c) => c.encrypt_block(b),
            Aes::A256(c) => c.encrypt_block(b),
        }
    }
    fn decrypt(&self, b: &mut [u8]) {
        let b = GenericArray::from_mut_slice(b);
        match self {
            Aes::A128(c) => c.decrypt_block(b),
            Aes::A256(c) => c.decrypt_block(b),
        }
    }
}

/// 一個方向的加密狀態：AES-CBC 金鑰、HMAC-SHA1 金鑰、序號（ChangeCipherSpec 後從 0 開始）。
struct Dir {
    aes: Aes,
    mac_key: Vec<u8>,
    seq: u64,
}

impl Dir {
    fn new(key: &[u8], mac_key: &[u8]) -> Self {
        let aes = if key.len() == 16 {
            Aes::A128(aes::Aes128::new(GenericArray::from_slice(key)))
        } else {
            Aes::A256(aes::Aes256::new(GenericArray::from_slice(key)))
        };
        Self { aes, mac_key: mac_key.to_vec(), seq: 0 }
    }

    /// HMAC-SHA1(seq ‖ type ‖ version ‖ length ‖ 明文)（RFC 5246 §6.2.3.1）。
    fn mac(&self, ty: u8, plain: &[u8]) -> [u8; MAC_LEN] {
        let mut m = <Hmac<sha1::Sha1> as Mac>::new_from_slice(&self.mac_key).expect("HMAC 收任何長度的金鑰");
        m.update(&self.seq.to_be_bytes());
        m.update(&[ty, TLS12[0], TLS12[1]]);
        m.update(&(plain.len() as u16).to_be_bytes());
        m.update(plain);
        m.finalize().into_bytes().into()
    }

    /// 明文 → 紀錄內容：IV ‖ AES-CBC(明文 ‖ MAC ‖ padding)。
    fn seal(&mut self, ty: u8, plain: &[u8]) -> Vec<u8> {
        let mac = self.mac(ty, plain);
        self.seq += 1;
        let mut data = Vec::with_capacity(plain.len() + MAC_LEN + BLOCK);
        data.extend_from_slice(plain);
        data.extend_from_slice(&mac);
        let pad = BLOCK - 1 - data.len() % BLOCK;
        data.resize(data.len() + pad + 1, pad as u8);
        let mut out = vec![0u8; BLOCK];
        fill_random(&mut out);
        let mut prev: [u8; BLOCK] = out[..].try_into().unwrap();
        for chunk in data.chunks_mut(BLOCK) {
            for (b, p) in chunk.iter_mut().zip(prev) {
                *b ^= p;
            }
            self.aes.encrypt(chunk);
            prev.copy_from_slice(chunk);
        }
        out.extend_from_slice(&data);
        out
    }

    /// 紀錄內容 → 明文；padding 或 MAC 不對回錯（之後整條連線就斷了）。
    fn open(&mut self, ty: u8, payload: &[u8]) -> AppResult<Vec<u8>> {
        if payload.len() < 2 * BLOCK || payload.len() % BLOCK != 0 {
            return Err(fail("bad encrypted record length"));
        }
        let (iv, ct) = payload.split_at(BLOCK);
        let mut data = ct.to_vec();
        let mut prev: [u8; BLOCK] = iv.try_into().unwrap();
        for chunk in data.chunks_mut(BLOCK) {
            let this: [u8; BLOCK] = (&*chunk).try_into().unwrap();
            self.aes.decrypt(chunk);
            for (b, p) in chunk.iter_mut().zip(prev) {
                *b ^= p;
            }
            prev = this;
        }
        let pad = *data.last().unwrap() as usize;
        let bad_pad = pad + 1 + MAC_LEN > data.len() || data[data.len() - pad - 1..].iter().any(|&b| b as usize != pad);
        let body_len = if bad_pad { data.len().saturating_sub(MAC_LEN) } else { data.len() - pad - 1 };
        let (plain, mac) = data[..body_len].split_at(body_len.saturating_sub(MAC_LEN));
        let expected = self.mac(ty, plain);
        self.seq += 1;
        if bad_pad || !ct_eq(mac, &expected) {
            return Err(fail("bad record MAC"));
        }
        Ok(plain.to_vec())
    }
}

// ---- PRF 與小工具 ----

/// TLS 1.2 PRF：P_SHA256(secret, label ‖ seed)，取前 `n` bytes（RFC 5246 §5）。
fn prf(secret: &[u8], label: &[u8], seed: &[u8], n: usize) -> Vec<u8> {
    let hmac = |parts: &[&[u8]]| {
        let mut m = <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("HMAC 收任何長度的金鑰");
        for p in parts {
            m.update(p);
        }
        m.finalize().into_bytes()
    };
    let mut out = Vec::with_capacity(n + 32);
    let mut a = hmac(&[label, seed]);
    while out.len() < n {
        out.extend_from_slice(&hmac(&[&a, label, seed]));
        a = hmac(&[&a]);
    }
    out.truncate(n);
    out
}

/// 長度相同才比、逐 byte 累積差異（不在第一個不同處提早結束）。
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn alert_err(p: &[u8]) -> AppError {
    let desc = p.get(1).copied().unwrap_or(0);
    fail(&format!("the server sent TLS alert {desc}"))
}

fn fail(detail: &str) -> AppError {
    AppError::Rd(tf!("TLS 握手失敗：{e}", e = detail))
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Rd(tf!("VNC 連線 I/O 錯誤：{detail}", detail = e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// TLS 1.2 PRF（P_SHA256）的公開測試向量（IETF TLS WG 流傳的那組；另用 Node 的 HMAC 獨立算過一次）。
    #[test]
    fn prf_sha256_test_vector() {
        let out = prf(
            &hex("9bbe436ba940f017b17652849a71db35"),
            b"test label",
            &hex("a0ba9f936cda311827a6f796ffd5198c"),
            100,
        );
        assert_eq!(
            out,
            hex("e3f229ba727be17b8d122620557cd453c2aab21d07c3d495329b52d4e61edb5a6b301791e90d35c9c9a46b4e14baf9af0fa022f7077def17abfd3797c0564bab4fbc91666e9def9b97fce34f796789baa48082d122ee42c5a72e5a5110fff70187347b66")
        );
    }

    fn pair(key_len: usize) -> (Dir, Dir) {
        let key = vec![7u8; key_len];
        let mac = vec![9u8; MAC_LEN];
        (Dir::new(&key, &mac), Dir::new(&key, &mac))
    }

    #[test]
    fn record_roundtrip_both_key_sizes_and_lengths() {
        for key_len in [16, 32] {
            let (mut tx, mut rx) = pair(key_len);
            for len in [0usize, 1, 11, 12, 15, 16, 17, 300, MAX_PLAIN] {
                let plain: Vec<u8> = (0..len).map(|i| i as u8).collect();
                let rec = tx.seal(CT_APP, &plain);
                assert_eq!(rec.len() % BLOCK, 0);
                assert_eq!(rx.open(CT_APP, &rec).unwrap(), plain, "key {key_len} len {len}");
            }
        }
    }

    #[test]
    fn tampered_or_replayed_records_are_rejected() {
        let (mut tx, mut rx) = pair(16);
        let rec = tx.seal(CT_APP, b"hello");
        let mut bad = rec.clone();
        bad[20] ^= 1;
        assert!(rx.clone_state().open(CT_APP, &bad).is_err(), "改一個 bit");
        assert!(rx.clone_state().open(CT_HANDSHAKE, &rec).is_err(), "型別不同 MAC 就不同");
        assert_eq!(rx.open(CT_APP, &rec).unwrap(), b"hello");
        assert!(rx.open(CT_APP, &rec).is_err(), "同一筆再送一次（序號已經往前）");
        assert!(rx.open(CT_APP, &rec[..BLOCK]).is_err(), "太短");
    }

    impl Dir {
        fn clone_state(&self) -> Dir {
            let key: Vec<u8> = match &self.aes {
                Aes::A128(_) => vec![7u8; 16],
                Aes::A256(_) => vec![7u8; 32],
            };
            Dir { seq: self.seq, ..Dir::new(&key, &self.mac_key) }
        }
    }

    #[test]
    fn client_hello_offers_only_what_we_implement() {
        let body = client_hello_body(&[0u8; 32]);
        assert_eq!(&body[..2], &TLS12);
        // 版本 2 + random 32 + session id 1 → 加密套件清單
        let suites = &body[35..35 + 2 + 6];
        assert_eq!(suites, &[0, 6, 0xC0, 0x19, 0xC0, 0x18, 0x00, 0xFF]);
        let sh = {
            let mut b = TLS12.to_vec();
            b.extend_from_slice(&[5u8; 32]);
            b.push(0);
            b.extend_from_slice(&SUITE_AES128.to_be_bytes());
            b.push(0);
            b.extend_from_slice(&[0, 4, 0, 23, 0, 0]); // extended_master_secret
            b
        };
        let p = parse_server_hello(&sh).unwrap();
        assert!(p.ems && p.suite == SUITE_AES128 && p.random == [5u8; 32]);
        let mut wrong = sh.clone();
        wrong[35] = 0x00;
        wrong[36] = 0x2f; // 沒提供的套件
        assert!(parse_server_hello(&wrong).is_err());
    }

    #[test]
    fn server_key_exchange_must_be_x25519() {
        let mut ske = vec![3, 0, 29, 32];
        ske.extend_from_slice(&[1u8; 32]);
        assert_eq!(parse_server_key_exchange(&ske).unwrap(), [1u8; 32]);
        let mut p256 = ske.clone();
        p256[2] = 23;
        assert!(parse_server_key_exchange(&p256).is_err());
    }
}
