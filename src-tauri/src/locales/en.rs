//! 繁中原文 → 英文對照表。
//!
//! - key 為 `t!` / `tf!` 傳入的**繁中原字面值**（含 `{name}` 佔位符），查無回 `None`（identity fallback）。
//! - clap 的 `about` / 參數說明字面值（`src/cli/args.rs`）也收錄於此，供 dbk `--help` 執行期覆寫。
//! - 新增使用者可見字串時，於對應分類補一行即可；不需維護排序。
#![allow(clippy::match_same_arms)]

/// 查表：找到回英文，否則 `None`（由 `i18n::lookup` 做 identity fallback）。
pub fn lookup(zh: &str) -> Option<&'static str> {
    Some(match zh {
        // ---- error.rs：AppError 外層包裝（序列化時產生）----
        "找不到連線：{detail}" => "Connection not found: {detail}",
        "連線失敗：{detail}" => "Connection failed: {detail}",
        "查詢失敗：{detail}" => "Query failed: {detail}",
        "不支援的資料庫種類：{detail}" => "Unsupported database kind: {detail}",
        "連線池已耗盡或關閉" => "The connection pool is exhausted or closed",
        "儲存錯誤：{detail}" => "Storage error: {detail}",
        "SSH 通道錯誤：{detail}" => "SSH tunnel error: {detail}",
        "查詢逾時（{ms} ms）；伺服器端查詢可能仍在執行，可從行程清單手動終止" => {
            "Query timed out after {ms} ms; the server-side query may still be running and can be terminated manually from the process list"
        }

        // ---- store.rs：設定 / keychain ----
        "無法取得使用者設定目錄" => "Unable to determine the user config directory",
        "無法取得設定目錄：{e}" => "Unable to determine the config directory: {e}",
        "建立設定目錄失敗：{e}" => "Failed to create the config directory: {e}",
        "讀取連線設定失敗：{e}" => "Failed to read connection settings: {e}",
        "序列化連線設定失敗：{e}" => "Failed to serialize connection settings: {e}",
        "寫入連線設定失敗：{e}" => "Failed to write connection settings: {e}",
        "更新連線設定失敗：{e}" => "Failed to update connection settings: {e}",
        "解析 {file} 失敗：{e}" => "Failed to parse {file}: {e}",
        "讀取 {file} 失敗：{e}" => "Failed to read {file}: {e}",
        "序列化 {file} 失敗：{e}" => "Failed to serialize {file}: {e}",
        "寫入 {file} 失敗：{e}" => "Failed to write {file}: {e}",
        "更新 {file} 失敗：{e}" => "Failed to update {file}: {e}",
        "keychain 開啟失敗：{e}" => "Failed to open the keychain: {e}",
        "keychain 寫入失敗：{e}" => "Failed to write to the keychain: {e}",

        // ---- commands/mod.rs ----
        "salt 產生失敗：{e}" => "Failed to generate salt: {e}",
        "密碼雜湊失敗：{e}" => "Failed to hash the password: {e}",
        "密碼不可為空" => "Password must not be empty",
        "目前密碼不正確" => "Current password is incorrect",
        "請提供 passphrase" => "A passphrase is required",
        "序列化失敗：{e}" => "Serialization failed: {e}",
        "寫入失敗：{e}" => "Write failed: {e}",
        "讀取失敗：{e}" => "Read failed: {e}",
        "解密成功但內容格式不符（檔案可能來自不同版本）" => {
            "Decryption succeeded but the contents are malformed (the file may be from a different version)"
        }
        "檔案過大（上限 8 MiB）" => "File is too large (8 MiB limit)",
        "檔案過大（約 {mb} MB），CSV 匯入上限 100 MB；請先分割檔案" => {
            "File is too large (~{mb} MB); the CSV import limit is 100 MB. Please split the file first"
        }
        "檔案非 UTF-8 編碼；請在試算表以「另存新檔 → CSV UTF-8」重新匯出後再試" => {
            "The file is not UTF-8 encoded. Re-export it from your spreadsheet as \"Save As -> CSV UTF-8\" and try again"
        }
        "讀取檔案失敗：{e}" => "Failed to read the file: {e}",
        "檔案過大（約 {mb} MB），Excel 匯入上限 100 MB" => {
            "File is too large (~{mb} MB); the Excel import limit is 100 MB"
        }
        "{id2}: subscribe {c} 失敗：{e}" => "{id2}: subscribe {c} failed: {e}",
        "{id2}: psubscribe {p} 失敗：{e}" => "{id2}: psubscribe {p} failed: {e}",
        "此筆為失敗紀錄，無法還原" => "This entry is a failed backup and cannot be restored",

        // ---- CLI 執行期輸出（cli/*.rs）----
        "連線成功" => "Connected successfully",
        "已備份：{path}（{bytes} bytes，方式 {method}）" => "Backed up: {path} ({bytes} bytes, method {method})",
        "(無欄位；{n} 列受影響)" => "(no columns; {n} rows affected)",
        "(結果已截斷於 {cap} 列；用 --max-rows 0 取完整結果)" => {
            "(results truncated at {cap} rows; use --max-rows 0 for the full result)"
        }
        "資料表：{tables}　關係：{relations}" => "Tables: {tables}   Relations: {relations}",
        "(第 {page} 頁，每頁 {page_size}，共 {total} 列)" => "(page {page}, {page_size} per page, {total} rows total)",
        "(已達上限 {limit}，可能仍有更多鍵)" => "(reached the limit of {limit}; there may be more keys)",
        "(鍵不存在)" => "(key does not exist)",
        "已匯出 {rows} 列到 {path}（{bytes} bytes，{format} 格式）" => {
            "Exported {rows} rows to {path} ({bytes} bytes, {format} format)"
        }
        "請提供 --passphrase" => "--passphrase is required",
        "已加密匯出 {count} 筆連線到 {path}" => "Encrypted and exported {count} connections to {path}",
        "篩選格式錯誤（應為 col:op[:value]）：{spec}" => "Invalid filter format (expected col:op[:value]): {spec}",
        "不支援的篩選運算子：{op}" => "Unsupported filter operator: {op}",
        "排序格式錯誤（應為 col:asc|desc）：{spec}" => "Invalid sort format (expected col:asc|desc): {spec}",
        "排序方向需為 asc/desc：{other}" => "Sort direction must be asc/desc: {other}",
        "(空結果)" => "(empty result)",
        "({n} 列)" => "({n} rows)",
        "json 序列化失敗：{e}" => "JSON serialization failed: {e}",
        "CLI 為唯讀模式，僅允許查詢語句（偵測到 `{kw}`）" => {
            "The CLI is read-only; only query statements are allowed (detected `{kw}`)"
        }
        "CLI 為唯讀模式，偵測到可寫 CTE（含 `{w}`）" => {
            "The CLI is read-only; a writable CTE was detected (contains `{w}`)"
        }
        "CLI 不支援外部 gateway（External）連線" => "The CLI does not support external gateway (External) connections",
        "請以 --conn <名稱> 指定已存連線，或以 --kind / --url 指定臨時連線" => {
            "Specify a saved connection with --conn <name>, or an ad-hoc connection with --kind / --url"
        }
        "無法判斷連線種類（請加 --kind 或於 --url 指定 scheme）" => {
            "Cannot determine the connection kind (add --kind or specify a scheme in --url)"
        }

        // ---- clap 說明（cli/args.rs：about / 參數 / 子指令）----
        "db-kit CLI — 唯讀查詢與匯出（重用 GUI 已存連線 / 臨時連線）" => {
            "db-kit CLI — read-only query and export (reuses GUI saved connections / ad-hoc connections)"
        }
        "使用已存連線（名稱或 id；讀 GUI 的 connections.json + keychain）" => {
            "Use a saved connection (name or id; reads the GUI's connections.json + keychain)"
        }
        "臨時連線：資料庫種類" => "Ad-hoc connection: database kind",
        "臨時連線：主機（預設 127.0.0.1）" => "Ad-hoc connection: host (default 127.0.0.1)",
        "臨時連線：連接埠（預設依種類）" => "Ad-hoc connection: port (default depends on kind)",
        "臨時連線：帳號" => "Ad-hoc connection: username",
        "臨時連線：密碼（亦可用環境變數 DBKIT_PASSWORD，避免出現在 argv）" => {
            "Ad-hoc connection: password (can also use the DBKIT_PASSWORD env var to keep it out of argv)"
        }
        "臨時連線：連線字串 / DSN（如 mysql://user:pass@host:3306/db；sqlite 給檔案路徑）" => {
            "Ad-hoc connection: connection string / DSN (e.g. mysql://user:pass@host:3306/db; for sqlite give a file path)"
        }
        "預設資料庫 / schema（sqlite=檔案路徑、redis=db index）" => {
            "Default database / schema (sqlite = file path, redis = db index)"
        }
        "輸出格式" => "Output format",
        "介面語言（zh-TW | en；亦可用環境變數 DBKIT_LANG）" => {
            "Interface language (zh-TW | en; can also use the DBKIT_LANG env var)"
        }
        "連線管理（唯讀 + 加密匯出）" => "Connection management (read-only + encrypted export)",
        "列出資料庫 / schema" => "List databases / schemas",
        "資料表瀏覽" => "Browse tables",
        "執行查詢（唯讀；非查詢語句會被擋下）" => "Run a query (read-only; non-query statements are blocked)",
        "結果列數上限（0 = 不限；預設沿用全域 1000）。截斷時於 stderr 提示。" => {
            "Maximum result rows (0 = unlimited; defaults to the global 1000). A note is printed to stderr when truncated."
        }
        "查詢計畫（EXPLAIN）" => "Query plan (EXPLAIN)",
        "欄位統計（總數 / 非空 / 相異 / 範圍）" => "Column statistics (total / non-null / distinct / range)",
        "預存程序 / 函式 / 觸發器" => "Stored procedures / functions / triggers",
        "全資料庫物件搜尋" => "Search objects across the database",
        "匯出資料庫結構（所有表 DDL）" => "Export the database schema (DDL of all tables)",
        "匯出資料表資料（csv/tsv/json/sql/markdown）" => "Export table data (csv/tsv/json/sql/markdown)",
        "備份（dump → 檔案；唯讀產出，不還原）" => "Backup (dump to file; read-only output, no restore)",
        "ER 模型（表 + 外鍵關係）" => "ER model (tables + foreign key relations)",
        "伺服器資訊" => "Server info",
        "Redis 唯讀操作" => "Redis read-only operations",
        "列出已存連線" => "List saved connections",
        "測試連線（不保留）" => "Test the connection (not persisted)",
        "Ping（量測 RTT）" => "Ping (measure RTT)",
        "加密匯出所有已存連線（含密碼，需 passphrase）" => {
            "Encrypt and export all saved connections (includes passwords; requires a passphrase)"
        }
        "列出資料表 / 視圖 / 集合" => "List tables / views / collections",
        "欄位定義" => "Column definitions",
        "分頁讀取資料" => "Read data with pagination",
        "篩選 col:op[:value]（op: = != > >= < <= like is_null is_not_null），可重複" => {
            "Filter col:op[:value] (op: = != > >= < <= like is_null is_not_null); repeatable"
        }
        "排序 col:asc|desc，可重複" => "Sort col:asc|desc; repeatable",
        "多個篩選以 OR 連接（預設 AND）" => "Combine multiple filters with OR (default AND)",
        "資料表統計" => "Table statistics",
        "建表 DDL" => "CREATE TABLE DDL",
        "索引清單" => "Index list",
        "外鍵清單" => "Foreign key list",
        "列出預存程序 / 函式 / 觸發器" => "List stored procedures / functions / triggers",
        "取得單一 routine 的 DDL" => "Get the DDL of a single routine",
        "搜尋字串（子字串）" => "Search string (substring)",
        "限定資料庫 / schema（可重複；預設全部）" => "Restrict to databases / schemas (repeatable; default all)",
        "限定物件型別（可重複；如 table view procedure …）" => {
            "Restrict to object types (repeatable; e.g. table view procedure ...)"
        }
        "比對名稱（若三個比對範圍皆未指定，預設比對名稱）" => {
            "Match names (if none of the three match scopes is set, names are matched by default)"
        }
        "比對定義內文" => "Match definition bodies",
        "比對註解" => "Match comments",
        "區分大小寫" => "Case sensitive",
        "僅比對整個單字" => "Match whole words only",
        "啟用萬用字元 * 與 ?" => "Enable wildcards * and ?",
        "結果上限" => "Result limit",
        "輸出檔路徑" => "Output file path",
        "匯出格式：csv | tsv | xlsx | json | sql | markdown" => "Export format: csv | tsv | xlsx | json | sql | markdown",
        "不輸出表頭列" => "Do not output the header row",
        "CSV/TSV 自訂分隔字元" => "Custom delimiter for CSV/TSV",
        "NULL 在 CSV/TSV 的呈現（預設空字串）" => "How NULL is rendered in CSV/TSV (default empty string)",
        "檔首寫 UTF-8 BOM（方便 Excel）" => "Write a UTF-8 BOM at the start of the file (for Excel)",
        "篩選 col:op[:value]，可重複" => "Filter col:op[:value]; repeatable",
        "篩選以 OR 連接" => "Combine filters with OR",
        "要備份的資料庫名" => "Name of the database to back up",
        "掃描鍵名" => "Scan key names",
        "取得單一鍵的內容" => "Get the contents of a single key",
        "慢查詢日誌（SLOWLOG）" => "Slow query log (SLOWLOG)",
        "用戶端連線清單（CLIENT LIST）" => "Client connection list (CLIENT LIST)",
        "大鍵掃描（取樣 + MEMORY USAGE）" => "Big-key scan (sampling + MEMORY USAGE)",

        // ---- backup.rs ----
        "外部 gateway 連線不支援備份" => "External gateway connections do not support backup",
        "SQL Server 備份尚未支援（規劃以 sqlpackage 匯出 .bacpac）" => {
            "SQL Server backup is not supported yet (planned via sqlpackage export to .bacpac)"
        }
        "Oracle 備份尚未支援（規劃以 Data Pump expdp 匯出 .dmp）" => {
            "Oracle backup is not supported yet (planned via Data Pump expdp export to .dmp)"
        }
        "SQLite 連線未指定檔案路徑" => "The SQLite connection did not specify a file path",
        "複製 SQLite 檔失敗：{e}" => "Failed to copy the SQLite file: {e}",
        "找不到 {tool} 工具，請先安裝後再備份（或改用支援內建匯出的格式）" => {
            "The {tool} tool was not found; install it before backing up (or use a format with built-in export)"
        }
        "備份指令執行失敗，請檢查連線與權限" => "The backup command failed; check the connection and permissions",
        "備份檔不存在" => "The backup file does not exist",
        "還原 SQLite 檔失敗：{e}" => "Failed to restore the SQLite file: {e}",
        "找不到 mysql 客戶端，請先安裝" => "The mysql client was not found; install it first",
        "MySQL 還原失敗" => "MySQL restore failed",
        "PostgreSQL 還原失敗" => "PostgreSQL restore failed",
        "找不到 mongorestore，請先安裝" => "mongorestore was not found; install it first",
        "MongoDB 還原失敗" => "MongoDB restore failed",
        "Redis 自動還原暫未支援；請以 redis-cli 手動匯入 RDB" => {
            "Automatic Redis restore is not supported yet; import the RDB manually with redis-cli"
        }
        "SQL Server 還原尚未支援（規劃以 sqlpackage 匯入 .bacpac）" => {
            "SQL Server restore is not supported yet (planned via sqlpackage import from .bacpac)"
        }
        "Oracle 還原尚未支援（規劃以 Data Pump impdp 匯入 .dmp）" => {
            "Oracle restore is not supported yet (planned via Data Pump impdp import from .dmp)"
        }
        "外部 gateway 連線不支援還原" => "External gateway connections do not support restore",
        "建立輸出檔失敗：{e}" => "Failed to create the output file: {e}",
        "開啟備份檔失敗：{e}" => "Failed to open the backup file: {e}",
        "找不到 psql，請先安裝" => "psql was not found; install it first",
        "建立 mongo 工具設定暫存檔失敗：{e}" => "Failed to create the temp config file for the mongo tools: {e}",
        "備份檔過小或無法讀取" => "The backup file is too small or unreadable",
        "備份檔不是有效的 SQLite 資料庫檔" => "The backup file is not a valid SQLite database file",

        // ---- ssh.rs ----
        "找不到設定目錄" => "config directory not found",
        "SQLite 不支援 SSH Tunnel" => "SQLite does not support SSH tunneling",
        "未填寫 SSH 主機" => "SSH host is empty",
        "SSH 連線逾時" => "SSH connection timed out",
        "SSH 連線失敗：{e}" => "SSH connection failed: {e}",
        "SSH 認證逾時" => "SSH authentication timed out",
        "SSH 認證失敗：{e}" => "SSH authentication failed: {e}",
        "讀取 SSH 私鑰失敗：{e}" => "Failed to read the SSH private key: {e}",
        "SSH 認證被拒（帳號 / 密碼 / 金鑰不正確）" => "SSH authentication rejected (incorrect username / password / key)",
        "本地監聽失敗：{e}" => "Local listen failed: {e}",
        "取得本地埠失敗：{e}" => "Failed to obtain the local port: {e}",

        // ---- conn_crypto.rs ----
        "金鑰派生失敗：{e}" => "Key derivation failed: {e}",
        "金鑰派生參數錯誤：{e}" => "Invalid key-derivation parameters: {e}",
        "passphrase 至少 {min} 碼（匯出檔可離線暴力破解，弱口令保護不了機密）" => {
            "The passphrase must be at least {min} characters (the export file can be brute-forced offline; a weak passphrase cannot protect the secrets)"
        }
        "加密失敗" => "Encryption failed",
        "非 db-kit 加密連線檔（檔頭不符）" => "Not a db-kit encrypted connection file (header mismatch)",
        "解密失敗（passphrase 錯誤或檔案損毀）" => "Decryption failed (wrong passphrase or corrupted file)",

        // ---- import.rs / export.rs ----
        "讀取 Excel 失敗：{e}" => "Failed to read the Excel file: {e}",
        "Excel 沒有任何工作表" => "The Excel file has no worksheets",
        "讀取工作表「{sheet}」失敗：{e}" => "Failed to read worksheet \"{sheet}\": {e}",
        "沒有任何資料列" => "No data rows",
        "未提供欄名（無表頭時必填 columns）" => "No column names provided (columns is required when there is no header)",
        "欄名為空" => "Column names are empty",
        "第 {line_no} 列欄數 {got} 與表頭 {want} 不符" => {
            "Row {line_no} has {got} columns, which does not match the {want} header columns"
        }
        "第 {line_no} 列：{e}" => "Row {line_no}: {e}",
        "寫入檔案失敗：{e}" => "Failed to write the file: {e}",
        "沒有可匯出的結果集" => "No result set to export",
        "結果 {n}" => "Result {n}",
        "不支援的匯出格式：{other}" => "Unsupported export format: {other}",
        "沒有可匯出的結構（此資料庫無資料表或不支援建表 SQL）" => {
            "No schema to export (this database has no tables or does not support CREATE SQL)"
        }
        "產生 Excel 失敗：{e}" => "Failed to generate the Excel file: {e}",
        "結果{n}" => "Result{n}",
        "寫入 Excel 失敗：{e}" => "Failed to write to the Excel file: {e}",
        "結果 {n}：{e}" => "Result {n}: {e}",
        "欄數 {n} 超過 Excel 上限（16384）" => "Column count {n} exceeds the Excel limit (16384)",
        "列數 {n} 超過 Excel 上限（1048576）" => "Row count {n} exceeds the Excel limit (1048576)",

        // ---- transfer.rs / scheduler.rs / agent.rs / manager.rs / db/external.rs ----
        "無法解析來源建表 DDL（找不到 CREATE TABLE）" => "Unable to parse the source table DDL (no CREATE TABLE found)",
        "來源建表 DDL 無欄位定義" => "The source table DDL has no column definitions",
        "來源與目標是同一張表，無法傳輸" => "Source and destination are the same table; cannot transfer",
        "自動建表僅支援相同資料庫種類；請先在目標手動建立資料表" => {
            "Auto table creation is only supported between the same database kind; create the destination table manually first"
        }
        "來源與目標沒有同名欄位可傳輸；請確認目標表結構" => {
            "Source and destination share no columns with matching names; verify the destination table structure"
        }
        "建立輸出目錄失敗：{e}" => "Failed to create the output directory: {e}",
        // 註：「無法取得設定目錄：{e}」已於 store.rs 分類收錄（agent.rs 共用同一 key）。
        "建立助手工作目錄失敗：{e}" => "Failed to create the assistant working directory: {e}",
        "僅允許開啟 http / https 連結" => "Only http / https links may be opened",
        "找不到 claude CLI，請先安裝 Claude Code 並登入" => "claude CLI not found; install Claude Code and sign in first",
        "啟動 claude 失敗：{e}" => "Failed to start claude: {e}",
        "claude 以結束碼 {c} 退出" => "claude exited with code {c}",
        "此連線不是 Redis" => "This connection is not Redis",
        "此連線不是 MongoDB" => "This connection is not MongoDB",
        "External 連線未指定 options.driver" => "The External connection did not specify options.driver",
        "此 build 未編入外部驅動「{other}」" => "This build does not include the external driver \"{other}\"",

        // ---- db/mod.rs：trait 預設 Unsupported + 欄位驗證 ----
        "此資料庫不支援鍵結構編輯" => "This database does not support key structure editing",
        "此資料庫不支援查詢計畫分析" => "This database does not support query plan analysis",
        "此資料庫不支援欄位統計" => "This database does not support column statistics",
        "此資料庫不支援建立集合（請用設計表結構建表）" => {
            "This database does not support creating collections (use table design instead)"
        }
        "此資料庫不支援新增資料庫" => "This database does not support creating databases",
        "此資料庫不支援刪除集合" => "This database does not support dropping collections",
        "此資料庫不支援刪除資料庫" => "This database does not support dropping databases",
        "此資料庫不支援預存程序 / 觸發器" => "This database does not support stored procedures / triggers",
        "此資料庫不支援物件搜尋" => "This database does not support object search",
        "此資料庫不支援此操作" => "This database does not support this operation",
        "此資料庫不支援語法驗證" => "This database does not support syntax validation",
        "此資料庫不支援結構編輯" => "This database does not support schema editing",
        "此資料庫不支援 ER 圖" => "This database does not support ER diagrams",
        "此資料庫不支援建表 DDL" => "This database does not support table DDL",
        "此資料庫不支援刪除索引" => "This database does not support dropping indexes",
        "此資料庫不支援建立索引" => "This database does not support creating indexes",
        "此資料庫不支援伺服器狀態" => "This database does not support server status",
        "此資料庫不支援鍵掃描" => "This database does not support key scanning",
        "此資料庫不支援文件檢視" => "This database does not support document viewing",
        "此資料庫不支援文件取代" => "This database does not support document replacement",
        "請指定欄位型別" => "Please specify a column type",
        "欄位型別含不允許的字元（; -- /* 或換行）" => "The column type contains disallowed characters (; -- /* or line breaks)",
        "預設值含不允許的字元（; -- /* 或換行）" => "The default value contains disallowed characters (; -- /* or line breaks)",

        // ---- 各驅動共用：資料列編輯 / 結構 ----
        "欄位與值數量不符" => "Column and value counts do not match",
        "此表無主鍵，無法安全更新" => "The table has no primary key; cannot update safely",
        "此表無主鍵，無法安全刪除" => "The table has no primary key; cannot delete safely",
        "主鍵欄位與值數量不符" => "Primary key column and value counts do not match",
        "主鍵值為 NULL，無法定位該列" => "The primary key value is NULL; cannot locate the row",
        "主鍵值為 NULL，無法安全定位列" => "The primary key value is NULL; cannot safely locate the row",
        "主鍵值為 NULL，無法安全定位該列" => "The primary key value is NULL; cannot safely locate this row",
        "未提供任何欄位" => "No columns provided",
        "請至少選擇一個欄位" => "Please select at least one column",
        "不支援的運算子：{op}" => "Unsupported operator: {op}",
        "找不到該表的建表語句" => "Could not find the CREATE statement for this table",
        "找不到觸發器「{name}」" => "Trigger \"{name}\" not found",
        "SQLite 不支援直接修改欄位型別（需重建資料表）" => {
            "SQLite does not support altering a column type directly (the table must be rebuilt)"
        }
        "SQLite 不支援直接修改欄位預設值（需重建資料表）" => {
            "SQLite does not support altering a column default directly (the table must be rebuilt)"
        }

        // ---- db/mssql.rs ----
        "取不到定義（可能無權限或物件不存在）" => "Could not retrieve the definition (possibly no permission or the object does not exist)",
        "找不到資料表欄位" => "No table columns found",
        "欄位統計無結果" => "Column statistics returned no results",
        "列數（估計）" => "Row count (estimated)",
        "資料大小" => "Data size",
        "系統資料庫「{name}」不可刪除" => "The system database \"{name}\" cannot be dropped",
        "缺少主鍵，無法定位列" => "Missing primary key; cannot locate the row",

        // ---- db/mysql.rs ----
        "拒絕刪除 MySQL 系統資料庫「{name}」" => "Refusing to drop the MySQL system database \"{name}\"",
        "「{name}」是此連線使用中的預設資料庫，無法刪除；請改用其他連線或先變更連線預設庫" => {
            "\"{name}\" is the default database in use by this connection and cannot be dropped; use another connection or change the connection's default database first"
        }
        "未知的程序類型「{routine_type}」" => "Unknown routine type \"{routine_type}\"",
        "無法取得定義（可能權限不足）" => "Could not retrieve the definition (possibly insufficient permission)",
        "無法辨識的 MySQL DDL，已略過伺服器驗證（僅前端結構檢查）。" => {
            "Unrecognized MySQL DDL; server-side validation was skipped (front-end structure check only)."
        }
        "MySQL 觸發器需掛載於真實資料表，無法安全試建驗證；已略過伺服器驗證（僅前端結構檢查）。" => {
            "MySQL triggers must attach to a real table and cannot be safely trial-created for validation; server-side validation was skipped (front-end structure check only)."
        }
        "MySQL 事件無法安全試建驗證；已略過伺服器驗證（僅前端結構檢查）。" => {
            "MySQL events cannot be safely trial-created for validation; server-side validation was skipped (front-end structure check only)."
        }
        "未知的 MySQL routine 類型，已略過伺服器驗證。" => "Unknown MySQL routine type; server-side validation was skipped.",
        "未指定資料庫，MySQL 無法試建驗證；已略過伺服器驗證（僅前端結構檢查）。" => {
            "No database specified, so MySQL cannot trial-create for validation; server-side validation was skipped (front-end structure check only)."
        }
        "目前帳號缺少建立 routine 的權限，無法在伺服器驗證（僅前端結構檢查）。" => {
            "The current account lacks permission to create routines, so server-side validation is not possible (front-end structure check only)."
        }
        "函式需宣告 DETERMINISTIC / READS SQL DATA（或具備權限）才能試建，已略過伺服器驗證。" => {
            "The function must declare DETERMINISTIC / READS SQL DATA (or have permission) to be trial-created; server-side validation was skipped."
        }
        "引擎" => "Engine",
        "排序規則" => "Collation",
        "建立時間" => "Created",
        "索引大小" => "Index size",
        "註解" => "Comment",
        "無法取得建表語句" => "Could not retrieve the CREATE statement",

        // ---- db/postgres.rs ----
        "拒絕刪除 PostgreSQL 系統 schema「{name}」" => "Refusing to drop the PostgreSQL system schema \"{name}\"",
        "找不到「{name}」的定義" => "Could not find the definition of \"{name}\"",
        "總大小" => "Total size",
        "找不到該表的欄位" => "No columns found for this table",

        // ---- db/oracle.rs ----
        "Oracle client 已以「{dir}」初始化；變更 client 目錄需重新啟動應用程式" => {
            "The Oracle client was already initialized with \"{dir}\"; changing the client directory requires restarting the application"
        }
        "client 目錄無效：{e}" => "Invalid client directory: {e}",
        "Oracle 連線需在「資料庫」欄填入服務名稱（Service Name）/ SID / TNS 別名" => {
            "Oracle connections require a Service Name / SID / TNS alias in the \"Database\" field"
        }
        "此表無主鍵，拒絕就地編輯（避免影響多列）" => {
            "The table has no primary key; in-place editing is refused (to avoid affecting multiple rows)"
        }
        "背景執行緒失敗：{e}" => "Background thread failed: {e}",
        "Oracle 連線逾時（30 秒）" => "Oracle connection timed out (30 seconds)",
        "至少需一個欄位" => "At least one column is required",
        "索引至少需一個欄位" => "An index requires at least one column",
        "取得 DDL 失敗（需物件擁有者或 SELECT_CATALOG_ROLE）：{e}" => {
            "Failed to retrieve DDL (requires the object owner or SELECT_CATALOG_ROLE): {e}"
        }
        "找不到原始碼（權限不足或物件不存在）" => "Source not found (insufficient permission or the object does not exist)",
        "沒有可解釋的語句" => "No statement to explain",
        "列數（統計估計）" => "Row count (statistics estimate)",
        "統計時間" => "Statistics time",
        "表空間" => "Tablespace",
        "Oracle DDL 隱式提交，無法安全試行驗證；將直接執行" => {
            "Oracle DDL commits implicitly and cannot be safely trial-validated; it will be executed directly"
        }
        "Oracle 尚未支援此結構操作" => "Oracle does not support this schema operation yet",
        "Oracle 的資料庫＝schema（使用者帳號）；請由 DBA 以 CREATE USER 管理" => {
            "In Oracle a database equals a schema (user account); have a DBA manage it with CREATE USER"
        }
        "Oracle 的 schema 即使用者帳號，請由 DBA 以 DROP USER 管理（本工具不代理此高風險操作）" => {
            "In Oracle a schema is a user account; have a DBA manage it with DROP USER (this tool does not proxy this high-risk operation)"
        }
        "找不到 Oracle Instant Client（或架構不符，需 64 位元）。\n請安裝 Instant Client Basic / Basic Light 並將其目錄加入 PATH，或在連線設定的「Instant Client 目錄」填入路徑後重試。\n下載：{url}\n（{msg}）" => {
            "Oracle Instant Client not found (or architecture mismatch; 64-bit required).\nInstall Instant Client Basic / Basic Light and add its directory to PATH, or set the path in the connection's \"Instant Client directory\" field and retry.\nDownload: {url}\n({msg})"
        }

        // ---- db/redis.rs ----
        "非預期的 PING 回應：{pong}" => "Unexpected PING response: {pong}",
        "秒；-1 表示無到期" => "seconds; -1 means no expiry",
        "空命令" => "Empty command",
        "TTL 必須為整數" => "TTL must be an integer",
        "不支援直接改 key 名稱，請用 RENAME" => "Renaming a key directly is not supported; use RENAME",
        "type 欄為唯讀，無法編輯" => "The type field is read-only and cannot be edited",
        "缺少 key" => "Missing key",
        "key 為空" => "The key is empty",
        "目標鍵「{new_key}」已存在，為避免覆蓋而取消改名" => {
            "The target key \"{new_key}\" already exists; the rename was cancelled to avoid overwriting"
        }

        // ---- db/mongo.rs：錯誤 ----
        "MongoDB 查詢請提供 JSON：{\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}" => {
            "For a MongoDB query, provide JSON: {\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}"
        }
        "缺少 db" => "Missing db",
        "缺少 collection" => "Missing collection",
        "pipeline 必須是陣列" => "pipeline must be an array",
        "pipeline 每個階段必須是物件" => "Each pipeline stage must be an object",
        "insert 必須是陣列" => "insert must be an array",
        "insert 每個元素必須是物件" => "Each insert element must be an object",
        "update 需要 set 物件" => "update requires a set object",
        "update 的 set 不可為空" => "The set object of update must not be empty",
        "update 需要非空 filter（避免誤改整個集合；要全改請用明確條件如 {\"_id\":{\"$exists\":true}}）" => {
            "update requires a non-empty filter (to avoid modifying the whole collection; to update everything use an explicit condition like {\"_id\":{\"$exists\":true}})"
        }
        "delete 必須是 filter 物件" => "delete must be a filter object",
        "delete 需要非空 filter（避免誤刪整個集合）" => "delete requires a non-empty filter (to avoid deleting the whole collection)",
        "此欄為巢狀結構，需輸入合法 JSON：{e}" => "This field is a nested structure; valid JSON is required: {e}",
        "JSON 轉 BSON 失敗：{e}" => "Failed to convert JSON to BSON: {e}",
        "缺少 _id，無法刪除" => "Missing _id; cannot delete",
        "_id 為空，無法刪除" => "_id is empty; cannot delete",
        "拒絕刪除 MongoDB 系統資料庫「{name}」" => "Refusing to drop the MongoDB system database \"{name}\"",
        "找不到文件" => "Document not found",
        "文件需為合法 JSON：{e}" => "The document must be valid JSON: {e}",
        "文件必須是 JSON 物件" => "The document must be a JSON object",
        "MongoDB 執行計畫請提供與查詢相同的 JSON：{\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}（可加 \"verbosity\"）" => {
            "For a MongoDB execution plan, provide the same JSON as a query: {\"db\":\"..\",\"collection\":\"..\",\"filter\":{}} (an optional \"verbosity\" may be added)"
        }
        "索引規格無效：{other}（可用 1 / -1 / text / 2dsphere / hashed）" => {
            "Invalid index spec: {other} (allowed: 1 / -1 / text / 2dsphere / hashed)"
        }
        "partialFilterExpression 需為合法 JSON：{e}" => "partialFilterExpression must be valid JSON: {e}",
        "partialFilterExpression 必須是非空 JSON 物件" => "partialFilterExpression must be a non-empty JSON object",
        "拒絕修改系統集合的驗證規則" => "Refusing to modify the validation rules of a system collection",
        "validationLevel 無效：{level}" => "Invalid validationLevel: {level}",
        "validationAction 無效：{action}" => "Invalid validationAction: {action}",
        "validator 需為合法 JSON：{e}" => "validator must be valid JSON: {e}",
        "validator 必須是 JSON 物件" => "validator must be a JSON object",
        "profiler level 需為 0 / 1 / 2" => "profiler level must be 0 / 1 / 2",
        "缺少 _id，無法定位文件" => "Missing _id; cannot locate the document",
        "_id 為空" => "_id is empty",
        "verbosity 無效：{other}（可用 queryPlanner / executionStats / allPlansExecution）" => {
            "Invalid verbosity: {other} (allowed: queryPlanner / executionStats / allPlansExecution)"
        }
        "執行計畫僅支援 find / aggregate（pipeline）" => "Execution plans are only supported for find / aggregate (pipeline)",

        // ---- db/mongo.rs：dbStats / collStats / serverStatus 標籤 ----
        "文件數" => "Documents",
        "大小" => "Size",
        "儲存大小" => "Storage size",
        "索引數" => "Indexes",
        "平均文件大小" => "Average document size",
        "集合數" => "Collections",
        "版本" => "Version",
        "主機" => "Host",
        "程序" => "Process",
        "運行時間" => "Uptime",
        "伺服器" => "Server",
        "目前" => "Current",
        "可用" => "Available",
        "活躍" => "Active",
        "累計建立" => "Total created",
        "連線" => "Connections",
        "操作計數" => "Operation counts",
        "常駐記憶體" => "Resident memory",
        "虛擬記憶體" => "Virtual memory",
        "WT 快取使用" => "WT cache used",
        "WT 快取上限" => "WT cache limit",
        "記憶體" => "Memory",
        "流入" => "Bytes in",
        "流出" => "Bytes out",
        "請求數" => "Requests",
        "網路" => "Network",
        "角色" => "Role",
        "成員" => "Members",
        "複寫" => "Replication",
        "{d} 天 {hms}" => "{d}d {hms}",

        // ---- db/kafka ----
        "群組仍有活躍成員，無法重設位移（請先停掉消費者）" => {
            "The group still has active members; stop the consumers before resetting offsets"
        }
        "重設逾時：無法取得群組分區指派" => {
            "Reset timed out: unable to obtain the group's partition assignment"
        }
        "主題含無法讀取的敏感設定，整組覆寫會遺失該值，已拒絕編輯" => {
            "The topic has sensitive config values that cannot be read; a full-set overwrite would silently drop them, so the edit was refused"
        }
        "新分區數必須大於目前的 {n}" => "The new partition count must be greater than the current {n}",
        "內部主題不可清空" => "Internal topics cannot be emptied",
        "沒有符合的分區" => "No matching partitions",
        "沒有可套用的分區（皆無已提交位移）" => "No partitions to apply (none have committed offsets)",
        "群組仍有活躍成員，無法刪除（請先停掉消費者）" => {
            "The group still has active members; stop the consumers before deleting it"
        }
        "（此連線未設定 Schema Registry，無法以 Avro 解碼）" => {
            "(No Schema Registry configured for this connection; cannot decode as Avro)"
        }
        "（非 Confluent wire format，無法以 Avro 解碼）" => {
            "(Not Confluent wire format; cannot decode as Avro)"
        }
        "此連線未設定 Schema Registry，無法以 Avro 發佈" => {
            "No Schema Registry configured for this connection; cannot produce as Avro"
        }
        "僅支援以 Avro 序列化發佈（此 subject 非 AVRO）" => {
            "Only Avro serialization is supported for producing (this subject is not AVRO)"
        }
        "Avro 編碼失敗" => "Avro encoding failed",

        _ => return None,
    })
}
