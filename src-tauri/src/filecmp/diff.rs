//! 兩邊的掃描結果依相對路徑對齊，給每個項目一個狀態。
//!
//! 這裡只看中繼資料（大小、修改時間）。「內容比對」要讀檔，另外由 `fcmp_content_check` 對
//! 狀態為 `Unchecked` 或使用者選取的項目跑；資料夾的彙總狀態（底下有沒有不同）由前端依子項目算，
//! 內容比對更新了檔案狀態之後資料夾才能跟著變。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::scan::Node;

/// 判斷兩個檔案「相同」的準則。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Criteria {
    /// 大小相同且修改時間在容許誤差內（預設；最快，同步工具的慣例）。
    #[default]
    SizeMtime,
    /// 只看大小（兩邊時鐘或時區不可信時用）。
    Size,
    /// 看內容：大小不同直接判不同，大小相同標 `Unchecked` 等內容比對。
    Content,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct AlignOpts {
    pub criteria: Criteria,
    /// 修改時間的容許誤差（秒）。FAT / 部分 FTP 伺服器只有 2 秒精度。
    pub tolerance_secs: u64,
    /// 忽略整小時的時間差（同一個檔在兩邊差了時區 / 夏令時間）。
    pub ignore_hour_offset: bool,
    /// 名稱大小寫不敏感地對齊（Windows ↔ Linux 比對時常要）。
    pub case_insensitive: bool,
}

impl Default for AlignOpts {
    fn default() -> Self {
        Self { criteria: Criteria::SizeMtime, tolerance_secs: 2, ignore_hour_offset: false, case_insensitive: false }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Same,
    Diff,
    LeftOnly,
    RightOnly,
    /// 一邊是資料夾、另一邊是檔案。
    TypeMismatch,
    /// 大小相同、還沒比過內容（`Criteria::Content`）。
    Unchecked,
}

/// 一邊的項目。`rel` 是這一邊實際的相對路徑（大小寫不敏感對齊時，兩邊的 `rel` 可能不同）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Meta {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    /// 對齊用的鍵（大小寫不敏感時是轉小寫的路徑）。前端用它建樹：父節點 = 去掉最後一段。
    pub key: String,
    pub left: Option<Meta>,
    pub right: Option<Meta>,
    pub status: Status,
    /// 兩邊都有且修改時間不同時，哪一邊比較新（"left" / "right"）。
    pub newer: Option<&'static str>,
}

fn fold(rel: &str, ci: bool) -> String {
    if ci {
        rel.to_lowercase()
    } else {
        rel.to_string()
    }
}

fn meta(n: &Node) -> Meta {
    Meta { rel: n.rel.clone(), name: n.name.clone(), is_dir: n.is_dir, size: n.size, mtime: n.mtime }
}

/// 兩個修改時間在準則下是否算相同；任一邊沒有時間就不拿時間判斷（回 true）。
pub fn mtime_equal(a: Option<u64>, b: Option<u64>, opts: &AlignOpts) -> bool {
    let (Some(a), Some(b)) = (a, b) else { return true };
    let d = a.abs_diff(b);
    if d <= opts.tolerance_secs {
        return true;
    }
    if opts.ignore_hour_offset && d <= 24 * 3600 {
        let r = d % 3600;
        return r <= opts.tolerance_secs || 3600 - r <= opts.tolerance_secs;
    }
    false
}

fn file_status(l: &Meta, r: &Meta, opts: &AlignOpts) -> (Status, Option<&'static str>) {
    let same_time = mtime_equal(l.mtime, r.mtime, opts);
    let newer = match (l.mtime, r.mtime) {
        (Some(a), Some(b)) if !same_time => Some(if a > b { "left" } else { "right" }),
        _ => None,
    };
    let status = match opts.criteria {
        Criteria::SizeMtime if l.size == r.size && same_time => Status::Same,
        Criteria::SizeMtime => Status::Diff,
        Criteria::Size if l.size == r.size => Status::Same,
        Criteria::Size => Status::Diff,
        Criteria::Content if l.size != r.size => Status::Diff,
        // 兩個都是空檔：內容一定相同，不必讀。
        Criteria::Content if l.size == 0 => Status::Same,
        Criteria::Content => Status::Unchecked,
    };
    (status, newer)
}

/// 同一邊有兩個項目摺成同一個鍵（大小寫不敏感時的 `A` 與 `a`）時，後來那個用的鍵：
/// 摺過的鍵後面接 `\u{1}` + 原本的路徑。`/` 不在後綴之前，父節點（去掉最後一段）仍是同一個資料夾。
fn collision_key(k: &str, rel: &str) -> String {
    format!("{k}\u{1}{rel}")
}

