//! 編排：建立輸出目錄 → 逐句（重新探測 → 前像 → 回滾片段先落地 → 執行 → 後像 → 差異）→ 報告。
//!
//! 為什麼逐句擷取、而不是開跑前一次抓完所有前像：腳本裡後面的語句常依賴前面的結果
//!（先 UPDATE 狀態、再 DELETE 某狀態的列）。開跑前抓的前像對第二句是錯的，產出的回滾會把
//! 第一句的效果一起「還原」掉一半。
//!
//! 為什麼回滾片段在**執行前**就寫進 rollback.sql：這句執行到一半斷線、或 App 被關掉，
//! 輸出目錄裡仍有涵蓋到這句為止的回滾腳本。

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::analyze::Op;
use super::capture::{self, ExecContext, TableSnapshot};
use super::plan::{self, clamp_cap, NoteLevel, Prepared, RollbackLevel, SchemaGroup, StatementProbe, Strategy};
use super::report::{self, DiffSummary, RunManifest, RunStatus, StatementRecord, StmtStatus};
use super::rollback::{self, Fragment, Line, PreOp, RowOp, TableDiff};
use crate::compare::ddl::SyncOptions;
use crate::compare::diff::DiffOptions;
use crate::compare::schema::DbSchema;
use crate::db::sqlgen::qualified;
use crate::db::DbKind;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// 只擷取前像、產生審查與回滾腳本，不執行。
    Backup,
    Execute,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunOptions {
    /// 每句前像的擷取上限（0 = 預設 10,000）。
    #[serde(default)]
    pub max_capture_rows: usize,
    /// 接受「有語句沒有完整回滾」。
    #[serde(default)]
    pub allow_incomplete: bool,
    /// 正式環境連線的明確確認。
    #[serde(default)]
    pub confirm_prod: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Progress {
    pub run_id: String,
    /// prepare | capture_before | execute | capture_after | write | done
    pub phase: String,
    pub index: usize,
    pub total: usize,
    pub detail: String,
}

pub type ProgressFn<'a> = &'a (dyn Fn(Progress) + Send + Sync);

pub struct RunRequest<'a> {
    pub run_id: &'a str,
    pub conn_label: &'a str,
    pub database: &'a str,
    pub script: &'a str,
    pub out_dir: &'a Path,
    pub mode: RunMode,
    pub options: RunOptions,
    pub review: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunOutcome {
    pub dir: String,
    pub manifest: RunManifest,
    /// rollback.sql 開頭一段（對話框預覽用；完整內容在檔案裡）。
    pub rollback_preview: String,
    pub diff_preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewPrepared {
    pub prepared: Prepared,
    pub prompt: String,
}

const PREVIEW_BYTES: usize = 64 * 1024;
const MAX_SAMPLE_ROWS: usize = 20;

/// 分析 + 探測 + AI 審查提示（可附前像樣本）。
pub async fn prepare_review(
    mgr: &ConnectionManager,
    id: &str,
    conn_label: &str,
    database: &str,
    script: &str,
    cap: usize,
    sample_rows: usize,
) -> AppResult<ReviewPrepared> {
    let prep = plan::prepare(mgr, id, database, script, cap).await?;
    let sample_rows = sample_rows.min(MAX_SAMPLE_ROWS);
    let mut snaps: Vec<(usize, TableSnapshot)> = Vec::new();
    if sample_rows > 0 {
        if let Some(ctx) = &prep.ctx {
            for st in prep.statements.iter().filter(|s| s.write) {
                let snap = match &st.strategy {
                    Strategy::Predicate { meta, target, source, predicate, fanout, .. } => {
                        capture::capture_predicate(mgr, id, ctx, meta, target, source, predicate.as_deref(), *fanout, sample_rows).await.ok()
                    }
                    Strategy::WholeTables { metas } => match metas.first() {
                        Some(m) => capture::capture_whole(mgr, id, ctx, m, sample_rows).await.ok(),
                        None => None,
                    },
                    Strategy::Keys { meta, keys } => {
                        let k: Vec<Vec<String>> = keys.iter().take(sample_rows).cloned().collect();
                        capture::capture_by_keys(mgr, id, ctx, meta, &k, "keys").await.ok()
                    }
                    _ => None,
                };
                if let Some(s) = snap {
                    snaps.push((st.index, s));
                }
            }
        }
    }
    let samples: Vec<report::Sample<'_>> = snaps.iter().map(|(i, s)| report::Sample { index: *i, snapshot: s }).collect();
    let prompt = report::build_review_prompt(&prep, conn_label, script, &samples, crate::i18n::current());
    Ok(ReviewPrepared { prepared: prep, prompt })
}

// ---------------------------------------------------------------------------
// 輸出目錄
// ---------------------------------------------------------------------------

fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    let trimmed: String = cleaned.trim_matches(['_', '.']).chars().take(40).collect();
    if trimmed.is_empty() {
        "db".to_string()
    } else {
        trimmed
    }
}

struct Out {
    dir: PathBuf,
    files: Vec<String>,
}

impl Out {
    async fn create(base: &Path, conn: &str, db: &str) -> AppResult<Out> {
        if base.as_os_str().is_empty() {
            return Err(AppError::Storage(t!("請指定輸出目錄").into()));
        }
        tokio::fs::create_dir_all(base)
            .await
            .map_err(|e| AppError::Storage(tf!("無法建立輸出目錄 {dir}：{e}", dir = base.display(), e = e.to_string())))?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let name = format!("{stamp}_{}_{}", sanitize(conn), sanitize(db));
        let mut dir = base.join(&name);
        let mut n = 2;
        while tokio::fs::try_exists(&dir).await.unwrap_or(false) {
            dir = base.join(format!("{name}-{n}"));
            n += 1;
        }
        tokio::fs::create_dir_all(dir.join("snapshots"))
            .await
            .map_err(|e| AppError::Storage(tf!("無法建立輸出目錄 {dir}：{e}", dir = dir.display(), e = e.to_string())))?;
        Ok(Out { dir, files: vec![] })
    }

    async fn write(&mut self, rel: &str, content: &[u8]) -> AppResult<()> {
        let path = self.dir.join(rel);
        // 先寫暫存檔再改名：中途失敗不會留下半截的 rollback.sql。
        let tmp = path.with_extension("tmp");
        tokio::fs::write(&tmp, content)
            .await
            .map_err(|e| AppError::Storage(tf!("寫入 {file} 失敗：{e}", file = rel, e = e.to_string())))?;
        tokio::fs::rename(&tmp, &path)
            .await
            .map_err(|e| AppError::Storage(tf!("寫入 {file} 失敗：{e}", file = rel, e = e.to_string())))?;
        if !self.files.iter().any(|f| f == rel) {
            self.files.push(rel.to_string());
        }
        Ok(())
    }

    async fn write_json<T: Serialize>(&mut self, rel: &str, v: &T) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(v).map_err(|e| AppError::Storage(e.to_string()))?;
        self.write(rel, &bytes).await
    }

    fn snapshot_name(&self, index: usize, phase: &str, table: &str) -> String {
        let base = format!("snapshots/{:02}-{phase}-{}", index + 1, sanitize(table));
        let mut name = format!("{base}.json");
        let mut n = 2;
        while self.files.contains(&name) {
            name = format!("{base}-{n}.json");
            n += 1;
        }
        name
    }
}

