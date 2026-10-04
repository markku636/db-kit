//! 經 SOCKS5 / HTTP CONNECT proxy 連資料庫。
//!
//! 與 SSH tunnel 同一個做法：本地開一個轉發埠，每條進站連線都先經 proxy 撥到 DB 的 host:port，
//! driver 改連本地埠即可——不必改任何一個 driver 的 TCP 撥號。
//!
//! 設定放在連線的 options：`proxy_url` = `socks5://[user@]host:port`（`socks5h` 同義：一律由 proxy 解析目標主機名）
//! 或 `http://[user@]host:port`；密碼走 `proxy_password`，存 keychain、不進 connections.json（見 store）。

use std::net::SocketAddr;

use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};
use crate::ssh::TunnelGuard;

pub const PROXY_OPTION: &str = "proxy_url";
/// 只在記憶體出現：存檔時抽到 keychain、載入時再補回（見 store::proxy_account）。
pub const PROXY_PASSWORD_OPTION: &str = "proxy_password";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyKind {
    Socks5,
    Http,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxySpec {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// `socks5://user@host:1080`、`http://host:3128`。網址裡的密碼也接受，但 UI 會引導改填密碼欄（存 keychain）。
pub fn parse_proxy(url: &str, password: Option<&str>) -> AppResult<ProxySpec> {
    let url = url.trim();
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| AppError::Connect(tf!("Proxy 網址格式不對：{url}（例：socks5://host:1080）", url = url)))?;
    let kind = match scheme.to_ascii_lowercase().as_str() {
        "socks5" | "socks5h" | "socks" => ProxyKind::Socks5,
        "http" => ProxyKind::Http,
        other => return Err(AppError::Connect(tf!("不支援的 Proxy 類型：{scheme}（支援 socks5、http）", scheme = other))),
    };
    let rest = rest.trim_end_matches('/');
    let (auth, hostport) = match rest.rsplit_once('@') {
        Some((a, h)) => (Some(a), h),
        None => (None, rest),
    };
    let (host, port) = hostport
        .rsplit_once(':')
        .and_then(|(h, p)| p.parse::<u16>().ok().map(|p| (h.trim_matches(['[', ']']).to_string(), p)))
        .unwrap_or_else(|| (hostport.to_string(), if kind == ProxyKind::Socks5 { 1080 } else { 8080 }));
    if host.is_empty() {
        return Err(AppError::Connect(tf!("Proxy 網址格式不對：{url}（例：socks5://host:1080）", url = url)));
    }
    let (username, url_pw) = match auth {
        Some(a) => match a.split_once(':') {
            Some((u, p)) => (Some(u.to_string()), Some(p.to_string())),
            None => (Some(a.to_string()), None),
        },
        None => (None, None),
    };
    let password = password.filter(|p| !p.is_empty()).map(str::to_string).or(url_pw);
    Ok(ProxySpec { kind, host, port, username: username.filter(|u| !u.is_empty()), password })
}

fn io_err(msg: String) -> std::io::Error {
    std::io::Error::other(msg)
}

/// 經 proxy 撥到 target_host:target_port，回傳已打通的串流。
pub async fn dial(spec: &ProxySpec, target_host: &str, target_port: u16) -> std::io::Result<TcpStream> {
    let mut s = TcpStream::connect((spec.host.as_str(), spec.port)).await?;
    match spec.kind {
        ProxyKind::Socks5 => socks5_connect(&mut s, spec, target_host, target_port).await?,
        ProxyKind::Http => http_connect(&mut s, spec, target_host, target_port).await?,
    }
    Ok(s)
}

async fn socks5_connect(s: &mut TcpStream, spec: &ProxySpec, host: &str, port: u16) -> std::io::Result<()> {
    let with_auth = spec.username.is_some();
    // 問候：支援的方法（0 = 免認證、2 = 帳密）。
    if with_auth { s.write_all(&[5, 2, 0, 2]).await? } else { s.write_all(&[5, 1, 0]).await? }
    let mut r = [0u8; 2];
    s.read_exact(&mut r).await?;
    if r[0] != 5 {
        return Err(io_err("SOCKS5: not a SOCKS5 proxy".into()));
    }
    match r[1] {
        0 => {}
        2 => {
            let u = spec.username.clone().unwrap_or_default();
            let p = spec.password.clone().unwrap_or_default();
            if u.len() > 255 || p.len() > 255 {
                return Err(io_err("SOCKS5: username / password too long".into()));
            }
            let mut msg = vec![1, u.len() as u8];
            msg.extend_from_slice(u.as_bytes());
            msg.push(p.len() as u8);
            msg.extend_from_slice(p.as_bytes());
            s.write_all(&msg).await?;
            let mut a = [0u8; 2];
            s.read_exact(&mut a).await?;
            if a[1] != 0 {
                return Err(io_err("SOCKS5: authentication failed".into()));
            }
        }
        0xff => return Err(io_err("SOCKS5: no acceptable authentication method (proxy needs a username / password?)".into())),
        m => return Err(io_err(format!("SOCKS5: unsupported method {m}"))),
    }
    // CONNECT：一律用網域名（ATYP 3），讓 proxy 端解析主機名。
    if host.len() > 255 {
        return Err(io_err("SOCKS5: host name too long".into()));
    }
    let mut req = vec![5, 1, 0, 3, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await?;
    if head[1] != 0 {
        let why = match head[1] {
            1 => "general failure",
            2 => "connection not allowed by ruleset",
            3 => "network unreachable",
            4 => "host unreachable",
            5 => "connection refused",
            6 => "TTL expired",
            _ => "rejected",
        };
        return Err(io_err(format!("SOCKS5: {why}")));
    }
    // 吃掉回覆裡的綁定位址。
    let skip = match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await?;
            l[0] as usize + 2
        }
        _ => return Err(io_err("SOCKS5: bad reply".into())),
    };
    let mut buf = vec![0u8; skip];
    s.read_exact(&mut buf).await?;
    Ok(())
}

