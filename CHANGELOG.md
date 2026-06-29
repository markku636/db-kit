# Changelog

## 查詢結果可匯出 Excel / SQL（統一走後端匯出管線）

查詢結果的「匯出」原本只能存 CSV / JSON / TSV / Markdown（前端純文字）。現改走後端 `export_rows`，與資料表匯出共用同一套 `render`，**新增 Excel (.xlsx) 與 SQL (INSERT)**，且文字格式也享有 CSV 注入防護 / BOM 等一致行為。

> 驗證：後端新增 `export_rows` command（重用 `render`，欄 + 列由前端帶回）；`cargo check` 綠燈、touched 檔 `cargo clippy` 零警告；前端 `tsc` + `eslint` + `vite build` 綠燈。

- 另存對話框格式：**CSV / Excel (.xlsx) / JSON / TSV / SQL (INSERT) / Markdown**，依副檔名自動選格式。
- 匯出來源沿用目前所見（含前端排序 / 篩選後的可視列）。
- 「複製 CSV / TSV / JSON / MD」剪貼簿按鈕維持前端即時序列化不變。

## Excel（.xlsx）匯出（致敬 Navicat「匯出至 Excel」）

匯出資料對話框新增 **Excel (.xlsx)** 格式，直接產生原生 Excel 活頁簿，不再只能用 CSV 繞道。

> 驗證：後端新增 `rust_xlsxwriter`（純 Rust、內含 zip + miniz_oxide，無 C / 系統相依，跨平台可打包）；`cargo test export::` 13 項全通過（含 xlsx 容器魔數與數字保真 2 項新測試）、新程式碼 `cargo clippy` 零警告；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 130 項全通過。

- **一張工作表 + 可選粗體標題列**：勾選「含欄位標題」時，首列為粗體欄名。
- **數字保真**：值預設寫成文字以免失真；僅當字串為「乾淨數字」且以 f64 最短往返表示一致時才寫成數值（Excel 可加總、右對齊）。前導零（`007`）、尾隨零小數（`1.50`）、超精度大整數、指數記法一律保留為文字。`NULL` 留空白格。
- **尊重既有篩選 / 排序 / 全部列或目前頁**（沿用 `export_table` 管線）。
- **上限保護**：欄數 > 16384 或列數 > 1048576 直接回報錯誤，不靜默截斷。
- 後端共用 `render()`，CLI（`dbk`）匯出亦自動支援 xlsx。

## 視覺化查詢建構器（Visual Query Builder，致敬 Navicat SQL Builder）

對標 Navicat 旗艦的 SQL Builder：不寫 SQL，靠勾選與下拉即可組出 SELECT 查詢，再一鍵帶入查詢編輯器執行 / 微調。僅關聯式（MySQL / PostgreSQL / SQLite）。

> 驗證：前端 `tsc --noEmit` + `eslint` + `vite build` 綠燈；新增 `buildSelectQuery` 純函式與 8 項 vitest（共 119 項全通過）。

### 功能
- **查詢面板工具列新增「建構器」**（Blocks 圖示，緊鄰格式化 / 分析）；開啟全幅對話框。
- **左欄挑表**：列出目前資料庫所有表（可搜尋過濾），點選加入 / 移除；加入時自動帶入該表全部欄位到 SELECT。
- **表卡欄位勾選**：每張已選表一張卡，逐欄勾選是否顯示（不勾＝`SELECT *`），標示 PK（琥珀）/ FK（連結圖示）/ 資料型別；首張為「基底表」。
- **視覺化 JOIN**：選 2 張以上表時，**由外鍵自動推斷 JOIN**（加入新表即試建、或按「由外鍵自動連接」整批補齊）；可手動改 JOIN 型別（INNER / LEFT / RIGHT / FULL，MySQL 隱藏 FULL）與左右連接欄位。
- **WHERE 條件**：表.欄 + 運算子（`= <> > >= < <= LIKE NOT LIKE IN NOT IN IS NULL IS NOT NULL`）+ 值；多條以各自 AND / OR 串接；數字值原樣比較、字串自動加引號（方言感知，MySQL 反斜線加倍）、`IN` 拆逗號、`IS NULL` 免值。
- **聚合 / 分組**：每個顯示欄位可設 `COUNT / COUNT DISTINCT / SUM / AVG / MIN / MAX` 與別名；**有聚合時自動以其餘欄位 GROUP BY**（Navicat 風）。
- **ORDER BY**（多欄 ASC / DESC）、**DISTINCT**、**LIMIT**。
- **右欄即時 SQL 預覽**（經 `formatSql` 美化），可**複製 SQL**或**帶入查詢編輯器**（沿用 per-連線 持久化）。

### 工程
- SQL 產生抽為 `src/sql.ts` 的純函式 `buildSelectQuery(kind, spec)`：跨方言識別字 / 字面值跳脫，單表省前綴、多表加前綴，聚合自動分組，可單元測試（零 React / Tauri 依賴）。
- 結構來源沿用既有 `er_model` command（一次取得表 + 欄 + 外鍵關係），無需新增後端。

## v0.1.7

- 啟用時的 splash logo 放大（`min(46vw, 440px)` → `min(62vw, 620px)`），開場品牌標誌更醒目。

## Redis 功能對齊 Another Redis Desktop Manager（本次）

把原本藏在右鍵選單的 Redis 操作搬上一眼可見的工具列，並補齊「另一款 Redis 工具」常用而本工具缺少的面板。

> 驗證：前端 `tsc --noEmit` + `vite build` 綠燈；後端 `cargo check` 無錯誤、零新增警告。

### 可見工具列（keys 檢視）
- 開啟 Redis 連線的 keys 後，工具列直接出現 **＋新增鍵 / 📊狀態 / 📡Pub/Sub / 🛠維運 / ⌨命令列** 按鈕（先前僅能從連線 / DB 節點右鍵進入，不易發現）。
- 新增鍵 / 伺服器狀態 / 命令列沿用既有對話框；刪除鍵、設定 TTL、重新命名仍可由鍵列右鍵或網格批次操作。

### 值檢視與格式化 + 大型集合分頁
- 鍵詳情的 String 值新增 **原始 / JSON / Hex** 檢視切換：JSON 自動美化（可回填）、Hex 經典 dump、顯示位元組數。
- hash / list / set / zset 改用後端**游標式分頁**（HSCAN/SSCAN/ZSCAN、list 用 LRANGE 視窗），每頁 200 筆、可「載入更多」，大鍵不再一次全載卡死。
- **成員 / 欄位過濾**：hash 比對 field、set/zset 比對 member（支援 `* ?`）、list 子字串。

