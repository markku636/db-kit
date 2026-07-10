## v0.9.0

- **多語系（i18n）：繁體中文 ⇄ English，即時切換不需重啟。**
  - 切換入口有兩處：工具列右側的語言選單、以及「設定 → 語言」。偏好存於 `localStorage["dbkit:lang"]`，並同步寫入 `app_settings.json`。
  - **預設仍是繁體中文**，不偵測 OS locale —— 既有使用者升級後零感知。
  - 語言名一律以該語言自己的寫法呈現（「繁體中文」/「English」）；誤切到看不懂的語言時仍找得回母語。
  - `index.html` 的 pre-mount script 直接設好 `<html lang>`，英文使用者**首次繪製即為英文**，不會先閃一次中文。
  - 英文譯文表（1,857 條）由 vite 切成獨立 chunk，**繁中使用者永遠不會下載它**。
- **後端與 CLI 一併在地化** —— 英文介面不會再跳出中文錯誤訊息。
  - Rust 側新增 `i18n.rs`（`t!` / `tf!` 巨集 + 執行期 `{name}` 插值），約 360 條使用者可見字串跟隨語言。
  - `AppError` 序列化改為 `{ kind, code, message }`（additive；`code` 是穩定的機器碼，`message` 依當前語言產生）。
  - `dbk` CLI 新增 `--lang <zh-TW|en>` 全域旗標；語言優先序 `--lang` > `DBKIT_LANG` > `app_settings.json` > `zh-TW`。連 clap 的 `--help` 都會跟著切換。GUI 與 CLI 共用同一份 `app_settings.json`，在 GUI 切了語言，`dbk` 下次執行就跟著。
- **AI 助手與匯出的資料字典也跟隨語言**：英文模式下 AI 情境改用英文並要求英文回覆；匯出的 HTML 文件表頭與 `<html lang>` 同步切換。
- **工具列在空間不足時自動收成純圖示**（標籤退到 tooltip）。順帶修掉一個既有問題：11 顆固定寬按鈕 + 兩個下拉在視窗最小寬度（900px）**原本就會溢出**，只是英文標籤較長，才把它推到預設寬度就發作。
- 新增 `locales/en_ext.rs` 泛用擴充點（上游恆回 `None`），供下游打包注入自家私有驅動的譯文 —— 與 `db/external.rs` 的驅動分派 seam 同一個模式。
- **修正**：`userListSql()` 原本把顯示用的「無」寫進送往 MySQL 的 SQL（`IF(ssl_type='', '無', ssl_type)`）。改為原樣回傳 `ssl_type`，空值的呈現交給 UI，並加上「SQL 內不得含使用者可見文案」的回歸測試。

## v0.8.6

- **進階物件搜尋（`Ctrl+Shift+G`）**：跨資料庫搜尋表 / 視圖 / 欄位 / 索引 / 預存程序 / 函式 / 觸發器 / 外鍵，結果以**表格**呈現（物件名稱 / 資料庫(Schema) / 型別 / 命中於 / 詳細，欄位可排序），底部可調高度的**定義預覽**並高亮命中處，並可「**在物件總管中選取**」把該物件在側欄樹展開 + 捲動 + 選取。與既有的快速物件搜尋並存、共用後端 `search_objects`。
  - **整字比對（whole word）**：needle 左右須為非單字字元或字串邊界（`_` / 數字算單字字元）。
  - **萬用字元（wildcards）**：`*` 任意長度（含空）、`?` 單一字元，後端轉錨定比對；Redis 走原生 glob。
  - 兩個開關皆關時，比對行為與舊版 `contains` 逐位元相同；SQL 粗篩改由 `SearchOptions::like_pattern()` 統一產生（含萬用字元時放寬 LIKE，再由 Rust 端精確過濾）。
  - CLI 同步支援：`dbk search <term> --whole-word --wildcards`。
- **SQL 編輯器：`@` 使用者變數自動完成**（MySQL 系 / MariaDB / SQL Server / external gateway）——輸入 `@` 時提示目前文件中出現過的使用者變數（不分大小寫去重，保留首見的原樣拼寫）。
- **查詢分頁右鍵選單**：「關閉查詢」/「關閉其他查詢」（home 分頁 `__query__` 不可關）。
- **修正：qland / external 連線在側欄看不到預存程序與函式**——「支援 routines 的 kind」白名單原本在抓取端與渲染端各寫一份且不一致（`mssql` 只在渲染端 → 資料夾恆顯示 0；`external` 兩端皆缺 → 完全不顯示）。集中成單一 `supportsRoutines()` predicate；`genUseDb` / `sqlLiteral` 的 MySQL 方言分支補上 `external`（原本落到結尾的 trigger fallback）。
- **修正：編輯 external 連線會清掉沒有 UI 的進階選項**——`ConnectionDialog` 存檔時以物件字面值重建 `options`，把 `cache_ttl_secs` / `max_concurrency` 等未列舉的鍵一併清空；改為在既有 `options` 上覆寫，且「略過 TLS」取消勾選時真正移除該鍵。
- **README 與介面預覽圖全面更新**：4 張 SVG mockup（配色停在已移除的 slate 主題）換成 **5 張 Playwright 實拍**（`npm run make:screenshots` → `scripts/capture-screenshots.mjs`：`vite preview` 起 production build + 注入 Tauri invoke shim 餵示範資料，不需後端也不需真實資料庫）。原 `scripts/make-screenshots.mjs` 移除。

## v0.7.4

- **開場動畫改為每次啟動固定 1.5 秒**：原本首次啟動 1.2s、之後精簡 0.6s（靠 `localStorage` 的 `dbkit:launched` 旗標區分），現統一為每次 1.5s；一併移除已無用的 `dbkit:launched` 旗標。其餘行為不變——仍扣除 bundle 載入已流逝時間（保底 300ms）、點擊 / 按任意鍵可跳過、`prefers-reduced-motion` 與啟動密碼鎖屏情境維持原邏輯、淡出動畫 0.55s。

## v0.7.3

- **External（gateway）查詢分頁改用 CodeMirror SQL 編輯器**：external kind 原本 fallback 到 Redis 用的純 `<textarea>`，導致「設定 → 編輯器主題」不生效、無語法高亮 / 行號 / 自動完成。新增 `supportsSqlEditor` flag（`supportsExplain || external`）把「編輯器選擇」與「EXPLAIN 能力」兩個關注點分離——external 分頁現與其他 SQL 連線一致：主題即時生效、行號、片段、格式化、SQL 轉換、`:name` 參數 badge、Ctrl+Enter 游標語句、反白選取段執行、失敗語句定位。前端多語句切分維持不動（external 仍整段送 gateway、多結果集不受影響）；建構器與「分析（EXPLAIN 表格）」維持原 gate（external 無 schema 自動完成 / EXPLAIN 表格）。
- package-lock.json 版號補同步（0.7.1 → 0.7.3；v0.7.2 bump 時漏掉，避免 CI `npm ci` 再踩 lockfile 驗證）。

