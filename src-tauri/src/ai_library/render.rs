//! 範本渲染：Mustache 子集 + 任務組裝（契約 / 必要變數）+ 系統提示組法。
//!
//! 與前端 `src/promptTemplate.ts` 逐字元同一套規則，由 `tests/fixtures/ai-render-cases.json` 釘住。
//! 規格見前端檔頭；這裡只重述會讓兩邊分岔的細節：
//! - 標籤逐字元手寫解析（`{{name}}`、`{{#name}}`、`{{^name}}`、`{{/name}}`、`{{! 註解 }}`），名稱限 `[A-Za-z0-9_.-]`，
//!   標籤內只容許空格 / tab；讀不成的 `{{` 當普通字元。
//! - 一行去掉前後空格 / tab 後恰好是**一個**區段標籤或註解 → 整行連換行移除。
//! - 區段真假看變數 trim 後是否非空；名稱對不上的 `{{/x}}` 忽略；沒收尾的區段延續到結尾。
//! - 結果去掉尾端換行。

use std::collections::HashMap;

use super::frontmatter::normalize;

pub type Vars = HashMap<String, String>;

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Text(String),
    Var(String),
    Open { name: String, inverted: bool },
    Close(String),
    Comment,
}

fn is_ws(c: char) -> bool {
    c == ' ' || c == '\t'
}

fn is_name(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'
}

/// 在 `line[i]`（必為 `{{`）讀一個標籤；讀不成回 None。回傳 (token, 結束位置)。
fn read_tag(line: &[char], i: usize) -> Option<(Tok, usize)> {
    let mut j = i + 2;
    if line.get(j) == Some(&'!') {
        let mut k = j + 1;
        while k + 1 < line.len() {
            if line[k] == '}' && line[k + 1] == '}' {
                return Some((Tok::Comment, k + 2));
            }
            k += 1;
        }
        return None;
    }
    while line.get(j).copied().is_some_and(is_ws) {
        j += 1;
    }
    let sigil = match line.get(j) {
        Some(c @ ('#' | '^' | '/')) => {
            j += 1;
            Some(*c)
        }
        _ => None,
    };
    while line.get(j).copied().is_some_and(is_ws) {
        j += 1;
    }
    let start = j;
    while line.get(j).copied().is_some_and(is_name) {
        j += 1;
    }
    if j == start {
        return None;
    }
    let name: String = line[start..j].iter().collect();
    while line.get(j).copied().is_some_and(is_ws) {
        j += 1;
    }
    if line.get(j) != Some(&'}') || line.get(j + 1) != Some(&'}') {
        return None;
    }
    let tok = match sigil {
        Some('#') => Tok::Open { name, inverted: false },
        Some('^') => Tok::Open { name, inverted: true },
        Some('/') => Tok::Close(name),
        _ => Tok::Var(name),
    };
    Some((tok, j + 2))
}

fn tokenize_line(line: &str) -> Vec<Tok> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut text = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' && chars.get(i + 1) == Some(&'{') {
            if let Some((tok, end)) = read_tag(&chars, i) {
                if !text.is_empty() {
                    out.push(Tok::Text(std::mem::take(&mut text)));
                }
                out.push(tok);
                i = end;
                continue;
            }
        }
        text.push(chars[i]);
        i += 1;
    }
    if !text.is_empty() {
        out.push(Tok::Text(text));
    }
    out
}

fn tokenize(tpl: &str) -> Vec<Tok> {
    let norm = normalize(tpl);
    let lines: Vec<&str> = norm.split('\n').collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_matches(is_ws);
        let inner = tokenize_line(trimmed);
        if inner.len() == 1 && matches!(inner[0], Tok::Open { .. } | Tok::Close(_) | Tok::Comment) {
            out.extend(inner);
            continue;
        }
        out.extend(tokenize_line(line));
        if i + 1 < lines.len() {
            out.push(Tok::Text("\n".into()));
        }
    }
    out
}

pub fn truthy(v: Option<&String>) -> bool {
    v.is_some_and(|s| !s.trim().is_empty())
}

pub fn render(tpl: &str, vars: &Vars) -> String {
    let mut stack: Vec<(String, bool)> = Vec::new();
    let mut out = String::new();
    for t in tokenize(tpl) {
        let active = stack.iter().all(|(_, on)| *on);
        match t {
            Tok::Text(s) => {
                if active {
                    out.push_str(&s);
                }
            }
            Tok::Var(name) => {
                if active {
                    if let Some(v) = vars.get(&name) {
                        out.push_str(v);
                    }
                }
            }
            Tok::Open { name, inverted } => {
                let v = truthy(vars.get(&name));
                stack.push((name, if inverted { !v } else { v }));
            }
            Tok::Close(name) => {
                if stack.last().is_some_and(|(n, _)| *n == name) {
                    stack.pop();
                }
            }
            Tok::Comment => {}
        }
    }
    out.trim_end_matches('\n').to_string()
}

/// 範本裡有沒有直接輸出這個變數（`{{name}}`，不含區段標籤）。
pub fn uses_var(tpl: &str, name: &str) -> bool {
    tokenize(tpl).iter().any(|t| matches!(t, Tok::Var(n) if n == name))
}

/// 範本裡出現過的所有變數名（含區段），依出現順序去重。
pub fn referenced_vars(tpl: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for t in tokenize(tpl) {
        let n = match t {
            Tok::Var(n) | Tok::Close(n) | Tok::Open { name: n, .. } => n,
            _ => continue,
        };
        if !seen.contains(&n) {
            seen.push(n);
        }
    }
    seen
}

