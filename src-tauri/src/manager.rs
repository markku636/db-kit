use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::db::mongo::MongoDriver;
use crate::db::mssql::MssqlDriver;
use crate::db::mysql::MysqlDriver;
use crate::db::oracle::OracleDriver;
use crate::db::postgres::PostgresDriver;
use crate::db::redis::RedisDriver;
use crate::db::sqlite::SqliteDriver;
#[cfg(feature = "kafka")]
use crate::db::kafka::KafkaDriver;
#[cfg(feature = "elastic")]
use crate::db::elastic::ElasticDriver;
#[cfg(feature = "rabbitmq")]
use crate::db::rabbitmq::RabbitMqDriver;
use crate::db::{
    AlterOp, CellEdit, ColumnInfo, ColumnStats, ConnectionConfig, DataQuery, DatabaseDriver, DbKind,
    ErModel, ForeignKeyInfo, IndexInfo, KeyDetail, KeyEdit, PagedData, PoolStatus, QueryResult, RedisKeys,
    RoutineInfo, RowDelete, RowInsert, SearchHit, SearchOptions, ServerInfoSection, TableColumns, TableInfo, ValidationReport,
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
    Mssql(Arc<MssqlDriver>),
    Oracle(Arc<OracleDriver>),
    /// Kafka 驅動（一等公民；具體型別於 `kafka` feature 開啟時編入）。
    #[cfg(feature = "kafka")]
    Kafka(Arc<KafkaDriver>),
    /// Elasticsearch / OpenSearch 驅動（一等公民；具體型別於 `elastic` feature 開啟時編入）。
    #[cfg(feature = "elastic")]
    Elastic(Arc<ElasticDriver>),
    /// RabbitMQ 驅動（一等公民；具體型別於 `rabbitmq` feature 開啟時編入）。
    #[cfg(feature = "rabbitmq")]
    RabbitMq(Arc<RabbitMqDriver>),
    /// 外部 gateway 驅動（trait object，見 db::external）。
    Dyn(Arc<dyn DatabaseDriver>),
}

impl Active {
    /// 此連線的資料庫種類（供資料傳輸判斷同類型以決定能否沿用來源 DDL 建表）。
    /// 外部 gateway（Dyn）一律視為 External。
    fn kind(&self) -> DbKind {
        match self {
            Active::Mysql(_) => DbKind::Mysql,
            Active::Postgres(_) => DbKind::Postgres,
            Active::Sqlite(_) => DbKind::Sqlite,
            Active::Mongo(_) => DbKind::Mongo,
            Active::Redis(_) => DbKind::Redis,
            Active::Mssql(_) => DbKind::Mssql,
            Active::Oracle(_) => DbKind::Oracle,
            #[cfg(feature = "kafka")]
            Active::Kafka(_) => DbKind::Kafka,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(_) => DbKind::RabbitMq,
            #[cfg(feature = "elastic")]
            Active::Elastic(_) => DbKind::Elastic,
            Active::Dyn(_) => DbKind::External,
        }
    }

