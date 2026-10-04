<p align="center">
  <img src="docs/hero.png" alt="db-kit — MAGIDB CONNECT：一站式跨平台資料庫管理工具" width="860">
</p>

<h1 align="center">db-kit</h1>

<p align="center"><strong>MAGIDB CONNECT — Making Data Connections Magical</strong></p>

<p align="center">
一套介面管理 <strong>MySQL · MariaDB · PostgreSQL · SQL Server · Oracle · SQLite · MongoDB · Redis · Kafka · Elasticsearch · RabbitMQ</strong>，<br>
並把 <strong>SSH / SFTP / FTP · Docker · Kubernetes · 遠端桌面 · 檔案比對</strong> 收進同一個視窗。
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white">
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-22c55e">
</p>

<p align="center">
  <strong>💚 100% 開源免費</strong>　·　MIT 授權　·　無付費牆　·　無遙測
</p>

<p align="center">
  <strong>繁體中文</strong> · <a href="./README.en.md">English</a>
</p>

---

## 這是什麼

**db-kit** 是 Windows / macOS / Linux 的桌面資料庫工具。關聯式、文件型、鍵值型、訊息佇列、搜尋引擎共用同一套連線樹、資料格、查詢編輯器與快捷鍵；查問題時常要跟著開的 SSH、容器、遠端桌面也在同一個側欄。

- **輕量**：Tauri 2（Rust 後端 + 系統 WebView），記憶體約為 Electron 同類工具的十分之一。
- **安全**：密碼與 API 金鑰只存 OS keychain；寫入全參數化、以主鍵定位；可設唯讀連線與環境色標。
- **AI 選配**：接本機 Claude Code / Codex CLI 或任何 Anthropic / OpenAI 相容 API；助手查資料庫一律唯讀，寫入先走「審查並執行」。也能反過來當 **MCP 伺服器**，讓 Claude Code / Codex / Cursor / VS Code 直接查你的資料庫。
- **附 CLI**：`dbk` 重用同一套連線，可在伺服器上查詢、匯出、備份、比對。

## 畫面預覽

<p align="center">
  <img src="docs/screenshots/21-new-connection.png" alt="新增連線：資料庫、訊息佇列、搜尋引擎、容器、遠端主機在同一個選擇器" width="860">
</p>

| 資料表檢視 | 查詢編輯器（多結果集） |
|:---:|:---:|
| ![資料表檢視](docs/screenshots/01-data-grid.png) | ![查詢編輯器](docs/screenshots/02-query-editor.png) |
| **ER 圖** | **Redis** |
| ![ER 圖](docs/screenshots/03-er-diagram.png) | ![Redis 檢視](docs/screenshots/04-redis.png) |
| **結構比對與同步腳本** | **審查並執行（逐句回滾）** |
| ![結構比對](docs/screenshots/10-schema-compare.png) | ![審查並執行](docs/screenshots/12-review-run.png) |
| **SSH 終端機 + SFTP** | **遠端桌面** |
| ![SSH 終端機](docs/screenshots/15-ssh-terminal.png) | ![遠端桌面](docs/screenshots/18-remote-desktop.png) |
| **Docker** | **Kubernetes** |
| ![Docker](docs/screenshots/16-docker.png) | ![Kubernetes](docs/screenshots/17-kubernetes.png) |

> 更多畫面（Kafka、SQL 壓力測試、SQL 審查、資料夾比對…）在 [`docs/screenshots/`](./docs/screenshots/)。畫面中的資料皆為虛構示範資料。

## 功能一覽

