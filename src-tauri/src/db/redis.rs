use redis::AsyncCommands;

use crate::db::{
    finalize_hits, BigKey, CellEdit, ClientInfo, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver,
    KeyDetail, KeyEdit, KeyPage, PagedData, PoolStatus, QueryResult, RedisKeys, RowDelete, RowInsert,
    SearchHit, SearchOptions, ServerInfoSection, SlowLogEntry, TableInfo,
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
    /// URL 尾綴：TLS 略過憑證驗證時為 "#insecure"，否則空字串。附加在 base_url/<db> 之後。
    url_suffix: String,
    db_count: i64,
    /// per-db-index 連線快取。Redis 連線綁定單一 DB，故依 db index 快取各自的
    /// ConnectionManager（多工、Clone 共享、斷線自動重連），避免每次操作新建 TCP + 握手。
    conns: tokio::sync::RwLock<std::collections::HashMap<i64, redis::aio::ConnectionManager>>,
    /// 網格模式 table_data 翻頁用的鍵快照，避免每次翻頁重掃整個 keyspace。
    snapshot: tokio::sync::Mutex<Option<KeysSnapshot>>,
}

/// 網格模式 table_data 的鍵快照：同 db + pattern 下翻頁直接切片，不重掃 keyspace。
/// page==0、過期、或 db/pattern 不符時重建；寫入操作與 clear_cache 會使其失效。
struct KeysSnapshot {
    db: String,
    pattern: String,
    keys: Vec<String>,
    created: std::time::Instant,
}

/// 鍵快照有效期。逾時翻頁會重掃，確保不長時間顯示過期鍵集。
const SNAPSHOT_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// string value 大小保護：超過 1 MiB 且未要求完整載入時，只取前段預覽。
const STRING_PREVIEW_THRESHOLD: i64 = 1 << 20; // 1 MiB
/// 預覽取回的位元組數（64 KiB 對 UI 顯示綽綽有餘）。
const STRING_PREVIEW_BYTES: isize = 64 * 1024;

impl RedisDriver {
    /// 取得指定 DB 的非同步連線（快取命中即回 clone；未命中才建 ConnectionManager）。
    async fn conn(&self, database: &str) -> AppResult<redis::aio::ConnectionManager> {
        let db_idx: i64 = database.parse().unwrap_or(0);
        if let Some(c) = self.conns.read().await.get(&db_idx) {
            return Ok(c.clone());
        }
        let mut w = self.conns.write().await;
        // double-check：等寫鎖期間可能已被其他呼叫建好。
        if let Some(c) = w.get(&db_idx) {
            return Ok(c.clone());
        }
        // 以 base_url/<db> 形式選 DB；TLS insecure 時附加 #insecure fragment。
        let url = format!("{}/{}{}", self.base_url, db_idx, self.url_suffix);
        let client = redis::Client::open(url).map_err(|e| AppError::Connect(e.to_string()))?;
        let cm = client
            .get_connection_manager()
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;
        w.insert(db_idx, cm.clone());
        Ok(cm)
    }

    /// 預設（DB 0）的伺服器層連線，供不綁特定 DB 的維運指令（SLOWLOG / CLIENT 等）使用。
    async fn admin_conn(&self) -> AppResult<redis::aio::ConnectionManager> {
        self.conn("0").await
    }

    /// 使鍵快照失效（寫入操作後呼叫，避免翻頁看到殭屍鍵或漏掉新鍵）。
    async fn invalidate_snapshot(&self) {
        *self.snapshot.lock().await = None;
    }

