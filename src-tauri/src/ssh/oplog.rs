//! SSH 操作紀錄：終端機執行的指令、檔案面板的動作（上傳 / 下載 / 刪除 / 改名 / 建資料夾 / 權限 / 存檔），
//! 以及連線與斷線。一天一個 JSONL 檔：`<設定目錄>/ssh-oplog/2026-10-02.jsonl`（本機日期），設定在同目錄的
//! `config.json`（開關、保留天數）。
//!
//! 密碼不會進來：指令是前端從畫面上讀的（密碼提示下打的字不會回顯，畫面上沒有），指令裡帶的密碼參數
//! 前端先換成 `***`（見 `src/sshOpLog.ts`）；連線紀錄只有主機、port、帳號。這裡只負責存、查、清，
//! 以及依保留天數刪掉舊檔。不依賴 Tauri。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{Duration, Local, NaiveDate, TimeZone};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};

/// 一筆指令 / 路徑最多存這麼多字（貼上整份腳本時不讓單筆紀錄無限長）。
pub const MAX_DETAIL_CHARS: usize = 8000;
/// 查詢一次最多回這麼多筆（再多請縮小日期範圍）。
pub const MAX_QUERY_LIMIT: usize = 5000;
const DEFAULT_QUERY_LIMIT: usize = 1000;
/// 記住多少條連線的對象（斷線後還要能記到 `exit` 這類最後一條指令，所以不隨斷線移除）。
const MAX_TARGETS: usize = 512;
const CONFIG_FILE: &str = "config.json";

/// 一筆紀錄。欄位名與前端 `SshOpEntry` 一致（snake_case）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpEntry {
    /// 毫秒 epoch。
    pub ts: i64,
    /// `connect` / `disconnect` / `command` / `upload` / `download` / `delete` / `rename` / `mkdir` /
    /// `chmod` / `save` / `create`。
    pub kind: String,
    /// `ssh`（終端機）/ `sftp` / `ftp`。
    pub proto: String,
    #[serde(default)]
    pub conn_id: String,
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// 側欄已存主機的 id（臨時連線沒有）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 指令，或主要的路徑（多個路徑以換行分隔）。
    #[serde(default)]
    pub detail: String,
    /// 改名的新路徑、傳輸的目的地、chmod 的權限（`0755`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// 執行指令時終端機所在的資料夾（知道的話）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 指令從哪裡送出：`keyboard` / `paste` / `compose`（命令列輸入條）/ `ai` / `app`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// `ok` / `error` / `cancelled`。
    #[serde(default = "result_ok")]
    pub result: String,
    /// 錯誤訊息、斷線原因、略過了哪些項目。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn result_ok() -> String {
    "ok".into()
}

/// 一條連線是誰：連上時登記，之後的指令 / 檔案動作用 conn_id 查。
#[derive(Debug, Clone, PartialEq)]
pub struct OpTarget {
    /// `ssh` 或 `ftp`（SSH 連線上的檔案動作記成 `sftp`）。
    pub proto: &'static str,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub session_id: Option<String>,
}

/// 設定：開關與保留天數（0 = 永久保留）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpLogConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_retention")]
    pub retention_days: u32,
}

fn default_enabled() -> bool {
    true
}
fn default_retention() -> u32 {
    90
}

impl Default for OpLogConfig {
    fn default() -> Self {
        Self { enabled: default_enabled(), retention_days: default_retention() }
    }
}

/// 查詢條件。全部可省：省略 = 不限。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OpQuery {
    /// 起（毫秒 epoch，含）。
    #[serde(default)]
    pub from: Option<i64>,
    /// 迄（毫秒 epoch，不含）。
    #[serde(default)]
    pub to: Option<i64>,
    /// 只要這些種類；空 = 全部。
    #[serde(default)]
    pub kinds: Vec<String>,
    /// 只要這台已存主機。
    #[serde(default)]
    pub session_id: Option<String>,
    /// 主機關鍵字（比對 `user@host:port`，不分大小寫）。
    #[serde(default)]
    pub host: String,
    /// 內容關鍵字（比對指令 / 路徑 / 目的地 / 資料夾 / 訊息，不分大小寫）。
    #[serde(default)]
    pub text: String,
    /// 最多幾筆；0 = 預設 1000，上限 `MAX_QUERY_LIMIT`。
    #[serde(default)]
    pub limit: usize,
}

