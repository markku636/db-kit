//! Docker 串流：log follow 與 exec 互動終端。與 Tauri 無關——輸出一律經 `StreamSink` 閉包送出，
//! GUI 端（commands/docker.rs）把它接到 `tauri::ipc::Channel`，做法同 SSH 的 `TermSink`。
//!
//! - 非 TTY 容器的 log / attach 是多工格式：每幀 8-byte header `[type,0,0,0,len_be32]` + payload，
//!   type 1 = stdout、2 = stderr。`Demux` 把它拆回來（stderr 以亮紅色呈現）。
//! - 輸出合併節流：累積到 16 KiB 或距第一筆待送資料 8 ms 就送一次（同 ssh/terminal.rs 的 pump），
//!   避免大量 log 逐塊觸發 IPC。
//! - 登記簿 `DockerStreams`：stream id → 背景任務；斷線 / 移除連線時依連線 id 一次收掉。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt, WriteHalf};

use super::api::DockerApi;
use crate::error::{AppError, AppResult};

/// 串流事件。
pub enum StreamEvent {
    Data(Vec<u8>),
    /// 串流結束：`error` = 異常原因；`exit_code` = exec 的結束碼（log 串流為 None）。
    End { error: Option<String>, exit_code: Option<i64> },
}

pub type StreamSink = Arc<dyn Fn(StreamEvent) + Send + Sync>;

const FLUSH_BYTES: usize = 16 * 1024;
const FLUSH_DELAY: Duration = Duration::from_millis(8);
const STDERR_ON: &[u8] = b"\x1b[91m";
const STDERR_OFF: &[u8] = b"\x1b[0m";

/// 多工 log 拆幀器（可跨 chunk 邊界累積）。
#[derive(Default)]
pub struct Demux {
    buf: Vec<u8>,
}

impl Demux {
    /// 餵入一塊資料，回傳完整的幀（type, payload）。不完整的尾巴留待下次。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<(u8, Vec<u8>)> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut pos = 0;
        while self.buf.len() - pos >= 8 {
            let h = &self.buf[pos..pos + 8];
            let len = u32::from_be_bytes([h[4], h[5], h[6], h[7]]) as usize;
            if self.buf.len() - pos - 8 < len {
                break;
            }
            let kind = h[0];
            out.push((kind, self.buf[pos + 8..pos + 8 + len].to_vec()));
            pos += 8 + len;
        }
        self.buf.drain(..pos);
        out
    }

    /// 已拆幀的輸出轉成顯示位元組（stderr 上色）。
    pub fn render(frames: Vec<(u8, Vec<u8>)>, out: &mut Vec<u8>) {
        for (kind, payload) in frames {
            if kind == 2 {
                out.extend_from_slice(STDERR_ON);
                out.extend_from_slice(&payload);
                out.extend_from_slice(STDERR_OFF);
            } else {
                out.extend_from_slice(&payload);
            }
        }
    }
}

/// 一條 exec 互動 session：寫入端 + exec id（resize 用）。
pub struct ExecSession {
    writer: tokio::sync::Mutex<WriteHalf<reqwest::Upgraded>>,
    exec_id: String,
    api: Arc<DockerApi>,
}

impl ExecSession {
    pub async fn write(&self, data: &[u8]) -> AppResult<()> {
        let mut w = self.writer.lock().await;
        w.write_all(data).await.map_err(|e| AppError::Query(e.to_string()))?;
        w.flush().await.map_err(|e| AppError::Query(e.to_string()))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        self.api.exec_resize(&self.exec_id, cols.max(1), rows.max(1)).await
    }

    async fn shutdown(&self) {
        let _ = self.writer.lock().await.shutdown().await;
    }
}

struct Entry {
    conn_id: String,
    task: tokio::task::AbortHandle,
    exec: Option<Arc<ExecSession>>,
}

/// log / exec 串流登記簿。
#[derive(Default)]
pub struct DockerStreams {
    inner: Mutex<HashMap<String, Entry>>,
}

