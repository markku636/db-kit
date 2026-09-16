//! `dbk schema snapshot|show` 與 `dbk compare schema`：結構快照與結構比對的 CLI 執行器。
//!
//! 與 `dispatch.rs` 分開的理由：比對要同時持有兩條連線（或連線 + 快照檔），
//! 單連線的 `run_connected` 流程套不上；連線收尾（含 SSH 通道）在此自行保證於所有路徑執行。
//! 進度一律走 stderr，stdout 只放結果（`--format json … > diff.json` 才不會被污染）。

use std::path::Path;

use crate::compare::data::{self, DataCompareOptions, DbCompareOptions, DbRef, RunMode, Strategy, TableRef};
use crate::compare::ddl::{self, SyncOptions};
use crate::compare::diff::{self, DiffOptions, SchemaDiff};
use crate::compare::schema::{self, CaptureOptions, DbSchema};
use crate::compare::snapshot;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

use super::args::{CompareCmd, CompareDataArgs, CompareSchemaArgs, ConnArgs, Format, StrategyArg};
use super::resolve::{self, SideRef};
use super::{guard, render};

/// `dbk schema snapshot --to a.json`（已連線；由 dispatch::exec 呼叫）。
pub async fn snapshot(
    mgr: &ConnectionManager,
    id: &str,
    conn_name: &str,
    db: &str,
    to: &str,
    no_ddl: bool,
    no_routines: bool,
) -> AppResult<()> {
    if db.is_empty() {
        return Err(AppError::Query(t!("請以 -d 指定要擷取的資料庫 / schema").into()));
    }
    let opts = CaptureOptions { include_ddl: !no_ddl, include_routines: !no_routines, ..Default::default() };
    let label = format!("{conn_name} / {db}");
    let progress = |done: usize, total: usize| {
        eprint!("\r{}", tf!("擷取結構中… {done}/{total}", done = done, total = total));
    };
    let s = schema::capture(mgr, id, db, &label, &opts, Some(&progress)).await?;
    eprintln!();
    let info = snapshot::save(Path::new(to), &s).await?;
    println!(
        "{}",
        tf!(
            "已存快照：{path}（{tables} 表 / {views} 視圖 / {routines} 程序，{bytes} bytes）",
            path = info.path,
            tables = info.tables,
            views = info.views,
            routines = info.routines,
            bytes = info.bytes
        )
    );
    for w in &s.warnings {
        eprintln!("warning: {w}");
    }
    Ok(())
}

/// `dbk schema show a.json`：不需連線。
pub async fn show_snapshot(path: &str, fmt: Format) -> AppResult<()> {
    let f = snapshot::load(Path::new(path)).await?;
    let s = &f.schema;
    let pairs = vec![
        (t!("種類").to_string(), s.kind.as_str().to_string()),
        (t!("資料庫").to_string(), s.database.clone()),
        (t!("標籤").to_string(), s.label.clone()),
        (t!("擷取時間").to_string(), fmt_ms(s.captured_at_ms)),
        (t!("資料表數").to_string(), s.tables.len().to_string()),
        (t!("視圖數").to_string(), s.views.len().to_string()),
        (t!("程序 / 函式 / 觸發器數").to_string(), s.routines.len().to_string()),
        (t!("快照版本").to_string(), f.version.to_string()),
        (t!("產生程式版本").to_string(), f.app_version.clone()),
    ];
    render::emit_pairs(fmt, &pairs);
    Ok(())
}

fn fmt_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| ms.to_string())
}

/// `dbk compare …` 入口。
pub async fn run(conn: &ConnArgs, fmt: Format, cmd: CompareCmd) -> AppResult<()> {
    match cmd {
        CompareCmd::Schema(a) => run_schema(conn, fmt, a).await,
        CompareCmd::Data(a) => run_data(conn, fmt, a).await,
    }
}

// ---------------------------------------------------------------------------
// compare data
// ---------------------------------------------------------------------------

