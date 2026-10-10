//! db-kit 的 Linux 更新小幫手：以 root 安裝比目前新的 db-kit 正式版 .deb / .rpm。
//!
//! 用 .deb / .rpm 裝的 db-kit 要更新得有 root 權限。這支程式隨套件裝在 `/usr/lib/db-kit/db-kit-updater`，
//! 搭配 polkit 規則（`dev.dbkit.app.update.policy`）：坐在電腦前（本機、作用中的登入）的使用者用 pkexec
//! 執行它不必輸入密碼；遠端或非作用中的登入照樣要系統管理員密碼。
//!
//! 不用密碼代表這台電腦上任何程式都叫得動它，所以它只做一件事，而且不信任呼叫的人給的任何東西：
//! - 只收「版本號 + App 已經下載好的安裝檔」：`db-kit-updater install <版本> <安裝檔> [--proxy <網址>]`。
//! - 版本一定要比目前裝的 db-kit 新：不能降版，也不能重裝同一版。
//! - 安裝檔先複製到只有 root 寫得進去的資料夾，之後只動那一份；它的 SHA-256 跟自己向 GitHub API 查到的
//!   （這個專案那個版本的 Release 裡同名的檔案）比對。
//! - 套件名稱要是 db-kit、版本要跟要求的一樣，才交給 apt-get / dnf（沒有時用 dpkg / rpm）安裝。
//!
//! 結束代碼（App 的 `src-tauri/src/commands/update.rs` 照這個顯示訊息；避開 pkexec 自己用的 126 / 127）：
//! 0 裝好了；2 參數不對；3 拒絕安裝（不是更新的版本、不是 db-kit、db-kit 不是這個套件管理員裝的）；
//! 4 安裝檔對不上（SHA-256、大小，或 Release 裡沒有這個檔）；5 連不到 GitHub；6 套件管理員安裝失敗。
//! 失敗原因寫在 stderr 的最後一行（`db-kit-updater: …`）。

#[cfg(not(unix))]
compile_error!("db-kit-updater 只在 Linux 上使用");

use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Output, Stdio};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

const REPO: &str = "markku636/db-kit";
/// .deb / .rpm 裡的套件名稱（Tauri 把 productName「DB Kit」轉成 kebab-case）。
const PACKAGE: &str = "db-kit";
/// 放安裝檔複本的地方：/var/cache 只有 root 寫得進去，別人沒辦法先佔位，也沒辦法在驗證後把檔案換掉。
const WORK_DIR: &str = "/var/cache/db-kit-updater";
/// 安裝檔大小上限（現在約 60 MB），擋掉指向超大檔案的路徑。
const MAX_SIZE: u64 = 1 << 30;
/// 系統指令只在這些資料夾找；也是交給套件管理員的 PATH（pkexec 會清掉環境變數，維護腳本要找得到系統指令）。
const SYSTEM_PATH: &str = "/usr/sbin:/usr/bin:/sbin:/bin";
const USAGE: &str = "usage: db-kit-updater install <version> <package file> [--proxy <url>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args).and_then(|req| run(&req)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(f) => {
            eprintln!("db-kit-updater: {}", f.message());
            ExitCode::from(f.code())
        }
    }
}

#[derive(Debug)]
enum Fail {
    Usage(String),
    Refused(String),
    Mismatch(String),
    Network(String),
    Install(String),
}

impl Fail {
    fn code(&self) -> u8 {
        match self {
            Fail::Usage(_) => 2,
            Fail::Refused(_) => 3,
            Fail::Mismatch(_) => 4,
            Fail::Network(_) => 5,
            Fail::Install(_) => 6,
        }
    }

