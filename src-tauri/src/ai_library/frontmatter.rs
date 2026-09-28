//! 扁平 YAML frontmatter：解析 + 往返不變的就地編輯。
//!
//! 與前端 `src/promptTemplate.ts::parseFrontmatter` 是同一份規格（共用案例見
//! `tests/fixtures/ai-render-cases.json`）。只認得本資源庫用得到的形狀：`key: 純量`、`key: [a, b]`、
//! `key:` 接 `- 項目`、`key: |` / `key: >` 區塊字串。其餘（Claude Code 的 `hooks`、`mcpServers` 這類
//! 巢狀物件）不解析，但**存檔時原樣保留**——使用者在同一個檔案裡給 Claude Code 用的設定不能被我們弄丟。
//!
//! 刻意不引入 yaml crate：我們只寫自己的幾個扁平鍵，其餘行一律不碰；用 serde 重新序列化整份 YAML
//! 反而會重排鍵序、吃掉註解。

use serde_json::{Map, Value as Json};

/// 去掉 BOM、統一換行成 `\n`。
pub fn normalize(text: &str) -> String {
    text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n").replace('\r', "\n")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    /// frontmatter 的原始行（不含前後 `---`）；None = 檔案沒有 frontmatter。
    pub fm: Option<Vec<String>>,
    /// frontmatter 之後的全部原文（不修剪）。
    pub body_raw: String,
}

fn is_ws(c: char) -> bool {
    c == ' ' || c == '\t'
}

fn starts_ws(s: &str) -> bool {
    s.starts_with(is_ws)
}

