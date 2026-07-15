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
    RoutineInfo, RowDelete, RowInsert, SearchHit, SearchOptions, ServerInfoSection, SlowLogEntry, TableColumns,
    TableInfo, ValidationReport,
};
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;
use crate::scheduler::{self, BackupHistoryEntry, BackupSchedule, BackupStatus};
use crate::store::{self, PersistedConnection};
#[cfg(feature = "kafka")]
use crate::db::kafka::dto::{
    KafkaBatchResult, KafkaClusterInfo, KafkaConfigEntry, KafkaConsumeQuery, KafkaConsumeResult,
    KafkaConsumerGroup, KafkaCreateTopicSpec, KafkaDeleteRecordsResult, KafkaGroupDetail,
    KafkaOffsetPlanRow, KafkaOffsetReset, KafkaPartitionInfo, KafkaProduceRequest,
    KafkaProduceResult, KafkaSchema, KafkaSchemaSubject, KafkaStart, KafkaTopic,
};

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
    /// Kafka live-tail 的取消旗標（key = 連線 id；每連線一個 tail）。停止 / 斷線時設 true，
    /// poll 執行緒下一輪見到即退出並釋放 consumer（BaseConsumer drop 快速）。
    #[cfg(feature = "kafka")]
    pub kafka_tails: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// Kafka 長跑工作的取消旗標（key = "{連線 id}:{kind}"，如 "c1:scan" / "c1:csv"）。
    #[cfg(feature = "kafka")]
    pub kafka_jobs: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
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

/// 前端骨架屏完成首次繪製後呼叫：顯示主視窗。
/// 配合 tauri.conf.json 的 visible:false，消除 WebView2 初始化期間的白屏。
#[tauri::command]
pub fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// 設定介面語言：更新進程內語言（供後端錯誤訊息本地化），並寫回 `app_settings.json`
/// （GUI 與 dbk CLI 共用）。未知語言碼一律退回預設（zh-TW）。
#[tauri::command]
pub async fn set_lang(app: AppHandle, lang: String) -> AppResult<()> {
    let l = crate::i18n::Lang::from_code(&lang).unwrap_or_default();
    crate::i18n::set_lang(l);
    let mut s: store::AppSettings = store::read_json(&app, store::APP_SETTINGS_FILE).await?;
    s.lang = Some(l.as_code().to_string());
    store::write_json(&app, store::APP_SETTINGS_FILE, &s).await
}

