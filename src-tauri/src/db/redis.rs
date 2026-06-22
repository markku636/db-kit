use redis::AsyncCommands;

use crate::db::{
    CellEdit, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver, KeyDetail, KeyEdit,
    PagedData, PoolStatus, QueryResult, RowDelete, RowInsert, ServerInfoSection, TableInfo,
};
use crate::error::{AppError, AppResult};

/// Redis 驅動。鍵值型，沿用 Navicat 表格手感的「key 列表化」：
/// - list_databases → DB 0..N（預設 16）
/// - list_tables → 對該 DB 回單一虛擬「表」keys（讓樹可展開）
/// - table_data → SCAN 掃 key，列出 [key, type, ttl] 三欄；key 作為主鍵
/// - key_detail → 取單一 key 依型別展開（String/Hash/List/Set/ZSet）
/// - update_cell：改 string 值或 TTL；insert_row：SET 新 key；delete_row：DEL key
///
/// 安全：列舉 key 一律用 SCAN（游標式），嚴禁 KEYS * 鎖死正式環境。
pub struct RedisDriver {
    client: redis::Client,
    base_url: String,
    db_count: i64,
}

impl RedisDriver {
    /// 取得指定 DB 的非同步連線（Redis 連線綁定單一 DB，故每次依 db 重連）。
    async fn conn(&self, database: &str) -> AppResult<redis::aio::MultiplexedConnection> {
        let db_idx: i64 = database.parse().unwrap_or(0);
        // 以 base_url/<db> 形式選 DB。
        let url = format!("{}/{}", self.base_url, db_idx);
        let client = redis::Client::open(url).map_err(|e| AppError::Connect(e.to_string()))?;
        client
            .get_multiplexed_tokio_connection()
            .await
            .map_err(|e| AppError::Connect(e.to_string()))
    }
}

