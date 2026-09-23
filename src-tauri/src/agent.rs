//! 內建 AI 助手：驅動本機 `claude` 或 `codex` CLI（使用使用者的訂閱登入），
//! 以 headless 串流模式回答問題與撰寫腳本；或直接以 HTTP 打 Anthropic-compatible /
//! OpenAI-compatible 端點（見 `llm/`）。四種供應商共用同一組 `agent-stream` 事件，
//! 前端不需要分辨後端是誰。
//!
//! 設計取捨：
//! - CLI 後端用「訂閱（Claude Pro/Max、ChatGPT Plus/Pro 登入）」而非 API key，唯一可行路徑是呼叫
//!   官方 CLI，而非 Agent SDK 函式庫（SDK 需付費 API key，官方也不允許第三方走網頁登入）。
//! - API 後端則相反：不需要任何外部安裝，但工具得自己實作 —— CLI 那套內建工具（Read/Write/
//!   WebSearch…）在 HTTP 上不存在，改用 `llm::tools` 限定在助手工作資料夾內的檔案工具，
//!   且沒有網路搜尋。
//! - 串流方式對標 Redis Pub/Sub：背景任務逐行讀 stdout 的 NDJSON，
//!   以 `agent-stream` 事件推給前端；JoinHandle 存在 AppState 供取消。
//! - 兩家 CLI 的「限制副作用」機制不同，各自用它原生的那一套：
//!   * Claude Code：允許清單 + `dontAsk`，清單外工具一律自動拒絕（不卡住），
//!     故 shell（PowerShell / Bash）、所有 MCP、Task / Workflow 等都被擋；
//!     `advise`（預設）只放行唯讀 / 查資料工具，`agent` 額外放行寫檔工具。
//!   * Codex：OS 層沙箱 `--sandbox`，`advise` / `generate` 走 `read-only`（不可寫檔、不可連網），
//!     `agent` 走 `workspace-write` 並以 `--cd` 把可寫範圍綁在助手工作資料夾。
//!     注意這是「檔案系統層」而非「工具層」的限制：Codex 在 read-only 下仍可能執行唯讀指令。
//! - Codex 的 `exec --json` 沒有 token 級增量事件，整段回答會在 `item.completed` 一次到齊；
//!   Claude 走 `--include-partial-messages` 則是逐字串流。前端兩者都只是「附加文字」，無需分支。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::agent_setup::{self, Os};
use crate::commands::AppState;
use crate::dbtools::DbToolCtx;
use crate::error::{AppError, AppResult};

/// 掛給 CLI 供應商的 MCP 伺服器名稱（Claude 的工具名會變成 `mcp__dbkit__<tool>`）。
const MCP_SERVER_NAME: &str = "dbkit";
/// 工具結果給前端的預覽長度（字元），與 `llm::agent_loop` 同值。
const TOOL_PREVIEW_CHARS: usize = 600;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 支援的供應商。前端以字串傳入（"claude" / "codex" / "anthropic-api" / "openai-api"），
/// 未指定或不認得時預設 Claude（設錯字串不該讓整個助手掛掉）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Provider {
    Claude,
    Codex,
    AnthropicApi,
    OpenAiApi,
}

impl Provider {
    fn parse(s: Option<&str>) -> Provider {
        match s.map(str::trim) {
            Some("codex") => Provider::Codex,
            Some("anthropic-api") => Provider::AnthropicApi,
            Some("openai-api") => Provider::OpenAiApi,
            _ => Provider::Claude,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::AnthropicApi => "anthropic-api",
            Provider::OpenAiApi => "openai-api",
        }
    }

    /// 走 HTTP 的供應商回 `Some(kind)`；CLI 供應商回 `None`。
    fn llm_kind(self) -> Option<crate::llm::LlmKind> {
        match self {
            Provider::AnthropicApi => Some(crate::llm::LlmKind::Anthropic),
            Provider::OpenAiApi => Some(crate::llm::LlmKind::OpenAi),
            _ => None,
        }
    }

    /// 執行檔名稱（同時也是 `where` / `which` 的查找目標）。API 供應商沒有執行檔。
    fn exe(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            _ => "",
        }
    }

    /// 允許使用者以環境變數指定執行檔路徑（PATH 找不到、或想指定特定版本時）。
    fn bin_env(self) -> &'static str {
        match self {
            Provider::Claude => "DB_KIT_CLAUDE_BIN",
            Provider::Codex => "DB_KIT_CODEX_BIN",
            _ => "",
        }
    }
}

/// 解析後的 CLI 執行方式。npm 安裝的 `.cmd` shim 需透過 `cmd /C` 呼叫。
struct AgentBin {
    program: String,
    prefix: Vec<String>,
    display: String,
}

/// 偵測結果，回給前端決定是否顯示安裝 / 登入提示。
#[derive(Serialize)]
pub struct AgentStatus {
    provider: String,
    installed: bool,
    version: Option<String>,
    logged_in: bool,
    path: Option<String>,
    /// 資料庫工具的提供方式：HTTP 供應商為 `"builtin"`；CLI 供應商為找到的 `dbk` 路徑，
    /// 找不到為 `None`（前端據此顯示「需要 dbk」）。
    db_tools: Option<String>,
    /// 這台機器上的官方安裝指令（CLI 供應商才有）：面板照抄顯示，「在終端機安裝」跑的也是這一行。
    install_cmd: Option<String>,
}

/// 推送給前端的串流事件（事件名 `agent-stream`）。扁平結構，欄位依 kind 取捨。
#[derive(Clone, Serialize, Default, Debug, PartialEq)]
struct AgentEvent {
    req_id: String,
    /// "system" | "text" | "tool" | "tool_result" | "result" | "error" | "done"
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
    // ---- 工具呼叫細節（kind = tool / tool_result）：讓使用者看到助手跑了哪條 SQL、拿回幾列 ----
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_output_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_rows: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_ms: Option<u64>,
}

fn preview(s: &str) -> String {
    let mut p: String = s.chars().take(TOOL_PREVIEW_CHARS).collect();
    if s.chars().count() > TOOL_PREVIEW_CHARS {
        p.push('…');
    }
    p
}

/// 工具輸入的顯示字串：查詢類直接給 query / sql；其餘給緊湊 JSON。
fn tool_input_display(input: &serde_json::Value) -> Option<String> {
    for k in ["query", "sql", "table", "path"] {
        if let Some(s) = input.get(k).and_then(|v| v.as_str()) {
            let mut out = s.trim().to_string();
            if k == "table" {
                if let Some(db) = input.get("database").and_then(|v| v.as_str()).filter(|d| !d.trim().is_empty()) {
                    out = format!("{}.{}", db.trim(), out);
                }
            }
            return Some(out);
        }
    }
    match input {
        serde_json::Value::Object(m) if m.is_empty() => None,
        serde_json::Value::Null => None,
        other => Some(other.to_string()),
    }
}

/// `mcp__dbkit__run_query` / `dbkit:run_query` → `run_query`（前端徽章只要工具名）。
fn strip_mcp_prefix(name: &str) -> String {
    let n = name.strip_prefix("mcp__").unwrap_or(name);
    let n = match n.split_once("__") {
        Some((_, rest)) if name.starts_with("mcp__") => rest,
        _ => n,
    };
    match n.split_once(':') {
        Some((_, rest)) => rest.to_string(),
        None => n.to_string(),
    }
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// 依路徑判斷如何呼叫：Windows 的 `.cmd` / `.bat` 需經 `cmd /C`。
fn classify(path: String) -> AgentBin {
    let lower = path.to_lowercase();
    if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        AgentBin {
            program: "cmd".to_string(),
            prefix: vec!["/C".to_string(), path.clone()],
            display: path,
        }
    } else {
        AgentBin {
            program: path.clone(),
            prefix: Vec::new(),
            display: path,
        }
    }
}

