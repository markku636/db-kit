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
}

impl Lang {
    /// 對前端 / 設定檔用的語言碼（與 `src/i18n.ts` 的 `Lang` 型別一致）。
    pub fn as_code(self) -> &'static str {
        match self {
            Lang::ZhTw => "zh-TW",
            Lang::En => "en",
        }
    }

    /// 由語言碼解析（大小寫不敏感；未知回 `None`）。
    pub fn from_code(s: &str) -> Option<Lang> {
        match s.trim().to_ascii_lowercase().as_str() {
            "zh-tw" | "zh" | "zh-hant" | "zh_tw" => Some(Lang::ZhTw),
            "en" | "en-us" | "en_us" | "en-gb" => Some(Lang::En),
            _ => None,
        }
    }
}

// 0 = ZhTw、1 = En。以 `Lang as u8` 對應，載入時反查。
static LANG: AtomicU8 = AtomicU8::new(0);

/// 設定進程語言（GUI command / CLI 啟動時呼叫）。
pub fn set_lang(l: Lang) {
    LANG.store(l as u8, Ordering::Relaxed);
}

/// 目前進程語言。
pub fn current() -> Lang {
    match LANG.load(Ordering::Relaxed) {
        1 => Lang::En,
        _ => Lang::ZhTw,
    }
}

/// 查表：`En` 時查譯文，查無回原字面值（identity fallback）；`ZhTw` 直接回原文。
pub fn lookup(zh: &'static str) -> &'static str {
    match current() {
        Lang::ZhTw => zh,
        Lang::En => crate::locales::en::lookup(zh).unwrap_or(zh),
    }
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
        set_lang(Lang::ZhTw);
        assert_eq!(lookup("完全沒有收錄的字串 xyz"), "完全沒有收錄的字串 xyz");
    }

    #[test]
    fn lang_code_roundtrip() {
        assert_eq!(Lang::from_code("EN"), Some(Lang::En));
        assert_eq!(Lang::from_code("zh-TW"), Some(Lang::ZhTw));
        assert_eq!(Lang::from_code("fr"), None);
        assert_eq!(Lang::En.as_code(), "en");
    }
}
