//! 加密匯出連線的「範圍挑選 + 機密政策」核心（GUI `export_connections_encrypted` 與
//! dbk CLI `conn export` 共用同一份，避免兩邊政策漂移）。
//!
//! 硬規則：PROD 連線（`options.prod == "1"`）一律不帶帳號與任何機密 —— 使用者在
//! 「進階匯出」勾了什麼都無效，CLI 也一樣。匯出檔可攜（能被 copy 到任何機器、離線暴力破解），
//! 所以正式環境的帳密從來不該進到這個檔案裡；要在對方機器上用 PROD 連線，就自己補帳密。
//! 沿用既有的 `options.prod` 旗標（同 `commands::schema_cache_allowed` 的判定），
//! 不另立一套「敏感連線」概念。
//!
//! 檔案明文格式（加密前）：
//! - v2：`{ "groups": [...], "connections": [...] }` —— 連線帶 `group_id`，群組定義一起帶出，
//!   匯入端才能把 id 對回去。只帶 `group_id` 不帶群組（v1 的做法）到另一台機器就全變孤兒、
//!   全部落到「未分組」。
//! - v1：純 `[...]` 連線陣列。`parse` 仍接受，讀成「沒有群組」。
//! - v2 起再加 `ssh_folders` / `ssh_hosts` / `rd_folders` / `rd_hosts`（側欄的 SSH 主機與遠端桌面，
//!   各自帶資料夾）。欄位全是 `#[serde(default)]`：舊檔讀成「沒有主機」；舊版 App 讀新檔會忽略
//!   這幾欄、照樣匯入資料庫連線。

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::rd::sessions::{self as rd_sessions, RdFolder, RdSession, RdSessionsFile};
use crate::ssh::sessions::{self as ssh_sessions, SshFolder, SshSession, SshSessionsFile};
use crate::store::{self, ConnGroup, PersistedConnection};

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

/// 加密匯出檔內的單台 SSH 主機 = `SshSession` + keychain 裡的密碼 / 私鑰密語（未帶為空字串）。
#[derive(Serialize, Deserialize)]
pub struct ExportedSsh {
    #[serde(flatten)]
    pub base: SshSession,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub passphrase: String,
}

/// 加密匯出檔內的單台遠端桌面 = `RdSession` + keychain 裡的密碼（未帶為空字串）。
#[derive(Serialize, Deserialize)]
pub struct ExportedRd {
    #[serde(flatten)]
    pub base: RdSession,
    #[serde(default)]
    pub password: String,
}

/// 加密匯出檔的明文內容（v2）。
#[derive(Serialize, Deserialize, Default)]
pub struct ExportFile {
    /// 匯出連線用到的群組定義（順序＝側欄順序）；`include_groups = false` 時為空。
    #[serde(default)]
    pub groups: Vec<ConnGroup>,
    #[serde(default)]
    pub connections: Vec<ExportedConn>,
    /// 匯出的 SSH 主機用到的資料夾（含上層）；`include_groups = false` 時為空。
    #[serde(default)]
    pub ssh_folders: Vec<SshFolder>,
    #[serde(default)]
    pub ssh_hosts: Vec<ExportedSsh>,
    /// 匯出的遠端桌面用到的資料夾（含上層）；`include_groups = false` 時為空。
    #[serde(default)]
    pub rd_folders: Vec<RdFolder>,
    #[serde(default)]
    pub rd_hosts: Vec<ExportedRd>,
}

fn yes() -> bool {
    true
}