    /// 確保鍵快照對應 (db, pattern) 且未過期，回傳 (總鍵數, 該頁鍵)。
    /// page==0 一律重掃並更新快照（換 filter/排序時前端會 setPage(0)，語意自然）。
    async fn paged_keys(
        &self,
        conn: &mut redis::aio::ConnectionManager,
        database: &str,
        pattern: &str,
        page: u32,
        page_size: u32,
    ) -> AppResult<(u64, Vec<String>)> {
        let mut guard = self.snapshot.lock().await;
        let fresh = guard.as_ref().is_some_and(|s| {
            s.db == database && s.pattern == pattern && s.created.elapsed() < SNAPSHOT_TTL
        });
        if page == 0 || !fresh {
            let keys = scan_all_keys(conn, pattern).await?;
            *guard = Some(KeysSnapshot {
                db: database.to_string(),
                pattern: pattern.to_string(),
                keys,
                created: std::time::Instant::now(),
            });
        }
        let snap = guard.as_ref().unwrap();
        let total = snap.keys.len() as u64;
        let start = (page as usize).saturating_mul(page_size as usize);
        let end = start.saturating_add(page_size as usize).min(snap.keys.len());
        let page_keys = if start < snap.keys.len() {
            snap.keys[start..end].to_vec()
        } else {
            Vec::new()
        };
        Ok((total, page_keys))
    }

    // ===== 以下為 Redis 專屬「另一款 Redis 工具」對齊功能（inherent 方法，
    //       由 commands::redis_* 透過 manager.redis_driver 直接呼叫，不經 DatabaseDriver trait）=====

    /// Pub/Sub 用的 client（複製連線設定即可；實際訂閱連線於背景任務中建立）。
    pub fn pubsub_client(&self) -> redis::Client {
        self.client.clone()
    }

