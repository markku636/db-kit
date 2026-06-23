use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::db::mongo::MongoDriver;
use crate::db::mysql::MysqlDriver;
use crate::db::postgres::PostgresDriver;
use crate::db::redis::RedisDriver;
use crate::db::sqlite::SqliteDriver;
use crate::db::{
    AlterOp, CellEdit, ColumnInfo, ColumnStats, ConnectionConfig, DataQuery, DatabaseDriver, DbKind,
    ErModel, IndexInfo, KeyDetail, KeyEdit, PagedData, PoolStatus, QueryResult, RoutineInfo, RowDelete,
    RowInsert, ServerInfoSection, TableInfo,
};
use crate::error::{AppError, AppResult};
use crate::ssh::TunnelGuard;

/// 持有一個已連線的 driver。
enum Active {
    Mysql(Arc<MysqlDriver>),
    Postgres(Arc<PostgresDriver>),
    Sqlite(Arc<SqliteDriver>),
    Mongo(Arc<MongoDriver>),
    Redis(Arc<RedisDriver>),
}

impl Active {
    async fn ping(&self) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.ping().await,
            Active::Postgres(d) => d.ping().await,
            Active::Sqlite(d) => d.ping().await,
            Active::Mongo(d) => d.ping().await,
            Active::Redis(d) => d.ping().await,
        }
    }
    async fn list_databases(&self) -> AppResult<Vec<String>> {
        match self {
            Active::Mysql(d) => d.list_databases().await,
            Active::Postgres(d) => d.list_databases().await,
            Active::Sqlite(d) => d.list_databases().await,
            Active::Mongo(d) => d.list_databases().await,
            Active::Redis(d) => d.list_databases().await,
        }
    }
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        match self {
            Active::Mysql(d) => d.list_tables(database).await,
            Active::Postgres(d) => d.list_tables(database).await,
            Active::Sqlite(d) => d.list_tables(database).await,
            Active::Mongo(d) => d.list_tables(database).await,
            Active::Redis(d) => d.list_tables(database).await,
        }
    }
    async fn table_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        match self {
            Active::Mysql(d) => d.table_columns(database, table).await,
            Active::Postgres(d) => d.table_columns(database, table).await,
            Active::Sqlite(d) => d.table_columns(database, table).await,
            Active::Mongo(d) => d.table_columns(database, table).await,
            Active::Redis(d) => d.table_columns(database, table).await,
        }
    }
    async fn table_data(
        &self,
        database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        match self {
            Active::Mysql(d) => d.table_data(database, table, query).await,
            Active::Postgres(d) => d.table_data(database, table, query).await,
            Active::Sqlite(d) => d.table_data(database, table, query).await,
            Active::Mongo(d) => d.table_data(database, table, query).await,
            Active::Redis(d) => d.table_data(database, table, query).await,
        }
    }
    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        match self {
            Active::Mysql(d) => d.query(sql).await,
            Active::Postgres(d) => d.query(sql).await,
            Active::Sqlite(d) => d.query(sql).await,
            Active::Mongo(d) => d.query(sql).await,
            Active::Redis(d) => d.query(sql).await,
        }
    }
    async fn update_cell(
        &self,
        database: &str,
        table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64> {
        match self {
            Active::Mysql(d) => d.update_cell(database, table, edit).await,
            Active::Postgres(d) => d.update_cell(database, table, edit).await,
            Active::Sqlite(d) => d.update_cell(database, table, edit).await,
            Active::Mongo(d) => d.update_cell(database, table, edit).await,
            Active::Redis(d) => d.update_cell(database, table, edit).await,
        }
    }
    async fn insert_row(
        &self,
        database: &str,
        table: &str,
        row: &RowInsert,
    ) -> AppResult<u64> {
        match self {
            Active::Mysql(d) => d.insert_row(database, table, row).await,
            Active::Postgres(d) => d.insert_row(database, table, row).await,
            Active::Sqlite(d) => d.insert_row(database, table, row).await,
            Active::Mongo(d) => d.insert_row(database, table, row).await,
            Active::Redis(d) => d.insert_row(database, table, row).await,
        }
    }
    async fn delete_row(
        &self,
        database: &str,
        table: &str,
        del: &RowDelete,
    ) -> AppResult<u64> {
        match self {
            Active::Mysql(d) => d.delete_row(database, table, del).await,
            Active::Postgres(d) => d.delete_row(database, table, del).await,
            Active::Sqlite(d) => d.delete_row(database, table, del).await,
            Active::Mongo(d) => d.delete_row(database, table, del).await,
            Active::Redis(d) => d.delete_row(database, table, del).await,
        }
    }
    fn pool_status(&self) -> PoolStatus {
        match self {
            Active::Mysql(d) => d.pool_status(),
            Active::Postgres(d) => d.pool_status(),
            Active::Sqlite(d) => d.pool_status(),
            Active::Mongo(d) => d.pool_status(),
            Active::Redis(d) => d.pool_status(),
        }
    }
    async fn key_detail(&self, database: &str, key: &str) -> AppResult<Option<KeyDetail>> {
        match self {
            Active::Mysql(d) => d.key_detail(database, key).await,
            Active::Postgres(d) => d.key_detail(database, key).await,
            Active::Sqlite(d) => d.key_detail(database, key).await,
            Active::Mongo(d) => d.key_detail(database, key).await,
            Active::Redis(d) => d.key_detail(database, key).await,
        }
    }
    async fn key_edit(&self, database: &str, key: &str, edit: &KeyEdit) -> AppResult<u64> {
        match self {
            Active::Mysql(d) => d.key_edit(database, key, edit).await,
            Active::Postgres(d) => d.key_edit(database, key, edit).await,
            Active::Sqlite(d) => d.key_edit(database, key, edit).await,
            Active::Mongo(d) => d.key_edit(database, key, edit).await,
            Active::Redis(d) => d.key_edit(database, key, edit).await,
        }
    }
    async fn explain(&self, sql: &str) -> AppResult<QueryResult> {
        match self {
            Active::Mysql(d) => d.explain(sql).await,
            Active::Postgres(d) => d.explain(sql).await,
            Active::Sqlite(d) => d.explain(sql).await,
            Active::Mongo(d) => d.explain(sql).await,
            Active::Redis(d) => d.explain(sql).await,
        }
    }
    async fn column_stats(&self, database: &str, table: &str, column: &str) -> AppResult<ColumnStats> {
        match self {
            Active::Mysql(d) => d.column_stats(database, table, column).await,
            Active::Postgres(d) => d.column_stats(database, table, column).await,
            Active::Sqlite(d) => d.column_stats(database, table, column).await,
            Active::Mongo(d) => d.column_stats(database, table, column).await,
            Active::Redis(d) => d.column_stats(database, table, column).await,
        }
    }
    async fn table_info(&self, database: &str, table: &str) -> AppResult<Vec<(String, String)>> {
        match self {
            Active::Mysql(d) => d.table_info(database, table).await,
            Active::Postgres(d) => d.table_info(database, table).await,
            Active::Sqlite(d) => d.table_info(database, table).await,
            Active::Mongo(d) => d.table_info(database, table).await,
            Active::Redis(d) => d.table_info(database, table).await,
        }
    }
    async fn create_collection(&self, database: &str, name: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.create_collection(database, name).await,
            Active::Postgres(d) => d.create_collection(database, name).await,
            Active::Sqlite(d) => d.create_collection(database, name).await,
            Active::Mongo(d) => d.create_collection(database, name).await,
            Active::Redis(d) => d.create_collection(database, name).await,
        }
    }
    async fn create_database(&self, name: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.create_database(name).await,
            Active::Postgres(d) => d.create_database(name).await,
            Active::Sqlite(d) => d.create_database(name).await,
            Active::Mongo(d) => d.create_database(name).await,
            Active::Redis(d) => d.create_database(name).await,
        }
    }
    async fn drop_collection(&self, database: &str, name: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.drop_collection(database, name).await,
            Active::Postgres(d) => d.drop_collection(database, name).await,
            Active::Sqlite(d) => d.drop_collection(database, name).await,
            Active::Mongo(d) => d.drop_collection(database, name).await,
            Active::Redis(d) => d.drop_collection(database, name).await,
        }
    }
    async fn drop_database(&self, name: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.drop_database(name).await,
            Active::Postgres(d) => d.drop_database(name).await,
            Active::Sqlite(d) => d.drop_database(name).await,
            Active::Mongo(d) => d.drop_database(name).await,
            Active::Redis(d) => d.drop_database(name).await,
        }
    }
    async fn list_routines(&self, database: &str) -> AppResult<Vec<RoutineInfo>> {
        match self {
            Active::Mysql(d) => d.list_routines(database).await,
            Active::Postgres(d) => d.list_routines(database).await,
            Active::Sqlite(d) => d.list_routines(database).await,
            Active::Mongo(d) => d.list_routines(database).await,
            Active::Redis(d) => d.list_routines(database).await,
        }
    }
    async fn routine_definition(&self, database: &str, name: &str, routine_type: &str) -> AppResult<String> {
        match self {
            Active::Mysql(d) => d.routine_definition(database, name, routine_type).await,
            Active::Postgres(d) => d.routine_definition(database, name, routine_type).await,
            Active::Sqlite(d) => d.routine_definition(database, name, routine_type).await,
            Active::Mongo(d) => d.routine_definition(database, name, routine_type).await,
            Active::Redis(d) => d.routine_definition(database, name, routine_type).await,
        }
    }
    async fn exec_ddl(&self, sql: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.exec_ddl(sql).await,
            Active::Postgres(d) => d.exec_ddl(sql).await,
            Active::Sqlite(d) => d.exec_ddl(sql).await,
            Active::Mongo(d) => d.exec_ddl(sql).await,
            Active::Redis(d) => d.exec_ddl(sql).await,
        }
    }
    async fn alter_table(&self, database: &str, table: &str, op: &AlterOp) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.alter_table(database, table, op).await,
            Active::Postgres(d) => d.alter_table(database, table, op).await,
            Active::Sqlite(d) => d.alter_table(database, table, op).await,
            Active::Mongo(d) => d.alter_table(database, table, op).await,
            Active::Redis(d) => d.alter_table(database, table, op).await,
        }
    }
    async fn er_model(&self, database: &str) -> AppResult<ErModel> {
        match self {
            Active::Mysql(d) => d.er_model(database).await,
            Active::Postgres(d) => d.er_model(database).await,
            Active::Sqlite(d) => d.er_model(database).await,
            Active::Mongo(d) => d.er_model(database).await,
            Active::Redis(d) => d.er_model(database).await,
        }
    }
    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        match self {
            Active::Mysql(d) => d.table_ddl(database, table).await,
            Active::Postgres(d) => d.table_ddl(database, table).await,
            Active::Sqlite(d) => d.table_ddl(database, table).await,
            Active::Mongo(d) => d.table_ddl(database, table).await,
            Active::Redis(d) => d.table_ddl(database, table).await,
        }
    }
    async fn table_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        match self {
            Active::Mysql(d) => d.table_indexes(database, table).await,
            Active::Postgres(d) => d.table_indexes(database, table).await,
            Active::Sqlite(d) => d.table_indexes(database, table).await,
            Active::Mongo(d) => d.table_indexes(database, table).await,
            Active::Redis(d) => d.table_indexes(database, table).await,
        }
    }
    async fn drop_index(&self, database: &str, table: &str, index: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.drop_index(database, table, index).await,
            Active::Postgres(d) => d.drop_index(database, table, index).await,
            Active::Sqlite(d) => d.drop_index(database, table, index).await,
            Active::Mongo(d) => d.drop_index(database, table, index).await,
            Active::Redis(d) => d.drop_index(database, table, index).await,
        }
    }
    async fn create_index(&self, database: &str, table: &str, name: &str, columns: &[String], unique: bool) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Postgres(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Sqlite(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Mongo(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Redis(d) => d.create_index(database, table, name, columns, unique).await,
        }
    }
    async fn server_info(&self) -> AppResult<Vec<ServerInfoSection>> {
        match self {
            Active::Mysql(d) => d.server_info().await,
            Active::Postgres(d) => d.server_info().await,
            Active::Sqlite(d) => d.server_info().await,
            Active::Mongo(d) => d.server_info().await,
            Active::Redis(d) => d.server_info().await,
        }
    }
    async fn close(&self) {
        match self {
            Active::Mysql(d) => d.close().await,
            Active::Postgres(d) => d.close().await,
            Active::Sqlite(d) => d.close().await,
            Active::Mongo(d) => d.close().await,
            Active::Redis(d) => d.close().await,
        }
    }
}

