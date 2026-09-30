//! 對真正 VNC（RFB）伺服器的 client 側握手 + 認證。
//!
//! 支援四種認證：
//! - **None**（RFB security type 1）：不需要憑證。
//! - **VNC Authentication**（type 2）：DES challenge-response。密碼截 / 補到 8 bytes、
//!   每個 byte 位元反轉後當 DES 金鑰，加密 16 bytes 挑戰後送回。
//! - **Apple Remote Desktop**（type 30）：Diffie-Hellman 交換出共享密鑰，取其 MD5 當
//!   AES-128 金鑰，把「帳號 + 密碼」各 64 bytes 的 128-byte 區塊以 AES-128-ECB 加密後，
//!   連同 client 公鑰一起送出。
//! - **VeNCrypt-Plain**（type 19 + subtype 256）：明文帳密（外層應套 TLS，但本模組只做
//!   Plain 子型別，`encrypted` 一律回 `false`，是否加密由上層傳輸決定）。
//!
//! 版本協商：讀伺服器 `RFB xxx.yyy\n` 後取 `min(server, 3.8)`；Apple 的 `3.889` 視為 `3.8`。
//! - `3.3`：伺服器直接以 u32 指定唯一 security type（無清單）。
//! - `3.7`：伺服器給清單，client 選一個；None 之後**不**回 SecurityResult。
//! - `3.8`：伺服器給清單；SecurityResult 恆送出、失敗時附帶原因字串。
//!
//! 重試策略：VNC / ARD 認證失敗時 RFB 伺服器會直接關閉連線，故本模組**不**在內部重試，
//! 一律回 [`AppError::RdAuth`]；由呼叫端重連並用 [`VncCredSource`] 的 `error` 參數重新詢問。
//!
//! 本模組不含逾時（呼叫端以 `tokio::time::timeout` 包起來），且成功後**不**送 ClientInit
//! （交由上層的 pump 從 noVNC 轉送）。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{AppError, AppResult};

// ---- 對外型別 ----

/// 使用者 / 連線設定指定的偏好認證方式。序列化為 snake_case 字串。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VncSecurityPref {
    /// 自動：依是否有帳號決定優先序（見 [`client_handshake`]）。
    Auto,
    /// 強制 None（type 1）。
    None,
    /// 強制 VNC Authentication（type 2）。
    Vnc,
    /// 強制 Apple Remote Desktop（type 30）。
    Ard,
    /// 強制 VeNCrypt-Plain（type 19 / subtype 256）。
    Plain,
}

/// 一組帳密。密碼只活在記憶體。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VncCreds {
    pub username: String,
    pub password: String,
}

/// 當選定的 security type 需要「上層未預先提供」的憑證時，向使用者詢問。
///
/// 回傳 `None` 代表使用者取消 → 呼叫端會收到 [`AppError::RdCancelled`]。
#[async_trait]
pub trait VncCredSource: Send + Sync {
    /// `need_username`：此認證方式是否需要帳號（ARD / Plain 需要；VNC Auth 只要密碼）。
    /// `error`：上一輪失敗原因（供重連後重問時顯示）；本模組內部不重試，故此處恆傳 `None`。
    async fn creds(&self, need_username: bool, error: Option<String>) -> Option<VncCreds>;
}

/// 握手 + 認證成功後的結果摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VncAuthOutcome {
    /// 實際成功的認證方式：`"vnc-none"` / `"vnc-auth"` / `"ard"` / `"vencrypt-plain"`。
    pub security: &'static str,
    /// 這條連線本身是否加密。以上四種在本模組層級皆為 `false`。
    pub encrypted: bool,
    /// 伺服器回報的 RFB 版本（未經 clamp 的原始值，例如 Apple 為 `(3, 889)`）。
    pub server_version: (u32, u32),
}

// ---- 內部：security type ----

const SEC_NONE: u8 = 1;
const SEC_VNC: u8 = 2;
const SEC_VENCRYPT: u8 = 19;
const SEC_ARD: u8 = 30;

/// VeNCrypt 的 Plain 子型別。
const VENCRYPT_PLAIN: u32 = 256;

// ---- 對外主流程 ----

