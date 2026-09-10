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

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::commands::AppState;
use crate::error::{AppError, AppResult};

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
}

/// 推送給前端的串流事件（事件名 `agent-stream`）。扁平結構，欄位依 kind 取捨。
#[derive(Clone, Serialize, Default)]
struct AgentEvent {
    req_id: String,
    /// "system" | "text" | "tool" | "result" | "error" | "done"
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
fn open_path(path: &std::path::Path) {
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

/// 解析單行 NDJSON 並轉成前端事件。
/// CLI 的 stream-json 外層為包裝型別（system/assistant/result/stream_event），
/// 非原始 API 事件；token 級增量在 `--include-partial-messages` 的 `stream_event` 裡。
fn parse_claude_line(app: &AppHandle, req: &str, line: &str) {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") => {
            if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                let session_id = v
                    .get("session_id")
                    .and_then(|s| s.as_str())
                    .map(String::from);
                let model = v
                    .get("model")
                    .and_then(|m| m.as_str())
                    .or_else(|| {
                        v.get("data")
                            .and_then(|d| d.get("model"))
                            .and_then(|m| m.as_str())
                    })
                    .map(String::from);
                emit(
                    app,
                    AgentEvent {
                        req_id: req.to_string(),
                        kind: "system".to_string(),
                        session_id,
                        model,
                        ..Default::default()
                    },
                );
            }
        }
        Some("stream_event") => {
            let ev = match v.get("event") {
                Some(e) => e,
                None => return,
            };
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    if let Some(d) = ev.get("delta") {
                        if d.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                            if let Some(t) = d.get("text").and_then(|t| t.as_str()) {
                                emit(
                                    app,
                                    AgentEvent {
                                        req_id: req.to_string(),
                                        kind: "text".to_string(),
                                        text: Some(t.to_string()),
                                        ..Default::default()
                                    },
                                );
                            }
                        }
                    }
                }
                Some("content_block_start") => {
                    if let Some(cb) = ev.get("content_block") {
                        if cb.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                            let name = cb
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            emit(
                                app,
                                AgentEvent {
                                    req_id: req.to_string(),
                                    kind: "tool".to_string(),
                                    tool: Some(name),
                                    ..Default::default()
                                },
                            );
                        }
                    }
                }
                _ => {}
            }
        }
        Some("result") => {
            let session_id = v
                .get("session_id")
                .and_then(|s| s.as_str())
                .map(String::from);
            let is_error = v.get("is_error").and_then(|b| b.as_bool());
            let text = v.get("result").and_then(|s| s.as_str()).map(String::from);
            let duration_ms = v.get("duration_ms").and_then(|d| d.as_u64());
            emit(
                app,
                AgentEvent {
                    req_id: req.to_string(),
                    kind: "result".to_string(),
                    session_id,
                    is_error,
                    text,
                    duration_ms,
                    ..Default::default()
                },
            );
        }
        _ => {}
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

