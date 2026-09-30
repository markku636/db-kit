//! Kubernetes API server REST 用戶端（reqwest）。
//!
//! - 認證每個請求現算：token / tokenFile（每次重讀，輪替的 SA token 才會生效）/ basic / exec plugin。
//!   exec plugin 回用戶端憑證時，reqwest `Client` 的 identity 要跟著換，所以 client 放在 `RwLock` 裡可重建。
//!   API server 回 401 且有 exec plugin：強制重跑 plugin、重送一次。
//! - 回應以 `serde_json::Value` 處理：資源種類多（含 CRD），前端依原始物件自己排版；後端只做
//!   樹狀清單、表格（server-side printing 的 `as=Table`）、YAML 往返、事件 / 指標這些需要彙整的部分。
//! - 串流（log / exec / port-forward）用另一個不設整體逾時、強制 HTTP/1.1 的 client（WebSocket upgrade 需要）。

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures::future::join_all;
use parking_lot::RwLock;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde_json::{json, Value};

use super::auth::{ClusterInfo, ExecAuth};
use super::dto::*;
use super::kubeconfig::{self, ClusterSpec};
use crate::db::http_tls::{apply_tunnel, client_builder, http_err, opt, parse_target, HttpTarget, TlsOpts, TUNNEL_ORIGIN_HOST};
use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};

/// SSH 通道前處理記下的原始 API server 網址（記憶體內，不落地）。
pub const TUNNEL_SERVER: &str = "__k8s_server";
/// server-side apply 的 field manager 名稱。
pub const FIELD_MANAGER: &str = "db-kit";
const TABLE_ACCEPT: &str = "application/json;as=Table;v=v1;g=meta.k8s.io, application/json";
const META_ACCEPT: &str = "application/json;as=PartialObjectMetadataList;v=v1;g=meta.k8s.io, application/json";

struct Clients {
    /// 一般請求（30 秒整體逾時）。
    client: Client,
    /// 串流請求：不設整體逾時、HTTP/1.1。
    stream: Client,
    /// 目前 identity 的來源（exec 憑證變了才重建）。
    identity: Option<(String, String)>,
}

struct BuildParams {
    target: HttpTarget,
    tls: TlsOpts,
    proxy: Option<String>,
    /// SSH 通道：`resolve(原主機名 → 127.0.0.1:本地埠)`。
    tunnel_cfg: Option<ConnectionConfig>,
    /// tls-server-name：以該名稱連線、resolve 到原主機（僅原主機為 IP 時可行）。
    sni: Option<(String, std::net::SocketAddr)>,
}

pub struct K8sApi {
    base: String,
    params: BuildParams,
    clients: RwLock<Arc<Clients>>,
    token: Option<String>,
    token_file: Option<std::path::PathBuf>,
    basic: Option<(String, String)>,
    exec: Option<ExecAuth>,
    discovery: tokio::sync::Mutex<Option<Arc<Vec<ApiResource>>>>,
    /// context 名稱或 server（顯示用）。
    pub label: String,
    pub server: String,
    /// context 預設 namespace。
    pub default_ns: Option<String>,
    /// 連線設定限定顯示的 namespace（沒權限列 namespace 時也靠它）。
    pub ns_filter: Vec<String>,
}

fn pem_str(b: &Option<Vec<u8>>) -> Option<String> {
    b.as_ref().map(|v| String::from_utf8_lossy(v).into_owned())
}

impl K8sApi {
    pub fn new(cfg: &ConnectionConfig) -> AppResult<Self> {
        let spec = kubeconfig::spec_from_config(cfg)?;
        Self::from_spec(cfg, spec)
    }

