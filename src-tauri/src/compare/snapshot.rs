//! 結構快照檔：把 `DbSchema` 存成 JSON、之後載回與即時結構（或另一份快照）比對。
//!
//! 與 `schema_cache` 的「壞檔 → 空快取、永不失敗」刻意相反：快照是使用者指定的**輸入**，
//! 壞檔若被當成空結構，會報成「全部資料表皆需刪除」並產出一整串 DROP TABLE——必須大聲失敗。
//! 用 pretty JSON（`store::write_json_in`）：快照是給人 diff / 進版控的檔，不是機器快取。

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::schema::DbSchema;
use crate::error::{AppError, AppResult};
use crate::store;

pub const SNAPSHOT_VERSION: u32 = 1;

fn v1() -> u32 {
    SNAPSHOT_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotFile {
    #[serde(default = "v1")]
    pub version: u32,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub created_at_ms: i64,
    pub schema: DbSchema,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotInfo {
    pub path: String,
    pub bytes: u64,
    pub tables: usize,
    pub views: usize,
    pub routines: usize,
    pub captured_at_ms: i64,
}

fn split(path: &Path) -> AppResult<(&Path, &str)> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let file = path
        .file_name()
        .and_then(|f| f.to_str())
        .ok_or_else(|| AppError::Storage(t!("快照路徑無效").into()))?;
    Ok((parent, file))
}

pub async fn save(path: &Path, schema: &DbSchema) -> AppResult<SnapshotInfo> {
    let (dir, file) = split(path)?;
    if !dir.exists() {
        return Err(AppError::Storage(tf!("目錄不存在：{dir}", dir = dir.display())));
    }
    let f = SnapshotFile {
        version: SNAPSHOT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at_ms: schema.captured_at_ms,
        schema: schema.clone(),
    };
    store::write_json_in(dir, file, &f).await?;
    let bytes = tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0);
    Ok(SnapshotInfo {
        path: path.display().to_string(),
        bytes,
        tables: schema.tables.len(),
        views: schema.views.len(),
        routines: schema.routines.len(),
        captured_at_ms: schema.captured_at_ms,
    })
}

pub async fn load(path: &Path) -> AppResult<SnapshotFile> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| AppError::Storage(tf!("讀取快照失敗：{err}", err = e)))?;
    let f: SnapshotFile = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Storage(tf!("快照格式錯誤：{err}", err = e)))?;
    if f.version > SNAPSHOT_VERSION {
        return Err(AppError::Storage(tf!(
            "快照版本 {v} 高於本程式支援的 {max}，請更新 db-kit",
            v = f.version,
            max = SNAPSHOT_VERSION
        )));
    }
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbKind;

    fn sample() -> DbSchema {
        DbSchema {
            kind: DbKind::Sqlite,
            database: "main".into(),
            captured_at_ms: 123,
            label: "x".into(),
            tables: vec![],
            views: vec![],
            routines: vec![],
            warnings: vec![],
        }
    }

    #[tokio::test]
    async fn round_trip_and_strict_load() {
        let dir = std::env::temp_dir().join(format!("dbkit-snap-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let p = dir.join("a.json");
        let info = save(&p, &sample()).await.unwrap();
        assert!(info.bytes > 0);
        let f = load(&p).await.unwrap();
        assert_eq!(f.version, SNAPSHOT_VERSION);
        assert_eq!(f.schema.database, "main");

        // 壞檔 → Err（不是空結構）。
        tokio::fs::write(&p, b"{ not json").await.unwrap();
        assert!(load(&p).await.is_err());
        // 未來版本 → Err。
        tokio::fs::write(&p, format!(r#"{{"version":{},"schema":{}}}"#, SNAPSHOT_VERSION + 1, serde_json::to_string(&sample()).unwrap()))
            .await
            .unwrap();
        assert!(load(&p).await.is_err());
        // 不存在 → Err。
        assert!(load(&dir.join("missing.json")).await.is_err());
        // 目錄不存在 → save Err。
        assert!(save(&dir.join("no").join("b.json"), &sample()).await.is_err());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
