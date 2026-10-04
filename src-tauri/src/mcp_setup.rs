//! MCP 用戶端設定：把 `dbk mcp` 接到 Claude Code / Codex / Cursor / VS Code / Claude Desktop / Windsurf。
//!
//! `dbk mcp config|install` 與 GUI 的「MCP 設定」對話框共用這一份（不依賴 Tauri，slim CLI 也編得進來）。
//!
//! 原則：
//! - 設定檔**永遠不放帳密**。連線一律以 `--conn <id>` 指向 db-kit 已存連線，執行期才從 keychain 取密碼；
//!   HTTP 模式的權杖是唯一例外（用戶端要帶 Authorization 標頭，沒有別的管道）。
//! - 寫入只動自己那一項（`mcpServers.<name>` / `[mcp_servers.<name>]`），其餘內容原樣保留；
//!   寫之前先把原檔備份成 `<檔名>.dbkit-bak`，再以「暫存檔 + rename」整檔替換，寫到一半當掉也不會留下半個 JSON。
//! - 解析不了的檔（VS Code 的 mcp.json 允許註解）不硬改：回錯誤請使用者複製片段手動貼上。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// 支援的 AI 用戶端。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Client {
    ClaudeCode,
    Codex,
    Cursor,
    Vscode,
    ClaudeDesktop,
    Windsurf,
    /// 通用 `mcpServers` JSON（只產生片段，不寫檔）。
    Json,
}

impl Client {
    pub const ALL: [Client; 7] = [
        Client::ClaudeCode,
        Client::Codex,
        Client::Cursor,
        Client::Vscode,
        Client::ClaudeDesktop,
        Client::Windsurf,
        Client::Json,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claude-code",
            Client::Codex => "codex",
            Client::Cursor => "cursor",
            Client::Vscode => "vscode",
            Client::ClaudeDesktop => "claude-desktop",
            Client::Windsurf => "windsurf",
            Client::Json => "json",
        }
    }

    pub fn parse(s: &str) -> Option<Client> {
        Client::ALL.into_iter().find(|c| c.id() == s)
    }

    pub fn label(self) -> &'static str {
        match self {
            Client::ClaudeCode => "Claude Code",
            Client::Codex => "Codex",
            Client::Cursor => "Cursor",
            Client::Vscode => "VS Code",
            Client::ClaudeDesktop => "Claude Desktop",
            Client::Windsurf => "Windsurf",
            Client::Json => "JSON",
        }
    }

    /// 有專案層設定檔（`.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` / `.codex/config.toml`）。
    pub fn supports_project(self) -> bool {
        matches!(self, Client::ClaudeCode | Client::Codex | Client::Cursor | Client::Vscode)
    }

    /// 能直接連 HTTP 端點（Claude Desktop 的設定檔只收 stdio 子程序）。
    pub fn supports_http(self) -> bool {
        !matches!(self, Client::ClaudeDesktop)
    }

    /// 設定檔格式。
    pub fn format(self) -> &'static str {
        if self == Client::Codex { "toml" } else { "json" }
    }

    /// JSON 設定裡放伺服器的那個鍵（VS Code 叫 `servers`，其餘 `mcpServers`）。
    fn servers_key(self) -> &'static str {
        if self == Client::Vscode { "servers" } else { "mcpServers" }
    }
}

/// 用戶端要怎麼連到 dbk。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Transport {
    /// 用戶端自己把 dbk 當子程序啟動（最常見）。
    Stdio { command: String, args: Vec<String> },
    /// 連到已在執行的 `dbk mcp --http`。
    Http { url: String, token: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerSpec {
    pub name: String,
    pub transport: Transport,
}

/// `dbk mcp` 的伺服器參數（GUI 與 CLI 用同一份規則組出 args）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerArgs {
    /// 單一連線（已存連線 id 或名稱）；None = 多連線模式。
    pub conn: Option<String>,
    pub database: Option<String>,
    /// 多連線模式只開放這些連線；空 = 全部。
    pub connections: Vec<String>,
    pub tools: Vec<String>,
    pub allow_write: bool,
    pub allow_destructive: bool,
    pub allow_prod: bool,
    pub out: Option<String>,
    pub lang: Option<String>,
}

