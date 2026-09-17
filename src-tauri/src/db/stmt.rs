//! 語句開頭關鍵字判讀：driver 決定一條 SQL 該走 fetch（取回結果集）還是 execute（只取受影響列數）。
//!
//! 每個 SQL driver 都要做這個分流，原本各自寫成 `sql.trim_start().starts_with("select")`，
//! 有兩個破口：
//!
//! - **前導註解**：`-- 查詢客戶\nSELECT …` 去掉空白後開頭是 `--`，比對不中 → 走 execute →
//!   回空結果集。使用者的體感是「同一條 SQL，反白時多框到上一行註解就沒有輸出了」。
//! - **前綴比對**：`starts_with("describe")` 認不得 MySQL 慣用的縮寫 `DESC users`，
//!   於是查看表結構這種純讀取的指令一律落到 execute，永遠回 0 列。
//!
//! 兩者都只是「怎麼取第一個關鍵字」錯了，所以集中成這一份：跳過前導空白與註解、取第一個
//! **完整字詞**比對。各 driver 只留自己方言的關鍵字清單。
//!
//! 同理，「語句裡有沒有 RETURNING」也不能拿原文 `contains` 去問 —— 註解或字串字面值裡的
//! `returning` 不是語法的一部分，得先用 [`code_only`] 把它們拿掉。

/// 跳過開頭的空白與註解（`-- …`、`# …`、`/* … */`），回傳語句真正的起點。
///
/// 註解可連續出現且互相夾雜；整段都是註解時回傳空字串。未閉合的 `/*` 視為吃到結尾
/// （與 DB 行為一致：那本來就是語法錯誤，交給 DB 報比較準）。
///
/// `#` 是 MySQL 的行註解。其他方言沒有以 `#` 起頭的合法語句（T-SQL 的 `#temp` 只出現在
/// 識別字位置），所以不分方言統一略過是安全的。
pub fn statement_head(sql: &str) -> &str {
    let mut s = sql;
    loop {
        s = s.trim_start();
        s = if let Some(r) = s.strip_prefix("--") {
            match r.find('\n') {
                Some(i) => &r[i + 1..],
                None => "",
            }
        } else if let Some(r) = s.strip_prefix('#') {
            match r.find('\n') {
                Some(i) => &r[i + 1..],
                None => "",
            }
        } else if let Some(r) = s.strip_prefix("/*") {
            match r.find("*/") {
                Some(i) => &r[i + 2..],
                None => "",
            }
        } else {
            return s;
        };
    }
}

/// 語句（略過前導註解後）的第一個字詞是否為 `kw`（不分大小寫）。
///
/// 需為**完整字詞**：`select` 不可比中識別字 `selectivity`，但 `select*`、`select(1)`
/// 這類沒有空白的寫法仍算命中。
pub fn head_is(sql: &str, kw: &str) -> bool {
    head_word_is(statement_head(sql), kw)
}

/// 任一關鍵字命中即為真。只掃一次前導註解，比逐個呼叫 [`head_is`] 省。
pub fn head_is_any(sql: &str, kws: &[&str]) -> bool {
    let head = statement_head(sql);
    kws.iter().any(|kw| head_word_is(head, kw))
}