#[derive(Serialize)]
struct SnapshotFile<'a> {
    app_version: &'static str,
    kind: DbKind,
    statement: usize,
    phase: &'a str,
    #[serde(flatten)]
    snapshot: &'a TableSnapshot,
}

#[derive(Serialize)]
struct SchemaFile<'a> {
    app_version: &'static str,
    statement: usize,
    phase: &'a str,
    schema: &'a DbSchema,
}

// ---------------------------------------------------------------------------
// 擷取
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Captured {
    before: Vec<TableSnapshot>,
    schema_before: Vec<DbSchema>,
    /// KeyRange：執行前的最大鍵（外層 Some = 有擷取；內層 None = 表是空的）。
    max_key: Option<Option<String>>,
}

async fn capture_before(mgr: &ConnectionManager, id: &str, ctx: &ExecContext, probe: &StatementProbe, cap: usize) -> AppResult<Captured> {
    let mut c = Captured::default();
    match &probe.strategy {
        Strategy::Predicate { meta, target, source, predicate, fanout, .. } => {
            c.before.push(capture::capture_predicate(mgr, id, ctx, meta, target, source, predicate.as_deref(), *fanout, cap).await?);
        }
        Strategy::WholeTables { metas } => {
            for m in metas {
                c.before.push(capture::capture_whole(mgr, id, ctx, m, cap).await?);
            }
        }
        Strategy::Keys { meta, keys } => {
            c.before.push(capture::capture_by_keys(mgr, id, ctx, meta, keys, "keys").await?);
        }
        Strategy::KeyRange { meta } => {
            c.max_key = Some(capture::max_key(mgr, id, ctx, meta).await?);
        }
        Strategy::Schema { groups, data } => {
            for g in groups {
                c.schema_before.push(capture::capture_schema(mgr, id, &g.database, &g.targets()).await?);
            }
            for m in data {
                c.before.push(capture::capture_whole(mgr, id, ctx, m, cap).await?);
            }
        }
        _ => {}
    }
    Ok(c)
}

