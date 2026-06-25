//! 連線設定加密匯出 / 匯入用的對稱加密。
//!
//! 檔案格式（單檔）：`MAGIC(8) || salt(16) || nonce(12) || ciphertext(AES-256-GCM)`。
//! 金鑰由使用者 passphrase 經 Argon2id 派生（salt 隨機）。GCM 同時驗證完整性——
//! passphrase 錯或檔案被竄改時 `decrypt` 會失敗（auth tag 不符）。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::Argon2;

use crate::error::{AppError, AppResult};

const MAGIC: &[u8; 8] = b"DBKITEC1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

fn derive_key(passphrase: &str, salt: &[u8]) -> AppResult<[u8; 32]> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Storage(format!("金鑰派生失敗：{e}")))?;
    Ok(key)
}

/// 以 passphrase 加密明文，回傳含檔頭的完整 blob。
pub fn encrypt(plain: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    if passphrase.is_empty() {
        return Err(AppError::Storage("passphrase 不可為空".into()));
    }
    let salt: [u8; SALT_LEN] = rand::random();
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let key = derive_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain)
        .map_err(|_| AppError::Storage("加密失敗".into()))?;

    let mut out = Vec::with_capacity(MAGIC.len() + SALT_LEN + NONCE_LEN + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 以 passphrase 解密 blob。passphrase 錯或檔案損毀 / 非本格式 → Err。
pub fn decrypt(blob: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    let header = MAGIC.len() + SALT_LEN + NONCE_LEN;
    if blob.len() < header || &blob[..MAGIC.len()] != MAGIC {
        return Err(AppError::Storage("非 db-kit 加密連線檔（檔頭不符）".into()));
    }
    let salt = &blob[MAGIC.len()..MAGIC.len() + SALT_LEN];
    let nonce = &blob[MAGIC.len() + SALT_LEN..header];
    let ct = &blob[header..];
    let key = derive_key(passphrase, salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| AppError::Storage("解密失敗（passphrase 錯誤或檔案損毀）".into()))
}
