//! `dbk mcp --http <addr>`：MCP Streamable HTTP 傳輸（規範 2025-03-26 起）。
//!
//! 與 stdio 一樣手刻、不拉 web 框架：只需要一個端點 `/mcp`——
//! - `POST`：本文是一則（或一批）JSON-RPC。有回應就回 200 `application/json`（用戶端只收 SSE 時包成單一 SSE 事件）；
//!   通知 / 回應訊息回 202、無本文。`initialize` 的回應帶 `Mcp-Session-Id`。
//! - `GET`：405（不提供伺服器主動推播的 SSE 串流；規範允許）。
//! - `DELETE`：結束 session。
//!
//! 安全：
//! - 預設只聽本機；聽非本機位址時**必須**設權杖（`--token` / `DBKIT_MCP_TOKEN`），否則拒絕啟動。
//! - 有權杖時每個請求都要 `Authorization: Bearer <token>`（常數時間比對）。
//! - 帶 `Origin` 的請求只接受本機來源（擋 DNS rebinding：惡意網頁把網域解析到 127.0.0.1 再打進來）；
//!   不回任何 CORS 標頭，瀏覽器跨來源呼叫一律被擋。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::error::{AppError, AppResult};

use super::McpServer;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// 連線閒置多久就關（keep-alive 的上限）。
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_SESSIONS: usize = 1024;

#[derive(Clone)]
struct Shared {
    server: Arc<McpServer>,
    token: Option<String>,
    sessions: Arc<Mutex<HashSet<String>>>,
}

/// `8765` / `:8765` → `127.0.0.1:8765`；其餘原樣（`0.0.0.0:8765`、`localhost:8765`、`[::1]:8765`）。
pub fn normalize_addr(addr: &str) -> String {
    let a = addr.trim();
    if a.chars().all(|c| c.is_ascii_digit()) && !a.is_empty() {
        return format!("127.0.0.1:{a}");
    }
    if let Some(port) = a.strip_prefix(':') {
        return format!("127.0.0.1:{port}");
    }
    a.to_string()
}

/// 綁定並開始服務，直到 Ctrl+C。
pub async fn serve(server: Arc<McpServer>, addr: &str, token: Option<String>) -> AppResult<()> {
    let addr = normalize_addr(addr);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| AppError::Connect(tf!("無法監聽 {addr}：{e}", addr = addr, e = e.to_string())))?;
    let local = listener.local_addr().map_err(|e| AppError::Connect(e.to_string()))?;
    let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if !local.ip().is_loopback() && token.is_none() {
        return Err(AppError::NeedsConfirm(
            t!("監聽非本機位址時必須設定權杖（--token 或環境變數 DBKIT_MCP_TOKEN），否則同網段任何人都能存取資料庫").into(),
        ));
    }
    if token.as_deref().is_some_and(|t| t.len() < 16) {
        eprintln!("warning: {}", t!("權杖太短（少於 16 字元），建議用更長的隨機字串"));
    }
    eprintln!(
        "[dbk mcp] {}",
        tf!(
            "MCP 伺服器已啟動（HTTP）：http://{addr}/mcp　權杖：{auth}　按 Ctrl+C 結束",
            addr = local,
            auth = if token.is_some() { t!("已啟用") } else { t!("未設定（僅本機）") }
        )
    );
    let shared = Shared { server: server.clone(), token, sessions: Arc::new(Mutex::new(HashSet::new())) };
    tokio::select! {
        _ = accept_loop(listener, shared) => {}
        _ = tokio::signal::ctrl_c() => {
            eprintln!("[dbk mcp] {}", t!("收到中斷訊號，正在關閉…"));
        }
    }
    server.shutdown().await;
    Ok(())
}

async fn accept_loop(listener: TcpListener, shared: Shared) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let s = shared.clone();
        tokio::spawn(async move {
            let _ = handle_conn(stream, s).await;
        });
    }
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    fn wants_close(&self) -> bool {
        self.header("connection").is_some_and(|v| v.eq_ignore_ascii_case("close"))
    }
}

