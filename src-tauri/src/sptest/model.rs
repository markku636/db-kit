//! 測試檔資料模型（`tests/<name>.json`）。
//!
//! 步驟詞彙借自表格驅動 DB 測試框架的慣例：`insert`（取回自動值）、`call`（OUT 參數 / 結果集 / 副作用）、
//! `query`（預設不比列序、只比列出的欄）、`sql`、`compare`、`snapshot`；符號 `">>name"` 擷取、
//! `"<<name"` 引用、SQL 內 `@name` 代入。
//!
//! 值一律以 `serde_json::Value` 承載：字串可能是符號、物件可能是 `{"not": v}` 或 `{"type": …, "value": …}`，
//! 解析時機在執行期（符號要先有值），故這裡不預先分類。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::errclass::ErrorClass;
use crate::db::DbKind;

/// 一列期望 / 一列 seed：欄名 → 值。保留鍵序（serde_json 開了 preserve_order），表格呈現才穩定。
pub type Row = Map<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestFile {
    pub version: u32,
    pub target: Target,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tables: Vec<TableMap>,
    /// 程序名對應（同 `tables`）：diff 時把來源的 `usp_x` 對到 PG 的 `usp_x` 以外的名字。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routines: Vec<TableMap>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub symbols: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fixtures: BTreeMap<String, Fixture>,
    #[serde(default)]
    pub defaults: Defaults,
    pub scenarios: Vec<Scenario>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub kind: DbKind,
    /// MSSQL / MySQL 為資料庫名；PG 為 schema（與 db-kit 其餘功能的「database」軸一致）。
    pub database: String,
}

/// 跨引擎名稱對應（diff 模式用）：`name` 是檔案裡寫的名字，各引擎欄位給該引擎的實際名字。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TableMap {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mssql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mysql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pg: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub natural_key: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fixture {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxMode {
    Wrapped,
    Isolated,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnError {
    RollbackToSavepoint,
    Keep,
}

/// 自動快照的表來源：`"auto"`（盤點到的寫入目標）、`"none"`、或明列。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SnapshotSpec {
    Named(String),
    Tables(Vec<String>),
}

impl Default for SnapshotSpec {
    fn default() -> Self {
        SnapshotSpec::Named("auto".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Defaults {
    pub mode: TxMode,
    pub ordered: bool,
    pub ignore_trailing_spaces: bool,
    pub case_insensitive_text: bool,
    pub null_equals_empty: bool,
    pub zero_date_as_null: bool,
    pub float_rel_tol: f64,
    pub float_abs_tol: f64,
    pub datetime_tol_ms: i64,
    pub mask_columns: Vec<String>,
    pub snapshot: SnapshotSpec,
    pub effects_strict: bool,
    pub max_snapshot_rows: usize,
    pub lock_timeout_ms: u64,
    pub statement_timeout_ms: u64,
    pub on_error: OnError,
}

impl Default for Defaults {
    fn default() -> Self {
        Defaults {
            mode: TxMode::Wrapped,
            ordered: false,
            ignore_trailing_spaces: true,
            case_insensitive_text: false,
            null_equals_empty: false,
            zero_date_as_null: true,
            float_rel_tol: 1e-9,
            float_abs_tol: 1e-12,
            datetime_tol_ms: 10,
            mask_columns: vec![],
            snapshot: SnapshotSpec::default(),
            effects_strict: false,
            max_snapshot_rows: 50_000,
            lock_timeout_ms: 5_000,
            statement_timeout_ms: 60_000,
            on_error: OnError::RollbackToSavepoint,
        }
    }
}

/// `skip: true` 或 `skip: "原因"`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Skip {
    Flag(bool),
    Reason(String),
}

impl Skip {
    pub fn reason(&self) -> Option<String> {
        match self {
            Skip::Flag(true) => Some(String::new()),
            Skip::Flag(false) => None,
            Skip::Reason(r) => Some(r.clone()),
        }
    }
}

/// 資料驅動：同一組 steps 以不同變數跑多次。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub name: String,
    #[serde(default)]
    pub vars: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_error: Option<ErrorExpect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip: Option<Skip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<TxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<SnapshotSpec>,
    /// 前置的 fixture 名稱（依序展開在 steps 之前）。
    #[serde(default, rename = "use", skip_serializing_if = "Vec::is_empty")]
    pub use_fixtures: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cases: Vec<Case>,
    pub steps: Vec<Step>,
    /// 效能測試參數（bench 模式）；本切片僅保留原文。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bench: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perf: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorExpect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<ErrorClass>,
    /// MSSQL / MySQL 錯誤號（數字）或 PG SQLSTATE（字串）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_contains: Option<String>,
}

/// 結果集期望：列（部分欄）、或只比數量、或 `"ignore"`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResultSetExpect {
    Ignore(String),
    Spec(ResultSetSpec),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultSetSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Row>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordered: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key: Vec<String>,
}

