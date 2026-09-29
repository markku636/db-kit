//! Docker 驅動（Engine REST API；本機 socket / named pipe、TCP、TLS / mTLS）。
//!
//! 設計同 RabbitMQ：`DatabaseDriver` 只做讓連線樹可運作的最小映射——
//! 四個固定分類當 database（containers / images / volumes / networks），各項目當 table
//! （`TableInfo.kind` 帶 `container-<state>` / `image` / `image-dangling` / `volume` / `network`
//! 供前端換圖示）。容器操作 / log / exec / 映像拉取等走 `commands::docker_*`，
//! 由 `manager.container_driver(id)?.docker()` 取得 `DockerApi` 後呼叫。

pub mod api;
pub mod config;
pub mod dto;
pub mod stream;

#[cfg(test)]
mod it_tests;

use std::sync::Arc;

use api::DockerApi;

use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, PagedData, PoolStatus,
    QueryResult, RowDelete, RowInsert, TableInfo,
};
use crate::error::{AppError, AppResult};

/// 連線樹的四個固定分類（database 層）。前端依此字串顯示翻譯後的標籤。
pub const CATEGORIES: [&str; 4] = ["containers", "images", "volumes", "networks"];

pub struct DockerDriver {
    pub api: Arc<DockerApi>,
}

fn unsupported() -> AppError {
    AppError::Unsupported(t!("Docker 連線不支援此操作（請從連線樹開啟容器 / 映像）").into())
}

#[async_trait::async_trait]
impl DatabaseDriver for DockerDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let api = DockerApi::new(config)?;
        api.ping().await?;
        Ok(DockerDriver { api: Arc::new(api) })
    }

    async fn ping(&self) -> AppResult<()> {
        self.api.ping().await
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        Ok(CATEGORIES.iter().map(|s| s.to_string()).collect())
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let item = |name: String, kind: String| TableInfo { name, kind };
        Ok(match database {
            "containers" => self
                .api
                .containers(true)
                .await?
                .into_iter()
                .map(|c| item(c.name, format!("container-{}", c.state)))
                .collect(),
            "images" => self
                .api
                .images()
                .await?
                .into_iter()
                .map(|i| item(i.reference, if i.dangling { "image-dangling" } else { "image" }.to_string()))
                .collect(),
            "volumes" => self
                .api
                .volumes()
                .await?
                .into_iter()
                .map(|v| item(v.name, "volume".to_string()))
                .collect(),
            "networks" => self
                .api
                .networks()
                .await?
                .into_iter()
                .map(|n| item(n.name, "network".to_string()))
                .collect(),
            _ => Vec::new(),
        })
    }

    async fn table_columns(&self, _database: &str, _table: &str) -> AppResult<Vec<ColumnInfo>> {
        Ok(Vec::new())
    }

    async fn table_data(&self, _database: &str, _table: &str, _query: &DataQuery) -> AppResult<PagedData> {
        Err(unsupported())
    }

    async fn query(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(unsupported())
    }

    async fn update_cell(&self, _database: &str, _table: &str, _edit: &CellEdit) -> AppResult<u64> {
        Err(unsupported())
    }

    async fn insert_row(&self, _database: &str, _table: &str, _row: &RowInsert) -> AppResult<u64> {
        Err(unsupported())
    }

    async fn delete_row(&self, _database: &str, _table: &str, _del: &RowDelete) -> AppResult<u64> {
        Err(unsupported())
    }

    fn pool_status(&self) -> PoolStatus {
        PoolStatus { size: 1, idle: 1, in_use: 0 }
    }

    async fn close(&self) {}
}