struct Response {
    status: u16,
    content_type: Option<&'static str>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn empty(status: u16) -> Response {
        Response { status, content_type: None, headers: Vec::new(), body: Vec::new() }
    }
    fn text(status: u16, msg: &str) -> Response {
        Response { status, content_type: Some("text/plain; charset=utf-8"), headers: Vec::new(), body: msg.as_bytes().to_vec() }
    }
    fn json(v: &Value) -> Response {
        Response { status: 200, content_type: Some("application/json"), headers: Vec::new(), body: v.to_string().into_bytes() }
    }
    fn sse(v: &Value) -> Response {
        let body = format!("event: message\ndata: {v}\n\n").into_bytes();
        Response { status: 200, content_type: Some("text/event-stream"), headers: Vec::new(), body }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        _ => "Error",
    }
}

async fn handle_conn(mut stream: TcpStream, shared: Shared) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let req = match tokio::time::timeout(IDLE_TIMEOUT, read_request(&mut stream, &mut buf)).await {
            Ok(Ok(Some(r))) => r,
            Ok(Ok(None)) | Err(_) => return Ok(()),
            Ok(Err(status)) => {
                write_response(&mut stream, Response::text(status, reason(status)), true).await?;
                return Ok(());
            }
        };
        let close = req.wants_close();
        let resp = route(&req, &shared).await;
        write_response(&mut stream, resp, close).await?;
        if close {
            return Ok(());
        }
    }
}

fn find_header_end(b: &[u8]) -> Option<usize> {
    b.windows(4).position(|w| w == b"\r\n\r\n")
}

