<p align="center">
  <img src="docs/hero.png" alt="db-kit — MAGIDB CONNECT: an all-in-one cross-platform database management tool" width="860">
</p>

<h1 align="center">db-kit</h1>

<p align="center"><strong>MAGIDB CONNECT — Making Data Connections Magical</strong></p>

<p align="center">
An all-in-one cross-platform desktop database tool that manages<br>
<strong>MySQL · MariaDB · PostgreSQL · SQL Server · Oracle · SQLite · MongoDB · Redis · Kafka</strong><br>
through a single, consistent interface.
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white">
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-22c55e">
</p>

<p align="center">
  <strong>💚 100% Free & Open Source</strong>　·　MIT License　·　No paywall　·　No feature locks　·　No telemetry　·　Fork / self-host freely
</p>

<p align="center">
  <a href="./README.md">繁體中文</a> · <strong>English</strong>
</p>

---

## What is this

Engineers and DBAs constantly juggle MySQL, MariaDB, PostgreSQL, SQL Server, Oracle, MongoDB, Redis… with a desktop full of separate management tools, each with its own quirks. **db-kit** brings them all into one interface, one connection manager, and one theme system — relational, document, and key-value paradigms each get a browsing and editing experience tailored to how they feel, while everyday operations (data grid, queries, ER diagrams, import/export, backup) stay aligned across databases.

Built on **Tauri 2 (Rust backend + web frontend)**: small installers and roughly one tenth the memory footprint of comparable Electron apps. All database connections live in the Rust backend and the frontend talks to them through Tauri commands — never connecting directly — for both security and performance.

## Cross-platform

One codebase, one consistent experience, shipping **native desktop apps for Windows / macOS / Linux**:

- **One codebase, three native targets** — based on Tauri 2, `npm run tauri build` produces native installers on each platform: Windows `.msi` / `.exe` (NSIS), macOS `.dmg`, Linux `.AppImage` / `.deb` — all native windows, not browser tabs.
- **Identical UI and feel everywhere** — the connection tree, editable data grid, query editor, ER diagram, keyboard shortcuts, and dark/light themes are exactly the same on all three platforms. Switching machines requires no re-learning.
- **Passwords stored in each OS's native keychain** — via `keyring`, mapped to Windows Credential Manager, macOS Keychain, and Linux Secret Service (libsecret). Passwords never touch the disk.
- **The `dbk` CLI is cross-platform too** — build a lean, Tauri-free binary with `--no-default-features` for Linux servers; SSH in and query / export / back up right there.
- **Lightweight** — Tauri uses the system WebView (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) instead of bundling Chromium: small installers, ~10× less memory than Electron equivalents.

