//! 對 Docker OpenSSH 的整合測試（預設 `#[ignore]`）。
//!
//! ```text
//! docker run -d --name dbkit-ssh -p 2222:2222 -e PUID=1000 -e PGID=1000 -e USER_NAME=dbkit \
//!   -e USER_PASSWORD=dbkit123 -e PASSWORD_ACCESS=true -e SUDO_ACCESS=false \
//!   lscr.io/linuxserver/openssh-server:latest
//! cargo test --no-default-features --lib ssh::it_tests -- --ignored
//! ```
//! 環境變數 `DBKIT_SSH_IT_HOST` / `_PORT` / `_USER` / `_PASS` 可覆寫目標。
//! known_hosts 用臨時檔，不碰使用者真正的信任清單。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use super::auth::{connect_and_auth, SilentUi, SshTarget, TargetOrigin};
use super::known_hosts::KnownHostsStore;
use super::runtime::SshConn;
use super::sessions::{SshAuthKind, SshTermOptions};
use super::sftp::SftpClient;
use super::terminal::{TermEvent, TermHandle, TermOpen, TermSink};
use crate::error::AppError;

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string())
}

fn target() -> SshTarget {
    SshTarget {
        host: env_or("DBKIT_SSH_IT_HOST", "127.0.0.1"),
        port: env_or("DBKIT_SSH_IT_PORT", "2222").parse().unwrap(),
        username: env_or("DBKIT_SSH_IT_USER", "dbkit"),
        auth: SshAuthKind::Password,
        password: env_or("DBKIT_SSH_IT_PASS", "dbkit123"),
        private_key_path: String::new(),
        passphrase: String::new(),
        term: SshTermOptions { keepalive_secs: 5, ..Default::default() },
        origin: TargetOrigin::AdHoc,
    }
}

