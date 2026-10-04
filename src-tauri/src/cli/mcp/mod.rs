//! `dbk mcp`：以 MCP（Model Context Protocol）伺服器把資料庫工具提供給 AI 用戶端
//! （Claude Code / Codex / Cursor / VS Code / Claude Desktop / 任何支援 MCP 的 agent）。
//!
//! 為何手刻而不用 `rmcp` crate：只需要 5 個方法（initialize / ping / tools/list / tools/call /
//! notifications），wire format 就是 JSON-RPC 2.0；拉一個帶 proc-macro 與 schemars 的
//! 框架進 slim binary 不划算，而且 MSRV 比本 crate 動得快。HTTP 傳輸同理（見 `http`）。
//!
//! 模組分工：
//! - 本檔：協定（JSON-RPC 分派、工具清單、工具呼叫）與 stdio 主迴圈、`config` / `install` 子指令。
//! - `registry`：單一連線（`--conn` / `--url`）或多連線（全部已存連線，`--connections` 白名單）；連線延遲建立。
//! - `extra`：MCP 專屬的唯讀延伸工具（list_connections / list_routines / get_ddl / compare_schema）。
//! - `write`：`--allow-write` 的寫入工具（preview_write → 審查代碼 → execute_write，走審查並執行核心）。
//! - `http`：`--http` 的 Streamable HTTP 傳輸。
//!
//! 行為：
//! - stdio 模式 stdout **只**走協定，所有診斷一律 stderr（混進 stdout 會讓用戶端整條連線失效）。
//! - 連線延遲到第一次工具呼叫才建立：`initialize` / `tools/list` 不該因為資料庫暫時連不上就失敗。
//! - 工具失敗回 `isError: true` 的**結果**而非 JSON-RPC 錯誤（MCP 規範：讓模型看到錯誤文字自行修正）。
//! - 預設唯讀。寫入要伺服器啟動時明確 `--allow-write`；高破壞 / 正式環境再各要一個旗標，模型改不了。

mod extra;
mod http;
mod registry;
mod write;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::dbtools::{self, ToolDef};
use crate::error::{AppError, AppResult};
use crate::mcp_setup::{self, Client, ServerArgs, ServerSpec, Transport};

use super::args::{ConnArgs, McpAction, McpArgs, McpClientArg, McpClientArgs, McpServeOpts};
use registry::{Mode, Registry};
use write::{PendingStore, WritePolicy};

/// 我們實作的協定版本；用戶端送來的版本若在支援清單內就回它那一版。
pub const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

pub struct McpServer {
    reg: Registry,
    /// `--tools` 限定的工具子集（DBA agent 審查依人設與隱私設定傳入）；None = 全部。
    allow: Option<Vec<String>>,
    /// `--allow-write` 才有；None = 唯讀伺服器（寫入工具不列出、硬叫也擋）。
    write: Option<WritePolicy>,
    pending: PendingStore,
}

/// 預設的寫入輸出目錄：`<設定目錄>/mcp-runs`。
fn default_out_dir() -> PathBuf {
    crate::store::headless_config_dir().map(|d| d.join("mcp-runs")).unwrap_or_else(|_| std::env::temp_dir().join("dbkit-mcp-runs"))
}

impl McpServer {
    pub fn new(conn: &ConnArgs, o: &McpServeOpts) -> McpServer {
        let tools: Vec<String> = o.tools.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        let allow = if tools.is_empty() { None } else { Some(tools) };
        let write = o.allow_write.then(|| WritePolicy {
            allow_destructive: o.allow_destructive,
            allow_prod: o.allow_prod,
            out: o.out.as_deref().map(PathBuf::from).unwrap_or_else(default_out_dir),
        });
        McpServer {
            reg: Registry::new(Mode::from_args(conn, &o.connections), allow.clone()),
            allow,
            write,
            pending: PendingStore::default(),
        }
    }

    fn allows(&self, name: &str) -> bool {
        self.allow.as_ref().is_none_or(|a| a.iter().any(|n| n == name))
    }

    fn instructions(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        if self.reg.is_multi() {
            parts.push(t!("這些工具存取使用者在 db-kit 存好的資料庫連線。先呼叫 list_connections 看有哪些連線，其餘工具都要以 connection 參數指定連線名稱。"));
            parts.push(t!("寫查詢前先用 describe_table 確認欄名；查詢一律加 LIMIT；不要猜測不存在的表或欄位。"));
        } else {
            parts.push(t!("這些工具唯讀地存取使用者在 db-kit 選定的資料庫連線。寫查詢前先用 describe_table 確認欄名；查詢一律加 LIMIT；不要猜測不存在的表或欄位。"));
        }
        if self.write.is_some() {
            parts.push(t!("修改資料或結構一律先呼叫 preview_write，把影響列數與回滾能力給使用者看過、取得同意後，才以審查代碼呼叫 execute_write。不要用 run_query 嘗試寫入。"));
        }
        parts.join("\n")
    }

