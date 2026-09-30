//! port-forward：本機 `127.0.0.1:<埠>` ↔ Pod 埠（WebSocket `v4.channel.k8s.io`）。
//!
//! 每條進站 TCP 連線開一條新的 WebSocket（與 kubectl 一樣一連線一串流）。轉發目標可以是 `pod/x`，
//! 也可以是 `svc/x` / `deploy/x` / `sts/x`：開始時解析成某個 Ready 的 Pod 並快取；
//! 之後連線失敗（Pod 被重建）就重新解析一次再試。
//!
//! 兩種用法：
//! - 使用者從側欄 / 分頁開的轉發（`K8sForwards` 登記簿，可列出、停止）；
//! - 資料庫連線的「經由 Kubernetes port-forward」：manager 連線時開一條，包成 `TunnelGuard`，
//!   跟 SSH 通道一樣隨連線生命週期收掉。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::api::K8sApi;
use super::dto::K8sForwardInfo;
use super::ws::{self, Message, Read, CHANNEL_PROTOCOL};
use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};

/// 轉發狀態（UI 顯示用）。
#[derive(Default)]
pub struct ForwardState {
    pub active: AtomicU32,
    pub pod: Mutex<String>,
    pub remote_port: Mutex<u16>,
    pub last_error: Mutex<Option<String>>,
}

/// 一條進行中的轉發。
pub struct Forward {
    pub local_addr: SocketAddr,
    pub shutdown: watch::Sender<bool>,
    pub task: JoinHandle<()>,
    pub state: Arc<ForwardState>,
}

/// 開始轉發。`bind_port` 0 = 由 OS 挑。目標先解析一次（失敗直接回錯，不留監聽）。
pub async fn start(api: Arc<K8sApi>, ns: &str, target: &str, remote_port: u16, bind_port: u16) -> AppResult<Forward> {
    let (pod, port) = api.resolve_forward(ns, target, remote_port).await?;
    let listener = TcpListener::bind(("127.0.0.1", bind_port)).await.map_err(|e| {
        AppError::Connect(tf!("本機埠 {port} 無法監聽：{e}", port = bind_port, e = e))
    })?;
    let local_addr = listener.local_addr().map_err(|e| AppError::Connect(e.to_string()))?;
    let state = Arc::new(ForwardState::default());
    *state.pod.lock() = pod;
    *state.remote_port.lock() = port;
    let (tx, mut rx) = watch::channel(false);
    let st = state.clone();
    let ns = ns.to_string();
    let target = target.to_string();
    let task = tokio::spawn(async move {
        let mut conns: Vec<JoinHandle<()>> = Vec::new();
        loop {
            tokio::select! {
                _ = rx.changed() => {
                    if *rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let socket = match accepted {
                        Ok((s, _)) => s,
                        Err(_) => {
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            continue;
                        }
                    };
                    let _ = socket.set_nodelay(true);
                    let api = api.clone();
                    let st = st.clone();
                    let ns = ns.clone();
                    let target = target.clone();
                    conns.retain(|h| !h.is_finished());
                    conns.push(tokio::spawn(async move {
                        st.active.fetch_add(1, Ordering::Relaxed);
                        let r = serve(&api, &st, &ns, &target, remote_port, socket).await;
                        st.active.fetch_sub(1, Ordering::Relaxed);
                        if let Err(e) = r {
                            *st.last_error.lock() = Some(e);
                        }
                    }));
                }
            }
        }
        for h in conns {
            h.abort();
        }
    });
    Ok(Forward { local_addr, shutdown: tx, task, state })
}

/// 一條 TCP 連線：開 WebSocket（失敗就重新解析目標再試一次）後雙向轉送。
async fn serve(api: &K8sApi, st: &ForwardState, ns: &str, target: &str, requested: u16, socket: TcpStream) -> Result<(), String> {
    let pod = st.pod.lock().clone();
    let port = *st.remote_port.lock();
    let upgraded = match open_ws(api, ns, &pod, port).await {
        Ok(u) => u,
        Err(first) => {
            // Pod 可能已被重建：重新解析（pod/x 目標重試同一個）。
            let (pod, port) = api.resolve_forward(ns, target, requested).await.map_err(|e| e.message())?;
            *st.pod.lock() = pod.clone();
            *st.remote_port.lock() = port;
            open_ws(api, ns, &pod, port).await.map_err(|e| format!("{} / {}", first.message(), e.message()))?
        }
    };
    bridge(socket, upgraded).await
}