/// 用 `where` / `which` 找執行檔；Windows 優先取 `.exe`（可直接 CreateProcess），
/// 略過 `.ps1`（無法直接執行）。
async fn which_bin(exe: &str) -> Option<String> {
    let prog = if cfg!(windows) { "where" } else { "which" };
    let mut c = Command::new(prog);
    c.arg(exe).stdin(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let out = c.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut fallback: Option<String> = None;
    for line in text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        let lower = line.to_lowercase();
        if cfg!(windows) {
            // 偏好可直接 CreateProcess 的 .exe；其次 cmd /C 可跑的 .cmd / .bat。
            // 略過 .ps1 與「無副檔名」的 shim（npm 安裝會有一個 bash shim，CreateProcess 無法執行）。
            if lower.ends_with(".exe") {
                return Some(line.to_string());
            }
            if (lower.ends_with(".cmd") || lower.ends_with(".bat")) && fallback.is_none() {
                fallback = Some(line.to_string());
            }
        } else if fallback.is_none() {
            fallback = Some(line.to_string());
        }
    }
    fallback
}

/// 各供應商的預設安裝位置（PATH 沒設好時的最後一搏）。
fn default_install_paths(provider: Provider, home: &std::path::Path) -> Vec<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{}.exe", provider.exe())
    } else {
        provider.exe().to_string()
    };
    match provider {
        Provider::Claude => vec![home.join(".local").join("bin").join(&exe)],
        // Codex 官方安裝器放 ~/.codex/bin；npm 全域安裝則多半已在 PATH 上。
        Provider::Codex => vec![
            home.join(".codex").join("bin").join(&exe),
            home.join(".local").join("bin").join(&exe),
        ],
        // API 供應商沒有執行檔。
        Provider::AnthropicApi | Provider::OpenAiApi => Vec::new(),
    }
}

/// 解析 CLI 執行檔：env 覆寫 → PATH 查找 → 預設安裝路徑。
async fn resolve_bin(provider: Provider) -> Option<AgentBin> {
    if let Ok(p) = std::env::var(provider.bin_env()) {
        if !p.trim().is_empty() {
            return Some(classify(p));
        }
    }
    if let Some(p) = which_bin(provider.exe()).await {
        return Some(classify(p));
    }
    if let Some(home) = home_dir() {
        for cand in default_install_paths(provider, &home) {
            if cand.exists() {
                return Some(classify(cand.to_string_lossy().to_string()));
            }
        }
    }
    None
}

/// 建立帶有「不彈出主控台視窗」（Windows）設定的指令。
fn make_cmd(bin: &AgentBin) -> Command {
    let mut c = Command::new(&bin.program);
    for a in &bin.prefix {
        c.arg(a);
    }
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

fn env_set(key: &str) -> bool {
    std::env::var(key)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

/// 是否已具備可用憑證：env 的 API key，或本機 CLI 的登入憑證檔。
fn logged_in(provider: Provider) -> bool {
    match provider {
        Provider::Claude => {
            if env_set("ANTHROPIC_API_KEY") {
                return true;
            }
            home_dir()
                .map(|h| h.join(".claude").join(".credentials.json").exists())
                .unwrap_or(false)
        }
        Provider::Codex => {
            if env_set("CODEX_API_KEY") || env_set("OPENAI_API_KEY") {
                return true;
            }
            // `codex login` 會把憑證寫進 $CODEX_HOME/auth.json（預設 ~/.codex）。
            let dir = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| home_dir().map(|h| h.join(".codex")));
            dir.map(|d| d.join("auth.json").exists()).unwrap_or(false)
        }
        // API 供應商：keychain / env 有金鑰即可用（地端端點另在 agent_detect 放行）。
        Provider::AnthropicApi | Provider::OpenAiApi => {
            provider.llm_kind().and_then(crate::llm::resolve_key).is_some()
        }
    }
}

async fn cli_version(bin: &AgentBin) -> Option<String> {
    let mut c = make_cmd(bin);
    c.arg("--version").stdin(Stdio::null());
    let out = c.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// 助手的工作資料夾（agent 模式寫腳本檔的位置）；放在設定目錄下，啟動即建立。
async fn workspace_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(tf!("無法取得設定目錄：{e}", e = e)))?
        .join("agent-workspace");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Storage(tf!("建立助手工作目錄失敗：{e}", e = e)))?;
    Ok(dir)
}

fn emit(app: &AppHandle, ev: AgentEvent) {
    let _ = app.emit("agent-stream", ev);
}

/// 用 OS 檔案總管開啟指定路徑（fire-and-forget；explorer 會回非零碼，不檢查）。
pub(crate) fn open_path(path: &std::path::Path) {
    #[cfg(windows)]
    let prog = "explorer";
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let prog = "xdg-open";
    let mut c = std::process::Command::new(prog);
    c.arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = c.spawn();
}

/// 在檔案總管開啟助手工作資料夾（agent 模式寫腳本檔的位置）。
#[tauri::command]
pub async fn open_agent_workspace(app: AppHandle) -> AppResult<()> {
    let dir = workspace_dir(&app).await?;
    open_path(&dir);
    Ok(())
}

/// 以系統預設瀏覽器開啟外部連結（僅允許 http/https；供助手回應中的連結點擊）。
#[tauri::command]
pub async fn open_external(url: String) -> AppResult<()> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(AppError::Query(
            t!("僅允許開啟 http / https 連結").to_string(),
        ));
    }
    #[cfg(windows)]
    {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", u]);
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(u).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(u).spawn();
    }
    Ok(())
}

// ---- Claude Code：stream-json 解析 ----