/// 查詢結果：新 → 舊。`more` = 符合條件的不只這些。
#[derive(Debug, Clone, Serialize)]
pub struct OpPage {
    pub entries: Vec<OpEntry>,
    pub more: bool,
}

pub struct OpLog {
    dir: PathBuf,
    cfg: Mutex<OpLogConfig>,
    /// conn_id → (登記順序, 對象)；超過上限丟最舊的。
    targets: Mutex<HashMap<String, (u64, OpTarget)>>,
    seq: Mutex<u64>,
    /// 寫檔互斥；裡面放上次刪舊檔的日期（一天最多掃一次）。
    write: tokio::sync::Mutex<Option<NaiveDate>>,
}

impl OpLog {
    /// 開在 `dir`（不存在沒關係，第一次寫入才建）。設定檔讀不到就用預設值。
    pub fn open(dir: PathBuf) -> Self {
        let cfg = std::fs::read(dir.join(CONFIG_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice::<OpLogConfig>(&b).ok())
            .unwrap_or_default();
        Self {
            dir,
            cfg: Mutex::new(cfg),
            targets: Mutex::new(HashMap::new()),
            seq: Mutex::new(0),
            write: tokio::sync::Mutex::new(None),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn config(&self) -> OpLogConfig {
        *self.cfg.lock()
    }

    /// 存設定（保留天數夾在 0–3650），並馬上照新的保留天數刪舊檔。
    pub async fn set_config(&self, mut c: OpLogConfig) -> AppResult<OpLogConfig> {
        c.retention_days = c.retention_days.min(3650);
        tokio::fs::create_dir_all(&self.dir).await.map_err(|e| self.io_err(e))?;
        let json = serde_json::to_vec_pretty(&c).map_err(|e| AppError::Storage(e.to_string()))?;
        tokio::fs::write(self.dir.join(CONFIG_FILE), json).await.map_err(|e| self.io_err(e))?;
        *self.cfg.lock() = c;
        let mut last = self.write.lock().await;
        self.prune(Local::now().date_naive()).await;
        *last = Some(Local::now().date_naive());
        Ok(c)
    }

    /// 登記一條連線是誰（之後的紀錄用 conn_id 查）。
    pub fn remember(&self, conn_id: &str, target: OpTarget) {
        let n = {
            let mut s = self.seq.lock();
            *s += 1;
            *s
        };
        let mut g = self.targets.lock();
        g.insert(conn_id.to_string(), (n, target));
        if g.len() > MAX_TARGETS {
            if let Some(oldest) = g.iter().min_by_key(|(_, (n, _))| *n).map(|(k, _)| k.clone()) {
                g.remove(&oldest);
            }
        }
    }

    pub fn target(&self, conn_id: &str) -> Option<OpTarget> {
        self.targets.lock().get(conn_id).map(|(_, t)| t.clone())
    }

    /// 以登記過的對象起一筆紀錄（時間 = 現在）。`file_op` = 檔案面板的動作（SSH 連線記成 `sftp`）。
    /// 沒登記過（例如 RustDesk 的傳檔連線）回 `None`：那不是 SSH 的操作，不記。
    pub fn entry(&self, conn_id: &str, kind: &str, file_op: bool) -> Option<OpEntry> {
        let t = self.target(conn_id)?;
        let proto = if file_op && t.proto == "ssh" { "sftp" } else { t.proto };
        Some(OpEntry {
            ts: Local::now().timestamp_millis(),
            kind: kind.to_string(),
            proto: proto.to_string(),
            conn_id: conn_id.to_string(),
            host: t.host,
            port: t.port,
            user: t.user,
            session_id: t.session_id,
            detail: String::new(),
            target: None,
            cwd: None,
            source: None,
            result: result_ok(),
            message: None,
        })
    }

    /// 追加一筆（關掉時什麼都不做）。換日後第一次寫入順便刪掉超過保留天數的舊檔。
    pub async fn append(&self, mut e: OpEntry) -> AppResult<()> {
        if !self.config().enabled {
            return Ok(());
        }
        e.detail = clip(&e.detail, MAX_DETAIL_CHARS);
        let day = day_of(e.ts);
        let mut line = serde_json::to_string(&e).map_err(|e| AppError::Storage(e.to_string()))?;
        line.push('\n');
        let mut last = self.write.lock().await;
        tokio::fs::create_dir_all(&self.dir).await.map_err(|e| self.io_err(e))?;
        let today = Local::now().date_naive();
        if *last != Some(today) {
            self.prune(today).await;
            *last = Some(today);
        }
        let path = self.dir.join(file_name(day));
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(|e| self.io_err(e))?;
        f.write_all(line.as_bytes()).await.map_err(|e| self.io_err(e))?;
        f.flush().await.map_err(|e| self.io_err(e))
    }

    /// 依條件查，新 → 舊。從最新的檔案往回讀，湊滿 `limit` 筆就停。
    pub async fn query(&self, q: &OpQuery) -> AppResult<OpPage> {
        let limit = match q.limit {
            0 => DEFAULT_QUERY_LIMIT,
            n => n.min(MAX_QUERY_LIMIT),
        };
        let from_day = q.from.map(day_of);
        let to_day = q.to.map(|t| day_of(t - 1));
        let host = q.host.trim().to_lowercase();
        let text = q.text.trim().to_lowercase();
        let mut days = self.days().await;
        days.sort_unstable_by(|a, b| b.cmp(a));
        let mut out = Vec::new();
        let mut more = false;
        'files: for day in days {
            if from_day.is_some_and(|d| day < d) || to_day.is_some_and(|d| day > d) {
                continue;
            }
            let Ok(raw) = tokio::fs::read_to_string(self.dir.join(file_name(day))).await else {
                continue;
            };
            let mut todays: Vec<OpEntry> = raw
                .lines()
                .filter_map(|l| serde_json::from_str::<OpEntry>(l).ok())
                .filter(|e| matches(e, q, &host, &text))
                .collect();
            // 同一天裡也可能不照順序（指令要等畫面回顯完才記），照時間排一次。
            todays.sort_by(|a, b| b.ts.cmp(&a.ts));
            for e in todays {
                if out.len() == limit {
                    more = true;
                    break 'files;
                }
                out.push(e);
            }
        }
        Ok(OpPage { entries: out, more })
    }

    /// 刪掉全部紀錄（設定檔留著）。
    pub async fn clear(&self) -> AppResult<()> {
        let _g = self.write.lock().await;
        for day in self.days().await {
            match tokio::fs::remove_file(self.dir.join(file_name(day))).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(self.io_err(e)),
            }
        }
        Ok(())
    }

    /// 目錄裡有紀錄的日期（檔名認不得的不算）。
    async fn days(&self) -> Vec<NaiveDate> {
        let mut out = Vec::new();
        let Ok(mut rd) = tokio::fs::read_dir(&self.dir).await else {
            return out;
        };
        while let Ok(Some(ent)) = rd.next_entry().await {
            if let Some(d) = ent.file_name().to_str().and_then(parse_file_name) {
                out.push(d);
            }
        }
        out
    }

    /// 刪掉比 `today - 保留天數` 還舊的檔（保留天數 0 = 不刪）。失敗就算了，下次再試。
    async fn prune(&self, today: NaiveDate) {
        let keep = self.config().retention_days;
        if keep == 0 {
            return;
        }
        let cutoff = today - Duration::days(i64::from(keep) - 1);
        for day in self.days().await {
            if day < cutoff {
                let _ = tokio::fs::remove_file(self.dir.join(file_name(day))).await;
            }
        }
    }

    fn io_err(&self, e: std::io::Error) -> AppError {
        AppError::Storage(tf!("寫入 SSH 操作紀錄失敗（{path}）：{e}", path = self.dir.display(), e = e))
    }
}

fn matches(e: &OpEntry, q: &OpQuery, host: &str, text: &str) -> bool {
    if q.from.is_some_and(|f| e.ts < f) || q.to.is_some_and(|t| e.ts >= t) {
        return false;
    }
    if !q.kinds.is_empty() && !q.kinds.iter().any(|k| k == &e.kind) {
        return false;
    }
    if let Some(sid) = q.session_id.as_deref().filter(|s| !s.is_empty()) {
        if e.session_id.as_deref() != Some(sid) {
            return false;
        }
    }
    if !host.is_empty() {
        let who = format!("{}@{}:{}", e.user, e.host, e.port).to_lowercase();
        if !who.contains(host) {
            return false;
        }
    }
    if !text.is_empty() {
        let hit = [Some(e.detail.as_str()), e.target.as_deref(), e.cwd.as_deref(), e.message.as_deref()]
            .into_iter()
            .flatten()
            .any(|s| s.to_lowercase().contains(text));
        if !hit {
            return false;
        }
    }
    true
}

/// 毫秒 epoch → 本機日期。
fn day_of(ts: i64) -> NaiveDate {
    Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or_else(|| Local::now().date_naive())
}

fn file_name(day: NaiveDate) -> String {
    format!("{}.jsonl", day.format("%Y-%m-%d"))
}

fn parse_file_name(name: &str) -> Option<NaiveDate> {
    let stem = name.strip_suffix(".jsonl")?;
    NaiveDate::parse_from_str(stem, "%Y-%m-%d").ok()
}

/// 截到 `max` 個字元（以字元算，不切斷 UTF-8），截掉的部分以 `…` 表示。
fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("dbkit-oplog-{}", uuid::Uuid::new_v4()))
    }

    fn web01() -> OpTarget {
        OpTarget { proto: "ssh", host: "web-01".into(), port: 22, user: "deploy".into(), session_id: Some("s1".into()) }
    }

    fn at(day: NaiveDate, h: u32) -> i64 {
        Local.from_local_datetime(&day.and_hms_opt(h, 0, 0).unwrap()).single().unwrap().timestamp_millis()
    }

    fn cmd(log: &OpLog, ts: i64, text: &str) -> OpEntry {
        let mut e = log.entry("c1", "command", false).unwrap();
        e.ts = ts;
        e.detail = text.into();
        e
    }

    #[tokio::test]
    async fn append_query_newest_first_and_filters() {
        let dir = tmp();
        let log = OpLog::open(dir.clone());
        log.remember("c1", web01());
        log.remember("f1", OpTarget { proto: "ftp", host: "files.lan".into(), port: 21, user: "anon".into(), session_id: None });
        let d1 = NaiveDate::from_ymd_opt(2026, 9, 30).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        // 停用保留天數，免得測試日期被當成舊檔刪掉。
        log.set_config(OpLogConfig { enabled: true, retention_days: 0 }).await.unwrap();
        log.append(cmd(&log, at(d1, 9), "ls -la")).await.unwrap();
        log.append(cmd(&log, at(d2, 10), "systemctl restart nginx")).await.unwrap();
        log.append(cmd(&log, at(d2, 8), "uptime")).await.unwrap();
        let mut up = log.entry("c1", "upload", true).unwrap();
        up.ts = at(d2, 11);
        up.detail = "C:\\tmp\\a.txt".into();
        up.target = Some("/var/www/a.txt".into());
        log.append(up).await.unwrap();
        let mut ftp = log.entry("f1", "delete", true).unwrap();
        ftp.ts = at(d2, 12);
        ftp.detail = "/pub/old.zip".into();
        log.append(ftp).await.unwrap();
        // 一天一個檔
        assert!(dir.join("2026-09-30.jsonl").exists());
        assert!(dir.join("2026-10-01.jsonl").exists());

        let all = log.query(&OpQuery::default()).await.unwrap();
        let details: Vec<&str> = all.entries.iter().map(|e| e.detail.as_str()).collect();
        assert_eq!(details, ["/pub/old.zip", "C:\\tmp\\a.txt", "systemctl restart nginx", "uptime", "ls -la"]);
        assert!(!all.more);
        // SSH 連線上的檔案動作記成 sftp；FTP 照舊
        assert_eq!(all.entries[1].proto, "sftp");
        assert_eq!(all.entries[0].proto, "ftp");
        assert_eq!(all.entries[2].proto, "ssh");

        // 種類
        let q = OpQuery { kinds: vec!["command".into()], ..Default::default() };
        assert_eq!(log.query(&q).await.unwrap().entries.len(), 3);
        // 主機（user@host:port，不分大小寫）與已存主機 id
        let q = OpQuery { host: "FILES".into(), ..Default::default() };
        assert_eq!(log.query(&q).await.unwrap().entries.len(), 1);
        let q = OpQuery { session_id: Some("s1".into()), ..Default::default() };
        assert_eq!(log.query(&q).await.unwrap().entries.len(), 4);
        // 內容關鍵字也比對目的地
        let q = OpQuery { text: "/VAR/www".into(), ..Default::default() };
        assert_eq!(log.query(&q).await.unwrap().entries.len(), 1);
        // 日期範圍：只要 9/30
        let q = OpQuery { from: Some(at(d1, 0)), to: Some(at(d2, 0)), ..Default::default() };
        let r = log.query(&q).await.unwrap();
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].detail, "ls -la");
        // limit + more
        let q = OpQuery { limit: 2, ..Default::default() };
        let r = log.query(&q).await.unwrap();
        assert_eq!(r.entries.len(), 2);
        assert!(r.more);

        log.clear().await.unwrap();
        assert!(log.query(&OpQuery::default()).await.unwrap().entries.is_empty());
        // 設定檔留著
        assert!(dir.join(CONFIG_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn disabled_writes_nothing_and_config_persists() {
        let dir = tmp();
        let log = OpLog::open(dir.clone());
        log.remember("c1", web01());
        log.set_config(OpLogConfig { enabled: false, retention_days: 30 }).await.unwrap();
        log.append(cmd(&log, Local::now().timestamp_millis(), "whoami")).await.unwrap();
        assert!(log.query(&OpQuery::default()).await.unwrap().entries.is_empty());
        // 重開讀回同一份設定；保留天數夾在 3650 以內
        let again = OpLog::open(dir.clone());
        assert_eq!(again.config(), OpLogConfig { enabled: false, retention_days: 30 });
        let c = again.set_config(OpLogConfig { enabled: true, retention_days: 99999 }).await.unwrap();
        assert_eq!(c.retention_days, 3650);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn prune_drops_files_past_retention() {
        let dir = tmp();
        std::fs::create_dir_all(&dir).unwrap();
        let today = Local::now().date_naive();
        let old = today - Duration::days(10);
        let recent = today - Duration::days(2);
        for d in [old, recent] {
            std::fs::write(dir.join(file_name(d)), "").unwrap();
        }
        std::fs::write(dir.join("notes.txt"), "keep me").unwrap();
        let log = OpLog::open(dir.clone());
        log.set_config(OpLogConfig { enabled: true, retention_days: 7 }).await.unwrap();
        assert!(!dir.join(file_name(old)).exists());
        assert!(dir.join(file_name(recent)).exists());
        assert!(dir.join("notes.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_conn_is_not_logged_and_targets_are_capped() {
        let log = OpLog::open(tmp());
        assert!(log.entry("nope", "command", false).is_none());
        for i in 0..(MAX_TARGETS + 5) {
            log.remember(&format!("c{i}"), web01());
        }
        assert_eq!(log.targets.lock().len(), MAX_TARGETS);
        // 最舊的被丟掉、最新的還在
        assert!(log.target("c0").is_none());
        assert!(log.target(&format!("c{}", MAX_TARGETS + 4)).is_some());
    }

    #[test]
    fn clip_and_names() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("密碼不記錄", 2), "密碼…");
        let d = NaiveDate::from_ymd_opt(2026, 1, 2).unwrap();
        assert_eq!(file_name(d), "2026-01-02.jsonl");
        assert_eq!(parse_file_name("2026-01-02.jsonl"), Some(d));
        assert_eq!(parse_file_name("config.json"), None);
        assert_eq!(parse_file_name("2026-13-01.jsonl"), None);
    }

    #[test]
    fn old_lines_without_optional_fields_still_parse() {
        let e: OpEntry = serde_json::from_str(r#"{"ts":1,"kind":"command","proto":"ssh","host":"h"}"#).unwrap();
        assert_eq!(e.result, "ok");
        assert_eq!(e.port, 0);
        assert!(e.session_id.is_none());
    }
}
