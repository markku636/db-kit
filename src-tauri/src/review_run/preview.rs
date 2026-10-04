//! 寫入語句的「影響列預覽」：不執行、不送 AI，只把每句 UPDATE / DELETE / INSERT 會碰到的列先 SELECT 出來給使用者看。
//!
//! 與審查並執行共用同一套分析與擷取（`plan::prepare` 決定擷取策略、`capture` 產生唯讀 SELECT），
//! 所以「預覽看到的列」就是「審查並執行會備份的前像」。差別只在這裡到此為止：不寫檔、不執行、不產生回滾。

use serde::Serialize;

use super::capture::{self, TableSnapshot};
use super::plan::{self, Blocker, Note, Strategy};
use crate::manager::ConnectionManager;
use crate::error::{AppError, AppResult};

/// 每句最多顯示的列數（使用者看的，不是備份；要完整清單請用審查並執行）。
pub const PREVIEW_ROWS: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct StatementPreview {
    pub index: usize,
    pub sql: String,
    pub op: super::analyze::Op,
    pub write: bool,
    pub targets: Vec<String>,
    pub estimated_rows: Option<u64>,
    pub estimate_exact: bool,
    pub method: String,
    /// 有擷取到列時的目標表與欄位；`rows` 與 `columns` 同序。
    pub table: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// 符合的列超過 PREVIEW_ROWS。
    pub truncated: bool,
    /// 沒有列可看時的說明（INSERT 自動編號、DDL、擷取失敗…）。
    pub detail: Option<String>,
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DmlPreview {
    pub database: String,
    pub statements: Vec<StatementPreview>,
    pub blockers: Vec<Blocker>,
}

fn from_snapshot(sp: &mut StatementPreview, snap: TableSnapshot) {
    let specs = &snap.meta.columns;
    sp.table = Some(snap.meta.table.clone());
    sp.columns = specs.iter().map(|c| c.name.clone()).collect();
    // 擷取值是 codec 的無損文字形式（SQLite 帶 `i:` / `t:` 型別前綴、二進位是 hex…），轉成給人看的樣子。
    sp.rows = snap
        .rows
        .iter()
        .map(|r| {
            r.iter()
                .zip(specs)
                .map(|(v, spec)| v.as_deref().map(|x| super::codec::display(spec, Some(x))))
                .collect()
        })
        .collect();
    sp.truncated = snap.truncated;
}

/// 預覽整份腳本的寫入語句（讀取語句照列出但不擷取）。
pub async fn preview(mgr: &ConnectionManager, id: &str, database: &str, script: &str) -> AppResult<DmlPreview> {
    let prepared = plan::prepare(mgr, id, database, script, PREVIEW_ROWS).await?;
    let ctx = prepared.ctx.clone().ok_or_else(|| AppError::Query(t!("沒有可執行的語句").into()))?;
    let kind = prepared.kind;
    let mut out = Vec::with_capacity(prepared.statements.len());
    for probe in &prepared.statements {
        let mut sp = StatementPreview {
            index: probe.index,
            sql: probe.sql.clone(),
            op: probe.op,
            write: probe.write,
            targets: probe.strategy.targets(kind),
            estimated_rows: probe.estimated_rows,
            estimate_exact: probe.estimate_exact,
            method: probe.method.clone(),
            table: None,
            columns: vec![],
            rows: vec![],
            truncated: false,
            detail: None,
            notes: probe.notes.clone(),
        };
        if probe.write {
            let captured = match &probe.strategy {
                Strategy::Predicate { meta, target, source, predicate, fanout, .. } => Some(
                    capture::capture_predicate(mgr, id, &ctx, meta, target, source, predicate.as_deref(), *fanout, PREVIEW_ROWS).await,
                ),
                Strategy::Keys { meta, keys } => {
                    // INSERT 帶明確鍵：列出「已存在、會撞鍵或被 upsert 覆蓋」的列；空表示全是新列。
                    let r = capture::capture_by_keys(mgr, id, &ctx, meta, keys, "keys").await;
                    if matches!(&r, Ok(s) if s.rows.is_empty()) {
                        sp.detail = Some(t!("這些鍵目前都不存在：全部是新增的列。").into());
                    }
                    Some(r)
                }
                Strategy::WholeTables { metas } => match metas.first() {
                    Some(m) => Some(capture::capture_whole(mgr, id, &ctx, m, PREVIEW_ROWS).await),
                    None => None,
                },
                Strategy::KeyRange { .. } => {
                    sp.detail = Some(t!("自動編號的新增：執行前沒有既有的列可預覽。").into());
                    None
                }
                Strategy::Schema { .. } | Strategy::Rename { .. } => {
                    sp.detail = Some(t!("結構變更：沒有資料列可預覽，請用「審查並執行」檢視結構前後差異。").into());
                    None
                }
                Strategy::None | Strategy::Unsupported => {
                    sp.detail = Some(t!("無法判斷這句會影響哪些列（例如呼叫程序或動態 SQL），無法預覽。").into());
                    None
                }
            };
            match captured {
                Some(Ok(snap)) => from_snapshot(&mut sp, snap),
                Some(Err(e)) => sp.detail = Some(tf!("擷取影響列失敗：{e}", e = e)),
                None => {}
            }
        }
        out.push(sp);
    }
    Ok(DmlPreview { database: prepared.database.clone(), statements: out, blockers: prepared.blockers.clone() })
}