fn fragment_title(probe: &StatementProbe) -> String {
    let sql: String = probe.sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = sql.chars().take(160).collect();
    let target = probe.targets.first().cloned().unwrap_or_default();
    format!(
        "#{} {}{}\n{}",
        probe.index + 1,
        short,
        if sql.chars().count() > 160 { "…" } else { "" },
        tf!("目標：{target}　回滾：{level}", target = if target.is_empty() { "—".into() } else { target }, level = report::level_text(probe.rollback))
    )
}

fn push_notes(f: &mut Fragment, probe: &StatementProbe) {
    for n in probe.notes.iter().filter(|n| n.level != NoteLevel::Info) {
        f.comment(format!("⚠ {}", n.message));
    }
}

/// 執行前（只有前像）的回滾片段。
fn pre_fragment(kind: DbKind, probe: &StatementProbe, cap: &Captured) -> Fragment {
    let mut f = Fragment::new(probe.index, fragment_title(probe));
    push_notes(&mut f, probe);
    match &probe.strategy {
        Strategy::Predicate { set_columns, .. } => {
            for snap in &cap.before {
                let op = if probe.op == Op::Update { PreOp::Update { set_columns: set_columns.as_deref() } } else { PreOp::Reinsert };
                rollback::rollback_before_only(&mut f, kind, snap, op);
            }
        }
        Strategy::WholeTables { .. } => {
            for snap in &cap.before {
                let op = if probe.op == Op::Truncate { PreOp::Reinsert } else { PreOp::ReplaceTable };
                rollback::rollback_before_only(&mut f, kind, snap, op);
            }
        }
        Strategy::Keys { keys, .. } => {
            for snap in &cap.before {
                rollback::rollback_before_only(&mut f, kind, snap, PreOp::Keys { keys });
            }
        }
        Strategy::KeyRange { .. } => {
            f.comment(t!("新增了哪些列要執行後才知道；這段回滾會在執行後產生。"));
        }
        Strategy::Schema { groups, .. } => schema_pre(&mut f, kind, probe, groups, cap),
        Strategy::Rename { inverse } => f.sql(inverse.clone()),
        Strategy::None | Strategy::Unsupported => {
            if probe.rollback != RollbackLevel::NotNeeded {
                f.comment(t!("這句沒有自動產生的回滾，請依上方說明手動處理。"));
            }
        }
    }
    f
}

fn sync_options() -> SyncOptions {
    SyncOptions { include_drops: true, include_indexes: true, include_fks: true, include_views: true, include_routines: true }
}

/// 反向 DDL：讓 `after` 變回 `before`。回傳可執行語句與無法表達的變更。
fn reverse_ddl(before: &DbSchema, after: &DbSchema) -> (Vec<(String, Option<String>)>, Vec<String>) {
    let d = crate::compare::diff::diff(before, after, &DiffOptions::default());
    match crate::compare::ddl::generate(&d, before, after, &sync_options()) {
        Ok(script) => (script.statements.into_iter().map(|s| (s.sql, s.note)).collect(), script.skipped),
        Err(e) => (vec![], vec![e.message()]),
    }
}

fn push_ddl(f: &mut Fragment, stmts: Vec<(String, Option<String>)>, skipped: Vec<String>) -> Vec<String> {
    let mut sqls = Vec::new();
    for (sql, note) in stmts {
        if let Some(n) = note {
            f.comment(n);
        }
        sqls.push(sql.clone());
        f.sql(sql);
    }
    for s in skipped {
        f.comment(tf!("無法自動產生：{what}", what = s));
    }
    sqls
}