/// 副作用期望：數量，或逐列。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CountOrRows {
    Count(usize),
    Rows(Vec<Row>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CountOrChanges {
    Count(usize),
    Changes(Vec<RowChangeExpect>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowChangeExpect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<Row>,
    pub after: Row,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectExpect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inserted: Option<CountOrRows>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<CountOrChanges>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<CountOrRows>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallExpect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_sets: Option<Vec<ResultSetExpect>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_code: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<Row>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effects: Option<BTreeMap<String, EffectExpect>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effects_strict: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InsertStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub insert: String,
    pub rows: Vec<Row>,
    #[serde(default)]
    pub identity_insert: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_error: Option<ErrorExpect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<Vec<Row>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordered: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub capture: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_error: Option<ErrorExpect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub call: String,
    #[serde(default)]
    pub params: Row,
    /// 從第一個結果集擷取：`{"col": ">>sym"}` 取第一列的欄；`{"*": ">>sym"}` 存整個結果集（給 compare）。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub capture: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<CallExpect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_error: Option<ErrorExpect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<OnError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub query: String,
    pub expect: Vec<Row>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordered: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub capture: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_error: Option<ErrorExpect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompareStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 兩個結果集符號（`"<<a"`, `"<<b"`）。
    pub compare: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordered: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub snapshot: Vec<String>,
}

/// 各變體的必要鍵互斥（`insert` / `call` / `query` / `compare` / `snapshot` / `sql`），
/// 搭配 `deny_unknown_fields` 讓 untagged 解析不會誤配。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Step {
    Insert(InsertStep),
    Call(CallStep),
    Query(QueryStep),
    Compare(CompareStep),
    Snapshot(SnapshotStep),
    Sql(SqlStep),
}

impl Step {
    pub fn kind(&self) -> &'static str {
        match self {
            Step::Insert(_) => "insert",
            Step::Call(_) => "call",
            Step::Query(_) => "query",
            Step::Compare(_) => "compare",
            Step::Snapshot(_) => "snapshot",
            Step::Sql(_) => "sql",
        }
    }

    pub fn id(&self) -> Option<&str> {
        match self {
            Step::Insert(s) => s.id.as_deref(),
            Step::Call(s) => s.id.as_deref(),
            Step::Query(s) => s.id.as_deref(),
            Step::Compare(s) => s.id.as_deref(),
            Step::Snapshot(s) => s.id.as_deref(),
            Step::Sql(s) => s.id.as_deref(),
        }
    }

    pub fn expect_error(&self) -> Option<&ErrorExpect> {
        match self {
            Step::Insert(s) => s.expect_error.as_ref(),
            Step::Call(s) => s.expect_error.as_ref(),
            Step::Query(s) => s.expect_error.as_ref(),
            Step::Sql(s) => s.expect_error.as_ref(),
            Step::Compare(_) | Step::Snapshot(_) => None,
        }
    }

    /// 步驟的顯示名：`id`，否則「第 N 步 <kind>」。
    pub fn label(&self, index: usize) -> String {
        match self.id() {
            Some(id) => id.to_string(),
            None => format!("#{} {}", index + 1, self.kind()),
        }
    }
}

// ---------------------------------------------------------------------------
// 符號語法
// ---------------------------------------------------------------------------

/// `">>name"` → `Some("name")`。
pub fn capture_name(v: &Value) -> Option<&str> {
    v.as_str().and_then(|s| s.strip_prefix(">>")).map(str::trim).filter(|s| !s.is_empty())
}

/// `"<<name"` / `"<<name.col"` → `Some(("name", Some("col")))`。
pub fn reference_name(v: &Value) -> Option<(&str, Option<&str>)> {
    let s = v.as_str()?.strip_prefix("<<")?.trim();
    if s.is_empty() {
        return None;
    }
    Some(match s.split_once('.') {
        Some((n, c)) => (n, Some(c)),
        None => (s, None),
    })
}

/// 欄名尾的 `?`（只比值、不當 key）。
pub fn split_value_only(col: &str) -> (&str, bool) {
    match col.strip_suffix('?') {
        Some(c) => (c, true),
        None => (col, false),
    }
}

// ---------------------------------------------------------------------------
// 驗證
// ---------------------------------------------------------------------------

