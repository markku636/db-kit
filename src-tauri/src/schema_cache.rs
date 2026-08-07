//! 結構快取：把「整庫表名 + 欄名」落地成 JSON，讓 SQL 自動完成開啟即用、離線可用，
//! 並讓使用者看得到「上次更新時間」、能手動刷新。
//!
//! 設計取捨（都有代價，寫下來免得日後回頭改壞）：
//!
//! - **一連線一檔**（`schema-cache/<conn_id>.json`）。全部塞一個檔的話，一次刷新就要重寫
//!   所有連線的內容；PG 一個連線列出三百個 schema 是常態，單檔輕易破十 MB。
//! - **只存欄名**（`TableColumns`），不存 `ColumnInfo`。型別 / 預設值 / 註解對自動完成沒用，
//!   但 `default` 與 `comment` 很可能夾帶實際資料與業務邏輯——落地磁碟的東西越少越好。
//! - **解析失敗一律降級成空快取**，不往上拋。這是快取不是設定檔：寫到一半斷電、手動改壞、
//!   舊版格式，任何一種都只該讓人「少了提示」，不該讓功能整個壞掉。
//! - **compact 序列化**（`write_json_compact_in`）。pretty 縮排對大 schema 要多吃約五成空間，
//!   而且沒人會手讀它。
//! - 全部函式吃 `dir: &Path`、**不碰 tauri**，所以 slim CLI（`--no-default-features`）編得過，
//!   dir 由呼叫端（GUI 走 app_config_dir、CLI 走 headless_config_dir）決定。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::TableColumns;
use crate::error::AppResult;
use crate::store::write_json_compact_in;

/// 快取檔所在的子目錄（相對於設定目錄）。
pub const CACHE_DIR: &str = "schema-cache";

const CACHE_VERSION: u32 = 1;

fn cache_v1() -> u32 {
    1
}

/// 單一資料庫（PG / Oracle 是 schema、MSSQL 是 database）的結構快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CachedDatabase {
    pub database: String,
    /// Unix epoch 毫秒。0 代表「沒有時間資訊」，UI 一律當成過期處理。
    #[serde(default)]
    pub updated_at_ms: i64,
    #[serde(default)]
    pub tables: Vec<TableColumns>,
}

/// 一個連線的整份快取檔。
///
/// 版本欄位沿用 connections.json 的慣例：只做加欄位的演進、欄位一律 `#[serde(default)]`，
/// 讀進來的舊檔不需要 migration；`version` 純資訊性，寫入時一律蓋成當前值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaCacheFile {
    #[serde(default = "cache_v1")]
    pub version: u32,
    #[serde(default)]
    pub conn_id: String,
    #[serde(default)]
    pub databases: Vec<CachedDatabase>,
}

impl Default for SchemaCacheFile {
    fn default() -> Self {
        Self { version: CACHE_VERSION, conn_id: String::new(), databases: Vec::new() }
    }
}

/// 設定頁「結構快取」那一列的整體摘要：路徑（讓人自己去看 / 自己去刪）+ 每個連線的統計。
#[derive(Debug, Clone, Default, Serialize)]
pub struct SchemaCacheSummary {
    pub dir: String,
    pub entries: Vec<SchemaCacheStat>,
}

/// 設定頁「結構快取」那一列要顯示的統計。
#[derive(Debug, Clone, Default, Serialize)]
pub struct SchemaCacheStat {
    pub conn_id: String,
    pub databases: usize,
    pub tables: usize,
    pub bytes: u64,
    /// 該連線所有資料庫中最新的一次更新時間（0 = 無）。
    pub updated_at_ms: i64,
}

/// 把連線 id 轉成安全的檔名。
///
/// 連線 id 實務上是 uuid，但它終究是外部輸入。只放行 `[A-Za-z0-9_-]`，其餘一律換成 `_`——
/// 連 `.` 都不放行：副檔名由我們自己接，句點對 id 沒有意義，禁掉就沒有 `..`、隱藏檔、
/// 或 Windows 上尾端句點被靜默截掉這類邊角要想。空字串回 `_`，避免產生空檔名。
pub fn sanitize_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() {
        "_".to_string()
    } else {
        s
    }
}

fn cache_dir(dir: &Path) -> PathBuf {
    dir.join(CACHE_DIR)
}

fn file_name(conn_id: &str) -> String {
    format!("{}.json", sanitize_id(conn_id))
}

/// 讀取一個連線的快取檔。**任何失敗都回空快取**（見模組說明）。
pub async fn load(dir: &Path, conn_id: &str) -> SchemaCacheFile {
    let path = cache_dir(dir).join(file_name(conn_id));
    match tokio::fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice::<SchemaCacheFile>(&bytes) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[schema_cache] {} 解析失敗，當成無快取：{e}", path.display());
                SchemaCacheFile::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SchemaCacheFile::default(),
        Err(e) => {
            eprintln!("[schema_cache] 讀取 {} 失敗，當成無快取：{e}", path.display());
            SchemaCacheFile::default()
        }
    }
}