    pub fn from_spec(cfg: &ConnectionConfig, spec: ClusterSpec) -> AppResult<Self> {
        let server = opt(cfg, TUNNEL_SERVER).map(str::to_string).unwrap_or_else(|| spec.server.clone());
        let mut target = parse_target(&server, 0, true, (80, 443));
        let tunnel_cfg = if opt(cfg, TUNNEL_ORIGIN_HOST).is_some() {
            // SSH 通道：manager 已把 host / port 改寫成本地轉發埠。
            target.port = cfg.port;
            Some(cfg.clone())
        } else {
            None
        };
        let sni = match (&spec.tls_server_name, tunnel_cfg.is_none()) {
            (Some(name), true) => target.host.parse::<std::net::IpAddr>().ok().map(|ip| {
                let addr = std::net::SocketAddr::new(ip, target.port);
                (name.clone(), addr)
            }),
            _ => None,
        };
        let tls = TlsOpts {
            ca: pem_str(&spec.ca_pem),
            cert: pem_str(&spec.user.client_cert_pem),
            key: pem_str(&spec.user.client_key_pem),
            insecure: spec.insecure,
        };
        let params = BuildParams { target, tls, proxy: spec.proxy_url.clone(), tunnel_cfg, sni };
        let (clients, base) = build_clients(&params, None)?;
        let exec = spec.user.exec.clone().map(|e| {
            ExecAuth::new(
                e,
                spec.user.exec_dir.clone(),
                ClusterInfo {
                    server: spec.server.clone(),
                    ca_pem: spec.ca_pem.clone(),
                    insecure: spec.insecure,
                    tls_server_name: spec.tls_server_name.clone(),
                },
            )
        });
        let ns_filter = kubeconfig::namespace_filter(cfg);
        Ok(K8sApi {
            base,
            params,
            clients: RwLock::new(Arc::new(clients)),
            token: spec.user.token.clone(),
            token_file: spec.user.token_file.clone(),
            basic: spec.user.basic.clone(),
            exec,
            discovery: tokio::sync::Mutex::new(None),
            label: spec.label.clone(),
            server: spec.server.clone(),
            default_ns: opt(cfg, "k8s_default_namespace").map(str::to_string).or(spec.namespace.clone()),
            ns_filter,
        })
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// 認證後的 client + 標頭。`force` = 強制重跑 exec plugin。
    async fn auth(&self, force: bool) -> AppResult<(Arc<Clients>, Option<String>, Option<(String, String)>)> {
        let mut bearer = self.token.clone();
        if let Some(p) = &self.token_file {
            let t = tokio::fs::read_to_string(p)
                .await
                .map_err(|e| AppError::Connect(tf!("讀取 tokenFile 失敗（{path}）：{e}", path = p.display(), e = e)))?;
            bearer = Some(t.trim().to_string());
        }
        if let Some(exec) = &self.exec {
            let cred = exec.get(force).await?;
            if cred.token.is_some() {
                bearer = cred.token.clone();
            }
            if let (Some(c), Some(k)) = (cred.client_cert_pem, cred.client_key_pem) {
                let id = (c, k);
                let current = self.clients.read().clone();
                if current.identity.as_ref() != Some(&id) {
                    let (clients, _) = build_clients(&self.params, Some(id))?;
                    *self.clients.write() = Arc::new(clients);
                }
            }
        }
        let clients = self.clients.read().clone();
        Ok((clients, bearer, self.basic.clone()))
    }

    /// 建請求並送出；401 + exec plugin → 重跑 plugin 再送一次。`f` 補上 query / body / 標頭。
    pub async fn send_with(
        &self,
        method: Method,
        path: &str,
        stream: bool,
        f: impl Fn(RequestBuilder) -> RequestBuilder,
    ) -> AppResult<Response> {
        let mut force = false;
        loop {
            let rb = self.build(method.clone(), path, stream, force).await?;
            let resp = f(rb).send().await.map_err(|e| self.transport_err(e))?;
            if resp.status() == StatusCode::UNAUTHORIZED && self.exec.is_some() && !force {
                force = true;
                continue;
            }
            return check_status(resp).await;
        }
    }

    /// 已帶認證的 RequestBuilder（WebSocket upgrade 用：交給 `ws::connect` 自己送）。
    pub async fn build(&self, method: Method, path: &str, stream: bool, force: bool) -> AppResult<RequestBuilder> {
        let (clients, bearer, basic) = self.auth(force).await?;
        let c = if stream { &clients.stream } else { &clients.client };
        let mut rb = c.request(method, self.url(path));
        if let Some(t) = bearer.filter(|t| !t.is_empty()) {
            rb = rb.header(AUTHORIZATION, format!("Bearer {t}"));
        } else if let Some((u, p)) = basic {
            rb = rb.basic_auth(u, Some(p));
        }
        Ok(rb)
    }

    fn transport_err(&self, e: reqwest::Error) -> AppError {
        match http_err(e) {
            AppError::Connect(m) => AppError::Connect(format!("{} — {m}", self.server)),
            other => other,
        }
    }

    pub async fn get_json(&self, path: &str) -> AppResult<Value> {
        self.send_with(Method::GET, path, false, |rb| rb).await?.json().await.map_err(http_err)
    }

    // ---- 系統 ----

    pub async fn version(&self) -> AppResult<Value> {
        self.get_json("/version").await
    }

    pub async fn ping(&self) -> AppResult<()> {
        self.version().await.map(|_| ())
    }

    /// 可見的 namespace：有設定限定清單就用它；否則列出全部，沒權限（403）退回 context 的 namespace。
    pub async fn namespaces(&self) -> AppResult<Vec<String>> {
        if !self.ns_filter.is_empty() {
            return Ok(self.ns_filter.clone());
        }
        match self.get_json("/api/v1/namespaces").await {
            Ok(v) => {
                let mut out: Vec<String> = items(&v).iter().map(|n| name_of(n)).collect();
                out.sort();
                Ok(out)
            }
            Err(AppError::Query(m)) if m.contains(" 403") => match &self.default_ns {
                Some(ns) => Ok(vec![ns.clone()]),
                None => Err(AppError::Query(tf!(
                    "{m}\n沒有列出 namespace 的權限：請在連線設定的「限定 namespace」填入可存取的 namespace",
                    m = m
                ))),
            },
            Err(e) => Err(e),
        }
    }

    // ---- 資源 ----

    /// 列出某種資源（`ns` = None → 全部 namespace / cluster 範圍）。`metadata_only` 只取 metadata（secret 不把資料拉回來）。
    pub async fn list(&self, res: &ResRef, ns: Option<&str>, metadata_only: bool, q: &[(&str, String)]) -> AppResult<Vec<Value>> {
        let path = res.path(ns, None);
        let v = self
            .send_with(Method::GET, &path, false, |rb| {
                let rb = rb.query(q);
                if metadata_only {
                    rb.header(ACCEPT, META_ACCEPT)
                } else {
                    rb
                }
            })
            .await?
            .json::<Value>()
            .await
            .map_err(http_err)?;
        Ok(items(&v).to_vec())
    }

    /// server-side printing（與 kubectl get 同樣的欄位）。
    pub async fn table(&self, res: &ResRef, ns: Option<&str>, selector: Option<&str>) -> AppResult<K8sTable> {
        let path = res.path(ns, None);
        let mut q: Vec<(&str, String)> = vec![("limit", "2000".into())];
        if let Some(s) = selector.filter(|s| !s.trim().is_empty()) {
            q.push(("labelSelector", s.trim().to_string()));
        }
        let v: Value = self
            .send_with(Method::GET, &path, false, |rb| rb.query(&q).header(ACCEPT, TABLE_ACCEPT))
            .await?
            .json()
            .await
            .map_err(http_err)?;
        Ok(map_table(&v))
    }

    pub async fn get(&self, res: &ResRef, ns: Option<&str>, name: &str) -> AppResult<Value> {
        let mut v = self.get_json(&res.path(ns, Some(name))).await?;
        strip_managed(&mut v);
        Ok(v)
    }

    pub async fn get_yaml(&self, res: &ResRef, ns: Option<&str>, name: &str) -> AppResult<String> {
        let v = self.get(res, ns, name).await?;
        to_yaml(&v)
    }

    /// 以編輯後的 YAML 取代物件（PUT；帶 resourceVersion → 別人先改過會 409）。
    pub async fn replace_yaml(&self, res: &ResRef, ns: Option<&str>, name: &str, yaml: &str, dry_run: bool) -> AppResult<Value> {
        let v: Value = serde_yaml::from_str(yaml).map_err(|e| AppError::Query(tf!("YAML 格式不正確：{e}", e = e)))?;
        let got = v["metadata"]["name"].as_str().unwrap_or_default();
        if got != name {
            return Err(AppError::Query(tf!(
                "metadata.name 不能改（原本是「{name}」，YAML 裡是「{got}」）；要建立新資源請用「套用 YAML」",
                name = name,
                got = got
            )));
        }
        let body = serde_json::to_vec(&v).map_err(|e| AppError::Query(e.to_string()))?;
        let resp = self
            .send_with(Method::PUT, &res.path(ns, Some(name)), false, |rb| {
                let rb = rb.header(CONTENT_TYPE, "application/json").body(body.clone());
                if dry_run {
                    rb.query(&[("dryRun", "All")])
                } else {
                    rb
                }
            })
            .await?;
        let mut out: Value = resp.json().await.map_err(http_err)?;
        strip_managed(&mut out);
        Ok(out)
    }

    /// 刪除。`grace_zero` = 立即刪除（Pod 強制刪除）。
    pub async fn delete(&self, res: &ResRef, ns: Option<&str>, name: &str, grace_zero: bool) -> AppResult<()> {
        let mut body = json!({ "propagationPolicy": "Background" });
        if grace_zero {
            body["gracePeriodSeconds"] = json!(0);
        }
        self.send_with(Method::DELETE, &res.path(ns, Some(name)), false, |rb| rb.json(&body)).await.map(|_| ())
    }

    async fn merge_patch(&self, path: &str, patch: &Value) -> AppResult<Value> {
        let body = patch.to_string();
        let resp = self
            .send_with(Method::PATCH, path, false, |rb| {
                rb.header(CONTENT_TYPE, "application/merge-patch+json").body(body.clone())
            })
            .await?;
        resp.json().await.map_err(http_err)
    }

    pub async fn scale(&self, res: &ResRef, ns: &str, name: &str, replicas: i64) -> AppResult<()> {
        let path = format!("{}/scale", res.path(Some(ns), Some(name)));
        self.merge_patch(&path, &json!({ "spec": { "replicas": replicas.max(0) } })).await.map(|_| ())
    }

    /// rollout restart：改 pod template 的 annotation（與 kubectl 相同的鍵）。
    pub async fn restart(&self, res: &ResRef, ns: &str, name: &str) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let patch = json!({ "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": now
        } } } } });
        self.merge_patch(&res.path(Some(ns), Some(name)), &patch).await.map(|_| ())
    }

    pub async fn set_suspend(&self, ns: &str, name: &str, suspend: bool) -> AppResult<()> {
        let res = ResRef::builtin("cronjobs").unwrap();
        self.merge_patch(&res.path(Some(ns), Some(name)), &json!({ "spec": { "suspend": suspend } })).await.map(|_| ())
    }

    pub async fn set_unschedulable(&self, node: &str, on: bool) -> AppResult<()> {
        let res = ResRef::builtin("nodes").unwrap();
        self.merge_patch(&res.path(None, Some(node)), &json!({ "spec": { "unschedulable": on } })).await.map(|_| ())
    }

    /// 從 CronJob 手動觸發一個 Job（同 `kubectl create job --from=cronjob/x`）。回傳 Job 名稱。
    pub async fn trigger_cronjob(&self, ns: &str, name: &str) -> AppResult<String> {
        let cj = self.get(&ResRef::builtin("cronjobs").unwrap(), Some(ns), name).await?;
        let job = job_from_cronjob(&cj, &random_suffix())?;
        let job_name = job["metadata"]["name"].as_str().unwrap_or_default().to_string();
        let path = ResRef::builtin("jobs").unwrap().path(Some(ns), None);
        self.send_with(Method::POST, &path, false, |rb| rb.json(&job)).await?;
        Ok(job_name)
    }

    /// 套用 YAML（可多份文件、`kind: List`）：server-side apply。`dry_run` = 只驗證不寫入。
    pub async fn apply_yaml(&self, yaml: &str, default_ns: Option<&str>, dry_run: bool, force: bool) -> AppResult<Vec<K8sApplyResult>> {
        let docs = parse_docs(yaml)?;
        if docs.is_empty() {
            return Err(AppError::Query(t!("YAML 裡沒有任何資源").into()));
        }
        let disc = self.discovery().await?;
        let mut out = Vec::new();
        for doc in docs {
            let api_version = doc["apiVersion"].as_str().unwrap_or_default().to_string();
            let kind = doc["kind"].as_str().unwrap_or_default().to_string();
            let name = doc["metadata"]["name"].as_str().unwrap_or_default().to_string();
            let mut r = K8sApplyResult { kind: kind.clone(), name: name.clone(), namespace: String::new(), action: String::new(), error: None };
            if api_version.is_empty() || kind.is_empty() || name.is_empty() {
                r.error = Some(t!("缺少 apiVersion / kind / metadata.name").into());
                out.push(r);
                continue;
            }
            let Some(res) = find_kind(&disc, &api_version, &kind) else {
                r.error = Some(tf!("叢集不認得 {av} {kind}（CRD 尚未安裝？）", av = api_version, kind = kind));
                out.push(r);
                continue;
            };
            let ns = if res.namespaced {
                let ns = doc["metadata"]["namespace"].as_str().map(str::to_string).or(default_ns.map(str::to_string)).or(self.default_ns.clone()).unwrap_or_else(|| "default".into());
                r.namespace = ns.clone();
                Some(ns)
            } else {
                None
            };
            let rref = res.to_ref();
            let path = rref.path(ns.as_deref(), Some(&name));
            let body = doc.to_string();
            let mut q: Vec<(&str, String)> = vec![("fieldManager", FIELD_MANAGER.into())];
            if force {
                q.push(("force", "true".into()));
            }
            if dry_run {
                q.push(("dryRun", "All".into()));
            }
            let sent = self
                .send_with(Method::PATCH, &path, false, |rb| {
                    rb.query(&q).header(CONTENT_TYPE, "application/apply-patch+yaml").body(body.clone())
                })
                .await;
            match sent {
                Ok(resp) => {
                    r.action = if resp.status() == StatusCode::CREATED { "created" } else { "configured" }.into();
                }
                Err(e) => r.error = Some(e.message()),
            }
            out.push(r);
        }
        Ok(out)
    }

    // ---- discovery ----

    /// 叢集支援的所有資源種類（含 CRD）。快取到連線結束；`refresh` 重抓。
    pub async fn discovery(&self) -> AppResult<Arc<Vec<ApiResource>>> {
        self.discovery_opt(false).await
    }

    pub async fn discovery_opt(&self, refresh: bool) -> AppResult<Arc<Vec<ApiResource>>> {
        let mut cache = self.discovery.lock().await;
        if !refresh {
            if let Some(d) = cache.as_ref() {
                return Ok(d.clone());
            }
        }
        let mut out: Vec<ApiResource> = Vec::new();
        let core = self.get_json("/api/v1").await?;
        out.extend(map_resource_list(&core, "", "v1"));
        let groups = self.get_json("/apis").await?;
        let gvs: Vec<(String, String)> = arr(&groups, "groups")
            .iter()
            .filter_map(|g| {
                let name = g["name"].as_str()?.to_string();
                let ver = g["preferredVersion"]["version"].as_str()?.to_string();
                Some((name, ver))
            })
            .collect();
        let fetched = join_all(gvs.iter().map(|(g, v)| async move {
            (g.clone(), v.clone(), self.get_json(&format!("/apis/{g}/{v}")).await)
        }))
        .await;
        for (g, v, r) in fetched {
            // 個別 group 失敗（例如 metrics-server 掛了的 aggregated API）不影響其他。
            if let Ok(list) = r {
                out.extend(map_resource_list(&list, &g, &v));
            }
        }
        out.sort_by(|a, b| (a.group.as_str(), a.plural.as_str()).cmp(&(b.group.as_str(), b.plural.as_str())));
        let arc = Arc::new(out);
        *cache = Some(arc.clone());
        Ok(arc)
    }

    // ---- 事件 / 指標 ----

    /// 事件（新的在前）。`object` = (kind, name) 只看某個物件；`ns` None = 全部 namespace。
    pub async fn events(&self, ns: Option<&str>, object: Option<(&str, &str)>, warnings_only: bool) -> AppResult<Vec<K8sEvent>> {
        let res = ResRef::builtin("events").unwrap();
        let mut fs: Vec<String> = Vec::new();
        if let Some((kind, name)) = object {
            fs.push(format!("involvedObject.kind={kind}"));
            fs.push(format!("involvedObject.name={name}"));
        }
        if warnings_only {
            fs.push("type=Warning".into());
        }
        let mut q: Vec<(&str, String)> = vec![("limit", "500".into())];
        if !fs.is_empty() {
            q.push(("fieldSelector", fs.join(",")));
        }
        let list = self.list(&res, ns, false, &q).await?;
        let mut out: Vec<K8sEvent> = list.iter().map(map_event).collect();
        out.sort_by(|a, b| b.last.cmp(&a.last));
        Ok(out)
    }

    /// Pod 指標（metrics-server）。沒裝 metrics-server → Ok(None)。
    pub async fn pod_metrics(&self, ns: Option<&str>, name: Option<&str>) -> AppResult<Option<Vec<K8sPodMetrics>>> {
        let path = match (ns, name) {
            (Some(ns), Some(n)) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{}/pods/{}", seg(ns), seg(n)),
            (Some(ns), None) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{}/pods", seg(ns)),
            _ => "/apis/metrics.k8s.io/v1beta1/pods".to_string(),
        };
        let v = match self.get_json(&path).await {
            Ok(v) => v,
            Err(AppError::Query(m)) if metrics_missing(&m) => return Ok(None),
            Err(e) => return Err(e),
        };
        let list: Vec<Value> = if name.is_some() { vec![v] } else { items(&v).to_vec() };
        Ok(Some(list.iter().map(map_pod_metrics).collect()))
    }

    pub async fn node_metrics(&self) -> AppResult<Option<Vec<K8sNodeMetrics>>> {
        let v = match self.get_json("/apis/metrics.k8s.io/v1beta1/nodes").await {
            Ok(v) => v,
            Err(AppError::Query(m)) if metrics_missing(&m) => return Ok(None),
            Err(e) => return Err(e),
        };
        Ok(Some(
            items(&v)
                .iter()
                .map(|n| K8sNodeMetrics {
                    name: name_of(n),
                    cpu_milli: parse_cpu(n["usage"]["cpu"].as_str().unwrap_or("0")),
                    memory_bytes: parse_mem(n["usage"]["memory"].as_str().unwrap_or("0")),
                })
                .collect(),
        ))
    }

    /// Secret 解碼後的值（前端預設遮罩，點了才要）。
    pub async fn secret_data(&self, ns: &str, name: &str) -> AppResult<BTreeMap<String, String>> {
        let v = self.get(&ResRef::builtin("secrets").unwrap(), Some(ns), name).await?;
        Ok(decode_secret(&v))
    }

    /// Pod 各容器的環境變數實際值（`value`、`valueFrom` 的 secretKeyRef / configMapKeyRef、`envFrom`）。
    /// 給「建立資料庫連線」預填帳密用；讀不到（沒權限）的來源略過。
    pub async fn pod_env(&self, ns: &str, pod: &str) -> AppResult<Vec<K8sEnvVar>> {
        let p = self.pod(ns, pod).await?;
        let mut cache: BTreeMap<(bool, String), Option<BTreeMap<String, String>>> = BTreeMap::new();
        let mut out = Vec::new();
        for c in arr(&p["spec"], "containers") {
            let cname = s(c, "name");
            for from in arr(c, "envFrom") {
                let prefix = from["prefix"].as_str().unwrap_or_default();
                let (is_secret, name) = if let Some(n) = from["secretRef"]["name"].as_str() {
                    (true, n)
                } else if let Some(n) = from["configMapRef"]["name"].as_str() {
                    (false, n)
                } else {
                    continue;
                };
                if let Some(map) = self.env_source(ns, is_secret, name, &mut cache).await {
                    for (k, v) in map {
                        out.push(K8sEnvVar { container: cname.clone(), name: format!("{prefix}{k}"), value: v, secret: is_secret });
                    }
                }
            }
            for e in arr(c, "env") {
                let name = s(e, "name");
                if let Some(v) = e["value"].as_str() {
                    out.push(K8sEnvVar { container: cname.clone(), name, value: v.to_string(), secret: false });
                    continue;
                }
                let vf = &e["valueFrom"];
                let (is_secret, r) = if vf["secretKeyRef"].is_object() {
                    (true, &vf["secretKeyRef"])
                } else if vf["configMapKeyRef"].is_object() {
                    (false, &vf["configMapKeyRef"])
                } else {
                    continue;
                };
                let (Some(src), Some(key)) = (r["name"].as_str(), r["key"].as_str()) else { continue };
                if let Some(map) = self.env_source(ns, is_secret, src, &mut cache).await {
                    if let Some(v) = map.get(key) {
                        out.push(K8sEnvVar { container: cname.clone(), name, value: v.clone(), secret: is_secret });
                    }
                }
            }
        }
        Ok(out)
    }

    async fn env_source(
        &self,
        ns: &str,
        is_secret: bool,
        name: &str,
        cache: &mut BTreeMap<(bool, String), Option<BTreeMap<String, String>>>,
    ) -> Option<BTreeMap<String, String>> {
        let key = (is_secret, name.to_string());
        if let Some(v) = cache.get(&key) {
            return v.clone();
        }
        let v = if is_secret {
            self.secret_data(ns, name).await.ok()
        } else {
            self.get(&ResRef::builtin("configmaps").unwrap(), Some(ns), name).await.ok().map(|cm| {
                cm["data"]
                    .as_object()
                    .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
                    .unwrap_or_default()
            })
        };
        cache.insert(key, v.clone());
        v
    }

    // ---- 叢集總覽 ----

    pub async fn overview(&self) -> AppResult<K8sOverview> {
        let ver = self.version().await?;
        let nodes_res = ResRef::builtin("nodes").unwrap();
        let pods_res = ResRef::builtin("pods").unwrap();
        let (nodes, ns, pods, metrics, warnings) = futures::join!(
            self.list(&nodes_res, None, false, &[]),
            self.namespaces(),
            self.list(&pods_res, None, false, &[]),
            self.node_metrics(),
            self.events(None, None, true),
        );
        let metrics = metrics.unwrap_or(None);
        let mut o = K8sOverview {
            label: self.label.clone(),
            server: self.server.clone(),
            version: s(&ver, "gitVersion"),
            platform: s(&ver, "platform"),
            namespaces: ns.map(|v| v.len() as i64).unwrap_or(-1),
            metrics_available: metrics.is_some(),
            ..Default::default()
        };
        match nodes {
            Ok(list) => {
                o.nodes = list.iter().map(|n| map_node(n, metrics.as_deref())).collect();
            }
            Err(e) => o.errors.push(e.message()),
        }
        match pods {
            Ok(list) => {
                for p in &list {
                    let phase = p["status"]["phase"].as_str().unwrap_or("Unknown").to_string();
                    *o.pod_phases.entry(phase).or_insert(0) += 1;
                }
                o.pods = list.len() as i64;
                let mut per_node: BTreeMap<String, i64> = BTreeMap::new();
                for p in &list {
                    if let Some(n) = p["spec"]["nodeName"].as_str() {
                        *per_node.entry(n.to_string()).or_insert(0) += 1;
                    }
                }
                for n in &mut o.nodes {
                    n.pods = per_node.get(&n.name).copied().unwrap_or(0);
                }
            }
            Err(e) => {
                o.pods = -1;
                o.errors.push(e.message());
            }
        }
        if let Ok(ev) = warnings {
            o.warnings = ev.into_iter().take(50).collect();
        }
        Ok(o)
    }

    // ---- 連線樹 ----

    /// namespace 下（或 cluster 範圍）的樹狀節點：`種類複數/名稱` + 狀態 kind。
    pub async fn tree(&self, ns: Option<&str>) -> AppResult<Vec<crate::db::TableInfo>> {
        let kinds: &[&str] = match ns {
            Some(_) => &TREE_KINDS,
            None => &CLUSTER_TREE_KINDS,
        };
        let fetched = join_all(kinds.iter().map(|plural| async move {
            let res = ResRef::builtin(plural).unwrap();
            let meta_only = matches!(*plural, "configmaps" | "secrets" | "serviceaccounts" | "storageclasses" | "customresourcedefinitions");
            (*plural, self.list(&res, ns, meta_only, &[("limit", "1000".into())]).await)
        }))
        .await;
        let mut out = Vec::new();
        let mut first_err: Option<AppError> = None;
        let mut ok_any = false;
        for (plural, r) in fetched {
            match r {
                Ok(list) => {
                    ok_any = true;
                    let mut entries: Vec<(String, String)> =
                        list.iter().map(|o| (name_of(o), tree_state(plural, o))).collect();
                    entries.sort_by(|a, b| crate::store::natural_label_cmp(&a.0, &b.0));
                    for (name, state) in entries {
                        out.push(crate::db::TableInfo { name: format!("{plural}/{name}"), kind: format!("k8s:{plural}:{state}") });
                    }
                }
                // 沒權限的種類靜默略過（RBAC 常只開部分資源）；全部失敗才報錯。
                Err(e) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
            }
        }
        match (ok_any, first_err) {
            (false, Some(e)) => Err(e),
            _ => Ok(out),
        }
    }

    /// 某個 Pod 的容器名稱（log / shell 下拉）與預設容器（`kubectl.kubernetes.io/default-container`）。
    pub async fn pod(&self, ns: &str, name: &str) -> AppResult<Value> {
        self.get(&ResRef::builtin("pods").unwrap(), Some(ns), name).await
    }

    // ---- 串流端點 ----

    pub async fn logs(&self, ns: &str, pod: &str, opts: &LogOptions) -> AppResult<Response> {
        let path = format!("/api/v1/namespaces/{}/pods/{}/log", seg(ns), seg(pod));
        let mut q: Vec<(&str, String)> = vec![("follow", opts.follow.to_string()), ("timestamps", opts.timestamps.to_string())];
        if !opts.container.is_empty() {
            q.push(("container", opts.container.clone()));
        }
        if opts.tail > 0 {
            q.push(("tailLines", opts.tail.to_string()));
        }
        if opts.previous {
            q.push(("previous", "true".into()));
        }
        if opts.since_seconds > 0 {
            q.push(("sinceSeconds", opts.since_seconds.to_string()));
        }
        self.send_with(Method::GET, &path, true, |rb| rb.query(&q)).await
    }

    /// exec 的 WebSocket 請求（未送出）。
    pub async fn exec_request(&self, ns: &str, pod: &str, container: &str, cmd: &[String], tty: bool) -> AppResult<RequestBuilder> {
        let path = format!("/api/v1/namespaces/{}/pods/{}/exec", seg(ns), seg(pod));
        let mut q: Vec<(&str, String)> = vec![
            ("stdin", "true".into()),
            ("stdout", "true".into()),
            ("stderr", (!tty).to_string()),
            ("tty", tty.to_string()),
        ];
        if !container.is_empty() {
            q.push(("container", container.to_string()));
        }
        for c in cmd {
            q.push(("command", c.clone()));
        }
        Ok(self.build(Method::GET, &path, true, false).await?.query(&q))
    }

    /// port-forward 的 WebSocket 請求（未送出）。
    pub async fn portforward_request(&self, ns: &str, pod: &str, port: u16, force: bool) -> AppResult<RequestBuilder> {
        let path = format!("/api/v1/namespaces/{}/pods/{}/portforward", seg(ns), seg(pod));
        Ok(self.build(Method::GET, &path, true, force).await?.query(&[("ports", port.to_string())]))
    }

    pub fn has_exec_plugin(&self) -> bool {
        self.exec.is_some()
    }

    /// 解析轉發目標：`pod/x` 直接用；`svc/x`（或 `service/x`）依 selector 挑一個 Ready 的 Pod，
    /// 並把 service port 換成該 Pod 的容器埠（targetPort 可為數字或名稱）；`deploy/x`、`sts/x` 用 workload 的 selector。
    pub async fn resolve_forward(&self, ns: &str, target: &str, port: u16) -> AppResult<(String, u16)> {
        let (kind, name) = target.split_once('/').unwrap_or(("pod", target));
        let kind = kind.to_ascii_lowercase();
        match kind.as_str() {
            "pod" | "pods" | "po" => Ok((name.to_string(), port)),
            "svc" | "service" | "services" => {
                let svc = self.get(&ResRef::builtin("services").unwrap(), Some(ns), name).await?;
                let sp = arr(&svc["spec"], "ports")
                    .iter()
                    .find(|p| p["port"].as_i64() == Some(port as i64))
                    .or_else(|| (port == 0).then(|| arr(&svc["spec"], "ports").first()).flatten())
                    .cloned()
                    .ok_or_else(|| AppError::Query(tf!("Service「{name}」沒有埠 {port}", name = name, port = port)))?;
                let selector = label_selector(&svc["spec"]["selector"]);
                if selector.is_empty() {
                    return Err(AppError::Query(tf!("Service「{name}」沒有 selector，無法找到後端 Pod", name = name)));
                }
                let pod = self.pick_pod(ns, &selector, name).await?;
                let tp = &sp["targetPort"];
                let container_port = match (tp.as_i64(), tp.as_str()) {
                    (Some(n), _) => n as u16,
                    (None, Some(named)) => named_port(&pod, named).ok_or_else(|| {
                        AppError::Query(tf!("Pod「{pod}」沒有名為「{p}」的容器埠", pod = name_of(&pod), p = named))
                    })?,
                    _ => sp["port"].as_i64().unwrap_or(port as i64) as u16,
                };
                Ok((name_of(&pod), container_port))
            }
            "deploy" | "deployment" | "deployments" | "sts" | "statefulset" | "statefulsets" | "ds" | "daemonset" | "daemonsets" => {
                let plural = match kind.as_str() {
                    "deploy" | "deployment" | "deployments" => "deployments",
                    "sts" | "statefulset" | "statefulsets" => "statefulsets",
                    _ => "daemonsets",
                };
                let w = self.get(&ResRef::builtin(plural).unwrap(), Some(ns), name).await?;
                let selector = label_selector(&w["spec"]["selector"]["matchLabels"]);
                let pod = self.pick_pod(ns, &selector, name).await?;
                Ok((name_of(&pod), port))
            }
            other => Err(AppError::Query(tf!("不支援的轉發目標種類：{k}（可用 pod / svc / deploy / sts）", k = other))),
        }
    }

    async fn pick_pod(&self, ns: &str, selector: &str, owner: &str) -> AppResult<Value> {
        let pods = self.list(&ResRef::builtin("pods").unwrap(), Some(ns), false, &[("labelSelector", selector.to_string())]).await?;
        pick_ready_pod(&pods).ok_or_else(|| AppError::Query(tf!("「{name}」目前沒有執行中的 Pod", name = owner)))
    }
}

