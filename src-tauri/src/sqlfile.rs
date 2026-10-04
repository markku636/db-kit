//! 執行 SQL 檔（GUI「執行 SQL 檔…」）：讀檔 → 切句 → 在**同一條專屬連線**上逐句執行，回報進度與每句錯誤。
//!
//! 為什麼要專屬連線：傾印 / 遷移腳本幾乎都依賴工作階段狀態——`USE db`、`SET FOREIGN_KEY_CHECKS = 0`、
//! `BEGIN … COMMIT`、暫存表。走 DatabaseDriver 每句都從池裡借，第二句可能就換了連線，前面設的全不算數。
//! 專屬連線沿用預存程序測試的 EngineSession（SQL Server / PostgreSQL / MySQL / MariaDB），SQLite 另開一條；
//! Oracle 沒有對應的會話實作，逐句走連線池（每句自動提交），跨句的工作階段設定不保證生效。
//!
//! 切句與審查並執行同一套（`review_run::scan::split_statements`：字串 / 註解 / dollar-quote 內的分號不算、
//! SQL Server `GO` 行為分隔），再補兩件傾印檔常見的事：
//! - MySQL `DELIMITER xx`（mysqldump 的觸發器 / 程序段落）：切換分隔符，段落內以新分隔符切。
//! - PostgreSQL 以 `\` 開頭的 psql 指令行（pg_dump 的 `\connect`、`\restrict`）：略過並計數。
//! pg_dump 純文字格式的 `COPY … FROM stdin` 資料區塊不是 SQL，無法逐句執行——開跑前就擋下並說明替代做法。

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::db::sqlgen::quote_ident;
use crate::db::DbKind;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;
use crate::review_run::scan::split_statements;
use crate::sptest::session::{self, EngineSession};

/// 讀進記憶體的檔案上限：再大就該用原生工具（mysql / psql / sqlcmd）。
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// 報告裡保留的錯誤筆數上限（繼續執行模式下錯誤可能成千上萬）。
const MAX_ERRORS: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct ScriptStmt {
    /// 語句第一個非空白字元所在行（1 起算）。
    pub line: usize,
    pub sql: String,
}

#[derive(Debug, Default)]
pub struct SplitScript {
    pub statements: Vec<ScriptStmt>,
    /// 略過的 psql 指令行數。
    pub skipped_meta: usize,
}

/// `DELIMITER xx` 行 → 新分隔符。
fn delimiter_line(line: &str) -> Option<&str> {
    let t = line.trim();
    let b = t.as_bytes();
    if b.len() < 10 || !b[..9].eq_ignore_ascii_case(b"DELIMITER") || !b[9].is_ascii_whitespace() {
        return None;
    }
    let d = t[9..].trim();
    (!d.is_empty()).then_some(d)
}

/// 切成語句。`Err` = 這份腳本不能逐句執行（目前只有 PG 的 COPY FROM stdin）。
pub fn split_script(kind: DbKind, text: &str) -> AppResult<SplitScript> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mysqlish = matches!(kind, DbKind::Mysql | DbKind::Mariadb);
    let mut out = SplitScript::default();

    // 依 DELIMITER 行切成段落；每段記下起始行號與分隔符。psql 指令行換成空行（保住行號）。
    let mut segments: Vec<(usize, String, String)> = Vec::new(); // (first_line, delimiter, text)
    let mut delim = ";".to_string();
    let mut cur = String::new();
    let mut cur_first = 1usize;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        let lineno = i + 1;
        if mysqlish {
            if let Some(d) = delimiter_line(raw) {
                segments.push((cur_first, delim.clone(), std::mem::take(&mut cur)));
                delim = d.to_string();
                cur_first = lineno + 1;
                continue;
            }
        }
        if kind == DbKind::Postgres && raw.trim_start().starts_with('\\') {
            out.skipped_meta += 1;
            cur.push('\n');
            continue;
        }
        cur.push_str(raw);
    }
    segments.push((cur_first, delim, cur));

    for (first_line, delim, seg) in &segments {
        let line_at = |byte: usize| first_line + seg[..byte].bytes().filter(|&b| b == b'\n').count();
        if delim == ";" {
            for (a, b) in split_statements(kind, seg) {
                out.statements.push(ScriptStmt { line: line_at(a), sql: seg[a..b].to_string() });
            }
        } else {
            // 自訂分隔符段落（mysqldump 的 `;;` / `$$`）：照字面切，段內不再理會 `;`。
            let mut start = 0usize;
            let mut push = |from: usize, to: usize| {
                let piece = &seg[from..to];
                let trimmed = piece.trim();
                if !trimmed.is_empty() {
                    let lead = piece.len() - piece.trim_start().len();
                    out.statements.push(ScriptStmt { line: line_at(from + lead), sql: trimmed.to_string() });
                }
            };
            while let Some(pos) = seg[start..].find(delim.as_str()) {
                push(start, start + pos);
                start += pos + delim.len();
            }
            push(start, seg.len());
        }
    }

    if kind == DbKind::Postgres {
        if let Some(s) = out.statements.iter().find(|s| is_copy_from_stdin(&s.sql)) {
            return Err(AppError::Query(tf!(
                "第 {line} 行是 pg_dump 的 COPY … FROM stdin 資料區塊，無法逐句執行。請改用 `pg_dump --inserts`（或 --column-inserts）重新匯出，或用「備份 / 還原」交給 psql。",
                line = s.line
            )));
        }
    }
    Ok(out)
}

