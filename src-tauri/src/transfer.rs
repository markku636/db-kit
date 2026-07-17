//! 資料傳輸（Data Transfer，致敬 Navicat）：把一張表的資料複製到另一個連線 / 資料庫 / 表。
//!
//! 資料層級（不建表，目標表需先存在）：以「來源 ∩ 目標」的同名欄位傳輸，逐頁讀來源、逐列寫目標，
//! 沿用各 driver 的型別轉型，與資料庫種類無關（MySQL / PostgreSQL / SQLite，且可跨連線 / 跨庫 / 同庫跨表）。
//! 分頁以來源主鍵排序以穩定順序（無主鍵則退回無排序，可能重複 / 漏列——與「匯出」一致）。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::db::{DataQuery, DbKind, RowInsert, Sort, SortDir};
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

/// 一次自來源取多少列。
const PAGE_SIZE: u32 = 1000;
/// 安全上限，避免極大表把流程拖死。
const MAX_ROWS: u64 = 5_000_000;
/// 最多保留的錯誤訊息數。
const MAX_ERRORS: usize = 20;

#[derive(Debug, Deserialize, Default)]
pub struct TransferOptions {
    /// 任一列失敗即中止（預設關：盡量傳輸，回報失敗列數與前幾筆錯誤）。
    #[serde(default)]
    pub stop_on_error: bool,
    /// 目標表不存在時，沿用來源 DDL 自動建立（限相同資料庫種類）。
    #[serde(default)]
    pub create_table: bool,
}

#[derive(Debug, Serialize, Default)]
pub struct TransferResult {
    pub transferred: u64,
    pub failed: u64,
    /// 實際傳輸的欄位（來源 ∩ 目標，依來源欄序）。
    pub columns: Vec<String>,
    /// 來源有、目標無 → 略過的欄位（供使用者知悉）。
    pub skipped_columns: Vec<String>,
    /// 是否在本次傳輸中自動建立了目標表。
    pub created: bool,
    pub errors: Vec<String>,
}

/// 識別字跳脫（PostgreSQL 雙引號、其餘反引號；內部引號加倍）。
fn quote_ident(kind: DbKind, id: &str) -> String {
    match kind {
        DbKind::Postgres | DbKind::Oracle => format!("\"{}\"", id.replace('"', "\"\"")),
        DbKind::Mssql => format!("[{}]", id.replace(']', "]]")),
        _ => format!("`{}`", id.replace('`', "``")),
    }
}

/// 目標限定名：SQLite 不加 schema；其餘以 db.table 限定（確保建在指定庫 / schema）。
fn qualified(kind: DbKind, db: &str, table: &str) -> String {
    match kind {
        DbKind::Sqlite => quote_ident(kind, table),
        _ => format!("{}.{}", quote_ident(kind, db), quote_ident(kind, table)),
    }
}

/// 把來源建表 DDL 的表名換成目標表（限定到目標庫 / schema），保留 IF NOT EXISTS 與欄位定義原樣。
/// 作法：定位 `CREATE TABLE` 與其後第一個 `(`（欄位清單起點），把中間的（可能含 schema / 各式引號的）
/// 舊表名整段換成目標限定名——對 MySQL / PostgreSQL / SQLite 各種引號與限定寫法皆穩健。
pub fn rewrite_create_table_name(
    ddl: &str,
    dst_db: &str,
    dst_table: &str,
    kind: DbKind,
) -> AppResult<String> {
    let lower = ddl.to_ascii_lowercase();
    let ct = lower
        .find("create table")
        .ok_or_else(|| AppError::Query(t!("無法解析來源建表 DDL（找不到 CREATE TABLE）").into()))?;
    let after = ct + "create table".len();
    let paren_rel = ddl[after..]
        .find('(')
        .ok_or_else(|| AppError::Query(t!("來源建表 DDL 無欄位定義").into()))?;
    let paren = after + paren_rel;
    // 保留 IF NOT EXISTS（若原本就有）。
    let between = ddl[after..paren].to_ascii_lowercase();
    let ine = if between.contains("if not exists") { "IF NOT EXISTS " } else { "" };
    let head = &ddl[..ct]; // CREATE TABLE 之前的內容（通常為空）。
    let tail = &ddl[paren..]; // 從 '(' 起的欄位定義與其後選項。
    Ok(format!("{head}CREATE TABLE {ine}{} {tail}", qualified(kind, dst_db, dst_table)))
}