fn schema_pre(f: &mut Fragment, kind: DbKind, probe: &StatementProbe, groups: &[SchemaGroup], cap: &Captured) {
    for (g, before) in groups.iter().zip(&cap.schema_before) {
        for name in &g.missing {
            if g.tables.contains(name) {
                f.sql(format!("DROP TABLE {}", qualified(kind, &g.database, name)));
            } else if g.views.contains(name) {
                f.sql(format!("DROP VIEW {}", qualified(kind, &g.database, name)));
            } else {
                f.comment(tf!("{name} 是這句新建的程序 / 函式，請手動刪除。", name = name));
            }
        }
        match probe.op {
            // 刪除物件：以「沒有這些物件」模擬執行後，反向 DDL 就是把它們建回來。
            Op::DropTable | Op::DropView | Op::DropRoutine => {
                let mut after = before.clone();
                after.tables.retain(|t| !g.tables.contains(&t.name));
                after.views.retain(|t| !g.views.contains(&t.name));
                after.routines.retain(|r| !g.routines.iter().any(|n| n.eq_ignore_ascii_case(&r.info.name)));
                let (stmts, skipped) = reverse_ddl(before, &after);
                push_ddl(f, stmts, skipped);
            }
            _ => {
                let existing = before.tables.iter().chain(&before.views).filter(|t| !g.missing.contains(&t.name));
                let mut any = false;
                for t in existing {
                    if let Some(ddl) = &t.ddl {
                        if !any {
                            f.comment(t!("結構變更的精確反向 DDL 要執行後才能產生；以下是執行前的定義，供手動還原參考。"));
                            any = true;
                        }
                        f.disabled(tf!("{name} 執行前的定義", name = t.name), ddl.clone());
                    }
                }
            }
        }
    }
    for snap in &cap.before {
        if probe.op == Op::DropTable {
            rollback::rollback_before_only(f, kind, snap, PreOp::Reinsert);
        } else {
            f.comment(tf!(
                "{table} 的資料前像（{n} 列）已存於 snapshots/；精確的資料還原語句會在執行後產生。",
                table = snap.meta.table,
                n = snap.rows.len()
            ));
        }
    }
}

struct PostResult {
    fragment: Fragment,
    diffs: Vec<TableDiff>,
    ddl: Vec<String>,
    after: Vec<TableSnapshot>,
    schema_after: Vec<DbSchema>,
}