/// 同時開著的串流上限（每條都佔一個 daemon 連線）。
const MAX_STREAMS: usize = 64;

impl DockerStreams {
    pub fn new() -> Self {
        Self::default()
    }

    fn check_capacity(&self) -> AppResult<()> {
        if self.inner.lock().len() >= MAX_STREAMS {
            return Err(AppError::Query(t!("同時開啟的 Docker 串流太多，請先關閉一些 log / 終端分頁").into()));
        }
        Ok(())
    }

    /// 開 log 串流（`id` 由呼叫端先產生，讓 sink 在串流極短時也知道自己的 id）。
    #[allow(clippy::too_many_arguments)]
    pub async fn open_logs(
        self: &Arc<Self>,
        id: String,
        conn_id: &str,
        api: Arc<DockerApi>,
        container: &str,
        tail: u32,
        timestamps: bool,
        follow: bool,
        sink: StreamSink,
    ) -> AppResult<()> {
        self.check_capacity()?;
        let tty = api.container_tty(container).await?;
        let resp = api.logs(container, tail, timestamps, follow).await?;
        let me = self.clone();
        let sid = id.clone();
        // 先持鎖再 spawn：避免極短的串流在登記前就結束、remove 找不到而殘留。
        let mut map = self.inner.lock();
        let task = tokio::spawn(async move {
            let err = pump_logs(resp, tty, &sink).await.err();
            sink(StreamEvent::End { error: err, exit_code: None });
            me.inner.lock().remove(&sid);
        });
        map.insert(id, Entry { conn_id: conn_id.to_string(), task: task.abort_handle(), exec: None });
        Ok(())
    }

    /// 開 exec 互動終端。`cmd` 為空 → 自動挑 bash / sh。
    #[allow(clippy::too_many_arguments)]
    pub async fn open_exec(
        self: &Arc<Self>,
        id: String,
        conn_id: &str,
        api: Arc<DockerApi>,
        container: &str,
        cmd: Vec<String>,
        user: &str,
        cols: u32,
        rows: u32,
        sink: StreamSink,
    ) -> AppResult<()> {
        self.check_capacity()?;
        let cmd = if cmd.is_empty() { default_shell() } else { cmd };
        let exec_id = api.exec_create(container, &cmd, user, true).await?;
        let upgraded = api.exec_start(&exec_id, true).await?;
        let (mut reader, writer) = tokio::io::split(upgraded);
        let session = Arc::new(ExecSession { writer: tokio::sync::Mutex::new(writer), exec_id: exec_id.clone(), api: api.clone() });
        let _ = session.resize(cols, rows).await;

        let me = self.clone();
        let sid = id.clone();
        let mut map = self.inner.lock();
        let task = tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            let mut error = None;
            loop {
                let read = if pending.is_empty() {
                    reader.read(&mut buf).await
                } else {
                    match tokio::time::timeout(FLUSH_DELAY, reader.read(&mut buf)).await {
                        Ok(r) => r,
                        Err(_) => {
                            sink(StreamEvent::Data(std::mem::take(&mut pending)));
                            continue;
                        }
                    }
                };
                match read {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        if pending.len() >= FLUSH_BYTES {
                            sink(StreamEvent::Data(std::mem::take(&mut pending)));
                        }
                    }
                    Err(e) => {
                        error = Some(e.to_string());
                        break;
                    }
                }
            }
            if !pending.is_empty() {
                sink(StreamEvent::Data(pending));
            }
            // 讀端 EOF 後 daemon 可能還沒把 exec 標成結束，稍等再查。
            let mut exit_code = None;
            for _ in 0..5 {
                match api.exec_exit_code(&exec_id).await {
                    Ok(Some(c)) => {
                        exit_code = Some(c);
                        break;
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(100)).await,
                    Err(_) => break,
                }
            }
            sink(StreamEvent::End { error, exit_code });
            me.inner.lock().remove(&sid);
        });
        map.insert(id, Entry { conn_id: conn_id.to_string(), task: task.abort_handle(), exec: Some(session) });
        Ok(())
    }

    pub fn exec(&self, id: &str) -> AppResult<Arc<ExecSession>> {
        self.inner
            .lock()
            .get(id)
            .and_then(|e| e.exec.clone())
            .ok_or_else(|| AppError::NotFound(id.to_string()))
    }

    /// 關掉一條串流（找不到即視為已關）。
    pub async fn close(&self, id: &str) {
        let entry = self.inner.lock().remove(id);
        if let Some(e) = entry {
            e.task.abort();
            if let Some(s) = e.exec {
                s.shutdown().await;
            }
        }
    }

    /// 關掉某連線的所有串流（斷線 / 移除連線）。
    pub async fn close_conn(&self, conn_id: &str) {
        let entries: Vec<Entry> = {
            let mut map = self.inner.lock();
            let ids: Vec<String> = map.iter().filter(|(_, e)| e.conn_id == conn_id).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        for e in entries {
            e.task.abort();
            if let Some(s) = e.exec {
                s.shutdown().await;
            }
        }
    }
}

