//! 情境執行器：展開 fixtures / cases → 每個目標引擎開專屬連線 → 開場 → 逐 step 執行與斷言 → 收場 rollback。
//!
//! 模式：`assert`（只比 expect）、`record`（把實際輸出寫成基線）、`golden`（expect + 基線）、
//! `diff`（兩個目標跑同一檔，各比 expect 再互比）。步驟之間檢查取消旗標；進行中的情境一定跑到收場。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::assert::{self, CmpOpts, Difference};
use super::errclass::classify;
use super::inspect::{self, RoutineSig};
use super::model::{capture_name, CallStep, OnError, ResultSetExpect, Scenario, SnapshotSpec, Step, TableMap, TestFile, TxMode};
use super::render::{self, Role, Symbols};
use super::report::{ErrInfo, FileReport, GoldenFile, ScenarioReport, StepOutcome, StepReport, Verdict};
use super::session::{self, BatchOutcome, DbErr, EngineSession, ResultSet};
use super::snapshot::{self, TableRef};
use super::{EngineRef, Progress, ProgressFn};
use crate::db::DbKind;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecMode {
    Assert,
    Record,
    Golden,
    Diff,
}

impl ExecMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecMode::Assert => "assert",
            ExecMode::Record => "record",
            ExecMode::Golden => "golden",
            ExecMode::Diff => "diff",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub mode: ExecMode,
    /// 基線資料夾（record / golden 必填）。
    pub golden_dir: Option<PathBuf>,
    /// 每個結果集 / 快照的列數上限（0 = 不限）。
    pub row_cap: usize,
    /// 只跑這些 scenario id（空 = 全部）。
    pub only: Vec<String>,
    /// 只跑帶任一 tag 的 scenario（空 = 全部）。
    pub tags: Vec<String>,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions { mode: ExecMode::Assert, golden_dir: None, row_cap: 10_000, only: vec![], tags: vec![] }
    }
}

/// 展開後的情境（fixture 前置 + case 變數）。
struct Expanded {
    id: String,
    case: Option<String>,
    steps: Vec<Step>,
    vars: BTreeMap<String, Value>,
    skip: Option<String>,
    mode: TxMode,
    snapshot: SnapshotSpec,
}

