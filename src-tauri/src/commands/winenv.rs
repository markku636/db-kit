//! Windows 免安裝版的「使用者變數」（`HKCU\Environment`）設定。
//!
//! 安裝版有安裝程式，要把資料夾寫進 PATH、要在移除時收回來，都是它的事。免安裝版解壓即用、
//! 刻意不碰登錄檔，於是 `dbk` 永遠不在 PATH 上，`ORACLE_HOME`、`HTTP_PROXY`、`DB_KIT_DATA_DIR`
//! 這類變數也只能在開 App 之前自己 `set` 一次、關掉就沒了。這裡補上那一塊：在 App 裡列出、
//! 新增、修改、刪除**目前這個 Windows 帳戶**的使用者變數，並提供「把這個資料夾加進 PATH」的
//! 一鍵開關（加進去之後任何終端機都能直接跑 `dbk`）。
//!
//! 只動「使用者變數」（`HKEY_CURRENT_USER\Environment`），不動「系統變數」
//! （`HKLM\...\Session Manager\Environment`）：使用者變數屬於登入的這個帳戶、不需要系統管理員
//! 權限，影響範圍也只有自己。系統變數這裡只讀不寫，用來判斷「資料夾是不是已經被管理員加進
//! 系統 PATH 了」——是的話就不必再往使用者 PATH 塞一份。
//!
//! 刻意限定 **Windows + 免安裝版**（執行檔旁有 `portable.txt`，與 `store` / `update` 同一個判準）：
//! - 安裝版的 PATH 歸安裝程式管，App 再插手只會留下移除不掉的殘渣。
//! - macOS / Linux 沒有「寫一個地方就生效」的等價物（`.zshrc` / `.profile` / launchctl /
//!   systemd 各走各的），不在這裡假裝做得到。
//!
//! 非 Windows 與安裝版一律回報「不支援」，前端整段不顯示（見 `user_env_support`）。
//!
//! 兩件事要先講清楚，前端的說明文字也照這個講：
//! 1. 寫進去的是**這台電腦的登錄檔**，不跟著 `data\` 走。隨身碟換一台電腦要再設一次。
//! 2. 改完廣播 `WM_SETTINGCHANGE`，**之後新開**的終端機 / 程式才讀得到；已經開著的程式
//!    （包含 db-kit 自己）環境區塊是啟動時複製的那一份，不會跟著變——所以這裡不碰自己行程的
//!    環境變數，免得「App 內看得到、重開就不見」或 `DB_KIT_DATA_DIR` 在用到一半被換掉。

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 名稱長度上限。環境變數本身能到 32767，但名稱寫那麼長只是自找麻煩，
/// 這裡擋在前面，免得登錄檔裡留下一條看不完也刪不掉的垃圾。
const MAX_NAME: usize = 255;
/// 值長度上限：單一環境變數的上限（32767 個字元）。
const MAX_VALUE: usize = 32767;
/// 使用者 PATH 在登錄檔裡的值名稱。Windows 自己寫的是 `Path`（登錄檔的值名不分大小寫）。
const PATH_NAME: &str = "Path";

/// 免安裝版資料夾與 PATH 現況。`user_env_support` 回 `None` = 這份不是 Windows 免安裝版。
#[derive(Debug, Clone, Serialize)]
pub struct UserEnvSupport {
    /// 免安裝版的資料夾（執行檔所在目錄），也就是「加進 PATH」會加的那個路徑。
    pub app_dir: String,
    /// 資料夾裡有 `dbk.exe`：前端據此決定要不要說「加進 PATH 就能在終端機直接跑 dbk」。
    pub has_dbk: bool,
    /// `app_dir` 已經在使用者 PATH 裡。
    pub on_user_path: bool,
    /// `app_dir` 已經在系統 PATH 裡（管理員設的）。這時再加進使用者 PATH 只是多一份。
    pub on_machine_path: bool,
}

