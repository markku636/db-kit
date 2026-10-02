//! 遠端桌面伺服器憑證的 TOFU（trust on first use）：RDP 與 VNC（VeNCrypt X509）共用。
//!
//! RDP / VNC 伺服器幾乎都是自簽憑證（Windows、Xvnc、QEMU 自己產生），走 CA 驗證等於每台都要跳警告，所以跟 SSH
//! host key 一樣：第一次問、記住 SHA-256 指紋、之後比對。存檔格式與 `ssh_known_hosts.json` 相同（平面
//! `{ "host:port": "SHA256:…" }`），直接沿用 `KnownHostsStore`，只換檔名。RDP 與 VNC 的埠不同，記在同一個檔案不會互相蓋掉。

use async_trait::async_trait;

use super::runtime::CertDecision;
use crate::error::{AppError, AppResult};
use crate::ssh::known_hosts::{HostKeyStatus, KnownHostsStore};

/// 憑證對話框（GUI 發事件等回答；測試用固定答案）。
#[async_trait]
pub trait CertUi: Send + Sync {
    async fn ask(&self, q: CertQuestion) -> CertDecision;
}

/// 比對已信任的指紋；第一次見到或變了就問使用者。拒絕 → [`AppError::RdCancelled`]。
/// 要在送出任何認證資料之前呼叫（使用者拒絕時密碼不會送給冒牌伺服器）。
pub async fn check_tofu(store: &CertStore, ui: &dyn CertUi, q: CertQuestion) -> AppResult<()> {
    let status = store
        .check(&q.host_id, &q.fingerprint)
        .map_err(|e| AppError::Rd(tf!("無法讀取已信任的遠端桌面憑證清單：{e}", e = e)))?;
    if status == HostKeyStatus::Known {
        return Ok(());
    }
    match ui.ask(CertQuestion { status, ..q.clone() }).await {
        CertDecision::AcceptSave => store
            .record(&q.host_id, &q.fingerprint)
            .map_err(|e| AppError::Rd(tf!("無法記住憑證：{e}", e = e))),
        CertDecision::AcceptOnce => Ok(()),
        CertDecision::Reject => Err(AppError::RdCancelled),
    }
}

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

    /// 從 DER 建（rustls 給的是 DER）：指紋照原始位元組算；主旨解不出來就留空。
    pub fn from_der(host: &str, port: u16, der: &[u8]) -> Self {
        use x509_cert::der::Decode as _;
        let subject = x509_cert::Certificate::from_der(der)
            .map(|c| c.tbs_certificate.subject.to_string())
            .unwrap_or_default();
        Self { host_id: format!("{host}:{port}"), fingerprint: fingerprint(der), subject, status: HostKeyStatus::New }
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
