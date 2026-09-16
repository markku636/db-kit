//! 依方言產生 SQL 片段的共用工具：識別字引號、限定名、字面值、簡單 DML。
//!
//! 過去 `transfer.rs`、`cli/dispatch.rs` 各自帶一份 `quote_ident` / `qualified`，且 transfer 的
//! MSSQL 版只給兩段式 `[db].[table]`（T-SQL 會把它讀成 *schema*.object 而找不到表）。
//! 統一落點於此：與前端 `sql.ts::qualifiedName` 同一套規則，同一份 SQL 由兩邊產生不可分歧。
//!
//! 不放 driver 內：driver 各有自己「只認單一方言」的 `quote_ident(&str)`；這裡是「給定 DbKind」
//! 的跨連線版本，供傳輸 / 比對 / CLI 等需要對*另一個*連線產 SQL 的模組使用。

use super::DbKind;

/// 識別字跳脫（PostgreSQL / Oracle 雙引號、MSSQL 中括號、其餘反引號；內部引號加倍）。
pub fn quote_ident(kind: DbKind, id: &str) -> String {
    match kind {
        DbKind::Postgres | DbKind::Oracle => format!("\"{}\"", id.replace('"', "\"\"")),
        DbKind::Mssql => format!("[{}]", id.replace(']', "]]")),
        _ => format!("`{}`", id.replace('`', "``")),
    }
}

/// 限定名：
/// - SQLite：單檔無 schema 概念，只給表名。
/// - SQL Server：三段式 `db.schema.table`——schema 取自表名中的 `schema.table` 前綴
///   （`list_tables` 對非 dbo 物件就是這樣回的），沒有則用 `dbo`。
/// - 其餘（MySQL 家族 / PostgreSQL / Oracle）：`db.table`，其中 PG / Oracle 的「db」本來就是 schema。
/// - `db` 為空：只給表名（呼叫端沒有庫名可限定時）。
pub fn qualified(kind: DbKind, db: &str, table: &str) -> String {
    if matches!(kind, DbKind::Sqlite) {
        return quote_ident(kind, table);
    }
    if matches!(kind, DbKind::Mssql) {
        let (schema, tbl) = match table.split_once('.') {
            Some((s, t)) => (s, t),
            None => ("dbo", table),
        };
        if db.is_empty() {
            return format!("{}.{}", quote_ident(kind, schema), quote_ident(kind, tbl));
        }
        return format!(
            "{}.{}.{}",
            quote_ident(kind, db),
            quote_ident(kind, schema),
            quote_ident(kind, tbl)
        );
    }
    if db.is_empty() {
        return quote_ident(kind, table);
    }
    format!("{}.{}", quote_ident(kind, db), quote_ident(kind, table))
}

/// 字串字面值（`None` → `NULL`）。
/// - MySQL 家族：反斜線是轉義字元，需加倍，否則含 `\` 的值會被吃掉。
/// - MSSQL：前置 `N` 以保 Unicode（否則非 ASCII 會被轉成 `?`）。
/// - 其餘：標準 SQL，只把單引號加倍。
pub fn sql_literal(kind: DbKind, v: Option<&str>) -> String {
    let Some(s) = v else { return "NULL".to_string() };
    match kind {
        DbKind::Mysql | DbKind::Mariadb | DbKind::External => {
            format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
        }
        DbKind::Mssql => format!("N'{}'", s.replace('\'', "''")),
        _ => format!("'{}'", s.replace('\'', "''")),
    }
}

/// `INSERT INTO q (cols) VALUES (vals)`。
pub fn insert_stmt(
    kind: DbKind,
    db: &str,
    table: &str,
    cols: &[String],
    vals: &[Option<String>],
) -> String {
    let c = cols.iter().map(|c| quote_ident(kind, c)).collect::<Vec<_>>().join(", ");
    let v = vals.iter().map(|v| sql_literal(kind, v.as_deref())).collect::<Vec<_>>().join(", ");
    format!("INSERT INTO {} ({c}) VALUES ({v})", qualified(kind, db, table))
}

/// `UPDATE q SET a = x, b = y WHERE pk = v`。主鍵值為 NULL 時以 `IS NULL` 比對。
pub fn update_stmt(
    kind: DbKind,
    db: &str,
    table: &str,
    set_cols: &[String],
    set_vals: &[Option<String>],
    pk_cols: &[String],
    pk_vals: &[Option<String>],
) -> String {
    let set = set_cols
        .iter()
        .zip(set_vals)
        .map(|(c, v)| format!("{} = {}", quote_ident(kind, c), sql_literal(kind, v.as_deref())))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "UPDATE {} SET {set} WHERE {}",
        qualified(kind, db, table),
        where_pk(kind, pk_cols, pk_vals)
    )
}