/// 解析 `codex exec --json` 的單行 JSONL。
/// 事件族：thread.started / turn.started / turn.completed / turn.failed / item.* / error。
/// 與 Claude 最大的差異是「沒有 token 級增量」：整段回答在 item.completed 一次給完。
fn parse_codex_line(app: &AppHandle, req: &str, line: &str, st: &mut CodexTurn, started: Instant) {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    let kind = match v.get("type").and_then(|t| t.as_str()) {
        Some(k) => k,
        None => return,
    };
    match kind {
        "thread.started" => {
            let id = v
                .get("thread_id")
                .and_then(|s| s.as_str())
                .map(String::from);
            st.session_id = id.clone();
            emit(
                app,
                AgentEvent {
                    req_id: req.to_string(),
                    kind: "system".to_string(),
                    session_id: id,
                    ..Default::default()
                },
            );
        }
        "item.started" => {
            let item_type = v
                .get("item")
                .and_then(|i| i.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if let Some(label) = codex_tool_label(item_type) {
                emit(
                    app,
                    AgentEvent {
                        req_id: req.to_string(),
                        kind: "tool".to_string(),
                        tool: Some(label.to_string()),
                        ..Default::default()
                    },
                );
            }
        }
        "item.completed" => {
            let item = match v.get("item") {
                Some(i) => i,
                None => return,
            };
            // 只把 agent_message 當回答內容；reasoning 與工具項目不進聊天氣泡。
            if item.get("type").and_then(|t| t.as_str()) != Some("agent_message") {
                return;
            }
            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                if text.is_empty() {
                    return;
                }
                st.last_text = Some(text.to_string());
                emit(
                    app,
                    AgentEvent {
                        req_id: req.to_string(),
                        kind: "text".to_string(),
                        text: Some(text.to_string()),
                        ..Default::default()
                    },
                );
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
            emit(
                app,
                AgentEvent {
                    req_id: req.to_string(),
                    kind: "result".to_string(),
                    session_id: st.session_id.clone(),
                    is_error: Some(failed),
                    text,
                    duration_ms: Some(started.elapsed().as_millis() as u64),
                    ..Default::default()
                },
            );
        }
        "error" => {
            let msg = v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            emit(
                app,
                AgentEvent {
                    req_id: req.to_string(),
                    kind: "error".to_string(),
                    text: Some(msg),
                    ..Default::default()
                },
            );
        }
        _ => {}
    }
}

// ---- 指令組裝 ----

/// 由助手模式推導 Claude 的 CLI 旗標：採「允許清單 + dontAsk」而非黑名單。
/// dontAsk 會自動拒絕清單外的所有工具（不會卡住等待輸入），
/// 因此 shell（Windows 是 PowerShell、類 Unix 是 Bash）、所有 MCP 工具、
/// Task / Workflow / Skill 等一律被擋下，與平台無關。
fn claude_flags_for_mode(mode: &str) -> (&'static str, &'static str) {
    // (permission_mode, allowed_tools)
    match mode {
        // 可寫腳本檔：額外放行寫檔 / 改檔（限工作資料夾），仍不放行 shell / MCP。
        "agent" => (
            "dontAsk",
            "Read,Glob,Grep,Write,Edit,MultiEdit,WebSearch,WebFetch",
        ),
        // 一次性語句生成（NL→SQL / NL→ES DSL）：零工具、單回合，回覆即語句。
        // 空 allowedTools + dontAsk → 清單外一律自動拒絕（見下方 agent_send 略過旗標）。
        "generate" => ("dontAsk", ""),
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

fn claude_args(mode: &str, session_id: Option<&str>, model: Option<&str>, system_prompt: Option<&str>) -> Vec<String> {
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
    // 空 allowedTools（generate 模式）略過該旗標：dontAsk 下未列入允許者一律自動拒絕，
    // 行為等價「全拒」，且避開 CLI 對空字串引數的解析歧義。
    if !allowed.is_empty() {
        a.push("--allowedTools".into());
        a.push(allowed.into());
    }
    // 一次性語句生成：限單回合（防守性——即使模型嘗試 tool call 被拒也不會進入多回合重試）。
    if mode == "generate" {
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

fn codex_args(
    mode: &str,
    workspace: &std::path::Path,
    session_id: Option<&str>,
    model: Option<&str>,
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
        };
    }
    match resolve_bin(p).await {
        Some(bin) => {
            let version = cli_version(&bin).await;
            AgentStatus {
                provider: p.id().to_string(),
                installed: version.is_some(),
                version,
                logged_in: logged_in(p),
                path: Some(bin.display),
            }
        }
        None => AgentStatus {
            provider: p.id().to_string(),
            installed: false,
            version: None,
            logged_in: logged_in(p),
            path: None,
        },
    }
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

    // ---- HTTP 供應商：不開子程序，直接跑工具迴圈 ----
    if let Some(kind) = p.llm_kind() {
        return llm_send(app, state, req_id, prompt, sid, model, &mode, kind, base_url.as_deref(), sys, workspace).await;
    }

    let bin = resolve_bin(p).await.ok_or_else(|| {
        AppError::Query(tf!(
            "找不到 {cli} CLI，請先安裝並以你的訂閱帳號登入",
            cli = p.exe()
        ))
    })?;

    // Codex 沒有 append-system-prompt，人設併進提示本文。
    let prompt = match p {
        Provider::Codex => prepend_system(&prompt, sys),
        _ => prompt,
    };

    let args = match p {
        Provider::Claude => claude_args(&mode, sid, model, sys),
        Provider::Codex => codex_args(&mode, &workspace, sid, model),
        // 上面已提前 return，這裡到不了。
        Provider::AnthropicApi | Provider::OpenAiApi => unreachable!(),
    };

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
    let mut history = state.llm_sessions.lock().get(&sid).cloned().unwrap_or_default();

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
        };

        let result = crate::llm::agent_loop::run(
            crate::llm::client(),
            &cfg,
            &mode,
            &workspace,
            &mut history,
            prompt,
            system_prompt.as_deref(),
            &sink,
        )
        .await;

        let ms = started.elapsed().as_millis() as u64;
        let code = match result {
            Ok(text) => {
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

/// 取模型清單（順便當「測試連線」用）。抓不到回空陣列，前端退回手填。
#[tauri::command]
pub async fn llm_list_models(kind: String, base_url: Option<String>) -> Vec<String> {
    match crate::llm::LlmKind::parse(&kind) {
        Some(k) => crate::llm::models::list(crate::llm::client(), k, base_url.as_deref()).await,
        None => Vec::new(),
    }
}