#[async_trait::async_trait]
impl DatabaseDriver for RedisDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        let auth = if config.password.is_empty() {
            String::new()
        } else if config.username.is_empty() {
            format!(":{}@", config.password)
        } else {
            format!("{}:{}@", config.username, config.password)
        };
        let base_url = format!("redis://{auth}{}:{}", config.host, config.port);

        let client =
            redis::Client::open(base_url.clone()).map_err(|e| AppError::Connect(e.to_string()))?;

        let driver = Self {
            client,
            base_url,
            db_count: 16, // 預設；下方 connect 後嘗試讀 CONFIG databases
        };
        driver.ping().await?;
        Ok(driver)
    }

    async fn ping(&self) -> AppResult<()> {
        let mut conn = self
            .client
            .get_multiplexed_tokio_connection()
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;
        let pong: String = redis::cmd("PING")
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;
        if pong.eq_ignore_ascii_case("pong") {
            Ok(())
        } else {
            Err(AppError::Connect(format!("非預期的 PING 回應：{pong}")))
        }
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        Ok((0..self.db_count).map(|i| i.to_string()).collect())
    }

    async fn list_tables(&self, _database: &str) -> AppResult<Vec<TableInfo>> {
        // Redis 無表概念；回一個虛擬節點 "keys" 讓樹可展開、雙擊開 key 列表。
        Ok(vec![TableInfo {
            name: "keys".to_string(),
            kind: "keyspace".to_string(),
        }])
    }

    async fn table_columns(
        &self,
        _database: &str,
        _table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        // 固定三欄結構。
        Ok(vec![
            ColumnInfo {
                name: "key".to_string(),
                data_type: "string".to_string(),
                nullable: false,
                key: "PRI".to_string(),
                default: None,
                extra: String::new(),
            },
            ColumnInfo {
                name: "type".to_string(),
                data_type: "string".to_string(),
                nullable: false,
                key: String::new(),
                default: None,
                extra: String::new(),
            },
            ColumnInfo {
                name: "ttl".to_string(),
                data_type: "integer".to_string(),
                nullable: true,
                key: String::new(),
                default: None,
                extra: "秒；-1 表示無到期".to_string(),
            },
        ])
    }

    async fn table_data(
        &self,
        database: &str,
        _table: &str,
        query: &DataQuery,
    ) -> AppResult<PagedData> {
        let mut conn = self.conn(database).await?;

        // 篩選若有 key 的 like/= 條件，轉成 SCAN MATCH pattern。
        let mut pattern = "*".to_string();
        for f in &query.filters {
            if f.column == "key" {
                if let Some(v) = &f.value {
                    pattern = match f.op.as_str() {
                        "like" => v.replace('%', "*"),
                        "=" => v.clone(),
                        _ => pattern,
                    };
                }
            }
        }

        // 用 SCAN 全掃（游標式，安全），收集所有符合 pattern 的 key。
        let mut all_keys: Vec<String> = Vec::new();
        let mut cursor: u64 = 0;
        loop {
            let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(&pattern)
                .arg("COUNT")
                .arg(500)
                .query_async(&mut conn)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            all_keys.extend(batch);
            cursor = next;
            if cursor == 0 {
                break;
            }
            // 安全上限，避免極端情況無限掃
            if all_keys.len() > 100_000 {
                break;
            }
        }

        // SCAN 可能回傳重複的 key（游標式不保證唯一），排序後去重避免重複列與灌水的總數。
        all_keys.sort();
        all_keys.dedup();
        let total = all_keys.len() as u64;

        // 分頁切片（saturating 避免極端 page * page_size 溢位，與 SQL driver 一致）。
        let start = (query.page as usize).saturating_mul(query.page_size as usize);
        let end = start.saturating_add(query.page_size as usize).min(all_keys.len());
        let page_keys = if start < all_keys.len() {
            &all_keys[start..end]
        } else {
            &[]
        };

        // 對該頁 key 取 type 與 ttl
        let mut rows: Vec<Vec<Option<String>>> = Vec::with_capacity(page_keys.len());
        for k in page_keys {
            let ktype: String = redis::cmd("TYPE")
                .arg(k)
                .query_async(&mut conn)
                .await
                .unwrap_or_else(|_| "unknown".to_string());
            let ttl: i64 = redis::cmd("TTL")
                .arg(k)
                .query_async(&mut conn)
                .await
                .unwrap_or(-1);
            rows.push(vec![
                Some(k.clone()),
                Some(ktype),
                Some(ttl.to_string()),
            ]);
        }

        Ok(PagedData {
            columns: vec!["key".to_string(), "type".to_string(), "ttl".to_string()],
            rows,
            total_rows: total,
            page: query.page,
            page_size: query.page_size,
            primary_key: vec!["key".to_string()],
        })
    }

    async fn query(&self, sql: &str) -> AppResult<QueryResult> {
        // 接受原始 Redis 命令列，例如 "GET foo" 或 "0:GET foo"（前綴選 DB）。
        let (db, cmdline) = match sql.split_once(':') {
            Some((maybe_db, rest)) if maybe_db.trim().parse::<i64>().is_ok() => {
                (maybe_db.trim().to_string(), rest.trim())
            }
            _ => ("0".to_string(), sql.trim()),
        };
        let parts: Vec<&str> = cmdline.split_whitespace().collect();
        if parts.is_empty() {
            return Err(AppError::Query("空命令".to_string()));
        }
        let mut conn = self.conn(&db).await?;
        let mut cmd = redis::cmd(parts[0]);
        for p in &parts[1..] {
            cmd.arg(*p);
        }
        // 以通用 Value 取回，轉成字串列。
        let val: redis::Value = cmd
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let rows = redis_value_to_rows(&val);
        Ok(QueryResult {
            columns: vec!["result".to_string()],
            rows,
            rows_affected: 0,
        })
    }

    async fn update_cell(
        &self,
        database: &str,
        _table: &str,
        edit: &CellEdit,
    ) -> AppResult<u64> {
        // 從主鍵取 key；依被編輯的欄位決定行為。
        let key = pk_key(&edit.pk_columns, &edit.pk_values)?;
        let mut conn = self.conn(database).await?;
        match edit.column.as_str() {
            "ttl" => {
                let secs: i64 = edit
                    .new_value
                    .as_deref()
                    .unwrap_or("-1")
                    .parse()
                    .map_err(|_| AppError::Query("TTL 必須為整數".to_string()))?;
                if secs < 0 {
                    let _: i64 = conn
                        .persist(&key)
                        .await
                        .map_err(|e| AppError::Query(e.to_string()))?;
                } else {
                    let _: bool = conn
                        .expire(&key, secs)
                        .await
                        .map_err(|e| AppError::Query(e.to_string()))?;
                }
                Ok(1)
            }
            "key" => Err(AppError::Query("不支援直接改 key 名稱，請用 RENAME".to_string())),
            // type 為唯讀的型別中介資料；若以 SET 寫入會把 list/set/zset/hash 覆蓋成 string、
            // 造成資料遺失，故明確拒絕（避免誤觸格內編輯）。
            "type" => Err(AppError::Query("type 欄為唯讀，無法編輯".to_string())),
            // 其餘（string value 編輯）：對 string 型別做 SET
            _ => {
                let v = edit.new_value.clone().unwrap_or_default();
                let _: () = conn
                    .set(&key, v)
                    .await
                    .map_err(|e| AppError::Query(e.to_string()))?;
                Ok(1)
            }
        }
    }

    async fn insert_row(
        &self,
        database: &str,
        _table: &str,
        row: &RowInsert,
    ) -> AppResult<u64> {
        // 新增 key：需要 key 與 value 兩欄（type 預設 string）。
        let mut key = None;
        let mut value = None;
        for (c, v) in row.columns.iter().zip(row.values.iter()) {
            match c.as_str() {
                "key" => key = v.clone(),
                "value" | "type" => {
                    if c == "value" {
                        value = v.clone()
                    }
                }
                _ => {}
            }
        }
        let key = key.ok_or_else(|| AppError::Query("缺少 key".to_string()))?;
        let value = value.unwrap_or_default();
        let mut conn = self.conn(database).await?;
        let _: () = conn
            .set(&key, value)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(1)
    }

    async fn delete_row(
        &self,
        database: &str,
        _table: &str,
        del: &RowDelete,
    ) -> AppResult<u64> {
        let key = pk_key(&del.pk_columns, &del.pk_values)?;
        let mut conn = self.conn(database).await?;
        let n: i64 = conn
            .del(&key)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(n as u64)
    }

    fn pool_status(&self) -> PoolStatus {
        PoolStatus { size: 0, idle: 0, in_use: 0 }
    }

    async fn key_detail(&self, database: &str, key: &str) -> AppResult<Option<KeyDetail>> {
        let mut conn = self.conn(database).await?;
        let ktype: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let ttl: i64 = redis::cmd("TTL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .unwrap_or(-1);

        let mut detail = KeyDetail {
            key: key.to_string(),
            type_: ktype.clone(),
            ttl,
            entries: Vec::new(),
            fields: Vec::new(),
            scores: Vec::new(),
        };

        match ktype.as_str() {
            "string" => {
                let v: Option<String> = conn
                    .get(key)
                    .await
                    .map_err(|e| AppError::Query(e.to_string()))?;
                detail.entries = vec![v.unwrap_or_default()];
            }
            "list" => {
                let items: Vec<String> = conn
                    .lrange(key, 0, -1)
                    .await
                    .map_err(|e| AppError::Query(e.to_string()))?;
                detail.entries = items;
            }
            "set" => {
                let items: Vec<String> = conn
                    .smembers(key)
                    .await
                    .map_err(|e| AppError::Query(e.to_string()))?;
                detail.entries = items;
            }
            "zset" => {
                // 帶分數取回（member, score 交錯）
                let pairs: Vec<(String, f64)> = conn
                    .zrange_withscores(key, 0, -1)
                    .await
                    .map_err(|e| AppError::Query(e.to_string()))?;
                for (m, s) in pairs {
                    detail.entries.push(m);
                    detail.scores.push(s);
                }
            }
            "hash" => {
                let map: std::collections::HashMap<String, String> = conn
                    .hgetall(key)
                    .await
                    .map_err(|e| AppError::Query(e.to_string()))?;
                for (f, v) in map {
                    detail.fields.push(f);
                    detail.entries.push(v);
                }
            }
            _ => {}
        }
        Ok(Some(detail))
    }

    async fn key_edit(&self, database: &str, key: &str, edit: &KeyEdit) -> AppResult<u64> {
        let mut conn = self.conn(database).await?;
        let to_err = |e: redis::RedisError| AppError::Query(e.to_string());
        // 移除最後一個元素時 Redis 會自動刪 key；前端 reload key_detail 後即反映。
        let affected: i64 = match edit {
            KeyEdit::ListSet { index, value } => {
                let _: () = redis::cmd("LSET")
                    .arg(key)
                    .arg(*index)
                    .arg(value)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?;
                1
            }
            KeyEdit::ListPush { value, front } => {
                let cmd = if *front { "LPUSH" } else { "RPUSH" };
                redis::cmd(cmd)
                    .arg(key)
                    .arg(value)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?
            }
            KeyEdit::ListRemove { value, count } => redis::cmd("LREM")
                .arg(key)
                .arg(*count)
                .arg(value)
                .query_async(&mut conn)
                .await
                .map_err(to_err)?,
            KeyEdit::SetAdd { member } => redis::cmd("SADD")
                .arg(key)
                .arg(member)
                .query_async(&mut conn)
                .await
                .map_err(to_err)?,
            KeyEdit::SetRemove { member } => redis::cmd("SREM")
                .arg(key)
                .arg(member)
                .query_async(&mut conn)
                .await
                .map_err(to_err)?,
            KeyEdit::ZsetAdd { member, score } => {
                // ZADD 對既有成員回 0（更新分數），coerce 成 1 避免被當失敗。
                let _: i64 = redis::cmd("ZADD")
                    .arg(key)
                    .arg(*score)
                    .arg(member)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?;
                1
            }
            KeyEdit::ZsetRemove { member } => redis::cmd("ZREM")
                .arg(key)
                .arg(member)
                .query_async(&mut conn)
                .await
                .map_err(to_err)?,
            KeyEdit::HashSet { field, value } => {
                // HSET 對既有欄位回 0（更新值），coerce 成 1。
                let _: i64 = redis::cmd("HSET")
                    .arg(key)
                    .arg(field)
                    .arg(value)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?;
                1
            }
            KeyEdit::HashRemove { field } => redis::cmd("HDEL")
                .arg(key)
                .arg(field)
                .query_async(&mut conn)
                .await
                .map_err(to_err)?,
            KeyEdit::Rename { new_key } => {
                // 用 RENAMENX：目的鍵已存在則回 0、不覆蓋，避免靜默摧毀既有鍵；
                // 來源不存在仍會報錯。回 1 表示成功改名。
                let renamed: i64 = redis::cmd("RENAMENX")
                    .arg(key)
                    .arg(new_key)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?;
                if renamed == 0 {
                    return Err(AppError::Query(format!(
                        "目標鍵「{new_key}」已存在，為避免覆蓋而取消改名"
                    )));
                }
                1
            }
        };
        Ok(affected.max(0) as u64)
    }

    async fn server_info(&self) -> AppResult<Vec<ServerInfoSection>> {
        let mut conn = self
            .client
            .get_multiplexed_tokio_connection()
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;
        let raw: String = redis::cmd("INFO")
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(parse_info(&raw))
    }

    async fn close(&self) {
        // redis Client 無顯式 close；連線於 drop 時釋放。
    }
}

