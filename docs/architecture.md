# 架構設計

## 分層

```
┌─────────────────────────────────────────────┐
│ 前端 UI 層 (React + TS)                       │
│  ┌─────────┬──────────────────────────────┐  │
│  │ 共用     │ 大圖示工具列 / 連線樹 / 主題    │  │
│  │ 分流     │ 資料檢視器 / 查詢編輯器         │  │
│  └─────────┴──────────────────────────────┘  │
├─────────────────────────────────────────────┤
│ Tauri 橋接層：command 路由 / 事件 / 進度回報    │
├─────────────────────────────────────────────┤
│ Rust 核心層                                    │
│  ┌─────────┬──────────────────────────────┐  │
│  │ 共用     │ ConnectionManager / 加密 / 排程 │  │
│  │ 分流     │ Driver 實作 / Backup Provider   │  │
│  └─────────┴──────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

共用部分（連線管理、UI 外殼、主題）統一實作；差異部分（資料操作、檢視元件）依範式分流。估計多種資料庫可共用約 60% 程式碼。

## 統一 Driver 抽象

以 Rust trait 定義統一驅動介面，用 enum 區分範式，差異吸收在 driver 層。

```rust
// src-tauri/src/db/mod.rs
pub enum DbKind {
    Mysql, Mariadb, Postgres, Sqlite, Mssql, Oracle, // 關聯式（Mariadb 為 Mysql 薄別名，共用 MysqlDriver）
    Mongo,                                           // 文件型
    Redis,                                           // 鍵值型
    External,                                        // 外部 web gateway（非真實連線；透過 HTTP 下 SQL）
}

#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> where Self: Sized;
    async fn ping(&self) -> AppResult<()>;
    async fn list_databases(&self) -> AppResult<Vec<String>>;
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>>;
    async fn table_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>>;
    async fn table_data(&self, database: &str, table: &str, page: u32, page_size: u32) -> AppResult<PagedData>;
    async fn query(&self, sql: &str) -> AppResult<QueryResult>;
    async fn update_cell(&self, database: &str, table: &str, edit: &CellEdit) -> AppResult<u64>;
    fn pool_status(&self) -> PoolStatus;
    async fn close(&self);
}
```

`ConnectionManager` 持有一個 `Active` enum（每種已連線 driver 一個 variant），對外提供統一方法，內部 `match` 分派到對應 driver。新增資料庫只需：(1) 新增 driver 檔、(2) 在 `Active` 加 variant、(3) 在 `connect`/`test` 加 match arm。

各 driver 的連線池 / 客戶端：MySQL / MariaDB / PostgreSQL / SQLite 用 **sqlx** 內建 pool（MariaDB 線協定相容，`DbKind::Mariadb` 直接建 `MysqlDriver`、`Active::Mysql`——kind 塌陷正合 transfer 同類型 gate 的預期；sqlx 另開 `tls-rustls-ring-native-roots` 支援 ssl-mode）；**SQL Server** 因 sqlx 0.8 已移除 MSSQL 支援，改用純 Rust TDS 驅動 **tiberius + bb8-tiberius** 連線池（走 futures-io，以 `tokio-util` compat 轉接到 tokio）；**Oracle** 用 **rust-oracle（ODPI-C）**——同步 API 以 `spawn_blocking` 包裝、ODPI-C 內建 session pool；為全案唯一需要原生 DLL 的例外：**Oracle Instant Client 於執行期 LoadLibrary**（偵測順序：連線 options 的 client_dir > ORACLE_HOME > PATH），不裝也能編譯 / 啟動，只有連 Oracle 時才需要（DPI-1047 時給下載指引；最低伺服器版本 12c）；MongoDB 用官方 `mongodb` client；Redis 用 `redis` connection-manager。`External` 為泛用擴充點（trait object 接入，未編入外部驅動時 `connect_external` 回 `Unsupported`）。

## 寫操作安全

`update_cell` 以主鍵定位列：

- 表無主鍵 → 拒絕更新（避免誤改多列）。
- 主鍵值含 NULL → 拒絕（無法以 `=` 安全比對）。
- 所有識別字（庫/表/欄）以對應引號包裹並轉義：MySQL / MariaDB 反引號、PG/SQLite/**Oracle** 雙引號、**SQL Server 方括號 `[…]`（`]` 以 `]]` 轉義），寫入採三部式限定 `[db].[schema].[table]`**。Oracle 採 exact-case + 全程雙引號策略（目錄查回什麼就綁什麼）。
- 值綁定：MySQL/SQLite 用 `?`、PostgreSQL 用 `$1` 參數綁定，不字串拼接。**SQL Server（tiberius）與 Oracle 目前改以字面值轉義**（單引號加倍；SQL Server 字串另包 `N'…'`；數字 / 日期以字串傳入由引擎隱式轉型），非參數綁定但同樣做逸出處理。

## 模組結構

```
src-tauri/src/
├── main.rs            程序進入點
├── lib.rs             Tauri builder、command 註冊、優雅關閉
├── error.rs           統一錯誤型別（序列化為 {kind, message}）
├── manager.rs         ConnectionManager + Active enum 分派
├── store.rs           連線設定持久化（connections.json）+ OS keychain 存取
├── conn_crypto.rs     連線設定加密 export / import
├── ssh.rs             SSH Tunnel（russh）+ host key TOFU 驗證
├── scheduler.rs       排程備份
├── backup.rs          備份 / 還原（各 DB 外部工具分派）
├── export.rs          資料匯出（CSV / TSV / Excel / JSON / SQL / Markdown）
├── import.rs          資料匯入（CSV / TSV / Excel）
├── transfer.rs        跨連線 / 跨庫資料傳輸與比對同步
├── agent.rs           AI 助手（本機 Claude CLI 串流橋接）
├── it_tests.rs        Docker 真實資料庫整合測試
├── commands/mod.rs    Tauri command（薄包裝）
├── cli/               dbk CLI（args / dispatch / guard / render / resolve）
├── bin/dbk.rs         CLI binary 進入點（不連 Tauri）
└── db/
    ├── mod.rs         DbKind、共用型別、DatabaseDriver trait
    ├── mysql.rs       MySQL driver（sqlx）
    ├── postgres.rs    PostgreSQL driver（sqlx）
    ├── sqlite.rs      SQLite driver（sqlx）
    ├── mssql.rs       SQL Server driver（tiberius + bb8）
    ├── oracle.rs      Oracle driver（rust-oracle / ODPI-C；Instant Client 執行期偵測 + spawn_blocking）
    ├── mongo.rs       MongoDB driver（mongodb）
    ├── redis.rs       Redis driver（redis）
    └── external.rs    外部 web gateway 分派層（泛用擴充點）
```
