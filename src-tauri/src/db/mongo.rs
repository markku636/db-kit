use futures::stream::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime as BsonDateTime, Decimal128, Document};
use mongodb::options::{AggregateOptions, ClientOptions, FindOptions, IndexOptions, UpdateOptions};
use mongodb::{Client, IndexModel};
use std::time::Duration;

use crate::db::{
    finalize_hits, fmt_bytes, CellEdit, ColumnInfo, ColumnStats, ConnectionConfig, DataQuery, DatabaseDriver, Filter,
    IndexInfo, PagedData, PoolStatus, QueryResult, RowDelete, RowInsert, SearchHit, SearchOptions,
    ServerInfoSection, Sort, SortDir, TableInfo,
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

    /// 集合改名走 admin 的 renameCollection（Mongo 沒有一般 UPDATE 可改集合名）。
    pub async fn rename_collection(&self, database: &str, from: &str, to: &str) -> AppResult<()> {
        let (from, to) = (from.trim(), to.trim());
        if from.is_empty() || to.is_empty() || from == to {
            return Err(AppError::Query(t!("請輸入與原名稱不同的新集合名稱").to_string()));
        }
        let cmd = doc! {
            "renameCollection": format!("{database}.{from}"),
            "to": format!("{database}.{to}"),
        };
        let _: Document = self.client.database("admin").run_command(cmd).await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl DatabaseDriver for MongoDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        // 組 mongodb URI（支援 SRV / authSource / TLS / replicaSet / directConnection，見 build_mongo_uri）。
        let uri = build_mongo_uri(config);

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

        // 保留首次出現順序；混合型別欄位取抽樣中「最多數」的型別，
        // 不要被最後一筆文件的型別誤導（同一欄 3 個數字 + 1 個字串應顯示數字）。
        let mut order: Vec<String> = Vec::new();
        let mut types: std::collections::HashMap<String, std::collections::HashMap<String, usize>> =
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
                *types.entry(k.clone()).or_default().entry(bson_type_name(v)).or_default() += 1;
            }
        }
        // 空集合也要有 _id 欄，讓使用者能直接插入第一筆文件。
        if !order.iter().any(|x| x == "_id") { order.insert(0, "_id".to_string()); }

        Ok(order
            .into_iter()
            .map(|name| {
                let is_id = name == "_id";
                let dominant = types.get(&name)
                    // 同數時用型別名字當第二次排序鍵，避免 HashMap 迭代順序讓頁面每次刷新都換型別。
                    .and_then(|m| m.iter().max_by(|(ta, na), (tb, nb)| {
                        na.cmp(nb).then_with(|| tb.cmp(ta))
                    }))
                    .map(|(t, _)| t.clone())
                    .unwrap_or_default();
                ColumnInfo {
                    data_type: dominant,
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

        // 總數：純翻頁時前端傳 count=false 直接略過（沿用前次快取）；
        // 空 filter 用 estimated_document_count（O(1) 讀 metadata，不全掃）；
        // 有 filter 才 count_documents，並加 max_time 上限避免大表全掃卡死。
        let total = if !query.count {
            0
        } else if filter.is_empty() {
            coll.estimated_document_count()
                .await
                .map_err(|e| AppError::Query(e.to_string()))?
        } else {
            coll.count_documents(filter.clone())
                .max_time(Duration::from_secs(5))
                .await
                .map_err(|e| AppError::Query(e.to_string()))?
        };

        let skip = (query.page as u64) * (query.page_size as u64);
        let mut find_opts = FindOptions::builder()
            .skip(skip)
            .limit(query.page_size as i64)
            .max_time(Duration::from_secs(20))
            .build();
        if let Some(s) = sort {
            find_opts.sort = Some(s);
        }

        // 欄位聯集不能只看目前頁：否則每翻頁欄位都在變，多頁匯出的表頭更是只取自第 0 頁，
        // 後面才出現的欄位會被靜默丟掉。額外抽樣前 100 筆文件穩定欄位集合。
        let col_opts = FindOptions::builder()
            .limit(100)
            .max_time(Duration::from_secs(5))
            .build();
        let mut col_cursor = coll
            .find(filter.clone())
            .with_options(col_opts)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let mut sampled_docs: Vec<Document> = Vec::new();
        while let Some(d) = col_cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            sampled_docs.push(d);
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
        for d in sampled_docs.iter().chain(docs.iter()) {
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
                    .map(|col| d.get(col).map(cell_display))
                    .collect()
            })
            .collect();

        // 每列 _id 的 canonical extended JSON，供前端精確定位（非 ObjectId/String 型別也不失真）。
        let row_ids: Vec<String> = docs
            .iter()
            .map(|d| {
                d.get("_id")
                    .map(|id| id.clone().into_canonical_extjson().to_string())
                    .unwrap_or_default()
            })
            .collect();

        Ok(PagedData {
            columns,
            rows,
            total_rows: total,
        truncated: false,
            page: query.page,
            page_size: query.page_size,
            primary_key: vec!["_id".to_string()],
            row_ids,
        })
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        self.query_capped(sql, 0).await
    }

    async fn query_capped(&self, sql: &str, cap: usize) -> AppResult<QueryResult> {
        // MongoDB 無 SQL。接受 JSON：
        //   find：{"db","collection","filter","sort","projection","limit"}
        //   聚合：{"db","collection","pipeline":[ {..stage..}, … ]}（提供 pipeline 時改走 aggregate）
        // 回傳每列一個 JSON 字串。未指定 limit 時 find 預設 200，避免誤拉整個集合。
        // cap（0 = 不限）為全域 row cap：cursor 分批拉取，達 cap 即停 — 截斷真省網路。
        let parsed: serde_json::Value = serde_json::from_str(sql)
            .map_err(|_| AppError::Query(
                t!("MongoDB 查詢請提供 JSON：{\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}").to_string(),
            ))?;
        let db = parsed.get("db").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Query(t!("缺少 db").to_string()))?;
        let coll_name = parsed.get("collection").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Query(t!("缺少 collection").to_string()))?;

        // 聚合管線（Mongo 旗艦功能）：提供 "pipeline" 陣列時走 aggregate，回傳各階段結果文件。
        if let Some(pv) = parsed.get("pipeline") {
            let arr = pv
                .as_array()
                .ok_or_else(|| AppError::Query(t!("pipeline 必須是陣列").to_string()))?;
            let mut stages: Vec<Document> = Vec::with_capacity(arr.len());
            for v in arr {
                match bson_from_json(v) {
                    Bson::Document(d) => stages.push(d),
                    _ => return Err(AppError::Query(t!("pipeline 每個階段必須是物件").to_string())),
                }
            }
            let coll = self.db_handle(db).collection::<Document>(coll_name);
            let mut agg = coll.aggregate(stages);
            // DB 端第一層查詢逾時（maxTimeMS；0 = 不設）。外層另有 tokio 兜底。
            let tms = crate::db::limits::timeout_ms();
            if tms > 0 {
                agg = agg.max_time(Duration::from_millis(tms));
            }
            let mut cursor = agg
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            // 安全上限：避免使用者誤下未收斂的管線（如 [{"$match":{}}]）把整個集合拉進記憶體。
            // 全域 row cap 與固定 AGG 上限取小者；要全部結果請在管線尾端自行加 $limit（並調高 cap）。
            let eff_cap = if cap > 0 { cap.min(AGG_RESULT_CAP) } else { AGG_RESULT_CAP };
            let mut rows = Vec::new();
            let mut truncated = false;
            while let Some(d) = cursor
                .try_next()
                .await
                .map_err(|e| AppError::Query(e.to_string()))?
            {
                if rows.len() >= eff_cap {
                    truncated = true;
                    break;
                }
                // 用 canonical extended JSON：一般 serde 序列化會把 Int64 變成 JSON number，
                // 前端 JSON.parse 可能掉精度，且文件匯出就再也還原不回 BSON 型別。
                rows.push(vec![Some(Bson::Document(d).into_canonical_extjson().to_string())]);
            }
            return Ok(QueryResult {
                columns: vec!["document".to_string()],
                rows,
                rows_affected: 0,
                truncated,
            });
        }

        // 批次插入（Mongo 的「匯入 JSON」對稱能力）：提供 "insert" 物件陣列時走 insert_many，
        // 回傳插入筆數。可直接在查詢編輯器貼上 {db,collection,insert:[{…},…]} 匯入文件。
        if let Some(iv) = parsed.get("insert") {
            let arr = iv
                .as_array()
                .ok_or_else(|| AppError::Query(t!("insert 必須是陣列").to_string()))?;
            let mut docs: Vec<Document> = Vec::with_capacity(arr.len());
            for v in arr {
                match bson_from_json(v) {
                    Bson::Document(d) => docs.push(d),
                    _ => return Err(AppError::Query(t!("insert 每個元素必須是物件").to_string())),
                }
            }
            if docs.is_empty() {
                return Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: 0, truncated: false });
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
                truncated: false,
            });
        }

        // 批次更新：
        //   舊寫法 { "update": { "filter": {…}, "set": {…} } } → update_many($set)
        //   新寫法 { "update": { "filter": {…}, "update": {"$set":…,"$unset":…,"$inc":…}, "upsert":true, "multi":false } }
        // 只允許白名單更新運算子，避免 $where 等在 UI 裡被誤用。
        if let Some(uv) = parsed.get("update") {
            let spec = uv.as_object().ok_or_else(|| AppError::Query(t!("update 必須是物件").to_string()))?;
            let filter = spec
                .get("filter")
                .map(bson_from_json)
                .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                .unwrap_or_default();
            let update = if let Some(u) = spec.get("update") {
                match bson_from_json(u) {
                    Bson::Document(d) => d,
                    _ => return Err(AppError::Query(t!("update.update 必須是物件").to_string())),
                }
            } else {
                let set = spec
                    .get("set")
                    .map(bson_from_json)
                    .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                    .ok_or_else(|| AppError::Query(t!("update 需要 set 或 update 物件").to_string()))?;
                doc! { "$set": set }
            };
            const ALLOWED: &[&str] = &["$set", "$unset", "$inc", "$mul", "$min", "$max", "$rename",
                "$push", "$pull", "$addToSet", "$pop", "$setOnInsert", "$currentDate"];
            if update.is_empty() {
                return Err(AppError::Query(t!("update 的內容不可為空").to_string()));
            }
            for (k, _) in &update {
                if !ALLOWED.contains(&k.as_str()) {
                    return Err(AppError::Query(tf!("不允許的更新運算子：{op}", op = k)));
                }
            }
            // 與 delete 一致的安全防護：filter 不可為空。
            if filter.is_empty() {
                return Err(AppError::Query(
                    t!("update 需要非空 filter（避免誤改整個集合；要全改請用明確條件如 {\"_id\":{\"$exists\":true}}）")
                        .to_string(),
                ));
            }
            let upsert = spec.get("upsert").and_then(|v| v.as_bool()).unwrap_or(false);
            let multi = spec.get("multi").and_then(|v| v.as_bool()).unwrap_or(true);
            let opts = UpdateOptions::builder().upsert(upsert).build();
            let coll = self.db_handle(db).collection::<Document>(coll_name);
            let res = if multi {
                coll.update_many(filter, update).with_options(opts).await
            } else {
                coll.update_one(filter, update).with_options(opts).await
            }
            .map_err(|e| AppError::Query(e.to_string()))?;
            return Ok(QueryResult {
                columns: vec![], rows: vec![],
                rows_affected: res.modified_count + if res.upserted_id.is_some() { 1 } else { 0 },
                truncated: false,
            });
        }

        // 批次刪除：{ …, "delete": {…filter…} } → delete_many，回傳刪除筆數。
        // 安全防護：filter 不可為空，避免一個 {} 誤刪整個集合。
        if let Some(dv) = parsed.get("delete") {
            let filter = match bson_from_json(dv) {
                Bson::Document(d) => d,
                _ => return Err(AppError::Query(t!("delete 必須是 filter 物件").to_string())),
            };
            if filter.is_empty() {
                return Err(AppError::Query(
                    t!("delete 需要非空 filter（避免誤刪整個集合）").to_string(),
                ));
            }
            let coll = self.db_handle(db).collection::<Document>(coll_name);
            let res = coll
                .delete_many(filter)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            return Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: res.deleted_count, truncated: false });
        }

        let filter_doc = match parsed.get("filter") {
            Some(f) => bson_from_json(f),
            None => Bson::Document(Document::new()),
        };
        let filter = match filter_doc {
            Bson::Document(d) => d,
            // 像 {"$oid":…} 這種 extJSON 會被解成非 Document；沉默轉成空 filter
            // 等於把整個集合撈出來。明確報錯，讓使用者修正條件。
            _ => return Err(AppError::Query(t!("filter 必須是文件物件").to_string())),
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
        // 全域 row cap（0 = 不限）：伺服器端 limit 收斂到 cap+1（多取 1 列以探測截斷）。
        let eff_limit = if cap > 0 && limit > cap as i64 { cap as i64 + 1 } else { limit };
        let mut find_opts = FindOptions::builder().limit(eff_limit).build();
        // skip 讓查詢結果也能分頁（不必靠表格的游標）。
        find_opts.skip = parsed.get("skip").and_then(|v| v.as_u64());
        find_opts.sort = Some(effective_sort(as_doc("sort")));
        find_opts.projection = as_doc("projection");
        // DB 端第一層查詢逾時（maxTimeMS；0 = 不設）。外層另有 tokio 兜底。
        let tms = crate::db::limits::timeout_ms();
        if tms > 0 {
            find_opts.max_time = Some(Duration::from_millis(tms));
        }

        let coll = self.db_handle(db).collection::<Document>(coll_name);
        let mut cursor = coll
            .find(filter)
            .with_options(find_opts)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let mut rows = Vec::new();
        let mut truncated = false;
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            if cap > 0 && rows.len() >= cap {
                truncated = true;
                break;
            }
            // 與聚合分支一致用 canonical extJSON：一般 serde 會把 Int64 變成 JSON number，
            // JavaScript JSON.parse 會掉精度，文件匯出就再也還原不回原值。
            rows.push(vec![Some(Bson::Document(d).into_canonical_extjson().to_string())]);
        }
        Ok(QueryResult {
            columns: vec!["document".to_string()],
            rows,
            rows_affected: 0,
            truncated,
        })
    }

    async fn update_cell(
        &self,
        database: &str,
        table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64> {
        // 防護：前端表格對 >4KB 的值只顯示截斷預覽，若這段文字被當新值寫回，
        // 原值尾巴會永久消失。明確拒絕，並提示改用整份文件編輯器。
        if edit.new_value.as_deref().is_some_and(|s| cell_truncated_marker(s)) {
            return Err(AppError::Query(t!("此值為截斷預覽，不能寫回；請用整份文件編輯器修改").to_string()));
        }
        // 以 _id 定位文件，設定單一欄位。
        let id_value = id_filter(edit)?;
        let coll = self.db_handle(database).collection::<Document>(table);
        // 新值：null 代表設為 BSON null（Mongo 沒有「移除欄位」與「設 null」之別，這裡採設 null）
        let new_bson = match &edit.new_value {
            None => Bson::Null,
            Some(s) => {
                // 新值本身是 {…} / […] → 一律還原成 Document/Array（含全新欄位）。
                if let Some(b) = coerce_nested_bson(s)? {
                    b
                } else {
                    // 取原文件判斷該欄原型別：若原為 Document/Array，新值需為合法 JSON 並以 extended JSON
                    // 還原成 BSON，避免把巢狀結構存成純字串而破壞文件；純量欄位沿用 guess_bson。
                    let orig = coll
                        .find_one(id_value.clone())
                        .await
                        .map_err(|e| AppError::Query(e.to_string()))?;
                    let original = orig.as_ref().and_then(|d| d.get(&edit.column));
                    if matches!(original, Some(Bson::Document(_)) | Some(Bson::Array(_))) {
                        let v: serde_json::Value = serde_json::from_str(s.trim()).map_err(|e| {
                            AppError::Query(tf!("此欄為巢狀結構，需輸入合法 JSON：{e}", e = e))
                        })?;
                        Bson::try_from(v)
                            .map_err(|e| AppError::Query(tf!("JSON 轉 BSON 失敗：{e}", e = e)))?
                    } else {
                        coerce_bson_edit(original, s)?
                    }
                }
            }
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
            return Err(AppError::Query(t!("欄位與值數量不符").to_string()));
        }
        let mut d = Document::new();
        for (c, v) in row.columns.iter().zip(row.values.iter()) {
            // _id 留空則由 Mongo 自動產生（不放入文件）
            if c == "_id" && v.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                continue;
            }
            let b = match v {
                Some(s) => {
                    // 與 update_cell 一致：截斷預覽不能被當成完整新值存進去。
                    if cell_truncated_marker(s) {
                        return Err(AppError::Query(t!("此值為截斷預覽，不能寫回；請用整份文件編輯器修改").to_string()));
                    }
                    // 「以此列為範本新增」會把巢狀欄位帶成 {"a":…} 字串；
                    // 若不還原成 BSON，新文件的 schema 會被改成純字串。
                    coerce_nested_bson(s)?.unwrap_or_else(|| guess_bson(s))
                }
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
            .ok_or_else(|| AppError::Query(t!("缺少 _id，無法刪除").to_string()))?;
        let raw = del.pk_values.get(idx).and_then(|v| v.clone())
            .ok_or_else(|| AppError::Query(t!("_id 為空，無法刪除").to_string()))?;
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
            return Err(AppError::Query(t!("索引至少需一個欄位").to_string()));
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
            out.push((t!("文件數").into(), c.to_string()));
        }
        if let Some(s) = num("size") {
            out.push((t!("大小").into(), fmt_bytes(s)));
        }
        if let Some(s) = num("storageSize") {
            out.push((t!("儲存大小").into(), fmt_bytes(s)));
        }
        if let Some(n) = num("nindexes") {
            out.push((t!("索引數").into(), n.to_string()));
        }
        if let Some(a) = num("avgObjSize") {
            out.push((t!("平均文件大小").into(), fmt_bytes(a)));
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
            return Err(AppError::Query(tf!("拒絕刪除 MongoDB 系統資料庫「{name}」", name = name)));
        }
        self.client
            .database(name)
            .drop()
            .await
            .map_err(|e| AppError::Query(e.to_string()))
    }

    async fn search_objects(&self, opts: &SearchOptions) -> AppResult<Vec<SearchHit>> {
        // MongoDB 無 SQL 物件；僅以名稱比對集合（object_type=collection）。
        if opts.term.is_empty() || !opts.match_names || !opts.wants_type("collection") {
            return Ok(vec![]);
        }
        const SYS: [&str; 3] = ["admin", "config", "local"];
        let dbs: Vec<String> = match &opts.databases {
            Some(list) if !list.is_empty() => list.clone(),
            _ => self
                .client
                .list_database_names()
                .await
                .map_err(|e| AppError::Query(e.to_string()))?
                .into_iter()
                .filter(|d| !SYS.iter().any(|s| s.eq_ignore_ascii_case(d)))
                .collect(),
        };
        let mut hits = Vec::new();
        for db in dbs {
            let names = match self.db_handle(&db).list_collection_names().await {
                Ok(n) => n,
                Err(_) => continue,
            };
            for name in names {
                if opts.hit(&name) {
                    hits.push(SearchHit {
                        database: db.clone(),
                        object_type: "collection".into(),
                        object_name: name,
                        parent: None,
                        matched_in: "name".into(),
                        snippet: None,
                        extra: None,
                    });
                }
            }
        }
        Ok(finalize_hits(hits, opts))
    }

    async fn document_get(&self, database: &str, table: &str, id: &str) -> AppResult<String> {
        let coll = self.db_handle(database).collection::<Document>(table);
        let doc = coll
            .find_one(doc! { "_id": id_bson(id) })
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
            .ok_or_else(|| AppError::Query(t!("找不到文件").to_string()))?;
        // canonical extended JSON（保真 ObjectId/Int64/Date/Decimal128），美化輸出供編輯。
        let ext = Bson::Document(doc).into_canonical_extjson();
        serde_json::to_string_pretty(&ext).map_err(|e| AppError::Query(e.to_string()))
    }

    async fn document_replace(
        &self,
        database: &str,
        table: &str,
        id: &str,
        doc_json: &str,
    ) -> AppResult<u64> {
        let coll = self.db_handle(database).collection::<Document>(table);
        let v: serde_json::Value = serde_json::from_str(doc_json)
            .map_err(|e| AppError::Query(tf!("文件需為合法 JSON：{e}", e = e)))?;
        let bson = Bson::try_from(v)
            .map_err(|e| AppError::Query(tf!("JSON 轉 BSON 失敗：{e}", e = e)))?;
        let mut new_doc = match bson {
            Bson::Document(d) => d,
            _ => return Err(AppError::Query(t!("文件必須是 JSON 物件").to_string())),
        };
        // _id 不可變更：強制與定位鍵一致，避免改動 _id 造成新增而非取代。
        let id_val = id_bson(id);
        new_doc.insert("_id", id_val.clone());
        let res = coll
            .replace_one(doc! { "_id": id_val }, new_doc)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(res.modified_count)
    }

    /// 執行計畫：輸入與 query() 相同的 JSON DSL（find 或 pipeline），包成 explain 指令送出。
    /// 回傳 relaxed extended JSON 單格（前端 mongoExplain.ts 解析成 stage 樹；解析失敗可原樣顯示）。
    /// 注意：verbosity=executionStats / allPlansExecution 會「實際執行」查詢，昂貴管線請用 queryPlanner。
    async fn explain(&self, sql: &str) -> AppResult<QueryResult> {
        let parsed: serde_json::Value = serde_json::from_str(sql).map_err(|_| {
            AppError::Query(
                t!("MongoDB 執行計畫請提供與查詢相同的 JSON：{\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}（可加 \"verbosity\"）").to_string(),
            )
        })?;
        let (db, cmd) = build_explain_command(&parsed)?;
        let reply = self
            .db_handle(&db)
            .run_command(cmd)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        // relaxed（而非 canonical）extJSON：數字維持 JSON number，前端解析 / 人眼閱讀都直觀。
        let ext = Bson::Document(reply).into_relaxed_extjson();
        let json = serde_json::to_string(&ext).map_err(|e| AppError::Query(e.to_string()))?;
        Ok(QueryResult {
            columns: vec!["explain".to_string()],
            rows: vec![vec![Some(json)]],
            rows_affected: 0,
            truncated: false,
        })
    }

    /// 欄位統計（Mongo 版）：單趟 $facet 聚合算 缺欄 / null / 型別分布 / Top-10 / 相異值估計 / 範圍。
    /// 大集合（估計 > 20k 文件）先 $sample 抽樣，避免全掃卡住；sampled 欄位回報抽樣數供 UI 標註。
    /// 欄名含 `.` 會被聚合視為巢狀路徑（Mongo 語意即如此），屬預期行為。
    async fn column_stats(
        &self,
        database: &str,
        table: &str,
        column: &str,
    ) -> AppResult<ColumnStats> {
        const SAMPLE_CAP: u64 = 20_000;
        const DISTINCT_CAP: i64 = 1001; // 相異值計數上限：達 1001 表示「≥ 1001」（distinct_capped）
        let coll = self.db_handle(database).collection::<Document>(table);
        let est = coll.estimated_document_count().await.unwrap_or(0);
        let use_sample = est > SAMPLE_CAP;

        let field = column.to_string();
        let fref = format!("${field}");
        let exists = doc! { &field: { "$exists": true } };
        let non_null = doc! { "$and": [ { &field: { "$exists": true } }, { &field: { "$not": { "$type": "null" } } } ] };

        let mut pipeline: Vec<Document> = Vec::new();
        if use_sample {
            pipeline.push(doc! { "$sample": { "size": SAMPLE_CAP as i64 } });
        }
        pipeline.push(doc! { "$facet": {
            "total":    [ { "$count": "n" } ],
            "missing":  [ { "$match": { &field: { "$exists": false } } }, { "$count": "n" } ],
            "nulls":    [ { "$match": { &field: { "$type": "null" } } }, { "$count": "n" } ],
            "types":    [ { "$match": &exists },
                          { "$group": { "_id": { "$type": &fref }, "n": { "$sum": 1 } } },
                          { "$sort": { "n": -1 } } ],
            "top":      [ { "$match": &non_null },
                          { "$group": { "_id": &fref, "n": { "$sum": 1 } } },
                          { "$sort": { "n": -1 } }, { "$limit": 10 } ],
            "distinct": [ { "$match": &exists },
                          { "$group": { "_id": &fref } }, { "$limit": DISTINCT_CAP }, { "$count": "n" } ],
            "range":    [ { "$match": &non_null },
                          { "$group": { "_id": Bson::Null, "min": { "$min": &fref }, "max": { "$max": &fref } } } ],
        }});

        let opts = AggregateOptions::builder()
            .allow_disk_use(true)
            .max_time(Duration::from_secs(15))
            .build();
        let mut cursor = coll
            .aggregate(pipeline)
            .with_options(opts)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let facets = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
            .ok_or_else(|| AppError::Query(t!("欄位統計無結果").to_string()))?;

        // $facet 各結果為文件陣列；count 型 facet 取首件的 n。
        let facet_count = |name: &str| -> u64 {
            facets
                .get_array(name)
                .ok()
                .and_then(|a| a.first())
                .and_then(|b| b.as_document())
                .and_then(|d| doc_num(d, "n"))
                .unwrap_or(0) as u64
        };
        let scanned = facet_count("total");
        let missing = facet_count("missing");
        let null_count = facet_count("nulls");
        let distinct_raw = facet_count("distinct");
        let distinct_capped = distinct_raw >= DISTINCT_CAP as u64;

        // (值, 次數) 清單型 facet（types / top）：_id 為分組鍵。
        let pairs = |name: &str| -> Vec<(String, u64)> {
            facets
                .get_array(name)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| b.as_document())
                        .map(|d| {
                            let key = d.get("_id").map(cell_display).unwrap_or_default();
                            let n = doc_num(d, "n").unwrap_or(0) as u64;
                            (key, n)
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let types = pairs("types");
        let top_values = pairs("top");

        // 範圍（min/max 依 BSON 型別排序；混型欄位跨型別比較可能看似奇怪，UI 有註記）。
        let (min, max) = facets
            .get_array("range")
            .ok()
            .and_then(|a| a.first())
            .and_then(|b| b.as_document())
            .map(|d| (d.get("min").map(cell_display), d.get("max").map(cell_display)))
            .unwrap_or((None, None));

        Ok(ColumnStats {
            // 抽樣時 total 回集合估計數（統計本身基於抽樣）；全量時即掃描數。
            total: if use_sample { est } else { scanned },
            non_null: scanned.saturating_sub(missing).saturating_sub(null_count),
            distinct: distinct_raw,
            min,
            max,
            missing,
            null_count,
            types,
            top_values,
            distinct_capped,
            sampled: if use_sample { scanned } else { 0 },
        })
    }

    /// 伺服器狀態：serverStatus + buildInfo → 分區 (標籤, 值) 清單（比照 Redis INFO 的呈現）。
    /// 需要 serverStatus 權限；受限帳號（部分 Atlas 角色）會收到權限錯誤原樣呈現。
    async fn server_info(&self) -> AppResult<Vec<ServerInfoSection>> {
        let admin = self.client.database("admin");
        let status = admin
            .run_command(doc! { "serverStatus": 1 })
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        // buildInfo 失敗不阻斷（版本欄留空即可）。
        let build = admin
            .run_command(doc! { "buildInfo": 1 })
            .await
            .unwrap_or_default();
        Ok(server_status_sections(&status, &build))
    }

    fn pool_status(&self) -> PoolStatus {
        // mongodb crate 未公開即時池統計，回傳 0（介面相容用）；
        // 實際連線壓力見 server_info 的「連線」區（serverStatus.connections）。
        PoolStatus { size: 0, idle: 0, in_use: 0 }
    }

    async fn close(&self) {
        // mongodb Client 於 drop 時自行清理連線；無顯式 close。
    }
}

// ---- Mongo 專屬操作（監控 / 進階索引 / validation）----
// 經 manager.mongo_driver() 由 mongo_* 專屬命令直接呼叫（Redis 模式），不擴充 DatabaseDriver trait。
impl MongoDriver {
    /// $indexStats：各索引自統計起（mongod 重啟即重置）的存取次數。
    /// view 上會失敗、需 indexStats 權限——錯誤原樣回傳，前端降級顯示。
    pub async fn index_stats(&self, database: &str, collection: &str) -> AppResult<Vec<crate::db::MongoIndexStat>> {
        let coll = self.db_handle(database).collection::<Document>(collection);
        let mut cursor = coll
            .aggregate(vec![doc! { "$indexStats": {} }])
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out = Vec::new();
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            let accesses = d.get_document("accesses").ok();
            out.push(crate::db::MongoIndexStat {
                name: d.get_str("name").unwrap_or_default().to_string(),
                ops: accesses.and_then(|a| doc_num(a, "ops")).unwrap_or(0).max(0) as u64,
                since: accesses
                    .and_then(|a| a.get_datetime("since").ok())
                    .and_then(|dt| dt.try_to_rfc3339_string().ok())
                    .unwrap_or_default(),
                host: d.get_str("host").unwrap_or_default().to_string(),
            });
        }
        Ok(out)
    }

    /// 進階索引建立：keys 為 (欄位, 規格) 有序清單（"1"/"-1"/"text"/"2dsphere"/"hashed"），
    /// options 含 unique / sparse / hidden / TTL / partialFilterExpression。
    pub async fn create_index_advanced(
        &self,
        database: &str,
        collection: &str,
        name: &str,
        keys: &[(String, String)],
        options: &crate::db::MongoIndexOptions,
    ) -> AppResult<()> {
        if keys.is_empty() {
            return Err(AppError::Query(t!("索引至少需一個欄位").to_string()));
        }
        let mut key_doc = Document::new();
        for (field, spec) in keys {
            // key_doc.insert 會覆蓋同欄先前的值：使用者以為建立複合索引，實際上只有一個欄位。
            if key_doc.contains_key(field) {
                return Err(AppError::Query(tf!("索引欄位「{field}」重複", field = field)));
            }
            let v: Bson = match spec.trim() {
                "1" | "" => Bson::Int32(1),
                "-1" => Bson::Int32(-1),
                other @ ("text" | "2dsphere" | "hashed") => Bson::String(other.to_string()),
                other => return Err(AppError::Query(tf!("索引規格無效：{other}（可用 1 / -1 / text / 2dsphere / hashed）", other = other))),
            };
            key_doc.insert(field.clone(), v);
        }
        let mut opts = IndexOptions::builder()
            .unique(options.unique)
            .sparse(options.sparse)
            .build();
        if options.hidden {
            opts.hidden = Some(true); // 4.4+；舊版由伺服器回錯
        }
        if !name.trim().is_empty() {
            opts.name = Some(name.trim().to_string());
        }
        if let Some(secs) = options.expire_after_secs {
            opts.expire_after = Some(Duration::from_secs(secs));
        }
        if let Some(pf) = options.partial_filter_json.as_deref().filter(|s| !s.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(pf)
                .map_err(|e| AppError::Query(tf!("partialFilterExpression 需為合法 JSON：{e}", e = e)))?;
            match bson_from_json(&v) {
                Bson::Document(d) if !d.is_empty() => opts.partial_filter_expression = Some(d),
                _ => return Err(AppError::Query(t!("partialFilterExpression 必須是非空 JSON 物件").to_string())),
            }
        }
        let model = IndexModel::builder().keys(key_doc).options(opts).build();
        self.db_handle(database)
            .collection::<Document>(collection)
            .create_index(model)
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    /// 讀取集合驗證規則（listCollections options 的 validator / validationLevel / validationAction）。
    pub async fn get_validation(&self, database: &str, collection: &str) -> AppResult<crate::db::MongoValidation> {
        let reply = self
            .db_handle(database)
            .run_command(doc! { "listCollections": 1, "filter": { "name": collection } })
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let options = doc_path(&reply, &["cursor"])
            .and_then(|b| b.as_document())
            .and_then(|c| c.get_array("firstBatch").ok())
            .and_then(|a| a.first())
            .and_then(|b| b.as_document())
            .and_then(|d| d.get_document("options").ok());
        let validator_json = options
            .and_then(|o| o.get_document("validator").ok())
            .filter(|v| !v.is_empty())
            .map(|v| {
                let ext = Bson::Document(v.clone()).into_canonical_extjson();
                serde_json::to_string_pretty(&ext).unwrap_or_default()
            })
            .unwrap_or_default();
        Ok(crate::db::MongoValidation {
            validator_json,
            level: options
                .and_then(|o| o.get_str("validationLevel").ok())
                .unwrap_or("strict")
                .to_string(),
            action: options
                .and_then(|o| o.get_str("validationAction").ok())
                .unwrap_or("error")
                .to_string(),
        })
    }

    /// 設定集合驗證規則（collMod）。validator_json 空字串＝清除規則（設為空物件）。
    pub async fn set_validation(
        &self,
        database: &str,
        collection: &str,
        validator_json: &str,
        level: &str,
        action: &str,
    ) -> AppResult<()> {
        // 系統集合硬擋（比照 drop_database 的 SYS 護欄精神）。
        if collection.starts_with("system.") {
            return Err(AppError::Query(t!("拒絕修改系統集合的驗證規則").to_string()));
        }
        if !matches!(level, "off" | "moderate" | "strict") {
            return Err(AppError::Query(tf!("validationLevel 無效：{level}", level = level)));
        }
        if !matches!(action, "warn" | "error") {
            return Err(AppError::Query(tf!("validationAction 無效：{action}", action = action)));
        }
        let validator: Document = if validator_json.trim().is_empty() {
            Document::new()
        } else {
            let v: serde_json::Value = serde_json::from_str(validator_json)
                .map_err(|e| AppError::Query(tf!("validator 需為合法 JSON：{e}", e = e)))?;
            match bson_from_json(&v) {
                Bson::Document(d) => d,
                _ => return Err(AppError::Query(t!("validator 必須是 JSON 物件").to_string())),
            }
        };
        self.db_handle(database)
            .run_command(doc! {
                "collMod": collection,
                "validator": validator,
                "validationLevel": level,
                "validationAction": action,
            })
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    /// dbStats：資料庫層級統計（與 table_info 的 collStats 對稱）。
    pub async fn db_stats(&self, database: &str) -> AppResult<Vec<(String, String)>> {
        let stats = self
            .db_handle(database)
            .run_command(doc! { "dbStats": 1 })
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let num = |k: &str| doc_num(&stats, k);
        let mut out: Vec<(String, String)> = Vec::new();
        if let Some(v) = num("collections") {
            out.push((t!("集合數").into(), v.to_string()));
        }
        if let Some(v) = num("objects") {
            out.push((t!("文件數").into(), v.to_string()));
        }
        if let Some(v) = num("avgObjSize") {
            out.push((t!("平均文件大小").into(), fmt_bytes(v)));
        }
        if let Some(v) = num("dataSize") {
            out.push((t!("資料大小").into(), fmt_bytes(v)));
        }
        if let Some(v) = num("storageSize") {
            out.push((t!("儲存大小").into(), fmt_bytes(v)));
        }
        if let Some(v) = num("indexes") {
            out.push((t!("索引數").into(), v.to_string()));
        }
        if let Some(v) = num("indexSize") {
            out.push((t!("索引大小").into(), fmt_bytes(v)));
        }
        Ok(out)
    }

    /// 進行中操作：admin 上跑 $currentOp（排除閒置連線）。
    /// allUsers:true 需 inprog 權限；被拒時降級為「僅自己的操作」再試一次。
    pub async fn current_ops(&self) -> AppResult<Vec<crate::db::MongoOp>> {
        let admin = self.client.database("admin");
        let run = |all_users: bool| {
            let admin = admin.clone();
            async move {
                admin
                    .aggregate(vec![doc! { "$currentOp": { "allUsers": all_users, "idleConnections": false } }])
                    .await
            }
        };
        let mut cursor = match run(true).await {
            Ok(c) => c,
            Err(_) => run(false)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?,
        };
        let mut out = Vec::new();
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            // opid：單機為數字、sharded 為 "shard:123" 字串 → 統一字串。
            let opid = match d.get("opid") {
                Some(Bson::Int32(n)) => n.to_string(),
                Some(Bson::Int64(n)) => n.to_string(),
                Some(Bson::String(s)) => s.clone(),
                _ => String::new(),
            };
            out.push(crate::db::MongoOp {
                opid,
                op: d.get_str("op").unwrap_or_default().to_string(),
                ns: d.get_str("ns").unwrap_or_default().to_string(),
                secs_running: doc_num(&d, "secs_running").unwrap_or(0),
                client: d.get_str("client").unwrap_or_default().to_string(),
                desc: d.get_str("desc").unwrap_or_default().to_string(),
                command_json: d
                    .get_document("command")
                    .map(|c| cell_display(&Bson::Document(c.clone())))
                    .unwrap_or_default(),
                active: d.get_bool("active").unwrap_or(false),
                waiting_for_lock: d.get_bool("waitingForLock").unwrap_or(false),
            });
        }
        Ok(out)
    }

    /// 終止操作（killOp）。opid 可為數字或 sharded 字串。
    pub async fn kill_op(&self, opid: &str) -> AppResult<()> {
        let op: Bson = match opid.parse::<i64>() {
            Ok(n) if i32::try_from(n).is_ok() => Bson::Int32(n as i32),
            Ok(n) => Bson::Int64(n),
            Err(_) => Bson::String(opid.to_string()),
        };
        self.client
            .database("admin")
            .run_command(doc! { "killOp": 1, "op": op })
            .await
            .map(|_| ())
            .map_err(|e| AppError::Query(e.to_string()))
    }

    /// 讀取 Profiler 設定（profile: -1）。
    pub async fn profile_get(&self, database: &str) -> AppResult<crate::db::MongoProfile> {
        let d = self
            .db_handle(database)
            .run_command(doc! { "profile": -1 })
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(crate::db::MongoProfile {
            level: doc_num(&d, "was").unwrap_or(0) as i32,
            slow_ms: doc_num(&d, "slowms").unwrap_or(100),
        })
    }

    /// 設定 Profiler（level 0-2 + slowms），回傳設定後的實際值。
    /// mongos 不支援 per-database profiling —— 錯誤原樣呈現。
    pub async fn profile_set(&self, database: &str, level: i32, slow_ms: i64) -> AppResult<crate::db::MongoProfile> {
        if !(0..=2).contains(&level) {
            return Err(AppError::Query(t!("profiler level 需為 0 / 1 / 2").to_string()));
        }
        self.db_handle(database)
            .run_command(doc! { "profile": level, "slowms": slow_ms })
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        self.profile_get(database).await
    }

    /// 讀 system.profile 慢查詢（新到舊）。集合不存在（未開過 profiler）時 find 自然回空。
    pub async fn slow_queries(&self, database: &str, limit: u32) -> AppResult<Vec<crate::db::MongoSlowQuery>> {
        let limit = limit.clamp(1, 500) as i64;
        let coll = self.db_handle(database).collection::<Document>("system.profile");
        let opts = FindOptions::builder().sort(doc! { "ts": -1 }).limit(limit).build();
        let mut cursor = coll
            .find(doc! {})
            .with_options(opts)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out = Vec::new();
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Query(e.to_string()))?
        {
            out.push(crate::db::MongoSlowQuery {
                ts: d
                    .get_datetime("ts")
                    .ok()
                    .and_then(|dt| dt.try_to_rfc3339_string().ok())
                    .unwrap_or_default(),
                op: d.get_str("op").unwrap_or_default().to_string(),
                ns: d.get_str("ns").unwrap_or_default().to_string(),
                millis: doc_num(&d, "millis").unwrap_or(0),
                plan_summary: d.get_str("planSummary").unwrap_or_default().to_string(),
                keys_examined: doc_num(&d, "keysExamined").unwrap_or(0),
                docs_examined: doc_num(&d, "docsExamined").unwrap_or(0),
                nreturned: doc_num(&d, "nreturned").unwrap_or(0),
                command_json: d
                    .get_document("command")
                    .map(|c| cell_display(&Bson::Document(c.clone())))
                    .unwrap_or_default(),
            });
        }
        Ok(out)
    }
}

/// 從 CellEdit 取 _id 組成 filter。
fn id_filter(edit: &CellEdit) -> AppResult<Document> {
    let idx = edit
        .pk_columns
        .iter()
        .position(|c| c == "_id")
        .ok_or_else(|| AppError::Query(t!("缺少 _id，無法定位文件").to_string()))?;
    let raw = edit.pk_values.get(idx).and_then(|v| v.clone())
        .ok_or_else(|| AppError::Query(t!("_id 為空").to_string()))?;
    Ok(doc! { "_id": id_bson(&raw) })
}

/// 依連線設定組 mongodb 連線字串。連線選項存於 options map：
/// - mongo_srv=1        → mongodb+srv://（DNS SRV，不帶 port）
/// - mongo_auth_source  → authSource（非 admin 認證庫）
/// - mongo_tls=1        → tls=true
/// - mongo_replica_set  → replicaSet
/// - mongo_direct=1     → directConnection=true
/// - mongo_tls_ca       → tlsCAFile（自訂 CA 憑證檔）
/// - mongo_tls_insecure=1 → tlsAllowInvalidCertificates=true（自簽 / 開發用）
/// userinfo（帳號 / 密碼）做 percent-encoding，避免特殊字元破壞 URI。
pub(crate) fn build_mongo_uri(config: &ConnectionConfig) -> String {
    build_mongo_uri_inner(config, true)
}

/// mongodump / mongorestore 用的 URI：不帶 `/db` 路徑（MongoDB Tools 會拒絕同時給 URI db 與 `--db` /
/// `--nsInclude`），改用 `authSource` 保留原本的驗證資料庫語意。
pub(crate) fn build_mongo_tool_uri(config: &ConnectionConfig) -> String {
    build_mongo_uri_inner(config, false)
}

fn build_mongo_uri_inner(config: &ConnectionConfig, include_db: bool) -> String {
    let auth = if config.username.is_empty() {
        String::new()
    } else {
        format!("{}:{}@", pct_encode(&config.username), pct_encode(&config.password))
    };
    let opt = |k: &str| config.options.get(k).map(String::as_str).unwrap_or("");
    let srv = opt("mongo_srv") == "1";
    // URI 的 IPv6 host 必須保留方括號，否則 mongodb://::1:27017 會被 driver 當成無效語法。
    let bare_host = config.host.trim();
    let uri_host = if bare_host.contains(':') && !bare_host.starts_with('[') {
        format!("[{bare_host}]")
    } else {
        bare_host.to_string()
    };
    let host_part = if srv {
        // SRV：host 為 DNS 域名、不帶 port（由 SRV 記錄決定）。
        format!("mongodb+srv://{auth}{uri_host}")
    } else {
        format!("mongodb://{auth}{uri_host}:{}", config.port)
    };

    let db_path = config.database.as_deref().unwrap_or("").trim();
    let mut params: Vec<String> = Vec::new();
    let auth_source = opt("mongo_auth_source");
    if !auth_source.is_empty() {
        params.push(format!("authSource={}", pct_encode(auth_source)));
    } else if !include_db && !db_path.is_empty() {
        // 工具 URI 拿掉路徑後，原本靠路徑指定的 authSource 要明確補回來。
        params.push(format!("authSource={}", pct_encode(db_path)));
    }
    if opt("mongo_tls") == "1" {
        params.push("tls=true".to_string());
    }
    let replica_set = opt("mongo_replica_set");
    if !replica_set.is_empty() {
        params.push(format!("replicaSet={}", pct_encode(replica_set)));
    }
    // driver 不接受 replicaSet + directConnection 同時出現；與前端表單一致，以 replicaSet 為準。
    if opt("mongo_direct") == "1" && replica_set.is_empty() {
        params.push("directConnection=true".to_string());
    }
    let tls_ca = opt("mongo_tls_ca");
    if !tls_ca.is_empty() {
        params.push(format!("tlsCAFile={}", pct_encode(tls_ca)));
    }
    if opt("mongo_tls_insecure") == "1" {
        params.push("tlsAllowInvalidCertificates=true".to_string());
    }

    // 標準 mongodb://user:pass@host:27017/mydb 的路徑是預設資料庫（也是預設 authSource）。
    // 之前被丟掉，導致最常見的「URI 內含 db」寫法被拿去對 admin 驗證而失敗，mongodump 也一樣。
    let db_path = if include_db { db_path } else { "" };
    let base = if db_path.is_empty() {
        host_part
    } else {
        format!("{host_part}/{}", pct_encode(db_path))
    };
    if params.is_empty() {
        base
    } else if db_path.is_empty() {
        format!("{base}/?{}", params.join("&"))
    } else {
        format!("{base}?{}", params.join("&"))
    }
}

/// URI userinfo / 參數值的 percent-encoding，避免特殊字元破壞 mongodb 連線字串。
pub(crate) fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 分頁（skip + limit）必須有穩定排序，否則 WiredTiger 的自然順序會讓翻頁重複 / 漏列。
/// 沒指定 sort 時用 `_id` 升序；有指定時補 `_id` 當 tiebreaker（已含則不動）。
fn effective_sort(sort: Option<Document>) -> Document {
    let mut d = sort.unwrap_or_default();
    if d.keys().any(|k| k.starts_with('$')) || d.contains_key("_id") {
        return d;
    }
    d.insert("_id".to_string(), Bson::Int32(1));
    d
}

/// 將前端傳來的 _id 定位值還原成 BSON。
/// 新前端傳 canonical extended JSON（`{"$oid":…}` / `{"$numberLong":…}` / `"str"` 等），
/// 可正確還原 ObjectId / Int64 / Date / Decimal128 / String 等任意型別；
/// 舊前端傳純顯示字串（24 hex → ObjectId，否則字串），維持向後相容。
fn id_bson(raw: &str) -> Bson {
    let t = raw.trim();
    // extended JSON：物件（{…}）或 JSON 字串（"…"）。bare 數字 / bool 不當 JSON，避免
    // 數字外觀的字串 _id（如 "123"）被舊前端誤轉成數字。
    if t.starts_with('{') || t.starts_with('"') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
            if let Ok(b) = Bson::try_from(v) {
                return b;
            }
        }
    }
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

