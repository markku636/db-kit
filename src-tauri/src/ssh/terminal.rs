//! 終端機：一條 session channel 上的 PTY shell。
//!
//! 讀端是背景任務：把伺服器送來的位元組**合併**後才交給 `TermSink`——IPC 才是瓶頸，不是 xterm；
//! 緩衝 ≥ 16 KiB 或距第一個位元組 ≥ 8 ms 就送一次，`cat` 大檔時不會每個 TCP 片段都打一次 IPC，
//! 互動打字又不會感覺到延遲。結束前 flush，最後送 `Exit`。
//!
//! 寫端（`ChannelWriteHalf`）的方法全是 `&self`，`TermHandle` 可以放進 `Arc` 讓多個 command 共用。

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelWriteHalf};
use tokio::task::JoinHandle;

use super::runtime::SshConn;
use crate::error::{AppError, AppResult};

/// 合併門檻：緩衝到這個大小就立刻送。
pub const COALESCE_BYTES: usize = 16 * 1024;
/// 合併門檻：距緩衝裡第一個位元組這麼久就送（互動延遲的上限）。
pub const COALESCE_DELAY: Duration = Duration::from_millis(8);
/// 關閉時等伺服器回 Close 的寬限；超過就 abort 讀端任務。
const CLOSE_GRACE: Duration = Duration::from_millis(500);
/// `request_pty` / `request_shell` 等伺服器回覆的上限。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 開終端機的參數。
#[derive(Debug, Clone)]
pub struct TermOpen {
    pub cols: u32,
    pub rows: u32,
    /// `TERM`（空 → xterm-256color）。
    pub term: String,
    pub env: BTreeMap<String, String>,
    /// shell 開好後自動送出的第一行（會補 `\r`）。
    pub startup_command: String,
}

/// 讀端事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermEvent {
    /// 合併後的一段輸出（原始位元組，不做編碼轉換；UTF-8 切半交給 xterm 處理）。
    Data(Vec<u8>),
    /// shell 結束。`status` 是 exit code；被訊號殺掉時 `signal` 有值。
    Exit { status: Option<u32>, signal: Option<String> },
}

/// 事件的去處。GUI 把它接到 IPC channel + `app.emit`，測試接到 mpsc。
pub type TermSink = Arc<dyn Fn(TermEvent) + Send + Sync>;

/// 一個活著的終端機。
pub struct TermHandle {
    pub conn_id: String,
    writer: ChannelWriteHalf<Msg>,
    reader: parking_lot::Mutex<Option<JoinHandle<()>>>,
}

impl TermHandle {
    /// 開 session channel → env → PTY → shell → 啟動指令 → 起讀端。
    pub async fn open(conn: Arc<SshConn>, o: TermOpen, sink: TermSink) -> AppResult<Self> {
        let mut ch: Channel<Msg> = conn
            .handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(tf!("開啟 SSH 通道失敗：{e}", e = e)))?;
        // 環境變數不要求回覆：伺服器 AcceptEnv 沒放行的會被拒，那不是錯。
        for (k, v) in &o.env {
            if k.trim().is_empty() {
                continue;
            }
            let _ = ch.set_env(false, k.clone(), v.clone()).await;
        }
        let term = if o.term.trim().is_empty() { "xterm-256color" } else { o.term.trim() };
        ch.request_pty(true, term, o.cols.max(1), o.rows.max(1), 0, 0, &[])
            .await
            .map_err(|e| AppError::Ssh(tf!("要求 PTY 失敗：{e}", e = e)))?;
        expect_reply(&mut ch, t!("伺服器拒絕配置 PTY")).await?;
        ch.request_shell(true)
            .await
            .map_err(|e| AppError::Ssh(tf!("要求 shell 失敗：{e}", e = e)))?;
        expect_reply(&mut ch, t!("伺服器拒絕開啟 shell")).await?;
        if !o.startup_command.trim().is_empty() {
            let line = format!("{}\r", o.startup_command.trim_end_matches(['\r', '\n']));
            ch.data_bytes(line.into_bytes())
                .await
                .map_err(|e| AppError::Ssh(tf!("送出啟動指令失敗：{e}", e = e)))?;
        }
        let (mut read, writer) = ch.split();
        let reader = tokio::spawn(async move {
            pump(&mut read, &sink).await;
        });
        Ok(Self {
            conn_id: conn.id.clone(),
            writer,
            reader: parking_lot::Mutex::new(Some(reader)),
        })
    }

    /// 送原始位元組（xterm `onData` / `onBinary` 的輸入）。
    pub async fn write(&self, data: &[u8]) -> AppResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.writer
            .data_bytes(data.to_vec())
            .await
            .map_err(|e| AppError::Ssh(tf!("寫入終端機失敗：{e}", e = e)))
    }

    /// 送一行指令（補 `\r`）。命令列輸入條與 AI「送到終端機」專用。
    pub async fn send_line(&self, line: &str) -> AppResult<()> {
        let mut s = line.trim_end_matches(['\r', '\n']).to_string();
        s.push('\r');
        self.write(s.as_bytes()).await
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        self.writer
            .window_change(cols.max(1), rows.max(1), 0, 0)
            .await
            .map_err(|e| AppError::Ssh(tf!("調整終端機大小失敗：{e}", e = e)))
    }

    /// EOF + Close，給伺服器一點時間回 Close（讀端自然結束並送 Exit），逾時就 abort。
    pub async fn close(&self) {
        let _ = self.writer.eof().await;
        let _ = self.writer.close().await;
        let task = self.reader.lock().take();
        if let Some(mut task) = task {
            if tokio::time::timeout(CLOSE_GRACE, &mut task).await.is_err() {
                task.abort();
            }
        }
    }
}

