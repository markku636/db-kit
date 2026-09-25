//! SSH 使用者金鑰（Xshell 的「使用者金鑰管理員」）：格式辨識、各種格式的私鑰載入、OpenSSH 憑證、
//! App 內的金鑰庫。
//!
//! **能載入的私鑰格式**——russh 0.61 / ssh-key 0.7 原生解得開的交給它們，其餘在這裡補：
//! - OpenSSH（`BEGIN OPENSSH PRIVATE KEY`，bcrypt 密語）
//! - PuTTY PPK v2 / v3（v3 的 Argon2 密語）
//! - PKCS#8（`BEGIN PRIVATE KEY` / `BEGIN ENCRYPTED PRIVATE KEY`）
//! - PKCS#1 RSA 與 SEC1 EC（`BEGIN RSA / EC PRIVATE KEY`），**包括 OpenSSL 傳統加密**
//!   （`Proc-Type: 4,ENCRYPTED` + `DEK-Info`）的 DES-EDE3-CBC / DES-CBC / AES-128/192/256-CBC。
//!   russh 只認 AES-128，`openssl genrsa -des3`、`openssl rsa -aes256`、舊版 `ssh-keygen -m PEM`
//!   產的金鑰在這裡先解開再交給它
//! - 沒有 PEM 外殼的二進位 DER（PKCS#8 / PKCS#1 / SEC1 的 `.der` / `.key`）
//!
//! **認得、但不能用的**一律回明確的說明（該怎麼轉換）而不是一句「讀取失敗」：DSA（OpenSSH 7.0 起
//! 預設停用）、SSH.COM / SECSH 私鑰、公鑰、OpenSSH 憑證本身、X.509 憑證、PKCS#12（`.pfx` / `.p12`）。
//!
//! **金鑰庫**：匯入時一律轉成 OpenSSH 格式存進 `<設定目錄>/ssh_keys/<id>`。原本有密語就用同一個密語
//! 重新加密——原本加密的金鑰絕不以明文落地；轉成 OpenSSH 之後，公鑰與指紋不必解密就讀得到。
//! 主機以 `keystore:<id>` 參照金鑰，不綁檔案路徑（原檔搬走、刪掉都不影響）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine as _;
use russh::keys::ssh_key::{
    self, public::KeyData, Algorithm, Certificate, EcdsaCurve, HashAlg, LineEnding, PrivateKey, PublicKey,
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 主機設定裡參照金鑰庫的前綴：`keystore:<id>`。
pub const KEYSTORE_PREFIX: &str = "keystore:";
const STORE_DIR: &str = "ssh_keys";
const INDEX_FILE: &str = "index.json";

// ---- 格式辨識 ----

/// OpenSSL 傳統 PEM 加密（`DEK-Info`）支援的演算法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyCipher {
    DesEde3Cbc,
    DesCbc,
    Aes128Cbc,
    Aes192Cbc,
    Aes256Cbc,
}

impl LegacyCipher {
    fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_uppercase().as_str() {
            "DES-EDE3-CBC" => Some(Self::DesEde3Cbc),
            "DES-CBC" => Some(Self::DesCbc),
            "AES-128-CBC" => Some(Self::Aes128Cbc),
            "AES-192-CBC" => Some(Self::Aes192Cbc),
            "AES-256-CBC" => Some(Self::Aes256Cbc),
            _ => None,
        }
    }

    fn key_len(self) -> usize {
        match self {
            Self::DesEde3Cbc | Self::Aes192Cbc => 24,
            Self::DesCbc => 8,
            Self::Aes128Cbc => 16,
            Self::Aes256Cbc => 32,
        }
    }

    fn iv_len(self) -> usize {
        match self {
            Self::DesEde3Cbc | Self::DesCbc => 8,
            _ => 16,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::DesEde3Cbc => "DES-EDE3-CBC",
            Self::DesCbc => "DES-CBC",
            Self::Aes128Cbc => "AES-128-CBC",
            Self::Aes192Cbc => "AES-192-CBC",
            Self::Aes256Cbc => "AES-256-CBC",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyFormat {
    OpenSsh,
    Ppk { version: u8 },
    Pkcs8,
    Pkcs8Encrypted,
    Pkcs1Rsa,
    Sec1Ec,
    /// 沒有 PEM 外殼的二進位 DER。
    Der,
}

impl KeyFormat {
    /// 給人看的格式名稱（格式名本身不翻譯）。
    pub fn label(self, legacy: Option<LegacyCipher>) -> String {
        let base = match self {
            Self::OpenSsh => "OpenSSH".to_string(),
            Self::Ppk { version } => format!("PuTTY PPK v{version}"),
            Self::Pkcs8 | Self::Pkcs8Encrypted => "PKCS#8".to_string(),
            Self::Pkcs1Rsa => "PEM (PKCS#1 RSA)".to_string(),
            Self::Sec1Ec => "PEM (SEC1 EC)".to_string(),
            Self::Der => "DER".to_string(),
        };
        match legacy {
            Some(c) => format!("{base}, {}", c.name()),
            None => base,
        }
    }

    /// 傳統 PEM 加密時要重新包回去的 PEM 標籤。
    fn pem_label(self) -> &'static str {
        match self {
            Self::Pkcs1Rsa => "RSA PRIVATE KEY",
            Self::Sec1Ec => "EC PRIVATE KEY",
            _ => "PRIVATE KEY",
        }
    }
}

/// 格式辨識的結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Detected {
    Private {
        format: KeyFormat,
        encrypted: bool,
        /// OpenSSL 傳統 PEM 加密：演算法 + IV。
        legacy: Option<(LegacyCipher, Vec<u8>)>,
    },
    /// 不是（能用的）私鑰：訊息已本地化，並說明該怎麼辦。
    Unsupported(String),
}

fn text_of(bytes: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(bytes).ok()?;
    Some(s.trim_start_matches('\u{feff}').replace("\r\n", "\n"))
}

/// 找出某個 PEM 區塊的內文（BEGIN 與 END 之間，不含標頭行）。
fn pem_block<'a>(text: &'a str, label: &str) -> Option<&'a str> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let start = text.find(&begin)? + begin.len();
    let stop = text[start..].find(&end)? + start;
    Some(&text[start..stop])
}