/// 對真正的 RFB 伺服器完成 client 側握手 + 認證。
///
/// `initial` 為上層預先提供的帳密（可能只有密碼、或都沒有）；缺少必要憑證時才會呼叫 `ask`。
pub async fn client_handshake<S: AsyncRead + AsyncWrite + Unpin + Send>(
    s: &mut S,
    pref: VncSecurityPref,
    initial: Option<VncCreds>,
    ask: &dyn VncCredSource,
) -> AppResult<VncAuthOutcome> {
    // 1) 版本協商。
    let server_version = read_server_version(s).await?;
    let minor = negotiated_minor(server_version);
    write_all(s, format!("RFB 003.{minor:03}\n").as_bytes()).await?;

    // 2) 取得伺服器提供的 security types。
    let offered = read_security_types(s, minor).await?;

    // 3) 選定要用哪一種。
    let chosen = choose_security(pref, &offered, initial.as_ref())?;

    // 4) 3.7 / 3.8 需回覆選擇；3.3 由伺服器決定、client 不回。
    if minor >= 7 {
        write_all(s, &[chosen]).await?;
    }

    // 5) 依選定型別執行認證，並在需要時讀 SecurityResult。
    match chosen {
        SEC_NONE => {
            // None：3.8 仍會送 SecurityResult；3.3 / 3.7 不送。
            if minor >= 8 {
                read_security_result(s, minor).await?;
            }
            Ok(outcome("vnc-none", server_version))
        }
        SEC_VNC => {
            let creds = ensure_creds(&initial, ask, false).await?;
            do_vnc_auth(s, &creds.password).await?;
            // VNC Auth 在 3.3 / 3.7 / 3.8 皆送 SecurityResult。
            read_security_result(s, minor).await?;
            Ok(outcome("vnc-auth", server_version))
        }
        SEC_ARD => {
            let creds = ensure_creds(&initial, ask, true).await?;
            do_ard_auth(s, &creds).await?;
            read_security_result(s, minor).await?;
            Ok(outcome("ard", server_version))
        }
        SEC_VENCRYPT => {
            let creds = ensure_creds(&initial, ask, true).await?;
            do_vencrypt_plain(s, &creds, minor).await?;
            Ok(outcome("vencrypt-plain", server_version))
        }
        // choose_security 只會回上述四種。
        other => Err(AppError::Rd(tf!(
            "不支援的 VNC 認證型別：{n}",
            n = other
        ))),
    }
}

fn outcome(security: &'static str, server_version: (u32, u32)) -> VncAuthOutcome {
    VncAuthOutcome {
        security,
        encrypted: false,
        server_version,
    }
}

// ---- 版本協商 ----

/// 讀 `RFB xxx.yyy\n`（12 bytes）並解析成 `(major, minor)`。
async fn read_server_version<S: AsyncRead + Unpin>(s: &mut S) -> AppResult<(u32, u32)> {
    let mut buf = [0u8; 12];
    read_exact(s, &mut buf).await?;
    if &buf[0..4] != b"RFB " || buf[7] != b'.' || buf[11] != b'\n' {
        return Err(AppError::Rd(t!("VNC 伺服器回應的版本字串格式不正確").to_string()));
    }
    let major = parse_ver(&buf[4..7])?;
    let minor = parse_ver(&buf[8..11])?;
    Ok((major, minor))
}

fn parse_ver(b: &[u8]) -> AppResult<u32> {
    std::str::from_utf8(b)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .ok_or_else(|| AppError::Rd(t!("VNC 伺服器回應的版本字串格式不正確").to_string()))
}

/// 取 `min(server, 3.8)` 的 minor：`>=3.8`（含 Apple 3.889）→ 8；`3.7` → 7；其餘 → 3。
fn negotiated_minor(server: (u32, u32)) -> u32 {
    let (major, minor) = server;
    if major > 3 || (major == 3 && minor >= 8) {
        8
    } else if major == 3 && minor == 7 {
        7
    } else {
        3
    }
}

// ---- security type 清單 ----

/// 依協商版本讀伺服器提供的 security types。
/// - 3.3：單一 u32（0 代表失敗、附原因）。
/// - 3.7 / 3.8：u8 數量 + N × u8（數量 0 代表失敗、附原因）。
async fn read_security_types<S: AsyncRead + Unpin>(
    s: &mut S,
    minor: u32,
) -> AppResult<Vec<u8>> {
    if minor <= 3 {
        let t = read_u32(s).await?;
        if t == 0 {
            let reason = read_reason(s).await.unwrap_or_default();
            return Err(rd_or_default(reason, "VNC 伺服器拒絕連線"));
        }
        // 3.3 只可能是 1（None）或 2（VNC Auth）；其餘視為 u8。
        Ok(vec![t as u8])
    } else {
        let count = read_u8(s).await?;
        if count == 0 {
            let reason = read_reason(s).await.unwrap_or_default();
            return Err(rd_or_default(reason, "VNC 伺服器拒絕連線"));
        }
        let mut types = vec![0u8; count as usize];
        read_exact(s, &mut types).await?;
        Ok(types)
    }
}

// ---- 選型 ----

/// 依偏好與帳號有無，從伺服器提供的清單中選一種。
fn choose_security(
    pref: VncSecurityPref,
    offered: &[u8],
    initial: Option<&VncCreds>,
) -> AppResult<u8> {
    let has = |t: u8| offered.contains(&t);
    let require = |t: u8, name: &str| -> AppResult<u8> {
        if has(t) {
            Ok(t)
        } else {
            Err(AppError::Rd(tf!(
                "伺服器未提供指定的 VNC 認證方式（{name}）；實際提供：{list}",
                name = name,
                list = fmt_types(offered)
            )))
        }
    };

    match pref {
        VncSecurityPref::None => require(SEC_NONE, "None"),
        VncSecurityPref::Vnc => require(SEC_VNC, "VNC Authentication"),
        VncSecurityPref::Ard => require(SEC_ARD, "Apple Remote Desktop"),
        VncSecurityPref::Plain => require(SEC_VENCRYPT, "VeNCrypt-Plain"),
        VncSecurityPref::Auto => {
            let has_username = initial.map_or(false, |c| !c.username.is_empty());
            // 有帳號：ARD → VeNCrypt-Plain → VNC → None。
            // 無帳號：VNC → None → ARD（ARD 之後再向使用者要帳號）。
            let order: &[u8] = if has_username {
                &[SEC_ARD, SEC_VENCRYPT, SEC_VNC, SEC_NONE]
            } else {
                &[SEC_VNC, SEC_NONE, SEC_ARD]
            };
            order
                .iter()
                .copied()
                .find(|t| has(*t))
                .ok_or_else(|| {
                    AppError::Rd(tf!(
                        "伺服器未提供任何支援的 VNC 認證方式；實際提供：{list}",
                        list = fmt_types(offered)
                    ))
                })
        }
    }
}

