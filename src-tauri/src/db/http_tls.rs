//! 容器類連線（Docker / Registry / Harbor）共用的 HTTP 端點解析與 reqwest 用戶端建構。
//!
//! - 端點：`host` 欄可填完整 URL（`https://h:443/prefix`）或裸主機名 + `port` 欄；
//!   `normalize_target` 把前者拆回 host / port / scheme / 路徑前綴，讓 SSH 通道只需轉發一個 TCP 埠。
//! - TLS：自訂 CA、用戶端憑證 + 私鑰（mTLS）、略過驗證。憑證值可為 PEM 內文或檔案路徑。
//! - SSH 通道：manager 把 host 改寫成 127.0.0.1 之前會把原主機名存進 `TUNNEL_ORIGIN_HOST`，
//!   這裡以 `resolve(原主機名 → 127.0.0.1:本地埠)` 連線，SNI 與憑證主機名驗證仍對真實主機。

use std::net::SocketAddr;
use std::time::Duration;

use reqwest::ClientBuilder;

use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};

/// SSH 通道改寫前的原始主機名（manager 寫入 `options`，僅存在於記憶體中的連線設定，不落地）。
pub const TUNNEL_ORIGIN_HOST: &str = "__tunnel_origin_host";

/// 讀取某個 option（去空白），不存在或空字串回 None。
pub fn opt<'a>(cfg: &'a ConnectionConfig, key: &str) -> Option<&'a str> {
    cfg.options.get(key).map(|s| s.trim()).filter(|s| !s.is_empty())
}

/// bool option（"1" / "true" 為真）。
pub fn opt_bool(cfg: &ConnectionConfig, key: &str) -> bool {
    matches!(opt(cfg, key), Some("1") | Some("true"))
}

/// 解析後的 HTTP 端點。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpTarget {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    /// 路徑前綴（無尾斜線；空字串 = 根）。反向代理把 Harbor 掛在子路徑時用。
    pub prefix: String,
}

impl HttpTarget {
    /// `http(s)://host:port/prefix`（IPv6 主機加方括號）。
    pub fn base_url(&self) -> String {
        let scheme = if self.tls { "https" } else { "http" };
        let host = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{scheme}://{host}:{}{}", self.port, self.prefix)
    }
}

/// 解析 `host` 欄：接受 `https://h[:p][/prefix]`、`http://…`、`h:p`、`h`。
/// scheme 未指定時採 `default_tls`；埠未指定時依 TLS 取 `ports.1` / `ports.0`，`port` 欄非 0 則優先。
pub fn parse_target(host_field: &str, port: u16, default_tls: bool, ports: (u16, u16)) -> HttpTarget {
    let raw = host_field.trim();
    let (tls, rest) = if let Some(r) = raw.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = raw.strip_prefix("http://") {
        (false, r)
    } else {
        (default_tls, raw)
    };
    let (authority, prefix) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].trim_end_matches('/').to_string()),
        None => (rest, String::new()),
    };
    let (host, url_port) = split_host_port(authority);
    let port = if port != 0 {
        port
    } else if let Some(p) = url_port {
        p
    } else if tls {
        ports.1
    } else {
        ports.0
    };
    let host = if host.is_empty() { "localhost".to_string() } else { host };
    HttpTarget { tls, host, port, prefix }
}

/// `h:p` / `[v6]:p` / `h` → (host, port)。裸 IPv6（多個冒號、無方括號）整段當主機。
fn split_host_port(authority: &str) -> (String, Option<u16>) {
    if let Some(rest) = authority.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let host = rest[..end].to_string();
            let port = rest[end + 1..].strip_prefix(':').and_then(|p| p.parse().ok());
            return (host, port);
        }
    }
    if authority.matches(':').count() == 1 {
        let (h, p) = authority.split_once(':').unwrap_or((authority, ""));
        if let Ok(p) = p.parse::<u16>() {
            return (h.to_string(), Some(p));
        }
    }
    (authority.to_string(), None)
}

/// 把 `host` 欄裡的 URL 形式攤平成 host / port，scheme 與路徑前綴移到 options，
/// 讓 SSH 通道（只轉發 `cfg.host:cfg.port`）能正確開到目標。`tls_key` / `prefix_key` 為該 kind 的 option 鍵。
pub fn normalize_target(
    cfg: &mut ConnectionConfig,
    default_tls: bool,
    ports: (u16, u16),
    tls_key: &str,
    prefix_key: &str,
) {
    let default_tls = if cfg.options.contains_key(tls_key) {
        opt_bool(cfg, tls_key)
    } else {
        default_tls
    };
    let t = parse_target(&cfg.host, cfg.port, default_tls, ports);
    cfg.host = t.host;
    cfg.port = t.port;
    cfg.options.insert(tls_key.to_string(), if t.tls { "1" } else { "0" }.to_string());
    if !t.prefix.is_empty() {
        cfg.options.insert(prefix_key.to_string(), t.prefix);
    }
}

