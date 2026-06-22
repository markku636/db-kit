//! 排程備份 + 備份歷史。
//!
//! - 排程持久化於 `schedules.json`，歷史於 `history.json`（重用 `store::read_json/write_json`）。
//! - 啟動時載入排程並重算 next_run；背景 tokio 迴圈每 30s tick 一次，逐一觸發到期排程。
//! - **僅在 app 開啟時執行**（無背景 daemon）；關閉期間到期者不補跑，下次啟動只排未來的下一次。

use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::db::DbKind;

pub const SCHEDULES_FILE: &str = "schedules.json";
pub const HISTORY_FILE: &str = "history.json";
const MAX_HISTORY: usize = 500;
const TICK_SECS: u64 = 30;

/// 觸發週期。結構化 enum，避開 cron 字串的時區/解析陷阱。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Cadence {
    EveryMinutes { minutes: u32 },
    EveryHours { hours: u32 },
    DailyAt { hour: u8, minute: u8 },
}

/// 一筆備份排程。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSchedule {
    pub id: String,
    pub connection_id: String,
    pub database: String,
    pub target_dir: String,
    pub cadence: Cadence,
    pub enabled: bool,
    #[serde(default)]
    pub last_run: Option<DateTime<Local>>,
    #[serde(default)]
    pub next_run: Option<DateTime<Local>>,
    /// 保留份數；None = 全部保留。
    #[serde(default)]
    pub retention_count: Option<u32>,
    #[serde(default)]
    pub created_at: Option<DateTime<Local>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackupStatus {
    Ok,
    Failed,
}

/// 一筆備份歷史。connection_name / kind 反正規化，連線被刪後仍可讀可（部分）還原。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupHistoryEntry {
    pub id: String,
    #[serde(default)]
    pub schedule_id: Option<String>,
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub kind: DbKind,
    pub path: String,
    pub bytes: u64,
    pub method: String,
    pub status: BackupStatus,
    #[serde(default)]
    pub error: Option<String>,
    pub started_at: DateTime<Local>,
    pub finished_at: DateTime<Local>,
}

/// 從 `from` 算出下一次觸發時間。
pub fn compute_next_run(cadence: &Cadence, from: DateTime<Local>) -> Option<DateTime<Local>> {
    match cadence {
        Cadence::EveryMinutes { minutes } => {
            Some(from + chrono::Duration::minutes((*minutes).max(1) as i64))
        }
        Cadence::EveryHours { hours } => {
            Some(from + chrono::Duration::hours((*hours).max(1) as i64))
        }
        Cadence::DailyAt { hour, minute } => {
            let h = (*hour).min(23) as u32;
            let mi = (*minute).min(59) as u32;
            let today = from.date_naive();
            let make = |d: chrono::NaiveDate| -> Option<DateTime<Local>> {
                let naive = d.and_hms_opt(h, mi, 0)?;
                Local.from_local_datetime(&naive).earliest()
            };
            match make(today) {
                Some(c) if c > from => Some(c),
                _ => make(today + chrono::Duration::days(1)),
            }
        }
    }
}

/// 檔名安全字元過濾。
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect()
}

/// 此排程的檔名基底（無時間戳、無副檔名），以排程 id 命名空間化，
/// 避免「同 DB、同目錄」的不同排程互相誤刪（保留份數隔離）或同秒覆蓋。
fn name_base(database: &str, fallback: &str, sched_id: &str) -> String {
    let base = if database.trim().is_empty() { fallback } else { database };
    sanitize(&format!("{base}__{sched_id}"))
}

/// 產生備份檔名：`<base>_<YYYYMMDD-HHMMSS><ext>`。
fn make_filename(base: &str, kind: DbKind, when: DateTime<Local>) -> String {
    format!("{base}_{}{}", when.format("%Y%m%d-%H%M%S"), kind.backup_ext())
}

