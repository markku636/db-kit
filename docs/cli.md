# `dbk` CLI 完整操作指南

`dbk` 是 db-kit 的命令列工具。它**直接重用桌面版的核心層**（連線管理 / keychain / 匯出 / 備份 / 加密 / 壓測），不經過 Tauri，所以可以編成一支不含 GUI 的精簡 binary，SSH 進伺服器就能用。

適合的場景：排程任務、CI、資料稽核、故障排除、把查詢結果丟進 pipeline。不適合的場景：需要看 ER 圖、視覺化執行計畫、逐格編輯資料 —— 那些請開 GUI。

---

## 目錄

- [取得 dbk](#取得-dbk)
- [連線的三種指定方式](#連線的三種指定方式)
- [全域旗標](#全域旗標)
- [安全模型：唯讀預設、`--yes`、`--force`](#安全模型唯讀預設--yes--force)
- [輸出格式](#輸出格式)
- [指令參考](#指令參考)
  - [`conn` — 連線管理](#conn--連線管理)
  - [`db` — 資料庫 / schema](#db--資料庫--schema)
  - [`table` — 資料表](#table--資料表)
  - [`query` / `exec` / `explain`](#query--exec--explain)
  - [`stress` — 壓力測試](#stress--壓力測試)
  - [`export` / `schema-dump` / `backup`](#export--schema-dump--backup)
  - [`search` / `column-stats` / `routine` / `er-model` / `server-info`](#search--column-stats--routine--er-model--server-info)
  - [`redis` — Redis 操作](#redis--redis-操作)
- [常見情境](#常見情境)
- [結束碼與錯誤處理](#結束碼與錯誤處理)
- [限制](#限制)

---

## 取得 dbk

桌面版安裝檔**不含** `dbk`，需自行編譯：

```bash
# 精簡版（不含 GUI / Tauri，體積最小，伺服器適用）
cargo build --release --no-default-features --bin dbk
# 產物：src-tauri/target/release/dbk（Windows 為 dbk.exe）
```

想連 Elasticsearch / RabbitMQ / Kafka 的話它們是 GUI 專屬，CLI 不支援（見[限制](#限制)）。

Oracle 連線需要另外安裝 64 位元 Oracle Instant Client（執行期偵測 `PATH` / `ORACLE_HOME`）。

```bash
dbk --help          # 完整子指令清單
dbk stress --help   # 單一子指令的旗標說明
dbk --version
```

---

## 連線的三種指定方式

### 1. 沿用 GUI 已存的連線（推薦）

```bash
dbk --conn prod-mysql db list
```

`--conn` 吃**連線名稱或 id**，讀的是 GUI 那份 `connections.json` 加上 OS keychain 裡的密碼 —— 所以密碼不會出現在指令、script 或 shell 歷史裡。先用 `dbk conn list` 看有哪些。

### 2. 連線字串

```bash
dbk --url "mysql://app:secret@10.0.0.5:3306/shop" table list
dbk --url "postgres://user@host/db?sslmode=require" db list
dbk --url "oracle://user:pass@host:1521/SERVICE" table list
dbk --url "/var/data/local.sqlite" table list          # SQLite 直接給檔案路徑
```

與 GUI 的「從連線字串匯入」共用同一套解析器（`conn_url.rs`），支援 `mysql://` `postgres://` `mongodb+srv://` `rediss://` `sqlserver://` `oracle://` 與 Azure ADO.NET 格式。

### 3. 逐項旗標

```bash
DBKIT_PASSWORD=secret dbk --kind mysql --host 10.0.0.5 --port 3306 --user app -d shop table list
```

`--kind` 可為 `mysql` / `mariadb` / `postgres` / `sqlite` / `mongo` / `redis` / `mssql` / `oracle`。

> **密碼走 `DBKIT_PASSWORD` 環境變數，不要用 `--password`。** 寫在命令列上會進 shell 歷史，在多人機器上 `ps` 也看得到。

---

## 全域旗標

這些旗標放在子指令前後都可以。

| 旗標 | 說明 |
|---|---|
| `--conn <名稱\|id>` | 使用 GUI 已存的連線 |
| `--url <DSN>` | 連線字串 |
| `--kind` `--host` `--port` `--user` `--password` | 逐項指定臨時連線 |
| `-d, --database <名稱>` | 預設資料庫 / schema（SQLite 為檔案路徑、Redis 為 DB index） |
| `--format table\|csv\|json` | 輸出格式，預設 `table` |
| `--lang zh-TW\|zh-CN\|en\|ja\|ko` | 訊息與 `--help` 的語言（亦可用 `DBKIT_LANG`；預設讀 GUI 的設定） |
| `-y, --yes` | 確認執行寫入指令 |
| `--force` | 額外確認高破壞動作，須與 `--yes` 併用 |

環境變數：`DBKIT_PASSWORD`（密碼）、`DBKIT_LANG`（語言）。

---

## 安全模型：唯讀預設、`--yes`、`--force`

這是 `dbk` 最該先理解的部分。

**第一層 — 唯讀守門。** `query`、`explain`、`stress` 只放行查詢類語句（`select` / `with` / `show` / `describe` / `explain` / `pragma` / `use` / `values` / `table`）。偵測到寫入語句直接擋下並回非零結束碼。判斷是逐 `;` 切句後取首個有效關鍵字，會跳過註解，也會偵測 PostgreSQL 的可寫 CTE（`WITH x AS (DELETE …)`）。

```bash
$ dbk --conn prod query "delete from sessions"
error: 查詢失敗：CLI 為唯讀模式，僅允許查詢語句（偵測到 `delete`）
```

**第二層 — 寫入要 `--yes`。** 要改資料就用 `exec`（或 `table drop` / `redis set` 等寫入子指令）。沒帶 `--yes` 時**不執行**，只印出將要做的事並回非零結束碼 —— 等於內建的 dry run。

```bash
$ dbk --conn prod exec "update users set status='active' where id=42"
error: 此為寫入指令，未執行：執行：update users set status='active' where id=42。確認無誤請加 --yes
```

**第三層 — 高破壞動作要 `--yes --force`。** `DROP` / `TRUNCATE` / `FLUSHDB` / **沒有 `WHERE` 的 `UPDATE`·`DELETE`** 都算。WHERE 的判斷會先剝掉註解、字串與括號，只認頂層的 —— 把條件註解掉（`DELETE FROM t -- WHERE id=1`）或條件只在子查詢裡，都仍會被判為高破壞。

```bash
$ dbk --conn prod exec "delete from sessions" --yes
error: 此為高破壞動作，未執行：執行：delete from sessions。請再加 --force 確認
```

> 建議搭配**唯讀資料庫帳號**作為第二道防線。CLI 的守門是防手滑，不是防惡意。

---

## 輸出格式

```bash
dbk --conn prod --format table query "select id, name from users limit 3"   # 預設，對齊 ASCII 表格
dbk --conn prod --format csv   query "select id, name from users limit 3"   # 進 pipeline / Excel
dbk --conn prod --format json  query "select id, name from users limit 3"   # 給 jq
```

`table` 給人看，`csv` / `json` 給程式吃。進度與警告一律走 **stderr**，資料走 **stdout**，所以 `> out.json` 不會被污染。

```bash
dbk --conn prod --format json query "select * from orders limit 100" | jq '.[].status' | sort | uniq -c
```

---

## 指令參考

### `conn` — 連線管理

```bash
dbk conn list                                   # 列出 GUI 已存的連線（不含密碼）
dbk --conn prod conn test                       # 測試連線，不保留
dbk --conn prod conn ping                       # 量測往返延遲（含 SSH tunnel）
dbk conn export conns.enc --passphrase "…"      # 加密匯出全部連線（含密碼）
```

### `db` — 資料庫 / schema

```bash
dbk --conn prod db list
dbk --conn prod db create staging --yes
dbk --conn prod db drop staging --yes --force   # 連同其中所有物件，不可復原
```

PostgreSQL 的 `db create` / `db drop` 操作的是 **schema**。

### `table` — 資料表

```bash
dbk --conn prod -d shop table list
dbk --conn prod -d shop table columns orders
dbk --conn prod -d shop table info orders          # 列數 / 大小 / 引擎等統計
dbk --conn prod -d shop table ddl orders           # 建表 DDL
dbk --conn prod -d shop table indexes orders
dbk --conn prod -d shop table foreign-keys orders
```

分頁讀資料，支援多欄篩選與排序：

```bash
dbk --conn prod -d shop table data orders \
    --page 0 --page-size 50 \
    --filter "status:=:paid" \
    --filter "total:>:1000" \
    --sort "created_at:desc"

# 多個篩選預設 AND，加 --match-any 改成 OR
dbk --conn prod -d shop table data orders --filter "status:=:paid" --filter "status:=:shipped" --match-any
```

篩選語法是 `欄位:運算子[:值]`，運算子有 `=` `!=` `>` `>=` `<` `<=` `like` `is_null` `is_not_null`（後兩者不用給值）。排序是 `欄位:asc|desc`。

破壞性操作：

```bash
dbk --conn prod -d shop table truncate audit_log --yes --force
dbk --conn prod -d shop table drop tmp_import --yes --force
```

### `query` / `exec` / `explain`

```bash
# 唯讀查詢
dbk --conn prod query "select id, name from users limit 20"
dbk --conn prod query "select * from big_table" --max-rows 0     # 0 = 不限，取完整結果
dbk --conn prod query "select * from big_table" --max-rows 50000

# 寫入（含 DDL）
dbk --conn prod exec "update users set status='active' where id=42" --yes
dbk --conn prod exec "create index idx_orders_status on orders(status)" --yes

# 執行計畫
dbk --conn prod explain "select * from orders where status='paid'"
```

`query` 預設沿用全域列數上限（1,000 列），截斷時 stderr 會提示。`exec` 不過唯讀守門（那正是 `query` 的職責），改由 `--yes` / `--force` 兩段確認把關。

### `stress` — 壓力測試

多執行緒重複執行同一段查詢，量 TPS 與延遲分佈。與 GUI 的壓測是**同一個核心**（`stress.rs`）。

```bash
# 固定迭代：4 執行緒 × 每執行緒 100 次（預設）
dbk --conn prod stress "SELECT COUNT(*) FROM orders"

# 持續時間 + 爬升：8 執行緒跑滿 30 秒，前 5 秒逐步進場
dbk --conn prod stress "SELECT * FROM orders WHERE status='paid' LIMIT 100" \
    --threads 8 --seconds 30 --ramp 5 --warmup 20

# 報表導成 JSON（進度在 stderr，不會污染）
dbk --conn prod --format json stress "SELECT 1" --threads 16 --seconds 60 > bench.json
```

| 旗標 | 預設 | 說明 |
|---|---|---|
| `--threads <n>` | 4 | 並行執行緒，上限 64 |
| `--iterations <n>` | 100 | 每執行緒迭代次數。與 `--seconds` 互斥 |
| `--seconds <n>` | — | 改以持續時間計，跑滿 N 秒（**含**暖機與爬升） |
| `--ramp <n>` | 0 | 執行緒逐步進場的秒數，只在 `--seconds` 模式有意義 |
| `--warmup <n>` | 0 | 每執行緒暖機次數，不計入統計 |
| `--delay-ms <n>` | 0 | 每次迭代之間的間隔 |
| `--max-rows <n>` | 1000 | 每次查詢的取列上限，`0` = 完整取回 |
| `--timeout-ms <n>` | 30000 | 單次查詢逾時，`0` = 不逾時 |

**輸出**：`table` / `csv` 格式給重點指標兩欄表 + 錯誤分組表；`json` 給完整報表，含每秒一格的 `series`（可拿去畫圖）。

```
模式       | iterations      TPS   | 2777.8      p50 | 1.2
執行緒     | 4               平均  | 1.4         p90 | 1.4
完成查詢數 | 100             最小  | 0.8         p95 | 1.5
錯誤數     | 0               最大  | 7.2         p99 | 7.1
```

**怎麼讀**：看百分位的**形狀**而不是單一數字。`p99` 遠大於 `p50` 是排隊或鎖競爭；整體平坦但偏高是單次查詢成本就高；最大值遠離 `p99` 是偶發事件（checkpoint / GC / 網路重試）。

**注意事項**：

- CLI 的 `stress` **一律唯讀**，沒有 `--allow-writes`。要壓測寫入請開 GUI 明確扳開危險開關。
- 壓測會另開一條 `max_connections = --threads` 的**專屬連線**，跑完釋放。所以 `--threads 64` 就是對目標打 64 條連線，先確認伺服器的 `max_connections` 撐得住。
- 暖機的用途是讓連線與 plan cache 熱起來。沒有它，首次建連的數十毫秒會整個灌進 p99。
- `--seconds` 是**自壓測開始算的總時間預算**，暖機與爬升都含在裡面。

### `export` / `schema-dump` / `backup`

```bash
# 匯出單表（--data-format: csv | tsv | xlsx | json | sql | markdown）
dbk --conn prod -d shop export orders --to orders.csv --data-format csv --bom
dbk --conn prod -d shop export orders --to orders.xlsx --data-format xlsx
dbk --conn prod -d shop export orders --to orders.sql --data-format sql

# 匯出前先篩選 / 排序（語法同 table data）
dbk --conn prod -d shop export orders --to paid.csv \
    --filter "status:=:paid" --sort "created_at:desc"

# CSV 細節
dbk --conn prod -d shop export orders --to o.tsv --data-format tsv --delimiter $'\t' \
    --null-text "NULL" --no-header

# 整庫結構 SQL（所有表的建表語句）
dbk --conn prod -d shop schema-dump > schema.sql

# 備份
dbk --conn prod backup shop --to shop.dump
```

`--bom` 會在檔首寫 UTF-8 BOM，Excel 開中文 CSV 不會亂碼。

**`backup` 依資料庫種類走不同機制**，且**沒有內建的降級路徑** —— 找不到對應工具會直接失敗，不會靜默改用別的方式：

| 種類 | 機制 | 前置需求 |
|---|---|---|
| SQLite | 直接複製資料庫檔 | 無 |
| MySQL / MariaDB | `mysqldump` | 需在 `PATH` |
| PostgreSQL | `pg_dump` | 需在 `PATH` |
| MongoDB | `mongodump` | 需在 `PATH` |
| Redis | `redis-cli --rdb` | 需在 `PATH` |
| SQL Server / Oracle | 尚未支援 | — |

要在沒有官方工具的機器上留一份資料，改用 `export --data-format sql`（純內建，不需外部工具，但只出資料不含完整結構與索引）。`dbk` 不做還原 —— 那是破壞性操作，請用 GUI 或各資料庫的原生工具。

### `search` / `column-stats` / `routine` / `er-model` / `server-info`

```bash
# 跨資料庫找物件（名稱 / 定義內文 / 註解）
dbk --conn prod search "order_status"
dbk --conn prod search "TODO" --definitions --limit 50
dbk --conn prod search "usr" --whole-word                # 只比對整個單字
dbk --conn prod search "tmp_*" --wildcards               # 啟用 * 與 ?
dbk --conn prod search "audit" --databases shop --databases shop_archive --type table --type view

# 欄位剖析：總數 / 非空 / 相異值 / 範圍
dbk --conn prod -d shop column-stats orders status

# 預存程序 / 函式 / 觸發器
dbk --conn prod -d shop routine list
dbk --conn prod -d shop routine def sp_close_order --type procedure

# ER 模型（表 + 外鍵關係）與伺服器資訊
dbk --conn prod -d shop --format json er-model > er.json
dbk --conn prod server-info
```

三個比對範圍（`--names` / `--definitions` / `--comments`）都不給時，預設只比對名稱。

### `redis` — Redis 操作

讀取類：

```bash
dbk --conn cache redis keys --pattern "session:*" --limit 500
dbk --conn cache redis key session:42
dbk --conn cache redis slowlog --count 20
dbk --conn cache redis clients
dbk --conn cache redis big-keys --sample 200 --top 30      # 取樣 + MEMORY USAGE
```

寫入類（都要 `--yes`）：

```bash
dbk --conn cache redis set session:42 '{"uid":42}' --ttl 3600 --yes
dbk --conn cache redis expire session:42 600 --yes
dbk --conn cache redis persist session:42 --yes            # 移除 TTL，永不過期
dbk --conn cache redis rename session:42 session:42:old --yes
dbk --conn cache redis del session:42:old --yes
```

高破壞（要 `--yes --force`）：

```bash
dbk --conn cache redis del-prefix "session:" --yes --force --limit 50000
dbk --conn cache redis flush-db --yes --force
```

> `del-prefix` **不會**把前綴丟給 Redis 當 pattern。它先 `SCAN MATCH <前綴>*` 取出實際鍵名（上限 `--limit`，預設 10,000）再分批 `DEL`，確認訊息會先告訴你會刪掉幾個鍵。這樣 `*` `?` 等萬用字元不會被意外解讀成模式。

指定 DB index 用 `-d`：`dbk --conn cache -d 3 redis keys`。

---

## 常見情境

**每日匯出報表**

```bash
#!/usr/bin/env bash
set -euo pipefail
day=$(date +%F)
dbk --conn prod -d shop export orders --to "orders-$day.csv" \
    --data-format csv --bom --filter "created_at:>=:$day"
```

**排程備份（cron）**

```cron
0 3 * * * /usr/local/bin/dbk --conn prod backup shop --to /backup/shop-$(date +\%F).dump
```

**改版後跑一次效能基準線並存檔**

```bash
for q in "SELECT COUNT(*) FROM orders" "SELECT * FROM orders WHERE status='paid' LIMIT 100"; do
  dbk --conn staging --format json stress "$q" --threads 8 --seconds 20 --warmup 50 \
    >> "bench-$(date +%F).jsonl"
done
```

**用 jq 取出關鍵指標做趨勢**

```bash
dbk --conn staging --format json stress "SELECT 1" --threads 8 --seconds 30 \
  | jq '{rps, p95: .p95_ms, p99: .p99_ms, errors}'
```

**上線前確認 script 會打到哪一台（dry run）**

```bash
# 不帶 --yes：只印出將要做的事，回非零結束碼，什麼都不會改
dbk --conn prod exec "delete from sessions where expired_at < now()"
```

**稽核：找出所有引用某欄位的預存程序**

```bash
dbk --conn prod --format json search "customer_id" --definitions --type procedure | jq -r '.[].object_name'
```

---

## 結束碼與錯誤處理

| 結束碼 | 意義 |
|---|---|
| `0` | 成功 |
| 非 `0` | 任何錯誤，包含連線失敗、唯讀守門擋下、**未帶 `--yes` / `--force` 的預演** |

錯誤訊息印在 stderr，格式為 `error: <訊息>`，語言跟隨 `--lang`。

**要注意**：「未確認的寫入」也回非零結束碼。在 `set -e` 的 script 裡，忘了加 `--yes` 會讓整個 script 中止 —— 這是刻意的，寧可停下來也不要靜默略過。

---

## 限制

- **Kafka / Elasticsearch / RabbitMQ 連線 CLI 不支援**。沒有可在終端機表達的通用查詢語言，且精簡 binary 未編入其驅動；指定時會回明確錯誤，請改用 GUI。
- **`GO` 批次分隔未支援**。SSMS 貼出來的腳本，`GO` 之後的語句不會被切成獨立批次。
- **`stress` 一律唯讀**，不提供 `--allow-writes`。
- **不做還原**。`backup` 只產出 dump 檔；還原請用 GUI 或各資料庫的原生工具（還原是破壞性操作，需要互動確認）。
- **`backup` 需要各資料庫的官方 dump 工具在 `PATH`**（SQLite 除外，走檔案複製），沒有內建降級；SQL Server 與 Oracle 的備份尚未接上。
- **Oracle 連線需要 Instant Client**，未安裝時只有 Oracle 連線受影響。

---

相關文件：[README](../README.md) · [架構設計](./architecture.md) · [CHANGELOG](../CHANGELOG.md)
