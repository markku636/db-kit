//! 輸出內容：AI 審查提示、`report.md`、`diff.md` 與 `manifest.json` 的資料模型。
//!
//! 提示在後端組：GUI（串流給目前的 AI 供應商）與 `dbk run --review-cmd`（餵給外部指令）必須拿到
//! **同一份**提示，否則同一份腳本兩個入口審出兩種結論。

use serde::Serialize;

use super::capture::TableSnapshot;
use super::plan::{Prepared, RollbackLevel, Strategy};
use super::rollback::TableDiff;
use crate::db::DbKind;
use crate::i18n::Lang;

const MAX_SCRIPT_CHARS: usize = 16_000;
const MAX_SAMPLE_ROWS: usize = 20;
const MAX_CELL_CHARS: usize = 120;
/// diff.md 每張表最多列出的修改列數（完整資料在 snapshots/*.json）。
pub const MAX_DIFF_ROWS: usize = 200;

fn fence(lang: &str, body: &str) -> String {
    let mut longest = 0usize;
    let mut run = 0usize;
    for ch in body.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let f = "`".repeat((longest + 1).max(3));
    format!("{f}{lang}\n{}\n{f}", body.trim_end())
}

fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

pub fn kind_label(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Mysql => "MySQL",
        DbKind::Mariadb => "MariaDB",
        DbKind::Postgres => "PostgreSQL",
        DbKind::Sqlite => "SQLite",
        DbKind::Mssql => "SQL Server",
        DbKind::Oracle => "Oracle",
        _ => "SQL",
    }
}

fn reply_language(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhTw => "Traditional Chinese (繁體中文, Taiwan usage)",
        Lang::ZhCn => "Simplified Chinese (简体中文)",
        Lang::En => "English",
        Lang::Ja => "Japanese (日本語)",
        Lang::Ko => "Korean (한국어)",
        Lang::Vi => "Vietnamese (Tiếng Việt)",
    }
}

fn level_en(l: RollbackLevel) -> &'static str {
    match l {
        RollbackLevel::NotNeeded => "not needed",
        RollbackLevel::Full => "full",
        RollbackLevel::Partial => "partial",
        RollbackLevel::None => "NONE",
    }
}

pub fn level_text(l: RollbackLevel) -> &'static str {
    match l {
        RollbackLevel::NotNeeded => t!("不需要"),
        RollbackLevel::Full => t!("完整"),
        RollbackLevel::Partial => t!("部分"),
        RollbackLevel::None => t!("無"),
    }
}

/// 送給 AI 的樣本列（前像的前幾列）。
pub struct Sample<'a> {
    pub index: usize,
    pub snapshot: &'a TableSnapshot,
}