fn build_clients(p: &BuildParams, identity: Option<(String, String)>) -> AppResult<(Clients, String)> {
    let mut tls = p.tls.clone();
    if let Some((c, k)) = &identity {
        tls.cert = Some(c.clone());
        tls.key = Some(k.clone());
    }
    let one = |timeout: Option<Duration>, http1: bool| -> AppResult<(Client, String)> {
        let mut b = client_builder(&tls, timeout)?;
        if http1 {
            b = b.http1_only();
        }
        if let Some(px) = &p.proxy {
            let proxy = reqwest::Proxy::all(px.as_str()).map_err(|e| AppError::Connect(tf!("proxy-url 不正確：{e}", e = e)))?;
            b = b.proxy(proxy);
        }
        let mut target = p.target.clone();
        if let Some(cfg) = &p.tunnel_cfg {
            let (t, nb) = apply_tunnel(cfg, target, b);
            target = t;
            b = nb;
        } else if let Some((name, addr)) = &p.sni {
            b = b.resolve(name, *addr);
            target.host = name.clone();
        }
        Ok((b.build().map_err(http_err)?, target.base_url()))
    };
    let (client, base) = one(Some(Duration::from_secs(30)), false)?;
    let (stream, _) = one(None, true)?;
    Ok((Clients { client, stream, identity }, base))
}

