//! ConnectionConfig → Docker Engine 端點。
//!
//! `host` 欄可填：
//! - 空白：本機預設（Windows `\\.\pipe\docker_engine`、其餘 `/var/run/docker.sock`）
//! - `unix:///path/docker.sock` 或 `/path/docker.sock`
//! - `npipe:////./pipe/docker_engine` 或 `\\.\pipe\docker_engine`
//! - `tcp://h:2375`、`http(s)://h:p`、`h`（搭配 `port` 欄）
//!
//! 非機密 options（`docker_*` 前綴，明文存 connections.json）：
//! - `docker_tls`：TCP 走 TLS（`https://`；預設埠 2376）
//! - `docker_tls_ca` / `docker_tls_cert` / `docker_tls_key`：PEM 路徑（與 `DOCKER_CERT_PATH` 的
//!   ca.pem / cert.pem / key.pem 對應）；`docker_tls_insecure`：略過伺服器憑證驗證
//! - `docker_api_version`：固定 API 版本（如 `1.43`）；空白 = 不帶版本前綴（daemon 採其最新版）

use crate::db::http_tls::{opt, opt_bool, parse_target, HttpTarget, TlsOpts};
use crate::db::ConnectionConfig;

/// Docker daemon 端點。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// Unix domain socket 路徑。
    Unix(String),
    /// Windows named pipe（`\\.\pipe\name` 形式）。
    Pipe(String),
    /// TCP（含 TLS 與否）。
    Tcp(HttpTarget),
}

impl Endpoint {
    /// 是否為本機 socket / pipe（不能走 SSH 通道）。
    pub fn is_local(&self) -> bool {
        !matches!(self, Endpoint::Tcp(_))
    }

    /// 顯示用（連線資訊 / 錯誤訊息）。
    pub fn label(&self) -> String {
        match self {
            Endpoint::Unix(p) => format!("unix://{p}"),
            Endpoint::Pipe(p) => format!("npipe://{}", p.replace('\\', "/")),
            Endpoint::Tcp(t) => {
                let scheme = if t.tls { "tcp+tls" } else { "tcp" };
                format!("{scheme}://{}:{}", t.host, t.port)
            }
        }
    }
}

/// 本機預設端點。
pub fn default_local() -> Endpoint {
    if cfg!(windows) {
        Endpoint::Pipe(r"\\.\pipe\docker_engine".to_string())
    } else {
        Endpoint::Unix("/var/run/docker.sock".to_string())
    }
}

/// `npipe://` 之後的路徑（`//./pipe/x` 或 `\\.\pipe\x`）→ `\\.\pipe\x`。
fn pipe_path(p: &str) -> String {
    let p = p.replace('/', "\\");
    if p.starts_with(r"\\") {
        p
    } else {
        format!(r"\\.\pipe\{}", p.trim_start_matches('\\'))
    }
}

/// 解析 `host` 欄成端點。
pub fn endpoint(cfg: &ConnectionConfig) -> Endpoint {
    let h = cfg.host.trim();
    let tls = opt_bool(cfg, "docker_tls");
    if h.is_empty() || h == "local" {
        return default_local();
    }
    if let Some(p) = h.strip_prefix("unix://") {
        return Endpoint::Unix(p.to_string());
    }
    if let Some(p) = h.strip_prefix("npipe://") {
        return Endpoint::Pipe(pipe_path(p));
    }
    if h.starts_with(r"\\") || h.starts_with("//./pipe/") {
        return Endpoint::Pipe(pipe_path(h));
    }
    if h.starts_with('/') {
        return Endpoint::Unix(h.to_string());
    }
    let rest = h.strip_prefix("tcp://").or_else(|| h.strip_prefix("docker://")).unwrap_or(h);
    // tcp:// 不帶 TLS 資訊，一律依 docker_tls；http(s):// 由 parse_target 依 scheme 決定。
    Endpoint::Tcp(parse_target(rest, cfg.port, tls, (2375, 2376)))
}

/// TLS 選項（只在 TCP + TLS 時有意義）。
pub fn tls_opts(cfg: &ConnectionConfig) -> TlsOpts {
    TlsOpts::from_options(cfg, "docker_tls")
}

/// 固定的 API 版本前綴（`/v1.43`）；未設 → 空字串。
pub fn api_prefix(cfg: &ConnectionConfig) -> String {
    match opt(cfg, "docker_api_version") {
        Some(v) => format!("/v{}", v.trim_start_matches(['v', 'V'])),
        None => String::new(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::DbKind;

    pub(crate) fn cfg(host: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: "d".into(),
            name: "d".into(),
            kind: DbKind::Docker,
            host: host.into(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            max_connections: 1,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_username: String::new(),
            ssh_auth_method: Default::default(),
            ssh_password: String::new(),
            ssh_private_key_path: String::new(),
            ssh_passphrase: String::new(),
            options: Default::default(),
            otp_secret: String::new(),
        }
    }

    #[test]
    fn local_forms() {
        assert_eq!(endpoint(&cfg("")), default_local());
        assert_eq!(endpoint(&cfg("unix:///var/run/docker.sock")), Endpoint::Unix("/var/run/docker.sock".into()));
        assert_eq!(endpoint(&cfg("/run/user/1000/docker.sock")), Endpoint::Unix("/run/user/1000/docker.sock".into()));
        assert_eq!(endpoint(&cfg("npipe:////./pipe/docker_engine")), Endpoint::Pipe(r"\\.\pipe\docker_engine".into()));
        assert_eq!(endpoint(&cfg(r"\\.\pipe\dockerDesktopLinuxEngine")), Endpoint::Pipe(r"\\.\pipe\dockerDesktopLinuxEngine".into()));
        assert_eq!(endpoint(&cfg("npipe://docker_engine")), Endpoint::Pipe(r"\\.\pipe\docker_engine".into()));
        assert!(endpoint(&cfg("")).is_local());
    }

    #[test]
    fn tcp_forms() {
        let Endpoint::Tcp(t) = endpoint(&cfg("tcp://10.0.0.5:2375")) else { panic!() };
        assert_eq!((t.tls, t.host.as_str(), t.port), (false, "10.0.0.5", 2375));

        let mut c = cfg("docker.example.com");
        c.options.insert("docker_tls".into(), "1".into());
        let Endpoint::Tcp(t) = endpoint(&c) else { panic!() };
        assert_eq!((t.tls, t.port), (true, 2376));
        assert_eq!(t.base_url(), "https://docker.example.com:2376");

        let mut c = cfg("tcp://h");
        c.port = 12375;
        let Endpoint::Tcp(t) = endpoint(&c) else { panic!() };
        assert_eq!((t.tls, t.port), (false, 12375));

        let Endpoint::Tcp(t) = endpoint(&cfg("https://h:9999")) else { panic!() };
        assert!(t.tls && t.port == 9999);
    }

    #[test]
    fn api_prefix_forms() {
        let mut c = cfg("");
        assert_eq!(api_prefix(&c), "");
        c.options.insert("docker_api_version".into(), "v1.43".into());
        assert_eq!(api_prefix(&c), "/v1.43");
    }

    #[test]
    fn labels() {
        assert_eq!(Endpoint::Pipe(r"\\.\pipe\docker_engine".into()).label(), "npipe:////./pipe/docker_engine");
        let Endpoint::Tcp(t) = endpoint(&cfg("tcp://h:2375")) else { panic!() };
        assert_eq!(Endpoint::Tcp(t).label(), "tcp://h:2375");
    }
}
