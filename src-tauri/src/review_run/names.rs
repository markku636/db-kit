//! 物件參照解析：把語句裡寫的 `` `shop`.`orders` o `` / `"public"."Orders" AS x` / `[db].[dbo].[t]`
//! 拆成（資料庫 / schema、表名、別名），並套用各方言「未加引號識別字」的大小寫折疊。
//!
//! 名稱的形狀對齊 `list_tables` 回的形式，後續 `table_columns` / `qualified()` 才對得上：
//! - MySQL 家族：`db.table`（db 省略 = 目前資料庫）。
//! - PostgreSQL：`schema.table`；三段式 `db.schema.table` 的 db 略過（PG 不能跨庫查詢）。
//! - SQL Server：`db.schema.table`；dbo 的表回裸名、其他 schema 回 `schema.table`。
//! - Oracle：`owner.table`，未加引號折成大寫。
//! - SQLite：只有 `main.table` / `table`。

use serde::Serialize;

use super::scan::{is_ident_byte, Masked};
use crate::db::DbKind;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObjRef {
    /// 語句裡的原文（不含別名），重組前像查詢時原樣使用。
    pub text: String,
    /// 解析出的資料庫 / schema；None = 語句沒有限定，用目前資料庫。
    pub db: Option<String>,
    /// 與 `list_tables` 同形的名稱（MSSQL 非 dbo 為 `schema.table`）。
    pub name: String,
    pub alias: Option<String>,
}

impl ObjRef {
    /// 欄位限定詞：有別名用別名，否則用表名最後一段的原文寫法（`orders.id` 在各方言都合法，
    /// 四段式 `[db].[dbo].[t].[c]` 在 T-SQL 反而不合法）。
    pub fn column_qualifier(&self, kind: DbKind) -> String {
        if let Some(a) = &self.alias {
            return a.clone();
        }
        match split_parts(kind, &self.text) {
            Some(parts) if !parts.is_empty() => parts.last().unwrap().raw.clone(),
            _ => self.text.clone(),
        }
    }

    pub fn db_or<'a>(&'a self, current: &'a str) -> &'a str {
        self.db.as_deref().unwrap_or(current)
    }
}

#[derive(Debug, Clone)]
struct Part {
    /// 原文（含引號）。
    raw: String,
    /// 去引號、套用折疊後的值。
    value: String,
    quoted: bool,
}

/// 識別字關鍵字：出現在表名之後代表「表名已結束」，不可當成別名吃掉。
const NOT_ALIAS: &[&str] = &[
    "set", "where", "join", "inner", "left", "right", "full", "cross", "natural", "straight_join", "on", "using",
    "from", "output", "returning", "values", "value", "select", "with", "default", "partition", "order", "limit",
    "group", "having", "union", "cascade", "restrict", "purge", "restart", "continue", "drop", "reuse", "add",
    "modify", "change", "alter", "rename", "if", "only", "table", "into", "for", "when", "then", "top", "window",
    "force", "use", "ignore", "tablesample", "as",
];

fn fold(kind: DbKind, s: &str) -> String {
    match kind {
        DbKind::Postgres => s.to_lowercase(),
        DbKind::Oracle => s.to_uppercase(),
        _ => s.to_string(),
    }
}

