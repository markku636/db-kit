//! 加密匯出連線的「範圍挑選 + 機密政策」核心（GUI `export_connections_encrypted` 與
//! dbk CLI `conn export` 共用同一份，避免兩邊政策漂移）。
//!
//! 硬規則：PROD 連線（`options.prod == "1"`）一律不帶帳號與任何機密 —— 使用者在
//! 「進階匯出」勾了什麼都無效，CLI 也一樣。匯出檔可攜（能被 copy 到任何機器、離線暴力破解），
//! 所以正式環境的帳密從來不該進到這個檔案裡；要在對方機器上用 PROD 連線，就自己補帳密。
//! 沿用既有的 `options.prod` 旗標（同 `commands::schema_cache_allowed` 的判定），
//! 不另立一套「敏感連線」概念。

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::store::{self, PersistedConnection};

/// 加密匯出檔內的單筆連線 = `PersistedConnection` + 從 keychain 取出的機密。
/// 只存在密文內，不會以明文落地。未帶的機密為空字串（匯入端遇空字串會跳過、不覆寫既有 keychain）。
#[derive(Serialize, Deserialize)]
pub struct ExportedConn {
    #[serde(flatten)]
    pub base: PersistedConnection,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub ssh_password: String,
    #[serde(default)]
    pub ssh_passphrase: String,
    #[serde(default)]
    pub otp_secret: String,
}

fn yes() -> bool {
    true
}

/// 匯出範圍與機密政策（前端「進階匯出」對話框的選項）。
/// 欄位全部 `#[serde(default)]`：舊前端 / CLI 不給就是「全部連線 + 全部機密」，與改版前行為一致。
#[derive(Debug, Clone, Deserialize)]
pub struct ExportScope {
    /// 只匯出這些連線 id；`None` 或空陣列 = 全部。
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// 帶資料庫密碼。
    #[serde(default = "yes")]
    pub include_password: bool,
    /// 帶 SSH 密碼與私鑰 passphrase。
    #[serde(default = "yes")]
    pub include_ssh: bool,
    /// 帶 OTP secret。
    #[serde(default = "yes")]
    pub include_otp: bool,
    /// 帶側欄群組歸屬（`group_id`）；false = 匯入端一律視為未分組。
    #[serde(default = "yes")]
    pub include_groups: bool,
}

impl Default for ExportScope {
    fn default() -> Self {
        Self {
            ids: None,
            include_password: true,
            include_ssh: true,
            include_otp: true,
            include_groups: true,
        }
    }
}

/// 匯出結果統計。`redacted` = 因 PROD 硬規則被抹掉帳號與機密的筆數（回前端提示用）。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ExportSummary {
    pub count: usize,
    pub redacted: usize,
}

/// 此連線是否標記為正式環境。
pub fn is_prod(c: &PersistedConnection) -> bool {
    c.options.get("prod").map(|v| v == "1").unwrap_or(false)
}

/// 依 `scope` 挑出要匯出的連線，並套用機密政策（含 PROD 硬規則）。
/// 機密逐筆從 keychain 取；沒勾的類別連讀都不讀。
pub fn build(conns: Vec<PersistedConnection>, scope: &ExportScope) -> (Vec<ExportedConn>, ExportSummary) {
    let selected = |id: &str| match &scope.ids {
        Some(ids) if !ids.is_empty() => ids.iter().any(|x| x == id),
        _ => true,
    };
    let kc = |account: String, allowed: bool| {
        if allowed {
            store::kc_get(&account).unwrap_or_default()
        } else {
            String::new()
        }
    };
    let mut redacted = 0usize;
    let exported: Vec<ExportedConn> = conns
        .into_iter()
        .filter(|c| selected(&c.id))
        .map(|mut c| {
            if !scope.include_groups {
                c.group_id = None;
            }
            if is_prod(&c) {
                redacted += 1;
                // 帳號也算「帳密」的一半：PROD 連同 username / ssh_username 一起抹掉，
                // 匯入端拿到的是「連得到哪台、用什麼驅動」，但登入資訊得自己填。
                c.username = String::new();
                c.ssh_username = String::new();
                return ExportedConn {
                    base: c,
                    password: String::new(),
                    ssh_password: String::new(),
                    ssh_passphrase: String::new(),
                    otp_secret: String::new(),
                };
            }
            let id = c.id.clone();
            ExportedConn {
                password: kc(id.clone(), scope.include_password),
                ssh_password: kc(store::ssh_account(&id), scope.include_ssh),
                ssh_passphrase: kc(store::ssh_passphrase_account(&id), scope.include_ssh),
                otp_secret: kc(store::otp_account(&id), scope.include_otp),
                base: c,
            }
        })
        .collect();
    let count = exported.len();
    (exported, ExportSummary { count, redacted })
}

