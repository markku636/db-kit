//! 後端 i18n（與前端 `src/i18n.ts` 同一套慣例）。
//!
//! - **繁中原文即 translation key**：查無譯文時回傳原字面值（identity fallback），
//!   故 zh-TW 模式行為逐字元不變、未收錄的字串照常顯示中文。
//! - 插值佔位符 `{name}`：`tf!("已匯出 {n} 列", n = rows)`。
//! - 語言為進程層級全域狀態（`AtomicU8`，無鎖）；GUI 由 `set_lang` command 更新、
//!   dbk CLI 於啟動時依 `--lang` / `DBKIT_LANG` / `app_settings.json` 決定。
//!
//! macro `t!` / `tf!` 以 `#[macro_export]` 匯出，讓 overlay 私有檔（如 `db/qland/mod.rs`）也能使用。

use std::sync::atomic::{AtomicU8, Ordering};

/// 介面語言。`Default` = `ZhTw`（不偵測 OS locale，避免既有使用者升級後突然變英文）。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Lang {
    #[default]
    ZhTw,
    En,
    Ja,
    Ko,
    ZhCn,
}

impl Lang {
    /// 對前端 / 設定檔用的語言碼（與 `src/i18n.ts` 的 `Lang` 型別一致）。
    pub fn as_code(self) -> &'static str {
        match self {
            Lang::ZhTw => "zh-TW",
            Lang::En => "en",
            Lang::Ja => "ja",
            Lang::Ko => "ko",
            Lang::ZhCn => "zh-CN",
        }
    }

    /// 由語言碼解析（大小寫不敏感；未知回 `None`）。
    ///
    /// 別名收得寬一點：`--lang` 與 `DBKIT_LANG` 常被填成 OS locale 的寫法
    /// （`ja_JP`、`ko-KR`、`zh_CN.UTF-8` 的前半段），沒必要為此回錯誤。
    pub fn from_code(s: &str) -> Option<Lang> {
        let s = s.trim().to_ascii_lowercase();
        let s = s.split('.').next().unwrap_or(&s); // 去掉 `zh_CN.UTF-8` 的編碼尾巴
        match s {
            "zh-tw" | "zh" | "zh-hant" | "zh_tw" | "zh-hk" | "zh_hk" | "zh-mo" => Some(Lang::ZhTw),
            "en" | "en-us" | "en_us" | "en-gb" => Some(Lang::En),
            "ja" | "ja-jp" | "ja_jp" | "jp" => Some(Lang::Ja),
            "ko" | "ko-kr" | "ko_kr" | "kr" => Some(Lang::Ko),
            "zh-cn" | "zh_cn" | "zh-hans" | "zh-sg" | "zh_sg" => Some(Lang::ZhCn),
            _ => None,
        }
    }
}

// 以 `Lang as u8` 對應（0 = ZhTw、1 = En、2 = Ja、3 = Ko、4 = ZhCn），載入時反查。
static LANG: AtomicU8 = AtomicU8::new(0);

/// 設定進程語言（GUI command / CLI 啟動時呼叫）。
pub fn set_lang(l: Lang) {
    LANG.store(l as u8, Ordering::Relaxed);
}

/// 目前進程語言。
pub fn current() -> Lang {
    match LANG.load(Ordering::Relaxed) {
        1 => Lang::En,
        2 => Lang::Ja,
        3 => Lang::Ko,
        4 => Lang::ZhCn,
        _ => Lang::ZhTw,
    }
}

/// 單一語言的查表：`<lang>` → `<lang>_ext` → `None`。
///
/// `_ext` 是給下游打包（overlay / 外掛）注入自家私有字串譯文用的擴充點，
/// 上游恆回 `None`（見 `locales/en_ext.rs`）。
fn lookup_in(l: Lang, zh: &str) -> Option<&'static str> {
    use crate::locales as loc;
    match l {
        Lang::ZhTw => None,
        Lang::En => loc::en::lookup(zh).or_else(|| loc::en_ext::lookup(zh)),
        Lang::Ja => loc::ja::lookup(zh).or_else(|| loc::ja_ext::lookup(zh)),
        Lang::Ko => loc::ko::lookup(zh).or_else(|| loc::ko_ext::lookup(zh)),
        Lang::ZhCn => loc::zh_cn::lookup(zh).or_else(|| loc::zh_cn_ext::lookup(zh)),
    }
}

/// 次選語言。與前端 `src/i18n.ts` 的 `FALLBACK` 同一份決策：日 / 韓查無譯文時退到英文，
/// 而不是直接露出繁中；簡中的 key 本身就是中文，退回原文即可。
fn fallback_of(l: Lang) -> Option<Lang> {
    match l {
        Lang::Ja | Lang::Ko => Some(Lang::En),
        _ => None,
    }
}

/// 查目前語言的譯文（`<lang>` → `<lang>_ext` → 次選語言），查無回 `None`、**不**做 identity fallback。
///
/// 給拿不到 `&'static str` 的呼叫端用 —— clap 的 help 文字在執行期是 `String`，
/// 但譯文表回的是 `&'static str`，兩者無法用 `lookup` 的簽章接起來。
pub fn lookup_opt(zh: &str) -> Option<&'static str> {
    let l = current();
    if l == Lang::ZhTw {
        return None;
    }
    lookup_in(l, zh).or_else(|| fallback_of(l).and_then(|f| lookup_in(f, zh)))
}

