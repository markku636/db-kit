//! VeNCrypt 的 X509 子型別（X509None / X509Vnc / X509Plain）：一般的憑證 TLS，用 rustls（ring）。
//!
//! VNC 伺服器的憑證幾乎都是自簽（Xvnc 的 `-X509Cert`、QEMU / libvirt 的 tls-creds），跟 RDP 一樣走 TOFU（`rd::cert`）：
//! - 握手時收下伺服器憑證，但**照樣驗握手簽章**——證明對方握有這張憑證的私鑰。不驗的話，中間人拿真伺服器的憑證
//!   重播、自己做金鑰交換，指紋比對也看不出來。
//! - 握手完成後比對指紋，第一次見到或變了才問使用者；這時還沒送出任何 VNC 密碼，拒絕就直接斷。
//!
//! 握手後跟匿名 TLS 一樣回一條普通串流（`tokio::io::duplex` 的一端），背景 task 驅動 rustls 加解密。

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::rd::cert::{check_tofu, CertQuestion, CertStore, CertUi};
use crate::rd::transport::BoxStream;

const BUF: usize = 16 * 1024;
const DUPLEX_BUF: usize = 256 * 1024;

/// 收下伺服器憑證（之後做 TOFU），簽章照 provider 的演算法驗。
#[derive(Debug)]
struct Tofu {
    provider: Arc<CryptoProvider>,
    seen: Mutex<Option<Vec<u8>>>,
}

impl ServerCertVerifier for Tofu {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        *self.seen.lock().unwrap() = Some(end_entity.as_ref().to_vec());
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// X509 TLS 握手 + 憑證 TOFU。`host` / `port` 是使用者設定的目標（指紋記在 `host:port` 底下）。
pub async fn connect(mut sock: BoxStream, host: &str, port: u16, store: &CertStore, ui: &dyn CertUi) -> AppResult<BoxStream> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(Tofu { provider: provider.clone(), seen: Mutex::new(None) });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(tls_err)?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    // SNI：主機名照填；不是合法的 DNS 名稱（例如帶底線）就給一個不存在的名字，反正憑證不照名稱驗。
    let name = ServerName::try_from(host.to_string())
        .unwrap_or_else(|_| ServerName::try_from("vnc.invalid".to_string()).expect("合法的 DNS 名稱"));
    let mut conn = ClientConnection::new(Arc::new(config), name).map_err(tls_err)?;
    conn.set_buffer_limit(None);

    let mut buf = vec![0u8; BUF];
    loop {
        flush(&mut conn, &mut sock).await?;
        if !conn.is_handshaking() {
            break;
        }
        let n = sock.read(&mut buf).await.map_err(io_err)?;
        if n == 0 {
            return Err(fail("the server closed the connection during the TLS handshake"));
        }
        feed(&mut conn, &buf[..n])?;
    }

    let der = verifier
        .seen
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| fail("the server sent no certificate"))?;
    check_tofu(store, ui, CertQuestion::from_der(host, port, &der)).await?;
    Ok(spawn_relay(sock, conn))
}

/// 握手後的轉送：rustls 連線只有這個 task 拿著；兩個方向的 `read` 都可以中途取消，所以用一個 select 迴圈。
fn spawn_relay(sock: BoxStream, mut conn: ClientConnection) -> BoxStream {
    let (app, inner) = tokio::io::duplex(DUPLEX_BUF);
    tokio::spawn(async move {
        let (mut sock_r, mut sock_w) = tokio::io::split(sock);
        let (mut in_r, mut in_w) = tokio::io::split(inner);
        let (mut net, mut up, mut plain) = (vec![0u8; BUF], vec![0u8; BUF], vec![0u8; BUF]);
        'relay: loop {
            // rustls 手上已解好的明文先交給上層（伺服器可能在握手剛結束就送了資料）。
            loop {
                match conn.reader().read(&mut plain) {
                    Ok(0) => break 'relay, // close_notify
                    Ok(n) => {
                        if in_w.write_all(&plain[..n]).await.is_err() {
                            break 'relay;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => break 'relay,
                }
            }
            if flush(&mut conn, &mut sock_w).await.is_err() {
                break;
            }
            tokio::select! {
                r = sock_r.read(&mut net) => match r {
                    Ok(n) if n > 0 => {
                        if feed(&mut conn, &net[..n]).is_err() {
                            break;
                        }
                    }
                    _ => break,
                },
                r = in_r.read(&mut up) => match r {
                    Ok(n) if n > 0 => {
                        if conn.writer().write_all(&up[..n]).is_err() {
                            break;
                        }
                    }
                    _ => {
                        conn.send_close_notify();
                        let _ = flush(&mut conn, &mut sock_w).await;
                        let _ = sock_w.shutdown().await;
                        break;
                    }
                },
            }
        }
        let _ = in_w.shutdown().await;
    });
    Box::new(app)
}

/// 收到的密文交給 rustls 解（`read_tls` 一次不一定吃完，邊吃邊處理）。
fn feed(conn: &mut ClientConnection, mut data: &[u8]) -> AppResult<()> {
    while !data.is_empty() {
        conn.read_tls(&mut data).map_err(io_err)?;
        conn.process_new_packets().map_err(tls_err)?;
    }
    Ok(())
}

/// rustls 要送的密文全部寫出去。
async fn flush<W: AsyncWrite + Unpin>(conn: &mut ClientConnection, w: &mut W) -> AppResult<()> {
    while conn.wants_write() {
        let mut out = Vec::new();
        conn.write_tls(&mut out).map_err(io_err)?;
        w.write_all(&out).await.map_err(io_err)?;
    }
    w.flush().await.map_err(io_err)
}

fn tls_err(e: rustls::Error) -> AppError {
    fail(&e.to_string())
}

fn fail(detail: &str) -> AppError {
    AppError::Rd(tf!("TLS 握手失敗：{e}", e = detail))
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Rd(tf!("VNC 連線 I/O 錯誤：{detail}", detail = e))
}