    /// 多連線模式的資料庫工具：說明不綁種類，每支都要 `connection`。
    fn multi_db_defs() -> Vec<ToolDef> {
        let mut v = dbtools::tool_defs(crate::db::DbKind::Mysql, false);
        for d in v.iter_mut() {
            if d.name == "run_query" {
                d.description.push(' ');
                d.description.push_str(t!("MongoDB 連線的 query 改用 JSON（{\"collection\":\"..\",\"filter\":{}}），Redis 連線用命令列（如 GET k）；連線種類見 list_connections。"));
            }
        }
        v
    }

    /// 在 inputSchema 加上必填的 `connection`。
    fn add_connection_param(d: &mut ToolDef) {
        let Some(obj) = d.input_schema.as_object_mut() else { return };
        let props = obj.entry("properties").or_insert_with(|| json!({}));
        if let Some(p) = props.as_object_mut() {
            p.insert("connection".into(), json!({ "type": "string", "description": t!("連線名稱（見 list_connections）") }));
        }
        let req = obj.entry("required").or_insert_with(|| json!([]));
        if let Some(r) = req.as_array_mut() {
            r.insert(0, json!("connection"));
        }
    }

    /// 這台伺服器提供的工具（依模式、連線種類、寫入政策與 `--tools` 白名單）。
    async fn tool_defs(&self) -> Result<Vec<ToolDef>, String> {
        let mut defs: Vec<ToolDef> = Vec::new();
        if self.reg.is_multi() {
            defs.push(extra::list_connections_def());
            let mut rest = Self::multi_db_defs();
            rest.extend(extra::defs());
            if self.write.is_some() {
                rest.extend(write::defs());
            }
            for d in rest.iter_mut() {
                Self::add_connection_param(d);
            }
            defs.extend(rest);
        } else {
            let t = self.reg.target(&Value::Null).await?;
            defs.extend(dbtools::tool_defs(t.kind, t.prod));
            if crate::review_run::analyze::supported_kind(t.kind) {
                defs.extend(extra::defs());
                if self.write.is_some() {
                    defs.extend(write::defs());
                }
            }
        }
        Ok(defs.into_iter().filter(|d| self.allows(d.name)).collect())
    }

    fn is_known(name: &str) -> bool {
        dbtools::is_db_tool(name)
            || matches!(
                name,
                extra::LIST_CONNECTIONS | extra::LIST_ROUTINES | extra::GET_DDL | extra::COMPARE_SCHEMA | write::PREVIEW_WRITE | write::EXECUTE_WRITE
            )
    }

