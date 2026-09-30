//! 對真實叢集的整合測試（`#[ignore]`）。需要：
//!
//! ```text
//! docker run -d --name dbkit-k3s --privileged -p 16443:6443 -e K3S_KUBECONFIG_OUTPUT=/output/kubeconfig.yaml \
//!   -e K3S_KUBECONFIG_MODE=666 -v <dir>:/output rancher/k3s:v1.33.4-k3s1 server --tls-san 127.0.0.1 --disable traefik
//! # kubeconfig 裡的 server 改成 https://127.0.0.1:16443，並 kubectl apply 下面 DEMO 的資源（namespace demo：
//! # StatefulSet pg + Service pg:15432→pg、Deployment redis ×2 + Service redis、ConfigMap、Secret、CronJob ticker）
//! DBKIT_K8S_KUBECONFIG=<dir>/kubeconfig.yaml cargo test --no-default-features --features docker --lib k8s::it_tests -- --ignored --test-threads=1
//! ```

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::api::K8sApi;
use super::dto::ResRef;
use super::stream::K8sStreams;
use crate::db::docker::stream::{StreamEvent, StreamSink};
use crate::db::{ConnectionConfig, DatabaseDriver, DbKind};

fn cfg() -> ConnectionConfig {
    let path = std::env::var("DBKIT_K8S_KUBECONFIG").expect("DBKIT_K8S_KUBECONFIG");
    let mut c = crate::db::docker::config::tests::cfg("");
    c.id = "k8s-it".into();
    c.kind = DbKind::Kubernetes;
    c.options.insert("k8s_kubeconfig".into(), path);
    c
}

fn api() -> Arc<K8sApi> {
    Arc::new(K8sApi::new(&cfg()).unwrap())
}

/// 收集串流輸出直到結束。
fn collector() -> (StreamSink, tokio::sync::mpsc::UnboundedReceiver<StreamEvent>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (Arc::new(move |ev| { let _ = tx.send(ev); }), rx)
}

async fn drain(mut rx: tokio::sync::mpsc::UnboundedReceiver<StreamEvent>) -> (String, Option<String>, Option<i64>) {
    let mut out = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(30), rx.recv()).await.expect("stream timeout") {
            Some(StreamEvent::Data(d)) => out.extend(d),
            Some(StreamEvent::End { error, exit_code }) => return (String::from_utf8_lossy(&out).into_owned(), error, exit_code),
            None => return (String::from_utf8_lossy(&out).into_owned(), None, None),
        }
    }
}

async fn first_pod(api: &K8sApi, app: &str) -> String {
    let pods = api.list(&ResRef::builtin("pods").unwrap(), Some("demo"), false, &[("labelSelector", format!("app={app}"))]).await.unwrap();
    super::api::name_of(&super::api::pick_ready_pod(&pods).expect("running pod"))
}

#[tokio::test]
#[ignore]
async fn driver_tree_and_tables() {
    let d = super::K8sDriver::connect(&cfg()).await.unwrap();
    let dbs = d.list_databases().await.unwrap();
    assert_eq!(dbs[0], super::CLUSTER_DB);
    assert!(dbs.contains(&"demo".to_string()) && dbs.contains(&"kube-system".to_string()));
    let tree = d.list_tables("demo").await.unwrap();
    assert!(tree.iter().any(|t| t.name == "services/pg" && t.kind == "k8s:services:clusterip"), "{tree:?}");
    assert!(tree.iter().any(|t| t.name == "statefulsets/pg" && t.kind.starts_with("k8s:statefulsets:")));
    assert!(tree.iter().any(|t| t.name == "secrets/app-secret"));
    assert!(tree.iter().any(|t| t.name.starts_with("pods/redis-") && t.kind == "k8s:pods:running"));
    let cluster = d.list_tables(super::CLUSTER_DB).await.unwrap();
    assert!(cluster.iter().any(|t| t.kind == "k8s:nodes:ready"), "{cluster:?}");

    let api = d.api.clone();
    let t = api.table(&ResRef::builtin("pods").unwrap(), Some("demo"), Some("app=redis")).await.unwrap();
    assert_eq!(t.columns[0].name, "Name");
    assert_eq!(t.rows.len(), 2);
    let disc = api.discovery().await.unwrap();
    assert!(disc.iter().any(|r| r.plural == "deployments" && r.group == "apps"));
    assert!(disc.iter().all(|r| !r.plural.contains('/')));
    let ov = api.overview().await.unwrap();
    assert!(ov.version.starts_with("v1.") && ov.nodes.len() == 1 && ov.pods > 0, "{:?}", ov.errors);
}