/// 非 2xx → AppError（取 Status.message）。
pub async fn check_status(resp: Response) -> AppResult<Response> {
    let st = resp.status();
    if st.is_success() || st == StatusCode::SWITCHING_PROTOCOLS {
        return Ok(resp);
    }
    Err(status_error(resp).await)
}

pub async fn status_error(resp: Response) -> AppError {
    let code = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_string))
        .unwrap_or(body);
    let hint = match code {
        401 => t!("（認證失敗：token 過期或無效？）"),
        _ => "",
    };
    AppError::Query(format!("Kubernetes {code}：{}{hint}", msg.trim()))
}

fn metrics_missing(m: &str) -> bool {
    m.contains(" 404") || m.contains(" 503") || m.contains("the server could not find the requested resource")
}

// ---- 資源參照 ----

impl ResRef {
    /// 內建資源（連線樹 / 常用動作）。
    pub fn builtin(plural: &str) -> Option<ResRef> {
        let (group, version, kind, namespaced) = match plural {
            "pods" => ("", "v1", "Pod", true),
            "services" => ("", "v1", "Service", true),
            "configmaps" => ("", "v1", "ConfigMap", true),
            "secrets" => ("", "v1", "Secret", true),
            "persistentvolumeclaims" => ("", "v1", "PersistentVolumeClaim", true),
            "serviceaccounts" => ("", "v1", "ServiceAccount", true),
            "events" => ("", "v1", "Event", true),
            "endpoints" => ("", "v1", "Endpoints", true),
            "nodes" => ("", "v1", "Node", false),
            "namespaces" => ("", "v1", "Namespace", false),
            "persistentvolumes" => ("", "v1", "PersistentVolume", false),
            "deployments" => ("apps", "v1", "Deployment", true),
            "statefulsets" => ("apps", "v1", "StatefulSet", true),
            "daemonsets" => ("apps", "v1", "DaemonSet", true),
            "replicasets" => ("apps", "v1", "ReplicaSet", true),
            "jobs" => ("batch", "v1", "Job", true),
            "cronjobs" => ("batch", "v1", "CronJob", true),
            "ingresses" => ("networking.k8s.io", "v1", "Ingress", true),
            "horizontalpodautoscalers" => ("autoscaling", "v2", "HorizontalPodAutoscaler", true),
            "storageclasses" => ("storage.k8s.io", "v1", "StorageClass", false),
            "customresourcedefinitions" => ("apiextensions.k8s.io", "v1", "CustomResourceDefinition", false),
            _ => return None,
        };
        Some(ResRef { group: group.into(), version: version.into(), plural: plural.into(), kind: kind.into(), namespaced })
    }

