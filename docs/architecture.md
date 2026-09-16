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

## 審查並執行：寫入前的安全網

`review_run/` 讓「跑一份會改資料的腳本」在執行前留下可以還原的東西。它刻意不包交易：db-kit 的連線是連線池，
而使用者要的是「這句跑完之後我還回得去」，不是「整份一起成功或失敗」。規則同樣是「機制上做不到」而非「提醒使用者小心」：

| 面向 | 規則 | 落點 |
|------|------|------|
| 前像擷取 | 只送唯讀查詢；述詞是從使用者語句切出來的，送出前一律過嚴格唯讀檢查 | `capture::guard_read_only` → `cli::guard::read_only_violation(strict_explain=true)` |
| 擷取時機 | **逐句**：執行第 N 句之前才抓第 N 句的前像，並重新探測（前一句可能建了表、改了結構） | `run::run` → `plan::probe_statement` |
| 值的保真 | 不走顯示用的 `cell_to_string`（會截斷二進位 / CLOB）；每欄依方言與型別改寫成可無損往返的運算式，並成對定義還原字面值；做不到無損的值讓該列回滾被註解掉，不寫 NULL | `codec::select_expr` / `codec::literal` / `codec::restorable` |
| 回滾落地 | 每句執行**前**先把涵蓋到這句的 `rollback.sql` 寫進輸出目錄（暫存檔 + rename） | `run::Out::write` |
| 不確定的回滾 | 以註解輸出並寫明原因（UPDATE 後依原鍵找不到的列、無鍵表的修改、自動編號 INSERT 數量對不上…） | `rollback::Line::Disabled` |
| 擋下整份腳本 | 交易控制、session 狀態（USE / SET / DECLARE / 暫存表 / LOCK）、非 PG 程序本體、DROP DATABASE、未代入參數；例外是回滾腳本自己產生的檔頭 SET 與 SQL Server identity 批次 | `analyze::Issue::is_blocker` |
| 需要確認 | 回滾等級不是「完整」、正式環境連線；擷取時才發現超過上限或等級變差，停在那一句之前 | `RunOptions::allow_incomplete` / `confirm_prod`；CLI 為 `--allow-incomplete` / `--allow-prod` |
| AI | 提示在後端組（GUI 與 `dbk run --review-cmd` 同一份），預設不含任何資料列；模式 `review` 零工具、單回合、不落地對話歷史 | `report::build_review_prompt`、`agent::is_one_shot_mode` |

DDL 的回滾沿用 `compare/` 的結構擷取與同步 DDL 產生器（讓「執行後」變回「執行前」），資料部分再依主鍵比對前後整表寫回。

## AI 助手的工具邊界

助手可以自己讀資料庫，因此界線必須是「機制上做不到」而非「提示裡請它不要」——模型被繞過的方式太多。

| 面向 | 規則 | 落點 |
|------|------|------|
| 資料庫 | **一律唯讀**，與助手模式無關 | `dbtools::ensure_tool_read_only`：SQL 走 `cli::guard::read_only_violation(strict_explain=true)`（連 `EXPLAIN ANALYZE DELETE` 都擋，PG 會真的執行內層語句）；Mongo 拒絕 `$out` / `$merge`；Redis 只放行讀取類命令白名單 |
| 語句數 | 一次一條 | `guard::statement_count`；多語句要拆成多次呼叫 |
| 結果量 | 200 列 / 8 KB / 30 秒 | `dbtools` 的 `MAX_QUERY_ROWS`、`MAX_TEXT_BYTES`、`tool_timeout_ms` |
| 檔案 | 只在助手工作資料夾內，且 `agent` 模式才可寫 | `llm::tools::safe_path`（磁碟前綴 / UNC / `..` 自己判，不靠平台語意） |
| Shell / 網路 | 完全不提供 | `llm::tools` 不實作；Claude 走 `--allowedTools` 允許清單 + `--strict-mcp-config`，Codex 走 `--sandbox` |
| 稽核 | 每次工具呼叫的輸入與結果預覽都推到前端 | `llm::ToolTrace` → `agent-stream` 的 `tool` / `tool_result` 事件 → 聊天面板的「工具呼叫」清單 |
| 正式環境 | 第一次要讓助手查 prod 連線時前端先確認 | `AssistantPanel`（後端 `is_prod` 只用於調整工具說明，不阻擋） |