impl ServerArgs {
    /// 組出 `dbk` 的參數（以 `mcp` 開頭；全域旗標放在子指令後面也有效）。
    pub fn to_args(&self) -> Vec<String> {
        let mut a = vec!["mcp".to_string()];
        let nonempty = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        if let Some(c) = nonempty(&self.conn) {
            a.push("--conn".into());
            a.push(c);
            if let Some(d) = nonempty(&self.database) {
                a.push("-d".into());
                a.push(d);
            }
        } else {
            let list: Vec<&str> = self.connections.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            if !list.is_empty() {
                a.push("--connections".into());
                a.push(list.join(","));
            }
        }
        let tools: Vec<&str> = self.tools.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        if !tools.is_empty() {
            a.push("--tools".into());
            a.push(tools.join(","));
        }
        if self.allow_write {
            a.push("--allow-write".into());
            if self.allow_destructive {
                a.push("--allow-destructive".into());
            }
            if self.allow_prod {
                a.push("--allow-prod".into());
            }
            if let Some(o) = nonempty(&self.out) {
                a.push("--out".into());
                a.push(o);
            }
        }
        if let Some(l) = nonempty(&self.lang) {
            a.push("--lang".into());
            a.push(l);
        }
        a
    }
}

/// 伺服器名稱只留英數、`-`、`_`（Codex 的 TOML 鍵、Claude 的 `mcp__<name>__` 工具前綴都靠它）。
pub fn sanitize_name(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let t = out.trim_matches('-').chars().take(48).collect::<String>();
    if t.is_empty() { "dbkit".to_string() } else { t }
}

/// 預設伺服器名稱：多連線 `dbkit`；單一連線 `dbkit-<連線名>`。
pub fn default_name(conn_name: Option<&str>) -> String {
    match conn_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => {
            let s = sanitize_name(n);
            if s == "dbkit" { s } else { format!("dbkit-{s}") }
        }
        None => "dbkit".to_string(),
    }
}

// ---------------------------------------------------------------------------
// 片段
// ---------------------------------------------------------------------------

/// 一個伺服器在某用戶端 JSON 設定裡的值。
pub fn json_entry(client: Client, t: &Transport) -> Result<Value, String> {
    Ok(match t {
        Transport::Stdio { command, args } => match client {
            Client::ClaudeCode | Client::Vscode => json!({ "type": "stdio", "command": command, "args": args }),
            Client::Codex => return Err("codex uses TOML".into()),
            _ => json!({ "command": command, "args": args }),
        },
        Transport::Http { url, token } => {
            if !client.supports_http() {
                return Err(tf!("{client} 不支援直接連 HTTP 伺服器，請改用 stdio", client = client.label()));
            }
            let mut m = Map::new();
            match client {
                Client::ClaudeCode | Client::Vscode => {
                    m.insert("type".into(), json!("http"));
                    m.insert("url".into(), json!(url));
                }
                Client::Windsurf => {
                    m.insert("serverUrl".into(), json!(url));
                }
                Client::Codex => return Err("codex uses TOML".into()),
                _ => {
                    m.insert("url".into(), json!(url));
                }
            }
            if let Some(tok) = token.as_deref().filter(|s| !s.is_empty()) {
                m.insert("headers".into(), json!({ "Authorization": format!("Bearer {tok}") }));
            }
            Value::Object(m)
        }
    })
}

/// TOML 基本字串（雙引號、跳脫反斜線與引號）。
fn toml_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04X}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Codex `config.toml` 的一個 `[mcp_servers.<name>]` 區塊（結尾含換行）。
pub fn codex_block(spec: &ServerSpec) -> String {
    let name = sanitize_name(&spec.name);
    let mut s = format!("[mcp_servers.{name}]\n");
    match &spec.transport {
        Transport::Stdio { command, args } => {
            s.push_str(&format!("command = {}\n", toml_str(command)));
            let a: Vec<String> = args.iter().map(|x| toml_str(x)).collect();
            s.push_str(&format!("args = [{}]\n", a.join(", ")));
        }
        Transport::Http { url, token } => {
            s.push_str(&format!("url = {}\n", toml_str(url)));
            if token.as_deref().is_some_and(|t| !t.is_empty()) {
                // Codex 從環境變數取 Bearer 權杖；權杖本身不寫進 config.toml。
                s.push_str("bearer_token_env_var = \"DBKIT_MCP_TOKEN\"\n");
            }
        }
    }
    s
}

