//! VNC（RFB）內嵌檢視的後端協定層。
//!
//! 架構：webview 內跑 noVNC，Rust 端當一條 byte pipe。**真正的** RFB 握手 +
//! 認證由 Rust 直接對伺服器完成（密碼因此不會流進 JS），成功後對 noVNC 佯裝成
//! 「已認證完成」的伺服器，之後兩端逐位元組轉送（noVNC 這側從 ClientInit 起、
//! 伺服器那側從 ServerInit 起）。
//!
//! - [`auth`]：對真正伺服器的 client 側握手 + 認證（VNC-None / VNC Auth /
//!   Apple Remote Desktop / VeNCrypt）。密碼 / 密語只活在記憶體。
//! - [`tls_anon`]：VeNCrypt 的匿名 TLS（TLSNone / TLSVnc / TLSPlain）——自己做的最小 TLS 1.2 用戶端。
//! - [`tls_x509`]：VeNCrypt 的憑證 TLS（X509*）——rustls + 憑證 TOFU。
//!   兩種 TLS 握手完都換成一條普通串流，下面的 pump 不知道有 TLS。
//! - [`synth`]：對 noVNC 佯裝的 server 側握手（永遠只給 None、直接回報成功）。
//!
//! - [`pump`]：認證後的工作階段——假握手 + Channel ⇄ 伺服器的位元組轉送。
//!
//! 全部為純 tokio、無 Tauri 相依。

pub mod auth;
pub mod pump;
pub mod synth;
pub mod tls_anon;
pub mod tls_x509;