async fn run_data(conn: &ConnArgs, fmt: Format, a: CompareDataArgs) -> AppResult<()> {
    let src_cfg = resolve::resolve(conn).await?;
    let src_db = conn
        .database
        .clone()
        .or_else(|| src_cfg.database.clone())
        .ok_or_else(|| AppError::Query(t!("請以 -d 指定來源資料庫 / schema").into()))?;
    // 目標：--dst 為連線名 / 連線字串；省略 = 同一連線（跨庫比對）。
    let dst_db = a.dst_db.clone().unwrap_or_else(|| src_db.clone());
    let dst_cfg = match &a.dst {
        Some(s) => match resolve::resolve_ref(s, Some(&dst_db)).await? {
            SideRef::Conn(c) => Some(c),
            SideRef::Snapshot(_) => return Err(AppError::Query(t!("資料比對的目標必須是連線，不能是快照檔").into())),
        },
        None => None,
    };

    let mgr = ConnectionManager::new();
    let src_id = src_cfg.id.clone();
    mgr.connect(src_cfg).await?;
    let dst_id = match dst_cfg {
        Some(c) => {
            let id = c.id.clone();
            if let Err(e) = mgr.connect(c).await {
                mgr.disconnect(&src_id).await;
                return Err(e);
            }
            id
        }
        None => src_id.clone(),
    };

    let res = run_data_connected(&mgr, conn, fmt, &a, &src_id, &src_db, &dst_id, &dst_db).await;
    mgr.disconnect(&src_id).await;
    if dst_id != src_id {
        mgr.disconnect(&dst_id).await;
    }
    res
}