fn unquote(s: &str) -> String {
    let v = s.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        let inner = &v[1..v.len() - 1];
        let mut out = String::new();
        let mut it = inner.chars();
        while let Some(c) = it.next() {
            if c == '\\' {
                match it.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(o) => {
                        out.push('\\');
                        out.push(o);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    v.to_string()
}

/// 以逗號切開，但不切引號內的逗號。
pub fn split_list(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut q: Option<char> = None;
    for ch in s.chars() {
        match q {
            Some(open) => {
                cur.push(ch);
                if ch == open {
                    q = None;
                }
            }
            None if ch == '"' || ch == '\'' => {
                q = Some(ch);
                cur.push(ch);
            }
            None if ch == ',' => out.push(std::mem::take(&mut cur)),
            None => cur.push(ch),
        }
    }
    out.push(cur);
    out.iter().map(|x| unquote(x)).filter(|x| !x.is_empty()).collect()
}

/// 未加引號的純量去掉行尾 ` # 註解`（`\s#`，與前端 `search(/\s#/)` 一致）。
fn strip_comment(s: &str) -> &str {
    if s.starts_with('"') || s.starts_with('\'') {
        return s;
    }
    let b: Vec<char> = s.chars().collect();
    for i in 1..b.len() {
        if b[i] == '#' && b[i - 1].is_whitespace() {
            let byte = s.char_indices().nth(i - 1).map(|(p, _)| p).unwrap_or(s.len());
            return s[..byte].trim_end();
        }
    }
    s
}

/// `key: rest` 的解析；rest 已 trim。
fn split_key(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    // `key : v` 也算（前端的正規式是 `key\s*:`）。
    let key = line[..colon].trim_end_matches(is_ws);
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let rest = &line[colon + 1..];
    // YAML 的 mapping 冒號後面要有空白（或行尾）；`a:b` 是純量不是鍵。
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some((key, rest.trim()))
}

pub fn parse(raw: &str) -> Doc {
    let text = normalize(raw);
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return Doc { fm: None, body_raw: text };
    }
    let end = lines.iter().enumerate().skip(1).find(|(_, l)| l.trim() == "---").map(|(i, _)| i);
    let Some(end) = end else {
        return Doc { fm: None, body_raw: text };
    };
    Doc {
        fm: Some(lines[1..end].iter().map(|s| s.to_string()).collect()),
        body_raw: lines[end + 1..].join("\n"),
    }
}

/// 本文去掉開頭空行與結尾換行（檔案結尾的換行不屬於 prompt）。
pub fn trim_body(s: &str) -> String {
    s.trim_start_matches('\n').trim_end_matches('\n').to_string()
}

impl Doc {
    pub fn has_frontmatter(&self) -> bool {
        self.fm.is_some()
    }

    /// 修剪過的本文（渲染 / 系統提示用）。沒有 frontmatter 時整份就是本文。
    pub fn body(&self) -> String {
        trim_body(&self.body_raw)
    }

    /// 解析出的欄位（保留出現順序）。純量為字串、清單為字串陣列；無法解析的鍵不出現。
    pub fn fields(&self) -> Map<String, Json> {
        let mut out = Map::new();
        let Some(fm) = &self.fm else { return out };
        let mut i = 0;
        while i < fm.len() {
            let line = &fm[i];
            i += 1;
            if line.trim().is_empty() || line.trim_start().starts_with('#') || starts_ws(line) {
                continue;
            }
            let Some((key, rest0)) = split_key(line) else { continue };
            let rest = strip_comment(rest0);
            if rest.is_empty() {
                let mut items = Vec::new();
                let mut j = i;
                while j < fm.len() {
                    let l = &fm[j];
                    let t = l.trim_start();
                    if let Some(item) = t.strip_prefix('-').filter(|r| r.starts_with(char::is_whitespace)) {
                        items.push(unquote(strip_comment(item.trim())));
                    } else if l.trim().is_empty() {
                        // 清單中間的空行照樣吃掉
                    } else {
                        break;
                    }
                    j += 1;
                }
                if !items.is_empty() {
                    out.insert(key.to_string(), Json::Array(items.into_iter().map(Json::String).collect()));
                    i = j;
                }
                continue;
            }
            if matches!(rest, "|" | ">" | "|-" | ">-") {
                let mut block = Vec::new();
                let mut j = i;
                while j < fm.len() && (starts_ws(&fm[j]) || fm[j].trim().is_empty()) {
                    block.push(fm[j].as_str());
                    j += 1;
                }
                let indent = block
                    .iter()
                    .filter(|b| !b.trim().is_empty())
                    .map(|b| b.len() - b.trim_start_matches(is_ws).len())
                    .min()
                    .unwrap_or(0);
                let body: Vec<&str> = block.iter().map(|b| if b.len() >= indent { &b[indent..] } else { "" }).collect();
                let joined = if rest.starts_with('|') { body.join("\n") } else { body.join(" ") };
                out.insert(key.to_string(), Json::String(joined.trim().to_string()));
                i = j;
                continue;
            }
            if rest.starts_with('[') && rest.ends_with(']') {
                let items = split_list(&rest[1..rest.len() - 1]);
                out.insert(key.to_string(), Json::Array(items.into_iter().map(Json::String).collect()));
                continue;
            }
            out.insert(key.to_string(), Json::String(unquote(rest)));
        }
        out
    }

    /// 某個鍵佔用的行範圍 `[start, end)`（含它的區塊清單 / 區塊字串 / 巢狀內容）。
    fn key_span(fm: &[String], key: &str) -> Option<(usize, usize)> {
        let start = fm.iter().position(|l| !starts_ws(l) && split_key(l).map(|(k, _)| k) == Some(key))?;
        let mut end = start + 1;
        loop {
            match fm.get(end) {
                Some(l) if starts_ws(l) => end += 1,
                Some(l) if l.trim().is_empty() => {
                    // 空行只有在後面還接著縮排行時才算這個鍵的一部分。
                    let mut k = end;
                    while fm.get(k).is_some_and(|x| x.trim().is_empty()) {
                        k += 1;
                    }
                    if fm.get(k).is_some_and(|x| starts_ws(x)) {
                        end = k;
                    } else {
                        break;
                    }
                }
                _ => break,
            }
        }
        Some((start, end))
    }

    /// 設定（或新增）一個純量欄位；其餘行不動。
    pub fn set_str(&mut self, key: &str, value: &str) {
        self.set_line(key, format!("{key}: {}", quote_scalar(value)));
    }

    /// 設定（或新增）一個清單欄位（寫成 `[a, b]` 行內清單；YAML 與 Claude Code 都認得）。
    pub fn set_list(&mut self, key: &str, values: &[String]) {
        let items: Vec<String> = values.iter().map(|v| quote_item(v)).collect();
        self.set_line(key, format!("{key}: [{}]", items.join(", ")));
    }

    fn set_line(&mut self, key: &str, line: String) {
        let fm = self.fm.get_or_insert_with(Vec::new);
        match Self::key_span(fm, key) {
            Some((s, e)) => {
                fm.splice(s..e, [line]);
            }
            None => {
                // 接在最後一個非空行之後，不把新鍵放到結尾的空行下面。
                let at = fm.iter().rposition(|l| !l.trim().is_empty()).map(|i| i + 1).unwrap_or(0);
                fm.insert(at, line);
            }
        }
    }

    pub fn remove(&mut self, key: &str) {
        if let Some(fm) = &mut self.fm {
            if let Some((s, e)) = Self::key_span(fm, key) {
                fm.drain(s..e);
            }
        }
    }

    pub fn set_body(&mut self, body: &str) {
        self.body_raw = normalize(body);
    }

    /// 序列化回檔案內容（LF、結尾一個換行）。
    pub fn to_text(&self) -> String {
        let body = self.body_raw.trim_end_matches('\n');
        let mut s = String::new();
        if let Some(fm) = &self.fm {
            s.push_str("---\n");
            for l in fm {
                s.push_str(l);
                s.push('\n');
            }
            s.push_str("---\n");
        }
        s.push_str(body);
        s.push('\n');
        s
    }
}

pub fn field_str(f: &Map<String, Json>, key: &str) -> Option<String> {
    match f.get(key)? {
        Json::String(s) => Some(s.clone()),
        Json::Array(a) => Some(a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", ")),
        _ => None,
    }
}

pub fn field_list(f: &Map<String, Json>, key: &str) -> Vec<String> {
    match f.get(key) {
        Some(Json::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        Some(Json::String(s)) => split_list(s),
        _ => Vec::new(),
    }
}

pub fn field_bool(f: &Map<String, Json>, key: &str, dflt: bool) -> bool {
    match field_str(f, key).map(|s| s.trim().to_ascii_lowercase()) {
        None => dflt,
        Some(s) if s.is_empty() => dflt,
        Some(s) => matches!(s.as_str(), "true" | "yes" | "1" | "on"),
    }
}

fn needs_quote(v: &str) -> bool {
    v.is_empty()
        || v != v.trim()
        || v.contains('\n')
        || v.contains(": ")
        || v.contains(" #")
        || v.ends_with(':')
        || v.starts_with(['[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`', ',', '?'])
        || (v.starts_with('-') && v.chars().nth(1).is_none_or(char::is_whitespace))
}

fn json_quote(v: &str) -> String {
    let mut s = String::from("\"");
    for c in v.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\n' => s.push_str("\\n"),
            '\t' => s.push_str("\\t"),
            c => s.push(c),
        }
    }
    s.push('"');
    s
}