#[tokio::test]
#[ignore]
async fn yaml_roundtrip_apply_and_delete() {
    let api = api();
    let cm = ResRef::builtin("configmaps").unwrap();
    let yaml = api.get_yaml(&cm, Some("demo"), "app-config").await.unwrap();
    assert!(yaml.contains("LOG_LEVEL: debug") && !yaml.contains("managedFields"));
    let edited = yaml.replace("LOG_LEVEL: debug", "LOG_LEVEL: info");
    let dry = api.replace_yaml(&cm, Some("demo"), "app-config", &edited, true).await.unwrap();
    assert_eq!(dry["data"]["LOG_LEVEL"], "info");
    assert_eq!(api.get(&cm, Some("demo"), "app-config").await.unwrap()["data"]["LOG_LEVEL"], "debug");
    assert!(api.replace_yaml(&cm, Some("demo"), "app-config", &edited.replace("name: app-config", "name: other"), true).await.is_err());

    let doc = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: it-applied\ndata:\n  a: \"1\"\n---\napiVersion: v1\nkind: Nope\nmetadata: {name: x}\n";
    let r = api.apply_yaml(doc, Some("demo"), false, false).await.unwrap();
    assert_eq!(r[0].action, "created", "{r:?}");
    assert_eq!(r[0].namespace, "demo");
    assert!(r[1].error.is_some());
    let r = api.apply_yaml(&doc.replace("\"1\"", "\"2\""), Some("demo"), false, false).await.unwrap();
    assert_eq!(r[0].action, "configured");
    assert_eq!(api.get(&cm, Some("demo"), "it-applied").await.unwrap()["data"]["a"], "2");
    api.delete(&cm, Some("demo"), "it-applied", false).await.unwrap();

    let secret = api.secret_data("demo", "app-secret").await.unwrap();
    assert_eq!(secret["API_KEY"], "abc123");
    let ev = api.events(Some("demo"), None, false).await.unwrap();
    assert!(!ev.is_empty());
}

#[tokio::test]
#[ignore]
async fn exec_and_logs() {
    let api = api();
    let pod = first_pod(&api, "redis").await;
    let streams = Arc::new(K8sStreams::new());
    let (sink, rx) = collector();
    streams
        .open_exec("e1".into(), "k8s-it", api.clone(), "demo", &pod, "", vec!["sh".into(), "-c".into(), "echo hello-$((40+2)); exit 3".into()], 80, 24, sink)
        .await
        .unwrap();
    let (out, err, code) = drain(rx).await;
    assert!(out.contains("hello-42"), "{out:?}");
    assert_eq!((err, code), (None, Some(3)));

    // 互動：送指令進 stdin。
    let (sink, rx) = collector();
    streams.open_exec("e2".into(), "k8s-it", api.clone(), "demo", &pod, "redis", vec!["sh".into()], 80, 24, sink).await.unwrap();
    let s = streams.exec("e2").unwrap();
    s.resize(100, 30).await.unwrap();
    s.write(b"stty size; echo typed-$((1+1)); exit\n").await.unwrap();
    let (out, _, code) = drain(rx).await;
    assert!(out.contains("typed-2") && out.contains("30 100"), "{out:?}");
    assert_eq!(code, Some(0));

    let (sink, rx) = collector();
    let opts = super::dto::LogOptions { tail: 20, ..Default::default() };
    streams.open_logs("l1".into(), "k8s-it", api.clone(), "demo", &pod, opts, sink).await.unwrap();
    let (out, err, _) = drain(rx).await;
    assert!(err.is_none() && out.contains("Ready to accept connections"), "{out:?}");
}

