//! 自動更新：從 GitHub Release 下載這台電腦用的安裝檔、驗 SHA-256，裝好後把 App 重新開起來。
//!
//! 有沒有新版由前端查（`src/updateCheck.ts`，直打 GitHub API）；這裡只管「裝」。安裝方式照 Tauri 官方
//! updater 外掛：
//! - Windows：NSIS 安裝檔 `/P /UPDATE /R`（只顯示進度、更新模式、裝完重開；被動模式下安裝程式會自己
//!   關掉還在跑的 App），MSI 用 `msiexec /i … /passive AUTOLAUNCHAPP=True`（裝在 Program Files，
//!   Windows 會跳 UAC）。交給安裝程式後關閉 App。
//! - Linux AppImage：新的 AppImage 換掉原本那個檔（同一個路徑），重新啟動。
//! - Linux .deb / .rpm：`pkexec dpkg -i` / `pkexec rpm -U`（系統會跳出輸入密碼的視窗），裝完重新啟動。
//!
//! macOS / 開發版 / 免安裝版不支援自動安裝，前端改開 Release 頁面讓使用者自己下載。
//!
//! 下載網址只接受這個專案 Release 的下載路徑；GitHub API 給的 `digest`（`sha256:…`）一定要有、
//! 而且要對得上才安裝。下載中斷 / 卡住時用 HTTP Range 續傳（慢的網路抓幾十 MB 常會斷一兩次）。

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
    #[serde(rename = "appimage")]
    AppImage,
    Deb,
    Rpm,
}

/// 下載進度（`total` 0 = 不知道大小）。`installing` = 下載完、正在安裝（.deb / .rpm 這時會跳出輸入密碼的視窗）。
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    downloaded: u64,
    total: u64,
    installing: bool,
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

/// 目前這份 App 能不能自動安裝更新；`None` = 不行（macOS / 開發版 / 免安裝版）。
/// Linux 要問套件管理員這支程式是不是它裝的，不在主執行緒做。
#[tauri::command]
pub async fn update_support() -> Option<InstallKind> {
    tokio::task::spawn_blocking(install_kind).await.ok().flatten()
}

/// 下載 `version` 的安裝檔、驗證後安裝，接著關閉 App（Windows 由安裝程式裝完重開；Linux 在這裡裝好、
/// 重新啟動）。進度走 `on_progress`。
#[tauri::command]
pub async fn update_install(app: AppHandle, version: String, on_progress: Channel<UpdateProgress>) -> AppResult<()> {
    let unsupported = || AppError::Update(t!("這個安裝方式不支援自動更新，請到 GitHub 下載安裝檔").into());
    let kind = tokio::task::spawn_blocking(install_kind).await.ok().flatten().ok_or_else(unsupported)?;
    let progress = |p: UpdateProgress| {
        let _ = on_progress.send(p);
    };
    let path = download_installer(&version, kind, std::env::consts::ARCH, &progress).await?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    progress(UpdateProgress { downloaded: size, total: size, installing: true });
    let installed = tokio::task::spawn_blocking(move || install(kind, &path))
        .await
        .map_err(|e| AppError::Update(e.to_string()))??;
    // 讓這次 invoke 的回應先送回前端，再走正常的關閉流程（RunEvent::Exit 會關掉所有連線與輔助程式，
    // 安裝程式才換得掉它們的檔案）。Linux 已經裝好：關閉後用新版重新啟動（AppImage 會啟動換好的那個檔）。
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        match installed {
            Installed::ByInstaller => app.exit(0),
            Installed::Done => app.request_restart(),
        }
    });
    Ok(())
}

/// `install` 做到哪：交給安裝程式（它會關掉 App、裝完重開）/ 已經裝好（App 自己重新啟動）。
enum Installed {
    ByInstaller,
    Done,
}

fn install(kind: InstallKind, path: &Path) -> AppResult<Installed> {
    match kind {
        InstallKind::Nsis | InstallKind::Msi => launch_installer(kind, path).map(|()| Installed::ByInstaller),
        InstallKind::AppImage => replace_appimage(path).map(|()| Installed::Done),
        InstallKind::Deb | InstallKind::Rpm => install_package(kind, path).map(|()| Installed::Done),
    }
}

