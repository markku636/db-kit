//! 唯讀 SQL 守門。`query` / `explain` 送 manager 前先過此檢查，擋下非查詢語句，
//! 兌現「只查詢不刪除」。逐句（`;` 切）取首個有效關鍵字（跳過前導註解），
//! 只放行查詢類語句。建議搭配唯讀 DB 帳號作第二道防線。

use crate::error::{AppError, AppResult};

/// 允許的語句開頭關鍵字（皆為唯讀 / 查詢類）。
const ALLOWED: &[&str] = &[
    "select", "with", "show", "describe", "desc", "explain", "pragma", "use", "values", "table",
];

/// 可寫 CTE 偵測用的寫入關鍵字。
const CTE_WRITE: &[&str] = &["insert", "update", "delete", "merge"];

pub fn ensure_read_only(sql: &str) -> AppResult<()> {
    for stmt in split_statements(sql) {
        let kw = first_keyword(stmt);
        if kw.is_empty() {
            continue; // 空句 / 純註解
        }
        if !ALLOWED.contains(&kw.as_str()) {
            return Err(AppError::Query(tf!(
                "CLI 為唯讀模式，僅允許查詢語句（偵測到 `{kw}`）",
                kw = kw
            )));
        }
        // PostgreSQL 可寫 CTE：`WITH x AS (DELETE …) …` 首關鍵字為 with（被允許），
        // 但實際會改資料。含寫入關鍵字即擋下（寧可多擋）。
        if kw == "with" {
            let lower = stmt.to_ascii_lowercase();
            if let Some(w) = CTE_WRITE.iter().find(|w| contains_keyword(&lower, w)) {
                return Err(AppError::Query(tf!(
                    "CLI 為唯讀模式，偵測到可寫 CTE（含 `{w}`）",
                    w = w
                )));
            }
        }
    }
    Ok(())
}

/// 以「字界」判斷 haystack（已小寫）是否含關鍵字 word（避免 `deleted_at` 誤判為 `delete`）。
fn contains_keyword(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(word) {
        let i = start + pos;
        let before_ok = i == 0 || !is_word(bytes[i - 1]);
        let after = i + word.len();
        let after_ok = after >= bytes.len() || !is_word(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
        start = i + 1;
    }
    false
}

/// 以分號切分多條語句，但略過字串 / 識別字（' " `）、註解（-- 行、/* */ 區塊）與 PostgreSQL
/// dollar-quote（$$ … $$ / $tag$ … $tag$）內的分號——與前端 splitSqlStatements 同套規則，
/// 避免把字串裡的 `;` 誤判成語句邊界而錯擋合法查詢（如 `LIKE '%a; b%'`）。只會切得更精準，
/// 不會少切真正的語句邊界，故所有寫入語句仍各自成句受檢，唯讀防護不被削弱。
/// 位元組掃描僅比對 ASCII 標記，UTF-8 連續位元組（≥0x80）不會與其相撞，切點亦落在字元邊界。
fn split_statements(sql: &str) -> Vec<&str> {
    let b = sql.as_bytes();
    let n = b.len();
    let is_tag = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        let nx = if i + 1 < n { b[i + 1] } else { 0 };
        match c {
            b'\'' | b'"' | b'`' => {
                // 字串 / 識別字：找對應結束引號（連續兩個同引號視為跳脫）。
                i += 1;
                while i < n {
                    if b[i] == c {
                        if i + 1 < n && b[i + 1] == c {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'-' if nx == b'-' => {
                i += 2;
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if nx == b'*' => {
                i += 2;
                while i < n && !(b[i] == b'*' && i + 1 < n && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(n);
            }
            b'$' => {
                // PostgreSQL dollar-quote 開頭 $tag$（tag 為 [A-Za-z0-9_]*）；否則當一般字元。
                let mut j = i + 1;
                while j < n && is_tag(b[j]) {
                    j += 1;
                }
                if j < n && b[j] == b'$' {
                    let tag = &sql[i..=j];
                    let tlen = tag.len();
                    i = j + 1;
                    while i < n {
                        if b[i] == b'$' && i + tlen <= n && &sql[i..i + tlen] == tag {
                            i += tlen;
                            break;
                        }
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
            b';' => {
                out.push(&sql[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < n {
        out.push(&sql[start..n]);
    }
    out
}

/// 取語句的第一個關鍵字（小寫），跳過前導空白與行 / 區塊註解。
fn first_keyword(stmt: &str) -> String {
    let mut s = stmt.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            match rest.find('\n') {
                Some(i) => s = rest[i + 1..].trim_start(),
                None => return String::new(),
            }
        } else if let Some(rest) = s.strip_prefix("/*") {
            match rest.find("*/") {
                Some(i) => s = rest[i + 2..].trim_start(),
                None => return String::new(),
            }
        } else {
            break;
        }
    }
    s.split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::ensure_read_only;

    #[test]
    fn allows_select_and_friends() {
        assert!(ensure_read_only("select * from t").is_ok());
        assert!(ensure_read_only("  SELECT 1").is_ok());
        assert!(ensure_read_only("WITH x AS (select 1) select * from x").is_ok());
        assert!(ensure_read_only("show tables").is_ok());
        assert!(ensure_read_only("-- c\nselect 1").is_ok());
        assert!(ensure_read_only("/* c */ explain select 1").is_ok());
    }

    #[test]
    fn blocks_writes() {
        assert!(ensure_read_only("delete from t").is_err());
        assert!(ensure_read_only("update t set x=1").is_err());
        assert!(ensure_read_only("insert into t values (1)").is_err());
        assert!(ensure_read_only("drop table t").is_err());
        assert!(ensure_read_only("select 1; delete from t").is_err());
    }

    #[test]
    fn blocks_writable_cte_but_allows_readonly_cte() {
        // 可寫 CTE 應被擋（首關鍵字 with 雖被允許，但實際改資料）。
        assert!(ensure_read_only("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d").is_err());
        assert!(ensure_read_only("with u as (UPDATE t SET a=1 RETURNING id) select * from u").is_err());
        assert!(ensure_read_only("WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i").is_err());
        // 唯讀 CTE 照常放行；欄名含 delete 字根（deleted_at）不誤判。
        assert!(ensure_read_only("WITH x AS (SELECT deleted_at FROM t) SELECT * FROM x").is_ok());
    }

    #[test]
    fn does_not_split_on_semicolons_inside_literals_or_comments() {
        // 字串字面值內的 `;` 與寫入字樣不可被當成語句邊界（原 naive split 會誤擋）。
        assert!(ensure_read_only("SELECT * FROM logs WHERE msg LIKE '%error; retry%'").is_ok());
        assert!(ensure_read_only("SELECT 'a; delete from t' AS note").is_ok());
        assert!(ensure_read_only("SELECT ';' /* ; delete */ , 1").is_ok());
        // 反引號識別字內含 `;` 亦然。
        assert!(ensure_read_only("SELECT `a;b` FROM t").is_ok());
        // 但真正的語句邊界仍切分受檢：字串後的真分號接寫入要擋。
        assert!(ensure_read_only("SELECT 'ok'; DELETE FROM t").is_err());
        assert!(ensure_read_only("SELECT 1 /* c */ ; drop table t").is_err());
    }

    #[test]
    fn ignores_semicolons_inside_dollar_quotes() {
        // dollar-quote 函式本體含分號不應被切；首句為唯讀 DO/SELECT 才放行。
        assert!(ensure_read_only("SELECT $$a; delete from t$$ AS body").is_ok());
        assert!(ensure_read_only("SELECT $tag$x; update y$tag$ AS body").is_ok());
    }
}
