//! 對 Docker FTP 伺服器的整合測試（預設 `#[ignore]`）。兩種伺服器各跑一次，涵蓋兩條列表路徑：
//! vsftpd 沒有 `MLSD`（走 `LIST` 解析），而且資料連線預設要求沿用控制連線的 TLS session；
//! pure-ftpd 有 `MLSD`。兩台都開 explicit FTPS（自簽憑證 → 走指紋 TOFU）。
//!
//! ```text
//! docker run -d --name dbkit-vsftpd -p 2121:21 -p 21000-21010:21000-21010 \
//!   -e USERS="dbkit|dbkit123" -e ADDRESS=127.0.0.1 -e MIN_PORT=21000 -e MAX_PORT=21010 \
//!   -e TLS_CERT=/etc/ssl/dbkit/cert.pem -e TLS_KEY=/etc/ssl/dbkit/key.pem \
//!   -v <含 cert.pem / key.pem 的資料夾>:/etc/ssl/dbkit:ro delfer/alpine-ftp-server
//! docker run -d --name dbkit-pureftpd -p 2122:21 -p 30000-30009:30000-30009 \
//!   -e PUBLICHOST=127.0.0.1 -e FTP_USER_NAME=dbkit -e FTP_USER_PASS=dbkit123 \
//!   -e FTP_USER_HOME=/home/dbkit -e ADDED_FLAGS="--tls=1" -e TLS_CN=localhost \
//!   -e TLS_ORG=dbkit -e TLS_C=TW -e TLS_USE_DSAPRAM=true stilliard/pure-ftpd
//! cargo test --no-default-features --lib ssh::ftp_it_tests -- --ignored
//! ```
//! 在 Git Bash 下 `docker run` 要加 `MSYS_NO_PATHCONV=1`，否則 `FTP_USER_HOME=/home/dbkit` 會被改寫成 Windows 路徑、
//! pure-ftpd 的帳號建不起來。vsftpd 映像偶爾啟動後 daemon 沒在跑（`docker exec dbkit-vsftpd ps` 看不到 `vsftpd -o…`），
//! 照 `/bin/start_vsftpd.sh` 最後那行的參數在容器裡手動再啟動一次即可。
//! 環境變數 `DBKIT_FTP_IT_{VSFTPD,PUREFTPD}_{HOST,PORT,USER,PASS,TLS}` 可覆寫目標（TLS = none / explicit / implicit）。
//! known_hosts 用臨時檔，不碰使用者真正的信任清單。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::auth::{SilentUi, TargetOrigin};
use super::ftp::{connect_and_login, FtpClient, FtpConn, FtpTarget};
use super::known_hosts::KnownHostsStore;
use super::sessions::{FtpOptions, FtpTls};
use super::sftp::{self, remote_join, OnConflict, ProgressFn, RemoteFs};
use crate::error::AppError;

const MIB: usize = 1024 * 1024;

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string())
}

fn target(name: &str, port: u16) -> FtpTarget {
    let v = |k: &str, d: &str| env_or(&format!("DBKIT_FTP_IT_{name}_{k}"), d);
    FtpTarget {
        host: v("HOST", "127.0.0.1"),
        port: v("PORT", &port.to_string()).parse().unwrap(),
        username: v("USER", "dbkit"),
        password: v("PASS", "dbkit123"),
        opts: FtpOptions {
            tls: match v("TLS", "explicit").as_str() {
                "none" => FtpTls::None,
                "implicit" => FtpTls::Implicit,
                _ => FtpTls::Explicit,
            },
            active: false,
        },
        connect_timeout: Duration::from_secs(10),
        origin: TargetOrigin::AdHoc,
        pinned_cert: None,
    }
}

fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("dbkit-ftp-it-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn tmp_store() -> KnownHostsStore {
    KnownHostsStore::at(tmp_dir("kh").join("ssh_known_hosts.json"))
}

fn bytes(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 131 % 251) as u8).collect()
}

fn noop() -> ProgressFn {
    Box::new(|_, _| {})
}

/// 記下第一次進度回報的位置（續傳從哪裡開始）。
fn first_progress() -> (Arc<std::sync::Mutex<Option<u64>>>, ProgressFn) {
    let first = Arc::new(std::sync::Mutex::new(None::<u64>));
    let f2 = first.clone();
    (first, Box::new(move |d, _| {
        f2.lock().unwrap().get_or_insert(d);
    }))
}