/// 讀一個請求。`Ok(None)` = 對方關閉連線；`Err(status)` = 請求格式不對（回該狀態碼後關閉）。
async fn read_request(stream: &mut TcpStream, buf: &mut Vec<u8>) -> Result<Option<Request>, u16> {
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(i) = find_header_end(buf) {
            break i;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err(400);
        }
        let n = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    buf.drain(..head_end + 4);
    let mut lines = head.split("\r\n");
    let start = lines.next().unwrap_or("");
    let mut parts = start.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let target = parts.next().unwrap_or("/");
    if method.is_empty() {
        return Err(400);
    }
    let path = target.split('?').next().unwrap_or("/").to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    let get = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    let chunked = get("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        read_chunked(stream, buf).await?
    } else {
        let len: usize = match get("content-length") {
            Some(v) => v.parse().map_err(|_| 400u16)?,
            None => 0,
        };
        if len > MAX_BODY_BYTES {
            return Err(413);
        }
        while buf.len() < len {
            let n = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
            if n == 0 {
                return Err(400);
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        buf.drain(..len).collect()
    };
    Ok(Some(Request { method, path, headers, body }))
}

/// 從緩衝（不足時從 socket 補）取一行，不含 CRLF。
async fn read_line(stream: &mut TcpStream, buf: &mut Vec<u8>) -> Result<String, u16> {
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(i) = buf.windows(2).position(|w| w == b"\r\n") {
            let line = String::from_utf8_lossy(&buf[..i]).to_string();
            buf.drain(..i + 2);
            return Ok(line);
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err(400);
        }
        let n = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if n == 0 {
            return Err(400);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// 解 `Transfer-Encoding: chunked`（有些 HTTP 用戶端串流送本文時用）。
async fn read_chunked(stream: &mut TcpStream, buf: &mut Vec<u8>) -> Result<Vec<u8>, u16> {
    let mut body = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let line = read_line(stream, buf).await?;
        let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16).map_err(|_| 400u16)?;
        if size == 0 {
            // 最後一塊之後是選用的 trailer，讀到空行為止。
            while !read_line(stream, buf).await?.is_empty() {}
            return Ok(body);
        }
        if body.len() + size > MAX_BODY_BYTES {
            return Err(413);
        }
        // 資料 + 結尾 CRLF
        while buf.len() < size + 2 {
            let n = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
            if n == 0 {
                return Err(400);
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        body.extend_from_slice(&buf[..size]);
        buf.drain(..size + 2);
    }
}

async fn write_response(stream: &mut TcpStream, r: Response, close: bool) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", r.status, reason(r.status));
    if let Some(ct) = r.content_type {
        head.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    for (k, v) in &r.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\nCache-Control: no-store\r\n", r.body.len()));
    head.push_str(if close { "Connection: close\r\n\r\n" } else { "Connection: keep-alive\r\n\r\n" });
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&r.body).await?;
    stream.flush().await
}

/// 常數時間比較（權杖）。
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 只接受本機來源的 `Origin`（沒帶 Origin 的非瀏覽器用戶端照常放行）。
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(o) = origin.map(str::trim).filter(|s| !s.is_empty()) else {
        return true;
    };
    if o == "null" {
        return false;
    }
    let rest = o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")).unwrap_or("");
    let host = if let Some(r) = rest.strip_prefix('[') {
        r.split(']').next().unwrap_or("")
    } else {
        rest.split([':', '/']).next().unwrap_or("")
    };
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

fn is_initialize(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.iter().any(is_initialize),
        _ => v.get("method").and_then(|m| m.as_str()) == Some("initialize"),
    }
}

async fn route(req: &Request, sh: &Shared) -> Response {
    if req.path != "/mcp" && req.path != "/" {
        return Response::text(404, "Not Found");
    }
    if !origin_allowed(req.header("origin")) {
        return Response::text(403, "Forbidden origin");
    }
    if let Some(tok) = &sh.token {
        let ok = req
            .header("authorization")
            .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
            .is_some_and(|got| ct_eq(got.trim().as_bytes(), tok.as_bytes()));
        if !ok {
            let mut r = Response::text(401, "Unauthorized");
            r.headers.push(("WWW-Authenticate".into(), "Bearer".into()));
            return r;
        }
    }
    let session = req.header("mcp-session-id").map(str::to_string);
    match req.method.as_str() {
        "POST" => {}
        "DELETE" => {
            if let Some(s) = session {
                sh.sessions.lock().remove(&s);
            }
            return Response::empty(204);
        }
        _ => {
            let mut r = Response::text(405, "Method Not Allowed");
            r.headers.push(("Allow".into(), "POST, DELETE".into()));
            return r;
        }
    }
    let v: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return Response::json(&super::rpc_err(&Value::Null, -32700, "Parse error")),
    };
    let init = is_initialize(&v);
    // 不認得的 session（伺服器重啟過、或已 DELETE）→ 404，規範要求用戶端重新 initialize。
    if !init {
        if let Some(s) = &session {
            if !sh.sessions.lock().contains(s) {
                return Response::text(404, "Unknown session");
            }
        }
    }
    let out = sh.server.handle_value(v).await;
    let mut resp = match out {
        None => Response::empty(202),
        Some(v) => {
            let accept = req.header("accept").unwrap_or("").to_ascii_lowercase();
            let json_ok = accept.is_empty() || accept.contains("application/json") || accept.contains("*/*");
            if !json_ok && accept.contains("text/event-stream") {
                Response::sse(&v)
            } else {
                Response::json(&v)
            }
        }
    };
    if init {
        let id = uuid::Uuid::new_v4().simple().to_string();
        {
            let mut g = sh.sessions.lock();
            if g.len() >= MAX_SESSIONS {
                if let Some(k) = g.iter().next().cloned() {
                    g.remove(&k);
                }
            }
            g.insert(id.clone());
        }
        resp.headers.push(("Mcp-Session-Id".into(), id));
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn addr_normalization() {
        assert_eq!(normalize_addr("8765"), "127.0.0.1:8765");
        assert_eq!(normalize_addr(":8765"), "127.0.0.1:8765");
        assert_eq!(normalize_addr("0.0.0.0:1"), "0.0.0.0:1");
    }

    #[test]
    fn origin_checks() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://localhost:3000")));
        assert!(origin_allowed(Some("http://127.0.0.1")));
        assert!(origin_allowed(Some("http://[::1]:8080")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("http://localhost.evil.example")));
        assert!(!origin_allowed(Some("null")));
    }

    #[test]
    fn constant_time_eq() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }

    async fn start(token: Option<&str>) -> std::net::SocketAddr {
        let server = Arc::new(super::super::tests::server(&["--kind", "mysql", "--host", "127.0.0.1", "--port", "1"]));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let shared = Shared { server, token: token.map(String::from), sessions: Arc::new(Mutex::new(HashSet::new())) };
        tokio::spawn(accept_loop(listener, shared));
        addr
    }

    /// 送一個原始 HTTP 請求，回 (狀態碼, 標頭原文, 本文)。
    async fn send(addr: std::net::SocketAddr, raw: String) -> (u16, String, String) {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).await.unwrap();
        let text = String::from_utf8_lossy(&out).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        (status, head.to_string(), body.to_string())
    }

    fn post(body: &Value, extra: &str) -> String {
        let b = body.to_string();
        format!(
            "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\n{extra}Content-Length: {}\r\n\r\n{b}",
            b.len()
        )
    }

    #[tokio::test]
    async fn initialize_list_and_notifications_over_http() {
        let addr = start(None).await;
        let (st, head, body) = send(addr, post(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}), "")).await;
        assert_eq!(st, 200, "{head}");
        assert!(head.to_ascii_lowercase().contains("mcp-session-id:"), "{head}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], "dbk");
        let sid = head
            .lines()
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("mcp-session-id")).map(|(_, v)| v.trim().to_string()))
            .unwrap();

        let (st, _, body) = send(addr, post(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), &format!("Mcp-Session-Id: {sid}\r\n"))).await;
        assert_eq!(st, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert!(v["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "run_query"));

        let (st, _, body) = send(addr, post(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}), "")).await;
        assert_eq!(st, 202);
        assert!(body.is_empty());

        // 不認得的 session → 404
        let (st, _, _) = send(addr, post(&json!({"jsonrpc":"2.0","id":3,"method":"ping"}), "Mcp-Session-Id: nope\r\n")).await;
        assert_eq!(st, 404);
        // GET → 405
        let (st, _, _) = send(addr, "GET /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".into()).await;
        assert_eq!(st, 405);
        // 壞 JSON → JSON-RPC parse error
        let (st, _, body) = send(addr, "POST /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 4\r\n\r\n{bad".into()).await;
        assert_eq!(st, 200);
        assert!(body.contains("-32700"));
    }

    #[tokio::test]
    async fn token_origin_and_sse_and_chunked() {
        let addr = start(Some("s3cret-token-0123456789")).await;
        let ping = json!({"jsonrpc":"2.0","id":1,"method":"ping"});
        let (st, head, _) = send(addr, post(&ping, "")).await;
        assert_eq!(st, 401);
        assert!(head.contains("WWW-Authenticate"));
        let (st, _, _) = send(addr, post(&ping, "Authorization: Bearer wrong\r\n")).await;
        assert_eq!(st, 401);
        let auth = "Authorization: Bearer s3cret-token-0123456789\r\n";
        let (st, _, _) = send(addr, post(&ping, auth)).await;
        assert_eq!(st, 200);
        let (st, _, _) = send(addr, post(&ping, &format!("{auth}Origin: https://evil.example\r\n"))).await;
        assert_eq!(st, 403);
        // 只收 SSE 的用戶端 → 單一 SSE 事件
        let b = ping.to_string();
        let raw = format!("POST /mcp HTTP/1.1\r\nHost: x\r\n{auth}Accept: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{b}", b.len());
        let (st, head, body) = send(addr, raw).await;
        assert_eq!(st, 200);
        assert!(head.contains("text/event-stream"));
        assert!(body.starts_with("event: message\ndata: {"), "{body}");
        // chunked 本文
        let (a, c) = b.split_at(5);
        let raw = format!(
            "POST /mcp HTTP/1.1\r\nHost: x\r\n{auth}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{a}\r\n{:x}\r\n{c}\r\n0\r\n\r\n",
            a.len(),
            c.len()
        );
        let (st, _, body) = send(addr, raw).await;
        assert_eq!(st, 200, "{body}");
        assert!(body.contains("\"result\""));
    }

    #[tokio::test]
    async fn keep_alive_serves_multiple_requests() {
        let addr = start(None).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        for id in 1..=2 {
            let b = json!({"jsonrpc":"2.0","id":id,"method":"ping"}).to_string();
            let raw = format!("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{b}", b.len());
            s.write_all(raw.as_bytes()).await.unwrap();
            let mut got = Vec::new();
            let mut tmp = [0u8; 1024];
            while find_header_end(&got).is_none() || !String::from_utf8_lossy(&got).contains(&format!("\"id\":{id}")) {
                let n = s.read(&mut tmp).await.unwrap();
                assert!(n > 0, "連線被提早關閉");
                got.extend_from_slice(&tmp[..n]);
            }
        }
    }

    #[tokio::test]
    async fn refuses_public_bind_without_token() {
        let server = Arc::new(super::super::tests::server(&["--kind", "mysql"]));
        let r = serve(server, "0.0.0.0:0", None).await;
        assert!(r.is_err());
    }
}
