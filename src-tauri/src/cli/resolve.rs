//! 連線解析：`--conn`（已存）或臨時旗標 / `--url`（臨時）→ `ConnectionConfig`。

use uuid::Uuid;

use crate::db::conn_url::{parse_url, Parsed};
use crate::db::{ConnectionConfig, DbKind};
use crate::error::{AppError, AppResult};
use crate::store;

use super::args::{ConnArgs, KindArg};

/// 解析連線設定：優先 `--conn`（已存），否則用臨時旗標 / `--url` 組臨時連線。
pub async fn resolve(args: &ConnArgs) -> AppResult<ConnectionConfig> {
    if let Some(needle) = &args.conn {
        resolve_saved(needle, args).await
    } else {
        resolve_adhoc(args)
    }
}

/// 以名稱（優先）或 id 在已存連線中找出一筆，並從 keychain hydrate 機密。
async fn resolve_saved(needle: &str, args: &ConnArgs) -> AppResult<ConnectionConfig> {
    resolve_saved_by(needle, args.database.as_deref()).await
}

async fn resolve_saved_by(needle: &str, database: Option<&str>) -> AppResult<ConnectionConfig> {
    let dir = store::headless_config_dir()?;
    let all = store::load_all_in(&dir).await?;
    let found = all
        .iter()
        .find(|c| c.name == needle)
        .or_else(|| all.iter().find(|c| c.id == needle))
        .ok_or_else(|| AppError::NotFound(needle.to_string()))?;
    let mut cfg = store::load_connection_in(&dir, &found.id).await?;
    ensure_cli_kind(cfg.kind)?;
    cfg.database = apply_namespace(cfg.kind, cfg.database.take(), database);
    Ok(cfg)
}

/// 套用 `-d` / `--src-db` / `--dst-db`：這些旗標指的是「要**檢視**的命名空間」——
/// MySQL / SQL Server 的 database、PostgreSQL 的 schema、Oracle 的 owner、SQLite 的檔案。
///
/// PostgreSQL 是唯一「命名空間」與「要連上的資料庫」不同軸的引擎：`ConnectionConfig.database`
/// 是 sqlx 要連的**資料庫**，schema 只是其中一層。把 schema 名寫進去，連線階段就會死在
/// `database "public" does not exist`——所以 PG 以連線自帶的資料庫為準，旗標只在連線沒指定時補位。
/// 其餘引擎兩者同義，旗標優先（MySQL 的視圖 / 程序 DDL 未限定庫名，同步時得靠連線的預設庫）。
fn apply_namespace(kind: DbKind, current: Option<String>, flag: Option<&str>) -> Option<String> {
    let flag = flag.map(str::to_string);
    if matches!(kind, DbKind::Postgres) {
        current.or(flag)
    } else {
        flag.or(current)
    }
}

/// 比對指令的「一側」：連線或結構快照檔。
pub enum SideRef {
    Conn(ConnectionConfig),
    Snapshot(std::path::PathBuf),
}

/// 把 `--src` / `--dst` 這類單一字串解析成一側：
/// - 以 `.json` 結尾且檔案存在 → 快照檔；
/// - 含 `://`（或 `jdbc:` 前綴）→ 連線字串（臨時連線）；
/// - 其餘 → 已存連線名稱 / id。
/// `database` 為該側要檢視的命名空間（見 `apply_namespace`）。
pub async fn resolve_ref(s: &str, database: Option<&str>) -> AppResult<SideRef> {
    let p = std::path::Path::new(s);
    if s.to_ascii_lowercase().ends_with(".json") && p.is_file() {
        return Ok(SideRef::Snapshot(p.to_path_buf()));
    }
    if s.contains("://") || s.starts_with("jdbc:") {
        let mut cfg = from_url(s, None)?;
        cfg.database = apply_namespace(cfg.kind, cfg.database.take(), database);
        return Ok(SideRef::Conn(cfg));
    }
    Ok(SideRef::Conn(resolve_saved_by(s, database).await?))
}

/// CLI 支援的連線種類守門。訊息 / 搜尋引擎類（Kafka / Elasticsearch / RabbitMQ）與 external gateway
/// 沒有可在終端機表達的通用查詢語言，且 slim CLI（`--no-default-features`）根本沒編入其驅動，
/// 故已存連線與臨時連線（`--kind` / `--url`）都在此擋下，而非讓使用者連上後每個指令才報錯。
fn ensure_cli_kind(kind: DbKind) -> AppResult<()> {
    let msg = match kind {
        DbKind::External => t!("CLI 不支援外部 gateway（External）連線"),
        DbKind::Kafka => t!("CLI 不支援 Kafka 連線（請用 GUI）"),
        DbKind::Elastic => t!("CLI 不支援 Elasticsearch 連線（請用 GUI）"),
        DbKind::RabbitMq => t!("CLI 不支援 RabbitMQ 連線（請用 GUI）"),
        _ => return Ok(()),
    };
    Err(AppError::Unsupported(msg.into()))
}

fn kind_of(k: KindArg) -> DbKind {
    match k {
        KindArg::Mysql => DbKind::Mysql,
        KindArg::Mariadb => DbKind::Mariadb,
        KindArg::Postgres => DbKind::Postgres,
        KindArg::Sqlite => DbKind::Sqlite,
        KindArg::Mongo => DbKind::Mongo,
        KindArg::Redis => DbKind::Redis,
        KindArg::Mssql => DbKind::Mssql,
        KindArg::Oracle => DbKind::Oracle,
        KindArg::Kafka => DbKind::Kafka,
        KindArg::Elastic => DbKind::Elastic,
        KindArg::Rabbitmq => DbKind::RabbitMq,
    }
}

