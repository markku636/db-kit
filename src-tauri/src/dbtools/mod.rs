//! 唯讀資料庫工具：AI 助手可自己「看資料庫」的那一組能力。
//!
//! 兩個消費者共用同一份實作，避免兩邊漂移成「這裡擋、那裡不擋」：
//! - GUI 的 HTTP 供應商工具迴圈（`llm::tools`），直接呼叫 `call`；
//! - `dbk mcp`（`cli::mcp`）以 MCP stdio 伺服器把同一組工具提供給 Claude Code / Codex。
//!
//! 安全邊界：
//! - **永遠唯讀**。SQL 走 `cli::guard::read_only_violation(.., strict_explain = true)`
//!   （連 `EXPLAIN ANALYZE DELETE` 也擋，PostgreSQL 會真的執行內層語句）；
//!   MongoDB 拒絕 `$out` / `$merge` 階段；Redis 只放行讀取類命令白名單。
//! - 一次一條語句、列數 / 位元組 / 逾時三道上限——工具回傳是要塞進模型上下文的，
//!   一張寬表就足以把整段對話擠掉。
//! - 只認連線 id，永不接觸帳密；連線是否存在由 `ConnectionManager` 決定。
//!
//! 本模組不依賴 Tauri / reqwest，slim CLI（`--no-default-features`）也編得進來。

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::cli::guard::{self, ReadOnlyViolation};
use crate::db::{ColumnInfo, DataQuery, DbKind, ForeignKeyInfo, IndexInfo, PagedData, QueryResult};
use crate::manager::ConnectionManager;

/// 工具回傳文字的位元組上限（超過截斷並註明）。
pub const MAX_TEXT_BYTES: usize = 8 * 1024;
/// 單一儲存格字元上限（長 JSON / blob 只給前段）。
pub const MAX_CELL_CHARS: usize = 200;
/// 最多列出的欄數（寬表只給前段欄位）。
pub const MAX_COLS: usize = 60;
/// run_query 的列數上限與預設值。
pub const MAX_QUERY_ROWS: usize = 200;
pub const DEFAULT_QUERY_ROWS: usize = 100;
/// sample_rows 的列數上限與預設值。
pub const MAX_SAMPLE_ROWS: usize = 20;
pub const DEFAULT_SAMPLE_ROWS: usize = 10;
/// list_* 的筆數上限。
pub const MAX_LIST: usize = 500;
/// 工具逾時（毫秒）：沿用全域查詢逾時，未設（0 = 關）時退 30 秒；再高也夾在 60 秒。
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 60_000;

/// 工具名稱（與 MCP `tools/list`、Claude `--allowedTools` 的 `mcp__dbkit__<name>` 一致）。
pub const TOOL_NAMES: &[&str] = &[
    "list_databases",
    "list_tables",
    "describe_table",
    "sample_rows",
    "run_query",
    "explain_query",
];

pub fn is_db_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// 一次對話綁定的連線上下文。`database` 是前端「目前看的庫」，工具參數省略 database 時的預設值。
#[derive(Clone)]
pub struct DbToolCtx {
    pub manager: Arc<ConnectionManager>,
    pub conn_id: String,
    pub kind: DbKind,
    pub database: Option<String>,
    /// 連線標記為正式環境（`options.prod == "1"`）：工具說明會多提醒模型保持查詢輕量。
    pub prod: bool,
}

impl DbToolCtx {
    /// 由已連線的 manager 建立；連線不存在（未連線 / 已斷）回 Err 字串。
    pub fn from_manager(
        manager: Arc<ConnectionManager>,
        conn_id: &str,
        database: Option<&str>,
    ) -> Result<DbToolCtx, String> {
        let kind = manager.kind(conn_id).map_err(|e| e.message())?;
        let prod = manager.is_prod(conn_id).unwrap_or(false);
        Ok(DbToolCtx {
            manager,
            conn_id: conn_id.to_string(),
            kind,
            database: database.map(str::trim).filter(|s| !s.is_empty()).map(String::from),
            prod,
        })
    }
}

/// 供應商中立的工具定義；`llm::ToolSpec` 與 MCP `inputSchema` 都由此映射。
#[derive(Clone, Debug)]
pub struct ToolDef {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Value,
}

/// 一次工具執行的結果（給模型的文字 + 給 UI 的摘要欄位）。
#[derive(Clone, Debug, Default)]
pub struct ToolOutcome {
    /// 給模型看的內容（已套位元組上限）。
    pub text: String,
    /// 供 UI 顯示的輸入摘要：SQL / JSON DSL / `db.table`。
    pub input_label: Option<String>,
    /// 回傳列數（查詢類工具）。
    pub rows: Option<usize>,
    /// 伺服端或文字層有截斷。
    pub truncated: bool,
    pub ms: u64,
}

/// 此連線種類是否有 SQL 方言（唯讀守門走 SQL 關鍵字）。
fn is_sql_kind(kind: DbKind) -> bool {
    matches!(
        kind,
        DbKind::Mysql
            | DbKind::Mariadb
            | DbKind::Postgres
            | DbKind::Sqlite
            | DbKind::Mssql
            | DbKind::Oracle
            | DbKind::External
    )
}

