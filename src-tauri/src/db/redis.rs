use redis::AsyncCommands;

use crate::db::{
    finalize_hits, BigKey, CellEdit, ClientInfo, ColumnInfo, ConnectionConfig, DataQuery, DatabaseDriver,
    KeyDetail, KeyEdit, KeyPage, PagedData, PoolStatus, QueryResult, RedisKeys, RowDelete, RowInsert,
    SearchHit, SearchOptions, ServerInfoSection, SlowLogEntry, StreamGroup, TableInfo,
};
use crate::error::{AppError, AppResult};

/// 從「匯出單鍵 JSON」匯入的一筆。value 的形狀隨 type 而異，由 import_keys 解析。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RedisImportKey {
    pub key: String,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(default = "default_ttl")]
    pub ttl: i64,
    /// 匯出時只載到部分成員：匯入必須略過，否則會 DEL 掉原鍵再寫回截斷的子集。
    #[serde(default)]
    pub partial: bool,
    /// 匯出檔自我描述：匯出筆數 / 實際總數。partial 被竄改時仍可在後端擋下。
    #[serde(default)]
    pub exported: i64,
    #[serde(default)]
    pub total: i64,
    pub value: serde_json::Value,
}

fn default_ttl() -> i64 { -1 }

#[derive(Debug, Clone, serde::Serialize)]
pub struct RedisImportSummary {
    pub imported: usize,
    pub skipped: usize,
}

/// RedisInsight 風格的 keyspace 分析：抽樣統計各型別的鍵數與記憶體用量。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedisKeyspaceSummary {
    /// 實際取樣到的鍵數。
    pub sampled: usize,
    /// DBSIZE 回報的總鍵數（可能不精確但足以當量級）。
    pub total_keys: i64,
    /// 抽樣鍵的 MEMORY USAGE 總和（位元組）。
    pub total_bytes: i64,
    /// (型別, 鍵數, 記憶體位元組)，依記憶體降冪。
    pub types: Vec<(String, usize, i64)>,
    /// MEMORY USAGE 被停用 / 失敗：記憶體欄位不可信（全為 0）。
    pub memory_unavailable: bool,
}

/// 把 (type, bytes) 列表聚合成各型別的計數與總用量，供單元測試。
fn aggregate_keyspace(entries: &[(String, i64)]) -> Vec<(String, usize, i64)> {
    use std::collections::BTreeMap;
    let mut m: BTreeMap<String, (usize, i64)> = BTreeMap::new();
    for (ty, bytes) in entries {
        let e = m.entry(ty.clone()).or_insert((0, 0));
        e.0 += 1;
        e.1 += *bytes;
    }
    let mut out: Vec<(String, usize, i64)> = m.into_iter().map(|(k, (c, b))| (k, c, b)).collect();
    out.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.1.cmp(&a.1)));
    out
}

/// zset 分數可能是數字，也可能是匯出檔對 ±inf 的字面表示（JSON 不能存 Infinity）。
fn parse_import_score(v: &serde_json::Value) -> Option<f64> {
    if let Some(n) = v.as_f64() { return Some(n); }
    match v.as_str()? {
        "+inf" | "inf" | "Infinity" => Some(f64::INFINITY),
        "-inf" | "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

/// 匯入前一筆資料是否可處理：目前不支援 stream / 模組型別，且 value 型狀要對。
fn import_key_valid(item: &RedisImportKey) -> bool {
    // 截斷過的匯出要擋下來：DEL 掉完整鍵再寫回部分內容就是資料丟失。
    if item.partial || item.key.trim().is_empty() { return false; }
    // 雙重保險：即使前端漏標 partial，只要檔案自己說「只載到一部分」就略過。
    if item.total > 0 && item.exported < item.total { return false; }
    match item.type_.as_str() {
        "string" => item.value.is_string(),
        "hash" => item.value.as_array().is_some_and(|a| a.iter().all(|v| {
            v.get("field").is_some_and(|x| x.is_string()) && v.get("value").is_some_and(|x| x.is_string())
        })),
        "list" | "set" => item.value.as_array().is_some_and(|a| a.iter().all(|v| v.is_string())),
        "zset" => item.value.as_array().is_some_and(|a| a.iter().all(|v| {
            v.get("member").is_some_and(|x| x.is_string())
                && v.get("score").is_some_and(|x| parse_import_score(x).is_some())
        })),
        _ => false,
    }
}

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
    /// 連線參數（db 欄位固定 0；各 DB 的連線複製一份再改 db）。
    ///
    /// 直接組 ConnectionInfo、不拼 URL：密碼含 `@ : / # % ?` 時拼出來的 URL 會被切錯
    ///（`#` 之後被當成 fragment、`@` 讓主機名稱跑掉），IPv6 位址也要另外加方括號。
    info: redis::ConnectionInfo,
    db_count: i64,
    /// `SCAN ... TYPE` 要 Redis 6+；連線時由 INFO 判斷，舊版改走客戶端 TYPE 過濾。
    /// 讀不到版本時保守用 false（慢一點但功能正常）。
    supports_scan_type: bool,
    /// per-db-index 連線快取。Redis 連線綁定單一 DB，故依 db index 快取各自的
    /// ConnectionManager（多工、Clone 共享、斷線自動重連），避免每次操作新建 TCP + 握手。
    conns: tokio::sync::RwLock<std::collections::HashMap<i64, redis::aio::ConnectionManager>>,
    /// 網格模式 table_data 翻頁用的鍵快照，避免每次翻頁重掃整個 keyspace。
    snapshot: tokio::sync::Mutex<Option<KeysSnapshot>>,
}

/// 以索引移除 list 元素：先用唯一哨兵 LSET 該位置再 LREM，全部在同一個 script 裡完成。
/// 回 0 表示索引超出範圍（沒動到任何元素）。
const LUA_LIST_REMOVE_AT: &str = r#"
local n = redis.call('LLEN', KEYS[1])
local i = tonumber(ARGV[1])
if i < 0 or i >= n then return 0 end
redis.call('LSET', KEYS[1], i, ARGV[2])
redis.call('LREM', KEYS[1], 1, ARGV[2])
return 1
"#;

/// set 成員改名：目標已存在回 -1、來源不存在回 0，都不會動到原成員。
const LUA_SET_RENAME: &str = r#"
if redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 1 then return -1 end
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[1], ARGV[2])
return 1
"#;

/// DUMP 出來的 payload 搭配 RESTORE 的 TTL（毫秒）：-1 永不過期、-2 鍵不存在都想成 0。
fn clone_restore_ttl_ms(pttl: i64) -> i64 {
    if pttl > 0 { pttl } else { 0 }
}

