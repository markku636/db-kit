//! 容器類（Docker / Registry / Harbor）的 Tauri command（薄包裝；邏輯在 `crate::db::{docker,registry,harbor}`）。
//!
//! 串流（log / exec）的輸出走 `ipc::Channel<InvokeResponseBody::Raw>`（前端拿到 `ArrayBuffer`，
//! 與 SSH 終端同一套），結束發 `docker-stream-end` 事件（前端以 `stream_id` 過濾）。
//! 映像拉取進度走 `Channel<DockerPullProgress>`，指令本身等拉取完成才回傳。

use std::sync::Arc;

use base64::Engine as _;
use futures::StreamExt;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use super::AppState;
use crate::db::docker::api::{parse_pull_line, DockerApi};
use crate::db::docker::dto::*;
use crate::db::docker::stream::{StreamEvent, StreamSink};
use crate::db::harbor::api::HarborApi;
use crate::db::harbor::dto::*;
use crate::db::registry::dto::*;
use crate::error::{AppError, AppResult};
use crate::ssh::terminal::decode_b64_input;

fn api(state: &AppState, id: &str) -> AppResult<Arc<DockerApi>> {
    state.manager.container_driver(id)?.docker()
}

#[derive(Clone, Serialize)]
struct StreamEnd {
    stream_id: String,
    error: Option<String>,
    exit_code: Option<i64>,
}

/// StreamSink：資料走 Channel、結束發事件。
fn sink(app: AppHandle, stream_id: String, on_output: Channel<InvokeResponseBody>) -> StreamSink {
    Arc::new(move |ev| match ev {
        StreamEvent::Data(bytes) => {
            let _ = on_output.send(InvokeResponseBody::Raw(bytes));
        }
        StreamEvent::End { error, exit_code } => {
            let _ = app.emit("docker-stream-end", StreamEnd { stream_id: stream_id.clone(), error, exit_code });
        }
    })
}

// ---- 系統 ----

#[tauri::command]
pub async fn docker_overview(state: State<'_, AppState>, id: String) -> AppResult<DockerOverview> {
    api(&state, &id)?.overview().await
}

#[tauri::command]
pub async fn docker_disk_usage(state: State<'_, AppState>, id: String) -> AppResult<DockerDiskUsage> {
    api(&state, &id)?.disk_usage().await
}

#[tauri::command]
pub async fn docker_prune(state: State<'_, AppState>, id: String, target: String, all: bool) -> AppResult<DockerPruneResult> {
    api(&state, &id)?.prune(&target, all).await
}

// ---- 容器 ----

#[tauri::command]
pub async fn docker_containers(state: State<'_, AppState>, id: String, all: bool) -> AppResult<Vec<DockerContainer>> {
    api(&state, &id)?.containers(all).await
}

#[tauri::command]
pub async fn docker_container_inspect(state: State<'_, AppState>, id: String, container: String) -> AppResult<DockerContainerDetail> {
    api(&state, &id)?.container_inspect(&container).await
}

#[tauri::command]
pub async fn docker_container_action(state: State<'_, AppState>, id: String, container: String, action: String) -> AppResult<()> {
    api(&state, &id)?.container_action(&container, &action).await
}

#[tauri::command]
pub async fn docker_container_remove(
    state: State<'_, AppState>,
    id: String,
    container: String,
    force: bool,
    volumes: bool,
) -> AppResult<()> {
    api(&state, &id)?.container_remove(&container, force, volumes).await
}

#[tauri::command]
pub async fn docker_container_rename(state: State<'_, AppState>, id: String, container: String, name: String) -> AppResult<()> {
    api(&state, &id)?.container_rename(&container, &name).await
}

#[tauri::command]
pub async fn docker_container_stats(state: State<'_, AppState>, id: String, container: String) -> AppResult<DockerStats> {
    api(&state, &id)?.container_stats(&container).await
}