- **右鍵「產生 SQL」一律向右開新查詢分頁（對標 SSMS）**：側欄「新增查詢」（含 USE / search_path 起手；SQLite 開空白分頁）、「查詢前 100 筆（含明列欄位）」、SELECT COUNT(*)、INSERT / GRANT 範本、複製資料表、Mongo 範本，與查詢建構器 / 結構同步 / 資料產生對話框的「送到編輯器」——原本會覆蓋目前查詢分頁的草稿，現改為向右開新分頁並自動切換，原分頁內容不動。AI 助手「貼到查詢編輯器」與常用查詢雙擊維持「貼進目前分頁」語意。
- 版本號同步 0.7.2（v0.6.0 / v0.7.0 釋出時 package.json / tauri.conf.json / Cargo.toml 未跟上、App 內顯示 0.5.0，本次補齊；v0.7.1 因 CI 未修復完成未發佈）。
- **CI（release workflow）修復**：v0.6.0 起歷次 release 全平台掛在 `npm ci`——lockfile 由 npm 11 產生、CI Node 20 內建 npm 10 驗證 optional peerDependencies 不相容（Missing: esbuild from lock file），setup-node 升 Node 24（npm 11）；macOS Intel 的 macos-13 runner 已退役（job 永遠 queued 卡住整條 run），改在 macos-latest（Apple Silicon）交叉編譯 x86_64。

## v0.5.0

- 版本號 0.4.0 → 0.5.0（package.json / tauri.conf.json / Cargo.toml 同步）。本版四大主題：**啟動速度**、**查詢安全網（row cap / 逾時）**、**大表操作效能**、**安全性收尾**。

### 啟動速度（白屏消除 + 首包瘦身）

- **白屏徹底消除**：視窗改 `visible:false` 啟動，`index.html` 內建純 HTML/CSS 深色骨架屏（與開場動畫同一漸層，零跳變），骨架屏首次繪製後才呼叫 `show_main_window` 顯示視窗；Rust 端 4 秒保險絲兜底（前端載入失敗仍會顯示視窗）。
- **前端 code splitting**：全部條件掛載的對話框 / 工具面板（~40 個）與 SQL / Mongo 編輯器改 `React.lazy`（共用 `lazyOverlay` helper，自帶 Suspense 邊界），CodeMirror 全家桶（~460 KB）獨立 chunk 延後到首次開查詢分頁才載——**首包 JS 1,139 KB → ~470 KB**（index 325 KB + react-vendor 142 KB）。
- **資產瘦身**：splash hero 圖 5,140 KB → **218 KB**（縮至顯示尺寸 2x + palette 量化，視覺無損；`scripts/optimize-hero.mjs`）；字型只內嵌 latin / latin-ext 子集（14 → 4 個 woff2，`src/fonts.css`）。
- **Rust release 瘦身**：新增 `[profile.release]`（`lto="thin"` + `strip="symbols"`），縮 exe 體積。
- **開場動畫不再強制等待**：2.2s → 首次啟動 1.2s、之後 0.6s，並扣除 bundle 載入已流逝時間；點擊 / 按任意鍵可跳過；`prefers-reduced-motion` 直接跳過；設有啟動密碼時不再白播（鎖屏蓋住看不到）。
- 啟動 IPC 並行化（鎖定狀態查詢與連線清單同時發）；更新檢查延後至啟動 10 秒後、可於設定關閉。

### 查詢安全網（row cap / 逾時）

- **結果列數上限（預設 1,000，設定可調 / 0=不限）**：`run_query` 於各 driver 的 fetch 端截斷（stream 逐列取到上限即停，支援任意語句），誤跑 `SELECT *` 大表不再記憶體爆量 / UI 凍結。截斷時結果列顯示琥珀「已截斷」徽章 +「載入更多」（2× 上限重跑該語句）；匯出改走後端 `export_query` 重新執行取完整結果（上限 100 萬列，rows 不經 IPC）。
- **查詢逾時（預設關閉，30s/60s/5m 可選）**：DB 端第一層（PG `statement_timeout`、MySQL `max_execution_time` / MariaDB `max_statement_time` 自動分流、Oracle `OCI_ATTR_CALL_TIMEOUT`、Mongo `maxTimeMS`）+ tokio 兜底；逾時錯誤引導以行程清單手動 KILL（MSSQL 第一版僅本端逾時）。
- CLI `dbk query` 新增 `--max-rows`（預設沿用全域 1,000；截斷時 stderr 提示，`--max-rows 0` 取完整結果）。

### 大表操作效能

- **資料格列級 memo 化**（`DataRow`）：選取移動 / 框選 / 編輯只重繪受影響的列（原本 1000 列 × N 欄整表 reconcile）；事件處理器經穩定 ref 委派，欄寬拖曳不再整格重排。
- **COUNT(*) 不再白跑**：MySQL / PostgreSQL / SQLite 補齊 `count:false` 旗標支援（前端翻頁本來就有送，先前被忽略）；資料請求與 count 拆成**並行**（資料先回、總數以「…」佔位補上），大表首屏不再被 COUNT 卡住。
- **切庫連線快取**：帶 `USE` / `SET search_path` 前綴的查詢，同庫 60 秒內重用同一條已切庫連線（原本每次丟棄池連線再重建）。
- 池健檢改條件式：閒置 ≥60s（或逾時功能啟用時）才 ping，省掉高頻小查詢每次取用的 round-trip。
- 表格重載頂部顯示 2px 進度條（舊資料保持可見，不閃白）。

### 體驗打磨

- **查詢執行回饋**：執行中顯示即時經過時間與多語句進度「第 N/M 條」；執行鈕變紅色「停止」（Esc 同效）——多語句批次於語句邊界中止、已完成結果保留。
- **錯誤訊息品質**：常見錯誤（MySQL 1045/1146、PG 42P01/28P01、Oracle ORA-01017 / 缺 Instant Client…約 25 條）附繁中友善提示與建議動作（原文保留）；新增「複製錯誤」與「定位失敗語句」（在編輯器反白多語句批次中出錯的那條）；連線失敗改對話框（可讀完 / 可複製 / 可重試）。
- **查詢歷史升級**：上限 50 → 200，條目帶執行時間與連線名（下拉顯示相對時間），新增即時過濾框；舊格式自動遷移。
- 鎖定畫面新增「忘記密碼？」自救指引（刪 `app_settings.json` 即可解除，不影響 keychain 中的連線機密）。

### 安全性

