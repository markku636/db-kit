// 鍵盤：db-kit 送來的是 PC 掃描碼（Windows 的 position code），對方卻是用「它自己系統的鍵碼」解讀
// `KeyEvent.chr`（官方伺服端 `keycode_to_rdev_key`）。所以跟官方 Windows 用戶端一樣，依對方的系統換算
// （`src/keyboard.rs` 的 `_map_keyboard_mode`：Windows 原樣、macOS / Android / 其他（Linux）各查一張表）。
//
// 另外每個按鍵要帶本機鎖定鍵的狀態（官方 `add_lock_modes_modifiers`）：對方會先把自己的 CapsLock / NumLock
// 切成跟這端一樣再按（伺服端 `LockModesHandler`）。不帶 = 對方當成都沒開——數字鍵盤打出來變成方向鍵 / End，
// 開著 CapsLock 打的字變小寫，登入畫面的密碼 / PIN 就會錯。
//
// 對照表由 rustdesk-org/rdev 的 `src/keycodes/{windows,linux,macos,android}.rs` 產生（MIT），規則同
// `src/codes_conv.rs` 的 `conv_keycodes!`：掃描碼 → rdev Key（同一個掃描碼取表上第一個）→ 對方的鍵碼；
// macOS 的 NonConvert / Convert 對到 JIS 的英數 / かな。
//
// SPDX-License-Identifier: AGPL-3.0-only

