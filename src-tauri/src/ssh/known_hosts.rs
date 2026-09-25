//! SSH host key 指紋存放（TOFU：trust on first use）。
//!
//! 檔案 `ssh_known_hosts.json` 是 `{ "host:port": "SHA256:…" }` 的平面表，與舊版 tunnel 相同，
//! 升級不需搬遷。`KnownHostsStore` 把路徑做成可注入，讓測試 / 整合測試各用自己的臨時檔，
//! 不會碰到使用者真正的信任清單。
//!
//! 安全備註：讀取 / 持久化失敗時呼叫端一律「拒絕連線」（fail-closed），不退回「信任任意金鑰」。

use std::collections::HashMap;
use std::path::PathBuf;

/// 某台主機的指紋與已記錄清單的關係。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// 與已記錄指紋相同。
    Known,
    /// 第一次見到這台主機。
    New,
    /// 指紋與已記錄的不同（金鑰輪替，或中間人）。
    Changed { old: String },
}

/// 指紋清單的存放位置。`path == None`（找不到設定目錄）時讀到空表、寫入失敗。
#[derive(Debug, Clone)]
pub struct KnownHostsStore {
    path: Option<PathBuf>,
}

impl KnownHostsStore {
    /// 使用者的真正清單：`<config_dir>/dev.dbkit.app/ssh_known_hosts.json`。
    pub fn default_path() -> Self {
        Self {
            path: dirs::config_dir().map(|d| d.join("dev.dbkit.app").join("ssh_known_hosts.json")),
        }
    }

    /// 指定檔案（測試用）。
    pub fn at(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    /// 區分「檔案不存在」（→ 空表，正常首次使用）與「讀取 / 解析失敗」（→ Err，呼叫端 fail-closed）。
    pub fn load(&self) -> std::io::Result<HashMap<String, String>> {
        let Some(p) = &self.path else {
            return Ok(Default::default());
        };
        match std::fs::read(p) {
            Ok(b) => serde_json::from_slice(&b)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(e),
        }
    }

    /// 原子寫入（temp + rename），避免中斷時產生截斷 / 損毀檔；錯誤一律回傳供呼叫端判斷。
    pub fn save(&self, map: &HashMap<String, String>) -> std::io::Result<()> {
        let p = self.path.as_ref().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, t!("找不到設定目錄"))
        })?;
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let b = serde_json::to_vec_pretty(map)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, &b)?;
        std::fs::rename(&tmp, p)?;
        Ok(())
    }

    /// 純比對：指紋與清單的關係。
    pub fn status_in(map: &HashMap<String, String>, host_id: &str, fingerprint: &str) -> HostKeyStatus {
        match map.get(host_id) {
            Some(stored) if stored == fingerprint => HostKeyStatus::Known,
            Some(stored) => HostKeyStatus::Changed { old: stored.clone() },
            None => HostKeyStatus::New,
        }
    }

    /// 讀檔 + 比對。讀不到檔案（損毀 / 權限）回 Err，讓呼叫端 fail-closed。
    pub fn check(&self, host_id: &str, fingerprint: &str) -> std::io::Result<HostKeyStatus> {
        Ok(Self::status_in(&self.load()?, host_id, fingerprint))
    }

    /// 記住（或覆寫）某台主機的指紋。
    pub fn record(&self, host_id: &str, fingerprint: &str) -> std::io::Result<()> {
        let mut map = self.load()?;
        map.insert(host_id.to_string(), fingerprint.to_string());
        self.save(&map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbkit-kh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d.join("ssh_known_hosts.json")
    }

    #[test]
    fn three_states_and_record_roundtrip() {
        let s = KnownHostsStore::at(tmp());
        assert_eq!(s.check("h:22", "SHA256:a").unwrap(), HostKeyStatus::New, "檔案不存在 = 空表");
        s.record("h:22", "SHA256:a").unwrap();
        assert_eq!(s.check("h:22", "SHA256:a").unwrap(), HostKeyStatus::Known);
        assert_eq!(
            s.check("h:22", "SHA256:b").unwrap(),
            HostKeyStatus::Changed { old: "SHA256:a".into() }
        );
        assert_eq!(s.check("other:22", "SHA256:a").unwrap(), HostKeyStatus::New);
        // 覆寫（使用者按「接受並更新」）
        s.record("h:22", "SHA256:b").unwrap();
        assert_eq!(s.check("h:22", "SHA256:b").unwrap(), HostKeyStatus::Known);
    }

    /// 損毀的檔案必須是 Err（呼叫端 fail-closed），不能被當成空表而重新信任任意金鑰。
    #[test]
    fn corrupt_file_is_an_error_not_empty() {
        let p = tmp();
        std::fs::write(&p, b"{ not json").unwrap();
        let s = KnownHostsStore::at(p);
        assert!(s.load().is_err());
        assert!(s.check("h:22", "x").is_err());
        assert!(s.record("h:22", "x").is_err(), "record 也不可把損毀檔蓋掉");
    }

    #[test]
    fn missing_config_dir_reads_empty_but_cannot_save() {
        let s = KnownHostsStore { path: None };
        assert!(s.load().unwrap().is_empty());
        assert!(s.save(&Default::default()).is_err());
    }
}
