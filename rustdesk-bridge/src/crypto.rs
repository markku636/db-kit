// 經 ID 伺服器連線時的加密：驗 ID 伺服器 / 對方的 Ed25519 簽章、用 crypto_box 把對稱金鑰交給對方、
// 之後每個封包用 crypto_secretbox 加密。
//
// 照 RustDesk（rustdesk/rustdesk 的 src/common.rs `create_symmetric_key_msg`、`decode_id_pk`，
// rustdesk/hbb_common 的 src/tcp.rs `Encrypt`，AGPL-3.0）；它們用 libsodium（sodiumoxide），這裡換成純 Rust 的
// 同一組演算法，所以位元組格式要對齊 libsodium 的「combined mode」：
// - 簽章：`crypto_sign` = 64 bytes 簽章 + 原文。
// - crypto_box / crypto_secretbox：16 bytes MAC 在前、密文在後（RustCrypto 的 Aead::encrypt 是 MAC 在後，
//   所以一律用 detached API 自己排）。
// - 封包 nonce：24 bytes，前 8 bytes 是每個方向各自從 1 起算的序號（LE），其餘為 0；兩個方向共用同一把金鑰
//   （key exchange version 0，官方用戶端對方宣告更新版本時仍接受 0）。
//
// SPDX-License-Identifier: AGPL-3.0-only

use base64::Engine as _;
use crypto_box::aead::rand_core::RngCore;
use crypto_box::aead::{AeadInPlace, OsRng};
use crypto_secretbox::{KeyInit, XSalsa20Poly1305};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

const MAC: usize = 16;

/// RustDesk 公開伺服器的公鑰（hbb_common 的 `config::RS_PUB_KEY`）。
pub const PUBLIC_SERVER_KEY: &str = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=";

/// ID 伺服器的公鑰字串（base64，32 bytes）→ Ed25519 公鑰。格式不對 → None。
pub fn server_key(b64: &str) -> Option<[u8; 32]> {
    let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    raw.try_into().ok()
}

/// libsodium 的 `crypto_sign_open`：`簽章(64) + 原文` → 驗過的原文。
pub fn verify_signed(signed: &[u8], pk: &[u8; 32]) -> Option<Vec<u8>> {
    if signed.len() < 64 {
        return None;
    }
    let vk = VerifyingKey::from_bytes(pk).ok()?;
    let sig = Signature::from_slice(&signed[..64]).ok()?;
    let msg = &signed[64..];
    vk.verify(msg, &sig).ok()?;
    Some(msg.to_vec())
}

/// 簽過名的 `IdPk { id, pk }` → `(id, pk)`（`decode_id_pk`）。
pub fn decode_id_pk(signed: &[u8], pk: &[u8; 32]) -> Option<(String, [u8; 32])> {
    use protobuf::Message as _;
    let msg = verify_signed(signed, pk)?;
    let v = crate::proto::rendezvous::IdPk::parse_from_bytes(&msg).ok()?;
    let pk: [u8; 32] = v.pk.to_vec().try_into().ok()?;
    Some((v.id, pk))
}

/// `create_symmetric_key_msg`：產生一次性的 crypto_box 金鑰對與一把 secretbox 金鑰，
/// 把後者封給對方（nonce 全 0）。回傳 `(我方 box 公鑰, 封好的金鑰, 金鑰)`。
pub fn seal_symmetric_key(their_box_pk: [u8; 32]) -> ([u8; 32], Vec<u8>, [u8; 32]) {
    let our_sk = crypto_box::SecretKey::generate(&mut OsRng);
    let our_pk = *our_sk.public_key().as_bytes();
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let sealed = seal_with(&our_sk, their_box_pk, &key);
    (our_pk, sealed, key)
}

fn seal_with(our_sk: &crypto_box::SecretKey, their_box_pk: [u8; 32], key: &[u8; 32]) -> Vec<u8> {
    let b = crypto_box::SalsaBox::new(&crypto_box::PublicKey::from(their_box_pk), our_sk);
    let mut buf = key.to_vec();
    let tag = b
        .encrypt_in_place_detached(&[0u8; 24].into(), b"", &mut buf)
        .expect("crypto_box seal of 32 bytes cannot fail");
    let mut out = tag.to_vec();
    out.extend_from_slice(&buf);
    out
}

/// 一個方向的封包加解密（`Encrypt` 的一半：金鑰 + 這個方向的序號）。
pub struct Cipher {
    c: XSalsa20Poly1305,
    seq: u64,
}

impl Cipher {
    pub fn new(key: &[u8; 32]) -> Self {
        Self { c: XSalsa20Poly1305::new(key.into()), seq: 0 }
    }

