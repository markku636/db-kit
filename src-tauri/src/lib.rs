// slim CLI build（無 gui feature）只用到核心層的唯讀路徑，寫入 / DDL / restore 等方法在此 profile
// 必然 unused；GUI build 仍會正常檢查 dead_code，故僅在非 gui 時靜音。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

// i18n 必須最先宣告：`#[macro_use]` 讓 `t!` / `tf!` 在其後所有模組的文字域內可用。
#[macro_use]
mod i18n;
mod locales;

// 核心層（GUI 與 CLI 共用，不依賴 Tauri）。
// AI 資源庫（人設 / 技能 / 提示範本 / 輸出契約的靜態檔）：GUI 與 dbk 共用，不依賴 Tauri 與 reqwest。
mod ai_library;
mod backup;
// 結構 / 資料比對核心：不依賴 Tauri（進度以 callback 注入），GUI 與 dbk CLI 共用。
mod compare;
mod conn_crypto;
mod conn_export;
mod db;
// AI 助手的唯讀資料庫工具：GUI 的 HTTP 工具迴圈與 `dbk mcp` 共用，不依賴 Tauri。
mod dbtools;
mod error;
mod export;
mod import;
mod manager;
// 遠端桌面（RDP / VNC）：不依賴 Tauri；GUI 的 command 在 commands/rd.rs。
mod rd;
// 審查並執行：逐句前後像 + 回滾腳本 + 輸出目錄。不依賴 Tauri，GUI 與 `dbk run` 共用。
mod review_run;
mod schema_cache;
mod ssh;
mod store;
// 壓力測試核心：不依賴 Tauri（進度以 callback 注入），slim CLI build 也編得進來。
mod stress;
mod transfer;

// CLI（唯讀查詢 + 匯出）。一直編譯；不依賴 Tauri，直接呼叫 manager / store / export / backup。
pub mod cli;

