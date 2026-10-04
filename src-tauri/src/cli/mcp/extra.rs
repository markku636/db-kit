//! `dbk mcp` 專屬的唯讀延伸工具（GUI 內建助手不用，故不放進 `dbtools`）：
//! - `list_connections`：多連線模式列出可用連線（不含帳密）。
//! - `list_routines` / `get_ddl`：程序 / 函式 / 觸發器清單與 DDL、表 / 視圖的 CREATE 語句。
//! - `compare_schema`：兩個庫（可跨連線）的結構差異，選擇性附上同步 DDL——**只產生、不執行**。

use std::time::Duration;

use serde_json::{json, Value};

use crate::compare::ddl::{self, SyncOptions};
use crate::compare::diff::{self, DiffOptions};
use crate::compare::schema::{self, CaptureOptions};
use crate::db::DbKind;
use crate::dbtools::{self, DbToolCtx, FormatOpts};

use super::registry::ConnInfo;

pub const LIST_CONNECTIONS: &str = "list_connections";
pub const LIST_ROUTINES: &str = "list_routines";
pub const GET_DDL: &str = "get_ddl";
pub const COMPARE_SCHEMA: &str = "compare_schema";

/// 結構擷取（兩邊各一次）的時間上限：大庫要幾十秒，再久就是卡住了。
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(180);
/// DDL / 同步腳本可以比一般工具輸出長一點（模型常要整段讀完才能改）。
const MAX_DDL_BYTES: usize = 24 * 1024;

fn is_sql(kind: DbKind) -> bool {
    matches!(kind, DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres | DbKind::Sqlite | DbKind::Mssql | DbKind::Oracle)
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// 在 UTF-8 字元邊界截斷並註明。
pub fn clip(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s.push_str(&tf!("\n…（已截斷，超過 {kb} KB）", kb = max / 1024));
    s
}

/// 工具參數的 database，沒給就用上下文的預設命名空間。
fn database(ctx: &DbToolCtx, args: &Value) -> Result<String, String> {
    if let Some(d) = arg_str(args, "database") {
        return Ok(d.to_string());
    }
    if let Some(d) = &ctx.database {
        return Ok(d.clone());
    }
    if matches!(ctx.kind, DbKind::Sqlite) {
        return Ok(String::new());
    }
    Err(t!("未指定 database：請先呼叫 list_databases，再以 database 參數指定").to_string())
}

pub fn defs() -> Vec<dbtools::ToolDef> {
    let db_prop = json!({ "type": "string", "description": t!("資料庫 / schema 名稱；省略則用目前對話的資料庫") });
    vec![
        dbtools::ToolDef {
            name: LIST_ROUTINES,
            description: t!("列出資料庫裡的預存程序、函式與觸發器（SQL 資料庫）。").to_string(),
            input_schema: json!({ "type": "object", "properties": { "database": db_prop } }),
        },
        dbtools::ToolDef {
            name: GET_DDL,
            description: t!("取得物件的 DDL：資料表 / 視圖的 CREATE 語句，或程序 / 函式 / 觸發器的定義。改結構前先看現況用。").to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "database": db_prop,
                    "name": { "type": "string", "description": t!("物件名稱") },
                    "type": { "type": "string", "enum": ["table", "view", "procedure", "function", "trigger"], "description": t!("物件種類，預設 table") }
                },
                "required": ["name"]
            }),
        },
        dbtools::ToolDef {
            name: COMPARE_SCHEMA,
            description: t!("比對兩個資料庫 / schema 的結構差異（表、欄、索引、外鍵、視圖），可附上讓目標追上來源的同步 DDL。只產生、不執行；要套用請把 SQL 交給 preview_write。").to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "database": { "type": "string", "description": t!("來源資料庫 / schema；省略用目前的") },
                    "target_connection": { "type": "string", "description": t!("目標連線名稱（多連線模式；省略 = 與來源同一條連線）") },
                    "target_database": { "type": "string", "description": t!("目標資料庫 / schema；省略 = 與來源同名") },
                    "sync_sql": { "type": "boolean", "description": t!("附上同步 DDL（預設 false）") },
                    "include_drops": { "type": "boolean", "description": t!("同步 DDL 含 DROP（刪除目標多出的物件；預設 false）") },
                    "ignore_case": { "type": "boolean" },
                    "ignore_comments": { "type": "boolean" },
                    "ignore_defaults": { "type": "boolean" }
                }
            }),
        },
    ]
}

