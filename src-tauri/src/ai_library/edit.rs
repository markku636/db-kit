//! 寫入資源庫：存檔（就地或新建）、複製為自訂、刪除。
//!
//! 一律只寫在「可寫的層」（個人層，或設定為可寫的團隊資料夾）；內建層唯讀。
//! 就地存檔用 frontmatter 的逐行編輯：只動表單上有的鍵與本文，其餘行（Claude Code 的 hooks 之類）原樣保留。

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value as Json};

use super::frontmatter;
use super::library::{Kind, Layer, Library, LANGS};

/// 名稱只收安全字元：它會變成檔名 / 資料夾名，不能帶路徑分隔或 `..`。
pub fn valid_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && n.len() <= 64
        && n.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !n.contains("..")
}

fn valid_lang(lang: &str) -> bool {
    lang.is_empty() || LANGS.contains(&lang)
}

/// 新檔案在某一層裡的路徑（db-kit 結構）。
pub fn new_path(root: &Path, kind: Kind, name: &str, lang: &str) -> PathBuf {
    let suffix = if lang.is_empty() { String::new() } else { format!(".{lang}") };
    match kind {
        Kind::Agent => root.join("agents").join(format!("{name}{suffix}.md")),
        Kind::Skill => root.join("skills").join(name).join(format!("SKILL{suffix}.md")),
        Kind::Prompt => root.join("prompts").join(format!("{name}{suffix}.md")),
        Kind::Contract => root.join("contracts").join(format!("{name}{suffix}.md")),
    }
}

fn writable_layer<'a>(layers: &'a [Layer], id: &str) -> Result<&'a Layer, String> {
    let l = layers.iter().find(|l| l.id == id).ok_or_else(|| tf!("找不到資源庫層：{id}", id = id))?;
    if !l.writable || l.root.is_none() {
        return Err(tf!("「{label}」是唯讀的，請改存到個人或可寫的團隊資料夾", label = l.label));
    }
    Ok(l)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| tf!("建立資料夾失敗：{e}", e = e))?;
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, text).map_err(|e| tf!("寫入失敗：{e}", e = e))?;
    std::fs::rename(&tmp, path).map_err(|e| tf!("寫入失敗：{e}", e = e))
}