async fn http_connect(s: &mut TcpStream, spec: &ProxySpec, host: &str, port: u16) -> std::io::Result<()> {
    use base64::Engine as _;
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(u) = &spec.username {
        let cred = base64::engine::general_purpose::STANDARD.encode(format!("{u}:{}", spec.password.clone().unwrap_or_default()));
        req.push_str(&format!("Proxy-Authorization: Basic {cred}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await?;
    // 讀到標頭結束（\r\n\r\n）；只看狀態列。
    let mut got = Vec::with_capacity(256);
    let mut b = [0u8; 1];
    while !got.ends_with(b"\r\n\r\n") {
        if s.read(&mut b).await? == 0 || got.len() > 16 * 1024 {
            return Err(io_err("HTTP proxy: connection closed before the CONNECT response".into()));
        }
        got.push(b[0]);
    }
    let status = String::from_utf8_lossy(&got);
    let line = status.lines().next().unwrap_or_default();
    if line.split_whitespace().nth(1) != Some("200") {
        return Err(io_err(format!("HTTP proxy: {line}")));
    }
    Ok(())
}

/// 開一個本地轉發埠，每條進站連線經 proxy 撥到 DB host:port。先試撥一次，proxy 設錯就在連線當下報錯。
pub async fn open_proxy_tunnel(cfg: &ConnectionConfig) -> AppResult<TunnelGuard> {
    let url = cfg.options.get(PROXY_OPTION).map(|s| s.as_str()).unwrap_or_default();
    let spec = parse_proxy(url, cfg.options.get(PROXY_PASSWORD_OPTION).map(|s| s.as_str()))?;
    let (host, port) = (cfg.host.trim().to_string(), cfg.port);
    // 試撥：proxy 不通 / 拒絕 / 認證失敗，在按「連線」的那一下就說清楚，而不是 driver 報一個看不懂的逾時。
    let probe = tokio::time::timeout(std::time::Duration::from_secs(10), dial(&spec, &host, port))
        .await
        .map_err(|_| AppError::Connect(t!("經 Proxy 連線逾時（10 秒）").into()))?
        .map_err(|e| AppError::Connect(tf!("經 Proxy 連不到 {host}:{port}：{e}", host = host, port = port, e = e)))?;
    drop(probe);

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Connect(tf!("本地監聽失敗：{e}", e = e)))?;
    let local_addr: SocketAddr = listener
        .local_addr()
        .map_err(|e| AppError::Connect(tf!("取得本地埠失敗：{e}", e = e)))?;
    let (tx, mut rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = rx.changed() => {
                    if *rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    };
                    let spec = spec.clone();
                    let host = host.clone();
                    tokio::spawn(async move {
                        match dial(&spec, &host, port).await {
                            Ok(mut upstream) => {
                                let _ = copy_bidirectional(&mut socket, &mut upstream).await;
                            }
                            Err(e) => eprintln!("[proxy] {e}"),
                        }
                    });
                }
            }
        }
    });
    Ok(TunnelGuard::from_parts(local_addr, tx, task))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_variants() {
        let s = parse_proxy("socks5://alice@10.0.0.1:1081", Some("pw")).unwrap();
        assert_eq!((s.kind.clone(), s.host.as_str(), s.port, s.username.as_deref(), s.password.as_deref()), (ProxyKind::Socks5, "10.0.0.1", 1081, Some("alice"), Some("pw")));
        let h = parse_proxy("http://proxy.corp:3128/", None).unwrap();
        assert_eq!((h.kind, h.host.as_str(), h.port, h.username), (ProxyKind::Http, "proxy.corp", 3128, None));
        assert_eq!(parse_proxy("socks5h://p", None).unwrap().port, 1080);
        assert_eq!(parse_proxy("socks5://u:inurl@p:1", None).unwrap().password.as_deref(), Some("inurl"));
        assert!(parse_proxy("ftp://p:1", None).is_err());
        assert!(parse_proxy("p:1080", None).is_err());
    }

    /// 迷你 proxy 伺服器：接受一條連線，走完 SOCKS5（或 HTTP CONNECT）握手後把對方送的資料原樣回傳。
    async fn fake_proxy(kind: ProxyKind, require_auth: bool) -> (u16, tokio::task::JoinHandle<(String, u16)>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let (host, tport) = match kind {
                ProxyKind::Socks5 => {
                    let mut g = [0u8; 2];
                    s.read_exact(&mut g).await.unwrap();
                    let mut m = vec![0u8; g[1] as usize];
                    s.read_exact(&mut m).await.unwrap();
                    if require_auth {
                        assert!(m.contains(&2));
                        s.write_all(&[5, 2]).await.unwrap();
                        let mut v = [0u8; 2];
                        s.read_exact(&mut v).await.unwrap();
                        let mut u = vec![0u8; v[1] as usize];
                        s.read_exact(&mut u).await.unwrap();
                        let mut pl = [0u8; 1];
                        s.read_exact(&mut pl).await.unwrap();
                        let mut p = vec![0u8; pl[0] as usize];
                        s.read_exact(&mut p).await.unwrap();
                        assert_eq!((u.as_slice(), p.as_slice()), (&b"alice"[..], &b"pw"[..]));
                        s.write_all(&[1, 0]).await.unwrap();
                    } else {
                        s.write_all(&[5, 0]).await.unwrap();
                    }
                    let mut head = [0u8; 5];
                    s.read_exact(&mut head).await.unwrap();
                    assert_eq!(&head[..4], &[5, 1, 0, 3]);
                    let mut name = vec![0u8; head[4] as usize];
                    s.read_exact(&mut name).await.unwrap();
                    let mut pb = [0u8; 2];
                    s.read_exact(&mut pb).await.unwrap();
                    s.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await.unwrap();
                    (String::from_utf8(name).unwrap(), u16::from_be_bytes(pb))
                }
                ProxyKind::Http => {
                    let mut got = Vec::new();
                    let mut b = [0u8; 1];
                    while !got.ends_with(b"\r\n\r\n") {
                        s.read_exact(&mut b).await.unwrap();
                        got.push(b[0]);
                    }
                    let text = String::from_utf8(got).unwrap();
                    let target = text.split_whitespace().nth(1).unwrap().to_string();
                    if require_auth {
                        assert!(text.contains("Proxy-Authorization: Basic YWxpY2U6cHc="), "{text}");
                    }
                    s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
                    let (h, p) = target.rsplit_once(':').unwrap();
                    (h.to_string(), p.parse().unwrap())
                }
            };
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&buf).await.unwrap();
            (host, tport)
        });
        (port, h)
    }

    #[tokio::test]
    async fn socks5_and_http_connect_handshakes() {
        for (kind, auth) in [(ProxyKind::Socks5, false), (ProxyKind::Socks5, true), (ProxyKind::Http, false), (ProxyKind::Http, true)] {
            let (port, server) = fake_proxy(kind.clone(), auth).await;
            let spec = ProxySpec {
                kind: kind.clone(),
                host: "127.0.0.1".into(),
                port,
                username: auth.then(|| "alice".to_string()),
                password: auth.then(|| "pw".to_string()),
            };
            let mut s = dial(&spec, "db.internal", 5432).await.unwrap();
            s.write_all(b"hello").await.unwrap();
            let mut echo = [0u8; 5];
            s.read_exact(&mut echo).await.unwrap();
            assert_eq!(&echo, b"hello", "{kind:?} auth={auth}");
            assert_eq!(server.await.unwrap(), ("db.internal".to_string(), 5432));
        }
    }
}