/// 查詢防護設定（互動查詢 row cap / 逾時），全域生效。
/// 前端於啟動與設定變更時呼叫；持久化在前端 localStorage（非機密、UI 偏好層級）。
#[tauri::command]
pub fn set_query_guard(max_rows: usize, timeout_ms: u64) {
    crate::db::limits::set_row_cap(max_rows);
    crate::db::limits::set_timeout_ms(timeout_ms);
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
    #[cfg(feature = "kafka")]
    {
        if let Some(c) = state.kafka_tails.lock().remove(&id) {
            c.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        cancel_kafka_jobs(&state, &id);
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
    #[cfg(feature = "kafka")]
    {
        if let Some(c) = state.kafka_tails.lock().remove(&id) {
            c.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        cancel_kafka_jobs(&state, &id);
    }
    state.manager.disconnect(&id).await;
    Ok(())
}

/// 取消並移除某連線所有登記中的 Kafka 長跑工作（key 前綴 "{id}:"）。
#[cfg(feature = "kafka")]
fn cancel_kafka_jobs(state: &AppState, id: &str) {
    let prefix = format!("{id}:");
    let mut jobs = state.kafka_jobs.lock();
    let keys: Vec<String> = jobs
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for k in keys {
        if let Some(c) = jobs.remove(&k) {
            c.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
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
        .map_err(|e| AppError::Storage(tf!("salt 產生失敗：{e}", e = e)))?;
    let phc = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::Storage(tf!("密碼雜湊失敗：{e}", e = e)))?;
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
        return Err(AppError::Storage(t!("密碼不可為空").into()));
    }
    let mut s: store::AppSettings = store::read_json(&app, store::APP_SETTINGS_FILE).await?;
    if let Some(existing) = &s.startup_password_hash {
        let ok = current
            .as_deref()
            .map(|c| verify_startup_hash(c, existing))
            .unwrap_or(false);
        if !ok {
            return Err(AppError::Storage(t!("目前密碼不正確").into()));
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
            return Err(AppError::Storage(t!("目前密碼不正確").into()));
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
        return Err(AppError::Storage(t!("請提供 passphrase").into()));
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
        .map_err(|e| AppError::Storage(tf!("序列化失敗：{e}", e = e)))?;
    let blob = crate::conn_crypto::encrypt(&plain, &passphrase)?;
    tokio::fs::write(&path, blob)
        .await
        .map_err(|e| AppError::Storage(tf!("寫入失敗：{e}", e = e)))?;
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
        .map_err(|e| AppError::Storage(tf!("讀取失敗：{e}", e = e)))?;
    let plain = crate::conn_crypto::decrypt(&blob, &passphrase)?;
    let exported: Vec<ExportedConn> = serde_json::from_slice(&plain)
        .map_err(|_| AppError::Storage(t!("解密成功但內容格式不符（檔案可能來自不同版本）").into()))?;
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

/// 一次載回整個資料庫所有表的欄名（供 SQL 自動完成批次補全；qland 走單一分頁 information_schema 查詢）。
#[tauri::command]
pub async fn schema_columns(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<TableColumns>> {
    state.manager.schema_columns(&id, &database).await
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
    max_rows: Option<usize>,
) -> AppResult<QueryResult> {
    // max_rows：單次覆寫（「載入更多」以 2× cap 重跑）；未提供則走全域 row cap。
    match max_rows {
        Some(cap) => state.manager.query_capped(&id, &sql, cap).await,
        None => state.manager.query(&id, &sql).await,
    }
}

/// 多結果集版 run_query：批次 / 預存程序的每個結果集各一筆（至少 1 筆）。
/// 未覆寫 query_multi_capped 的驅動回單元素陣列，與 run_query 行為等價。
/// max_rows 語意同 run_query（每集各自截斷）。
#[tauri::command]
pub async fn run_query_multi(
    state: State<'_, AppState>,
    id: String,
    sql: String,
    max_rows: Option<usize>,
) -> AppResult<Vec<QueryResult>> {
    match max_rows {
        Some(cap) => state.manager.query_multi_capped(&id, &sql, cap).await,
        None => state.manager.query_multi(&id, &sql).await,
    }
}

/// 將文字內容寫入使用者（透過原生另存對話框）選定的路徑。供匯出查詢結果用。
#[tauri::command]
pub async fn save_text_file(path: String, content: String) -> AppResult<()> {
    std::fs::write(&path, content).map_err(|e| AppError::Query(tf!("寫入失敗：{e}", e = e)))
}

/// 讀取使用者（透過原生開啟對話框）選定之文字檔內容。供查詢編輯器開啟 .sql 檔用。
/// 上限 8 MiB，避免誤選巨大檔案塞爆編輯器 / 記憶體。
#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    let meta = std::fs::metadata(&path).map_err(|e| AppError::Query(tf!("讀取失敗：{e}", e = e)))?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err(AppError::Query(t!("檔案過大（上限 8 MiB）").into()));
    }
    std::fs::read_to_string(&path).map_err(|e| AppError::Query(tf!("讀取失敗：{e}", e = e)))
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

/// 以「重新執行查詢」匯出完整結果（不受互動 row cap 限制、rows 不經 IPC 往返）。
/// 供查詢結果已被截斷但要匯出全部的場景；上限沿用匯出管線的 1,000,000 列保護。
#[tauri::command]
pub async fn export_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
    options: crate::export::ExportOptions,
    out_path: String,
) -> AppResult<crate::export::ExportResult> {
    crate::export::export_query(&state.manager, &id, &sql, &options, &out_path).await
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

/// 一次匯出多個結果集（多語句批次的「全部匯出」）：xlsx 單檔多工作表、
/// markdown / json / sql 單檔分節、csv / tsv 編號多檔。資料同 export_rows 已備妥於前端。
#[tauri::command]
pub async fn export_rows_multi(
    sets: Vec<crate::export::ResultSetPayload>,
    options: crate::export::ExportOptions,
    out_path: String,
) -> AppResult<crate::export::ExportResult> {
    crate::export::export_rows_multi(sets, &options, &out_path).await
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
            return Err(AppError::Query(tf!(
                "檔案過大（約 {mb} MB），CSV 匯入上限 100 MB；請先分割檔案",
                mb = meta.len() / 1024 / 1024
            )));
        }
    }
    let content = tokio::fs::read_to_string(&path).await.map_err(|e| {
        // 非 UTF-8（常見於舊版 Excel / ANSI 匯出）給明確指引，而非難懂的原始錯誤。
        if e.kind() == std::io::ErrorKind::InvalidData {
            AppError::Query(
                t!("檔案非 UTF-8 編碼；請在試算表以「另存新檔 → CSV UTF-8」重新匯出後再試").to_string(),
            )
        } else {
            AppError::Query(tf!("讀取檔案失敗：{e}", e = e))
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
            return Err(AppError::Query(tf!(
                "檔案過大（約 {mb} MB），Excel 匯入上限 100 MB",
                mb = meta.len() / 1024 / 1024
            )));
        }
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Query(tf!("讀取檔案失敗：{e}", e = e)))?;
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
            .map_err(|e| AppError::Query(tf!("讀取檔案失敗：{e}", e = e)))?;
        crate::import::parse_xlsx(&bytes)?
    } else {
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| AppError::Query(tf!("讀取檔案失敗：{e}", e = e)))?;
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
                let _ = app2.emit(
                    "redis-pubsub-error",
                    tf!("{id2}: subscribe {c} 失敗：{e}", id2 = id2, c = c, e = e),
                );
            }
        }
        for p in &patterns {
            if let Err(e) = pubsub.psubscribe(p).await {
                let _ = app2.emit(
                    "redis-pubsub-error",
                    tf!("{id2}: psubscribe {p} 失敗：{e}", id2 = id2, p = p, e = e),
                );
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
        return Err(AppError::Query(t!("此筆為失敗紀錄，無法還原").into()));
    }
    let cfg = store::load_connection(&app, &entry.connection_id).await?;
    backup::restore(&cfg, &entry.database, &entry.path).await
}

#[tauri::command]
pub async fn clear_history(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let _g = state.history_lock.lock().await;
    store::write_json(&app, scheduler::HISTORY_FILE, &Vec::<BackupHistoryEntry>::new()).await
}

// ===================== Kafka（一等公民；kafka feature）=====================

/// 主題清單（含分區數 / 複本數 / 內部標記）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_topics(state: State<'_, AppState>, id: String) -> AppResult<Vec<KafkaTopic>> {
    state.manager.kafka_driver(&id)?.list_topics().await
}

/// 叢集資訊（brokers）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_cluster_info(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<KafkaClusterInfo> {
    state.manager.kafka_driver(&id)?.cluster_info().await
}

/// 某主題各分區資訊（leader / replicas / ISR / low / high）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_topic_partitions(
    state: State<'_, AppState>,
    id: String,
    topic: String,
) -> AppResult<Vec<KafkaPartitionInfo>> {
    state
        .manager
        .kafka_driver(&id)?
        .topic_partitions(&topic)
        .await
}

