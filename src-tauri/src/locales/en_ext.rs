//! 英文對照表的**泛用擴充點**（開源空間）。
//!
//! db-kit 本體不內建任何額外譯文，故一律回 `None`。
//! 下游打包（外掛 / overlay）若帶入自己的私有驅動與字串，可整檔覆蓋本檔並填入對照表 ——
//! 與 `db/external.rs` 的驅動分派 seam 是同一個模式：泛用結構留在上游，具體內容由下游注入。
//!
//! `i18n::lookup` 的查表順序：`en::lookup` → `en_ext::lookup` → identity fallback（回原文）。
//! 因此覆蓋本檔既不會影響上游的 361 條譯文，也不需要在 `en.rs`（500+ 行）上開 patch 錨點。

/// 額外譯文查表。上游無內容，恆回 `None`。
pub fn lookup(_zh: &str) -> Option<&'static str> {
    None
}