### Pub/Sub 訂閱與發佈
- 新面板可訂閱頻道 / 樣式（`PSUBSCRIBE`），訊息經後端背景任務 + Tauri 事件即時推送；可暫停 / 清空 / 發佈訊息（回報訂閱者數）。
- 訂閱連線獨立持有；面板關閉、連線中斷或移除連線時自動取消訂閱、收掉背景任務（防洩漏）。

### 維運面板
- **慢查詢**（`SLOWLOG GET`，可 RESET）、**用戶端**（`CLIENT LIST`，可逐一 `CLIENT KILL`）、**大鍵**（`SCAN` 取樣 + `MEMORY USAGE`，依用量排序取前 N）。

### 後端
- 新增 Redis 專屬命令：`redis_key_page` / `redis_slowlog` / `redis_clients` / `redis_client_kill` / `redis_big_keys` / `redis_publish` / `redis_subscribe` / `redis_unsubscribe`，透過 `manager.redis_driver()` 取得 driver 本體直呼 inherent 方法（不必擴充 `DatabaseDriver` trait 與五驅動 dispatch）。

## 跨五大資料庫功能強化 + 正確性修正 + 資料格 / 查詢編輯器 / UI/UX 打磨

致敬 DBeaver / TablePlus / DataGrip / Navicat 的日常手感與功能廣度：補強資料呈現正確性、跨資料庫功能對齊與操作效率。
本批重點包含 **PostgreSQL 嚴格型別寫入修正**（整數 / 複合主鍵的列終於可編輯 / 刪除）、**MongoDB 完整查詢 + CRUD-via-JSON**（find / 聚合 / insert / update / delete）+ 索引管理、**CSV 匯入**、**整庫結構轉儲**、**欄位資料剖析**、**Ping 連線延遲**、`RETURNING` 顯示，以及多項由對抗式自我審查找出的細節修正（Excel BOM、多欄排序鍵序、空 filter 批次操作防護等）。

> 驗證：前端 `tsc` + `vite build` 綠燈、`cargo clippy` 新增程式碼零警告；後端 `cargo test --lib --include-ignored` **49/49 通過**（45 純函式 / SQLite 端到端 + 4 Docker 真實資料庫 MySQL 8 / PostgreSQL 16 / MongoDB 7 / Redis 7）。前端 **vitest 26 項全通過**（純函式邏輯抽至 `src/sql.ts`：SQL 多語句切分含 PG dollar-quoting / MySQL 雙反引號、CSV 跳脫、查詢歷史 / 收藏持久化守衛、跨資料庫識別字與字面值跳脫含 MySQL 反斜線方言）。後端測試涵蓋五大資料庫的連線 / `ping` / CRUD（含整數·複合主鍵 / set-NULL）/ 全 9 種篩選運算子 + AND·OR / DDL 欄位編輯 / 索引建刪 / EXPLAIN / RETURNING / ER 外鍵探索 / Mongo 聚合·CRUD-via-JSON / 匯出·匯入往返 / 欄位剖析 / 結構轉儲 / 備份還原（含非法檔被拒）/ 無主鍵編輯防護 / 注入安全 / `<unrenderable>` 型別呈現（含 BOOLEAN·UUID·NUMERIC·DECIMAL）等所有路徑。

### 修正：儲存格 `<unrenderable>`
- **日期時間欄位顯示 `<unrenderable>` 的 bug**：`string_fallback` 只試了 `NaiveDateTime` / `NaiveDate`，漏了帶時區的時間戳——MySQL `TIMESTAMP`、PostgreSQL `TIMESTAMPTZ`（sqlx 解碼為 `DateTime<Utc>`）與 `TIME`（`NaiveTime`），使 `created_at` 這類欄位整格顯示 `<unrenderable>`。三個 SQL driver 一併補齊，並統一格式化為 `YYYY-MM-DD HH:MM:SS`。
- **JSON / JSONB 欄位**：開啟 sqlx `json` 特性，MySQL JSON 與 PostgreSQL JSON/JSONB 改以 `serde_json::Value` 呈現（先前同樣 `<unrenderable>`）。
- **二進位欄位（BLOB / BYTEA）**：非合法 UTF-8 時改以 `0x…` 十六進位預覽（上限 64 bytes 並標總長度），取代 `from_utf8_lossy` 一堆替換字元的雜訊（共用 `db::bytes_to_display`）。
- MySQL unsigned 大整數溢位 `i64` 時退回 `u64`。
- **MongoDB `Decimal128`**（金融資料常見）直接顯示十進位字串（如 `9.99`），取代 fallback 的 `{"$numberDecimal":"9.99"}` extended JSON 雜訊。

### 資料表：儲存格右鍵選單 + 內容檢視器 + 鍵盤導覽
- **右鍵選單**（SQL 表）：檢視內容、複製值、複製整列（JSON / TSV）、**複製為 INSERT**、編輯儲存格、設為 NULL、**以此列為範本新增**、刪除此列。
- **儲存格內容檢視器**：檢視 / 編輯長文字、JSON、二進位；可一鍵格式化 JSON、複製，可編輯表直接套用變更或設 NULL。
- **鍵盤導覽**：方向鍵 / Tab 移動選取格、Enter / F2 進入編輯、Ctrl+C 複製、Esc 取消；單擊選取並高亮（藍框）。
- 共用剪貼簿 helper `copyToClipboard`（`navigator.clipboard` + textarea fallback）。
- **多欄排序**：Shift+點擊欄標題附加 / 切換排序欄，徽章顯示排序次序（單擊仍為單欄循環）。
- **重新整理**鈕（重讀目前頁）；**雙擊欄分隔線自動符合內容寬度**（canvas 量測，致敬 Navicat / TablePlus）。
- **每頁列數選擇器**（100 / 200 / 500 / 1000）；底部顯示「顯示 X–Y · 共 N 列」的範圍資訊。

- **依儲存格值篩選**：右鍵選單新增「篩選此值 / 排除此值」（NULL 自動轉 is null / is not null），即時帶入篩選列（致敬 TablePlus / DBeaver「Filter by value」）。
- **欄位標題右鍵選單**：升冪 / 降冪 / 清除排序、自動符合寬度、複製欄名、**複製整欄值（本頁）**、**隱藏此欄 / 顯示所有欄**（隱藏狀態 per-table 持久化，至少保留一欄）。
- 底部顯示**選取儲存格資訊**（欄名＝值，Excel 名稱框手感）。
- **即時尋找**（Ctrl+F 或「🔍 尋找」）：在目前頁就地標示符合片段並顯示符合格數（client-side，與伺服器端篩選互補）。
- **未套用變更保護**：有待套用編輯時，重新整理 / 切換頁面前先確認，避免靜默丟失。
- **整列表單檢視**：點列號開啟，逐欄檢視 / 編輯一列（寬表友善），可上下切換列（致敬 DBeaver 記錄檢視）。