fn default_port(kind: DbKind) -> u16 {
    match kind {
        DbKind::Mysql | DbKind::Mariadb => 3306,
        DbKind::Postgres => 5432,
        DbKind::Mongo => 27017,
        DbKind::Redis => 6379,
        DbKind::Mssql => 1433,
        DbKind::Oracle => 1521,
        DbKind::Kafka => 9092,
        DbKind::Elastic => 9200,
        DbKind::RabbitMq => 5672,
        DbKind::Sqlite | DbKind::External => 0,
    }
}

/// 只靠連線字串組臨時連線（比對指令的 `--dst mysql://…` 用）。
fn from_url(url: &str, kind_hint: Option<DbKind>) -> AppResult<ConnectionConfig> {
    let parsed = parse_url(url, kind_hint)?;
    build_adhoc(parsed, None, None, None, None, None)
}

/// 由臨時旗標（含 `--url`）組出 `ConnectionConfig`，id 為一次性 `cli-<uuid>`（僅當 manager 索引）。
fn resolve_adhoc(args: &ConnArgs) -> AppResult<ConnectionConfig> {
    let parsed = if let Some(url) = &args.url {
        parse_url(url, args.kind.map(kind_of))?
    } else if let Some(k) = args.kind {
        Parsed {
            kind: Some(kind_of(k)),
            ..Default::default()
        }
    } else {
        return Err(AppError::Connect(
            t!("請以 --conn <名稱> 指定已存連線，或以 --kind / --url 指定臨時連線").into(),
        ));
    };
    build_adhoc(
        parsed,
        args.host.as_deref(),
        args.port,
        args.user.as_deref(),
        args.password.as_deref(),
        args.database.as_deref(),
    )
}

fn build_adhoc(
    parsed: Parsed,
    host: Option<&str>,
    port: Option<u16>,
    user: Option<&str>,
    password: Option<&str>,
    database: Option<&str>,
) -> AppResult<ConnectionConfig> {
    let kind = parsed.kind.ok_or_else(|| {
        AppError::Connect(t!("無法判斷連線種類（請加 --kind 或於 --url 指定 scheme）").into())
    })?;
    ensure_cli_kind(kind)?;

    // 個別旗標覆寫 URL 解析到的對應欄位。
    let host = host
        .map(str::to_string)
        .or(parsed.host)
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = port.or(parsed.port).unwrap_or_else(|| default_port(kind));
    let username = user.map(str::to_string).or(parsed.username).unwrap_or_default();
    let password = password.map(str::to_string).or(parsed.password).unwrap_or_default();
    // sqlite：database 視為檔案路徑；其餘為要檢視的命名空間（PG 例外，見 apply_namespace）。
    let database = apply_namespace(kind, parsed.database, database);
    // URL query 解析出的 driver options（ssl_mode / mongo_* / redis_tls 等）直接帶入。
    let options = parsed.options;

    Ok(ConnectionConfig {
        id: format!("cli-{}", Uuid::new_v4()),
        name: "cli".to_string(),
        kind,
        host,
        port,
        username,
        password,
        database,
        max_connections: 5,
        ssh_enabled: false,
        ssh_host: String::new(),
        ssh_port: 0,
        ssh_username: String::new(),
        ssh_auth_method: Default::default(),
        ssh_password: String::new(),
        ssh_private_key_path: String::new(),
        ssh_passphrase: String::new(),
        options,
        otp_secret: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `-d` / `--dst-db` 是「要檢視的命名空間」，不是「要連上的資料庫」。
    /// PG 兩者不同軸：旗標寫進 database 會讓連線階段死在 `database "public" does not exist`。
    #[test]
    fn namespace_flag_does_not_clobber_postgres_database() {
        let db = |s: &str| Some(s.to_string());
        // PG：連線字串 / 已存連線自帶的資料庫優先，旗標（schema）不覆寫。
        assert_eq!(apply_namespace(DbKind::Postgres, db("testdb"), Some("public")), db("testdb"));
        // PG 且連線沒指定資料庫時，旗標補位（總比沒有好；driver 無值時會退到 "postgres"）。
        assert_eq!(apply_namespace(DbKind::Postgres, None, Some("public")), db("public"));
        // 其餘引擎兩者同義，旗標優先。
        assert_eq!(apply_namespace(DbKind::Mysql, db("a"), Some("b")), db("b"));
        assert_eq!(apply_namespace(DbKind::Mssql, db("a"), Some("b")), db("b"));
        assert_eq!(apply_namespace(DbKind::Sqlite, db("x.db"), Some("y.db")), db("y.db"));
        // 兩邊都沒有就是沒有。
        assert_eq!(apply_namespace(DbKind::Mysql, None, None), None);
        assert_eq!(apply_namespace(DbKind::Postgres, None, None), None);
    }

    /// 由 URL 組臨時連線時走同一條規則（`--url postgres://…/testdb --dst-db public`）。
    #[test]
    fn adhoc_from_url_keeps_postgres_database_from_url() {
        let cfg = build_adhoc(
            parse_url("postgres://u:p@h:5432/testdb", None).unwrap(),
            None, None, None, None, Some("public"),
        )
        .unwrap();
        assert_eq!(cfg.database.as_deref(), Some("testdb"));
        // MySQL 相反：旗標指定的就是要看的 schema。
        let cfg = build_adhoc(
            parse_url("mysql://u:p@h:3306/testdb", None).unwrap(),
            None, None, None, None, Some("shop"),
        )
        .unwrap();
        assert_eq!(cfg.database.as_deref(), Some("shop"));
    }
}