- **mongodump / mongorestore 不再把含密碼 URI 放上命令列**（行程列表可見）：改走 `--config` 暫存檔傳遞、用後即刪——對齊 mysqldump（`MYSQL_PWD`）/ pg_dump（`PGPASSWORD`）既有慣例。
- **加密匯出檔格式升級 v2**（`DBKITEC2`）：Argon2id 參數顯式提高（64 MiB / t=3，原 library 預設 19 MiB / t=2）並與檔頭版本綁定（升級 argon2 crate 不影響解密）；舊 v1 檔案仍可匯入；後端強制 passphrase ≥ 8 碼。
- `ConnectionConfig.options` 明確標註「嚴禁放機密」（此 map 明文落地 connections.json）。
- 已知取捨：密碼在記憶體以一般 `String` 持有（未 zeroize）——縱深防禦項，列入後續評估。

## v0.4.0

- 版本號 0.3.2 → 0.4.0（package.json / tauri.conf.json / Cargo.toml 同步）。本版四大主題：**MariaDB**、**Oracle**、**MongoDB 強化**、**PostgreSQL / MySQL 連線補強**。

### MariaDB 支援（一等連線類型）

- 新增 `mariadb` 連線類型：與 MySQL 線協定相容，後端直接共用 `MysqlDriver`（`DbKind::Mariadb` 薄別名，零重複驅動程式碼），前端獨立類型（teal 色標、MariaSQL 編輯器方言、全部 MySQL 功能對齊：維護 / 使用者管理 / 處理程序 / ER 圖 / routines / 全文索引）。
- `INSERT / REPLACE / DELETE … RETURNING`（MariaDB 10.5+）結果集正確顯示（比照 PostgreSQL 的偵測）。
- 結構比對允許 MySQL ↔ MariaDB 互比（方言 / DDL 相容視為同族）；備份 / 還原沿用 mysqldump / mysql。

### Oracle 支援（rust-oracle / ODPI-C）

- 新增 `oracle` 連線類型：CRUD、分頁（OFFSET/FETCH，**最低伺服器版本 12c**）、結構分頁（索引 / 外鍵 / DDL via DBMS_METADATA）、routines（all_source）、執行計畫（EXPLAIN PLAN + DBMS_XPLAN 文字 grid）、ER 圖、欄位統計、物件搜尋、識別字 exact-case 全程雙引號策略。
- **需自行安裝 64 位元 Oracle Instant Client**（本工具不隨附 DLL）：執行期偵測「連線設定 client 目錄 > ORACLE_HOME > PATH」，未安裝時給明確繁中指引 + 下載連結；不裝 client 完全不影響其他資料庫類型。
- 連線方式支援 服務名稱（EZConnect）/ SID（完整 descriptor）/ TNS 別名 三種；同步 API 以 `spawn_blocking` 包裝不阻塞 UI；ODPI-C session pool + 池狀態監控。
- CLI 支援 `oracle://user:pass@host:1521/SERVICE` URL。

### MongoDB 強化（四大方向）

- **執行計畫**：查詢 DSL 直接 explain（find / aggregate；verbosity 可選 queryPlanner / executionStats / allPlansExecution），視覺化 stage 樹（COLLSCAN 紅色警示、IXSCAN 索引名、記憶體 SORT 琥珀、sharded 分片子樹、SBE 相容）+ 摘要條（回傳 / 鍵掃描 / 文件掃描 / 掃描比 >10× 高亮）。
- **JSON 查詢編輯器**：textarea 升級 CodeMirror——語法高亮、即時 JSON lint、DSL 鍵 / `$` 運算子 / 目標集合欄位名三路自動補全（取樣 schema）。
- **索引與 Schema**：$indexStats 使用次數欄（0 次標「未使用」）、進階索引建立（方向 / text / 2dsphere / hashed + unique / sparse / hidden / TTL / partialFilterExpression）、集合**驗證規則**檢視與編輯（$jsonSchema + validationLevel / validationAction via collMod，strict+error 危險確認、系統集合硬擋）。
- **監控面板**：serverStatus 分區指標（連線 / 操作計數 / 記憶體 / WT 快取 / 複寫）、dbStats、currentOp 進行中操作（可 killOp）、Profiler（level 0-2 + slowms + system.profile 慢查詢表，level 2 危險確認）；各分頁獨立載入，受限帳號（Atlas）單項失敗不拖垮整個面板。
- **欄位統計**：BSON 型別分布橫條（混型欄位）、Top-10 值、缺欄 / null 區分、相異值估計；大集合自動 $sample 抽樣（20k）+ 15s 逾時保護。

### PostgreSQL / MySQL 連線補強

- sqlx 開啟 `tls-rustls-ring-native-roots`：新增 **SSL 模式**選項（PG：disable/prefer/require/verify-ca/verify-full；MySQL 系：disabled/preferred/required/verify_ca/verify_identity），維持 rustls+ring 免系統相依。
- 連線改用 typed `ConnectOptions` builder（不再字串內插 URL）：**密碼含 `@ / ? # %` 等特殊字元不再壞掉**。
- PG 結構分頁補欄位註解（col_description，以 attname join 避開 DROP COLUMN 後的編號錯位）。

### 啟動密碼（app-lock 閘門）

- 新增可選的**啟動密碼**：啟用後每次開啟 App 需先輸入密碼才能進入（僅冷啟動時要求一次）。工具列「設定」可啟用 / 變更 / 移除。
- 只儲存密碼的 **Argon2id 雜湊**（含 salt，存 `app_settings.json`），明文不落地、驗證在 Rust 後端做。屬「開啟 App 的閘門」，**不加密連線資料**——連線機密仍存於 OS keychain，`dbk` CLI 完全不受影響。
- 忘記密碼可刪除設定目錄的 `app_settings.json` 解除（不影響已存連線）。



- 版本號 0.2.5 → 0.2.6（package.json / package-lock.json / tauri.conf.json / Cargo.toml / Cargo.lock 同步）；重打安裝檔。本版內容見下方「『關於 DB Kit』對話框」與「多結果集同時顯示（SSMS 風格）」。

## 「關於 DB Kit」對話框

- 新增：工具列「關於」按鈕（標題列版本號也可直接點擊）開啟關於對話框，顯示 App 圖示、版本號（附「複製版本資訊」方便回報問題時附上）、支援的資料庫清單（由 KIND_META 導出，新增類型自動跟上）、GitHub 專案 / 變更紀錄 / 回報問題連結（沿用 `open_external` 以系統瀏覽器開啟）、MIT 授權。
- 新增：關於對話框內可**手動檢查更新**——`checkForUpdate` 增加 `force` 參數略過每日快取直打 GitHub API（使用者主動點的就真的去查），結果顯示「有新版 vX.Y.Z，點擊前往下載 / 已是最新版本 / 檢查失敗」三態；啟動時的自動檢查行為不變。

