# 開發路線圖

**繁體中文** · [English](./roadmap.en.md)

採分階段漸進開發，每階段產出可運作的成果。

| 階段 | 內容 | 狀態 |
|------|------|------|
| P0 | Tauri + React 骨架、大圖示工具列、連線池與釋放層、MySQL 連線 | ✅ 完成 |
| P1 | 連線樹展開到表、雙擊開表 | ✅ 完成 |
| P2 | 表格檢視（資料/結構分頁）+ 底部分頁導覽 | ✅ 完成 |
| — | SQLite 支援（檔案型） | ✅ 完成 |
| — | PostgreSQL 支援 | ✅ 完成 |
| — | 儲存格直接編輯 + ✓ 套用（寫回 DB，以主鍵定位） | ✅ 完成 |
| — | Windows 安裝檔打包（.msi / .exe）+ 自動裝依賴的 ps1 | ✅ 完成 |
| — | 新增列 / 刪除列（完整 CRUD） | ✅ 完成 |
| — | 篩選（單欄條件）、排序（點欄位標題） | ✅ 完成 |
| — | MongoDB（文件攤平成表格，沿用表格手感） | ✅ 完成 |
| — | Redis（key 列表化 + 五種結構檢視） | ✅ 完成 |
| — | 備份 / 還原（手動，CLI 為主 + SQLite 檔案複製） | ✅ 完成 |
| — | 連線設定持久化 + 密碼 OS keychain 加密 | ✅ 完成 |
| — | SSH Tunnel（密碼 / 私鑰認證） | ✅ 完成 |
| — | 排程備份 + 備份歷史管理 | ✅ 完成 |
| — | Redis 結構編輯、多欄複合篩選、欄寬調整 | ✅ 完成 |
| — | 多欄篩選 AND / OR 切換 | ✅ 完成 |
| — | 資料匯出（CSV / TSV / JSON / SQL / Markdown，多選項） | ✅ 完成 |
| — | SSH host key 驗證（TOFU） | ✅ 完成 |
| — | **SSH 終端機 + SFTP**（參考 Xshell）：側欄獨立「SSH 主機」清單（資料夾；有主機才出現）、可從「新增連線」貼 ssh:// / sftp:// 連線字串加入、多分頁 xterm.js 終端機（密碼 / 私鑰 / keyboard-interactive / ssh-agent · Pageant；私鑰可匯入 OpenSSH、PuTTY PPK、PKCS#8、PEM（含 OpenSSL 3DES / AES 加密）、DER，支援 OpenSSH 使用者憑證，App 內金鑰庫可匯入 / 產生 / 匯出；主機可從 ~/.ssh/config 與 .xsh 工作階段檔匯入；跳板機 ProxyJump（可多層）；終端機狀態列、工作階段記錄與畫面內容存檔）、host key 首次 / 變更確認、命令列輸入條、SFTP 分割面板（瀏覽 / 上下傳 / 改名 / 刪除；Xftp 式 App 內編輯、權限、篩選；多選與資料夾批次上傳下載；斷點續傳；開在終端機所在的資料夾、可跟隨 cd；剪下 / 貼上搬檔；可開成獨立視窗、拖放檔案上傳）、已設 SSH tunnel 的資料庫連線可直接開終端機；AI 只建議指令、由使用者按鈕送出（危險指令分級確認） | ✅ 完成 |
| — | **FTP / FTPS 主機**（suppaftp + rustls）：與 SFTP 共用前端檔案面板與 `ssh_sftp_*` 命令（`FileClient` 分派）；explicit / implicit TLS、自簽憑證指紋 TOFU、被動 / 主動模式；一條瀏覽連線 + 每個傳輸各自的連線（每台主機最多兩條、其餘排隊）；斷點續傳（`REST` / `APPE`，接之前比對已傳部分的結尾） | ✅ 完成 |
| — | **SSH 操作紀錄**：終端機執行的指令（Enter 時從畫面讀，不記鍵盤，密碼提示下打的字讀不到；指令裡的密碼參數換成 ***）、SFTP / FTP 的檔案動作、連線與斷線；一天一個 JSONL 檔、可設保留天數；依時間 / 主機 / 種類 / 關鍵字查詢、匯出 CSV | ✅ 完成 |
| — | **Docker / Docker Registry / Harbor**（`docker` feature，全走既有 reqwest）：Docker Engine API（本機 socket / named pipe、TCP、TLS / mTLS、經 SSH Tunnel），容器 / 映像 / Volume / 網路樹、容器資訊 / Log / Shell / 資源 / 行程、資料庫容器一鍵建連線、總覽與清理、拉取映像；Registry v2（token 換發、多平台清單、依 tag 刪除）；Harbor v2.0 API（artifact、弱點掃描、配額、元件健康）；Registry / Harbor 的映像拉到 Docker | ✅ 完成 |
| — | **Kubernetes**（不引入 kube-rs，REST + 自己收發 WebSocket 幀）：kubeconfig / token / 用戶端憑證 / exec 外部登入指令（EKS / GKE / AKS），限定 namespace、經 SSH Tunnel；namespace → 種類 → 資源樹、概要 / 事件 / YAML（server-side dry-run 試套用、resourceVersion 衝突擋下）、Pod log / exec / metrics、調整副本 / 重新啟動 / CronJob / cordon / 刪除；port-forward（Service 挑就緒 Pod、Pod 重建後自動改轉）與資料庫連線「經由 Kubernetes port-forward」；資源瀏覽器（含 CRD）、套用多文件 YAML、叢集總覽 | ✅ 完成 |
| — | **檔案 / 資料夾 / 二進位比對**（`filecmp` 模組，GUI 比對分頁與 `dbk diff` / `dbk sync` 共用）：本機與 SFTP / FTP 主機任意組合；文字比對逐塊套用與存回（存檔前檢查外部修改）、資料夾比對（大小 + 時間 / 大小 / 內容三種準則、排除規則、不分大小寫）與五種同步規則、十六進位比對（大檔只讀捲到的部分）；已存的比對與最近的比對 | ✅ 完成 |
| — | **側欄分組一致化**：資料庫連線依種類各一區，SSH 主機、遠端桌面各一區；三區共用可摺疊標題、群組、拖曳排序與拖進 / 拖出 | ✅ 完成 |
| — | **遠端桌面（RDP / VNC / Mac 螢幕共享）**：側欄獨立「遠端桌面」清單（資料夾；有主機才出現）、分頁內嵌畫面（RDP 走 IronRDP，TLS / NLA、憑證首次確認、差異區塊 + 反壓；VNC 走 noVNC，後端代做認證含 Apple ARD，密碼不進前端）、全螢幕（Ctrl+Alt+Enter，浮動工具列送 Ctrl+Alt+Del / Win / Alt+Tab）、動態解析度 / 縮放 / 原始大小、可經已存 SSH 主機轉接、連線字串（rdp:// 兩種寫法、mstsc /v:、vnc://、rustdesk://）與 .rdp 檔匯入 | ✅ 完成 |
| — | 遠端桌面第二階段：RDP / VNC 剪貼簿文字同步（系統剪貼簿由後端讀寫）、Windows 低階鍵盤攔截（全螢幕時 Win / Alt+Tab / Alt+F4 / Ctrl+Esc 直接進遠端） | ✅ 完成 |
| — | 遠端桌面第三階段：RDP 剪貼簿圖片 / 檔案、macOS 全螢幕按鍵攔截（需輔助使用權限） | ⏳ 規劃中 |
| — | RustDesk 相容連線第一階段：獨立 AGPL 輔助程式 `rustdesk-bridge/`（stdin / stdout 與 db-kit 對話）、Direct IP、密碼登入 / 對方按接受、VP9 / VP8 影像原封不動交給 WebView 的 WebCodecs 解碼、鍵盤滑鼠、可經 SSH 主機轉接 | ✅ 完成 |
| — | RustDesk 第二階段：用 RustDesk ID 連線——ID 伺服器（hbbs，公開或自架 + Key）→ TCP 打洞直連，不行就經中繼（hbbr）→ 驗過簽章的端到端加密（box / secretbox 金鑰交換）；可貼上 RustDesk 匯出的伺服器設定字串 | ✅ 完成 |
| — | RustDesk 多螢幕：工具列每個螢幕一顆按鈕切換、「所有螢幕」照排列拼成一張；對方插拔螢幕 / 換解析度時跟著更新 | ✅ 完成 |
| — | RustDesk 工具列：顯示設定（檢視方式 / 畫質 / 編碼 / 連線品質）、動作（Ctrl+Alt+Del / 鎖定 / 封鎖輸入 / 重新啟動）、剪貼簿文字同步、聊天、錄影；鍵盤依對方系統換算鍵碼並帶鎖定鍵狀態；虛擬鍵盤、輸入作業系統密碼、鍵盤模式（對應 / 翻譯）；斷線自動重連 | ✅ 完成 |
| — | RustDesk 檔案傳輸：雙窗格（本機 / 對方）、上傳下載整個資料夾、改名刪除、傳輸清單與同名處理跟 SFTP 共用 | ✅ 完成 |
| — | RustDesk 畫面與游標：游標換成對方的形狀、顯示對方游標、自訂縮放、真彩 4:4:4、跟著對方切換螢幕、滾輪反向、截圖 | ✅ 完成 |
| — | RustDesk 第三階段：音訊、UDP / IPv6 打洞、傳檔的斷點續傳 | ⏳ 規劃中 |
| — | VNC 工具列：顯示設定（檢視方式 / 畫質 / 只看不控制 / 游標點）、動作（Ctrl+Alt+Del / 重新整理 / 虛擬機電源）、截圖、錄影；虛擬鍵盤、剪貼簿文字逐字打出、斷線自動重連 | ✅ 完成 |
| — | VNC 加密：VeNCrypt 匿名 TLS（自製 ECDH_anon TLS 1.2 用戶端）與 X509 憑證 TLS（rustls，憑證首次確認、與 RDP 共用 TOFU）；「自動」優先走加密 | ✅ 完成 |
| — | VNC 加密：RSA-AES | ⏳ 規劃中 |
| — | 查詢效能分析（EXPLAIN） | ✅ 完成 |
| — | 結構編輯（DDL：新增/刪除/改名欄位） | ✅ 完成 |
| — | ER 圖（表 + 外鍵關係） | ✅ 完成 |
| — | Redis 強化（仿 Another Redis）：鍵列右鍵選單（檢視/複製鍵名/改名/設 TTL/刪除）、DB 節點右鍵（新增鍵/清空 DB/伺服器狀態/命令列）、伺服器狀態面板（INFO 重點指標 + 全分區，可自動刷新）、命令列 Console（指令歷史 ↑/↓、DB 切換、clear） | ✅ 完成 |
| — | 索引管理（新增 / 刪除，MySQL / PostgreSQL / SQLite / MongoDB） | ✅ 完成 |
| — | Ping 既有連線（量測往返延遲，含 SSH 通道） | ✅ 完成 |
| — | MongoDB 查詢增強：sort / projection / limit、**聚合管線**、批次 insert / update / delete（CRUD-via-JSON） | ✅ 完成 |
| — | 查詢編輯器顯示 `RETURNING` 結果（PostgreSQL / SQLite） | ✅ 完成 |
| — | **CSV 資料匯入**（RFC4180 解析、空欄→NULL、逐列回報） | ✅ 完成 |
| — | 轉儲整庫結構 SQL（所有表建表語句） | ✅ 完成 |
| — | PostgreSQL 嚴格型別寫入修正（整數 / 複合主鍵 CRUD、數值範圍篩選原生比較） | ✅ 完成 |
| — | **視覺化查詢建構器**（Visual Query Builder，致敬 Navicat）：勾選表 / 欄、外鍵自動 JOIN、WHERE / GROUP BY 聚合 / HAVING / ORDER BY / DISTINCT / LIMIT / OFFSET、即時預覽 + 計數，帶入編輯器；可從資料表右鍵開啟 | ✅ 完成 |
| — | **Excel（.xlsx）匯出 / 匯入**（rust_xlsxwriter / calamine，純 Rust）：數字保真、凍結表頭 + 自動欄寬、第一張工作表匯入 | ✅ 完成 |
| — | **查詢結果匯出**統一走後端管線（CSV / TSV / Excel / JSON / SQL / Markdown） | ✅ 完成 |
| — | **SQL 片段庫**（Snippets）：編輯器自動完成 + 工具列管理，11+ 內建骨架 | ✅ 完成 |
| — | **資料傳輸**（Data Transfer）：跨連線 / 跨庫複製表資料、同名欄位交集、目標不存在時自動建表（同種類）、整庫多表一次傳 | ✅ 完成 |
| — | **資料比對 / 同步**（Data Synchronization）：以主鍵比對兩表，產生 INSERT / UPDATE / DELETE 同步 DML（共同欄位） | ✅ 完成 |
| — | **結構 / 資料比對 v2**（Rust 引擎，GUI 與 `dbk compare` 共用）：結構比對含索引 / 外鍵 / 預設值 / 註解 / 視圖 / 程序並產生雙向 DDL（含 DROP、破壞性分級）；資料比對改為主鍵排序串流 merge-join（排序規則不一致自動退雜湊），**無 20k 列上限**，單表 / 整庫皆可，含快速預檢；同步 SQL 可直接於目標分批交易套用；結構快照存檔（JSON）可與即時或另一快照比對；Markdown / HTML / JSON 報告；支援 MySQL / MariaDB / PostgreSQL / SQLite / SQL Server / Oracle | ✅ 完成 |
| — | **外鍵雙向導覽**：儲存格跳至參照的列；主鍵儲存格找參照此列的列 | ✅ 完成 |
| — | **命令面板**（Ctrl/Cmd+K）：模糊搜尋跳轉連線 / 資料庫 / 資料表 / 動作 | ✅ 完成 |
| — | **連線唯讀模式**：擋查詢寫入 / DDL 與資料格 / 側欄寫入動作；**連線色標**區分環境；**釘選常用表** | ✅ 完成 |
| — | **參數化查詢** `:name`：執行前提示輸入並安全代入（方言跳脫、`::type` 不誤判） | ✅ 完成 |
| — | **SQL 編輯器**：格式化 / 壓縮單行 / 關鍵字大小寫、Copy as IN、相異值分布 | ✅ 完成 |
| — | **整庫資料庫文件**（HTML / Markdown 報表，含目錄） | ✅ 完成 |
| — | **跨庫查詢自動完成**（同一連線多 database / schema）：巢狀結構命名空間、`其他庫.` 按需載入、限定名精確對表、工具列「跨庫」預載多選、AI 審查含跨庫結構 | ✅ 完成 |
| — | **AI 唯讀資料庫工具**：助手可自己 list / describe / 取樣 / SELECT / EXPLAIN（一次一句、200 列 / 8 KB / 30 秒上限，寫入機制上做不到）；每次呼叫的 SQL 與結果列在回應裡供稽核；API 供應商內建，CLI 供應商走新增的 `dbk mcp`（手寫 MCP stdio 伺服器） | ✅ 完成 |
| — | **編輯器 AI 動作 + 差異預覽**：解釋 / 最佳化 / 修正 / 加註解 / 轉方言 / 產生測試資料 / 白話解釋計畫；`Ctrl+I` 自然語言就地指示；改寫一律先逐塊比對，接受後進 undo 歷史 | ✅ 完成 |
| — | **DBA agent 審查 + AI 資源庫**：人設 / 技能 / 全部提示範本改成 Markdown 靜態檔（格式相容 Claude Code subagent 與 Agent Skills），內建 < 個人 < 團隊資料夾三層覆蓋、輸出契約鎖定、必要變數保底、前後端共用案例釘住同一套範本引擎；DBA 可自己用唯讀工具驗證（人設決定工具白名單與回合上限）、多位 DBA 會審取最嚴格結論；三個入口（編輯器 SQL、審查並執行、資料表結構）；一鍵同步到 Claude Code / Codex（不覆蓋使用者自己的檔）；`dbk ai list / show / lint / sync`、`dbk run --persona`、`dbk mcp --tools` | ✅ 完成 |
| — | **審查並執行**（GUI 與 `dbk run` 共用）：AI 審查 → 逐句擷取前像 → 回滾語句先落地 → 執行 → 擷取後像比對；依型別無損取值（BLOB / 時區 / 浮點精度）；DDL 回滾沿用結構比對產生器；腳本、審查、`rollback.sql`、`diff.md`、快照寫入指定目錄；交易控制 / session 狀態語句整份擋下；AI 助手的寫入語句同走此流程；MySQL / PostgreSQL / SQL Server / SQLite 端到端還原驗證 | ✅ 完成 |
| — | **對話面板增強**：`@` 指定附帶範圍（表 / 庫 / 檔案 / 查詢 / 結果 / 錯誤，含預算與「沒帶成」的交代）、`/` 斜線命令、SQL 區塊就地執行並回饋、HTTP 供應商對話歷史落地、`Ctrl+L` 聚焦 | ✅ 完成 |

## 各資料庫備份機制（規劃）

| 資料庫 | 備份方式 | 策略 |
|--------|----------|------|
| MySQL | 邏輯匯出 (SQL) | 優先 mysqldump；無則 sqlx 自組 |
| PostgreSQL | pg_dump | 呼叫系統 pg_dump |
| SQLite | 檔案複製 / .dump | 直接複製檔案或 VACUUM INTO |
| MongoDB | BSON / JSON | 優先 mongodump |
| Redis | RDB / 逐 key | BGSAVE 或 DUMP/RESTORE |

策略：官方 CLI 工具為主、內建邏輯匯出為輔。偵測使用者機器是否安裝官方工具，有則使用，無則降級。

## 安全注意（規劃）

- 備份檔含敏感資料 → 提供 AES 加密選項。
- 備份設定（含密碼）→ 存於 OS keychain。
- 還原與 DROP 類破壞性操作 → 二次確認。
