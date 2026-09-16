//! 資料庫比對（結構 + 資料）核心。
//!
//! 放核心層而非 GUI 層（不 `use tauri`）：進度以 callback 注入，GUI 端包成 Tauri event、
//! CLI 端印文字，`--no-default-features` 的 slim CLI 也編得起來。
//!
//! 模組分工：
//! - `schema` / `diff` / `ddl` / `snapshot`：結構擷取 → 結構差異 → 同步 DDL → 快照存讀。
//! - `normalize` / `rowstream` / `merge` / `data`：跨引擎值正規化 → 主鍵分頁串流 → 合併比對 → 資料比對編排。
//!
//! 方向一律是「讓目標（dst）變成來源（src）」：added = 來源有目標無、removed = 目標有來源無。

// slim CLI build 只用到部分路徑；GUI build 仍正常檢查 dead_code。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::manager::ConnectionManager;

pub mod data;
pub mod ddl;
pub mod diff;
#[cfg(test)] mod it_cross;
#[cfg(test)] mod it_mssql;
#[cfg(test)] mod it_mysql;
#[cfg(test)] mod it_pg;
pub mod merge;
pub mod normalize;
pub mod rowstream;
pub mod schema;
pub mod snapshot;

// ---------------------------------------------------------------------------
// 取消登錄簿（與 stress.rs 同一套設計：模組層 static，CLI 無 AppState 也能用）
// ---------------------------------------------------------------------------

/// 執行中比對的取消旗標（key = run_id）。同時執行的比對只有個位數，線性查找即可。
static RUNS: Mutex<Vec<(String, Arc<AtomicBool>)>> = Mutex::new(Vec::new());

/// 登錄一次執行；回傳的 guard 於 drop 時自動註銷（成功 / 錯誤 / panic 皆收掉）。
pub(crate) fn register(run_id: &str) -> RunGuard {
    let flag = Arc::new(AtomicBool::new(false));
    let mut runs = RUNS.lock();
    runs.retain(|(id, _)| id != run_id); // 同 id 重跑：舊登錄直接取代
    runs.push((run_id.to_string(), flag.clone()));
    RunGuard { run_id: run_id.to_string(), flag }
}

pub(crate) struct RunGuard {
    run_id: String,
    pub flag: Arc<AtomicBool>,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNS.lock().retain(|(id, _)| id != &self.run_id);
    }
}

/// 要求取消某次比對。回傳是否找到執行中的比對（false = 已結束或 id 不存在）。
pub fn cancel(run_id: &str) -> bool {
    let runs = RUNS.lock();
    match runs.iter().find(|(id, _)| id == run_id) {
        Some((_, flag)) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// 目前是否有這個 run 在跑（供 GUI 防止重複開跑）。
pub fn is_running(run_id: &str) -> bool {
    RUNS.lock().iter().any(|(id, _)| id == run_id)
}

// ---------------------------------------------------------------------------
// 進度事件（結構擷取與資料比對共用同一個 payload；GUI 以 `compare-progress` 事件廣播）
// ---------------------------------------------------------------------------

/// 進度快照。`run_id` 由前端產生並隨事件帶回，多個比對視窗各認各的。
/// `phase`：capture（擷取結構）| precheck（快速預檢）| scan（逐列比對）| apply（套用同步）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct CompareProgress {
    pub run_id: String,
    pub phase: String,
    pub table: String,
    pub table_index: usize,
    pub table_count: usize,
    pub src_rows: u64,
    pub dst_rows: u64,
    pub inserts: u64,
    pub updates: u64,
    pub deletes: u64,
    pub applied: u64,
    pub elapsed_ms: u64,
}

pub type ProgressFn<'a> = &'a (dyn Fn(CompareProgress) + Send + Sync);

// ---------------------------------------------------------------------------
// 結構比對的「一側」：即時連線或快照檔
// ---------------------------------------------------------------------------

/// 結構比對的來源 / 目標。GUI 與 CLI 共用：兩側皆可為即時連線或快照檔，
/// 即時 vs 快照、快照 vs 快照都自然成立；同步 / 套用僅在目標為 `Live` 時可行。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SchemaSide {
    Live { id: String, database: String },
    Snapshot { path: String },
}

/// 把一側解析成 `DbSchema`：即時連線走 `schema::capture`，快照檔走 `snapshot::load`。
pub async fn resolve_side(
    manager: &ConnectionManager,
    side: &SchemaSide,
    opts: &schema::CaptureOptions,
) -> AppResult<schema::DbSchema> {
    match side {
        SchemaSide::Live { id, database } => {
            let label = format!("{id} / {database}");
            schema::capture(manager, id, database, &label, opts, None).await
        }
        SchemaSide::Snapshot { path } => {
            Ok(snapshot::load(std::path::Path::new(path)).await?.schema)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_cancel_and_guard_drop() {
        {
            let g = register("cmp-test-1");
            assert!(is_running("cmp-test-1"));
            assert!(!g.flag.load(Ordering::Relaxed));
            assert!(cancel("cmp-test-1"));
            assert!(g.flag.load(Ordering::Relaxed));
        }
        // guard drop 後自動註銷。
        assert!(!is_running("cmp-test-1"));
        assert!(!cancel("cmp-test-1"));
    }

    #[test]
    fn schema_side_deserializes_tagged() {
        let s: SchemaSide =
            serde_json::from_str(r#"{"type":"live","id":"c1","database":"shop"}"#).unwrap();
        assert!(matches!(s, SchemaSide::Live { .. }));
        let s: SchemaSide = serde_json::from_str(r#"{"type":"snapshot","path":"a.json"}"#).unwrap();
        assert!(matches!(s, SchemaSide::Snapshot { .. }));
    }
}