    async fn ping(&self) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.ping().await,
            Active::Postgres(d) => d.ping().await,
            Active::Sqlite(d) => d.ping().await,
            Active::Mongo(d) => d.ping().await,
            Active::Redis(d) => d.ping().await,
            Active::Mssql(d) => d.ping().await,
            Active::Oracle(d) => d.ping().await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.ping().await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.ping().await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.ping().await,
            Active::Dyn(d) => d.ping().await,
        }
    }
    async fn list_databases(&self) -> AppResult<Vec<String>> {
        match self {
            Active::Mysql(d) => d.list_databases().await,
            Active::Postgres(d) => d.list_databases().await,
            Active::Sqlite(d) => d.list_databases().await,
            Active::Mongo(d) => d.list_databases().await,
            Active::Redis(d) => d.list_databases().await,
            Active::Mssql(d) => d.list_databases().await,
            Active::Oracle(d) => d.list_databases().await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.list_databases().await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.list_databases().await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.list_databases().await,
            Active::Dyn(d) => d.list_databases().await,
        }
    }
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        match self {
            Active::Mysql(d) => d.list_tables(database).await,
            Active::Postgres(d) => d.list_tables(database).await,
            Active::Sqlite(d) => d.list_tables(database).await,
            Active::Mongo(d) => d.list_tables(database).await,
            Active::Redis(d) => d.list_tables(database).await,
            Active::Mssql(d) => d.list_tables(database).await,
            Active::Oracle(d) => d.list_tables(database).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.list_tables(database).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.list_tables(database).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.list_tables(database).await,
            Active::Dyn(d) => d.list_tables(database).await,
        }
    }
    async fn table_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        match self {
            Active::Mysql(d) => d.table_columns(database, table).await,
            Active::Postgres(d) => d.table_columns(database, table).await,
            Active::Sqlite(d) => d.table_columns(database, table).await,
            Active::Mongo(d) => d.table_columns(database, table).await,
            Active::Redis(d) => d.table_columns(database, table).await,
            Active::Mssql(d) => d.table_columns(database, table).await,
            Active::Oracle(d) => d.table_columns(database, table).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.table_columns(database, table).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.table_columns(database, table).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.table_columns(database, table).await,
            Active::Dyn(d) => d.table_columns(database, table).await,
        }
    }
    async fn schema_columns(&self, database: &str) -> AppResult<Vec<TableColumns>> {
        match self {
            Active::Mysql(d) => d.schema_columns(database).await,
            Active::Postgres(d) => d.schema_columns(database).await,
            Active::Sqlite(d) => d.schema_columns(database).await,
            Active::Mongo(d) => d.schema_columns(database).await,
            Active::Redis(d) => d.schema_columns(database).await,
            Active::Mssql(d) => d.schema_columns(database).await,
            Active::Oracle(d) => d.schema_columns(database).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.schema_columns(database).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.schema_columns(database).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.schema_columns(database).await,
            Active::Dyn(d) => d.schema_columns(database).await,
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
            Active::Mssql(d) => d.table_data(database, table, query).await,
            Active::Oracle(d) => d.table_data(database, table, query).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.table_data(database, table, query).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.table_data(database, table, query).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.table_data(database, table, query).await,
            Active::Dyn(d) => d.table_data(database, table, query).await,
        }
    }
    /// 查詢並截斷於 cap（0 = 不限）。Dyn（外部 gateway）走 trait 預設實作（不截斷）。
    async fn query_capped(&self, sql: &str, cap: usize) -> AppResult<QueryResult> {
        match self {
            Active::Mysql(d) => d.query_capped(sql, cap).await,
            Active::Postgres(d) => d.query_capped(sql, cap).await,
            Active::Sqlite(d) => d.query_capped(sql, cap).await,
            Active::Mongo(d) => d.query_capped(sql, cap).await,
            Active::Redis(d) => d.query_capped(sql, cap).await,
            Active::Mssql(d) => d.query_capped(sql, cap).await,
            Active::Oracle(d) => d.query_capped(sql, cap).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.query_capped(sql, cap).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.query_capped(sql, cap).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.query_capped(sql, cap).await,
            Active::Dyn(d) => d.query_capped(sql, cap).await,
        }
    }
    /// 多結果集查詢（每集各自截斷於 cap）。未覆寫的驅動走 trait 預設（單集包 Vec）。
    async fn query_multi_capped(&self, sql: &str, cap: usize) -> AppResult<Vec<QueryResult>> {
        match self {
            Active::Mysql(d) => d.query_multi_capped(sql, cap).await,
            Active::Postgres(d) => d.query_multi_capped(sql, cap).await,
            Active::Sqlite(d) => d.query_multi_capped(sql, cap).await,
            Active::Mongo(d) => d.query_multi_capped(sql, cap).await,
            Active::Redis(d) => d.query_multi_capped(sql, cap).await,
            Active::Mssql(d) => d.query_multi_capped(sql, cap).await,
            Active::Oracle(d) => d.query_multi_capped(sql, cap).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.query_multi_capped(sql, cap).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.query_multi_capped(sql, cap).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.query_multi_capped(sql, cap).await,
            Active::Dyn(d) => d.query_multi_capped(sql, cap).await,
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
            Active::Mssql(d) => d.update_cell(database, table, edit).await,
            Active::Oracle(d) => d.update_cell(database, table, edit).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.update_cell(database, table, edit).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.update_cell(database, table, edit).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.update_cell(database, table, edit).await,
            Active::Dyn(d) => d.update_cell(database, table, edit).await,
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
            Active::Mssql(d) => d.insert_row(database, table, row).await,
            Active::Oracle(d) => d.insert_row(database, table, row).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.insert_row(database, table, row).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.insert_row(database, table, row).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.insert_row(database, table, row).await,
            Active::Dyn(d) => d.insert_row(database, table, row).await,
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
            Active::Mssql(d) => d.delete_row(database, table, del).await,
            Active::Oracle(d) => d.delete_row(database, table, del).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.delete_row(database, table, del).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.delete_row(database, table, del).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.delete_row(database, table, del).await,
            Active::Dyn(d) => d.delete_row(database, table, del).await,
        }
    }
    fn pool_status(&self) -> PoolStatus {
        match self {
            Active::Mysql(d) => d.pool_status(),
            Active::Postgres(d) => d.pool_status(),
            Active::Sqlite(d) => d.pool_status(),
            Active::Mongo(d) => d.pool_status(),
            Active::Redis(d) => d.pool_status(),
            Active::Mssql(d) => d.pool_status(),
            Active::Oracle(d) => d.pool_status(),
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.pool_status(),
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.pool_status(),
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.pool_status(),
            Active::Dyn(d) => d.pool_status(),
        }
    }
    async fn key_detail(&self, database: &str, key: &str) -> AppResult<Option<KeyDetail>> {
        match self {
            Active::Mysql(d) => d.key_detail(database, key).await,
            Active::Postgres(d) => d.key_detail(database, key).await,
            Active::Sqlite(d) => d.key_detail(database, key).await,
            Active::Mongo(d) => d.key_detail(database, key).await,
            Active::Redis(d) => d.key_detail(database, key).await,
            Active::Mssql(d) => d.key_detail(database, key).await,
            Active::Oracle(d) => d.key_detail(database, key).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.key_detail(database, key).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.key_detail(database, key).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.key_detail(database, key).await,
            Active::Dyn(d) => d.key_detail(database, key).await,
        }
    }
    async fn key_edit(&self, database: &str, key: &str, edit: &KeyEdit) -> AppResult<u64> {
        match self {
            Active::Mysql(d) => d.key_edit(database, key, edit).await,
            Active::Postgres(d) => d.key_edit(database, key, edit).await,
            Active::Sqlite(d) => d.key_edit(database, key, edit).await,
            Active::Mongo(d) => d.key_edit(database, key, edit).await,
            Active::Redis(d) => d.key_edit(database, key, edit).await,
            Active::Mssql(d) => d.key_edit(database, key, edit).await,
            Active::Oracle(d) => d.key_edit(database, key, edit).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.key_edit(database, key, edit).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.key_edit(database, key, edit).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.key_edit(database, key, edit).await,
            Active::Dyn(d) => d.key_edit(database, key, edit).await,
        }
    }
    async fn explain(&self, sql: &str) -> AppResult<QueryResult> {
        match self {
            Active::Mysql(d) => d.explain(sql).await,
            Active::Postgres(d) => d.explain(sql).await,
            Active::Sqlite(d) => d.explain(sql).await,
            Active::Mongo(d) => d.explain(sql).await,
            Active::Redis(d) => d.explain(sql).await,
            Active::Mssql(d) => d.explain(sql).await,
            Active::Oracle(d) => d.explain(sql).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.explain(sql).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.explain(sql).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.explain(sql).await,
            Active::Dyn(d) => d.explain(sql).await,
        }
    }
    async fn column_stats(&self, database: &str, table: &str, column: &str) -> AppResult<ColumnStats> {
        match self {
            Active::Mysql(d) => d.column_stats(database, table, column).await,
            Active::Postgres(d) => d.column_stats(database, table, column).await,
            Active::Sqlite(d) => d.column_stats(database, table, column).await,
            Active::Mongo(d) => d.column_stats(database, table, column).await,
            Active::Redis(d) => d.column_stats(database, table, column).await,
            Active::Mssql(d) => d.column_stats(database, table, column).await,
            Active::Oracle(d) => d.column_stats(database, table, column).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.column_stats(database, table, column).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.column_stats(database, table, column).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.column_stats(database, table, column).await,
            Active::Dyn(d) => d.column_stats(database, table, column).await,
        }
    }
    async fn table_info(&self, database: &str, table: &str) -> AppResult<Vec<(String, String)>> {
        match self {
            Active::Mysql(d) => d.table_info(database, table).await,
            Active::Postgres(d) => d.table_info(database, table).await,
            Active::Sqlite(d) => d.table_info(database, table).await,
            Active::Mongo(d) => d.table_info(database, table).await,
            Active::Redis(d) => d.table_info(database, table).await,
            Active::Mssql(d) => d.table_info(database, table).await,
            Active::Oracle(d) => d.table_info(database, table).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.table_info(database, table).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.table_info(database, table).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.table_info(database, table).await,
            Active::Dyn(d) => d.table_info(database, table).await,
        }
    }
    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        match self {
            Active::Mysql(d) => d.list_foreign_keys(database, table).await,
            Active::Postgres(d) => d.list_foreign_keys(database, table).await,
            Active::Sqlite(d) => d.list_foreign_keys(database, table).await,
            Active::Mongo(d) => d.list_foreign_keys(database, table).await,
            Active::Redis(d) => d.list_foreign_keys(database, table).await,
            Active::Mssql(d) => d.list_foreign_keys(database, table).await,
            Active::Oracle(d) => d.list_foreign_keys(database, table).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.list_foreign_keys(database, table).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.list_foreign_keys(database, table).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.list_foreign_keys(database, table).await,
            Active::Dyn(d) => d.list_foreign_keys(database, table).await,
        }
    }
    async fn create_collection(&self, database: &str, name: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.create_collection(database, name).await,
            Active::Postgres(d) => d.create_collection(database, name).await,
            Active::Sqlite(d) => d.create_collection(database, name).await,
            Active::Mongo(d) => d.create_collection(database, name).await,
            Active::Redis(d) => d.create_collection(database, name).await,
            Active::Mssql(d) => d.create_collection(database, name).await,
            Active::Oracle(d) => d.create_collection(database, name).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.create_collection(database, name).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.create_collection(database, name).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.create_collection(database, name).await,
            Active::Dyn(d) => d.create_collection(database, name).await,
        }
    }
    async fn create_database(&self, name: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.create_database(name).await,
            Active::Postgres(d) => d.create_database(name).await,
            Active::Sqlite(d) => d.create_database(name).await,
            Active::Mongo(d) => d.create_database(name).await,
            Active::Redis(d) => d.create_database(name).await,
            Active::Mssql(d) => d.create_database(name).await,
            Active::Oracle(d) => d.create_database(name).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.create_database(name).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.create_database(name).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.create_database(name).await,
            Active::Dyn(d) => d.create_database(name).await,
        }
    }
    async fn drop_collection(&self, database: &str, name: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.drop_collection(database, name).await,
            Active::Postgres(d) => d.drop_collection(database, name).await,
            Active::Sqlite(d) => d.drop_collection(database, name).await,
            Active::Mongo(d) => d.drop_collection(database, name).await,
            Active::Redis(d) => d.drop_collection(database, name).await,
            Active::Mssql(d) => d.drop_collection(database, name).await,
            Active::Oracle(d) => d.drop_collection(database, name).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.drop_collection(database, name).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.drop_collection(database, name).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.drop_collection(database, name).await,
            Active::Dyn(d) => d.drop_collection(database, name).await,
        }
    }
    async fn drop_database(&self, name: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.drop_database(name).await,
            Active::Postgres(d) => d.drop_database(name).await,
            Active::Sqlite(d) => d.drop_database(name).await,
            Active::Mongo(d) => d.drop_database(name).await,
            Active::Redis(d) => d.drop_database(name).await,
            Active::Mssql(d) => d.drop_database(name).await,
            Active::Oracle(d) => d.drop_database(name).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.drop_database(name).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.drop_database(name).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.drop_database(name).await,
            Active::Dyn(d) => d.drop_database(name).await,
        }
    }
    async fn list_routines(&self, database: &str) -> AppResult<Vec<RoutineInfo>> {
        match self {
            Active::Mysql(d) => d.list_routines(database).await,
            Active::Postgres(d) => d.list_routines(database).await,
            Active::Sqlite(d) => d.list_routines(database).await,
            Active::Mongo(d) => d.list_routines(database).await,
            Active::Redis(d) => d.list_routines(database).await,
            Active::Mssql(d) => d.list_routines(database).await,
            Active::Oracle(d) => d.list_routines(database).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.list_routines(database).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.list_routines(database).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.list_routines(database).await,
            Active::Dyn(d) => d.list_routines(database).await,
        }
    }
    async fn routine_definition(&self, database: &str, name: &str, routine_type: &str) -> AppResult<String> {
        match self {
            Active::Mysql(d) => d.routine_definition(database, name, routine_type).await,
            Active::Postgres(d) => d.routine_definition(database, name, routine_type).await,
            Active::Sqlite(d) => d.routine_definition(database, name, routine_type).await,
            Active::Mongo(d) => d.routine_definition(database, name, routine_type).await,
            Active::Redis(d) => d.routine_definition(database, name, routine_type).await,
            Active::Mssql(d) => d.routine_definition(database, name, routine_type).await,
            Active::Oracle(d) => d.routine_definition(database, name, routine_type).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.routine_definition(database, name, routine_type).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.routine_definition(database, name, routine_type).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.routine_definition(database, name, routine_type).await,
            Active::Dyn(d) => d.routine_definition(database, name, routine_type).await,
        }
    }
    async fn search_objects(&self, opts: &SearchOptions) -> AppResult<Vec<SearchHit>> {
        match self {
            Active::Mysql(d) => d.search_objects(opts).await,
            Active::Postgres(d) => d.search_objects(opts).await,
            Active::Sqlite(d) => d.search_objects(opts).await,
            Active::Mongo(d) => d.search_objects(opts).await,
            Active::Redis(d) => d.search_objects(opts).await,
            Active::Mssql(d) => d.search_objects(opts).await,
            Active::Oracle(d) => d.search_objects(opts).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.search_objects(opts).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.search_objects(opts).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.search_objects(opts).await,
            Active::Dyn(d) => d.search_objects(opts).await,
        }
    }
    async fn exec_ddl(&self, sql: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.exec_ddl(sql).await,
            Active::Postgres(d) => d.exec_ddl(sql).await,
            Active::Sqlite(d) => d.exec_ddl(sql).await,
            Active::Mongo(d) => d.exec_ddl(sql).await,
            Active::Redis(d) => d.exec_ddl(sql).await,
            Active::Mssql(d) => d.exec_ddl(sql).await,
            Active::Oracle(d) => d.exec_ddl(sql).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.exec_ddl(sql).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.exec_ddl(sql).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.exec_ddl(sql).await,
            Active::Dyn(d) => d.exec_ddl(sql).await,
        }
    }
    async fn validate_ddl(&self, database: &str, sql: &str) -> AppResult<ValidationReport> {
        match self {
            Active::Mysql(d) => d.validate_ddl(database, sql).await,
            Active::Postgres(d) => d.validate_ddl(database, sql).await,
            Active::Sqlite(d) => d.validate_ddl(database, sql).await,
            Active::Mongo(d) => d.validate_ddl(database, sql).await,
            Active::Redis(d) => d.validate_ddl(database, sql).await,
            Active::Mssql(d) => d.validate_ddl(database, sql).await,
            Active::Oracle(d) => d.validate_ddl(database, sql).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.validate_ddl(database, sql).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.validate_ddl(database, sql).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.validate_ddl(database, sql).await,
            Active::Dyn(d) => d.validate_ddl(database, sql).await,
        }
    }
    async fn alter_table(&self, database: &str, table: &str, op: &AlterOp) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.alter_table(database, table, op).await,
            Active::Postgres(d) => d.alter_table(database, table, op).await,
            Active::Sqlite(d) => d.alter_table(database, table, op).await,
            Active::Mongo(d) => d.alter_table(database, table, op).await,
            Active::Redis(d) => d.alter_table(database, table, op).await,
            Active::Mssql(d) => d.alter_table(database, table, op).await,
            Active::Oracle(d) => d.alter_table(database, table, op).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.alter_table(database, table, op).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.alter_table(database, table, op).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.alter_table(database, table, op).await,
            Active::Dyn(d) => d.alter_table(database, table, op).await,
        }
    }
    async fn er_model(&self, database: &str) -> AppResult<ErModel> {
        match self {
            Active::Mysql(d) => d.er_model(database).await,
            Active::Postgres(d) => d.er_model(database).await,
            Active::Sqlite(d) => d.er_model(database).await,
            Active::Mongo(d) => d.er_model(database).await,
            Active::Redis(d) => d.er_model(database).await,
            Active::Mssql(d) => d.er_model(database).await,
            Active::Oracle(d) => d.er_model(database).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.er_model(database).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.er_model(database).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.er_model(database).await,
            Active::Dyn(d) => d.er_model(database).await,
        }
    }
    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        match self {
            Active::Mysql(d) => d.table_ddl(database, table).await,
            Active::Postgres(d) => d.table_ddl(database, table).await,
            Active::Sqlite(d) => d.table_ddl(database, table).await,
            Active::Mongo(d) => d.table_ddl(database, table).await,
            Active::Redis(d) => d.table_ddl(database, table).await,
            Active::Mssql(d) => d.table_ddl(database, table).await,
            Active::Oracle(d) => d.table_ddl(database, table).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.table_ddl(database, table).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.table_ddl(database, table).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.table_ddl(database, table).await,
            Active::Dyn(d) => d.table_ddl(database, table).await,
        }
    }
    async fn table_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        match self {
            Active::Mysql(d) => d.table_indexes(database, table).await,
            Active::Postgres(d) => d.table_indexes(database, table).await,
            Active::Sqlite(d) => d.table_indexes(database, table).await,
            Active::Mongo(d) => d.table_indexes(database, table).await,
            Active::Redis(d) => d.table_indexes(database, table).await,
            Active::Mssql(d) => d.table_indexes(database, table).await,
            Active::Oracle(d) => d.table_indexes(database, table).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.table_indexes(database, table).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.table_indexes(database, table).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.table_indexes(database, table).await,
            Active::Dyn(d) => d.table_indexes(database, table).await,
        }
    }
    async fn drop_index(&self, database: &str, table: &str, index: &str) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.drop_index(database, table, index).await,
            Active::Postgres(d) => d.drop_index(database, table, index).await,
            Active::Sqlite(d) => d.drop_index(database, table, index).await,
            Active::Mongo(d) => d.drop_index(database, table, index).await,
            Active::Redis(d) => d.drop_index(database, table, index).await,
            Active::Mssql(d) => d.drop_index(database, table, index).await,
            Active::Oracle(d) => d.drop_index(database, table, index).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.drop_index(database, table, index).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.drop_index(database, table, index).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.drop_index(database, table, index).await,
            Active::Dyn(d) => d.drop_index(database, table, index).await,
        }
    }
    async fn create_index(&self, database: &str, table: &str, name: &str, columns: &[String], unique: bool) -> AppResult<()> {
        match self {
            Active::Mysql(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Postgres(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Sqlite(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Mongo(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Redis(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Mssql(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Oracle(d) => d.create_index(database, table, name, columns, unique).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.create_index(database, table, name, columns, unique).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.create_index(database, table, name, columns, unique).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.create_index(database, table, name, columns, unique).await,
            Active::Dyn(d) => d.create_index(database, table, name, columns, unique).await,
        }
    }
    async fn server_info(&self) -> AppResult<Vec<ServerInfoSection>> {
        match self {
            Active::Mysql(d) => d.server_info().await,
            Active::Postgres(d) => d.server_info().await,
            Active::Sqlite(d) => d.server_info().await,
            Active::Mongo(d) => d.server_info().await,
            Active::Redis(d) => d.server_info().await,
            Active::Mssql(d) => d.server_info().await,
            Active::Oracle(d) => d.server_info().await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.server_info().await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.server_info().await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.server_info().await,
            Active::Dyn(d) => d.server_info().await,
        }
    }
    async fn scan_keys(&self, database: &str, pattern: &str, limit: usize) -> AppResult<RedisKeys> {
        match self {
            Active::Mysql(d) => d.scan_keys(database, pattern, limit).await,
            Active::Postgres(d) => d.scan_keys(database, pattern, limit).await,
            Active::Sqlite(d) => d.scan_keys(database, pattern, limit).await,
            Active::Mongo(d) => d.scan_keys(database, pattern, limit).await,
            Active::Redis(d) => d.scan_keys(database, pattern, limit).await,
            Active::Mssql(d) => d.scan_keys(database, pattern, limit).await,
            Active::Oracle(d) => d.scan_keys(database, pattern, limit).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.scan_keys(database, pattern, limit).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.scan_keys(database, pattern, limit).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.scan_keys(database, pattern, limit).await,
            Active::Dyn(d) => d.scan_keys(database, pattern, limit).await,
        }
    }
    async fn document_get(&self, database: &str, table: &str, id: &str) -> AppResult<String> {
        match self {
            Active::Mysql(d) => d.document_get(database, table, id).await,
            Active::Postgres(d) => d.document_get(database, table, id).await,
            Active::Sqlite(d) => d.document_get(database, table, id).await,
            Active::Mongo(d) => d.document_get(database, table, id).await,
            Active::Redis(d) => d.document_get(database, table, id).await,
            Active::Mssql(d) => d.document_get(database, table, id).await,
            Active::Oracle(d) => d.document_get(database, table, id).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.document_get(database, table, id).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.document_get(database, table, id).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.document_get(database, table, id).await,
            Active::Dyn(d) => d.document_get(database, table, id).await,
        }
    }
    async fn document_replace(&self, database: &str, table: &str, id: &str, doc_json: &str) -> AppResult<u64> {
        match self {
            Active::Mysql(d) => d.document_replace(database, table, id, doc_json).await,
            Active::Postgres(d) => d.document_replace(database, table, id, doc_json).await,
            Active::Sqlite(d) => d.document_replace(database, table, id, doc_json).await,
            Active::Mongo(d) => d.document_replace(database, table, id, doc_json).await,
            Active::Redis(d) => d.document_replace(database, table, id, doc_json).await,
            Active::Mssql(d) => d.document_replace(database, table, id, doc_json).await,
            Active::Oracle(d) => d.document_replace(database, table, id, doc_json).await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.document_replace(database, table, id, doc_json).await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.document_replace(database, table, id, doc_json).await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.document_replace(database, table, id, doc_json).await,
            Active::Dyn(d) => d.document_replace(database, table, id, doc_json).await,
        }
    }
    async fn clear_cache(&self) {
        match self {
            Active::Mysql(d) => d.clear_cache().await,
            Active::Postgres(d) => d.clear_cache().await,
            Active::Sqlite(d) => d.clear_cache().await,
            Active::Mongo(d) => d.clear_cache().await,
            Active::Redis(d) => d.clear_cache().await,
            Active::Mssql(d) => d.clear_cache().await,
            Active::Oracle(d) => d.clear_cache().await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.clear_cache().await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.clear_cache().await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.clear_cache().await,
            Active::Dyn(d) => d.clear_cache().await,
        }
    }
    async fn close(&self) {
        match self {
            Active::Mysql(d) => d.close().await,
            Active::Postgres(d) => d.close().await,
            Active::Sqlite(d) => d.close().await,
            Active::Mongo(d) => d.close().await,
            Active::Redis(d) => d.close().await,
            Active::Mssql(d) => d.close().await,
            Active::Oracle(d) => d.close().await,
            #[cfg(feature = "kafka")]
            Active::Kafka(d) => d.close().await,
            #[cfg(feature = "rabbitmq")]
            Active::RabbitMq(d) => d.close().await,
            #[cfg(feature = "elastic")]
            Active::Elastic(d) => d.close().await,
            Active::Dyn(d) => d.close().await,
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
        if cfg.ssh_enabled && !matches!(cfg.kind, DbKind::Sqlite | DbKind::External) {
            let guard = crate::ssh::open_tunnel(&cfg).await?;
            cfg.host = "127.0.0.1".to_string();
            cfg.port = guard.local_port();
            tunnel = Some(guard);
        }

        let built = match cfg.kind {
            // MariaDB 線協定相容，共用 MysqlDriver（Active::Mysql；kind() 塌陷成 mysql 正合
            // transfer 同類型 gate 的預期——兩者 DDL 相容可互轉）。
            DbKind::Mysql | DbKind::Mariadb => MysqlDriver::connect(&cfg).await.map(|d| Active::Mysql(Arc::new(d))),
            DbKind::Sqlite => {
                SqliteDriver::connect(&cfg).await.map(|d| Active::Sqlite(Arc::new(d)))
            }
            DbKind::Postgres => {
                PostgresDriver::connect(&cfg).await.map(|d| Active::Postgres(Arc::new(d)))
            }
            DbKind::Mongo => MongoDriver::connect(&cfg).await.map(|d| Active::Mongo(Arc::new(d))),
            DbKind::Redis => RedisDriver::connect(&cfg).await.map(|d| Active::Redis(Arc::new(d))),
            DbKind::Mssql => MssqlDriver::connect(&cfg).await.map(|d| Active::Mssql(Arc::new(d))),
            DbKind::Oracle => OracleDriver::connect(&cfg).await.map(|d| Active::Oracle(Arc::new(d))),
            // Kafka：具體驅動於 `kafka` feature 開啟時編入；未編入時回 Unsupported。
            #[cfg(feature = "kafka")]
            DbKind::Kafka => KafkaDriver::connect(&cfg).await.map(|d| Active::Kafka(Arc::new(d))),
            #[cfg(not(feature = "kafka"))]
            DbKind::Kafka => Err(AppError::Unsupported(
                t!("此版本未編入 Kafka 支援（請以 --features kafka 建置）").into(),
            )),
            // Elasticsearch / OpenSearch：具體驅動於 `elastic` feature 開啟時編入；未編入時回 Unsupported。
            #[cfg(feature = "elastic")]
            DbKind::Elastic => ElasticDriver::connect(&cfg).await.map(|d| Active::Elastic(Arc::new(d))),
            #[cfg(not(feature = "elastic"))]
            DbKind::Elastic => Err(AppError::Unsupported(
                t!("此版本未編入 Elasticsearch 支援（請以 --features elastic 建置）").into(),
            )),
            // RabbitMQ：具體驅動於 `rabbitmq` feature 開啟時編入；未編入時回 Unsupported。
            #[cfg(feature = "rabbitmq")]
            DbKind::RabbitMq => RabbitMqDriver::connect(&cfg).await.map(|d| Active::RabbitMq(Arc::new(d))),
            #[cfg(not(feature = "rabbitmq"))]
            DbKind::RabbitMq => Err(AppError::Unsupported(
                t!("此版本未編入 RabbitMQ 支援（請以 --features rabbitmq 建置）").into(),
            )),
            DbKind::External => crate::db::external::connect_external(&cfg).await.map(Active::Dyn),
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
        if cfg.ssh_enabled && !matches!(cfg.kind, DbKind::Sqlite | DbKind::External) {
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
            DbKind::Mysql | DbKind::Mariadb => {
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
            DbKind::Mssql => {
                let driver = MssqlDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
            DbKind::Oracle => {
                let driver = OracleDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
            #[cfg(feature = "kafka")]
            DbKind::Kafka => {
                let driver = KafkaDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
            #[cfg(not(feature = "kafka"))]
            DbKind::Kafka => Err(AppError::Unsupported(
                t!("此版本未編入 Kafka 支援（請以 --features kafka 建置）").into(),
            )),
            #[cfg(feature = "elastic")]
            DbKind::Elastic => {
                let driver = ElasticDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
            #[cfg(not(feature = "elastic"))]
            DbKind::Elastic => Err(AppError::Unsupported(
                t!("此版本未編入 Elasticsearch 支援（請以 --features elastic 建置）").into(),
            )),
            #[cfg(feature = "rabbitmq")]
            DbKind::RabbitMq => {
                let driver = RabbitMqDriver::connect(config).await?;
                driver.ping().await?;
                driver.close().await;
                Ok(())
            }
            #[cfg(not(feature = "rabbitmq"))]
            DbKind::RabbitMq => Err(AppError::Unsupported(
                t!("此版本未編入 RabbitMQ 支援（請以 --features rabbitmq 建置）").into(),
            )),
            DbKind::External => {
                let d = crate::db::external::connect_external(config).await?;
                d.ping().await?;
                d.close().await;
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

    /// 連線的資料庫種類（供資料傳輸判斷同類型）。
    pub fn kind(&self, id: &str) -> AppResult<DbKind> {
        Ok(self.get(id)?.active.kind())
    }

    pub async fn table_columns(
        &self,
        id: &str,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        self.get(id)?.active.table_columns(database, table).await
    }

    pub async fn schema_columns(&self, id: &str, database: &str) -> AppResult<Vec<TableColumns>> {
        self.get(id)?.active.schema_columns(database).await
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

    /// 互動查詢入口（run_query）：套用全域 row cap，外層以 tokio timeout 兜底（0 = 關閉）。
    /// 逾時語意：本端 future 被放棄，sqlx 於連線回池時偵測髒狀態並汰換（before_acquire 健檢
    /// 為雙保險）；**伺服器端查詢可能仍在執行**，錯誤訊息引導使用者以行程清單手動 KILL。
    pub async fn query(&self, id: &str, sql: &str) -> AppResult<QueryResult> {
        let ms = crate::db::limits::timeout_ms();
        let fut = self.query_capped(id, sql, crate::db::limits::row_cap());
        if ms == 0 {
            return fut.await;
        }
        match tokio::time::timeout(std::time::Duration::from_millis(ms), fut).await {
            Ok(r) => r,
            Err(_) => Err(AppError::Timeout(ms)),
        }
    }

    /// 查詢並截斷於 cap（0 = 不限）。批次路徑（匯出 / CLI）用：不套互動逾時
    ///（DB 端 session timeout 若已啟用仍會生效，屬使用者的全域選擇）。
    pub async fn query_capped(&self, id: &str, sql: &str, cap: usize) -> AppResult<QueryResult> {
        self.get(id)?.active.query_capped(sql, cap).await
    }

    /// 互動多結果集查詢（run_query_multi）：全域 row cap（每集各自截斷）+ tokio timeout 兜底，
    /// 逾時語意同 query()。未覆寫 query_multi_capped 的驅動回單元素 Vec，行為與 query() 等價。
    pub async fn query_multi(&self, id: &str, sql: &str) -> AppResult<Vec<QueryResult>> {
        let ms = crate::db::limits::timeout_ms();
        let fut = self.query_multi_capped(id, sql, crate::db::limits::row_cap());
        if ms == 0 {
            return fut.await;
        }
        match tokio::time::timeout(std::time::Duration::from_millis(ms), fut).await {
            Ok(r) => r,
            Err(_) => Err(AppError::Timeout(ms)),
        }
    }

    /// 多結果集查詢並將每集各自截斷於 cap（0 = 不限）。
    pub async fn query_multi_capped(
        &self,
        id: &str,
        sql: &str,
        cap: usize,
    ) -> AppResult<Vec<QueryResult>> {
        self.get(id)?.active.query_multi_capped(sql, cap).await
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

    pub async fn list_foreign_keys(&self, id: &str, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        self.get(id)?.active.list_foreign_keys(database, table).await
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

    pub async fn search_objects(&self, id: &str, opts: &SearchOptions) -> AppResult<Vec<SearchHit>> {
        self.get(id)?.active.search_objects(opts).await
    }

    pub async fn exec_ddl(&self, id: &str, sql: &str) -> AppResult<()> {
        self.get(id)?.active.exec_ddl(sql).await
    }

    pub async fn validate_ddl(&self, id: &str, database: &str, sql: &str) -> AppResult<ValidationReport> {
        self.get(id)?.active.validate_ddl(database, sql).await
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

    pub async fn scan_keys(
        &self,
        id: &str,
        database: &str,
        pattern: &str,
        limit: usize,
    ) -> AppResult<RedisKeys> {
        self.get(id)?.active.scan_keys(database, pattern, limit).await
    }

    pub async fn document_get(&self, id: &str, database: &str, table: &str, doc_id: &str) -> AppResult<String> {
        self.get(id)?.active.document_get(database, table, doc_id).await
    }

    pub async fn document_replace(
        &self,
        id: &str,
        database: &str,
        table: &str,
        doc_id: &str,
        doc_json: &str,
    ) -> AppResult<u64> {
        self.get(id)?.active.document_replace(database, table, doc_id, doc_json).await
    }

    /// 取得 Redis driver 本體，供 Redis 專屬命令直接呼叫其 inherent 方法
    /// （成員分頁 / SLOWLOG / CLIENT / 大鍵 / Pub-Sub），不必擴充 DatabaseDriver trait。
    /// 非 Redis 連線回 Unsupported。
    pub fn redis_driver(&self, id: &str) -> AppResult<Arc<RedisDriver>> {
        match &self.get(id)?.active {
            Active::Redis(d) => Ok(d.clone()),
            _ => Err(AppError::Unsupported(t!("此連線不是 Redis").into())),
        }
    }

    /// 取得 Mongo driver 本體，供 Mongo 專屬命令直接呼叫其 inherent 方法
    /// （$indexStats / validation / dbStats / currentOp / profiler），不必擴充 DatabaseDriver trait。
    /// 非 Mongo 連線回 Unsupported。
    pub fn mongo_driver(&self, id: &str) -> AppResult<Arc<MongoDriver>> {
        match &self.get(id)?.active {
            Active::Mongo(d) => Ok(d.clone()),
            _ => Err(AppError::Unsupported(t!("此連線不是 MongoDB").into())),
        }
    }

    /// 取得 Kafka driver 本體，供 `kafka_*` 專屬命令呼叫其 inherent 方法
    /// （topics / consume / produce / groups / admin / schema），不必擴充 DatabaseDriver trait。
    /// 非 Kafka 連線回 Unsupported。
    #[cfg(feature = "kafka")]
    pub fn kafka_driver(&self, id: &str) -> AppResult<Arc<KafkaDriver>> {
        match &self.get(id)?.active {
            Active::Kafka(d) => Ok(d.clone()),
            _ => Err(AppError::Unsupported(t!("此連線不是 Kafka").into())),
        }
    }

    /// 取得 Elasticsearch / OpenSearch driver 本體，供 `es_*` 專屬命令呼叫其 inherent 方法
    /// （cluster_health / indices / nodes / mapping / delete_index），不必擴充 DatabaseDriver trait。
    /// 非 Elasticsearch 連線回 Unsupported。
    #[cfg(feature = "elastic")]
    pub fn elastic_driver(&self, id: &str) -> AppResult<Arc<ElasticDriver>> {
        match &self.get(id)?.active {
            Active::Elastic(d) => Ok(d.clone()),
            _ => Err(AppError::Unsupported(t!("此連線不是 Elasticsearch").into())),
        }
    }

    /// 取得 RabbitMQ driver 本體，供 `rabbitmq_*` 專屬命令呼叫其 inherent 方法
    /// （peek / publish / delete_queue）。非 RabbitMQ 連線回 Unsupported。
    #[cfg(feature = "rabbitmq")]
    pub fn rabbitmq_driver(&self, id: &str) -> AppResult<Arc<RabbitMqDriver>> {
        match &self.get(id)?.active {
            Active::RabbitMq(d) => Ok(d.clone()),
            _ => Err(AppError::Unsupported(t!("此連線不是 RabbitMQ").into())),
        }
    }

    /// 清除指定連線驅動的查詢快取（供前端「重新整理」強制重抓，而非吃快取）。
    /// 找不到連線時靜默忽略（未連線本就無快取）。
    pub async fn clear_cache(&self, id: &str) -> AppResult<()> {
        if let Ok(live) = self.get(id) {
            live.active.clear_cache().await;
        }
        Ok(())
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