/// 一筆使用者變數。
#[derive(Debug, Clone, Serialize)]
pub struct UserEnvVar {
    pub name: String,
    pub value: String,
    /// `REG_EXPAND_SZ`：值裡的 `%VAR%` 由系統展開（Windows 自己建的 `Path` / `TEMP` 都是）。
    /// 寫回時沿用原本的型別，免得把 `%USERPROFILE%\bin` 存成一段永遠展不開的死字串。
    pub expand: bool,
}

/// 這份 App 不是 Windows 免安裝版 —— 所有寫入路徑的第一道關。
fn unsupported() -> AppError {
    AppError::Env(t!("只有 Windows 免安裝版可以設定使用者變數").into())
}

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Env(e.to_string())
}

/// 檢查並正規化變數名稱。名稱前後的空白一律去掉：登錄檔收得下，但那個變數在任何
/// 終端機裡都叫不出來，只會變成一條鬼變數。
fn validate_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::Env(t!("變數名稱不可空白").into()));
    }
    // `=` 是環境變數區塊裡名稱與值的分隔符；控制字元（含 NUL）會讓登錄檔與環境區塊對不起來。
    if n.contains('=') || n.chars().any(char::is_control) {
        return Err(AppError::Env(t!("變數名稱不能包含「=」或控制字元").into()));
    }
    if n.chars().count() > MAX_NAME {
        return Err(AppError::Env(tf!("變數名稱太長（上限 {n} 個字元）", n = MAX_NAME)));
    }
    Ok(n.to_string())
}

/// 檢查並正規化變數值（前後空白去掉：PATH 之類的值帶著尾端空白是經典的疑難雜症來源）。
fn validate_value(value: &str) -> AppResult<String> {
    let v = value.trim();
    if v.chars().any(char::is_control) {
        return Err(AppError::Env(t!("變數值不能包含控制字元（換行、Tab 等）").into()));
    }
    if v.chars().count() > MAX_VALUE {
        return Err(AppError::Env(tf!("變數值太長（上限 {n} 個字元）", n = MAX_VALUE)));
    }
    Ok(v.to_string())
}

/// PATH 字串處理的純函式：與平台無關、可單測。非 Windows 的建置只有測試用得到。
#[cfg_attr(not(windows), allow(dead_code))]
mod pathstr {
    /// 拆 PATH：以 `;` 分段、去掉空白與空段。
    pub fn split_path(raw: &str) -> Vec<String> {
        raw.split(';').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
    }

    /// 展開 `%VAR%`。查不到的原樣留著（Windows 也是這樣）。
    /// 取值的來源以參數注入，測試才不必去動進程的環境變數。
    pub fn expand_with(s: &str, get: &dyn Fn(&str) -> Option<String>) -> String {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(i) = rest.find('%') {
            let (head, tail) = rest.split_at(i);
            out.push_str(head);
            // `%` 之後沒有成對的 `%`（`D:\50%off`）：剩下的原樣收尾，不能吃掉半截路徑。
            let Some(j) = tail[1..].find('%') else {
                out.push_str(tail);
                return out;
            };
            let name = &tail[1..1 + j];
            match get(name) {
                Some(v) => out.push_str(&v),
                None => {
                    out.push('%');
                    out.push_str(name);
                    out.push('%');
                }
            }
            rest = &tail[j + 2..];
        }
        out.push_str(rest);
        out
    }

    fn expand(s: &str) -> String {
        expand_with(s, &|k| std::env::var(k).ok())
    }

    /// 路徑比對用的正規化：去掉前後空白與包住路徑的引號、展開 `%VAR%`、去掉結尾的 `\`、轉小寫。
    /// Windows 的路徑不分大小寫，`D:\dbkit` 與 `d:\dbkit\` 是同一個資料夾。
    pub fn norm_dir(s: &str) -> String {
        expand(s.trim().trim_matches('"')).trim_end_matches(['\\', '/']).to_lowercase()
    }

    pub fn same_dir(a: &str, b: &str) -> bool {
        norm_dir(a) == norm_dir(b)
    }

    /// `dir` 是否已在這份 PATH 裡。
    pub fn in_path(raw: &str, dir: &str) -> bool {
        split_path(raw).iter().any(|e| same_dir(e, dir))
    }

