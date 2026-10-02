//! 預存程序整合測試的 Tauri command（薄包裝；核心在 `crate::sptest`，與 `dbk sp-test` 共用）。
//!
//! 測試檔由前端以文字傳入（編輯器就是來源），後端只負責解析 / 驗證 / 執行 / 寫報表。
//! 進度走 `sp-test-progress` 事件（前端以 `run_id` 過濾）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::sptest::model::{self, TestFile};
use crate::sptest::report::{self, FileReport};
use crate::sptest::run::{run_file, ExecMode, RunOptions};
use crate::sptest::{inspect, EngineRef, Progress};

#[derive(Debug, Serialize)]
pub struct SpTestFileEntry {
    pub name: String,
    pub path: String,
    pub text: String,
    pub errors: Vec<String>,
}

fn parse_errors(text: &str) -> Vec<String> {
    match serde_json::from_str::<TestFile>(text) {
        Ok(f) => model::validate(&f),
        Err(e) => vec![e.to_string()],
    }
}

/// 列出資料夾底下的測試檔（*.json；略過 golden/ runs/ reports/ 子目錄——它們在別層）。
#[tauri::command]
pub async fn sp_test_load_dir(dir: String) -> AppResult<Vec<SpTestFileEntry>> {
    let d = PathBuf::from(dir.trim());
    if !d.is_dir() {
        return Err(AppError::Storage(tf!("找不到測試檔或資料夾：{path}", path = dir)));
    }
    let mut out = Vec::new();
    let mut rd = tokio::fs::read_dir(&d).await.map_err(|e| AppError::Storage(e.to_string()))?;
    while let Some(e) = rd.next_entry().await.map_err(|e| AppError::Storage(e.to_string()))? {
        let p = e.path();
        if !p.is_file() || !p.extension().map(|x| x.eq_ignore_ascii_case("json")).unwrap_or(false) {
            continue;
        }
        let text = tokio::fs::read_to_string(&p).await.map_err(|e| AppError::Storage(e.to_string()))?;
        out.push(SpTestFileEntry {
            name: p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
            path: p.display().to_string(),
            errors: parse_errors(&text),
            text,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 存檔（必須是絕對路徑、副檔名 .json）。回傳驗證訊息（空 = 通過）；格式錯也照存——使用者正在編輯。
#[tauri::command]
pub async fn sp_test_save_file(path: String, text: String) -> AppResult<Vec<String>> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() || !p.extension().map(|x| x.eq_ignore_ascii_case("json")).unwrap_or(false) {
        return Err(AppError::Storage(t!("測試檔路徑必須是絕對路徑且以 .json 結尾").into()));
    }
    if let Some(parent) = p.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| AppError::Storage(e.to_string()))?;
    }
    tokio::fs::write(&p, text.as_bytes()).await.map_err(|e| AppError::Storage(e.to_string()))?;
    Ok(parse_errors(&text))
}

#[tauri::command]
pub fn sp_test_validate(text: String) -> Vec<String> {
    parse_errors(&text)
}

/// 盤點：簽名、寫入目標、本文、相關表 DDL（同 `dbk sp-test inspect`）。
#[tauri::command]
pub async fn sp_test_inspect(state: State<'_, AppState>, id: String, database: String, routine: String) -> AppResult<serde_json::Value> {
    inspect_json(&state.manager, &id, &database, &routine).await
}

async fn inspect_json(mgr: &crate::manager::ConnectionManager, id: &str, database: &str, routine: &str) -> AppResult<serde_json::Value> {
    let kind = mgr.kind(id)?;
    let sig = inspect::routine_sig(mgr, id, kind, database, routine).await?;
    let targets = inspect::write_targets(mgr, id, kind, database, routine).await?;
    let (_, name) = inspect::split_routine(kind, database, routine);
    let rt = match sig.kind {
        inspect::RoutineKind::Procedure => "procedure",
        inspect::RoutineKind::Function => "function",
    };
    let definition = match mgr.routine_definition(id, database, &name, rt).await {
        Ok(d) => d,
        Err(_) => mgr.routine_definition(id, database, routine, rt).await.unwrap_or_default(),
    };
    let mut ddl = serde_json::Map::new();
    for t in &targets {
        if let Ok(d) = mgr.table_ddl(id, database, t).await {
            ddl.insert(t.clone(), serde_json::Value::String(d));
        }
    }
    Ok(serde_json::json!({
        "routine": routine,
        "kind": format!("{kind:?}").to_ascii_lowercase(),
        "database": database,
        "signature": sig,
        "write_targets": targets,
        "definition": definition,
        "tables_ddl": ddl,
        "breaks_wrapping": inspect::body_breaks_wrapping(kind, &definition),
    }))
}

/// 給 AI 的「產生情境」提示：盤點結果 + 測試檔 schema + 情境型態清單。回覆要求單一 ```json 區塊。
#[tauri::command]
pub async fn sp_test_testgen_prompt(
    state: State<'_, AppState>,
    id: String,
    database: String,
    routine: String,
    lang: Option<String>,
) -> AppResult<String> {
    let info = inspect_json(&state.manager, &id, &database, &routine).await?;
    let reply = match lang.as_deref().unwrap_or("zh-TW") {
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "vi" => "Vietnamese",
        "zh-CN" => "Simplified Chinese",
        _ => "Traditional Chinese",
    };
    let ddl = info["tables_ddl"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| format!("-- {k}\n{}", v.as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n\n"))
        .unwrap_or_default();
    Ok(format!(
        "You are writing integration tests for a stored procedure that will run against a real {kind} database inside a transaction that is rolled back afterwards.\n\
Produce ONE test file in the JSON format below and nothing else (a single ```json code block). Descriptions and ids may be in {reply}; keys and values must follow the schema exactly.\n\n\
# Test file schema\n{schema}\n\n\
# Target\nengine: {kind}\ndatabase/schema: {db}\nroutine: {routine}\n\
signature: {sig}\n\
write targets (tables modified directly, through callees or triggers): {targets}\n\
breaks_wrapping (contains COMMIT/ROLLBACK/DDL): {breaks}\n\n\
# Routine definition\n```sql\n{def}\n```\n\n\
# Table definitions\n{ddl}\n\n\
# Guidelines\n\
- 4–8 scenarios: happy path; boundaries (0 / negative / maximum / string length); NULL for each nullable parameter; EVERY error branch (THROW / RAISERROR / SIGNAL / RAISE) as its own scenario with `expect_error` (class, and `message_contains` when the message is stable); a multi-step business flow that calls related routines and checks state in between with `query`; an invariant `query` (sums / counts that must be conserved).\n\
- Put shared seed rows in `fixtures` and reference them with `use`. Capture generated keys with \">>sym\" and reference them with \"<<sym\" — never hard-code identity values or timestamps.\n\
- Assert only the columns that matter. Use `effects` for side effects (counts, or rows for the important ones). Use `cases` for data-driven variants of the same steps.\n\
- Table names without schema prefix; parameter names exactly as in the signature; decimals as strings (\"25.00\").\n\
- `target.kind` must be \"{kind}\" and `target.database` must be \"{db}\"; set `routine` to \"{routine}\".\n",
        kind = info["kind"].as_str().unwrap_or(""),
        reply = reply,
        schema = model::SCHEMA_DOC,
        db = database,
        routine = routine,
        sig = serde_json::to_string(&info["signature"]).unwrap_or_default(),
        targets = serde_json::to_string(&info["write_targets"]).unwrap_or_default(),
        breaks = info["breaks_wrapping"],
        def = info["definition"].as_str().unwrap_or(""),
        ddl = ddl,
    ))
}

#[derive(Debug, Deserialize)]
pub struct SpTestFileInput {
    pub name: String,
    pub text: String,
}

/// 執行。`targets`：assert / record / golden 一個；diff 兩個。回每個檔案的報表。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sp_test_run(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    targets: Vec<EngineRef>,
    files: Vec<SpTestFileInput>,
    mode: ExecMode,
    golden_dir: Option<String>,
    only: Option<Vec<String>>,
    row_cap: Option<usize>,
) -> AppResult<Vec<FileReport>> {
    let opts = RunOptions {
        mode,
        golden_dir: golden_dir.filter(|s| !s.trim().is_empty()).map(PathBuf::from),
        row_cap: row_cap.unwrap_or(10_000),
        only: only.unwrap_or_default(),
        tags: vec![],
    };
    let emit = move |p: Progress| {
        let _ = app.emit("sp-test-progress", p);
    };
    let mut out = Vec::new();
    for f in &files {
        let file: TestFile = serde_json::from_str(&f.text).map_err(|e| AppError::Query(tf!("{file} 解析失敗：{e}", file = f.name, e = e.to_string())))?;
        out.push(run_file(&state.manager, &run_id, &targets, &file, &f.name, &opts, &emit).await?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn sp_test_cancel(run_id: String) -> AppResult<()> {
    crate::sptest::cancel(&run_id);
    Ok(())
}

/// 把報表寫到 `<dir>/reports/`：JUnit XML + Markdown。回兩個路徑。
#[tauri::command]
pub async fn sp_test_export(dir: String, reports: Vec<FileReport>) -> AppResult<(String, String)> {
    let base = Path::new(dir.trim()).join("reports");
    tokio::fs::create_dir_all(&base).await.map_err(|e| AppError::Storage(e.to_string()))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let junit = base.join(format!("{stamp}.junit.xml"));
    let md = base.join(format!("{stamp}.md"));
    tokio::fs::write(&junit, report::to_junit(&reports)).await.map_err(|e| AppError::Storage(e.to_string()))?;
    tokio::fs::write(&md, report::render_md(&reports)).await.map_err(|e| AppError::Storage(e.to_string()))?;
    Ok((junit.display().to_string(), md.display().to_string()))
}
