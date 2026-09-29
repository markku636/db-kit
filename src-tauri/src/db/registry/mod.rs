//! Docker Registry（OCI Distribution / Registry HTTP API v2）驅動。
//!
//! 連線樹：repository → database、tag → table。repository 清單優先用連線設定的 `registry_repos`
//! （逗號 / 換行分隔；Docker Hub、GHCR 等不開放 `_catalog` 的 registry 必填），否則走 `_catalog`。
//! manifest / 刪除等走 `commands::registry_*`。

pub mod api;
pub mod auth;
pub mod dto;

#[cfg(test)]
mod it_tests;

use std::sync::Arc;

use api::RegistryApi;

use crate::db::http_tls::opt;
use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, PagedData, PoolStatus,
    QueryResult, RowDelete, RowInsert, TableInfo,
};
use crate::error::{AppError, AppResult};

pub struct RegistryDriver {
    pub api: Arc<RegistryApi>,
    /// 使用者指定的 repository 清單（空 = 用 `_catalog`）。
    repos: Vec<String>,
}

/// `registry_repos`：逗號 / 換行 / 空白分隔。
pub(crate) fn parse_repo_list(s: &str) -> Vec<String> {
    let mut v: Vec<String> = s
        .split([',', '\n', '\r', ' ', '\t'])
        .map(|x| x.trim().trim_matches('/').to_string())
        .filter(|x| !x.is_empty())
        .collect();
    v.dedup();
    v
}

fn unsupported() -> AppError {
    AppError::Unsupported(t!("Registry 連線不支援此操作（請從連線樹開啟 tag）").into())
}

impl RegistryDriver {
    /// 目前要顯示的 repository 清單。
    pub async fn repositories(&self) -> AppResult<Vec<String>> {
        if !self.repos.is_empty() {
            return Ok(self.repos.clone());
        }
        self.api.catalog().await.map_err(|e| match e {
            AppError::Connect(m) | AppError::Query(m) if m.contains("401") || m.contains("403") || m.contains("404") || m.contains("UNSUPPORTED") => {
                AppError::Query(tf!(
                    "此 registry 不開放 repository 清單（_catalog）：{m}\n請在連線設定的「Repository 清單」填入要瀏覽的 repository",
                    m = m
                ))
            }
            other => other,
        })
    }
}

#[async_trait::async_trait]
impl DatabaseDriver for RegistryDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let api = RegistryApi::new(config)?;
        api.ping().await?;
        let repos = opt(config, "registry_repos").map(parse_repo_list).unwrap_or_default();
        Ok(RegistryDriver { api: Arc::new(api), repos })
    }

    async fn ping(&self) -> AppResult<()> {
        self.api.ping().await
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        self.repositories().await
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        Ok(self
            .api
            .tags(database)
            .await?
            .into_iter()
            .map(|name| TableInfo { name, kind: "tag".to_string() })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_list_parsing() {
        assert_eq!(parse_repo_list("library/nginx, org/app\nteam/x "), vec!["library/nginx", "org/app", "team/x"]);
        assert!(parse_repo_list("  ").is_empty());
    }
}
