//! 遠端桌面全螢幕時的系統按鍵攔截（Windows：`WH_KEYBOARD_LL` 低階鍵盤 hook）。
//!
//! webview 收不到 Win、Alt+Tab、Alt+F4、Ctrl+Esc——作業系統先吃掉了（Alt+F4 甚至會把 App 關掉）。
//! 桌面版遠端桌面客戶端的做法是全螢幕時裝一個低階鍵盤 hook，把這幾個鍵攔下來轉給遠端。這裡一樣：
//! 只在「有遠端桌面分頁全螢幕、而且畫面有焦點」時才攔（前端用 `rd_keyboard_grab` 開關），
//! 攔到的鍵經回呼交給前端（再依協定轉成 RDP 掃描碼或 VNC keysym），同時把它吞掉不給本機。
//!
//! 判斷規則在 `should_grab`（純函式、可測）；hook 本身只在 Windows 編。其他平台 `set_target` 是 no-op。

/// 攔到的一個按鍵。`scancode` 是 PC/AT set-1（擴充鍵 OR 0xE000），跟 RDP 輸入紀錄同一種表示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrabbedKey {
    pub scancode: u16,
    pub down: bool,
}

// Virtual-key 碼（winuser.h）。
pub const VK_TAB: u32 = 0x09;
pub const VK_ESCAPE: u32 = 0x1B;
pub const VK_SPACE: u32 = 0x20;
pub const VK_LWIN: u32 = 0x5B;
pub const VK_RWIN: u32 = 0x5C;
pub const VK_APPS: u32 = 0x5D;
pub const VK_F4: u32 = 0x73;

/// 這個鍵要不要攔（按下時判斷；放開一律跟著按下時的決定，見 hook 的 `held`）。
///
/// - Win（左右）、選單鍵：一律攔（開始功能表、Win+D / Win+L 之類都該在遠端發生）。
/// - Alt+Tab、Alt+Esc、Alt+F4、Alt+Space：攔（切視窗 / 關視窗 / 視窗選單）。
/// - Ctrl+Esc：攔（開始功能表）。
/// - Ctrl+Alt+Del 攔不到（安全注意序列，OS 保留），照舊走工具列。
pub fn should_grab(vk: u32, alt: bool, ctrl: bool) -> bool {
    match vk {
        VK_LWIN | VK_RWIN | VK_APPS => true,
        VK_TAB | VK_F4 | VK_SPACE => alt,
        VK_ESCAPE => alt || ctrl,
        _ => false,
    }
}

/// `KBDLLHOOKSTRUCT` 的掃描碼 + 擴充旗標 → set-1 掃描碼（Win 鍵的 scanCode 是 0x5B、帶擴充旗標 → 0xE05B）。
pub fn to_scancode(scan: u32, extended: bool) -> u16 {
    let sc = (scan & 0xFF) as u16;
    if extended { sc | 0xE000 } else { sc }
}

pub type Sink = Box<dyn Fn(&str, GrabbedKey) + Send + Sync>;

#[cfg(all(windows, feature = "gui"))]
mod imp {
    use std::collections::HashSet;
    use std::sync::OnceLock;