pub fn list_connections_def() -> dbtools::ToolDef {
    dbtools::ToolDef {
        name: LIST_CONNECTIONS,
        description: t!("列出可用的資料庫連線（名稱 / 種類 / 主機 / 預設資料庫 / 是否正式環境）。其他工具都要以 connection 參數指定其中一條。").to_string(),
        input_schema: json!({ "type": "object", "properties": {} }),
    }
}

/// `list_connections` 的文字（`writable` 判斷這條連線能不能走寫入工具）。
pub fn format_connections(list: &[ConnInfo], writable: impl Fn(&ConnInfo) -> bool) -> String {
    if list.is_empty() {
        return t!("（沒有可用的連線：請先在 db-kit 新增連線，或檢查 --connections 白名單）").to_string();
    }
    let mut s = String::new();
    for c in list {
        let mut tags: Vec<String> = Vec::new();
        if c.prod {
            tags.push(t!("正式環境").to_string());
        }
        if writable(c) {
            tags.push(t!("可寫入").to_string());
        }
        let addr = if matches!(c.kind, DbKind::Sqlite) { c.database.clone().unwrap_or_default() } else { format!("{}:{}", c.host, c.port) };
        let db = match (&c.database, c.kind) {
            (Some(d), k) if !d.is_empty() && !matches!(k, DbKind::Sqlite) => format!(" db={d}"),
            _ => String::new(),
        };
        let tags = if tags.is_empty() { String::new() } else { format!(" [{}]", tags.join(", ")) };
        s.push_str(&format!("- {} — {} {}{}{}\n", c.name, c.kind.as_str(), addr, db, tags));
    }
    s
}

pub async fn list_routines(ctx: &DbToolCtx, args: &Value) -> Result<String, String> {
    if !is_sql(ctx.kind) {
        return Err(t!("此連線種類沒有預存程序").to_string());
    }
    let db = database(ctx, args)?;
    let list = ctx.manager.list_routines(&ctx.conn_id, &db).await.map_err(|e| e.message())?;
    if list.is_empty() {
        return Ok(t!("（此資料庫沒有程序 / 函式 / 觸發器）").to_string());
    }
    let lines: Vec<String> = list
        .iter()
        .map(|r| {
            let mut s = format!("{} ({})", r.name, r.routine_type);
            if let Some(p) = &r.parent {
                s.push_str(&format!(" on {p}"));
            }
            if let Some(sig) = r.signature.as_deref().filter(|s| !s.is_empty()) {
                s.push_str(&format!(" [{sig}]"));
            }
            s
        })
        .collect();
    Ok(clip(lines.join("\n"), dbtools::MAX_TEXT_BYTES))
}

pub async fn get_ddl(ctx: &DbToolCtx, args: &Value) -> Result<String, String> {
    if !is_sql(ctx.kind) {
        return Err(t!("此連線種類沒有 DDL；請改用 describe_table").to_string());
    }
    let db = database(ctx, args)?;
    let name = arg_str(args, "name").or_else(|| arg_str(args, "table")).ok_or_else(|| t!("缺少 name").to_string())?;
    let ty = arg_str(args, "type").unwrap_or("table").to_ascii_lowercase();
    let m = &ctx.manager;
    let ddl = match ty.as_str() {
        "table" | "view" => m.table_ddl(&ctx.conn_id, &db, name).await,
        "procedure" | "function" | "trigger" => m.routine_definition(&ctx.conn_id, &db, name, &ty).await,
        other => return Err(tf!("不支援的物件種類：{ty}", ty = other)),
    }
    .map_err(|e| e.message())?;
    if ddl.trim().is_empty() {
        return Err(tf!("取不到 {name} 的定義（名稱或種類可能不對）", name = name));
    }
    Ok(clip(ddl, MAX_DDL_BYTES))
}

