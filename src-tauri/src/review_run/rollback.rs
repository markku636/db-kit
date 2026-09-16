//! 回滾腳本：前後像比對（純函式）與反向語句產生。
//!
//! 兩種來源：
//! - **執行後（精確）**：前像 vs 後像依鍵比對 → 只還原真的變了的列與欄。
//! - **執行前（預估）**：只有前像（「只產生備份」模式、或執行中途斷線拿不到後像）→ 假設前像裡的
//!   列全部被改 / 被刪，保守地整列還原。
//!
//! 同一句的反向語句順序固定為 DELETE（移除新增的列）→ UPDATE → INSERT（補回刪掉的列）：
//! 先騰出唯一鍵，再寫回舊值，才不會撞到次要唯一索引。跨語句則由呼叫端以「最後一句先還原」排列。
//!
//! 任何「不確定能安全還原」的語句都不會以可執行形式出現——改為註解並寫明原因，讓人決定要不要打開。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::capture::{TableMeta, TableSnapshot};
use super::codec::{self, ColumnSpec};
use crate::db::sqlgen::quote_ident;
use crate::db::DbKind;

/// 回滾腳本的一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Line {
    Comment { text: String },
    Sql { sql: String },
    /// 以註解形式輸出、需要人工確認的語句。
    Disabled { reason: String, sql: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Fragment {
    /// 對應的語句序號（0-based）。
    pub index: usize,
    pub title: String,
    pub lines: Vec<Line>,
}

impl Fragment {
    pub fn new(index: usize, title: impl Into<String>) -> Fragment {
        Fragment { index, title: title.into(), lines: vec![] }
    }
    pub fn comment(&mut self, text: impl Into<String>) {
        self.lines.push(Line::Comment { text: text.into() });
    }
    pub fn sql(&mut self, sql: impl Into<String>) {
        self.lines.push(Line::Sql { sql: sql.into() });
    }
    pub fn disabled(&mut self, reason: impl Into<String>, sql: impl Into<String>) {
        self.lines.push(Line::Disabled { reason: reason.into(), sql: sql.into() });
    }
    pub fn executable_count(&self) -> usize {
        self.lines.iter().filter(|l| matches!(l, Line::Sql { .. })).count()
    }
    pub fn disabled_count(&self) -> usize {
        self.lines.iter().filter(|l| matches!(l, Line::Disabled { .. })).count()
    }
}

// ---------------------------------------------------------------------------
// 前後像比對
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowChange {
    /// 前像整列（欄位順序同前像 meta）。
    pub before: Vec<Option<String>>,
    /// 後像整列，已對齊到前像欄位順序；後像沒有的欄位（被 DROP COLUMN）為 None 並列入 `dropped`。
    pub after: Vec<Option<String>>,
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDiff {
    pub database: String,
    pub table: String,
    pub columns: Vec<String>,
    /// 與 `columns` 對齊的規格（顯示值用）。
    pub specs: Vec<ColumnSpec>,
    pub key: Vec<String>,
    /// 後像有、前像沒有（對齊到前像欄位順序）。
    pub inserted: Vec<Vec<Option<String>>>,
    /// 前像有、後像沒有。
    pub deleted: Vec<Vec<Option<String>>>,
    pub updated: Vec<RowChange>,
    pub unchanged: usize,
    /// 後像已不存在這些欄位（ALTER … DROP COLUMN）。
    pub dropped_columns: Vec<String>,
    /// 後像多出的欄位（ADD COLUMN）；不列入比對。
    pub added_columns: Vec<String>,
    /// 無鍵：以整列多重集合比對，只分得出增刪，分不出「改了哪列」。
    pub keyless: bool,
    /// 任一側快照被截斷：比對結果不完整。
    pub incomplete: bool,
}

/// 前像 vs 後像。後像的欄位以名稱對齊到前像（ALTER 可能增刪欄位）。
pub fn diff_snapshots(before: &TableSnapshot, after: &TableSnapshot) -> TableDiff {
    let bm = &before.meta;
    let cols: Vec<String> = bm.columns.iter().map(|c| c.name.clone()).collect();
    let after_pos: Vec<Option<usize>> = cols.iter().map(|n| after.meta.columns.iter().position(|c| &c.name == n)).collect();
    let dropped_columns: Vec<String> = if after.missing {
        vec![]
    } else {
        cols.iter().zip(&after_pos).filter(|(_, p)| p.is_none()).map(|(n, _)| n.clone()).collect()
    };
    let added_columns: Vec<String> = after
        .meta
        .columns
        .iter()
        .filter(|c| !cols.contains(&c.name))
        .map(|c| c.name.clone())
        .collect();
    let align = |r: &Vec<Option<String>>| -> Vec<Option<String>> { after_pos.iter().map(|p| p.and_then(|i| r[i].clone())).collect() };
    let after_rows: Vec<Vec<Option<String>>> = after.rows.iter().map(align).collect();

    let mut d = TableDiff {
        database: bm.database.clone(),
        table: bm.table.clone(),
        columns: cols.clone(),
        specs: bm.columns.clone(),
        key: bm.key.clone(),
        inserted: vec![],
        deleted: vec![],
        updated: vec![],
        unchanged: 0,
        dropped_columns: dropped_columns.clone(),
        added_columns,
        keyless: false,
        incomplete: before.truncated || after.truncated,
    };
    let key_idx = bm.key_indexes();
    let key_in_after = key_idx.iter().all(|&i| after_pos[i].is_some()) || after.missing;
    if key_idx.is_empty() || key_idx.len() != bm.key.len() || !key_in_after {
        d.keyless = true;
        // 多重集合：同樣內容的列可以有好幾筆。只比兩側共有的欄位。
        let common: Vec<usize> = (0..cols.len()).filter(|&i| after_pos[i].is_some()).collect();
        let proj = |r: &Vec<Option<String>>| common.iter().map(|&i| r[i].clone()).collect::<Vec<_>>();
        let mut pool: HashMap<Vec<Option<String>>, usize> = HashMap::new();
        for r in &after_rows {
            *pool.entry(proj(r)).or_default() += 1;
        }
        for r in &before.rows {
            match pool.get_mut(&proj(r)) {
                Some(n) if *n > 0 => {
                    *n -= 1;
                    d.unchanged += 1;
                }
                _ => d.deleted.push(r.clone()),
            }
        }
        let mut pool_b: HashMap<Vec<Option<String>>, usize> = HashMap::new();
        for r in &before.rows {
            *pool_b.entry(proj(r)).or_default() += 1;
        }
        for r in &after_rows {
            match pool_b.get_mut(&proj(r)) {
                Some(n) if *n > 0 => *n -= 1,
                _ => d.inserted.push(r.clone()),
            }
        }
        return d;
    }
    let key_of = |r: &Vec<Option<String>>| key_idx.iter().map(|&i| r[i].clone()).collect::<Vec<_>>();
    let mut after_by_key: HashMap<Vec<Option<String>>, usize> = HashMap::new();
    for (i, r) in after_rows.iter().enumerate() {
        after_by_key.insert(key_of(r), i);
    }
    let mut matched = vec![false; after_rows.len()];
    for r in &before.rows {
        match after_by_key.get(&key_of(r)) {
            Some(&ai) => {
                matched[ai] = true;
                let a = &after_rows[ai];
                let changed: Vec<String> = cols
                    .iter()
                    .enumerate()
                    .filter(|(i, n)| dropped_columns.contains(n) || !codec::same_value(r[*i].as_deref(), a[*i].as_deref()))
                    .map(|(_, n)| n.clone())
                    .collect();
                if changed.is_empty() {
                    d.unchanged += 1;
                } else {
                    d.updated.push(RowChange { before: r.clone(), after: a.clone(), changed });
                }
            }
            None => d.deleted.push(r.clone()),
        }
    }
    for (i, r) in after_rows.iter().enumerate() {
        if !matched[i] {
            d.inserted.push(r.clone());
        }
    }
    d
}

// ---------------------------------------------------------------------------
// 語句組裝
// ---------------------------------------------------------------------------

fn value_lits(kind: DbKind, specs: &[&ColumnSpec], vals: &[Option<String>]) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(specs.len());
    for (s, v) in specs.iter().zip(vals) {
        if !codec::restorable(s, v.as_deref()) {
            return Err(tf!("欄位 {col} 的值無法以 SQL 字面值無損還原（型別 {ty}）", col = s.name, ty = s.data_type));
        }
        out.push(codec::literal(kind, s, v.as_deref()));
    }
    Ok(out)
}

fn where_key(kind: DbKind, meta: &TableMeta, row: &[Option<String>]) -> Result<String, String> {
    let idx = meta.key_indexes();
    let specs: Vec<&ColumnSpec> = idx.iter().map(|&i| &meta.columns[i]).collect();
    let vals: Vec<Option<String>> = idx.iter().map(|&i| row[i].clone()).collect();
    let lits = value_lits(kind, &specs, &vals)?;
    Ok(meta
        .key
        .iter()
        .zip(lits)
        .zip(&vals)
        .map(|((k, lit), v)| {
            if v.is_none() {
                format!("{} IS NULL", quote_ident(kind, k))
            } else {
                format!("{} = {lit}", quote_ident(kind, k))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND "))
}

fn insert_sql(kind: DbKind, meta: &TableMeta, row: &[Option<String>]) -> Result<String, String> {
    let idx: Vec<usize> = (0..meta.columns.len()).filter(|&i| meta.columns[i].writable).collect();
    let specs: Vec<&ColumnSpec> = idx.iter().map(|&i| &meta.columns[i]).collect();
    let vals: Vec<Option<String>> = idx.iter().map(|&i| row[i].clone()).collect();
    let lits = value_lits(kind, &specs, &vals)?;
    let cols = specs.iter().map(|s| quote_ident(kind, &s.name)).collect::<Vec<_>>().join(", ");
    // PG 的 GENERATED ALWAYS AS IDENTITY 要明說覆寫，否則伺服器拒收明確值。
    let overriding = if kind == DbKind::Postgres && specs.iter().any(|s| s.identity_always) { " OVERRIDING SYSTEM VALUE" } else { "" };
    Ok(format!("INSERT INTO {} ({cols}){overriding} VALUES ({})", meta.qualified(kind), lits.join(", ")))
}

fn update_sql(kind: DbKind, meta: &TableMeta, row: &[Option<String>], columns: &[String]) -> Result<Option<String>, String> {
    let key = &meta.key;
    let idx: Vec<usize> = columns
        .iter()
        .filter(|c| !key.contains(c))
        .filter_map(|c| meta.columns.iter().position(|s| &s.name == c))
        .filter(|&i| meta.columns[i].writable)
        .collect();
    if idx.is_empty() {
        return Ok(None);
    }
    let specs: Vec<&ColumnSpec> = idx.iter().map(|&i| &meta.columns[i]).collect();
    let vals: Vec<Option<String>> = idx.iter().map(|&i| row[i].clone()).collect();
    let lits = value_lits(kind, &specs, &vals)?;
    let set = specs.iter().zip(lits).map(|(s, l)| format!("{} = {l}", quote_ident(kind, &s.name))).collect::<Vec<_>>().join(", ");
    Ok(Some(format!("UPDATE {} SET {set} WHERE {}", meta.qualified(kind), where_key(kind, meta, row)?)))
}

fn delete_sql(kind: DbKind, meta: &TableMeta, row: &[Option<String>]) -> Result<String, String> {
    Ok(format!("DELETE FROM {} WHERE {}", meta.qualified(kind), where_key(kind, meta, row)?))
}

/// 一組 INSERT；MSSQL 的 identity 欄要包 IDENTITY_INSERT ON / OFF。
fn push_inserts(f: &mut Fragment, kind: DbKind, meta: &TableMeta, rows: &[Vec<Option<String>>], disabled_reason: Option<&str>) {
    if rows.is_empty() {
        return;
    }
    let identity = kind == DbKind::Mssql && meta.columns.iter().any(|c| c.identity && c.writable);
    if kind == DbKind::Oracle && meta.columns.iter().any(|c| c.identity_always) {
        f.comment(t!("此表有 GENERATED ALWAYS 的 identity 欄，Oracle 不接受明確值；以下 INSERT 可能被拒絕，屆時請改用 BY DEFAULT 或手動處理。"));
    }
    // IDENTITY_INSERT 是 session 層級：ON / INSERT / OFF 必須落在同一條連線。db-kit 的查詢分頁逐句
    // 走連線池送出，所以整組輸出成「中間沒有分號」的單一批次（T-SQL 不要求分號），分句器會把它當一句送。
    const BATCH: usize = 500;
    let mut batch: Vec<String> = Vec::new();
    let flush = |f: &mut Fragment, batch: &mut Vec<String>| {
        if batch.is_empty() {
            return;
        }
        let q = meta.qualified(kind);
        f.sql(format!("SET IDENTITY_INSERT {q} ON\n{}\nSET IDENTITY_INSERT {q} OFF", batch.join("\n")));
        batch.clear();
    };
    for r in rows {
        match (insert_sql(kind, meta, r), disabled_reason) {
            (Ok(sql), None) if identity => {
                batch.push(sql);
                if batch.len() >= BATCH {
                    flush(f, &mut batch);
                }
            }
            (Ok(sql), None) => f.sql(sql),
            (Ok(sql), Some(reason)) => f.disabled(reason, sql),
            (Err(reason), _) => f.disabled(reason, t!("（此列的 INSERT 無法產生）")),
        }
    }
    flush(f, &mut batch);
}

/// 語句類型：影響「後像裡找不到前像列」該怎麼解讀。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowOp {
    Update,
    Delete,
    /// INSERT / upsert / MERGE / TRUNCATE / LOAD / DDL 的資料部分：增刪改都可能。
    Any,
}

/// 執行後的精確回滾：把後像還原成前像。
pub fn rollback_from_diff(f: &mut Fragment, kind: DbKind, meta: &TableMeta, diff: &TableDiff, op: RowOp) {
    if diff.incomplete {
        f.comment(t!("警告：前像或後像超過擷取上限而被截斷，以下回滾只涵蓋已擷取到的列。"));
    }
    // 1) 移除新增的列。
    if !diff.inserted.is_empty() {
        if diff.keyless {
            for r in &diff.inserted {
                f.disabled(t!("此表沒有主鍵或唯一鍵，無法精確定位要刪除的列"), format!("-- {}", describe_row(meta, r)));
            }
        } else {
            for r in &diff.inserted {
                match delete_sql(kind, meta, r) {
                    Ok(sql) => f.sql(sql),
                    Err(reason) => f.disabled(reason, t!("（此列的 DELETE 無法產生）")),
                }
            }
        }
    }
    // 2) 寫回舊值。
    for ch in &diff.updated {
        match update_sql(kind, meta, &ch.before, &ch.changed) {
            Ok(Some(sql)) => f.sql(sql),
            Ok(None) => {}
            Err(reason) => f.disabled(reason, t!("（此列的 UPDATE 無法產生）")),
        }
    }
    // 3) 補回刪掉的列。UPDATE 之後「找不到」的列多半是主鍵被改掉（或觸發器刪了它）：
    //    補回舊鍵會和改過鍵的那列並存，不自動執行。
    let reason = match op {
        RowOp::Update => Some(t!("UPDATE 之後依主鍵找不到這列（主鍵可能被改掉，或被觸發器刪除），補回可能造成重複資料")),
        _ => None,
    };
    push_inserts(f, kind, meta, &diff.deleted, reason);
}

/// 執行前的預估回滾（只有前像）。`set_columns`：UPDATE 的 SET 目標欄，None = 整列還原。
pub fn rollback_before_only(f: &mut Fragment, kind: DbKind, snap: &TableSnapshot, op: PreOp<'_>) {
    let meta = &snap.meta;
    if snap.truncated {
        f.comment(tf!(
            "警告：符合的列超過擷取上限，只備份了前 {n} 列；以下回滾不完整。",
            n = snap.rows.len()
        ));
    }
    match op {
        PreOp::Update { set_columns } => {
            if meta.key.is_empty() {
                for r in &snap.rows {
                    f.disabled(t!("此表沒有主鍵或唯一鍵，無法定位要還原的列"), format!("-- {}", describe_row(meta, r)));
                }
                return;
            }
            let all: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
            let cols: Vec<String> = match set_columns {
                Some(sc) if sc.iter().all(|c| all.iter().any(|a| a.eq_ignore_ascii_case(c))) => {
                    all.iter().filter(|a| sc.iter().any(|c| c.eq_ignore_ascii_case(a))).cloned().collect()
                }
                _ => all,
            };
            for r in &snap.rows {
                match update_sql(kind, meta, r, &cols) {
                    Ok(Some(sql)) => f.sql(sql),
                    Ok(None) => {}
                    Err(reason) => f.disabled(reason, t!("（此列的 UPDATE 無法產生）")),
                }
            }
        }
        PreOp::Reinsert => push_inserts(f, kind, meta, &snap.rows, None),
        PreOp::ReplaceTable => {
            f.comment(t!("整表還原：先清空，再寫回備份當下的所有列。"));
            f.sql(format!("DELETE FROM {}", meta.qualified(kind)));
            push_inserts(f, kind, meta, &snap.rows, None);
        }
        PreOp::Keys { keys } => {
            // upsert：備份當下已存在的鍵 → 寫回整列；不存在的鍵 → 刪掉（那是這句新增的）。
            let key_idx = meta.key_indexes();
            let existing: Vec<Vec<String>> = snap
                .rows
                .iter()
                .filter_map(|r| {
                    let specs: Vec<&ColumnSpec> = key_idx.iter().map(|&i| &meta.columns[i]).collect();
                    let vals: Vec<Option<String>> = key_idx.iter().map(|&i| r[i].clone()).collect();
                    value_lits(kind, &specs, &vals).ok()
                })
                .collect();
            for k in keys {
                if existing.iter().any(|e| same_key_literal(e, k)) {
                    continue;
                }
                let cond = meta
                    .key
                    .iter()
                    .zip(k)
                    .map(|(c, lit)| format!("{} = {lit}", quote_ident(kind, c)))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                f.sql(format!("DELETE FROM {} WHERE {cond}", meta.qualified(kind)));
            }
            let all: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
            for r in &snap.rows {
                match update_sql(kind, meta, r, &all) {
                    Ok(Some(sql)) => f.sql(sql),
                    Ok(None) => {}
                    Err(reason) => f.disabled(reason, t!("（此列的 UPDATE 無法產生）")),
                }
            }
        }
    }
}

/// 鍵字面值比較：語句裡寫的 `'5'` 與擷取到的 `5` 視為同一個鍵。
fn same_key_literal(a: &[String], b: &[String]) -> bool {
    let norm = |s: &str| {
        let t = s.trim();
        let t = t.strip_prefix('N').filter(|r| r.starts_with('\'')).unwrap_or(t);
        t.trim_matches('\'').to_string()
    };
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| norm(x) == norm(y))
}

#[derive(Debug, Clone, Copy)]
pub enum PreOp<'a> {
    Update { set_columns: Option<&'a [String]> },
    /// DELETE / TRUNCATE / DROP TABLE：把前像整批 INSERT 回去。
    Reinsert,
    /// MERGE / LOAD / REPLACE：清空再寫回。
    ReplaceTable,
    /// INSERT … VALUES 帶明確鍵（含 upsert）。
    Keys { keys: &'a [Vec<String>] },
}

/// 給註解用的簡短列描述：`id=5, name='x'…`。
pub fn describe_row(meta: &TableMeta, row: &[Option<String>]) -> String {
    let mut parts = Vec::new();
    for (c, v) in meta.columns.iter().zip(row).take(6) {
        let v = match v {
            None => "NULL".to_string(),
            Some(_) => {
                let s: String = codec::display(c, v.as_deref()).chars().take(40).collect();
                format!("'{}'", s.replace('\n', " "))
            }
        };
        parts.push(format!("{}={v}", c.name));
    }
    if meta.columns.len() > 6 {
        parts.push("…".into());
    }
    parts.join(", ")
}

/// 整份回滾腳本。`fragments` 依語句原順序傳入，這裡反過來排（最後一句先還原）。
pub fn render_script(kind: DbKind, header: &[String], fragments: &[Fragment]) -> String {
    let mut out = String::new();
    for h in header {
        for line in h.lines() {
            out.push_str("-- ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push('\n');
    let preamble = codec::script_preamble(kind);
    for p in &preamble {
        out.push_str(p);
        out.push_str(";\n");
    }
    if !preamble.is_empty() {
        out.push('\n');
    }
    for f in fragments.iter().rev() {
        out.push_str("-- ============================================================\n");
        for line in f.title.lines() {
            out.push_str("-- ");
            out.push_str(line);
            out.push('\n');
        }
        out.push_str("-- ============================================================\n");
        if f.lines.is_empty() {
            out.push_str("-- ");
            out.push_str(t!("（這句不需要或無法產生回滾語句）"));
            out.push('\n');
        }
        for l in &f.lines {
            match l {
                Line::Comment { text } => {
                    for t in text.lines() {
                        out.push_str("-- ");
                        out.push_str(t);
                        out.push('\n');
                    }
                }
                Line::Sql { sql } => {
                    out.push_str(sql.trim_end().trim_end_matches(';'));
                    out.push_str(";\n");
                }
                Line::Disabled { reason, sql } => {
                    out.push_str("-- [");
                    out.push_str(t!("需人工確認"));
                    out.push_str("] ");
                    out.push_str(&reason.replace('\n', " "));
                    out.push('\n');
                    for s in sql.trim_end().trim_end_matches(';').lines() {
                        if s.starts_with("--") {
                            out.push_str(s);
                        } else {
                            out.push_str("-- ");
                            out.push_str(s);
                            out.push(';');
                        }
                        out.push('\n');
                    }
                }
            }
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_run::capture::KeyKind;
    use crate::review_run::codec::Codec;

    fn spec(name: &str, codec: Codec) -> ColumnSpec {
        ColumnSpec { name: name.into(), data_type: "x".into(), codec, writable: true, identity: false, identity_always: false }
    }

    fn meta(kind_key: bool) -> TableMeta {
        TableMeta {
            database: "shop".into(),
            table: "t".into(),
            columns: vec![spec("id", Codec::Number), spec("name", Codec::Text), spec("n", Codec::Number)],
            key: if kind_key { vec!["id".into()] } else { vec![] },
            key_kind: if kind_key { KeyKind::Primary } else { KeyKind::None },
        }
    }

    fn row(id: &str, name: Option<&str>, n: &str) -> Vec<Option<String>> {
        vec![Some(id.into()), name.map(String::from), Some(n.into())]
    }

    fn snap(meta: TableMeta, rows: Vec<Vec<Option<String>>>) -> TableSnapshot {
        TableSnapshot { meta, rows, truncated: false, missing: false, method: "t".into(), captured_at_ms: 0 }
    }

    fn sqls(f: &Fragment) -> Vec<String> {
        f.lines
            .iter()
            .filter_map(|l| match l {
                Line::Sql { sql } => Some(sql.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn diff_by_key_classifies_rows() {
        let before = snap(meta(true), vec![row("1", Some("a"), "10"), row("2", Some("b"), "20"), row("3", None, "30")]);
        let after = snap(meta(true), vec![row("1", Some("a"), "10"), row("2", Some("B"), "21"), row("4", Some("d"), "40")]);
        let d = diff_snapshots(&before, &after);
        assert_eq!(d.unchanged, 1);
        assert_eq!(d.updated.len(), 1);
        assert_eq!(d.updated[0].changed, vec!["name".to_string(), "n".to_string()]);
        assert_eq!(d.deleted, vec![row("3", None, "30")]);
        assert_eq!(d.inserted, vec![row("4", Some("d"), "40")]);
        assert!(!d.keyless);

        let mut f = Fragment::new(0, "t");
        rollback_from_diff(&mut f, DbKind::Mysql, &before.meta, &d, RowOp::Any);
        assert_eq!(
            sqls(&f),
            vec![
                "DELETE FROM `shop`.`t` WHERE `id` = 4".to_string(),
                "UPDATE `shop`.`t` SET `name` = 'b', `n` = 20 WHERE `id` = 2".to_string(),
                "INSERT INTO `shop`.`t` (`id`, `name`, `n`) VALUES (3, NULL, 30)".to_string(),
            ]
        );
    }

    #[test]
    fn update_losing_rows_is_not_auto_reinserted() {
        let before = snap(meta(true), vec![row("1", Some("a"), "1")]);
        let after = snap(meta(true), vec![]);
        let d = diff_snapshots(&before, &after);
        let mut f = Fragment::new(0, "t");
        rollback_from_diff(&mut f, DbKind::Mysql, &before.meta, &d, RowOp::Update);
        assert_eq!(f.executable_count(), 0);
        assert_eq!(f.disabled_count(), 1);
    }

    #[test]
    fn keyless_multiset_only_restores_deletions() {
        let before = snap(meta(false), vec![row("1", Some("a"), "1"), row("1", Some("a"), "1"), row("2", Some("b"), "2")]);
        let after = snap(meta(false), vec![row("1", Some("a"), "1"), row("9", Some("z"), "9")]);
        let d = diff_snapshots(&before, &after);
        assert!(d.keyless);
        assert_eq!(d.deleted.len(), 2, "重複列要逐筆計數");
        assert_eq!(d.inserted.len(), 1);
        let mut f = Fragment::new(0, "t");
        rollback_from_diff(&mut f, DbKind::Postgres, &before.meta, &d, RowOp::Any);
        assert_eq!(f.executable_count(), 2);
        assert_eq!(f.disabled_count(), 1);
    }

    #[test]
    fn dropped_columns_are_restored_after_ddl() {
        let before = snap(meta(true), vec![row("1", Some("a"), "5")]);
        let mut am = meta(true);
        am.columns.remove(2);
        let after = snap(am, vec![vec![Some("1".into()), Some("a".into())]]);
        let d = diff_snapshots(&before, &after);
        assert_eq!(d.dropped_columns, vec!["n".to_string()]);
        let mut f = Fragment::new(0, "t");
        rollback_from_diff(&mut f, DbKind::Postgres, &before.meta, &d, RowOp::Any);
        assert_eq!(sqls(&f), vec!["UPDATE \"shop\".\"t\" SET \"n\" = 5 WHERE \"id\" = 1".to_string()]);
    }

    #[test]
    fn unrestorable_values_are_disabled_not_nulled() {
        let mut m = meta(true);
        m.columns[1].codec = Codec::Hex;
        let before = snap(m.clone(), vec![vec![Some("1".into()), Some("0xff… (100 bytes)".into()), Some("1".into())]]);
        let after = snap(m.clone(), vec![]);
        let d = diff_snapshots(&before, &after);
        let mut f = Fragment::new(0, "t");
        rollback_from_diff(&mut f, DbKind::Mysql, &m, &d, RowOp::Delete);
        assert_eq!(f.executable_count(), 0);
        assert_eq!(f.disabled_count(), 1);
    }

    #[test]
    fn identity_and_generated_columns() {
        let mut m = meta(true);
        m.columns[0].identity = true;
        m.columns[2].writable = false;
        let rows = vec![row("7", Some("x"), "99")];
        let mut f = Fragment::new(0, "t");
        rollback_before_only(&mut f, DbKind::Mssql, &snap(m.clone(), rows.clone()), PreOp::Reinsert);
        assert_eq!(
            sqls(&f),
            vec!["SET IDENTITY_INSERT [shop].[dbo].[t] ON\nINSERT INTO [shop].[dbo].[t] ([id], [name]) VALUES (7, N'x')\nSET IDENTITY_INSERT [shop].[dbo].[t] OFF".to_string()]
        );
        // 整組是一句：分句器不可在中間切開。
        let text = render_script(DbKind::Mssql, &[], &[f.clone()]);
        let body: Vec<&str> = crate::review_run::scan::split_statements(DbKind::Mssql, &text).into_iter().map(|(a, b)| &text[a..b]).collect();
        assert!(body.iter().any(|s| s.contains("ON\nINSERT") && s.ends_with("OFF")), "{text}");
        m.columns[0].identity_always = true;
        let mut f = Fragment::new(0, "t");
        rollback_before_only(&mut f, DbKind::Postgres, &snap(m, rows), PreOp::Reinsert);
        assert!(sqls(&f)[0].contains("OVERRIDING SYSTEM VALUE"));
    }

    #[test]
    fn pre_run_update_restores_set_columns_only() {
        let s = snap(meta(true), vec![row("1", Some("a"), "5")]);
        let set = vec!["N".to_string()];
        let mut f = Fragment::new(0, "t");
        rollback_before_only(&mut f, DbKind::Mysql, &s, PreOp::Update { set_columns: Some(&set) });
        assert_eq!(sqls(&f), vec!["UPDATE `shop`.`t` SET `n` = 5 WHERE `id` = 1".to_string()]);
        // SET 目標解析失敗 → 整列（非鍵）還原。
        let mut f = Fragment::new(0, "t");
        rollback_before_only(&mut f, DbKind::Mysql, &s, PreOp::Update { set_columns: None });
        assert_eq!(sqls(&f), vec!["UPDATE `shop`.`t` SET `name` = 'a', `n` = 5 WHERE `id` = 1".to_string()]);
    }

    #[test]
    fn pre_run_upsert_keys() {
        let s = snap(meta(true), vec![row("1", Some("a"), "5")]);
        let keys = vec![vec!["1".to_string()], vec!["'2'".to_string()]];
        let mut f = Fragment::new(0, "t");
        rollback_before_only(&mut f, DbKind::Mysql, &s, PreOp::Keys { keys: &keys });
        assert_eq!(
            sqls(&f),
            vec![
                "DELETE FROM `shop`.`t` WHERE `id` = '2'".to_string(),
                "UPDATE `shop`.`t` SET `name` = 'a', `n` = 5 WHERE `id` = 1".to_string(),
            ]
        );
    }

    #[test]
    fn script_is_reversed_and_disabled_lines_are_commented() {
        let mut a = Fragment::new(0, "#1 first");
        a.sql("UPDATE a SET x = 1 WHERE id = 1");
        let mut b = Fragment::new(1, "#2 second");
        b.disabled("why", "DELETE FROM b WHERE id = 2");
        let text = render_script(DbKind::Postgres, &["hdr".to_string()], &[a, b]);
        let first = text.find("#1 first").unwrap();
        let second = text.find("#2 second").unwrap();
        assert!(second < first, "最後一句要先還原");
        assert!(text.contains("-- DELETE FROM b WHERE id = 2;"));
        assert!(text.contains("SET standard_conforming_strings = on;"));
        assert!(text.contains("UPDATE a SET x = 1 WHERE id = 1;"));
    }
}