pub fn quote_scalar(v: &str) -> String {
    if needs_quote(v) { json_quote(v) } else { v.to_string() }
}

fn quote_item(v: &str) -> String {
    if needs_quote(v) || v.contains(',') || v.contains(']') || v.contains('[') { json_quote(v) } else { v.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_preserve_unknown_lines_and_order() {
        let src = "---\nname: x\n# 留著\nhooks:\n  PreToolUse:\n    - matcher: Bash\ndescription: old\nskills:\n  - a\n  - b\n---\nbody\n";
        let mut d = parse(src);
        d.set_str("description", "新的: 說明");
        d.set_list("skills", &["a".into(), "c".into()]);
        d.set_str("dbkit-title", "標題");
        let out = d.to_text();
        assert_eq!(
            out,
            "---\nname: x\n# 留著\nhooks:\n  PreToolUse:\n    - matcher: Bash\ndescription: \"新的: 說明\"\nskills: [a, c]\ndbkit-title: 標題\n---\nbody\n"
        );
        let f = parse(&out).fields();
        assert_eq!(field_str(&f, "description").unwrap(), "新的: 說明");
        assert_eq!(field_list(&f, "skills"), vec!["a", "c"]);
    }

    #[test]
    fn remove_and_body_roundtrip() {
        let mut d = parse("---\na: 1\nb: [x, y]\n---\n\nold body\n");
        d.remove("a");
        d.set_body("new\r\nbody\n\n");
        assert_eq!(d.to_text(), "---\nb: [x, y]\n---\nnew\nbody\n");
    }

    #[test]
    fn creates_frontmatter_when_missing() {
        let mut d = parse("just body");
        d.set_str("name", "n");
        assert_eq!(d.to_text(), "---\nname: n\n---\njust body\n");
    }

    #[test]
    fn quoting_rules() {
        assert_eq!(quote_scalar("plain text"), "plain text");
        assert_eq!(quote_scalar(""), "\"\"");
        assert_eq!(quote_scalar("- dash"), "\"- dash\"");
        assert_eq!(quote_scalar("a # b"), "\"a # b\"");
        assert_eq!(quote_item("a,b"), "\"a,b\"");
    }
}
