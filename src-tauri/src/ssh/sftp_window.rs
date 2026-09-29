//! SFTP 獨立視窗的視窗標籤與網址（純字串處理，不碰 Tauri，方便單元測試）。
//!
//! 一個終端機分頁最多一個 SFTP 視窗：標籤由分頁鍵推出來，再按一次就把同一個視窗叫到最前面。
//! 視窗載入 `sftp.html?tab=<分頁鍵>`，前端靠這個參數認出自己屬於哪個分頁。

/// SFTP 視窗標籤的前綴（capabilities/sftp-window.json 的 `sftp-*` 對的就是它）。
pub const LABEL_PREFIX: &str = "sftp-";

/// 分頁鍵 → 視窗標籤。Tauri 的標籤只收英數與 `-` `/` `:` `_`，其餘字元換成 `_`。
pub fn label_for(tab_key: &str) -> String {
    let body: String = tab_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("{LABEL_PREFIX}{body}")
}

/// 這個視窗是不是 SFTP 獨立視窗。
pub fn is_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// 視窗要載入的頁面（相對於前端根目錄）。
pub fn url_for(tab_key: &str) -> String {
    format!("sftp.html?tab={}", percent_encode(tab_key))
}

/// 查詢字串用的百分比編碼：只留 RFC 3986 的 unreserved 字元。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_stable_and_tauri_safe() {
        let key = "__ssh__:0f8c2d4e-9a1b-4c3d-8e7f-123456789abc";
        let label = label_for(key);
        assert_eq!(label, "sftp-__ssh___0f8c2d4e-9a1b-4c3d-8e7f-123456789abc");
        assert_eq!(label, label_for(key), "同一個分頁永遠是同一個視窗");
        assert!(label.chars().all(|c| c.is_ascii_alphanumeric() || "-_".contains(c)));
        assert!(is_label(&label));
        assert!(!is_label("main"));
        assert_eq!(label_for("a b/中"), "sftp-a_b__", "空白、斜線與非 ASCII 都換掉");
    }

    #[test]
    fn url_encodes_the_tab_key() {
        assert_eq!(url_for("__ssh__:ab-1"), "sftp.html?tab=__ssh__%3Aab-1");
        assert_eq!(url_for("a&b=c d"), "sftp.html?tab=a%26b%3Dc%20d");
        assert_eq!(url_for("中"), "sftp.html?tab=%E4%B8%AD");
    }
}