/// 結構正確但語意錯的地方：未定義的 fixture、`compare` 引用不是 `<<` 符號、`expect` 與 `expect_error` 並存……
/// 回傳人看的訊息清單；空 = 通過。
pub fn validate(file: &TestFile) -> Vec<String> {
    let mut errs = Vec::new();
    if file.version != 1 {
        errs.push(format!("version 必須是 1（實得 {}）", file.version));
    }
    if file.scenarios.is_empty() {
        errs.push("scenarios 不可為空".into());
    }
    let mut seen = std::collections::HashSet::new();
    for sc in &file.scenarios {
        if !seen.insert(sc.id.as_str()) {
            errs.push(format!("scenario id 重複：{}", sc.id));
        }
        for f in &sc.use_fixtures {
            if !file.fixtures.contains_key(f) {
                errs.push(format!("scenario {}：use 的 fixture「{f}」不存在", sc.id));
            }
        }
        let mut case_names = std::collections::HashSet::new();
        for c in &sc.cases {
            if !case_names.insert(c.name.as_str()) {
                errs.push(format!("scenario {}：case 名稱重複：{}", sc.id, c.name));
            }
        }
        if sc.steps.is_empty() && sc.use_fixtures.is_empty() {
            errs.push(format!("scenario {}：沒有任何步驟", sc.id));
        }
        for (i, st) in sc.steps.iter().enumerate() {
            validate_step(&sc.id, i, st, &mut errs);
        }
    }
    for (name, fx) in &file.fixtures {
        for (i, st) in fx.steps.iter().enumerate() {
            validate_step(&format!("fixture {name}"), i, st, &mut errs);
        }
    }
    errs
}

fn validate_step(owner: &str, i: usize, st: &Step, errs: &mut Vec<String>) {
    let label = st.label(i);
    match st {
        Step::Call(c) => {
            if c.call.trim().is_empty() {
                errs.push(format!("{owner} / {label}：call 不可為空"));
            }
            if c.expect.is_some() && c.expect_error.is_some() {
                errs.push(format!("{owner} / {label}：expect 與 expect_error 不可並存"));
            }
        }
        Step::Insert(s) => {
            if s.rows.is_empty() {
                errs.push(format!("{owner} / {label}：insert 至少要一列"));
            }
        }
        Step::Query(q) => {
            if q.query.trim().is_empty() {
                errs.push(format!("{owner} / {label}：query 不可為空"));
            }
            if q.expect_error.is_some() && !q.expect.is_empty() {
                errs.push(format!("{owner} / {label}：expect 與 expect_error 不可並存"));
            }
        }
        Step::Sql(s) => {
            if s.sql.trim().is_empty() {
                errs.push(format!("{owner} / {label}：sql 不可為空"));
            }
        }
        Step::Compare(c) => {
            if c.compare.len() != 2 {
                errs.push(format!("{owner} / {label}：compare 需要恰好兩個符號"));
            }
            for s in &c.compare {
                if reference_name(&Value::String(s.clone())).is_none() {
                    errs.push(format!("{owner} / {label}：compare 的「{s}」不是 <<符號"));
                }
            }
        }
        Step::Snapshot(s) => {
            if s.snapshot.is_empty() {
                errs.push(format!("{owner} / {label}：snapshot 至少要一張表"));
            }
        }
    }
}

/// 給 AI 範本看的精簡 schema 說明（與 `TestFile` 同步維護）。
pub const SCHEMA_DOC: &str = r#"TestFile { version: 1, target: {kind: "mssql"|"postgres"|"mysql", database}, routine?, tables?: [{name, mssql?, mysql?, pg?, natural_key?}],
  symbols?: {name: value}, fixtures?: {name: {steps: Step[]}}, defaults?: Defaults, scenarios: Scenario[] }
Defaults { mode: "wrapped"|"isolated"|"auto", ordered: false, ignore_trailing_spaces: true, case_insensitive_text: false, null_equals_empty: false,
  zero_date_as_null: true, float_rel_tol: 1e-9, datetime_tol_ms: 10, mask_columns: [], snapshot: "auto"|"none"|[tables], effects_strict: false,
  max_snapshot_rows: 50000, on_error: "rollback_to_savepoint"|"keep" }
Scenario { id, description?, tags?, skip?: bool|string, mode?, snapshot?, use?: [fixture names], cases?: [{name, vars: {k: v}, expect_error?}], steps: Step[] }
Step = {insert: table, rows: Row[], identity_insert?}            // Row value ">>sym" captures the generated value
     | {call: routine, params: {name: Value}, expect?: {result_sets?: [{rows?: Row[], count?, ordered?, key?} | "ignore"], return_code?, out?: {name: Value},
            effects?: {table: {inserted?: n|Row[], updated?: n|[{before?: Row, after: Row}], deleted?: n|Row[]}}, effects_strict?}, expect_error?: ErrorExpect, on_error?}
     | {query: sql, expect: Row[], ordered?, key?, capture?: {col: ">>sym"}}
     | {sql: sql, expect?: Row[], capture?}
     | {compare: ["<<a", "<<b"], ordered?}
     | {snapshot: [tables]}
