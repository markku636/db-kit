//! 容器類連線（Docker / Registry / Harbor / Kubernetes）的統一包裝。
//!
//! manager 的 `Active` 只多一個 `Container` 變體，內部再依 kind 分派——三種 kind 共用
//! `docker` feature 與同一組 SSH 通道前處理，不必在 manager 的 40 多個委派 match 各加三條分支。

use std::sync::Arc;

use crate::db::docker::api::DockerApi;
use crate::db::docker::DockerDriver;
use crate::db::harbor::api::HarborApi;
use crate::db::harbor::HarborDriver;
use crate::db::http_tls::normalize_target;
use crate::db::k8s::api::K8sApi;
use crate::db::k8s::K8sDriver;
use crate::db::registry::RegistryDriver;
use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, DbKind, PagedData, PoolStatus,
    QueryResult, RowDelete, RowInsert, TableInfo,
};
use crate::error::{AppError, AppResult};

pub enum ContainerDriver {
    Docker(DockerDriver),
    Registry(RegistryDriver),
    Harbor(HarborDriver),
    Kubernetes(K8sDriver),
}

impl ContainerDriver {
    pub fn kind(&self) -> DbKind {
        match self {
            ContainerDriver::Docker(_) => DbKind::Docker,
            ContainerDriver::Registry(_) => DbKind::Registry,
            ContainerDriver::Harbor(_) => DbKind::Harbor,
            ContainerDriver::Kubernetes(_) => DbKind::Kubernetes,
        }
    }

    pub fn is_container_kind(kind: DbKind) -> bool {
        matches!(kind, DbKind::Docker | DbKind::Registry | DbKind::Harbor | DbKind::Kubernetes)
    }

    /// Docker Engine API 用戶端（非 Docker 連線回 Unsupported）。
    pub fn docker(&self) -> AppResult<Arc<DockerApi>> {
        match self {
            ContainerDriver::Docker(d) => Ok(d.api.clone()),
            _ => Err(AppError::Unsupported(t!("此連線不是 Docker").into())),
        }
    }

    pub fn registry(&self) -> AppResult<&RegistryDriver> {
        match self {
            ContainerDriver::Registry(d) => Ok(d),
            _ => Err(AppError::Unsupported(t!("此連線不是 Registry").into())),
        }
    }

    pub fn harbor(&self) -> AppResult<Arc<HarborApi>> {
        match self {
            ContainerDriver::Harbor(d) => Ok(d.api.clone()),
            _ => Err(AppError::Unsupported(t!("此連線不是 Harbor").into())),
        }
    }

    /// Kubernetes API 用戶端（非 Kubernetes 連線回 Unsupported）。
    pub fn k8s(&self) -> AppResult<Arc<K8sApi>> {
        match self {
            ContainerDriver::Kubernetes(d) => Ok(d.api.clone()),
            _ => Err(AppError::Unsupported(t!("此連線不是 Kubernetes").into())),
        }
    }
}

/// 開 SSH 通道前的前處理：把 `host` 欄的 URL 形式攤平成 host / port（通道只轉發 `host:port`），
/// scheme 與路徑前綴移進 options；本機 socket / pipe 型的 Docker 則直接拒絕（通道轉不了本機 socket）。
pub fn prepare_tunnel(cfg: &mut ConnectionConfig) -> AppResult<()> {
    match cfg.kind {
        DbKind::Docker => match crate::db::docker::config::endpoint(cfg) {
            crate::db::docker::config::Endpoint::Tcp(t) => {
                cfg.host = t.host;
                cfg.port = t.port;
                if t.tls {
                    cfg.options.insert("docker_tls".into(), "1".into());
                }
            }
            _ => {
                return Err(AppError::Connect(
                    t!("本機 socket / named pipe 型的 Docker 連線不能走 SSH 通道；請改用 TCP（daemon 需監聽 TCP 埠）").into(),
                ))
            }
        },
        DbKind::Registry | DbKind::Harbor => {
            let kind = if cfg.kind == DbKind::Registry { "registry" } else { "harbor" };
            // 與 reg_target 同一套預設：裸主機時 localhost 走 http、其餘 https。
            let t = crate::db::http_tls::reg_target(cfg, kind);
            normalize_target(cfg, t.tls, (80, 443), &format!("{kind}_tls"), &format!("{kind}_prefix"));
        }
        DbKind::Kubernetes => crate::db::k8s::prepare_tunnel(cfg)?,
        _ => {}
    }
    Ok(())
}