/// 支援 run_query 的種類：SQL 方言 + Mongo（JSON DSL）+ Redis（命令白名單）。
fn supports_query(kind: DbKind) -> bool {
    is_sql_kind(kind) || matches!(kind, DbKind::Mongo | DbKind::Redis)
}

/// 支援 explain_query 的種類（Mongo 的 explain 走驅動內建的 explain）。
fn supports_explain(kind: DbKind) -> bool {
    is_sql_kind(kind) || matches!(kind, DbKind::Mongo)
}

/// 「database」參數可空的種類：SQLite（檔案即庫）、訊息 / 搜尋引擎（list_tables 不看它）。
fn database_optional(kind: DbKind) -> bool {
    matches!(kind, DbKind::Sqlite | DbKind::Kafka | DbKind::Elastic | DbKind::RabbitMq)
}

/// 種類對應的「表」名詞（工具說明用）。
fn table_noun(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Mongo => "collection",
        DbKind::Redis => "key",
        DbKind::Kafka => "topic",
        DbKind::Elastic => "index",
        DbKind::RabbitMq => "queue",
        _ => "table",
    }
}

/// 依連線種類給出可用工具（說明文字會依種類 / 正式環境調整）。
pub fn tool_defs(kind: DbKind, prod: bool) -> Vec<ToolDef> {
    let noun = table_noun(kind);
    let db_prop = json!({ "type": "string", "description": t!("資料庫 / schema 名稱；省略則用目前對話的資料庫") });
    let prod_note = if prod {
        format!(" {}", t!("此為正式環境連線，請保持查詢輕量（小 LIMIT、避免全表掃描）。"))
    } else {
        String::new()
    };
    let mut v = vec![
        ToolDef {
            name: "list_databases",
            description: t!("列出此連線上的資料庫 / schema。").to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "list_tables",
            description: tf!("列出資料庫裡的 {noun}（含視圖）。", noun = noun),
            input_schema: json!({ "type": "object", "properties": { "database": db_prop } }),
        },
        ToolDef {
            name: "describe_table",
            description: tf!(
                "取得一個 {noun} 的欄位（名稱 / 型別 / 可空 / 主鍵 / 預設值 / 註解）、索引與外鍵。寫查詢前請先用它確認欄名。",
                noun = noun
            ),
            input_schema: json!({
                "type": "object",
                "properties": { "database": db_prop, "table": { "type": "string" } },
                "required": ["table"]
            }),
        },
        ToolDef {
            name: "sample_rows",
            description: tf!(
                "抓取一個 {noun} 的前幾列樣本（最多 {max} 列），用來了解資料長相。{prod}",
                noun = noun,
                max = MAX_SAMPLE_ROWS,
                prod = prod_note
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "database": db_prop,
                    "table": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_SAMPLE_ROWS, "description": tf!("預設 {n}", n = DEFAULT_SAMPLE_ROWS) }
                },
                "required": ["table"]
            }),
        },
    ];
    if supports_query(kind) {
        let desc = match kind {
            DbKind::Mongo => tf!(
                // 注意：tf! 的插值只認 `{ident}`，其餘大括號原樣保留，故 JSON 範例直接寫單層大括號。
                "對目前連線執行**唯讀** MongoDB 查詢。參數 query 為 JSON：find 用 {\"collection\":\"..\",\"filter\":{},\"sort\":{},\"projection\":{},\"limit\":N}；聚合用 {\"collection\":\"..\",\"pipeline\":[…]}（省略 db 則用目前資料庫）。禁止 $out / $merge 與任何寫入。結果最多 {max} 列、{kb} KB。{prod}",
                max = MAX_QUERY_ROWS,
                kb = MAX_TEXT_BYTES / 1024,
                prod = prod_note
            ),
            DbKind::Redis => tf!(
                "對目前連線執行**唯讀** Redis 命令（如 GET k、HGETALL h、SCAN 0 MATCH user:* COUNT 100；可用 \"2:GET k\" 指定 DB index）。只放行讀取類命令；KEYS 會全庫掃描，請改用 SCAN。{prod}",
                prod = prod_note
            ),
            _ => tf!(
                "對目前連線執行**唯讀** SQL（單一語句）。寫 SQL 前請先用 describe_table 確認欄名；一律加 LIMIT（結果最多 {max} 列、{kb} KB）。禁止 INSERT / UPDATE / DELETE / DDL；可寫 CTE 與 EXPLAIN ANALYZE 寫入語句也會被擋。{prod}",
                max = MAX_QUERY_ROWS,
                kb = MAX_TEXT_BYTES / 1024,
                prod = prod_note
            ),
        };
        let query_desc = match kind {
            DbKind::Mongo => t!("MongoDB 查詢 JSON").to_string(),
            DbKind::Redis => t!("Redis 命令列").to_string(),
            _ => t!("要執行的 SQL（單一語句）").to_string(),
        };
        v.push(ToolDef {
            name: "run_query",
            description: desc,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": query_desc },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_QUERY_ROWS, "description": tf!("結果列數上限，預設 {n}", n = DEFAULT_QUERY_ROWS) }
                },
                "required": ["query"]
            }),
        });
    }
    if supports_explain(kind) {
        v.push(ToolDef {
            name: "explain_query",
            description: t!("取得一條唯讀查詢的執行計畫（EXPLAIN），用來判斷索引是否用上、哪個節點最貴。不會執行寫入語句。").to_string(),
            input_schema: json!({
                "type": "object",
                "properties": { "query": { "type": "string", "description": t!("要解釋的查詢（單一語句）") } },
                "required": ["query"]
            }),
        });
    }
    v
}

