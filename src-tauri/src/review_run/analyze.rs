//! 靜態分析：腳本 → 逐句的「該抓什麼前像、能不能回滾、要不要整份擋下」計畫。
//!
//! 語法判斷沿用前端 `impact.ts` 的思路（它是本功能的前身，只接了影響列數估算、沒接 UI）：
//! 不寫完整 parser，只回答三個問題——目標是誰、頂層 WHERE 在哪、尾巴砍到哪；答不出來就明確
//! 標成 `Unparsed`，由後續流程要求使用者確認「這句沒有回滾」。六個方言的 DML 在 FROM / USING /
//! JOIN / TOP / LIMIT / RETURNING / OUTPUT 上組合爆炸，「大致對」的 parser 會靜默切錯 WHERE，
//! 然後抓到錯的前像——對回滾腳本來說，那比沒有更糟。
//!
//! 純函式、不碰連線：探測列數與擷取前像在 `capture` 做。

use serde::Serialize;

use super::names::{column_name, parse_column_list, parse_obj_ref, ObjRef};
use super::scan::{split_statements, Masked};
use crate::db::DbKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Read,
    Update,
    Delete,
    Insert,
    Replace,
    Merge,
    Truncate,
    Load,
    CreateTable,
    DropTable,
    AlterTable,
    RenameTable,
    CreateIndex,
    DropIndex,
    CreateView,
    DropView,
    CreateRoutine,
    DropRoutine,
    DropDatabase,
    Call,
    Permission,
    Maintenance,
    TxControl,
    Session,
    Other,
}

/// 語句層級的問題。前段是「整份腳本不得走本流程」的阻擋，後段是「這句沒有完整回滾」的警示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Issue {
    // ---- 阻擋 ----
    /// BEGIN / COMMIT / ROLLBACK / SAVEPOINT：本流程逐句 autocommit，交易控制語句會落在連線池的
    /// 不同連線上，留下一條開著交易的連線。
    TxControl,
    /// USE / SET / DECLARE / 暫存表 / LOCK TABLES：session 狀態在連線池裡不保證帶到下一句。
    SessionState,
    /// 非 PostgreSQL 的程序 / 觸發器本體：BEGIN … END 裡的分號讓逐句切分失準。
    RoutineBody,
    /// 仍含未代入的 `:name` 具名參數。
    UnresolvedParams,
    /// DROP DATABASE / SCHEMA：沒有可擷取的單一物件，請改用完整備份。
    WholeDatabase,
    // ---- 回滾受限（需使用者確認）----
    /// CALL / EXEC / DO：程序內容不可分析。
    ProcedureCall,
    /// PostgreSQL 可寫 CTE。
    WritingCte,
    /// 一句同時改多張表（MySQL `DELETE a, b FROM …` / 多表 UPDATE 的 SET 橫跨兩張表）。
    MultiTarget,
    /// 句型不在可分析範圍內。
    Unparsed,
    /// 權限 / 使用者 / 序列等不動資料列、但本工具也不產生反向語句的變更。
    ManualRollback,
}

impl Issue {
    pub fn is_blocker(self) -> bool {
        matches!(
            self,
            Issue::TxControl | Issue::SessionState | Issue::RoutineBody | Issue::UnresolvedParams | Issue::WholeDatabase
        )
    }
}

/// 結構擷取範圍。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SchemaScope {
    Tables { objs: Vec<ObjRef> },
    Views { objs: Vec<ObjRef> },
    Routines { objs: Vec<ObjRef> },
    /// 找不到索引屬於哪張表（PG / Oracle 的 `DROP INDEX ix`）：整庫的表結構都要擷取。
    AllTables { db: Option<String> },
}

