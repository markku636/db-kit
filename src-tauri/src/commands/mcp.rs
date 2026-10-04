//! 「MCP 設定」對話框的 Tauri 命令。
//!
//! - 產生 / 寫入 / 移除 AI 用戶端設定：核心在 `crate::mcp_setup`（與 `dbk mcp config|install` 共用），
//!   這裡只負責找 dbk 執行檔、設定目錄與連線名稱。
//! - 在背景啟停 `dbk mcp --http`：權杖走環境變數（不出現在行程的命令列），App 結束時一併關掉。
//!   埠號與權杖存在 `<設定目錄>/mcp-http.json`，重開 App 後用戶端設定仍然有效。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::mcp_setup::{self, Client, InstallOutcome, ServerArgs, ServerSpec, Snippet, Transport};
use crate::store;

const HTTP_CONFIG_FILE: &str = "mcp-http.json";
const DEFAULT_HTTP_PORT: u16 = 8765;
const LOG_LINES: usize = 40;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub supports_project: bool,
    pub supports_http: bool,
    pub format: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetupInfo {
    /// 找得到的 dbk 執行檔；None = 用戶端無法自己啟動 dbk（stdio 設定不能寫入）。
    pub dbk_path: Option<String>,
    pub clients: Vec<McpClientInfo>,
    pub http: HttpStatus,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetupReq {
    pub client: String,
    #[serde(default)]
    pub name: Option<String>,
    /// 專案資料夾（寫 `.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` / `.codex/config.toml`）。
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub server: ServerArgs,
    /// 連到 App 背景啟動的 HTTP 伺服器，而不是讓用戶端自己啟動 dbk。
    #[serde(default)]
    pub http: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPreview {
    pub name: String,
    pub snippet: Snippet,
    pub installed: bool,
    pub dbk_missing: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct HttpConfig {
    port: u16,
    token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpStatus {
    pub running: bool,
    pub url: String,
    pub port: u16,
    pub token: String,
    /// 執行中伺服器的選項；給前端判斷「選項改了要重啟」。
    pub server: Option<ServerArgs>,
    pub log: Vec<String>,
    pub error: Option<String>,
}

struct HttpProc {
    child: Child,
    port: u16,
    server: ServerArgs,
    log: Arc<Mutex<VecDeque<String>>>,
}

static HTTP: Mutex<Option<HttpProc>> = Mutex::new(None);

fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    store::app_config_dir(app)
}

/// 讀（必要時建立）HTTP 設定：沒有權杖就產生一組並存檔。
fn http_config(dir: &Path) -> HttpConfig {
    let path = dir.join(HTTP_CONFIG_FILE);
    let mut cfg: HttpConfig = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let mut dirty = false;
    if cfg.port == 0 {
        cfg.port = DEFAULT_HTTP_PORT;
        dirty = true;
    }
    if cfg.token.len() < 16 {
        cfg.token = new_token();
        dirty = true;
    }
    if dirty {
        save_http_config(dir, &cfg);
    }
    cfg
}

fn save_http_config(dir: &Path, cfg: &HttpConfig) {
    let _ = std::fs::create_dir_all(dir);
    if let Ok(s) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(dir.join(HTTP_CONFIG_FILE), s);
    }
}

fn status(dir: &Path) -> HttpStatus {
    let cfg = http_config(dir);
    let mut g = HTTP.lock();
    let mut error = None;
    // 行程自己結束了（埠被占用、被手動關掉…）：收掉並把最後幾行 log 當錯誤回報。
    if let Some(p) = g.as_mut() {
        if let Ok(Some(code)) = p.child.try_wait() {
            let tail: Vec<String> = p.log.lock().iter().cloned().collect();
            error = Some(tf!("HTTP 伺服器已結束（{code}）：{log}", code = code.to_string(), log = tail.join(" / ")));
            *g = None;
        }
    }
    match g.as_ref() {
        Some(p) => HttpStatus {
            running: true,
            url: url_for(p.port),
            port: p.port,
            token: cfg.token,
            server: Some(p.server.clone()),
            log: p.log.lock().iter().cloned().collect(),
            error,
        },
        None => HttpStatus { running: false, url: url_for(cfg.port), port: cfg.port, token: cfg.token, server: None, log: Vec::new(), error },
    }
}

/// App 結束時呼叫：把背景的 HTTP 伺服器一起關掉。
pub fn shutdown_http() {
    if let Some(mut p) = HTTP.lock().take() {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

fn parse_client(s: &str) -> AppResult<Client> {
    Client::parse(s).ok_or_else(|| AppError::Query(tf!("不支援的 AI 用戶端：{client}", client = s)))
}

fn project_dir(p: Option<&str>) -> AppResult<Option<PathBuf>> {
    match p.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => {
            let path = PathBuf::from(s);
            if !path.is_dir() {
                return Err(AppError::Storage(tf!("專案資料夾不存在：{path}", path = s)));
            }
            Ok(Some(path))
        }
    }
}

/// 補上介面語言（dbk 的工具說明與錯誤訊息跟著 App 的語言）。
fn with_lang(mut s: ServerArgs) -> ServerArgs {
    if s.lang.as_deref().is_none_or(|l| l.trim().is_empty()) {
        s.lang = Some(crate::i18n::current().as_code().to_string());
    }
    s
}

/// 依請求組出伺服器規格；回 (用戶端, 規格, 專案資料夾, 是否找不到 dbk)。
async fn build(app: &AppHandle, req: &McpSetupReq) -> AppResult<(Client, ServerSpec, Option<PathBuf>, bool)> {
    let client = parse_client(&req.client)?;
    let dir = config_dir(app)?;
    let project = project_dir(req.project.as_deref())?;
    let server = with_lang(req.server.clone());
    let name = match req.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => mcp_setup::sanitize_name(n),
        None => {
            let conn_name = match server.conn.as_deref() {
                Some(id) => store::load_all_in(&dir).await?.into_iter().find(|c| c.id == id || c.name == id).map(|c| c.name),
                None => None,
            };
            mcp_setup::default_name(conn_name.as_deref())
        }
    };
    let (transport, missing) = if req.http {
        let cfg = http_config(&dir);
        (Transport::Http { url: url_for(cfg.port), token: Some(cfg.token) }, false)
    } else {
        let bin = crate::agent::resolve_dbk_bin().await;
        let missing = bin.is_none();
        (Transport::Stdio { command: bin.unwrap_or_else(|| "dbk".into()), args: server.to_args() }, missing)
    };
    Ok((client, ServerSpec { name, transport }, project, missing))
}

#[tauri::command]
pub async fn mcp_setup_info(app: AppHandle) -> AppResult<McpSetupInfo> {
    let dir = config_dir(&app)?;
    let clients = Client::ALL
        .into_iter()
        .map(|c| McpClientInfo {
            id: c.id(),
            label: c.label(),
            supports_project: c.supports_project(),
            supports_http: c.supports_http(),
            format: c.format(),
        })
        .collect();
    Ok(McpSetupInfo { dbk_path: crate::agent::resolve_dbk_bin().await, clients, http: status(&dir) })
}

#[tauri::command]
pub async fn mcp_setup_preview(app: AppHandle, req: McpSetupReq) -> AppResult<McpPreview> {
    let (client, spec, project, dbk_missing) = build(&app, &req).await?;
    let snippet = mcp_setup::snippet(client, &spec, project.as_deref()).map_err(AppError::Query)?;
    let installed = client != Client::Json && mcp_setup::is_installed(client, &spec.name, project.as_deref());
    Ok(McpPreview { name: spec.name, snippet, installed, dbk_missing })
}

#[tauri::command]
pub async fn mcp_setup_install(app: AppHandle, req: McpSetupReq) -> AppResult<InstallOutcome> {
    let (client, spec, project, dbk_missing) = build(&app, &req).await?;
    if dbk_missing {
        return Err(AppError::Storage(
            t!("找不到 dbk 執行檔，用戶端無法啟動 MCP 伺服器。請重新安裝 db-kit，或以環境變數 DB_KIT_DBK_BIN 指定路徑").into(),
        ));
    }
    mcp_setup::install(client, &spec, project.as_deref()).map_err(AppError::Storage)
}

#[tauri::command]
pub async fn mcp_setup_uninstall(app: AppHandle, req: McpSetupReq) -> AppResult<bool> {
    let (client, spec, project, _) = build(&app, &req).await?;
    mcp_setup::uninstall(client, &spec.name, project.as_deref()).map_err(AppError::Storage)
}

#[tauri::command]
pub async fn mcp_http_status(app: AppHandle) -> AppResult<HttpStatus> {
    Ok(status(&config_dir(&app)?))
}

/// 重新產生權杖（已寫進用戶端的 HTTP 設定要重寫一次）。執行中的伺服器會以新權杖重啟。
#[tauri::command]
pub async fn mcp_http_rotate_token(app: AppHandle) -> AppResult<HttpStatus> {
    let dir = config_dir(&app)?;
    let mut cfg = http_config(&dir);
    cfg.token = new_token();
    save_http_config(&dir, &cfg);
    let running = HTTP.lock().as_ref().map(|p| p.server.clone());
    if let Some(server) = running {
        shutdown_http();
        spawn_http(&dir, server).await?;
    }
    Ok(status(&dir))
}

#[tauri::command]
pub async fn mcp_http_start(app: AppHandle, server: ServerArgs, port: Option<u16>) -> AppResult<HttpStatus> {
    let dir = config_dir(&app)?;
    if let Some(p) = port.filter(|p| *p > 0) {
        let mut cfg = http_config(&dir);
        cfg.port = p;
        save_http_config(&dir, &cfg);
    }
    shutdown_http();
    spawn_http(&dir, with_lang(server)).await?;
    Ok(status(&dir))
}

#[tauri::command]
pub async fn mcp_http_stop(app: AppHandle) -> AppResult<HttpStatus> {
    shutdown_http();
    Ok(status(&config_dir(&app)?))
}

/// 啟動 `dbk <args> --http 127.0.0.1:<port>`；權杖只走環境變數。啟動後稍等一下確認沒有立刻結束（埠被占用等）。
async fn spawn_http(dir: &Path, server: ServerArgs) -> AppResult<()> {
    let cfg = http_config(dir);
    let bin = crate::agent::resolve_dbk_bin().await.ok_or_else(|| {
        AppError::Storage(t!("找不到 dbk 執行檔，用戶端無法啟動 MCP 伺服器。請重新安裝 db-kit，或以環境變數 DB_KIT_DBK_BIN 指定路徑").into())
    })?;
    let mut full = server.to_args();
    full.push("--http".into());
    full.push(format!("127.0.0.1:{}", cfg.port));
    let mut cmd = Command::new(&bin);
    cmd.args(&full).env("DBKIT_MCP_TOKEN", &cfg.token).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不要閃一個主控台視窗
    }
    let mut child = cmd.spawn().map_err(|e| AppError::Storage(tf!("無法啟動 dbk：{e}", e = e.to_string())))?;
    let log: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(err) = child.stderr.take() {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let mut g = log.lock();
                if g.len() >= LOG_LINES {
                    g.pop_front();
                }
                g.push_back(line);
            }
        });
    }
    tokio::time::sleep(Duration::from_millis(800)).await;
    if let Ok(Some(code)) = child.try_wait() {
        let tail: Vec<String> = log.lock().iter().cloned().collect();
        return Err(AppError::Storage(tf!(
            "HTTP 伺服器啟動失敗（{code}）：{log}",
            code = code.to_string(),
            log = tail.join(" / ")
        )));
    }
    *HTTP.lock() = Some(HttpProc { child, port: cfg.port, server, log });
    Ok(())
}