macro_rules! delegate {
    ($self:ident, $d:ident => $e:expr) => {
        match $self {
            ContainerDriver::Docker($d) => $e,
            ContainerDriver::Registry($d) => $e,
            ContainerDriver::Harbor($d) => $e,
            ContainerDriver::Kubernetes($d) => $e,
        }
    };
}

#[async_trait::async_trait]
impl DatabaseDriver for ContainerDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        match config.kind {
            DbKind::Docker => DockerDriver::connect(config).await.map(ContainerDriver::Docker),
            DbKind::Registry => RegistryDriver::connect(config).await.map(ContainerDriver::Registry),
            DbKind::Harbor => HarborDriver::connect(config).await.map(ContainerDriver::Harbor),
            DbKind::Kubernetes => K8sDriver::connect(config).await.map(ContainerDriver::Kubernetes),
            other => Err(AppError::Unsupported(format!("{other:?}"))),
        }
    }

    async fn ping(&self) -> AppResult<()> {
        delegate!(self, d => d.ping().await)
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        delegate!(self, d => d.list_databases().await)
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        delegate!(self, d => d.list_tables(database).await)
    }

    async fn table_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        delegate!(self, d => d.table_columns(database, table).await)
    }

    async fn table_data(&self, database: &str, table: &str, query: &DataQuery) -> AppResult<PagedData> {
        delegate!(self, d => d.table_data(database, table, query).await)
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        delegate!(self, d => d.query(sql).await)
    }

    async fn update_cell(&self, database: &str, table: &str, edit: &CellEdit) -> AppResult<u64> {
        delegate!(self, d => d.update_cell(database, table, edit).await)
    }

    async fn insert_row(&self, database: &str, table: &str, row: &RowInsert) -> AppResult<u64> {
        delegate!(self, d => d.insert_row(database, table, row).await)
    }

    async fn delete_row(&self, database: &str, table: &str, del: &RowDelete) -> AppResult<u64> {
        delegate!(self, d => d.delete_row(database, table, del).await)
    }

    fn pool_status(&self) -> PoolStatus {
        delegate!(self, d => d.pool_status())
    }

    async fn close(&self) {
        delegate!(self, d => d.close().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::docker::config::tests::cfg;

    #[test]
    fn tunnel_rejects_local_docker() {
        let mut c = cfg("");
        assert!(prepare_tunnel(&mut c).is_err());
    }

    #[test]
    fn tunnel_flattens_tcp_url() {
        let mut c = cfg("https://docker.internal:2376");
        prepare_tunnel(&mut c).unwrap();
        assert_eq!((c.host.as_str(), c.port), ("docker.internal", 2376));
        assert_eq!(c.options.get("docker_tls").map(String::as_str), Some("1"));
    }

    #[test]
    fn tunnel_flattens_harbor_url() {
        let mut c = cfg("https://harbor.corp/sub");
        c.kind = DbKind::Harbor;
        prepare_tunnel(&mut c).unwrap();
        assert_eq!((c.host.as_str(), c.port), ("harbor.corp", 443));
        assert_eq!(c.options.get("harbor_tls").map(String::as_str), Some("1"));
        assert_eq!(c.options.get("harbor_prefix").map(String::as_str), Some("/sub"));

        let mut r = cfg("localhost:5000");
        r.kind = DbKind::Registry;
        prepare_tunnel(&mut r).unwrap();
        assert_eq!((r.host.as_str(), r.port), ("localhost", 5000));
        assert_eq!(r.options.get("registry_tls").map(String::as_str), Some("0"));
    }
}