/// 預設 shell：有 bash 用 bash，否則 sh（多數精簡映像只有 sh）。
pub fn default_shell() -> Vec<String> {
    vec![
        "/bin/sh".into(),
        "-c".into(),
        "if [ -x /bin/bash ]; then exec /bin/bash; elif [ -x /bin/ash ]; then exec /bin/ash; else exec /bin/sh; fi".into(),
    ]
}

/// 讀完 log 串流（follow 時直到容器停止或被 abort）。
async fn pump_logs(resp: reqwest::Response, tty: bool, sink: &StreamSink) -> Result<(), String> {
    let mut stream = resp.bytes_stream();
    let mut demux = Demux::default();
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let next = if pending.is_empty() {
            stream.next().await
        } else {
            match tokio::time::timeout(FLUSH_DELAY, stream.next()).await {
                Ok(n) => n,
                Err(_) => {
                    sink(StreamEvent::Data(std::mem::take(&mut pending)));
                    continue;
                }
            }
        };
        match next {
            None => break,
            Some(Ok(chunk)) => {
                if tty {
                    pending.extend_from_slice(&chunk);
                } else {
                    Demux::render(demux.feed(&chunk), &mut pending);
                }
                if pending.len() >= FLUSH_BYTES {
                    sink(StreamEvent::Data(std::mem::take(&mut pending)));
                }
            }
            Some(Err(e)) => {
                if !pending.is_empty() {
                    sink(StreamEvent::Data(std::mem::take(&mut pending)));
                }
                return Err(e.to_string());
            }
        }
    }
    if !pending.is_empty() {
        sink(StreamEvent::Data(pending));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![kind, 0, 0, 0];
        v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn demux_whole_frames() {
        let mut d = Demux::default();
        let mut data = frame(1, b"hello\n");
        data.extend(frame(2, b"oops\n"));
        let frames = d.feed(&data);
        assert_eq!(frames, vec![(1, b"hello\n".to_vec()), (2, b"oops\n".to_vec())]);
    }

    #[test]
    fn demux_split_across_chunks() {
        let mut d = Demux::default();
        let data = frame(1, b"abcdefgh");
        assert!(d.feed(&data[..5]).is_empty()); // header 未滿
        assert!(d.feed(&data[5..10]).is_empty()); // payload 未滿
        assert_eq!(d.feed(&data[10..]), vec![(1, b"abcdefgh".to_vec())]);
        assert!(d.buf.is_empty());
    }

    #[test]
    fn render_colors_stderr() {
        let mut out = Vec::new();
        Demux::render(vec![(1, b"a".to_vec()), (2, b"b".to_vec())], &mut out);
        assert_eq!(out, b"a\x1b[91mb\x1b[0m");
    }

    #[test]
    fn empty_frame_ok() {
        let mut d = Demux::default();
        assert_eq!(d.feed(&frame(1, b"")), vec![(1, Vec::new())]);
    }
}
