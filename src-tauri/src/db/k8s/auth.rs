//! exec credential plugin（client.authentication.k8s.io）：執行 kubeconfig `users[].user.exec` 指定的外部指令
//! （`aws eks get-token`、`gke-gcloud-auth-plugin`、`kubelogin`、`az`…），讀 stdout 的 ExecCredential JSON
//! 取得 token 或用戶端憑證。
//!
//! - 快取到 `expirationTimestamp` 前 60 秒；沒有到期時間的憑證一直沿用，直到 API server 回 401 才強制重跑。
//! - 不做互動：`spec.interactive = false`，stdin 接 null（需要輸入的 plugin 會失敗並回 stderr 給使用者看）。
//!   瀏覽器登入型（kubelogin、Azure device code）仍可用——plugin 自己開瀏覽器，這裡只是等它結束（最多 3 分鐘）。
//! - 找指令：Windows 依 PATHEXT 找 `.exe` / `.cmd` / `.bat`，並以 CREATE_NO_WINDOW 啟動（不閃黑窗）；
//!   macOS / Linux 從桌面啟動時 PATH 很短，補上 Homebrew、`/usr/local/bin`、gcloud SDK 等常見位置。

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::kubeconfig::ExecConfig;
use crate::error::{AppError, AppResult};

const EXEC_TIMEOUT: Duration = Duration::from_secs(180);
const DEFAULT_API_VERSION: &str = "client.authentication.k8s.io/v1beta1";

/// plugin 回傳的憑證。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCredential {
    pub token: Option<String>,
    pub client_cert_pem: Option<String>,
    pub client_key_pem: Option<String>,
    pub expires: Option<DateTime<Utc>>,
}

impl ExecCredential {
    fn fresh(&self, now: DateTime<Utc>) -> bool {
        match self.expires {
            Some(t) => t - chrono::Duration::seconds(60) > now,
            None => true,
        }
    }
}

/// 提供給 plugin 的叢集資訊（`provideClusterInfo: true` 時放進 KUBERNETES_EXEC_INFO）。
#[derive(Debug, Clone, Default)]
pub struct ClusterInfo {
    pub server: String,
    pub ca_pem: Option<Vec<u8>>,
    pub insecure: bool,
    pub tls_server_name: Option<String>,
}

pub struct ExecAuth {
    cfg: ExecConfig,
    dir: Option<PathBuf>,
    cluster: ClusterInfo,
    cache: tokio::sync::Mutex<Option<ExecCredential>>,
}

impl ExecAuth {
    pub fn new(cfg: ExecConfig, dir: Option<PathBuf>, cluster: ClusterInfo) -> Self {
        ExecAuth { cfg, dir, cluster, cache: tokio::sync::Mutex::new(None) }
    }

    /// 取得憑證（快取有效就直接回；`force` = 401 後強制重跑）。
    pub async fn get(&self, force: bool) -> AppResult<ExecCredential> {
        let mut cache = self.cache.lock().await;
        if !force {
            if let Some(c) = cache.as_ref() {
                if c.fresh(Utc::now()) {
                    return Ok(c.clone());
                }
            }
        }
        let cred = run(&self.cfg, self.dir.as_deref(), &self.cluster).await?;
        *cache = Some(cred.clone());
        Ok(cred)
    }
}

/// KUBERNETES_EXEC_INFO 環境變數內容。
pub fn exec_info(cfg: &ExecConfig, cluster: &ClusterInfo) -> Value {
    let api_version = if cfg.api_version.is_empty() { DEFAULT_API_VERSION } else { cfg.api_version.as_str() };
    let mut spec = json!({ "interactive": false });
    if cfg.provide_cluster_info {
        use base64::Engine as _;
        let mut c = json!({ "server": cluster.server, "insecure-skip-tls-verify": cluster.insecure });
        if let Some(ca) = &cluster.ca_pem {
            c["certificate-authority-data"] = json!(base64::engine::general_purpose::STANDARD.encode(ca));
        }
        if let Some(n) = &cluster.tls_server_name {
            c["tls-server-name"] = json!(n);
        }
        spec["cluster"] = c;
    }
    json!({ "apiVersion": api_version, "kind": "ExecCredential", "spec": spec })
}

