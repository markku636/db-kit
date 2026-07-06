use std::collections::HashMap;
use std::sync::Arc;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::backup::{self, BackupResult};
use crate::db::{
    AlterOp, BigKey, CellEdit, ClientInfo, ColumnInfo, ConnectionConfig, DataQuery, ErModel,
    ForeignKeyInfo, KeyDetail, KeyEdit, KeyPage, MongoIndexOptions, MongoIndexStat, MongoOp,
    MongoProfile, MongoSlowQuery, MongoValidation, PagedData, PoolStatus, QueryResult, RedisKeys,
    RoutineInfo, RowDelete, RowInsert, SearchHit, SearchOptions, ServerInfoSection, SlowLogEntry, TableInfo,
    ValidationReport,
};
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;
use crate::scheduler::{self, BackupHistoryEntry, BackupSchedule, BackupStatus};
use crate::store::{self, PersistedConnection};

pub struct AppState {
    pub manager: ConnectionManager,
    /// 排程清單的執行時權威副本（背景迴圈每 tick 讀取；命令變更後持久化）。
    pub schedules: Arc<Mutex<Vec<BackupSchedule>>>,
    /// 序列化 history.json 的讀-改-寫（避免排程 append 與 clear_history 競態）。
    pub history_lock: Arc<tokio::sync::Mutex<()>>,
    /// Redis Pub/Sub 訂閱的背景任務（key = 連線 id）。重新訂閱 / 取消訂閱 / 斷線時 abort。
    pub pubsub: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// AI 助手進行中的問答背景任務（key = req_id）。取消時 abort 即終止 claude 子程序。
    pub agent_jobs: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

/// 若前端送來的 secret 為空（存檔但未重新輸入的連線），從 keychain 補回。
/// 剛輸入的新密碼非空 → 跳過，向後相容。
fn hydrate_secrets(config: &mut ConnectionConfig) {
    if config.password.is_empty() {
        config.password = store::kc_get(&config.id).unwrap_or_default();
    }
    if config.otp_secret.is_empty() {
        config.otp_secret = store::kc_get(&store::otp_account(&config.id)).unwrap_or_default();
    }
    if config.ssh_enabled {
        if config.ssh_password.is_empty() {
            config.ssh_password = store::kc_get(&store::ssh_account(&config.id)).unwrap_or_default();
        }
        if config.ssh_passphrase.is_empty() {
            config.ssh_passphrase =
                store::kc_get(&store::ssh_passphrase_account(&config.id)).unwrap_or_default();
        }
    }
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
) -> AppResult<()> {
    let mut config = config;
    hydrate_secrets(&mut config);
    state.manager.test(&config).await
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    config: ConnectionConfig,
) -> AppResult<()> {
    let mut config = config;
    hydrate_secrets(&mut config);
    state.manager.connect(config).await
}

// ---- 連線設定持久化 ----

#[tauri::command]
pub async fn list_saved_connections(app: AppHandle) -> AppResult<Vec<PersistedConnection>> {
    store::load_all(&app).await
}

#[tauri::command]
pub async fn save_connection(app: AppHandle, config: ConnectionConfig) -> AppResult<()> {
    // secret 進 keychain。空字串 = 不變動（編輯連線時未重新輸入密碼則保留舊的）。
    if !config.password.is_empty() {
        store::kc_set(&config.id, &config.password)?;
    }
    if !config.otp_secret.is_empty() {
        store::kc_set(&store::otp_account(&config.id), &config.otp_secret)?;
    }
    if config.ssh_enabled {
        if !config.ssh_password.is_empty() {
            store::kc_set(&store::ssh_account(&config.id), &config.ssh_password)?;
        }
        if !config.ssh_passphrase.is_empty() {
            store::kc_set(
                &store::ssh_passphrase_account(&config.id),
                &config.ssh_passphrase,
            )?;
        }
    }
    store::upsert(&app, PersistedConnection::from(&config)).await
}

#[tauri::command]
pub async fn remove_saved_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    if let Some(h) = state.pubsub.lock().remove(&id) {
        h.abort();
    }
    state.manager.disconnect(&id).await;
    store::remove(&app, &id).await?;
    store::kc_delete(&id);
    store::kc_delete(&store::otp_account(&id));
    store::kc_delete(&store::ssh_account(&id));
    store::kc_delete(&store::ssh_passphrase_account(&id));
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(h) = state.pubsub.lock().remove(&id) {
        h.abort();
    }
    state.manager.disconnect(&id).await;
    Ok(())
}

/// 清除指定連線驅動的查詢快取（外部 gateway 等），供前端「重新整理」強制重抓。
#[tauri::command]
pub async fn clear_cache(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.clear_cache(&id).await
}

