//! 非互動執行一段指令：一條 session channel 上的 `exec`（沒有 PTY），收 stdout / stderr / exit code。
//!
//! 給 `dbk mcp` 的 `ssh_run` 用（終端機分頁走的是 `terminal` 的 PTY shell）。
//! - stdin 一開始就送 EOF：要輸入的程式（沒有 NOPASSWD 的 sudo、等確認的安裝程式）立刻失敗，不會卡到逾時。
//! - 輸出只留頭尾（`Capped`）：`cat` 一個大檔或 `journalctl` 沒加 -n 時，不會把整段對話擠掉。
//! - 逾時送 SIGKILL 再關 channel（OpenSSH 7.9 起才收 signal 請求；不收的伺服器在 channel 關閉後通常會 SIGHUP）。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use russh::client::Handle;
use russh::{ChannelMsg, Sig};

use super::auth::DbkHandler;
use crate::error::{AppError, AppResult};

/// 收到 exit status 後再等多久的 EOF / Close（有些伺服器先送 exit 才送最後一段輸出）。
const EXIT_GRACE: Duration = Duration::from_secs(2);

/// 只留頭 `head` 與尾 `tail` 位元組的緩衝；`total` 是實際收到的量。
#[derive(Debug, Clone)]
pub struct Capped {
    head_cap: usize,
    tail_cap: usize,
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
}

impl Capped {
    pub fn new(head_cap: usize, tail_cap: usize) -> Self {
        Self { head_cap, tail_cap, head: Vec::new(), tail: VecDeque::new(), total: 0 }
    }

    pub fn push(&mut self, mut data: &[u8]) {
        self.total += data.len();
        if self.head.len() < self.head_cap {
            let n = (self.head_cap - self.head.len()).min(data.len());
            self.head.extend_from_slice(&data[..n]);
            data = &data[n..];
        }
        if self.tail_cap == 0 || data.is_empty() {
            return;
        }
        if data.len() >= self.tail_cap {
            self.tail.clear();
            self.tail.extend(&data[data.len() - self.tail_cap..]);
            return;
        }
        let overflow = (self.tail.len() + data.len()).saturating_sub(self.tail_cap);
        self.tail.drain(..overflow);
        self.tail.extend(data);
    }

    /// 中間被省略的位元組數。
    pub fn omitted(&self) -> usize {
        self.total - self.head.len() - self.tail.len()
    }

    pub fn is_empty(&self) -> bool {
        self.total == 0
    }

    /// 轉成文字（非 UTF-8 的位元組以 � 取代）；中間有省略時插一行說明。
    pub fn render(&self) -> String {
        let head = String::from_utf8_lossy(&self.head);
        let tail_bytes: Vec<u8> = self.tail.iter().copied().collect();
        let tail = String::from_utf8_lossy(&tail_bytes);
        match self.omitted() {
            0 => format!("{head}{tail}"),
            n => format!("{head}\n…{}…\n{tail}", tf!("（中間省略 {n} 位元組）", n = n)),
        }
    }
}

/// 執行結果。
#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub stdout: Capped,
    pub stderr: Capped,
    pub exit_status: Option<u32>,
    pub exit_signal: Option<String>,
    /// 逾時被中斷（遠端程序可能仍在執行）。
    pub timed_out: bool,
    pub elapsed: Duration,
}

#[derive(Debug, Clone, Copy)]
pub struct ExecLimits {
    pub timeout: Duration,
    /// stdout 頭 / 尾各留多少。
    pub stdout: (usize, usize),
    pub stderr: (usize, usize),
}

/// 在一條已認證的連線上執行 `command`（交給使用者的登入 shell 解譯）。
pub async fn run(handle: &Handle<DbkHandler>, command: &str, lim: ExecLimits) -> AppResult<ExecOutput> {
    let start = Instant::now();
    let mut ch = handle.channel_open_session().await.map_err(|e| AppError::Ssh(tf!("開啟 SSH 通道失敗：{e}", e = e)))?;
    ch.exec(true, command.as_bytes()).await.map_err(|e| AppError::Ssh(tf!("送出指令失敗：{e}", e = e)))?;
    let _ = ch.eof().await;

    let mut out = ExecOutput {
        stdout: Capped::new(lim.stdout.0, lim.stdout.1),
        stderr: Capped::new(lim.stderr.0, lim.stderr.1),
        exit_status: None,
        exit_signal: None,
        timed_out: false,
        elapsed: Duration::ZERO,
    };
    let mut deadline = tokio::time::Instant::now() + lim.timeout;
    let mut replied = false;
    loop {
        match tokio::time::timeout_at(deadline, ch.wait()).await {
            Err(_) => {
                // 已經拿到 exit status：只是伺服器沒送 Close，正常結束。
                if out.exit_status.is_none() && out.exit_signal.is_none() {
                    out.timed_out = true;
                    let _ = ch.signal(Sig::KILL).await;
                }
                let _ = ch.close().await;
                break;
            }
            Ok(None) | Ok(Some(ChannelMsg::Close)) => break,
            Ok(Some(msg)) => match msg {
                ChannelMsg::Data { data } => out.stdout.push(&data),
                ChannelMsg::ExtendedData { data, ext: 1 } => out.stderr.push(&data),
                ChannelMsg::Success => replied = true,
                ChannelMsg::Failure if !replied => {
                    let _ = ch.close().await;
                    return Err(AppError::Ssh(t!("伺服器拒絕執行指令（exec 請求被拒）").into()));
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    out.exit_status = Some(exit_status);
                    deadline = deadline.min(tokio::time::Instant::now() + EXIT_GRACE);
                }
                ChannelMsg::ExitSignal { signal_name, error_message, .. } => {
                    let name = format!("{signal_name:?}");
                    out.exit_signal = Some(if error_message.trim().is_empty() { name } else { format!("{name} ({})", error_message.trim()) });
                    deadline = deadline.min(tokio::time::Instant::now() + EXIT_GRACE);
                }
                _ => {}
            },
        }
    }
    out.elapsed = start.elapsed();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_keeps_head_and_tail() {
        let mut c = Capped::new(4, 4);
        c.push(b"abc");
        assert_eq!(c.render(), "abc");
        c.push(b"defgh");
        // 頭 abcd、尾 efgh，剛好沒有省略。
        assert_eq!(c.render(), "abcdefgh");
        c.push(b"ijkl");
        assert_eq!(c.total, 12);
        assert_eq!(c.omitted(), 4);
        let r = c.render();
        assert!(r.starts_with("abcd\n") && r.ends_with("\nijkl"), "{r}");
        // 一次塞進比尾巴還大的量：只留最後那段。
        let mut c = Capped::new(2, 3);
        c.push(b"0123456789");
        assert_eq!((c.omitted(), c.render().ends_with("789")), (5, true));
        // 沒有尾巴：只留頭。
        let mut c = Capped::new(3, 0);
        c.push(b"abcdef");
        assert_eq!(c.omitted(), 3);
        assert!(Capped::new(1, 1).is_empty());
    }
}
