//! SSH Tunnel（local port forward）。
//!
//! 連線前若啟用 SSH，開一條 `direct-tcpip` 轉發：在 `127.0.0.1:<OS 分配埠>` 監聽，
//! 每條進站連線都透過 SSH session 轉到原始 DB host:port。driver 連到本地埠即可。
//! `TunnelGuard` 持有關閉旗標與背景任務；drop 前須 `shutdown().await` 收掉。
//!
//! 安全備註：`check_server_key` 採 TOFU（首次記住指紋，之後比對；不符則拒絕）。
//! 為防中間人，讀取 / 持久化 known_hosts 失敗時一律「拒絕連線」（fail-closed），
//! 不退回「信任任意金鑰」。

use std::net::SocketAddr;
use std::sync::Arc;

use russh::client::{self, Msg};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::Channel;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::error::{AppError, AppResult};

/// SSH 撥號 / 認證逾時，避免黑洞 bastion（接受 TCP 但不完成 banner/KEX）無限阻塞 connect 路徑。
const SSH_DIAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 以 TOFU（trust on first use）驗證 host key 的 client handler。
/// 第一次連線記住指紋；之後比對，不符則拒絕（可能 MITM）。
struct TunnelHandler {
    host_id: String,
}

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(Default::default()).to_string();
        // 讀取失敗（檔案損毀 / 解析錯誤等）→ fail-closed 拒絕，不可退回「信任任意金鑰」。
        let mut known = match load_known_hosts() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[ssh] 無法讀取 known_hosts，為防中間人而拒絕連線：{e}");
                return Ok(false);
            }
        };
        match known.get(&self.host_id) {
            Some(stored) if stored == &fp => Ok(true),
            Some(_) => {
                eprintln!(
                    "[ssh] host key 與已記錄指紋不符，拒絕連線（可能遭中間人攻擊）：{}",
                    self.host_id
                );
                Ok(false)
            }
            None => {
                // TOFU：第一次連線，記住此指紋；若無法持久化則拒絕（避免下次又重新信任任意金鑰）。
                known.insert(self.host_id.clone(), fp);
                if let Err(e) = save_known_hosts(&known) {
                    eprintln!("[ssh] 無法保存 host key 指紋，為防下次重新信任而拒絕連線：{e}");
                    return Ok(false);
                }
                Ok(true)
            }
        }
    }
}

fn known_hosts_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("dev.atkit.app").join("ssh_known_hosts.json"))
}

// 區分「檔案不存在」（→ 空表，正常首次使用）與「讀取 / 解析失敗」（→ Err，呼叫端 fail-closed）。
fn load_known_hosts() -> std::io::Result<std::collections::HashMap<String, String>> {
    let Some(p) = known_hosts_path() else {
        return Ok(Default::default());
    };
    match std::fs::read(&p) {
        Ok(b) => serde_json::from_slice(&b)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(e) => Err(e),
    }
}

// 原子寫入（temp + rename），避免中斷時產生截斷 / 損毀檔；錯誤一律回傳供呼叫端判斷。
fn save_known_hosts(map: &std::collections::HashMap<String, String>) -> std::io::Result<()> {
    let p = known_hosts_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "找不到設定目錄"))?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let b = serde_json::to_vec_pretty(map)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &b)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

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
        return Err(AppError::Ssh("SQLite 不支援 SSH Tunnel".into()));
    }
    if cfg.ssh_host.trim().is_empty() {
        return Err(AppError::Ssh("未填寫 SSH 主機".into()));
    }
    let ssh_port = if cfg.ssh_port == 0 { 22 } else { cfg.ssh_port };
    let remote_host = cfg.host.clone();
    let remote_port = cfg.port as u32;

    // 1. 連到 SSH bastion。
    let config = Arc::new(client::Config::default());
    let handler = TunnelHandler {
        host_id: format!("{}:{}", cfg.ssh_host, ssh_port),
    };
    let mut session = tokio::time::timeout(
        SSH_DIAL_TIMEOUT,
        client::connect(config, (cfg.ssh_host.as_str(), ssh_port), handler),
    )
    .await
    .map_err(|_| AppError::Ssh("SSH 連線逾時".into()))?
    .map_err(|e| AppError::Ssh(format!("SSH 連線失敗：{e}")))?;

    // 2. 認證（密碼或私鑰）；同樣加逾時，避免認證階段卡死。
    let auth = match cfg.ssh_auth_method {
        SshAuthMethod::Password => tokio::time::timeout(
            SSH_DIAL_TIMEOUT,
            session.authenticate_password(cfg.ssh_username.clone(), cfg.ssh_password.clone()),
        )
        .await
        .map_err(|_| AppError::Ssh("SSH 認證逾時".into()))?
        .map_err(|e| AppError::Ssh(format!("SSH 認證失敗：{e}")))?,
        SshAuthMethod::Key => {
            let passphrase = if cfg.ssh_passphrase.is_empty() {
                None
            } else {
                Some(cfg.ssh_passphrase.as_str())
            };
            let key = load_secret_key(&cfg.ssh_private_key_path, passphrase)
                .map_err(|e| AppError::Ssh(format!("讀取 SSH 私鑰失敗：{e}")))?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            tokio::time::timeout(
                SSH_DIAL_TIMEOUT,
                session.authenticate_publickey(cfg.ssh_username.clone(), key),
            )
            .await
            .map_err(|_| AppError::Ssh("SSH 認證逾時".into()))?
            .map_err(|e| AppError::Ssh(format!("SSH 認證失敗：{e}")))?
        }
    };
    if !auth.success() {
        return Err(AppError::Ssh("SSH 認證被拒（帳號 / 密碼 / 金鑰不正確）".into()));
    }

    // 3. 本地監聽（OS 分配空埠，避免手動掃描競態）。
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Ssh(format!("本地監聽失敗：{e}")))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| AppError::Ssh(format!("取得本地埠失敗：{e}")))?;

    // 4. 背景 accept loop：每條進站連線開一條 direct-tcpip 並雙向轉送。
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