### 查詢編輯器（補強）
- 編輯器內 **Tab 鍵插入兩個空格**（不再跳離）、**Ctrl+/ 切換行註解**，符合 SQL 編寫習慣。
- **查詢內容 per-連線 持久化**：切換連線 / 重開後沿用該連線上次的 SQL（localStorage）。
- **多語句執行**：SQL 以分號切分依序執行（略過字串 / 註解內的分號），最後一個結果集呈現，純寫入語句累計影響列數（sqlx 不允許單次多語句，故前端拆分）；多語句失敗會標示第幾條出錯。
- **收藏查詢**：具名收藏常用 SQL（localStorage），一鍵載回 / 刪除，與「歷史」並列。
- **查詢結果格複製**：點選儲存格高亮、Ctrl+C 複製、右鍵選單（複製值 / 整列 TSV / 整列 JSON / 整欄）。
- **匯出查詢結果到檔案**：原生另存對話框，依副檔名輸出 CSV（RFC4180 跳脫）/ JSON / TSV（後端 `save_text_file`）。

### 結構：複製建表 SQL（致敬 Navicat「Copy CREATE statement」）
- 後端新增 `table_ddl` command + driver 方法：MySQL `SHOW CREATE TABLE`、SQLite 取 `sqlite_master.sql`、PostgreSQL 以 information_schema 欄位 + 主鍵重建（盡力而為）。
- 結構分頁新增「📋 建表 SQL」，於唯讀檢視器顯示完整 CREATE 語句，可一鍵複製。

### 結構：索引檢視 + 刪除（四種資料庫一致）
- 後端新增 `table_indexes` command + driver 方法：MySQL（information_schema.STATISTICS）、PostgreSQL（pg_index）、SQLite（PRAGMA index_list / index_info）、MongoDB（listIndexes）。
- 結構分頁於欄位下方新增「索引」區，顯示名稱 / 欄位 / UNIQUE / PK 標記。
- **新增 / 刪除索引**（`create_index` / `drop_index`，關聯式）：索引區「＋ 新增索引」表單（名稱、欄位多選依點選順序組複合索引、唯一）；索引列尾「−」刪除非主鍵索引（含確認）。MySQL / PostgreSQL / SQLite 各以自身語法組 `CREATE [UNIQUE] INDEX` / `DROP INDEX`，皆以真實資料庫測試驗證（建立後讀回、刪除後確認消失）。

### ER 圖（致敬 Navicat / DBeaver 的 ER 工具）
- **縮放控制**（－ / ＋ / 百分比 / 適配視窗 / 重置）；表卡拖曳位移依縮放校正。
- **佈局持久化**：拖曳後的表卡位置存 localStorage（per 連線 / DB），重開沿用。
- **關聯高亮**：hover 表卡時，相關外鍵連線加亮、其餘淡出。

### 導覽 / 分頁
- **側欄搜尋過濾**：頂部搜尋框即時過濾連線與表名稱；搜尋表名也會讓其所屬連線浮現。
- **分頁管理**：中鍵關閉分頁、右鍵選單（關閉 / 關閉其他 / 全部關閉）、Ctrl+W 關閉作用中表分頁；分頁 tooltip 顯示 DB·表。
- **側欄表右鍵「產生 SQL」**（SQL 連線）：查詢前 100 筆、SELECT COUNT(*)、INSERT 範本、複製建表 SQL、複製表名；查詢類項目會載入查詢編輯器並切到查詢分頁（識別字依資料庫種類正確跳脫）。
- **複製連線**：連線右鍵新增「複製連線…」，以新 id 帶入既有設定開啟對話框，調整後另存為新連線。

### 連線
- **狀態列連線池監控**：已連線時每 4 秒輪詢 `pool_status`，顯示「使用中 / 總數 · 閒置」與類型色標連線點（呼應規劃 3.5）。
- **Ping 既有連線**：點擊狀態列連線池徽章即送出一次輕量往返（`ping_connection` → 各 driver `SELECT 1` / `PING`），回報「連線正常 · 延遲 N ms」，可確認長閒置連線（含 SSH 通道）是否仍有效——致敬 DBeaver / TablePlus 的 Ping。Mongo / Redis 未公開連線池統計，徽章顯示「⚡ Ping」而非誤導的「池 0/0」。
- 連線對話框：**測試連線顯示延遲（ms）**、Esc 關閉。

### 查詢編輯器（致敬商用 SQL 工具）
- **執行時間** 與 **回傳 / 影響列數** 狀態列；**查詢歷史**（localStorage，最近在前、去重、上限 50，可載回 / 清除）。
- **只執行反白選取段**（無選取則跑全部）；新增 **Ctrl+Enter** 與既有 F6 皆可執行。
- 結果可一鍵 **複製為 TSV / JSON**；結果表加列號與滿格 tooltip。

### 前端元件稽核修正（第四輪多代理稽核）
針對 ER 圖、對話框、共用 UI helper、Redis 編輯路徑稽核並修正：
- **修正 ER 圖切換 DB 的競態（bug）**：快速切換資料庫時較早的回應若晚到會覆蓋目前的圖；加 cancelled 守衛 + effect 清理。拖曳期間卸載對話框時的監聽洩漏亦修正。
- **修正並發對話框的 Promise 洩漏（bug）**：`uiConfirm`/`uiPrompt` 在前一個尚未回應時被再次呼叫，舊 Promise 會永遠懸而不決；改為先以「取消」結束舊請求；PromptDialog 相同 message+title 重用時不再殘留上次輸入。
- **修正 Redis RENAME 靜默覆蓋目的鍵（data-loss）**：改用 `RENAMENX`，目的鍵已存在則拒絕改名而非摧毀。
- 匯出 / 備份還原 / 清空歷史 加防重入守衛（避免另存對話框開啟期間重複觸發 / 重複還原）。
- 其餘 Redis 觀察（LREM 重複值刪首個、set 改名非原子）為既知設計取捨，已記錄。

