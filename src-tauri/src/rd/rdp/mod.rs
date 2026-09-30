//! RDP（IronRDP）：連線握手與工作階段迴圈。
//!
//! 流程參照 IronRDP 的 `ironrdp-client` crate（`src/rdp.rs`，MIT / Apache-2.0，© Devolutions），但不直接用它：
//! 它的輸出是「每次更新都送整張 `Vec<u32>`」，且拉進 reqwest / tungstenite 的 aws-lc TLS。這裡改成
//! 差異區塊 + ack 反壓（`frames`）、TLS 只走 ring、憑證改成 TOFU 並在 CredSSP 之前就先驗（使用者拒絕時
//! NTLM 回應根本不會送出去）。
//!
//! 握手：TCP → X.224 協商（`connect_begin`）→ TLS（`ironrdp_tls::upgrade`）→ 憑證 TOFU →
//! CredSSP / NLA（`connect_finalize`，只做 NTLM；Kerberos 需要 KDC，`NoKdc` 直接回錯）→ 進入 ActiveStage。

pub mod cert;
pub mod clipboard;
pub mod frames;
pub mod input;

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use ironrdp::connector::connection_activation::ConnectionActivationState;
use ironrdp::connector::sspi::generator::NetworkRequest;
use ironrdp::connector::{self as connector, ConnectionResult, ConnectorError, ConnectorErrorKind, ConnectorResult};
use ironrdp::core::WriteBuf;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::rdp::capability_sets::{client_codecs_capabilities, MajorPlatformType};
use ironrdp::pdu::rdp::client_info::{CompressionType, PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{fast_path, ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::{split_tokio_framed, FramedWrite as _, TokioFramed};
use tokio::sync::mpsc;

use self::cert::{CertQuestion, CertStore};
use self::frames::{DirtyRegion, FramePacer, Rect};
use self::input::InputState;
use super::runtime::{CertDecision, RdCtl};
use super::transport::{BoxStream, Dialed};
use crate::error::{AppError, AppResult};
use crate::ssh::known_hosts::HostKeyStatus;

/// 一次 RDP 連線需要的參數（憑證已從 keychain / 對話框補好）。
#[derive(Clone)]
pub struct RdpParams {
    /// TLS SNI 與憑證 TOFU 的主機名（經 SSH 時仍是目標主機名，不是 127.0.0.1）。
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: String,
    pub width: u16,
    pub height: u16,
    /// 100 = 100%。
    pub scale: u32,
    pub color_depth: u32,
    pub nla: bool,
    pub view_only: bool,
    /// 同步剪貼簿文字（CLIPRDR）。
    pub clipboard: bool,
}

impl std::fmt::Debug for RdpParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 密碼不進 log。
        f.debug_struct("RdpParams")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("domain", &self.domain)
            .field("size", &(self.width, self.height))
            .field("nla", &self.nla)
            .finish()
    }
}

/// 憑證對話框（GUI 發事件等回答；測試用固定答案）。
#[async_trait]
pub trait CertUi: Send + Sync {
    async fn ask(&self, q: CertQuestion) -> CertDecision;
}

type Framed = TokioFramed<BoxStream>;

/// 握手完成、還沒進迴圈的連線。
pub struct RdpConnected {
    framed: Framed,
    result: ConnectionResult,
    /// `"nla"` / `"tls"`。
    pub security: &'static str,
    ssh: Option<super::transport::SshHold>,
    view_only: bool,
    clip: Option<clipboard::SharedClip>,
}

impl RdpConnected {
    pub fn desktop_size(&self) -> (u16, u16) {
        (self.result.desktop_size.width, self.result.desktop_size.height)
    }
}

/// Kerberos 要打 KDC；這裡不支援，NTLM 用不到它。
struct NoKdc;

impl ironrdp_tokio::NetworkClient for NoKdc {
    async fn send(&mut self, _req: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
        Err(connector::general_err!("Kerberos (KDC) is not supported; use NTLM"))
    }
}