    /// 分頁讀取集合型鍵的成員（大鍵不再一次全載）。
    /// - hash/set/zset：游標式 HSCAN/SSCAN/ZSCAN（MATCH 過濾欄位 / 成員名）。
    /// - list：以 cursor 當 LRANGE 視窗起點；filter 為非空時於本頁以子字串過濾。
    /// - string：忽略分頁，回單一值。
    pub async fn key_page(
        &self,
        database: &str,
        key: &str,
        cursor: u64,
        count: usize,
        filter: &str,
        full: bool,
    ) -> AppResult<KeyPage> {
        let mut conn = self.conn(database).await?;
        let to_err = |e: redis::RedisError| AppError::Query(e.to_string());
        let ktype: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(to_err)?;
        let ttl: i64 = redis::cmd("TTL").arg(key).query_async(&mut conn).await.unwrap_or(-1);
        let count = count.clamp(1, 10_000);
        // SCAN 家族的 MATCH：空 → "*"；含 glob 字元（* ?）原樣；否則以 *sub* 包夾成子字串比對。
        let match_pat = if filter.is_empty() {
            "*".to_string()
        } else if filter.contains('*') || filter.contains('?') {
            filter.to_string()
        } else {
            format!("*{filter}*")
        };

        let mut page = KeyPage {
            type_: ktype.clone(),
            ttl,
            total: -1,
            cursor: 0,
            fields: Vec::new(),
            members: Vec::new(),
            scores: Vec::new(),
            value_bytes: -1,
            truncated: false,
        };

        match ktype.as_str() {
            "string" => {
                // 先量長度：超過閾值且未要求完整載入 → 只取前段預覽，避免一次拉回數十 MB 卡 UI。
                let len: i64 =
                    redis::cmd("STRLEN").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                page.value_bytes = len;
                page.total = 1;
                if !full && len > STRING_PREVIEW_THRESHOLD {
                    let bytes: Vec<u8> = redis::cmd("GETRANGE")
                        .arg(key)
                        .arg(0)
                        .arg(STRING_PREVIEW_BYTES - 1)
                        .query_async(&mut conn)
                        .await
                        .map_err(to_err)?;
                    // from_utf8_lossy 容忍在 UTF-8 邊界截斷。
                    page.members = vec![String::from_utf8_lossy(&bytes).into_owned()];
                    page.truncated = true;
                } else {
                    let v: Option<String> = conn.get(key).await.map_err(to_err)?;
                    page.members = vec![v.unwrap_or_default()];
                }
            }
            "list" => {
                let total: i64 =
                    redis::cmd("LLEN").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                page.total = total;
                let start = cursor as i64;
                let stop = start + count as i64 - 1;
                let items: Vec<String> = redis::cmd("LRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(stop)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?;
                let fetched = items.len();
                page.members = if filter.is_empty() {
                    items
                } else {
                    items.into_iter().filter(|s| s.contains(filter)).collect()
                };
                // fetched < count → 已是最後一頁（LRANGE 回不滿即代表到底）；否則下一視窗起點。
                page.cursor = if fetched < count {
                    0
                } else {
                    (start + fetched as i64) as u64
                };
            }
            "set" => {
                page.total = redis::cmd("SCARD").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                // SCAN COUNT 僅為提示，單次可能回很少；迴圈累積到接近一頁或掃完，避免「載入更多」常拿到空批。
                let mut cur = cursor;
                loop {
                    let (next, batch): (u64, Vec<String>) = redis::cmd("SSCAN")
                        .arg(key)
                        .arg(cur)
                        .arg("MATCH")
                        .arg(&match_pat)
                        .arg("COUNT")
                        .arg(count)
                        .query_async(&mut conn)
                        .await
                        .map_err(to_err)?;
                    page.members.extend(batch);
                    cur = next;
                    if cur == 0 || page.members.len() >= count {
                        break;
                    }
                }
                page.cursor = cur;
            }
            "hash" => {
                page.total = redis::cmd("HLEN").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                let mut cur = cursor;
                loop {
                    let (next, batch): (u64, Vec<String>) = redis::cmd("HSCAN")
                        .arg(key)
                        .arg(cur)
                        .arg("MATCH")
                        .arg(&match_pat)
                        .arg("COUNT")
                        .arg(count)
                        .query_async(&mut conn)
                        .await
                        .map_err(to_err)?;
                    // batch 為 field, value 交錯。
                    let mut it = batch.into_iter();
                    while let (Some(f), Some(v)) = (it.next(), it.next()) {
                        page.fields.push(f);
                        page.members.push(v);
                    }
                    cur = next;
                    if cur == 0 || page.members.len() >= count {
                        break;
                    }
                }
                page.cursor = cur;
            }
            "zset" => {
                page.total = redis::cmd("ZCARD").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                let mut cur = cursor;
                loop {
                    let (next, batch): (u64, Vec<String>) = redis::cmd("ZSCAN")
                        .arg(key)
                        .arg(cur)
                        .arg("MATCH")
                        .arg(&match_pat)
                        .arg("COUNT")
                        .arg(count)
                        .query_async(&mut conn)
                        .await
                        .map_err(to_err)?;
                    // batch 為 member, score 交錯。
                    let mut it = batch.into_iter();
                    while let (Some(m), Some(s)) = (it.next(), it.next()) {
                        page.members.push(m);
                        page.scores.push(s.parse::<f64>().unwrap_or(0.0));
                    }
                    cur = next;
                    if cur == 0 || page.members.len() >= count {
                        break;
                    }
                }
                page.cursor = cur;
            }
            _ => {}
        }
        Ok(page)
    }

    /// 慢查詢日誌（SLOWLOG GET count）。
    pub async fn slowlog(&self, count: i64) -> AppResult<Vec<SlowLogEntry>> {
        let mut conn = self.admin_conn().await?;
        let val: redis::Value = redis::cmd("SLOWLOG")
            .arg("GET")
            .arg(count.max(1))
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        let mut out = Vec::new();
        if let redis::Value::Array(entries) = val {
            for e in entries {
                if let redis::Value::Array(f) = e {
                    let command = match f.get(3) {
                        Some(redis::Value::Array(args)) => {
                            args.iter().map(rv_to_string).collect::<Vec<_>>().join(" ")
                        }
                        _ => String::new(),
                    };
                    out.push(SlowLogEntry {
                        id: rv_as_i64(f.get(0)),
                        time: rv_as_i64(f.get(1)),
                        duration_us: rv_as_i64(f.get(2)),
                        command,
                        client: f.get(4).map(rv_to_string).unwrap_or_default(),
                        client_name: f.get(5).map(rv_to_string).unwrap_or_default(),
                    });
                }
            }
        }
        Ok(out)
    }

    /// 用戶端連線清單（CLIENT LIST，逐行解析 key=value）。
    pub async fn clients(&self) -> AppResult<Vec<ClientInfo>> {
        let mut conn = self.admin_conn().await?;
        let raw: String = redis::cmd("CLIENT")
            .arg("LIST")
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(parse_client_list(&raw))
    }

    /// 中斷指定用戶端（CLIENT KILL ID <id>）。
    pub async fn client_kill(&self, client_id: &str) -> AppResult<()> {
        let mut conn = self.admin_conn().await?;
        let _: redis::Value = redis::cmd("CLIENT")
            .arg("KILL")
            .arg("ID")
            .arg(client_id)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(())
    }

    /// 大鍵掃描：SCAN 取樣 sample 個鍵，逐一 MEMORY USAGE，回傳前 top 名。
    /// 取樣式（非全量），避免在大型實例上長時間鎖佔；sample 上限保護。
    pub async fn big_keys(&self, database: &str, sample: usize, top: usize) -> AppResult<Vec<BigKey>> {
        let sample = sample.clamp(1, 100_000);
        let top = top.clamp(1, 1_000);
        let mut conn = self.conn(database).await?;
        let to_err = |e: redis::RedisError| AppError::Query(e.to_string());
        let mut all: Vec<BigKey> = Vec::new();
        let mut scanned = 0usize;
        let mut cursor: u64 = 0;
        loop {
            let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("COUNT")
                .arg(500)
                .query_async(&mut conn)
                .await
                .map_err(to_err)?;
            // 只取樣到 sample 上限。
            let take: Vec<String> = batch.into_iter().take(sample.saturating_sub(scanned)).collect();
            if !take.is_empty() {
                // pipeline：每 key MEMORY USAGE + TYPE + TTL（三命令）一次送回，避免 N×3 序列往返。
                let mut pipe = redis::pipe();
                for k in &take {
                    pipe.cmd("MEMORY").arg("USAGE").arg(k);
                    pipe.cmd("TYPE").arg(k);
                    pipe.cmd("TTL").arg(k);
                }
                let vals: Vec<redis::Value> = pipe.query_async(&mut conn).await.map_err(to_err)?;
                for (k, tri) in take.iter().zip(vals.chunks(3)) {
                    // MEMORY USAGE 對不存在鍵回 Nil → 維持 -1 語意。
                    let bytes = match tri.first() {
                        Some(redis::Value::Nil) | None => -1,
                        Some(v) => rv_as_i64(Some(v)),
                    };
                    let ktype = tri.get(1).map(rv_to_string).unwrap_or_else(|| "unknown".to_string());
                    let ttl = rv_as_i64(tri.get(2));
                    all.push(BigKey { key: k.clone(), type_: ktype, bytes, ttl });
                }
                scanned += take.len();
            }
            cursor = next;
            if cursor == 0 || scanned >= sample {
                break;
            }
        }
        all.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        all.truncate(top);
        Ok(all)
    }

    /// 發佈訊息到頻道（PUBLISH），回傳收到的訂閱者數。
    pub async fn publish(&self, channel: &str, message: &str) -> AppResult<i64> {
        let mut conn = self.admin_conn().await?;
        redis::cmd("PUBLISH")
            .arg(channel)
            .arg(message)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))
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
        // TLS：options["redis_tls"]=="true" → rediss://；redis_tls_insecure → #insecure 略過憑證驗證。
        let use_tls = config.options.get("redis_tls").is_some_and(|v| v == "true");
        let tls_insecure = config.options.get("redis_tls_insecure").is_some_and(|v| v == "true");
        let scheme = if use_tls { "rediss" } else { "redis" };
        let url_suffix = if use_tls && tls_insecure { "#insecure".to_string() } else { String::new() };
        let base_url = format!("{scheme}://{auth}{}:{}", config.host, config.port);

