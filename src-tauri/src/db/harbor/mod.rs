//! Harbor 驅動（`/api/v2.0`）。連線樹：project → database、repository（去掉專案前綴）→ table。
//! artifact / tag / 弱點掃描 / 刪除走 `commands::harbor_*`。

pub mod api;
pub mod dto;

use std::sync::Arc;

use api::HarborApi;

use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, PagedData, PoolStatus,
    QueryResult, RowDelete, RowInsert, TableInfo,
};
use crate::error::{AppError, AppResult};

pub struct HarborDriver {
    pub api: Arc<HarborApi>,
}

fn unsupported() -> AppError {
    AppError::Unsupported(t!("Harbor 連線不支援此操作（請從連線樹開啟 repository）").into())
}

#[async_trait::async_trait]
impl DatabaseDriver for HarborDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let api = HarborApi::new(config)?;
        api.ping().await?;
        Ok(HarborDriver { api: Arc::new(api) })
    }

    async fn ping(&self) -> AppResult<()> {
        self.api.ping().await
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        self.api.project_names().await
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        Ok(self
            .api
            .repositories(database)
            .await?
            .into_iter()
            .map(|r| TableInfo { name: r.name, kind: "repository".to_string() })
            .collect())
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
