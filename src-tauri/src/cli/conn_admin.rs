//! `dbk conn add` / `dbk conn remove`：從命令列建立 / 刪除已存連線。
//!
//! 主要給 AI 代理人（Claude Code / Codex…）用：它們只能打指令，以前得請使用者打開 GUI 填表，
//! 現在一行 `dbk conn add` 就能把連線存好，之後 `--conn <名稱>` 與 `dbk mcp` 都認得。
//!
//! - 連線本體沿用全域臨時連線旗標（`--kind` / `--url` / `--host` / `--port` / `--user` /
//!   `--password` / `-d`），跟「臨時連一次」完全同一套解析，不另立一份語法。
//! - 存檔走 `store::save_connection_in`（與 GUI 儲存連線同一份實作）：密碼進 OS keychain，
//!   connections.json 不落任何 secret；GUI 切回視窗時會重讀清單，側欄直接出現。
//! - 預設存檔前先連一次，連不上就不存（AI 打錯埠號、帳密時立刻知道，而不是留下一筆壞連線）。
//! - 新增免確認（只動本機設定，不碰資料庫）；覆寫既有連線、刪除連線要 `--yes`，刪 PROD 連線再要 `--force`。

use std::collections::BTreeMap;
use std::io::BufRead;

use uuid::Uuid;

use crate::db::{ConnectionConfig, SshAuthMethod};
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;
use crate::store::{self, PersistedConnection};

use super::args::{ConnAddArgs, ConnArgs, Format};
use super::{guard, render, resolve};

pub async fn add(conn: &ConnArgs, fmt: Format, a: ConnAddArgs) -> AppResult<()> {
    if conn.conn.is_some() {
        return Err(AppError::Connect(
            t!("conn add 不能搭配 --conn；請用 --kind / --url / --host 等旗標描述新連線").into(),
        ));
    }
    let name = a.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Connect(t!("連線名稱不能是空的").into()));
    }

    let mut cfg = resolve::adhoc_for_save(conn)?;
    cfg.name = name.clone();
    if a.password_stdin {
        cfg.password = read_stdin_line()?;
    }
    apply_options(&mut cfg.options, &a)?;
    apply_ssh(&mut cfg, &a)?;

    let dir = store::headless_config_dir()?;
    let all = store::load_all_in(&dir).await?;
    let existing = find_unique_by_name(&all, &name)?;
    let replaced = match existing {
        Some(old) => {
            if !a.replace {
                return Err(AppError::Storage(tf!(
                    "已有同名連線「{name}」（{id}）；要覆寫請加 --replace --yes，或換個名稱",
                    name = name,
                    id = old.id
                )));
            }
            guard::ensure_confirmed(conn.yes, conn.force, false, &tf!("覆寫已存連線「{name}」", name = name))?;
            cfg.id = old.id.clone();
            // 沒重新給的 secret 沿用舊的（測試連線要用；存檔時空字串本來就是「不變動」）。
            let prev = store::load_connection_in(&dir, &old.id).await?;
            inherit_secrets(&mut cfg, &prev);
            true
        }
        None => {
            cfg.id = Uuid::new_v4().to_string();
            false
        }
    };

    let test = if a.no_test {
        "skipped"
    } else if resolve::ensure_cli_kind(cfg.kind).is_err() {
        // Kafka / Elasticsearch / RabbitMQ：CLI 沒有驅動，存給 GUI 用、不測。
        "unsupported"
    } else {
        // 測試用一次性 id：不要讓 manager 以正式 id 索引一條測完就丟的連線。
        let mut probe = cfg.clone();
        probe.id = format!("cli-{}", Uuid::new_v4());
        if let Err(e) = ConnectionManager::new().test(&probe).await {
            // 原錯誤照原樣回（由 CLI 外層本地化）；這裡只補一行「沒存、怎麼強制存」。
            eprintln!("{}", t!("連線測試失敗，未存檔（確定要先存起來請加 --no-test）"));
            return Err(e);
        }
        "ok"
    };

    store::save_connection_in(&dir, &cfg).await?;
    let group = match a.group.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
        Some(g) => {
            store::assign_group_in(&dir, &cfg.id, g).await?;
            Some(g.to_string())
        }
        // 覆寫時沒給 --group：群組由 upsert 保留，回報既有的群組名稱。
        None => {
            let file = store::load_file_in(&dir).await?;
            file.connections
                .iter()
                .find(|c| c.id == cfg.id)
                .and_then(|c| c.group_id.as_ref())
                .and_then(|gid| file.groups.iter().find(|g| &g.id == gid))
                .map(|g| g.name.clone())
        }
    };

    // 輸出刻意不含任何 secret。
    let summary = serde_json::json!({
        "action": if replaced { "replaced" } else { "created" },
        "name": cfg.name,
        "id": cfg.id,
        "kind": cfg.kind.as_str(),
        "host": cfg.host,
        "port": cfg.port,
        "user": cfg.username,
        "database": cfg.database,
        "group": group,
        "prod": a.prod,
        "ssh": cfg.ssh_enabled,
        "test": test,
    });
    if matches!(fmt, Format::Table) {
        let line = if replaced {
            tf!("已覆寫連線「{name}」，之後用 --conn \"{name}\" 即可", name = cfg.name)
        } else {
            tf!("已新增連線「{name}」，之後用 --conn \"{name}\" 即可", name = cfg.name)
        };
        eprintln!("{line}");
    }
    render::emit_value(fmt, &summary);
    Ok(())
}