/// 一次性消費一頁訊息（訊息瀏覽器「查詢」用）。掃描模式下以 `kafka-scan-progress`
/// 回報進度，並登記取消旗標 `{id}:scan`（可由 kafka_job_cancel 中止）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_consume(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    topic: String,
    query: KafkaConsumeQuery,
) -> AppResult<KafkaConsumeResult> {
    use std::sync::atomic::AtomicBool;
    let driver = state.manager.kafka_driver(&id)?;

    // 非掃描模式：直接跑，不登記工作。
    if query.scan.is_none() {
        return driver.consume_page(&topic, &query, None, None).await;
    }

    // 掃描模式：登記取消旗標 + 進度 emit。
    let cancel = Arc::new(AtomicBool::new(false));
    let job_key = format!("{id}:scan");
    if let Some(old) = state.kafka_jobs.lock().insert(job_key.clone(), cancel.clone()) {
        old.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let app2 = app.clone();
    let conn_id = id.clone();
    let topic2 = topic.clone();
    let progress: crate::db::kafka::consume::ProgressFn = Box::new(move |scanned, matched| {
        let _ = app2.emit(
            "kafka-scan-progress",
            serde_json::json!({ "conn_id": conn_id, "topic": topic2, "scanned": scanned, "matched": matched }),
        );
    });
    let res = driver
        .consume_page(&topic, &query, Some(cancel), Some(progress))
        .await;
    state.kafka_jobs.lock().remove(&job_key);
    res
}

/// 取消 Kafka 長跑工作（kind 如 "scan" / "csv"）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_job_cancel(state: State<'_, AppState>, id: String, kind: String) -> AppResult<()> {
    if let Some(c) = state.kafka_jobs.lock().remove(&format!("{id}:{kind}")) {
        c.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// 開始 live-tail：背景任務串流新訊息，以 `kafka-message` 事件推給前端（每連線一個 tail，重呼叫即取代）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_tail_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    topic: String,
    partition: Option<i32>,
    start: KafkaStart,
    js_filter: Option<String>,
) -> AppResult<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let driver = state.manager.kafka_driver(&id)?;
    let consumer = driver.build_tail_consumer(&topic, partition, start).await?;
    // JS 篩選：開跑前先編譯驗證，避免壞運算式進迴圈才發現。
    let js_src = js_filter.filter(|s| !s.trim().is_empty());
    #[cfg(feature = "kafka-js")]
    if let Some(src) = &js_src {
        let src = src.clone();
        // 注意：JsFilter 為 !Send，不可作為 spawn_blocking 的回傳跨執行緒 —— 在 closure 內丟棄。
        tokio::task::spawn_blocking(move || {
            crate::db::kafka::jsfilter::JsFilter::compile(&src).map(|_| ())
        })
        .await
        .map_err(|e| AppError::Query(e.to_string()))?
        .map_err(|e| AppError::Query(crate::tf!("JS 篩選編譯失敗：{e}", e = e)))?;
    }
    #[cfg(not(feature = "kafka-js"))]
    if js_src.is_some() {
        return Err(AppError::Unsupported(
            crate::t!("此版本未啟用 JS 篩選（kafka-js feature）").into(),
        ));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    // 每連線一個 tail：先讓舊的停。
    if let Some(old) = state.kafka_tails.lock().insert(id.clone(), cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    let app2 = app.clone();
    let conn_id = id.clone();
    // 專屬 OS 執行緒跑阻塞 poll 迴圈；BaseConsumer drop 快速，不擋 tokio worker
    //（StreamConsumer 的 drop 在 assign-only 情境會無限阻塞，故不用）。
    std::thread::spawn(move || {
        // JsFilter 為 !Send，於本執行緒內編譯（上方已驗證可編譯）。
        #[cfg(feature = "kafka-js")]
        let mut js = js_src
            .as_deref()
            .and_then(|s| crate::db::kafka::jsfilter::JsFilter::compile(s).ok());
        #[cfg(feature = "kafka-js")]
        let mut js_err_sent = false;
        while !cancel.load(Ordering::Relaxed) {
            match consumer.poll(std::time::Duration::from_millis(250)) {
                Some(Ok(msg)) => {
                    let km = crate::db::kafka::message_to_dto_sync(&msg, &topic, &conn_id);
                    #[cfg(feature = "kafka-js")]
                    if let Some(f) = js.as_mut() {
                        match f.eval(&km) {
                            Ok(true) => {}
                            Ok(false) => continue,
                            Err(e) => {
                                if !js_err_sent {
                                    let _ = app2.emit("kafka-error", format!("{conn_id}: JS {e}"));
                                    js_err_sent = true;
                                }
                                continue;
                            }
                        }
                    }
                    let _ = app2.emit("kafka-message", km);
                }
                Some(Err(rdkafka::error::KafkaError::PartitionEOF(_))) => {}
                Some(Err(e)) => {
                    let _ = app2.emit("kafka-error", format!("{conn_id}: {e}"));
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                None => {}
            }
        }
        drop(consumer); // 迴圈結束即釋放（BaseConsumer close 快速返回）
    });
    Ok(())
}

/// 停止 live-tail（設取消旗標，poll 執行緒下一輪退出）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_tail_stop(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(c) = state.kafka_tails.lock().remove(&id) {
        c.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// CSV 批次發佈。登記取消旗標 "{id}:csv"，以 kafka-produce-progress 回報進度。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_produce_csv(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
    options: crate::db::kafka::dto::KafkaCsvProduceOptions,
) -> AppResult<KafkaBatchResult> {
    use std::sync::atomic::AtomicBool;
    let driver = state.manager.kafka_driver(&id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let job_key = format!("{id}:csv");
    if let Some(old) = state.kafka_jobs.lock().insert(job_key.clone(), cancel.clone()) {
        old.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let app2 = app.clone();
    let conn_id = id.clone();
    let res = driver
        .produce_csv(&path, &options, cancel, move |sent, failed, total| {
            let _ = app2.emit(
                "kafka-produce-progress",
                serde_json::json!({ "conn_id": conn_id, "sent": sent, "failed": failed, "total": total }),
            );
        })
        .await;
    state.kafka_jobs.lock().remove(&job_key);
    res
}

/// 批次發佈多則訊息（並行）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_produce_batch(
    state: State<'_, AppState>,
    id: String,
    reqs: Vec<KafkaProduceRequest>,
) -> AppResult<KafkaBatchResult> {
    state
        .manager
        .kafka_driver(&id)?
        .produce_batch(&reqs)
        .await
}

/// 發佈一則訊息。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_produce(
    state: State<'_, AppState>,
    id: String,
    req: KafkaProduceRequest,
) -> AppResult<KafkaProduceResult> {
    state.manager.kafka_driver(&id)?.produce(&req).await
}

/// 消費者群組清單。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_consumer_groups(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<KafkaConsumerGroup>> {
    state.manager.kafka_driver(&id)?.list_groups().await
}

/// 群組詳細（成員 + 每分區 Lag）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_group_detail(
    state: State<'_, AppState>,
    id: String,
    group: String,
) -> AppResult<KafkaGroupDetail> {
    state.manager.kafka_driver(&id)?.describe_group(&group).await
}

