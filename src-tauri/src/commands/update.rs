//! 自動更新：從 GitHub Release 下載這台電腦用的安裝檔、驗 SHA-256，交給安裝程式後關閉 App，
//! 安裝程式裝完會把 App 重新開起來。
//!
//! 有沒有新版由前端查（`src/updateCheck.ts`，直打 GitHub API）；這裡只管「裝」。安裝參數照 Tauri 官方
//! updater 外掛：NSIS 安裝檔 `/P /UPDATE /R`（只顯示進度、更新模式、裝完重開；被動模式下安裝程式會自己
//! 關掉還在跑的 App），MSI 用 `msiexec /i … /passive AUTOLAUNCHAPP=True`（裝在 Program Files，
//! Windows 會跳 UAC）。macOS / Linux / 開發版不支援自動安裝，前端改開 Release 頁面讓使用者自己下載。
//!
//! 下載網址只接受這個專案 Release 的下載路徑；GitHub API 給的 `digest`（`sha256:…`）一定要有、
//! 而且要對得上才執行。下載中斷 / 卡住時用 HTTP Range 續傳（慢的網路抓幾十 MB 常會斷一兩次）。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};

const REPO: &str = "markku636/db-kit";

/// 這份 App 是用哪種安裝檔裝的（決定下載哪個檔、怎麼安裝）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    Nsis,
    Msi,
}

/// 下載進度（`total` 0 = 不知道大小）。
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    downloaded: u64,
    total: u64,
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Clone, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    /// `sha256:<hex>`（GitHub 自己算的）。
    #[serde(default)]
    digest: Option<String>,
}

/// 目前這份 App 能不能自動安裝更新；`None` = 不行（macOS / Linux / 開發版 / 免安裝版）。
#[tauri::command]
pub fn update_support() -> Option<InstallKind> {
    install_kind()
}

/// 下載 `version` 的安裝檔、驗證後啟動安裝程式，接著關閉 App。進度走 `on_progress`。
#[tauri::command]
pub async fn update_install(app: AppHandle, version: String, on_progress: Channel<UpdateProgress>) -> AppResult<()> {
    let kind = install_kind().ok_or_else(|| AppError::Update(t!("這個安裝方式不支援自動更新，請到 GitHub 下載安裝檔").into()))?;
    let path = download_installer(&version, kind, arch(), &|p| {
        let _ = on_progress.send(p);
    })
    .await?;
    launch_installer(kind, &path)?;
    // 讓這次 invoke 的回應先送回前端，再走正常的關閉流程（RunEvent::Exit 會關掉所有連線與輔助程式，
    // 安裝程式才換得掉它們的檔案）。
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        app.exit(0);
    });
    Ok(())
}

/// 查 `version` 的 Release、挑出 `kind` / `arch` 的安裝檔，下載到暫存資料夾並驗過 SHA-256，回傳檔案路徑。
async fn download_installer(
    version: &str,
    kind: InstallKind,
    arch: &str,
    progress: &(dyn Fn(UpdateProgress) + Sync),
) -> AppResult<PathBuf> {
    let version = version.trim().trim_start_matches(['v', 'V']).to_string();
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err(AppError::Update(tf!("版本號格式不對：{v}", v = version)));
    }
    let client = http_client()?;
    let release: Release = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/tags/v{version}"))
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Update(tf!("查不到 v{v} 的 Release：{e}", v = version, e = e)))?
        .json()
        .await
        .map_err(|e| AppError::Update(e.to_string()))?;
    let asset = pick_asset(&release.assets, kind, arch)
        .ok_or_else(|| AppError::Update(tf!("{tag} 沒有這台電腦用的安裝檔", tag = release.tag_name)))?
        .clone();
    if !asset.browser_download_url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        return Err(AppError::Update(tf!("安裝檔的下載網址不對：{u}", u = asset.browser_download_url)));
    }
    let want = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| AppError::Update(t!("GitHub 沒有提供安裝檔的 SHA-256，無法確認檔案完整，已取消更新").into()))?;

    let dir = std::env::temp_dir().join("db-kit-update");
    // 上次留下的安裝檔先清掉（裝完的安裝程式不會自己刪）。
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Update(e.to_string()))?;
    let path = dir.join(safe_file_name(&asset.name));
    let got = download(&client, &asset.browser_download_url, asset.size, &path, progress).await?;
    if got != want {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(AppError::Update(t!("下載的安裝檔 SHA-256 對不上，可能下載不完整或被竄改，已取消更新").into()));
    }
    Ok(path)
}

