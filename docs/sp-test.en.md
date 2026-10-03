# Stored Procedure Integration Testing (sp-test)

[繁體中文](./sp-test.md) · **English**

**Integration tests** for stored procedures with side effects, run against a real database with real data. One scenario = one business flow (place order → check stock → cancel → check again),
executed inside a single transaction that is rolled back automatically. The affected tables are snapshotted automatically before and after each call, and result sets / OUT parameters / side effects / error classes are compared.

Four modes share the same test file:

| Mode | What it does | Use |
|---|---|---|
| `assert` | Compares against the expectations written in the test file | Day-to-day |
| `record` | Records the actual output of every step as a baseline (`golden/`) | Create / update the baseline |
| `golden` | Compares against the expectations **and** the baseline | CI regression: changing an SP turns it red |
| `diff` | Runs the same test file once on each of two connections and compares them step by step | Migration verification (SQL Server / MySQL → PostgreSQL) |

Supported engines: SQL Server, PostgreSQL, MySQL / MariaDB.

## Test files

`tests/<name>.json`. One file usually corresponds to one stored procedure and can contain multiple scenarios. Table / procedure names written **without** a schema are resolved against the connection's
database (the schema, for PG). Parameter names ignore case, `@`, the `p_` prefix and underscores (`CustomerID` ≈ `p_customer_id`),
so the same file can be run as-is against the PG version.

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

### Steps

| step | Description |
|---|---|
| `insert` | Loads seed data. Columns whose value is `">>sym"` are not written; the engine fills them in and the value is stored as a symbol (identity / default). `identity_insert: true` lets you supply values for auto-generated columns. |
| `call` | Calls a procedure / function. `params` are matched to the signature by name; OUT parameters can be given an initial value, or written as `">>sym"` to capture them. `capture` takes values from the first result set (`{"col": ">>sym"}`) or stores the entire result set (`{"*": ">>sym"}`). |
| `query` | Runs SQL and asserts on the result (`expect` is required). `@sym` in the SQL is substituted with the symbol's value. |
| `sql` | Arbitrary SQL; `expect` is optional. |
| `compare` | Compares two stored result-set symbols: `{"compare": ["<<a", "<<b"]}`. |
| `snapshot` | Changes the list of tables that subsequent `call` steps snapshot. |

Symbols: `">>name"` captures, `"<<name"` references, `"<<name.col"` takes a column from the first row of a result set, and `@name` is used inside SQL.
The `vars` of `cases` are symbols too; `fixtures` + `use` share setup steps; `tags` filter; `skip: "reason"` skips.

### Assertions

| To assert | How to write it |
|---|---|
| Result set (subset of columns, row order ignored) | `"result_sets": [{"rows": [{"qty": 2, "total": "25.00"}]}]` — only the listed columns are compared; columns not marked with `?` serve as the key for matching rows; reports "value mismatch / extra row / missing row" |
| Ordered result set | `{"ordered": true, "rows": [...]}` |
| Compare a value without using it as a key | Append `?` to the column name: `{"id": 1, "amount?": "9.99"}` |
| Empty set / ignore / count | `{"rows": []}` · `"ignore"` · `{"count": 3}` |
| OUT parameters / return code | `"out": {"NewBalance": "112.50"}`, `"return_code": 0` |
| Side-effect counts | `"effects": {"orders": {"inserted": 1, "updated": 0}}` |
| Side effects row by row | `"effects": {"orders": {"inserted": [{"qty": 2}]}, "products": {"updated": [{"before": {"stock": 10}, "after": {"product_id": "<<pid", "stock": 8}}]}}` |
| Tables not listed must not change | `"effects_strict": true` |
| Expected error | `"expect_error": {"class": "user_raised", "code": 50001, "message_contains": "customer"}` |
| Negation | `{"status": {"not": "CANCELLED"}}` |
| Type tags | `{"type": "datetime", "value": "2024-01-02 03:04:05"}` (`decimal` / `date` / `uuid` / `bytes` (base64) / `json`) |

Error classes: `constraint_violation` / `not_null` / `conversion` / `divide_by_zero` / `user_raised` / `not_found` / `timeout` / `other`.
The error numbers / SQLSTATEs of all three engines are already mapped to them; in `diff` mode, when "both sides fail", the classes are compared rather than the messages.

