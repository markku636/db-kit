//! 兩側列串流的比對演算法（純函式，離線可測）。
//!
//! - `merge_join`：兩側皆依主鍵遞增時的 sort-merge，記憶體 O(page)。附**順序守衛**：伺服器端的排序
//!   規則（MySQL `_ci`、PG locale、MSSQL `_CI_AS`）與 Rust 比較器可能不一致——一旦某側在比較器下
//!   不是嚴格遞增，合併結果就不可信，回 `OrderViolation` 讓上層改走 hash_diff。
//! - `hash_diff`：不依賴順序。第一趟每列只留 `(鍵雜湊 u128, 列雜湊 u64)`，排序合併得出差異鍵集；
//!   第二趟重掃把差異列餵給 sink。記憶體 O(24 B × 列數)，以 `max_rows` 兜底。

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

use super::normalize::{cells_equal, cmp_key, key_hash128, row_hash, CompareMode};
use super::rowstream::{PageSource, Row};
use crate::error::AppResult;

/// 差異接收端。回 Err 可中止（如 SQL 文字超過上限）。
/// `Send`：sink 會跨 await 被 `&mut dyn` 持有，Tauri command 的 future 才能在 runtime 執行緒間移動。
pub trait DiffSink: Send {
    fn insert(&mut self, src: &Row) -> AppResult<()>;
    fn update(&mut self, src: &Row, dst: &Row, changed: &[usize]) -> AppResult<()>;
    fn delete(&mut self, dst: &Row) -> AppResult<()>;
    /// 兩側相同的一列。
    fn matched(&mut self) {}
}

pub struct RowComparer {
    pub key_modes: Vec<CompareMode>,
    pub col_modes: Vec<CompareMode>,
    pub null_eq_empty: bool,
    pub trim_ws: bool,
}

impl RowComparer {
    pub fn cmp_keys(&self, a: &Row, b: &Row) -> Ordering {
        cmp_key(&a.key, &b.key, &self.key_modes)
    }
    /// 值不同的欄位索引（共同欄位順序）。
    pub fn changed_columns(&self, a: &Row, b: &Row) -> Vec<usize> {
        let mut out = Vec::new();
        for (i, m) in self.col_modes.iter().enumerate() {
            let x = a.values.get(i).and_then(|v| v.as_deref());
            let y = b.values.get(i).and_then(|v| v.as_deref());
            if !cells_equal(*m, x, y, self.null_eq_empty, self.trim_ws) {
                out.push(i);
            }
        }
        out
    }
    pub fn row_hash(&self, r: &Row) -> u64 {
        row_hash(&r.values, &self.col_modes, self.trim_ws, self.null_eq_empty)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    /// 每側最多掃描列數；0 = 不限。
    pub max_rows: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Src,
    Dst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    Completed,
    OrderViolation { side: Side },
    DuplicateKey { side: Side },
    MaxRows,
    Cancelled,
}

/// 一側的游標：目前頁 + 索引，並記上一把鍵做順序守衛。
struct Cursor<'a> {
    src: &'a mut dyn PageSource,
    page: Vec<Row>,
    i: usize,
    last: Option<Row>,
    exhausted: bool,
    side: Side,
}