fn http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("db-kit/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        // 下載卡住（沒有資料進來）就當斷線，交給續傳。
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Update(e.to_string()))
}

/// 斷線後續傳的次數上限（安裝檔幾十 MB，慢的網路常會斷一兩次）。
const MAX_RESUMES: u32 = 5;

/// 串流下載到 `path`，邊下載邊算 SHA-256（回傳小寫 hex）。連線中斷 / 卡住 / 提早結束時用 HTTP Range
/// 從斷掉的地方接著下載；伺服器不支援續傳（回 200 而不是 206）就從頭來。
async fn download(
    client: &reqwest::Client,
    url: &str,
    size_hint: u64,
    path: &Path,
    on_progress: &(dyn Fn(UpdateProgress) + Sync),
) -> AppResult<String> {
    use tokio::io::AsyncSeekExt;
    let err = |e: &dyn std::fmt::Display| AppError::Update(tf!("下載安裝檔失敗：{e}", e = e));
    let mut file = tokio::fs::File::create(path).await.map_err(|e| err(&e))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut total = size_hint;
    let mut resumes = 0u32;
    let mut last = Instant::now();
    on_progress(UpdateProgress { downloaded, total });
    loop {
        let mut req = client.get(url);
        if downloaded > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
        }
        let failure: String = match req.send().await.and_then(|r| r.error_for_status()) {
            Err(e) => e.to_string(),
            Ok(resp) => {
                if downloaded > 0 && resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                    file.set_len(0).await.map_err(|e| err(&e))?;
                    file.seek(std::io::SeekFrom::Start(0)).await.map_err(|e| err(&e))?;
                    hasher = Sha256::new();
                    downloaded = 0;
                }
                if downloaded == 0 {
                    total = resp.content_length().unwrap_or(size_hint);
                }
                let mut stream = resp.bytes_stream();
                let mut broke = None;
                while let Some(chunk) = stream.next().await {
                    let chunk = match chunk {
                        Ok(c) => c,
                        Err(e) => {
                            broke = Some(e.to_string());
                            break;
                        }
                    };
                    hasher.update(&chunk);
                    file.write_all(&chunk).await.map_err(|e| err(&e))?;
                    downloaded += chunk.len() as u64;
                    if last.elapsed() >= Duration::from_millis(100) {
                        last = Instant::now();
                        on_progress(UpdateProgress { downloaded, total });
                    }
                }
                match broke {
                    Some(e) => e,
                    None if total > 0 && downloaded < total => format!("connection closed at {downloaded} / {total} bytes"),
                    None => break,
                }
            }
        };
        if resumes >= MAX_RESUMES {
            return Err(err(&failure));
        }
        resumes += 1;
        tokio::time::sleep(Duration::from_secs(u64::from(resumes))).await;
    }
    file.flush().await.map_err(|e| err(&e))?;
    drop(file);
    on_progress(UpdateProgress { downloaded, total: total.max(downloaded) });
    Ok(hex(&hasher.finalize()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 檔名只留安全字元（Release 的檔名本來就是 `DB.Kit_0.44.0_x64-setup.exe` 這種）。
fn safe_file_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    if s.trim_matches('.').is_empty() { "db-kit-update.bin".into() } else { s }
}

/// Release 安裝檔名裡的架構：`DB.Kit_0.44.0_x64-setup.exe` / `DB.Kit_0.44.0_x64_en-US.msi`。
fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "x86",
        other => other,
    }
}

fn pick_asset<'a>(assets: &'a [Asset], kind: InstallKind, arch: &str) -> Option<&'a Asset> {
    let nsis = format!("_{arch}-setup.exe");
    let msi = format!("_{arch}_");
    assets.iter().find(|a| match kind {
        InstallKind::Nsis => a.name.ends_with(&nsis),
        InstallKind::Msi => a.name.ends_with(".msi") && a.name.contains(&msi),
    })
}

/// 安裝方式看 App 裝在哪：NSIS（目前使用者）會在安裝資料夾留 `uninstall.exe`；
/// MSI 裝在 Program Files、沒有那支；兩者都不是（`cargo run`、免安裝版）就不自動更新。
fn install_kind() -> Option<InstallKind> {
    if !cfg!(windows) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let program_files: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
        .collect();
    kind_for(&exe, &program_files)
}

