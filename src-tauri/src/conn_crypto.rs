//! 連線設定加密匯出 / 匯入用的對稱加密。
//!
//! 檔案格式（單檔）：`MAGIC(8) || salt(16) || nonce(12) || ciphertext(AES-256-GCM)`。
//! 金鑰由使用者 passphrase 經 Argon2id 派生（salt 隨機）。GCM 同時驗證完整性——
//! passphrase 錯或檔案被竄改時 `decrypt` 會失敗（auth tag 不符）。
//!
//! 版本以 MAGIC 尾碼區分（KDF 參數跟著版本固定，升級 argon2 crate 不影響舊檔解密）：
//! - `DBKITEC1`（舊）：Argon2id 用 library 預設參數（19 MiB / t=2）— 僅供解密相容。
//! - `DBKITEC2`（現行）：Argon2id m=64 MiB / t=3 / p=1 — 匯出檔可攜、可離線暴力破解，
//!   參數取高於 OWASP 最低建議的檔案加密等級。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};

use crate::error::{AppError, AppResult};

const MAGIC_V1: &[u8; 8] = b"DBKITEC1";
const MAGIC_V2: &[u8; 8] = b"DBKITEC2";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
/// 匯出檔 passphrase 最低長度（弱口令的離線暴力成本太低；與前端提示一致）。
const MIN_PASSPHRASE: usize = 8;

/// v1 KDF（僅解密相容）：argon2 crate 預設參數。
fn derive_key_v1(passphrase: &str, salt: &[u8]) -> AppResult<[u8; 32]> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Storage(tf!("金鑰派生失敗：{e}", e = e)))?;
    Ok(key)
}

/// v2 KDF（現行加密）：顯式參數 m=64 MiB / t=3 / p=1，與 MAGIC 版本綁定。
fn derive_key_v2(passphrase: &str, salt: &[u8]) -> AppResult<[u8; 32]> {
    let params = Params::new(64 * 1024, 3, 1, Some(32))
        .map_err(|e| AppError::Storage(tf!("金鑰派生參數錯誤：{e}", e = e)))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Storage(tf!("金鑰派生失敗：{e}", e = e)))?;
    Ok(key)
}

/// 以 passphrase 加密明文，回傳含檔頭的完整 blob（v2 格式）。
pub fn encrypt(plain: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    if passphrase.len() < MIN_PASSPHRASE {
        return Err(AppError::Storage(tf!(
            "passphrase 至少 {min} 碼（匯出檔可離線暴力破解，弱口令保護不了機密）",
            min = MIN_PASSPHRASE
        )));
    }
    let salt: [u8; SALT_LEN] = rand::random();
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let key = derive_key_v2(passphrase, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain)
        .map_err(|_| AppError::Storage(t!("加密失敗").into()))?;

    let mut out = Vec::with_capacity(MAGIC_V2.len() + SALT_LEN + NONCE_LEN + ct.len());
    out.extend_from_slice(MAGIC_V2);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 以 passphrase 解密 blob（依 MAGIC 自動選 KDF 版本）。passphrase 錯或檔案損毀 / 非本格式 → Err。
pub fn decrypt(blob: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    let header = MAGIC_V2.len() + SALT_LEN + NONCE_LEN;
    if blob.len() < header {
        return Err(AppError::Storage(t!("非 db-kit 加密連線檔（檔頭不符）").into()));
    }
    let magic = &blob[..MAGIC_V2.len()];
    let salt = &blob[MAGIC_V2.len()..MAGIC_V2.len() + SALT_LEN];
    let nonce = &blob[MAGIC_V2.len() + SALT_LEN..header];
    let ct = &blob[header..];
    let key = if magic == MAGIC_V2 {
        derive_key_v2(passphrase, salt)?
    } else if magic == MAGIC_V1 {
        derive_key_v1(passphrase, salt)?
    } else {
        return Err(AppError::Storage(t!("非 db-kit 加密連線檔（檔頭不符）").into()));
    };
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| AppError::Storage(t!("解密失敗（passphrase 錯誤或檔案損毀）").into()))
}
