//! VNC 工作階段：Tauri Channel ⇄ 伺服器的位元組轉送。
//!
//! 認證（`auth`）已在呼叫前做完；這裡在中間放一條 `tokio::io::duplex`：
//!
//! ```text
//! 前端 noVNC ⇄ [Channel / rd_write] ⇄ js 端 ║ duplex ║ novnc 端 ⇄ fake_server_handshake → copy_bidirectional ⇄ 伺服器
//! ```
//!
//! 讓假握手與轉送都寫成一般的 stream 程式，Tauri 的部分只剩「讀 js 端 → sink」與「`RdCtl::Write` → 寫 js 端」。

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::synth::fake_server_handshake;
use crate::rd::runtime::RdCtl;
use crate::rd::transport::{BoxStream, SshHold};

/// 前端方向的單次讀取上限：一則 Channel 訊息最多這麼大（大畫面更新會被切成數則，順序不變）。
const READ_CHUNK: usize = 256 * 1024;
const DUPLEX_BUF: usize = 1024 * 1024;

pub type Sink = std::sync::Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// 跑到任一端結束。回傳結束原因（`None` = 使用者自己斷的）。
pub async fn run(
    server: BoxStream,
    ssh: Option<SshHold>,
    mut ctl: mpsc::UnboundedReceiver<RdCtl>,
    sink: Sink,
) -> Option<String> {
    let (mut novnc, js) = tokio::io::duplex(DUPLEX_BUF);
    let relay = tokio::spawn(async move {
        let mut server = server;
        fake_server_handshake(&mut novnc).await.map_err(|e| e.message())?;
        tokio::io::copy_bidirectional(&mut novnc, &mut server)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    });
    let (mut js_r, mut js_w) = tokio::io::split(js);
    let mut buf = vec![0u8; READ_CHUNK];
    let user_closed = loop {
        tokio::select! {
            n = js_r.read(&mut buf) => match n {
                Ok(0) | Err(_) => break false,
                Ok(n) => sink(buf[..n].to_vec()),
            },
            m = ctl.recv() => match m {
                Some(RdCtl::Write(bytes)) => {
                    if js_w.write_all(&bytes).await.is_err() {
                        break false;
                    }
                }
                Some(RdCtl::Close) | None => break true,
                // RDP 專用的控制訊息（ack / resize / 組合鍵）對 VNC 無意義：noVNC 自己送 Ctrl+Alt+Del。
                Some(_) => {}
            },
        }
    };
    drop(js_w);
    drop(js_r);
    let reason = if user_closed {
        relay.abort();
        None
    } else {
        match relay.await {
            Ok(Ok(())) => Some(t!("遠端主機關閉了連線").to_string()),
            Ok(Err(e)) => Some(tf!("連線中斷：{e}", e = e)),
            Err(_) => Some(t!("遠端主機關閉了連線").to_string()),
        }
    };
    if let Some(h) = ssh {
        h.close().await;
    }
    reason
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// 端到端：假握手 → noVNC 的 ClientInit 轉到伺服器 → 伺服器的 ServerInit 回到前端。
    #[tokio::test]
    async fn fake_handshake_then_relay_both_ways() {
        let (server_side, mut fake_server) = tokio::io::duplex(64 * 1024);
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let sink: Sink = Arc::new(move |b| {
            let _ = out_tx.send(b);
        });
        let task = tokio::spawn(run(Box::new(server_side), None, ctl_rx, sink));

        let mut got = Vec::new();
        // 1. 前端收到假伺服器版本
        while got.len() < 12 {
            got.extend(out_rx.recv().await.unwrap());
        }
        assert_eq!(&got[..12], b"RFB 003.008\n");
        got.drain(..12);
        // 2. 前端回版本 → 收到 security types [1, 1]
        ctl_tx.send(RdCtl::Write(b"RFB 003.008\n".to_vec())).unwrap();
        while got.len() < 2 {
            got.extend(out_rx.recv().await.unwrap());
        }
        assert_eq!(&got[..2], &[1, 1]);
        got.drain(..2);
        // 3. 選 None → SecurityResult 0
        ctl_tx.send(RdCtl::Write(vec![1])).unwrap();
        while got.len() < 4 {
            got.extend(out_rx.recv().await.unwrap());
        }
        assert_eq!(&got[..4], &[0, 0, 0, 0]);
        got.drain(..4);
        // 4. ClientInit（shared = 1）→ 真伺服器收到的第一個 byte 就是它（假握手沒有漏到伺服器）
        ctl_tx.send(RdCtl::Write(vec![1])).unwrap();
        let mut b = [0u8; 1];
        fake_server.read_exact(&mut b).await.unwrap();
        assert_eq!(b, [1]);
        // 5. 伺服器 → 前端（ServerInit 的一部分）
        fake_server.write_all(b"SERVERINIT").await.unwrap();
        while got.len() < 10 {
            got.extend(out_rx.recv().await.unwrap());
        }
        assert_eq!(&got[..10], b"SERVERINIT");
        // 6. 伺服器斷線 → 任務結束並帶原因
        drop(fake_server);
        let reason = task.await.unwrap();
        assert!(reason.is_some());
    }

    #[tokio::test]
    async fn user_close_returns_none() {
        let (server_side, _keep) = tokio::io::duplex(1024);
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let sink: Sink = Arc::new(|_| {});
        let task = tokio::spawn(run(Box::new(server_side), None, ctl_rx, sink));
        ctl_tx.send(RdCtl::Ack(1)).unwrap(); // 無關的訊息：忽略
        ctl_tx.send(RdCtl::Close).unwrap();
        assert_eq!(task.await.unwrap(), None);
    }
}