| 範疇 | 內容 |
|------|------|
| 資料庫 | MySQL / MariaDB / PostgreSQL / SQL Server / Oracle / SQLite / MongoDB / Redis：可編輯資料格（大結果集虛擬捲動；儲存格 JSON 樹 / 十六進位 / 圖片檢視）、多欄篩選排序、DDL 與索引、EXPLAIN 視覺化（含 SQLite / SQL Server）、ER 圖（匯出 SVG / PNG）、預存程序、匯入匯出（CSV / Excel / JSON）、執行 SQL 檔、處理程序清單、備份與排程 |
| 訊息與搜尋 | Kafka（訊息瀏覽與即時 tail、消費者群組、Schema Registry、Connect、ACL、監控告警）、RabbitMQ、Elasticsearch / OpenSearch |
| 查詢工作區 | 自動完成（含跨庫、JOIN 外鍵條件）、找不到的表 / 欄位即時標示、多結果集堆疊、可取消執行中的查詢、視覺化查詢建構器、片段庫、參數（`:name`、`${name}`、`#{name}`、`?`）、查詢歷史與收藏、進階物件搜尋（`Ctrl+Shift+G`）、命令面板（`Ctrl+K`） |
| 結構與資料 | 結構比對與同步（跨庫 / 跨連線 / 對快照、欄位改名偵測、交給審查並執行產生回滾腳本）、資料傳輸、資料列比對、整庫文件 |
| 安全網 | **審查並執行**（AI 審查 → 逐句前像 → 回滾腳本 → 執行 → 差異報告）、寫入前預覽影響列、唯讀連線暫時解鎖、正式環境寫入確認、SQL 靜態審查、DBA 人設審查、結果列數上限與查詢逾時、啟動鎖定 |
| 測試與效能 | SQL 壓力測試（TPS、p50–p99）、預存程序整合測試（自動 rollback、基線回歸、跨引擎比對、JUnit） |
| AI 工具整合 | **MCP 伺服器**（`dbk mcp`）：Claude Code / Codex / Cursor / VS Code / Claude Desktop / Windsurf 一鍵寫入設定；單一或多連線、預設唯讀，可開放經預覽與核准的寫入（自動回滾腳本）；stdio 或本機 HTTP |
| AI | 對話助手（`@` 指定範圍、`/` 指令）、編輯器 AI 動作（解釋 / 最佳化 / 修正 / 轉方言，先看差異再套用）、AI 資源庫（人設 / 技能 / 提示都是 Markdown 檔） |
| 遠端與容器 | SSH 終端機 + SFTP / FTP（斷點續傳、跳板機、操作紀錄）、資料庫連線經 SSH 跳板或 SOCKS5 / HTTP Proxy、Docker / Registry / Harbor、Kubernetes（port-forward 連叢集內資料庫）、遠端桌面 RDP / VNC / RustDesk |
| 檔案比對 | 文字 / 資料夾 / 二進位比對與同步，兩邊可以是本機或 SSH / FTP 主機 |
| 介面 | 7 套主題、介面與程式碼字級分開調、六種語言（繁中 / 简中 / English / 日本語 / 한국어 / Tiếng Việt）、App 內更新 |

完整變更見 [CHANGELOG](./CHANGELOG.md)。

## 下載安裝

<p align="center">
  <a href="https://github.com/markku636/db-kit/releases/latest">
    <img alt="下載最新版" src="https://img.shields.io/github/v/release/markku636/db-kit?label=%E4%B8%8B%E8%BC%89%E6%9C%80%E6%96%B0%E7%89%88&style=for-the-badge&color=22c55e">
  </a>
</p>

| 平台 | 安裝檔 |
|------|--------|
| Windows 10 / 11 | `db-kit_x.y.z_x64-setup.exe` 或 `.msi` |
| macOS Apple Silicon / Intel | `db-kit_x.y.z_aarch64.dmg` / `db-kit_x.y.z_x64.dmg` |
| Linux | `.deb`、`.rpm` 或免安裝的 `.AppImage` |

安裝檔沒有付費簽章，第一次開啟會被系統擋下：

- **Windows**：SmartScreen 點「更多資訊」→「仍要執行」。需要 WebView2 Runtime（Windows 11 內建）。
- **macOS**：拖進「應用程式」後執行下面這行，之後就能直接開啟（更新到新版若又被擋，再執行一次）：
  ```bash
  xattr -dr com.apple.quarantine "/Applications/DB Kit.app"
  ```
  不想用終端機：先開一次 App 被擋 → 系統設定 → 隱私權與安全性 → 「強制打開」。
- **Linux**：`sudo dpkg -i db-kit_*.deb`、`sudo rpm -i db-kit-*.rpm`，或 `chmod +x *.AppImage` 後直接執行。