## 多結果集同時顯示（SSMS 風格）

- 一次執行多條 SQL（F6 整段 / 執行鈕）時，每條有回傳結果集的語句現在**各佔一格、堆疊同時顯示**（致敬 SSMS / MySQL Workbench），不再只顯示最後一個結果集。每格標頭顯示「結果 N、對應語句、列數、耗時」，各格獨立捲動、排序、篩選、框選複製。
- 點任一格（含表格內部）設為「作用中」（框線高亮 + 右上角「結果 N」指示），右上的複製 CSV/TSV/JSON/MD、匯出、問 AI 即對該結果集生效；「問 AI」並改帶該格對應的單條語句，讓查詢與結果一一對應。
- 狀態列多結果集時顯示「N 個結果集 · 共 M 列」。單語句 / 純 DML / 分析（EXPLAIN）行為與先前完全一致。
- 中途某條語句失敗時，失敗前已取回的結果集照樣顯示（錯誤橫幅在上、部分結果在下，SSMS 同款），不必重跑前面的 SELECT。
- 效能與操作細節：ResultTable 加 `React.memo`（作用中表格篩選打字不再連帶重渲染其餘大表格）、每格渲染列數上限按格數均分（總 DOM 列數有預算，複製 / 匯出仍取全部）、畫面外的格以 `content-visibility:auto` 跳過排版繪製、各格可摺疊（保留排序 / 篩選狀態）、鍵盤聚焦（Tab 進表格）也會切換作用中結果集、重跑批次時各格捲動位置重置、點右上「結果 N」指示可捲至該格。

## v0.2.5

- 新增：**啟動時檢查 GitHub 有無新版本並提示昇級**。App 啟動時查 `releases/latest`，若線上 Release 版本較新，即在標題列版本號旁顯示「有新版 vX.Y.Z」小標記，點擊以系統瀏覽器開啟該 Release 下載頁自行安裝。純前端實作（fetch GitHub API、`isNewer` 數值版本比較、localStorage 快取每天最多檢查一次、任何失敗安靜略過），沿用既有 `open_external` 開連結，未新增任何後端依賴；新增 7 項 vitest（共 202 項全通過）。
- 版本號 0.2.4 → 0.2.5（package.json / package-lock.json / tauri.conf.json / Cargo.toml / Cargo.lock 同步）；重打 Windows / macOS / Linux 安裝檔。

## v0.2.4

- 版本號 0.2.3 → 0.2.4（package.json / package-lock.json / tauri.conf.json / Cargo.toml / Cargo.lock 同步）；重打 Windows / macOS / Linux 安裝檔。
- 修正：查詢結果列過多時撐爆版面（畫過狀態列）——QueryPane 根容器補 `min-h-0`，結果區改由內層 `overflow-auto` 正常捲動。

## v0.2.3

- 版本號 0.2.2 → 0.2.3（package.json / tauri.conf.json / Cargo.toml / Cargo.lock 同步）；重打 Windows / macOS / Linux 安裝檔。修正 release 佈版：v0.2.2 標籤指向的是尚未同步 package-lock.json 的舊 commit，`npm ci` 在裝相依這步就失敗，故改以含 lockfile 修正的 commit 重切乾淨標籤發佈。

## v0.2.2

- 版本號 0.2.1 → 0.2.2（package.json / tauri.conf.json / Cargo.toml / lockfiles 同步）；重打 Windows / macOS / Linux 安裝檔。整理版本標籤（移除誤植的大寫殘留 tag）。

## 多查詢分頁（Tab）

- 仿 Navicat：可同時開多個查詢分頁，各自獨立的編輯器內容與草稿（每連線 × 每分頁分開持久化）。分頁列上的「＋」新增、額外分頁可關閉（中鍵或關閉鈕）；預設「查詢」home 分頁不可關。Ctrl+T 新增、Ctrl+W 關閉、Ctrl+Tab / Ctrl+1..9 在所有表分頁與查詢分頁間循環/跳轉。
- 向後相容：home 分頁沿用原本的儲存鍵，既有草稿不受影響；不開額外分頁時行為與先前完全一致。

## v0.2.0

- 版本號 0.1.7 → 0.2.0（package.json / tauri.conf.json / Cargo.toml 三者同步），反映自 0.1.x 以來累積的大量功能（資料傳輸、查詢建構器、匯入匯出、結構比對、視覺化執行計畫、片段、唯讀模式、AI 助手、工具列精簡等）。

## 匯入：trim 開啟時略過純空白列

- CSV/Excel 匯入啟用「去除前後空白」時，整列皆為空白的資料列現在會被略過，而非插入一整列 NULL（auto-PK 表更會無聲產生雜訊列）。空白列偵測改為 trim 感知。新增 1 條後端整合測試。

## 資料列右鍵：複製為 SELECT（定位此列）

- 仿 Navicat「Copy as SELECT」：在資料格右鍵新增「複製為 SELECT（定位此列）」，以主鍵組出 SELECT * FROM 表 WHERE pk=… 方便精準重查 / 分享單列。屬唯讀動作，readonly 連線也提供（不像 UPDATE/DELETE 需可寫）。+1 前端測試。

## 查詢工具列精簡 ＋ 單擊開表 ＋ 新查詢回饋

- 查詢工具列不再擠成一團：新增明顯的「新查詢」按鈕（Ctrl+N），並把開啟/另存/收藏、壓縮、關鍵字大/小寫、分析、視覺化解釋等次要動作收進「更多 ⋯」溢出下拉。主列只留：新查詢粒歷史粒收藏粒片段粒建構器粒格式化粒更多粒執行。
- Ctrl+N / 「新查詢」現在會跳出「已開新查詢」提示並聚焦編輯器（原內容自動存進歷史），不再像「沒作用」。
- 側欄資料表改為「單擊即開啟」（openTable 去重：已開的表只切換）；資料庫/資料表/資料夾節點加大行高（py-1.5），點擊命中區更好按。右鍵仍可「查詢前 100 筆」等產生 SELECT。

## 字串字面值：external gateway 沿用 MySQL 反斜線跳脫

- 修正 sqlLiteral 對 external（講 MySQL 方言的閘道）未加倍反斜線的問題：external 的識別字 / USE 皆按 MySQL 處理，但字串字面值漏了反斜線跳脫，使像 a\（反斜線結尾）的值變成 a\ 後接的結尾引號被轉義而衝出字串（資料錯誤甚至注入）。改為 mysql / external 一致加倍反斜線。新增 3 條前端測試。

## MySQL：USE 前綴切分忽略引號內分號

- split_leading_use 改用引號感知掃描找頂層分號，避免反引號資料庫名含 `;`（如 USE `odd;name`; …）被錯切。與唯讀守門的修正同屬一類（裸分隔掃描忽略引號）。新增 3 條後端測試。