/// 解析 plugin stdout。
pub fn parse_output(stdout: &str) -> AppResult<ExecCredential> {
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        AppError::Connect(tf!("exec plugin 的輸出不是 ExecCredential JSON：{e}", e = e))
    })?;
    let st = &v["status"];
    let s = |k: &str| st[k].as_str().map(str::to_string).filter(|s| !s.is_empty());
    let cred = ExecCredential {
        token: s("token"),
        client_cert_pem: s("clientCertificateData"),
        client_key_pem: s("clientKeyData"),
        expires: s("expirationTimestamp").and_then(|t| DateTime::parse_from_rfc3339(&t).ok()).map(|t| t.with_timezone(&Utc)),
    };
    if cred.token.is_none() && (cred.client_cert_pem.is_none() || cred.client_key_pem.is_none()) {
        return Err(AppError::Connect(t!("exec plugin 沒有回傳 token 或用戶端憑證").into()));
    }
    Ok(cred)
}

async fn run(cfg: &ExecConfig, dir: Option<&Path>, cluster: &ClusterInfo) -> AppResult<ExecCredential> {
    let extra = extra_path_dirs();
    let program = find_program(&cfg.command, dir, &extra).ok_or_else(|| {
        let hint = cfg.install_hint.as_deref().map(|h| format!("\n{}", h.trim())).unwrap_or_default();
        AppError::Connect(tf!(
            "找不到 kubeconfig 指定的認證指令「{cmd}」；請先安裝它並確認在 PATH 上{hint}",
            cmd = cfg.command,
            hint = hint
        ))
    })?;
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&cfg.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env("KUBERNETES_EXEC_INFO", exec_info(cfg, cluster).to_string());
    for e in &cfg.env {
        cmd.env(&e.name, &e.value);
    }
    if !extra.is_empty() {
        let mut paths: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        paths.extend(extra.iter().cloned());
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    if let Some(d) = dir.filter(|d| d.is_dir()) {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let child = cmd.spawn().map_err(|e| {
        AppError::Connect(tf!("無法執行認證指令「{cmd}」：{e}", cmd = program.display(), e = e))
    })?;
    let out = match tokio::time::timeout(EXEC_TIMEOUT, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| AppError::Connect(tf!("認證指令執行失敗：{e}", e = e)))?,
        Err(_) => {
            return Err(AppError::Connect(tf!(
                "認證指令「{cmd}」超過 {s} 秒沒有結束（是否在等待登入？）",
                cmd = cfg.command,
                s = EXEC_TIMEOUT.as_secs()
            )))
        }
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.trim().chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(AppError::Connect(tf!(
            "認證指令「{cmd}」失敗（{status}）：{err}",
            cmd = cfg.command,
            status = out.status,
            err = tail
        )));
    }
    parse_output(&String::from_utf8_lossy(&out.stdout))
}

/// 桌面啟動時 PATH 可能缺的常見安裝位置（只列存在的資料夾）。
fn extra_path_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        return Vec::new();
    }
    let mut v: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/google-cloud-sdk/bin", "/snap/bin"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(h) = dirs::home_dir() {
        for d in [".local/bin", "bin", "google-cloud-sdk/bin", ".krew/bin", ".azure-kubelogin"] {
            v.push(h.join(d));
        }
    }
    let path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    v.into_iter().filter(|d| d.is_dir() && !path.contains(d)).collect()
}

