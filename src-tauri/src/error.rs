use serde::Serialize;

/// 統一錯誤型別。對前端序列化成 `{ kind, code, message }`（additive；舊程式讀 `message` / `kind` 不破）。
///
/// `#[error(...)]` 屬性一律為中性英文，僅供 `Display` / Debug / log —— thiserror 屬性在編譯期展開，
/// 無法呼叫 `t!()`。使用者可見的 `message` 於序列化時以 `tf!` 依當前語言即時產生（見 `Serialize`）。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("connection not found: {0}")]
    NotFound(String),

    #[error("connection failed: {0}")]
    Connect(String),

    #[error("query failed: {0}")]
    Query(String),

    #[error("unsupported database kind: {0}")]
    #[allow(dead_code)]
    Unsupported(String),

    #[error("pool exhausted or closed")]
    #[allow(dead_code)] // 保留：連線池耗盡 / 關閉時的錯誤類型（與 Unsupported 同為預留變體）
    PoolUnavailable,

    #[error("storage error: {0}")]
    Storage(String),

    #[error("ssh tunnel error: {0}")]
    Ssh(String),

    /// 查詢超過全域逾時（毫秒）。注意：伺服器端查詢可能仍在執行，
    /// 前端錯誤文案應引導使用者以行程清單（ProcessList）手動 KILL。
    #[error("query timed out after {0} ms")]
    Timeout(u64),
}

impl AppError {
    /// 錯誤大類（snake_case）。維持與舊版序列化相同的值，前端 switch 不破。
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "not_found",
            AppError::Connect(_) => "connect",
            AppError::Query(_) => "query",
            AppError::Unsupported(_) => "unsupported",
            AppError::PoolUnavailable => "pool_unavailable",
            AppError::Storage(_) => "storage",
            AppError::Ssh(_) => "ssh",
            AppError::Timeout(_) => "timeout",
        }
    }

    /// 穩定的機器可讀錯誤碼（與語言無關；供前端分支 / 遙測用）。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "ERR_NOT_FOUND",
            AppError::Connect(_) => "ERR_CONNECT",
            AppError::Query(_) => "ERR_QUERY",
            AppError::Unsupported(_) => "ERR_UNSUPPORTED",
            AppError::PoolUnavailable => "ERR_POOL_UNAVAILABLE",
            AppError::Storage(_) => "ERR_STORAGE",
            AppError::Ssh(_) => "ERR_SSH",
            AppError::Timeout(_) => "ERR_TIMEOUT",
        }
    }

    /// 使用者可見訊息，依當前語言即時產生。內層 detail（`{0}`）多為 call site 已本地化的字串
    /// 或原生驅動錯誤，此處僅做外層包裝與插值。
    pub fn message(&self) -> String {
        match self {
            AppError::NotFound(s) => tf!("找不到連線：{detail}", detail = s),
            AppError::Connect(s) => tf!("連線失敗：{detail}", detail = s),
            AppError::Query(s) => tf!("查詢失敗：{detail}", detail = s),
            AppError::Unsupported(s) => tf!("不支援的資料庫種類：{detail}", detail = s),
            AppError::PoolUnavailable => t!("連線池已耗盡或關閉").to_string(),
            AppError::Storage(s) => tf!("儲存錯誤：{detail}", detail = s),
            AppError::Ssh(s) => tf!("SSH 通道錯誤：{detail}", detail = s),
            AppError::Timeout(ms) => tf!(
                "查詢逾時（{ms} ms）；伺服器端查詢可能仍在執行，可從行程清單手動終止",
                ms = ms
            ),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.message())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