## CLI 唯讀守門：分號切分支援字串 / 註解 / dollar-quote

- 修正 dbk 唯讀模式誤擋合法查詢：原本以裸 `split(;)` 切語句，會把字串字面值 / 註解 / PostgreSQL dollar-quote 內的分號當成語句邊界，導致像 `SELECT * FROM logs WHERE msg LIKE %error; retry%` 這類查詢被誤判含寫入字樣而拒絕。改用與前端 splitSqlStatements 相同的引號 / 註解感知切分；只會切得更精準、不會漏切真正的語句邊界，所有寫入語句仍各自成句受檢，唯讀防護不被削弱。新增 5 條後端測試。

## 執行計畫熱點：PostgreSQL 改用獨佔成本

- 視覺化 EXPLAIN 的熱點判斷修正：PG 的 Total Cost 是含子樹的累積值，根節點永遠最大，原本一律把根標為瓶頸。改用獨佔成本（self＝本節點 Total 減各直接子節點 Total，pgAdmin / explain.depesz 的標準算法），凸顯真正最耗工的節點；節點額外顯示 self 徽章解釋熱點來源。MySQL 既有步驟成本邏輯不變。

# Changelog

## 匯入預覽（致敬 Navicat 匯入精靈）

匯入 CSV / Excel 改為「**選檔 → 預覽 → 匯入**」：選好檔即顯示**欄名與前 20 列**和約略總列數，確認無誤再匯入；調整分隔字元 / 表頭設定會即時重新預覽，搭配「重新指定欄名」對齊欄位更直覺。

> 驗證：後端新增 `import_preview` command + `build_preview` 純函式（欄名 columns 覆蓋 > 表頭 > col1..N）+ 2 項 vitest（import 20 項全通過）、`cargo clippy` 零警告；前端 `tsc` + `eslint` + `vite build` 綠燈。

- 預覽顯示檔案的「自然欄名」（表頭或 col1..N），方便對照後填寫覆蓋欄名。

## 匯出選取的列（資料格批次列）

資料格勾選多列後，動作列新增「**匯出選取**」——把勾選的列另存 CSV / Excel / JSON / SQL / TSV / Markdown（走後端 export_rows，依副檔名選格式）。與「刪除選取」並列。

> 驗證：沿用 export_rows 後端管線；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 184 項全通過。

## 匯入：去除每格前後空白（資料清理）

匯入 CSV / Excel 時可勾選「去除每格前後空白」，把「 alice 」清成「alice」，並在 empty→NULL 判定前套用（全空白 → NULL）。

> 驗證：後端 `ImportOptions.trim` + import_rows 套用（向後相容）+ 1 項 SQLite 端到端測試；import 測試 18 項全通過、`cargo clippy` 零警告；前端 `tsc` + `eslint` + `vite build` 綠燈。

## 整庫傳輸自動建表依外鍵相依排序

整庫傳輸勾選「自動建表」時，**先建被外鍵參照的表**——拓樸排序避免 `CREATE TABLE` 因外鍵指向尚未建立的表而失敗（如先建 users 再建 orders）。

> 驗證：`topoSortByFk` 抽為 `fkorder.ts` 純函式（被參照者在前、多層相依、環不無限遞迴）+ 4 項 vitest（共 184 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- 自動建表時以來源 `er_model` 的外鍵關係排序選取的表；取不到關係則沿用原順序。

## 匯入欄位對應：重新指定欄名（覆蓋檔案表頭）

匯入 CSV / Excel 時，檔案表頭若與目標表欄位不一致，可勾選「重新指定欄名」**把檔案欄位對齊到目標欄位**（致敬 Navicat 匯入精靈的欄位對應），不必先改檔案。

> 驗證：後端 `import_rows` 改為「has_header 先吃表頭、`columns` 覆蓋優先」（向後相容）+ 1 項 SQLite 端到端測試（表頭 x,y 覆蓋成 id,name）；import 測試 17 項全通過、`cargo clippy` 零警告；前端 `tsc` + `eslint` + `vite build` 綠燈。

- 勾選後出現欄名輸入框；空 / 未勾選時沿用檔案表頭（行為不變）。

## 結構比對支援跨連線（正式 vs 測試）

結構比對原本只能比同一連線下的兩個資料庫，現在可**選不同連線當目標**（如比對正式環境 vs 測試環境的結構差異），限相同資料庫種類以產生相容 DDL。

> 驗證：以既有唯讀 API（listTables / tableColumns）對目標連線取結構，差異 / 同步 DDL 邏輯不變；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 180 項全通過。

- 比對列頭新增**目標連線下拉**（同種類且已連線者，2 個以上才顯示）；切換連線重置比對。


## 資料同步強化：只同步來源 ∩ 目標的共同欄位

`buildSyncDml` 加 `targetColumns`：當兩表欄位不完全相同時，**只對共同欄位產生 INSERT / UPDATE**，避免引用目標沒有的欄位導致 DML 執行失敗。

> 驗證：新增 1 項 vitest（目標缺 `qty` → 產出的 INSERT/UPDATE 不含 `qty`）；共 datasync 6 項全通過；前端 `tsc` + `eslint` + `vite build` 綠燈。

## 欄位相異值分布（資料剖析）

資料表欄位標題右鍵新增「**相異值分布（Top 50）**」：一鍵產生 `GROUP BY 該欄 ORDER BY 筆數` 的查詢並帶入編輯器，快速看「這欄各值各有幾筆」——找熱門值 / 髒資料 / 列舉值很實用。

> 驗證：沿用 `quoteIdent` / `qualifiedName` 組查詢、`requestQuery` 帶入編輯器；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 176 項全通過。

## 資料比對 / 同步（致敬 Navicat Data Synchronization）

資料表右鍵新增「**資料比對 / 同步…**」：以主鍵比對來源與目標兩表的資料，算出讓目標與來源一致所需的 **INSERT / UPDATE / DELETE**，產生同步 DML 供檢視後執行（跨連線 / 跨庫）。

> 驗證：比對與 DML 產生抽為 `datasync.ts` 純函式（`diffRowsByPk` / `buildSyncDml`）+ 5 項 vitest（共 176 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **以來源主鍵比對**：目標缺 → INSERT、值有差 → UPDATE、目標多出 → DELETE（需勾選「含 DELETE」）；NULL 主鍵值正確配對。
- 顯示**新增 / 更新 / 刪除筆數**與產生的 DML；可複製或**帶入目標連線的查詢編輯器**檢視後執行（不自動套用，較安全）。
- 記憶體內比對，每側上限 2 萬列（超出標示僅比對前 N 列）；識別字 / 值方言感知跳脫。

## SQL 壓縮成單行（與格式化互補）

