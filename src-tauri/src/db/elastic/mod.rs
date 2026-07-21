//! Elasticsearch / OpenSearch 驅動（一等公民；以 reqwest REST 接入）。
//!
//! 設計：`DatabaseDriver` 做最小映射讓連線樹 / 資料格可運作
//! （cluster→database、index→table、alias→view、document→row 的合成欄位），
//! ES 專屬能力（叢集健康 / 索引 / 節點 / mapping / 刪索引）走 `commands::es_*` 指令，
//! 由 `manager.elastic_driver(id)` downcast `Active::Elastic` 取得本型別的 inherent 方法。
//!
//! Elasticsearch 與 OpenSearch 的 REST API 高度相容；連線時以 `GET /` 的 `version.distribution`
//! 自動偵測 flavor（OpenSearch 回 "opensearch"；ES 無此欄）。第一版唯讀瀏覽 + DSL 查詢。

mod client;
mod config;
pub mod dto;
mod flatten;

use serde_json::Value;

use client::EsClient;
use dto::{EsClusterHealth, EsIndexInfo, EsNodeInfo};

use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, PagedData, PoolStatus,
    QueryResult, RowDelete, RowInsert, SortDir, TableInfo,
};
use crate::error::{AppError, AppResult};

/// 一個已連線的 Elasticsearch / OpenSearch 端點。
pub struct ElasticDriver {
    client: EsClient,
    /// "elasticsearch" | "opensearch"（connect 時由 `version.distribution` 偵測）。
    flavor: String,
    /// 發行版本號（`version.number`）。
    version: String,
    /// 是否在索引 / 別名清單顯示 `.` 開頭的隱藏項。
    show_hidden: bool,
}

/// `_id` 主鍵（合成，同 table_columns）。
const ID_FIELD: &str = "_id";

impl ElasticDriver {
    /// 叢集健康（`GET /_cluster/health`）；flavor / version 取自連線時偵測值。
    pub async fn cluster_health(&self) -> AppResult<EsClusterHealth> {
        let h = self.client.get_json("/_cluster/health").await?;
        let u32_of = |key: &str| h.get(key).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        Ok(EsClusterHealth {
            cluster_name: h
                .get("cluster_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            status: h.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            flavor: self.flavor.clone(),
            version: self.version.clone(),
            number_of_nodes: u32_of("number_of_nodes"),
            number_of_data_nodes: u32_of("number_of_data_nodes"),
            active_primary_shards: u32_of("active_primary_shards"),
            active_shards: u32_of("active_shards"),
            relocating_shards: u32_of("relocating_shards"),
            unassigned_shards: u32_of("unassigned_shards"),
        })
    }

    /// 索引清單（`GET /_cat/indices`）。
    pub async fn indices(&self) -> AppResult<Vec<EsIndexInfo>> {
        let arr = self
            .client
            .get_json("/_cat/indices?format=json&h=index,health,status,docs.count,docs.deleted,store.size,pri,rep")
            .await?;
        let str_of = |item: &Value, key: &str| {
            item.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
        };
        // _cat 的數值欄位回字串（如 "docs.count": "42"）；容錯解析。
        let u64_of = |item: &Value, key: &str| {
            item.get(key)
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
        };
        let u32_of = |item: &Value, key: &str| {
            item.get(key)
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0)
        };
        let mut out = Vec::new();
        if let Some(items) = arr.as_array() {
            for item in items {
                let index = str_of(item, "index");
                if !self.show_hidden && index.starts_with('.') {
                    continue;
                }
                out.push(EsIndexInfo {
                    index,
                    health: str_of(item, "health"),
                    status: str_of(item, "status"),
                    docs_count: u64_of(item, "docs.count"),
                    docs_deleted: u64_of(item, "docs.deleted"),
                    store_size: str_of(item, "store.size"),
                    pri: u32_of(item, "pri"),
                    rep: u32_of(item, "rep"),
                });
            }
        }
        out.sort_by(|a, b| a.index.cmp(&b.index));
        Ok(out)
    }