// ---- 啟動密碼（app-lock 閘門）----
//
// GUI 啟動時擋一道：Argon2id PHC 雜湊存 app_settings.json（非機密、可落地）。驗證在後端做，
// 明文密碼不落地、不入 keychain。刻意不加密連線機密——機密仍走 OS keychain，dbk CLI 不受影響
//（見 store::AppSettings）。

/// 以隨機 salt 產生 Argon2id PHC 雜湊字串。
fn hash_startup_password(password: &str) -> AppResult<String> {
    let salt_bytes: [u8; 16] = rand::random();
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|e| AppError::Storage(format!("salt 產生失敗：{e}")))?;
    let phc = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::Storage(format!("密碼雜湊失敗：{e}")))?;
    Ok(phc.to_string())
}

/// 常數時間比對（由 argon2 `verify_password` 保證）。雜湊字串無法解析時回 false。
fn verify_startup_hash(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// 是否已設定啟動密碼（前端據此決定啟動時要不要顯示鎖定畫面）。
#[tauri::command]
pub async fn has_startup_password(app: AppHandle) -> AppResult<bool> {
    let s: store::AppSettings = store::read_json(&app, store::APP_SETTINGS_FILE).await?;
    Ok(s.startup_password_hash.is_some())
}

/// 驗證啟動密碼。未設定時一律視為通過（回 true）。
#[tauri::command]
pub async fn verify_startup_password(app: AppHandle, password: String) -> AppResult<bool> {
    let s: store::AppSettings = store::read_json(&app, store::APP_SETTINGS_FILE).await?;
    Ok(match s.startup_password_hash {
        Some(h) => verify_startup_hash(&password, &h),
        None => true,
    })
}

/// 設定 / 變更啟動密碼。已有密碼時必須先以 `current` 驗證通過才可變更。
#[tauri::command]
pub async fn set_startup_password(
    app: AppHandle,
    current: Option<String>,
    next: String,
) -> AppResult<()> {
    if next.is_empty() {
        return Err(AppError::Storage("密碼不可為空".into()));
    }
    let mut s: store::AppSettings = store::read_json(&app, store::APP_SETTINGS_FILE).await?;
    if let Some(existing) = &s.startup_password_hash {
        let ok = current
            .as_deref()
            .map(|c| verify_startup_hash(c, existing))
            .unwrap_or(false);
        if !ok {
            return Err(AppError::Storage("目前密碼不正確".into()));
        }
    }
    s.startup_password_hash = Some(hash_startup_password(&next)?);
    store::write_json(&app, store::APP_SETTINGS_FILE, &s).await
}

/// 移除啟動密碼。必須先以 `current` 驗證通過。
#[tauri::command]
pub async fn clear_startup_password(app: AppHandle, current: String) -> AppResult<()> {
    let mut s: store::AppSettings = store::read_json(&app, store::APP_SETTINGS_FILE).await?;
    if let Some(existing) = &s.startup_password_hash {
        if !verify_startup_hash(&current, existing) {
            return Err(AppError::Storage("目前密碼不正確".into()));
        }
    }
    s.startup_password_hash = None;
    store::write_json(&app, store::APP_SETTINGS_FILE, &s).await
}

/// 加密匯出時的單筆連線（PersistedConnection + 從 keychain 取出的機密）。
/// 只用於加密檔內部，不會以明文落地。
#[derive(serde::Serialize, serde::Deserialize)]
struct ExportedConn {
    #[serde(flatten)]
    base: PersistedConnection,
    #[serde(default)]
    password: String,
    #[serde(default)]
    ssh_password: String,
    #[serde(default)]
    ssh_passphrase: String,
    #[serde(default)]
    otp_secret: String,
}

/// 加密匯出所有連線（**含**密碼 / SSH 機密 / OTP secret，從 keychain 取出），
/// 以 passphrase 派生金鑰用 AES-256-GCM 加密整包寫入 path。回傳匯出筆數。
#[tauri::command]
pub async fn export_connections_encrypted(
    app: AppHandle,
    path: String,
    passphrase: String,
) -> AppResult<usize> {
    if passphrase.is_empty() {
        return Err(AppError::Storage("請提供 passphrase".into()));
    }
    let conns = store::load_all(&app).await?;
    let exported: Vec<ExportedConn> = conns
        .into_iter()
        .map(|c| {
            let id = c.id.clone();
            ExportedConn {
                password: store::kc_get(&id).unwrap_or_default(),
                ssh_password: store::kc_get(&store::ssh_account(&id)).unwrap_or_default(),
                ssh_passphrase: store::kc_get(&store::ssh_passphrase_account(&id)).unwrap_or_default(),
                otp_secret: store::kc_get(&store::otp_account(&id)).unwrap_or_default(),
                base: c,
            }
        })
        .collect();
    let count = exported.len();
    let plain = serde_json::to_vec(&exported)
        .map_err(|e| AppError::Storage(format!("序列化失敗：{e}")))?;
    let blob = crate::conn_crypto::encrypt(&plain, &passphrase)?;
    tokio::fs::write(&path, blob)
        .await
        .map_err(|e| AppError::Storage(format!("寫入失敗：{e}")))?;
    Ok(count)
}

/// 從加密檔匯入連線：以 passphrase 解密後，機密寫回 keychain、設定 upsert。回傳匯入筆數。
#[tauri::command]
pub async fn import_connections_encrypted(
    app: AppHandle,
    path: String,
    passphrase: String,
) -> AppResult<usize> {
    let blob = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Storage(format!("讀取失敗：{e}")))?;
    let plain = crate::conn_crypto::decrypt(&blob, &passphrase)?;
    let exported: Vec<ExportedConn> = serde_json::from_slice(&plain)
        .map_err(|_| AppError::Storage("解密成功但內容格式不符（檔案可能來自不同版本）".into()))?;
    let count = exported.len();
    for e in exported {
        let id = e.base.id.clone();
        if !e.password.is_empty() {
            store::kc_set(&id, &e.password)?;
        }
        if !e.ssh_password.is_empty() {
            store::kc_set(&store::ssh_account(&id), &e.ssh_password)?;
        }
        if !e.ssh_passphrase.is_empty() {
            store::kc_set(&store::ssh_passphrase_account(&id), &e.ssh_passphrase)?;
        }
        if !e.otp_secret.is_empty() {
            store::kc_set(&store::otp_account(&id), &e.otp_secret)?;
        }
        store::upsert(&app, e.base).await?;
    }
    Ok(count)
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<String>> {
    state.manager.list_databases(&id).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<TableInfo>> {
    state.manager.list_tables(&id, &database).await
}

#[tauri::command]
pub async fn table_columns(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    state.manager.table_columns(&id, &database, &table).await
}

#[tauri::command]
pub async fn table_data(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    query: DataQuery,
) -> AppResult<PagedData> {
    state.manager.table_data(&id, &database, &table, &query).await
}

#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
) -> AppResult<QueryResult> {
    state.manager.query(&id, &sql).await
}

/// 將文字內容寫入使用者（透過原生另存對話框）選定的路徑。供匯出查詢結果用。
#[tauri::command]
pub async fn save_text_file(path: String, content: String) -> AppResult<()> {
    std::fs::write(&path, content).map_err(|e| AppError::Query(format!("寫入失敗：{e}")))
}

/// 讀取使用者（透過原生開啟對話框）選定之文字檔內容。供查詢編輯器開啟 .sql 檔用。
/// 上限 8 MiB，避免誤選巨大檔案塞爆編輯器 / 記憶體。
#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    let meta = std::fs::metadata(&path).map_err(|e| AppError::Query(format!("讀取失敗：{e}")))?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err(AppError::Query("檔案過大（上限 8 MiB）".into()));
    }
    std::fs::read_to_string(&path).map_err(|e| AppError::Query(format!("讀取失敗：{e}")))
}

