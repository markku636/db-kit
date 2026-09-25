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
        // 啟動鎖定：生物辨識（Windows Hello / Touch ID）。第一句會出現在 OS 的驗證對話框上。
        "驗證以解鎖 DB Kit" => "Verify to unlock DB Kit",
        "此裝置無法使用生物辨識" => "Biometrics are not available on this device",
        "驗證未通過，尚未啟用生物辨識解鎖" => {
            "Verification failed; biometric unlock was not enabled"
        }
        "驗證未通過；若已設定啟動密碼，可改以密碼關閉" => {
            "Verification failed; if a startup password is set, you can turn this off with the password instead"
        }
        "驗證執行緒異常結束：{e}" => "The verification thread ended unexpectedly: {e}",
        // ---- biometric.rs ----
        "無法取得 Windows Hello 狀態：{e}" => "Could not read Windows Hello status: {e}",
        "無法建立驗證介面：{e}" => "Could not create the verification interface: {e}",
        "無法顯示驗證提示：{e}" => "Could not show the verification prompt: {e}",
        "驗證過程發生錯誤：{e}" => "The verification failed with an error: {e}",
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

        // ---- db/conn_url/：連線字串解析（GUI parse_connection_url / CLI --url 共用）----
        "無法解析連線字串" => "Unable to parse the connection string",
        "不支援的連線字串格式：{scheme}" => "Unsupported connection string format: {scheme}",

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
        "其中 {n} 筆是 PROD 連線，一律不含帳號與密碼" => {
            "{n} of them are PROD connections and never carry a username or password"
        }
        "沒有可匯出的連線" => "There are no connections to export",
        "含 {n} 個側欄群組" => "Including {n} sidebar groups",
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

        "CLI 不支援 Kafka 連線（請用 GUI）" => "The CLI does not support Kafka connections (use the GUI)",
        "CLI 不支援 RabbitMQ 連線（請用 GUI）" => "The CLI does not support RabbitMQ connections (use the GUI)",

        // ---- cli/guard.rs、cli/dispatch.rs：寫入確認與寫入結果 ----
        "此為寫入指令，未執行：{action}。確認無誤請加 --yes{extra}" => {
            "This is a write command and was not executed: {action}. Add --yes{extra} once you have checked it"
        }
        "此為高破壞動作，未執行：{action}。請再加 --force 確認" => {
            "This is a highly destructive action and was not executed: {action}. Add --force as well to confirm"
        }
        "執行：{sql}" => "Execute: {sql}",
        "完成（{n} 列受影響）" => "Done ({n} rows affected)",
        "新增{noun}「{name}」" => "Create {noun} \"{name}\"",
        "已新增{noun}「{name}」" => "Created {noun} \"{name}\"",
        "刪除{noun}「{name}」（含其所有物件）" => "Drop {noun} \"{name}\" (including all objects in it)",
        "已刪除{noun}「{name}」" => "Dropped {noun} \"{name}\"",
        "刪除{noun}「{table}」" => "Drop {noun} \"{table}\"",
        "已刪除{noun}「{table}」" => "Dropped {noun} \"{table}\"",
        "清空資料表「{table}」的所有資料列" => "Delete all rows in table \"{table}\"",
        "已清空「{table}」（{n} 列）" => "Emptied \"{table}\" ({n} rows)",
        "Mongo 不支援 truncate（請用 dbk table drop 刪除集合，或以 query 帶明確 filter 刪除）" => {
            "Mongo does not support truncate (use `dbk table drop` to drop the collection, or delete with an explicit filter)"
        }
        "設定鍵「{key}」的值" => "Set the value of key \"{key}\"",
        "--ttl 需為正整數秒數（0 或負數在 Redis 等同立刻刪除該鍵；不設 TTL 請省略此旗標）" => {
            "--ttl must be a positive number of seconds (0 or negative deletes the key immediately in Redis; omit the flag for no TTL)"
        }
        "秒數需為正整數（0 或負數在 Redis 等同立刻刪除該鍵；要改為永不過期請用 dbk redis persist）" => {
            "Seconds must be positive (0 or negative deletes the key immediately in Redis; use `dbk redis persist` to remove the expiry)"
        }
        "前綴不可為空（要清空整個 DB 請用 dbk redis flush-db）" => {
            "The prefix cannot be empty (use `dbk redis flush-db` to clear the whole DB)"
        }
        "已設定鍵「{key}」（TTL {s} 秒）" => "Set key \"{key}\" (TTL {s}s)",
        "已設定鍵「{key}」" => "Set key \"{key}\"",
        "刪除 {n} 個鍵" => "Delete {n} keys",
        "已刪除 {n} 個鍵" => "Deleted {n} keys",
        "(掃描已達上限 {limit}；請縮小前綴或調高 --limit 後再執行)" => {
            "(the scan hit the {limit} cap; narrow the prefix or raise --limit before running)"
        }
        "刪除前綴「{prefix}」底下的 {n} 個鍵" => "Delete the {n} keys under prefix \"{prefix}\"",
        "設定鍵「{key}」存活 {seconds} 秒" => "Set key \"{key}\" to expire in {seconds}s",
        "已設定 TTL：{key}" => "TTL set: {key}",
        "移除鍵「{key}」的存活時間" => "Remove the expiry of key \"{key}\"",
        "已改為永不過期：{key}" => "Now persistent: {key}",
        "(鍵不存在或本就無 TTL)" => "(the key does not exist or had no TTL)",
        "將鍵「{key}」改名為「{new_key}」" => "Rename key \"{key}\" to \"{new_key}\"",
        "已改名：{key} → {new_key}" => "Renamed: {key} -> {new_key}",
        "清空 DB {target} 的所有鍵（FLUSHDB）" => "Flush all keys in DB {target} (FLUSHDB)",
        "已清空 DB {target}" => "Flushed DB {target}",
        "資料表" => "table",
        "集合" => "collection",

        // ---- clap 說明（cli/args.rs：about / 參數 / 子指令）----
        "db-kit CLI — 查詢、匯出與寫入（重用 GUI 已存連線 / 臨時連線；寫入需 --yes）" => {
            "db-kit CLI — query, export and write (reuses GUI saved connections / ad-hoc connections; writes require --yes)"
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
        "介面語言（zh-TW | zh-CN | en | ja | ko | vi；亦可用環境變數 DBKIT_LANG）" => {
            "Interface language (zh-TW | zh-CN | en | ja | ko | vi; can also use the DBKIT_LANG env var)"
        }
        "確認執行寫入指令（修改 / 刪除）。未加時只印出將執行的動作並以錯誤結束（等同預演）" => {
            "Confirm a write command (modify / delete). Without it, the action is only printed and the command exits with an error (dry run)"
        }
        "額外確認高破壞動作（DROP / TRUNCATE / FLUSHDB / 無 WHERE 的 UPDATE·DELETE），需與 --yes 併用" => {
            "Extra confirmation for highly destructive actions (DROP / TRUNCATE / FLUSHDB / UPDATE·DELETE without WHERE); use together with --yes"
        }
        "執行寫入語句（INSERT / UPDATE / DELETE / DDL）。需 --yes；高破壞動作另需 --force" => {
            "Run a write statement (INSERT / UPDATE / DELETE / DDL). Requires --yes; destructive actions also require --force"
        }
        "新增資料庫 / schema（PostgreSQL 為 schema）。需 --yes" => {
            "Create a database / schema (schema on PostgreSQL). Requires --yes"
        }
        "刪除資料庫 / schema（含其所有物件，不可復原）。需 --yes --force" => {
            "Drop a database / schema and everything in it (irreversible). Requires --yes --force"
        }
        "刪除資料表 / 集合（DROP TABLE / dropCollection）。需 --yes --force" => {
            "Drop a table / collection (DROP TABLE / dropCollection). Requires --yes --force"
        }
        "清空資料表（TRUNCATE；Mongo 為刪除所有文件）。需 --yes --force" => {
            "Empty a table (TRUNCATE). Requires --yes --force"
        }
        "設定 string 鍵的值（SET；可同時設 TTL）。需 --yes" => {
            "Set the value of a string key (SET; can also set a TTL). Requires --yes"
        }
        "同時設定存活秒數（省略 = 不動既有 TTL）" => "Also set the TTL in seconds (omit to leave the existing TTL untouched)",
        "刪除鍵（DEL，可一次多個）。需 --yes" => "Delete keys (DEL; accepts several at once). Requires --yes",
        "依前綴批次刪除鍵（先 SCAN 出鍵名再 DEL；預設只預覽，加 --yes 才真刪）。需 --yes --force" => {
            "Delete keys by prefix (SCAN for key names, then DEL; previews only by default). Requires --yes --force"
        }
        "掃描鍵數上限（保護大型實例）" => "Maximum number of keys to scan (protects large instances)",
        "設定鍵的存活秒數（EXPIRE）。需 --yes" => "Set a key's TTL in seconds (EXPIRE). Requires --yes",
        "移除鍵的存活時間，使其永不過期（PERSIST）。需 --yes" => {
            "Remove a key's TTL so it never expires (PERSIST). Requires --yes"
        }
        "重新命名鍵（RENAME；目標已存在會被擋下）。需 --yes" => {
            "Rename a key (RENAME; blocked if the target already exists). Requires --yes"
        }
        "清空目前 DB 的所有鍵（FLUSHDB，不可復原）。需 --yes --force" => {
            "Flush every key in the current DB (FLUSHDB, irreversible). Requires --yes --force"
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
        "Redis 操作（掃描 / 檢視 + 修改 / 刪除）" => "Redis operations (scan / inspect + modify / delete)",
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
        "找不到 {cli} CLI，請先安裝並以你的訂閱帳號登入" => {
            "{cli} CLI not found; install it and sign in with your subscription first"
        }
        "這個供應商不需要在終端機安裝或登入" => "This provider has nothing to install or sign in to in a terminal",
        "指令已結束。沒有錯誤的話，回到 DB Kit 就會自動重新偵測；這個視窗可以關掉。" => {
            "The command has finished. If there were no errors, switch back to DB Kit and it will detect again automatically. You can close this window."
        }
        "無法開啟終端機（{e}），請自行在終端機執行：{cmd}" => {
            "Could not open a terminal ({e}). Run this in a terminal yourself: {cmd}"
        }
        "啟動 {cli} 失敗：{e}" => "Failed to start {cli}: {e}",
        "{cli} 以結束碼 {c} 退出" => "{cli} exited with code {c}",
        "Codex 回合失敗" => "The Codex turn failed",
        "此連線不是 Redis" => "This connection is not Redis",
        "此連線不是 MongoDB" => "This connection is not MongoDB",
        "External 連線未指定 options.driver" => "The External connection did not specify options.driver",
        "此 build 未編入外部驅動「{other}」" => "This build does not include the external driver \"{other}\"",

        // ---- db/mod.rs：trait 預設 Unsupported + 欄位驗證 ----
        "此連線不支援取消執行中的查詢" => "This connection does not support cancelling a running query",
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

        // ---- stress.rs：壓力測試守門 ----
        "壓力測試至少需要一條 SQL 語句" => "A stress test needs at least one SQL statement",
        "壓力測試的並行執行緒數至少為 1" => "A stress test needs at least 1 concurrent thread",
        "壓力測試的每執行緒迭代次數至少為 1" => {
            "A stress test needs at least 1 iteration per thread"
        }
        "壓力測試的持續時間至少為 1 秒" => "A stress test must run for at least 1 second",
        "壓力測試的持續時間上限為 {max} 秒" => {
            "A stress test may run for at most {max} seconds"
        }
        "壓力測試會反覆執行語句，已拒絕高破壞語句（DROP / TRUNCATE 或無 WHERE 的 UPDATE / DELETE）：{sql}" => {
            "A stress test replays statements repeatedly, so highly destructive statements are refused (DROP / TRUNCATE, or UPDATE / DELETE without WHERE): {sql}"
        }
        "壓力測試會反覆執行語句，已拒絕 EXPLAIN ANALYZE 寫入語句（它會真的執行，不只產生執行計畫）：{sql}" => {
            "A stress test replays statements repeatedly, so EXPLAIN ANALYZE on a write statement is refused (it really executes the statement, not just plans it): {sql}"
        }

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
        "此連線未設定 Kafka Connect" => "This connection has no Kafka Connect configured",
        "連接器正在重新平衡，請稍後再試" => "The connector is rebalancing; please try again shortly",
        "叢集未啟用授權器（authorizer），無法管理 ACL" => {
            "The cluster has no authorizer enabled; ACLs cannot be managed"
        }
        "此連線未設定 Schema Registry，無法以 Avro 發佈" => {
            "No Schema Registry configured for this connection; cannot produce as Avro"
        }
        "僅支援以 Avro 序列化發佈（此 subject 非 AVRO）" => {
            "Only Avro serialization is supported for producing (this subject is not AVRO)"
        }
        "Avro 編碼失敗" => "Avro encoding failed",

        // ---- Elasticsearch / OpenSearch（elastic feature）----
        "此連線不是 Elasticsearch" => "This connection is not Elasticsearch",
        "此版本未編入 Elasticsearch 支援（請以 --features elastic 建置）" => {
            "This build does not include Elasticsearch support (build with --features elastic)"
        }
        "Elasticsearch 查詢請提供含 index 的 JSON 物件" => {
            "Provide a JSON object with an \"index\" field for the Elasticsearch query"
        }
        "Elasticsearch 查詢需為 JSON：{e}" => "The Elasticsearch query must be JSON: {e}",
        "Elasticsearch 連線第一版為唯讀，不支援直接編輯文件（請以 DSL 查詢瀏覽）" => {
            "Elasticsearch connections are read-only in this version; documents cannot be edited directly (use DSL queries to browse)"
        }
        "Elasticsearch 深度分頁超過 max_result_window（10000）；請改用 DSL 查詢（search_after）或縮小頁數" => {
            "Deep pagination exceeds max_result_window (10000); use a DSL query (search_after) or reduce the page number"
        }
        "文件不存在：{id}" => "Document not found: {id}",
        "Elastic Cloud cloud_id 格式無法解析" => "Could not parse the Elastic Cloud cloud_id",
        "讀取 CA 憑證檔失敗：{e}" => "Failed to read the CA certificate file: {e}",
        "搜尋引擎類連線不支援資料傳輸" => "Search-engine connections do not support data transfer",
        "Elasticsearch 連線不支援備份" => "Elasticsearch connections do not support backup",
        "Elasticsearch 連線不支援還原" => "Elasticsearch connections do not support restore",
        "CLI 不支援 Elasticsearch 連線（請用 GUI）" => {
            "The CLI does not support Elasticsearch connections (use the GUI)"
        }


        // ---- llm/：Anthropic / OpenAI 相容供應商 ----
        "尚未設定 API Base URL" => "No API base URL configured",
        "尚未指定模型" => "No model specified",
        "未知的供應商：{kind}" => "Unknown provider: {kind}",
        "（金鑰無效或沒有權限）" => " (invalid key or insufficient permission)",
        "（Base URL 可能不對，或這個服務沒有這個端點）" => " (the base URL may be wrong, or this service has no such endpoint)",
        "（額度或速率上限）" => " (quota or rate limit)",
        "串流中斷：{e}" => "Stream interrupted: {e}",
        "連線失敗：{e}" => "Connection failed: {e}",
        "回應不是 JSON：{e}" => "The response is not JSON: {e}",
        "端點連續拒絕請求（已嘗試相容性調整）" => "The endpoint kept rejecting the request (compatibility adjustments were already tried)",
        "（回應長度達上限，內容可能不完整）" => "(Reached the length limit; the answer may be incomplete.)",
        "模型重複呼叫同一支工具且沒有進展，已中止" => "The model kept calling the same tool without progress, so the run was stopped",
        "超過 {n} 回合仍未收斂，已中止" => "Stopped after {n} turns without converging",
        "讀取助手工作資料夾裡的一個檔案（相對路徑）。" => "Read one file inside the assistant workspace folder (relative path).",
        "列出助手工作資料夾裡的檔案，可用 * 與 ? 萬用字元過濾。" => "List files in the assistant workspace folder; * and ? wildcards are supported.",
        "在助手工作資料夾的文字檔中搜尋字串，回傳檔名、行號與該行內容。" => "Search text files in the assistant workspace folder and return file, line number and the matching line.",
        "把內容寫進助手工作資料夾裡的檔案（會覆蓋同名檔，可建立子目錄）。" => "Write content to a file in the assistant workspace folder (overwrites an existing file; subdirectories are created).",
        "path 不可為空" => "path must not be empty",
        "只能使用相對路徑（限助手工作資料夾內）" => "Only relative paths are allowed (inside the assistant workspace folder)",
        "路徑不可包含 .. 或磁碟前綴（限助手工作資料夾內）" => "The path must not contain .. or a drive prefix (inside the assistant workspace folder)",
        "建立目錄失敗：{e}" => "Failed to create the directory: {e}",
        "query 不可為空" => "query must not be empty",
        "目前是唯讀模式（advise），要寫檔請切到 agent 模式" => "This is read-only mode (advise); switch to agent mode to write files",
        "未知的工具：{name}" => "Unknown tool: {name}",
        "（找不到「{query}」）" => "(no match for “{query}”)",
        "（工作資料夾裡沒有符合的檔案）" => "(no matching file in the workspace folder)",
        "已寫入 {path}（{n} 位元組）" => "Wrote {path} ({n} bytes)",

        // ---- compare/：結構 / 資料比對（schema.rs / ddl.rs / snapshot.rs）----
        "此資料庫種類不支援結構比對" => "This database kind does not support schema comparison",
        "無法取得 {name} 的定義：{err}" => "Unable to fetch the definition of {name}: {err}",
        "無法列出程序 / 函式：{err}" => "Unable to list routines: {err}",
        "欄位：{err}" => "columns: {err}",
        "索引：{err}" => "indexes: {err}",
        "外鍵：{err}" => "foreign keys: {err}",
        "DDL：{err}" => "DDL: {err}",
        "找不到視圖定義" => "View definition not found",
        "來源與目標資料庫種類不同，無法產生同步 DDL" => "Source and target are different database kinds; cannot generate sync DDL",
        "資料表 {name}：來源無 DDL，無法產生 CREATE TABLE" => "Table {name}: the source has no DDL, so CREATE TABLE cannot be generated",
        "Oracle DDL 含儲存子句（TABLESPACE 等），目標環境可能需調整" => "Oracle DDL includes storage clauses (TABLESPACE etc.) that may need adjusting for the target",
        "資料表 {name}：{err}" => "Table {name}: {err}",
        "資料表 {name}：目標多出（未含 DROP）" => "Table {name}: only in target (DROP not included)",
        "{table}：主鍵變更請手動處理" => "{table}: primary key changes must be handled manually",
        "SQLite 無 DEFAULT 的 NOT NULL 欄無法新增，已改為允許 NULL" => "SQLite cannot add a NOT NULL column without a DEFAULT; changed to nullable",
        "{obj}：identity / generated 屬性變更（{src} → {dst}）請手動處理" => "{obj}: identity / generated attribute change ({src} → {dst}) must be handled manually",
        "{obj}：SQLite 無法修改欄位型別 / NULL / 預設值（需重建資料表）" => "{obj}: SQLite cannot alter column type / nullability / default (table rebuild required)",
        "{obj}：SQL Server 預設值為具名約束，請手動處理" => "{obj}: SQL Server defaults are named constraints; handle manually",
        "{obj}：identity 屬性變更請手動處理" => "{obj}: identity attribute change must be handled manually",
        "{obj}：此引擎不支援欄位變更" => "{obj}: this engine does not support column changes",
        "{obj}：目標多出的欄位（未含 DROP）" => "{obj}: column only in target (DROP not included)",
        "需 SQLite 3.35+" => "Requires SQLite 3.35+",
        "若此唯一索引由 UNIQUE 約束建立，請改用 DROP CONSTRAINT" => "If this unique index backs a UNIQUE constraint, use DROP CONSTRAINT instead",
        "{table}.{fk}：SQLite 無法新增外鍵（需重建資料表）" => "{table}.{fk}: SQLite cannot add foreign keys (table rebuild required)",
        "{table}.{fk}：SQLite 無法刪除外鍵（需重建資料表）" => "{table}.{fk}: SQLite cannot drop foreign keys (table rebuild required)",
        "視圖 {name}：目標多出（未含 DROP）" => "View {name}: only in target (DROP not included)",
        "視圖 {name}：來源無定義" => "View {name}: the source has no definition",
        "視圖本體引用的表未限定資料庫，請在目標資料庫的連線環境下執行" => "Tables referenced in the view body are not database-qualified; run this while connected to the target database",
        "{rtype} {name}：目標多出（未含 DROP）" => "{rtype} {name}: only in target (DROP not included)",
        "{name}：來源無定義" => "{name}: the source has no definition",
        "定義沿用來源（{src}），若內含 schema 限定名請改為 {dst}" => "Definition taken from the source ({src}); change any schema-qualified names to {dst}",
        "請在目標資料庫的連線環境下執行" => "Run while connected to the target database",
        "快照路徑無效" => "Invalid snapshot path",
        "目錄不存在：{dir}" => "Directory does not exist: {dir}",
        "讀取快照失敗：{err}" => "Failed to read the snapshot: {err}",
        "快照格式錯誤：{err}" => "Invalid snapshot format: {err}",
        "快照版本 {v} 高於本程式支援的 {max}，請更新 db-kit" => "Snapshot version {v} is newer than the supported {max}; please update db-kit",

        // ---- cli/compare.rs ----
        "請以 -d 指定要擷取的資料庫 / schema" => "Specify the database / schema to capture with -d",
        "擷取結構中… {done}/{total}" => "Capturing schema… {done}/{total}",
        "已存快照：{path}（{tables} 表 / {views} 視圖 / {routines} 程序，{bytes} bytes）" => "Snapshot saved: {path} ({tables} tables / {views} views / {routines} routines, {bytes} bytes)",
        "種類" => "kind",
        "標籤" => "label",
        "擷取時間" => "captured at",
        "資料表數" => "tables",
        "視圖數" => "views",
        "程序 / 函式 / 觸發器數" => "routines",
        "快照版本" => "snapshot version",
        "產生程式版本" => "app version",
        "{role}未指定資料庫 / schema" => "No database / schema specified for the {role}",
        "擷取{role}結構中… {done}/{total}" => "Capturing {role} schema… {done}/{total}",
        "來源" => "source",
        "目標" => "target",
        "目標為快照檔，無法套用同步 SQL" => "The target is a snapshot file; sync SQL cannot be applied",
        "結構一致，無需同步。" => "Schemas match; nothing to sync.",
        "在目標「{db}」執行 {n} 句同步 DDL（{d} 句為高破壞）" => "Run {n} sync DDL statements on target \"{db}\" ({d} destructive)",
        "套用中… {i}/{n}" => "Applying… {i}/{n}",
        "第 {i} 句失敗（{obj}）：{err}\n{sql}" => "Statement {i} failed ({obj}): {err}\n{sql}",
        "已套用 {n} 句同步 DDL" => "Applied {n} sync DDL statements",
        "{n} 句（{d} 句高破壞，{s} 項未能自動產生）" => "{n} statements ({d} destructive, {s} could not be generated)",
        "結構一致，無差異。" => "Schemas match; no differences.",
        "發現 {n} 項結構差異" => "Found {n} schema differences",

        // ---- cli/args.rs：ConnArgs 與 stress 的 help（v0.29 起漏收，害 `dbk --lang en` 在 debug build
        //      直接觸發 cli/mod.rs 的 debug_assert 而 panic）----
        "全域連線與輸出旗標（flatten 到所有子指令；`global = true` 讓它們可放在子指令前後）。" => {
            "Global connection and output flags (flattened into every subcommand; `global = true` lets them appear before or after the subcommand)."
        }
        "壓力測試：多執行緒重複執行同一段查詢，量測 TPS 與延遲分佈（唯讀；寫入語句會被擋下）" => {
            "Stress test: replay one statement from multiple threads and measure TPS and latency distribution (read-only; writes are blocked)"
        }
        "並行執行緒數（1..64）" => "Number of concurrent threads (1..64)",
        "每執行緒迭代次數。與 --seconds 互斥；兩者皆未給時預設跑 100 次" => {
            "Iterations per thread. Mutually exclusive with --seconds; defaults to 100 when neither is given"
        }
        "改以「持續時間」計：跑滿 N 秒（含暖機與爬升）" => {
            "Measure by duration instead: run for N seconds (including warmup and ramp-up)"
        }
        "執行緒逐步進場的爬升秒數（僅 --seconds 模式有意義）" => {
            "Seconds over which threads ramp up (only meaningful with --seconds)"
        }
        "每執行緒暖機次數（不計入統計）" => "Warmup iterations per thread (excluded from the statistics)",
        "每次迭代之間的間隔（毫秒）" => "Delay between iterations (milliseconds)",
        "每次查詢的取列上限（0 = 完整取回）" => "Row cap per query (0 = fetch everything)",
        "單次查詢逾時（毫秒；0 = 不逾時）" => "Timeout per query (milliseconds; 0 = no timeout)",

        // ---- cli/args.rs：schema / compare 子命令 help ----
        "結構快照（擷取整庫結構為 JSON 檔，供日後比對）" => "Schema snapshots (capture a whole database schema to a JSON file for later comparison)",
        "比對來源與目標（結構 / 資料列），可輸出或套用同步 SQL" => "Compare source and target (schema / rows); print or apply sync SQL",
        "擷取目前連線 / 資料庫的結構為 JSON 快照檔" => "Capture the current connection / database schema to a JSON snapshot file",
        "輸出檔路徑（.json）" => "Output file path (.json)",
        "不含建表 DDL（檔案較小；無法比對 charset / engine 等 DDL 層差異）" => "Exclude CREATE TABLE DDL (smaller file; DDL-level differences such as charset / engine cannot be compared)",
        "不含預存程序 / 函式 / 觸發器" => "Exclude stored procedures / functions / triggers",
        "顯示快照檔摘要（種類 / 資料庫 / 表數 / 擷取時間）" => "Show a snapshot file summary (kind / database / table count / captured time)",
        "結構比對：表 / 欄位 / 索引 / 外鍵 / 視圖 / 程序；可輸出同步 DDL" => "Schema comparison: tables / columns / indexes / foreign keys / views / routines; can print sync DDL",
        "目標：已存連線名稱 / id、連線字串，或 .json 快照檔路徑" => "Target: saved connection name / id, connection string, or .json snapshot path",
        "來源（省略 = 全域連線旗標 --conn / --url）；同樣接受連線或快照檔" => "Source (omit = global --conn / --url); also accepts a connection or snapshot file",
        "來源資料庫 / schema（預設沿用 -d）" => "Source database / schema (defaults to -d)",
        "目標資料庫 / schema（預設同來源）" => "Target database / schema (defaults to the source's)",
        "名稱比對忽略大小寫" => "Ignore case when matching names",
        "忽略欄位註解差異" => "Ignore column comment differences",
        "忽略欄位預設值差異" => "Ignore column default differences",
        "不比對預存程序 / 函式 / 觸發器" => "Skip stored procedures / functions / triggers",
        "輸出同步 SQL（使目標與來源一致）而非差異表" => "Print sync SQL (make the target match the source) instead of a diff table",
        "同步 SQL 含 DROP 語句（刪除目標多出的表 / 欄 / 視圖）" => "Include DROP statements in sync SQL (remove tables / columns / views only in target)",
        "同步 SQL 含程序 / 函式 / 觸發器" => "Include routines in sync SQL",
        "直接在目標執行同步 SQL。需 --yes；含高破壞語句時另需 --force" => "Apply sync SQL on the target directly. Requires --yes; --force too when destructive statements are included",
        "有差異時以非零結束碼結束（腳本 / CI 用）" => "Exit non-zero when differences are found (for scripts / CI)",

        // ---- compare/data.rs + cli compare data ----
        "目標缺少對應主鍵欄位 {col}" => "The target lacks primary-key column {col}",
        "來源與目標沒有同名欄位可比對" => "Source and target share no columns to compare",
        "寫入暫存檔失敗：{err}" => "Failed to write the temp file: {err}",
        "建立暫存檔失敗：{err}" => "Failed to create the temp file: {err}",
        "讀取暫存檔失敗：{err}" => "Failed to read the temp file: {err}",
        "此資料庫種類不支援資料比對" => "This database kind does not support data comparison",
        "來源資料表沒有主鍵，無法以主鍵比對" => "The source table has no primary key; cannot compare by key",
        "來源與目標是同一張表" => "Source and target are the same table",
        "目標連線標記為正式環境，未允許套用同步" => "The target connection is marked as production; applying sync is not allowed",
        "含二進位欄位，以原字串比對（跨引擎可能不可比）" => "Binary columns are compared as raw strings (may not be comparable across engines)",
        "兩側主鍵排序與比較器不一致，已改用雜湊比對" => "Primary-key ordering differs from the comparer; switched to hash comparison",
        "無主鍵" => "no primary key",
        "預檢相同（筆數 / 主鍵範圍一致）" => "precheck identical (row count / key range match)",
        "預檢有差異（僅預檢）" => "precheck differs (precheck only)",
        "預檢失敗：{err}" => "precheck failed: {err}",
        "請以 -d 指定來源資料庫 / schema" => "Specify the source database / schema with -d",
        "資料比對的目標必須是連線，不能是快照檔" => "The target of a data comparison must be a connection, not a snapshot file",
        "比對中… {table} {i}/{n} · 來源 {s} 列 / 目標 {d} 列 · +{ins} ~{upd} -{del}" => "Comparing… {table} {i}/{n} · source {s} rows / target {d} rows · +{ins} ~{upd} -{del}",
        "資料一致，無需同步。" => "Data match; nothing to sync.",
        "套用同步到目標「{db}」：{i} INSERT / {u} UPDATE / {d} DELETE（{t} 表）" => "Apply sync to target \"{db}\": {i} INSERT / {u} UPDATE / {d} DELETE ({t} tables)",
        "{n} 句同步 SQL 失敗" => "{n} sync SQL statements failed",
        "+{ins} ~{upd} -{del}" => "+{ins} ~{upd} -{del}",
        "套用同步到目標「{dst}」：{i} INSERT / {u} UPDATE / {d} DELETE" => "Apply sync to target \"{dst}\": {i} INSERT / {u} UPDATE / {d} DELETE",
        "同步 SQL 超過文字上限，請改用 --apply 或縮小範圍" => "Sync SQL exceeds the text limit; use --apply or narrow the scope",
        "新增（目標缺）" => "inserts (missing in target)",
        "更新（值不同）" => "updates (values differ)",
        "刪除（目標多出）" => "deletes (only in target)",
        "相同" => "identical",
        "來源列數" => "source rows",
        "目標列數" => "target rows",
        "策略" => "strategy",
        "耗時（ms）" => "elapsed (ms)",
        "截斷原因" => "truncated",
        "DELETE 已停用" => "DELETE suppressed",
        "比對被截斷，為安全不輸出 DELETE" => "The comparison was truncated; DELETE is withheld for safety",
        "主鍵" => "primary key",
        "來源獨有欄位（忽略）" => "source-only columns (ignored)",
        "目標獨有欄位（不受影響）" => "target-only columns (untouched)",
        "已套用" => "applied",
        "失敗" => "failed",
        "已套用 {a}，失敗 {f}" => "applied {a}, failed {f}",
        "僅來源有：{list}" => "Only in source: {list}",
        "僅目標有：{list}" => "Only in target: {list}",
        "合計 +{ins} ~{upd} -{del}" => "Total +{ins} ~{upd} -{del}",
        "已取消" => "Cancelled",
        "資料列比對：以主鍵逐列比對兩表（或整庫），可輸出 / 套用同步 SQL" => "Row comparison: compare two tables (or a whole database) row by row on the primary key; print or apply sync SQL",
        "來源表名（與 --all 互斥）" => "Source table name (mutually exclusive with --all)",
        "目標：已存連線名稱 / id 或連線字串（省略 = 與來源同一連線）" => "Target: saved connection name / id or connection string (omit = same connection as the source)",
        "目標表名（預設同來源）" => "Target table name (defaults to the source's)",
        "比對整庫（來源 ∩ 目標的資料表；略過視圖與無主鍵表）" => "Compare the whole database (tables in both source and target; views and tables without a primary key are skipped)",
        "先以 COUNT / MIN / MAX 預檢，看起來相同的表直接略過（僅 --all）" => "Precheck with COUNT / MIN / MAX first and skip tables that look identical (--all only)",
        "只做預檢，不逐列比對（僅 --all）" => "Precheck only, no row-by-row comparison (--all only)",
        "將同步 SQL 輸出到 stdout（不執行）" => "Print sync SQL to stdout (do not execute)",
        "在目標直接執行同步 SQL。需 --yes；含 --include-deletes 時另需 --force" => "Execute sync SQL on the target directly. Requires --yes; --force too with --include-deletes",
        "同步 SQL 含 DELETE（刪除目標多出的列）" => "Include DELETE in sync SQL (remove rows only in target)",
        "每側最多掃描列數（0 = 不限）" => "Maximum rows to scan per side (0 = unlimited)",
        "每類差異保留的樣本列數" => "Sample rows kept per difference category",
        "忽略的欄位（可重複）" => "Columns to ignore (repeatable)",
        "忽略字串尾端空白" => "Ignore trailing whitespace in strings",
        "比對策略：auto（排序合併，失敗自動退雜湊）| merge | hash" => "Comparison strategy: auto (sort-merge, falls back to hash) | merge | hash",
        "套用時任一批失敗即中止（預設：該批改逐句重放，隔離壞列後繼續）" => "Stop when any batch fails while applying (default: replay that batch statement by statement, isolating bad rows, then continue)",
        "允許對標記為正式環境（prod）的目標連線套用" => "Allow applying to a target connection marked as production (prod)",
        // ---- cli/args.rs：dbk mcp ----
        "以 MCP（stdio JSON-RPC）伺服器模式啟動，把唯讀資料庫工具提供給 AI 用戶端（Claude Code / Codex）" => {
            "Start as an MCP (stdio JSON-RPC) server exposing read-only database tools to AI clients (Claude Code / Codex)"
        }
        // ---- cli/mcp.rs ----
        "這些工具唯讀地存取使用者在 db-kit 選定的資料庫連線。寫查詢前先用 describe_table 確認欄名；查詢一律加 LIMIT；不要猜測不存在的表或欄位。" => {
            "These tools give read-only access to the database connection the user selected in db-kit. Call describe_table before writing a query; always add LIMIT; never guess tables or columns that you have not listed."
        }
        "MCP 伺服器已啟動（stdio）；等待用戶端 initialize…" => "MCP server started (stdio); waiting for the client to initialize…",

        // ---- dbtools/mod.rs：AI 助手的唯讀資料庫工具 ----
        "資料庫 / schema 名稱；省略則用目前對話的資料庫" => "Database / schema name; defaults to the current database of this conversation",
        "此為正式環境連線，請保持查詢輕量（小 LIMIT、避免全表掃描）。" => "This is a production connection: keep queries light (small LIMIT, avoid full scans).",
        "列出此連線上的資料庫 / schema。" => "List the databases / schemas on this connection.",
        "列出資料庫裡的 {noun}（含視圖）。" => "List the {noun}s in a database (including views).",
        "取得一個 {noun} 的欄位（名稱 / 型別 / 可空 / 主鍵 / 預設值 / 註解）、索引與外鍵。寫查詢前請先用它確認欄名。" => {
            "Get the columns (name / type / nullable / primary key / default / comment), indexes and foreign keys of a {noun}. Use it to confirm column names before writing a query."
        }
        "抓取一個 {noun} 的前幾列樣本（最多 {max} 列），用來了解資料長相。{prod}" => {
            "Fetch the first few sample rows of a {noun} (at most {max}) to see what the data looks like.{prod}"
        }
        "預設 {n}" => "Default {n}",
        "對目前連線執行**唯讀** MongoDB 查詢。參數 query 為 JSON：find 用 {\"collection\":\"..\",\"filter\":{},\"sort\":{},\"projection\":{},\"limit\":N}；聚合用 {\"collection\":\"..\",\"pipeline\":[…]}（省略 db 則用目前資料庫）。禁止 $out / $merge 與任何寫入。結果最多 {max} 列、{kb} KB。{prod}" => {
            "Run a **read-only** MongoDB query on the current connection. `query` is JSON: find with {\"collection\":\"..\",\"filter\":{},\"sort\":{},\"projection\":{},\"limit\":N}; aggregate with {\"collection\":\"..\",\"pipeline\":[…]} (db defaults to the current database). $out / $merge and any write are forbidden. At most {max} rows / {kb} KB.{prod}"
        }
        "對目前連線執行**唯讀** Redis 命令（如 GET k、HGETALL h、SCAN 0 MATCH user:* COUNT 100；可用 \"2:GET k\" 指定 DB index）。只放行讀取類命令；KEYS 會全庫掃描，請改用 SCAN。{prod}" => {
            "Run a **read-only** Redis command on the current connection (e.g. GET k, HGETALL h, SCAN 0 MATCH user:* COUNT 100; prefix \"2:GET k\" to pick the DB index). Only read commands are allowed; KEYS scans the whole keyspace, prefer SCAN.{prod}"
        }
        "對目前連線執行**唯讀** SQL（單一語句）。寫 SQL 前請先用 describe_table 確認欄名；一律加 LIMIT（結果最多 {max} 列、{kb} KB）。禁止 INSERT / UPDATE / DELETE / DDL；可寫 CTE 與 EXPLAIN ANALYZE 寫入語句也會被擋。{prod}" => {
            "Run a **read-only** SQL statement (one statement) on the current connection. Call describe_table first to confirm column names; always add LIMIT (at most {max} rows / {kb} KB). INSERT / UPDATE / DELETE / DDL are rejected, as are writable CTEs and EXPLAIN ANALYZE over writes.{prod}"
        }
        "MongoDB 查詢 JSON" => "MongoDB query JSON",
        "Redis 命令列" => "Redis command line",
        "要執行的 SQL（單一語句）" => "The SQL to run (one statement)",
        "結果列數上限，預設 {n}" => "Maximum rows to return, default {n}",
        "取得一條唯讀查詢的執行計畫（EXPLAIN），用來判斷索引是否用上、哪個節點最貴。不會執行寫入語句。" => {
            "Get the execution plan (EXPLAIN) of a read-only query to see whether indexes are used and which node is the most expensive. Never runs write statements."
        }
        "要解釋的查詢（單一語句）" => "The query to explain (one statement)",
        "一次只能執行一條語句；請拆成多次呼叫" => "Only one statement per call; split it into several calls",
        "唯讀工具只允許查詢語句（偵測到 `{kw}`）；不要嘗試寫入" => "Read-only tool: only query statements are allowed (detected `{kw}`); do not attempt writes",
        "唯讀工具不允許可寫 CTE（含 `{w}`）" => "Read-only tool: writable CTEs are not allowed (contains `{w}`)",
        "唯讀工具不允許 EXPLAIN 寫入語句（含 `{w}`；EXPLAIN ANALYZE 會真的執行）" => {
            "Read-only tool: EXPLAIN over a write statement is not allowed (contains `{w}`; EXPLAIN ANALYZE really executes it)"
        }
        "MongoDB 查詢必須是 JSON 物件：{e}" => "The MongoDB query must be a JSON object: {e}",
        "MongoDB 查詢必須是 JSON 物件" => "The MongoDB query must be a JSON object",
        "不允許的鍵：{k}（只接受 db / collection / filter / sort / projection / limit / pipeline）" => {
            "Key not allowed: {k} (only db / collection / filter / sort / projection / limit / pipeline)"
        }
        "唯讀工具不允許 {k} 階段" => "Read-only tool: the {k} stage is not allowed",
        "唯讀工具不允許 Redis 命令 `{cmd}`；只放行讀取類命令（GET / HGETALL / SCAN / TTL …）" => {
            "Read-only tool: Redis command `{cmd}` is not allowed; only read commands (GET / HGETALL / SCAN / TTL …) are permitted"
        }
        "此連線種類不支援 run_query；請改用 list_tables / describe_table / sample_rows" => {
            "run_query is not supported for this connection kind; use list_tables / describe_table / sample_rows instead"
        }
        " | …（另有 {n} 欄未列出）" => " | …({n} more columns not shown)",
        "…（文字達 {kb} KB 上限，只顯示前 {shown} 列，共取回 {total} 列）" => "…(text hit the {kb} KB cap; showing the first {shown} of {total} fetched rows)",
        "（無結果集；rows_affected = {n}）" => "(no result set; rows_affected = {n})",
        "{label}：{n} 欄" => "{label}: {n} columns",
        "（無欄位資訊：資料表可能不存在，請用 list_tables 確認名稱）" => "(no column info: the table may not exist; confirm the name with list_tables)",
        "（另有 {n} 欄未列出）" => "({n} more columns not shown)",
        "索引：" => "Indexes:",
        "（無索引）" => "(no indexes)",
        "（無法取得索引資訊；請勿假設任何索引存在）" => "(index info unavailable; do not assume any index exists)",
        "外鍵：" => "Foreign keys:",
        "（無外鍵）" => "(no foreign keys)",
        "（無法取得外鍵資訊）" => "(foreign key info unavailable)",
        "…（內容過長，其餘已截斷）" => "…(content too long; the rest was truncated)",
        "…（共 {total} 筆，只列前 {n} 筆）" => "…({total} in total; only the first {n} listed)",
        "未指定 database：請先呼叫 list_databases，再以 database 參數指定" => "No database given: call list_databases first, then pass the database parameter",
        "工具逾時（{ms} ms）；請縮小查詢範圍或加 LIMIT" => "Tool timed out ({ms} ms); narrow the query or add LIMIT",
        "（此連線沒有可列出的資料庫）" => "(this connection has no databases to list)",
        "（此資料庫沒有資料表）" => "(this database has no tables)",
        "缺少 table" => "Missing table",
        "\n（樣本 {n} 列）" => "\n({n} sample rows)",
        "缺少 query" => "Missing query",
        "\n（顯示 {n} 列；結果已在 {cap} 列處截斷，需要更多請縮小範圍或加條件）" => "\n({n} rows shown; the result was cut at {cap} rows — narrow the query or add conditions for more)",
        "\n（共 {n} 列）" => "\n({n} rows)",
        "此連線種類不支援 explain_query" => "explain_query is not supported for this connection kind",

        // ---- llm/tools.rs ----
        "此對話未附帶資料庫連線，無法使用資料庫工具" => "No database connection is attached to this conversation, so database tools are unavailable",

        // ---- agent.rs：資料庫工具指引 ----
        "{kind} 連線，目前資料庫：{db}" => "{kind} connection, current database: {db}",
        "{kind} 連線" => "{kind} connection",
        "【資料庫工具】你可以用這些工具直接讀取使用者目前在 db-kit 的 {target}：{names}。全部唯讀。寫查詢前先用 describe_table 確認欄名與型別；查詢一律加 LIMIT；不要猜測不存在的表或欄位，先 list_tables。需要看資料時直接呼叫工具，不要請使用者代跑；回答時附上你實際執行的查詢。" => {
            "[Database tools] You can use these tools to read the user's current {target} in db-kit directly: {names}. All read-only. Call describe_table to confirm column names and types before writing a query; always add LIMIT; never guess tables or columns — list_tables first. When you need data, call the tools yourself instead of asking the user to run queries; include the queries you actually ran in your answer."
        }
        "此連線是正式環境：查詢保持輕量（小 LIMIT、避免全表掃描、不要重複同一條查詢）。" => {
            "This connection is production: keep queries light (small LIMIT, no full scans, do not repeat the same query)."
        }

        // ---- review_run/ + cli/run_script.rs：審查並執行 ----
        "此連線種類不支援審查並執行" => "Review & run is not supported for this connection type",
        "無法判斷目前的資料庫，請先選擇資料庫" => "Unable to determine the current database; please select one first",
        "擷取查詢未通過唯讀檢查，已中止：{sql}" => "The capture query failed the read-only check and was aborted: {sql}",
        "讀不到資料表 {table} 的欄位" => "Unable to read the columns of table {table}",
        "擷取查詢回傳的欄數不符（預期 {want}，實得 {got}）" => "The capture query returned an unexpected number of columns (expected {want}, got {got})",
        "主鍵最大值不是整數：{v}" => "The maximum key value is not an integer: {v}",
        "無法解讀列數：{v}" => "Unable to parse the row count: {v}",
        "含交易控制語句（BEGIN / COMMIT / ROLLBACK）。本流程逐句自動提交，交易控制會落在連線池的不同連線上，請移除後再執行。" => "Contains transaction control (BEGIN / COMMIT / ROLLBACK). This flow autocommits statement by statement, so transaction control would land on different pooled connections. Remove it and try again.",
        "含切換 session 狀態的語句（USE / SET / DECLARE / 暫存表 / LOCK）。連線池不保證下一句用同一條連線，請移除或改在查詢分頁執行。" => "Contains session-state statements (USE / SET / DECLARE / temporary tables / LOCK). The connection pool does not guarantee the next statement uses the same connection. Remove them or run the script in a query tab.",
        "含程序 / 函式 / 觸發器本體，逐句切分不可靠。請改在查詢分頁執行。" => "Contains a procedure / function / trigger body, which cannot be split into statements reliably. Run it in a query tab instead.",
        "仍含未代入的具名參數（:name）。" => "Still contains unresolved named parameters (:name).",
        "DROP DATABASE / SCHEMA 無法以本流程備份，請先用「備份」做完整傾印。" => "DROP DATABASE / SCHEMA cannot be backed up by this flow. Take a full dump with Backup first.",
        "呼叫預存程序：程序內容無法分析，這句沒有回滾。" => "Calls a stored procedure: its body cannot be analyzed, so this statement has no rollback.",
        "可寫 CTE（WITH … DELETE / UPDATE / INSERT）：無法安全擷取前像，這句沒有回滾。" => "Writable CTE (WITH … DELETE / UPDATE / INSERT): the before-image cannot be captured safely, so this statement has no rollback.",
        "一句同時改動多張表（或 CASCADE 連帶影響其他表），只涵蓋主要目標表。" => "The statement changes several tables (or cascades to other tables); only the main target table is covered.",
        "無法解析這句的目標與條件，這句沒有回滾。" => "Unable to parse this statement's target and condition, so it has no rollback.",
        "權限 / 使用者 / 序列等變更不會自動產生反向語句，需手動回復。" => "No reverse statement is generated for permission / user / sequence changes; revert them manually.",
        "沒有可執行的語句" => "No executable statements",
        "前面第 {n} 句也改動了 {table}：列數估算以目前狀態為準，實際執行時會在這句前重新擷取。" => "Statement {n} also changes {table}: the row estimate reflects the current state; the before-image is re-captured right before this statement runs.",
        "探測失敗：{err}" => "Probe failed: {err}",
        "{table} 的欄位 {cols} 型別無法以字面值無損還原；這些欄位有值的列不會自動回滾。" => "Columns {cols} of {table} have types that cannot be restored losslessly as literals; rows with values in them are not rolled back automatically.",
        "找不到資料表 {table}（資料庫 {db}）" => "Table {table} not found (database {db})",
        "{table} 受影響約 {rows} 列，超過擷取上限 {cap} 列：前像無法完整備份。" => "About {rows} rows of {table} are affected, over the capture limit of {cap}: the before-image cannot be fully backed up.",
        "{table} 沒有主鍵或唯一鍵：無法定位被修改的列，這句沒有回滾。" => "{table} has no primary or unique key: changed rows cannot be located, so this statement has no rollback.",
        "這句修改了鍵欄位 {cols}：執行後無法依原鍵找回這些列，這句沒有回滾。" => "This statement changes key columns {cols}: the rows cannot be found by their old keys afterwards, so it has no rollback.",
        "{table} 沒有主鍵且語句含 JOIN：同一列可能被重複擷取。" => "{table} has no primary key and the statement joins other tables: the same row may be captured more than once.",
        "新增的列以「{key} 大於執行前最大值」認定；若執行期間有其他連線同時新增，回滾腳本會把那些列標為需人工確認。" => "Inserted rows are identified as \"{key} greater than the maximum before execution\"; if another connection inserts at the same time, the rollback script marks those rows for manual review.",
        "無法從語句判斷新增了哪些列，而 {table} 有 {rows} 列、超過擷取上限 {cap}：這句沒有回滾。" => "The inserted rows cannot be determined from the statement, and {table} has {rows} rows, over the capture limit of {cap}: this statement has no rollback.",
        "{table} 沒有主鍵或唯一鍵：新增的列無法精確刪除。" => "{table} has no primary or unique key: inserted rows cannot be deleted precisely.",
        "{table} 沒有主鍵或唯一鍵：只能還原被刪除的列，修改與新增無法精確還原。" => "{table} has no primary or unique key: only deleted rows can be restored; updates and inserts cannot be reverted precisely.",
        "無法判斷索引屬於哪張表，而資料庫有 {n} 張表（上限 {cap}）：這句沒有回滾。" => "Unable to tell which table the index belongs to, and the database has {n} tables (limit {cap}): this statement has no rollback.",
        "無法從語句判斷索引屬於哪張表，會擷取整個資料庫（{n} 張表）的結構。" => "Unable to tell from the statement which table the index belongs to; the structure of the whole database ({n} tables) will be captured.",
        "{table} 有 {rows} 列，超過擷取上限 {cap}：結構可以還原，資料不行。" => "{table} has {rows} rows, over the capture limit of {cap}: the structure can be restored, the data cannot.",
        "{table} 沒有主鍵或唯一鍵：結構變更造成的資料改變無法逐列還原。" => "{table} has no primary or unique key: data changes caused by the structure change cannot be restored row by row.",
        "不需要" => "Not needed",
        "完整" => "Full",
        "部分" => "Partial",
        "無" => "None",
        "只產生備份（未執行）" => "Backup only (not executed)",
        "已完成" => "Completed",
        "執行失敗" => "Execution failed",
        "已中止" => "Stopped",
        "未執行" => "Not run",
        "成功" => "Succeeded",
        "可以執行" => "Safe to run",
        "注意風險後再執行" => "Run after reviewing the risks",
        "不建議執行" => "Not recommended",
        "審查並執行報告" => "Review & Run Report",
        "項目" => "Item",
        "內容" => "Value",
        "狀態" => "Status",
        "原因" => "Reason",
        "資料庫種類" => "Engine",
        "資料庫" => "Database",
        "正式環境" => "Production",
        "是" => "Yes",
        "否" => "No",
        "開始" => "Started",
        "結束" => "Finished",
        "擷取上限（列 / 句）" => "Capture limit (rows / statement)",
        "AI 審查結論" => "AI review verdict",
        "語句" => "Statement",
        "影響列數" => "Rows affected",
        "回滾" => "Rollback",
        "前後差異" => "Before / after",
        "{table}：改 {u} / 增 {i} / 刪 {d}" => "{table}: {u} updated / {i} inserted / {d} deleted",
        "注意事項" => "Notes",
        "檔案" => "Files",
        "rollback.sql 依「最後一句先還原」排列；被註解掉的語句代表無法確定能安全還原，請人工確認後再取消註解。" => "rollback.sql is ordered last statement first; commented-out statements could not be confirmed safe to restore — review them before uncommenting.",
        "執行前後差異" => "Before / After Differences",
        "連線 {conn} · 資料庫 {db} · {at}" => "Connection {conn} · Database {db} · {at}",
        "（沒有擷取到任何差異）" => "(No differences captured)",
        "狀態：{status}，影響 {n} 列" => "Status: {status}, {n} rows affected",
        "結構變更（回滾用的反向 DDL）" => "Structure changes (reverse DDL for rollback)",
        "修改 {u}、新增 {i}、刪除 {d}、未變 {n}" => "{u} updated, {i} inserted, {d} deleted, {n} unchanged",
        "前像或後像超過擷取上限，差異不完整。" => "The before- or after-image exceeded the capture limit; the differences are incomplete.",
        "此表沒有主鍵或唯一鍵，只能以整列內容比對增刪，無法判斷哪一列被修改。" => "This table has no primary or unique key: rows are compared by their full contents, so inserts and deletes are detected but not which row was updated.",
        "執行後已不存在的欄位：{cols}" => "Columns that no longer exist after execution: {cols}",
        "執行後新增的欄位：{cols}" => "Columns added by execution: {cols}",
        "鍵" => "Key",
        "欄位" => "Column",
        "執行前" => "Before",
        "執行後" => "After",
        "欄位已刪除" => "column dropped",
        "…另有 {n} 列修改未列出，完整內容見 snapshots/ 目錄。" => "…{n} more updated rows not listed; see snapshots/ for the full data.",
        "刪除的列" => "Deleted rows",
        "新增的列" => "Inserted rows",
        "…另有 {n} 列未列出，完整內容見 snapshots/ 目錄。" => "…{n} more rows not listed; see snapshots/ for the full data.",
        "欄位 {col} 的值無法以 SQL 字面值無損還原（型別 {ty}）" => "The value of column {col} cannot be restored losslessly as a SQL literal (type {ty})",
        "此表有 GENERATED ALWAYS 的 identity 欄，Oracle 不接受明確值；以下 INSERT 可能被拒絕，屆時請改用 BY DEFAULT 或手動處理。" => "This table has a GENERATED ALWAYS identity column and Oracle rejects explicit values; the INSERTs below may fail — switch it to BY DEFAULT or handle them manually.",
        "（此列的 INSERT 無法產生）" => "(Unable to generate the INSERT for this row)",
        "警告：前像或後像超過擷取上限而被截斷，以下回滾只涵蓋已擷取到的列。" => "Warning: the before- or after-image was truncated at the capture limit; the rollback below only covers the captured rows.",
        "此表沒有主鍵或唯一鍵，無法精確定位要刪除的列" => "This table has no primary or unique key, so the rows to delete cannot be located precisely",
        "（此列的 DELETE 無法產生）" => "(Unable to generate the DELETE for this row)",
        "（此列的 UPDATE 無法產生）" => "(Unable to generate the UPDATE for this row)",
        "UPDATE 之後依主鍵找不到這列（主鍵可能被改掉，或被觸發器刪除），補回可能造成重複資料" => "This row cannot be found by its primary key after the UPDATE (the key may have changed, or a trigger deleted it); re-inserting it may create duplicates",
        "警告：符合的列超過擷取上限，只備份了前 {n} 列；以下回滾不完整。" => "Warning: the matching rows exceed the capture limit and only the first {n} were backed up; the rollback below is incomplete.",
        "此表沒有主鍵或唯一鍵，無法定位要還原的列" => "This table has no primary or unique key, so the rows to restore cannot be located",
        "整表還原：先清空，再寫回備份當下的所有列。" => "Whole-table restore: clear the table, then write back every row from the backup.",
        "（這句不需要或無法產生回滾語句）" => "(This statement needs no rollback, or none could be generated)",
        "需人工確認" => "Review manually",
        "請指定輸出目錄" => "Please specify an output folder",
        "無法建立輸出目錄 {dir}：{e}" => "Unable to create the output folder {dir}: {e}",
        "目標：{target}　回滾：{level}" => "Target: {target}  Rollback: {level}",
        "新增了哪些列要執行後才知道；這段回滾會在執行後產生。" => "Which rows get inserted is only known after execution; this part of the rollback is generated afterwards.",
        "這句沒有自動產生的回滾，請依上方說明手動處理。" => "No rollback was generated for this statement; handle it manually as described above.",
        "無法自動產生：{what}" => "Could not be generated automatically: {what}",
        "{name} 是這句新建的程序 / 函式，請手動刪除。" => "{name} is a procedure / function created by this statement; drop it manually.",
        "結構變更的精確反向 DDL 要執行後才能產生；以下是執行前的定義，供手動還原參考。" => "The exact reverse DDL can only be generated after execution; the definitions before execution are listed below for manual restore.",
        "{name} 執行前的定義" => "Definition of {name} before execution",
        "{table} 的資料前像（{n} 列）已存於 snapshots/；精確的資料還原語句會在執行後產生。" => "The before-image of {table} ({n} rows) is saved in snapshots/; exact data restore statements are generated after execution.",
        "此表沒有主鍵或唯一鍵：假設前像中的列全部受到影響。" => "This table has no primary or unique key: all rows in the before-image are assumed to be affected.",
        "前像的鍵值無法還原成字面值，改用執行前的預估回滾。" => "The key values in the before-image cannot be turned into literals; using the pre-execution estimated rollback instead.",
        "此表沒有主鍵或唯一鍵，無法比對修改。" => "This table has no primary or unique key, so updates cannot be compared.",
        "這句回報新增 {n} 列，但依主鍵範圍找到 {found} 列：可能混入其他連線同時新增的列" => "The statement reported {n} inserted rows but {found} were found by key range: rows inserted concurrently by other connections may be included",
        "腳本含本流程不支援的語句，未執行任何動作：\n{list}" => "The script contains statements this flow does not support; nothing was run:\n{list}",
        "db-kit 回滾腳本" => "db-kit rollback script",
        "連線：{conn}　資料庫：{db}　種類：{kind}　產生時間：{at}" => "Connection: {conn}  Database: {db}  Engine: {kind}  Generated: {at}",
        "依執行前後的前後像比對產生；某句若拿不到後像，該段改用執行前的預估。" => "Generated by comparing before- and after-images; where an after-image could not be captured, that part falls back to the pre-execution estimate.",
        "依執行前的前像產生（腳本尚未執行）：UPDATE 整列寫回、DELETE 補回；前後相依的語句請人工確認。" => "Generated from before-images (the script has not run): UPDATEs write whole rows back and DELETEs are re-inserted; review statements that depend on each other manually.",
        "【執行中】這是執行過程中的暫存版本，只涵蓋到目前這句為止。" => "[IN PROGRESS] Interim version written during execution; it only covers statements up to the current one.",
        "最後一句排在最前面，請由上往下執行。被註解掉的語句需人工確認後再取消註解。" => "The last statement comes first; run from top to bottom. Review commented-out statements before uncommenting them.",
        "這是正式環境連線，需要明確確認才能執行。" => "This is a production connection; explicit confirmation is required to run.",
        "有語句沒有完整回滾，需要明確確認才能執行。" => "Some statements have no complete rollback; explicit confirmation is required to run.",
        "執行到第 {n} 句時，它的回滾等級降為「{level}」，已停在這句之前。" => "When execution reached statement {n}, its rollback level dropped to \"{level}\"; stopped before it.",
        "擷取前像失敗：{err}" => "Failed to capture the before-image: {err}",
        "第 {n} 句：{msg}" => "Statement {n}: {msg}",
        "第 {n} 句的前像超過擷取上限 {cap} 列，已停在這句之前。" => "The before-image of statement {n} exceeds the capture limit of {cap} rows; stopped before it.",
        "這句執行失敗，資料庫沒有套用它的變更，不需要回滾。" => "This statement failed and the database did not apply its changes; no rollback is needed.",
        "第 {n} 句執行失敗：{err}" => "Statement {n} failed: {err}",
        "擷取後像失敗，這句的回滾改用執行前的預估：{err}" => "Failed to capture the after-image; this statement's rollback falls back to the pre-execution estimate: {err}",
        "輸出目錄必須是絕對路徑" => "The output folder must be an absolute path",
        "不是審查並執行的輸出目錄：{path}" => "Not a review & run output folder: {path}",
        "讀取 stdin 失敗：{e}" => "Failed to read stdin: {e}",
        "讀取腳本 {path} 失敗：{e}" => "Failed to read script {path}: {e}",
        "無法啟動審查指令：{e}" => "Unable to start the review command: {e}",
        "無法把提示寫給審查指令：{e}" => "Unable to write the prompt to the review command: {e}",
        "審查指令結束碼 {code}" => "The review command exited with code {code}",
        "資料庫：{db}　語句：{n}　擷取上限：{cap} 列 / 句" => "Database: {db}  Statements: {n}  Capture limit: {cap} rows / statement",
        "約 {rows} 列" => "~{rows} rows",
        "✗ 第 {n} 句：{msg}" => "✗ Statement {n}: {msg}",
        "腳本含本流程不支援的語句，未執行任何動作" => "The script contains statements this flow does not support; nothing was run",
        "AI 審查中…" => "AI review in progress…",
        "AI 審查結論：{v}" => "AI review verdict: {v}",
        "審查指令沒有輸出任何內容" => "The review command produced no output",
        "執行腳本" => "run the script",
        "AI 審查結論為 STOP：只產生備份、不執行（確定要執行請加 --ignore-verdict）" => "The AI review verdict is STOP: backup only, not executed (add --ignore-verdict to run anyway)",
        "未加 --yes：只產生審查與備份，不執行。" => "No --yes: generating the review and backup only, not executing.",
        "目標連線標記為正式環境，請再加 --allow-prod 確認" => "The target connection is marked as production; add --allow-prod to confirm",
        "有 {n} 句沒有完整回滾，未執行。確認可以接受請再加 --allow-incomplete" => "{n} statements have no complete rollback; not executed. Add --allow-incomplete if that is acceptable",
        "#{n} 擷取前像 {detail}" => "#{n} capturing before-image {detail}",
        "#{n} 執行" => "#{n} executing",
        "#{n} 擷取後像" => "#{n} capturing after-image",
        "輸出目錄：{dir}" => "Output folder: {dir}",
        "審查並執行 SQL 腳本：逐句擷取前後像、產生回滾腳本與差異報告到輸出目錄。未加 --yes 只產生審查與備份" => "Review and run a SQL script: capture before/after images per statement and write a rollback script and diff report to the output folder. Without --yes, only the review and backup are generated",
        "SQL 腳本檔（- = 從 stdin 讀）" => "SQL script file (- = read from stdin)",
        "輸出目錄：每次在底下建立一個子目錄，放腳本、審查、回滾腳本、前後像與報告" => "Output folder: each run creates a subfolder with the script, review, rollback script, before/after images and reports",
        "AI 審查指令：審查提示從 stdin 餵入、stdout 存成 review.md（如 \"claude -p\"）" => "AI review command: the review prompt is fed on stdin and stdout is saved as review.md (e.g. \"claude -p\")",
        "附給 AI 的前像樣本列數（0 = 不附資料，只給結構與列數）" => "Sample rows from the before-image to include for the AI (0 = no data, only structure and row counts)",
        "只把審查提示印到 stdout 後結束（不擷取、不執行）" => "Print the review prompt to stdout and exit (no capture, no execution)",
        "每句前像的擷取上限（列）" => "Before-image capture limit per statement (rows)",
        "接受「有語句沒有完整回滾」仍執行" => "Run even if some statements have no complete rollback",
        "目標連線標記為正式環境時，執行需加上此旗標" => "Required to run when the target connection is marked as production",
        "AI 審查結論為 STOP 時仍執行（預設只產生備份）" => "Run even if the AI review verdict is STOP (default: backup only)",

        // ---- ssh/（終端機 / SFTP / 認證）+ commands/ssh.rs ----
        "SSH 認證失敗：{detail}" => "SSH authentication failed: {detail}",
        "SSH 主機金鑰驗證失敗：{detail}" => "SSH host key verification failed: {detail}",
        "使用者已取消 SSH 連線" => "The SSH connection was cancelled by the user",
        "SFTP 錯誤：{detail}" => "SFTP error: {detail}",
        "此連線未啟用 SSH" => "SSH is not enabled for this connection",
        "未填寫 SSH 使用者名稱" => "SSH username is empty",
        "找不到 SSH 主機：{id}" => "SSH host not found: {id}",
        "SSH 連線不存在或已關閉" => "The SSH connection does not exist or has been closed",
        "終端機不存在或已關閉" => "The terminal does not exist or has been closed",
        "SFTP 工作階段不存在或已關閉" => "The SFTP session does not exist or has been closed",
        "同時開啟的 SSH 連線已達上限（{n}）" => "The limit of concurrent SSH connections ({n}) has been reached",
        "同時開啟的終端機已達上限（{n}）" => "The limit of concurrent terminals ({n}) has been reached",
        "找不到待回答的 SSH 提示（可能已逾時）" => "No pending SSH prompt found (it may have timed out)",
        "無法讀取 known_hosts，為防中間人而拒絕連線：{e}" => "Cannot read known_hosts; connection refused to prevent a man-in-the-middle attack: {e}",
        "無法保存 host key 指紋：{e}" => "Failed to save the host key fingerprint: {e}",
        "{host} 的主機金鑰與已記錄的指紋不符，已拒絕連線（可能遭中間人攻擊）" => "The host key of {host} does not match the recorded fingerprint; connection refused (possible man-in-the-middle attack)",
        "未信任 {host} 的主機金鑰" => "The host key of {host} was not trusted",
        "ssh-agent" => "ssh-agent",
        "公鑰" => "public key",
        "密碼" => "Password",
        "鍵盤互動" => "keyboard-interactive",
        "沒有可用的認證方式" => "No usable authentication method",
        "沒有可用的認證方式（{detail}）" => "No usable authentication method ({detail})",
        "伺服器接受了 {methods} 但要求進一步認證" => "The server accepted {methods} but requires further authentication",
        "伺服器拒絕了 {methods} 認證（帳號 / 密碼 / 金鑰不正確）" => "The server rejected {methods} authentication (incorrect username / password / key)",
        "找不到 ssh-agent" => "ssh-agent not found",
        "ssh-agent 讀取金鑰清單失敗：{e}" => "Failed to list keys from ssh-agent: {e}",
        "ssh-agent 沒有任何金鑰" => "ssh-agent holds no keys",
        "私鑰 {path} 受密語保護" => "The private key {path} is protected by a passphrase",
        "私鑰密語" => "Private key passphrase",
        "請輸入 {label} 的密碼" => "Enter the password for {label}",
        "伺服器要求互動輸入，但目前模式無法詢問使用者" => "The server requires interactive input, but the current mode cannot prompt the user",
        "等待 OpenSSH agent named pipe 逾時" => "Timed out waiting for the OpenSSH agent named pipe",
        "OpenSSH agent：{a}；Pageant：{b}" => "OpenSSH agent: {a}; Pageant: {b}",
        "開啟 SSH 通道失敗：{e}" => "Failed to open an SSH channel: {e}",
        "要求 PTY 失敗：{e}" => "PTY request failed: {e}",
        "伺服器拒絕配置 PTY" => "The server refused to allocate a PTY",
        "要求 shell 失敗：{e}" => "Shell request failed: {e}",
        "伺服器拒絕開啟 shell" => "The server refused to start a shell",
        "送出啟動指令失敗：{e}" => "Failed to send the startup command: {e}",
        "寫入終端機失敗：{e}" => "Failed to write to the terminal: {e}",
        "調整終端機大小失敗：{e}" => "Failed to resize the terminal: {e}",
        "SSH 通道已被伺服器關閉" => "The SSH channel was closed by the server",
        "等待伺服器回覆逾時" => "Timed out waiting for the server's reply",
        "無效的 base64 輸入" => "Invalid base64 input",
        "要求 sftp 子系統失敗：{e}" => "sftp subsystem request failed: {e}",
        "拒絕刪除根目錄或目前目錄" => "Refusing to delete the root or current directory",
        "資料夾內的項目超過 {max} 個，請改用終端機（例如 tar）處理" => "The folder contains more than {max} items; use the terminal (for example tar) instead",
        "遠端已有同名檔案，無法建立資料夾：{path}" => "A file with the same name exists on the remote, so the folder cannot be created: {path}",
        "遠端已有同名項目：{path}" => "An item with the same name already exists on the remote: {path}",
        "本機已有同名資料夾：{path}" => "A local folder with the same name already exists: {path}",
        "讀不到憑證 {path}：{e}" => "Cannot read certificate {path}: {e}",
        "{detail}；另外略過：{skipped}" => "{detail}; also skipped: {skipped}",
        "密語不正確，請再輸入一次（{path}）" => "Wrong passphrase, please try again ({path})",
        "PEM 標示為加密，卻沒有 DEK-Info" => "The PEM is marked as encrypted but has no DEK-Info",
        "不支援的 PEM 加密方式：{name}（可支援 DES-EDE3-CBC、DES-CBC、AES-128/192/256-CBC）" => "Unsupported PEM encryption: {name} (supported: DES-EDE3-CBC, DES-CBC, AES-128/192/256-CBC)",
        "PEM 的 DEK-Info IV 格式錯誤" => "Malformed DEK-Info IV in the PEM",
        "DSA（ssh-dss）金鑰：OpenSSH 7.0 起預設停用、9.8 起移除，多數伺服器已不接受。請改用 ed25519 或 RSA 3072 以上的金鑰。" => "DSA (ssh-dss) key: disabled by default since OpenSSH 7.0 and removed in 9.8; most servers no longer accept it. Use an ed25519 key or RSA 3072 or larger.",
        "SSH.COM（SECSH）格式的私鑰：請先轉成 OpenSSH 格式，例如 ssh-keygen -i -f <檔案> > id_key，或用 PuTTYgen 的 Import 再 Export OpenSSH key。" => "SSH.COM (SECSH) private key: convert it to OpenSSH format first, e.g. ssh-keygen -i -f <file> > id_key, or PuTTYgen Import then Export OpenSSH key.",
        "這是公鑰，不是私鑰。請選對應的私鑰檔（通常是同名、沒有 .pub 的那個）。" => "This is a public key, not a private key. Choose the matching private key file (usually the same name without .pub).",
        "這是 OpenSSH 憑證（-cert.pub），不是私鑰。請選對應的私鑰；憑證放在私鑰旁邊（<私鑰>-cert.pub）或在主機設定指定，連線時會一起使用。" => "This is an OpenSSH certificate (-cert.pub), not a private key. Choose the matching private key; put the certificate next to it (<key>-cert.pub) or set it on the host, and it is used when connecting.",
        "這是 X.509（SSL / TLS）憑證，不是 SSH 金鑰。SSH 要用的是私鑰檔（例如 id_ed25519、.ppk、.pem）。" => "This is an X.509 (SSL / TLS) certificate, not an SSH key. SSH needs a private key file (e.g. id_ed25519, .ppk, .pem).",
        "看起來是 PKCS#12（.pfx / .p12）憑證包或加密的二進位私鑰。請先轉出 PEM 私鑰，例如 openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem。" => "This looks like a PKCS#12 (.pfx / .p12) bundle or an encrypted binary key. Export a PEM private key first, e.g. openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem.",
        "認不得的金鑰格式。支援 OpenSSH、PuTTY PPK、PKCS#8、PEM（PKCS#1 RSA / SEC1 EC，含 OpenSSL 加密）與 DER；Xshell / SecureCRT 的金鑰請先在該軟體裡匯出成 OpenSSH 格式。" => "Unrecognised key format. Supported: OpenSSH, PuTTY PPK, PKCS#8, PEM (PKCS#1 RSA / SEC1 EC, including OpenSSL encryption) and DER; export Xshell / SecureCRT keys as OpenSSH first.",
        "這把私鑰受密語保護，請輸入密語" => "This private key is passphrase-protected; enter the passphrase",
        "密語不正確（或不支援這種加密方式）：{e}" => "Wrong passphrase (or unsupported encryption): {e}",
        "無法解析私鑰：{e}" => "Cannot parse the private key: {e}",
        "解密後的內容不正確" => "The decrypted content is invalid",
        "憑證格式錯誤：{e}" => "Invalid certificate: {e}",
        "無效的金鑰 id：{id}" => "Invalid key id: {id}",
        "金鑰庫裡找不到這把金鑰（可能已刪除）：{id}" => "Key not found in the key store (it may have been deleted): {id}",
        "加密私鑰失敗：{e}" => "Failed to encrypt the private key: {e}",
        "轉成 OpenSSH 格式失敗：{e}" => "Failed to convert to OpenSSH format: {e}",
        "產生金鑰失敗：{e}" => "Failed to generate the key: {e}",
        "名稱不能是空的" => "The name cannot be empty",
        "讀不到公鑰" => "Cannot read the public key",
        "這張憑證簽的不是這把金鑰" => "This certificate was not issued for this key",
        "本機已有同名項目：{path}" => "An item with the same name already exists locally: {path}",
        "略過 {n} 個同名項目" => "Skipped {n} existing items",
        "略過 {n} 個連結或特殊檔案" => "Skipped {n} links or special files",
        "略過 {a} 個同名項目、{b} 個連結或特殊檔案" => "Skipped {a} existing items and {b} links or special files",
        "內容太大，無法在編輯器存檔（上限 {max} MiB）" => "The content is too large to save from the editor (limit {max} MiB)",
        "伺服器回傳可疑的檔名，已中止刪除：{name}" => "The server returned a suspicious file name; deletion aborted: {name}",
        "本機檔案已存在：{path}" => "The local file already exists: {path}",
        "遠端檔案已存在：{path}" => "The remote file already exists: {path}",
        "無效的檔名：{name}" => "Invalid file name: {name}",
        "找不到檔案或目錄" => "No such file or directory",
        "權限不足" => "Permission denied",
        "伺服器不支援此操作" => "The server does not support this operation",
        "SFTP 連線已中斷" => "The SFTP connection was lost",
        "已到檔案結尾" => "End of file reached",
        "SFTP 協定錯誤" => "SFTP protocol error",
        "操作失敗（伺服器未說明原因；常見為檔案已存在或目錄非空）" => "Operation failed (the server gave no reason; commonly the file already exists or the directory is not empty)",
        "SFTP 操作逾時" => "SFTP operation timed out",
        "SFTP I/O 錯誤：{e}" => "SFTP I/O error: {e}",
        "SFTP 錯誤：{e}" => "SFTP error: {e}",
        "本機檔案錯誤：{e}" => "Local file error: {e}",
        _ => return None,
    })
}
