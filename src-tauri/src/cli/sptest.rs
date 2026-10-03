//! `dbk sp-test`：預存程序整合測試的 CLI 執行器（核心在 `crate::sptest`，與 GUI 共用）。
//!
//! 與 `dispatch.rs` 分開的理由與 compare 相同：diff 要同時持有兩條連線。
//! 進度一律走 stderr，stdout 只放結果（`--format json … > report.json` 才不會被污染）。

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;
use crate::sptest::model::{self, TestFile};
use crate::sptest::report::{self, FileReport, Verdict};
use crate::sptest::run::{run_file, ExecMode, RunOptions};
use crate::sptest::{inspect, EngineRef, Progress};

use super::args::{ConnArgs, Format, SpTestCmd, SpTestMode};
use super::render;
use super::resolve::{self, SideRef};

pub async fn run(conn: &ConnArgs, fmt: Format, cmd: SpTestCmd) -> AppResult<()> {
    match cmd {
        SpTestCmd::Validate { paths } => validate(&paths),
        SpTestCmd::List { paths } => list(fmt, &paths),
        SpTestCmd::Inspect { routine } => inspect_cmd(conn, fmt, &routine).await,
        SpTestCmd::Init { routine, out } => init(conn, &routine, out.as_deref()).await,
        SpTestCmd::Run(a) => {
            let mode = match a.mode {
                SpTestMode::Assert => ExecMode::Assert,
                SpTestMode::Golden => ExecMode::Golden,
                SpTestMode::Record => ExecMode::Record,
            };
            let opts = RunOptions { mode, golden_dir: a.golden.map(PathBuf::from), row_cap: a.max_rows, only: a.only, tags: a.tag };
            execute(conn, fmt, &a.paths, opts, a.junit.as_deref(), a.exit_code, None, None).await
        }
        SpTestCmd::Diff(a) => {
            let opts = RunOptions { mode: ExecMode::Diff, golden_dir: None, row_cap: a.max_rows, only: a.only, tags: a.tag };
            execute(conn, fmt, &a.paths, opts, a.junit.as_deref(), a.exit_code, Some(&a.dst), a.dst_db.as_deref()).await
        }
    }
}

/// 檔案 / 資料夾 → 測試檔清單（資料夾取底下 *.json，略過 golden/ runs/）。
fn collect_files(paths: &[String]) -> AppResult<Vec<PathBuf>> {
    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
                .map_err(|e| AppError::Storage(e.to_string()))?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().map(|x| x.eq_ignore_ascii_case("json")).unwrap_or(false))
                .collect();
            entries.sort();
            out.extend(entries);
        } else if path.is_file() {
            out.push(path.to_path_buf());
        } else {
            return Err(AppError::NotFound(tf!("找不到測試檔或資料夾：{path}", path = p)));
        }
    }
    if out.is_empty() {
        return Err(AppError::Query(t!("沒有找到測試檔").into()));
    }
    Ok(out)
}

fn load(path: &Path) -> AppResult<TestFile> {
    let file = path.display().to_string();
    let text = std::fs::read_to_string(path).map_err(|e| AppError::Storage(tf!("{file} 解析失敗：{e}", file = file, e = e.to_string())))?;
    let f: TestFile = serde_json::from_str(&text).map_err(|e| AppError::Query(tf!("{file} 解析失敗：{e}", file = file, e = e.to_string())))?;
    let errs = model::validate(&f);
    if !errs.is_empty() {
        return Err(AppError::Query(tf!("{file}：{errs}", file = file, errs = errs.join("；"))));
    }
    Ok(f)
}

fn validate(paths: &[String]) -> AppResult<()> {
    let mut bad = 0;
    for p in collect_files(paths)? {
        match load(&p) {
            Ok(f) => println!("ok   {} ({} scenarios)", p.display(), f.scenarios.len()),
            Err(e) => {
                bad += 1;
                println!("FAIL {}", e.message());
            }
        }
    }
    if bad > 0 {
        return Err(AppError::Query(tf!("{n} 個測試檔有誤", n = bad)));
    }
    Ok(())
}

