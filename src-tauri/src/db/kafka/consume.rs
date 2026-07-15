//! 有界消費（分頁讀近期訊息）與 payload 解碼。live-tail 見 `tail.rs`。
//!
//! 兩段式解碼：阻塞式 poll 只抽出「原始 bytes」（RawMsg），再於 async 段解碼
//! （UTF-8/JSON 同步；Confluent Avro 需向 Schema Registry 取 schema，非同步）。
//!
//! 有界讀策略：臨時 `BaseConsumer`（唯一 group.id、關閉自動 commit、enable.partition.eof），
//! 依起點 assign 各分區位移後 poll 至「收滿 limit / 全分區到底 / idle 逾時」，用完即 drop。

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::error::KafkaError;
use rdkafka::message::{BorrowedHeaders, BorrowedMessage, Headers, Message};
use rdkafka::topic_partition_list::{Offset, TopicPartitionList};
use rdkafka::ClientConfig;

use super::dto::{KafkaConsumeQuery, KafkaHeader, KafkaMessage, KafkaStart};
use super::schema::SchemaRegistry;
use super::{query_err, KafkaDriver};
use crate::db::PagedData;
use crate::error::{AppError, AppResult};

/// value 顯示上限（超過即截斷並標記 truncated），守住 IPC / 前端渲染量。
const MAX_VALUE_BYTES: usize = 256 * 1024;
/// 有界讀的整體逾時（避免無訊息時卡住）。
const CONSUME_MAX_WAIT: Duration = Duration::from_secs(20);

/// 反序列化覆寫（查詢層級）。`Auto` = 現行自動判斷（wire-format 嗅探 + UTF-8/JSON/hex）。
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Deser {
    Auto,
    Str,
    Json,
    Hex,
    Avro,
}

impl Deser {
    pub(super) fn from_opt(s: Option<&str>) -> Self {
        match s {
            Some("string") => Self::Str,
            Some("json") => Self::Json,
            Some("hex") => Self::Hex,
            Some("avro") => Self::Avro,
            _ => Self::Auto,
        }
    }
}

/// 從 BorrowedMessage 抽出的擁有式原始訊息（脫離 consumer 借用，供 async 段解碼）。
pub(super) struct RawMsg {
    pub partition: i32,
    pub offset: i64,
    pub timestamp: i64,
    pub key: Option<Vec<u8>>,
    pub value: Option<Vec<u8>>,
    pub headers: Vec<KafkaHeader>,
}

impl KafkaDriver {
    /// 一次性消費一頁訊息（訊息瀏覽器 / table_data 用）。
    pub async fn consume_page(
        &self,
        topic: &str,
        query: &KafkaConsumeQuery,
    ) -> AppResult<Vec<KafkaMessage>> {
        let base = self.base.clone();
        let topic_s = topic.to_string();
        let partition = query.partition;
        let start = query.start.clone();
        let limit = (query.limit.max(1)) as usize;

        let raws = tokio::task::spawn_blocking(move || {
            consume_page_blocking(&base, &topic_s, partition, start, limit)
        })
        .await
        .map_err(query_err)??;

        // async 解碼（Avro 走 registry）+ 客戶端篩選。
        let sr = self.schema.as_deref();
        let filter = query.filter.as_deref();
        let key_deser = Deser::from_opt(query.key_deser.as_deref());
        let value_deser = Deser::from_opt(query.value_deser.as_deref());
        let mut out = Vec::with_capacity(raws.len());
        for raw in raws {
            let km = raw_to_dto(raw, topic, "", sr, key_deser, value_deser).await;
            if passes_filter(&km, filter) {
                out.push(km);
            }
        }
        out.sort_by(|a, b| {
            a.timestamp
                .cmp(&b.timestamp)
                .then(a.partition.cmp(&b.partition))
                .then(a.offset.cmp(&b.offset))
        });
        Ok(out)
    }

}