/// 擷取計畫（靜態可知的部分；實際策略在探測後決定）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CapturePlan {
    /// 不需要前像（讀取、或不動資料 / 結構）。
    None,
    /// UPDATE / DELETE：依述詞擷取目標表的列。
    Rows {
        table: ObjRef,
        /// FROM 子句（可含 JOIN / 其他來源）；前像查詢為 `SELECT … FROM {source} WHERE {predicate}`。
        source: String,
        predicate: Option<String>,
        /// UPDATE 的 SET 目標欄（解析失敗 = None，回滾時保守還原所有欄）。
        set_columns: Option<Vec<String>>,
        /// 來源含 JOIN / USING / FROM：同一列可能重複出現，要依鍵去重。
        fanout: bool,
    },
    /// INSERT / REPLACE / upsert。
    Insert {
        table: ObjRef,
        columns: Option<Vec<String>>,
        /// VALUES 的各列原始運算式（非 VALUES 形式為 None）。
        rows: Option<Vec<Vec<String>>>,
        /// 含 ON DUPLICATE KEY / ON CONFLICT，或本身是 REPLACE：可能覆寫既有列。
        upsert: bool,
    },
    /// TRUNCATE / MERGE / LOAD：整表前像。
    WholeTables { tables: Vec<ObjRef> },
    /// DDL：物件結構前後像；`data` 為需要一併保留資料的表（DROP TABLE / 破壞性 ALTER）。
    Schema { scope: SchemaScope, data: Vec<ObjRef> },
    /// RENAME：反向語句可由文字直接推得，不需擷取。
    Rename { inverse: String },
    /// 無法擷取（原因見 issues）。
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementPlan {
    pub index: usize,
    pub sql: String,
    pub op: Op,
    pub write: bool,
    /// DROP / TRUNCATE / 無 WHERE 的 UPDATE·DELETE / 破壞性 ALTER / MERGE / REPLACE。
    pub destructive: bool,
    pub has_where: Option<bool>,
    pub capture: CapturePlan,
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScriptPlan {
    pub kind: DbKind,
    pub database: String,
    pub statements: Vec<StatementPlan>,
}

impl ScriptPlan {
    pub fn blockers(&self) -> Vec<(usize, Issue)> {
        self.statements
            .iter()
            .flat_map(|s| s.issues.iter().filter(|i| i.is_blocker()).map(move |i| (s.index, *i)))
            .collect()
    }
    pub fn has_writes(&self) -> bool {
        self.statements.iter().any(|s| s.write)
    }
}

/// 本流程支援的連線種類：六種內建 SQL 引擎（external gateway 的結構 API 不可靠，不收）。
pub fn supported_kind(kind: DbKind) -> bool {
    matches!(
        kind,
        DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres | DbKind::Sqlite | DbKind::Mssql | DbKind::Oracle
    )
}

pub fn analyze_script(kind: DbKind, database: &str, script: &str) -> ScriptPlan {
    let statements = split_statements(kind, script)
        .into_iter()
        .enumerate()
        .map(|(i, (a, b))| {
            let mut p = analyze_statement(kind, &script[a..b]);
            p.index = i;
            p
        })
        .collect();
    ScriptPlan { kind, database: database.to_string(), statements }
}

pub fn analyze_statement(kind: DbKind, sql: &str) -> StatementPlan {
    let sql = sql.trim().trim_end_matches(';').trim_end();
    let mut p = StatementPlan {
        index: 0,
        sql: sql.to_string(),
        op: Op::Other,
        write: false,
        destructive: false,
        has_where: None,
        capture: CapturePlan::None,
        issues: Vec::new(),
    };
    let m = Masked::new(kind, sql);
    let kw = m.first_word();
    match kw.as_str() {
        "select" | "show" | "describe" | "desc" | "explain" | "values" | "table" | "pragma" => {
            p.op = Op::Read;
            // SQLite 的 `PRAGMA x = y` 會改連線設定。
            if kw == "pragma" && m.find_top_byte(b'=', 0, m.len()).is_some() {
                p.op = Op::Session;
                p.write = true;
                p.issues.push(Issue::SessionState);
            }
            // T-SQL 的 SELECT … INTO 新表：會建表。
            if kw == "select" && m.find_top(&["into"], 0).is_some() && kind != DbKind::Mysql && kind != DbKind::Mariadb {
                p.op = Op::CreateTable;
                p.write = true;
                p.issues.push(Issue::Unparsed);
                p.capture = CapturePlan::Unsupported;
            }
        }
        "with" => {
            if m.find_any(&["insert"], 0).or(m.find_any(&["update"], 0)).or(m.find_any(&["delete"], 0)).or(m.find_any(&["merge"], 0)).is_some() {
                p.op = Op::Other;
                p.write = true;
                p.destructive = true;
                p.capture = CapturePlan::Unsupported;
                p.issues.push(Issue::WritingCte);
            } else {
                p.op = Op::Read;
            }
        }
        "update" => analyze_update(kind, &m, &mut p),
        "delete" => analyze_delete(kind, &m, &mut p),
        "insert" | "replace" | "upsert" => analyze_insert(kind, &m, &mut p, kw == "replace"),
        "merge" => analyze_merge(kind, &m, &mut p),
        "truncate" => analyze_truncate(kind, &m, &mut p),
        "drop" => analyze_drop(kind, &m, &mut p),
        "create" => analyze_create(kind, &m, &mut p),
        "alter" => analyze_alter(kind, &m, &mut p),
        "rename" => analyze_rename_table(kind, &m, &mut p),
        "load" | "copy" => analyze_load(kind, &m, &mut p),
        "call" | "exec" | "execute" | "do" => {
            p.op = Op::Call;
            p.write = true;
            p.capture = CapturePlan::Unsupported;
            p.issues.push(Issue::ProcedureCall);
        }
        "grant" | "revoke" | "comment" | "deny" => {
            p.op = Op::Permission;
            p.write = true;
            p.issues.push(Issue::ManualRollback);
        }
        "analyze" | "analyse" | "vacuum" | "reindex" | "optimize" | "checkpoint" | "cluster" | "refresh" | "check"
        | "repair" | "flush" => {
            p.op = Op::Maintenance;
            p.write = true;
        }
        "begin" | "start" | "commit" | "rollback" | "savepoint" | "release" | "end" => {
            p.op = Op::TxControl;
            p.write = true;
            p.issues.push(Issue::TxControl);
        }
        "set" if kind == DbKind::Mssql && m.phrase_at(m.skip_ws(0), &["set", "identity_insert"]).is_some() => {
            analyze_identity_batch(kind, sql, &mut p)
        }
        // 回滾腳本檔頭的 SET：值與 db-kit 連線本來就設定的相同（sqlx 的預設），在連線池的任何一條連線上都是
        // 無作用；認得它們，回滾腳本本身才能再走一次審查並執行。
        "set" if is_connection_default_set(kind, sql) => {
            p.op = Op::Session;
        }
        "set" | "use" | "declare" | "lock" | "unlock" | "reset" | "discard" | "delimiter" => {
            p.op = Op::Session;
            p.write = true;
            p.issues.push(Issue::SessionState);
        }
        "" => {}
        _ => {
            p.op = Op::Other;
            p.write = true;
            p.capture = CapturePlan::Unsupported;
            p.issues.push(Issue::Unparsed);
        }
    }
    if p.write && has_named_params(&m) {
        p.issues.push(Issue::UnresolvedParams);
    }
    p
}

// ---------------------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------------------

/// `:name` 具名參數（PG 的 `::type` 轉型不算）。只看程式碼段（字面值 / 註解已被遮罩）。
fn has_named_params(m: &Masked) -> bool {
    let b = &m.mask;
    for i in 0..b.len() {
        if b[i] != b':' {
            continue;
        }
        if i > 0 && b[i - 1] == b':' {
            continue;
        }
        if i + 1 < b.len() && b[i + 1] == b':' {
            continue;
        }
        // MySQL 的 `:=` 指派、Oracle / T-SQL 的標籤 `label:` 都不是參數。
        if i + 1 < b.len() && (b[i + 1].is_ascii_alphabetic() || b[i + 1] == b'_') {
            return true;
        }
    }
    false
}

/// 跳過一串修飾詞（出現順序不拘），回傳修飾詞之後的位移與是否帶 TOP (n)。
fn skip_modifiers(m: &Masked, mut at: usize, words: &[&str]) -> usize {
    loop {
        let pos = m.skip_ws(at);
        let mut advanced = false;
        for w in words {
            if let Some(e) = m.phrase_at(pos, &[w]) {
                at = e;
                advanced = true;
                break;
            }
        }
        // `OR REPLACE` / `OR IGNORE`（SQLite）。
        if !advanced {
            if let Some(e) = m.phrase_at(pos, &["or"]) {
                if let Some((s2, e2)) = m.word_after(e) {
                    let w = m.src[s2..e2].to_ascii_lowercase();
                    if ["rollback", "abort", "replace", "fail", "ignore", "alter"].contains(&w.as_str()) {
                        at = e2;
                        advanced = true;
                    }
                }
            }
        }
        // T-SQL 的 TOP (n) / TOP n [PERCENT]。
        if !advanced {
            if let Some(e) = m.phrase_at(pos, &["top"]) {
                let mut j = m.skip_ws(e);
                if j < m.len() && m.mask[j] == b'(' {
                    while j < m.len() && m.mask[j] != b')' {
                        j += 1;
                    }
                    j += 1;
                } else {
                    while j < m.len() && m.mask[j].is_ascii_digit() {
                        j += 1;
                    }
                }
                at = m.phrase_at(m.skip_ws(j), &["percent"]).unwrap_or(j);
                advanced = true;
            }
        }
        if !advanced {
            return m.skip_ws(at);
        }
    }
}

/// 語句尾巴（RETURNING / OUTPUT / ORDER BY / LIMIT / OFFSET / FETCH）的起點。
fn find_tail(m: &Masked, from: usize) -> usize {
    const TAILS: &[&[&str]] = &[
        &["returning"],
        &["output"],
        &["order", "by"],
        &["limit"],
        &["offset"],
        &["fetch", "first"],
        &["fetch", "next"],
        &["option"],
    ];
    m.find_top_first(TAILS, from).map(|(s, _, _)| s).unwrap_or(m.len())
}

/// FROM 子句的第一個來源與其他來源是否存在（JOIN / 逗號）。
struct FromItems {
    items: Vec<ObjRef>,
    joined: bool,
}

/// 拆 FROM 子句裡「看得懂的表參照」（JOIN 的 ON 條件略過）。子查詢 / 函式來源直接略過不列。
fn from_items(kind: DbKind, text: &str) -> FromItems {
    let m = Masked::new(kind, text);
    let mut items = Vec::new();
    let mut joined = false;
    // 以逗號與 JOIN 家族關鍵字切段；每段去掉 ON / USING 之後的條件。
    let mut cuts: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    const JOIN_WORDS: &[&str] = &["join", "inner", "left", "right", "full", "cross", "natural", "straight_join", "outer", "apply"];
    while i < m.len() {
        if m.depth[i] == 0 {
            if m.mask[i] == b',' {
                cuts.push((start, i));
                start = i + 1;
                joined = true;
                i += 1;
                continue;
            }
            let mut hit = None;
            for w in JOIN_WORDS {
                if let Some(e) = m.phrase_at(i, &[w]) {
                    hit = Some(e);
                    break;
                }
            }
            if let Some(e) = hit {
                if start < i {
                    cuts.push((start, i));
                }
                start = e;
                joined = true;
                i = e;
                continue;
            }
        }
        i += 1;
    }
    cuts.push((start, m.len()));
    for (a, b) in cuts {
        let seg = &text[a..b];
        let sm = Masked::new(kind, seg);
        let end = sm.find_top_first(&[&["on"], &["using"]], 0).map(|(s, _, _)| s).unwrap_or(seg.len());
        let piece = seg[..end].trim();
        if piece.is_empty() {
            continue;
        }
        if let Some(o) = parse_obj_ref(kind, piece) {
            items.push(o);
        }
    }
    FromItems { items, joined }
}

/// 別名 → 真正的表參照（T-SQL `UPDATE o SET … FROM orders o`、MySQL `DELETE o FROM orders o`）。
fn resolve_alias(target_word: &str, items: &[ObjRef]) -> Option<ObjRef> {
    items
        .iter()
        .find(|o| o.alias.as_deref().is_some_and(|a| a.eq_ignore_ascii_case(target_word)))
        .or_else(|| items.iter().find(|o| o.alias.is_none() && o.text.eq_ignore_ascii_case(target_word)))
        .cloned()
}

fn set_destructive_by_where(p: &mut StatementPlan) {
    if p.has_where == Some(false) {
        p.destructive = true;
    }
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

// 形狀（跨方言）：
//   MySQL    UPDATE [LOW_PRIORITY][IGNORE] t [JOIN u ON …] SET … [WHERE …][ORDER BY …][LIMIT n]
//   PG       UPDATE [ONLY] t [AS x] SET … [FROM other] [WHERE …][RETURNING …]
//   MSSQL    UPDATE [TOP (n)] t SET … [OUTPUT …][FROM other][WHERE …]
//   SQLite   UPDATE [OR …] t SET … [FROM other][WHERE …]
//   Oracle   UPDATE t [alias] SET … [WHERE …]
fn analyze_update(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.op = Op::Update;
    p.write = true;
    let head = m.phrase_at(m.skip_ws(0), &["update"]).unwrap_or(0);
    let header_end = skip_modifiers(m, head, &["low_priority", "ignore"]);
    let Some((set_s, set_e)) = m.find_top(&["set"], header_end) else {
        return unparsed(p);
    };
    let target_text = m.cut(header_end, set_s);
    let where_hit = m.find_top(&["where"], set_e);
    p.has_where = Some(where_hit.is_some());
    set_destructive_by_where(p);
    if let Some((_, we)) = where_hit {
        if m.phrase_at(m.skip_ws(we), &["current", "of"]).is_some() {
            return unparsed(p);
        }
    }
    let tail_from = where_hit.map(|(_, e)| e).unwrap_or(set_e);
    let tail = find_tail(m, tail_from);
    let body_end = where_hit.map(|(s, _)| s).unwrap_or(tail).min(tail);
    // PG / MSSQL / SQLite 的 `UPDATE t SET … FROM other`；OUTPUT 可能夾在 SET 與 FROM 之間。
    let from_hit = m.find_top(&["from"], set_e).filter(|(s, _)| *s < body_end);
    let set_end = [from_hit.map(|(s, _)| s), Some(find_tail(m, set_e)), Some(body_end)]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(body_end);
    let set_columns = parse_set_columns(kind, m.cut(set_e, set_end));
    let predicate = where_hit.map(|(_, we)| m.cut(we, tail).to_string());

    // 目標：MySQL 可 `UPDATE a JOIN b ON … SET`；其餘方言為單一表（可帶別名）。
    let target_items = from_items(kind, target_text);
    let (table, source, fanout) = if let Some((_, fe)) = from_hit {
        let from_text = m.cut(fe, body_end);
        let items = from_items(kind, from_text);
        let bare = parse_obj_ref(kind, target_text);
        match (kind, bare) {
            // T-SQL：SET 前面常是 FROM 裡的別名，FROM 本身就含目標表。
            (DbKind::Mssql, Some(b)) if b.alias.is_none() && b.db.is_none() => {
                let t = resolve_alias(&b.text, &items.items).unwrap_or(b);
                (t, from_text.to_string(), true)
            }
            (_, Some(b)) => (b, format!("{target_text}, {from_text}"), true),
            _ => return unparsed(p),
        }
    } else if target_items.joined {
        match target_items.items.first() {
            Some(first) => (first.clone(), target_text.to_string(), true),
            None => return unparsed(p),
        }
    } else {
        match parse_obj_ref(kind, target_text) {
            Some(t) => (t, target_text.to_string(), false),
            None => return unparsed(p),
        }
    };
    // MySQL 多表 UPDATE：SET 若改到非第一張表的欄位，就是一句改兩張表。
    if target_items.joined {
        if let Some(q) = set_qualifiers(kind, m.cut(set_e, set_end)) {
            let mine = table.column_qualifier(kind);
            if q.iter().any(|x| !x.eq_ignore_ascii_case(&mine) && !x.eq_ignore_ascii_case(&table.name)) {
                p.issues.push(Issue::MultiTarget);
                p.capture = CapturePlan::Unsupported;
                return;
            }
        }
    }
    p.capture = CapturePlan::Rows { table, source, predicate, set_columns, fanout };
}

/// SET 子句的目標欄名。`SET (a, b) = (…)`（PG）也收。解析失敗回 None。
fn parse_set_columns(kind: DbKind, set_text: &str) -> Option<Vec<String>> {
    let m = Masked::new(kind, set_text);
    let mut cols = Vec::new();
    for (a, b) in m.split_top(0, set_text.len(), b',') {
        let assign = &set_text[a..b];
        let am = Masked::new(kind, assign);
        let eq = am.find_top_byte(b'=', 0, assign.len())?;
        let lhs = assign[..eq].trim();
        if lhs.starts_with('(') {
            cols.extend(parse_column_list(kind, lhs)?);
        } else {
            cols.push(column_name(kind, lhs)?);
        }
    }
    if cols.is_empty() {
        None
    } else {
        Some(cols)
    }
}

/// SET 左側帶的限定詞（`a.x = …` 的 a）；有任何一個無限定詞就回空集合代表「都屬於目標表」。
fn set_qualifiers(kind: DbKind, set_text: &str) -> Option<Vec<String>> {
    let m = Masked::new(kind, set_text);
    let mut out = Vec::new();
    for (a, b) in m.split_top(0, set_text.len(), b',') {
        let assign = &set_text[a..b];
        let am = Masked::new(kind, assign);
        let eq = am.find_top_byte(b'=', 0, assign.len())?;
        let lhs = assign[..eq].trim();
        let lm = Masked::new(kind, lhs);
        // 最後一個不在引號內的點之前就是限定詞。
        if let Some(dot) = (0..lhs.len()).rev().find(|&i| lm.mask[i] == b'.') {
            let q = lhs[..dot].trim();
            let last = q.rsplit('.').next().unwrap_or(q).trim_matches(|c| c == '`' || c == '"' || c == '[' || c == ']');
            out.push(last.to_string());
        }
    }
    Some(out)
}

fn unparsed(p: &mut StatementPlan) {
    p.capture = CapturePlan::Unsupported;
    if !p.issues.contains(&Issue::Unparsed) {
        p.issues.push(Issue::Unparsed);
    }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

// 形狀（跨方言）：
//   MySQL  DELETE [LOW_PRIORITY][QUICK][IGNORE] a[, b] FROM a JOIN b … WHERE …
//          DELETE FROM a USING a JOIN b … WHERE …
//   MSSQL  DELETE [TOP (n)] [FROM] a [OUTPUT …] [FROM a JOIN b …] WHERE …  ← 第二個 FROM 才是來源
//   PG     DELETE FROM [ONLY] t [AS x] [USING other] WHERE … [RETURNING …]
//   Oracle DELETE [FROM] t [alias] WHERE …
fn analyze_delete(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.op = Op::Delete;
    p.write = true;
    let head = m.phrase_at(m.skip_ws(0), &["delete"]).unwrap_or(0);
    let header_end = skip_modifiers(m, head, &["low_priority", "quick", "ignore"]);
    let where_hit = m.find_top(&["where"], header_end);
    p.has_where = Some(where_hit.is_some());
    set_destructive_by_where(p);
    if let Some((_, we)) = where_hit {
        if m.phrase_at(m.skip_ws(we), &["current", "of"]).is_some() {
            return unparsed(p);
        }
    }
    let tail = find_tail(m, where_hit.map(|(_, e)| e).unwrap_or(header_end));
    let body_end = match where_hit {
        Some((ws, _)) => ws.min(find_tail(m, header_end)),
        None => tail,
    };
    let predicate = where_hit.map(|(_, we)| m.cut(we, tail).to_string());
    let from1 = m.find_top(&["from"], header_end).filter(|(s, _)| *s < body_end);

    let (table, source, fanout) = match from1 {
        None => {
            // Oracle / T-SQL 的 `DELETE t WHERE …`（省略 FROM）。
            let src = m.cut(header_end, body_end);
            match parse_obj_ref(kind, src) {
                Some(t) => (t, src.to_string(), false),
                None => return unparsed(p),
            }
        }
        Some((f1s, f1e)) => {
            let pre_from = m.cut(header_end, f1s);
            let from2 = m.find_top(&["from"], f1e).filter(|(s, _)| *s < body_end);
            let using = m.find_top(&["using"], f1e).filter(|(s, _)| *s < body_end);
            let main_start = from2.map(|(_, e)| e).unwrap_or(f1e);
            let main_end = using.map(|(s, _)| s).filter(|s| *s > main_start).unwrap_or(body_end);
            let main_text = m.cut(main_start, main_end);
            let mysql = matches!(kind, DbKind::Mysql | DbKind::Mariadb);
            // MySQL `DELETE FROM a USING a JOIN b`：FROM 後面列的是「要刪的表」，USING 才是來源。
            let mysql_using = mysql && using.is_some_and(|(ue, _)| ue > main_start);
            let source = match using {
                Some((_, ue)) if ue > main_start && mysql => m.cut(ue, body_end).to_string(),
                Some((_, ue)) if ue > main_start => format!("{main_text}, {}", m.cut(ue, body_end)),
                _ => main_text.to_string(),
            };
            let items = from_items(kind, &source);
            let fanout = !pre_from.is_empty() || from2.is_some() || using.is_some() || items.joined;
            if mysql_using {
                let tm = Masked::new(kind, main_text);
                if tm.find_top_byte(b',', 0, main_text.len()).is_some() {
                    p.issues.push(Issue::MultiTarget);
                    p.capture = CapturePlan::Unsupported;
                    return;
                }
                let word = main_text.trim_end_matches(".*");
                let Some(t) = resolve_alias(word, &items.items).or_else(|| parse_obj_ref(kind, word)) else {
                    return unparsed(p);
                };
                p.capture = CapturePlan::Rows { table: t, source, predicate, set_columns: None, fanout };
                return;
            }
            if !pre_from.is_empty() {
                // MySQL `DELETE a, b FROM …`：一句刪兩張表。
                let pm = Masked::new(kind, pre_from);
                if pm.find_top_byte(b',', 0, pre_from.len()).is_some() {
                    p.issues.push(Issue::MultiTarget);
                    p.capture = CapturePlan::Unsupported;
                    return;
                }
                let word = pre_from.trim_end_matches(".*");
                match resolve_alias(word, &items.items).or_else(|| parse_obj_ref(kind, word)) {
                    Some(t) => (t, source, fanout),
                    None => return unparsed(p),
                }
            } else if from2.is_some() {
                // T-SQL `DELETE FROM o FROM orders o JOIN …`：第一個 FROM 後面是別名或表名。
                let word = m.cut(f1e, from2.unwrap().0);
                match resolve_alias(word, &items.items).or_else(|| parse_obj_ref(kind, word)) {
                    Some(t) => (t, source, fanout),
                    None => return unparsed(p),
                }
            } else {
                match items.items.first() {
                    Some(first) => (first.clone(), source, fanout),
                    None => return unparsed(p),
                }
            }
        }
    };
    p.capture = CapturePlan::Rows { table, source, predicate, set_columns: None, fanout };
}

// ---------------------------------------------------------------------------
// INSERT / REPLACE / upsert
// ---------------------------------------------------------------------------

/// 與 db-kit 連線既有 session 設定相同的 SET（回滾腳本檔頭產生的那幾句）。
fn is_connection_default_set(kind: DbKind, sql: &str) -> bool {
    let norm = sql.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    super::codec::script_preamble(kind).iter().any(|p| p.to_ascii_lowercase() == norm)
}

/// SQL Server 回滾腳本的 identity 批次：`SET IDENTITY_INSERT t ON` + 多句 INSERT + `SET IDENTITY_INSERT t OFF`，
/// 整批在同一條連線上送出（見 rollback.rs）。解析成「對 t 的一句多列 INSERT」，ON / OFF 不算 session 狀態。
fn analyze_identity_batch(kind: DbKind, sql: &str, p: &mut StatementPlan) {
    p.op = Op::Insert;
    p.write = true;
    let m = Masked::new(kind, sql);
    let Some((_, on_end)) = m.find_top(&["set", "identity_insert"], 0) else {
        return unparsed(p);
    };
    let Some((on_s, on_e)) = m.find_top(&["on"], on_end) else {
        return unparsed(p);
    };
    let Some(table) = parse_obj_ref(kind, m.cut(on_end, on_s)) else {
        return unparsed(p);
    };
    let Some((off_s, off_e)) = m.find_top(&["set", "identity_insert"], on_e) else {
        return unparsed(p);
    };
    if m.find_top(&["off"], off_e).is_none() {
        return unparsed(p);
    }
    let mut starts = Vec::new();
    let mut from = on_e;
    while let Some((s, e)) = m.find_top(&["insert"], from) {
        if s >= off_s {
            break;
        }
        starts.push(s);
        from = e;
    }
    if starts.is_empty() {
        return unparsed(p);
    }
    let mut columns: Option<Vec<String>> = None;
    let mut rows = Vec::new();
    for (i, &s) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(off_s);
        let one = analyze_statement(kind, m.cut(s, end));
        match one.capture {
            CapturePlan::Insert { table: t, columns: c, rows: Some(r), upsert: false } if t.name == table.name && t.db == table.db => {
                if columns.is_some() && columns != c {
                    return unparsed(p);
                }
                columns = c;
                rows.extend(r);
            }
            _ => return unparsed(p),
        }
    }
    p.capture = CapturePlan::Insert { table, columns, rows: Some(rows), upsert: false };
}

fn analyze_insert(kind: DbKind, m: &Masked, p: &mut StatementPlan, replace: bool) {
    p.op = if replace { Op::Replace } else { Op::Insert };
    p.write = true;
    let head = m.word_after(0).map(|(_, e)| e).unwrap_or(0);
    // Oracle 的 INSERT ALL / FIRST：多目標。
    if m.phrase_at(m.skip_ws(head), &["all"]).is_some() || m.phrase_at(m.skip_ws(head), &["first"]).is_some() {
        p.issues.push(Issue::MultiTarget);
        p.capture = CapturePlan::Unsupported;
        return;
    }
    let mut header_end = skip_modifiers(m, head, &["low_priority", "delayed", "high_priority", "ignore"]);
    if let Some(e) = m.phrase_at(header_end, &["into"]) {
        header_end = m.skip_ws(e);
    }
    let upsert_hit = m.find_top_first(&[&["on", "duplicate", "key"], &["on", "conflict"]], header_end);
    let upsert = replace || upsert_hit.is_some() || (kind == DbKind::Sqlite && m.find_top(&["or", "replace"], 0).is_some());
    if upsert {
        p.destructive = replace;
    }
    let body = m.find_top_first(
        &[&["values"], &["value"], &["select"], &["with"], &["set"], &["default", "values"], &["exec"], &["execute"]],
        header_end,
    );
    let body_start = body.map(|(s, _, _)| s).unwrap_or(m.len());
    // T-SQL 的 OUTPUT 夾在欄位清單與 VALUES 之間；PG 的 RETURNING 在句尾。主體的結束點只看主體之後的。
    let tail = m
        .find_top_first(&[&["returning"], &["output"]], body.map(|(_, e, _)| e).unwrap_or(header_end))
        .map(|(s, _, _)| s)
        .unwrap_or(m.len());
    let end = upsert_hit.map(|(s, _, _)| s).unwrap_or(m.len()).min(tail).min(m.len());
    let output_before_body = m.find_top(&["output"], header_end).map(|(s, _)| s).filter(|s| *s < body_start);
    // 目標表：header 之後到欄位清單 `(`、OUTPUT 或主體為止。
    let mut target_end = output_before_body.unwrap_or(body_start).min(end);
    let mut col_list: Option<(usize, usize)> = None;
    if let Some(open) = m.find_top_byte(b'(', header_end, target_end) {
        // 對應的右括號：深度回到 0 的第一個 `)`。
        let close = (open + 1..target_end).find(|&i| m.mask[i] == b')' && m.depth[i] == 0);
        if let Some(c) = close {
            col_list = Some((open, c + 1));
        }
        target_end = open;
    }
    let target_text = m.cut(header_end, target_end);
    let Some(table) = parse_obj_ref(kind, target_text) else {
        return unparsed(p);
    };
    let columns = col_list.and_then(|(a, b)| parse_column_list(kind, &m.src[a..b]));
    let rows = match body {
        Some((_, be, 0 | 1)) => parse_values_rows(kind, m, be, end),
        Some((_, be, 4)) => {
            // MySQL `INSERT … SET a = 1, b = 2`：欄位與值都在 SET 裡。
            let set_text = m.cut(be, end);
            return finish_insert_set(kind, p, table, set_text, upsert);
        }
        _ => None,
    };
    p.capture = CapturePlan::Insert { table, columns, rows, upsert };
}

fn parse_values_rows(kind: DbKind, m: &Masked, from: usize, to: usize) -> Option<Vec<Vec<String>>> {
    let mut rows = Vec::new();
    for (a, b) in m.split_top(from, to, b',') {
        let tuple = &m.src[a..b];
        // MySQL 8 的 `VALUES ROW(1, 2)`。
        let tuple = tuple.strip_prefix("ROW").or_else(|| tuple.strip_prefix("row")).unwrap_or(tuple).trim();
        let inner = tuple.strip_prefix('(')?.strip_suffix(')')?;
        let im = Masked::new(kind, inner);
        rows.push(im.split_top(0, inner.len(), b',').into_iter().map(|(x, y)| inner[x..y].to_string()).collect());
    }
    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

fn finish_insert_set(kind: DbKind, p: &mut StatementPlan, table: ObjRef, set_text: &str, upsert: bool) {
    let m = Masked::new(kind, set_text);
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    for (a, b) in m.split_top(0, set_text.len(), b',') {
        let assign = &set_text[a..b];
        let am = Masked::new(kind, assign);
        let Some(eq) = am.find_top_byte(b'=', 0, assign.len()) else {
            return unparsed(p);
        };
        let Some(c) = column_name(kind, &assign[..eq]) else {
            return unparsed(p);
        };
        cols.push(c);
        vals.push(assign[eq + 1..].trim().to_string());
    }
    p.capture = CapturePlan::Insert { table, columns: Some(cols), rows: Some(vec![vals]), upsert };
}

// ---------------------------------------------------------------------------
// MERGE / TRUNCATE / LOAD
// ---------------------------------------------------------------------------

fn analyze_merge(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.op = Op::Merge;
    p.write = true;
    p.destructive = true;
    let head = m.phrase_at(m.skip_ws(0), &["merge"]).unwrap_or(0);
    let mut at = skip_modifiers(m, head, &[]);
    if let Some(e) = m.phrase_at(at, &["into"]) {
        at = m.skip_ws(e);
    }
    let Some((us, _)) = m.find_top(&["using"], at) else {
        return unparsed(p);
    };
    match parse_obj_ref(kind, m.cut(at, us)) {
        Some(t) => p.capture = CapturePlan::WholeTables { tables: vec![t] },
        None => unparsed(p),
    }
}

fn analyze_truncate(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.op = Op::Truncate;
    p.write = true;
    p.destructive = true;
    p.has_where = Some(false);
    let head = m.phrase_at(m.skip_ws(0), &["truncate"]).unwrap_or(0);
    let mut from = m.skip_ws(head);
    if let Some(e) = m.phrase_at(from, &["table"]) {
        from = m.skip_ws(e);
    }
    if let Some(e) = m.phrase_at(from, &["only"]) {
        from = m.skip_ws(e);
    }
    let to = m
        .find_top_first(
            &[&["restart"], &["continue"], &["cascade"], &["restrict"], &["drop"], &["reuse"], &["with"]],
            from,
        )
        .map(|(s, _, _)| s)
        .unwrap_or(m.len());
    let mut tables = Vec::new();
    for (a, b) in m.split_top(from, to, b',') {
        match parse_obj_ref(kind, &m.src[a..b]) {
            Some(t) => tables.push(t),
            None => return unparsed(p),
        }
    }
    if tables.is_empty() {
        return unparsed(p);
    }
    // PG 的 TRUNCATE … CASCADE 會連帶清空參照它的表——那些表不在前像範圍內。
    if m.find_top(&["cascade"], from).is_some() {
        p.issues.push(Issue::MultiTarget);
    }
    p.capture = CapturePlan::WholeTables { tables };
}

fn analyze_load(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.op = Op::Load;
    let kw = m.first_word();
    if kw == "copy" {
        // COPY t TO … / COPY (query) TO … 是匯出。
        if m.find_top(&["from"], 0).is_none() {
            p.op = Op::Read;
            return;
        }
        p.write = true;
        let head = m.phrase_at(m.skip_ws(0), &["copy"]).unwrap_or(0);
        let start = m.skip_ws(head);
        let end = (start..m.len()).find(|&i| m.mask[i].is_ascii_whitespace() || m.mask[i] == b'(').unwrap_or(m.len());
        match parse_obj_ref(kind, m.cut(start, end)) {
            Some(t) => p.capture = CapturePlan::WholeTables { tables: vec![t] },
            None => unparsed(p),
        }
        return;
    }
    p.write = true;
    // MySQL `LOAD DATA [LOCAL] INFILE '…' [REPLACE|IGNORE] INTO TABLE t …`
    let Some((_, e)) = m.find_top(&["into", "table"], 0) else {
        return unparsed(p);
    };
    let start = m.skip_ws(e);
    let end = (start..m.len()).find(|&i| m.mask[i].is_ascii_whitespace() || m.mask[i] == b'(').unwrap_or(m.len());
    match parse_obj_ref(kind, m.cut(start, end)) {
        Some(t) => p.capture = CapturePlan::WholeTables { tables: vec![t] },
        None => unparsed(p),
    }
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/// 物件名稱：從 `at` 起吃到空白 / `(` 為止（`CREATE TABLE t(...)` 的名稱緊貼括號）。
fn object_name_at(m: &Masked, at: usize) -> (usize, usize) {
    let s = m.skip_ws(at);
    let mut e = s;
    while e < m.len() && !m.mask[e].is_ascii_whitespace() && m.mask[e] != b'(' && m.mask[e] != b',' {
        e += 1;
    }
    (s, e)
}

fn skip_if_exists(m: &Masked, at: usize, not: bool) -> usize {
    let at = m.skip_ws(at);
    let words: &[&str] = if not { &["if", "not", "exists"] } else { &["if", "exists"] };
    m.phrase_at(at, words).map(|e| m.skip_ws(e)).unwrap_or(at)
}

fn analyze_drop(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.write = true;
    p.destructive = true;
    let head = m.phrase_at(m.skip_ws(0), &["drop"]).unwrap_or(0);
    let Some((ws, we)) = m.word_after(head) else {
        return unparsed(p);
    };
    let what = m.src[ws..we].to_ascii_lowercase();
    match what.as_str() {
        "table" => {
            p.op = Op::DropTable;
            let from = skip_if_exists(m, we, false);
            let to = m.find_top_first(&[&["cascade"], &["restrict"], &["purge"]], from).map(|(s, _, _)| s).unwrap_or(m.len());
            let mut objs = Vec::new();
            for (a, b) in m.split_top(from, to, b',') {
                match parse_obj_ref(kind, &m.src[a..b]) {
                    Some(t) => objs.push(t),
                    None => return unparsed(p),
                }
            }
            if objs.is_empty() {
                return unparsed(p);
            }
            p.capture = CapturePlan::Schema { scope: SchemaScope::Tables { objs: objs.clone() }, data: objs };
        }
        "view" | "materialized" => {
            p.op = Op::DropView;
            let mut from = we;
            if what == "materialized" {
                from = m.phrase_at(m.skip_ws(we), &["view"]).unwrap_or(we);
            }
            let from = skip_if_exists(m, from, false);
            let to = m.find_top_first(&[&["cascade"], &["restrict"]], from).map(|(s, _, _)| s).unwrap_or(m.len());
            let objs: Option<Vec<ObjRef>> = m.split_top(from, to, b',').into_iter().map(|(a, b)| parse_obj_ref(kind, &m.src[a..b])).collect();
            match objs {
                Some(objs) if !objs.is_empty() => p.capture = CapturePlan::Schema { scope: SchemaScope::Views { objs }, data: vec![] },
                _ => unparsed(p),
            }
        }
        "index" => {
            p.op = Op::DropIndex;
            p.destructive = false;
            let mut from = m.skip_ws(we);
            if let Some(e) = m.phrase_at(from, &["concurrently"]) {
                from = e;
            }
            let from = skip_if_exists(m, from, false);
            let (ns, ne) = object_name_at(m, from);
            // MySQL / MSSQL：`DROP INDEX ix ON t`；MSSQL 舊寫法 `DROP INDEX t.ix`。
            if let Some((_, oe)) = m.find_top(&["on"], ne) {
                let (ts, te) = object_name_at(m, oe);
                match parse_obj_ref(kind, m.cut(ts, te)) {
                    Some(t) => p.capture = CapturePlan::Schema { scope: SchemaScope::Tables { objs: vec![t] }, data: vec![] },
                    None => unparsed(p),
                }
            } else if ne > ns {
                let db = parse_obj_ref(kind, m.cut(ns, ne)).and_then(|o| o.db);
                // PG 的 `schema.ix` 的 schema 就是表所在的 schema。
                p.capture = CapturePlan::Schema { scope: SchemaScope::AllTables { db: if kind == DbKind::Postgres { db } else { None } }, data: vec![] };
            } else {
                unparsed(p);
            }
        }
        "procedure" | "function" | "trigger" | "proc" => {
            p.op = Op::DropRoutine;
            p.destructive = false;
            let from = skip_if_exists(m, we, false);
            let (ns, ne) = object_name_at(m, from);
            match parse_obj_ref(kind, m.cut(ns, ne)) {
                Some(o) => p.capture = CapturePlan::Schema { scope: SchemaScope::Routines { objs: vec![o] }, data: vec![] },
                None => unparsed(p),
            }
        }
        "database" | "schema" => {
            p.op = Op::DropDatabase;
            p.issues.push(Issue::WholeDatabase);
            p.capture = CapturePlan::Unsupported;
        }
        "temporary" => {
            p.op = Op::Session;
            p.issues.push(Issue::SessionState);
        }
        _ => {
            p.op = Op::Other;
            p.issues.push(Issue::ManualRollback);
        }
    }
}

fn analyze_create(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.write = true;
    let head = m.phrase_at(m.skip_ws(0), &["create"]).unwrap_or(0);
    let mut at = skip_modifiers(m, head, &["unique", "clustered", "nonclustered", "unlogged", "materialized", "global", "local"]);
    // MySQL 的 DEFINER = `u`@`h`。
    if let Some(e) = m.phrase_at(at, &["definer"]) {
        let mut j = m.skip_ws(e);
        while j < m.len() && !m.mask[j].is_ascii_whitespace() {
            j += 1;
        }
        // `DEFINER = x` 中間可能有空白。
        if m.mask.get(m.skip_ws(e)) == Some(&b'=') {
            let vs = m.skip_ws(m.skip_ws(e) + 1);
            j = vs;
            while j < m.len() && !m.mask[j].is_ascii_whitespace() {
                j += 1;
            }
        }
        at = m.skip_ws(j);
    }
    if m.phrase_at(at, &["temporary"]).is_some() || m.phrase_at(at, &["temp"]).is_some() {
        p.op = Op::Session;
        p.issues.push(Issue::SessionState);
        return;
    }
    let Some((ws, we)) = m.word_after(at) else {
        return unparsed(p);
    };
    let what = m.src[ws..we].to_ascii_lowercase();
    match what.as_str() {
        "table" => {
            p.op = Op::CreateTable;
            let from = skip_if_exists(m, we, true);
            let (ns, ne) = object_name_at(m, from);
            match parse_obj_ref(kind, m.cut(ns, ne)) {
                Some(o) => p.capture = CapturePlan::Schema { scope: SchemaScope::Tables { objs: vec![o] }, data: vec![] },
                None => unparsed(p),
            }
            // T-SQL 的 #temp 表。
            if m.cut(ns, ne).starts_with('#') {
                p.op = Op::Session;
                p.capture = CapturePlan::None;
                p.issues.retain(|i| *i != Issue::Unparsed);
                p.issues.push(Issue::SessionState);
            }
        }
        "index" => {
            p.op = Op::CreateIndex;
            let mut from = m.skip_ws(we);
            if let Some(e) = m.phrase_at(from, &["concurrently"]) {
                from = e;
            }
            let from = skip_if_exists(m, from, true);
            let Some((_, oe)) = m.find_top(&["on"], from) else {
                return unparsed(p);
            };
            let mut ts = m.skip_ws(oe);
            if let Some(e) = m.phrase_at(ts, &["only"]) {
                ts = m.skip_ws(e);
            }
            let (ts, te) = object_name_at(m, ts);
            match parse_obj_ref(kind, m.cut(ts, te)) {
                Some(t) => p.capture = CapturePlan::Schema { scope: SchemaScope::Tables { objs: vec![t] }, data: vec![] },
                None => unparsed(p),
            }
        }
        "view" => {
            p.op = Op::CreateView;
            let from = skip_if_exists(m, we, true);
            let (ns, ne) = object_name_at(m, from);
            match parse_obj_ref(kind, m.cut(ns, ne)) {
                Some(o) => p.capture = CapturePlan::Schema { scope: SchemaScope::Views { objs: vec![o] }, data: vec![] },
                None => unparsed(p),
            }
        }
        "procedure" | "function" | "trigger" | "proc" | "package" | "event" | "type" if kind != DbKind::Postgres => {
            p.op = Op::CreateRoutine;
            p.issues.push(Issue::RoutineBody);
        }
        "procedure" | "function" | "trigger" => {
            p.op = Op::CreateRoutine;
            let from = skip_if_exists(m, we, true);
            let (ns, ne) = object_name_at(m, from);
            match parse_obj_ref(kind, m.cut(ns, ne)) {
                Some(o) => p.capture = CapturePlan::Schema { scope: SchemaScope::Routines { objs: vec![o] }, data: vec![] },
                None => unparsed(p),
            }
        }
        _ => {
            // CREATE DATABASE / SCHEMA / USER / ROLE / SEQUENCE / EXTENSION …
            p.op = Op::Other;
            p.issues.push(Issue::ManualRollback);
        }
    }
}

fn analyze_alter(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.write = true;
    let head = m.phrase_at(m.skip_ws(0), &["alter"]).unwrap_or(0);
    let Some((ws, we)) = m.word_after(head) else {
        return unparsed(p);
    };
    let what = m.src[ws..we].to_ascii_lowercase();
    match what.as_str() {
        "table" => {
            p.op = Op::AlterTable;
            let mut from = skip_if_exists(m, we, false);
            if let Some(e) = m.phrase_at(from, &["only"]) {
                from = m.skip_ws(e);
            }
            let (ns, ne) = object_name_at(m, from);
            let Some(table) = parse_obj_ref(kind, m.cut(ns, ne)) else {
                return unparsed(p);
            };
            // RENAME：結構前後像的 diff 會把改名看成「刪一個、加一個」，產出的回滾會丟資料。
            if let Some((_, re)) = m.find_top(&["rename"], ne) {
                return analyze_alter_rename(kind, m, p, &table, re);
            }
            if kind == DbKind::Mysql || kind == DbKind::Mariadb {
                if m.find_top(&["change"], ne).is_some() {
                    // CHANGE old new …：同時改名與改型別。
                    p.destructive = true;
                    p.issues.push(Issue::ManualRollback);
                    p.capture = CapturePlan::Schema { scope: SchemaScope::Tables { objs: vec![table.clone()] }, data: vec![table] };
                    return;
                }
            }
            let destructive = m.find_top(&["drop"], ne).is_some()
                || m.find_top(&["modify"], ne).is_some()
                || m.find_top(&["type"], ne).is_some()
                || m.find_top(&["alter", "column"], ne).is_some() && kind == DbKind::Mssql;
            p.destructive = destructive;
            let data = if destructive { vec![table.clone()] } else { vec![] };
            p.capture = CapturePlan::Schema { scope: SchemaScope::Tables { objs: vec![table] }, data };
        }
        "view" => {
            p.op = Op::CreateView;
            let (ns, ne) = object_name_at(m, we);
            match parse_obj_ref(kind, m.cut(ns, ne)) {
                Some(o) => p.capture = CapturePlan::Schema { scope: SchemaScope::Views { objs: vec![o] }, data: vec![] },
                None => unparsed(p),
            }
        }
        "procedure" | "function" | "trigger" | "proc" | "package" if kind != DbKind::Postgres => {
            p.op = Op::CreateRoutine;
            p.issues.push(Issue::RoutineBody);
        }
        "database" | "schema" | "session" | "system" => {
            p.op = Op::Session;
            p.issues.push(Issue::ManualRollback);
        }
        _ => {
            p.op = Op::Other;
            p.issues.push(Issue::ManualRollback);
        }
    }
}

/// `ALTER TABLE t RENAME TO n` / `RENAME COLUMN a TO b`：反向語句直接由文字組出。
fn analyze_alter_rename(kind: DbKind, m: &Masked, p: &mut StatementPlan, table: &ObjRef, re: usize) {
    p.op = Op::RenameTable;
    let at = m.skip_ws(re);
    // RENAME COLUMN a TO b
    if let Some(ce) = m.phrase_at(at, &["column"]) {
        let (as_, ae) = object_name_at(m, ce);
        if let Some((_, te)) = m.find_top(&["to"], ae) {
            let (bs, be) = object_name_at(m, te);
            let (old, new) = (m.cut(as_, ae), m.cut(bs, be));
            if !old.is_empty() && !new.is_empty() && m.is_blank(be, m.len()) {
                p.capture = CapturePlan::Rename {
                    inverse: format!("ALTER TABLE {} RENAME COLUMN {new} TO {old}", table.text),
                };
                return;
            }
        }
    }
    // RENAME TO n（MySQL 也收 RENAME AS n / RENAME n）
    let mut to_at = at;
    if let Some(e) = m.phrase_at(at, &["to"]).or_else(|| m.phrase_at(at, &["as"])) {
        to_at = e;
    }
    let (ns, ne) = object_name_at(m, to_at);
    let new_name = m.cut(ns, ne);
    if !new_name.is_empty() && m.is_blank(ne, m.len()) && kind != DbKind::Mssql {
        // 新名稱不帶 schema 時，反向語句要把 schema 加回來才找得到表。
        let new_ref = match (parse_obj_ref(kind, new_name), &table.db) {
            (Some(n), Some(_)) if n.db.is_none() => {
                let qualifier = table.text.rsplit_once('.').map(|(q, _)| q).unwrap_or("");
                if qualifier.is_empty() || kind == DbKind::Postgres || kind == DbKind::Oracle {
                    // PG / Oracle 的 RENAME TO 不接受 schema 前綴，新表留在原 schema。
                    format!("{qualifier}{}{new_name}", if qualifier.is_empty() { "" } else { "." })
                } else {
                    format!("{qualifier}.{new_name}")
                }
            }
            _ => new_name.to_string(),
        };
        let old_bare = table.text.rsplit_once('.').map(|(_, n)| n).unwrap_or(&table.text);
        let old_for_to = if kind == DbKind::Postgres || kind == DbKind::Oracle || kind == DbKind::Sqlite {
            old_bare.to_string()
        } else {
            table.text.clone()
        };
        p.capture = CapturePlan::Rename { inverse: format!("ALTER TABLE {new_ref} RENAME TO {old_for_to}") };
        return;
    }
    p.issues.push(Issue::ManualRollback);
    p.capture = CapturePlan::Unsupported;
}

/// MySQL `RENAME TABLE a TO b [, c TO d]`。
fn analyze_rename_table(kind: DbKind, m: &Masked, p: &mut StatementPlan) {
    p.op = Op::RenameTable;
    p.write = true;
    let head = m.phrase_at(m.skip_ws(0), &["rename"]).unwrap_or(0);
    let Some(te) = m.phrase_at(m.skip_ws(head), &["table"]) else {
        return unparsed(p);
    };
    let mut inverses = Vec::new();
    for (a, b) in m.split_top(te, m.len(), b',') {
        let pair = &m.src[a..b];
        let pm = Masked::new(kind, pair);
        let Some((ts, tend)) = pm.find_top(&["to"], 0) else {
            return unparsed(p);
        };
        let (old, new) = (pm.cut(0, ts), pm.cut(tend, pair.len()));
        if old.is_empty() || new.is_empty() {
            return unparsed(p);
        }
        inverses.push(format!("{new} TO {old}"));
    }
    inverses.reverse();
    p.capture = CapturePlan::Rename { inverse: format!("RENAME TABLE {}", inverses.join(", ")) };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(kind: DbKind, sql: &str) -> StatementPlan {
        analyze_statement(kind, sql)
    }

    fn rows(p: &StatementPlan) -> (&ObjRef, &str, Option<&str>, Option<&Vec<String>>, bool) {
        match &p.capture {
            CapturePlan::Rows { table, source, predicate, set_columns, fanout } => {
                (table, source.as_str(), predicate.as_deref(), set_columns.as_ref(), *fanout)
            }
            other => panic!("預期 Rows，得到 {other:?}"),
        }
    }

    #[test]
    fn update_basic_and_modifiers() {
        let p = a(DbKind::Mysql, "UPDATE LOW_PRIORITY `shop`.`orders` o SET o.status = 'x', total = total + 1 WHERE o.id > 10 ORDER BY id LIMIT 5");
        assert_eq!(p.op, Op::Update);
        assert_eq!(p.has_where, Some(true));
        assert!(!p.destructive);
        let (t, src, pred, set, fan) = rows(&p);
        assert_eq!((t.db.as_deref(), t.name.as_str(), t.alias.as_deref()), (Some("shop"), "orders", Some("o")));
        assert_eq!(src, "`shop`.`orders` o");
        assert_eq!(pred, Some("o.id > 10"));
        assert_eq!(set.unwrap(), &vec!["status".to_string(), "total".to_string()]);
        assert!(!fan);
    }

    #[test]
    fn update_without_where_is_destructive() {
        let p = a(DbKind::Postgres, "UPDATE t SET a = (SELECT max(x) FROM y WHERE z = 1)");
        assert_eq!(p.has_where, Some(false));
        assert!(p.destructive);
        assert_eq!(rows(&p).2, None);
    }

    #[test]
    fn update_from_forms() {
        // PG：目標表 + FROM 其他來源 → fan-out。
        let p = a(DbKind::Postgres, "UPDATE orders SET paid = true FROM payments p WHERE p.order_id = orders.id RETURNING *");
        let (t, src, pred, _, fan) = rows(&p);
        assert_eq!(t.name, "orders");
        assert_eq!(src, "orders, payments p");
        assert_eq!(pred, Some("p.order_id = orders.id"));
        assert!(fan);
        // T-SQL：SET 前是別名，FROM 本身含目標表。
        let p = a(DbKind::Mssql, "UPDATE TOP (10) o SET o.Status = N'x' OUTPUT inserted.Id FROM dbo.Orders o JOIN dbo.Cust c ON c.Id = o.CustId WHERE c.Vip = 1");
        let (t, src, pred, set, _) = rows(&p);
        assert_eq!((t.name.as_str(), t.alias.as_deref()), ("Orders", Some("o")));
        assert_eq!(src, "dbo.Orders o JOIN dbo.Cust c ON c.Id = o.CustId");
        assert_eq!(pred, Some("c.Vip = 1"));
        assert_eq!(set.unwrap(), &vec!["Status".to_string()]);
    }

    #[test]
    fn mysql_multi_table_update() {
        let p = a(DbKind::Mysql, "UPDATE orders o JOIN users u ON u.id = o.uid SET o.flag = 1 WHERE u.vip = 1");
        let (t, src, _, _, fan) = rows(&p);
        assert_eq!((t.name.as_str(), t.alias.as_deref()), ("orders", Some("o")));
        assert_eq!(src, "orders o JOIN users u ON u.id = o.uid");
        assert!(fan);
        let p = a(DbKind::Mysql, "UPDATE orders o JOIN users u ON u.id = o.uid SET o.flag = 1, u.flag = 2");
        assert!(p.issues.contains(&Issue::MultiTarget));
    }

    #[test]
    fn delete_shapes() {
        let p = a(DbKind::Mysql, "DELETE FROM logs WHERE created_at < '2024-01-01' LIMIT 1000");
        let (t, src, pred, _, fan) = rows(&p);
        assert_eq!((t.name.as_str(), src, pred, fan), ("logs", "logs", Some("created_at < '2024-01-01'"), false));

        let p = a(DbKind::Mysql, "DELETE o FROM orders o JOIN users u ON u.id = o.uid WHERE u.gone = 1");
        let (t, src, _, _, fan) = rows(&p);
        assert_eq!((t.name.as_str(), t.alias.as_deref(), src, fan), ("orders", Some("o"), "orders o JOIN users u ON u.id = o.uid", true));

        let p = a(DbKind::Postgres, "DELETE FROM ONLY orders o USING users u WHERE u.id = o.uid RETURNING o.id");
        let (t, src, pred, _, fan) = rows(&p);
        assert_eq!((t.name.as_str(), src, pred, fan), ("orders", "ONLY orders o, users u", Some("u.id = o.uid"), true));

        let p = a(DbKind::Mssql, "DELETE FROM o FROM dbo.Orders o JOIN dbo.C c ON c.Id = o.CId WHERE c.X = 1");
        let (t, _, _, _, _) = rows(&p);
        assert_eq!(t.name, "Orders");

        let p = a(DbKind::Oracle, "DELETE hr.emp e WHERE e.dept = 10");
        let (t, _, pred, _, _) = rows(&p);
        assert_eq!((t.db.as_deref(), t.name.as_str(), pred), (Some("HR"), "EMP", Some("e.dept = 10")));

        let p = a(DbKind::Mysql, "DELETE a, b FROM a JOIN b ON a.id = b.id");
        assert!(p.issues.contains(&Issue::MultiTarget));
        assert!(p.destructive);

        let p = a(DbKind::Mysql, "DELETE FROM t WHERE CURRENT OF c");
        assert!(p.issues.contains(&Issue::Unparsed));
    }

    #[test]
    fn insert_shapes() {
        let p = a(DbKind::Mysql, "INSERT INTO shop.users (id, name) VALUES (1, 'a'), (2, 'b;c')");
        match &p.capture {
            CapturePlan::Insert { table, columns, rows, upsert } => {
                assert_eq!(table.name, "users");
                assert_eq!(columns.as_ref().unwrap(), &vec!["id".to_string(), "name".to_string()]);
                assert_eq!(rows.as_ref().unwrap(), &vec![vec!["1".to_string(), "'a'".to_string()], vec!["2".to_string(), "'b;c'".to_string()]]);
                assert!(!upsert);
            }
            other => panic!("{other:?}"),
        }
        let p = a(DbKind::Postgres, "INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = excluded.n RETURNING id");
        assert!(matches!(&p.capture, CapturePlan::Insert { upsert: true, rows: Some(r), .. } if r.len() == 1));
        let p = a(DbKind::Mysql, "INSERT INTO t SET id = 5, name = 'x'");
        assert!(matches!(&p.capture, CapturePlan::Insert { columns: Some(c), rows: Some(r), .. } if c.len() == 2 && r[0][0] == "5"));
        let p = a(DbKind::Mysql, "REPLACE INTO t (id) VALUES (1)");
        assert_eq!(p.op, Op::Replace);
        assert!(p.destructive);
        let p = a(DbKind::Postgres, "INSERT INTO archive SELECT * FROM orders WHERE old");
        assert!(matches!(&p.capture, CapturePlan::Insert { rows: None, columns: None, .. }));
        let p = a(DbKind::Mssql, "INSERT INTO dbo.T (A) OUTPUT inserted.Id VALUES (1)");
        assert!(matches!(&p.capture, CapturePlan::Insert { rows: Some(_), .. }));
    }

    #[test]
    fn ddl_shapes() {
        let p = a(DbKind::Mysql, "DROP TABLE IF EXISTS a, shop.b");
        match &p.capture {
            CapturePlan::Schema { scope: SchemaScope::Tables { objs }, data } => {
                assert_eq!(objs.len(), 2);
                assert_eq!(data.len(), 2);
            }
            other => panic!("{other:?}"),
        }
        let p = a(DbKind::Postgres, "ALTER TABLE orders ADD COLUMN note text");
        assert!(matches!(&p.capture, CapturePlan::Schema { data, .. } if data.is_empty()));
        assert!(!p.destructive);
        let p = a(DbKind::Postgres, "ALTER TABLE orders DROP COLUMN note");
        assert!(matches!(&p.capture, CapturePlan::Schema { data, .. } if data.len() == 1));
        assert!(p.destructive);
        let p = a(DbKind::Postgres, "ALTER TABLE orders ALTER COLUMN n TYPE bigint");
        assert!(p.destructive);
        let p = a(DbKind::Mysql, "CREATE UNIQUE INDEX ix ON shop.orders (a, b)");
        assert!(matches!(&p.capture, CapturePlan::Schema { scope: SchemaScope::Tables { objs }, .. } if objs[0].name == "orders"));
        let p = a(DbKind::Postgres, "DROP INDEX CONCURRENTLY IF EXISTS public.ix_a");
        assert!(matches!(&p.capture, CapturePlan::Schema { scope: SchemaScope::AllTables { db: Some(d) }, .. } if d == "public"));
        let p = a(DbKind::Mssql, "DROP INDEX IX_A ON dbo.Orders");
        assert!(matches!(&p.capture, CapturePlan::Schema { scope: SchemaScope::Tables { objs }, .. } if objs[0].name == "Orders"));
        let p = a(DbKind::Postgres, "CREATE OR REPLACE VIEW v AS SELECT 1");
        assert!(matches!(&p.capture, CapturePlan::Schema { scope: SchemaScope::Views { .. }, .. }));
        let p = a(DbKind::Mysql, "CREATE PROCEDURE p() BEGIN SELECT 1");
        assert!(p.issues.contains(&Issue::RoutineBody));
        let p = a(DbKind::Postgres, "CREATE OR REPLACE FUNCTION f(a int) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql");
        assert!(matches!(&p.capture, CapturePlan::Schema { scope: SchemaScope::Routines { objs }, .. } if objs[0].name == "f"));
        let p = a(DbKind::Mysql, "CREATE TABLE t2 (id int primary key)");
        assert!(matches!(&p.capture, CapturePlan::Schema { scope: SchemaScope::Tables { objs }, .. } if objs[0].name == "t2"));
        let p = a(DbKind::Mysql, "CREATE TEMPORARY TABLE x (id int)");
        assert!(p.issues.contains(&Issue::SessionState));
        let p = a(DbKind::Mysql, "DROP DATABASE shop");
        assert!(p.issues.contains(&Issue::WholeDatabase));
    }

    #[test]
    fn renames_produce_textual_inverse() {
        let inv = |p: &StatementPlan| match &p.capture {
            CapturePlan::Rename { inverse } => inverse.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(inv(&a(DbKind::Postgres, "ALTER TABLE public.a RENAME TO b")), "ALTER TABLE public.b RENAME TO a");
        assert_eq!(inv(&a(DbKind::Mysql, "ALTER TABLE shop.a RENAME TO b")), "ALTER TABLE shop.b RENAME TO shop.a");
        assert_eq!(inv(&a(DbKind::Postgres, "ALTER TABLE t RENAME COLUMN x TO y")), "ALTER TABLE t RENAME COLUMN y TO x");
        assert_eq!(inv(&a(DbKind::Mysql, "RENAME TABLE a TO b, c TO d")), "RENAME TABLE d TO c, b TO a");
    }

    #[test]
    fn blockers_and_warnings() {
        for (sql, issue) in [
            ("BEGIN", Issue::TxControl),
            ("START TRANSACTION", Issue::TxControl),
            ("COMMIT", Issue::TxControl),
            ("SET FOREIGN_KEY_CHECKS = 0", Issue::SessionState),
            ("USE other", Issue::SessionState),
            ("LOCK TABLES t WRITE", Issue::SessionState),
            ("CALL p(1)", Issue::ProcedureCall),
            ("GRANT SELECT ON t TO u", Issue::ManualRollback),
            ("WITH d AS (DELETE FROM t RETURNING *) INSERT INTO a SELECT * FROM d", Issue::WritingCte),
            ("UPDATE t SET a = :val WHERE id = 1", Issue::UnresolvedParams),
        ] {
            let p = a(DbKind::Postgres, sql);
            assert!(p.issues.contains(&issue), "{sql} → {:?}", p.issues);
        }
        // PG 的 ::type 轉型、字串裡的 :x 不算具名參數。
        assert!(!a(DbKind::Postgres, "UPDATE t SET a = '1'::int, b = ':x' WHERE id = 1").issues.contains(&Issue::UnresolvedParams));
        assert!(a(DbKind::Mysql, "SELECT 1").issues.is_empty());
        assert!(!a(DbKind::Mysql, "SELECT 1").write);
    }

    #[test]
    fn script_plan_indexes_and_blockers() {
        let plan = analyze_script(DbKind::Mysql, "shop", "UPDATE t SET a=1 WHERE id=1; COMMIT; SELECT 1");
        assert_eq!(plan.statements.len(), 3);
        assert_eq!(plan.statements[2].index, 2);
        assert_eq!(plan.blockers(), vec![(1, Issue::TxControl)]);
    }

    #[test]
    fn rollback_scripts_can_be_reviewed_again() {
        // 回滾腳本檔頭的 SET：與連線既有設定相同 → 不擋。
        for (kind, sql) in [
            (DbKind::Mysql, "SET time_zone = '+00:00'"),
            (DbKind::Mysql, "set  NAMES utf8mb4"),
            (DbKind::Postgres, "SET DateStyle = 'ISO, MDY'"),
            (DbKind::Postgres, "SET standard_conforming_strings = on"),
        ] {
            let p = a(kind, sql);
            assert!(p.issues.is_empty() && !p.write, "{sql} → {:?}", p.issues);
        }
        assert!(a(DbKind::Mysql, "SET time_zone = '+08:00'").issues.contains(&Issue::SessionState));
        assert!(a(DbKind::Mysql, "SET FOREIGN_KEY_CHECKS = 0").issues.contains(&Issue::SessionState));
        // SQL Server 的 identity 批次 → 一句多列 INSERT（值內含換行與 INSERT 字樣也不切錯）。
        let batch = "SET IDENTITY_INSERT [db].[dbo].[t] ON\nINSERT INTO [db].[dbo].[t] ([id], [v]) VALUES (7, N'a\nINSERT INTO x')\nINSERT INTO [db].[dbo].[t] ([id], [v]) VALUES (8, NULL)\nSET IDENTITY_INSERT [db].[dbo].[t] OFF";
        let p = a(DbKind::Mssql, batch);
        assert!(p.issues.is_empty(), "{:?}", p.issues);
        match &p.capture {
            CapturePlan::Insert { table, columns, rows: Some(rows), upsert: false } => {
                assert_eq!((table.db.as_deref(), table.name.as_str()), (Some("db"), "t"));
                assert_eq!(columns.as_ref().unwrap(), &vec!["id".to_string(), "v".to_string()]);
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[0][0], "7");
            }
            other => panic!("{other:?}"),
        }
        assert!(a(DbKind::Mssql, "SET IDENTITY_INSERT t ON").issues.contains(&Issue::Unparsed));
    }

    #[test]
    fn truncate_and_merge() {
        let p = a(DbKind::Postgres, "TRUNCATE TABLE a, b RESTART IDENTITY");
        assert!(matches!(&p.capture, CapturePlan::WholeTables { tables } if tables.len() == 2));
        let p = a(DbKind::Mssql, "MERGE INTO dbo.T AS t USING dbo.S AS s ON t.Id = s.Id WHEN MATCHED THEN UPDATE SET t.A = s.A");
        assert!(matches!(&p.capture, CapturePlan::WholeTables { tables } if tables[0].name == "T"));
        let p = a(DbKind::Postgres, "COPY t TO STDOUT");
        assert_eq!(p.op, Op::Read);
    }
}