### SSH / 機密 / 連線生命週期稽核修正（第三輪多代理稽核）
針對 SSH tunnel、OS keychain 機密儲存、連線生命週期與排程進行稽核並修正：
- **修正 SSH host-key 驗證的 fail-open 漏洞（security）**：`known_hosts` 損毀 / 無法寫入時，原本 `unwrap_or_default()` 會悄悄退回空表 → 對任何主機都走 TOFU「信任任意金鑰」，等同失去中間人防護。改為區分「檔案不存在」與「讀取 / 解析錯誤」，後者一律 **fail-closed 拒絕連線**；指紋無法持久化（含原子寫入 temp+rename）時亦拒絕，並修正過時的安全註解。
- **SSH 撥號 / 認證逾時**：`connect` 與 `authenticate_*` 加 20 秒逾時，黑洞 bastion 不再無限阻塞連線命令。
- **SSH accept 迴圈強健性**：單次 `accept()` 失敗不再終結整條 tunnel（記錄後略過續聽）。
- **修正並發 connect 同 id 的 tunnel 洩漏（robustness）**：被覆蓋的舊連線改在 insert 後收掉其 tunnel 背景任務 + driver。
- **修正排程保留份數跨排程誤刪（correctness）**：備份檔名以排程 id 命名空間化，「同 DB 同目錄」的不同排程不再互相刪除 / 同秒覆蓋。