/// 阻塞式有界讀（於 spawn_blocking 內執行），只抽出原始 bytes。
fn consume_page_blocking(
    base: &ClientConfig,
    topic: &str,
    partition: Option<i32>,
    start: KafkaStart,
    limit: usize,
) -> AppResult<Vec<RawMsg>> {
    let mut cc = base.clone();
    cc.set("group.id", format!("dbkit-page-{}", uuid::Uuid::new_v4()));
    cc.set("enable.auto.commit", "false");
    cc.set("enable.partition.eof", "true");
    let consumer: BaseConsumer = cc.create().map_err(query_err)?;

    // 決定目標分區。
    let part_ids: Vec<i32> = match partition {
        Some(p) => vec![p],
        None => {
            let md = consumer
                .fetch_metadata(Some(topic), Duration::from_secs(10))
                .map_err(query_err)?;
            let t = md
                .topics()
                .iter()
                .find(|t| t.name() == topic)
                .ok_or_else(|| AppError::Query(format!("找不到主題 {topic}")))?;
            if t.partitions().is_empty() {
                return Ok(vec![]);
            }
            t.partitions().iter().map(|p| p.id()).collect()
        }
    };

    // Timestamp 模式：先解析各分區起始位移。
    let ts_offsets: HashMap<i32, i64> = if let KafkaStart::Timestamp { ts } = &start {
        let mut q = TopicPartitionList::new();
        for &pid in &part_ids {
            q.add_partition_offset(topic, pid, Offset::Offset(*ts))
                .map_err(query_err)?;
        }
        let resolved = consumer
            .offsets_for_times(q, Duration::from_secs(10))
            .map_err(query_err)?;
        resolved
            .elements()
            .iter()
            .filter_map(|e| match e.offset() {
                Offset::Offset(o) => Some((e.partition(), o)),
                _ => None,
            })
            .collect()
    } else {
        HashMap::new()
    };

    // 各分區 watermark + 起始位移，組 assignment。
    let per = ((limit as i64) / (part_ids.len() as i64).max(1)).max(1);
    let mut tpl = TopicPartitionList::new();
    let mut highs: HashMap<i32, i64> = HashMap::new();
    for &pid in &part_ids {
        let (low, high) = consumer
            .fetch_watermarks(topic, pid, Duration::from_secs(10))
            .map_err(query_err)?;
        highs.insert(pid, high);
        let start_off = match &start {
            KafkaStart::Beginning => low,
            KafkaStart::End => (high - per).max(low),
            KafkaStart::Offset { offset } => (*offset).clamp(low, high),
            KafkaStart::Timestamp { .. } => {
                ts_offsets.get(&pid).copied().unwrap_or(high).clamp(low, high)
            }
        };
        tpl.add_partition_offset(topic, pid, Offset::Offset(start_off))
            .map_err(query_err)?;
    }
    consumer.assign(&tpl).map_err(query_err)?;

    // poll 至收滿 / 全分區到底 / 逾時。
    let mut out: Vec<RawMsg> = Vec::with_capacity(limit);
    let mut eof: HashSet<i32> = HashSet::new();
    let started = Instant::now();
    while out.len() < limit && eof.len() < part_ids.len() && started.elapsed() < CONSUME_MAX_WAIT {
        match consumer.poll(Duration::from_millis(400)) {
            Some(Ok(msg)) => {
                if let Some(&high) = highs.get(&msg.partition()) {
                    if msg.offset() + 1 >= high {
                        eof.insert(msg.partition());
                    }
                }
                out.push(raw_from_message(&msg));
            }
            Some(Err(KafkaError::PartitionEOF(pid))) => {
                eof.insert(pid);
            }
            Some(Err(e)) => return Err(query_err(e)),
            None => {}
        }
    }
    Ok(out)
}

/// BorrowedMessage → 擁有式 RawMsg（脫離 consumer 借用）。
pub(super) fn raw_from_message(msg: &BorrowedMessage) -> RawMsg {
    RawMsg {
        partition: msg.partition(),
        offset: msg.offset(),
        timestamp: msg.timestamp().to_millis().unwrap_or(-1),
        key: msg.key().map(|b| b.to_vec()),
        value: msg.payload().map(|b| b.to_vec()),
        headers: extract_headers(msg.headers()),
    }
}

/// RawMsg → KafkaMessage（async：value 為 Confluent 框架時走 registry 解碼）。
pub(super) async fn raw_to_dto(
    raw: RawMsg,
    topic: &str,
    conn_id: &str,
    sr: Option<&SchemaRegistry>,
    key_deser: Deser,
    value_deser: Deser,
) -> KafkaMessage {
    let (key, key_encoding, _kb, _kt, _kid) = if key_deser == Deser::Auto {
        let (k, enc, kb, kt) = decode_payload(raw.key.as_deref());
        (k, enc, kb, kt, None)
    } else {
        decode_with(raw.key.as_deref(), sr, key_deser).await
    };
    let (value, value_encoding, value_bytes, truncated, schema_id) =
        decode_with(raw.value.as_deref(), sr, value_deser).await;
    KafkaMessage {
        conn_id: conn_id.to_string(),
        topic: topic.to_string(),
        partition: raw.partition,
        offset: raw.offset,
        timestamp: raw.timestamp,
        key,
        value,
        headers: raw.headers,
        key_encoding,
        value_encoding,
        value_bytes,
        truncated,
        schema_id,
    }
}