/// (Windows 掃描碼, Linux（X11 keycode = evdev + 8）, macOS 虛擬鍵碼, Android 鍵碼)；-1 = 對方系統沒有這顆。
#[rustfmt::skip]
const KEYMAP: &[(u32, i32, i32, i32)] = &[
    (0x01, 9, 0x35, 111), // Escape
    (0x02, 10, 0x12, 8), // Num1
    (0x03, 11, 0x13, 9), // Num2
    (0x04, 12, 0x14, 10), // Num3
    (0x05, 13, 0x15, 11), // Num4
    (0x06, 14, 0x17, 12), // Num5
    (0x07, 15, 0x16, 13), // Num6
    (0x08, 16, 0x1A, 14), // Num7
    (0x09, 17, 0x1C, 15), // Num8
    (0x0A, 18, 0x19, 16), // Num9
    (0x0B, 19, 0x1D, 7), // Num0
    (0x0C, 20, 0x1B, 69), // Minus
    (0x0D, 21, 0x18, 70), // Equal
    (0x0E, 22, 0x33, 67), // Backspace
    (0x0F, 23, 0x30, 61), // Tab
    (0x10, 24, 0x0C, 45), // KeyQ
    (0x11, 25, 0x0D, 51), // KeyW
    (0x12, 26, 0x0E, 33), // KeyE
    (0x13, 27, 0x0F, 46), // KeyR
    (0x14, 28, 0x11, 48), // KeyT
    (0x15, 29, 0x10, 53), // KeyY
    (0x16, 30, 0x20, 49), // KeyU
    (0x17, 31, 0x22, 37), // KeyI
    (0x18, 32, 0x1F, 43), // KeyO
    (0x19, 33, 0x23, 44), // KeyP
    (0x1A, 34, 0x21, 71), // LeftBracket
    (0x1B, 35, 0x1E, 72), // RightBracket
    (0x1C, 36, 0x24, 66), // Return
    (0x1D, 37, 0x3B, 113), // ControlLeft
    (0x1E, 38, 0x00, 29), // KeyA
    (0x1F, 39, 0x01, 47), // KeyS
    (0x20, 40, 0x02, 32), // KeyD
    (0x21, 41, 0x03, 34), // KeyF
    (0x22, 42, 0x05, 35), // KeyG
    (0x23, 43, 0x04, 36), // KeyH
    (0x24, 44, 0x26, 38), // KeyJ
    (0x25, 45, 0x28, 39), // KeyK
    (0x26, 46, 0x25, 40), // KeyL
    (0x27, 47, 0x29, 74), // SemiColon
    (0x28, 48, 0x27, 75), // Quote
    (0x29, 49, 0x32, 75), // BackQuote
    (0x2A, 50, 0x38, 59), // ShiftLeft
    (0x2B, 51, 0x2A, 73), // BackSlash
    (0x2C, 52, 0x06, 54), // KeyZ
    (0x2D, 53, 0x07, 52), // KeyX
    (0x2E, 54, 0x08, 31), // KeyC
    (0x2F, 55, 0x09, 50), // KeyV
    (0x30, 56, 0x0B, 30), // KeyB
    (0x31, 57, 0x2D, 42), // KeyN
    (0x32, 58, 0x2E, 41), // KeyM
    (0x33, 59, 0x2B, 55), // Comma
    (0x34, 60, 0x2F, 56), // Dot
    (0x35, 61, 0x2C, 76), // Slash
    (0x36, 62, 0x3C, 60), // ShiftRight
    (0x37, 63, 0x43, -1), // KpMultiply
    (0x38, 64, 0x3A, 57), // Alt
    (0x39, 65, 0x31, 62), // Space
    (0x3A, 66, 0x39, 115), // CapsLock
    (0x3B, 67, 0x7A, 131), // F1
    (0x3C, 68, 0x78, 132), // F2
    (0x3D, 69, 0x63, 133), // F3
    (0x3E, 70, 0x76, 134), // F4
    (0x3F, 71, 0x60, 135), // F5
    (0x40, 72, 0x61, 136), // F6
    (0x41, 73, 0x62, 137), // F7
    (0x42, 74, 0x64, 138), // F8
    (0x43, 75, 0x65, 139), // F9
    (0x44, 76, 0x6D, 140), // F10
    (0x45, 77, 0x47, 143), // NumLock
    (0x46, 78, -1, 116), // ScrollLock
    (0x47, 79, 0x59, -1), // Kp7
    (0x48, 80, 0x5B, -1), // Kp8
    (0x49, 81, 0x5C, -1), // Kp9
    (0x4A, 82, 0x4E, -1), // KpMinus
    (0x4B, 83, 0x56, -1), // Kp4
    (0x4C, 84, 0x57, -1), // Kp5
    (0x4D, 85, 0x58, -1), // Kp6
    (0x4E, 86, 0x45, -1), // KpPlus
    (0x4F, 87, 0x53, -1), // Kp1
    (0x50, 88, 0x54, -1), // Kp2
    (0x51, 89, 0x55, -1), // Kp3
    (0x52, 90, 0x52, -1), // Kp0
    (0x53, 91, 0x41, -1), // KpDecimal
    (0x56, 94, 0x0A, -1), // IntlBackslash
    (0x57, 95, 0x67, 141), // F11
    (0x58, 96, 0x6F, 142), // F12
    (0x59, 125, 0x51, -1), // KpEqual
    (0x64, 191, 0x69, -1), // F13
    (0x65, 192, 0x6B, -1), // F14
    (0x66, 193, 0x71, -1), // F15
    (0x67, 194, 0x6A, -1), // F16
    (0x68, 195, 0x40, -1), // F17
    (0x69, 196, 0x4F, -1), // F18
    (0x6A, 197, 0x50, -1), // F19
    (0x6B, 198, 0x5A, -1), // F20
    (0x6C, 199, -1, -1), // F21
    (0x6D, 200, -1, -1), // F22
    (0x6E, 201, -1, -1), // F23
    (0x70, 101, -1, 218), // KanaMode
    (0x73, 97, 0x5E, -1), // IntlRo
    (0x76, 202, -1, -1), // F24
    (0x77, 99, -1, -1), // Lang4
    (0x78, 98, -1, -1), // Lang3
    (0x79, 100, 0x68, -1), // Convert
    (0x7B, 102, 0x66, -1), // NonConvert
    (0x7D, 132, 0x5D, -1), // IntlYen
    (0x7E, 129, 0x5F, -1), // KpComma
    (0x80, -1, -1, -1), // Kana
    (0xF1, 131, -1, -1), // Hanja
    (0xF2, 130, -1, -1), // Hangul
    (0xE01C, 104, 0x4C, -1), // KpReturn
    (0xE01D, 105, 0x3E, 114), // ControlRight
    (0xE020, 121, 0x4A, -1), // VolumeMute
    (0xE02E, 122, 0x49, -1), // VolumeDown
    (0xE030, 123, 0x48, -1), // VolumeUp
    (0xE035, 106, 0x4B, -1), // KpDivide
    (0xE037, 107, -1, 120), // PrintScreen
    (0xE038, 108, 0x3D, 58), // AltGr
    (0xE047, 110, 0x73, 3), // Home
    (0xE048, 111, 0x7E, 19), // UpArrow
    (0xE049, 112, 0x74, 92), // PageUp
    (0xE04B, 113, 0x7B, 21), // LeftArrow
    (0xE04D, 114, 0x7C, 22), // RightArrow
    (0xE04F, 115, 0x77, 123), // End
    (0xE050, 116, 0x7D, 20), // DownArrow
    (0xE051, 117, 0x79, 93), // PageDown
    (0xE052, 118, 0x72, 124), // Insert
    (0xE053, 119, 0x75, 112), // Delete
    (0xE05B, 133, 0x37, 117), // MetaLeft
    (0xE05C, 134, 0x36, -1), // MetaRight
    (0xE05D, 135, 0x6E, -1), // Apps
];

/// Pause / Break：db-kit 前端的記號值（set-1 沒有單一掃描碼）。
pub const SCANCODE_PAUSE: u32 = 0xE11D;

fn row(scancode: u32) -> Option<&'static (u32, i32, i32, i32)> {
    KEYMAP.iter().find(|r| r.0 == scancode)
}