查詢工具列新增「**壓縮**」鈕：把多行 SQL 收成單行（方便貼進程式碼字串 / log）。與「格式化」（展開換行）一對。

> 驗證：`minifySql` 抽為 `sql.ts` 純函式 + 4 項 vitest（共 171 項全通過）；前端 `tsc` + `vite build` 綠燈。

- 程式碼段內多重空白 / 換行收斂為單一空白；**字串內容與 `/* 區塊註解 */`、`$$` 原樣保留**；**行註解（`-- …`）移除**（單行化會吃掉後續）。

## 參數化查詢（`:name`，致敬 Navicat 參數查詢）

在 SQL 寫 `:name` 佔位符，執行時**逐一提示輸入值並安全代入**——同一條查詢換參數重跑，不必每次手改 WHERE，也避免手動拼字串的跳脫風險。

> 驗證：`extractNamedParams` / `substituteNamedParams` 抽為 `sql.ts` 純函式 + 2 項 vitest（共 168 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- 執行前偵測查詢中的 `:name`（依序、去重），逐一跳出輸入框；任一取消即中止整次執行。
- **安全代入**：數字原樣（數值比較）、其餘以字串字面值跳脫（方言感知，MySQL 反斜線加倍）。
- **不誤判**：字串 / 註解內的 `:name` 不算；PostgreSQL 型別轉換 `::type` 不當參數。

## 唯讀模式強化：側欄寫入 / 破壞性動作一併隱藏

延伸上一版的唯讀連線：除了查詢編輯器與資料格，**側欄資料表右鍵的寫入 / 破壞性動作也一併隱藏**——新增資料表 / 列、匯入精靈、資料產生、重新命名、複製含資料、清空、截斷、刪除。唯讀連線只剩查詢 / 匯出 / 文件等只讀操作。

> 驗證：以 `readonlyConns[connId]` 旗標條件式排除選單項；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 166 項全通過。

## 連線唯讀模式（致敬 Navicat / DataGrip read-only connection）

把連線標為**唯讀**，擋掉誤改正式環境資料的兩大途徑——搭配連線色標（紅＝正式）更安全。

> 驗證：`connReadonly.ts`（純函式存取）+ `isWriteStatement`（sql.ts）各附 vitest（共 166 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **連線右鍵切換「設為唯讀模式」**；側欄連線列顯示「唯讀」徽章；狀態 per-連線 localStorage 持久化（透過 store 反應式套用）。
- **查詢編輯器**：執行前若任一語句為寫入 / DDL（`INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE…` 含交易控制）即擋下並提示；`SELECT/SHOW/EXPLAIN/WITH…SELECT` 照常。
- **資料格**：唯讀時不可編輯儲存格 / 新增 / 刪除列（`editable` 連動）。
- 為前端層防護（連線本身仍可寫），目的在防手滑；關閉唯讀即恢復。

## 視覺化查詢建構器：計數（總列數）

建構器右側面板新增「**計數**」鈕：把目前查詢包成 `COUNT(*)` 子查詢，立刻得知這查詢會回多少列（不必先「帶入編輯器」再手動改寫）。

> 驗證：`buildCountQuery` 抽為 `sql.ts` 純函式（略去 LIMIT / OFFSET / ORDER）+ 1 項 vitest（共 161 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

## SQL 片段庫擴充：反連接 / EXISTS / CASE / 分頁

內建片段再加 4 個常用骨架：**反連接（找無對應的列）、EXISTS 子查詢、CASE WHEN 條件分類、LIMIT/OFFSET 分頁**——在編輯器輸入 `antijoin` / `exists` / `case` / `paginate` 即可展開。

> 驗證：vitest 全通過（片段測試以 `BUILTIN_SNIPPETS.length` 動態比對，新增不破壞）；前端 `tsc` + `vite build` 綠燈。

## 視覺化查詢建構器：OFFSET（分頁）

查詢建構器選項列補上 **OFFSET**，與 LIMIT 一起組出 `LIMIT n OFFSET m` 分頁查詢。

> 驗證：`buildSelectQuery` 加 offset（接於 LIMIT 後，0 / 負值不輸出）+ 1 項 vitest（共 160 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

## Excel 匯出品質提升：凍結表頭 + 自動欄寬

匯出的 .xlsx 現在**凍結首列表頭**（捲動時標題常駐）並**自動依內容調整欄寬**，開檔即一目了然，更貼近 Navicat 的 Excel 輸出品質。

> 驗證：`render_xlsx` 加 `set_freeze_panes` / `autofit`（rust_xlsxwriter）；`cargo test export::` 13 項全通過、`cargo clippy` 零警告。

## 整庫資料庫文件（致敬 Navicat HTML 文件 / 模型報表）

資料庫節點右鍵新增「**資料庫文件…**」：一次彙整整個資料庫所有資料表的欄位 / 索引 / 外鍵成一份**含目錄**的文件，可複製或另存 **Markdown / HTML**（HTML 帶錨點目錄，適合放 wiki / 交付）。

> 驗證：文件產生抽為 `dataDict.ts` 純函式（`buildDbDictMarkdown` / `buildDbDictHtml`）+ 3 項 vitest（共 159 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **逐表並行載入**（限併發 6，個別失敗以空白代之），即時顯示進度；上限 200 張表（超出標示）。
- Markdown / HTML 兩種格式即時切換預覽；表名 / 內容皆做跳脫（`|`、`<`、`&`）。
- 沿用既有 `table_columns` / `table_indexes` / `list_foreign_keys`，無需新增後端。

## SQL 關鍵字大小寫轉換（致敬 Navicat 編輯器）

查詢工具列新增 **ABC / abc** 兩鈕：把 SQL 關鍵字一鍵統一轉大寫 / 小寫，符合團隊風格。

> 驗證：`transformKeywordCase` 抽為 `sql.ts` 純函式 + 5 項 vitest（共 156 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **只動關鍵字**：子句 / 運算子 / DML / DDL 字（`SELECT FROM WHERE JOIN GROUP BY HAVING INSERT UPDATE…`）；**字串、行 / 區塊註解、`$$` 內容、識別字（含反引號 / 雙引號）一律不動**。
- 刻意**排除型別名與常見欄名**（`date / text / timestamp…`），避免把欄位誤改大小寫。

## 反向外鍵導覽：尋找參照此列的列

補齊外鍵雙向導覽：**主鍵欄位的儲存格右鍵新增「尋找參照此列的列…」**——找出哪些表以外鍵指向這一列，一鍵開啟並過濾出參照它的子列（如從某筆使用者跳到他的所有訂單）。

> 驗證：沿用既有 `er_model`（延遲載入、本分頁快取）與上一版的 `openTableFiltered`；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 151 項全通過。

