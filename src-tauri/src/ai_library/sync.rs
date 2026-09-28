//! 把資源庫的人設與技能同步到 Claude Code / Codex，讓同一批 DBA 人設在 db-kit 之外也能用：
//! `claude --agent dba-prod-gatekeeper`、Codex 的 `$lock-risk`。
//!
//! | 目標 | 寫入 |
//! |---|---|
//! | Claude Code 使用者層 | `$CLAUDE_CONFIG_DIR` 或 `~/.claude`：`agents/<名>.md`、`skills/<名>/SKILL.md` |
//! | Codex 使用者層 | `~/.agents/skills/<名>/SKILL.md`；`$CODEX_HOME` 或 `~/.codex`：`agents/<名>.toml` |
//! | 專案資料夾（選用） | `<dir>/.claude/agents`、`<dir>/.claude/skills`、`<dir>/.agents/skills`、`<dir>/.codex/agents` |
//!
//! **絕不覆蓋使用者自己的檔案**：`<設定目錄>/ai-library-sync.json` 記下每個我們寫過的檔案的雜湊。
//! 檔案不存在、或內容仍是上次寫入的那一份 → 可以建立 / 更新；其餘一律列為衝突並略過。
//! 資源庫刪掉的項目，只刪內容沒被動過的受管檔。一律先產生計畫（dry-run），確認後才寫入。
//!
//! 只同步 agents 與 skills：prompts / contracts 是 db-kit 專屬（變數由 db-kit 的上下文提供者產生），
//! 放到外部工具裡沒有意義。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::frontmatter::{field_list, field_str, quote_scalar};
use super::library::{resolve, Kind, Library};
use super::settings::AiLibrarySettings;

