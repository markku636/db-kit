//! 前端輸入紀錄 → IronRDP 的 fast-path 事件。
//!
//! 線路格式（前端 `src/rdInput.ts` 產生）：每筆 8 bytes，little-endian `[u8 op][u8 flags][u16 a][u16 b][u16 c]`。
//! 用固定長度的二進位而不是 JSON：滑鼠移動一秒上百筆，JSON + serde 的成本比事件本身還高。
//!
//! | op | 意義 | 欄位 |
//! |---|---|---|
//! | 1 / 2 | 按鍵按下 / 放開 | a = scancode（擴充鍵 OR 0xE000；0xE11D = Pause） |
//! | 3 | 滑鼠移動 | a = x, b = y（遠端像素） |
//! | 4 / 5 | 滑鼠鍵按下 / 放開 | a = 0 左 1 中 2 右 3 X1 4 X2, b = x, c = y |
//! | 6 | 滾輪 | flags bit0 = 水平；a = i16（每格 120）, b = x, c = y |
//! | 7 / 8 | Unicode 字元按下 / 放開 | a = UTF-16 code unit |
//! | 9 | 全部放開（失焦時） | — |
//! | 10 | 同步鎖定鍵 | flags：1 Scroll、2 Num、4 Caps、8 Kana |
//!
//! 按鍵狀態交給 `ironrdp_input::Database`：它記得哪些鍵 / 鈕按著，`release_all` 才放得乾淨，
//! 重複的按下 / 放開也會被它去重。

use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use smallvec::SmallVec;

pub const OP_KEY_DOWN: u8 = 1;
pub const OP_KEY_UP: u8 = 2;
pub const OP_MOVE: u8 = 3;
pub const OP_BUTTON_DOWN: u8 = 4;
pub const OP_BUTTON_UP: u8 = 5;
pub const OP_WHEEL: u8 = 6;
pub const OP_UNICODE_DOWN: u8 = 7;
pub const OP_UNICODE_UP: u8 = 8;
pub const OP_RELEASE_ALL: u8 = 9;
pub const OP_SYNC_LOCKS: u8 = 10;

pub const RECORD_LEN: usize = 8;

/// Pause/Break 的前端代碼：它是 E1 前綴的特殊序列，`Scancode` 表示不了。
pub const SCANCODE_PAUSE: u16 = 0xE11D;

pub type Events = SmallVec<[FastPathInputEvent; 2]>;

/// 輸入狀態機：一條 RDP 連線一個。
pub struct InputState {
    db: Database,
    view_only: bool,
}

impl InputState {
    pub fn new(view_only: bool) -> Self {
        Self { db: Database::new(), view_only }
    }

