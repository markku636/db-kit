//! RDP 畫面 → 前端：差異區塊（dirty rect）的合併、節流與打包。純邏輯，不碰網路。
//!
//! 為什麼不像參考客戶端那樣每次更新都送整張：1080p 一張 RGBA 是 8 MB，打字時每秒幾十次更新
//! 只動到游標附近幾百像素。這裡把 IronRDP 回報的更新區塊累積成一組矩形，**送出當下**才從 DecodedImage
//! 讀像素（所以永遠是最新的，送晚不會送到舊畫面），並用前端 ack 做反壓：最多 `MAX_IN_FLIGHT` 張沒畫完，
//! 前端忙不過來時新的更新只會被併進待送區塊，不會在 IPC 裡排隊。
//!
//! 線路格式（little-endian；一則 Channel 訊息可含多筆 record），每筆 16 bytes 標頭：
//! `[u8 type][u8 flags][u16 rsv][u16 a][u16 b][u16 c][u16 d][u32 seq]`，之後是 type 專屬的 payload：
//!
//! | type | 意義 | a / b / c / d | payload |
//! |---|---|---|---|
//! | 1 RECT | 一塊像素 | x / y / w / h | w×h×4 RGBA |
//! | 2 RESIZE | 桌面尺寸改變 | w / h | — |
//! | 3 POINTER_BITMAP | 游標圖 | w / h / hotX / hotY | w×h×4 RGBA（非預乘） |
//! | 4 POINTER_POS | 伺服器移動游標 | x / y | — |
//! | 5 POINTER_SYSTEM | flags 0 = 隱藏、1 = 預設箭頭 | — | — |
//! | 6 FRAME_END | 這一批畫完請 ack `seq` | — | — |
//! | 7 CLIPBOARD | 遠端複製了文字 | 長度低 16 / 高 16 bits | UTF-8 |
//!
//! 前端解析在 `src/rdFrames.ts`，兩邊的格式必須一起改。

use std::time::{Duration, Instant};

pub const REC_RECT: u8 = 1;
pub const REC_RESIZE: u8 = 2;
pub const REC_POINTER_BITMAP: u8 = 3;
pub const REC_POINTER_POS: u8 = 4;
pub const REC_POINTER_SYSTEM: u8 = 5;
pub const REC_FRAME_END: u8 = 6;
/// 遠端剪貼簿的文字：a = 長度低 16 bits、b = 高 16 bits，payload 是 UTF-8。
pub const REC_CLIPBOARD: u8 = 7;

pub const HEADER_LEN: usize = 16;

/// 最多幾張還沒被 ack（2 = 前端畫這張時，下一張已經在路上）。
pub const MAX_IN_FLIGHT: usize = 2;
/// 兩次送出的最小間隔（≈ 60 fps）。
pub const MIN_INTERVAL: Duration = Duration::from_millis(16);
/// ack 超過這麼久沒回就當它丟了（視窗最小化時 rAF 停擺、前端重建 canvas…），別讓畫面永遠卡住。
pub const ACK_TIMEOUT: Duration = Duration::from_secs(2);
/// 矩形數超過就改送外框。
const MAX_RECTS: usize = 32;
/// 矩形總面積超過外框的這個比例就直接送外框（一塊大的比很多碎塊便宜）。
const BBOX_RATIO: f64 = 0.6;

/// 半開區間矩形 `[x, x+w) × [y, y+h)`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

impl Rect {
    pub fn new(x: u16, y: u16, w: u16, h: u16) -> Self {
        Self { x, y, w, h }
    }

    /// IronRDP 的 `InclusiveRectangle`（right / bottom 含端點）。
    pub fn from_inclusive(left: u16, top: u16, right: u16, bottom: u16) -> Self {
        let w = right.saturating_sub(left).saturating_add(1);
        let h = bottom.saturating_sub(top).saturating_add(1);
        Self { x: left, y: top, w, h }
    }