/// shell 參數引號（只在需要時加雙引號；PowerShell 與 POSIX shell 都吃）。
fn sh_arg(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=,@\\".contains(c)) {
        s.to_string()
    } else {
        format!("\"{}\"", s.replace('"', "\\\""))
    }
}

/// 用戶端有自己的「加 MCP 伺服器」指令時，回一行等價指令（給偏好指令列的人）。
pub fn cli_command(client: Client, spec: &ServerSpec, project: bool) -> Option<String> {
    let name = sanitize_name(&spec.name);
    match (client, &spec.transport) {
        (Client::ClaudeCode, Transport::Stdio { command, args }) => {
            let scope = if project { "project" } else { "user" };
            let rest: Vec<String> = args.iter().map(|a| sh_arg(a)).collect();
            Some(format!("claude mcp add --scope {scope} {name} -- {} {}", sh_arg(command), rest.join(" ")))
        }
        (Client::ClaudeCode, Transport::Http { url, token }) => {
            let scope = if project { "project" } else { "user" };
            let mut s = format!("claude mcp add --scope {scope} --transport http {name} {}", sh_arg(url));
            if let Some(t) = token.as_deref().filter(|t| !t.is_empty()) {
                s.push_str(&format!(" --header {}", sh_arg(&format!("Authorization: Bearer {t}"))));
            }
            Some(s)
        }
        (Client::Codex, Transport::Stdio { command, args }) if !project => {
            let rest: Vec<String> = args.iter().map(|a| sh_arg(a)).collect();
            Some(format!("codex mcp add {name} -- {} {}", sh_arg(command), rest.join(" ")))
        }
        (Client::Codex, Transport::Http { url, token }) if !project => {
            let mut s = format!("codex mcp add {name} --url {}", sh_arg(url));
            if token.as_deref().is_some_and(|t| !t.is_empty()) {
                s.push_str(" --bearer-token-env-var DBKIT_MCP_TOKEN");
            }
            Some(s)
        }
        _ => None,
    }
}

/// 可直接貼進設定檔的完整片段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub client: Client,
    /// `json` / `toml`
    pub language: &'static str,
    pub text: String,
    /// 預設寫入的設定檔（Json 通用片段為 None）。
    pub path: Option<String>,
    /// 等價的用戶端指令（有的話）。
    pub cli: Option<String>,
    /// 給使用者的提醒（例如要設 DBKIT_MCP_TOKEN 環境變數）。
    pub notes: Vec<String>,
}

pub fn snippet(client: Client, spec: &ServerSpec, project: Option<&Path>) -> Result<Snippet, String> {
    let mut notes = Vec::new();
    let text = if client == Client::Codex {
        if let Transport::Http { token: Some(t), .. } = &spec.transport {
            if !t.is_empty() {
                notes.push(t!("Codex 從環境變數 DBKIT_MCP_TOKEN 讀取 HTTP 權杖，請先設定好再啟動 Codex。").to_string());
            }
        }
        codex_block(spec)
    } else {
        let entry = json_entry(client, &spec.transport)?;
        let mut servers = Map::new();
        servers.insert(sanitize_name(&spec.name), entry);
        let mut root = Map::new();
        root.insert(client.servers_key().into(), Value::Object(servers));
        serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?
    };
    if matches!(&spec.transport, Transport::Http { token: Some(t), .. } if !t.is_empty()) && client != Client::Codex {
        notes.push(t!("設定裡含 HTTP 權杖，請勿把這個檔案提交到版本控制。").to_string());
    }
    let path = config_path(client, project).ok().map(|p| p.display().to_string());
    Ok(Snippet { client, language: client.format(), text, path, cli: cli_command(client, spec, project.is_some()), notes })
}

// ---------------------------------------------------------------------------
// 設定檔位置
// ---------------------------------------------------------------------------

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| t!("無法取得使用者家目錄").to_string())
}

fn config_base() -> Result<PathBuf, String> {
    dirs::config_dir().ok_or_else(|| t!("無法取得使用者設定目錄").to_string())
}

