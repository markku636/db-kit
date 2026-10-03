# `dbk` CLI: Complete Guide

[繁體中文](./cli.md) · **English**

`dbk` is db-kit's command-line tool. It **reuses the desktop app's core layer directly** (connection management / keychain / export / backup / encryption / stress testing) without going through Tauri, so it can be built as a lean binary with no GUI that you can use right after SSHing into a server.

Good fits: scheduled jobs, CI, data audits, troubleshooting, feeding query results into a pipeline. Poor fits: anything that needs an ER diagram, a visual execution plan, or cell-by-cell data editing; open the GUI for those.

---

## Contents

- [Getting dbk](#getting-dbk)
- [Three ways to specify a connection](#three-ways-to-specify-a-connection)
- [Global flags](#global-flags)
- [Safety model: read-only by default, `--yes`, `--force`](#safety-model-read-only-by-default---yes---force)
- [Output formats](#output-formats)
- [Command reference](#command-reference)
  - [`conn` — connection management](#conn--connection-management)
  - [`db` — databases / schemas](#db--databases--schemas)
  - [`table` — tables](#table--tables)
  - [`query` / `exec` / `explain`](#query--exec--explain)
  - [`stress` — stress testing](#stress--stress-testing)
  - [`export` / `schema-dump` / `backup`](#export--schema-dump--backup)
  - [`search` / `column-stats` / `routine` / `er-model` / `server-info`](#search--column-stats--routine--er-model--server-info)
  - [`compare` / `schema` — schema / data compare and snapshots](#compare--schema--schema--data-compare-and-snapshots)
  - [`run` — Review & Run SQL scripts](#run--review--run-sql-scripts)
  - [`redis` — Redis operations](#redis--redis-operations)
  - [`mcp` — MCP server (for AI clients)](#mcp--mcp-server-for-ai-clients)
  - [`ai` — AI library (personas / skills / prompt templates)](#ai--ai-library-personas--skills--prompt-templates)
  - [`diff` / `sync` — file / folder compare and sync](#diff--sync--file--folder-compare-and-sync)
- [Common scenarios](#common-scenarios)
- [Exit codes and error handling](#exit-codes-and-error-handling)
- [Limitations](#limitations)

---

## Getting dbk

The desktop installer **does not include** `dbk`; you need to build it yourself:

```bash
# Lean build (no GUI / Tauri, smallest size, suited to servers)
cargo build --release --no-default-features --bin dbk
# Output: src-tauri/target/release/dbk (dbk.exe on Windows)
```

Elasticsearch / RabbitMQ / Kafka connections are GUI-only; the CLI does not support them (see [Limitations](#limitations)).

Oracle connections require a separately installed 64-bit Oracle Instant Client (detected at runtime via `PATH` / `ORACLE_HOME`).

```bash
dbk --help          # full list of subcommands
dbk stress --help   # flag reference for a single subcommand
dbk --version
```

---

## Three ways to specify a connection

### 1. Reuse a connection saved in the GUI (recommended)

```bash
dbk --conn prod-mysql db list
```

`--conn` takes a **connection name or id** and reads the GUI's `connections.json` plus the password stored in the OS keychain, so the password never appears in the command, a script, or your shell history. Run `dbk conn list` first to see what is available.

### 2. Connection string

```bash
dbk --url "mysql://app:secret@10.0.0.5:3306/shop" table list
dbk --url "postgres://user@host/db?sslmode=require" db list
dbk --url "oracle://user:pass@host:1521/SERVICE" table list
dbk --url "/var/data/local.sqlite" table list          # for SQLite, just give the file path
```

This shares the same parser (`conn_url.rs`) as the GUI's "Import from connection string", and supports `mysql://` `postgres://` `mongodb+srv://` `rediss://` `sqlserver://` `oracle://` as well as the Azure ADO.NET format.

### 3. Individual flags

```bash
DBKIT_PASSWORD=secret dbk --kind mysql --host 10.0.0.5 --port 3306 --user app -d shop table list
```

`--kind` can be `mysql` / `mariadb` / `postgres` / `sqlite` / `mongo` / `redis` / `mssql` / `oracle`.

> **Pass the password through the `DBKIT_PASSWORD` environment variable, not `--password`.** Anything on the command line ends up in your shell history, and on a shared machine it is also visible through `ps`.

---

## Global flags

These flags can go either before or after the subcommand.

| Flag | Description |
|---|---|
| `--conn <name\|id>` | Use a connection saved in the GUI |
| `--url <DSN>` | Connection string |
| `--kind` `--host` `--port` `--user` `--password` | Specify an ad-hoc connection field by field |
| `-d, --database <name>` | Default database / schema (file path for SQLite, DB index for Redis) |
| `--format table\|csv\|json` | Output format, default `table` |
| `--lang zh-TW\|zh-CN\|en\|ja\|ko\|vi` | Language for messages and `--help` (also settable via `DBKIT_LANG`; defaults to the GUI's setting) |
| `-y, --yes` | Confirm execution of a write command |
| `--force` | Additional confirmation for highly destructive actions; must be combined with `--yes` |

Environment variables: `DBKIT_PASSWORD` (password), `DBKIT_LANG` (language).

---

## Safety model: read-only by default, `--yes`, `--force`

This is the first thing to understand about `dbk`.

**Layer 1 — read-only guard.** `query`, `explain` and `stress` only allow query statements (`select` / `with` / `show` / `describe` / `explain` / `pragma` / `use` / `values` / `table`). Any detected write statement is blocked outright with a non-zero exit code. The check splits the input on `;` and looks at the first meaningful keyword of each statement, skipping comments, and it also detects PostgreSQL writable CTEs (`WITH x AS (DELETE …)`).

```bash
$ dbk --conn prod query "delete from sessions"
error: Query failed: The CLI is read-only; only query statements are allowed (detected `delete`)
```

**Layer 2 — writes require `--yes`.** To change data, use `exec` (or a write subcommand such as `table drop` / `redis set`). Without `--yes` it **does not execute**; it only prints what it would do and returns a non-zero exit code, which amounts to a built-in dry run.

```bash
$ dbk --conn prod exec "update users set status='active' where id=42"
error: This is a write command and was not executed: Execute: update users set status='active' where id=42. Add --yes once you have checked it
```

**Layer 3 — highly destructive actions require `--yes --force`.** This covers `DROP` / `TRUNCATE` / `FLUSHDB` / **`UPDATE`·`DELETE` without a `WHERE`**. The WHERE check first strips comments, strings and parentheses and only counts a top-level WHERE, so commenting the condition out (`DELETE FROM t -- WHERE id=1`) or having the condition only inside a subquery still counts as highly destructive.

```bash
$ dbk --conn prod exec "delete from sessions" --yes
error: This is a highly destructive action and was not executed: Execute: delete from sessions. Add --force as well to confirm
```

**Layer 4 (optional) — keep a rollback.** For production migration scripts, use `run` instead: it likewise requires `--yes` / `--force`, and in addition captures a before-image for each statement and writes a rollback script into the `--out` directory. Statements without a complete rollback additionally require `--allow-incomplete`, and production connections additionally require `--allow-prod`. See [`run` — Review & Run SQL scripts](#run--review--run-sql-scripts).

> We recommend pairing this with a **read-only database account** as a second line of defense. The CLI's guard protects against slips, not against malice.

---

## Output formats

```bash
dbk --conn prod --format table query "select id, name from users limit 3"   # default, aligned ASCII table
dbk --conn prod --format csv   query "select id, name from users limit 3"   # for pipelines / Excel
dbk --conn prod --format json  query "select id, name from users limit 3"   # for jq
```

`table` is for humans; `csv` / `json` are for programs. Progress and warnings always go to **stderr** and data goes to **stdout**, so `> out.json` stays clean.

```bash
dbk --conn prod --format json query "select * from orders limit 100" | jq '.[].status' | sort | uniq -c
```

---

## Command reference

### `conn` — connection management

```bash
dbk conn list                                   # list connections saved in the GUI (without passwords)
dbk --conn prod conn test                       # test the connection without keeping it open
dbk --conn prod conn ping                       # measure round-trip latency (including SSH tunnel)
dbk conn export conns.enc --passphrase "…"      # encrypted export of all connections (with passwords; PROD connections never include credentials)
```

### `db` — databases / schemas

```bash
dbk --conn prod db list
dbk --conn prod db create staging --yes
dbk --conn prod db drop staging --yes --force   # drops all objects inside as well; irreversible
```

On PostgreSQL, `db create` / `db drop` operate on **schemas**.

### `table` — tables

```bash
dbk --conn prod -d shop table list
dbk --conn prod -d shop table columns orders
dbk --conn prod -d shop table info orders          # row count / size / engine and other stats
dbk --conn prod -d shop table ddl orders           # CREATE TABLE DDL
dbk --conn prod -d shop table indexes orders
dbk --conn prod -d shop table foreign-keys orders
```

Read data page by page, with multi-column filtering and sorting:

```bash
dbk --conn prod -d shop table data orders \
    --page 0 --page-size 50 \
    --filter "status:=:paid" \
    --filter "total:>:1000" \
    --sort "created_at:desc"

# Multiple filters are ANDed by default; add --match-any to OR them
dbk --conn prod -d shop table data orders --filter "status:=:paid" --filter "status:=:shipped" --match-any
```

The filter syntax is `column:operator[:value]`. Operators are `=` `!=` `>` `>=` `<` `<=` `like` `is_null` `is_not_null` (the last two take no value). Sorting is `column:asc|desc`.

Destructive operations:

```bash
dbk --conn prod -d shop table truncate audit_log --yes --force
dbk --conn prod -d shop table drop tmp_import --yes --force
```

### `query` / `exec` / `explain`

```bash
# Read-only queries
dbk --conn prod query "select id, name from users limit 20"
dbk --conn prod query "select * from big_table" --max-rows 0     # 0 = unlimited, fetch the full result
dbk --conn prod query "select * from big_table" --max-rows 50000

# Writes (including DDL)
dbk --conn prod exec "update users set status='active' where id=42" --yes
dbk --conn prod exec "create index idx_orders_status on orders(status)" --yes

# Execution plan
dbk --conn prod explain "select * from orders where status='paid'"
```

By default `query` uses the global row limit (1,000 rows) and prints a notice on stderr when the result is truncated. `exec` skips the read-only guard (that is exactly what `query` is for) and is instead gated by the two-step `--yes` / `--force` confirmation.

### `stress` — stress testing

Runs the same query repeatedly across multiple threads and measures TPS and the latency distribution. It is **the same core** (`stress.rs`) as the GUI's stress test.

```bash
# Fixed iterations: 4 threads × 100 runs per thread (the default)
dbk --conn prod stress "SELECT COUNT(*) FROM orders"

# Duration + ramp-up: 8 threads for a full 30 seconds, phased in over the first 5 seconds
dbk --conn prod stress "SELECT * FROM orders WHERE status='paid' LIMIT 100" \
    --threads 8 --seconds 30 --ramp 5 --warmup 20

# Export the report as JSON (progress goes to stderr, so it stays clean)
dbk --conn prod --format json stress "SELECT 1" --threads 16 --seconds 60 > bench.json
```

| Flag | Default | Description |
|---|---|---|
| `--threads <n>` | 4 | Concurrent threads, up to 64 |
| `--iterations <n>` | 100 | Iterations per thread. Mutually exclusive with `--seconds` |
| `--seconds <n>` | — | Run by duration instead, for a full N seconds (**including** warm-up and ramp-up) |
| `--ramp <n>` | 0 | Seconds over which threads are phased in; only meaningful in `--seconds` mode |
| `--warmup <n>` | 0 | Warm-up runs per thread, excluded from the statistics |
| `--delay-ms <n>` | 0 | Delay between iterations |
| `--max-rows <n>` | 1000 | Row fetch limit per query; `0` = fetch everything |
| `--timeout-ms <n>` | 30000 | Per-query timeout; `0` = no timeout |

**Output**: the `table` / `csv` formats give a two-column table of key metrics plus a table of grouped errors; `json` gives the full report, including a per-second `series` (which you can chart).

```
Mode              | iterations      TPS   | 2777.8      p50 | 1.2
Threads           | 4               Avg   | 1.4         p90 | 1.4
Completed queries | 100             Min   | 0.8         p95 | 1.5
Errors            | 0               Max   | 7.2         p99 | 7.1
```

**How to read it**: look at the **shape** of the percentiles rather than any single number. A `p99` far above `p50` points to queuing or lock contention; a flat but high distribution means each query is simply expensive; a maximum far beyond `p99` indicates sporadic events (checkpoints / GC / network retries).

**Notes**:

- The CLI's `stress` is **always read-only**; there is no `--allow-writes`. To stress-test writes, open the GUI and explicitly turn on the danger switch.
- The stress test opens a **dedicated connection** with `max_connections = --threads` and releases it when done. So `--threads 64` means 64 connections against the target; first make sure the server's `max_connections` can handle it.
- Warm-up exists to get connections and the plan cache warm. Without it, the tens of milliseconds spent on the first connection all land in p99.
- `--seconds` is **the total time budget measured from the start of the test**; warm-up and ramp-up are both included.

### `export` / `schema-dump` / `backup`

```bash
# Export a single table (--data-format: csv | tsv | xlsx | json | sql | markdown)
dbk --conn prod -d shop export orders --to orders.csv --data-format csv --bom
dbk --conn prod -d shop export orders --to orders.xlsx --data-format xlsx
dbk --conn prod -d shop export orders --to orders.sql --data-format sql

# Filter / sort before exporting (same syntax as table data)
dbk --conn prod -d shop export orders --to paid.csv \
    --filter "status:=:paid" --sort "created_at:desc"

# CSV details
dbk --conn prod -d shop export orders --to o.tsv --data-format tsv --delimiter $'\t' \
    --null-text "NULL" --no-header

# Schema SQL for the whole database (CREATE statements for every table)
dbk --conn prod -d shop schema-dump > schema.sql

# Backup
dbk --conn prod backup shop --to shop.dump
```

`--bom` writes a UTF-8 BOM at the start of the file so Excel does not garble CSVs containing CJK text.

**`backup` uses a different mechanism per database kind**, and **there is no built-in fallback path**: if the required tool cannot be found it fails outright instead of silently switching to another method:

| Kind | Mechanism | Prerequisite |
|---|---|---|
| SQLite | Copies the database file directly | None |
| MySQL / MariaDB | `mysqldump` | Must be on `PATH` |
| PostgreSQL | `pg_dump` | Must be on `PATH` |
| MongoDB | `mongodump` | Must be on `PATH` |
| Redis | `redis-cli --rdb` | Must be on `PATH` |
| SQL Server / Oracle | Not yet supported | — |

To keep a copy of the data on a machine without the official tools, use `export --data-format sql` instead (fully built in, no external tools needed, but it only exports data, not the complete schema and indexes). `dbk` does not do restores; that is a destructive operation, so use the GUI or each database's native tools.

### `search` / `column-stats` / `routine` / `er-model` / `server-info`

```bash
# Find objects across databases (names / definition bodies / comments)
dbk --conn prod search "order_status"
dbk --conn prod search "TODO" --definitions --limit 50
dbk --conn prod search "usr" --whole-word                # match whole words only
dbk --conn prod search "tmp_*" --wildcards               # enable * and ?
dbk --conn prod search "audit" --databases shop --databases shop_archive --type table --type view

# Column profiling: total / non-null / distinct values / range
dbk --conn prod -d shop column-stats orders status

# Stored procedures / functions / triggers
dbk --conn prod -d shop routine list
dbk --conn prod -d shop routine def sp_close_order --type procedure

# ER model (tables + foreign key relationships) and server info
dbk --conn prod -d shop --format json er-model > er.json
dbk --conn prod server-info
```

When none of the three match scopes (`--names` / `--definitions` / `--comments`) is given, only names are matched by default.

### `compare` / `schema` — schema / data compare and snapshots

This shares the same Rust engine as the GUI's Schema compare (`compare data` is CLI-only; the GUI only does schema. For step-by-step GUI instructions see the **[Schema compare guide](./compare.en.md)**). The source is specified with the global connection flags and the target with `--dst` (a saved connection name / id, a connection string, or a `.json` snapshot file). Differences are always computed **relative to the source**: the generated sync SQL "makes the target match the source". Supports MySQL / MariaDB / PostgreSQL / SQLite / SQL Server / Oracle.

```bash
# Schema snapshot: save the database's table / view / procedure definitions as JSON, to compare later against the live schema or another snapshot
dbk --conn prod -d shop schema snapshot --to shop-2026-09.json
dbk schema show shop-2026-09.json

# Schema compare: tables / columns (type / nullability / default / comment) / indexes / foreign keys / views / procedures
dbk --conn staging -d shop compare schema --dst prod
dbk --conn staging -d shop compare schema --dst prod --format json > diff.json
dbk --conn staging -d shop compare schema --dst shop-2026-09.json --exit-code   # CI: non-zero when there are differences
dbk --conn staging -d shop compare schema --dst prod --sync                     # print sync DDL (no DROP)
dbk --conn staging -d shop compare schema --dst prod --sync --include-drops     # include DROP TABLE / COLUMN
dbk --conn staging -d shop compare schema --dst prod --sync --apply --yes       # execute directly on the target

# Data compare: streamed comparison by primary key (no row limit); a single table or --all for the whole database
dbk --conn staging -d shop compare data orders --dst prod
dbk --conn staging -d shop compare data orders --dst prod --sql > sync.sql      # print INSERT / UPDATE (/ DELETE)
dbk --conn staging -d shop compare data --all --dst prod --precheck             # skip tables whose row count / primary key range match
dbk --conn staging -d shop compare data orders --dst prod --apply --yes         # apply to the target in batched transactions
dbk --conn staging -d shop compare data orders --dst prod --apply --include-deletes --yes --force
```

- Without `--yes`, `--apply` only prints a summary of the differences (equivalent to a dry run) and returns non-zero. If the `--sync --apply` script contains highly destructive DDL (DROP / type change / NOT NULL change), or with `compare data --apply --include-deletes`, `--force` is also required.
- **On PostgreSQL, `-d` / `--src-db` / `--dst-db` are schemas, not databases.** PG is the only engine where the "namespace" and the "database you connect to" are separate axes: the database to connect to goes in the connection string (`postgres://…/testdb`) or the saved connection, and the flags only specify the schema. So it is `--dst "postgres://…/testdb" --dst-db public`, not `public` stuffed into the connection string. On every other engine the two are synonymous, and the flag also serves as the connection's default database (MySQL view / procedure DDL is not qualified with a database name, so sync relies on it).
- When the primary key collation differs between the two sides in a data compare (e.g. MySQL `_ci` vs PostgreSQL), it automatically switches to hash comparison (`--strategy auto`). The result is just as exact, at the cost of a bit more memory. When a scan is truncated by `--max-rows`, **no** DELETE statements are emitted.
- When the target connection is marked as production (`options.prod`), `--apply` is blocked; add `--allow-prod` if you are sure you want to apply.
- Changes an engine cannot express (a type change on SQLite, a default value change on SQL Server) are listed in the `skipped` section rather than silently dropped.

### `run` — Review & Run SQL scripts

For each statement it goes "capture before-image → write rollback script → execute → capture after-image", and writes the script, the AI review, the rollback script, the before/after snapshots and a diff report into a new subdirectory under `--out`. Without `--yes` it stops after producing the review and backups (no execution), consistent with the dry-run semantics of the other write commands.

```bash
# Dry run: analysis + before-image + rollback script, no execution
dbk --conn prod-mysql -d shop run migrate.sql --out D:/db-backups

# External AI review: the prompt is fed on stdin and stdout is saved as review.md; if the AI says STOP, only backups are produced
dbk --conn prod-mysql -d shop run migrate.sql --out D:/db-backups --review-cmd "claude -p"

# Execute (add --force for DROP / TRUNCATE / writes without WHERE; add --allow-prod for production connections)
dbk --conn prod-mysql -d shop run migrate.sql --out D:/db-backups --yes

# Only print the review prompt, to pipe into any AI tool
dbk --conn prod-mysql -d shop run migrate.sql --out D:/db-backups --print-prompt > prompt.md

# Read the script from stdin; to restore, run rollback.sql the same way (the current state is backed up before restoring)
cat migrate.sql | dbk --conn prod-mysql -d shop run - --out D:/db-backups --yes
dbk --conn prod-mysql -d shop run D:/db-backups/20260916-210000_prod-mysql_shop/rollback.sql --out D:/db-backups --yes
```

| Flag | Description |
|---|---|
| `--out`, `-o` | Output directory (required; each run creates a `time_connection_database` subdirectory) |
| `--review-cmd <CMD>` | AI review command (run via `cmd /C` on Windows, `sh -c` elsewhere); the prompt = DBA persona + task, fed on stdin |
| `--persona <NAME,…>` | DBA review persona(s) (names from `agents/` in the AI library); comma-separate several for a panel review, where the review command runs once per persona and the strictest verdict wins. When omitted, the default from `ai-library.json` is used depending on whether the connection is production |
| `--ignore-verdict` | Execute even if the AI verdict is STOP |
| `--review-samples <N>` | Number of before-image sample rows attached for the AI (default 0, no data sent) |
| `--print-prompt` | Print the review prompt and exit |
| `--max-capture-rows <N>` | Before-image capture limit per statement (default 10,000) |
| `--allow-incomplete` | Execute even if some statements lack a complete rollback |
| `--allow-prod` | Required when the connection is marked as production |

Scripts containing `BEGIN` / `COMMIT`, `USE` / `SET`, a non-PostgreSQL procedure body, or `DROP DATABASE` are rejected as a whole, and not a single statement is executed. stderr shows the per-statement analysis and progress; stdout shows each statement's status / affected rows / rollback level / diff summary (with `--format json`, the directory path + the full manifest). For rollback levels, how each statement is backed up, and how values are restored on each database (and the limitations), see the **[Review & Run guide](./review-run.en.md)**.

### `redis` — Redis operations

Reads:

```bash
dbk --conn cache redis keys --pattern "session:*" --limit 500
dbk --conn cache redis key session:42
dbk --conn cache redis slowlog --count 20
dbk --conn cache redis clients
dbk --conn cache redis big-keys --sample 200 --top 30      # sampling + MEMORY USAGE
```

Writes (all require `--yes`):

```bash
dbk --conn cache redis set session:42 '{"uid":42}' --ttl 3600 --yes
dbk --conn cache redis expire session:42 600 --yes
dbk --conn cache redis persist session:42 --yes            # remove the TTL; never expires
dbk --conn cache redis rename session:42 session:42:old --yes
dbk --conn cache redis del session:42:old --yes
```

Highly destructive (require `--yes --force`):

```bash
dbk --conn cache redis del-prefix "session:" --yes --force --limit 50000
dbk --conn cache redis flush-db --yes --force
```

> `del-prefix` does **not** hand the prefix to Redis as a pattern. It first runs `SCAN MATCH <prefix>*` to collect the actual key names (up to `--limit`, default 10,000) and then `DEL`s them in batches; the confirmation message tells you up front how many keys will be deleted. This way wildcards such as `*` and `?` are never accidentally interpreted as a pattern.

Use `-d` to pick the DB index: `dbk --conn cache -d 3 redis keys`.

### `mcp` — MCP server (for AI clients)

Starts in [Model Context Protocol](https://modelcontextprotocol.io) stdio mode and exposes a set of **read-only** database tools to Claude Code, Codex, or any MCP-capable AI client.

```bash
dbk --conn shop -d shop mcp
```

It is not meant to be run directly by a person: stdout carries only the protocol (one JSON-RPC 2.0 message per line), and diagnostics always go to stderr. The client launches it as a child process:

```bash
# Claude Code
claude mcp add dbkit -- dbk --conn shop -d shop mcp
```

```jsonc
// or put it in the project's .mcp.json
{ "mcpServers": { "dbkit": { "command": "dbk", "args": ["--conn", "shop", "-d", "shop", "mcp"] } } }
```

Tools provided:

| Tool | Purpose |
|------|------|
| `list_databases` | List databases / schemas |
| `list_tables` | List tables (including views) |
| `describe_table` | Columns (type / nullability / primary key / default / comment) + indexes + foreign keys |
| `sample_rows` | First few sample rows (up to 20) |
| `run_query` | Run a read-only query (up to 200 rows / 8 KB / 30 seconds) |
| `explain_query` | Get the execution plan |

Safety model (the same implementation as the GUI's built-in assistant; see [Architecture](./architecture.en.md#ai-assistant-tool-boundaries)):

- **Always read-only**, with no switch to relax it. SQL goes through a stricter version of the same guard as `query`; even `EXPLAIN ANALYZE DELETE …` is blocked (PostgreSQL would actually execute the inner statement). MongoDB rejects `$out` / `$merge`; Redis only allows read commands.
- **One statement per call**; split multiple statements into multiple calls.
- Tool failures come back as an `isError` **result** rather than a protocol error, so the model can see the reason and correct itself.
- The connection is not established until the first `tools/call`, so a database that is temporarily unreachable does not make the whole client handshake fail.

`--tools a,b` exposes only the listed tools (calls to anything outside the list are blocked). DBA agent reviews use this to apply a persona's tool allowlist and its "send no data" privacy setting.

> The GUI's AI assistant uses it automatically: when the Claude / Codex provider is selected, db-kit finds `dbk` and attaches it with the current connection (if it cannot be found, it falls back to having no database tools and the panel shows a notice). Use `DB_KIT_DBK_BIN` to specify the path.

### `ai` — AI library (personas / skills / prompt templates)

Reads the same settings directory as the GUI (`<settings dir>/ai-library/` and `ai-library.json`). For the format, layering and template syntax see the **[AI library guide](./ai-library.en.md)**.

```bash
dbk ai path                          # locations of the personal layer, team folders and settings file
dbk ai list [agent|skill|prompt]     # currently active items and the layer each comes from
dbk ai show agent/dba-senior         # print the body; --raw prints the whole file, --variant en shows a language variant
dbk ai lint                          # check the whole library; non-zero exit code on errors
dbk ai lint --dir ./dba-rules        # check a single folder only (for CI in a team repo)
dbk ai sync                          # list the plan for syncing to Claude Code / Codex
dbk ai sync --claude --yes           # sync to Claude Code only and write the files
dbk ai sync --project . --yes        # sync to the project folder's .claude / .agents / .codex
```

Sync only overwrites files that db-kit itself wrote and that have not been edited by hand since; any other file with the same name is listed as a conflict and skipped.

### `diff` / `sync` — file / folder compare and sync

These share the same Rust core (`src-tauri/src/filecmp/`) as the GUI's file compare tab. The two commands **do not use a database connection**; `--conn` / `--url` are ignored. Each side can be:

- A local path (file or folder);
- `ssh://<saved host>/<path>`: the host is a name or id from the GUI's "SSH hosts" list. FTP / FTPS hosts use the same form (`sftp://`, `ftp://` and `ftps://` prefixes are accepted too); `~` is the remote home directory, e.g. `ssh://web-01/~/app`. Credentials come from the OS keychain according to the host's settings, and jump hosts are used as configured.

```bash
# Files: output a unified diff (--context sets the number of context lines); when identical, stderr prints "The contents are identical"
dbk diff ./conf/app.conf ssh://web-01/etc/app/app.conf
dbk diff old.bin new.bin --mode binary                 # binary: list the differing ranges (offset / length)

# Folders: by default only differing entries are listed (status / path / size and mtime on each side / which side is newer); --all lists identical ones too
dbk diff ./site ssh://web-01/var/www/site
dbk diff ./site ssh://web-01/var/www/site --criteria content --exclude "*.log" --exclude .cache
dbk --format json diff ./site ssh://web-01/var/www/site > diff.json
dbk diff ./site ssh://web-01/var/www/site --exit-code   # CI / scheduled jobs: non-zero when there are differences

# Sync: dry-run first (without --yes it only lists each action and returns non-zero), then execute once confirmed; --force is also required when files will be deleted
dbk sync ./site ssh://web-01/var/www/site --rule update-lr
dbk sync ./site ssh://web-01/var/www/site --rule mirror-lr --yes --force

# Run a comparison saved in the GUI: both sides, exclusions, criteria and sync rule all come from it; command-line arguments take precedence
dbk diff --session "Website deploy check"
dbk sync --session "Website deploy check" --yes
```

**Compare mode** (`--mode`): when omitted, it is decided automatically from the two sides. If both are folders, it compares folders; if both are files, anything that does not look like UTF-8 text is compared as binary. One file and one folder is an error. When a file is too large, or the two sides differ too much to compare line by line, you are prompted to use `--mode binary` instead.

**Criteria for treating folder entries as identical** (`--criteria`):

| Value | Meaning |
|---|---|
| `size-mtime` (default) | Same size and same modification time (2-second tolerance; `--ignore-hour-offset` additionally ignores whole-hour offsets, to handle time zones / daylight saving time) |
| `size` | Size only |
| `content` | Byte-by-byte content comparison (remote files are first downloaded to a temporary folder, which is deleted at the end) |

`--ignore-case` matches names case-insensitively; `--exclude` can be repeated and supports `*` and `?`; when given, it replaces the default exclusions (`.git`, `node_modules`).

**Sync rule** (`--rule`; can be omitted when the saved comparison has one set):

| Value | What it does |
|---|---|
| `mirror-lr` / `mirror-rl` | Mirror: make the right side (/ left side) exactly like the other side; overwrites differing files and **deletes** entries that exist only at the destination |
| `update-lr` / `update-rl` | Only copy files that are newer or missing on the other side; deletes nothing |
| `update-both` | Fill in both sides from each other; differing files are resolved in favor of the newer side, and those whose age cannot be determined are listed as conflicts and left alone |

- Copies preserve the source's modification time, so comparing again after a sync reports "identical". FTP hosts cannot set modification times; a note at the end says how many files did not keep theirs.
- Remote ↔ remote sync also works (relayed through a local temporary folder).
- If any item fails, the others are still processed, and at the end a list of failures is printed and a non-zero exit code is returned.

---

## Common scenarios

**Daily report export**

```bash
#!/usr/bin/env bash
set -euo pipefail
day=$(date +%F)
dbk --conn prod -d shop export orders --to "orders-$day.csv" \
    --data-format csv --bom --filter "created_at:>=:$day"
```

**Scheduled backup (cron)**

```cron
0 3 * * * /usr/local/bin/dbk --conn prod backup shop --to /backup/shop-$(date +\%F).dump
```

**Run a performance baseline after a release and save it**

```bash
for q in "SELECT COUNT(*) FROM orders" "SELECT * FROM orders WHERE status='paid' LIMIT 100"; do
  dbk --conn staging --format json stress "$q" --threads 8 --seconds 20 --warmup 50 \
    >> "bench-$(date +%F).jsonl"
done
```

**Extract key metrics with jq for trend tracking**

```bash
dbk --conn staging --format json stress "SELECT 1" --threads 8 --seconds 30 \
  | jq '{rps, p95: .p95_ms, p99: .p99_ms, errors}'
```

**Check which server a script will hit before going live (dry run)**

```bash
# Without --yes: only prints what it would do and returns a non-zero exit code; nothing is changed
dbk --conn prod exec "delete from sessions where expired_at < now()"
```

**Production migration: dry-run and review first, then execute and keep a rollback**

```bash
# 1) Dry run: analysis + AI review + before-image and rollback script, no execution
dbk --conn prod -d shop run release-42.sql --out /backup/releases --review-cmd "claude -p"
# 2) Execute after reading review.md / rollback.sql (the before-image is captured again on every run; files from step 1 are not reused)
dbk --conn prod -d shop run release-42.sql --out /backup/releases --yes --allow-prod
# 3) Restore if something goes wrong: run the rollback script the same way; the current state is backed up before restoring too
dbk --conn prod -d shop run /backup/releases/<subdirectory>/rollback.sql --out /backup/releases --yes --allow-prod
```

**Scheduled check: has anyone hand-edited the website files on the production server?**

```bash
# Compare content against the deployment source; non-zero on differences, so the scheduler / monitoring can send an alert
dbk --format json diff ./release/site ssh://web-01/var/www/site --criteria content --exit-code > drift.json
```

**Audit: find every stored procedure that references a given column**

```bash
dbk --conn prod --format json search "customer_id" --definitions --type procedure | jq -r '.[].object_name'
```

---

## Exit codes and error handling

| Exit code | Meaning |
|---|---|
| `0` | Success |
| Non-`0` | Any error, including connection failures, blocks by the read-only guard, and **dry runs without `--yes` / `--force`** |

Error messages are printed to stderr in the form `error: <message>`, in the language set by `--lang`.

**Watch out**: an "unconfirmed write" also returns a non-zero exit code. In a `set -e` script, forgetting `--yes` aborts the whole script. This is deliberate: better to stop than to skip silently.

---

## Stored procedure integration tests: `dbk sp-test`

Runs scenario tests of stored procedures against a real database (multi-step, automatic rollback, automatic snapshots of side effects). Four modes share the same test files:
`assert` (compare against expectations), `record` / `golden` (baseline regression), and `diff` (compare two connections against each other, for migration verification).
For the full guide, the UI workflow and 8 runnable examples, see [sp-test.en.md](./sp-test.en.md).

```
dbk sp-test init usp_place_order --conn mssql-test -d sales -o tests/          # skeleton from a routine (seed data, parameters, error-branch scenarios)
dbk sp-test list tests/                                                        # list scenarios / cases / tags (no connection)
dbk sp-test validate tests/                                                    # check format and references (no connection)
dbk sp-test inspect dbo.usp_place_order --conn mssql-test -d sales            # signature, write targets, body (JSON)
dbk sp-test run tests/ --conn mssql-test -d sales                              # assert
dbk sp-test run tests/ --conn mssql-test -d sales --only qty_cases/zero       # run a single case
dbk sp-test run tests/ --conn mssql-test -d sales --mode record --golden golden/
dbk sp-test run tests/ --conn mssql-test -d sales --mode golden --golden golden/ --junit reports/mssql.xml --exit-code
dbk sp-test diff tests/ --conn mssql-test -d sales --dst pg-test --dst-db public --junit reports/diff.xml --exit-code
```

- `--only a,b/c` runs only the listed scenarios (`id` or `id/case`); `--tag smoke` filters by tag; `--format json` outputs the full report (stdout carries only the results; progress goes to stderr).
- `--junit` additionally writes JUnit XML; `--exit-code` returns non-zero if any scenario fails (for CI).
- `--dst` accepts a saved connection name or a connection string; when `--dst-db` is omitted it is the same as `-d`.
- `init -o` with a folder writes `<routine>.json`; add `--force` to overwrite an existing file; without `-o` it prints to stdout.

## Limitations

- **Kafka / Elasticsearch / RabbitMQ and container-type connections (Docker / Registry / Harbor / Kubernetes) are not supported by the CLI.** They have no general-purpose query language that can be expressed in a terminal, and the lean binary does not compile in their drivers; specifying one returns a clear error, so use the GUI instead. SSH hosts are only used by `diff` / `sync` (as one side of a file compare); the CLI does not open terminals.
- **`mcp` handles requests one at a time**, not concurrently. Database tools should run one at a time anyway, and they share the same connection.
- **`GO` batch separators are only supported by `run`.** When `exec` receives a script pasted from SSMS, the statements after `GO` are not split into separate batches.
- **`run` does not wrap a transaction and commits statement by statement**; scripts containing `BEGIN` / `COMMIT`, `USE` / `SET`, or a non-PostgreSQL procedure body are rejected as a whole. **Oracle has not been tested yet.**
- **`stress` is always read-only**; `--allow-writes` is not offered.
- **No restores.** `backup` only produces a dump file; to restore, use the GUI or each database's native tools (restoring is destructive and needs interactive confirmation).
- **`backup` requires each database's official dump tool on `PATH`** (except SQLite, which copies the file), with no built-in fallback; SQL Server and Oracle backups are not wired up yet.
- **Oracle connections require Instant Client**; when it is not installed, only Oracle connections are affected.

---

Related docs: [README](../README.en.md) · [Architecture](./architecture.en.md) · [CHANGELOG](../CHANGELOG.md)