    /// 執行一支工具；Err 是給模型看的錯誤文字（外層包成 isError 結果）。
    async fn call_tool(&self, name: &str, args: &Value) -> Result<String, String> {
        if !Self::is_known(name) {
            return Err(tf!("未知的工具：{name}", name = name));
        }
        if !self.allows(name) {
            return Err(tf!("這次審查不允許使用 {name}（DBA 人設或隱私設定限制了可用的工具）", name = name));
        }
        match name {
            extra::LIST_CONNECTIONS => {
                if !self.reg.is_multi() {
                    return Err(t!("這個 MCP 伺服器只綁定一條連線，不需要 list_connections").to_string());
                }
                let list = self.reg.saved().await?;
                let writable = |c: &registry::ConnInfo| {
                    self.write.as_ref().is_some_and(|w| crate::review_run::analyze::supported_kind(c.kind) && (!c.prod || w.allow_prod))
                };
                Ok(extra::format_connections(&list, writable))
            }
            write::PREVIEW_WRITE => {
                let policy = self.write.as_ref().ok_or_else(|| t!("這個 MCP 伺服器沒有開放寫入（啟動時要加 --allow-write）").to_string())?;
                let target = self.reg.target(args).await?;
                write::precheck(&target, policy)?;
                let ctx = self.reg.ctx(args).await?;
                let ns = write::namespace(&ctx, args, self.reg.namespace_flag());
                write::preview(&ctx, &target, &ns, args, policy, &self.pending).await
            }
            write::EXECUTE_WRITE => {
                let policy = self.write.as_ref().ok_or_else(|| t!("這個 MCP 伺服器沒有開放寫入（啟動時要加 --allow-write）").to_string())?;
                let (key, h) = write::take(&self.pending, args)?;
                // 審查代碼綁定預覽時的連線：不看這次的 connection 參數。
                let at = json!({ "connection": key });
                let target = self.reg.target(&at).await?;
                write::precheck(&target, policy)?;
                let ctx = self.reg.ctx(&at).await?;
                write::execute(&ctx, h, args, policy, &self.pending).await
            }
            _ => {
                // 唯讀守門搬到連線**之前**。`dbtools::call` 裡本來就有一份（真正的防線），
                // 但那要先連上才跑得到：模型送 `DROP TABLE` 過來時會先撥一次連線、再收到一句
                // 「連線失敗」——它學到的是「這裡連不上」而不是「這裡不准寫」，於是繼續重試。
                // 種類從設定就讀得到，不必連線。
                let target = self.reg.target(args).await?;
                if matches!(name, "run_query" | "explain_query") {
                    if let Some(q) = args.get("query").or_else(|| args.get("sql")).and_then(|v| v.as_str()) {
                        if let Err(e) = dbtools::ensure_tool_read_only(target.kind, q) {
                            return Err(if self.write.is_some() {
                                format!("{e}\n{}", t!("要修改資料請改用 preview_write。"))
                            } else {
                                e
                            });
                        }
                    }
                }
                // e 已經是完整句子（`AppError::message()` 自帶「連線失敗：」等前綴），不再包一層。
                let ctx = self.reg.ctx(args).await?;
                match name {
                    extra::LIST_ROUTINES => extra::list_routines(&ctx, args).await,
                    extra::GET_DDL => extra::get_ddl(&ctx, args).await,
                    extra::COMPARE_SCHEMA => {
                        let dst = match args.get("target_connection").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                            Some(tc) if self.reg.is_multi() => self.reg.ctx(&json!({ "connection": tc })).await?,
                            Some(_) => return Err(t!("單一連線模式不能指定 target_connection；請改用 target_database").to_string()),
                            None => ctx.clone(),
                        };
                        extra::compare_schema(&ctx, &dst, args).await
                    }
                    _ => dbtools::call(&ctx, name, args).await.map(|o| o.text),
                }
            }
        }
    }

    /// 處理一行輸入。回 `None` 表示不需回應（通知 / 回應訊息 / 空行）。
    pub async fn handle_line(&self, line: &str) -> Option<Value> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(v) => self.handle_value(v).await,
            Err(_) => Some(rpc_err(&Value::Null, -32700, "Parse error")),
        }
    }

    /// 處理一則已解析的訊息（單一或批次）。
    pub async fn handle_value(&self, v: Value) -> Option<Value> {
        match v {
            Value::Array(batch) => {
                let mut out = Vec::new();
                for req in &batch {
                    if let Some(r) = self.handle_request(req).await {
                        out.push(r);
                    }
                }
                if out.is_empty() { None } else { Some(Value::Array(out)) }
            }
            other => self.handle_request(&other).await,
        }
    }

    /// 處理單一 JSON-RPC 物件。
    pub async fn handle_request(&self, req: &Value) -> Option<Value> {
        let method = req.get("method").and_then(|m| m.as_str());
        let id = req.get("id").cloned();
        // 沒有 method 的物件是「回應」（用戶端回我們的 ping 等）：忽略。
        let method = method?;
        // 通知（沒有 id）：initialized / cancelled / progress…一律不回。
        let Some(id) = id else {
            return None;
        };
        if id.is_null() {
            return None;
        }
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(|p| p.as_str()).unwrap_or(PROTOCOL_VERSION);
                let ver = if SUPPORTED_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSION };
                Ok(json!({
                    "protocolVersion": ver,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "dbk", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": self.instructions()
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => match self.tool_defs().await {
                Ok(defs) => {
                    let tools: Vec<Value> = defs
                        .into_iter()
                        .map(|d| json!({ "name": d.name, "description": d.description, "inputSchema": d.input_schema }))
                        .collect();
                    Ok(json!({ "tools": tools }))
                }
                Err(e) => Err((-32603, e)),
            },
            "tools/call" => {
                let Some(name) = params.get("name").and_then(|n| n.as_str()) else {
                    return Some(rpc_err(&id, -32602, "Missing params.name"));
                };
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                Ok(match self.call_tool(name, &args).await {
                    Ok(text) => tool_result(&text, false),
                    Err(e) => tool_result(&e, true),
                })
            }
            // 有些用戶端會順手探詢；回空清單比 -32601 友善。
            "resources/list" => Ok(json!({ "resources": [] })),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
            "prompts/list" => Ok(json!({ "prompts": [] })),
            other => Err((-32601, format!("Method not found: {other}"))),
        };
        Some(match result {
            Ok(r) => rpc_ok(&id, r),
            Err((code, msg)) => rpc_err(&id, code, &msg),
        })
    }

    /// 收尾：釋放連線池（stdin EOF / 用戶端關閉 / Ctrl+C 時）。
    pub async fn shutdown(&self) {
        self.reg.shutdown().await;
    }
}