/// 掃描碼 → 對方系統的鍵碼（`platform` 是 `PeerInfo.platform`；空的當 Windows）。對方系統沒有這顆 → None（不送）。
pub fn peer_keycode(scancode: u32, platform: &str) -> Option<u32> {
    let code = |c: i32| u32::try_from(c).ok();
    if scancode == SCANCODE_PAUSE {
        // rdev 的 Windows 表裡 Pause 沒有掃描碼：Linux 直接給 127；Windows 對方另走舊式控制鍵（session.rs），
        // macOS / Android 沒有這顆。
        return (!matches!(platform, "" | "Windows" | "Mac OS" | "Android")).then_some(127);
    }
    match platform {
        "" | "Windows" => {
            // 官方：大於 0xFF 又不是 E0 開頭的不送（https://github.com/rustdesk/rustdesk/issues/1371）。
            (scancode <= 0xFF || scancode >> 8 == 0xE0).then_some(scancode)
        }
        "Mac OS" => row(scancode).and_then(|r| code(r.2)),
        "Android" => row(scancode).and_then(|r| code(r.3)),
        _ => row(scancode).and_then(|r| code(r.1)),
    }
}

/// 字母鍵（要帶 CapsLock 狀態的）：A–Z 加上 `[ ] ; ' , .`（官方 `is_letter_rdev_key` + `is_letter_rdev_key_ex`）。
pub fn is_letter(scancode: u32) -> bool {
    matches!(scancode, 0x10..=0x19 | 0x1E..=0x26 | 0x2C..=0x32 | 0x1A | 0x1B | 0x27 | 0x28 | 0x33 | 0x34)
}

/// 數字鍵盤（要帶 NumLock 狀態的）：0–9、+ - * / 與小數點（官方 `is_numpad_rdev_key`，不含 Enter）。
pub fn is_numpad(scancode: u32) -> bool {
    matches!(scancode, 0x47..=0x53 | 0x37 | 0xE035)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_for_peer_platform() {
        // A：Windows 0x1E、Linux 38、macOS kVK_ANSI_A = 0、Android KEYCODE_A = 29
        assert_eq!(peer_keycode(0x1E, "Windows"), Some(0x1E));
        assert_eq!(peer_keycode(0x1E, ""), Some(0x1E));
        assert_eq!(peer_keycode(0x1E, "Linux"), Some(38));
        assert_eq!(peer_keycode(0x1E, "Mac OS"), Some(0));
        assert_eq!(peer_keycode(0x1E, "Android"), Some(29));
        // 左 Win：Linux 133（Super_L）、macOS kVK_Command = 0x37
        assert_eq!(peer_keycode(0xE05B, "Linux"), Some(133));
        assert_eq!(peer_keycode(0xE05B, "Mac OS"), Some(0x37));
        // 數字鍵盤 1：Linux 87（KP_End / KP_1）
        assert_eq!(peer_keycode(0x4F, "Linux"), Some(87));
        // 對方沒有的鍵 / 表上沒有的掃描碼 → 不送
        assert_eq!(peer_keycode(0x46, "Mac OS"), None, "macOS 沒有 ScrollLock");
        assert_eq!(peer_keycode(0x7F, "Linux"), None);
        // Pause：Windows 不原樣送（session.rs 改送控制鍵）、Linux 127、macOS 沒有
        assert_eq!(peer_keycode(SCANCODE_PAUSE, "Windows"), None);
        assert_eq!(peer_keycode(SCANCODE_PAUSE, "Linux"), Some(127));
        assert_eq!(peer_keycode(SCANCODE_PAUSE, "Mac OS"), None);
        // Windows 對方：E0 以外的兩位元組碼不原樣送
        assert_eq!(peer_keycode(0xE11E, "Windows"), None);
        assert_eq!(peer_keycode(0xE053, "Windows"), Some(0xE053));
    }

    #[test]
    fn lock_mode_key_classes() {
        for sc in [0x10, 0x19, 0x1E, 0x26, 0x2C, 0x32, 0x1A, 0x1B, 0x27, 0x28, 0x33, 0x34] {
            assert!(is_letter(sc), "{sc:#x}");
        }
        for sc in [0x02, 0x0B, 0x29, 0x2B, 0x35, 0x39, 0x1C] {
            assert!(!is_letter(sc), "{sc:#x}");
        }
        for sc in [0x47, 0x4F, 0x52, 0x53, 0x4A, 0x4E, 0x37, 0xE035] {
            assert!(is_numpad(sc), "{sc:#x}");
        }
        for sc in [0x45, 0xE01C, 0x02, 0xE047] {
            assert!(!is_numpad(sc), "{sc:#x}");
        }
    }

    #[test]
    fn table_is_sorted_and_unique() {
        assert!(KEYMAP.windows(2).all(|w| w[0].0 < w[1].0));
    }
}
