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
use super::sftp::{local_conflicts, OnConflict, SftpClient};
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

/// 資料夾遞迴：本機樹上傳 → 遠端結構一致 → 整棵下載回另一處 → 逐檔內容一致；
/// 已存在且未允許覆蓋要失敗；允許覆蓋時合併；中途取消回 SshCancelled。
#[tokio::test]
#[ignore = "需要 Docker OpenSSH:2222"]
async fn sftp_tree_upload_download_roundtrip() {
    let conn = connect().await;
    let (sftp, home) = SftpClient::open(&conn).await.expect("sftp open");
    let tmp = std::env::temp_dir().join(format!("dbkit-sftp-tree-{}", uuid::Uuid::new_v4()));
    let src = tmp.join("site");
    std::fs::create_dir_all(src.join("css")).unwrap();
    std::fs::create_dir_all(src.join("js/vendor")).unwrap();
    std::fs::create_dir_all(src.join("empty")).unwrap();
    std::fs::write(src.join("index.html"), b"<h1>hi</h1>\n").unwrap();
    std::fs::write(src.join("css/app.css"), b"body{margin:0}\n").unwrap();
    std::fs::write(src.join("js/vendor/lib.js"), vec![b'x'; 200_000]).unwrap();
    std::fs::write(src.join("中文檔名.txt"), "內容".as_bytes()).unwrap();

    let remote_root = format!("{home}/dbkit-it-tree-{}", uuid::Uuid::new_v4());
    let no_cancel = AtomicBool::new(false);
    let last = Arc::new(std::sync::Mutex::new((0u64, None::<u64>)));
    let l2 = last.clone();
    let r = sftp
        .upload_tree(&src, &remote_root, false, Box::new(move |d, t| *l2.lock().unwrap() = (d, t)), &no_cancel)
        .await
        .expect("upload_tree");
    assert_eq!(r, remote_root);
    let total = 12 + 15 + 200_000 + "內容".len() as u64;
    assert_eq!(*last.lock().unwrap(), (total, Some(total)), "進度最後要到 100%");
    let names: Vec<String> = sftp.list_dir(&remote_root).await.unwrap().into_iter().map(|e| e.name).collect();
    for n in ["css", "js", "empty", "index.html", "中文檔名.txt"] {
        assert!(names.contains(&n.to_string()), "遠端少了 {n}：{names:?}");
    }
    assert_eq!(sftp.stat(&format!("{remote_root}/js/vendor/lib.js")).await.unwrap().size, 200_000);

    // 已存在、未允許覆蓋 → 失敗；允許覆蓋 → 合併成功
    assert!(sftp.upload_tree(&src, &remote_root, false, Box::new(|_, _| {}), &no_cancel).await.is_err());
    sftp.upload_tree(&src, &remote_root, true, Box::new(|_, _| {}), &no_cancel).await.expect("merge");

    // 整棵下載到另一個本機資料夾（給既有資料夾 → 放進去成 <dst>/<遠端資料夾名>）
    let dst = tmp.join("dl");
    std::fs::create_dir_all(&dst).unwrap();
    let got = sftp.download_tree(&remote_root, &dst, false, Box::new(|_, _| {}), &no_cancel).await.expect("download_tree");
    assert_eq!(got, dst.join(super::sftp::basename(&remote_root)));
    for rel in ["index.html", "css/app.css", "js/vendor/lib.js", "中文檔名.txt"] {
        assert_eq!(std::fs::read(got.join(rel)).unwrap(), std::fs::read(src.join(rel)).unwrap(), "{rel} 內容不一致");
    }
    assert!(got.join("empty").is_dir(), "空資料夾也要建");
    // 再下載一次、未允許覆蓋 → 失敗（本機已有同名資料夾）
    assert!(sftp.download_tree(&remote_root, &dst, false, Box::new(|_, _| {}), &no_cancel).await.is_err());

    // 中途取消
    let cancel = Arc::new(AtomicBool::new(false));
    let c2 = cancel.clone();
    let err = sftp
        .download_tree(&remote_root, &tmp.join("dl2"), false, Box::new(move |d, _| if d > 0 { c2.store(true, Ordering::Relaxed) }), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::SshCancelled), "{err:?}");

    sftp.remove(&remote_root, true).await.unwrap();
    sftp.close().await;
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
}