#[tauri::command]
pub async fn update_cell(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    edit: CellEdit,
) -> AppResult<u64> {
    state.manager.update_cell(&id, &database, &table, &edit).await
}

#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    row: RowInsert,
) -> AppResult<u64> {
    state.manager.insert_row(&id, &database, &table, &row).await
}

#[tauri::command]
pub async fn delete_row(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    del: RowDelete,
) -> AppResult<u64> {
    state.manager.delete_row(&id, &database, &table, &del).await
}

#[tauri::command]
pub async fn pool_status(state: State<'_, AppState>, id: String) -> AppResult<PoolStatus> {
    state.manager.pool_status(&id)
}

/// 對既有的活躍連線送出一次輕量往返（SELECT 1 / PING / ping），回傳延遲毫秒。
/// 用途：像 DBeaver / TablePlus 的「Ping」，確認連線（含 SSH 通道）仍然有效並量測 RTT。
#[tauri::command]
pub async fn ping_connection(state: State<'_, AppState>, id: String) -> AppResult<u64> {
    let start = std::time::Instant::now();
    state.manager.ping(&id).await?;
    Ok(start.elapsed().as_millis() as u64)
}

#[tauri::command]
pub async fn key_detail(
    state: State<'_, AppState>,
    id: String,
    database: String,
    key: String,
) -> AppResult<Option<KeyDetail>> {
    state.manager.key_detail(&id, &database, &key).await
}