一次性模式（`generate` / `edit` / `review`）零工具、單回合：它們的輸出就是一段語句或一份審查報告，給工具只會讓模型多繞路。API 供應商在一次性模式下不落地對話歷史——沒有 session 可以續，而審查提示可能夾帶前像樣本資料。

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
├── transfer.rs        跨連線 / 跨庫資料傳輸
├── compare/           結構 / 資料比對引擎（GUI 與 dbk compare 共用，不依賴 Tauri）
│   ├── schema.rs      DbSchema 擷取 + 型別 / 預設值 / 定義文字正規化
│   ├── diff.rs        結構差異（表 / 欄 / 索引 / 外鍵 / 視圖 / 程序）
│   ├── ddl.rs         同步 DDL 產生（全域順序、destructive 分級、skipped）
│   ├── snapshot.rs    結構快照 JSON 存讀（壞檔即失敗）
│   ├── normalize.rs   跨引擎值正規化（數值 / 布林 / 日期 / JSON）
│   ├── rowstream.rs   主鍵排序分頁串流（keyset / offset）
│   ├── merge.rs       merge-join（順序守衛）/ hash_diff
│   └── data.rs        單表 / 整庫資料比對編排、DML spool 與分批交易套用
├── review_run/        審查並執行（GUI 與 dbk run 共用，不依賴 Tauri）
│   ├── scan.rs        位移保留式 SQL 遮罩 + 語句切分（含 SQL Server GO）
│   ├── names.rs       表參照解析（引號 / 大小寫折疊 / 別名）
│   ├── analyze.rs     逐句靜態分析：目標、WHERE、擷取計畫、阻擋理由
│   ├── plan.rs        探測：解析表 / 鍵 / 估列數，決定擷取策略與回滾等級
│   ├── codec.rs       依方言與型別的無損取值運算式 ↔ 還原字面值
│   ├── capture.rs     執行脈絡、表結構與鍵、依述詞 / 鍵 / 整表抓列、結構快照
│   ├── rollback.rs    前後像比對與反向語句（DELETE → UPDATE → INSERT）
│   ├── report.rs      AI 審查提示、report.md / diff.md / manifest
│   └── run.rs         編排：逐句前像 → 回滾落地 → 執行 → 後像 → 輸出目錄
├── agent.rs           AI 助手（四種供應商共用一組 agent-stream 事件；CLI 走子程序 + dbk mcp、API 走 llm/）
├── dbtools/mod.rs     AI 唯讀資料庫工具（list/describe/sample/run_query/explain）—— GUI 工具迴圈與 dbk mcp 共用
├── llm/               HTTP 供應商（Anthropic / OpenAI 相容）
│   ├── mod.rs         供應商中立的訊息 / 工具 / 串流事件模型、Base URL 正規化、金鑰解析
│   ├── anthropic.rs   /v1/messages 請求組裝與 SSE 串流
│   ├── openai.rs      /chat/completions（含相容性降級鏈）
│   ├── sse.rs         chunk 邊界安全的 SSE 行讀取
│   ├── models.rs      GET /models（順便當「測試連線」）
│   ├── tools.rs       檔案工具（限助手工作資料夾）+ 掛載 dbtools
│   ├── agent_loop.rs  工具迴圈（回合上限 / 重複呼叫中止 / 歷史修剪）
│   └── sessions.rs    對話歷史落地（<config>/llm-sessions/<id>.json，30 天 / 50 段上限）
├── it_tests.rs        Docker 真實資料庫整合測試
├── commands/mod.rs    Tauri command（薄包裝）
├── cli/               dbk CLI（args / dispatch / guard / mcp / render / resolve / run_script）
├── bin/dbk.rs         CLI binary 進入點（不連 Tauri）
└── db/
    ├── mod.rs         DbKind、共用型別、DatabaseDriver trait
    ├── sqlgen.rs      跨連線 SQL 片段（quote_ident / qualified / sql_literal / DML）—— transfer / compare / CLI 共用
    ├── mysql.rs       MySQL driver（sqlx）
    ├── postgres.rs    PostgreSQL driver（sqlx）
    ├── sqlite.rs      SQLite driver（sqlx）
    ├── mssql.rs       SQL Server driver（tiberius + bb8）
    ├── oracle.rs      Oracle driver（rust-oracle / ODPI-C；Instant Client 執行期偵測 + spawn_blocking）
    ├── mongo.rs       MongoDB driver（mongodb）
    ├── redis.rs       Redis driver（redis）
    └── external.rs    外部 web gateway 分派層（泛用擴充點）
```
