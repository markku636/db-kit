//! 位移保留式 SQL 掃描：前端 `impact.ts::maskSql` 的 Rust 版，外加語句切分。
//!
//! 為什麼不用 `cli::guard` 的 `strip_noncode`：那支把字串 / 註解塌成空白，服務的是「有沒有某個
//! 關鍵字」這種布林判斷；這裡要「從 WHERE 切到句尾」再拿**原文**重組前像查詢（引號、大小寫、
//! schema 前綴都得保真），必須保住每個位元組的位置。
//!
//! 以位元組為單位：遮罩與原文等長，所有切點都落在 ASCII 位元組（關鍵字、標點、空白）上，
//! 因此 `&src[a..b]` 一定是合法的 UTF-8 邊界。非 ASCII 位元組只可能出現在識別字 / 字面值 /
//! 註解裡（前兩者被 FILL、後者被空白取代），或是 MySQL 允許的未加引號中文識別字——那種情況
//! 原樣保留，並視為識別字字元（見 `is_ident_byte`）。

use crate::db::DbKind;

/// 字面值 / 引號識別字的填充位元組：非空白、非運算子，被遮住的區塊仍算「一個 token」，
/// `UPDATE'x'SET` 不會黏成一個字。註解則遮成空白（註解本來就是分隔符）。
pub const FILL: u8 = 0x01;

pub struct Masked<'a> {
    /// 原文（重組 SQL 一律從這裡切）。
    pub src: &'a str,
    /// 與 src 等長：字面值 / 引號識別字 / dollar-quote → FILL；註解 → 空白；其餘原樣。
    pub mask: Vec<u8>,
    /// 與 src 等長：該位移的括號深度（`(` 與 `)` 都記「外層」深度）。
    pub depth: Vec<u32>,
}

fn mysql_family(kind: DbKind) -> bool {
    matches!(kind, DbKind::Mysql | DbKind::Mariadb | DbKind::External)
}

/// 識別字字元：字母、數字、底線、`$`（MySQL / Oracle 識別字可含）與非 ASCII（未加引號的中文表名）。
pub fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

impl<'a> Masked<'a> {
    pub fn new(kind: DbKind, src: &'a str) -> Masked<'a> {
        let b = src.as_bytes();
        let n = b.len();
        let mut mask = vec![0u8; n];
        let mut depth = vec![0u32; n];
        // MySQL 家族預設把 \ 當字串轉義；PostgreSQL（standard_conforming_strings）/ SQLite / MSSQL 不認。
        let backslash = mysql_family(kind);
        let mut d = 0u32;
        let mut i = 0usize;
        let fill = |mask: &mut [u8], depth: &mut [u32], from: usize, to: usize, ch: u8, d: u32| {
            for k in from..to {
                mask[k] = ch;
                depth[k] = d;
            }
        };
        while i < n {
            let c = b[i];
            let nx = if i + 1 < n { b[i + 1] } else { 0 };
            // 行註解：`--` 各方言通用；`#` 只有 MySQL 家族（PG 的 # 是 XOR 運算子）。
            if (c == b'-' && nx == b'-') || (c == b'#' && mysql_family(kind)) {
                let stop = b[i..].iter().position(|&x| x == b'\n').map(|p| i + p).unwrap_or(n);
                fill(&mut mask, &mut depth, i, stop, b' ', d);
                i = stop;
                continue;
            }
            if c == b'/' && nx == b'*' {
                let stop = find_bytes(b, b"*/", i + 2).map(|p| p + 2).unwrap_or(n);
                fill(&mut mask, &mut depth, i, stop, b' ', d);
                i = stop;
                continue;
            }
            if c == b'\'' || c == b'"' || c == b'`' {
                let pg_e = kind == DbKind::Postgres
                    && c == b'\''
                    && i >= 1
                    && (b[i - 1] == b'E' || b[i - 1] == b'e')
                    && (i < 2 || !is_ident_byte(b[i - 2]));
                // 反引號是識別字，只認加倍轉義。
                let esc = c != b'`' && (backslash || pg_e);
                let mut j = i + 1;
                while j < n {
                    if esc && b[j] == b'\\' {
                        j += 2;
                        continue;
                    }
                    if b[j] == c {
                        if j + 1 < n && b[j + 1] == c {
                            j += 2;
                            continue;
                        }
                        j += 1;
                        break;
                    }
                    j += 1;
                }
                let stop = j.min(n);
                fill(&mut mask, &mut depth, i, stop, FILL, d);
                i = stop;
                continue;
            }
            // [識別字] 只在 MSSQL 認：其他方言的 `[` 可能是 PG 陣列下標。
            if c == b'[' && kind == DbKind::Mssql {
                let mut j = i + 1;
                while j < n {
                    if b[j] == b']' {
                        if j + 1 < n && b[j + 1] == b']' {
                            j += 2;
                            continue;
                        }
                        j += 1;
                        break;
                    }
                    j += 1;
                }
                let stop = j.min(n);
                fill(&mut mask, &mut depth, i, stop, FILL, d);
                i = stop;
                continue;
            }
            // PostgreSQL dollar-quote：$$ … $$ / $tag$ … $tag$。tag 以字母 / 底線開頭，$1 參數不會誤入。
            if c == b'$' && kind == DbKind::Postgres {
                let mut j = i + 1;
                if j < n && (b[j].is_ascii_alphabetic() || b[j] == b'_') {
                    while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                        j += 1;
                    }
                }
                if j < n && b[j] == b'$' {
                    let tag = &b[i..=j];
                    let stop = find_bytes(b, tag, j + 1).map(|p| p + tag.len()).unwrap_or(n);
                    fill(&mut mask, &mut depth, i, stop, FILL, d);
                    i = stop;
                    continue;
                }
            }
            if c == b'(' {
                mask[i] = c;
                depth[i] = d;
                d += 1;
                i += 1;
                continue;
            }
            if c == b')' {
                d = d.saturating_sub(1);
                mask[i] = c;
                depth[i] = d;
                i += 1;
                continue;
            }
            mask[i] = c;
            depth[i] = d;
            i += 1;
        }
        Masked { src, mask, depth }
    }

