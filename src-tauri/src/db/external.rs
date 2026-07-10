//! 外部 gateway 驅動分派層（泛用擴充點）。
//!
//! `DbKind::External` 連線（非真實 DB，而是 HTTP gateway）在此依 `options["driver"]`
//! 分派到對應實作，包成 `Arc<dyn DatabaseDriver>` 交給 `manager::Active::Dyn`。
//!
//! 此檔（db-kit 本體）**不內建任何具體外部驅動**，故一律回 Unsupported——這是「開源空間」：
//! 泛用的 External 機制留在這裡，具體（可能私有）的驅動由外掛 / overlay 覆寫本檔接入
//! （例如新增 `"mydriver" => super::mydriver::MyDriver::connect(...)` 一條 arm）。

use std::sync::Arc;

use crate::db::{ConnectionConfig, DatabaseDriver};
use crate::error::{AppError, AppResult};

/// 依 `options["driver"]` 建立外部驅動。本體不含具體驅動 → 回 Unsupported。
pub async fn connect_external(config: &ConnectionConfig) -> AppResult<Arc<dyn DatabaseDriver>> {
    let driver = config.options.get("driver").map(|s| s.as_str()).unwrap_or("");
    let _ = &driver; // 具體驅動由 overlay 覆寫此函式時使用
    match driver {
        "" => Err(AppError::Connect(
            t!("External 連線未指定 options.driver").into(),
        )),
        other => Err(AppError::Unsupported(tf!(
            "此 build 未編入外部驅動「{other}」",
            other = other
        ))),
    }
}
