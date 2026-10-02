//! 副作用快照：呼叫前後整表擷取（在專屬連線上，看得到未提交狀態）→ 前後像差異 → `TableEffect`。
//!
//! 前後像比對直接用 review_run 的 `diff_snapshots`（含無主鍵的多重集合模式），這裡只負責
//! 把結果集組成 `TableSnapshot`、以及標出要遮罩的欄（identity / 時間預設值），比對時那些欄只看
//! 「兩邊都 NULL / 都非 NULL」——各引擎的自動值本來就不會相等。

use serde::{Deserialize, Serialize};

use super::session::ResultSet;
use crate::db::DbKind;
use crate::error::AppResult;
use crate::manager::ConnectionManager;
use crate::review_run::capture::{now_ms, table_meta, TableMeta, TableSnapshot};
use crate::review_run::rollback::diff_snapshots;

#[derive(Debug, Clone)]
pub struct TableRef {
    /// 測試檔 / 盤點給的名字。
    pub logical: String,
    pub meta: TableMeta,
    pub identity_cols: Vec<String>,
    pub volatile_cols: Vec<String>,
}

/// 表名正規化（比對 effects 期望與跨引擎對應用）：小寫、去 `dbo.` / `<database>.` 前綴。
pub fn norm_table_name(kind: DbKind, database: &str, name: &str) -> String {
    let n = name.trim().replace(['[', ']', '"', '`'], "").to_ascii_lowercase();
    match n.split_once('.') {
        Some((pre, rest)) if matches!(kind, DbKind::Mssql) && pre == "dbo" => rest.to_string(),
        Some((pre, rest)) if !matches!(kind, DbKind::Mssql) && pre == database.to_ascii_lowercase() => rest.to_string(),
        _ => n,
    }
}

/// driver 認得的表名：MSSQL 去 `dbo.`、其餘去 `<database>.`。
pub fn driver_table_name(kind: DbKind, database: &str, name: &str) -> String {
    let n = name.trim().replace(['[', ']', '"', '`'], "");
    match n.split_once('.') {
        Some((pre, rest)) if matches!(kind, DbKind::Mssql) && pre.eq_ignore_ascii_case("dbo") => rest.to_string(),
        Some((pre, rest)) if !matches!(kind, DbKind::Mssql) && pre.eq_ignore_ascii_case(database) => rest.to_string(),
        _ => n,
    }
}

fn is_volatile_default(d: &str) -> bool {
    let d = d.to_ascii_lowercase();
    ["getdate", "sysdatetime", "sysutcdatetime", "getutcdate", "now(", "current_timestamp", "newid", "newsequentialid", "gen_random_uuid", "uuid_generate", "uuid()", "localtimestamp", "clock_timestamp"]
        .iter()
        .any(|k| d.contains(k))
}

pub async fn load_table(mgr: &ConnectionManager, id: &str, kind: DbKind, database: &str, name: &str) -> AppResult<TableRef> {
    let tname = driver_table_name(kind, database, name);
    let meta = table_meta(mgr, id, kind, database, &tname).await?;
    let cols = mgr.table_columns(id, database, &tname).await.unwrap_or_default();
    let identity_cols: Vec<String> = meta
        .columns
        .iter()
        .filter(|c| c.identity)
        .map(|c| c.name.clone())
        .chain(cols.iter().filter(|c| c.extra.to_ascii_lowercase().contains("auto_increment") || c.default.as_deref().map(|d| d.to_ascii_lowercase().starts_with("nextval(")).unwrap_or(false)).map(|c| c.name.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let volatile_cols: Vec<String> = cols
        .iter()
        .filter(|c| c.default.as_deref().map(is_volatile_default).unwrap_or(false))
        .map(|c| c.name.clone())
        .collect();
    Ok(TableRef { logical: name.to_string(), meta, identity_cols, volatile_cols })
}

/// 結果集 → 快照（欄序 = meta.columns；零列時結果集可能沒有欄名，直接當空）。
pub fn snapshot_from(meta: &TableMeta, set: &ResultSet) -> TableSnapshot {
    let width = meta.columns.len();
    let rows = set
        .rows
        .iter()
        .map(|r| {
            let mut row: Vec<Option<String>> = r.clone();
            row.resize(width, None);
            row
        })
        .collect();
    TableSnapshot { meta: meta.clone(), rows, truncated: set.truncated, missing: false, method: "sptest".into(), captured_at_ms: now_ms() }
}

/// 一張表在一次呼叫前後的變化。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableEffect {
    /// 正規化後的表名（比對鍵）。
    pub table: String,
    pub columns: Vec<String>,
    pub key: Vec<String>,
    pub inserted: Vec<Vec<Option<String>>>,
    /// （前像, 後像）
    pub updated: Vec<(Vec<Option<String>>, Vec<Option<String>>)>,
    pub deleted: Vec<Vec<Option<String>>>,
    /// 任一側快照被截斷：數量仍可信、逐列比對不完整。
    pub incomplete: bool,
    pub keyless: bool,
    pub masked_cols: Vec<String>,
}

impl TableEffect {
    pub fn is_empty(&self) -> bool {
        self.inserted.is_empty() && self.updated.is_empty() && self.deleted.is_empty()
    }
}

pub fn effect(kind: DbKind, database: &str, t: &TableRef, before: &TableSnapshot, after: &TableSnapshot) -> TableEffect {
    let d = diff_snapshots(before, after);
    let mut masked: Vec<String> = t.identity_cols.iter().chain(t.volatile_cols.iter()).cloned().collect();
    masked.sort();
    masked.dedup();
    TableEffect {
        table: norm_table_name(kind, database, &t.logical),
        columns: d.columns.clone(),
        key: d.key.clone(),
        inserted: d.inserted,
        updated: d.updated.into_iter().map(|c| (c.before, c.after)).collect(),
        deleted: d.deleted,
        incomplete: d.incomplete,
        keyless: d.keyless,
        masked_cols: masked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_name_normalization() {
        assert_eq!(norm_table_name(DbKind::Mssql, "sptest", "dbo.Orders"), "orders");
        assert_eq!(norm_table_name(DbKind::Mssql, "sptest", "[sales].[Items]"), "sales.items");
        assert_eq!(norm_table_name(DbKind::Postgres, "sptest", "sptest.orders"), "orders");
        assert_eq!(norm_table_name(DbKind::Mysql, "sptest", "other.orders"), "other.orders");
        assert_eq!(driver_table_name(DbKind::Mssql, "sptest", "dbo.orders"), "orders");
        assert_eq!(driver_table_name(DbKind::Mssql, "sptest", "sales.items"), "sales.items");
        assert_eq!(driver_table_name(DbKind::Postgres, "sptest", "sptest.orders"), "orders");
    }

    #[test]
    fn volatile_defaults() {
        assert!(is_volatile_default("(getdate())"));
        assert!(is_volatile_default("now()"));
        assert!(is_volatile_default("CURRENT_TIMESTAMP(6)"));
        assert!(!is_volatile_default("'NEW'"));
        assert!(!is_volatile_default("0"));
    }
}