/// 表格輸入若以 `{` / `[` 開頭，視為 extended JSON 還原成 Document / Array。
/// 巢狀值曾經被 guess_bson 存成純字串，等於把文件 schema 改壞；解析失敗直接報錯，
/// 不要默默退回字串。其他輸入回 None，交給原欄位型別的轉換邏輯。
fn coerce_nested_bson(s: &str) -> AppResult<Option<Bson>> {
    let v = s.trim();
    if !v.starts_with('{') && !v.starts_with('[') {
        return Ok(None);
    }
    let json: serde_json::Value = serde_json::from_str(v)
        .map_err(|e| AppError::Query(tf!("巢狀 JSON 格式錯誤：{e}", e = e)))?;
    let b = Bson::try_from(json)
        .map_err(|e| AppError::Query(tf!("JSON 轉 BSON 失敗：{e}", e = e)))?;
    Ok(Some(b))
}

/// 依原欄位型別把表格輸入轉回 BSON：避免 ObjectId / Date / Int32 等被 guess_bson 變成字串，
///  silently 把文件 schema 改壞。不支援就地編輯的型別直接要求用整份文件編輯器。
fn coerce_bson_edit(orig: Option<&Bson>, s: &str) -> AppResult<Bson> {
    let bad = |t: &str| AppError::Query(tf!("此欄位型別為 {t}，請輸入合法值或用整份文件編輯器修改", t = t));
    let v = s.trim();
    match orig {
        Some(Bson::ObjectId(_)) => ObjectId::parse_str(v).map(Bson::ObjectId).map_err(|_| bad("ObjectId")),
        Some(Bson::DateTime(_)) => BsonDateTime::parse_rfc3339_str(v).map(Bson::DateTime).map_err(|_| bad("Date")),
        Some(Bson::Int32(_)) => v.parse::<i32>().map(Bson::Int32).map_err(|_| bad("Int32")),
        Some(Bson::Decimal128(_)) => v.parse::<Decimal128>().map(Bson::Decimal128).map_err(|_| bad("Decimal128")),
        Some(Bson::Double(_)) => v.parse::<f64>().map(Bson::Double).map_err(|_| bad("double")),
        Some(Bson::Int64(_)) => v.parse::<i64>().map(Bson::Int64).map_err(|_| bad("Int64")),
        Some(Bson::Boolean(_)) => match v {
            "true" => Ok(Bson::Boolean(true)),
            "false" => Ok(Bson::Boolean(false)),
            _ => Err(bad("bool")),
        },
        Some(Bson::Binary(_)) | Some(Bson::RegularExpression(_)) | Some(Bson::Timestamp(_))
        | Some(Bson::JavaScriptCodeWithScope(_)) => Err(AppError::Query(
            t!("此 BSON 型別無法用表格就地編輯，請用整份文件編輯器修改").to_string(),
        )),
        _ => Ok(guess_bson(s)),
    }
}