    /// REST 路徑。cluster 範圍的資源忽略 `ns`。
    pub fn path(&self, ns: Option<&str>, name: Option<&str>) -> String {
        let mut p = if self.group.is_empty() {
            format!("/api/{}", self.version)
        } else {
            format!("/apis/{}/{}", self.group, self.version)
        };
        if self.namespaced {
            if let Some(ns) = ns.filter(|s| !s.is_empty()) {
                p.push_str(&format!("/namespaces/{}", seg(ns)));
            }
        }
        p.push('/');
        p.push_str(&self.plural);
        if let Some(n) = name {
            p.push('/');
            p.push_str(&seg(n));
        }
        p
    }
}

impl ApiResource {
    pub fn to_ref(&self) -> ResRef {
        ResRef {
            group: self.group.clone(),
            version: self.version.clone(),
            plural: self.plural.clone(),
            kind: self.kind.clone(),
            namespaced: self.namespaced,
        }
    }
}

/// 連線樹每個 namespace 下列出的種類（順序即顯示順序）。
pub const TREE_KINDS: [&str; 12] = [
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "jobs",
    "cronjobs",
    "services",
    "ingresses",
    "configmaps",
    "secrets",
    "persistentvolumeclaims",
    "horizontalpodautoscalers",
];

/// 「叢集」節點下的種類。
pub const CLUSTER_TREE_KINDS: [&str; 4] = ["nodes", "persistentvolumes", "storageclasses", "customresourcedefinitions"];