/// Registry / Harbor 端點。`host` 為 URL 時以 URL 為準；裸主機時 TLS 依 `{kind}_tls`
/// （SSH 通道前處理會寫入），未設則 localhost / 127.x / ::1 走 http（registry:2 的預設），其餘 https；
/// 路徑前綴取 `{kind}_prefix`（通道前處理從 URL 拆出來的）。
pub fn reg_target(cfg: &ConnectionConfig, kind: &str) -> HttpTarget {
    let host = cfg.host.trim();
    let has_scheme = host.starts_with("http://") || host.starts_with("https://");
    let tls_key = format!("{kind}_tls");
    let default_tls = if cfg.options.contains_key(&tls_key) {
        opt_bool(cfg, &tls_key)
    } else {
        let bare = split_host_port(host.split('/').next().unwrap_or(host)).0;
        !(bare == "localhost" || bare.starts_with("127.") || bare == "::1")
    };
    let mut t = parse_target(host, cfg.port, default_tls, (80, 443));
    if !has_scheme && t.prefix.is_empty() {
        if let Some(p) = opt(cfg, &format!("{kind}_prefix")) {
            t.prefix = p.trim_end_matches('/').to_string();
        }
    }
    t
}

/// TLS 選項。`ca` / `cert` / `key` 為 PEM 內文或檔案路徑。
#[derive(Debug, Clone, Default)]
pub struct TlsOpts {
    pub ca: Option<String>,
    pub cert: Option<String>,
    pub key: Option<String>,
    pub insecure: bool,
}

impl TlsOpts {
    /// 從 `{prefix}_ca` / `{prefix}_cert` / `{prefix}_key` / `{prefix}_insecure` 讀取。
    pub fn from_options(cfg: &ConnectionConfig, prefix: &str) -> Self {
        let get = |k: &str| opt(cfg, &format!("{prefix}_{k}")).map(str::to_string);
        TlsOpts {
            ca: get("ca"),
            cert: get("cert"),
            key: get("key"),
            insecure: opt_bool(cfg, &format!("{prefix}_insecure")),
        }
    }
}

/// 讀 PEM：值含 `-----BEGIN` 視為內文，否則視為檔案路徑（支援 `~/` 開頭）。
pub fn read_pem(value: &str, what: &str) -> AppResult<Vec<u8>> {
    let v = value.trim();
    if v.contains("-----BEGIN") {
        return Ok(v.as_bytes().to_vec());
    }
    let path = expand_home(v);
    std::fs::read(&path).map_err(|e| {
        AppError::Connect(tf!("讀取{what}失敗（{path}）：{e}", what = what, path = path.display(), e = e))
    })
}

fn expand_home(p: &str) -> std::path::PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return std::path::PathBuf::from(home).join(rest);
        }
    }
    std::path::PathBuf::from(p)
}

/// 建 reqwest 用戶端（套用逾時與 TLS 選項）。`read_timeout` 為 None 時不設整體逾時（串流 log / exec 用）。
pub fn client_builder(tls: &TlsOpts, request_timeout: Option<Duration>) -> AppResult<ClientBuilder> {
    let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(10));
    if let Some(t) = request_timeout {
        b = b.timeout(t);
    }
    if let Some(ca) = &tls.ca {
        let pem = read_pem(ca, &t!("CA 憑證"))?;
        let certs = reqwest::Certificate::from_pem_bundle(&pem)
            .map_err(|e| AppError::Connect(tf!("CA 憑證格式不正確：{e}", e = e)))?;
        if certs.is_empty() {
            return Err(AppError::Connect(t!("CA 憑證檔裡沒有任何憑證").into()));
        }
        for c in certs {
            b = b.add_root_certificate(c);
        }
    }
    match (&tls.cert, &tls.key) {
        (Some(cert), Some(key)) => {
            let mut pem = read_pem(cert, &t!("用戶端憑證"))?;
            pem.push(b'\n');
            pem.extend(read_pem(key, &t!("用戶端私鑰"))?);
            let id = reqwest::Identity::from_pem(&pem)
                .map_err(|e| AppError::Connect(tf!("用戶端憑證或私鑰格式不正確：{e}", e = e)))?;
            b = b.identity(id);
        }
        (Some(_), None) => return Err(AppError::Connect(t!("已指定用戶端憑證，但缺少私鑰").into())),
        (None, Some(_)) => return Err(AppError::Connect(t!("已指定用戶端私鑰，但缺少憑證").into())),
        (None, None) => {}
    }
    if tls.insecure {
        b = b.danger_accept_invalid_certs(true);
    }
    Ok(b)
}

