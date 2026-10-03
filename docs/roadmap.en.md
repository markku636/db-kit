# Development Roadmap

[繁體中文](./roadmap.md) · **English**

Development proceeds incrementally in phases, and each phase produces a working result.

| Phase | Scope | Status |
|------|------|------|
| P0 | Tauri + React skeleton, large-icon toolbar, connection pool and release layer, MySQL connection | ✅ Done |
| P1 | Connection tree expands down to tables, double-click to open a table | ✅ Done |
| P2 | Table view (Data / Structure tabs) + pagination bar at the bottom | ✅ Done |
| — | SQLite support (file-based) | ✅ Done |
| — | PostgreSQL support | ✅ Done |
| — | Direct cell editing + ✓ Apply (written back to the DB, rows located by primary key) | ✅ Done |
| — | Windows installer packaging (.msi / .exe) + a ps1 that installs dependencies automatically | ✅ Done |
| — | Add row / delete row (full CRUD) | ✅ Done |
| — | Filtering (single-column condition), sorting (click a column header) | ✅ Done |
| — | MongoDB (documents flattened into a table, keeping the same table feel) | ✅ Done |
| — | Redis (keys as a list + views for the five data structures) | ✅ Done |
| — | Backup / restore (manual; mainly via CLI tools + SQLite file copy) | ✅ Done |
| — | Connection settings persistence + passwords encrypted in the OS keychain | ✅ Done |
| — | SSH Tunnel (password / private key authentication) | ✅ Done |
| — | Scheduled backups + backup history management | ✅ Done |
| — | Redis structure editing, multi-column compound filters, column width adjustment | ✅ Done |
| — | AND / OR toggle for multi-column filters | ✅ Done |
| — | Data export (CSV / TSV / JSON / SQL / Markdown, with multiple options) | ✅ Done |
| — | SSH host key verification (TOFU) | ✅ Done |
| — | **SSH terminal + SFTP** (modeled on Xshell): a separate "SSH Hosts" list in the sidebar (with folders; appears only when there are hosts); hosts can be added from "New Connection" by pasting an ssh:// / sftp:// connection string; multi-tab xterm.js terminal (password / private key / keyboard-interactive / ssh-agent · Pageant; private keys can be imported from OpenSSH, PuTTY PPK, PKCS#8, PEM (including OpenSSL 3DES / AES encryption) and DER, OpenSSH user certificates are supported, and the in-app key store can import / generate / export keys; hosts can be imported from ~/.ssh/config and .xsh session files; ProxyJump jump hosts (multi-hop); terminal status bar, session logging and saving the screen contents); host key confirmation on first use / on change; a command input bar; SFTP split panel (browse / upload & download / rename / delete; Xftp-style in-app editing, permissions, filtering; multi-select and folder batch upload / download; resumable transfers; opens in the terminal's current folder and can follow cd; cut / paste to move files; can be opened as a standalone window, drag-and-drop files to upload); database connections with an SSH tunnel configured can open a terminal directly; the AI only suggests commands, which the user sends with a button (dangerous commands are graded and confirmed) | ✅ Done |
| — | **FTP / FTPS hosts** (suppaftp + rustls): share the frontend file panel and `ssh_sftp_*` commands with SFTP (dispatched by `FileClient`); explicit / implicit TLS, self-signed certificate fingerprint TOFU, passive / active mode; one browsing connection + a separate connection per transfer (at most two per host, the rest queued); resumable transfers (`REST` / `APPE`, with the tail of the already-transferred part checked before resuming) | ✅ Done |
| — | **SSH activity log**: commands run in the terminal (read from the screen on Enter, not from keystrokes, so text typed at password prompts is not captured; password arguments in commands are replaced with ***), SFTP / FTP file actions, connects and disconnects; one JSONL file per day with a configurable retention period; query by time / host / type / keyword, export to CSV | ✅ Done |
| — | **Docker / Docker Registry / Harbor** (`docker` feature, all via the existing reqwest): Docker Engine API (local socket / named pipe, TCP, TLS / mTLS, via SSH Tunnel), container / image / volume / network tree, container info / logs / shell / resources / processes, one-click connection creation for database containers, overview and cleanup, image pulls; Registry v2 (token exchange, multi-platform manifests, delete by tag); Harbor v2.0 API (artifacts, vulnerability scanning, quotas, component health); pulling Registry / Harbor images into Docker | ✅ Done |
| — | **Kubernetes** (without kube-rs; REST + our own WebSocket frame handling): kubeconfig / token / client certificate / exec external login commands (EKS / GKE / AKS), namespace-restricted, via SSH Tunnel; namespace → kind → resource tree, overview / events / YAML (server-side dry-run trial apply, resourceVersion conflicts blocked), Pod log / exec / metrics, scale replicas / restart / CronJob / cordon / delete; port-forward (a Service picks a ready Pod, automatically re-targets after the Pod is recreated) and database connections "via Kubernetes port-forward"; resource browser (including CRDs), applying multi-document YAML, cluster overview | ✅ Done |
| — | **File / folder / binary compare** (`filecmp` module, shared by the GUI compare tab and `dbk diff` / `dbk sync`): any combination of local and SFTP / FTP hosts; text compare with per-hunk apply and save back (checks for external modification before saving), folder compare (three criteria: size + time / size / content, exclusion rules, case-insensitive) with five sync rules, hex compare (large files only read the scrolled-to region); saved compares and recent compares | ✅ Done |
| — | **Consistent sidebar grouping**: database connections get one section per kind, and SSH hosts and remote desktops each get their own section; all three share collapsible headers, groups, drag-to-reorder and drag in / out | ✅ Done |
| — | **Remote desktop (RDP / VNC / Mac Screen Sharing)**: a separate "Remote Desktop" list in the sidebar (with folders; appears only when there are hosts), screen embedded in a tab (RDP via IronRDP with TLS / NLA, certificate confirmation on first use, dirty regions + backpressure; VNC via noVNC with the backend handling authentication including Apple ARD, passwords never reach the frontend), full screen (Ctrl+Alt+Enter, with a floating toolbar to send Ctrl+Alt+Del / Win / Alt+Tab), dynamic resolution / scaling / original size, can be relayed through a saved SSH host, import of connection strings (both rdp:// forms, mstsc /v:, vnc://, rustdesk://) and .rdp files | ✅ Done |
| — | Remote desktop phase 2: RDP / VNC clipboard text sync (the system clipboard is read / written by the backend), Windows low-level keyboard capture (in full screen, Win / Alt+Tab / Alt+F4 / Ctrl+Esc go straight to the remote) | ✅ Done |
| — | Remote desktop phase 3: VeNCrypt TLS, RDP clipboard images / files, macOS full-screen key capture (requires Accessibility permission) | ⏳ Planned |
| — | RustDesk-compatible connections phase 1: standalone AGPL helper `rustdesk-bridge/` (talks to db-kit over stdin / stdout), Direct IP, password login / remote side clicks Accept, VP9 / VP8 video passed untouched to the WebView's WebCodecs decoder, keyboard and mouse, can be relayed through an SSH host | ✅ Done |
| — | RustDesk phase 2: connect by RustDesk ID — ID server (hbbs, public or self-hosted + key) → direct connection via TCP hole punching, falling back to the relay (hbbr) → signature-verified end-to-end encryption (box / secretbox key exchange); a server config string exported from RustDesk can be pasted in | ✅ Done |
| — | RustDesk multi-monitor: one toolbar button per monitor to switch, and "All monitors" stitches them into one image following their arrangement; updates when the remote side plugs / unplugs monitors or changes resolution | ✅ Done |
| — | RustDesk toolbar: display settings (view mode / image quality / codec / connection quality), actions (Ctrl+Alt+Del / lock / block input / restart), clipboard text sync, chat, recording; keyboard key codes translated for the remote OS and carrying lock-key state; virtual keyboard, typing the OS password, keyboard mode (map / translate); automatic reconnect on disconnect | ✅ Done |
| — | RustDesk file transfer: dual panes (local / remote), upload / download entire folders, rename and delete; the transfer list and same-name handling are shared with SFTP | ✅ Done |
| — | RustDesk screen and cursor: cursor takes the remote side's shape, show the remote cursor, custom scaling, true color 4:4:4, follow the remote side when it switches monitors, reverse scroll wheel, screenshots | ✅ Done |
| — | RustDesk phase 3: audio, UDP / IPv6 hole punching, resumable file transfers | ⏳ Planned |
| — | VNC toolbar: display settings (view mode / image quality / view only / cursor dot), actions (Ctrl+Alt+Del / refresh / VM power), screenshots, recording; virtual keyboard, typing out clipboard text character by character, automatic reconnect on disconnect | ✅ Done |
| — | VNC encryption: VeNCrypt anonymous TLS (home-grown ECDH_anon TLS 1.2 client) and X509 certificate TLS (rustls, certificate confirmation on first use, TOFU shared with RDP); "Auto" prefers encryption | ✅ Done |
| — | VNC encryption: RSA-AES | ⏳ Planned |
| — | Query performance analysis (EXPLAIN) | ✅ Done |
| — | Structure editing (DDL: add / drop / rename columns) | ✅ Done |
| — | ER diagram (tables + foreign key relationships) | ✅ Done |
| — | Redis enhancements (modeled on Another Redis): key row context menu (view / copy key name / rename / set TTL / delete), DB node context menu (new key / flush DB / server status / console), server status panel (key INFO metrics + all sections, with optional auto-refresh), command-line console (command history ↑/↓, DB switching, clear) | ✅ Done |
| — | Index management (create / drop; MySQL / PostgreSQL / SQLite / MongoDB) | ✅ Done |
| — | Ping existing connections (measures round-trip latency, including through SSH tunnels) | ✅ Done |
| — | MongoDB query enhancements: sort / projection / limit, **aggregation pipeline**, batch insert / update / delete (CRUD-via-JSON) | ✅ Done |
| — | Query editor shows `RETURNING` results (PostgreSQL / SQLite) | ✅ Done |
| — | **CSV data import** (RFC4180 parsing, empty field → NULL, per-row reporting) | ✅ Done |
| — | Dump the whole database's schema SQL (CREATE TABLE statements for all tables) | ✅ Done |
| — | PostgreSQL strict-typing write fixes (CRUD with integer / composite primary keys, native comparison for numeric range filters) | ✅ Done |
| — | **Visual Query Builder** (inspired by familiar desktop database tools): tick tables / columns, automatic JOINs from foreign keys, WHERE / GROUP BY aggregates / HAVING / ORDER BY / DISTINCT / LIMIT / OFFSET, live preview + row count, inserted into the editor; can be opened from a table's context menu | ✅ Done |
| — | **Excel (.xlsx) export / import** (rust_xlsxwriter / calamine, pure Rust): numeric fidelity, frozen header + auto column width, imports the first worksheet | ✅ Done |
| — | **Query result export** unified through the backend pipeline (CSV / TSV / Excel / JSON / SQL / Markdown) | ✅ Done |
| — | **SQL snippet library** (Snippets): editor autocompletion + toolbar management, 11+ built-in templates | ✅ Done |
| — | **Data Transfer**: copy table data across connections / databases, intersection of same-named columns, auto-create the target table when it doesn't exist (same kind), transfer many tables of a whole database at once | ✅ Done |
| — | **Data compare / sync** (Data Synchronization): compares two tables by primary key and generates INSERT / UPDATE / DELETE sync DML (on common columns) | ✅ Done |
| — | **Schema / data compare v2** (Rust engine, shared by the GUI and `dbk compare`): schema compare covers indexes / foreign keys / defaults / comments / views / procedures and generates bidirectional DDL (including DROP, with destructive grading); data compare switched to primary-key-ordered streaming merge-join (automatically falls back to hashing when collations differ), **no 20k-row limit**, works for a single table or a whole database, with a quick pre-check; sync SQL can be applied directly to the target in batched transactions; schema snapshots can be saved (JSON) and compared against a live database or another snapshot; Markdown / HTML / JSON reports; supports MySQL / MariaDB / PostgreSQL / SQLite / SQL Server / Oracle | ✅ Done |
| — | **Bidirectional foreign key navigation**: jump from a cell to the referenced row; from a primary key cell, find the rows that reference it | ✅ Done |
| — | **Command palette** (Ctrl/Cmd+K): fuzzy search to jump to connections / databases / tables / actions | ✅ Done |
| — | **Read-only connection mode**: blocks writes / DDL in queries as well as write actions in data cells / the sidebar; **connection color tags** to distinguish environments; **pinned favorite tables** | ✅ Done |
| — | **Parameterized queries** `:name`: prompts for values before execution and substitutes them safely (dialect escaping, `::type` not misdetected) | ✅ Done |
| — | **SQL editor**: format / compress to a single line / keyword case, Copy as IN, distinct-value distribution | ✅ Done |
| — | **Whole-database documentation** (HTML / Markdown report, with a table of contents) | ✅ Done |
| — | **Cross-database query autocompletion** (multiple databases / schemas on the same connection): nested schema namespaces, `otherdb.` loaded on demand, qualified names resolved to exact tables, toolbar "Cross-DB" multi-select preloading, AI review includes cross-database schemas | ✅ Done |
| — | **AI read-only database tools**: the assistant can list / describe / sample / SELECT / EXPLAIN on its own (one statement at a time, 200 rows / 8 KB / 30 seconds limit, writes are mechanically impossible); the SQL and results of every call are listed in the reply for auditing; built in for API providers, while CLI providers use the new `dbk mcp` (a hand-written MCP stdio server) | ✅ Done |
| — | **Editor AI actions + diff preview**: explain / optimize / fix / add comments / convert dialect / generate test data / explain the plan in plain language; `Ctrl+I` for in-place natural-language instructions; rewrites are always shown as a per-hunk diff first, and accepting them enters the undo history | ✅ Done |
| — | **DBA agent review + AI library**: personas / skills / all prompt templates moved to static Markdown files (format-compatible with Claude Code subagents and Agent Skills), three override layers built-in < personal < team folder, locked output contract, guaranteed required variables, frontend and backend share test cases pinning the same template engine; the DBA can verify things itself with read-only tools (the persona determines the tool whitelist and turn limit), multiple DBAs can review jointly with the strictest conclusion taken; three entry points (editor SQL, Review & Run, table structure); one-click sync to Claude Code / Codex (never overwrites the user's own files); `dbk ai list / show / lint / sync`, `dbk run --persona`, `dbk mcp --tools` | ✅ Done |
| — | **Review & Run** (shared by the GUI and `dbk run`): AI review → per-statement before-image capture → rollback statements persisted first → execute → after-image capture and comparison; lossless value capture by type (BLOB / time zones / floating-point precision); DDL rollback reuses the Schema compare generator; script, review, `rollback.sql`, `diff.md` and snapshots are written to a specified directory; transaction-control / session-state statements block the entire script; write statements from the AI assistant go through the same flow; end-to-end restore verified on MySQL / PostgreSQL / SQL Server / SQLite | ✅ Done |
| — | **Chat panel enhancements**: `@` to specify attached scope (table / database / file / query / result / error, with a budget and an account of what "couldn't be attached"), `/` slash commands, run SQL blocks in place and feed results back, conversation history persistence for HTTP providers, `Ctrl+L` to focus | ✅ Done |

## Backup mechanisms per database (planned)

| Database | Backup method | Strategy |
|--------|----------|------|
| MySQL | Logical export (SQL) | Prefer mysqldump; otherwise assemble it ourselves via sqlx |
| PostgreSQL | pg_dump | Call the system pg_dump |
| SQLite | File copy / .dump | Copy the file directly or use VACUUM INTO |
| MongoDB | BSON / JSON | Prefer mongodump |
| Redis | RDB / per key | BGSAVE or DUMP/RESTORE |

Strategy: official CLI tools first, with the built-in logical export as a fallback. Detect whether the official tools are installed on the user's machine; use them if present, otherwise degrade gracefully.

## Security notes (planned)

- Backup files contain sensitive data → provide an AES encryption option.
- Backup settings (including passwords) → stored in the OS keychain.
- Restores and destructive operations such as DROP → require a second confirmation.
