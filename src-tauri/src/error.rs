use serde::Serialize;

/// 統一錯誤型別。對前端一律序列化成 { kind, message }。
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
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let kind = match self {
            AppError::NotFound(_) => "not_found",
            AppError::Connect(_) => "connect",
            AppError::Query(_) => "query",
            AppError::Unsupported(_) => "unsupported",
            AppError::PoolUnavailable => "pool_unavailable",
            AppError::Storage(_) => "storage",
            AppError::Ssh(_) => "ssh",
        };
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