/// 解析單行 NDJSON 並轉成前端事件（純函式，方便測試；由呼叫端逐一 emit）。
/// CLI 的 stream-json 外層為包裝型別（system/assistant/user/result/stream_event），
/// 非原始 API 事件；token 級增量在 `--include-partial-messages` 的 `stream_event` 裡。
///
/// 工具呼叫的細節走兩條路：`stream_event.content_block_start` 先亮徽章（沒有輸入），
/// 完整的 `assistant` 訊息再補上 tool_use 的 id 與 input；`user` 訊息裡的 tool_result 給結果預覽。
fn claude_events(req: &str, line: &str) -> Vec<AgentEvent> {
    let mut out = Vec::new();
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let ev = |kind: &str| AgentEvent { req_id: req.to_string(), kind: kind.to_string(), ..Default::default() };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") => {
            if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                let session_id = v.get("session_id").and_then(|s| s.as_str()).map(String::from);
                let model = v
                    .get("model")
                    .and_then(|m| m.as_str())
                    .or_else(|| v.get("data").and_then(|d| d.get("model")).and_then(|m| m.as_str()))
                    .map(String::from);
                out.push(AgentEvent { session_id, model, ..ev("system") });
            }
        }
        Some("stream_event") => {
            let Some(e) = v.get("event") else { return out };
            match e.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    if let Some(d) = e.get("delta") {
                        if d.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                            if let Some(t) = d.get("text").and_then(|t| t.as_str()) {
                                out.push(AgentEvent { text: Some(t.to_string()), ..ev("text") });
                            }
                        }
                    }
                }
                Some("content_block_start") => {
                    if let Some(cb) = e.get("content_block") {
                        if cb.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                            let name = cb.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            out.push(AgentEvent {
                                tool: Some(strip_mcp_prefix(name)),
                                tool_id: cb.get("id").and_then(|i| i.as_str()).map(String::from),
                                ..ev("tool")
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        // 完整的助理訊息：補上每個 tool_use 的 id 與輸入（串流開頭事件拿不到 input）。
        Some("assistant") => {
            for cb in content_blocks(&v) {
                if cb.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                    continue;
                }
                let name = cb.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                out.push(AgentEvent {
                    tool: Some(strip_mcp_prefix(name)),
                    tool_id: cb.get("id").and_then(|i| i.as_str()).map(String::from),
                    tool_input: cb.get("input").and_then(tool_input_display),
                    ..ev("tool")
                });
            }
        }
        // 工具結果（CLI 把它包成 user 訊息）：給前端結果預覽，SQL 有沒有跑成功一眼可見。
        Some("user") => {
            for cb in content_blocks(&v) {
                if cb.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                let text = tool_result_text(cb.get("content"));
                let is_error = cb.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                out.push(AgentEvent {
                    tool_id: cb.get("tool_use_id").and_then(|i| i.as_str()).map(String::from),
                    tool_output_preview: Some(preview(&text)),
                    is_error: Some(is_error),
                    ..ev("tool_result")
                });
            }
        }
        Some("result") => {
            let session_id = v.get("session_id").and_then(|s| s.as_str()).map(String::from);
            let is_error = v.get("is_error").and_then(|b| b.as_bool());
            let text = v.get("result").and_then(|s| s.as_str()).map(String::from);
            let duration_ms = v.get("duration_ms").and_then(|d| d.as_u64());
            out.push(AgentEvent { session_id, is_error, text, duration_ms, ..ev("result") });
        }
        _ => {}
    }
    out
}

/// `message.content[]`（找不到回空）。
fn content_blocks(v: &serde_json::Value) -> Vec<&serde_json::Value> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

/// tool_result 的 content 可能是字串或 `[{type:"text",text}]` 陣列；取出純文字。
fn tool_result_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn parse_claude_line(app: &AppHandle, req: &str, line: &str) {
    for e in claude_events(req, line) {
        emit(app, e);
    }
}

// ---- Codex：exec --json 解析 ----

/// 一次 Codex turn 的累積狀態（thread id 與最後一則訊息，供 result 事件回填）。
#[derive(Default)]
struct CodexTurn {
    session_id: Option<String>,
    last_text: Option<String>,
}

/// Codex 的 item.type → 前端工具標籤。agent_message / reasoning 不算工具（回傳 None）。
fn codex_tool_label(kind: &str) -> Option<&'static str> {
    match kind {
        "command_execution" => Some("Command"),
        "file_change" => Some("Edit"),
        "mcp_tool_call" => Some("MCP"),
        "web_search" => Some("WebSearch"),
        "todo_list" => Some("Plan"),
        _ => None,
    }
}

/// MCP 工具項目的顯示名：`item.tool`（去掉伺服器前綴）；拿不到退回 "MCP"。
fn codex_mcp_tool_name(item: &serde_json::Value) -> String {
    item.get("tool")
        .or_else(|| item.get("name"))
        .and_then(|t| t.as_str())
        .map(strip_mcp_prefix)
        .unwrap_or_else(|| "MCP".to_string())
}

/// 解析 `codex exec --json` 的單行 JSONL（純函式，方便測試）。
/// 事件族：thread.started / turn.started / turn.completed / turn.failed / item.* / error。
/// 與 Claude 最大的差異是「沒有 token 級增量」：整段回答在 item.completed 一次給完。
/// 欄位名依 Codex 公開輸出格式；解析一律寬鬆（拿不到就略過），版本差異不至於讓整輪失敗。
fn codex_events(req: &str, line: &str, st: &mut CodexTurn, started: Instant) -> Vec<AgentEvent> {
    let mut out = Vec::new();
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let Some(kind) = v.get("type").and_then(|t| t.as_str()) else { return out };
    let ev = |kind: &str| AgentEvent { req_id: req.to_string(), kind: kind.to_string(), ..Default::default() };
    match kind {
        "thread.started" => {
            let id = v.get("thread_id").and_then(|s| s.as_str()).map(String::from);
            st.session_id = id.clone();
            out.push(AgentEvent { session_id: id, ..ev("system") });
        }
        "item.started" => {
            let Some(item) = v.get("item") else { return out };
            let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if item_type == "mcp_tool_call" {
                out.push(AgentEvent {
                    tool: Some(codex_mcp_tool_name(item)),
                    tool_id: item.get("id").and_then(|i| i.as_str()).map(String::from),
                    tool_input: item.get("arguments").and_then(tool_input_display),
                    ..ev("tool")
                });
            } else if let Some(label) = codex_tool_label(item_type) {
                out.push(AgentEvent { tool: Some(label.to_string()), ..ev("tool") });
            }
        }
        "item.completed" => {
            let Some(item) = v.get("item") else { return out };
            match item.get("type").and_then(|t| t.as_str()) {
                // 只把 agent_message 當回答內容；reasoning 與工具項目不進聊天氣泡。
                Some("agent_message") => {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        if text.is_empty() {
                            return out;
                        }
                        st.last_text = Some(text.to_string());
                        out.push(AgentEvent { text: Some(text.to_string()), ..ev("text") });
                    }
                }
                // MCP 工具結果：給前端預覽（result 可能是字串 / 物件 / content 陣列）。
                Some("mcp_tool_call") => {
                    let err = item.get("error").map(|e| match e {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.get("message").and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| other.to_string()),
                    });
                    let text = match (&err, item.get("result")) {
                        (Some(e), _) => e.clone(),
                        (None, Some(r)) => {
                            let inner = r.get("content").or(Some(r));
                            match inner {
                                Some(serde_json::Value::Array(_)) => tool_result_text(inner),
                                Some(serde_json::Value::String(s)) => s.clone(),
                                Some(other) => other.to_string(),
                                None => String::new(),
                            }
                        }
                        (None, None) => String::new(),
                    };
                    out.push(AgentEvent {
                        tool: Some(codex_mcp_tool_name(item)),
                        tool_id: item.get("id").and_then(|i| i.as_str()).map(String::from),
                        tool_output_preview: Some(preview(&text)),
                        is_error: Some(err.is_some() || item.get("status").and_then(|s| s.as_str()) == Some("failed")),
                        ..ev("tool_result")
                    });
                }
                _ => {}
            }
        }
        "turn.completed" | "turn.failed" => {
            let failed = kind == "turn.failed";
            let text = if failed {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .or_else(|| v.get("message"))
                    .and_then(|m| m.as_str())
                    .map(String::from)
                    .or_else(|| Some(t!("Codex 回合失敗").to_string()))
            } else {
                st.last_text.clone()
            };
            out.push(AgentEvent {
                session_id: st.session_id.clone(),
                is_error: Some(failed),
                text,
                duration_ms: Some(started.elapsed().as_millis() as u64),
                ..ev("result")
            });
        }
        "error" => {
            let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
            out.push(AgentEvent { text: Some(msg), ..ev("error") });
        }
        _ => {}
    }
    out
}

fn parse_codex_line(app: &AppHandle, req: &str, line: &str, st: &mut CodexTurn, started: Instant) {
    for e in codex_events(req, line, st, started) {
        emit(app, e);
    }
}

// ---- 指令組裝 ----

/// 掛給 CLI 供應商的 `dbk mcp` 伺服器描述。每次送出各建一份 Claude 用的設定檔，跑完即刪。
struct McpAttach {
    /// Claude：`--mcp-config` 指向的 JSON 檔。
    config_path: PathBuf,
    /// dbk 執行檔與參數（Codex 以 `-c mcp_servers.dbkit.*` 直接帶）。
    command: String,
    args: Vec<String>,
    /// 此連線種類有的工具名（決定 Claude `--allowedTools` 要放行哪些 `mcp__dbkit__<name>`）。
    tool_names: Vec<&'static str>,
}

/// 一次性語句生成 / 改寫 / 執行前審查：零工具、單回合，不掛 MCP。
fn is_one_shot_mode(mode: &str) -> bool {
    matches!(mode, "generate" | "edit" | "review")
}

