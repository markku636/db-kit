//! API 供應商專用的工具集：**只在助手工作資料夾內**的檔案讀寫與搜尋，
//! 加上 `dbtools` 的唯讀資料庫工具（有附帶連線時才出現）。
//!
//! CLI 後端用的是 Claude Code / Codex 內建的 Read / Glob / Grep / Write（由它們自己的權限機制
//! 限制），資料庫工具則透過 `dbk mcp` 提供；API 供應商沒有這些，所以自己實作一組同樣範圍的工具。
//! 刻意不提供 shell 與網路：助手的定位是「看資料庫、寫腳本」，不是通用 agent。
//!
//! 安全邊界只有一條、寫在 `safe_path`：路徑必須是工作資料夾底下的相對路徑，
//! 出現 `..` / 絕對路徑 / Windows 磁碟前綴一律拒絕。資料庫工具的唯讀守門在 `dbtools`。

use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Value};

use super::ToolSpec;
use crate::dbtools::{self, DbToolCtx, ToolOutcome};

/// 單檔讀取上限（超過截斷並註明）。
const MAX_READ: usize = 256 * 1024;
/// 列檔 / 搜尋的遞迴深度與筆數上限。
const MAX_DEPTH: usize = 5;
const MAX_LIST: usize = 500;
const MAX_HITS: usize = 200;

/// 依助手模式與連線給出可用工具。`agent` 模式才有寫檔；有連線才有資料庫工具。
pub fn specs(mode: &str, db: Option<&DbToolCtx>) -> Vec<ToolSpec> {
    let mut v = vec![
        ToolSpec {
            name: "read_file".into(),
            description: t!("讀取助手工作資料夾裡的一個檔案（相對路徑）。").to_string(),
            schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "相對於工作資料夾的檔案路徑" } },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "list_files".into(),
            description: t!("列出助手工作資料夾裡的檔案，可用 * 與 ? 萬用字元過濾。").to_string(),
            schema: json!({
                "type": "object",
                "properties": { "pattern": { "type": "string", "description": "如 *.sql；省略則列全部" } }
            }),
        },
        ToolSpec {
            name: "search_files".into(),
            description: t!("在助手工作資料夾的文字檔中搜尋字串，回傳檔名、行號與該行內容。").to_string(),
            schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "ignore_case": { "type": "boolean", "description": "預設 true" }
                },
                "required": ["query"]
            }),
        },
    ];
    if mode == "agent" {
        v.push(ToolSpec {
            name: "write_file".into(),
            description: t!("把內容寫進助手工作資料夾裡的檔案（會覆蓋同名檔，可建立子目錄）。").to_string(),
            schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
                "required": ["path", "content"]
            }),
        });
    }
    if let Some(ctx) = db {
        v.extend(dbtools::tool_defs(ctx.kind, ctx.prod).into_iter().map(|d| ToolSpec {
            name: d.name.to_string(),
            description: d.description,
            schema: d.input_schema,
        }));
    }
    v
}

/// 把相對路徑接到工作資料夾底下；任何逃逸寫法都回 Err。
///
/// 磁碟前綴（`C:/…`）自己判，不靠 `Path` 的平台語意：在 Linux 上 `C:/Windows/win.ini`
/// 被當成一個名叫 `C:` 的目錄，`is_absolute()` 是 false、components 也全是 Normal，
/// 於是同一段輸入在兩個平台得到不同結論。判準只該有一份，而且要是最嚴的那一份。
fn safe_path(workspace: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err(t!("path 不可為空").to_string());
    }
    if has_drive_prefix(&rel) {
        return Err(t!("路徑不可包含 .. 或磁碟前綴（限助手工作資料夾內）").to_string());
    }
    let p = Path::new(&rel);
    if p.is_absolute() || rel.starts_with('/') {
        return Err(t!("只能使用相對路徑（限助手工作資料夾內）").to_string());
    }
    for c in p.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(t!("路徑不可包含 .. 或磁碟前綴（限助手工作資料夾內）").to_string()),
        }
    }
    Ok(workspace.join(p))
}