/// 匯出範圍與機密政策（前端「進階匯出」對話框的選項）。
/// 欄位全部 `#[serde(default)]`：舊前端 / CLI 不給就是「全部 + 全部機密」，與改版前行為一致。
///
/// 三個 `*ids`：`None` = 全部；`Some(空陣列)` = 一個都不要（只匯出 SSH 主機時，資料庫連線就是空的）。
#[derive(Debug, Clone, Deserialize)]
pub struct ExportScope {
    /// 只匯出這些資料庫連線 id。
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// 只匯出這些 SSH 主機 id。
    #[serde(default)]
    pub ssh_ids: Option<Vec<String>>,
    /// 只匯出這些遠端桌面 id。
    #[serde(default)]
    pub rd_ids: Option<Vec<String>>,
    /// 帶資料庫密碼。
    #[serde(default = "yes")]
    pub include_password: bool,
    /// 帶 SSH 密碼與私鑰 passphrase（資料庫連線的 SSH 通道與側欄的 SSH 主機都算）。
    #[serde(default = "yes")]
    pub include_ssh: bool,
    /// 帶 OTP secret。
    #[serde(default = "yes")]
    pub include_otp: bool,
    /// 帶遠端桌面密碼。
    #[serde(default = "yes")]
    pub include_rd: bool,
    /// 帶側欄群組（群組 / 資料夾定義 + 各項目的歸屬）；false = 匯入端一律視為未分組。
    #[serde(default = "yes")]
    pub include_groups: bool,
}

impl Default for ExportScope {
    fn default() -> Self {
        Self {
            ids: None,
            ssh_ids: None,
            rd_ids: None,
            include_password: true,
            include_ssh: true,
            include_otp: true,
            include_rd: true,
            include_groups: true,
        }
    }
}

/// 匯出結果統計。`count` = 資料庫連線數；`redacted` = 因 PROD 硬規則被抹掉帳號與機密的筆數
/// （回前端提示用）；`groups` = 一併帶出的群組 / 資料夾數；`ssh` / `rd` = SSH 主機與遠端桌面數。
#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct ExportSummary {
    pub count: usize,
    pub redacted: usize,
    pub groups: usize,
    pub ssh: usize,
    pub rd: usize,
}

impl ExportSummary {
    /// 全部項目數（資料庫連線 + SSH 主機 + 遠端桌面）。
    pub fn total(&self) -> usize {
        self.count + self.ssh + self.rd
    }
}

/// 匯入結果統計（回前端提示用）。`count` = 資料庫連線數；`groups_added` = 本機新增的群組 /
/// 資料夾數；`ssh` / `rd` = SSH 主機與遠端桌面數。
/// `prod_without_credentials` = 匯入後本機仍沒有帳號的 PROD 連線數 —— 這些要先補帳密才連得上。
#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct ImportSummary {
    pub count: usize,
    pub groups_added: usize,
    pub prod_without_credentials: usize,
    pub ssh: usize,
    pub rd: usize,
}

/// 此連線是否標記為正式環境。
pub fn is_prod(c: &PersistedConnection) -> bool {
    c.options.get("prod").map(|v| v == "1").unwrap_or(false)
}

/// `ids` 範圍內是否包含 `id`（`None` = 全部）。
fn picked(ids: &Option<Vec<String>>, id: &str) -> bool {
    ids.as_ref().map_or(true, |ids| ids.iter().any(|x| x == id))
}

/// 機密從 keychain 取；沒勾的類別連讀都不讀。
fn kc(account: String, allowed: bool) -> String {
    if allowed {
        store::kc_get(&account).unwrap_or_default()
    } else {
        String::new()
    }
}

/// 依 `scope` 挑出要匯出的資料庫連線，並套用機密政策（含 PROD 硬規則）。
/// 機密逐筆從 keychain 取；沒勾的類別連讀都不讀。SSH 主機 / 遠端桌面由 `add_ssh` / `add_rd` 另外加。
///
/// 群組只帶「有被匯出連線引用」的那些（保持側欄順序）：空群組在匯出檔裡沒有意義，
/// 只匯出部分連線時也不該把無關的群組名稱一起搬出去。
pub fn build(
    conns: Vec<PersistedConnection>,
    groups: Vec<ConnGroup>,
    scope: &ExportScope,
) -> (ExportFile, ExportSummary) {
    let mut redacted = 0usize;
    let exported: Vec<ExportedConn> = conns
        .into_iter()
        .filter(|c| picked(&scope.ids, &c.id))
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
    let groups: Vec<ConnGroup> = if scope.include_groups {
        groups
            .into_iter()
            .filter(|g| exported.iter().any(|e| e.base.group_id.as_deref() == Some(g.id.as_str())))
            .collect()
    } else {
        Vec::new()
    };
    let count = exported.len();
    let summary = ExportSummary { count, redacted, groups: groups.len(), ..Default::default() };
    (ExportFile { groups, connections: exported, ..Default::default() }, summary)
}

