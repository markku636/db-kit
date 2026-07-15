//! Kafka 指令的 serde DTO（前端 <-> 後端）。純資料型別，不依賴 rdkafka，
//! 但整個 `db::kafka` 模組於 `kafka` feature 開啟時才編入。

use serde::{Deserialize, Serialize};

/// 叢集資訊（叢集總覽面板）。單次 metadata 計算的靜態快照，不含 watermark / 趨勢。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaClusterInfo {
    pub bootstrap: String,
    pub broker_count: u32,
    pub brokers: Vec<KafkaBroker>,
    /// 本次 metadata 查詢所連 broker 的 id（-1 表未知）。
    pub orig_broker_id: i32,
    /// Kafka cluster.id（broker 未回報時為 None）。
    pub cluster_id: Option<String>,
    /// 控制器 broker id；-1 表未知。
    pub controller_id: i32,
    /// 主題數（排除內部主題；內部主題另計）。
    pub topic_count: u32,
    pub internal_topic_count: u32,
    pub partition_count: u32,
    /// ISR < replicas 的分區數（URP）。
    pub under_replicated: u32,
    /// leader == -1 的分區數。
    pub offline_partitions: u32,
    /// broker 軟體版本無法經 rdkafka 取得，以 librdkafka 版本替代顯示。
    pub librdkafka_version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KafkaBroker {
    pub id: i32,
    pub host: String,
    pub port: i32,
}

/// 主題基本資訊（清單用）。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaTopic {
    pub name: String,
    pub partitions: u32,
    pub replication: u16,
    pub internal: bool,
}

/// 分區資訊（主題設定 / 分區檢視）。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaPartitionInfo {
    pub partition: i32,
    pub leader: i32,
    pub replicas: Vec<i32>,
    pub isr: Vec<i32>,
    pub low: i64,
    pub high: i64,
}

/// 訊息標頭。發佈時作為輸入（Deserialize），消費時作為輸出（Serialize）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KafkaHeader {
    pub key: String,
    pub value: String,
}

/// 一則消費到的訊息（訊息瀏覽器 / live-tail 事件共用）。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaMessage {
    /// live-tail 事件過濾用；一次性 consume 回傳時為空字串。
    pub conn_id: String,
    pub topic: String,
    pub partition: i32,
    pub offset: i64,
    /// epoch millis；-1 表未知。
    pub timestamp: i64,
    pub key: Option<String>,
    pub value: Option<String>,
    pub headers: Vec<KafkaHeader>,
    /// "string" | "json" | "avro" | "protobuf" | "binary"
    pub key_encoding: String,
    pub value_encoding: String,
    /// value 原始位元組長度（供大訊息提示）。
    pub value_bytes: u64,
    /// value 是否因過大而截斷。
    pub truncated: bool,
    /// Confluent wire 格式的 schema id（有解碼時填）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_id: Option<i32>,
}

/// 消費起點（前端 `{type, ...}`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum KafkaStart {
    Beginning,
    End,
    Offset { offset: i64 },
    Timestamp { ts: i64 },
}

/// 一次性消費查詢參數。
#[derive(Debug, Clone, Deserialize)]
pub struct KafkaConsumeQuery {
    /// None = 全部分區。
    #[serde(default)]
    pub partition: Option<i32>,
    pub start: KafkaStart,
    pub limit: u32,
    /// 子字串篩選（比對 key / value）；None = 不篩選。
    #[serde(default)]
    pub filter: Option<String>,
    /// key 反序列化覆寫："string" | "json" | "hex" | "avro"；None / 其他 = 自動。
    #[serde(default)]
    pub key_deser: Option<String>,
    /// value 反序列化覆寫；同上。
    #[serde(default)]
    pub value_deser: Option<String>,
    /// 「搜尋更多」：掃描直到命中 limit 筆或掃到上限。None = 舊行為（取一頁後篩選）。
    #[serde(default)]
    pub scan: Option<KafkaScanOptions>,
}

