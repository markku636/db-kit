//! RabbitMQ 指令的 serde DTO（前端 <-> 後端）。純資料型別，不依賴 lapin，
//! 但整個 `db::rabbitmq` 模組於 `rabbitmq` feature 開啟時才編入。
//!
//! 欄位一律 snake_case（前端照此對），增減請於回報標注。

use serde::Serialize;

/// 叢集總覽（Management `/api/overview`）。
#[derive(Debug, Clone, Serialize)]
pub struct RabbitOverview {
    pub rabbitmq_version: String,
    pub erlang_version: String,
    pub node: String,
    pub queue_total: u64,
    pub connection_total: u64,
    pub consumer_total: u64,
    pub messages_ready: u64,
    pub messages_unacked: u64,
    pub publish_rate: f64,
    pub deliver_rate: f64,
}

/// 佇列資訊（Management `/api/queues/{vhost}`；連線樹 / 佇列清單用）。
#[derive(Debug, Clone, Serialize)]
pub struct RabbitQueue {
    pub name: String,
    pub vhost: String,
    /// classic | quorum | stream（mgmt 回的 `type` 欄）。
    pub queue_type: String,
    pub state: String,
    pub messages: u64,
    pub messages_ready: u64,
    pub messages_unacked: u64,
    pub consumers: u64,
    pub durable: bool,
    pub auto_delete: bool,
    pub memory: u64,
}

/// 交換器資訊（Management `/api/exchanges/{vhost}`）。
#[derive(Debug, Clone, Serialize)]
pub struct RabbitExchange {
    pub name: String,
    /// mgmt 的 `type`（direct | fanout | topic | headers | …）。
    pub exchange_type: String,
    pub durable: bool,
    pub auto_delete: bool,
}

/// 一則預覽到的訊息（basic.get + requeue 非破壞性預覽）。
#[derive(Debug, Clone, Serialize)]
pub struct RabbitMessage {
    pub payload: String,
    /// AMQP 屬性序列化成 JSON 字串（content_type / delivery_mode / headers 等）。
    pub properties: String,
    pub routing_key: String,
    pub exchange: String,
    pub redelivered: bool,
    /// basic.get-ok 回報的佇列剩餘訊息數。
    pub message_count: u64,
}

/// 發佈結果（等待 publisher confirm）。
#[derive(Debug, Clone, Serialize)]
pub struct RabbitPublishResult {
    pub confirmed: bool,
}