/// 被匯出項目用到的資料夾 + 它們的上層（保持側欄順序）。少了上層，巢狀資料夾到匯入端會變成孤兒。
fn used_folders<F>(
    folders: Vec<F>,
    used: impl Iterator<Item = String>,
    id_of: impl Fn(&F) -> &str,
    parent_of: impl Fn(&F) -> Option<&str>,
) -> Vec<F> {
    let mut keep = std::collections::HashSet::new();
    for mut cur in used {
        // insert 失敗 = 這條鏈已走過（或資料夾互指成環），停。
        while keep.insert(cur.clone()) {
            match folders.iter().find(|f| id_of(f) == cur).and_then(|f| parent_of(f)) {
                Some(p) => cur = p.to_string(),
                None => break,
            }
        }
    }
    folders.into_iter().filter(|f| keep.contains(id_of(f))).collect()
}

/// 把側欄的 SSH 主機加進匯出檔（範圍 `scope.ssh_ids`，機密依 `include_ssh`）。
pub fn add_ssh(out: &mut ExportFile, summary: &mut ExportSummary, src: SshSessionsFile, scope: &ExportScope) {
    out.ssh_hosts = src
        .sessions
        .into_iter()
        .filter(|s| picked(&scope.ssh_ids, &s.id))
        .map(|mut s| {
            if !scope.include_groups {
                s.folder_id = None;
            }
            ExportedSsh {
                password: kc(ssh_sessions::session_password_account(&s.id), scope.include_ssh),
                passphrase: kc(ssh_sessions::session_passphrase_account(&s.id), scope.include_ssh),
                base: s,
            }
        })
        .collect();
    out.ssh_folders = if scope.include_groups {
        let used = out.ssh_hosts.iter().filter_map(|h| h.base.folder_id.clone());
        used_folders(src.folders, used, |f| f.id.as_str(), |f| f.parent_id.as_deref())
    } else {
        Vec::new()
    };
    summary.ssh = out.ssh_hosts.len();
    summary.groups += out.ssh_folders.len();
}

/// 把側欄的遠端桌面加進匯出檔（範圍 `scope.rd_ids`，密碼依 `include_rd`）。
pub fn add_rd(out: &mut ExportFile, summary: &mut ExportSummary, src: RdSessionsFile, scope: &ExportScope) {
    out.rd_hosts = src
        .sessions
        .into_iter()
        .filter(|s| picked(&scope.rd_ids, &s.id))
        .map(|mut s| {
            if !scope.include_groups {
                s.folder_id = None;
            }
            ExportedRd { password: kc(rd_sessions::session_password_account(&s.id), scope.include_rd), base: s }
        })
        .collect();
    out.rd_folders = if scope.include_groups {
        let used = out.rd_hosts.iter().filter_map(|h| h.base.folder_id.clone());
        used_folders(src.folders, used, |f| f.id.as_str(), |f| f.parent_id.as_deref())
    } else {
        Vec::new()
    };
    summary.rd = out.rd_hosts.len();
    summary.groups += out.rd_folders.len();
}

/// 匯出全部三類（資料庫連線 + SSH 主機 + 遠端桌面），GUI 與 CLI 共用。
/// `dir` = 設定目錄（`ssh_sessions.json` / `remote_desktops.json` 所在處）。
pub async fn build_all(
    dir: &std::path::Path,
    conns: Vec<PersistedConnection>,
    groups: Vec<ConnGroup>,
    scope: &ExportScope,
) -> AppResult<(ExportFile, ExportSummary)> {
    let (mut file, mut summary) = build(conns, groups, scope);
    add_ssh(&mut file, &mut summary, ssh_sessions::load_in(dir).await?, scope);
    add_rd(&mut file, &mut summary, rd_sessions::load_in(dir).await?, scope);
    Ok((file, summary))
}

