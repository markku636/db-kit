//! 連線字串解析統一落點（GUI「貼上連線字串」指令與 dbk CLI `--url` 共用）。
//!
//! 支援格式：
//! - 標準 URL / DSN：`scheme://[user[:pass]@]host[:port][/db][?k=v&…][#fragment]`
//!   （userinfo / host / database / query 值做 percent-decode；IPv6 host 以方括號 `[::1]:5432`）
//! - `mongodb+srv://`（DNS SRV，不帶 port）、`rediss://` / `valkeys://` / `amqps://`（TLS）
//! - 框架方言後綴 `dialect+driver://`：SQLAlchemy 的 `postgresql+psycopg2` / `mysql+pymysql` 等
//!   （後綴忽略，只有 `+tls` / `+ssl` 有語意）
//! - JDBC：開頭 `jdbc:` 剝掉後照常解析，dialect 限 `JDBC_URL_DIALECTS` 白名單
//! - ADO.NET / Npgsql：無 scheme 且以 `;` 分隔的 `key=value`
//!   （`Server=host,port;Database=db;User ID=u;…` → MSSQL；`Host=…;Database=…` → Postgres）
//! - libpq keyword/value：無 scheme 且以空白分隔的 `key=value`
//!   （`host=localhost port=5432 dbname=app sslmode=require` → Postgres）
//! - sqlite：`sqlite:path` / `sqlite://path` / 純檔案路徑（Windows 磁碟機字首 `C:` 不誤判為 scheme）
//! - 雜訊容錯：外層引號、`export DATABASE_URL=` 前綴、尾端 `;`、折行（見 `normalize`）
//!
//! query 參數依 kind 映射到各 driver 實際讀取的 options 鍵（見 `params::apply_query_param`）；
//! 未知參數靜默忽略。**只發各 driver 真的會讀、且前端表單有對應欄位的鍵**——前端
//! `ConnectionDialog.buildOptions` 每次存檔都重建整個 options 物件，沒有表單 state 的鍵會被靜默丟棄。
//!
//! - Oracle：`jdbc:oracle:thin:@//host:port/service`、`@host:port:SID`、EZConnect、
//!   TNS descriptor `(DESCRIPTION=…)`、TNS 別名
//! - Elasticsearch：`http(s)://[user:pass@]host[:port]`（整段 URL 存進 host）與 Elastic Cloud ID
//! - Kafka：client properties 區塊（`bootstrap.servers=…` / `security.protocol=…` / JAAS）
//!
//! 模組分工：
//! - `normalize` — 貼上內容的雜訊前置處理
//! - `standard`  — scheme 之後的標準 URL 主體
//! - `kv`        — 無 scheme 的 `key=value` 方言（分號的 ADO.NET / Npgsql、空白的 libpq）
//! - `vendor`    — 廠商專屬方言（Oracle / Elastic / Kafka）
//! - `params`    — host/port 切割、query → options 映射、percent-decode 等共用工具
//!
//! 偵測優先序（`parse_url` 依序試，先中先贏）：
//! 1. Kafka properties（點號鍵；`;` 串接的 blob 會被 KV 偵測器搶走，故必須最前）
//! 2. Oracle TNS descriptor（`(DESCRIPTION=…)`，內含大量 `=` 與 `,`）
//! 3. `jdbc:` 前綴 → oracle 交給 `vendor`，其餘剝殼後續走下面的流程（非白名單 dialect 報錯）
//! 4. 分號 KV（ADO.NET / Npgsql）—— 僅在無 scheme 時
//! 5. libpq 空白 KV —— 僅在無 scheme 時
//! 6. Elastic Cloud ID —— 僅在無 scheme 時
//! 7. 已知 scheme URL（含 `+driver` 剝除）
//! 8. `http(s)` → Elastic（整段 URL 留在 host）
//! 9. sqlite 路徑
//! 10. 未知 scheme → 有 hint 沿用 hint，無 hint 回 Err
//!
//! 防誤判護欄（動偵測順序前務必先讀）：
//! - `kv` 的偵測器只在字串**不含 `://`**（即 `split_scheme` 未取出 scheme）時才跑。
//! - **分號 KV 必須排在 libpq 之前**：Npgsql 的 `Host=pg;SSL Mode=Require` 鍵名含空白，
//!   以空白切詞會得到看似合法的 `("host", "pg;SSL")` 而解壞 host。
//! - libpq 偵測器要求「切出 ≥2 段、每段都是 `key=value`、且命中至少一個 libpq 專屬鍵」。
//!   三條缺一不可：`Server=tcp:h,1433;…;User ID=sa;…` 以空白切恰好是 2 段合法 token，
//!   靠「libpq 專屬鍵」那條才擋下來。
//! - Windows 磁碟機字首（`C:\…`）靠 `split_scheme` 的「單冒號只認已知 scheme」規則保護。
//! - 判不出 kind 時回 `kind: None` 而非亂猜；只有「明確給了 scheme 卻不認得且無 hint」才回 Err。

mod kv;
mod normalize;
mod params;
mod standard;
mod vendor;

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use crate::db::DbKind;
use crate::error::{AppError, AppResult};

/// 解 Elastic Cloud 的 `cloud_id`：`name:base64(host$es_uuid$kibana_uuid)`。
///
/// 回傳 `(host, es_uuid)`，供組出 `https://{es_uuid}.{host}` 的叢集端點。
/// 格式不符（無 `:`、base64 解不開、欄位不足或缺 host / es_uuid）→ None。
///
/// 住在這裡而非 db/elastic/config.rs：`elastic` 是 cargo feature，而本模組沒有 gate
/// （精簡 CLI 依賴它），「貼上 Cloud ID 自動填表」與 Elastic driver 的 base URL 推導
/// 得共用同一份邏輯。config.rs 以 `pub use` 取回這個名字，原呼叫點與其單元測試不變。
pub fn decode_cloud_id(cloud_id: &str) -> Option<(String, String)> {
    let (_name, b64) = cloud_id.trim().split_once(':')?;
    let decoded = STANDARD.decode(b64.trim()).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let mut parts = text.split('$');
    let host = parts.next()?.trim();
    let es_uuid = parts.next()?.trim();
    if host.is_empty() || es_uuid.is_empty() {
        return None;
    }
    Some((host.to_string(), es_uuid.to_string()))
}

/// URL / DSN 解析結果。欄位皆可選：None = 字串中未提供（CLI 沿用旗標 / 預設值、
/// GUI 前端保留欄位現值）。直接序列化回前端（snake_case 欄位名，與 ConnectionConfig / api.ts
/// 對齊；kind 沿 DbKind 的 lowercase serde）。
#[derive(Debug, Default, serde::Serialize)]
pub struct Parsed {
    pub kind: Option<DbKind>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    /// 已映射成各 driver 讀取的 options 鍵（如 ssl_mode / ssl_ca / mongo_srv / redis_tls）。
    pub options: BTreeMap<String, String>,
}