fn tool_result(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_err(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// `dbk mcp [config|install]` 進入點。
pub async fn run(conn: &ConnArgs, a: McpArgs) -> AppResult<()> {
    match a.action {
        Some(McpAction::Config(c)) => client_config(conn, c, false).await,
        Some(McpAction::Install(c)) => client_config(conn, c, true).await,
        None => serve(conn, a.serve).await,
    }
}

fn has_single(conn: &ConnArgs) -> bool {
    conn.conn.is_some() || conn.url.is_some() || conn.kind.is_some()
}

async fn serve(conn: &ConnArgs, o: McpServeOpts) -> AppResult<()> {
    if has_single(conn) && !o.connections.is_empty() {
        return Err(AppError::Query(t!("--connections 只用於多連線模式；已用 --conn / --url 指定單一連線時不要再給").into()));
    }
    let server = Arc::new(McpServer::new(conn, &o));
    if let Some(addr) = o.http.as_deref() {
        return http::serve(server, addr, o.token.clone()).await;
    }
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    eprintln!("[dbk mcp] {}", t!("MCP 伺服器已啟動（stdio）；等待用戶端 initialize…"));
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(resp) = server.handle_line(&line).await {
            let mut s = resp.to_string();
            s.push('\n');
            if out.write_all(s.as_bytes()).await.is_err() {
                break;
            }
            let _ = out.flush().await;
        }
    }
    server.shutdown().await;
    Ok(())
}

fn client_of(c: McpClientArg) -> Client {
    match c {
        McpClientArg::ClaudeCode => Client::ClaudeCode,
        McpClientArg::Codex => Client::Codex,
        McpClientArg::Cursor => Client::Cursor,
        McpClientArg::Vscode => Client::Vscode,
        McpClientArg::ClaudeDesktop => Client::ClaudeDesktop,
        McpClientArg::Windsurf => Client::Windsurf,
        McpClientArg::Json => Client::Json,
    }
}

/// `dbk mcp config|install`：產生 / 寫入 AI 用戶端設定。設定裡只放連線 id，不放帳密。
async fn client_config(conn: &ConnArgs, c: McpClientArgs, install: bool) -> AppResult<()> {
    if conn.url.is_some() || conn.kind.is_some() {
        return Err(AppError::Unsupported(
            t!("設定檔不放帳密：請先在 db-kit 把連線存起來，再以 --conn <名稱> 指定").into(),
        ));
    }
    if c.serve.http.is_some() {
        return Err(AppError::Query(t!("config / install 不用 --http；要連到已在執行的 HTTP 伺服器請用 --http-url").into()));
    }
    if conn.conn.is_some() && !c.serve.connections.is_empty() {
        return Err(AppError::Query(t!("--connections 只用於多連線模式；已用 --conn / --url 指定單一連線時不要再給").into()));
    }
    let client = client_of(c.client);
    // 單一連線：以 id 寫進設定（改名不會斷），預設伺服器名用連線名。
    let saved = match conn.conn.as_deref() {
        Some(needle) => {
            let dir = crate::store::headless_config_dir()?;
            let all = crate::store::load_all_in(&dir).await?;
            let found = all
                .iter()
                .find(|x| x.name == needle)
                .or_else(|| all.iter().find(|x| x.id == needle))
                .ok_or_else(|| AppError::NotFound(needle.to_string()))?;
            Some((found.id.clone(), found.name.clone()))
        }
        None => None,
    };
    let name = c.name.clone().map(|n| mcp_setup::sanitize_name(&n)).unwrap_or_else(|| mcp_setup::default_name(saved.as_ref().map(|(_, n)| n.as_str())));
    let transport = match c.http_url.as_deref() {
        Some(url) => Transport::Http { url: url.trim().to_string(), token: c.serve.token.clone().filter(|t| !t.trim().is_empty()) },
        None => {
            let command = match &c.bin {
                Some(b) => b.clone(),
                None => std::env::current_exe().map(|p| p.display().to_string()).map_err(|e| AppError::Storage(e.to_string()))?,
            };
            let args = ServerArgs {
                conn: saved.as_ref().map(|(id, _)| id.clone()),
                database: conn.database.clone(),
                connections: c.serve.connections.clone(),
                tools: c.serve.tools.clone(),
                allow_write: c.serve.allow_write,
                allow_destructive: c.serve.allow_destructive,
                allow_prod: c.serve.allow_prod,
                out: c.serve.out.clone(),
                lang: conn.lang.clone(),
            }
            .to_args();
            Transport::Stdio { command, args }
        }
    };
    let spec = ServerSpec { name, transport };
    let project = c.project.as_deref().map(PathBuf::from);
    let snip = mcp_setup::snippet(client, &spec, project.as_deref()).map_err(AppError::Query)?;
    if !install {
        println!("{}", snip.text.trim_end());
        if let Some(p) = &snip.path {
            eprintln!("{}", tf!("設定檔：{path}", path = p));
        }
        if let Some(cmd) = &snip.cli {
            eprintln!("{}", tf!("或執行：{cmd}", cmd = cmd));
        }
        for n in &snip.notes {
            eprintln!("note: {n}");
        }
        return Ok(());
    }
    let (path, _, replaced) = mcp_setup::plan_install(client, &spec, project.as_deref()).map_err(AppError::Query)?;
    let action = tf!(
        "{verb} {client} 設定檔 {path} 的「{name}」",
        verb = if replaced { t!("取代") } else { t!("新增到") },
        client = client.label(),
        path = path.display().to_string(),
        name = spec.name
    );
    if !conn.yes {
        println!("{}", snip.text.trim_end());
    }
    super::guard::ensure_confirmed(conn.yes, false, false, &action)?;
    let o = mcp_setup::install(client, &spec, project.as_deref()).map_err(AppError::Query)?;
    println!("{}", tf!("已寫入 {path}", path = o.path));
    if let Some(b) = &o.backup {
        eprintln!("{}", tf!("原檔備份：{path}", path = b));
    }
    for n in &snip.notes {
        eprintln!("note: {n}");
    }
    eprintln!("{}", tf!("重新啟動 {client} 後即可使用。", client = client.label()));
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::cli::args::{Cli, Command};
    use clap::Parser;

    /// `dbk <pre…> mcp <post…>` 解析成伺服器。
    pub(crate) fn server_with(pre: &[&str], post: &[&str]) -> McpServer {
        let mut full = vec!["dbk"];
        full.extend_from_slice(pre);
        full.push("mcp");
        full.extend_from_slice(post);
        let cli = Cli::try_parse_from(full).expect("parse");
        let Command::Mcp(a) = cli.command else { panic!("not mcp") };
        McpServer::new(&cli.conn, &a.serve)
    }

    pub(crate) fn server(argv: &[&str]) -> McpServer {
        server_with(argv, &[])
    }

    fn req(id: i64, method: &str, params: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
    }

    fn call(id: i64, tool: &str, args: Value) -> String {
        req(id, "tools/call", json!({ "name": tool, "arguments": args }))
    }

    fn text(r: &Value) -> String {
        r["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
    }

    fn names(r: &Value) -> Vec<String> {
        r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn cli_shapes_parse() {
        // GUI 助手的寫法（全域旗標放在 mcp 之後）必須照舊能用。
        let cli = Cli::try_parse_from(["dbk", "mcp", "--conn", "id1", "-d", "shop", "--lang", "en", "--tools", "describe_table,explain_query"]).unwrap();
        let Command::Mcp(a) = cli.command else { panic!() };
        assert_eq!(cli.conn.conn.as_deref(), Some("id1"));
        assert_eq!(a.serve.tools, ["describe_table", "explain_query"]);
        // 破壞 / 正式環境旗標要先開寫入。
        assert!(Cli::try_parse_from(["dbk", "mcp", "--allow-destructive"]).is_err());
        assert!(Cli::try_parse_from(["dbk", "mcp", "--allow-write", "--allow-prod", "--http", "8765"]).is_ok());
        // 伺服器選項與子指令互斥。
        assert!(Cli::try_parse_from(["dbk", "mcp", "--allow-write", "config", "--client", "cursor"]).is_err());
        let cli = Cli::try_parse_from(["dbk", "--conn", "shop", "mcp", "install", "--client", "claude-code", "--allow-write", "--yes"]).unwrap();
        let Command::Mcp(a) = cli.command else { panic!() };
        let Some(McpAction::Install(c)) = a.action else { panic!() };
        assert!(c.serve.allow_write);
        assert!(cli.conn.yes);
    }

    #[tokio::test]
    async fn initialize_echoes_supported_version_and_server_info() {
        let s = server(&["--kind", "mysql", "--host", "127.0.0.1", "--port", "1"]);
        let r = s.handle_line(&req(1, "initialize", json!({ "protocolVersion": "2025-03-26", "capabilities": {} }))).await.unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "dbk");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        assert!(!r["result"]["instructions"].as_str().unwrap().contains("preview_write"));
        // 不認得的版本 → 回我們的版本
        let r = s.handle_line(&req(2, "initialize", json!({ "protocolVersion": "1999-01-01" }))).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);
        // 開寫入時指示會提醒先預覽
        let w = server_with(&["--kind", "mysql"], &["--allow-write"]);
        let r = w.handle_line(&req(3, "initialize", json!({}))).await.unwrap();
        assert!(r["result"]["instructions"].as_str().unwrap().contains("preview_write"));
    }

    #[tokio::test]
    async fn tools_list_derives_kind_without_connecting() {
        let s = server(&["--kind", "mysql", "--host", "127.0.0.1", "--port", "1"]);
        let r = s.handle_line(&req(3, "tools/list", json!({}))).await.unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        // 6 支資料庫工具 + 3 支延伸唯讀工具，沒有寫入工具。
        assert_eq!(tools.len(), dbtools::TOOL_NAMES.len() + 3);
        let n = names(&r);
        assert!(n.contains(&"get_ddl".to_string()) && n.contains(&"compare_schema".to_string()));
        assert!(!n.iter().any(|x| x.contains("write") || x == "list_connections"));
        let run = tools.iter().find(|t| t["name"] == "run_query").unwrap();
        assert_eq!(run["inputSchema"]["type"], "object");
        assert!(run["inputSchema"]["required"].as_array().unwrap().contains(&json!("query")));
        // Redis：少 explain_query，也沒有 SQL 延伸工具。
        let s2 = server(&["--kind", "redis", "--host", "127.0.0.1", "--port", "1"]);
        let r2 = s2.handle_line(&req(4, "tools/list", json!({}))).await.unwrap();
        assert_eq!(r2["result"]["tools"].as_array().unwrap().len(), 5);
        // --tools 白名單照樣收斂（DBA 審查用）。
        let s3 = server_with(&["--kind", "mysql"], &["--tools", "describe_table,get_ddl"]);
        let r3 = s3.handle_line(&req(5, "tools/list", json!({}))).await.unwrap();
        assert_eq!(names(&r3), ["describe_table", "get_ddl"]);
    }

    #[tokio::test]
    async fn write_tools_only_with_allow_write() {
        let w = server_with(&["--kind", "mysql", "--host", "127.0.0.1", "--port", "1"], &["--allow-write"]);
        let r = w.handle_line(&req(1, "tools/list", json!({}))).await.unwrap();
        let n = names(&r);
        assert!(n.contains(&"preview_write".to_string()) && n.contains(&"execute_write".to_string()));
        // 唯讀伺服器硬叫寫入工具：明講沒開放，而不是「未知的工具」。
        let ro = server(&["--kind", "mysql"]);
        let e = ro.handle_line(&call(2, "preview_write", json!({ "sql": "delete from t where id=1" }))).await.unwrap();
        assert_eq!(e["result"]["isError"], true);
        assert!(text(&e).contains("--allow-write"), "{}", text(&e));
        // 審查代碼不對 → isError
        let e = w.handle_line(&call(3, "execute_write", json!({ "review_token": "nope" }))).await.unwrap();
        assert_eq!(e["result"]["isError"], true);
        // Redis 連線不支援寫入工具（不撥連線就擋）。
        let rd = server_with(&["--kind", "redis", "--host", "127.0.0.1", "--port", "1"], &["--allow-write"]);
        let r = rd.handle_line(&req(4, "tools/list", json!({}))).await.unwrap();
        assert!(!names(&r).contains(&"preview_write".to_string()));
        let e = rd.handle_line(&call(5, "preview_write", json!({ "sql": "SET k v" }))).await.unwrap();
        assert!(text(&e).contains("redis"), "{}", text(&e));
        // 開寫入時 run_query 擋下寫入語句會指路到 preview_write。
        let e = w.handle_line(&call(6, "run_query", json!({ "query": "DELETE FROM t" }))).await.unwrap();
        assert!(text(&e).contains("preview_write"));
    }

    #[tokio::test]
    async fn multi_mode_requires_connection_param() {
        let m = server(&[]);
        let r = m.handle_line(&req(1, "tools/list", json!({}))).await.unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"], "list_connections");
        for t in tools.iter().skip(1) {
            let req = t["inputSchema"]["required"].as_array().unwrap();
            assert_eq!(req[0], "connection", "{}", t["name"]);
            assert!(t["inputSchema"]["properties"]["connection"].is_object());
        }
        // 沒給 connection → isError 結果（不是協定錯誤）。
        let e = m.handle_line(&call(2, "list_tables", json!({}))).await.unwrap();
        assert_eq!(e["result"]["isError"], true);
        assert!(text(&e).contains("connection"));
        // 找不到的連線
        let e = m.handle_line(&call(3, "list_tables", json!({ "connection": "definitely-not-a-saved-connection-xyz" }))).await.unwrap();
        assert_eq!(e["result"]["isError"], true);
        assert!(text(&e).contains("list_connections"));
        // 白名單收得很死時列表是空的。
        let w = server_with(&[], &["--connections", "definitely-not-a-saved-connection-xyz"]);
        let r = w.handle_line(&call(4, "list_connections", json!({}))).await.unwrap();
        assert_eq!(r["result"]["isError"], false);
        // 單一連線模式叫 list_connections → 明講不需要。
        let s = server(&["--kind", "mysql"]);
        let e = s.handle_line(&call(5, "list_connections", json!({}))).await.unwrap();
        assert_eq!(e["result"]["isError"], true);
    }

    #[tokio::test]
    async fn notifications_responses_and_bad_json() {
        let s = server(&["--kind", "mysql"]);
        assert!(s.handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await.is_none());
        assert!(s.handle_line(r#"{"jsonrpc":"2.0","id":9,"result":{}}"#).await.is_none());
        assert!(s.handle_line("").await.is_none());
        let bad = s.handle_line("{not json").await.unwrap();
        assert_eq!(bad["error"]["code"], -32700);
        assert!(bad["id"].is_null());
    }

    #[tokio::test]
    async fn unknown_method_and_ping() {
        let s = server(&["--kind", "mysql"]);
        let r = s.handle_line(&req(5, "foo/bar", json!({}))).await.unwrap();
        assert_eq!(r["error"]["code"], -32601);
        let p = s.handle_line(&req(6, "ping", json!({}))).await.unwrap();
        assert_eq!(p["result"], json!({}));
        let pl = s.handle_line(&req(7, "prompts/list", json!({}))).await.unwrap();
        assert_eq!(pl["result"]["prompts"], json!([]));
    }

    #[tokio::test]
    async fn tools_call_errors_are_results_not_rpc_errors() {
        // 已存連線不存在 → 連線失敗，但仍是 isError 結果（模型能讀到原因）。
        let s = server(&["--conn", "definitely-not-a-saved-connection"]);
        let r = s.handle_line(&call(8, "list_tables", json!({}))).await.unwrap();
        assert!(r.get("error").is_none());
        assert_eq!(r["result"]["isError"], true);
        // 錯誤訊息只包一層（`AppError::message()` 自帶前綴）。
        let msg = text(&r);
        assert!(msg.contains("找不到連線"), "{msg}");
        assert!(!msg.contains("連線失敗：連線失敗"), "{msg}");
        // 未知工具
        let u = s.handle_line(&call(9, "drop_everything", json!({}))).await.unwrap();
        assert_eq!(u["result"]["isError"], true);
        // 缺 name → 參數錯誤
        let m = s.handle_line(&req(10, "tools/call", json!({}))).await.unwrap();
        assert_eq!(m["error"]["code"], -32602);
    }

    /// 寫入語句在「撥連線之前」就被擋掉：連不上的主機也必須回唯讀錯誤而不是連線錯誤，
    /// 否則模型會把「不准寫」誤讀成「連不上」然後一直重試。
    #[tokio::test]
    async fn write_is_rejected_before_connecting() {
        let s = server(&["--kind", "mysql", "--host", "127.0.0.1", "--port", "1"]);
        for (tool, q) in [
            ("run_query", "DROP TABLE users"),
            ("run_query", "select 1; delete from t"),
            ("explain_query", "EXPLAIN ANALYZE DELETE FROM t"),
        ] {
            let r = s.handle_line(&call(20, tool, json!({ "query": q }))).await.unwrap();
            assert_eq!(r["result"]["isError"], true, "{q}");
            let msg = text(&r);
            assert!(!msg.contains("連線失敗") && !msg.contains("找不到連線"), "{q} → {msg}");
        }
        // 唯讀查詢照常往下走到連線（這裡會失敗，但錯的是連線而不是守門）。
        let ok = s.handle_line(&call(21, "run_query", json!({ "query": "select 1" }))).await.unwrap();
        assert_eq!(ok["result"]["isError"], true);
        assert!(text(&ok).contains("連線"));
    }

    #[tokio::test]
    async fn batch_requests_get_batch_response() {
        let s = server(&["--kind", "mysql"]);
        let batch = json!([
            { "jsonrpc": "2.0", "id": 1, "method": "ping" },
            { "jsonrpc": "2.0", "method": "notifications/initialized" }
        ])
        .to_string();
        let r = s.handle_line(&batch).await.unwrap();
        assert_eq!(r.as_array().unwrap().len(), 1);
    }

    /// 真的走一趟：SQLite 暫存檔 → 預覽 → 執行 → 查詢 → DDL / 程序清單 → 回滾腳本落地。
    #[tokio::test]
    async fn sqlite_end_to_end_preview_execute_query() {
        let dir = std::env::temp_dir().join(format!("dbkit-mcp-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db").display().to_string();
        let out = dir.join("runs").display().to_string();
        let s = server_with(&["--kind", "sqlite", "-d", &db], &["--allow-write", "--out", &out]);

        // 建表 + 灌資料
        let p = s
            .handle_line(&call(1, "preview_write", json!({ "sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1,'a'),(2,'b');" })))
            .await
            .unwrap();
        assert_eq!(p["result"]["isError"], false, "{}", text(&p));
        // 審查代碼是 12 位小寫十六進位。
        let tok = |r: &Value| {
            text(r)
                .split(|c: char| !c.is_ascii_alphanumeric())
                .find(|w| w.len() == 12 && w.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)))
                .unwrap_or_default()
                .to_string()
        };
        let token = tok(&p);
        assert_eq!(token.len(), 12, "{}", text(&p));
        let e = s.handle_line(&call(2, "execute_write", json!({ "review_token": token }))).await.unwrap();
        // CREATE TABLE 沒有完整回滾（前像不存在）時要明示同意；兩種情況都接受，但最後一定要執行成功。
        let e = if e["result"]["isError"] == true && text(&e).contains("acknowledge_incomplete") {
            s.handle_line(&call(3, "execute_write", json!({ "review_token": token, "acknowledge_incomplete": true }))).await.unwrap()
        } else {
            e
        };
        assert_eq!(e["result"]["isError"], false, "{}", text(&e));
        assert!(text(&e).contains(&out) || text(&e).contains("runs"), "{}", text(&e));
        // 同一個代碼不能再用
        let again = s.handle_line(&call(4, "execute_write", json!({ "review_token": token, "acknowledge_incomplete": true }))).await.unwrap();
        assert_eq!(again["result"]["isError"], true);

        // 改一列，回滾等級應為完整
        let p = s.handle_line(&call(5, "preview_write", json!({ "sql": "UPDATE t SET name = 'z' WHERE id = 2" }))).await.unwrap();
        assert_eq!(p["result"]["isError"], false, "{}", text(&p));
        let e = s.handle_line(&call(6, "execute_write", json!({ "review_token": tok(&p) }))).await.unwrap();
        assert_eq!(e["result"]["isError"], false, "{}", text(&e));
        assert!(text(&e).contains("rollback.sql"), "{}", text(&e));

        let q = s.handle_line(&call(7, "run_query", json!({ "query": "SELECT name FROM t ORDER BY id" }))).await.unwrap();
        assert_eq!(q["result"]["isError"], false, "{}", text(&q));
        assert!(text(&q).contains('z') && text(&q).contains('a'));

        // 高破壞語句：沒開 --allow-destructive 不給代碼。
        let d = s.handle_line(&call(8, "preview_write", json!({ "sql": "DELETE FROM t" }))).await.unwrap();
        assert_eq!(d["result"]["isError"], true);
        assert!(text(&d).contains("--allow-destructive"), "{}", text(&d));
        // 純查詢不該走寫入工具。
        let r = s.handle_line(&call(9, "preview_write", json!({ "sql": "SELECT 1" }))).await.unwrap();
        assert_eq!(r["result"]["isError"], true);

        let ddl = s.handle_line(&call(10, "get_ddl", json!({ "name": "t" }))).await.unwrap();
        assert!(text(&ddl).to_ascii_uppercase().contains("CREATE TABLE"), "{}", text(&ddl));
        let rt = s.handle_line(&call(11, "list_routines", json!({}))).await.unwrap();
        assert!(rt["result"]["isError"] == false || text(&rt).contains("SQLite") || text(&rt).contains("sqlite"), "{}", text(&rt));

        s.shutdown().await;
        // 回滾腳本與報告確實落地
        let has_rollback = walk(&PathBuf::from(&out)).iter().any(|p| p.ends_with("rollback.sql"));
        assert!(has_rollback);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn walk(p: &std::path::Path) -> Vec<String> {
        let mut v = Vec::new();
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    v.extend(walk(&path));
                } else {
                    v.push(path.display().to_string());
                }
            }
        }
        v
    }
}