    fn message(&self) -> &str {
        match self {
            Fail::Usage(m) | Fail::Refused(m) | Fail::Mismatch(m) | Fail::Network(m) | Fail::Install(m) => m,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Deb,
    Rpm,
}

#[derive(Debug, PartialEq)]
struct Request {
    version: String,
    file: PathBuf,
    /// 安裝檔的檔名，跟 Release 裡的檔名一樣（App 下載時沿用 Release 的檔名）。
    name: String,
    format: Format,
    proxy: Option<String>,
}

fn parse_args(args: &[String]) -> Result<Request, Fail> {
    let usage = || Fail::Usage(USAGE.into());
    let mut it = args.iter();
    if it.next().map(String::as_str) != Some("install") {
        return Err(usage());
    }
    let version = it.next().ok_or_else(usage)?.trim().trim_start_matches(['v', 'V']).to_string();
    if parse_version(&version).is_none() {
        return Err(Fail::Usage(format!("invalid version: {version}")));
    }
    let file = PathBuf::from(it.next().ok_or_else(usage)?);
    let mut proxy = None;
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--proxy" => proxy = Some(it.next().ok_or_else(usage)?.trim().to_string()).filter(|p| !p.is_empty()),
            _ => return Err(usage()),
        }
    }
    if !file.is_absolute() {
        return Err(Fail::Usage(format!("the package file path must be absolute: {}", file.display())));
    }
    let name = file.file_name().and_then(OsStr::to_str).unwrap_or_default().to_string();
    let format = if name.ends_with(".deb") {
        Format::Deb
    } else if name.ends_with(".rpm") {
        Format::Rpm
    } else {
        return Err(Fail::Usage(format!("not a .deb / .rpm file: {}", file.display())));
    };
    Ok(Request { version, file, name, format, proxy })
}

/// `0.58.0`、`0.58.0-beta.1` → (數字段, pre-release)。其他寫法一律不收。
fn parse_version(v: &str) -> Option<(Vec<u64>, Option<&str>)> {
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    if pre.is_some_and(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')) {
        return None;
    }
    let nums = core
        .split('.')
        .map(|s| (!s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten())
        .collect::<Option<Vec<u64>>>()?;
    Some((nums, pre))
}

/// `new` 是否比 `installed` 新：數字段逐段比（缺的段當 0）；數字一樣時，有 pre-release 的比沒有的舊。
/// `installed` 是套件管理員給的版本，可能帶 epoch（`1:0.57.5`），先去掉。
fn is_newer(new: &str, installed: &str) -> bool {
    let installed = installed.split_once(':').map_or(installed, |(_, v)| v);
    let (Some((a, pre_a)), Some((b, pre_b))) = (parse_version(new), parse_version(installed)) else {
        return false;
    };
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    match (pre_a, pre_b) {
        (None, Some(_)) => true,
        (Some(x), Some(y)) => x > y,
        _ => false,
    }
}

fn run(req: &Request) -> Result<(), Fail> {
    let installed = installed_version(req.format)?;
    if !is_newer(&req.version, &installed) {
        return Err(Fail::Refused(format!("{} is not newer than the installed {PACKAGE} {installed}", req.version)));
    }
    let expected = expected_file(&fetch_release(&req.version, req.proxy.as_deref())?, &req.name)?;
    let dir = work_dir()?;
    let result = (|| {
        // 檔名已確認是 Release 裡的檔名（不含 / 之類的字元）。
        let copy = dir.join(&req.name);
        let sha256 = copy_and_hash(&req.file, &copy, expected.size)?;
        if sha256 != expected.sha256 {
            return Err(Fail::Mismatch(format!("the SHA-256 of {} doesn't match the release", req.name)));
        }
        let (package, version) = package_info(req.format, &copy)?;
        if package != PACKAGE || version != req.version {
            return Err(Fail::Refused(format!("{} contains {package} {version}, expected {PACKAGE} {}", req.name, req.version)));
        }
        install(req.format, &copy, req.proxy.as_deref())
    })();
    let _ = fs::remove_dir_all(&dir);
    result
}

#[derive(Debug, Deserialize)]
struct Release {
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    #[serde(default)]
    size: u64,
    /// `sha256:<hex>`（GitHub 自己算的）。
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, PartialEq)]
struct Expected {
    size: u64,
    sha256: String,
}

fn fetch_release(version: &str, proxy: Option<&str>) -> Result<Release, Fail> {
    let mut agent = ureq::AgentBuilder::new()
        .user_agent(concat!("db-kit-updater/", env!("CARGO_PKG_VERSION")))
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(60));
    if let Some(p) = proxy {
        // 代理只是轉送：TLS 照樣驗 GitHub 的憑證，給錯的代理頂多連不上。認不得的寫法就不用代理。
        match ureq::Proxy::new(p) {
            Ok(proxy) => agent = agent.proxy(proxy),
            Err(e) => eprintln!("db-kit-updater: ignoring proxy {p}: {e}"),
        }
    }
    // `version` 已經過 parse_version，只有數字、英文字母、. 與 -。
    let url = format!("https://api.github.com/repos/{REPO}/releases/tags/v{version}");
    match agent.build().get(&url).set("Accept", "application/vnd.github+json").call() {
        Ok(resp) => {
            let body = resp.into_string().map_err(|e| Fail::Network(e.to_string()))?;
            serde_json::from_str(&body).map_err(|e| Fail::Network(format!("unexpected GitHub API response: {e}")))
        }
        Err(ureq::Error::Status(404, _)) => Err(Fail::Mismatch(format!("there is no v{version} release"))),
        Err(ureq::Error::Status(code, _)) => Err(Fail::Network(format!("the GitHub API returned HTTP {code}"))),
        Err(e) => Err(Fail::Network(e.to_string())),
    }
}