/// 由助手模式推導 Claude 的 CLI 旗標：採「允許清單 + dontAsk」而非黑名單。
/// dontAsk 會自動拒絕清單外的所有工具（不會卡住等待輸入），
/// 因此 shell（Windows 是 PowerShell、類 Unix 是 Bash）、其他 MCP 伺服器、
/// Task / Workflow / Skill 等一律被擋下，與平台無關。只有我們自己掛的 `dbkit` MCP 工具會被逐一放行。
fn claude_flags_for_mode(mode: &str) -> (&'static str, &'static str) {
    // (permission_mode, allowed_tools)
    match mode {
        // 可寫腳本檔：額外放行寫檔 / 改檔（限工作資料夾），仍不放行 shell。
        "agent" => (
            "dontAsk",
            "Read,Glob,Grep,Write,Edit,MultiEdit,WebSearch,WebFetch",
        ),
        // 一次性語句生成 / 改寫（NL→SQL / NL→ES DSL / 編輯器改寫）：零工具、單回合，回覆即語句。
        // 空 allowedTools + dontAsk → 清單外一律自動拒絕（見下方 agent_send 略過旗標）。
        "generate" | "edit" | "review" => ("dontAsk", ""),
        // 純問答 / 產生腳本文字（預設）：只放行唯讀與查資料工具。
        _ => ("dontAsk", "Read,Glob,Grep,WebSearch,WebFetch"),
    }
}

/// Codex 的沙箱層級：只有 agent 模式需要寫檔，其餘一律唯讀（連網也一併被擋）。
fn codex_sandbox_for_mode(mode: &str) -> &'static str {
    if mode == "agent" {
        "workspace-write"
    } else {
        "read-only"
    }
}

fn claude_args(
    mode: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    system_prompt: Option<&str>,
    mcp: Option<&McpAttach>,
) -> Vec<String> {
    let (perm, allowed) = claude_flags_for_mode(mode);
    let mut a: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--permission-mode".into(),
        perm.into(),
    ];
    // 一次性模式不掛 MCP（零工具）。
    let mcp = mcp.filter(|_| !is_one_shot_mode(mode));
    let mut allowed_list: Vec<String> = allowed.split(',').filter(|s| !s.is_empty()).map(String::from).collect();
    if let Some(m) = mcp {
        allowed_list.extend(m.tool_names.iter().map(|n| format!("mcp__{MCP_SERVER_NAME}__{n}")));
    }
    // 空 allowedTools（generate / edit 模式）略過該旗標：dontAsk 下未列入允許者一律自動拒絕，
    // 行為等價「全拒」，且避開 CLI 對空字串引數的解析歧義。
    if !allowed_list.is_empty() {
        a.push("--allowedTools".into());
        a.push(allowed_list.join(","));
    }
    if let Some(m) = mcp {
        a.push("--mcp-config".into());
        a.push(m.config_path.to_string_lossy().to_string());
        // 只用我們給的伺服器：使用者自己的 ~/.claude.json / 專案 .mcp.json 不併入（那些不在允許清單，
        // 掛了也只是白啟動幾個子程序）。
        a.push("--strict-mcp-config".into());
    }
    // 一次性語句生成：限單回合（防守性——即使模型嘗試 tool call 被拒也不會進入多回合重試）。
    if is_one_shot_mode(mode) {
        a.push("--max-turns".into());
        a.push("1".into());
    }
    if let Some(sid) = session_id {
        a.push("--resume".into());
        a.push(sid.into());
    }
    if let Some(m) = model {
        a.push("--model".into());
        a.push(m.into());
    }
    // 人設 / 技能：接在 CLI 自己的系統提示之後（不取代它，那會弄壞 Claude Code 的工具行為）。
    if let Some(sp) = system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        a.push("--append-system-prompt".into());
        a.push(sp.into());
    }
    a
}

/// TOML 字串字面值：能用單引號（literal string，反斜線不需跳脫，Windows 路徑最友善）就用；
/// 內含單引號或換行才退回雙引號 basic string。
fn toml_string(s: &str) -> String {
    if !s.contains('\'') && !s.contains('\n') && !s.contains('\r') {
        format!("'{s}'")
    } else {
        let esc = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r");
        format!("\"{esc}\"")
    }
}

fn codex_args(
    mode: &str,
    workspace: &Path,
    session_id: Option<&str>,
    model: Option<&str>,
    mcp: Option<&McpAttach>,
) -> Vec<String> {
    let mut a: Vec<String> = vec!["exec".into()];
    // 多輪對話：`codex exec resume <THREAD_ID>` 接續同一個 thread。
    if let Some(sid) = session_id {
        a.push("resume".into());
        a.push(sid.into());
    }
    a.push("--json".into());
    // 工作資料夾不是 git repo，Codex 預設會拒跑，需明確略過檢查。
    a.push("--skip-git-repo-check".into());
    a.push("--sandbox".into());
    a.push(codex_sandbox_for_mode(mode).into());
    a.push("--cd".into());
    a.push(workspace.to_string_lossy().to_string());
    // MCP 伺服器以 `-c` 覆寫設定帶入（不動使用者的 ~/.codex/config.toml）。值以 TOML 字面值給。
    if let Some(m) = mcp.filter(|_| !is_one_shot_mode(mode)) {
        a.push("-c".into());
        a.push(format!("mcp_servers.{MCP_SERVER_NAME}.command={}", toml_string(&m.command)));
        let args_toml = m.args.iter().map(|s| toml_string(s)).collect::<Vec<_>>().join(", ");
        a.push("-c".into());
        a.push(format!("mcp_servers.{MCP_SERVER_NAME}.args=[{args_toml}]"));
    }
    if let Some(m) = model {
        a.push("--model".into());
        a.push(m.into());
    }
    // `-` = 由 stdin 讀提示（同 Claude，避開 Windows 命令列長度上限與引號轉義）。
    a.push("-".into());
    a
}

/// Codex 沒有等價於 `--append-system-prompt` 的旗標，人設只能併進提示本文最前面。
fn prepend_system(prompt: &str, system_prompt: Option<&str>) -> String {
    match system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sp) => format!("[人設與技能]\n{sp}\n\n[問題]\n{prompt}"),
        None => prompt.to_string(),
    }
}

// ---- 資料庫工具：連線上下文、系統提示、dbk MCP ----

/// 由前端帶來的 connection_id / database 建立工具上下文。一次性模式、沒給 id、或該連線未連線
/// 時回 None（沒有資料庫工具，其餘照常）。
fn db_ctx(state: &AppState, mode: &str, connection_id: Option<&str>, database: Option<&str>) -> Option<DbToolCtx> {
    if is_one_shot_mode(mode) {
        return None;
    }
    let id = connection_id.map(str::trim).filter(|s| !s.is_empty())?;
    DbToolCtx::from_manager(state.manager.clone(), id, database).ok()
}

/// 給模型的工具使用指引（接在人設 / 技能之後）。不含主機 / 帳密，只講「有哪些工具、怎麼用」。
fn db_tools_guidance(ctx: &DbToolCtx, via_mcp: bool) -> String {
    let names = crate::dbtools::tool_defs(ctx.kind, ctx.prod)
        .into_iter()
        .map(|d| if via_mcp { format!("mcp__{MCP_SERVER_NAME}__{}", d.name) } else { d.name.to_string() })
        .collect::<Vec<_>>()
        .join(" / ");
    let target = match &ctx.database {
        Some(db) => tf!("{kind} 連線，目前資料庫：{db}", kind = ctx.kind.as_str(), db = db),
        None => tf!("{kind} 連線", kind = ctx.kind.as_str()),
    };
    let mut s = tf!(
        "【資料庫工具】你可以用這些工具直接讀取使用者目前在 db-kit 的 {target}：{names}。全部唯讀。寫查詢前先用 describe_table 確認欄名與型別；查詢一律加 LIMIT；不要猜測不存在的表或欄位，先 list_tables。需要看資料時直接呼叫工具，不要請使用者代跑；回答時附上你實際執行的查詢。",
        target = target,
        names = names
    );
    if ctx.prod {
        s.push(' ');
        s.push_str(&t!("此連線是正式環境：查詢保持輕量（小 LIMIT、避免全表掃描、不要重複同一條查詢）。"));
    }
    s
}

