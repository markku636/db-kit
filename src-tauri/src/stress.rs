//! 壓力測試（Stress Test）核心：以多個並行 worker 對同一連線反覆執行 SQL，
//! 量測吞吐（RPS）與延遲分布（avg / p50 / p90 / p95 / p99 / stddev），並把錯誤指紋化分組。
//!
//! 放核心層而非 GUI 層（不 `use tauri`、不加 `#[cfg(feature = "gui")]`）：進度以 callback 注入，
//! GUI 端包成 Tauri event、CLI 端直接印文字，`--no-default-features` 的 slim CLI 也編得起來。
//!
//! 連線策略：壓測跑「專屬連線池」（連線 id 加 `::stress` 後綴、池大小 = 執行緒數），
//! 不共用互動池——否則 64 條併發查詢會把 UI 用的連線吃光，連線樹 / 自動完成全部卡死。
//! 專屬池於**所有離開路徑**（成功 / 錯誤 / 取消 / panic）都由 `RunGuard` 收掉。

// slim CLI build（`--no-default-features`）不編入 commands，本模組在該組態下沒有呼叫端；
// 統一在模組層放行 dead_code，避免 CLI 建置被一整排「未使用」警告淹沒。
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

/// 並行上限。再高只是把 client 端排隊成本算進延遲，量不到伺服器的真實表現。
const MAX_THREADS: u32 = 64;
/// 進度回報頻率（ms）。太密會讓前端 event 佇列變成瓶頸。
const PROGRESS_MS: u64 = 500;
/// 時間序列取樣頻率（ms）。一格一秒，圖表看得出爬升與劣化拐點。
const SAMPLE_MS: u64 = 1000;
/// 錯誤分組最多保留幾組（依次數由大到小）。
const MAX_ERROR_GROUPS: usize = 20;
/// 單組錯誤訊息長度上限（字元）。
const MAX_ERROR_LEN: usize = 300;
/// 進度列的 p95 只取最近這麼多筆估算——每 500ms 排序整個歷史，取樣本身會反過來拖慢壓測。
const PROGRESS_WINDOW: usize = 50_000;
/// 收尾補一格取樣的最小區間（ms）。太短的尾巴（如 30ms）換算 rps 會噴出假尖峰。
const TAIL_SAMPLE_MIN_MS: u64 = 200;
/// 持續時間上限（秒）= 24 小時。設上界的真正理由是避免極端輸入讓 `secs * 1000`
/// 與 `Instant + Duration` 算術溢位 panic（debug build 直接炸 worker），順便擋掉手滑多打幾個零。
const MAX_DURATION_SECS: u64 = 86_400;

// ---------------------------------------------------------------------------
// DTO（欄位名 = 前端 src/api.ts 的契約，serde 預設 snake_case，勿改）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StressMode {
    /// 固定次數：每個 worker 各跑 `per_thread` 次（總次數 = threads × per_thread）。
    Iterations { per_thread: u64 },
    /// 固定時間：整段跑 `secs` 秒，前 `ramp_secs` 秒把 worker 逐步放進場（ramp 含在 secs 內）。
    Duration { secs: u64, ramp_secs: u64 },
}

#[derive(Debug, Clone, Deserialize)]
pub struct StressPlan {
    /// 至少 1 條；>1 時各 worker 依迭代序輪替取用（模擬混合負載）。
    pub statements: Vec<String>,
    /// 並行 worker 數，夾在 1..=64。
    pub threads: u32,
    pub mode: StressMode,
    /// 每 worker 的暖機次數，不計入統計（讓連線池建好連線、伺服器 plan cache 熱起來）。
    pub warmup_iterations: u64,
    pub delay_ms: u64,
    /// 每次查詢取回的列數上限（0 = 不截斷）。
    pub row_cap: usize,
    /// 單次查詢逾時（0 = 不逾時）。
    pub query_timeout_ms: u64,
    pub allow_writes: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StressErrorGroup {
    pub message: String,
    pub count: u64,
}

/// 時間序列的一格。**三個數值都是「該區間內」的值，不是累計值**：
/// `rps` = 該區間完成數 / 區間秒數、`p95_ms` = 該區間延遲的 p95、`errors` = 該區間新增錯誤數。
/// 累計值會把後期的劣化平均掉，看不出拐點，故一律存區間值。
#[derive(Debug, Clone, Serialize)]
pub struct StressSample {
    pub t_ms: u64,
    pub rps: f64,
    pub p95_ms: f64,
    pub errors: u64,
}

/// 執行中的即時進度（累計值）。`p95_ms` 為近似值（見 `PROGRESS_WINDOW`）。
#[derive(Debug, Clone, Serialize)]
pub struct StressProgress {
    pub run_id: String,
    pub elapsed_ms: u64,
    pub completed: u64,
    pub errors: u64,
    pub rps: f64,
    pub avg_ms: f64,
    pub p95_ms: f64,
    pub in_flight: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct StressReport {
    pub elapsed_ms: u64,
    pub completed: u64,
    pub errors: u64,
    pub rows_total: u64,
    pub rps: f64,
    pub avg_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub stddev_ms: f64,
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub error_groups: Vec<StressErrorGroup>,
    pub series: Vec<StressSample>,
    pub threads: u32,
    pub mode: String,
    pub warmup_iterations: u64,
    pub cancelled: bool,
}

// ---------------------------------------------------------------------------
// 純函式（統計 / 指紋 / 守門）——單元測試主要落點
// ---------------------------------------------------------------------------

/// 報表數值統一取到小數 3 位：避免 f64 尾差讓 UI 出現 `12.340000000000001`，也縮小 JSON 體積。
/// 非有限值（NaN / inf，如 elapsed 為 0 時的除法）一律歸零，前端不必處理特例。
fn r3(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    (v * 1000.0).round() / 1000.0
}

/// 延遲值不會是 NaN，但 `sort_by` 需要一個 total order 的 fallback。
fn sort_f64(v: &mut [f64]) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
}

/// nearest-rank 百分位：`sorted` 需已由小到大排序，`q` 為 0..=1 的分位（0.95 = p95）。
///
/// 用 nearest-rank 而非線性內插：回傳的一定是「真的量到過的那一次延遲」，
/// 與 DB 慢查詢日誌對得起來，也不會在樣本數少時插出根本沒發生過的數字。
/// 空陣列回 0.0（讓報表欄位維持數值型別，前端不必處理 null）。
pub fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let n = sorted.len();
    let rank = (q.clamp(0.0, 1.0) * n as f64).ceil() as usize;
    sorted[rank.clamp(1, n) - 1]
}

