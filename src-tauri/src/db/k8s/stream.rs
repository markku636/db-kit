//! Kubernetes 串流：Pod log follow 與 exec 互動終端。與 Tauri 無關——輸出經 `StreamSink`（與 Docker 共用型別）送出。
//!
//! - log：`GET …/pods/{pod}/log?follow=true` 的 chunked 回應，原樣轉給前端（xterm readOnly 會把 `\n` 轉 `\r\n`）。
//! - exec：WebSocket `v4.channel.k8s.io`；stdin 走 channel 0、resize 走 channel 4（`{"Width","Height"}`），
//!   channel 3 的 Status JSON 帶結束碼。非 TTY 時 stderr（channel 2）以亮紅色呈現。
//! - 輸出合併節流同 Docker：16 KiB 或 8 ms 送一次。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::mpsc;

use super::api::K8sApi;
use super::dto::LogOptions;
use super::ws::{self, Message, Read, CHANNEL_PROTOCOL};
use crate::db::docker::stream::{StreamEvent, StreamSink};
use crate::error::{AppError, AppResult};

const FLUSH_BYTES: usize = 16 * 1024;
const FLUSH_DELAY: Duration = Duration::from_millis(8);
const MAX_STREAMS: usize = 64;

enum Out {
    Data(Vec<u8>),
    Pong(Vec<u8>),
    Close,
}

/// 一條 exec session 的寫入端。
pub struct ExecSession {
    tx: mpsc::Sender<Out>,
}

