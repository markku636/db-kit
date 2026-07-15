//! 訊息 JS 篩選運算式（Conduktor 風），以內嵌 boa 引擎執行。
//!
//! 使用者寫一段回傳 truthy 的 JS 運算式，可用變數：
//! `key`（字串或 null）、`value`（字串或 null）、`json`（value 若為合法 JSON 的解析結果，否則 null）、
//! `headers`（{k:v} 物件）、`partition`、`offset`、`timestamp`、`topic`。
//!
//! 安全性：不引入 boa_runtime（無 fetch/console/fs 等 intrinsics），並設迴圈/遞迴上限。
//! `Context` 內含 Gc/Rc 為 `!Send` —— 本型別只在 `spawn_blocking` closure 或 tail OS 執行緒內
//! 建立與使用，絕不跨 await。

use boa_engine::{Context, JsValue, Source};

use super::dto::KafkaMessage;

/// 已編譯的 JS 篩選（持有 Context + 編譯出的函式）。`!Send`。
pub struct JsFilter {
    ctx: Context,
    func: JsValue,
}

impl JsFilter {
    /// 編譯運算式；語法錯誤回 `Err(訊息)`。
    pub fn compile(expr: &str) -> Result<Self, String> {
        let mut ctx = Context::default();
        ctx.runtime_limits_mut().set_loop_iteration_limit(100_000);
        ctx.runtime_limits_mut().set_recursion_limit(256);
        // 包成函式：解構訊息欄位為區域變數，回傳運算式值。
        let src = format!(
            "(function(__m){{ const {{key,value,json,headers,partition,offset,timestamp,topic}} = __m; return ({expr}); }})"
        );
        let func = ctx
            .eval(Source::from_bytes(src.as_bytes()))
            .map_err(|e| e.to_string())?;
        if func.as_callable().is_none() {
            return Err("運算式未編譯為函式".to_string());
        }
        Ok(Self { ctx, func })
    }

    /// 對一則訊息求值；回傳是否命中。求值錯誤（如存取 undefined 的屬性）回 `Err`。
    pub fn eval(&mut self, m: &KafkaMessage) -> Result<bool, String> {
        let arg_json = message_to_json(m);
        let arg = JsValue::from_json(&arg_json, &mut self.ctx).map_err(|e| e.to_string())?;
        let callable = self
            .func
            .as_callable()
            .cloned()
            .ok_or_else(|| "非可呼叫值".to_string())?;
        let r = callable
            .call(&JsValue::undefined(), &[arg], &mut self.ctx)
            .map_err(|e| e.to_string())?;
        Ok(r.to_boolean())
    }
}

/// KafkaMessage → 供 JS 存取的 JSON 物件（欄位見模組註解）。
fn message_to_json(m: &KafkaMessage) -> serde_json::Value {
    use serde_json::{Map, Value};
    let mut obj = Map::new();
    obj.insert("key".into(), str_or_null(&m.key));
    obj.insert("value".into(), str_or_null(&m.value));
    // json：value 為合法 JSON 時放解析結果，否則 null。
    let json = m
        .value
        .as_deref()
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .unwrap_or(Value::Null);
    obj.insert("json".into(), json);
    let mut hdrs = Map::new();
    for h in &m.headers {
        hdrs.insert(h.key.clone(), Value::String(h.value.clone()));
    }
    obj.insert("headers".into(), Value::Object(hdrs));
    obj.insert("partition".into(), Value::from(m.partition));
    obj.insert("offset".into(), Value::from(m.offset));
    obj.insert("timestamp".into(), Value::from(m.timestamp));
    obj.insert("topic".into(), Value::String(m.topic.clone()));
    Value::Object(obj)
}

fn str_or_null(s: &Option<String>) -> serde_json::Value {
    match s {
        Some(v) => serde_json::Value::String(v.clone()),
        None => serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(value: &str, key: Option<&str>) -> KafkaMessage {
        KafkaMessage {
            conn_id: String::new(),
            topic: "t".into(),
            partition: 1,
            offset: 42,
            timestamp: 1000,
            key: key.map(String::from),
            value: Some(value.into()),
            headers: vec![super::super::dto::KafkaHeader {
                key: "src".into(),
                value: "web".into(),
            }],
            key_encoding: "string".into(),
            value_encoding: "json".into(),
            value_bytes: 0,
            truncated: false,
            schema_id: None,
        }
    }

    #[test]
    fn json_field_predicate() {
        let mut f = JsFilter::compile("json && json.n > 3").unwrap();
        assert!(f.eval(&msg("{\"n\":5}", None)).unwrap());
        assert!(!f.eval(&msg("{\"n\":2}", None)).unwrap());
    }

    #[test]
    fn key_and_headers() {
        let mut f = JsFilter::compile("key === 'a1' && headers.src === 'web'").unwrap();
        assert!(f.eval(&msg("{}", Some("a1"))).unwrap());
        assert!(!f.eval(&msg("{}", Some("b2"))).unwrap());
    }

    #[test]
    fn metadata_fields() {
        let mut f = JsFilter::compile("partition === 1 && offset >= 40 && topic === 't'").unwrap();
        assert!(f.eval(&msg("{}", None)).unwrap());
    }

    #[test]
    fn compile_error_reported() {
        assert!(JsFilter::compile("this is not valid ((").is_err());
    }

    #[test]
    fn eval_error_is_err_not_panic() {
        // 存取 null 的屬性 → 執行期 TypeError → Err（呼叫端計為 eval_error 並略過）。
        let mut f = JsFilter::compile("json.a.b.c === 1").unwrap();
        assert!(f.eval(&msg("not json", None)).is_err());
    }
}
