# 預存程序整合測試（sp-test）

**繁體中文** · [English](./sp-test.en.md)

對真實資料庫、真實資料、含副作用的預存程序做**整合測試**：一個情境 = 一條業務流程（下單 → 查庫存 → 取消 → 再查），
在一個交易裡跑完自動 rollback，呼叫前後自動快照受影響的表、比對結果集 / OUT 參數 / 副作用 / 錯誤類別。

四種用法共用同一份測試檔：

| 模式 | 做什麼 | 用途 |
|---|---|---|
| `assert` | 比對測試檔裡寫的期望 | 日常 |
| `record` | 把每一步的實際輸出錄成基線（`golden/`） | 建 / 更新基線 |
| `golden` | 比期望 **也** 比基線 | CI 回歸：改了 SP 就紅燈 |
| `diff` | 同一份測試檔在兩個連線各跑一次、逐步互比 | 遷移驗證（SQL Server / MySQL → PostgreSQL） |

支援引擎：SQL Server、PostgreSQL、MySQL / MariaDB。

## 測試檔

`tests/<name>.json`，一個檔案通常對應一支預存程序，可以有多個情境。表名 / 程序名**不帶** schema 時依連線的
資料庫（PG 為 schema）解析；參數名忽略大小寫、`@`、`p_` 前綴與底線（`CustomerID` ≈ `p_customer_id`），
所以同一份檔案可以直接拿去跑 PG 版。

```json
{
  "version": 1,
  "target": {"kind": "mssql", "database": "sales"},
  "fixtures": {
    "base": {"steps": [
      {"insert": "customers", "rows": [{"customer_id": ">>cid", "name": "Ann", "credit": "100.00", "is_active": true}]},
      {"insert": "products",  "rows": [{"product_id": ">>pid", "name": "Pen", "price": "12.50", "stock": 10}]}
    ]}
  },
  "scenarios": [
    {"id": "place_then_cancel", "use": ["base"], "steps": [
      {"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 2},
       "capture": {"order_id": ">>oid"},
       "expect": {"result_sets": [{"rows": [{"qty": 2, "total": "25.00", "status": "NEW"}]}],
                  "effects": {"orders": {"inserted": 1},
                              "products": {"updated": [{"before": {"stock": 10}, "after": {"product_id": "<<pid", "stock": 8}}]}}}},
      {"query": "SELECT stock FROM products WHERE product_id = @pid", "expect": [{"stock": 8}]},
      {"call": "usp_cancel_order", "params": {"OrderID": "<<oid"}},
      {"query": "SELECT stock FROM products WHERE product_id = @pid", "expect": [{"stock": 10}]},
      {"call": "usp_cancel_order", "params": {"OrderID": "<<oid"}, "expect_error": {"class": "user_raised"}}
    ]},
    {"id": "qty_cases", "use": ["base"],
     "cases": [{"name": "two", "vars": {"qty": 2, "total": "25.00"}},
               {"name": "zero", "vars": {"qty": 0}, "expect_error": {"class": "user_raised"}}],
     "steps": [{"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": "<<qty"},
                "expect": {"result_sets": [{"rows": [{"qty": "<<qty", "total": "<<total"}]}]}}]}
  ]
}
```

### 步驟

| step | 說明 |
|---|---|
| `insert` | 灌 seed。值寫 `">>sym"` 的欄不寫入、由引擎回填後存成符號（identity / default）。`identity_insert: true` 可指定自動欄的值。 |
| `call` | 呼叫程序 / 函式。`params` 依名稱對簽名；OUT 參數可給初值、或寫 `">>sym"` 擷取。`capture` 從第一個結果集取值（`{"col": ">>sym"}`）或存整個結果集（`{"*": ">>sym"}`）。 |
| `query` | 跑 SQL 並斷言結果（`expect` 必填）。SQL 裡的 `@sym` 以符號值代入。 |
| `sql` | 任意 SQL，`expect` 可選。 |
| `compare` | 比兩個已存的結果集符號：`{"compare": ["<<a", "<<b"]}`。 |
| `snapshot` | 改變之後 `call` 要快照的表清單。 |

符號：`">>name"` 擷取、`"<<name"` 引用、`"<<name.col"` 取結果集第一列的欄、SQL 內 `@name`。
`cases` 的 `vars` 也是符號；`fixtures` + `use` 共用前置步驟；`tags` 篩選；`skip: "原因"` 略過。

### 斷言

| 想斷言 | 寫法 |
|---|---|
| 結果集（部分欄、不比列序） | `"result_sets": [{"rows": [{"qty": 2, "total": "25.00"}]}]` — 只比列出的欄；未標 `?` 的欄當 key 配對；報「值不符 / 多列 / 缺列」 |
| 結果集有序 | `{"ordered": true, "rows": [...]}` |
| 只比值不當 key | 欄名加 `?`：`{"id": 1, "amount?": "9.99"}` |
| 空集 / 略過 / 數量 | `{"rows": []}` · `"ignore"` · `{"count": 3}` |
| OUT 參數 / return code | `"out": {"NewBalance": "112.50"}`, `"return_code": 0` |
| 副作用數量 | `"effects": {"orders": {"inserted": 1, "updated": 0}}` |
| 副作用逐列 | `"effects": {"orders": {"inserted": [{"qty": 2}]}, "products": {"updated": [{"before": {"stock": 10}, "after": {"product_id": "<<pid", "stock": 8}}]}}` |
| 沒列出的表不准動 | `"effects_strict": true` |
| 預期錯誤 | `"expect_error": {"class": "user_raised", "code": 50001, "message_contains": "customer"}` |
| 反向 | `{"status": {"not": "CANCELLED"}}` |
| 型別標記 | `{"type": "datetime", "value": "2024-01-02 03:04:05"}`（`decimal` / `date` / `uuid` / `bytes`(base64) / `json`） |