fn kind_for(exe: &Path, program_files: &[PathBuf]) -> Option<InstallKind> {
    let dir = exe.parent()?;
    if dir.join("uninstall.exe").is_file() {
        return Some(InstallKind::Nsis);
    }
    let lower = |p: &Path| p.to_string_lossy().to_lowercase();
    let exe_l = lower(exe);
    program_files
        .iter()
        .any(|pf| !pf.as_os_str().is_empty() && exe_l.starts_with(&format!("{}\\", lower(pf).trim_end_matches('\\'))))
        .then_some(InstallKind::Msi)
}

#[cfg(windows)]
fn launch_installer(kind: InstallKind, path: &Path) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let mut cmd = match kind {
        InstallKind::Nsis => {
            let mut c = std::process::Command::new(path);
            c.args(["/P", "/UPDATE", "/R"]);
            c
        }
        InstallKind::Msi => {
            let msiexec = std::env::var_os("SYSTEMROOT")
                .map(|r| PathBuf::from(r).join("System32").join("msiexec.exe"))
                .unwrap_or_else(|| PathBuf::from("msiexec.exe"));
            let mut c = std::process::Command::new(msiexec);
            c.arg("/i").arg(path).args(["/passive", "/promptrestart", "AUTOLAUNCHAPP=True"]);
            c
        }
    };
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::Update(tf!("無法啟動安裝程式：{e}", e = e)))
}