    use parking_lot::Mutex;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, SetWindowsHookExW, HC_ACTION,
        KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, LLKHF_EXTENDED, LLKHF_INJECTED, LLKHF_UP, MSG, WH_KEYBOARD_LL,
    };

    use super::{should_grab, to_scancode, GrabbedKey, Sink};

    struct State {
        /// 目前要把鍵交給哪條連線；`None` = 不攔。
        target: Option<String>,
        sink: Option<Sink>,
        /// 按下時攔了的鍵（vk）：放開也要攔，不然本機會收到一個沒有按下的放開。
        held: HashSet<u32>,
    }

    fn state() -> &'static Mutex<State> {
        static S: OnceLock<Mutex<State>> = OnceLock::new();
        S.get_or_init(|| Mutex::new(State { target: None, sink: None, held: HashSet::new() }))
    }

    /// 前景視窗是不是自己這個程序的（切到別的程式時不能還在攔別人的 Win 鍵）。
    fn app_in_foreground() -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            pid == GetCurrentProcessId()
        }
    }

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY：WH_KEYBOARD_LL 的 lParam 就是 KBDLLHOOKSTRUCT*（HC_ACTION 時有效）。
            let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            // 自己（或別的程式）注入的鍵不攔，免得跟 SendInput 類工具打架。
            if (k.flags.0 & LLKHF_INJECTED.0) == 0 {
                let up = (k.flags.0 & LLKHF_UP.0) != 0;
                let mut st = state().lock();
                if let (Some(target), true) = (st.target.clone(), app_in_foreground()) {
                    let grab = if up {
                        st.held.remove(&k.vkCode)
                    } else {
                        let alt = (k.flags.0 & LLKHF_ALTDOWN.0) != 0;
                        let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } < 0;
                        let g = should_grab(k.vkCode, alt, ctrl) || st.held.contains(&k.vkCode);
                        if g {
                            st.held.insert(k.vkCode);
                        }
                        g
                    };
                    if grab {
                        let key = GrabbedKey {
                            scancode: to_scancode(k.scanCode, (k.flags.0 & LLKHF_EXTENDED.0) != 0),
                            down: !up,
                        };
                        if let Some(sink) = &st.sink {
                            sink(&target, key);
                        }
                        return LRESULT(1); // 吞掉：本機不處理
                    }
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// hook 執行緒：第一次開始攔的時候裝，之後一直留著（沒有目標時 hook 只是放行，成本很低）。
    fn ensure_hook() {
        static STARTED: OnceLock<()> = OnceLock::new();
        STARTED.get_or_init(|| {
            let _ = std::thread::Builder::new().name("rd-keygrab".into()).spawn(|| unsafe {
                if let Err(e) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0) {
                    eprintln!("[rd] 安裝鍵盤 hook 失敗：{e}");
                    return;
                }
                // 低階 hook 要求裝它的執行緒一直跑訊息迴圈。
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            });
        });
    }

    pub fn set_sink(sink: Sink) {
        state().lock().sink = Some(sink);
    }

    pub fn set_target(target: Option<String>) {
        let mut st = state().lock();
        if target.is_some() {
            drop(st);
            ensure_hook();
            st = state().lock();
        } else {
            st.held.clear();
        }
        st.target = target;
    }
}

#[cfg(all(windows, feature = "gui"))]
pub use imp::{set_sink, set_target};

/// 非 Windows：沒有低階 hook（macOS 要輔助使用權限的 event tap，另議）。
#[cfg(not(all(windows, feature = "gui")))]
pub fn set_sink(_sink: Sink) {}
#[cfg(not(all(windows, feature = "gui")))]
pub fn set_target(_target: Option<String>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grab_rules() {
        assert!(should_grab(VK_LWIN, false, false));
        assert!(should_grab(VK_RWIN, false, false));
        assert!(should_grab(VK_TAB, true, false), "Alt+Tab");
        assert!(!should_grab(VK_TAB, false, false), "單獨 Tab 照常進 webview");
        assert!(should_grab(VK_F4, true, false), "Alt+F4 不能把 App 關掉");
        assert!(!should_grab(VK_F4, false, true));
        assert!(should_grab(VK_ESCAPE, false, true), "Ctrl+Esc");
        assert!(should_grab(VK_ESCAPE, true, false), "Alt+Esc");
        assert!(!should_grab(VK_ESCAPE, false, false));
        assert!(!should_grab(0x41, true, true), "一般字母不攔");
    }

    #[test]
    fn scancodes() {
        assert_eq!(to_scancode(0x5B, true), 0xE05B, "左 Win");
        assert_eq!(to_scancode(0x0F, false), 0x0F, "Tab");
        assert_eq!(to_scancode(0x13E, false), 0x3E, "只取低 8 bits");
    }
}