impl<'a> Cursor<'a> {
    fn new(src: &'a mut dyn PageSource, side: Side) -> Self {
        Self { src, page: Vec::new(), i: 0, last: None, exhausted: false, side }
    }
    /// 確保 `page[i]` 可用；無更多列回 false。
    async fn fill(&mut self) -> AppResult<bool> {
        while self.i >= self.page.len() {
            if self.exhausted {
                return Ok(false);
            }
            match self.src.next_page().await? {
                Some(p) if !p.is_empty() => {
                    self.page = p;
                    self.i = 0;
                }
                _ => {
                    self.exhausted = true;
                    self.page.clear();
                    self.i = 0;
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
    fn peek(&self) -> &Row {
        &self.page[self.i]
    }
    /// 前進一列並做順序守衛。
    fn advance(&mut self, cmp: &RowComparer) -> Result<(), MergeOutcome> {
        let cur = std::mem::take(&mut self.page[self.i]);
        self.i += 1;
        if let Some(prev) = &self.last {
            match cmp.cmp_keys(prev, &cur) {
                Ordering::Less => {}
                Ordering::Equal => return Err(MergeOutcome::DuplicateKey { side: self.side }),
                Ordering::Greater => return Err(MergeOutcome::OrderViolation { side: self.side }),
            }
        }
        self.last = Some(cur);
        Ok(())
    }
    fn seen(&self) -> u64 {
        self.src.rows_seen()
    }
}

impl Default for Row {
    fn default() -> Self {
        Self { key: vec![], values: vec![] }
    }
}

/// 進度回呼型別（`Send`：同 DiffSink 的理由）。
pub type Tick<'a> = &'a mut (dyn FnMut(u64, u64) + Send);

/// sort-merge join。`tick(src_seen, dst_seen)` 於每次翻頁後呼叫。
pub async fn merge_join(
    src: &mut dyn PageSource,
    dst: &mut dyn PageSource,
    cmp: &RowComparer,
    sink: &mut dyn DiffSink,
    limits: &Limits,
    cancel: &AtomicBool,
    tick: Tick<'_>,
) -> AppResult<MergeOutcome> {
    let mut a = Cursor::new(src, Side::Src);
    let mut b = Cursor::new(dst, Side::Dst);
    let over = |a: &Cursor, b: &Cursor| limits.max_rows > 0 && (a.seen() > limits.max_rows || b.seen() > limits.max_rows);
    loop {
        if cancel.load(AtomicOrdering::Relaxed) {
            return Ok(MergeOutcome::Cancelled);
        }
        let ha = a.fill().await?;
        let hb = b.fill().await?;
        tick(a.seen(), b.seen());
        if over(&a, &b) {
            return Ok(MergeOutcome::MaxRows);
        }
        match (ha, hb) {
            (false, false) => return Ok(MergeOutcome::Completed),
            (true, false) => {
                sink.insert(a.peek())?;
                if let Err(o) = a.advance(cmp) {
                    return Ok(o);
                }
            }
            (false, true) => {
                sink.delete(b.peek())?;
                if let Err(o) = b.advance(cmp) {
                    return Ok(o);
                }
            }
            (true, true) => match cmp.cmp_keys(a.peek(), b.peek()) {
                Ordering::Less => {
                    sink.insert(a.peek())?;
                    if let Err(o) = a.advance(cmp) {
                        return Ok(o);
                    }
                }
                Ordering::Greater => {
                    sink.delete(b.peek())?;
                    if let Err(o) = b.advance(cmp) {
                        return Ok(o);
                    }
                }
                Ordering::Equal => {
                    let changed = cmp.changed_columns(a.peek(), b.peek());
                    if changed.is_empty() {
                        sink.matched();
                    } else {
                        sink.update(a.peek(), b.peek(), &changed)?;
                    }
                    if let Err(o) = a.advance(cmp) {
                        return Ok(o);
                    }
                    if let Err(o) = b.advance(cmp) {
                        return Ok(o);
                    }
                }
            },
        }
    }
}

/// 兩趟雜湊比對（順序無關）。
pub async fn hash_diff(
    src: &mut dyn PageSource,
    dst: &mut dyn PageSource,
    cmp: &RowComparer,
    sink: &mut dyn DiffSink,
    limits: &Limits,
    cancel: &AtomicBool,
    tick: Tick<'_>,
) -> AppResult<MergeOutcome> {
    // ---- 第一趟：收雜湊 ----
    async fn collect(
        s: &mut dyn PageSource,
        cmp: &RowComparer,
        limits: &Limits,
        cancel: &AtomicBool,
        other_seen: u64,
        is_src: bool,
        tick: Tick<'_>,
    ) -> AppResult<Result<Vec<(u128, u64)>, MergeOutcome>> {
        let mut v: Vec<(u128, u64)> = Vec::new();
        while let Some(page) = s.next_page().await? {
            if cancel.load(AtomicOrdering::Relaxed) {
                return Ok(Err(MergeOutcome::Cancelled));
            }
            for r in &page {
                v.push((key_hash128(&r.key), cmp.row_hash(r)));
            }
            if is_src { tick(s.rows_seen(), other_seen) } else { tick(other_seen, s.rows_seen()) }
            if limits.max_rows > 0 && s.rows_seen() > limits.max_rows {
                return Ok(Err(MergeOutcome::MaxRows));
            }
        }
        v.sort_unstable();
        Ok(Ok(v))
    }
    let sa = match collect(src, cmp, limits, cancel, 0, true, tick).await? {
        Ok(v) => v,
        Err(o) => return Ok(o),
    };
    let src_seen = src.rows_seen();
    let sb = match collect(dst, cmp, limits, cancel, src_seen, false, tick).await? {
        Ok(v) => v,
        Err(o) => return Ok(o),
    };
    // 同側重複鍵：主鍵不該重複；出現即代表鍵正規化把兩把不同鍵併成一把（或表根本沒唯一鍵）。
    if sa.windows(2).any(|w| w[0].0 == w[1].0) {
        return Ok(MergeOutcome::DuplicateKey { side: Side::Src });
    }
    if sb.windows(2).any(|w| w[0].0 == w[1].0) {
        return Ok(MergeOutcome::DuplicateKey { side: Side::Dst });
    }

    // ---- 合併雜湊 → 差異鍵集 ----
    let mut inserts: HashSet<u128> = HashSet::new();
    let mut updates: HashSet<u128> = HashSet::new();
    let mut deletes: HashSet<u128> = HashSet::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < sa.len() || j < sb.len() {
        match (sa.get(i), sb.get(j)) {
            (Some(x), Some(y)) => match x.0.cmp(&y.0) {
                Ordering::Less => {
                    inserts.insert(x.0);
                    i += 1;
                }
                Ordering::Greater => {
                    deletes.insert(y.0);
                    j += 1;
                }
                Ordering::Equal => {
                    if x.1 != y.1 {
                        updates.insert(x.0);
                    } else {
                        sink.matched();
                    }
                    i += 1;
                    j += 1;
                }
            },
            (Some(x), None) => {
                inserts.insert(x.0);
                i += 1;
            }
            (None, Some(y)) => {
                deletes.insert(y.0);
                j += 1;
            }
            (None, None) => break,
        }
    }
    drop(sa);
    drop(sb);
    if inserts.is_empty() && updates.is_empty() && deletes.is_empty() {
        return Ok(MergeOutcome::Completed);
    }

    // ---- 第二趟：目標側（刪除 + 收更新的目標列），再來源側（新增 + 更新）----
    let mut dst_rows: HashMap<u128, Row> = HashMap::new();
    if !deletes.is_empty() || !updates.is_empty() {
        dst.reopen().await?;
        while let Some(page) = dst.next_page().await? {
            if cancel.load(AtomicOrdering::Relaxed) {
                return Ok(MergeOutcome::Cancelled);
            }
            for r in page {
                let h = key_hash128(&r.key);
                if deletes.contains(&h) {
                    sink.delete(&r)?;
                } else if updates.contains(&h) {
                    dst_rows.insert(h, r);
                }
            }
        }
    }
    if !inserts.is_empty() || !updates.is_empty() {
        src.reopen().await?;
        while let Some(page) = src.next_page().await? {
            if cancel.load(AtomicOrdering::Relaxed) {
                return Ok(MergeOutcome::Cancelled);
            }
            for r in page {
                let h = key_hash128(&r.key);
                if inserts.contains(&h) {
                    sink.insert(&r)?;
                } else if updates.contains(&h) {
                    if let Some(d) = dst_rows.get(&h) {
                        let changed = cmp.changed_columns(&r, d);
                        if changed.is_empty() {
                            // 雜湊不同但逐欄相等（極罕見：雜湊碰撞方向相反）→ 視為相同。
                            sink.matched();
                        } else {
                            sink.update(&r, d, &changed)?;
                        }
                    }
                }
            }
        }
    }
    Ok(MergeOutcome::Completed)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::compare::rowstream::VecPages;

    pub fn row(k: &str, vals: &[Option<&str>]) -> Row {
        Row { key: vec![Some(k.to_string())], values: vals.iter().map(|v| v.map(str::to_string)).collect() }
    }
    fn rows(spec: &[(&str, &[Option<&str>])]) -> Vec<Row> {
        spec.iter().map(|(k, v)| row(k, v)).collect()
    }

    #[derive(Default, Debug)]
    pub struct RecSink {
        pub inserts: Vec<String>,
        pub updates: Vec<(String, Vec<usize>)>,
        pub deletes: Vec<String>,
        pub matched: u64,
    }
    impl DiffSink for RecSink {
        fn insert(&mut self, src: &Row) -> AppResult<()> {
            self.inserts.push(src.key[0].clone().unwrap());
            Ok(())
        }
        fn update(&mut self, src: &Row, _dst: &Row, changed: &[usize]) -> AppResult<()> {
            self.updates.push((src.key[0].clone().unwrap(), changed.to_vec()));
            Ok(())
        }
        fn delete(&mut self, dst: &Row) -> AppResult<()> {
            self.deletes.push(dst.key[0].clone().unwrap());
            Ok(())
        }
        fn matched(&mut self) {
            self.matched += 1;
        }
    }

    fn cmp_num(cols: usize) -> RowComparer {
        RowComparer { key_modes: vec![CompareMode::Numeric], col_modes: vec![CompareMode::Text; cols], null_eq_empty: false, trim_ws: false }
    }

    #[tokio::test]
    async fn merge_join_basic_insert_update_delete() {
        let src = rows(&[("1", &[Some("a")]), ("2", &[Some("b")]), ("4", &[Some("d")])]);
        let dst = rows(&[("1", &[Some("a")]), ("2", &[Some("B")]), ("3", &[Some("c")])]);
        let mut s = VecPages::from_rows(src, 2);
        let mut d = VecPages::from_rows(dst, 1);
        let mut sink = RecSink::default();
        let mut ticks = 0;
        let o = merge_join(&mut s, &mut d, &cmp_num(1), &mut sink, &Limits::default(), &AtomicBool::new(false), &mut |_, _| ticks += 1).await.unwrap();
        assert_eq!(o, MergeOutcome::Completed);
        assert_eq!(sink.inserts, vec!["4"]);
        assert_eq!(sink.updates, vec![("2".to_string(), vec![0])]);
        assert_eq!(sink.deletes, vec!["3"]);
        assert_eq!(sink.matched, 1);
        assert!(ticks > 0);
    }

    #[tokio::test]
    async fn merge_join_numeric_key_order_and_guard() {
        // 數值鍵 9 < 10：字串序會錯，數值比較器要對。
        let src = rows(&[("9", &[None]), ("10", &[None])]);
        let dst = rows(&[("9", &[None]), ("10", &[None])]);
        let mut sink = RecSink::default();
        let o = merge_join(&mut VecPages::from_rows(src.clone(), 10), &mut VecPages::from_rows(dst, 10), &cmp_num(1), &mut sink, &Limits::default(), &AtomicBool::new(false), &mut |_, _| {}).await.unwrap();
        assert_eq!(o, MergeOutcome::Completed);
        assert_eq!(sink.matched, 2);
        // 同樣的資料用文字比較器 → 順序守衛觸發（"9" > "10"）。
        let text = RowComparer { key_modes: vec![CompareMode::Text], col_modes: vec![CompareMode::Text], null_eq_empty: false, trim_ws: false };
        let o = merge_join(&mut VecPages::from_rows(src.clone(), 10), &mut VecPages::from_rows(src, 10), &text, &mut RecSink::default(), &Limits::default(), &AtomicBool::new(false), &mut |_, _| {}).await.unwrap();
        assert_eq!(o, MergeOutcome::OrderViolation { side: Side::Src });
    }

    #[tokio::test]
    async fn merge_join_duplicate_cancel_and_max_rows() {
        let dup = rows(&[("1", &[None]), ("1", &[None])]);
        let o = merge_join(&mut VecPages::from_rows(dup.clone(), 10), &mut VecPages::from_rows(vec![], 10), &cmp_num(1), &mut RecSink::default(), &Limits::default(), &AtomicBool::new(false), &mut |_, _| {}).await.unwrap();
        assert_eq!(o, MergeOutcome::DuplicateKey { side: Side::Src });

        let many: Vec<Row> = (0..10).map(|i| row(&i.to_string(), &[None])).collect();
        let o = merge_join(&mut VecPages::from_rows(many.clone(), 3), &mut VecPages::from_rows(many.clone(), 3), &cmp_num(1), &mut RecSink::default(), &Limits { max_rows: 5 }, &AtomicBool::new(false), &mut |_, _| {}).await.unwrap();
        assert_eq!(o, MergeOutcome::MaxRows);

        let o = merge_join(&mut VecPages::from_rows(many.clone(), 3), &mut VecPages::from_rows(many, 3), &cmp_num(1), &mut RecSink::default(), &Limits::default(), &AtomicBool::new(true), &mut |_, _| {}).await.unwrap();
        assert_eq!(o, MergeOutcome::Cancelled);
    }

    #[tokio::test]
    async fn hash_diff_matches_merge_join_on_unsorted_input() {
        // 故意亂序：merge_join 會守衛失敗，hash_diff 仍要得到同樣的計數。
        let src = rows(&[("3", &[Some("c")]), ("1", &[Some("a")]), ("2", &[Some("b")]), ("4", &[Some("d")])]);
        let dst = rows(&[("2", &[Some("B")]), ("5", &[Some("e")]), ("1", &[Some("a")]), ("3", &[Some("c")])]);
        let mut sink = RecSink::default();
        let o = hash_diff(&mut VecPages::from_rows(src, 2), &mut VecPages::from_rows(dst, 3), &cmp_num(1), &mut sink, &Limits::default(), &AtomicBool::new(false), &mut |_, _| {}).await.unwrap();
        assert_eq!(o, MergeOutcome::Completed);
        assert_eq!(sink.inserts, vec!["4"]);
        assert_eq!(sink.updates, vec![("2".to_string(), vec![0])]);
        assert_eq!(sink.deletes, vec!["5"]);
        assert_eq!(sink.matched, 2);
    }

    #[tokio::test]
    async fn hash_diff_identical_needs_no_second_pass() {
        let a = rows(&[("1", &[Some("x")]), ("2", &[Some("y")])]);
        let mut s = VecPages::from_rows(a.clone(), 10);
        let mut d = VecPages::from_rows(a, 10);
        let mut sink = RecSink::default();
        let o = hash_diff(&mut s, &mut d, &cmp_num(1), &mut sink, &Limits::default(), &AtomicBool::new(false), &mut |_, _| {}).await.unwrap();
        assert_eq!(o, MergeOutcome::Completed);
        assert_eq!(sink.matched, 2);
        // 沒有第二趟：兩側都只掃過一次。
        assert_eq!(s.rows_seen(), 2);
        assert_eq!(d.rows_seen(), 2);
    }

    #[tokio::test]
    async fn dst_only_columns_are_ignored_via_projection() {
        // 投影在 rowstream 做；這裡 values 已只含共同欄位，NULL vs 空字串依 null_eq_empty。
        let src = rows(&[("1", &[None])]);
        let dst = rows(&[("1", &[Some("")])]);
        let mut sink = RecSink::default();
        let mut c = cmp_num(1);
        merge_join(&mut VecPages::from_rows(src.clone(), 10), &mut VecPages::from_rows(dst.clone(), 10), &c, &mut sink, &Limits::default(), &AtomicBool::new(false), &mut |_, _| {}).await.unwrap();
        assert_eq!(sink.updates.len(), 1);
        c.null_eq_empty = true;
        let mut sink = RecSink::default();
        merge_join(&mut VecPages::from_rows(src, 10), &mut VecPages::from_rows(dst, 10), &c, &mut sink, &Limits::default(), &AtomicBool::new(false), &mut |_, _| {}).await.unwrap();
        assert_eq!(sink.matched, 1);
    }
}