/// 解析度限制（MS-RDPEDISP：寬 200–8192 且為偶數，高 200–8192）。
pub fn clamp_size(w: u16, h: u16) -> (u16, u16) {
    let (w, h) = MonitorLayoutEntry::adjust_display_size(u32::from(w.max(200)), u32::from(h.max(200)));
    (w as u16, h as u16)
}

fn build_config(p: &RdpParams) -> AppResult<connector::Config> {
    let codecs = client_codecs_capabilities(&[]).map_err(AppError::Rd)?;
    let (w, h) = clamp_size(p.width, p.height);
    let client_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "db-kit".into());
    Ok(connector::Config {
        credentials: connector::Credentials::UsernamePassword {
            username: p.username.clone(),
            password: p.password.clone(),
        },
        domain: (!p.domain.is_empty()).then(|| p.domain.clone()),
        // NLA 關掉時只剩 TLS（圖形登入畫面）；開著時兩個都送，由伺服器挑（多半挑 NLA）。
        enable_tls: true,
        enable_credssp: p.nla,
        keyboard_type: ironrdp::pdu::gcc::KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize { width: w, height: h },
        desktop_scale_factor: if p.scale > 100 { p.scale } else { 0 },
        bitmap: Some(connector::BitmapConfig {
            // IronRDP 只解 16 / 32；24 當 32。
            color_depth: if p.color_depth == 16 { 16 } else { 32 },
            lossy_compression: true,
            codecs,
        }),
        client_build: 0,
        client_name,
        client_dir: String::new(),
        platform: MajorPlatformType::UNSPECIFIED,
        hardware_id: None,
        license_cache: None,
        enable_server_pointer: true,
        autologon: false,
        enable_audio_playback: false,
        request_data: None,
        pointer_software_rendering: false,
        multitransport_flags: None,
        compression_type: Some(CompressionType::K64),
        performance_flags: PerformanceFlags::default(),
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    })
}

/// IronRDP 的錯誤 → AppError。認證類的走 `RdAuth`，讓前端知道該重問密碼而不是只顯示錯誤。
fn map_err(e: ConnectorError) -> AppError {
    let detail = e.report().to_string();
    match e.kind() {
        ConnectorErrorKind::Credssp(_) | ConnectorErrorKind::AccessDenied => AppError::RdAuth(detail),
        ConnectorErrorKind::Negotiation(f) => {
            use ironrdp::pdu::nego::FailureCode;
            let code = f.code();
            if code == FailureCode::HYBRID_REQUIRED_BY_SERVER {
                AppError::Rd(t!("伺服器要求網路層級驗證（NLA），請在連線設定開啟 NLA").into())
            } else if code == FailureCode::SSL_REQUIRED_BY_SERVER || code == FailureCode::SSL_NOT_ALLOWED_BY_SERVER {
                AppError::Rd(tf!("伺服器不接受目前的安全層設定：{detail}", detail = detail))
            } else {
                AppError::Rd(detail)
            }
        }
        _ => AppError::Rd(detail),
    }
}

/// 握手。`certs` / `ui` 決定憑證信任；使用者拒絕 → `RdCancelled`。
pub async fn connect(d: Dialed, p: &RdpParams, store: &CertStore, ui: &dyn CertUi) -> AppResult<RdpConnected> {
    let Dialed { stream, local_addr, ssh } = d;
    let result = handshake(stream, local_addr, p, store, ui).await;
    match result {
        Ok((framed, result, security, clip)) => {
            Ok(RdpConnected { framed, result, security, ssh, view_only: p.view_only, clip })
        }
        Err(e) => {
            if let Some(h) = ssh {
                h.close().await;
            }
            Err(e)
        }
    }
}