/// 傳統 PEM 加密的標頭：`Proc-Type: 4,ENCRYPTED` + `DEK-Info: <演算法>,<IV hex>`。
/// 回 `Ok(None)` = 沒加密；`Err` = 加密但演算法不支援。
fn legacy_header(block: &str) -> Result<Option<(LegacyCipher, Vec<u8>)>, String> {
    let mut encrypted = false;
    let mut dek: Option<&str> = None;
    for line in block.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("Proc-Type:") {
            encrypted = v.to_ascii_uppercase().contains("ENCRYPTED");
        } else if let Some(v) = line.strip_prefix("DEK-Info:") {
            dek = Some(v.trim());
        }
    }
    if !encrypted {
        return Ok(None);
    }
    let dek = dek.ok_or_else(|| t!("PEM 標示為加密，卻沒有 DEK-Info").to_string())?;
    let (name, iv_hex) = dek.split_once(',').unwrap_or((dek, ""));
    let cipher = LegacyCipher::parse(name)
        .ok_or_else(|| tf!("不支援的 PEM 加密方式：{name}（可支援 DES-EDE3-CBC、DES-CBC、AES-128/192/256-CBC）", name = name))?;
    let iv = hex_decode(iv_hex.trim()).filter(|v| v.len() == cipher.iv_len()).ok_or_else(|| t!("PEM 的 DEK-Info IV 格式錯誤").to_string())?;
    Ok(Some((cipher, iv)))
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn msg_dsa() -> String {
    t!("DSA（ssh-dss）金鑰：OpenSSH 7.0 起預設停用、9.8 起移除，多數伺服器已不接受。請改用 ed25519 或 RSA 3072 以上的金鑰。").to_string()
}
fn msg_sshcom() -> String {
    t!("SSH.COM（SECSH）格式的私鑰：請先轉成 OpenSSH 格式，例如 ssh-keygen -i -f <檔案> > id_key，或用 PuTTYgen 的 Import 再 Export OpenSSH key。").to_string()
}
fn msg_public() -> String {
    t!("這是公鑰，不是私鑰。請選對應的私鑰檔（通常是同名、沒有 .pub 的那個）。").to_string()
}
fn msg_cert() -> String {
    t!("這是 OpenSSH 憑證（-cert.pub），不是私鑰。請選對應的私鑰；憑證放在私鑰旁邊（<私鑰>-cert.pub）或在主機設定指定，連線時會一起使用。").to_string()
}
fn msg_x509() -> String {
    t!("這是 X.509（SSL / TLS）憑證，不是 SSH 金鑰。SSH 要用的是私鑰檔（例如 id_ed25519、.ppk、.pem）。").to_string()
}
fn msg_pkcs12() -> String {
    t!("看起來是 PKCS#12（.pfx / .p12）憑證包或加密的二進位私鑰。請先轉出 PEM 私鑰，例如 openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem。").to_string()
}
fn msg_unknown() -> String {
    t!("認不得的金鑰格式。支援 OpenSSH、PuTTY PPK、PKCS#8、PEM（PKCS#1 RSA / SEC1 EC，含 OpenSSL 加密）與 DER；Xshell / SecureCRT 的金鑰請先在該軟體裡匯出成 OpenSSH 格式。").to_string()
}

/// 認出檔案內容是哪一種私鑰（或哪一種「不是私鑰」）。
pub fn detect(bytes: &[u8]) -> Detected {
    // 二進位：DER 的外層一律是 SEQUENCE（0x30）。PKCS#8 / PKCS#1 / SEC1 或 PKCS#12 都有可能，載入時再試。
    // 短的 DER 可能剛好是合法 UTF-8（全是 < 0x80 的位元組），所以「0x30 開頭 + 有控制字元」也算二進位。
    let control = |b: &u8| *b < 0x09 || (*b > 0x0d && *b < 0x20);
    if bytes.first() == Some(&0x30) && (std::str::from_utf8(bytes).is_err() || bytes.iter().any(control)) {
        return Detected::Private { format: KeyFormat::Der, encrypted: false, legacy: None };
    }
    let Some(text) = text_of(bytes) else {
        return Detected::Unsupported(msg_unknown());
    };
    let t = text.trim_start();
    if let Some(rest) = t.strip_prefix("PuTTY-User-Key-File-") {
        let version = rest.chars().next().and_then(|c| c.to_digit(10)).unwrap_or(0) as u8;
        let encrypted = t
            .lines()
            .find_map(|l| l.strip_prefix("Encryption:"))
            .map(|v| v.trim() != "none")
            .unwrap_or(false);
        return Detected::Private { format: KeyFormat::Ppk { version }, encrypted, legacy: None };
    }
    if let Some(block) = pem_block(&text, "OPENSSH PRIVATE KEY") {
        let pem = format!("-----BEGIN OPENSSH PRIVATE KEY-----{block}-----END OPENSSH PRIVATE KEY-----\n");
        let encrypted = PrivateKey::from_openssh(pem.as_bytes()).map(|k| k.is_encrypted()).unwrap_or(false);
        return Detected::Private { format: KeyFormat::OpenSsh, encrypted, legacy: None };
    }
    if text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        return Detected::Private { format: KeyFormat::Pkcs8Encrypted, encrypted: true, legacy: None };
    }
    for (label, format) in [("RSA PRIVATE KEY", KeyFormat::Pkcs1Rsa), ("EC PRIVATE KEY", KeyFormat::Sec1Ec), ("PRIVATE KEY", KeyFormat::Pkcs8)] {
        if let Some(block) = pem_block(&text, label) {
            return match legacy_header(block) {
                Ok(legacy) => Detected::Private { format, encrypted: legacy.is_some(), legacy },
                Err(msg) => Detected::Unsupported(msg),
            };
        }
    }
    if text.contains("-----BEGIN DSA PRIVATE KEY-----") {
        return Detected::Unsupported(msg_dsa());
    }
    if text.contains("---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----") || text.contains("---- BEGIN SSH2 PRIVATE KEY ----") {
        return Detected::Unsupported(msg_sshcom());
    }
    if text.contains("-----BEGIN CERTIFICATE-----") || text.contains("-----BEGIN TRUSTED CERTIFICATE-----") {
        return Detected::Unsupported(msg_x509());
    }
    if text.contains("---- BEGIN SSH2 PUBLIC KEY ----")
        || text.contains("-----BEGIN PUBLIC KEY-----")
        || text.contains("-----BEGIN RSA PUBLIC KEY-----")
    {
        return Detected::Unsupported(msg_public());
    }
    let first = t.lines().next().unwrap_or("").trim();
    let word = first.split_whitespace().next().unwrap_or("");
    if word.ends_with("-cert-v01@openssh.com") {
        return Detected::Unsupported(msg_cert());
    }
    if word.starts_with("ssh-") || word.starts_with("ecdsa-") || word.starts_with("sk-") {
        return Detected::Unsupported(msg_public());
    }
    Detected::Unsupported(msg_unknown())
}

// ---- 載入 ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    /// 受密語保護，沒給密語。
    NeedPassphrase,
    /// 給了密語但解不開（多半是密語錯；也可能是不支援的加密方式）。
    BadPassphrase(String),
    /// 不是能用的私鑰：訊息已本地化，含建議。
    Unsupported(String),
    /// 認得格式但內容壞了。
    Invalid(String),
}

impl KeyError {
    pub fn message(&self) -> String {
        match self {
            Self::NeedPassphrase => t!("這把私鑰受密語保護，請輸入密語").to_string(),
            Self::BadPassphrase(d) => tf!("密語不正確（或不支援這種加密方式）：{e}", e = d),
            Self::Unsupported(m) => m.clone(),
            Self::Invalid(d) => tf!("無法解析私鑰：{e}", e = d),
        }
    }
}

impl From<KeyError> for AppError {
    fn from(e: KeyError) -> Self {
        AppError::Ssh(e.message())
    }
}

/// OpenSSL 的 `EVP_BytesToKey(MD5, 1 輪)`：傳統 PEM 加密從密語導出金鑰（salt = IV 前 8 bytes）。
fn evp_bytes_to_key(pass: &[u8], salt: &[u8], key_len: usize) -> Vec<u8> {
    use md5::{Digest, Md5};
    let mut out = Vec::with_capacity(key_len + 16);
    let mut prev: Vec<u8> = Vec::new();
    while out.len() < key_len {
        let mut h = Md5::new();
        h.update(&prev);
        h.update(pass);
        h.update(salt);
        prev = h.finalize().to_vec();
        out.extend_from_slice(&prev);
    }
    out.truncate(key_len);
    out
}

fn legacy_decrypt(cipher: LegacyCipher, key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let mut buf = data.to_vec();
    let n = match cipher {
        LegacyCipher::DesEde3Cbc => cbc::Decryptor::<des::TdesEde3>::new_from_slices(key, iv).ok()?.decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?.len(),
        LegacyCipher::DesCbc => cbc::Decryptor::<des::Des>::new_from_slices(key, iv).ok()?.decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?.len(),
        LegacyCipher::Aes128Cbc => cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv).ok()?.decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?.len(),
        LegacyCipher::Aes192Cbc => cbc::Decryptor::<aes::Aes192>::new_from_slices(key, iv).ok()?.decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?.len(),
        LegacyCipher::Aes256Cbc => cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv).ok()?.decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?.len(),
    };
    buf.truncate(n);
    Some(buf)
}

