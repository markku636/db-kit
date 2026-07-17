//! RabbitMQ 驅動（一等公民）。雙軌：lapin（AMQP 0-9-1）負責連線 / peek / publish / 刪佇列，
//! Management REST（reqwest，見 mgmt.rs）負責總覽 / 佇列 / exchange 清單等營運資訊。
//!
//! 設計：`DatabaseDriver` 只做最小映射讓連線樹可運作（vhost→database、queue→table），
//! RabbitMQ 專屬能力（peek / publish / purge / delete）走 `commands::rabbitmq_*` 指令，
//! 由 `manager.rabbitmq_driver(id)` downcast `Active::RabbitMq` 取得本型別的 inherent 方法（見 ops.rs）。

mod config;
pub mod dto;
mod mgmt;
mod ops;

use std::sync::Arc;

use lapin::types::ShortString;
use lapin::{Connection, ConnectionProperties};
use tokio::sync::Mutex;

use mgmt::MgmtClient;

use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, PagedData, PoolStatus,
    QueryResult, RowDelete, RowInsert, TableInfo,
};
use crate::error::{AppError, AppResult};

/// 一個已連線的 RabbitMQ。持有長生命週期 AMQP connection + 一條共用 channel（Mutex 序列化操作），
/// 以及選用的 Management REST 用戶端（清單 / 總覽走它）。
pub struct RabbitMqDriver {
    /// 長生命週期 AMQP 連線（close 時收尾）。
    conn: Connection,
    /// 共用 channel：peek / publish / delete 皆序列化在此（basic_get + reject 的順序性需要）。
    pub(super) chan: Mutex<lapin::Channel>,
    /// Management REST 用戶端（清單 / 總覽 / purge）。construction 不連線，呼叫時才可能失敗。
    pub(super) mgmt: Option<Arc<MgmtClient>>,
    /// 目標 vhost（list_databases 回它；mgmt 路徑段用它）。
    pub(super) vhost: String,
}

/// RabbitMQ 連線 / 建立錯誤 → AppError::Connect。
fn conn_err(e: impl std::fmt::Display) -> AppError {
    AppError::Connect(e.to_string())
}

/// RabbitMQ 查詢 / 操作錯誤 → AppError::Query。
fn query_err(e: impl std::fmt::Display) -> AppError {
    AppError::Query(e.to_string())
}

impl RabbitMqDriver {
    /// 取 Management 用戶端；未設定 / 不可達時回 Unsupported（提示需要 15672）。
    fn mgmt(&self) -> AppResult<&MgmtClient> {
        self.mgmt.as_deref().ok_or_else(|| {
            AppError::Unsupported(t!("需要 Management API（請於連線設定填 URL 或確認 15672 可達）").into())
        })
    }

    /// 叢集總覽（Management）。
    pub async fn overview(&self) -> AppResult<dto::RabbitOverview> {
        self.mgmt()?.overview().await
    }

    /// 目標 vhost 的佇列清單（Management）。
    pub async fn queues(&self) -> AppResult<Vec<dto::RabbitQueue>> {
        self.mgmt()?.queues(&self.vhost).await
    }

    /// 目標 vhost 的交換器清單（Management）。
    pub async fn exchanges(&self) -> AppResult<Vec<dto::RabbitExchange>> {
        self.mgmt()?.exchanges(&self.vhost).await
    }

    /// 單一佇列詳情（Management）。
    pub async fn queue_detail(&self, name: &str) -> AppResult<dto::RabbitQueue> {
        self.mgmt()?.queue_detail(&self.vhost, name).await
    }

    /// 清空佇列（Management DELETE contents）。
    pub async fn purge(&self, name: &str) -> AppResult<()> {
        self.mgmt()?.purge(&self.vhost, name).await
    }
}