/// 進度超過 `at` 就立起取消旗標。
fn cancel_after(at: u64, flag: Arc<AtomicBool>) -> ProgressFn {
    Box::new(move |d, _| {
        if d >= at {
            flag.store(true, Ordering::Relaxed);
        }
    })
}

async fn open(t: &FtpTarget) -> (Arc<FtpConn>, FtpClient, String) {
    let (t, initial) = connect_and_login(t, "it", &SilentUi, &tmp_store()).await.expect("登入");
    if t.opts.tls != FtpTls::None {
        assert!(t.pinned_cert.is_some(), "自簽憑證要走指紋 TOFU");
    }
    let conn = Arc::new(FtpConn::new("it".into(), t, initial));
    let (client, home) = FtpClient::open(&conn).await.expect("開瀏覽連線");
    (conn, client, home)
}

async fn roundtrip(t: FtpTarget) {
    let (_conn, client, home) = open(&t).await;
    let dir = remote_join(&home, &format!("dbkit-it-{}", uuid::Uuid::new_v4())).unwrap();
    client.mkdir(&dir).await.expect("mkdir");

    // ---- 小檔：新增 / 讀 / 改名 / 屬性 ----
    let a = format!("{dir}/a b.txt");
    let text = "hello\n世界\n";
    let e = client.write_text(&a, text, true).await.expect("write_text");
    assert_eq!(e.size, text.len() as u64);
    assert!(client.write_text(&a, "x", true).await.is_err(), "新增檔案不可蓋掉既有的");
    assert_eq!(client.read_small(&a, 0).await.unwrap().text, text);
    let cut = client.read_small(&a, 3).await.unwrap();
    assert!(cut.truncated && cut.text == "hel", "{cut:?}");
    client.write_text(&a, "edited", false).await.expect("存回");
    assert_eq!(client.read_small(&a, 0).await.unwrap().text, "edited", "截斷預覽之後連線要能繼續用");
    let b = format!("{dir}/b.txt");
    client.rename(&a, &b).await.expect("rename");
    let names: Vec<String> = client.list_dir(&dir).await.unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, vec!["b.txt".to_string()]);
    let st = client.stat(&b).await.expect("stat");
    assert!(!st.is_dir && st.size == 6 && st.path == b, "{st:?}");
    assert!(client.stat(&dir).await.unwrap().is_dir);
    // chmod：伺服器不一定支援（回錯就算了）；支援又回得出權限的話要真的變了
    if let Ok(e) = client.chmod(&b, 0o640).await {
        if let Some(p) = e.permissions {
            assert_eq!(p & 0o777, 0o640, "{e:?}");
        }
    }

    // ---- 大檔上下傳 ----
    let data = bytes(12 * MIB);
    let local = tmp_dir("data");
    let src = local.join("src.bin");
    std::fs::write(&src, &data).unwrap();
    let never = AtomicBool::new(false);
    let fs = client.transfer_session(&never).await.expect("傳輸連線");
    let remote = format!("{dir}/big.bin");
    fs.upload(&src, &remote, OnConflict::Fail, noop(), &never).await.expect("upload");
    assert!(fs.upload(&src, &remote, OnConflict::Fail, noop(), &never).await.is_err(), "Fail：遠端已存在");
    fs.upload(&src, &remote, OnConflict::Skip, noop(), &never).await.expect("Skip：什麼都不做");
    let dst = local.join("big.dl");
    fs.download(&remote, &dst, OnConflict::Fail, noop(), &never).await.expect("download");
    assert!(std::fs::read(&dst).unwrap() == data);
    assert_eq!(fs.kind_follow(&remote).await.unwrap(), (sftp::Kind::File, data.len() as u64));

    // ---- 續傳下載 ----
    let part = local.join("big.dl.part");
    std::fs::remove_file(&dst).unwrap();
    std::fs::write(&part, &data[..5 * MIB]).unwrap();
    let (first, p) = first_progress();
    fs.download(&remote, &dst, OnConflict::Fail, p, &never).await.expect("續傳下載");
    assert_eq!(*first.lock().unwrap(), Some(5 * MIB as u64), "從 .part 的結尾接著傳");
    assert!(std::fs::read(&dst).unwrap() == data, "續傳後內容要與遠端一致");
    assert!(!part.exists());
    // .part 不是這個檔的前半段 → 從頭
    std::fs::remove_file(&dst).unwrap();
    std::fs::write(&part, vec![0xaau8; MIB]).unwrap();
    let (first, p) = first_progress();
    fs.download(&remote, &dst, OnConflict::Fail, p, &never).await.unwrap();
    assert_eq!(*first.lock().unwrap(), Some(0));
    assert!(std::fs::read(&dst).unwrap() == data);
    // Resume：本機已經是完整的檔 → 略過
    let (first, p) = first_progress();
    fs.download(&remote, &dst, OnConflict::Resume, p, &never).await.unwrap();
    assert_eq!(*first.lock().unwrap(), Some(data.len() as u64));

    // ---- 續傳上傳 ----
    let up = format!("{dir}/up.bin");
    let half = local.join("half.bin");
    std::fs::write(&half, &data[..5 * MIB]).unwrap();
    fs.upload(&half, &up, OnConflict::Fail, noop(), &never).await.unwrap();
    let (first, p) = first_progress();
    fs.upload(&src, &up, OnConflict::Resume, p, &never).await.expect("續傳上傳");
    assert_eq!(*first.lock().unwrap(), Some(5 * MIB as u64), "從遠端的結尾接著寫");
    let back = local.join("up.back");
    fs.download(&up, &back, OnConflict::Overwrite, noop(), &never).await.unwrap();
    assert!(std::fs::read(&back).unwrap() == data, "續傳上傳後遠端內容要一致");
    // 已經一樣 → 略過
    let (first, p) = first_progress();
    fs.upload(&src, &up, OnConflict::Resume, p, &never).await.unwrap();
    assert_eq!(*first.lock().unwrap(), Some(data.len() as u64));
    // 遠端內容對不上 → 從頭重寫，而不是接在別人的內容後面
    std::fs::write(&half, vec![0x55u8; MIB]).unwrap();
    fs.upload(&half, &up, OnConflict::Overwrite, noop(), &never).await.unwrap();
    let (first, p) = first_progress();
    fs.upload(&src, &up, OnConflict::Resume, p, &never).await.unwrap();
    assert_eq!(*first.lock().unwrap(), Some(0));
    fs.download(&up, &back, OnConflict::Overwrite, noop(), &never).await.unwrap();
    assert!(std::fs::read(&back).unwrap() == data);

    // ---- 取消：上傳到一半 → 遠端不留檔；下載到一半 → 不留 .part（之後同一條連線照常可用）----
    let flag = Arc::new(AtomicBool::new(false));
    let cancelled = format!("{dir}/cancelled.bin");
    let err = fs.upload(&src, &cancelled, OnConflict::Fail, cancel_after(2 * MIB as u64, flag.clone()), &flag).await.unwrap_err();
    assert!(matches!(err, AppError::SshCancelled), "{err:?}");
    assert!(client.stat(&cancelled).await.is_err(), "取消的上傳不留半個檔");
    let flag = Arc::new(AtomicBool::new(false));
    let dst2 = local.join("cancelled.dl");
    // 本機下載太快，節流過的進度回報來不及到 2 MiB：一開始（第一次進度回報）就取消，照樣要清掉 .part。
    let err = fs.download(&remote, &dst2, OnConflict::Fail, cancel_after(0, flag.clone()), &flag).await.unwrap_err();
    assert!(matches!(err, AppError::SshCancelled), "{err:?}");
    assert!(!dst2.exists() && !local.join("cancelled.dl.part").exists(), "取消的下載不留 .part");

    // ---- 資料夾與多選 ----
    let tree = local.join("tree");
    std::fs::create_dir_all(tree.join("sub/deeper")).unwrap();
    std::fs::write(tree.join("x.txt"), b"xx").unwrap();
    std::fs::write(tree.join("sub/deeper/y.bin"), bytes(300 * 1024)).unwrap();
    let rtree = format!("{dir}/tree");
    sftp::upload_tree(&fs, &tree, &rtree, OnConflict::Fail, noop(), &never).await.expect("upload_tree");
    assert!(sftp::upload_tree(&fs, &tree, &rtree, OnConflict::Fail, noop(), &never).await.is_err());
    let got = sftp::download_tree(&fs, &rtree, &local.join("back-tree"), OnConflict::Fail, noop(), &never).await.expect("download_tree");
    assert_eq!(std::fs::read(got.join("x.txt")).unwrap(), b"xx");
    assert!(std::fs::read(got.join("sub/deeper/y.bin")).unwrap() == bytes(300 * 1024));
    let sum = sftp::upload_many(&fs, &[tree.clone(), src.clone()], &dir, OnConflict::Skip, noop(), &never).await.unwrap();
    assert_eq!((sum.skipped_existing, sum.files), (1, 1), "tree 已存在 → 略過；src.bin 是新的");
    let many = local.join("many");
    let sum = sftp::download_many(&fs, &[rtree.clone(), remote.clone()], &many, OnConflict::Fail, noop(), &never).await.unwrap();
    assert_eq!(sum.files, 3);
    assert!(std::fs::read(many.join("big.bin")).unwrap() == data);
    assert!(many.join("tree/sub/deeper/y.bin").exists());

    // ---- 同時：瀏覽 + 兩條傳輸連線；第三條要等名額（等待中可以取消）----
    let fs2 = client.transfer_session(&never).await.expect("第二條傳輸連線");
    let (p1, p2) = (local.join("p1.bin"), local.join("p2.bin"));
    let (r1, r2, r3) = tokio::join!(
        fs.download(&remote, &p1, OnConflict::Fail, noop(), &never),
        fs2.download(&remote, &p2, OnConflict::Fail, noop(), &never),
        client.list_dir(&dir),
    );
    r1.expect("並行下載 1");
    r2.expect("並行下載 2");
    assert!(r3.expect("傳輸時照樣可以瀏覽").iter().any(|e| e.name == "big.bin"));
    let stop = AtomicBool::new(true);
    let third = tokio::time::timeout(Duration::from_secs(5), client.transfer_session(&stop)).await.expect("等名額時要能取消");
    assert!(matches!(third, Err(AppError::SshCancelled)), "名額用完：排隊，取消就結束");
    drop(fs2);
    tokio::time::timeout(Duration::from_secs(10), client.transfer_session(&never)).await.expect("放掉一條就有名額").unwrap();

    // ---- 瀏覽連線斷掉 → 下一個操作自動重連 ----
    client.close().await;
    assert!(client.list_dir(&dir).await.is_ok(), "關掉的瀏覽連線要自動重連");

    client.remove(&dir, true).await.expect("遞迴刪除");
    assert!(client.stat(&dir).await.is_err());
    assert!(matches!(client.remove("/", true).await, Err(AppError::Ftp(_))), "拒絕刪根目錄");
    let _ = std::fs::remove_dir_all(&local);
}