/// 已知 scheme → DbKind 對照（單一事實來源：`normalize_scheme` 與 `split_scheme` 共用；
/// 未來新增類型只需在此加一列）。此處只認**完整** scheme；`dialect+driver` 形式
/// （`postgresql+psycopg2`）由 `normalize_scheme` 剝除後再查。
fn scheme_kind(s: &str) -> Option<DbKind> {
    match s {
        "mysql" => Some(DbKind::Mysql),
        "mariadb" => Some(DbKind::Mariadb),
        "postgres" | "postgresql" => Some(DbKind::Postgres),
        "mongodb" | "mongodb+srv" | "mongo" => Some(DbKind::Mongo),
        // valkey 為 Redis 的 fork，協定相同，沿用 Redis driver。
        "redis" | "rediss" | "valkey" | "valkeys" => Some(DbKind::Redis),
        // 純 http(s) URL 視為 Elasticsearch / OpenSearch：貼上路徑裡沒有別的以 http 為基礎的
        // 一等類型（external gateway 不在此範圍），而 GUI 會顯示解析出的類型且可一鍵改，
        // 猜錯看得見也改得回；回報「不支援」則什麼都不給。走 vendor::parse_elastic_url。
        "http" | "https" => Some(DbKind::Elastic),
        "mssql" | "sqlserver" => Some(DbKind::Mssql),
        "oracle" => Some(DbKind::Oracle),
        "kafka" => Some(DbKind::Kafka),
        "elasticsearch" | "opensearch" | "elastic" => Some(DbKind::Elastic),
        "amqp" | "amqps" => Some(DbKind::RabbitMq),
        "sqlite" => Some(DbKind::Sqlite),
        _ => None,
    }
}

/// scheme 本身隱含的連線選項。取代原先散在 `standard` 裡的 `scheme == Some("rediss")`
/// 這類字串比較——新增 scheme 別名時只需改 `normalize_scheme`，不必回頭找每個比較點。
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct SchemeFlags {
    /// scheme 隱含 TLS（`rediss` / `valkeys` / `amqps` / `redis+tls`）。
    pub tls: bool,
    /// DNS SRV 查詢（`mongodb+srv`）：port 由 SRV 記錄決定。
    pub srv: bool,
    /// scheme 是 `http` / `https`：整段 URL 要留在 host 欄（見 vendor::parse_elastic_url）。
    pub http: bool,
}

/// TLS 語意的 scheme 別名（完整比對）。
fn scheme_is_tls(s: &str) -> bool {
    matches!(s, "rediss" | "valkeys" | "amqps")
}

/// scheme → (kind, flags)。
///
/// 先做**完整比對**（`mongodb+srv` 必須精準命中，否則會被下面的 `+` 剝除誤拆成 mongodb + srv
/// 而丟掉 SRV 語意）；未命中且含 `+` 時才視為 `dialect+driver`：
/// 前綴決定 kind，後綴多為框架 driver 名（SQLAlchemy 的 `psycopg2` / `asyncpg` / `pymysql`、
/// JDBC 的 `mariadbconnector`…）一律忽略，只有 `tls` / `ssl` 後綴有語意（`redis+tls://`）。
fn normalize_scheme(raw: &str) -> Option<(DbKind, SchemeFlags)> {
    let s = raw.to_ascii_lowercase();
    if let Some(k) = scheme_kind(&s) {
        return Some((
            k,
            SchemeFlags {
                tls: scheme_is_tls(&s),
                srv: s == "mongodb+srv",
                http: matches!(s.as_str(), "http" | "https"),
            },
        ));
    }
    let (head, tail) = s.split_once('+')?;
    let k = scheme_kind(head)?;
    Some((
        k,
        SchemeFlags {
            tls: scheme_is_tls(head) || matches!(tail, "tls" | "ssl"),
            srv: false,
            http: false,
        },
    ))
}

/// 取出 scheme：先試 `scheme://`，再試 `scheme:`（僅限已知 scheme，避免把 Windows 磁碟機 `C:` 當 scheme）。
pub fn split_scheme(url: &str) -> (Option<String>, String) {
    if let Some((s, r)) = url.split_once("://") {
        return (Some(s.to_ascii_lowercase()), r.to_string());
    }
    if let Some((s, r)) = url.split_once(':') {
        let s = s.to_ascii_lowercase();
        // 用 normalize_scheme 而非 scheme_kind：`sqlite+aiosqlite:app.db` 這類單冒號的
        // dialect+driver 形式也要認得。
        if normalize_scheme(&s).is_some() {
            return (Some(s), r.to_string());
        }
    }
    (None, url.to_string())
}

/// 輸入是否「看得出結構」——供有 kind hint 時的防呆用。
///
/// 為什麼需要：hint 會讓 `parse_url` 一定給得出 kind，等於關掉「判不出類型就報錯」那道防呆。
/// 沒有這層檢查，在 MySQL 對話框貼一段隨手複製的文字也會「成功」並把整段塞進 host。
///
/// 接受：URL（含 `://`）、`jdbc:`、TNS descriptor、任何含 `=` 的 KV、檔案路徑、`host:port`。
/// 拒絕：單一裸字（`localhost` / 一段密碼）——它不帶埠或資料庫資訊，解析它毫無意義，
/// 使用者直接填「主機」欄即可。
pub fn looks_structured(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    if t.contains("://") || t.contains('=') || t.starts_with('(') {
        return true;
    }
    if params::strip_prefix_ci(t, "jdbc:").is_some() {
        return true;
    }
    // sqlite 檔案路徑
    if t.contains('/') || t.contains('\\') {
        return true;
    }
    // `host:port`（單一 token，且冒號後是合法埠號）
    if t.split_whitespace().count() != 1 {
        return false;
    }
    match t.rsplit_once(':') {
        Some((h, port)) => !h.is_empty() && port.parse::<u16>().is_ok(),
        None => false,
    }
}

/// `jdbc:` 後放行的 dialect 白名單：剝掉前綴後內層即為標準 URL（已有測試覆蓋）。
/// 不在此列的 dialect（`jdbc:db2:` / `jdbc:oracle:thin:@…`）語法各異，剝殼後會解成錯誤欄位，
/// 故明確報錯而非默默亂解。
const JDBC_URL_DIALECTS: &[&str] = &[
    "sqlserver",
    "mysql",
    "mariadb",
    "postgresql",
    "postgres",
    "sqlite",
];