- **僅主鍵欄位的儲存格**出現此項（值非 NULL），語義即「找參照此列的列」。
- 點選時才抓 `er_model` 並快取於本分頁；找出 `to_table = 本表 ∧ to_column = 此欄` 的關係。
- **0 個** → 提示無人參照；**1 個** → 直接開啟並過濾；**多個** → 跳出小選單列出各來源表.欄供挑選。

## 複製整欄為 IN 子句（致敬 Navicat「Copy as IN」）

資料表欄位標題右鍵新增「**複製整欄為 IN(...)（本頁）**」：把本頁該欄的值組成 `col IN ('a', 'b', …)`，直接貼進別處 WHERE 即可篩選那批值。

> 驗證：`buildInClause` 抽為 `sql.ts` 純函式 + 4 項 vitest（共 151 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **去重**、方言感知識別字 / 字面值跳脫（單引號加倍）、純數字原樣（數值比較）。
- **NULL 處理**：以 `OR col IS NULL` 並聯（`IN` 不含 NULL，避免漏掉 NULL 列）；整欄全為 NULL 時輸出 `col IS NULL`。

## 釘選 / 常用資料表（致敬 Navicat Favorites）

把常開的表釘到側欄頂部「**★ 常用**」區，跨連線一鍵開啟——不必每次層層展開連線 → 資料庫 → 找表。

> 驗證：釘選存取抽為 `pins.ts` 純函式（toggle / isPinned / removePinsForConn / 持久化）+ 3 項 vitest（共 147 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **資料表右鍵新增「釘選到常用 / 取消釘選」**（依目前狀態切換）。
- **側欄頂部「★ 常用」區**：列出釘選的表（含視圖圖示）、所屬資料庫，點擊即切到該連線並開分頁；hover 顯示 × 取消釘選。
- 受側欄搜尋字過濾；刪除連線時連帶清掉其釘選；以 `連線+資料庫+表` 為鍵去重，localStorage 持久化。

## 命令面板（Ctrl/Cmd+K）— 跨連線快速跳轉

按 **Ctrl/Cmd+K** 叫出命令面板，輸入即模糊搜尋並跳到 **連線 / 資料庫 / 資料表（含視圖）**，或執行常用動作（開查詢編輯器、切換主題）。大量連線 / 表時，鍵盤一路到底，不必在側欄層層展開。

> 驗證：模糊比對抽為 `fuzzy.ts` 純函式（`fuzzyScore` / `fuzzyFilter`）+ 6 項 vitest（共 144 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **模糊排序**：子序列匹配，連續 / 開頭 / 完整子字串加分，較短名稱優先；輸入也比對次要文字（連線名 / 資料庫）。
- **鍵盤操作**：↑/↓ 移動、Enter 開啟、Esc 關閉；滑鼠移入即選取。
- 索引涵蓋所有連線、已載入的資料庫與資料表（已展開者）；選資料表自動切到該連線並開分頁。
- F1 快捷鍵說明新增「全域 · Ctrl+K」。

## 外鍵導覽：跳至參照的列（致敬 Navicat / TablePlus）

瀏覽資料時，**外鍵欄位的儲存格右鍵新增「跳至 <參照表>（<參照欄> = 值）」**——一鍵開啟被參照的資料表並過濾到對應那一列，沿著關聯快速鑽研資料，不必手動切表打 WHERE。

> 驗證：新增 store `openTableFiltered` / `pendingFilter`（開表後由該分頁消費套用篩選）；資料格載入本表外鍵（`list_foreign_keys`）標記可導覽欄位；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 138 項全通過。

- **外鍵欄位才出現**該選單項（值為 NULL 時不顯示）；選單標籤帶參照表 / 欄與值預覽。
- 開啟被參照表後自動套用 `參照欄 = 值` 篩選並展開篩選列；若該表分頁已開啟則切換並重新過濾。
- 僅關聯式（MySQL / PostgreSQL / SQLite）資料分頁載入外鍵資訊。

## 整庫資料傳輸（多表一次傳，致敬 Navicat Data Transfer）

資料庫節點右鍵新增「**資料傳輸（整庫）…**」：勾選多張來源表，一次傳到另一連線 / 資料庫的同名表，常用於「把某庫整批複製到測試環境」。

> 驗證：逐表複用已測試的 `transfer_table`（含自動建表，後端已有 8 項測試）；前端新增 `DbTransferDialog`，`tsc` + `eslint` + `vite build` 綠燈、vitest 138 項全通過。

- **多表勾選**（預設全選，可搜尋過濾、全選 / 全不選）；目標連線 + 資料庫選擇器（關聯式、已連線）。
- **逐表進度與結果**：傳輸中即時顯示進度（`done/total`）與每張表的旋轉指示，完成後每表標記「N 列 / 已建表」或錯誤，互不影響（單表失敗不中斷整體）。
- **自動建表**選項（限同種類）沿用單表傳輸的 DDL 改寫；外鍵密集結構建議目標預建。
- 同庫對同庫的防呆（避免把整庫傳到自己）。

## 從資料表右鍵直接開「查詢建構器」

讓旗艦的視覺化查詢建構器更好發現：在側欄**資料表右鍵新增「查詢建構器…」**（MySQL / PostgreSQL / SQLite，含視圖），開啟時自動帶入該表，按「帶入查詢編輯器」即把產生的 SQL 送進查詢分頁執行。

> 驗證：QueryBuilder 加 `initialTable` prop（模型載入後自動加入該表，僅一次）；沿用 `sendQuery` 把產生的 SQL 推進查詢編輯器；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 138 項全通過。

- 先前查詢建構器只能從查詢工具列開啟；現在資料瀏覽到一半也能就地以該表起手。

## 視覺化查詢建構器：結果預覽 + 欄位全選 / 清空

讓查詢建構器更接近 Navicat SQL Builder 的「邊建邊看」手感。

> 驗證：沿用既有 `buildSelectQuery` / `run_query`，無新增後端；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 138 項全通過。

- **結果預覽**：右側 SQL 面板新增「預覽」鈕，**在建構器內直接執行查詢看結果**（自動套上預覽上限：未設 LIMIT → 200、已設 → 取 min(設定, 500)），免切到查詢編輯器；結果以精簡表格呈現、`NULL` 標灰。
- **每張表「全選 / 清空」欄位**：表卡標頭新增快捷，寬表不必逐欄點選。
- 切換資料庫時一併清掉預覽結果，避免殘留。

## 連線色標（Connection Color，致敬 Navicat）

給連線標上顏色以一眼區分 **正式 / 測試 / 開發** 等環境，降低「在正式環境誤操作」的風險。

> 驗證：色標存取抽為 `connColors.ts` 純函式 + 2 項 vitest（共 138 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。純前端 localStorage，與後端連線設定 / keychain 解耦。