/// 從主鍵欄位列取出 "key" 的值。
fn pk_key(cols: &[String], vals: &[Option<String>]) -> AppResult<String> {
    let idx = cols
        .iter()
        .position(|c| c == "key")
        .ok_or_else(|| AppError::Query("缺少 key".to_string()))?;
    vals.get(idx)
        .and_then(|v| v.clone())
        .ok_or_else(|| AppError::Query("key 為空".to_string()))
}

/// 解析 Redis `INFO` 純文字為分區結構。
/// 區段以 "# Name" 起始，內容為 "key:value"；註解／空行略過。
fn parse_info(raw: &str) -> Vec<ServerInfoSection> {
    let mut sections: Vec<ServerInfoSection> = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix("# ") {
            sections.push(ServerInfoSection {
                name: name.trim().to_string(),
                items: Vec::new(),
            });
        } else if let Some((k, v)) = line.split_once(':') {
            // 萬一第一筆在任何區段標頭之前出現，補一個 General 區段承接。
            if sections.last().is_none() {
                sections.push(ServerInfoSection {
                    name: "General".to_string(),
                    items: Vec::new(),
                });
            }
            sections
                .last_mut()
                .unwrap()
                .items
                .push((k.to_string(), v.to_string()));
        }
    }
    sections
}

/// 將 redis::Value 攤平成單欄字串列。
fn redis_value_to_rows(v: &redis::Value) -> Vec<Vec<Option<String>>> {
    match v {
        redis::Value::Nil => vec![vec![Some("(nil)".to_string())]],
        redis::Value::Int(i) => vec![vec![Some(i.to_string())]],
        redis::Value::SimpleString(s) => vec![vec![Some(s.clone())]],
        redis::Value::Okay => vec![vec![Some("OK".to_string())]],
        redis::Value::BulkString(bytes) => {
            vec![vec![Some(String::from_utf8_lossy(bytes).into_owned())]]
        }
        redis::Value::Array(items) | redis::Value::Set(items) => items
            .iter()
            .flat_map(|it| redis_value_to_rows(it))
            .collect(),
        other => vec![vec![Some(format!("{other:?}"))]],
    }
}