/// AI 審查提示。模型面向的指令用英文（不是使用者可見文字，免翻譯），回覆語言另外指定。
pub fn build_review_prompt(prep: &Prepared, conn_label: &str, script: &str, samples: &[Sample<'_>], lang: Lang) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "You are a senior database administrator reviewing a SQL script BEFORE it is executed against a {} database.\n",
        kind_label(prep.kind)
    ));
    if prep.prod {
        s.push_str("This is a PRODUCTION connection. Be strict.\n");
    }
    s.push_str(&format!("Reply in {}. Be concise and concrete; refer to statements by number (#1, #2, …).\n\n", reply_language(lang)));
    s.push_str("The FIRST line of your reply must be exactly one of:\n");
    s.push_str("VERDICT: GO\nVERDICT: CAUTION\nVERDICT: STOP\n");
    s.push_str("(GO = safe as written; CAUTION = can run, but read the risks first; STOP = should not run as written.)\n\n");
    s.push_str("Then write these Markdown sections:\n");
    s.push_str("## Summary\n## Expected changes (before → after)\nFor every write statement: which rows or objects change and how, using the row estimates below.\n");
    s.push_str("## Risks\nLocks and long-running operations, missing or overly broad WHERE clauses, constraint / trigger / cascade side effects, data loss, ordering problems between statements.\n");
    s.push_str("## Suggested fixes\nOnly if needed. Put corrected SQL in fenced code blocks.\n");
    s.push_str("## Rollback check\nThe tool will capture before-images and generate a rollback script as described per statement below. Point out what that rollback does NOT cover.\n\n");
    s.push_str("Do not invent tables or columns that are not listed. If information is missing, say what is missing instead of guessing.\n\n");

    s.push_str("# Context\n");
    s.push_str(&format!("- Engine: {}\n", kind_label(prep.kind)));
    s.push_str(&format!("- Connection: {conn_label}\n"));
    s.push_str(&format!("- Current database / schema: {}\n", prep.database));
    s.push_str(&format!("- Production: {}\n", if prep.prod { "yes" } else { "no" }));
    s.push_str("- Execution: statements run one at a time with autocommit (no wrapping transaction); execution stops at the first error.\n");
    s.push_str(&format!("- Before-image capture limit: {} rows per statement.\n\n", prep.max_capture_rows));

    s.push_str("# Script\n");
    let clipped = script.chars().count() > MAX_SCRIPT_CHARS;
    s.push_str(&fence("sql", &clip_chars(script, MAX_SCRIPT_CHARS)));
    s.push('\n');
    if clipped {
        s.push_str("(Script truncated for length.)\n");
    }
    s.push('\n');

    s.push_str("# Static analysis\n");
    for st in &prep.statements {
        let target = if st.targets.is_empty() { String::new() } else { format!(" on {}", st.targets.join(", ")) };
        s.push_str(&format!("- #{} {:?}{}", st.index + 1, st.op, target));
        if st.write {
            if let Some(w) = st.has_where {
                s.push_str(&format!("; WHERE: {}", if w { "yes" } else { "NO" }));
            }
            if let Some(n) = st.estimated_rows {
                s.push_str(&format!("; rows: {}{}", if st.estimate_exact { "" } else { "≤" }, n));
            }
            if st.destructive {
                s.push_str("; destructive");
            }
            s.push_str(&format!("; rollback: {}", level_en(st.rollback)));
        } else {
            s.push_str("; read-only");
        }
        s.push('\n');
        for n in &st.notes {
            s.push_str(&format!("  - {}\n", n.message));
        }
    }
    for b in &prep.blockers {
        s.push_str(&format!("- BLOCKED #{}: {}\n", b.index + 1, b.message));
    }
    s.push('\n');

    // 目標表結構（去重）。
    let mut seen: Vec<String> = Vec::new();
    let mut tables = String::new();
    for st in &prep.statements {
        let metas: Vec<&super::capture::TableMeta> = match &st.strategy {
            Strategy::Predicate { meta, .. } | Strategy::Keys { meta, .. } | Strategy::KeyRange { meta } => vec![meta],
            Strategy::WholeTables { metas } => metas.iter().collect(),
            Strategy::Schema { data, .. } => data.iter().collect(),
            _ => vec![],
        };
        for m in metas {
            let name = m.qualified(prep.kind);
            if seen.contains(&name) {
                continue;
            }
            seen.push(name.clone());
            let key = if m.key.is_empty() { "none".to_string() } else { m.key.join(", ") };
            tables.push_str(&format!("## {name} (key: {key})\n"));
            for c in &m.columns {
                let mut flags = Vec::new();
                if !c.writable {
                    flags.push("generated");
                }
                if c.identity {
                    flags.push("identity");
                }
                let f = if flags.is_empty() { String::new() } else { format!(" [{}]", flags.join(", ")) };
                tables.push_str(&format!("- {} {}{}\n", c.name, c.data_type, f));
            }
        }
    }
    if !tables.is_empty() {
        s.push_str("# Tables\n");
        s.push_str(&clip_chars(&tables, 8000));
        s.push_str("\n\n");
    }

    if !samples.is_empty() {
        s.push_str("# Sample rows (current state, before execution)\n");
        for smp in samples {
            let snap = smp.snapshot;
            s.push_str(&format!("## #{} {}\n", smp.index + 1, snap.meta.qualified(prep.kind)));
            let cols: Vec<&str> = snap.meta.columns.iter().map(|c| c.name.as_str()).collect();
            s.push_str(&format!("| {} |\n", cols.join(" | ")));
            s.push_str(&format!("|{}\n", "---|".repeat(cols.len())));
            for r in snap.rows.iter().take(MAX_SAMPLE_ROWS) {
                let cells: Vec<String> = r
                    .iter()
                    .map(|v| match v {
                        None => "NULL".to_string(),
                        Some(x) => clip_chars(x, MAX_CELL_CHARS).replace('|', "\\|").replace('\n', " "),
                    })
                    .collect();
                s.push_str(&format!("| {} |\n", cells.join(" | ")));
            }
            s.push('\n');
        }
    }
    s
}