> **Oracle** 需另裝 64 位元 [Oracle Instant Client](https://www.oracle.com/database/technologies/instant-client/downloads.html) 並加入 PATH（伺服器 12c 以上）；其他資料庫不需要。

## 快速上手

1. 工具列點 **「連線」**，選類型；手上有連線字串（`postgres://`、`mongodb+srv://`、`ssh://`、JDBC、ADO.NET…）就直接貼上，欄位會自動填好。
2. 填主機、帳密，需要時設 SSH Tunnel，按 **「測試連線」** 後儲存。
3. 左側樹狀清單展開資料庫，雙擊資料表開始瀏覽 / 編輯。

| 常用操作 | 快捷鍵 |
|----------|--------|
| 執行游標所在語句 / 整段 | `Ctrl+Enter` / `F6` |
| 命令面板 / 進階物件搜尋 | `Ctrl+K` / `Ctrl+Shift+G` |
| 開關 AI 助手 / 編輯器 AI 動作 | `Ctrl+L` / `Ctrl+Shift+E` |

沒有資料庫可以試？用 Docker 起一個：

```bash
docker run --name mysql-test -e MYSQL_ROOT_PASSWORD=test1234 -p 3306:3306 -d mysql:8
```

## 使用指南

- [結構比對](./docs/compare.md) · [審查並執行](./docs/review-run.md) · [DBA 審查](./docs/dba-review.md) · [AI 資源庫](./docs/ai-library.md) · [預存程序整合測試](./docs/sp-test.md) · [MCP 伺服器](./docs/mcp.md)
- [`dbk` CLI](./docs/cli.md) · [架構](./docs/architecture.md) · [連線生命週期](./docs/connection-lifecycle.md) · [路線圖](./docs/roadmap.md)

## 命令列工具 `dbk`

重用 GUI 已存的連線與 keychain，也能編成不含 GUI 的精簡 binary 放到伺服器上：

```bash
cargo build --release --no-default-features --bin dbk

dbk --conn prod-mysql --format csv query "select id, name from users limit 20"
dbk --conn prod-mysql export orders --to orders.xlsx --data-format xlsx
dbk --conn prod-mysql exec "update users set status='active' where id=42" --yes
```

`query` 只放行唯讀語句；寫入要 `--yes`，高破壞動作（DROP / TRUNCATE / 沒有 WHERE）再要 `--force`，沒帶旗標只會預演。完整子指令見 [docs/cli.md](./docs/cli.md)。

## 從原始碼建置

需要 [Rust](https://rustup.rs/)（stable）、[Node.js](https://nodejs.org/) 18+ 與 [Tauri 系統依賴](https://tauri.app/start/prerequisites/)。

```bash
npm install
npm run tauri dev     # 開發模式
npm run tauri build   # 打包目前平台的安裝檔 → src-tauri/target/release/bundle/
```

Windows 也可以跑 `powershell -ExecutionPolicy Bypass -File .\build-installer.ps1`，會自動補裝 Rust 與 Node.js。推送 `v*` 標籤會由 [GitHub Actions](./.github/workflows/release.yml) 打包三平台安裝檔並建立 Release。

## 贊助開源

如果 db-kit 幫你省下了時間，可以請我喝杯咖啡：

[![PayPal $5](https://img.shields.io/badge/PayPal-%245-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/8B7GRXA6UJH36)
[![PayPal $10](https://img.shields.io/badge/PayPal-%2410-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/8LBTFUBBF2CHS)
[![PayPal $15](https://img.shields.io/badge/PayPal-%2415-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/A653DD46GEU4W)
[![PayPal $25](https://img.shields.io/badge/PayPal-%2425-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/Y5WPSXVGH3YS4)

其他金額請走 [PayPal.Me](https://paypal.me/226network)。

## 作者與授權

由 [Mark.K](https://github.com/markku636) 開發，開發筆記在 [blog.markkulab.net](https://blog.markkulab.net/)。以 [MIT](./LICENSE) 授權釋出；RustDesk 連線元件 `rustdesk-bridge/` 為獨立的 AGPL 程式。
