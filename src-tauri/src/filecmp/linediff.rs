//! 行 diff（Myers O((N+M)·D)）與 unified 格式輸出，給 `dbk diff` 的文字比對用。
//! GUI 的文字比對在前端（@codemirror/merge），不走這裡。
//!
//! 差異太大（編輯距離超過 `MAX_D`）時放棄逐行比對、只回報「不同」：Myers 的軌跡是 O(D²) 記憶體，
//! 兩個完全不相干的大檔會吃掉幾 GB。

/// 編輯距離上限（插入 + 刪除的行數）。
pub const MAX_D: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Equal,
    Delete,
    Insert,
}

/// 逐行的編輯腳本：(操作, a 的行號, b 的行號)。Delete 的 b 行號 / Insert 的 a 行號是「插在這之前」的位置。
pub type Script = Vec<(Op, usize, usize)>;

/// Myers diff。差異超過 `MAX_D` 回 `None`。
pub fn diff_lines(a: &[&str], b: &[&str]) -> Option<Script> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let max = (n + m) as usize;
    let limit = max.min(MAX_D);
    let off = limit as isize + 1;
    let mut v = vec![0isize; 2 * limit + 3];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    'outer: for d in 0..=limit as isize {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let idx = (k + off) as usize;
            let mut x = if k == -d || (k != d && v[idx - 1] < v[idx + 1]) { v[idx + 1] } else { v[idx - 1] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[idx] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'outer;
            }
            k += 2;
        }
    }
    let d_final = found?;
    // 回溯。
    let mut script: Script = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (0..=d_final).rev() {
        let v = &trace[d as usize];
        let k = x - y;
        let idx = |k: isize| (k + off) as usize;
        let prev_k = if k == -d || (k != d && v[idx(k - 1)] < v[idx(k + 1)]) { k + 1 } else { k - 1 };
        let prev_x = if d == 0 { 0 } else { v[idx(prev_k)] };
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            script.push((Op::Equal, x as usize, y as usize));
        }
        if d > 0 {
            if x == prev_x {
                script.push((Op::Insert, x as usize, prev_y as usize));
            } else {
                script.push((Op::Delete, prev_x as usize, y as usize));
            }
        }
        x = prev_x;
        y = prev_y;
    }
    script.reverse();
    Some(script)
}

/// 兩段文字的 unified diff（`context` 行上下文）。相同回空字串；差異太大回 `None`。
pub fn unified(a: &str, b: &str, name_a: &str, name_b: &str, context: usize) -> Option<String> {
    let la: Vec<&str> = a.lines().collect();
    let lb: Vec<&str> = b.lines().collect();
    let script = diff_lines(&la, &lb)?;
    if script.iter().all(|(op, _, _)| *op == Op::Equal) {
        return Some(String::new());
    }
    // 把變動的位置分組成 hunk：兩段變動之間相隔不超過 2*context 行就併成一個。
    let changes: Vec<usize> = script.iter().enumerate().filter(|(_, (op, _, _))| *op != Op::Equal).map(|(i, _)| i).collect();
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for &i in &changes {
        match groups.last_mut() {
            Some((_, end)) if i <= *end + 2 * context + 1 => *end = i,
            _ => groups.push((i, i)),
        }
    }
    let mut out = format!("--- {name_a}\n+++ {name_b}\n");
    for (s, e) in groups {
        let from = s.saturating_sub(context);
        let to = (e + context + 1).min(script.len());
        let seg = &script[from..to];
        let a_start = seg.first().map(|(_, ia, _)| *ia).unwrap_or(0);
        let b_start = seg.first().map(|(_, _, ib)| *ib).unwrap_or(0);
        let a_len = seg.iter().filter(|(op, _, _)| *op != Op::Insert).count();
        let b_len = seg.iter().filter(|(op, _, _)| *op != Op::Delete).count();
        let fmt_range = |start: usize, len: usize| if len == 0 { format!("{start},0") } else { format!("{},{len}", start + 1) };
        out.push_str(&format!("@@ -{} +{} @@\n", fmt_range(a_start, a_len), fmt_range(b_start, b_len)));
        for (op, ia, ib) in seg {
            match op {
                Op::Equal => out.push_str(&format!(" {}\n", la[*ia])),
                Op::Delete => out.push_str(&format!("-{}\n", la[*ia])),
                Op::Insert => out.push_str(&format!("+{}\n", lb[*ib])),
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(a: &[&str], b: &[&str], s: &Script) -> Vec<String> {
        // 依腳本重建 b，驗證腳本正確。
        let mut out = Vec::new();
        for (op, ia, ib) in s {
            match op {
                Op::Equal => out.push(a[*ia].to_string()),
                Op::Insert => out.push(b[*ib].to_string()),
                Op::Delete => {}
            }
        }
        out
    }

    #[test]
    fn scripts_rebuild_b() {
        let cases: &[(&[&str], &[&str])] = &[
            (&[], &[]),
            (&["a"], &[]),
            (&[], &["a"]),
            (&["a", "b", "c", "a", "b", "b", "a"], &["c", "b", "a", "b", "a", "c"]),
            (&["x", "y", "z"], &["x", "y", "z"]),
            (&["1", "2", "3", "4"], &["1", "3", "4", "5"]),
        ];
        for (a, b) in cases {
            let s = diff_lines(a, b).unwrap();
            assert_eq!(apply(a, b, &s), b.iter().map(|x| x.to_string()).collect::<Vec<_>>(), "{a:?} → {b:?}");
        }
        let s = diff_lines(&["a", "b", "c", "a", "b", "b", "a"], &["c", "b", "a", "b", "a", "c"]).unwrap();
        // 經典例子（Myers 論文）：最短編輯距離是 5。
        assert_eq!(s.iter().filter(|(o, _, _)| *o != Op::Equal).count(), 5);
    }

    #[test]
    fn unified_output() {
        let a = "host = db\nport = 5432\npool = 10\ntimeout = 30\nlog = info\n";
        let b = "host = db\nport = 6432\npool = 10\ntimeout = 30\nlog = debug\nretry = 3\n";
        // 兩段變動之間只隔 2 行（= 2 × context）：併成一個 hunk（同 GNU diff）。
        let u = unified(a, b, "old", "new", 1).unwrap();
        assert_eq!(
            u,
            "--- old\n+++ new\n@@ -1,5 +1,6 @@\n host = db\n-port = 5432\n+port = 6432\n pool = 10\n timeout = 30\n-log = info\n+log = debug\n+retry = 3\n"
        );
        assert_eq!(unified(a, a, "x", "y", 3).unwrap(), "");
        // 相隔超過 2 × context 行的變動分成兩個 hunk。
        let a2 = "1\n2\n3\n4\n5\n6\n7\n";
        let b2 = "1x\n2\n3\n4\n5\n6\n7x\n";
        let u2 = unified(a2, b2, "a", "b", 1).unwrap();
        assert_eq!(u2.matches("@@ -").count(), 2, "{u2}");
        assert!(u2.contains("@@ -1,2 +1,2 @@") && u2.contains("@@ -6,2 +6,2 @@"), "{u2}");
    }
}