    fn nonce(seq: u64) -> crypto_secretbox::Nonce {
        let mut n = [0u8; 24];
        n[..8].copy_from_slice(&seq.to_le_bytes());
        n.into()
    }

    pub fn seal(&mut self, data: &[u8]) -> Vec<u8> {
        self.seq += 1;
        let mut buf = data.to_vec();
        let tag = self
            .c
            .encrypt_in_place_detached(&Self::nonce(self.seq), b"", &mut buf)
            .expect("secretbox seal cannot fail");
        let mut out = Vec::with_capacity(MAC + buf.len());
        out.extend_from_slice(&tag);
        out.extend_from_slice(&buf);
        out
    }

    /// 0 / 1 byte 的封包不加密（官方 `Encrypt::dec` 一樣跳過，也不動序號）。
    pub fn open(&mut self, data: Vec<u8>) -> std::io::Result<Vec<u8>> {
        if data.len() <= 1 {
            return Ok(data);
        }
        self.seq += 1;
        let bad = || std::io::Error::new(std::io::ErrorKind::InvalidData, "decryption error");
        if data.len() < MAC {
            return Err(bad());
        }
        let (tag, ct) = data.split_at(MAC);
        let mut buf = ct.to_vec();
        self.c
            .decrypt_in_place_detached(&Self::nonce(self.seq), b"", &mut buf, tag.into())
            .map_err(|_| bad())?;
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn server_key_parses_public_key() {
        assert!(server_key(PUBLIC_SERVER_KEY).is_some());
        assert!(server_key("not base64!").is_none());
        assert!(server_key("AAAA").is_none(), "長度不是 32 bytes");
    }

    #[test]
    fn signed_id_pk_roundtrip_and_tamper() {
        use protobuf::Message as _;
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let id_pk = crate::proto::rendezvous::IdPk { id: "123456789".into(), pk: vec![9u8; 32].into(), ..Default::default() };
        let msg = id_pk.write_to_bytes().unwrap();
        let mut signed = sk.sign(&msg).to_bytes().to_vec();
        signed.extend_from_slice(&msg);
        assert_eq!(decode_id_pk(&signed, &pk), Some(("123456789".into(), [9u8; 32])));
        let mut bad = signed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(decode_id_pk(&bad, &pk), None, "竄改過 → 不接受");
        assert_eq!(decode_id_pk(&signed, &[1u8; 32]), None, "別把金鑰簽的 → 不接受");
    }

    /// 對方（持有 box 私鑰）解得開我們封的金鑰：MAC 在前的 combined 格式。
    #[test]
    fn sealed_key_opens_on_the_other_side() {
        let peer_sk = crypto_box::SecretKey::from([3u8; 32]);
        let peer_pk = *peer_sk.public_key().as_bytes();
        let (our_pk, sealed, key) = seal_symmetric_key(peer_pk);
        assert_eq!(sealed.len(), 32 + MAC);
        let b = crypto_box::SalsaBox::new(&crypto_box::PublicKey::from(our_pk), &peer_sk);
        let mut buf = sealed[MAC..].to_vec();
        b.decrypt_in_place_detached(&[0u8; 24].into(), b"", &mut buf, sealed[..MAC].into()).unwrap();
        assert_eq!(buf, key);
    }

    #[test]
    fn cipher_sequence_and_small_frames() {
        let key = [5u8; 32];
        let (mut a, mut b) = (Cipher::new(&key), Cipher::new(&key));
        for msg in [&b"hello"[..], b"", b"x", b"world"] {
            let sealed = if msg.len() <= 1 { msg.to_vec() } else { a.seal(msg) };
            assert_eq!(b.open(sealed).unwrap(), msg);
        }
        // 序號錯開（掉了一個封包）→ 解不開
        let _ = a.seal(b"lost");
        assert!(b.open(a.seal(b"next")).is_err());
    }

    /// 跟 libsodium 的 crypto_secretbox_easy 逐 byte 一致：MAC(16) + 密文，nonce 前 8 bytes 是序號 1。
    /// crypto_secretbox crate 的 `Aead::encrypt` 本身就照 libsodium 把 MAC 放前面，拿它當對照。
    #[test]
    fn cipher_matches_combined_layout() {
        use crypto_secretbox::aead::Aead;
        let key = [1u8; 32];
        let mut c = Cipher::new(&key);
        let sealed = c.seal(b"payload");
        let mut n = [0u8; 24];
        n[0] = 1;
        let combined = XSalsa20Poly1305::new(&key.into()).encrypt(&n.into(), &b"payload"[..]).unwrap();
        assert_eq!(sealed, combined);
        assert_eq!(sealed.len(), MAC + 7);
    }
}