/// 一列一個「展開後」的情境（cases 各自一列）：`--only` 要填的名字就是第二欄。
fn list(fmt: Format, paths: &[String]) -> AppResult<()> {
    let columns: Vec<String> = ["file", "scenario", "steps", "tags", "skip", "description"].iter().map(|s| s.to_string()).collect();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    for p in collect_files(paths)? {
        let f = load(&p)?;
        let file = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        for sc in &f.scenarios {
            let fixture_steps: usize = sc.use_fixtures.iter().filter_map(|u| f.fixtures.get(u)).map(|fx| fx.steps.len()).sum();
            let steps = if fixture_steps > 0 { format!("{}+{}", fixture_steps, sc.steps.len()) } else { sc.steps.len().to_string() };
            let skip = sc.skip.as_ref().and_then(|s| s.reason()).map(|r| if r.is_empty() { "yes".to_string() } else { r });
            let tags = (!sc.tags.is_empty()).then(|| sc.tags.join(","));
            let names: Vec<String> = if sc.cases.is_empty() { vec![sc.id.clone()] } else { sc.cases.iter().map(|c| format!("{}/{}", sc.id, c.name)).collect() };
            for n in names {
                rows.push(vec![Some(file.clone()), Some(n), Some(steps.clone()), tags.clone(), skip.clone(), sc.description.clone()]);
            }
        }
    }
    render::emit(fmt, &columns, &rows);
    Ok(())
}

/// `dbk sp-test init`：連線盤點 → 骨架。寫檔時印下一步提示到 stderr。
async fn init(conn: &ConnArgs, routine: &str, out: Option<&str>) -> AppResult<()> {
    let cfg = resolve::resolve(conn).await?;
    let db = conn
        .database
        .clone()
        .or_else(|| cfg.database.clone())
        .ok_or_else(|| AppError::Query(t!("請以 -d 指定資料庫 / schema").into()))?;
    let mgr = ConnectionManager::new();
    let id = cfg.id.clone();
    let kind = cfg.kind;
    mgr.connect(cfg).await?;
    let res = crate::sptest::scaffold::scaffold(&mgr, &id, kind, &db, routine).await;
    mgr.disconnect(&id).await;
    let text = serde_json::to_string_pretty(&res?).map_err(|e| AppError::Query(e.to_string()))?;
    let Some(out) = out else {
        println!("{text}");
        return Ok(());
    };
    let mut path = PathBuf::from(out);
    if path.is_dir() || out.ends_with('/') || out.ends_with('\\') {
        let (_, name) = inspect::split_routine(kind, &db, routine);
        path = path.join(format!("{}.json", name.replace(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '.'), "_")));
    }
    if path.exists() && !conn.force {
        return Err(AppError::Storage(tf!("{path} 已存在；要覆寫請加 --force", path = path.display().to_string())));
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Storage(e.to_string()))?;
    }
    std::fs::write(&path, text.as_bytes()).map_err(|e| AppError::Storage(e.to_string()))?;
    eprintln!("{}", tf!("已寫入測試檔骨架：{path}", path = path.display().to_string()));
    eprintln!("{}", t!("下一步：執行一次看實際輸出 → 把期望寫進 expect（或 --mode record 錄成基線）→ 錯誤情境改好參數後拿掉 skip"));
    Ok(())
}

async fn inspect_cmd(conn: &ConnArgs, fmt: Format, routine: &str) -> AppResult<()> {
    let cfg = resolve::resolve(conn).await?;
    let db = conn
        .database
        .clone()
        .or_else(|| cfg.database.clone())
        .ok_or_else(|| AppError::Query(t!("請以 -d 指定資料庫 / schema").into()))?;
    let mgr = ConnectionManager::new();
    let id = cfg.id.clone();
    let kind = cfg.kind;
    mgr.connect(cfg).await?;
    let res = async {
        let sig = inspect::routine_sig(&mgr, &id, kind, &db, routine).await?;
        let targets = inspect::write_targets(&mgr, &id, kind, &db, routine).await?;
        let (_, name) = inspect::split_routine(kind, &db, routine);
        let rt = match sig.kind {
            inspect::RoutineKind::Procedure => "procedure",
            inspect::RoutineKind::Function => "function",
        };
        let definition = match mgr.routine_definition(&id, &db, &name, rt).await {
            Ok(d) => d,
            Err(_) => mgr.routine_definition(&id, &db, routine, rt).await.unwrap_or_default(),
        };
        Ok::<serde_json::Value, AppError>(serde_json::json!({
            "routine": routine,
            "database": db,
            "signature": sig,
            "write_targets": targets,
            "definition": definition,
            "breaks_wrapping": inspect::body_breaks_wrapping(kind, &definition),
            "schema_doc": model::SCHEMA_DOC,
        }))
    }
    .await;
    mgr.disconnect(&id).await;
    render::emit_value(fmt, &res?);
    Ok(())
}