/// 佇列投影成資料格的合成欄位（供 table_columns；GUI 實際走專屬佇列瀏覽面板）。
fn synthetic_queue_columns() -> Vec<ColumnInfo> {
    let col = |name: &str, ty: &str| ColumnInfo {
        name: name.to_string(),
        data_type: ty.to_string(),
        nullable: false,
        key: String::new(),
        default: None,
        extra: String::new(),
        comment: String::new(),
    };
    vec![
        col("name", "text"),
        col("type", "text"),
        col("state", "text"),
        col("messages", "bigint"),
        col("messages_ready", "bigint"),
        col("messages_unacked", "bigint"),
        col("consumers", "bigint"),
    ]
}

#[async_trait::async_trait]
impl DatabaseDriver for RabbitMqDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let uri = config::amqp_uri(config);
        let vhost = config::vhost(config);
        // AMQP 握手（tokio feature 讓 lapin 走 tokio reactor / executor）。
        let conn = Connection::connect(&uri, ConnectionProperties::default())
            .await
            .map_err(conn_err)?;
        let chan = conn.create_channel().await.map_err(conn_err)?;
        // Management 用戶端（帳密沿用 AMQP 帳密；construction 不連線，list/總覽呼叫時才驗證可達）。
        let mgmt = MgmtClient::new(
            &config::mgmt_url(config),
            config.username.trim().to_string(),
            config.password.clone(),
        )
        .ok()
        .map(Arc::new);
        Ok(RabbitMqDriver {
            conn,
            chan: Mutex::new(chan),
            mgmt,
            vhost,
        })
    }

    async fn ping(&self) -> AppResult<()> {
        // 開一條臨時 channel 再關閉：廉價的 AMQP 層存活偵測。
        let ch = self.conn.create_channel().await.map_err(conn_err)?;
        let _ = ch.close(200u16, ShortString::from("ping")).await;
        Ok(())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        // RabbitMQ 無資料庫層級；回單一合成 vhost 節點供連線樹展開。
        Ok(vec![self.vhost.clone()])
    }

    async fn list_tables(&self, _database: &str) -> AppResult<Vec<TableInfo>> {
        let mgmt = self.mgmt.as_ref().ok_or_else(|| {
            AppError::Unsupported(t!("需要 Management API（請於連線設定填 URL 或確認 15672 可達）").into())
        })?;
        let queues = mgmt.queues(&self.vhost).await?;
        Ok(queues
            .into_iter()
            .map(|q| TableInfo {
                name: q.name,
                kind: "table".to_string(),
            })
            .collect())
    }

    async fn table_columns(&self, _database: &str, _table: &str) -> AppResult<Vec<ColumnInfo>> {
        Ok(synthetic_queue_columns())
    }

    async fn table_data(
        &self,
        _database: &str,
        _table: &str,
        _query: &DataQuery,
    ) -> AppResult<PagedData> {
        // peek 有副作用（basic.get + requeue），不允許泛用資料格默默觸發；GUI 走專屬佇列瀏覽面板。
        Err(AppError::Unsupported(
            t!("請從佇列開啟訊息瀏覽（basic.get 有副作用，不走通用資料格）").into(),
        ))
    }

    async fn query(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::Unsupported(
            t!("RabbitMQ 連線不支援 SQL 查詢（請從佇列開啟訊息瀏覽 / 發布）").into(),
        ))
    }

    async fn update_cell(&self, _database: &str, _table: &str, _edit: &CellEdit) -> AppResult<u64> {
        Err(AppError::Unsupported(t!("RabbitMQ 訊息不可就地編輯（請用發布訊息）").into()))
    }

    async fn insert_row(&self, _database: &str, _table: &str, _row: &RowInsert) -> AppResult<u64> {
        Err(AppError::Unsupported(t!("RabbitMQ 不支援插入列（請用發布訊息）").into()))
    }

    async fn delete_row(&self, _database: &str, _table: &str, _del: &RowDelete) -> AppResult<u64> {
        Err(AppError::Unsupported(t!("RabbitMQ 訊息不可刪除").into()))
    }

    fn pool_status(&self) -> PoolStatus {
        PoolStatus {
            size: 1,
            idle: 0,
            in_use: 1,
        }
    }

    async fn close(&self) {
        let _ = self.conn.close(200u16, ShortString::from("bye")).await;
    }
}