/// 執行後：擷取後像、比對、產生精確回滾。
async fn post_fragment(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    probe: &StatementProbe,
    cap: &Captured,
    rows_affected: u64,
    max_rows: usize,
) -> AppResult<PostResult> {
    let kind = ctx.kind;
    let mut r = PostResult { fragment: Fragment::new(probe.index, fragment_title(probe)), diffs: vec![], ddl: vec![], after: vec![], schema_after: vec![] };
    push_notes(&mut r.fragment, probe);
    match &probe.strategy {
        Strategy::Predicate { meta, .. } => {
            let before = &cap.before[0];
            let after = if meta.key.is_empty() {
                // 無鍵：DELETE 假設前像中的列全數被刪（UPDATE 無鍵在探測時已判為沒有回滾）。
                r.fragment.comment(t!("此表沒有主鍵或唯一鍵：假設前像中的列全部受到影響。"));
                TableSnapshot::empty(meta.clone(), "assumed", false)
            } else {
                match capture::snapshot_key_literals(kind, before) {
                    Some(keys) if !keys.is_empty() => capture::capture_by_keys(mgr, id, ctx, meta, &keys, "keys").await?,
                    Some(_) => TableSnapshot::empty(meta.clone(), "keys", false),
                    None => return Ok(fallback_post(kind, probe, cap, t!("前像的鍵值無法還原成字面值，改用執行前的預估回滾。"))),
                }
            };
            if meta.key.is_empty() && probe.op == Op::Update {
                return Ok(fallback_post(kind, probe, cap, t!("此表沒有主鍵或唯一鍵，無法比對修改。")));
            }
            let d = rollback::diff_snapshots(before, &after);
            let op = if probe.op == Op::Update { RowOp::Update } else { RowOp::Delete };
            rollback::rollback_from_diff(&mut r.fragment, kind, &before.meta, &d, op);
            r.diffs.push(d);
            r.after.push(after);
        }
        Strategy::WholeTables { metas } => {
            for (m, before) in metas.iter().zip(&cap.before) {
                let after = capture::capture_whole(mgr, id, ctx, m, max_rows).await?;
                let d = rollback::diff_snapshots(before, &after);
                rollback::rollback_from_diff(&mut r.fragment, kind, &before.meta, &d, RowOp::Any);
                r.diffs.push(d);
                r.after.push(after);
            }
        }
        Strategy::Keys { meta, keys } => {
            let before = &cap.before[0];
            let after = capture::capture_by_keys(mgr, id, ctx, meta, keys, "keys").await?;
            let d = rollback::diff_snapshots(before, &after);
            rollback::rollback_from_diff(&mut r.fragment, kind, &before.meta, &d, RowOp::Any);
            r.diffs.push(d);
            r.after.push(after);
        }
        Strategy::KeyRange { meta } => {
            let max = cap.max_key.clone().flatten();
            let after = capture::capture_key_range(mgr, id, ctx, meta, max.as_deref(), max_rows).await?;
            let before = TableSnapshot::empty(meta.clone(), "key_range", false);
            let d = rollback::diff_snapshots(&before, &after);
            let mut frag = Fragment::new(probe.index, fragment_title(probe));
            push_notes(&mut frag, probe);
            rollback::rollback_from_diff(&mut frag, kind, meta, &d, RowOp::Any);
            let found = after.rows.len() as u64;
            if rows_affected > 0 && found != rows_affected {
                // 抓到的列數與這句回報的新增列數不同：多半是同時有別的連線在寫，DELETE 一律改成需人工確認。
                let reason = tf!(
                    "這句回報新增 {n} 列，但依主鍵範圍找到 {found} 列：可能混入其他連線同時新增的列",
                    n = rows_affected,
                    found = found
                );
                frag.lines = frag
                    .lines
                    .into_iter()
                    .map(|l| match l {
                        Line::Sql { sql } => Line::Disabled { reason: reason.clone(), sql },
                        other => other,
                    })
                    .collect();
            }
            r.fragment = frag;
            r.diffs.push(d);
            r.after.push(after);
        }
        Strategy::Schema { groups, data } => {
            for (g, before) in groups.iter().zip(&cap.schema_before) {
                let after = capture::capture_schema(mgr, id, &g.database, &g.targets()).await?;
                let (stmts, skipped) = reverse_ddl(before, &after);
                let sqls = push_ddl(&mut r.fragment, stmts, skipped);
                r.ddl.extend(sqls);
                r.schema_after.push(after);
            }
            for (m, before) in data.iter().zip(&cap.before) {
                let exists = mgr
                    .list_tables(id, &m.database)
                    .await
                    .map(|l| l.iter().any(|t| t.name == m.table))
                    .unwrap_or(false);
                let after = if exists {
                    let fresh = capture::table_meta(mgr, id, kind, &m.database, &m.table).await?;
                    capture::capture_whole(mgr, id, ctx, &fresh, max_rows).await?
                } else {
                    TableSnapshot::empty(m.clone(), "whole_table", true)
                };
                let d = rollback::diff_snapshots(before, &after);
                rollback::rollback_from_diff(&mut r.fragment, kind, &before.meta, &d, RowOp::Any);
                r.diffs.push(d);
                r.after.push(after);
            }
        }
        Strategy::Rename { inverse } => r.fragment.sql(inverse.clone()),
        Strategy::None | Strategy::Unsupported => {
            if probe.rollback != RollbackLevel::NotNeeded {
                r.fragment.comment(t!("這句沒有自動產生的回滾，請依上方說明手動處理。"));
            }
        }
    }
    Ok(r)
}

fn fallback_post(kind: DbKind, probe: &StatementProbe, cap: &Captured, why: &str) -> PostResult {
    let mut fragment = pre_fragment(kind, probe, cap);
    fragment.lines.insert(0, Line::Comment { text: why.to_string() });
    PostResult { fragment, diffs: vec![], ddl: vec![], after: vec![], schema_after: vec![] }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

fn now_text() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S %:z").to_string()
}