fn fmt_types(offered: &[u8]) -> String {
    offered
        .iter()
        .map(|t| t.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

// ---- 憑證取得 ----

/// 取得所需憑證：優先用 `initial`，不足才問 `ask`。取消 → [`AppError::RdCancelled`]。
async fn ensure_creds(
    initial: &Option<VncCreds>,
    ask: &dyn VncCredSource,
    need_username: bool,
) -> AppResult<VncCreds> {
    if let Some(c) = initial {
        let ok = !c.password.is_empty() && (!need_username || !c.username.is_empty());
        if ok {
            return Ok(c.clone());
        }
    }
    match ask.creds(need_username, None).await {
        Some(c) => Ok(c),
        None => Err(AppError::RdCancelled),
    }
}

// ---- VNC Authentication（DES challenge-response）----

async fn do_vnc_auth<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    password: &str,
) -> AppResult<()> {
    let mut challenge = [0u8; 16];
    read_exact(s, &mut challenge).await?;
    let response = vnc_des_response(password.as_bytes(), &challenge);
    write_all(s, &response).await?;
    Ok(())
}

/// VNC Auth 的 DES 回應：密碼截 / 補零到 8 bytes、每 byte 位元反轉後當金鑰，
/// 以 DES-ECB 分兩塊加密 16-byte 挑戰。
pub fn vnc_des_response(password: &[u8], challenge: &[u8; 16]) -> [u8; 16] {
    use des::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
    use des::Des;

    let mut key = [0u8; 8];
    for i in 0..8 {
        let b = password.get(i).copied().unwrap_or(0);
        key[i] = reverse_bits(b);
    }
    let cipher = Des::new(GenericArray::from_slice(&key));

    let mut out = [0u8; 16];
    for blk in 0..2 {
        let mut block = GenericArray::clone_from_slice(&challenge[blk * 8..blk * 8 + 8]);
        cipher.encrypt_block(&mut block);
        out[blk * 8..blk * 8 + 8].copy_from_slice(&block);
    }
    out
}

/// 反轉單一 byte 的位元順序（VNC Auth 金鑰的老規矩，RFB 規格未明載）。
fn reverse_bits(mut b: u8) -> u8 {
    let mut r = 0u8;
    for _ in 0..8 {
        r = (r << 1) | (b & 1);
        b >>= 1;
    }
    r
}

// ---- Apple Remote Desktop（DH + AES-128-ECB）----

async fn do_ard_auth<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    creds: &VncCreds,
) -> AppResult<()> {
    use num_bigint::BigUint;

    // 讀 generator(u16)、key length(u16)、prime[len]、server 公鑰[len]。
    let generator = read_u16(s).await?;
    let key_len = read_u16(s).await? as usize;
    if key_len == 0 || key_len > 8192 {
        return Err(AppError::Rd(t!("ARD 金鑰長度不合理").to_string()));
    }
    let mut prime = vec![0u8; key_len];
    read_exact(s, &mut prime).await?;
    let mut server_pub = vec![0u8; key_len];
    read_exact(s, &mut server_pub).await?;

    let p = BigUint::from_bytes_be(&prime);
    let g = BigUint::from(generator);
    let server_pub_n = BigUint::from_bytes_be(&server_pub);

    // 產生亂數私鑰（key_len bytes），算 client 公鑰與共享密鑰。
    let mut priv_bytes = vec![0u8; key_len];
    fill_random(&mut priv_bytes);
    let priv_n = BigUint::from_bytes_be(&priv_bytes);

    let client_pub = g.modpow(&priv_n, &p);
    let shared = server_pub_n.modpow(&priv_n, &p);

    let client_pub_bytes = left_pad_be(&client_pub.to_bytes_be(), key_len);
    let shared_bytes = left_pad_be(&shared.to_bytes_be(), key_len);

    // AES-128 金鑰 = MD5(共享密鑰)。
    let aes_key = md5_16(&shared_bytes);

    // 憑證區塊：128 bytes；帳號放前 64、密碼放後 64，各為 UTF-8 + NUL 終止、其餘填亂數。
    let mut cred = [0u8; 128];
    fill_random(&mut cred);
    write_field(&mut cred[0..64], creds.username.as_bytes());
    write_field(&mut cred[64..128], creds.password.as_bytes());

    // AES-128-ECB 加密整個 128-byte 區塊（8 塊，各塊獨立）。
    let ciphertext = aes128_ecb_encrypt(&aes_key, &cred);

    // 送出 ciphertext(128) 再送 client 公鑰(key_len)。
    write_all(s, &ciphertext).await?;
    write_all(s, &client_pub_bytes).await?;
    Ok(())
}