/// 預覽位移重設（不檢查群組狀態、不 commit）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_preview_reset(
    state: State<'_, AppState>,
    id: String,
    reset: KafkaOffsetReset,
) -> AppResult<Vec<KafkaOffsetPlanRow>> {
    state.manager.kafka_driver(&id)?.preview_reset(&reset).await
}

/// 重設群組位移（群組須 Empty）。回傳實際套用的計畫。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_reset_offsets(
    state: State<'_, AppState>,
    id: String,
    reset: KafkaOffsetReset,
) -> AppResult<Vec<KafkaOffsetPlanRow>> {
    state.manager.kafka_driver(&id)?.reset_offsets(&reset).await
}

/// 刪除消費者群組（須 Empty）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_delete_group(
    state: State<'_, AppState>,
    id: String,
    group: String,
) -> AppResult<()> {
    state.manager.kafka_driver(&id)?.delete_group(&group).await
}

/// 建立主題。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_create_topic(
    state: State<'_, AppState>,
    id: String,
    spec: KafkaCreateTopicSpec,
) -> AppResult<()> {
    state.manager.kafka_driver(&id)?.create_topic(&spec).await
}

/// 刪除主題。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_delete_topic(
    state: State<'_, AppState>,
    id: String,
    topic: String,
) -> AppResult<()> {
    state.manager.kafka_driver(&id)?.delete_topic(&topic).await
}