    pub fn len(&self) -> usize {
        self.mask.len()
    }

    /// 原文 [from, to) 去頭尾空白。
    pub fn cut(&self, from: usize, to: usize) -> &'a str {
        let to = to.min(self.src.len());
        if from >= to {
            return "";
        }
        self.src[from..to].trim()
    }

    /// 在 `at` 位置整字比對 `word`（不分大小寫）；成功回傳字尾位移。
    fn word_at(&self, at: usize, word: &str) -> Option<usize> {
        let w = word.as_bytes();
        let end = at + w.len();
        if end > self.mask.len() {
            return None;
        }
        if at > 0 && is_ident_byte(self.mask[at - 1]) {
            return None;
        }
        if !self.mask[at..end].eq_ignore_ascii_case(w) {
            return None;
        }
        if end < self.mask.len() && is_ident_byte(self.mask[end]) {
            return None;
        }
        Some(end)
    }

    /// 從 `at` 起跳過空白（含被遮成空白的註解）。
    pub fn skip_ws(&self, mut at: usize) -> usize {
        while at < self.mask.len() && self.mask[at].is_ascii_whitespace() {
            at += 1;
        }
        at
    }

    /// 在 `at` 位置比對一串關鍵字（字間任意空白），成功回傳結尾位移。
    pub fn phrase_at(&self, at: usize, words: &[&str]) -> Option<usize> {
        let mut pos = at;
        for (k, w) in words.iter().enumerate() {
            if k > 0 {
                let next = self.skip_ws(pos);
                if next == pos {
                    return None; // 字與字之間至少一個空白
                }
                pos = next;
            }
            pos = self.word_at(pos, w)?;
        }
        Some(pos)
    }

    /// 找「括號深度 0」的關鍵字片語位移（>= from）；回傳 (起點, 終點)。
    pub fn find_top(&self, words: &[&str], from: usize) -> Option<(usize, usize)> {
        self.find_at_depth(words, from, Some(0))
    }

    /// 同上，但不限深度（找任何位置）。
    pub fn find_any(&self, words: &[&str], from: usize) -> Option<(usize, usize)> {
        self.find_at_depth(words, from, None)
    }

    fn find_at_depth(&self, words: &[&str], from: usize, depth: Option<u32>) -> Option<(usize, usize)> {
        let first = words.first()?.as_bytes().first()?.to_ascii_lowercase();
        let n = self.mask.len();
        let mut i = from;
        while i < n {
            if self.mask[i].to_ascii_lowercase() == first && depth.map_or(true, |d| self.depth[i] == d) {
                if let Some(end) = self.phrase_at(i, words) {
                    return Some((i, end));
                }
            }
            i += 1;
        }
        None
    }

    /// 多個候選片語中最早出現者（深度 0）。回傳 (起點, 終點, 候選序號)。
    pub fn find_top_first(&self, alts: &[&[&str]], from: usize) -> Option<(usize, usize, usize)> {
        let mut best: Option<(usize, usize, usize)> = None;
        for (k, words) in alts.iter().enumerate() {
            if let Some((s, e)) = self.find_top(words, from) {
                if best.map_or(true, |(bs, _, _)| s < bs) {
                    best = Some((s, e, k));
                }
            }
        }
        best
    }

    /// 深度 0 的某個標點位移（`,` / `;` / `=` …）。
    pub fn find_top_byte(&self, ch: u8, from: usize, to: usize) -> Option<usize> {
        (from..to.min(self.mask.len())).find(|&i| self.mask[i] == ch && self.depth[i] == 0)
    }

    /// 在 [from, to) 依「深度 0 的分隔字元」切開，回傳 (起, 訖) 位移（已去頭尾空白、略過空片段）。
    pub fn split_top(&self, from: usize, to: usize, sep: u8) -> Vec<(usize, usize)> {
        let to = to.min(self.mask.len());
        let mut out = Vec::new();
        let mut start = from;
        for i in from..to {
            if self.mask[i] == sep && self.depth[i] == 0 {
                push_trimmed(self, &mut out, start, i);
                start = i + 1;
            }
        }
        push_trimmed(self, &mut out, start, to);
        out
    }

    /// 遮罩上的第一個字（小寫）；純註解 / 空白回空字串。
    pub fn first_word(&self) -> String {
        self.word_after(0).map(|(s, e)| self.src[s..e].to_ascii_lowercase()).unwrap_or_default()
    }

    /// `from` 之後的下一個識別字 token（跳過空白與標點，不跳過 FILL）；回傳 (起, 訖)。
    pub fn word_after(&self, from: usize) -> Option<(usize, usize)> {
        let n = self.mask.len();
        let mut i = self.skip_ws(from);
        while i < n && !is_ident_byte(self.mask[i]) {
            if self.mask[i] == FILL {
                return None; // 下一個 token 是字面值 / 引號識別字
            }
            if !self.mask[i].is_ascii_whitespace() {
                return None;
            }
            i += 1;
        }
        if i >= n {
            return None;
        }
        let s = i;
        while i < n && is_ident_byte(self.mask[i]) {
            i += 1;
        }
        Some((s, i))
    }

    /// 遮罩在 [from, to) 內是否全為空白（沒有任何程式碼）。
    pub fn is_blank(&self, from: usize, to: usize) -> bool {
        self.mask[from..to.min(self.mask.len())].iter().all(|b| b.is_ascii_whitespace())
    }
}