### 深度安全 / 強健性稽核修正（第二輪多代理稽核）
針對「注入面 / 崩潰強健性 / Redis 驅動 / 匯出備份」四維稽核找出並修正：
- **DDL 注入強化**：`ALTER TABLE ADD COLUMN` 的 `data_type` / `default` 原為原樣字串插值；新增共用 `validate_column_spec` 阻擋 `;`、`--`、`/* */`、換行（保留 ENUM / DECIMAL 括號逗號等合法型別），三個 SQL driver 套用，並加單元測試。
- **CSV 公式注入防護**：匯出 CSV/TSV 時，以 `= + - @ tab CR` 開頭的值前置單引號，避免試算表把資料當公式執行。
- **SQL 匯出反斜線跳脫**：SQL INSERT 匯出（MySQL 方言）同時跳脫 `\`，避免含反斜線的值產生錯誤 / 不安全結果；空分隔符退回格式預設。
- **備份 / 還原強健性**：MongoDB 連線字串的帳密改為 percent-encode（含 `@ : /` 的密碼不再破壞備份）；Redis 備份密碼改走 `REDISCLI_AUTH` 環境變數（不再出現在行程列表）；SQLite 還原前先驗證來源為 SQLite 檔（標頭）並備份現有 DB 為 `.bak`；修正 MySQL 還原原本的空死分支為實際的客戶端偵測。
- **Redis 資料遺失防護**：唯讀 `type` 欄誤觸格內編輯會以 `SET` 把 list/set/zset/hash 覆蓋成 string；改為明確拒絕編輯 `type`。
- **Redis SCAN 去重 + 分頁 saturating**：SCAN 可能回傳重複 key，排序後去重避免重複列 / 灌水總數；分頁位移改用 saturating，與 SQL driver 一致。其餘觀察（二進位鍵、TTL 0 語意、db 數量、query 參數切分）已記錄供後續處理。

### 多代理對抗式審查修正（第一輪自我審查找出並修正）
經多代理對抗式程式碼審查（4 維度 + 逐項獨立驗證）找出並修正：
- **修正 PostgreSQL 非文字欄位篩選失效（bug）**：`build_where` 將值以 text 綁定但無轉型，PG 嚴格型別不隱式轉換，導致 `int = text` 報錯、資料分頁篩選對非文字欄位完全不可用。改為 `欄位::text op $n`，並加 int 欄位篩選的真實資料庫回歸測試。
- **修正中斷連線把使用者踢離查詢分頁（bug）**：`markDisconnected` 未把 `__query__` 哨兵視為有效作用鍵，中斷任一連線都會跳離查詢編輯器。改為保留 `__query__`。
- **修正多語句切分漏處理 PostgreSQL dollar-quoting（$$ … $$ / $tag$）**：函式 / DO 區塊本體的分號不再被誤切；加單元測試（含 `$1` 參數不誤判）。
- 小修：MongoDB `limit:0` 不再被當「不限」（夾為預設 200）、SQLite 運算式索引欄位不再因 NULL 而錯位、即時尋找計數略過隱藏欄、重載清除選取格、隱藏選取欄時清除選取避免鍵盤導覽卡住、變更每頁列數套用未套用變更確認、多語句改為呈現「最後一個結果集」。

### PostgreSQL 嚴格型別 — 寫入路徑與數值篩選修正（擴充測試覆蓋後找出，皆以真實 PG 回歸驗證）
舊測試僅用 **TEXT 主鍵 / 文字欄位**，掩蓋了以下嚴重問題。新增 **整數主鍵 + JSONB 欄位** 的 CRUD 測試後揭露並修正：
- **修正整數 / UUID 等主鍵的列無法更新 / 刪除（嚴重 bug）**：`update_cell` / `delete_row` 的 WHERE 以 `主鍵 = $n`（text 綁定），PG 嚴格型別下 `integer = text` 直接報錯，導致**絕大多數真實表（自增整數主鍵）的列完全無法編輯或刪除**。改為 `主鍵::text = $n`（等值比較正確、且免逐型別轉換）。
- **修正非文字欄位無法新增 / 更新（嚴重 bug）**：`insert_row` 的 `VALUES ($n)` 與 `update_cell` 的 `SET 欄 = $1` 以 text 綁定，插入 / 更新 int / numeric / bool / uuid / jsonb / 時間等欄位時報 `column is of type … but expression is of type text`。改為依 `information_schema.udt_name` 把參數轉成欄位實際型別（`$n::int4` / `::jsonb` / `::timestamptz`…，型別名僅允許識別字字元，仍走參數化綁定、無注入）。
- **修正數值 / 時間欄位的範圍篩選變字典序（bug）**：先前 `>,>=,<,<=` 一律以 `欄位::text` 比較，使 `id >= 3` 在 `{1,2,10,30}` 誤得 `{30}`（字典序 `'10' < '2'`）而非 `{10,30}`。改為排序運算子遇已知數值 / 時間型別時，把參數轉成該型別做原生比較（`欄位 op $n::型別`）；型別不明或文字欄位沿用 `::text`（等值 / LIKE / 文字排序皆正確）。型別查詢僅在篩選含排序運算子時觸發，不影響一般翻頁。
- 跨資料庫一致性已以真實資料庫驗證：**整數主鍵 CRUD** 於 SQLite（INTEGER affinity）、MySQL（寬鬆 coerce）、PostgreSQL（上述轉型修正）三者皆通過。

### 跨資料庫一致性（MySQL / PostgreSQL / MongoDB / SQLite）
- 通用資料格能力（多欄排序、依值篩選、每頁列數、隱藏欄、右鍵複製、內容檢視器、鍵盤導覽）對所有資料庫一致生效（Mongo 的 filter / sort 由 driver 對應到 `$or` / `$gt` / `$regex` 等）。
- **修正 MongoDB `LIKE` 語意（bug）**：原本僅把 `%` 換成 `.*` 且未錨定，導致 `LIKE 'abc'`（應為精確相等）與 `LIKE 'abc%'`（應為開頭符合）都退化成「子字串包含」；且未跳脫 regex 特殊字元，使 `LIKE '%@gmail.com'` 的 `.` 被當任意字元誤配。改為 `like_to_regex`：`%`→`.*`、`_`→`.`、跳脫 regex 特殊字元並以 `^…$` 錨定，加純函式單元測試 + 真實 Mongo 回歸測試。
- **修正 MongoDB `guess_bson` 型別推斷失真（bug）**：寫入 / 篩選時把字串推斷成數字，但 `"01234"`（ZIP / 代碼）會被轉成 `1234`（前導零消失）、超出 i64 範圍的長數字 ID 會被當 f64 而掉精度。改為僅在「數字正規表示與原字串完全一致」時才當整數、浮點僅接受含 `.`/`e`/`E` 的字串，其餘保留原字串。加單元測試。
- **複製為 INSERT** 依資料庫種類正確跳脫識別字（PostgreSQL 雙引號、MySQL/SQLite 反引號）；字串字面值依方言跳脫（**MySQL 額外加倍反斜線**，否則 `\b` 等會被當轉義；PostgreSQL / SQLite 視 `\` 為字面，不加倍）；Mongo 不顯示此項（改用複製 JSON）。加單元測試覆蓋各方言。
- **側欄「產生查詢」** 對 Mongo 集合產生 `{ db, collection, filter }` JSON 範本；對 SQL 表產生 SELECT/COUNT/INSERT。
- **ER 圖** 工具列鈕僅對關聯式資料庫啟用（Mongo / Redis 無外鍵概念，不再誤觸發 Unsupported 錯誤）。
- 鍵盤左右移動會略過隱藏欄。
- **MongoDB 查詢增強**：JSON 查詢支援 `sort` / `projection` / `limit`（未指定 limit 時預設 200，避免誤拉整個集合）。
- **修正多欄排序鍵序被字母重排（bug）**：`serde_json` 預設以 BTreeMap 解析物件、把鍵按字母排序，導致 `sort: {"name":1,"age":-1}` 被重排成依 age 為主——多欄排序優先序錯誤。改開 `serde_json` 的 `preserve_order` 特性（IndexMap 保留鍵序）；連帶讓 JSON 匯出欄序符合來源欄序。加多欄排序真實 Mongo 回歸測試。
- **MongoDB 聚合管線（aggregate）**：查詢 JSON 提供 `"pipeline": [ {…stage…}, … ]` 時改走 `aggregate`，支援 `$match` / `$group` / `$sum` / `$project` 等全部聚合階段（Mongo 旗艦功能）；查詢編輯器 placeholder 同時提示 find 與 aggregate 兩種格式。結果收集設 5000 筆安全上限（呼應 find 路徑，避免未收斂管線把整個集合拉進記憶體；要完整結果請在管線尾自加 `$limit`）。加真實 Mongo 回歸測試（`$match`+`$group`+`$sum`）。
- **MongoDB 索引管理**：補上 `create_index` / `drop_index`（先前僅有列出），與關聯式 driver 對齊；結構分頁的「＋ 新增索引 / − 刪除」對 Mongo 一併啟用（依點選順序組複合索引、可設唯一；預設 `_id_` 索引受保護不可刪）。欄位 / DDL 編輯仍僅限 SQL。加真實 Mongo 回歸測試（建立後讀回、刪除後消失）。
- **MongoDB 批次寫入（CRUD-via-JSON）**：查詢 JSON 除 find / aggregate 外，新增 `insert`（`insert_many`，貼上文件陣列即可匯入 JSON）、`update`（`{filter,set}` → `update_many` `$set`）、`delete`（`delete_many`，回報筆數）。**`update` 與 `delete` 的 filter 皆不可為空**——一致的安全防護，避免一個遺漏 filter 就誤改 / 誤刪整個集合（真要全集合操作請用明確條件如 `{"_id":{"$exists":true}}`）。讓 Mongo 查詢編輯器具備完整 CRUD 能力（致敬商用 Mongo 工具的 shell）。加真實 Mongo 回歸測試（insert 2 / update 2 / delete 2 / 空 filter 刪除被拒）。
- **查詢編輯器顯示 `RETURNING` 結果**（PostgreSQL / SQLite 3.35+）：`INSERT/UPDATE/DELETE … RETURNING …` 原本被當寫入語句、只回影響筆數而吞掉回傳列；改為偵測到 `RETURNING` 時走 `fetch_all` 取回並顯示回傳列（致敬 DataGrip / DBeaver）。加真實資料庫回歸測試。
- **欄位資料剖析**（致敬 Navicat / DataGrip）：資料格欄位標題右鍵「欄位統計」→ 後端 `column_stats`（`COUNT(*)` / `COUNT(欄)` / `COUNT(DISTINCT 欄)` + best-effort `MIN`/`MAX`）→ toast 顯示「總列數 · 非空 · 相異值 · 範圍 [min, max]」。MIN/MAX 重用各 driver 的儲存格渲染（型別正確），不支援的型別（如 JSON）自動略過範圍。關聯式三庫適用；加 SQLite（含 NULL / 重複值 / 範圍）與真實 MySQL 回歸測試。
- **轉儲整庫結構 SQL**（致敬 Navicat / DBeaver 的「轉儲結構」）：側欄資料庫節點右鍵「匯出結構 SQL…」→ 串接該庫所有表的建表 SQL（重用 `table_ddl`）→ 另存 `.sql`。關聯式資料庫適用（Mongo 集合無建表 SQL 會略過）；資料庫右鍵選單改為依連線種類顯示對應項目（Redis 維持新增鍵 / FLUSHDB，SQL 顯示轉儲結構）。加端到端測試（SQLite：含每表建表語句）。
- **CSV 資料匯入**（致敬 Navicat / DBeaver 匯入精靈，匯出的對稱功能）：資料格工具列「⬆ 匯入」開啟對話框 → 選 CSV/TSV 檔 → 逐列寫入目標表。RFC4180 解析器（引號欄位可含分隔符 / 換行 / `""` 轉義，**去除開頭 UTF-8 BOM**——Excel 匯出的 CSV 常帶 BOM，否則第一欄欄名被前置 `﻿` 對不上欄位、整批失敗；11 個純函式單元測試）；後端讀檔避免大檔過 JS bridge（含 100 MB 上限防 OOM；非 UTF-8 檔給明確指引而非難懂錯誤）；逐列走 driver 的 `insert_row`（沿用 PostgreSQL 嚴格型別的參數轉型修正，整數 / 時間欄位也能匯入）；選項：分隔字元（, / Tab / ;）、第一列為欄名（或自填欄名）、空欄位視為 NULL、遇錯即停 / 盡量匯入；回報成功 / 失敗列數與前 20 筆錯誤（含列號）。加端到端測試（SQLite，免 Docker：引號含逗號、空欄→NULL、整數欄匯入）。

### 全域 UI/UX 打磨（`styles.css`）
- 細捲軸融入深色主題、藍調文字選取色、鍵盤焦點環（focus-visible）、互動微過渡。
- UI chrome 預設不可選取（原生 App 手感），資料 / 輸入框 / `.mono` 仍可選取；移除 number input 微調鈕、修正深色底下拉選單可讀性。
- 資料格 / 查詢結果列**斑馬條紋**提升可讀性；重新整理時表格淡化提示載入中；SQL 編輯器可**垂直拖曳調整高度**。
- **快捷鍵說明**（工具列「⌨ 快捷鍵」或 F1）：彙整查詢、表格、分頁/全域三區的所有鍵盤操作，提升新增功能的可發現性。
- **全域錯誤邊界**：渲染錯誤時顯示友善訊息與「嘗試繼續 / 重新載入」，取代整頁白屏。

---

## EXPLAIN · SSH host key TOFU · DDL · ER 圖（本次）

一次補完 roadmap 剩餘四項。後端在 `DatabaseDriver` trait 加 `explain` / `alter_table` / `er_model` 三個預設方法（非關聯式回 Unsupported），三個 SQL driver 實作。

- **查詢效能分析（EXPLAIN）**：`explain_query` command；MySQL/PG 跑 `EXPLAIN <sql>`、SQLite 跑 `EXPLAIN QUERY PLAN <sql>`，結果用既有結果表呈現。查詢面板新增「🔬 分析」鈕。
- **SSH host key 驗證（TOFU）**：`ssh.rs` 的 handler 改為——計算 server key 指紋，與 `<config_dir>/dev.dbkit.app/ssh_known_hosts.json` 比對；首次連線記住（trust on first use），之後不符則拒絕（防 MITM）。先前是無條件接受。
- **結構編輯（DDL）**：`alter_table` command + `AlterOp`（add_column / drop_column / rename_column），各 SQL driver 以自身識別字跳脫組 `ALTER TABLE`。結構分頁新增「＋ 新增欄位」表單與每欄改名(✎)/刪除(−)。
- **ER 圖**：`er_model` command 回傳表 + 欄位（標 PK/FK）+ 外鍵關係（MySQL/PG 走 information_schema、SQLite 走 `PRAGMA foreign_key_list`）。工具列「🗺 ER 圖」開啟可拖曳表卡、SVG 連線的圖；可切換資料庫/schema。

---

## 資料匯出 + 多欄 OR 篩選（本次）

### 資料匯出（Navicat 風格多格式，`export.rs`）
- 新增 `export_table` command：尊重目前的篩選 / 排序 / AND·OR，將表格資料匯出成 **CSV / TSV / JSON / SQL INSERT / Markdown**。
- 選項：含/不含欄位標題、自訂分隔字元、NULL 呈現字串、UTF-8 BOM（方便 Excel 開 CSV）、SQL 目標表名、**匯出全部符合列 vs 只匯目前頁**。
- 逐頁（每批 2000 列）向 driver 取資料，安全上限 100 萬列；CSV 欄位/SQL 值/Markdown 儲存格皆做跳脫。
- 前端 `ExportDialog.tsx`：資料分頁「⬇ 匯出」鈕開啟，格式 + 選項 + 原生「另存」對話框；完成以 toast 回報列數/大小/路徑。

### 多欄篩選 AND / OR
- `DataQuery` 加 `match_any`；四個 driver 的 `build_where`（MySQL / PostgreSQL / SQLite）與 Mongo `build_filter` 依此以 `AND`/`OR`（Mongo `$or`）串接。
- `FilterBar` 在多條件時顯示「全部 (AND) / 任一 (OR)」切換。

---

## 持久化 · SSH Tunnel · 排程備份 · UX 套組（本次）

依相依性順序一次補完四大功能。

### 操作體驗優化（UX）
- **原生檔案選擇器**（接 `tauri-plugin-dialog`）：備份輸出/還原來源路徑、排程備份目錄、SQLite 檔案、SSH 私鑰路徑都加「瀏覽…」，免手打路徑（`capabilities/default.json` 加 `dialog:default`）。
- **編輯現有連線**：連線設定持久化後可重新編輯——連線對話框支援帶入既有設定（保留 id、標題改「編輯連線」），側欄 hover 出現 ✎/× 與右鍵選單。`save_connection` 改為密碼留空＝不變更（編輯時不必重打密碼，也不會誤刪 keychain）。
- **Toast 通知 + 樣式化確認框**（`ui.tsx`）：取代瀏覽器 `alert()`/`confirm()`；右下角滑出通知，刪除/還原等破壞性操作走統一的紅色確認框。
- **連線樹體驗**：右鍵選單（連線/中斷、重新整理資料庫、編輯、刪除）、連線中顯示 loading 轉圈、中斷時只收合該連線的展開節點。

### 驗證 / 修正（以 Docker 真實資料庫整合測試，7/7 通過）
- **修正 MySQL `list_databases` 回空清單的 bug**：原本用 `SHOW DATABASES` + `try_get::<String>().ok()`，但 sqlx-mysql 對該欄位常回 binary 型別導致解碼失敗、被 `.ok()` 默默丟棄，**整個資料庫清單變空（連線樹展不開）**。改用 `information_schema.SCHEMATA` 並加 bytes 解碼後備（`str_col`），`list_tables` / `table_columns` / `primary_key` 一併套用。
- **russh 改用 `ring` crypto backend**（`default-features=false, features=["ring","flate2","rsa"]`），避免預設的 aws-lc-sys 在 Windows 需要 NASM 才能編譯（減少建置前置需求）。
- 補上 `src-tauri/icons/icon.ico`（tauri-build 在 Windows 產生資源檔必需；原本只有 icon.png 會導致建置失敗）。
- 整合測試 `src-tauri/src/it_tests.rs`（`cargo test --lib it_tests -- --include-ignored`）：覆蓋五大資料庫的連線 / `ping` / CRUD / 多欄 AND 篩選、Redis 五型結構編輯 + 改名（RENAMENX 不覆蓋）/ 刪除 / TTL、SQLite 備份還原（含還原非法檔被拒、原庫不被覆蓋）、排程 next_run、連線持久化序列化（確認 secret 不落地）。並針對寫入路徑強化：**整數主鍵 CRUD**（SQLite / MySQL / PostgreSQL 三者）、**DDL 欄位編輯**（alter_table 新增 / 改名 / 刪除欄位，三者；含 SQLite 受限的 ALTER）、**ER 圖外鍵探索**（er_model：PG / MySQL 建父子表 + FK → 探索出關係、FK 欄標記）、**RETURNING 回傳列**（PG / SQLite）、**PostgreSQL 複合主鍵更新 / 刪除 + 複合主鍵偵測**、**整數欄位更新為 NULL**、**數值欄位範圍篩選原生比較**（PG / MySQL）、**OR 篩選模式**（match_any，PG / MySQL / Mongo `$or`）、**寫入值注入安全**（SQL 中繼字元字面儲存）、**EXPLAIN 查詢計畫**（MySQL / PostgreSQL / SQLite）、Mongo query JSON 介面（filter / sort / projection / limit）、Mongo `LIKE` 錨定 / `guess_bson` 型別推斷 / `Decimal128` 顯示。
- 測試（無需 Docker，`cargo test --lib` 直接跑，41 例）：`filter_op_sql` / `op_needs_value`（篩選運算子→SQL 對應，所有 driver 共用的單一真相來源）、`export()` 匯出管線端到端（分頁→render→寫檔）、`export::schema_dump`（整庫建表 SQL）、`backup::pct_encode`（Mongo URI userinfo percent-encoding，特殊字元密碼不破壞 URI）、`bytes_to_display`、`validate_column_spec`（注入阻擋）、`collect_relations`（FK 組裝）、`export::csv_field`（CSV 公式注入防護）、`export::sql_quote`（反斜線 / 單引號跳脫）、`export::render`（CSV/TSV/JSON/SQL/Markdown 五格式端到端輸出）、`import::parse_csv`（RFC4180 解析 10 例：引號含分隔符 / 換行、`""` 轉義、CRLF、自訂分隔符、空欄）、`import_csv` 端到端（SQLite：匯入 / 空欄→NULL / 整數欄 / 欄數不符回報 / stop_on_error）、`scheduler_next_run`、`scheduler::backups_to_prune`（備份保留清理——資料風險邏輯）、`persisted_connection_drops_secrets`、Mongo `like_to_regex` / `guess_bson` / `bson_to_string(Decimal128)`、PostgreSQL `pg_cast_suffix`（型別名注入防護）/ `pg_native_cast` / `bind_placeholder` / `is_ordering_op`。前端另有 `vitest` 26 例覆蓋 SQL 切分（含 PG dollar-quoting、MySQL 雙反引號識別字）/ 匯出格式 / 識別字與字面值跳脫（含 MySQL 反斜線方言）/ localStorage 持久化守衛（收藏查詢與歷史的損壞資料過濾）等純邏輯。

### 連線設定持久化 + OS keychain（`store.rs`）
- 連線設定寫入 `<app_config_dir>/connections.json`（原子寫入 temp + rename），**密碼 / SSH secret 一律存 OS keychain（`keyring`）**，磁碟不含任何密碼、也不回傳前端。
- 啟動自動載入連線清單（不自動連線）；`connect` / `test` / `backup` 於後端從 keychain hydrate 密碼（剛輸入的新密碼非空則跳過，向後相容）。
- 新增 command：`list_saved_connections` / `save_connection` / `remove_saved_connection`；側欄連線列新增刪除鈕（一併清除 keychain）。
- keychain 依平台選原生後端（Windows Credential Manager / macOS Keychain / Linux Secret Service），讀取失敗一律優雅降級為空密碼。

### SSH Tunnel（`ssh.rs`，`russh` 純 Rust）
- 連線前若啟用 SSH，開 `direct-tcpip` 本地轉發（`127.0.0.1:<OS 分配埠>`），driver 連本地埠；支援密碼 / 私鑰（passphrase）認證。
- tunnel 與 driver 生命週期綁定（`LiveConn`）：disconnect / close_all / test 一併收掉；driver 建立失敗時手動關閉 tunnel 避免任務洩漏。
- `ConnectionConfig` 新增 8 個 `#[serde(default)]` SSH 欄位（向後相容）；連線對話框新增可摺疊「SSH Tunnel」區塊（SQLite 隱藏）。
- 安全備註：此版本不驗 host key（dev 工具；TOFU 為後續）。