// ---- 純函式（可測）----

/// 把模型給的 limit 夾進 [1, max]；缺省 / 非數字 / 非正數用預設值。
pub fn clamp_limit(v: Option<i64>, default: usize, max: usize) -> usize {
    match v {
        Some(n) if n > 0 => (n as usize).min(max),
        _ => default.min(max),
    }
}

fn tool_timeout_ms() -> u64 {
    let g = crate::db::limits::timeout_ms();
    let ms = if g == 0 { DEFAULT_TIMEOUT_MS } else { g };
    ms.min(MAX_TIMEOUT_MS)
}

/// Redis 讀取類命令白名單（大寫）。`KEYS` 放行但工具說明勸改用 SCAN。
const REDIS_READ_ONLY: &[&str] = &[
    "GET", "MGET", "GETRANGE", "STRLEN", "EXISTS", "TYPE", "TTL", "PTTL", "HGET", "HGETALL", "HKEYS", "HVALS",
    "HLEN", "HMGET", "HEXISTS", "LRANGE", "LLEN", "LINDEX", "LPOS", "SMEMBERS", "SCARD", "SISMEMBER", "SMISMEMBER",
    "SRANDMEMBER", "ZRANGE", "ZRANGEBYSCORE", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZRANGEBYLEX", "ZCARD", "ZCOUNT",
    "ZSCORE", "ZRANK", "ZREVRANK", "ZMSCORE", "SCAN", "SSCAN", "HSCAN", "ZSCAN", "KEYS", "DBSIZE", "INFO", "PING",
    "ECHO", "TIME", "RANDOMKEY", "OBJECT", "MEMORY", "XRANGE", "XREVRANGE", "XLEN", "XINFO", "PFCOUNT", "BITCOUNT",
    "GETBIT", "GEOPOS", "GEODIST", "GEOHASH", "JSON.GET", "JSON.TYPE", "JSON.STRLEN", "JSON.ARRLEN", "JSON.OBJKEYS",
    "FT.SEARCH", "FT.INFO", "TS.GET", "TS.RANGE", "CONFIG", "CLIENT", "COMMAND", "LASTSAVE", "DUMP",
];

/// Redis 子命令有寫入變體者：`CONFIG SET`、`CLIENT KILL`、`MEMORY PURGE`、`OBJECT` 皆讀。
fn redis_subcommand_blocked(cmd: &str, sub: Option<&str>) -> bool {
    let sub = sub.map(|s| s.to_ascii_uppercase());
    match cmd {
        "CONFIG" => !matches!(sub.as_deref(), Some("GET")),
        "CLIENT" => !matches!(sub.as_deref(), Some("LIST") | Some("INFO") | Some("ID") | Some("GETNAME")),
        "MEMORY" => matches!(sub.as_deref(), Some("PURGE")),
        _ => false,
    }
}

/// 拆 Redis 命令列：`[db:]COMMAND args…` → (COMMAND 大寫, 第二個 token)。
fn redis_head(cmdline: &str) -> (String, Option<String>) {
    let rest = match cmdline.split_once(':') {
        Some((maybe_db, rest)) if maybe_db.trim().parse::<i64>().is_ok() => rest.trim(),
        _ => cmdline.trim(),
    };
    let mut it = rest.split_whitespace();
    let cmd = it.next().unwrap_or("").to_ascii_uppercase();
    let sub = it.next().map(|s| s.to_string());
    (cmd, sub)
}

/// Mongo 查詢 JSON 允許的頂層鍵。
const MONGO_TOP_KEYS: &[&str] = &["db", "collection", "filter", "sort", "projection", "limit", "pipeline"];
/// 會寫入的聚合階段。
const MONGO_WRITE_STAGES: &[&str] = &["$out", "$merge"];

