//! 內建 AI 助手：驅動本機 `claude` CLI（使用使用者的 Claude 訂閱登入），
//! 以 headless 串流模式回答問題與撰寫腳本。
//!
//! 設計取捨：
//! - 用「訂閱（Pro/Max 登入）」而非 API key，唯一可行路徑是呼叫 `claude` CLI，
//!   而非 Agent SDK 函式庫（SDK 需付費 API key，且官方不允許第三方走 claude.ai 登入）。
//! - 串流方式對標 Redis Pub/Sub：背景任務逐行讀 stdout 的 NDJSON，
//!   以 `claude-stream` 事件推給前端；JoinHandle 存在 AppState 供取消。
//! - 權限採「允許清單 + dontAsk」：清單外工具一律自動拒絕（不卡住），
//!   故 shell（PowerShell / Bash）、所有 MCP、Task / Workflow 等都被擋；
//!   `advise`（預設）只放行唯讀 / 查資料工具（純問答 / 產生腳本文字），
//!   `agent` 額外放行寫檔工具，可將腳本寫入專屬工作資料夾。

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::commands::AppState;
use crate::error::{AppError, AppResult};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 解析後的 claude 執行方式。npm 安裝的 `.cmd` shim 需透過 `cmd /C` 呼叫。
struct ClaudeBin {
    program: String,
    prefix: Vec<String>,
    display: String,
}

/// 偵測結果，回給前端決定是否顯示安裝 / 登入提示。
#[derive(Serialize)]
pub struct ClaudeStatus {
    installed: bool,
    version: Option<String>,
    logged_in: bool,
    path: Option<String>,
}

/// 推送給前端的串流事件（事件名 `claude-stream`）。扁平結構，欄位依 kind 取捨。
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
fn classify(path: String) -> ClaudeBin {
    let lower = path.to_lowercase();
    if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        ClaudeBin {
            program: "cmd".to_string(),
            prefix: vec!["/C".to_string(), path.clone()],
            display: path,
        }
    } else {
        ClaudeBin {
            program: path.clone(),
            prefix: Vec::new(),
            display: path,
        }
    }
}

