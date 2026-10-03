# Stored Procedure Integration Testing (sp-test)

[繁體中文](./sp-test.md) · **English**

Run **scenario tests** against stored procedures on a **real database**. A scenario is one business flow (place an order → check stock → cancel → check again).
Each scenario runs inside a transaction that is **rolled back automatically**, so nothing is left behind in the database. The tables a call is going to change are
snapshotted before and after it, so besides "what did it return" you can also check "which rows changed and to what" and "did it raise an error where it should".

The same test file (JSON) can be **run by clicking in the desktop app** or with **`dbk sp-test` in a terminal / CI**, with the same results.

Supported engines: SQL Server, PostgreSQL, MySQL / MariaDB.

> The app's UI is shown in Traditional Chinese in the screenshots; the English labels are given in the text (the app follows your language setting).

**Contents**

- [The one-minute version](#the-one-minute-version)
- [Five minutes: run the examples first](#five-minutes-run-the-examples-first)
- [Using the desktop app (UI)](#using-the-desktop-app-ui)
- [Using the command line (CLI) and CI](#using-the-command-line-cli-and-ci)
- [Scenario cookbook: the 8 examples](#scenario-cookbook-the-8-examples)
- [Reading the results](#reading-the-results)
- [Test file reference](#test-file-reference)
- [FAQ](#faq)
- [Limitations](#limitations)

---

## The one-minute version

Every scenario runs in this order:

```mermaid
flowchart LR
  A[Begin transaction] --> B[Load seed data<br/>fixture / insert]
  B --> C[Snapshot<br/>tables to be changed]
  C --> D[Call the routine<br/>call]
  D --> E[Snapshot again]
  E --> F[Compare<br/>result sets · OUT · side effects · errors]
  F --> G{More steps?}
  G -- yes --> C
  G -- no --> H[ROLLBACK]
```

One test file, four ways to run it:

| Mode | In the UI | What it does | When |
|---|---|---|---|
| `assert` | Assert | Checks the expectations written in the test file | Everyday development |
| `record` | Record golden | Records each step's actual output as a baseline (`golden/`) | The first time, or after you deliberately changed a routine's behavior |
| `golden` | Golden | Checks the expectations **and** the last recorded baseline | CI regression: red as soon as a routine breaks |
| `diff` | Diff | Runs the same test file on two connections and compares them step by step | Migration verification (SQL Server / MySQL → PostgreSQL) |

A minimal test file looks like this (order two pens, expect the stock to go from 10 to 8):

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

- `">>cid"`: **capture**. The generated key is not written; the database generates it and it is stored as the symbol `cid`.
- `"<<cid"`: **reference** a symbol; inside SQL write `@cid`.
- Expectations **only compare the columns you list**: `orders` also has `created_at`, which is not compared because it is not listed.

---

## Five minutes: run the examples first

The repo ships a sample database (the same tables and routines on all three engines) and 8 example test files ([`examples/sp-test/`](../examples/sp-test/)).
Every scenario later in this guide comes from there, and the integration tests run all of them on all three engines every time.

```bash
# 1. Start three databases (SQL Server 11435, PostgreSQL 15433, MySQL 13307)
docker compose -f scripts/dev-sptest/docker-compose.yml up -d

# 2. Load the sample schema and routines (MySQL shown; SQL Server / PostgreSQL are in mssql/ and pg/ next to it)
mysql -h 127.0.0.1 -P 13307 -uroot -ptest1234 < scripts/dev-sptest/mysql/schema.sql
mysql -h 127.0.0.1 -P 13307 -uroot -ptest1234 < scripts/dev-sptest/mysql/routines.sql

# 3. Run every example
dbk sp-test run examples/sp-test --url "mysql://root:test1234@127.0.0.1:13307/sptest" -d sptest
```

> Or just run `cargo test --lib sptest::it_sptest -- --ignored --test-threads=1`: it creates the databases, loads the routines and runs the examples on each of the three engines.

In the app: add a MySQL connection to `127.0.0.1:13307` → right-click the `sptest` database → "Stored-procedure integration tests…" → pick `examples/sp-test` as the test folder → Run.

---

## Using the desktop app (UI)

### 1. Open it

Two entry points:

- **Right-click a database → "Stored-procedure integration tests…"**: manage a whole folder of test files.
- **Right-click a stored procedure → "Integration tests…"**: adds two abilities. "New file" **inspects the routine and generates a skeleton**, and "Generate scenarios with AI" becomes available.

The first time, you pick a **test folder** (ideally inside your project repo, e.g. `db/tests/`). One JSON file per routine.

### 2. New file: generate a skeleton from the routine

Opened from a routine, **New file** reads the routine's signature and body and writes a test file that **runs as generated**:

![New file: a skeleton generated from the routine](./screenshots/sp-test-guide-01-scaffold.png)

The skeleton contains:

| Part | Where it comes from |
|---|---|
| `fixtures.base` | One row for every table the routine reads or writes, plus their **foreign-key parents**, in foreign-key order. Generated keys are written as `">>symbol"`, foreign-key columns reference the parent's symbol, and NOT NULL columns without a default get a sample value for their type (number 10, decimal `"10.00"`, string `"test"`…). Tables the routine only INSERTs into are not seeded (the routine adds the rows itself). |
| `happy_path` | Calls the routine once. Parameters whose names match a symbol reference it (`OrderID` ↔ `order_id`), OUT parameters are captured as symbols, the rest get sample values. **Expected values are not guessed**: run it once and look at the actual output first. |
| `error_…` | One scenario for every `THROW` / `RAISERROR` / `SIGNAL` / `RAISE EXCEPTION` in the routine body, with `expect_error` already filled in (class, error number, message) but `skip`ped. Adjust the parameters so the routine reaches that branch, remove `skip`, and you have an error-path test. |

If the routine body contains `COMMIT` / `ROLLBACK` (or, on MySQL, DDL that commits implicitly), every scenario is skipped with the reason written out; see [Limitations](#limitations).

### 3. Run and read the results

**Run** runs the open file (or the whole folder when no file is selected). The Result tab:

![Results: summary bar, scenario verdicts, step summaries](./screenshots/sp-test-guide-02-results.png)

- **Summary bar**: how many scenarios got each verdict (hover for an explanation). "Only not passed" hides the green ones; "Re-run the ones that did not pass" re-runs just the red ones.
- **Each scenario**: verdict badge, number of differences, duration. The ↻ on the right **re-runs just this one** (only that case when it has cases), and the result is merged back into the report.
- **Expand a scenario**: first the step list, then the difference table. Each row in the step list is one step:
  - ✓ no differences, ⚠ errored as expected (`expect_error`), ✗ has differences.
  - Source: `[base] customers` means it comes from fixture `base`; otherwise the routine name or the start of the SQL.
  - One-line summary: `result set 1 row · orders +1 · products ~1` (`+` inserted, `~` updated, `-` deleted).

The verdicts are explained in [Reading the results](#reading-the-results).

### 4. See each step's actual output, and "Use actual" to turn it into the expectation

Click a step to see what it **actually** returned: every result set, OUT parameters, and the side effects on each table (updated rows show before / after):

![Click a step to see its actual output, next to "Use actual"](./screenshots/sp-test-guide-03-step-detail.png)

If the output is right, **Use actual** writes it as that step's expectation (into the editor, **not saved yet**; review it, then Save):

| Step | Written as |
|---|---|
| `call` | result sets → `result_sets`; OUT → `out` (literal values); tables that changed → counts in `effects` |
| `query` / `sql` | the first result set → `expect` |
| a step that errored | becomes `expect_error` (class + first line of the message) |

Details: generated-key / timestamp-default columns (different on every run) are written as `"<<oid"` when they match a symbol and skipped otherwise; integers become numbers, decimals stay strings (`"25.00"`).
"Use actual" is not offered for steps from a fixture (shared by several scenarios, changing it would affect the others), for scenarios with `cases` (it would overwrite `"<<qty"` with one case's literal value), or in diff mode.

> The suggested rhythm: **skeleton → run → check each step → Use actual → save → run again, now green**. From then on, a red result after you change the routine means its behavior changed.

### 5. Insert example and the help panel

**Insert example** offers 8 scenario skeletons (happy path, expected error, OUT parameter, data-driven, business flow, invariant, no other table may change, before / after compare).
The inserted scenario goes to the end of `scenarios` and reuses the file's existing fixture and routine name; replace the placeholder table / parameter names and values and it runs.

**Help** in the toolbar opens the help panel: three steps to get started, what the current mode does, a symbol cheat sheet, and **the CLI command for the current settings** (copyable).
The **CLI** button in the toolbar copies that command directly.

![Help panel and the Insert example menu](./screenshots/sp-test-guide-04-recipes.png)

### 6. Everything else

- **Golden / Record golden**: picking the mode adds a "Baseline folder" field (default `<test folder>/golden`).
- **Diff**: picking the mode lets you choose a second connection and database / schema.
- **Export reports**: writes `<test folder>/reports/<timestamp>.junit.xml` and `.md`.
- **Generate scenarios with AI** (when opened from a routine): sends the routine's signature, body, related table DDL and the test-file format to the AI; the JSON in the reply goes into the editor (not saved automatically). Expectations the AI writes still need to be run and checked.

---

## Using the command line (CLI) and CI

### The usual flow

```bash
# 1. Generate a skeleton (-o with a folder = <routine>.json; add --force to overwrite; omit -o to print to stdout)
dbk sp-test init usp_cancel_order --conn mssql-test -d sales -o tests/

# 2. See which scenarios are in there (no connection)
dbk sp-test list tests/

# 3. Run; look at the actual output and fix the expectations (--format json includes every step's full outcomes)
dbk sp-test run tests/ --conn mssql-test -d sales
dbk sp-test run tests/usp_cancel_order.json --conn mssql-test -d sales --only happy_path --format json

# 4. Record a baseline, then compare against it in CI
dbk sp-test run tests/ --conn mssql-test -d sales --mode record --golden golden/
dbk sp-test run tests/ --conn mssql-test -d sales --mode golden --golden golden/ --junit reports/sp.xml --exit-code

# 5. Migration verification: run the same files on SQL Server and PostgreSQL and compare step by step
dbk sp-test diff tests/ --conn mssql-test -d sales --dst pg-test --dst-db public --junit reports/diff.xml --exit-code
```

### Subcommands

| Command | Connection | What it does |
|---|---|---|
| `init <routine>` | yes | Generates a test-file skeleton (same as "New file" in the UI) |
| `list <file or folder>…` | no | Lists the expanded scenarios (including `id/case`), step counts (`2+1` = 2 fixture steps + 1 scenario step), tags and skip reasons |
| `validate <file or folder>…` | no | Checks format and references (undefined fixtures, `expect` together with `expect_error`…) |
| `inspect <routine>` | yes | Signature, write targets, body, `breaks_wrapping` (JSON; the raw material for AI-generated scenarios) |
| `run <file or folder>…` | yes | `--mode assert` (default) / `record` / `golden` |
| `diff <file or folder>…` | two | `--dst` is the second connection (saved connection name / id or a connection string), `--dst-db` its database / schema |

Options for `run` / `diff`:

| Option | Meaning |
|---|---|
| `--only a,b/c` | Run only these; `id` runs the whole scenario, `id/case` only that case (get the names from `list`) |
| `--tag smoke` | Run only scenarios carrying any of these tags |
| `--golden <dir>` | Baseline folder (required for `record` / `golden`) |
| `--junit <path>` | Also write JUnit XML |
| `--exit-code` | Exit non-zero when any scenario does not pass (for CI) |
| `--format json` | Print the full report on stdout (every step's actual output and differences); progress always goes to stderr |
| `--max-rows <n>` | Row cap per result set / snapshot (default 10000, 0 = unlimited) |

Use a connection saved in the app (`--conn`) or give a connection string (`--url`):

```bash
--url "mssql://sa:password@localhost:1433/sales?trustServerCertificate=true"
--url "postgres://ci:password@localhost:5432/sales"      # for PG, -d is the schema
--url "mysql://root:password@localhost:3306/sales"
```

### What a failure looks like

With two expectations in `01_place_order.json` deliberately wrong (a total of 26.00, a stock of 7):

```
file                    | scenario   | verdict | ms  | first_difference
------------------------+------------+---------+-----+---------------------------------------------------------------
broken_place_order.json | happy_path | fail    | 102 | cell @ place: set 0 / row 0 / total: expected 26.00, got 25.00
(1 rows)

# Stored-procedure integration test report

| File | Mode | Targets | Pass | Fail | Error | Skipped |
|---|---|---|---|---|---|---|
| broken_place_order.json | assert | mysql | 0 | 1 | 0 | 0 |

### happy_path — fail

**place** (call)

| Kind | Where | Expected / A | Actual / B | Note |
|---|---|---|---|---|
| cell | set 0 / row 0 / total | 26.00 | 25.00 |  |

**stock_after** (query)

| Kind | Where | Expected / A | Actual / B | Note |
|---|---|---|---|---|
| cell | result / row 0 / stock | 7 | 8 |  |
```

First a table with each scenario's verdict and first difference; when something did not pass, a Markdown report follows that lists every difference step by step.
Steps with an `id` are shown by it (`place`, `stock_after`); without one they show as `#3 call` (position + kind), **counting the fixture steps too**.

### CI

```yaml
# GitHub Actions example: SQL Server as a service container, load schema / routines, run the baseline regression
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

Commit the baseline (`golden/`) together with the test files. When a PR changes a routine, `golden` mode goes red; for a **deliberate** behavior change, re-record with `--mode record` and the baseline diff is reviewed in the same PR.

---

## Scenario cookbook: the 8 examples

All of them live in [`examples/sp-test/`](../examples/sp-test/) and run against the [sample schema](../scripts/dev-sptest/) on all three engines (except 05, see that section).

| # | File | Shows |
|---|---|---|
| 1 | [`01_place_order.json`](../examples/sp-test/01_place_order.json) | Happy path: result set, row-level side effects, `effects_strict`, a multi-step business flow |
| 2 | [`02_error_branches.json`](../examples/sp-test/02_error_branches.json) | Every error branch, no state left behind after an error, the database's own constraint errors |
| 3 | [`03_out_params.json`](../examples/sp-test/03_out_params.json) | OUT parameters: capture, check, reuse in the next step |
| 4 | [`04_data_driven.json`](../examples/sp-test/04_data_driven.json) | `cases`: the same steps with 5 boundary values |
| 5 | [`05_result_set_shapes.json`](../examples/sp-test/05_result_set_shapes.json) | Multiple result sets, ordered compare, count only, ignore |
| 6 | [`06_invariants_and_compare.json`](../examples/sp-test/06_invariants_and_compare.json) | Invariant queries, `?` value-only, `not`, before / after compare of a whole result set |
| 7 | [`07_options_tags_skip.json`](../examples/sp-test/07_options_tags_skip.json) | `defaults` (case, snapshot list, strict), tags, skip |
| 8 | [`08_migration_bug_demo.json`](../examples/sp-test/08_migration_bug_demo.json) | Diff: catching a line that was lost when porting to PostgreSQL |

### 1. Happy path and side effects

**What we want to know**: ordering 2 pens returns the new order; `orders` gets one row with the right content; the pen's stock in `products` goes 10 → 8; **no other table is touched**.

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

Points to note:

- `capture` takes `order_id` from the **first row of the first result set** and stores it as `oid`; later `query` / `call` steps can use it.
- `effects` can be just counts (`{"inserted": 1}`) or row by row; row by row also compares only the listed columns. `before` in `updated` is optional.
- `effects_strict: true`: among the snapshotted tables, **any unlisted table that changed fails the step**. This catches "the routine also changed a table it should not have".
- `place_then_cancel` in the same file is a multi-step flow: place → cancel (`orders.status` NEW → CANCELLED, stock restored) → check the status → a second cancel must fail.

### 2. Error branches

**What we want to know**: every input that should be rejected is rejected, and **nothing is left behind afterwards**.

```json
{"id": "insufficient_stock_leaves_no_trace", "use": ["base"], "steps": [
  {"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 11},
   "expect_error": {"class": "user_raised", "message_contains": "insufficient stock"}},
  {"query": "SELECT stock FROM products WHERE product_id = @pid", "expect": [{"stock": 10}]},
  {"query": "SELECT COUNT(*) AS n FROM orders WHERE customer_id = @cid", "expect": [{"n": 0}]}
]}
```

Points to note:

- `expect_error` compares the **error class** (error numbers / SQLSTATEs of the three engines are already mapped). You can add `code` (the SQL Server / MySQL error number, the PG SQLSTATE) and `message_contains`. Test files that only use `class` can be shared across engines.
- After an error, the default is to go back to the savepoint taken before the call (`on_error: "rollback_to_savepoint"`, like an application that rolls back when it gets an error), so the following `query` sees the state of "no order was placed". To look at what the error left behind, use `"keep"`.
- `insert` steps can use `expect_error` too: the `database_constraints` scenario deliberately inserts rows that break a foreign key and miss a NOT NULL column, checking the database's own constraints (`constraint_violation` / `not_null`).
- Fixtures can be stacked: `"use": ["base", "inactive_customer"]`.
- **An error without `expect_error` makes the scenario `error`**, and the remaining steps are not run.

### 3. OUT parameters

```json
{"call": "usp_adjust_credit", "params": {"CustomerID": "<<cid", "Delta": "12.5", "NewBalance": ">>bal"},
 "expect": {"out": {"NewBalance": "112.50"}}},
{"query": "SELECT credit FROM customers WHERE customer_id = @cid", "expect": [{"credit": "<<bal"}]}
```

- Writing `">>symbol"` for an OUT parameter in `params` captures it; `expect.out` checks its value; afterwards `"<<bal"` / `@bal` can be used.
- Parameter names ignore case, `@`, a `p_` prefix and underscores: in the same file `NewBalance` maps to `p_new_balance` on MySQL and to `INOUT p_new_balance` on PG.
- `two_adjustments`: two calls in one scenario see each other's writes (same transaction).

### 4. Data-driven (cases)

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

- Each case is **its own scenario** (its own transaction, its own report row: `qty_boundaries/zero`); `vars` are symbols.
- A case's `expect_error` applies to the **last `call`** and replaces its `expect`, so cases that error do not need `total` / `left`.
- Run a single case: `--only qty_boundaries/zero`; in the UI, the ↻ on that row.

### 5. Multiple result sets and the ways to compare one

```json
"expect": {"result_sets": [
  {"rows": [{"customer_id": "<<cid", "name": "Ann", "credit": "100.00"}]},
  {"ordered": true, "rows": [{"qty": 1, "total": "12.50"}, {"qty": 2, "total": "25.00"}]}
]}
```

| Form | Meaning |
|---|---|
| `{"rows": [...]}` | Compare only the listed columns, **ignore row order** (columns without `?` form the row key) |
| `{"ordered": true, "rows": [...]}` | Compare in order |
| `{"count": 2}` | Compare the row count only |
| `"ignore"` | Do not check this result set (it still takes its position) |
| `{"rows": []}` | Must be empty |

> A PostgreSQL function returns a single result set; multiple result sets need `SETOF refcursor`, which is not supported yet, so this example runs on SQL Server / MySQL only.
> Also, zero-row result sets on PG / MySQL come without column names, so cross-engine files should not rely on "the N-th result set is empty".

### 6. Invariants and before / after compare

**Invariant**: whatever happens in between, some total must be conserved. This kind of query is the best at catching "changed A, forgot B":

```json
{"id": "invariant",
 "query": "SELECT p.stock + COALESCE(SUM(o.qty), 0) AS units FROM products p LEFT JOIN orders o ON o.product_id = p.product_id AND o.status = 'NEW' WHERE p.product_id = @pid GROUP BY p.stock",
 "expect": [{"units": 10}]}
```

**A trailing `?` on a column** compares the value only, not as part of the row key; **`{"not": …}`** is a negative assertion:

```json
"expect": [{"qty": 2, "total?": "25.00", "status": "CANCELLED"},
           {"qty": 3, "total?": "37.50", "status": {"not": "CANCELLED"}}]
```

**Before / after compare of a whole result set**: `capture: {"*": ">>before"}` stores a whole result set; after a series of actions store it again and `compare` the two. Here: "cancelling an order must restore the product exactly":

```json
{"query": "SELECT product_id, name, price, stock FROM products WHERE product_id = @pid", "expect": [{"stock": 10}], "capture": {"*": ">>before"}},
{"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 4}, "capture": {"order_id": ">>oid"}},
{"call": "usp_cancel_order", "params": {"OrderID": "<<oid"}},
{"query": "SELECT product_id, name, price, stock FROM products WHERE product_id = @pid", "expect": [{"stock": 10}], "capture": {"*": ">>after"}},
{"compare": ["<<before", "<<after"]}
```

### 7. Comparison options, tags, skip

```json
"defaults": {
  "case_insensitive_text": true,
  "snapshot": ["orders", "products", "customers"],
  "effects_strict": true
}
```

- `defaults` applies to the whole file: here `"new"` matches `"NEW"`, only three tables are snapshotted, and every `call` is `effects_strict`.
- `tags`: `--tag smoke` runs only tagged scenarios (`list` shows the tags).
- `skip: "reason"`: not run; the report shows "skipped" with the reason. `usp_commit_inside`, which contains `COMMIT`, is marked this way.
- A scenario does not have to call a routine: `seed_only_check` just uses `sql` + `expect` to check the seed data itself.

### 8. Migration verification: catching a porting bug

After porting SQL Server routines to PostgreSQL, `diff` runs the same test file on both and compares the output step by step.
This example uses `routines` to send the PG side's call to `usp_place_order_bad`, a port that "forgot to decrement stock":

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
08_migration_bug_demo.json | ported_version_forgets_stock | mismatch | 386 | effect @ #3 call: effects / products: expected +0 ~1 -0

### ported_version_forgets_stock — mismatch

**#3 call** (call)

| Kind | Where | Expected / A | Actual / B | Note |
|---|---|---|---|---|
| effect | effects / products | +0 ~1 -0 |  | postgres has no snapshot of this table |

**#4 query** (query)

| Kind | Where | Expected / A | Actual / B | Note |
|---|---|---|---|---|
| cell | set 0 / row 0 / stock | mssql: 8 | postgres: 10 |  |
```

On SQL Server one `products` row was updated (`~1`); on PostgreSQL nothing changed. The broken port never writes `products`, so inspection does not find it and the note says "no snapshot of this table".
The next step checks the stock, 8 on one side and 10 on the other, which points straight at the difference.

A diff needs no expectations; it compares "is the output of the two sides the same":

- Generated-key, `nextval` and timestamp-default (`getdate()` / `now()`…) columns are masked automatically and only compared as "both NULL / both non-NULL"; captured symbols are replaced with `<symbol>` before comparing, so order number 101 on SQL Server and 1000 on PG is not a difference.
- When both sides error, the **error class** is compared, not the message (verdict `both_error`, counts as a pass).
- When table / routine names differ between the two sides, map them with `tables` / `routines` (separate `mssql` / `mysql` / `pg` names are allowed).

---

## Reading the results

### Verdicts

| Verdict | UI | Meaning | Counts as passed? |
|---|---|---|---|
| `pass` | Pass | Every step met its expectation (and the baseline / diff comparison also matched) | ✓ |
| `fail` | Fail | A step's actual output did not match the expectation (or the baseline) | |
| `error` | Error | An error occurred without `expect_error`, or the connection / test file itself has a problem; steps after the error are not run | |
| `seed_error` | Seed failed | The fixture / insert seed data could not be loaded, so the scenario never really started | |
| `skipped` | Skipped | The scenario has `skip` | ✓ |
| `mismatch` | Mismatch | Diff: the two connections produced different output | |
| `error_on_one_side` | Error on one side | Diff: only one side errored | |
| `both_error` | Both errored | Diff: both sides errored with the same error class | ✓ |

`--exit-code` and the red / green in the UI both follow the "counts as passed" column.

### Kinds of differences

| Kind | Meaning |
|---|---|
| `cell` | A value in some row / column differs (the location reads `set 0 / row 0 / total`) |
| `missing_row` / `surplus_row` | An expected row is missing / a row appeared that was not expected |
| `missing_column` | The result set lacks a column the expectation names |
| `count` / `result_set_count` | Row count / number of result sets differs |
| `out` / `return_code` | OUT parameter / return code differs |
| `effect` | Inserted / updated / deleted count or content of a table does not match |
| `effect_strict` | Under `effects_strict`, an unlisted table changed |
| `error_class` / `error_code` / `error_message` | Error class / number / message does not match (including "an error was expected but none occurred") |
| `unexpected_error` | An error occurred without `expect_error` |
| `capture` / `expectation` | Nothing to capture (column missing) / the expectation itself is wrong (references a symbol that does not exist…) |
| `error_one_side` | Diff: only one side errored, or only one side reached this step |
| `golden:…` | Differs from the baseline in golden mode (followed by one of the kinds above) |

---

## Test file reference

`tests/<name>.json`; one file usually covers one routine and can hold several scenarios. Table / routine names **without** a schema are resolved against the connection's database (the schema on PG);
parameter names ignore case, `@`, a `p_` prefix and underscores (`CustomerID` ≈ `p_customer_id`), so the same file runs as is against the PG version.

### Top level

| Key | Meaning |
|---|---|
| `version` | Always `1` |
| `target` | `{"kind": "mssql" \| "postgres" \| "mysql", "database": "…"}` (informational; where it actually runs is decided at run time) |
| `routine` | The main routine under test (optional; used when the UI inserts examples) |
| `fixtures` | `{"name": {"description"?, "steps": [...]}}`; scenarios reference them with `use`, and they expand in order before the scenario's steps |
| `defaults` | Options for the whole file, see below |
| `tables` / `routines` | Cross-engine name mapping: `[{"name": "orders", "pg": "order_header"}]` |
| `scenarios` | The scenarios |

A scenario has `id`, `description`, `tags`, `skip` (`true` or a reason string), `use`, `cases`, `snapshot` (overrides the file setting) and `steps`.

### Steps

| Step | Meaning |
|---|---|
| `insert` | Seed data. Columns whose value is `">>sym"` are not written; the engine fills them and the value is stored as a symbol (identity / default). `identity_insert: true` lets you set the generated column's value. |
| `call` | Call a procedure / function. `params` are matched to the signature by name; OUT parameters can take an initial value or `">>sym"` to capture. `capture` takes values from the first result set (`{"col": ">>sym"}`) or stores the whole result set (`{"*": ">>sym"}`). `on_error`, see below. |
| `query` | Run SQL and assert on the result (`expect` required). `@sym` in the SQL is replaced with the symbol's value. |
| `sql` | Any SQL, `expect` optional. |
| `compare` | Compare two stored result-set symbols: `{"compare": ["<<a", "<<b"]}`. |
| `snapshot` | Change the list of tables later `call`s snapshot. |

Every step can have an `id` (shown in reports) and a `description`; `insert` / `call` / `query` / `sql` can use `expect_error` (instead of `expect`).

Symbols: `">>name"` captures, `"<<name"` references, `"<<name.col"` takes a column of the first row of a result-set symbol, `@name` inside SQL. `vars` in `cases` are symbols too.

### Writing assertions

| To assert | Write |
|---|---|
| Result set (some columns, row order ignored) | `"result_sets": [{"rows": [{"qty": 2, "total": "25.00"}]}]` |
| Result set in order | `{"ordered": true, "rows": [...]}` |
| Value only, not part of the row key | Trailing `?` on the column: `{"id": 1, "amount?": "9.99"}` |
| Empty / ignore / count | `{"rows": []}` · `"ignore"` · `{"count": 3}` |
| OUT parameters / return code | `"out": {"NewBalance": "112.50"}` · `"return_code": 0` |
| Side-effect counts | `"effects": {"orders": {"inserted": 1, "updated": 0}}` |
| Side effects row by row | `"effects": {"orders": {"inserted": [{"qty": 2}]}, "products": {"updated": [{"before": {"stock": 10}, "after": {"stock": 8}}]}}` |
| Unlisted tables must not change | `"effects_strict": true` |
| Expected error | `"expect_error": {"class": "user_raised", "code": 50001, "message_contains": "customer"}` |
| Negation | `{"status": {"not": "CANCELLED"}}` |
| Type tag | `{"type": "datetime", "value": "2024-01-02 03:04:05"}` (`decimal` / `date` / `uuid` / `bytes` (base64) / `json`) |

Error classes: `constraint_violation` / `not_null` / `conversion` / `divide_by_zero` / `user_raised` / `not_found` / `timeout` / `other`; the error numbers / SQLSTATEs of the three engines are already mapped.

### How values are compared

`1.0` = `1`, `12.5` = `12.50`, bit = boolean, each engine's date string format, and JSON key order are all treated as equal. Adjustable in `defaults`:

| Option | Default | Meaning |
|---|---|---|
| `float_rel_tol` / `float_abs_tol` | `1e-9` / `1e-12` | Floating-point tolerance |
| `datetime_tol_ms` | `10` | Date-time tolerance (ms) |
| `ignore_trailing_spaces` | `true` | Ignore trailing spaces (CHAR padding) |
| `case_insensitive_text` | `false` | Case-insensitive text comparison |
| `null_equals_empty` | `false` | Treat NULL and the empty string as equal |
| `zero_date_as_null` | `true` | Treat MySQL's `0000-00-00` as NULL |
| `mask_columns` | `[]` | These columns are only compared as "both NULL / both non-NULL" (`"col"` or `"table.col"`) |
| `ordered` | `false` | Whether result sets compare row order by default |
| `snapshot` | `"auto"` | Which tables to snapshot: `"auto"`, `"none"`, or a list `["orders", "products"]` |
| `effects_strict` | `false` | Whether every `call` is strict by default |
| `on_error` | `"rollback_to_savepoint"` | State after an error: back to before the call, or `"keep"` |
| `max_snapshot_rows` | `50000` | Snapshot row cap per table (beyond it counts are reliable, row-level comparison is incomplete) |
| `lock_timeout_ms` / `statement_timeout_ms` | `5000` / `60000` | Timeouts |

Identity / `nextval` / timestamp-default columns are masked automatically (each engine's generated values are never equal anyway).

### Side-effect snapshots

`snapshot: "auto"` (the default) inspects which tables will be written: SQL Server via `sys.dm_sql_referenced_entities`, PG / MySQL by scanning the routine body,
recursing into called routines and triggers on the tables (≤ 5 levels). Snapshots are taken on the same connection, so they see uncommitted state.
Tables the inspection misses (e.g. written by dynamic SQL) show up in the report as "This table is not in the snapshot list"; list them in `snapshot`, or add a `{"snapshot": [...]}` step to the scenario.

### After an error

When a `call` errors, the after-snapshot is taken first (recording the real partial side effects: with SQL Server `XACT_ABORT OFF`, and on MySQL without a handler, writes made before the error remain),
then `on_error` decides what later steps see: `rollback_to_savepoint` (default) or `keep`. PostgreSQL always goes back to the savepoint (the transaction is aborted).

---

## FAQ

**The scenario says "pass", but I wrote no expectations?**
A `call` without `expect` passes as long as it does not error, which is exactly what the skeleton's `happy_path` starts as. Expand the step, look at the actual output, and click "Use actual" or write `expect` yourself; only then is it really checking anything.

**The order number is different on every run. How do I write the expectation?**
Do not hard-code it. Capture it as a symbol with `capture` and reference it with `"<<oid"`, or simply leave that column out (only listed columns are compared). Generated-key columns are masked automatically in golden / diff comparisons.

**SQL Server does not connect with `--url` (`Timed out in bb8`)?**
Local / test containers usually have self-signed certificates; add `?trustServerCertificate=true` to the connection string.

**The routine contains `COMMIT` / `ROLLBACK`?**
Such routines cannot run inside an outer transaction (they would commit or roll back the outer transaction too). `breaks_wrapping` in `dbk sp-test inspect` flags them and the skeleton skips them automatically. For now you can only skip them or test the routines they call.

**The report says "This table is not in the snapshot list"?**
Automatic inspection did not find that this table is written (common with dynamic SQL). List it in `defaults.snapshot`, or add `{"snapshot": ["that_table"]}` before the `call`.

**Can I run it against production?**
Yes, but only in the default wrapped mode (transaction + rollback). It does take row locks, so a test database or a restored copy is still the better target.

**Why are decimals written as strings in the test files?**
JSON reads `25.00` as `25`; `"25.00"` keeps it as written. The comparison treats `"25.00"` and `25` as equal anyway, but strings make the report easier to read.

---

## Limitations

- Routines with `COMMIT` / `ROLLBACK` (and, on MySQL, DDL that commits implicitly) cannot run inside a transaction; an isolated mode (no wrapping transaction, cleanup afterwards) is planned.
- A PostgreSQL function returns a single result set; routines with several result sets need `SETOF refcursor` (planned).
- Zero-row result sets on PostgreSQL / MySQL come without column names; empty vs. empty counts as equal.
- Symbol substitution replaces literal values, it is not a bind.
- "Use actual" writes only side-effect **counts**; for row-level checks expand them to `[{...}]` yourself.

## Integration tests vs. performance tests

| | Integration tests (this feature) | Performance tests (stress test) |
|---|---|---|
| Goal | Correct behavior: results, side effects, errors | Latency / throughput / error rate |
| Execution | Once per scenario, wrapped in a rolled-back transaction | N times, multi-threaded, for D seconds |
| Data | Precise seed | Realistic volume, spread over a parameter pool |
| Verdict | Deterministic (with tolerances) | Statistical: p95 ≤ threshold, ≤ baseline × 1.2 |
| In a migration | "Was it ported correctly?" (`diff`) | "Is it slower after the port?" |

## Development / integration tests

```bash
docker compose -f scripts/dev-sptest/docker-compose.yml up -d
cargo test --lib sptest::it_sptest -- --ignored --test-threads=1   # engine, examples and skeletons, end to end on all three engines
npm run verify:ui -- sp-test-dialog sp-test-from-routine           # UI (fake backend, no database needed)
```