/// 一個活著的連線：driver + 其專屬 SSH tunnel（若有）。
/// tunnel 與 driver 生命週期綁定，斷線時一併收掉。
struct LiveConn {
    active: Active,
    tunnel: Mutex<Option<TunnelGuard>>,
}

/// 全域連線管理器。負責建立、查找、釋放連線池。
///
/// 釋放策略（呼應規劃 3.5）：
/// - disconnect 主動關閉單一連線（含 tunnel）
/// - close_all 在應用關閉時 drain 全部連線池（含全部 tunnel）
#[derive(Default)]
pub struct ConnectionManager {
    active: Mutex<HashMap<String, Arc<LiveConn>>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建立連線（會做一次健康檢查）。已存在則先關舊的再建。
    /// 若啟用 SSH，先開 tunnel 並把 host/port 改寫成本地轉發埠。
    pub async fn connect(&self, config: ConnectionConfig) -> AppResult<()> {
        // 若已有同 id 連線，先關閉釋放（含舊 tunnel）。
        self.disconnect(&config.id).await;

        let mut cfg = config;

        // SSH tunnel（SQLite 不適用）。
        let mut tunnel: Option<TunnelGuard> = None;
        if cfg.ssh_enabled && !matches!(cfg.kind, DbKind::Sqlite) {
            let guard = crate::ssh::open_tunnel(&cfg).await?;
            cfg.host = "127.0.0.1".to_string();
            cfg.port = guard.local_port();
            tunnel = Some(guard);
        }

        let built = match cfg.kind {
            DbKind::Mysql => MysqlDriver::connect(&cfg).await.map(|d| Active::Mysql(Arc::new(d))),
            DbKind::Sqlite => {
                SqliteDriver::connect(&cfg).await.map(|d| Active::Sqlite(Arc::new(d)))
            }
            DbKind::Postgres => {
                PostgresDriver::connect(&cfg).await.map(|d| Active::Postgres(Arc::new(d)))
            }
            DbKind::Mongo => MongoDriver::connect(&cfg).await.map(|d| Active::Mongo(Arc::new(d))),
            DbKind::Redis => RedisDriver::connect(&cfg).await.map(|d| Active::Redis(Arc::new(d))),
        };

        // driver 建立失敗：手動收掉 tunnel，避免背景任務洩漏（不可用裸 `?`）。
        let active = match built {
            Ok(a) => a,
            Err(e) => {
                if let Some(g) = tunnel {
                    g.shutdown().await;
                }
                return Err(e);
            }
        };

        let live = Arc::new(LiveConn {
            active,
            tunnel: Mutex::new(tunnel),
        });
        // 並發 connect 同一 id 的競態：insert 回傳被覆蓋的舊連線時，收掉其 tunnel + driver，
        // 避免背景任務 / session 洩漏（起始的 disconnect 只處理「先前已存在」的常見情形）。
        let displaced = self.active.lock().insert(cfg.id.clone(), live);
        if let Some(old) = displaced {
            old.active.close().await;
            let tunnel = old.tunnel.lock().take();
            if let Some(g) = tunnel {
                g.shutdown().await;
            }
        }
        Ok(())
    }

