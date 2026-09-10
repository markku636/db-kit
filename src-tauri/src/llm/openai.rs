//! OpenAI-compatible：`POST {base}/chat/completions`。
//!
//! 相容端點的差異幾乎都落在三個欄位上，這裡各給一條降級路徑（一次請求最多重試兩次）：
//! - `max_tokens` vs `max_completion_tokens`（新版 OpenAI 模型只收後者）
//! - `temperature` 不接受非預設值（部分推理模型）
//! - `tools` / `tool_choice` 不支援（地端小模型）→ 由呼叫端決定要不要退成無工具

use serde_json::{json, Value};

use super::{http_error, sse, LlmConfig, LlmResult, Message, Sink, StopReason, StreamEvent, ToolCall, TurnOutput, TurnRequest};

#[derive(Clone, Copy)]
struct Compat {
    /// true = 用 `max_completion_tokens` 而非 `max_tokens`
    max_completion: bool,
    /// false = 整個不送 temperature
    temperature: bool,
}

impl Default for Compat {
    fn default() -> Self {
        Self { max_completion: false, temperature: true }
    }
}

fn build_messages(system: Option<&str>, msgs: &[Message]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
        out.push(json!({ "role": "system", "content": sys }));
    }
    for m in msgs {
        match m {
            Message::User(text) => out.push(json!({ "role": "user", "content": text })),
            Message::Assistant { text, tool_calls } => {
                let mut msg = json!({ "role": "assistant", "content": text });
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = Value::Array(
                        tool_calls
                            .iter()
                            .map(|tc| {
                                json!({
                                    "id": tc.id,
                                    "type": "function",
                                    "function": { "name": tc.name, "arguments": serde_json::to_string(&tc.args).unwrap_or_else(|_| "{}".into()) }
                                })
                            })
                            .collect(),
                    );
                }
                out.push(msg);
            }
            Message::ToolResults(results) => {
                for r in results {
                    out.push(json!({ "role": "tool", "tool_call_id": r.id, "content": r.content }));
                }
            }
        }
    }
    out
}

fn build_body(cfg: &LlmConfig, req: &TurnRequest<'_>, stream: bool, compat: Compat) -> Value {
    let mut body = json!({
        "model": cfg.model,
        "messages": build_messages(req.system, req.messages),
        "stream": stream,
    });
    let tokens_key = if compat.max_completion { "max_completion_tokens" } else { "max_tokens" };
    body[tokens_key] = json!(req.max_tokens);
    if compat.temperature {
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } }))
                .collect(),
        );
    }
    body
}

fn request(http: &reqwest::Client, cfg: &LlmConfig, body: &Value) -> reqwest::RequestBuilder {
    let mut r = http.post(cfg.endpoint()).header("content-type", "application/json").json(body);
    if let Some(k) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
        r = r.header("authorization", format!("Bearer {k}"));
    }
    r
}

/// 由錯誤內容判斷下一步的相容性調整；回 `None` 代表沒得退了。
fn next_compat(body: &str, cur: Compat) -> Option<Compat> {
    let b = body.to_ascii_lowercase();
    if !cur.max_completion && b.contains("max_completion_tokens") {
        return Some(Compat { max_completion: true, ..cur });
    }
    if cur.temperature && b.contains("temperature") {
        return Some(Compat { temperature: false, ..cur });
    }
    None
}

/// 送出請求並在相容性問題上重試（最多兩次）。成功回 Response。
async fn send_with_compat(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>, stream: bool) -> LlmResult<reqwest::Response> {
    let mut compat = Compat::default();
    for _ in 0..3 {
        let body = build_body(cfg, req, stream, compat);
        let resp = request(http, cfg, &body).send().await.map_err(|e| tf!("連線失敗：{e}", e = e))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let text = resp.text().await.unwrap_or_default();
        match next_compat(&text, compat) {
            Some(next) => compat = next,
            None => return Err(http_error(status, &text)),
        }
    }
    Err(t!("端點連續拒絕請求（已嘗試相容性調整）").to_string())
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    args: String,
}