### 排程備份 + 備份歷史（`scheduler.rs`）
- 結構化週期（每 N 分 / 每 N 時 / 每天定時，`chrono::Local`），背景 tokio 迴圈每 30s 檢查到期排程；**僅在 app 開啟時執行**，關閉期間到期者不補跑。
- 排程持久化 `schedules.json`、歷史 `history.json`（上限 500 筆、newest-first）；fire 時以 `store::load_connection` 從 keychain 補密碼後呼叫既有 `backup::backup`，成敗都寫歷史。
- 保留份數（選填）：只刪該排程自己產出的檔。新增 command：`list/save/remove/toggle_schedule`、`run_schedule_now`、`list_backup_history`、`restore_from_history`、`clear_history`。
- `BackupDialog` 擴為三分頁（手動 / 排程 / 歷史）；歷史可一鍵還原（Redis 列停用，沿用「暫未支援」）。

### UX 套組
- **Redis 結構編輯**：新增 `KeyEdit`（serde `tag="action"`）+ trait 預設方法 `key_edit`（非 Redis 回 `Unsupported`）+ `key_edit` command。Redis driver 實作 List（LSET/LPUSH/RPUSH/LREM）/ Set（SADD/SREM）/ ZSet（ZADD/ZREM）/ Hash（HSET/HDEL）；鍵詳情彈窗各型別可就地編輯 / 新增 / 刪除元素，String 仍走 `update_cell`。
- **多欄複合篩選**：`FilterBar` 改多列（＋新增條件 / 移除），送出完整 `Filter[]`（後端早已 AND 串接）。AND-only；Mongo 同欄多條件後者勝；Redis 僅 `key` 欄有效。
- **欄寬拖曳**：資料表 `table-layout: fixed` + 表頭右緣可拖曳調整，per-table 寬度存於 `localStorage`；長值裁切（ellipsis）並可 hover 看全文。