#[cfg(not(windows))]
fn launch_installer(_: InstallKind, _: &Path) -> AppResult<()> {
    Err(AppError::Update(t!("這個安裝方式不支援自動更新，請到 GitHub 下載安裝檔").into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> Asset {
        Asset {
            name: name.into(),
            browser_download_url: format!("https://github.com/{REPO}/releases/download/v0.44.0/{name}"),
            size: 1,
            digest: Some("sha256:00".into()),
        }
    }

    /// v0.43.1 Release 實際的檔名。
    #[test]
    fn picks_the_installer_for_this_install_kind() {
        let assets: Vec<Asset> = [
            "DB.Kit-0.43.1-1.x86_64.rpm",
            "DB.Kit_0.43.1_aarch64.dmg",
            "DB.Kit_0.43.1_amd64.AppImage",
            "DB.Kit_0.43.1_x64-setup.exe",
            "DB.Kit_0.43.1_x64_en-US.msi",
            "DB.Kit_x64.app.tar.gz",
        ]
        .into_iter()
        .map(asset)
        .collect();
        assert_eq!(pick_asset(&assets, InstallKind::Nsis, "x64").map(|a| a.name.as_str()), Some("DB.Kit_0.43.1_x64-setup.exe"));
        assert_eq!(pick_asset(&assets, InstallKind::Msi, "x64").map(|a| a.name.as_str()), Some("DB.Kit_0.43.1_x64_en-US.msi"));
        assert!(pick_asset(&assets, InstallKind::Nsis, "arm64").is_none(), "沒有 ARM 版就不裝 x64 的");
    }

    #[test]
    fn install_kind_from_location() {
        let tmp = std::env::temp_dir().join(format!("dbkit-update-test-{}", std::process::id()));
        let nsis = tmp.join("nsis");
        std::fs::create_dir_all(&nsis).unwrap();
        std::fs::write(nsis.join("uninstall.exe"), b"").unwrap();
        let pf = vec![PathBuf::from("C:\\Program Files"), PathBuf::new()];
        assert_eq!(kind_for(&nsis.join("db-kit.exe"), &pf), Some(InstallKind::Nsis));
        assert_eq!(kind_for(Path::new("C:\\Program Files\\DB Kit\\db-kit.exe"), &pf), Some(InstallKind::Msi));
        assert_eq!(kind_for(Path::new("c:\\program files\\DB Kit\\db-kit.exe"), &pf), Some(InstallKind::Msi), "不分大小寫");
        assert_eq!(kind_for(Path::new("C:\\Program Files Extra\\db-kit.exe"), &pf), None, "要是 Program Files 底下");
        assert_eq!(kind_for(Path::new("D:\\projects\\db-kit\\src-tauri\\target\\debug\\db-kit.exe"), &pf), None, "開發版");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 本機假下載伺服器：第一個連線送一半就斷線；之後的連線看 Range 回 206 剩下的（`ranges` = 是否支援續傳，
    /// 不支援時一律回 200 整個檔）。回傳每次請求帶的 Range 起點。
    async fn flaky_server(body: Vec<u8>, ranges: bool) -> (std::net::SocketAddr, tokio::task::JoinHandle<Vec<Option<usize>>>) {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for n in 0..2 {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut req = Vec::new();
                let mut buf = [0u8; 1024];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    let k = s.read(&mut buf).await.unwrap();
                    if k == 0 {
                        break;
                    }
                    req.extend_from_slice(&buf[..k]);
                }
                let req = String::from_utf8_lossy(&req).to_lowercase();
                let from = req
                    .lines()
                    .find_map(|l| l.strip_prefix("range: bytes="))
                    .and_then(|r| r.trim().trim_end_matches('-').parse::<usize>().ok());
                seen.push(from);
                let len = body.len();
                match from.filter(|_| ranges) {
                    Some(f) => {
                        let head = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {f}-{}/{len}\r\nConnection: close\r\n\r\n",
                            len - f,
                            len - 1
                        );
                        s.write_all(head.as_bytes()).await.unwrap();
                        s.write_all(&body[f..]).await.unwrap();
                    }
                    None => {
                        let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n");
                        s.write_all(head.as_bytes()).await.unwrap();
                        // 第一次只送一半就斷線。
                        s.write_all(if n == 0 { &body[..len / 2] } else { &body[..] }).await.unwrap();
                    }
                }
                let _ = s.shutdown().await;
            }
            seen
        });
        (addr, task)
    }

    #[tokio::test]
    async fn resumes_after_the_connection_drops() {
        let data: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        for ranges in [true, false] {
            let (addr, server) = flaky_server(data.clone(), ranges).await;
            let path = std::env::temp_dir().join(format!("dbkit-update-resume-{}-{ranges}.bin", std::process::id()));
            let last = std::sync::Mutex::new(None);
            let got = download(&http_client().unwrap(), &format!("http://{addr}/x"), 0, &path, &|p| {
                *last.lock().unwrap() = Some((p.downloaded, p.total));
            })
            .await
            .unwrap_or_else(|e| panic!("ranges={ranges}: {e}"));
            assert_eq!(got, hex(&Sha256::digest(&data)), "ranges={ranges}");
            assert_eq!(std::fs::read(&path).unwrap(), data, "ranges={ranges}：檔案內容完整、沒有重複");
            let n = data.len() as u64;
            assert_eq!(last.into_inner().unwrap(), Some((n, n)));
            // 支援續傳：第二次從一半接著抓；不支援：伺服器回 200，從頭重抓。
            assert_eq!(server.await.unwrap(), vec![None, Some(data.len() / 2)], "ranges={ranges}");
            let _ = std::fs::remove_file(&path);
        }
    }

    /// 對真的 GitHub Release（v0.43.1）：挑出 NSIS / MSI 安裝檔、下載、SHA-256 跟 GitHub 給的對得上
    /// （不執行安裝程式）。`cargo test --features gui --lib -- --ignored real_release`
    #[tokio::test]
    #[ignore]
    async fn real_release_download_matches_digest() {
        for kind in [InstallKind::Nsis, InstallKind::Msi] {
            let calls = std::sync::Mutex::new(Vec::new());
            let path = download_installer("v0.43.1", kind, "x64", &|p| calls.lock().unwrap().push(p))
                .await
                .unwrap_or_else(|e| panic!("{kind:?}: {e}"));
            let len = std::fs::metadata(&path).unwrap().len();
            let calls = calls.into_inner().unwrap();
            let last = calls.last().unwrap();
            eprintln!("{kind:?}: {} ({len} bytes, {} progress events)", path.display(), calls.len());
            assert!(len > 10 << 20, "{len}");
            assert_eq!((last.downloaded, last.total), (len, len), "最後一則進度 = 檔案大小");
        }
        assert!(download_installer("0.0.0-nope", InstallKind::Nsis, "x64", &|_| {}).await.is_err(), "沒有這個 Release");
    }

    #[test]
    fn file_names_are_sanitised() {
        assert_eq!(safe_file_name("DB.Kit_0.44.0_x64-setup.exe"), "DB.Kit_0.44.0_x64-setup.exe");
        assert_eq!(safe_file_name("..\\..\\evil.exe"), ".._.._evil.exe");
        assert_eq!(safe_file_name(".."), "db-kit-update.bin");
        assert_eq!(hex(&[0, 0xab, 0x10]), "00ab10");
    }
}