/// 依連線種類檢查查詢是否唯讀。Err 內容是給模型看的說明（讓它改寫，而不是重試同一句）。
pub fn ensure_tool_read_only(kind: DbKind, query: &str) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err(t!("query 不可為空").to_string());
    }
    if is_sql_kind(kind) {
        if guard::statement_count(query) > 1 {
            return Err(t!("一次只能執行一條語句；請拆成多次呼叫").to_string());
        }
        return match guard::read_only_violation(query, true) {
            None => Ok(()),
            Some(ReadOnlyViolation::Statement(kw)) => {
                Err(tf!("唯讀工具只允許查詢語句（偵測到 `{kw}`）；不要嘗試寫入", kw = kw))
            }
            Some(ReadOnlyViolation::WritableCte(w)) => {
                Err(tf!("唯讀工具不允許可寫 CTE（含 `{w}`）", w = w))
            }
            Some(ReadOnlyViolation::ExplainInner(w)) => {
                Err(tf!("唯讀工具不允許 EXPLAIN 寫入語句（含 `{w}`；EXPLAIN ANALYZE 會真的執行）", w = w))
            }
        };
    }
    match kind {
        DbKind::Mongo => {
            let v: Value = serde_json::from_str(query)
                .map_err(|e| tf!("MongoDB 查詢必須是 JSON 物件：{e}", e = e))?;
            let obj = v.as_object().ok_or_else(|| t!("MongoDB 查詢必須是 JSON 物件").to_string())?;
            if !obj.contains_key("collection") {
                return Err(t!("缺少 collection").to_string());
            }
            for k in obj.keys() {
                if !MONGO_TOP_KEYS.contains(&k.as_str()) {
                    return Err(tf!("不允許的鍵：{k}（只接受 db / collection / filter / sort / projection / limit / pipeline）", k = k));
                }
            }
            if let Some(p) = obj.get("pipeline") {
                let arr = p.as_array().ok_or_else(|| t!("pipeline 必須是陣列").to_string())?;
                for stage in arr {
                    let so = stage.as_object().ok_or_else(|| t!("pipeline 每個階段必須是物件").to_string())?;
                    for k in so.keys() {
                        if MONGO_WRITE_STAGES.contains(&k.as_str()) {
                            return Err(tf!("唯讀工具不允許 {k} 階段", k = k));
                        }
                    }
                }
            }
            Ok(())
        }
        DbKind::Redis => {
            let (cmd, sub) = redis_head(query);
            if cmd.is_empty() {
                return Err(t!("空命令").to_string());
            }
            if !REDIS_READ_ONLY.contains(&cmd.as_str()) || redis_subcommand_blocked(&cmd, sub.as_deref()) {
                return Err(tf!("唯讀工具不允許 Redis 命令 `{cmd}`；只放行讀取類命令（GET / HGETALL / SCAN / TTL …）", cmd = cmd));
            }
            Ok(())
        }
        _ => Err(t!("此連線種類不支援 run_query；請改用 list_tables / describe_table / sample_rows").to_string()),
    }
}

/// 結果集 → 純文字表格的選項。
#[derive(Clone, Copy)]
pub struct FormatOpts {
    pub max_bytes: usize,
    pub max_cell_chars: usize,
    pub max_cols: usize,
}

impl Default for FormatOpts {
    fn default() -> Self {
        FormatOpts { max_bytes: MAX_TEXT_BYTES, max_cell_chars: MAX_CELL_CHARS, max_cols: MAX_COLS }
    }
}

fn cell_text(c: &Option<String>, max_chars: usize) -> String {
    match c {
        None => "NULL".to_string(),
        Some(s) => {
            let mut out: String = s.chars().take(max_chars).collect();
            if s.chars().count() > max_chars {
                out.push('…');
            }
            out.replace('|', "\\|").replace('\n', "⏎").replace('\r', "")
        }
    }
}

/// 把 (columns, rows) 排成 `a | b | c` 純文字；回 (文字, 是否因位元組上限截斷)。
/// 位元組上限一到就停，不切在列中間；欄超過 max_cols 只給前段並註明。
pub fn format_rows(columns: &[String], rows: &[Vec<Option<String>>], opts: &FormatOpts) -> (String, bool) {
    let ncols = columns.len().min(opts.max_cols);
    let mut out = String::new();
    let header: Vec<String> = columns.iter().take(ncols).map(|c| c.replace('|', "\\|")).collect();
    out.push_str(&header.join(" | "));
    if columns.len() > ncols {
        out.push_str(&tf!(" | …（另有 {n} 欄未列出）", n = columns.len() - ncols));
    }
    let mut truncated = false;
    let mut shown = 0usize;
    for r in rows {
        let cells: Vec<String> = r.iter().take(ncols).map(|c| cell_text(c, opts.max_cell_chars)).collect();
        let line = cells.join(" | ");
        if out.len() + 1 + line.len() > opts.max_bytes {
            truncated = true;
            break;
        }
        out.push('\n');
        out.push_str(&line);
        shown += 1;
    }
    if truncated {
        out.push('\n');
        out.push_str(&tf!("…（文字達 {kb} KB 上限，只顯示前 {shown} 列，共取回 {total} 列）", kb = opts.max_bytes / 1024, shown = shown, total = rows.len()));
    }
    (out, truncated)
}

pub fn format_result(q: &QueryResult, opts: &FormatOpts) -> (String, bool) {
    if q.columns.is_empty() {
        return (tf!("（無結果集；rows_affected = {n}）", n = q.rows_affected), false);
    }
    format_rows(&q.columns, &q.rows, opts)
}

pub fn format_paged(p: &PagedData, opts: &FormatOpts) -> (String, bool) {
    format_rows(&p.columns, &p.rows, opts)
}

fn column_line(c: &ColumnInfo) -> String {
    let mut s = format!("- {} {}", c.name, c.data_type);
    if c.key == "PRI" {
        s.push_str(" PK");
    } else if c.key == "UNI" {
        s.push_str(" UNIQUE");
    }
    if !c.nullable {
        s.push_str(" NOT NULL");
    }
    if let Some(d) = &c.default {
        if !d.is_empty() {
            s.push_str(&format!(" DEFAULT {d}"));
        }
    }
    if !c.extra.is_empty() {
        s.push(' ');
        s.push_str(&c.extra);
    }
    if !c.comment.is_empty() {
        let short: String = c.comment.chars().take(80).collect();
        s.push_str(&format!(" -- {short}"));
    }
    s
}

fn index_line(i: &IndexInfo) -> String {
    let flag = if i.primary { " PRIMARY" } else if i.unique { " UNIQUE" } else { "" };
    format!("- {} ({}){}", i.name, i.columns.join(", "), flag)
}