/// 把使用者輸入的「命名空間前綴」轉成 SCAN MATCH 樣式：跳脫 glob 特殊字元，
/// 前綴裡的 `*` / `[` 是鍵名的一部分，不能被當成樣式語法。
fn redis_prefix_glob(prefix: &str) -> String {
    let mut out = String::with_capacity(prefix.len() + 1);
    for ch in prefix.chars() {
        if matches!(ch, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('*');
    out
}

/// 網格模式 table_data 的鍵快照：同 db + pattern 下翻頁直接切片，不重掃 keyspace。
/// page==0、過期、或 db/pattern 不符時重建；寫入操作與 clear_cache 會使其失效。
struct KeysSnapshot {
    db: String,
    pattern: String,
    keys: Vec<String>,
    /// SCAN 因安全上限提前停止：總鍵數比 keys.len() 還多，介面必須講清楚。
    truncated: bool,
    created: std::time::Instant,
}

/// 跳脫 Redis glob 的特殊字元，讓字面值不會被當成萬用字元 / 字元 class。
fn glob_escape(filter: &str) -> String {
    let mut out = String::with_capacity(filter.len());
    for ch in filter.chars() {
        if matches!(ch, '[' | ']' | '\\' | '*' | '?') { out.push('\\'); }
        out.push(ch);
    }
    out
}

/// 把字面子字串包成 SCAN MATCH：[] 與 \ 是 Redis glob 的特殊字元，要跳脫，
/// 否則查 `user[0]` 會變成字元 class、配到 `user0`。
fn glob_literal_substring(filter: &str) -> String {
    format!("*{}*", glob_escape(filter))
}

/// SQL LIKE 轉 Redis glob：`%` 才是萬用字元，其餘 glob 字元（含 `*`）都是字面。
fn glob_like_pattern(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch == '%' { out.push('*'); }
        else if matches!(ch, '[' | ']' | '\\' | '*' | '?') { out.push('\\'); out.push(ch); }
        else { out.push(ch); }
    }
    out
}

/// 連線選項的 Sentinel master 名稱（空字串＝一般直連）。
fn sentinel_master(config: &ConnectionConfig) -> Option<&str> {
    config.options.get("redis_sentinel_master").map(String::as_str)
}

/// SCAN 安全上限。
const SCAN_KEY_LIMIT: usize = 100_000;

/// 是否因上限提前停止（游標沒歸零就代表還有鍵沒掃）。
fn scan_truncated(cursor: u64, collected: usize) -> bool {
    cursor != 0 && collected > SCAN_KEY_LIMIT
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
        let mut info = self.info.clone();
        info.redis.db = db_idx;
        let client = redis::Client::open(info).map_err(|e| AppError::Connect(e.to_string()))?;
        let cm = client
            .get_connection_manager_with_config(manager_config())
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
    ) -> AppResult<(u64, Vec<String>, bool)> {
        let mut guard = self.snapshot.lock().await;
        let fresh = guard.as_ref().is_some_and(|s| {
            s.db == database && s.pattern == pattern && s.created.elapsed() < SNAPSHOT_TTL
        });
        if page == 0 || !fresh {
            let (keys, truncated) = scan_all_keys(conn, pattern).await?;
            *guard = Some(KeysSnapshot {
                db: database.to_string(),
                pattern: pattern.to_string(),
                keys,
                truncated,
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
        Ok((total, page_keys, snap.truncated))
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
    /// - stream：翻頁靠項目 ID（`after_id` = 上一頁回傳的 `next_id`），不靠數字游標。
    /// stream 的項目以 fields = ID、members = 該項目的欄位（JSON 物件字串）表示。
    #[allow(clippy::too_many_arguments)]
    pub async fn key_page(
        &self,
        database: &str,
        key: &str,
        cursor: u64,
        count: usize,
        filter: &str,
        full: bool,
        after_id: Option<&str>,
    ) -> AppResult<KeyPage> {
        let mut conn = self.conn(database).await?;
        let to_err = rerr;
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
            glob_literal_substring(filter)
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
            binary: false,
            next_id: None,
            groups: Vec::new(),
            memory_bytes: -1,
            encoding: String::new(),
        };
        // 第一頁順便取記憶體用量與內部編碼（一次 pipeline）。託管 Redis 可能停用 MEMORY / OBJECT，取不到就略過。
        if cursor == 0 && after_id.is_none() && ktype != "none" {
            let mut pipe = redis::pipe();
            pipe.cmd("MEMORY").arg("USAGE").arg(key).cmd("OBJECT").arg("ENCODING").arg(key);
            if let Ok((mem, enc)) = pipe.query_async::<(Option<i64>, Option<String>)>(&mut conn).await {
                page.memory_bytes = mem.unwrap_or(-1);
                page.encoding = enc.unwrap_or_default();
            }
        }
        // 一律以位元組取回再解碼：直接要 String 的話，只要有一個非 UTF-8 位元組（gzip、protobuf、
        // 序列化物件快取很常見），redis crate 就讓整個指令失敗，鍵詳情整頁打不開。
        let mut page_bin = false;
        let mut text = |b: Vec<u8>| {
            let (s, bin) = decode_bytes(b);
            page_bin |= bin;
            s
        };

        match ktype.as_str() {
            "string" => {
                // 先量長度：超過閾值且未要求完整載入 → 只取前段預覽，避免一次拉回數十 MB 卡 UI。
                let len: i64 =
                    redis::cmd("STRLEN").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                page.value_bytes = len;
                page.total = 1;
                if !full && len > STRING_PREVIEW_THRESHOLD {
                    let mut bytes: Vec<u8> = redis::cmd("GETRANGE")
                        .arg(key)
                        .arg(0)
                        .arg(STRING_PREVIEW_BYTES - 1)
                        .query_async(&mut conn)
                        .await
                        .map_err(to_err)?;
                    // 預覽可能剛好切在多位元組字元中間：去掉結尾不完整的那幾個位元組，不算二進位。
                    trim_incomplete_utf8_tail(&mut bytes);
                    page.members = vec![text(bytes)];
                    page.truncated = true;
                } else {
                    let v: Option<Vec<u8>> = conn.get(key).await.map_err(to_err)?;
                    page.members = vec![text(v.unwrap_or_default())];
                }
            }
            "list" => {
                let total: i64 =
                    redis::cmd("LLEN").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                page.total = total;
                let start = cursor as i64;
                let stop = start + count as i64 - 1;
                let items: Vec<Vec<u8>> = redis::cmd("LRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(stop)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?;
                let fetched = items.len();
                let items = items.into_iter().map(&mut text);
                // 把「原始 list 索引」放在 scores 一起回給前端：過濾後 i 只是顯示序号，
                // 直接拿去 LSET 會改到別的元素（例如 [a,b,c,d] 過濾 b 後编辑會覆蓋 a）。
                let mut members = Vec::new();
                let mut indices = Vec::new();
                for (i, s) in items.enumerate() {
                    if filter.is_empty() || s.contains(filter) {
                        indices.push((start + i as i64) as f64);
                        members.push(s);
                    }
                }
                page.scores = indices;
                page.members = members;
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
                    let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("SSCAN")
                        .arg(key)
                        .arg(cur)
                        .arg("MATCH")
                        .arg(&match_pat)
                        .arg("COUNT")
                        .arg(count)
                        .query_async(&mut conn)
                        .await
                        .map_err(to_err)?;
                    page.members.extend(batch.into_iter().map(&mut text));
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
                    let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("HSCAN")
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
                        page.fields.push(text(f));
                        page.members.push(text(v));
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
                    let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("ZSCAN")
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
                        page.members.push(text(m));
                        page.scores.push(String::from_utf8_lossy(&s).parse::<f64>().unwrap_or(0.0));
                    }
                    cur = next;
                    if cur == 0 || page.members.len() >= count {
                        break;
                    }
                }
                page.cursor = cur;
            }
            "stream" => {
                page.total = redis::cmd("XLEN").arg(key).query_async(&mut conn).await.unwrap_or(-1);
                // 下一頁的起點 = 上一頁最後一個 ID 的下一號（包含式區間）。不用 `(id` 排他區間：那要 Redis 6.2+。
                let mut start = after_id.map(next_stream_id).unwrap_or_else(|| "-".to_string());
                let mut last_id: Option<String> = None;
                let mut hit_scan_cap = false;
                // 有過濾時要一直往後撈到「湊滿一頁符合的」或到底，否則稀有符合項會藏在
                // 被丟掉的原始頁裡，使用者看到空頁 + 一個永遠載不完的「載入更多」。
                for page_no in 0..20 {
                    let raw: redis::Value = redis::cmd("XRANGE")
                        .arg(key)
                        .arg(&start)
                        .arg("+")
                        .arg("COUNT")
                        .arg(count)
                        .query_async(&mut conn)
                        .await
                        .map_err(to_err)?;
                    let entries = parse_stream_entries(raw);
                    let fetched = entries.len();
                    if fetched == 0 { break; }
                    for (id, kvs) in entries {
                        let id = text(id);
                        let pairs: Vec<(String, String)> = kvs.into_iter().map(|(f, v)| (text(f), text(v))).collect();
                        let body = stream_fields_json(&pairs);
                        if filter.is_empty() || id.contains(filter) || body.contains(filter) {
                            page.fields.push(id.clone());
                            page.members.push(body);
                        }
                        last_id = Some(id);
                        if page.members.len() >= count { break; }
                    }
                    let next = next_stream_id(last_id.as_deref().unwrap_or(&start));
                    let exhausted = fetched < count || next == start;
                    start = next;
                    if page.members.len() >= count || exhausted {
                        // 20 頁上限到了但還沒撈滿、也不是真的到底 → 仍要給下一頁起點，
                        // 否則稀疏過濾的符合項會被藏在後面，使用者再也載不到。
                        if page_no == 19 && !exhausted { hit_scan_cap = true; }
                        break;
                    }
                }
                page.next_id = if page.members.len() >= count || hit_scan_cap { last_id } else { None };
                page.cursor = u64::from(page.next_id.is_some());
                if after_id.is_none() {
                    // 群組資訊只在第一頁取；XINFO 失敗（舊版 / 權限）不影響項目本身。
                    let info: Option<redis::Value> =
                        redis::cmd("XINFO").arg("GROUPS").arg(key).query_async(&mut conn).await.ok();
                    page.groups = info.map(parse_stream_groups).unwrap_or_default();
                }
            }
            _ => {}
        }
        page.binary = page_bin;
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
            .map_err(rerr)?;
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
                        id: rv_as_i64(f.first()),
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
            .map_err(rerr)?;
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
            .map_err(rerr)?;
        Ok(())
    }

    /// 大鍵掃描：SCAN 取樣 sample 個鍵，逐一 MEMORY USAGE，回傳前 top 名。
    /// 取樣式（非全量），避免在大型實例上長時間鎖佔；sample 上限保護。
    pub async fn big_keys(&self, database: &str, sample: usize, top: usize) -> AppResult<Vec<BigKey>> {
        self.big_keys_filtered(database, None, sample, top).await
    }

    /// 限定命名空間的大鍵分析（ARDM 的 Memory Analysis in folder）：pattern 由呼叫端把
    /// 前綴轉成 SCAN MATCH 樣式，只對該前綴下的鍵取樣 MEMORY USAGE。
    pub async fn big_keys_filtered(
        &self,
        database: &str,
        prefix: Option<&str>,
        sample: usize,
        top: usize,
    ) -> AppResult<Vec<BigKey>> {
        let sample = sample.clamp(1, 100_000);
        let top = top.clamp(1, 1_000);
        let pattern = prefix.map(redis_prefix_glob);
        let mut conn = self.conn(database).await?;
        let to_err = rerr;
        let mut all: Vec<BigKey> = Vec::new();
        let mut scanned = 0usize;
        let mut cursor: u64 = 0;
        loop {
            let mut cmd = redis::cmd("SCAN");
            cmd.arg(cursor);
            if let Some(p) = pattern.as_deref() {
                cmd.arg("MATCH").arg(p);
            }
            let (next, batch): (u64, Vec<Vec<u8>>) = cmd
                .arg("COUNT")
                .arg(500)
                .query_async(&mut conn)
                .await
                .map_err(to_err)?;
            // 只取樣到 sample 上限。
            // 保留原始位元組送 MEMORY USAGE：非 UTF-8 鍵名解碼成跳脫字串後就不是那個鍵了。
            let take: Vec<Vec<u8>> = batch.into_iter().take(sample.saturating_sub(scanned)).collect();
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
                    all.push(BigKey { key: decode_bytes(k.clone()).0, type_: ktype, bytes, ttl });
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

    /// 複製鍵到新名稱（DUMP + RESTORE）：保留型別 / 值 / TTL，連 RedisJSON、Stream 等模組型別也行，
    /// 不用為每種型別寫一套複製邏輯。目標已存在時不給 REPLACE，避免靜默覆寫別人的資料。
    pub async fn clone_key(&self, database: &str, source: &str, target: &str) -> AppResult<()> {
        let mut conn = self.conn(database).await?;
        let dump: redis::Value = redis::cmd("DUMP").arg(source).query_async(&mut conn).await.map_err(rerr)?;
        let redis::Value::BulkString(payload) = dump else {
            return Err(AppError::Query(t!("來源鍵不存在，無法複製").to_string()));
        };
        let pttl: i64 = redis::cmd("PTTL").arg(source).query_async(&mut conn).await.map_err(rerr)?;
        let _: () = redis::cmd("RESTORE")
            .arg(target)
            .arg(clone_restore_ttl_ms(pttl))
            .arg(payload)
            .query_async(&mut conn)
            .await
            .map_err(rerr)?;
        Ok(())
    }

    /// 同 scan_keys，但用 SCAN 的 TYPE 選項在伺服器端過濾型別（Redis 6+）。
    /// 不為每個鍵打 TYPE，大型 keyspace 也只多一個 SCAN 參數。
    pub async fn scan_keys_typed(
        &self,
        database: &str,
        pattern: &str,
        type_filter: &str,
        limit: usize,
    ) -> AppResult<RedisKeys> {
        if type_filter.trim().is_empty() {
            return self.scan_keys(database, pattern, limit).await;
        }
        if !self.supports_scan_type {
            return self.scan_keys_typed_client(database, pattern, type_filter, limit).await;
        }
        let limit = limit.max(1);
        let pattern = if pattern.is_empty() { "*" } else { pattern };
        let mut conn = self.conn(database).await?;
        let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut cursor: u64 = 0;
        let mut truncated = false;
        loop {
            let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
                .arg(cursor).arg("MATCH").arg(pattern)
                .arg("COUNT").arg(1000)
                .arg("TYPE").arg(type_filter)
                .query_async(&mut conn).await.map_err(rerr)?;
            set.extend(decode_keys(batch));
            cursor = next;
            if cursor == 0 { break; }
            if set.len() >= limit { truncated = true; break; }
        }
        let mut keys: Vec<String> = set.into_iter().collect();
        // SCAN 的 COUNT 是建議值，最後一批可能一次帶回超過 limit 個鍵；
        // 即使游標已歸零，被 truncate 掉也算截斷，要讓前端顯示上限警告。
        if keys.len() > limit {
            keys.truncate(limit);
            truncated = true;
        }
        Ok(RedisKeys { keys, truncated })
    }

    /// Redis < 6 沒有 SCAN TYPE：先照常 SCAN，再用 pipeline 對鍵取 TYPE 在客戶端挑。
    /// 多掃一些以補足過濾後的 limit；真的掃不完就照樣標 truncated。
    async fn scan_keys_typed_client(
        &self,
        database: &str,
        pattern: &str,
        type_filter: &str,
        limit: usize,
    ) -> AppResult<RedisKeys> {
        let limit = limit.max(1);
        let scan_limit = limit.saturating_mul(10).clamp(1, 100_000);
        let scanned = self.scan_keys(database, pattern, scan_limit).await?;
        let mut conn = self.conn(database).await?;
        let mut out: Vec<String> = Vec::new();
        for chunk in scanned.keys.chunks(500) {
            let mut pipe = redis::pipe();
            for k in chunk { pipe.cmd("TYPE").arg(k); }
            let vals: Vec<redis::Value> = pipe.query_async(&mut conn).await.map_err(rerr)?;
            for (k, v) in chunk.iter().zip(vals.into_iter()) {
                if rv_to_string(&v) == type_filter { out.push(k.clone()); }
            }
        }
        let truncated = scanned.truncated || out.len() > limit;
        out.truncate(limit);
        Ok(RedisKeys { keys: out, truncated })
    }

    /// 抽樣統計 keyspace：SCAN 取樣 + pipeline TYPE / MEMORY USAGE，聚合出各型別的
    /// 鍵數與記憶體用量（RedisInsight 的 Analysis 概念）。不影響線上服務。
    pub async fn keyspace_summary(&self, database: &str, sample: usize) -> AppResult<RedisKeyspaceSummary> {
        let sample = sample.clamp(100, 100_000);
        let mut conn = self.conn(database).await?;
        let total_keys: i64 = redis::cmd("DBSIZE").query_async(&mut conn).await.unwrap_or(-1);
        let mut entries: Vec<(String, i64)> = Vec::new();
        let mut memory_unavailable = false;
        let mut cursor: u64 = 0;
        loop {
            let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
                .arg(cursor).arg("COUNT").arg(500)
                .query_async(&mut conn).await.map_err(rerr)?;
            let take: Vec<Vec<u8>> = batch.into_iter().take(sample.saturating_sub(entries.len())).collect();
            if !take.is_empty() {
                let mut pipe = redis::pipe();
                for k in &take {
                    pipe.cmd("TYPE").arg(k);
                    if !memory_unavailable {
                        pipe.cmd("MEMORY").arg("USAGE").arg(k);
                    }
                }
                // 託管 Redis 常停用 MEMORY USAGE；一個命令錯會讓整條 pipeline 失敗，
                // 這時退回只問 TYPE，至少給出型別分佈，不要整頁顯示錯誤。
                let (vals, stride) = match pipe.query_async::<Vec<redis::Value>>(&mut conn).await {
                    Ok(v) => (v, if memory_unavailable { 1 } else { 2 }),
                    Err(_) => {
                        memory_unavailable = true;
                        let mut tp = redis::pipe();
                        for k in &take { tp.cmd("TYPE").arg(k); }
                        (tp.query_async::<Vec<redis::Value>>(&mut conn).await.unwrap_or_default(), 1)
                    }
                };
                for pair in vals.chunks(stride) {
                    let ty = pair.first().map(rv_to_string).unwrap_or_else(|| "unknown".into());
                    let bytes = pair.get(1).map(|v| rv_as_i64(Some(v))).unwrap_or(0).max(0);
                    entries.push((ty, bytes));
                }
            }
            cursor = next;
            if cursor == 0 || entries.len() >= sample { break; }
        }
        let total_bytes = entries.iter().map(|(_, b)| *b).sum();
        Ok(RedisKeyspaceSummary {
            sampled: entries.len(),
            total_keys,
            total_bytes,
            types: aggregate_keyspace(&entries),
            memory_unavailable,
        })
    }

    /// 把 TTL 指令接進既有 pipeline：每鍵原本還要一次 EXPIRE/PERSIST 往返，
/// 匯入上萬鍵時等於多上萬次序列化 Round-trip。
fn pipe_ttl(pipe: &mut redis::Pipeline, key: &str, ttl: i64) {
    if ttl >= 0 { pipe.cmd("EXPIRE").arg(key).arg(ttl).ignore(); }
    else { pipe.cmd("PERSIST").arg(key).ignore(); }
}

/// 從匯出的 JSON 還原鍵（仿 ARDM 的 Import keys）：只處理 string / hash / list / set / zset，
    /// stream 與模組型別無法從一般 value 表示，明確略過並計入 skipped。
    pub async fn import_keys(&self, database: &str, items: Vec<RedisImportKey>) -> AppResult<RedisImportSummary> {
        let mut conn = self.conn(database).await?;
        let mut summary = RedisImportSummary { imported: 0, skipped: 0 };
        for item in items {
            if !import_key_valid(&item) { summary.skipped += 1; continue; }
            let written = match item.type_.as_str() {
                "string" => {
                    let v = item.value.as_str().unwrap_or("");
                    let mut pipe = redis::pipe();
                    pipe.atomic();
                    if item.ttl >= 0 {
                        // SET key val EX secs：一條指令同時寫值與到期時間。
                        pipe.cmd("SET").arg(&item.key).arg(v).arg("EX").arg(item.ttl).ignore();
                    } else {
                        pipe.cmd("SET").arg(&item.key).arg(v).ignore();
                    }
                    pipe.query_async::<()>(&mut conn).await.is_ok()
                }
                "hash" => {
                    let mut pipe = redis::pipe();
                    pipe.atomic().del(&item.key).ignore();
                    for pair in item.value.as_array().unwrap() {
                        pipe.hset(&item.key, pair["field"].as_str().unwrap_or(""), pair["value"].as_str().unwrap_or("")).ignore();
                    }
                    Self::pipe_ttl(&mut pipe, &item.key, item.ttl);
                    pipe.query_async::<()>(&mut conn).await.is_ok()
                }
                "list" | "set" => {
                    let mut pipe = redis::pipe();
                    pipe.atomic().del(&item.key).ignore();
                    for v in item.value.as_array().unwrap() {
                        let s = v.as_str().unwrap_or("");
                        if item.type_ == "list" { pipe.rpush(&item.key, s).ignore(); }
                        else { pipe.sadd(&item.key, s).ignore(); }
                    }
                    Self::pipe_ttl(&mut pipe, &item.key, item.ttl);
                    pipe.query_async::<()>(&mut conn).await.is_ok()
                }
                "zset" => {
                    let mut pipe = redis::pipe();
                    pipe.atomic().del(&item.key).ignore();
                    for v in item.value.as_array().unwrap() {
                        let member = v["member"].as_str().unwrap_or("");
                        let score = parse_import_score(&v["score"]).unwrap_or(0.0);
                        pipe.zadd(&item.key, member, score).ignore();
                    }
                    Self::pipe_ttl(&mut pipe, &item.key, item.ttl);
                    pipe.query_async::<()>(&mut conn).await.is_ok()
                }
                _ => false,
            };
            // TTL 已隨各分支的 pipeline 一起送出（string 用 SET ... EX），這裡不再多打一次往返。
            if !written { summary.skipped += 1; continue; }
            summary.imported += 1;
        }
        self.invalidate_snapshot().await;
        Ok(summary)
    }

    /// 批次刪除鍵（DEL，分批 pipeline），回傳實際被刪除的鍵數。
    /// 走「明確鍵名清單」而非 pattern：命名空間批次刪除由呼叫端先算好要刪哪些鍵，
    /// 鍵名內含 glob 字元（* ? [）也不會誤傷旁邊的鍵。
    pub async fn delete_keys(&self, database: &str, keys: &[String]) -> AppResult<u64> {
        if keys.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn(database).await?;
        let mut removed: i64 = 0;
        // 分批送出：單次 DEL 參數過多會撐大 RESP 封包並長時間佔用單執行緒的 Redis。
        for chunk in keys.chunks(500) {
            let mut cmd = redis::cmd("DEL");
            for k in chunk {
                cmd.arg(k.as_str());
            }
            let n: i64 = cmd
                .query_async(&mut conn)
                .await
                .map_err(rerr)?;
            removed += n;
        }
        self.invalidate_snapshot().await; // 刪鍵後翻頁不應再看到殭屍鍵
        Ok(removed as u64)
    }

    /// 批次設定 TTL：把整批 keys 的 EXPIRE / PERSIST 管線化，
    /// 避免多選上萬鍵時對 IPC 與 Redis 各打上萬次序列化往返。
    pub async fn set_ttl_many(&self, database: &str, keys: &[String], secs: i64) -> AppResult<u64> {
        if keys.is_empty() { return Ok(0); }
        let mut conn = self.conn(database).await?;
        let mut applied = 0u64;
        for chunk in keys.chunks(500) {
            let mut pipe = redis::pipe();
            for k in chunk {
                if secs < 0 { pipe.cmd("PERSIST").arg(k.as_str()); }
                else { pipe.cmd("EXPIRE").arg(k.as_str()).arg(secs); }
            }
            let results: Vec<redis::Value> = pipe.query_async(&mut conn).await.map_err(rerr)?;
            applied += results.iter().filter(|v| rv_as_i64(Some(v)) > 0).count() as u64;
        }
        Ok(applied)
    }

    /// 設定 / 解除鍵的存活時間。`secs < 0` → PERSIST（永不過期）；否則 EXPIRE。
    /// 回傳 true 表示鍵存在且已套用。
    pub async fn expire_key(&self, database: &str, key: &str, secs: i64) -> AppResult<bool> {
        let mut conn = self.conn(database).await?;
        let cmd = if secs < 0 { "PERSIST" } else { "EXPIRE" };
        let mut c = redis::cmd(cmd);
        c.arg(key);
        if secs >= 0 {
            c.arg(secs);
        }
        let n: i64 = c
            .query_async(&mut conn)
            .await
            .map_err(rerr)?;
        Ok(n == 1)
    }

    /// 發佈訊息到頻道（PUBLISH），回傳收到的訂閱者數。
    pub async fn publish(&self, channel: &str, message: &str) -> AppResult<i64> {
        let mut conn = self.admin_conn().await?;
        redis::cmd("PUBLISH")
            .arg(channel)
            .arg(message)
            .query_async(&mut conn)
            .await
            .map_err(rerr)
    }
}

#[async_trait::async_trait]
impl DatabaseDriver for RedisDriver {
    async fn connect(config: &ConnectionConfig) -> AppResult<Self> {
        // 主機欄被貼進整段 StackExchange.Redis 設定字串（`h:6379,abortConnect=false,…`）時，
        // redis crate 只會回「URL did not parse」，看不出原因；直接講清楚該怎麼改。
        if config.host.contains(',') || config.host.contains('=') {
            return Err(AppError::Connect(tf!(
                "主機欄含有逗號或等號：{host}。這看起來是 StackExchange.Redis 連線字串，請貼到上方「連線字串」欄按「解析並填入」，主機欄只留主機名稱。",
                host = config.host
            )));
        }
        // TLS：options["redis_tls"]=="true" → 加密連線；redis_tls_insecure → 略過憑證驗證（自簽 / 內網）。
        let use_tls = config.options.get("redis_tls").is_some_and(|v| v == "true");
        let tls_insecure = config.options.get("redis_tls_insecure").is_some_and(|v| v == "true");
        let mut info = connection_info(config, use_tls, tls_insecure);
        // Sentinel 模式：_host:_port 指向 Sentinel 節點，選項給 master 名稱；先問 Sentinel
        // 目前 master 的實際位址，後續所有 DB 連線都打到 master（仿 ARDM 的 Sentinel Support）。
        if let Some(master) = sentinel_master(config).filter(|s| !s.is_empty()) {
            let mut sentinel = redis::sentinel::Sentinel::build(vec![info.clone()])
                .map_err(|e| AppError::Connect(format!("建立 Sentinel 失敗：{e}")))?;
            // 不帶 SentinelNodeConnectionInfo 的話，找到的 master 連線會沒有帳密 / TLS，
            // 之後每次操作都 NOAUTH 或 TLS 失敗。要把原本的認證與加密設定一併帶過去。
            let node = redis::sentinel::SentinelNodeConnectionInfo {
                tls_mode: use_tls.then(|| {
                    if tls_insecure { redis::TlsMode::Insecure } else { redis::TlsMode::Secure }
                }),
                redis_connection_info: Some(info.redis.clone()),
            };
            let master_client = sentinel
                .async_master_for(master, Some(&node))
                .await
                .map_err(|e| AppError::Connect(format!("找不到 Sentinel master「{master}」：{e}")))?;
            info = master_client.get_connection_info().clone();
        }

        // 基礎 client 供 pub/sub 用（同一份連線參數，加密連線的訂閱也走 TLS）。
        let client = redis::Client::open(info.clone()).map_err(|e| AppError::Connect(e.to_string()))?;

        let driver = Self {
            client,
            info,
            db_count: 16, // 下方讀 CONFIG GET databases 覆寫；讀不到（如託管 Redis 禁 CONFIG）維持 16。
            supports_scan_type: false,
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
            return Err(AppError::Connect(tf!("非預期的 PING 回應：{pong}", pong = pong)));
        }
        // Redis Cluster 只有 DB 0（SELECT 其他庫一律報錯），但 CONFIG GET databases 照樣回 16，
        // 樹上就會列出 15 個點了只會報錯的庫。
        let cluster = redis::cmd("INFO")
            .arg("cluster")
            .query_async::<String>(&mut conn)
            .await
            .is_ok_and(|s| s.contains("cluster_enabled:1"));
        let db_count = if cluster {
            1
        } else {
            redis::cmd("CONFIG")
                .arg("GET")
                .arg("databases")
                .query_async::<Vec<String>>(&mut conn)
                .await
                .ok()
                .and_then(|v| v.get(1).and_then(|s| s.parse::<i64>().ok()))
                .unwrap_or(16)
        };

        // 順手讀一次版本，避免在每次點型別下拉時才發現 SCAN TYPE 不支援。
        let info_server: String = redis::cmd("INFO")
            .arg("server")
            .query_async(&mut conn)
            .await
            .unwrap_or_default();
        let supports_scan_type = redis_version_at_least(&info_server, 6);
        Ok(Self { db_count, supports_scan_type, ..driver })
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
            Err(AppError::Connect(tf!("非預期的 PING 回應：{pong}", pong = pong)))
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
                extra: t!("秒；-1 表示無到期").to_string(),
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
                        "like" => glob_like_pattern(v),
                        "=" => glob_escape(v),
                        _ => pattern,
                    };
                }
            }
        }

        // 取（或重建）鍵快照後切出該頁；翻頁不重掃整個 keyspace（見 paged_keys）。
        let (total, page_keys, truncated) = self
            .paged_keys(&mut conn, database, &pattern, query.page, query.page_size)
            .await?;

        // 對該頁 key 以 pipeline 一次取回 type + ttl（100 keys 從 200 次往返降到 1 次）。
        let rows = fetch_key_meta(&mut conn, &page_keys).await?;

        Ok(PagedData {
            columns: vec!["key".to_string(), "type".to_string(), "ttl".to_string()],
            rows,
            total_rows: total,
            truncated,
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
            return Err(AppError::Query(t!("空命令").to_string()));
        }
        let policy = console_policy(&parts);
        if let ConsolePolicy::Reject(msg) = policy {
            return Err(AppError::Query(msg));
        }
        let mut cmd = redis::cmd(&parts[0]);
        for p in &parts[1..] {
            cmd.arg(p.as_str());
        }
        // 以通用 Value 取回，轉成字串列。
        let val: redis::Value = if policy == ConsolePolicy::Dedicated {
            // 阻塞指令開一條用完即丟的連線：放在共用的多工連線上，伺服器端整條連線會被卡住，
            // 樹狀、網格、其他分頁排在它後面的指令全部跟著等（外層逾時只丟掉 future，伺服器照樣卡著）。
            let mut info = self.info.clone();
            info.redis.db = db.parse().unwrap_or(0);
            let client = redis::Client::open(info).map_err(|e| AppError::Connect(e.to_string()))?;
            let cfg = redis::AsyncConnectionConfig::new()
                .set_connection_timeout(std::time::Duration::from_secs(10))
                .set_response_timeout(std::time::Duration::from_secs(BLOCKING_MAX_SECS));
            let mut conn = client
                .get_multiplexed_async_connection_with_config(&cfg)
                .await
                .map_err(|e| AppError::Connect(e.to_string()))?;
            cmd.query_async(&mut conn).await.map_err(|e| {
                if e.is_timeout() {
                    AppError::Query(tf!(
                        "阻塞指令等了 {secs} 秒沒有結果，已中斷。主控台一次最多等 {secs} 秒，請把逾時參數設小一點（0 代表永遠等）。",
                        secs = BLOCKING_MAX_SECS
                    ))
                } else {
                    AppError::Query(e.to_string())
                }
            })?
        } else {
            let mut conn = self.conn(&db).await?;
            cmd.query_async(&mut conn)
                .await
                .map_err(rerr)?
        };
        let rows = redis_value_to_rows(&val);
        Ok(QueryResult {
            columns: vec!["result".to_string()],
            rows,
            rows_affected: 0,
            truncated: false,
        })
    }

    async fn query_capped(&self, sql: &str, cap: usize) -> AppResult<QueryResult> {
        // Redis 回覆整包已在記憶體（RESP 一次回完），截斷只省 IPC 與前端渲染量。
        let mut r = self.query(sql).await?;
        if cap > 0 && r.rows.len() > cap {
            r.rows.truncate(cap);
            r.truncated = true;
        }
        Ok(r)
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
                    .map_err(|_| AppError::Query(t!("TTL 必須為整數").to_string()))?;
                if secs < 0 {
                    let _: i64 = conn
                        .persist(&key)
                        .await
                        .map_err(rerr)?;
                } else {
                    let _: bool = conn
                        .expire(&key, secs)
                        .await
                        .map_err(rerr)?;
                }
                Ok(1)
            }
            "key" => Err(AppError::Query(t!("不支援直接改 key 名稱，請用 RENAME").to_string())),
            // type 為唯讀的型別中介資料；若以 SET 寫入會把 list/set/zset/hash 覆蓋成 string、
            // 造成資料遺失，故明確拒絕（避免誤觸格內編輯）。
            "type" => Err(AppError::Query(t!("type 欄為唯讀，無法編輯").to_string())),
            // 其餘（string value 編輯）：對 string 型別做 SET
            _ => {
                let v = edit.new_value.clone().unwrap_or_default();
                let _: () = conn
                    .set(&key, v)
                    .await
                    .map_err(rerr)?;
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
        let key = key.ok_or_else(|| AppError::Query(t!("缺少 key").to_string()))?;
        let value = value.unwrap_or_default();
        let mut conn = self.conn(database).await?;
        // SET NX：「新增」不可以覆蓋既有的鍵。以前直接 SET，同名鍵不論是什麼型別（hash、list…）
        // 都被靜默換成這個字串，原本的資料就沒了。
        let created: Option<String> = redis::cmd("SET")
            .arg(&key)
            .arg(value)
            .arg("NX")
            .query_async(&mut conn)
            .await
            .map_err(rerr)?;
        if created.is_none() {
            return Err(AppError::Query(tf!(
                "鍵「{key}」已存在，為避免覆蓋已取消新增。要改值請直接開啟該鍵編輯。",
                key = key
            )));
        }
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
            .map_err(rerr)?;
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
            .map_err(rerr)?;
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
                        .map_err(rerr)?;
                    detail.entries = vec![String::from_utf8_lossy(&bytes).into_owned()];
                } else {
                    let v: Option<Vec<u8>> = conn
                        .get(key)
                        .await
                        .map_err(rerr)?;
                    detail.entries = vec![decode_bytes(v.unwrap_or_default()).0];
                }
            }
            "list" => {
                let items: Vec<Vec<u8>> = conn
                    .lrange(key, 0, -1)
                    .await
                    .map_err(rerr)?;
                detail.entries = decode_keys(items);
            }
            "set" => {
                let items: Vec<Vec<u8>> = conn
                    .smembers(key)
                    .await
                    .map_err(rerr)?;
                detail.entries = decode_keys(items);
            }
            "zset" => {
                // 帶分數取回（member, score 交錯）
                let pairs: Vec<(Vec<u8>, f64)> = conn
                    .zrange_withscores(key, 0, -1)
                    .await
                    .map_err(rerr)?;
                for (m, s) in pairs {
                    detail.entries.push(decode_bytes(m).0);
                    detail.scores.push(s);
                }
            }
            "hash" => {
                let pairs: Vec<(Vec<u8>, Vec<u8>)> = conn
                    .hgetall(key)
                    .await
                    .map_err(rerr)?;
                for (f, v) in pairs {
                    detail.fields.push(decode_bytes(f).0);
                    detail.entries.push(decode_bytes(v).0);
                }
            }
            _ => {}
        }
        Ok(Some(detail))
    }

    async fn key_edit(&self, database: &str, key: &str, edit: &KeyEdit) -> AppResult<u64> {
        let mut conn = self.conn(database).await?;
        let to_err = rerr;
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
            KeyEdit::ListRemoveAt { index } => {
                // 哨兵要唯一，否則 LREM 可能刪到原本就存在同名值的元素。
                let sentinel = format!("__dbkit_del_{}__", uuid::Uuid::new_v4());
                let removed: i64 = redis::cmd("EVAL")
                    .arg(LUA_LIST_REMOVE_AT)
                    .arg(1)
                    .arg(key)
                    .arg(*index)
                    .arg(&sentinel)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?;
                if removed == 0 {
                    return Err(AppError::Query(t!("索引超出範圍，沒有移除元素").to_string()));
                }
                removed
            }
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
            KeyEdit::SetRename { from, to } => {
                let result: i64 = redis::cmd("EVAL")
                    .arg(LUA_SET_RENAME)
                    .arg(1)
                    .arg(key)
                    .arg(from)
                    .arg(to)
                    .query_async(&mut conn)
                    .await
                    .map_err(to_err)?;
                match result {
                    -1 => return Err(AppError::Query(tf!(
                        "目標成員「{to}」已存在，為避免合併而取消改名", to = to
                    ))),
                    0 => return Err(AppError::Query(tf!(
                        "來源成員「{from}」不存在，無法改名", from = from
                    ))),
                    _ => 1,
                }
            }
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
            KeyEdit::StreamAdd { fields } => {
                if fields.is_empty() {
                    return Err(AppError::Query(t!("stream 項目至少要有一個欄位").to_string()));
                }
                let mut c = redis::cmd("XADD");
                c.arg(key).arg("*");
                for (f, v) in fields {
                    c.arg(f).arg(v);
                }
                let _: redis::Value = c.query_async(&mut conn).await.map_err(to_err)?;
                1
            }
            KeyEdit::StreamDelete { id } => redis::cmd("XDEL")
                .arg(key)
                .arg(id)
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
                    return Err(AppError::Query(tf!(
                        "目標鍵「{new_key}」已存在，為避免覆蓋而取消改名",
                        new_key = new_key
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
            .map_err(rerr)?;
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
            let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(1000)
                .query_async(&mut conn)
                .await
                .map_err(rerr)?;
            set.extend(decode_keys(batch));
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

/// Redis 回來的位元組 → 顯示字串。合法 UTF-8 原樣回傳；否則照 redis-cli 的習慣把壞掉的位元組寫成 `\xHH`
///（反斜線本身寫成 `\\`，免得和跳脫混在一起），並回報 true。
fn decode_bytes(b: Vec<u8>) -> (String, bool) {
    match String::from_utf8(b) {
        Ok(s) => (s, false),
        Err(e) => (escape_binary(e.as_bytes()), true),
    }
}

fn escape_binary(b: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(b.len() * 2);
    for chunk in b.utf8_chunks() {
        for ch in chunk.valid().chars() {
            if ch == '\\' {
                out.push_str("\\\\");
            } else {
                out.push(ch);
            }
        }
        for x in chunk.invalid() {
            let _ = write!(out, "\\x{x:02x}");
        }
    }
    out
}

/// 截斷的預覽若剛好切在多位元組字元中間，去掉結尾那幾個不完整的位元組（最多 3 個）。
/// 只處理「結尾不完整」；中間真的有非 UTF-8 位元組的照舊算二進位。
fn trim_incomplete_utf8_tail(bytes: &mut Vec<u8>) {
    if let Err(e) = std::str::from_utf8(bytes) {
        if e.error_len().is_none() {
            bytes.truncate(e.valid_up_to());
        }
    }
}

/// 鍵名清單解碼：非 UTF-8 鍵名以 `\xHH` 顯示（清單不會因為一個怪鍵名整頁失敗）。
fn decode_keys(keys: Vec<Vec<u8>>) -> Vec<String> {
    keys.into_iter().map(|k| decode_bytes(k).0).collect()
}

/// stream ID `毫秒-序號` 的下一號，給 XRANGE 當包含式起點。解析不了就原樣回傳（最多重複一筆，不會漏）。
fn next_stream_id(id: &str) -> String {
    let Some((ms, seq)) = id.split_once('-') else { return id.to_string() };
    match (ms.parse::<u64>(), seq.parse::<u64>()) {
        (Ok(ms), Ok(seq)) if seq < u64::MAX => format!("{ms}-{}", seq + 1),
        (Ok(ms), Ok(_)) if ms < u64::MAX => format!("{}-0", ms + 1),
        _ => id.to_string(),
    }
}

/// XRANGE 回覆 → [(ID, [(欄位, 值)])]，一律保留原始位元組（呼叫端再解碼）。
fn parse_stream_entries(v: redis::Value) -> Vec<(Vec<u8>, Vec<(Vec<u8>, Vec<u8>)>)> {
    let bytes = |v: redis::Value| match v {
        redis::Value::BulkString(b) => b,
        redis::Value::SimpleString(s) => s.into_bytes(),
        other => rv_to_string(&other).into_bytes(),
    };
    let redis::Value::Array(items) = v else { return Vec::new() };
    items
        .into_iter()
        .filter_map(|it| {
            let redis::Value::Array(mut pair) = it else { return None };
            if pair.len() < 2 {
                return None;
            }
            let kv = pair.pop()?;
            let id = bytes(pair.pop()?);
            let flat: Vec<Vec<u8>> = match kv {
                redis::Value::Array(xs) => xs.into_iter().map(bytes).collect(),
                redis::Value::Map(xs) => xs.into_iter().flat_map(|(k, v)| [bytes(k), bytes(v)]).collect(),
                _ => Vec::new(),
            };
            let mut it = flat.into_iter();
            let mut kvs = Vec::new();
            while let (Some(f), Some(v)) = (it.next(), it.next()) {
                kvs.push((f, v));
            }
            Some((id, kvs))
        })
        .collect()
}

/// 項目欄位 → 照原順序的 JSON 物件字串（serde_json 的 Map 預設會依鍵排序，所以自己組）。
fn stream_fields_json(pairs: &[(String, String)]) -> String {
    let body: Vec<String> = pairs
        .iter()
        .map(|(f, v)| {
            format!(
                "{}:{}",
                serde_json::to_string(f).unwrap_or_default(),
                serde_json::to_string(v).unwrap_or_default()
            )
        })
        .collect();
    format!("{{{}}}", body.join(","))
}

/// XINFO GROUPS 回覆（每個群組是 `名稱, 值, 名稱, 值…` 的扁平陣列，RESP3 則是 map）。
fn parse_stream_groups(v: redis::Value) -> Vec<StreamGroup> {
    let redis::Value::Array(groups) = v else { return Vec::new() };
    groups
        .into_iter()
        .map(|g| {
            let pairs: Vec<(String, redis::Value)> = match g {
                redis::Value::Array(xs) => {
                    let mut it = xs.into_iter();
                    let mut out = Vec::new();
                    while let (Some(k), Some(v)) = (it.next(), it.next()) {
                        out.push((rv_to_string(&k), v));
                    }
                    out
                }
                redis::Value::Map(xs) => xs.into_iter().map(|(k, v)| (rv_to_string(&k), v)).collect(),
                _ => Vec::new(),
            };
            let get = |name: &str| pairs.iter().find(|(k, _)| k == name).map(|(_, v)| v);
            StreamGroup {
                name: get("name").map(rv_to_string).unwrap_or_default(),
                consumers: rv_as_i64(get("consumers")),
                pending: rv_as_i64(get("pending")),
                last_delivered_id: get("last-delivered-id").map(rv_to_string).unwrap_or_default(),
                lag: get("lag").and_then(|v| match v {
                    redis::Value::Nil => None,
                    other => Some(rv_as_i64(Some(other))),
                }),
            }
        })
        .collect()
}

/// redis 錯誤 → AppError。Redis Cluster 的 MOVED / ASK 只會說「Moved: 1234 10.0.0.2:6379」，
/// 看不出是什麼意思：講明這是 Cluster、鍵在哪個節點、要怎麼辦。
fn rerr(e: redis::RedisError) -> AppError {
    if let Some((node, slot)) = e.redirect_node() {
        return AppError::Query(tf!(
            "這是 Redis Cluster：這個鍵屬於雜湊槽 {slot}，存放在另一個節點 {node}。DB Kit 目前一次只連一個節點，請另外建立一個連到 {node} 的連線來操作它。",
            slot = slot,
            node = node
        ));
    }
    AppError::Query(e.to_string())
}

/// 主控台阻塞指令最多等幾秒（之後中斷那條專屬連線）。
const BLOCKING_MAX_SECS: u64 = 60;

/// 主控台指令怎麼送。
#[derive(Debug, PartialEq)]
enum ConsolePolicy {
    /// 走該 DB 共用的連線。
    Shared,
    /// 阻塞指令：開一條專屬連線、有上限地等。
    Dedicated,
    /// 不送，回傳原因。
    Reject(String),
}

/// 判斷主控台的一行指令能不能送、該走哪條連線。
///
/// 主控台和樹狀 / 網格 / 鍵詳情共用同一條多工連線（每個 DB 一條），會改變「連線狀態」的指令
/// 送上去，影響的是整個 App：`SELECT 3` 之後畫面上標著 DB 0 的操作全打到 DB 3；`MULTI` 之後
/// 別處送的指令都被排進交易；`SUBSCRIBE` / `MONITOR` 讓連線只收推播、再也不回一般指令的結果。
fn console_policy(parts: &[String]) -> ConsolePolicy {
    let name = parts[0].to_ascii_uppercase();
    let sub = parts.get(1).map(|s| s.to_ascii_uppercase()).unwrap_or_default();
    let reject = |msg: &str| ConsolePolicy::Reject(msg.to_string());
    match name.as_str() {
        "SELECT" => reject(&t!(
            "主控台不支援 SELECT 切換資料庫（會改到整個 App 共用的連線）。請改用主控台上方的資料庫選單，或在指令前加「編號:」，例如 3:GET key。"
        )),
        "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "UNSUBSCRIBE" | "PUNSUBSCRIBE" | "SUNSUBSCRIBE" => {
            reject(&t!("訂閱與 MONITOR 會讓連線只收推播訊息，請改用「Pub/Sub」面板。"))
        }
        "MONITOR" => reject(&t!("MONITOR 會讓連線只收推播訊息，請改用「監視」面板。")),
        "MULTI" | "EXEC" | "DISCARD" | "WATCH" | "UNWATCH" => reject(&t!(
            "主控台一次只送一行，交易（MULTI / EXEC）無法跨行進行，而且會把共用連線留在交易狀態。請改用 EVAL 腳本做原子操作。"
        )),
        "QUIT" | "RESET" | "HELLO" | "AUTH" => reject(&t!("這個指令會改變共用連線的登入或協定狀態，主控台不支援。")),
        "CLIENT" if matches!(sub.as_str(), "REPLY" | "TRACKING" | "NO-EVICT" | "NO-TOUCH") => {
            reject(&t!("這個指令會改變共用連線的登入或協定狀態，主控台不支援。"))
        }
        "BLPOP" | "BRPOP" | "BRPOPLPUSH" | "BLMOVE" | "BLMPOP" | "BZPOPMIN" | "BZPOPMAX" | "BZMPOP" | "WAIT" | "WAITAOF" => {
            ConsolePolicy::Dedicated
        }
        "XREAD" | "XREADGROUP" if parts.iter().any(|p| p.eq_ignore_ascii_case("BLOCK")) => ConsolePolicy::Dedicated,
        _ => ConsolePolicy::Shared,
    }
}

/// 連線設定 → redis ConnectionInfo（db 一律 0，`conn()` 再依 DB 改）。
fn connection_info(config: &ConnectionConfig, use_tls: bool, tls_insecure: bool) -> redis::ConnectionInfo {
    // 使用者常把 IPv6 照 URL 習慣打成 `[::1]`；ConnectionAddr 要的是裸位址。
    let host = config.host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    let addr = if use_tls {
        redis::ConnectionAddr::TcpTls { host, port: config.port, insecure: tls_insecure, tls_params: None }
    } else {
        redis::ConnectionAddr::Tcp(host, config.port)
    };
    let non_empty = |s: &str| (!s.is_empty()).then(|| s.to_string());
    redis::ConnectionInfo {
        addr,
        redis: redis::RedisConnectionInfo {
            db: 0,
            username: non_empty(&config.username),
            password: non_empty(&config.password),
            ..Default::default()
        },
    }
}

/// 各 DB 共用連線（ConnectionManager）的逾時與重連設定。
///
/// redis crate 預設「連線不逾時、斷線重試 6 次（指數退避）、回應不逾時」：主機打錯時要等作業系統的
/// TCP 逾時（Windows 約 21 秒）× 6 次才報錯，畫面看起來就是當掉；伺服器卡住時查詢也永遠不回來。
fn manager_config() -> redis::aio::ConnectionManagerConfig {
    redis::aio::ConnectionManagerConfig::new()
        .set_connection_timeout(std::time::Duration::from_secs(10))
        .set_number_of_retries(2)
        .set_response_timeout(std::time::Duration::from_secs(120))
}

/// SCAN 全掃收集符合 pattern 的鍵（游標式、安全上限 100k、排序去重）。
/// SCAN 在 rehash 期間可能重複回傳同一 key，故排序後 dedup 避免重複列與灌水總數。
async fn scan_all_keys(
    conn: &mut redis::aio::ConnectionManager,
    pattern: &str,
) -> AppResult<(Vec<String>, bool)> {
    let mut all: Vec<String> = Vec::new();
    let mut cursor: u64 = 0;
    let truncated;
    loop {
        let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(500)
            .query_async(conn)
            .await
            .map_err(rerr)?;
        all.extend(decode_keys(batch));
        cursor = next;
        // 掃完（cursor 歸零）或達安全上限即停。
        if cursor == 0 || all.len() > SCAN_KEY_LIMIT {
            truncated = scan_truncated(cursor, all.len());
            break;
        }
    }
    all.sort();
    all.dedup();
    Ok((all, truncated))
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
        .map_err(rerr)?;
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
        .ok_or_else(|| AppError::Query(t!("缺少 key").to_string()))?;
    vals.get(idx)
        .and_then(|v| v.clone())
        .ok_or_else(|| AppError::Query(t!("key 為空").to_string()))
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
        // RESP3 的 map（HGETALL、CONFIG GET、XINFO…）攤成 field / value 交錯，與 RESP2 的陣列回法一致。
        redis::Value::Map(pairs) => pairs
            .iter()
            .flat_map(|(k, v)| redis_value_to_rows(k).into_iter().chain(redis_value_to_rows(v)))
            .collect(),
        redis::Value::Attribute { data, .. } => redis_value_to_rows(data),
        redis::Value::Push { data, .. } => data.iter().flat_map(redis_value_to_rows).collect(),
        other => vec![vec![Some(rv_to_string(other))]],
    }
}

/// 從 `INFO server` 的文字判斷 redis_version 主要版本是否 >= major。
/// 讀不到 / 解析失敗回 false，讓呼叫端走相容路徑（慢一點但不會整頁報錯）。
fn redis_version_at_least(info: &str, major: u32) -> bool {
    info.lines()
        .find_map(|l| l.strip_prefix("redis_version:").map(str::trim))
        .and_then(|v| v.split('.').next())
        .and_then(|v| v.parse::<u32>().ok())
        .is_some_and(|v| v >= major)
}

/// 將單一 redis::Value 攤成字串（供 SLOWLOG 等巢狀結果取值）。
fn rv_to_string(v: &redis::Value) -> String {
    match v {
        redis::Value::Nil => String::new(),
        redis::Value::Int(i) => i.to_string(),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::Okay => "OK".to_string(),
        redis::Value::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        // RESP3 純量：以前一律印 Rust 的 Debug 格式（`Double(1.5)`、`VerbatimString { format: … }`）。
        redis::Value::Double(d) => d.to_string(),
        redis::Value::Boolean(b) => b.to_string(),
        redis::Value::VerbatimString { text, .. } => text.clone(),
        redis::Value::ServerError(e) => format!("(error) {}", e.details().unwrap_or_default()),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_literal_substring_escapes_brackets() {
        assert_eq!(glob_literal_substring("user[0]"), r"*user\[0\]*");
        assert_eq!(glob_literal_substring("a\\b"), r"*a\\b*");
        assert_eq!(glob_literal_substring("abc"), "*abc*");
        // grid 的 = / like 篩選也要當字面處理，不能讓 key 裡的 * 變成萬用字元。
        assert_eq!(glob_escape("user[0]*"), r"user\[0\]\*");
        assert_eq!(glob_like_pattern("user%"), "user*");
        assert_eq!(glob_like_pattern("a*b"), r"a\*b");
        assert_eq!(glob_like_pattern("u[0]%"), r"u\[0\]*");
    }

    #[test]
    fn redis_version_at_least_parses_info_server() {
        assert!(redis_version_at_least("# Server\r\nredis_version:7.2.4\r\n", 6));
        assert!(redis_version_at_least("redis_version:6.0.16\r\n", 6));
        assert!(!redis_version_at_least("redis_version:5.0.14\r\n", 6));
        // 讀不到 / 託管 Redis 隱藏 INFO → 保守走相容路徑。
        assert!(!redis_version_at_least("", 6));
        assert!(!redis_version_at_least("redis_version:unknown\r\n", 6));
    }

    #[test]
    fn aggregate_keyspace_groups_by_type_and_sorts_by_memory() {
        let rows = vec![
            ("string".into(), 100i64),
            ("hash".into(), 500),
            ("string".into(), 50),
            ("list".into(), 20),
        ];
        let out = aggregate_keyspace(&rows);
        assert_eq!(out[0].0, "hash");
        assert_eq!(out[0].1, 1);
        assert_eq!(out[0].2, 500);
        assert_eq!(out[1].0, "string");
        assert_eq!(out[1].1, 2);
        assert_eq!(out[1].2, 150);
        assert_eq!(out[2].0, "list");
    }

    #[test]
    fn sentinel_master_reads_the_connection_option() {
        assert_eq!(sentinel_master(&cfg("h", "", "")), None);
        let mut c = cfg("h", "", "");
        c.options.insert("redis_sentinel_master".into(), "mymaster".into());
        assert_eq!(sentinel_master(&c), Some("mymaster"));
    }

    #[test]
    fn import_key_valid_checks_value_shape() {
        let j = |s: &str| RedisImportKey {
            key: "k".into(), type_: "string".into(), ttl: -1, partial: false,
            exported: 0, total: 0, value: serde_json::from_str(s).unwrap(),
        };
        assert!(import_key_valid(&j(r#""hello""#)));
        assert!(!import_key_valid(&j("123")));
        assert!(!import_key_valid(&j("null")));
        let h = RedisImportKey {
            key: "h".into(), type_: "hash".into(), ttl: -1, partial: false,
            exported: 0, total: 0,
            value: serde_json::from_str(r#"[{"field":"a","value":"1"}]"#).unwrap(),
        };
        assert!(import_key_valid(&h));
        let z = RedisImportKey {
            key: "z".into(), type_: "zset".into(), ttl: -1, partial: false,
            exported: 0, total: 0,
            value: serde_json::from_str(r#"[{"member":"m","score":1.5}]"#).unwrap(),
        };
        assert!(import_key_valid(&z));
        // JSON 不能代表 Infinity：匯出檔用 "+inf" / "-inf"，後端要認得。
        let inf = RedisImportKey {
            key: "zinf".into(), type_: "zset".into(), ttl: -1, partial: false,
            exported: 0, total: 0,
            value: serde_json::from_str(r#"[{"member":"m","score":"+inf"}]"#).unwrap(),
        };
        assert!(import_key_valid(&inf));
        assert_eq!(parse_import_score(&serde_json::json!("-inf")), Some(f64::NEG_INFINITY));
        let stream = RedisImportKey { type_: "stream".into(), ..j(r#""x""#) };
        assert!(!import_key_valid(&stream));
        // 只匯出部分的鍵不能拿去覆寫完整鍵。
        let partial = RedisImportKey { partial: true, ..j(r#""x""#) };
        assert!(!import_key_valid(&partial));
        // 即使 partial 被竄改成 false，檔案自己說只載 2/1000 筆就仍要擋。
        let undercount = RedisImportKey {
            key: "h".into(), type_: "hash".into(), ttl: -1, partial: false,
            exported: 2, total: 1000,
            value: serde_json::from_str(r#"[{"field":"a","value":"1"},{"field":"b","value":"2"}]"#).unwrap(),
        };
        assert!(!import_key_valid(&undercount));
    }

    #[test]
    fn import_payload_accepts_exported_single_and_array_shapes() {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Payload { One(RedisImportKey), Many(Vec<RedisImportKey>) }
        let one = r#"{"key":"k","type":"string","ttl":60,"value":"v","partial":false}"#;
        let arr = format!("[{one}]");
        assert!(serde_json::from_str::<Payload>(one).is_ok());
        assert!(serde_json::from_str::<Payload>(&arr).is_ok());
    }

    #[test]
    fn clone_restore_ttl_uses_zero_for_no_expiry() {
        assert_eq!(clone_restore_ttl_ms(15_000), 15_000);
        assert_eq!(clone_restore_ttl_ms(-1), 0); // 永不過期
        assert_eq!(clone_restore_ttl_ms(-2), 0); // 來源鍵不存在
    }

    #[test]
    fn redis_prefix_glob_escapes_literal_special_chars() {
        assert_eq!(redis_prefix_glob("user:"), "user:*");
        assert_eq!(redis_prefix_glob("a[b]*"), "a\\[b\\]\\**");
        assert_eq!(redis_prefix_glob(""), "*");
    }

    #[test]
    fn scan_truncated_detects_early_stop() {
        // 游標歸零＝真的掃完了，即使筆數很多也不算截斷。
        assert!(!scan_truncated(0, 200_000));
        // 到上限就停但游標還沒歸零＝後面還有鍵，total 不是全貌。
        assert!(scan_truncated(1234, SCAN_KEY_LIMIT + 1));
        assert!(!scan_truncated(1234, 500));
    }

    fn cfg(host: &str, user: &str, pass: &str) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "t", "name": "t", "kind": "redis", "host": host, "port": 6380,
            "username": user, "password": pass, "database": null, "max_connections": 1,
        }))
        .expect("最小欄位的 ConnectionConfig 應可反序列化")
    }

    #[test]
    fn connection_info_keeps_special_chars_in_password_verbatim() {
        // 以前拼 URL：`#` 之後被當成 fragment、`@` 讓主機名稱跑掉。
        let info = connection_info(&cfg("cache.local", "app", "p@ss:w/rd#1%?"), false, false);
        assert_eq!(info.redis.password.as_deref(), Some("p@ss:w/rd#1%?"));
        assert_eq!(info.redis.username.as_deref(), Some("app"));
        assert_eq!(info.addr, redis::ConnectionAddr::Tcp("cache.local".into(), 6380));
    }

    #[test]
    fn connection_info_empty_auth_and_ipv6_and_tls() {
        let info = connection_info(&cfg("[::1]", "", ""), true, true);
        assert_eq!(info.redis.password, None);
        assert_eq!(info.redis.username, None);
        match info.addr {
            redis::ConnectionAddr::TcpTls { host, port, insecure, .. } => {
                assert_eq!((host.as_str(), port, insecure), ("::1", 6380, true));
            }
            other => panic!("應為 TLS 位址：{other:?}"),
        }
    }

    fn policy(line: &str) -> ConsolePolicy {
        console_policy(&split_args(line))
    }

    #[test]
    fn console_policy_rejects_commands_that_change_shared_connection_state() {
        for line in ["SELECT 3", "select 1", "SUBSCRIBE ch", "psubscribe *", "MONITOR", "MULTI", "EXEC", "QUIT", "HELLO 3", "CLIENT REPLY OFF"] {
            assert!(matches!(policy(line), ConsolePolicy::Reject(_)), "{line}");
        }
    }

    #[test]
    fn console_policy_sends_blocking_commands_to_a_dedicated_connection() {
        for line in ["BLPOP q 0", "brpop q 5", "BZPOPMIN z 0", "XREAD BLOCK 0 STREAMS s $", "WAIT 1 0"] {
            assert_eq!(policy(line), ConsolePolicy::Dedicated, "{line}");
        }
    }

    #[test]
    fn console_policy_allows_ordinary_commands() {
        for line in ["GET k", "XREAD COUNT 10 STREAMS s 0", "CLIENT LIST", "SCAN 0", "EVAL \"return 1\" 0"] {
            assert_eq!(policy(line), ConsolePolicy::Shared, "{line}");
        }
    }

    #[test]
    fn next_stream_id_steps_past_the_last_entry() {
        assert_eq!(next_stream_id("1700000000000-0"), "1700000000000-1");
        assert_eq!(next_stream_id("5-18446744073709551615"), "6-0");
        assert_eq!(next_stream_id("壞掉"), "壞掉");
    }

    #[test]
    fn stream_fields_json_keeps_order_and_escapes() {
        let pairs = vec![("z".to_string(), "1".to_string()), ("a".to_string(), "say \"hi\"".to_string())];
        assert_eq!(stream_fields_json(&pairs), r#"{"z":"1","a":"say \"hi\""}"#);
    }

    #[test]
    fn parse_stream_groups_reads_resp2_flat_arrays() {
        use redis::Value as V;
        let b = |s: &str| V::BulkString(s.as_bytes().to_vec());
        let g = V::Array(vec![V::Array(vec![
            b("name"), b("workers"), b("consumers"), V::Int(2), b("pending"), V::Int(5),
            b("last-delivered-id"), b("1-3"), b("entries-read"), V::Int(3), b("lag"), V::Nil,
        ])]);
        let out = parse_stream_groups(g);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].name.as_str(), out[0].consumers, out[0].pending), ("workers", 2, 5));
        assert_eq!(out[0].last_delivered_id, "1-3");
        assert_eq!(out[0].lag, None);
    }

    #[test]
    fn rerr_explains_cluster_redirects() {
        let moved = redis::RedisError::from((redis::ErrorKind::Moved, "Moved", "1234 10.0.0.2:6379".to_string()));
        let msg = rerr(moved).to_string();
        assert!(msg.contains("Redis Cluster") && msg.contains("10.0.0.2:6379") && msg.contains("1234"), "{msg}");
        let other = redis::RedisError::from((redis::ErrorKind::TypeError, "WRONGTYPE", "x".to_string()));
        assert!(!rerr(other).to_string().contains("Cluster"));
    }

    #[test]
    fn decode_bytes_escapes_only_invalid_utf8() {
        assert_eq!(decode_bytes("中文 a\\b".as_bytes().to_vec()), ("中文 a\\b".to_string(), false));
        // gzip 開頭：1f 8b 08；可讀部分保留、壞位元組寫成 \xHH、反斜線加倍。
        let (s, bin) = decode_bytes(vec![0x1f, 0x8b, b'a', b'\\', 0xff]);
        assert!(bin);
        assert_eq!(s, "\u{1f}\\x8ba\\\\\\xff");
        // 合法的多位元組字元夾在壞位元組之間也保留。
        let mut v = "值".as_bytes().to_vec();
        v.push(0xc0);
        assert_eq!(decode_bytes(v), ("值\\xc0".to_string(), true));
    }

    #[test]
    fn trim_incomplete_utf8_tail_only_cuts_a_split_char() {
        let mut v = "ab中".as_bytes().to_vec();
        v.pop(); // 中 = e4 b8 ad → 剩 e4 b8
        trim_incomplete_utf8_tail(&mut v);
        assert_eq!(v, b"ab");
        // 中間就壞掉的不是截斷造成的，不動（之後當二進位顯示）。
        let mut bad = vec![b'a', 0xff, b'b'];
        trim_incomplete_utf8_tail(&mut bad);
        assert_eq!(bad, vec![b'a', 0xff, b'b']);
    }

    #[test]
    fn redis_value_to_rows_flattens_resp3_types_readably() {
        use redis::Value as V;
        let map = V::Map(vec![(V::BulkString(b"f".to_vec()), V::Int(1))]);
        assert_eq!(redis_value_to_rows(&map), vec![vec![Some("f".into())], vec![Some("1".into())]]);
        assert_eq!(redis_value_to_rows(&V::Double(1.5)), vec![vec![Some("1.5".into())]]);
        assert_eq!(redis_value_to_rows(&V::Boolean(true)), vec![vec![Some("true".into())]]);
    }
}