#[allow(clippy::too_many_arguments)]
async fn run_data_connected(
    mgr: &ConnectionManager,
    conn: &ConnArgs,
    fmt: Format,
    a: &CompareDataArgs,
    src_id: &str,
    src_db: &str,
    dst_id: &str,
    dst_db: &str,
) -> AppResult<()> {
    let strategy = match a.strategy {
        StrategyArg::Auto => Strategy::Auto,
        StrategyArg::Merge => Strategy::MergeJoin,
        StrategyArg::Hash => Strategy::HashDiff,
    };
    // 掃描階段一律以 Sql 模式產出 DML 文字：--sql 直接印；--apply 先當預演給使用者看摘要，
    // 過 --yes / --force 守門後才真的再跑一次 apply 模式。
    let mut opts = DataCompareOptions {
        mode: if a.sql || a.apply { RunMode::Sql } else { RunMode::Report },
        strategy,
        include_deletes: a.include_deletes,
        sample_cap: a.samples,
        max_rows: a.max_rows,
        ignore_columns: a.ignore_columns.clone(),
        ignore_trailing_spaces: a.ignore_trailing_spaces,
        null_equals_empty: None,
        batch_size: 500,
        stop_on_error: a.stop_on_error,
        allow_prod_target: a.allow_prod,
    };
    let run_id = format!("cli-{}", uuid::Uuid::new_v4());
    let progress = |p: crate::compare::CompareProgress| {
        eprint!(
            "\r{}",
            tf!(
                "比對中… {table} {i}/{n} · 來源 {s} 列 / 目標 {d} 列 · +{ins} ~{upd} -{del}",
                table = p.table,
                i = p.table_index,
                n = p.table_count,
                s = p.src_rows,
                d = p.dst_rows,
                ins = p.inserts,
                upd = p.updates,
                del = p.deletes
            )
        );
    };

    if a.all {
        let s = DbRef { conn_id: src_id.into(), database: src_db.into() };
        let d = DbRef { conn_id: dst_id.into(), database: dst_db.into() };
        let dopts = DbCompareOptions { table: opts.clone(), tables: None, precheck: a.precheck, precheck_only: a.precheck_only };
        let report = data::compare_database(mgr, &run_id, &s, &d, &dopts, &progress).await?;
        eprintln!();
        if a.apply {
            let n = report.totals.inserts + report.totals.updates + if a.include_deletes { report.totals.deletes } else { 0 };
            if n == 0 {
                println!("{}", t!("資料一致，無需同步。"));
                return Ok(());
            }
            let action = tf!(
                "套用同步到目標「{db}」：{i} INSERT / {u} UPDATE / {d} DELETE（{t} 表）",
                db = dst_db,
                i = report.totals.inserts,
                u = report.totals.updates,
                d = if a.include_deletes { report.totals.deletes } else { 0 },
                t = report.tables.iter().filter(|t| t.status == data::TableStatus::Compared).count()
            );
            if let Err(e) = guard::ensure_confirmed(conn.yes, conn.force, a.include_deletes, &action) {
                print_db_report(fmt, &report);
                return Err(e);
            }
            opts.mode = RunMode::Apply;
            let dopts = DbCompareOptions { table: opts, tables: None, precheck: a.precheck, precheck_only: false };
            let applied = data::compare_database(mgr, &run_id, &s, &d, &dopts, &progress).await?;
            eprintln!();
            print_db_report(fmt, &applied);
            let failed: u64 = applied.tables.iter().filter_map(|t| t.report.as_ref()?.apply.as_ref()).map(|r| r.failed).sum();
            if failed > 0 {
                return Err(AppError::Query(tf!("{n} 句同步 SQL 失敗", n = failed)));
            }
            return Ok(());
        }
        if a.sql {
            for t in &report.tables {
                if let Some(sql) = t.report.as_ref().and_then(|r| r.sql.as_deref()) {
                    if !sql.is_empty() {
                        println!("-- {}", t.table);
                        print!("{sql}");
                    }
                }
            }
            eprintln!(
                "{}",
                tf!("+{ins} ~{upd} -{del}", ins = report.totals.inserts, upd = report.totals.updates, del = report.totals.deletes)
            );
            return Ok(());
        }
        print_db_report(fmt, &report);
        return Ok(());
    }

    let table = a.table.clone().unwrap_or_default();
    let s = TableRef { conn_id: src_id.into(), database: src_db.into(), table: table.clone() };
    let d = TableRef { conn_id: dst_id.into(), database: dst_db.into(), table: a.dst_table.clone().unwrap_or(table) };
    let report = data::compare_table(mgr, &run_id, &s, &d, &opts, &progress).await?;
    eprintln!();
    for w in &report.summary.warnings {
        eprintln!("warning: {w}");
    }
    if a.apply {
        let n = report.summary.inserts + report.summary.updates + if a.include_deletes { report.summary.deletes } else { 0 };
        if n == 0 {
            println!("{}", t!("資料一致，無需同步。"));
            return Ok(());
        }
        let action = tf!(
            "套用同步到目標「{dst}」：{i} INSERT / {u} UPDATE / {d} DELETE",
            dst = report.dst,
            i = report.summary.inserts,
            u = report.summary.updates,
            d = if a.include_deletes && !report.summary.deletes_suppressed { report.summary.deletes } else { 0 }
        );
        if let Err(e) = guard::ensure_confirmed(conn.yes, conn.force, a.include_deletes, &action) {
            print_table_report(fmt, &report);
            return Err(e);
        }
        opts.mode = RunMode::Apply;
        let applied = data::compare_table(mgr, &run_id, &s, &d, &opts, &progress).await?;
        eprintln!();
        print_table_report(fmt, &applied);
        if let Some(r) = &applied.apply {
            if r.failed > 0 {
                return Err(AppError::Query(tf!("{n} 句同步 SQL 失敗", n = r.failed)));
            }
        }
        return Ok(());
    }
    if a.sql {
        match &report.sql {
            Some(sql) => print!("{sql}"),
            None => eprintln!("{}", t!("同步 SQL 超過文字上限，請改用 --apply 或縮小範圍")),
        }
        eprintln!(
            "{}",
            tf!("+{ins} ~{upd} -{del}", ins = report.summary.inserts, upd = report.summary.updates, del = report.summary.deletes)
        );
        return Ok(());
    }
    print_table_report(fmt, &report);
    Ok(())
}