/// 等 `want_reply = true` 的請求回覆：Success 放行、Failure 回錯；其他訊息（WindowAdjusted…）略過。
async fn expect_reply(ch: &mut Channel<Msg>, failure_msg: &'static str) -> AppResult<()> {
    let wait = async {
        loop {
            match ch.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => return Err(AppError::Ssh(failure_msg.into())),
                Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => {
                    return Err(AppError::Ssh(t!("SSH 通道已被伺服器關閉").into()));
                }
                Some(_) => {}
            }
        }
    };
    match tokio::time::timeout(REQUEST_TIMEOUT, wait).await {
        Ok(r) => r,
        Err(_) => Err(AppError::Ssh(t!("等待伺服器回覆逾時").into())),
    }
}

/// 會吐 `ChannelMsg` 的來源：真的是 `ChannelReadHalf`，測試用 mpsc 假裝。
pub(crate) trait MsgSource {
    fn next(&mut self) -> impl Future<Output = Option<ChannelMsg>> + Send;
}

impl MsgSource for russh::ChannelReadHalf {
    fn next(&mut self) -> impl Future<Output = Option<ChannelMsg>> + Send {
        self.wait()
    }
}

impl MsgSource for tokio::sync::mpsc::Receiver<ChannelMsg> {
    fn next(&mut self) -> impl Future<Output = Option<ChannelMsg>> + Send {
        self.recv()
    }
}

/// 讀端迴圈（抽成泛型好測）。
///
/// `Data` / `ExtendedData` 累積到緩衝；緩衝 ≥ `COALESCE_BYTES` 或距第一個位元組 ≥ `COALESCE_DELAY`
/// 就 flush。`ExitStatus` / `ExitSignal` 記下來；`Close` 或來源結束 → flush 後送 `Exit`。
/// `Eof` 不結束（OpenSSH 先 Eof 再 ExitStatus 再 Close），`Success` / `Failure` / `WindowAdjusted` 略過。
pub(crate) async fn pump<S: MsgSource>(src: &mut S, sink: &TermSink) {
    let mut buf: Vec<u8> = Vec::with_capacity(COALESCE_BYTES);
    let mut first_at: Option<tokio::time::Instant> = None;
    let mut status: Option<u32> = None;
    let mut signal: Option<String> = None;
    let flush = |buf: &mut Vec<u8>, first_at: &mut Option<tokio::time::Instant>| {
        if !buf.is_empty() {
            sink(TermEvent::Data(std::mem::take(buf)));
        }
        *first_at = None;
    };
    loop {
        // sleep 只在緩衝非空時武裝，否則 select 會空轉。
        let deadline = first_at.map(|t| t + COALESCE_DELAY);
        tokio::select! {
            msg = src.next() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if buf.is_empty() {
                        first_at = Some(tokio::time::Instant::now());
                    }
                    buf.extend_from_slice(&data);
                    if buf.len() >= COALESCE_BYTES {
                        flush(&mut buf, &mut first_at);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                    signal = Some(sig_name(&signal_name));
                }
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)), if deadline.is_some() => {
                flush(&mut buf, &mut first_at);
            }
        }
    }
    flush(&mut buf, &mut first_at);
    sink(TermEvent::Exit { status, signal });
}