fn record_from_probe(p: &StatementProbe) -> StatementRecord {
    StatementRecord {
        index: p.index,
        sql: p.sql.clone(),
        op: p.op,
        write: p.write,
        destructive: p.destructive,
        targets: p.targets.clone(),
        method: p.method.clone(),
        estimated_rows: p.estimated_rows,
        rollback: p.rollback,
        notes: p.notes.clone(),
        status: StmtStatus::NotRun,
        rows_affected: None,
        elapsed_ms: None,
        error: None,
        files: vec![],
        diff: vec![],
        ddl_statements: 0,
        rollback_statements: 0,
        rollback_disabled: 0,
        rollback_exact: false,
    }
}

fn blockers_error(prep: &Prepared) -> AppError {
    let lines: Vec<String> = prep.blockers.iter().map(|b| format!("#{}：{}", b.index + 1, b.message)).collect();
    AppError::Query(tf!("腳本含本流程不支援的語句，未執行任何動作：\n{list}", list = lines.join("\n")))
}

fn script_header(kind: DbKind, conn: &str, db: &str, mode: RunMode, in_progress: bool) -> Vec<String> {
    let mut h = vec![
        t!("db-kit 回滾腳本").to_string(),
        tf!("連線：{conn}　資料庫：{db}　種類：{kind}　產生時間：{at}", conn = conn, db = db, kind = report::kind_label(kind), at = now_text()),
    ];
    match mode {
        RunMode::Execute => h.push(t!("依執行前後的前後像比對產生；某句若拿不到後像，該段改用執行前的預估。").into()),
        RunMode::Backup => h.push(t!("依執行前的前像產生（腳本尚未執行）：UPDATE 整列寫回、DELETE 補回；前後相依的語句請人工確認。").into()),
    }
    if in_progress {
        h.push(t!("【執行中】這是執行過程中的暫存版本，只涵蓋到目前這句為止。").into());
    }
    h.push(t!("最後一句排在最前面，請由上往下執行。被註解掉的語句需人工確認後再取消註解。").into());
    h
}

