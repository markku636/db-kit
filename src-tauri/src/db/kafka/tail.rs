//! live-tail：建立 BaseConsumer 並 assign 至指定起點，交由指令層在專屬執行緒 poll 迴圈 emit 事件。
//!
//! 用 `assign`（非 subscribe/consumer-group）→ 無群組協調需清理；用 `BaseConsumer`（非
//! `StreamConsumer`）→ 沒有背景轉發執行緒，drop 時 `rd_kafka_consumer_close` 快速返回
//! （StreamConsumer 的 drop 在 assign-only 情境會無限阻塞）。預設起點 End（只收新訊息）。

use std::time::Duration;

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::topic_partition_list::{Offset, TopicPartitionList};
use rdkafka::ClientConfig;

use super::dto::KafkaStart;
use super::{query_err, KafkaDriver};
use crate::error::{AppError, AppResult};

impl KafkaDriver {
    /// 建立 live-tail 用 BaseConsumer（assign 到分區/起點）。指令層取得後在專屬執行緒 poll 迴圈 + emit。
    pub async fn build_tail_consumer(
        &self,
        topic: &str,
        partition: Option<i32>,
        start: KafkaStart,
    ) -> AppResult<BaseConsumer> {
        let base = self.base.clone();
        let topic = topic.to_string();
        tokio::task::spawn_blocking(move || build_tail_blocking(&base, &topic, partition, start))
            .await
            .map_err(query_err)?
    }
}

fn build_tail_blocking(
    base: &ClientConfig,
    topic: &str,
    partition: Option<i32>,
    start: KafkaStart,
) -> AppResult<BaseConsumer> {
    let mut cc = base.clone();
    cc.set("group.id", format!("dbkit-tail-{}", uuid::Uuid::new_v4()));
    cc.set("enable.auto.commit", "false");
    let consumer: BaseConsumer = cc.create().map_err(query_err)?;

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
            t.partitions().iter().map(|p| p.id()).collect()
        }
    };

    let mut tpl = TopicPartitionList::new();
    if let KafkaStart::Timestamp { ts } = &start {
        // 先以 offsets_for_times 解析各分區起始位移。
        let mut q = TopicPartitionList::new();
        for &pid in &part_ids {
            q.add_partition_offset(topic, pid, Offset::Offset(*ts))
                .map_err(query_err)?;
        }
        let resolved = consumer
            .offsets_for_times(q, Duration::from_secs(10))
            .map_err(query_err)?;
        for &pid in &part_ids {
            let off = resolved
                .find_partition(topic, pid)
                .and_then(|e| match e.offset() {
                    Offset::Offset(o) => Some(Offset::Offset(o)),
                    _ => None,
                })
                .unwrap_or(Offset::End);
            tpl.add_partition_offset(topic, pid, off).map_err(query_err)?;
        }
    } else {
        for &pid in &part_ids {
            let off = match &start {
                KafkaStart::Beginning => Offset::Beginning,
                KafkaStart::End => Offset::End,
                KafkaStart::Offset { offset } => Offset::Offset(*offset),
                KafkaStart::Timestamp { .. } => Offset::End, // 已於上分支處理
            };
            tpl.add_partition_offset(topic, pid, off).map_err(query_err)?;
        }
    }
    consumer.assign(&tpl).map_err(query_err)?;
    Ok(consumer)
}