fn tmp_store() -> KnownHostsStore {
    let d = std::env::temp_dir().join(format!("dbkit-ssh-it-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    KnownHostsStore::at(d.join("ssh_known_hosts.json"))
}

async fn connect() -> Arc<SshConn> {
    let t = target();
    let c = connect_and_auth(&t, "it", Arc::new(SilentUi), tmp_store())
        .await
        .expect("connect_and_auth");
    Arc::new(SshConn::new("it".into(), &t, c))
}

/// 收 sink 事件的 mpsc。
fn sink() -> (TermSink, mpsc::UnboundedReceiver<TermEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let s: TermSink = Arc::new(move |ev| {
        let _ = tx.send(ev);
    });
    (s, rx)
}

/// 等到累積輸出含 `needle`（或逾時 panic）。回傳目前累積的輸出。
async fn wait_for(rx: &mut mpsc::UnboundedReceiver<TermEvent>, acc: &mut Vec<u8>, needle: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if String::from_utf8_lossy(acc).contains(needle) {
            return;
        }
        let ev = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .unwrap_or_else(|_| panic!("等待 {needle:?} 逾時；目前輸出：{}", String::from_utf8_lossy(acc)))
            .expect("sink 已關");
        match ev {
            TermEvent::Data(d) => acc.extend_from_slice(&d),
            TermEvent::Exit { .. } => panic!("shell 提前結束；輸出：{}", String::from_utf8_lossy(acc)),
        }
    }
}

#[tokio::test]
#[ignore = "需要 Docker OpenSSH:2222"]
async fn password_auth_pty_echo_resize_exit() {
    let conn = connect().await;
    let (s, mut rx) = sink();
    let term = TermHandle::open(
        conn.clone(),
        TermOpen {
            cols: 80,
            rows: 24,
            term: "xterm-256color".into(),
            env: Default::default(),
            startup_command: "echo dbkit-startup".into(),
        },
        s,
    )
    .await
    .expect("open term");
    let mut acc = Vec::new();
    // 啟動指令的輸出
    wait_for(&mut rx, &mut acc, "dbkit-startup").await;
    // 回聲 + 算術：shell 真的在跑
    term.send_line("echo dbkit-$((1+1))").await.unwrap();
    wait_for(&mut rx, &mut acc, "dbkit-2").await;
    // resize 後 COLUMNS 會變
    term.resize(132, 40).await.unwrap();
    term.send_line("stty size").await.unwrap();
    wait_for(&mut rx, &mut acc, "40 132").await;
    // exit → Exit{Some(0)}
    term.write(b"exit 0\r").await.unwrap();
    let exit = loop {
        match tokio::time::timeout(Duration::from_secs(15), rx.recv()).await.unwrap() {
            Some(TermEvent::Data(_)) => {}
            Some(e @ TermEvent::Exit { .. }) => break e,
            None => panic!("sink 關閉前沒有 Exit"),
        }
    };
    assert_eq!(exit, TermEvent::Exit { status: Some(0), signal: None });
    term.close().await;
    let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
}

#[tokio::test]
#[ignore = "需要 Docker OpenSSH:2222"]
async fn sftp_roundtrip_with_byte_compare() {
    let conn = connect().await;
    let (sftp, home) = SftpClient::open(&conn).await.expect("sftp open");
    assert!(home.starts_with('/'), "home 應是絕對路徑：{home}");

    let dir = format!("{home}/dbkit-it-{}", uuid::Uuid::new_v4());
    sftp.mkdir(&dir).await.unwrap();
    let st = sftp.stat(&dir).await.unwrap();
    assert!(st.is_dir);
    assert!(st.mode.starts_with('d'), "{}", st.mode);

    // 3 MiB 偽隨機內容（LCG，免依賴）
    let mut data = vec![0u8; 3 * 1024 * 1024];
    let mut x: u32 = 0x1234_5678;
    for b in data.iter_mut() {
        x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *b = (x >> 24) as u8;
    }
    let local_dir = std::env::temp_dir().join(format!("dbkit-sftp-it-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_dir).unwrap();
    let src = local_dir.join("src.bin");
    std::fs::write(&src, &data).unwrap();

    let remote = format!("{dir}/blob.bin");
    let progressed = Arc::new(AtomicBool::new(false));
    let p2 = progressed.clone();
    sftp.upload(&src, &remote, false, Box::new(move |_, _| p2.store(true, Ordering::Relaxed)), &AtomicBool::new(false))
        .await
        .expect("upload");
    assert!(progressed.load(Ordering::Relaxed));
    // !overwrite 再傳一次 → 失敗
    let err = sftp
        .upload(&src, &remote, false, Box::new(|_, _| {}), &AtomicBool::new(false))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Sftp(_)), "{err:?}");

    let list = sftp.list_dir(&dir).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "blob.bin");
    assert_eq!(list[0].size, data.len() as u64);
    assert!(!list[0].is_dir);

    let dst = local_dir.join("dst.bin");
    let out = sftp
        .download(&remote, &dst, false, Box::new(|_, _| {}), &AtomicBool::new(false))
        .await
        .expect("download");
    assert_eq!(out, dst);
    assert_eq!(std::fs::read(&dst).unwrap(), data, "上傳 / 下載內容一致");
    assert!(!local_dir.join("dst.bin.part").exists());

    // 下載到目錄 → 用遠端檔名
    let out = sftp
        .download(&remote, &local_dir, true, Box::new(|_, _| {}), &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!(out, local_dir.join("blob.bin"));

    // read_small 截斷
    let txt = sftp.read_small(&remote, 100).await.unwrap();
    assert!(txt.truncated);
    assert_eq!(txt.size, data.len() as u64);

    // rename / 巢狀目錄 / 遞迴刪除
    let renamed = format!("{dir}/moved.bin");
    sftp.rename(&remote, &renamed).await.unwrap();
    let sub = format!("{dir}/sub/deeper");
    sftp.mkdir(&format!("{dir}/sub")).await.unwrap();
    sftp.mkdir(&sub).await.unwrap();
    sftp.upload(&src, &format!("{sub}/x.bin"), true, Box::new(|_, _| {}), &AtomicBool::new(false))
        .await
        .unwrap();
    let err = sftp.remove(&dir, false).await.unwrap_err();
    assert!(matches!(err, AppError::Sftp(_)), "非空目錄不遞迴應失敗：{err:?}");
    sftp.remove(&dir, true).await.unwrap();
    assert!(sftp.stat(&dir).await.is_err(), "遞迴刪除後目錄應消失");
    assert!(matches!(sftp.remove("/", true).await, Err(AppError::Sftp(_))));

    sftp.close().await;
    let _ = std::fs::remove_dir_all(&local_dir);
    let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
}

#[tokio::test]
#[ignore = "需要 Docker OpenSSH:2222"]
async fn cancelled_download_leaves_no_part_file() {
    let conn = connect().await;
    let (sftp, home) = SftpClient::open(&conn).await.unwrap();
    let dir = format!("{home}/dbkit-it-cancel-{}", uuid::Uuid::new_v4());
    sftp.mkdir(&dir).await.unwrap();
    let local_dir = std::env::temp_dir().join(format!("dbkit-sftp-cancel-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_dir).unwrap();
    let src = local_dir.join("big.bin");
    std::fs::write(&src, vec![7u8; 8 * 1024 * 1024]).unwrap();
    let remote = format!("{dir}/big.bin");
    sftp.upload(&src, &remote, true, Box::new(|_, _| {}), &AtomicBool::new(false)).await.unwrap();

    // 第一次進度回報後就取消
    let cancel = Arc::new(AtomicBool::new(false));
    let c2 = cancel.clone();
    let dst = local_dir.join("big.copy");
    let err = sftp
        .download(&remote, &dst, true, Box::new(move |done, _| {
            if done > 0 {
                c2.store(true, Ordering::Relaxed);
            }
        }), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::SshCancelled), "{err:?}");
    assert!(!dst.exists(), "取消不該留下目標檔");
    assert!(!local_dir.join("big.copy.part").exists(), "取消不該留下 .part");

    // 上傳取消：遠端不留半成品
    let cancel = Arc::new(AtomicBool::new(false));
    let c2 = cancel.clone();
    let remote2 = format!("{dir}/big2.bin");
    let err = sftp
        .upload(&src, &remote2, true, Box::new(move |done, _| {
            if done > 0 {
                c2.store(true, Ordering::Relaxed);
            }
        }), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::SshCancelled), "{err:?}");
    assert!(sftp.stat(&remote2).await.is_err(), "取消上傳不該留下遠端檔");

    sftp.remove(&dir, true).await.unwrap();
    sftp.close().await;
    let _ = std::fs::remove_dir_all(&local_dir);
    let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
}

/// Xftp「編輯」與「權限」：新增檔案 → 讀回 → 覆寫（權限與擁有者不能被換掉）→ chmod → 非 UTF-8 標 lossy。
#[tokio::test]
#[ignore = "需要 Docker OpenSSH:2222"]
async fn sftp_edit_text_and_chmod() {
    let conn = connect().await;
    let (sftp, home) = SftpClient::open(&conn).await.expect("sftp open");
    let dir = format!("{home}/dbkit-it-edit-{}", uuid::Uuid::new_v4());
    sftp.mkdir(&dir).await.unwrap();
    let path = format!("{dir}/app.conf");

    // 新增：create_new 對不存在的檔成功，第二次（已存在）必須失敗，不能蓋掉別人的檔。
    let st = sftp.write_text(&path, "listen 80;\n", true).await.expect("create");
    assert_eq!(st.size, 11);
    assert!(sftp.write_text(&path, "x", true).await.is_err(), "create_new 不該覆蓋既有檔");

    // chmod 0640 → 讀回的權限位元一致；型別位元（一般檔）保留。
    let st = sftp.chmod(&path, 0o640).await.expect("chmod");
    assert_eq!(st.permissions.map(|p| p & 0o7777), Some(0o640), "{:?}", st.permissions);
    assert!(st.mode.starts_with("-rw-r-----"), "{}", st.mode);

    // 覆寫（編輯存檔）：內容換掉、長度縮短也不留尾巴，權限維持 0640（沒有被換成新檔的預設權限）。
    let st = sftp.write_text(&path, "listen 8080;\nserver_name 範例;\n", false).await.expect("overwrite");
    let back = sftp.read_small(&path, 0).await.unwrap();
    assert_eq!(back.text, "listen 8080;\nserver_name 範例;\n");
    assert!(!back.lossy && !back.binary && !back.truncated);
    assert_eq!(st.permissions.map(|p| p & 0o7777), Some(0o640), "直接覆寫不該換掉權限");
    let st = sftp.write_text(&path, "a\n", false).await.unwrap();
    assert_eq!(st.size, 2, "TRUNCATE：變短不留舊內容的尾巴");

    // 檔案在編輯途中被刪掉：不帶 CREATE，存檔要失敗而不是默默重建。
    let gone = format!("{dir}/gone.txt");
    assert!(sftp.write_text(&gone, "x", false).await.is_err(), "不存在的檔不該被當成編輯目標重建");

    // 非 UTF-8（Big5 的「中」= a4 a4）→ lossy；NUL → binary。原始位元組經本機暫存檔上傳。
    let local_dir = std::env::temp_dir().join(format!("dbkit-sftp-edit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_dir).unwrap();
    let put = |name: &str, bytes: &[u8]| {
        let p = local_dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    };
    let no_cancel = AtomicBool::new(false);
    let big5 = format!("{dir}/big5.txt");
    sftp.upload(&put("big5.txt", &[0xa4, 0xa4, b'\n']), &big5, true, Box::new(|_, _| {}), &no_cancel)
        .await
        .unwrap();
    let t = sftp.read_small(&big5, 0).await.unwrap();
    assert!(t.lossy, "Big5 內容要標 lossy，前端才會只給唯讀");
    let bin = format!("{dir}/blob.bin");
    sftp.upload(&put("blob.bin", b"\x7fELF\0\x02\x01"), &bin, true, Box::new(|_, _| {}), &no_cancel)
        .await
        .unwrap();
    assert!(sftp.read_small(&bin, 0).await.unwrap().binary);

    sftp.remove(&dir, true).await.unwrap();
    sftp.close().await;
    let _ = std::fs::remove_dir_all(&local_dir);
    let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
}