/// 查 `version` 的 Release、挑出 `kind` / `arch` 的安裝檔，下載到暫存資料夾並驗過 SHA-256，回傳檔案路徑。
/// `arch` 是 `std::env::consts::ARCH` 的寫法（`x86_64` / `aarch64`）。
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
    on_progress(UpdateProgress { downloaded, total, installing: false });
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
                        on_progress(UpdateProgress { downloaded, total, installing: false });
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
    on_progress(UpdateProgress { downloaded, total: total.max(downloaded), installing: false });
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

/// 這種安裝檔在 Release 裡的檔名結尾（`arch` 是 `std::env::consts::ARCH` 的寫法）。各家對架構的叫法不同：
/// `DB.Kit_0.57.4_x64-setup.exe` / `DB.Kit_0.57.4_x64_en-US.msi` / `DB.Kit_0.57.4_amd64.AppImage` /
/// `DB.Kit_0.57.4_amd64.deb` / `DB.Kit-0.57.4-1.x86_64.rpm`（ARM 是 arm64 / aarch64 / arm64 / aarch64）。
fn asset_matches(name: &str, kind: InstallKind, arch: &str) -> bool {
    let windows = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let debian = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    let appimage = match arch {
        "x86_64" => "amd64",
        other => other,
    };
    match kind {
        InstallKind::Nsis => name.ends_with(&format!("_{windows}-setup.exe")),
        InstallKind::Msi => name.ends_with(".msi") && name.contains(&format!("_{windows}_")),
        InstallKind::AppImage => name.ends_with(&format!("_{appimage}.AppImage")),
        InstallKind::Deb => name.ends_with(&format!("_{debian}.deb")),
        InstallKind::Rpm => name.ends_with(&format!(".{arch}.rpm")),
    }
}

fn pick_asset<'a>(assets: &'a [Asset], kind: InstallKind, arch: &str) -> Option<&'a Asset> {
    assets.iter().find(|a| asset_matches(&a.name, kind, arch))
}

/// 這份 App 是怎麼裝的；不是自動更新裝得了的（macOS、`cargo run`、免安裝版）→ `None`。
fn install_kind() -> Option<InstallKind> {
    if cfg!(windows) {
        let exe = std::env::current_exe().ok()?;
        let program_files: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
            .collect();
        kind_for(&exe, &program_files)
    } else if cfg!(target_os = "linux") {
        linux_kind(std::env::var_os("APPIMAGE").map(PathBuf::from).as_deref(), &std::env::current_exe().ok()?, &|cmd, exe| {
            std::process::Command::new(cmd[0])
                .args(&cmd[1..])
                .arg(exe)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
    } else {
        None
    }
}

/// Windows：NSIS（目前使用者）會在安裝資料夾留 `uninstall.exe`；MSI 裝在 Program Files、沒有那支。
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

/// Linux：從 AppImage 啟動時，AppImage 的 runtime 會把 AppImage 檔本身的路徑放在 `APPIMAGE`；
/// 否則問 dpkg / rpm 這支程式是不是它們裝的（`owned_by(["dpkg-query", "-S"], exe)` = 指令成功）。
fn linux_kind(appimage: Option<&Path>, exe: &Path, owned_by: &dyn Fn(&[&str], &Path) -> bool) -> Option<InstallKind> {
    if appimage.is_some_and(Path::is_file) {
        return Some(InstallKind::AppImage);
    }
    if owned_by(&["dpkg-query", "-S"], exe) {
        return Some(InstallKind::Deb);
    }
    if owned_by(&["rpm", "-qf"], exe) {
        return Some(InstallKind::Rpm);
    }
    None
}

/// 用下載好的 AppImage 換掉正在跑的這個（`APPIMAGE` 指的檔）：先複製到同一個資料夾的暫存檔、設成可執行，
/// 再 rename 蓋過去（同一個檔案系統上是原子的，換到一半不會留下壞掉的 AppImage）。正在跑的這份已經掛載起來，
/// 檔案被換掉不受影響。
fn replace_appimage(new: &Path) -> AppResult<()> {
    let target = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Update(t!("這個安裝方式不支援自動更新，請到 GitHub 下載安裝檔").into()))?;
    replace_file(new, &target)
}

fn replace_file(new: &Path, target: &Path) -> AppResult<()> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.update"));
    let err = |e: std::io::Error| {
        let _ = std::fs::remove_file(&tmp);
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            AppError::Update(tf!("沒有權限寫入 {dir}，請到 GitHub 下載新版 AppImage 自行替換", dir = dir.display()))
        } else {
            AppError::Update(tf!("替換 AppImage 失敗：{e}", e = e))
        }
    };
    std::fs::copy(new, &tmp).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
    }
    std::fs::rename(&tmp, target).map_err(err)?;
    let _ = std::fs::remove_file(new);
    Ok(())
}