    /// 算出加入 / 移出 `dir` 之後的 PATH 字串。
    ///
    /// - 加入：接在最後面（放前面會蓋掉使用者原本挑好的同名工具）。已經在裡面就原樣返回。
    /// - 移出：所有指到同一個資料夾的段落都拿掉（重複加過也清得乾淨）。
    /// - 其餘段落的原文與順序完全保留 —— 別人的 `%VAR%` 寫法不會被我們展開後寫死。
    pub fn toggled_path(raw: &str, dir: &str, enable: bool) -> String {
        let mut entries = split_path(raw);
        if enable {
            if !entries.iter().any(|e| same_dir(e, dir)) {
                entries.push(dir.to_string());
            }
        } else {
            entries.retain(|e| !same_dir(e, dir));
        }
        entries.join(";")
    }
}

// ---- command ----

/// 這份 App 能不能設使用者變數；`None` = 不能（非 Windows、或不是免安裝版），前端整段不顯示。
#[tauri::command]
pub async fn user_env_support() -> Option<UserEnvSupport> {
    tokio::task::spawn_blocking(imp::support).await.ok().flatten()
}

/// 目前這個帳戶的使用者變數（依名稱排序；非字串型別的值不列出，它們不會變成環境變數）。
#[tauri::command]
pub async fn user_env_list() -> AppResult<Vec<UserEnvVar>> {
    tokio::task::spawn_blocking(imp::list).await.map_err(join_err)?
}

/// 新增或覆寫一筆使用者變數。
#[tauri::command]
pub async fn user_env_set(name: String, value: String) -> AppResult<()> {
    let name = validate_name(&name)?;
    let value = validate_value(&value)?;
    tokio::task::spawn_blocking(move || imp::set(&name, &value)).await.map_err(join_err)?
}

/// 刪除一筆使用者變數。
#[tauri::command]
pub async fn user_env_remove(name: String) -> AppResult<()> {
    let name = validate_name(&name)?;
    tokio::task::spawn_blocking(move || imp::remove(&name)).await.map_err(join_err)?
}

/// 把免安裝資料夾加進 / 移出使用者 PATH。回傳更新後的現況（前端直接換上，不必再查一次）。
/// 要加的路徑由後端自己決定（執行檔所在目錄），不吃前端給的字串。
#[tauri::command]
pub async fn user_env_path(enable: bool) -> AppResult<UserEnvSupport> {
    tokio::task::spawn_blocking(move || imp::set_on_path(enable)).await.map_err(join_err)?
}