/// 取單一資料庫的快取（沒有就 None）。
pub async fn get(dir: &Path, conn_id: &str, database: &str) -> Option<CachedDatabase> {
    load(dir, conn_id)
        .await
        .databases
        .into_iter()
        .find(|d| d.database == database)
}

/// 把一個資料庫的快照併回檔案並原子寫出。
pub async fn put(
    dir: &Path,
    conn_id: &str,
    entry: CachedDatabase,
) -> AppResult<()> {
    let mut file = load(dir, conn_id).await;
    file.version = CACHE_VERSION;
    file.conn_id = conn_id.to_string();
    merge_database(&mut file, entry);
    write_json_compact_in(&cache_dir(dir), &file_name(conn_id), &file).await
}

/// 併入 / 取代單一資料庫的 entry（純函式，供單元測試）。
///
/// 空表清單**不覆蓋**既有的非空快取——刷新失敗或權限不足時常常是「查得到 0 列」，
/// 若照單全收就會把使用者本來好好的提示清空，比舊資料更糟。
pub fn merge_database(file: &mut SchemaCacheFile, entry: CachedDatabase) {
    if let Some(slot) = file.databases.iter_mut().find(|d| d.database == entry.database) {
        if entry.tables.is_empty() && !slot.tables.is_empty() {
            return;
        }
        *slot = entry;
    } else {
        file.databases.push(entry);
    }
}

/// 刪快取：`Some(id)` 刪單一連線、`None` 刪整個目錄。找不到檔案不算錯。
pub async fn clear(dir: &Path, conn_id: Option<&str>) -> AppResult<()> {
    match conn_id {
        Some(id) => {
            let path = cache_dir(dir).join(file_name(id));
            match tokio::fs::remove_file(&path).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => {
                    eprintln!("[schema_cache] 刪除 {} 失敗：{e}", path.display());
                    Ok(())
                }
            }
        }
        None => {
            let path = cache_dir(dir);
            match tokio::fs::remove_dir_all(&path).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => {
                    eprintln!("[schema_cache] 清除 {} 失敗：{e}", path.display());
                    Ok(())
                }
            }
        }
    }
}

/// 掃出所有快取檔的統計（設定頁用）。目錄不存在時 entries 為空，dir 仍照常回傳。
pub async fn summary(dir: &Path) -> SchemaCacheSummary {
    SchemaCacheSummary {
        dir: cache_dir(dir).display().to_string(),
        entries: stats(dir).await,
    }
}