    fn right(&self) -> u32 {
        u32::from(self.x) + u32::from(self.w)
    }
    fn bottom(&self) -> u32 {
        u32::from(self.y) + u32::from(self.h)
    }
    fn area(&self) -> u64 {
        u64::from(self.w) * u64::from(self.h)
    }
    fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    /// 相交或相鄰（邊貼邊也算：合起來不會多送沒變的像素）。
    fn touches(&self, o: &Rect) -> bool {
        u32::from(self.x) <= o.right()
            && u32::from(o.x) <= self.right()
            && u32::from(self.y) <= o.bottom()
            && u32::from(o.y) <= self.bottom()
    }

    fn contains(&self, o: &Rect) -> bool {
        self.x <= o.x && self.y <= o.y && self.right() >= o.right() && self.bottom() >= o.bottom()
    }

    fn union(&self, o: &Rect) -> Rect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        let r = self.right().max(o.right());
        let b = self.bottom().max(o.bottom());
        Rect { x, y, w: (r - u32::from(x)) as u16, h: (b - u32::from(y)) as u16 }
    }

    /// 裁到畫面內；完全在外面回 None。
    fn clip(&self, width: u16, height: u16) -> Option<Rect> {
        if self.x >= width || self.y >= height {
            return None;
        }
        let r = self.right().min(u32::from(width));
        let b = self.bottom().min(u32::from(height));
        let c = Rect { x: self.x, y: self.y, w: (r - u32::from(self.x)) as u16, h: (b - u32::from(self.y)) as u16 };
        (!c.is_empty()).then_some(c)
    }
}

/// 待送的差異區塊。
#[derive(Debug, Default)]
pub struct DirtyRegion {
    rects: Vec<Rect>,
}

impl DirtyRegion {
    pub fn is_empty(&self) -> bool {
        self.rects.is_empty()
    }

    #[cfg(test)]
    pub fn rects(&self) -> &[Rect] {
        &self.rects
    }

    /// 整張都要重送（剛連上、resize 後、前端要求 refresh）。
    pub fn mark_full(&mut self, width: u16, height: u16) {
        self.rects.clear();
        if width > 0 && height > 0 {
            self.rects.push(Rect::new(0, 0, width, height));
        }
    }

    /// 加一塊：裁邊 → 與相交 / 相鄰的反覆合併 → 太碎或太滿就收成外框。
    pub fn add(&mut self, r: Rect, width: u16, height: u16) {
        let Some(mut r) = r.clip(width, height) else { return };
        if self.rects.iter().any(|x| x.contains(&r)) {
            return;
        }
        // 合併後的矩形可能又碰到先前不相鄰的，所以要一直併到穩定。
        loop {
            match self.rects.iter().position(|x| x.touches(&r)) {
                Some(i) => r = r.union(&self.rects.swap_remove(i)),
                None => break,
            }
        }
        self.rects.push(r);
        if self.rects.len() > MAX_RECTS {
            self.collapse();
        } else if self.rects.len() > 1 {
            let bbox = self.bbox();
            let sum: u64 = self.rects.iter().map(Rect::area).sum();
            if sum as f64 > bbox.area() as f64 * BBOX_RATIO {
                self.collapse();
            }
        }
    }

    fn bbox(&self) -> Rect {
        let mut it = self.rects.iter();
        let first = *it.next().expect("non-empty");
        it.fold(first, |a, r| a.union(r))
    }

    fn collapse(&mut self) {
        if !self.rects.is_empty() {
            let b = self.bbox();
            self.rects.clear();
            self.rects.push(b);
        }
    }

    pub fn take(&mut self) -> Vec<Rect> {
        std::mem::take(&mut self.rects)
    }
}

/// 送出節流 + ack 反壓。
#[derive(Debug)]
pub struct FramePacer {
    next_seq: u32,
    /// (seq, 送出時間)。
    in_flight: Vec<(u32, Instant)>,
    last_flush: Option<Instant>,
}

impl Default for FramePacer {
    fn default() -> Self {
        Self::new()
    }
}