// ---- 平台實作 ----

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;

    use winreg::enums::{RegType, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue};

    use super::pathstr::{in_path, split_path, toggled_path};
    use super::{unsupported, UserEnvSupport, UserEnvVar, PATH_NAME};
    use crate::error::{AppError, AppResult};

    /// 使用者變數：`HKEY_CURRENT_USER\Environment`（登入的這個帳戶，不需要系統管理員）。
    const USER_ENV_KEY: &str = "Environment";
    /// 系統變數：唯讀，只用來看資料夾是不是已經在系統 PATH 上。
    const MACHINE_ENV_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

    /// 免安裝版的資料夾：執行檔旁有 `portable.txt` 才算（與 `store` / `update` 同一個判準）。
    /// 開發時（`cargo tauri dev`）沒有這個檔，整個功能不會出現；要試就在執行檔旁放一個。
    fn portable_dir() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?.to_path_buf();
        dir.join(crate::store::PORTABLE_MARKER).is_file().then_some(dir)
    }

    pub fn support() -> Option<UserEnvSupport> {
        let dir = portable_dir()?;
        let app_dir = dir.to_string_lossy().to_string();
        Some(UserEnvSupport {
            has_dbk: dir.join("dbk.exe").is_file(),
            on_user_path: in_path(&user_path().unwrap_or_default(), &app_dir),
            on_machine_path: in_path(&machine_path().unwrap_or_default(), &app_dir),
            app_dir,
        })
    }

    /// 開 `HKCU\Environment`。免安裝版以外一律擋在這裡 —— 前端不顯示只是不給按，
    /// command 本身也不該讓安裝版改得動（見檔頭）。
    fn user_key(write: bool) -> AppResult<RegKey> {
        portable_dir().ok_or_else(unsupported)?;
        let perms = if write { KEY_READ | KEY_WRITE } else { KEY_READ };
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(USER_ENV_KEY, perms)
            .map_err(|e| AppError::Env(tf!("打不開使用者變數（HKCU\\Environment）：{e}", e = e)))
    }

    pub fn list() -> AppResult<Vec<UserEnvVar>> {
        let key = user_key(false)?;
        let mut out: Vec<UserEnvVar> = key
            .enum_values()
            .filter_map(Result::ok)
            .filter_map(|(name, val)| {
                let expand = match val.vtype {
                    RegType::REG_SZ => false,
                    RegType::REG_EXPAND_SZ => true,
                    // 其他型別（REG_DWORD、REG_BINARY…）不會變成環境變數。列出來只會讓人
                    // 以為可以改，改完又什麼都沒發生。
                    _ => return None,
                };
                Some(UserEnvVar { name, value: decode_sz(&val.bytes), expand })
            })
            .collect();
        // 固定依名稱排序（不分大小寫）：登錄檔的原序是寫入順序，每台機器都不一樣，不好找。
        out.sort_by_key(|v| v.name.to_lowercase());
        Ok(out)
    }

    pub fn set(name: &str, value: &str) -> AppResult<()> {
        let key = user_key(true)?;
        // 型別：原本是 `REG_EXPAND_SZ` 就維持，新變數看值裡有沒有 `%`。
        // 判斷錯的代價是 `%USERPROFILE%\bin` 變成展不開的死字串，所以寧可多展開。
        let expand = key.get_raw_value(name).is_ok_and(|v| matches!(v.vtype, RegType::REG_EXPAND_SZ))
            || value.contains('%');
        write_sz(&key, name, value, expand)
    }

    pub fn remove(name: &str) -> AppResult<()> {
        let key = user_key(true)?;
        key.delete_value(name)
            .map_err(|e| AppError::Env(tf!("刪除使用者變數「{name}」失敗：{e}", name = name, e = e)))?;
        broadcast();
        Ok(())
    }

    pub fn set_on_path(enable: bool) -> AppResult<UserEnvSupport> {
        let dir = portable_dir().ok_or_else(unsupported)?;
        let app_dir = dir.to_string_lossy().to_string();
        let key = user_key(true)?;
        let current = key.get_raw_value(PATH_NAME).ok();
        // Path 存成字串以外的型別（正常不會發生）：不猜它的意思，原封不動退回來。
        // 這一欄寫壞的代價是整個帳戶的 PATH 沒了，寧可什麼都不做。
        if current.as_ref().is_some_and(|v| !matches!(v.vtype, RegType::REG_SZ | RegType::REG_EXPAND_SZ)) {
            return Err(AppError::Env(t!("使用者 PATH 的格式不是字串，為了安全起見不去更動它").into()));
        }
        let raw = current.as_ref().map(|v| decode_sz(&v.bytes)).unwrap_or_default();
        let next = toggled_path(&raw, &app_dir, enable);
        if next == raw {
            // 本來就是要的狀態（重複按、或別處已經改過）：不寫、不廣播。
            return support().ok_or_else(unsupported);
        }
        // 原本是 `REG_EXPAND_SZ`（Windows 預設）就維持；任一段帶 `%` 也必須是 EXPAND_SZ，
        // 否則別人設的 `%USERPROFILE%\bin` 會被我們寫成死字串。
        let expand = current.is_some_and(|v| matches!(v.vtype, RegType::REG_EXPAND_SZ))
            || split_path(&next).iter().any(|e| e.contains('%'));
        write_sz(&key, PATH_NAME, &next, expand)?;
        let after = support().ok_or_else(unsupported)?;
        // 寫完了卻不是該有的狀態：多半是同時有別的程式在改 PATH。講清楚比默默成功好。
        if after.on_user_path != enable {
            return Err(AppError::Env(t!("使用者 PATH 似乎同時被其他程式改動，請再試一次").into()));
        }
        Ok(after)
    }

    fn write_sz(key: &RegKey, name: &str, value: &str, expand: bool) -> AppResult<()> {
        let v = RegValue {
            vtype: if expand { RegType::REG_EXPAND_SZ } else { RegType::REG_SZ },
            bytes: encode_sz(value),
        };
        key.set_raw_value(name, &v)
            .map_err(|e| AppError::Env(tf!("寫入使用者變數「{name}」失敗：{e}", name = name, e = e)))?;
        broadcast();
        Ok(())
    }

    fn user_path() -> Option<String> {
        read_path(RegKey::predef(HKEY_CURRENT_USER), USER_ENV_KEY)
    }

    fn machine_path() -> Option<String> {
        read_path(RegKey::predef(HKEY_LOCAL_MACHINE), MACHINE_ENV_KEY)
    }

    fn read_path(root: RegKey, sub: &str) -> Option<String> {
        let key = root.open_subkey_with_flags(sub, KEY_READ).ok()?;
        let v = key.get_raw_value(PATH_NAME).ok()?;
        matches!(v.vtype, RegType::REG_SZ | RegType::REG_EXPAND_SZ).then(|| decode_sz(&v.bytes))
    }

    /// 登錄檔的字串是 UTF-16LE + 結尾 NUL。winreg 的 `String::from_reg_value` 也做得到，
    /// 但這裡自己解：容得下沒有結尾 NUL、或長度是奇數的壞資料（別的程式寫的），
    /// 不會因為一筆壞值就整張清單讀不出來。
    fn decode_sz(bytes: &[u8]) -> String {
        let u16s: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let end = u16s.iter().position(|&c| c == 0).unwrap_or(u16s.len());
        String::from_utf16_lossy(&u16s[..end])
    }

    fn encode_sz(s: &str) -> Vec<u8> {
        let mut bytes: Vec<u8> = s.encode_utf16().flat_map(u16::to_le_bytes).collect();
        bytes.extend_from_slice(&[0, 0]); // 結尾 NUL：少了它，有些程式會讀到尾巴的垃圾
        bytes
    }

    // 只為了一支 user32 函式，不去動 `windows` crate 的 feature 與版本綁定：
    // 這個宣告跟 C 標頭一樣穩，`windows` 升版也不會動到它。
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: *const u16,
            flags: u32,
            timeout_ms: u32,
            result: *mut usize,
        ) -> isize;
    }

    /// 廣播「環境變數改了」。
    ///
    /// 登錄檔寫下去只是存著：Explorer 這類長壽的程式是在啟動時複製一份環境區塊，之後從它開的
    /// 終端機 / 程式都繼承那一份。收到 `WM_SETTINGCHANGE("Environment")` 它才會重讀，新開的
    /// 視窗才吃得到新值——少了這一步，使用者得登出再登入才會生效。
    ///
    /// 用 `SendMessageTimeout` 而不是 `PostMessage`：要讓對方真的處理完。`SMTO_ABORTIFHUNG`
    /// 加 1 秒上限是保險——某個視窗沒在抽訊息時，不會把這裡一起拖住（本來就跑在 blocking 執行緒）。
    /// 廣播失敗不算錯：值已經寫進去了，下次登入照樣生效，沒必要讓使用者看到一個無事可做的錯誤。
    fn broadcast() {
        const HWND_BROADCAST: isize = 0xffff;
        const WM_SETTINGCHANGE: u32 = 0x001A;
        const SMTO_ABORTIFHUNG: u32 = 0x0002;
        let target: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result: usize = 0;
        // SAFETY: 常數訊息 + 一個活著的 UTF-16 NUL 結尾字串；out 參數指向本地變數。
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                target.as_ptr(),
                SMTO_ABORTIFHUNG,
                1000,
                &mut result,
            );
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{unsupported, UserEnvSupport, UserEnvVar};
    use crate::error::AppResult;

    pub fn support() -> Option<UserEnvSupport> {
        None
    }

    pub fn list() -> AppResult<Vec<UserEnvVar>> {
        Err(unsupported())
    }

    pub fn set(_name: &str, _value: &str) -> AppResult<()> {
        Err(unsupported())
    }

    pub fn remove(_name: &str) -> AppResult<()> {
        Err(unsupported())
    }

    pub fn set_on_path(_enable: bool) -> AppResult<UserEnvSupport> {
        Err(unsupported())
    }
}