/// URL / DSN / ADO.NET 解析：`scheme://[user[:pass]@]host[:port][/db][?k=v&…]`。
/// sqlite 特例：`sqlite:path` / `sqlite://path` 或直接給檔案路徑 → database = path（不需 url crate）。
/// 回 Err 僅於「明確給了 scheme 但不認得且無 kind hint」（給使用者清楚錯誤而非默默全空）。
pub fn parse_url(input: &str, kind_hint: Option<DbKind>) -> AppResult<Parsed> {
    // 前置處理：剝掉引號、`export DATABASE_URL=` 前綴、尾端分號、折行（見 normalize）。
    let prepared = normalize::prepare(input);
    let url = prepared.as_str();

    // Kafka client properties：點號鍵與其他方言完全不重疊，且 `;` 串接的 blob 會被下面的
    // KV 偵測器搶走，故必須排在最前面。
    if let Some(p) = vendor::try_kafka_properties(url, kind_hint) {
        return Ok(p);
    }

    // Oracle TNS descriptor：`(DESCRIPTION=…)`。內含大量 `=` 與 `,`，同樣得先攔下來。
    if matches!(kind_hint, None | Some(DbKind::Oracle)) {
        if let Some(p) = vendor::try_tns(url) {
            return Ok(p);
        }
    }

    // JDBC：剝掉 `jdbc:` 前綴後照常解析，但只放行白名單 dialect（見 JDBC_URL_DIALECTS）。
    // oracle 例外：`jdbc:oracle:thin:@…` 的內層不是 URL，交給 vendor 自己解。
    let url = if let Some(rest) = params::strip_prefix_ci(url, "jdbc:") {
        let dialect = rest.split([':', '/']).next().unwrap_or("").to_ascii_lowercase();
        if dialect == "oracle" {
            if let Some(p) = vendor::try_jdbc_oracle(rest) {
                return Ok(p);
            }
        }
        if !JDBC_URL_DIALECTS.contains(&dialect.as_str()) {
            return Err(AppError::Connect(tf!(
                "不支援的連線字串格式：{scheme}",
                scheme = format!("jdbc:{dialect}")
            )));
        }
        rest
    } else {
        url
    };

    let (scheme, rest) = split_scheme(url);

    // ---- 無 scheme 的 key=value 方言。順序有意義，見模組 doc 的偵測優先序 ----
    if scheme.is_none() {
        // 分號 KV（ADO.NET / Npgsql）必須先試：`;` 的存在本身就是最可靠的判別依據。
        // 反過來讓 libpq 先跑會誤判——Npgsql 的 `Host=pg;SSL Mode=Require` 鍵名含空白，
        // 以空白切詞會得到 ("host", "pg;SSL") 這種「看起來合法」的 token 而把 host 解壞。
        if let Some(p) = kv::try_semicolon_kv(url, kind_hint) {
            return Ok(p);
        }
        // libpq keyword/value（空白分隔）。到這裡的字串要嘛沒有 `;`，要嘛沒命中任何位址鍵。
        if let Some(p) = kv::try_libpq_kv(url, kind_hint) {
            return Ok(p);
        }
        // Elastic Cloud ID（`name:base64(...)`）。排在 KV 之後、已知 scheme 之前：
        // 判別靠「base64 解得開」，`sqlite:app.db` 這種解不開所以不會被誤吃。
        if let Some(p) = vendor::try_cloud_id(url, kind_hint) {
            return Ok(p);
        }
    }

    // scheme → (DbKind, SchemeFlags)。已給 scheme 但不認得且無 hint → 明確報錯。
    let (kind, flags) = match scheme.as_deref() {
        Some(s) => match normalize_scheme(s) {
            Some((k, f)) => (Some(k), f),
            None => match kind_hint {
                Some(k) => (Some(k), SchemeFlags::default()),
                None => {
                    return Err(AppError::Connect(tf!(
                        "不支援的連線字串格式：{scheme}",
                        scheme = s
                    )))
                }
            },
        },
        None => (kind_hint, SchemeFlags::default()),
    };

    // http(s)：整段 URL 要留在 host 欄（Elastic 的慣例，見 vendor::parse_elastic_url），
    // 不能走 standard 的 host/port/db 切割。
    if flags.http {
        return Ok(vendor::parse_elastic_url(
            scheme.as_deref().unwrap_or("https"),
            &rest,
        ));
    }

    // sqlite：去掉 scheme 後整段當檔案路徑（路徑可含 ? / #，不做 query 切割）。
    if matches!(kind, Some(DbKind::Sqlite)) {
        let path = if scheme.is_some() { rest } else { url.to_string() };
        return Ok(Parsed {
            kind,
            database: Some(path),
            ..Default::default()
        });
    }

    Ok(standard::parse(kind, flags, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Parsed {
        parse_url(url, None).expect("應可解析")
    }

    fn opt<'a>(p: &'a Parsed, k: &str) -> Option<&'a str> {
        p.options.get(k).map(String::as_str)
    }

    // ---- 各 scheme 基本解析 ----

    #[test]
    fn mysql_full_url() {
        let p = parse("mysql://user:pass@localhost:3306/mydb");
        assert_eq!(p.kind, Some(DbKind::Mysql));
        assert_eq!(p.host.as_deref(), Some("localhost"));
        assert_eq!(p.port, Some(3306));
        assert_eq!(p.username.as_deref(), Some("user"));
        assert_eq!(p.password.as_deref(), Some("pass"));
        assert_eq!(p.database.as_deref(), Some("mydb"));
        assert!(p.options.is_empty());
    }

    #[test]
    fn mariadb_and_postgresql_aliases() {
        assert_eq!(parse("mariadb://h/db").kind, Some(DbKind::Mariadb));
        assert_eq!(parse("postgresql://h/db").kind, Some(DbKind::Postgres));
        assert_eq!(parse("sqlserver://h").kind, Some(DbKind::Mssql));
        assert_eq!(parse("oracle://sys:pw@h:1521/XEPDB1").database.as_deref(), Some("XEPDB1"));
        assert_eq!(parse("kafka://broker:9092").port, Some(9092));
    }

    // ---- query string 不進 database（舊版 bug 回歸測試）----

    #[test]
    fn query_not_eaten_into_database() {
        let p = parse("postgres://u:p@h:5432/app?sslmode=require");
        assert_eq!(p.database.as_deref(), Some("app"));
        assert_eq!(opt(&p, "ssl_mode"), Some("require"));
    }

    #[test]
    fn query_without_path_leaves_database_none() {
        let p = parse("postgres://h?sslmode=require");
        assert_eq!(p.database, None);
        assert_eq!(p.host.as_deref(), Some("h"));
        assert_eq!(opt(&p, "ssl_mode"), Some("require"));
    }

    // ---- percent-decode ----

    #[test]
    fn userinfo_percent_decoded() {
        // 密碼含 %40（@）與 %3A（:）。
        let p = parse("mysql://us%2Fer:p%40ss%3Aw0rd@h:3306/my%20db");
        assert_eq!(p.username.as_deref(), Some("us/er"));
        assert_eq!(p.password.as_deref(), Some("p@ss:w0rd"));
        assert_eq!(p.database.as_deref(), Some("my db"));
    }

    #[test]
    fn pct_decode_keeps_invalid_sequences() {
        use params::pct_decode;
        assert_eq!(pct_decode("a%zzb"), "a%zzb"); // 非 hex → 原樣
        assert_eq!(pct_decode("tail%4"), "tail%4"); // 截尾 → 原樣
        assert_eq!(pct_decode("a+b"), "a+b"); // `+` 不當空白
        assert_eq!(pct_decode("%41%42"), "AB");
    }

    // ---- IPv6 ----

    #[test]
    fn ipv6_bracketed_host_with_port() {
        let p = parse("postgres://[::1]:5432/db");
        assert_eq!(p.host.as_deref(), Some("::1"));
        assert_eq!(p.port, Some(5432));
        assert_eq!(p.database.as_deref(), Some("db"));
    }

    #[test]
    fn ipv6_bracketed_host_without_port() {
        let p = parse("redis://user:pw@[2001:db8::1]/0");
        assert_eq!(p.host.as_deref(), Some("2001:db8::1"));
        assert_eq!(p.port, None);
        assert_eq!(p.database.as_deref(), Some("0"));
    }

    #[test]
    fn ipv6_bare_host_treated_whole() {
        let p = parse("redis://::1");
        assert_eq!(p.host.as_deref(), Some("::1"));
        assert_eq!(p.port, None);
    }

    // ---- mongodb+srv / rediss ----

    #[test]
    fn mongodb_srv_sets_option_and_drops_port() {
        let p = parse("mongodb+srv://u:p@cluster0.example.mongodb.net/mydb?authSource=admin");
        assert_eq!(p.kind, Some(DbKind::Mongo));
        assert_eq!(p.host.as_deref(), Some("cluster0.example.mongodb.net"));
        assert_eq!(p.port, None); // SRV 不帶 port
        assert_eq!(p.database.as_deref(), Some("mydb"));
        assert_eq!(opt(&p, "mongo_srv"), Some("1"));
        assert_eq!(opt(&p, "mongo_auth_source"), Some("admin"));
    }

    #[test]
    fn rediss_sets_tls_option() {
        let p = parse("rediss://:secret@cache.example.com:6380/2");
        assert_eq!(p.kind, Some(DbKind::Redis));
        assert_eq!(opt(&p, "redis_tls"), Some("true")); // redis.rs 讀 "true"
        assert_eq!(p.password.as_deref(), Some("secret"));
        assert_eq!(p.database.as_deref(), Some("2"));
        assert_eq!(p.port, Some(6380));
    }

    #[test]
    fn rediss_insecure_fragment_maps_to_option() {
        let p = parse("rediss://h:6380/0#insecure");
        assert_eq!(opt(&p, "redis_tls_insecure"), Some("true"));
        assert_eq!(p.database.as_deref(), Some("0")); // fragment 不進 database
    }

    // ---- mongo query 參數映射 ----

    #[test]
    fn mongo_query_params_mapped() {
        let p = parse(
            "mongodb://h:27017/app?tls=true&replicaSet=rs0&directConnection=true\
             &tlsCAFile=%2Fetc%2Fca.pem&tlsAllowInvalidCertificates=true&unknownParam=x",
        );
        assert_eq!(opt(&p, "mongo_tls"), Some("1")); // mongo.rs 讀 "1"
        assert_eq!(opt(&p, "mongo_replica_set"), Some("rs0"));
        assert_eq!(opt(&p, "mongo_direct"), Some("1"));
        assert_eq!(opt(&p, "mongo_tls_ca"), Some("/etc/ca.pem"));
        assert_eq!(opt(&p, "mongo_tls_insecure"), Some("1"));
        assert!(!p.options.contains_key("unknownParam")); // 未知參數靜默忽略
        assert_eq!(p.database.as_deref(), Some("app"));
    }

    // ---- mysql / postgres SSL 參數 ----

    #[test]
    fn mysql_ssl_params_normalized_lowercase() {
        let p = parse("mysql://h/db?ssl-mode=VERIFY_CA&ssl-ca=C%3A%5Cca.pem");
        assert_eq!(opt(&p, "ssl_mode"), Some("verify_ca"));
        assert_eq!(opt(&p, "ssl_ca"), Some("C:\\ca.pem"));
        // 容錯無連字號寫法。
        let p2 = parse("mysql://h/db?sslmode=REQUIRED");
        assert_eq!(opt(&p2, "ssl_mode"), Some("required"));
    }

    #[test]
    fn postgres_sslrootcert_maps_to_ssl_ca() {
        let p = parse("postgres://h/db?sslmode=verify-full&sslrootcert=/etc/ca.pem");
        assert_eq!(opt(&p, "ssl_mode"), Some("verify-full")); // 直通不改寫
        assert_eq!(opt(&p, "ssl_ca"), Some("/etc/ca.pem"));
    }

    // ---- ADO.NET / JDBC（mssql）----

    #[test]
    fn ado_net_connection_string() {
        let p = parse(
            "Server=tcp:db.example.com,1433;Database=mydb;User ID=sa;Password=p@ss;\
             Encrypt=True;TrustServerCertificate=true",
        );
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("db.example.com"));
        assert_eq!(p.port, Some(1433));
        assert_eq!(p.database.as_deref(), Some("mydb"));
        assert_eq!(p.username.as_deref(), Some("sa"));
        assert_eq!(p.password.as_deref(), Some("p@ss")); // ADO 值為字面值，不 pct-decode
        assert_eq!(opt(&p, "encrypt"), Some("true"));
        assert_eq!(opt(&p, "trust_server_certificate"), Some("true"));
    }

    #[test]
    fn ado_net_alternate_keys() {
        let p = parse("Data Source=host2;Initial Catalog=cat;UID=u;PWD=pw;Encrypt=no");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("host2"));
        assert_eq!(p.database.as_deref(), Some("cat"));
        assert_eq!(p.username.as_deref(), Some("u"));
        assert_eq!(p.password.as_deref(), Some("pw"));
        assert_eq!(opt(&p, "encrypt"), Some("false"));
    }

    #[test]
    fn jdbc_sqlserver_prefix_stripped() {
        let p = parse("jdbc:sqlserver://host:1433;databaseName=db;encrypt=false");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("host"));
        assert_eq!(p.port, Some(1433));
        assert_eq!(p.database.as_deref(), Some("db"));
        assert_eq!(opt(&p, "encrypt"), Some("false"));
    }

    #[test]
    fn sqlserver_semicolon_params() {
        let p = parse("sqlserver://host;database=x;encrypt=true");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("host"));
        assert_eq!(p.database.as_deref(), Some("x"));
        assert_eq!(opt(&p, "encrypt"), Some("true"));
    }

    #[test]
    fn mssql_query_params() {
        let p = parse("mssql://sa:pw@h:1433?database=mydb&encrypt=true&trustServerCertificate=true");
        assert_eq!(p.database.as_deref(), Some("mydb"));
        assert_eq!(opt(&p, "encrypt"), Some("true"));
        assert_eq!(opt(&p, "trust_server_certificate"), Some("true"));
    }

    #[test]
    fn mssql_password_with_semicolon_survives() {
        // 密碼含 `;x=1`：分號參數切割須在 userinfo 抽出之後，否則 host 會被截成 "sa"（回歸）。
        let p = parse("mssql://sa:pa;x=1@dbhost/mydb");
        assert_eq!(p.host.as_deref(), Some("dbhost"));
        assert_eq!(p.username.as_deref(), Some("sa"));
        assert_eq!(p.password.as_deref(), Some("pa;x=1"));
        assert_eq!(p.database.as_deref(), Some("mydb"));
    }

    // ---- 誤判防呆 ----

    #[test]
    fn non_ado_semicolon_text_not_misclassified() {
        // 含分號的檔案路徑：有 `;`+`=` 但無任何識別鍵 → 不判成 MSSQL。
        assert_eq!(parse_url("C:\\data\\app;ver=2.db", None).unwrap().kind, None);
        // 反例：含 Server= 識別鍵仍正確判為 MSSQL。
        assert_eq!(
            parse_url("Server=h;Integrated Security=true", None).unwrap().kind,
            Some(DbKind::Mssql)
        );
        // 註：`bootstrap.servers=…;security.protocol=…` 原本也在這裡（判不出 kind），
        // 現在由 Kafka properties 偵測器認走，正向案例見 kafka_properties_semicolon_separated。
    }

    #[test]
    fn jdbc_non_allowlisted_dialect_rejected() {
        // 白名單外的 dialect 剝殼後會亂解析，須明確報錯而非默默解錯。
        let err = parse_url("jdbc:db2://dbhost:50000/SAMPLE", None).unwrap_err();
        assert!(err.message().contains("jdbc:db2"), "錯誤應含 dialect：{}", err.message());
        assert!(parse_url("jdbc:sybase:Tds:h:5000", None).is_err());
    }

    #[test]
    fn postgres_sslmode_normalized_lowercase() {
        // 大寫 sslmode（部分工具輸出）須正規化，否則前端 Select 無對應、driver 落到 Prefer。
        let p = parse("postgres://u:p@h:5432/db?sslmode=REQUIRE");
        assert_eq!(opt(&p, "ssl_mode"), Some("require"));
    }

    // ---- sqlite / 路徑不誤判 ----

    #[test]
    fn sqlite_scheme_forms() {
        assert_eq!(parse("sqlite:app.db").database.as_deref(), Some("app.db"));
        assert_eq!(
            parse("sqlite:///data/app.db").database.as_deref(),
            Some("/data/app.db")
        );
        // sqlite 路徑整段保留（? 不當 query 切）。
        assert_eq!(
            parse("sqlite:C:\\data\\app.db").database.as_deref(),
            Some("C:\\data\\app.db")
        );
    }

    #[test]
    fn windows_path_not_treated_as_scheme() {
        // `C:` 不在已知 scheme 清單 → 無 scheme；搭配 kind hint 時整段為檔案路徑。
        let p = parse_url("C:\\data\\app.db", Some(DbKind::Sqlite)).unwrap();
        assert_eq!(p.kind, Some(DbKind::Sqlite));
        assert_eq!(p.database.as_deref(), Some("C:\\data\\app.db"));
        // 無 hint：kind 判不出（不 Err、不誤判成其他 kind）。
        let p2 = parse_url("C:\\data\\app.db", None).unwrap();
        assert_eq!(p2.kind, None);
    }

    // ---- 未知 scheme ----

    #[test]
    fn unknown_scheme_errors_without_hint() {
        let err = parse_url("weird://h:1/x", None).unwrap_err();
        assert!(err.message().contains("weird"), "錯誤應含 scheme 名：{}", err.message());
        // 有 hint 時沿用 hint（CLI --kind 搭配非標準 URL 的行為不回歸）。
        let p = parse_url("weird://h:1/x", Some(DbKind::Mysql)).unwrap();
        assert_eq!(p.kind, Some(DbKind::Mysql));
        assert_eq!(p.host.as_deref(), Some("h"));
    }

    // ---- 其他回歸 ----

    #[test]
    fn bare_hostport_with_hint() {
        let p = parse_url("localhost:5433", Some(DbKind::Postgres)).unwrap();
        assert_eq!(p.kind, Some(DbKind::Postgres));
        assert_eq!(p.host.as_deref(), Some("localhost"));
        assert_eq!(p.port, Some(5433));
    }

    #[test]
    fn userinfo_without_password() {
        let p = parse("postgres://alice@h/db");
        assert_eq!(p.username.as_deref(), Some("alice"));
        assert_eq!(p.password, None);
    }

    // ---- 使用者回報的原始字串（回歸釘樁）----

    #[test]
    fn reported_postgres_url_fills_every_field() {
        let p = parse("postgresql://ranai_user:ranai_pass_2026@localhost:5434/ranai");
        assert_eq!(p.kind, Some(DbKind::Postgres));
        assert_eq!(p.host.as_deref(), Some("localhost"));
        assert_eq!(p.port, Some(5434));
        assert_eq!(p.username.as_deref(), Some("ranai_user"));
        assert_eq!(p.password.as_deref(), Some("ranai_pass_2026"));
        assert_eq!(p.database.as_deref(), Some("ranai"));
    }

    // ---- scheme 正規化：dialect+driver / 別名 ----

    #[test]
    fn sqlalchemy_driver_suffix_stripped() {
        assert_eq!(parse("postgresql+psycopg2://h/db").kind, Some(DbKind::Postgres));
        assert_eq!(parse("postgresql+asyncpg://h/db").kind, Some(DbKind::Postgres));
        assert_eq!(parse("postgres+psycopg://h/db").kind, Some(DbKind::Postgres));
        assert_eq!(parse("mysql+pymysql://h/db").kind, Some(DbKind::Mysql));
        assert_eq!(parse("mysql+mysqldb://h/db").kind, Some(DbKind::Mysql));
        assert_eq!(parse("mariadb+mariadbconnector://h/db").kind, Some(DbKind::Mariadb));
        assert_eq!(parse("mssql+pyodbc://h/db").kind, Some(DbKind::Mssql));
        // 欄位仍照常解析，不因剝後綴而漏。
        let p = parse("postgresql+psycopg2://u:pw@h:5432/app");
        assert_eq!(p.host.as_deref(), Some("h"));
        assert_eq!(p.port, Some(5432));
        assert_eq!(p.username.as_deref(), Some("u"));
    }

    #[test]
    fn sqlite_driver_suffix_stripped() {
        // sqlite 走檔案路徑分支，`+aiosqlite` 後綴同樣要先剝掉。
        assert_eq!(
            parse("sqlite+aiosqlite:///data/app.db").database.as_deref(),
            Some("/data/app.db")
        );
    }

    #[test]
    fn mongodb_srv_suffix_not_stripped() {
        // 回歸：`mongodb+srv` 必須走完整比對，不可被 `+` 剝除邏輯拆成 mongodb 而丟掉 SRV 語意。
        let p = parse("mongodb+srv://u:p@cluster0.example.mongodb.net/db");
        assert_eq!(p.kind, Some(DbKind::Mongo));
        assert_eq!(opt(&p, "mongo_srv"), Some("1"));
        assert_eq!(p.port, None);
    }

    #[test]
    fn valkey_aliases_map_to_redis() {
        assert_eq!(parse("valkey://h:6379").kind, Some(DbKind::Redis));
        let p = parse("valkeys://h:6380/1");
        assert_eq!(p.kind, Some(DbKind::Redis));
        assert_eq!(opt(&p, "redis_tls"), Some("true"));
        assert_eq!(p.database.as_deref(), Some("1"));
    }

    #[test]
    fn redis_plus_tls_sets_tls() {
        assert_eq!(opt(&parse("redis+tls://h:6380"), "redis_tls"), Some("true"));
        assert_eq!(opt(&parse("redis+ssl://h:6380"), "redis_tls"), Some("true"));
        // 純 redis:// 不得誤加 TLS。
        assert_eq!(opt(&parse("redis://h:6379"), "redis_tls"), None);
    }

    #[test]
    fn unknown_plus_suffix_still_errors() {
        // 前綴不是已知 scheme → 仍須報錯，不可因為含 `+` 就放行。
        assert!(parse_url("weird+driver://h/db", None).is_err());
    }

    #[test]
    fn amqps_tls_flag_via_scheme_flags() {
        // 回歸：amqps 的 TLS 改由 SchemeFlags 驅動，vhost 仍搬進 rabbitmq_vhost。
        let p = parse("amqps://user:pw@h:5671/myvhost");
        assert_eq!(p.kind, Some(DbKind::RabbitMq));
        assert_eq!(opt(&p, "rabbitmq_tls"), Some("1"));
        assert_eq!(opt(&p, "rabbitmq_vhost"), Some("myvhost"));
        assert_eq!(p.database, None);
        // amqp（無 s）不得帶 TLS。
        assert_eq!(opt(&parse("amqp://h:5672/v"), "rabbitmq_tls"), None);
    }

    // ---- 雜訊容錯（normalize 的端到端效果）----

    #[test]
    fn noise_tolerated_around_url() {
        let expect = |p: Parsed| {
            assert_eq!(p.kind, Some(DbKind::Postgres));
            assert_eq!(p.host.as_deref(), Some("h"));
            assert_eq!(p.port, Some(5432));
            assert_eq!(p.database.as_deref(), Some("db"));
        };
        expect(parse("\"postgres://u:p@h:5432/db\""));
        expect(parse("export DATABASE_URL=postgres://u:p@h:5432/db"));
        expect(parse("DATABASE_URL=\"postgres://u:p@h:5432/db\""));
        expect(parse("postgres://u:p@h:5432/db;"));
        expect(parse("  postgres://u:p@h:5432/db  "));
    }

    // ---- libpq keyword/value ----

    #[test]
    fn libpq_kv_basic() {
        let p = parse("host=localhost port=5434 dbname=ranai user=ranai_user password=secret");
        assert_eq!(p.kind, Some(DbKind::Postgres));
        assert_eq!(p.host.as_deref(), Some("localhost"));
        assert_eq!(p.port, Some(5434));
        assert_eq!(p.database.as_deref(), Some("ranai"));
        assert_eq!(p.username.as_deref(), Some("ranai_user"));
        assert_eq!(p.password.as_deref(), Some("secret"));
    }

    #[test]
    fn libpq_kv_quoted_value_with_space() {
        let p = parse("host=h dbname=d password='a b c'");
        assert_eq!(p.password.as_deref(), Some("a b c"));
        assert_eq!(p.host.as_deref(), Some("h"));
    }

    #[test]
    fn libpq_kv_sslmode_and_rootcert() {
        let p = parse("host=h dbname=d sslmode=VERIFY-FULL sslrootcert=/etc/ca.pem");
        assert_eq!(opt(&p, "ssl_mode"), Some("verify-full")); // 正規化小寫
        assert_eq!(opt(&p, "ssl_ca"), Some("/etc/ca.pem"));
    }

    #[test]
    fn libpq_kv_hostaddr_used_only_when_host_absent() {
        assert_eq!(parse("hostaddr=10.0.0.5 dbname=d").host.as_deref(), Some("10.0.0.5"));
        // host 與 hostaddr 同時給時以 host 為準（憑證驗證用的是名稱）。
        assert_eq!(parse("host=pg.internal hostaddr=10.0.0.5 dbname=d").host.as_deref(), Some("pg.internal"));
    }

    #[test]
    fn libpq_kv_requires_all_tokens_kv() {
        // 含 `=` 但夾雜非 KV 片段的普通文字不可被當成連線字串。
        assert_eq!(parse_url("some random text with = sign", None).unwrap().kind, None);
        assert_eq!(parse_url("SELECT 1 FROM t WHERE a = 1", None).unwrap().kind, None);
    }

    #[test]
    fn libpq_kv_requires_own_marker() {
        // 全是 KV 但沒有任何 libpq 專屬鍵 → 不認（避免亂吃 `a=1 b=2`）。
        assert_eq!(parse_url("a=1 b=2", None).unwrap().kind, None);
    }

    #[test]
    fn libpq_kv_not_triggered_for_url() {
        // 含 `://` 一律走 URL 路徑，即使 query 裡有 `=`。
        let p = parse("postgres://h/db?sslmode=require");
        assert_eq!(p.host.as_deref(), Some("h"));
        assert_eq!(p.database.as_deref(), Some("db"));
    }

    #[test]
    fn ado_user_id_key_not_mistaken_for_libpq() {
        // 回歸：`…;User ID=sa;…` 以空白切恰好是兩段合法 token，必須靠「libpq 專屬鍵」那條擋下，
        // 否則 host 會被解成 `tcp:db.example.com,1433;Database=mydb;User`。
        let p = parse("Server=tcp:db.example.com,1433;Database=mydb;User ID=sa;Password=pw");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("db.example.com"));
        assert_eq!(p.port, Some(1433));
        assert_eq!(p.username.as_deref(), Some("sa"));
    }

    // ---- Npgsql 分號 KV（原先被誤判成 MSSQL 且 host 為空）----

    #[test]
    fn npgsql_string_detected_as_postgres() {
        let p = parse("Host=pg.example.com;Port=5432;Database=app;Username=u;Password=p");
        assert_eq!(p.kind, Some(DbKind::Postgres));
        assert_eq!(p.host.as_deref(), Some("pg.example.com"));
        assert_eq!(p.port, Some(5432));
        assert_eq!(p.database.as_deref(), Some("app"));
        assert_eq!(p.username.as_deref(), Some("u"));
        assert_eq!(p.password.as_deref(), Some("p"));
        // 不可沾染 MSSQL 的選項鍵。
        assert!(!p.options.contains_key("encrypt"));
        assert!(!p.options.contains_key("trust_server_certificate"));
    }

    #[test]
    fn npgsql_ssl_mode_vocabulary_translated() {
        assert_eq!(opt(&parse("Host=h;Database=d;SSL Mode=Require"), "ssl_mode"), Some("require"));
        assert_eq!(opt(&parse("Host=h;Database=d;SSL Mode=VerifyFull"), "ssl_mode"), Some("verify-full"));
        assert_eq!(opt(&parse("Host=h;Database=d;SSL Mode=VerifyCA"), "ssl_mode"), Some("verify-ca"));
        assert_eq!(opt(&parse("Host=h;Database=d;SSL Mode=Disable"), "ssl_mode"), Some("disable"));
        // Prefer / Allow 無對應詞彙，不寫入（driver 預設已是 prefer）。
        assert_eq!(opt(&parse("Host=h;Database=d;SSL Mode=Prefer"), "ssl_mode"), None);
    }

    #[test]
    fn ado_mssql_still_wins_on_mssql_markers() {
        // 同時有 Host= 與 MSSQL 專屬鍵時判 MSSQL（規則 1 優先於規則 2）。
        let p = parse("Host=h;Initial Catalog=cat;User ID=sa;Password=pw");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.database.as_deref(), Some("cat"));
    }

    #[test]
    fn server_key_without_markers_stays_mssql() {
        // 回歸：`Server=…` 形式維持判為 MSSQL（MySQL-Connector-.NET 亦用此形式，刻意不區分）。
        let p = parse("Server=h;Database=d;Uid=u;Pwd=pw");
        assert_eq!(p.kind, Some(DbKind::Mssql));
        assert_eq!(p.host.as_deref(), Some("h"));
    }

    #[test]
    fn semicolon_kv_hint_overrides_classification() {
        // CLI --kind 是使用者明說的，優先於識別鍵推斷。
        let p = parse_url("Server=h;Database=d", Some(DbKind::Postgres)).unwrap();
        assert_eq!(p.kind, Some(DbKind::Postgres));
        assert_eq!(p.host.as_deref(), Some("h"));
        // hint 指向無關類型時不誤判（含 `;` 的 sqlite 路徑）。
        let s = parse_url("C:\\data\\app;v=2.db", Some(DbKind::Sqlite)).unwrap();
        assert_eq!(s.kind, Some(DbKind::Sqlite));
        assert_eq!(s.database.as_deref(), Some("C:\\data\\app;v=2.db"));
    }

    // ---- JDBC 白名單 ----

    #[test]
    fn jdbc_mysql_credentials_from_query() {
        // JDBC 慣用把帳密放 query string。
        let p = parse("jdbc:mysql://dbhost:3306/app?user=root&password=pw");
        assert_eq!(p.kind, Some(DbKind::Mysql));
        assert_eq!(p.host.as_deref(), Some("dbhost"));
        assert_eq!(p.port, Some(3306));
        assert_eq!(p.database.as_deref(), Some("app"));
        assert_eq!(p.username.as_deref(), Some("root"));
        assert_eq!(p.password.as_deref(), Some("pw"));
    }

    #[test]
    fn jdbc_mariadb_and_postgresql_urls() {
        assert_eq!(parse("jdbc:mariadb://h:3306/db").kind, Some(DbKind::Mariadb));
        let p = parse("jdbc:postgresql://h:5432/db?sslmode=require");
        assert_eq!(p.kind, Some(DbKind::Postgres));
        assert_eq!(opt(&p, "ssl_mode"), Some("require"));
    }

    #[test]
    fn userinfo_wins_over_query_credentials() {
        // URL 已寫明 user:pass@ 時，query 的 user / password 不得覆蓋。
        let p = parse("jdbc:mysql://real:realpw@h:3306/db?user=fake&password=fakepw");
        assert_eq!(p.username.as_deref(), Some("real"));
        assert_eq!(p.password.as_deref(), Some("realpw"));
    }

    // ---- Redis / Mongo 多主機與 query ----

    #[test]
    fn redis_db_query_param_sets_database() {
        assert_eq!(parse("redis://h:6379?db=3").database.as_deref(), Some("3"));
        // path 形式仍然有效（既有行為）。
        assert_eq!(parse("redis://h:6379/4").database.as_deref(), Some("4"));
    }

    #[test]
    fn redis_ssl_query_param_sets_tls() {
        assert_eq!(opt(&parse("redis://h:6380?ssl=true"), "redis_tls"), Some("true"));
        assert_eq!(opt(&parse("redis://h:6380?tls=1"), "redis_tls"), Some("true"));
        // 明確為 false 時不得開啟。
        assert_eq!(opt(&parse("redis://h:6380?ssl=false"), "redis_tls"), None);
    }

    #[test]
    fn redis_password_only_userinfo() {
        // 釘住契約：無帳號時 username 為 Some("")（redis.rs 據此走 `:pass@` 分支，
        // 前端 applyParsed 以 `!= null` 判斷故空字串也會套用）。
        let p = parse("redis://:secret@h:6379");
        assert_eq!(p.username.as_deref(), Some(""));
        assert_eq!(p.password.as_deref(), Some("secret"));
    }

    #[test]
    fn mongo_multi_host_uses_first_seed() {
        // build_mongo_uri 一定會接 `:{port}`，整段逗號清單塞進 host 會組出壞 URI；
        // 取第一個 seed，其餘成員由 driver 自 replicaSet 發現。
        let p = parse("mongodb://h1:27017,h2:27017,h3:27017/app?replicaSet=rs0");
        assert_eq!(p.kind, Some(DbKind::Mongo));
        assert_eq!(p.host.as_deref(), Some("h1"));
        assert_eq!(p.port, Some(27017));
        assert_eq!(p.database.as_deref(), Some("app"));
        assert_eq!(opt(&p, "mongo_replica_set"), Some("rs0"));
    }

    #[test]
    fn mongo_multi_host_without_ports() {
        let p = parse("mongodb://u:pw@h1,h2/app");
        assert_eq!(p.host.as_deref(), Some("h1"));
        assert_eq!(p.port, None);
        assert_eq!(p.username.as_deref(), Some("u"));
    }

    #[test]
    fn kafka_multi_broker_host_verbatim() {
        // Kafka 的 bootstrap 清單必須原樣保留（kafka/config.rs 對含 `,` 的 host 直接採用）。
        let p = parse("kafka://h1:9092,h2:9092");
        assert_eq!(p.kind, Some(DbKind::Kafka));
        assert_eq!(p.host.as_deref(), Some("h1:9092,h2:9092"));
        assert_eq!(p.port, None);
    }

    // ---- host percent-decode ----

    #[test]
    fn host_percent_decoded() {
        // libpq / SQLAlchemy 的 unix socket 目錄寫法。
        let p = parse("postgresql://u@%2Fvar%2Frun%2Fpostgresql/app");
        assert_eq!(p.host.as_deref(), Some("/var/run/postgresql"));
        assert_eq!(p.database.as_deref(), Some("app"));
    }

    #[test]
    fn postgres_without_host_keeps_database() {
        // `postgres:///db`：無 host（本機 socket / 預設），database 仍須解出。
        let p = parse("postgres:///mydb");
        assert_eq!(p.kind, Some(DbKind::Postgres));
        assert_eq!(p.host, None);
        assert_eq!(p.database.as_deref(), Some("mydb"));
    }

    // ---- Oracle：JDBC thin / EZConnect / TNS ----

    #[test]
    fn jdbc_oracle_thin_service_form() {
        let p = parse("jdbc:oracle:thin:@//dbhost:1521/XEPDB1");
        assert_eq!(p.kind, Some(DbKind::Oracle));
        assert_eq!(p.host.as_deref(), Some("dbhost"));
        assert_eq!(p.port, Some(1521));
        assert_eq!(p.database.as_deref(), Some("XEPDB1"));
        // service 是預設值，不發 connect_type（對齊前端 buildOptions 的省略規則）。
        assert_eq!(opt(&p, "connect_type"), None);
    }

    #[test]
    fn jdbc_oracle_thin_sid_form() {
        let p = parse("jdbc:oracle:thin:@dbhost:1521:ORCL");
        assert_eq!(p.kind, Some(DbKind::Oracle));
        assert_eq!(p.host.as_deref(), Some("dbhost"));
        assert_eq!(p.port, Some(1521));
        assert_eq!(p.database.as_deref(), Some("ORCL"));
        assert_eq!(opt(&p, "connect_type"), Some("sid"));
    }

    #[test]
    fn jdbc_oracle_oci_and_tns_alias() {
        // oci driver 與 thin 同樣處理。
        let p = parse("jdbc:oracle:oci:@//h:1521/svc");
        assert_eq!(p.database.as_deref(), Some("svc"));
        // 單一 token → TNS 別名。
        let a = parse("jdbc:oracle:thin:@MYALIAS");
        assert_eq!(a.kind, Some(DbKind::Oracle));
        assert_eq!(a.database.as_deref(), Some("MYALIAS"));
        assert_eq!(opt(&a, "connect_type"), Some("tns"));
    }

    #[test]
    fn oracle_ezconnect_with_hint() {
        // 裸 `host:port/service` 需搭配 kind hint（無 scheme 時本模組不猜類型）。
        let p = parse_url("dbhost:1521/XEPDB1", Some(DbKind::Oracle)).unwrap();
        assert_eq!(p.host.as_deref(), Some("dbhost"));
        assert_eq!(p.port, Some(1521));
        assert_eq!(p.database.as_deref(), Some("XEPDB1"));
    }

    #[test]
    fn tns_descriptor_fields_extracted() {
        let p = parse(
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.example.com)(PORT=1521))\
             (CONNECT_DATA=(SERVICE_NAME=XEPDB1)))",
        );
        assert_eq!(p.kind, Some(DbKind::Oracle));
        assert_eq!(p.host.as_deref(), Some("db.example.com"));
        assert_eq!(p.port, Some(1521));
        assert_eq!(p.database.as_deref(), Some("XEPDB1"));
        assert_eq!(opt(&p, "connect_type"), None); // SERVICE_NAME → service
    }

    #[test]
    fn tns_descriptor_sid_sets_connect_type() {
        let p = parse("(DESCRIPTION=(ADDRESS=(HOST=h)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))");
        assert_eq!(p.database.as_deref(), Some("ORCL"));
        assert_eq!(opt(&p, "connect_type"), Some("sid"));
    }

    #[test]
    fn tns_descriptor_unparseable_falls_back_to_tns() {
        // 抓不到 HOST → 整段當 TNS 別名交給 driver（oracle.rs 的 tns 分支原樣傳遞）。
        let raw = "(DESCRIPTION=(CONNECT_DATA=(SERVICE_NAME=svc)))";
        let p = parse(raw);
        assert_eq!(p.kind, Some(DbKind::Oracle));
        assert_eq!(opt(&p, "connect_type"), Some("tns"));
        assert_eq!(p.database.as_deref(), Some(raw));
    }

    // ---- Elasticsearch：http(s) URL 與 Cloud ID ----

    #[test]
    fn elastic_https_url_host_is_full_url() {
        let p = parse("https://es.example.com:9243");
        assert_eq!(p.kind, Some(DbKind::Elastic));
        // 整段 URL 存進 host（elastic/config.rs 的 build_base_url 對此原樣採用）。
        assert_eq!(p.host.as_deref(), Some("https://es.example.com:9243"));
        assert_eq!(p.port, Some(9243));
        assert_eq!(p.database, None); // elastic 無資料庫概念
        assert_eq!(opt(&p, "es_tls"), None); // scheme 已在 host 裡，不重複發
    }

    #[test]
    fn elastic_https_url_sets_basic_auth() {
        let p = parse("https://elastic:pw%40123@es.example.com:9243");
        assert_eq!(p.username.as_deref(), Some("elastic"));
        assert_eq!(p.password.as_deref(), Some("pw@123")); // userinfo 仍 percent-decode
        // 沒有這條，前端 esAuth 會留在 none，而 build() 會把剛填好的帳密清空存檔。
        assert_eq!(opt(&p, "es_auth"), Some("basic"));
        // host 不可殘留 userinfo。
        assert_eq!(p.host.as_deref(), Some("https://es.example.com:9243"));
    }

    #[test]
    fn elastic_url_without_credentials_does_not_emit_es_auth() {
        // 刻意不發 "none"：發了會害使用者之後手動補的帳密被 usesAuth 判定為不需認證而清空。
        let p = parse("http://localhost:9200");
        assert_eq!(p.host.as_deref(), Some("http://localhost:9200"));
        assert_eq!(opt(&p, "es_auth"), None);
    }

    #[test]
    fn elastic_url_path_and_trailing_slash() {
        // 尾斜線去掉；路徑保留在 host 內（反向代理常掛在子路徑下）。
        assert_eq!(
            parse("https://es.example.com/").host.as_deref(),
            Some("https://es.example.com")
        );
        assert_eq!(
            parse("https://proxy.example.com/es").host.as_deref(),
            Some("https://proxy.example.com/es")
        );
    }

    #[test]
    fn cloud_id_expands_to_node_url() {
        // `name:base64("host$es_uuid$kibana_uuid")`
        // base64("example.aws.found.io$abc123$def456")
        let cid = "mydeploy:ZXhhbXBsZS5hd3MuZm91bmQuaW8kYWJjMTIzJGRlZjQ1Ng==";
        let p = parse(cid);
        assert_eq!(p.kind, Some(DbKind::Elastic));
        assert_eq!(p.host.as_deref(), Some("https://abc123.example.aws.found.io"));
    }

    #[test]
    fn known_scheme_with_colon_not_mistaken_for_cloud_id() {
        // `sqlite:app.db` 的右半段不是合法 base64，且已知 scheme 也排在 cloud id 之前。
        assert_eq!(parse("sqlite:app.db").kind, Some(DbKind::Sqlite));
        // 一般 `name:value` 解不開 base64 → 不誤判成 Elastic。
        assert_eq!(parse_url("label:some.value", None).unwrap().kind, None);
    }

    // ---- Kafka properties ----

    #[test]
    fn kafka_properties_newline_separated() {
        let p = parse(
            "bootstrap.servers=pkc-x.confluent.cloud:9092\n\
             security.protocol=SASL_SSL\n\
             sasl.mechanism=PLAIN\n\
             sasl.username=MYKEY\n\
             sasl.password=MYSECRET",
        );
        assert_eq!(p.kind, Some(DbKind::Kafka));
        assert_eq!(p.host.as_deref(), Some("pkc-x.confluent.cloud:9092"));
        assert_eq!(opt(&p, "kafka_security_protocol"), Some("SASL_SSL"));
        assert_eq!(opt(&p, "kafka_sasl_mechanism"), Some("PLAIN"));
        assert_eq!(p.username.as_deref(), Some("MYKEY"));
        assert_eq!(p.password.as_deref(), Some("MYSECRET"));
    }

    #[test]
    fn kafka_properties_semicolon_separated() {
        let p = parse("bootstrap.servers=h:9092;security.protocol=SSL");
        assert_eq!(p.kind, Some(DbKind::Kafka));
        assert_eq!(p.host.as_deref(), Some("h:9092"));
        assert_eq!(opt(&p, "kafka_security_protocol"), Some("SSL"));
    }

    #[test]
    fn kafka_jaas_config_credentials_extracted() {
        let p = parse(
            "bootstrap.servers=h:9092\n\
             security.protocol=SASL_SSL\n\
             sasl.mechanism=PLAIN\n\
             sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule \
             required username=\"K1\" password=\"S1\";",
        );
        assert_eq!(p.username.as_deref(), Some("K1"));
        assert_eq!(p.password.as_deref(), Some("S1"));
    }

    #[test]
    fn kafka_properties_comments_ignored() {
        let p = parse(
            "# Confluent Cloud\n\
             bootstrap.servers=h:9092\n\
             ! legacy comment\n\
             security.protocol=SASL_SSL",
        );
        assert_eq!(p.kind, Some(DbKind::Kafka));
        assert_eq!(opt(&p, "kafka_security_protocol"), Some("SASL_SSL"));
    }

    #[test]
    fn kafka_properties_without_marker_returns_none() {
        // 沒有任何 Kafka 識別鍵 → 不認（避免亂吃普通 properties 檔）。
        assert_eq!(parse_url("foo.bar=1\nbaz.qux=2", None).unwrap().kind, None);
    }

    // ---- looks_structured：有 kind hint 時的防呆 ----

    #[test]
    fn looks_structured_accepts_real_connection_strings() {
        for s in [
            "postgresql://u:p@h:5432/db",
            "jdbc:oracle:thin:@//h:1521/svc",
            "(DESCRIPTION=(ADDRESS=(HOST=h)(PORT=1521)))",
            "host=localhost port=5432 dbname=app",
            "Server=h;Database=d",
            "dbhost:1521/XEPDB1",
            "localhost:5434",
            "C:\\data\\app.db",
            "/var/lib/app.sqlite",
        ] {
            assert!(looks_structured(s), "應視為有結構：{s}");
        }
    }

    #[test]
    fn looks_structured_rejects_bare_words() {
        // 單一裸字不帶埠 / 資料庫資訊，解析它沒有意義；使用者直接填「主機」欄即可。
        // 這道防呆是有 kind hint 時唯一擋得住「隨手貼一段文字」的東西。
        for s in ["", "   ", "localhost", "ranai_pass_2026", "p@ssw0rd", "SELECT 1 FROM t"] {
            assert!(!looks_structured(s), "不應視為有結構：{s}");
        }
    }

    #[test]
    fn kafka_ssl_options_mapped() {
        let p = parse(
            "bootstrap.servers=h:9092\n\
             security.protocol=SSL\n\
             ssl.ca.location=/etc/ca.pem\n\
             enable.ssl.certificate.verification=false",
        );
        assert_eq!(opt(&p, "kafka_ssl_ca"), Some("/etc/ca.pem"));
        assert_eq!(opt(&p, "kafka_ssl_insecure"), Some("1"));
    }
}
