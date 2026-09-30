// RustDesk 的封包框：1–4 bytes 的長度標頭（低 2 bits = 標頭長度 - 1，其餘 = 資料長度 << 2，little-endian）。
// 改寫自 rustdesk/hbb_common 的 src/bytes_codec.rs（AGPL-3.0）；這裡直接對 AsyncRead / AsyncWrite 讀寫，
// 不經 tokio-util 的 Framed。
//
// SPDX-License-Identifier: AGPL-3.0-only

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// 標頭表示得了的最大長度（4 bytes 標頭扣掉 2 bits）。
pub const MAX_FRAME_LENGTH: usize = 0x3FFF_FFFF;
/// 對方宣稱的長度再大也不先配置超過這麼多（照原實作：防惡意標頭把記憶體吃光）。
const MAX_PREALLOC: usize = 256 * 1024;
/// 單一封包上限（一張 4K 關鍵畫面也遠低於此）。
pub const MAX_PACKET: usize = 64 * 1024 * 1024;

pub fn encode_header(len: usize) -> io::Result<Vec<u8>> {
    let mut h = Vec::with_capacity(4);
    if len <= 0x3F {
        h.push((len << 2) as u8);
    } else if len <= 0x3FFF {
        h.extend_from_slice(&(((len << 2) as u16) | 0x1).to_le_bytes());
    } else if len <= 0x3F_FFFF {
        let v = ((len << 2) as u32) | 0x2;
        h.extend_from_slice(&(v as u16).to_le_bytes());
        h.push((v >> 16) as u8);
    } else if len <= MAX_FRAME_LENGTH {
        h.extend_from_slice(&(((len << 2) as u32) | 0x3).to_le_bytes());
    } else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
    }
    Ok(h)
}

pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, data: &[u8]) -> io::Result<()> {
    let mut buf = encode_header(data.len())?;
    buf.extend_from_slice(data);
    w.write_all(&buf).await?;
    w.flush().await
}

/// 讀一個封包；對方正常關閉 → `Ok(None)`。
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut first = [0u8; 1];
    match r.read(&mut first).await? {
        0 => return Ok(None),
        _ => {}
    }
    let head_len = ((first[0] & 0x3) + 1) as usize;
    let mut head = [0u8; 4];
    head[0] = first[0];
    if head_len > 1 {
        r.read_exact(&mut head[1..head_len]).await?;
    }
    let n = (u32::from_le_bytes(head) >> 2) as usize;
    if n > MAX_PACKET {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "packet too big"));
    }
    let mut data = Vec::with_capacity(n.min(MAX_PREALLOC));
    let mut left = n;
    let mut chunk = [0u8; 16 * 1024];
    while left > 0 {
        let want = left.min(chunk.len());
        r.read_exact(&mut chunk[..want]).await?;
        data.extend_from_slice(&chunk[..want]);
        left -= want;
    }
    Ok(Some(data))
}

/// 可以放在 `select!` 裡的讀取端：讀到一半被取消時，已經收到的 bytes 留在緩衝區，下次接著讀
/// （`read_frame` 的 `read_exact` 被取消會把讀到一半的封包丟掉，之後整條串流就錯位了）。
pub struct FrameReader<R> {
    r: R,
    buf: bytes::BytesMut,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(r: R) -> Self {
        Self { r, buf: bytes::BytesMut::with_capacity(64 * 1024) }
    }

    fn take_frame(&mut self) -> io::Result<Option<Vec<u8>>> {
        let Some(&first) = self.buf.first() else { return Ok(None) };
        let head_len = ((first & 0x3) + 1) as usize;
        if self.buf.len() < head_len {
            return Ok(None);
        }
        let mut head = [0u8; 4];
        head[..head_len].copy_from_slice(&self.buf[..head_len]);
        let n = (u32::from_le_bytes(head) >> 2) as usize;
        if n > MAX_PACKET {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "packet too big"));
        }
        if self.buf.len() < head_len + n {
            // 大封包：先把空間要夠，但不超過防呆上限。
            self.buf.reserve((head_len + n - self.buf.len()).min(MAX_PREALLOC * 16));
            return Ok(None);
        }
        let _ = self.buf.split_to(head_len);
        Ok(Some(self.buf.split_to(n).to_vec()))
    }

    /// 下一個封包；對方正常關閉 → `Ok(None)`。取消安全。
    pub async fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            if let Some(f) = self.take_frame()? {
                return Ok(Some(f));
            }
            if self.buf.capacity() - self.buf.len() < 16 * 1024 {
                self.buf.reserve(64 * 1024);
            }
            if self.r.read_buf(&mut self.buf).await? == 0 {
                return if self.buf.is_empty() {
                    Ok(None)
                } else {
                    Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed mid-packet"))
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一次只給幾個 bytes、中途還被取消：封包照樣完整、依序讀出。
    #[tokio::test]
    async fn frame_reader_survives_cancellation() {
        let mut wire = Vec::new();
        for len in [0usize, 5, 0x40, 0x5000] {
            write_frame(&mut wire, &vec![len as u8; len]).await.unwrap();
        }
        let (mut tx, rx) = tokio::io::duplex(64);
        let feeder = tokio::spawn(async move {
            for chunk in wire.chunks(7) {
                tx.write_all(chunk).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let mut r = FrameReader::new(rx);
        let mut got = Vec::new();
        while got.len() < 4 {
            // 很短的逾時 = 不斷在讀到一半時取消
            if let Ok(f) = tokio::time::timeout(std::time::Duration::from_micros(50), r.next()).await {
                got.push(f.unwrap().unwrap());
            }
        }
        feeder.await.unwrap();
        assert_eq!(got.iter().map(|f| f.len()).collect::<Vec<_>>(), vec![0, 5, 0x40, 0x5000]);
        assert!(got[3].iter().all(|b| *b == 0x5000u16 as u8));
        assert!(r.next().await.unwrap().is_none(), "EOF");
    }

    #[tokio::test]
    async fn roundtrip_all_header_sizes() {
        for len in [0usize, 1, 0x3F, 0x40, 0x3FFF, 0x4000, 0x3F_FFFF, 0x40_0000] {
            let data = vec![7u8; len];
            let mut buf = Vec::new();
            write_frame(&mut buf, &data).await.unwrap();
            let expect_head = match len {
                0..=0x3F => 1,
                0x40..=0x3FFF => 2,
                0x4000..=0x3F_FFFF => 3,
                _ => 4,
            };
            assert_eq!(buf.len(), len + expect_head, "len {len}");
            let mut r = &buf[..];
            assert_eq!(read_frame(&mut r).await.unwrap().unwrap(), data);
            assert!(read_frame(&mut r).await.unwrap().is_none());
        }
    }

    /// 跟原實作的編碼逐 byte 一致（取自 bytes_codec.rs 的測試數值）。
    #[test]
    fn header_bytes_match_upstream() {
        assert_eq!(encode_header(0x3F).unwrap(), vec![0xFC]);
        assert_eq!(encode_header(0x40).unwrap(), vec![0x01, 0x01]);
        assert_eq!(encode_header(0x4000).unwrap(), vec![0x02, 0x00, 0x01]);
    }

    #[tokio::test]
    async fn rejects_oversized_header() {
        let head = ((((MAX_PACKET + 1) << 2) as u32) | 0x3).to_le_bytes();
        let mut r = &head[..];
        assert!(read_frame(&mut r).await.is_err());
    }
}
