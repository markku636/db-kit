//! 發佈訊息（FutureProducer）。

use std::time::Duration;

use rdkafka::message::{Header, OwnedHeaders};
use rdkafka::producer::FutureRecord;

use super::dto::{KafkaProduceRequest, KafkaProduceResult};
use super::{query_err, KafkaDriver};
use crate::error::AppResult;

impl KafkaDriver {
    /// 發佈一則訊息，回傳落地的 partition / offset。
    pub async fn produce(&self, req: &KafkaProduceRequest) -> AppResult<KafkaProduceResult> {
        let mut headers = OwnedHeaders::new();
        for h in &req.headers {
            headers = headers.insert(Header {
                key: &h.key,
                value: Some(h.value.as_bytes()),
            });
        }
        let key = req.key.clone().unwrap_or_default();
        let payload = req.value.clone().unwrap_or_default();

        let mut record = FutureRecord::to(&req.topic)
            .payload(&payload)
            .key(&key)
            .headers(headers);
        if let Some(p) = req.partition {
            record = record.partition(p);
        }

        match self.producer.send(record, Duration::from_secs(15)).await {
            Ok(d) => Ok(KafkaProduceResult {
                partition: d.partition,
                offset: d.offset,
            }),
            Err((e, _msg)) => Err(query_err(e)),
        }
    }
}