        // 基礎 client 供 pub/sub 用（含 TLS suffix，確保加密連線的訂閱也走 TLS）。
        let client = redis::Client::open(format!("{base_url}{url_suffix}"))
            .map_err(|e| AppError::Connect(e.to_string()))?;

        let driver = Self {
            client,
            base_url,
            url_suffix,
            db_count: 16, // 下方讀 CONFIG GET databases 覆寫；讀不到（如託管 Redis 禁 CONFIG）維持 16。
            conns: Default::default(),
            snapshot: Default::default(),
        };

        // PING 驗證連線，並順帶讀取實際 DB 數（CONFIG GET databases 回 ["databases", "16"]）。
        let mut conn = driver.admin_conn().await?;
        let pong: String = redis::cmd("PING")
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Connect(e.to_string()))?;
        if !pong.eq_ignore_ascii_case("pong") {
            return Err(AppError::Connect(format!("非預期的 PING 回應：{pong}")));
        }
        let db_count = redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async::<Vec<String>>(&mut conn)
            .await
            .ok()
            .and_then(|v| v.get(1).and_then(|s| s.parse::<i64>().ok()))
            .unwrap_or(16);

        Ok(Self { db_count, ..driver })
    }

    async fn ping(&self) -> AppResult<()> {
        let mut conn = self.admin_conn().await?;
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
                comment: String::new(),
            },
            ColumnInfo {
                name: "type".to_string(),
                data_type: "string".to_string(),
                nullable: false,
                key: String::new(),
                default: None,
                extra: String::new(),
                comment: String::new(),
            },
            ColumnInfo {
                name: "ttl".to_string(),
                data_type: "integer".to_string(),
                nullable: true,
                key: String::new(),
                default: None,
                extra: "秒；-1 表示無到期".to_string(),
                comment: String::new(),
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

        // 取（或重建）鍵快照後切出該頁；翻頁不重掃整個 keyspace（見 paged_keys）。
        let (total, page_keys) = self
            .paged_keys(&mut conn, database, &pattern, query.page, query.page_size)
            .await?;

        // 對該頁 key 以 pipeline 一次取回 type + ttl（100 keys 從 200 次往返降到 1 次）。
        let rows = fetch_key_meta(&mut conn, &page_keys).await?;

        Ok(PagedData {
            columns: vec!["key".to_string(), "type".to_string(), "ttl".to_string()],
            rows,
            total_rows: total,
            page: query.page,
            page_size: query.page_size,
            primary_key: vec!["key".to_string()],
            row_ids: Vec::new(),
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
        // 以 redis-cli 風格切詞（支援單 / 雙引號與雙引號內的 \ 轉義），
        // 才能輸入含空白的值，如 SET k "hello world"。
        let parts = split_args(cmdline);
        if parts.is_empty() {
            return Err(AppError::Query("空命令".to_string()));
        }
        let mut conn = self.conn(&db).await?;
        let mut cmd = redis::cmd(&parts[0]);
        for p in &parts[1..] {
            cmd.arg(p.as_str());
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
        self.invalidate_snapshot().await; // 新增鍵後翻頁需看到它
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
        self.invalidate_snapshot().await; // 刪鍵後翻頁不應再看到殭屍鍵
        Ok(n as u64)
    }

    fn pool_status(&self) -> PoolStatus {
        // 回報目前快取的 per-db 連線數（try_read 避免在同步方法阻塞；取不到鎖回 0）。
        let size = self.conns.try_read().map(|m| m.len() as u32).unwrap_or(0);
        PoolStatus { size, idle: size, in_use: 0 }
    }

    async fn search_objects(&self, opts: &SearchOptions) -> AppResult<Vec<SearchHit>> {
        // Redis 無 SQL 物件；以 SCAN MATCH 比對鍵名（object_type=key，glob 比對為大小寫敏感）。
        if opts.term.is_empty() || !opts.match_names || !opts.wants_type("key") {
            return Ok(vec![]);
        }
        let cap = opts.cap();
        // 含 glob 字元（* ?）視為樣式原樣使用；否則以 *sub* 包夾成子字串比對。
        let pattern = if opts.term.contains('*') || opts.term.contains('?') {
            opts.term.clone()
        } else {
            format!("*{}*", opts.term)
        };
        let dbs: Vec<String> = match &opts.databases {
            Some(list) if !list.is_empty() => list.clone(),
            _ => (0..self.db_count).map(|i| i.to_string()).collect(),
        };
        let mut hits = Vec::new();
        for db in dbs {
            if hits.len() >= cap {
                break;
            }
            let found = match self.scan_keys(&db, &pattern, cap).await {
                Ok(k) => k,
                Err(_) => continue,
            };
            for key in found.keys {
                hits.push(SearchHit {
                    database: db.clone(),
                    object_type: "key".into(),
                    object_name: key,
                    parent: None,
                    matched_in: "name".into(),
                    snippet: None,
                    extra: None,
                });
            }
        }
        Ok(finalize_hits(hits, opts))
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
                // 大 value 保護：超過閾值只取前段預覽（此路徑非樹狀 UI 使用，仍防呆避免 OOM）。
                let len: i64 =
                    redis::cmd("STRLEN").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                if len > STRING_PREVIEW_THRESHOLD {
                    let bytes: Vec<u8> = redis::cmd("GETRANGE")
                        .arg(key)
                        .arg(0)
                        .arg(STRING_PREVIEW_BYTES - 1)
                        .query_async(&mut conn)
                        .await
                        .map_err(|e| AppError::Query(e.to_string()))?;
                    detail.entries = vec![String::from_utf8_lossy(&bytes).into_owned()];
                } else {
                    let v: Option<String> = conn
                        .get(key)
                        .await
                        .map_err(|e| AppError::Query(e.to_string()))?;
                    detail.entries = vec![v.unwrap_or_default()];
                }
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
        // 改名 / 移除最後一個元素會改變鍵集合，使快照失效以免翻頁看到殭屍鍵。
        self.invalidate_snapshot().await;
        Ok(affected.max(0) as u64)
    }

    async fn server_info(&self) -> AppResult<Vec<ServerInfoSection>> {
        let mut conn = self.admin_conn().await?;
        let raw: String = redis::cmd("INFO")
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        Ok(parse_info(&raw))
    }

    async fn scan_keys(
        &self,
        database: &str,
        pattern: &str,
        limit: usize,
    ) -> AppResult<RedisKeys> {
        let limit = limit.max(1);
        let pattern = if pattern.is_empty() { "*" } else { pattern };
        let mut conn = self.conn(database).await?;

        // 邊掃邊去重（SCAN 在 rehash 期間可能重複回傳同一 key），
        // 截斷判斷一律以「唯一鍵數」為準，避免重複灌水誤判截斷或漏掃。
        // BTreeSet 同時保證輸出已排序。
        let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut cursor: u64 = 0;
        let mut truncated = false;
        loop {
            let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(1000)
                .query_async(&mut conn)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            set.extend(batch);
            cursor = next;
            // 掃完一輪即停（最精確的「沒有更多」訊號）；此時不算截斷。
            if cursor == 0 {
                break;
            }
            // 唯一鍵數達上限且仍有游標 → 確實還有更多鍵，標記截斷後停掃。
            if set.len() >= limit {
                truncated = true;
                break;
            }
        }

        let mut keys: Vec<String> = set.into_iter().collect();
        if keys.len() > limit {
            keys.truncate(limit);
            truncated = true;
        }
        Ok(RedisKeys { keys, truncated })
    }

    async fn clear_cache(&self) {
        // 前端刷新連線樹 / 網格「重新整理」時呼叫：使鍵快照失效，下次翻頁強制重掃。
        self.invalidate_snapshot().await;
    }

    async fn close(&self) {
        // 清空快取的連線（ConnectionManager 於 drop 時釋放底層 TCP）。
        self.conns.write().await.clear();
    }
}

/// SCAN 全掃收集符合 pattern 的鍵（游標式、安全上限 100k、排序去重）。
/// SCAN 在 rehash 期間可能重複回傳同一 key，故排序後 dedup 避免重複列與灌水總數。
async fn scan_all_keys(
    conn: &mut redis::aio::ConnectionManager,
    pattern: &str,
) -> AppResult<Vec<String>> {
    let mut all: Vec<String> = Vec::new();
    let mut cursor: u64 = 0;
    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(500)
            .query_async(conn)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;
        all.extend(batch);
        cursor = next;
        // 掃完（cursor 歸零）或達安全上限即停。
        if cursor == 0 || all.len() > 100_000 {
            break;
        }
    }
    all.sort();
    all.dedup();
    Ok(all)
}

/// 以 pipeline 一次取回多個 key 的 TYPE + TTL，組成 [key, type, ttl] 列。
async fn fetch_key_meta(
    conn: &mut redis::aio::ConnectionManager,
    keys: &[String],
) -> AppResult<Vec<Vec<Option<String>>>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut pipe = redis::pipe();
    for k in keys {
        pipe.cmd("TYPE").arg(k);
        pipe.cmd("TTL").arg(k);
    }
    let vals: Vec<redis::Value> = pipe
        .query_async(conn)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;
    let mut rows = Vec::with_capacity(keys.len());
    for (k, pair) in keys.iter().zip(vals.chunks(2)) {
        let ktype = pair.first().map(rv_to_string).unwrap_or_else(|| "unknown".to_string());
        let ttl = rv_as_i64(pair.get(1));
        rows.push(vec![Some(k.clone()), Some(ktype), Some(ttl.to_string())]);
    }
    Ok(rows)
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

/// redis-cli 風格的命令列切詞：以空白分隔；支援單引號（字面）、
/// 雙引號（內部 \ 轉義 \n \t \r \" \\ 等），引號區段可與相鄰字元相接。
/// 例：`SET k "hello world"` → ["SET", "k", "hello world"]。
fn split_args(line: &str) -> Vec<String> {
    enum Q {
        None,
        Single,
        Double,
    }
    let mut args: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_arg = false;
    let mut q = Q::None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match q {
            Q::None => {
                if c.is_whitespace() {
                    if in_arg {
                        args.push(std::mem::take(&mut cur));
                        in_arg = false;
                    }
                } else if c == '"' {
                    in_arg = true;
                    q = Q::Double;
                } else if c == '\'' {
                    in_arg = true;
                    q = Q::Single;
                } else {
                    in_arg = true;
                    cur.push(c);
                }
            }
            Q::Double => {
                if c == '\\' {
                    if let Some(&n) = chars.peek() {
                        chars.next();
                        cur.push(match n {
                            'n' => '\n',
                            't' => '\t',
                            'r' => '\r',
                            other => other,
                        });
                    }
                } else if c == '"' {
                    q = Q::None;
                } else {
                    cur.push(c);
                }
            }
            Q::Single => {
                if c == '\'' {
                    q = Q::None;
                } else {
                    cur.push(c);
                }
            }
        }
    }
    if in_arg {
        args.push(cur);
    }
    args
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

/// 將單一 redis::Value 攤成字串（供 SLOWLOG 等巢狀結果取值）。
fn rv_to_string(v: &redis::Value) -> String {
    match v {
        redis::Value::Nil => String::new(),
        redis::Value::Int(i) => i.to_string(),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::Okay => "OK".to_string(),
        redis::Value::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        other => format!("{other:?}"),
    }
}

/// 從 redis::Value 取整數（接受 Int / 數字字串）。
fn rv_as_i64(v: Option<&redis::Value>) -> i64 {
    match v {
        Some(redis::Value::Int(i)) => *i,
        Some(redis::Value::BulkString(b)) => String::from_utf8_lossy(b).trim().parse().unwrap_or(0),
        Some(redis::Value::SimpleString(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// 解析 `CLIENT LIST` 純文字：每行為空白分隔的 key=value。
fn parse_client_list(raw: &str) -> Vec<ClientInfo> {
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let mut m: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
            for tok in line.split_whitespace() {
                if let Some((k, v)) = tok.split_once('=') {
                    m.insert(k, v);
                }
            }
            let get = |k: &str| m.get(k).map(|s| s.to_string()).unwrap_or_default();
            ClientInfo {
                id: get("id"),
                addr: get("addr"),
                name: get("name"),
                age: get("age"),
                idle: get("idle"),
                db: get("db"),
                cmd: get("cmd"),
                flags: get("flags"),
            }
        })
        .collect()
}