async fn handshake(
    stream: BoxStream,
    local_addr: std::net::SocketAddr,
    p: &RdpParams,
    store: &CertStore,
    ui: &dyn CertUi,
) -> AppResult<(Framed, ConnectionResult, &'static str, Option<clipboard::SharedClip>)> {
    let config = build_config(p)?;
    let drdynvc = ironrdp::dvc::DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())));
    let mut conn = connector::ClientConnector::new(config, local_addr).with_static_channel(drdynvc);
    // 剪貼簿（文字）：只在設定開著、而且不是只看不控時接上 CLIPRDR 通道。
    let clip = (p.clipboard && !p.view_only).then(|| {
        let shared: clipboard::SharedClip = Arc::default();
        conn.attach_static_channel(ironrdp::cliprdr::CliprdrClient::new(Box::new(clipboard::TextClipboard::new(
            shared.clone(),
        ))));
        shared
    });

    let mut framed = TokioFramed::new(stream);
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut conn).await.map_err(map_err)?;
    let (raw, leftover) = framed.into_inner();
    let (tls, cert) = ironrdp_tls::upgrade(raw, &p.host)
        .await
        .map_err(|e| AppError::Rd(tf!("TLS 握手失敗：{e}", e = e)))?;

    // 憑證 TOFU：在 CredSSP 之前。拒絕就直接斷，NTLM 回應不會送給冒牌伺服器。
    let q = CertQuestion::from_cert(&p.host, p.port, &cert);
    let status = store.check(&q.host_id, &q.fingerprint).map_err(|e| {
        AppError::Rd(tf!("無法讀取已信任的遠端桌面憑證清單：{e}", e = e))
    })?;
    if status != HostKeyStatus::Known {
        match ui.ask(CertQuestion { status: status.clone(), ..q.clone() }).await {
            CertDecision::AcceptSave => store
                .record(&q.host_id, &q.fingerprint)
                .map_err(|e| AppError::Rd(tf!("無法記住憑證：{e}", e = e)))?,
            CertDecision::AcceptOnce => {}
            CertDecision::Reject => return Err(AppError::RdCancelled),
        }
    }

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut conn);
    let security = if conn.should_perform_credssp() { "nla" } else { "tls" };
    let boxed: BoxStream = Box::new(tls);
    let mut framed = TokioFramed::new_with_leftover(boxed, leftover);
    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&cert)
        .ok_or_else(|| AppError::Rd(t!("讀不到伺服器憑證的公鑰").into()))?
        .to_owned();
    let result = ironrdp_tokio::connect_finalize(
        upgraded,
        conn,
        &mut framed,
        &mut NoKdc,
        p.host.clone().into(),
        server_public_key,
        None,
    )
    .await
    .map_err(map_err)?;
    Ok((framed, result, security, clip))
}

/// 在專屬執行緒（自己的 current-thread tokio runtime）跑一段 RDP 工作。
///
/// 為什麼不 `tokio::spawn`：ironrdp-async 的 `single_sequence_step*` 把 `&dyn PduHint` 抱過 `.await`，
/// 握手與工作階段的 future 因此不是 `Send`，放不進多執行緒 runtime。`f` 本身（與它帶的資料）是 `Send`，
/// future 在新執行緒裡才建立。結果經 oneshot 回來；呼叫端丟掉 receiver 不影響執行緒跑完。
///
/// stream 若是在主 runtime 建的（經 SSH 的 duplex）照樣能用：duplex 不綁 reactor；直連的 TCP 則在這個執行緒裡撥。
pub fn run_on_own_thread<F, Fut, T>(name: String, f: F) -> tokio::sync::oneshot::Receiver<T>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = T>,
    T: Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    let spawned = std::thread::Builder::new().name(name).spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[rdp] 建立 runtime 失敗：{e}");
                return;
            }
        };
        let out = rt.block_on(f());
        let _ = tx.send(out);
    });
    if let Err(e) = spawned {
        eprintln!("[rdp] 建立執行緒失敗：{e}");
    }
    rx
}