/// 錯誤指紋化（仿 pt-query-digest）：把「只差在參數」的錯誤歸成同一組，
/// 否則 `Duplicate entry '123' …` / `'456' …` 會各佔一組，20 組上限瞬間被灌爆而看不到全貌。
///
/// 規則：引號（' " `）內的內容連同引號換成 `'?'`（三種引號統一輸出單引號，
/// 讓 `` `t` `` 與 `'t'` 這種同義訊息也歸同一組）、數字（含小數 / IP / 版本號）換成 `?`、
/// 連續空白壓成單一空格（多行訊息才穩定），最後截到 300 字元。
pub fn normalize_error(msg: &str) -> String {
    let cs: Vec<char> = msg.chars().collect();
    let n = cs.len();
    let mut out = String::with_capacity(msg.len());
    let mut i = 0usize;
    while i < n {
        let c = cs[i];
        if c == '\'' || c == '"' || c == '`' {
            i += 1;
            while i < n {
                if cs[i] == '\\' {
                    i += 2; // 反斜線跳脫：連同下一個字元吃掉
                    continue;
                }
                if cs[i] == c {
                    // 連續兩個同引號 = 跳脫的引號（SQL 慣例），不算結束
                    if i + 1 < n && cs[i + 1] == c {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push_str("'?'");
            continue;
        }
        if c.is_ascii_digit() {
            i += 1;
            while i < n {
                if cs[i].is_ascii_digit() {
                    i += 1;
                } else if cs[i] == '.' && i + 1 < n && cs[i + 1].is_ascii_digit() {
                    i += 2; // 小數點只在前後都是數字時併入，句末的 `.` 不被吃掉
                } else {
                    break;
                }
            }
            out.push('?');
            continue;
        }
        if c.is_whitespace() {
            while i < n && cs[i].is_whitespace() {
                i += 1;
            }
            out.push(' ');
            continue;
        }
        out.push(c);
        i += 1;
    }
    out.trim().chars().take(MAX_ERROR_LEN).collect()
}

/// 由延遲向量 + 錯誤表 + 耗時算出完整報表。與執行流程解耦（純函式），可直接單元測試。
///
/// `latencies_ms` 不需事先排序（內部複製後排序）；`error_counts` 的 key 應已過 `normalize_error`。
/// 標準差用**母體**公式（樣本即全體，不做 n-1 修正）。
#[allow(clippy::too_many_arguments)]
pub fn summarize(
    latencies_ms: &[f64],
    error_counts: &HashMap<String, u64>,
    elapsed_ms: u64,
    rows_total: u64,
    series: Vec<StressSample>,
    threads: u32,
    mode: &str,
    warmup_iterations: u64,
    cancelled: bool,
) -> StressReport {
    let mut lat = latencies_ms.to_vec();
    sort_f64(&mut lat);
    let completed = lat.len() as u64;
    let errors: u64 = error_counts.values().sum();
    let avg = if completed == 0 {
        0.0
    } else {
        lat.iter().sum::<f64>() / completed as f64
    };
    let var = if completed == 0 {
        0.0
    } else {
        lat.iter().map(|v| (v - avg) * (v - avg)).sum::<f64>() / completed as f64
    };

    // 次數多者在前；同次數以訊息排序，讓輸出穩定可比對（回歸測試 / 兩次跑分 diff）。
    let mut groups: Vec<StressErrorGroup> = error_counts
        .iter()
        .map(|(m, c)| StressErrorGroup { message: m.clone(), count: *c })
        .collect();
    groups.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.message.cmp(&b.message)));
    groups.truncate(MAX_ERROR_GROUPS);

    StressReport {
        elapsed_ms,
        completed,
        errors,
        rows_total,
        rps: r3(completed as f64 * 1000.0 / elapsed_ms as f64),
        avg_ms: r3(avg),
        min_ms: r3(lat.first().copied().unwrap_or(0.0)),
        max_ms: r3(lat.last().copied().unwrap_or(0.0)),
        stddev_ms: r3(var.sqrt()),
        p50_ms: r3(percentile(&lat, 0.50)),
        p90_ms: r3(percentile(&lat, 0.90)),
        p95_ms: r3(percentile(&lat, 0.95)),
        p99_ms: r3(percentile(&lat, 0.99)),
        error_groups: groups,
        series,
        threads,
        mode: mode.to_string(),
        warmup_iterations,
        cancelled,
    }
}

/// 實際採用的並行數（上限見 `MAX_THREADS`）。0 已由 `validate_plan` 擋掉，這裡只夾上界。
pub fn effective_threads(threads: u32) -> u32 {
    threads.clamp(1, MAX_THREADS)
}

/// 錯誤訊息只帶語句前 80 字，避免把整段 SQL 灌進對話框。
fn brief(sql: &str) -> String {
    let s: String = sql.chars().take(80).collect();
    if s.chars().count() < sql.chars().count() {
        format!("{s}…")
    } else {
        s
    }
}

/// 以「字界」判斷已小寫的 haystack 是否含關鍵字（`deleted_at` 不可命中 `delete`）。
/// 判準與 `cli::guard` 相同，但該處的同名輔助函式是私有的；此處只補一道**壓測獨有**的判斷，
/// 不重做語句切分，故自帶一份極小的字界比對，不動共用守門。
fn has_word(lower: &str, word: &str) -> bool {
    let bytes = lower.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut start = 0usize;
    while let Some(pos) = lower[start..].find(word) {
        let i = start + pos;
        let before_ok = i == 0 || !is_word(bytes[i - 1]);
        let after = i + word.len();
        if before_ok && (after >= bytes.len() || !is_word(bytes[after])) {
            return true;
        }
        start = i + 1; // 命中點必為 ASCII，+1 仍落在字元邊界
    }
    false
}

/// `EXPLAIN ANALYZE` 會真的執行語句時的寫入關鍵字。
const EXPLAIN_WRITE: &[&str] = &["insert", "update", "delete", "merge", "truncate", "drop"];

/// `EXPLAIN ANALYZE <寫入語句>` 不是「只出計畫」：PostgreSQL 與 MySQL 8 都會**實際執行**語句
/// 再回報真實耗時。但兩道既有守門都只看語句首關鍵字——`explain` 既在唯讀白名單內、
/// 也不在高破壞名單內——於是 `EXPLAIN ANALYZE DELETE FROM t` 在 `allow_writes` 為 false / true
/// 兩種模式下都會被放行。互動查詢誤跑一次還救得回來，壓測卻是把同一句重放 threads × iterations 次，
/// 故這道判斷只補在壓測這條路徑上。
///
/// 要求 explain + analyze + 寫入字三者同時出現才擋，把「唯讀查詢剛好提到這些字」的誤擋壓到最低；
/// PostgreSQL 亦接受英式拼法 `ANALYSE`，一併納入。
fn is_executed_explain_write(sql: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    if !has_word(&lower, "explain") {
        return false;
    }
    if !has_word(&lower, "analyze") && !has_word(&lower, "analyse") {
        return false;
    }
    EXPLAIN_WRITE.iter().any(|w| has_word(&lower, w))
}

/// 開跑前的一次性守門，回傳清洗過（去空白、去空句）的語句清單。
///
/// 全部檢查在建連線之前一次做完：壓測是「迴圈重放」，跑到一半才擋下來，
/// 該寫壞的資料早就寫壞了 N 次——所以任一條不合就整個 `Err`，不做部分執行。
pub fn validate_plan(plan: &StressPlan) -> AppResult<Vec<String>> {
    let statements: Vec<String> = plan
        .statements
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if statements.is_empty() {
        return Err(AppError::Query(crate::t!("壓力測試至少需要一條 SQL 語句").into()));
    }
    if plan.threads == 0 {
        return Err(AppError::Query(crate::t!("壓力測試的並行執行緒數至少為 1").into()));
    }
    match plan.mode {
        StressMode::Iterations { per_thread: 0 } => {
            return Err(AppError::Query(crate::t!("壓力測試的每執行緒迭代次數至少為 1").into()));
        }
        StressMode::Duration { secs: 0, .. } => {
            return Err(AppError::Query(crate::t!("壓力測試的持續時間至少為 1 秒").into()));
        }
        StressMode::Duration { secs, .. } if secs > MAX_DURATION_SECS => {
            return Err(AppError::Query(crate::tf!(
                "壓力測試的持續時間上限為 {max} 秒",
                max = MAX_DURATION_SECS
            )));
        }
        _ => {}
    }
    for sql in &statements {
        // 先擋 EXPLAIN ANALYZE 寫入：它會真的執行，而兩道共用守門都只看首關鍵字 `explain` 而放行，
        // 因此不論 allow_writes 與否都要在這裡攔下（見 `is_executed_explain_write`）。
        if is_executed_explain_write(sql) {
            return Err(AppError::Query(crate::tf!(
                "壓力測試會反覆執行語句，已拒絕 EXPLAIN ANALYZE 寫入語句（它會真的執行，不只產生執行計畫）：{sql}",
                sql = brief(sql)
            )));
        }
        if !plan.allow_writes {
            // 唯讀模式：與 CLI query / GUI 查詢同一道守門（含可寫 CTE 偵測）。
            crate::cli::guard::ensure_read_only(sql)?;
        } else if crate::cli::guard::is_destructive_sql(sql) {
            // 已明示允許寫入，仍不放行高破壞語句：這類語句在迴圈裡重放一次就足以清空整張表，
            // 且第二次之後量到的都不是同一件事（表已空），數據本身也沒有意義。
            return Err(AppError::Query(crate::tf!(
                "壓力測試會反覆執行語句，已拒絕高破壞語句（DROP / TRUNCATE 或無 WHERE 的 UPDATE / DELETE）：{sql}",
                sql = brief(sql)
            )));
        }
    }
    Ok(statements)
}

// ---------------------------------------------------------------------------
// 取消登錄簿
// ---------------------------------------------------------------------------

/// 執行中壓測的取消旗標（key = run_id）。
///
/// 用 `Vec` 而非 `HashMap`：`HashMap::new()` 不是 const fn，無法作 static 初始化；
/// 同時執行的壓測本就只有個位數，線性查找成本可忽略。登錄簿放模組層而非 AppState，
/// 是為了讓 CLI（無 AppState）也能用同一套取消機制。
static RUNS: Mutex<Vec<(String, Arc<AtomicBool>)>> = Mutex::new(Vec::new());

fn register(run_id: &str, flag: Arc<AtomicBool>) {
    let mut runs = RUNS.lock();
    runs.retain(|(id, _)| id != run_id); // 同 id 重跑：舊登錄直接取代
    runs.push((run_id.to_string(), flag));
}

fn unregister(run_id: &str) {
    RUNS.lock().retain(|(id, _)| id != run_id);
}

/// 要求取消某次壓測（`run_id` 即 `run_stress` 收到的那一個）。
/// 回傳是否找到執行中的壓測（false = 已結束或 id 不存在）。
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
// 執行
// ---------------------------------------------------------------------------

/// worker 共享的計數器與樣本池。計數器用 atomic、樣本池用 parking_lot Mutex：
/// 取樣端只在每 500ms / 1s 短暫持鎖複製新增段，不會拖慢 worker 的迭代。
#[derive(Default)]
struct Shared {
    completed: AtomicU64,
    errors: AtomicU64,
    rows: AtomicU64,
    /// 延遲總和（微秒）：讓進度列以 O(1) 算平均，不必每次掃整個歷史。
    sum_us: AtomicU64,
    in_flight: AtomicU32,
    /// 成功迭代的延遲（毫秒，依完成順序 append）；最後排序算百分位。
    lat: Mutex<Vec<f64>>,
    /// 指紋化錯誤訊息 → 次數。
    errs: Mutex<HashMap<String, u64>>,
}

/// 取樣游標：靠它把「累計值」換算成 series 需要的「區間值」。
#[derive(Default)]
struct SampleState {
    /// `Shared::lat` 已取樣到的位置。
    cursor: usize,
    /// 上次取樣時的累計錯誤數。
    last_err: u64,
    /// 上次取樣的時間點（ms）。
    last_ms: u64,
}

/// 收尾守衛：壓測專屬連線池與取消登錄，無論成功 / 失敗 / 取消 / panic 都要收乾淨，
/// 否則專屬池（含 SSH tunnel）會留著不放，下次重跑又疊一個。
///
/// `Drop` 不能 await，故正常路徑走 `finish().await`（同步等到真的斷線）；
/// Drop 裡的背景斷線只是 panic / 提早 return 的保險絲。
struct RunGuard {
    manager: Arc<ConnectionManager>,
    conn_id: String,
    run_id: String,
    done: bool,
}

impl RunGuard {
    async fn finish(mut self) {
        self.done = true;
        unregister(&self.run_id);
        self.manager.disconnect(&self.conn_id).await;
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        unregister(&self.run_id);
        let manager = self.manager.clone();
        let id = std::mem::take(&mut self.conn_id);
        // unwind 時仍在 tokio 任務內，拿得到 handle；真的沒有 runtime 就只能放棄
        //（此時整個 runtime 正在收攤，連線池也會隨之釋放）。
        if let Ok(h) = tokio::runtime::Handle::try_current() {
            h.spawn(async move { manager.disconnect(&id).await });
        }
    }
}

/// 執行一次壓力測試。
///
/// `manager` 收 `Arc` 而非 `&`：worker 以 `tokio::spawn` 送到 runtime 的執行緒池才是真並行
/// （借用的引用滿足不了 spawn 的 'static）。
/// `on_progress` 則是借用即可——取樣迴圈與本函式同一個任務，不跨 spawn。
///
/// 時間基準：`t0` 設在 spawn worker 之時，暖機與 ramp 的時間都算在 `elapsed_ms` 內
/// （不另設 barrier 同步暖機終點，避免任一 worker 提早結束造成 barrier 死等）；
/// 因此 `rps` 是「含暖機 / 爬升的整體平均」，暖機次數請設小值。
pub async fn run_stress(
    manager: Arc<ConnectionManager>,
    run_id: &str,
    config: ConnectionConfig,
    plan: StressPlan,
    on_progress: &(dyn Fn(StressProgress) + Send + Sync),
) -> AppResult<StressReport> {
    // 1) 守門：語句與參數全部檢查完才建連線。
    let statements = Arc::new(validate_plan(&plan)?);
    let threads = effective_threads(plan.threads);
    let mode_name = match plan.mode {
        StressMode::Iterations { .. } => "iterations",
        StressMode::Duration { .. } => "duration",
    };

    // 2) 專屬連線池：沿用既有 connect（SSH tunnel / TLS / CA 都已處理），只改 id 與池大小。
    //
    // 池 id 必須含 run_id：manager.connect 對同 id 會「先斷舊的再建新的」，若兩個壓測視窗
    // 打同一條連線而共用 `{id}::stress`，後開的那個會把先開的池抽掉——先開的剩餘迭代全部
    // 收到 connection not found（報表變成一堆假錯誤，使用者會誤判成資料庫掛了），
    // 接著先開的收尾又把後開的池斷掉，兩邊數據都作廢。加上 run_id 後彼此完全隔離。
    let mut cfg = config;
    let stress_id = format!("{}::stress::{run_id}", cfg.id);
    cfg.id = stress_id.clone();
    cfg.max_connections = threads;

    let cancel_flag = Arc::new(AtomicBool::new(false));
    register(run_id, cancel_flag.clone());
    // 先立守衛再連線：connect 失敗時也要把登錄簿清掉（且 disconnect 不存在的 id 是 no-op）。
    let guard = RunGuard {
        manager: manager.clone(),
        conn_id: stress_id.clone(),
        run_id: run_id.to_string(),
        done: false,
    };
    manager.connect(cfg).await?;

    // 3) 開跑。
    let shared = Arc::new(Shared::default());
    let plan = Arc::new(plan);
    let conn_id = Arc::new(stress_id);
    let t0 = Instant::now();
    let mut set = tokio::task::JoinSet::new();
    for idx in 0..threads {
        set.spawn(worker(
            manager.clone(),
            conn_id.clone(),
            statements.clone(),
            plan.clone(),
            shared.clone(),
            cancel_flag.clone(),
            idx,
            threads,
            t0,
        ));
    }

    // 4) 進度 / 取樣：與 worker 併行，但跑在**本任務**內（on_progress 是借來的引用，不能 move 進 spawn）。
    let mut series: Vec<StressSample> = Vec::new();
    let mut st = SampleState::default();
    let mut prog_tick = tokio::time::interval(Duration::from_millis(PROGRESS_MS));
    let mut samp_tick = tokio::time::interval(Duration::from_millis(SAMPLE_MS));
    prog_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    samp_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // interval 的第一次 tick 立即返回，丟掉以免 t=0 就推一筆全零的進度 / 樣本。
    prog_tick.tick().await;
    samp_tick.tick().await;
    loop {
        // join_next 是 cancel-safe 的（其他分支先完成時不會掉任務），可直接放進 select!。
        // worker 不回傳值；某個 worker panic（JoinError）也只當它結束，其餘照跑完。
        tokio::select! {
            done = set.join_next() => if done.is_none() { break },
            _ = prog_tick.tick() => on_progress(make_progress(&shared, run_id, t0)),
            _ = samp_tick.tick() => push_sample(&shared, t0.elapsed().as_millis() as u64, &mut st, &mut series),
        }
    }

    // 5) 收尾：補最後一格（不足一秒的尾巴太短就不補，免得換算出假尖峰；
    //    但整場都還沒取樣過時一定補一格，否則圖表會是空的）與最後一次進度。
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    if series.is_empty() || elapsed_ms.saturating_sub(st.last_ms) >= TAIL_SAMPLE_MIN_MS {
        push_sample(&shared, elapsed_ms, &mut st, &mut series);
    }
    on_progress(make_progress(&shared, run_id, t0));

    let cancelled = cancel_flag.load(Ordering::Relaxed);
    // worker 都已結束，此處無競爭；take 出來避免再複製一份大向量。
    let lat = std::mem::take(&mut *shared.lat.lock());
    let errs = std::mem::take(&mut *shared.errs.lock());
    let report = summarize(
        &lat,
        &errs,
        elapsed_ms,
        shared.rows.load(Ordering::Relaxed),
        series,
        threads,
        mode_name,
        plan.warmup_iterations,
        cancelled,
    );
    guard.finish().await;
    Ok(report)
}

/// 單次迭代：查詢 + 可選逾時。回傳取回的列數（供 `rows_total` 累計）。
///
/// 逾時語意與互動查詢一致：只放棄本端等待，伺服器端查詢可能仍在跑
/// （壓測下這點很重要——逾時不代表伺服器負載跟著消失）。
async fn exec_once(
    manager: &ConnectionManager,
    conn_id: &str,
    sql: &str,
    row_cap: usize,
    timeout_ms: u64,
) -> AppResult<usize> {
    let fut = manager.query_capped(conn_id, sql, row_cap);
    let r = if timeout_ms == 0 {
        fut.await
    } else {
        match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
            Ok(v) => v,
            Err(_) => Err(AppError::Timeout(timeout_ms)),
        }
    };
    r.map(|q| q.rows.len())
}