async fn wrong_password(mut t: FtpTarget) {
    t.password = "definitely-wrong".into();
    let err = connect_and_login(&t, "it", &SilentUi, &tmp_store()).await.err().expect("密碼錯要失敗");
    match err {
        AppError::Ftp(m) => assert!(m.contains("登入失敗"), "{m}"),
        e => panic!("{e:?}"),
    }
}

#[tokio::test]
#[ignore]
async fn vsftpd_roundtrip() {
    roundtrip(target("VSFTPD", 2121)).await;
}

#[tokio::test]
#[ignore]
async fn vsftpd_wrong_password() {
    wrong_password(target("VSFTPD", 2121)).await;
}

#[tokio::test]
#[ignore]
async fn pureftpd_roundtrip() {
    roundtrip(target("PUREFTPD", 2122)).await;
}

#[tokio::test]
#[ignore]
async fn pureftpd_wrong_password() {
    wrong_password(target("PUREFTPD", 2122)).await;
}

/// 憑證換掉（指紋與信任過的不同）→ 沒人可以問的時候拒絕連線，不會默默接受。
#[tokio::test]
#[ignore]
async fn changed_certificate_is_rejected() {
    let mut t = target("VSFTPD", 2121);
    if t.opts.tls == FtpTls::None {
        return;
    }
    let store = tmp_store();
    store.record(&t.cert_host_id(), "SHA256:not-the-real-fingerprint").unwrap();
    t.pinned_cert = None;
    let err = connect_and_login(&t, "it", &SilentUi, &store).await.err().expect("指紋不同要拒絕");
    assert!(matches!(err, AppError::SshHostKey(_)), "{err:?}");
}