fn fk_line(f: &ForeignKeyInfo) -> String {
    format!("- {} → {}.{}", f.column, f.ref_table, f.ref_column)
}

/// 組 describe_table 的文字（純函式以便測試；索引 / 外鍵抓不到就明講）。
pub fn format_describe(
    label: &str,
    cols: &[ColumnInfo],
    idx: Option<&[IndexInfo]>,
    fks: Option<&[ForeignKeyInfo]>,
    max_bytes: usize,
) -> (String, bool) {
    let mut lines: Vec<String> = Vec::new();
    lines.push(tf!("{label}：{n} 欄", label = label, n = cols.len()));
    if cols.is_empty() {
        lines.push(t!("（無欄位資訊：資料表可能不存在，請用 list_tables 確認名稱）").to_string());
    }
    for c in cols.iter().take(MAX_COLS) {
        lines.push(column_line(c));
    }
    if cols.len() > MAX_COLS {
        lines.push(tf!("（另有 {n} 欄未列出）", n = cols.len() - MAX_COLS));
    }
    lines.push(String::new());
    lines.push(t!("索引：").to_string());
    match idx {
        Some(ix) if !ix.is_empty() => lines.extend(ix.iter().map(index_line)),
        Some(_) => lines.push(t!("（無索引）").to_string()),
        None => lines.push(t!("（無法取得索引資訊；請勿假設任何索引存在）").to_string()),
    }
    lines.push(String::new());
    lines.push(t!("外鍵：").to_string());
    match fks {
        Some(f) if !f.is_empty() => lines.extend(f.iter().map(fk_line)),
        Some(_) => lines.push(t!("（無外鍵）").to_string()),
        None => lines.push(t!("（無法取得外鍵資訊）").to_string()),
    }
    let mut out = String::new();
    let mut truncated = false;
    for l in lines {
        if out.len() + l.len() + 1 > max_bytes {
            truncated = true;
            out.push('\n');
            out.push_str(&t!("…（內容過長，其餘已截斷）"));
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&l);
    }
    (out, truncated)
}

fn list_lines(items: Vec<String>, empty_note: &str) -> (String, bool) {
    if items.is_empty() {
        return (empty_note.to_string(), false);
    }
    let total = items.len();
    let mut shown: Vec<String> = items.into_iter().take(MAX_LIST).collect();
    let truncated = total > shown.len();
    if truncated {
        shown.push(tf!("…（共 {total} 筆，只列前 {n} 筆）", total = total, n = MAX_LIST));
    }
    (shown.join("\n"), truncated)
}

// ---- 執行 ----

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

/// 決定這次呼叫的資料庫：參數 → 對話預設 → 可空種類給空字串 → 要模型先指定。
fn resolve_db(ctx: &DbToolCtx, args: &Value) -> Result<String, String> {
    if let Some(d) = arg_str(args, "database") {
        return Ok(d.to_string());
    }
    if let Some(d) = &ctx.database {
        return Ok(d.clone());
    }
    if database_optional(ctx.kind) {
        return Ok(String::new());
    }
    Err(t!("未指定 database：請先呼叫 list_databases，再以 database 參數指定").to_string())
}

async fn with_timeout<T, F>(fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let ms = tool_timeout_ms();
    match tokio::time::timeout(Duration::from_millis(ms), fut).await {
        Ok(r) => r,
        Err(_) => Err(tf!("工具逾時（{ms} ms）；請縮小查詢範圍或加 LIMIT", ms = ms)),
    }
}

/// Mongo：query JSON 省略 db 時補上目前資料庫（模型多半只知道 collection）。
fn mongo_inject_db(query: &str, db: &str) -> String {
    if db.is_empty() {
        return query.to_string();
    }
    match serde_json::from_str::<Value>(query) {
        Ok(Value::Object(mut m)) if !m.contains_key("db") => {
            m.insert("db".to_string(), Value::String(db.to_string()));
            Value::Object(m).to_string()
        }
        _ => query.to_string(),
    }
}

