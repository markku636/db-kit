//! 工具迴圈：送出 → 串流 → 有工具就執行 → 把結果接回去 → 再送，直到模型不再要工具。
//!
//! CLI 後端這一段是 Claude Code / Codex 自己在跑，換成 HTTP 之後得自己來。三個守門：
//! - 回合上限（`MAX_TURNS`）：避免無限往返燒 token
//! - 同名同參數連續三次即中止：小模型很容易卡在同一支工具上重試
//! - 對話歷史上限：HTTP 沒有伺服器端 session，整串歷史每回合都要重送，不修剪會越送越貴

use std::path::Path;
use std::time::Instant;

use super::{stream_turn, tools, LlmConfig, LlmResult, Message, Sink, StopReason, StreamEvent, ToolOutput, ToolSpec, ToolTrace, TurnRequest};
use crate::dbtools::DbToolCtx;

/// 工具結果給前端看的預覽長度（字元）。
const PREVIEW_CHARS: usize = 600;

fn preview(s: &str) -> String {
    let mut p: String = s.chars().take(PREVIEW_CHARS).collect();
    if s.chars().count() > PREVIEW_CHARS {
        p.push('…');
    }
    p
}

/// 一次問答內最多來回幾次（含工具回合）。
const MAX_TURNS: usize = 16;
/// 對話歷史保留的訊息則數上限。
pub const MAX_HISTORY: usize = 40;
/// 對話歷史序列化後的位元組上限（超過從最舊的開始丟）。
pub const MAX_HISTORY_BYTES: usize = 200 * 1024;

/// 助手模式 → 這回合的參數。`generate`（NL→SQL）刻意零工具、單回合、temperature 0；
/// `edit`（編輯器內改寫 SQL）同樣零工具與 temperature 0，但要回傳整段語句，額度放寬到 4096；
/// `review`（審查並執行的執行前審查）是一份含修正 SQL 的完整報告，給到 8192。
fn params_for_mode(mode: &str) -> (u32, Option<f32>, bool) {
    // (max_tokens, temperature, 允許工具)
    match mode {
        "generate" => (1024, Some(0.0), false),
        "edit" => (4096, Some(0.0), false),
        "review" => (8192, Some(0.0), false),
        "agent" => (8192, None, true),
        _ => (8192, None, true),
    }
}

/// 歷史修剪：先砍則數，再砍總量；一律從最舊的丟，且保持「Assistant 的工具呼叫」與
/// 「對應的 ToolResults」成對出現 —— 兩家 API 都會對落單的 tool_result 回 400。
pub fn trim_history(history: &mut Vec<Message>) {
    while history.len() > MAX_HISTORY {
        history.remove(0);
    }
    loop {
        // 開頭若是 ToolResults（它的 Assistant 已被丟掉）就繼續丟。
        if matches!(history.first(), Some(Message::ToolResults(_))) {
            history.remove(0);
            continue;
        }
        let size = serde_json::to_string(&history).map(|s| s.len()).unwrap_or(0);
        if size <= MAX_HISTORY_BYTES || history.len() <= 2 {
            break;
        }
        history.remove(0);
    }
}