/// 判斷是否為 cell_display 產生的截斷後綴（前端也有一份相同判斷）。
fn cell_truncated_marker(s: &str) -> bool {
    const PREFIX: &str = "…⟪+";
    const SUFFIX: &str = " bytes⟫";
    let Some(i) = s.rfind(PREFIX) else { return false; };
    let tail = &s[i + PREFIX.len()..];
    tail.ends_with(SUFFIX)
        && tail[..tail.len() - SUFFIX.len()].chars().all(|c| c.is_ascii_digit())
}

/// 表格單格顯示上限（位元組）。超過則截斷並標記，避免巨型欄位（大陣列 / base64）整包渲染卡 UI。
const CELL_CAP: usize = 4096;

/// 表格單格顯示：以 bson_to_string 呈現，超過 CELL_CAP 於 UTF-8 邊界截斷並加標記後綴。
/// 前端據標記後綴判定「已截斷」→ 停用行內編輯、導向整份文件 JSON 編輯器。
fn cell_display(b: &Bson) -> String {
    let s = bson_to_string(b);
    if s.len() <= CELL_CAP {
        return s;
    }
    let mut end = CELL_CAP;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let extra = s.len() - end;
    format!("{}…⟪+{extra} bytes⟫", &s[..end])
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
        Bson::Decimal128(_) => "decimal128",
        Bson::Binary(_) => "binary",
        Bson::RegularExpression(_) => "regex",
        Bson::Timestamp(_) => "timestamp",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Symbol(_) => "symbol",
        Bson::MinKey => "minKey",
        Bson::MaxKey => "maxKey",
        Bson::Undefined => "undefined",
        Bson::DbPointer(_) => "dbPointer",
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
/// match_any=true 時以 $or 串接；否则以 $and 保留每條條件（同欄多條件才不會互相覆蓋）。
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
            // {field: null} 在 Mongo 會同時命中「欄位不存在」的文件；
            // $type:"null" 才是 SQL IS NULL 的語意（與欄位統計一致）。
            "is_null" => { d.insert(field, doc! { "$type": "null" }); }
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
    } else if clauses.len() == 1 {
        clauses.remove(0)
    } else {
        // 直接用 merged.insert 會讓「同一欄的兩個條件」（如 age>10 且 age<20）
        // 互相覆蓋，結果靜默出錯。改用 $and 保留每一條。
        doc! { "$and": clauses.into_iter().map(Bson::Document).collect::<Vec<_>>() }
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
/// 先試 canonical extended JSON（{$oid} / {$date} / {$numberLong}…）：
/// 從文件編輯器或 Compass 複製的條件才會保留 ObjectId / Date 等型別；
/// 查詢運算子（$gt / $in…）不是 extJSON，會自然地走原來的 plain document 路徑。
fn bson_from_json(v: &serde_json::Value) -> Bson {
    Bson::try_from(v.clone()).unwrap_or_else(|_| mongodb::bson::to_bson(v).unwrap_or(Bson::Null))
}

/// 文件數值欄位（i32 / i64 / f64 依版本不定）統一取成 i64。
fn doc_num(d: &Document, key: &str) -> Option<i64> {
    d.get_i64(key)
        .ok()
        .or_else(|| d.get_i32(key).ok().map(|v| v as i64))
        .or_else(|| d.get_f64(key).ok().map(|v| v as i64))
}

/// 由查詢 DSL 組出 explain 指令（純函式，供單元測試）。
/// find 形：{"explain":{"find":coll,filter,sort,projection,limit},"verbosity":v}；
/// pipeline 形：{"explain":{"aggregate":coll,"pipeline":[…],"cursor":{}},"verbosity":v}
/// （用頂層 explain 指令而非 aggregate 的 explain:true——後者不接受 verbosity）。
fn build_explain_command(parsed: &serde_json::Value) -> AppResult<(String, Document)> {
    let db = parsed
        .get("db")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Query(t!("缺少 db").to_string()))?;
    let coll = parsed
        .get("collection")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Query(t!("缺少 collection").to_string()))?;
    let mut verbosity = match parsed.get("verbosity").and_then(|v| v.as_str()) {
        None => "executionStats",
        Some(v @ ("queryPlanner" | "executionStats" | "allPlansExecution")) => v,
        Some(other) => {
            return Err(AppError::Query(format!(
                "verbosity 無效：{other}（可用 queryPlanner / executionStats / allPlansExecution）",
                other = other
            )))
        }
    };
    // MongoDB 拒絕對含 $out 的管線做 executionStats / allPlansExecution 的 explain；
    // explain 本身不寫入，降為 queryPlanner 依然能看到完整計畫（前端也做同樣調整）。
    fn has_out(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::Array(a) => a.iter().any(has_out),
            serde_json::Value::Object(m) => m.iter().any(|(k, v)| k == "$out" || has_out(v)),
            _ => false,
        }
    }
    if parsed.get("pipeline").is_some_and(has_out) {
        verbosity = "queryPlanner";
    }
    if parsed.get("insert").is_some() || parsed.get("update").is_some() || parsed.get("delete").is_some() {
        return Err(AppError::Query(t!("執行計畫僅支援 find / aggregate（pipeline）").to_string()));
    }

    let inner = if let Some(pv) = parsed.get("pipeline") {
        let arr = pv
            .as_array()
            .ok_or_else(|| AppError::Query(t!("pipeline 必須是陣列").to_string()))?;
        let mut stages: Vec<Bson> = Vec::with_capacity(arr.len());
        for v in arr {
            match bson_from_json(v) {
                Bson::Document(d) => stages.push(Bson::Document(d)),
                _ => return Err(AppError::Query(t!("pipeline 每個階段必須是物件").to_string())),
            }
        }
        doc! { "aggregate": coll, "pipeline": stages, "cursor": {} }
    } else {
        let mut find = doc! { "find": coll };
        let as_doc = |key: &str| -> Option<Document> {
            parsed.get(key).map(bson_from_json).and_then(|b| match b {
                Bson::Document(d) => Some(d),
                _ => None,
            })
        };
        if let Some(f) = as_doc("filter") {
            find.insert("filter", f);
        }
        if let Some(s) = as_doc("sort") {
            find.insert("sort", s);
        }
        if let Some(p) = as_doc("projection") {
            find.insert("projection", p);
        }
        // 與 query() 相同的預設 limit 200：讓 explain 反映實際會執行的查詢形狀。
        let limit = parsed
            .get("limit")
            .and_then(|v| v.as_i64())
            .filter(|n| *n > 0)
            .unwrap_or(200);
        find.insert("limit", limit);
        find
    };
    Ok((db.to_string(), doc! { "explain": inner, "verbosity": verbosity }))
}

