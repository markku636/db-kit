// slim CLI build（無 gui feature）只用到核心層的唯讀路徑，寫入 / DDL / restore 等方法在此 profile
// 必然 unused；GUI build 仍會正常檢查 dead_code，故僅在非 gui 時靜音。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

// i18n 必須最先宣告：`#[macro_use]` 讓 `t!` / `tf!` 在其後所有模組的文字域內可用。
#[macro_use]
mod i18n;
mod locales;

// 核心層（GUI 與 CLI 共用，不依賴 Tauri）。
mod backup;
mod conn_crypto;
mod db;
mod error;
mod export;
mod import;
mod manager;
mod ssh;
mod store;
mod transfer;

// CLI（唯讀查詢 + 匯出）。一直編譯；不依賴 Tauri，直接呼叫 manager / store / export / backup。
pub mod cli;

// 僅 GUI（Tauri）需要的模組。slim build（--no-default-features，無 gui feature）整段排除，
// 連同 tauri / tauri-plugin-dialog 相依一起不被連入。
#[cfg(feature = "gui")]
mod agent;
#[cfg(feature = "gui")]
mod commands;
#[cfg(feature = "gui")]
mod scheduler;

#[cfg(test)]
mod it_tests;

// Kafka 後端整合測試（對 live broker；需 kafka feature + DBKIT_KAFKA_IT=1）。
#[cfg(all(test, feature = "kafka"))]
mod kafka_it;

#[cfg(feature = "gui")]
use std::sync::Arc;

