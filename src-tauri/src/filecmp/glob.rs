//! 資料夾比對的排除規則：`*`（任意長度）與 `?`（單一字元）的萬用字元，大小寫不敏感。
//!
//! 規則不含 `/` 時比對的是項目名稱（`node_modules`、`*.log`），含 `/` 時比對相對路徑
//! （`build/*.tmp`）。刻意不引進 glob crate：只需要這兩個符號，行為好說明、也好測。

/// 名稱或相對路徑是否命中任一條規則。空白規則略過。
pub fn excluded(patterns: &[String], name: &str, rel: &str) -> bool {
    patterns.iter().any(|p| {
        let p = p.trim();
        if p.is_empty() {
            return false;
        }
        let p = p.trim_matches('/');
        if p.contains('/') {
            wildcard(p, rel)
        } else {
            wildcard(p, name)
        }
    })
}

/// 萬用字元比對（整串比對，不是子字串）。大小寫不敏感：Windows 與 macOS 的檔名本來就不分大小寫，
/// 在 Linux 上把 `*.LOG` 也排掉通常也是使用者要的。
pub fn wildcard(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    // 最近一次 `*` 的位置與當時對到的文字位置：失配時回到這裡，讓 `*` 多吃一個字元。
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_basics() {
        assert!(wildcard("*.log", "server.log"));
        assert!(wildcard("*.LOG", "server.log"));
        assert!(!wildcard("*.log", "server.log.1"));
        assert!(wildcard("*.log*", "server.log.1"));
        assert!(wildcard("a?c", "abc"));
        assert!(!wildcard("a?c", "ac"));
        assert!(wildcard("*", ""));
        assert!(wildcard("node_modules", "node_modules"));
        assert!(!wildcard("node_modules", "node_modules2"));
        assert!(wildcard("*a*b*", "xxaYYbzz"));
        assert!(!wildcard("*a*b", "xxaYYbzz"));
    }

    #[test]
    fn excluded_by_name_or_path() {
        let pats = vec![".git".to_string(), "build/*.tmp".to_string(), "  ".to_string()];
        assert!(excluded(&pats, ".git", "sub/.git"));
        assert!(excluded(&pats, "x.tmp", "build/x.tmp"));
        assert!(!excluded(&pats, "x.tmp", "src/x.tmp"));
        assert!(!excluded(&pats, "main.rs", "src/main.rs"));
    }
}
