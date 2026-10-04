//! `dbk mcp --allow-write` 的寫入工具：`preview_write` → 審查代碼 → `execute_write`。
//!
//! 整條路走「審查並執行」核心（`review_run`），與 GUI 的盾牌鈕、`dbk run` 是同一套：
//! 逐句探測影響範圍與回滾能力 → 執行前擷取前像 → 執行 → 擷取後像 → 輸出回滾腳本與差異報告。
//!
//! 兩段式的理由：
//! - 模型（與使用者）在執行前一定先看過影響列數與回滾能力；MCP 用戶端對每次工具呼叫的核准畫面，
//!   因此會是「預覽」與「執行」兩次，使用者有機會在第二次按拒絕。
//! - 審查代碼綁定**伺服器端保存的那份 SQL**：`execute_write` 不收 SQL，模型不可能預覽一段、執行另一段。
//!   代碼 15 分鐘失效、只能用一次。
//!
//! 伺服器旗標是硬性上限，模型改不了：高破壞語句要 `--allow-destructive`、正式環境要 `--allow-prod`；
//! 沒有完整回滾的語句，模型必須在 `execute_write` 明示 `acknowledge_incomplete: true`（核准畫面看得到）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::db::DbKind;
use crate::dbtools::{self, DbToolCtx};
use crate::review_run::plan::{self, NoteLevel, Prepared, RollbackLevel};
use crate::review_run::report::{self, RunStatus, StmtStatus};
use crate::review_run::run::{self, RunMode, RunOptions, RunRequest};

use super::extra::clip;
use super::registry::Target;

pub const PREVIEW_WRITE: &str = "preview_write";
pub const EXECUTE_WRITE: &str = "execute_write";

const TOKEN_TTL: Duration = Duration::from_secs(15 * 60);
/// 同時保留的預覽上限（防止模型狂刷預覽把記憶體吃光）；超過就丟最舊的。
const MAX_PENDING: usize = 32;
const MAX_ROLLBACK_PREVIEW: usize = 4 * 1024;

#[derive(Clone, Debug)]
pub struct WritePolicy {
    pub allow_destructive: bool,
    pub allow_prod: bool,
    pub out: PathBuf,
}

struct Pending {
    conn_key: String,
    conn_name: String,
    database: String,
    script: String,
    needs_ack: bool,
    created: Instant,
}

#[derive(Default)]
pub struct PendingStore(Mutex<HashMap<String, Pending>>);

impl PendingStore {
    fn insert(&self, token: String, p: Pending) {
        let mut g = self.0.lock();
        g.retain(|_, v| v.created.elapsed() < TOKEN_TTL);
        while g.len() >= MAX_PENDING {
            let Some(oldest) = g.iter().min_by_key(|(_, v)| v.created).map(|(k, _)| k.clone()) else { break };
            g.remove(&oldest);
        }
        g.insert(token, p);
    }

    fn take(&self, token: &str) -> Option<Pending> {
        let mut g = self.0.lock();
        let p = g.remove(token)?;
        (p.created.elapsed() < TOKEN_TTL).then_some(p)
    }

    fn put_back(&self, token: String, p: Pending) {
        self.0.lock().insert(token, p);
    }
}

pub fn defs() -> Vec<dbtools::ToolDef> {
    vec![
        dbtools::ToolDef {
            name: PREVIEW_WRITE,
            description: t!("預覽一段寫入 SQL（INSERT / UPDATE / DELETE / DDL，可多句）：逐句估算影響列數、能否完整回滾與風險提示，不會改動任何資料。通過後回傳審查代碼；請先把預覽內容給使用者確認，再呼叫 execute_write。").to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": t!("要執行的 SQL 腳本") },
                    "database": { "type": "string", "description": t!("資料庫 / schema 名稱；省略則用目前對話的資料庫") }
                },
                "required": ["sql"]
            }),
        },
        dbtools::ToolDef {
            name: EXECUTE_WRITE,
            description: t!("執行先前 preview_write 預覽過的 SQL（以審查代碼指定，不能改 SQL）。執行前自動擷取前像，完成後回傳每句影響列數與回滾腳本位置。").to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "review_token": { "type": "string", "description": t!("preview_write 回傳的審查代碼") },
                    "acknowledge_incomplete": { "type": "boolean", "description": t!("預覽指出有語句無法完整回滾時，須徵得使用者同意後設為 true") }
                },
                "required": ["review_token"]
            }),
        },
    ]
}

/// 寫入政策預檢（不連線）：種類與正式環境。
pub fn precheck(target: &Target, policy: &WritePolicy) -> Result<(), String> {
    if !crate::review_run::analyze::supported_kind(target.kind) {
        return Err(tf!("{kind} 連線不支援寫入工具（只支援 SQL 資料庫）", kind = target.kind.as_str()));
    }
    if target.prod && !policy.allow_prod {
        return Err(tf!(
            "連線「{name}」標記為正式環境，這個 MCP 伺服器不允許對它寫入（啟動時需加 --allow-prod）",
            name = target.name
        ));
    }
    Ok(())
}

