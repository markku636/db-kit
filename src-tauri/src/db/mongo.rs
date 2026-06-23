use futures::stream::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{ClientOptions, FindOptions, IndexOptions};
use mongodb::{Client, IndexModel};
use std::time::Duration;

use crate::db::{
    fmt_bytes, CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, Filter, IndexInfo,
    PagedData, PoolStatus, QueryResult, RowDelete, RowInsert, Sort, SortDir, TableInfo,
};
use crate::error::{AppError, AppResult};

/// 聚合查詢一次最多收集的結果文件數（安全上限，避免未收斂管線把整個集合拉進記憶體）。
const AGG_RESULT_CAP: usize = 5000;

/// MongoDB 驅動。文件型，但盡量沿用 Navicat 表格手感：
/// - list_databases → Mongo 資料庫
/// - list_tables → 集合（kind = "collection"）
/// - table_data → 取一批文件，聯集頂層欄位攤平成表格；巢狀值以 JSON 字串呈現
/// - 主鍵固定為 _id
/// - update_cell / insert_row / delete_row → 以 _id 定位的文件操作
///
/// mongodb crate 的 Client 內建連線池（maxPoolSize），故無需自管池。
pub struct MongoDriver {
    client: Client,
    /// 連線時指定的預設資料庫（list_databases 仍會列全部）。
    default_db: Option<String>,
}

impl MongoDriver {
    fn db_handle(&self, database: &str) -> mongodb::Database {
        self.client.database(database)
    }
}