pub const MANIFEST_FILE: &str = "ai-library-sync.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Manifest {
    /// 絕對路徑 → 上次寫入內容的 md5（hex）。
    pub files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Create,
    Update,
    Unchanged,
    Conflict,
    Delete,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanItem {
    pub target: String,
    pub path: String,
    pub action: Action,
    /// 來源：`agent:dba-senior` / `skill:lock-risk`（刪除時為舊檔對應的來源，可能為空）。
    pub source: String,
    #[serde(skip)]
    content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncPlan {
    pub items: Vec<PlanItem>,
    /// 同步過去的人設用 `mcp__dbkit__*` 工具時，要先把 `dbk mcp` 註冊到該工具。
    pub mcp_hint: String,
}

fn md5_hex(s: &str) -> String {
    use md5::{Digest, Md5};
    let d = Md5::digest(s.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

struct Target {
    label: String,
    claude: Option<PathBuf>,
    agents_skills: Option<PathBuf>,
    codex: Option<PathBuf>,
}

fn targets(s: &AiLibrarySettings, config_dir: &Path) -> Vec<Target> {
    let home = dirs::home_dir();
    let mut v = Vec::new();
    if s.sync.claude_user {
        if let Some(dir) = env_dir("CLAUDE_CONFIG_DIR").or_else(|| home.as_ref().map(|h| h.join(".claude"))) {
            v.push(Target { label: "Claude Code".into(), claude: Some(dir), agents_skills: None, codex: None });
        }
    }
    if s.sync.codex_user {
        v.push(Target {
            label: "Codex".into(),
            claude: None,
            agents_skills: home.as_ref().map(|h| h.join(".agents").join("skills")),
            codex: env_dir("CODEX_HOME").or_else(|| home.as_ref().map(|h| h.join(".codex"))),
        });
    }
    for p in &s.sync.project_dirs {
        if p.trim().is_empty() {
            continue;
        }
        let root = super::settings::resolve_dir(config_dir, p);
        v.push(Target {
            label: tf!("專案 {dir}", dir = root.display()),
            claude: Some(root.join(".claude")),
            agents_skills: Some(root.join(".agents").join("skills")),
            codex: Some(root.join(".codex")),
        });
    }
    v
}

/// `include` 過濾：空 = 全部；支援結尾 `*`。
fn included(s: &AiLibrarySettings, name: &str) -> bool {
    if s.sync.include.is_empty() {
        return true;
    }
    s.sync.include.iter().any(|p| match p.trim().strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => p.trim() == name,
    })
}

const MANAGED_NOTE_MD: &str = "# 由 db-kit 的 AI 資源庫同步產生。請在 db-kit 裡修改後重新同步；直接改這個檔，下次同步會跳過它。";

/// Claude Code subagent 檔：保留 Claude Code 認得的欄位，去掉 db-kit 專屬的 `dbkit-*`。
fn claude_agent_md(lib: &Library, name: &str, lang: &str) -> Option<String> {
    let e = lib.find(Kind::Agent, name)?;
    let r = resolve(e, lang);
    let mut fm = vec![MANAGED_NOTE_MD.to_string(), format!("name: {}", e.name)];
    fm.push(format!("description: {}", quote_scalar(field_str(&r.fields, "description").unwrap_or_default().trim())));
    let tools = field_list(&r.fields, "tools");
    if !tools.is_empty() {
        fm.push(format!("tools: {}", tools.join(", ")));
    }
    for k in ["model", "maxTurns", "permissionMode", "effort", "color"] {
        if let Some(v) = field_str(&r.fields, k).filter(|v| !v.trim().is_empty()) {
            fm.push(format!("{k}: {}", quote_scalar(v.trim())));
        }
    }
    let skills = field_list(&r.fields, "skills");
    if !skills.is_empty() {
        fm.push(format!("skills: [{}]", skills.join(", ")));
    }
    Some(format!("---\n{}\n---\n{}\n", fm.join("\n"), r.body))
}

fn skill_md(lib: &Library, name: &str, lang: &str) -> Option<String> {
    let e = lib.find(Kind::Skill, name)?;
    let r = resolve(e, lang);
    let desc = field_str(&r.fields, "description").unwrap_or_default();
    Some(format!("---\n{MANAGED_NOTE_MD}\nname: {}\ndescription: {}\n---\n{}\n", e.name, quote_scalar(desc.trim()), r.body))
}

/// TOML 字串：內容沒有 `'''` 就用多行字面字串（不需跳脫、最好讀），否則退回跳脫過的一般字串。
fn toml_text(s: &str) -> String {
    if !s.contains("'''") && !s.ends_with('\'') {
        return format!("'''\n{s}'''");
    }
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn toml_line(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Codex 自訂 agent（`.toml`）：Codex 的 agent 沒有「預載技能」，所以把技能本文併進 developer_instructions。
fn codex_agent_toml(lib: &Library, name: &str, lang: &str) -> Option<String> {
    let e = lib.find(Kind::Agent, name)?;
    let r = resolve(e, lang);
    let instructions = lib.persona_system(Some(name), lang, &[], &[]);
    let desc = field_str(&r.fields, "description").unwrap_or_default();
    Some(format!(
        "# 由 db-kit 的 AI 資源庫同步產生。請在 db-kit 裡修改後重新同步；直接改這個檔，下次同步會跳過它。\nname = {}\ndescription = {}\nsandbox_mode = \"read-only\"\ndeveloper_instructions = {}\n",
        toml_line(&e.name),
        toml_line(desc.trim()),
        toml_text(&format!("{instructions}\n")),
    ))
}

pub fn load_manifest(config_dir: &Path) -> Manifest {
    std::fs::read(config_dir.join(MANIFEST_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_manifest(config_dir: &Path, m: &Manifest) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let tmp = config_dir.join(format!("{MANIFEST_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(m).map_err(std::io::Error::other)?)?;
    std::fs::rename(tmp, config_dir.join(MANIFEST_FILE))
}

/// 預設同步哪些：所有 DBA（及其他非 `assistant` 角色）人設 + 所有技能；`include` 另外過濾。
fn sync_sources(lib: &Library, s: &AiLibrarySettings) -> (Vec<String>, Vec<String>) {
    let agents = lib
        .of_kind(Kind::Agent)
        .filter(|e| field_str(&e.variants[""].fields, "dbkit-role").as_deref() != Some("assistant") || !s.sync.include.is_empty())
        .filter(|e| included(s, &e.name))
        .map(|e| e.name.clone())
        .collect();
    let skills = lib.of_kind(Kind::Skill).filter(|e| included(s, &e.name)).map(|e| e.name.clone()).collect();
    (agents, skills)
}

/// 產生同步計畫（不寫任何檔案）。
pub fn plan(lib: &Library, s: &AiLibrarySettings, config_dir: &Path, lang: &str) -> SyncPlan {
    let manifest = load_manifest(config_dir);
    let (agents, skills) = sync_sources(lib, s);
    let mut outputs: Vec<(String, PathBuf, String, String)> = Vec::new(); // (target, path, source, content)
    for t in targets(s, config_dir) {
        if let Some(c) = &t.claude {
            for a in &agents {
                if let Some(txt) = claude_agent_md(lib, a, lang) {
                    outputs.push((t.label.clone(), c.join("agents").join(format!("{a}.md")), format!("agent:{a}"), txt));
                }
            }
            for sk in &skills {
                if let Some(txt) = skill_md(lib, sk, lang) {
                    outputs.push((t.label.clone(), c.join("skills").join(sk).join("SKILL.md"), format!("skill:{sk}"), txt));
                }
            }
        }
        if let Some(d) = &t.agents_skills {
            for sk in &skills {
                if let Some(txt) = skill_md(lib, sk, lang) {
                    outputs.push((t.label.clone(), d.join(sk).join("SKILL.md"), format!("skill:{sk}"), txt));
                }
            }
        }
        if let Some(c) = &t.codex {
            for a in &agents {
                if let Some(txt) = codex_agent_toml(lib, a, lang) {
                    outputs.push((t.label.clone(), c.join("agents").join(format!("{a}.toml")), format!("agent:{a}"), txt));
                }
            }
        }
    }
    let mut items = Vec::new();
    let mut planned: Vec<String> = Vec::new();
    for (target, path, source, content) in outputs {
        let key = path.to_string_lossy().to_string();
        if planned.contains(&key) {
            continue;
        }
        planned.push(key.clone());
        let action = match std::fs::read_to_string(&path) {
            Err(_) => Action::Create,
            Ok(cur) if cur == content => Action::Unchanged,
            Ok(cur) if manifest.files.get(&key) == Some(&md5_hex(&cur)) => Action::Update,
            Ok(_) => Action::Conflict,
        };
        items.push(PlanItem { target, path: key, action, source, content });
    }
    // 上次寫過、這次不再產生的受管檔：內容沒被動過才刪。
    for (p, hash) in &manifest.files {
        if planned.contains(p) {
            continue;
        }
        if let Ok(cur) = std::fs::read_to_string(p) {
            if &md5_hex(&cur) == hash {
                items.push(PlanItem { target: String::new(), path: p.clone(), action: Action::Delete, source: String::new(), content: String::new() });
            }
        }
    }
    SyncPlan {
        items,
        mcp_hint: t!("同步過去的 DBA 人設使用 mcp__dbkit__* 資料庫工具。要在 Claude Code / Codex 裡直接使用，先把 dbk 的 MCP 伺服器註冊進去：Claude Code 執行 `claude mcp add dbkit -- dbk --conn <連線名稱> mcp`；Codex 在 ~/.codex/config.toml 加上 [mcp_servers.dbkit]，command = \"dbk\"、args = [\"--conn\", \"<連線名稱>\", \"mcp\"]。").into(),
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncReport {
    pub written: usize,
    pub deleted: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// 依計畫寫入（衝突與未變更的略過），並更新雜湊清單。
pub fn apply(plan: &SyncPlan, config_dir: &Path) -> SyncReport {
    let mut manifest = load_manifest(config_dir);
    let mut rep = SyncReport::default();
    for it in &plan.items {
        let path = Path::new(&it.path);
        match it.action {
            Action::Create | Action::Update => {
                let res = path
                    .parent()
                    .map(std::fs::create_dir_all)
                    .transpose()
                    .and_then(|_| std::fs::write(path, &it.content));
                match res {
                    Ok(_) => {
                        manifest.files.insert(it.path.clone(), md5_hex(&it.content));
                        rep.written += 1;
                    }
                    Err(e) => rep.errors.push(format!("{}: {e}", it.path)),
                }
            }
            Action::Unchanged => {
                manifest.files.insert(it.path.clone(), md5_hex(&it.content));
            }
            Action::Delete => match std::fs::remove_file(path) {
                Ok(_) => {
                    manifest.files.remove(&it.path);
                    // 技能資料夾空了就一併移除（只移除空資料夾）。
                    if path.file_name().is_some_and(|n| n == "SKILL.md") {
                        if let Some(d) = path.parent() {
                            let _ = std::fs::remove_dir(d);
                        }
                    }
                    rep.deleted += 1;
                }
                Err(e) => rep.errors.push(format!("{}: {e}", it.path)),
            },
            Action::Conflict => rep.skipped += 1,
        }
    }
    if let Err(e) = save_manifest(config_dir, &manifest) {
        rep.errors.push(format!("{MANIFEST_FILE}: {e}"));
    }
    rep
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_library::library::Layer;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbkit-ailib-sync-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn settings_for(project: &Path) -> AiLibrarySettings {
        let mut s = AiLibrarySettings::default();
        s.sync.claude_user = false;
        s.sync.codex_user = false;
        s.sync.project_dirs = vec![project.to_string_lossy().to_string()];
        s.sync.include = vec!["dba-prod-*".into(), "lock-risk".into(), "online-ddl".into()];
        s
    }

    #[test]
    fn plan_apply_conflict_and_delete() {
        let cfg = tmp("cfg");
        let proj = tmp("proj");
        let lib = Library::load(&[Layer::builtin()]);
        let s = settings_for(&proj);

        let p = plan(&lib, &s, &cfg, "zh-TW");
        let paths: Vec<&str> = p.items.iter().map(|i| i.path.as_str()).collect();
        assert!(p.items.iter().all(|i| i.action == Action::Create), "{paths:#?}");
        let agent_md = proj.join(".claude").join("agents").join("dba-prod-gatekeeper.md");
        let codex_toml = proj.join(".codex").join("agents").join("dba-prod-gatekeeper.toml");
        assert!(paths.contains(&agent_md.to_string_lossy().as_ref()));
        assert!(paths.contains(&codex_toml.to_string_lossy().as_ref()));
        assert!(paths.contains(&proj.join(".agents").join("skills").join("lock-risk").join("SKILL.md").to_string_lossy().as_ref()));

        let rep = apply(&p, &cfg);
        assert_eq!(rep.written, p.items.len());
        let md = std::fs::read_to_string(&agent_md).unwrap();
        assert!(md.contains("tools: mcp__dbkit__list_databases"));
        assert!(!md.contains("dbkit-"), "{md}");
        let toml = std::fs::read_to_string(&codex_toml).unwrap();
        assert!(toml.contains("developer_instructions = '''"));
        assert!(toml.contains("[技能：鎖與併發風險]"));

        // 第二次：全部未變更。使用者手改一個檔 → 衝突，不覆蓋。
        std::fs::write(&agent_md, "我自己改的").unwrap();
        let p2 = plan(&lib, &s, &cfg, "zh-TW");
        let act = |path: &Path| p2.items.iter().find(|i| i.path == path.to_string_lossy()).unwrap().action;
        assert_eq!(act(&agent_md), Action::Conflict);
        assert_eq!(act(&codex_toml), Action::Unchanged);
        let rep2 = apply(&p2, &cfg);
        assert_eq!(rep2.skipped, 1);
        assert_eq!(std::fs::read_to_string(&agent_md).unwrap(), "我自己改的");

        // 縮小同步範圍 → 不再產生的受管檔被刪；被手改過的那個不在清單裡的刪除條件內。
        let mut s3 = s.clone();
        s3.sync.include = vec!["lock-risk".into()];
        let p3 = plan(&lib, &s3, &cfg, "zh-TW");
        assert!(p3.items.iter().any(|i| i.action == Action::Delete && i.path == codex_toml.to_string_lossy()));
        assert!(!p3.items.iter().any(|i| i.action == Action::Delete && i.path == agent_md.to_string_lossy()));
        apply(&p3, &cfg);
        assert!(!codex_toml.exists());
        assert!(agent_md.exists());
        let _ = std::fs::remove_dir_all(cfg);
        let _ = std::fs::remove_dir_all(proj);
    }

    #[test]
    fn toml_strings_escape_safely() {
        assert_eq!(toml_text("a\nb\n"), "'''\na\nb\n'''");
        assert_eq!(toml_text("has ''' inside"), "\"has ''' inside\"");
        assert_eq!(toml_line("say \"hi\"\\"), "\"say \\\"hi\\\"\\\\\"");
    }
}
