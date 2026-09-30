//! RDP 伺服器憑證的 TOFU（trust on first use）。
//!
//! RDP 伺服器幾乎都是自簽憑證（Windows 自動產生），走 CA 驗證等於每台都要跳警告，所以跟 SSH host key
//! 一樣：第一次問、記住 SHA-256 指紋、之後比對。存檔格式與 `ssh_known_hosts.json` 相同（平面
//! `{ "host:port": "SHA256:…" }`），直接沿用 `KnownHostsStore`，只換檔名。

use crate::ssh::known_hosts::{HostKeyStatus, KnownHostsStore};

/// 檔名（與 SSH 的指紋清單分開：同一台主機的 SSH host key 與 RDP 憑證是兩回事）。
pub const CERTS_FILE: &str = "rd_known_certs.json";

pub type CertStore = KnownHostsStore;

/// 使用者真正的清單：`<config_dir>/dev.dbkit.app/rd_known_certs.json`。
/// 找不到設定目錄時讀到空表、寫入失敗（`AcceptSave` 會回錯，`AcceptOnce` 仍可用）。
pub fn default_store() -> CertStore {
    KnownHostsStore::config_file(CERTS_FILE)
}

/// 要問使用者的憑證資訊。
#[derive(Debug, Clone)]
pub struct CertQuestion {
    pub host_id: String,
    pub fingerprint: String,
    pub subject: String,
    pub status: HostKeyStatus,
}

impl CertQuestion {
    pub fn from_cert(host: &str, port: u16, cert: &x509_cert::Certificate) -> Self {
        use x509_cert::der::Encode as _;
        let der = cert.to_der().unwrap_or_default();
        Self {
            host_id: format!("{host}:{port}"),
            fingerprint: fingerprint(&der),
            subject: cert.tbs_certificate.subject.to_string(),
            status: HostKeyStatus::New,
        }
    }
}

/// `SHA256:` + base64（無 padding），與 SSH 指紋同一種寫法，使用者比對時不用切換腦袋。
pub fn fingerprint(der: &[u8]) -> String {
    use base64::Engine as _;
    use sha2::Digest as _;
    let h = sha2::Sha256::digest(der);
    format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_format() {
        // sha256("") = e3b0c442…；base64 無 padding 43 字元
        let f = fingerprint(b"");
        assert_eq!(f, "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU");
    }

    #[test]
    fn tofu_roundtrip_with_separate_file() {
        let d = std::env::temp_dir().join(format!("dbkit-rdcert-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let s = KnownHostsStore::at(d.join(CERTS_FILE));
        assert_eq!(s.check("h:3389", "SHA256:a").unwrap(), HostKeyStatus::New);
        s.record("h:3389", "SHA256:a").unwrap();
        assert_eq!(s.check("h:3389", "SHA256:a").unwrap(), HostKeyStatus::Known);
        assert!(matches!(s.check("h:3389", "SHA256:b").unwrap(), HostKeyStatus::Changed { .. }));
    }
}