/// 可被取消打斷的等待。取消旗標只在迴圈頂端看得到，若整段 delay 一次睡完，
/// 使用者按下停止後最久要等一整個 delay_ms 才收手（前端容許到 60 秒，ramp 更可長達數十秒）——
/// 那段期間 UI 停在「停止中」、專屬連線池也還沒還回去。故切成小段，段與段之間回頭看一次旗標。
/// delay 本來就 ≤ 一段的長度時只睡一次，行為與直接 sleep 相同。
async fn sleep_cancellable(total: Duration, cancel: &AtomicBool) {
    const STEP: Duration = Duration::from_millis(100);
    let mut left = total;
    while left > Duration::ZERO {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let step = left.min(STEP);
        tokio::time::sleep(step).await;
        left -= step;
    }
}

#[allow(clippy::too_many_arguments)]
async fn worker(
    manager: Arc<ConnectionManager>,
    conn_id: Arc<String>,
    statements: Arc<Vec<String>>,
    plan: Arc<StressPlan>,
    shared: Arc<Shared>,
    cancel: Arc<AtomicBool>,
    idx: u32,
    threads: u32,
    t0: Instant,
) {
    let stmts = statements.as_slice();
    let delay = Duration::from_millis(plan.delay_ms);

    // 暖機：先把連線建起來、讓伺服器的 plan cache / buffer pool 熱起來。
    // 不計入任何統計——否則首次建連的數十毫秒會整個灌進 p99，看起來像伺服器有問題。
    for i in 0..plan.warmup_iterations {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let sql = &stmts[(i as usize) % stmts.len()];
        let _ = exec_once(&manager, &conn_id, sql, plan.row_cap, plan.query_timeout_ms).await;
        if plan.delay_ms > 0 {
            sleep_cancellable(delay, &cancel).await;
        }
    }

    // Duration + ramp：第 i 個 worker 延遲 ramp*i/threads 秒才進場，讓負載逐步爬升。
    // 一次全開會撞出假的尖峰延遲，也看不出系統是在多少併發開始劣化。
    //
    // deadline 由呼叫端傳進來的 t0（spawn 之前取的）推算，不是在這裡 `Instant::now()`：
    // 後者會讓每個 worker 從「自己暖機結束」才起算，而 elapsed_ms / rps 卻是從 t0 算的，
    // 兩者不一致 —— 設 30 秒實跑 32 秒、rps 被暖機時間稀釋。secs 的語意是「自壓測開始的
    // 總時間預算」（含暖機與 ramp），與報表的 elapsed_ms 同一個基準。
    let (deadline, max_iters) = match plan.mode {
        StressMode::Duration { secs, ramp_secs } => {
            let d = t0 + Duration::from_secs(secs);
            let ramp_ms = ramp_secs.min(secs) * 1000 * idx as u64 / threads.max(1) as u64;
            if ramp_ms > 0 {
                // 進場等待同樣要能被取消：ramp 容許到與 secs 等長，最後進場的 worker 可能要睡上幾分鐘，
                // 一次睡完會讓「停止」到 run_stress 真的回傳之間空等這麼久。
                sleep_cancellable(Duration::from_millis(ramp_ms), &cancel).await;
            }
            (Some(d), u64::MAX)
        }
        StressMode::Iterations { per_thread } => (None, per_thread),
    };

    let mut iter: u64 = 0;
    while iter < max_iters {
        // 每輪先看取消旗標：使用者按下停止後，最多再多跑一次迭代就收工。
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if let Some(d) = deadline {
            if Instant::now() >= d {
                break;
            }
        }
        // 多語句時輪替取用，讓每條語句的樣本數平均。
        let sql = &stmts[(iter as usize) % stmts.len()];
        shared.in_flight.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let r = exec_once(&manager, &conn_id, sql, plan.row_cap, plan.query_timeout_ms).await;
        let el = started.elapsed();
        shared.in_flight.fetch_sub(1, Ordering::Relaxed);
        match r {
            Ok(rows) => {
                shared.rows.fetch_add(rows as u64, Ordering::Relaxed);
                shared.sum_us.fetch_add(el.as_micros() as u64, Ordering::Relaxed);
                shared.lat.lock().push(el.as_secs_f64() * 1000.0);
                // completed 最後才加：取樣端據此顯示完成數，先加會出現「完成數比延遲樣本多」的瞬間。
                shared.completed.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                // 用 Display（中性英文）而非 message()（已本地化）做指紋：
                // 中途切語言不會讓同一種錯誤裂成兩組。
                *shared.errs.lock().entry(normalize_error(&e.to_string())).or_insert(0) += 1;
                shared.errors.fetch_add(1, Ordering::Relaxed);
            }
        }
        iter += 1;
        if plan.delay_ms > 0 {
            sleep_cancellable(delay, &cancel).await;
        }
    }
}