fn push_trimmed(m: &Masked, out: &mut Vec<(usize, usize)>, from: usize, to: usize) {
    let (mut a, mut b) = (from, to);
    while a < b && m.mask[a].is_ascii_whitespace() {
        a += 1;
    }
    while b > a && m.mask[b - 1].is_ascii_whitespace() {
        b -= 1;
    }
    if b > a {
        out.push((a, b));
    }
}

fn find_bytes(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// 腳本切成語句（原文片段，已去頭尾空白；純註解片段略過）。
///
/// 切點規則與前端 `splitSqlStatements` 相同（字串 / 註解 / dollar-quote 內的分號不算），另外：
/// - SQL Server 的 `GO` 批次分隔行（整行只有 GO，可帶次數以外的空白）視為分隔。SSMS 產生的
///   腳本幾乎都有；不認的話 `GO` 會被當成下一句的開頭送出去而語法錯誤。
/// - 不處理 `DELIMITER` 與 BEGIN … END 程序本體：那種腳本逐句切不準，由分析層擋下（見 analyze）。
pub fn split_statements(kind: DbKind, sql: &str) -> Vec<(usize, usize)> {
    let m = Masked::new(kind, sql);
    let n = m.len();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < n {
        if m.mask[i] == b';' {
            push_trimmed(&m, &mut out, start, i);
            start = i + 1;
            i += 1;
            continue;
        }
        if kind == DbKind::Mssql && (i == 0 || m.mask[i - 1] == b'\n') {
            // 行首：整行（去空白後）是否只有 GO。
            let line_end = m.mask[i..].iter().position(|&x| x == b'\n').map(|p| i + p).unwrap_or(n);
            let line = &m.mask[i..line_end];
            let trimmed: Vec<u8> = line.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
            if trimmed.eq_ignore_ascii_case(b"go") {
                push_trimmed(&m, &mut out, start, i);
                start = line_end;
                i = line_end;
                continue;
            }
        }
        i += 1;
    }
    push_trimmed(&m, &mut out, start, n);
    out.retain(|&(a, b)| !m.is_blank(a, b));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stmts(kind: DbKind, sql: &str) -> Vec<String> {
        split_statements(kind, sql).into_iter().map(|(a, b)| sql[a..b].to_string()).collect()
    }

    #[test]
    fn mask_keeps_length_and_depth() {
        let sql = "UPDATE t SET a=(SELECT max(x) FROM y) WHERE id=1";
        let m = Masked::new(DbKind::Mysql, sql);
        assert_eq!(m.mask.len(), sql.len());
        let (w, _) = m.find_top(&["where"], 0).unwrap();
        assert_eq!(&sql[w..w + 5], "WHERE");
        // 子查詢裡的 FROM 在深度 1，頂層找不到。
        assert!(m.find_top(&["from"], 0).is_none());
        assert!(m.find_any(&["from"], 0).is_some());
    }

    #[test]
    fn literals_and_comments_do_not_leak_keywords() {
        let sql = "UPDATE t SET a='x WHERE y' /* WHERE z */ -- WHERE w\n";
        let m = Masked::new(DbKind::Postgres, sql);
        assert!(m.find_top(&["where"], 0).is_none());
        // 註解遮成空白、字面值遮成單一 token，不讓鄰接關鍵字黏在一起。
        let m = Masked::new(DbKind::Mysql, "UPDATE/*c*/t SET a=1");
        assert!(String::from_utf8_lossy(&m.mask).contains("UPDATE     t SET"));
    }

    #[test]
    fn dialect_specific_quoting() {
        // MySQL：反斜線轉義的引號不結束字串。
        let m = Masked::new(DbKind::Mysql, r"SELECT 'a\' WHERE' FROM t WHERE x=1");
        let (w, _) = m.find_top(&["where"], 0).unwrap();
        assert_eq!(&m.src[w..w + 5], "WHERE");
        assert!(w > 20);
        // PG：$$ 本體內的分號與關鍵字不算。
        let sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; DELETE FROM t; END $$ LANGUAGE plpgsql; SELECT 1";
        assert_eq!(stmts(DbKind::Postgres, sql).len(), 2);
        // MSSQL：[識別字] 內的空白與關鍵字。
        let m = Masked::new(DbKind::Mssql, "DELETE FROM [my where] WHERE id=1");
        let (w, _) = m.find_top(&["where"], 0).unwrap();
        assert_eq!(w, 23);
        // MySQL # 註解；PG 的 # 不是註解。
        assert_eq!(stmts(DbKind::Mysql, "SELECT 1 # ; nope\n; SELECT 2").len(), 2);
    }

    #[test]
    fn phrases_span_whitespace_and_respect_word_boundaries() {
        let m = Masked::new(DbKind::Mysql, "SELECT order_by FROM t ORDER\n  BY x");
        let (s, _) = m.find_top(&["order", "by"], 0).unwrap();
        assert_eq!(&m.src[s..s + 5], "ORDER");
        assert!(m.find_top(&["update"], 0).is_none(), "update_log 之類不可誤中");
    }

    #[test]
    fn splits_statements_and_go_batches() {
        assert_eq!(stmts(DbKind::Mysql, "a; b;\n-- only comment\n; c"), vec!["a", "b", "c"]);
        assert_eq!(
            stmts(DbKind::Mssql, "UPDATE t SET a=1\nGO\nDELETE FROM t WHERE 1=0\n  go  \nSELECT 1"),
            vec!["UPDATE t SET a=1", "DELETE FROM t WHERE 1=0", "SELECT 1"]
        );
        // 非 MSSQL 的 GO 行不動（讓分析層照常把它當未知語句）。
        assert_eq!(stmts(DbKind::Mysql, "SELECT 1\nGO\nSELECT 2").len(), 1);
        // 中文字面值與識別字不破壞切點。
        assert_eq!(stmts(DbKind::Mysql, "UPDATE 客戶 SET 名稱='王;小明' WHERE id=1; SELECT 1").len(), 2);
    }

    #[test]
    fn split_top_only_at_depth_zero() {
        let sql = "a, b(1,2), c";
        let m = Masked::new(DbKind::Postgres, sql);
        let parts: Vec<&str> = m.split_top(0, sql.len(), b',').into_iter().map(|(a, b)| &sql[a..b]).collect();
        assert_eq!(parts, vec!["a", "b(1,2)", "c"]);
    }
}