impl FramePacer {
    pub fn new() -> Self {
        Self { next_seq: 1, in_flight: Vec::new(), last_flush: None }
    }

    fn expire(&mut self, now: Instant) {
        self.in_flight.retain(|(_, t)| now.duration_since(*t) < ACK_TIMEOUT);
    }

    /// 現在能不能送；不能的話回「最早什麼時候再試」（None = 等 ack）。
    pub fn ready(&mut self, now: Instant) -> Result<(), Option<Instant>> {
        self.expire(now);
        if self.in_flight.len() >= MAX_IN_FLIGHT {
            // 等 ack；但最久等到最舊那張逾時。
            let oldest = self.in_flight.iter().map(|(_, t)| *t).min().expect("non-empty");
            return Err(Some(oldest + ACK_TIMEOUT));
        }
        match self.last_flush {
            Some(t) if now.duration_since(t) < MIN_INTERVAL => Err(Some(t + MIN_INTERVAL)),
            _ => Ok(()),
        }
    }

    /// 記一次送出，回這批的 seq。
    pub fn flushed(&mut self, now: Instant) -> u32 {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1).max(1);
        self.in_flight.push((seq, now));
        self.last_flush = Some(now);
        seq
    }

    /// 前端畫完 `seq`：它和更早的都算完成（ack 可能合併、也可能亂序到）。
    pub fn acked(&mut self, seq: u32) {
        self.in_flight.retain(|(s, _)| s.wrapping_sub(seq) as i32 > 0);
    }

    #[cfg(test)]
    pub fn in_flight(&self) -> usize {
        self.in_flight.len()
    }

    /// resize / 重連：舊的 ack 都不重要了。
    pub fn reset(&mut self) {
        self.in_flight.clear();
        self.last_flush = None;
    }
}

