# 預存程序整合測試（sp-test）

**繁體中文** · [English](./sp-test.en.md)

對**真實資料庫**上的預存程序跑**情境測試**：一個情境就是一條業務流程（下單 → 查庫存 → 取消 → 再查），
每個情境在一個交易裡跑完、**自動 rollback**，不會在資料庫留下任何資料。呼叫前後自動快照會被改到的表，
所以除了「回傳什麼」，也能驗證「改了哪些列、改成什麼」與「該報錯的地方有沒有報錯」。

同一份測試檔（JSON）可以在**桌面 App 裡點著跑**，也可以用 **`dbk sp-test` 在終端機 / CI 跑**，結果一致。

支援引擎：SQL Server、PostgreSQL、MySQL / MariaDB。

**目錄**

- [一分鐘看懂](#一分鐘看懂)
- [五分鐘上手：先跑範例](#五分鐘上手先跑範例)
- [用桌面 App（UI）](#用桌面-appui)
- [用命令列（CLI）與 CI](#用命令列cli與-ci)
- [情境食譜：8 個範例逐一說明](#情境食譜8-個範例逐一說明)
- [讀懂結果](#讀懂結果)
- [測試檔參考](#測試檔參考)
- [常見問題](#常見問題)
- [限制](#限制)

---

## 一分鐘看懂

每個情境都照這個順序跑：

```mermaid
flowchart LR
  A[開交易] --> B[灌前置資料<br/>fixture / insert]
  B --> C[快照<br/>會被改的表]
  C --> D[呼叫程序<br/>call]
  D --> E[再快照]
  E --> F[比對<br/>結果集・OUT・副作用・錯誤]
  F --> G{還有步驟?}
  G -- 有 --> C
  G -- 沒有 --> H[ROLLBACK]
```

一份測試檔，四種跑法：

| 模式 | UI 上叫 | 做什麼 | 什麼時候用 |
|---|---|---|---|
| `assert` | 斷言 | 比對測試檔裡寫的期望 | 日常開發 |
| `record` | 錄基線 | 把每一步的實際輸出錄成基線檔（`golden/`） | 第一次建立、或刻意改了程序行為之後 |
| `golden` | 基線 | 比期望，**也**比上次錄的基線 | CI 回歸：程序一改壞就紅燈 |
| `diff` | 差分 | 同一份測試檔在兩個連線各跑一次、逐步互比 | 遷移驗證（SQL Server / MySQL → PostgreSQL） |

一個最小的測試檔長這樣（下一支筆的訂單，預期庫存從 10 變 8）：

```json
{
  "version": 1,
  "target": {"kind": "mssql", "database": "sptest"},
  "fixtures": {"base": {"steps": [
    {"insert": "customers", "rows": [{"customer_id": ">>cid", "name": "Ann", "is_active": true}]},
    {"insert": "products",  "rows": [{"product_id": ">>pid", "name": "Pen", "price": "12.50", "stock": 10}]}
  ]}},
  "scenarios": [
    {"id": "happy_path", "use": ["base"], "steps": [
      {"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 2},
       "expect": {"result_sets": [{"rows": [{"qty": 2, "total": "25.00"}]}],
                  "effects": {"orders": {"inserted": 1}, "products": {"updated": 1}}}},
      {"query": "SELECT stock FROM products WHERE product_id = @pid", "expect": [{"stock": 8}]}
    ]}
  ]
}
```

- `">>cid"`：**擷取**。自動編號欄不寫入，由資料庫產生後存成符號 `cid`。
- `"<<cid"`：**引用**符號；在 SQL 裡寫 `@cid`。
- 期望**只比你列出的欄**——`orders` 還有 `created_at`，沒列就不比。

---

## 五分鐘上手：先跑範例

repo 附了一套樣本資料庫（三個引擎同一組表與程序）和 8 份範例測試檔（[`examples/sp-test/`](../examples/sp-test/)），
文件後面的每個情境都是從這裡來的，而且整合測試每次都會在三個引擎上把它們跑過一遍。

```bash
# 1. 起三個資料庫（SQL Server 11435、PostgreSQL 15433、MySQL 13307）
docker compose -f scripts/dev-sptest/docker-compose.yml up -d

# 2. 灌樣本 schema 與程序（以 MySQL 為例；SQL Server / PostgreSQL 的在同目錄 mssql/ pg/）
mysql -h 127.0.0.1 -P 13307 -uroot -ptest1234 < scripts/dev-sptest/mysql/schema.sql
mysql -h 127.0.0.1 -P 13307 -uroot -ptest1234 < scripts/dev-sptest/mysql/routines.sql

# 3. 跑全部範例
dbk sp-test run examples/sp-test --url "mysql://root:test1234@127.0.0.1:13307/sptest" -d sptest
```

> 也可以直接跑 `cargo test --lib sptest::it_sptest -- --ignored --test-threads=1`，它會自己建庫、灌程序、把範例在三個引擎上各跑一次。

在 App 裡：新增一個指向 `127.0.0.1:13307` 的 MySQL 連線 → 在 `sptest` 資料庫按右鍵 →「預存程序整合測試…」→ 選 `examples/sp-test` 當測試資料夾 → 執行。

---

## 用桌面 App（UI）

### 1. 打開

兩個入口：

- **資料庫右鍵 →「預存程序整合測試…」**：管理整個資料夾的測試檔。
- **預存程序右鍵 →「整合測試…」**：多了兩個能力——「新檔」會**盤點這支程序產生骨架**、「AI 產生情境」可用。

第一次會請你選一個**測試資料夾**（建議放在專案 repo 裡，例如 `db/tests/`）。一支程序一個 JSON 檔。

### 2. 新檔：從程序產生骨架

從程序右鍵開啟時按「**新檔**」，db-kit 會讀程序的簽名與本文，產生一份**打開就能跑**的測試檔：

![新檔：從程序產生的骨架](./screenshots/sp-test-guide-01-scaffold.png)

骨架裡有：

| 部分 | 怎麼來的 |
|---|---|
| `fixtures.base` | 程序本文讀寫到的表、以及它們的**外鍵父表**，依外鍵順序各灌一列。自動編號欄寫 `">>符號"`，外鍵欄引用父表的符號，NOT NULL 又沒預設值的欄填型別樣本值（數字 10、小數 `"10.00"`、字串 `"test"`…）。只會被 INSERT 的表不灌（程序自己會新增）。 |
| `happy_path` | 呼叫一次程序。參數名對得上符號就引用（`OrderID` ↔ `order_id`），OUT 參數擷取成符號，其餘填樣本值。**不猜期望值**——先跑一次看實際輸出再決定。 |
| `error_…` | 程序本文裡每個 `THROW` / `RAISERROR` / `SIGNAL` / `RAISE EXCEPTION` 各一個情境，已寫好 `expect_error`（類別、錯誤號、訊息），但先 `skip`——改好參數讓程序走到那個分支、拿掉 `skip`，就是一個錯誤路徑測試。 |

程序本文含 `COMMIT` / `ROLLBACK`（或 MySQL 會隱式 commit 的 DDL）時，所有情境都會帶 `skip` 並註明原因，見[限制](#限制)。

### 3. 執行、讀結果

按「**執行**」跑目前開著的檔（沒選檔就跑整個資料夾）。結果分頁：

![執行結果：摘要列、情境紅綠、逐步摘要](./screenshots/sp-test-guide-02-results.png)

- **摘要列**：每種判定各幾個（滑鼠移上去有說明）；「只看未通過」把綠的藏起來；「重跑未通過」只重跑紅的那幾個。
- **每個情境**：判定徽章、差異數、耗時；右邊的 ↻ **只重跑這一個**（有 case 時只重跑那個 case），結果併回原報表。
- **展開情境**：先是步驟清單，再是差異表。步驟清單每一列是一步：
  - ✓ 沒差異、⚠ 出錯但是預期中的（`expect_error`）、✗ 有差異。
  - 來源：`[base] customers` 表示來自 fixture `base`；其餘是程序名或 SQL 開頭。
  - 一行摘要：`結果集 1 列 · orders +1 · products ~1`（`+` 新增、`~` 更新、`-` 刪除）。

判定的意思見[讀懂結果](#讀懂結果)。

### 4. 看每一步的實際輸出，「採用實際值」寫成期望

點一步，展開它**實際**回了什麼：每個結果集、OUT 參數、每張表的副作用（更新的列有前像 / 後像）：

![點一步看實際輸出，旁邊是「採用實際值」](./screenshots/sp-test-guide-03-step-detail.png)

確認輸出是對的，按「**採用實際值**」就把它寫成這一步的期望（寫進編輯器，**還沒存檔**，檢查後按「儲存」）：

| 步驟 | 寫成 |
|---|---|
| `call` | 結果集 → `result_sets`；OUT → `out`（字面值）；有變化的表 → `effects` 的數量 |
| `query` / `sql` | 第一個結果集 → `expect` |
| 出錯的步驟 | 改成 `expect_error`（類別 + 訊息第一行） |

細節：自動編號 / 時間預設值欄（每次跑都不同）若對得到符號就寫成 `"<<oid"`，對不到就略過；整數寫成數字、小數維持字串（`"25.00"`）。
這三種情況不提供「採用實際值」：fixture 裡的步驟（多個情境共用，改它會影響別人）、有 `cases` 的情境（會把 `"<<qty"` 蓋成某個 case 的字面值）、差分模式。

> 建議的節奏：**骨架 → 執行 → 逐步確認 → 採用實際值 → 儲存 → 再執行變綠**。之後改了程序再跑，紅燈就代表行為變了。

### 5. 插入範例與說明面板

「**插入範例**」有 8 種情境骨架（正常流程、預期錯誤、OUT 參數、資料驅動、業務流程、不變量、不准動其他表、前後比對），
插入後接在 `scenarios` 最後、沿用檔案既有的 fixture 與程序名；佔位的表名 / 參數 / 值換成自己的就能跑。

工具列的「**使用說明**」打開說明面板：三步上手、目前模式的說明、符號速查，以及**目前設定對應的 CLI 指令**（可複製）；
工具列的「**CLI**」按鈕也會直接複製這段指令。

![說明面板與插入範例選單](./screenshots/sp-test-guide-04-recipes.png)

### 6. 其他

- **基線 / 錄基線**：選模式後旁邊多一格「基線資料夾」（預設 `<測試資料夾>/golden`）。
- **差分**：選模式後挑第二個連線與資料庫 / schema。
- **匯出報表**：寫到 `<測試資料夾>/reports/<時間>.junit.xml` 與 `.md`。
- **AI 產生情境**（從程序右鍵開時）：把程序簽名、本文、相關表 DDL 與測試檔格式交給 AI，回覆的 JSON 放進編輯器（不自動存檔）。AI 產生的期望值一樣要跑過、確認過。

---

## 用命令列（CLI）與 CI

### 典型流程

```bash
# 1. 產生骨架（-o 給資料夾 = <程序名>.json；已存在要加 --force；省略 -o 印到 stdout）
dbk sp-test init usp_cancel_order --conn mssql-test -d sales -o tests/

# 2. 看裡面有什麼情境（不連線）
dbk sp-test list tests/

# 3. 跑；看實際輸出改期望（--format json 有每一步完整的 outcomes）
dbk sp-test run tests/ --conn mssql-test -d sales
dbk sp-test run tests/usp_cancel_order.json --conn mssql-test -d sales --only happy_path --format json

# 4. 錄基線、之後在 CI 比基線
dbk sp-test run tests/ --conn mssql-test -d sales --mode record --golden golden/
dbk sp-test run tests/ --conn mssql-test -d sales --mode golden --golden golden/ --junit reports/sp.xml --exit-code

# 5. 遷移驗證：同一份測試檔在 SQL Server 與 PostgreSQL 各跑一次、逐步互比
dbk sp-test diff tests/ --conn mssql-test -d sales --dst pg-test --dst-db public --junit reports/diff.xml --exit-code
```

### 子指令

| 指令 | 連線 | 做什麼 |
|---|---|---|
| `init <程序>` | 要 | 產生測試檔骨架（同 UI 的「新檔」） |
| `list <檔或資料夾>…` | 不用 | 列出展開後的情境（含 `id/case`）、步驟數（`2+1` = fixture 2 步 + 情境 1 步）、標籤、略過原因 |
| `validate <檔或資料夾>…` | 不用 | 檢查格式與引用（未定義的 fixture、`expect` 與 `expect_error` 並存…） |
| `inspect <程序>` | 要 | 簽名、寫入目標、本文、`breaks_wrapping`（JSON；AI 產生情境用的原料） |
| `run <檔或資料夾>…` | 要 | `--mode assert`（預設）/ `record` / `golden` |
| `diff <檔或資料夾>…` | 要兩個 | `--dst` 第二個連線（已存連線名 / id 或連線字串）、`--dst-db` 它的庫 / schema |

`run` / `diff` 的選項：

| 選項 | 說明 |
|---|---|
| `--only a,b/c` | 只跑這些情境；`id` 跑整個情境，`id/case` 只跑那個 case（名字用 `list` 查） |
| `--tag smoke` | 只跑帶任一標籤的情境 |
| `--golden <dir>` | 基線資料夾（`record` / `golden` 必填） |
| `--junit <path>` | 另寫 JUnit XML |
| `--exit-code` | 任一情境未通過就以非零結束（CI 用） |
| `--format json` | stdout 輸出完整報表（每一步的實際輸出與差異）；進度一律在 stderr |
| `--max-rows <n>` | 每個結果集 / 快照的列數上限（預設 10000，0 = 不限） |

連線可以用 App 裡存好的連線名（`--conn`），也可以直接給連線字串（`--url`）：

```bash
--url "mssql://sa:密碼@localhost:1433/sales?trustServerCertificate=true"
--url "postgres://ci:密碼@localhost:5432/sales"      # PG 的 -d 是 schema
--url "mysql://root:密碼@localhost:3306/sales"
```

### 失敗時長怎樣

把 `01_place_order.json` 的兩個期望故意寫錯（總額寫 26.00、庫存寫 7）：

```
file                    | scenario   | verdict | ms  | first_difference
------------------------+------------+---------+-----+---------------------------------------------------------------
broken_place_order.json | happy_path | fail    | 102 | cell @ place: set 0 / row 0 / total: expected 26.00, got 25.00
(1 列)

# 預存程序整合測試報表

| 檔案 | 模式 | 目標 | 通過 | 失敗 | 錯誤 | 略過 |
|---|---|---|---|---|---|---|
| broken_place_order.json | assert | mysql | 0 | 1 | 0 | 0 |

### happy_path — fail

**place** (call)

| 類型 | 位置 | 期望 / A | 實際 / B | 備註 |
|---|---|---|---|---|
| cell | set 0 / row 0 / total | 26.00 | 25.00 |  |

**stock_after** (query)

| 類型 | 位置 | 期望 / A | 實際 / B | 備註 |
|---|---|---|---|---|
| cell | result / row 0 / stock | 7 | 8 |  |
```

先一張總表（每個情境的判定與第一處差異），有未通過的情境再印一份 Markdown 報表，逐步列出每一處差異。
步驟有寫 `id` 時顯示 `id`（`place`、`stock_after`），沒寫時顯示 `#3 call` 這種「第幾步 + 種類」，**序號含 fixture 的步驟**。

### CI

```yaml
# GitHub Actions 範例：服務容器起 SQL Server，灌 schema / 程序，再跑基線回歸
jobs:
  sp-test:
    runs-on: ubuntu-latest
    services:
      mssql:
        image: mcr.microsoft.com/mssql/server:2022-latest
        env: { ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: "${{ secrets.MSSQL_PASS }}" }
        ports: ["1433:1433"]
    steps:
      - uses: actions/checkout@v4
      - run: sqlcmd -S localhost -U sa -P "$MSSQL_PASS" -C -i db/schema.sql -i db/procs.sql
        env: { MSSQL_PASS: "${{ secrets.MSSQL_PASS }}" }
      - run: >
          dbk sp-test run db/tests --url "mssql://sa:$MSSQL_PASS@localhost:1433/sales?trustServerCertificate=true"
          --mode golden --golden db/golden --junit reports/sp-test.xml --exit-code
        env: { MSSQL_PASS: "${{ secrets.MSSQL_PASS }}" }
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: sp-test-report, path: reports/ }
```

基線（`golden/`）與測試檔一起進 git。PR 改了程序，`golden` 模式就紅燈；**刻意的**行為變更用 `--mode record` 重錄，基線檔的 diff 跟著 PR 一起審。

---

## 情境食譜：8 個範例逐一說明

每份都在 [`examples/sp-test/`](../examples/sp-test/)，對 [樣本 schema](../scripts/dev-sptest/) 在三個引擎都能跑（05 除外，見該節）。

| # | 檔案 | 示範什麼 |
|---|---|---|
| 1 | [`01_place_order.json`](../examples/sp-test/01_place_order.json) | 正常流程：結果集、副作用逐列、`effects_strict`、多步驟業務流程 |
| 2 | [`02_error_branches.json`](../examples/sp-test/02_error_branches.json) | 每個錯誤分支、錯誤後狀態不殘留、資料庫自己的約束錯誤 |
| 3 | [`03_out_params.json`](../examples/sp-test/03_out_params.json) | OUT 參數：擷取、比對、拿去下一步用 |
| 4 | [`04_data_driven.json`](../examples/sp-test/04_data_driven.json) | `cases`：同一組步驟跑 5 組邊界值 |
| 5 | [`05_result_set_shapes.json`](../examples/sp-test/05_result_set_shapes.json) | 多結果集、有序比對、只比數量、略過 |
| 6 | [`06_invariants_and_compare.json`](../examples/sp-test/06_invariants_and_compare.json) | 不變量查詢、`?` 只比值、`not`、整個結果集前後比對 |
| 7 | [`07_options_tags_skip.json`](../examples/sp-test/07_options_tags_skip.json) | `defaults`（大小寫、快照清單、strict）、標籤、略過 |
| 8 | [`08_migration_bug_demo.json`](../examples/sp-test/08_migration_bug_demo.json) | 差分：抓出移植到 PostgreSQL 時漏掉的一行 |

### 1. 正常流程與副作用

**想驗證**：下 2 支筆 → 回傳新訂單；`orders` 多一列且內容對；`products` 那支筆的庫存 10 → 8；**其他表都沒被動到**。

```json
{"id": "place", "call": "usp_place_order",
 "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 2},
 "capture": {"order_id": ">>oid"},
 "expect": {
   "result_sets": [{"rows": [{"qty": 2, "total": "25.00", "status": "NEW"}]}],
   "effects": {
     "orders":   {"inserted": [{"customer_id": "<<cid", "product_id": "<<pid", "qty": 2, "total": "25.00", "status": "NEW"}]},
     "products": {"updated":  [{"before": {"stock": 10}, "after": {"product_id": "<<pid", "stock": 8}}]}
   },
   "effects_strict": true}}
```

重點：

- `capture` 從**第一個結果集第一列**取 `order_id` 存成 `oid`，後面的 `query` / `call` 都能用。
- `effects` 可以只寫數量（`{"inserted": 1}`），也可以逐列寫；逐列時同樣只比列出的欄。`updated` 的 `before` 可省略。
- `effects_strict: true`：快照到的表裡，**沒列出的那些只要有變化就失敗**——抓「程序順手改了不該改的表」。
- 同檔的 `place_then_cancel` 是多步驟流程：下單 → 取消（`orders.status` NEW → CANCELLED、庫存回補）→ 查狀態 → 再取消一次要報錯。

### 2. 錯誤分支

**想驗證**：每一個「應該被擋下」的輸入都被擋下，而且**擋下之後不留痕跡**。

```json
{"id": "insufficient_stock_leaves_no_trace", "use": ["base"], "steps": [
  {"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 11},
   "expect_error": {"class": "user_raised", "message_contains": "insufficient stock"}},
  {"query": "SELECT stock FROM products WHERE product_id = @pid", "expect": [{"stock": 10}]},
  {"query": "SELECT COUNT(*) AS n FROM orders WHERE customer_id = @cid", "expect": [{"n": 0}]}
]}
```

重點：

- `expect_error` 比的是**錯誤類別**（三個引擎的錯誤號 / SQLSTATE 已對應好），可再加 `code`（SQL Server / MySQL 的錯誤號、PG 的 SQLSTATE）與 `message_contains`。只寫 `class` 的測試檔才能跨引擎共用。
- 出錯之後，預設回到呼叫前的 savepoint（`on_error: "rollback_to_savepoint"`，模擬應用程式收到錯誤就 rollback），所以後面的 `query` 看到的是「沒下過單」的狀態。要看錯誤當下殘留的狀態改 `"keep"`。
- `insert` 步驟也能 `expect_error`：`database_constraints` 情境故意塞違反外鍵、缺 NOT NULL 欄的列，驗證資料庫本身的約束（`constraint_violation` / `not_null`）。
- 兩個 fixture 可以疊：`"use": ["base", "inactive_customer"]`。
- **沒寫 `expect_error` 卻出錯 → 情境判 `error`**，後面的步驟不再跑。

### 3. OUT 參數

```json
{"call": "usp_adjust_credit", "params": {"CustomerID": "<<cid", "Delta": "12.5", "NewBalance": ">>bal"},
 "expect": {"out": {"NewBalance": "112.50"}}},
{"query": "SELECT credit FROM customers WHERE customer_id = @cid", "expect": [{"credit": "<<bal"}]}
```

- OUT 參數在 `params` 裡寫 `">>符號"` 就會被擷取；`expect.out` 比它的值；之後 `"<<bal"` / `@bal` 都能用。
- 參數名忽略大小寫、`@`、`p_` 前綴與底線：同一份檔案的 `NewBalance` 在 MySQL 對到 `p_new_balance`、在 PG 對到 `INOUT p_new_balance`。
- `two_adjustments`：同一個情境裡兩次呼叫看得到彼此的寫入（同一個交易）。

### 4. 資料驅動（cases）

```json
{"id": "qty_boundaries", "use": ["base"],
 "cases": [
   {"name": "one",        "vars": {"qty": 1,  "total": "12.50",  "left": 9}},
   {"name": "all_stock",  "vars": {"qty": 10, "total": "125.00", "left": 0}},
   {"name": "zero",       "vars": {"qty": 0},  "expect_error": {"class": "user_raised", "message_contains": "positive"}},
   {"name": "negative",   "vars": {"qty": -1}, "expect_error": {"class": "user_raised", "message_contains": "positive"}},
   {"name": "over_stock", "vars": {"qty": 11}, "expect_error": {"class": "user_raised", "message_contains": "insufficient"}}
 ],
 "steps": [{"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": "<<qty"},
            "expect": {"result_sets": [{"rows": [{"qty": "<<qty", "total": "<<total"}]}],
                       "effects": {"products": {"updated": [{"after": {"product_id": "<<pid", "stock": "<<left"}}]}}}}]}
```

- 每個 case 是**獨立的情境**（各自一個交易、各自一列報表：`qty_boundaries/zero`），`vars` 就是符號。
- case 的 `expect_error` 套在**最後一個 `call`**，並取代它的 `expect`——所以出錯的 case 不必給 `total` / `left`。
- 只跑某個 case：`--only qty_boundaries/zero`；UI 上按那一列的 ↻。

### 5. 多結果集與結果集的各種比法

```json
"expect": {"result_sets": [
  {"rows": [{"customer_id": "<<cid", "name": "Ann", "credit": "100.00"}]},
  {"ordered": true, "rows": [{"qty": 1, "total": "12.50"}, {"qty": 2, "total": "25.00"}]}
]}
```

| 寫法 | 意思 |
|---|---|
| `{"rows": [...]}` | 只比列出的欄、**不比列序**（未標 `?` 的欄當配對鍵） |
| `{"ordered": true, "rows": [...]}` | 依序比 |
| `{"count": 2}` | 只比列數 |
| `"ignore"` | 這個結果集不比（但位置要佔住） |
| `{"rows": []}` | 必須是空集 |

> PostgreSQL 的函式只能回一個結果集，多結果集要用 `SETOF refcursor`，目前不支援；這份範例只在 SQL Server / MySQL 跑。
> 另外 PG / MySQL 的零列結果集拿不到欄名，跨引擎的檔案別依賴「第 N 個結果集是空的」。

### 6. 不變量與前後比對

**不變量**：不管中間發生什麼，某個總量要守恆。這類查詢最能抓「改 A 忘了改 B」：

```json
{"id": "invariant",
 "query": "SELECT p.stock + COALESCE(SUM(o.qty), 0) AS units FROM products p LEFT JOIN orders o ON o.product_id = p.product_id AND o.status = 'NEW' WHERE p.product_id = @pid GROUP BY p.stock",
 "expect": [{"units": 10}]}
```

**欄名加 `?`** 只比值、不當配對鍵；**`{"not": …}`** 反向斷言：

```json
"expect": [{"qty": 2, "total?": "25.00", "status": "CANCELLED"},
           {"qty": 3, "total?": "37.50", "status": {"not": "CANCELLED"}}]
```

**整個結果集前後比對**：`capture: {"*": ">>before"}` 存下整個結果集，做完一串動作再存一次，`compare` 兩者——「取消訂單要把商品還原成原樣」：

```json
{"query": "SELECT product_id, name, price, stock FROM products WHERE product_id = @pid", "expect": [{"stock": 10}], "capture": {"*": ">>before"}},
{"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 4}, "capture": {"order_id": ">>oid"}},
{"call": "usp_cancel_order", "params": {"OrderID": "<<oid"}},
{"query": "SELECT product_id, name, price, stock FROM products WHERE product_id = @pid", "expect": [{"stock": 10}], "capture": {"*": ">>after"}},
{"compare": ["<<before", "<<after"]}
```

### 7. 比對選項、標籤、略過

```json
"defaults": {
  "case_insensitive_text": true,
  "snapshot": ["orders", "products", "customers"],
  "effects_strict": true
}
```

- `defaults` 對整個檔案生效：這裡 `"new"` 比得過 `"NEW"`、只快照三張表、每個 `call` 都套 `effects_strict`。
- `tags`：`--tag smoke` 只跑帶標籤的情境（`list` 會列出標籤）。
- `skip: "原因"`：不跑、報表標「略過」並寫原因。程序內含 `COMMIT` 的 `usp_commit_inside` 就用這個標著。
- 情境不一定要呼叫程序：`seed_only_check` 只用 `sql` + `expect` 檢查前置資料本身。

### 8. 遷移驗證：抓出移植錯誤

把 SQL Server 的程序移植到 PostgreSQL 之後，用 `diff` 讓兩邊跑同一份測試檔、逐步比輸出。
這份範例用 `routines` 把 PG 那邊的呼叫導到 `usp_place_order_bad`——一個「忘了扣庫存」的移植版：

```json
"routines": [{"name": "usp_place_order", "pg": "usp_place_order_bad"}]
```

```bash
dbk sp-test diff examples/sp-test/08_migration_bug_demo.json \
  --url "mssql://sa:Test1234!@127.0.0.1:11435/sptest?trustServerCertificate=true" -d sptest \
  --dst "postgres://postgres:test1234@127.0.0.1:15433/postgres" --dst-db sptest
```

```
file                       | scenario                     | verdict  | ms  | first_difference
---------------------------+------------------------------+----------+-----+--------------------------------------------------------
08_migration_bug_demo.json | ported_version_forgets_stock | mismatch | 126 | effect @ #3 call: effects / products: expected +0 ~1 -0

### ported_version_forgets_stock — mismatch

**#3 call** (call)

| 類型 | 位置 | 期望 / A | 實際 / B | 備註 |
|---|---|---|---|---|
| effect | effects / products | +0 ~1 -0 |  | postgres 沒有這張表的快照 |

**#4 query** (query)

| 類型 | 位置 | 期望 / A | 實際 / B | 備註 |
|---|---|---|---|---|
| cell | set 0 / row 0 / stock | mssql: 8 | postgres: 10 |  |
```

SQL Server 那邊 `products` 被更新了一列（`~1`），PostgreSQL 那邊完全沒動——壞掉的移植版根本沒寫 `products`，盤點不到它，所以註明「沒有這張表的快照」；
下一步查庫存，兩邊一個 8、一個 10，直接指出差在哪。

差分不需要寫期望——它比的是「兩邊的輸出一不一樣」：

- 自動編號、`nextval`、時間預設值（`getdate()` / `now()`…）的欄自動遮罩，只比「兩邊都 NULL / 都非 NULL」；擷取到的符號換成 `<符號>` 再比，所以 SQL Server 的訂單號 101 與 PG 的 1000 不算差異。
- 兩邊都出錯時比的是**錯誤類別**，不比訊息（判 `both_error`，算通過）。
- 表名 / 程序名兩邊不同時，用 `tables` / `routines` 對應（可分別給 `mssql` / `mysql` / `pg`）。

---

## 讀懂結果

### 判定

| 判定 | UI | 意思 | 算通過？ |
|---|---|---|---|
| `pass` | 通過 | 每一步都符合期望（基線 / 差分模式另外比對也一致） | ✓ |
| `fail` | 失敗 | 有步驟的實際輸出與期望（或基線）不符 | |
| `error` | 錯誤 | 沒寫 `expect_error` 卻出錯，或連線 / 測試檔本身有問題；出錯後的步驟不再跑 | |
| `seed_error` | 前置失敗 | fixture / insert 的前置資料灌不進去，情境沒有真正開始 | |
| `skipped` | 略過 | 情境帶 `skip` | ✓ |
| `mismatch` | 不一致 | 差分：兩個連線的輸出不同 | |
| `error_on_one_side` | 單邊出錯 | 差分：只有一邊出錯 | |
| `both_error` | 兩邊皆錯 | 差分：兩邊都出錯且錯誤類別相同 | ✓ |

`--exit-code` 與 UI 的紅綠都以「算通過」那一欄為準。

### 差異種類

| 種類 | 意思 |
|---|---|
| `cell` | 某列某欄的值不同（位置寫成 `set 0 / row 0 / total`） |
| `missing_row` / `surplus_row` | 期望的列沒出現 / 多出期望沒有的列 |
| `missing_column` | 結果集沒有期望寫的欄 |
| `count` / `result_set_count` | 列數 / 結果集數量不同 |
| `out` / `return_code` | OUT 參數 / 回傳碼不同 |
| `effect` | 某張表的新增 / 更新 / 刪除數量或內容不符 |
| `effect_strict` | `effects_strict` 下，沒列出的表有變化 |
| `error_class` / `error_code` / `error_message` | 錯誤類別 / 錯誤號 / 訊息不符（含「預期出錯但沒有錯誤」） |
| `unexpected_error` | 沒寫 `expect_error` 卻出錯 |
| `capture` / `expectation` | 擷取不到（欄不存在）/ 期望本身寫錯（引用了不存在的符號…） |
| `error_one_side` | 差分：只有一邊出錯、或只有一邊跑到這一步 |
| `golden:…` | 基線模式下與基線不同（後面接上面的種類） |

---

## 測試檔參考

`tests/<name>.json`，一個檔案通常對應一支程序，可以有多個情境。表名 / 程序名**不帶** schema 時依連線的資料庫（PG 為 schema）解析；
參數名忽略大小寫、`@`、`p_` 前綴與底線（`CustomerID` ≈ `p_customer_id`），所以同一份檔案可以直接拿去跑 PG 版。

### 頂層

| 鍵 | 說明 |
|---|---|
| `version` | 固定 `1` |
| `target` | `{"kind": "mssql" \| "postgres" \| "mysql", "database": "…"}`（資訊用；實際連哪裡由執行時決定） |
| `routine` | 主要測的程序（選填；UI 插入範例時用） |
| `fixtures` | `{"名稱": {"description"?, "steps": [...]}}`，情境用 `use` 引用、依序展開在情境步驟之前 |
| `defaults` | 整個檔案的選項，見下 |
| `tables` / `routines` | 跨引擎名稱對應：`[{"name": "orders", "pg": "order_header"}]` |
| `scenarios` | 情境清單 |

情境：`id`、`description`、`tags`、`skip`（`true` 或原因字串）、`use`、`cases`、`snapshot`（覆寫檔案的設定）、`steps`。

### 步驟

| 步驟 | 說明 |
|---|---|
| `insert` | 灌資料。值寫 `">>sym"` 的欄不寫入、由引擎回填後存成符號（identity / default）。`identity_insert: true` 可指定自動欄的值。 |
| `call` | 呼叫程序 / 函式。`params` 依名稱對簽名；OUT 參數可給初值、或寫 `">>sym"` 擷取。`capture` 從第一個結果集取值（`{"col": ">>sym"}`）或存整個結果集（`{"*": ">>sym"}`）。`on_error` 見下。 |
| `query` | 跑 SQL 並斷言結果（`expect` 必填）。SQL 裡的 `@sym` 以符號值代入。 |
| `sql` | 任意 SQL，`expect` 可選。 |
| `compare` | 比兩個已存的結果集符號：`{"compare": ["<<a", "<<b"]}`。 |
| `snapshot` | 改變之後 `call` 要快照的表清單。 |

每一步都可以有 `id`（報表顯示用）與 `description`；`insert` / `call` / `query` / `sql` 都可以寫 `expect_error`（與 `expect` 二擇一）。

符號：`">>name"` 擷取、`"<<name"` 引用、`"<<name.col"` 取結果集符號第一列的欄、SQL 內 `@name`。`cases` 的 `vars` 也是符號。

### 斷言寫法

| 想斷言 | 寫法 |
|---|---|
| 結果集（部分欄、不比列序） | `"result_sets": [{"rows": [{"qty": 2, "total": "25.00"}]}]` |
| 結果集有序 | `{"ordered": true, "rows": [...]}` |
| 只比值不當配對鍵 | 欄名加 `?`：`{"id": 1, "amount?": "9.99"}` |
| 空集 / 略過 / 數量 | `{"rows": []}` · `"ignore"` · `{"count": 3}` |
| OUT 參數 / return code | `"out": {"NewBalance": "112.50"}` · `"return_code": 0` |
| 副作用數量 | `"effects": {"orders": {"inserted": 1, "updated": 0}}` |
| 副作用逐列 | `"effects": {"orders": {"inserted": [{"qty": 2}]}, "products": {"updated": [{"before": {"stock": 10}, "after": {"stock": 8}}]}}` |
| 沒列出的表不准動 | `"effects_strict": true` |
| 預期錯誤 | `"expect_error": {"class": "user_raised", "code": 50001, "message_contains": "customer"}` |
| 反向 | `{"status": {"not": "CANCELLED"}}` |
| 型別標記 | `{"type": "datetime", "value": "2024-01-02 03:04:05"}`（`decimal` / `date` / `uuid` / `bytes`(base64) / `json`） |

錯誤類別：`constraint_violation` / `not_null` / `conversion` / `divide_by_zero` / `user_raised` / `not_found` / `timeout` / `other`，三個引擎的錯誤號 / SQLSTATE 已對應好。

### 值怎麼比

`1.0` = `1`、`12.5` = `12.50`、bit = boolean、各家日期字串寫法、JSON 鍵序都視為相等。`defaults` 可調：

| 選項 | 預設 | 說明 |
|---|---|---|
| `float_rel_tol` / `float_abs_tol` | `1e-9` / `1e-12` | 浮點容差 |
| `datetime_tol_ms` | `10` | 日期時間容差（毫秒） |
| `ignore_trailing_spaces` | `true` | 忽略字串尾端空白（CHAR 補空白） |
| `case_insensitive_text` | `false` | 文字比對不分大小寫 |
| `null_equals_empty` | `false` | NULL 與空字串視為相等 |
| `zero_date_as_null` | `true` | MySQL 的 `0000-00-00` 當 NULL |
| `mask_columns` | `[]` | 這些欄只比「都 NULL / 都非 NULL」（`"col"` 或 `"table.col"`） |
| `ordered` | `false` | 結果集預設是否比列序 |
| `snapshot` | `"auto"` | 快照哪些表：`"auto"`、`"none"`、或明列 `["orders", "products"]` |
| `effects_strict` | `false` | 每個 `call` 預設是否 strict |
| `on_error` | `"rollback_to_savepoint"` | 出錯後的狀態：回到呼叫前，或 `"keep"` |
| `max_snapshot_rows` | `50000` | 每張表快照列數上限（超過時數量仍可信、逐列比對不完整） |
| `lock_timeout_ms` / `statement_timeout_ms` | `5000` / `60000` | 逾時 |

identity / `nextval` / 時間預設值的欄自動遮罩（各引擎的自動值本來就不會相等）。

### 副作用快照

`snapshot: "auto"`（預設）盤點會被寫的表：SQL Server 用 `sys.dm_sql_referenced_entities`，PG / MySQL 掃程序本文，
都會遞迴進被呼叫的程序與表上的觸發器（≤ 5 層）。快照在同一條連線上拍，看得到未提交的狀態。
盤點漏掉的表（例如動態 SQL 寫的）在報表會顯示「這張表不在快照清單裡」——用 `snapshot` 明列，或在情境裡加一個 `{"snapshot": [...]}` 步驟。

### 錯誤之後

`call` 出錯時先拍後快照（記錄真實的部分副作用——SQL Server `XACT_ABORT OFF` 與 MySQL 無 handler 時錯誤前的寫入會留著），
再依 `on_error` 決定後續步驟看到的狀態：`rollback_to_savepoint`（預設）或 `keep`。PostgreSQL 一律回到 savepoint（交易已 aborted）。

---

## 常見問題

**情境顯示「通過」，可是我什麼期望都沒寫？**
沒有 `expect` 的 `call` 只要不出錯就算通過——骨架的 `happy_path` 一開始就是這樣。展開步驟看實際輸出，按「採用實際值」或手寫 `expect` 之後才真的在驗證東西。

**每次跑訂單號都不一樣，期望要怎麼寫？**
不要寫死。用 `capture` 擷取成符號、再用 `"<<oid"` 引用；或乾脆不列那一欄（只比列出的欄）。自動編號欄在基線 / 差分比對時會自動遮罩。

**SQL Server 用 `--url` 連不上（`Timed out in bb8`）？**
本機 / 測試容器多半是自簽憑證，連線字串加 `?trustServerCertificate=true`。

**程序裡有 `COMMIT` / `ROLLBACK`？**
這種程序不能包在外層交易裡跑（會把外層交易一起提交或滾掉）。`dbk sp-test inspect` 的 `breaks_wrapping` 會標出來，骨架也會自動 `skip`。目前只能略過或改測它呼叫的子程序。

**報表說「這張表不在快照清單裡」？**
自動盤點沒找到這張表被寫（常見於動態 SQL）。在 `defaults.snapshot` 明列，或在 `call` 之前加 `{"snapshot": ["那張表"]}`。

**可以對正式環境跑嗎？**
可以，但只允許預設的 wrapped（交易 + rollback）模式；會鎖到列，建議還是對測試庫或還原的副本跑。

**為什麼測試檔裡小數要寫成字串？**
JSON 的 `25.00` 讀進來是 `25`，`"25.00"` 才保留原樣；比對時 `"25.00"` 與 `25` 本來就相等，但寫成字串報表比較好讀。

---

## 限制

- 程序內有 `COMMIT` / `ROLLBACK`（MySQL 還有 DDL 的隱式 commit）的不能包在交易裡跑；isolated 模式（不包交易、事後清理）之後版本支援。
- PostgreSQL 的函式只有一個結果集；多結果集的程序要改用 `SETOF refcursor`（之後版本支援）。
- 零列的結果集在 PostgreSQL / MySQL 拿不到欄名，空對空視為相等。
- 符號代入是字面值替換不是 bind。
- 「採用實際值」只寫副作用的**數量**；要逐列比對請自己展開成 `[{...}]`。

## 整合測試 vs 效能測試

| | 整合測試（本功能） | 效能測試（壓力測試） |
|---|---|---|
| 目的 | 行為正確：結果、副作用、錯誤 | 延遲 / 吞吐 / 錯誤率 |
| 執行 | 1 次 / 情境，包交易 rollback | N 次、多執行緒、持續 D 秒 |
| 資料 | 精準 seed | 真實規模、參數池分散 |
| 判定 | 確定性（含容差） | 統計：p95 ≤ 閾值、≤ 基線 × 1.2 |
| 在遷移中 | 「轉對了沒」（`diff`） | 「轉完會不會變慢」 |

## 開發 / 整合測試

```bash
docker compose -f scripts/dev-sptest/docker-compose.yml up -d
cargo test --lib sptest::it_sptest -- --ignored --test-threads=1   # 引擎、範例、骨架在三個引擎上的端到端測試
npm run verify:ui -- sp-test-dialog sp-test-from-routine           # 介面（假後端，不需資料庫）
```