fn summary_pairs(s: &data::DataDiffSummary) -> Vec<(String, String)> {
    let mut v = vec![
        (t!("新增（目標缺）").to_string(), s.inserts.to_string()),
        (t!("更新（值不同）").to_string(), s.updates.to_string()),
        (t!("刪除（目標多出）").to_string(), s.deletes.to_string()),
        (t!("相同").to_string(), s.compared_rows.to_string()),
        (t!("來源列數").to_string(), s.src_rows.to_string()),
        (t!("目標列數").to_string(), s.dst_rows.to_string()),
        (t!("策略").to_string(), s.strategy_used.clone()),
        (t!("耗時（ms）").to_string(), s.elapsed_ms.to_string()),
    ];
    if let Some(r) = &s.truncated_reason {
        v.push((t!("截斷原因").to_string(), format!("{r:?}")));
    }
    if s.deletes_suppressed {
        v.push((t!("DELETE 已停用").to_string(), t!("比對被截斷，為安全不輸出 DELETE").to_string()));
    }
    v
}

fn print_table_report(fmt: Format, r: &data::DataDiffReport) {
    if fmt == Format::Json {
        render::emit_value(fmt, r);
        return;
    }
    let mut pairs = vec![(t!("來源").to_string(), r.src.clone()), (t!("目標").to_string(), r.dst.clone()), (t!("主鍵").to_string(), r.pk.join(", "))];
    pairs.extend(summary_pairs(&r.summary));
    if !r.skipped_src_columns.is_empty() {
        pairs.push((t!("來源獨有欄位（忽略）").to_string(), r.skipped_src_columns.join(", ")));
    }
    if !r.skipped_dst_columns.is_empty() {
        pairs.push((t!("目標獨有欄位（不受影響）").to_string(), r.skipped_dst_columns.join(", ")));
    }
    if let Some(a) = &r.apply {
        pairs.push((t!("已套用").to_string(), a.applied.to_string()));
        pairs.push((t!("失敗").to_string(), a.failed.to_string()));
        for e in &a.errors {
            eprintln!("error: {e}");
        }
    }
    render::emit_pairs(fmt, &pairs);
}

fn print_db_report(fmt: Format, r: &data::DataDiffDbReport) {
    if fmt == Format::Json {
        render::emit_value(fmt, r);
        return;
    }
    let cols: Vec<String> = ["table", "status", "inserts", "updates", "deletes", "same", "note"].iter().map(|s| s.to_string()).collect();
    let rows: Vec<Vec<Option<String>>> = r
        .tables
        .iter()
        .map(|t| {
            let s = t.report.as_ref().map(|x| &x.summary);
            let n = |f: fn(&data::DataDiffSummary) -> u64| s.map(|x| f(x).to_string());
            let mut note = t.reason.clone().unwrap_or_default();
            if let Some(ap) = t.report.as_ref().and_then(|x| x.apply.as_ref()) {
                note = tf!("已套用 {a}，失敗 {f}", a = ap.applied, f = ap.failed);
            }
            vec![
                Some(t.table.clone()),
                Some(format!("{:?}", t.status).to_ascii_lowercase()),
                n(|x| x.inserts),
                n(|x| x.updates),
                n(|x| x.deletes),
                n(|x| x.compared_rows),
                Some(note),
            ]
        })
        .collect();
    render::emit(fmt, &cols, &rows);
    if !r.only_in_src.is_empty() {
        eprintln!("{}", tf!("僅來源有：{list}", list = r.only_in_src.join(", ")));
    }
    if !r.only_in_dst.is_empty() {
        eprintln!("{}", tf!("僅目標有：{list}", list = r.only_in_dst.join(", ")));
    }
    eprintln!(
        "{}",
        tf!("合計 +{ins} ~{upd} -{del}", ins = r.totals.inserts, upd = r.totals.updates, del = r.totals.deletes)
    );
    if r.cancelled {
        eprintln!("{}", t!("已取消"));
    }
}

/// 一側解析出來的結構 + 若為即時連線，其在 manager 內的 id（收尾要 disconnect）。
struct Side {
    schema: DbSchema,
    conn_id: Option<String>,
}