/// 寫入的命名空間（與 `dbk run` 同規則）：PostgreSQL 以參數 / `-d` 為 schema、沒有就交給 current_schema()；
/// SQLite 固定 main；其餘參數 > 上下文預設庫。
pub fn namespace(ctx: &DbToolCtx, args: &Value, flag: Option<&str>) -> String {
    let arg = args.get("database").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
    match ctx.kind {
        DbKind::Sqlite => String::new(),
        DbKind::Postgres => arg.or(flag).unwrap_or_default().to_string(),
        _ => arg.map(String::from).or_else(|| ctx.database.clone()).unwrap_or_default(),
    }
}

fn analysis_text(prep: &Prepared) -> String {
    let mut s = tf!("資料庫：{db}　語句：{n}", db = prep.database, n = prep.statements.len());
    s.push('\n');
    for st in &prep.statements {
        let one: String = st.sql.split_whitespace().collect::<Vec<_>>().join(" ");
        let short: String = one.chars().take(160).collect();
        let rows = st
            .estimated_rows
            .map(|n| format!("{}{n}", if st.estimate_exact { "" } else { "≤" }))
            .unwrap_or_else(|| "—".into());
        let mut flags: Vec<String> = Vec::new();
        if st.destructive {
            flags.push(t!("高破壞").to_string());
        }
        if st.write {
            flags.push(tf!("回滾：{level}", level = report::level_text(st.rollback)));
        }
        s.push_str(&format!(
            "#{} {} · {} · {}\n    {}\n",
            st.index + 1,
            if st.write { "write" } else { "read" },
            tf!("約 {rows} 列", rows = rows),
            flags.join(" · "),
            short
        ));
        for n in &st.notes {
            let tag = match n.level {
                NoteLevel::Info => "info",
                NoteLevel::Warn => "warn",
                NoteLevel::Error => "error",
            };
            s.push_str(&format!("    [{tag}] {}\n", n.message));
        }
    }
    for b in &prep.blockers {
        s.push_str(&tf!("✗ 第 {n} 句：{msg}", n = b.index + 1, msg = b.message));
        s.push('\n');
    }
    s
}

fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

