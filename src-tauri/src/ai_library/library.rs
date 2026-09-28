//! 資源庫的載入與分層：內建（嵌入二進位）< 個人（`<設定目錄>/ai-library/`）< 團隊資料夾（可多個，依序）。
//!
//! - 同種類同 `name` 時後面的層覆蓋前面的層；被蓋掉的留在 `shadowed`，內建版本另存在 `builtin`
//!   供「還原內建」與比對。
//! - 契約（`contracts/`）只認內建層：它是解析器的依賴，使用者改了等於弄壞結論徽章與 `dbk run` 的 STOP 攔截。
//! - 覆蓋內建範本時，任務登錄欄位（`dbkit-mode` / `dbkit-contract` / `dbkit-vars` / `dbkit-required`）
//!   一律改用內建值：覆蓋檔只能換本文，不能改變程式碼與範本之間的契約。
//! - 團隊資料夾同時接受 db-kit 結構（`agents/ skills/ prompts/`）與 Claude Code / Codex 結構
//!   （`.claude/agents/`、`.claude/skills/`、`.agents/skills/`）——團隊 repo 本身就能直接給那兩套工具用。
//!
//! 語言變體（`<名>.<語言>.md`）與前端 `src/aiLibrary.ts` 同一套規則（日 / 韓 / 越 → 英文 → 基底）。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};

use super::builtin;
use super::frontmatter::{self, field_bool, field_list, field_str};
use super::render::{self, Vars};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Agent,
    Skill,
    Prompt,
    Contract,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Agent => "agent",
            Kind::Skill => "skill",
            Kind::Prompt => "prompt",
            Kind::Contract => "contract",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        match s.trim().trim_end_matches('s') {
            "agent" | "persona" => Some(Kind::Agent),
            "skill" => Some(Kind::Skill),
            "prompt" => Some(Kind::Prompt),
            "contract" => Some(Kind::Contract),
            _ => None,
        }
    }
}

/// 支援的語言碼（與前端 `LIB_LANGS` 相同）。
pub const LANGS: &[&str] = &["zh-TW", "zh-CN", "en", "ja", "ko", "vi"];

/// 任務登錄欄位：覆蓋檔一律改用內建值。
pub const REGISTRY_KEYS: &[&str] = &["dbkit-mode", "dbkit-contract", "dbkit-vars", "dbkit-required"];