#[cfg(test)]
mod tests {
    use super::pathstr::*;
    use super::*;

    fn fake_env(k: &str) -> Option<String> {
        match k {
            "USERPROFILE" => Some(r"C:\Users\mark".into()),
            _ => None,
        }
    }

    #[test]
    fn expands_known_vars_and_keeps_unknown() {
        let e = |s: &str| expand_with(s, &fake_env);
        assert_eq!(e(r"%USERPROFILE%\bin"), r"C:\Users\mark\bin");
        assert_eq!(e(r"%NOPE%\bin"), r"%NOPE%\bin");
        assert_eq!(e(r"D:\dbkit"), r"D:\dbkit");
        // 沒有成對的 `%`：原樣留著，不能吃掉半截路徑。
        assert_eq!(e(r"D:\50%off"), r"D:\50%off");
    }

    #[test]
    fn same_dir_ignores_case_quotes_and_trailing_slash() {
        assert!(same_dir(r"D:\dbkit", "d:\\DBKit\\"));
        assert!(same_dir("\"D:\\dbkit\"", r"D:\dbkit"));
        assert!(!same_dir(r"D:\dbkit", r"D:\dbkit2"));
    }

    #[test]
    fn toggled_path_adds_once_at_the_end() {
        let raw = r"C:\Windows;C:\Windows\System32";
        let with = toggled_path(raw, r"D:\dbkit", true);
        assert_eq!(with, r"C:\Windows;C:\Windows\System32;D:\dbkit");
        // 已經在裡面（大小寫 / 結尾斜線不同也算）就不再加一份。
        assert_eq!(toggled_path(&with, "d:\\dbkit\\", true), with);
    }