/// 序列化 → 以 passphrase 加密 → 寫檔（GUI / CLI 共用尾段）。
pub async fn write_encrypted(path: &str, passphrase: &str, exported: &[ExportedConn]) -> AppResult<()> {
    let plain = serde_json::to_vec(exported)
        .map_err(|e| AppError::Storage(tf!("序列化失敗：{e}", e = e)))?;
    let blob = crate::conn_crypto::encrypt(&plain, passphrase)?;
    tokio::fs::write(path, blob)
        .await
        .map_err(|e| AppError::Storage(tf!("寫入失敗：{e}", e = e)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbKind;

    fn conn(id: &str, prod: bool) -> PersistedConnection {
        let mut options = std::collections::BTreeMap::new();
        if prod {
            options.insert("prod".to_string(), "1".to_string());
        }
        PersistedConnection {
            id: id.to_string(),
            name: id.to_string(),
            kind: DbKind::Mysql,
            host: "db.example.com".into(),
            port: 3306,
            username: "app".into(),
            database: None,
            max_connections: 5,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_username: "ops".into(),
            ssh_auth_method: Default::default(),
            ssh_private_key_path: String::new(),
            options,
            group_id: Some("g1".into()),
        }
    }

    #[test]
    fn exports_only_selected_ids() {
        let scope = ExportScope {
            ids: Some(vec!["b".into()]),
            ..Default::default()
        };
        let (out, sum) = build(vec![conn("a", false), conn("b", false)], &scope);
        assert_eq!(sum.count, 1);
        assert_eq!(out[0].base.id, "b");
    }

    #[test]
    fn empty_or_missing_ids_export_all() {
        for ids in [None, Some(vec![])] {
            let scope = ExportScope { ids, ..Default::default() };
            let (_, sum) = build(vec![conn("a", false), conn("b", false)], &scope);
            assert_eq!(sum.count, 2);
        }
    }

    #[test]
    fn prod_never_carries_credentials() {
        // 三個 include_* 全開，PROD 仍必須空手而回 —— 這是本模組唯一不可覆寫的規則。
        let (out, sum) = build(vec![conn("p", true)], &ExportScope::default());
        assert_eq!(sum.redacted, 1);
        let e = &out[0];
        assert_eq!(e.base.username, "");
        assert_eq!(e.base.ssh_username, "");
        assert_eq!(e.password, "");
        assert_eq!(e.ssh_password, "");
        assert_eq!(e.ssh_passphrase, "");
        assert_eq!(e.otp_secret, "");
        // 非機密欄位照常帶出：對方仍看得到這是哪台機器、什麼驅動。
        assert_eq!(e.base.host, "db.example.com");
    }

    #[test]
    fn redacted_counts_prod_only() {
        let (_, sum) = build(vec![conn("a", false), conn("p", true)], &ExportScope::default());
        assert_eq!(sum.count, 2);
        assert_eq!(sum.redacted, 1);
    }

    #[test]
    fn include_groups_false_clears_group_id() {
        let scope = ExportScope { include_groups: false, ..Default::default() };
        let (out, _) = build(vec![conn("a", false)], &scope);
        assert_eq!(out[0].base.group_id, None);
        let (kept, _) = build(vec![conn("a", false)], &ExportScope::default());
        assert_eq!(kept[0].base.group_id.as_deref(), Some("g1"));
    }
}