/// 「搜尋更多」掃描參數。
#[derive(Debug, Clone, Deserialize)]
pub struct KafkaScanOptions {
    /// 最多掃描幾筆（不論是否命中）。
    pub max_scan: u32,
    /// 整體逾時（毫秒）；None = 60000。
    #[serde(default)]
    pub max_wait_ms: Option<u64>,
}

/// 一次性消費結果（含掃描統計）。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaConsumeResult {
    pub messages: Vec<KafkaMessage>,
    /// 已掃描（讀取）的訊息數。
    pub scanned: u64,
    /// 通過篩選的訊息數（= messages.len()）。
    pub matched: u64,
    /// 是否所有分區都掃到末端。
    pub reached_end: bool,
    /// JS 篩選評估失敗而略過的訊息數（B-10 用；此版恆 0）。
    pub eval_errors: u64,
    pub elapsed_ms: u64,
}

/// 發佈訊息請求。
#[derive(Debug, Clone, Deserialize)]
pub struct KafkaProduceRequest {
    pub topic: String,
    #[serde(default)]
    pub partition: Option<i32>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub headers: Vec<KafkaHeader>,
}

/// 發佈結果。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaProduceResult {
    pub partition: i32,
    pub offset: i64,
}

/// DeleteRecords 每分區結果。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaDeleteRecordsResult {
    pub partition: i32,
    /// 刪除後的新 low watermark；-1 表該分區失敗（見 error）。
    pub low_watermark: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 主題設定項（describe configs）。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaConfigEntry {
    pub name: String,
    pub value: String,
    pub source: String,
    pub is_default: bool,
    pub is_sensitive: bool,
}

/// 建立主題規格。
#[derive(Debug, Clone, Deserialize)]
pub struct KafkaCreateTopicSpec {
    pub name: String,
    pub partitions: i32,
    pub replication: i32,
    #[serde(default)]
    pub config: Vec<KafkaHeader>, // 沿用 {key,value} 形狀當設定 k/v
}

/// 消費者群組摘要。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaConsumerGroup {
    pub group_id: String,
    pub state: String,
    pub protocol: String,
    pub members: u32,
}

/// 群組成員。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaGroupMember {
    pub member_id: String,
    pub client_id: String,
    pub host: String,
    /// 指派的 topic-partition（"topic:partition" 字串清單）。
    pub assignments: Vec<String>,
}

/// 群組每分區位移 / Lag。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaGroupOffset {
    pub topic: String,
    pub partition: i32,
    pub current: i64,
    pub log_end: i64,
    pub lag: i64,
}

/// 群組詳細（成員 + Lag）。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaGroupDetail {
    pub group_id: String,
    pub state: String,
    pub members: Vec<KafkaGroupMember>,
    pub offsets: Vec<KafkaGroupOffset>,
}

/// 位移重設目標（重設專用；不污染 consume / tail 共用的 KafkaStart）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum KafkaResetTarget {
    Beginning,
    End,
    Offset { offset: i64 },
    Timestamp { ts: i64 },
    /// 以現值平移 ±N（無已提交位移的分區跳過）。
    Shift { by: i64 },
}

/// 預覽 / 套用共用的每分區位移計畫列。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaOffsetPlanRow {
    pub partition: i32,
    /// -1 = 無已提交位移。
    pub current: i64,
    /// None = 略過（如 Shift 遇 current = -1）。
    pub target: Option<i64>,
    pub low: i64,
    pub high: i64,
}

/// 位移重設請求。
#[derive(Debug, Clone, Deserialize)]
pub struct KafkaOffsetReset {
    pub group: String,
    pub topic: String,
    pub target: KafkaResetTarget,
    /// None = 該主題所有分區。
    #[serde(default)]
    pub partitions: Option<Vec<i32>>,
}

/// Schema Registry 主題（subject）。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaSchemaSubject {
    pub subject: String,
    pub versions: Vec<i32>,
    pub latest: i32,
}

/// 單一 schema。
#[derive(Debug, Clone, Serialize)]
pub struct KafkaSchema {
    pub subject: String,
    pub version: i32,
    pub id: i32,
    /// "AVRO" | "PROTOBUF" | "JSON"
    pub schema_type: String,
    pub schema: String,
}