    /// 僅測試連線是否成功，不保留。SSH 則臨時開 tunnel 測完即關。
    pub async fn test(&self, config: &ConnectionConfig) -> AppResult<()> {
        let mut cfg = config.clone();
        let mut tunnel: Option<TunnelGuard> = None;
        if cfg.ssh_enabled && !matches!(cfg.kind, DbKind::Sqlite) {
            let guard = crate::ssh::open_tunnel(&cfg).await?;
            cfg.host = "127.0.0.1".to_string();
            cfg.port = guard.local_port();
            tunnel = Some(guard);
        }
        let result = Self::test_inner(&cfg).await;
        // 不論成敗都收掉 tunnel。
        if let Some(g) = tunnel {
            g.shutdown().await;
        }
        result
    }

    async fn test_inner(config: &ConnectionConfig) -> AppResult<()> {
        match config.kind {
            DbKind::Mysql => {
                let driver = MysqlDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await; // 立即釋放，不留池
                Ok(())
            }
            DbKind::Sqlite => {
                let driver = SqliteDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
            DbKind::Postgres => {
                let driver = PostgresDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
            DbKind::Mongo => {
                let driver = MongoDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
            DbKind::Redis => {
                let driver = RedisDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
        }
    }

    fn get(&self, id: &str) -> AppResult<Arc<LiveConn>> {
        self.active
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(id.to_string()))
    }

    pub async fn ping(&self, id: &str) -> AppResult<()> {
        self.get(id)?.active.ping().await
    }

    pub async fn list_databases(&self, id: &str) -> AppResult<Vec<String>> {
        self.get(id)?.active.list_databases().await
    }

    pub async fn list_tables(&self, id: &str, database: &str) -> AppResult<Vec<TableInfo>> {
        self.get(id)?.active.list_tables(database).await
    }

    pub async fn table_columns(
        &self,
        id: &str,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        self.get(id)?.active.table_columns(database, table).await
    }

    pub async fn table_data(
        &self,
        id: &str,
        database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        self.get(id)?.active.table_data(database, table, query).await
    }

    pub async fn query(&self, id: &str, sql: &str) -> AppResult<QueryResult> {
        self.get(id)?.active.query(sql).await
    }

    pub async fn update_cell(
        &self,
        id: &str,
        database: &str,
        table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64> {
        self.get(id)?.active.update_cell(database, table, edit).await
    }

    pub async fn insert_row(
        &self,
        id: &str,
        database: &str,
        table: &str,
        row: &RowInsert,
    ) -> AppResult<u64> {
        self.get(id)?.active.insert_row(database, table, row).await
    }

    pub async fn delete_row(
        &self,
        id: &str,
        database: &str,
        table: &str,
        del: &RowDelete,
    ) -> AppResult<u64> {
        self.get(id)?.active.delete_row(database, table, del).await
    }

    pub fn pool_status(&self, id: &str) -> AppResult<PoolStatus> {
        Ok(self.get(id)?.active.pool_status())
    }

    pub async fn key_detail(
        &self,
        id: &str,
        database: &str,
        key: &str,
    ) -> AppResult<Option<KeyDetail>> {
        self.get(id)?.active.key_detail(database, key).await
    }

    pub async fn key_edit(
        &self,
        id: &str,
        database: &str,
        key: &str,
        edit: &KeyEdit,
    ) -> AppResult<u64> {
        self.get(id)?.active.key_edit(database, key, edit).await
    }

    pub async fn explain(&self, id: &str, sql: &str) -> AppResult<QueryResult> {
        self.get(id)?.active.explain(sql).await
    }

    pub async fn column_stats(&self, id: &str, database: &str, table: &str, column: &str) -> AppResult<ColumnStats> {
        self.get(id)?.active.column_stats(database, table, column).await
    }

    pub async fn table_info(&self, id: &str, database: &str, table: &str) -> AppResult<Vec<(String, String)>> {
        self.get(id)?.active.table_info(database, table).await
    }

    pub async fn create_collection(&self, id: &str, database: &str, name: &str) -> AppResult<()> {
        self.get(id)?.active.create_collection(database, name).await
    }

    pub async fn create_database(&self, id: &str, name: &str) -> AppResult<()> {
        self.get(id)?.active.create_database(name).await
    }

    pub async fn drop_collection(&self, id: &str, database: &str, name: &str) -> AppResult<()> {
        self.get(id)?.active.drop_collection(database, name).await
    }

    pub async fn drop_database(&self, id: &str, name: &str) -> AppResult<()> {
        self.get(id)?.active.drop_database(name).await
    }

    pub async fn list_routines(&self, id: &str, database: &str) -> AppResult<Vec<RoutineInfo>> {
        self.get(id)?.active.list_routines(database).await
    }

    pub async fn routine_definition(&self, id: &str, database: &str, name: &str, routine_type: &str) -> AppResult<String> {
        self.get(id)?.active.routine_definition(database, name, routine_type).await
    }

    pub async fn exec_ddl(&self, id: &str, sql: &str) -> AppResult<()> {
        self.get(id)?.active.exec_ddl(sql).await
    }

    pub async fn alter_table(
        &self,
        id: &str,
        database: &str,
        table: &str,
        op: &AlterOp,
    ) -> AppResult<()> {
        self.get(id)?.active.alter_table(database, table, op).await
    }

    pub async fn er_model(&self, id: &str, database: &str) -> AppResult<ErModel> {
        self.get(id)?.active.er_model(database).await
    }

    pub async fn table_ddl(&self, id: &str, database: &str, table: &str) -> AppResult<String> {
        self.get(id)?.active.table_ddl(database, table).await
    }

    pub async fn table_indexes(&self, id: &str, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        self.get(id)?.active.table_indexes(database, table).await
    }

    pub async fn drop_index(&self, id: &str, database: &str, table: &str, index: &str) -> AppResult<()> {
        self.get(id)?.active.drop_index(database, table, index).await
    }

    pub async fn create_index(&self, id: &str, database: &str, table: &str, name: &str, columns: &[String], unique: bool) -> AppResult<()> {
        self.get(id)?.active.create_index(database, table, name, columns, unique).await
    }

    pub async fn server_info(&self, id: &str) -> AppResult<Vec<ServerInfoSection>> {
        self.get(id)?.active.server_info().await
    }

    /// 主動關閉並移除單一連線（含其 tunnel）。
    pub async fn disconnect(&self, id: &str) {
        let removed = self.active.lock().remove(id);
        if let Some(live) = removed {
            live.active.close().await;
            // 在鎖外收掉 tunnel（take 後 guard 立即釋放，再 await）。
            let tunnel = live.tunnel.lock().take();
            if let Some(g) = tunnel {
                g.shutdown().await;
            }
        }
    }

    /// 優雅關閉：drain 全部連線池（含全部 tunnel）。應在應用關閉事件時呼叫。
    pub async fn close_all(&self) {
        let all: Vec<Arc<LiveConn>> = {
            let mut guard = self.active.lock();
            guard.drain().map(|(_, v)| v).collect()
        };
        for live in all {
            live.active.close().await;
            let tunnel = live.tunnel.lock().take();
            if let Some(g) = tunnel {
                g.shutdown().await;
            }
        }
    }
}
