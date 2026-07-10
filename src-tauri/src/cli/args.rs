//! CLI 參數定義（clap derive 指令樹 + 全域連線旗標）。唯讀 + 匯出範圍。

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Parser, Debug)]
#[command(
    name = "dbk",
    version,
    about = "db-kit CLI — 唯讀查詢與匯出（重用 GUI 已存連線 / 臨時連線）"
)]
pub struct Cli {
    #[command(flatten)]
    pub conn: ConnArgs,

    #[command(subcommand)]
    pub command: Command,
}

/// 全域連線與輸出旗標（flatten 到所有子指令；`global = true` 讓它們可放在子指令前後）。
#[derive(Args, Debug, Clone)]
pub struct ConnArgs {
    /// 使用已存連線（名稱或 id；讀 GUI 的 connections.json + keychain）
    #[arg(long, global = true)]
    pub conn: Option<String>,

    /// 臨時連線：資料庫種類
    #[arg(long, value_enum, global = true)]
    pub kind: Option<KindArg>,

    /// 臨時連線：主機（預設 127.0.0.1）
    #[arg(long, global = true)]
    pub host: Option<String>,

    /// 臨時連線：連接埠（預設依種類）
    #[arg(long, global = true)]
    pub port: Option<u16>,

    /// 臨時連線：帳號
    #[arg(long, global = true)]
    pub user: Option<String>,

    /// 臨時連線：密碼（亦可用環境變數 DBKIT_PASSWORD，避免出現在 argv）
    #[arg(long, env = "DBKIT_PASSWORD", global = true)]
    pub password: Option<String>,

    /// 臨時連線：連線字串 / DSN（如 mysql://user:pass@host:3306/db；sqlite 給檔案路徑）
    #[arg(long, global = true)]
    pub url: Option<String>,

    /// 預設資料庫 / schema（sqlite=檔案路徑、redis=db index）
    #[arg(short = 'd', long, global = true)]
    pub database: Option<String>,