/// 表單欄位：字串 = 純量、陣列 = 清單、null = 刪除該鍵。
fn apply_fields(doc: &mut frontmatter::Doc, fields: &Map<String, Json>) {
    for (k, v) in fields {
        match v {
            Json::Null => doc.remove(k),
            Json::Array(a) => {
                let items: Vec<String> = a.iter().filter_map(|x| x.as_str().map(str::to_string)).filter(|s| !s.trim().is_empty()).collect();
                if items.is_empty() {
                    doc.remove(k);
                } else {
                    doc.set_list(k, &items);
                }
            }
            Json::String(s) if s.trim().is_empty() => doc.remove(k),
            Json::String(s) => doc.set_str(k, s.trim()),
            Json::Bool(b) => doc.set_str(k, if *b { "true" } else { "false" }),
            Json::Number(n) => doc.set_str(k, &n.to_string()),
            Json::Object(_) => {}
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveRequest {
    pub kind: Kind,
    /// 目前的名稱（新建時與 `new_name` 相同或留空）。
    pub name: String,
    /// 另存 / 改名後的名稱；None = 不改名。
    #[serde(default)]
    pub new_name: Option<String>,
    /// 語言變體；空字串 = 基底檔。
    #[serde(default)]
    pub lang: String,
    /// 寫到哪一層（`personal` / `team:<n>`）。
    pub layer: String,
    /// 表單欄位（只列要改的；null = 刪除）。
    #[serde(default)]
    pub fields: Map<String, Json>,
    /// 新本文；None = 不動本文。
    #[serde(default)]
    pub body: Option<String>,
    /// 直接給整份檔案原文（進階：原文編輯模式）。有給時忽略 fields / body。
    #[serde(default)]
    pub raw: Option<String>,
}

/// 存檔。目標層已有這一筆 → 就地編輯該檔；沒有 → 以勝出版本（或空白）為底新建。
/// 回傳寫入的路徑。
pub fn save(lib: &Library, layers: &[Layer], req: &SaveRequest) -> Result<PathBuf, String> {
    let layer = writable_layer(layers, &req.layer)?;
    let root = layer.root.as_ref().unwrap();
    let target_name = req.new_name.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(req.name.trim()).to_string();
    if !valid_name(&target_name) {
        return Err(tf!("名稱「{name}」不合法：只能用英數、連字號、底線與點，且以英數開頭", name = target_name));
    }
    if !valid_lang(&req.lang) {
        return Err(tf!("不支援的語言：{lang}", lang = req.lang));
    }
    if req.kind == Kind::Contract {
        return Err(t!("輸出契約不能修改（解析器依賴它）").into());
    }
    let existing = lib.find(req.kind, req.name.trim());
    // 同一層、同名、同語言 → 就地；否則新建到 db-kit 結構的路徑。
    let in_place = existing
        .filter(|e| e.layer == layer.id && target_name == e.name)
        .and_then(|e| e.variants.get(&req.lang))
        .map(|v| PathBuf::from(&v.path));
    let path = in_place.clone().unwrap_or_else(|| new_path(root, req.kind, &target_name, &req.lang));
    if in_place.is_none() && path.exists() {
        return Err(tf!("檔案已存在：{path}", path = path.display()));
    }
    let text = match &req.raw {
        Some(raw) => frontmatter::normalize(raw),
        None => {
            // 底稿：目標層那一份 > 勝出版本同語言的那一份 > 空白。
            let base_raw = existing.and_then(|e| e.variants.get(&req.lang)).map(|v| v.raw.clone()).unwrap_or_default();
            let mut doc = own_copy(&base_raw, &target_name, &req.lang);
            if doc.fm.is_none() {
                doc.fm = Some(Vec::new());
            }
            doc.set_str("name", &target_name);
            apply_fields(&mut doc, &req.fields);
            if let Some(b) = &req.body {
                doc.set_body(b);
            }
            doc.to_text()
        }
    };
    write_atomic(&path, &text)?;
    // 在較低層（內建）之上第一次存同名覆蓋：覆蓋是整筆取代，其他語言變體也要一起帶上來，
    // 不然只改了基底，英文 / 簡中使用者就會掉回基底檔。
    if let Some(e) = existing.filter(|e| in_place.is_none() && e.layer != layer.id && e.name == target_name) {
        for (lang, v) in e.variants.iter().filter(|(l, _)| **l != req.lang) {
            let p = new_path(root, req.kind, &target_name, lang);
            if !p.exists() {
                write_atomic(&p, &own_copy(&v.raw, &target_name, lang).to_text())?;
            }
        }
    }
    // 改名：刪掉同一層的舊檔（就地編輯的情況下舊檔就是新檔，不動）。
    if let Some(e) = existing.filter(|e| e.layer == layer.id && e.name != target_name) {
        if let Some(v) = e.variants.get(&req.lang) {
            let _ = std::fs::remove_file(&v.path);
        }
    }
    Ok(path)
}

/// 複製為自訂：把勝出版本（含所有語言變體）複製到可寫的層，可同時改名。
pub fn copy(lib: &Library, layers: &[Layer], kind: Kind, name: &str, new_name: &str, layer_id: &str) -> Result<PathBuf, String> {
    let layer = writable_layer(layers, layer_id)?;
    let root = layer.root.as_ref().unwrap();
    let new_name = new_name.trim();
    if !valid_name(new_name) {
        return Err(tf!("名稱「{name}」不合法：只能用英數、連字號、底線與點，且以英數開頭", name = new_name));
    }
    if kind == Kind::Contract {
        return Err(t!("輸出契約不能複製（解析器依賴它）").into());
    }
    let src = lib.find(kind, name).ok_or_else(|| tf!("找不到：{name}", name = name))?;
    let base_path = new_path(root, kind, new_name, "");
    if base_path.exists() {
        return Err(tf!("檔案已存在：{path}", path = base_path.display()));
    }
    for (lang, v) in &src.variants {
        write_atomic(&new_path(root, kind, new_name, lang), &own_copy(&v.raw, new_name, lang).to_text())?;
    }
    Ok(base_path)
}

/// 把別層的一份檔案變成自己的副本：改掉 `name`，拿掉產生器寫的「請勿手改」註解（對自訂副本不成立）。
fn own_copy(raw: &str, name: &str, lang: &str) -> frontmatter::Doc {
    let mut doc = frontmatter::parse(raw);
    if doc.fm.is_some() || lang.is_empty() {
        doc.set_str("name", name);
    }
    if let Some(fm) = &mut doc.fm {
        fm.retain(|l| !l.contains("i18n-gen-zhcn.mjs"));
    }
    doc
}

/// 刪除某一層裡的一筆（lang = None 刪全部語言變體；技能資料夾空了就一併移除）。
pub fn delete(lib: &Library, layers: &[Layer], kind: Kind, name: &str, layer_id: &str, lang: Option<&str>) -> Result<(), String> {
    let layer = writable_layer(layers, layer_id)?;
    let e = lib.find(kind, name).filter(|e| e.layer == layer.id).ok_or_else(|| tf!("「{label}」裡沒有 {name}", label = layer.label, name = name))?;
    let mut dirs: Vec<PathBuf> = Vec::new();
    for (l, v) in &e.variants {
        if lang.is_some_and(|want| want != l) {
            continue;
        }
        let p = PathBuf::from(&v.path);
        std::fs::remove_file(&p).map_err(|err| tf!("刪除失敗：{e}", e = err))?;
        if let Some(d) = p.parent() {
            dirs.push(d.to_path_buf());
        }
    }
    if kind == Kind::Skill {
        for d in dirs {
            // 只移除空資料夾：技能資料夾可能還有 references/ 之類的附件。
            let _ = std::fs::remove_dir(d);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_library::frontmatter::field_list;

    fn setup() -> (PathBuf, Vec<Layer>) {
        let d = std::env::temp_dir().join(format!("dbkit-ailib-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let layers = vec![Layer::builtin(), Layer { id: "personal".into(), label: "個人".into(), root: Some(d.clone()), writable: true }];
        (d, layers)
    }

    #[test]
    fn name_validation_blocks_traversal() {
        assert!(valid_name("dba-senior"));
        assert!(valid_name("my_skill.v2"));
        assert!(!valid_name("../x"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("-x"));
        assert!(!valid_name(""));
    }

    #[test]
    fn copy_then_edit_in_place_preserves_unknown_lines() {
        let (dir, layers) = setup();
        let lib = Library::load(&layers);
        let p = copy(&lib, &layers, Kind::Agent, "dba-senior", "my-dba", "personal").unwrap();
        assert!(p.exists());
        assert!(dir.join("agents/my-dba.en.md").exists());
        assert!(dir.join("agents/my-dba.zh-CN.md").exists());
        // 手動加一行 Claude Code 的設定，再從表單存檔 → 那行要留著。
        let raw = std::fs::read_to_string(&p).unwrap().replace("---\nname: my-dba", "---\nname: my-dba\nmodel: opus");
        std::fs::write(&p, raw).unwrap();
        let lib = Library::load(&layers);
        let mut fields = Map::new();
        fields.insert("skills".into(), serde_json::json!(["lock-risk", "pii-check"]));
        fields.insert("dbkit-icon".into(), Json::Null);
        let req = SaveRequest {
            kind: Kind::Agent,
            name: "my-dba".into(),
            new_name: None,
            lang: String::new(),
            layer: "personal".into(),
            fields,
            body: Some("新的本文".into()),
            raw: None,
        };
        let out = save(&lib, &layers, &req).unwrap();
        assert_eq!(out, p);
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("model: opus"), "{text}");
        assert!(!text.contains("dbkit-icon"));
        assert!(text.ends_with("---\n新的本文\n"));
        let lib = Library::load(&layers);
        let e = lib.find(Kind::Agent, "my-dba").unwrap();
        assert_eq!(e.layer, "personal");
        assert_eq!(field_list(&e.variants[""].fields, "skills"), ["lock-risk", "pii-check"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_override_of_builtin_creates_personal_file_and_delete_restores() {
        let (dir, layers) = setup();
        let lib = Library::load(&layers);
        let req = SaveRequest {
            kind: Kind::Prompt,
            name: "review-sql".into(),
            new_name: None,
            lang: String::new(),
            layer: "personal".into(),
            fields: Map::new(),
            body: Some("自訂審查 {{sql}}\n{{contract}}".into()),
            raw: None,
        };
        let p = save(&lib, &layers, &req).unwrap();
        assert_eq!(p, dir.join("prompts/review-sql.md"));
        // 覆蓋是整筆取代：沒改到的語言變體要從內建帶上來，產生器的「請勿手改」註解要拿掉。
        assert!(dir.join("prompts/review-sql.en.md").exists());
        let zh_cn = std::fs::read_to_string(dir.join("prompts/review-sql.zh-CN.md")).unwrap();
        assert!(!zh_cn.contains("i18n-gen-zhcn.mjs"), "{zh_cn}");
        let lib = Library::load(&layers);
        let e = lib.find(Kind::Prompt, "review-sql").unwrap();
        assert_eq!(e.layer, "personal");
        assert!(e.variants[""].body.starts_with("自訂審查"));
        assert_eq!(e.variants["en"].body, e.builtin.as_ref().unwrap()["en"].body);
        // 已經有覆蓋之後再存另一個語言 → 就地，不再從內建補檔。
        std::fs::remove_file(dir.join("prompts/review-sql.en.md")).unwrap();
        let lib = Library::load(&layers);
        let req_zh = SaveRequest { lang: "zh-CN".into(), body: Some("自订 {{sql}}\n{{contract}}".into()), ..req.clone() };
        save(&lib, &layers, &req_zh).unwrap();
        assert!(!dir.join("prompts/review-sql.en.md").exists());
        delete(&lib, &layers, Kind::Prompt, "review-sql", "personal", None).unwrap();
        let lib = Library::load(&layers);
        assert_eq!(lib.find(Kind::Prompt, "review-sql").unwrap().layer, "builtin");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn builtin_layer_and_contracts_are_read_only() {
        let (dir, layers) = setup();
        let lib = Library::load(&layers);
        assert!(copy(&lib, &layers, Kind::Agent, "dba-senior", "x", "builtin").is_err());
        assert!(copy(&lib, &layers, Kind::Contract, "verdict", "x", "personal").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