    #[test]
    fn toggled_path_removes_every_duplicate_and_keeps_the_rest_verbatim() {
        let raw = r"D:\dbkit;%USERPROFILE%\bin;d:\dbkit\;C:\Windows";
        let without = toggled_path(raw, r"D:\dbkit", false);
        assert_eq!(without, r"%USERPROFILE%\bin;C:\Windows");
        // 不在裡面時移除是 no-op。
        assert_eq!(toggled_path(&without, r"D:\dbkit", false), without);
    }

    #[test]
    fn split_path_drops_blank_segments() {
        assert_eq!(split_path(r"C:\a;; D:\b ;"), vec![r"C:\a".to_string(), r"D:\b".to_string()]);
        assert!(split_path("").is_empty());
    }

    #[test]
    fn in_path_compares_as_folders_not_strings() {
        assert!(in_path(r"C:\Windows;D:\dbkit", "d:\\dbkit\\"));
        assert!(!in_path(r"C:\Windows", r"D:\dbkit"));
        assert!(!in_path("", r"D:\dbkit"));
    }

    #[test]
    fn validate_name_rejects_blank_equals_and_control_chars() {
        assert_eq!(validate_name("  ORACLE_HOME  ").unwrap(), "ORACLE_HOME");
        assert!(validate_name("   ").is_err());
        assert!(validate_name("A=B").is_err());
        assert!(validate_name("A\nB").is_err());
        assert!(validate_name(&"x".repeat(MAX_NAME + 1)).is_err());
    }

    #[test]
    fn validate_value_trims_and_rejects_control_chars() {
        assert_eq!(validate_value("  D:\\dbkit  ").unwrap(), "D:\\dbkit");
        assert_eq!(validate_value("").unwrap(), "");
        assert!(validate_value("a\tb").is_err());
        assert!(validate_value(&"x".repeat(MAX_VALUE + 1)).is_err());
    }
}