/// 匯入檔的 SSH 主機 / 遠端桌面寫回本機：機密進 keychain（空值 = 這次沒帶，保留本機既有的），
/// 主機與資料夾合併寫檔（`ssh::sessions::import_in` / `rd::sessions::import_in`）。回傳新增的資料夾數。
pub async fn import_hosts(
    dir: &std::path::Path,
    ssh_folders: Vec<SshFolder>,
    ssh_hosts: Vec<ExportedSsh>,
    rd_folders: Vec<RdFolder>,
    rd_hosts: Vec<ExportedRd>,
) -> AppResult<usize> {
    let mut added = 0;
    if !ssh_hosts.is_empty() {
        let mut sessions = Vec::with_capacity(ssh_hosts.len());
        for h in ssh_hosts {
            if !h.password.is_empty() {
                store::kc_set(&ssh_sessions::session_password_account(&h.base.id), &h.password)?;
            }
            if !h.passphrase.is_empty() {
                store::kc_set(&ssh_sessions::session_passphrase_account(&h.base.id), &h.passphrase)?;
            }
            sessions.push(h.base);
        }
        added += ssh_sessions::import_in(dir, ssh_folders, sessions).await?;
    }
    if !rd_hosts.is_empty() {
        let mut sessions = Vec::with_capacity(rd_hosts.len());
        for h in rd_hosts {
            if !h.password.is_empty() {
                store::kc_set(&rd_sessions::session_password_account(&h.base.id), &h.password)?;
            }
            sessions.push(h.base);
        }
        added += rd_sessions::import_in(dir, rd_folders, sessions).await?;
    }
    Ok(added)
}

/// 解析解密後的明文：先試 v2 物件，再退回 v1 純陣列（讀成沒有群組）。兩種都不是 → `None`。
pub fn parse(plain: &[u8]) -> Option<ExportFile> {
    if let Ok(f) = serde_json::from_slice::<ExportFile>(plain) {
        return Some(f);
    }
    serde_json::from_slice::<Vec<ExportedConn>>(plain)
        .ok()
        .map(|connections| ExportFile { connections, ..Default::default() })
}