#[tauri::command]
pub async fn docker_container_top(state: State<'_, AppState>, id: String, container: String) -> AppResult<DockerTop> {
    api(&state, &id)?.container_top(&container).await
}

// ---- log / exec 串流 ----

/// 開 log 串流。`tail` = 0 → 全部；`follow` = 持續接收新輸出。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn docker_logs_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    container: String,
    tail: u32,
    timestamps: bool,
    follow: bool,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<String> {
    let api = api(&state, &id)?;
    let stream_id = uuid::Uuid::new_v4().to_string();
    let s = sink(app, stream_id.clone(), on_output);
    state
        .docker_streams
        .open_logs(stream_id.clone(), &id, api, &container, tail, timestamps, follow, s)
        .await?;
    Ok(stream_id)
}

/// 開 exec 互動終端。`cmd` 空 → 自動挑 bash / ash / sh。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn docker_exec_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    container: String,
    cmd: Vec<String>,
    user: String,
    cols: u32,
    rows: u32,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<String> {
    let api = api(&state, &id)?;
    let stream_id = uuid::Uuid::new_v4().to_string();
    let s = sink(app, stream_id.clone(), on_output);
    state
        .docker_streams
        .open_exec(stream_id.clone(), &id, api, &container, cmd, &user, cols, rows, s)
        .await?;
    Ok(stream_id)
}

/// xterm 輸入（base64）。
#[tauri::command]
pub async fn docker_exec_write(state: State<'_, AppState>, stream_id: String, data_b64: String) -> AppResult<()> {
    let s = state.docker_streams.exec(&stream_id)?;
    s.write(&decode_b64_input(&data_b64)?).await
}

#[tauri::command]
pub async fn docker_exec_resize(state: State<'_, AppState>, stream_id: String, cols: u32, rows: u32) -> AppResult<()> {
    state.docker_streams.exec(&stream_id)?.resize(cols, rows).await
}

/// 關閉 log / exec 串流（已結束的串流靜默忽略）。
#[tauri::command]
pub async fn docker_stream_close(state: State<'_, AppState>, stream_id: String) -> AppResult<()> {
    state.docker_streams.close(&stream_id).await;
    Ok(())
}

// ---- 映像 ----

#[tauri::command]
pub async fn docker_images(state: State<'_, AppState>, id: String) -> AppResult<Vec<DockerImage>> {
    api(&state, &id)?.images().await
}

#[tauri::command]
pub async fn docker_image_inspect(state: State<'_, AppState>, id: String, image: String) -> AppResult<DockerImageDetail> {
    api(&state, &id)?.image_inspect(&image).await
}

#[tauri::command]
pub async fn docker_image_remove(state: State<'_, AppState>, id: String, image: String, force: bool) -> AppResult<Vec<String>> {
    api(&state, &id)?.image_remove(&image, force).await
}

#[tauri::command]
pub async fn docker_image_tag(state: State<'_, AppState>, id: String, source: String, repo: String, tag: String) -> AppResult<()> {
    api(&state, &id)?.image_tag(&source, &repo, &tag).await
}

