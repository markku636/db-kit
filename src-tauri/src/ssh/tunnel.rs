//! SSH Tunnel（local port forward）。
//!
//! 連線前若啟用 SSH，開一條 `direct-tcpip` 轉發：在 `127.0.0.1:<OS 分配埠>` 監聽，
//! 每條進站連線都透過 SSH session 轉到原始 DB host:port。driver 連到本地埠即可。
//! `TunnelGuard` 持有關閉旗標與背景任務；drop 前須 `shutdown().await` 收掉。
//!
//! 撥號與認證走 `auth::connect_and_auth` + `SilentUi`：host key 採 TOFU（首次記住指紋，之後比對；
//! 不符則拒絕）、不會彈任何對話框，與拆分前的行為相同。

use std::net::SocketAddr;
use std::sync::Arc;

use russh::client::Msg;
use russh::Channel;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::auth::{connect_and_auth, Connected, SilentUi, SshTarget};
use super::known_hosts::KnownHostsStore;
use crate::db::{ConnectionConfig, DbKind};
use crate::error::{AppError, AppResult};

/// 一條存活中的 tunnel。本地監聽位址 + 背景任務 + 關閉旗標。
pub struct TunnelGuard {
    local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl TunnelGuard {
    /// 本地轉發埠（driver 改連此埠）。
    pub fn local_port(&self) -> u16 {
        self.local_addr.port()
    }

    /// 通知背景任務結束並等待收尾。
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

/// 依連線設定開一條 SSH tunnel，回傳 guard。撥號目標為「原始」DB host:port。
pub async fn open_tunnel(cfg: &ConnectionConfig) -> AppResult<TunnelGuard> {
    if matches!(cfg.kind, DbKind::Sqlite) {
        return Err(AppError::Ssh(t!("SQLite 不支援 SSH Tunnel").into()));
    }
    let target = SshTarget::from_connection(cfg)?;
    let remote_host = cfg.host.clone();
    let remote_port = cfg.port as u32;

    // 1. 連到 SSH bastion 並認證（不發問；TOFU 自動記住新主機）。
    let Connected { handle: session, .. } = connect_and_auth(
        &target,
        &format!("tunnel:{}", cfg.id),
        Arc::new(SilentUi),
        KnownHostsStore::default_path(),
    )
    .await?;

    // 2. 本地監聽（OS 分配空埠，避免手動掃描競態）。
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Ssh(tf!("本地監聽失敗：{e}", e = e)))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| AppError::Ssh(tf!("取得本地埠失敗：{e}", e = e)))?;

    // 3. 背景 accept loop：每條進站連線開一條 direct-tcpip 並雙向轉送。
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
                    let (mut socket, peer) = match accepted {
                        Ok(v) => v,
                        Err(e) => {
                            // 單次 accept 失敗（多為短暫資源限制）不應終結整條 tunnel；
                            // 記錄後略過並繼續監聽（小睡避免持續錯誤時忙迴圈）。
                            eprintln!("[ssh] accept 失敗（略過，繼續監聽）：{e}");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            continue;
                        }
                    };
                    let channel: Channel<Msg> = match session
                        .channel_open_direct_tcpip(
                            remote_host.clone(),
                            remote_port,
                            "127.0.0.1".to_string(),
                            peer.port() as u32,
                        )
                        .await
                    {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[ssh] 開啟轉發通道失敗：{e}");
                            continue;
                        }
                    };
                    tokio::spawn(async move {
                        let mut stream = channel.into_stream();
                        let _ = copy_bidirectional(&mut socket, &mut stream).await;
                    });
                }
            }
        }
        // 跳出迴圈後 session（Handle）隨任務結束 drop，russh 會關閉連線。
        drop(session);
    });

    Ok(TunnelGuard {
        local_addr,
        shutdown: tx,
        task,
    })
}