async fn open_side(
    mgr: &ConnectionManager,
    side: SideRef,
    db_override: Option<&str>,
    opts: &CaptureOptions,
    role: &str,
) -> AppResult<Side> {
    match side {
        SideRef::Snapshot(p) => {
            let s = snapshot::load(&p).await?.schema;
            Ok(Side { schema: s, conn_id: None })
        }
        SideRef::Conn(cfg) => {
            let db = db_override
                .map(str::to_string)
                .or_else(|| cfg.database.clone())
                .ok_or_else(|| AppError::Query(tf!("{role}未指定資料庫 / schema", role = role)))?;
            let id = cfg.id.clone();
            let label = format!("{} / {db}", cfg.name);
            mgr.connect(cfg).await?;
            let progress = |done: usize, total: usize| {
                eprint!("\r{}", tf!("擷取{role}結構中… {done}/{total}", role = role, done = done, total = total));
            };
            let res = schema::capture(mgr, &id, &db, &label, opts, Some(&progress)).await;
            eprintln!();
            match res {
                Ok(s) => Ok(Side { schema: s, conn_id: Some(id) }),
                Err(e) => {
                    mgr.disconnect(&id).await;
                    Err(e)
                }
            }
        }
    }
}

async fn run_schema(conn: &ConnArgs, fmt: Format, a: CompareSchemaArgs) -> AppResult<()> {
    let capture_opts = CaptureOptions { include_routines: !a.no_routines, ..Default::default() };
    let diff_opts = DiffOptions {
        ignore_case: a.ignore_case,
        ignore_comments: a.ignore_comments,
        ignore_defaults: a.ignore_defaults,
        ..Default::default()
    };

    // 來源：--src 或全域連線旗標。
    let src_db = a.src_db.clone().or_else(|| conn.database.clone());
    let src_ref = match &a.src {
        Some(s) => resolve::resolve_ref(s, src_db.as_deref()).await?,
        None => SideRef::Conn(resolve::resolve(conn).await?),
    };
    // 目標：預設庫名同來源（跨連線同名庫是最常見情境）。
    let dst_db = a.dst_db.clone().or_else(|| src_db.clone());
    let dst_ref = resolve::resolve_ref(&a.dst, dst_db.as_deref()).await?;

    let mgr = ConnectionManager::new();
    let src = open_side(&mgr, src_ref, src_db.as_deref(), &capture_opts, &t!("來源")).await?;
    let dst = match open_side(&mgr, dst_ref, dst_db.as_deref(), &capture_opts, &t!("目標")).await {
        Ok(d) => d,
        Err(e) => {
            if let Some(id) = &src.conn_id {
                mgr.disconnect(id).await;
            }
            return Err(e);
        }
    };

    let res = compare_and_output(&mgr, conn, fmt, &a, &src, &dst, &diff_opts).await;

    for id in [&src.conn_id, &dst.conn_id].into_iter().flatten() {
        mgr.disconnect(id).await;
    }
    res
}

