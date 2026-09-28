//! 內建資源庫：repo 根目錄的 `ai-library/` 由 build.rs 逐檔 `include_str!` 進二進位。
//! 隨 App 升級、唯讀；使用者要改就「複製為自訂」到個人層或團隊資料夾。

include!(concat!(env!("OUT_DIR"), "/ai_builtin.rs"));
