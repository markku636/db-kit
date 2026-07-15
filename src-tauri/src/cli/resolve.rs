//! 連線解析：`--conn`（已存）或臨時旗標 / `--url`（臨時）→ `ConnectionConfig`。

use uuid::Uuid;

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
    let dir = store::headless_config_dir()?;
    let all = store::load_all_in(&dir).await?;
    let found = all
        .iter()
        .find(|c| c.name == needle)
        .or_else(|| all.iter().find(|c| c.id == needle))
        .ok_or_else(|| AppError::NotFound(needle.to_string()))?;
    let mut cfg = store::load_connection_in(&dir, &found.id).await?;
    if matches!(cfg.kind, DbKind::External) {
        return Err(AppError::Unsupported(
            t!("CLI 不支援外部 gateway（External）連線").into(),
        ));
    }
    if matches!(cfg.kind, DbKind::Kafka) {
        return Err(AppError::Unsupported(
            t!("CLI 不支援 Kafka 連線（請用 GUI）").into(),
        ));
    }
    if let Some(db) = &args.database {
        cfg.database = Some(db.clone());
    }
    Ok(cfg)
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
        DbKind::Sqlite | DbKind::External => 0,
    }
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

    let kind = parsed.kind.ok_or_else(|| {
        AppError::Connect(t!("無法判斷連線種類（請加 --kind 或於 --url 指定 scheme）").into())
    })?;

    // 個別旗標覆寫 URL 解析到的對應欄位。
    let host = args
        .host
        .clone()
        .or(parsed.host)
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = args.port.or(parsed.port).unwrap_or_else(|| default_port(kind));
    let username = args.user.clone().or(parsed.username).unwrap_or_default();
    let password = args.password.clone().or(parsed.password).unwrap_or_default();
    // sqlite：database 視為檔案路徑；其餘為預設 DB / schema。
    let database = args.database.clone().or(parsed.database);

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
        options: Default::default(),
        otp_secret: String::new(),
    })
}

#[derive(Default)]
struct Parsed {
    kind: Option<DbKind>,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    database: Option<String>,
}

/// 取出 scheme：先試 `scheme://`，再試 `scheme:`（僅限已知 scheme，避免把 Windows 磁碟機 `C:` 當 scheme）。
fn split_scheme(url: &str) -> (Option<String>, String) {
    if let Some((s, r)) = url.split_once("://") {
        return (Some(s.to_ascii_lowercase()), r.to_string());
    }
    const SCHEMES: &[&str] = &[
        "sqlite",
        "mysql",
        "mariadb",
        "postgres",
        "postgresql",
        "mongodb",
        "mongo",
        "redis",
        "mssql",
        "sqlserver",
        "oracle",
        "kafka",
    ];
    if let Some((s, r)) = url.split_once(':') {
        if SCHEMES.contains(&s.to_ascii_lowercase().as_str()) {
            return (Some(s.to_ascii_lowercase()), r.to_string());
        }
    }
    (None, url.to_string())
}

/// 極簡 URL/DSN 解析：`scheme://[user[:pass]@]host[:port][/db]`。
/// sqlite 特例：`sqlite:path` / `sqlite://path` 或直接給檔案路徑 → database = path（不需 url crate）。
fn parse_url(url: &str, kind_hint: Option<DbKind>) -> AppResult<Parsed> {
    let (scheme, rest) = split_scheme(url);

    let kind = match scheme.as_deref() {
        Some("mysql") => Some(DbKind::Mysql),
        Some("mariadb") => Some(DbKind::Mariadb),
        Some("postgres") | Some("postgresql") => Some(DbKind::Postgres),
        Some("mongodb") | Some("mongo") => Some(DbKind::Mongo),
        Some("redis") => Some(DbKind::Redis),
        Some("mssql") | Some("sqlserver") => Some(DbKind::Mssql),
        Some("oracle") => Some(DbKind::Oracle),
        Some("kafka") => Some(DbKind::Kafka),
        Some("sqlite") => Some(DbKind::Sqlite),
        _ => kind_hint,
    };

    // sqlite：去掉 scheme 後整段當檔案路徑。
    if matches!(kind, Some(DbKind::Sqlite)) {
        let path = if scheme.is_some() { rest } else { url.to_string() };
        return Ok(Parsed {
            kind,
            database: Some(path),
            ..Default::default()
        });
    }

    let mut p = Parsed {
        kind,
        ..Default::default()
    };

    // 切出 /db。
    let (authority, db) = match rest.split_once('/') {
        Some((a, d)) => (
            a.to_string(),
            if d.is_empty() { None } else { Some(d.to_string()) },
        ),
        None => (rest, None),
    };
    p.database = db;

    // 切出 user[:pass]@。
    let hostport = if let Some((userinfo, hp)) = authority.rsplit_once('@') {
        match userinfo.split_once(':') {
            Some((u, pw)) => {
                p.username = Some(u.to_string());
                p.password = Some(pw.to_string());
            }
            None => p.username = Some(userinfo.to_string()),
        }
        hp.to_string()
    } else {
        authority
    };

    // 切出 host[:port]。
    match hostport.rsplit_once(':') {
        Some((h, port_str)) if !h.is_empty() => {
            p.host = Some(h.to_string());
            p.port = port_str.parse::<u16>().ok();
        }
        _ => {
            if !hostport.is_empty() {
                p.host = Some(hostport);
            }
        }
    }

    Ok(p)
}
