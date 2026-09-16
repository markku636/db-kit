//! 資料列比對編排：單表 / 整庫，report / sql / apply 三種模式。
//!
//! 流程：欄位交集（忽略大小寫）→ 探主鍵 → 兩側各開一條依主鍵排序的分頁串流 → `merge_join`
//! （順序守衛失敗自動退 `hash_diff`）→ sink 一邊計數取樣、一邊產 DML。
//!
//! **套用是兩階段的**：掃描期間 DML 先 spool 到暫存檔（DELETE / UPDATE / INSERT 三段），掃完才分批
//! 以交易重放——邊 OFFSET 分頁邊改目標會讓頁面位移（漏列 / 重複）。掃描被截斷（max_rows / 取消）
//! 時**永不輸出 DELETE**：目標多出的列可能只是還沒掃到的來源列。

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::merge::{self, DiffSink, Limits, MergeOutcome, RowComparer};
use super::normalize::{infer_mode, render_for_target, CompareMode};
use super::rowstream::{PageSource, PkStream, Row, PAGE_SIZE};
use super::{CompareProgress, ProgressFn};
use crate::db::sqlgen::{delete_stmt, insert_stmt, update_stmt};
use crate::db::{ColumnInfo, DataQuery, DbKind};
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

/// 每類差異最多保留的樣本列數（IPC payload 上限）。
const DEFAULT_SAMPLE_CAP: usize = 500;
/// 每側最多掃描列數（與 transfer 同）。
const DEFAULT_MAX_ROWS: u64 = 5_000_000;
/// 套用時每批語句數。
const DEFAULT_BATCH: usize = 500;
/// SQL 模式的文字上限（超過就不回 SQL 只回計數；改用 apply 或 CLI --sql 串流）。
const SQL_TEXT_CAP: usize = 20 * 1024 * 1024;
/// 套用錯誤訊息最多保留幾筆。
const MAX_ERRORS: usize = 20;

fn d_sample_cap() -> usize {
    DEFAULT_SAMPLE_CAP
}
fn d_max_rows() -> u64 {
    DEFAULT_MAX_ROWS
}
fn d_batch() -> usize {
    DEFAULT_BATCH
}