    /// 節點清單（`GET /_cat/nodes`）。
    pub async fn nodes(&self) -> AppResult<Vec<EsNodeInfo>> {
        let arr = self
            .client
            .get_json("/_cat/nodes?format=json&h=name,version,node.role,heap.percent,cpu")
            .await?;
        let str_of = |item: &Value, key: &str| {
            item.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
        };
        let mut out = Vec::new();
        if let Some(items) = arr.as_array() {
            for item in items {
                out.push(EsNodeInfo {
                    name: str_of(item, "name"),
                    version: str_of(item, "version"),
                    roles: str_of(item, "node.role"),
                    heap_percent: str_of(item, "heap.percent"),
                    cpu: str_of(item, "cpu"),
                });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// 某索引的 mapping 原文（`GET /{index}/_mapping`，pretty JSON）。
    pub async fn mapping(&self, index: &str) -> AppResult<String> {
        let resp = self.client.get_json(&format!("/{index}/_mapping")).await?;
        serde_json::to_string_pretty(&resp).map_err(|e| AppError::Query(e.to_string()))
    }

    /// 刪除索引（`DELETE /{index}`）。ES 專屬破壞性操作，走專屬指令。
    pub async fn delete_index(&self, index: &str) -> AppResult<()> {
        self.client.delete_json(&format!("/{index}")).await?;
        Ok(())
    }

    /// DSL envelope 執行：頂層必含 `"index"`，`"count": true` → _count；否則 _search。
    /// 回傳 1 或 2 個結果集（search 有 aggregations 時附上第二個 aggs 結果）。
    async fn exec_dsl(&self, sql: &str, cap: usize) -> AppResult<Vec<QueryResult>> {
        let envelope: Value = serde_json::from_str(sql)
            .map_err(|e| AppError::Query(tf!("Elasticsearch 查詢需為 JSON：{e}", e = e)))?;
        let obj = envelope.as_object().ok_or_else(|| {
            AppError::Query(t!("Elasticsearch 查詢請提供含 index 的 JSON 物件").into())
        })?;
        let index = obj
            .get("index")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                AppError::Query(t!("Elasticsearch 查詢請提供含 index 的 JSON 物件").into())
            })?
            .to_string();
        let is_count = obj.get("count").and_then(|v| v.as_bool()).unwrap_or(false);

        // body = 除 "index" / "count" 外的頂層鍵，原樣作 search / count body（鍵序保留）。
        let mut body = serde_json::Map::new();
        for (k, v) in obj {
            if k == "index" || k == "count" {
                continue;
            }
            body.insert(k.clone(), v.clone());
        }

        if is_count {
            let mut cbody = serde_json::Map::new();
            if let Some(q) = body.get("query") {
                cbody.insert("query".to_string(), q.clone());
            }
            let resp = self
                .client
                .post_json(&format!("/{index}/_count"), &Value::Object(cbody))
                .await?;
            let count = resp.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
            return Ok(vec![QueryResult {
                columns: vec!["count".to_string()],
                rows: vec![vec![Some(count.to_string())]],
                rows_affected: 0,
                truncated: false,
            }]);
        }

        // cap 語義：未給 size → size = cap（cap=0 則 200）；給了 size → min(size, cap)（cap=0 不夾）。
        let user_size = body.get("size").and_then(|v| v.as_u64());
        let size = match user_size {
            Some(s) => {
                if cap > 0 {
                    s.min(cap as u64)
                } else {
                    s
                }
            }
            None => {
                if cap > 0 {
                    cap as u64
                } else {
                    200
                }
            }
        };
        body.insert("size".to_string(), Value::from(size));

        let resp = self
            .client
            .post_json(&format!("/{index}/_search"), &Value::Object(body))
            .await?;
        let mut hits = flatten::hits_to_query_result(&resp);
        let total = flatten::hits_total(&resp);
        hits.truncated = total > hits.rows.len() as u64;

        let mut results = vec![hits];
        if let Some(aggs) = resp.get("aggregations") {
            results.push(flatten::aggs_to_query_result(aggs));
        }
        Ok(results)
    }
}

/// 寫入類統一訊息（第一版唯讀）。
fn read_only() -> AppError {
    AppError::Unsupported(
        t!("Elasticsearch 連線第一版為唯讀，不支援直接編輯文件（請以 DSL 查詢瀏覽）").into(),
    )
}

#[async_trait::async_trait]
impl DatabaseDriver for ElasticDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let params = config::build_params(config)?;
        let client = EsClient::new(params)?;
        // GET / 讀 version.number / version.distribution，同時作為健康檢查。
        let root = client.get_json("/").await.map_err(|e| match e {
            AppError::Query(m) => AppError::Connect(m),
            other => other,
        })?;
        let version = root
            .pointer("/version/number")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let distribution = root
            .pointer("/version/distribution")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let flavor = if distribution.eq_ignore_ascii_case("opensearch") {
            "opensearch"
        } else {
            "elasticsearch"
        }
        .to_string();
        Ok(ElasticDriver {
            client,
            flavor,
            version,
            show_hidden: config::show_hidden(config),
        })
    }

    async fn ping(&self) -> AppResult<()> {
        self.client.get_json("/_cluster/health?timeout=5s").await.map(|_| ())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        // ES 無資料庫層級；回單一合成 cluster 節點供連線樹展開（同 Kafka）。
        Ok(vec!["cluster".to_string()])
    }

    async fn list_tables(&self, _database: &str) -> AppResult<Vec<TableInfo>> {
        let mut tables: Vec<TableInfo> = Vec::new();
        // Data View 分組去重集合：同一 ILM/data-stream 名稱的多筆每日 backing index 只留一筆節點。
        let mut data_views: std::collections::HashSet<String> = std::collections::HashSet::new();
        // 索引 → table（或併入 Data View 分組，見 flatten::ds_backing_group）。
        let indices = self
            .client
            .get_json("/_cat/indices?format=json&h=index,health,status,docs.count")
            .await?;
        if let Some(items) = indices.as_array() {
            for item in items {
                if let Some(name) = item.get("index").and_then(|v| v.as_str()) {
                    if !self.show_hidden && name.starts_with('.') {
                        continue;
                    }
                    match flatten::ds_backing_group(name) {
                        Some(group) => {
                            data_views.insert(group);
                        }
                        None => tables.push(TableInfo {
                            name: name.to_string(),
                            kind: "table".to_string(),
                        }),
                    }
                }
            }
        }
        for group in data_views {
            tables.push(TableInfo {
                name: group,
                kind: "data_view".to_string(),
            });
        }
        tables.sort_by(|a, b| a.name.cmp(&b.name));

        // 別名 → view。
        let mut views: Vec<TableInfo> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        if let Ok(aliases) = self.client.get_json("/_cat/aliases?format=json").await {
            if let Some(items) = aliases.as_array() {
                for item in items {
                    if let Some(name) = item.get("alias").and_then(|v| v.as_str()) {
                        if name == "-" {
                            continue;
                        }
                        if !self.show_hidden && name.starts_with('.') {
                            continue;
                        }
                        if seen.insert(name.to_string()) {
                            views.push(TableInfo {
                                name: name.to_string(),
                                kind: "view".to_string(),
                            });
                        }
                    }
                }
            }
        }
        views.sort_by(|a, b| a.name.cmp(&b.name));
        tables.extend(views);
        Ok(tables)
    }

    async fn table_columns(&self, _database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let resp = self.client.get_json(&format!("/{table}/_mapping")).await?;
        Ok(flatten::mapping_to_columns(&resp))
    }

    async fn table_data(
        &self,
        _database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        let page = query.page;
        let size = if query.page_size > 0 { query.page_size } else { 100 };
        let from = (page as u64) * (size as u64);
        // ES 預設 from + size 上限 max_result_window = 10000；深度分頁需 search_after（走 DSL）。
        if from + (size as u64) > 10000 {
            return Err(AppError::Query(
                t!("Elasticsearch 深度分頁超過 max_result_window（10000）；請改用 DSL 查詢（search_after）或縮小頁數")
                    .into(),
            ));
        }

        let mut body = serde_json::Map::new();
        body.insert("from".to_string(), Value::from(from));
        body.insert("size".to_string(), Value::from(size));
        body.insert(
            "query".to_string(),
            flatten::filters_to_query(&query.filters, query.match_any),
        );
        if !query.sorts.is_empty() {
            let sorts: Vec<Value> = query
                .sorts
                .iter()
                .map(|s| {
                    let dir = match s.dir {
                        SortDir::Asc => "asc",
                        SortDir::Desc => "desc",
                    };
                    let mut order = serde_json::Map::new();
                    order.insert("order".to_string(), Value::String(dir.to_string()));
                    let mut sm = serde_json::Map::new();
                    sm.insert(s.column.clone(), Value::Object(order));
                    Value::Object(sm)
                })
                .collect();
            body.insert("sort".to_string(), Value::Array(sorts));
        }

        let resp = self
            .client
            .post_json(&format!("/{table}/_search"), &Value::Object(body))
            .await?;
        let qr = flatten::hits_to_query_result(&resp);
        let total = flatten::hits_total(&resp);
        Ok(PagedData {
            columns: qr.columns,
            rows: qr.rows,
            total_rows: total,
            page,
            page_size: size,
            primary_key: vec![ID_FIELD.to_string()],
            row_ids: vec![],
        })
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        self.query_capped(sql, 0).await
    }

    async fn query_capped(&self, sql: &str, cap: usize) -> AppResult<QueryResult> {
        let mut results = self.exec_dsl(sql, cap).await?;
        Ok(results.remove(0)) // exec_dsl 不變量：至少 1 個結果集。
    }

    async fn query_multi_capped(&self, sql: &str, cap: usize) -> AppResult<Vec<QueryResult>> {
        self.exec_dsl(sql, cap).await
    }

    async fn document_get(&self, _database: &str, table: &str, id: &str) -> AppResult<String> {
        let resp = self
            .client
            .get_json_opt(&format!("/{table}/_doc/{id}"))
            .await?
            .ok_or_else(|| AppError::Query(tf!("文件不存在：{id}", id = id)))?;
        let source = resp.get("_source").cloned().unwrap_or(Value::Null);
        serde_json::to_string_pretty(&source).map_err(|e| AppError::Query(e.to_string()))
    }

    async fn update_cell(
        &self,
        _database: &str,
        _table: &str,
        _edit: &CellEdit,
    ) -> AppResult<u64> {
        Err(read_only())
    }

    async fn insert_row(&self, _database: &str, _table: &str, _row: &RowInsert) -> AppResult<u64> {
        Err(read_only())
    }

    async fn delete_row(&self, _database: &str, _table: &str, _del: &RowDelete) -> AppResult<u64> {
        Err(read_only())
    }

    fn pool_status(&self) -> PoolStatus {
        PoolStatus {
            size: 1,
            idle: 0,
            in_use: 1,
        }
    }

    async fn close(&self) {
        // reqwest Client 於 Drop 時自行收尾；無連線池要 drain。
    }
}