/// 序列化 → 以 passphrase 加密 → 寫檔（GUI / CLI 共用尾段）。
pub async fn write_encrypted(path: &str, passphrase: &str, file: &ExportFile) -> AppResult<()> {
    let plain = serde_json::to_vec(file)
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

    fn group(id: &str) -> ConnGroup {
        ConnGroup { id: id.into(), name: id.to_uppercase(), kind: None }
    }

    #[test]
    fn exports_only_selected_ids() {
        let scope = ExportScope {
            ids: Some(vec!["b".into()]),
            ..Default::default()
        };
        let (out, sum) = build(vec![conn("a", false), conn("b", false)], vec![], &scope);
        assert_eq!(sum.count, 1);
        assert_eq!(out.connections[0].base.id, "b");
    }

    /// `None` = 全部；空陣列 = 一個都不要（只勾 SSH 主機時，資料庫連線不能因此變成「全部」）。
    #[test]
    fn missing_ids_export_all_but_empty_ids_export_none() {
        let (_, sum) = build(vec![conn("a", false), conn("b", false)], vec![], &ExportScope::default());
        assert_eq!(sum.count, 2);
        let scope = ExportScope { ids: Some(vec![]), ..Default::default() };
        let (_, sum) = build(vec![conn("a", false), conn("b", false)], vec![], &scope);
        assert_eq!(sum.count, 0);
    }

    #[test]
    fn prod_never_carries_credentials() {
        // 三個 include_* 全開，PROD 仍必須空手而回 —— 這是本模組唯一不可覆寫的規則。
        let (out, sum) = build(vec![conn("p", true)], vec![], &ExportScope::default());
        assert_eq!(sum.redacted, 1);
        let e = &out.connections[0];
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
        let (_, sum) = build(vec![conn("a", false), conn("p", true)], vec![], &ExportScope::default());
        assert_eq!(sum.count, 2);
        assert_eq!(sum.redacted, 1);
    }

    #[test]
    fn include_groups_false_clears_group_id_and_groups() {
        let scope = ExportScope { include_groups: false, ..Default::default() };
        let (out, sum) = build(vec![conn("a", false)], vec![group("g1")], &scope);
        assert_eq!(out.connections[0].base.group_id, None);
        assert!(out.groups.is_empty());
        assert_eq!(sum.groups, 0);
        let (kept, sum) = build(vec![conn("a", false)], vec![group("g1")], &ExportScope::default());
        assert_eq!(kept.connections[0].base.group_id.as_deref(), Some("g1"));
        assert_eq!(kept.groups.len(), 1);
        assert_eq!(sum.groups, 1);
    }

    /// 只帶被匯出連線引用到的群組：空群組、以及只被「沒選到的連線」用到的群組都不出去。
    #[test]
    fn only_referenced_groups_are_exported() {
        let mut b = conn("b", false);
        b.group_id = Some("g2".into());
        let scope = ExportScope { ids: Some(vec!["a".into()]), ..Default::default() };
        let (out, _) = build(
            vec![conn("a", false), b],
            vec![group("g1"), group("g2"), group("empty")],
            &scope,
        );
        assert_eq!(out.groups.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), ["g1"]);
    }

    /// PROD 連線抹掉帳密，但群組歸屬照常帶出（群組不是機密）。
    #[test]
    fn prod_keeps_group() {
        let (out, _) = build(vec![conn("p", true)], vec![group("g1")], &ExportScope::default());
        assert_eq!(out.connections[0].base.group_id.as_deref(), Some("g1"));
        assert_eq!(out.groups.len(), 1);
    }

    #[test]
    fn parse_accepts_v2_object_and_v1_array() {
        let (file, _) = build(vec![conn("a", false)], vec![group("g1")], &ExportScope::default());
        let v2 = serde_json::to_vec(&file).unwrap();
        let parsed = parse(&v2).expect("v2 應可解析");
        assert_eq!(parsed.groups.len(), 1);
        assert_eq!(parsed.connections.len(), 1);

        let v1 = serde_json::to_vec(&file.connections).unwrap();
        let parsed = parse(&v1).expect("v1 陣列應可解析");
        assert!(parsed.groups.is_empty(), "v1 沒有群組定義");
        assert_eq!(parsed.connections[0].base.id, "a");

        assert!(parse(b"\"nope\"").is_none());
        assert!(parse(b"42").is_none());
    }

    fn ssh_host(id: &str, folder: Option<&str>) -> SshSession {
        SshSession {
            id: id.into(),
            name: id.to_uppercase(),
            host: format!("{id}.example"),
            port: 22,
            username: "deploy".into(),
            auth: Default::default(),
            private_key_path: String::new(),
            certificate_path: String::new(),
            jump_session_id: None,
            folder_id: folder.map(Into::into),
            options: Default::default(),
            protocol: Default::default(),
            ftp: Default::default(),
        }
    }

    fn rd_host(id: &str, folder: Option<&str>) -> RdSession {
        RdSession {
            id: id.into(),
            name: id.to_uppercase(),
            protocol: Default::default(),
            host: format!("{id}.example"),
            port: 0,
            username: "admin".into(),
            domain: String::new(),
            via_ssh_session_id: None,
            folder_id: folder.map(Into::into),
            options: Default::default(),
        }
    }

    fn ssh_folder(id: &str, parent: Option<&str>) -> SshFolder {
        SshFolder { id: id.into(), name: id.to_uppercase(), parent_id: parent.map(Into::into) }
    }

    /// SSH 主機：只帶選到的；資料夾只帶用到的 + 上層（巢狀），空資料夾 / 別人的資料夾不出去。
    #[test]
    fn ssh_hosts_follow_scope_and_carry_folder_chain() {
        let src = SshSessionsFile {
            folders: vec![ssh_folder("root", None), ssh_folder("child", Some("root")), ssh_folder("other", None)],
            sessions: vec![ssh_host("a", Some("child")), ssh_host("b", Some("other")), ssh_host("c", None)],
            ..Default::default()
        };
        let scope = ExportScope { ssh_ids: Some(vec!["a".into(), "c".into()]), ..Default::default() };
        let (mut out, mut sum) = build(vec![], vec![], &scope);
        add_ssh(&mut out, &mut sum, src, &scope);
        assert_eq!(out.ssh_hosts.iter().map(|h| h.base.id.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!(out.ssh_folders.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["root", "child"]);
        assert_eq!((sum.ssh, sum.groups, sum.total()), (2, 2, 2));
    }

    /// 沒勾群組：主機的資料夾歸屬清掉、不帶資料夾；`Some(空陣列)` = 一台都不帶。
    #[test]
    fn hosts_without_groups_and_empty_scope() {
        let scope = ExportScope { include_groups: false, rd_ids: Some(vec![]), ..Default::default() };
        let (mut out, mut sum) = build(vec![], vec![], &scope);
        let ssh = SshSessionsFile {
            folders: vec![ssh_folder("f", None)],
            sessions: vec![ssh_host("a", Some("f"))],
            ..Default::default()
        };
        let rd = RdSessionsFile { sessions: vec![rd_host("r", None)], ..Default::default() };
        add_ssh(&mut out, &mut sum, ssh, &scope);
        add_rd(&mut out, &mut sum, rd, &scope);
        assert_eq!(out.ssh_hosts[0].base.folder_id, None);
        assert!(out.ssh_folders.is_empty());
        assert!(out.rd_hosts.is_empty(), "rd_ids = [] → 不帶遠端桌面");
        assert_eq!((sum.ssh, sum.rd, sum.groups), (1, 0, 0));
    }

    /// 機密沒勾就不帶（連 keychain 都不讀）。
    #[test]
    fn host_secrets_respect_flags() {
        let scope = ExportScope { include_ssh: false, include_rd: false, ..Default::default() };
        let (mut out, mut sum) = build(vec![], vec![], &scope);
        add_ssh(&mut out, &mut sum, SshSessionsFile { sessions: vec![ssh_host("a", None)], ..Default::default() }, &scope);
        add_rd(&mut out, &mut sum, RdSessionsFile { sessions: vec![rd_host("r", None)], ..Default::default() }, &scope);
        assert_eq!((out.ssh_hosts[0].password.as_str(), out.ssh_hosts[0].passphrase.as_str()), ("", ""));
        assert_eq!(out.rd_hosts[0].password, "");
    }

    /// 含主機的匯出檔能原樣解析回來；沒有主機欄位的舊 v2 檔讀成「沒有主機」。
    #[test]
    fn parse_roundtrips_hosts_and_reads_old_v2_without_them() {
        let (mut file, mut sum) = build(vec![conn("a", false)], vec![], &ExportScope::default());
        add_rd(&mut file, &mut sum, RdSessionsFile { sessions: vec![rd_host("r", None)], ..Default::default() }, &ExportScope::default());
        file.rd_hosts[0].password = "pw".into();
        let parsed = parse(&serde_json::to_vec(&file).unwrap()).expect("新檔應可解析");
        assert_eq!(parsed.rd_hosts.len(), 1);
        assert_eq!(parsed.rd_hosts[0].base.host, "r.example");
        assert_eq!(parsed.rd_hosts[0].password, "pw");

        let old = serde_json::json!({ "groups": [], "connections": serde_json::to_value(&file.connections).unwrap() });
        let parsed = parse(old.to_string().as_bytes()).expect("舊 v2 應可解析");
        assert_eq!(parsed.connections.len(), 1);
        assert!(parsed.ssh_hosts.is_empty() && parsed.rd_hosts.is_empty());
    }
}