#[derive(Debug, Clone, Deserialize)]
pub struct TableRef {
    pub conn_id: String,
    pub database: String,
    pub table: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DbRef {
    pub conn_id: String,
    pub database: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    #[default]
    Report,
    Sql,
    Apply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    #[default]
    Auto,
    MergeJoin,
    HashDiff,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DataCompareOptions {
    #[serde(default)]
    pub mode: RunMode,
    #[serde(default)]
    pub strategy: Strategy,
    /// 產生 / 套用 DELETE（刪除目標多出的列）。
    #[serde(default)]
    pub include_deletes: bool,
    #[serde(default = "d_sample_cap")]
    pub sample_cap: usize,
    /// 每側最多掃描列數；0 = 不限。
    #[serde(default = "d_max_rows")]
    pub max_rows: u64,
    /// 不比對的欄位（主鍵不可忽略）。
    #[serde(default)]
    pub ignore_columns: Vec<String>,
    #[serde(default)]
    pub ignore_trailing_spaces: bool,
    /// NULL 與空字串視為相同；None = 自動（任一側 Oracle 時 true）。
    #[serde(default)]
    pub null_equals_empty: Option<bool>,
    #[serde(default = "d_batch")]
    pub batch_size: usize,
    /// 套用時任一批失敗即中止（預設關：該批改逐句重放，隔離壞列後繼續）。
    #[serde(default)]
    pub stop_on_error: bool,
    /// 允許對標記 prod 的目標連線套用（後端守門；前端另有唯讀連線閘門）。
    #[serde(default)]
    pub allow_prod_target: bool,
}

impl Default for DataCompareOptions {
    fn default() -> Self {
        Self {
            mode: RunMode::Report,
            strategy: Strategy::Auto,
            include_deletes: false,
            sample_cap: DEFAULT_SAMPLE_CAP,
            max_rows: DEFAULT_MAX_ROWS,
            ignore_columns: vec![],
            ignore_trailing_spaces: false,
            null_equals_empty: None,
            batch_size: DEFAULT_BATCH,
            stop_on_error: false,
            allow_prod_target: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TruncReason {
    MaxRows,
    PkOrderMismatch,
    DuplicateKey,
    Cancelled,
    SqlTooLarge,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DataDiffSummary {
    pub inserts: u64,
    pub updates: u64,
    pub deletes: u64,
    /// 兩側相同的列數。
    pub compared_rows: u64,
    pub src_rows: u64,
    pub dst_rows: u64,
    /// "merge_join" | "hash_diff"
    pub strategy_used: String,
    pub truncated_reason: Option<TruncReason>,
    /// 因截斷而未輸出 DELETE（計數仍在 `deletes`）。
    pub deletes_suppressed: bool,
    pub cancelled: bool,
    pub elapsed_ms: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateSample {
    pub src: Vec<Option<String>>,
    pub dst: Vec<Option<String>>,
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DiffSamples {
    /// 來源列（共同欄位順序）。
    pub inserts: Vec<Vec<Option<String>>>,
    pub updates: Vec<UpdateSample>,
    /// 目標列（共同欄位順序）。
    pub deletes: Vec<Vec<Option<String>>>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DataApplyResult {
    pub applied: u64,
    pub failed: u64,
    pub batches: u64,
    /// 所有批次皆在交易內執行。
    pub transactional: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DataDiffReport {
    pub src: String,
    pub dst: String,
    /// 主鍵欄位（來源拼法）。
    pub pk: Vec<String>,
    /// 實際比對的欄位（來源拼法、來源欄序）。
    pub columns: Vec<String>,
    pub skipped_src_columns: Vec<String>,
    pub skipped_dst_columns: Vec<String>,
    pub summary: DataDiffSummary,
    pub samples: DiffSamples,
    /// `RunMode::Sql` 時的同步 SQL（超過上限時為 None，見 `truncated_reason`）。
    pub sql: Option<String>,
    pub apply: Option<DataApplyResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TableStatus {
    Compared,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrecheckResult {
    pub src_count: u64,
    pub dst_count: u64,
    pub src_min: Option<String>,
    pub src_max: Option<String>,
    pub dst_min: Option<String>,
    pub dst_max: Option<String>,
    pub likely_identical: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableDiffEntry {
    pub table: String,
    pub status: TableStatus,
    pub reason: Option<String>,
    pub precheck: Option<PrecheckResult>,
    pub report: Option<DataDiffReport>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DbCompareOptions {
    #[serde(flatten)]
    pub table: DataCompareOptions,
    /// 只比這些表（None = 兩側交集全部）。
    #[serde(default)]
    pub tables: Option<Vec<String>>,
    /// 先以 COUNT / MIN / MAX 預檢，看起來相同的表直接略過。
    #[serde(default)]
    pub precheck: bool,
    /// 只做預檢，不逐列比對。
    #[serde(default)]
    pub precheck_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DataDiffDbReport {
    pub tables: Vec<TableDiffEntry>,
    pub totals: DataDiffSummary,
    pub only_in_src: Vec<String>,
    pub only_in_dst: Vec<String>,
    pub cancelled: bool,
}

// ---------------------------------------------------------------------------
// 共用計數器（sink 與進度回報共享）
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Counters {
    inserts: AtomicU64,
    updates: AtomicU64,
    deletes: AtomicU64,
    compared: AtomicU64,
}

impl Counters {
    fn get(&self, c: &AtomicU64) -> u64 {
        c.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// 欄位對應
// ---------------------------------------------------------------------------

struct Mapping {
    columns_src: Vec<String>,
    columns_dst: Vec<String>,
    /// 目標欄位的宣告型別（與 columns_dst 同序），供 DML 依目標渲染值。
    types_dst: Vec<String>,
    col_modes: Vec<CompareMode>,
    pk_src: Vec<String>,
    pk_dst: Vec<String>,
    /// 主鍵在共同欄位裡的索引。
    pk_idx: Vec<usize>,
    key_modes: Vec<CompareMode>,
    skipped_src: Vec<String>,
    skipped_dst: Vec<String>,
    keyset: bool,
}

fn build_mapping(
    src_cols: &[ColumnInfo],
    dst_cols: &[ColumnInfo],
    pk: &[String],
    ignore: &[String],
) -> AppResult<Mapping> {
    let is_pk = |n: &str| pk.iter().any(|p| p.eq_ignore_ascii_case(n));
    let ignored = |n: &str| ignore.iter().any(|p| p.eq_ignore_ascii_case(n));
    let mut m = Mapping {
        columns_src: vec![],
        columns_dst: vec![],
        types_dst: vec![],
        col_modes: vec![],
        pk_src: vec![],
        pk_dst: vec![],
        pk_idx: vec![],
        key_modes: vec![],
        skipped_src: vec![],
        skipped_dst: vec![],
        keyset: false,
    };
    for c in src_cols {
        let Some(d) = dst_cols.iter().find(|d| d.name.eq_ignore_ascii_case(&c.name)) else {
            m.skipped_src.push(c.name.clone());
            continue;
        };
        if ignored(&c.name) && !is_pk(&c.name) {
            continue;
        }
        m.columns_src.push(c.name.clone());
        m.columns_dst.push(d.name.clone());
        m.types_dst.push(d.data_type.clone());
        m.col_modes.push(infer_mode(&c.data_type, &d.data_type));
    }
    for d in dst_cols {
        if !src_cols.iter().any(|c| c.name.eq_ignore_ascii_case(&d.name)) {
            m.skipped_dst.push(d.name.clone());
        }
    }
    for p in pk {
        let Some(i) = m.columns_src.iter().position(|c| c.eq_ignore_ascii_case(p)) else {
            return Err(AppError::Query(tf!("目標缺少對應主鍵欄位 {col}", col = p)));
        };
        m.pk_idx.push(i);
        m.pk_src.push(m.columns_src[i].clone());
        m.pk_dst.push(m.columns_dst[i].clone());
        m.key_modes.push(m.col_modes[i]);
    }
    if m.columns_src.is_empty() {
        return Err(AppError::Query(t!("來源與目標沒有同名欄位可比對").into()));
    }
    m.keyset = m.pk_idx.len() == 1 && m.key_modes[0] == CompareMode::Numeric;
    Ok(m)
}

// ---------------------------------------------------------------------------
// Sink：計數 + 取樣 + DML（文字或 spool）
// ---------------------------------------------------------------------------

struct DmlCtx {
    kind: DbKind,
    db: String,
    table: String,
    cols_dst: Vec<String>,
    pk_dst: Vec<String>,
    pk_idx: Vec<usize>,
    /// 目標欄位的宣告型別（與 cols_dst 同序）。產 DML 時用來把值渲染成目標吃得下的字面值，
    /// 依據刻意是**目標**而非 CompareMode——後者任一側是布林就成立，會寫壞 'Y'/'N' 這類目標。
    types_dst: Vec<String>,
}

enum DmlOut {
    None,
    Text { del: String, upd: String, ins: String, cap: usize, overflow: bool },
    Spool { del: BufWriter<File>, upd: BufWriter<File>, ins: BufWriter<File>, paths: [PathBuf; 3] },
}

/// spool 一行一句：換行 / 反斜線跳脫，讀回時還原。
fn encode_line(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r")
}
fn decode_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('\\') => out.push('\\'),
                Some(o) => {
                    out.push('\\');
                    out.push(o);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn spool_path(run_id: &str, seq: usize, section: &str) -> PathBuf {
    let safe: String = run_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    std::env::temp_dir().join(format!("dbkit-compare-{safe}-{seq}-{section}.sql"))
}

struct Sink {
    counters: Arc<Counters>,
    columns: Vec<String>,
    sample_cap: usize,
    include_deletes: bool,
    samples: DiffSamples,
    dml: DmlOut,
    ctx: Option<DmlCtx>,
}

impl Sink {
    fn new(counters: Arc<Counters>, columns: Vec<String>, sample_cap: usize, include_deletes: bool, dml: DmlOut, ctx: Option<DmlCtx>) -> Self {
        Self { counters, columns, sample_cap, include_deletes, samples: DiffSamples::default(), dml, ctx }
    }

    /// 主鍵條件的值也要走目標渲染：MySQL 對 TINYINT 欄位的 `= 'true'` 會靜默轉成 0，
    /// 布林參與複合主鍵時會更新 / 刪到錯的列（無錯誤訊息）。
    fn pk_vals(ctx: &DmlCtx, r: &Row) -> Vec<Option<String>> {
        ctx.pk_idx
            .iter()
            .map(|i| Self::render(ctx, *i, r.values.get(*i).cloned().flatten()))
            .collect()
    }

    fn render(ctx: &DmlCtx, i: usize, v: Option<String>) -> Option<String> {
        let ty = ctx.types_dst.get(i).map(String::as_str).unwrap_or("");
        render_for_target(ty, v.as_deref())
    }

    fn emit(&mut self, section: usize, sql: String) -> AppResult<()> {
        match &mut self.dml {
            DmlOut::None => {}
            DmlOut::Text { del, upd, ins, cap, overflow } => {
                if *overflow {
                    return Ok(());
                }
                let total = del.len() + upd.len() + ins.len() + sql.len() + 2;
                if total > *cap {
                    *overflow = true;
                    return Ok(());
                }
                let buf = match section {
                    0 => del,
                    1 => upd,
                    _ => ins,
                };
                buf.push_str(&sql);
                buf.push_str(";\n");
            }
            DmlOut::Spool { del, upd, ins, .. } => {
                let w = match section {
                    0 => del,
                    1 => upd,
                    _ => ins,
                };
                writeln!(w, "{}", encode_line(&sql)).map_err(|e| AppError::Storage(tf!("寫入暫存檔失敗：{err}", err = e)))?;
            }
        }
        Ok(())
    }
}

impl DiffSink for Sink {
    fn insert(&mut self, src: &Row) -> AppResult<()> {
        self.counters.inserts.fetch_add(1, Ordering::Relaxed);
        if self.samples.inserts.len() < self.sample_cap {
            self.samples.inserts.push(src.values.clone());
        }
        if let Some(ctx) = &self.ctx {
            let vals: Vec<Option<String>> =
                src.values.iter().enumerate().map(|(i, v)| Self::render(ctx, i, v.clone())).collect();
            let sql = insert_stmt(ctx.kind, &ctx.db, &ctx.table, &ctx.cols_dst, &vals);
            self.emit(2, sql)?;
        }
        Ok(())
    }

    fn update(&mut self, src: &Row, dst: &Row, changed: &[usize]) -> AppResult<()> {
        self.counters.updates.fetch_add(1, Ordering::Relaxed);
        if self.samples.updates.len() < self.sample_cap {
            self.samples.updates.push(UpdateSample {
                src: src.values.clone(),
                dst: dst.values.clone(),
                changed: changed.iter().filter_map(|i| self.columns.get(*i).cloned()).collect(),
            });
        }
        if let Some(ctx) = &self.ctx {
            let set_cols: Vec<String> = changed.iter().filter_map(|i| ctx.cols_dst.get(*i).cloned()).collect();
            let set_vals: Vec<Option<String>> = changed
                .iter()
                .map(|i| Self::render(ctx, *i, src.values.get(*i).cloned().flatten()))
                .collect();
            let sql = update_stmt(ctx.kind, &ctx.db, &ctx.table, &set_cols, &set_vals, &ctx.pk_dst, &Self::pk_vals(ctx, src));
            self.emit(1, sql)?;
        }
        Ok(())
    }

    fn delete(&mut self, dst: &Row) -> AppResult<()> {
        self.counters.deletes.fetch_add(1, Ordering::Relaxed);
        if self.samples.deletes.len() < self.sample_cap {
            self.samples.deletes.push(dst.values.clone());
        }
        if self.include_deletes {
            if let Some(ctx) = &self.ctx {
                let sql = delete_stmt(ctx.kind, &ctx.db, &ctx.table, &ctx.pk_dst, &Self::pk_vals(ctx, dst));
                self.emit(0, sql)?;
            }
        }
        Ok(())
    }

    fn matched(&mut self) {
        self.counters.compared.fetch_add(1, Ordering::Relaxed);
    }
}

/// 建立 spool 三檔。
fn open_spool(run_id: &str, seq: usize) -> AppResult<DmlOut> {
    let paths = [spool_path(run_id, seq, "del"), spool_path(run_id, seq, "upd"), spool_path(run_id, seq, "ins")];
    let mk = |p: &PathBuf| File::create(p).map(BufWriter::new).map_err(|e| AppError::Storage(tf!("建立暫存檔失敗：{err}", err = e)));
    Ok(DmlOut::Spool { del: mk(&paths[0])?, upd: mk(&paths[1])?, ins: mk(&paths[2])?, paths })
}

fn remove_spool(paths: &[PathBuf; 3]) {
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
}

// ---------------------------------------------------------------------------
// 進度
// ---------------------------------------------------------------------------

struct ProgressCtx<'a> {
    on_progress: ProgressFn<'a>,
    run_id: String,
    table: String,
    table_index: usize,
    table_count: usize,
    counters: Arc<Counters>,
    started: Instant,
}

impl ProgressCtx<'_> {
    fn emit(&self, phase: &str, src_rows: u64, dst_rows: u64, applied: u64) {
        let c = &self.counters;
        (self.on_progress)(CompareProgress {
            run_id: self.run_id.clone(),
            phase: phase.into(),
            table: self.table.clone(),
            table_index: self.table_index,
            table_count: self.table_count,
            src_rows,
            dst_rows,
            inserts: c.get(&c.inserts),
            updates: c.get(&c.updates),
            deletes: c.get(&c.deletes),
            applied,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        });
    }
}

// ---------------------------------------------------------------------------
// 單表
// ---------------------------------------------------------------------------

fn ensure_sql_kind(kind: DbKind) -> AppResult<()> {
    if matches!(kind, DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres | DbKind::Sqlite | DbKind::Mssql | DbKind::Oracle) {
        Ok(())
    } else {
        Err(AppError::Unsupported(t!("此資料庫種類不支援資料比對").into()))
    }
}

/// 探主鍵（`page_size: 1`，與 transfer 同法；引擎無關）。
async fn probe_pk(manager: &ConnectionManager, t: &TableRef) -> AppResult<Vec<String>> {
    let q = DataQuery { page: 0, page_size: 1, filters: vec![], sorts: vec![], match_any: false, count: false };
    Ok(manager.table_data(&t.conn_id, &t.database, &t.table, &q).await?.primary_key)
}

pub async fn compare_table(
    manager: &ConnectionManager,
    run_id: &str,
    src: &TableRef,
    dst: &TableRef,
    opts: &DataCompareOptions,
    on_progress: ProgressFn<'_>,
) -> AppResult<DataDiffReport> {
    let guard = super::register(run_id);
    let pk = probe_pk(manager, src).await?;
    if pk.is_empty() {
        return Err(AppError::Query(t!("來源資料表沒有主鍵，無法以主鍵比對").into()));
    }
    let pc = ProgressCtx {
        on_progress,
        run_id: run_id.into(),
        table: src.table.clone(),
        table_index: 1,
        table_count: 1,
        counters: Arc::new(Counters::default()),
        started: Instant::now(),
    };
    compare_table_inner(manager, run_id, 0, src, dst, pk, opts, &pc, &guard.flag).await
}

#[allow(clippy::too_many_arguments)]
async fn compare_table_inner(
    manager: &ConnectionManager,
    run_id: &str,
    seq: usize,
    src: &TableRef,
    dst: &TableRef,
    pk: Vec<String>,
    opts: &DataCompareOptions,
    pc: &ProgressCtx<'_>,
    cancel: &AtomicBool,
) -> AppResult<DataDiffReport> {
    let started = Instant::now();
    if src.conn_id == dst.conn_id && src.database == dst.database && src.table == dst.table {
        return Err(AppError::Query(t!("來源與目標是同一張表").into()));
    }
    let src_kind = manager.kind(&src.conn_id)?;
    let dst_kind = manager.kind(&dst.conn_id)?;
    ensure_sql_kind(src_kind)?;
    ensure_sql_kind(dst_kind)?;
    if opts.mode == RunMode::Apply && manager.is_prod(&dst.conn_id)? && !opts.allow_prod_target {
        return Err(AppError::Query(t!("目標連線標記為正式環境，未允許套用同步").into()));
    }

    let src_cols = manager.table_columns(&src.conn_id, &src.database, &src.table).await?;
    let dst_cols = manager.table_columns(&dst.conn_id, &dst.database, &dst.table).await?;
    let m = build_mapping(&src_cols, &dst_cols, &pk, &opts.ignore_columns)?;
    let null_eq_empty = opts.null_equals_empty.unwrap_or(src_kind == DbKind::Oracle || dst_kind == DbKind::Oracle);
    let cmp = RowComparer {
        key_modes: m.key_modes.clone(),
        col_modes: m.col_modes.clone(),
        null_eq_empty,
        trim_ws: opts.ignore_trailing_spaces,
    };
    let limits = Limits { max_rows: opts.max_rows };
    let mut warnings: Vec<String> = Vec::new();
    if m.col_modes.iter().any(|x| *x == CompareMode::Raw) {
        warnings.push(t!("含二進位欄位，以原字串比對（跨引擎可能不可比）").into());
    }

    let mk_streams = || {
        (
            PkStream::new(manager, &src.conn_id, &src.database, &src.table, m.pk_src.clone(), m.columns_src.clone(), m.key_modes.clone(), opts.ignore_trailing_spaces, m.keyset, PAGE_SIZE),
            PkStream::new(manager, &dst.conn_id, &dst.database, &dst.table, m.pk_dst.clone(), m.columns_dst.clone(), m.key_modes.clone(), opts.ignore_trailing_spaces, m.keyset, PAGE_SIZE),
        )
    };
    let mk_sink = || -> AppResult<Sink> {
        // 每次重跑重置計數（hash 退路會重來一次）。
        pc.counters.inserts.store(0, Ordering::Relaxed);
        pc.counters.updates.store(0, Ordering::Relaxed);
        pc.counters.deletes.store(0, Ordering::Relaxed);
        pc.counters.compared.store(0, Ordering::Relaxed);
        let (dml, ctx) = match opts.mode {
            RunMode::Report => (DmlOut::None, None),
            RunMode::Sql | RunMode::Apply => {
                let out = if opts.mode == RunMode::Sql {
                    DmlOut::Text { del: String::new(), upd: String::new(), ins: String::new(), cap: SQL_TEXT_CAP, overflow: false }
                } else {
                    open_spool(run_id, seq)?
                };
                (
                    out,
                    Some(DmlCtx {
                        kind: dst_kind,
                        db: dst.database.clone(),
                        table: dst.table.clone(),
                        cols_dst: m.columns_dst.clone(),
                        pk_dst: m.pk_dst.clone(),
                        pk_idx: m.pk_idx.clone(),
                        types_dst: m.types_dst.clone(),
                    }),
                )
            }
        };
        Ok(Sink::new(pc.counters.clone(), m.columns_src.clone(), opts.sample_cap, opts.include_deletes, dml, ctx))
    };

    let run = |strategy: Strategy| {
        let (mut s, mut d) = mk_streams();
        let sink = mk_sink();
        let cmp = &cmp;
        let limits = &limits;
        async move {
            let mut sink = sink?;
            let mut tick = |a: u64, b: u64| pc.emit("scan", a, b, 0);
            let outcome = match strategy {
                Strategy::HashDiff => merge::hash_diff(&mut s, &mut d, cmp, &mut sink, limits, cancel, &mut tick).await?,
                _ => merge::merge_join(&mut s, &mut d, cmp, &mut sink, limits, cancel, &mut tick).await?,
            };
            Ok::<_, AppError>((outcome, sink, s.rows_seen(), d.rows_seen()))
        }
    };

    let first = if opts.strategy == Strategy::HashDiff { Strategy::HashDiff } else { Strategy::MergeJoin };
    let (mut outcome, mut sink, mut src_rows, mut dst_rows) = run(first).await?;
    let mut strategy_used = first;
    if opts.strategy == Strategy::Auto && matches!(outcome, MergeOutcome::OrderViolation { .. } | MergeOutcome::DuplicateKey { .. }) {
        // 排序規則與比較器不一致（或鍵正規化撞鍵）→ 改走順序無關的雜湊比對。
        if let DmlOut::Spool { paths, .. } = &sink.dml {
            remove_spool(paths);
        }
        warnings.push(t!("兩側主鍵排序與比較器不一致，已改用雜湊比對").into());
        let r = run(Strategy::HashDiff).await?;
        outcome = r.0;
        sink = r.1;
        src_rows = r.2;
        dst_rows = r.3;
        strategy_used = Strategy::HashDiff;
    }

    let truncated_reason = match outcome {
        MergeOutcome::Completed => None,
        MergeOutcome::MaxRows => Some(TruncReason::MaxRows),
        MergeOutcome::OrderViolation { .. } => Some(TruncReason::PkOrderMismatch),
        MergeOutcome::DuplicateKey { .. } => Some(TruncReason::DuplicateKey),
        MergeOutcome::Cancelled => Some(TruncReason::Cancelled),
    };
    let cancelled = outcome == MergeOutcome::Cancelled;
    let truncated = truncated_reason.is_some();
    let c = &pc.counters;
    let deletes = c.get(&c.deletes);
    let deletes_suppressed = truncated && opts.include_deletes && deletes > 0;

    // ---- 收 DML ----
    let mut sql_text: Option<String> = None;
    let mut apply: Option<DataApplyResult> = None;
    let mut trunc = truncated_reason;
    let Sink { samples, dml, .. } = sink;
    match dml {
        DmlOut::None => {}
        DmlOut::Text { del, upd, ins, overflow, .. } => {
            if overflow {
                trunc = trunc.or(Some(TruncReason::SqlTooLarge));
            } else {
                let mut s = String::with_capacity(del.len() + upd.len() + ins.len());
                if !deletes_suppressed {
                    s.push_str(&del);
                }
                s.push_str(&upd);
                s.push_str(&ins);
                sql_text = Some(s);
            }
        }
        DmlOut::Spool { del, upd, ins, paths } => {
            // flush 後關檔，再重放。
            for mut w in [del, upd, ins] {
                w.flush().map_err(|e| AppError::Storage(tf!("寫入暫存檔失敗：{err}", err = e)))?;
            }
            if !cancelled {
                let sections: Vec<&PathBuf> = if deletes_suppressed || !opts.include_deletes {
                    vec![&paths[1], &paths[2]]
                } else {
                    vec![&paths[0], &paths[1], &paths[2]]
                };
                let res = replay(manager, &dst.conn_id, &sections, opts, pc, cancel).await;
                remove_spool(&paths);
                apply = Some(res?);
            } else {
                remove_spool(&paths);
            }
        }
    }

    Ok(DataDiffReport {
        src: format!("{}.{}", src.database, src.table),
        dst: format!("{}.{}", dst.database, dst.table),
        pk: m.pk_src.clone(),
        columns: m.columns_src.clone(),
        skipped_src_columns: m.skipped_src.clone(),
        skipped_dst_columns: m.skipped_dst.clone(),
        summary: DataDiffSummary {
            inserts: c.get(&c.inserts),
            updates: c.get(&c.updates),
            deletes,
            compared_rows: c.get(&c.compared),
            src_rows,
            dst_rows,
            strategy_used: match strategy_used {
                Strategy::HashDiff => "hash_diff".into(),
                _ => "merge_join".into(),
            },
            truncated_reason: trunc,
            deletes_suppressed,
            cancelled,
            elapsed_ms: started.elapsed().as_millis() as u64,
            warnings,
        },
        samples,
        sql: sql_text,
        apply,
    })
}

/// 重放 spool：每批一交易；失敗且未設 stop_on_error 時該批逐句重跑以隔離壞列。
async fn replay(
    manager: &ConnectionManager,
    dst_id: &str,
    sections: &[&PathBuf],
    opts: &DataCompareOptions,
    pc: &ProgressCtx<'_>,
    cancel: &AtomicBool,
) -> AppResult<DataApplyResult> {
    let mut res = DataApplyResult { transactional: true, ..Default::default() };
    let batch_size = opts.batch_size.max(1);
    let mut batch: Vec<String> = Vec::with_capacity(batch_size);

    async fn flush(
        manager: &ConnectionManager,
        dst_id: &str,
        batch: &mut Vec<String>,
        opts: &DataCompareOptions,
        res: &mut DataApplyResult,
    ) -> AppResult<()> {
        if batch.is_empty() {
            return Ok(());
        }
        res.batches += 1;
        match manager.exec_batch(dst_id, batch, true).await {
            Ok((_, tx)) => {
                res.applied += batch.len() as u64;
                if !tx {
                    res.transactional = false;
                }
            }
            Err(e) => {
                if opts.stop_on_error {
                    res.failed += batch.len() as u64;
                    res.errors.push(e.to_string());
                    batch.clear();
                    return Err(e);
                }
                // 整批已回滾：逐句重跑，壞的記下來、好的照套。
                res.transactional = false;
                for s in batch.iter() {
                    match manager.exec_batch(dst_id, std::slice::from_ref(s), false).await {
                        Ok(_) => res.applied += 1,
                        Err(e) => {
                            res.failed += 1;
                            if res.errors.len() < MAX_ERRORS {
                                res.errors.push(format!("{e}\n{s}"));
                            }
                        }
                    }
                }
            }
        }
        batch.clear();
        Ok(())
    }

    for p in sections {
        let f = File::open(p).map_err(|e| AppError::Storage(tf!("讀取暫存檔失敗：{err}", err = e)))?;
        for line in BufReader::new(f).lines() {
            if cancel.load(Ordering::Relaxed) {
                flush(manager, dst_id, &mut batch, opts, &mut res).await?;
                return Ok(res);
            }
            let line = line.map_err(|e| AppError::Storage(tf!("讀取暫存檔失敗：{err}", err = e)))?;
            if line.is_empty() {
                continue;
            }
            batch.push(decode_line(&line));
            if batch.len() >= batch_size {
                flush(manager, dst_id, &mut batch, opts, &mut res).await?;
                pc.emit("apply", 0, 0, res.applied);
            }
        }
    }
    flush(manager, dst_id, &mut batch, opts, &mut res).await?;
    pc.emit("apply", 0, 0, res.applied);
    Ok(res)
}

// ---------------------------------------------------------------------------
// 整庫
// ---------------------------------------------------------------------------

pub async fn compare_database(
    manager: &ConnectionManager,
    run_id: &str,
    src: &DbRef,
    dst: &DbRef,
    opts: &DbCompareOptions,
    on_progress: ProgressFn<'_>,
) -> AppResult<DataDiffDbReport> {
    let guard = super::register(run_id);
    let cancel = &guard.flag;
    ensure_sql_kind(manager.kind(&src.conn_id)?)?;
    ensure_sql_kind(manager.kind(&dst.conn_id)?)?;

    let src_tables: Vec<String> = manager
        .list_tables(&src.conn_id, &src.database)
        .await?
        .into_iter()
        .filter(|t| t.kind == "table")
        .map(|t| t.name)
        .collect();
    let dst_tables: Vec<String> = manager
        .list_tables(&dst.conn_id, &dst.database)
        .await?
        .into_iter()
        .filter(|t| t.kind == "table")
        .map(|t| t.name)
        .collect();
    let src_lower: HashSet<String> = src_tables.iter().map(|t| t.to_ascii_lowercase()).collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut only_in_src = Vec::new();
    for t in &src_tables {
        match dst_tables.iter().find(|d| d.eq_ignore_ascii_case(t)) {
            Some(d) => pairs.push((t.clone(), d.clone())),
            None => only_in_src.push(t.clone()),
        }
    }
    let only_in_dst: Vec<String> = dst_tables.iter().filter(|d| !src_lower.contains(&d.to_ascii_lowercase())).cloned().collect();
    if let Some(only) = &opts.tables {
        pairs.retain(|(s, _)| only.iter().any(|n| n.eq_ignore_ascii_case(s)));
    }

    let started = Instant::now();
    let mut report = DataDiffDbReport { tables: Vec::new(), totals: DataDiffSummary::default(), only_in_src, only_in_dst, cancelled: false };
    let total = pairs.len();
    for (i, (st, dt)) in pairs.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        let s_ref = TableRef { conn_id: src.conn_id.clone(), database: src.database.clone(), table: st.clone() };
        let d_ref = TableRef { conn_id: dst.conn_id.clone(), database: dst.database.clone(), table: dt.clone() };
        let pc = ProgressCtx {
            on_progress,
            run_id: run_id.into(),
            table: st.clone(),
            table_index: i + 1,
            table_count: total,
            counters: Arc::new(Counters::default()),
            started,
        };
        let mut entry = TableDiffEntry { table: st.clone(), status: TableStatus::Skipped, reason: None, precheck: None, report: None };

        let pk = match probe_pk(manager, &s_ref).await {
            Ok(pk) => pk,
            Err(e) => {
                entry.status = TableStatus::Failed;
                entry.reason = Some(e.to_string());
                report.tables.push(entry);
                continue;
            }
        };
        if pk.is_empty() {
            entry.reason = Some(t!("無主鍵").into());
            report.tables.push(entry);
            continue;
        }

        if opts.precheck || opts.precheck_only {
            pc.emit("precheck", 0, 0, 0);
            match precheck(manager, &s_ref, &d_ref, &pk[0]).await {
                Ok(p) => {
                    let identical = p.likely_identical;
                    entry.precheck = Some(p);
                    if identical {
                        entry.reason = Some(t!("預檢相同（筆數 / 主鍵範圍一致）").into());
                        report.tables.push(entry);
                        continue;
                    }
                    if opts.precheck_only {
                        entry.reason = Some(t!("預檢有差異（僅預檢）").into());
                        report.tables.push(entry);
                        continue;
                    }
                }
                Err(e) => {
                    // 預檢失敗不致命：照常逐列比對。
                    entry.reason = Some(tf!("預檢失敗：{err}", err = e.to_string()));
                }
            }
        }

        match compare_table_inner(manager, run_id, i, &s_ref, &d_ref, pk, &opts.table, &pc, cancel).await {
            Ok(r) => {
                let t = &mut report.totals;
                t.inserts += r.summary.inserts;
                t.updates += r.summary.updates;
                t.deletes += r.summary.deletes;
                t.compared_rows += r.summary.compared_rows;
                t.src_rows += r.summary.src_rows;
                t.dst_rows += r.summary.dst_rows;
                if r.summary.cancelled {
                    report.cancelled = true;
                }
                entry.status = TableStatus::Compared;
                entry.report = Some(r);
            }
            Err(e) => {
                entry.status = TableStatus::Failed;
                entry.reason = Some(e.to_string());
            }
        }
        report.tables.push(entry);
        if report.cancelled {
            break;
        }
    }
    report.totals.elapsed_ms = started.elapsed().as_millis() as u64;
    report.totals.cancelled = report.cancelled;
    Ok(report)
}

/// COUNT / MIN / MAX 預檢（走既有 `column_stats`，五種引擎皆可）。
async fn precheck(manager: &ConnectionManager, s: &TableRef, d: &TableRef, pk: &str) -> AppResult<PrecheckResult> {
    let (a, b) = tokio::join!(
        manager.column_stats(&s.conn_id, &s.database, &s.table, pk),
        manager.column_stats(&d.conn_id, &d.database, &d.table, pk),
    );
    let (a, b) = (a?, b?);
    let norm = |v: &Option<String>| v.as_ref().map(|x| super::normalize::normalize_cell(CompareMode::Numeric, x, false).into_owned());
    let likely_identical = a.total == b.total && norm(&a.min) == norm(&b.min) && norm(&a.max) == norm(&b.max);
    Ok(PrecheckResult {
        src_count: a.total,
        dst_count: b.total,
        src_min: a.min,
        src_max: a.max,
        dst_min: b.min,
        dst_max: b.max,
        likely_identical,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ci(name: &str, ty: &str) -> ColumnInfo {
        ColumnInfo { name: name.into(), data_type: ty.into(), nullable: true, key: String::new(), default: None, extra: String::new(), comment: String::new() }
    }

    #[test]
    fn mapping_intersects_case_insensitively_and_tracks_pk() {
        let src = vec![ci("Id", "int"), ci("Name", "varchar(10)"), ci("OnlySrc", "int"), ci("Skip", "int")];
        let dst = vec![ci("id", "bigint"), ci("name", "text"), ci("only_dst", "int"), ci("skip", "int")];
        let m = build_mapping(&src, &dst, &["Id".into()], &["skip".into()]).unwrap();
        assert_eq!(m.columns_src, vec!["Id", "Name"]);
        assert_eq!(m.columns_dst, vec!["id", "name"]);
        assert_eq!(m.pk_idx, vec![0]);
        assert_eq!(m.pk_dst, vec!["id"]);
        assert_eq!(m.skipped_src, vec!["OnlySrc"]);
        assert_eq!(m.skipped_dst, vec!["only_dst"]);
        assert!(m.keyset, "單一數值主鍵應走 keyset");
        // 主鍵不可被忽略。
        let m = build_mapping(&src, &dst, &["Id".into()], &["id".into()]).unwrap();
        assert_eq!(m.pk_idx, vec![0]);
        // 目標缺主鍵欄 → Err。
        assert!(build_mapping(&src, &[ci("name", "text")], &["Id".into()], &[]).is_err());
        // 複合 / 字串主鍵 → OFFSET。
        let m = build_mapping(&src, &dst, &["Id".into(), "Name".into()], &[]).unwrap();
        assert!(!m.keyset);
    }

    #[test]
    fn spool_line_encoding_round_trips() {
        for s in ["plain", "a\nb", "back\\slash", "cr\r\nlf", "trail\\", "\\n literal"] {
            assert_eq!(decode_line(&encode_line(s)), s, "{s:?}");
            assert!(!encode_line(s).contains('\n'));
        }
    }

    #[test]
    fn sink_emits_dml_in_target_spelling_and_caps_text() {
        let counters = Arc::new(Counters::default());
        let ctx = DmlCtx {
            kind: DbKind::Postgres,
            db: "tgt".into(),
            table: "t".into(),
            cols_dst: vec!["id".into(), "name".into()],
            pk_dst: vec!["id".into()],
            pk_idx: vec![0],
            types_dst: vec!["integer".into(), "text".into()],
        };
        let mut sink = Sink::new(counters.clone(), vec!["Id".into(), "Name".into()], 1, true, DmlOut::Text { del: String::new(), upd: String::new(), ins: String::new(), cap: 400, overflow: false }, Some(ctx));
        let r = |k: &str, n: Option<&str>| Row { key: vec![Some(k.into())], values: vec![Some(k.into()), n.map(str::to_string)] };
        sink.insert(&r("1", Some("a"))).unwrap();
        sink.update(&r("2", Some("b")), &r("2", Some("B")), &[1]).unwrap();
        sink.delete(&r("3", None)).unwrap();
        sink.insert(&r("4", Some("d"))).unwrap(); // 第二個樣本超過 cap=1 不收
        sink.matched();
        assert_eq!(counters.get(&counters.inserts), 2);
        assert_eq!(sink.samples.inserts.len(), 1);
        assert_eq!(sink.samples.updates[0].changed, vec!["Name"]);
        match &sink.dml {
            DmlOut::Text { del, upd, ins, overflow, .. } => {
                assert_eq!(del, "DELETE FROM \"tgt\".\"t\" WHERE \"id\" = '3';\n");
                assert_eq!(upd, "UPDATE \"tgt\".\"t\" SET \"name\" = 'b' WHERE \"id\" = '2';\n");
                assert!(ins.starts_with("INSERT INTO \"tgt\".\"t\" (\"id\", \"name\") VALUES ('1', 'a');\n"));
                assert!(!overflow);
            }
            _ => panic!(),
        }
        // 超過 cap → overflow，不再累積。
        for i in 0..20 {
            sink.insert(&r(&i.to_string(), Some("xxxxxxxxxxxxxxxx"))).unwrap();
        }
        assert!(matches!(sink.dml, DmlOut::Text { overflow: true, .. }));
    }

    /// 布林值一律依「目標欄位型別」渲染成 1/0：MySQL TINYINT(1) 不吃 'true'（1366），
    /// 且 `WHERE flag = 'true'` 在 MySQL 會靜默轉成 0 而更新到錯的列。
    #[test]
    fn sink_renders_boolean_for_the_target_column_type() {
        let counters = Arc::new(Counters::default());
        let ctx = DmlCtx {
            kind: DbKind::Mysql,
            db: "d".into(),
            table: "t".into(),
            cols_dst: vec!["flag".into(), "note".into()],
            pk_dst: vec!["flag".into()],
            pk_idx: vec![0],
            // 目標：布林 + 文字。來源給的是 driver 讀出的 "true"/"false"。
            types_dst: vec!["tinyint(1)".into(), "varchar(10)".into()],
        };
        let mut sink = Sink::new(counters, vec!["flag".into(), "note".into()], 10, true, DmlOut::Text { del: String::new(), upd: String::new(), ins: String::new(), cap: 4096, overflow: false }, Some(ctx));
        let r = |b: &str, n: &str| Row { key: vec![Some(b.into())], values: vec![Some(b.into()), Some(n.into())] };
        sink.insert(&r("true", "true")).unwrap();
        sink.update(&r("false", "x"), &r("true", "y"), &[1]).unwrap();
        sink.delete(&r("true", "z")).unwrap();
        match &sink.dml {
            DmlOut::Text { del, upd, ins, .. } => {
                // 布林欄 → 1/0；文字欄的 "true" 原樣保留（目標不是布林，不該被改寫）。
                assert_eq!(ins, "INSERT INTO `d`.`t` (`flag`, `note`) VALUES ('1', 'true');\n");
                // 主鍵條件也走同一套渲染，否則 MySQL 會把 'false' 轉成 0 而更新到錯的列。
                assert_eq!(upd, "UPDATE `d`.`t` SET `note` = 'x' WHERE `flag` = '0';\n");
                assert_eq!(del, "DELETE FROM `d`.`t` WHERE `flag` = '1';\n");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn options_deserialize_with_defaults() {
        let o: DataCompareOptions = serde_json::from_str(r#"{"mode":"apply","include_deletes":true}"#).unwrap();
        assert_eq!(o.mode, RunMode::Apply);
        assert!(o.include_deletes);
        assert_eq!(o.max_rows, DEFAULT_MAX_ROWS);
        let d: DbCompareOptions = serde_json::from_str(r#"{"precheck":true,"strategy":"hash_diff"}"#).unwrap();
        assert!(d.precheck);
        assert_eq!(d.table.strategy, Strategy::HashDiff);
    }
}
