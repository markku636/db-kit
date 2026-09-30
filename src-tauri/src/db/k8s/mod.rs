//! Kubernetes 驅動（API server REST + WebSocket；全走既有 reqwest，不引入 kube-rs）。
//!
//! 連線樹映射：database = namespace（外加一個「叢集」節點 `CLUSTER_DB`，放 Node / PV / StorageClass / CRD），
//! table = `種類複數/名稱`（`pods/redis-7c9…`），`TableInfo.kind` = `k8s:<種類>:<狀態>` 供前端分組、上色。
//! 資源詳情 / YAML / log / exec / port-forward 走 `commands::k8s_*`，由
//! `manager.container_driver(id)?.k8s()` 取得 `K8sApi` 後呼叫。
//!
//! 資料庫連線也可以「經由 Kubernetes port-forward」連到叢集內的 DB（`forward::open_db_forward`）。

pub mod api;
pub mod auth;
pub mod dto;
pub mod forward;
pub mod kubeconfig;
pub mod stream;
pub mod ws;

#[cfg(test)]
mod it_tests;

use std::sync::Arc;

use api::K8sApi;

use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, PagedData, PoolStatus, QueryResult, RowDelete,
    RowInsert, TableInfo,
};
use crate::error::{AppError, AppResult};

/// 連線樹上代表 cluster 範圍資源的 database 名稱（namespace 名稱不可能含括號）。
pub const CLUSTER_DB: &str = "(cluster)";

pub struct K8sDriver {
    pub api: Arc<K8sApi>,
}

fn unsupported() -> AppError {
    AppError::Unsupported(t!("Kubernetes 連線不支援此操作（請從連線樹開啟資源）").into())
}

#[async_trait::async_trait]
impl DatabaseDriver for K8sDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let api = K8sApi::new(config)?;
        api.ping().await?;
        Ok(K8sDriver { api: Arc::new(api) })
    }

    async fn ping(&self) -> AppResult<()> {
        self.api.ping().await
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let mut out = vec![CLUSTER_DB.to_string()];
        out.extend(self.api.namespaces().await?);
        Ok(out)
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        if database == CLUSTER_DB {
            self.api.tree(None).await
        } else {
            self.api.tree(Some(database)).await
        }
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

/// 開 SSH 通道前的前處理：API server 網址攤平成 host / port（通道只轉發 `host:port`），原網址記進 options。
pub fn prepare_tunnel(cfg: &mut ConnectionConfig) -> AppResult<()> {
    let spec = kubeconfig::spec_from_config(cfg)?;
    let t = crate::db::http_tls::parse_target(&spec.server, 0, true, (80, 443));
    cfg.options.insert(api::TUNNEL_SERVER.to_string(), spec.server.clone());
    cfg.host = t.host;
    cfg.port = t.port;
    Ok(())
}
