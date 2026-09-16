//! `dbk run <script.sql> --out <dir>`：審查並執行的 CLI 入口（核心在 `review_run/`，與 GUI 共用）。
//!
//! 沿用 CLI 既有的兩段確認：沒帶 `--yes` 只做分析、擷取前像、產生審查與回滾腳本（＝預演）；
//! 帶 `--yes` 才執行，含 DROP / TRUNCATE / 無 WHERE 寫入時再要 `--force`。
//!
//! AI 審查不在 slim CLI 裡內建（HTTP 供應商的 reqwest 掛在 gui feature 後）：`--review-cmd` 把提示從
//! stdin 餵給任何外部指令（`claude -p`、`codex exec -`、自家腳本），stdout 存成 review.md。
//! `--print-prompt` 只印出提示，方便接到其他工具。

use std::process::Stdio;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;
use crate::review_run::plan::{NoteLevel, Prepared, RollbackLevel};
use crate::review_run::report::{self, RunStatus, StmtStatus};
use crate::review_run::run::{self, RunMode, RunOptions, RunRequest};

use crate::db::DbKind;

use super::args::{ConnArgs, Format, RunArgs};
use super::dispatch::Confirm;
use super::{guard, render, resolve};

async fn read_script(path: &str) -> AppResult<String> {
    if path == "-" {
        let mut s = String::new();
        tokio::io::stdin()
            .read_to_string(&mut s)
            .await
            .map_err(|e| AppError::Storage(tf!("讀取 stdin 失敗：{e}", e = e.to_string())))?;
        return Ok(s);
    }
    tokio::fs::read_to_string(path)
        .await
        .map_err(|e| AppError::Storage(tf!("讀取腳本 {path} 失敗：{e}", path = path, e = e.to_string())))
}