/// `DELETE FROM q WHERE pk = v`。
pub fn delete_stmt(
    kind: DbKind,
    db: &str,
    table: &str,
    pk_cols: &[String],
    pk_vals: &[Option<String>],
) -> String {
    format!("DELETE FROM {} WHERE {}", qualified(kind, db, table), where_pk(kind, pk_cols, pk_vals))
}

/// 主鍵條件：`a = 1 AND b IS NULL`。
pub fn where_pk(kind: DbKind, pk_cols: &[String], pk_vals: &[Option<String>]) -> String {
    pk_cols
        .iter()
        .zip(pk_vals)
        .map(|(c, v)| match v {
            Some(s) => format!("{} = {}", quote_ident(kind, c), sql_literal(kind, Some(s))),
            None => format!("{} IS NULL", quote_ident(kind, c)),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_per_dialect_and_escapes_inner_quotes() {
        assert_eq!(quote_ident(DbKind::Mysql, "or`ders"), "`or``ders`");
        assert_eq!(quote_ident(DbKind::Postgres, "or\"ders"), "\"or\"\"ders\"");
        assert_eq!(quote_ident(DbKind::Oracle, "ORDERS"), "\"ORDERS\"");
        assert_eq!(quote_ident(DbKind::Mssql, "or]ders"), "[or]]ders]");
    }

    #[test]
    fn qualifies_like_the_frontend() {
        // SQLite 單檔：只給表名（沿用前端的反引號寫法，SQLite 為相容 MySQL 亦接受）。
        assert_eq!(qualified(DbKind::Sqlite, "main", "orders"), "`orders`");
        // MySQL 家族 / PostgreSQL / Oracle：db.table（PG / Oracle 的 db 即 schema）。
        assert_eq!(qualified(DbKind::Mysql, "shop", "orders"), "`shop`.`orders`");
        assert_eq!(qualified(DbKind::Postgres, "public", "orders"), "\"public\".\"orders\"");
        // SQL Server 必須三段式：只給 db.table 會被 T-SQL 當成 schema.object。
        assert_eq!(qualified(DbKind::Mssql, "Reporting", "orders"), "[Reporting].[dbo].[orders]");
        assert_eq!(qualified(DbKind::Mssql, "Reporting", "sales.orders"), "[Reporting].[sales].[orders]");
        // 無庫名：退回可用的最短形式。
        assert_eq!(qualified(DbKind::Mysql, "", "orders"), "`orders`");
        assert_eq!(qualified(DbKind::Mssql, "", "sales.orders"), "[sales].[orders]");
    }

    #[test]
    fn literals_follow_dialect_escaping() {
        assert_eq!(sql_literal(DbKind::Mysql, None), "NULL");
        assert_eq!(sql_literal(DbKind::Mysql, Some("a\\b'c")), "'a\\\\b''c'");
        assert_eq!(sql_literal(DbKind::Postgres, Some("a\\b'c")), "'a\\b''c'");
        assert_eq!(sql_literal(DbKind::Mssql, Some("中'文")), "N'中''文'");
    }

    #[test]
    fn dml_builders_handle_null_pk() {
        let cols = vec!["id".to_string(), "name".to_string()];
        let vals = vec![Some("1".to_string()), None];
        assert_eq!(
            insert_stmt(DbKind::Mysql, "shop", "t", &cols, &vals),
            "INSERT INTO `shop`.`t` (`id`, `name`) VALUES ('1', NULL)"
        );
        let pk = vec!["a".to_string(), "b".to_string()];
        let pkv = vec![Some("1".to_string()), None];
        assert_eq!(
            update_stmt(DbKind::Postgres, "public", "t", &cols[1..], &vals[1..], &pk, &pkv),
            "UPDATE \"public\".\"t\" SET \"name\" = NULL WHERE \"a\" = '1' AND \"b\" IS NULL"
        );
        assert_eq!(
            delete_stmt(DbKind::Mssql, "db", "s.t", &pk, &pkv),
            "DELETE FROM [db].[s].[t] WHERE [a] = N'1' AND [b] IS NULL"
        );
    }
}