/// 組一筆即時進度（累計值）。
fn make_progress(shared: &Shared, run_id: &str, t0: Instant) -> StressProgress {
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let completed = shared.completed.load(Ordering::Relaxed);
    let sum_us = shared.sum_us.load(Ordering::Relaxed);
    // p95 只取最近 PROGRESS_WINDOW 筆估算：每 500ms 排序整個歷史，取樣會反過來變成瓶頸。
    let mut recent = {
        let g = shared.lat.lock();
        let from = g.len().saturating_sub(PROGRESS_WINDOW);
        g[from..].to_vec()
    };
    sort_f64(&mut recent);
    StressProgress {
        run_id: run_id.to_string(),
        elapsed_ms,
        completed,
        errors: shared.errors.load(Ordering::Relaxed),
        rps: r3(completed as f64 * 1000.0 / elapsed_ms as f64),
        avg_ms: if completed == 0 {
            0.0
        } else {
            r3(sum_us as f64 / completed as f64 / 1000.0)
        },
        p95_ms: r3(percentile(&recent, 0.95)),
        in_flight: shared.in_flight.load(Ordering::Relaxed),
    }
}

/// 推一格時間序列。**存的是區間值**：以游標只取上次取樣後新增的那一段延遲，
/// 錯誤數以「累計差」還原，故 rps / p95 / errors 都只反映該區間，不被前期資料稀釋。
fn push_sample(shared: &Shared, t_ms: u64, st: &mut SampleState, series: &mut Vec<StressSample>) {
    let mut window = {
        let g = shared.lat.lock();
        let from = st.cursor.min(g.len());
        g[from..].to_vec()
    };
    st.cursor += window.len();
    sort_f64(&mut window);
    let errs_total = shared.errors.load(Ordering::Relaxed);
    // 取樣受排程抖動影響不會剛好 1000ms，故用實際區間換算；max(1) 避免除以 0。
    let d_ms = t_ms.saturating_sub(st.last_ms).max(1);
    series.push(StressSample {
        t_ms,
        rps: r3(window.len() as f64 * 1000.0 / d_ms as f64),
        p95_ms: r3(percentile(&window, 0.95)),
        errors: errs_total.saturating_sub(st.last_err),
    });
    st.last_err = errs_total;
    st.last_ms = t_ms;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_of(stmts: &[&str], allow_writes: bool) -> StressPlan {
        StressPlan {
            statements: stmts.iter().map(|s| s.to_string()).collect(),
            threads: 4,
            mode: StressMode::Iterations { per_thread: 10 },
            warmup_iterations: 0,
            delay_ms: 0,
            row_cap: 100,
            query_timeout_ms: 0,
            allow_writes,
        }
    }

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    // ---- DTO 線上格式（與 src/api.ts 的型別逐字對照）----

    #[test]
    fn plan_deserializes_exactly_what_the_frontend_sends() {
        // 這段 JSON 是 TS 端 StressPlan / StressMode 序列化後的原樣；欄位名或 tag 一旦漂移，
        // 症狀是使用者按下開始後只收到一句 invalid args，這裡先擋下來。
        let p: StressPlan = serde_json::from_str(
            r#"{"statements":["select 1"],"threads":8,"mode":{"kind":"duration","secs":30,"ramp_secs":5},
                "warmup_iterations":2,"delay_ms":0,"row_cap":100,"query_timeout_ms":0,"allow_writes":false}"#,
        )
        .expect("duration 模式應能反序列化");
        assert!(matches!(p.mode, StressMode::Duration { secs: 30, ramp_secs: 5 }));
        assert_eq!(p.threads, 8);

        let p2: StressPlan = serde_json::from_str(
            r#"{"statements":["select 1"],"threads":1,"mode":{"kind":"iterations","per_thread":50},
                "warmup_iterations":0,"delay_ms":10,"row_cap":0,"query_timeout_ms":5000,"allow_writes":true}"#,
        )
        .expect("iterations 模式應能反序列化");
        assert!(matches!(p2.mode, StressMode::Iterations { per_thread: 50 }));
    }

    #[test]
    fn report_serializes_with_the_contracted_field_names() {
        let r = summarize(
            &[1.0],
            &HashMap::from([("boom".to_string(), 1u64)]),
            1_000,
            7,
            vec![StressSample { t_ms: 1_000, rps: 1.0, p95_ms: 1.0, errors: 1 }],
            2,
            "duration",
            0,
            false,
        );
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        for k in [
            "elapsed_ms", "completed", "errors", "rows_total", "rps", "avg_ms", "min_ms", "max_ms",
            "stddev_ms", "p50_ms", "p90_ms", "p95_ms", "p99_ms", "error_groups", "series",
            "threads", "mode", "warmup_iterations", "cancelled",
        ] {
            assert!(v.get(k).is_some(), "報表少了契約欄位 {k}");
        }
        assert!(v["error_groups"][0].get("message").is_some());
        assert!(v["error_groups"][0].get("count").is_some());
        for k in ["t_ms", "rps", "p95_ms", "errors"] {
            assert!(v["series"][0].get(k).is_some(), "series 少了契約欄位 {k}");
        }
        // 非有限值會被 serde_json 寫成 null，前端圖表拿到 null 直接斷線；全程不得出現。
        let zero: serde_json::Value =
            serde_json::to_value(summarize(&[], &HashMap::new(), 0, 0, vec![], 1, "duration", 0, true))
                .unwrap();
        assert!(zero.as_object().unwrap().values().all(|x| !x.is_null()));
    }

    // ---- percentile ----

    #[test]
    fn percentile_uses_nearest_rank() {
        let v: Vec<f64> = (1..=100).map(|i| i as f64).collect();
        approx(percentile(&v, 0.50), 50.0);
        approx(percentile(&v, 0.90), 90.0);
        approx(percentile(&v, 0.95), 95.0);
        approx(percentile(&v, 0.99), 99.0);
        // 邊界：0 取最小、1 取最大（nearest-rank 不內插，回傳的都是真實量到的值）。
        approx(percentile(&v, 0.0), 1.0);
        approx(percentile(&v, 1.0), 100.0);
    }

    #[test]
    fn percentile_handles_empty_and_single() {
        assert_eq!(percentile(&[], 0.95), 0.0);
        approx(percentile(&[7.5], 0.5), 7.5);
        approx(percentile(&[7.5], 0.99), 7.5);
        // 分位超界一律夾回 0..=1，不 panic、不越界索引。
        approx(percentile(&[1.0, 2.0], 5.0), 2.0);
        approx(percentile(&[1.0, 2.0], -1.0), 1.0);
    }

    #[test]
    fn percentile_small_sample_rounds_up() {
        // 4 筆時 p50 = ceil(0.5*4)=2 → 第 2 小；p95/p99 皆落在最後一筆。
        let v = vec![10.0, 20.0, 30.0, 40.0];
        approx(percentile(&v, 0.50), 20.0);
        approx(percentile(&v, 0.95), 40.0);
        approx(percentile(&v, 0.99), 40.0);
    }

    // ---- summarize ----

    #[test]
    fn summarize_computes_min_max_stddev_and_rps() {
        let lat = vec![40.0, 10.0, 30.0, 20.0]; // 故意未排序，summarize 應自行排序
        let mut errs = HashMap::new();
        errs.insert("boom".to_string(), 2u64);
        let r = summarize(&lat, &errs, 2_000, 123, vec![], 8, "iterations", 5, false);
        assert_eq!(r.completed, 4);
        assert_eq!(r.errors, 2);
        assert_eq!(r.rows_total, 123);
        approx(r.min_ms, 10.0);
        approx(r.max_ms, 40.0);
        approx(r.avg_ms, 25.0);
        // 母體標準差：sqrt(((15²+5²+5²+15²)/4)) = sqrt(125) ≈ 11.180
        approx(r.stddev_ms, 11.180);
        approx(r.rps, 2.0); // 4 次 / 2 秒
        approx(r.p50_ms, 20.0);
        approx(r.p90_ms, 40.0);
        assert_eq!(r.threads, 8);
        assert_eq!(r.mode, "iterations");
        assert_eq!(r.warmup_iterations, 5);
        assert!(!r.cancelled);
    }

    #[test]
    fn summarize_empty_run_is_all_zero_not_nan() {
        // 一開跑就被取消：沒有任何樣本、elapsed 為 0，所有欄位必須是 0 而非 NaN / inf
        //（NaN 會序列化成 null，前端圖表直接爆）。
        let r = summarize(&[], &HashMap::new(), 0, 0, vec![], 1, "duration", 0, true);
        assert_eq!(r.completed, 0);
        approx(r.rps, 0.0);
        approx(r.avg_ms, 0.0);
        approx(r.min_ms, 0.0);
        approx(r.max_ms, 0.0);
        approx(r.stddev_ms, 0.0);
        approx(r.p99_ms, 0.0);
        assert!(r.cancelled);
        assert!(r.error_groups.is_empty());
    }

    #[test]
    fn summarize_sorts_error_groups_by_count_and_caps_at_20() {
        let mut errs = HashMap::new();
        for i in 0..25u64 {
            errs.insert(format!("err {i}"), i + 1);
        }
        let r = summarize(&[1.0], &errs, 1_000, 0, vec![], 1, "iterations", 0, false);
        assert_eq!(r.error_groups.len(), 20);
        assert_eq!(r.error_groups[0].count, 25); // 次數最多者在前
        assert_eq!(r.error_groups[19].count, 6); // 只留前 20 組
        assert_eq!(r.errors, (1..=25u64).sum::<u64>()); // 總數仍含被截掉的組
    }

    // ---- normalize_error ----

    #[test]
    fn normalize_error_merges_same_shape_messages() {
        let a = normalize_error("Duplicate entry '123' for key 'PRIMARY'");
        let b = normalize_error("Duplicate entry '456' for key 'PRIMARY'");
        assert_eq!(a, b);
        assert_eq!(a, "Duplicate entry '?' for key '?'");
        // 不同引號視為同一種參數位置，一併歸組。
        assert_eq!(
            normalize_error("Unknown column `x` in 'field list'"),
            normalize_error("Unknown column \"y\" in 'field list'")
        );
    }

    #[test]
    fn normalize_error_replaces_numbers_but_keeps_shape() {
        assert_eq!(normalize_error("ERROR 1062 at line 3"), "ERROR ? at line ?");
        // 小數 / IP / 版本號整段視為一個數字；句末的點不被吃掉。
        assert_eq!(normalize_error("timeout after 12.5s."), "timeout after ?s.");
        assert_eq!(normalize_error("connect 192.168.0.11:3306 failed"), "connect ?:? failed");
        // 形狀不同者不可誤併。
        assert_ne!(
            normalize_error("Deadlock found when trying to get lock"),
            normalize_error("Lock wait timeout exceeded")
        );
    }

    #[test]
    fn normalize_error_collapses_whitespace_and_caps_length() {
        assert_eq!(normalize_error("  a\n\t  b  "), "a b");
        let long = "x".repeat(500);
        assert_eq!(normalize_error(&long).chars().count(), MAX_ERROR_LEN);
        // 中文訊息按字元截斷，不可切在 UTF-8 中間（能組回字串就代表沒切壞）。
        let zh = "查詢失敗：".repeat(100);
        assert_eq!(normalize_error(&zh).chars().count(), MAX_ERROR_LEN);
    }

    // ---- 守門 ----

    #[test]
    fn validate_rejects_writes_when_read_only() {
        assert!(validate_plan(&plan_of(&["delete from t where id=1"], false)).is_err());
        assert!(validate_plan(&plan_of(&["update t set a=1 where id=1"], false)).is_err());
        assert!(validate_plan(&plan_of(&["insert into t values (1)"], false)).is_err());
        // 多語句中只要有一條寫入就整個擋（不做部分執行）。
        assert!(validate_plan(&plan_of(&["select 1", "drop table t"], false)).is_err());
        // 可寫 CTE 也擋（首關鍵字是 with，但會改資料）。
        assert!(validate_plan(&plan_of(
            &["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"],
            false
        ))
        .is_err());
    }

    #[test]
    fn validate_allows_reads_and_does_not_misjudge_deleted_at() {
        // 欄名含 delete / update 字根不可被當成寫入語句。
        let p = plan_of(&["select deleted_at, updated_at from t where deleted_at is null"], false);
        assert!(validate_plan(&p).is_ok());
        assert!(validate_plan(&plan_of(&["  SELECT 1  ", "show tables"], false)).is_ok());
        assert!(validate_plan(&plan_of(&["/* c */ explain select 1"], false)).is_ok());
        // 字串字面值裡的分號與寫入字樣不算語句邊界。
        assert!(validate_plan(&plan_of(&["SELECT 'a; delete from t' AS note"], false)).is_ok());
    }

    #[test]
    fn validate_blocks_destructive_even_when_writes_allowed() {
        assert!(validate_plan(&plan_of(&["drop table t"], true)).is_err());
        assert!(validate_plan(&plan_of(&["TRUNCATE TABLE t"], true)).is_err());
        assert!(validate_plan(&plan_of(&["delete from t"], true)).is_err()); // 無 WHERE
        assert!(validate_plan(&plan_of(&["update t set a=1"], true)).is_err()); // 無 WHERE
        // 有 WHERE 的寫入屬一般寫入，允許寫入時放行；deleted_at 一樣不誤判。
        assert!(validate_plan(&plan_of(&["update t set deleted_at=now() where id=1"], true)).is_ok());
        assert!(validate_plan(&plan_of(&["insert into t values (1)"], true)).is_ok());
    }

    #[test]
    fn validate_rejects_bad_parameters() {
        // 空語句 / 全空白語句。
        assert!(validate_plan(&plan_of(&[], false)).is_err());
        assert!(validate_plan(&plan_of(&["   ", "\n"], false)).is_err());
        // threads = 0。
        let mut p = plan_of(&["select 1"], false);
        p.threads = 0;
        assert!(validate_plan(&p).is_err());
        // iterations = 0。
        let mut p = plan_of(&["select 1"], false);
        p.mode = StressMode::Iterations { per_thread: 0 };
        assert!(validate_plan(&p).is_err());
        // duration secs = 0。
        let mut p = plan_of(&["select 1"], false);
        p.mode = StressMode::Duration { secs: 0, ramp_secs: 0 };
        assert!(validate_plan(&p).is_err());
        // duration 超過上限（擋在守門，免得後面的 secs*1000 / Instant 加法溢位 panic）。
        let mut p = plan_of(&["select 1"], false);
        p.mode = StressMode::Duration { secs: u64::MAX, ramp_secs: 0 };
        assert!(validate_plan(&p).is_err());
        // 合法的 duration 照過，且語句已去除前後空白。
        let mut p = plan_of(&["  select 1  "], false);
        p.mode = StressMode::Duration { secs: 30, ramp_secs: 5 };
        assert_eq!(validate_plan(&p).unwrap(), vec!["select 1".to_string()]);
    }

    #[test]
    fn validate_blocks_explain_analyze_writes() {
        // 前提釘樁：共用守門只看首關鍵字 `explain`，唯讀與高破壞兩道都攔不下 EXPLAIN ANALYZE 寫入。
        // 這正是壓測要自己補一道的理由；哪天共用守門變嚴了，這兩行會先失敗來提醒可以移除本地判斷。
        assert!(crate::cli::guard::ensure_read_only("EXPLAIN ANALYZE DELETE FROM users").is_ok());
        assert!(!crate::cli::guard::is_destructive_sql("EXPLAIN ANALYZE DELETE FROM users"));

        for sql in [
            "EXPLAIN ANALYZE DELETE FROM users",
            "explain analyze update t set a=1 where id=1",
            "EXPLAIN (ANALYZE, BUFFERS) INSERT INTO t VALUES (1)",
            "EXPLAIN ANALYSE DELETE FROM t", // PostgreSQL 也吃英式拼法
            "select 1; explain analyze delete from t", // 混在多語句中
        ] {
            assert!(validate_plan(&plan_of(&[sql], false)).is_err(), "read-only: {sql}");
            assert!(validate_plan(&plan_of(&[sql], true)).is_err(), "allow-writes: {sql}");
        }
        // 純讀取的 EXPLAIN ANALYZE、以及只出計畫的 EXPLAIN 不可被誤擋。
        assert!(validate_plan(&plan_of(&["EXPLAIN ANALYZE SELECT * FROM t"], false)).is_ok());
        assert!(validate_plan(&plan_of(&["explain select deleted_at from t"], false)).is_ok());
    }

    #[test]
    fn threads_are_clamped_to_supported_range() {
        assert_eq!(effective_threads(0), 1);
        assert_eq!(effective_threads(16), 16);
        assert_eq!(effective_threads(1_000), MAX_THREADS);
    }

    #[tokio::test]
    async fn delay_and_ramp_waits_are_interrupted_by_cancel() {
        // 按下停止後，等待中的 worker 必須在一個檢查間隔內收手，而不是把整段 delay / ramp 睡完
        //（前端容許 delay 到 60 秒、ramp 到與總時長等長，一次睡完會讓 UI 卡在「停止中」數分鐘）。
        let flag = Arc::new(AtomicBool::new(true));
        let t = Instant::now();
        sleep_cancellable(Duration::from_secs(600), &flag).await;
        assert!(t.elapsed() < Duration::from_millis(500), "已取消卻仍睡了 {:?}", t.elapsed());

        // 等待「途中」才按下停止（真正會發生的順序）：同樣要立刻收手，不能睡滿 600 秒。
        let flag2 = Arc::new(AtomicBool::new(false));
        let f = flag2.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            f.store(true, Ordering::Relaxed);
        });
        let t2 = Instant::now();
        sleep_cancellable(Duration::from_secs(600), &flag2).await;
        assert!(t2.elapsed() < Duration::from_secs(5), "取消後仍空等 {:?}", t2.elapsed());

        // 未取消時仍要睡滿，不可提早返回而讓 delay 形同虛設。
        let flag3 = Arc::new(AtomicBool::new(false));
        let t3 = Instant::now();
        sleep_cancellable(Duration::from_millis(150), &flag3).await;
        assert!(t3.elapsed() >= Duration::from_millis(100), "睡不滿：{:?}", t3.elapsed());
    }

    #[test]
    fn cancel_reports_whether_run_exists() {
        // 未登錄的 run 不該被誤報成「已取消」。
        assert!(!cancel("no-such-run"));
        let flag = Arc::new(AtomicBool::new(false));
        register("unit-run", flag.clone());
        assert!(is_running("unit-run"));
        assert!(cancel("unit-run"));
        assert!(flag.load(Ordering::Relaxed));
        unregister("unit-run");
        assert!(!is_running("unit-run"));
    }
}
