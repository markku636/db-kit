//! 對 noVNC 佯裝的 server 側 RFB 握手。
//!
//! Rust 端已用 [`crate::rd::vnc::auth`] 對真正伺服器完成認證，因此對 noVNC 這側只需
//! 假裝成一台「不需認證」的伺服器，讓 noVNC 順順地走到 ClientInit，之後由上層 pump
//! 逐位元組轉送（noVNC → 真伺服器 從 ClientInit 起、真伺服器 → noVNC 從 ServerInit 起）。
//!
//! 位元組流（皆為 RFB 3.8，且逐步反應、不預先一次送完）：
//! 1. server → noVNC：`"RFB 003.008\n"`（12 bytes）
//! 2. noVNC → server：client 版本字串（12 bytes，須以 `"RFB "` 開頭）
//! 3. server → noVNC：security types = `[0x01, 0x01]`（數量 1、型別 None）
//! 4. noVNC → server：選定型別（1 byte，須為 `0x01` = None）
//! 5. server → noVNC：SecurityResult = `u32 0`（成功）
//!
//! 之後即進入 ClientInit（由上層 pump 接手，本函式不處理）。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{AppError, AppResult};

/// 對 noVNC 端完成佯裝伺服器的握手（見模組說明的位元組流）。
pub async fn fake_server_handshake<C: AsyncRead + AsyncWrite + Unpin + Send>(
    no_vnc: &mut C,
) -> AppResult<()> {
    // 1) 送出我們的版本。
    no_vnc
        .write_all(b"RFB 003.008\n")
        .await
        .map_err(io_err)?;
    no_vnc.flush().await.map_err(io_err)?;

    // 2) 讀 client 版本（12 bytes），驗證開頭。
    let mut client_ver = [0u8; 12];
    no_vnc.read_exact(&mut client_ver).await.map_err(io_err)?;
    if &client_ver[0..4] != b"RFB " {
        return Err(AppError::Rd(
            t!("noVNC 端回應的 RFB 版本字串格式不正確").to_string(),
        ));
    }

    // 3) 只提供 None（數量 1、型別 1）。
    no_vnc.write_all(&[1u8, 1u8]).await.map_err(io_err)?;
    no_vnc.flush().await.map_err(io_err)?;

    // 4) 讀 client 選擇，必須是 None（1）。
    let mut chosen = [0u8; 1];
    no_vnc.read_exact(&mut chosen).await.map_err(io_err)?;
    if chosen[0] != 1 {
        return Err(AppError::Rd(tf!(
            "noVNC 端選了非預期的認證型別：{n}",
            n = chosen[0]
        )));
    }

    // 5) SecurityResult：成功（u32 0）。
    no_vnc.write_all(&0u32.to_be_bytes()).await.map_err(io_err)?;
    no_vnc.flush().await.map_err(io_err)?;
    Ok(())
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Rd(tf!("VNC 連線 I/O 錯誤：{detail}", detail = e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn fake_server_handshake_byte_sequence() {
        let (mut server, mut client) = tokio::io::duplex(4096);
        // client 這側模擬 noVNC。
        let cli = tokio::spawn(async move {
            // 1) 讀 server 版本。
            let mut ver = [0u8; 12];
            client.read_exact(&mut ver).await.unwrap();
            assert_eq!(&ver, b"RFB 003.008\n");
            // 2) 送 client 版本。
            client.write_all(b"RFB 003.008\n").await.unwrap();
            // 3) 讀 security types。
            let mut sec = [0u8; 2];
            client.read_exact(&mut sec).await.unwrap();
            assert_eq!(sec, [1u8, 1u8]);
            // 4) 選 None。
            client.write_all(&[1u8]).await.unwrap();
            // 5) 讀 SecurityResult。
            let mut res = [0u8; 4];
            client.read_exact(&mut res).await.unwrap();
            assert_eq!(u32::from_be_bytes(res), 0);
        });

        fake_server_handshake(&mut server).await.unwrap();
        cli.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_bad_client_version() {
        let (mut server, mut client) = tokio::io::duplex(4096);
        let cli = tokio::spawn(async move {
            let mut ver = [0u8; 12];
            client.read_exact(&mut ver).await.unwrap();
            // 送格式錯誤的版本字串。
            client.write_all(b"XXX 003.008\n").await.unwrap();
        });
        let err = fake_server_handshake(&mut server).await.unwrap_err();
        let _ = cli.await;
        assert!(matches!(err, AppError::Rd(_)));
    }

    #[tokio::test]
    async fn rejects_non_none_choice() {
        let (mut server, mut client) = tokio::io::duplex(4096);
        let cli = tokio::spawn(async move {
            let mut ver = [0u8; 12];
            client.read_exact(&mut ver).await.unwrap();
            client.write_all(b"RFB 003.008\n").await.unwrap();
            let mut sec = [0u8; 2];
            client.read_exact(&mut sec).await.unwrap();
            client.write_all(&[2u8]).await.unwrap(); // 非 None
        });
        let err = fake_server_handshake(&mut server).await.unwrap_err();
        let _ = cli.await;
        assert!(matches!(err, AppError::Rd(_)));
    }
}