/// 以系統 shell 執行審查指令：提示走 stdin、回覆取 stdout。
async fn run_review_cmd(cmd: &str, prompt: &str) -> AppResult<String> {
    #[cfg(windows)]
    let mut c = {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(cmd);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    let mut child = c.spawn().map_err(|e| AppError::Query(tf!("無法啟動審查指令：{e}", e = e.to_string())))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| AppError::Query(tf!("無法把提示寫給審查指令：{e}", e = e.to_string())))?;
    }
    let out = child.wait_with_output().await.map_err(|e| AppError::Query(e.to_string()))?;
    if !out.status.success() {
        return Err(AppError::Query(tf!("審查指令結束碼 {code}", code = out.status.code().unwrap_or(-1))));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn print_analysis(prep: &Prepared) {
    eprintln!("{}", tf!("資料庫：{db}　語句：{n}　擷取上限：{cap} 列 / 句", db = prep.database, n = prep.statements.len(), cap = prep.max_capture_rows));
    for st in &prep.statements {
        let one: String = st.sql.split_whitespace().collect::<Vec<_>>().join(" ");
        let short: String = one.chars().take(80).collect();
        let rows = st.estimated_rows.map(|n| format!("{}{n}", if st.estimate_exact { "" } else { "≤" })).unwrap_or_else(|| "—".into());
        eprintln!(
            "  #{:<3} {:<9} {} {}",
            st.index + 1,
            report::level_text(st.rollback),
            tf!("約 {rows} 列", rows = rows),
            short
        );
        for n in &st.notes {
            let tag = match n.level {
                NoteLevel::Info => "info",
                NoteLevel::Warn => "warn",
                NoteLevel::Error => "error",
            };
            eprintln!("        [{tag}] {}", n.message);
        }
    }
    for b in &prep.blockers {
        eprintln!("  {}", tf!("✗ 第 {n} 句：{msg}", n = b.index + 1, msg = b.message));
    }
}

/// 入口：自己管連線生命週期（命名空間要直接看 `-d` 旗標，見下方 PostgreSQL 的說明）。
pub async fn run_cli(conn: &ConnArgs, fmt: Format, a: RunArgs) -> AppResult<()> {
    let cfg = resolve::resolve(conn).await?;
    let id = cfg.id.clone();
    let name = cfg.name.clone();
    // 未限定表名要落在哪個命名空間：
    // - PostgreSQL：`-d` 是 schema；連線自帶的 database 是「連到哪個庫」，不能拿來當 schema，沒給 -d 就用 current_schema()。
    // - SQLite：database 是檔案路徑，命名空間固定 main。
    // - 其餘：-d 優先，否則連線的預設庫（SQL Server / Oracle 由伺服器回報為準，見 ExecContext）。
    let ns = match cfg.kind {
        DbKind::Postgres => conn.database.clone().unwrap_or_default(),
        DbKind::Sqlite => String::new(),
        _ => conn.database.clone().or_else(|| cfg.database.clone()).unwrap_or_default(),
    };
    let cf = Confirm { yes: conn.yes, force: conn.force };
    let mgr = ConnectionManager::new();
    mgr.connect(cfg).await?;
    let res = run(&mgr, &name, &id, &ns, fmt, cf, a).await;
    mgr.disconnect(&id).await;
    res
}

async fn run(mgr: &ConnectionManager, conn_name: &str, id: &str, db: &str, fmt: Format, cf: Confirm, a: RunArgs) -> AppResult<()> {
    let script = read_script(&a.file).await?;
    // 資料庫另有欄位記錄（報告、輸出目錄名都會帶），標籤只放連線名，免得目錄名重複出現庫名。
    let label = conn_name.to_string();
    let rp = run::prepare_review(mgr, id, &label, db, &script, a.max_capture_rows, a.review_samples).await?;
    if a.print_prompt {
        println!("{}", rp.prompt);
        return Ok(());
    }
    let prep = &rp.prepared;
    print_analysis(prep);
    if !prep.blockers.is_empty() {
        return Err(AppError::Query(t!("腳本含本流程不支援的語句，未執行任何動作").into()));
    }

    // AI 審查（選用）。
    let mut review: Option<String> = None;
    if let Some(cmd) = a.review_cmd.as_deref().filter(|c| !c.trim().is_empty()) {
        eprintln!("{}", t!("AI 審查中…"));
        match run_review_cmd(cmd, &rp.prompt).await {
            Ok(text) if !text.is_empty() => {
                if let Some(v) = report::parse_verdict(&text) {
                    eprintln!("{}", tf!("AI 審查結論：{v}", v = v.to_uppercase()));
                }
                review = Some(text);
            }
            Ok(_) => eprintln!("warning: {}", t!("審查指令沒有輸出任何內容")),
            Err(e) => eprintln!("warning: {}", e.message()),
        }
    }
    let verdict = review.as_deref().and_then(report::parse_verdict);

    // 執行與否：沿用 --yes / --force 的兩段確認；AI 判 STOP 時預設只產生備份。
    let destructive = prep.statements.iter().any(|s| s.destructive);
    let mut mode = RunMode::Backup;
    if prep.has_writes && cf.yes {
        guard::ensure_confirmed(cf.yes, cf.force, destructive, t!("執行腳本"))?;
        if verdict == Some("stop") && !a.ignore_verdict {
            eprintln!("warning: {}", t!("AI 審查結論為 STOP：只產生備份、不執行（確定要執行請加 --ignore-verdict）"));
        } else {
            mode = RunMode::Execute;
        }
    } else if prep.has_writes {
        eprintln!("{}", t!("未加 --yes：只產生審查與備份，不執行。"));
    }
    if mode == RunMode::Execute {
        if prep.prod && !a.allow_prod {
            return Err(AppError::NeedsConfirm(t!("目標連線標記為正式環境，請再加 --allow-prod 確認").into()));
        }
        if prep.needs_ack && !a.allow_incomplete {
            let n = prep.statements.iter().filter(|s| s.write && matches!(s.rollback, RollbackLevel::Partial | RollbackLevel::None)).count();
            return Err(AppError::NeedsConfirm(tf!(
                "有 {n} 句沒有完整回滾，未執行。確認可以接受請再加 --allow-incomplete",
                n = n
            )));
        }
    }

    let run_id = format!("cli-{}", uuid::Uuid::new_v4());
    let progress = |p: run::Progress| match p.phase.as_str() {
        "capture_before" => eprintln!("{}", tf!("#{n} 擷取前像 {detail}", n = p.index + 1, detail = p.detail)),
        "execute" => eprintln!("{}", tf!("#{n} 執行", n = p.index + 1)),
        "capture_after" => eprintln!("{}", tf!("#{n} 擷取後像", n = p.index + 1)),
        _ => {}
    };
    let out_dir = std::path::PathBuf::from(&a.out);
    let outcome = run::run(
        mgr,
        id,
        RunRequest {
            run_id: &run_id,
            conn_label: &label,
            database: db,
            script: &script,
            out_dir: &out_dir,
            mode,
            options: RunOptions { max_capture_rows: a.max_capture_rows, allow_incomplete: a.allow_incomplete, confirm_prod: a.allow_prod },
            review,
        },
        &progress,
    )
    .await?;

    let m = &outcome.manifest;
    match fmt {
        Format::Json => render::emit_value(fmt, &serde_json::json!({ "dir": outcome.dir, "manifest": m })),
        _ => {
            let rows: Vec<Vec<Option<String>>> = m
                .statements
                .iter()
                .map(|s| {
                    let diff = s
                        .diff
                        .iter()
                        .map(|d| format!("{} ~{} +{} -{}", d.table, d.updated, d.inserted, d.deleted))
                        .collect::<Vec<_>>()
                        .join("; ");
                    vec![
                        Some((s.index + 1).to_string()),
                        serde_json::to_value(s.status).ok().and_then(|v| v.as_str().map(String::from)),
                        s.rows_affected.map(|n| n.to_string()),
                        Some(report::level_text(s.rollback).to_string()),
                        Some(format!("{}/{}", s.rollback_statements, s.rollback_disabled)),
                        Some(diff),
                    ]
                })
                .collect();
            let cols = ["#", "status", "rows", "rollback", "stmts/manual", "diff"].map(String::from).to_vec();
            render::emit(fmt, &cols, &rows);
            println!("{}", tf!("輸出目錄：{dir}", dir = outcome.dir));
        }
    }
    match m.status {
        RunStatus::Completed | RunStatus::BackupOnly => Ok(()),
        _ => {
            let failed = m.statements.iter().any(|s| s.status == StmtStatus::Failed);
            Err(AppError::Query(m.stop_reason.clone().unwrap_or_else(|| {
                if failed {
                    t!("執行失敗").to_string()
                } else {
                    t!("已中止").to_string()
                }
            })))
        }
    }
}