/// 用戶端設定檔路徑。`project` 有給時用專案層（不支援專案層的用戶端回錯誤）。
pub fn config_path(client: Client, project: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(dir) = project {
        return match client {
            Client::ClaudeCode => Ok(dir.join(".mcp.json")),
            Client::Codex => Ok(dir.join(".codex").join("config.toml")),
            Client::Cursor => Ok(dir.join(".cursor").join("mcp.json")),
            Client::Vscode => Ok(dir.join(".vscode").join("mcp.json")),
            _ => Err(tf!("{client} 沒有專案層設定檔", client = client.label())),
        };
    }
    match client {
        Client::ClaudeCode => Ok(home()?.join(".claude.json")),
        Client::Codex => {
            let base = std::env::var_os("CODEX_HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty());
            Ok(match base {
                Some(b) => b.join("config.toml"),
                None => home()?.join(".codex").join("config.toml"),
            })
        }
        Client::Cursor => Ok(home()?.join(".cursor").join("mcp.json")),
        Client::Vscode => Ok(config_base()?.join("Code").join("User").join("mcp.json")),
        Client::ClaudeDesktop => Ok(config_base()?.join("Claude").join("claude_desktop_config.json")),
        Client::Windsurf => Ok(home()?.join(".codeium").join("windsurf").join("mcp_config.json")),
        Client::Json => Err(t!("通用 JSON 片段沒有固定的設定檔，請複製後自行貼上").to_string()),
    }
}

// ---------------------------------------------------------------------------
// 合併（純函式，可測）
// ---------------------------------------------------------------------------

/// 把伺服器合併進既有 JSON 設定；回 (新內容, 是否取代了同名項目)。
pub fn merge_json(client: Client, existing: Option<&str>, spec: &ServerSpec) -> Result<(String, bool), String> {
    let mut root: Value = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => serde_json::from_str(s).map_err(|_| t!("設定檔不是純 JSON（可能含註解或尾逗號），為免弄壞請複製片段手動貼上").to_string())?,
        None => json!({}),
    };
    let obj = root.as_object_mut().ok_or_else(|| t!("設定檔最外層不是 JSON 物件").to_string())?;
    let key = client.servers_key();
    let servers = obj.entry(key.to_string()).or_insert_with(|| json!({}));
    if servers.is_null() {
        *servers = json!({});
    }
    let servers = servers.as_object_mut().ok_or_else(|| tf!("設定檔的 {key} 不是物件", key = key))?;
    let name = sanitize_name(&spec.name);
    let replaced = servers.contains_key(&name);
    servers.insert(name, json_entry(client, &spec.transport)?);
    let mut text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    text.push('\n');
    Ok((text, replaced))
}

/// 從 JSON 設定移除伺服器；回 (新內容, 是否真的有移除)。
pub fn remove_json(client: Client, existing: &str, name: &str) -> Result<(String, bool), String> {
    let mut root: Value = serde_json::from_str(existing).map_err(|_| t!("設定檔不是純 JSON（可能含註解或尾逗號），為免弄壞請手動編輯").to_string())?;
    let name = sanitize_name(name);
    let removed = root
        .get_mut(client.servers_key())
        .and_then(|v| v.as_object_mut())
        .map(|m| m.shift_remove(&name).is_some())
        .unwrap_or(false);
    let mut text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    text.push('\n');
    Ok((text, removed))
}

/// TOML 表頭的鍵路徑（`[a.b]` / `[[a.b]]` / `[a."b"]` → `a.b`），非表頭回 None。
fn toml_header_path(line: &str) -> Option<String> {
    let t = line.trim();
    if !t.starts_with('[') {
        return None;
    }
    let inner = t.trim_start_matches('[');
    let end = inner.find(']')?;
    let path: String = inner[..end].split('.').map(|p| p.trim().trim_matches('"').trim_matches('\'')).collect::<Vec<_>>().join(".");
    Some(path)
}

/// 刪掉 Codex config.toml 裡 `[mcp_servers.<name>]` 與其子表（`[mcp_servers.<name>.env]`）；回 (新內容, 是否有刪)。
pub fn remove_codex_block(existing: &str, name: &str) -> (String, bool) {
    let name = sanitize_name(name);
    let own = format!("mcp_servers.{name}");
    let own_child = format!("{own}.");
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    let mut removed = false;
    for line in existing.lines() {
        if let Some(p) = toml_header_path(line) {
            skipping = p == own || p.starts_with(&own_child);
            removed |= skipping;
        }
        if !skipping {
            out.push(line);
        }
    }
    // 收掉刪除後留在結尾的空行。
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    let mut s = out.join("\n");
    if !s.is_empty() {
        s.push('\n');
    }
    (s, removed)
}