    /// 輸出格式
    #[arg(long, value_enum, default_value = "table", global = true)]
    pub format: Format,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum KindArg {
    Mysql,
    Mariadb,
    Postgres,
    Sqlite,
    Mongo,
    Redis,
    Mssql,
    Oracle,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Table,
    Csv,
    Json,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// 連線管理（唯讀 + 加密匯出）
    #[command(subcommand)]
    Conn(ConnCmd),

    /// 列出資料庫 / schema
    #[command(subcommand)]
    Db(DbCmd),

    /// 資料表瀏覽
    #[command(subcommand)]
    Table(TableCmd),

    /// 執行查詢（唯讀；非查詢語句會被擋下）
    Query {
        sql: String,
        /// 結果列數上限（0 = 不限；預設沿用全域 1000）。截斷時於 stderr 提示。
        #[arg(long)]
        max_rows: Option<usize>,
    },

    /// 查詢計畫（EXPLAIN）
    Explain { sql: String },

    /// 欄位統計（總數 / 非空 / 相異 / 範圍）
    ColumnStats { table: String, column: String },

    /// 預存程序 / 函式 / 觸發器
    #[command(subcommand)]
    Routine(RoutineCmd),

    /// 全資料庫物件搜尋
    Search(SearchArgs),

    /// 匯出資料庫結構（所有表 DDL）
    SchemaDump,

    /// 匯出資料表資料（csv/tsv/json/sql/markdown）
    Export(ExportArgs),

    /// 備份（dump → 檔案；唯讀產出，不還原）
    Backup(BackupArgs),

    /// ER 模型（表 + 外鍵關係）
    ErModel,

    /// 伺服器資訊
    ServerInfo,

    /// Redis 唯讀操作
    #[command(subcommand)]
    Redis(RedisCmd),
}

#[derive(Subcommand, Debug)]
pub enum ConnCmd {
    /// 列出已存連線
    List,
    /// 測試連線（不保留）
    Test,
    /// Ping（量測 RTT）
    Ping,
    /// 加密匯出所有已存連線（含密碼，需 passphrase）
    Export {
        path: String,
        #[arg(long)]
        passphrase: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum DbCmd {
    /// 列出資料庫 / schema
    List,
}

#[derive(Subcommand, Debug)]
pub enum TableCmd {
    /// 列出資料表 / 視圖 / 集合
    List,
    /// 欄位定義
    Columns { table: String },
    /// 分頁讀取資料
    Data {
        table: String,
        #[arg(long, default_value_t = 0)]
        page: u32,
        #[arg(long, default_value_t = 100)]
        page_size: u32,
        /// 篩選 col:op[:value]（op: = != > >= < <= like is_null is_not_null），可重複
        #[arg(long)]
        filter: Vec<String>,
        /// 排序 col:asc|desc，可重複
        #[arg(long)]
        sort: Vec<String>,
        /// 多個篩選以 OR 連接（預設 AND）
        #[arg(long)]
        match_any: bool,
    },
    /// 資料表統計
    Info { table: String },
    /// 建表 DDL
    Ddl { table: String },
    /// 索引清單
    Indexes { table: String },
    /// 外鍵清單
    ForeignKeys { table: String },
}

#[derive(Subcommand, Debug)]
pub enum RoutineCmd {
    /// 列出預存程序 / 函式 / 觸發器
    List,
    /// 取得單一 routine 的 DDL
    Def {
        name: String,
        #[arg(long = "type", default_value = "procedure")]
        routine_type: String,
    },
}

#[derive(Args, Debug)]
pub struct SearchArgs {
    /// 搜尋字串（子字串）
    pub term: String,
    /// 限定資料庫 / schema（可重複；預設全部）
    #[arg(long)]
    pub databases: Vec<String>,
    /// 限定物件型別（可重複；如 table view procedure …）
    #[arg(long = "type")]
    pub types: Vec<String>,
    /// 比對名稱（若三個比對範圍皆未指定，預設比對名稱）
    #[arg(long)]
    pub names: bool,
    /// 比對定義內文
    #[arg(long)]
    pub definitions: bool,
    /// 比對註解
    #[arg(long)]
    pub comments: bool,
    /// 區分大小寫
    #[arg(long)]
    pub case_sensitive: bool,
    /// 僅比對整個單字
    #[arg(long = "whole-word")]
    pub whole_word: bool,
    /// 啟用萬用字元 * 與 ?
    #[arg(long)]
    pub wildcards: bool,
    /// 結果上限
    #[arg(long)]
    pub limit: Option<usize>,
}

#[derive(Args, Debug)]
pub struct ExportArgs {
    pub table: String,
    /// 輸出檔路徑
    #[arg(long)]
    pub to: String,
    /// 匯出格式：csv | tsv | xlsx | json | sql | markdown
    #[arg(long = "data-format", default_value = "csv")]
    pub data_format: String,
    /// 不輸出表頭列
    #[arg(long = "no-header")]
    pub no_header: bool,
    /// CSV/TSV 自訂分隔字元
    #[arg(long)]
    pub delimiter: Option<String>,
    /// NULL 在 CSV/TSV 的呈現（預設空字串）
    #[arg(long)]
    pub null_text: Option<String>,
    /// 檔首寫 UTF-8 BOM（方便 Excel）
    #[arg(long)]
    pub bom: bool,
    /// 篩選 col:op[:value]，可重複
    #[arg(long)]
    pub filter: Vec<String>,
    /// 排序 col:asc|desc，可重複
    #[arg(long)]
    pub sort: Vec<String>,
    /// 篩選以 OR 連接
    #[arg(long)]
    pub match_any: bool,
}

#[derive(Args, Debug)]
pub struct BackupArgs {
    /// 要備份的資料庫名
    pub database: String,
    /// 輸出檔路徑
    #[arg(long)]
    pub to: String,
}

#[derive(Subcommand, Debug)]
pub enum RedisCmd {
    /// 掃描鍵名
    Keys {
        #[arg(long, default_value = "*")]
        pattern: String,
        #[arg(long, default_value_t = 1000)]
        limit: usize,
    },
    /// 取得單一鍵的內容
    Key { key: String },
    /// 慢查詢日誌（SLOWLOG）
    Slowlog {
        #[arg(long, default_value_t = 10)]
        count: i64,
    },
    /// 用戶端連線清單（CLIENT LIST）
    Clients,
    /// 大鍵掃描（取樣 + MEMORY USAGE）
    BigKeys {
        #[arg(long, default_value_t = 100)]
        sample: usize,
        #[arg(long, default_value_t = 20)]
        top: usize,
    },
}