fn expand(file: &TestFile, sc: &Scenario) -> Result<Vec<Expanded>, String> {
    let mut base_steps: Vec<Step> = Vec::new();
    for f in &sc.use_fixtures {
        let fx = file.fixtures.get(f).ok_or_else(|| tf!("fixture {name} 不存在", name = f))?;
        base_steps.extend(fx.steps.iter().cloned());
    }
    base_steps.extend(sc.steps.iter().cloned());
    let skip = sc.skip.as_ref().and_then(|s| s.reason());
    let mode = sc.mode.unwrap_or(file.defaults.mode);
    let snapshot = sc.snapshot.clone().unwrap_or_else(|| file.defaults.snapshot.clone());
    if sc.cases.is_empty() {
        return Ok(vec![Expanded { id: sc.id.clone(), case: None, steps: base_steps, vars: BTreeMap::new(), skip, mode, snapshot }]);
    }
    let mut out = Vec::new();
    for c in &sc.cases {
        let mut steps = base_steps.clone();
        // case 層的 expect_error 套在最後一個 call（這個 case 預期的就是那次呼叫出錯）。
        if let Some(ee) = &c.expect_error {
            if let Some(Step::Call(last)) = steps.iter_mut().rev().find(|s| matches!(s, Step::Call(_))) {
                last.expect_error = Some(ee.clone());
                last.expect = None;
            }
        }
        out.push(Expanded { id: sc.id.clone(), case: Some(c.name.clone()), steps, vars: c.vars.clone(), skip: skip.clone(), mode, snapshot: snapshot.clone() });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 單一引擎上的情境執行
// ---------------------------------------------------------------------------

struct Caches {
    sigs: HashMap<String, RoutineSig>,
    tables: HashMap<String, TableRef>,
    targets: HashMap<String, Vec<String>>,
}

struct EngineCtx<'a> {
    mgr: &'a ConnectionManager,
    target: &'a EngineRef,
    kind: DbKind,
    file: &'a TestFile,
    opts: &'a RunOptions,
    cmp: CmpOpts,
    caches: Caches,
}

/// 一個引擎跑完一個情境的結果。
struct EngineRun {
    label: String,
    steps: Vec<StepOutcome>,
    differences: Vec<Vec<Difference>>,
    /// harness 層錯誤（連線 / 開場 / 未預期的引擎錯誤），情境到此為止。
    fatal: Option<String>,
    /// 未預期的錯誤發生在 seed（insert / sql）步驟。
    seed_error: bool,
}

fn engine_label(kind: DbKind) -> String {
    match kind {
        DbKind::Mssql => "mssql".into(),
        DbKind::Postgres => "postgres".into(),
        DbKind::Mysql => "mysql".into(),
        DbKind::Mariadb => "mariadb".into(),
        other => format!("{other:?}").to_ascii_lowercase(),
    }
}

/// 依引擎種類套 `tables` / `routines` 的名稱對應。
fn map_name(kind: DbKind, maps: &[TableMap], name: &str) -> String {
    let Some(m) = maps.iter().find(|m| m.name.eq_ignore_ascii_case(name)) else { return name.to_string() };
    let mapped = match kind {
        DbKind::Mssql => m.mssql.as_deref(),
        DbKind::Postgres => m.pg.as_deref(),
        DbKind::Mysql | DbKind::Mariadb => m.mysql.as_deref(),
        _ => None,
    };
    mapped.unwrap_or(name).to_string()
}

fn err_info(kind: DbKind, e: &DbErr) -> ErrInfo {
    ErrInfo {
        code: e.number.map(|n| n.to_string()).or_else(|| e.sqlstate.clone()),
        class: classify(kind, e.number, e.sqlstate.as_deref()),
        message: e.message.clone(),
    }
}

async fn exec(sess: &mut Box<dyn EngineSession>, sql: &str, cap: usize) -> BatchOutcome {
    sess.batch(sql, cap).await
}

impl<'a> EngineCtx<'a> {
    async fn sig(&mut self, routine: &str) -> AppResult<RoutineSig> {
        let name = map_name(self.kind, &self.file.routines, routine);
        if let Some(s) = self.caches.sigs.get(&name) {
            return Ok(s.clone());
        }
        let s = inspect::routine_sig(self.mgr, &self.target.conn_id, self.kind, &self.target.database, &name).await?;
        self.caches.sigs.insert(name, s.clone());
        Ok(s)
    }

    async fn table(&mut self, logical: &str) -> AppResult<TableRef> {
        let name = map_name(self.kind, &self.file.tables, logical);
        if let Some(t) = self.caches.tables.get(&name) {
            return Ok(t.clone());
        }
        let t = snapshot::load_table(self.mgr, &self.target.conn_id, self.kind, &self.target.database, &name).await?;
        self.caches.tables.insert(name, t.clone());
        Ok(t)
    }

    async fn auto_targets(&mut self, routine: &str) -> AppResult<Vec<String>> {
        let name = map_name(self.kind, &self.file.routines, routine);
        if let Some(t) = self.caches.targets.get(&name) {
            return Ok(t.clone());
        }
        let t = inspect::write_targets(self.mgr, &self.target.conn_id, self.kind, &self.target.database, &name).await?;
        self.caches.targets.insert(name, t.clone());
        Ok(t)
    }

    /// 要快照的表（依 scenario / defaults 的 snapshot 設定，或盤點）。
    async fn snapshot_tables(&mut self, spec: &SnapshotSpec, routine: &str) -> AppResult<Vec<TableRef>> {
        let names: Vec<String> = match spec {
            SnapshotSpec::Named(n) if n == "none" => vec![],
            SnapshotSpec::Named(_) => self.auto_targets(routine).await?,
            SnapshotSpec::Tables(t) => t.clone(),
        };
        let mut out = Vec::new();
        for n in names {
            out.push(self.table(&n).await?);
        }
        Ok(out)
    }
}

/// 把 `>>sym` 擷取從結果集 / OUT 套到符號表。
fn capture_from_set(set: &ResultSet, captures: &BTreeMap<String, String>, syms: &mut Symbols) -> Result<(), String> {
    for (col, target) in captures {
        let target_v = Value::String(target.clone());
        let Some(sym) = capture_name(&target_v) else {
            return Err(tf!("capture 的值必須是 >>符號（{v}）", v = target));
        };
        if col == "*" {
            syms.set(sym, render::set_to_value(&set.columns, &set.rows));
            continue;
        }
        let Some(idx) = assert::find_col(&set.columns, col) else {
            return Err(tf!("結果集沒有欄位 {col}，無法擷取", col = col));
        };
        syms.set_col(sym, render::cell_to_value(set.first_cell(idx)), &set.columns[idx]);
    }
    Ok(())
}

async fn take_snapshots(sess: &mut Box<dyn EngineSession>, kind: DbKind, tables: &[TableRef], cap: usize) -> Result<Vec<crate::review_run::capture::TableSnapshot>, DbErr> {
    let mut out = Vec::new();
    for t in tables {
        let sql = render::snapshot_select(kind, &t.meta);
        let res = exec(sess, &sql, cap).await;
        if let Some(e) = res.error {
            return Err(e);
        }
        let set = res.sets.into_iter().find(|s| !s.columns.is_empty() || !s.rows.is_empty()).unwrap_or_default();
        out.push(snapshot::snapshot_from(&t.meta, &set));
    }
    Ok(out)
}

/// MSSQL 的 call batch：兩個 marker 之間是程序的結果集；end marker 那一集帶 return code 與 OUT。
fn split_mssql_call(sets: Vec<ResultSet>, out_names: &[String]) -> (Vec<ResultSet>, Option<String>, BTreeMap<String, Option<String>>) {
    let is_marker = |s: &ResultSet, m: &str| s.columns.first().map(|c| c == "__dbk_marker").unwrap_or(false) && s.first_cell(0) == Some(m);
    let begin = sets.iter().position(|s| is_marker(s, "__dbk_begin"));
    let end = sets.iter().position(|s| is_marker(s, "__dbk_end"));
    let mut rc = None;
    let mut out = BTreeMap::new();
    if let Some(e) = end {
        let s = &sets[e];
        if let Some(i) = s.columns.iter().position(|c| c == "__rc") {
            rc = s.first_cell(i).map(|v| v.to_string());
        }
        for name in out_names {
            if let Some(i) = s.columns.iter().position(|c| c == name) {
                out.insert(name.clone(), s.first_cell(i).map(|v| v.to_string()));
            }
        }
    }
    let lo = begin.map(|b| b + 1).unwrap_or(0);
    let hi = end.unwrap_or(sets.len());
    let body = if lo <= hi { sets[lo..hi].to_vec() } else { vec![] };
    (body, rc, out)
}

/// 單一引擎跑完整個情境。
async fn run_engine(ctx: &mut EngineCtx<'_>, sc: &Expanded, flag: &std::sync::atomic::AtomicBool, progress: ProgressFn<'_>, prog: &Progress) -> EngineRun {
    let kind = ctx.kind;
    let label = engine_label(kind);
    let mut run = EngineRun { label: label.clone(), steps: vec![], differences: vec![], fatal: None, seed_error: false };
    let mut sess = match session::open(ctx.mgr, &ctx.target.conn_id).await {
        Ok(s) => s,
        Err(e) => {
            run.fatal = Some(e.to_string());
            return run;
        }
    };
    let mut syms = Symbols::new();
    syms.extend(&ctx.file.symbols);
    syms.extend(&sc.vars);
    for s in render::open_stmts(kind, &ctx.target.database, &ctx.file.defaults) {
        if let Some(e) = exec(&mut sess, &s, 0).await.error {
            run.fatal = Some(tf!("開場失敗：{e}", e = e.message));
            let _ = exec(&mut sess, render::close_stmt(kind), 0).await;
            return run;
        }
    }
    let mut snapshot_spec = sc.snapshot.clone();
    for (i, step) in sc.steps.iter().enumerate() {
        if flag.load(Ordering::Relaxed) {
            run.fatal = Some(t!("已取消").into());
            break;
        }
        progress(Progress { step: Some(step.label(i)), phase: "step".into(), engine: Some(label.clone()), ..prog.clone() });
        let t0 = Instant::now();
        let mut oc = StepOutcome { kind: step.kind().into(), ..Default::default() };
        let mut diffs: Vec<Difference> = Vec::new();
        let mut stop = false;
        let savepoint = !matches!(step, Step::Compare(_) | Step::Snapshot(_));
        if savepoint {
            if let Some(e) = exec(&mut sess, &render::savepoint_stmt(kind, "dbk_step"), 0).await.error {
                run.fatal = Some(tf!("SAVEPOINT 失敗：{e}", e = e.message));
                break;
            }
        }
        let mut raw_err: Option<DbErr> = None;
        match step {
            Step::Insert(st) => {
                let table = map_name(kind, &ctx.file.tables, &st.insert);
                'rows: for row in &st.rows {
                    let stmts = match render::insert_stmts(kind, &ctx.target.database, &table, row, &syms, st.identity_insert) {
                        Ok(s) => s,
                        Err(e) => {
                            run.fatal = Some(e);
                            break;
                        }
                    };
                    for stmt in stmts {
                        let res = exec(&mut sess, &stmt.sql, ctx.opts.row_cap).await;
                        if let Some(e) = res.error {
                            raw_err = Some(e);
                            break 'rows;
                        }
                        if let Role::Capture(caps) = &stmt.role {
                            let set = res.sets.into_iter().find(|s| !s.rows.is_empty()).unwrap_or_default();
                            for (col, sym) in caps {
                                match assert::find_col(&set.columns, col) {
                                    Some(idx) => syms.set_col(sym, render::cell_to_value(set.first_cell(idx)), col),
                                    None => diffs.push(Difference::new("capture", format!("insert / {col}"), None, None).with_note(t!("引擎沒回傳這個欄，無法擷取"))),
                                }
                            }
                        }
                    }
                }
            }
            Step::Sql(st) => match render::substitute_sql(kind, &st.sql, &syms) {
                Ok(sql) => {
                    let res = exec(&mut sess, &sql, ctx.opts.row_cap).await;
                    oc.result_sets = res.sets.into_iter().filter(|s| !s.columns.is_empty() || !s.rows.is_empty()).collect();
                    raw_err = res.error;
                    if raw_err.is_none() {
                        let first = oc.result_sets.first().cloned().unwrap_or_default();
                        if let Err(e) = capture_from_set(&first, &st.capture, &mut syms) {
                            run.fatal = Some(e);
                        }
                        if let Some(exp) = &st.expect {
                            match resolve_rows(exp, &syms) {
                                Ok(rows) => diffs.extend(assert::check_rows("result", &rows, &first, st.ordered.unwrap_or(ctx.cmp.ordered), &st.key, &[], &ctx.cmp)),
                                Err(e) => run.fatal = Some(e),
                            }
                        }
                    }
                }
                Err(e) => run.fatal = Some(e),
            },
            Step::Query(st) => match render::substitute_sql(kind, &st.query, &syms) {
                Ok(sql) => {
                    let res = exec(&mut sess, &sql, ctx.opts.row_cap).await;
                    oc.result_sets = res.sets.into_iter().filter(|s| !s.columns.is_empty() || !s.rows.is_empty()).collect();
                    raw_err = res.error;
                    if raw_err.is_none() {
                        let first = oc.result_sets.first().cloned().unwrap_or_default();
                        if let Err(e) = capture_from_set(&first, &st.capture, &mut syms) {
                            run.fatal = Some(e);
                        }
                        match resolve_rows(&st.expect, &syms) {
                            Ok(rows) => diffs.extend(assert::check_rows("result", &rows, &first, st.ordered.unwrap_or(ctx.cmp.ordered), &st.key, &[], &ctx.cmp)),
                            Err(e) => run.fatal = Some(e),
                        }
                    }
                }
                Err(e) => run.fatal = Some(e),
            },
            Step::Call(st) => {
                match run_call(ctx, &mut sess, st, &snapshot_spec, &mut syms, &mut oc).await {
                    Ok(err) => raw_err = err,
                    Err(e) => run.fatal = Some(e.to_string()),
                }
                if run.fatal.is_none() && raw_err.is_none() {
                    diffs.extend(check_call_expect(ctx, st, &oc, &syms));
                }
                if oc.tx_state.as_deref() == Some("rolled_back_by_sp") || oc.tx_state.as_deref() == Some("doomed") {
                    run.fatal = Some(tf!("交易狀態 {s}：程序內的 ROLLBACK 把外層交易一起滾掉了，後續步驟無法繼續（改用 isolated 模式）", s = oc.tx_state.clone().unwrap_or_default()));
                }
            }
            Step::Compare(st) => {
                let get = |s: &str| syms.get(s.trim_start_matches("<<").trim()).cloned();
                match (st.compare.first().and_then(|s| get(s)), st.compare.get(1).and_then(|s| get(s))) {
                    (Some(Value::Array(a)), Some(Value::Array(b))) => {
                        let to_set = |rows: &[Value]| -> ResultSet {
                            let columns: Vec<String> = rows.first().and_then(|r| r.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default();
                            let data = rows
                                .iter()
                                .map(|r| columns.iter().map(|c| r.get(c).and_then(|v| if v.is_null() { None } else { Some(assert::expected_display(v)) })).collect())
                                .collect();
                            ResultSet { columns, rows: data, truncated: false }
                        };
                        let sa = to_set(&a);
                        let sb = to_set(&b);
                        oc.result_sets = vec![sa.clone(), sb.clone()];
                        let rows = assert::set_to_rows(&sa, &[]);
                        diffs.extend(assert::check_rows("compare", &rows, &sb, st.ordered.unwrap_or(ctx.cmp.ordered), &[], &[], &ctx.cmp));
                    }
                    _ => run.fatal = Some(t!("compare 的兩個符號都必須是結果集").into()),
                }
            }
            Step::Snapshot(st) => {
                snapshot_spec = SnapshotSpec::Tables(st.snapshot.clone());
            }
        }

        // 錯誤處理：預期的錯誤 → 比對；未預期 → 情境到此為止。
        if let Some(e) = &raw_err {
            oc.error = Some(err_info(kind, e));
            match step.expect_error() {
                Some(exp) => diffs.extend(assert::check_error(exp, Some(e), kind)),
                None => {
                    stop = true;
                    if matches!(step, Step::Insert(_) | Step::Sql(_)) {
                        run.seed_error = true;
                    }
                    diffs.push(Difference::new("unexpected_error", step.label(i), None, Some(format!("{} ({})", e.message, oc.error.as_ref().map(|x| x.class.as_str()).unwrap_or("?")))));
                }
            }
            // 回到步驟前的狀態（PG 的交易已 aborted，一定要回；其餘依 on_error）。
            let on_error = match step {
                Step::Call(c) => c.on_error.unwrap_or(ctx.file.defaults.on_error),
                _ => ctx.file.defaults.on_error,
            };
            if savepoint && (on_error == OnError::RollbackToSavepoint || kind == DbKind::Postgres) {
                let _ = exec(&mut sess, &render::rollback_to_stmt(kind, "dbk_step"), 0).await;
            }
        } else if let Some(exp) = step.expect_error() {
            diffs.extend(assert::check_error(exp, None, kind));
        }
        oc.elapsed_ms = t0.elapsed().as_millis() as u64;
        // 給基線 / 差分比對用：這一步結束時的符號值、以及目前碰到的表的自動值欄名。
        oc.symbols = syms.scalars();
        oc.symbol_cols = syms.columns();
        let mut masked: Vec<String> = ctx.caches.tables.values().flat_map(|t| t.identity_cols.iter().chain(t.volatile_cols.iter()).cloned()).collect();
        masked.sort();
        masked.dedup();
        oc.masked_cols = masked;
        run.steps.push(oc);
        run.differences.push(diffs);
        if stop || run.fatal.is_some() {
            break;
        }
    }
    let _ = exec(&mut sess, render::close_stmt(kind), 0).await;
    run
}

fn resolve_rows(rows: &[super::model::Row], syms: &Symbols) -> Result<Vec<super::model::Row>, String> {
    rows.iter()
        .map(|r| {
            let mut out = super::model::Row::new();
            for (k, v) in r {
                out.insert(k.clone(), render::resolve_value(v, syms)?);
            }
            Ok(out)
        })
        .collect()
}

/// `call` step：快照 → 呼叫 → 交易狀態 → 快照 → 副作用 → 擷取。回 `Ok(Some(err))` = 程序出錯（交給呼叫端判斷是否預期）。
async fn run_call(
    ctx: &mut EngineCtx<'_>,
    sess: &mut Box<dyn EngineSession>,
    st: &CallStep,
    snapshot_spec: &SnapshotSpec,
    syms: &mut Symbols,
    oc: &mut StepOutcome,
) -> AppResult<Option<DbErr>> {
    let kind = ctx.kind;
    let sig = ctx.sig(&st.call).await?;
    let tables = ctx.snapshot_tables(snapshot_spec, &st.call).await?;
    let plan = render::call_plan(kind, &ctx.target.database, &sig, &st.params, syms).map_err(AppError::Query)?;
    let before = take_snapshots(sess, kind, &tables, ctx.opts.row_cap.max(ctx.file.defaults.max_snapshot_rows)).await.map_err(|e| AppError::Query(e.message))?;

    let mut err: Option<DbErr> = None;
    let mut sets: Vec<ResultSet> = Vec::new();
    for stmt in &plan.stmts {
        let res = exec(sess, &stmt.sql, ctx.opts.row_cap).await;
        match &stmt.role {
            Role::Setup | Role::Capture(_) => {}
            Role::Call => {
                if kind == DbKind::Mssql {
                    let (body, rc, out) = split_mssql_call(res.sets, &plan.out_names);
                    sets.extend(body);
                    oc.return_code = rc;
                    oc.out = out;
                } else {
                    sets.extend(res.sets.into_iter().filter(|s| !s.columns.is_empty() || !s.rows.is_empty()));
                }
            }
            Role::OutFetch => {
                // PG 的 CALL 回單列 = OUT 參數；MySQL 的 SELECT @o 同形。
                if let Some(row) = res.sets.iter().find(|s| !s.rows.is_empty()) {
                    for (i, c) in row.columns.iter().enumerate() {
                        oc.out.insert(c.clone(), row.first_cell(i).map(|v| v.to_string()));
                    }
                }
            }
        }
        if let Some(e) = res.error {
            err = Some(e);
            break;
        }
    }
    oc.result_sets = sets;

    if let Some(q) = render::tx_state_stmt(kind) {
        let res = exec(sess, q, 1).await;
        if let Some(s) = res.sets.first() {
            let tc = s.first_cell(0).and_then(|v| v.parse::<i64>().ok()).unwrap_or(1);
            let xs = s.first_cell(1).and_then(|v| v.parse::<i64>().ok()).unwrap_or(1);
            oc.tx_state = Some(if tc == 0 { "rolled_back_by_sp".into() } else if xs == -1 { "doomed".into() } else { "open".into() });
        }
    }
    if oc.tx_state.as_deref() != Some("rolled_back_by_sp") && oc.tx_state.as_deref() != Some("doomed") {
        // PG：出錯後交易 aborted，後快照要先回到 savepoint 才能查（此時副作用必為空）。
        if err.is_some() && kind == DbKind::Postgres {
            let _ = exec(sess, &render::rollback_to_stmt(kind, "dbk_step"), 0).await;
        }
        let after = take_snapshots(sess, kind, &tables, ctx.opts.row_cap.max(ctx.file.defaults.max_snapshot_rows)).await.map_err(|e| AppError::Query(e.message))?;
        for ((t, b), a) in tables.iter().zip(&before).zip(&after) {
            oc.effects.push(snapshot::effect(kind, &ctx.target.database, t, b, a));
        }
    }
    if err.is_none() {
        for (col, sym) in &plan.out_captures {
            let v = oc.out.iter().find(|(k, _)| inspect::norm_param(k) == inspect::norm_param(col)).and_then(|(_, v)| v.as_deref());
            syms.set_col(sym, render::cell_to_value(v), col);
        }
        let first = oc.result_sets.first().cloned().unwrap_or_default();
        capture_from_set(&first, &st.capture, syms).map_err(AppError::Query)?;
    }
    Ok(err)
}

fn check_call_expect(ctx: &EngineCtx<'_>, st: &CallStep, oc: &StepOutcome, syms: &Symbols) -> Vec<Difference> {
    let mut diffs = Vec::new();
    let Some(exp) = &st.expect else { return diffs };
    let o = &ctx.cmp;
    if let Some(sets) = &exp.result_sets {
        if oc.result_sets.len() != sets.len() {
            diffs.push(Difference::new("result_set_count", "result_sets", Some(sets.len().to_string()), Some(oc.result_sets.len().to_string())));
        }
        for (i, e) in sets.iter().enumerate() {
            let ResultSetExpect::Spec(spec) = e else { continue };
            let Some(actual) = oc.result_sets.get(i) else { continue };
            let loc = format!("set {i}");
            if let Some(rows) = &spec.rows {
                match resolve_rows(rows, syms) {
                    Ok(rows) => diffs.extend(assert::check_rows(&loc, &rows, actual, spec.ordered.unwrap_or(o.ordered), &spec.key, &[], o)),
                    Err(e) => diffs.push(Difference::new("expectation", loc.clone(), None, None).with_note(e)),
                }
            }
            if let Some(n) = spec.count {
                diffs.extend(assert::check_count(&loc, n, actual));
            }
        }
    }
    if let Some(rc) = &exp.return_code {
        match render::resolve_value(rc, syms) {
            Ok(v) => diffs.extend(assert::check_scalar("return_code", "return_code", &v, oc.return_code.as_deref(), o)),
            Err(e) => diffs.push(Difference::new("expectation", "return_code", None, None).with_note(e)),
        }
    }
    if let Some(out) = &exp.out {
        match resolve_rows(std::slice::from_ref(out), syms) {
            Ok(rows) => diffs.extend(assert::check_out(&rows[0], &oc.out, o)),
            Err(e) => diffs.push(Difference::new("expectation", "out", None, None).with_note(e)),
        }
    }
    if let Some(effects) = &exp.effects {
        // 期望列裡的 <<sym 也要解析
        let mut resolved = BTreeMap::new();
        for (t, e) in effects {
            let mut e = e.clone();
            if let Some(super::model::CountOrRows::Rows(rows)) = &e.inserted {
                e.inserted = Some(super::model::CountOrRows::Rows(resolve_rows(rows, syms).unwrap_or_else(|_| rows.clone())));
            }
            if let Some(super::model::CountOrRows::Rows(rows)) = &e.deleted {
                e.deleted = Some(super::model::CountOrRows::Rows(resolve_rows(rows, syms).unwrap_or_else(|_| rows.clone())));
            }
            if let Some(super::model::CountOrChanges::Changes(ch)) = &e.updated {
                let ch = ch
                    .iter()
                    .map(|c| super::model::RowChangeExpect {
                        before: c.before.as_ref().map(|b| resolve_rows(std::slice::from_ref(b), syms).ok().and_then(|v| v.into_iter().next()).unwrap_or_else(|| b.clone())),
                        after: resolve_rows(std::slice::from_ref(&c.after), syms).ok().and_then(|v| v.into_iter().next()).unwrap_or_else(|| c.after.clone()),
                    })
                    .collect();
                e.updated = Some(super::model::CountOrChanges::Changes(ch));
            }
            resolved.insert(t.clone(), e);
        }
        let strict = exp.effects_strict.unwrap_or(ctx.file.defaults.effects_strict);
        diffs.extend(assert::check_effects(&resolved, strict, &oc.effects, ctx.kind, &ctx.target.database, o));
    } else if ctx.file.defaults.effects_strict {
        diffs.extend(assert::check_effects(&BTreeMap::new(), true, &oc.effects, ctx.kind, &ctx.target.database, o));
    }
    diffs
}

// ---------------------------------------------------------------------------
// 檔案層
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 跑一個測試檔。`targets`：assert / record / golden 一個；diff 兩個（A = 來源 / 基準，B = 目標）。
pub async fn run_file(
    mgr: &ConnectionManager,
    run_id: &str,
    targets: &[EngineRef],
    file: &TestFile,
    file_name: &str,
    opts: &RunOptions,
    progress: ProgressFn<'_>,
) -> AppResult<FileReport> {
    if targets.is_empty() {
        return Err(AppError::Query(t!("沒有指定目標連線").into()));
    }
    if opts.mode == ExecMode::Diff && targets.len() != 2 {
        return Err(AppError::Query(t!("diff 模式需要恰好兩個目標").into()));
    }
    if matches!(opts.mode, ExecMode::Record | ExecMode::Golden) && opts.golden_dir.is_none() {
        return Err(AppError::Query(t!("record / golden 模式需要基線資料夾").into()));
    }
    let errs = super::model::validate(file);
    if !errs.is_empty() {
        return Err(AppError::Query(tf!("測試檔有誤：{errs}", errs = errs.join("；"))));
    }
    let guard = super::register(run_id);
    let file_stem = std::path::Path::new(file_name).file_stem().and_then(|s| s.to_str()).unwrap_or(file_name).to_string();
    let mut ctxs: Vec<EngineCtx> = Vec::new();
    for t in targets {
        let kind = mgr.kind(&t.conn_id)?;
        if mgr.is_prod(&t.conn_id)? && file.defaults.mode != TxMode::Wrapped {
            return Err(AppError::Unsupported(t!("正式環境連線只能用 wrapped 模式").into()));
        }
        ctxs.push(EngineCtx {
            mgr,
            target: t,
            kind,
            file,
            opts,
            cmp: CmpOpts::from_defaults(&file.defaults),
            caches: Caches { sigs: HashMap::new(), tables: HashMap::new(), targets: HashMap::new() },
        });
    }
    let mut expanded: Vec<Expanded> = Vec::new();
    for sc in &file.scenarios {
        // `--only` 可寫情境 id，或 `id/case` 只跑某個 case。
        let whole = opts.only.iter().any(|o| o == &sc.id);
        let cases: Vec<&str> = opts.only.iter().filter_map(|o| o.split_once('/')).filter(|(id, _)| *id == sc.id).map(|(_, c)| c).collect();
        if !opts.only.is_empty() && !whole && cases.is_empty() {
            continue;
        }
        if !opts.tags.is_empty() && !sc.tags.iter().any(|t| opts.tags.contains(t)) {
            continue;
        }
        let mut ex = expand(file, sc).map_err(AppError::Query)?;
        if !whole && !cases.is_empty() {
            ex.retain(|e| e.case.as_deref().map(|c| cases.contains(&c)).unwrap_or(false));
        }
        expanded.extend(ex);
    }
    let total = expanded.len();
    let mut report = FileReport { file: file_name.to_string(), mode: opts.mode.as_str().into(), targets: ctxs.iter().map(|c| engine_label(c.kind)).collect(), started_at: now_iso(), scenarios: vec![] };

    for (index, sc) in expanded.iter().enumerate() {
        let prog = Progress { run_id: run_id.into(), file: file_name.into(), scenario: sc.id.clone(), case: sc.case.clone(), step: None, phase: "open".into(), engine: None, verdict: None, index, total };
        progress(prog.clone());
        let t0 = Instant::now();
        let mut sr = ScenarioReport { id: sc.id.clone(), case: sc.case.clone(), verdict: Verdict::Pass, mode_used: "wrapped".into(), elapsed_ms: 0, skipped: None, error: None, steps: vec![] };
        if let Some(reason) = &sc.skip {
            sr.verdict = Verdict::Skipped;
            sr.skipped = Some(reason.clone());
            report.scenarios.push(sr);
            continue;
        }
        if guard.flag.load(Ordering::Relaxed) {
            sr.verdict = Verdict::Error;
            sr.error = Some(t!("已取消").into());
            report.scenarios.push(sr);
            continue;
        }
        if sc.mode == TxMode::Isolated {
            sr.verdict = Verdict::Error;
            sr.error = Some(t!("isolated 模式尚未支援（程序內含 COMMIT / ROLLBACK 的情境請先略過）").into());
            report.scenarios.push(sr);
            continue;
        }
        // auto：程序本文有交易控制 → 這版先標為無法在交易內跑。
        let mut runs: Vec<EngineRun> = Vec::new();
        for ctx in ctxs.iter_mut() {
            runs.push(run_engine(ctx, sc, &guard.flag, progress, &prog).await);
        }
        // 組 step 報表
        let n_steps = runs.iter().map(|r| r.steps.len()).max().unwrap_or(0);
        for i in 0..n_steps {
            let step = sc.steps.get(i);
            let mut st = StepReport { label: step.map(|s| s.label(i)).unwrap_or_else(|| format!("#{}", i + 1)), kind: step.map(|s| s.kind().into()).unwrap_or_default(), outcomes: BTreeMap::new(), differences: vec![] };
            for r in &runs {
                if let Some(oc) = r.steps.get(i) {
                    st.outcomes.insert(r.label.clone(), oc.clone());
                }
                if let Some(d) = r.differences.get(i) {
                    st.differences.extend(d.iter().cloned().map(|mut d| {
                        if runs.len() > 1 {
                            d.location = format!("[{}] {}", r.label, d.location);
                        }
                        d
                    }));
                }
            }
            sr.steps.push(st);
        }
        let cmp = CmpOpts::from_defaults(&file.defaults);
        // 模式相關：基線 / 差分
        let mut cross: Vec<Difference> = Vec::new();
        let mut one_side = false;
        let mut both_error = false;
        match opts.mode {
            ExecMode::Diff => {
                let (a, b) = (&runs[0], &runs[1]);
                for i in 0..n_steps {
                    match (a.steps.get(i), b.steps.get(i)) {
                        (Some(oa), Some(ob)) => {
                            let d = assert::outcome_diff(oa, ob, &a.label, &b.label, &cmp);
                            if d.iter().any(|d| d.kind == "error_one_side") {
                                one_side = true;
                            }
                            if oa.error.is_some() && ob.error.is_some() {
                                both_error = true;
                            }
                            if let Some(st) = sr.steps.get_mut(i) {
                                st.differences.extend(d.iter().cloned());
                            }
                            cross.extend(d);
                        }
                        (Some(_), None) | (None, Some(_)) => {
                            one_side = true;
                            if let Some(st) = sr.steps.get_mut(i) {
                                st.differences.push(Difference::new("error_one_side", st.label.clone(), None, None).with_note(t!("只有一邊跑到這一步")));
                            }
                        }
                        (None, None) => {}
                    }
                }
            }
            ExecMode::Record => {
                let dir = opts.golden_dir.clone().unwrap();
                let r = &runs[0];
                if r.fatal.is_none() {
                    let path = super::report::golden_path(&dir, &r.label, &file_stem, &sc.id, sc.case.as_deref());
                    let g = GoldenFile { recorded_at: now_iso(), engine: r.label.clone(), steps: r.steps.clone() };
                    if let Err(e) = super::report::write_golden(&path, &g).await {
                        sr.error = Some(e.to_string());
                    }
                }
            }
            ExecMode::Golden => {
                let dir = opts.golden_dir.clone().unwrap();
                let r = &runs[0];
                let path = super::report::golden_path(&dir, &r.label, &file_stem, &sc.id, sc.case.as_deref());
                match super::report::read_golden(&path).await {
                    Ok(Some(g)) => {
                        for i in 0..n_steps.max(g.steps.len()) {
                            match (g.steps.get(i), r.steps.get(i)) {
                                (Some(ga), Some(ac)) => {
                                    let d: Vec<Difference> = assert::outcome_diff(ga, ac, "golden", &r.label, &cmp).into_iter().map(|mut d| {
                                        d.kind = format!("golden:{}", d.kind);
                                        d
                                    }).collect();
                                    if let Some(st) = sr.steps.get_mut(i) {
                                        st.differences.extend(d.iter().cloned());
                                    }
                                    cross.extend(d);
                                }
                                (Some(_), None) | (None, Some(_)) => {
                                    let d = Difference::new("golden:step_count", format!("step {}", i + 1), Some(g.steps.len().to_string()), Some(r.steps.len().to_string()));
                                    if let Some(st) = sr.steps.get_mut(i) {
                                        st.differences.push(d.clone());
                                    }
                                    cross.push(d);
                                }
                                (None, None) => {}
                            }
                        }
                    }
                    Ok(None) => {
                        sr.error = Some(tf!("沒有基線：{path}（先用 record 模式錄一次）", path = path.display().to_string()));
                    }
                    Err(e) => sr.error = Some(e.to_string()),
                }
            }
            ExecMode::Assert => {}
        }
        // 判定
        let fatal = runs.iter().find_map(|r| r.fatal.clone());
        let seed_error = runs.iter().any(|r| r.seed_error);
        let expect_diffs = runs.iter().flat_map(|r| r.differences.iter()).any(|d| !d.is_empty());
        sr.verdict = if let Some(f) = fatal {
            sr.error = Some(f);
            Verdict::Error
        } else if sr.error.is_some() {
            Verdict::Error
        } else if seed_error {
            Verdict::SeedError
        } else if runs.iter().any(|r| r.differences.iter().flatten().any(|d| d.kind == "unexpected_error")) {
            Verdict::Error
        } else if expect_diffs {
            Verdict::Fail
        } else if opts.mode == ExecMode::Diff {
            if !cross.is_empty() && cross.iter().any(|d| d.kind != "error_one_side") {
                Verdict::Mismatch
            } else if one_side {
                Verdict::ErrorOnOneSide
            } else if both_error {
                Verdict::BothError
            } else {
                Verdict::Pass
            }
        } else if !cross.is_empty() {
            Verdict::Fail
        } else {
            Verdict::Pass
        };
        sr.elapsed_ms = t0.elapsed().as_millis() as u64;
        progress(Progress { phase: "done".into(), verdict: Some(sr.verdict.as_str().into()), ..prog.clone() });
        report.scenarios.push(sr);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_fixtures_and_cases() {
        let f: TestFile = serde_json::from_str(
            r#"{"version": 1, "target": {"kind": "mysql", "database": "d"},
                "fixtures": {"base": {"steps": [{"sql": "SELECT 1"}]}},
                "scenarios": [{"id": "s", "use": ["base"], "cases": [{"name": "a", "vars": {"q": 1}}, {"name": "b", "vars": {"q": 0}, "expect_error": {"class": "other"}}],
                               "steps": [{"call": "p", "params": {"q": "<<q"}, "expect": {"return_code": 0}}]}]}"#,
        )
        .unwrap();
        let ex = expand(&f, &f.scenarios[0]).unwrap();
        assert_eq!(ex.len(), 2);
        assert_eq!(ex[0].steps.len(), 2);
        assert_eq!(ex[0].case.as_deref(), Some("a"));
        match &ex[1].steps[1] {
            Step::Call(c) => {
                assert!(c.expect.is_none());
                assert!(c.expect_error.is_some());
            }
            _ => panic!(),
        }
    }

    #[test]
    fn mssql_call_split() {
        let mk = |cols: &[&str], row: &[Option<&str>]| ResultSet { columns: cols.iter().map(|s| s.to_string()).collect(), rows: vec![row.iter().map(|c| c.map(str::to_string)).collect()], truncated: false };
        let sets = vec![
            mk(&["__dbk_marker"], &[Some("__dbk_begin")]),
            mk(&["order_id", "qty"], &[Some("101"), Some("2")]),
            mk(&["__dbk_marker", "__rc", "NewBalance"], &[Some("__dbk_end"), Some("0"), Some("12.50")]),
        ];
        let (body, rc, out) = split_mssql_call(sets, &["NewBalance".into()]);
        assert_eq!(body.len(), 1);
        assert_eq!(rc.as_deref(), Some("0"));
        assert_eq!(out.get("NewBalance").cloned().flatten().as_deref(), Some("12.50"));
        // 出錯：沒有 end marker
        let sets = vec![mk(&["__dbk_marker"], &[Some("__dbk_begin")]), mk(&["a"], &[Some("1")])];
        let (body, rc, out) = split_mssql_call(sets, &[]);
        assert_eq!(body.len(), 1);
        assert!(rc.is_none() && out.is_empty());
    }

    #[test]
    fn name_mapping() {
        let maps = vec![TableMap { name: "usp_place_order".into(), pg: Some("usp_place_order_bad".into()), ..Default::default() }];
        assert_eq!(map_name(DbKind::Postgres, &maps, "usp_place_order"), "usp_place_order_bad");
        assert_eq!(map_name(DbKind::Mssql, &maps, "usp_place_order"), "usp_place_order");
        assert_eq!(map_name(DbKind::Mysql, &maps, "other"), "other");
    }
}