/// `<字母>:` 開頭（Windows 磁碟前綴，含 UNC 的 `//server/share`）。平台無關。
fn has_drive_prefix(rel: &str) -> bool {
    if rel.starts_with("//") {
        return true; // UNC
    }
    let b = rel.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// `*` / `?` 萬用字元比對（大小寫不敏感）。只用於檔名過濾，故不支援字元類別。
fn wildcard(pat: &str, s: &str) -> bool {
    let p: Vec<char> = pat.to_lowercase().chars().collect();
    let t: Vec<char> = s.to_lowercase().chars().collect();
    // 經典 DP：dp[i][j] = pat 前 i 字元是否匹配 s 前 j 字元
    let mut dp = vec![vec![false; t.len() + 1]; p.len() + 1];
    dp[0][0] = true;
    for i in 1..=p.len() {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=p.len() {
        for j in 1..=t.len() {
            dp[i][j] = match p[i - 1] {
                '*' => dp[i - 1][j] || dp[i][j - 1],
                '?' => dp[i - 1][j - 1],
                c => dp[i - 1][j - 1] && c == t[j - 1],
            };
        }
    }
    dp[p.len()][t.len()]
}

/// 遞迴收集工作資料夾下的相對路徑（深度上限 MAX_DEPTH、筆數上限 MAX_LIST）。
fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_DEPTH || out.len() >= MAX_LIST {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= MAX_LIST {
            return;
        }
        let path = e.path();
        if path.is_dir() {
            walk(root, &path, depth + 1, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// 列出工作資料夾的檔案（相對路徑、已排序），可帶萬用字元。供工具與前端 `@file:` 補全共用。
pub fn list_files(workspace: &Path, pattern: &str) -> Vec<String> {
    let pattern = pattern.trim();
    let mut files = Vec::new();
    walk(workspace, workspace, 0, &mut files);
    if !pattern.is_empty() {
        files.retain(|f| {
            let base = f.rsplit('/').next().unwrap_or(f);
            wildcard(pattern, f) || wildcard(pattern, base)
        });
    }
    files.sort();
    files
}

/// 讀一個工作資料夾內的檔案（同 `read_file` 工具的上限與截斷規則）。
pub async fn read_file(workspace: &Path, rel: &str) -> Result<String, String> {
    let full = safe_path(workspace, rel)?;
    let data = tokio::fs::read(&full).await.map_err(|e| tf!("讀取失敗：{e}", e = e))?;
    let text = String::from_utf8_lossy(&data);
    if text.len() > MAX_READ {
        let cut: String = text.chars().take(MAX_READ / 4).collect();
        Ok(format!("{cut}\n…（檔案過大，已截斷）"))
    } else {
        Ok(text.to_string())
    }
}

/// 執行一支工具。回傳給模型看的純文字與 UI 摘要（工具失敗時回 Err，由迴圈標成 is_error）。
/// 資料庫工具轉交 `dbtools`；沒附帶連線時明講，讓模型改用檔案 / 對話內容回答。
pub async fn call(
    workspace: &Path,
    db: Option<&DbToolCtx>,
    name: &str,
    args: &Value,
    allow_write: bool,
) -> Result<ToolOutcome, String> {
    if dbtools::is_db_tool(name) {
        let ctx = db.ok_or_else(|| t!("此對話未附帶資料庫連線，無法使用資料庫工具").to_string())?;
        return dbtools::call(ctx, name, args).await;
    }
    let started = Instant::now();
    let (text, input_label) = call_file(workspace, name, args, allow_write).await?;
    Ok(ToolOutcome { text, input_label, ms: started.elapsed().as_millis() as u64, ..Default::default() })
}

async fn call_file(workspace: &Path, name: &str, args: &Value, allow_write: bool) -> Result<(String, Option<String>), String> {
    match name {
        "read_file" => {
            let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("");
            Ok((read_file(workspace, path).await?, Some(path.to_string())))
        }
        "list_files" => {
            let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("").trim().to_string();
            let files = list_files(workspace, &pattern);
            let label = if pattern.is_empty() { None } else { Some(pattern) };
            if files.is_empty() {
                Ok((t!("（工作資料夾裡沒有符合的檔案）").to_string(), label))
            } else {
                Ok((files.join("\n"), label))
            }
        }
        "search_files" => {
            let query = args.get("query").and_then(|q| q.as_str()).unwrap_or("").to_string();
            if query.trim().is_empty() {
                return Err(t!("query 不可為空").to_string());
            }
            let ignore_case = args.get("ignore_case").and_then(|b| b.as_bool()).unwrap_or(true);
            let needle = if ignore_case { query.to_lowercase() } else { query.clone() };
            let files = list_files(workspace, "");
            let mut hits = Vec::new();
            for f in files {
                if hits.len() >= MAX_HITS {
                    break;
                }
                let full = workspace.join(&f);
                let Ok(meta) = std::fs::metadata(&full) else { continue };
                if meta.len() > 1024 * 1024 {
                    continue;
                }
                let Ok(content) = tokio::fs::read(&full).await else { continue };
                let text = String::from_utf8_lossy(&content);
                for (i, line) in text.lines().enumerate() {
                    let hay = if ignore_case { line.to_lowercase() } else { line.to_string() };
                    if hay.contains(&needle) {
                        let short: String = line.trim().chars().take(200).collect();
                        hits.push(format!("{f}:{}: {short}", i + 1));
                        if hits.len() >= MAX_HITS {
                            break;
                        }
                    }
                }
            }
            if hits.is_empty() {
                Ok((tf!("（找不到「{query}」）", query = query), Some(query)))
            } else {
                Ok((hits.join("\n"), Some(query)))
            }
        }
        "write_file" => {
            if !allow_write {
                return Err(t!("目前是唯讀模式（advise），要寫檔請切到 agent 模式").to_string());
            }
            let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let content = args.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let full = safe_path(workspace, path)?;
            if let Some(parent) = full.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| tf!("建立目錄失敗：{e}", e = e))?;
            }
            tokio::fs::write(&full, content).await.map_err(|e| tf!("寫入失敗：{e}", e = e))?;
            Ok((tf!("已寫入 {path}（{n} 位元組）", path = path, n = content.len()), Some(path.to_string())))
        }
        other => Err(tf!("未知的工具：{name}", name = other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbKind;
    use crate::manager::ConnectionManager;
    use std::sync::Arc;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbkit-llm-tools-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ctx(kind: DbKind) -> DbToolCtx {
        DbToolCtx { manager: Arc::new(ConnectionManager::new()), conn_id: "c".into(), kind, database: None, prod: false }
    }

    #[test]
    fn safe_path_rejects_escapes() {
        let ws = tmp();
        assert!(safe_path(&ws, "a.sql").is_ok());
        assert!(safe_path(&ws, "sub/a.sql").is_ok());
        assert!(safe_path(&ws, "../a.sql").is_err());
        assert!(safe_path(&ws, "sub/../../a.sql").is_err());
        assert!(safe_path(&ws, "/etc/passwd").is_err());
        assert!(safe_path(&ws, "C:/Windows/win.ini").is_err());
        assert!(safe_path(&ws, "..\\a.sql").is_err());
        assert!(safe_path(&ws, "").is_err());
        // 平台無關：這些在 Linux 上的 Path 語意是「合法相對路徑」，仍必須擋下。
        assert!(safe_path(&ws, "c:\\temp\\x").is_err());
        assert!(safe_path(&ws, "//server/share/x").is_err());
        assert!(safe_path(&ws, "/etc/passwd").is_err());
    }

    #[test]
    fn wildcard_matches() {
        assert!(wildcard("*.sql", "a.sql"));
        assert!(wildcard("*.SQL", "a.sql"));
        assert!(!wildcard("*.sql", "a.txt"));
        assert!(wildcard("a?.sql", "ab.sql"));
        assert!(wildcard("*", "anything"));
        assert!(wildcard("sub/*.sql", "sub/a.sql"));
    }

    #[tokio::test]
    async fn write_requires_agent_mode() {
        let ws = tmp();
        let r = call(&ws, None, "write_file", &json!({ "path": "x.sql", "content": "select 1" }), false).await;
        assert!(r.is_err());
        let r2 = call(&ws, None, "write_file", &json!({ "path": "x.sql", "content": "select 1" }), true).await;
        assert!(r2.is_ok());
        let back = call(&ws, None, "read_file", &json!({ "path": "x.sql" }), true).await.unwrap();
        assert_eq!(back.text, "select 1");
        assert_eq!(back.input_label.as_deref(), Some("x.sql"));
        let _ = std::fs::remove_file(ws.join("x.sql"));
    }

    #[test]
    fn specs_gate_write_by_mode_and_db_by_ctx() {
        assert!(specs("advise", None).iter().all(|s| s.name != "write_file"));
        assert!(specs("agent", None).iter().any(|s| s.name == "write_file"));
        assert_eq!(specs("agent", None).len(), 4);
        // 有連線才出現資料庫工具，且依種類增減。
        let with_db = specs("advise", Some(&ctx(DbKind::Mysql)));
        assert!(with_db.iter().any(|s| s.name == "run_query"));
        assert_eq!(with_db.len(), 3 + crate::dbtools::TOOL_NAMES.len());
        let kafka = specs("advise", Some(&ctx(DbKind::Kafka)));
        assert!(!kafka.iter().any(|s| s.name == "run_query"));
    }

    #[tokio::test]
    async fn db_tool_without_ctx_explains() {
        let ws = tmp();
        let e = call(&ws, None, "run_query", &json!({ "query": "select 1" }), false).await.unwrap_err();
        assert!(e.contains("未附帶資料庫連線"));
    }
}
