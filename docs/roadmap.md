# 開發路線圖

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
| — | **外鍵雙向導覽**：儲存格跳至參照的列；主鍵儲存格找參照此列的列 | ✅ 完成 |
| — | **命令面板**（Ctrl/Cmd+K）：模糊搜尋跳轉連線 / 資料庫 / 資料表 / 動作 | ✅ 完成 |
| — | **連線唯讀模式**：擋查詢寫入 / DDL 與資料格 / 側欄寫入動作；**連線色標**區分環境；**釘選常用表** | ✅ 完成 |
| — | **參數化查詢** `:name`：執行前提示輸入並安全代入（方言跳脫、`::type` 不誤判） | ✅ 完成 |
| — | **SQL 編輯器**：格式化 / 壓縮單行 / 關鍵字大小寫、Copy as IN、相異值分布 | ✅ 完成 |
| — | **整庫資料庫文件**（HTML / Markdown 報表，含目錄） | ✅ 完成 |

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
