//! Kubernetes 的 Tauri command（薄包裝；邏輯在 `crate::db::k8s`）。
//!
//! 串流（log / exec）的輸出走 `ipc::Channel<InvokeResponseBody::Raw>`（前端拿到 `ArrayBuffer`，
//! 與 Docker / SSH 終端同一套），結束發 `k8s-stream-end` 事件（前端以 `stream_id` 過濾）。

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use super::AppState;
use crate::db::docker::stream::{StreamEvent, StreamSink};
use crate::db::k8s::api::K8sApi;
use crate::db::k8s::dto::*;
use crate::db::k8s::kubeconfig::{self, KubeconfigInfo};
use crate::error::AppResult;
use crate::ssh::terminal::decode_b64_input;

fn api(state: &AppState, id: &str) -> AppResult<Arc<K8sApi>> {
    state.manager.container_driver(id)?.k8s()
}

fn ns_opt(ns: &Option<String>) -> Option<&str> {
    ns.as_deref().filter(|s| !s.is_empty())
}

#[derive(Clone, Serialize)]
struct StreamEnd {
    stream_id: String,
    error: Option<String>,
    exit_code: Option<i64>,
}

fn sink(app: AppHandle, stream_id: String, on_output: Channel<InvokeResponseBody>) -> StreamSink {
    Arc::new(move |ev| match ev {
        StreamEvent::Data(bytes) => {
            let _ = on_output.send(InvokeResponseBody::Raw(bytes));
        }
        StreamEvent::End { error, exit_code } => {
            let _ = app.emit("k8s-stream-end", StreamEnd { stream_id: stream_id.clone(), error, exit_code });
        }
    })
}

// ---- kubeconfig（不需連線；連線對話框用）----

/// 讀 kubeconfig 列出 context。`path` 空白 = 預設位置（KUBECONFIG / ~/.kube/config）。
#[tauri::command]
pub async fn k8s_kubeconfig_contexts(path: Option<String>) -> AppResult<KubeconfigInfo> {
    let paths = kubeconfig::paths_from(path.as_deref().map(str::trim).filter(|s| !s.is_empty()));
    tokio::task::spawn_blocking(move || {
        let (kc, read) = kubeconfig::load(&paths)?;
        Ok(KubeconfigInfo {
            files: read.iter().map(|p| p.display().to_string()).collect(),
            current_context: kc.current_context.clone(),
            contexts: kc.context_infos(),
        })
    })
    .await
    .map_err(|e| crate::error::AppError::Query(e.to_string()))?
}

/// 預設 kubeconfig 路徑（對話框提示用）。
#[tauri::command]
pub fn k8s_default_kubeconfig() -> Vec<String> {
    kubeconfig::default_paths().iter().map(|p| p.display().to_string()).collect()
}

// ---- 叢集 ----

#[tauri::command]
pub async fn k8s_overview(state: State<'_, AppState>, id: String) -> AppResult<K8sOverview> {
    api(&state, &id)?.overview().await
}

#[tauri::command]
pub async fn k8s_namespaces(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    api(&state, &id)?.namespaces().await
}

#[tauri::command]
pub async fn k8s_discovery(state: State<'_, AppState>, id: String, refresh: bool) -> AppResult<Vec<ApiResource>> {
    Ok(api(&state, &id)?.discovery_opt(refresh).await?.as_ref().clone())
}

#[tauri::command]
pub async fn k8s_events(
    state: State<'_, AppState>,
    id: String,
    ns: Option<String>,
    kind: Option<String>,
    name: Option<String>,
    warnings_only: bool,
) -> AppResult<Vec<K8sEvent>> {
    let obj = match (&kind, &name) {
        (Some(k), Some(n)) if !k.is_empty() && !n.is_empty() => Some((k.as_str(), n.as_str())),
        _ => None,
    };
    api(&state, &id)?.events(ns_opt(&ns), obj, warnings_only).await
}