ErrorExpect { class?: constraint_violation|not_null|conversion|divide_by_zero|user_raised|not_found|timeout|other, code?, message_contains? }
Value = JSON scalar | null | {"not": Value} | {"type": "decimal"|"datetime"|"date"|"uuid"|"bytes"|"json", "value": string} | ">>sym" | "<<sym" | "<<sym.col"
Row = {col: Value}   // only listed columns are compared; a trailing "?" on a column name means value-only (not part of the row key)"#;

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "version": 1,
      "target": {"kind": "mssql", "database": "sptest"},
      "fixtures": {"base": {"steps": [{"insert": "dbo.customers", "rows": [{"customer_id": ">>cid", "name": "Ann"}]}]}},
      "scenarios": [{
        "id": "place",
        "use": ["base"],
        "steps": [
          {"insert": "dbo.products", "rows": [{"product_id": ">>pid", "name": "Pen", "price": "12.50", "stock": 10}]},
          {"call": "dbo.usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 2},
           "expect": {"result_sets": [{"rows": [{"qty": 2, "total": "25.00"}]}], "effects": {"dbo.orders": {"inserted": 1}}}},
          {"query": "SELECT stock FROM dbo.products WHERE product_id = @pid", "expect": [{"stock": 8}]},
          {"call": "dbo.usp_cancel_order", "params": {"OrderID": "<<oid"}, "expect_error": {"class": "user_raised"}},
          {"compare": ["<<a", "<<b"]},
          {"snapshot": ["dbo.orders"]},
          {"sql": "UPDATE dbo.products SET stock = 1 WHERE product_id = @pid"}
        ]
      }]
    }"#;

    #[test]
    fn parses_every_step_kind() {
        let f: TestFile = serde_json::from_str(SAMPLE).unwrap();
        let kinds: Vec<_> = f.scenarios[0].steps.iter().map(|s| s.kind()).collect();
        assert_eq!(kinds, ["insert", "call", "query", "call", "compare", "snapshot", "sql"]);
        assert!(validate(&f).is_empty(), "{:?}", validate(&f));
        assert_eq!(f.defaults.datetime_tol_ms, 10);
        assert_eq!(f.defaults.snapshot, SnapshotSpec::Named("auto".into()));
    }

    #[test]
    fn rejects_unknown_keys_and_bad_refs() {
        let bad = r#"{"version": 1, "target": {"kind": "mysql", "database": "x"}, "scenarios": [{"id": "a", "steps": [{"insrt": "t", "rows": []}]}]}"#;
        assert!(serde_json::from_str::<TestFile>(bad).is_err());
        let f: TestFile = serde_json::from_str(
            r#"{"version": 1, "target": {"kind": "mysql", "database": "x"},
                "scenarios": [{"id": "a", "use": ["nope"], "steps": [{"compare": ["a", "<<b"]}]},
                              {"id": "a", "steps": [{"call": "p", "expect": {}, "expect_error": {"class": "other"}}]}]}"#,
        )
        .unwrap();
        let errs = validate(&f);
        assert!(errs.iter().any(|e| e.contains("nope")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("不是 <<符號")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("重複")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("不可並存")), "{errs:?}");
    }

    #[test]
    fn symbol_helpers() {
        assert_eq!(capture_name(&Value::String(">>oid".into())), Some("oid"));
        assert_eq!(capture_name(&Value::String("<<oid".into())), None);
        assert_eq!(reference_name(&Value::String("<<last.total".into())), Some(("last", Some("total"))));
        assert_eq!(reference_name(&Value::String("<<x".into())), Some(("x", None)));
        assert_eq!(split_value_only("amount?"), ("amount", true));
        assert_eq!(split_value_only("id"), ("id", false));
    }

    #[test]
    fn skip_forms() {
        let s: Scenario = serde_json::from_str(r#"{"id": "s", "skip": "flaky", "steps": [{"sql": "SELECT 1"}]}"#).unwrap();
        assert_eq!(s.skip.unwrap().reason(), Some("flaky".into()));
        let s: Scenario = serde_json::from_str(r#"{"id": "s", "skip": false, "steps": [{"sql": "SELECT 1"}]}"#).unwrap();
        assert_eq!(s.skip.unwrap().reason(), None);
    }
}