#[tauri::command]
pub async fn backup_detect_cli(kind: crate::db::DbKind) -> AppResult<bool> {
    Ok(backup::detect_cli(kind).await)
}

#[tauri::command]
pub async fn backup_run(
    config: ConnectionConfig,
    database: String,
    out_path: String,
) -> AppResult<BackupResult> {
    let mut config = config;
    hydrate_secrets(&mut config);
    backup::backup(&config, &database, &out_path).await
}

#[tauri::command]
pub async fn backup_restore(
    config: ConnectionConfig,
    database: String,
    in_path: String,
) -> AppResult<()> {
    let mut config = config;
    hydrate_secrets(&mut config);
    backup::restore(&config, &database, &in_path).await
}

// ---- 查詢效能分析 / 結構編輯 / ER 圖 ----

#[tauri::command]
pub async fn explain_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
) -> AppResult<QueryResult> {
    state.manager.explain(&id, &sql).await
}

/// 欄位資料剖析（總數 / 非空 / 相異）。致敬 Navicat / DataGrip 的欄位統計。
#[tauri::command]
pub async fn column_stats(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    column: String,
) -> AppResult<crate::db::ColumnStats> {
    state.manager.column_stats(&id, &database, &table, &column).await
}

/// 資料表統計（引擎 / 列數估計 / 大小 / 排序規則 / 註解）。
#[tauri::command]
pub async fn table_info(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<Vec<(String, String)>> {
    state.manager.table_info(&id, &database, &table).await
}

/// 列出本表外鍵（含約束名）。
#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ForeignKeyInfo>> {
    state.manager.list_foreign_keys(&id, &database, &table).await
}

/// 建立集合（MongoDB）。
#[tauri::command]
pub async fn create_collection(
    state: State<'_, AppState>,
    id: String,
    database: String,
    name: String,
) -> AppResult<()> {
    state.manager.create_collection(&id, &database, &name).await
}

/// 新增資料庫 / schema（MySQL CREATE DATABASE、PostgreSQL CREATE SCHEMA、MongoDB 具現化）。
#[tauri::command]
pub async fn create_database(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    state.manager.create_database(&id, &name).await
}

/// 刪除集合（MongoDB）。
#[tauri::command]
pub async fn drop_collection(
    state: State<'_, AppState>,
    id: String,
    database: String,
    name: String,
) -> AppResult<()> {
    state.manager.drop_collection(&id, &database, &name).await
}

/// 刪除資料庫 / schema（MySQL DROP DATABASE、PostgreSQL DROP SCHEMA CASCADE、MongoDB Database::drop）。
#[tauri::command]
pub async fn drop_database(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    state.manager.drop_database(&id, &name).await
}

/// 列出預存程序 / 函式 / 觸發器。
#[tauri::command]
pub async fn list_routines(state: State<'_, AppState>, id: String, database: String) -> AppResult<Vec<RoutineInfo>> {
    state.manager.list_routines(&id, &database).await
}

/// 取得預存程序 / 函式 / 觸發器的建立 DDL。
#[tauri::command]
pub async fn routine_definition(
    state: State<'_, AppState>,
    id: String,
    database: String,
    name: String,
    routine_type: String,
) -> AppResult<String> {
    state.manager.routine_definition(&id, &database, &name, &routine_type).await
}

/// 全資料庫物件搜尋（SQL Search）：跨資料庫 / schema 比對名稱 / 定義內文 / 註解。
#[tauri::command]
pub async fn search_objects(
    state: State<'_, AppState>,
    id: String,
    options: SearchOptions,
) -> AppResult<Vec<SearchHit>> {
    state.manager.search_objects(&id, &options).await
}

/// 執行 DDL（CREATE / DROP PROCEDURE / FUNCTION / TRIGGER 等，以簡單查詢協定整段送出）。
#[tauri::command]
pub async fn exec_ddl(state: State<'_, AppState>, id: String, sql: String) -> AppResult<()> {
    state.manager.exec_ddl(&id, &sql).await
}

/// 驗證 DDL 語法而不持久化（PG/SQLite 交易回滾、MySQL 暫存名稱試建）。回傳 ValidationReport。
#[tauri::command]
pub async fn validate_ddl(
    state: State<'_, AppState>,
    id: String,
    database: String,
    sql: String,
) -> AppResult<ValidationReport> {
    state.manager.validate_ddl(&id, &database, &sql).await
}

#[tauri::command]
pub async fn alter_table(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    op: AlterOp,
) -> AppResult<()> {
    state.manager.alter_table(&id, &database, &table, &op).await
}