/// 把 `src` 表的資料傳輸到 `dst` 表（兩者可屬不同連線 / 資料庫）。
#[allow(clippy::too_many_arguments)]
pub async fn transfer_table(
    manager: &ConnectionManager,
    src_id: &str,
    src_db: &str,
    src_table: &str,
    dst_id: &str,
    dst_db: &str,
    dst_table: &str,
    opts: &TransferOptions,
) -> AppResult<TransferResult> {
    // 防呆：不可把表傳輸到它自己（會邊讀邊寫無限增長）。
    if src_id == dst_id && src_db == dst_db && src_table == dst_table {
        return Err(AppError::Query(t!("來源與目標是同一張表，無法傳輸").into()));
    }

    // Kafka 為訊息串流，非關聯表；不支援資料傳輸（來源或目標皆不可為 Kafka）。
    if matches!(manager.kind(src_id)?, DbKind::Kafka)
        || matches!(manager.kind(dst_id)?, DbKind::Kafka)
    {
        return Err(AppError::Unsupported(t!("Kafka 連線不支援資料傳輸").into()));
    }

    // Elasticsearch / OpenSearch 為搜尋引擎（文件 / DSL），非關聯表；不支援資料傳輸。
    if matches!(manager.kind(src_id)?, DbKind::Elastic)
        || matches!(manager.kind(dst_id)?, DbKind::Elastic)
    {
        return Err(AppError::Unsupported(t!("搜尋引擎類連線不支援資料傳輸").into()));
    }

    // 0. 目標表不存在且要求自動建表：沿用來源 DDL 建立（限同種類）。
    let mut created = false;
    if opts.create_table {
        let exists = manager
            .list_tables(dst_id, dst_db)
            .await?
            .iter()
            .any(|t| t.name == dst_table);
        if !exists {
            let src_kind = manager.kind(src_id)?;
            let dst_kind = manager.kind(dst_id)?;
            if src_kind != dst_kind {
                return Err(AppError::Query(
                    t!("自動建表僅支援相同資料庫種類；請先在目標手動建立資料表").into(),
                ));
            }
            let ddl = manager.table_ddl(src_id, src_db, src_table).await?;
            let create = rewrite_create_table_name(&ddl, dst_db, dst_table, dst_kind)?;
            manager.exec_ddl(dst_id, &create).await?;
            created = true;
        }
    }

    // 1. 欄位交集（同名），保留來源欄序；來源獨有者記為略過。
    let src_cols = manager.table_columns(src_id, src_db, src_table).await?;
    let dst_cols = manager.table_columns(dst_id, dst_db, dst_table).await?;
    let dst_names: HashSet<&str> = dst_cols.iter().map(|c| c.name.as_str()).collect();
    let mut columns: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for c in &src_cols {
        if dst_names.contains(c.name.as_str()) {
            columns.push(c.name.clone());
        } else {
            skipped.push(c.name.clone());
        }
    }
    if columns.is_empty() {
        return Err(AppError::Query(
            t!("來源與目標沒有同名欄位可傳輸；請確認目標表結構").into(),
        ));
    }

    // 2. 探主鍵以穩定分頁順序；無主鍵則以全部（交集）欄位排序，讓分頁順序確定，避免跨頁重複 / 漏列。
    let probe = manager
        .table_data(
            src_id,
            src_db,
            src_table,
            &DataQuery { page: 0, page_size: 1, filters: vec![], sorts: vec![], match_any: false, count: true },
        )
        .await?;
    let sort_cols = if probe.primary_key.is_empty() { &columns } else { &probe.primary_key };
    let sorts: Vec<Sort> = sort_cols
        .iter()
        .map(|c| Sort { column: c.clone(), dir: SortDir::Asc })
        .collect();

    let mut result = TransferResult {
        columns: columns.clone(),
        skipped_columns: skipped,
        created,
        ..Default::default()
    };
    let mut page = 0u32;
    let mut seen = 0u64;
    loop {
        let q = DataQuery {
            page,
            page_size: PAGE_SIZE,
            filters: vec![],
            sorts: sorts.clone(),
            match_any: false,
            count: false, // 資料傳輸逐頁抓完即止，不需要總數。
        };
        let pd = manager.table_data(src_id, src_db, src_table, &q).await?;
        // 交集欄位 → 來源結果欄索引（依 columns 順序取值）。
        let idx: Vec<Option<usize>> =
            columns.iter().map(|c| pd.columns.iter().position(|x| x == c)).collect();
        let fetched = pd.rows.len();
        for row in &pd.rows {
            let values: Vec<Option<String>> = idx
                .iter()
                .map(|oi| oi.and_then(|i| row.get(i).cloned().flatten()))
                .collect();
            let ins = RowInsert { columns: columns.clone(), values };
            match manager.insert_row(dst_id, dst_db, dst_table, &ins).await {
                Ok(_) => result.transferred += 1,
                Err(e) => {
                    result.failed += 1;
                    if result.errors.len() < MAX_ERRORS {
                        result.errors.push(e.to_string());
                    }
                    if opts.stop_on_error {
                        return Err(e);
                    }
                }
            }
            seen += 1;
        }
        if fetched < PAGE_SIZE as usize {
            break;
        }
        if seen >= pd.total_rows || seen >= MAX_ROWS {
            break;
        }
        page += 1;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::rewrite_create_table_name;
    use crate::db::DbKind;

    #[test]
    fn rewrite_mysql_backtick_name_qualifies_to_dst_db() {
        let ddl = "CREATE TABLE `old` (\n  `id` int NOT NULL\n) ENGINE=InnoDB";
        let got = rewrite_create_table_name(ddl, "shop", "newt", DbKind::Mysql).unwrap();
        assert_eq!(got, "CREATE TABLE `shop`.`newt` (\n  `id` int NOT NULL\n) ENGINE=InnoDB");
    }

    #[test]
    fn rewrite_pg_qualified_source_to_target_schema() {
        let ddl = "CREATE TABLE \"public\".\"old\" (\n  \"id\" integer\n);";
        let got = rewrite_create_table_name(ddl, "app", "newt", DbKind::Postgres).unwrap();
        assert_eq!(got, "CREATE TABLE \"app\".\"newt\" (\n  \"id\" integer\n);");
    }

    #[test]
    fn rewrite_sqlite_preserves_if_not_exists_and_no_schema() {
        let ddl = "CREATE TABLE IF NOT EXISTS old (id INTEGER PRIMARY KEY, name TEXT)";
        let got = rewrite_create_table_name(ddl, "main", "newt", DbKind::Sqlite).unwrap();
        assert_eq!(got, "CREATE TABLE IF NOT EXISTS `newt` (id INTEGER PRIMARY KEY, name TEXT)");
    }

    #[test]
    fn rewrite_case_insensitive_create_table() {
        let ddl = "create table old (id int)";
        let got = rewrite_create_table_name(ddl, "d", "newt", DbKind::Mysql).unwrap();
        assert_eq!(got, "CREATE TABLE `d`.`newt` (id int)");
    }

    #[test]
    fn rewrite_rejects_non_create_or_no_columns() {
        assert!(rewrite_create_table_name("SELECT 1", "d", "t", DbKind::Mysql).is_err());
        assert!(rewrite_create_table_name("CREATE TABLE x", "d", "t", DbKind::Mysql).is_err());
    }
}
