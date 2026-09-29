//! 對真實 Docker daemon 的整合測試（`#[ignore]`；`DBKIT_DOCKER_IT=1 cargo test -- --ignored docker::it_tests`）。
//!
//! 端點：`DBKIT_DOCKER_HOST`（同連線的 host 欄語法），未設＝本機預設 socket / pipe。
//! 映像：`DBKIT_DOCKER_IMAGE`（需含 /bin/sh），預設 `alpine:3`——本機沒有會先 `docker pull`。
//! 測試自己起一個 `dbkit-it-<uuid>` 容器、結束時強制刪除，不動其他容器。
#![cfg(test)]

use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use super::api::DockerApi;
use super::config::tests::cfg;
use super::stream::{DockerStreams, StreamEvent, StreamSink};
use crate::db::DatabaseDriver;

fn enabled() -> bool {
    std::env::var("DBKIT_DOCKER_IT").as_deref() == Ok("1")
}

fn host() -> String {
    std::env::var("DBKIT_DOCKER_HOST").unwrap_or_default()
}

fn image() -> String {
    std::env::var("DBKIT_DOCKER_IMAGE").unwrap_or_else(|_| "alpine:3".into())
}

/// 用 docker CLI 起測試容器（本模組只做管理，不做 create；用 CLI 準備場景最直接）。
struct Scratch {
    name: String,
}

impl Scratch {
    fn start(script: &str) -> Scratch {
        let name = format!("dbkit-it-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let out = Command::new("docker")
            .args(["run", "-d", "--name", &name, "--entrypoint", "/bin/sh", &image(), "-c", script])
            .output()
            .expect("docker CLI");
        assert!(out.status.success(), "docker run failed: {}", String::from_utf8_lossy(&out.stderr));
        Scratch { name }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.name]).output();
    }
}

fn collector() -> (StreamSink, Arc<Mutex<Vec<u8>>>, Arc<Mutex<Option<(Option<String>, Option<i64>)>>>) {
    let data = Arc::new(Mutex::new(Vec::new()));
    let end = Arc::new(Mutex::new(None));
    let (d, e) = (data.clone(), end.clone());
    let sink: StreamSink = Arc::new(move |ev| match ev {
        StreamEvent::Data(b) => d.lock().extend_from_slice(&b),
        StreamEvent::End { error, exit_code } => *e.lock() = Some((error, exit_code)),
    });
    (sink, data, end)
}