    /// 解一批紀錄。格式不對的尾巴直接丟掉（前端 bug 不該讓連線斷掉）。
    pub fn apply(&mut self, bytes: &[u8]) -> Events {
        let mut out = Events::new();
        if self.view_only {
            return out;
        }
        let mut ops: Vec<Operation> = Vec::new();
        for rec in bytes.chunks_exact(RECORD_LEN) {
            let op = rec[0];
            let flags = rec[1];
            let a = u16::from_le_bytes([rec[2], rec[3]]);
            let b = u16::from_le_bytes([rec[4], rec[5]]);
            let c = u16::from_le_bytes([rec[6], rec[7]]);
            match op {
                OP_KEY_DOWN | OP_KEY_UP if a == SCANCODE_PAUSE => {
                    // 特殊序列要跟前面累積的 op 保持順序。
                    out.extend(self.db.apply(ops.drain(..)));
                    if op == OP_KEY_DOWN {
                        out.extend(pause_sequence());
                    }
                }
                OP_KEY_DOWN => ops.push(Operation::KeyPressed(Scancode::from_u16(a))),
                OP_KEY_UP => ops.push(Operation::KeyReleased(Scancode::from_u16(a))),
                OP_MOVE => ops.push(Operation::MouseMove(MousePosition { x: a, y: b })),
                OP_BUTTON_DOWN | OP_BUTTON_UP => {
                    let Some(btn) = MouseButton::from_idx(usize::from(a)) else { continue };
                    ops.push(Operation::MouseMove(MousePosition { x: b, y: c }));
                    ops.push(if op == OP_BUTTON_DOWN {
                        Operation::MouseButtonPressed(btn)
                    } else {
                        Operation::MouseButtonReleased(btn)
                    });
                }
                OP_WHEEL => {
                    ops.push(Operation::MouseMove(MousePosition { x: b, y: c }));
                    // PDU 的滾動量只有 9 bits（±255）：大的拆成每格 120 送。
                    let mut left = i32::from(a as i16);
                    while left != 0 {
                        let step = left.clamp(-120, 120);
                        ops.push(Operation::WheelRotations(WheelRotations {
                            is_vertical: flags & 1 == 0,
                            rotation_units: step as i16,
                        }));
                        left -= step;
                    }
                }
                OP_UNICODE_DOWN | OP_UNICODE_UP => {
                    // 代理對（emoji）的半邊不是合法 char；RDP 的 Unicode 事件也只收 BMP，略過。
                    let Some(ch) = char::from_u32(u32::from(a)) else { continue };
                    ops.push(if op == OP_UNICODE_DOWN {
                        Operation::UnicodeKeyPressed(ch)
                    } else {
                        Operation::UnicodeKeyReleased(ch)
                    });
                }
                OP_RELEASE_ALL => {
                    out.extend(self.db.apply(ops.drain(..)));
                    out.extend(self.db.release_all());
                }
                OP_SYNC_LOCKS => {
                    out.extend(self.db.apply(ops.drain(..)));
                    out.push(ironrdp::input::synchronize_event(
                        flags & 1 != 0,
                        flags & 2 != 0,
                        flags & 4 != 0,
                        flags & 8 != 0,
                    ));
                }
                _ => {}
            }
        }
        out.extend(self.db.apply(ops));
        out
    }

    /// 工具列的組合鍵（Ctrl+Alt+Del 等 webview 攔不到、或會被本機 OS 吃掉的）。未知名稱回空。
    pub fn combo(&mut self, name: &str) -> Events {
        if self.view_only {
            return Events::new();
        }
        let keys: &[u16] = match name {
            "ctrl_alt_del" => &[0x1D, 0x38, 0xE053],
            "win" => &[0xE05B],
            "alt_tab" => &[0x38, 0x0F],
            "ctrl_esc" => &[0x1D, 0x01],
            "print_screen" => &[0xE037],
            "alt_f4" => &[0x38, 0x3E],
            _ => return Events::new(),
        };
        let mut ops: Vec<Operation> = keys.iter().map(|&k| Operation::KeyPressed(Scancode::from_u16(k))).collect();
        ops.extend(keys.iter().rev().map(|&k| Operation::KeyReleased(Scancode::from_u16(k))));
        self.db.apply(ops)
    }

    /// 失焦 / 斷線前：把按著的鍵鈕都放開，避免遠端卡著 Ctrl。
    pub fn release_all(&mut self) -> Events {
        self.db.release_all()
    }
}

