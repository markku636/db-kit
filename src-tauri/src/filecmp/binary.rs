//! 兩個本機檔的逐位元組比對。
//!
//! 位移對齊（同一個位移比同一個位移），不做插入 / 刪除的序列對齊：二進位檔多半是固定格式，
//! 對齊位移才看得出「哪個欄位變了」；一邊多出來的尾巴算成一段差異。

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 差異區段最多回傳幾段；超過標 `truncated`（差異位元組總數仍照算到底）。
pub const MAX_RANGES: usize = 10_000;
/// `read_bytes` 一次最多讀多少。
pub const READ_MAX: u64 = 1024 * 1024;
const CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BinDiff {
    pub size_a: u64,
    pub size_b: u64,
    /// 差異區段：[起始位移, 長度]，依位移排序、互不相鄰。
    pub ranges: Vec<[u64; 2]>,
    /// 不同的位元組總數（含一邊多出來的尾巴）。
    pub diff_bytes: u64,
    pub truncated: bool,
}

fn read_full<R: Read>(r: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// 比對兩個 reader（純函式：測試直接餵 `Cursor`）。
pub fn diff_readers<A: Read, B: Read>(mut a: A, mut b: B, max_ranges: usize, cancel: &AtomicBool) -> AppResult<BinDiff> {
    let mut ba = vec![0u8; CHUNK];
    let mut bb = vec![0u8; CHUNK];
    let (mut size_a, mut size_b) = (0u64, 0u64);
    let mut ranges: Vec<[u64; 2]> = Vec::new();
    let mut diff_bytes = 0u64;
    let mut truncated = false;
    // 進行中的差異區段起點（跨 chunk 延續）。
    let mut open: Option<u64> = None;
    let close = |start: u64, end: u64, ranges: &mut Vec<[u64; 2]>, truncated: &mut bool| {
        if ranges.len() < max_ranges {
            ranges.push([start, end - start]);
        } else {
            *truncated = true;
        }
    };
    let io = |e: std::io::Error| AppError::Compare(e.to_string());
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::CompareCancelled);
        }
        let na = read_full(&mut a, &mut ba).map_err(io)?;
        let nb = read_full(&mut b, &mut bb).map_err(io)?;
        let base = size_a.min(size_b);
        let common = na.min(nb);
        for i in 0..common {
            let pos = base + i as u64;
            if ba[i] != bb[i] {
                diff_bytes += 1;
                if open.is_none() {
                    open = Some(pos);
                }
            } else if let Some(s) = open.take() {
                close(s, pos, &mut ranges, &mut truncated);
            }
        }
        size_a += na as u64;
        size_b += nb as u64;
        if na != nb || na < CHUNK {
            // 至少一邊讀完了：把另一邊剩下的全部讀完，算成尾巴。
            let mut rest = [0u8; 64 * 1024];
            if na > nb {
                while let Ok(k) = a.read(&mut rest) {
                    if k == 0 {
                        break;
                    }
                    size_a += k as u64;
                }
            } else if nb > na {
                while let Ok(k) = b.read(&mut rest) {
                    if k == 0 {
                        break;
                    }
                    size_b += k as u64;
                }
            }
            break;
        }
    }
    let common_len = size_a.min(size_b);
    let tail = size_a.max(size_b) - common_len;
    match open.take() {
        // 差異一路延續到共同長度結尾，又有尾巴：合成一段。
        Some(s) => close(s, common_len + tail, &mut ranges, &mut truncated),
        None if tail > 0 => close(common_len, common_len + tail, &mut ranges, &mut truncated),
        None => {}
    }
    diff_bytes += tail;
    Ok(BinDiff { size_a, size_b, ranges, diff_bytes, truncated })
}

pub fn diff_files(a: &Path, b: &Path, cancel: &AtomicBool) -> AppResult<BinDiff> {
    let open = |p: &Path| {
        std::fs::File::open(p).map_err(|e| AppError::Compare(tf!("{path}：{e}", path = p.display(), e = e)))
    };
    diff_readers(std::io::BufReader::new(open(a)?), std::io::BufReader::new(open(b)?), MAX_RANGES, cancel)
}