/// 同步版 BorrowedMessage → KafkaMessage（live-tail poll 執行緒用；不走 registry，
/// Confluent 框架值僅標 schema id + hex 預覽，完整 Avro 解碼由一次性 consume 負責）。
pub fn message_to_dto_sync(msg: &BorrowedMessage, topic: &str, conn_id: &str) -> KafkaMessage {
    let raw = raw_from_message(msg);
    let (key, key_encoding, _kb, _kt) = decode_payload(raw.key.as_deref());
    let (value, value_encoding, value_bytes, truncated, schema_id) = decode_value_sync(raw.value.as_deref());
    KafkaMessage {
        conn_id: conn_id.to_string(),
        topic: topic.to_string(),
        partition: raw.partition,
        offset: raw.offset,
        timestamp: raw.timestamp,
        key,
        value,
        headers: raw.headers,
        key_encoding,
        value_encoding,
        value_bytes,
        truncated,
        schema_id,
    }
}

/// 同步解碼 value（無 registry）：Confluent 框架 → 標 schema id + hex；否則 utf8/json/hex。
fn decode_value_sync(bytes: Option<&[u8]>) -> (Option<String>, String, u64, bool, Option<i32>) {
    let Some(b) = bytes else {
        return (None, "string".to_string(), 0, false, None);
    };
    if b.len() >= 5 && b[0] == 0x00 {
        let id = i32::from_be_bytes([b[1], b[2], b[3], b[4]]);
        let (val, _enc, _len, trunc) = decode_payload(Some(&b[5..]));
        return (val, "avro".to_string(), b.len() as u64, trunc, Some(id));
    }
    let (val, enc, len, trunc) = decode_payload(Some(b));
    (val, enc, len, trunc, None)
}

/// 依覆寫模式解碼一段 payload。`Auto` 走現行 `decode_value`；其餘強制指定路徑。
async fn decode_with(
    bytes: Option<&[u8]>,
    sr: Option<&SchemaRegistry>,
    mode: Deser,
) -> (Option<String>, String, u64, bool, Option<i32>) {
    match mode {
        Deser::Auto => decode_value(bytes, sr).await,
        Deser::Avro => {
            let Some(b) = bytes else {
                return (None, "avro".to_string(), 0, false, None);
            };
            if b.len() >= 5 && b[0] == 0x00 {
                let id = i32::from_be_bytes([b[1], b[2], b[3], b[4]]);
                if let Some(sr) = sr {
                    if let Some((json, enc, id)) = sr.decode(b).await {
                        return (Some(json), enc, b.len() as u64, false, Some(id));
                    }
                    // registry 解不動（schema 遺失等）→ payload hex 預覽 + schema id。
                    let (val, _enc, _len, trunc) = decode_payload(Some(&b[5..]));
                    return (val, "avro".to_string(), b.len() as u64, trunc, Some(id));
                }
                return (
                    Some(t!("（此連線未設定 Schema Registry，無法以 Avro 解碼）").to_string()),
                    "avro".to_string(),
                    b.len() as u64,
                    false,
                    Some(id),
                );
            }
            (
                Some(t!("（非 Confluent wire format，無法以 Avro 解碼）").to_string()),
                "avro".to_string(),
                b.len() as u64,
                false,
                None,
            )
        }
        Deser::Str => {
            let Some(b) = bytes else {
                return (None, "string".to_string(), 0, false, None);
            };
            let len = b.len() as u64;
            let (slice, trunc) = if b.len() > MAX_VALUE_BYTES {
                (&b[..MAX_VALUE_BYTES], true)
            } else {
                (b, false)
            };
            (
                Some(String::from_utf8_lossy(slice).to_string()),
                "string".to_string(),
                len,
                trunc,
                None,
            )
        }
        Deser::Json => {
            // 強制 UTF-8 路徑（含 JSON 嗅探；跳過 wire-format 偵測）。非 UTF-8 退 hex。
            let (val, enc, len, trunc) = decode_payload(bytes);
            (val, enc, len, trunc, None)
        }
        Deser::Hex => {
            let Some(b) = bytes else {
                return (None, "binary".to_string(), 0, false, None);
            };
            let len = b.len() as u64;
            let (slice, trunc) = if b.len() > MAX_VALUE_BYTES {
                (&b[..MAX_VALUE_BYTES], true)
            } else {
                (b, false)
            };
            (
                Some(hex_preview(slice)),
                "binary".to_string(),
                len,
                trunc,
                None,
            )
        }
    }
}

