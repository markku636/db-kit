//! 韓文對照表的**泛用擴充點**（開源空間）。與 `en_ext.rs` 同一個模式，見該檔說明。
//!
//! `i18n::lookup` 在 `Lang::Ko` 的查表順序：`ko::lookup` → `ko_ext::lookup` → 英文（次選語言）→ 原文。

/// 額外譯文查表。上游無內容，恆回 `None`。
pub fn lookup(_zh: &str) -> Option<&'static str> {
    None
}