錯誤類別：`constraint_violation` / `not_null` / `conversion` / `divide_by_zero` / `user_raised` / `not_found` / `timeout` / `other`，
三個引擎的錯誤號 / SQLSTATE 已對應好，`diff` 模式「兩邊都出錯」時比的是類別而不是訊息。

值比對：`1.0` = `1`、`12.5` = `12.50`、bit = boolean、各家日期字串寫法、JSON 鍵序；容差在 `defaults`：
`float_rel_tol`（1e-9）、`datetime_tol_ms`（10）、`ignore_trailing_spaces`（true）、`case_insensitive_text`（false）、
`zero_date_as_null`（true）、`mask_columns`。identity / `nextval` / 時間預設值（`getdate()` / `now()`…）的欄位自動遮罩——
只比「兩邊都 NULL / 都非 NULL」，各引擎的自動值本來就不會相等。

### 副作用快照

`defaults.snapshot`：`"auto"`（預設；盤點程序本文與 `sys.dm_sql_referenced_entities` 找出會寫的表，含被呼叫程序與觸發器）、
`"none"`、或明列 `["orders", "products"]`。快照在同一條連線上拍，看得到未提交的狀態。

### 錯誤之後

`call` 出錯時先拍後快照（記錄真實的部分副作用——SQL Server `XACT_ABORT OFF` 與 MySQL 無 handler 時錯誤前的寫入會留著），
再依 `on_error` 決定後續步驟看到的狀態：`rollback_to_savepoint`（預設；模擬應用層收到錯誤就 rollback）或 `keep`。
PostgreSQL 一律回到 savepoint（交易已 aborted）。沒寫 `expect_error` 卻出錯 → 情境判 `error`，後面的步驟不再跑。

### 限制

- 程序內有 `COMMIT` / `ROLLBACK`（MySQL 還有 DDL 的隱式 commit）的不能包在交易裡跑；`dbk sp-test inspect` 的 `breaks_wrapping` 會標出來。
- PostgreSQL 的函式只有一個結果集；多結果集的程序要改用 `SETOF refcursor`（之後版本支援）。
- 零列的結果集在 PostgreSQL / MySQL 拿不到欄名，空對空視為相等。
- 符號代入是字面值替換不是 bind。

## CLI

```
dbk sp-test validate tests/
dbk sp-test inspect dbo.usp_place_order --conn mssql-test -d sales            # 簽名、寫入目標、本文（JSON）
dbk sp-test run tests/ --conn mssql-test -d sales                              # assert
dbk sp-test run tests/ --conn mssql-test -d sales --mode record --golden golden/
dbk sp-test run tests/ --conn mssql-test -d sales --mode golden --golden golden/ --junit reports/mssql.xml --exit-code
dbk sp-test diff tests/ --conn mssql-test -d sales --dst pg-test --dst-db public --junit reports/diff.xml --exit-code
```

`--only a,b` 只跑指定情境、`--tag smoke` 篩標籤、`--format json` 輸出完整報表、`--exit-code` 讓任何未通過的情境回非零。
`--conn` 可換成 `--url "mssql://sa:…@host:1433/sales"`。

### CI

```yaml
steps:
  - sqlcmd -i schema/*.sql -i procs/*.sql
  - dbk sp-test run tests/ --url "mssql://sa:$MSSQL_PASS@localhost:1433/sales" --mode golden --golden golden/ --junit reports/mssql.xml --exit-code
  - dbk sp-test diff tests/ --url "mssql://…/sales" --dst "postgres://ci:$PG_PASS@localhost:5432/sales" --dst-db public --junit reports/diff.xml --exit-code
  - upload reports/*.xml
```

基線（`golden/`）與測試檔一起進 git；PR 改了 SP 就在 `golden` 模式紅燈，刻意的行為變更用 `--mode record` 更新基線後一起提交（diff 可審）。

## 整合測試 vs 效能測試

| | 整合測試（本功能） | 效能測試（壓力測試） |
|---|---|---|
| 目的 | 行為正確：結果、副作用、錯誤 | 延遲 / 吞吐 / 錯誤率 |
| 執行 | 1 次 / 情境，包交易 rollback | N 次、多執行緒、持續 D 秒 |
| 資料 | 精準 seed | 真實規模、參數池分散 |
| 判定 | 確定性（含容差） | 統計：p95 ≤ 閾值、≤ 基線 × 1.2 |
| 在遷移中 | 「轉對了沒」（`diff`） | 「轉完會不會變慢」 |

## 開發 / 整合測試

```
docker compose -f scripts/dev-sptest/docker-compose.yml up -d
cargo test --lib sptest::it_sptest -- --ignored --test-threads=1
```
