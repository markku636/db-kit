//! 探測：把靜態計畫落到實際連線上——解析表、讀結構與鍵、估列數，決定每句的擷取策略與回滾等級。
//!
//! 只送唯讀查詢。任何單句探測失敗都不讓整份分析失敗：記成一則 note、該句回滾等級降為 none，
//! 由使用者決定要不要在「沒有回滾」的情況下繼續。

use serde::Serialize;

use super::analyze::{analyze_script, supported_kind, CapturePlan, Issue, Op, SchemaScope, StatementPlan};
use super::capture::{self, ExecContext, TableMeta, MAX_ALL_TABLES};
use super::codec::Codec;
use super::names::ObjRef;
use super::scan::Masked;
use crate::db::DbKind;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

pub const DEFAULT_CAPTURE_ROWS: usize = 10_000;
pub const MAX_CAPTURE_ROWS: usize = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RollbackLevel {
    /// 讀取 / 維護類語句，不需要回滾。
    NotNeeded,
    Full,
    /// 有回滾，但部分列或部分變更不在涵蓋範圍內（見 notes）。
    Partial,
    /// 這句沒有回滾。
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteLevel {
    Info,
    Warn,
    Error,
}

/// 探測結果的說明。`message` 已依目前語言產生（後端語言隨 UI 切換，見 `set_lang`）。
#[derive(Debug, Clone, Serialize)]
pub struct Note {
    pub code: String,
    pub level: NoteLevel,
    pub message: String,
}

impl Note {
    fn new(code: &str, level: NoteLevel, message: String) -> Note {
        Note { code: code.into(), level, message }
    }
}

pub fn issue_message(issue: Issue) -> String {
    match issue {
        Issue::TxControl => t!("含交易控制語句（BEGIN / COMMIT / ROLLBACK）。本流程逐句自動提交，交易控制會落在連線池的不同連線上，請移除後再執行。").into(),
        Issue::SessionState => t!("含切換 session 狀態的語句（USE / SET / DECLARE / 暫存表 / LOCK）。連線池不保證下一句用同一條連線，請移除或改在查詢分頁執行。").into(),
        Issue::RoutineBody => t!("含程序 / 函式 / 觸發器本體，逐句切分不可靠。請改在查詢分頁執行。").into(),
        Issue::UnresolvedParams => t!("仍含未代入的具名參數（:name）。").into(),
        Issue::WholeDatabase => t!("DROP DATABASE / SCHEMA 無法以本流程備份，請先用「備份」做完整傾印。").into(),
        Issue::ProcedureCall => t!("呼叫預存程序：程序內容無法分析，這句沒有回滾。").into(),
        Issue::WritingCte => t!("可寫 CTE（WITH … DELETE / UPDATE / INSERT）：無法安全擷取前像，這句沒有回滾。").into(),
        Issue::MultiTarget => t!("一句同時改動多張表（或 CASCADE 連帶影響其他表），只涵蓋主要目標表。").into(),
        Issue::Unparsed => t!("無法解析這句的目標與條件，這句沒有回滾。").into(),
        Issue::ManualRollback => t!("權限 / 使用者 / 序列等變更不會自動產生反向語句，需手動回復。").into(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaGroup {
    pub database: String,
    pub tables: Vec<String>,
    pub views: Vec<String>,
    pub routines: Vec<String>,
    pub all_tables: bool,
    /// 擷取當下不存在的物件（CREATE 的目標）。
    pub missing: Vec<String>,
}

impl SchemaGroup {
    pub fn targets(&self) -> capture::SchemaTargets {
        capture::SchemaTargets {
            tables: self.tables.clone(),
            views: self.views.clone(),
            routines: self.routines.clone(),
            all_tables: self.all_tables,
        }
    }
}

/// 擷取策略（探測後決定）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Strategy {
    None,
    Predicate {
        meta: TableMeta,
        target: ObjRef,
        source: String,
        predicate: Option<String>,
        fanout: bool,
        set_columns: Option<Vec<String>>,
    },
    WholeTables {
        metas: Vec<TableMeta>,
    },
    /// INSERT … VALUES 帶明確鍵：前後像都依這些鍵擷取。
    Keys {
        meta: TableMeta,
        keys: Vec<Vec<String>>,
    },
    /// 自動編號的 INSERT：執行前記下最大鍵，執行後抓「大於它」的列。
    KeyRange {
        meta: TableMeta,
    },
    Schema {
        groups: Vec<SchemaGroup>,
        data: Vec<TableMeta>,
    },
    Rename {
        inverse: String,
    },
    Unsupported,
}

impl Strategy {
    pub fn method(&self) -> &'static str {
        match self {
            Strategy::None => "none",
            Strategy::Predicate { .. } => "predicate",
            Strategy::WholeTables { .. } => "whole_table",
            Strategy::Keys { .. } => "keys",
            Strategy::KeyRange { .. } => "key_range",
            Strategy::Schema { .. } => "schema",
            Strategy::Rename { .. } => "rename",
            Strategy::Unsupported => "unsupported",
        }
    }

    /// 顯示用的目標名稱。
    pub fn targets(&self, kind: DbKind) -> Vec<String> {
        match self {
            Strategy::Predicate { meta, .. } | Strategy::Keys { meta, .. } | Strategy::KeyRange { meta } => {
                vec![super::report::display_table(kind, &meta.database, &meta.table)]
            }
            Strategy::WholeTables { metas } => metas.iter().map(|m| super::report::display_table(kind, &m.database, &m.table)).collect(),
            Strategy::Schema { groups, .. } => groups
                .iter()
                .flat_map(|g| {
                    let mut v: Vec<String> = g.tables.iter().chain(&g.views).chain(&g.routines).cloned().collect();
                    if g.all_tables {
                        v.push(format!("{}.*", g.database));
                    }
                    v
                })
                .collect(),
            _ => vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementProbe {
    pub index: usize,
    pub sql: String,
    pub op: Op,
    pub write: bool,
    pub destructive: bool,
    pub has_where: Option<bool>,
    pub method: String,
    pub targets: Vec<String>,
    pub estimated_rows: Option<u64>,
    /// false：JOIN / USING fan-out 下的 COUNT 是上限，實際 ≤ 此值。
    pub estimate_exact: bool,
    pub rollback: RollbackLevel,
    pub notes: Vec<Note>,
    #[serde(skip)]
    pub strategy: Strategy,
    #[serde(skip)]
    pub plan: StatementPlan,
}

#[derive(Debug, Clone, Serialize)]
pub struct Blocker {
    pub index: usize,
    pub issue: Issue,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Prepared {
    pub kind: DbKind,
    pub database: String,
    pub prod: bool,
    pub max_capture_rows: usize,
    pub statements: Vec<StatementProbe>,
    pub blockers: Vec<Blocker>,
    /// 有寫入語句的回滾等級不是 full：執行前必須明確確認。
    pub needs_ack: bool,
    pub has_writes: bool,
    #[serde(skip)]
    pub ctx: Option<ExecContext>,
}

pub fn clamp_cap(cap: usize) -> usize {
    if cap == 0 {
        DEFAULT_CAPTURE_ROWS
    } else {
        cap.min(MAX_CAPTURE_ROWS)
    }
}

/// 分析 + 探測整份腳本。
pub async fn prepare(mgr: &ConnectionManager, id: &str, database: &str, script: &str, cap: usize) -> AppResult<Prepared> {
    let kind = mgr.kind(id)?;
    if !supported_kind(kind) {
        return Err(AppError::Unsupported(t!("此連線種類不支援審查並執行").into()));
    }
    let cap = clamp_cap(cap);
    let ctx = ExecContext::resolve(mgr, id, database).await?;
    let plan = analyze_script(kind, &ctx.database, script);
    if plan.statements.is_empty() {
        return Err(AppError::Query(t!("沒有可執行的語句").into()));
    }
    let prod = mgr.is_prod(id).unwrap_or(false);
    let mut probes = Vec::with_capacity(plan.statements.len());
    // 已被前面語句寫入的表：後面的語句若也碰到，探測數字是「目前狀態」而非執行到那句時的狀態。
    let mut written: Vec<(String, String, usize)> = Vec::new();
    for sp in &plan.statements {
        let mut probe = probe_statement(mgr, id, &ctx, sp, cap).await;
        if sp.write {
            let touched = touched_tables(&probe.strategy);
            for (db, t) in &touched {
                if let Some((_, _, j)) = written.iter().find(|(d, n, _)| d == db && n.eq_ignore_ascii_case(t)) {
                    probe.notes.push(Note::new(
                        "depends_on_earlier",
                        NoteLevel::Info,
                        tf!("前面第 {n} 句也改動了 {table}：列數估算以目前狀態為準，實際執行時會在這句前重新擷取。", n = j + 1, table = t),
                    ));
                    break;
                }
            }
            for (db, t) in touched {
                written.push((db, t, sp.index));
            }
        }
        probes.push(probe);
    }
    let blockers: Vec<Blocker> = plan
        .blockers()
        .into_iter()
        .map(|(index, issue)| Blocker { index, issue, message: issue_message(issue) })
        .collect();
    let has_writes = plan.has_writes();
    let needs_ack = probes.iter().any(|p| p.write && matches!(p.rollback, RollbackLevel::Partial | RollbackLevel::None));
    Ok(Prepared {
        kind,
        database: ctx.database.clone(),
        prod,
        max_capture_rows: cap,
        statements: probes,
        blockers,
        needs_ack,
        has_writes,
        ctx: Some(ctx),
    })
}

fn touched_tables(s: &Strategy) -> Vec<(String, String)> {
    match s {
        Strategy::Predicate { meta, .. } | Strategy::Keys { meta, .. } | Strategy::KeyRange { meta } => {
            vec![(meta.database.clone(), meta.table.clone())]
        }
        Strategy::WholeTables { metas } => metas.iter().map(|m| (m.database.clone(), m.table.clone())).collect(),
        Strategy::Schema { groups, .. } => groups
            .iter()
            .flat_map(|g| g.tables.iter().map(move |t| (g.database.clone(), t.clone())))
            .collect(),
        _ => vec![],
    }
}

pub(crate) async fn probe_statement(mgr: &ConnectionManager, id: &str, ctx: &ExecContext, sp: &StatementPlan, cap: usize) -> StatementProbe {
    let mut p = StatementProbe {
        index: sp.index,
        sql: sp.sql.clone(),
        op: sp.op,
        write: sp.write,
        destructive: sp.destructive,
        has_where: sp.has_where,
        method: String::new(),
        targets: vec![],
        estimated_rows: None,
        estimate_exact: true,
        rollback: if sp.write { RollbackLevel::Full } else { RollbackLevel::NotNeeded },
        notes: vec![],
        strategy: Strategy::None,
        plan: sp.clone(),
    };
    for issue in &sp.issues {
        let level = if issue.is_blocker() { NoteLevel::Error } else { NoteLevel::Warn };
        p.notes.push(Note::new(&format!("issue_{}", issue_code(*issue)), level, issue_message(*issue)));
    }
    if sp.write && matches!(sp.op, Op::Maintenance) {
        p.rollback = RollbackLevel::NotNeeded;
    }
    let result = match &sp.capture {
        CapturePlan::None => Ok(Strategy::None),
        CapturePlan::Unsupported => Ok(Strategy::Unsupported),
        CapturePlan::Rename { inverse } => Ok(Strategy::Rename { inverse: inverse.clone() }),
        CapturePlan::Rows { table, source, predicate, set_columns, fanout } => {
            probe_rows(mgr, id, ctx, sp, &mut p, cap, table, source, predicate.as_deref(), set_columns.as_ref(), *fanout).await
        }
        CapturePlan::Insert { table, columns, rows, upsert } => {
            probe_insert(mgr, id, ctx, &mut p, cap, table, columns.as_ref(), rows.as_ref(), *upsert).await
        }
        CapturePlan::WholeTables { tables } => probe_whole(mgr, id, ctx, sp, &mut p, cap, tables).await,
        CapturePlan::Schema { scope, data } => probe_schema(mgr, id, ctx, &mut p, cap, scope, data).await,
    };
    match result {
        Ok(s) => p.strategy = s,
        Err(e) => {
            p.notes.push(Note::new("probe_failed", NoteLevel::Error, tf!("探測失敗：{err}", err = e.message())));
            p.strategy = Strategy::Unsupported;
        }
    }
    // 回滾等級：issue 與策略都會往下壓，取最差的那個。
    if sp.write {
        let mut level = p.rollback;
        for issue in &sp.issues {
            let l = match issue {
                Issue::MultiTarget if matches!(p.strategy, Strategy::WholeTables { .. }) => RollbackLevel::Partial,
                _ => RollbackLevel::None,
            };
            level = level.max(l);
        }
        if matches!(p.strategy, Strategy::Unsupported) || (matches!(p.strategy, Strategy::None) && p.rollback != RollbackLevel::NotNeeded) {
            level = level.max(RollbackLevel::None);
        }
        p.rollback = level;
    }
    p.method = p.strategy.method().to_string();
    p.targets = p.strategy.targets(ctx.kind);
    p
}

fn issue_code(i: Issue) -> &'static str {
    match i {
        Issue::TxControl => "tx_control",
        Issue::SessionState => "session_state",
        Issue::RoutineBody => "routine_body",
        Issue::UnresolvedParams => "unresolved_params",
        Issue::WholeDatabase => "whole_database",
        Issue::ProcedureCall => "procedure_call",
        Issue::WritingCte => "writing_cte",
        Issue::MultiTarget => "multi_target",
        Issue::Unparsed => "unparsed",
        Issue::ManualRollback => "manual_rollback",
    }
}

fn downgrade(p: &mut StatementProbe, to: RollbackLevel) {
    p.rollback = p.rollback.max(to);
}

fn note_unrestorable_columns(p: &mut StatementProbe, meta: &TableMeta) {
    let cols: Vec<String> = meta.columns.iter().filter(|c| c.codec == Codec::Unsupported).map(|c| c.name.clone()).collect();
    if !cols.is_empty() {
        p.notes.push(Note::new(
            "unrestorable_columns",
            NoteLevel::Warn,
            tf!("{table} 的欄位 {cols} 型別無法以字面值無損還原；這些欄位有值的列不會自動回滾。", table = meta.table, cols = cols.join(", ")),
        ));
        downgrade(p, RollbackLevel::Partial);
    }
}

async fn resolve_meta(mgr: &ConnectionManager, id: &str, ctx: &ExecContext, p: &mut StatementProbe, obj: &ObjRef) -> AppResult<Option<TableMeta>> {
    match capture::resolve_table(mgr, id, ctx, obj).await? {
        Some((db, name)) => Ok(Some(capture::table_meta(mgr, id, ctx.kind, &db, &name).await?)),
        None => {
            p.notes.push(Note::new(
                "table_not_found",
                NoteLevel::Error,
                tf!("找不到資料表 {table}（資料庫 {db}）", table = obj.text, db = obj.db_or(&ctx.database)),
            ));
            downgrade(p, RollbackLevel::None);
            Ok(None)
        }
    }
}

fn note_too_many(p: &mut StatementProbe, table: &str, rows: u64, cap: usize, level: RollbackLevel) {
    p.notes.push(Note::new(
        "too_many_rows",
        NoteLevel::Error,
        tf!("{table} 受影響約 {rows} 列，超過擷取上限 {cap} 列：前像無法完整備份。", table = table, rows = rows, cap = cap),
    ));
    downgrade(p, level);
}

#[allow(clippy::too_many_arguments)]
async fn probe_rows(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    sp: &StatementPlan,
    p: &mut StatementProbe,
    cap: usize,
    table: &ObjRef,
    source: &str,
    predicate: Option<&str>,
    set_columns: Option<&Vec<String>>,
    fanout: bool,
) -> AppResult<Strategy> {
    let Some(meta) = resolve_meta(mgr, id, ctx, p, table).await? else {
        return Ok(Strategy::Unsupported);
    };
    let rows = capture::count(mgr, id, ctx, &capture::predicate_count_sql(source, predicate)).await?;
    p.estimated_rows = Some(rows);
    p.estimate_exact = !fanout;
    if sp.op == Op::Update && meta.key.is_empty() {
        p.notes.push(Note::new(
            "no_key",
            NoteLevel::Error,
            tf!("{table} 沒有主鍵或唯一鍵：無法定位被修改的列，這句沒有回滾。", table = meta.table),
        ));
        downgrade(p, RollbackLevel::None);
    }
    if sp.op == Op::Update {
        if let Some(sc) = set_columns {
            let hit: Vec<String> = sc.iter().filter(|c| meta.key.iter().any(|k| k.eq_ignore_ascii_case(c))).cloned().collect();
            if !hit.is_empty() {
                p.notes.push(Note::new(
                    "updates_key",
                    NoteLevel::Error,
                    tf!("這句修改了鍵欄位 {cols}：執行後無法依原鍵找回這些列，這句沒有回滾。", cols = hit.join(", ")),
                ));
                downgrade(p, RollbackLevel::None);
            }
        }
    }
    if fanout && meta.key.is_empty() {
        p.notes.push(Note::new(
            "fanout_without_key",
            NoteLevel::Warn,
            tf!("{table} 沒有主鍵且語句含 JOIN：同一列可能被重複擷取。", table = meta.table),
        ));
        downgrade(p, RollbackLevel::Partial);
    }
    if rows as usize > cap {
        note_too_many(p, &meta.table, rows, cap, RollbackLevel::None);
    }
    note_unrestorable_columns(p, &meta);
    Ok(Strategy::Predicate {
        meta,
        target: table.clone(),
        source: source.to_string(),
        predicate: predicate.map(String::from),
        fanout,
        set_columns: set_columns.cloned(),
    })
}

/// VALUES 裡的鍵是否為單純字面值（數字 / 字串 / NULL）。`uuid()` / `nextval()` / DEFAULT 之類要執行後才知道。
fn simple_literal(kind: DbKind, expr: &str) -> bool {
    let e = expr.trim();
    if e.eq_ignore_ascii_case("null") {
        return false; // NULL 鍵在主鍵裡不成立；唯一鍵裡定位不到單一列
    }
    let body = e.strip_prefix('-').unwrap_or(e);
    if !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit() || b == b'.') && body.bytes().filter(|b| *b == b'.').count() <= 1 {
        return true;
    }
    let s = if kind == DbKind::Mssql { e.strip_prefix('N').or_else(|| e.strip_prefix('n')).unwrap_or(e) } else { e };
    if !s.starts_with('\'') {
        return false;
    }
    let m = Masked::new(kind, s);
    m.mask.iter().all(|b| *b == super::scan::FILL)
}

fn integer_key(kind: DbKind, meta: &TableMeta) -> bool {
    if meta.key.len() != 1 {
        return false;
    }
    let Some(spec) = meta.spec(&meta.key[0]) else { return false };
    let t = spec.data_type.to_ascii_lowercase();
    let base = t.split('(').next().unwrap_or("").trim().to_string();
    match kind {
        DbKind::Sqlite => base == "integer",
        DbKind::Oracle => base == "number" && !t.contains(','),
        _ => matches!(
            base.as_str(),
            "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "int2" | "int4" | "int8" | "serial" | "bigserial" | "smallserial"
        ),
    }
}

#[allow(clippy::too_many_arguments)]
async fn probe_insert(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    p: &mut StatementProbe,
    cap: usize,
    table: &ObjRef,
    columns: Option<&Vec<String>>,
    rows: Option<&Vec<Vec<String>>>,
    upsert: bool,
) -> AppResult<Strategy> {
    let Some(meta) = resolve_meta(mgr, id, ctx, p, table).await? else {
        return Ok(Strategy::Unsupported);
    };
    note_unrestorable_columns(p, &meta);
    if let Some(rows) = rows {
        p.estimated_rows = Some(rows.len() as u64);
        p.estimate_exact = !upsert;
        if !meta.key.is_empty() {
            let cols: Vec<String> = match columns {
                Some(c) => c.clone(),
                None => meta.columns.iter().map(|c| c.name.clone()).collect(),
            };
            let pos: Option<Vec<usize>> = meta.key.iter().map(|k| cols.iter().position(|c| c.eq_ignore_ascii_case(k))).collect();
            if let Some(pos) = pos {
                let keys: Option<Vec<Vec<String>>> = rows
                    .iter()
                    .map(|r| {
                        pos.iter()
                            .map(|&i| r.get(i).filter(|e| simple_literal(ctx.kind, e)).map(|e| e.trim().to_string()))
                            .collect::<Option<Vec<String>>>()
                    })
                    .collect();
                if let Some(keys) = keys {
                    return Ok(Strategy::Keys { meta, keys });
                }
            }
        }
    }
    if !upsert && integer_key(ctx.kind, &meta) {
        p.notes.push(Note::new(
            "key_range",
            NoteLevel::Info,
            tf!("新增的列以「{key} 大於執行前最大值」認定；若執行期間有其他連線同時新增，回滾腳本會把那些列標為需人工確認。", key = meta.key[0]),
        ));
        return Ok(Strategy::KeyRange { meta });
    }
    // 其他情況（INSERT … SELECT 且鍵非整數、upsert 沒有明確鍵）：整表前後像比對。
    let total = capture::count(mgr, id, ctx, &format!("SELECT COUNT(*) FROM {}", meta.qualified(ctx.kind))).await?;
    if total as usize > cap {
        p.notes.push(Note::new(
            "too_many_rows",
            NoteLevel::Error,
            tf!("無法從語句判斷新增了哪些列，而 {table} 有 {rows} 列、超過擷取上限 {cap}：這句沒有回滾。", table = meta.table, rows = total, cap = cap),
        ));
        downgrade(p, RollbackLevel::None);
        return Ok(Strategy::Unsupported);
    }
    if meta.key.is_empty() {
        p.notes.push(Note::new(
            "no_key",
            NoteLevel::Warn,
            tf!("{table} 沒有主鍵或唯一鍵：新增的列無法精確刪除。", table = meta.table),
        ));
        downgrade(p, RollbackLevel::Partial);
    }
    Ok(Strategy::WholeTables { metas: vec![meta] })
}

async fn probe_whole(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    sp: &StatementPlan,
    p: &mut StatementProbe,
    cap: usize,
    tables: &[ObjRef],
) -> AppResult<Strategy> {
    let mut metas = Vec::new();
    let mut total = 0u64;
    for t in tables {
        let Some(meta) = resolve_meta(mgr, id, ctx, p, t).await? else {
            return Ok(Strategy::Unsupported);
        };
        let rows = capture::count(mgr, id, ctx, &format!("SELECT COUNT(*) FROM {}", meta.qualified(ctx.kind))).await?;
        total += rows;
        if rows as usize > cap {
            note_too_many(p, &meta.table, rows, cap, RollbackLevel::None);
        }
        // TRUNCATE 沒有鍵也能整批 INSERT 回去；MERGE / LOAD 需要鍵才分得出改了哪列。
        if meta.key.is_empty() && sp.op != Op::Truncate {
            p.notes.push(Note::new(
                "no_key",
                NoteLevel::Warn,
                tf!("{table} 沒有主鍵或唯一鍵：只能還原被刪除的列，修改與新增無法精確還原。", table = meta.table),
            ));
            downgrade(p, RollbackLevel::Partial);
        }
        note_unrestorable_columns(p, &meta);
        metas.push(meta);
    }
    p.estimated_rows = Some(total);
    p.estimate_exact = sp.op == Op::Truncate;
    Ok(Strategy::WholeTables { metas })
}

async fn probe_schema(
    mgr: &ConnectionManager,
    id: &str,
    ctx: &ExecContext,
    p: &mut StatementProbe,
    cap: usize,
    scope: &SchemaScope,
    data: &[ObjRef],
) -> AppResult<Strategy> {
    let mut groups: Vec<SchemaGroup> = Vec::new();
    let group_for = |groups: &mut Vec<SchemaGroup>, db: &str| -> usize {
        if let Some(i) = groups.iter().position(|g| g.database == db) {
            return i;
        }
        groups.push(SchemaGroup { database: db.to_string(), tables: vec![], views: vec![], routines: vec![], all_tables: false, missing: vec![] });
        groups.len() - 1
    };
    match scope {
        SchemaScope::Tables { objs } | SchemaScope::Views { objs } => {
            let views = matches!(scope, SchemaScope::Views { .. });
            for o in objs {
                let db = o.db_or(&ctx.database).to_string();
                let existing = mgr.list_tables(id, &db).await?;
                let name = super::names::resolve_name(&o.name, existing.iter().map(|t| t.name.as_str()));
                let gi = group_for(&mut groups, &db);
                let g = &mut groups[gi];
                let resolved = name.clone().unwrap_or_else(|| o.name.clone());
                if name.is_none() {
                    g.missing.push(resolved.clone());
                }
                if views {
                    g.views.push(resolved);
                } else {
                    g.tables.push(resolved);
                }
            }
        }
        SchemaScope::Routines { objs } => {
            for o in objs {
                let db = o.db_or(&ctx.database).to_string();
                let list = mgr.list_routines(id, &db).await.unwrap_or_default();
                let name = super::names::resolve_name(&o.name, list.iter().map(|r| r.name.as_str()));
                let gi = group_for(&mut groups, &db);
                let g = &mut groups[gi];
                let resolved = name.clone().unwrap_or_else(|| o.name.clone());
                if name.is_none() {
                    g.missing.push(resolved.clone());
                }
                g.routines.push(resolved);
            }
        }
        SchemaScope::AllTables { db } => {
            let db = db.clone().unwrap_or_else(|| ctx.database.clone());
            let n = mgr.list_tables(id, &db).await?.iter().filter(|t| t.kind != "view").count();
            if n > MAX_ALL_TABLES {
                p.notes.push(Note::new(
                    "schema_too_large",
                    NoteLevel::Error,
                    tf!("無法判斷索引屬於哪張表，而資料庫有 {n} 張表（上限 {cap}）：這句沒有回滾。", n = n, cap = MAX_ALL_TABLES),
                ));
                downgrade(p, RollbackLevel::None);
                return Ok(Strategy::Unsupported);
            }
            let gi = group_for(&mut groups, &db);
            groups[gi].all_tables = true;
            p.notes.push(Note::new(
                "all_tables",
                NoteLevel::Info,
                tf!("無法從語句判斷索引屬於哪張表，會擷取整個資料庫（{n} 張表）的結構。", n = n),
            ));
        }
    }
    let mut metas = Vec::new();
    let mut total = 0u64;
    for o in data {
        let Some((db, name)) = capture::resolve_table(mgr, id, ctx, o).await? else {
            continue; // DROP TABLE IF EXISTS 一張不存在的表
        };
        let meta = capture::table_meta(mgr, id, ctx.kind, &db, &name).await?;
        let rows = capture::count(mgr, id, ctx, &format!("SELECT COUNT(*) FROM {}", meta.qualified(ctx.kind))).await?;
        total += rows;
        if rows as usize > cap {
            p.notes.push(Note::new(
                "too_many_rows",
                NoteLevel::Error,
                tf!("{table} 有 {rows} 列，超過擷取上限 {cap}：結構可以還原，資料不行。", table = meta.table, rows = rows, cap = cap),
            ));
            downgrade(p, RollbackLevel::Partial);
        }
        note_unrestorable_columns(p, &meta);
        if meta.key.is_empty() && p.op == Op::AlterTable {
            p.notes.push(Note::new(
                "no_key",
                NoteLevel::Warn,
                tf!("{table} 沒有主鍵或唯一鍵：結構變更造成的資料改變無法逐列還原。", table = meta.table),
            ));
            downgrade(p, RollbackLevel::Partial);
        }
        metas.push(meta);
    }
    if !data.is_empty() {
        p.estimated_rows = Some(total);
    }
    Ok(Strategy::Schema { groups, data: metas })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_literals() {
        assert!(simple_literal(DbKind::Mysql, "42"));
        assert!(simple_literal(DbKind::Mysql, "-3.5"));
        assert!(simple_literal(DbKind::Mysql, "'a''b'"));
        assert!(simple_literal(DbKind::Mssql, "N'x'"));
        assert!(!simple_literal(DbKind::Mysql, "'a' || 'b'"));
        assert!(!simple_literal(DbKind::Mysql, "uuid()"));
        assert!(!simple_literal(DbKind::Postgres, "DEFAULT"));
        assert!(!simple_literal(DbKind::Postgres, "NULL"));
        assert!(!simple_literal(DbKind::Mysql, "1.2.3"));
    }

    #[test]
    fn rollback_levels_order_from_best_to_worst() {
        assert!(RollbackLevel::Full < RollbackLevel::Partial);
        assert!(RollbackLevel::Partial < RollbackLevel::None);
        assert_eq!(RollbackLevel::Full.max(RollbackLevel::None), RollbackLevel::None);
    }
}