/// 用系統的套件管理員裝 .deb / .rpm：要系統管理員權限，經 pkexec 跳出輸入密碼的視窗（Ubuntu / Fedora
/// 桌面都有）。等它裝完才回來。
fn install_package(kind: InstallKind, path: &Path) -> AppResult<()> {
    let (program, args): (&str, &[&str]) = match kind {
        InstallKind::Deb => ("dpkg", &["-i"]),
        InstallKind::Rpm => ("rpm", &["-U"]),
        _ => return Err(AppError::Update(t!("這個安裝方式不支援自動更新，請到 GitHub 下載安裝檔").into())),
    };
    let status = std::process::Command::new("pkexec")
        .arg(program)
        .args(args)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Update(t!("找不到 pkexec，無法取得系統管理員權限安裝更新，請到 GitHub 下載安裝檔").into())
            } else {
                AppError::Update(tf!("無法啟動安裝程式：{e}", e = e))
            }
        })?;
    package_result(program, status.code())
}

/// pkexec 的結束代碼：成功時是被執行的程式自己的代碼；126 = 使用者關掉了輸入密碼的視窗；
/// 127 = 沒有授權（密碼錯、沒有輸入密碼的視窗可跳）。
fn package_result(program: &str, code: Option<i32>) -> AppResult<()> {
    match code {
        Some(0) => Ok(()),
        Some(126) => Err(AppError::Update(t!("已取消安裝：沒有輸入系統管理員密碼").into())),
        Some(127) => Err(AppError::Update(t!("沒有取得系統管理員權限，無法安裝更新").into())),
        Some(c) => Err(AppError::Update(tf!("{program} 安裝失敗（結束代碼 {code}）", program = program, code = c))),
        None => Err(AppError::Update(tf!("{program} 安裝中途被中斷", program = program))),
    }
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
        InstallKind::AppImage | InstallKind::Deb | InstallKind::Rpm => {
            return Err(AppError::Update(t!("這個安裝方式不支援自動更新，請到 GitHub 下載安裝檔").into()))
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

    /// v0.57.4 Release 實際的檔名。
    #[test]
    fn picks_the_installer_for_this_install_kind() {
        let assets: Vec<Asset> = [
            "DB.Kit-0.57.4-1.x86_64.rpm",
            "DB.Kit_0.57.4_aarch64.dmg",
            "DB.Kit_0.57.4_amd64.AppImage",
            "DB.Kit_0.57.4_amd64.deb",
            "DB.Kit_0.57.4_x64-setup.exe",
            "DB.Kit_0.57.4_x64.dmg",
            "DB.Kit_0.57.4_x64_en-US.msi",
            "DB.Kit_aarch64.app.tar.gz",
            "DB.Kit_x64.app.tar.gz",
        ]
        .into_iter()
        .map(asset)
        .collect();
        let pick = |kind, arch| pick_asset(&assets, kind, arch).map(|a| a.name.as_str());
        assert_eq!(pick(InstallKind::Nsis, "x86_64"), Some("DB.Kit_0.57.4_x64-setup.exe"));
        assert_eq!(pick(InstallKind::Msi, "x86_64"), Some("DB.Kit_0.57.4_x64_en-US.msi"));
        assert_eq!(pick(InstallKind::AppImage, "x86_64"), Some("DB.Kit_0.57.4_amd64.AppImage"));
        assert_eq!(pick(InstallKind::Deb, "x86_64"), Some("DB.Kit_0.57.4_amd64.deb"));
        assert_eq!(pick(InstallKind::Rpm, "x86_64"), Some("DB.Kit-0.57.4-1.x86_64.rpm"));
        for kind in [InstallKind::Nsis, InstallKind::Msi, InstallKind::AppImage, InstallKind::Deb, InstallKind::Rpm] {
            assert!(pick(kind, "aarch64").is_none(), "{kind:?}：沒有 ARM 版就不裝 x64 的");
        }
    }

    /// ARM 版各家的叫法（Tauri 打包 aarch64 時的檔名）。
    #[test]
    fn arm_asset_names() {
        assert!(asset_matches("DB.Kit_1.0.0_arm64-setup.exe", InstallKind::Nsis, "aarch64"));
        assert!(asset_matches("DB.Kit_1.0.0_aarch64.AppImage", InstallKind::AppImage, "aarch64"));
        assert!(asset_matches("DB.Kit_1.0.0_arm64.deb", InstallKind::Deb, "aarch64"));
        assert!(asset_matches("DB.Kit-1.0.0-1.aarch64.rpm", InstallKind::Rpm, "aarch64"));
        assert!(!asset_matches("DB.Kit_1.0.0_amd64.deb", InstallKind::Deb, "aarch64"));
    }

    #[test]
    fn linux_install_kind() {
        let tmp = std::env::temp_dir().join(format!("dbkit-update-linux-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let appimage = tmp.join("DB.Kit_0.57.4_amd64.AppImage");
        std::fs::write(&appimage, b"").unwrap();
        let exe = Path::new("/usr/bin/db-kit");
        let asked = std::sync::Mutex::new(Vec::new());
        let log = &asked;
        let only = |owner: &'static str| {
            move |cmd: &[&str], p: &Path| {
                log.lock().unwrap().push(format!("{} {}", cmd.join(" "), p.display()));
                cmd[0] == owner
            }
        };
        assert_eq!(linux_kind(Some(appimage.as_path()), exe, &only("dpkg-query")), Some(InstallKind::AppImage), "AppImage 優先");
        assert!(asked.lock().unwrap().is_empty(), "從 AppImage 啟動就不必問套件管理員");
        assert_eq!(linux_kind(Some(tmp.join("gone.AppImage").as_path()), exe, &only("dpkg-query")), Some(InstallKind::Deb), "APPIMAGE 指的檔不在就不算");
        assert_eq!(linux_kind(None, exe, &only("rpm")), Some(InstallKind::Rpm));
        assert_eq!(linux_kind(None, Path::new("/home/me/db-kit/target/debug/db-kit"), &only("none")), None, "開發版 / 免安裝版");
        assert_eq!(asked.lock().unwrap()[0], "dpkg-query -S /usr/bin/db-kit");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn replaces_the_appimage_in_place() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("dbkit-update-appimage-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("dl")).unwrap();
        let target = tmp.join("DB.Kit_0.57.4_amd64.AppImage");
        std::fs::write(&target, b"old").unwrap();
        let new = tmp.join("dl").join("DB.Kit_0.58.0_amd64.AppImage");
        std::fs::write(&new, b"new version").unwrap();
        replace_file(&new, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new version");
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755, "可執行");
        assert!(!new.exists(), "下載的那份刪掉");
        let left: Vec<_> = std::fs::read_dir(&tmp).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 2, "沒有留下暫存檔：{left:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn package_manager_exit_codes() {
        assert!(package_result("dpkg", Some(0)).is_ok());
        let msg = |code| match package_result("dpkg", code) {
            Err(AppError::Update(m)) => m,
            other => panic!("{code:?}: {other:?}"),
        };
        // 不比對字面：其他測試會暫時切換介面語言。
        assert_ne!(msg(Some(126)), msg(Some(127)), "關掉輸入密碼的視窗 ≠ 沒有授權");
        assert!(msg(Some(1)).contains("dpkg") && msg(Some(1)).contains('1'));
        assert!(msg(None).contains("dpkg"));
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
            let path = download_installer("v0.43.1", kind, "x86_64", &|p| calls.lock().unwrap().push(p))
                .await
                .unwrap_or_else(|e| panic!("{kind:?}: {e}"));
            let len = std::fs::metadata(&path).unwrap().len();
            let calls = calls.into_inner().unwrap();
            let last = calls.last().unwrap();
            eprintln!("{kind:?}: {} ({len} bytes, {} progress events)", path.display(), calls.len());
            assert!(len > 10 << 20, "{len}");
            assert_eq!((last.downloaded, last.total), (len, len), "最後一則進度 = 檔案大小");
        }
        assert!(download_installer("0.0.0-nope", InstallKind::Nsis, "x86_64", &|_| {}).await.is_err(), "沒有這個 Release");
    }

    #[test]
    fn file_names_are_sanitised() {
        assert_eq!(safe_file_name("DB.Kit_0.44.0_x64-setup.exe"), "DB.Kit_0.44.0_x64-setup.exe");
        assert_eq!(safe_file_name("..\\..\\evil.exe"), ".._.._evil.exe");
        assert_eq!(safe_file_name(".."), "db-kit-update.bin");
        assert_eq!(hex(&[0, 0xab, 0x10]), "00ab10");
    }
}
