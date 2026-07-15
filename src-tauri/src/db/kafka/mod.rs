//! Kafka 驅動（一等公民）。以 rdkafka（librdkafka）接入。
//!
//! 設計：`DatabaseDriver` 只做最小映射讓連線樹/資料格可運作
//! （cluster→database、topic→table、message→row 的合成欄位），
//! Kafka 專屬能力（消費/發佈/Admin/群組 Lag/tail/Schema）走 `commands::kafka_*` 指令，
//! 由 `manager.kafka_driver(id)` downcast `Active::Kafka` 取得本型別的 inherent 方法。
//!
//! 執行緒模型：librdkafka 的 metadata / watermark / offset 查詢是阻塞式 C 呼叫，
//! 一律包在 `tokio::task::spawn_blocking`；AdminClient / FutureProducer 走原生 async。

mod admin;
mod config;
pub(crate) mod consume;
pub mod dto;
#[cfg(feature = "kafka-js")]
pub(crate) mod jsfilter;
mod metrics;
mod produce;
mod proto;
mod schema;
mod tail;

/// 供 live-tail poll 執行緒同步將 rdkafka 訊息轉為 DTO。
pub use consume::message_to_dto_sync;

use std::sync::Arc;
use std::time::Duration;

use rdkafka::admin::AdminClient;
use rdkafka::client::DefaultClientContext;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::producer::FutureProducer;
use rdkafka::ClientConfig;

use dto::{KafkaConsumeQuery, KafkaStart};

use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, PagedData, PoolStatus,
    QueryResult, RowDelete, RowInsert, TableInfo,
};
use crate::error::{AppError, AppResult};

/// 一個已連線的 Kafka 叢集。持有長生命週期的 admin / producer / metadata consumer。
pub struct KafkaDriver {
    /// 共用 ClientConfig 模板；分頁讀 / tail 會 clone 後覆寫 group.id 建立各自 consumer。
    pub(super) base: ClientConfig,
    /// 長生命週期 AdminClient（建/刪主題、改設定）。
    pub(super) admin: AdminClient<DefaultClientContext>,
    /// 長生命週期 producer（發佈訊息）。
    pub(super) producer: FutureProducer,
    /// metadata / watermark 查詢用的長生命週期 consumer（不 subscribe / commit）。
    meta: Arc<BaseConsumer>,
    /// bootstrap.servers 顯示字串（cluster_info / 診斷用）。
    pub(super) bootstrap: String,
    /// 是否在主題清單顯示內部主題（`__consumer_offsets` 等）。
    show_internal: bool,
    /// Schema Registry（若連線有設定 `kafka_sr_url`）。供 Avro 解碼與 schema 檢視。
    pub(super) schema: Option<Arc<schema::SchemaRegistry>>,
}

/// Kafka 連線 / 建立錯誤 → AppError::Connect。
fn conn_err(e: impl std::fmt::Display) -> AppError {
    AppError::Connect(e.to_string())
}

/// Kafka 查詢 / 操作錯誤 → AppError::Query。
fn query_err(e: impl std::fmt::Display) -> AppError {
    AppError::Query(e.to_string())
}

/// 內部主題判斷（`__` 前綴或 `_schemas`）。
fn is_internal_topic(name: &str) -> bool {
    name.starts_with("__") || name == "_schemas"
}

/// 一則 Kafka 訊息投影成資料格的合成欄位（供「資料」分頁 / table_columns）。
fn col(name: &str, ty: &str, key: &str, nullable: bool) -> ColumnInfo {
    ColumnInfo {
        name: name.to_string(),
        data_type: ty.to_string(),
        nullable,
        key: key.to_string(),
        default: None,
        extra: String::new(),
        comment: String::new(),
    }
}

/// 訊息投影欄位定義（partition / offset / timestamp / key / value / headers）。
fn synthetic_message_columns() -> Vec<ColumnInfo> {
    vec![
        col("partition", "int", "", false),
        col("offset", "bigint", "PRI", false),
        col("timestamp", "datetime", "", true),
        col("key", "text", "", true),
        col("value", "text", "", true),
        col("headers", "text", "", true),
    ]
}