/// 掃出所有快取檔的統計。目錄不存在回空清單。
pub async fn stats(dir: &Path) -> Vec<SchemaCacheStat> {
    let mut out: Vec<SchemaCacheStat> = Vec::new();
    let mut rd = match tokio::fs::read_dir(cache_dir(dir)).await {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    while let Ok(Some(ent)) = rd.next_entry().await {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let bytes = ent.metadata().await.map(|m| m.len()).unwrap_or(0);
        let parsed: SchemaCacheFile = match tokio::fs::read(&path).await {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => continue,
        };
        let conn_id = if parsed.conn_id.is_empty() {
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string()
        } else {
            parsed.conn_id.clone()
        };
        out.push(SchemaCacheStat {
            conn_id,
            databases: parsed.databases.len(),
            tables: parsed.databases.iter().map(|d| d.tables.len()).sum(),
            bytes,
            updated_at_ms: parsed.databases.iter().map(|d| d.updated_at_ms).max().unwrap_or(0),
        });
    }
    out.sort_by(|a, b| a.conn_id.cmp(&b.conn_id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(db: &str, tables: &[(&str, &[&str])], at: i64) -> CachedDatabase {
        CachedDatabase {
            database: db.into(),
            updated_at_ms: at,
            tables: tables
                .iter()
                .map(|(t, cols)| TableColumns {
                    table: (*t).into(),
                    columns: cols.iter().map(|c| (*c).to_string()).collect(),
                })
                .collect(),
        }
    }

    #[test]
    fn sanitize_strips_path_separators_and_dots() {
        assert_eq!(sanitize_id("../../etc/passwd"), "______etc_passwd");
        assert_eq!(sanitize_id("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_id("9f3c-4d1e_ok.v2"), "9f3c-4d1e_ok_v2");
        // 正常的 uuid 原樣通過（絕大多數情況）。
        assert_eq!(
            sanitize_id("3f2504e0-4f89-41d3-9a0c-0305e82c3301"),
            "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        );
    }

    #[test]
    fn sanitize_never_yields_empty_or_dotfile() {
        assert_eq!(sanitize_id(""), "_");
        assert_eq!(sanitize_id("..."), "___");
        assert_eq!(sanitize_id("/"), "_");
        // 結果永遠不含路徑分隔字元或句點。
        for probe in ["..", "a.b", "C:\\x", "../x"] {
            let s = sanitize_id(probe);
            assert!(!s.contains(['/', '\\', '.', ':']), "{probe} -> {s}");
        }
    }

    #[test]
    fn merge_appends_new_database() {
        let mut f = SchemaCacheFile::default();
        merge_database(&mut f, entry("shop", &[("orders", &["id"])], 100));
        assert_eq!(f.databases.len(), 1);
        assert_eq!(f.databases[0].database, "shop");
    }

    #[test]
    fn merge_replaces_same_database_in_place() {
        let mut f = SchemaCacheFile::default();
        merge_database(&mut f, entry("a", &[("t", &["x"])], 1));
        merge_database(&mut f, entry("b", &[("u", &["y"])], 2));
        merge_database(&mut f, entry("a", &[("t", &["x", "z"])], 3));
        assert_eq!(f.databases.len(), 2);
        // 位置不變（不該因為刷新就跳到最後）。
        assert_eq!(f.databases[0].database, "a");
        assert_eq!(f.databases[0].updated_at_ms, 3);
        assert_eq!(f.databases[0].tables[0].columns, vec!["x", "z"]);
    }

    #[test]
    fn merge_refuses_to_blank_existing_entry() {
        // 刷新失敗常表現為「查得到 0 列」；照單全收會清掉本來好好的提示。
        let mut f = SchemaCacheFile::default();
        merge_database(&mut f, entry("a", &[("t", &["x"])], 1));
        merge_database(&mut f, entry("a", &[], 2));
        assert_eq!(f.databases[0].tables.len(), 1);
        assert_eq!(f.databases[0].updated_at_ms, 1);
    }

    #[test]
    fn merge_allows_empty_entry_for_genuinely_empty_database() {
        let mut f = SchemaCacheFile::default();
        merge_database(&mut f, entry("empty", &[], 5));
        assert_eq!(f.databases.len(), 1);
        assert_eq!(f.databases[0].updated_at_ms, 5);
    }

    #[test]
    fn missing_fields_take_serde_defaults() {
        // 舊檔 / 手改檔缺欄位不得整份失效。
        let f: SchemaCacheFile = serde_json::from_str(r#"{"conn_id":"x"}"#).unwrap();
        assert_eq!(f.version, 1);
        assert_eq!(f.conn_id, "x");
        assert!(f.databases.is_empty());
    }

    #[test]
    fn unknown_future_fields_are_ignored() {
        let f: SchemaCacheFile =
            serde_json::from_str(r#"{"version":9,"conn_id":"x","databases":[],"future":true}"#)
                .unwrap();
        assert_eq!(f.version, 9);
    }

    #[test]
    fn file_round_trips_through_json() {
        let mut f = SchemaCacheFile::default();
        f.conn_id = "c1".into();
        merge_database(&mut f, entry("shop", &[("orders", &["id", "total"])], 42));
        let json = serde_json::to_string(&f).unwrap();
        let back: SchemaCacheFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.conn_id, "c1");
        assert_eq!(back.databases[0].tables[0].columns, vec!["id", "total"]);
        assert_eq!(back.databases[0].updated_at_ms, 42);
    }

    #[tokio::test]
    async fn load_returns_default_for_missing_and_corrupt_files() {
        let dir = std::env::temp_dir().join(format!("dbkit_sc_test_{}", std::process::id()));
        let sub = dir.join(CACHE_DIR);
        tokio::fs::create_dir_all(&sub).await.unwrap();

        // 不存在 → 空快取。
        assert!(load(&dir, "nope").await.databases.is_empty());

        // 半截 JSON（模擬寫到一半斷電）→ 空快取，不 panic 不回錯。
        tokio::fs::write(sub.join("broken.json"), b"{\"databases\":[{\"data")
            .await
            .unwrap();
        assert!(load(&dir, "broken").await.databases.is_empty());

        // 寫得進去也讀得回來。
        put(&dir, "c1", entry("shop", &[("orders", &["id"])], 7)).await.unwrap();
        let got = get(&dir, "c1", "shop").await.unwrap();
        assert_eq!(got.tables[0].table, "orders");
        assert_eq!(got.updated_at_ms, 7);

        // 清掉單一連線後就沒了，重複清不算錯。
        clear(&dir, Some("c1")).await.unwrap();
        assert!(get(&dir, "c1", "shop").await.is_none());
        clear(&dir, Some("c1")).await.unwrap();

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