#[tauri::command]
pub async fn er_model(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<ErModel> {
    state.manager.er_model(&id, &database).await
}

#[tauri::command]
pub async fn table_ddl(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<String> {
    state.manager.table_ddl(&id, &database, &table).await
}

#[tauri::command]
pub async fn table_indexes(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<Vec<crate::db::IndexInfo>> {
    state.manager.table_indexes(&id, &database, &table).await
}

#[tauri::command]
pub async fn drop_index(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    index: String,
) -> AppResult<()> {
    state.manager.drop_index(&id, &database, &table, &index).await
}

#[tauri::command]
pub async fn create_index(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    name: String,
    columns: Vec<String>,
    unique: bool,
) -> AppResult<()> {
    state.manager.create_index(&id, &database, &table, &name, &columns, unique).await
}

#[tauri::command]
pub async fn server_info(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<ServerInfoSection>> {
    state.manager.server_info(&id).await
}

#[tauri::command]
pub async fn redis_keys(
    state: State<'_, AppState>,
    id: String,
    database: String,
    pattern: String,
    limit: usize,
) -> AppResult<RedisKeys> {
    state.manager.scan_keys(&id, &database, &pattern, limit).await
}

/// 文件型：取回整份文件的 canonical extended JSON（供 JSON 編輯器）。
#[tauri::command]
pub async fn document_get(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    doc_id: String,
) -> AppResult<String> {
    state.manager.document_get(&id, &database, &table, &doc_id).await
}

/// 文件型：以整份 extended JSON 文件取代（保真巢狀 / ObjectId / Date）。
#[tauri::command]
pub async fn document_replace(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    doc_id: String,
    doc_json: String,
) -> AppResult<u64> {
    state.manager.document_replace(&id, &database, &table, &doc_id, &doc_json).await
}

// ---- 資料匯出 ----

#[tauri::command]
pub async fn export_table(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    query: DataQuery,
    options: crate::export::ExportOptions,
    out_path: String,
) -> AppResult<crate::export::ExportResult> {
    crate::export::export(&state.manager, &id, &database, &table, &query, &options, &out_path).await
}

/// 匯出「已備妥的查詢結果」到檔案（CSV / TSV / Excel / JSON / SQL / Markdown）。
/// 資料已在前端（查詢結果格），故直接帶欄 + 列回後端走同一套 render 管線，xlsx 等二進位格式亦可用。
#[tauri::command]
pub async fn export_rows(
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    options: crate::export::ExportOptions,
    out_path: String,
) -> AppResult<crate::export::ExportResult> {
    crate::export::export_rows(columns, rows, &options, &out_path).await
}

/// CSV 匯入到資料表（致敬 Navicat / DBeaver 匯入精靈）。逐列以 insert_row 寫入，
/// 沿用各 driver 的型別轉型（PG 等嚴格型別欄位也能匯入），回報成功 / 失敗列數與前幾筆錯誤。
#[tauri::command]
pub async fn import_csv(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    path: String,
    options: crate::import::ImportOptions,
) -> AppResult<crate::import::ImportResult> {
    // 後端讀檔（避免大檔經 JS bridge）；解析 + 寫入由 import::import_csv 處理。
    // 安全上限：避免誤選超大檔（整檔讀進記憶體 + 全列解析）導致 OOM；逐列匯入本就不適合超大檔。
    const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;
    if let Ok(meta) = tokio::fs::metadata(&path).await {
        if meta.len() > MAX_IMPORT_BYTES {
            return Err(AppError::Query(format!(
                "檔案過大（約 {} MB），CSV 匯入上限 100 MB；請先分割檔案",
                meta.len() / 1024 / 1024
            )));
        }
    }
    let content = tokio::fs::read_to_string(&path).await.map_err(|e| {
        // 非 UTF-8（常見於舊版 Excel / ANSI 匯出）給明確指引，而非難懂的原始錯誤。
        if e.kind() == std::io::ErrorKind::InvalidData {
            AppError::Query(
                "檔案非 UTF-8 編碼；請在試算表以「另存新檔 → CSV UTF-8」重新匯出後再試".to_string(),
            )
        } else {
            AppError::Query(format!("讀取檔案失敗：{e}"))
        }
    })?;
    crate::import::import_csv(&state.manager, &id, &database, &table, &content, &options).await
}

/// Excel (.xlsx/.xls) 匯入到資料表（致敬 Navicat 匯入精靈的 Excel 來源）。取第一張工作表，
/// 與 CSV 匯入共用同一套逐列寫入邏輯（型別轉型 / 空→NULL / 錯誤回報）。delimiter 對 Excel 無意義。
#[tauri::command]
pub async fn import_excel(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    path: String,
    options: crate::import::ImportOptions,
) -> AppResult<crate::import::ImportResult> {
    const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;
    if let Ok(meta) = tokio::fs::metadata(&path).await {
        if meta.len() > MAX_IMPORT_BYTES {
            return Err(AppError::Query(format!(
                "檔案過大（約 {} MB），Excel 匯入上限 100 MB",
                meta.len() / 1024 / 1024
            )));
        }
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Query(format!("讀取檔案失敗：{e}")))?;
    crate::import::import_xlsx(&state.manager, &id, &database, &table, &bytes, &options).await
}

/// 匯入預覽：讀檔（CSV / Excel，依副檔名）解析後回傳欄名 + 前幾列 + 總列數，供匯入前檢視 / 對應欄位。
#[tauri::command]
pub async fn import_preview(
    path: String,
    options: crate::import::ImportOptions,
) -> AppResult<crate::import::ImportPreview> {
    const PREVIEW_ROWS: usize = 20;
    let is_excel = {
        let p = path.to_ascii_lowercase();
        p.ends_with(".xlsx") || p.ends_with(".xls")
    };
    let rows = if is_excel {
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| AppError::Query(format!("讀取檔案失敗：{e}")))?;
        crate::import::parse_xlsx(&bytes)?
    } else {
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| AppError::Query(format!("讀取檔案失敗：{e}")))?;
        let delim = options.delimiter.as_deref().and_then(|d| d.chars().next()).unwrap_or(',');
        crate::import::parse_csv(&content, delim)
    };
    let (columns, rows, total_rows) =
        crate::import::build_preview(rows, options.has_header, options.columns.clone(), PREVIEW_ROWS);
    Ok(crate::import::ImportPreview { columns, rows, total_rows })
}

/// 資料傳輸：把來源表的資料複製到目標表（可跨連線 / 跨庫）。致敬 Navicat 的 Data Transfer。
/// 以同名欄位交集傳輸，目標表需先存在。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_table(
    state: State<'_, AppState>,
    src_id: String,
    src_db: String,
    src_table: String,
    dst_id: String,
    dst_db: String,
    dst_table: String,
    options: crate::transfer::TransferOptions,
) -> AppResult<crate::transfer::TransferResult> {
    crate::transfer::transfer_table(
        &state.manager, &src_id, &src_db, &src_table, &dst_id, &dst_db, &dst_table, &options,
    )
    .await
}

/// 匯出整個資料庫的結構 SQL（所有表的建表語句）。致敬 Navicat / DBeaver 的「轉儲結構」。
#[tauri::command]
pub async fn schema_dump(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<String> {
    crate::export::schema_dump(&state.manager, &id, &database).await
}

// ---- Redis 鍵結構編輯 ----

#[tauri::command]
pub async fn key_edit(
    state: State<'_, AppState>,
    id: String,
    database: String,
    key: String,
    edit: KeyEdit,
) -> AppResult<u64> {
    state.manager.key_edit(&id, &database, &key, &edit).await
}

// ---- Redis 進階：成員分頁 / 維運面板 / Pub-Sub（對齊 Another Redis Desktop Manager）----

/// 分頁讀取大型集合鍵成員（hash/set/zset 游標式；list LRANGE 視窗）。
#[tauri::command]
pub async fn redis_key_page(
    state: State<'_, AppState>,
    id: String,
    database: String,
    key: String,
    cursor: u64,
    count: usize,
    filter: String,
    full: Option<bool>,
) -> AppResult<KeyPage> {
    state
        .manager
        .redis_driver(&id)?
        .key_page(&database, &key, cursor, count, &filter, full.unwrap_or(false))
        .await
}

/// 慢查詢日誌（SLOWLOG GET）。
#[tauri::command]
pub async fn redis_slowlog(
    state: State<'_, AppState>,
    id: String,
    count: i64,
) -> AppResult<Vec<SlowLogEntry>> {
    state.manager.redis_driver(&id)?.slowlog(count).await
}

/// 用戶端連線清單（CLIENT LIST）。
#[tauri::command]
pub async fn redis_clients(state: State<'_, AppState>, id: String) -> AppResult<Vec<ClientInfo>> {
    state.manager.redis_driver(&id)?.clients().await
}

/// 中斷指定用戶端（CLIENT KILL ID）。
#[tauri::command]
pub async fn redis_client_kill(
    state: State<'_, AppState>,
    id: String,
    client_id: String,
) -> AppResult<()> {
    state.manager.redis_driver(&id)?.client_kill(&client_id).await
}

/// 大鍵掃描（SCAN 取樣 + MEMORY USAGE，回前 top 名）。
#[tauri::command]
pub async fn redis_big_keys(
    state: State<'_, AppState>,
    id: String,
    database: String,
    sample: usize,
    top: usize,
) -> AppResult<Vec<BigKey>> {
    state.manager.redis_driver(&id)?.big_keys(&database, sample, top).await
}

// ---- MongoDB 專屬（監控 / 進階索引 / validation；Redis 模式：直呼 driver inherent 方法）----

/// $indexStats 索引使用統計（前端與 table_indexes 以名稱 join；失敗降級顯示 "—"）。
#[tauri::command]
pub async fn mongo_index_stats(
    state: State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
) -> AppResult<Vec<MongoIndexStat>> {
    state.manager.mongo_driver(&id)?.index_stats(&database, &collection).await
}

/// 進階索引建立（方向 / text / 2dsphere / hashed + unique / sparse / hidden / TTL / partial）。
#[tauri::command]
pub async fn mongo_create_index(
    state: State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    name: String,
    keys: Vec<(String, String)>,
    options: MongoIndexOptions,
) -> AppResult<()> {
    state
        .manager
        .mongo_driver(&id)?
        .create_index_advanced(&database, &collection, &name, &keys, &options)
        .await
}

#[tauri::command]
pub async fn mongo_get_validation(
    state: State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
) -> AppResult<MongoValidation> {
    state.manager.mongo_driver(&id)?.get_validation(&database, &collection).await
}

#[tauri::command]
pub async fn mongo_set_validation(
    state: State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    validator_json: String,
    level: String,
    action: String,
) -> AppResult<()> {
    state
        .manager
        .mongo_driver(&id)?
        .set_validation(&database, &collection, &validator_json, &level, &action)
        .await
}

/// dbStats 資料庫層級統計。
#[tauri::command]
pub async fn mongo_db_stats(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<(String, String)>> {
    state.manager.mongo_driver(&id)?.db_stats(&database).await
}

/// 進行中操作（$currentOp）。
#[tauri::command]
pub async fn mongo_current_ops(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<MongoOp>> {
    state.manager.mongo_driver(&id)?.current_ops().await
}

/// 終止操作（killOp）。
#[tauri::command]
pub async fn mongo_kill_op(
    state: State<'_, AppState>,
    id: String,
    opid: String,
) -> AppResult<()> {
    state.manager.mongo_driver(&id)?.kill_op(&opid).await
}

#[tauri::command]
pub async fn mongo_profile_get(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<MongoProfile> {
    state.manager.mongo_driver(&id)?.profile_get(&database).await
}

#[tauri::command]
pub async fn mongo_profile_set(
    state: State<'_, AppState>,
    id: String,
    database: String,
    level: i32,
    slow_ms: i64,
) -> AppResult<MongoProfile> {
    state.manager.mongo_driver(&id)?.profile_set(&database, level, slow_ms).await
}

/// system.profile 慢查詢清單。
#[tauri::command]
pub async fn mongo_slow_queries(
    state: State<'_, AppState>,
    id: String,
    database: String,
    limit: u32,
) -> AppResult<Vec<MongoSlowQuery>> {
    state.manager.mongo_driver(&id)?.slow_queries(&database, limit).await
}

/// 發佈訊息（PUBLISH），回傳收到訊息的訂閱者數。
#[tauri::command]
pub async fn redis_publish(
    state: State<'_, AppState>,
    id: String,
    channel: String,
    message: String,
) -> AppResult<i64> {
    state.manager.redis_driver(&id)?.publish(&channel, &message).await
}

/// 推送給前端的 Pub/Sub 訊息（事件 `redis-pubsub`）。
#[derive(Clone, Serialize)]
struct PubSubMessage {
    conn_id: String,
    channel: String,
    pattern: Option<String>,
    payload: String,
}

/// 訂閱頻道 / 樣式：背景任務持有專屬 pub/sub 連線，收到訊息以 `redis-pubsub` 事件推給前端。
/// 重新呼叫會取代既有訂閱（先 abort 舊任務）。
#[tauri::command]
pub async fn redis_subscribe(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    channels: Vec<String>,
    patterns: Vec<String>,
) -> AppResult<()> {
    let driver = state.manager.redis_driver(&id)?;
    let client = driver.pubsub_client();
    // 重新訂閱 = 取代：先收掉舊任務。
    if let Some(h) = state.pubsub.lock().remove(&id) {
        h.abort();
    }

    let app2 = app.clone();
    let id2 = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        use futures::StreamExt;
        let mut pubsub = match client.get_async_pubsub().await {
            Ok(p) => p,
            Err(e) => {
                let _ = app2.emit("redis-pubsub-error", format!("{id2}: {e}"));
                return;
            }
        };
        for c in &channels {
            if let Err(e) = pubsub.subscribe(c).await {
                let _ = app2.emit("redis-pubsub-error", format!("{id2}: subscribe {c} 失敗：{e}"));
            }
        }
        for p in &patterns {
            if let Err(e) = pubsub.psubscribe(p).await {
                let _ = app2.emit("redis-pubsub-error", format!("{id2}: psubscribe {p} 失敗：{e}"));
            }
        }
        let mut stream = pubsub.on_message();
        while let Some(msg) = stream.next().await {
            let channel = msg.get_channel_name().to_string();
            let payload: String = msg.get_payload().unwrap_or_else(|_| {
                String::from_utf8_lossy(msg.get_payload_bytes()).into_owned()
            });
            let pattern = msg.get_pattern::<String>().ok();
            let _ = app2.emit(
                "redis-pubsub",
                PubSubMessage { conn_id: id2.clone(), channel, pattern, payload },
            );
        }
    });
    state.pubsub.lock().insert(id, handle);
    Ok(())
}

/// 取消訂閱：收掉該連線的 pub/sub 背景任務。
#[tauri::command]
pub async fn redis_unsubscribe(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(h) = state.pubsub.lock().remove(&id) {
        h.abort();
    }
    Ok(())
}

// ---- 排程備份 + 備份歷史 ----

#[tauri::command]
pub async fn list_schedules(state: State<'_, AppState>) -> AppResult<Vec<BackupSchedule>> {
    Ok(state.schedules.lock().clone())
}

#[tauri::command]
pub async fn save_schedule(
    app: AppHandle,
    state: State<'_, AppState>,
    schedule: BackupSchedule,
) -> AppResult<BackupSchedule> {
    let mut sched = schedule;
    sched.next_run = scheduler::compute_next_run(&sched.cadence, chrono::Local::now());
    let snapshot = {
        let mut g = state.schedules.lock();
        g.retain(|s| s.id != sched.id);
        g.push(sched.clone());
        g.clone()
    };
    store::write_json(&app, scheduler::SCHEDULES_FILE, &snapshot).await?;
    Ok(sched)
}

#[tauri::command]
pub async fn remove_schedule(
    app: AppHandle,
    state: State<'_, AppState>,
    schedule_id: String,
) -> AppResult<()> {
    let snapshot = {
        let mut g = state.schedules.lock();
        g.retain(|s| s.id != schedule_id);
        g.clone()
    };
    store::write_json(&app, scheduler::SCHEDULES_FILE, &snapshot).await
}

#[tauri::command]
pub async fn toggle_schedule(
    app: AppHandle,
    state: State<'_, AppState>,
    schedule_id: String,
    enabled: bool,
) -> AppResult<BackupSchedule> {
    let (snapshot, updated) = {
        let mut g = state.schedules.lock();
        let idx = g
            .iter()
            .position(|s| s.id == schedule_id)
            .ok_or_else(|| AppError::NotFound(schedule_id.clone()))?;
        let next = if enabled {
            scheduler::compute_next_run(&g[idx].cadence, chrono::Local::now())
        } else {
            g[idx].next_run
        };
        g[idx].enabled = enabled;
        g[idx].next_run = next;
        let updated = g[idx].clone();
        (g.clone(), updated)
    };
    store::write_json(&app, scheduler::SCHEDULES_FILE, &snapshot).await?;
    Ok(updated)
}

#[tauri::command]
pub async fn run_schedule_now(
    app: AppHandle,
    state: State<'_, AppState>,
    schedule_id: String,
) -> AppResult<BackupHistoryEntry> {
    let sched = state
        .schedules
        .lock()
        .iter()
        .find(|s| s.id == schedule_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(schedule_id))?;
    Ok(scheduler::fire_one(&app, &sched).await)
}

#[tauri::command]
pub async fn list_backup_history(app: AppHandle) -> AppResult<Vec<BackupHistoryEntry>> {
    store::read_json(&app, scheduler::HISTORY_FILE).await
}

#[tauri::command]
pub async fn restore_from_history(app: AppHandle, entry_id: String) -> AppResult<()> {
    let hist: Vec<BackupHistoryEntry> =
        store::read_json(&app, scheduler::HISTORY_FILE).await?;
    let entry = hist
        .into_iter()
        .find(|e| e.id == entry_id)
        .ok_or_else(|| AppError::NotFound(entry_id))?;
    if entry.status != BackupStatus::Ok {
        return Err(AppError::Query("此筆為失敗紀錄，無法還原".into()));
    }
    let cfg = store::load_connection(&app, &entry.connection_id).await?;
    backup::restore(&cfg, &entry.database, &entry.path).await
}

#[tauri::command]
pub async fn clear_history(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let _g = state.history_lock.lock().await;
    store::write_json(&app, scheduler::HISTORY_FILE, &Vec::<BackupHistoryEntry>::new()).await
}
