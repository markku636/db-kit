//! 發佈訊息（FutureProducer）。

use std::time::Duration;

use rdkafka::message::{Header, OwnedHeaders};
use rdkafka::producer::FutureRecord;

use super::dto::{KafkaBatchResult, KafkaProduceRequest, KafkaProduceResult};
use super::{query_err, KafkaDriver};
use crate::error::{AppError, AppResult};

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

        // value：raw → 原文 bytes；avro → 以 SR schema 編碼為 wire-format。
        let payload: Vec<u8> = if req.value_format.as_deref() == Some("avro") {
            let sr = self.schema.as_deref().ok_or_else(|| {
                AppError::Unsupported(t!("此連線未設定 Schema Registry，無法以 Avro 發佈").into())
            })?;
            let subject = req
                .value_subject
                .clone()
                .unwrap_or_else(|| format!("{}-value", req.topic));
            let json = req.value.clone().unwrap_or_default();
            sr.encode_json(&subject, &json).await?
        } else {
            req.value.clone().unwrap_or_default().into_bytes()
        };

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

    /// 批次發佈（並行 send）。單筆失敗不整體 Err，統計成功 / 失敗數與首個錯誤。
    pub async fn produce_batch(&self, reqs: &[KafkaProduceRequest]) -> AppResult<KafkaBatchResult> {
        let futs = reqs.iter().map(|r| self.produce(r));
        let results = futures::future::join_all(futs).await;
        let mut sent = 0u64;
        let mut failed = 0u64;
        let mut first_error = None;
        for r in results {
            match r {
                Ok(_) => sent += 1,
                Err(e) => {
                    failed += 1;
                    if first_error.is_none() {
                        first_error = Some(e.to_string());
                    }
                }
            }
        }
        Ok(KafkaBatchResult {
            sent,
            failed,
            first_error,
        })
    }
}
