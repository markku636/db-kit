//! 依主鍵排序的分頁列串流：把 `manager.table_data` 包成可逐頁拉取的 `PageSource`。
//!
//! 分頁策略：
//! - 單一數值主鍵 → keyset（`WHERE pk > last ORDER BY pk`），O(n)；
//! - 其餘（複合 / 字串主鍵）→ OFFSET，靠 `max_rows` 兜底。
//! 兩者都走既有 `table_data`，五種 SQL 引擎的方言差異（MSSQL ORDER BY 必填、Oracle FETCH、
//! 大小寫）已在各 driver 處理，這裡不寫任何方言 SQL。

use async_trait::async_trait;

use super::normalize::{canon_key, CanonKey, CompareMode};
use crate::db::{DataQuery, Filter, Sort, SortDir};
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

/// 每頁列數。比 transfer 的 1000 大一點：比對只讀不寫，往返成本佔比更高。
pub const PAGE_SIZE: u32 = 2000;

/// 一列：典型化主鍵 + 投影到「共同欄位」（來源欄序）的值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub key: CanonKey,
    pub values: Vec<Option<String>>,
}

#[async_trait]
pub trait PageSource: Send {
    /// 下一頁；`None` = 已到末端。
    async fn next_page(&mut self) -> AppResult<Option<Vec<Row>>>;
    /// 從頭再讀（hash_diff 第二趟）。
    async fn reopen(&mut self) -> AppResult<()>;
    fn rows_seen(&self) -> u64;
}

enum Paging {
    Keyset { last: Option<String> },
    Offset { page: u32 },
}

/// 一側資料表的分頁串流。
pub struct PkStream<'a> {
    manager: &'a ConnectionManager,
    conn_id: String,
    database: String,
    table: String,
    /// 這一側的主鍵欄位拼法（依來源主鍵順序）。
    pk_names: Vec<String>,
    /// 這一側的共同欄位拼法（依來源欄序）。
    col_names: Vec<String>,
    key_modes: Vec<CompareMode>,
    trim_ws: bool,
    keyset: bool,
    page_size: u32,
    paging: Paging,
    seen: u64,
    done: bool,
}

impl<'a> PkStream<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        manager: &'a ConnectionManager,
        conn_id: &str,
        database: &str,
        table: &str,
        pk_names: Vec<String>,
        col_names: Vec<String>,
        key_modes: Vec<CompareMode>,
        trim_ws: bool,
        keyset: bool,
        page_size: u32,
    ) -> Self {
        let keyset = keyset && pk_names.len() == 1;
        Self {
            manager,
            conn_id: conn_id.to_string(),
            database: database.to_string(),
            table: table.to_string(),
            pk_names,
            col_names,
            key_modes,
            trim_ws,
            keyset,
            page_size,
            paging: if keyset { Paging::Keyset { last: None } } else { Paging::Offset { page: 0 } },
            seen: 0,
            done: false,
        }
    }

    fn query(&self) -> DataQuery {
        let sorts = self.pk_names.iter().map(|c| Sort { column: c.clone(), dir: SortDir::Asc }).collect();
        let (page, filters) = match &self.paging {
            Paging::Keyset { last } => (
                0,
                last.as_ref()
                    .map(|v| vec![Filter { column: self.pk_names[0].clone(), op: ">".into(), value: Some(v.clone()) }])
                    .unwrap_or_default(),
            ),
            Paging::Offset { page } => (*page, vec![]),
        };
        DataQuery { page, page_size: self.page_size, filters, sorts, match_any: false, count: false }
    }
}

/// 在結果欄位裡找名稱（忽略大小寫）。
fn find_col(cols: &[String], name: &str) -> Option<usize> {
    cols.iter().position(|c| c == name).or_else(|| cols.iter().position(|c| c.eq_ignore_ascii_case(name)))
}

#[async_trait]
impl PageSource for PkStream<'_> {
    async fn next_page(&mut self) -> AppResult<Option<Vec<Row>>> {
        if self.done {
            return Ok(None);
        }
        let q = self.query();
        let pd = self.manager.table_data(&self.conn_id, &self.database, &self.table, &q).await?;
        // 空結果集時部分 driver 連欄名都不回（sqlx 無列可 describe）——這是「到末端」，不是欄位缺失。
        if pd.rows.is_empty() {
            self.done = true;
            return Ok(None);
        }
        let pk_idx: Vec<usize> = self
            .pk_names
            .iter()
            .map(|n| find_col(&pd.columns, n).ok_or_else(|| AppError::Query(tf!("結果缺少主鍵欄位 {col}", col = n))))
            .collect::<AppResult<_>>()?;
        let col_idx: Vec<Option<usize>> = self.col_names.iter().map(|n| find_col(&pd.columns, n)).collect();
        let fetched = pd.rows.len();
        let mut out = Vec::with_capacity(fetched);
        for r in &pd.rows {
            let key = canon_key(r, &pk_idx, &self.key_modes, self.trim_ws);
            let values = col_idx.iter().map(|oi| oi.and_then(|i| r.get(i).cloned().flatten())).collect();
            out.push(Row { key, values });
        }
        self.seen += fetched as u64;
        if fetched < self.page_size as usize {
            self.done = true;
        }
        match &mut self.paging {
            Paging::Keyset { last } => {
                if let Some(r) = pd.rows.last() {
                    // keyset 用原始值（不是正規化後的），交給資料庫自己比。
                    *last = r.get(pk_idx[0]).cloned().flatten();
                    if last.is_none() {
                        // 主鍵為 NULL 不可能（PK），保險：退回 done 以免無限迴圈。
                        self.done = true;
                    }
                }
            }
            Paging::Offset { page } => *page += 1,
        }
        if fetched == 0 {
            return Ok(None);
        }
        Ok(Some(out))
    }

    async fn reopen(&mut self) -> AppResult<()> {
        self.paging = if self.keyset { Paging::Keyset { last: None } } else { Paging::Offset { page: 0 } };
        self.seen = 0;
        self.done = false;
        Ok(())
    }

    fn rows_seen(&self) -> u64 {
        self.seen
    }
}

/// 測試用：記憶體內的分頁來源。
#[cfg(test)]
pub struct VecPages {
    pages: Vec<Vec<Row>>,
    next: usize,
    seen: u64,
}

#[cfg(test)]
impl VecPages {
    pub fn new(pages: Vec<Vec<Row>>) -> Self {
        Self { pages, next: 0, seen: 0 }
    }
    /// 把一串 (key, values) 切成固定大小的頁。
    pub fn from_rows(rows: Vec<Row>, page: usize) -> Self {
        let pages = rows.chunks(page.max(1)).map(|c| c.to_vec()).collect();
        Self::new(pages)
    }
}

#[cfg(test)]
#[async_trait]
impl PageSource for VecPages {
    async fn next_page(&mut self) -> AppResult<Option<Vec<Row>>> {
        if self.next >= self.pages.len() {
            return Ok(None);
        }
        let p = self.pages[self.next].clone();
        self.next += 1;
        self.seen += p.len() as u64;
        Ok(Some(p))
    }
    async fn reopen(&mut self) -> AppResult<()> {
        self.next = 0;
        self.seen = 0;
        Ok(())
    }
    fn rows_seen(&self) -> u64 {
        self.seen
    }
}