/// 人設 / 技能 + 工具指引合成系統提示（兩者都可能沒有）。
fn compose_system(user: Option<&str>, guidance: Option<&str>) -> Option<String> {
    let u = user.map(str::trim).filter(|s| !s.is_empty());
    let g = guidance.map(str::trim).filter(|s| !s.is_empty());
    match (u, g) {
        (None, None) => None,
        (Some(u), None) => Some(u.to_string()),
        (None, Some(g)) => Some(g.to_string()),
        (Some(u), Some(g)) => Some(format!("{u}\n\n{g}")),
    }
}

/// 找 `dbk` 執行檔：env 覆寫 → 與 GUI 同目錄（打包 sidecar）→ PATH → 開發用 target 目錄。
async fn resolve_dbk_bin() -> Option<String> {
    if let Ok(p) = std::env::var("DB_KIT_DBK_BIN") {
        let p = p.trim();
        if !p.is_empty() && Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    let exe = if cfg!(windows) { "dbk.exe" } else { "dbk" };
    if let Ok(cur) = std::env::current_exe() {
        if let Some(dir) = cur.parent() {
            let cand = dir.join(exe);
            if cand.exists() {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }
    if let Some(p) = which_bin("dbk").await {
        return Some(p);
    }
    // 開發模式：cargo 的 target 目錄（`cargo build --bin dbk --no-default-features`）。
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for profile in ["debug", "release"] {
        let cand = manifest.join("target").join(profile).join(exe);
        if cand.exists() {
            return Some(cand.to_string_lossy().to_string());
        }
    }
    None
}

/// `dbk mcp` 的參數：以連線 id 指定（GUI 存的就是 id）、帶目前資料庫與介面語言。不含任何帳密。
fn dbk_mcp_args(ctx: &DbToolCtx) -> Vec<String> {
    let mut a = vec!["mcp".to_string(), "--conn".to_string(), ctx.conn_id.clone()];
    if let Some(db) = &ctx.database {
        a.push("-d".to_string());
        a.push(db.clone());
    }
    a.push("--lang".to_string());
    a.push(crate::i18n::current().as_code().to_string());
    a
}

/// Claude 的 `--mcp-config` 檔內容。
fn mcp_config_json(command: &str, args: &[String]) -> serde_json::Value {
    serde_json::json!({
        "mcpServers": {
            MCP_SERVER_NAME: { "command": command, "args": args }
        }
    })
}

/// 準備 MCP 掛載：找 dbk、寫設定檔。找不到 dbk 回 None（助手照常運作，只是沒有資料庫工具）。
async fn mcp_attach(app: &AppHandle, ctx: &DbToolCtx, req_id: &str) -> Option<McpAttach> {
    let command = resolve_dbk_bin().await?;
    let args = dbk_mcp_args(ctx);
    let dir = app.path().app_config_dir().ok()?.join("agent-mcp");
    tokio::fs::create_dir_all(&dir).await.ok()?;
    let config_path = dir.join(format!("{}.json", crate::schema_cache::sanitize_id(req_id)));
    let body = serde_json::to_vec_pretty(&mcp_config_json(&command, &args)).ok()?;
    tokio::fs::write(&config_path, body).await.ok()?;
    let tool_names = crate::dbtools::tool_defs(ctx.kind, ctx.prod).into_iter().map(|d| d.name).collect();
    Some(McpAttach { config_path, command, args, tool_names })
}

// ---- Tauri 指令 ----

#[tauri::command]
pub async fn agent_detect(provider: Option<String>, base_url: Option<String>) -> AgentStatus {
    let p = Provider::parse(provider.as_deref());
    // API 供應商沒有執行檔可偵測：有 Base URL 就算「裝好了」，有金鑰（或是地端端點）算「已登入」。
    if let Some(kind) = p.llm_kind() {
        let cfg = crate::llm::LlmConfig::resolve(kind, base_url.as_deref(), None);
        return AgentStatus {
            provider: p.id().to_string(),
            installed: !cfg.base.is_empty(),
            version: None,
            logged_in: cfg.api_key.is_some() || cfg.is_local(),
            path: if cfg.base.is_empty() { None } else { Some(cfg.base) },
            // HTTP 供應商的資料庫工具內建在 Rust 工具迴圈裡，不需要外部程式。
            db_tools: Some("builtin".to_string()),
            install_cmd: None,
        };
    }
    // CLI 供應商的資料庫工具靠 `dbk mcp`；一併回報找得到與否，讓面板能提示「需要 dbk」。
    let db_tools = resolve_dbk_bin().await;
    let install_cmd = agent_setup::install_command(p.id(), Os::current()).map(String::from);
    match resolve_bin(p).await {
        Some(bin) => {
            let version = cli_version(&bin).await;
            AgentStatus {
                provider: p.id().to_string(),
                installed: version.is_some(),
                version,
                logged_in: logged_in(p),
                path: Some(bin.display),
                db_tools,
                install_cmd,
            }
        }
        None => AgentStatus {
            provider: p.id().to_string(),
            installed: false,
            version: None,
            logged_in: logged_in(p),
            path: None,
            db_tools,
            install_cmd,
        },
    }
}

/// 開一個看得見的終端機視窗，跑官方安裝指令（`action = "install"`）或登入（`"login"`）。
/// 指令由後端決定（見 `agent_setup`），前端只選供應商與動作；只負責開窗，不等它跑完 ——
/// 前端在使用者切回 App 時重新偵測。
#[tauri::command]
pub async fn agent_setup_terminal(provider: Option<String>, action: String) -> AppResult<()> {
    let p = Provider::parse(provider.as_deref());
    let os = Os::current();
    let command = match action.as_str() {
        "install" => agent_setup::install_command(p.id(), os).map(String::from),
        "login" => match resolve_bin(p).await {
            Some(bin) => agent_setup::login_command(p.id(), &bin.display, os),
            None => {
                return Err(AppError::Query(tf!("找不到 {cli} CLI，請先安裝並以你的訂閱帳號登入", cli = p.exe())));
            }
        },
        _ => None,
    }
    .ok_or_else(|| AppError::Query(t!("這個供應商不需要在終端機安裝或登入").to_string()))?;
    let home = home_dir().unwrap_or_else(std::env::temp_dir);
    let script = agent_setup::terminal_script(
        &command,
        &t!("指令已結束。沒有錯誤的話，回到 DB Kit 就會自動重新偵測；這個視窗可以關掉。"),
        os,
    );
    agent_setup::open_terminal(&script, &home, &std::env::temp_dir()).map_err(|e| {
        AppError::Query(tf!("無法開啟終端機（{e}），請自行在終端機執行：{cmd}", e = e, cmd = command))
    })
}

/// 送出一次問答（多輪以 session_id 串接：Claude 走 `--resume`、Codex 走 `exec resume`）。
/// 立即回傳；輸出以 `agent-stream` 事件串流，直到 `done`。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_send(
    app: AppHandle,
    state: State<'_, AppState>,
    req_id: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    provider: Option<String>,
    base_url: Option<String>,
    system_prompt: Option<String>,
    connection_id: Option<String>,
    database: Option<String>,
) -> AppResult<()> {
    let p = Provider::parse(provider.as_deref());
    let workspace = workspace_dir(&app).await?;
    let mode = mode.unwrap_or_else(|| "advise".to_string());
    let sid = session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let model = model.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let sys = system_prompt.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // 前端附帶的連線 → 資料庫工具上下文（一次性模式 / 未連線時為 None）。
    let db = db_ctx(&state, &mode, connection_id.as_deref(), database.as_deref());

    // ---- HTTP 供應商：不開子程序，直接跑工具迴圈 ----
    if let Some(kind) = p.llm_kind() {
        let guidance = db.as_ref().map(|c| db_tools_guidance(c, false));
        let sys = compose_system(sys, guidance.as_deref());
        return llm_send(app, state, req_id, prompt, sid, model, &mode, kind, base_url.as_deref(), sys.as_deref(), workspace, db).await;
    }

    let bin = resolve_bin(p).await.ok_or_else(|| {
        AppError::Query(tf!(
            "找不到 {cli} CLI，請先安裝並以你的訂閱帳號登入",
            cli = p.exe()
        ))
    })?;

    // CLI 供應商的資料庫工具走 `dbk mcp`：找得到 dbk 才掛；找不到照常回答（前端另有提示）。
    let mcp = match &db {
        Some(c) => mcp_attach(&app, c, &req_id).await,
        None => None,
    };
    let guidance = match (&db, &mcp) {
        (Some(c), Some(_)) => Some(db_tools_guidance(c, matches!(p, Provider::Claude))),
        _ => None,
    };
    let sys_full = compose_system(sys, guidance.as_deref());
    let sys = sys_full.as_deref();

    // Codex 沒有 append-system-prompt，人設併進提示本文。
    let prompt = match p {
        Provider::Codex => prepend_system(&prompt, sys),
        _ => prompt,
    };

    let args = match p {
        Provider::Claude => claude_args(&mode, sid, model, sys, mcp.as_ref()),
        Provider::Codex => codex_args(&mode, &workspace, sid, model, mcp.as_ref()),
        // 上面已提前 return，這裡到不了。
        Provider::AnthropicApi | Provider::OpenAiApi => unreachable!(),
    };
    let mcp_config = mcp.map(|m| m.config_path);

    let mut cmd = make_cmd(&bin);
    for a in &args {
        cmd.arg(a);
    }
    cmd.current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Query(tf!("啟動 {cli} 失敗：{e}", cli = p.exe(), e = e)))?;

    // 提示由 stdin 餵入（避免 Windows 命令列長度上限與引號轉義問題），寫完即 EOF。
    if let Some(mut stdin) = child.stdin.take() {
        let pr = prompt;
        tokio::spawn(async move {
            let _ = stdin.write_all(pr.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // 同 id 的舊任務先收掉（理論上不會發生，req_id 每次唯一）。
    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }

    let app2 = app.clone();
    let req2 = req_id.clone();
    let jobs = state.agent_jobs.clone();
    let cli_name = p.exe();
    let handle = tauri::async_runtime::spawn(async move {
        // 並行排空 stderr，避免管線塞滿造成死結。
        let err_task = tokio::spawn(async move {
            let mut s = String::new();
            let mut rd = BufReader::new(stderr);
            let _ = rd.read_to_string(&mut s).await;
            s
        });

        let started = Instant::now();
        let mut turn = CodexTurn::default();
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if !line.trim().is_empty() {
                        match p {
                            Provider::Codex => {
                                parse_codex_line(&app2, &req2, &line, &mut turn, started)
                            }
                            // Claude 與（到不了的）API 供應商都走 stream-json 解析。
                            _ => parse_claude_line(&app2, &req2, &line),
                        }
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }

        let status = child.wait().await;
        let err = err_task.await.unwrap_or_default();
        // MCP 設定檔是一次性的（內含連線 id 與 dbk 路徑，不含帳密）；子程序結束即清掉。
        if let Some(pth) = &mcp_config {
            let _ = tokio::fs::remove_file(pth).await;
        }
        let code = status.ok().and_then(|s| s.code());
        if let Some(c) = code {
            if c != 0 {
                let msg = if err.trim().is_empty() {
                    tf!("{cli} 以結束碼 {c} 退出", cli = cli_name, c = c)
                } else {
                    err.trim().to_string()
                };
                emit(
                    &app2,
                    AgentEvent {
                        req_id: req2.clone(),
                        kind: "error".to_string(),
                        text: Some(msg),
                        ..Default::default()
                    },
                );
            }
        }
        emit(
            &app2,
            AgentEvent {
                req_id: req2.clone(),
                kind: "done".to_string(),
                code,
                ..Default::default()
            },
        );
        jobs.lock().remove(&req2);
    });
    state.agent_jobs.lock().insert(req_id, handle);
    Ok(())
}

/// 取消進行中的問答：abort 背景任務 → CLI 走 kill_on_drop 終止子程序、
/// API 走 drop 掉 reqwest 串流關閉連線。
#[tauri::command]
pub async fn agent_cancel(state: State<'_, AppState>, req_id: String) -> AppResult<()> {
    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }
    Ok(())
}

// ---- HTTP 供應商 ----

/// API 供應商的送出路徑：先回應前端（`system` 事件帶自產的 session id），
/// 再於背景跑工具迴圈，逐字送 `text`，收尾送 `result` + `done`。
#[allow(clippy::too_many_arguments)]
async fn llm_send(
    app: AppHandle,
    state: State<'_, AppState>,
    req_id: String,
    prompt: String,
    session_id: Option<&str>,
    model: Option<&str>,
    mode: &str,
    kind: crate::llm::LlmKind,
    base_url: Option<&str>,
    system_prompt: Option<&str>,
    workspace: PathBuf,
    db: Option<DbToolCtx>,
) -> AppResult<()> {
    let cfg = crate::llm::LlmConfig::resolve(kind, base_url, model);
    if cfg.base.is_empty() {
        return Err(AppError::Query(t!("尚未設定 API Base URL").to_string()));
    }
    if cfg.model.trim().is_empty() {
        return Err(AppError::Query(t!("尚未指定模型").to_string()));
    }

    // HTTP 沒有伺服器端 session，對話歷史存在 App 記憶體裡，id 由這裡產。
    let sid = session_id.map(String::from).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let config_dir = crate::store::app_config_dir(&app).ok();
    // 記憶體沒有、但前端帶了既有 session id → 從磁碟接回來（App 重開後的續聊）。
    // 讀失敗一律當成「沒有歷史」，見 llm::sessions 的模組說明。
    let cached = state.llm_sessions.lock().get(&sid).cloned();
    let mut history = match (cached, session_id, &config_dir) {
        (Some(h), _, _) => h,
        (None, Some(_), Some(dir)) => crate::llm::sessions::load_in(dir, &sid).await.map(|f| f.messages).unwrap_or_default(),
        _ => Vec::new(),
    };

    emit(
        &app,
        AgentEvent {
            req_id: req_id.clone(),
            kind: "system".to_string(),
            session_id: Some(sid.clone()),
            model: Some(cfg.model.clone()),
            ..Default::default()
        },
    );

    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }

    let app2 = app.clone();
    let req2 = req_id.clone();
    let jobs = state.agent_jobs.clone();
    let sessions = state.llm_sessions.clone();
    let mode = mode.to_string();
    let system_prompt = system_prompt.map(String::from);
    // 一次性模式沒有 session 可以續（前端每次都帶 sessionId = null），落地只會堆出一次一檔的歷史；
    // 而審查提示可能夾帶前像樣本資料，更不該留在設定目錄裡。
    let persist_dir = if is_one_shot_mode(&mode) { None } else { config_dir.clone() };
    let persist_provider = match cfg.kind {
        crate::llm::LlmKind::Anthropic => "anthropic-api",
        crate::llm::LlmKind::OpenAi => "openai-api",
    };
    let persist_model = cfg.model.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let sink_app = app2.clone();
        let sink_req = req2.clone();
        let sink = move |ev: crate::llm::StreamEvent| match ev {
            crate::llm::StreamEvent::Text(t) => emit(
                &sink_app,
                AgentEvent { req_id: sink_req.clone(), kind: "text".to_string(), text: Some(t), ..Default::default() },
            ),
            crate::llm::StreamEvent::ToolStart(name) => emit(
                &sink_app,
                AgentEvent { req_id: sink_req.clone(), kind: "tool".to_string(), tool: Some(name), ..Default::default() },
            ),
            crate::llm::StreamEvent::ToolDone(tr) => emit(
                &sink_app,
                AgentEvent {
                    req_id: sink_req.clone(),
                    kind: "tool_result".to_string(),
                    tool: Some(tr.name),
                    tool_id: Some(tr.id),
                    tool_input: tr.input_label,
                    tool_output_preview: Some(tr.output_preview),
                    tool_rows: tr.rows,
                    tool_truncated: Some(tr.truncated),
                    tool_ms: Some(tr.ms),
                    is_error: Some(tr.is_error),
                    ..Default::default()
                },
            ),
        };

        let result = crate::llm::agent_loop::run(
            crate::llm::client(),
            &cfg,
            &mode,
            &workspace,
            db.as_ref(),
            &mut history,
            prompt,
            system_prompt.as_deref(),
            &sink,
        )
        .await;

        let ms = started.elapsed().as_millis() as u64;
        let code = match result {
            Ok(text) => {
                // 先落地再進記憶體：寫檔失敗只記 log，不該讓這一輪的回答看起來像失敗。
                // 歷史已在 agent_loop 內修剪過（40 則 / 200 KB），這裡直接寫修剪後的版本。
                if let Some(dir) = &persist_dir {
                    let now = now_ms();
                    let file = crate::llm::sessions::SessionFile {
                        version: 1,
                        session_id: sid.clone(),
                        provider: persist_provider.to_string(),
                        model: persist_model.clone(),
                        created_at_ms: now,
                        updated_at_ms: now,
                        messages: history.clone(),
                    };
                    if let Err(e) = crate::llm::sessions::save_in(dir, &file).await {
                        eprintln!("[agent] 寫入對話歷史失敗：{e}");
                    }
                }
                sessions.lock().insert(sid.clone(), history);
                emit(
                    &app2,
                    AgentEvent {
                        req_id: req2.clone(),
                        kind: "result".to_string(),
                        session_id: Some(sid.clone()),
                        is_error: Some(false),
                        text: Some(text),
                        duration_ms: Some(ms),
                        ..Default::default()
                    },
                );
                0
            }
            Err(e) => {
                // 失敗的那一輪不寫回歷史：把壞掉的 tool_use / tool_result 留著，
                // 下一次送出會整串一起被端點拒絕。
                emit(
                    &app2,
                    AgentEvent { req_id: req2.clone(), kind: "error".to_string(), text: Some(e), ..Default::default() },
                );
                emit(
                    &app2,
                    AgentEvent {
                        req_id: req2.clone(),
                        kind: "result".to_string(),
                        session_id: Some(sid.clone()),
                        is_error: Some(true),
                        duration_ms: Some(ms),
                        ..Default::default()
                    },
                );
                1
            }
        };
        emit(
            &app2,
            AgentEvent { req_id: req2.clone(), kind: "done".to_string(), code: Some(code), ..Default::default() },
        );
        jobs.lock().remove(&req2);
    });
    state.agent_jobs.lock().insert(req_id, handle);
    Ok(())
}

