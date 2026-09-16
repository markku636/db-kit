<p align="center">
  <img src="docs/hero.png" alt="db-kit — MAGIDB CONNECT：一站式跨平台資料庫管理工具" width="860">
</p>

<h1 align="center">db-kit</h1>

<p align="center"><strong>MAGIDB CONNECT — Making Data Connections Magical</strong></p>

<p align="center">
一站式跨平台桌面資料庫工具，以單一一致的介面管理<br>
<strong>MySQL · MariaDB · PostgreSQL · SQL Server · Oracle · SQLite · MongoDB · Redis · Kafka · Elasticsearch · RabbitMQ</strong>。
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white">
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-22c55e">
</p>

<p align="center">
  <strong>💚 100% 開源免費</strong>　·　MIT 授權　·　無付費牆　·　無功能鎖　·　無遙測　·　可自由 fork / 自託管
</p>

<p align="center">
  <strong>繁體中文</strong> · <a href="./README.en.md">English</a>
</p>

> ☕ 這個工具免費且開源。如果幫上忙，可以 [請我喝杯咖啡](#贊助開源)。

---

## 這是什麼

工程師與 DBA 的日常往往要在 MySQL、MariaDB、PostgreSQL、SQL Server、Oracle、MongoDB、Redis… 之間來回切換，桌面上散落著好幾個各有脾氣的管理工具。**db-kit** 把它們收進同一套介面、同一套連線管理、同一套主題——關聯式、文件型、鍵值型三種資料範式都有貼合各自手感的瀏覽與編輯體驗，且日常操作（資料格、查詢、ER 圖、匯入匯出、備份）跨資料庫對齊。

採用 **Tauri 2（Rust 後端 + Web 前端）**，安裝檔小、記憶體佔用約為 Electron 同類產品的十分之一；資料庫連線一律收在 Rust 後端、前端透過 Tauri command 呼叫，不直連、兼顧安全與效能。

## 贊助開源

這個工具免費且開源。如果它幫你省下了時間，可以請我喝杯咖啡，讓後續的更新繼續做下去。

[![PayPal $5](https://img.shields.io/badge/PayPal-%245-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/8B7GRXA6UJH36)
[![PayPal $10](https://img.shields.io/badge/PayPal-%2410-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/8LBTFUBBF2CHS)
[![PayPal $15](https://img.shields.io/badge/PayPal-%2415-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/A653DD46GEU4W)
[![PayPal $25](https://img.shields.io/badge/PayPal-%2425-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/Y5WPSXVGH3YS4)

其他金額請走 [PayPal.Me](https://paypal.me/226network)。

## 跨平台

一套程式碼、一致體驗，產出 **Windows / macOS / Linux 三平台原生桌面 App**：

- **同一份程式碼，三平台原生輸出** — 基於 Tauri 2，`npm run tauri build` 在各平台直接產出對應的原生安裝檔：Windows `.msi` / `.exe`（NSIS）、macOS `.dmg`、Linux `.AppImage` / `.deb`，皆為原生視窗而非瀏覽器分頁。
- **介面與操作手感跨平台一致** — 連線樹、可編輯資料格、查詢編輯器、ER 圖、鍵盤快捷鍵、深 / 亮色主題在三個平台完全相同，換機器不必重新熟悉。
- **密碼存各 OS 原生 keychain** — 透過 `keyring` 對應到 Windows 認證管理員、macOS Keychain、Linux Secret Service（libsecret），密碼不落地到磁碟。
- **`dbk` CLI 同樣跨平台** — 可在 Linux 伺服器上以 `--no-default-features` 編出不連 Tauri 的精簡 binary，SSH 進機器即可查詢 / 匯出 / 備份 / 寫入。
- **輕量** — Tauri 直接用系統內建 WebView（Windows 為 WebView2、macOS 為 WKWebView、Linux 為 WebKitGTK），不內嵌 Chromium，安裝檔小、記憶體佔用約為 Electron 同類產品的十分之一。

> GitHub Releases 已提供 **Windows / macOS / Linux** 三平台預編譯安裝檔（由 GitHub Actions 自動打包）。macOS 同時提供 Apple Silicon 與 Intel 版本；安裝檔皆未付費簽章，首次開啟需依下方步驟略過系統警示。也可依 [從原始碼建置](#從原始碼建置) 自行 `npm run tauri build`。

## 畫面預覽

> App 實際畫面截圖（production build，預設的 **Amethyst 紫水晶**深色主題）；畫面中的連線與資料皆為虛構的示範電商 schema。
> 隨程式碼演進可用 `npm run make:screenshots` 重拍（Playwright 實拍，見 [`scripts/capture-screenshots.mjs`](./scripts/capture-screenshots.mjs)）。

| 資料表檢視 — 連線樹 · 分頁 · 可編輯資料格 | 查詢編輯器 — 多語句 · 結果集堆疊（SSMS 風格） |
|:---:|:---:|
| ![資料表檢視](docs/screenshots/01-data-grid.png) | ![查詢編輯器](docs/screenshots/02-query-editor.png) |
| **ER 圖** — 外鍵關係 · 可拖曳表卡 · 佈局記憶 | **Redis** — 命名空間鍵樹 · 結構編輯 · INFO 狀態 |
| ![ER 圖](docs/screenshots/03-er-diagram.png) | ![Redis 檢視](docs/screenshots/04-redis.png) |

**進階物件搜尋**（`Ctrl+Shift+G`）— 跨資料庫找表 / 欄位 / 索引 / 預存程序，可搜「定義內文」與「註解」，支援整字比對與萬用字元；命中處高亮，並可一鍵「在物件總管中選取」跳回側欄：

<p align="center">
  <img src="docs/screenshots/05-advanced-search.png" alt="進階物件搜尋" width="860">
</p>

**Kafka 訊息瀏覽器** — 主題樹、分區 / 位移 / Key / Value 一覽、JSON 明細與 headers；一次性查詢與即時 tail，另有叢集總覽、消費者群組、監控告警、Schema Registry / Connect / ACL 面板：

<p align="center">
  <img src="docs/screenshots/06-kafka.png" alt="Kafka 訊息瀏覽器" width="860">
</p>

**SQL 壓力測試** — 多執行緒重複執行同一段查詢，量 TPS 與延遲分佈。固定迭代或持續時間 + 爬升、每執行緒暖機、`:name` 參數以 CSV 輪替代入（避免整場只打同一把 key 而全落在快取）；報表含 p50 / p90 / p95 / p99、每秒取樣的 TPS 與 p95 折線，錯誤指紋化分組。走**專屬連線池**不佔用互動連線，寫入與高破壞語句預設擋下：

<p align="center">
  <img src="docs/screenshots/07-stress-test.png" alt="SQL 壓力測試" width="860">
</p>

**SQL 審查** — 打字當下即時列出寫法與效能問題，**不執行查詢、不需要 AI、離線可用**。點一筆即在編輯器選取對應範圍；規則涵蓋不到的語意與索引選擇度，再一鍵交給「AI 深入審查」：

<p align="center">
  <img src="docs/screenshots/08-sql-review.png" alt="SQL 審查" width="860">
</p>

**執行預存程序** — 右鍵程序 →「執行程序…」，一格一引數：方向（IN / OUT / INOUT）、名稱、型別由畫面給，引號由型別決定，留空即 `NULL`。OUT 引數走 session 變數自動接回值。送出的 SQL 一律攤在下方，需要運算式時勾「編輯 SQL」直接改：

<p align="center">
  <img src="docs/screenshots/09-routine-exec.png" alt="執行預存程序的引數表單" width="860">
</p>

**結構比對** — 比整個資料庫，或只比某一張表。目標可以是同一條連線的另一個庫、**另一條連線**，或先前存下的結構快照檔。差異涵蓋欄位、索引、外鍵、視圖與預存程序；同步 DDL 依相依性排序產生，破壞性語句（DROP / 改型別 / 加 NOT NULL）另外分組、要再勾一次才送得出去，引擎表達不出來的變更一律列進「略過」而不是靜默漏掉。**AI 總結**把差異濃縮成風險與執行順序（只送結構摘要，不送任何資料）；報告可匯出 Markdown / HTML / JSON：

<p align="center">
  <img src="docs/screenshots/10-schema-compare.png" alt="整庫結構比對與同步腳本" width="860">
</p>

> 逐步操作、四種比對情境（兩個庫 / 單一資料表 / 跨連線 / 對快照）與各資料庫的注意事項，見 **[結構比對使用指南](./docs/compare.md)**。

**審查並執行** — 在正式環境跑會改資料的腳本之前，查詢分頁工具列的「審查並執行」會先請 AI 審查（預期的前後差異、風險、修正建議），接著**逐句**「擷取會被改到的列 → 寫入回滾語句 → 執行 → 再擷取一次比對差異」，腳本、AI 審查、`rollback.sql`、前後像快照與 `diff.md` 全部寫進你指定的目錄。前像以依型別改寫的查詢無損擷取（BLOB、時間戳時區、浮點精度都原封不動），不確定能安全還原的回滾語句一律註解掉並寫明原因；交易控制、session 狀態這類在連線池上不可靠的語句會整份擋下。AI 助手對話裡的寫入語句、命令列 `dbk run` 走同一套。

<p align="center">
  <img src="docs/screenshots/12-review-run.png" alt="審查並執行：逐句回滾等級與 AI 審查結論" width="860">
</p>

執行後結果分頁列出逐欄的執行前 / 執行後差異；回滾腳本最後一句排最前面，無法安全還原的列以註解列出並寫明原因：

<p align="center">
  <img src="docs/screenshots/13-review-run-diff.png" alt="審查並執行：執行前後差異" width="860">
</p>

> 回滾等級怎麼判、輸出目錄裡每個檔案是什麼、各資料庫的還原做法與限制，見 **[審查並執行使用指南](./docs/review-run.md)**。

**整庫文件** — 右鍵資料庫 →「資料庫文件…」，把每張表的欄位、型別、可空、鍵、預設值與註解整理成一份可交付的文件，Markdown 與 HTML 兩種格式，附目錄錨點：

<p align="center">
  <img src="docs/screenshots/11-db-docs.png" alt="整庫資料字典" width="860">
</p>

## 下載安裝

<p align="center">
  <a href="https://github.com/markku636/db-kit/releases/latest">
    <img alt="下載最新版" src="https://img.shields.io/github/v/release/markku636/db-kit?label=%E4%B8%8B%E8%BC%89%E6%9C%80%E6%96%B0%E7%89%88&style=for-the-badge&color=22c55e">
  </a>
</p>

前往 **[Releases 頁面下載最新版本 ⬇️](https://github.com/markku636/db-kit/releases/latest)**，依作業系統選擇對應安裝檔：

| 平台 | 安裝檔 | 安裝方式 |
|------|--------|----------|
| **Windows** 10 / 11 | `db-kit_x.y.z_x64-setup.exe`（NSIS）<br>或 `db-kit_x.y.z_x64_en-US.msi`（MSI） | 下載後雙擊執行，依精靈完成安裝 |
| **macOS** Apple Silicon（M 系列） | `db-kit_x.y.z_aarch64.dmg` | 開啟 .dmg，把 DB Kit 拖進「應用程式」 |
| **macOS** Intel | `db-kit_x.y.z_x64.dmg` | 開啟 .dmg，把 DB Kit 拖進「應用程式」 |
| **Linux** Debian / Ubuntu | `db-kit_x.y.z_amd64.deb` | `sudo dpkg -i db-kit_*.deb` 或用軟體中心安裝 |
| **Linux** Fedora / RHEL | `db-kit-x.y.z-1.x86_64.rpm` | `sudo rpm -i db-kit-*.rpm` |
| **Linux** 免安裝 | `db-kit_x.y.z_amd64.AppImage` | `chmod +x *.AppImage` 後直接執行 |

**Windows 安裝步驟**

1. 到 [Releases](https://github.com/markku636/db-kit/releases/latest) 下載 `.exe`（建議）或 `.msi`。
2. 雙擊執行；若 SmartScreen 跳出警告，點「更多資訊」→「仍要執行」（安裝檔未付費簽章所致）。
3. 完成後從開始選單啟動 **db-kit**。

> **需要 WebView2 Runtime**：Windows 11 已內建、Windows 10 多數也已隨更新安裝；若缺少，安裝檔會自動提示下載。

**macOS 安裝步驟**

1. 依晶片下載對應 `.dmg`：Apple Silicon（M1/M2/M3…）選 `aarch64`，Intel 選 `x64`。
2. 開啟 .dmg，把 **DB Kit** 拖進「應用程式」資料夾。
3. 首次開啟因安裝檔**未經 Apple 簽章 / 公證**，會跳「無法驗證開發者」：請對 App 圖示按**右鍵 →「打開」→「打開」**即可（只需一次）。
   - 若仍被擋，可在終端機執行：`xattr -dr com.apple.quarantine "/Applications/DB Kit.app"`。

**Linux 安裝步驟**

- Debian / Ubuntu：`sudo dpkg -i db-kit_*.deb`（缺依賴時補 `sudo apt-get -f install`）。
- Fedora / RHEL：`sudo rpm -i db-kit-*.rpm`。
- 任意發行版（免安裝）：下載 `.AppImage`，`chmod +x` 後直接執行。

想自己打包安裝檔，請見下方 [從原始碼建置](#從原始碼建置)。

## 快速上手

安裝後第一次使用，三步驟即可連上資料庫：

1. **新增連線** — 左上角點 **「＋ 新增連線」**，選擇資料庫類型（MySQL / MariaDB / PostgreSQL / SQL Server / Oracle / SQLite / MongoDB / Redis / Kafka）。
2. **填入連線資訊** — 輸入主機、連接埠、帳號、密碼（或選 SQLite 檔案）。需要時可在 **SSH Tunnel** 分頁設定跳板。先按 **「測試連線」** 確認可連，再 **儲存**。
3. **開始操作** — 連線會出現在左側樹狀清單，展開資料庫 → 雙擊資料表即可瀏覽 / 編輯資料；上方分頁可開查詢編輯器、ER 圖等。

> 密碼會存進作業系統的 keychain（不落地到磁碟）。連線設定可隨時在連線上按右鍵「編輯 / 複製 / 刪除」。

> **Oracle 前置需求**：連 Oracle 需先安裝 **64 位元 [Oracle Instant Client](https://www.oracle.com/database/technologies/instant-client/downloads.html)**（Basic 或 Basic Light）並加入 PATH（或在連線設定填入 client 目錄）——這是 Oracle 官方驅動的原生相依，db-kit 不隨附；未安裝時只有 Oracle 連線會提示，其他資料庫完全不受影響。伺服器需 Oracle 12c 以上。

**沒有現成資料庫可連？** 用 Docker 起一個測試用 MySQL：

```bash
docker run --name mysql-test -e MYSQL_ROOT_PASSWORD=test1234 -p 3306:3306 -d mysql:8
# 之後在 db-kit 新增連線：host 127.0.0.1、port 3306、user root、password test1234
```

常用操作速覽：

| 想做的事 | 怎麼做 |
|----------|--------|
| 編輯資料 | 雙擊儲存格直接改 → 按 **✓** 套用（以主鍵定位寫回） |
| 篩選 / 排序 | 點欄位標題排序、Shift+點擊多欄；工具列開多欄複合篩選 |
| 跑 SQL | 開「查詢編輯器」分頁，**Ctrl+Enter** 執行游標所在語句、**F6** 執行整段（也可只跑反白段） |
| 一次跑多條 | 多條語句以 `;` 分隔，各自的結果集**堆疊顯示**（SSMS 風格），可分別排序 / 篩選 / 匯出 |
| 跨庫查詢 | 同一連線直接寫 `其他庫.表`（PostgreSQL 為 `schema.表`）；打 `其他庫.` 就會補出那個庫的表，工具列「**跨庫**」可預先勾選常用的庫 |
| 找東西在哪 | **Ctrl+Shift+G** 進階物件搜尋（跨庫找表 / 欄 / 索引 / 程序定義）；**Ctrl+K** 命令面板快速跳轉 |
| 匯出 / 匯入 | 資料格工具列匯出 CSV / JSON / Excel / SQL…；CSV / Excel 可匯入資料表 |
| 看表關聯 | 開「ER 圖」分頁，拖曳表卡、佈局自動記憶 |
| 換配色 | 右上角主題選單：光亮 / 暗黑 + 7 套寶石系變體（整個 App 與編輯器一起換） |
| 調字級 | 設定 → 字級：**介面字級**讓整個 App 的文字與間距等比縮放（最小 12px ～ 超大 22px）；**程式碼字級**只管查詢編輯器與程式碼區塊（也吃 **Ctrl** **+** / **−** / **0**） |
| 問 AI | 右側面板（**Ctrl+L**）串接本機 Claude Code / OpenAI Codex CLI，或任何 Anthropic / OpenAI 相容 API（面板上可切換）。助手可自己下唯讀查詢；輸入 `@` 指定要附帶哪幾張表、`/` 用指令 |
| 改 SQL | 在編輯器選一段 → 右鍵或 **Ctrl+Shift+E**：解釋 / 最佳化 / 修正 / 加註解 / 轉方言，改寫先看差異再套用（**Ctrl+I** 可直接用一句話下指示） |

## ✨ 亮點

- **一站式八大資料庫 + Kafka** — MySQL · MariaDB · PostgreSQL · SQL Server · Oracle · SQLite · MongoDB · Redis · Kafka，全部可實際連線，共用同一套連線樹、資料格與快捷鍵。
- **跨平台桌面 App** — 同一份程式碼產出 Windows / macOS / Linux 三平台原生安裝檔，介面、快捷鍵、連線管理與 keychain 完全一致；`dbk` CLI 亦跨平台（見 [跨平台](#跨平台)）。
- **輕量高效** — Tauri 2 架構，用系統內建 WebView、比 Electron 輕約 10×；啟動走骨架屏（零白屏）、首包 JS 約 470 KB，CodeMirror 延後到開查詢分頁才載。
- **一次跑多條、結果各自成格** — 多語句批次執行時每個結果集**堆疊同時顯示**（致敬 SSMS / MySQL Workbench），各格獨立捲動 / 排序 / 篩選，可單格或「全部匯出」；中途失敗仍保留先前已取回的結果集。
- **整套主題系統** — 內建 7 套寶石系配色（Amethyst / Moonstone / Jade / Garnet / Amber / Ruby / Obsidian），從工具列一鍵切換，**同時驅動整個 App 與 SQL 編輯器語法高亮**；AI 助手的程式碼區塊也跟著換色。
- **安全可靠** — 連線密碼存於 OS keychain（磁碟不落地）、SSH Tunnel（密碼／私鑰）+ host key TOFU 驗證、所有寫入以主鍵定位 + 全參數化綁定防注入；另有**結果列數上限**與**查詢逾時**兩道安全網，誤跑 `SELECT *` 大表不會炸掉記憶體。
- **桌面級操作手感** — 儲存格直接編輯、右鍵選單、鍵盤導覽、多欄排序、欄寬拖曳、依值篩選、內容檢視器、即時尋找、表頭 hover 顯示欄位註解。
- **內建 AI 助手（四種供應商）** — 右側面板可接**本機 CLI**（Claude Code / OpenAI Codex，用你自己的訂閱登入，不需要 API key）或**任何 Anthropic / OpenAI 相容 API**（官方 API、OpenRouter / DeepSeek / Kimi / GLM / Groq，以及地端的 Ollama / LM Studio / vLLM —— 填 Base URL 與模型即可，地端端點免金鑰）。串流回答資料庫問題、撰寫／優化 SQL，並可附帶目前連線的 schema 作上下文。供應商在面板上隨時切換，助手與「AI 生成查詢」列共用同一個選擇。**API 金鑰只存 OS keychain**，設定檔與前端都拿不到明文。
- **助手能自己讀資料庫（唯讀）** — 不再只能看前端塞給它的那一張表：助手可以自己 `list_tables` / `describe_table` / 取樣 / 下 `SELECT`，所以「這個庫是做什麼的」「上個月訂單多少」這類問題它查得到答案。**一律唯讀**，且是機制上做不到寫入而非提示裡請它不要——連 `EXPLAIN ANALYZE DELETE` 都擋；一次一條語句、200 列 / 8 KB / 30 秒上限；**它跑過的每一條 SQL 與結果摘要都列在回應裡**，可一鍵貼回編輯器稽核。正式環境連線第一次使用前另外確認一次。API 供應商內建此能力，CLI 供應商（Claude Code / Codex）則透過內建的 `dbk mcp` 提供同一組工具。
- **編輯器內的 AI 動作 + 差異預覽** — 選一段 SQL（或把游標放在某條語句上），右鍵／`Ctrl+Shift+E`／工具列「AI 動作」：解釋、最佳化、修正錯誤、加註解、轉換方言（MySQL ↔ PostgreSQL ↔ SQL Server ↔ Oracle ↔ SQLite）、產生測試資料、白話解釋執行計畫。`Ctrl+I` 可直接用一句話描述要怎麼改。改寫類動作**一律先顯示差異**：逐塊可拒絕、可手動微調，按「接受」才寫回編輯器，而且進 undo 歷史（`Ctrl+Z` 退得回去）。
- **對話面板：@ 範圍、/ 指令、就地執行** — 打 `@` 指定要附帶哪幾張表（或 `@query` / `@result` / `@error` 帶入編輯器現況），送出前就看得到「這則帶了 3 張表、約 4.2 KB」；沒帶成的也會標出原因，不會靜默消失。`/explain`、`/fix`、`/optimize`、`/sql`、`/schema` 等指令免打整段提示。回應裡的 SQL 區塊可直接「執行」或「執行並回饋」（結果交回模型接著分析），守門與查詢分頁同一套——唯讀連線擋寫入；**寫入語句先進入「審查並執行」**（AI 審查 + 逐句備份 + 回滾腳本）才會執行。HTTP 供應商的對話歷史會落地，重開 App 續聊不會失憶。
- **審查並執行：寫入前的安全網** — 查詢分頁工具列一鍵：AI 先審查腳本（預期前後差異、風險、修正建議），接著**逐句**擷取會被改到的列、回滾語句先寫進檔案、執行、再擷取一次比對。腳本、AI 審查、`rollback.sql`、`diff.md` 與前後像快照全部寫進你指定的目錄；值依型別無損擷取（BLOB、時區、浮點精度原封不動），不確定能安全還原的語句一律註解掉並寫明原因。命令列 `dbk run` 同一套（詳見 [審查並執行使用指南](./docs/review-run.md)）。
- **人設與技能** — 助手的系統提示詞（人設）可以改，並可存多組具名的「技能」（如「SQL 效能診斷」「唯讀安全至上」），在面板上一鍵勾選套用；四種供應商共用同一份設定。
- **附命令列工具 `dbk`** — 查詢 / 瀏覽 / 匯出 / 備份 + **寫入（修改 · 刪除，需 `--yes`，高破壞再要 `--force`）** 的 CLI，重用同一套連線與 keychain，可 `--no-default-features` 編成不連 Tauri 的精簡 binary，適合伺服器與 script 場景（見 [命令列工具](#命令列工具dbk-cli)）。
- **完整工程實踐** — 後端以 Docker 真實資料庫（MySQL / PostgreSQL / SQLite / MongoDB / Redis）做整合測試、Rust 單元測試覆蓋各方言 SQL 生成（含 MariaDB / Oracle）、前端 vitest 覆蓋（329 項），另有 **`npm run verify:ui` UI 冒煙檢查**（production build + Tauri invoke shim 驗右鍵選單與分頁行為，免 Docker / 免真實資料庫），經多輪對抗式自我審查修正安全與正確性問題（見 [CHANGELOG](./CHANGELOG.md)）。

## 功能特色

| 範疇 | 重點功能 |
|------|----------|
| 關聯式（MySQL / MariaDB / PostgreSQL / SQL Server / Oracle / SQLite） | 完整 CRUD、DDL 欄位編輯、索引 / 外鍵管理、EXPLAIN + 視覺化執行計畫（SQL Server 走 SHOWPLAN XML、Oracle 走 DBMS_XPLAN）、routines（預存程序 / 函式）、RETURNING 顯示、ER 圖、結構比對、SSL 模式（MySQL 系 / PG） |
| 文件型（MongoDB） | 文件攤平成表格、find / 聚合管線、CRUD-via-JSON、**explain 執行計畫視覺化**、JSON 查詢編輯器（語法高亮 + 欄位補全）、進階索引（TTL / partial / text / $indexStats 使用率）、**驗證規則（JSON Schema）**、欄位統計（型別分布 / Top 值）、**監控面板**（serverStatus / dbStats / currentOp / Profiler） |
| 鍵值型（Redis） | 五種結構檢視＋編輯、命名空間鍵樹（**右鍵新增 / 改名 / TTL / 複製鍵值 / 整個命名空間批次刪除**、就地縮小 SCAN 範圍）、值格式化、Pub/Sub、**維運面板**（慢查詢 / 用戶端 / 大鍵，掃出的大鍵可勾選批次清除）、命令列 Console |
| 串流（Kafka） | 訊息瀏覽 + live tail、**JS 篩選運算式**（內嵌 boa）+ 反序列化選擇（string / JSON / hex / Avro）+ **搜尋更多**掃描 + JSON 欄位投影、發佈（headers / **Avro 序列化** / **流量模式 + 隨機模板** / CSV 批次；**主題右鍵可直接發佈**）、**叢集總覽**（brokers / URP 健康）、建 / 刪主題（雙重確認）、主題設定編輯 / 加分割區 / 清空、位移重設全功能（含預覽）、消費者群組 + Lag（清單可篩選、右鍵刪除），**監控與告警**（背景取樣 / 手刻 SVG 圖表 / 規則 + OS 通知）、**Schema Registry**（讀寫 / 相容性 / 版本 diff）、**Protobuf 解碼**、**Kafka Connect**（連接器管理 / 設定驗證）、**ACL** 管理 |
| 通用資料格 | 多欄複合篩選（9 運算子 + AND·OR）、多欄排序、依值篩選、**外鍵雙向導覽**（跳至參照 / 找參照此列者）、**Excel + CSV 匯入**、多格式 + **Excel 匯出**、複製為 INSERT/UPDATE/DELETE/IN、欄位剖析 + 相異值分布、**表頭 hover 顯示欄位註解** |
| 查詢工作區 | 語法高亮 + 表/欄自動完成（含 external gateway）、**`@` 使用者變數提示**、**多結果集堆疊**（SSMS 風格，可摺疊 / 單格或全部匯出）、**視覺化查詢建構器**（JOIN / 聚合 / HAVING / 分頁 / 即時預覽）、**SQL 片段庫**、**參數化查詢 `:name`**、格式化 / 壓縮 / 關鍵字大小寫、查詢歷史（200 筆，可過濾）、**收藏查詢**（分組 / 編輯 / 匯出匯入）、只執行反白段、失敗語句定位、多開查詢分頁（右鍵關閉其他）、**重開 app 還原上次開著的分頁**（含停在哪一個；內容本來就 per-連線 × per-分頁 記憶） |
| 搜尋 / 導覽 | **進階物件搜尋 Ctrl+Shift+G**（跨庫搜名稱 / 定義內文 / 註解，整字比對 + 萬用字元 `*` `?`、定義預覽高亮、在物件總管中選取）、**命令面板 Ctrl+K**、側欄搜尋命中自動展開資料夾 |
| 跨庫 / 跨連線 | **跨庫查詢自動完成**（同一連線寫 `其他庫.表` 也補得到表 / 欄 / 別名，打 `其他庫.` 當下按需載入）、**資料傳輸**（單表 / 整庫 / 不存在時自動建表）、**結構比對**（單表 / 整庫；目標可為另一條連線、同連線的其他庫，或結構快照檔；差異含欄位 / 索引 / 外鍵 / 視圖 / 程序，同步 SQL 可直接套用，破壞性語句分級確認；**AI 總結**；Markdown / HTML / JSON 報告）、**資料列比對**（以主鍵串流、無列數上限，走 CLI `dbk compare data`）、**整庫文件**（HTML / Markdown） |
| 效能 | **SQL 壓力測試**（致敬 SQLQueryStress）：多執行緒重複執行、固定迭代或持續時間 + 爬升、暖機、**p50/p90/p95/p99 延遲百分位** + TPS 即時折線、**錯誤指紋化分組**、`:name` 參數 CSV 替換、報表一鍵複製為 Markdown；走**專屬連線池**不佔用互動連線，寫入與高破壞語句預設擋下；亦可用 `dbk stress` 在腳本中跑 |
| 外觀 | **7 套寶石系主題**（Amethyst / Moonstone / Jade / Garnet / Amber / Ruby / Obsidian）驅動整個 App + 編輯器語法高亮，工具列一鍵切換光亮 / 暗黑 / 變體；**全域介面字級**（6 段，整個 App 等比縮放）與**程式碼字級**分開設定 |
| 安全 | 密碼存 OS keychain、SSH Tunnel（密碼 / 私鑰）+ host key TOFU、全參數化綁定防注入、**連線唯讀模式**（擋寫入 / DDL）、**連線色標**（區分正式 / 測試）、**啟動鎖定**（Windows Hello / Touch ID 或 Argon2id 密碼、閒置自動鎖定）、**結果列數上限 / 查詢逾時**、釘選常用表 |
| SQL 審查 | **靜態規則引擎**（對標 Redgate SQL Prompt / SonarQube SQL rules）：15 條規則、三級嚴重度，打字當下即時列出無 WHERE 的 DML、笛卡兒積、欄位套函式讓索引失效、前綴萬用字元 LIKE、`NOT IN` 的 NULL 陷阱、UNION vs UNION ALL、NOLOCK 髒讀、游標逐列處理…；方言感知、**不執行查詢也不需要 AI**，點一筆即跳到編輯器對應位置 |
| AI 助手 | 右側面板串接本機 **Claude Code 或 OpenAI Codex** CLI（下拉即切、各自記住模型）或任何 Anthropic / OpenAI 相容 API：串流問答、撰寫 / 優化 SQL；程式碼區塊套用目前主題的語法高亮。**助手可自己下唯讀查詢**（列表 / 看結構 / 取樣 / SELECT / EXPLAIN；跑過的 SQL 全列在回應裡）；輸入框支援 **`@` 指定範圍**與 **`/` 指令**；回應裡的 SQL 可直接執行並把結果回饋給模型。另有三個一鍵入口——**AI 審查 SQL**（帶規則引擎發現 + 結構 + 索引 + 計畫）、**AI 調校建議**（帶計畫熱點，要求索引 DDL / 改寫 / 代價評估）、**AI 分析壓測結果**（從延遲百分位的形狀反推瓶頸類型） |
| 審查並執行 | 執行前 **AI 審查**（結論徽章：可以執行 / 注意風險 / 不建議執行，預設不送資料列）→ **逐句擷取前像 → 回滾語句先落地 → 執行 → 擷取後像比對**；回滾等級逐句標示（完整 / 部分 / 無），不完整或正式環境要勾選確認；輸出 `script.sql` / `review.md` / `rollback.sql` / `diff.md` / `report.md` / `manifest.json` / `snapshots/`；「只產生備份」不執行（唯讀連線可用）；回滾腳本可再走一次審查並執行；AI 助手寫入語句與 `dbk run` 共用；支援 MySQL / MariaDB / PostgreSQL / SQL Server / Oracle / SQLite |
| AI 動作（編輯器） | 選一段 SQL → 右鍵 / `Ctrl+Shift+E` / 工具列「AI 動作」：解釋、最佳化、修正、加註解、**轉換方言**、產生測試資料、白話解釋執行計畫；`Ctrl+I` 用一句話描述要怎麼改。改寫類一律先走**差異預覽**（逐塊可拒絕、可手改），接受後進 undo 歷史 |
| 多語系 | **繁體中文 · 简体中文 · English · 日本語 · 한국어 · Tiếng Việt**，工具列或設定頁即時切換、不需重啟；前端 / Rust 後端錯誤訊息 / `dbk` CLI（`--lang`、`DBKIT_LANG`）三處同步。各語言的譯文表由 vite 各切一個 chunk，只下載自己那包 |
| 運維 | 連線設定持久化、加密匯出 / 匯入連線（逐筆選連線與機密類別；PROD 連線一律不含帳密）、排程備份 + 備份歷史、連線池監控 + Ping、啟動時檢查新版、跨平台桌面 App |

> 目前進度：**八大資料庫 + Kafka 全部可連線**；關聯式完整 CRUD / DDL 欄位編輯 / 索引管理 / EXPLAIN / RETURNING 顯示、多欄複合篩選（9 種運算子 + AND·OR）排序、**CSV 匯入** + 多格式匯出 + **轉儲整庫結構 SQL**
> SQL Server（tiberius + bb8 連線池）：CRUD、結構分頁（索引 / 外鍵 / DDL）、routines（預存程序 / 函式）、執行計畫（SET SHOWPLAN_XML）、ER 圖、欄位統計；備份 / 還原規劃以 sqlpackage 匯出 `.bacpac`（尚未接上）
> MariaDB 與 MySQL 共用驅動（線協定相容）：MySQL 全功能對齊 + `INSERT/DELETE … RETURNING` 結果集顯示
> Oracle（rust-oracle / ODPI-C）：CRUD、結構分頁（索引 / 外鍵 / DDL via DBMS_METADATA）、routines、執行計畫（EXPLAIN PLAN + DBMS_XPLAN）、ER 圖、欄位統計；**需自行安裝 64 位元 Oracle Instant Client**（執行期偵測 PATH / ORACLE_HOME / 自訂目錄，未安裝時給下載指引；伺服器需 12c+）
> MongoDB 文件攤平 + 查詢編輯器完整 **CRUD-via-JSON**（find / 聚合 aggregate / insert / update / delete）+ **explain 執行計畫**（stage 樹、COLLSCAN 警示、掃描比）+ 進階索引（TTL / partial / text / 2dsphere / hidden + $indexStats 使用率）+ **驗證規則**（$jsonSchema via collMod）+ 欄位統計（BSON 型別分布 / Top-10 / 抽樣）+ **監控面板**（serverStatus / dbStats / currentOp+kill / Profiler 慢查詢）
> Redis 仿 **Another Redis Desktop Manager**：五種結構檢視＋編輯、**命名空間鍵樹**（依 `:` 分組資料夾）、值格式化（原始 / JSON / Hex）、**Pub/Sub** 訂閱發佈、**維運面板**（慢查詢 / 用戶端 / 大鍵）、**伺服器狀態面板**（INFO 重點指標 + 全分區，可自動刷新）、**命令列 Console**（指令歷史、DB 切換）
> Kafka（rdkafka / librdkafka）參考 **Conduktor Console**：訊息瀏覽 + live tail、**JS 篩選運算式**（內嵌 boa 引擎，可用 key / value / json / headers…）、反序列化選擇 + 「搜尋更多」掃描 + JSON 欄位投影、匯出 CSV / JSON / xlsx、發佈（headers / **Avro 序列化** / **流量模式 + 隨機模板** / **CSV 批次**）；**叢集總覽**（brokers / URP / 離線分區健康）、主題設定編輯 / 加分割區 / 清空（DeleteRecords）、位移重設全功能（指定 / 時間戳 / 平移 + **套用前預覽**）、消費者群組 Lag；**監控與告警**（背景取樣 + 手刻 SVG 時間序列圖 + 規則 → OS 通知 / 告警歷史 / 健康風險掃描）；**Schema Registry**（subject / 版本 / diff / 註冊 / 相容性 / 刪除）、**Protobuf 解碼**（protox + prost-reflect）、**Kafka Connect**（連接器管理 + 設定驗證）、**ACL**（依主體分組管理）
> 連線設定持久化（密碼存 OS keychain）、SSH Tunnel、排程備份 + 備份歷史、Ping 連線延遲、ER 圖、欄寬可拖曳、AI 助手
> 查詢工作區：多語句 → **多結果集堆疊顯示**（SSMS 風格）、失敗語句定位、查詢歷史 200 筆、收藏查詢分組管理、`@` 使用者變數與表 / 欄自動完成
> 外觀：**7 套寶石系主題整體驅動 App + 編輯器**（工具列切換，設定頁亦可）；**進階物件搜尋**（跨庫 / 定義內文 / 整字 / 萬用字元）

完整規劃文件見 [`docs/`](./docs/)：[規劃](./docs/planning.md) · [架構](./docs/architecture.md) · [連線生命週期](./docs/connection-lifecycle.md) · [資料表操作習慣](./docs/navicat-ux.md) · [路線圖](./docs/roadmap.md)。變更紀錄見 [CHANGELOG](./CHANGELOG.md)。

## 功能藍圖

核心功能皆已完成（50+ 項），點開檢視完整清單：

<details>
<summary><strong>展開完整功能清單</strong></summary>

- [x] P0 骨架：佈局、大圖示工具列、連線池與釋放層、MySQL 連線
- [x] P1/P2 雙擊開表 → 表格檢視 + 底部分頁導覽 + 結構/資料分頁切換
- [x] SQLite 支援（檔案型，與 MySQL 共用 trait）
- [x] PostgreSQL 支援
- [x] Microsoft SQL Server 支援（tiberius + bb8 連線池；結構分頁 / routines / 執行計畫 SHOWPLAN XML / ER 圖 / 欄位統計；備份規劃以 sqlpackage 匯出 `.bacpac`，尚未接上）
- [x] MariaDB 支援（與 MySQL 共用 sqlx 驅動；獨立連線類型 + MariaSQL 編輯器方言 + RETURNING 結果集）
- [x] Oracle 支援（rust-oracle / ODPI-C；Instant Client 執行期偵測、EZConnect / SID / TNS 三種連線方式、結構分頁 / routines / DBMS_XPLAN 執行計畫 / ER 圖；伺服器需 12c+）
- [x] MongoDB 強化：explain 視覺化、JSON 查詢編輯器（補全）、進階索引 + $indexStats、驗證規則、欄位統計、監控面板（currentOp / Profiler）
- [x] Kafka 支援（一等公民；rdkafka / librdkafka）：叢集→主題樹、訊息瀏覽器 + JSON/Avro 明細、**即時 tail**、發佈訊息、**消費者群組 + Lag**、位移重設、建/刪主題 + 設定、**Schema Registry**（Avro→JSON）；`kafka` feature 隨 gui 預設開，TLS/SCRAM 走 `kafka-tls`（需 OpenSSL）
- [x] MySQL / PostgreSQL SSL 模式（sqlx rustls；typed 連線參數，密碼特殊字元不再需編碼）
- [x] 雲端連線強化：**從連線字串匯入**（貼 `mysql://` / `postgres://` / `mongodb+srv://` / `rediss://` / `sqlserver://` 及 Azure ADO.NET 一鍵填表；GUI 與 `dbk --url` 共用同一套解析）、自訂 CA 憑證（MySQL / PostgreSQL / SQL Server / MongoDB，適配 AWS RDS / DocumentDB / Aiven / Supabase / Upstash 等）
- [x] 新增連線對話框改版：連線類型依**分類分組**（關聯式 / 文件 / 鍵值 / 訊息佇列 / 搜尋引擎）＋圖示選擇器，選定後收合為單列、可隨時「變更類型」
- [x] Elasticsearch / OpenSearch 支援（一等公民；純 reqwest REST，無額外 C 相依，`elastic` feature 隨 gui 預設開）：叢集→索引樹、**Query DSL 查詢編輯器**（JSON envelope `{ "index":"..", "query":{..} }` + lint + 欄位補全）、search / count / 單層聚合（雙結果集）、**叢集總覽**（健康 / 節點 / 索引狀態）、Mapping 檢視、刪除索引；認證支援 Basic / API Key / Elastic Cloud ID，TLS + 自訂 CA；flavor（ES vs OpenSearch）連線時自動偵測
- [x] **自然語言查詢**（NL→SQL / NL→ES DSL）：查詢面板「AI 生成」列（Ctrl+Shift+A），用自然語言描述需求 → 本機 Claude Code / Codex CLI（沿用 AI 助手管線，訂閱登入、不需 API key）注入 schema / mapping 後生成查詢語句。生成語句**先顯示於預覽**（可檢視 / 複製 / 重新生成）再由使用者「套用到編輯器」執行，非黑箱；破壞性語句（DROP/TRUNCATE 等）套用前警示；執行失敗可「帶錯誤重試」。單回合零工具（tool 自動拒絕，無副作用）
- [x] RabbitMQ 支援（一等公民；lapin AMQP 0-9-1 + Management REST 雙軌，`rabbitmq` feature 隨 gui 預設開，rustls-ring 純 Rust 無 NASM）：連線→vhost→佇列樹、**佇列訊息瀏覽**（basic.get 非破壞性預覽 + requeue，含 redelivered / quorum 警告；stream 佇列擋）、**發布訊息**（publisher confirm）、佇列詳情、清空 / 刪除佇列（危險確認）、叢集總覽（版本 / 節點 / 佇列 / 訊息數 / 速率）；amqp(s):// 貼上即用（CloudAMQP）；vhost / TLS / Management URL 可設
- [x] 儲存格直接編輯 + ✓ 套用（以主鍵定位，寫回 DB）
- [x] 新增列 / 刪除列（完整 CRUD）
- [x] 篩選（單欄條件）、排序（點欄位標題）
- [x] MongoDB（文件攤平成表格，沿用表格手感）
- [x] Redis（key 列表化 + 五種結構檢視）
- [x] Redis 強化（仿 Another Redis）：命名空間鍵樹（`:` 分組）、鍵列 / DB / 連線右鍵選單、伺服器狀態（INFO）面板、命令列 Console
- [x] Kafka 支援（rdkafka / librdkafka，一等公民資料來源）：訊息瀏覽 + live tail、消費者群組 Lag、發佈、Schema Registry 檢視
- [x] Kafka 強化（參考 Conduktor Console）：JS 篩選 + 反序列化 + 搜尋更多 + 投影、Avro / 流量 / CSV 發佈、叢集總覽 + 設定編輯 + 清空 + 位移重設預覽、監控與告警（圖表 + OS 通知）、SR 寫入 + Protobuf 解碼 + Kafka Connect + ACL
- [x] **Redis / Kafka 右鍵補齊新增 · 修改 · 刪除**：Redis 命名空間右鍵批次刪除 / 在此新增鍵 / 只顯示此命名空間、鍵右鍵複製鍵值 + TTL、大鍵面板勾選批次清除、維運與 Pub/Sub 從側欄直達；Kafka 主題右鍵發佈訊息 / CSV 批次 / 建主題、刪除主題雙重確認、消費者群組清單篩選 + 右鍵刪除
- [x] **`dbk` CLI 寫入**：`exec`、`db create/drop`、`table drop/truncate`、`redis set/del/del-prefix/expire/persist/rename/flush-db`；寫入需 `--yes`、高破壞需 `--force`，未帶旗標只印出將執行的動作（內建預演）
- [x] **UI 冒煙檢查** `npm run verify:ui`：production build + Tauri invoke shim，斷言右鍵選單與分頁行為（免 Docker / 免真實資料庫）
- [x] 備份 / 還原（手動，CLI 為主 + SQLite 檔案複製）
- [x] 連線設定持久化 + 密碼 OS keychain 加密
- [x] SSH Tunnel（密碼 / 私鑰認證）
- [x] 排程備份 + 備份歷史管理（清單 / 立即執行 / 還原 / 保留份數）
- [x] Redis 結構編輯（List / Set / ZSet / Hash 元素增刪改）、多欄複合篩選、欄寬調整
- [x] 多欄篩選 AND / OR 條件切換
- [x] 資料匯出（CSV / TSV / JSON / SQL INSERT / Markdown，含標題 / 分隔字元 / NULL / BOM / 範圍選項）
- [x] 資料匯入（CSV / TSV → 資料表，RFC4180 解析、空欄→NULL、逐列回報成功 / 失敗）
- [x] 轉儲整庫結構 SQL（側欄資料庫右鍵「匯出結構 SQL」，串接所有表建表語句）
- [x] 欄位資料剖析（欄位標題右鍵「欄位統計」：總列數 / 非空 / 相異值）
- [x] 操作體驗：原生檔案選擇器、編輯連線、Toast 通知、連線樹右鍵選單
- [x] SSH host key 驗證（TOFU：首次記憶指紋、之後比對）
- [x] 查詢效能分析（EXPLAIN）
- [x] 結構編輯（DDL：新增 / 刪除 / 改名欄位）
- [x] ER 圖（表 + 外鍵關係，表卡可拖曳、縮放、佈局記憶、關聯高亮）
- [x] 資料格手感：儲存格右鍵選單（複製值 / 整列 JSON·TSV / INSERT、設 NULL、依值篩選）、內容檢視器、鍵盤導覽、選取資訊
- [x] 多欄排序（Shift+點擊）、每頁列數、欄位隱藏 / 自動符合寬度、重新整理
- [x] 查詢編輯器：執行時間 / 列數、查詢歷史、只執行反白段、Ctrl+Enter、per-連線記憶、結果複製 / 匯出（CSV·JSON·TSV）
- [x] 結構：複製建表 SQL（SHOW CREATE TABLE 等）、索引檢視 + 新增 / 刪除（MySQL / PostgreSQL / SQL Server / SQLite / MongoDB）
- [x] MongoDB 查詢增強：sort / projection / limit + **聚合管線**（aggregate：`$match` / `$group` / `$sum`…）
- [x] 側欄：搜尋過濾、表右鍵產生查詢（SQL SELECT/COUNT/INSERT、Mongo find 範本）、複製連線
- [x] 分頁管理（中鍵 / 關閉其他 / 全部 / Ctrl+W）、連線池即時監控 + **Ping**（量測既有連線往返延遲，含 SSH 通道）、全域 UI/UX 打磨
- [x] Redis 進階：值格式化（原始 / JSON / Hex）+ 大集合游標式分頁、**Pub/Sub** 訂閱發佈、**維運面板**（慢查詢 / 用戶端 / 大鍵）
- [x] AI 助手（右側面板，串接本機 Claude Code / OpenAI Codex CLI）：串流問答、撰寫 / 優化 SQL，可附帶目前連線 schema 作上下文
- [x] **AI 唯讀資料庫工具**：助手自己 list / describe / 取樣 / SELECT / EXPLAIN（一次一句，200 列 / 8 KB / 30 秒上限；寫入是機制上做不到，連 `EXPLAIN ANALYZE DELETE` 都擋）；每次呼叫的 SQL 與結果都列在回應裡可稽核、可貼回編輯器；正式環境連線首次使用前確認。API 供應商內建，CLI 供應商透過內建 `dbk mcp`（MCP stdio 伺服器）取得同一組工具
- [x] **編輯器 AI 動作 + 差異預覽**：選取段 / 游標所在語句 → 右鍵 · `Ctrl+Shift+E` · 工具列，解釋 / 最佳化 / 修正 / 加註解 / 轉方言 / 產生測試資料 / 白話解釋執行計畫；`Ctrl+I` 用一句話下指示。改寫類先逐塊比對（可拒絕、可手改），接受後進 undo 歷史
- [x] **對話面板增強**：`@` 指定附帶範圍（表 / 庫 / 檔案 / `@query` / `@result` / `@error`，含預算與「沒帶成」的交代）、`/` 斜線命令、SQL 區塊「執行」/「執行並回饋」（守門同查詢分頁）、HTTP 供應商對話歷史落地（重開不失憶）、`Ctrl+L` 開關並聚焦
- [x] 跨資料庫一致：上述能力於 MySQL / PostgreSQL / SQL Server / SQLite / MongoDB 對齊（識別字 / 篩選 / 索引依各庫對應）
- [x] **視覺化查詢建構器**：勾選表 / 欄、外鍵自動 JOIN、WHERE / 聚合 / HAVING / ORDER BY / DISTINCT / LIMIT / OFFSET、即時預覽 + 計數，帶入編輯器；可從資料表右鍵開啟
- [x] **Excel（.xlsx）匯出 / 匯入**：純 Rust（rust_xlsxwriter / calamine），數字保真、凍結表頭 + 自動欄寬
- [x] **查詢結果匯出**走後端統一管線（CSV / TSV / Excel / JSON / SQL / Markdown）
- [x] **SQL 片段庫**（編輯器自動完成 + 工具列管理）、**參數化查詢 `:name`**、SQL **格式化 / 壓縮 / 關鍵字大小寫**
- [x] **資料傳輸**（跨連線 / 跨庫；單表 / 整庫；目標不存在時自動建表）
- [x] **資料列比對 / 同步**（以主鍵串流比對兩表或整庫，無列數上限；產生 INSERT / UPDATE / DELETE，可直接分批交易套用）——CLI 專屬：`dbk compare data`
- [x] **整庫資料庫文件**（HTML / Markdown 報表，含目錄）
- [x] **外鍵雙向導覽**（跳至參照的列 / 找參照此列的列）、**Copy as IN**、**相異值分布**
- [x] **命令面板**（Ctrl/Cmd+K）：模糊搜尋跳轉連線 / 資料庫 / 資料表 / 動作
- [x] **連線唯讀模式**（擋寫入 / DDL 與資料格 / 側欄寫入）、**連線色標**（區分環境）、**釘選常用表**
- [x] **審查並執行**（AI 審查 + 逐句前後像 + 回滾腳本 + 差異報告寫入指定目錄；依型別無損取值；DDL 回滾沿用結構比對產生器；交易控制 / session 狀態語句整份擋下；AI 助手寫入語句同走此流程；`dbk run`）
- [x] **結構比對**（單表或整庫；跨連線 / 跨庫 / 對快照檔：表 / 欄位 / 索引 / 外鍵 / 視圖 / 程序差異，雙向同步 DDL 含破壞性分級與「略過」清單；結構快照存檔；**AI 總結**；Markdown / HTML / JSON 報告；`dbk compare schema`）
  - MySQL / MariaDB / PostgreSQL / SQLite / **SQL Server** / Oracle；SQL Server 的視圖與程序自動包成目標庫的 `sp_executesql`（T-SQL 不收三部式名稱），被索引擋住的 `ALTER COLUMN` 自動卸索引再重建
  - 端對端驗證跑在真實伺服器上：MySQL 8.4、PostgreSQL 16、**兩台獨立的 SQL Server 2022**（跨連線），判準是「同步後再比一次必須零差異」
- [x] **啟動鎖定**（App 開啟閘門；不影響 keychain 與 `dbk` CLI）
  - 生物辨識：Windows Hello（指紋 / 臉 / PIN）、macOS Touch ID；Linux 不支援，退回密碼
  - 啟動密碼：Argon2id 雜湊。與生物辨識互相獨立，可單開或併用
  - 閒置自動鎖定：5 / 15 / 30 分鐘或 1 小時，重新鎖定時不會丟失開著的查詢與編輯內容
- [x] **查詢安全網**：結果列數上限（預設 1,000）+ 查詢逾時（DB 端 + tokio 兜底），大表操作效能優化（列級 memo / COUNT 並行 / 切庫連線快取）
- [x] **啟動速度**：骨架屏消除白屏、對話框與 CodeMirror code splitting（首包 1,139 KB → ~470 KB）、資產與字型子集瘦身
- [x] **多結果集**（SSMS 風格堆疊）：每格獨立捲動 / 排序 / 篩選 / 摺疊，作用中結果集決定複製 / 匯出 / 問 AI 的對象；「全部匯出」一次匯出所有結果集
- [x] **編輯器主題**：7 套寶石系配色（`src/editorThemes.ts`），0.8.0 起升級為驅動整個 App 的統一主題系統，工具列可切光亮 / 暗黑 / 變體
- [x] **收藏查詢**完善：分組、編輯 / 重新命名、匯出匯入（含 SQL 片段），管理入口在頂部工具列
- [x] **SQL 編輯器補全**：表 / 欄自動完成（**整庫一次批次載入、無張數上限**）、**結構快取**（落地磁碟，開檔即用 / 離線可用，工具列徽章顯示更新時間並可一鍵重抓）、`@` 使用者變數提示
- [x] **進階物件搜尋**（`Ctrl+Shift+G`）：表格化結果（可排序）、名稱 / 定義 / 註解三種命中、整字比對 + 萬用字元、定義預覽高亮、在物件總管中選取
- [x] 側欄搜尋 / 篩選命中時自動展開資料夾；資料表格表頭 hover 顯示欄位 comment
- [x] 「關於 DB Kit」對話框 + 啟動時檢查 GitHub 新版（可於設定關閉）
- [x] **多語系（i18n）**：繁體中文 / 简体中文 / English / 日本語 / 한국어 / Tiếng Việt，即時切換不需重啟；前端、Rust 後端與 `dbk` CLI（`--lang`、`DBKIT_LANG`）全部在地化。日 / 韓 / 越譯文缺漏時退回英文而非中文，簡中對照表由 `scripts/i18n-gen-zhcn.mjs` 產生（OpenCC + 資料庫用語詞表）

</details>

## 技術棧

| 層 | 技術 |
|----|------|
| 應用框架 | Tauri 2 |
| 前端 | React 18 + TypeScript + Vite |
| UI | Tailwind CSS（shadcn/ui 風格）；12 個語意 CSS 變數（`--c-*`）承載主題，7 套配色以 `buildAppVars` 推導表面景深 |
| 編輯器 | CodeMirror 6（SQL / JSON 語法高亮、lint、自動完成） |
| 狀態 | Zustand |
| 後端 | Rust：sqlx (MySQL / MariaDB / PostgreSQL / SQLite)、tiberius + bb8 (SQL Server)、rust-oracle / ODPI-C (Oracle，需 Instant Client)、mongodb、redis |
| 安全 | OS keychain（keyring）、SSH Tunnel（russh）+ host key TOFU |
| AI 助手 | 本機 Claude Code / OpenAI Codex CLI（訂閱登入，串流），或 Anthropic / OpenAI 相容 API（金鑰存 OS keychain）；唯讀資料庫工具（CLI 供應商經 `dbk mcp`）、`@codemirror/merge` 差異預覽 |

## 連線生命週期設計

連線釋放是此類工具最易出錯處，本專案在 P0 即建立：

- **連線池**：sqlx 內建 pool，設定 `max_connections` / `idle_timeout` / `max_lifetime`
- **健康檢查**：取得連線前以 `SELECT 1` 驗證殭屍連線
- **優雅關閉**：應用結束時 drain 所有連線池（RAII / Drop 保底）
- **連線數監控**：每連線回報 in-use / idle 狀態

## 從原始碼建置

想自行修改、貢獻，或在 macOS / Linux 上使用，可從原始碼建置。

**環境需求**

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- Tauri 系統依賴：見 <https://tauri.app/start/prerequisites/>

**開發與打包**

```bash
# 安裝前端依賴
npm install

# 開發模式（同時起前端與 Tauri，支援熱重載）
npm run tauri dev

# 打包成目前平台的安裝檔
npm run tauri build
```

打包產物位於 `src-tauri/target/release/bundle/`（依平台為 `.msi` / `.exe` / `.dmg` / `.AppImage` / `.deb`）。

## 命令列工具（`dbk` CLI）

> 📖 **完整操作指南：[docs/cli.md](./docs/cli.md)** —— 每個子指令的旗標、輸出格式、常見情境（排程備份 / 效能基準線 / 稽核）、結束碼與限制。以下為速覽。

除了桌面 GUI，db-kit 另附一支 **`dbk` 命令列工具**——**查詢 / 匯出 / 寫入（修改 · 刪除）**，適合 SSH 進伺服器、寫 script、排程任務時用，不必開 GUI。它直接重用核心層（連線管理 / 匯出 / 備份 / 加密），**不經過 Tauri**，所以能 `--no-default-features` 編出一支**不連 Tauri 的精簡 binary**。

```bash
# 編譯精簡 CLI（不含 GUI / Tauri）
cargo build --release --no-default-features --bin dbk
# 產物：target/release/dbk(.exe)
```

**連線兩種來源**：沿用 GUI 已存的連線（`--conn <名稱或 id>`，讀同一份 connections.json + OS keychain），或用旗標臨時連線（`--kind mysql --host … --user …`，密碼可走環境變數 `DBKIT_PASSWORD` 避免出現在 argv；`--kind` 支援 `mysql / mariadb / postgres / sqlite / mongo / redis / mssql / oracle`，也可用 `--url` 一段式連線字串如 `oracle://user:pass@host:1521/SERVICE`）。輸出格式 `--format table|csv|json`。

```bash
# 用 GUI 已存的連線，跑一段唯讀查詢，輸出 CSV
dbk --conn prod-mysql --format csv query "select id,name from users limit 20"

# 臨時連線（密碼走環境變數），列出資料表
DBKIT_PASSWORD=*** dbk --kind mysql --host 10.0.0.5 --user app db list
dbk --conn prod-mysql table data orders --page 0 --page-size 50 --filter "status:=:paid" --sort "created_at:desc"

# 匯出整表 / 轉儲整庫結構 / 備份（--data-format 支援 csv | tsv | xlsx | json | sql | markdown）
dbk --conn prod-mysql export orders --to orders.csv --data-format csv --bom
dbk --conn prod-mysql export orders --to orders.xlsx --data-format xlsx
dbk --conn prod-mysql schema-dump > schema.sql
dbk --conn prod-mysql backup mydb --to mydb.dump

# 壓力測試：8 執行緒跑滿 30 秒（前 5 秒逐步進場），報表導成 JSON
dbk --conn prod-mysql stress "select * from orders where status='paid' limit 100" \
    --threads 8 --seconds 30 --ramp 5 --warmup 20
dbk --conn prod-mysql --format json stress "select 1" --threads 16 --seconds 60 > bench.json
```

**唯讀守門**：`query` / `explain` 只放行查詢類語句（`select` / `with` / `show` / `describe` / `explain` / `pragma` / `use` / `values` / `table`），偵測到寫入語句（`insert` / `update` / `delete` / `drop`…）直接擋下並回非零 exit code（逐 `;` 切句、跳過註解）。要寫入請改用下方的 `exec`；另建議搭配唯讀 DB 帳號作第二道防線。

**結果列數上限**：`query` 預設沿用全域設定（1,000 列），可用 `--max-rows N` 覆寫（`--max-rows 0` 取完整結果；截斷時 stderr 會提示）。

### 寫入（修改 / 刪除）

寫入一律要 **`--yes`**；**高破壞動作**（`DROP` / `TRUNCATE` / `FLUSHDB` / 沒有 `WHERE` 的 `UPDATE`·`DELETE`）再要 **`--force`**。沒帶旗標時**不會執行**，只印出「將要做什麼」並回非零 exit code——等於內建預演（dry run），貼進 script 前可先跑一次確認打到的是哪一台、哪一張表。

```bash
# 一般寫入：--yes
dbk --conn prod-mysql exec "update users set status='active' where id=42" --yes

# 高破壞：--yes --force（少一個就擋下）
dbk --conn prod-mysql exec "delete from sessions" --yes --force
dbk --conn prod-mysql table truncate audit_log --yes --force
dbk --conn prod-mysql table drop tmp_import --yes --force
dbk --conn prod-mysql db create staging --yes

# Redis：設值 / TTL / 改名 / 刪鍵 / 依前綴批次刪
dbk --conn cache redis set session:42 '{"uid":42}' --ttl 3600 --yes
dbk --conn cache redis expire session:42 600 --yes
dbk --conn cache redis persist session:42 --yes
dbk --conn cache redis rename session:42 session:42:old --yes
dbk --conn cache redis del session:42:old --yes
dbk --conn cache redis del-prefix session: --yes --force   # 先 SCAN 出鍵名再 DEL
```

> `del-prefix` 不會把前綴丟給 Redis 當 pattern：先 `SCAN MATCH <prefix>*` 取出實際鍵名（上限 `--limit`，預設 10,000）再分批 `DEL`，確認訊息會先告訴你會刪掉幾個鍵。

其餘子指令：`conn`（list / test / ping / 加密 export）、`db`（list / create / drop）、`table`（list / columns / data / info / ddl / indexes / foreign-keys / drop / truncate）、`routine`、`search`（`--whole-word` 整字比對、`--wildcards` 啟用 `*` `?`）、`column-stats`、`er-model`、`server-info`、`exec`、`run`（審查並執行腳本）、`stress`、`redis`（keys / key / slowlog / clients / big-keys / set / del / del-prefix / expire / persist / rename / flush-db）。逐項說明與實例見 **[docs/cli.md](./docs/cli.md)**，或 `dbk --help` / `dbk <子指令> --help`。

> **審查並執行腳本**：`dbk run migrate.sql --out <目錄>` 逐句備份前後像並產生回滾腳本（沒帶 `--yes` 只產生審查與備份，`--review-cmd "claude -p"` 接外部 AI 審查），見 [docs/cli.md](./docs/cli.md#run--審查並執行-sql-腳本) 與 [審查並執行使用指南](./docs/review-run.md)。

> `stress` 一律唯讀（不提供 `--allow-writes`）。它會另開一條 `max_connections = --threads` 的專屬連線，跑完釋放——所以 `--threads 64` 就是對目標打 64 條連線，先確認伺服器撐得住。

> Kafka / Elasticsearch / RabbitMQ 連線 CLI 不支援（沒有可在終端機表達的通用查詢語言，且精簡 binary 未編入其驅動），指定時會直接回明確錯誤，請改用 GUI。

> 架構上 `tauri` / `tauri-plugin-dialog` 已改為 optional，藏在預設的 `gui` feature 後；GUI binary（`db-kit`）需要 `gui` feature，CLI binary（`dbk`）不需要。

## 打包 Windows 安裝檔

在 **Windows** 上執行隨附的 PowerShell 腳本，它會自動檢查並安裝 Rust 與 Node.js，然後產出 `.msi` 與 `.exe` 安裝檔：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
```

完成後安裝檔位於 `src-tauri\target\release\bundle\`（`msi\` 與 `nsis\` 子目錄）。

> 注意：Tauri 需要 WebView2 Runtime（Windows 11 內建，Windows 10 多數已有）。

**自動發佈（GitHub Actions）**：推送 `v` 開頭的版本標籤即會在雲端**同時打包 Windows / macOS（Intel + Apple Silicon）/ Linux** 安裝檔並建立對應的 [Release](https://github.com/markku636/db-kit/releases)（見 [`.github/workflows/release.yml`](./.github/workflows/release.yml)）：

```bash
git tag v0.1.6 && git push origin v0.1.6
```

## 贊助開源

這個工具免費且開源。如果它幫你省下了時間，可以請我喝杯咖啡，讓後續的更新繼續做下去。

[![PayPal $5](https://img.shields.io/badge/PayPal-%245-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/8B7GRXA6UJH36)
[![PayPal $10](https://img.shields.io/badge/PayPal-%2410-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/8LBTFUBBF2CHS)
[![PayPal $15](https://img.shields.io/badge/PayPal-%2415-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/A653DD46GEU4W)
[![PayPal $25](https://img.shields.io/badge/PayPal-%2425-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/Y5WPSXVGH3YS4)

其他金額請走 [PayPal.Me](https://paypal.me/226network)。應用程式內的「關於」對話框也有同一組贊助按鈕。

## 作者

由 [Mark.K](https://github.com/markku636) 開發。開發筆記與技術文章寫在 **[blog.markkulab.net](https://blog.markkulab.net/)** —— app 內「關於 DB Kit」也有這個連結。

## 授權

[MIT](./LICENSE)