/// 區段沒配對好時回傳第一個問題標籤（`{{/x}}` 或 `{{#x}}`）。
pub fn section_problem(tpl: &str) -> Option<String> {
    let mut stack: Vec<String> = Vec::new();
    for t in tokenize(tpl) {
        match t {
            Tok::Open { name, .. } => stack.push(name),
            Tok::Close(name) => {
                if stack.last() != Some(&name) {
                    return Some(format!("{{{{/{name}}}}}"));
                }
                stack.pop();
            }
            _ => {}
        }
    }
    stack.last().map(|n| format!("{{{{#{n}}}}}"))
}

/// 任務組裝：契約先渲染成 `{{contract}}` 變數；範本漏放契約就附在最後；必要變數沒被直接輸出就附在契約之前。
/// 回傳 (提示, 被自動附加的必要變數)。
pub fn compose_task(body: &str, vars: &Vars, contract: Option<&str>, required: &[String]) -> (String, Vec<String>) {
    let rendered_contract = contract.map(|c| render(c, vars)).unwrap_or_default();
    let mut v = vars.clone();
    v.insert("contract".into(), rendered_contract.clone());
    let mut text = render(body, &v);
    let missing: Vec<String> = required.iter().filter(|r| r.as_str() != "contract" && !uses_var(body, r)).cloned().collect();
    for r in &missing {
        if let Some(val) = vars.get(r).filter(|s| !s.trim().is_empty()) {
            text = if text.is_empty() { val.clone() } else { format!("{text}\n\n{val}") };
        }
    }
    if !rendered_contract.is_empty() && !uses_var(body, "contract") {
        text = if text.is_empty() { rendered_contract } else { format!("{text}\n\n{rendered_contract}") };
    }
    (text, missing)
}

/// 系統提示：人設 + `[技能：名稱]` 段落 + 片段，空的略過，以空行相接。
pub fn compose_system(persona: &str, skills: &[(String, String)], fragments: &[String], skill_label: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !persona.trim().is_empty() {
        parts.push(persona.trim().to_string());
    }
    for (title, body) in skills {
        if !body.trim().is_empty() {
            parts.push(format!("[{skill_label}：{title}]\n{}", body.trim()));
        }
    }
    for f in fragments {
        if !f.trim().is_empty() {
            parts.push(f.trim().to_string());
        }
    }
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::super::frontmatter;
    use super::*;
    use serde_json::Value as Json;

    fn cases() -> Json {
        serde_json::from_str(include_str!("../../tests/fixtures/ai-render-cases.json")).unwrap()
    }

    fn vars_of(v: &Json) -> Vars {
        v.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect()
    }

    fn strs(v: &Json) -> Vec<String> {
        v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn shared_render_cases() {
        for c in cases()["render"].as_array().unwrap() {
            let got = render(c["tpl"].as_str().unwrap(), &vars_of(&c["vars"]));
            assert_eq!(got, c["out"].as_str().unwrap(), "render case: {}", c["name"]);
        }
    }

    #[test]
    fn shared_compose_cases() {
        for c in cases()["compose"].as_array().unwrap() {
            let (text, missing) = compose_task(
                c["body"].as_str().unwrap(),
                &vars_of(&c["vars"]),
                c["contract"].as_str(),
                &strs(&c["required"]),
            );
            assert_eq!(text, c["out"].as_str().unwrap(), "compose case: {}", c["name"]);
            assert_eq!(missing, strs(&c["missing"]), "compose missing: {}", c["name"]);
        }
    }

    #[test]
    fn shared_frontmatter_cases() {
        for c in cases()["frontmatter"].as_array().unwrap() {
            let d = frontmatter::parse(c["text"].as_str().unwrap());
            assert_eq!(Json::Object(d.fields()), c["fields"], "frontmatter fields: {}", c["name"]);
            assert_eq!(d.body(), c["body"].as_str().unwrap(), "frontmatter body: {}", c["name"]);
            assert_eq!(d.has_frontmatter(), c["has_frontmatter"].as_bool().unwrap(), "has fm: {}", c["name"]);
        }
    }

    #[test]
    fn shared_system_cases() {
        for c in cases()["system"].as_array().unwrap() {
            let skills: Vec<(String, String)> = c["skills"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| (s["title"].as_str().unwrap().to_string(), s["body"].as_str().unwrap().to_string()))
                .collect();
            let got = compose_system(c["persona"].as_str().unwrap(), &skills, &strs(&c["fragments"]), c["label"].as_str().unwrap());
            assert_eq!(got, c["out"].as_str().unwrap(), "system case: {}", c["name"]);
        }
    }

    #[test]
    fn analysis_helpers() {
        assert!(!uses_var("{{#sql}}x{{/sql}}", "sql"));
        assert!(uses_var("a {{ sql }} b", "sql"));
        assert_eq!(referenced_vars("{{#a}}{{b}}{{/a}}{{b}}{{^c}}{{/c}}"), vec!["a", "b", "c"]);
        assert_eq!(section_problem("{{#a}}{{/a}}"), None);
        assert_eq!(section_problem("{{#a}}").as_deref(), Some("{{#a}}"));
        assert_eq!(section_problem("{{#a}}{{/b}}").as_deref(), Some("{{/b}}"));
    }
}