/// 對齊兩份清單，依鍵排序輸出。同一邊撞鍵的項目見 `collision_key`，不會被吞掉。
pub fn align(left: &[Node], right: &[Node], opts: &AlignOpts) -> Vec<Row> {
    let ci = opts.case_insensitive;
    let mut rows: HashMap<String, (Option<Meta>, Option<Meta>)> = HashMap::new();
    for n in left {
        let mut k = fold(&n.rel, ci);
        if rows.get(&k).is_some_and(|(l, _)| l.is_some()) {
            k = collision_key(&k, &n.rel);
        }
        rows.entry(k).or_default().0 = Some(meta(n));
    }
    for n in right {
        let mut k = fold(&n.rel, ci);
        if rows.get(&k).is_some_and(|(_, r)| r.is_some()) {
            k = collision_key(&k, &n.rel);
        }
        rows.entry(k).or_default().1 = Some(meta(n));
    }
    let mut out: Vec<Row> = rows
        .into_iter()
        .map(|(key, (l, r))| {
            let (status, newer) = match (&l, &r) {
                (Some(_), None) => (Status::LeftOnly, None),
                (None, Some(_)) => (Status::RightOnly, None),
                (Some(a), Some(b)) if a.is_dir != b.is_dir => (Status::TypeMismatch, None),
                (Some(a), Some(_)) if a.is_dir => (Status::Same, None),
                (Some(a), Some(b)) => file_status(a, b, opts),
                (None, None) => unreachable!(),
            };
            Row { key, left: l, right: r, status, newer }
        })
        .collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(rel: &str, size: u64, mtime: u64) -> Node {
        Node { rel: rel.into(), name: rel.rsplit('/').next().unwrap().into(), is_dir: false, size, mtime: Some(mtime) }
    }
    fn d(rel: &str) -> Node {
        Node { rel: rel.into(), name: rel.rsplit('/').next().unwrap().into(), is_dir: true, size: 0, mtime: None }
    }
    fn status_of<'a>(rows: &'a [Row], key: &str) -> &'a Row {
        rows.iter().find(|r| r.key == key).unwrap_or_else(|| panic!("no row {key}"))
    }

    #[test]
    fn statuses_by_size_and_time() {
        let left = vec![d("a"), f("a/same", 10, 1000), f("a/newer", 10, 2000), f("a/size", 10, 1000), f("lonly", 1, 1), d("dir_vs_file")];
        let right = vec![d("a"), f("a/same", 10, 1001), f("a/newer", 10, 1000), f("a/size", 11, 1000), f("ronly", 1, 1), f("dir_vs_file", 1, 1)];
        let rows = align(&left, &right, &AlignOpts::default());
        assert_eq!(status_of(&rows, "a").status, Status::Same);
        assert_eq!(status_of(&rows, "a/same").status, Status::Same);
        let n = status_of(&rows, "a/newer");
        assert_eq!((n.status, n.newer), (Status::Diff, Some("left")));
        assert_eq!(status_of(&rows, "a/size").status, Status::Diff);
        assert_eq!(status_of(&rows, "lonly").status, Status::LeftOnly);
        assert_eq!(status_of(&rows, "ronly").status, Status::RightOnly);
        assert_eq!(status_of(&rows, "dir_vs_file").status, Status::TypeMismatch);
        // 依鍵排序
        let keys: Vec<_> = rows.iter().map(|r| r.key.as_str()).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
    }

    #[test]
    fn criteria_size_and_content() {
        let left = vec![f("x", 10, 1000), f("y", 10, 1000), f("z", 0, 1)];
        let right = vec![f("x", 10, 9000), f("y", 12, 1000), f("z", 0, 9)];
        let size = align(&left, &right, &AlignOpts { criteria: Criteria::Size, ..Default::default() });
        assert_eq!(status_of(&size, "x").status, Status::Same);
        assert_eq!(status_of(&size, "x").newer, Some("right"));
        assert_eq!(status_of(&size, "y").status, Status::Diff);
        let content = align(&left, &right, &AlignOpts { criteria: Criteria::Content, ..Default::default() });
        assert_eq!(status_of(&content, "x").status, Status::Unchecked);
        assert_eq!(status_of(&content, "y").status, Status::Diff);
        assert_eq!(status_of(&content, "z").status, Status::Same);
    }

    #[test]
    fn hour_offset_and_tolerance() {
        let o = AlignOpts { ignore_hour_offset: true, ..Default::default() };
        assert!(mtime_equal(Some(10_000), Some(10_000 + 3600), &o));
        assert!(mtime_equal(Some(10_000), Some(10_000 + 7201), &o));
        assert!(!mtime_equal(Some(10_000), Some(10_000 + 1800), &o));
        assert!(!mtime_equal(Some(10_000), Some(10_000 + 3600), &AlignOpts::default()));
        assert!(mtime_equal(Some(10_000), Some(10_002), &AlignOpts::default()));
        assert!(!mtime_equal(Some(10_000), Some(10_003), &AlignOpts::default()));
        assert!(mtime_equal(None, Some(1), &AlignOpts::default()));
    }

    #[test]
    fn case_insensitive_alignment_keeps_both_rels() {
        let left = vec![d("Src"), f("Src/Main.rs", 1, 1)];
        let right = vec![d("src"), f("src/main.rs", 1, 1), f("src/extra.rs", 1, 1)];
        let exact = align(&left, &right, &AlignOpts::default());
        assert_eq!(exact.iter().filter(|r| r.status == Status::LeftOnly).count(), 2);
        let ci = align(&left, &right, &AlignOpts { case_insensitive: true, ..Default::default() });
        let m = status_of(&ci, "src/main.rs");
        assert_eq!(m.status, Status::Same);
        assert_eq!(m.left.as_ref().unwrap().rel, "Src/Main.rs");
        assert_eq!(m.right.as_ref().unwrap().rel, "src/main.rs");
        assert_eq!(status_of(&ci, "src/extra.rs").status, Status::RightOnly);
    }

    #[test]
    fn case_collision_on_one_side_is_not_swallowed() {
        let left = vec![f("A", 1, 1), f("a", 2, 1)];
        let rows = align(&left, &[], &AlignOpts { case_insensitive: true, ..Default::default() });
        assert_eq!(rows.len(), 2);
    }
}