/// Release 裡叫 `name` 的檔案應有的大小與 SHA-256（小寫 hex）。
fn expected_file(release: &Release, name: &str) -> Result<Expected, Fail> {
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == name)
        .ok_or_else(|| Fail::Mismatch(format!("the release has no file named {name}")))?;
    let sha256 = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| Fail::Mismatch(format!("GitHub didn't provide a SHA-256 for {name}")))?;
    Ok(Expected { size: asset.size, sha256 })
}

/// 這次用的資料夾（`/var/cache/db-kit-updater/<pid>`，用完整個刪掉）。上層要是 root 的資料夾，不是連結。
fn work_dir() -> Result<PathBuf, Fail> {
    let io = |e: std::io::Error| Fail::Install(format!("can't prepare {WORK_DIR}: {e}"));
    match fs::DirBuilder::new().mode(0o755).create(WORK_DIR) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(io(e)),
        _ => {}
    }
    let meta = fs::symlink_metadata(WORK_DIR).map_err(io)?;
    if !meta.is_dir() || meta.uid() != 0 {
        return Err(Fail::Install(format!("{WORK_DIR} is not a directory owned by root")));
    }
    let dir = Path::new(WORK_DIR).join(std::process::id().to_string());
    let _ = fs::remove_dir_all(&dir);
    fs::DirBuilder::new().mode(0o755).create(&dir).map_err(io)?;
    Ok(dir)
}

/// 把 `src` 複製成 `dst`（新建，別人只能讀），邊複製邊算 SHA-256（小寫 hex）。大小要剛好是 `size`。
fn copy_and_hash(src: &Path, dst: &Path, size: u64) -> Result<String, Fail> {
    let unreadable = |e: std::io::Error| Fail::Usage(format!("can't read {}: {e}", src.display()));
    let meta = fs::metadata(src).map_err(unreadable)?;
    if !meta.is_file() {
        return Err(Fail::Usage(format!("{} is not a regular file", src.display())));
    }
    if size == 0 || size > MAX_SIZE || meta.len() != size {
        return Err(Fail::Mismatch(format!("{} is {} bytes, the release file is {size} bytes", src.display(), meta.len())));
    }
    let mut input = fs::File::open(src).map_err(unreadable)?;
    let write_err = |e: std::io::Error| Fail::Install(format!("can't write {}: {e}", dst.display()));
    let mut output = fs::OpenOptions::new().write(true).create_new(true).mode(0o644).open(dst).map_err(write_err)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = input.read(&mut buf).map_err(unreadable)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > size {
            return Err(Fail::Mismatch(format!("{} grew while it was being copied", src.display())));
        }
        hasher.update(&buf[..n]);
        output.write_all(&buf[..n]).map_err(write_err)?;
    }
    if total != size {
        return Err(Fail::Mismatch(format!("{} shrank while it was being copied", src.display())));
    }
    output.sync_all().map_err(write_err)?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// 系統指令的完整路徑（只在 SYSTEM_PATH 的資料夾找，不看呼叫的人的 PATH）。
fn program(name: &str) -> Option<PathBuf> {
    SYSTEM_PATH.split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file())
}

fn require(name: &str) -> Result<PathBuf, Fail> {
    program(name).ok_or_else(|| Fail::Install(format!("{name} was not found")))
}

/// 執行系統指令：環境變數只留 PATH 與英文訊息（`extra` 另外加），輸出收起來。
fn run_program(program: &Path, args: &[&OsStr], extra: &[(&str, &str)]) -> Result<Output, Fail> {
    Command::new(program)
        .args(args)
        .env_clear()
        .env("PATH", SYSTEM_PATH)
        .env("LC_ALL", "C")
        .envs(extra.iter().copied())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Fail::Install(format!("can't run {}: {e}", program.display())))
}

/// 輸出的最後一行（優先 stderr），給錯誤訊息用。
fn last_line(out: &Output) -> String {
    let pick = |b: &[u8]| String::from_utf8_lossy(b).lines().map(str::trim).rev().find(|l| !l.is_empty()).map(str::to_string);
    let line = pick(&out.stderr).or_else(|| pick(&out.stdout)).unwrap_or_default();
    line.chars().take(300).collect()
}