async fn wait_end(end: &Arc<Mutex<Option<(Option<String>, Option<i64>)>>>) -> (Option<String>, Option<i64>) {
    for _ in 0..100 {
        if let Some(v) = end.lock().clone() {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("stream did not end within 10s");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn docker_end_to_end() {
    if !enabled() {
        return;
    }
    let c = cfg(&host());
    let drv = super::DockerDriver::connect(&c).await.expect("connect");
    let api: Arc<DockerApi> = drv.api.clone();

    let ov = api.overview().await.expect("overview");
    assert!(!ov.server_version.is_empty());
    assert!(drv.list_tables("images").await.expect("images").iter().any(|t| t.kind.starts_with("image")));
    api.volumes().await.expect("volumes");
    assert!(api.networks().await.expect("networks").iter().any(|n| n.builtin));

    let sc = Scratch::start("echo out-line; echo err-line >&2; sleep 300");
    tokio::time::sleep(Duration::from_millis(800)).await;

    // 容器出現在樹上、狀態 running。
    let tables = drv.list_tables("containers").await.expect("containers");
    let me = tables.iter().find(|t| t.name == sc.name).expect("scratch container listed");
    assert_eq!(me.kind, "container-running");

    let d = api.container_inspect(&sc.name).await.expect("inspect");
    assert!(d.running && !d.tty);

    // log（非 TTY → 多工格式）：stdout 原樣、stderr 上色。
    let streams = Arc::new(DockerStreams::new());
    let (sink, data, end) = collector();
    streams
        .open_logs("log".into(), "c", api.clone(), &sc.name, 0, false, false, sink)
        .await
        .expect("logs");
    let (err, _) = wait_end(&end).await;
    assert!(err.is_none(), "log stream error: {err:?}");
    let text = String::from_utf8_lossy(&data.lock()).to_string();
    assert!(text.contains("out-line"), "logs: {text:?}");
    assert!(text.contains("\x1b[91merr-line"), "stderr not colored: {text:?}");

    // exec：hijack 串流雙向 + 結束碼。
    let (sink, data, end) = collector();
    streams
        .open_exec("ex".into(), "c", api.clone(), &sc.name, vec!["/bin/sh".into()], "", 100, 30, sink)
        .await
        .expect("exec open");
    let s = streams.exec("ex").expect("exec handle");
    s.resize(120, 40).await.expect("resize");
    s.write(b"echo hello-$((1+2))\nexit 7\n").await.expect("write");
    let (err, code) = wait_end(&end).await;
    assert!(err.is_none(), "exec error: {err:?}");
    assert_eq!(code, Some(7));
    let text = String::from_utf8_lossy(&data.lock()).to_string();
    assert!(text.contains("hello-3"), "exec output: {text:?}");

    // 預設 shell 選擇（空 cmd）也能開。
    let (sink, _data, end) = collector();
    streams
        .open_exec("ex2".into(), "c", api.clone(), &sc.name, vec![], "", 80, 24, sink)
        .await
        .expect("default shell");
    streams.exec("ex2").unwrap().write(b"exit 0\n").await.unwrap();
    assert_eq!(wait_end(&end).await.1, Some(0));

    // 資源 / 行程。
    let st = api.container_stats(&sc.name).await.expect("stats");
    assert!(st.mem_usage > 0 && st.pids >= 1);
    assert!(!api.container_top(&sc.name).await.expect("top").processes.is_empty());

    // 關連線時一次收掉串流（follow log 會一直掛著）。
    let (sink, _, end) = collector();
    streams
        .open_logs("follow".into(), "c", api.clone(), &sc.name, 10, true, true, sink)
        .await
        .expect("follow");
    streams.close_conn("c").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(end.lock().is_none(), "aborted stream should not report End");

    // 啟停 / 刪除。
    api.container_action(&sc.name, "pause").await.expect("pause");
    assert!(api.container_inspect(&sc.name).await.unwrap().paused);
    api.container_action(&sc.name, "unpause").await.expect("unpause");
    api.container_action(&sc.name, "stop").await.expect("stop");
    // 已停止再停 → 304，視為成功。
    api.container_action(&sc.name, "stop").await.expect("stop twice");
    api.container_remove(&sc.name, false, false).await.expect("remove");
    let err = api.container_inspect(&sc.name).await.unwrap_err().to_string();
    assert!(err.contains("404"), "{err}");
}

/// TLS / mTLS：對 `docker:dind`（`--tlsverify`，自動產生 CA / server / client 憑證）驗證。
/// 需 `DBKIT_DOCKER_TLS_HOST`（如 `localhost:12376`）與 `DBKIT_DOCKER_CERT_PATH`（含 ca.pem / cert.pem / key.pem）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn docker_tls_mtls() {
    if !enabled() {
        return;
    }
    let (Ok(host), Ok(dir)) = (std::env::var("DBKIT_DOCKER_TLS_HOST"), std::env::var("DBKIT_DOCKER_CERT_PATH")) else {
        return;
    };
    let p = |f: &str| std::path::Path::new(&dir).join(f).to_string_lossy().to_string();
    let with = |pairs: &[(&str, String)]| {
        let mut c = cfg(&host);
        c.options.insert("docker_tls".into(), "1".into());
        for (k, v) in pairs {
            c.options.insert((*k).into(), v.clone());
        }
        c
    };

    // 完整 mTLS：CA + 用戶端憑證 + 私鑰。
    let ok = with(&[("docker_tls_ca", p("ca.pem")), ("docker_tls_cert", p("cert.pem")), ("docker_tls_key", p("key.pem"))]);
    let drv = super::DockerDriver::connect(&ok).await.expect("mTLS connect");
    let ov = drv.api.overview().await.expect("overview over TLS");
    assert!(ov.endpoint.starts_with("tcp+tls://"), "{}", ov.endpoint);
    drv.list_tables("networks").await.expect("networks over TLS");

    // 缺用戶端憑證：--tlsverify 的 daemon 拒絕握手。
    let no_client = with(&[("docker_tls_ca", p("ca.pem"))]);
    assert!(super::DockerDriver::connect(&no_client).await.is_err(), "daemon should require a client cert");

    // 不給 CA：自簽 server 憑證驗不過；勾「略過驗證」才過。
    let no_ca = with(&[("docker_tls_cert", p("cert.pem")), ("docker_tls_key", p("key.pem"))]);
    assert!(super::DockerDriver::connect(&no_ca).await.is_err(), "self-signed server cert must not verify");
    let mut insecure = no_ca.clone();
    insecure.options.insert("docker_tls_insecure".into(), "1".into());
    super::DockerDriver::connect(&insecure).await.expect("insecure + client cert");
}
