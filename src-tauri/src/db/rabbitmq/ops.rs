//! AMQP 操作（走 lapin channel）：非破壞性預覽 peek、發佈 publish（publisher confirm）、
//! 刪除佇列 delete_queue。皆為 `RabbitMqDriver` 的 inherent 方法，供 `rabbitmq_*` 指令呼叫。

use lapin::message::BasicGetMessage;
use lapin::options::{
    BasicGetOptions, BasicPublishOptions, BasicRejectOptions, ConfirmSelectOptions,
    QueueDeleteOptions,
};
use lapin::types::ShortString;
use lapin::BasicProperties;
use serde_json::Value;

use super::dto::{RabbitMessage, RabbitPublishResult};
use super::{query_err, RabbitMqDriver};
use crate::error::{AppError, AppResult};

impl RabbitMqDriver {
    /// 非破壞性預覽：迴圈 basic.get 取回最多 `count` 則，全部取完後再依 `requeue` 一次性
    /// reject 放回（requeue=true 保留於佇列；requeue=false 丟棄 / 轉入 dead-letter）。
    ///
    /// 重要：必須「先全部 get、後統一 reject」——若 get 一則就立刻 requeue，下一次 get 會拿到
    /// 同一則（回到佇列頭），造成重複。取用期間訊息以 unacked 暫留，故能逐則往後前進。
    ///
    /// stream 類型佇列不支援 basic.get（AMQP 需 consume + x-stream-offset）——直接回錯。
    pub async fn peek(
        &self,
        queue: &str,
        count: u32,
        requeue: bool,
    ) -> AppResult<Vec<RabbitMessage>> {
        // 若有 Management，先辨識 stream 佇列以給明確錯誤（mgmt 不可用時略過，交由 basic.get 報錯）。
        if let Some(mgmt) = &self.mgmt {
            if let Ok(q) = mgmt.queue_detail(&self.vhost, queue).await {
                if q.queue_type == "stream" {
                    return Err(AppError::Unsupported(
                        t!("Stream 類型佇列不支援訊息預覽（basic.get）").into(),
                    ));
                }
            }
        }

        let chan = self.chan.lock().await;
        let mut messages: Vec<RabbitMessage> = Vec::new();
        let mut tags: Vec<u64> = Vec::new();
        for _ in 0..count {
            let got = chan
                .basic_get(ShortString::from(queue), BasicGetOptions { no_ack: false })
                .await
                .map_err(query_err)?;
            match got {
                Some(msg) => {
                    tags.push(msg.delivery.delivery_tag);
                    messages.push(message_to_dto(&msg));
                }
                None => break, // 佇列已空。
            }
        }
        // 統一放回 / 丟棄（reject 不支援 multiple，逐則送出）。
        for tag in tags {
            chan.basic_reject(tag, BasicRejectOptions { requeue })
                .await
                .map_err(query_err)?;
        }
        Ok(messages)
    }

    /// 發佈訊息：開 publisher confirm、basic.publish（persistent → delivery_mode=2）、等待 broker confirm。
    pub async fn publish(
        &self,
        exchange: &str,
        routing_key: &str,
        payload: &str,
        persistent: bool,
    ) -> AppResult<RabbitPublishResult> {
        let chan = self.chan.lock().await;
        // 啟用 publisher confirm（重複呼叫 confirm.select 在已啟用的 channel 上為 no-op）。
        chan.confirm_select(ConfirmSelectOptions::default())
            .await
            .map_err(query_err)?;
        let mut props = BasicProperties::default();
        if persistent {
            props = props.with_delivery_mode(2);
        }
        let confirm = chan
            .basic_publish(
                ShortString::from(exchange),
                ShortString::from(routing_key),
                BasicPublishOptions::default(),
                payload.as_bytes(),
                props,
            )
            .await
            .map_err(query_err)?;
        // 等待 broker 的 ack/nack。
        let confirmation = confirm.await.map_err(query_err)?;
        Ok(RabbitPublishResult {
            confirmed: confirmation.is_ack(),
        })
    }

    /// 刪除佇列（含其訊息）。
    pub async fn delete_queue(&self, name: &str) -> AppResult<()> {
        let chan = self.chan.lock().await;
        chan.queue_delete(ShortString::from(name), QueueDeleteOptions::default())
            .await
            .map_err(query_err)?;
        Ok(())
    }
}

/// BasicGetMessage → RabbitMessage（payload 以 UTF-8 lossy 轉字串；properties 序列化成 JSON 字串）。
fn message_to_dto(msg: &BasicGetMessage) -> RabbitMessage {
    let d = &msg.delivery;
    RabbitMessage {
        payload: String::from_utf8_lossy(&d.data).into_owned(),
        properties: properties_to_json(&d.properties),
        routing_key: d.routing_key.as_str().to_string(),
        exchange: d.exchange.as_str().to_string(),
        redelivered: d.redelivered,
        message_count: msg.message_count as u64,
    }
}

/// AMQP BasicProperties → JSON 字串（只輸出有值的欄位；headers 遞迴序列化）。
fn properties_to_json(p: &BasicProperties) -> String {
    let mut m = serde_json::Map::new();
    let mut put_str = |k: &str, v: &Option<ShortString>| {
        if let Some(v) = v {
            m.insert(k.to_string(), Value::String(v.as_str().to_string()));
        }
    };
    put_str("content_type", p.content_type());
    put_str("content_encoding", p.content_encoding());
    put_str("correlation_id", p.correlation_id());
    put_str("reply_to", p.reply_to());
    put_str("expiration", p.expiration());
    put_str("message_id", p.message_id());
    put_str("type", p.kind());
    put_str("user_id", p.user_id());
    put_str("app_id", p.app_id());
    if let Some(v) = p.delivery_mode() {
        m.insert("delivery_mode".to_string(), Value::from(*v));
    }
    if let Some(v) = p.priority() {
        m.insert("priority".to_string(), Value::from(*v));
    }
    if let Some(v) = p.timestamp() {
        m.insert("timestamp".to_string(), Value::from(*v));
    }
    if let Some(h) = p.headers() {
        if let Ok(hv) = serde_json::to_value(h) {
            m.insert("headers".to_string(), hv);
        }
    }
    serde_json::to_string(&Value::Object(m)).unwrap_or_else(|_| "{}".to_string())
}
