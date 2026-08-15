//! 語言對照表。zh-TW 為原文，不需表；其餘每語一個模組（`en` / `ja` / `ko` / `zh_cn`）。
//!
//! 對照表以 `&'static str -> &'static str` 的 `match` 實作（見 `en.rs`），
//! 好處是不需維護排序、新增 key 只要補一行、查無回 `None` 交由 `i18n::lookup` 做 identity fallback。
//!
//! 每語另有一個 `_ext` 模組（如 `en_ext.rs`）：下游打包注入私有譯文的擴充點，上游恆回 `None`。

pub mod en;
pub mod en_ext;
pub mod ja;
pub mod ja_ext;
pub mod ko;
pub mod ko_ext;
pub mod zh_cn;
pub mod zh_cn_ext;
