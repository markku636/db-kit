//! 審查並執行（review & run）：SQL 腳本執行前的 AI 審查素材、逐句前後像、回滾腳本與輸出目錄。

// slim CLI build 只用到部分路徑；GUI build 仍正常檢查 dead_code。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

pub mod analyze;
pub mod capture;
pub mod codec;
#[cfg(test)]
mod it_sqlite;
#[cfg(test)]
mod it_server;
pub mod names;
pub mod plan;
pub mod report;
pub mod rollback;
pub mod run;
pub mod scan;