pub async fn stream_turn(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>, sink: Sink<'_>) -> LlmResult<TurnOutput> {
    let resp = send_with_compat(http, cfg, req, true).await?;

    let mut text = String::new();
    let mut calls: std::collections::BTreeMap<u64, PartialCall> = std::collections::BTreeMap::new();
    let mut announced: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
    let mut finish: Option<String> = None;
    let mut err: Option<String> = None;

    sse::read_sse(resp, |data| {
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        if let Some(msg) = v.pointer("/error/message").and_then(|m| m.as_str()) {
            err = Some(msg.to_string());
            return Ok(false);
        }
        let Some(choice) = v.pointer("/choices/0") else { return Ok(true) };
        if let Some(t) = choice.pointer("/delta/content").and_then(|c| c.as_str()) {
            if !t.is_empty() {
                text.push_str(t);
                sink(StreamEvent::Text(t.to_string()));
            }
        }
        if let Some(tcs) = choice.pointer("/delta/tool_calls").and_then(|c| c.as_array()) {
            for tc in tcs {
                let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let slot = calls.entry(idx).or_default();
                if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                    if !id.is_empty() {
                        slot.id = id.to_string();
                    }
                }
                if let Some(n) = tc.pointer("/function/name").and_then(|n| n.as_str()) {
                    if !n.is_empty() {
                        slot.name.push_str(n);
                    }
                }
                if let Some(a) = tc.pointer("/function/arguments").and_then(|a| a.as_str()) {
                    slot.args.push_str(a);
                }
                // 名字湊齊了就先報一次工具事件（面板要即時看到「正在用哪支工具」）。
                if !slot.name.is_empty() && !announced.contains(&idx) {
                    announced.insert(idx);
                    sink(StreamEvent::ToolStart(slot.name.clone()));
                }
            }
        }
        if let Some(f) = choice.get("finish_reason").and_then(|f| f.as_str()) {
            if !f.is_empty() {
                finish = Some(f.to_string());
            }
        }
        Ok(true)
    })
    .await?;

    if let Some(e) = err {
        return Err(e);
    }

    let tool_calls: Vec<ToolCall> = calls
        .into_values()
        .filter(|c| !c.name.is_empty())
        .enumerate()
        .map(|(i, c)| ToolCall {
            id: if c.id.is_empty() { format!("call_{i}") } else { c.id },
            name: c.name,
            args: if c.args.trim().is_empty() { json!({}) } else { serde_json::from_str(&c.args).unwrap_or_else(|_| json!({})) },
        })
        .collect();

    let stop = match finish.as_deref() {
        Some("tool_calls") | Some("function_call") => StopReason::ToolUse,
        Some("stop") | None => {
            if tool_calls.is_empty() {
                StopReason::End
            } else {
                StopReason::ToolUse
            }
        }
        Some(other) => StopReason::Other(other.to_string()),
    };

    Ok(TurnOutput { text, tool_calls, stop })
}

/// 非串流一次性呼叫（結構化輸出用）。
#[allow(dead_code)]
pub async fn complete(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>) -> LlmResult<Value> {
    let resp = send_with_compat(http, cfg, req, false).await?;
    let text = resp.text().await.unwrap_or_default();
    serde_json::from_str(&text).map_err(|e| tf!("回應不是 JSON：{e}", e = e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{LlmKind, ToolOutput, ToolSpec};

    fn cfg() -> LlmConfig {
        LlmConfig { kind: LlmKind::OpenAi, base: "https://x/v1".into(), api_key: Some("k".into()), model: "m".into() }
    }

    #[test]
    fn messages_shape_with_tools() {
        let msgs = vec![
            Message::User("hi".into()),
            Message::Assistant { text: "".into(), tool_calls: vec![ToolCall { id: "c1".into(), name: "read_file".into(), args: json!({"path":"a"}) }] },
            Message::ToolResults(vec![ToolOutput { id: "c1".into(), name: "read_file".into(), content: "ok".into(), is_error: false }]),
        ];
        let built = build_messages(Some("sys"), &msgs);
        assert_eq!(built[0]["role"], "system");
        assert_eq!(built[2]["tool_calls"][0]["function"]["name"], "read_file");
        // arguments 必須是字串化的 JSON，不是物件
        assert!(built[2]["tool_calls"][0]["function"]["arguments"].is_string());
        assert_eq!(built[3]["role"], "tool");
        assert_eq!(built[3]["tool_call_id"], "c1");
    }

    #[test]
    fn compat_downgrade_chain() {
        let c = Compat::default();
        let next = next_compat("Unsupported parameter: 'max_tokens' is not supported, use 'max_completion_tokens'", c).unwrap();
        assert!(next.max_completion);
        let next2 = next_compat("temperature does not support 0.0 with this model", next).unwrap();
        assert!(!next2.temperature);
        assert!(next_compat("some other error", next2).is_none());
    }

    #[test]
    fn body_uses_max_completion_when_downgraded() {
        let msgs = vec![Message::User("hi".into())];
        let tools: Vec<ToolSpec> = vec![];
        let req = TurnRequest { system: None, messages: &msgs, tools: &tools, max_tokens: 64, temperature: Some(0.2) };
        let body = build_body(&cfg(), &req, true, Compat { max_completion: true, temperature: false });
        assert_eq!(body["max_completion_tokens"], 64);
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("temperature").is_none());
    }
}
