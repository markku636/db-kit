//! 結構差異（純函式）：兩份 `DbSchema` → `SchemaDiff`。
//!
//! 方向固定「讓 dst 變成 src」：`*_added` = 來源有目標無（目標需新增）、`*_removed` = 目標有來源無
//! （目標需刪除），與前端 `sql.ts::diffColumns` 同一慣例。所有輸出依名稱排序，測試 / CLI 可決定性。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::schema::{
    group_fks, normalize_ddl, normalize_default, normalize_text, normalize_type, same_family,
    type_family, DbSchema, ForeignKey, TableSchema,
};
use crate::db::{ColumnInfo, DbKind, IndexInfo};

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiffOptions {
    /// 名稱比對忽略大小寫（MySQL Linux 表名區分、Windows 不區分；跨環境時常用）。
    #[serde(default)]
    pub ignore_case: bool,
    #[serde(default)]
    pub ignore_comments: bool,
    #[serde(default)]
    pub ignore_defaults: bool,
    /// 索引 / 外鍵名稱不同但定義相同時視為「改名」而非新增＋刪除
    /// （SQLite `sqlite_autoindex_*`、Oracle `SYS_C…`、PG 自動命名皆需要）。
    #[serde(default = "yes")]
    pub match_by_content: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self { ignore_case: false, ignore_comments: false, ignore_defaults: false, match_by_content: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnAttr {
    DataType,
    Nullable,
    Default,
    Extra,
    Comment,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnChange {
    pub name: String,
    pub src: ColumnInfo,
    pub dst: ColumnInfo,
    pub attrs: Vec<ColumnAttr>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexChange {
    pub name: String,
    pub src: IndexInfo,
    pub dst: IndexInfo,
    /// 定義相同、只是名稱不同（`match_by_content`）。
    pub renamed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FkChange {
    pub name: String,
    pub src: ForeignKey,
    pub dst: ForeignKey,
    pub renamed: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TableDiff {
    pub name: String,
    pub columns_added: Vec<ColumnInfo>,
    pub columns_removed: Vec<ColumnInfo>,
    pub columns_changed: Vec<ColumnChange>,
    pub indexes_added: Vec<IndexInfo>,
    pub indexes_removed: Vec<IndexInfo>,
    pub indexes_changed: Vec<IndexChange>,
    pub fks_added: Vec<ForeignKey>,
    pub fks_removed: Vec<ForeignKey>,
    pub fks_changed: Vec<FkChange>,
    /// 結構化比對無差異，但正規化後的原始 DDL 仍不同（charset / engine 等）；僅供提示。
    pub ddl_differs: bool,
}

impl TableDiff {
    pub fn is_empty(&self) -> bool {
        self.columns_added.is_empty()
            && self.columns_removed.is_empty()
            && self.columns_changed.is_empty()
            && self.indexes_added.is_empty()
            && self.indexes_removed.is_empty()
            && self.indexes_changed.is_empty()
            && self.fks_added.is_empty()
            && self.fks_removed.is_empty()
            && self.fks_changed.is_empty()
    }
}

/// 視圖 / 程序這類「以定義文字比對」的物件。
#[derive(Debug, Clone, Serialize)]
pub struct TextChange {
    pub name: String,
    /// 程序類型（procedure / function / trigger）；視圖為 None。
    pub routine_type: Option<String>,
    pub src: Option<String>,
    pub dst: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DiffSummary {
    pub tables_added: usize,
    pub tables_removed: usize,
    pub tables_changed: usize,
    pub views_added: usize,
    pub views_removed: usize,
    pub views_changed: usize,
    pub routines_added: usize,
    pub routines_removed: usize,
    pub routines_changed: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaDiff {
    pub src_kind: DbKind,
    pub dst_kind: DbKind,
    pub src_db: String,
    pub dst_db: String,
    /// 兩側引擎不同族：型別差異僅以家族判定，且不可產生同步 DDL。
    pub cross_engine: bool,
    pub tables_added: Vec<String>,
    pub tables_removed: Vec<String>,
    pub tables_changed: Vec<TableDiff>,
    /// 兩邊皆有且結構相同的表（UI 顯示「相同」用）。
    pub tables_identical: Vec<String>,
    pub views_added: Vec<String>,
    pub views_removed: Vec<String>,
    pub views_changed: Vec<TextChange>,
    pub routines_added: Vec<TextChange>,
    pub routines_removed: Vec<TextChange>,
    pub routines_changed: Vec<TextChange>,
    pub summary: DiffSummary,
}

impl SchemaDiff {
    pub fn is_empty(&self) -> bool {
        self.summary.total == 0
    }

    /// 只保留這些表（含視圖）的差異；程序全部去掉。單表 drill-in 產生同步 DDL 用。
    pub fn retain_tables(&mut self, names: &[String]) {
        let keep = |n: &String| names.iter().any(|x| x == n);
        self.tables_added.retain(keep);
        self.tables_removed.retain(keep);
        self.tables_changed.retain(|t| keep(&t.name));
        self.tables_identical.retain(keep);
        self.views_added.retain(keep);
        self.views_removed.retain(keep);
        self.views_changed.retain(|t| keep(&t.name));
        self.routines_added.clear();
        self.routines_removed.clear();
        self.routines_changed.clear();
        self.summary = DiffSummary {
            tables_added: self.tables_added.len(),
            tables_removed: self.tables_removed.len(),
            tables_changed: self.tables_changed.len(),
            views_added: self.views_added.len(),
            views_removed: self.views_removed.len(),
            views_changed: self.views_changed.len(),
            ..Default::default()
        };
        let s = &self.summary;
        self.summary.total =
            s.tables_added + s.tables_removed + s.tables_changed + s.views_added + s.views_removed + s.views_changed;
    }
}

fn key(name: &str, opts: &DiffOptions) -> String {
    if opts.ignore_case { name.to_ascii_lowercase() } else { name.to_string() }
}

/// 以 key 配對兩側，回 (only_src, only_dst, both)；皆依 key 排序。
fn pair<'a, T>(
    src: &'a [T],
    dst: &'a [T],
    name_of: impl Fn(&T) -> &str,
    opts: &DiffOptions,
) -> (Vec<&'a T>, Vec<&'a T>, Vec<(&'a T, &'a T)>) {
    let mut s: BTreeMap<String, &T> = BTreeMap::new();
    for t in src {
        s.insert(key(name_of(t), opts), t);
    }
    let mut d: BTreeMap<String, &T> = BTreeMap::new();
    for t in dst {
        d.insert(key(name_of(t), opts), t);
    }
    let mut only_s = Vec::new();
    let mut both = Vec::new();
    for (k, v) in &s {
        match d.get(k) {
            Some(w) => both.push((*v, *w)),
            None => only_s.push(*v),
        }
    }
    let only_d = d.iter().filter(|(k, _)| !s.contains_key(*k)).map(|(_, v)| *v).collect();
    (only_s, only_d, both)
}

pub fn diff(src: &DbSchema, dst: &DbSchema, opts: &DiffOptions) -> SchemaDiff {
    let cross_engine = !same_family(src.kind, dst.kind);
    let mut out = SchemaDiff {
        src_kind: src.kind,
        dst_kind: dst.kind,
        src_db: src.database.clone(),
        dst_db: dst.database.clone(),
        cross_engine,
        tables_added: vec![],
        tables_removed: vec![],
        tables_changed: vec![],
        tables_identical: vec![],
        views_added: vec![],
        views_removed: vec![],
        views_changed: vec![],
        routines_added: vec![],
        routines_removed: vec![],
        routines_changed: vec![],
        summary: DiffSummary::default(),
    };

    // ---- tables ----
    let (only_s, only_d, both) = pair(&src.tables, &dst.tables, |t| t.name.as_str(), opts);
    out.tables_added = only_s.iter().map(|t| t.name.clone()).collect();
    out.tables_removed = only_d.iter().map(|t| t.name.clone()).collect();
    for (s, d) in both {
        let td = diff_table(s, d, src.kind, dst.kind, cross_engine, opts);
        if td.is_empty() && !td.ddl_differs {
            out.tables_identical.push(s.name.clone());
        } else {
            out.tables_changed.push(td);
        }
    }

    // ---- views（以定義文字比對）----
    let (only_s, only_d, both) = pair(&src.views, &dst.views, |t| t.name.as_str(), opts);
    out.views_added = only_s.iter().map(|t| t.name.clone()).collect();
    out.views_removed = only_d.iter().map(|t| t.name.clone()).collect();
    for (s, d) in both {
        let same = match (&s.ddl, &d.ddl) {
            (Some(a), Some(b)) => normalize_text(src.kind, a) == normalize_text(dst.kind, b),
            // 一側沒 DDL：退回欄位名 / 型別比對。
            _ => columns_equivalent(&s.columns, &d.columns, src.kind, dst.kind, cross_engine, opts),
        };
        if !same {
            out.views_changed.push(TextChange {
                name: s.name.clone(),
                routine_type: None,
                src: s.ddl.clone(),
                dst: d.ddl.clone(),
            });
        }
    }

    // ---- routines（type + name 為 key）----
    let rkey = |r: &super::schema::RoutineSchema| format!("{}:{}", r.info.routine_type, r.info.name);
    let src_r: Vec<(String, &super::schema::RoutineSchema)> = src.routines.iter().map(|r| (rkey(r), r)).collect();
    let dst_r: Vec<(String, &super::schema::RoutineSchema)> = dst.routines.iter().map(|r| (rkey(r), r)).collect();
    let (only_s, only_d, both) = pair(&src_r, &dst_r, |(k, _)| k.as_str(), opts);
    let to_tc = |r: &super::schema::RoutineSchema, s: Option<String>, d: Option<String>| TextChange {
        name: r.info.name.clone(),
        routine_type: Some(r.info.routine_type.clone()),
        src: s,
        dst: d,
    };
    out.routines_added = only_s.iter().map(|(_, r)| to_tc(r, r.definition.clone(), None)).collect();
    out.routines_removed = only_d.iter().map(|(_, r)| to_tc(r, None, r.definition.clone())).collect();
    for ((_, s), (_, d)) in both {
        let same = match (&s.definition, &d.definition) {
            (Some(a), Some(b)) => normalize_text(src.kind, a) == normalize_text(dst.kind, b),
            (None, None) => true,
            _ => false,
        };
        if !same {
            out.routines_changed.push(to_tc(s, s.definition.clone(), d.definition.clone()));
        }
    }

    out.summary = DiffSummary {
        tables_added: out.tables_added.len(),
        tables_removed: out.tables_removed.len(),
        tables_changed: out.tables_changed.len(),
        views_added: out.views_added.len(),
        views_removed: out.views_removed.len(),
        views_changed: out.views_changed.len(),
        routines_added: out.routines_added.len(),
        routines_removed: out.routines_removed.len(),
        routines_changed: out.routines_changed.len(),
        total: 0,
    };
    let s = &out.summary;
    out.summary.total = s.tables_added
        + s.tables_removed
        + s.tables_changed
        + s.views_added
        + s.views_removed
        + s.views_changed
        + s.routines_added
        + s.routines_removed
        + s.routines_changed;
    out
}

fn columns_equivalent(
    a: &[ColumnInfo],
    b: &[ColumnInfo],
    ak: DbKind,
    bk: DbKind,
    cross: bool,
    opts: &DiffOptions,
) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let (only_s, only_d, both) = pair(a, b, |c| c.name.as_str(), opts);
    only_s.is_empty()
        && only_d.is_empty()
        && both.iter().all(|(s, d)| column_attrs(s, d, ak, bk, cross, opts).is_empty())
}

/// 兩欄的差異屬性（空 = 相同）。
fn column_attrs(
    s: &ColumnInfo,
    d: &ColumnInfo,
    sk: DbKind,
    dk: DbKind,
    cross: bool,
    opts: &DiffOptions,
) -> Vec<ColumnAttr> {
    let mut attrs = Vec::new();
    let type_same = if cross {
        type_family(sk, &s.data_type) == type_family(dk, &d.data_type)
    } else {
        normalize_type(sk, &s.data_type) == normalize_type(dk, &d.data_type)
    };
    if !type_same {
        attrs.push(ColumnAttr::DataType);
    }
    if s.nullable != d.nullable {
        attrs.push(ColumnAttr::Nullable);
    }
    if !opts.ignore_defaults && !cross
        && normalize_default(sk, s.default.as_deref()) != normalize_default(dk, d.default.as_deref())
    {
        attrs.push(ColumnAttr::Default);
    }
    if !cross && normalize_extra(&s.extra) != normalize_extra(&d.extra) {
        attrs.push(ColumnAttr::Extra);
    }
    if !opts.ignore_comments && s.comment.trim() != d.comment.trim() {
        attrs.push(ColumnAttr::Comment);
    }
    attrs
}

/// extra 只看語意旗標：auto_increment / identity / generated。
fn normalize_extra(e: &str) -> Vec<&'static str> {
    let l = e.to_ascii_lowercase();
    let mut v = Vec::new();
    if l.contains("auto_increment") || l.contains("identity") {
        v.push("auto_increment");
    }
    if l.contains("generated") && !l.contains("default_generated") {
        v.push("generated");
    }
    v
}

fn index_content(i: &IndexInfo) -> (Vec<String>, bool) {
    (i.columns.iter().map(|c| c.to_ascii_lowercase()).collect(), i.unique)
}

fn fk_content(f: &ForeignKey) -> (Vec<String>, String, Vec<String>) {
    (
        f.columns.iter().map(|c| c.to_ascii_lowercase()).collect(),
        f.ref_table.to_ascii_lowercase(),
        f.ref_columns.iter().map(|c| c.to_ascii_lowercase()).collect(),
    )
}

fn diff_table(
    s: &TableSchema,
    d: &TableSchema,
    sk: DbKind,
    dk: DbKind,
    cross: bool,
    opts: &DiffOptions,
) -> TableDiff {
    let mut td = TableDiff { name: s.name.clone(), ..Default::default() };

    // ---- columns ----
    let (only_s, only_d, both) = pair(&s.columns, &d.columns, |c| c.name.as_str(), opts);
    td.columns_added = only_s.into_iter().cloned().collect();
    td.columns_removed = only_d.into_iter().cloned().collect();
    for (sc, dc) in both {
        let attrs = column_attrs(sc, dc, sk, dk, cross, opts);
        if !attrs.is_empty() {
            td.columns_changed.push(ColumnChange { name: sc.name.clone(), src: sc.clone(), dst: dc.clone(), attrs });
        }
    }

    // ---- indexes ----
    // 主鍵索引不看名字（MySQL PRIMARY / PG t_pkey / Oracle SYS_C…），以 primary 旗標配對。
    let s_pk = s.indexes.iter().find(|i| i.primary);
    let d_pk = d.indexes.iter().find(|i| i.primary);
    match (s_pk, d_pk) {
        (Some(a), Some(b)) => {
            if index_content(a) != index_content(b) {
                td.indexes_changed.push(IndexChange { name: a.name.clone(), src: a.clone(), dst: b.clone(), renamed: false });
            }
        }
        (Some(a), None) => td.indexes_added.push(a.clone()),
        (None, Some(b)) => td.indexes_removed.push(b.clone()),
        (None, None) => {}
    }
    let s_idx: Vec<&IndexInfo> = s.indexes.iter().filter(|i| !i.primary).collect();
    let d_idx: Vec<&IndexInfo> = d.indexes.iter().filter(|i| !i.primary).collect();
    let (only_s, only_d, both) = pair(&s_idx, &d_idx, |i| i.name.as_str(), opts);
    for (a, b) in both {
        if index_content(a) != index_content(b) {
            td.indexes_changed.push(IndexChange { name: a.name.clone(), src: (*a).clone(), dst: (*b).clone(), renamed: false });
        }
    }
    let (mut only_s, mut only_d): (Vec<&IndexInfo>, Vec<&IndexInfo>) =
        (only_s.into_iter().copied().collect(), only_d.into_iter().copied().collect());
    if opts.match_by_content {
        // 第二輪：名稱不同、定義相同 → 改名。
        let mut i = 0;
        while i < only_s.len() {
            if let Some(j) = only_d.iter().position(|b| index_content(b) == index_content(only_s[i])) {
                let a = only_s.remove(i);
                let b = only_d.remove(j);
                td.indexes_changed.push(IndexChange { name: a.name.clone(), src: a.clone(), dst: b.clone(), renamed: true });
            } else {
                i += 1;
            }
        }
    }
    td.indexes_added = only_s.into_iter().cloned().collect();
    td.indexes_removed = only_d.into_iter().cloned().collect();

    // ---- foreign keys ----
    let s_fk = group_fks(&s.foreign_keys);
    let d_fk = group_fks(&d.foreign_keys);
    let (only_s, only_d, both) = pair(&s_fk, &d_fk, |f| f.name.as_str(), opts);
    for (a, b) in both {
        if fk_content(a) != fk_content(b) {
            td.fks_changed.push(FkChange { name: a.name.clone(), src: a.clone(), dst: b.clone(), renamed: false });
        }
    }
    let (mut only_s, mut only_d): (Vec<&ForeignKey>, Vec<&ForeignKey>) = (only_s, only_d);
    if opts.match_by_content {
        let mut i = 0;
        while i < only_s.len() {
            if let Some(j) = only_d.iter().position(|b| fk_content(b) == fk_content(only_s[i])) {
                let a = only_s.remove(i);
                let b = only_d.remove(j);
                td.fks_changed.push(FkChange { name: a.name.clone(), src: a.clone(), dst: b.clone(), renamed: true });
            } else {
                i += 1;
            }
        }
    }
    td.fks_added = only_s.into_iter().cloned().collect();
    td.fks_removed = only_d.into_iter().cloned().collect();

    // ---- raw DDL（僅同引擎且為真實 DDL 時）----
    if !cross && td.is_empty() && !s.ddl_synthesized && !d.ddl_synthesized
        && matches!(sk, DbKind::Mysql | DbKind::Mariadb | DbKind::Oracle)
    {
        if let (Some(a), Some(b)) = (&s.ddl, &d.ddl) {
            td.ddl_differs = normalize_ddl(sk, a) != normalize_ddl(dk, b);
        }
    }

    // 決定性排序。
    td.columns_added.sort_by(|a, b| a.name.cmp(&b.name));
    td.columns_removed.sort_by(|a, b| a.name.cmp(&b.name));
    td.columns_changed.sort_by(|a, b| a.name.cmp(&b.name));
    td.indexes_added.sort_by(|a, b| a.name.cmp(&b.name));
    td.indexes_removed.sort_by(|a, b| a.name.cmp(&b.name));
    td.indexes_changed.sort_by(|a, b| a.name.cmp(&b.name));
    td.fks_added.sort_by(|a, b| a.name.cmp(&b.name));
    td.fks_removed.sort_by(|a, b| a.name.cmp(&b.name));
    td.fks_changed.sort_by(|a, b| a.name.cmp(&b.name));
    td
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::ForeignKeyInfo;

    pub fn col(name: &str, ty: &str, nullable: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable,
            key: String::new(),
            default: None,
            extra: String::new(),
            comment: String::new(),
        }
    }
    pub fn idx(name: &str, cols: &[&str], unique: bool, primary: bool) -> IndexInfo {
        IndexInfo { name: name.into(), columns: cols.iter().map(|c| c.to_string()).collect(), unique, primary }
    }
    pub fn table(name: &str, cols: Vec<ColumnInfo>, indexes: Vec<IndexInfo>) -> TableSchema {
        TableSchema { name: name.into(), kind: "table".into(), columns: cols, indexes, ..Default::default() }
    }
    pub fn db(kind: DbKind, tables: Vec<TableSchema>) -> DbSchema {
        DbSchema {
            kind,
            database: "d".into(),
            captured_at_ms: 0,
            label: String::new(),
            tables,
            views: vec![],
            routines: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn detects_added_removed_changed_tables_and_columns() {
        let src = db(
            DbKind::Mysql,
            vec![
                table("a", vec![col("id", "int", false), col("name", "varchar(50)", true)], vec![]),
                table("only_src", vec![], vec![]),
            ],
        );
        let dst = db(
            DbKind::Mysql,
            vec![
                table("a", vec![col("id", "int(11)", false), col("name", "varchar(80)", false), col("old", "int", true)], vec![]),
                table("only_dst", vec![], vec![]),
            ],
        );
        let d = diff(&src, &dst, &DiffOptions::default());
        assert_eq!(d.tables_added, vec!["only_src"]);
        assert_eq!(d.tables_removed, vec!["only_dst"]);
        assert_eq!(d.tables_changed.len(), 1);
        let td = &d.tables_changed[0];
        assert!(td.columns_added.is_empty());
        assert_eq!(td.columns_removed[0].name, "old");
        assert_eq!(td.columns_changed.len(), 1);
        assert_eq!(td.columns_changed[0].attrs, vec![ColumnAttr::DataType, ColumnAttr::Nullable]);
        assert_eq!(d.summary.total, 3);
    }

    #[test]
    fn identical_schemas_yield_empty_diff() {
        let s = db(DbKind::Postgres, vec![table("a", vec![col("id", "integer", false)], vec![idx("a_pkey", &["id"], true, true)])]);
        let mut d2 = s.clone();
        d2.tables[0].columns[0].data_type = "int4".into();
        d2.tables[0].indexes[0].name = "PRIMARY".into();
        let d = diff(&s, &d2, &DiffOptions::default());
        assert!(d.is_empty(), "{d:?}");
        assert_eq!(d.tables_identical, vec!["a"]);
    }

    #[test]
    fn renamed_index_matched_by_content() {
        let s = db(DbKind::Sqlite, vec![table("t", vec![], vec![idx("ix_a", &["a"], true, false)])]);
        let d = db(DbKind::Sqlite, vec![table("t", vec![], vec![idx("sqlite_autoindex_t_1", &["a"], true, false)])]);
        let r = diff(&s, &d, &DiffOptions::default());
        let td = &r.tables_changed[0];
        assert!(td.indexes_added.is_empty() && td.indexes_removed.is_empty());
        assert!(td.indexes_changed[0].renamed);
        // 關閉內容配對 → 新增 + 刪除。
        let r = diff(&s, &d, &DiffOptions { match_by_content: false, ..Default::default() });
        let td = &r.tables_changed[0];
        assert_eq!(td.indexes_added.len(), 1);
        assert_eq!(td.indexes_removed.len(), 1);
    }

    #[test]
    fn composite_fk_grouped_and_compared() {
        let f = |n: &str, c: &str, rc: &str| ForeignKeyInfo { name: n.into(), column: c.into(), ref_table: "p".into(), ref_column: rc.into() };
        let mut s = table("t", vec![], vec![]);
        s.foreign_keys = vec![f("fk", "a", "x"), f("fk", "b", "y")];
        let mut d = table("t", vec![], vec![]);
        d.foreign_keys = vec![f("fk", "a", "x")];
        let r = diff(&db(DbKind::Mysql, vec![s]), &db(DbKind::Mysql, vec![d]), &DiffOptions::default());
        let td = &r.tables_changed[0];
        assert_eq!(td.fks_changed.len(), 1);
        assert_eq!(td.fks_changed[0].src.columns, vec!["a", "b"]);
    }

    #[test]
    fn ignore_case_matches_names() {
        let s = db(DbKind::Mysql, vec![table("Orders", vec![col("Id", "int", false)], vec![])]);
        let d = db(DbKind::Mysql, vec![table("orders", vec![col("id", "int", false)], vec![])]);
        assert_eq!(diff(&s, &d, &DiffOptions::default()).summary.total, 2);
        assert!(diff(&s, &d, &DiffOptions { ignore_case: true, ..Default::default() }).is_empty());
    }

    #[test]
    fn cross_engine_compares_type_family_only() {
        let s = db(DbKind::Mysql, vec![table("t", vec![col("ok", "tinyint(1)", false), col("id", "bigint", false), col("n", "varchar(10)", true)], vec![])]);
        let d = db(DbKind::Postgres, vec![table("t", vec![col("ok", "boolean", false), col("id", "integer", false), col("n", "integer", true)], vec![])]);
        let r = diff(&s, &d, &DiffOptions::default());
        assert!(r.cross_engine);
        let td = &r.tables_changed[0];
        assert_eq!(td.columns_changed.len(), 1);
        assert_eq!(td.columns_changed[0].name, "n");
    }

    #[test]
    fn routines_and_views_compare_by_normalized_text() {
        use super::super::schema::RoutineSchema;
        use crate::db::RoutineInfo;
        let ri = |n: &str| RoutineInfo { name: n.into(), routine_type: "procedure".into(), parent: None, signature: None, modified: None, deterministic: None, comment: None };
        let mut s = db(DbKind::Mysql, vec![]);
        s.routines = vec![
            RoutineSchema { info: ri("p1"), definition: Some("CREATE DEFINER=`a`@`%` PROCEDURE p1() BEGIN END".into()) },
            RoutineSchema { info: ri("p2"), definition: Some("CREATE PROCEDURE p2() BEGIN SELECT 1; END".into()) },
        ];
        s.views = vec![TableSchema { name: "v".into(), kind: "view".into(), ddl: Some("CREATE VIEW v AS SELECT 1".into()), ..Default::default() }];
        let mut d = db(DbKind::Mysql, vec![]);
        d.routines = vec![
            RoutineSchema { info: ri("p1"), definition: Some("CREATE PROCEDURE p1()\nBEGIN\nEND;".into()) },
            RoutineSchema { info: ri("p2"), definition: Some("CREATE PROCEDURE p2() BEGIN SELECT 2; END".into()) },
            RoutineSchema { info: ri("p3"), definition: None },
        ];
        d.views = vec![TableSchema { name: "v".into(), kind: "view".into(), ddl: Some("create view v as select 2".into()), ..Default::default() }];
        let r = diff(&s, &d, &DiffOptions::default());
        assert_eq!(r.routines_changed.len(), 1);
        assert_eq!(r.routines_changed[0].name, "p2");
        assert_eq!(r.routines_removed.len(), 1);
        assert_eq!(r.views_changed.len(), 1);
    }

    #[test]
    fn ddl_differs_flag_for_real_ddl_only() {
        let mut s = table("t", vec![col("id", "int", false)], vec![]);
        s.ddl = Some("CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4".into());
        let mut d = s.clone();
        d.ddl = Some("CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=99 DEFAULT CHARSET=latin1".into());
        let r = diff(&db(DbKind::Mysql, vec![s.clone()]), &db(DbKind::Mysql, vec![d.clone()]), &DiffOptions::default());
        assert!(r.tables_changed[0].ddl_differs);
        // 只有 AUTO_INCREMENT 不同 → 視為相同。
        d.ddl = Some("CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=99 DEFAULT CHARSET=utf8mb4".into());
        let r = diff(&db(DbKind::Mysql, vec![s]), &db(DbKind::Mysql, vec![d]), &DiffOptions::default());
        assert!(r.is_empty());
    }
}
