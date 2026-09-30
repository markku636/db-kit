//! 同步規則 → 操作清單（`dbk sync` 用）。規則與前端 `folderCompareModel.ts` 的 `planSync` 一致：
//!
//! - 鏡像（mirror_lr / mirror_rl）：讓目的地變得跟來源一模一樣——來源沒有的刪掉、不同的覆蓋。
//! - 更新（update_lr / update_rl）：只把來源有、目的地沒有或比較舊的複製過去，不刪任何東西。
//! - 兩邊更新（update_both）：各自補上對方沒有的，不同的以較新的一邊為準；分不出新舊的列為衝突。
//!
//! 只在一邊的資料夾整個複製 / 刪除，不再往下展開（同步執行時自己會展開）。

use std::collections::HashMap;

use super::diff::{Meta, Row, Status};
use super::sessions::SyncRule;
use super::sync::{OpKind, SyncOp};

pub struct Plan {
    pub ops: Vec<SyncOp>,
    /// 分不出方向的項目（鍵）。
    pub conflicts: Vec<String>,
}

fn parent_key(key: &str) -> &str {
    let base = key.split('\u{1}').next().unwrap_or(key);
    base.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

struct Tree<'a> {
    rows: &'a [Row],
    children: HashMap<&'a str, Vec<usize>>,
    index: HashMap<&'a str, usize>,
}

impl<'a> Tree<'a> {
    fn new(rows: &'a [Row]) -> Self {
        let index: HashMap<&str, usize> = rows.iter().enumerate().map(|(i, r)| (r.key.as_str(), i)).collect();
        let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, r) in rows.iter().enumerate() {
            let p = parent_key(&r.key);
            let p = if index.contains_key(p) && p != r.key { p } else { "" };
            children.entry(p).or_default().push(i);
        }
        Self { rows, children, index }
    }

    fn src<'r>(r: &'r Row, to_right: bool) -> Option<&'r Meta> {
        if to_right { r.left.as_ref() } else { r.right.as_ref() }
    }
    fn dst<'r>(r: &'r Row, to_right: bool) -> Option<&'r Meta> {
        if to_right { r.right.as_ref() } else { r.left.as_ref() }
    }

    /// 目的那一邊的相對路徑：最近一個目的地也有的祖先 + 其後的名稱。
    fn dest_rel(&self, i: usize, to_right: bool) -> String {
        let r = &self.rows[i];
        if let Some(d) = Self::dst(r, to_right) {
            return d.rel.clone();
        }
        let mut segs: Vec<&str> = Vec::new();
        let mut cur = Some(i);
        while let Some(c) = cur {
            let row = &self.rows[c];
            if let Some(d) = Self::dst(row, to_right) {
                segs.reverse();
                return format!("{}/{}", d.rel, segs.join("/"));
            }
            segs.push(Self::src(row, to_right).map(|m| m.name.as_str()).unwrap_or(""));
            cur = self.index.get(parent_key(&row.key)).copied().filter(|&p| p != c);
        }
        segs.reverse();
        segs.join("/")
    }

    fn copy(&self, i: usize, to_right: bool) -> SyncOp {
        let src = Self::src(&self.rows[i], to_right).expect("copy source");
        SyncOp {
            kind: if to_right { OpKind::CopyLr } else { OpKind::CopyRl },
            src: src.rel.clone(),
            dst: Some(self.dest_rel(i, to_right)),
            is_dir: src.is_dir,
        }
    }

    fn visit(&self, i: usize, rule: SyncRule, plan: &mut Plan) {
        let r = &self.rows[i];
        let is_dir = r.left.as_ref().or(r.right.as_ref()).is_some_and(|m| m.is_dir);
        let kids = || self.children.get(r.key.as_str()).into_iter().flatten().copied();
        let mirror = match rule {
            SyncRule::MirrorLr => Some(true),
            SyncRule::MirrorRl => Some(false),
            _ => None,
        };
        if let Some(to_right) = mirror {
            if Self::src(r, to_right).is_none() {
                let m = Self::dst(r, to_right).expect("row has a side");
                plan.ops.push(SyncOp {
                    kind: if to_right { OpKind::DeleteRight } else { OpKind::DeleteLeft },
                    src: m.rel.clone(),
                    dst: None,
                    is_dir: m.is_dir,
                });
                return;
            }
            match r.status {
                Status::LeftOnly | Status::RightOnly | Status::TypeMismatch => plan.ops.push(self.copy(i, to_right)),
                _ if is_dir => kids().for_each(|c| self.visit(c, rule, plan)),
                Status::Same => {}
                _ => plan.ops.push(self.copy(i, to_right)),
            }
            return;
        }
        let to_right_ok = matches!(rule, SyncRule::UpdateLr | SyncRule::UpdateBoth);
        let to_left_ok = matches!(rule, SyncRule::UpdateRl | SyncRule::UpdateBoth);
        match r.status {
            Status::TypeMismatch => plan.conflicts.push(r.key.clone()),
            Status::LeftOnly => {
                if to_right_ok {
                    plan.ops.push(self.copy(i, true))
                }
            }
            Status::RightOnly => {
                if to_left_ok {
                    plan.ops.push(self.copy(i, false))
                }
            }
            _ if is_dir => kids().for_each(|c| self.visit(c, rule, plan)),
            Status::Same => {}
            _ => match r.newer {
                Some("left") if to_right_ok => plan.ops.push(self.copy(i, true)),
                Some("right") if to_left_ok => plan.ops.push(self.copy(i, false)),
                None => plan.conflicts.push(r.key.clone()),
                _ => {}
            },
        }
    }
}