/// 背景排程迴圈。每 30s 檢查到期排程並逐一（序列）觸發。
pub async fn run_loop(app: AppHandle) {
    let mut ticker = tokio::time::interval(Duration::from_secs(TICK_SECS));
    loop {
        ticker.tick().await;
        let now = Local::now();
        let due: Vec<BackupSchedule> = {
            let schedules = app.state::<AppState>().schedules.clone();
            let guard = schedules.lock();
            guard
                .iter()
                .filter(|s| s.enabled && s.next_run.map_or(true, |t| t <= now))
                .cloned()
                .collect()
        };
        for sched in due {
            let _ = fire_one(&app, &sched).await;
        }
    }
}

/// 觸發單一排程：解析連線（含密碼）→ 備份 → 寫歷史 → 更新 next_run → 保留清理。
/// 回傳該次的歷史紀錄（成功或失敗皆有）。
pub async fn fire_one(app: &AppHandle, sched: &BackupSchedule) -> BackupHistoryEntry {
    let started = Local::now();
    let mut conn_name = sched.connection_id.clone();
    let mut kind = DbKind::Mysql; // 找不到連線時的佔位（該筆必為 Failed，無法還原）。
    let mut base = name_base(&sched.database, "backup", &sched.id);

    let result: Result<crate::backup::BackupResult, String> =
        match crate::store::load_connection(app, &sched.connection_id).await {
            Err(e) => Err(e.to_string()),
            Ok(cfg) => {
                conn_name = cfg.name.clone();
                kind = cfg.kind;
                base = name_base(&sched.database, &cfg.name, &sched.id);
                let filename = make_filename(&base, cfg.kind, started);
                let out_path = Path::new(&sched.target_dir).join(&filename);
                let out_str = out_path.to_string_lossy().to_string();
                // 確保輸出目錄存在。
                if let Err(e) = tokio::fs::create_dir_all(&sched.target_dir).await {
                    Err(format!("建立輸出目錄失敗：{e}"))
                } else {
                    crate::backup::backup(&cfg, &sched.database, &out_str)
                        .await
                        .map_err(|e| e.to_string())
                }
            }
        };

    let finished = Local::now();
    let entry = match result {
        Ok(res) => BackupHistoryEntry {
            id: new_id(),
            schedule_id: Some(sched.id.clone()),
            connection_id: sched.connection_id.clone(),
            connection_name: conn_name,
            database: sched.database.clone(),
            kind,
            path: res.path,
            bytes: res.bytes,
            method: res.method,
            status: BackupStatus::Ok,
            error: None,
            started_at: started,
            finished_at: finished,
        },
        Err(err) => BackupHistoryEntry {
            id: new_id(),
            schedule_id: Some(sched.id.clone()),
            connection_id: sched.connection_id.clone(),
            connection_name: conn_name,
            database: sched.database.clone(),
            kind,
            path: String::new(),
            bytes: 0,
            method: String::new(),
            status: BackupStatus::Failed,
            error: Some(err),
            started_at: started,
            finished_at: finished,
        },
    };

    append_history(app, entry.clone()).await;
    update_schedule_after_run(app, &sched.id, finished).await;

    // 保留清理（僅在備份成功時）。
    if entry.status == BackupStatus::Ok {
        if let Some(n) = sched.retention_count {
            prune_old_backups(&sched.target_dir, &base, kind, n as usize).await;
        }
    }

    entry
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 追加歷史（newest-first，上限 MAX_HISTORY）。以 history_lock 序列化讀-改-寫。
async fn append_history(app: &AppHandle, entry: BackupHistoryEntry) {
    let lock = app.state::<AppState>().history_lock.clone();
    let _g = lock.lock().await;
    let mut hist: Vec<BackupHistoryEntry> = crate::store::read_json(app, HISTORY_FILE)
        .await
        .unwrap_or_default();
    hist.insert(0, entry);
    hist.truncate(MAX_HISTORY);
    if let Err(e) = crate::store::write_json(app, HISTORY_FILE, &hist).await {
        eprintln!("[scheduler] 寫入歷史失敗：{e}");
    }
}

/// 更新該排程的 last_run / next_run 並持久化。
async fn update_schedule_after_run(app: &AppHandle, sched_id: &str, finished: DateTime<Local>) {
    let schedules = app.state::<AppState>().schedules.clone();
    let snapshot = {
        let mut g = schedules.lock();
        if let Some(s) = g.iter_mut().find(|s| s.id == sched_id) {
            s.last_run = Some(finished);
            s.next_run = compute_next_run(&s.cadence, finished);
        }
        g.clone()
    };
    if let Err(e) = crate::store::write_json(app, SCHEDULES_FILE, &snapshot).await {
        eprintln!("[scheduler] 寫入排程失敗：{e}");
    }
}

/// 保留清理：只刪「此排程自己」產出的檔（base + ext 比對），保留最新 n 份。
async fn prune_old_backups(target_dir: &str, base: &str, kind: DbKind, keep: usize) {
    if keep == 0 {
        return;
    }
    let prefix = format!("{base}_");
    let ext = kind.backup_ext();
    let mut matches: Vec<String> = Vec::new();
    let mut rd = match tokio::fs::read_dir(target_dir).await {
        Ok(rd) => rd,
        Err(_) => return,
    };
    while let Ok(Some(ent)) = rd.next_entry().await {
        if let Some(name) = ent.file_name().to_str() {
            if name.starts_with(&prefix) && name.ends_with(ext) {
                matches.push(name.to_string());
            }
        }
    }
    for stale in backups_to_prune(matches, keep) {
        let _ = tokio::fs::remove_file(Path::new(target_dir).join(stale)).await;
    }
}

/// 從符合的備份檔名中挑出「應刪除」者：保留最新 `keep` 個、其餘回傳待刪。
/// 檔名含 `YYYYMMDD-HHMMSS`，字典序遞減即時間遞減，故排序後保留前 keep 個。
/// `keep == 0` 代表「不啟用保留上限」→ 不刪任何檔（與 prune_old_backups 的提前返回一致）。
/// 抽成純函式以便對「會刪檔」的資料風險邏輯做單元測試。
fn backups_to_prune(mut names: Vec<String>, keep: usize) -> Vec<String> {
    if keep == 0 {
        return Vec::new();
    }
    names.sort();
    names.reverse();
    names.into_iter().skip(keep).collect()
}

#[cfg(test)]
mod tests {
    use super::backups_to_prune;

    fn names() -> Vec<String> {
        // 故意亂序，驗證函式自行排序。
        vec![
            "db_20260102-000000.sql".to_string(),
            "db_20260101-000000.sql".to_string(),
            "db_20260103-000000.sql".to_string(),
        ]
    }

    #[test]
    fn keeps_newest_deletes_rest() {
        // keep 2 → 只刪最舊的 1 個（20260101）。
        assert_eq!(backups_to_prune(names(), 2), vec!["db_20260101-000000.sql".to_string()]);
        // keep 1 → 刪最舊 2 個。
        let d = backups_to_prune(names(), 1);
        assert_eq!(d.len(), 2);
        assert!(d.contains(&"db_20260101-000000.sql".to_string()));
        assert!(d.contains(&"db_20260102-000000.sql".to_string()));
        assert!(!d.contains(&"db_20260103-000000.sql".to_string()), "最新檔不應被刪");
    }

    #[test]
    fn keep_zero_or_excess_deletes_nothing() {
        // keep 0 = 不啟用保留上限 → 不刪。
        assert!(backups_to_prune(names(), 0).is_empty());
        // keep >= 檔數 → 不刪。
        assert!(backups_to_prune(names(), 3).is_empty());
        assert!(backups_to_prune(names(), 99).is_empty());
    }
}