#[tauri::command]
pub async fn k8s_pod_metrics(state: State<'_, AppState>, id: String, ns: Option<String>, name: Option<String>) -> AppResult<Option<Vec<K8sPodMetrics>>> {
    api(&state, &id)?.pod_metrics(ns_opt(&ns), name.as_deref().filter(|s| !s.is_empty())).await
}

#[tauri::command]
pub async fn k8s_node_metrics(state: State<'_, AppState>, id: String) -> AppResult<Option<Vec<K8sNodeMetrics>>> {
    api(&state, &id)?.node_metrics().await
}

// ---- 資源 ----

#[tauri::command]
pub async fn k8s_table(state: State<'_, AppState>, id: String, res: ResRef, ns: Option<String>, selector: Option<String>) -> AppResult<K8sTable> {
    api(&state, &id)?.table(&res, ns_opt(&ns), selector.as_deref()).await
}

/// 原始物件清單（workload 底下的 Pod、Service 的後端…）。
#[tauri::command]
pub async fn k8s_list(
    state: State<'_, AppState>,
    id: String,
    res: ResRef,
    ns: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
) -> AppResult<Vec<Value>> {
    let mut q: Vec<(&str, String)> = Vec::new();
    if let Some(s) = label_selector.filter(|s| !s.is_empty()) {
        q.push(("labelSelector", s));
    }
    if let Some(s) = field_selector.filter(|s| !s.is_empty()) {
        q.push(("fieldSelector", s));
    }
    api(&state, &id)?.list(&res, ns_opt(&ns), false, &q).await
}

#[tauri::command]
pub async fn k8s_get(state: State<'_, AppState>, id: String, res: ResRef, ns: Option<String>, name: String) -> AppResult<Value> {
    api(&state, &id)?.get(&res, ns_opt(&ns), &name).await
}

#[tauri::command]
pub async fn k8s_get_yaml(state: State<'_, AppState>, id: String, res: ResRef, ns: Option<String>, name: String) -> AppResult<String> {
    api(&state, &id)?.get_yaml(&res, ns_opt(&ns), &name).await
}

#[tauri::command]
pub async fn k8s_replace_yaml(
    state: State<'_, AppState>,
    id: String,
    res: ResRef,
    ns: Option<String>,
    name: String,
    yaml: String,
    dry_run: bool,
) -> AppResult<Value> {
    api(&state, &id)?.replace_yaml(&res, ns_opt(&ns), &name, &yaml, dry_run).await
}

#[tauri::command]
pub async fn k8s_apply_yaml(
    state: State<'_, AppState>,
    id: String,
    yaml: String,
    ns: Option<String>,
    dry_run: bool,
    force: bool,
) -> AppResult<Vec<K8sApplyResult>> {
    api(&state, &id)?.apply_yaml(&yaml, ns_opt(&ns), dry_run, force).await
}

#[tauri::command]
pub async fn k8s_delete(state: State<'_, AppState>, id: String, res: ResRef, ns: Option<String>, name: String, force: bool) -> AppResult<()> {
    api(&state, &id)?.delete(&res, ns_opt(&ns), &name, force).await
}

#[tauri::command]
pub async fn k8s_scale(state: State<'_, AppState>, id: String, res: ResRef, ns: String, name: String, replicas: i64) -> AppResult<()> {
    api(&state, &id)?.scale(&res, &ns, &name, replicas).await
}

#[tauri::command]
pub async fn k8s_restart(state: State<'_, AppState>, id: String, res: ResRef, ns: String, name: String) -> AppResult<()> {
    api(&state, &id)?.restart(&res, &ns, &name).await
}

#[tauri::command]
pub async fn k8s_cronjob_suspend(state: State<'_, AppState>, id: String, ns: String, name: String, suspend: bool) -> AppResult<()> {
    api(&state, &id)?.set_suspend(&ns, &name, suspend).await
}