pub async fn run(mgr: &ConnectionManager, id: &str, req: RunRequest<'_>, progress: ProgressFn<'_>) -> AppResult<RunOutcome> {
    let guard = crate::compare::register(req.run_id);
    let cancelled = || guard.flag.load(Ordering::Relaxed);
    let cap = clamp_cap(req.options.max_capture_rows);
    let emit = |phase: &str, index: usize, total: usize, detail: String| {
        progress(Progress { run_id: req.run_id.to_string(), phase: phase.into(), index, total, detail });
    };
    let started_at = now_text();
    emit("prepare", 0, 0, String::new());

    let prep = plan::prepare(mgr, id, req.database, req.script, cap).await?;
    if !prep.blockers.is_empty() {
        return Err(blockers_error(&prep));
    }
    let ctx = prep.ctx.clone().expect("prepare 一定帶 ctx");
    let kind = ctx.kind;
    let execute = req.mode == RunMode::Execute;
    if execute {
        if prep.prod && !req.options.confirm_prod {
            return Err(AppError::NeedsConfirm(t!("這是正式環境連線，需要明確確認才能執行。").into()));
        }
        if prep.needs_ack && !req.options.allow_incomplete {
            return Err(AppError::NeedsConfirm(t!("有語句沒有完整回滾，需要明確確認才能執行。").into()));
        }
    }

    let mut out = Out::create(req.out_dir, req.conn_label, &prep.database).await?;
    out.write("script.sql", req.script.as_bytes()).await?;
    if let Some(r) = req.review.as_deref().filter(|r| !r.trim().is_empty()) {
        out.write("review.md", r.as_bytes()).await?;
    }
    let verdict = req.review.as_deref().and_then(report::parse_verdict);

    let total = prep.statements.len();
    let mut records: Vec<StatementRecord> = prep.statements.iter().map(record_from_probe).collect();
    let mut pre: Vec<Option<Fragment>> = vec![None; total];
    let mut post: Vec<Option<Fragment>> = vec![None; total];
    let mut diffs: Vec<(usize, Vec<TableDiff>, Vec<String>)> = Vec::new();
    let mut status = if execute { RunStatus::Completed } else { RunStatus::BackupOnly };
    let mut stop_reason: Option<String> = None;

    for i in 0..total {
        if cancelled() {
            status = RunStatus::Cancelled;
            break;
        }
        let mut probe = prep.statements[i].clone();
        if execute && i > 0 && probe.write {
            // 前面的語句可能改了結構或資料：以執行到這句時的狀態重新探測。
            let fresh = plan::probe_statement(mgr, id, &ctx, &probe.plan, cap).await;
            let worse = fresh.rollback > probe.rollback;
            probe = fresh;
            let rec = &mut records[i];
            rec.rollback = probe.rollback;
            rec.notes = probe.notes.clone();
            rec.estimated_rows = probe.estimated_rows;
            rec.method = probe.method.clone();
            rec.targets = probe.targets.clone();
            if worse && !req.options.allow_incomplete && matches!(probe.rollback, RollbackLevel::Partial | RollbackLevel::None) {
                status = RunStatus::Stopped;
                stop_reason = Some(tf!("執行到第 {n} 句時，它的回滾等級降為「{level}」，已停在這句之前。", n = i + 1, level = report::level_text(probe.rollback)));
                break;
            }
        }

        let mut captured = Captured::default();
        if probe.write {
            emit("capture_before", i, total, probe.targets.join(", "));
            match capture_before(mgr, id, &ctx, &probe, cap).await {
                Ok(c) => captured = c,
                Err(e) => {
                    let msg = tf!("擷取前像失敗：{err}", err = e.message());
                    records[i].notes.push(plan::Note { code: "capture_failed".into(), level: NoteLevel::Error, message: msg.clone() });
                    records[i].rollback = RollbackLevel::None;
                    probe.rollback = RollbackLevel::None;
                    if execute && !req.options.allow_incomplete {
                        status = RunStatus::Stopped;
                        stop_reason = Some(tf!("第 {n} 句：{msg}", n = i + 1, msg = msg));
                        break;
                    }
                }
            }
            if captured.before.iter().any(|s| s.truncated) {
                records[i].rollback = records[i].rollback.max(RollbackLevel::Partial);
                probe.rollback = records[i].rollback;
                if execute && !req.options.allow_incomplete {
                    status = RunStatus::Stopped;
                    stop_reason = Some(tf!("第 {n} 句的前像超過擷取上限 {cap} 列，已停在這句之前。", n = i + 1, cap = cap));
                    break;
                }
            }
            for snap in &captured.before {
                let name = out.snapshot_name(i, "before", &snap.meta.table);
                out.write_json(&name, &SnapshotFile { app_version: env!("CARGO_PKG_VERSION"), kind, statement: i + 1, phase: "before", snapshot: snap }).await?;
                records[i].files.push(name);
            }
            for s in &captured.schema_before {
                let name = out.snapshot_name(i, "schema-before", &s.database);
                out.write_json(&name, &SchemaFile { app_version: env!("CARGO_PKG_VERSION"), statement: i + 1, phase: "before", schema: s }).await?;
                records[i].files.push(name);
            }
            pre[i] = Some(pre_fragment(kind, &probe, &captured));
        }
        if !execute {
            continue;
        }
        if probe.write {
            // 回滾片段先落地，再執行。
            let interim: Vec<Fragment> = (0..=i).filter_map(|k| post[k].clone().or_else(|| pre[k].clone())).collect();
            let text = rollback::render_script(kind, &script_header(kind, req.conn_label, &prep.database, req.mode, true), &interim);
            out.write("rollback.sql", text.as_bytes()).await?;
        }
        if cancelled() {
            status = RunStatus::Cancelled;
            break;
        }
        emit("execute", i, total, String::new());
        let t0 = Instant::now();
        let result = mgr.query_capped(id, &ctx.with_prefix(&probe.sql), 200).await;
        let elapsed = t0.elapsed().as_millis() as u64;
        records[i].elapsed_ms = Some(elapsed);
        let rows_affected = match result {
            Ok(q) => {
                let n = if q.columns.is_empty() { q.rows_affected } else { q.rows.len() as u64 };
                records[i].status = StmtStatus::Ok;
                records[i].rows_affected = Some(n);
                n
            }
            Err(e) => {
                records[i].status = StmtStatus::Failed;
                records[i].error = Some(e.message());
                // 單句 autocommit 失敗不會留下變更，這句不需要回滾片段。
                if let Some(f) = pre[i].as_mut() {
                    f.lines = vec![Line::Comment { text: t!("這句執行失敗，資料庫沒有套用它的變更，不需要回滾。").into() }];
                }
                status = RunStatus::Failed;
                stop_reason = Some(tf!("第 {n} 句執行失敗：{err}", n = i + 1, err = e.message()));
                break;
            }
        };
        if !probe.write {
            continue;
        }
        emit("capture_after", i, total, probe.targets.join(", "));
        match post_fragment(mgr, id, &ctx, &probe, &captured, rows_affected, cap).await {
            Ok(res) => {
                for snap in &res.after {
                    let name = out.snapshot_name(i, "after", &snap.meta.table);
                    out.write_json(&name, &SnapshotFile { app_version: env!("CARGO_PKG_VERSION"), kind, statement: i + 1, phase: "after", snapshot: snap }).await?;
                    records[i].files.push(name);
                }
                for s in &res.schema_after {
                    let name = out.snapshot_name(i, "schema-after", &s.database);
                    out.write_json(&name, &SchemaFile { app_version: env!("CARGO_PKG_VERSION"), statement: i + 1, phase: "after", schema: s }).await?;
                    records[i].files.push(name);
                }
                records[i].diff = res.diffs.iter().map(|d| DiffSummary::of(kind, d)).collect();
                records[i].ddl_statements = res.ddl.len();
                records[i].rollback_exact = true;
                if !res.diffs.is_empty() || !res.ddl.is_empty() {
                    diffs.push((i, res.diffs, res.ddl));
                }
                post[i] = Some(res.fragment);
            }
            Err(e) => {
                records[i].notes.push(plan::Note {
                    code: "capture_after_failed".into(),
                    level: NoteLevel::Warn,
                    message: tf!("擷取後像失敗，這句的回滾改用執行前的預估：{err}", err = e.message()),
                });
            }
        }
    }

    emit("write", total, total, String::new());
    let fragments: Vec<Fragment> = (0..total).filter_map(|k| post[k].clone().or_else(|| pre[k].clone())).collect();
    for f in &fragments {
        records[f.index].rollback_statements = f.executable_count();
        records[f.index].rollback_disabled = f.disabled_count();
    }
    let rollback_text = rollback::render_script(kind, &script_header(kind, req.conn_label, &prep.database, req.mode, false), &fragments);
    out.write("rollback.sql", rollback_text.as_bytes()).await?;

    let mut manifest = RunManifest {
        app: "db-kit",
        app_version: env!("CARGO_PKG_VERSION"),
        run_id: req.run_id.to_string(),
        mode: req.mode,
        status,
        stop_reason,
        connection: req.conn_label.to_string(),
        kind,
        database: prep.database.clone(),
        prod: prep.prod,
        started_at,
        finished_at: now_text(),
        max_capture_rows: cap,
        verdict,
        statements: records,
        files: vec![],
    };
    let mut diff_text = String::new();
    if execute {
        diff_text = report::render_diff(kind, &manifest, &diffs);
        out.write("diff.md", diff_text.as_bytes()).await?;
    }
    for f in ["report.md", "manifest.json"] {
        if !out.files.iter().any(|x| x == f) {
            out.files.push(f.to_string());
        }
    }
    manifest.files = out.files.clone();
    manifest.files.sort_by_key(|f| (f.starts_with("snapshots/"), f.clone()));
    out.write("report.md", report::render_report(&manifest).as_bytes()).await?;
    out.write_json("manifest.json", &manifest).await?;
    emit("done", total, total, String::new());

    let clip = |s: &str| -> String {
        if s.len() <= PREVIEW_BYTES {
            return s.to_string();
        }
        let mut end = PREVIEW_BYTES;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n…", &s[..end])
    };
    Ok(RunOutcome { dir: out.dir.display().to_string(), manifest, rollback_preview: clip(&rollback_text), diff_preview: clip(&diff_text) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_names_readable_and_safe() {
        assert_eq!(sanitize("prod mysql / shop"), "prod_mysql___shop");
        assert_eq!(sanitize("客戶資料庫"), "客戶資料庫");
        assert_eq!(sanitize("../.."), "db");
        assert_eq!(sanitize("a:b*c?"), "a_b_c");
    }
}