pub async fn remove(conn: &ConnArgs, target: &str) -> AppResult<()> {
    let dir = store::headless_config_dir()?;
    let all = store::load_all_in(&dir).await?;
    let found = match all.iter().find(|c| c.id == target) {
        Some(c) => c,
        None => find_unique_by_name(&all, target)?.ok_or_else(|| AppError::NotFound(target.to_string()))?,
    };
    // 刪 PROD 連線多要一個 --force：側欄那筆連線常是團隊匯入的，刪了要重新跟人要帳密。
    let prod = crate::conn_export::is_prod(found);
    guard::ensure_confirmed(
        conn.yes,
        conn.force,
        prod,
        &tf!("刪除已存連線「{name}」（{id}）", name = found.name, id = found.id),
    )?;
    let (name, id) = (found.name.clone(), found.id.clone());
    store::remove_connection_in(&dir, &id).await?;
    println!("{}", tf!("已刪除連線「{name}」", name = name));
    Ok(())
}

/// 依名稱找唯一一筆：0 筆 → `None`；多筆同名 → 錯誤（請改用 id），避免刪 / 覆寫到別筆。
fn find_unique_by_name<'a>(all: &'a [PersistedConnection], name: &str) -> AppResult<Option<&'a PersistedConnection>> {
    let mut same = all.iter().filter(|c| c.name == name);
    match (same.next(), same.next()) {
        (None, _) => Ok(None),
        (Some(c), None) => Ok(Some(c)),
        (Some(_), Some(_)) => {
            let n = all.iter().filter(|c| c.name == name).count();
            Err(AppError::Storage(tf!(
                "有 {n} 筆連線都叫「{name}」，請改用 id 指定（dbk conn list 可查）",
                n = n,
                name = name
            )))
        }
    }
}

fn read_stdin_line() -> AppResult<String> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| AppError::Connect(tf!("讀取 stdin 密碼失敗：{e}", e = e)))?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

/// `--opt k=v` / `--ssl-mode` / `--prod` → `options`（與 GUI 連線對話框寫入的鍵一致）。
fn apply_options(options: &mut BTreeMap<String, String>, a: &ConnAddArgs) -> AppResult<()> {
    for kv in &a.opts {
        let (k, v) = kv
            .split_once('=')
            .filter(|(k, _)| !k.trim().is_empty())
            .ok_or_else(|| AppError::Connect(tf!("--opt 格式應為 key=value：{kv}", kv = kv)))?;
        options.insert(k.trim().to_string(), v.to_string());
    }
    if let Some(m) = a.ssl_mode.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        options.insert("ssl_mode".to_string(), m.to_string());
    }
    if a.prod {
        options.insert("prod".to_string(), "1".to_string());
    }
    Ok(())
}

fn apply_ssh(cfg: &mut ConnectionConfig, a: &ConnAddArgs) -> AppResult<()> {
    let Some(host) = a.ssh_host.as_deref().map(str::trim).filter(|h| !h.is_empty()) else {
        if a.ssh_user.is_some() || a.ssh_key.is_some() {
            return Err(AppError::Connect(t!("--ssh-user / --ssh-key 要搭配 --ssh-host").into()));
        }
        return Ok(());
    };
    cfg.ssh_enabled = true;
    cfg.ssh_host = host.to_string();
    cfg.ssh_port = a.ssh_port;
    cfg.ssh_username = a.ssh_user.clone().unwrap_or_default();
    if let Some(key) = a.ssh_key.as_deref().filter(|k| !k.is_empty()) {
        cfg.ssh_auth_method = SshAuthMethod::Key;
        cfg.ssh_private_key_path = key.to_string();
        cfg.ssh_passphrase = a.ssh_passphrase.clone().unwrap_or_default();
    } else {
        cfg.ssh_auth_method = SshAuthMethod::Password;
        cfg.ssh_password = a.ssh_password.clone().unwrap_or_default();
    }
    Ok(())
}

