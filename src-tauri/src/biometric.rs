//! 生物辨識解鎖（Windows Hello 指紋 / 臉 / PIN、macOS Touch ID）。
//!
//! 用途與啟動密碼相同：**開啟 App 的閘門**。它不加密任何東西 —— 連線機密仍在 OS keychain，
//! `dbk` CLI 不受影響，刪掉 `app_settings.json` 一樣能解除。之所以仍值得做，是因為對「同一台機器、
//! 同一個 OS 帳號」以外的人來說，多一道當面驗證比一組會被看肩的密碼實際得多。
//!
//! 對外只有兩個動作：`status()` 探測可用性（**不跳提示**），`verify()` 跳 OS 提示。
//! 兩者都是**阻塞**的（底層 WinRT / LocalAuthentication 都是等使用者操作），呼叫端必須
//! 包在 `tokio::task::spawn_blocking` 裡 —— 見 `commands::biometric_verify`。
//!
//! 平台實作分家在 `imp`；Windows / macOS 以外一律回報 `unsupported_platform`，由前端退回密碼。

use serde::Serialize;

use crate::error::AppResult;

/// 生物辨識可用性。前端據此決定設定頁的開關能不能勾、以及勾不動時要顯示哪句說明。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BiometricStatus {
    pub available: bool,
    /// `"windows_hello"` / `"touch_id"` / `"none"`。前端用來決定顯示的名稱。
    pub kind: &'static str,
    /// `"available"` / `"no_device"` / `"not_enrolled"` / `"disabled_by_policy"`
    /// / `"device_busy"` / `"unsupported_platform"`。
    ///
    /// 刻意回穩定的機器可讀字串而非已本地化的句子：文案屬於前端，且四個語系的譯文
    /// 都走既有的 `t()` 流程，不必在 Rust 這邊再維護一份。
    pub reason: &'static str,
}

impl BiometricStatus {
    fn of(kind: &'static str, reason: &'static str) -> Self {
        Self {
            available: reason == "available",
            kind,
            reason,
        }
    }
}

/// 探測可用性。不會跳出任何提示，設定頁開啟時即可安全呼叫。
pub fn status() -> BiometricStatus {
    imp::status()
}

/// 跳出 OS 驗證提示，通過回 `true`。
///
/// `hwnd` 是 Windows 專用的父視窗控制代碼（其他平台忽略）：Hello 對話框必須認這個視窗當爸爸，
/// 否則會跑到 App 後面，使用者看到的就是「按了沒反應」。以 `isize` 而非 `HWND` 傳遞，
/// 是為了不讓型別跟著 Tauri 的 `windows` crate 版本走 —— 哪天兩邊版本分岔也不會編不過。
///
/// 使用者取消 / 比對失敗 / 重試次數用盡都回 `Ok(false)`（不是 `Err`），讓前端能區分
/// 「驗證沒過，可以再試」與「這台機器根本叫不起來」。
pub fn verify(hwnd: isize, reason: &str) -> AppResult<bool> {
    imp::verify(hwnd, reason)
}

// ---- Windows：UserConsentVerifier（WinRT）----
#[cfg(windows)]
mod imp {
    use super::BiometricStatus;
    use crate::error::{AppError, AppResult};
    use std::ffi::c_void;
    use windows::core::{factory, HSTRING};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::{HWND, RPC_E_CHANGED_MODE};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    const KIND: &str = "windows_hello";

    /// COM apartment 的 RAII guard。
    ///
    /// 底下兩個 WinRT 呼叫最後都是阻塞的 `IAsyncOperation::get()`，必須在 MTA 執行緒上跑：
    /// 若在擁有父視窗的 STA 執行緒阻塞，會和 modal 對話框互鎖（畫面凍住、Hello 永遠不出現）。
    /// `RPC_E_CHANGED_MODE` 表示這條執行緒已經被初始化成別的 apartment —— 那不是我們初始化的，
    /// 就不該由我們 `CoUninitialize`，否則會把別人的計數扣掉。
    struct ComGuard {
        owned: bool,
    }

    impl ComGuard {
        fn mta() -> Self {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            Self {
                owned: hr != RPC_E_CHANGED_MODE,
            }
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.owned {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn availability() -> windows::core::Result<UserConsentVerifierAvailability> {
        UserConsentVerifier::CheckAvailabilityAsync()?.get()
    }

    fn reason_of(a: UserConsentVerifierAvailability) -> &'static str {
        if a == UserConsentVerifierAvailability::Available {
            "available"
        } else if a == UserConsentVerifierAvailability::NotConfiguredForUser {
            "not_enrolled"
        } else if a == UserConsentVerifierAvailability::DisabledByPolicy {
            "disabled_by_policy"
        } else if a == UserConsentVerifierAvailability::DeviceBusy {
            "device_busy"
        } else {
            // DeviceNotPresent 與任何未來新增的值都歸在這裡：對使用者而言結論一樣是「用不了」。
            "no_device"
        }
    }

    pub fn status() -> BiometricStatus {
        let _com = ComGuard::mta();
        match availability() {
            Ok(a) => BiometricStatus::of(KIND, reason_of(a)),
            Err(_) => BiometricStatus::of(KIND, "no_device"),
        }
    }

    pub fn verify(hwnd: isize, reason: &str) -> AppResult<bool> {
        let _com = ComGuard::mta();

        // 先問可用性。不是為了給好錯誤訊息——是因為在未設定 Hello 的機器上略過這一步直接叫
        // RequestVerificationForWindowAsync，呼叫會直接 hang 住不返回。
        let avail = availability()
            .map_err(|e| AppError::Storage(tf!("無法取得 Windows Hello 狀態：{e}", e = e)))?;
        if avail != UserConsentVerifierAvailability::Available {
            return Ok(false);
        }

        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .map_err(|e| AppError::Storage(tf!("無法建立驗證介面：{e}", e = e)))?;

        // 非 UWP 的 Win32 程式不能用無視窗的 RequestVerificationAsync（叫不起來），
        // 必須走 interop 版本並交出真正的父視窗。
        let op: IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop.RequestVerificationForWindowAsync(
                HWND(hwnd as *mut c_void),
                &HSTRING::from(reason),
            )
        }
        .map_err(|e| AppError::Storage(tf!("無法顯示驗證提示：{e}", e = e)))?;

        let res = op
            .get()
            .map_err(|e| AppError::Storage(tf!("驗證過程發生錯誤：{e}", e = e)))?;
        Ok(res == UserConsentVerificationResult::Verified)
    }
}

// ---- macOS：LocalAuthentication（LAContext）----
#[cfg(target_os = "macos")]
mod imp {
    use super::BiometricStatus;
    use crate::error::AppResult;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};