/// 給前端的輸出（一則 Channel 訊息）。
pub type Sink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// 工作階段迴圈。回傳結束原因（給 `rd-conn-closed`；None = 使用者自己斷的）。
pub async fn run(c: RdpConnected, mut ctl: mpsc::UnboundedReceiver<RdCtl>, sink: Sink) -> Option<String> {
    let RdpConnected { framed, result, ssh, view_only, clip, .. } = c;
    let reason = session(framed, result, &mut ctl, &sink, view_only, clip).await;
    if let Some(h) = ssh {
        h.close().await;
    }
    reason
}

async fn session(
    framed: Framed,
    result: ConnectionResult,
    ctl: &mut mpsc::UnboundedReceiver<RdCtl>,
    sink: &Sink,
    view_only: bool,
    clip: Option<clipboard::SharedClip>,
) -> Option<String> {
    let (mut reader, mut writer) = split_tokio_framed(framed);
    let size = result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    let activation_factory = result.activation_factory;
    let mut stage: ActiveStage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();

    let mut input = InputState::new(view_only);
    let mut dirty = DirtyRegion::default();
    let mut pacer = FramePacer::new();
    // 前端要知道畫布大小才能畫第一張。
    sink(frames::encode_resize(image.width(), image.height()));
    dirty.mark_full(image.width(), image.height());
    let mut retry_at: Option<Instant> = Some(Instant::now());

    loop {
        let wake = async {
            match retry_at {
                Some(t) => tokio::time::sleep_until(t.into()).await,
                None => std::future::pending().await,
            }
        };
        let outputs: Vec<ActiveStageOutput> = tokio::select! {
            frame = reader.read_pdu() => {
                let (action, payload) = match frame {
                    Ok(v) => v,
                    Err(e) => return Some(tf!("連線中斷：{e}", e = e)),
                };
                match stage.process(&mut image, action, &payload) {
                    Ok(o) => o,
                    Err(e) => return Some(tf!("RDP 協定錯誤：{e}", e = e.report())),
                }
            }
            msg = ctl.recv() => {
                let Some(msg) = msg else { return None };
                // 本機剪貼簿有新文字：記下來、向遠端宣告（遠端貼上時才真的送，見 clipboard.rs）。
                if let (RdCtl::Clipboard(text), Some(c)) = (&msg, &clip) {
                    let mut s = c.lock();
                    s.local = Some(clipboard::normalize_local(text));
                    if s.ready {
                        s.actions.push_back(clipboard::Action::Advertise);
                    }
                }
                match handle_ctl(msg, &mut stage, &mut image, &mut input, &mut pacer, &mut dirty) {
                    Ok(Some(o)) => o,
                    Ok(None) => {
                        // Close：放開按鍵、送 graceful shutdown，再等伺服器結束（或逾時由 runtime abort）。
                        let mut o = stage.process_fastpath_input(&mut image, &input.release_all()).unwrap_or_default();
                        o.extend(stage.graceful_shutdown().unwrap_or_default());
                        for out in o {
                            if let ActiveStageOutput::ResponseFrame(f) = out {
                                let _ = writer.write_all(&f).await;
                            }
                        }
                        return None;
                    }
                    Err(e) => return Some(e),
                }
            }
            _ = wake => Vec::new(),
        };

        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => {
                    if let Err(e) = writer.write_all(&frame).await {
                        return Some(tf!("連線中斷：{e}", e = e));
                    }
                }
                ActiveStageOutput::GraphicsUpdate(r) => {
                    dirty.add(Rect::from_inclusive(r.left, r.top, r.right, r.bottom), image.width(), image.height());
                }
                ActiveStageOutput::PointerDefault => sink(frames::encode_pointer_system(true)),
                ActiveStageOutput::PointerHidden => sink(frames::encode_pointer_system(false)),
                ActiveStageOutput::PointerPosition { x, y } => sink(frames::encode_pointer_pos(x, y)),
                ActiveStageOutput::PointerBitmap(p) => {
                    sink(frames::encode_pointer_bitmap(p.width, p.height, p.hotspot_x, p.hotspot_y, &p.bitmap_data))
                }
                ActiveStageOutput::DeactivateAll => {
                    // Deactivation-Reactivation（resize 之後伺服器會走這段）：重跑 activation，換新尺寸的畫布。
                    let mut act = activation_factory.create();
                    let mut buf = WriteBuf::new();
                    loop {
                        let written = match ironrdp_tokio::single_sequence_step_read(&mut reader, &mut act, &mut buf).await {
                            Ok(w) => w,
                            Err(e) => return Some(tf!("重新啟用工作階段失敗：{e}", e = e.report())),
                        };
                        if written.size().is_some() {
                            if let Err(e) = writer.write_all(buf.filled()).await {
                                return Some(tf!("連線中斷：{e}", e = e));
                            }
                        }
                        if let ConnectionActivationState::Finalized {
                            desktop_size,
                            share_id,
                            enable_server_pointer,
                            pointer_software_rendering,
                        } = act.connection_activation_state()
                        {
                            image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
                            stage.set_fastpath_processor(
                                fast_path::ProcessorBuilder {
                                    io_channel_id: act.io_channel_id(),
                                    user_channel_id: act.user_channel_id(),
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                    bulk_decompressor: None,
                                }
                                .build(),
                            );
                            stage.set_share_id(share_id);
                            stage.set_enable_server_pointer(enable_server_pointer);
                            sink(frames::encode_resize(image.width(), image.height()));
                            pacer.reset();
                            dirty.mark_full(image.width(), image.height());
                            break;
                        }
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    use ironrdp::session::GracefulDisconnectReason as G;
                    return match reason {
                        G::UserInitiated => None,
                        G::ServerInitiated => Some(t!("遠端主機結束了工作階段").into()),
                        G::Other(s) => Some(s),
                    };
                }
                _ => {}
            }
        }

        // 剪貼簿的待辦動作（backend 回呼排進來的）。
        if let Some(c) = &clip {
            match run_clipboard(c, &mut stage, sink) {
                Ok(frames_out) => {
                    for f in frames_out {
                        if let Err(e) = writer.write_all(&f).await {
                            return Some(tf!("連線中斷：{e}", e = e));
                        }
                    }
                }
                // 剪貼簿壞掉不該拖垮整個工作階段：記下來、丟掉這批。
                Err(e) => eprintln!("[rdp] 剪貼簿：{e}"),
            }
        }

        // 送畫面：有差異、而且節流 / 反壓允許。
        retry_at = None;
        if !dirty.is_empty() {
            let now = Instant::now();
            match pacer.ready(now) {
                Ok(()) => {
                    let rects = dirty.take();
                    let seq = pacer.flushed(now);
                    sink(frames::encode_frame(image.data(), image.stride(), image.width(), image.height(), &rects, seq));
                }
                Err(t) => retry_at = t,
            }
        }
    }
}