fn is_copy_from_stdin(sql: &str) -> bool {
    let up = sql.to_ascii_uppercase();
    let words: Vec<&str> = up.split_whitespace().collect();
    words.first() == Some(&"COPY") && words.windows(2).any(|w| w[0] == "FROM" && w[1].trim_end_matches(';') == "STDIN")
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SqlFileOptions {
    /// 某句失敗後繼續執行後面的語句（預設：遇錯即停）。
    #[serde(default)]
    pub continue_on_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqlFileProgress {
    pub run_id: String,
    pub done: usize,
    pub total: usize,
    pub failed: usize,
    pub line: usize,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqlFileError {
    pub index: usize,
    pub line: usize,
    pub sql: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqlFileReport {
    pub total: usize,
    pub executed: usize,
    pub failed: usize,
    pub skipped_meta: usize,
    pub cancelled: bool,
    pub stopped_on_error: bool,
    pub errors: Vec<SqlFileError>,
    /// 錯誤超過 MAX_ERRORS 筆時，沒列出的筆數。
    pub errors_omitted: usize,
    pub elapsed_ms: u64,
}

enum Session {
    Engine(Box<dyn EngineSession>),
    Sqlite(sqlx::SqliteConnection),
    Pooled,
}

impl Session {
    async fn open(mgr: &ConnectionManager, id: &str, kind: DbKind) -> AppResult<Session> {
        match kind {
            DbKind::Mssql | DbKind::Postgres | DbKind::Mysql | DbKind::Mariadb => Ok(Session::Engine(session::open(mgr, id).await?)),
            DbKind::Sqlite => Ok(Session::Sqlite(mgr.sqlite_driver(id)?.dedicated_connection().await?)),
            DbKind::Oracle => Ok(Session::Pooled),
            _ => Err(AppError::Unsupported(t!("此連線種類不支援執行 SQL 檔").into())),
        }
    }

    async fn exec(&mut self, mgr: &ConnectionManager, id: &str, sql: &str) -> Result<(), String> {
        match self {
            Session::Engine(s) => s.batch(sql, 1).await.into_result().map(|_| ()).map_err(|e| e.message),
            Session::Sqlite(c) => {
                use sqlx::Executor;
                // execute_many 會把多句一次送；這裡已切好，一次一句。
                c.execute(sqlx::raw_sql(sql)).await.map(|_| ()).map_err(|e| e.to_string())
            }
            Session::Pooled => mgr.query(id, sql).await.map(|_| ()).map_err(|e| e.to_string()),
        }
    }
}

/// 開跑前切換到使用者選的資料庫（專屬連線上，只影響這次執行）。
fn use_database_sql(kind: DbKind, database: &str) -> Option<String> {
    let db = database.trim();
    if db.is_empty() {
        return None;
    }
    match kind {
        DbKind::Mysql | DbKind::Mariadb | DbKind::Mssql => Some(format!("USE {}", quote_ident(kind, db))),
        DbKind::Postgres => Some(format!("SET search_path TO {}", quote_ident(kind, db))),
        _ => None,
    }
}

/// 讀檔並執行。`emit` 收進度（約每 100 ms 一次，最後一定送一次）；`run_id` 可用 `crate::compare::cancel` 取消，
/// 於語句之間收手（正在跑的那一句會跑完）。
pub async fn run(
    mgr: &ConnectionManager,
    id: &str,
    database: &str,
    path: &str,
    opts: &SqlFileOptions,
    run_id: &str,
    emit: &(dyn Fn(SqlFileProgress) + Send + Sync),
) -> AppResult<SqlFileReport> {
    let meta = tokio::fs::metadata(path).await.map_err(|e| AppError::Query(tf!("無法讀取檔案：{e}", e = e)))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::Query(tf!(
            "檔案太大（{mb} MB，上限 {max} MB），請改用資料庫的命令列工具匯入。",
            mb = meta.len() / 1024 / 1024,
            max = MAX_FILE_BYTES / 1024 / 1024
        )));
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| AppError::Query(tf!("無法讀取檔案：{e}", e = e)))?;
    let text = String::from_utf8(bytes).map_err(|_| AppError::Query(t!("檔案不是 UTF-8 編碼，請先轉成 UTF-8 再執行。").into()))?;

    let kind = mgr.kind(id)?;
    let script = split_script(kind, &text)?;
    drop(text);
    let total = script.statements.len();

    let guard = crate::compare::register(run_id);
    let started = Instant::now();
    let mut sess = Session::open(mgr, id, kind).await?;
    if let Some(sql) = use_database_sql(kind, database) {
        sess.exec(mgr, id, &sql).await.map_err(AppError::Query)?;
    }

    let mut report = SqlFileReport {
        total,
        executed: 0,
        failed: 0,
        skipped_meta: script.skipped_meta,
        cancelled: false,
        stopped_on_error: false,
        errors: vec![],
        errors_omitted: 0,
        elapsed_ms: 0,
    };
    let mut last_emit = Instant::now();
    let progress = |r: &SqlFileReport, line: usize| SqlFileProgress {
        run_id: run_id.to_string(),
        done: r.executed + r.failed,
        total,
        failed: r.failed,
        line,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    for (i, st) in script.statements.iter().enumerate() {
        if guard.flag.load(std::sync::atomic::Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        match sess.exec(mgr, id, &st.sql).await {
            Ok(()) => report.executed += 1,
            Err(message) => {
                report.failed += 1;
                if report.errors.len() < MAX_ERRORS {
                    let sql: String = st.sql.chars().take(400).collect();
                    report.errors.push(SqlFileError { index: i, line: st.line, sql, message });
                } else {
                    report.errors_omitted += 1;
                }
                if !opts.continue_on_error {
                    report.stopped_on_error = true;
                    break;
                }
            }
        }
        if last_emit.elapsed().as_millis() >= 100 {
            emit(progress(&report, st.line));
            last_emit = Instant::now();
        }
    }
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    emit(progress(&report, 0));
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &SplitScript) -> Vec<(usize, &str)> {
        s.statements.iter().map(|x| (x.line, x.sql.as_str())).collect()
    }

    #[test]
    fn mysql_delimiter_blocks_from_mysqldump() {
        let sql = "SET NAMES utf8mb4;\n\
                   CREATE TABLE t (id INT);\n\
                   DELIMITER ;;\n\
                   CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.id = NEW.id + 1; END ;;\n\
                   DELIMITER ;\n\
                   INSERT INTO t VALUES (1);\n";
        let s = split_script(DbKind::Mysql, sql).unwrap();
        assert_eq!(
            lines(&s),
            vec![
                (1, "SET NAMES utf8mb4"),
                (2, "CREATE TABLE t (id INT)"),
                (4, "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.id = NEW.id + 1; END"),
                (6, "INSERT INTO t VALUES (1)"),
            ]
        );
    }

    #[test]
    fn delimiter_is_only_special_for_mysql() {
        let s = split_script(DbKind::Postgres, "SELECT 1;\nDELIMITER //\nSELECT 2;").unwrap();
        assert_eq!(s.statements.len(), 2);
        assert!(s.statements[1].sql.starts_with("DELIMITER //"), "PG 不認 DELIMITER，那一行照原文留在語句裡");
    }

    #[test]
    fn postgres_skips_psql_meta_and_keeps_line_numbers() {
        let sql = "\\restrict abc\nSET client_encoding = 'UTF8';\n\\connect shop\nCREATE TABLE a (x int);\n";
        let s = split_script(DbKind::Postgres, sql).unwrap();
        assert_eq!(s.skipped_meta, 2);
        assert_eq!(lines(&s), vec![(2, "SET client_encoding = 'UTF8'"), (4, "CREATE TABLE a (x int)")]);
    }

    #[test]
    fn postgres_copy_from_stdin_is_rejected_up_front() {
        let sql = "CREATE TABLE a (x int);\nCOPY public.a (x) FROM stdin;\n1\n2\n\\.\n";
        let err = split_script(DbKind::Postgres, sql).unwrap_err().to_string();
        assert!(err.contains("COPY") && err.contains("2"), "{err}");
    }

    #[test]
    fn mssql_go_batches_and_bom() {
        let sql = "\u{feff}CREATE TABLE t (id int)\nGO\nINSERT INTO t VALUES (1)\nGO\n";
        let s = split_script(DbKind::Mssql, sql).unwrap();
        assert_eq!(lines(&s), vec![(1, "CREATE TABLE t (id int)"), (3, "INSERT INTO t VALUES (1)")]);
    }

    #[test]
    fn semicolons_inside_strings_and_comments_do_not_split() {
        let s = split_script(DbKind::Sqlite, "INSERT INTO t VALUES ('a;b'); -- x;y\nSELECT 1;").unwrap();
        assert_eq!(s.statements.len(), 2);
        assert_eq!(s.statements[0].sql, "INSERT INTO t VALUES ('a;b')");
    }
}
