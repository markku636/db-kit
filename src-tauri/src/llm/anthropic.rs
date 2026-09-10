//! Anthropic-compatible：`POST {base}/messages`（Messages API）。
//!
//! 相容端點（Kimi 的 `/anthropic`、GLM 的 `/api/anthropic`、自架代理）走的是同一份 wire format，
//! 差別只在 base URL，所以這裡不做任何廠商分支。

use serde_json::{json, Value};

use super::{http_error, sse, LlmConfig, LlmResult, Message, Sink, StopReason, StreamEvent, ToolCall, TurnOutput, TurnRequest};

const API_VERSION: &str = "2023-06-01";

/// 訊息模型 → Anthropic `messages[]`。
fn build_messages(msgs: &[Message]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for m in msgs {
        match m {
            Message::User(text) => out.push(json!({ "role": "user", "content": [{ "type": "text", "text": text }] })),
            Message::Assistant { text, tool_calls } => {
                let mut content: Vec<Value> = Vec::new();
                if !text.trim().is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                for tc in tool_calls {
                    content.push(json!({ "type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.args }));
                }
                // 內容不可為空陣列（API 會 400）；只有工具呼叫而無文字時已由上面補齊。
                if content.is_empty() {
                    content.push(json!({ "type": "text", "text": "" }));
                }
                out.push(json!({ "role": "assistant", "content": content }));
            }
            Message::ToolResults(results) => {
                let content: Vec<Value> = results
                    .iter()
                    .map(|r| json!({ "type": "tool_result", "tool_use_id": r.id, "content": r.content, "is_error": r.is_error }))
                    .collect();
                out.push(json!({ "role": "user", "content": content }));
            }
        }
    }
    out
}

fn build_body(cfg: &LlmConfig, req: &TurnRequest<'_>, stream: bool) -> Value {
    let mut body = json!({
        "model": cfg.model,
        "max_tokens": req.max_tokens,
        "messages": build_messages(req.messages),
        "stream": stream,
    });
    if let Some(sys) = req.system.filter(|s| !s.trim().is_empty()) {
        body["system"] = json!(sys);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema }))
                .collect(),
        );
    }
    body
}

fn request(http: &reqwest::Client, cfg: &LlmConfig, body: &Value) -> reqwest::RequestBuilder {
    let mut r = http
        .post(cfg.endpoint())
        .header("content-type", "application/json")
        .header("anthropic-version", API_VERSION)
        .json(body);
    if let Some(k) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
        r = r.header("x-api-key", k);
        // 部分代理只認 Authorization（例如以 gateway 轉發到官方 API 的自架服務）。
        r = r.header("authorization", format!("Bearer {k}"));
    }
    r
}

/// 串流累積中的一個 content block。
#[derive(Default)]
struct Block {
    kind: String,
    id: String,
    name: String,
    json_buf: String,
}

pub async fn stream_turn(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>, sink: Sink<'_>) -> LlmResult<TurnOutput> {
    let body = build_body(cfg, req, true);
    let resp = request(http, cfg, &body).send().await.map_err(|e| tf!("連線失敗：{e}", e = e))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(http_error(status, &text));
    }

    let mut text = String::new();
    let mut blocks: std::collections::HashMap<u64, Block> = std::collections::HashMap::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut stop = StopReason::End;
    let mut err: Option<String> = None;

    sse::read_sse(resp, |data| {
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Ok(true), // 非 JSON 的心跳行直接略過
        };
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "content_block_start" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let cb = v.get("content_block").cloned().unwrap_or(Value::Null);
                let kind = cb.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                let name = cb.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                if kind == "tool_use" {
                    sink(StreamEvent::ToolStart(name.clone()));
                }
                blocks.insert(
                    idx,
                    Block { kind, id: cb.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(), name, json_buf: String::new() },
                );
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(d) = v.get("delta") else { return Ok(true) };
                match d.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "text_delta" => {
                        if let Some(t) = d.get("text").and_then(|t| t.as_str()) {
                            text.push_str(t);
                            sink(StreamEvent::Text(t.to_string()));
                        }
                    }
                    "input_json_delta" => {
                        if let Some(p) = d.get("partial_json").and_then(|p| p.as_str()) {
                            blocks.entry(idx).or_default().json_buf.push_str(p);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                if let Some(b) = blocks.remove(&idx) {
                    if b.kind == "tool_use" {
                        let args = if b.json_buf.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&b.json_buf).unwrap_or_else(|_| json!({}))
                        };
                        tool_calls.push(ToolCall { id: b.id, name: b.name, args });
                    }
                }
            }
            "message_delta" => {
                if let Some(sr) = v.pointer("/delta/stop_reason").and_then(|s| s.as_str()) {
                    stop = match sr {
                        "tool_use" => StopReason::ToolUse,
                        "end_turn" | "stop_sequence" => StopReason::End,
                        other => StopReason::Other(other.to_string()),
                    };
                }
            }
            "error" => {
                let msg = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("stream error").to_string();
                err = Some(msg);
                return Ok(false);
            }
            "message_stop" => return Ok(false),
            _ => {}
        }
        Ok(true)
    })
    .await?;

    if let Some(e) = err {
        return Err(e);
    }
    // 有工具呼叫但 stop_reason 沒收到（部分相容端點省略 message_delta）→ 當成 tool_use。
    if !tool_calls.is_empty() && stop == StopReason::End {
        stop = StopReason::ToolUse;
    }
    Ok(TurnOutput { text, tool_calls, stop })
}

/// 非串流的一次性呼叫（結構化輸出用；db-kit 目前只有 AI Podcast Cut 那邊會用到，保留以對齊兩案）。
#[allow(dead_code)]
pub async fn complete(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>) -> LlmResult<Value> {
    let body = build_body(cfg, req, false);
    let resp = request(http, cfg, &body).send().await.map_err(|e| tf!("連線失敗：{e}", e = e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| tf!("回應不是 JSON：{e}", e = e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{LlmKind, ToolOutput, ToolSpec};

    fn cfg() -> LlmConfig {
        LlmConfig { kind: LlmKind::Anthropic, base: "https://x/v1".into(), api_key: Some("k".into()), model: "m".into() }
    }

    #[test]
    fn tool_result_round_trip_shape() {
        let msgs = vec![
            Message::User("hi".into()),
            Message::Assistant { text: "".into(), tool_calls: vec![ToolCall { id: "t1".into(), name: "read_file".into(), args: json!({"path":"a"}) }] },
            Message::ToolResults(vec![ToolOutput { id: "t1".into(), name: "read_file".into(), content: "ok".into(), is_error: false }]),
        ];
        let built = build_messages(&msgs);
        assert_eq!(built.len(), 3);
        assert_eq!(built[1]["content"][0]["type"], "tool_use");
        assert_eq!(built[2]["role"], "user");
        assert_eq!(built[2]["content"][0]["tool_use_id"], "t1");
    }

    #[test]
    fn body_includes_tools_and_system() {
        let tools = vec![ToolSpec { name: "read_file".into(), description: "d".into(), schema: json!({"type":"object"}) }];
        let msgs = vec![Message::User("hi".into())];
        let req = TurnRequest { system: Some("persona"), messages: &msgs, tools: &tools, max_tokens: 128, temperature: Some(0.0) };
        let body = build_body(&cfg(), &req, true);
        assert_eq!(body["system"], "persona");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 128);
    }

    #[test]
    fn empty_assistant_content_is_padded() {
        let msgs = vec![Message::Assistant { text: "".into(), tool_calls: vec![] }];
        let built = build_messages(&msgs);
        assert_eq!(built[0]["content"][0]["type"], "text");
    }
}