/// 把伺服器合併進 Codex config.toml（先刪同名區塊再接在最後）；回 (新內容, 是否取代)。
pub fn merge_codex(existing: Option<&str>, spec: &ServerSpec) -> (String, bool) {
    let (mut base, replaced) = remove_codex_block(existing.unwrap_or(""), &spec.name);
    if !base.is_empty() {
        base.push('\n');
    }
    base.push_str(&codex_block(spec));
    (base, replaced)
}

// ---------------------------------------------------------------------------
// 寫檔
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub path: String,
    /// 原檔備份（原本不存在則為 None）。
    pub backup: Option<String>,
    /// 取代了同名的既有項目。
    pub replaced: bool,
    /// 實際寫入的完整內容（預演時顯示用）。
    pub content: String,
}

fn backup_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".dbkit-bak");
    PathBuf::from(s)
}

/// 先備份、再寫暫存檔、最後 rename 覆蓋（Windows 的 rename 也會取代既有檔）。
fn write_atomic(path: &Path, content: &str) -> Result<Option<String>, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| tf!("建立資料夾失敗：{e}", e = e.to_string()))?;
    }
    let backup = if path.exists() {
        let b = backup_path(path);
        std::fs::copy(path, &b).map_err(|e| tf!("備份原設定檔失敗：{e}", e = e.to_string()))?;
        Some(b.display().to_string())
    } else {
        None
    };
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".dbkit-tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| tf!("寫入設定檔失敗：{e}", e = e.to_string()))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(tf!("寫入設定檔失敗：{e}", e = e.to_string()));
    }
    Ok(backup)
}

fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(tf!("讀取設定檔失敗：{e}", e = e.to_string())),
    }
}

/// 計算要寫入的內容（不寫檔）：`dry_run` 預演與實際寫入共用。
pub fn plan_install(client: Client, spec: &ServerSpec, project: Option<&Path>) -> Result<(PathBuf, String, bool), String> {
    if let Transport::Http { .. } = spec.transport {
        if !client.supports_http() {
            return Err(tf!("{client} 不支援直接連 HTTP 伺服器，請改用 stdio", client = client.label()));
        }
    }
    let path = config_path(client, project)?;
    let existing = read_existing(&path)?;
    let (content, replaced) = if client == Client::Codex {
        merge_codex(existing.as_deref(), spec)
    } else {
        merge_json(client, existing.as_deref(), spec)?
    };
    Ok((path, content, replaced))
}

/// 寫入用戶端設定檔。
pub fn install(client: Client, spec: &ServerSpec, project: Option<&Path>) -> Result<InstallOutcome, String> {
    let (path, content, replaced) = plan_install(client, spec, project)?;
    let backup = write_atomic(&path, &content)?;
    Ok(InstallOutcome { path: path.display().to_string(), backup, replaced, content })
}

/// 從用戶端設定檔移除；回是否真的有移除（沒有該項目時不動檔案）。
pub fn uninstall(client: Client, name: &str, project: Option<&Path>) -> Result<bool, String> {
    let path = config_path(client, project)?;
    let Some(existing) = read_existing(&path)? else {
        return Ok(false);
    };
    let (content, removed) = if client == Client::Codex {
        remove_codex_block(&existing, name)
    } else {
        remove_json(client, &existing, name)?
    };
    if removed {
        write_atomic(&path, &content)?;
    }
    Ok(removed)
}