/// 把資料寫進固定寬度欄位並補 NUL；過長則截斷並保留最後一個 NUL 終止。
fn write_field(field: &mut [u8], data: &[u8]) {
    let n = data.len().min(field.len().saturating_sub(1));
    field[..n].copy_from_slice(&data[..n]);
    field[n] = 0;
    // n+1..end 維持先前填入的亂數。
}

/// AES-128-ECB 加密（塊長須為 16 的倍數）。
fn aes128_ecb_encrypt(key: &[u8; 16], data: &[u8]) -> Vec<u8> {
    use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
    use aes::Aes128;

    let cipher = Aes128::new(GenericArray::from_slice(key));
    let mut out = data.to_vec();
    for chunk in out.chunks_exact_mut(16) {
        let mut block = GenericArray::clone_from_slice(chunk);
        cipher.encrypt_block(&mut block);
        chunk.copy_from_slice(&block);
    }
    out
}

fn md5_16(data: &[u8]) -> [u8; 16] {
    use md5::{Digest, Md5};
    let mut h = Md5::new();
    h.update(data);
    let d = h.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&d);
    out
}

/// 以大端序左補零到指定長度（modpow 結果可能少於 key_len bytes）。
fn left_pad_be(bytes: &[u8], len: usize) -> Vec<u8> {
    if bytes.len() >= len {
        bytes[bytes.len() - len..].to_vec()
    } else {
        let mut out = vec![0u8; len];
        out[len - bytes.len()..].copy_from_slice(bytes);
        out
    }
}

/// 以 rand（Cargo.toml 內以 `rand010` 引入的 rand 0.10）填入亂數。
fn fill_random(buf: &mut [u8]) {
    use rand010::Rng;
    let mut rng = rand010::rng();
    rng.fill_bytes(buf);
}

// ---- VeNCrypt-Plain ----

async fn do_vencrypt_plain<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    creds: &VncCreds,
    minor: u32,
) -> AppResult<()> {
    // 伺服器送 VeNCrypt 版本 [major, minor]；我們回應要用的版本 0.2。
    let mut ver = [0u8; 2];
    read_exact(s, &mut ver).await?;
    write_all(s, &[0, 2]).await?;

    // 版本 ack：0 = OK。
    let ack = read_u8(s).await?;
    if ack != 0 {
        return Err(AppError::Rd(t!("伺服器不接受 VeNCrypt 0.2").to_string()));
    }

    // 子型別清單：u8 數量 + N × u32。
    let count = read_u8(s).await?;
    let mut subtypes = Vec::with_capacity(count as usize);
    for _ in 0..count {
        subtypes.push(read_u32(s).await?);
    }
    if !subtypes.contains(&VENCRYPT_PLAIN) {
        return Err(AppError::Rd(t!("伺服器未提供 VeNCrypt-Plain 子型別").to_string()));
    }

    // 選 Plain。
    write_all(s, &VENCRYPT_PLAIN.to_be_bytes()).await?;

    // 送帳密：u32 帳號長度、u32 密碼長度、帳號、密碼。
    let u = creds.username.as_bytes();
    let p = creds.password.as_bytes();
    write_all(s, &(u.len() as u32).to_be_bytes()).await?;
    write_all(s, &(p.len() as u32).to_be_bytes()).await?;
    write_all(s, u).await?;
    write_all(s, p).await?;

    // SecurityResult（VeNCrypt 一律回報；原因字串只有 3.8 有）。
    read_security_result(s, minor).await?;
    Ok(())
}

// ---- SecurityResult / 原因字串 ----

/// 讀 SecurityResult（u32）；非 0 為失敗，3.8 時再讀原因字串。
async fn read_security_result<S: AsyncRead + Unpin>(s: &mut S, minor: u32) -> AppResult<()> {
    let r = read_u32(s).await?;
    if r == 0 {
        return Ok(());
    }
    let reason = if minor >= 8 {
        read_reason(s).await.unwrap_or_default()
    } else {
        String::new()
    };
    Err(if reason.is_empty() {
        AppError::RdAuth(t!("VNC 認證被伺服器拒絕").to_string())
    } else {
        AppError::RdAuth(reason)
    })
}

