//! Docker Engine REST 用戶端（reqwest）。本機 socket / named pipe 以 `http://localhost` 為 base，
//! 由 reqwest 的 `unix_socket` / `windows_named_pipe` 接到 daemon；TCP / TLS 走一般 HTTP(S)。
//!
//! 回應以 `serde_json::Value` 解析再映射成 dto：Engine API 各版本欄位增減頻繁，
//! 寬鬆讀取（缺欄給預設值）比嚴格 struct 更耐版本差異。

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use reqwest::header::{CONNECTION, UPGRADE};
use reqwest::{Client, Method, RequestBuilder, Response};
use serde_json::{json, Value};

use super::config::{self, Endpoint};
use super::dto::*;
use crate::db::http_tls::{apply_tunnel, client_builder, http_err, TlsOpts};
use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};

/// 一個 Docker daemon 端點。
pub struct DockerApi {
    /// 一般請求（30 秒整體逾時）。
    client: Client,
    /// 串流請求（log follow / pull / exec）：不設整體逾時。
    stream: Client,
    base: String,
    prefix: String,
    pub endpoint: Endpoint,
}

impl DockerApi {
    pub fn new(cfg: &ConnectionConfig) -> AppResult<Self> {
        let endpoint = config::endpoint(cfg);
        let prefix = config::api_prefix(cfg);
        let build = |timeout: Option<Duration>| -> AppResult<(Client, String)> {
            match &endpoint {
                Endpoint::Tcp(t) => {
                    let tls = if t.tls { config::tls_opts(cfg) } else { TlsOpts::default() };
                    let b = client_builder(&tls, timeout)?;
                    let (t, b) = apply_tunnel(cfg, t.clone(), b);
                    let client = b.build().map_err(http_err)?;
                    Ok((client, t.base_url()))
                }
                #[cfg(unix)]
                Endpoint::Unix(p) => {
                    let b = client_builder(&TlsOpts::default(), timeout)?.unix_socket(p.as_str());
                    Ok((b.build().map_err(http_err)?, "http://localhost".to_string()))
                }
                #[cfg(windows)]
                Endpoint::Pipe(p) => {
                    let b = client_builder(&TlsOpts::default(), timeout)?.windows_named_pipe(p.as_str());
                    Ok((b.build().map_err(http_err)?, "http://localhost".to_string()))
                }
                #[cfg(not(unix))]
                Endpoint::Unix(_) => Err(AppError::Connect(
                    t!("此作業系統不支援 unix socket；Windows 請用 npipe:// 或 TCP").into(),
                )),
                #[cfg(not(windows))]
                Endpoint::Pipe(_) => Err(AppError::Connect(
                    t!("named pipe 只在 Windows 可用；請改用 unix:// 或 TCP").into(),
                )),
            }
        };
        let (client, base) = build(Some(Duration::from_secs(30)))?;
        let (stream, _) = build(None)?;
        Ok(DockerApi { client, stream, base, prefix, endpoint })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}{}", self.base, self.prefix, path)
    }

    fn req(&self, method: Method, path: &str) -> RequestBuilder {
        self.client.request(method, self.url(path))
    }

    async fn send(&self, rb: RequestBuilder) -> AppResult<Response> {
        let resp = rb.send().await.map_err(|e| self.transport_err(e))?;
        check_status(resp).await
    }

    /// 傳輸層錯誤：附上端點，並對「本機 daemon 沒開」給明確提示。
    fn transport_err(&self, e: reqwest::Error) -> AppError {
        let hint = if self.endpoint.is_local() {
            t!("（Docker daemon 是否在執行？Docker Desktop 需先啟動）")
        } else {
            ""
        };
        match http_err(e) {
            AppError::Connect(m) => AppError::Connect(format!("{} — {m}{hint}", self.endpoint.label())),
            other => other,
        }
    }

    async fn get_json(&self, path: &str) -> AppResult<Value> {
        let resp = self.send(self.req(Method::GET, path)).await?;
        resp.json().await.map_err(http_err)
    }

    async fn get_json_q(&self, path: &str, q: &[(&str, String)]) -> AppResult<Value> {
        let resp = self.send(self.req(Method::GET, path).query(q)).await?;
        resp.json().await.map_err(http_err)
    }

    // ---- 系統 ----

    pub async fn ping(&self) -> AppResult<()> {
        self.send(self.req(Method::GET, "/_ping")).await.map(|_| ())
    }

    pub async fn overview(&self) -> AppResult<DockerOverview> {
        let ver = self.get_json("/version").await?;
        let info = self.get_json("/info").await?;
        Ok(DockerOverview {
            endpoint: self.endpoint.label(),
            server_version: s(&ver, "Version"),
            api_version: s(&ver, "ApiVersion"),
            os: s(&info, "OperatingSystem"),
            os_type: s(&info, "OSType"),
            arch: s(&info, "Architecture"),
            kernel: s(&info, "KernelVersion"),
            name: s(&info, "Name"),
            ncpu: i(&info, "NCPU"),
            mem_total: i(&info, "MemTotal"),
            driver: s(&info, "Driver"),
            root_dir: s(&info, "DockerRootDir"),
            containers: i(&info, "Containers"),
            running: i(&info, "ContainersRunning"),
            paused: i(&info, "ContainersPaused"),
            stopped: i(&info, "ContainersStopped"),
            images: i(&info, "Images"),
            warnings: strs(&info, "Warnings"),
        })
    }

    pub async fn disk_usage(&self) -> AppResult<DockerDiskUsage> {
        let v = self.get_json("/system/df").await?;
        let mut d = DockerDiskUsage::default();
        for img in arr(&v, "Images") {
            d.images_count += 1;
            d.images_size += i(img, "Size");
            if i(img, "Containers") == 0 {
                d.images_reclaimable += i(img, "Size") - i(img, "SharedSize").max(0);
            }
        }
        for c in arr(&v, "Containers") {
            d.containers_count += 1;
            d.containers_size += i(c, "SizeRw");
        }
        for vol in arr(&v, "Volumes") {
            d.volumes_count += 1;
            let usage = &vol["UsageData"];
            let size = i(usage, "Size").max(0);
            d.volumes_size += size;
            if i(usage, "RefCount") == 0 {
                d.volumes_reclaimable += size;
            }
        }
        for b in arr(&v, "BuildCache") {
            d.build_cache_count += 1;
            d.build_cache_size += i(b, "Size");
        }
        Ok(d)
    }

    /// prune：`target` = containers / images / volumes / networks / build。
    /// `all`（僅 images / volumes）：images 連同未被使用的具名映像、volumes 連同具名 volume 一併清。
    pub async fn prune(&self, target: &str, all: bool) -> AppResult<DockerPruneResult> {
        let (path, deleted_key) = match target {
            "containers" => ("/containers/prune", "ContainersDeleted"),
            "images" => ("/images/prune", "ImagesDeleted"),
            "volumes" => ("/volumes/prune", "VolumesDeleted"),
            "networks" => ("/networks/prune", "NetworksDeleted"),
            "build" => ("/build/prune", "CachesDeleted"),
            other => return Err(AppError::Query(tf!("不支援的清理目標：{t}", t = other))),
        };
        let mut rb = self.stream.request(Method::POST, self.url(path));
        if all {
            let filters = match target {
                "images" => Some(json!({"dangling": ["false"]})),
                "volumes" => Some(json!({"all": ["true"]})),
                _ => None,
            };
            if let Some(f) = filters {
                rb = rb.query(&[("filters", f.to_string())]);
            }
            if target == "build" {
                rb = rb.query(&[("all", "true")]);
            }
        }
        let resp = self.send(rb).await?;
        let v: Value = resp.json().await.map_err(http_err)?;
        Ok(DockerPruneResult {
            deleted: v[deleted_key].as_array().map(|a| a.len() as i64).unwrap_or(0),
            space_reclaimed: i(&v, "SpaceReclaimed"),
        })
    }

    // ---- 容器 ----

    pub async fn containers(&self, all: bool) -> AppResult<Vec<DockerContainer>> {
        let v = self
            .get_json_q("/containers/json", &[("all", if all { "1" } else { "0" }.to_string())])
            .await?;
        let mut out: Vec<DockerContainer> = arr(&v, "").iter().map(map_container).collect();
        out.sort_by(|a, b| (a.compose_project.as_str(), a.name.as_str()).cmp(&(b.compose_project.as_str(), b.name.as_str())));
        Ok(out)
    }

    async fn container_raw(&self, id: &str) -> AppResult<Value> {
        self.get_json(&format!("/containers/{}/json", seg(id))).await
    }

    /// 容器是否以 TTY 啟動（log 串流是否多工）。
    pub async fn container_tty(&self, id: &str) -> AppResult<bool> {
        Ok(b(&self.container_raw(id).await?["Config"], "Tty"))
    }

    pub async fn container_inspect(&self, id: &str) -> AppResult<DockerContainerDetail> {
        let v = self.container_raw(id).await?;
        Ok(map_container_detail(&v))
    }

    /// start / stop / restart / pause / unpause / kill。304（已在該狀態）視為成功。
    pub async fn container_action(&self, id: &str, action: &str) -> AppResult<()> {
        if !matches!(action, "start" | "stop" | "restart" | "pause" | "unpause" | "kill") {
            return Err(AppError::Query(tf!("不支援的容器操作：{a}", a = action)));
        }
        // stop / restart 預設等 10 秒再 SIGKILL；請求逾時要比它長。
        let rb = self
            .stream
            .request(Method::POST, self.url(&format!("/containers/{}/{action}", seg(id))))
            .timeout(Duration::from_secs(60));
        self.send(rb).await.map(|_| ())
    }

    pub async fn container_remove(&self, id: &str, force: bool, volumes: bool) -> AppResult<()> {
        let rb = self.req(Method::DELETE, &format!("/containers/{}", seg(id))).query(&[
            ("force", force.to_string()),
            ("v", volumes.to_string()),
        ]);
        self.send(rb).await.map(|_| ())
    }

    pub async fn container_rename(&self, id: &str, name: &str) -> AppResult<()> {
        let rb = self
            .req(Method::POST, &format!("/containers/{}/rename", seg(id)))
            .query(&[("name", name)]);
        self.send(rb).await.map(|_| ())
    }

    pub async fn container_stats(&self, id: &str) -> AppResult<DockerStats> {
        let v = self
            .get_json_q(&format!("/containers/{}/stats", seg(id)), &[("stream", "false".to_string())])
            .await?;
        Ok(compute_stats(&v))
    }

    pub async fn container_top(&self, id: &str) -> AppResult<DockerTop> {
        let v = self.get_json(&format!("/containers/{}/top", seg(id))).await?;
        Ok(DockerTop {
            titles: strs(&v, "Titles"),
            processes: arr(&v, "Processes")
                .iter()
                .map(|row| row.as_array().map(|r| r.iter().map(val_str).collect()).unwrap_or_default())
                .collect(),
        })
    }

    /// log 串流（未消費的 Response；呼叫端逐塊讀取）。`tail` = 0 → all。
    pub async fn logs(&self, id: &str, tail: u32, timestamps: bool, follow: bool) -> AppResult<Response> {
        let tail = if tail == 0 { "all".to_string() } else { tail.to_string() };
        let rb = self
            .stream
            .request(Method::GET, self.url(&format!("/containers/{}/logs", seg(id))))
            .query(&[
                ("stdout", "1".to_string()),
                ("stderr", "1".to_string()),
                ("follow", if follow { "1" } else { "0" }.to_string()),
                ("timestamps", if timestamps { "1" } else { "0" }.to_string()),
                ("tail", tail),
            ]);
        self.send(rb).await
    }

    // ---- exec ----

    /// 建立 exec 實例，回傳 exec id。
    pub async fn exec_create(&self, id: &str, cmd: &[String], user: &str, tty: bool) -> AppResult<String> {
        let mut body = json!({
            "AttachStdin": true,
            "AttachStdout": true,
            "AttachStderr": true,
            "Tty": tty,
            "Cmd": cmd,
            "Env": ["TERM=xterm-256color"],
        });
        if !user.trim().is_empty() {
            body["User"] = json!(user.trim());
        }
        let resp = self
            .send(self.req(Method::POST, &format!("/containers/{}/exec", seg(id))).json(&body))
            .await?;
        let v: Value = resp.json().await.map_err(http_err)?;
        let exec_id = s(&v, "Id");
        if exec_id.is_empty() {
            return Err(AppError::Query(t!("Docker 沒有回傳 exec id").into()));
        }
        Ok(exec_id)
    }

    /// 啟動 exec 並升級成雙向 raw stream（hijack）。
    pub async fn exec_start(&self, exec_id: &str, tty: bool) -> AppResult<reqwest::Upgraded> {
        let resp = self
            .stream
            .request(Method::POST, self.url(&format!("/exec/{}/start", seg(exec_id))))
            .header(CONNECTION, "Upgrade")
            .header(UPGRADE, "tcp")
            .json(&json!({ "Detach": false, "Tty": tty }))
            .send()
            .await
            .map_err(|e| self.transport_err(e))?;
        if resp.status() != reqwest::StatusCode::SWITCHING_PROTOCOLS {
            let resp = check_status(resp).await?;
            return Err(AppError::Query(tf!(
                "Docker 未切換成互動串流（HTTP {code}）",
                code = resp.status().as_u16()
            )));
        }
        resp.upgrade().await.map_err(http_err)
    }

    pub async fn exec_resize(&self, exec_id: &str, cols: u32, rows: u32) -> AppResult<()> {
        let rb = self
            .req(Method::POST, &format!("/exec/{}/resize", seg(exec_id)))
            .query(&[("h", rows.to_string()), ("w", cols.to_string())]);
        self.send(rb).await.map(|_| ())
    }

    /// exec 結束碼（仍在跑 → None）。
    pub async fn exec_exit_code(&self, exec_id: &str) -> AppResult<Option<i64>> {
        let v = self.get_json(&format!("/exec/{}/json", seg(exec_id))).await?;
        if b(&v, "Running") {
            return Ok(None);
        }
        Ok(v["ExitCode"].as_i64())
    }

    // ---- 映像 ----

    pub async fn images(&self) -> AppResult<Vec<DockerImage>> {
        let v = self.get_json("/images/json").await?;
        let mut out = Vec::new();
        for img in arr(&v, "") {
            let id = s(img, "Id");
            let tags: Vec<String> = strs(img, "RepoTags").into_iter().filter(|t| t != "<none>:<none>").collect();
            let digests = strs(img, "RepoDigests");
            let base = DockerImage {
                id: id.clone(),
                reference: short_id(&id),
                repo_tags: tags.clone(),
                repo_digests: digests,
                created: i(img, "Created"),
                size: i(img, "Size"),
                containers: img["Containers"].as_i64().unwrap_or(-1),
                dangling: tags.is_empty(),
            };
            if tags.is_empty() {
                out.push(base);
            } else {
                for t in &tags {
                    out.push(DockerImage { reference: t.clone(), ..base.clone() });
                }
            }
        }
        out.sort_by(|a, b| (a.dangling, a.reference.as_str()).cmp(&(b.dangling, b.reference.as_str())));
        Ok(out)
    }

    pub async fn image_inspect(&self, reference: &str) -> AppResult<DockerImageDetail> {
        let v = self.get_json(&format!("/images/{}/json", seg(reference))).await?;
        let hist = self
            .get_json(&format!("/images/{}/history", seg(reference)))
            .await
            .unwrap_or(Value::Null);
        let cfg = &v["Config"];
        Ok(DockerImageDetail {
            id: s(&v, "Id"),
            repo_tags: strs(&v, "RepoTags"),
            repo_digests: strs(&v, "RepoDigests"),
            created: s(&v, "Created"),
            arch: s(&v, "Architecture"),
            os: s(&v, "Os"),
            size: i(&v, "Size"),
            author: s(&v, "Author"),
            entrypoint: strs(cfg, "Entrypoint"),
            cmd: strs(cfg, "Cmd"),
            env: strs(cfg, "Env"),
            exposed_ports: obj_keys(cfg, "ExposedPorts"),
            working_dir: s(cfg, "WorkingDir"),
            user: s(cfg, "User"),
            labels: str_map(cfg, "Labels"),
            layers: v["RootFS"]["Layers"].as_array().map(|a| a.len()).unwrap_or(0),
            history: arr(&hist, "")
                .iter()
                .map(|h| DockerImageLayer {
                    created: i(h, "Created"),
                    created_by: s(h, "CreatedBy"),
                    size: i(h, "Size"),
                    comment: s(h, "Comment"),
                })
                .collect(),
            raw: pretty(&v),
        })
    }

    /// 刪除映像（或移除一個 tag）。回傳 daemon 報告的 Untagged / Deleted 清單。
    pub async fn image_remove(&self, reference: &str, force: bool) -> AppResult<Vec<String>> {
        let rb = self
            .req(Method::DELETE, &format!("/images/{}", seg(reference)))
            .query(&[("force", force.to_string())]);
        let v: Value = self.send(rb).await?.json().await.map_err(http_err)?;
        Ok(arr(&v, "")
            .iter()
            .flat_map(|x| {
                let mut out = Vec::new();
                if let Some(u) = x["Untagged"].as_str() {
                    out.push(format!("Untagged {u}"));
                }
                if let Some(d) = x["Deleted"].as_str() {
                    out.push(format!("Deleted {d}"));
                }
                out
            })
            .collect())
    }

    /// `docker tag`：`source` 加上 `repo:tag`。
    pub async fn image_tag(&self, source: &str, repo: &str, tag: &str) -> AppResult<()> {
        let rb = self
            .req(Method::POST, &format!("/images/{}/tag", seg(source)))
            .query(&[("repo", repo), ("tag", tag)]);
        self.send(rb).await.map(|_| ())
    }

    /// 拉取映像（未消費的進度串流；每行一個 JSON）。`auth` 為 base64 的 X-Registry-Auth。
    pub async fn image_pull(&self, image: &str, tag: &str, auth: Option<String>) -> AppResult<Response> {
        let mut rb = self
            .stream
            .request(Method::POST, self.url("/images/create"))
            .query(&[("fromImage", image), ("tag", tag)]);
        if let Some(a) = auth {
            rb = rb.header("X-Registry-Auth", a);
        }
        self.send(rb).await
    }

    // ---- volume / network ----

    pub async fn volumes(&self) -> AppResult<Vec<DockerVolume>> {
        let v = self.get_json("/volumes").await?;
        let users = self.volume_users().await.unwrap_or_default();
        let mut out: Vec<DockerVolume> = arr(&v, "Volumes")
            .iter()
            .map(|vol| {
                let name = s(vol, "Name");
                DockerVolume {
                    used_by: users.get(&name).cloned().unwrap_or_default(),
                    name,
                    driver: s(vol, "Driver"),
                    mountpoint: s(vol, "Mountpoint"),
                    created: s(vol, "CreatedAt"),
                    scope: s(vol, "Scope"),
                    labels: str_map(vol, "Labels"),
                    raw: pretty(vol),
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// volume 名 → 使用它的容器名。
    async fn volume_users(&self) -> AppResult<BTreeMap<String, Vec<String>>> {
        let v = self.get_json_q("/containers/json", &[("all", "1".to_string())]).await?;
        let mut m: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for c in arr(&v, "") {
            let name = first_name(c);
            for mnt in arr(c, "Mounts") {
                if s(mnt, "Type") == "volume" {
                    m.entry(s(mnt, "Name")).or_default().push(name.clone());
                }
            }
        }
        Ok(m)
    }

    pub async fn volume_remove(&self, name: &str, force: bool) -> AppResult<()> {
        let rb = self
            .req(Method::DELETE, &format!("/volumes/{}", seg(name)))
            .query(&[("force", force.to_string())]);
        self.send(rb).await.map(|_| ())
    }

    pub async fn networks(&self) -> AppResult<Vec<DockerNetwork>> {
        let v = self.get_json("/networks").await?;
        let mut out: Vec<DockerNetwork> = arr(&v, "").iter().map(map_network).collect();
        out.sort_by(|a, b| (!a.builtin, a.name.as_str()).cmp(&(!b.builtin, b.name.as_str())));
        Ok(out)
    }

    /// 單一網路（inspect 才帶成員容器）。
    pub async fn network_inspect(&self, id: &str) -> AppResult<DockerNetwork> {
        let v = self.get_json(&format!("/networks/{}", seg(id))).await?;
        Ok(map_network(&v))
    }

    pub async fn network_remove(&self, id: &str) -> AppResult<()> {
        self.send(self.req(Method::DELETE, &format!("/networks/{}", seg(id)))).await.map(|_| ())
    }
}

/// 非 2xx → AppError::Query（取 daemon 的 `message`）。304（容器已在目標狀態）視為成功。
async fn check_status(resp: Response) -> AppResult<Response> {
    let st = resp.status();
    if st.is_success() || st == reqwest::StatusCode::NOT_MODIFIED || st == reqwest::StatusCode::SWITCHING_PROTOCOLS {
        return Ok(resp);
    }
    let code = st.as_u16();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_string))
        .unwrap_or(body);
    Err(AppError::Query(format!("Docker {code}：{}", msg.trim())))
}

/// 路徑段編碼：保留 image 參照會用到的 `/ : @`，其餘非 unreserved 字元 percent-encode。
fn seg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &c in s.as_bytes() {
        match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' | b'@' => out.push(c as char),
            _ => out.push_str(&format!("%{c:02X}")),
        }
    }
    out
}