#[async_trait::async_trait]
impl DatabaseDriver for KafkaDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let base = config::build_client_config(config);
        let bootstrap = config::bootstrap_servers(config);
        let show_internal = config::show_internal(config);

        let admin: AdminClient<DefaultClientContext> = base.create().map_err(conn_err)?;
        let producer: FutureProducer = base.create().map_err(conn_err)?;
        let meta: BaseConsumer = base.create().map_err(conn_err)?;

        let driver = KafkaDriver {
            base,
            admin,
            producer,
            meta: Arc::new(meta),
            bootstrap,
            show_internal,
            schema: config::schema_registry(config).map(Arc::new),
        };
        // 實際打一次 metadata 確認 bootstrap 可達（librdkafka 是 lazy connect）。
        driver.ping().await?;
        Ok(driver)
    }

    async fn ping(&self) -> AppResult<()> {
        let meta = self.meta.clone();
        tokio::task::spawn_blocking(move || {
            meta.fetch_metadata(None, Duration::from_secs(8))
                .map(|_| ())
                .map_err(conn_err)
        })
        .await
        .map_err(conn_err)?
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        // Kafka 無資料庫層級；回單一合成 cluster 節點供連線樹展開。
        Ok(vec!["cluster".to_string()])
    }

    async fn list_tables(&self, _database: &str) -> AppResult<Vec<TableInfo>> {
        let meta = self.meta.clone();
        let show_internal = self.show_internal;
        tokio::task::spawn_blocking(move || {
            let md = meta
                .fetch_metadata(None, Duration::from_secs(10))
                .map_err(query_err)?;
            let mut topics: Vec<TableInfo> = md
                .topics()
                .iter()
                .map(|t| t.name().to_string())
                .filter(|name| show_internal || !is_internal_topic(name))
                .map(|name| TableInfo {
                    name,
                    kind: "table".to_string(),
                })
                .collect();
            topics.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(topics)
        })
        .await
        .map_err(query_err)?
    }

    async fn table_columns(&self, _database: &str, _table: &str) -> AppResult<Vec<ColumnInfo>> {
        Ok(synthetic_message_columns())
    }

    async fn table_data(
        &self,
        _database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        // 「資料」分頁：讀該主題最近 N 則訊息（GUI 實際走 kafka_consume；此為 trait 完整性）。
        let limit = if query.page_size > 0 { query.page_size } else { 200 };
        let res = self
            .consume_page(
                table,
                &KafkaConsumeQuery {
                    partition: None,
                    start: KafkaStart::End,
                    limit,
                    filter: None,
                    key_deser: None,
                    value_deser: None,
                    scan: None,
                    js_filter: None,
                },
                None,
                None,
            )
            .await?;
        Ok(consume::messages_to_paged(res.messages))
    }

    async fn query(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::Unsupported(
            t!("Kafka 連線不支援 SQL 查詢（請從主題開啟訊息瀏覽器）").into(),
        ))
    }

    async fn update_cell(
        &self,
        _database: &str,
        _table: &str,
        _edit: &CellEdit,
    ) -> AppResult<u64> {
        Err(AppError::Unsupported(
            t!("Kafka 訊息不可就地編輯（請用發佈訊息）").into(),
        ))
    }

    async fn insert_row(&self, _database: &str, _table: &str, _row: &RowInsert) -> AppResult<u64> {
        Err(AppError::Unsupported(
            t!("Kafka 不支援插入列（請用發佈訊息）").into(),
        ))
    }

    async fn delete_row(&self, _database: &str, _table: &str, _del: &RowDelete) -> AppResult<u64> {
        Err(AppError::Unsupported(t!("Kafka 訊息不可刪除").into()))
    }

    fn pool_status(&self) -> PoolStatus {
        PoolStatus {
            size: 1,
            idle: 0,
            in_use: 1,
        }
    }

    async fn close(&self) {
        // rdkafka 客戶端於 Drop 時自行收尾（背景執行緒 + 連線）；無額外連線池要 drain。
    }
}