/// 覆寫時沒重新給的 secret 沿用舊連線的（同 GUI 編輯連線「密碼欄留空 = 不變」）。
fn inherit_secrets(cfg: &mut ConnectionConfig, prev: &ConnectionConfig) {
    if cfg.password.is_empty() {
        cfg.password = prev.password.clone();
    }
    if cfg.otp_secret.is_empty() {
        cfg.otp_secret = prev.otp_secret.clone();
    }
    if cfg.ssh_enabled {
        if cfg.ssh_password.is_empty() {
            cfg.ssh_password = prev.ssh_password.clone();
        }
        if cfg.ssh_passphrase.is_empty() {
            cfg.ssh_passphrase = prev.ssh_passphrase.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbKind;

    fn persisted(id: &str, name: &str) -> PersistedConnection {
        PersistedConnection {
            id: id.into(),
            name: name.into(),
            kind: DbKind::Mysql,
            host: "h".into(),
            port: 3306,
            username: "u".into(),
            database: None,
            max_connections: 5,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_username: String::new(),
            ssh_auth_method: Default::default(),
            ssh_private_key_path: String::new(),
            options: Default::default(),
            group_id: None,
        }
    }

    fn add_args(extra: &[&str]) -> ConnAddArgs {
        use clap::Parser;
        let mut argv = vec!["dbk", "conn", "add", "x"];
        argv.extend_from_slice(extra);
        match super::super::args::Cli::parse_from(argv).command {
            super::super::args::Command::Conn(super::super::args::ConnCmd::Add(a)) => a,
            other => panic!("unexpected {other:?}"),
        }
    }

    fn mysql_args() -> ConnArgs {
        use clap::Parser;
        super::super::args::Cli::parse_from(["dbk", "--kind", "mysql", "conn", "list"]).conn
    }

    #[test]
    fn unique_name_lookup() {
        let all = vec![persisted("1", "a"), persisted("2", "b"), persisted("3", "b")];
        assert_eq!(find_unique_by_name(&all, "a").unwrap().map(|c| c.id.as_str()), Some("1"));
        assert!(find_unique_by_name(&all, "zz").unwrap().is_none());
        assert!(find_unique_by_name(&all, "b").is_err(), "同名多筆要求改用 id");
    }

    #[test]
    fn options_from_flags() {
        let a = add_args(&["--prod", "--ssl-mode", "require", "--opt", "connect_timeout=5", "--opt", "x=a=b"]);
        let mut o = BTreeMap::new();
        apply_options(&mut o, &a).unwrap();
        assert_eq!(o.get("prod").map(String::as_str), Some("1"));
        assert_eq!(o.get("ssl_mode").map(String::as_str), Some("require"));
        assert_eq!(o.get("connect_timeout").map(String::as_str), Some("5"));
        assert_eq!(o.get("x").map(String::as_str), Some("a=b"), "只切第一個等號");
        let bad = add_args(&["--opt", "novalue"]);
        assert!(apply_options(&mut BTreeMap::new(), &bad).is_err());
    }

    #[test]
    fn ssh_flags() {
        let mut cfg = resolve::adhoc_for_save(&mysql_args()).unwrap();
        let a = add_args(&["--ssh-host", "bastion", "--ssh-user", "ops", "--ssh-key", "/k/id_ed25519"]);
        apply_ssh(&mut cfg, &a).unwrap();
        assert!(cfg.ssh_enabled);
        assert_eq!(cfg.ssh_port, 22);
        assert!(matches!(cfg.ssh_auth_method, SshAuthMethod::Key));
        assert_eq!(cfg.ssh_private_key_path, "/k/id_ed25519");

        let orphan = add_args(&["--ssh-user", "ops"]);
        assert!(apply_ssh(&mut cfg, &orphan).is_err(), "沒有 --ssh-host 的 SSH 參數要報錯");
    }

    #[test]
    fn replace_keeps_old_secrets_unless_given() {
        let mut prev = resolve::adhoc_for_save(&mysql_args()).unwrap();
        prev.password = "old".into();
        let mut cfg = prev.clone();
        cfg.password = String::new();
        inherit_secrets(&mut cfg, &prev);
        assert_eq!(cfg.password, "old");
        cfg.password = "new".into();
        inherit_secrets(&mut cfg, &prev);
        assert_eq!(cfg.password, "new");
    }
}