fn head_word_is(head: &str, kw: &str) -> bool {
    // get(..) 在非字元邊界回 None —— 開頭是多位元組字元時自然不命中 ASCII 關鍵字。
    match head.get(..kw.len()) {
        Some(p) if p.eq_ignore_ascii_case(kw) => {
            !matches!(head[kw.len()..].chars().next(), Some(c) if c.is_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

/// 去掉註解與字串 / 識別字字面值後的語句（各整段換成一個空白，保持詞界）。
///
/// 供關鍵字掃描用：`INSERT … -- 之後可加 RETURNING` 的那個 returning 只是註記，
/// 拿原文 `contains("returning")` 去問會把它當成語法而誤走 fetch，丟掉受影響列數。
///
/// 位元組掃描只比對 ASCII 標記，UTF-8 續位元組（>= 0x80）不會與之相撞；略過的區段一律
/// 起訖於 ASCII 字元，因此保留下來的位元組仍是合法 UTF-8。
pub fn code_only(sql: &str) -> String {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out: Vec<u8> = Vec::with_capacity(n);
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        if c == b'\'' || c == b'"' || c == b'`' {
            let mut j = i + 1;
            while j < n {
                // MySQL / SQLite 允許以反斜線跳脫單引號；跳過被跳脫的那個位元組。
                if b[j] == b'\\' && c == b'\'' {
                    j += 2;
                    continue;
                }
                if b[j] == c {
                    // 連續兩個同引號是疊寫（'' / "" / ``），不是結尾。
                    if j + 1 < n && b[j + 1] == c {
                        j += 2;
                        continue;
                    }
                    j += 1;
                    break;
                }
                j += 1;
            }
            out.push(b' ');
            i = j;
            continue;
        }
        if (c == b'-' && b.get(i + 1) == Some(&b'-')) || c == b'#' {
            let mut j = i;
            while j < n && b[j] != b'\n' {
                j += 1;
            }
            out.push(b' ');
            i = j;
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            let mut j = i + 2;
            while j + 1 < n && !(b[j] == b'*' && b[j + 1] == b'/') {
                j += 1;
            }
            out.push(b' ');
            i = if j + 1 < n { j + 2 } else { n };
            continue;
        }
        out.push(c);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// 語句在「註解與字串字面值之外」是否含有 `word` 這個完整字詞（`word` 須為小寫）。
pub fn body_has_word(sql: &str, word: &str) -> bool {
    debug_assert!(word.bytes().all(|c| c.is_ascii_lowercase()));
    code_only(sql)
        .to_ascii_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|w| w == word)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_skips_leading_whitespace() {
        assert_eq!(statement_head("  \n\t SELECT 1"), "SELECT 1");
    }

    #[test]
    fn head_skips_line_and_block_comments() {
        // issue #5：反白時多框到上一行註解，語句本體不該因此被當成寫入。
        assert_eq!(statement_head("-- 查詢客戶\nSELECT 1"), "SELECT 1");
        assert_eq!(statement_head("/* 註解 */ SELECT 1"), "SELECT 1");
        assert_eq!(statement_head("# MySQL 行註解\nSELECT 1"), "SELECT 1");
        // 連續、混合、多行的註解都要一路跳過。
        assert_eq!(
            statement_head("-- a\n/* b\n   c */\n\n-- d\nSELECT 1"),
            "SELECT 1"
        );
    }

    #[test]
    fn head_of_comment_only_is_empty() {
        assert_eq!(statement_head("-- 只有註解"), "");
        assert_eq!(statement_head("/* 未閉合"), "");
        assert_eq!(statement_head("   "), "");
    }

    #[test]
    fn head_is_matches_whole_word_case_insensitively() {
        assert!(head_is("select 1", "select"));
        assert!(head_is("SeLeCt 1", "select"));
        assert!(head_is("SELECT(1)", "select"));
        assert!(head_is("SELECT*FROM t", "select"));
        // 不可比中以關鍵字起頭的識別字。
        assert!(!head_is("selectivity_report()", "select"));
        assert!(!head_is("describes", "describe"));
    }

    #[test]
    fn head_is_handles_desc_abbreviation() {
        // issue #6：DESC 是 DESCRIBE 的縮寫，前綴比對認不得，必須各自列為關鍵字。
        assert!(head_is("DESC users", "desc"));
        assert!(head_is("desc mydb.users", "desc"));
        assert!(head_is("DESCRIBE users", "describe"));
        // DESC 的清單比對不可誤傷 DESCRIBE 以外的字。
        assert!(!head_is("description_of()", "desc"));
    }

    #[test]
    fn head_is_any_matches_after_comments() {
        assert!(head_is_any("-- 註解\n  DESC users", &["select", "desc"]));
        assert!(!head_is_any("-- 註解\nINSERT INTO t VALUES (1)", &["select", "desc"]));
    }

    #[test]
    fn head_is_tolerates_non_ascii_start() {
        // 開頭是中文（多位元組）時 get(..len) 會落在非字元邊界，必須回 false 而非 panic。
        assert!(!head_is("這不是 SQL", "select"));
    }

    #[test]
    fn code_only_drops_comments_and_literals() {
        assert_eq!(code_only("SELECT 'a' FROM t -- x").trim_end(), "SELECT   FROM t");
        assert_eq!(code_only("SELECT /* x */ 1"), "SELECT   1");
        // 引號內的註解標記不是註解。
        assert_eq!(code_only("SELECT '-- 不是註解'"), "SELECT  ");
        // 疊寫的引號不是字串結尾。
        assert_eq!(code_only("SELECT 'it''s' , 1"), "SELECT   , 1");
        // 非 ASCII 內容原樣保留（不得因位元組掃描而損毀 UTF-8）。
        assert_eq!(code_only("SELECT 客戶 FROM t"), "SELECT 客戶 FROM t");
    }

    #[test]
    fn body_has_word_ignores_comments_and_literals() {
        assert!(body_has_word("INSERT INTO t VALUES (1) RETURNING id", "returning"));
        assert!(!body_has_word("INSERT INTO t VALUES (1) -- 之後可加 returning", "returning"));
        assert!(!body_has_word("INSERT INTO t VALUES ('returning')", "returning"));
        // 完整字詞：不可被 returning_at 之類的欄名帶偏。
        assert!(!body_has_word("INSERT INTO t (returning_at) VALUES (1)", "returning"));
    }
}