/// 把 `a.b."c"` 拆成段。遇到無法辨識的字元回 None。
fn split_parts(kind: DbKind, text: &str) -> Option<Vec<Part>> {
    let b = text.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    let mut parts = Vec::new();
    loop {
        while i < n && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= n {
            return None;
        }
        let start = i;
        let (value, quoted) = match b[i] {
            q @ (b'"' | b'`') => {
                let mut j = i + 1;
                let mut v = Vec::new();
                loop {
                    if j >= n {
                        return None;
                    }
                    if b[j] == q {
                        if j + 1 < n && b[j + 1] == q {
                            v.push(q);
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    v.push(b[j]);
                    j += 1;
                }
                i = j + 1;
                (String::from_utf8(v).ok()?, true)
            }
            b'[' if kind == DbKind::Mssql => {
                let mut j = i + 1;
                let mut v = Vec::new();
                loop {
                    if j >= n {
                        return None;
                    }
                    if b[j] == b']' {
                        if j + 1 < n && b[j + 1] == b']' {
                            v.push(b']');
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    v.push(b[j]);
                    j += 1;
                }
                i = j + 1;
                (String::from_utf8(v).ok()?, true)
            }
            c if is_ident_byte(c) || c == b'#' || c == b'@' => {
                let mut j = i + 1;
                while j < n && (is_ident_byte(b[j]) || b[j] == b'#') {
                    j += 1;
                }
                i = j;
                (fold(kind, &text[start..j]), false)
            }
            _ => return None,
        };
        parts.push(Part { raw: text[start..i].to_string(), value, quoted });
        while i < n && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < n && b[i] == b'.' {
            i += 1;
            continue;
        }
        break;
    }
    if i != n {
        return None;
    }
    Some(parts)
}

/// 解析「表參照 [AS] [別名]」。`text` 應是單一來源（不含 JOIN / 逗號）。
/// 回 None = 形狀不認得（子查詢、函式、表值參數…）。
pub fn parse_obj_ref(kind: DbKind, text: &str) -> Option<ObjRef> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let m = Masked::new(kind, text);
    // PG 的 `ONLY t`：ONLY 是修飾詞，不是表名。
    let mut body_start = 0usize;
    if kind == DbKind::Postgres {
        if let Some(e) = m.phrase_at(0, &["only"]) {
            body_start = m.skip_ws(e);
        }
    }
    // 名稱主體：從起點吃到「深度 0 的空白」為止，但 `.` 兩側可有空白的寫法少見，不支援。
    let mut end = body_start;
    while end < m.len() && !m.mask[end].is_ascii_whitespace() && m.mask[end] != b'(' {
        end += 1;
    }
    if end < m.len() && m.mask[end] == b'(' {
        return None; // 函式 / 表值函式 / 欄位清單
    }
    let name_text = &text[body_start..end];
    let parts = split_parts(kind, name_text)?;
    let rest = text[end..].trim();
    let alias = if rest.is_empty() {
        None
    } else {
        let rm = Masked::new(kind, rest);
        let after_as = rm.phrase_at(0, &["as"]).map(|e| rm.skip_ws(e)).unwrap_or(0);
        let alias_text = rest[after_as..].trim();
        let ap = split_parts(kind, alias_text)?;
        if ap.len() != 1 {
            return None;
        }
        if !ap[0].quoted && NOT_ALIAS.contains(&ap[0].value.to_ascii_lowercase().as_str()) {
            return None;
        }
        Some(ap[0].raw.clone())
    };
    let (db, name) = map_parts(kind, &parts)?;
    Some(ObjRef { text: name_text.to_string(), db, name, alias })
}

fn map_parts(kind: DbKind, p: &[Part]) -> Option<(Option<String>, String)> {
    match kind {
        DbKind::Mssql => {
            // [server].[db].[schema].[t] 四段式走 linked server，不支援。
            let (db, schema, t) = match p.len() {
                1 => (None, None, &p[0]),
                2 => (None, Some(&p[0]), &p[1]),
                3 => (Some(&p[0]), Some(&p[1]), &p[2]),
                _ => return None,
            };
            // `db..table`（省略 schema）不會進到這裡——split_parts 遇到空段就失敗。
            let name = match schema {
                Some(s) if !s.value.eq_ignore_ascii_case("dbo") => format!("{}.{}", s.value, t.value),
                _ => t.value.clone(),
            };
            Some((db.map(|d| d.value.clone()), name))
        }
        DbKind::Postgres => match p.len() {
            1 => Some((None, p[0].value.clone())),
            2 => Some((Some(p[0].value.clone()), p[1].value.clone())),
            3 => Some((Some(p[1].value.clone()), p[2].value.clone())),
            _ => None,
        },
        DbKind::Sqlite => match p.len() {
            1 => Some((None, p[0].value.clone())),
            // 只認 main；temp / attached 庫在 db-kit 的連線模型裡不存在。
            2 if p[0].value.eq_ignore_ascii_case("main") => Some((None, p[1].value.clone())),
            _ => None,
        },
        _ => match p.len() {
            1 => Some((None, p[0].value.clone())),
            2 => Some((Some(p[0].value.clone()), p[1].value.clone())),
            _ => None,
        },
    }
}

/// 從 `list_tables` 的結果裡找出語句指的那張表：先精確比對，再退「不分大小寫且唯一」
/// （MySQL on Windows / MSSQL 的 CI 定序 / 使用者在 PG 寫了加引號但大小寫不同的名字）。
pub fn resolve_name<'a>(wanted: &str, existing: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let all: Vec<&str> = existing.into_iter().collect();
    if let Some(hit) = all.iter().find(|n| **n == wanted) {
        return Some((*hit).to_string());
    }
    let ci: Vec<&&str> = all.iter().filter(|n| n.eq_ignore_ascii_case(wanted)).collect();
    if ci.len() == 1 {
        return Some((*ci[0]).to_string());
    }
    None
}

/// 解析 `(a, "b", [c])` 形式的欄位清單（INSERT 的欄位 / SET 左側用）。
pub fn parse_column_list(kind: DbKind, text: &str) -> Option<Vec<String>> {
    let t = text.trim();
    let inner = t.strip_prefix('(')?.strip_suffix(')')?;
    let m = Masked::new(kind, inner);
    let mut cols = Vec::new();
    for (a, b) in m.split_top(0, inner.len(), b',') {
        cols.push(column_name(kind, &inner[a..b])?);
    }
    if cols.is_empty() {
        None
    } else {
        Some(cols)
    }
}

/// 單一欄位參照（可帶表 / 別名限定詞），回傳去引號、套用折疊後的欄名。
pub fn column_name(kind: DbKind, text: &str) -> Option<String> {
    let parts = split_parts(kind, text.trim())?;
    parts.last().map(|p| p.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(kind: DbKind, s: &str) -> ObjRef {
        parse_obj_ref(kind, s).unwrap_or_else(|| panic!("無法解析：{s}"))
    }

    #[test]
    fn mysql_refs() {
        let o = r(DbKind::Mysql, "`shop`.`orders` o");
        assert_eq!((o.db.as_deref(), o.name.as_str(), o.alias.as_deref()), (Some("shop"), "orders", Some("o")));
        assert_eq!(o.column_qualifier(DbKind::Mysql), "o");
        let o = r(DbKind::Mysql, "orders");
        assert_eq!((o.db, o.name.as_str(), o.alias), (None, "orders", None));
        let o = r(DbKind::Mysql, "shop.orders AS x");
        assert_eq!(o.alias.as_deref(), Some("x"));
        assert_eq!(r(DbKind::Mysql, "shop.orders").column_qualifier(DbKind::Mysql), "orders");
        // 中文表名、反引號內的點。
        assert_eq!(r(DbKind::Mysql, "客戶").name, "客戶");
        assert_eq!(r(DbKind::Mysql, "`a.b`").name, "a.b");
    }

    #[test]
    fn postgres_folds_unquoted_and_skips_only() {
        let o = r(DbKind::Postgres, "Public.Orders");
        assert_eq!((o.db.as_deref(), o.name.as_str()), (Some("public"), "orders"));
        let o = r(DbKind::Postgres, "\"Public\".\"Orders\" AS \"O\"");
        assert_eq!((o.db.as_deref(), o.name.as_str(), o.alias.as_deref()), (Some("Public"), "Orders", Some("\"O\"")));
        let o = r(DbKind::Postgres, "ONLY orders");
        assert_eq!(o.name, "orders");
        let o = r(DbKind::Postgres, "mydb.public.orders");
        assert_eq!(o.db.as_deref(), Some("public"));
    }

    #[test]
    fn mssql_schema_shapes_match_list_tables() {
        assert_eq!(r(DbKind::Mssql, "[Shop].[dbo].[Orders]").name, "Orders");
        assert_eq!(r(DbKind::Mssql, "[Shop].[dbo].[Orders]").db.as_deref(), Some("Shop"));
        assert_eq!(r(DbKind::Mssql, "sales.Orders").name, "sales.Orders");
        assert_eq!(r(DbKind::Mssql, "dbo.Orders o").name, "Orders");
        assert_eq!(r(DbKind::Mssql, "[Order Items]").name, "Order Items");
        assert!(parse_obj_ref(DbKind::Mssql, "srv.db.dbo.t").is_none());
    }

    #[test]
    fn oracle_uppercases() {
        let o = r(DbKind::Oracle, "hr.employees e");
        assert_eq!((o.db.as_deref(), o.name.as_str(), o.alias.as_deref()), (Some("HR"), "EMPLOYEES", Some("e")));
    }

    #[test]
    fn rejects_non_table_shapes() {
        assert!(parse_obj_ref(DbKind::Mysql, "(SELECT 1) x").is_none());
        assert!(parse_obj_ref(DbKind::Mysql, "a JOIN b").is_none());
        assert!(parse_obj_ref(DbKind::Mysql, "orders SET").is_none());
        assert!(parse_obj_ref(DbKind::Postgres, "generate_series(1,3)").is_none());
    }

    #[test]
    fn resolves_case_insensitively_only_when_unique() {
        assert_eq!(resolve_name("Orders", ["orders", "items"]).as_deref(), Some("orders"));
        assert_eq!(resolve_name("orders", ["orders", "Orders"]).as_deref(), Some("orders"));
        assert_eq!(resolve_name("ORDERS", ["orders", "Orders"]), None);
    }

    #[test]
    fn column_lists() {
        assert_eq!(
            parse_column_list(DbKind::Mysql, "(`id`, name, t.`x`)"),
            Some(vec!["id".to_string(), "name".to_string(), "x".to_string()])
        );
        assert_eq!(parse_column_list(DbKind::Oracle, "(id, \"Name\")"), Some(vec!["ID".to_string(), "Name".to_string()]));
    }
}