---

## 備份 / 還原（本次）

### 新增
- **備份模組**（`backup.rs`）：手動備份與還原，策略為「官方 CLI 為主 + SQLite 檔案複製」。
  - MySQL → mysqldump / mysql；PostgreSQL → pg_dump / psql；MongoDB → mongodump / mongorestore（--archive 單檔）；Redis → redis-cli --rdb；SQLite → 直接複製檔案。
  - `backup_detect_cli`：偵測對應 CLI 是否在 PATH，UI 即時顯示狀態；找不到時給明確安裝提示。
  - 密碼以環境變數傳遞（MYSQL_PWD / PGPASSWORD），不出現在行程參數列表。
- **備份對話框**（`BackupDialog.tsx`）：工具列「備份」按鈕開啟；備份/還原模式切換、資料庫名稱、檔案路徑輸入、CLI 偵測狀態與結果顯示。

### 已知限制
- 輸出/輸入路徑目前為手動輸入（尚未接系統檔案選取對話框）。
- Redis 自動還原暫未支援（提示以 redis-cli 手動匯入 RDB）。
- 內建邏輯匯出（無 CLI 時的後備）除 SQLite 外尚未補完。

---

## Redis 支援（本次）— 五大資料庫到齊

### 新增
- **Redis driver**（`db/redis.rs`）：鍵值型，沿用「key 列表化」的表格手感。
  - `list_databases` → DB 0–15；`list_tables` → 虛擬節點 keys。
  - `table_data` → 以 **SCAN**（游標式，嚴禁 KEYS \*）列舉 key，呈現 key / type / ttl 三欄；key 作為主鍵；篩選的 key like/= 自動轉成 SCAN MATCH pattern。
  - **key_detail**（trait 新增的鍵值型專屬方法，非 Redis 預設回 None）：依型別展開五種結構 — String / List / Set / ZSet（含 score）/ Hash（field-value）。
  - `update_cell`：改 string 值或 TTL（EXPIRE/PERSIST）；`insert_row`：SET 新 key；`delete_row`：DEL。
  - `query`：接受原始 Redis 命令列（可加 `<db>:` 前綴選庫）。
