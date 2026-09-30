//! 已存的比對（比對工作階段）：兩邊來源、模式、資料夾比對的規則與同步規則。
//!
//! 存在設定目錄的 `compare_sessions.json`，GUI 與 `dbk` 共用同一份：GUI 的啟動畫面列出來一鍵重跑，
//! `dbk diff --session <名稱>` / `dbk sync --session <名稱>` 在腳本或排程裡跑同一套設定。
//! 遠端的一邊只記「哪台已存主機 + 路徑」，不記帳密（帳密照主機設定走 keychain）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::diff::{AlignOpts, Criteria};
use crate::error::{AppError, AppResult};

pub const FILE_NAME: &str = "compare_sessions.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "side", rename_all = "snake_case")]
pub enum SessionSide {
    Local { path: String },
    /// `session_id` = 已存的 SSH / SFTP / FTP 主機 id。
    Remote { session_id: String, path: String },
}

/// 同步規則（與前端 `folderCompareModel.ts` 的 `SyncRule` 同名同義）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRule {
    MirrorLr,
    MirrorRl,
    UpdateLr,
    UpdateRl,
    UpdateBoth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FolderSettings {
    pub excludes: Vec<String>,
    pub criteria: Criteria,
    pub tolerance_secs: u64,
    pub ignore_hour_offset: bool,
    pub case_insensitive: bool,
    /// 「同步」預設用的規則；`None` = 每次問。
    pub rule: Option<SyncRule>,
}

impl Default for FolderSettings {
    fn default() -> Self {
        let a = AlignOpts::default();
        Self {
            excludes: vec![".git".into(), "node_modules".into()],
            criteria: a.criteria,
            tolerance_secs: a.tolerance_secs,
            ignore_hour_offset: a.ignore_hour_offset,
            case_insensitive: a.case_insensitive,
            rule: None,
        }
    }
}

impl FolderSettings {
    pub fn align_opts(&self) -> AlignOpts {
        AlignOpts {
            criteria: self.criteria,
            tolerance_secs: self.tolerance_secs,
            ignore_hour_offset: self.ignore_hour_offset,
            case_insensitive: self.case_insensitive,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompareSession {
    pub id: String,
    pub name: String,
    /// "text" / "folder" / "binary"
    pub mode: String,
    pub left: SessionSide,
    pub right: SessionSide,
    #[serde(default)]
    pub folder: FolderSettings,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionsFile {
    pub version: u32,
    pub sessions: Vec<CompareSession>,
}

impl Default for SessionsFile {
    fn default() -> Self {
        Self { version: 1, sessions: Vec::new() }
    }
}

impl SessionsFile {
    /// 依名稱（大小寫不敏感）或 id 找。
    pub fn find(&self, name_or_id: &str) -> Option<&CompareSession> {
        let q = name_or_id.trim();
        self.sessions
            .iter()
            .find(|s| s.id == q)
            .or_else(|| self.sessions.iter().find(|s| s.name.eq_ignore_ascii_case(q)))
            .or_else(|| self.sessions.iter().find(|s| s.name.to_lowercase() == q.to_lowercase()))
    }
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// 讀檔；不存在回空清單。格式壞掉回錯（不要默默當成空的，下次存檔會把使用者的設定整個蓋掉）。
pub async fn load_in(dir: &Path) -> AppResult<SessionsFile> {
    let p = path_in(dir);
    match tokio::fs::read(&p).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| AppError::Storage(tf!("比對工作階段檔案格式錯誤（{path}）：{e}", path = p.display(), e = e))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SessionsFile::default()),
        Err(e) => Err(AppError::Storage(tf!("讀取比對工作階段失敗：{e}", e = e))),
    }
}

/// 寫檔：先寫暫存檔再 rename，寫到一半不會留下半個 JSON。
pub async fn save_in(dir: &Path, file: &SessionsFile) -> AppResult<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::Storage(tf!("建立設定目錄失敗：{e}", e = e)))?;
    let p = path_in(dir);
    let tmp = p.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(file).map_err(|e| AppError::Storage(e.to_string()))?;
    tokio::fs::write(&tmp, json)
        .await
        .map_err(|e| AppError::Storage(tf!("寫入比對工作階段失敗：{e}", e = e)))?;
    tokio::fs::rename(&tmp, &p)
        .await
        .map_err(|e| AppError::Storage(tf!("寫入比對工作階段失敗：{e}", e = e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn roundtrip_and_find() {
        let dir = std::env::temp_dir().join(format!("dbk-cmpsess-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_in(&dir).await.unwrap(), SessionsFile::default());
        let f = SessionsFile {
            version: 1,
            sessions: vec![CompareSession {
                id: "s1".into(),
                name: "Deploy Web".into(),
                mode: "folder".into(),
                left: SessionSide::Local { path: "C:\\site".into() },
                right: SessionSide::Remote { session_id: "h1".into(), path: "/var/www".into() },
                folder: FolderSettings { rule: Some(SyncRule::MirrorLr), ..Default::default() },
                updated_at: 1,
            }],
        };
        save_in(&dir, &f).await.unwrap();
        let back = load_in(&dir).await.unwrap();
        assert_eq!(back, f);
        assert_eq!(back.find("deploy web").unwrap().id, "s1");
        assert_eq!(back.find("s1").unwrap().name, "Deploy Web");
        assert!(back.find("nope").is_none());
        // 前端寫的 JSON（欄位省略）也讀得進來
        let json = r#"{"version":1,"sessions":[{"id":"x","name":"n","mode":"text","left":{"side":"local","path":"a"},"right":{"side":"local","path":"b"}}]}"#;
        let parsed: SessionsFile = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.sessions[0].folder.excludes, vec![".git", "node_modules"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