/// Pause：E1 1D 45 E1 9D C5（沒有放開事件）。
fn pause_sequence() -> Events {
    let mut e = Events::new();
    e.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED1, 0x1D));
    e.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x45));
    e.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED1 | KeyboardFlags::RELEASE, 0x1D));
    e.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x45));
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(op: u8, flags: u8, a: u16, b: u16, c: u16) -> Vec<u8> {
        let mut v = vec![op, flags];
        for x in [a, b, c] {
            v.extend_from_slice(&x.to_le_bytes());
        }
        v
    }

    fn kb(e: &FastPathInputEvent) -> Option<(KeyboardFlags, u8)> {
        match e {
            FastPathInputEvent::KeyboardEvent(f, c) => Some((*f, *c)),
            _ => None,
        }
    }

    #[test]
    fn key_down_up_and_extended() {
        let mut s = InputState::new(false);
        let mut b = rec(OP_KEY_DOWN, 0, 0xE01D, 0, 0); // Right Ctrl
        b.extend(rec(OP_KEY_UP, 0, 0xE01D, 0, 0));
        let ev = s.apply(&b);
        let k: Vec<_> = ev.iter().filter_map(kb).collect();
        assert_eq!(k.len(), 2);
        assert!(k[0].0.contains(KeyboardFlags::EXTENDED) && !k[0].0.contains(KeyboardFlags::RELEASE));
        assert_eq!(k[0].1, 0x1D);
        assert!(k[1].0.contains(KeyboardFlags::RELEASE));
    }

    #[test]
    fn release_all_releases_held_keys() {
        let mut s = InputState::new(false);
        s.apply(&rec(OP_KEY_DOWN, 0, 0x1D, 0, 0));
        let ev = s.apply(&rec(OP_RELEASE_ALL, 0, 0, 0, 0));
        let k: Vec<_> = ev.iter().filter_map(kb).collect();
        assert_eq!(k, vec![(KeyboardFlags::RELEASE, 0x1D)]);
        assert!(s.release_all().is_empty(), "沒按著的就沒事件");
    }

    #[test]
    fn mouse_and_wheel_produce_events() {
        let mut s = InputState::new(false);
        let mut b = rec(OP_MOVE, 0, 10, 20, 0);
        b.extend(rec(OP_BUTTON_DOWN, 0, 0, 10, 20));
        b.extend(rec(OP_BUTTON_UP, 0, 0, 10, 20));
        b.extend(rec(OP_WHEEL, 0, (-120i16) as u16, 10, 20));
        b.extend(rec(OP_BUTTON_DOWN, 0, 99, 0, 0)); // 不存在的鈕：略過
        let ev = s.apply(&b);
        assert!(ev.iter().all(|e| matches!(e, FastPathInputEvent::MouseEvent(_) | FastPathInputEvent::MouseEventEx(_))));
        assert!(ev.len() >= 3, "{ev:?}");
        // 大滾動量拆成 ±120 一步
        let wheels = |ev: &Events| {
            ev.iter()
                .filter(|e| matches!(e, FastPathInputEvent::MouseEvent(m) if m.number_of_wheel_rotation_units != 0))
                .count()
        };
        assert_eq!(wheels(&s.apply(&rec(OP_WHEEL, 0, 360, 10, 20))), 3);
    }

    #[test]
    fn view_only_drops_everything() {
        let mut s = InputState::new(true);
        assert!(s.apply(&rec(OP_KEY_DOWN, 0, 0x1E, 0, 0)).is_empty());
        assert!(s.combo("ctrl_alt_del").is_empty());
    }

    #[test]
    fn combos_press_then_release_in_reverse() {
        let mut s = InputState::new(false);
        let k: Vec<_> = s.combo("ctrl_alt_del").iter().filter_map(kb).collect();
        assert_eq!(k.len(), 6);
        assert_eq!(k[2].1, 0x53);
        assert!(k[2].0.contains(KeyboardFlags::EXTENDED));
        assert_eq!(k[3].1, 0x53, "先放 Del");
        assert!(k[3].0.contains(KeyboardFlags::RELEASE));
        assert!(s.combo("nope").is_empty());
    }

    #[test]
    fn pause_and_sync_and_truncated_tail() {
        let mut s = InputState::new(false);
        let mut b = rec(OP_KEY_DOWN, 0, SCANCODE_PAUSE, 0, 0);
        b.extend(rec(OP_SYNC_LOCKS, 4, 0, 0, 0));
        b.extend([1, 2, 3]); // 不完整的尾巴
        let ev = s.apply(&b);
        assert_eq!(ev.len(), 5, "{ev:?}");
        assert!(matches!(ev[0], FastPathInputEvent::KeyboardEvent(f, 0x1D) if f.contains(KeyboardFlags::EXTENDED1)));
        assert!(matches!(ev[4], FastPathInputEvent::SyncEvent(_)));
    }

    #[test]
    fn unicode_bmp_only() {
        let mut s = InputState::new(false);
        let mut b = rec(OP_UNICODE_DOWN, 0, '中' as u16, 0, 0);
        b.extend(rec(OP_UNICODE_UP, 0, '中' as u16, 0, 0));
        b.extend(rec(OP_UNICODE_DOWN, 0, 0xD83D, 0, 0)); // 代理對半邊：略過
        let ev = s.apply(&b);
        assert_eq!(ev.len(), 2);
        assert!(ev.iter().all(|e| matches!(e, FastPathInputEvent::UnicodeKeyboardEvent(..))));
    }
}