/// 從 AI 回覆的第一個非空行解析結論。
pub fn parse_verdict(text: &str) -> Option<&'static str> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let up = line.trim_start_matches(['*', '#', ' ']).to_ascii_uppercase();
    let rest = up.strip_prefix("VERDICT")?.trim_start_matches([':', ' ', '：']);
    if rest.starts_with("GO") {
        Some("go")
    } else if rest.starts_with("CAUTION") {
        Some("caution")
    } else if rest.starts_with("STOP") {
        Some("stop")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// manifest / 報告
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StmtStatus {
    /// 只產生備份的模式、或執行在前面就停了。
    NotRun,
    Ok,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffSummary {
    pub table: String,
    pub inserted: usize,
    pub deleted: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub keyless: bool,
    pub incomplete: bool,
}

impl DiffSummary {
    pub fn of(kind: DbKind, d: &TableDiff) -> DiffSummary {
        DiffSummary {
            table: display_table(kind, &d.database, &d.table),
            inserted: d.inserted.len(),
            deleted: d.deleted.len(),
            updated: d.updated.len(),
            unchanged: d.unchanged,
            keyless: d.keyless,
            incomplete: d.incomplete,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementRecord {
    pub index: usize,
    pub sql: String,
    pub op: super::analyze::Op,
    pub write: bool,
    pub destructive: bool,
    pub targets: Vec<String>,
    pub method: String,
    pub estimated_rows: Option<u64>,
    pub rollback: RollbackLevel,
    pub notes: Vec<super::plan::Note>,
    pub status: StmtStatus,
    pub rows_affected: Option<u64>,
    pub elapsed_ms: Option<u64>,
    pub error: Option<String>,
    pub files: Vec<String>,
    pub diff: Vec<DiffSummary>,
    /// 結構變更的反向 DDL 句數。
    pub ddl_statements: usize,
    pub rollback_statements: usize,
    pub rollback_disabled: usize,
    /// 回滾片段是執行後比對產生（true）或只依前像預估（false）。
    pub rollback_exact: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// 只產生備份與審查，沒有執行。
    BackupOnly,
    Completed,
    /// 某句執行失敗，後面沒有執行。
    Failed,
    Cancelled,
    /// 執行到一半發現前像不完整、又沒有確認可以接受，停在那句之前。
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunManifest {
    pub app: &'static str,
    pub app_version: &'static str,
    pub run_id: String,
    pub mode: super::run::RunMode,
    pub status: RunStatus,
    pub stop_reason: Option<String>,
    pub connection: String,
    pub kind: DbKind,
    pub database: String,
    pub prod: bool,
    pub started_at: String,
    pub finished_at: String,
    pub max_capture_rows: usize,
    pub verdict: Option<&'static str>,
    pub statements: Vec<StatementRecord>,
    pub files: Vec<String>,
}

fn status_text(s: RunStatus) -> &'static str {
    match s {
        RunStatus::BackupOnly => t!("只產生備份（未執行）"),
        RunStatus::Completed => t!("已完成"),
        RunStatus::Failed => t!("執行失敗"),
        RunStatus::Cancelled => t!("已取消"),
        RunStatus::Stopped => t!("已中止"),
    }
}

fn stmt_status_text(s: StmtStatus) -> &'static str {
    match s {
        StmtStatus::NotRun => t!("未執行"),
        StmtStatus::Ok => t!("成功"),
        StmtStatus::Failed => t!("失敗"),
    }
}

fn verdict_text(v: &str) -> &'static str {
    match v {
        "go" => t!("可以執行"),
        "caution" => t!("注意風險後再執行"),
        _ => t!("不建議執行"),
    }
}

fn md_cell(s: &str) -> String {
    clip_chars(s, MAX_CELL_CHARS).replace('|', "\\|").replace(['\n', '\r'], " ")
}

fn first_line(sql: &str) -> String {
    let one: String = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    clip_chars(&one, 90)
}

pub fn render_report(m: &RunManifest) -> String {
    let mut s = String::new();
    s.push_str(&format!("# {}\n\n", t!("審查並執行報告")));
    s.push_str(&format!("| {} | {} |\n|---|---|\n", t!("項目"), t!("內容")));
    s.push_str(&format!("| {} | {} |\n", t!("狀態"), status_text(m.status)));
    if let Some(r) = &m.stop_reason {
        s.push_str(&format!("| {} | {} |\n", t!("原因"), md_cell(r)));
    }
    s.push_str(&format!("| {} | {} |\n", t!("連線"), md_cell(&m.connection)));
    s.push_str(&format!("| {} | {} |\n", t!("資料庫種類"), kind_label(m.kind)));
    s.push_str(&format!("| {} | {} |\n", t!("資料庫"), md_cell(&m.database)));
    s.push_str(&format!("| {} | {} |\n", t!("正式環境"), if m.prod { t!("是") } else { t!("否") }));
    s.push_str(&format!("| {} | {} |\n", t!("開始"), m.started_at));
    s.push_str(&format!("| {} | {} |\n", t!("結束"), m.finished_at));
    s.push_str(&format!("| {} | {} |\n", t!("擷取上限（列 / 句）"), m.max_capture_rows));
    if let Some(v) = m.verdict {
        s.push_str(&format!("| {} | {} |\n", t!("AI 審查結論"), verdict_text(v)));
    }
    s.push('\n');

    s.push_str(&format!("## {}\n\n", t!("語句")));
    s.push_str(&format!(
        "| # | {} | {} | {} | {} | {} |\n|---|---|---|---|---|---|\n",
        t!("語句"),
        t!("狀態"),
        t!("影響列數"),
        t!("回滾"),
        t!("前後差異")
    ));
    for st in &m.statements {
        let diff = if st.diff.is_empty() {
            "—".to_string()
        } else {
            st.diff
                .iter()
                .map(|d| tf!("{table}：改 {u} / 增 {i} / 刪 {d}", table = d.table, u = d.updated, i = d.inserted, d = d.deleted))
                .collect::<Vec<_>>()
                .join("<br>")
        };
        let affected = st.rows_affected.map(|n| n.to_string()).unwrap_or_else(|| "—".into());
        s.push_str(&format!(
            "| {} | `{}` | {} | {} | {} | {} |\n",
            st.index + 1,
            md_cell(&first_line(&st.sql)).replace('`', "'"),
            stmt_status_text(st.status),
            affected,
            level_text(st.rollback),
            diff
        ));
    }
    s.push('\n');

    let noted: Vec<&StatementRecord> = m.statements.iter().filter(|s| !s.notes.is_empty() || s.error.is_some()).collect();
    if !noted.is_empty() {
        s.push_str(&format!("## {}\n\n", t!("注意事項")));
        for st in noted {
            if let Some(e) = &st.error {
                s.push_str(&format!("- #{}：{}\n", st.index + 1, md_cell(e)));
            }
            for n in &st.notes {
                s.push_str(&format!("- #{}：{}\n", st.index + 1, n.message));
            }
        }
        s.push('\n');
    }

    s.push_str(&format!("## {}\n\n", t!("檔案")));
    for f in &m.files {
        s.push_str(&format!("- `{f}`\n"));
    }
    s.push('\n');
    s.push_str(&format!("> {}\n", t!("rollback.sql 依「最後一句先還原」排列；被註解掉的語句代表無法確定能安全還原，請人工確認後再取消註解。")));
    s
}

fn cell(spec: Option<&super::codec::ColumnSpec>, v: &Option<String>) -> String {
    match (v, spec) {
        (None, _) => "NULL".to_string(),
        (Some(x), Some(s)) => format!("`{}`", md_cell(&super::codec::display(s, Some(x))).replace('`', "'")),
        (Some(x), None) => format!("`{}`", md_cell(x).replace('`', "'")),
    }
}

/// 顯示用表名（不加引號；SQLite 只有表名）。
pub fn display_table(kind: DbKind, db: &str, table: &str) -> String {
    if kind == DbKind::Sqlite || db.is_empty() {
        table.to_string()
    } else {
        format!("{db}.{table}")
    }
}

pub fn render_diff(kind: DbKind, m: &RunManifest, diffs: &[(usize, Vec<TableDiff>, Vec<String>)]) -> String {
    let mut s = String::new();
    s.push_str(&format!("# {}\n\n", t!("執行前後差異")));
    s.push_str(&format!(
        "{}\n\n",
        tf!("連線 {conn} · 資料庫 {db} · {at}", conn = m.connection, db = m.database, at = m.finished_at)
    ));
    if diffs.is_empty() {
        s.push_str(t!("（沒有擷取到任何差異）"));
        s.push('\n');
        return s;
    }
    for (index, tables, ddl) in diffs {
        let st = m.statements.iter().find(|x| x.index == *index);
        s.push_str(&format!("## #{} {}\n\n", index + 1, st.map(|x| first_line(&x.sql)).unwrap_or_default()));
        if let Some(st) = st {
            let affected = st.rows_affected.map(|n| n.to_string()).unwrap_or_else(|| "—".into());
            s.push_str(&format!("{}\n\n", tf!("狀態：{status}，影響 {n} 列", status = stmt_status_text(st.status), n = affected)));
        }
        if !ddl.is_empty() {
            s.push_str(&format!("### {}\n\n", t!("結構變更（回滾用的反向 DDL）")));
            s.push_str(&fence("sql", &ddl.join(";\n")));
            s.push_str("\n\n");
        }
        for d in tables {
            let name = display_table(kind, &d.database, &d.table);
            s.push_str(&format!(
                "### {name} — {}\n\n",
                tf!("修改 {u}、新增 {i}、刪除 {d}、未變 {n}", u = d.updated.len(), i = d.inserted.len(), d = d.deleted.len(), n = d.unchanged)
            ));
            if d.incomplete {
                s.push_str(&format!("> {}\n\n", t!("前像或後像超過擷取上限，差異不完整。")));
            }
            if d.keyless {
                s.push_str(&format!("> {}\n\n", t!("此表沒有主鍵或唯一鍵，只能以整列內容比對增刪，無法判斷哪一列被修改。")));
            }
            if !d.dropped_columns.is_empty() {
                s.push_str(&format!("> {}\n\n", tf!("執行後已不存在的欄位：{cols}", cols = d.dropped_columns.join(", "))));
            }
            if !d.added_columns.is_empty() {
                s.push_str(&format!("> {}\n\n", tf!("執行後新增的欄位：{cols}", cols = d.added_columns.join(", "))));
            }
            let key_idx: Vec<usize> = d.key.iter().filter_map(|k| d.columns.iter().position(|c| c == k)).collect();
            let key_text = |r: &Vec<Option<String>>| -> String {
                if key_idx.is_empty() {
                    return "—".into();
                }
                key_idx
                    .iter()
                    .map(|&i| format!("{}={}", d.columns[i], super::codec::display(&d.specs[i], r[i].as_deref())))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            if !d.updated.is_empty() {
                s.push_str(&format!("| {} | {} | {} | {} |\n|---|---|---|---|\n", t!("鍵"), t!("欄位"), t!("執行前"), t!("執行後")));
                let mut shown = 0usize;
                'rows: for ch in &d.updated {
                    for col in &ch.changed {
                        let Some(ci) = d.columns.iter().position(|c| c == col) else { continue };
                        let after = if d.dropped_columns.contains(col) { format!("({})", t!("欄位已刪除")) } else { cell(d.specs.get(ci), &ch.after[ci]) };
                        s.push_str(&format!("| {} | {} | {} | {} |\n", md_cell(&key_text(&ch.before)), col, cell(d.specs.get(ci), &ch.before[ci]), after));
                    }
                    shown += 1;
                    if shown >= MAX_DIFF_ROWS {
                        break 'rows;
                    }
                }
                if d.updated.len() > MAX_DIFF_ROWS {
                    s.push_str(&format!("\n{}\n", tf!("…另有 {n} 列修改未列出，完整內容見 snapshots/ 目錄。", n = d.updated.len() - MAX_DIFF_ROWS)));
                }
                s.push('\n');
            }
            for (title, rows) in [(t!("刪除的列"), &d.deleted), (t!("新增的列"), &d.inserted)] {
                if rows.is_empty() {
                    continue;
                }
                s.push_str(&format!("#### {title}（{}）\n\n", rows.len()));
                let cols: Vec<&String> = d.columns.iter().take(8).collect();
                s.push_str(&format!("| {} |\n|{}\n", cols.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(" | "), "---|".repeat(cols.len())));
                for r in rows.iter().take(MAX_DIFF_ROWS) {
                    s.push_str(&format!("| {} |\n", r.iter().take(8).enumerate().map(|(i, v)| cell(d.specs.get(i), v)).collect::<Vec<_>>().join(" | ")));
                }
                if rows.len() > MAX_DIFF_ROWS {
                    s.push_str(&format!("\n{}\n", tf!("…另有 {n} 列未列出，完整內容見 snapshots/ 目錄。", n = rows.len() - MAX_DIFF_ROWS)));
                }
                s.push('\n');
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_parsing_is_lenient_about_markdown() {
        assert_eq!(parse_verdict("VERDICT: GO\n## Summary"), Some("go"));
        assert_eq!(parse_verdict("\n  **VERDICT: CAUTION**\n"), Some("caution"));
        assert_eq!(parse_verdict("# VERDICT：STOP"), Some("stop"));
        assert_eq!(parse_verdict("Looks fine"), None);
        assert_eq!(parse_verdict(""), None);
    }

    #[test]
    fn fence_grows_past_backticks_in_body() {
        assert!(fence("sql", "select '```'").starts_with("````sql"));
        assert!(fence("sql", "select 1").starts_with("```sql"));
    }
}