/// 沿巢狀路徑取子文件欄位。
fn doc_path<'a>(d: &'a Document, path: &[&str]) -> Option<&'a Bson> {
    let (first, rest) = path.split_first()?;
    let b = d.get(*first)?;
    if rest.is_empty() {
        Some(b)
    } else {
        doc_path(b.as_document()?, rest)
    }
}

/// 秒數 → 「N 天 HH:MM:SS」。
fn fmt_uptime(secs: i64) -> String {
    let d = secs / 86_400;
    let h = (secs % 86_400) / 3_600;
    let m = (secs % 3_600) / 60;
    let s = secs % 60;
    if d > 0 {
        tf!("{d} 天 {hms}", d = d, hms = format!("{h:02}:{m:02}:{s:02}"))
    } else {
        format!("{h:02}:{m:02}:{s:02}")
    }
}

/// serverStatus + buildInfo → 分區顯示清單（純函式，供單元測試）。
/// 各區皆 best-effort：欄位缺漏（版本 / 權限差異）就略過該列，不整段失敗。
fn server_status_sections(status: &Document, build: &Document) -> Vec<ServerInfoSection> {
    let mut sections: Vec<ServerInfoSection> = Vec::new();
    let path_num = |path: &[&str]| -> Option<i64> {
        let (last, init) = path.split_last()?;
        let d = if init.is_empty() {
            status
        } else {
            doc_path(status, init)?.as_document()?
        };
        doc_num(d, last)
    };
    let path_str = |d: &Document, path: &[&str]| -> Option<String> {
        doc_path(d, path).and_then(|b| b.as_str().map(|s| s.to_string()))
    };

    // 伺服器
    let mut server: Vec<(String, String)> = Vec::new();
    if let Some(v) = path_str(build, &["version"]).or_else(|| path_str(status, &["version"])) {
        server.push((t!("版本").into(), v));
    }
    if let Some(h) = path_str(status, &["host"]) {
        server.push((t!("主機").into(), h));
    }
    if let Some(p) = path_str(status, &["process"]) {
        server.push((t!("程序").into(), p)); // mongod / mongos
    }
    if let Some(u) = path_num(&["uptime"]) {
        server.push((t!("運行時間").into(), fmt_uptime(u)));
    }
    if !server.is_empty() {
        sections.push(ServerInfoSection { name: t!("伺服器").into(), items: server });
    }

    // 連線
    let mut conns: Vec<(String, String)> = Vec::new();
    for (label, key) in [(t!("目前"), "current"), (t!("可用"), "available"), (t!("活躍"), "active"), (t!("累計建立"), "totalCreated")] {
        if let Some(v) = path_num(&["connections", key]) {
            conns.push((label.into(), v.to_string()));
        }
    }
    if !conns.is_empty() {
        sections.push(ServerInfoSection { name: t!("連線").into(), items: conns });
    }

    // 操作計數（自啟動累計）
    let mut ops: Vec<(String, String)> = Vec::new();
    for key in ["insert", "query", "update", "delete", "getmore", "command"] {
        if let Some(v) = path_num(&["opcounters", key]) {
            ops.push((key.into(), v.to_string()));
        }
    }
    if !ops.is_empty() {
        sections.push(ServerInfoSection { name: t!("操作計數").into(), items: ops });
    }

    // 記憶體（mem.* 單位為 MB；WiredTiger cache 為 bytes）
    let mut mem: Vec<(String, String)> = Vec::new();
    if let Some(v) = path_num(&["mem", "resident"]) {
        mem.push((t!("常駐記憶體").into(), fmt_bytes(v.saturating_mul(1024 * 1024))));
    }
    if let Some(v) = path_num(&["mem", "virtual"]) {
        mem.push((t!("虛擬記憶體").into(), fmt_bytes(v.saturating_mul(1024 * 1024))));
    }
    if let Some(v) = path_num(&["wiredTiger", "cache", "bytes currently in the cache"]) {
        mem.push((t!("WT 快取使用").into(), fmt_bytes(v)));
    }
    if let Some(v) = path_num(&["wiredTiger", "cache", "maximum bytes configured"]) {
        mem.push((t!("WT 快取上限").into(), fmt_bytes(v)));
    }
    if !mem.is_empty() {
        sections.push(ServerInfoSection { name: t!("記憶體").into(), items: mem });
    }

    // 網路
    let mut net: Vec<(String, String)> = Vec::new();
    if let Some(v) = path_num(&["network", "bytesIn"]) {
        net.push((t!("流入").into(), fmt_bytes(v)));
    }
    if let Some(v) = path_num(&["network", "bytesOut"]) {
        net.push((t!("流出").into(), fmt_bytes(v)));
    }
    if let Some(v) = path_num(&["network", "numRequests"]) {
        net.push((t!("請求數").into(), v.to_string()));
    }
    if !net.is_empty() {
        sections.push(ServerInfoSection { name: t!("網路").into(), items: net });
    }

    // 複寫（單機無 repl 區塊 → 整段略過）
    if let Some(repl) = doc_path(status, &["repl"]).and_then(|b| b.as_document()) {
        let mut r: Vec<(String, String)> = Vec::new();
        if let Some(v) = repl.get_str("setName").ok() {
            r.push(("Replica Set".into(), v.to_string()));
        }
        if let Ok(primary) = repl.get_bool("isWritablePrimary") {
            r.push((t!("角色").into(), if primary { "Primary".into() } else { "Secondary".into() }));
        }
        if let Ok(hosts) = repl.get_array("hosts") {
            let list: Vec<String> = hosts.iter().filter_map(|b| b.as_str().map(String::from)).collect();
            if !list.is_empty() {
                r.push((t!("成員").into(), list.join(", ")));
            }
        }
        if !r.is_empty() {
            sections.push(ServerInfoSection { name: t!("複寫").into(), items: r });
        }
    }

    sections
}

