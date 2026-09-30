//! 撥號：直連 TCP，或經已存 SSH 主機的 `direct-tcpip` 通道（不開本機 listener，跟 DB tunnel 不同）。
//!
//! 經 SSH 時，russh 的 channel stream 中間墊一條 `tokio::io::duplex`：IronRDP 的 framed 要求底層
//! stream 是 `Sync`，channel stream 不是；duplex 兩端都是。多一次記憶體複製，換到兩個協定共用同一種 stream。

use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};
use crate::ssh::auth::Connected;

/// 協定層吃的 stream。
pub trait RdStream: AsyncRead + AsyncWrite + Unpin + Send + Sync {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Sync> RdStream for T {}

pub type BoxStream = Box<dyn RdStream>;

/// duplex 緩衝：一張 1080p RemoteFX 更新常見幾百 KB，給足避免 SSH 端被頻繁 park。
const BRIDGE_BUF: usize = 512 * 1024;

/// 撥好的連線。`ssh` 有值時，整條 SSH 連線（含跳板機）必須跟著活著，關閉時一起收。
pub struct Dialed {
    pub stream: BoxStream,
    /// 本機端位址（RDP 的 Client Info 要填；經 SSH 時沒有真正的本機 socket，填 127.0.0.1:0）。
    pub local_addr: SocketAddr,
    pub ssh: Option<SshHold>,
}

/// 直連。`timeout` 涵蓋 DNS + TCP 握手。
pub async fn dial_direct(host: &str, port: u16, timeout: Duration) -> AppResult<Dialed> {
    let fut = TcpStream::connect((host, port));
    let stream = match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return Err(AppError::Rd(tf!("無法連線到 {host}:{port}：{e}", host = host, port = port, e = e)))
        }
        Err(_) => {
            return Err(AppError::Rd(tf!(
                "連線 {host}:{port} 逾時（{s} 秒）",
                host = host,
                port = port,
                s = timeout.as_secs()
            )))
        }
    };
    let _ = stream.set_nodelay(true);
    let local_addr = stream
        .local_addr()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 0)));
    Ok(Dialed { stream: Box::new(stream), local_addr, ssh: None })
}

/// 經已認證的 SSH 連線開 direct-tcpip 到 `host:port`（host 由 SSH 伺服器那端解析）。
pub async fn dial_via_ssh(conn: Connected, host: &str, port: u16) -> AppResult<Dialed> {
    let channel = match conn
        .handle
        .channel_open_direct_tcpip(host.to_string(), u32::from(port), "127.0.0.1".to_string(), 0)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            let hold = SshHold { conn, bridge: None };
            hold.close().await;
            return Err(AppError::Rd(tf!(
                "SSH 主機無法轉接到 {host}:{port}：{e}",
                host = host,
                port = port,
                e = e
            )));
        }
    };
    let (ours, theirs) = tokio::io::duplex(BRIDGE_BUF);
    let bridge = tokio::spawn(async move {
        let mut chan = channel.into_stream();
        let mut theirs = theirs;
        let _ = tokio::io::copy_bidirectional(&mut chan, &mut theirs).await;
    });
    Ok(Dialed {
        stream: Box::new(ours),
        local_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
        ssh: Some(SshHold { conn, bridge: Some(bridge) }),
    })
}


/// 把撥好的 stream 轉成本機 `127.0.0.1` 上的一個埠（只收第一條進來的連線）：
/// 給只會自己撥 TCP 的子程序（RustDesk 連線元件）走經 SSH 的路。SSH 連線跟著轉送任務活著、一起收。
pub async fn local_forward(d: Dialed) -> AppResult<(u16, JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Rd(tf!("本地監聽失敗：{e}", e = e)))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Rd(tf!("本地監聽失敗：{e}", e = e)))?
        .port();
    let Dialed { mut stream, ssh, .. } = d;
    let task = tokio::spawn(async move {
        // 只等 30 秒：子程序沒連上就放棄（不留一個對外敞開的轉送埠）。
        if let Ok(Ok((mut sock, _))) = tokio::time::timeout(Duration::from_secs(30), listener.accept()).await {
            drop(listener);
            let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
        }
        if let Some(h) = ssh {
            h.close().await;
        }
    });
    Ok((port, task))
}
/// 經 SSH 撥號時留著的 SSH 連線（含跳板機鏈）與轉送任務。
pub struct SshHold {
    conn: Connected,
    bridge: Option<JoinHandle<()>>,
}

impl SshHold {
    /// 由內而外斷線：先目標，再逐層跳板機。
    ///
    /// 回傳裝箱的 `dyn Future + Send`：russh 的 `disconnect(&str, &str)` 包在外層泛型 future 裡時，
    /// rustc 證明不了 `Send`（高階生命週期的已知限制）；在這裡抹掉型別，`Send` 就在生命週期具體的地方檢查。
    pub fn close(self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async move {
            if let Some(b) = self.bridge {
                b.abort();
            }
            let _ = self.conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
            let mut hop = self.conn.jump.as_deref();
            while let Some(j) = hop {
                let _ = j.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
                hop = j.jump.as_deref();
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn direct_dial_roundtrip() {
        let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut b = [0u8; 4];
            s.read_exact(&mut b).await.unwrap();
            s.write_all(&b).await.unwrap();
        });
        let mut d = dial_direct("127.0.0.1", port, Duration::from_secs(5)).await.unwrap();
        assert!(d.ssh.is_none());
        d.stream.write_all(b"ping").await.unwrap();
        let mut b = [0u8; 4];
        d.stream.read_exact(&mut b).await.unwrap();
        assert_eq!(&b, b"ping");
    }

    #[tokio::test]
    async fn direct_dial_refused_is_rd_error() {
        // 綁了又放掉的 port：幾乎一定沒人聽。
        let port = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        let e = dial_direct("127.0.0.1", port, Duration::from_secs(5)).await.err().unwrap();
        assert!(matches!(e, AppError::Rd(_)), "{e:?}");
    }
}