- **連線右鍵選單底部新增 10 色色盤**（含「無」清除）：選色即標記，當前色以外環高亮。
- **側欄連線列顯示色條**（左側 3px inset 色條），與選取的 accent 條並存、不位移版面。
- 色標 per-連線 持久化於 localStorage（`db-kit:connColors`），重載沿用。

## 視覺化查詢建構器：HAVING 群組後篩選

查詢建構器補上 **HAVING** 子句——以聚合結果篩選分組（如 `COUNT(id) > 1`、`SUM(total) >= 100`），補齊「分組統計 → 篩出符合門檻的群組」這條 Navicat 常見路徑。

> 驗證：`buildSelectQuery` 加 HAVING 支援並把聚合表達式抽成共用 `qbAggExpr`（SELECT / HAVING 共用）；+2 項 vitest（共 136 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **HAVING 區**（位於聚合 / 分組之後）：每列可選聚合函式（`COUNT / SUM / AVG / MIN / MAX / COUNT DISTINCT`，或留空＝直接以欄位比較）+ 表.欄 + 運算子 + 值，多列以各自 AND / OR 串接。
- 產生順序正確：`GROUP BY` → `HAVING` → `ORDER BY` → `LIMIT`；數字值原樣、字串加引號（方言感知）。

## 資料傳輸：自動建立目標表（傳到全新資料庫）

延伸上一版的資料傳輸——目標表不存在時，**沿用來源結構自動建表**再灌資料，於是可一鍵把表複製到全新的資料庫（限相同資料庫種類）。

> 驗證：`rewrite_create_table_name`（改寫來源 DDL 的表名為目標限定名）抽為純函式 + 5 項單元測試（MySQL / PostgreSQL / SQLite / 大小寫 / 非法輸入）；新增 1 項 SQLite 端到端整合測試（自動建表 + 傳資料）；共 8 項 transfer 測試通過、新程式碼 `cargo clippy` 零警告；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **傳輸對話框新增「目標表不存在時自動建立」**：勾選後改以「新表名」輸入（預設 `<來源表>_copy`），目標若已存在則沿用、不覆蓋。
- **DDL 改寫**：定位 `CREATE TABLE … (` 把舊表名（含 schema / 各式引號寫法）整段換成目標限定名（`db.table`，SQLite 不加 schema），保留 `IF NOT EXISTS` 與欄位定義原樣——對 MySQL `SHOW CREATE TABLE`、PostgreSQL 重建式、SQLite 原始 DDL 皆穩健。
- **同種類守衛**：跨資料庫種類（如 MySQL → PostgreSQL）不沿用 DDL，明確要求先手動建表；後端 `ConnectionManager::kind` 提供連線種類判斷。

## 資料傳輸（Data Transfer，致敬 Navicat）

把一張表的資料複製到**另一個連線 / 資料庫 / 表**——跨連線搬資料、把正式環境的表灌進測試庫、同庫複製到另一張表，都不必再手動匯出再匯入。資料表右鍵新增「資料傳輸…」（關聯式：MySQL / PostgreSQL / SQLite）。

> 驗證：後端新增 `transfer` 模組 + `transfer_table` command；新增 2 項 SQLite 端到端整合測試（欄位交集傳輸 / 同表防呆）通過、新程式碼 `cargo clippy` 零警告；前端 `tsc` + `eslint` + `vite build` 綠燈、vitest 134 項全通過。

- **同名欄位交集傳輸**：以「來源 ∩ 目標」的同名欄位複製，目標多 / 少欄皆可（來源獨有欄位列為「略過」回報）；目標表需先存在。與資料庫種類無關，沿用各 driver 的型別轉型。
- **跨連線 / 跨庫 / 同庫跨表**：目標連線下拉列出已連線的關聯式連線，再選資料庫與資料表。
- **穩定分頁**：以來源主鍵排序逐頁讀取（每頁 1000 列），避免漏列 / 重複；上限 500 萬列保護。
- **可選「傳輸前清空目標表」**（DELETE 全表）；主鍵衝突等失敗的列逐筆計數並回報前 20 筆錯誤。
- **防呆**：來源與目標為同一張表時拒絕（避免邊讀邊寫無限增長）。

## SQL 片段庫（Snippets，致敬 Navicat 程式碼片段）

把常用 SQL 骨架收進可重用的片段庫：**編輯器內輸入片段名即自動完成展開**，或從工具列「片段」下拉一鍵插入游標處。內建 11 個常用片段（前 100 筆 / 計數 / 找重複 / 分組 Top N / 各種 JOIN / CRUD 骨架…），使用者可新增 / 覆蓋 / 刪除。

> 驗證：片段儲存 / 合併 / 覆蓋邏輯抽為 `sql.ts` 純函式 + 4 項 vitest（共 134 項全通過）；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **編輯器自動完成**：以 `snippetCompletion` 註冊為 SQL 語言的額外完成來源，與既有「表 / 欄」結構完成併存——輸入 `sel100`、`dups` 等名稱即可補入骨架。
- **工具列「片段」下拉**：點擊插入游標處（透過編輯器命令式 `insertText`），可「從選取 / 目前 SQL 新增片段」、刪除使用者片段；內建片段標示「內建」且不可刪除。
- **持久化**：只存「與內建不同」的片段（使用者新增 / 覆蓋），內建未改不入存檔；同名以使用者為準，重載後合併回內建。
- 片段陣列以 `useMemo` 穩定 identity，避免每次 render 重建編輯器 extensions。

## Excel（.xlsx/.xls）匯入（致敬 Navicat 匯入精靈的 Excel 來源）

匯入對話框現在能直接吃 Excel 檔，不必先轉存 CSV。與 CSV 匯入共用同一套逐列寫入邏輯（型別轉型 / 空→NULL / 遇錯即停 / 錯誤回報）。

> 驗證：後端新增 `calamine`（純 Rust 讀 xlsx，`dates` 特性讓日期欄為日期而非序號）；`cargo test import::` 13 項全通過（含「產 xlsx → 讀回」端到端與非法檔被拒 2 項新測試）、新程式碼 `cargo clippy` 零警告；前端 `tsc` + `eslint` + `vite build` 綠燈。

- **檔案選擇器接受 `.xlsx / .xls`**：依副檔名自動切到 Excel 匯入器（分隔字元對 Excel 無意義，介面已標示）。
- **取第一張工作表的使用範圍**；calamine 會把不齊列補空格，使每列欄數一致，利於與表頭比對。
- **儲存格型別保真**：日期 → `YYYY-MM-DD HH:MM:SS`、整數型浮點去 `.0`、布林 / 字串原樣、公式錯誤格 → 空字串；尾端全空白列自動去除。
- 重構：CSV / Excel 匯入抽出共用 `import_rows`，行為一致；後端讀檔（避免大檔經 JS bridge），上限 100 MB。

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