> GitHub Releases provides prebuilt installers for **Windows / macOS / Linux** (packaged automatically by GitHub Actions). macOS builds ship for both Apple Silicon and Intel. Installers are not code-signed with a paid certificate, so the first launch requires bypassing the OS warning (steps below). You can also build your own via [Build from source](#build-from-source).

## Screenshots

> Real app screenshots (production build, default **Amethyst** dark theme). Connections and data shown are a fictional demo e-commerce schema.
> Retake them anytime with `npm run make:screenshots` (real Playwright captures — see [`scripts/capture-screenshots.mjs`](./scripts/capture-screenshots.mjs)).

| Table view — connection tree · tabs · editable data grid | Query editor — multi-statement · stacked result sets (SSMS style) |
|:---:|:---:|
| ![Table view](docs/screenshots/01-data-grid.png) | ![Query editor](docs/screenshots/02-query-editor.png) |
| **ER diagram** — foreign-key relations · draggable table cards · layout memory | **Redis** — namespaced key tree · structure editing · INFO status |
| ![ER diagram](docs/screenshots/03-er-diagram.png) | ![Redis view](docs/screenshots/04-redis.png) |

**Advanced object search** (`Ctrl+Shift+G`) — find tables / columns / indexes / stored procedures across databases, searching *definition bodies* and *comments* too, with whole-word matching and wildcards. Hits are highlighted, and one click "Select in object explorer" jumps back to the sidebar:

<p align="center">
  <img src="docs/screenshots/05-advanced-search.png" alt="Advanced object search" width="860">
</p>

## Download & install

<p align="center">
  <a href="https://github.com/markku636/db-kit/releases/latest">
    <img alt="Download latest release" src="https://img.shields.io/github/v/release/markku636/db-kit?label=Download%20latest&style=for-the-badge&color=22c55e">
  </a>
</p>

Head to the **[Releases page and grab the latest version ⬇️](https://github.com/markku636/db-kit/releases/latest)**, then pick the installer for your OS:

| Platform | Installer | How to install |
|------|--------|----------|
| **Windows** 10 / 11 | `db-kit_x.y.z_x64-setup.exe` (NSIS)<br>or `db-kit_x.y.z_x64_en-US.msi` (MSI) | Download, double-click, follow the wizard |
| **macOS** Apple Silicon (M series) | `db-kit_x.y.z_aarch64.dmg` | Open the .dmg and drag DB Kit into "Applications" |
| **macOS** Intel | `db-kit_x.y.z_x64.dmg` | Open the .dmg and drag DB Kit into "Applications" |
| **Linux** Debian / Ubuntu | `db-kit_x.y.z_amd64.deb` | `sudo dpkg -i db-kit_*.deb` or use your software center |
| **Linux** Fedora / RHEL | `db-kit-x.y.z-1.x86_64.rpm` | `sudo rpm -i db-kit-*.rpm` |
| **Linux** portable | `db-kit_x.y.z_amd64.AppImage` | `chmod +x *.AppImage` and run it |

**Windows install steps**

1. Download the `.exe` (recommended) or `.msi` from [Releases](https://github.com/markku636/db-kit/releases/latest).
2. Double-click to run. If SmartScreen warns you, click "More info" → "Run anyway" (the installer has no paid code-signing certificate).
3. When done, launch **db-kit** from the Start menu.

> **WebView2 Runtime required**: built into Windows 11 and already present on most updated Windows 10 machines; if missing, the installer prompts you to download it.

**macOS install steps**

1. Download the `.dmg` matching your chip: `aarch64` for Apple Silicon (M1/M2/M3…), `x64` for Intel.
2. Open the .dmg and drag **DB Kit** into the "Applications" folder.
3. On first launch, because the app is **not Apple-signed / notarized**, macOS shows "cannot verify the developer": **right-click the app icon → "Open" → "Open"** (needed only once).
   - If it's still blocked, run in Terminal: `xattr -dr com.apple.quarantine "/Applications/DB Kit.app"`.

**Linux install steps**

- Debian / Ubuntu: `sudo dpkg -i db-kit_*.deb` (fix missing dependencies with `sudo apt-get -f install`).
- Fedora / RHEL: `sudo rpm -i db-kit-*.rpm`.
- Any distro (portable): download the `.AppImage`, `chmod +x`, and run.

To package installers yourself, see [Build from source](#build-from-source) below.

## Quick start

First time after installing — three steps to connect:

1. **Add a connection** — click **"+ New Connection"** at the top left and pick the database type (MySQL / MariaDB / PostgreSQL / SQL Server / Oracle / SQLite / MongoDB / Redis / Kafka).
2. **Fill in connection details** — host, port, username, password (or pick a SQLite file). Configure a jump host on the **SSH Tunnel** tab if needed. Hit **"Test Connection"** first, then **Save**.
3. **Start working** — the connection appears in the left tree; expand a database and double-click a table to browse / edit data. Open query editor, ER diagram, and more from the top tabs.

> Passwords are stored in the OS keychain (never written to disk). Right-click a connection anytime to "Edit / Duplicate / Delete".

> **Oracle prerequisite**: connecting to Oracle requires a **64-bit [Oracle Instant Client](https://www.oracle.com/database/technologies/instant-client/downloads.html)** (Basic or Basic Light) on your PATH (or set the client directory in the connection settings) — a native dependency of Oracle's official driver that db-kit does not bundle. Without it, only Oracle connections prompt for it; every other database is unaffected. Server must be Oracle 12c or newer.

**No database handy?** Spin up a test MySQL with Docker:

```bash
docker run --name mysql-test -e MYSQL_ROOT_PASSWORD=test1234 -p 3306:3306 -d mysql:8
# Then add a connection in db-kit: host 127.0.0.1, port 3306, user root, password test1234
```

Common operations at a glance:

| To do this | Do this |
|----------|--------|
| Edit data | Double-click a cell to edit → hit **✓** to apply (written back keyed by primary key) |
| Filter / sort | Click a column header to sort, Shift+click for multi-column; open multi-column compound filters from the toolbar |
| Run SQL | Open a "Query Editor" tab: **Ctrl+Enter** runs the statement under the cursor, **F6** runs the whole script (or just the highlighted selection) |
| Run several at once | Separate statements with `;` — each result set is shown **stacked** (SSMS style), individually sortable / filterable / exportable |
| Find where something lives | **Ctrl+Shift+G** advanced object search (tables / columns / indexes / procedure definitions across databases); **Ctrl+K** command palette for quick jumps |
| Export / import | Export CSV / JSON / Excel / SQL… from the grid toolbar; import CSV / Excel into tables |
| See table relations | Open the "ER Diagram" tab — drag table cards, layout is remembered |
| Change the look | Theme menu at the top right: light / dark + 7 gemstone variants (the whole app and the editor switch together) |
| Ask AI | The right-hand panel connects to your local Claude CLI and can attach the current connection's schema |

## ✨ Highlights

- **Eight databases + Kafka, one tool** — MySQL · MariaDB · PostgreSQL · SQL Server · Oracle · SQLite · MongoDB · Redis · Kafka, all fully connectable, sharing one connection tree, data grid, and shortcut set.
- **Cross-platform desktop app** — one codebase ships native installers for Windows / macOS / Linux with identical UI, shortcuts, connection management, and keychain integration; the `dbk` CLI is cross-platform too (see [Cross-platform](#cross-platform)).
- **Light and fast** — Tauri 2 architecture using the system WebView, ~10× lighter than Electron; skeleton-screen startup (zero white flash), ~470 KB initial JS bundle, CodeMirror lazy-loaded only when you open a query tab.
- **Multi-statement runs, stacked results** — batch execution shows every result set **stacked at once** (in the spirit of SSMS / MySQL Workbench), each pane independently scrollable / sortable / filterable, exportable per pane or "export all"; a mid-batch failure keeps the result sets already fetched.
- **A full theme system** — 7 built-in gemstone palettes (Amethyst / Moonstone / Jade / Garnet / Amber / Ruby / Obsidian), switchable from the toolbar, **driving the entire app and SQL editor syntax highlighting together**; the AI assistant's code blocks recolor too.
- **Secure and safe** — connection passwords in the OS keychain (never on disk), SSH Tunnel (password / private key) with host-key TOFU verification, all writes keyed by primary key with fully parameterized bindings against injection; plus **row-count caps** and **query timeouts** as two safety nets — an accidental `SELECT *` on a huge table won't blow up memory.
- **Desktop-grade grid feel** — in-cell editing, context menus, keyboard navigation, multi-column sort, draggable column widths, filter-by-value, content viewer, instant find, column comments on header hover.
- **Built-in AI assistant** — the right panel connects to your local Claude CLI (sign in with your Claude subscription) to stream answers to database questions, write / optimize SQL, and optionally attach the current connection's schema as context.
- **Ships with the `dbk` CLI** — a read-only query / browse / export / backup command-line tool reusing the same connections and keychain; compile it Tauri-free with `--no-default-features` for servers and scripts (see [Command-line tool](#command-line-tool-dbk-cli)).
- **Solid engineering practice** — backend integration tests against real Docker databases (MySQL / PostgreSQL / SQLite / MongoDB / Redis), Rust unit tests covering per-dialect SQL generation (including MariaDB / Oracle), pure-function frontend coverage with vitest (234 tests), hardened through multiple rounds of adversarial self-review for security and correctness (see [CHANGELOG](./CHANGELOG.md)).

## Features

| Area | Key features |
|------|----------|
| Relational (MySQL / MariaDB / PostgreSQL / SQL Server / Oracle / SQLite) | Full CRUD, DDL column editing, index / foreign-key management, EXPLAIN + visual execution plans (SHOWPLAN XML on SQL Server, DBMS_XPLAN on Oracle), routines (stored procedures / functions), RETURNING display, ER diagram, schema compare, SSL modes (MySQL family / PG) |
| Document (MongoDB) | Documents flattened into a grid, find / aggregation pipelines, CRUD-via-JSON, **visual explain plans**, JSON query editor (syntax highlighting + field completion), advanced indexes (TTL / partial / text / $indexStats usage), **validation rules (JSON Schema)**, field statistics (type distribution / top values), **monitoring panel** (serverStatus / dbStats / currentOp / Profiler) |
| Key-value (Redis) | Five structure views with editing, namespaced key tree, value formatting, Pub/Sub, ops panel, command-line console |
| Message streaming (Kafka) | Cluster→topic tree, message browser (partition / offset / key / value / timestamp / headers), **live tail**, produce messages, **consumer groups + lag**, offset reset, create / delete topics + configs, **Schema Registry** (subjects / schema + Avro→JSON decode) |
| Universal data grid | Multi-column compound filters (9 operators + AND·OR), multi-column sort, filter by value, **two-way foreign-key navigation** (jump to referenced row / find referencing rows), **Excel + CSV import**, multi-format + **Excel export**, copy as INSERT/UPDATE/DELETE/IN, column profiling + distinct-value distribution, **column comments on header hover** |
| Query workspace | Syntax highlighting + table/column autocomplete (incl. external gateway), **`@` user-variable suggestions**, **stacked multi-result sets** (SSMS style, collapsible, export one or all), **visual query builder** (JOIN / aggregates / HAVING / paging / live preview), **SQL snippet library**, **parameterized queries `:name`**, format / minify / keyword casing, query history (200 entries, filterable), **saved queries** (groups / edit / import-export), run selection only, failed-statement locating, multiple query tabs (right-click to close others) |
| Search / navigation | **Advanced object search Ctrl+Shift+G** (search names / definition bodies / comments across databases, whole-word + wildcards `*` `?`, highlighted definition preview, select in object explorer), **command palette Ctrl+K**, sidebar search auto-expands matching folders |
| Cross-database / cross-connection | **Data transfer** (single table / whole database / auto-create missing tables), **data compare / sync** (generates INSERT/UPDATE/DELETE), **whole-database documentation** (HTML / Markdown), schema compare |
| Appearance | **7 gemstone themes** (Amethyst / Moonstone / Jade / Garnet / Amber / Ruby / Obsidian) driving the whole app + editor highlighting, one-click light / dark / variant switching from the toolbar |
| Security | Passwords in the OS keychain, SSH Tunnel (password / private key) + host-key TOFU, fully parameterized bindings against injection, **read-only connection mode** (blocks writes / DDL), **connection color labels** (tell prod from test), **startup password** (Argon2id), **row cap / query timeout**, pinned favorite tables |
| AI assistant | Right-hand panel wired to your local Claude CLI: streaming Q&A, write / optimize SQL, optionally attach the current schema; code blocks follow the active theme's highlighting |
| Operations | Persistent connection settings, encrypted connection export / import (passwords included), scheduled backups + backup history, connection-pool monitoring + ping, update check on launch, cross-platform desktop app |

> Current status: **all eight databases + Kafka fully connectable**; relational databases have full CRUD / DDL column editing / index management / EXPLAIN / RETURNING display, multi-column compound filters (9 operators + AND·OR) and sorting, **CSV import** + multi-format export + **whole-database schema dump SQL**
> SQL Server (tiberius + bb8 connection pool): CRUD, structure tabs (indexes / foreign keys / DDL), routines (stored procedures / functions), execution plans (SET SHOWPLAN_XML), ER diagram, column statistics; backup / restore planned via sqlpackage `.bacpac` export (not wired up yet)
> MariaDB shares the MySQL driver (wire-protocol compatible): full MySQL feature parity + `INSERT/DELETE … RETURNING` result-set display
> Oracle (rust-oracle / ODPI-C): CRUD, structure tabs (indexes / foreign keys / DDL via DBMS_METADATA), routines, execution plans (EXPLAIN PLAN + DBMS_XPLAN), ER diagram, column statistics; **requires a self-installed 64-bit Oracle Instant Client** (detected at runtime via PATH / ORACLE_HOME / custom directory, with download guidance if missing; server must be 12c+)
> MongoDB: document flattening + full **CRUD-via-JSON** in the query editor (find / aggregate / insert / update / delete) + **explain plans** (stage tree, COLLSCAN warnings, scan ratios) + advanced indexes (TTL / partial / text / 2dsphere / hidden + $indexStats usage) + **validation rules** ($jsonSchema via collMod) + field statistics (BSON type distribution / Top-10 / sampling) + **monitoring panel** (serverStatus / dbStats / currentOp+kill / Profiler slow queries)
> Redis, modeled on dedicated Redis desktop managers: five structure views with editing, **namespaced key tree** (folders grouped by `:`), value formatting (raw / JSON / Hex), **Pub/Sub** subscribe & publish, **ops panel** (slowlog / clients / big keys), **server status panel** (key INFO metrics + all sections, auto-refreshable), **command-line console** (command history, DB switching)
> Kafka (rdkafka / librdkafka), modeled on **Offset Explorer**: cluster info, topics & partitions (leader / ISR / watermark), bounded consume + JSON / Avro detail, **live tail**, produce, **consumer groups + lag**, offset reset, create / delete topics & configs, **Schema Registry** (Avro→JSON decode); PLAINTEXT / SASL_PLAINTEXT + PLAIN by default, TLS / SASL_SSL / SCRAM via the `kafka-tls` feature (needs prebuilt OpenSSL); librdkafka is C, so Windows builds need CMake (see `build-kafka.ps1`)
> Persistent connection settings (passwords in the OS keychain), SSH Tunnel, scheduled backups + backup history, connection latency ping, ER diagram, draggable column widths, AI assistant
> Query workspace: multi-statement → **stacked multi-result sets** (SSMS style), failed-statement locating, 200-entry query history, saved-query groups, `@` user variables and table/column autocomplete
> Appearance: **7 gemstone themes driving the app + editor together** (switch from the toolbar or Settings); **advanced object search** (cross-database / definition bodies / whole-word / wildcards)

Full planning docs live in [`docs/`](./docs/): [Planning](./docs/planning.md) · [Architecture](./docs/architecture.md) · [Connection lifecycle](./docs/connection-lifecycle.md) · [Roadmap](./docs/roadmap.md). Change history in the [CHANGELOG](./CHANGELOG.md).

## Feature roadmap

All core features are complete (50+ items). Expand for the full list:

<details>
<summary><strong>Show the full feature list</strong></summary>

- [x] P0 skeleton: layout, large-icon toolbar, connection pool & release layer, MySQL connectivity
- [x] P1/P2 double-click to open tables → grid view + bottom pagination + structure/data tab switching
- [x] SQLite support (file-based, sharing the MySQL trait)
- [x] PostgreSQL support
- [x] Microsoft SQL Server support (tiberius + bb8 pool; structure tabs / routines / SHOWPLAN XML execution plans / ER diagram / column stats; backup planned via sqlpackage `.bacpac`, not wired yet)
- [x] MariaDB support (shares the sqlx MySQL driver; distinct connection type + MariaSQL editor dialect + RETURNING result sets)
- [x] Oracle support (rust-oracle / ODPI-C; runtime Instant Client detection, EZConnect / SID / TNS connection styles, structure tabs / routines / DBMS_XPLAN plans / ER diagram; server 12c+)
- [x] MongoDB deep-dive: visual explain, JSON query editor (completion), advanced indexes + $indexStats, validation rules, field statistics, monitoring panel (currentOp / Profiler)
- [x] MySQL / PostgreSQL SSL modes (sqlx rustls; typed connection params — special characters in passwords no longer need encoding)
- [x] In-cell editing + ✓ apply (keyed by primary key, written back to the DB)
- [x] Insert / delete rows (full CRUD)
- [x] Filtering (single-column conditions), sorting (click column headers)
- [x] MongoDB (documents flattened into the grid, same grid feel)
- [x] Redis (key listing + five structure views)
- [x] Redis deep-dive: namespaced key tree (`:` grouping), context menus on keys / DBs / connections, server status (INFO) panel, command-line console
- [x] Backup / restore (manual, CLI-driven + SQLite file copy)
- [x] Persistent connection settings + passwords encrypted in the OS keychain
- [x] SSH Tunnel (password / private-key auth)
- [x] Scheduled backups + backup history management (list / run now / restore / retention count)
- [x] Redis structure editing (List / Set / ZSet / Hash element add/remove/edit), multi-column compound filters, column resizing
- [x] AND / OR toggle for multi-column filters
- [x] Data export (CSV / TSV / JSON / SQL INSERT / Markdown, with header / delimiter / NULL / BOM / range options)
- [x] Data import (CSV / TSV → table, RFC4180 parsing, empty-field→NULL, per-row success/failure reporting)
- [x] Whole-database schema dump SQL (right-click a database in the sidebar → "Export schema SQL", concatenating every table's CREATE statement)
- [x] Column profiling (right-click a column header → "Column statistics": total rows / non-null / distinct values)
- [x] UX polish: native file pickers, connection editing, toast notifications, connection-tree context menus
- [x] SSH host-key verification (TOFU: remember the fingerprint on first use, compare afterwards)
- [x] Query performance analysis (EXPLAIN)
- [x] Structure editing (DDL: add / drop / rename columns)
- [x] ER diagram (tables + foreign-key relations; draggable cards, zoom, layout memory, relation highlighting)
- [x] Grid feel: cell context menu (copy value / row as JSON·TSV / INSERT, set NULL, filter by value), content viewer, keyboard navigation, selection info
- [x] Multi-column sort (Shift+click), rows per page, column hiding / auto-fit width, refresh
- [x] Query editor: execution time / row counts, query history, run selection only, Ctrl+Enter, per-connection memory, result copy / export (CSV·JSON·TSV)
- [x] Structure: copy CREATE TABLE SQL (SHOW CREATE TABLE etc.), index viewing + create / drop (MySQL / PostgreSQL / SQL Server / SQLite / MongoDB)
- [x] MongoDB query upgrades: sort / projection / limit + **aggregation pipelines** (aggregate: `$match` / `$group` / `$sum`…)
- [x] Sidebar: search filtering, right-click tables to generate queries (SQL SELECT/COUNT/INSERT, Mongo find templates), duplicate connections
- [x] Tab management (middle-click / close others / close all / Ctrl+W), live connection-pool monitoring + **ping** (round-trip latency on existing connections, SSH tunnels included), global UI/UX polish
- [x] Redis advanced: value formatting (raw / JSON / Hex) + cursor-based paging for large collections, **Pub/Sub** subscribe & publish, **ops panel** (slowlog / clients / big keys)
- [x] AI assistant (right panel, wired to the local Claude CLI): streaming Q&A, write / optimize SQL, optionally attach the current connection's schema as context
- [x] Cross-database consistency: the above aligned across MySQL / PostgreSQL / SQL Server / SQLite / MongoDB (identifiers / filters / indexes mapped per database)
- [x] **Visual query builder**: check off tables / columns, auto-JOIN from foreign keys, WHERE / aggregates / HAVING / ORDER BY / DISTINCT / LIMIT / OFFSET, live preview + count, send to editor; open from a table's context menu
- [x] **Excel (.xlsx) export / import**: pure Rust (rust_xlsxwriter / calamine), numeric fidelity, frozen headers + auto column widths
- [x] **Query-result export** through a unified backend pipeline (CSV / TSV / Excel / JSON / SQL / Markdown)
- [x] **SQL snippet library** (editor autocomplete + toolbar management), **parameterized queries `:name`**, SQL **format / minify / keyword casing**
- [x] **Data transfer** (cross-connection / cross-database; single table / whole database; auto-create missing target tables)
- [x] **Data compare / sync** (compare two tables by primary key, generate INSERT / UPDATE / DELETE sync DML)
- [x] **Whole-database documentation** (HTML / Markdown reports with table of contents)
- [x] **Two-way foreign-key navigation** (jump to referenced row / find rows referencing this one), **Copy as IN**, **distinct-value distribution**
- [x] **Command palette** (Ctrl/Cmd+K): fuzzy-search jumps to connections / databases / tables / actions
- [x] **Read-only connection mode** (blocks writes / DDL from grid and sidebar), **connection color labels** (tell environments apart), **pinned favorite tables**
- [x] Schema compare (table / column diffs between two databases on one connection + sync SQL)
- [x] **Startup password** (Argon2id hash, gates app launch; does not affect the keychain or the `dbk` CLI)
- [x] **Query safety nets**: row cap (default 1,000) + query timeout (DB-side + tokio fallback), large-table performance work (row-level memoization / parallel COUNT / per-database connection caching)
- [x] **Startup speed**: skeleton screen kills the white flash, dialog & CodeMirror code splitting (initial bundle 1,139 KB → ~470 KB), asset and font-subset slimming
- [x] **Multi-result sets** (SSMS-style stacking): each pane independently scrolls / sorts / filters / collapses; the active pane drives copy / export / ask-AI; "Export all" exports every result set at once
- [x] **Editor themes**: 7 gemstone palettes (`src/editorThemes.ts`), upgraded in 0.8.0 into the unified theme system driving the whole app, switchable from the toolbar (light / dark / variants)
- [x] **Saved queries**, complete: groups, edit / rename, import & export (SQL snippets included), managed from the top toolbar
- [x] **SQL editor completion**: table / column autocomplete (incl. batch-loading a whole database's columns over the external gateway), `@` user-variable suggestions
- [x] **Advanced object search** (`Ctrl+Shift+G`): sortable tabular results (name / database(schema) / type / matched-in / detail), name / definition / comment matches, whole-word + wildcards, highlighted definition preview, select in object explorer
- [x] Sidebar search / filter auto-expands folders on match; grid headers show column comments on hover
- [x] "About DB Kit" dialog + GitHub update check on launch (can be disabled in Settings)
- [x] **Internationalization (i18n)**: Traditional Chinese ⇄ English, live switching without restart; frontend, Rust backend, and the `dbk` CLI all localized (`--lang`, `DBKIT_LANG`); English translation table code-split so Chinese users never download it

</details>

## Tech stack

| Layer | Technology |
|----|------|
| App framework | Tauri 2 |
| Frontend | React 18 + TypeScript + Vite |
| UI | Tailwind CSS (shadcn/ui style); 12 semantic CSS variables (`--c-*`) carry the theme, 7 palettes derive surface depth via `buildAppVars` |
| Editor | CodeMirror 6 (SQL / JSON syntax highlighting, lint, autocomplete) |
| State | Zustand |
| Backend | Rust: sqlx (MySQL / MariaDB / PostgreSQL / SQLite), tiberius + bb8 (SQL Server), rust-oracle / ODPI-C (Oracle, needs Instant Client), mongodb, redis |
| Security | OS keychain (keyring), SSH Tunnel (russh) + host-key TOFU |
| AI assistant | Local Claude CLI (Claude subscription sign-in, streaming) |

## Connection lifecycle design

Connection release is where tools like this most often go wrong, so it was designed in from P0:

- **Connection pooling**: sqlx's built-in pool with `max_connections` / `idle_timeout` / `max_lifetime`
- **Health checks**: validate zombie connections with `SELECT 1` before handing one out
- **Graceful shutdown**: drain every pool on app exit (RAII / Drop as the backstop)
- **Connection monitoring**: per-connection in-use / idle reporting

## Build from source

Build from source to modify, contribute, or run on macOS / Linux.

**Requirements**

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- Tauri system dependencies: see <https://tauri.app/start/prerequisites/>

**Develop & package**

```bash
# Install frontend dependencies
npm install

# Dev mode (starts frontend + Tauri together, hot reload)
npm run tauri dev

# Package an installer for the current platform
npm run tauri build
```

Build artifacts land in `src-tauri/target/release/bundle/` (`.msi` / `.exe` / `.dmg` / `.AppImage` / `.deb` depending on platform).

## Command-line tool (`dbk` CLI)

Alongside the desktop GUI, db-kit ships a **`dbk` command-line tool** — **read-only queries + export** — for SSH sessions, scripts, and scheduled jobs where opening a GUI makes no sense. It reuses the core layer directly (connection management / export / backup / crypto) and **does not go through Tauri**, so `--no-default-features` builds a **lean, Tauri-free binary**.

```bash
# Build the lean CLI (no GUI / Tauri)
cargo build --release --no-default-features --bin dbk
# Output: target/release/dbk(.exe)
```

**Two ways to connect**: reuse a connection saved in the GUI (`--conn <name or id>`, reading the same connections.json + OS keychain), or connect ad hoc with flags (`--kind mysql --host … --user …`; put the password in the `DBKIT_PASSWORD` environment variable to keep it out of argv). `--kind` accepts `mysql / mariadb / postgres / sqlite / mongo / redis / mssql / oracle`, or use a one-shot `--url` connection string like `oracle://user:pass@host:1521/SERVICE`. Output formats: `--format table|csv|json`.

```bash
# Use a GUI-saved connection, run a read-only query, output CSV
dbk --conn prod-mysql --format csv query "select id,name from users limit 20"

# Ad-hoc connection (password via env var), list tables
DBKIT_PASSWORD=*** dbk --kind mysql --host 10.0.0.5 --user app db list
dbk --conn prod-mysql table data orders --page 0 --page-size 50 --filter "status:=:paid" --sort "created_at:desc"

# Export a table / dump the schema / back up (--data-format: csv | tsv | xlsx | json | sql | markdown)
dbk --conn prod-mysql export orders --to orders.csv --data-format csv --bom
dbk --conn prod-mysql export orders --to orders.xlsx --data-format xlsx
dbk --conn prod-mysql schema-dump > schema.sql
dbk --conn prod-mysql backup mydb --to mydb.dump
```

**Read-only guard**: `query` / `explain` only allow query-class statements (`select` / `with` / `show` / `describe` / `explain` / `pragma` / `use` / `values` / `table`); write statements (`insert` / `update` / `delete` / `drop`…) are rejected with a non-zero exit code (statements split per `;`, comments skipped). Pairing it with a read-only DB account as a second line of defense is recommended.

**Row cap**: `query` defaults to the global setting (1,000 rows); override with `--max-rows N` (`--max-rows 0` fetches everything; truncation is reported on stderr).

Other subcommands: `conn` (list / test / ping / encrypted export), `table` (list / columns / data / info / ddl / indexes / foreign-keys), `routine`, `search` (`--whole-word` exact-word matching, `--wildcards` enables `*` `?`), `column-stats`, `er-model`, `server-info`, `redis` (keys / key / slowlog / clients / big-keys). Full list via `dbk --help`.

> Architecturally, `tauri` / `tauri-plugin-dialog` are optional dependencies behind the default `gui` feature; the GUI binary (`db-kit`) needs the `gui` feature, the CLI binary (`dbk`) does not.

## Packaging the Windows installer

On **Windows**, run the bundled PowerShell script — it checks for and installs Rust and Node.js automatically, then produces the `.msi` and `.exe` installers:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
```

The installers land in `src-tauri\target\release\bundle\` (`msi\` and `nsis\` subdirectories).

> Note: Tauri requires the WebView2 Runtime (built into Windows 11; most Windows 10 machines already have it).

**Automated releases (GitHub Actions)**: pushing a version tag starting with `v` packages **Windows / macOS (Intel + Apple Silicon) / Linux** installers in the cloud and creates the matching [Release](https://github.com/markku636/db-kit/releases) (see [`.github/workflows/release.yml`](./.github/workflows/release.yml)):

```bash
git tag v0.1.6 && git push origin v0.1.6
```

## License

[MIT](./LICENSE)
