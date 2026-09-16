//! `dbk mcp`：以 MCP（Model Context Protocol）stdio 伺服器把 `dbtools` 的唯讀資料庫工具
//! 提供給 AI 用戶端（Claude Code / Codex / 任何支援 MCP 的 agent）。
//!
//! 為何手刻而不用 `rmcp` crate：只需要 5 個方法（initialize / ping / tools/list / tools/call /
//! notifications），wire format 就是「一行一則 JSON-RPC 2.0」；拉一個帶 proc-macro 與 schemars 的
//! 框架進 slim binary 不划算，而且 MSRV 比本 crate 動得快。
//!
//! 行為：
//! - stdout **只**走協定，所有診斷一律 stderr（混進 stdout 會讓用戶端整條連線失效）。
//! - 連線延遲到第一次 `tools/call` 才建立：`initialize` / `tools/list` 不該因為資料庫暫時連不上就失敗。
//!   `tools/list` 只解析連線設定（取種類 / prod 標記），不連線。
//! - 工具失敗回 `isError: true` 的**結果**而非 JSON-RPC 錯誤（MCP 規範：讓模型看到錯誤文字自行修正）。
//! - 逐行、順序處理；不做並行（資料庫工具本來就該一條一條跑）。

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::db::DbKind;
use crate::dbtools::{self, DbToolCtx};
use crate::error::AppResult;
use crate::manager::ConnectionManager;

use super::args::ConnArgs;
use super::resolve;

/// 我們實作的協定版本；用戶端送來的版本若在支援清單內就回它那一版。
pub const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

pub struct McpServer {
    conn: ConnArgs,
    mgr: Arc<ConnectionManager>,
    /// 第一次 tools/call 才連線；連線失敗不快取（下次再試），成功後重用。
    ctx: tokio::sync::Mutex<Option<DbToolCtx>>,
}

impl McpServer {
    pub fn new(conn: ConnArgs) -> McpServer {
        McpServer { conn, mgr: Arc::new(ConnectionManager::new()), ctx: tokio::sync::Mutex::new(None) }
    }

    /// 取得（必要時建立）連線上下文。
    async fn ctx(&self) -> Result<DbToolCtx, String> {
        let mut g = self.ctx.lock().await;
        if let Some(c) = g.as_ref() {
            return Ok(c.clone());
        }
        let cfg = resolve::resolve(&self.conn).await.map_err(|e| e.message())?;
        let id = cfg.id.clone();
        // `-d` 是「要檢視的命名空間」，優先於連線自帶的預設庫（PG 例外已在 resolve 處理）。
        let db = self.conn.database.clone().or_else(|| cfg.database.clone());
        self.mgr.connect(cfg).await.map_err(|e| e.message())?;
        let c = DbToolCtx::from_manager(self.mgr.clone(), &id, db.as_deref())?;
        *g = Some(c.clone());
        Ok(c)
    }

    /// tools/list 需要的種類與 prod 標記：已連線就用現成的，否則只解析設定（不連線）。
    async fn kind_and_prod(&self) -> Result<(DbKind, bool), String> {
        if let Some(c) = self.ctx.lock().await.as_ref() {
            return Ok((c.kind, c.prod));
        }
        let cfg = resolve::resolve(&self.conn).await.map_err(|e| e.message())?;
        let prod = cfg.options.get("prod").map(|v| v == "1").unwrap_or(false);
        Ok((cfg.kind, prod))
    }