// ---- JSON 寬鬆讀取 ----

fn s(v: &Value, k: &str) -> String {
    val_str(&v[k])
}

fn val_str(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn i(v: &Value, k: &str) -> i64 {
    v[k].as_i64().or_else(|| v[k].as_f64().map(|f| f as i64)).unwrap_or(0)
}

fn b(v: &Value, k: &str) -> bool {
    v[k].as_bool().unwrap_or(false)
}

/// `k` 為空字串時把 v 自己當陣列。
fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    let x = if k.is_empty() { v } else { &v[k] };
    x.as_array().map(|a| a.as_slice()).unwrap_or(&[])
}

fn strs(v: &Value, k: &str) -> Vec<String> {
    match &v[k] {
        Value::Array(a) => a.iter().map(val_str).collect(),
        Value::String(x) if !x.is_empty() => vec![x.clone()],
        _ => Vec::new(),
    }
}

fn str_map(v: &Value, k: &str) -> BTreeMap<String, String> {
    v[k].as_object()
        .map(|o| o.iter().map(|(k, v)| (k.clone(), val_str(v))).collect())
        .unwrap_or_default()
}

fn obj_keys(v: &Value, k: &str) -> Vec<String> {
    v[k].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default()
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn short_id(id: &str) -> String {
    id.trim_start_matches("sha256:").chars().take(12).collect()
}

fn first_name(c: &Value) -> String {
    arr(c, "Names")
        .first()
        .and_then(Value::as_str)
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_else(|| short_id(&s(c, "Id")))
}

// ---- 映射 ----

fn map_container(c: &Value) -> DockerContainer {
    let labels = &c["Labels"];
    let mut seen = HashSet::new();
    let ports = arr(c, "Ports")
        .iter()
        .filter_map(|p| {
            let port = DockerPort {
                private_port: i(p, "PrivatePort") as u16,
                public_port: p["PublicPort"].as_u64().map(|x| x as u16),
                ip: s(p, "IP"),
                proto: s(p, "Type"),
            };
            // IPv4 / IPv6 各報一次同一條映射，去重。
            seen.insert((port.private_port, port.public_port, port.proto.clone())).then_some(port)
        })
        .collect::<Vec<_>>();
    let mut ports = ports;
    ports.sort_by_key(|p| (p.private_port, p.public_port));
    DockerContainer {
        id: s(c, "Id"),
        name: first_name(c),
        image: s(c, "Image"),
        command: s(c, "Command"),
        created: i(c, "Created"),
        state: s(c, "State"),
        status: s(c, "Status"),
        ports,
        compose_project: s(labels, "com.docker.compose.project"),
        compose_service: s(labels, "com.docker.compose.service"),
    }
}

/// inspect 的 `NetworkSettings.Ports`（`{"5432/tcp": [{HostIp, HostPort}] | null}`）→ DockerPort。
fn inspect_ports(v: &Value) -> Vec<DockerPort> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(o) = v["NetworkSettings"]["Ports"].as_object() {
        for (k, binds) in o {
            let (port, proto) = k.split_once('/').unwrap_or((k.as_str(), "tcp"));
            let private_port: u16 = port.parse().unwrap_or(0);
            let list = binds.as_array().cloned().unwrap_or_default();
            if list.is_empty() {
                out.push(DockerPort { private_port, public_port: None, ip: String::new(), proto: proto.to_string() });
                continue;
            }
            for bnd in list {
                let public_port = s(&bnd, "HostPort").parse().ok();
                if seen.insert((private_port, public_port, proto.to_string())) {
                    out.push(DockerPort { private_port, public_port, ip: s(&bnd, "HostIp"), proto: proto.to_string() });
                }
            }
        }
    }
    out.sort_by_key(|p| (p.private_port, p.public_port));
    out
}