impl ExecSession {
    pub async fn write(&self, data: &[u8]) -> AppResult<()> {
        let mut frame = Vec::with_capacity(data.len() + 1);
        frame.push(0u8);
        frame.extend_from_slice(data);
        self.tx.send(Out::Data(frame)).await.map_err(|_| AppError::Query(t!("終端機已關閉").into()))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        let mut frame = vec![4u8];
        frame.extend_from_slice(format!(r#"{{"Width":{},"Height":{}}}"#, cols.max(1), rows.max(1)).as_bytes());
        self.tx.send(Out::Data(frame)).await.map_err(|_| AppError::Query(t!("終端機已關閉").into()))
    }

    async fn shutdown(&self) {
        let _ = self.tx.send(Out::Close).await;
    }
}

struct Entry {
    conn_id: String,
    task: tokio::task::AbortHandle,
    exec: Option<Arc<ExecSession>>,
}

#[derive(Default)]
pub struct K8sStreams {
    inner: Mutex<HashMap<String, Entry>>,
}

impl K8sStreams {
    pub fn new() -> Self {
        Self::default()
    }

    fn check_capacity(&self) -> AppResult<()> {
        if self.inner.lock().len() >= MAX_STREAMS {
            return Err(AppError::Query(t!("同時開啟的 Kubernetes 串流太多，請先關閉一些 log / 終端分頁").into()));
        }
        Ok(())
    }

    pub async fn open_logs(
        self: &Arc<Self>,
        id: String,
        conn_id: &str,
        api: Arc<K8sApi>,
        ns: &str,
        pod: &str,
        opts: LogOptions,
        sink: StreamSink,
    ) -> AppResult<()> {
        self.check_capacity()?;
        let resp = api.logs(ns, pod, &opts).await?;
        let me = self.clone();
        let sid = id.clone();
        let mut map = self.inner.lock();
        let task = tokio::spawn(async move {
            let err = pump_bytes(resp, &sink).await.err();
            sink(StreamEvent::End { error: err, exit_code: None });
            me.inner.lock().remove(&sid);
        });
        map.insert(id, Entry { conn_id: conn_id.to_string(), task: task.abort_handle(), exec: None });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn open_exec(
        self: &Arc<Self>,
        id: String,
        conn_id: &str,
        api: Arc<K8sApi>,
        ns: &str,
        pod: &str,
        container: &str,
        cmd: Vec<String>,
        cols: u32,
        rows: u32,
        sink: StreamSink,
    ) -> AppResult<()> {
        self.check_capacity()?;
        let cmd = if cmd.is_empty() { crate::db::docker::stream::default_shell() } else { cmd };
        let tty = true;
        let upgraded = ws::connect(api.exec_request(ns, pod, container, &cmd, tty).await?, CHANNEL_PROTOCOL).await?;
        let (mut reader, mut writer) = ws::split(upgraded);
        let (tx, mut rx) = mpsc::channel::<Out>(256);
        let session = Arc::new(ExecSession { tx: tx.clone() });
        let _ = session.resize(cols, rows).await;

        let me = self.clone();
        let sid = id.clone();
        let mut map = self.inner.lock();
        let task = tokio::spawn(async move {
            let writer_task = tokio::spawn(async move {
                while let Some(o) = rx.recv().await {
                    let r = match o {
                        Out::Data(d) => writer.send_binary(&d).await,
                        Out::Pong(p) => writer.send_pong(&p).await,
                        Out::Close => break,
                    };
                    if r.is_err() {
                        break;
                    }
                }
                writer.close().await;
            });
            let mut pending: Vec<u8> = Vec::new();
            let mut error: Option<String> = None;
            let mut exit_code: Option<i64> = None;
            loop {
                let next = if pending.is_empty() {
                    reader.next().await
                } else {
                    match tokio::time::timeout(FLUSH_DELAY, reader.next()).await {
                        Ok(r) => r,
                        Err(_) => {
                            sink(StreamEvent::Data(std::mem::take(&mut pending)));
                            continue;
                        }
                    }
                };
                match next {
                    Ok(Read::Ping(p)) => {
                        let _ = tx.send(Out::Pong(p)).await;
                    }
                    Ok(Read::Msg(Message::Binary(data))) => {
                        let Some((&ch, payload)) = data.split_first() else { continue };
                        match ch {
                            1 => pending.extend_from_slice(payload),
                            2 => {
                                pending.extend_from_slice(b"\x1b[91m");
                                pending.extend_from_slice(payload);
                                pending.extend_from_slice(b"\x1b[0m");
                            }
                            3 => match parse_exit(payload) {
                                Ok(code) => exit_code = Some(code),
                                Err(msg) => error = Some(msg),
                            },
                            _ => {}
                        }
                        if pending.len() >= FLUSH_BYTES {
                            sink(StreamEvent::Data(std::mem::take(&mut pending)));
                        }
                    }
                    Ok(Read::Msg(Message::Text(_))) => {}
                    Ok(Read::Msg(Message::Close(..))) => break,
                    Err(e) => {
                        error = Some(e.to_string());
                        break;
                    }
                }
            }
            if !pending.is_empty() {
                sink(StreamEvent::Data(pending));
            }
            let _ = tx.send(Out::Close).await;
            let _ = writer_task.await;
            sink(StreamEvent::End { error, exit_code });
            me.inner.lock().remove(&sid);
        });
        map.insert(id, Entry { conn_id: conn_id.to_string(), task: task.abort_handle(), exec: Some(session) });
        Ok(())
    }

    pub fn exec(&self, id: &str) -> AppResult<Arc<ExecSession>> {
        self.inner.lock().get(id).and_then(|e| e.exec.clone()).ok_or_else(|| AppError::NotFound(id.to_string()))
    }

    pub async fn close(&self, id: &str) {
        let entry = self.inner.lock().remove(id);
        if let Some(e) = entry {
            if let Some(s) = &e.exec {
                s.shutdown().await;
                // 給寫端一點時間送出 close 幀再中止。
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            e.task.abort();
        }
    }

    pub async fn close_conn(&self, conn_id: &str) {
        let entries: Vec<Entry> = {
            let mut map = self.inner.lock();
            let ids: Vec<String> = map.iter().filter(|(_, e)| e.conn_id == conn_id).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        for e in entries {
            if let Some(s) = &e.exec {
                s.shutdown().await;
            }
            e.task.abort();
        }
    }
}

/// channel 3 的 Status：Success → 0；NonZeroExitCode → 結束碼；其他 Failure → 錯誤訊息。
pub fn parse_exit(payload: &[u8]) -> Result<i64, String> {
    let v: Value = serde_json::from_slice(payload).map_err(|_| String::from_utf8_lossy(payload).into_owned())?;
    if v["status"] == "Success" {
        return Ok(0);
    }
    if v["reason"] == "NonZeroExitCode" {
        let code = v["details"]["causes"]
            .as_array()
            .and_then(|c| c.iter().find(|x| x["reason"] == "ExitCode"))
            .and_then(|x| x["message"].as_str())
            .and_then(|m| m.parse().ok())
            .unwrap_or(1);
        return Ok(code);
    }
    Err(v["message"].as_str().unwrap_or("exec failed").to_string())
}

async fn pump_bytes(resp: reqwest::Response, sink: &StreamSink) -> Result<(), String> {
    let mut stream = resp.bytes_stream();
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
                pending.extend_from_slice(&chunk);
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

    #[test]
    fn exit_status_parsing() {
        assert_eq!(parse_exit(br#"{"metadata":{},"status":"Success"}"#), Ok(0));
        let nz = br#"{"metadata":{},"status":"Failure","message":"command terminated with non-zero exit code: error executing command [sh -c exit 3], exit code 3","reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"3"}]}}"#;
        assert_eq!(parse_exit(nz), Ok(3));
        let fail = br#"{"status":"Failure","message":"container not found (\"x\")"}"#;
        assert_eq!(parse_exit(fail), Err("container not found (\"x\")".into()));
    }
}