pub fn plan_sync(rows: &[Row], rule: SyncRule) -> Plan {
    let t = Tree::new(rows);
    let mut plan = Plan { ops: Vec::new(), conflicts: Vec::new() };
    for i in t.children.get("").cloned().unwrap_or_default() {
        t.visit(i, rule, &mut plan);
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(rel: &str, is_dir: bool) -> Meta {
        Meta { rel: rel.into(), name: rel.rsplit('/').next().unwrap().into(), is_dir, size: 1, mtime: Some(1) }
    }
    fn row(key: &str, l: Option<Meta>, r: Option<Meta>, status: Status, newer: Option<&'static str>) -> Row {
        Row { key: key.into(), left: l, right: r, status, newer }
    }

    /// 與 folderCompareModel.test.ts 的「plans mirror and update syncs」同一組資料、同一組期望。
    fn rows() -> Vec<Row> {
        vec![
            row("docs", Some(m("docs", true)), Some(m("docs", true)), Status::Same, None),
            row("docs/r.md", None, Some(m("docs/r.md", false)), Status::RightOnly, None),
            row("kind", Some(m("kind", false)), Some(m("kind", true)), Status::TypeMismatch, None),
            row("src", Some(m("src", true)), Some(m("src", true)), Status::Same, None),
            row("src/a.txt", Some(m("src/a.txt", false)), Some(m("src/a.txt", false)), Status::Same, None),
            row("src/b.txt", Some(m("src/b.txt", false)), Some(m("src/b.txt", false)), Status::Diff, Some("left")),
            row("src/only_l", Some(m("src/only_l", true)), None, Status::LeftOnly, None),
            row("src/only_l/x.txt", Some(m("src/only_l/x.txt", false)), None, Status::LeftOnly, None),
            row("src/u.bin", Some(m("src/u.bin", false)), Some(m("src/u.bin", false)), Status::Unchecked, None),
        ]
    }

    fn fmt(p: &Plan) -> Vec<String> {
        let mut v: Vec<String> = p.ops.iter().map(|o| format!("{:?}:{}", o.kind, o.src)).collect();
        v.sort();
        v
    }

    #[test]
    fn mirror_and_update() {
        let rows = rows();
        let p = plan_sync(&rows, SyncRule::MirrorLr);
        assert_eq!(
            fmt(&p),
            vec!["CopyLr:kind", "CopyLr:src/b.txt", "CopyLr:src/only_l", "CopyLr:src/u.bin", "DeleteRight:docs/r.md"]
        );
        assert!(p.conflicts.is_empty());

        let p = plan_sync(&rows, SyncRule::UpdateBoth);
        assert_eq!(fmt(&p), vec!["CopyLr:src/b.txt", "CopyLr:src/only_l", "CopyRl:docs/r.md"]);
        let mut c = p.conflicts.clone();
        c.sort();
        assert_eq!(c, vec!["kind", "src/u.bin"]);

        let p = plan_sync(&rows, SyncRule::UpdateRl);
        assert_eq!(fmt(&p), vec!["CopyRl:docs/r.md"]);
    }

    #[test]
    fn dest_rel_uses_other_side_parent() {
        let rows = vec![
            row("src", Some(m("Src", true)), Some(m("src", true)), Status::Same, None),
            row("src/new", Some(m("Src/New", true)), None, Status::LeftOnly, None),
        ];
        let p = plan_sync(&rows, SyncRule::MirrorLr);
        assert_eq!(p.ops[0].dst.as_deref(), Some("src/New"));
    }
}
