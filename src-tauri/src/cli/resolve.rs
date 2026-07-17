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
