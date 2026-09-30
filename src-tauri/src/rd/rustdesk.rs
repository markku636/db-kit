//! RustDesk 相容連線：啟動獨立的輔助程式 `dbk-rustdesk-bridge`、經 stdin / stdout 跟它交換訊息。
//!
//! 協定實作（取自 RustDesk，AGPL-3.0）全部在那個程式裡（repo 的 `rustdesk-bridge/`，獨立發行、獨立授權）；
//! db-kit 這邊只啟動子程序、轉送訊息，不連結它的程式碼，所以本體維持 MIT。
//!
//! 訊息格式（兩個方向相同）：`[u32 長度（LE，不含這 4 bytes）][u8 型別][內容]`。
//! - 型別 1：JSON（db-kit → bridge：`connect` / `mouse` / `key` / `ctrl_alt_del` / `refresh`；bridge → db-kit：事件）。
//! - 型別 2（bridge → db-kit）：影像 `[u8 codec][u8 key][u8 display][u8 保留][i64 pts]` + 仍是 VP9 / VP8 / AV1 的位元流。
//!
//! 給前端的 Channel 訊息 = `[u8 型別][內容]`（拿掉長度）：影像在 WebView 裡用 WebCodecs 解，JSON 事件照轉。

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use super::runtime::RdCtl;
use crate::error::{AppError, AppResult};

pub const BRIDGE_NAME: &str = "dbk-rustdesk-bridge";
pub const TYPE_JSON: u8 = 1;
/// 單則上限（一張 4K 關鍵畫面也遠低於此）。
const MAX_MSG: usize = 128 * 1024 * 1024;

/// 給前端的輸出（一則 Channel 訊息）。
pub type Sink = std::sync::Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// 輔助程式的位置：`DBKIT_RUSTDESK_BRIDGE` 環境變數（開發 / 測試），否則主程式旁邊
/// （Tauri 的 `externalBin` 打包後就放在那裡，名稱去掉 target triple）。
pub fn bridge_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("DBKIT_RUSTDESK_BRIDGE").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join(format!("{BRIDGE_NAME}{}", std::env::consts::EXE_SUFFIX));
    p.exists().then_some(p)
}

/// 連線參數（密碼經 stdin 傳，不放命令列）。
#[derive(Clone)]
pub struct RustdeskParams {
    pub host: String,
    pub port: u16,
    pub password: String,
}

impl std::fmt::Debug for RustdeskParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RustdeskParams").field("host", &self.host).field("port", &self.port).finish()
    }
}

pub async fn read_msg<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_le_bytes(len) as usize;
    if n == 0 || n > MAX_MSG {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad bridge message length"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

pub async fn write_json<W: AsyncWrite + Unpin>(w: &mut W, v: &serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(v).map_err(std::io::Error::other)?;
    write_typed(w, TYPE_JSON, &body).await
}

async fn write_typed<W: AsyncWrite + Unpin>(w: &mut W, ty: u8, body: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(5 + body.len());
    buf.extend_from_slice(&((body.len() + 1) as u32).to_le_bytes());
    buf.push(ty);
    buf.extend_from_slice(body);
    w.write_all(&buf).await?;
    w.flush().await
}

fn json_of(msg: &[u8]) -> Option<serde_json::Value> {
    (msg.first() == Some(&TYPE_JSON)).then(|| serde_json::from_slice(&msg[1..]).ok()).flatten()
}

/// 已連上（登入完成）的輔助程式。
pub struct Connected {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    /// 登入成功的那則事件（前端要從裡面拿螢幕清單）。
    pub hello: Vec<u8>,
    /// 目前螢幕的大小（沒有資訊時 0）。
    pub size: (u16, u16),
}

/// 啟動輔助程式並登入。密碼錯 → `RdAuth`（呼叫端重問密碼再來）。
pub async fn connect(p: &RustdeskParams, timeout: Duration) -> AppResult<Connected> {
    let path = bridge_path().ok_or_else(|| {
        AppError::Rd(t!("找不到 RustDesk 連線元件（dbk-rustdesk-bridge），請重新安裝 db-kit").into())
    })?;
    let mut cmd = Command::new(&path);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不要閃一個主控台視窗
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Rd(tf!("無法啟動 RustDesk 連線元件：{e}", e = e)))?;
    let mut stdin = child.stdin.take().ok_or_else(|| AppError::Rd("bridge stdin".into()))?;
    let mut stdout = child.stdout.take().ok_or_else(|| AppError::Rd("bridge stdout".into()))?;
    write_json(
        &mut stdin,
        &json!({
            "t": "connect",
            "host": p.host,
            "port": p.port,
            "password": p.password,
            "decoders": { "vp9": true, "vp8": true, "av1": false },
            "my_name": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default(),
        }),
    )
    .await
    .map_err(|e| AppError::Rd(tf!("RustDesk 連線元件沒有回應：{e}", e = e)))?;

    // 等登入結果（對方可能要在畫面上按「接受」，所以時間給長一點）。
    let wait = async {
        loop {
            let Some(msg) = read_msg(&mut stdout).await.map_err(|e| AppError::Rd(e.to_string()))? else {
                return Err(AppError::Rd(t!("RustDesk 連線元件意外結束").into()));
            };
            let Some(v) = json_of(&msg) else { continue };
            match v["type"].as_str() {
                Some("connected") => {
                    let cur = v["peer"]["current_display"].as_u64().unwrap_or(0) as usize;
                    let d = &v["peer"]["displays"][cur];
                    let size = (d["width"].as_u64().unwrap_or(0) as u16, d["height"].as_u64().unwrap_or(0) as u16);
                    return Ok((msg, size));
                }
                Some("login_error") => {
                    let m = v["message"].as_str().unwrap_or_default().to_string();
                    return Err(AppError::RdAuth(login_error_text(&m)));
                }
                Some("error") | Some("closed") => {
                    let m = v["message"].as_str().or(v["reason"].as_str()).unwrap_or_default().to_string();
                    return Err(AppError::Rd(m));
                }
                _ => {}
            }
        }
    };
    match tokio::time::timeout(timeout, wait).await {
        Ok(Ok((hello, size))) => Ok(Connected { child, stdin, stdout, hello, size }),
        Ok(Err(e)) => {
            let _ = child.kill().await;
            Err(e)
        }
        Err(_) => {
            let _ = child.kill().await;
            Err(AppError::Rd(t!("RustDesk 連線逾時（對方沒有回應，或沒有在畫面上按接受）").into()))
        }
    }
}