/// PEM 區塊的 base64 內文（跳過 `Proc-Type:` 之類的標頭行與空行）。
fn pem_body_der(block: &str) -> Option<Vec<u8>> {
    let b64: String = block.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains(':')).collect();
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

fn wrap_pem(label: &str, der: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut s = format!("-----BEGIN {label}-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        s.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        s.push('\n');
    }
    s.push_str(&format!("-----END {label}-----\n"));
    s
}

/// 二進位 DER：依序當成 PKCS#8 / PKCS#1 / SEC1 試（有密語時再試加密的 PKCS#8）。
fn load_der(bytes: &[u8], pass: Option<&str>) -> Result<PrivateKey, KeyError> {
    for label in ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"] {
        if let Ok(k) = russh::keys::decode_secret_key(&wrap_pem(label, bytes), None) {
            return Ok(k);
        }
    }
    if let Some(p) = pass {
        if let Ok(k) = russh::keys::decode_secret_key(&wrap_pem("ENCRYPTED PRIVATE KEY", bytes), Some(p)) {
            return Ok(k);
        }
    }
    Err(KeyError::Unsupported(msg_pkcs12()))
}

/// 載入私鑰（任何支援的格式），回 `(私鑰, 格式, 檔案本身是否受密語保護)`。
/// 沒加密的金鑰給了密語也照樣載入（密語忽略）。
pub fn load_private_key(bytes: &[u8], passphrase: Option<&str>) -> Result<(PrivateKey, KeyFormat, bool), KeyError> {
    let pass = passphrase.filter(|p| !p.is_empty());
    let (format, encrypted, legacy) = match detect(bytes) {
        Detected::Unsupported(msg) => return Err(KeyError::Unsupported(msg)),
        Detected::Private { format: KeyFormat::Der, .. } => {
            return load_der(bytes, pass).map(|k| (k, KeyFormat::Der, false));
        }
        Detected::Private { format, encrypted, legacy } => (format, encrypted, legacy),
    };
    if encrypted && pass.is_none() {
        return Err(KeyError::NeedPassphrase);
    }
    let text = text_of(bytes).unwrap_or_default();
    let r = match legacy {
        Some((cipher, iv)) => {
            let pass = pass.unwrap_or_default();
            let block = pem_block(&text, format.pem_label()).ok_or_else(|| KeyError::Invalid("PEM".into()))?;
            let der = pem_body_der(block).ok_or_else(|| KeyError::Invalid("base64".into()))?;
            let key = evp_bytes_to_key(pass.as_bytes(), &iv[..8], cipher.key_len());
            let plain = legacy_decrypt(cipher, &key, &iv, &der)
                .ok_or_else(|| KeyError::BadPassphrase(t!("解密後的內容不正確").to_string()))?;
            russh::keys::decode_secret_key(&wrap_pem(format.pem_label(), &plain), None)
        }
        None => russh::keys::decode_secret_key(&text, if encrypted { pass } else { None }),
    };
    match r {
        Ok(k) => Ok((k, format, encrypted)),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(KeyError::NeedPassphrase),
        Err(e) if encrypted => Err(KeyError::BadPassphrase(e.to_string())),
        Err(e) => Err(KeyError::Invalid(e.to_string())),
    }
}

// ---- 檢視（給 UI 的摘要） ----

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KeyInfo {
    pub format: String,
    /// `ssh-ed25519`、`ssh-rsa`、`ecdsa-sha2-nistp256`…
    pub algorithm: String,
    pub bits: Option<u32>,
    /// `SHA256:…`
    pub fingerprint: String,
    pub comment: String,
    /// 檔案本身受密語保護。
    pub encrypted: bool,
    /// `authorized_keys` 那一行（含註解）。
    pub public_openssh: String,
}

fn key_bits(k: &KeyData) -> Option<u32> {
    match k {
        KeyData::Rsa(r) => Some(r.key_size()),
        KeyData::Ecdsa(e) => Some(match e.curve() {
            EcdsaCurve::NistP256 => 256,
            EcdsaCurve::NistP384 => 384,
            EcdsaCurve::NistP521 => 521,
        }),
        KeyData::Ed25519(_) => Some(256),
        _ => None,
    }
}

fn info_of(pk: &PublicKey, format: String, encrypted: bool) -> KeyInfo {
    KeyInfo {
        format,
        algorithm: pk.algorithm().as_str().to_string(),
        bits: key_bits(pk.key_data()),
        fingerprint: pk.fingerprint(HashAlg::Sha256).to_string(),
        comment: pk.comment().to_string(),
        encrypted,
        public_openssh: pk.to_openssh().unwrap_or_default(),
    }
}