#[tauri::command]
pub async fn k8s_cronjob_trigger(state: State<'_, AppState>, id: String, ns: String, name: String) -> AppResult<String> {
    api(&state, &id)?.trigger_cronjob(&ns, &name).await
}

#[tauri::command]
pub async fn k8s_node_cordon(state: State<'_, AppState>, id: String, name: String, cordon: bool) -> AppResult<()> {
    api(&state, &id)?.set_unschedulable(&name, cordon).await
}

#[tauri::command]
pub async fn k8s_secret_data(state: State<'_, AppState>, id: String, ns: String, name: String) -> AppResult<BTreeMap<String, String>> {
    api(&state, &id)?.secret_data(&ns, &name).await
}

#[tauri::command]
pub async fn k8s_pod_env(state: State<'_, AppState>, id: String, ns: String, pod: String) -> AppResult<Vec<K8sEnvVar>> {
    api(&state, &id)?.pod_env(&ns, &pod).await
}

/// 轉發目標實際落在哪個 Pod / 埠（建立資料庫連線前預覽用）。
#[tauri::command]
pub async fn k8s_resolve_target(state: State<'_, AppState>, id: String, ns: String, target: String, port: u16) -> AppResult<(String, u16)> {
    api(&state, &id)?.resolve_forward(&ns, &target, port).await
}

// ---- 串流 ----

#[tauri::command]
pub async fn k8s_logs_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    ns: String,
    pod: String,
    opts: LogOptions,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<String> {
    let api = api(&state, &id)?;
    let stream_id = uuid::Uuid::new_v4().to_string();
    let s = sink(app, stream_id.clone(), on_output);
    state.k8s_streams.open_logs(stream_id.clone(), &id, api, &ns, &pod, opts, s).await?;
    Ok(stream_id)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn k8s_exec_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    ns: String,
    pod: String,
    container: String,
    cmd: Vec<String>,
    cols: u32,
    rows: u32,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<String> {
    let api = api(&state, &id)?;
    let stream_id = uuid::Uuid::new_v4().to_string();
    let s = sink(app, stream_id.clone(), on_output);
    state.k8s_streams.open_exec(stream_id.clone(), &id, api, &ns, &pod, &container, cmd, cols, rows, s).await?;
    Ok(stream_id)
}

#[tauri::command]
pub async fn k8s_exec_write(state: State<'_, AppState>, stream_id: String, data_b64: String) -> AppResult<()> {
    let s = state.k8s_streams.exec(&stream_id)?;
    s.write(&decode_b64_input(&data_b64)?).await
}

#[tauri::command]
pub async fn k8s_exec_resize(state: State<'_, AppState>, stream_id: String, cols: u32, rows: u32) -> AppResult<()> {
    state.k8s_streams.exec(&stream_id)?.resize(cols, rows).await
}

#[tauri::command]
pub async fn k8s_stream_close(state: State<'_, AppState>, stream_id: String) -> AppResult<()> {
    state.k8s_streams.close(&stream_id).await;
    Ok(())
}

// ---- port-forward ----

#[tauri::command]
pub async fn k8s_forward_open(
    state: State<'_, AppState>,
    id: String,
    ns: String,
    target: String,
    remote_port: u16,
    local_port: u16,
) -> AppResult<K8sForwardInfo> {
    let api = api(&state, &id)?;
    state.k8s_forwards.open(&id, api, &ns, &target, remote_port, local_port).await
}

#[tauri::command]
pub fn k8s_forward_list(state: State<'_, AppState>, id: Option<String>) -> Vec<K8sForwardInfo> {
    state.k8s_forwards.list(id.as_deref())
}

#[tauri::command]
pub async fn k8s_forward_close(state: State<'_, AppState>, forward_id: String) -> AppResult<()> {
    state.k8s_forwards.close(&forward_id).await;
    Ok(())
}
