//! AI 資源庫的 Tauri 命令。所有邏輯在 `crate::ai_library`（GUI 與 dbk 共用），這裡只負責
//! 找設定目錄、把結果包成前端要的快照。每次都重讀磁碟：團隊資料夾 `git pull` 之後按「重新載入」即可。

use serde::Serialize;
use tauri::AppHandle;

use crate::ai_library::edit::{self, SaveRequest};
use crate::ai_library::library::{Entry, Issue, Kind};
use crate::ai_library::settings::{self, AiLibrarySettings};
use crate::ai_library::sync::{self, SyncPlan, SyncReport};
use crate::error::{AppError, AppResult};
use crate::store;

#[derive(Debug, Clone, Serialize)]
pub struct TeamDirInfo {
    pub path: String,
    pub label: String,
    pub writable: bool,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryDirs {
    pub personal: String,
    pub teams: Vec<TeamDirInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibrarySnapshot {
    pub entries: Vec<Entry>,
    pub issues: Vec<Issue>,
    pub dirs: LibraryDirs,
    pub settings: AiLibrarySettings,
}

fn snapshot(dir: &std::path::Path) -> LibrarySnapshot {
    let (lib, s) = settings::load_library(dir);
    let teams = s
        .team_dirs
        .iter()
        .map(|t| {
            let p = settings::resolve_dir(dir, &t.path);
            TeamDirInfo { path: p.display().to_string(), label: t.label.clone(), writable: t.writable, exists: p.is_dir() }
        })
        .collect();
    LibrarySnapshot {
        entries: lib.entries,
        issues: lib.issues,
        dirs: LibraryDirs { personal: settings::personal_dir(dir).display().to_string(), teams },
        settings: s,
    }
}

fn storage(e: String) -> AppError {
    AppError::Storage(e)
}

#[tauri::command]
pub async fn ai_library_load(app: AppHandle) -> AppResult<LibrarySnapshot> {
    let dir = store::app_config_dir(&app)?;
    Ok(tauri::async_runtime::spawn_blocking(move || snapshot(&dir)).await.map_err(|e| AppError::Storage(e.to_string()))?)
}

#[tauri::command]
pub async fn ai_library_save(app: AppHandle, req: SaveRequest) -> AppResult<LibrarySnapshot> {
    let dir = store::app_config_dir(&app)?;
    let (lib, s) = settings::load_library(&dir);
    edit::save(&lib, &settings::layers(&dir, &s), &req).map_err(storage)?;
    Ok(snapshot(&dir))
}

#[tauri::command]
pub async fn ai_library_copy(app: AppHandle, kind: Kind, name: String, new_name: String, layer: String) -> AppResult<LibrarySnapshot> {
    let dir = store::app_config_dir(&app)?;
    let (lib, s) = settings::load_library(&dir);
    edit::copy(&lib, &settings::layers(&dir, &s), kind, &name, &new_name, &layer).map_err(storage)?;
    Ok(snapshot(&dir))
}

#[tauri::command]
pub async fn ai_library_delete(app: AppHandle, kind: Kind, name: String, layer: String, lang: Option<String>) -> AppResult<LibrarySnapshot> {
    let dir = store::app_config_dir(&app)?;
    let (lib, s) = settings::load_library(&dir);
    edit::delete(&lib, &settings::layers(&dir, &s), kind, &name, &layer, lang.as_deref()).map_err(storage)?;
    Ok(snapshot(&dir))
}

#[tauri::command]
pub async fn ai_library_settings_set(app: AppHandle, settings_value: AiLibrarySettings) -> AppResult<LibrarySnapshot> {
    let dir = store::app_config_dir(&app)?;
    settings::save(&dir, &settings_value).map_err(|e| AppError::Storage(tf!("寫入 AI 資源庫設定失敗：{e}", e = e)))?;
    Ok(snapshot(&dir))
}

/// 在檔案總管開啟資料夾（預設個人層；不存在就先建立，使用者才有地方放檔案）。
#[tauri::command]
pub async fn ai_library_reveal(app: AppHandle, path: Option<String>) -> AppResult<()> {
    let dir = store::app_config_dir(&app)?;
    let target = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) if !p.starts_with("builtin:") => {
            let pb = std::path::PathBuf::from(p);
            if pb.is_file() { pb.parent().map(|x| x.to_path_buf()).unwrap_or(pb) } else { pb }
        }
        _ => {
            let p = settings::personal_dir(&dir);
            std::fs::create_dir_all(&p).map_err(|e| AppError::Storage(tf!("建立資料夾失敗：{e}", e = e)))?;
            p
        }
    };
    crate::agent::open_path(&target);
    Ok(())
}

#[tauri::command]
pub async fn ai_library_sync_plan(app: AppHandle) -> AppResult<SyncPlan> {
    let dir = store::app_config_dir(&app)?;
    let (lib, s) = settings::load_library(&dir);
    Ok(sync::plan(&lib, &s, &dir, crate::i18n::current().as_code()))
}

/// 重新產生計畫再套用（不信任前端送回的計畫：兩次呼叫之間檔案可能被改過）。
#[tauri::command]
pub async fn ai_library_sync_apply(app: AppHandle) -> AppResult<SyncReport> {
    let dir = store::app_config_dir(&app)?;
    let (lib, s) = settings::load_library(&dir);
    let plan = sync::plan(&lib, &s, &dir, crate::i18n::current().as_code());
    Ok(sync::apply(&plan, &dir))
}