/// 兩個檔內容是否完全相同（資料夾比對的「比對內容」）。大小不同直接回 false，不讀檔。
pub fn files_equal(a: &Path, b: &Path, cancel: &AtomicBool) -> AppResult<bool> {
    let la = std::fs::metadata(a).map_err(|e| AppError::Compare(e.to_string()))?.len();
    let lb = std::fs::metadata(b).map_err(|e| AppError::Compare(e.to_string()))?.len();
    if la != lb {
        return Ok(false);
    }
    let d = diff_readers(
        std::io::BufReader::new(std::fs::File::open(a).map_err(|e| AppError::Compare(e.to_string()))?),
        std::io::BufReader::new(std::fs::File::open(b).map_err(|e| AppError::Compare(e.to_string()))?),
        1,
        cancel,
    )?;
    Ok(d.diff_bytes == 0)
}

/// 讀一段位元組（十六進位視圖分頁用）。讀到檔尾就回比較短的內容。
pub fn read_bytes(path: &Path, offset: u64, len: u64) -> AppResult<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let len = len.min(READ_MAX) as usize;
    let mut f = std::fs::File::open(path).map_err(|e| AppError::Compare(tf!("{path}：{e}", path = path.display(), e = e)))?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| AppError::Compare(e.to_string()))?;
    let mut buf = vec![0u8; len];
    let n = read_full(&mut f, &mut buf).map_err(|e| AppError::Compare(e.to_string()))?;
    buf.truncate(n);
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn run(a: &[u8], b: &[u8]) -> BinDiff {
        diff_readers(Cursor::new(a.to_vec()), Cursor::new(b.to_vec()), MAX_RANGES, &AtomicBool::new(false)).unwrap()
    }

    #[test]
    fn identical() {
        let d = run(b"hello", b"hello");
        assert_eq!(d, BinDiff { size_a: 5, size_b: 5, ranges: vec![], diff_bytes: 0, truncated: false });
    }

    #[test]
    fn ranges_and_tail() {
        let d = run(b"abcdefgh", b"aXXdeYgh");
        assert_eq!(d.ranges, vec![[1, 2], [5, 1]]);
        assert_eq!(d.diff_bytes, 3);
        let d = run(b"abc", b"abcdef");
        assert_eq!(d.ranges, vec![[3, 3]]);
        assert_eq!((d.size_a, d.size_b, d.diff_bytes), (3, 6, 3));
        // 差異延續到共同結尾又有尾巴 → 合成一段
        let d = run(b"abZ", b"abcdef");
        assert_eq!(d.ranges, vec![[2, 4]]);
        assert_eq!(d.diff_bytes, 4);
    }

    #[test]
    fn spans_chunks_and_caps_ranges() {
        let mut a = vec![0u8; CHUNK * 2 + 10];
        let mut b = a.clone();
        for i in CHUNK - 2..CHUNK + 2 {
            b[i] = 1;
        }
        a[CHUNK * 2 + 5] = 9;
        let d = run(&a, &b);
        assert_eq!(d.ranges, vec![[(CHUNK - 2) as u64, 4], [(CHUNK * 2 + 5) as u64, 1]]);
        let many_a = vec![0u8; 100];
        let many_b: Vec<u8> = (0..100).map(|i| if i % 2 == 0 { 1 } else { 0 }).collect();
        let d = diff_readers(Cursor::new(many_a), Cursor::new(many_b), 10, &AtomicBool::new(false)).unwrap();
        assert_eq!(d.ranges.len(), 10);
        assert!(d.truncated);
        assert_eq!(d.diff_bytes, 50);
    }

    #[test]
    fn files_equal_and_read_bytes() {
        let dir = std::env::temp_dir().join(format!("dbk-bin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b, c) = (dir.join("a"), dir.join("b"), dir.join("c"));
        std::fs::write(&a, b"0123456789").unwrap();
        std::fs::write(&b, b"0123456789").unwrap();
        std::fs::write(&c, b"0123456780").unwrap();
        let no = AtomicBool::new(false);
        assert!(files_equal(&a, &b, &no).unwrap());
        assert!(!files_equal(&a, &c, &no).unwrap());
        assert_eq!(read_bytes(&a, 8, 100).unwrap(), b"89");
        assert_eq!(read_bytes(&a, 20, 4).unwrap(), b"");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