/// 執行剪貼簿佇列：呼叫 CliprdrClient、把 SVC 訊息編成要送的 frame；遠端文字交給前端。
fn run_clipboard(clip: &clipboard::SharedClip, stage: &mut ActiveStage, sink: &Sink) -> Result<Vec<Vec<u8>>, String> {
    use ironrdp::cliprdr::pdu::ClipboardFormatId;
    use ironrdp::cliprdr::CliprdrClient;
    let (actions, has_local): (Vec<clipboard::Action>, bool) = {
        let mut s = clip.lock();
        (s.actions.drain(..).collect(), s.local.is_some())
    };
    let mut out = Vec::new();
    for a in actions {
        let Some(cl) = stage.get_svc_processor_mut::<CliprdrClient>() else { break };
        let msgs = match a {
            clipboard::Action::RemoteText(t) => {
                sink(frames::encode_clipboard(&t));
                continue;
            }
            clipboard::Action::Advertise if !has_local => continue,
            clipboard::Action::Advertise => cl.initiate_copy(&[clipboard::text_format()]),
            clipboard::Action::Paste => cl.initiate_paste(ClipboardFormatId::CF_UNICODETEXT),
            clipboard::Action::Submit(r) => cl.submit_format_data(r),
        }
        .map_err(|e| e.to_string())?;
        let frame = stage.process_svc_processor_messages(msgs).map_err(|e| e.report().to_string())?;
        if !frame.is_empty() {
            out.push(frame);
        }
    }
    Ok(out)
}

