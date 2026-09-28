//! `<設定目錄>/ai-library.json`：團隊資料夾、預設人設、會審陣容、同步目標。GUI 與 `dbk` 共用。
//!
//! 刻意與 `app_settings.json` 分開：那份放的是啟動密碼雜湊之類的安全設定，這份是使用者會常改、
//! 也可能想整份交給同事的偏好。讀寫都走同步 std::fs——檔案很小，CLI 與 Tauri 命令都能直接用。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::library::{Layer, Library};

pub const SETTINGS_FILE: &str = "ai-library.json";
/// 個人層資料夾（在設定目錄底下）。
pub const LIBRARY_DIR: &str = "ai-library";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TeamDir {
    pub path: String,
    pub label: String,
    pub writable: bool,
}

impl Default for TeamDir {
    fn default() -> Self {
        TeamDir { path: String::new(), label: String::new(), writable: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SyncSettings {
    /// 同步到 Claude Code 使用者層（`~/.claude/agents`、`~/.claude/skills`）。
    pub claude_user: bool,
    /// 同步到 Codex 使用者層（`~/.agents/skills`、`~/.codex/agents`）。
    pub codex_user: bool,
    /// 另外同步到這些專案資料夾（`<dir>/.claude/…`、`<dir>/.agents/skills`、`<dir>/.codex/agents`）。
    pub project_dirs: Vec<String>,
    /// 只同步這些名稱（支援結尾 `*` 萬用字元，例如 `dba-*`）；空 = 全部人設與技能。
    pub include: Vec<String>,
}

impl Default for SyncSettings {
    fn default() -> Self {
        SyncSettings { claude_user: true, codex_user: true, project_dirs: Vec::new(), include: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AiLibrarySettings {
    pub team_dirs: Vec<TeamDir>,
    /// 助手對話 / 一次性生成用的人設。
    pub assistant_persona: Option<String>,
    /// DBA 審查的預設人設。
    pub dba_persona: Option<String>,
    /// 連線標記為正式環境時的 DBA 人設。
    pub dba_persona_prod: Option<String>,
    /// 「多位 DBA 會審」預設勾選的人設。
    pub panel_personas: Vec<String>,
    /// 助手對話勾選中的技能；None = 尚未從前端 localStorage 遷移。
    pub active_skills: Option<Vec<String>>,
    pub sync: SyncSettings,
    /// 已把舊版 localStorage 的人設 / 技能搬進個人層。
    pub migrated_local_v1: bool,
}

impl Default for AiLibrarySettings {
    fn default() -> Self {
        AiLibrarySettings {
            team_dirs: Vec::new(),
            assistant_persona: Some("assistant".into()),
            dba_persona: Some("dba-senior".into()),
            dba_persona_prod: Some("dba-prod-gatekeeper".into()),
            panel_personas: vec!["dba-performance".into(), "dba-security".into(), "dba-prod-gatekeeper".into()],
            active_skills: None,
            sync: SyncSettings::default(),
            migrated_local_v1: false,
        }
    }
}

impl AiLibrarySettings {
    /// 依連線是否為正式環境挑預設 DBA 人設。
    pub fn dba_persona_for(&self, prod: bool) -> String {
        let pick = if prod { self.dba_persona_prod.as_deref().or(self.dba_persona.as_deref()) } else { self.dba_persona.as_deref() };
        pick.filter(|s| !s.trim().is_empty()).unwrap_or(if prod { "dba-prod-gatekeeper" } else { "dba-senior" }).to_string()
    }
}

/// 讀設定；檔案不存在或解析失敗一律回預設值（壞掉的偏好檔不該讓 AI 功能整個失能）。
pub fn load(config_dir: &Path) -> AiLibrarySettings {
    match std::fs::read(config_dir.join(SETTINGS_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            eprintln!("[ai-library] {SETTINGS_FILE} 解析失敗，改用預設值：{e}");
            AiLibrarySettings::default()
        }),
        Err(_) => AiLibrarySettings::default(),
    }
}

/// 原子寫入：先寫 `.tmp` 再 rename。
pub fn save(config_dir: &Path, s: &AiLibrarySettings) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_dir.join(SETTINGS_FILE);
    let tmp = config_dir.join(format!("{SETTINGS_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(s).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)
}

pub fn personal_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(LIBRARY_DIR)
}

/// 團隊資料夾路徑：相對路徑以設定目錄為基準，`~` 展開成家目錄。
pub fn resolve_dir(config_dir: &Path, raw: &str) -> PathBuf {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    let p = PathBuf::from(raw);
    if p.is_absolute() { p } else { config_dir.join(p) }
}

/// 設定對應的分層：內建 → 個人 → 團隊（依設定順序）。
pub fn layers(config_dir: &Path, s: &AiLibrarySettings) -> Vec<Layer> {
    let mut v = vec![
        Layer::builtin(),
        Layer { id: "personal".into(), label: t!("個人").into(), root: Some(personal_dir(config_dir)), writable: true },
    ];
    for (i, d) in s.team_dirs.iter().enumerate() {
        if d.path.trim().is_empty() {
            continue;
        }
        let label = if d.label.trim().is_empty() { tf!("團隊 {n}", n = i + 1) } else { d.label.trim().to_string() };
        v.push(Layer { id: format!("team:{i}"), label, root: Some(resolve_dir(config_dir, &d.path)), writable: d.writable });
    }
    v
}

/// 讀設定並載入整個資源庫。
pub fn load_library(config_dir: &Path) -> (Library, AiLibrarySettings) {
    let s = load(config_dir);
    let lib = Library::load(&layers(config_dir, &s));
    (lib, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dbkit-ailib-settings-{}", uuid::Uuid::new_v4()));
        assert_eq!(load(&dir), AiLibrarySettings::default());
        let mut s = AiLibrarySettings::default();
        s.team_dirs.push(TeamDir { path: "team".into(), label: "DBA".into(), writable: false });
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
        let ls = layers(&dir, &s);
        assert_eq!(ls.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["builtin", "personal", "team:0"]);
        assert_eq!(ls[2].root.as_deref(), Some(dir.join("team").as_path()));
        assert!(!ls[2].writable);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_fields_and_partial_json_are_tolerated() {
        let dir = std::env::temp_dir().join(format!("dbkit-ailib-settings2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"dba_persona":"dba-mentor","future":1}"#).unwrap();
        let s = load(&dir);
        assert_eq!(s.dba_persona.as_deref(), Some("dba-mentor"));
        assert_eq!(s.dba_persona_prod.as_deref(), Some("dba-prod-gatekeeper"));
        assert_eq!(s.dba_persona_for(false), "dba-mentor");
        assert_eq!(s.dba_persona_for(true), "dba-prod-gatekeeper");
        let _ = std::fs::remove_dir_all(dir);
    }
}