async fn open_ws(api: &K8sApi, ns: &str, pod: &str, port: u16) -> AppResult<reqwest::Upgraded> {
    let rb = api.portforward_request(ns, pod, port, false).await?;
    match ws::connect(rb, CHANNEL_PROTOCOL).await {
        Err(AppError::Query(m)) if m.contains(" 401") && api.has_exec_plugin() => {
            let rb = api.portforward_request(ns, pod, port, true).await?;
            ws::connect(rb, CHANNEL_PROTOCOL).await
        }
        other => other,
    }
}

enum Out {
    Data(Vec<u8>),
    Pong(Vec<u8>),
}

/// TCP ↔ WebSocket channel 0（資料）/ 1（錯誤）。
async fn bridge(socket: TcpStream, upgraded: reqwest::Upgraded) -> Result<(), String> {
    let (mut wr, mut ww) = ws::split(upgraded);
    let (mut tr, mut tw) = socket.into_split();
    let (out_tx, mut out_rx) = mpsc::channel::<Out>(64);

    // 寫端任務：TCP 讀到的資料與 pong 都經這裡送出（WsWriter 只有一個擁有者）。
    let writer = tokio::spawn(async move {
        while let Some(o) = out_rx.recv().await {
            let r = match o {
                Out::Data(d) => ww.send_binary(&d).await,
                Out::Pong(p) => ww.send_pong(&p).await,
            };
            if r.is_err() {
                break;
            }
        }
        ww.close().await;
    });

    // TCP → WS
    let tx = out_tx.clone();
    let upstream = tokio::spawn(async move {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match tr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut frame = Vec::with_capacity(n + 1);
                    frame.push(0u8);
                    frame.extend_from_slice(&buf[..n]);
                    if tx.send(Out::Data(frame)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // WS → TCP
    let mut seen_port = [false, false];
    let mut error: Option<String> = None;
    loop {
        match wr.next().await {
            Ok(Read::Ping(p)) => {
                let _ = out_tx.send(Out::Pong(p)).await;
            }
            Ok(Read::Msg(Message::Binary(data))) => {
                let Some((&ch, payload)) = data.split_first() else { continue };
                let idx = ch as usize;
                if idx < 2 && !seen_port[idx] {
                    // 每條 channel 的第一則訊息是 2-byte 埠號。
                    seen_port[idx] = true;
                    continue;
                }
                match ch {
                    0 => {
                        if tw.write_all(payload).await.is_err() {
                            break;
                        }
                    }
                    1 => {
                        let msg = String::from_utf8_lossy(payload).trim().to_string();
                        if !msg.is_empty() {
                            error = Some(msg);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Read::Msg(Message::Text(_))) => {}
            Ok(Read::Msg(Message::Close(..))) => break,
            Err(e) => {
                error = Some(e.to_string());
                break;
            }
        }
    }
    let _ = tw.shutdown().await;
    upstream.abort();
    drop(out_tx);
    let _ = writer.await;
    match error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

// ---- UI 開的轉發登記簿 ----

struct Entry {
    info: K8sForwardInfo,
    fwd: Forward,
}

#[derive(Default)]
pub struct K8sForwards {
    inner: Mutex<HashMap<String, Entry>>,
}

impl K8sForwards {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn open(&self, conn_id: &str, api: Arc<K8sApi>, ns: &str, target: &str, remote_port: u16, local_port: u16) -> AppResult<K8sForwardInfo> {
        let fwd = start(api, ns, target, remote_port, local_port).await?;
        let info = K8sForwardInfo {
            id: uuid::Uuid::new_v4().to_string(),
            conn_id: conn_id.to_string(),
            namespace: ns.to_string(),
            target: target.to_string(),
            pod: fwd.state.pod.lock().clone(),
            remote_port: *fwd.state.remote_port.lock(),
            local_port: fwd.local_addr.port(),
            active: 0,
            started: chrono::Utc::now().to_rfc3339(),
            last_error: None,
        };
        self.inner.lock().insert(info.id.clone(), Entry { info: info.clone(), fwd });
        Ok(info)
    }

    pub fn list(&self, conn_id: Option<&str>) -> Vec<K8sForwardInfo> {
        let map = self.inner.lock();
        let mut out: Vec<K8sForwardInfo> = map
            .values()
            .filter(|e| conn_id.map_or(true, |c| e.info.conn_id == c))
            .map(|e| {
                let mut i = e.info.clone();
                i.active = e.fwd.state.active.load(Ordering::Relaxed);
                i.pod = e.fwd.state.pod.lock().clone();
                i.last_error = e.fwd.state.last_error.lock().clone();
                i
            })
            .collect();
        out.sort_by(|a, b| a.started.cmp(&b.started));
        out
    }

    pub async fn close(&self, id: &str) {
        let e = self.inner.lock().remove(id);
        if let Some(e) = e {
            let _ = e.fwd.shutdown.send(true);
            let _ = e.fwd.task.await;
        }
    }

    pub async fn close_conn(&self, conn_id: &str) {
        let entries: Vec<Entry> = {
            let mut map = self.inner.lock();
            let ids: Vec<String> = map.iter().filter(|(_, e)| e.info.conn_id == conn_id).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        for e in entries {
            let _ = e.fwd.shutdown.send(true);
            let _ = e.fwd.task.await;
        }
    }
}

// ---- 資料庫連線經由 port-forward ----

/// 資料庫連線 options：經由哪個 Kubernetes 連線轉發。
pub const OPT_CONN: &str = "k8s_conn";
pub const OPT_NS: &str = "k8s_ns";
pub const OPT_TARGET: &str = "k8s_target";
pub const OPT_PORT: &str = "k8s_port";
/// 父連線（Kubernetes）的完整設定 JSON（commands 層從 store 載入後注入；記憶體內，不落地）。
pub const OPT_PARENT: &str = "__k8s_parent";

/// 此連線是否經由 Kubernetes port-forward。
pub fn wants_forward(cfg: &ConnectionConfig) -> bool {
    cfg.options.get(OPT_CONN).is_some_and(|v| !v.trim().is_empty())
}

async fn parent_config(cfg: &ConnectionConfig) -> AppResult<ConnectionConfig> {
    if let Some(json) = cfg.options.get(OPT_PARENT) {
        return serde_json::from_str(json).map_err(|e| AppError::Connect(e.to_string()));
    }
    let id = cfg.options.get(OPT_CONN).map(|s| s.trim()).unwrap_or_default();
    let dir = crate::store::headless_config_dir()?;
    crate::store::load_connection_in(&dir, id).await.map_err(|e| match e {
        AppError::NotFound(_) => AppError::Connect(t!("找不到這個連線指定的 Kubernetes 連線（可能已被刪除）").into()),
        other => other,
    })
}

/// 開一條資料庫用的轉發，包成 `TunnelGuard`（manager 用法與 SSH 通道相同）。
/// 父連線本身走 SSH 通道時，一併開那條通道，收尾時一起關。
pub async fn open_db_forward(cfg: &ConnectionConfig) -> AppResult<crate::ssh::TunnelGuard> {
    let mut parent = parent_config(cfg).await?;
    if parent.kind != crate::db::DbKind::Kubernetes {
        return Err(AppError::Connect(t!("port-forward 指定的連線不是 Kubernetes 連線").into()));
    }
    let ns = cfg.options.get(OPT_NS).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "default".into());
    let target = cfg.options.get(OPT_TARGET).map(|s| s.trim().to_string()).unwrap_or_default();
    if target.is_empty() {
        return Err(AppError::Connect(t!("請指定 port-forward 的目標（例如 svc/postgres）").into()));
    }
    let port: u16 = match cfg.options.get(OPT_PORT).and_then(|p| p.trim().parse().ok()) {
        Some(p) => p,
        None if cfg.port != 0 => cfg.port,
        None => return Err(AppError::Connect(t!("請指定 port-forward 的遠端埠").into())),
    };

    let mut ssh: Option<crate::ssh::TunnelGuard> = None;
    if parent.ssh_enabled {
        crate::db::container::prepare_tunnel(&mut parent)?;
        parent.options.insert(crate::db::http_tls::TUNNEL_ORIGIN_HOST.to_string(), parent.host.trim().to_string());
        let g = crate::ssh::open_tunnel(&parent).await?;
        parent.host = "127.0.0.1".into();
        parent.port = g.local_port();
        ssh = Some(g);
    }
    let started = async {
        let api = Arc::new(K8sApi::new(&parent)?);
        start(api, &ns, &target, port, 0).await
    }
    .await;
    let fwd = match started {
        Ok(f) => f,
        Err(e) => {
            if let Some(g) = ssh {
                g.shutdown().await;
            }
            return Err(e);
        }
    };
    let (tx, mut rx) = watch::channel(false);
    let Forward { local_addr, shutdown, task, .. } = fwd;
    let task = tokio::spawn(async move {
        let _ = rx.wait_for(|v| *v).await;
        let _ = shutdown.send(true);
        let _ = task.await;
        if let Some(g) = ssh {
            g.shutdown().await;
        }
    });
    Ok(crate::ssh::TunnelGuard::from_parts(local_addr, tx, task))
}