fn header(buf: &mut Vec<u8>, ty: u8, flags: u8, a: u16, b: u16, c: u16, d: u16, seq: u32) {
    buf.push(ty);
    buf.push(flags);
    buf.extend_from_slice(&0u16.to_le_bytes());
    for v in [a, b, c, d] {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    buf.extend_from_slice(&seq.to_le_bytes());
}

/// 把 `rects` 的目前像素打成一則訊息（每塊一筆 RECT + 最後一筆 FRAME_END）。
///
/// `data` 是整張 RGBA32 畫面（`stride` = 每列 bytes）。alpha 一律補 0xFF：DecodedImage 剛配置時是 0，
/// 伺服器沒畫過的區域若照抄，canvas 上會是透明的。
pub fn encode_frame(data: &[u8], stride: usize, width: u16, height: u16, rects: &[Rect], seq: u32) -> Vec<u8> {
    let total: usize = rects.iter().map(|r| HEADER_LEN + r.area() as usize * 4).sum::<usize>() + HEADER_LEN;
    let mut buf = Vec::with_capacity(total);
    for r in rects {
        let Some(r) = r.clip(width, height) else { continue };
        header(&mut buf, REC_RECT, 0, r.x, r.y, r.w, r.h, seq);
        let row = usize::from(r.w) * 4;
        for y in r.y..r.y + r.h {
            let start = usize::from(y) * stride + usize::from(r.x) * 4;
            let Some(src) = data.get(start..start + row) else { break };
            let at = buf.len();
            buf.extend_from_slice(src);
            for a in buf[at + 3..].iter_mut().step_by(4) {
                *a = 0xFF;
            }
        }
    }
    header(&mut buf, REC_FRAME_END, 0, 0, 0, 0, 0, seq);
    buf
}

pub fn encode_resize(width: u16, height: u16) -> Vec<u8> {
    let mut buf = Vec::with_capacity(HEADER_LEN);
    header(&mut buf, REC_RESIZE, 0, width, height, 0, 0, 0);
    buf
}

pub fn encode_pointer_bitmap(w: u16, h: u16, hot_x: u16, hot_y: u16, rgba: &[u8]) -> Vec<u8> {
    let n = usize::from(w) * usize::from(h) * 4;
    let mut buf = Vec::with_capacity(HEADER_LEN + n);
    header(&mut buf, REC_POINTER_BITMAP, 0, w, h, hot_x, hot_y, 0);
    let mut px = rgba.get(..n).unwrap_or(rgba).to_vec();
    px.resize(n, 0);
    buf.extend_from_slice(&px);
    buf
}

pub fn encode_pointer_pos(x: u16, y: u16) -> Vec<u8> {
    let mut buf = Vec::with_capacity(HEADER_LEN);
    header(&mut buf, REC_POINTER_POS, 0, x, y, 0, 0, 0);
    buf
}

/// `visible == false` → 隱藏；true → 系統預設箭頭。
pub fn encode_pointer_system(visible: bool) -> Vec<u8> {
    let mut buf = Vec::with_capacity(HEADER_LEN);
    header(&mut buf, REC_POINTER_SYSTEM, u8::from(visible), 0, 0, 0, 0, 0);
    buf
}

/// 遠端剪貼簿文字（UTF-8）。
pub fn encode_clipboard(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let len = bytes.len() as u32;
    let mut buf = Vec::with_capacity(HEADER_LEN + bytes.len());
    header(&mut buf, REC_CLIPBOARD, 0, (len & 0xFFFF) as u16, (len >> 16) as u16, 0, 0, 0);
    buf.extend_from_slice(bytes);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u16 = 1000;
    const H: u16 = 800;

    #[test]
    fn inclusive_conversion() {
        assert_eq!(Rect::from_inclusive(10, 20, 19, 29), Rect::new(10, 20, 10, 10));
        assert_eq!(Rect::from_inclusive(5, 5, 5, 5), Rect::new(5, 5, 1, 1));
    }

    #[test]
    fn disjoint_rects_stay_separate_touching_ones_merge() {
        let mut d = DirtyRegion::default();
        d.add(Rect::new(0, 0, 10, 10), W, H);
        d.add(Rect::new(500, 500, 10, 10), W, H);
        assert_eq!(d.rects().len(), 2);
        // 貼著第一塊的右邊 → 併成 20×10
        d.add(Rect::new(10, 0, 10, 10), W, H);
        assert_eq!(d.rects().len(), 2);
        assert!(d.rects().contains(&Rect::new(0, 0, 20, 10)));
        // 已被包含 → 不變
        d.add(Rect::new(2, 2, 3, 3), W, H);
        assert_eq!(d.rects().len(), 2);
    }

    #[test]
    fn chain_merge_until_stable() {
        let mut d = DirtyRegion::default();
        d.add(Rect::new(0, 0, 10, 10), W, H);
        d.add(Rect::new(40, 0, 10, 10), W, H);
        // 橫跨兩塊中間：三塊要併成一塊
        d.add(Rect::new(9, 0, 32, 10), W, H);
        assert_eq!(d.rects(), &[Rect::new(0, 0, 50, 10)]);
    }

    #[test]
    fn clip_and_ignore_outside() {
        let mut d = DirtyRegion::default();
        d.add(Rect::new(990, 790, 50, 50), W, H);
        assert_eq!(d.rects(), &[Rect::new(990, 790, 10, 10)]);
        d.add(Rect::new(2000, 10, 5, 5), W, H);
        assert_eq!(d.rects().len(), 1);
    }

    #[test]
    fn too_many_rects_collapse_to_bbox() {
        let mut d = DirtyRegion::default();
        for i in 0..40u16 {
            d.add(Rect::new(i * 20, 0, 5, 5), W, H);
        }
        assert_eq!(d.rects().len(), 1);
        assert_eq!(d.rects()[0], Rect::new(0, 0, 39 * 20 + 5, 5));
    }

    #[test]
    fn dense_rects_collapse_to_bbox() {
        let mut d = DirtyRegion::default();
        d.add(Rect::new(0, 0, 100, 100), W, H);
        d.add(Rect::new(102, 0, 100, 100), W, H); // 不相鄰（差 2px），但幾乎填滿外框
        assert_eq!(d.rects(), &[Rect::new(0, 0, 202, 100)]);
    }

    #[test]
    fn pacer_interval_and_backpressure() {
        let t0 = Instant::now();
        let mut p = FramePacer::new();
        assert!(p.ready(t0).is_ok());
        let s1 = p.flushed(t0);
        // 間隔不足
        assert_eq!(p.ready(t0 + Duration::from_millis(5)), Err(Some(t0 + MIN_INTERVAL)));
        let t1 = t0 + Duration::from_millis(20);
        assert!(p.ready(t1).is_ok());
        let s2 = p.flushed(t1);
        assert_eq!(s2, s1 + 1);
        // 兩張在路上 → 等 ack（最久到最舊那張逾時）
        let t2 = t1 + Duration::from_millis(20);
        assert_eq!(p.ready(t2), Err(Some(t0 + ACK_TIMEOUT)));
        p.acked(s1);
        assert_eq!(p.in_flight(), 1);
        assert!(p.ready(t2).is_ok());
        // ack 較新的 seq → 更早的一併完成
        let s3 = p.flushed(t2);
        p.acked(s3);
        assert_eq!(p.in_flight(), 0);
        let _ = s2;
    }

    #[test]
    fn pacer_ack_timeout_unblocks() {
        let t0 = Instant::now();
        let mut p = FramePacer::new();
        p.flushed(t0);
        p.flushed(t0 + MIN_INTERVAL);
        assert!(p.ready(t0 + Duration::from_millis(100)).is_err());
        assert!(p.ready(t0 + ACK_TIMEOUT + MIN_INTERVAL).is_ok(), "逾時的 ack 不再擋");
    }

    #[test]
    fn encode_frame_layout_and_alpha() {
        // 4×2 畫面，每像素 [x, y, 7, 0]
        let (w, h) = (4u16, 2u16);
        let stride = usize::from(w) * 4;
        let mut data = vec![0u8; stride * usize::from(h)];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let i = y * stride + x * 4;
                data[i] = x as u8;
                data[i + 1] = y as u8;
                data[i + 2] = 7;
            }
        }
        let buf = encode_frame(&data, stride, w, h, &[Rect::new(1, 0, 2, 2)], 9);
        assert_eq!(buf.len(), HEADER_LEN + 2 * 2 * 4 + HEADER_LEN);
        assert_eq!(buf[0], REC_RECT);
        assert_eq!(u16::from_le_bytes([buf[4], buf[5]]), 1, "x");
        assert_eq!(u16::from_le_bytes([buf[8], buf[9]]), 2, "w");
        assert_eq!(u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]), 9, "seq");
        let px = &buf[HEADER_LEN..HEADER_LEN + 16];
        assert_eq!(px, &[1, 0, 7, 255, 2, 0, 7, 255, 1, 1, 7, 255, 2, 1, 7, 255]);
        let end = &buf[HEADER_LEN + 16..];
        assert_eq!(end[0], REC_FRAME_END);
        assert_eq!(u32::from_le_bytes([end[12], end[13], end[14], end[15]]), 9);
    }

    #[test]
    fn small_records() {
        let r = encode_resize(1920, 1080);
        assert_eq!((r[0], u16::from_le_bytes([r[4], r[5]]), u16::from_le_bytes([r[6], r[7]])), (REC_RESIZE, 1920, 1080));
        let p = encode_pointer_bitmap(2, 1, 1, 0, &[1, 2, 3]);
        assert_eq!(p.len(), HEADER_LEN + 8, "不足的像素補 0");
        assert_eq!(encode_pointer_system(true)[1], 1);
        assert_eq!(encode_pointer_pos(3, 4)[4], 3);
        let c = encode_clipboard("hi");
        assert_eq!((c[0], c[4], c.len()), (REC_CLIPBOARD, 2, HEADER_LEN + 2));
    }
}