#[cfg(test)]
mod tests {
    use super::{bson_from_json, build_explain_command, build_filter, build_mongo_tool_uri, build_mongo_uri, cell_truncated_marker, coerce_bson_edit, coerce_nested_bson, effective_sort, guess_bson, like_to_regex, server_status_sections};
    use crate::db::{ConnectionConfig, DbKind, Filter, SshAuthMethod};
    use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime as BsonDateTime};

    #[test]
    fn build_filter_keeps_multiple_conditions_on_the_same_field() {
        let filters = vec![
            Filter { column: "age".into(), op: ">".into(), value: Some("10".into()) },
            Filter { column: "age".into(), op: "<".into(), value: Some("20".into()) },
        ];
        let d = build_filter(&filters, false);
        let and = d.get_array("$and").expect("兩個同欄條件不能互相覆蓋");
        assert_eq!(and.len(), 2);
        assert_eq!(and[0].as_document().unwrap().get_document("age").unwrap().get_i64("$gt").unwrap(), 10);
        assert_eq!(and[1].as_document().unwrap().get_document("age").unwrap().get_i64("$lt").unwrap(), 20);

        let any = build_filter(&filters, true);
        assert_eq!(any.get_array("$or").unwrap().len(), 2);
        // null 用 $type 而不是單純 null（後者會連「欄位不存在」一起命中）。
        let null_filter = build_filter(&[Filter { column: "x".into(), op: "is_null".into(), value: None }], false);
        assert_eq!(null_filter.get_document("x").unwrap().get_str("$type").unwrap(), "null");
    }

    #[test]
    fn mongo_uri_keeps_database_path() {
        let cfg = ConnectionConfig {
            id: "x".into(), name: "x".into(), kind: DbKind::Mongo,
            host: "h".into(), port: 27017, username: "u".into(), password: "p".into(),
            database: Some("mydb".into()), max_connections: 5,
            ssh_enabled: false, ssh_host: String::new(), ssh_port: 22, ssh_username: String::new(),
            ssh_auth_method: SshAuthMethod::Password, ssh_password: String::new(),
            ssh_private_key_path: String::new(), ssh_passphrase: String::new(),
            options: [("mongo_auth_source".to_string(), "admin".to_string())].into_iter().collect(),
            otp_secret: String::new(),
        };
        let uri = build_mongo_uri(&cfg);
        assert!(uri.contains("/mydb?authSource=admin"), "{uri}");
        let mut srv = cfg.clone();
        srv.options.insert("mongo_srv".into(), "1".into());
        assert!(build_mongo_uri(&srv).starts_with("mongodb+srv://"), "{uri}");
        assert!(build_mongo_uri(&srv).contains("/mydb?"));
    }

    #[test]
    fn mongo_tool_uri_has_no_db_path_but_keeps_auth_source() {
        let cfg = ConnectionConfig {
            id: "x".into(), name: "x".into(), kind: DbKind::Mongo,
            host: "h".into(), port: 27017, username: "u".into(), password: "p@ss".into(),
            database: Some("shop".into()), max_connections: 5,
            ssh_enabled: false, ssh_host: String::new(), ssh_port: 22, ssh_username: String::new(),
            ssh_auth_method: SshAuthMethod::Password, ssh_password: String::new(),
            ssh_private_key_path: String::new(), ssh_passphrase: String::new(),
            options: Default::default(), otp_secret: String::new(),
        };
        let uri = build_mongo_tool_uri(&cfg);
        assert!(uri.starts_with("mongodb://u:p%40ss@h:27017"), "{uri}");
        assert!(!uri.contains("/shop"), "mongodump 的 URI 不能有 db 路徑：{uri}");
        assert!(uri.contains("authSource=shop"), "路徑拿掉後要補 authSource：{uri}");

        // 明確設定 mongo_auth_source 時以它為準。
        let mut explicit = cfg;
        explicit.options.insert("mongo_auth_source".into(), "admin".into());
        let uri = build_mongo_tool_uri(&explicit);
        assert!(uri.contains("authSource=admin"), "{uri}");
        assert!(!uri.contains("authSource=shop"), "{uri}");
    }

    #[test]
    fn mongo_uri_brackets_ipv6_and_drops_conflicting_direct_connection() {
        let cfg = ConnectionConfig {
            id: "x".into(), name: "x".into(), kind: DbKind::Mongo,
            host: "::1".into(), port: 27017, username: String::new(), password: String::new(),
            database: Some("mydb".into()), max_connections: 5,
            ssh_enabled: false, ssh_host: String::new(), ssh_port: 22, ssh_username: String::new(),
            ssh_auth_method: SshAuthMethod::Password, ssh_password: String::new(),
            ssh_private_key_path: String::new(), ssh_passphrase: String::new(),
            options: [("mongo_replica_set".to_string(), "rs0".to_string()),
                      ("mongo_direct".to_string(), "1".to_string())].into_iter().collect(),
            otp_secret: String::new(),
        };
        let uri = build_mongo_uri(&cfg);
        assert!(uri.starts_with("mongodb://[::1]:27017"), "{uri}");
        assert!(uri.contains("replicaSet=rs0"), "{uri}");
        assert!(!uri.contains("directConnection"), "replicaSet 優先，不能同時送 directConnection：{uri}");

        // 沒有 replicaSet 時 directConnection 仍要保留。
        let mut direct = cfg;
        direct.options.remove("mongo_replica_set");
        let uri = build_mongo_uri(&direct);
        assert!(uri.contains("directConnection=true"), "{uri}");
    }

    #[test]
    fn query_json_accepts_canonical_extended_json() {
        let oid = bson_from_json(&serde_json::json!({"$oid": "507f1f77bcf86cd799439011"}));
        assert!(matches!(oid, Bson::ObjectId(_)), "{oid:?}");
        let n = bson_from_json(&serde_json::json!({"$numberLong": "5"}));
        assert!(matches!(n, Bson::Int64(5)), "{n:?}");
        // 查詢運算子必須仍是一般 document，不能被當成 extJSON。
        let gt = bson_from_json(&serde_json::json!({"$gt": 5}));
        assert_eq!(gt.as_document().unwrap().get_i32("$gt").unwrap(), 5);
    }

    #[test]
    fn document_json_serialization_keeps_bson_types() {
        let d = doc! { "_id": ObjectId::from_bytes([1; 12]), "n": Bson::Int64(5) };
        let s = Bson::Document(d).into_canonical_extjson().to_string();
        assert!(s.contains("$oid"), "文件 JSON 要保留 ObjectId：{s}");
        assert!(s.contains("$numberLong"), "Int64 不能用純 JSON number（前端會掉精度）：{s}");
    }

    #[test]
    fn grid_edit_keeps_original_bson_type() {
        assert!(matches!(
            coerce_bson_edit(Some(&Bson::ObjectId(ObjectId::from_bytes([1; 12]))), "507f1f77bcf86cd799439011").unwrap(),
            Bson::ObjectId(_)
        ));
        assert!(matches!(
            coerce_bson_edit(Some(&Bson::DateTime(BsonDateTime::from_millis(0))), "2024-01-02T03:04:05Z").unwrap(),
            Bson::DateTime(_)
        ));
        assert!(matches!(
            coerce_bson_edit(Some(&Bson::Int32(1)), "42").unwrap(),
            Bson::Int32(42)
        ));
        assert!(coerce_bson_edit(Some(&Bson::ObjectId(ObjectId::from_bytes([1; 12]))), "not-an-oid").is_err());
    }

    #[test]
    fn truncated_cell_marker_is_recognized() {
        assert!(cell_truncated_marker("abc…⟪+1234 bytes⟫"));
        assert!(!cell_truncated_marker("abc"));
        assert!(!cell_truncated_marker("abc…⟪+12 bytes⟫ tail"));
    }

    #[test]
    fn explain_command_find_defaults() {
        let dsl: serde_json::Value =
            serde_json::from_str(r#"{"db":"shop","collection":"orders","filter":{"status":"paid"},"sort":{"created":-1}}"#)
                .unwrap();
        let (db, cmd) = build_explain_command(&dsl).unwrap();
        assert_eq!(db, "shop");
        assert_eq!(cmd.get_str("verbosity").unwrap(), "executionStats"); // 預設
        let inner = cmd.get_document("explain").unwrap();
        assert_eq!(inner.get_str("find").unwrap(), "orders");
        assert_eq!(inner.get_document("filter").unwrap().get_str("status").unwrap(), "paid");
        assert_eq!(inner.get_i64("limit").unwrap(), 200); // 與 query() 相同的預設 limit
    }

    #[test]
    fn explain_command_pipeline_uses_top_level_form() {
        let dsl: serde_json::Value = serde_json::from_str(
            r#"{"db":"d","collection":"c","pipeline":[{"$match":{}}],"verbosity":"queryPlanner"}"#,
        )
        .unwrap();
        let (_, cmd) = build_explain_command(&dsl).unwrap();
        assert_eq!(cmd.get_str("verbosity").unwrap(), "queryPlanner");
        let inner = cmd.get_document("explain").unwrap();
        assert_eq!(inner.get_str("aggregate").unwrap(), "c");
        assert!(inner.get_array("pipeline").is_ok());
        assert!(inner.get_document("cursor").is_ok()); // aggregate 指令必帶 cursor
    }

    #[test]
    fn explain_command_rejects_writes_and_bad_verbosity() {
        let w: serde_json::Value =
            serde_json::from_str(r#"{"db":"d","collection":"c","insert":[{}]}"#).unwrap();
        assert!(build_explain_command(&w).is_err());
        let v: serde_json::Value =
            serde_json::from_str(r#"{"db":"d","collection":"c","verbosity":"nope"}"#).unwrap();
        assert!(build_explain_command(&v).is_err());
    }

    #[test]
    fn server_status_sections_extracts_core_metrics() {
        let status = doc! {
            "host": "db1", "process": "mongod", "uptime": 90_061i64, // 1 天 01:01:01
            "connections": { "current": 5i32, "available": 995i32 },
            "opcounters": { "insert": 10i64, "query": 20i64 },
            "mem": { "resident": 256i32 },
            "repl": { "setName": "rs0", "isWritablePrimary": true, "hosts": ["a:27017", "b:27017"] },
        };
        let build = doc! { "version": "7.0.5" };
        let secs = server_status_sections(&status, &build);
        let find = |name: &str| secs.iter().find(|s| s.name == name).unwrap();
        assert!(find("伺服器").items.iter().any(|(k, v)| k == "版本" && v == "7.0.5"));
        assert!(find("伺服器").items.iter().any(|(k, v)| k == "運行時間" && v.contains("1 天")));
        assert!(find("連線").items.iter().any(|(k, v)| k == "目前" && v == "5"));
        assert!(find("操作計數").items.iter().any(|(k, v)| k == "insert" && v == "10"));
        assert!(find("複寫").items.iter().any(|(k, v)| k == "角色" && v == "Primary"));
        // 無 network 區塊 → 該 section 不出現。
        assert!(secs.iter().all(|s| s.name != "網路"));
    }

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
    fn effective_sort_is_deterministic_for_paging() {
        assert_eq!(effective_sort(None), doc! { "_id": 1 });
        assert_eq!(effective_sort(Some(doc! { "status": 1 })), doc! { "status": 1, "_id": 1 });
        // 已指定 _id（含方向）時不覆蓋使用者的選擇。
        assert_eq!(effective_sort(Some(doc! { "_id": -1 })), doc! { "_id": -1 });
        // $natural 等特殊排序不加欄位（加了會被伺服器拒絕）。
        assert_eq!(effective_sort(Some(doc! { "$natural": 1 })), doc! { "$natural": 1 });
    }

    #[test]
    fn coerce_nested_bson_restores_objects_and_arrays() {
        // 巢狀 JSON 必須還原成 Document/Array，不能存成純字串。
        assert!(matches!(coerce_nested_bson(r#"{"a":1}"#).unwrap(), Some(Bson::Document(_))));
        assert!(matches!(coerce_nested_bson("[1,2]").unwrap(), Some(Bson::Array(_))));
        // extended JSON 的 ObjectId 也要還原。
        let ext = r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"}}"#;
        let Some(Bson::Document(d)) = coerce_nested_bson(ext).unwrap() else { panic!("應為 Document") };
        assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
        // 純量 / 一般字串交給 guess_bson。
        assert!(coerce_nested_bson("42").unwrap().is_none());
        assert!(coerce_nested_bson("hello").unwrap().is_none());
        // 看起來是 JSON 但壞掉 → 明確報錯，不 silently 存成字串。
        assert!(coerce_nested_bson("{oops").is_err());
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