Value comparison: `1.0` = `1`, `12.5` = `12.50`, bit = boolean, each vendor's date string formats, and JSON key order are all handled. Tolerances live in `defaults`:
`float_rel_tol` (1e-9), `datetime_tol_ms` (10), `ignore_trailing_spaces` (true), `case_insensitive_text` (false),
`zero_date_as_null` (true), `mask_columns`. Columns with identity / `nextval` / time defaults (`getdate()` / `now()`…) are masked automatically —
only "both NULL / both non-NULL" is compared, since auto-generated values from different engines would never be equal anyway.

### Side-effect snapshots

`defaults.snapshot`: `"auto"` (the default; inspects the procedure body and `sys.dm_sql_referenced_entities` to find the tables it writes, including called procedures and triggers),
`"none"`, or an explicit list `["orders", "products"]`. Snapshots are taken on the same connection, so they see uncommitted state.

### After an error

When a `call` fails, the after-snapshot is taken first (recording the real partial side effects — with SQL Server `XACT_ABORT OFF`, or MySQL without a handler, writes made before the error remain),
then `on_error` decides what state later steps see: `rollback_to_savepoint` (the default; simulates the application rolling back as soon as it receives the error) or `keep`.
PostgreSQL always returns to the savepoint (the transaction is already aborted). If an error occurs without an `expect_error` → the scenario is marked `error` and the remaining steps are not run.

### Limitations

- Procedures that contain `COMMIT` / `ROLLBACK` (and, on MySQL, implicit commits caused by DDL) cannot be wrapped in a transaction; `breaks_wrapping` in `dbk sp-test inspect` flags them.
- PostgreSQL functions have only one result set; procedures with multiple result sets need to switch to `SETOF refcursor` (supported in a later version).
- Zero-row result sets don't expose column names on PostgreSQL / MySQL; empty vs. empty is treated as equal.
- Symbol substitution is literal text replacement, not parameter binding.

## CLI

```
dbk sp-test validate tests/
dbk sp-test inspect dbo.usp_place_order --conn mssql-test -d sales            # signature, write targets, body (JSON)
dbk sp-test run tests/ --conn mssql-test -d sales                              # assert
dbk sp-test run tests/ --conn mssql-test -d sales --mode record --golden golden/
dbk sp-test run tests/ --conn mssql-test -d sales --mode golden --golden golden/ --junit reports/mssql.xml --exit-code
dbk sp-test diff tests/ --conn mssql-test -d sales --dst pg-test --dst-db public --junit reports/diff.xml --exit-code
```

`--only a,b` runs only the given scenarios, `--tag smoke` filters by tag, `--format json` outputs the full report, and `--exit-code` makes any scenario that doesn't pass return a non-zero exit code.
`--conn` can be replaced with `--url "mssql://sa:…@host:1433/sales"`.

### CI

```yaml
steps:
  - sqlcmd -i schema/*.sql -i procs/*.sql
  - dbk sp-test run tests/ --url "mssql://sa:$MSSQL_PASS@localhost:1433/sales" --mode golden --golden golden/ --junit reports/mssql.xml --exit-code
  - dbk sp-test diff tests/ --url "mssql://…/sales" --dst "postgres://ci:$PG_PASS@localhost:5432/sales" --dst-db public --junit reports/diff.xml --exit-code
  - upload reports/*.xml
```

Baselines (`golden/`) go into git together with the test files. A PR that changes an SP turns red in `golden` mode; for intentional behavior changes, update the baseline with `--mode record` and commit it alongside (the diff is reviewable).

## Integration testing vs performance testing

| | Integration testing (this feature) | Performance testing (load testing) |
|---|---|---|
| Purpose | Correct behavior: results, side effects, errors | Latency / throughput / error rate |
| Execution | Once per scenario, wrapped in a transaction and rolled back | N times, multi-threaded, sustained for D seconds |
| Data | Precise seed data | Realistic scale, spread-out parameter pool |
| Verdict | Deterministic (with tolerances) | Statistical: p95 ≤ threshold, ≤ baseline × 1.2 |
| In a migration | "Was it converted correctly?" (`diff`) | "Is it slower after conversion?" |

## Development / integration tests

```
docker compose -f scripts/dev-sptest/docker-compose.yml up -d
cargo test --lib sptest::it_sptest -- --ignored --test-threads=1
```