/// 拉取映像；進度逐筆送到 `on_progress`，完成才回傳。帳密空白 = 匿名。
/// `cred_conn`：密碼留空時改用這個已存連線（Registry / Harbor）在 keychain 裡的密碼——
/// 前端從 Registry / Harbor 的 tag「拉到 Docker」時用，密碼不必經過前端。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn docker_image_pull(
    state: State<'_, AppState>,
    id: String,
    image: String,
    tag: String,
    username: String,
    password: String,
    on_progress: Channel<DockerPullProgress>,
    cred_conn: Option<String>,
) -> AppResult<()> {
    let api = api(&state, &id)?;
    let password = match cred_conn.as_deref().filter(|c| !c.is_empty()) {
        Some(c) if password.is_empty() => crate::store::kc_get(c).unwrap_or_default(),
        _ => password,
    };
    let (image, tag) = split_image_tag(image.trim(), tag.trim());
    let auth = (!username.trim().is_empty()).then(|| registry_auth(&image, username.trim(), &password));
    let resp = api.image_pull(&image, &tag, auth).await?;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut last_error: Option<String> = None;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Query(e.to_string()))?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if let Some(p) = parse_pull_line(&String::from_utf8_lossy(&line)) {
                if !p.error.is_empty() {
                    last_error = Some(p.error.clone());
                }
                let _ = on_progress.send(p);
            }
        }
    }
    if let Some(p) = parse_pull_line(&String::from_utf8_lossy(&buf)) {
        if !p.error.is_empty() {
            last_error = Some(p.error.clone());
        }
        let _ = on_progress.send(p);
    }
    match last_error {
        Some(e) => Err(AppError::Query(e)),
        None => Ok(()),
    }
}

/// `nginx:1.27` + 空 tag → (`nginx`, `1.27`)；無 tag → latest。digest（`@sha256:`）原樣保留、tag 留空。
fn split_image_tag(image: &str, tag: &str) -> (String, String) {
    if !tag.is_empty() {
        return (image.to_string(), tag.to_string());
    }
    if image.contains('@') {
        return (image.to_string(), String::new());
    }
    // 最後一段（最後一個 / 之後）的冒號才是 tag；registry 的埠（host:5000/x）不算。
    let last_slash = image.rfind('/').map(|i| i + 1).unwrap_or(0);
    match image[last_slash..].rfind(':') {
        Some(i) => {
            let at = last_slash + i;
            (image[..at].to_string(), image[at + 1..].to_string())
        }
        None => (image.to_string(), "latest".to_string()),
    }
}

/// X-Registry-Auth：base64url(JSON{username, password, serveraddress})。
fn registry_auth(image: &str, username: &str, password: &str) -> String {
    let first = image.split('/').next().unwrap_or("");
    let server = if image.contains('/') && (first.contains('.') || first.contains(':') || first == "localhost") {
        first.to_string()
    } else {
        "https://index.docker.io/v1/".to_string()
    };
    let json = serde_json::json!({ "username": username, "password": password, "serveraddress": server });
    base64::engine::general_purpose::URL_SAFE.encode(json.to_string())
}

// ---- volume / network ----

#[tauri::command]
pub async fn docker_volumes(state: State<'_, AppState>, id: String) -> AppResult<Vec<DockerVolume>> {
    api(&state, &id)?.volumes().await
}

#[tauri::command]
pub async fn docker_volume_remove(state: State<'_, AppState>, id: String, name: String, force: bool) -> AppResult<()> {
    api(&state, &id)?.volume_remove(&name, force).await
}

#[tauri::command]
pub async fn docker_networks(state: State<'_, AppState>, id: String) -> AppResult<Vec<DockerNetwork>> {
    api(&state, &id)?.networks().await
}

#[tauri::command]
pub async fn docker_network_inspect(state: State<'_, AppState>, id: String, network: String) -> AppResult<DockerNetwork> {
    api(&state, &id)?.network_inspect(&network).await
}

#[tauri::command]
pub async fn docker_network_remove(state: State<'_, AppState>, id: String, network: String) -> AppResult<()> {
    api(&state, &id)?.network_remove(&network).await
}

// ---- Registry v2 ----

#[tauri::command]
pub async fn registry_info(state: State<'_, AppState>, id: String) -> AppResult<RegistryInfo> {
    let d = state.manager.container_driver(&id)?;
    d.registry()?.api.probe().await
}

#[tauri::command]
pub async fn registry_manifest(state: State<'_, AppState>, id: String, repo: String, reference: String) -> AppResult<RegistryManifest> {
    let d = state.manager.container_driver(&id)?;
    d.registry()?.api.manifest(&repo, &reference).await
}