// 僅 GUI（Tauri）需要的模組。slim build（--no-default-features，無 gui feature）整段排除，
// 連同 tauri / tauri-plugin-dialog 相依一起不被連入。
#[cfg(feature = "gui")]
mod agent;
// 幫使用者安裝 / 登入 CLI 供應商（開終端機跑官方指令）。只有 agent 會用，但只依賴 std，
// 所以測試時也編進 slim build —— 不必開 GUI feature 就能在本機跑它的測試。
#[cfg(any(feature = "gui", test))]
mod agent_setup;
// HTTP LLM 供應商（Anthropic-compatible / OpenAI-compatible）。相依 reqwest，
// 與 agent 一起掛在 gui feature 後：slim CLI（dbk）不含 AI，也就不需要把 reqwest 連進去。
#[cfg(feature = "gui")]
mod llm;
// 生物辨識解鎖（Windows Hello / Touch ID）。本身不相依 Tauri，但平台綁定（windows / objc2）
// 掛在 gui feature 後，slim CLI 不編；且 CLI 也沒有可以彈提示的視窗。
#[cfg(feature = "gui")]
mod biometric;
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
    // RDP 的 TLS 用 `ClientConfig::builder()`（取程序預設 provider）：明確裝 ring，別讓它靠依賴樹剛好只有 ring。
    #[cfg(feature = "rdp")]
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            manager: Arc::new(ConnectionManager::new()),
            schedules: Arc::new(Mutex::new(Vec::new())),
            history_lock: Arc::new(tokio::sync::Mutex::new(())),
            pubsub: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_jobs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            llm_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            ssh: Arc::new(ssh::SshRuntime::new()),
            rd: Arc::new(rd::RdRuntime::new()),
            #[cfg(feature = "kafka")]
            kafka_tails: Arc::new(Mutex::new(std::collections::HashMap::new())),
            #[cfg(feature = "kafka")]
            kafka_jobs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            #[cfg(feature = "kafka")]
            kafka_samplers: Arc::new(Mutex::new(std::collections::HashMap::new())),
            #[cfg(feature = "kafka")]
            kafka_metrics: Arc::new(Mutex::new(std::collections::HashMap::new())),
            #[cfg(feature = "kafka")]
            kafka_alert_rules: Arc::new(Mutex::new(Vec::new())),
            #[cfg(feature = "docker")]
            docker_streams: Arc::new(db::docker::stream::DockerStreams::new()),
            #[cfg(feature = "docker")]
            k8s_streams: Arc::new(db::k8s::stream::K8sStreams::new()),
            #[cfg(feature = "docker")]
            k8s_forwards: Arc::new(db::k8s::forward::K8sForwards::new()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // SSH 金鑰庫：主機以 `keystore:<id>` 參照金鑰，DB tunnel 等沒有 AppHandle 的地方也要解析得到。
            if let Ok(dir) = store::app_config_dir(&handle) {
                crate::ssh::keys::init_store_root(&dir);
            }
            // 載入語言偏好（與 dbk CLI 共用 app_settings.json）。啟動時套用，供後端錯誤訊息本地化。
            tauri::async_runtime::block_on(async {
                let s: store::AppSettings = store::read_json(&handle, store::APP_SETTINGS_FILE)
                    .await
                    .unwrap_or_default();
                if let Some(l) = s.lang.as_deref().and_then(crate::i18n::Lang::from_code) {
                    crate::i18n::set_lang(l);
                }
            });
            // 清掉過期的 AI 對話歷史（30 天 / 上限 50 段）。背景跑：這只是清垃圾，
            // 不該讓視窗晚一步出現；失敗也只是多留幾個檔案，不值得中斷啟動。
            {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(dir) = store::app_config_dir(&h) {
                        let now = chrono::Local::now().timestamp_millis();
                        let n = llm::sessions::prune_in(
                            &dir,
                            now,
                            llm::sessions::MAX_AGE_DAYS,
                            llm::sessions::MAX_SESSIONS,
                        )
                        .await;
                        if n > 0 {
                            eprintln!("[agent] 已清理 {n} 段過期的對話歷史");
                        }
                    }
                });
            }
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
            // 載入持久化的 Kafka 告警規則到執行時副本。
            #[cfg(feature = "kafka")]
            tauri::async_runtime::block_on(async {
                let loaded: Vec<crate::db::kafka::dto::KafkaAlertRule> =
                    store::read_json(&handle, commands::KAFKA_ALERTS_FILE)
                        .await
                        .unwrap_or_default();
                let state = handle.state::<AppState>();
                *state.kafka_alert_rules.lock() = loaded;
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
            commands::parse_connection_url,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::clear_cache,
            commands::external_session_alive,
            commands::app_lock_status,
            commands::verify_startup_password,
            commands::set_startup_password,
            commands::clear_startup_password,
            commands::biometric_status,
            commands::biometric_verify,
            commands::set_biometric_unlock,
            commands::set_auto_lock_minutes,
            commands::export_connections_encrypted,
            commands::import_connections_encrypted,
            commands::has_stored_password,
            commands::list_databases,
            commands::list_tables,
            commands::table_columns,
            commands::schema_columns,
            commands::get_schema_cache,
            commands::refresh_schema_cache,
            commands::clear_schema_cache,
            commands::schema_cache_stats,
            commands::table_data,
            commands::run_query,
            commands::run_query_multi,
            commands::cancel_query,
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
            commands::capture_schema,
            commands::diff_schema,
            commands::generate_schema_sync,
            commands::save_schema_snapshot,
            commands::load_schema_snapshot,
            commands::compare_data_table,
            commands::compare_data_database,
            commands::compare_data_cancel,
            commands::review_run_prepare,
            commands::ai_library::ai_library_load,
            commands::ai_library::ai_library_save,
            commands::ai_library::ai_library_copy,
            commands::ai_library::ai_library_delete,
            commands::ai_library::ai_library_settings_set,
            commands::ai_library::ai_library_reveal,
            commands::ai_library::ai_library_sync_plan,
            commands::ai_library::ai_library_sync_apply,
            commands::review_run_start,
            commands::review_run_cancel,
            commands::review_run_reveal,
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
            commands::redis_delete_keys,
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
            commands::kafka_job_cancel,
            #[cfg(feature = "kafka")]
            commands::kafka_tail_start,
            #[cfg(feature = "kafka")]
            commands::kafka_tail_stop,
            #[cfg(feature = "kafka")]
            commands::kafka_produce,
            #[cfg(feature = "kafka")]
            commands::kafka_produce_batch,
            #[cfg(feature = "kafka")]
            commands::kafka_produce_csv,
            #[cfg(feature = "kafka")]
            commands::kafka_consumer_groups,
            #[cfg(feature = "kafka")]
            commands::kafka_group_detail,
            #[cfg(feature = "kafka")]
            commands::kafka_delete_group,
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
            commands::kafka_health_scan,
            #[cfg(feature = "kafka")]
            commands::kafka_monitor_start,
            #[cfg(feature = "kafka")]
            commands::kafka_monitor_stop,
            #[cfg(feature = "kafka")]
            commands::kafka_monitor_status,
            #[cfg(feature = "kafka")]
            commands::kafka_metrics_history,
            #[cfg(feature = "kafka")]
            commands::kafka_alert_rules_list,
            #[cfg(feature = "kafka")]
            commands::kafka_alert_rule_save,
            #[cfg(feature = "kafka")]
            commands::kafka_alert_rule_remove,
            #[cfg(feature = "kafka")]
            commands::kafka_alert_history,
            #[cfg(feature = "kafka")]
            commands::kafka_alert_history_clear,
            #[cfg(feature = "kafka")]
            commands::kafka_alert_test,
            #[cfg(feature = "kafka")]
            commands::kafka_schema_subjects,
            #[cfg(feature = "kafka")]
            commands::kafka_schema,
            #[cfg(feature = "kafka")]
            commands::kafka_schema_register,
            #[cfg(feature = "kafka")]
            commands::kafka_schema_compat_check,
            #[cfg(feature = "kafka")]
            commands::kafka_schema_compat_get,
            #[cfg(feature = "kafka")]
            commands::kafka_schema_compat_set,
            #[cfg(feature = "kafka")]
            commands::kafka_schema_delete_subject,
            #[cfg(feature = "kafka")]
            commands::kafka_schema_delete_version,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_list,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_config,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_pause,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_resume,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_restart,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_restart_task,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_delete,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_put_config,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_plugins,
            #[cfg(feature = "kafka")]
            commands::kafka_connect_validate,
            #[cfg(feature = "kafka")]
            commands::kafka_acls_list,
            #[cfg(feature = "kafka")]
            commands::kafka_acls_create,
            #[cfg(feature = "kafka")]
            commands::kafka_acls_delete,
            #[cfg(feature = "elastic")]
            commands::es_cluster_health,
            #[cfg(feature = "elastic")]
            commands::es_indices,
            #[cfg(feature = "elastic")]
            commands::es_nodes,
            #[cfg(feature = "elastic")]
            commands::es_mapping,
            #[cfg(feature = "elastic")]
            commands::es_delete_index,
            #[cfg(feature = "elastic")]
            commands::es_data_view_id,
            #[cfg(feature = "rabbitmq")]
            commands::rabbitmq_overview,
            #[cfg(feature = "rabbitmq")]
            commands::rabbitmq_queues,
            #[cfg(feature = "rabbitmq")]
            commands::rabbitmq_exchanges,
            #[cfg(feature = "rabbitmq")]
            commands::rabbitmq_queue_detail,
            #[cfg(feature = "rabbitmq")]
            commands::rabbitmq_peek,
            #[cfg(feature = "rabbitmq")]
            commands::rabbitmq_publish,
            #[cfg(feature = "rabbitmq")]
            commands::rabbitmq_purge,
            #[cfg(feature = "rabbitmq")]
            commands::rabbitmq_delete_queue,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_kubeconfig_contexts,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_default_kubeconfig,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_overview,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_namespaces,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_discovery,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_events,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_pod_metrics,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_node_metrics,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_table,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_list,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_get,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_get_yaml,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_replace_yaml,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_apply_yaml,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_delete,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_scale,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_restart,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_cronjob_suspend,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_cronjob_trigger,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_node_cordon,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_secret_data,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_pod_env,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_resolve_target,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_logs_open,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_exec_open,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_exec_write,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_exec_resize,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_stream_close,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_forward_open,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_forward_list,
            #[cfg(feature = "docker")]
            commands::k8s::k8s_forward_close,
            #[cfg(feature = "docker")]
            commands::docker::docker_overview,
            #[cfg(feature = "docker")]
            commands::docker::docker_disk_usage,
            #[cfg(feature = "docker")]
            commands::docker::docker_prune,
            #[cfg(feature = "docker")]
            commands::docker::docker_containers,
            #[cfg(feature = "docker")]
            commands::docker::docker_container_inspect,
            #[cfg(feature = "docker")]
            commands::docker::docker_container_action,
            #[cfg(feature = "docker")]
            commands::docker::docker_container_remove,
            #[cfg(feature = "docker")]
            commands::docker::docker_container_rename,
            #[cfg(feature = "docker")]
            commands::docker::docker_container_stats,
            #[cfg(feature = "docker")]
            commands::docker::docker_container_top,
            #[cfg(feature = "docker")]
            commands::docker::docker_logs_open,
            #[cfg(feature = "docker")]
            commands::docker::docker_exec_open,
            #[cfg(feature = "docker")]
            commands::docker::docker_exec_write,
            #[cfg(feature = "docker")]
            commands::docker::docker_exec_resize,
            #[cfg(feature = "docker")]
            commands::docker::docker_stream_close,
            #[cfg(feature = "docker")]
            commands::docker::docker_images,
            #[cfg(feature = "docker")]
            commands::docker::docker_image_inspect,
            #[cfg(feature = "docker")]
            commands::docker::docker_image_remove,
            #[cfg(feature = "docker")]
            commands::docker::docker_image_tag,
            #[cfg(feature = "docker")]
            commands::docker::docker_image_pull,
            #[cfg(feature = "docker")]
            commands::docker::docker_volumes,
            #[cfg(feature = "docker")]
            commands::docker::docker_volume_remove,
            #[cfg(feature = "docker")]
            commands::docker::docker_networks,
            #[cfg(feature = "docker")]
            commands::docker::docker_network_inspect,
            #[cfg(feature = "docker")]
            commands::docker::docker_network_remove,
            #[cfg(feature = "docker")]
            commands::docker::registry_info,
            #[cfg(feature = "docker")]
            commands::docker::registry_manifest,
            #[cfg(feature = "docker")]
            commands::docker::registry_delete,
            #[cfg(feature = "docker")]
            commands::docker::harbor_overview,
            #[cfg(feature = "docker")]
            commands::docker::harbor_project,
            #[cfg(feature = "docker")]
            commands::docker::harbor_repositories,
            #[cfg(feature = "docker")]
            commands::docker::harbor_artifacts,
            #[cfg(feature = "docker")]
            commands::docker::harbor_scan,
            #[cfg(feature = "docker")]
            commands::docker::harbor_vulnerabilities,
            #[cfg(feature = "docker")]
            commands::docker::harbor_delete_artifact,
            #[cfg(feature = "docker")]
            commands::docker::harbor_delete_tag,
            #[cfg(feature = "docker")]
            commands::docker::harbor_delete_repository,
            commands::stress_run,
            commands::stress_cancel,
            commands::backup_detect_cli,
            commands::backup_run,
            commands::backup_restore,
            commands::list_saved_connections,
            commands::list_connection_groups,
            commands::save_connection_layout,
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
            commands::ssh::ssh_sessions_list,
            commands::ssh::ssh_session_save,
            commands::ssh::ssh_session_remove,
            commands::ssh::ssh_sessions_layout_save,
            commands::ssh::ssh_has_stored_password,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_test,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_hostkey_answer,
            commands::ssh::ssh_auth_answer,
            commands::ssh::ssh_term_open,
            commands::ssh::ssh_term_write,
            commands::ssh::ssh_term_send_line,
            commands::ssh::ssh_term_resize,
            commands::ssh::ssh_term_close,
            commands::ssh::ssh_sftp_open,
            commands::ssh::ssh_sftp_close,
            commands::ssh::ssh_sftp_list,
            commands::ssh::ssh_sftp_stat,
            commands::ssh::ssh_sftp_mkdir,
            commands::ssh::ssh_sftp_rename,
            commands::ssh::ssh_sftp_remove,
            commands::ssh::ssh_sftp_read_text,
            commands::ssh::ssh_sftp_write_text,
            commands::ssh::ssh_sftp_chmod,
            commands::ssh::ssh_sftp_download,
            commands::ssh::ssh_sftp_upload,
            commands::ssh::ssh_sftp_download_many,
            commands::ssh::ssh_sftp_upload_many,
            commands::ssh::ssh_sftp_local_conflicts,
            commands::ssh::ssh_session_log_write,
            commands::ssh::ssh_import_scan,
            commands::ssh::ssh_import_default_path,
            commands::ssh::ssh_key_inspect,
            commands::ssh::ssh_keys_list,
            commands::ssh::ssh_key_import,
            commands::ssh::ssh_key_generate,
            commands::ssh::ssh_key_rename,
            commands::ssh::ssh_key_remove,
            commands::ssh::ssh_key_public,
            commands::ssh::ssh_key_export,
            commands::ssh::ssh_key_attach_cert,
            commands::ssh::ssh_sftp_cancel,
            commands::ssh::ssh_sftp_window_open,
            commands::ssh::ssh_sftp_window_close,
            commands::rd::rd_sessions_list,
            commands::rd::rd_session_save,
            commands::rd::rd_session_remove,
            commands::rd::rd_sessions_layout_save,
            commands::rd::rd_has_stored_password,
            commands::rd::rd_read_rdp_file,
            commands::rd::rd_connect,
            commands::rd::rd_disconnect,
            commands::rd::rd_cert_answer,
            commands::rd::rd_auth_answer,
            commands::rd::rd_write,
            commands::rd::rd_input,
            commands::rd::rd_frame_ack,
            commands::rd::rd_resize,
            commands::rd::rd_refresh,
            commands::rd::rd_send_keys,
            commands::rd::rd_clipboard_set,
            commands::rd::rd_keyboard_grab,
            commands::rd::rd_clipboard_read,
            commands::rd::rd_clipboard_write,
            commands::rd::rd_set_fullscreen,
            agent::agent_detect,
            agent::agent_setup_terminal,
            agent::agent_send,
            agent::agent_cancel,
            agent::llm_key_set,
            agent::llm_key_status,
            agent::llm_list_models,
            agent::agent_workspace_files,
            agent::agent_workspace_read,
            agent::agent_session_delete,
            agent::agent_sessions_clear,
            agent::open_agent_workspace,
            agent::open_external,
        ])
        .on_window_event(|window, event| match event {
            // 主視窗關閉時，優雅釋放所有連線池（呼應規劃 3.5）。只看主視窗：SFTP 獨立視窗關掉不能把連線全收了。
            WindowEvent::CloseRequested { .. } if window.label() == "main" => {
                // SFTP 視窗用的是主視窗的 SSH 連線，主視窗一關就跟著關（全部視窗都關了 App 才會結束）。
                // 另開 task 做：在視窗事件回呼裡直接銷毀別的視窗有卡住事件迴圈的風險。
                let others: Vec<_> = window
                    .app_handle()
                    .webview_windows()
                    .into_iter()
                    .filter(|(label, _)| ssh::sftp_window::is_label(label))
                    .map(|(_, w)| w)
                    .collect();
                if !others.is_empty() {
                    tauri::async_runtime::spawn(async move {
                        for w in others {
                            let _ = w.destroy();
                        }
                    });
                }
                let state = window.state::<AppState>();
                // close_all 是 async；用 block 確保釋放完成才讓視窗關閉。SSH 終端 / SFTP 一併收掉
                // （abort 讀端、取消傳輸、送 disconnect），否則 shell 會在遠端多活到 TCP 逾時。
                tauri::async_runtime::block_on(async {
                    state.manager.close_all().await;
                    state.ssh.shutdown_all().await;
                    state.rd.shutdown_all().await;
                });
            }
            // SFTP 視窗不管是按標題列的 ×、面板上的關閉，還是分頁關閉時被主視窗收掉，都收掉它開的 sftp 通道。
            WindowEvent::Destroyed if ssh::sftp_window::is_label(window.label()) => {
                let rt = window.state::<AppState>().ssh.clone();
                let label = window.label().to_string();
                tauri::async_runtime::spawn(async move {
                    commands::ssh::close_sftps_owned_by(&rt, &label).await;
                });
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 程序整體退出時再保險 drain 一次。
            if let RunEvent::Exit = event {
                let state = app_handle.state::<AppState>();
                tauri::async_runtime::block_on(async {
                    state.manager.close_all().await;
                    state.ssh.shutdown_all().await;
                    state.rd.shutdown_all().await;
                });
            }
        });
}