/// 目前裝的 db-kit 版本；不是這個套件管理員裝的（或沒裝）就拒絕。
fn installed_version(format: Format) -> Result<String, Fail> {
    let not_installed = |how: &str| Fail::Refused(format!("{PACKAGE} is not installed as a {how} package"));
    match format {
        Format::Deb => {
            let out = run_program(&require("dpkg-query")?, &["-W".as_ref(), "--showformat=${Status}|${Version}".as_ref(), PACKAGE.as_ref()], &[])?;
            let text = String::from_utf8_lossy(&out.stdout);
            match text.trim().split_once('|') {
                Some((status, version)) if out.status.success() && status.ends_with(" installed") => Ok(version.trim().to_string()),
                _ => Err(not_installed(".deb")),
            }
        }
        Format::Rpm => {
            let out = run_program(&require("rpm")?, &["-q".as_ref(), "--qf".as_ref(), "%{VERSION}".as_ref(), PACKAGE.as_ref()], &[])?;
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && !version.is_empty() {
                Ok(version)
            } else {
                Err(not_installed(".rpm"))
            }
        }
    }
}

/// 安裝檔裡的套件名稱與版本。
fn package_info(format: Format, file: &Path) -> Result<(String, String), Fail> {
    let out = match format {
        Format::Deb => run_program(&require("dpkg-deb")?, &["-W".as_ref(), "--showformat=${Package} ${Version}".as_ref(), file.as_ref()], &[])?,
        Format::Rpm => run_program(&require("rpm")?, &["-qp".as_ref(), "--qf".as_ref(), "%{NAME} %{VERSION}".as_ref(), file.as_ref()], &[])?,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    match text.trim().split_once(' ') {
        Some((name, version)) if out.status.success() => Ok((name.to_string(), version.to_string())),
        _ => Err(Fail::Mismatch(format!("{} is not a valid package: {}", file.display(), last_line(&out)))),
    }
}

/// 交給套件管理員安裝。apt-get / dnf 裝本機的安裝檔會順便補裝新版多出來的相依套件（dpkg -i / rpm -U 不會，
/// 會卡在裝一半）；Ubuntu 開機後的自動更新正在跑時，apt-get 等它做完（最多 5 分鐘），不直接失敗。
fn install(format: Format, file: &Path, proxy: Option<&str>) -> Result<(), Fail> {
    let (program, args): (PathBuf, Vec<&OsStr>) = match format {
        Format::Deb => match program("apt-get") {
            Some(p) => (p, vec!["-y".as_ref(), "-o".as_ref(), "DPkg::Lock::Timeout=300".as_ref(), "install".as_ref(), file.as_ref()]),
            None => (require("dpkg")?, vec!["-i".as_ref(), file.as_ref()]),
        },
        Format::Rpm => match program("dnf") {
            Some(p) => (p, vec!["-y".as_ref(), "install".as_ref(), file.as_ref()]),
            None => (require("rpm")?, vec!["-U".as_ref(), file.as_ref()]),
        },
    };
    // 補裝相依套件要下載時，沿用使用者的代理。
    let mut env = vec![("DEBIAN_FRONTEND", "noninteractive")];
    if let Some(p) = proxy {
        env.extend([("http_proxy", p), ("https_proxy", p)]);
    }
    let out = run_program(&program, &args, &env)?;
    if out.status.success() {
        return Ok(());
    }
    let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let code = out.status.code().map_or_else(|| "a signal".to_string(), |c| format!("code {c}"));
    Err(Fail::Install(format!("{name} exited with {code}: {}", last_line(&out))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_the_install_request() {
        let req = parse_args(&args(&["install", "v0.58.0", "/tmp/db-kit-update/DB.Kit_0.58.0_amd64.deb"])).unwrap();
        assert_eq!(req.version, "0.58.0", "去掉 v");
        assert_eq!(req.name, "DB.Kit_0.58.0_amd64.deb");
        assert_eq!(req.format, Format::Deb);
        assert_eq!(req.proxy, None);
        let req = parse_args(&args(&["install", "0.58.0", "/tmp/x/DB.Kit-0.58.0-1.x86_64.rpm", "--proxy", "http://proxy:3128"])).unwrap();
        assert_eq!((req.format, req.proxy.as_deref()), (Format::Rpm, Some("http://proxy:3128")));
        assert_eq!(parse_args(&args(&["install", "0.58.0", "/tmp/a.deb", "--proxy", " "])).unwrap().proxy, None);

        let code = |list: &[&str]| parse_args(&args(list)).unwrap_err().code();
        assert_eq!(code(&[]), 2);
        assert_eq!(code(&["remove", "0.58.0", "/tmp/a.deb"]), 2);
        assert_eq!(code(&["install", "0.58.0"]), 2);
        assert_eq!(code(&["install", "../../0.58.0", "/tmp/a.deb"]), 2, "版本號只能是數字與 .");
        assert_eq!(code(&["install", "0.58.0", "a.deb"]), 2, "要完整路徑");
        assert_eq!(code(&["install", "0.58.0", "/tmp/a.AppImage"]), 2);
        assert_eq!(code(&["install", "0.58.0", "/tmp/a.deb", "--yes"]), 2);
        assert_eq!(code(&["install", "0.58.0", "/tmp/a.deb", "--proxy"]), 2);
    }

    #[test]
    fn only_newer_versions() {
        assert!(is_newer("0.58.0", "0.57.5"));
        assert!(is_newer("0.57.10", "0.57.9"), "逐段比數字，不是比字串");
        assert!(is_newer("1.0", "0.99.99"));
        assert!(is_newer("0.58.0", "0.58.0-beta.1"), "正式版比 pre-release 新");
        assert!(is_newer("0.58.0", "1:0.57.5"), "去掉 epoch");
        assert!(!is_newer("0.57.5", "0.57.5"), "同一版不重裝");
        assert!(!is_newer("0.57.4", "0.57.5"), "不降版");
        assert!(!is_newer("0.58.0-beta.1", "0.58.0"));
        assert!(!is_newer("0.58.0", ""), "讀不懂目前版本就不裝");
        assert!(parse_version("0.58.0-").is_none() && parse_version("0..1").is_none() && parse_version("0.58.0;rm").is_none());
    }

    #[test]
    fn digest_from_the_release() {
        let release: Release = serde_json::from_str(
            r#"{"tag_name":"v0.57.5","assets":[
                {"name":"DB.Kit_0.57.5_amd64.deb","size":58235232,"digest":"sha256:931B3D692B8941F322CC6C21D791E635AE518A1BFDC1B0E22C5FF50C435720EA"},
                {"name":"DB.Kit-0.57.5-1.x86_64.rpm","size":58236421,"digest":null},
                {"name":"DB.Kit_0.57.5_amd64.AppImage","size":1,"digest":"sha256:short"}]}"#,
        )
        .unwrap();
        assert_eq!(
            expected_file(&release, "DB.Kit_0.57.5_amd64.deb").unwrap(),
            Expected { size: 58235232, sha256: "931b3d692b8941f322cc6c21d791e635ae518a1bfdc1b0e22c5ff50c435720ea".into() }
        );
        for name in ["DB.Kit-0.57.5-1.x86_64.rpm", "DB.Kit_0.57.5_amd64.AppImage", "evil.deb"] {
            assert_eq!(expected_file(&release, name).unwrap_err().code(), 4, "{name}");
        }
    }

    #[test]
    fn copies_and_hashes_exactly_the_expected_size() {
        let dir = std::env::temp_dir().join(format!("db-kit-updater-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.deb");
        fs::write(&src, b"hello").unwrap();
        let copy = dir.join("copy.deb");
        assert_eq!(copy_and_hash(&src, &copy, 5).unwrap(), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert_eq!(fs::read(&copy).unwrap(), b"hello");
        assert_eq!(fs::metadata(&copy).unwrap().mode() & 0o777, 0o644);
        assert_eq!(copy_and_hash(&src, &dir.join("b.deb"), 6).unwrap_err().code(), 4, "大小不對");
        assert_eq!(copy_and_hash(&src, &copy, 5).unwrap_err().code(), 6, "不覆蓋已經在的檔案");
        assert_eq!(copy_and_hash(&dir, &dir.join("c.deb"), 5).unwrap_err().code(), 2, "不是一般檔案");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn last_line_prefers_stderr() {
        use std::os::unix::process::ExitStatusExt;
        let out = |stdout: &str, stderr: &str| Output {
            status: std::process::ExitStatus::from_raw(1 << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        };
        assert_eq!(last_line(&out("Reading package lists...\n", "W: warning\nE: Unable to locate package libfoo\n\n")), "E: Unable to locate package libfoo");
        assert_eq!(last_line(&out("done\n", "")), "done");
    }
}