#[tauri::command]
pub async fn registry_delete(state: State<'_, AppState>, id: String, repo: String, reference: String) -> AppResult<()> {
    let d = state.manager.container_driver(&id)?;
    d.registry()?.api.delete(&repo, &reference).await
}

// ---- Harbor ----

fn harbor(state: &AppState, id: &str) -> AppResult<Arc<HarborApi>> {
    state.manager.container_driver(id)?.harbor()
}

#[tauri::command]
pub async fn harbor_overview(state: State<'_, AppState>, id: String) -> AppResult<HarborOverview> {
    harbor(&state, &id)?.overview().await
}

#[tauri::command]
pub async fn harbor_project(state: State<'_, AppState>, id: String, project: String) -> AppResult<HarborProject> {
    harbor(&state, &id)?.project(&project).await
}

#[tauri::command]
pub async fn harbor_repositories(state: State<'_, AppState>, id: String, project: String) -> AppResult<Vec<HarborRepository>> {
    harbor(&state, &id)?.repositories(&project).await
}

#[tauri::command]
pub async fn harbor_artifacts(
    state: State<'_, AppState>,
    id: String,
    project: String,
    repo: String,
    page: u32,
    page_size: u32,
) -> AppResult<HarborArtifactPage> {
    harbor(&state, &id)?.artifacts(&project, &repo, page, page_size).await
}

#[tauri::command]
pub async fn harbor_scan(state: State<'_, AppState>, id: String, project: String, repo: String, digest: String) -> AppResult<()> {
    harbor(&state, &id)?.scan(&project, &repo, &digest).await
}

#[tauri::command]
pub async fn harbor_vulnerabilities(
    state: State<'_, AppState>,
    id: String,
    project: String,
    repo: String,
    digest: String,
) -> AppResult<HarborVulnReport> {
    harbor(&state, &id)?.vulnerabilities(&project, &repo, &digest).await
}

#[tauri::command]
pub async fn harbor_delete_artifact(state: State<'_, AppState>, id: String, project: String, repo: String, digest: String) -> AppResult<()> {
    harbor(&state, &id)?.delete_artifact(&project, &repo, &digest).await
}

#[tauri::command]
pub async fn harbor_delete_tag(
    state: State<'_, AppState>,
    id: String,
    project: String,
    repo: String,
    digest: String,
    tag: String,
) -> AppResult<()> {
    harbor(&state, &id)?.delete_tag(&project, &repo, &digest, &tag).await
}

#[tauri::command]
pub async fn harbor_delete_repository(state: State<'_, AppState>, id: String, project: String, repo: String) -> AppResult<()> {
    harbor(&state, &id)?.delete_repository(&project, &repo).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_tag_split() {
        assert_eq!(split_image_tag("nginx", ""), ("nginx".into(), "latest".into()));
        assert_eq!(split_image_tag("nginx:1.27", ""), ("nginx".into(), "1.27".into()));
        assert_eq!(split_image_tag("reg:5000/app", ""), ("reg:5000/app".into(), "latest".into()));
        assert_eq!(split_image_tag("reg:5000/app:v2", ""), ("reg:5000/app".into(), "v2".into()));
        assert_eq!(split_image_tag("app@sha256:ab", ""), ("app@sha256:ab".into(), String::new()));
        assert_eq!(split_image_tag("app", "dev"), ("app".into(), "dev".into()));
    }

    #[test]
    fn auth_server_address() {
        let decode = |s: String| -> serde_json::Value {
            serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE.decode(s).unwrap()).unwrap()
        };
        assert_eq!(decode(registry_auth("harbor.local/lib/app", "u", "p"))["serveraddress"], "harbor.local");
        assert_eq!(decode(registry_auth("library/nginx", "u", "p"))["serveraddress"], "https://index.docker.io/v1/");
        assert_eq!(decode(registry_auth("localhost/app", "u", "p"))["serveraddress"], "localhost");
    }
}