/// 不必解密就讀得到的公鑰（OpenSSH 與 PPK 的公鑰是明文存的）。
fn public_without_passphrase(bytes: &[u8]) -> Option<PublicKey> {
    let text = text_of(bytes)?;
    if let Some(block) = pem_block(&text, "OPENSSH PRIVATE KEY") {
        let pem = format!("-----BEGIN OPENSSH PRIVATE KEY-----{block}-----END OPENSSH PRIVATE KEY-----\n");
        return PrivateKey::from_openssh(pem.as_bytes()).ok().map(|k| k.public_key().clone());
    }
    if text.trim_start().starts_with("PuTTY-User-Key-File-") {
        let mut lines = text.lines();
        let mut comment = String::new();
        let mut blob = String::new();
        while let Some(l) = lines.next() {
            if let Some(c) = l.strip_prefix("Comment:") {
                comment = c.trim().to_string();
            } else if let Some(n) = l.strip_prefix("Public-Lines:") {
                let n: usize = n.trim().parse().ok()?;
                for _ in 0..n {
                    blob.push_str(lines.next()?.trim());
                }
            }
        }
        let raw = base64::engine::general_purpose::STANDARD.decode(blob).ok()?;
        let mut pk = PublicKey::from_bytes(&raw).ok()?;
        pk.set_comment(comment);
        return Some(pk);
    }
    None
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InspectStatus {
    Ok,
    NeedPassphrase,
    BadPassphrase,
    Unsupported,
    Invalid,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KeyInspect {
    pub status: InspectStatus,
    pub format: Option<String>,
    /// `ok` 時完整；要密語時若公鑰是明文存的（OpenSSH / PPK）也先給，讓使用者認得出是哪一把。
    pub info: Option<KeyInfo>,
    pub message: Option<String>,
    pub cert: Option<CertInfo>,
}

impl KeyInspect {
    /// 連檔案都讀不到（路徑錯、金鑰庫裡已刪除）。
    pub fn unreadable(message: String) -> Self {
        Self { status: InspectStatus::Invalid, format: None, info: None, message: Some(message), cert: None }
    }
}

/// 檢視一把私鑰：能不能用、是哪一把、要不要密語。成功時一併回私鑰本身（匯入用）。
pub fn inspect(bytes: &[u8], passphrase: Option<&str>) -> (KeyInspect, Option<PrivateKey>) {
    let (format, legacy) = match detect(bytes) {
        Detected::Private { format, legacy, .. } => (Some(format), legacy.map(|l| l.0)),
        Detected::Unsupported(_) => (None, None),
    };
    let label = format.map(|f| f.label(legacy));
    match load_private_key(bytes, passphrase) {
        Ok((key, format, encrypted)) => {
            let info = info_of(key.public_key(), format.label(legacy), encrypted);
            (KeyInspect { status: InspectStatus::Ok, format: Some(info.format.clone()), info: Some(info), message: None, cert: None }, Some(key))
        }
        Err(e) => {
            let status = match e {
                KeyError::NeedPassphrase => InspectStatus::NeedPassphrase,
                KeyError::BadPassphrase(_) => InspectStatus::BadPassphrase,
                KeyError::Unsupported(_) => InspectStatus::Unsupported,
                KeyError::Invalid(_) => InspectStatus::Invalid,
            };
            let info = matches!(status, InspectStatus::NeedPassphrase | InspectStatus::BadPassphrase)
                .then(|| public_without_passphrase(bytes))
                .flatten()
                .map(|pk| info_of(&pk, label.clone().unwrap_or_default(), true));
            (KeyInspect { status, format: label, info, message: Some(e.message()), cert: None }, None)
        }
    }
}

// ---- OpenSSH 憑證 ----

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CertInfo {
    pub path: String,
    pub key_id: String,
    pub principals: Vec<String>,
    /// epoch 秒；`valid_before == u64::MAX` = 永久有效。
    pub valid_after: u64,
    pub valid_before: u64,
    /// `user` / `host`
    pub cert_type: String,
    pub ca_fingerprint: String,
    /// 憑證裡的公鑰與私鑰是否同一把；私鑰還沒解開（要密語）時為 None。
    pub matches_key: Option<bool>,
    /// `valid` / `expired` / `not_yet_valid`
    pub validity: String,
}

/// 私鑰旁邊的憑證：OpenSSH 慣例 `<私鑰>-cert.pub`；私鑰有副檔名（.ppk / .pem / .key）時也找
/// `<去掉副檔名>-cert.pub`。
pub fn default_cert_candidates(key_path: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut s = key_path.as_os_str().to_owned();
    s.push("-cert.pub");
    out.push(PathBuf::from(s));
    if key_path.extension().is_some() {
        let mut s = key_path.with_extension("").into_os_string();
        s.push("-cert.pub");
        out.push(PathBuf::from(s));
    }
    out
}

pub fn parse_certificate(text: &str) -> Result<Certificate, KeyError> {
    Certificate::from_openssh(text.trim()).map_err(|e| KeyError::Invalid(tf!("憑證格式錯誤：{e}", e = e)))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn cert_info(cert: &Certificate, path: &Path, key: Option<&PublicKey>, now: u64) -> CertInfo {
    let validity = if now < cert.valid_after() {
        "not_yet_valid"
    } else if now >= cert.valid_before() {
        "expired"
    } else {
        "valid"
    };
    CertInfo {
        path: path.display().to_string(),
        key_id: cert.key_id().to_string(),
        principals: cert.valid_principals().to_vec(),
        valid_after: cert.valid_after(),
        valid_before: cert.valid_before(),
        cert_type: if cert.cert_type().is_host() { "host" } else { "user" }.to_string(),
        ca_fingerprint: cert.signature_key().fingerprint(HashAlg::Sha256).to_string(),
        matches_key: key.map(|k| cert.public_key() == k.key_data()),
        validity: validity.to_string(),
    }
}

/// 認證時要一起用的憑證：主機設定了路徑就用那個（讀不到 → 錯誤，不默默略過）；沒設就找私鑰旁邊的
/// `-cert.pub`（找不到 = 沒有憑證，不是錯誤）。
pub fn find_certificate(key_path: &Path, explicit: &str) -> Result<Option<(PathBuf, Certificate)>, KeyError> {
    let explicit = explicit.trim();
    if !explicit.is_empty() {
        let p = PathBuf::from(explicit);
        let text = std::fs::read_to_string(&p).map_err(|e| KeyError::Invalid(tf!("讀不到憑證 {path}：{e}", path = p.display(), e = e)))?;
        return parse_certificate(&text).map(|c| Some((p, c)));
    }
    for p in default_cert_candidates(key_path) {
        if let Ok(text) = std::fs::read_to_string(&p) {
            // 旁邊那個壞掉的憑證不擋連線：當成沒有，讓私鑰本身照常試。
            if let Ok(c) = parse_certificate(&text) {
                return Ok(Some((p, c)));
            }
        }
    }
    Ok(None)
}

// ---- 金鑰庫 ----

static STORE_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// App 啟動時登記設定目錄（`keystore:` 參照要靠它解析）。沒登記時退回 CLI 用的同一個目錄。
pub fn init_store_root(config_dir: &Path) {
    let _ = STORE_ROOT.set(config_dir.to_path_buf());
}

fn store_root() -> AppResult<PathBuf> {
    match STORE_ROOT.get() {
        Some(p) => Ok(p.clone()),
        None => crate::store::headless_config_dir(),
    }
}

pub fn store_dir_in(config_dir: &Path) -> PathBuf {
    config_dir.join(STORE_DIR)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// 金鑰庫裡某把金鑰的檔案。id 只收英數與 `-`（擋掉 `..` 之類的路徑穿越）。
pub fn key_file_in(config_dir: &Path, id: &str) -> AppResult<PathBuf> {
    if !valid_id(id) {
        return Err(AppError::Ssh(tf!("無效的金鑰 id：{id}", id = id)));
    }
    Ok(store_dir_in(config_dir).join(id))
}

fn cert_file_of(key_file: &Path) -> PathBuf {
    let mut s = key_file.as_os_str().to_owned();
    s.push("-cert.pub");
    PathBuf::from(s)
}

/// `keystore:<id>` → 金鑰庫裡的檔案；其他字串照原樣當成路徑。
pub fn resolve_key_path(p: &str) -> AppResult<PathBuf> {
    let p = p.trim();
    match p.strip_prefix(KEYSTORE_PREFIX) {
        Some(id) => {
            let f = key_file_in(&store_root()?, id)?;
            if !f.exists() {
                return Err(AppError::Ssh(tf!("金鑰庫裡找不到這把金鑰（可能已刪除）：{id}", id = id)));
            }
            Ok(f)
        }
        None => Ok(PathBuf::from(p)),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredKey {
    pub id: String,
    pub name: String,
    pub algorithm: String,
    #[serde(default)]
    pub bits: Option<u32>,
    pub fingerprint: String,
    #[serde(default)]
    pub comment: String,
    pub encrypted: bool,
    /// 匯入時的原始格式（顯示用；產生的金鑰是空字串）。
    #[serde(default)]
    pub source_format: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub has_cert: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct KeyIndex {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    keys: Vec<StoredKey>,
}

async fn read_index(config_dir: &Path) -> AppResult<KeyIndex> {
    crate::store::read_json_in(&store_dir_in(config_dir), INDEX_FILE).await
}

async fn write_index(config_dir: &Path, idx: &KeyIndex) -> AppResult<()> {
    crate::store::write_json_in(&store_dir_in(config_dir), INDEX_FILE, idx).await?;
    restrict_permissions(&store_dir_in(config_dir), true);
    Ok(())
}

/// Unix 上把金鑰庫收成只有自己讀得到（目錄 0700、檔案 0600）。Windows 的設定目錄本來就是每個使用者一份 ACL。
fn restrict_permissions(path: &Path, is_dir: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(if is_dir { 0o700 } else { 0o600 }));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, is_dir);
    }
}

async fn write_secret_file(path: &Path, content: &[u8]) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| AppError::Storage(e.to_string()))?;
        restrict_permissions(dir, true);
    }
    tokio::fs::write(path, content).await.map_err(|e| AppError::Storage(e.to_string()))?;
    restrict_permissions(path, false);
    Ok(())
}

/// 列出金鑰庫（檔案已不在的條目略過）。
pub async fn list_in(config_dir: &Path) -> AppResult<Vec<StoredKey>> {
    let idx = read_index(config_dir).await?;
    let mut out = Vec::with_capacity(idx.keys.len());
    for mut k in idx.keys {
        let Ok(f) = key_file_in(config_dir, &k.id) else { continue };
        if tokio::fs::try_exists(&f).await.unwrap_or(false) {
            k.has_cert = tokio::fs::try_exists(cert_file_of(&f)).await.unwrap_or(false);
            out.push(k);
        }
    }
    Ok(out)
}

/// 匯入的結果：`existed` = 同一把（指紋相同）早就在金鑰庫裡，回傳的是原本那一筆。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportOutcome {
    pub key: StoredKey,
    pub existed: bool,
}

