//! 語言對照表。目前僅英文（`en`）；zh-TW 為原文，不需表。
//!
//! 對照表以 `&'static str -> &'static str` 的 `match` 實作（見 `en.rs`），
//! 好處是不需維護排序、新增 key 只要補一行、查無回 `None` 交由 `i18n::lookup` 做 identity fallback。

pub mod en;