fn map_container_detail(v: &Value) -> DockerContainerDetail {
    let st = &v["State"];
    let cfg = &v["Config"];
    let hc = &v["HostConfig"];
    let health = &st["Health"];
    DockerContainerDetail {
        id: s(v, "Id"),
        name: s(v, "Name").trim_start_matches('/').to_string(),
        image: s(cfg, "Image"),
        image_id: s(v, "Image"),
        created: s(v, "Created"),
        state: s(st, "Status"),
        running: b(st, "Running"),
        paused: b(st, "Paused"),
        restarting: b(st, "Restarting"),
        oom_killed: b(st, "OOMKilled"),
        pid: i(st, "Pid"),
        exit_code: i(st, "ExitCode"),
        error: s(st, "Error"),
        started_at: s(st, "StartedAt"),
        finished_at: s(st, "FinishedAt"),
        restart_count: i(v, "RestartCount"),
        restart_policy: s(&hc["RestartPolicy"], "Name"),
        health: s(health, "Status"),
        health_log: arr(health, "Log")
            .iter()
            .rev()
            .take(5)
            .map(|h| DockerHealthLog { start: s(h, "Start"), exit_code: i(h, "ExitCode"), output: s(h, "Output") })
            .collect(),
        tty: b(cfg, "Tty"),
        hostname: s(cfg, "Hostname"),
        user: s(cfg, "User"),
        working_dir: s(cfg, "WorkingDir"),
        entrypoint: strs(cfg, "Entrypoint"),
        cmd: strs(cfg, "Cmd"),
        env: strs(cfg, "Env"),
        labels: str_map(cfg, "Labels"),
        ports: inspect_ports(v),
        mounts: arr(v, "Mounts")
            .iter()
            .map(|m| DockerMount {
                kind: s(m, "Type"),
                name: s(m, "Name"),
                source: s(m, "Source"),
                destination: s(m, "Destination"),
                mode: s(m, "Mode"),
                rw: b(m, "RW"),
            })
            .collect(),
        networks: v["NetworkSettings"]["Networks"]
            .as_object()
            .map(|o| {
                o.iter()
                    .map(|(name, n)| DockerContainerNet {
                        name: name.clone(),
                        ip: s(n, "IPAddress"),
                        gateway: s(n, "Gateway"),
                        mac: s(n, "MacAddress"),
                        aliases: strs(n, "Aliases"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        network_mode: s(hc, "NetworkMode"),
        raw: pretty(v),
    }
}

fn map_network(n: &Value) -> DockerNetwork {
    let name = s(n, "Name");
    let ipam = arr(&n["IPAM"], "Config");
    let mut members: Vec<DockerNetworkMember> = n["Containers"]
        .as_object()
        .map(|o| {
            o.values()
                .map(|c| DockerNetworkMember { name: s(c, "Name"), ipv4: s(c, "IPv4Address"), mac: s(c, "MacAddress") })
                .collect()
        })
        .unwrap_or_default();
    members.sort_by(|a, b| a.name.cmp(&b.name));
    DockerNetwork {
        id: s(n, "Id"),
        builtin: matches!(name.as_str(), "bridge" | "host" | "none" | "nat" | "ingress" | "docker_gwbridge"),
        name,
        driver: s(n, "Driver"),
        scope: s(n, "Scope"),
        internal: b(n, "Internal"),
        subnets: ipam.iter().map(|c| s(c, "Subnet")).filter(|x| !x.is_empty()).collect(),
        gateways: ipam.iter().map(|c| s(c, "Gateway")).filter(|x| !x.is_empty()).collect(),
        members,
        raw: pretty(n),
    }
}

/// `/containers/{id}/stats?stream=false` → CPU% / 記憶體等（與 `docker stats` 相同算法）。
pub(crate) fn compute_stats(v: &Value) -> DockerStats {
    let cpu = &v["cpu_stats"];
    let pre = &v["precpu_stats"];
    let total = cpu["cpu_usage"]["total_usage"].as_f64().unwrap_or(0.0);
    let pre_total = pre["cpu_usage"]["total_usage"].as_f64().unwrap_or(0.0);
    let sys = cpu["system_cpu_usage"].as_f64().unwrap_or(0.0);
    let pre_sys = pre["system_cpu_usage"].as_f64().unwrap_or(0.0);
    let online = cpu["online_cpus"]
        .as_i64()
        .filter(|n| *n > 0)
        .or_else(|| cpu["cpu_usage"]["percpu_usage"].as_array().map(|a| a.len() as i64))
        .unwrap_or(1);
    let cpu_delta = total - pre_total;
    let sys_delta = sys - pre_sys;
    let cpu_percent = if cpu_delta > 0.0 && sys_delta > 0.0 {
        cpu_delta / sys_delta * online as f64 * 100.0
    } else {
        0.0
    };
    let mem = &v["memory_stats"];
    let usage = i(mem, "usage");
    // cgroup v2 扣 inactive_file、v1 扣 cache（與 docker CLI 一致）。
    let cache = mem["stats"]["inactive_file"]
        .as_i64()
        .or_else(|| mem["stats"]["total_inactive_file"].as_i64())
        .or_else(|| mem["stats"]["cache"].as_i64())
        .unwrap_or(0);
    let mem_usage = (usage - cache).max(0);
    let mem_limit = i(mem, "limit");
    let mem_percent = if mem_limit > 0 { mem_usage as f64 / mem_limit as f64 * 100.0 } else { 0.0 };
    let (mut rx, mut tx) = (0, 0);
    if let Some(nets) = v["networks"].as_object() {
        for n in nets.values() {
            rx += i(n, "rx_bytes");
            tx += i(n, "tx_bytes");
        }
    }
    let (mut rd, mut wr) = (0, 0);
    for e in arr(&v["blkio_stats"], "io_service_bytes_recursive") {
        match s(e, "op").to_ascii_lowercase().as_str() {
            "read" => rd += i(e, "value"),
            "write" => wr += i(e, "value"),
            _ => {}
        }
    }
    DockerStats {
        cpu_percent,
        online_cpus: online,
        mem_usage,
        mem_limit,
        mem_percent,
        net_rx: rx,
        net_tx: tx,
        blk_read: rd,
        blk_write: wr,
        pids: i(&v["pids_stats"], "current"),
    }
}

/// 拉取進度的一行 JSON → DockerPullProgress。
pub(crate) fn parse_pull_line(line: &str) -> Option<DockerPullProgress> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let detail = &v["progressDetail"];
    Some(DockerPullProgress {
        id: s(&v, "id"),
        status: s(&v, "status"),
        progress: s(&v, "progress"),
        current: i(detail, "current"),
        total: i(detail, "total"),
        error: {
            let e = s(&v, "error");
            if e.is_empty() { s(&v["errorDetail"], "message") } else { e }
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_list_maps_and_dedupes_ports() {
        let v: Value = serde_json::from_str(
            r#"[{"Id":"abc","Names":["/pg"],"Image":"postgres:16","Command":"docker-entrypoint.sh postgres",
            "Created":1700000000,"State":"running","Status":"Up 2 hours",
            "Ports":[{"IP":"0.0.0.0","PrivatePort":5432,"PublicPort":15432,"Type":"tcp"},
                     {"IP":"::","PrivatePort":5432,"PublicPort":15432,"Type":"tcp"}],
            "Labels":{"com.docker.compose.project":"shop","com.docker.compose.service":"db"}}]"#,
        )
        .unwrap();
        let c = map_container(&arr(&v, "")[0]);
        assert_eq!(c.name, "pg");
        assert_eq!(c.ports.len(), 1);
        assert_eq!(c.ports[0].public_port, Some(15432));
        assert_eq!((c.compose_project.as_str(), c.compose_service.as_str()), ("shop", "db"));
    }

    #[test]
    fn inspect_ports_handles_null_bindings() {
        let v: Value = serde_json::from_str(
            r#"{"NetworkSettings":{"Ports":{"6379/tcp":null,"5432/tcp":[{"HostIp":"0.0.0.0","HostPort":"5433"},{"HostIp":"::","HostPort":"5433"}]}}}"#,
        )
        .unwrap();
        let p = inspect_ports(&v);
        assert_eq!(p.len(), 2);
        assert_eq!((p[0].private_port, p[0].public_port), (5432, Some(5433)));
        assert_eq!((p[1].private_port, p[1].public_port), (6379, None));
    }

    #[test]
    fn stats_cpu_and_memory() {
        let v: Value = serde_json::from_str(
            r#"{"cpu_stats":{"cpu_usage":{"total_usage":2000},"system_cpu_usage":20000,"online_cpus":4},
            "precpu_stats":{"cpu_usage":{"total_usage":1000},"system_cpu_usage":10000},
            "memory_stats":{"usage":1000,"limit":4000,"stats":{"inactive_file":200}},
            "networks":{"eth0":{"rx_bytes":10,"tx_bytes":20},"eth1":{"rx_bytes":1,"tx_bytes":2}},
            "blkio_stats":{"io_service_bytes_recursive":[{"op":"Read","value":7},{"op":"write","value":9}]},
            "pids_stats":{"current":12}}"#,
        )
        .unwrap();
        let st = compute_stats(&v);
        assert!((st.cpu_percent - 40.0).abs() < 1e-9);
        assert_eq!((st.mem_usage, st.mem_limit), (800, 4000));
        assert!((st.mem_percent - 20.0).abs() < 1e-9);
        assert_eq!((st.net_rx, st.net_tx, st.blk_read, st.blk_write, st.pids), (11, 22, 7, 9, 12));
    }

    #[test]
    fn pull_line_parsing() {
        let p = parse_pull_line(r#"{"status":"Downloading","progressDetail":{"current":5,"total":10},"progress":"[==>  ]","id":"a1b2"}"#).unwrap();
        assert_eq!((p.id.as_str(), p.current, p.total), ("a1b2", 5, 10));
        let e = parse_pull_line(r#"{"errorDetail":{"message":"denied"},"error":""}"#).unwrap();
        assert_eq!(e.error, "denied");
        assert!(parse_pull_line("not json").is_none());
    }

    #[test]
    fn seg_keeps_image_refs() {
        assert_eq!(seg("ghcr.io/org/app:1.2@sha256:ab"), "ghcr.io/org/app:1.2@sha256:ab");
        assert_eq!(seg("a b"), "a%20b");
    }

    #[test]
    fn network_builtin_flag() {
        let v: Value = serde_json::from_str(r#"{"Name":"bridge","Id":"x","IPAM":{"Config":[{"Subnet":"172.17.0.0/16","Gateway":"172.17.0.1"}]}}"#).unwrap();
        let n = map_network(&v);
        assert!(n.builtin);
        assert_eq!(n.subnets, vec!["172.17.0.0/16"]);
    }
}