- 前端：Redis 連線雙擊 key 開「鍵詳情」彈窗，依型別以對應表格/清單呈現；TTL 可直接在資料表編輯。
- 連線對話框移除「僅部分可連線」提示 — **五種資料庫全部可實際連線**。

### 架構
- `DatabaseDriver` trait 新增 `key_detail` 預設方法（回 None），讓鍵值型專屬能力不污染其他 driver。
- `Active` enum 與 connect/test 現已涵蓋全部 5 種，移除 unsupported catch-all。

---

## MongoDB 支援（本次）

### 新增
- **MongoDB driver**（`db/mongo.rs`）：文件型資料庫，沿用統一 `DatabaseDriver` trait 與 Navicat 表格手感。
  - `list_databases` → Mongo 資料庫；`list_tables` → 集合（kind=collection）。
  - `table_data` → 取一批文件，**聯集頂層欄位攤平成表格**（`_id` 固定第一欄），巢狀物件/陣列以 JSON 字串呈現。
  - `table_columns` → 抽樣 50 份文件推斷頂層欄位與 BSON 型別（「結構」分頁）。
  - 篩選 → Mongo find filter（比較運算子；like → 不分大小寫正規式）；排序 → sort document。
  - `update_cell` / `insert_row` / `delete_row` → 以 `_id` 定位的文件操作；ObjectId 字串自動轉型。
  - `query` → 接受 JSON `{db, collection, filter}` 回傳符合文件。
- mongodb crate 的 Client 內建連線池（maxPoolSize），無需自管池。
- 連線對話框開放 MongoDB；前端表格 / 編輯 / 篩選 / 排序元件直接沿用（`_id` 作為主鍵）。

### 可實際連線
- MySQL、PostgreSQL、SQLite、MongoDB（Redis 為後續階段）。

---

## 完整 CRUD + 篩選排序（本次）

### 新增
- **新增列 / 刪除列**：完成關聯式表的完整 CRUD。
  - 後端 `insert_row`（欄位+值，未列出欄交由 DB 預設）、`delete_row`（以主鍵定位，含 NULL 防呆）。
  - 前端：動作列 **＋ 新增列**（對話框可逐欄填值或標 NULL）、每列尾端 **−** 刪除鈕（含二次確認）。
- **排序**：點欄位標題循環切換 無 → ▲ 升冪 → ▼ 降冪；可一鍵清除。
- **篩選**：單欄條件列，運算子白名單（=, ≠, >, ≥, <, ≤, like, is null, not null），值以參數綁定。
- `table_data` 改用 `DataQuery`（page / page_size / filters / sorts），三個 SQL driver 各自組 WHERE/ORDER（識別字轉義、值綁定，MySQL/SQLite 用 `?`、PG 用 `$N`）。

### 安全
- 篩選運算子限定白名單；排序與篩選的欄位皆經識別字轉義；所有值一律參數綁定，不字串拼接。

---

## P1/P2 + 寫操作 + PostgreSQL（本次）

### 新增
- **PostgreSQL 支援**：新增 `db/postgres.rs`，完整實作 driver trait（schema 對應資料庫層級、`$1` 佔位符、雙引號識別字、pg_index 取主鍵）。
- **儲存格直接編輯**：資料表格可雙擊編輯，待套用變更以琥珀底標示，底部 **✓ 套用 / ✗ 捨棄**。
  - 後端 `update_cell`：以主鍵定位列，無主鍵或主鍵含 NULL 則拒絕；識別字轉義、值參數綁定防注入。
  - 前端可一鍵設為 NULL、Enter 套用、Esc 取消。
- `table_data` 新增回傳 `primary_key`，前端據此判斷可否編輯。
- `docs/` 資料夾：彙整所有規劃文件（planning / architecture / connection-lifecycle / navicat-ux / roadmap）與原始規劃 docx。

### 可實際連線
- MySQL、PostgreSQL、SQLite（MongoDB / Redis 為後續階段）。

---

## P1/P2 + SQLite

### 新增
- 連線樹展開到表，雙擊開表 → 表格檢視。
- **資料 / 結構** 分頁切換；資料分頁含底部導覽列與分頁。
- **SQLite 支援**（檔案型，連線對話框自動切換為檔案路徑欄位）。
- 主區改為多分頁（可開多張表 + 查詢分頁）。
- Windows 打包：`build-installer.ps1`（自動檢查/安裝 Rust 與 Node）+ tauri.conf.json 設定 msi/nsis。

### 修正
- 補上 `db/mod.rs` 遺漏的 `mod mysql;` 宣告。

---

## P0

### 新增
- Tauri 2 + React 18 + TypeScript 專案骨架。
- 大圖示工具列、連線樹（雙擊建連線、類型色標）、查詢編輯器（F6 執行）。
- 統一 `DatabaseDriver` trait + `ConnectionManager`。
- **MySQL driver**：連線池（idle_timeout / max_lifetime / test_before_acquire）。
- **連線釋放**：視窗關閉與程序退出時 drain 全部連線池。
