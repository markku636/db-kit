//! 發佈訊息（FutureProducer）。

use std::time::Duration;

use rdkafka::message::{Header, OwnedHeaders};
use rdkafka::producer::FutureRecord;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::dto::{KafkaBatchResult, KafkaCsvProduceOptions, KafkaProduceRequest, KafkaProduceResult};
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

    /// CSV 批次發佈：讀檔 → 解析 → 逐列 produce（分批並行），每批回報進度並檢查取消旗標。
    /// value_column=None 時整列（含標頭名）轉 JSON 物件當 value。
    pub async fn produce_csv(
        &self,
        path: &str,
        opts: &KafkaCsvProduceOptions,
        cancel: Arc<AtomicBool>,
        progress: impl Fn(u64, u64, u64),
    ) -> AppResult<KafkaBatchResult> {
        let content = tokio::fs::read_to_string(path)
            .await
            .map_err(|e| AppError::Query(crate::tf!("讀取檔案失敗：{e}", e = e)))?;
        let delim = opts
            .delimiter
            .as_deref()
            .and_then(|d| d.chars().next())
            .unwrap_or(',');
        let rows = crate::import::parse_csv(&content, delim);
        if rows.is_empty() {
            return Ok(KafkaBatchResult { sent: 0, failed: 0, first_error: None });
        }

        // 決定標頭與資料列範圍。
        let (header, data): (Vec<String>, &[Vec<String>]) = if opts.has_header {
            (rows[0].clone(), &rows[1..])
        } else {
            (Vec::new(), &rows[..])
        };
        let col_idx = |name: &Option<String>| -> Option<usize> {
            let n = name.as_deref()?;
            // 先當標頭名，再退回索引字串。
            header
                .iter()
                .position(|h| h == n)
                .or_else(|| n.parse::<usize>().ok())
        };
        let key_i = col_idx(&opts.key_column);
        let value_i = col_idx(&opts.value_column);

        let total = data.len() as u64;
        let mut sent = 0u64;
        let mut failed = 0u64;
        let mut first_error: Option<String> = None;

        const CHUNK: usize = 200;
        for chunk in data.chunks(CHUNK) {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let reqs: Vec<KafkaProduceRequest> = chunk
                .iter()
                .map(|row| {
                    let key = key_i.and_then(|i| row.get(i)).cloned();
                    let value = match value_i {
                        Some(i) => row.get(i).cloned(),
                        None if opts.has_header => Some(row_to_json(&header, row)),
                        None => Some(row.join(delim.to_string().as_str())),
                    };
                    KafkaProduceRequest {
                        topic: opts.topic.clone(),
                        partition: opts.partition,
                        key,
                        value,
                        headers: vec![],
                        value_format: None,
                        value_subject: None,
                    }
                })
                .collect();
            let r = self.produce_batch(&reqs).await?;
            sent += r.sent;
            failed += r.failed;
            if first_error.is_none() {
                first_error = r.first_error;
            }
            progress(sent, failed, total);
        }
        Ok(KafkaBatchResult { sent, failed, first_error })
    }
}

/// 一列 CSV → JSON 物件字串（key = 標頭名）。缺標頭名的欄以 "colN" 命名。
fn row_to_json(header: &[String], row: &[String]) -> String {
    let mut map = serde_json::Map::new();
    for (i, cell) in row.iter().enumerate() {
        let name = header
            .get(i)
            .cloned()
            .unwrap_or_else(|| format!("col{i}"));
        map.insert(name, serde_json::Value::String(cell.clone()));
    }
    serde_json::Value::Object(map).to_string()
}