/// 寫入 / 刪除 API 金鑰（空字串 = 刪除）。金鑰只進 OS keychain，不落地到設定檔。
#[tauri::command]
pub async fn llm_key_set(kind: String, key: String) -> AppResult<()> {
    let k = crate::llm::LlmKind::parse(&kind)
        .ok_or_else(|| AppError::Query(tf!("未知的供應商：{kind}", kind = kind)))?;
    crate::store::kc_set(k.key_account(), key.trim())
}

/// 只回「有沒有金鑰」，永不回傳明文。env 有設也算有。
#[tauri::command]
pub async fn llm_key_status(kind: String) -> bool {
    match crate::llm::LlmKind::parse(&kind) {
        Some(k) => crate::llm::resolve_key(k).is_some(),
        None => false,
    }
}

/// Unix epoch 毫秒。時鐘倒退（使用者改系統時間）時回 0，讓該筆歷史被當成最舊的，
/// 在 prune 時先被清掉——總比一個負數時間戳永遠排在最前面、把新對話擠掉好。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 刪除一段落地的對話歷史（前端「清空對話 / 開新對話」時呼叫）。
/// 記憶體與磁碟都清；HTTP 供應商以外的 session id 不存在於此，刪了也是 no-op。
#[tauri::command]
pub async fn agent_session_delete(app: AppHandle, state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state.llm_sessions.lock().remove(&session_id);
    let dir = crate::store::app_config_dir(&app)?;
    crate::llm::sessions::delete_in(&dir, &session_id).await
}

