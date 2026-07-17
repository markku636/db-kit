//! Elasticsearch / OpenSearch 指令的 serde DTO（前端 <-> 後端）。純資料型別。
//! 整個 `db::elastic` 模組於 `elastic` feature 開啟時才編入。
//!
//! 欄位一律 snake_case（serde 專案預設，不加 rename）——前端 TS interface 照這些名字對。

use serde::Serialize;

/// 叢集健康總覽（叢集面板）。`flavor` / `version` 於 connect 時偵測並存於 driver。
#[derive(Debug, Clone, Serialize)]
pub struct EsClusterHealth {
    pub cluster_name: String,
    /// "green" | "yellow" | "red"
    pub status: String,
    /// "elasticsearch" | "opensearch"
    pub flavor: String,
    /// 發行版本號（version.number）。
    pub version: String,
    pub number_of_nodes: u32,
    pub number_of_data_nodes: u32,
    pub active_primary_shards: u32,
    pub active_shards: u32,
    pub relocating_shards: u32,
    pub unassigned_shards: u32,
}

/// 索引基本資訊（索引清單）。對應 `_cat/indices`。
#[derive(Debug, Clone, Serialize)]
pub struct EsIndexInfo {
    pub index: String,
    /// "green" | "yellow" | "red"
    pub health: String,
    /// "open" | "close"
    pub status: String,
    pub docs_count: u64,
    pub docs_deleted: u64,
    /// 人類可讀的儲存大小（如 "1.2mb"；直接沿用 _cat 的字串）。
    pub store_size: String,
    /// 主分片數。
    pub pri: u32,
    /// 每主分片的複本數。
    pub rep: u32,
}

/// 節點資訊（節點清單）。對應 `_cat/nodes`。
#[derive(Debug, Clone, Serialize)]
pub struct EsNodeInfo {
    pub name: String,
    pub version: String,
    /// 節點角色（如 "dim" / "data,ingest,master"；沿用 _cat 的字串）。
    pub roles: String,
    /// heap 使用百分比（字串，沿用 _cat）。
    pub heap_percent: String,
    /// CPU 使用百分比（字串，沿用 _cat）。
    pub cpu: String,
}