/// 用戶端設定裡是否已有這個名稱（檔案不存在 / 解析不了 → false）。
pub fn is_installed(client: Client, name: &str, project: Option<&Path>) -> bool {
    let Ok(path) = config_path(client, project) else {
        return false;
    };
    let Ok(Some(text)) = read_existing(&path) else {
        return false;
    };
    let name = sanitize_name(name);
    if client == Client::Codex {
        let own = format!("mcp_servers.{name}");
        return text.lines().filter_map(toml_header_path).any(|p| p == own);
    }
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get(client.servers_key()).and_then(|s| s.get(&name)).map(|_| true))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(name: &str) -> ServerSpec {
        ServerSpec {
            name: name.into(),
            transport: Transport::Stdio { command: "C:\\Program Files\\db-kit\\dbk.exe".into(), args: vec!["mcp".into(), "--conn".into(), "c1".into()] },
        }
    }

    fn http(token: Option<&str>) -> ServerSpec {
        ServerSpec { name: "dbkit".into(), transport: Transport::Http { url: "http://127.0.0.1:8765/mcp".into(), token: token.map(String::from) } }
    }

    #[test]
    fn server_args_cover_single_multi_and_write_flags() {
        let a = ServerArgs { conn: Some("id-1".into()), database: Some("shop".into()), lang: Some("en".into()), ..Default::default() };
        assert_eq!(a.to_args(), ["mcp", "--conn", "id-1", "-d", "shop", "--lang", "en"]);
        let m = ServerArgs {
            connections: vec!["a".into(), " ".into(), "b".into()],
            allow_write: true,
            allow_destructive: true,
            out: Some("D:\\runs".into()),
            ..Default::default()
        };
        assert_eq!(m.to_args(), ["mcp", "--connections", "a,b", "--allow-write", "--allow-destructive", "--out", "D:\\runs"]);
        // 沒開寫入時，破壞 / 正式環境旗標不會單獨出現（clap 會因 requires 拒絕）。
        let w = ServerArgs { allow_destructive: true, allow_prod: true, ..Default::default() };
        assert_eq!(w.to_args(), ["mcp"]);
    }

    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize_name("My Shop (prod)"), "my-shop-prod");
        assert_eq!(sanitize_name("  "), "dbkit");
        assert_eq!(default_name(Some("訂單庫")), "dbkit");
        assert_eq!(default_name(Some("orders")), "dbkit-orders");
        assert_eq!(default_name(None), "dbkit");
    }

    #[test]
    fn json_entries_follow_each_client_shape() {
        let s = stdio("x").transport;
        assert_eq!(json_entry(Client::ClaudeCode, &s).unwrap()["type"], "stdio");
        assert!(json_entry(Client::Cursor, &s).unwrap().get("type").is_none());
        let h = http(Some("t0k")).transport;
        assert_eq!(json_entry(Client::Vscode, &h).unwrap()["type"], "http");
        assert_eq!(json_entry(Client::Windsurf, &h).unwrap()["serverUrl"], "http://127.0.0.1:8765/mcp");
        assert_eq!(json_entry(Client::Cursor, &h).unwrap()["headers"]["Authorization"], "Bearer t0k");
        assert!(json_entry(Client::ClaudeDesktop, &h).is_err());
        // 沒有權杖就不帶 headers。
        assert!(json_entry(Client::Cursor, &http(None).transport).unwrap().get("headers").is_none());
    }

    #[test]
    fn merge_json_keeps_other_servers_and_unrelated_keys() {
        let existing = r#"{ "theme": "dark", "mcpServers": { "other": { "command": "x" }, "dbkit": { "command": "old" } } }"#;
        let (out, replaced) = merge_json(Client::Cursor, Some(existing), &stdio("dbkit")).unwrap();
        assert!(replaced);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["dbkit"]["args"][2], "c1");
        // 鍵序保留：theme 仍在最前面。
        assert!(out.find("theme").unwrap() < out.find("mcpServers").unwrap());
        // VS Code 用 servers。
        let (vs, replaced) = merge_json(Client::Vscode, None, &stdio("dbkit")).unwrap();
        assert!(!replaced);
        assert!(serde_json::from_str::<Value>(&vs).unwrap()["servers"]["dbkit"].is_object());
        // 有註解的 JSONC 不硬改。
        assert!(merge_json(Client::Vscode, Some("{ // c\n }"), &stdio("dbkit")).is_err());
        // mcpServers 是 null 也能補上。
        let (n, _) = merge_json(Client::Cursor, Some(r#"{"mcpServers":null}"#), &stdio("dbkit")).unwrap();
        assert!(serde_json::from_str::<Value>(&n).unwrap()["mcpServers"]["dbkit"].is_object());
    }

    #[test]
    fn remove_json_only_touches_its_own_entry() {
        let existing = r#"{"mcpServers":{"other":{},"dbkit":{}}}"#;
        let (out, removed) = remove_json(Client::Cursor, existing, "dbkit").unwrap();
        assert!(removed);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["mcpServers"]["other"].is_object());
        assert!(v["mcpServers"].get("dbkit").is_none());
        assert!(!remove_json(Client::Cursor, existing, "nope").unwrap().1);
    }

    #[test]
    fn codex_block_escapes_windows_paths() {
        let b = codex_block(&stdio("dbkit"));
        assert!(b.starts_with("[mcp_servers.dbkit]\n"));
        assert!(b.contains(r#"command = "C:\\Program Files\\db-kit\\dbk.exe""#), "{b}");
        assert!(b.contains(r#"args = ["mcp", "--conn", "c1"]"#), "{b}");
        let h = codex_block(&http(Some("secret")));
        assert!(h.contains("bearer_token_env_var = \"DBKIT_MCP_TOKEN\""));
        assert!(!h.contains("secret"), "權杖不可寫進 config.toml");
    }

    #[test]
    fn merge_codex_replaces_block_and_children_only() {
        let existing = "model = \"o3\"\n\n[mcp_servers.dbkit]\ncommand = \"old\"\n\n[mcp_servers.dbkit.env]\nA = \"1\"\n\n[mcp_servers.other]\ncommand = \"keep\"\n\n[profiles.x]\nmodel = \"y\"\n";
        let (out, replaced) = merge_codex(Some(existing), &stdio("dbkit"));
        assert!(replaced);
        assert!(out.contains("model = \"o3\""));
        assert!(out.contains("[mcp_servers.other]\ncommand = \"keep\""));
        assert!(out.contains("[profiles.x]"));
        assert!(!out.contains("command = \"old\""));
        assert!(!out.contains("[mcp_servers.dbkit.env]"));
        assert_eq!(out.matches("[mcp_servers.dbkit]").count(), 1);
        // 新區塊在最後。
        assert!(out.trim_end().ends_with(r#"args = ["mcp", "--conn", "c1"]"#));
        // 空檔
        let (fresh, r) = merge_codex(None, &stdio("dbkit"));
        assert!(!r);
        assert!(fresh.starts_with("[mcp_servers.dbkit]"));
        // 帶引號的表頭也認得。
        let (_, r2) = remove_codex_block("[mcp_servers.\"dbkit\"]\ncommand = \"x\"\n", "dbkit");
        assert!(r2);
    }

    #[test]
    fn snippets_and_cli_commands() {
        let s = snippet(Client::ClaudeCode, &stdio("dbkit"), None).unwrap();
        assert_eq!(s.language, "json");
        assert!(s.text.contains("\"mcpServers\""));
        let cli = s.cli.unwrap();
        assert!(cli.starts_with("claude mcp add --scope user dbkit -- \"C:\\Program Files\\db-kit\\dbk.exe\" mcp --conn c1"), "{cli}");
        let c = snippet(Client::Codex, &http(Some("t")), None).unwrap();
        assert_eq!(c.language, "toml");
        assert!(!c.notes.is_empty());
        assert!(c.cli.unwrap().contains("--bearer-token-env-var DBKIT_MCP_TOKEN"));
        let j = snippet(Client::Json, &stdio("dbkit"), None).unwrap();
        assert!(j.path.is_none());
        assert!(snippet(Client::ClaudeDesktop, &http(None), None).is_err());
    }

    #[test]
    fn install_writes_backup_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("dbkit-mcp-setup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join(".mcp.json");
        std::fs::write(&cfg, r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        let o = install(Client::ClaudeCode, &stdio("dbkit"), Some(&dir)).unwrap();
        assert!(!o.replaced);
        assert!(o.backup.is_some());
        assert!(is_installed(Client::ClaudeCode, "dbkit", Some(&dir)));
        let o2 = install(Client::ClaudeCode, &stdio("dbkit"), Some(&dir)).unwrap();
        assert!(o2.replaced);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert!(uninstall(Client::ClaudeCode, "dbkit", Some(&dir)).unwrap());
        assert!(!is_installed(Client::ClaudeCode, "dbkit", Some(&dir)));
        assert!(!uninstall(Client::ClaudeCode, "dbkit", Some(&dir)).unwrap());
        // Codex 專案層
        install(Client::Codex, &stdio("dbkit"), Some(&dir)).unwrap();
        assert!(is_installed(Client::Codex, "dbkit", Some(&dir)));
        // 不留暫存檔
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains("dbkit-tmp")).collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