/// 清掉所有落地的對話歷史（AI 設定裡的「清除所有對話紀錄」）。
#[tauri::command]
pub async fn agent_sessions_clear(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    state.llm_sessions.lock().clear();
    let dir = crate::store::app_config_dir(&app)?;
    crate::llm::sessions::clear_in(&dir).await
}

/// 列出助手工作資料夾裡的檔案（供聊天輸入框的 `@file:` 補全）。
/// 與 `read_file` 工具同一套邊界：只看得到工作資料夾，路徑逃逸在 `llm::tools::safe_path` 擋下。
#[tauri::command]
pub async fn agent_workspace_files(app: AppHandle, pattern: Option<String>) -> AppResult<Vec<String>> {
    let dir = workspace_dir(&app).await?;
    Ok(crate::llm::tools::list_files(&dir, pattern.as_deref().unwrap_or("")))
}

/// 讀助手工作資料夾裡的一個檔案（供 `@file:` 把內容帶進上下文）。
#[tauri::command]
pub async fn agent_workspace_read(app: AppHandle, path: String) -> AppResult<String> {
    let dir = workspace_dir(&app).await?;
    crate::llm::tools::read_file(&dir, &path)
        .await
        .map_err(AppError::Query)
}

/// 取模型清單（順便當「測試連線」用）。抓不到回空陣列，前端退回手填。
#[tauri::command]
pub async fn llm_list_models(kind: String, base_url: Option<String>) -> Vec<String> {
    match crate::llm::LlmKind::parse(&kind) {
        Some(k) => crate::llm::models::list(crate::llm::client(), k, base_url.as_deref()).await,
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn attach() -> McpAttach {
        McpAttach {
            config_path: PathBuf::from("C:\\cfg\\agent-mcp\\r1.json"),
            command: "C:\\Program Files\\DB Kit\\dbk.exe".into(),
            args: vec!["mcp".into(), "--conn".into(), "c1".into(), "-d".into(), "shop".into()],
            tool_names: vec!["list_tables", "run_query"],
        }
    }

    #[test]
    fn strip_prefix_handles_claude_and_codex_names() {
        assert_eq!(strip_mcp_prefix("mcp__dbkit__run_query"), "run_query");
        assert_eq!(strip_mcp_prefix("dbkit:run_query"), "run_query");
        assert_eq!(strip_mcp_prefix("run_query"), "run_query");
        assert_eq!(strip_mcp_prefix("Read"), "Read");
    }

    #[test]
    fn tool_input_display_prefers_query_then_table_with_db() {
        assert_eq!(tool_input_display(&json!({ "query": " select 1 ", "limit": 5 })).as_deref(), Some("select 1"));
        assert_eq!(tool_input_display(&json!({ "table": "orders", "database": "shop" })).as_deref(), Some("shop.orders"));
        assert_eq!(tool_input_display(&json!({ "table": "orders" })).as_deref(), Some("orders"));
        assert_eq!(tool_input_display(&json!({})), None);
        assert_eq!(tool_input_display(&json!({ "pattern": "*.sql" })).as_deref(), Some(r#"{"pattern":"*.sql"}"#));
    }

    #[test]
    fn claude_events_tool_use_and_result() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"toolu_1","name":"mcp__dbkit__run_query","input":{"query":"select count(*) from t"}}]}}"#;
        let evs = claude_events("r", line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, "tool");
        assert_eq!(evs[0].tool.as_deref(), Some("run_query"));
        assert_eq!(evs[0].tool_id.as_deref(), Some("toolu_1"));
        assert_eq!(evs[0].tool_input.as_deref(), Some("select count(*) from t"));

        let res = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"count\n42\n（共 1 列）"}],"is_error":false}]}}"#;
        let evs = claude_events("r", res);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, "tool_result");
        assert_eq!(evs[0].tool_id.as_deref(), Some("toolu_1"));
        assert!(evs[0].tool_output_preview.as_deref().unwrap().starts_with("count\n42"));
        assert_eq!(evs[0].is_error, Some(false));

        // 字串型 content 與 is_error
        let res2 = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"boom","is_error":true}]}}"#;
        let evs = claude_events("r", res2);
        assert_eq!(evs[0].tool_output_preview.as_deref(), Some("boom"));
        assert_eq!(evs[0].is_error, Some(true));

        // 既有事件不受影響
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_3","name":"Read"}}}"#;
        let evs = claude_events("r", start);
        assert_eq!(evs[0].kind, "tool");
        assert_eq!(evs[0].tool.as_deref(), Some("Read"));
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}"#;
        assert_eq!(claude_events("r", delta)[0].text.as_deref(), Some("x"));
        assert!(claude_events("r", "not json").is_empty());
    }

    #[test]
    fn codex_events_mcp_tool_call() {
        let mut st = CodexTurn::default();
        let started = Instant::now();
        let s = r#"{"type":"item.started","item":{"id":"i1","type":"mcp_tool_call","server":"dbkit","tool":"run_query","arguments":{"query":"select 1"}}}"#;
        let evs = codex_events("r", s, &mut st, started);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, "tool");
        assert_eq!(evs[0].tool.as_deref(), Some("run_query"));
        assert_eq!(evs[0].tool_input.as_deref(), Some("select 1"));
        let c = r#"{"type":"item.completed","item":{"id":"i1","type":"mcp_tool_call","server":"dbkit","tool":"run_query","status":"completed","result":{"content":[{"type":"text","text":"1\n1"}]}}}"#;
        let evs = codex_events("r", c, &mut st, started);
        assert_eq!(evs[0].kind, "tool_result");
        assert_eq!(evs[0].tool_output_preview.as_deref(), Some("1\n1"));
        assert_eq!(evs[0].is_error, Some(false));
        let e = r#"{"type":"item.completed","item":{"id":"i2","type":"mcp_tool_call","tool":"run_query","status":"failed","error":{"message":"nope"}}}"#;
        let evs = codex_events("r", e, &mut st, started);
        assert_eq!(evs[0].tool_output_preview.as_deref(), Some("nope"));
        assert_eq!(evs[0].is_error, Some(true));
        // 非 MCP 工具維持標籤
        let cmd = r#"{"type":"item.started","item":{"id":"i3","type":"command_execution"}}"#;
        assert_eq!(codex_events("r", cmd, &mut st, started)[0].tool.as_deref(), Some("Command"));
    }

    #[test]
    fn claude_args_attach_mcp_only_in_conversational_modes() {
        let m = attach();
        let a = claude_args("advise", None, None, None, Some(&m));
        let allowed = a[a.iter().position(|x| x == "--allowedTools").unwrap() + 1].clone();
        assert!(allowed.contains("Read,Glob,Grep"));
        assert!(allowed.contains("mcp__dbkit__list_tables"));
        assert!(allowed.contains("mcp__dbkit__run_query"));
        assert!(!allowed.contains("mcp__dbkit__write"), "只放行工具清單裡的名字");
        let i = a.iter().position(|x| x == "--mcp-config").unwrap();
        assert_eq!(a[i + 1], "C:\\cfg\\agent-mcp\\r1.json");
        assert!(a.contains(&"--strict-mcp-config".to_string()));
        assert!(!a.contains(&"--max-turns".to_string()));

        // generate / edit：不掛 MCP、單回合、無 allowedTools。
        for mode in ["generate", "edit", "review"] {
            let g = claude_args(mode, None, None, None, Some(&m));
            assert!(!g.contains(&"--mcp-config".to_string()), "{mode}");
            assert!(!g.contains(&"--allowedTools".to_string()), "{mode}");
            assert!(g.contains(&"--max-turns".to_string()), "{mode}");
        }
        // 沒有 MCP 時與舊行為相同。
        let plain = claude_args("agent", Some("s1"), Some("opus"), Some("persona"), None);
        assert!(!plain.contains(&"--mcp-config".to_string()));
        assert!(plain.windows(2).any(|w| w[0] == "--resume" && w[1] == "s1"));
        assert!(plain.windows(2).any(|w| w[0] == "--append-system-prompt" && w[1] == "persona"));
    }

    #[test]
    fn codex_args_config_overrides_shape() {
        let m = attach();
        let a = codex_args("advise", Path::new("C:\\ws"), None, None, Some(&m));
        let cmd = a.iter().find(|x| x.starts_with("mcp_servers.dbkit.command=")).unwrap();
        assert_eq!(cmd, "mcp_servers.dbkit.command='C:\\Program Files\\DB Kit\\dbk.exe'");
        let args = a.iter().find(|x| x.starts_with("mcp_servers.dbkit.args=")).unwrap();
        assert_eq!(args, "mcp_servers.dbkit.args=['mcp', '--conn', 'c1', '-d', 'shop']");
        assert_eq!(a.last().map(String::as_str), Some("-"));
        assert!(a.windows(2).any(|w| w[0] == "--sandbox" && w[1] == "read-only"));
        // generate 不掛
        let g = codex_args("generate", Path::new("C:\\ws"), None, None, Some(&m));
        assert!(!g.iter().any(|x| x.starts_with("mcp_servers.")));
    }

    #[test]
    fn toml_string_escapes_only_when_needed() {
        assert_eq!(toml_string("C:\\a\\b.exe"), "'C:\\a\\b.exe'");
        assert_eq!(toml_string("it's"), "\"it's\"");
        assert_eq!(toml_string("a\"b\\c"), "'a\"b\\c'");
        assert_eq!(toml_string("x\ny'"), "\"x\\ny'\"");
    }

    #[test]
    fn mcp_config_json_has_no_secrets_and_right_shape() {
        let v = mcp_config_json("C:\\dbk.exe", &["mcp".into(), "--conn".into(), "c1".into()]);
        assert_eq!(v["mcpServers"]["dbkit"]["command"], "C:\\dbk.exe");
        assert_eq!(v["mcpServers"]["dbkit"]["args"][1], "--conn");
        let s = v.to_string();
        assert!(!s.contains("password"));
    }

    #[test]
    fn compose_system_joins_or_passes_through() {
        assert_eq!(compose_system(None, None), None);
        assert_eq!(compose_system(Some(" a "), None).as_deref(), Some("a"));
        assert_eq!(compose_system(None, Some("g")).as_deref(), Some("g"));
        assert_eq!(compose_system(Some("a"), Some("g")).as_deref(), Some("a\n\ng"));
        assert_eq!(compose_system(Some(""), Some("")), None);
    }

    #[test]
    fn preview_caps_length() {
        let long = "y".repeat(2000);
        assert_eq!(preview(&long).chars().count(), TOOL_PREVIEW_CHARS + 1);
        assert_eq!(preview("ok"), "ok");
    }
}