fn find_kind<'a>(disc: &'a [ApiResource], api_version: &str, kind: &str) -> Option<&'a ApiResource> {
    let (group, version) = match api_version.split_once('/') {
        Some((g, v)) => (g, v),
        None => ("", api_version),
    };
    disc.iter()
        .find(|r| r.group == group && r.version == version && r.kind == kind)
        // preferred version 以外的版本（例如 autoscaling/v1）：同 group + kind 也可以，路徑用文件裡的版本。
        .or_else(|| disc.iter().find(|r| r.group == group && r.kind == kind))
}

// ---- JSON 輔助 ----

/// URL 路徑片段編碼（資源名稱只會有 [a-z0-9.-]，但使用者輸入仍保險起見編碼）。
pub fn seg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b':' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn items(v: &Value) -> &[Value] {
    v["items"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v[k].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_string()
}

pub fn name_of(v: &Value) -> String {
    v["metadata"]["name"].as_str().unwrap_or_default().to_string()
}

pub fn strip_managed(v: &mut Value) {
    if let Some(m) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        m.remove("managedFields");
    }
}

pub fn to_yaml(v: &Value) -> AppResult<String> {
    serde_yaml::to_string(v).map_err(|e| AppError::Query(e.to_string()))
}

/// 多文件 YAML → 物件清單（`kind: List` 展開、空文件略過）。
pub fn parse_docs(text: &str) -> AppResult<Vec<Value>> {
    use serde::Deserialize as _;
    let mut out = Vec::new();
    for (i, doc) in serde_yaml::Deserializer::from_str(text).enumerate() {
        let v = Value::deserialize(doc).map_err(|e| AppError::Query(tf!("第 {n} 份文件的 YAML 格式不正確：{e}", n = i + 1, e = e)))?;
        match &v {
            Value::Null => {}
            Value::Object(_) if v["kind"].as_str().is_some_and(|k| k == "List" || k.ends_with("List")) && v["items"].is_array() => {
                out.extend(items(&v).iter().cloned());
            }
            Value::Object(_) => out.push(v),
            _ => return Err(AppError::Query(tf!("第 {n} 份文件不是物件", n = i + 1))),
        }
    }
    Ok(out)
}

fn label_selector(m: &Value) -> String {
    m.as_object()
        .map(|o| o.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default())).collect::<Vec<_>>().join(","))
        .unwrap_or_default()
}

fn pod_ready(p: &Value) -> bool {
    arr(&p["status"], "conditions").iter().any(|c| c["type"] == "Ready" && c["status"] == "True")
}

/// 挑轉發用的 Pod：Running + Ready 優先，其次 Running；略過正在刪除的。
pub fn pick_ready_pod(pods: &[Value]) -> Option<Value> {
    let alive = |p: &&Value| p["metadata"]["deletionTimestamp"].is_null() && p["status"]["phase"] == "Running";
    pods.iter().filter(alive).find(|p| pod_ready(p)).or_else(|| pods.iter().find(alive)).cloned()
}

fn named_port(pod: &Value, name: &str) -> Option<u16> {
    arr(&pod["spec"], "containers")
        .iter()
        .flat_map(|c| arr(c, "ports").iter())
        .find(|p| p["name"].as_str() == Some(name))
        .and_then(|p| p["containerPort"].as_i64())
        .map(|p| p as u16)
}

/// 樹狀節點的狀態字串（前端依此上色）。
pub fn tree_state(plural: &str, o: &Value) -> String {
    let st = &o["status"];
    let spec = &o["spec"];
    if !o["metadata"]["deletionTimestamp"].is_null() {
        return "terminating".into();
    }
    match plural {
        "pods" => {
            let phase = st["phase"].as_str().unwrap_or("Unknown");
            let waiting_bad = arr(st, "containerStatuses").iter().any(|c| {
                matches!(
                    c["state"]["waiting"]["reason"].as_str(),
                    Some("CrashLoopBackOff" | "ImagePullBackOff" | "ErrImagePull" | "CreateContainerConfigError" | "InvalidImageName")
                )
            });
            if waiting_bad {
                "error".into()
            } else if phase == "Running" && !pod_ready(o) {
                "notready".into()
            } else {
                phase.to_ascii_lowercase()
            }
        }
        "deployments" | "statefulsets" => {
            let want = spec["replicas"].as_i64().unwrap_or(1);
            let ready = st["readyReplicas"].as_i64().unwrap_or(0);
            if want == 0 {
                "zero".into()
            } else if ready >= want {
                "ok".into()
            } else {
                "warn".into()
            }
        }
        "daemonsets" => {
            let want = st["desiredNumberScheduled"].as_i64().unwrap_or(0);
            let ready = st["numberReady"].as_i64().unwrap_or(0);
            if want == 0 {
                "zero".into()
            } else if ready >= want {
                "ok".into()
            } else {
                "warn".into()
            }
        }
        "jobs" => {
            if arr(st, "conditions").iter().any(|c| c["type"] == "Failed" && c["status"] == "True") {
                "failed".into()
            } else if arr(st, "conditions").iter().any(|c| c["type"] == "Complete" && c["status"] == "True") {
                "complete".into()
            } else {
                "running".into()
            }
        }
        "cronjobs" => if spec["suspend"].as_bool() == Some(true) { "suspended" } else { "active" }.into(),
        "nodes" => {
            let ready = arr(st, "conditions").iter().any(|c| c["type"] == "Ready" && c["status"] == "True");
            match (ready, spec["unschedulable"].as_bool() == Some(true)) {
                (true, true) => "cordoned".into(),
                (true, false) => "ready".into(),
                _ => "notready".into(),
            }
        }
        "persistentvolumeclaims" | "persistentvolumes" => st["phase"].as_str().unwrap_or("").to_ascii_lowercase(),
        "services" => spec["type"].as_str().unwrap_or("").to_ascii_lowercase(),
        "secrets" => o["type"].as_str().unwrap_or("").to_string(),
        _ => String::new(),
    }
}

