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

/// 高破壞語句開頭關鍵字：整個物件 / 整批資料一次消失，且多半無法在交易外回復。
const DESTRUCTIVE: &[&str] = &["drop", "truncate"];

/// 寫入指令的確認守門：任何寫入都要 `--yes`；高破壞動作再要 `--force`。
/// `action` 是要印給使用者看的動作描述（未確認時原樣回報，等同預演）。
pub fn ensure_confirmed(yes: bool, force: bool, destructive: bool, action: &str) -> AppResult<()> {
    if !yes {
        return Err(AppError::NeedsConfirm(tf!(
            "此為寫入指令，未執行：{action}。確認無誤請加 --yes{extra}",
            action = action,
            extra = if destructive { " --force" } else { "" }
        )));
    }
    if destructive && !force {
        return Err(AppError::NeedsConfirm(tf!(
            "此為高破壞動作，未執行：{action}。請再加 --force 確認",
            action = action
        )));
    }
    Ok(())
}

/// 判斷一段 SQL 是否含高破壞語句：DROP / TRUNCATE，或沒有 WHERE 的 UPDATE / DELETE
///（後者會掃過整張表，與 GUI 資料格的「危險操作確認」同一條判準）。
pub fn is_destructive_sql(sql: &str) -> bool {
    for stmt in split_statements(sql) {
        let kw = first_keyword(stmt);
        if kw.is_empty() {
            continue;
        }
        if DESTRUCTIVE.contains(&kw.as_str()) {
            return true;
        }
        // WHERE 要在「真正的程式碼」上找，且只認頂層的：
        // - 不剝註解 / 字串 → `DELETE FROM logs -- WHERE id = 1`（使用者把條件註解掉試最壞情況）
        //   會被判成安全，然後在壓測迴圈裡把整張表清光。
        // - 不剝括號 → `UPDATE t SET a = (SELECT x FROM y WHERE z)` 的 WHERE 在子查詢裡，
        //   頂層其實沒有條件，一樣掃全表。
        // 與前端 sql.ts::isDangerousStatement 的 stripCode + stripParens 是同一套判準。
        if (kw == "update" || kw == "delete")
            && !contains_keyword(&strip_parens(&strip_noncode(stmt)).to_ascii_lowercase(), "where")
        {
            return true;
        }
    }
    false
}

/// 把字串 / 識別字 / 註解 / dollar-quote 的內容換成空白，只留下可供關鍵字比對的程式碼。
/// 掃描規則與 `split_statements` 相同（同一套引號與註解處理），差別只在輸出。
fn strip_noncode(sql: &str) -> String {
    let b = sql.as_bytes();
    let n = b.len();
    let is_tag = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = String::with_capacity(n);
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        let nx = if i + 1 < n { b[i + 1] } else { 0 };
        match c {
            b'\'' | b'"' | b'`' => {
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
                out.push(' ');
            }
            b'-' if nx == b'-' => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
                out.push(' ');
            }
            b'/' if nx == b'*' => {
                i += 2;
                while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(n);
                out.push(' ');
            }
            b'$' => {
                // dollar-quote：$tag$ … $tag$（tag 可空）。找不到收尾標記就當普通字元。
                let mut j = i + 1;
                while j < n && is_tag(b[j]) {
                    j += 1;
                }
                if j < n && b[j] == b'$' {
                    let tag = &sql[i..=j];
                    match sql[j + 1..].find(tag) {
                        Some(rel) => {
                            i = j + 1 + rel + tag.len();
                            out.push(' ');
                        }
                        None => {
                            out.push('$');
                            i += 1;
                        }
                    }
                } else {
                    out.push('$');
                    i += 1;
                }
            }
            // 非 ASCII 一律換成空白：關鍵字比對只認 ASCII，而逐位元組 `as char` 會把
            // UTF-8 續位元組解成 Latin-1 的怪字元。換空白同時保住了字界語意。
            _ if c >= 0x80 => {
                out.push(' ');
                i += 1;
            }
            _ => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    out
}