/// 執行一支工具。Err 為給模型看的錯誤文字（迴圈會標成 is_error 回傳，讓模型自行修正）。
pub async fn call(ctx: &DbToolCtx, name: &str, args: &Value) -> Result<ToolOutcome, String> {
    let started = Instant::now();
    let m = &ctx.manager;
    let id = ctx.conn_id.as_str();
    let opts = FormatOpts::default();
    let mut out = match name {
        "list_databases" => {
            let dbs = with_timeout(async { m.list_databases(id).await.map_err(|e| e.message()) }).await?;
            let (text, truncated) = list_lines(dbs, &t!("（此連線沒有可列出的資料庫）"));
            ToolOutcome { text, truncated, ..Default::default() }
        }
        "list_tables" => {
            let db = resolve_db(ctx, args)?;
            let tables = with_timeout(async { m.list_tables(id, &db).await.map_err(|e| e.message()) }).await?;
            let n = tables.len();
            let items = tables
                .into_iter()
                .map(|t| if t.kind == "view" { format!("{} (view)", t.name) } else { t.name })
                .collect();
            let (text, truncated) = list_lines(items, &t!("（此資料庫沒有資料表）"));
            ToolOutcome { text, input_label: Some(db), rows: Some(n), truncated, ..Default::default() }
        }
        "describe_table" => {
            let db = resolve_db(ctx, args)?;
            let table = arg_str(args, "table").ok_or_else(|| t!("缺少 table").to_string())?;
            let label = if db.is_empty() { table.to_string() } else { format!("{db}.{table}") };
            let cols = with_timeout(async { m.table_columns(id, &db, table).await.map_err(|e| e.message()) }).await?;
            // 索引 / 外鍵是加值：驅動不支援或失敗就明講「無法取得」，不讓整支工具失敗。
            let idx = m.table_indexes(id, &db, table).await.ok();
            let fks = m.list_foreign_keys(id, &db, table).await.ok();
            let (text, truncated) = format_describe(&label, &cols, idx.as_deref(), fks.as_deref(), MAX_TEXT_BYTES);
            ToolOutcome { text, input_label: Some(label), rows: Some(cols.len()), truncated, ..Default::default() }
        }
        "sample_rows" => {
            let db = resolve_db(ctx, args)?;
            let table = arg_str(args, "table").ok_or_else(|| t!("缺少 table").to_string())?;
            let limit = clamp_limit(arg_i64(args, "limit"), DEFAULT_SAMPLE_ROWS, MAX_SAMPLE_ROWS);
            let q = DataQuery { page: 0, page_size: limit as u32, filters: Vec::new(), sorts: Vec::new(), match_any: false, count: false };
            let page = with_timeout(async { m.table_data(id, &db, table, &q).await.map_err(|e| e.message()) }).await?;
            let label = if db.is_empty() { table.to_string() } else { format!("{db}.{table}") };
            let (mut text, truncated) = format_paged(&page, &opts);
            text.push_str(&tf!("\n（樣本 {n} 列）", n = page.rows.len()));
            ToolOutcome { text, input_label: Some(label), rows: Some(page.rows.len()), truncated, ..Default::default() }
        }
        "run_query" => {
            if !supports_query(ctx.kind) {
                return Err(t!("此連線種類不支援 run_query；請改用 list_tables / describe_table / sample_rows").to_string());
            }
            let query = arg_str(args, "query").or_else(|| arg_str(args, "sql")).ok_or_else(|| t!("缺少 query").to_string())?;
            ensure_tool_read_only(ctx.kind, query)?;
            let limit = clamp_limit(arg_i64(args, "limit"), DEFAULT_QUERY_ROWS, MAX_QUERY_ROWS);
            let cap = {
                let g = crate::db::limits::row_cap();
                if g > 0 { limit.min(g) } else { limit }
            };
            let effective = if matches!(ctx.kind, DbKind::Mongo) {
                mongo_inject_db(query, &resolve_db(ctx, args).unwrap_or_default())
            } else {
                query.to_string()
            };
            let res = with_timeout(async { m.query_capped(id, &effective, cap).await.map_err(|e| e.message()) }).await?;
            let (mut text, text_truncated) = format_result(&res, &opts);
            let n = res.rows.len();
            if res.truncated {
                text.push_str(&tf!("\n（顯示 {n} 列；結果已在 {cap} 列處截斷，需要更多請縮小範圍或加條件）", n = n, cap = cap));
            } else {
                text.push_str(&tf!("\n（共 {n} 列）", n = n));
            }
            ToolOutcome { text, input_label: Some(query.to_string()), rows: Some(n), truncated: res.truncated || text_truncated, ..Default::default() }
        }
        "explain_query" => {
            if !supports_explain(ctx.kind) {
                return Err(t!("此連線種類不支援 explain_query").to_string());
            }
            let query = arg_str(args, "query").or_else(|| arg_str(args, "sql")).ok_or_else(|| t!("缺少 query").to_string())?;
            ensure_tool_read_only(ctx.kind, query)?;
            let effective = if matches!(ctx.kind, DbKind::Mongo) {
                mongo_inject_db(query, &resolve_db(ctx, args).unwrap_or_default())
            } else {
                query.to_string()
            };
            let res = with_timeout(async { m.explain(id, &effective).await.map_err(|e| e.message()) }).await?;
            let (text, truncated) = format_result(&res, &opts);
            ToolOutcome { text, input_label: Some(query.to_string()), rows: Some(res.rows.len()), truncated, ..Default::default() }
        }
        other => return Err(tf!("未知的工具：{name}", name = other)),
    };
    out.ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qr(cols: &[&str], rows: Vec<Vec<Option<&str>>>) -> QueryResult {
        QueryResult {
            columns: cols.iter().map(|c| c.to_string()).collect(),
            rows: rows.into_iter().map(|r| r.into_iter().map(|c| c.map(String::from)).collect()).collect(),
            rows_affected: 0,
            truncated: false,
        }
    }

    #[test]
    fn clamp_limit_bounds() {
        assert_eq!(clamp_limit(None, 100, 200), 100);
        assert_eq!(clamp_limit(Some(0), 100, 200), 100);
        assert_eq!(clamp_limit(Some(-5), 100, 200), 100);
        assert_eq!(clamp_limit(Some(50), 100, 200), 50);
        assert_eq!(clamp_limit(Some(999), 100, 200), 200);
        assert_eq!(clamp_limit(None, 500, 200), 200);
    }

    #[test]
    fn format_result_marks_null_and_escapes() {
        let q = qr(&["a", "b"], vec![vec![Some("x|y"), None], vec![Some("line1\nline2"), Some("2")]]);
        let (text, truncated) = format_result(&q, &FormatOpts::default());
        assert!(!truncated);
        assert!(text.starts_with("a | b\n"));
        assert!(text.contains("x\\|y | NULL"));
        assert!(text.contains("line1⏎line2 | 2"));
    }

    #[test]
    fn format_result_respects_byte_cell_and_col_caps() {
        let long = "z".repeat(1000);
        let rows: Vec<Vec<Option<&str>>> = (0..200).map(|_| vec![Some(long.as_str())]).collect();
        let q = qr(&["c"], rows);
        let opts = FormatOpts { max_bytes: 2000, max_cell_chars: 50, max_cols: 60 };
        let (text, truncated) = format_result(&q, &opts);
        assert!(truncated);
        assert!(text.len() < 2300, "footer 之外不可超過上限太多：{}", text.len());
        assert!(text.contains("共取回 200 列"));
        // 儲存格夾 50 字 + 省略號
        assert!(text.contains(&format!("{}…", "z".repeat(50))));
        // 欄數上限
        let cols: Vec<String> = (0..70).map(|i| format!("c{i}")).collect();
        let (text, _) = format_rows(&cols, &[], &FormatOpts { max_cols: 5, ..FormatOpts::default() });
        assert!(text.starts_with("c0 | c1 | c2 | c3 | c4 | …"));
        assert!(text.contains("65"));
    }

    #[test]
    fn format_result_without_columns_reports_rows_affected() {
        let q = QueryResult { columns: vec![], rows: vec![], rows_affected: 3, truncated: false };
        let (text, _) = format_result(&q, &FormatOpts::default());
        assert!(text.contains("rows_affected = 3"));
    }

    #[test]
    fn sql_guard_blocks_writes_multi_and_explain_analyze() {
        assert!(ensure_tool_read_only(DbKind::Mysql, "select * from t limit 5").is_ok());
        assert!(ensure_tool_read_only(DbKind::Postgres, "EXPLAIN (ANALYZE) SELECT 1").is_ok());
        assert!(ensure_tool_read_only(DbKind::Mysql, "delete from t").is_err());
        assert!(ensure_tool_read_only(DbKind::Mysql, "select 1; select 2").is_err());
        assert!(ensure_tool_read_only(DbKind::Postgres, "EXPLAIN ANALYZE DELETE FROM t").is_err());
        assert!(ensure_tool_read_only(DbKind::Postgres, "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d").is_err());
        assert!(ensure_tool_read_only(DbKind::Mysql, "   ").is_err());
        // 錯誤訊息不該提到 CLI（這是 GUI / MCP 工具）。
        let e = ensure_tool_read_only(DbKind::Mysql, "update t set a=1").unwrap_err();
        assert!(!e.contains("CLI"), "{e}");
    }

    #[test]
    fn mongo_guard_blocks_out_merge_and_unknown_keys() {
        assert!(ensure_tool_read_only(DbKind::Mongo, r#"{"collection":"c","filter":{}}"#).is_ok());
        assert!(ensure_tool_read_only(DbKind::Mongo, r#"{"db":"d","collection":"c","pipeline":[{"$match":{}},{"$limit":5}]}"#).is_ok());
        assert!(ensure_tool_read_only(DbKind::Mongo, r#"{"collection":"c","pipeline":[{"$match":{}},{"$out":"x"}]}"#).is_err());
        assert!(ensure_tool_read_only(DbKind::Mongo, r#"{"collection":"c","pipeline":[{"$merge":{"into":"x"}}]}"#).is_err());
        assert!(ensure_tool_read_only(DbKind::Mongo, r#"{"collection":"c","update":{}}"#).is_err());
        assert!(ensure_tool_read_only(DbKind::Mongo, r#"{"filter":{}}"#).is_err());
        assert!(ensure_tool_read_only(DbKind::Mongo, "not json").is_err());
        assert!(ensure_tool_read_only(DbKind::Mongo, "[1,2]").is_err());
    }

    #[test]
    fn redis_guard_allowlist_case_insensitive_with_db_prefix() {
        assert!(ensure_tool_read_only(DbKind::Redis, "get foo").is_ok());
        assert!(ensure_tool_read_only(DbKind::Redis, "2:HGETALL h").is_ok());
        assert!(ensure_tool_read_only(DbKind::Redis, "SCAN 0 MATCH a:* COUNT 10").is_ok());
        assert!(ensure_tool_read_only(DbKind::Redis, "CONFIG GET maxmemory").is_ok());
        assert!(ensure_tool_read_only(DbKind::Redis, "CONFIG SET maxmemory 1").is_err());
        assert!(ensure_tool_read_only(DbKind::Redis, "DEL foo").is_err());
        assert!(ensure_tool_read_only(DbKind::Redis, "flushdb").is_err());
        assert!(ensure_tool_read_only(DbKind::Redis, "0:SET a b").is_err());
        assert!(ensure_tool_read_only(DbKind::Redis, "CLIENT KILL 1").is_err());
        assert!(ensure_tool_read_only(DbKind::Redis, "").is_err());
    }

    #[test]
    fn other_kinds_reject_run_query() {
        assert!(ensure_tool_read_only(DbKind::Kafka, "select 1").is_err());
        assert!(ensure_tool_read_only(DbKind::Elastic, "select 1").is_err());
    }

    #[test]
    fn tool_defs_by_kind() {
        let names = |k: DbKind| tool_defs(k, false).into_iter().map(|d| d.name).collect::<Vec<_>>();
        assert_eq!(names(DbKind::Mysql), TOOL_NAMES);
        assert_eq!(names(DbKind::Kafka), &TOOL_NAMES[..4]);
        assert_eq!(names(DbKind::Redis).len(), 5);
        assert!(names(DbKind::Redis).contains(&"run_query"));
        assert!(!names(DbKind::Redis).contains(&"explain_query"));
        assert!(names(DbKind::Mongo).contains(&"explain_query"));
        let mongo_run = tool_defs(DbKind::Mongo, false).into_iter().find(|d| d.name == "run_query").unwrap();
        assert!(mongo_run.description.contains("JSON"));
        assert!(mongo_run.input_schema["required"].as_array().unwrap().contains(&json!("query")));
        // 正式環境提醒只在 prod 出現。
        let sample_prod = tool_defs(DbKind::Mysql, true).into_iter().find(|d| d.name == "sample_rows").unwrap();
        assert!(sample_prod.description.contains("正式環境"));
        let sample = tool_defs(DbKind::Mysql, false).into_iter().find(|d| d.name == "sample_rows").unwrap();
        assert!(!sample.description.contains("正式環境"));
        // 每支工具都有合法的 object schema。
        for d in tool_defs(DbKind::Postgres, false) {
            assert_eq!(d.input_schema["type"], "object");
            assert!(d.input_schema.get("properties").is_some());
        }
    }

    #[test]
    fn describe_text_states_absence_explicitly() {
        let cols = vec![ColumnInfo {
            name: "id".into(), data_type: "int".into(), nullable: false, key: "PRI".into(),
            default: None, extra: "auto_increment".into(), comment: "主鍵".into(),
        }];
        let (text, _) = format_describe("shop.orders", &cols, Some(&[]), None, MAX_TEXT_BYTES);
        assert!(text.contains("shop.orders：1 欄"));
        assert!(text.contains("- id int PK NOT NULL auto_increment -- 主鍵"));
        assert!(text.contains("（無索引）"));
        assert!(text.contains("無法取得外鍵資訊"));
        let (empty, _) = format_describe("x", &[], None, None, MAX_TEXT_BYTES);
        assert!(empty.contains("資料表可能不存在"));
    }

    #[test]
    fn mongo_inject_db_only_when_missing() {
        assert_eq!(mongo_inject_db(r#"{"collection":"c"}"#, "shop"), r#"{"collection":"c","db":"shop"}"#);
        assert_eq!(mongo_inject_db(r#"{"db":"a","collection":"c"}"#, "shop"), r#"{"db":"a","collection":"c"}"#);
        assert_eq!(mongo_inject_db(r#"{"collection":"c"}"#, ""), r#"{"collection":"c"}"#);
        assert_eq!(mongo_inject_db("bad", "shop"), "bad");
    }

    #[test]
    fn list_lines_caps_and_notes() {
        let items: Vec<String> = (0..600).map(|i| format!("t{i}")).collect();
        let (text, truncated) = list_lines(items, "none");
        assert!(truncated);
        assert!(text.contains("共 600 筆"));
        assert_eq!(text.lines().count(), MAX_LIST + 1);
        let (empty, t2) = list_lines(vec![], "none");
        assert_eq!(empty, "none");
        assert!(!t2);
    }

    #[tokio::test]
    async fn call_without_connection_is_err_not_panic() {
        let ctx = DbToolCtx {
            manager: Arc::new(ConnectionManager::new()),
            conn_id: "nope".into(),
            kind: DbKind::Mysql,
            database: Some("db".into()),
            prod: false,
        };
        assert!(call(&ctx, "list_tables", &json!({})).await.is_err());
        assert!(call(&ctx, "bogus", &json!({})).await.unwrap_err().contains("未知的工具"));
        // 守門在連線之前：寫入語句不會碰到 manager。
        let e = call(&ctx, "run_query", &json!({ "query": "drop table t" })).await.unwrap_err();
        assert!(e.contains("drop"));
        // 缺參數
        assert!(call(&ctx, "describe_table", &json!({})).await.unwrap_err().contains("table"));
        // Kafka 沒有 run_query
        let k = DbToolCtx { kind: DbKind::Kafka, ..ctx.clone() };
        assert!(call(&k, "run_query", &json!({ "query": "x" })).await.is_err());
    }

    #[test]
    fn resolve_db_precedence() {
        let ctx = DbToolCtx {
            manager: Arc::new(ConnectionManager::new()),
            conn_id: "c".into(),
            kind: DbKind::Mysql,
            database: Some("dflt".into()),
            prod: false,
        };
        assert_eq!(resolve_db(&ctx, &json!({ "database": "  other " })).unwrap(), "other");
        assert_eq!(resolve_db(&ctx, &json!({})).unwrap(), "dflt");
        let none = DbToolCtx { database: None, ..ctx.clone() };
        assert!(resolve_db(&none, &json!({})).is_err());
        let sqlite = DbToolCtx { kind: DbKind::Sqlite, database: None, ..ctx.clone() };
        assert_eq!(resolve_db(&sqlite, &json!({})).unwrap(), "");
    }
}