    /// 處理一行輸入。回 `None` 表示不需回應（通知 / 回應訊息 / 空行）。
    pub async fn handle_line(&self, line: &str) -> Option<Value> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Some(rpc_err(&Value::Null, -32700, "Parse error")),
        };
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
                    "instructions": t!("這些工具唯讀地存取使用者在 db-kit 選定的資料庫連線。寫查詢前先用 describe_table 確認欄名；查詢一律加 LIMIT；不要猜測不存在的表或欄位。")
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => match self.kind_and_prod().await {
                Ok((kind, prod)) => {
                    let tools: Vec<Value> = dbtools::tool_defs(kind, prod)
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
                if !dbtools::is_db_tool(name) {
                    return Some(rpc_ok(&id, tool_result(&tf!("未知的工具：{name}", name = name), true)));
                }
                // 唯讀守門搬到連線**之前**。`dbtools::call` 裡本來就有一份（真正的防線），
                // 但那要先連上才跑得到：模型送 `DROP TABLE` 過來時會先撥一次連線、再收到一句
                // 「連線失敗」——它學到的是「這裡連不上」而不是「這裡不准寫」，於是繼續重試。
                // 種類從設定就讀得到，不必連線。
                if matches!(name, "run_query" | "explain_query") {
                    if let Some(q) = args.get("query").or_else(|| args.get("sql")).and_then(|v| v.as_str()) {
                        if let Ok((kind, _)) = self.kind_and_prod().await {
                            if let Err(e) = dbtools::ensure_tool_read_only(kind, q) {
                                return Some(rpc_ok(&id, tool_result(&e, true)));
                            }
                        }
                    }
                }
                match self.ctx().await {
                    // e 已經是完整句子（`AppError::message()` 自帶「連線失敗：」等前綴），不再包一層。
                    Err(e) => Ok(tool_result(&e, true)),
                    Ok(ctx) => match dbtools::call(&ctx, name, &args).await {
                        Ok(o) => Ok(tool_result(&o.text, false)),
                        Err(e) => Ok(tool_result(&e, true)),
                    },
                }
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

    /// 收尾：釋放連線池（stdin EOF / 用戶端關閉時）。
    pub async fn shutdown(&self) {
        if let Some(c) = self.ctx.lock().await.take() {
            self.mgr.disconnect(&c.conn_id).await;
        }
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

/// stdio 主迴圈：逐行讀 stdin → 處理 → 一行一則 JSON 回 stdout。stdin 關閉即結束。
pub async fn serve(conn: &ConnArgs) -> AppResult<()> {
    let server = McpServer::new(conn.clone());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::args::Cli;
    use clap::Parser;

    fn server(argv: &[&str]) -> McpServer {
        let mut full = vec!["dbk"];
        full.extend_from_slice(argv);
        full.push("mcp");
        let cli = Cli::try_parse_from(full).expect("parse");
        McpServer::new(cli.conn)
    }

    fn req(id: i64, method: &str, params: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
    }

    #[tokio::test]
    async fn initialize_echoes_supported_version_and_server_info() {
        let s = server(&["--kind", "mysql", "--host", "127.0.0.1", "--port", "1"]);
        let r = s.handle_line(&req(1, "initialize", json!({ "protocolVersion": "2025-03-26", "capabilities": {} }))).await.unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "dbk");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        // 不認得的版本 → 回我們的版本
        let r = s.handle_line(&req(2, "initialize", json!({ "protocolVersion": "1999-01-01" }))).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn tools_list_derives_kind_without_connecting() {
        let s = server(&["--kind", "mysql", "--host", "127.0.0.1", "--port", "1"]);
        let r = s.handle_line(&req(3, "tools/list", json!({}))).await.unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), dbtools::TOOL_NAMES.len());
        let run = tools.iter().find(|t| t["name"] == "run_query").unwrap();
        assert_eq!(run["inputSchema"]["type"], "object");
        assert!(run["inputSchema"]["required"].as_array().unwrap().contains(&json!("query")));
        // Redis 少 explain_query
        let s2 = server(&["--kind", "redis", "--host", "127.0.0.1", "--port", "1"]);
        let r2 = s2.handle_line(&req(4, "tools/list", json!({}))).await.unwrap();
        assert_eq!(r2["result"]["tools"].as_array().unwrap().len(), 5);
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
        let r = s.handle_line(&req(8, "tools/call", json!({ "name": "list_tables", "arguments": {} }))).await.unwrap();
        assert!(r.get("error").is_none());
        assert_eq!(r["result"]["isError"], true);
        // 錯誤訊息只包一層（`AppError::message()` 自帶前綴）。
        let msg = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(msg.contains("找不到連線"), "{msg}");
        assert!(!msg.contains("連線失敗：連線失敗"), "{msg}");
        // 未知工具
        let u = s.handle_line(&req(9, "tools/call", json!({ "name": "drop_everything", "arguments": {} }))).await.unwrap();
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
            let r = s
                .handle_line(&req(20, "tools/call", json!({ "name": tool, "arguments": { "query": q } })))
                .await
                .unwrap();
            assert_eq!(r["result"]["isError"], true, "{q}");
            let msg = r["result"]["content"][0]["text"].as_str().unwrap();
            assert!(!msg.contains("連線失敗") && !msg.contains("找不到連線"), "{q} → {msg}");
        }
        // 唯讀查詢照常往下走到連線（這裡會失敗，但錯的是連線而不是守門）。
        let ok = s
            .handle_line(&req(21, "tools/call", json!({ "name": "run_query", "arguments": { "query": "select 1" } })))
            .await
            .unwrap();
        assert_eq!(ok["result"]["isError"], true);
        assert!(ok["result"]["content"][0]["text"].as_str().unwrap().contains("連線"));
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
}