async fn compare_and_output(
    mgr: &ConnectionManager,
    conn: &ConnArgs,
    fmt: Format,
    a: &CompareSchemaArgs,
    src: &Side,
    dst: &Side,
    diff_opts: &DiffOptions,
) -> AppResult<()> {
    for w in src.schema.warnings.iter().chain(dst.schema.warnings.iter()) {
        eprintln!("warning: {w}");
    }
    let d = diff::diff(&src.schema, &dst.schema, diff_opts);

    if a.sync {
        let sync_opts = SyncOptions {
            include_drops: a.include_drops,
            include_routines: a.with_routines,
            ..Default::default()
        };
        let script = ddl::generate(&d, &src.schema, &dst.schema, &sync_opts)?;
        if a.apply {
            let Some(dst_id) = &dst.conn_id else {
                return Err(AppError::Query(t!("目標為快照檔，無法套用同步 SQL").into()));
            };
            if script.statements.is_empty() {
                println!("{}", t!("結構一致，無需同步。"));
                return Ok(());
            }
            let action = tf!(
                "在目標「{db}」執行 {n} 句同步 DDL（{d} 句為高破壞）",
                db = dst.schema.label,
                n = script.statements.len(),
                d = script.destructive_count
            );
            // 未確認：把腳本印出來當預演，再以 NeedsConfirm 結束。
            if let Err(e) = guard::ensure_confirmed(conn.yes, conn.force, script.destructive_count > 0, &action) {
                print!("{}", ddl::script_text(&script));
                return Err(e);
            }
            let total = script.statements.len();
            for (i, s) in script.statements.iter().enumerate() {
                eprint!("\r{}", tf!("套用中… {i}/{n}", i = i + 1, n = total));
                if let Err(e) = mgr.exec_ddl(dst_id, &s.sql).await {
                    eprintln!();
                    return Err(AppError::Query(tf!(
                        "第 {i} 句失敗（{obj}）：{err}\n{sql}",
                        i = i + 1,
                        obj = s.object,
                        err = e.to_string(),
                        sql = s.sql
                    )));
                }
            }
            eprintln!();
            println!("{}", tf!("已套用 {n} 句同步 DDL", n = total));
            for s in &script.skipped {
                eprintln!("skipped: {s}");
            }
            return Ok(());
        }
        match fmt {
            Format::Json => render::emit_value(fmt, &script),
            _ => print!("{}", ddl::script_text(&script)),
        }
        eprintln!(
            "{}",
            tf!(
                "{n} 句（{d} 句高破壞，{s} 項未能自動產生）",
                n = script.statements.len(),
                d = script.destructive_count,
                s = script.skipped.len()
            )
        );
    } else {
        match fmt {
            Format::Json => render::emit_value(fmt, &d),
            _ => {
                let (cols, rows) = flatten_diff(&d);
                if rows.is_empty() {
                    println!("{}", t!("結構一致，無差異。"));
                } else {
                    render::emit(fmt, &cols, &rows);
                }
            }
        }
    }

    if a.exit_code && !d.is_empty() {
        return Err(AppError::Query(tf!("發現 {n} 項結構差異", n = d.summary.total)));
    }
    Ok(())
}