fn map_table(v: &Value) -> K8sTable {
    let columns: Vec<K8sTableColumn> = arr(v, "columnDefinitions")
        .iter()
        .map(|c| K8sTableColumn {
            name: s(c, "name"),
            kind: s(c, "type"),
            priority: c["priority"].as_i64().unwrap_or(0),
            description: s(c, "description"),
        })
        .collect();
    let rows = arr(v, "rows")
        .iter()
        .map(|r| {
            let meta = &r["object"]["metadata"];
            K8sTableRow {
                name: meta["name"].as_str().unwrap_or_default().to_string(),
                namespace: meta["namespace"].as_str().unwrap_or_default().to_string(),
                cells: arr(r, "cells").to_vec(),
            }
        })
        .collect();
    K8sTable { columns, rows }
}

fn map_resource_list(v: &Value, group: &str, version: &str) -> Vec<ApiResource> {
    arr(v, "resources")
        .iter()
        .filter(|r| !r["name"].as_str().unwrap_or("").contains('/')) // 子資源（pods/log、deployments/scale）
        .map(|r| ApiResource {
            group: group.to_string(),
            version: version.to_string(),
            plural: s(r, "name"),
            kind: s(r, "kind"),
            namespaced: r["namespaced"].as_bool().unwrap_or(false),
            verbs: arr(r, "verbs").iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
            short_names: arr(r, "shortNames").iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        })
        .collect()
}