/// 處理一則控制訊息。`Ok(None)` = 要結束（Close）；`Err` = 致命錯誤的原因。
fn handle_ctl(
    msg: RdCtl,
    stage: &mut ActiveStage,
    image: &mut DecodedImage,
    input: &mut InputState,
    pacer: &mut FramePacer,
    dirty: &mut DirtyRegion,
) -> Result<Option<Vec<ActiveStageOutput>>, String> {
    let fast = |stage: &mut ActiveStage, image: &mut DecodedImage, ev: input::Events| {
        if ev.is_empty() {
            return Ok(Vec::new());
        }
        stage
            .process_fastpath_input(image, &ev)
            .map_err(|e| tf!("RDP 協定錯誤：{e}", e = e.report()))
    };
    let out = match msg {
        RdCtl::Close => return Ok(None),
        RdCtl::Input(bytes) => fast(stage, image, input.apply(&bytes))?,
        RdCtl::Keys(name) => fast(stage, image, input.combo(&name))?,
        RdCtl::Ack(seq) => {
            pacer.acked(seq);
            Vec::new()
        }
        RdCtl::Refresh => {
            pacer.reset();
            dirty.mark_full(image.width(), image.height());
            Vec::new()
        }
        RdCtl::Resize { width, height, scale } => {
            let (w, h) = clamp_size(width, height);
            if (w, h) == (image.width(), image.height()) {
                return Ok(Some(Vec::new()));
            }
            let scale = (scale >= 100).then_some(scale);
            match stage.encode_resize(u32::from(w), u32::from(h), scale, None) {
                Some(Ok(frame)) => vec![ActiveStageOutput::ResponseFrame(frame)],
                Some(Err(e)) => return Err(tf!("RDP 協定錯誤：{e}", e = e.report())),
                // 伺服器沒開動態解析度（DisplayControl 通道沒建起來）：維持原尺寸，前端改用縮放。
                None => Vec::new(),
            }
        }
        // 剪貼簿與 VNC 位元組不屬於 RDP 迴圈（剪貼簿在 P3 接 cliprdr）。
        RdCtl::Clipboard(_) | RdCtl::Write(_) => Vec::new(),
    };
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_size_rules() {
        assert_eq!(clamp_size(100, 100), (200, 200));
        let (w, _) = clamp_size(1001, 700);
        assert_eq!(w % 2, 0, "寬度要偶數");
        assert_eq!(clamp_size(9000, 9000), (8192, 8192));
    }

    #[test]
    fn config_follows_params_and_debug_hides_password() {
        let p = RdpParams {
            host: "h".into(),
            port: 3389,
            username: "u".into(),
            password: "hunter2".into(),
            domain: String::new(),
            width: 1280,
            height: 720,
            scale: 150,
            color_depth: 24,
            nla: false,
            view_only: false,
            clipboard: false,
        };
        let c = build_config(&p).unwrap();
        assert!(c.enable_tls && !c.enable_credssp);
        assert_eq!(c.domain, None);
        assert_eq!(c.bitmap.unwrap().color_depth, 32);
        assert_eq!(c.desktop_scale_factor, 150);
        assert!(!format!("{p:?}").contains("hunter2"));
    }
}