/// 把巢狀差異攤成 `object_type | object | change | attribute | source | target` 列（table / csv 用）。
pub fn flatten_diff(d: &SchemaDiff) -> (Vec<String>, Vec<Vec<Option<String>>>) {
    let cols = ["object_type", "object", "change", "attribute", "source", "target"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let s = |v: &str| Some(v.to_string());
    let push = |rows: &mut Vec<Vec<Option<String>>>, ty: &str, obj: String, ch: &str, attr: &str, a: Option<String>, b: Option<String>| {
        rows.push(vec![s(ty), Some(obj), s(ch), s(attr), a, b]);
    };
    for t in &d.tables_added {
        push(&mut rows, "table", t.clone(), "added", "", None, None);
    }
    for t in &d.tables_removed {
        push(&mut rows, "table", t.clone(), "removed", "", None, None);
    }
    for td in &d.tables_changed {
        for c in &td.columns_added {
            push(&mut rows, "column", format!("{}.{}", td.name, c.name), "added", "", Some(c.data_type.clone()), None);
        }
        for c in &td.columns_removed {
            push(&mut rows, "column", format!("{}.{}", td.name, c.name), "removed", "", None, Some(c.data_type.clone()));
        }
        for c in &td.columns_changed {
            for a in &c.attrs {
                let (x, y) = match a {
                    diff::ColumnAttr::DataType => (c.src.data_type.clone(), c.dst.data_type.clone()),
                    diff::ColumnAttr::Nullable => (c.src.nullable.to_string(), c.dst.nullable.to_string()),
                    diff::ColumnAttr::Default => (c.src.default.clone().unwrap_or_default(), c.dst.default.clone().unwrap_or_default()),
                    diff::ColumnAttr::Extra => (c.src.extra.clone(), c.dst.extra.clone()),
                    diff::ColumnAttr::Comment => (c.src.comment.clone(), c.dst.comment.clone()),
                };
                let attr = serde_json::to_value(a).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
                push(&mut rows, "column", format!("{}.{}", td.name, c.name), "changed", &attr, Some(x), Some(y));
            }
        }
        let idx_s = |i: &crate::db::IndexInfo| format!("{}({}){}", if i.unique { "UNIQUE " } else { "" }, i.columns.join(","), if i.primary { " PK" } else { "" });
        for i in &td.indexes_added {
            push(&mut rows, "index", format!("{}.{}", td.name, i.name), "added", "", Some(idx_s(i)), None);
        }
        for i in &td.indexes_removed {
            push(&mut rows, "index", format!("{}.{}", td.name, i.name), "removed", "", None, Some(idx_s(i)));
        }
        for i in &td.indexes_changed {
            let ch = if i.renamed { "renamed" } else { "changed" };
            push(&mut rows, "index", format!("{}.{}", td.name, i.name), ch, "", Some(format!("{} {}", i.src.name, idx_s(&i.src))), Some(format!("{} {}", i.dst.name, idx_s(&i.dst))));
        }
        let fk_s = |f: &schema::ForeignKey| format!("({}) -> {}({})", f.columns.join(","), f.ref_table, f.ref_columns.join(","));
        for f in &td.fks_added {
            push(&mut rows, "foreign_key", format!("{}.{}", td.name, f.name), "added", "", Some(fk_s(f)), None);
        }
        for f in &td.fks_removed {
            push(&mut rows, "foreign_key", format!("{}.{}", td.name, f.name), "removed", "", None, Some(fk_s(f)));
        }
        for f in &td.fks_changed {
            let ch = if f.renamed { "renamed" } else { "changed" };
            push(&mut rows, "foreign_key", format!("{}.{}", td.name, f.name), ch, "", Some(format!("{} {}", f.src.name, fk_s(&f.src))), Some(format!("{} {}", f.dst.name, fk_s(&f.dst))));
        }
        if td.ddl_differs && td.is_empty() {
            push(&mut rows, "table", td.name.clone(), "changed", "ddl", None, None);
        }
    }
    for v in &d.views_added {
        push(&mut rows, "view", v.clone(), "added", "", None, None);
    }
    for v in &d.views_removed {
        push(&mut rows, "view", v.clone(), "removed", "", None, None);
    }
    for v in &d.views_changed {
        push(&mut rows, "view", v.name.clone(), "changed", "definition", None, None);
    }
    let rt = |t: &diff::TextChange| t.routine_type.clone().unwrap_or_else(|| "routine".into());
    for r in &d.routines_added {
        push(&mut rows, &rt(r), r.name.clone(), "added", "", None, None);
    }
    for r in &d.routines_removed {
        push(&mut rows, &rt(r), r.name.clone(), "removed", "", None, None);
    }
    for r in &d.routines_changed {
        push(&mut rows, &rt(r), r.name.clone(), "changed", "definition", None, None);
    }
    (cols, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compare::diff::tests::{col, db, table};
    use crate::db::DbKind;

    #[test]
    fn flatten_produces_one_row_per_attribute() {
        let s = db(DbKind::Mysql, vec![table("t", vec![col("a", "int", false), col("n", "int", true)], vec![]), table("x", vec![], vec![])]);
        let d = db(DbKind::Mysql, vec![table("t", vec![col("a", "bigint", true)], vec![])]);
        let df = diff::diff(&s, &d, &DiffOptions::default());
        let (cols, rows) = flatten_diff(&df);
        assert_eq!(cols.len(), 6);
        // x added, n added, a: data_type + nullable → 4 列。
        assert_eq!(rows.len(), 4);
        let a_rows: Vec<&Vec<Option<String>>> = rows.iter().filter(|r| r[1].as_deref() == Some("t.a")).collect();
        assert_eq!(a_rows.len(), 2);
        assert_eq!(a_rows[0][3].as_deref(), Some("data_type"));
        assert_eq!(a_rows[1][3].as_deref(), Some("nullable"));
    }
}