/// 解碼 value：Confluent 框架（0x00 + schema id）優先走 registry；否則 UTF-8/JSON/hex。
async fn decode_value(
    bytes: Option<&[u8]>,
    sr: Option<&SchemaRegistry>,
) -> (Option<String>, String, u64, bool, Option<i32>) {
    let Some(b) = bytes else {
        return (None, "string".to_string(), 0, false, None);
    };
    if b.len() >= 5 && b[0] == 0x00 {
        // Confluent wire-format。
        if let Some(sr) = sr {
            if let Some((json, enc, id)) = sr.decode(b).await {
                return (Some(json), enc, b.len() as u64, false, Some(id));
            }
        }
        // 無 registry / 解碼失敗 → 標記 schema id + payload hex 預覽。
        let id = i32::from_be_bytes([b[1], b[2], b[3], b[4]]);
        let (val, _enc, _len, trunc) = decode_payload(Some(&b[5..]));
        return (val, "avro".to_string(), b.len() as u64, trunc, Some(id));
    }
    let (val, enc, len, trunc) = decode_payload(Some(b));
    (val, enc, len, trunc, None)
}

/// 同步解碼一段 bytes：UTF-8 → string/json；非 UTF-8 → hex 預覽（binary）。
fn decode_payload(bytes: Option<&[u8]>) -> (Option<String>, String, u64, bool) {
    let Some(b) = bytes else {
        return (None, "string".to_string(), 0, false);
    };
    let len = b.len() as u64;
    let (slice, truncated) = if b.len() > MAX_VALUE_BYTES {
        (&b[..MAX_VALUE_BYTES], true)
    } else {
        (b, false)
    };
    match std::str::from_utf8(slice) {
        Ok(s) => {
            let enc = if looks_like_json(s) { "json" } else { "string" };
            (Some(s.to_string()), enc.to_string(), len, truncated)
        }
        Err(_) => (Some(hex_preview(slice)), "binary".to_string(), len, truncated),
    }
}

fn looks_like_json(s: &str) -> bool {
    let t = s.trim_start();
    (t.starts_with('{') || t.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(s).is_ok()
}

fn hex_preview(bytes: &[u8]) -> String {
    const MAX: usize = 512;
    let take = bytes.len().min(MAX);
    let mut s = String::with_capacity(take * 3);
    for (i, b) in bytes[..take].iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{b:02x}"));
    }
    if bytes.len() > MAX {
        s.push_str(" …");
    }
    s
}

fn extract_headers(headers: Option<&BorrowedHeaders>) -> Vec<KafkaHeader> {
    let mut out = Vec::new();
    if let Some(hs) = headers {
        for i in 0..hs.count() {
            let h = hs.get(i);
            let value = h
                .value
                .map(|v| String::from_utf8_lossy(v).to_string())
                .unwrap_or_default();
            out.push(KafkaHeader {
                key: h.key.to_string(),
                value,
            });
        }
    }
    out
}

fn passes_filter(m: &KafkaMessage, filter: Option<&str>) -> bool {
    match filter {
        None => true,
        Some("") => true,
        Some(f) => {
            let f = f.to_lowercase();
            m.key
                .as_deref()
                .map(|k| k.to_lowercase().contains(&f))
                .unwrap_or(false)
                || m
                    .value
                    .as_deref()
                    .map(|v| v.to_lowercase().contains(&f))
                    .unwrap_or(false)
        }
    }
}

/// Vec<KafkaMessage> → PagedData（供 DatabaseDriver::table_data 的「資料」分頁）。
pub(super) fn messages_to_paged(msgs: Vec<KafkaMessage>) -> PagedData {
    let columns = ["partition", "offset", "timestamp", "key", "value", "headers"]
        .into_iter()
        .map(String::from)
        .collect();
    let rows = msgs
        .iter()
        .map(|m| {
            vec![
                Some(m.partition.to_string()),
                Some(m.offset.to_string()),
                Some(m.timestamp.to_string()),
                m.key.clone(),
                m.value.clone(),
                Some(headers_to_string(&m.headers)),
            ]
        })
        .collect();
    let total = msgs.len() as u64;
    PagedData {
        columns,
        rows,
        total_rows: total,
        page: 1,
        page_size: total as u32,
        primary_key: vec!["partition".to_string(), "offset".to_string()],
        row_ids: vec![],
    }
}

fn headers_to_string(headers: &[KafkaHeader]) -> String {
    headers
        .iter()
        .map(|h| format!("{}={}", h.key, h.value))
        .collect::<Vec<_>>()
        .join("; ")
}