#[tokio::test]
#[ignore]
async fn port_forward_service_to_postgres() {
    let api = api();
    let fwd = super::forward::start(api.clone(), "demo", "svc/pg", 15432, 0).await.unwrap();
    assert_eq!(*fwd.state.remote_port.lock(), 5432); // targetPort 是具名埠 pg
    for _ in 0..3 {
        let mut s = tokio::net::TcpStream::connect(fwd.local_addr).await.unwrap();
        // SSLRequest → 伺服器回單一位元組 'N'（不支援 SSL）或 'S'。
        s.write_all(&[0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]).await.unwrap();
        let mut b = [0u8; 1];
        tokio::time::timeout(Duration::from_secs(15), s.read_exact(&mut b)).await.unwrap().unwrap();
        assert!(b[0] == b'N' || b[0] == b'S', "{b:?}");
    }
    let _ = fwd.shutdown.send(true);
    fwd.task.await.unwrap();
}

#[tokio::test]
#[ignore]
async fn database_connection_via_port_forward() {
    let parent = cfg();
    let mut db = crate::db::docker::config::tests::cfg("");
    db.id = "pg-via-k8s".into();
    db.kind = DbKind::Postgres;
    db.username = "app".into();
    db.password = "secret".into();
    db.database = Some("appdb".into());
    db.options.insert(super::forward::OPT_CONN.into(), parent.id.clone());
    db.options.insert(super::forward::OPT_PARENT.into(), serde_json::to_string(&parent).unwrap());
    db.options.insert(super::forward::OPT_NS.into(), "demo".into());
    db.options.insert(super::forward::OPT_TARGET.into(), "sts/pg".into());
    db.options.insert(super::forward::OPT_PORT.into(), "5432".into());
    let mgr = crate::manager::ConnectionManager::new();
    mgr.test(&db).await.unwrap();
    mgr.connect(db.clone()).await.unwrap();
    let dbs = mgr.list_databases(&db.id).await.unwrap();
    // PostgreSQL 的 list_databases 回的是 schema；連得上 appdb 才看得到 public。
    assert!(dbs.contains(&"public".to_string()), "{dbs:?}");
    mgr.disconnect(&db.id).await;
}

#[tokio::test]
#[ignore]
async fn workload_actions() {
    let api = api();
    let dep = ResRef::builtin("deployments").unwrap();
    api.scale(&dep, "demo", "redis", 1).await.unwrap();
    assert_eq!(api.get(&dep, Some("demo"), "redis").await.unwrap()["spec"]["replicas"], 1);
    api.scale(&dep, "demo", "redis", 2).await.unwrap();
    api.restart(&dep, "demo", "redis").await.unwrap();
    let d = api.get(&dep, Some("demo"), "redis").await.unwrap();
    assert!(d["spec"]["template"]["metadata"]["annotations"]["kubectl.kubernetes.io/restartedAt"].is_string());

    api.set_suspend("demo", "ticker", true).await.unwrap();
    api.set_suspend("demo", "ticker", false).await.unwrap();
    let job = api.trigger_cronjob("demo", "ticker").await.unwrap();
    assert!(job.starts_with("ticker-manual-"));
    api.delete(&ResRef::builtin("jobs").unwrap(), Some("demo"), &job, false).await.unwrap();

    let node = api.list(&ResRef::builtin("nodes").unwrap(), None, false, &[]).await.unwrap();
    let n = super::api::name_of(&node[0]);
    api.set_unschedulable(&n, true).await.unwrap();
    api.set_unschedulable(&n, false).await.unwrap();
    // metrics-server 在 k3s 內建；剛啟動可能還沒資料，只驗證呼叫不出錯。
    let _ = api.pod_metrics(Some("demo"), None).await.unwrap();
    let _ = api.node_metrics().await.unwrap();
}
