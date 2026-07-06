//! 互動查詢的全域防護參數（row cap / 查詢逾時）。
//!
//! - row cap：`run_query` 的結果列數上限，防止誤跑 `SELECT *` 大表造成記憶體爆量 / UI 凍結。
//!   截斷發生在 driver 的 fetch 端（見各 driver 的 `query_capped`），非 SQL 改寫 —
//!   以支援 SHOW / EXEC / CALL / RETURNING 等任意語句。
//! - 逾時：`ConnectionManager::query` 外層的 tokio timeout 兜底（0 = 關閉）。
//!   DB 端 statement timeout 為第一層（各 driver 連線時設定），此處為未覆蓋時的保險網。
//!
//! 值由前端設定頁透過 `set_query_guard` command 寫入；CLI 以 `--max-rows` 覆寫單次查詢。
//! 明確走「顯式 cap 參數」的路徑（匯出 / 轉移）不受這裡影響。

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// 互動查詢預設列數上限。預設 1,000（0 = 不限）。
static DEFAULT_ROW_CAP: AtomicUsize = AtomicUsize::new(1_000);

/// 查詢逾時毫秒數。預設 0（關閉）— 工具型 app 預設開逾時會誤殺長報表查詢。
static QUERY_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);

pub fn row_cap() -> usize {
    DEFAULT_ROW_CAP.load(Ordering::Relaxed)
}

pub fn set_row_cap(v: usize) {
    DEFAULT_ROW_CAP.store(v, Ordering::Relaxed);
}

pub fn timeout_ms() -> u64 {
    QUERY_TIMEOUT_MS.load(Ordering::Relaxed)
}

pub fn set_timeout_ms(v: u64) {
    QUERY_TIMEOUT_MS.store(v, Ordering::Relaxed);
}