fn default_name(key: &PrivateKey) -> String {
    let c = key.comment().to_string();
    if !c.trim().is_empty() {
        return c;
    }
    format!("{} {}", key.algorithm().as_str(), &key.fingerprint(HashAlg::Sha256).to_string().chars().skip(7).take(8).collect::<String>())
}

/// 把一把已經解開的私鑰存進金鑰庫（OpenSSH 格式）。`protect` = 用來重新加密的密語（None = 不加密）。
async fn store_key(
    config_dir: &Path,
    mut key: PrivateKey,
    protect: Option<&str>,
    name: Option<&str>,
    source_format: String,
    cert: Option<&Certificate>,
) -> AppResult<ImportOutcome> {
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let mut idx = read_index(config_dir).await?;
    if let Some(existing) = idx.keys.iter().find(|k| k.fingerprint == fingerprint) {
        if key_file_in(config_dir, &existing.id).map(|f| f.exists()).unwrap_or(false) {
            return Ok(ImportOutcome { key: existing.clone(), existed: true });
        }
    }
    let name = name.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| default_name(&key));
    if key.comment().is_empty() {
        key.set_comment(name.clone());
    }
    let to_write = match protect.filter(|p| !p.is_empty()) {
        Some(p) => {
            let mut rng = rand010::rng();
            key.encrypt(&mut rng, p).map_err(|e| AppError::Ssh(tf!("加密私鑰失敗：{e}", e = e)))?
        }
        None => key.clone(),
    };
    let pem = to_write.to_openssh(LineEnding::LF).map_err(|e| AppError::Ssh(tf!("轉成 OpenSSH 格式失敗：{e}", e = e)))?;
    let id = uuid::Uuid::new_v4().to_string();
    let file = key_file_in(config_dir, &id)?;
    write_secret_file(&file, pem.as_bytes()).await?;
    let mut has_cert = false;
    if let Some(c) = cert.filter(|c| c.public_key() == key.public_key().key_data()) {
        if let Ok(line) = c.to_openssh() {
            write_secret_file(&cert_file_of(&file), format!("{line}\n").as_bytes()).await?;
            has_cert = true;
        }
    }
    let pk = key.public_key();
    let stored = StoredKey {
        id,
        name,
        algorithm: pk.algorithm().as_str().to_string(),
        bits: key_bits(pk.key_data()),
        fingerprint,
        comment: key.comment().to_string(),
        encrypted: protect.is_some_and(|p| !p.is_empty()),
        source_format,
        created_at: now_secs(),
        has_cert,
    };
    idx.version = 1;
    idx.keys.push(stored.clone());
    write_index(config_dir, &idx).await?;
    Ok(ImportOutcome { key: stored, existed: false })
}

/// 匯入一把私鑰（任何支援的格式）。原本受密語保護 → 用同一個密語重新加密後存；
/// `new_passphrase` 有值 → 改用它（原本沒加密的也可以趁匯入加上密語）。
pub async fn import_in(
    config_dir: &Path,
    bytes: &[u8],
    passphrase: Option<&str>,
    new_passphrase: Option<&str>,
    name: Option<&str>,
    cert: Option<&Certificate>,
) -> AppResult<ImportOutcome> {
    let legacy = match detect(bytes) {
        Detected::Private { legacy, .. } => legacy.map(|l| l.0),
        Detected::Unsupported(_) => None,
    };
    let (key, format, encrypted) = load_private_key(bytes, passphrase)?;
    let protect = match new_passphrase.filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None if encrypted => passphrase,
        None => None,
    };
    store_key(config_dir, key, protect, name, format.label(legacy), cert).await
}

/// 產生新金鑰時可選的演算法。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenAlgorithm {
    Ed25519,
    EcdsaP256,
    EcdsaP384,
    Rsa3072,
    Rsa4096,
}

/// 產生新金鑰存進金鑰庫（Xshell 的「新增使用者金鑰精靈」）。RSA 很慢，在 blocking 執行緒上做。
pub async fn generate_in(
    config_dir: &Path,
    alg: GenAlgorithm,
    comment: &str,
    passphrase: Option<&str>,
    name: Option<&str>,
) -> AppResult<StoredKey> {
    let comment = comment.trim().to_string();
    let mut key = tokio::task::spawn_blocking(move || -> Result<PrivateKey, ssh_key::Error> {
        let mut rng = rand010::rng();
        match alg {
            GenAlgorithm::Ed25519 => PrivateKey::random(&mut rng, Algorithm::Ed25519),
            GenAlgorithm::EcdsaP256 => PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 }),
            GenAlgorithm::EcdsaP384 => PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 }),
            GenAlgorithm::Rsa3072 | GenAlgorithm::Rsa4096 => {
                let bits = if alg == GenAlgorithm::Rsa3072 { 3072 } else { 4096 };
                let kp = ssh_key::private::RsaKeypair::random(&mut rng, bits)?;
                PrivateKey::new(ssh_key::private::KeypairData::from(kp), "")
            }
        }
    })
    .await
    .map_err(|e| AppError::Ssh(e.to_string()))?
    .map_err(|e| AppError::Ssh(tf!("產生金鑰失敗：{e}", e = e)))?;
    if !comment.is_empty() {
        key.set_comment(comment);
    }
    Ok(store_key(config_dir, key, passphrase, name, String::new(), None).await?.key)
}

pub async fn rename_in(config_dir: &Path, id: &str, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Ssh(t!("名稱不能是空的").into()));
    }
    let mut idx = read_index(config_dir).await?;
    let k = idx.keys.iter_mut().find(|k| k.id == id).ok_or_else(|| AppError::Ssh(tf!("金鑰庫裡找不到這把金鑰（可能已刪除）：{id}", id = id)))?;
    k.name = name.to_string();
    write_index(config_dir, &idx).await
}

/// 刪除金鑰（連同憑證）。已經不在也當成功。
pub async fn remove_in(config_dir: &Path, id: &str) -> AppResult<()> {
    let file = key_file_in(config_dir, id)?;
    let _ = tokio::fs::remove_file(cert_file_of(&file)).await;
    match tokio::fs::remove_file(&file).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(AppError::Storage(e.to_string())),
    }
    let mut idx = read_index(config_dir).await?;
    idx.keys.retain(|k| k.id != id);
    write_index(config_dir, &idx).await
}

/// 公鑰那一行（貼進伺服器的 `~/.ssh/authorized_keys`）。金鑰庫的檔案是 OpenSSH 格式，不必解密。
pub async fn public_key_in(config_dir: &Path, id: &str) -> AppResult<String> {
    let bytes = tokio::fs::read(key_file_in(config_dir, id)?).await.map_err(|e| AppError::Storage(e.to_string()))?;
    let pk = public_without_passphrase(&bytes).ok_or_else(|| AppError::Ssh(t!("讀不到公鑰").into()))?;
    pk.to_openssh().map_err(|e| AppError::Ssh(e.to_string()))
}