/// 移除所有成對括號內的內容（只留 depth-0 的文字），供「頂層是否有 WHERE」的判斷。
/// 與前端 sql.ts::stripParens 同一個理由：子查詢裡的 WHERE 不算數。
fn strip_parens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for ch in s.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
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
    use super::{ensure_confirmed, ensure_read_only, is_destructive_sql};

    #[test]
    fn write_needs_yes_and_destructive_needs_force() {
        // 一般寫入：--yes 即可。
        assert!(ensure_confirmed(false, false, false, "x").is_err());
        assert!(ensure_confirmed(true, false, false, "x").is_ok());
        // 高破壞：--yes 之外還要 --force；只給 --force 不算數。
        assert!(ensure_confirmed(true, false, true, "x").is_err());
        assert!(ensure_confirmed(false, true, true, "x").is_err());
        assert!(ensure_confirmed(true, true, true, "x").is_ok());
    }

    #[test]
    fn detects_destructive_sql() {
        assert!(is_destructive_sql("drop table t"));
        assert!(is_destructive_sql("TRUNCATE TABLE t"));
        assert!(is_destructive_sql("delete from t"));
        assert!(is_destructive_sql("update t set a=1"));
        assert!(is_destructive_sql("insert into t values (1); drop table u"));
        // 有 WHERE 的 UPDATE / DELETE 屬一般寫入；欄名含 where 字根不誤判成有 WHERE。
        assert!(!is_destructive_sql("delete from t where id=1"));
        assert!(!is_destructive_sql("update t set a=1 where id=1"));
        assert!(!is_destructive_sql("insert into t values (1)"));
        assert!(is_destructive_sql("delete from t /* nowhere */"));
    }

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

    #[test]
    fn destructive_detects_drop_truncate_and_bare_dml() {
        assert!(is_destructive_sql("DROP TABLE t"));
        assert!(is_destructive_sql("truncate table t"));
        assert!(is_destructive_sql("DELETE FROM t"));
        assert!(is_destructive_sql("UPDATE t SET a = 1"));
        // 帶 WHERE 的 DML 不算高破壞；欄名含 where 字根不誤判成有條件。
        assert!(!is_destructive_sql("DELETE FROM t WHERE id = 1"));
        assert!(!is_destructive_sql("UPDATE t SET a = 1 WHERE id = 1"));
        assert!(!is_destructive_sql("SELECT * FROM t"));
    }

    #[test]
    fn destructive_ignores_where_hidden_in_comments_and_literals() {
        // 註解掉的 WHERE 不是條件：整句仍會掃全表，必須判為高破壞。
        assert!(is_destructive_sql("DELETE FROM logs -- WHERE id = 1"));
        assert!(is_destructive_sql("DELETE FROM logs /* WHERE id = 1 */"));
        assert!(is_destructive_sql("UPDATE t SET a = 1 --where x"));
        // 字串字面值裡的 where 同理不算條件。
        assert!(is_destructive_sql("UPDATE t SET note = 'where'"));
        assert!(is_destructive_sql("DELETE FROM t /* keep */ -- where\n"));
        // 但真正的 WHERE 即使旁邊有註解 / 字串仍算數。
        assert!(!is_destructive_sql("DELETE FROM t -- 清掉舊資料\nWHERE id = 1"));
        assert!(!is_destructive_sql("UPDATE t SET note = 'where' WHERE id = 1"));
    }

    #[test]
    fn destructive_only_counts_top_level_where() {
        // 子查詢裡的 WHERE 不是本句的條件：這句會改到每一列。
        assert!(is_destructive_sql(
            "UPDATE t SET a = (SELECT x FROM y WHERE y.id = 1)"
        ));
        assert!(is_destructive_sql(
            "DELETE FROM t USING (SELECT id FROM y WHERE y.n > 0) s"
        ));
        // 頂層有 WHERE 就算安全，即使子查詢裡也有一個。
        assert!(!is_destructive_sql(
            "UPDATE t SET a = (SELECT x FROM y WHERE y.id = 1) WHERE t.id = 2"
        ));
    }
}