    const KIND: &str = "touch_id";

    // LAError（見 LocalAuthentication/LAError.h）。objc2 把它包成 newtype，這裡只需要數值比對。
    const LA_ERROR_BIOMETRY_NOT_AVAILABLE: isize = -6;
    const LA_ERROR_BIOMETRY_NOT_ENROLLED: isize = -7;
    const LA_ERROR_BIOMETRY_LOCKOUT: isize = -8;

    /// 每次都開新的 `LAContext`。重用同一個 context 會讓「上一次驗證成功」在一段時間內直接放行，
    /// 對一個「每次打開都要驗證」的鎖來說等於沒驗。
    fn context() -> Retained<LAContext> {
        unsafe { LAContext::new() }
    }

    pub fn status() -> BiometricStatus {
        // 這裡刻意問 WithBiometrics 而不是 DeviceOwnerAuthentication：後者只要使用者有登入密碼
        // 就會回 Ok，於是沒有 Touch ID 的 Mac 也會被判成「有生物辨識」。
        let ctx = context();
        match unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }
        {
            Ok(()) => BiometricStatus::of(KIND, "available"),
            Err(e) => {
                let reason = match unsafe { e.code() } {
                    LA_ERROR_BIOMETRY_NOT_ENROLLED => "not_enrolled",
                    LA_ERROR_BIOMETRY_LOCKOUT => "device_busy",
                    LA_ERROR_BIOMETRY_NOT_AVAILABLE => "no_device",
                    _ => "no_device",
                };
                BiometricStatus::of(KIND, reason)
            }
        }
    }

    pub fn verify(_hwnd: isize, reason: &str) -> AppResult<bool> {
        // 空字串會讓 LocalAuthentication 丟 NSInvalidArgumentException，那是 ObjC 例外，
        // 穿過 Rust frame 就是整個 process abort。寧可用一句無意義的預設值也不要傳空的。
        let reason = if reason.trim().is_empty() {
            "Unlock"
        } else {
            reason
        };

        let ctx = context();
        if unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }
            .is_err()
        {
            return Ok(false);
        }

        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let ns_reason = NSString::from_str(reason);
        let block = RcBlock::new(move |ok: Bool, _err: *mut NSError| {
            // callback 由系統在別的執行緒呼叫。panic 若往上竄就會穿越 ObjC frame（UB / abort），
            // 一律在這裡吃掉；接收端收不到值時本來就會退回 false。
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = tx.send(ok.as_bool());
            }));
        });

        // 驗證本身用 DeviceOwnerAuthentication（含系統密碼備援）：Touch ID 濕手指刷不過時，
        // 使用者還能用開機密碼過關，不會被卡在門外。可用性判斷則維持只看生物辨識（見 status）。
        unsafe {
            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &ns_reason,
                &block,
            )
        };

        // ctx / block 必須活到 callback 回來為止，所以這裡阻塞等待而不是提早返回。
        Ok(rx.recv().unwrap_or(false))
    }
}

// ---- 其他平台（Linux …）----
//
// Linux 沒有等價的東西：polkit 是授權不是「證明你本人在場」，且要隨安裝檔佈署 .policy 檔、
// 要求 session 內有 polkit agent；fprintd 又只涵蓋指紋機種。與其做半套，不如誠實回報不支援，
// 由前端把開關停用並引導使用啟動密碼。
#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::BiometricStatus;
    use crate::error::AppResult;

    pub fn status() -> BiometricStatus {
        BiometricStatus::of("none", "unsupported_platform")
    }

    pub fn verify(_hwnd: isize, _reason: &str) -> AppResult<bool> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不論平台，`status()` 都必須能安全呼叫且不跳任何 UI（CI 上沒有人可以按指紋）。
    ///
    /// 順帶把結果印出來（`cargo test -- --nocapture`）：查「為什麼設定頁的開關是灰的」時，
    /// 這是最快的判斷依據，不必為此開一次 GUI。
    #[test]
    fn status_is_safe_to_call() {
        let s = status();
        println!("biometric status = {s:?}");
        assert!(matches!(s.kind, "windows_hello" | "touch_id" | "none"));
        assert_eq!(s.available, s.reason == "available");
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn unsupported_platform_reports_and_never_passes() {
        let s = status();
        assert!(!s.available);
        assert_eq!(s.reason, "unsupported_platform");
        assert!(!verify(0, "test").unwrap());
    }
}
