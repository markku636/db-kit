//! 預存程序整合測試核心：情境（多步驟、真實資料、自動 rollback）、斷言、基線回歸、跨引擎差分。
//!
//! 放核心層而非 GUI 層（不 `use tauri`）：進度以 callback 注入，GUI 端包成 Tauri event、
//! CLI 端印文字 / 寫 JUnit，`--no-default-features` 的 slim CLI 也編得起來。
//!
//! 模組分工：
//! - `model`：測試檔 schema。`inspect`：簽名與寫入目標。`session`：專屬連線。`render`：各方言 SQL。
//! - `snapshot`：呼叫前後整表快照 → 副作用。`assert`：期望 vs 實際、兩份輸出互比。`errclass`：錯誤分類。
//! - `run`：情境執行器（模式 assert / record / golden / diff）。`report`：結果型別、基線、JUnit、Markdown。
//! - `scaffold`：從盤點產生測試檔骨架（`dbk sp-test init` 與 GUI「新檔」共用）。

// slim CLI build 只用到部分路徑；GUI build 仍正常檢查 dead_code。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub mod assert;
pub mod errclass;
pub mod inspect;
#[cfg(test)]
mod it_sptest;
pub mod model;
pub mod render;
pub mod report;
pub mod run;
pub mod scaffold;
pub mod session;
pub mod snapshot;

// ---------------------------------------------------------------------------
// 取消登錄簿（與 compare / stress 同一套設計：模組層 static，CLI 無 AppState 也能用）
// ---------------------------------------------------------------------------

static RUNS: Mutex<Vec<(String, Arc<AtomicBool>)>> = Mutex::new(Vec::new());

pub(crate) struct RunGuard {
    run_id: String,
    pub flag: Arc<AtomicBool>,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNS.lock().retain(|(id, _)| id != &self.run_id);
    }
}

pub(crate) fn register(run_id: &str) -> RunGuard {
    let flag = Arc::new(AtomicBool::new(false));
    let mut runs = RUNS.lock();
    runs.retain(|(id, _)| id != run_id);
    runs.push((run_id.to_string(), flag.clone()));
    RunGuard { run_id: run_id.to_string(), flag }
}

/// 要求取消某次執行。回傳是否找到執行中的 run。
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

pub fn is_running(run_id: &str) -> bool {
    RUNS.lock().iter().any(|(id, _)| id == run_id)
}

// ---------------------------------------------------------------------------
// 目標與進度
// ---------------------------------------------------------------------------

/// 一個執行目標：連線 + 容器（MSSQL / MySQL 的資料庫、PG 的 schema）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineRef {
    pub conn_id: String,
    pub database: String,
}

/// 進度快照。`phase`：open | step | assert | close | done。
#[derive(Debug, Clone, Default, Serialize)]
pub struct Progress {
    pub run_id: String,
    pub file: String,
    pub scenario: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    pub index: usize,
    pub total: usize,
}

pub type ProgressFn<'a> = &'a (dyn Fn(Progress) + Send + Sync);