/// 多選批次：檔案 + 資料夾混合上傳成一個工作 → 遠端都在；再傳一次，Fail 整批不動、Skip 全略過、
/// Overwrite 合併；批次下載回本機（同名檢查與實際下載用同一套檔名）→ 逐檔內容一致；
/// 下載時本機已有其中一項 → Skip 只傳其餘的。
#[tokio::test]
#[ignore = "需要 Docker OpenSSH:2222"]
async fn sftp_batch_many_with_conflicts() {
    let conn = connect().await;
    let (sftp, home) = SftpClient::open(&conn).await.expect("sftp open");
    let tmp = std::env::temp_dir().join(format!("dbkit-sftp-batch-{}", uuid::Uuid::new_v4()));
    let src = tmp.join("src");
    std::fs::create_dir_all(src.join("conf.d/extra")).unwrap();
    std::fs::write(src.join("a.txt"), b"alpha\n").unwrap();
    std::fs::write(src.join("b.log"), vec![b'b'; 150_000]).unwrap();
    std::fs::write(src.join("conf.d/site.conf"), b"server {}\n").unwrap();
    std::fs::write(src.join("conf.d/extra/x.conf"), b"# x\n").unwrap();

    let remote_dir = format!("{home}/dbkit-it-batch-{}", uuid::Uuid::new_v4());
    sftp.mkdir(&remote_dir).await.unwrap();
    let no_cancel = AtomicBool::new(false);
    let locals = vec![src.join("a.txt"), src.join("b.log"), src.join("conf.d")];
    let last = Arc::new(std::sync::Mutex::new((0u64, None::<u64>)));
    let l2 = last.clone();
    let sum = sftp
        .upload_many(&locals, &remote_dir, OnConflict::Fail, Box::new(move |d, t| *l2.lock().unwrap() = (d, t)), &no_cancel)
        .await
        .expect("upload_many");
    assert_eq!(sum.files, 4);
    assert_eq!(sum.message(), None);
    let total = 6 + 150_000 + 10 + 4;
    assert_eq!(*last.lock().unwrap(), (total, Some(total)), "一條合併的進度，最後到 100%");
    assert_eq!(sftp.stat(&format!("{remote_dir}/conf.d/extra/x.conf")).await.unwrap().size, 4);

    // 再傳一次：Fail 整批不開始、Skip 全部略過、Overwrite 合併
    let err = sftp.upload_many(&locals, &remote_dir, OnConflict::Fail, Box::new(|_, _| {}), &no_cancel).await.unwrap_err();
    assert!(matches!(err, AppError::Sftp(_)), "{err:?}");
    let sum = sftp.upload_many(&locals, &remote_dir, OnConflict::Skip, Box::new(|_, _| {}), &no_cancel).await.unwrap();
    assert_eq!((sum.files, sum.skipped_existing), (0, 3));
    assert!(sum.message().is_some());
    std::fs::write(src.join("a.txt"), b"alpha v2\n").unwrap();
    let sum = sftp.upload_many(&locals, &remote_dir, OnConflict::Overwrite, Box::new(|_, _| {}), &no_cancel).await.unwrap();
    assert_eq!((sum.files, sum.skipped_existing), (4, 0));

    // 批次下載回本機
    let dst = tmp.join("dst");
    std::fs::create_dir_all(&dst).unwrap();
    let remotes: Vec<String> = ["a.txt", "b.log", "conf.d"].iter().map(|n| format!("{remote_dir}/{n}")).collect();
    let names: Vec<String> = ["a.txt", "b.log", "conf.d"].iter().map(|n| n.to_string()).collect();
    assert!(local_conflicts(&dst, &names).await.is_empty());
    let sum = sftp.download_many(&remotes, &dst, OnConflict::Fail, Box::new(|_, _| {}), &no_cancel).await.expect("download_many");
    assert_eq!(sum.files, 4);
    for rel in ["a.txt", "b.log", "conf.d/site.conf", "conf.d/extra/x.conf"] {
        assert_eq!(std::fs::read(dst.join(rel)).unwrap(), std::fs::read(src.join(rel)).unwrap(), "{rel} 內容不一致");
    }
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"alpha v2\n", "Overwrite 要真的換掉遠端內容");

    // 本機已有其中兩項：同名檢查列得出來；Fail 不動、Skip 只傳剩下的
    std::fs::remove_file(dst.join("b.log")).unwrap();
    assert_eq!(local_conflicts(&dst, &names).await, vec!["a.txt".to_string(), "conf.d".to_string()]);
    assert!(sftp.download_many(&remotes, &dst, OnConflict::Fail, Box::new(|_, _| {}), &no_cancel).await.is_err());
    assert!(!dst.join("b.log").exists(), "Fail 時一個檔都不能傳");
    let sum = sftp.download_many(&remotes, &dst, OnConflict::Skip, Box::new(|_, _| {}), &no_cancel).await.unwrap();
    assert_eq!((sum.files, sum.skipped_existing), (1, 2));
    assert_eq!(std::fs::read(dst.join("b.log")).unwrap().len(), 150_000);

    // 中途取消
    let cancel = Arc::new(AtomicBool::new(false));
    let c2 = cancel.clone();
    let err = sftp
        .download_many(&remotes, &tmp.join("dst2"), OnConflict::Fail, Box::new(move |d, _| if d > 0 { c2.store(true, Ordering::Relaxed) }), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::SshCancelled), "{err:?}");

    sftp.remove(&remote_dir, true).await.unwrap();
    sftp.close().await;
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
}