#[cfg(feature = "gui")]
use commands::AppState;
#[cfg(feature = "gui")]
use manager::ConnectionManager;
#[cfg(feature = "gui")]
use parking_lot::Mutex;
#[cfg(feature = "gui")]
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg(feature = "gui")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            manager: ConnectionManager::new(),
            schedules: Arc::new(Mutex::new(Vec::new())),
            history_lock: Arc::new(tokio::sync::Mutex::new(())),
            pubsub: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_jobs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            #[cfg(feature = "kafka")]
            kafka_tails: Arc::new(Mutex::new(std::collections::HashMap::new())),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // 載入語言偏好（與 dbk CLI 共用 app_settings.json）。啟動時套用，供後端錯誤訊息本地化。
            tauri::async_runtime::block_on(async {
                let s: store::AppSettings = store::read_json(&handle, store::APP_SETTINGS_FILE)
                    .await
                    .unwrap_or_default();
                if let Some(l) = s.lang.as_deref().and_then(crate::i18n::Lang::from_code) {
                    crate::i18n::set_lang(l);
                }
            });
            // 載入持久化排程並重算 next_run（啟動只排未來的下一次，不補跑漏掉的）。
            tauri::async_runtime::block_on(async {
                let loaded: Vec<scheduler::BackupSchedule> =
                    store::read_json(&handle, scheduler::SCHEDULES_FILE)
                        .await
                        .unwrap_or_default();
                let state = handle.state::<AppState>();
                let now = chrono::Local::now();
                let mut g = state.schedules.lock();
                *g = loaded;
                for s in g.iter_mut() {
                    s.next_run = scheduler::compute_next_run(&s.cadence, now);
                }
            });
            // 背景排程迴圈。
            tauri::async_runtime::spawn(scheduler::run_loop(handle));
            // 保險絲：視窗以 visible:false 啟動，正常由前端骨架屏呼叫 show_main_window 顯示；
            // 若前端 4 秒內沒呼叫（bundle 載入失敗 / JS 錯誤），強制顯示視窗以免看起來像沒啟動。
            if let Some(w) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::show_main_window,
            commands::set_lang,
            commands::set_query_guard,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::clear_cache,
            commands::has_startup_password,
            commands::verify_startup_password,
            commands::set_startup_password,
            commands::clear_startup_password,
            commands::export_connections_encrypted,
            commands::import_connections_encrypted,
            commands::list_databases,
            commands::list_tables,
            commands::table_columns,
            commands::schema_columns,
            commands::table_data,
            commands::run_query,
            commands::run_query_multi,
            commands::save_text_file,
            commands::read_text_file,
            commands::update_cell,
            commands::insert_row,
            commands::delete_row,
            commands::pool_status,
            commands::ping_connection,
            commands::key_detail,
            commands::key_edit,
            commands::export_table,
            commands::export_rows,
            commands::export_rows_multi,
            commands::export_query,
            commands::import_csv,
            commands::import_excel,
            commands::import_preview,
            commands::transfer_table,
            commands::schema_dump,
            commands::explain_query,
            commands::column_stats,
            commands::table_info,
            commands::list_foreign_keys,
            commands::create_collection,
            commands::create_database,
            commands::drop_collection,
            commands::drop_database,
            commands::list_routines,
            commands::routine_definition,
            commands::search_objects,
            commands::exec_ddl,
            commands::validate_ddl,
            commands::alter_table,
            commands::er_model,
            commands::table_ddl,
            commands::table_indexes,
            commands::drop_index,
            commands::create_index,
            commands::server_info,
            commands::redis_keys,
            commands::document_get,
            commands::document_replace,
            commands::redis_key_page,
            commands::redis_slowlog,
            commands::redis_clients,
            commands::redis_client_kill,
            commands::redis_big_keys,
            commands::redis_publish,
            commands::redis_subscribe,
            commands::redis_unsubscribe,
            commands::mongo_index_stats,
            commands::mongo_create_index,
            commands::mongo_get_validation,
            commands::mongo_set_validation,
            commands::mongo_db_stats,
            commands::mongo_current_ops,
            commands::mongo_kill_op,
            commands::mongo_profile_get,
            commands::mongo_profile_set,
            commands::mongo_slow_queries,
            #[cfg(feature = "kafka")]
            commands::kafka_topics,
            #[cfg(feature = "kafka")]
            commands::kafka_cluster_info,
            #[cfg(feature = "kafka")]
            commands::kafka_topic_partitions,
            #[cfg(feature = "kafka")]
            commands::kafka_consume,
            #[cfg(feature = "kafka")]
            commands::kafka_tail_start,
            #[cfg(feature = "kafka")]
            commands::kafka_tail_stop,
            #[cfg(feature = "kafka")]
            commands::kafka_produce,
            #[cfg(feature = "kafka")]
            commands::kafka_consumer_groups,
            #[cfg(feature = "kafka")]
            commands::kafka_group_detail,
            #[cfg(feature = "kafka")]
            commands::kafka_preview_reset,
            #[cfg(feature = "kafka")]
            commands::kafka_reset_offsets,
            #[cfg(feature = "kafka")]
            commands::kafka_create_topic,
            #[cfg(feature = "kafka")]
            commands::kafka_delete_topic,
            #[cfg(feature = "kafka")]
            commands::kafka_topic_config,
            #[cfg(feature = "kafka")]
            commands::kafka_broker_config,
            #[cfg(feature = "kafka")]
            commands::kafka_set_topic_config,
            #[cfg(feature = "kafka")]
            commands::kafka_add_partitions,
            #[cfg(feature = "kafka")]
            commands::kafka_delete_records,
            #[cfg(feature = "kafka")]
            commands::kafka_schema_subjects,
            #[cfg(feature = "kafka")]
            commands::kafka_schema,
            commands::backup_detect_cli,
            commands::backup_run,
            commands::backup_restore,
            commands::list_saved_connections,
            commands::save_connection,
            commands::remove_saved_connection,
            commands::list_schedules,
            commands::save_schedule,
            commands::remove_schedule,
            commands::toggle_schedule,
            commands::run_schedule_now,
            commands::list_backup_history,
            commands::restore_from_history,
            commands::clear_history,
            agent::claude_detect,
            agent::claude_send,
            agent::claude_cancel,
            agent::open_agent_workspace,
            agent::open_external,
        ])
        .on_window_event(|window, event| {
            // 視窗關閉時，優雅釋放所有連線池（呼應規劃 3.5）。
            if let WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                // close_all 是 async；用 block 確保釋放完成才讓視窗關閉。
                tauri::async_runtime::block_on(state.manager.close_all());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 程序整體退出時再保險 drain 一次。
            if let RunEvent::Exit = event {
                let state = app_handle.state::<AppState>();
                tauri::async_runtime::block_on(state.manager.close_all());
            }
        });
}