/// 跑完一次問答。`history` 進來是這個 session 既有的訊息，回來是加上本回合之後的完整歷史。
/// `db` 為這次對話附帶的連線（有才給資料庫工具）。
#[allow(clippy::too_many_arguments)]
pub async fn run(
    http: &reqwest::Client,
    cfg: &LlmConfig,
    mode: &str,
    workspace: &Path,
    db: Option<&DbToolCtx>,
    history: &mut Vec<Message>,
    prompt: String,
    system: Option<&str>,
    sink: Sink<'_>,
) -> LlmResult<String> {
    if cfg.model.trim().is_empty() {
        return Err(t!("尚未指定模型").to_string());
    }
    let (max_tokens, temperature, tools_on) = params_for_mode(mode);
    let specs: Vec<ToolSpec> = if tools_on { tools::specs(mode, db) } else { Vec::new() };
    let allow_write = mode == "agent";

    history.push(Message::User(prompt));
    trim_history(history);

    let mut answer = String::new();
    let mut last_sig: Option<String> = None;
    let mut repeat = 0usize;

    for turn in 0..MAX_TURNS {
        let req = TurnRequest { system, messages: history, tools: &specs, max_tokens, temperature };
        let out = stream_turn(http, cfg, &req, sink).await?;

        if !out.text.trim().is_empty() {
            answer = out.text.clone();
        }
        history.push(Message::Assistant { text: out.text, tool_calls: out.tool_calls.clone() });

        if out.tool_calls.is_empty() || out.stop != StopReason::ToolUse {
            if let StopReason::Other(reason) = &out.stop {
                if reason == "length" || reason == "max_tokens" {
                    answer.push_str(&format!("\n\n{}", t!("（回應長度達上限，內容可能不完整）")));
                }
            }
            return Ok(answer);
        }

        // 同一支工具、同一組參數連續三次 = 卡住了，停下來比讓它燒 token 好。
        let sig = out
            .tool_calls
            .iter()
            .map(|c| format!("{}:{}", c.name, c.args))
            .collect::<Vec<_>>()
            .join("|");
        if Some(&sig) == last_sig.as_ref() {
            repeat += 1;
            if repeat >= 2 {
                return Err(t!("模型重複呼叫同一支工具且沒有進展，已中止").to_string());
            }
        } else {
            repeat = 0;
            last_sig = Some(sig);
        }

        let mut results = Vec::new();
        for call in &out.tool_calls {
            let started = Instant::now();
            let r = tools::call(workspace, db, &call.name, &call.args, allow_write).await;
            // 每次工具執行都往前端推一筆紀錄：資料庫工具跑了哪條 SQL、拿回幾列，使用者要能稽核。
            let (content, is_error, trace) = match r {
                Ok(o) => {
                    let trace = ToolTrace {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        input_label: o.input_label.clone(),
                        output_preview: preview(&o.text),
                        rows: o.rows,
                        truncated: o.truncated,
                        is_error: false,
                        ms: o.ms,
                    };
                    (o.text, false, trace)
                }
                Err(e) => {
                    let trace = ToolTrace {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        input_label: tool_input_label(&call.name, &call.args),
                        output_preview: preview(&e),
                        rows: None,
                        truncated: false,
                        is_error: true,
                        ms: started.elapsed().as_millis() as u64,
                    };
                    (e, true, trace)
                }
            };
            sink(StreamEvent::ToolDone(trace));
            results.push(ToolOutput { id: call.id.clone(), name: call.name.clone(), content, is_error });
        }
        history.push(Message::ToolResults(results));
        trim_history(history);

        if turn == MAX_TURNS - 1 {
            return Err(tf!("超過 {n} 回合仍未收斂，已中止", n = MAX_TURNS));
        }
    }
    Ok(answer)
}

/// 工具失敗時仍要給前端一個輸入摘要（成功路徑由工具自己回）：查詢類取 query，其餘取 path / table。
fn tool_input_label(name: &str, args: &serde_json::Value) -> Option<String> {
    let pick = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    match name {
        "run_query" | "explain_query" => pick("query").or_else(|| pick("sql")),
        "describe_table" | "sample_rows" => pick("table"),
        "read_file" | "write_file" => pick("path"),
        "search_files" => pick("query"),
        "list_files" => pick("pattern"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ToolCall;
    use serde_json::json;

    #[test]
    fn mode_params() {
        assert_eq!(params_for_mode("generate"), (1024, Some(0.0), false));
        assert_eq!(params_for_mode("edit"), (4096, Some(0.0), false));
        assert_eq!(params_for_mode("review"), (8192, Some(0.0), false));
        let (_, _, tools_on) = params_for_mode("agent");
        assert!(tools_on);
    }

    #[test]
    fn preview_and_labels() {
        let long = "x".repeat(1000);
        assert_eq!(preview(&long).chars().count(), PREVIEW_CHARS + 1);
        assert_eq!(preview("short"), "short");
        assert_eq!(tool_input_label("run_query", &json!({ "query": " select 1 " })).as_deref(), Some("select 1"));
        assert_eq!(tool_input_label("run_query", &json!({ "sql": "select 2" })).as_deref(), Some("select 2"));
        assert_eq!(tool_input_label("describe_table", &json!({ "table": "t" })).as_deref(), Some("t"));
        assert_eq!(tool_input_label("list_files", &json!({})), None);
    }

    #[test]
    fn trim_drops_oldest_and_never_leaves_orphan_tool_results() {
        let mut h: Vec<Message> = Vec::new();
        for i in 0..(MAX_HISTORY + 5) {
            h.push(Message::User(format!("m{i}")));
        }
        trim_history(&mut h);
        assert_eq!(h.len(), MAX_HISTORY);

        let mut h2 = vec![
            Message::ToolResults(vec![ToolOutput { id: "t".into(), name: "n".into(), content: "c".into(), is_error: false }]),
            Message::User("後面這則才是完整的".into()),
        ];
        trim_history(&mut h2);
        assert!(matches!(h2.first(), Some(Message::User(_))));
    }

    #[test]
    fn trim_keeps_pairs_when_under_limits() {
        let mut h = vec![
            Message::User("q".into()),
            Message::Assistant { text: String::new(), tool_calls: vec![ToolCall { id: "1".into(), name: "read_file".into(), args: json!({}) }] },
            Message::ToolResults(vec![ToolOutput { id: "1".into(), name: "read_file".into(), content: "x".into(), is_error: false }]),
        ];
        trim_history(&mut h);
        assert_eq!(h.len(), 3);
    }
}