/// 讀 `u32 長度 + UTF-8 字串`（失敗回應原因）。
async fn read_reason<S: AsyncRead + Unpin>(s: &mut S) -> AppResult<String> {
    let len = read_u32(s).await? as usize;
    if len > 64 * 1024 {
        return Err(AppError::Rd(t!("VNC 伺服器回應的原因字串過長").to_string()));
    }
    let mut buf = vec![0u8; len];
    read_exact(s, &mut buf).await?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn rd_or_default(reason: String, default_key: &'static str) -> AppError {
    if reason.is_empty() {
        AppError::Rd(crate::i18n::lookup(default_key).to_string())
    } else {
        AppError::Rd(reason)
    }
}

// ---- 低階 I/O 小工具（統一把 io::Error 轉成 AppError::Rd）----

async fn read_exact<S: AsyncRead + Unpin>(s: &mut S, buf: &mut [u8]) -> AppResult<()> {
    s.read_exact(buf).await.map_err(io_err)?;
    Ok(())
}

async fn write_all<S: AsyncWrite + Unpin>(s: &mut S, buf: &[u8]) -> AppResult<()> {
    s.write_all(buf).await.map_err(io_err)?;
    s.flush().await.map_err(io_err)?;
    Ok(())
}

async fn read_u8<S: AsyncRead + Unpin>(s: &mut S) -> AppResult<u8> {
    let mut b = [0u8; 1];
    read_exact(s, &mut b).await?;
    Ok(b[0])
}

async fn read_u16<S: AsyncRead + Unpin>(s: &mut S) -> AppResult<u16> {
    let mut b = [0u8; 2];
    read_exact(s, &mut b).await?;
    Ok(u16::from_be_bytes(b))
}

async fn read_u32<S: AsyncRead + Unpin>(s: &mut S) -> AppResult<u32> {
    let mut b = [0u8; 4];
    read_exact(s, &mut b).await?;
    Ok(u32::from_be_bytes(b))
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Rd(tf!("VNC 連線 I/O 錯誤：{detail}", detail = e))
}

// ============================ 測試 ============================
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    // ---- 測試用憑證來源 ----

    struct FixedCreds(Option<VncCreds>);
    #[async_trait]
    impl VncCredSource for FixedCreds {
        async fn creds(&self, _need_username: bool, _error: Option<String>) -> Option<VncCreds> {
            self.0.clone()
        }
    }

    fn creds(u: &str, p: &str) -> VncCreds {
        VncCreds {
            username: u.into(),
            password: p.into(),
        }
    }

    // ---- 測試用 fake RFB 伺服器小工具（server 這側） ----

    async fn srv_write_version(s: &mut DuplexStream, v: &str) {
        s.write_all(v.as_bytes()).await.unwrap();
    }
    async fn srv_read_client_version(s: &mut DuplexStream) -> [u8; 12] {
        let mut b = [0u8; 12];
        s.read_exact(&mut b).await.unwrap();
        b
    }
    async fn srv_read_u8(s: &mut DuplexStream) -> u8 {
        let mut b = [0u8; 1];
        s.read_exact(&mut b).await.unwrap();
        b[0]
    }
    async fn srv_read_u32(s: &mut DuplexStream) -> u32 {
        let mut b = [0u8; 4];
        s.read_exact(&mut b).await.unwrap();
        u32::from_be_bytes(b)
    }
    async fn srv_write_u32(s: &mut DuplexStream, v: u32) {
        s.write_all(&v.to_be_bytes()).await.unwrap();
    }

    // ---- 3.8 None ----
    #[tokio::test]
    async fn handshake_38_none() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let srv = tokio::spawn(async move {
            srv_write_version(&mut server, "RFB 003.008\n").await;
            let cv = srv_read_client_version(&mut server).await;
            assert_eq!(&cv, b"RFB 003.008\n");
            // 提供 [None]
            server.write_all(&[1u8, SEC_NONE]).await.unwrap();
            let chosen = srv_read_u8(&mut server).await;
            assert_eq!(chosen, SEC_NONE);
            // 3.8：None 也送 SecurityResult OK。
            srv_write_u32(&mut server, 0).await;
        });
        let out = client_handshake(
            &mut client,
            VncSecurityPref::Auto,
            None,
            &FixedCreds(None),
        )
        .await
        .unwrap();
        srv.await.unwrap();
        assert_eq!(out.security, "vnc-none");
        assert!(!out.encrypted);
        assert_eq!(out.server_version, (3, 8));
    }

    // ---- 3.3 伺服器指定 VNC Auth ----
    #[tokio::test]
    async fn handshake_33_server_chosen_vnc() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let challenge = [7u8; 16];
        let expected = vnc_des_response(b"secret", &challenge);
        let srv = tokio::spawn(async move {
            srv_write_version(&mut server, "RFB 003.003\n").await;
            let cv = srv_read_client_version(&mut server).await;
            assert_eq!(&cv, b"RFB 003.003\n");
            // 3.3：伺服器以 u32 指定唯一型別（VNC Auth）。
            srv_write_u32(&mut server, SEC_VNC as u32).await;
            // 3.3 不讀 client 的選擇；直接送挑戰。
            server.write_all(&challenge).await.unwrap();
            let mut resp = [0u8; 16];
            server.read_exact(&mut resp).await.unwrap();
            assert_eq!(resp, expected);
            srv_write_u32(&mut server, 0).await; // OK
        });
        let out = client_handshake(
            &mut client,
            VncSecurityPref::Auto,
            Some(creds("", "secret")),
            &FixedCreds(None),
        )
        .await
        .unwrap();
        srv.await.unwrap();
        assert_eq!(out.security, "vnc-auth");
        assert_eq!(out.server_version, (3, 3));
    }

    // ---- 3.8 VNC Auth 成功 ----
    #[tokio::test]
    async fn handshake_38_vnc_success() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let challenge = [0u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        let expected = vnc_des_response(b"password", &challenge);
        let srv = tokio::spawn(async move {
            srv_write_version(&mut server, "RFB 003.008\n").await;
            srv_read_client_version(&mut server).await;
            server.write_all(&[2u8, SEC_NONE, SEC_VNC]).await.unwrap();
            let chosen = srv_read_u8(&mut server).await;
            assert_eq!(chosen, SEC_VNC);
            server.write_all(&challenge).await.unwrap();
            let mut resp = [0u8; 16];
            server.read_exact(&mut resp).await.unwrap();
            assert_eq!(resp, expected);
            srv_write_u32(&mut server, 0).await;
        });
        let out = client_handshake(
            &mut client,
            VncSecurityPref::Vnc,
            Some(creds("", "password")),
            &FixedCreds(None),
        )
        .await
        .unwrap();
        srv.await.unwrap();
        assert_eq!(out.security, "vnc-auth");
    }

    // ---- 3.8 VNC Auth 失敗（含原因字串）----
    #[tokio::test]
    async fn handshake_38_vnc_failure_with_reason() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let srv = tokio::spawn(async move {
            srv_write_version(&mut server, "RFB 003.008\n").await;
            srv_read_client_version(&mut server).await;
            server.write_all(&[1u8, SEC_VNC]).await.unwrap();
            let _ = srv_read_u8(&mut server).await;
            server.write_all(&[0u8; 16]).await.unwrap();
            let mut resp = [0u8; 16];
            server.read_exact(&mut resp).await.unwrap();
            // SecurityResult = 1（失敗）+ 原因字串。
            srv_write_u32(&mut server, 1).await;
            let reason = "Authentication failed";
            srv_write_u32(&mut server, reason.len() as u32).await;
            server.write_all(reason.as_bytes()).await.unwrap();
        });
        let err = client_handshake(
            &mut client,
            VncSecurityPref::Vnc,
            Some(creds("", "wrong")),
            &FixedCreds(None),
        )
        .await
        .unwrap_err();
        srv.await.unwrap();
        match err {
            AppError::RdAuth(m) => assert_eq!(m, "Authentication failed"),
            other => panic!("expected RdAuth, got {other:?}"),
        }
    }

    // ---- VeNCrypt-Plain ----
    #[tokio::test]
    async fn handshake_vencrypt_plain() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let srv = tokio::spawn(async move {
            srv_write_version(&mut server, "RFB 003.008\n").await;
            srv_read_client_version(&mut server).await;
            server.write_all(&[1u8, SEC_VENCRYPT]).await.unwrap();
            let chosen = srv_read_u8(&mut server).await;
            assert_eq!(chosen, SEC_VENCRYPT);
            // VeNCrypt 版本 0.2。
            server.write_all(&[0, 2]).await.unwrap();
            let mut cv = [0u8; 2];
            server.read_exact(&mut cv).await.unwrap();
            assert_eq!(cv, [0, 2]);
            server.write_all(&[0u8]).await.unwrap(); // 版本 ack OK
            // 子型別清單：[256]
            server.write_all(&[1u8]).await.unwrap();
            srv_write_u32(&mut server, VENCRYPT_PLAIN).await;
            let sub = srv_read_u32(&mut server).await;
            assert_eq!(sub, VENCRYPT_PLAIN);
            let ulen = srv_read_u32(&mut server).await as usize;
            let plen = srv_read_u32(&mut server).await as usize;
            let mut u = vec![0u8; ulen];
            let mut p = vec![0u8; plen];
            server.read_exact(&mut u).await.unwrap();
            server.read_exact(&mut p).await.unwrap();
            assert_eq!(&u, b"alice");
            assert_eq!(&p, b"s3cr3t");
            srv_write_u32(&mut server, 0).await; // OK
        });
        let out = client_handshake(
            &mut client,
            VncSecurityPref::Plain,
            Some(creds("alice", "s3cr3t")),
            &FixedCreds(None),
        )
        .await
        .unwrap();
        srv.await.unwrap();
        assert_eq!(out.security, "vencrypt-plain");
    }

    // ---- ARD：測試伺服器實作 server 側 DH + AES 解密，驗證帳密 ----
    #[tokio::test]
    async fn handshake_ard_roundtrip() {
        use num_bigint::BigUint;

        // RFC 2409 第二 Oakley group（1024-bit）質數，generator = 2。keylen = 128。
        let prime_hex = "\
FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1\
29024E088A67CC74020BBEA63B139B22514A08798E3404DD\
EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245\
E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED\
EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381\
FFFFFFFFFFFFFFFF";
        let prime = hex_decode(prime_hex);
        assert_eq!(prime.len(), 128);
        let generator: u16 = 2;

        let (mut client, mut server) = tokio::io::duplex(4096);
        let prime_srv = prime.clone();
        let srv = tokio::spawn(async move {
            srv_write_version(&mut server, "RFB 003.008\n").await;
            srv_read_client_version(&mut server).await;
            server.write_all(&[1u8, SEC_ARD]).await.unwrap();
            let chosen = srv_read_u8(&mut server).await;
            assert_eq!(chosen, SEC_ARD);

            let p = BigUint::from_bytes_be(&prime_srv);
            let g = BigUint::from(generator);
            let key_len = prime_srv.len();

            // 伺服器私鑰（固定值即可，測試用）。
            let srv_priv = BigUint::from_bytes_be(&[9u8; 32]);
            let srv_pub = g.modpow(&srv_priv, &p);
            let srv_pub_bytes = super::left_pad_be(&srv_pub.to_bytes_be(), key_len);

            // 送 generator(u16), keylen(u16), prime, server pub。
            server.write_all(&generator.to_be_bytes()).await.unwrap();
            server
                .write_all(&(key_len as u16).to_be_bytes())
                .await
                .unwrap();
            server.write_all(&prime_srv).await.unwrap();
            server.write_all(&srv_pub_bytes).await.unwrap();

            // 讀 ciphertext(128) + client pub(key_len)。
            let mut ct = [0u8; 128];
            server.read_exact(&mut ct).await.unwrap();
            let mut client_pub = vec![0u8; key_len];
            server.read_exact(&mut client_pub).await.unwrap();

            // 共享密鑰 = clientPub^srvPriv mod p。
            let client_pub_n = BigUint::from_bytes_be(&client_pub);
            let shared = client_pub_n.modpow(&srv_priv, &p);
            let shared_bytes = super::left_pad_be(&shared.to_bytes_be(), key_len);
            let aes_key = super::md5_16(&shared_bytes);

            // AES-128-ECB 解密。
            let plain = aes128_ecb_decrypt(&aes_key, &ct);
            let user = read_cstr(&plain[0..64]);
            let pass = read_cstr(&plain[64..128]);
            assert_eq!(user, "admin");
            assert_eq!(pass, "hunter2");

            srv_write_u32(&mut server, 0).await; // OK
        });

        let out = client_handshake(
            &mut client,
            VncSecurityPref::Ard,
            Some(creds("admin", "hunter2")),
            &FixedCreds(None),
        )
        .await
        .unwrap();
        srv.await.unwrap();
        assert_eq!(out.security, "ard");
    }

    fn aes128_ecb_decrypt(key: &[u8; 16], data: &[u8]) -> Vec<u8> {
        use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
        use aes::Aes128;
        let cipher = Aes128::new(GenericArray::from_slice(key));
        let mut out = data.to_vec();
        for chunk in out.chunks_exact_mut(16) {
            let mut block = GenericArray::clone_from_slice(chunk);
            cipher.decrypt_block(&mut block);
            chunk.copy_from_slice(&block);
        }
        out
    }

    fn read_cstr(field: &[u8]) -> String {
        let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
        String::from_utf8_lossy(&field[..end]).into_owned()
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    // ---- Auto 選型規則 ----
    #[test]
    fn auto_selection_rules() {
        // 有帳號：ARD 優先。
        assert_eq!(
            choose_security(
                VncSecurityPref::Auto,
                &[SEC_NONE, SEC_VNC, SEC_VENCRYPT, SEC_ARD],
                Some(&creds("bob", "pw"))
            )
            .unwrap(),
            SEC_ARD
        );
        // 有帳號、無 ARD：VeNCrypt-Plain 次之。
        assert_eq!(
            choose_security(
                VncSecurityPref::Auto,
                &[SEC_NONE, SEC_VNC, SEC_VENCRYPT],
                Some(&creds("bob", "pw"))
            )
            .unwrap(),
            SEC_VENCRYPT
        );
        // 有帳號、只有 VNC：退到 VNC。
        assert_eq!(
            choose_security(
                VncSecurityPref::Auto,
                &[SEC_NONE, SEC_VNC],
                Some(&creds("bob", "pw"))
            )
            .unwrap(),
            SEC_VNC
        );
        // 無帳號：VNC 優先於 None。
        assert_eq!(
            choose_security(VncSecurityPref::Auto, &[SEC_NONE, SEC_VNC], None).unwrap(),
            SEC_VNC
        );
        // 無帳號、只有 None：None。
        assert_eq!(
            choose_security(VncSecurityPref::Auto, &[SEC_NONE], None).unwrap(),
            SEC_NONE
        );
        // 無帳號、只有 ARD：仍選 ARD（之後再要帳號）。
        assert_eq!(
            choose_security(VncSecurityPref::Auto, &[SEC_ARD], None).unwrap(),
            SEC_ARD
        );
        // 空帳號字串視同無帳號。
        assert_eq!(
            choose_security(
                VncSecurityPref::Auto,
                &[SEC_NONE, SEC_VNC, SEC_ARD],
                Some(&creds("", "pw"))
            )
            .unwrap(),
            SEC_VNC
        );
    }

    // ---- 指定型別但伺服器未提供 → 錯誤 ----
    #[test]
    fn explicit_pref_missing_errors() {
        let err = choose_security(VncSecurityPref::Ard, &[SEC_NONE, SEC_VNC], None).unwrap_err();
        match err {
            AppError::Rd(_) => {}
            other => panic!("expected Rd, got {other:?}"),
        }
    }

    // ---- 使用者取消 → RdCancelled ----
    #[tokio::test]
    async fn cancelled_creds_yields_rdcancelled() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let srv = tokio::spawn(async move {
            srv_write_version(&mut server, "RFB 003.008\n").await;
            srv_read_client_version(&mut server).await;
            server.write_all(&[1u8, SEC_VNC]).await.unwrap();
            let _ = srv_read_u8(&mut server).await;
            // 之後 client 會因無密碼、cred source 回 None 而取消，不再往下。
        });
        let err = client_handshake(
            &mut client,
            VncSecurityPref::Vnc,
            None,
            &FixedCreds(None),
        )
        .await
        .unwrap_err();
        let _ = srv.await;
        assert!(matches!(err, AppError::RdCancelled));
    }

    // ---- cred source 補上密碼後成功 ----
    #[tokio::test]
    async fn cred_source_supplies_password() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let challenge = [3u8; 16];
        let expected = vnc_des_response(b"fromdialog", &challenge);
        let srv = tokio::spawn(async move {
            srv_write_version(&mut server, "RFB 003.008\n").await;
            srv_read_client_version(&mut server).await;
            server.write_all(&[1u8, SEC_VNC]).await.unwrap();
            let _ = srv_read_u8(&mut server).await;
            server.write_all(&challenge).await.unwrap();
            let mut resp = [0u8; 16];
            server.read_exact(&mut resp).await.unwrap();
            assert_eq!(resp, expected);
            srv_write_u32(&mut server, 0).await;
        });
        let out = client_handshake(
            &mut client,
            VncSecurityPref::Vnc,
            None,
            &FixedCreds(Some(creds("", "fromdialog"))),
        )
        .await
        .unwrap();
        srv.await.unwrap();
        assert_eq!(out.security, "vnc-auth");
    }

    // ---- Apple 3.889 視為 3.8 ----
    #[test]
    fn apple_version_clamped_to_38() {
        assert_eq!(negotiated_minor((3, 889)), 8);
        assert_eq!(negotiated_minor((3, 8)), 8);
        assert_eq!(negotiated_minor((3, 7)), 7);
        assert_eq!(negotiated_minor((3, 3)), 3);
        assert_eq!(negotiated_minor((3, 4)), 3);
        assert_eq!(negotiated_minor((3, 6)), 3);
        assert_eq!(negotiated_minor((4, 0)), 8);
    }

    // ---- DES 基元的 FIPS 已知答案（KAT） ----
    // 來源：FIPS PUB 81 / NBS 單塊 DES 標準向量：
    //   key = 133457799BBCDFF1, plaintext = 0123456789ABCDEF → ciphertext = 85E813540F0AB405。
    // 用來證明 des 0.8 crate 就是標準 DES-ECB（VNC 回應 = 位元反轉金鑰 + 此基元）。
    #[test]
    fn des_primitive_fips_kat() {
        use des::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
        use des::Des;
        let key = [0x13, 0x34, 0x57, 0x79, 0x9B, 0xBC, 0xDF, 0xF1];
        let pt = [0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF];
        let cipher = Des::new(GenericArray::from_slice(&key));
        let mut block = GenericArray::clone_from_slice(&pt);
        cipher.encrypt_block(&mut block);
        let ct: Vec<u8> = block.to_vec();
        assert_eq!(ct, vec![0x85, 0xE8, 0x13, 0x54, 0x0F, 0x0A, 0xB4, 0x05]);
    }

    // ---- VNC 回應：獨立參考路徑（explicit 位元反轉 + DES）比對 ----
    // 說明：因公開的「密碼 + 挑戰 → 回應」向量多與密碼破解教材綁定，改以獨立路徑重算：
    // 顯式對密碼每 byte 位元反轉為金鑰、以 des crate 逐塊加密挑戰，與 vnc_des_response 對照。
    #[test]
    fn vnc_response_independent_reference() {
        use des::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
        use des::Des;

        let password = b"pass";
        let challenge = [0u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

        // 獨立參考：位元反轉金鑰。
        let mut key = [0u8; 8];
        for i in 0..8 {
            let b = *password.get(i).unwrap_or(&0);
            let mut r = 0u8;
            for bit in 0..8 {
                if b & (1 << bit) != 0 {
                    r |= 1 << (7 - bit);
                }
            }
            key[i] = r;
        }
        let cipher = Des::new(GenericArray::from_slice(&key));
        let mut expected = [0u8; 16];
        for blk in 0..2 {
            let mut block = GenericArray::clone_from_slice(&challenge[blk * 8..blk * 8 + 8]);
            cipher.encrypt_block(&mut block);
            expected[blk * 8..blk * 8 + 8].copy_from_slice(&block);
        }

        assert_eq!(vnc_des_response(password, &challenge), expected);
    }

    // ---- reverse_bits 基本檢查 ----
    #[test]
    fn reverse_bits_basic() {
        assert_eq!(reverse_bits(0b0000_0001), 0b1000_0000);
        assert_eq!(reverse_bits(0b1010_0000), 0b0000_0101);
        assert_eq!(reverse_bits(0x00), 0x00);
        assert_eq!(reverse_bits(0xFF), 0xFF);
    }

    // ---- serde：VncSecurityPref 的字串值 ----
    #[test]
    fn security_pref_serde_values() {
        for (v, s) in [
            (VncSecurityPref::Auto, "\"auto\""),
            (VncSecurityPref::None, "\"none\""),
            (VncSecurityPref::Vnc, "\"vnc\""),
            (VncSecurityPref::Ard, "\"ard\""),
            (VncSecurityPref::Plain, "\"plain\""),
        ] {
            assert_eq!(serde_json::to_string(&v).unwrap(), s);
            let back: VncSecurityPref = serde_json::from_str(s).unwrap();
            assert_eq!(back, v);
        }
    }
}