/// 查表：非 `ZhTw` 時查譯文（`<lang>` → `<lang>_ext` → 次選語言 → 原文）。
/// 一路查無就回原字面值（identity fallback），故未收錄的字串照常顯示中文。
pub fn lookup(zh: &'static str) -> &'static str {
    lookup_opt(zh).unwrap_or(zh)
}

/// `{name}` 佔位符執行期取代（與前端 `interpolate` 同慣例）。
///
/// - 佔位符 key 必須為 `[A-Za-z0-9_]+`；不符者原樣保留。
/// - args 內找不到對應 key 時，保留字面 `{key}`（不丟例外，方便部分插值）。
/// - `format!` 要求編譯期字面值，查表回來的 `&str` 不適用，故一律走此執行期取代。
pub fn interpolate(tpl: &str, args: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let key = &after[..close];
                let is_ident =
                    !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
                if is_ident {
                    match args.iter().find(|(k, _)| *k == key) {
                        Some((_, v)) => out.push_str(v),
                        None => {
                            // 未提供該 key：保留字面 `{key}`（與前端 regex 未命中時保留 whole 一致）。
                            out.push('{');
                            out.push_str(key);
                            out.push('}');
                        }
                    }
                    rest = &after[close + 1..];
                } else {
                    // `{` 後非合法識別字：`{` 原樣輸出，從其後繼續掃描。
                    out.push('{');
                    rest = after;
                }
            }
            None => {
                // 無對應 `}`：其餘原樣輸出。
                out.push('{');
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// 翻譯字面值 → `&'static str`（查無回原文）。
#[macro_export]
macro_rules! t {
    ($zh:literal) => {
        $crate::i18n::lookup($zh)
    };
}

/// 翻譯 + `{name}` 插值 → `String`。走執行期取代（見 `interpolate`）。
///
/// ```ignore
/// tf!("已匯出 {n} 列到 {path}", n = rows, path = path)
/// ```
#[macro_export]
macro_rules! tf {
    ($zh:literal, $($k:ident = $v:expr),* $(,)?) => {
        $crate::i18n::interpolate(
            $crate::i18n::lookup($zh),
            &[$((stringify!($k), ($v).to_string())),*],
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 語言是進程層級全域狀態，會動到它的測試必須互斥（cargo test 預設多執行緒同進程）。
    static LANG_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn interpolate_replaces_named_placeholders() {
        let s = interpolate("已匯出 {n} 列到 {path}", &[("n", "3".into()), ("path", "/tmp/a".into())]);
        assert_eq!(s, "已匯出 3 列到 /tmp/a");
    }

    #[test]
    fn interpolate_keeps_unknown_and_malformed() {
        assert_eq!(interpolate("{a}-{b}", &[("a", "1".into())]), "1-{b}");
        assert_eq!(interpolate("100% {done}", &[]), "100% {done}");
        assert_eq!(interpolate("no-brace", &[("a", "1".into())]), "no-brace");
        assert_eq!(interpolate("open {only", &[]), "open {only");
    }

    #[test]
    fn identity_fallback_in_zh() {
        let _g = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_lang(Lang::ZhTw);
        assert_eq!(lookup("完全沒有收錄的字串 xyz"), "完全沒有收錄的字串 xyz");
    }

    #[test]
    fn lang_code_roundtrip() {
        assert_eq!(Lang::from_code("EN"), Some(Lang::En));
        assert_eq!(Lang::from_code("zh-TW"), Some(Lang::ZhTw));
        assert_eq!(Lang::from_code("fr"), None);
        assert_eq!(Lang::En.as_code(), "en");
        for l in [Lang::ZhTw, Lang::En, Lang::Ja, Lang::Ko, Lang::ZhCn] {
            assert_eq!(Lang::from_code(l.as_code()), Some(l), "{}", l.as_code());
        }
    }

    #[test]
    fn lang_code_accepts_os_locale_spellings() {
        assert_eq!(Lang::from_code("ja_JP"), Some(Lang::Ja));
        assert_eq!(Lang::from_code("ko-KR"), Some(Lang::Ko));
        assert_eq!(Lang::from_code("zh_CN.UTF-8"), Some(Lang::ZhCn));
        assert_eq!(Lang::from_code("zh-Hans"), Some(Lang::ZhCn));
    }

    /// `current()` 的反查表若漏掉一個 variant，該語言會靜默變成 zh-TW。
    #[test]
    fn set_lang_round_trips_through_atomic() {
        let _g = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for l in [Lang::En, Lang::Ja, Lang::Ko, Lang::ZhCn, Lang::ZhTw] {
            set_lang(l);
            assert_eq!(current(), l, "{}", l.as_code());
        }
    }

    /// 日 / 韓查無譯文時應退到英文，而不是直接露出繁中 —— 故「英文查得到」蘊含「日韓查得到」。
    #[test]
    fn ja_ko_never_show_chinese_for_keys_english_covers() {
        let _g = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        const KEY: &str = "連線池已耗盡或關閉"; // en.rs 收錄
        assert!(crate::locales::en::lookup(KEY).is_some(), "前提：en 表收錄此 key");
        for l in [Lang::Ja, Lang::Ko] {
            set_lang(l);
            assert_ne!(lookup(KEY), KEY, "{} 不該退回繁中原文", l.as_code());
        }
        set_lang(Lang::ZhTw);
    }
}
