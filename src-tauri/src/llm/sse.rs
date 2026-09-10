//! Server-Sent Events 解析：把 reqwest 的 bytes stream 切成一則則 `data:` 內容。
//!
//! 兩家的串流都是 SSE，但分行位置與 chunk 邊界無關（一個 chunk 可能含半行、也可能含十行），
//! 且 UTF-8 多位元組字元會被切在 chunk 中間 —— 所以緩衝用 `Vec<u8>`、湊滿一行才解碼，
//! 不能對每個 chunk 直接 `from_utf8_lossy`（會生出替換字元，中文串流會出現亂碼方塊）。
//!
//! 讀取用 `Response::chunk()` 而非 `bytes_stream()`：少一個 futures 相依，行為相同。

/// 逐位元組累積、以換行切行的緩衝區。與 HTTP 無關，可單獨測試。
#[derive(Default)]
pub struct SseBuf {
    buf: Vec<u8>,
}

impl SseBuf {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 餵一段位元組，回傳這段之後湊滿的所有 `data:` 內容（已 trim，不含 `[DONE]`）。
    /// 第二個回傳值為 true 代表收到 `[DONE]`（OpenAI 的結束標記）。
    pub fn feed(&mut self, bytes: &[u8]) -> (Vec<String>, bool) {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut done = false;
        loop {
            let Some(pos) = self.buf.iter().position(|b| *b == b'\n') else { break };
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            // `event:` / `id:` / 空行（事件分隔）一律略過：兩家的判別資訊都在 data 的 JSON 裡。
            let Some(payload) = line.strip_prefix("data:") else { continue };
            let payload = payload.trim();
            if payload.is_empty() {
                continue;
            }
            if payload == "[DONE]" {
                done = true;
                continue;
            }
            out.push(payload.to_string());
        }
        (out, done)
    }
}

/// 讀完整個 SSE 回應；每則 data 呼叫一次 `on_data`。
/// `on_data` 回 `Ok(false)` 代表提早收工（例如已拿到 stop_reason）。
pub async fn read_sse<F>(mut resp: reqwest::Response, mut on_data: F) -> Result<(), String>
where
    F: FnMut(&str) -> Result<bool, String>,
{
    let mut sse = SseBuf::new();
    loop {
        let chunk = resp.chunk().await.map_err(|e| tf!("串流中斷：{e}", e = e))?;
        let Some(bytes) = chunk else { break };
        let (items, done) = sse.feed(&bytes);
        for item in items {
            if !on_data(&item)? {
                return Ok(());
            }
        }
        if done {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_across_chunks() {
        let mut b = SseBuf::new();
        let (a, done) = b.feed(b"data: {\"a\":1}\n\ndata: {\"b\"");
        assert_eq!(a, vec!["{\"a\":1}"]);
        assert!(!done);
        let (c, done2) = b.feed(b":2}\n\ndata: [DONE]\n\n");
        assert_eq!(c, vec!["{\"b\":2}"]);
        assert!(done2);
    }

    #[test]
    fn utf8_split_across_chunks_is_not_mangled() {
        // 「剪」= E5 89 AA，故意切在中間
        let mut b = SseBuf::new();
        let (none, _) = b.feed(&[b'd', b'a', b't', b'a', b':', b' ', 0xE5, 0x89]);
        assert!(none.is_empty());
        let (out, _) = b.feed(&[0xAA, b'\n']);
        assert_eq!(out, vec!["剪"]);
    }

    #[test]
    fn ignores_event_and_id_lines() {
        let mut b = SseBuf::new();
        let (out, _) = b.feed(b"event: content_block_delta\nid: 1\ndata: {\"x\":1}\n");
        assert_eq!(out, vec!["{\"x\":1}"]);
    }
}