/// 對方回的登入錯誤 → 使用者看得懂的句子（原文附在後面，方便查）。
fn login_error_text(m: &str) -> String {
    match m {
        "Wrong Password" => t!("RustDesk 密碼錯誤").into(),
        "No Password Access" | "Password Required" => t!("對方要求輸入密碼").into(),
        _ if m.contains("denied") || m.contains("Denied") => tf!("對方拒絕了連線：{m}", m = m),
        _ => m.to_string(),
    }
}

/// 工作階段：輔助程式的輸出轉給前端；前端的輸入（`rd_write` 的 JSON）轉給輔助程式。
/// 回傳結束原因（`None` = 使用者自己斷的）。
pub async fn run(c: Connected, mut ctl: mpsc::UnboundedReceiver<RdCtl>, sink: Sink) -> Option<String> {
    let Connected { mut child, mut stdin, mut stdout, hello, .. } = c;
    sink(hello);
    let reason = loop {
        tokio::select! {
            msg = read_msg(&mut stdout) => match msg {
                Ok(Some(m)) => {
                    if let Some(v) = json_of(&m) {
                        if v["type"] == "closed" || v["type"] == "error" {
                            let r = v["reason"].as_str().or(v["message"].as_str()).unwrap_or_default().to_string();
                            break Some(if r.is_empty() { t!("遠端主機關閉了連線").to_string() } else { r });
                        }
                    }
                    sink(m);
                }
                Ok(None) | Err(_) => break Some(t!("RustDesk 連線元件意外結束").to_string()),
            },
            m = ctl.recv() => {
                let cmd = match m {
                    // 前端直接送 JSON 指令（mouse / key），原樣轉。
                    Some(RdCtl::Write(bytes)) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                        Ok(v) => Some(v),
                        Err(_) => None,
                    },
                    Some(RdCtl::Keys(name)) if name == "ctrl_alt_del" => Some(json!({ "t": "ctrl_alt_del" })),
                    Some(RdCtl::Refresh) => Some(json!({ "t": "refresh" })),
                    Some(RdCtl::Close) | None => break None,
                    Some(_) => None,
                };
                if let Some(v) = cmd {
                    if write_json(&mut stdin, &v).await.is_err() {
                        break Some(t!("RustDesk 連線元件意外結束").to_string());
                    }
                }
            }
        }
    };
    // 關 stdin = 請它結束；等一下，還不走就砍掉。
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    reason
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn framing_roundtrip() {
        let mut buf = Vec::new();
        write_json(&mut buf, &json!({ "t": "refresh" })).await.unwrap();
        assert_eq!(&buf[..4], &((buf.len() - 4) as u32).to_le_bytes());
        let mut r = &buf[..];
        let m = read_msg(&mut r).await.unwrap().unwrap();
        assert_eq!(json_of(&m).unwrap()["t"], "refresh");
        assert!(read_msg(&mut r).await.unwrap().is_none());
    }

    #[test]
    fn login_errors_are_readable() {
        assert_eq!(login_error_text("Wrong Password"), "RustDesk 密碼錯誤");
        assert_eq!(login_error_text("weird"), "weird");
    }

    #[test]
    fn env_override_wins() {
        std::env::set_var("DBKIT_RUSTDESK_BRIDGE", "C:/x/bridge.exe");
        assert_eq!(bridge_path(), Some(PathBuf::from("C:/x/bridge.exe")));
        std::env::remove_var("DBKIT_RUSTDESK_BRIDGE");
    }
}