/// 讀取主題設定（describe configs）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_topic_config(
    state: State<'_, AppState>,
    id: String,
    topic: String,
) -> AppResult<Vec<KafkaConfigEntry>> {
    state.manager.kafka_driver(&id)?.topic_config(&topic).await
}

/// 讀取 broker 設定（describe configs）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_broker_config(
    state: State<'_, AppState>,
    id: String,
    broker_id: i32,
) -> AppResult<Vec<KafkaConfigEntry>> {
    state
        .manager
        .kafka_driver(&id)?
        .broker_config(broker_id)
        .await
}

/// 設定（value 有值）或還原預設（value = null）單一主題設定鍵。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_set_topic_config(
    state: State<'_, AppState>,
    id: String,
    topic: String,
    key: String,
    value: Option<String>,
) -> AppResult<()> {
    state
        .manager
        .kafka_driver(&id)?
        .set_topic_config(&topic, &key, value.as_deref())
        .await
}

/// 增加主題分區數（new_total 為新總數，只能增不能減）。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_add_partitions(
    state: State<'_, AppState>,
    id: String,
    topic: String,
    new_total: u32,
) -> AppResult<()> {
    state
        .manager
        .kafka_driver(&id)?
        .add_partitions(&topic, new_total as usize)
        .await
}

/// 刪除主題訊息（DeleteRecords）。partitions=null 全分區；before=null 清到 high watermark。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_delete_records(
    state: State<'_, AppState>,
    id: String,
    topic: String,
    partitions: Option<Vec<i32>>,
    before: Option<i64>,
) -> AppResult<Vec<KafkaDeleteRecordsResult>> {
    state
        .manager
        .kafka_driver(&id)?
        .delete_records(&topic, partitions.as_deref(), before)
        .await
}

/// Schema Registry：subjects 清單。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_schema_subjects(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<KafkaSchemaSubject>> {
    state.manager.kafka_driver(&id)?.schema_subjects().await
}

/// Schema Registry：取某 subject 指定版本（version <= 0 為 latest）的 schema。
#[cfg(feature = "kafka")]
#[tauri::command]
pub async fn kafka_schema(
    state: State<'_, AppState>,
    id: String,
    subject: String,
    version: i32,
) -> AppResult<KafkaSchema> {
    state
        .manager
        .kafka_driver(&id)?
        .get_schema(&subject, version)
        .await
}
