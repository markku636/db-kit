mod backup;
mod commands;
mod db;
mod error;
mod export;
mod import;
mod manager;
mod scheduler;
mod ssh;
mod store;

#[cfg(test)]
mod it_tests;

use std::sync::Arc;

use commands::AppState;
use manager::ConnectionManager;
use parking_lot::Mutex;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            manager: ConnectionManager::new(),
            schedules: Arc::new(Mutex::new(Vec::new())),
            history_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
        .setup(|app| {
            let handle = app.handle().clone();
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::list_tables,
            commands::table_columns,
            commands::table_data,
            commands::run_query,
            commands::save_text_file,
            commands::update_cell,
            commands::insert_row,
            commands::delete_row,
            commands::pool_status,
            commands::ping_connection,
            commands::key_detail,
            commands::key_edit,
            commands::export_table,
            commands::import_csv,
            commands::schema_dump,
            commands::explain_query,
            commands::column_stats,
            commands::create_collection,
            commands::create_database,
            commands::alter_table,
            commands::er_model,
            commands::table_ddl,
            commands::table_indexes,
            commands::drop_index,
            commands::create_index,
            commands::server_info,
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