fn map_event(e: &Value) -> K8sEvent {
    let io = &e["involvedObject"];
    let last = e["lastTimestamp"]
        .as_str()
        .or_else(|| e["eventTime"].as_str())
        .or_else(|| e["metadata"]["creationTimestamp"].as_str())
        .unwrap_or_default()
        .to_string();
    K8sEvent {
        namespace: e["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        kind: s(e, "type"),
        reason: s(e, "reason"),
        message: s(e, "message"),
        count: e["count"].as_i64().unwrap_or(1),
        first: e["firstTimestamp"].as_str().unwrap_or(&last).to_string(),
        last,
        object_kind: s(io, "kind"),
        object_name: s(io, "name"),
        source: e["source"]["component"].as_str().or_else(|| e["reportingComponent"].as_str()).unwrap_or_default().to_string(),
    }
}

fn map_pod_metrics(m: &Value) -> K8sPodMetrics {
    let containers: Vec<K8sContainerMetrics> = arr(m, "containers")
        .iter()
        .map(|c| K8sContainerMetrics {
            name: s(c, "name"),
            cpu_milli: parse_cpu(c["usage"]["cpu"].as_str().unwrap_or("0")),
            memory_bytes: parse_mem(c["usage"]["memory"].as_str().unwrap_or("0")),
        })
        .collect();
    K8sPodMetrics {
        namespace: m["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        name: name_of(m),
        cpu_milli: containers.iter().map(|c| c.cpu_milli).sum(),
        memory_bytes: containers.iter().map(|c| c.memory_bytes).sum(),
        containers,
    }
}

fn map_node(n: &Value, metrics: Option<&[K8sNodeMetrics]>) -> K8sNode {
    let st = &n["status"];
    let name = name_of(n);
    let m = metrics.and_then(|ms| ms.iter().find(|x| x.name == name));
    let roles: Vec<String> = n["metadata"]["labels"]
        .as_object()
        .map(|o| {
            o.keys()
                .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/").map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    K8sNode {
        state: tree_state("nodes", n),
        roles,
        version: st["nodeInfo"]["kubeletVersion"].as_str().unwrap_or_default().to_string(),
        os_image: st["nodeInfo"]["osImage"].as_str().unwrap_or_default().to_string(),
        arch: st["nodeInfo"]["architecture"].as_str().unwrap_or_default().to_string(),
        internal_ip: arr(st, "addresses")
            .iter()
            .find(|a| a["type"] == "InternalIP")
            .and_then(|a| a["address"].as_str())
            .unwrap_or_default()
            .to_string(),
        cpu_capacity_milli: parse_cpu(st["allocatable"]["cpu"].as_str().unwrap_or("0")),
        memory_capacity_bytes: parse_mem(st["allocatable"]["memory"].as_str().unwrap_or("0")),
        cpu_usage_milli: m.map(|x| x.cpu_milli),
        memory_usage_bytes: m.map(|x| x.memory_bytes),
        created: n["metadata"]["creationTimestamp"].as_str().unwrap_or_default().to_string(),
        pods: 0,
        name,
    }
}

/// CPU quantity → millicores（`250m`、`2`、`1500000n`、`12u`）。
pub fn parse_cpu(q: &str) -> f64 {
    let q = q.trim();
    let (num, mul) = if let Some(n) = q.strip_suffix('n') {
        (n, 1e-6)
    } else if let Some(n) = q.strip_suffix('u') {
        (n, 1e-3)
    } else if let Some(n) = q.strip_suffix('m') {
        (n, 1.0)
    } else {
        (q, 1000.0)
    };
    num.parse::<f64>().map(|v| v * mul).unwrap_or(0.0)
}

/// 記憶體 quantity → bytes（`128Mi`、`1G`、`123456Ki`、`1e3`）。
pub fn parse_mem(q: &str) -> i64 {
    let q = q.trim();
    const UNITS: [(&str, f64); 12] = [
        ("Ki", 1024.0),
        ("Mi", 1048576.0),
        ("Gi", 1073741824.0),
        ("Ti", 1099511627776.0),
        ("Pi", 1125899906842624.0),
        ("Ei", 1152921504606846976.0),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];
    for (u, m) in UNITS {
        if let Some(n) = q.strip_suffix(u) {
            return n.parse::<f64>().map(|v| (v * m) as i64).unwrap_or(0);
        }
    }
    if let Some(n) = q.strip_suffix('m') {
        return n.parse::<f64>().map(|v| (v / 1000.0) as i64).unwrap_or(0);
    }
    q.parse::<f64>().map(|v| v as i64).unwrap_or(0)
}

/// Secret 的 data（base64）+ stringData 解碼成字串（非 UTF-8 的值以 `base64:` 前綴原樣保留）。
pub fn decode_secret(v: &Value) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(o) = v["data"].as_object() {
        for (k, val) in o {
            let raw = val.as_str().unwrap_or_default();
            let text = match base64::engine::general_purpose::STANDARD.decode(raw) {
                Ok(b) => String::from_utf8(b).unwrap_or_else(|_| format!("base64:{raw}")),
                Err(_) => raw.to_string(),
            };
            out.insert(k.clone(), text);
        }
    }
    if let Some(o) = v["stringData"].as_object() {
        for (k, val) in o {
            out.insert(k.clone(), val.as_str().unwrap_or_default().to_string());
        }
    }
    out
}

fn random_suffix() -> String {
    const CH: &[u8] = b"bcdfghjklmnpqrstvwxz2456789";
    (0..5).map(|_| CH[rand::random::<usize>() % CH.len()] as char).collect()
}

/// CronJob → 手動 Job 物件（名稱 `<cronjob>-manual-<suffix>`，最長 63 字元）。
pub fn job_from_cronjob(cj: &Value, suffix: &str) -> AppResult<Value> {
    let name = name_of(cj);
    let tpl = &cj["spec"]["jobTemplate"];
    if tpl.is_null() {
        return Err(AppError::Query(t!("CronJob 沒有 jobTemplate").into()));
    }
    let base: String = name.chars().take(63 - "-manual-".len() - suffix.len()).collect();
    let mut annotations = tpl["metadata"]["annotations"].as_object().cloned().unwrap_or_default();
    annotations.insert("cronjob.kubernetes.io/instantiate".into(), json!("manual"));
    Ok(json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": format!("{}-manual-{suffix}", base.trim_end_matches('-')),
            "namespace": cj["metadata"]["namespace"],
            "labels": tpl["metadata"]["labels"].as_object().cloned().unwrap_or_default(),
            "annotations": annotations,
            "ownerReferences": [{
                "apiVersion": "batch/v1",
                "kind": "CronJob",
                "name": name,
                "uid": cj["metadata"]["uid"],
                "controller": true,
                "blockOwnerDeletion": true,
            }],
        },
        "spec": tpl["spec"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn res_paths() {
        let p = ResRef::builtin("pods").unwrap();
        assert_eq!(p.path(Some("demo"), Some("a")), "/api/v1/namespaces/demo/pods/a");
        assert_eq!(p.path(None, None), "/api/v1/pods");
        let d = ResRef::builtin("deployments").unwrap();
        assert_eq!(d.path(Some("x"), None), "/apis/apps/v1/namespaces/x/deployments");
        let n = ResRef::builtin("nodes").unwrap();
        assert_eq!(n.path(Some("ignored"), Some("n1")), "/api/v1/nodes/n1");
        assert!(ResRef::builtin("nope").is_none());
        for k in TREE_KINDS.iter().chain(CLUSTER_TREE_KINDS.iter()) {
            assert!(ResRef::builtin(k).is_some(), "{k}");
        }
    }

    #[test]
    fn quantities() {
        assert_eq!(parse_cpu("250m"), 250.0);
        assert_eq!(parse_cpu("2"), 2000.0);
        assert!((parse_cpu("1500000n") - 1.5).abs() < 1e-9);
        assert!((parse_cpu("12u") - 0.012).abs() < 1e-9);
        assert_eq!(parse_mem("128Mi"), 134217728);
        assert_eq!(parse_mem("1G"), 1_000_000_000);
        assert_eq!(parse_mem("123456Ki"), 126418944);
        assert_eq!(parse_mem("1000"), 1000);
        assert_eq!(parse_mem("bogus"), 0);
    }

    #[test]
    fn tree_states() {
        let pod = json!({"status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}});
        assert_eq!(tree_state("pods", &pod), "running");
        let pod = json!({"status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "False"}]}});
        assert_eq!(tree_state("pods", &pod), "notready");
        let pod = json!({"status": {"phase": "Pending", "containerStatuses": [{"state": {"waiting": {"reason": "ImagePullBackOff"}}}]}});
        assert_eq!(tree_state("pods", &pod), "error");
        let dep = json!({"spec": {"replicas": 3}, "status": {"readyReplicas": 2}});
        assert_eq!(tree_state("deployments", &dep), "warn");
        let dep = json!({"spec": {"replicas": 0}, "status": {}});
        assert_eq!(tree_state("deployments", &dep), "zero");
        let del = json!({"metadata": {"deletionTimestamp": "2026-01-01T00:00:00Z"}});
        assert_eq!(tree_state("pods", &del), "terminating");
        let cj = json!({"spec": {"suspend": true}});
        assert_eq!(tree_state("cronjobs", &cj), "suspended");
        let node = json!({"spec": {"unschedulable": true}, "status": {"conditions": [{"type": "Ready", "status": "True"}]}});
        assert_eq!(tree_state("nodes", &node), "cordoned");
    }

    #[test]
    fn picks_ready_pod() {
        let pods = vec![
            json!({"metadata": {"name": "a"}, "status": {"phase": "Pending"}}),
            json!({"metadata": {"name": "b"}, "status": {"phase": "Running"}}),
            json!({"metadata": {"name": "c", "deletionTimestamp": "x"}, "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}}),
            json!({"metadata": {"name": "d"}, "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}}),
        ];
        assert_eq!(name_of(&pick_ready_pod(&pods).unwrap()), "d");
        assert_eq!(name_of(&pick_ready_pod(&pods[..3]).unwrap()), "b");
        assert!(pick_ready_pod(&pods[..1]).is_none());
    }

    #[test]
    fn named_ports_and_selectors() {
        let pod = json!({"spec": {"containers": [{"ports": [{"name": "pg", "containerPort": 5432}]}]}});
        assert_eq!(named_port(&pod, "pg"), Some(5432));
        assert_eq!(named_port(&pod, "x"), None);
        assert_eq!(label_selector(&json!({"app": "pg", "tier": "db"})), "app=pg,tier=db");
        assert_eq!(label_selector(&Value::Null), "");
    }

    #[test]
    fn multi_doc_yaml() {
        let docs = parse_docs("---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\n\n---\napiVersion: v1\nkind: List\nitems:\n- {apiVersion: v1, kind: Secret, metadata: {name: s}}\n").unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[1]["kind"], "Secret");
        assert!(parse_docs("- a\n- b\n").is_err());
        assert!(parse_docs("a: [").is_err());
    }

    #[test]
    fn secret_decoding() {
        let v = json!({"data": {"a": "c2VjcmV0", "bin": "/w=="}, "stringData": {"b": "plain"}});
        let d = decode_secret(&v);
        assert_eq!(d["a"], "secret");
        assert_eq!(d["b"], "plain");
        assert_eq!(d["bin"], "base64:/w==");
    }

    #[test]
    fn cronjob_to_job() {
        let cj = json!({"metadata": {"name": "a-very-long-cronjob-name-that-goes-on-and-on-and-on-forever", "namespace": "demo", "uid": "u1"},
            "spec": {"jobTemplate": {"metadata": {"labels": {"x": "1"}}, "spec": {"template": {"spec": {"containers": []}}}}}});
        let j = job_from_cronjob(&cj, "abcde").unwrap();
        let name = j["metadata"]["name"].as_str().unwrap();
        assert!(name.len() <= 63 && name.ends_with("-manual-abcde"), "{name}");
        assert_eq!(j["metadata"]["ownerReferences"][0]["uid"], "u1");
        assert_eq!(j["metadata"]["annotations"]["cronjob.kubernetes.io/instantiate"], "manual");
        assert_eq!(j["metadata"]["labels"]["x"], "1");
        assert!(j["spec"]["template"].is_object());
    }

    #[test]
    fn find_kind_by_api_version() {
        let disc = vec![
            ApiResource { group: "apps".into(), version: "v1".into(), plural: "deployments".into(), kind: "Deployment".into(), namespaced: true, verbs: vec![], short_names: vec![] },
            ApiResource { group: "".into(), version: "v1".into(), plural: "nodes".into(), kind: "Node".into(), namespaced: false, verbs: vec![], short_names: vec![] },
        ];
        assert_eq!(find_kind(&disc, "apps/v1", "Deployment").unwrap().plural, "deployments");
        assert_eq!(find_kind(&disc, "v1", "Node").unwrap().plural, "nodes");
        assert!(find_kind(&disc, "apps/v1beta2", "Deployment").is_some());
        assert!(find_kind(&disc, "v1", "Deployment").is_none());
    }

    #[test]
    fn seg_encodes() {
        assert_eq!(seg("a-b.c"), "a-b.c");
        assert_eq!(seg("a b/c"), "a%20b%2Fc");
    }
}