fn mark(v: &str) -> &'static str {
    match v {
        "pass" => "✓",
        "skipped" => "-",
        "both_error" => "≈",
        _ => "✗",
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute(
    conn: &ConnArgs,
    fmt: Format,
    paths: &[String],
    opts: RunOptions,
    junit: Option<&str>,
    exit_code: bool,
    dst: Option<&str>,
    dst_db: Option<&str>,
) -> AppResult<()> {
    let files = collect_files(paths)?;
    let src_cfg = resolve::resolve(conn).await?;
    let src_db = conn
        .database
        .clone()
        .or_else(|| src_cfg.database.clone())
        .ok_or_else(|| AppError::Query(t!("請以 -d 指定資料庫 / schema").into()))?;
    let dst_cfg = match dst {
        Some(s) => {
            let db = dst_db.map(str::to_string).unwrap_or_else(|| src_db.clone());
            match resolve::resolve_ref(s, Some(&db)).await? {
                SideRef::Conn(c) => Some((c, db)),
                SideRef::Snapshot(_) => return Err(AppError::Query(t!("差分的目標必須是連線，不能是快照檔").into())),
            }
        }
        None => None,
    };

    let mgr = ConnectionManager::new();
    let src_id = src_cfg.id.clone();
    mgr.connect(src_cfg).await?;
    let mut targets = vec![EngineRef { conn_id: src_id.clone(), database: src_db }];
    let mut dst_id: Option<String> = None;
    if let Some((c, db)) = dst_cfg {
        let id = c.id.clone();
        if let Err(e) = mgr.connect(c).await {
            mgr.disconnect(&src_id).await;
            return Err(e);
        }
        targets.push(EngineRef { conn_id: id.clone(), database: db });
        dst_id = Some(id);
    }

    let mut reports: Vec<FileReport> = Vec::new();
    let mut failure: Option<AppError> = None;
    for path in &files {
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("test.json").to_string();
        eprintln!("{name}");
        let file = match load(path) {
            Ok(f) => f,
            Err(e) => {
                failure = Some(e);
                break;
            }
        };
        let progress = |p: Progress| {
            if p.phase == "done" {
                let case = p.case.as_deref().map(|c| format!("/{c}")).unwrap_or_default();
                let v = p.verdict.unwrap_or_default();
                eprintln!("  {} {}{} ({})", mark(&v), p.scenario, case, v);
            }
        };
        match run_file(&mgr, &format!("cli-{name}"), &targets, &file, &name, &opts, &progress).await {
            Ok(r) => reports.push(r),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    mgr.disconnect(&src_id).await;
    if let Some(d) = &dst_id {
        mgr.disconnect(d).await;
    }
    if let Some(e) = failure {
        return Err(e);
    }

    if let Some(j) = junit {
        std::fs::write(j, report::to_junit(&reports)).map_err(|e| AppError::Storage(e.to_string()))?;
        eprintln!("{}", tf!("已寫入 JUnit 報表：{path}", path = j));
    }
    match fmt {
        Format::Json => render::emit_value(fmt, &reports),
        _ => {
            let columns = vec!["file".to_string(), "scenario".into(), "verdict".into(), "ms".into(), "first_difference".into()];
            let rows: Vec<Vec<Option<String>>> = reports
                .iter()
                .flat_map(|r| {
                    r.scenarios.iter().map(move |s| {
                        let first = s.error.clone().or_else(|| s.steps.iter().flat_map(|st| st.differences.iter().map(move |d| format!("{} @ {}: {}", d.kind, st.label, d.summary()))).next());
                        vec![Some(r.file.clone()), Some(s.display_name()), Some(s.verdict.as_str().into()), Some(s.elapsed_ms.to_string()), first]
                    })
                })
                .collect();
            render::emit(fmt, &columns, &rows);
            if reports.iter().any(|r| !r.all_green()) {
                println!();
                print!("{}", report::render_md(&reports));
            }
        }
    }
    let bad = reports.iter().flat_map(|r| r.scenarios.iter()).filter(|s| !s.verdict.is_green()).count();
    let _ = Verdict::Pass;
    if exit_code && bad > 0 {
        return Err(AppError::Query(tf!("{n} 個情境未通過", n = bad)));
    }
    Ok(())
}
