//! Authenticated WSS transport. The ticket is never sent to a plain TCP endpoint.
use crate::{
    codec,
    proto::rendezvous::{rendezvous_message, RendezvousMessage},
};
use futures_util::{SinkExt, StreamExt};
use protobuf::Message as _;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[derive(Clone, Default, serde::Deserialize)]
pub struct Params {
    pub url: String,
    pub ticket: String,
}
impl std::fmt::Debug for Params {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tenon([redacted])")
    }
}
pub struct Pump(tokio::task::JoinHandle<()>);
impl Drop for Pump {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub async fn connect(p: &Params) -> Result<(tokio::io::DuplexStream, Vec<u8>, Pump), String> {
    if !p.url.starts_with("wss://") {
        return Err("Tenon requires WSS".into());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut request = p.url.as_str().into_client_request().map_err(|_| "Invalid Tenon endpoint")?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {}", p.ticket).parse().map_err(|_| "Invalid ticket")?);
    let (mut ws, _) =
        tokio::time::timeout(std::time::Duration::from_secs(20), tokio_tungstenite::connect_async(request))
            .await
            .map_err(|_| "Tenon connection timed out")?
            .map_err(|_| "Tenon rejected the connection or its TLS certificate")?;
    let first = tokio::time::timeout(std::time::Duration::from_secs(35), ws.next())
        .await
        .map_err(|_| "Tenon peer timed out")?
        .ok_or("Tenon closed the connection")?
        .map_err(|_| "Tenon transport failed")?;
    let Message::Binary(bytes) = first else {
        return Err("Tenon peer is unavailable or authorization was revoked".into());
    };
    let message = RendezvousMessage::parse_from_bytes(&bytes).map_err(|_| "Invalid Tenon handshake")?;
    let Some(rendezvous_message::Union::RelayResponse(rr)) = message.union else {
        return Err("Invalid Tenon handshake".into());
    };
    let pk = rr.pk().to_vec();
    if pk.is_empty() {
        return Err("Tenon did not provide the peer's signed key".into());
    }
    let (stream, wire) = tokio::io::duplex(256 * 1024);
    let task = tokio::spawn(async move {
        let (mut tx, mut rx) = ws.split();
        let (mut read, mut write) = tokio::io::split(wire);
        // Separate futures preserve partially read RustDesk frames while WS input arrives.
        let outgoing = async {
            while let Some(bytes) = codec::read_frame(&mut read).await.map_err(|_| ())? {
                tx.send(Message::Binary(bytes.into())).await.map_err(|_| ())?;
            }
            Ok::<(), ()>(())
        };
        let incoming = async {
            while let Some(message) = rx.next().await {
                match message.map_err(|_| ())? {
                    Message::Binary(bytes) => codec::write_frame(&mut write, &bytes).await.map_err(|_| ())?,
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                    _ => return Err(()),
                }
            }
            Ok::<(), ()>(())
        };
        tokio::select! {_ = outgoing=>{},_ = incoming=>{}}
    });
    Ok((stream, pk, Pump(task)))
}
