//! 遠端桌面對真伺服器的整合測試（預設 `#[ignore]`）。
//!
//! ```text
//! docker build -t dbkit-vnc-it src-tauri/tests/docker/vnc
//! docker run -d --name dbkit-vnc -p 5901:5901 -p 5902:5902 dbkit-vnc-it       # TigerVNC：5901 VNC 密碼、5902 免認證
//! docker build -t dbkit-xrdp-it src-tauri/tests/docker/xrdp
//! docker run -d --name dbkit-xrdp -p 3390:3389 dbkit-xrdp-it                  # xrdp（TLS，帳號 dbkit / dbkit123）
//! cargo test --no-default-features --features remote-desktop --lib rd::it_tests -- --ignored
//! ```
//! 環境變數 `DBKIT_VNC_IT_HOST` / `DBKIT_RDP_IT_HOST`（預設 127.0.0.1）可改目標。憑證 TOFU 用臨時檔。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::runtime::RdCtl;
use super::transport::dial_direct;
use crate::error::AppError;

fn host(var: &str) -> String {
    std::env::var(var).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "127.0.0.1".into())
}

const T: Duration = Duration::from_secs(10);

// ---- VNC ----

#[cfg(feature = "vnc")]
mod vnc {
    use super::*;
    use crate::rd::vnc::auth::{client_handshake, VncCredSource, VncCreds, VncSecurityPref};
    use crate::rd::vnc::pump;

    /// 不該被問到：認證資料一開始就給了。
    struct NoAsk;
    #[async_trait]
    impl VncCredSource for NoAsk {
        async fn creds(&self, _need_username: bool, _error: Option<String>) -> Option<VncCreds> {
            None
        }
    }

    fn creds(p: &str) -> Option<VncCreds> {
        Some(VncCreds { username: String::new(), password: p.into() })
    }