/// 找可執行檔：含路徑分隔字元 → 直接用（相對路徑以 kubeconfig 資料夾為準）；否則掃 PATH（+ Windows PATHEXT）。
pub fn find_program(command: &str, dir: Option<&Path>, extra: &[PathBuf]) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        let pe = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let mut v: Vec<String> = pe.split(';').filter(|s| !s.is_empty()).map(|s| s.to_ascii_lowercase()).collect();
        // 已帶副檔名（aws.exe）才試原名；裸名只走 PATHEXT——PATH 上常有同名、無副檔名的 shell script
        // （Git Bash 裝的），Windows 無法直接執行它。
        if Path::new(command).extension().is_some() {
            v.insert(0, String::new());
        }
        v
    } else {
        vec![String::new()]
    };
    let try_file = |base: &Path| -> Option<PathBuf> {
        for e in &exts {
            let p = if e.is_empty() { base.to_path_buf() } else { PathBuf::from(format!("{}{e}", base.display())) };
            if p.is_file() {
                return Some(p);
            }
        }
        None
    };
    if command.contains('/') || command.contains('\\') {
        let p = PathBuf::from(command);
        let p = match (p.is_absolute(), dir) {
            (false, Some(d)) => d.join(p),
            _ => p,
        };
        return try_file(&p);
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(extra.iter().cloned());
    dirs.iter().find_map(|d| try_file(&d.join(command)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_token_credential() {
        let c = parse_output(
            r#"{"kind":"ExecCredential","apiVersion":"client.authentication.k8s.io/v1beta1","spec":{},"status":{"expirationTimestamp":"2030-01-02T03:04:05Z","token":"k8s-aws-v1.abc"}}"#,
        )
        .unwrap();
        assert_eq!(c.token.as_deref(), Some("k8s-aws-v1.abc"));
        assert_eq!(c.expires.unwrap().to_rfc3339(), "2030-01-02T03:04:05+00:00");
        assert!(c.fresh(Utc::now()));
    }

    #[test]
    fn parses_cert_credential_and_rejects_empty() {
        let c = parse_output(r#"{"status":{"clientCertificateData":"C","clientKeyData":"K"}}"#).unwrap();
        assert_eq!((c.client_cert_pem.as_deref(), c.client_key_pem.as_deref()), (Some("C"), Some("K")));
        assert!(c.expires.is_none() && c.fresh(Utc::now()));
        assert!(parse_output(r#"{"status":{}}"#).is_err());
        assert!(parse_output("not json").is_err());
    }

    #[test]
    fn expiring_soon_is_not_fresh() {
        let c = ExecCredential { token: Some("t".into()), client_cert_pem: None, client_key_pem: None, expires: Some(Utc::now() + chrono::Duration::seconds(30)) };
        assert!(!c.fresh(Utc::now()));
    }

    #[test]
    fn exec_info_includes_cluster_when_asked() {
        let mut cfg = ExecConfig { command: "x".into(), ..Default::default() };
        let cluster = ClusterInfo { server: "https://h".into(), ca_pem: Some(b"CA".to_vec()), ..Default::default() };
        let v = exec_info(&cfg, &cluster);
        assert_eq!(v["apiVersion"], DEFAULT_API_VERSION);
        assert!(v["spec"].get("cluster").is_none());
        assert_eq!(v["spec"]["interactive"], false);
        cfg.provide_cluster_info = true;
        cfg.api_version = "client.authentication.k8s.io/v1".into();
        let v = exec_info(&cfg, &cluster);
        assert_eq!(v["spec"]["cluster"]["server"], "https://h");
        assert_eq!(v["spec"]["cluster"]["certificate-authority-data"], "Q0E=");
        assert_eq!(v["apiVersion"], "client.authentication.k8s.io/v1");
    }

    #[test]
    fn find_program_by_path_and_relative() {
        let dir = std::env::temp_dir().join(format!("dbkit-exec-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let name = if cfg!(windows) { "fake-plugin.cmd" } else { "fake-plugin" };
        std::fs::write(dir.join("bin").join(name), "echo").unwrap();
        assert!(find_program("fake-plugin", None, &[dir.join("bin")]).is_some());
        assert!(find_program("./bin/fake-plugin", Some(&dir), &[]).is_some());
        assert!(find_program("definitely-not-a-real-plugin-xyz", None, &[]).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