/// 用 `where` / `which` 找 claude；Windows 優先取 `.exe`（可直接 CreateProcess），
/// 略過 `.ps1`（無法直接執行）。
async fn which_claude() -> Option<String> {
    let (prog, arg) = if cfg!(windows) {
        ("where", "claude")
    } else {
        ("which", "claude")
    };
    let mut c = Command::new(prog);
    c.arg(arg).stdin(Stdio::null());
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

/// 解析 claude 執行檔：env 覆寫 → PATH 查找 → 預設安裝路徑。
async fn resolve_claude_bin() -> Option<ClaudeBin> {
    if let Ok(p) = std::env::var("DB_KIT_CLAUDE_BIN") {
        if !p.trim().is_empty() {
            return Some(classify(p));
        }
    }
    if let Some(p) = which_claude().await {
        return Some(classify(p));
    }
    if let Some(home) = home_dir() {
        let cand = if cfg!(windows) {
            home.join(".local").join("bin").join("claude.exe")
        } else {
            home.join(".local").join("bin").join("claude")
        };
        if cand.exists() {
            return Some(classify(cand.to_string_lossy().to_string()));
        }
    }
    None
}

/// 建立帶有「不彈出主控台視窗」（Windows）設定的指令。
fn make_cmd(bin: &ClaudeBin) -> Command {
    let mut c = Command::new(&bin.program);
    for a in &bin.prefix {
        c.arg(a);
    }
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// 是否已具備可用憑證：env 的 API key，或本機 Claude 登入憑證檔。
fn logged_in() -> bool {
    if std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    if let Some(home) = home_dir() {
        if home.join(".claude").join(".credentials.json").exists() {
            return true;
        }
    }
    false
}

async fn claude_version(bin: &ClaudeBin) -> Option<String> {
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
    let _ = app.emit("claude-stream", ev);
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
        return Err(AppError::Query(t!("僅允許開啟 http / https 連結").to_string()));
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

/// 解析單行 NDJSON 並轉成前端事件。
/// CLI 的 stream-json 外層為包裝型別（system/assistant/result/stream_event），
/// 非原始 API 事件；token 級增量在 `--include-partial-messages` 的 `stream_event` 裡。
fn parse_and_emit(app: &AppHandle, req: &str, line: &str) {
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
                    .or_else(|| v.get("data").and_then(|d| d.get("model")).and_then(|m| m.as_str()))
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

/// 由助手模式推導 CLI 旗標：採「允許清單 + dontAsk」而非黑名單。
/// dontAsk 會自動拒絕清單外的所有工具（不會卡住等待輸入），
/// 因此 shell（Windows 是 PowerShell、類 Unix 是 Bash）、所有 MCP 工具、
/// Task / Workflow / Skill 等一律被擋下，與平台無關。
fn flags_for_mode(mode: &str) -> (&'static str, &'static str) {
    // (permission_mode, allowed_tools)
    match mode {
        // 可寫腳本檔：額外放行寫檔 / 改檔（限工作資料夾），仍不放行 shell / MCP。
        "agent" => (
            "dontAsk",
            "Read,Glob,Grep,Write,Edit,MultiEdit,WebSearch,WebFetch",
        ),
        // 一次性語句生成（NL→SQL / NL→ES DSL）：零工具、單回合，回覆即語句。
        // 空 allowedTools + dontAsk → 清單外一律自動拒絕（見下方 claude_send 略過旗標）。
        "generate" => ("dontAsk", ""),
        // 純問答 / 產生腳本文字（預設）：只放行唯讀與查資料工具。
        _ => ("dontAsk", "Read,Glob,Grep,WebSearch,WebFetch"),
    }
}

#[tauri::command]
pub async fn claude_detect() -> ClaudeStatus {
    match resolve_claude_bin().await {
        Some(bin) => {
            let version = claude_version(&bin).await;
            ClaudeStatus {
                installed: version.is_some(),
                version,
                logged_in: logged_in(),
                path: Some(bin.display),
            }
        }
        None => ClaudeStatus {
            installed: false,
            version: None,
            logged_in: logged_in(),
            path: None,
        },
    }
}

/// 送出一次問答（多輪以 session_id + --resume 串接）。
/// 立即回傳；輸出以 `claude-stream` 事件串流，直到 `done`。
#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, AppState>,
    req_id: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    mode: Option<String>,
) -> AppResult<()> {
    let bin = resolve_claude_bin()
        .await
        .ok_or_else(|| AppError::Query(t!("找不到 claude CLI，請先安裝 Claude Code 並登入").to_string()))?;
    let workspace = workspace_dir(&app).await?;
    let mode = mode.unwrap_or_else(|| "advise".to_string());
    let (perm, allowed) = flags_for_mode(&mode);

    let mut cmd = make_cmd(&bin);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--permission-mode")
        .arg(perm);
    // 空 allowedTools（generate 模式）略過該旗標：dontAsk 下未列入允許者一律自動拒絕，
    // 行為等價「全拒」，且避開 CLI 對空字串引數的解析歧義。
    if !allowed.is_empty() {
        cmd.arg("--allowedTools").arg(allowed);
    }
    // 一次性語句生成：限單回合（防守性——即使模型嘗試 tool call 被拒也不會進入多回合重試）。
    if mode == "generate" {
        cmd.arg("--max-turns").arg("1");
    }
    if let Some(sid) = session_id.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(sid);
    }
    if let Some(m) = model.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    cmd.current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Query(tf!("啟動 claude 失敗：{e}", e = e)))?;

    // 提示由 stdin 餵入（避免 Windows 命令列長度上限與引號轉義問題），寫完即 EOF。
    if let Some(mut stdin) = child.stdin.take() {
        let p = prompt;
        tokio::spawn(async move {
            let _ = stdin.write_all(p.as_bytes()).await;
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
    let handle = tauri::async_runtime::spawn(async move {
        // 並行排空 stderr，避免管線塞滿造成死結。
        let err_task = tokio::spawn(async move {
            let mut s = String::new();
            let mut rd = BufReader::new(stderr);
            let _ = rd.read_to_string(&mut s).await;
            s
        });

        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if !line.trim().is_empty() {
                        parse_and_emit(&app2, &req2, &line);
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
                    tf!("claude 以結束碼 {c} 退出", c = c)
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

/// 取消進行中的問答：abort 背景任務 → kill_on_drop 終止子程序。
#[tauri::command]
pub async fn claude_cancel(state: State<'_, AppState>, req_id: String) -> AppResult<()> {
    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }
    Ok(())
}