/// 結構比對。`dst` 為目標上下文（同連線時與 `src` 相同）。
pub async fn compare_schema(src: &DbToolCtx, dst: &DbToolCtx, args: &Value) -> Result<String, String> {
    let src_db = database(src, args)?;
    let dst_db = arg_str(args, "target_database").map(String::from).unwrap_or_else(|| src_db.clone());
    if src.conn_id == dst.conn_id && src_db == dst_db {
        return Err(t!("來源與目標是同一個庫：請給 target_database 或 target_connection").to_string());
    }
    let opts = CaptureOptions { include_routines: false, ..Default::default() };
    let capture = |ctx: &DbToolCtx, db: String| {
        let mgr = ctx.manager.clone();
        let id = ctx.conn_id.clone();
        let opts = opts.clone();
        async move {
            let label = db.clone();
            match tokio::time::timeout(CAPTURE_TIMEOUT, schema::capture(&mgr, &id, &db, &label, &opts, None)).await {
                Ok(r) => r.map_err(|e| e.message()),
                Err(_) => Err(tf!("擷取結構逾時（{s} 秒）", s = CAPTURE_TIMEOUT.as_secs())),
            }
        }
    };
    let s = capture(src, src_db.clone()).await?;
    let d = capture(dst, dst_db.clone()).await?;
    let dopts = DiffOptions {
        ignore_case: arg_bool(args, "ignore_case"),
        ignore_comments: arg_bool(args, "ignore_comments"),
        ignore_defaults: arg_bool(args, "ignore_defaults"),
        ..Default::default()
    };
    let df = diff::diff(&s, &d, &dopts);
    let mut out = String::new();
    for w in s.warnings.iter().chain(d.warnings.iter()) {
        out.push_str(&format!("warning: {w}\n"));
    }
    if df.is_empty() {
        out.push_str(&t!("結構一致，無差異。"));
        return Ok(out);
    }
    out.push_str(&tf!("共 {n} 項差異（來源 {src} → 目標 {dst}）：\n", n = df.summary.total, src = src_db, dst = dst_db));
    let (cols, rows) = super::super::compare::flatten_diff(&df);
    let (table, _) = dbtools::format_rows(&cols, &rows, &FormatOpts::default());
    out.push_str(&table);
    if arg_bool(args, "sync_sql") {
        let sopts = SyncOptions { include_drops: arg_bool(args, "include_drops"), ..Default::default() };
        let script = ddl::generate(&df, &s, &d, &sopts).map_err(|e| e.message())?;
        out.push_str(&tf!(
            "\n\n-- 同步 DDL（{n} 句，{x} 句高破壞；尚未執行）\n",
            n = script.statements.len(),
            x = script.destructive_count
        ));
        out.push_str(&ddl::script_text(&script));
        for sk in &script.skipped {
            out.push_str(&format!("\n-- skipped: {sk}"));
        }
    }
    Ok(clip(out, MAX_DDL_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GUI 助手（agent.rs）靠 `dbtools::MCP_EXTRA_TOOLS` 決定 Claude 要放行哪些工具，兩邊名稱必須一致。
    #[test]
    fn extra_tool_names_match_the_shared_list() {
        let names: Vec<&str> = defs().iter().map(|d| d.name).collect();
        assert_eq!(names, dbtools::MCP_EXTRA_TOOLS);
    }

    #[test]
    fn clip_respects_char_boundaries() {
        let s = "資料".repeat(10); // 每字 3 bytes
        let c = clip(s, 7);
        assert!(c.starts_with("資料"));
        assert!(c.contains("已截斷") || c.contains("truncated"));
        assert_eq!(clip("abc".into(), 10), "abc");
    }

    #[test]
    fn connections_list_has_no_secrets_and_marks_prod() {
        let list = vec![
            ConnInfo { id: "1".into(), name: "shop".into(), kind: DbKind::Mysql, host: "db".into(), port: 3306, database: Some("shop".into()), prod: true },
            ConnInfo { id: "2".into(), name: "local".into(), kind: DbKind::Sqlite, host: String::new(), port: 0, database: Some("C:/a.db".into()), prod: false },
        ];
        let s = format_connections(&list, |c| !c.prod);
        assert!(s.contains("- shop — mysql db:3306 db=shop ["));
        assert!(s.contains("- local — sqlite C:/a.db ["));
        assert!(format_connections(&[], |_| false).contains("沒有可用的連線") || format_connections(&[], |_| false).contains("No"));
    }
}