/// 匯出私鑰（OpenSSH 格式，原本有密語就還是有）；有憑證也一起放在旁邊（`<dest>-cert.pub`）。
pub async fn export_in(config_dir: &Path, id: &str, dest: &Path) -> AppResult<()> {
    let file = key_file_in(config_dir, id)?;
    let bytes = tokio::fs::read(&file).await.map_err(|e| AppError::Storage(e.to_string()))?;
    write_secret_file(dest, &bytes).await?;
    if let Ok(cert) = tokio::fs::read(cert_file_of(&file)).await {
        write_secret_file(&cert_file_of(dest), &cert).await?;
    }
    Ok(())
}

/// 把一張 OpenSSH 憑證掛到金鑰庫裡的金鑰上（必須是同一把的憑證）。
pub async fn attach_cert_in(config_dir: &Path, id: &str, cert_text: &str) -> AppResult<CertInfo> {
    let file = key_file_in(config_dir, id)?;
    let bytes = tokio::fs::read(&file).await.map_err(|e| AppError::Storage(e.to_string()))?;
    let pk = public_without_passphrase(&bytes).ok_or_else(|| AppError::Ssh(t!("讀不到公鑰").into()))?;
    let cert = parse_certificate(cert_text)?;
    if cert.public_key() != pk.key_data() {
        return Err(AppError::Ssh(t!("這張憑證簽的不是這把金鑰").into()));
    }
    let line = cert.to_openssh().map_err(|e| AppError::Ssh(e.to_string()))?;
    let cpath = cert_file_of(&file);
    write_secret_file(&cpath, format!("{line}\n").as_bytes()).await?;
    Ok(cert_info(&cert, &cpath, Some(&pk), now_secs()))
}

/// 私鑰檔（或 `keystore:` 參照）加上憑證資訊的完整檢視。`explicit_cert` 是主機設定裡指定的憑證路徑。
pub fn inspect_path(path: &Path, passphrase: Option<&str>, explicit_cert: &str) -> KeyInspect {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            return KeyInspect {
                status: InspectStatus::Invalid,
                format: None,
                info: None,
                message: Some(tf!("讀取 SSH 私鑰失敗：{e}", e = e)),
                cert: None,
            }
        }
    };
    let (mut out, key) = inspect(&bytes, passphrase);
    let public = key.as_ref().map(|k| k.public_key().clone()).or_else(|| public_without_passphrase(&bytes));
    match find_certificate(path, explicit_cert) {
        Ok(Some((p, c))) => out.cert = Some(cert_info(&c, &p, public.as_ref(), now_secs())),
        Ok(None) => {}
        Err(e) => {
            // 指定的憑證讀不到：附在訊息裡，私鑰本身的狀態不變。
            let m = e.message();
            out.message = Some(match out.message.take() {
                Some(prev) => format!("{prev}\n{m}"),
                None => m,
            });
        }
    }
    out
}