/// `Sig` 沒有公開的名稱存取器，從 Debug 表示取（`TERM` / `Custom("FOO")` → `FOO`）。
fn sig_name(s: &russh::Sig) -> String {
    let d = format!("{s:?}");
    d.strip_prefix("Custom(\"")
        .and_then(|r| r.strip_suffix("\")"))
        .map(str::to_string)
        .unwrap_or(d)
}

/// 前端送來的 base64 輸入 → 位元組。
pub fn decode_b64_input(s: &str) -> AppResult<Vec<u8>> {
    if s.is_empty() {
        return Ok(Vec::new());
    }
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|_| AppError::Ssh(t!("無效的 base64 輸入").into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use tokio::sync::mpsc;

    fn data(s: &[u8]) -> ChannelMsg {
        ChannelMsg::Data { data: Bytes::copy_from_slice(s) }
    }

    /// 起一條 mpsc 當假 channel，回 (送訊息端, 收事件端)。
    fn rig() -> (mpsc::Sender<ChannelMsg>, mpsc::UnboundedReceiver<TermEvent>) {
        let (tx, mut rx) = mpsc::channel::<ChannelMsg>(64);
        let (etx, erx) = mpsc::unbounded_channel::<TermEvent>();
        let sink: TermSink = Arc::new(move |ev| {
            let _ = etx.send(ev);
        });
        tokio::spawn(async move {
            pump(&mut rx, &sink).await;
        });
        (tx, erx)
    }

    #[tokio::test]
    async fn coalesces_small_chunks_by_time() {
        let (tx, mut ev) = rig();
        for s in [&b"a"[..], b"b", b"c"] {
            tx.send(data(s)).await.unwrap();
        }
        // 8 ms 內沒有東西；之後三段合併成一段。
        let got = tokio::time::timeout(Duration::from_millis(500), ev.recv()).await.unwrap().unwrap();
        assert_eq!(got, TermEvent::Data(b"abc".to_vec()));
        assert!(ev.try_recv().is_err(), "不該有第二段");
        drop(tx);
        let exit = tokio::time::timeout(Duration::from_millis(500), ev.recv()).await.unwrap().unwrap();
        assert_eq!(exit, TermEvent::Exit { status: None, signal: None });
    }

    #[tokio::test]
    async fn flushes_immediately_at_size_threshold() {
        let (tx, mut ev) = rig();
        let big = vec![b'x'; COALESCE_BYTES + 100];
        tx.send(data(&big)).await.unwrap();
        // 不等 8 ms 就該送出（給排程一點時間，但遠小於 8 ms 也算不準——只驗內容）。
        let got = tokio::time::timeout(Duration::from_millis(500), ev.recv()).await.unwrap().unwrap();
        assert_eq!(got, TermEvent::Data(big));
        // 之後的小段仍照時間合併
        tx.send(data(b"tail")).await.unwrap();
        let got = tokio::time::timeout(Duration::from_millis(500), ev.recv()).await.unwrap().unwrap();
        assert_eq!(got, TermEvent::Data(b"tail".to_vec()));
    }

    #[tokio::test]
    async fn exit_status_is_recorded_and_flushed_before_exit() {
        let (tx, mut ev) = rig();
        tx.send(data(b"bye")).await.unwrap();
        tx.send(ChannelMsg::Eof).await.unwrap();
        tx.send(ChannelMsg::ExitStatus { exit_status: 3 }).await.unwrap();
        tx.send(ChannelMsg::Close).await.unwrap();
        let a = ev.recv().await.unwrap();
        let b = ev.recv().await.unwrap();
        assert_eq!(a, TermEvent::Data(b"bye".to_vec()), "資料先於 Exit");
        assert_eq!(b, TermEvent::Exit { status: Some(3), signal: None });
        assert!(ev.recv().await.is_none(), "Close 後任務結束、sink 被 drop");
    }

    #[tokio::test]
    async fn exit_signal_name() {
        let (tx, mut ev) = rig();
        tx.send(ChannelMsg::ExitSignal {
            signal_name: russh::Sig::TERM,
            core_dumped: false,
            error_message: String::new(),
            lang_tag: String::new(),
        })
        .await
        .unwrap();
        drop(tx);
        assert_eq!(
            ev.recv().await.unwrap(),
            TermEvent::Exit { status: None, signal: Some("TERM".into()) }
        );
        assert_eq!(sig_name(&russh::Sig::Custom("FOO".into())), "FOO");
    }

    #[test]
    fn decode_b64() {
        assert_eq!(decode_b64_input("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_b64_input("bHMgLWxhDQ==").unwrap(), b"ls -la\r".to_vec());
        assert!(matches!(decode_b64_input("###"), Err(AppError::Ssh(_))));
    }
}