/// 單一檔案上限：資源庫是提示文字，超過這個大小多半是放錯檔案。
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// 單一層最多掃幾個檔（防呆：團隊資料夾被設成整顆硬碟之類）。
const MAX_FILES_PER_LAYER: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct Variant {
    pub fields: Map<String, Json>,
    pub body: String,
    pub raw: String,
    /// 磁碟路徑；內建為 `builtin:<相對路徑>`。
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub layer: String,
    pub layer_label: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub kind: Kind,
    pub name: String,
    pub layer: String,
    pub layer_label: String,
    pub writable: bool,
    /// 語言變體；`""` = 基底檔。
    pub variants: BTreeMap<String, Variant>,
    pub shadowed: Vec<Source>,
    pub builtin: Option<BTreeMap<String, Variant>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Issue {
    pub level: &'static str,
    pub kind: Option<Kind>,
    pub name: Option<String>,
    pub path: Option<String>,
    pub message: String,
}

impl Issue {
    fn new(level: &'static str, kind: Option<Kind>, name: Option<&str>, path: Option<&str>, message: String) -> Issue {
        Issue { level, kind, name: name.map(str::to_string), path: path.map(str::to_string), message }
    }
}

/// 一層資源庫。`root` 為 None 表示內建。
#[derive(Debug, Clone)]
pub struct Layer {
    pub id: String,
    pub label: String,
    pub root: Option<PathBuf>,
    pub writable: bool,
}

impl Layer {
    pub fn builtin() -> Layer {
        Layer { id: "builtin".into(), label: t!("內建").into(), root: None, writable: false }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Library {
    pub entries: Vec<Entry>,
    pub issues: Vec<Issue>,
}

// ---------------------------------------------------------------------------
// 路徑分類
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Classified {
    pub kind: Kind,
    /// 同一筆資源（基底 + 各語言變體）的分組鍵，例如 `prompts/fix`、`skills/lock-risk`。
    pub group: String,
    /// 變體語言；基底為空字串。
    pub lang: String,
    /// 檔名主幹（技能為資料夾名）。
    pub stem: String,
}

fn split_lang(file: &str) -> (String, String) {
    let base = &file[..file.len() - 3];
    if let Some(dot) = base.rfind('.') {
        let lang = &base[dot + 1..];
        if dot > 0 && LANGS.contains(&lang) {
            return (base[..dot].to_string(), lang.to_string());
        }
    }
    (base.to_string(), String::new())
}

/// 與前端 `classifyPath` 同一套規則。
pub fn classify_path(rel: &str) -> Option<Classified> {
    let p = rel.replace('\\', "/");
    let p = p.trim_start_matches("./");
    let parts: Vec<&str> = p.split('/').collect();
    let file = *parts.last()?;
    if !file.to_ascii_lowercase().ends_with(".md") || file.len() < 4 {
        return None;
    }
    let top = parts[0];
    if top == "skills" {
        if parts.len() != 3 {
            return None;
        }
        let (stem, lang) = split_lang(file);
        if stem != "SKILL" {
            return None;
        }
        return Some(Classified { kind: Kind::Skill, group: format!("skills/{}", parts[1]), lang, stem: parts[1].to_string() });
    }
    let kind = match top {
        "agents" => Kind::Agent,
        "prompts" => Kind::Prompt,
        "contracts" => Kind::Contract,
        _ => return None,
    };
    if parts.len() < 2 || (kind != Kind::Agent && parts.len() != 2) {
        return None;
    }
    let (stem, lang) = split_lang(file);
    Some(Classified { kind, group: format!("{}/{}", parts[..parts.len() - 1].join("/"), stem), lang, stem })
}

// ---------------------------------------------------------------------------
// 讀檔
// ---------------------------------------------------------------------------

/// (規範化相對路徑, 顯示路徑, 內容)
type LayerFile = (String, String, String);

fn walk_md(dir: &Path, rel_prefix: &str, depth: usize, out: &mut Vec<(String, PathBuf)>, budget: &mut usize) {
    if depth > 4 || *budget == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut ents: Vec<_> = rd.flatten().collect();
    ents.sort_by_key(|e| e.file_name());
    for e in ents {
        if *budget == 0 {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = e.path();
        let rel = if rel_prefix.is_empty() { name.clone() } else { format!("{rel_prefix}/{name}") };
        match e.file_type() {
            Ok(ft) if ft.is_dir() => walk_md(&path, &rel, depth + 1, out, budget),
            Ok(ft) if ft.is_file() && name.to_ascii_lowercase().ends_with(".md") => {
                out.push((rel, path));
                *budget -= 1;
            }
            _ => {}
        }
    }
}

fn layer_files(layer: &Layer, issues: &mut Vec<Issue>) -> Vec<LayerFile> {
    let Some(root) = &layer.root else {
        return builtin::FILES.iter().map(|(rel, text)| (rel.to_string(), format!("builtin:{rel}"), frontmatter::normalize(text))).collect();
    };
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    let mut budget = MAX_FILES_PER_LAYER;
    // db-kit 結構 + Claude Code / Codex 結構。後者的 agents / skills 映射到同一套相對路徑。
    for (sub, kinds) in [
        ("", &["agents", "skills", "prompts", "contracts"][..]),
        (".claude", &["agents", "skills"][..]),
        (".agents", &["skills"][..]),
    ] {
        let base = if sub.is_empty() { root.clone() } else { root.join(sub) };
        for k in kinds {
            walk_md(&base.join(k), k, 0, &mut found, &mut budget);
        }
    }
    if budget == 0 {
        issues.push(Issue::new(
            "warn",
            None,
            None,
            Some(&root.to_string_lossy()),
            tf!("檔案超過 {n} 個，其餘未載入", n = MAX_FILES_PER_LAYER),
        ));
    }
    let mut out = Vec::new();
    for (rel, path) in found {
        let shown = path.to_string_lossy().to_string();
        match std::fs::metadata(&path) {
            Ok(m) if m.len() > MAX_FILE_BYTES => {
                issues.push(Issue::new("warn", None, None, Some(&shown), t!("檔案過大（超過 512 KB），已略過").into()));
                continue;
            }
            Err(_) => continue,
            _ => {}
        }
        match std::fs::read(&path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(s) => out.push((rel, shown, frontmatter::normalize(&s))),
                Err(_) => issues.push(Issue::new("warn", None, None, Some(&shown), t!("不是 UTF-8 文字檔，已略過").into())),
            },
            Err(e) => issues.push(Issue::new("warn", None, None, Some(&shown), tf!("讀取失敗：{e}", e = e))),
        }
    }
    out
}

fn entries_from_files(files: Vec<LayerFile>, layer: &Layer, issues: &mut Vec<Issue>) -> Vec<Entry> {
    struct Group {
        kind: Kind,
        stem: String,
        variants: BTreeMap<String, Variant>,
    }
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Group> = HashMap::new();
    for (rel, shown, text) in files {
        let Some(c) = classify_path(&rel) else { continue };
        let doc = frontmatter::parse(&text);
        if !doc.has_frontmatter() && c.kind != Kind::Contract {
            issues.push(Issue::new("warn", Some(c.kind), None, Some(&shown), t!("缺少 frontmatter（--- 包起來的 name / description）").into()));
        }
        let g = groups.entry(c.group.clone()).or_insert_with(|| {
            order.push(c.group.clone());
            Group { kind: c.kind, stem: c.stem.clone(), variants: BTreeMap::new() }
        });
        if g.variants.contains_key(&c.lang) {
            // 同一層兩種結構都放了同一份（例如 skills/x 與 .claude/skills/x）：先掃到的為準。
            issues.push(Issue::new("warn", Some(c.kind), Some(&c.stem), Some(&shown), t!("同一層重複的檔案，已略過").into()));
            continue;
        }
        g.variants.insert(c.lang.clone(), Variant { fields: doc.fields(), body: doc.body(), raw: text, path: shown });
    }
    let mut seen: HashMap<(Kind, String), ()> = HashMap::new();
    let mut out = Vec::new();
    for key in order {
        let g = groups.remove(&key).unwrap();
        let Some(base) = g.variants.get("") else {
            let p = g.variants.values().next().map(|v| v.path.clone());
            issues.push(Issue::new("warn", Some(g.kind), Some(&g.stem), p.as_deref(), t!("只有語言變體、沒有基底檔，已略過").into()));
            continue;
        };
        let name = field_str(&base.fields, "name").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| g.stem.clone());
        if g.kind == Kind::Skill && name != g.stem {
            issues.push(Issue::new(
                "warn",
                Some(g.kind),
                Some(&name),
                Some(&base.path),
                tf!("技能名稱「{name}」與資料夾名稱「{dir}」不同；Agent Skills 標準要求兩者一致", name = name, dir = g.stem),
            ));
        }
        if seen.insert((g.kind, name.clone()), ()).is_some() {
            issues.push(Issue::new("warn", Some(g.kind), Some(&name), Some(&base.path), t!("同一層有兩個同名的項目，後者已略過").into()));
            continue;
        }
        out.push(Entry {
            kind: g.kind,
            name,
            layer: layer.id.clone(),
            layer_label: layer.label.clone(),
            writable: layer.writable,
            variants: g.variants,
            shadowed: Vec::new(),
            builtin: None,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// 載入 + 分層
// ---------------------------------------------------------------------------

impl Library {
    /// 只有內建層（CLI 讀不到設定、或測試用）。
    pub fn builtin_only() -> Library {
        Library::load(&[Layer::builtin()])
    }

    pub fn load(layers: &[Layer]) -> Library {
        let mut issues = Vec::new();
        let mut entries: Vec<Entry> = Vec::new();
        let mut index: HashMap<(Kind, String), usize> = HashMap::new();
        for layer in layers {
            if let Some(root) = &layer.root {
                if !root.is_dir() {
                    if layer.id != "personal" {
                        issues.push(Issue::new("warn", None, None, Some(&root.to_string_lossy()), t!("資料夾不存在").into()));
                    }
                    continue;
                }
            }
            let files = layer_files(layer, &mut issues);
            for e in entries_from_files(files, layer, &mut issues) {
                if e.kind == Kind::Contract && layer.root.is_some() {
                    let p = e.variants.get("").map(|v| v.path.clone());
                    issues.push(Issue::new("warn", Some(Kind::Contract), Some(&e.name), p.as_deref(), t!("輸出契約只認內建版本（解析器依賴它），這個檔案不會生效").into()));
                    continue;
                }
                let key = (e.kind, e.name.clone());
                match index.get(&key) {
                    Some(&i) => {
                        let old = std::mem::replace(&mut entries[i], e);
                        let cur = &mut entries[i];
                        cur.shadowed.push(Source {
                            layer: old.layer.clone(),
                            layer_label: old.layer_label.clone(),
                            path: old.variants.get("").map(|v| v.path.clone()),
                        });
                        cur.shadowed.extend(old.shadowed);
                        cur.builtin = if old.layer == "builtin" { Some(old.variants) } else { old.builtin };
                    }
                    None => {
                        index.insert(key, entries.len());
                        entries.push(e);
                    }
                }
            }
        }
        // 覆蓋內建範本：任務登錄欄位改用內建值。
        for e in entries.iter_mut().filter(|e| e.kind == Kind::Prompt) {
            let Some(b) = e.builtin.as_ref().and_then(|b| b.get("")).map(|v| v.fields.clone()) else { continue };
            if let Some(base) = e.variants.get_mut("") {
                for k in REGISTRY_KEYS {
                    match b.get(*k) {
                        Some(v) => {
                            base.fields.insert(k.to_string(), v.clone());
                        }
                        None => {
                            base.fields.remove(*k);
                        }
                    }
                }
            }
        }
        let mut lib = Library { entries, issues };
        lib.lint();
        lib
    }

    pub fn find(&self, kind: Kind, name: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.kind == kind && e.name == name)
    }

    pub fn of_kind(&self, kind: Kind) -> impl Iterator<Item = &Entry> {
        self.entries.iter().filter(move |e| e.kind == kind)
    }

    fn lint(&mut self) {
        let skill_names: Vec<String> = self.of_kind(Kind::Skill).map(|e| e.name.clone()).collect();
        let mut out = Vec::new();
        for e in &self.entries {
            let base = &e.variants[""];
            let path = Some(base.path.as_str());
            if matches!(e.kind, Kind::Agent | Kind::Skill) {
                let ok = e.name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                    && e.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
                if !ok {
                    out.push(Issue::new("warn", Some(e.kind), Some(&e.name), path, t!("名稱建議只用小寫英數與連字號（Claude Code / Agent Skills 慣例）；否則同步到外部工具時可能被略過").into()));
                }
                if field_str(&base.fields, "description").is_none_or(|d| d.trim().is_empty()) {
                    out.push(Issue::new("warn", Some(e.kind), Some(&e.name), path, t!("缺少 description；Claude Code 與 Codex 會略過沒有說明的項目").into()));
                }
            }
            if e.kind == Kind::Agent {
                for s in field_list(&base.fields, "skills") {
                    if !skill_names.contains(&s) {
                        out.push(Issue::new("warn", Some(e.kind), Some(&e.name), path, tf!("預載的技能「{s}」不存在", s = s)));
                    }
                }
            }
            if e.kind == Kind::Prompt {
                if e.layer != "builtin" && e.builtin.is_none() {
                    out.push(Issue::new("info", Some(e.kind), Some(&e.name), path, t!("沒有任何功能使用這個範本（名稱不是內建的任務）").into()));
                    continue;
                }
                let declared = field_list(&base.fields, "dbkit-vars");
                let required = field_list(&base.fields, "dbkit-required");
                let has_contract = field_str(&base.fields, "dbkit-contract").is_some_and(|c| !c.trim().is_empty());
                for (lang, v) in &e.variants {
                    let vp = Some(v.path.as_str());
                    let label = if lang.is_empty() { e.name.clone() } else { format!("{}.{lang}", e.name) };
                    if let Some(p) = render::section_problem(&v.body) {
                        out.push(Issue::new("error", Some(e.kind), Some(&label), vp, tf!("區段沒有配對好：{tag}", tag = p)));
                    }
                    for name in render::referenced_vars(&v.body) {
                        if name != "contract" && !declared.contains(&name) {
                            out.push(Issue::new("warn", Some(e.kind), Some(&label), vp, tf!("未知的變數 {tag}（這個任務不提供它，會輸出空字串）", tag = format!("{{{{{name}}}}}"))));
                        }
                    }
                    for r in &required {
                        if !render::uses_var(&v.body, r) {
                            out.push(Issue::new("warn", Some(e.kind), Some(&label), vp, tf!("沒有輸出必要變數 {tag}，送出時會自動附在最後", tag = format!("{{{{{r}}}}}"))));
                        }
                    }
                    if has_contract && !render::uses_var(&v.body, "contract") {
                        out.push(Issue::new("info", Some(e.kind), Some(&label), vp, t!("範本沒放 {{contract}}，輸出契約會自動附在最後").into()));
                    }
                }
            }
        }
        self.issues.extend(out);
    }
}

// ---------------------------------------------------------------------------
// 解析 / 渲染（Rust 端渲染的任務：執行前審查、工具指引；以及 CLI）
// ---------------------------------------------------------------------------

pub fn lang_chain(lang: &str) -> Vec<String> {
    let mut v = vec![lang.to_string()];
    if matches!(lang, "ja" | "ko" | "vi") {
        v.push("en".into());
    }
    v
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub fields: Map<String, Json>,
    pub body: String,
    pub lang: String,
}

pub fn resolve(entry: &Entry, lang: &str) -> Resolved {
    let base = &entry.variants[""];
    for l in lang_chain(lang) {
        if let Some(v) = entry.variants.get(&l) {
            let mut fields = base.fields.clone();
            for (k, val) in &v.fields {
                fields.insert(k.clone(), val.clone());
            }
            return Resolved { fields, body: v.body.clone(), lang: l };
        }
    }
    let lang = field_str(&base.fields, "dbkit-lang").unwrap_or_else(|| "zh-TW".into());
    Resolved { fields: base.fields.clone(), body: base.body.clone(), lang }
}

#[derive(Debug, Clone)]
// missing / lang 目前只有測試與 CLI 以外的呼叫端會讀（預覽 / lint 在前端做），先留著給後續用。
#[cfg_attr(not(test), allow(dead_code))]
pub struct RenderedTask {
    pub text: String,
    pub missing: Vec<String>,
    pub lang: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonaInfo {
    pub name: String,
    pub title: String,
    pub description: String,
    pub body: String,
    pub skills: Vec<String>,
    pub max_turns: u32,
    pub db_tools: bool,
    /// 允許的資料庫工具（去掉 `mcp__dbkit__` 前綴）；None = 全部。
    pub tool_allow: Option<Vec<String>>,
}

impl Library {
    /// 渲染一個任務。找不到任務時退到內建（使用者刪掉覆蓋檔也不影響功能）。
    pub fn render_task(&self, task: &str, vars: &Vars, lang: &str) -> Result<RenderedTask, String> {
        let fallback;
        let entry = match self.find(Kind::Prompt, task) {
            Some(e) => e,
            None => {
                fallback = Library::builtin_only();
                match fallback.find(Kind::Prompt, task) {
                    Some(e) => return fallback.render_task_entry(e, vars, lang),
                    None => return Err(format!("unknown AI task: {task}")),
                }
            }
        };
        self.render_task_entry(entry, vars, lang)
    }

    fn render_task_entry(&self, entry: &Entry, vars: &Vars, lang: &str) -> Result<RenderedTask, String> {
        let r = resolve(entry, lang);
        let base = &entry.variants[""].fields;
        let required = field_list(base, "dbkit-required");
        let contract = field_str(base, "dbkit-contract")
            .filter(|c| !c.trim().is_empty())
            .and_then(|c| self.find(Kind::Contract, c.trim()).map(|ce| resolve(ce, &r.lang).body));
        let (text, missing) = render::compose_task(&r.body, vars, contract.as_deref(), &required);
        Ok(RenderedTask { text, missing, lang: r.lang })
    }

    pub fn persona(&self, name: &str, lang: &str) -> Option<PersonaInfo> {
        let e = self.find(Kind::Agent, name)?;
        let r = resolve(e, lang);
        let tools = field_list(&r.fields, "tools");
        let allow: Vec<String> = tools.iter().filter_map(|t| t.strip_prefix("mcp__dbkit__")).map(str::to_string).collect();
        let turns = field_str(&r.fields, "maxTurns").and_then(|s| s.trim().parse::<u32>().ok()).filter(|n| *n > 0).unwrap_or(10);
        Some(PersonaInfo {
            name: e.name.clone(),
            title: field_str(&r.fields, "dbkit-title").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| e.name.clone()),
            description: field_str(&r.fields, "description").unwrap_or_default(),
            body: r.body,
            skills: field_list(&r.fields, "skills"),
            max_turns: turns.min(40),
            db_tools: field_bool(&r.fields, "dbkit-db-tools", true),
            tool_allow: if tools.is_empty() { None } else { Some(allow) },
        })
    }

    /// 人設的系統提示：本文 + 預載技能 + 額外技能 + 片段。找不到人設退回 `assistant`。
    pub fn persona_system(&self, name: Option<&str>, lang: &str, extra_skills: &[String], fragments: &[String]) -> String {
        let info = name.and_then(|n| self.persona(n, lang)).or_else(|| self.persona("assistant", lang));
        let mut names: Vec<String> = Vec::new();
        for s in info.iter().flat_map(|i| i.skills.iter()).chain(extra_skills.iter()) {
            if !names.contains(s) {
                names.push(s.clone());
            }
        }
        let skills: Vec<(String, String)> = names
            .iter()
            .filter_map(|n| self.find(Kind::Skill, n))
            .map(|e| {
                let r = resolve(e, lang);
                (field_str(&r.fields, "dbkit-title").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| e.name.clone()), r.body)
            })
            .collect();
        render::compose_system(info.as_ref().map(|i| i.body.as_str()).unwrap_or(""), &skills, fragments, t!("技能"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbkit-ailib-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn layer(id: &str, root: &Path) -> Layer {
        Layer { id: id.into(), label: id.into(), root: Some(root.to_path_buf()), writable: true }
    }

    #[test]
    fn classify_matches_frontend_rules() {
        let c = classify_path("prompts/fix.en.md").unwrap();
        assert_eq!((c.kind, c.group.as_str(), c.lang.as_str(), c.stem.as_str()), (Kind::Prompt, "prompts/fix", "en", "fix"));
        let s = classify_path("skills/lock-risk/SKILL.zh-CN.md").unwrap();
        assert_eq!((s.kind, s.lang.as_str(), s.stem.as_str()), (Kind::Skill, "zh-CN", "lock-risk"));
        assert_eq!(classify_path("agents/team/dba-x.md").unwrap().group, "agents/team/dba-x");
        assert!(classify_path("skills/x/README.md").is_none());
        assert!(classify_path("prompts/sub/x.md").is_none());
        assert_eq!(classify_path("prompts/review.v1.md").unwrap().stem, "review.v1");
    }

    #[test]
    fn builtin_library_is_clean() {
        let lib = Library::builtin_only();
        assert!(lib.find(Kind::Prompt, "review-pre-exec").is_some());
        assert!(lib.find(Kind::Contract, "verdict").is_some());
        let bad: Vec<_> = lib.issues.iter().filter(|i| i.level != "info").collect();
        assert!(bad.is_empty(), "內建資源庫有 lint 問題：{bad:#?}");
    }

    #[test]
    fn layering_overrides_and_forces_registry() {
        let personal = tmpdir("p");
        let team = tmpdir("t");
        // 個人層覆蓋內建範本，還試圖改契約與登錄欄位 → 登錄欄位被改回內建值。
        write(&personal, "prompts/review-sql.md", "---\nname: review-sql\ndbkit-contract: none\ndbkit-vars: [sql]\n---\n我的審查 {{sql}}\n{{contract}}");
        // 團隊層用 Claude Code 結構放一個人設與技能，並試圖覆蓋契約（無效）。
        write(&team, ".claude/agents/team-dba.md", "---\nname: team-dba\ndescription: 團隊 DBA\ndbkit-role: dba\nskills: [team-rule]\n---\n你是團隊 DBA。");
        write(&team, ".agents/skills/team-rule/SKILL.md", "---\nname: team-rule\ndescription: 團隊規則\n---\n禁止 SELECT *。");
        write(&team, "contracts/verdict.md", "---\nname: verdict\n---\n亂改");
        let lib = Library::load(&[Layer::builtin(), layer("personal", &personal), layer("team:0", &team)]);

        let p = lib.find(Kind::Prompt, "review-sql").unwrap();
        assert_eq!(p.layer, "personal");
        assert_eq!(field_str(&p.variants[""].fields, "dbkit-contract").as_deref(), Some("verdict"));
        assert!(field_list(&p.variants[""].fields, "dbkit-vars").contains(&"lint_findings".to_string()));
        assert!(p.builtin.is_some());
        assert_eq!(p.shadowed[0].layer, "builtin");

        let a = lib.find(Kind::Agent, "team-dba").unwrap();
        assert_eq!(a.layer, "team:0");
        assert_eq!(lib.find(Kind::Contract, "verdict").unwrap().layer, "builtin");
        assert!(lib.issues.iter().any(|i| i.kind == Some(Kind::Contract) && i.level == "warn"));

        let sys = lib.persona_system(Some("team-dba"), "zh-TW", &[], &["【片段】".into()]);
        assert_eq!(sys, "你是團隊 DBA。\n\n[技能：team-rule]\n禁止 SELECT *。\n\n【片段】");

        let r = lib.render_task("review-sql", &Vars::from([("sql".into(), "S".into())]), "en").unwrap();
        assert!(r.text.starts_with("我的審查 S"));
        // 覆蓋檔只有基底，en 介面也用它（不去混內建的英文變體）；契約語言跟著範本（zh-TW）。
        assert!(r.text.contains("回覆的第一行必須是"));
        let _ = std::fs::remove_dir_all(personal);
        let _ = std::fs::remove_dir_all(team);
    }

    #[test]
    fn lint_reports_template_problems() {
        let personal = tmpdir("lint");
        write(&personal, "prompts/fix.md", "---\nname: fix\n---\n{{#a}}壞掉的區段\n{{nope}}");
        write(&personal, "agents/Bad_Name.md", "---\nname: Bad_Name\nskills: [missing-skill]\n---\nx");
        let lib = Library::load(&[Layer::builtin(), layer("personal", &personal)]);
        let msgs: Vec<&str> = lib.issues.iter().filter(|i| i.name.as_deref().is_some_and(|n| n == "fix" || n == "Bad_Name")).map(|i| i.level).collect();
        assert!(msgs.contains(&"error"), "{:#?}", lib.issues);
        assert!(lib.issues.iter().any(|i| i.message.contains("nope")));
        assert!(lib.issues.iter().any(|i| i.message.contains("missing-skill")));
        let _ = std::fs::remove_dir_all(personal);
    }

    #[test]
    fn persona_info_tools_and_turns() {
        let lib = Library::builtin_only();
        let g = lib.persona("dba-prod-gatekeeper", "zh-TW").unwrap();
        assert_eq!(g.tool_allow.as_deref().unwrap(), ["list_databases", "list_tables", "describe_table", "explain_query"]);
        assert_eq!(g.max_turns, 10);
        assert!(g.db_tools);
        assert!(lib.persona("assistant", "zh-TW").unwrap().tool_allow.is_none());
        assert_eq!(lib.persona("dba-senior", "en").unwrap().title, "Senior DBA");
    }

    #[test]
    fn pre_exec_template_is_english_with_english_contract() {
        let lib = Library::builtin_only();
        let vars = Vars::from([("script".into(), "```sql\nDELETE FROM t\n```".into()), ("static_analysis".into(), "- #1 Delete".into())]);
        let r = lib.render_task("review-pre-exec", &vars, "zh-TW").unwrap();
        assert_eq!(r.lang, "en");
        assert!(r.text.contains("VERDICT: STOP"));
        assert!(r.text.contains("The FIRST line of your reply must be exactly one of:"));
        assert!(r.missing.is_empty());
    }
}