/// 走 SSH 通道時（options 帶原主機名）：把請求 URL 的主機換回原主機名，並以 `resolve` 釘到本地轉發埠，
/// 讓 SNI / 憑證驗證對真實主機。回傳（可能改寫過的）target 與 builder。
pub fn apply_tunnel(
    cfg: &ConnectionConfig,
    mut target: HttpTarget,
    mut b: ClientBuilder,
) -> (HttpTarget, ClientBuilder) {
    if let Some(origin) = opt(cfg, TUNNEL_ORIGIN_HOST) {
        let local: SocketAddr = SocketAddr::from(([127, 0, 0, 1], target.port));
        // 原主機名本身若是 IP，不必 resolve（URL 直接用 127.0.0.1 即可；憑證仍以 IP SAN 驗證會失敗，
        // 這種情形使用者需勾「略過憑證驗證」或改用主機名）。
        if origin.parse::<std::net::IpAddr>().is_err() {
            b = b.resolve(origin, local);
            target.host = origin.to_string();
        }
    }
    (target, b)
}

/// HTTP 錯誤（傳輸層）→ AppError::Connect / Query，附上常見原因提示。
pub fn http_err(e: reqwest::Error) -> AppError {
    let mut msg = e.to_string();
    let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str("：");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    if e.is_connect() || e.is_timeout() {
        AppError::Connect(msg)
    } else {
        AppError::Query(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_target_forms() {
        let t = parse_target("https://harbor.example.com", 0, false, (80, 443));
        assert_eq!(t, HttpTarget { tls: true, host: "harbor.example.com".into(), port: 443, prefix: String::new() });
        assert_eq!(t.base_url(), "https://harbor.example.com:443");

        let t = parse_target("http://reg:5000/", 0, true, (80, 443));
        assert_eq!((t.tls, t.port, t.prefix.as_str()), (false, 5000, ""));

        let t = parse_target("reg.local", 0, false, (5000, 443));
        assert_eq!((t.tls, t.host.as_str(), t.port), (false, "reg.local", 5000));

        let t = parse_target("reg.local:8443", 0, true, (80, 443));
        assert_eq!((t.host.as_str(), t.port), ("reg.local", 8443));

        // port 欄優先於 URL 內的埠。
        let t = parse_target("https://h:8443/harbor/", 9443, false, (80, 443));
        assert_eq!((t.port, t.prefix.as_str()), (9443, "/harbor"));
        assert_eq!(t.base_url(), "https://h:9443/harbor");
    }

    #[test]
    fn parse_target_ipv6() {
        let t = parse_target("[::1]:5000", 0, false, (80, 443));
        assert_eq!((t.host.as_str(), t.port), ("::1", 5000));
        assert_eq!(t.base_url(), "http://[::1]:5000");
        let t = parse_target("fe80::1", 0, false, (80, 443));
        assert_eq!((t.host.as_str(), t.port), ("fe80::1", 80));
    }

    #[test]
    fn reg_target_defaults() {
        let mut c = crate::db::docker::config::tests::cfg("localhost:5000");
        c.kind = crate::db::DbKind::Registry;
        let t = reg_target(&c, "registry");
        assert_eq!((t.tls, t.port), (false, 5000));
        c.host = "harbor.example.com".into();
        let t = reg_target(&c, "harbor");
        assert_eq!((t.tls, t.port), (true, 443));
        // SSH 通道前處理攤平後：scheme / 前綴移到 options。
        let mut n = c.clone();
        n.host = "https://harbor.example.com/sub/".into();
        normalize_target(&mut n, true, (80, 443), "harbor_tls", "harbor_prefix");
        assert_eq!((n.host.as_str(), n.port), ("harbor.example.com", 443));
        assert_eq!(reg_target(&n, "harbor").base_url(), "https://harbor.example.com:443/sub");
    }

    #[test]
    fn read_pem_inline_passthrough() {
        let pem = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";
        assert_eq!(read_pem(pem, "x").unwrap(), pem.as_bytes());
        assert!(read_pem("Z:/definitely/missing.pem", "x").is_err());
    }

    #[test]
    fn half_identity_is_rejected() {
        let tls = TlsOpts { cert: Some("-----BEGIN CERTIFICATE-----".into()), ..Default::default() };
        assert!(client_builder(&tls, None).is_err());
    }
}