    /// 認證後送 ClientInit、讀 ServerInit 的寬高——證明認證後的串流接得上正常的 RFB 流程。
    async fn server_init_size(s: &mut crate::rd::transport::BoxStream) -> (u16, u16) {
        s.write_all(&[1]).await.unwrap();
        let mut head = [0u8; 24];
        s.read_exact(&mut head).await.unwrap();
        (u16::from_be_bytes([head[0], head[1]]), u16::from_be_bytes([head[2], head[3]]))
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_password_auth_against_tigervnc() {
        let mut d = dial_direct(&host("DBKIT_VNC_IT_HOST"), 5901, T).await.unwrap();
        let out = client_handshake(&mut d.stream, VncSecurityPref::Auto, creds("dbkit123"), &NoAsk).await.unwrap();
        assert_eq!(out.security, "vnc-auth");
        assert!(!out.encrypted);
        assert_eq!(server_init_size(&mut d.stream).await, (800, 600));
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_wrong_password_is_auth_error() {
        let mut d = dial_direct(&host("DBKIT_VNC_IT_HOST"), 5901, T).await.unwrap();
        let e = client_handshake(&mut d.stream, VncSecurityPref::Auto, creds("nope"), &NoAsk).await.err().unwrap();
        assert!(matches!(e, AppError::RdAuth(_)), "{e:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn vnc_none_auth_against_tigervnc() {
        let mut d = dial_direct(&host("DBKIT_VNC_IT_HOST"), 5902, T).await.unwrap();
        let out = client_handshake(&mut d.stream, VncSecurityPref::Auto, None, &NoAsk).await.unwrap();
        assert_eq!(out.security, "vnc-none");
        assert_eq!(server_init_size(&mut d.stream).await, (640, 480));
    }

    async fn recv(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> Vec<u8> {
        tokio::time::timeout(T, rx.recv()).await.unwrap().unwrap()
    }

    /// 完整路徑：認證 → pump（對前端假握手）→ 前端送 ClientInit → 前端收到真伺服器的 ServerInit。
    #[tokio::test]
    #[ignore]
    async fn vnc_pump_relays_real_server_init() {
        let mut d = dial_direct(&host("DBKIT_VNC_IT_HOST"), 5901, T).await.unwrap();
        client_handshake(&mut d.stream, VncSecurityPref::Auto, creds("dbkit123"), &NoAsk).await.unwrap();
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let sink: pump::Sink = Arc::new(move |b| {
            let _ = out_tx.send(b);
        });
        let task = tokio::spawn(pump::run(d.stream, None, ctl_rx, sink));
        let mut got = Vec::new();
        while got.len() < 12 {
            got.extend(recv(&mut out_rx).await);
        }
        assert_eq!(&got[..12], b"RFB 003.008\n");
        ctl_tx.send(RdCtl::Write(b"RFB 003.008\n".to_vec())).unwrap();
        while got.len() < 14 {
            got.extend(recv(&mut out_rx).await);
        }
        ctl_tx.send(RdCtl::Write(vec![1])).unwrap();
        while got.len() < 18 {
            got.extend(recv(&mut out_rx).await);
        }
        assert_eq!(&got[14..18], &[0, 0, 0, 0], "SecurityResult OK");
        ctl_tx.send(RdCtl::Write(vec![1])).unwrap(); // ClientInit（shared）
        while got.len() < 18 + 24 {
            got.extend(recv(&mut out_rx).await);
        }
        let si = &got[18..];
        assert_eq!((u16::from_be_bytes([si[0], si[1]]), u16::from_be_bytes([si[2], si[3]])), (800, 600));
        ctl_tx.send(RdCtl::Close).unwrap();
        assert_eq!(task.await.unwrap(), None);
    }
}

// ---- RDP ----

#[cfg(feature = "rdp")]
mod rdp {
    use super::*;
    use crate::rd::rdp::cert::CertQuestion;
    use crate::rd::rdp::{self as r, frames, CertUi, RdpParams};
    use crate::rd::runtime::CertDecision;
    use crate::ssh::known_hosts::KnownHostsStore;

    struct AcceptOnce;
    #[async_trait]
    impl CertUi for AcceptOnce {
        async fn ask(&self, q: CertQuestion) -> CertDecision {
            assert!(q.fingerprint.starts_with("SHA256:"), "{q:?}");
            CertDecision::AcceptOnce
        }
    }

    /// xrdp：TLS 握手 → 憑證 TOFU → 連上 → 收到第一張畫面（登入畫面也算）→ 斷線。
    #[tokio::test]
    #[ignore]
    async fn rdp_first_frame_against_xrdp() {
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let frames_seen = Arc::new(parking_lot::Mutex::new(Vec::<Vec<u8>>::new()));
        let seen = frames_seen.clone();
        let done = r::run_on_own_thread("rdp-it".into(), move || async move {
            let d = dial_direct(&host("DBKIT_RDP_IT_HOST"), 3390, T).await?;
            let params = RdpParams {
                host: "localhost".into(),
                port: 3390,
                username: "dbkit".into(),
                password: "dbkit123".into(),
                domain: String::new(),
                width: 1024,
                height: 768,
                scale: 100,
                color_depth: 32,
                nla: true,
                view_only: false,
                clipboard: true,
            };
            let dir = std::env::temp_dir().join(format!("dbkit-rd-it-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let store = KnownHostsStore::at(dir.join("certs.json"));
            let c = r::connect(d, &params, &store, &AcceptOnce).await?;
            let security = c.security;
            let size = c.desktop_size();
            let sink: r::Sink = Arc::new(move |b| seen.lock().push(b));
            let reason = r::run(c, ctl_rx, sink).await;
            Ok::<_, AppError>((security, size, reason))
        });
        // 等第一塊畫面（最多 30 秒），然後主動斷線。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let got = frames_seen.lock().iter().any(|m| m.first() == Some(&frames::REC_RECT));
            if got || tokio::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = ctl_tx.send(RdCtl::Close);
        let (security, size, _reason) = tokio::time::timeout(Duration::from_secs(10), done)
            .await
            .expect("RDP 執行緒沒有結束")
            .expect("RDP 執行緒沒有回報")
            .expect("RDP 連線失敗");
        assert_eq!(security, "tls", "xrdp 不做 NLA，協商結果應為 TLS");
        assert_eq!(size, (1024, 768));
        let msgs = frames_seen.lock();
        assert_eq!(msgs.first().map(|m| m[0]), Some(frames::REC_RESIZE), "第一則是畫布尺寸");
        assert!(msgs.iter().any(|m| m.first() == Some(&frames::REC_RECT)), "30 秒內要收到畫面");
    }
}

// ---- RustDesk（經 AGPL 輔助程式）----
//
// ```text
// docker build -t dbkit-rustdesk-it rustdesk-bridge/tests/docker
// docker run -d --name dbkit-rustdesk -p 21118:21118 dbkit-rustdesk-it          # Direct IP、密碼 dbkit123
// cargo build --manifest-path rustdesk-bridge/Cargo.toml
// DBKIT_RUSTDESK_BRIDGE=rustdesk-bridge/target/debug/dbk-rustdesk-bridge(.exe) cargo test ... rd::it_tests::rustdesk -- --ignored
//
// 用 ID 經自架的 ID / 中繼伺服器（rustdesk-bridge/tests/docker/compose.yml，對方 ID 與公鑰的取法見該檔）：
// DBKIT_RUSTDESK_IT_ID=<ID> DBKIT_RUSTDESK_IT_KEY=<公鑰> DBKIT_RUSTDESK_BRIDGE=... cargo test ... rd::it_tests::rustdesk::rustdesk_id -- --ignored
// ```
mod rustdesk {
    use super::*;
    use crate::rd::runtime::AuthAnswer;
    use crate::rd::rustdesk::{self as r, RustdeskParams, TwoFactorAnswer};

    fn params(password: &str) -> RustdeskParams {
        RustdeskParams { host: host("DBKIT_RUSTDESK_IT_HOST"), port: 21118, password: password.into(), rendezvous: None, hwid: String::new(), trusted: false }
    }

    /// 有給密碼的連線不會問（沒有 `waiting_accept`）。
    fn no_ask(_: bool) -> std::future::Ready<Option<AuthAnswer>> {
        std::future::ready(None)
    }

    /// 測試用的被控端沒開雙重驗證：不會問驗證碼。
    fn no_2fa(_: bool, _: bool) -> std::future::Ready<Option<TwoFactorAnswer>> {
        std::future::ready(None)
    }

    /// 沒給密碼：對方畫面跳出「接受」、db-kit 問密碼；答了密碼就在同一條連線補送登入（真的被控端認不認）。
    #[tokio::test]
    #[ignore]
    async fn rustdesk_password_entered_while_waiting_for_accept() {
        let asked = std::sync::atomic::AtomicBool::new(false);
        let c = r::connect(&params(""), Duration::from_secs(30), |_| {
            asked.store(true, std::sync::atomic::Ordering::SeqCst);
            std::future::ready(Some(AuthAnswer { username: String::new(), password: "dbkit123".into(), remember: false }))
        }, no_2fa)
        .await
        .expect("登入");
        assert!(asked.load(std::sync::atomic::Ordering::SeqCst), "沒密碼要問");
        assert_eq!(c.answered.as_ref().map(|a| a.password.as_str()), Some("dbkit123"));
        assert!(c.size.0 > 0 && c.size.1 > 0, "{:?}", c.size);
    }

    /// 啟動輔助程式 → 登入 → 工作階段迴圈把影像轉給 sink → 使用者斷線。
    #[tokio::test]
    #[ignore]
    async fn rustdesk_login_and_video_via_bridge() {
        let c = r::connect(&params("dbkit123"), Duration::from_secs(30), no_ask, no_2fa).await.expect("登入");
        assert!(c.size.0 > 0 && c.size.1 > 0, "{:?}", c.size);
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let sink: r::Sink = Arc::new(move |m| {
            let _ = tx.send(m);
        });
        let task = tokio::spawn(r::run(c, ctl_rx, sink));
        let first = tokio::time::timeout(T, rx.recv()).await.unwrap().unwrap();
        assert_eq!(first[0], 1, "第一則是 connected 事件");
        let mut video = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while video.is_none() && tokio::time::Instant::now() < deadline {
            if let Ok(Some(m)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                if m[0] == 2 {
                    video = Some(m);
                }
            }
        }
        let v = video.expect("要收到影像");
        assert!(v[1] == 1 || v[1] == 2, "VP9 / VP8");
        // 輸入：一個滑鼠移動（格式錯的 JSON 也不能讓它斷線）
        ctl_tx.send(RdCtl::Write(br#"{"t":"mouse","mask":0,"x":10,"y":10}"#.to_vec())).unwrap();
        ctl_tx.send(RdCtl::Write(b"not json".to_vec())).unwrap();
        ctl_tx.send(RdCtl::Refresh).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        ctl_tx.send(RdCtl::Close).unwrap();
        assert_eq!(tokio::time::timeout(T, task).await.unwrap().unwrap(), None, "使用者斷線 = 沒有原因");
    }

    fn id_params(key: &str) -> RustdeskParams {
        RustdeskParams {
            host: std::env::var("DBKIT_RUSTDESK_IT_ID").expect("DBKIT_RUSTDESK_IT_ID"),
            port: 0,
            password: "dbkit123".into(),
            rendezvous: Some(r::Rendezvous { server: host("DBKIT_RUSTDESK_IT_SERVER"), key: key.into(), ..Default::default() }),
            hwid: String::new(),
            trusted: false,
        }
    }

    /// 用 RustDesk ID：經 ID 伺服器找到對方、接上、驗過公鑰後加密。
    #[tokio::test]
    #[ignore]
    async fn rustdesk_id_via_rendezvous_is_encrypted() {
        let key = std::env::var("DBKIT_RUSTDESK_IT_KEY").expect("DBKIT_RUSTDESK_IT_KEY");
        let c = r::connect(&id_params(&key), Duration::from_secs(60), no_ask, no_2fa).await.expect("登入");
        assert!(c.secure, "驗過對方公鑰 → 加密");
        assert!(["relay", "direct", "lan"].contains(&c.route.as_str()), "{}", c.route);
        assert!(c.size.0 > 0 && c.size.1 > 0, "{:?}", c.size);
    }

    /// Key 填錯：ID 伺服器直接拒絕，錯誤是看得懂的句子（是一般錯誤，不會被當成密碼錯而一直重問密碼）。
    #[tokio::test]
    #[ignore]
    async fn rustdesk_id_wrong_key_is_readable() {
        let bad = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        match r::connect(&id_params(bad), Duration::from_secs(60), no_ask, no_2fa).await.err().unwrap() {
            AppError::Rd(m) => assert!(m.contains("Key"), "{m}"),
            e => panic!("{e:?}"),
        }
    }

    #[tokio::test]
    #[ignore]
    async fn rustdesk_wrong_password_is_auth_error() {
        let e = r::connect(&params("nope"), Duration::from_secs(30), no_ask, no_2fa).await.err().unwrap();
        assert!(matches!(e, AppError::RdAuth(_)), "{e:?}");
    }
}