/// 測試共用：產生各種格式的私鑰（單元測試與 Docker 整合測試都用；私鑰一律執行時產生，不進版控）。
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// 測試用：OpenSSL 傳統 PEM 加密（與 `legacy_decrypt` 對稱），驗證各種演算法的來回。
    pub fn legacy_encrypt_pem(label: &str, der: &[u8], cipher: LegacyCipher, pass: &str, iv: &[u8]) -> String {
        use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let key = evp_bytes_to_key(pass.as_bytes(), &iv[..8], cipher.key_len());
        let mut buf = der.to_vec();
        let pad = 8 * 2 * 4; // 足夠的尾巴空間給 PKCS#7
        buf.resize(der.len() + pad, 0);
        let n = match cipher {
            LegacyCipher::DesEde3Cbc => cbc::Encryptor::<des::TdesEde3>::new_from_slices(&key, iv).unwrap().encrypt_padded_mut::<Pkcs7>(&mut buf, der.len()).unwrap().len(),
            LegacyCipher::DesCbc => cbc::Encryptor::<des::Des>::new_from_slices(&key, iv).unwrap().encrypt_padded_mut::<Pkcs7>(&mut buf, der.len()).unwrap().len(),
            LegacyCipher::Aes128Cbc => cbc::Encryptor::<aes::Aes128>::new_from_slices(&key, iv).unwrap().encrypt_padded_mut::<Pkcs7>(&mut buf, der.len()).unwrap().len(),
            LegacyCipher::Aes192Cbc => cbc::Encryptor::<aes::Aes192>::new_from_slices(&key, iv).unwrap().encrypt_padded_mut::<Pkcs7>(&mut buf, der.len()).unwrap().len(),
            LegacyCipher::Aes256Cbc => cbc::Encryptor::<aes::Aes256>::new_from_slices(&key, iv).unwrap().encrypt_padded_mut::<Pkcs7>(&mut buf, der.len()).unwrap().len(),
        };
        buf.truncate(n);
        let iv_hex: String = iv.iter().map(|b| format!("{b:02X}")).collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        let mut s = format!("-----BEGIN {label}-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: {},{iv_hex}\n\n", cipher.name());
        for c in b64.as_bytes().chunks(64) {
            s.push_str(std::str::from_utf8(c).unwrap());
            s.push('\n');
        }
        s.push_str(&format!("-----END {label}-----\n"));
        s
    }

    /// SEC1（`BEGIN EC PRIVATE KEY`）的 DER：P-256 私鑰 + 公鑰點，手工編碼（避免測試再拉一套 p256）。
    pub fn sec1_p256_der(k: &PrivateKey) -> Vec<u8> {
        let ssh_key::private::KeypairData::Ecdsa(ssh_key::private::EcdsaKeypair::NistP256 { public, private }) = k.key_data() else {
            panic!("not p256")
        };
        let d = private.as_slice();
        let q = public.as_bytes();
        assert_eq!((d.len(), q.len()), (32, 65));
        let mut body = vec![0x02, 0x01, 0x01, 0x04, 0x20];
        body.extend_from_slice(d);
        body.extend_from_slice(&[0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
        body.extend_from_slice(&[0xa1, 0x44, 0x03, 0x42, 0x00]);
        body.extend_from_slice(q);
        let mut der = vec![0x30, body.len() as u8];
        der.extend_from_slice(&body);
        der
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{legacy_encrypt_pem, sec1_p256_der};
    use super::*;
    use russh::keys::ssh_key::certificate;

    fn ed25519() -> PrivateKey {
        let mut k = PrivateKey::random(&mut rand010::rng(), Algorithm::Ed25519).unwrap();
        k.set_comment("test@dbkit");
        k
    }
    fn p256() -> PrivateKey {
        PrivateKey::random(&mut rand010::rng(), Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 }).unwrap()
    }
    fn fp(k: &PrivateKey) -> String {
        k.fingerprint(HashAlg::Sha256).to_string()
    }

    #[test]
    fn evp_bytes_to_key_matches_openssl() {
        // 已知答案取自 OpenSSL 3.5：
        //   openssl enc -des-ede3-cbc -pass pass:test -S 0102030405060708 -md md5 -P
        //   openssl enc -aes-256-cbc  -pass pass:test -S 0102030405060708 -md md5 -P
        let salt = [1, 2, 3, 4, 5, 6, 7, 8];
        assert_eq!(evp_bytes_to_key(b"test", &salt, 24), hex_decode("D5E2AD1215FCA1925CA04478222A1851925ADB7B9BC2DC7B").unwrap());
        assert_eq!(
            evp_bytes_to_key(b"test", &salt, 32),
            hex_decode("D5E2AD1215FCA1925CA04478222A1851925ADB7B9BC2DC7B1E887EE1D41AFB38").unwrap()
        );
    }

    #[test]
    fn openssh_plain_and_encrypted() {
        let k = ed25519();
        let plain = k.to_openssh(LineEnding::LF).unwrap();
        let (got, fmt, enc) = load_private_key(plain.as_bytes(), None).unwrap();
        assert_eq!((fp(&got), fmt, enc), (fp(&k), KeyFormat::OpenSsh, false));
        // 沒加密的金鑰給了密語也照樣載入
        assert!(load_private_key(plain.as_bytes(), Some("whatever")).is_ok());

        let locked = k.encrypt(&mut rand010::rng(), "s3cret").unwrap().to_openssh(LineEnding::CRLF).unwrap();
        assert_eq!(load_private_key(locked.as_bytes(), None).unwrap_err(), KeyError::NeedPassphrase);
        assert!(matches!(load_private_key(locked.as_bytes(), Some("wrong")).unwrap_err(), KeyError::BadPassphrase(_)));
        let (got, _, enc) = load_private_key(locked.as_bytes(), Some("s3cret")).unwrap();
        assert!(enc);
        assert_eq!(fp(&got), fp(&k));

        // 要密語時仍認得出是哪一把（OpenSSH 的公鑰是明文）
        let (ins, _) = inspect(locked.as_bytes(), None);
        assert_eq!(ins.status, InspectStatus::NeedPassphrase);
        assert_eq!(ins.info.as_ref().map(|i| i.fingerprint.clone()), Some(fp(&k)));
    }

    #[test]
    fn pkcs8_plain_and_encrypted() {
        let k = ed25519();
        let mut plain = Vec::new();
        russh::keys::encode_pkcs8_pem(&k, &mut plain).unwrap();
        let (got, fmt, _) = load_private_key(&plain, None).unwrap();
        assert_eq!((fp(&got), fmt), (fp(&k), KeyFormat::Pkcs8));

        let mut locked = Vec::new();
        russh::keys::encode_pkcs8_pem_encrypted(&k, b"pw", 100, &mut locked).unwrap();
        assert_eq!(load_private_key(&locked, None).unwrap_err(), KeyError::NeedPassphrase);
        assert!(matches!(load_private_key(&locked, Some("nope")).unwrap_err(), KeyError::BadPassphrase(_)));
        let (got, fmt, enc) = load_private_key(&locked, Some("pw")).unwrap();
        assert_eq!((fp(&got), fmt, enc), (fp(&k), KeyFormat::Pkcs8Encrypted, true));
    }

    #[test]
    fn sec1_ec_plain_and_every_legacy_cipher() {
        let k = p256();
        let der = sec1_p256_der(&k);
        let plain = wrap_pem("EC PRIVATE KEY", &der);
        let (got, fmt, enc) = load_private_key(plain.as_bytes(), None).unwrap();
        assert_eq!((fp(&got), fmt, enc), (fp(&k), KeyFormat::Sec1Ec, false));

        for (cipher, iv) in [
            (LegacyCipher::DesEde3Cbc, vec![0x11u8; 8]),
            (LegacyCipher::DesCbc, vec![0x22; 8]),
            (LegacyCipher::Aes128Cbc, vec![0x33; 16]),
            (LegacyCipher::Aes192Cbc, vec![0x44; 16]),
            (LegacyCipher::Aes256Cbc, vec![0x55; 16]),
        ] {
            let pem = legacy_encrypt_pem("EC PRIVATE KEY", &der, cipher, "legacy-pw", &iv);
            assert_eq!(
                detect(pem.as_bytes()),
                Detected::Private { format: KeyFormat::Sec1Ec, encrypted: true, legacy: Some((cipher, iv.clone())) },
                "{}", cipher.name()
            );
            assert_eq!(load_private_key(pem.as_bytes(), None).unwrap_err(), KeyError::NeedPassphrase);
            assert!(load_private_key(pem.as_bytes(), Some("wrong-pw")).is_err(), "{}", cipher.name());
            let (got, _, enc) = load_private_key(pem.as_bytes(), Some("legacy-pw")).unwrap();
            assert!(enc);
            assert_eq!(fp(&got), fp(&k), "{}", cipher.name());
            let (ins, _) = inspect(pem.as_bytes(), Some("legacy-pw"));
            assert_eq!(ins.format.as_deref(), Some(format!("PEM (SEC1 EC), {}", cipher.name()).as_str()));
        }
    }

    #[test]
    fn der_without_pem_armor() {
        let k = p256();
        let (got, fmt, _) = load_private_key(&sec1_p256_der(&k), None).unwrap();
        assert_eq!((fp(&got), fmt), (fp(&k), KeyFormat::Der));
        // 認不得的二進位（PKCS#12 的開頭：SEQUENCE 長度 0x0100、version 3）→ 給轉換建議
        for junk in [&[0x30u8, 0x82, 0x01, 0x00, 0x02, 0x01, 0x03][..], &[0x30, 0x03, 0x02, 0x01, 0x03]] {
            let err = load_private_key(junk, None).unwrap_err();
            assert!(matches!(err, KeyError::Unsupported(ref m) if m.contains("pkcs12")), "{err:?}");
        }
    }

    #[test]
    fn explains_what_is_not_a_private_key() {
        let pk = ed25519().public_key().to_openssh().unwrap();
        let cases: Vec<(String, &str)> = vec![
            (pk, ".pub"),
            ("ssh-ed25519-cert-v01@openssh.com AAAA test".into(), "-cert.pub"),
            ("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n".into(), "X.509"),
            ("---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nabc\n---- END SSH2 ENCRYPTED PRIVATE KEY ----\n".into(), "ssh-keygen -i"),
            ("-----BEGIN DSA PRIVATE KEY-----\nMIIB\n-----END DSA PRIVATE KEY-----\n".into(), "ed25519"),
            ("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n".into(), ".pub"),
            ("hello world".into(), "OpenSSH"),
        ];
        for (text, needle) in cases {
            match detect(text.as_bytes()) {
                Detected::Unsupported(m) => assert!(m.contains(needle), "{needle}: {m}"),
                other => panic!("{needle}: {other:?}"),
            }
        }
        // 不支援的 PEM 加密方式
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CFB,00112233445566778899AABBCCDDEEFF\n\nAAAA\n-----END RSA PRIVATE KEY-----\n";
        assert!(matches!(detect(pem.as_bytes()), Detected::Unsupported(m) if m.contains("AES-256-CFB")));
    }

    #[test]
    fn ppk_detection_reads_public_part_without_passphrase() {
        let k = ed25519();
        let blob = k.public_key().to_bytes().unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
        let ppk = format!(
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\nComment: my-ppk-key\nPublic-Lines: 1\n{b64}\nKey-Derivation: Argon2id\nPrivate-Lines: 1\nAAAA\nPrivate-MAC: 00\n"
        );
        assert_eq!(
            detect(ppk.as_bytes()),
            Detected::Private { format: KeyFormat::Ppk { version: 3 }, encrypted: true, legacy: None }
        );
        let (ins, _) = inspect(ppk.as_bytes(), None);
        assert_eq!(ins.status, InspectStatus::NeedPassphrase);
        let info = ins.info.unwrap();
        assert_eq!((info.fingerprint, info.comment.as_str(), info.format.as_str()), (fp(&k), "my-ppk-key", "PuTTY PPK v3"));
    }

    fn user_cert(ca: &PrivateKey, key: &PrivateKey, principals: &[&str], after: u64, before: u64) -> Certificate {
        let mut b = certificate::Builder::new_with_random_nonce(&mut rand010::rng(), key.public_key(), after, before).unwrap();
        b.serial(1).unwrap();
        b.key_id("dbkit-test").unwrap();
        b.cert_type(certificate::CertType::User).unwrap();
        for p in principals {
            b.valid_principal(*p).unwrap();
        }
        b.sign(ca).unwrap()
    }

    #[test]
    fn certificate_info_and_matching() {
        let ca = ed25519();
        let key = ed25519();
        let other = ed25519();
        let now = now_secs();
        let cert = user_cert(&ca, &key, &["deploy", "root"], now - 60, now + 3600);
        let info = cert_info(&cert, Path::new("id-cert.pub"), Some(key.public_key()), now);
        assert_eq!(info.principals, vec!["deploy".to_string(), "root".to_string()]);
        assert_eq!((info.cert_type.as_str(), info.validity.as_str(), info.matches_key), ("user", "valid", Some(true)));
        assert_eq!(info.ca_fingerprint, fp(&ca));
        assert_eq!(cert_info(&cert, Path::new("x"), Some(other.public_key()), now).matches_key, Some(false));
        assert_eq!(cert_info(&cert, Path::new("x"), None, now + 7200).validity, "expired");
        assert_eq!(cert_info(&cert, Path::new("x"), None, now - 3600).validity, "not_yet_valid");
        // 文字來回
        let back = parse_certificate(&cert.to_openssh().unwrap()).unwrap();
        assert_eq!(back.key_id(), "dbkit-test");
    }

    #[test]
    fn cert_candidates_follow_openssh_convention() {
        let c = default_cert_candidates(Path::new("/home/u/.ssh/id_ed25519"));
        assert_eq!(c, vec![PathBuf::from("/home/u/.ssh/id_ed25519-cert.pub")]);
        let c = default_cert_candidates(Path::new("/k/work.ppk"));
        assert_eq!(c, vec![PathBuf::from("/k/work.ppk-cert.pub"), PathBuf::from("/k/work-cert.pub")]);
    }

    #[tokio::test]
    async fn keystore_import_keeps_encryption_and_dedupes() {
        let dir = std::env::temp_dir().join(format!("dbkit-keystore-{}", uuid::Uuid::new_v4()));
        let k = p256();
        let pem = legacy_encrypt_pem("EC PRIVATE KEY", &sec1_p256_der(&k), LegacyCipher::DesEde3Cbc, "pw1", &[7u8; 8]);
        let out = import_in(&dir, pem.as_bytes(), Some("pw1"), None, Some("prod key"), None).await.unwrap();
        assert!(!out.existed);
        assert_eq!((out.key.name.as_str(), out.key.fingerprint.clone(), out.key.encrypted), ("prod key", fp(&k), true));
        assert_eq!(out.key.source_format, "PEM (SEC1 EC), DES-EDE3-CBC");
        // 存進去的是 OpenSSH 格式、仍受同一個密語保護
        let file = key_file_in(&dir, &out.key.id).unwrap();
        let stored = std::fs::read(&file).unwrap();
        assert!(String::from_utf8_lossy(&stored).contains("BEGIN OPENSSH PRIVATE KEY"));
        assert_eq!(load_private_key(&stored, None).unwrap_err(), KeyError::NeedPassphrase);
        assert_eq!(fp(&load_private_key(&stored, Some("pw1")).unwrap().0), fp(&k));
        // 公鑰不必密語
        assert!(public_key_in(&dir, &out.key.id).await.unwrap().starts_with("ecdsa-sha2-nistp256 "));
        // 同一把再匯入 → 回原本那筆
        let again = import_in(&dir, pem.as_bytes(), Some("pw1"), None, None, None).await.unwrap();
        assert!(again.existed);
        assert_eq!(again.key.id, out.key.id);
        // 沒加密的來源 + 匯入時加上密語
        let plain = ed25519();
        let o2 = import_in(&dir, plain.to_openssh(LineEnding::LF).unwrap().as_bytes(), None, Some("newpw"), None, None).await.unwrap();
        assert!(o2.key.encrypted);
        assert_eq!(o2.key.name, "test@dbkit", "沒給名稱就用註解");
        let listed = list_in(&dir).await.unwrap();
        assert_eq!(listed.len(), 2);
        // 改名、刪除
        rename_in(&dir, &o2.key.id, "laptop").await.unwrap();
        assert!(list_in(&dir).await.unwrap().iter().any(|k| k.name == "laptop"));
        remove_in(&dir, &out.key.id).await.unwrap();
        assert_eq!(list_in(&dir).await.unwrap().len(), 1);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn keystore_generate_attach_cert_and_export() {
        let dir = std::env::temp_dir().join(format!("dbkit-keystore-{}", uuid::Uuid::new_v4()));
        let k = generate_in(&dir, GenAlgorithm::Ed25519, "me@laptop", Some("gpw"), Some("laptop")).await.unwrap();
        assert_eq!((k.algorithm.as_str(), k.bits, k.encrypted, k.comment.as_str()), ("ssh-ed25519", Some(256), true, "me@laptop"));
        let file = key_file_in(&dir, &k.id).unwrap();
        let key = load_private_key(&std::fs::read(&file).unwrap(), Some("gpw")).unwrap().0;
        assert_eq!(fp(&key), k.fingerprint);

        let ca = ed25519();
        let now = now_secs();
        let cert = user_cert(&ca, &key, &["deploy"], now - 10, now + 600);
        let info = attach_cert_in(&dir, &k.id, &cert.to_openssh().unwrap()).await.unwrap();
        assert_eq!(info.matches_key, Some(true));
        assert!(list_in(&dir).await.unwrap()[0].has_cert);
        // 別把金鑰的憑證掛不上去
        let wrong = user_cert(&ca, &ed25519(), &["deploy"], now - 10, now + 600);
        assert!(attach_cert_in(&dir, &k.id, &wrong.to_openssh().unwrap()).await.is_err());
        // 檢視：憑證跟著私鑰被找到
        let ins = inspect_path(&file, Some("gpw"), "");
        assert_eq!(ins.status, InspectStatus::Ok);
        assert_eq!(ins.cert.as_ref().map(|c| c.principals.clone()), Some(vec!["deploy".to_string()]));

        let dest = dir.join("exported").join("id_laptop");
        export_in(&dir, &k.id, &dest).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), std::fs::read(&file).unwrap());
        assert!(cert_file_of(&dest).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keystore_ids_cannot_escape_the_store() {
        let d = Path::new("/cfg");
        assert!(key_file_in(d, "../secrets").is_err());
        assert!(key_file_in(d, "a/b").is_err());
        assert!(key_file_in(d, "").is_err());
        assert!(key_file_in(d, "0f3c2a4e-1b2c-4d5e-8f90-123456789abc").is_ok());
    }

    /// 手動交叉驗證：`DBKIT_KEY_FIXTURES` 指到一個放了外部工具產生的金鑰的資料夾（openssl / ssh-keygen /
    /// puttygen），密語一律 `testpass`（ssh-keygen -m PEM 要至少 5 個字）。檔名含 `enc` 的要密語。私鑰不進版控。
    #[test]
    #[ignore = "需要 DBKIT_KEY_FIXTURES"]
    fn external_fixtures() {
        let Ok(dir) = std::env::var("DBKIT_KEY_FIXTURES") else { return };
        let mut n = 0;
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".pub") || name.starts_with('.') {
                continue;
            }
            let bytes = std::fs::read(e.path()).unwrap();
            let r = load_private_key(&bytes, name.contains("enc").then_some("testpass"));
            assert!(r.is_ok(), "{name}: {:?}", r.err());
            let (k, fmt, enc) = r.unwrap();
            println!("{name}: {:?} enc={enc} {} {}", fmt, k.algorithm().as_str(), fp(&k));
            n += 1;
        }
        assert!(n > 0);
    }
}