#[async_trait::async_trait]
impl DatabaseDriver for MongoDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        // 組 mongodb URI。有帳密則帶上。
        let auth = if config.username.is_empty() {
            String::new()
        } else {
            format!("{}:{}@", config.username, config.password)
        };
        let uri = format!(
            "mongodb://{auth}{host}:{port}",
            host = config.host,
            port = config.port,
        );

        let mut opts = ClientOptions::parse(&uri)
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;
        opts.max_pool_size = Some(config.max_connections.max(1));
        opts.connect_timeout = Some(Duration::from_secs(10));
        opts.server_selection_timeout = Some(Duration::from_secs(10));

        let client =
            Client::with_options(opts).map_err(|e| AppError::Connect(e.to_string()))?;

        let driver = Self {
            client,
            default_db: config.database.clone().filter(|d| !d.is_empty()),
        };
        driver.ping().await?;
        Ok(driver)
    }

    async fn ping(&self) -> AppResult<()> {
        // 對 admin 跑 ping 指令。
        self.client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .map(|_| ())
            .map_err(|e| AppError::Connect(e.to_string()))
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let names = self
            .client
            .list_database_names()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        // 若指定了預設庫且不在清單（權限不足列全部時），仍補上。
        let mut out = names;
        if let Some(d) = &self.default_db {
            if !out.contains(d) {
                out.insert(0, d.clone());
            }
        }
        Ok(out)
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let names = self
            .db_handle(database)
            .list_collection_names()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(names
            .into_iter()
            .map(|name| TableInfo {
                name,
                kind: "collection".to_string(),
            })
            .collect())
    }

    async fn table_columns(
        &self,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        // 無固定 schema：抽樣若干文件，推斷頂層欄位與其 BSON 型別。
        let coll = self.db_handle(database).collection::<Document>(table);
        let opts = FindOptions::builder().limit(50).build();
        let mut cursor = coll
            .find(doc! {})
            .with_options(opts)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;

        // 保留首次出現順序
        let mut order: Vec<String> = Vec::new();
        let mut types: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            for (k, v) in &d {
                if !types.contains_key(k) {
                    order.push(k.clone());
                }
                types.insert(k.clone(), bson_type_name(v));
            }
        }

        Ok(order
            .into_iter()
            .map(|name| {
                let is_id = name == "_id";
                ColumnInfo {
                    data_type: types.get(&name).cloned().unwrap_or_default(),
                    key: if is_id { "PRI".to_string() } else { String::new() },
                    nullable: !is_id,
                    default: None,
                    extra: String::new(),
                    comment: String::new(),
                    name,
                }
            })
            .collect())
    }

    async fn table_data(
        &self,
        database: &str,
        table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        let coll = self.db_handle(database).collection::<Document>(table);

        let filter = build_filter(&query.filters, query.match_any);
        let sort = build_sort(&query.sorts);

        // 總數（套用相同 filter）
        let total = coll
            .count_documents(filter.clone())
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;

        let skip = (query.page as u64) * (query.page_size as u64);
        let mut find_opts = FindOptions::builder()
            .skip(skip)
            .limit(query.page_size as i64)
            .build();
        if let Some(s) = sort {
            find_opts.sort = Some(s);
        }

        let mut cursor = coll
            .find(filter)
            .with_options(find_opts)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;

        let mut docs: Vec<Document> = Vec::new();
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            docs.push(d);
        }

        // 聯集頂層欄位為欄；_id 永遠擺第一欄。
        let mut columns: Vec<String> = Vec::new();
        columns.push("_id".to_string());
        for d in &docs {
            for (k, _) in d {
                if k != "_id" && !columns.contains(k) {
                    columns.push(k.clone());
                }
            }
        }

        let rows: Vec<Vec<Option<String>>> = docs
            .iter()
            .map(|d| {
                columns
                    .iter()
                    .map(|col| d.get(col).map(bson_to_string))
                    .collect()
            })
            .collect();

        Ok(PagedData {
            columns,
            rows,
            total_rows: total,
            page: query.page,
            page_size: query.page_size,
            primary_key: vec!["_id".to_string()],
        })
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        // MongoDB 無 SQL。接受 JSON：
        //   find：{"db","collection","filter","sort","projection","limit"}
        //   聚合：{"db","collection","pipeline":[ {..stage..}, … ]}（提供 pipeline 時改走 aggregate）
        // 回傳每列一個 JSON 字串。未指定 limit 時 find 預設 200，避免誤拉整個集合。
        let parsed: serde_json::Value = serde_json::from_str(sql)
            .map_err(|_| AppError::Query(
                "MongoDB 查詢請提供 JSON：{\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}".to_string(),
            ))?;
        let db = parsed.get("db").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Query("缺少 db".to_string()))?;
        let coll_name = parsed.get("collection").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Query("缺少 collection".to_string()))?;

        // 聚合管線（Mongo 旗艦功能）：提供 "pipeline" 陣列時走 aggregate，回傳各階段結果文件。
        if let Some(pv) = parsed.get("pipeline") {
            let arr = pv
                .as_array()
                .ok_or_else(|| AppError::Query("pipeline 必須是陣列".to_string()))?;
            let mut stages: Vec<Document> = Vec::with_capacity(arr.len());
            for v in arr {
                match bson_from_json(v) {
                    Bson::Document(d) => stages.push(d),
                    _ => return Err(AppError::Query("pipeline 每個階段必須是物件".to_string())),
                }
            }
            let coll = self.db_handle(db).collection::<Document>(coll_name);
            let mut cursor = coll
                .aggregate(stages)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            let mut rows = Vec::new();
            while let Some(d) = cursor
                .try_next()
                .await
                .map_err(|e| AppError::Query(e.to_string()))?
            {
                rows.push(vec![Some(serde_json::to_string(&d).unwrap_or_default())]);
                // 安全上限：避免使用者誤下未收斂的管線（如 [{"$match":{}}]）把整個集合拉進記憶體。
                // 與 find 路徑的預設上限呼應；要全部結果請在管線尾端自行加 $limit。
                if rows.len() >= AGG_RESULT_CAP {
                    break;
                }
            }
            return Ok(QueryResult {
                columns: vec!["document".to_string()],
                rows,
                rows_affected: 0,
            });
        }

        // 批次插入（Mongo 的「匯入 JSON」對稱能力）：提供 "insert" 物件陣列時走 insert_many，
        // 回傳插入筆數。可直接在查詢編輯器貼上 {db,collection,insert:[{…},…]} 匯入文件。
        if let Some(iv) = parsed.get("insert") {
            let arr = iv
                .as_array()
                .ok_or_else(|| AppError::Query("insert 必須是陣列".to_string()))?;
            let mut docs: Vec<Document> = Vec::with_capacity(arr.len());
            for v in arr {
                match bson_from_json(v) {
                    Bson::Document(d) => docs.push(d),
                    _ => return Err(AppError::Query("insert 每個元素必須是物件".to_string())),
                }
            }
            if docs.is_empty() {
                return Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: 0 });
            }
            let coll = self.db_handle(db).collection::<Document>(coll_name);
            let res = coll
                .insert_many(docs)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            return Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: res.inserted_ids.len() as u64,
            });
        }

        // 批次更新：{ …, "update": { "filter": {…}, "set": {…} } } → update_many($set)，回傳修改筆數。
        if let Some(uv) = parsed.get("update") {
            let filter = uv
                .get("filter")
                .map(bson_from_json)
                .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                .unwrap_or_default();
            let set = uv
                .get("set")
                .map(bson_from_json)
                .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                .ok_or_else(|| AppError::Query("update 需要 set 物件".to_string()))?;
            if set.is_empty() {
                return Err(AppError::Query("update 的 set 不可為空".to_string()));
            }
            // 與 delete 一致的安全防護：filter 不可為空，避免一個遺漏 filter 就改動整個集合。
            // 真要全集合更新，請以明確條件（如 {"_id": {"$exists": true}}）表達意圖。
            if filter.is_empty() {
                return Err(AppError::Query(
                    "update 需要非空 filter（避免誤改整個集合；要全改請用明確條件如 {\"_id\":{\"$exists\":true}}）"
                        .to_string(),
                ));
            }
            let coll = self.db_handle(db).collection::<Document>(coll_name);
            let res = coll
                .update_many(filter, doc! { "$set": set })
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            return Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: res.modified_count });
        }

        // 批次刪除：{ …, "delete": {…filter…} } → delete_many，回傳刪除筆數。
        // 安全防護：filter 不可為空，避免一個 {} 誤刪整個集合。
        if let Some(dv) = parsed.get("delete") {
            let filter = match bson_from_json(dv) {
                Bson::Document(d) => d,
                _ => return Err(AppError::Query("delete 必須是 filter 物件".to_string())),
            };
            if filter.is_empty() {
                return Err(AppError::Query(
                    "delete 需要非空 filter（避免誤刪整個集合）".to_string(),
                ));
            }
            let coll = self.db_handle(db).collection::<Document>(coll_name);
            let res = coll
                .delete_many(filter)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            return Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: res.deleted_count });
        }

        let filter_doc = match parsed.get("filter") {
            Some(f) => bson_from_json(f),
            None => Bson::Document(Document::new()),
        };
        let filter = match filter_doc {
            Bson::Document(d) => d,
            _ => Document::new(),
        };

        // 可選：sort / projection（document）、limit（數字）。
        let as_doc = |key: &str| -> Option<Document> {
            parsed.get(key).map(bson_from_json).and_then(|b| match b {
                Bson::Document(d) => Some(d),
                _ => None,
            })
        };
        // limit <= 0（含明確的 0，Mongo 視為「不限」）或缺漏皆套用預設 200，避免誤拉整個集合。
        let limit = parsed
            .get("limit")
            .and_then(|v| v.as_i64())
            .filter(|n| *n > 0)
            .unwrap_or(200);
        let mut find_opts = FindOptions::builder().limit(limit).build();
        find_opts.sort = as_doc("sort");
        find_opts.projection = as_doc("projection");

        let coll = self.db_handle(db).collection::<Document>(coll_name);
        let mut cursor = coll
            .find(filter)
            .with_options(find_opts)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let mut rows = Vec::new();
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            let json = serde_json::to_string(&d).unwrap_or_default();
            rows.push(vec![Some(json)]);
        }
        Ok(QueryResult {
            columns: vec!["document".to_string()],
            rows,
            rows_affected: 0,
        })
    }

    async fn update_cell(
        &self,
        database: &str,
        table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64> {
        // 以 _id 定位文件，設定單一欄位。
        let id_value = id_filter(edit)?;
        let coll = self.db_handle(database).collection::<Document>(table);
        // 新值：null 代表設為 BSON null（Mongo 沒有「移除欄位」與「設 null」之別，這裡採設 null）
        let new_bson = match &edit.new_value {
            Some(s) => guess_bson(s),
            None => Bson::Null,
        };
        let mut set_doc = Document::new();
        set_doc.insert(edit.column.clone(), new_bson);
        let res = coll
            .update_one(id_value, doc! { "$set": set_doc })
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(res.modified_count)
    }

    async fn insert_row(
        &self,
        database: &str,
        table: &str,
        row: &RowInsert,
    ) -> AppResult<u64> {
        if row.columns.len() != row.values.len() {
            return Err(AppError::Query("欄位與值數量不符".to_string()));
        }
        let mut d = Document::new();
        for (c, v) in row.columns.iter().zip(row.values.iter()) {
            // _id 留空則由 Mongo 自動產生（不放入文件）
            if c == "_id" && v.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                continue;
            }
            let b = match v {
                Some(s) => guess_bson(s),
                None => Bson::Null,
            };
            d.insert(c.clone(), b);
        }
        let coll = self.db_handle(database).collection::<Document>(table);
        coll.insert_one(d)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(1)
    }

    async fn delete_row(
        &self,
        database: &str,
        table: &str,
        del: &RowDelete,
    ) -> AppResult<u64> {
        // 從 RowDelete 取 _id。
        let idx = del
            .pk_columns
            .iter()
            .position(|c| c == "_id")
            .ok_or_else(|| AppError::Query("缺少 _id，無法刪除".to_string()))?;
        let raw = del.pk_values.get(idx).and_then(|v| v.clone())
            .ok_or_else(|| AppError::Query("_id 為空，無法刪除".to_string()))?;
        let filter = doc! { "_id": id_bson(&raw) };
        let coll = self.db_handle(database).collection::<Document>(table);
        let res = coll
            .delete_one(filter)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(res.deleted_count)
    }

    async fn table_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        let coll = self.db_handle(database).collection::<Document>(table);
        let mut cursor = coll
            .list_indexes()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out = Vec::new();
        while let Some(ix) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            let columns: Vec<String> = ix.keys.keys().map(|k| k.to_string()).collect();
            let name = ix
                .options
                .as_ref()
                .and_then(|o| o.name.clone())
                .unwrap_or_else(|| columns.join("_"));
            let unique = ix.options.as_ref().and_then(|o| o.unique).unwrap_or(false);
            let primary = name == "_id_";
            out.push(IndexInfo { name, columns, unique, primary });
        }
        Ok(out)
    }

    async fn create_index(
        &self,
        database: &str,
        table: &str,
        name: &str,
        columns: &[String],
        unique: bool,
    ) -> AppResult<()> {
        if columns.is_empty() {
            return Err(AppError::Query("索引至少需一個欄位".to_string()));
        }
        // 依點選順序組複合鍵（皆升冪 1）。
        let mut keys = Document::new();
        for c in columns {
            keys.insert(c.clone(), 1_i32);
        }
        let mut opts = IndexOptions::builder().unique(unique).build();
        if !name.trim().is_empty() {
            opts.name = Some(name.to_string());
        }
        let model = IndexModel::builder().keys(keys).options(opts).build();
        self.db_handle(database)
            .collection::<Document>(table)
            .create_index(model)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn drop_index(&self, database: &str, table: &str, index: &str) -> AppResult<()> {
        self.db_handle(database)
            .collection::<Document>(table)
            .drop_index(index)
            .await
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn create_collection(&self, database: &str, name: &str) -> AppResult<()> {
        self.db_handle(database)
            .create_collection(name)
            .await
            .map_err(|e| AppError::Query(e.to_string()))
    }

    /// MongoDB「新增資料庫」：以建立首個集合具現化（Mongo 無空資料庫）。
    async fn create_database(&self, name: &str) -> AppResult<()> {
        // 在新資料庫建立一個預設集合，使其在清單中可見。
        self.client
            .database(name)
            .create_collection("data")
            .await
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn table_info(&self, database: &str, table: &str) -> AppResult<Vec<(String, String)>> {
        let stats = self
            .db_handle(database)
            .run_command(doc! { "collStats": table })
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        // collStats 的數值欄位型別依版本可能為 i32 / i64 / f64，逐一嘗試。
        let num = |k: &str| -> Option<i64> {
            stats
                .get_i64(k)
                .ok()
                .or_else(|| stats.get_i32(k).ok().map(|v| v as i64))
                .or_else(|| stats.get_f64(k).ok().map(|v| v as i64))
        };
        let mut out = Vec::new();
        if let Some(c) = num("count") {
            out.push(("文件數".into(), c.to_string()));
        }
        if let Some(s) = num("size") {
            out.push(("大小".into(), fmt_bytes(s)));
        }
        if let Some(s) = num("storageSize") {
            out.push(("儲存大小".into(), fmt_bytes(s)));
        }
        if let Some(n) = num("nindexes") {
            out.push(("索引數".into(), n.to_string()));
        }
        if let Some(a) = num("avgObjSize") {
            out.push(("平均文件大小".into(), fmt_bytes(a)));
        }
        Ok(out)
    }

    async fn drop_collection(&self, database: &str, name: &str) -> AppResult<()> {
        self.db_handle(database)
            .collection::<Document>(name)
            .drop()
            .await
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn drop_database(&self, name: &str) -> AppResult<()> {
        // 後端硬性護欄：MongoDB 系統庫一律拒絕（drop config 會毀分片中繼資料、drop admin 會清使用者/角色）。
        const SYS: [&str; 3] = ["admin", "config", "local"];
        if SYS.iter().any(|s| s.eq_ignore_ascii_case(name)) {
            return Err(AppError::Query(format!("拒絕刪除 MongoDB 系統資料庫「{name}」")));
        }
        self.client
            .database(name)
            .drop()
            .await
            .map_err(|e| AppError::Query(e.to_string()))
    }

    fn pool_status(&self) -> PoolStatus {
        // mongodb crate 未公開即時池統計，回傳 0（介面相容用）。
        PoolStatus { size: 0, idle: 0, in_use: 0 }
    }

    async fn close(&self) {
        // mongodb Client 於 drop 時自行清理連線；無顯式 close。
    }
}

/// 從 CellEdit 取 _id 組成 filter。
fn id_filter(edit: &CellEdit) -> AppResult<Document> {
    let idx = edit
        .pk_columns
        .iter()
        .position(|c| c == "_id")
        .ok_or_else(|| AppError::Query("缺少 _id，無法定位文件".to_string()))?;
    let raw = edit.pk_values.get(idx).and_then(|v| v.clone())
        .ok_or_else(|| AppError::Query("_id 為空".to_string()))?;
    Ok(doc! { "_id": id_bson(&raw) })
}

/// 將字串 _id 還原成 BSON。ObjectId 字串（24 hex）轉 ObjectId，否則當字串。
fn id_bson(raw: &str) -> Bson {
    if raw.len() == 24 && raw.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(oid) = mongodb::bson::oid::ObjectId::parse_str(raw) {
            return Bson::ObjectId(oid);
        }
    }
    Bson::String(raw.to_string())
}

/// 把使用者輸入的字串猜測成適當 BSON：數字 / bool / 其餘為字串。
fn guess_bson(s: &str) -> Bson {
    // 推斷型別，但避免「悄悄竄改使用者輸入」造成失真：
    // 整數：僅在正規表示完全一致時才當 Int64，否則保留字串——前導零（ZIP「01234」）、
    // 前導 +、或超出 i64 範圍的長數字 ID 都不該被轉成數字（leading zero 會消失 / 大數會掉精度）。
    if let Ok(i) = s.parse::<i64>() {
        return if i.to_string() == s { Bson::Int64(i) } else { Bson::String(s.to_string()) };
    }
    // 浮點：只接受「看起來就是小數 / 科學記號」（含 . e E）的字串，
    // 避免超出 i64 的長整數字串被當 f64 而失去精度（保留為字串）。
    if let Ok(f) = s.parse::<f64>() {
        if f.is_finite() && s.bytes().any(|b| matches!(b, b'.' | b'e' | b'E')) {
            return Bson::Double(f);
        }
        return Bson::String(s.to_string());
    }
    match s {
        "true" => return Bson::Boolean(true),
        "false" => return Bson::Boolean(false),
        _ => {}
    }
    Bson::String(s.to_string())
}

/// BSON 值轉成表格顯示字串。巢狀物件/陣列以精簡 JSON 呈現。
fn bson_to_string(b: &Bson) -> String {
    match b {
        Bson::String(s) => s.clone(),
        Bson::Int32(i) => i.to_string(),
        Bson::Int64(i) => i.to_string(),
        Bson::Double(f) => f.to_string(),
        Bson::Boolean(v) => v.to_string(),
        Bson::ObjectId(o) => o.to_hex(),
        Bson::Null => "null".to_string(),
        Bson::DateTime(dt) => dt.try_to_rfc3339_string().unwrap_or_else(|_| format!("{dt:?}")),
        // Decimal128（金融資料常見）直接顯示十進位字串，避免 fallback 的 {"$numberDecimal":"…"} 雜訊。
        Bson::Decimal128(d) => d.to_string(),
        other => {
            // 物件、陣列等以 JSON 呈現
            serde_json::to_string(other).unwrap_or_else(|_| format!("{other:?}"))
        }
    }
}

fn bson_type_name(b: &Bson) -> String {
    match b {
        Bson::String(_) => "string",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::Double(_) => "double",
        Bson::Boolean(_) => "bool",
        Bson::ObjectId(_) => "objectId",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::DateTime(_) => "date",
        Bson::Null => "null",
        _ => "mixed",
    }
    .to_string()
}

/// 把 DataQuery 的篩選轉成 Mongo filter document。
/// SQL LIKE → 錨定正規表示式：`%` → `.*`、`_` → `.`，其餘字元跳脫為字面，外加 `^…$` 錨定。
/// 錨定是為了符合 LIKE 的「整個字串比對」語意——未錨定的 `$regex` 會退化成「子字串包含」，
/// 使 `LIKE 'abc'`（應為精確相等）與 `LIKE 'abc%'`（應為開頭符合）都變成「含 abc」而失準。
/// 跳脫 regex 特殊字元則避免 `LIKE '%@gmail.com'` 的 `.` 被當成「任意字元」而誤配。
fn like_to_regex(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 2);
    out.push('^');
    for ch in pattern.chars() {
        match ch {
            '%' => out.push_str(".*"),
            '_' => out.push('.'),
            '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('$');
    out
}

/// 支援運算子對應到 Mongo 比較運算子；like → 正規表示式（不分大小寫）。
/// match_any=true 時以 $or 串接（否則合併成單一 doc = AND）。
fn build_filter(filters: &[Filter], match_any: bool) -> Document {
    let mut clauses: Vec<Document> = Vec::new();
    for f in filters {
        let field = f.column.clone();
        let mut d = Document::new();
        match f.op.as_str() {
            "=" => { d.insert(field, value_bson(&f.value)); }
            "!=" => { d.insert(field, doc! { "$ne": value_bson(&f.value) }); }
            ">" => { d.insert(field, doc! { "$gt": value_bson(&f.value) }); }
            ">=" => { d.insert(field, doc! { "$gte": value_bson(&f.value) }); }
            "<" => { d.insert(field, doc! { "$lt": value_bson(&f.value) }); }
            "<=" => { d.insert(field, doc! { "$lte": value_bson(&f.value) }); }
            "like" => {
                d.insert(field, doc! { "$regex": like_to_regex(f.value.as_deref().unwrap_or("")), "$options": "i" });
            }
            "is_null" => { d.insert(field, Bson::Null); }
            "is_not_null" => { d.insert(field, doc! { "$ne": Bson::Null }); }
            _ => {}
        }
        if !d.is_empty() {
            clauses.push(d);
        }
    }
    if clauses.is_empty() {
        Document::new()
    } else if match_any {
        doc! { "$or": clauses.into_iter().map(Bson::Document).collect::<Vec<_>>() }
    } else {
        let mut merged = Document::new();
        for c in clauses {
            for (k, v) in c {
                merged.insert(k, v);
            }
        }
        merged
    }
}

fn value_bson(v: &Option<String>) -> Bson {
    match v {
        Some(s) => guess_bson(s),
        None => Bson::Null,
    }
}

/// 排序轉成 Mongo sort document（1 / -1）。
fn build_sort(sorts: &[Sort]) -> Option<Document> {
    if sorts.is_empty() {
        return None;
    }
    let mut d = Document::new();
    for s in sorts {
        let dir = match s.dir {
            SortDir::Asc => 1,
            SortDir::Desc => -1,
        };
        d.insert(s.column.clone(), dir);
    }
    Some(d)
}

/// 將 serde_json::Value 轉成 BSON（供 query 的 filter 用）。
fn bson_from_json(v: &serde_json::Value) -> Bson {
    match mongodb::bson::to_bson(v) {
        Ok(b) => b,
        Err(_) => Bson::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::{guess_bson, like_to_regex};
    use mongodb::bson::Bson;

    #[test]
    fn guess_bson_preserves_non_canonical_numbers() {
        // 正規整數 → Int64。
        assert_eq!(guess_bson("42"), Bson::Int64(42));
        assert_eq!(guess_bson("-7"), Bson::Int64(-7));
        // 前導零 / 前導 + → 保留字串（避免 ZIP / 代碼失真）。
        assert_eq!(guess_bson("01234"), Bson::String("01234".into()));
        assert_eq!(guess_bson("+42"), Bson::String("+42".into()));
        // 超出 i64 範圍的長數字 ID → 字串（避免 f64 精度流失）。
        assert_eq!(guess_bson("123456789012345678901"), Bson::String("123456789012345678901".into()));
        // 小數 / 科學記號 → Double。
        assert!(matches!(guess_bson("3.14"), Bson::Double(_)));
        assert!(matches!(guess_bson("42.0"), Bson::Double(_)));
        // 布林 / 一般字串維持原樣。
        assert_eq!(guess_bson("true"), Bson::Boolean(true));
        assert_eq!(guess_bson("hello"), Bson::String("hello".into()));
    }

    #[test]
    fn bson_to_string_renders_decimal128_cleanly() {
        use super::bson_to_string;
        use std::str::FromStr;
        let d = mongodb::bson::Decimal128::from_str("9.99").unwrap();
        let s = bson_to_string(&Bson::Decimal128(d));
        assert!(s.contains("9.99"), "Decimal128 應顯示十進位值：{s}");
        assert!(!s.contains("numberDecimal"), "不應出現 extended JSON 雜訊：{s}");
    }

    #[test]
    fn like_to_regex_anchors_translates_and_escapes() {
        // 無萬用字元 → 精確相等（整字串錨定，非子字串包含）。
        assert_eq!(like_to_regex("abc"), "^abc$");
        // % → .*（開頭 / 結尾 / 包含）。
        assert_eq!(like_to_regex("abc%"), "^abc.*$");
        assert_eq!(like_to_regex("%abc%"), "^.*abc.*$");
        // _ → .（單一字元）。
        assert_eq!(like_to_regex("a_c"), "^a.c$");
        // regex 特殊字元跳脫為字面（避免 . 被當任意字元）。
        assert_eq!(like_to_regex("%@gmail.com"), "^.*@gmail\\.com$");
        assert_eq!(like_to_regex("a(b)+"), "^a\\(b\\)\\+$");
    }
}
