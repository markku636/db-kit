# sp-test examples / 預存程序整合測試範例

Runnable test files for the sample schema in [`scripts/dev-sptest/`](../../scripts/dev-sptest/) (SQL Server, PostgreSQL and MySQL share the same tables and routines).
Each file is explained in the guide: [English](../../docs/sp-test.en.md#scenario-cookbook-the-8-examples) · [繁體中文](../../docs/sp-test.md#情境食譜8-個範例逐一說明).

對 [`scripts/dev-sptest/`](../../scripts/dev-sptest/) 樣本 schema 可直接執行的測試檔（三個引擎同一組表與程序），逐份說明見使用指南。

| File | Shows |
|---|---|
| `01_place_order.json` | Happy path, row-level side effects, `effects_strict`, a multi-step flow |
| `02_error_branches.json` | Every error branch, no state left after an error, database constraint errors |
| `03_out_params.json` | OUT parameters: capture, check, reuse |
| `04_data_driven.json` | `cases` with boundary values |
| `05_result_set_shapes.json` | Multiple result sets, ordered / count / ignore (SQL Server and MySQL only) |
| `06_invariants_and_compare.json` | Invariant query, `?` value-only, `not`, before / after `compare` |
| `07_options_tags_skip.json` | `defaults`, tags, `skip` |
| `08_migration_bug_demo.json` | `diff` catching a bug in a PostgreSQL port (expected to report a mismatch) |

```bash
docker compose -f scripts/dev-sptest/docker-compose.yml up -d
# load scripts/dev-sptest/<engine>/schema.sql and routines.sql, then:
dbk sp-test run examples/sp-test --url "mysql://root:test1234@127.0.0.1:13307/sptest" -d sptest
```

`cargo test --lib sptest::it_sptest -- --ignored --test-threads=1` creates the sample databases itself and runs every file here on all three engines
(`examples_pass_on_every_engine`, `examples_diff_across_engines`).