pub async fn preview(
    ctx: &DbToolCtx,
    target: &Target,
    ns: &str,
    args: &Value,
    policy: &WritePolicy,
    store: &PendingStore,
) -> Result<String, String> {
    let sql = args
        .get("sql")
        .or_else(|| args.get("query"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| t!("缺少 sql").to_string())?;
    let prep = plan::prepare(&ctx.manager, &ctx.conn_id, ns, sql, 0).await.map_err(|e| e.message())?;
    let analysis = analysis_text(&prep);
    if !prep.blockers.is_empty() {
        return Err(format!("{analysis}\n{}", t!("腳本含本流程不支援的語句，無法執行。請拆開或改寫後再預覽。")));
    }
    if !prep.has_writes {
        return Err(format!("{analysis}\n{}", t!("這段 SQL 沒有寫入語句；查詢請改用 run_query。")));
    }
    let destructive = prep.statements.iter().filter(|s| s.destructive).count();
    if destructive > 0 && !policy.allow_destructive {
        return Err(format!(
            "{analysis}\n{}",
            tf!(
                "有 {n} 句高破壞語句（DROP / TRUNCATE / 無 WHERE 的 UPDATE·DELETE），這個 MCP 伺服器不允許執行（啟動時需加 --allow-destructive）。",
                n = destructive
            )
        ));
    }
    let token = new_token();
    store.insert(
        token.clone(),
        Pending {
            conn_key: target.key.clone(),
            conn_name: target.name.clone(),
            database: ns.to_string(),
            script: sql.to_string(),
            needs_ack: prep.needs_ack,
            created: Instant::now(),
        },
    );
    let mut out = analysis;
    out.push('\n');
    out.push_str(&tf!("審查代碼：{token}（15 分鐘內有效、只能用一次）", token = token));
    out.push('\n');
    if prep.needs_ack {
        let n = prep
            .statements
            .iter()
            .filter(|s| s.write && matches!(s.rollback, RollbackLevel::Partial | RollbackLevel::None))
            .count();
        out.push_str(&tf!(
            "注意：有 {n} 句無法完整回滾。執行時須帶 acknowledge_incomplete: true，而且要先徵得使用者同意。",
            n = n
        ));
        out.push('\n');
    }
    out.push_str(t!("請先把上面的預覽給使用者確認，再以這個審查代碼呼叫 execute_write。"));
    Ok(out)
}

/// 取出待執行的預覽（給伺服器決定要連哪條連線）。失效 / 不存在回錯誤文字。
pub fn take(store: &PendingStore, args: &Value) -> Result<(String, PendingHandle), String> {
    let token = args
        .get("review_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| t!("缺少 review_token：請先呼叫 preview_write").to_string())?
        .to_string();
    let p = store
        .take(&token)
        .ok_or_else(|| t!("審查代碼無效或已過期（15 分鐘、只能用一次）：請重新呼叫 preview_write").to_string())?;
    Ok((p.conn_key.clone(), PendingHandle { token, p }))
}

/// 已從待執行清單取出的一筆預覽。
pub struct PendingHandle {
    token: String,
    p: Pending,
}

pub async fn execute(
    ctx: &DbToolCtx,
    h: PendingHandle,
    args: &Value,
    policy: &WritePolicy,
    store: &PendingStore,
) -> Result<String, String> {
    let ack = args.get("acknowledge_incomplete").and_then(|v| v.as_bool()).unwrap_or(false);
    if h.p.needs_ack && !ack {
        let msg = t!("這次預覽有語句無法完整回滾：徵得使用者同意後，帶 acknowledge_incomplete: true 再呼叫一次。").to_string();
        store.put_back(h.token, h.p);
        return Err(msg);
    }
    let p = h.p;
    let run_id = format!("mcp-{}", uuid::Uuid::new_v4());
    let noop = |_: run::Progress| {};
    let outcome = run::run(
        &ctx.manager,
        &ctx.conn_id,
        RunRequest {
            run_id: &run_id,
            conn_label: &p.conn_name,
            database: &p.database,
            script: &p.script,
            out_dir: &policy.out,
            mode: RunMode::Execute,
            options: RunOptions { max_capture_rows: 0, allow_incomplete: ack, confirm_prod: policy.allow_prod },
            review: None,
        },
        &noop,
    )
    .await
    .map_err(|e| e.message())?;

    let m = &outcome.manifest;
    let mut s = tf!("結果：{status}", status = report::status_text(m.status));
    s.push('\n');
    for st in &m.statements {
        let diff = st
            .diff
            .iter()
            .map(|d| format!("{} ~{} +{} -{}", d.table, d.updated, d.inserted, d.deleted))
            .collect::<Vec<_>>()
            .join("; ");
        let state = match st.status {
            StmtStatus::Ok => "ok",
            StmtStatus::Failed => "FAILED",
            StmtStatus::NotRun => "not run",
        };
        s.push_str(&format!(
            "#{} {} · {} · {}{}\n",
            st.index + 1,
            state,
            tf!("影響 {n} 列", n = st.rows_affected.map(|n| n.to_string()).unwrap_or_else(|| "—".into())),
            tf!("回滾：{level}", level = report::level_text(st.rollback)),
            if diff.is_empty() { String::new() } else { format!(" · {diff}") }
        ));
        if let Some(e) = &st.error {
            s.push_str(&format!("    {e}\n"));
        }
    }
    if let Some(r) = &m.stop_reason {
        s.push_str(&format!("{r}\n"));
    }
    s.push_str(&tf!("前像、回滾腳本與報告：{dir}", dir = outcome.dir));
    s.push('\n');
    if !outcome.rollback_preview.trim().is_empty() {
        s.push_str(&format!("\n-- rollback.sql\n{}", clip(outcome.rollback_preview.clone(), MAX_ROLLBACK_PREVIEW)));
    }
    match m.status {
        RunStatus::Completed => Ok(s),
        _ => Err(s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(created: Instant) -> Pending {
        Pending { conn_key: "k".into(), conn_name: "n".into(), database: "d".into(), script: "s".into(), needs_ack: false, created }
    }

    #[test]
    fn tokens_are_single_use_and_expire() {
        let st = PendingStore::default();
        st.insert("a".into(), pending(Instant::now()));
        assert!(st.take("a").is_some());
        assert!(st.take("a").is_none(), "只能用一次");
        if let Some(old) = Instant::now().checked_sub(TOKEN_TTL + Duration::from_secs(1)) {
            st.insert("b".into(), pending(old));
            assert!(st.take("b").is_none(), "過期");
        }
    }

    #[test]
    fn pending_store_is_bounded() {
        let st = PendingStore::default();
        for i in 0..(MAX_PENDING + 5) {
            st.insert(format!("t{i}"), pending(Instant::now()));
        }
        assert!(st.0.lock().len() <= MAX_PENDING);
        assert!(st.take(&format!("t{}", MAX_PENDING + 4)).is_some(), "最新的一定留著");
    }

    #[test]
    fn take_requires_a_token() {
        let st = PendingStore::default();
        assert!(take(&st, &json!({})).is_err());
        assert!(take(&st, &json!({ "review_token": "nope" })).is_err());
    }

    #[test]
    fn precheck_blocks_prod_and_non_sql() {
        let pol = WritePolicy { allow_destructive: false, allow_prod: false, out: PathBuf::from(".") };
        let t = |kind, prod| Target { key: String::new(), name: "x".into(), kind, prod };
        assert!(precheck(&t(DbKind::Mysql, false), &pol).is_ok());
        assert!(precheck(&t(DbKind::Mysql, true), &pol).is_err());
        assert!(precheck(&t(DbKind::Redis, false), &pol).is_err());
        let pol2 = WritePolicy { allow_prod: true, ..pol };
        assert!(precheck(&t(DbKind::Mysql, true), &pol2).is_ok());
    }
}
