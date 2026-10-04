//! MCP 伺服器的連線登錄：單一連線（`--conn` / `--url` / 臨時旗標）或多連線（db-kit 全部已存連線）。
//!
//! - 連線一律延遲到第一次需要時才建立，建立後依連線 id 快取重用；連線失敗不快取（下次再試）。
//! - 「這次呼叫打哪條連線、是什麼種類、是不是正式環境」只讀設定就答得出來（`target`），
//!   唯讀守門與寫入政策都在撥連線**之前**判斷，模型不會把「不准」誤讀成「連不上」。
//! - 多連線模式只列 CLI 支援的種類；`--connections` 再收斂成白名單。列表永不含帳密。

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::db::DbKind;
use crate::dbtools::DbToolCtx;
use crate::manager::ConnectionManager;
use crate::store;

use super::super::args::ConnArgs;
use super::super::resolve;

pub enum Mode {
    Single(ConnArgs),
    /// 白名單（名稱或 id）；空 = 全部已存連線。
    Multi { only: Vec<String> },
}

impl Mode {
    /// 有指定連線（`--conn` / `--url` / `--kind`）就是單一連線，否則多連線。
    pub fn from_args(conn: &ConnArgs, only: &[String]) -> Mode {
        if conn.conn.is_some() || conn.url.is_some() || conn.kind.is_some() {
            Mode::Single(conn.clone())
        } else {
            Mode::Multi { only: only.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect() }
        }
    }
}

/// 一條可用連線的摘要（`list_connections` 的內容；不含帳密）。
#[derive(Clone, Debug)]
pub struct ConnInfo {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    /// 連線自帶的預設資料庫（PG 是「連到哪個庫」，不是工具的 database = schema）。
    pub database: Option<String>,
    pub prod: bool,
}

/// 這次工具呼叫的目標（不連線就能決定）。
#[derive(Clone, Debug)]
pub struct Target {
    /// 快取鍵：單一連線固定 ""，多連線為連線 id。
    pub key: String,
    pub name: String,
    pub kind: DbKind,
    pub prod: bool,
}

/// 工具參數省略 database 時用的命名空間。PostgreSQL 的工具 database 是 **schema**，
/// 連線自帶的 database 是「連到哪個庫」，不能拿來當 schema——只認 `-d` 旗標，沒給就留空（模型會先 list_databases）。
pub fn default_namespace(kind: DbKind, flag: Option<&str>, conn_db: Option<&str>) -> Option<String> {
    let flag = flag.map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    if matches!(kind, DbKind::Postgres) {
        flag
    } else {
        flag.or_else(|| conn_db.map(str::trim).filter(|s| !s.is_empty()).map(String::from))
    }
}

pub struct Registry {
    mode: Mode,
    pub mgr: Arc<ConnectionManager>,
    /// `--tools` 白名單，帶進每個 DbToolCtx（`dbtools::call` 內的第二道防線）。
    allow: Option<Vec<String>>,
    /// 連線 id（單一連線為 ""）→ 已連上的上下文。鎖跨越 connect：並發的 HTTP 請求不會重複撥同一條連線。
    ctxs: tokio::sync::Mutex<HashMap<String, DbToolCtx>>,
}

impl Registry {
    pub fn new(mode: Mode, allow: Option<Vec<String>>) -> Registry {
        Registry { mode, mgr: Arc::new(ConnectionManager::new()), allow, ctxs: tokio::sync::Mutex::new(HashMap::new()) }
    }

    pub fn is_multi(&self) -> bool {
        matches!(self.mode, Mode::Multi { .. })
    }

    /// 單一連線模式的 `-d` 旗標。
    pub fn namespace_flag(&self) -> Option<&str> {
        match &self.mode {
            Mode::Single(c) => c.database.as_deref(),
            Mode::Multi { .. } => None,
        }
    }

    /// 多連線模式可用的已存連線（只讀設定檔，不連線、不碰 keychain）。
    pub async fn saved(&self) -> Result<Vec<ConnInfo>, String> {
        let Mode::Multi { only } = &self.mode else {
            return Ok(Vec::new());
        };
        let dir = store::headless_config_dir().map_err(|e| e.message())?;
        let all = store::load_all_in(&dir).await.map_err(|e| e.message())?;
        Ok(all
            .into_iter()
            .filter(|c| resolve::ensure_cli_kind(c.kind).is_ok())
            .filter(|c| only.is_empty() || only.iter().any(|o| o == &c.name || o == &c.id))
            .map(|c| ConnInfo {
                prod: c.options.get("prod").map(|v| v == "1").unwrap_or(false),
                id: c.id,
                name: c.name,
                kind: c.kind,
                host: c.host,
                port: c.port,
                database: c.database,
            })
            .collect())
    }

    /// 多連線模式：依 `connection` 參數（名稱優先、再 id、最後不分大小寫的名稱）找連線。
    async fn find(&self, needle: &str) -> Result<ConnInfo, String> {
        let list = self.saved().await?;
        let found = list
            .iter()
            .find(|c| c.name == needle)
            .or_else(|| list.iter().find(|c| c.id == needle))
            .or_else(|| list.iter().find(|c| c.name.eq_ignore_ascii_case(needle)));
        match found {
            Some(c) => Ok(c.clone()),
            None => {
                let names: Vec<&str> = list.iter().map(|c| c.name.as_str()).collect();
                Err(tf!(
                    "找不到連線「{name}」。可用的連線：{list}（可先呼叫 list_connections）",
                    name = needle,
                    list = if names.is_empty() { "-".to_string() } else { names.join(", ") }
                ))
            }
        }
    }

    /// 這次呼叫打哪條連線（不連線）。
    pub async fn target(&self, args: &Value) -> Result<Target, String> {
        match &self.mode {
            Mode::Single(conn) => {
                let cfg = resolve::resolve(conn).await.map_err(|e| e.message())?;
                let prod = cfg.options.get("prod").map(|v| v == "1").unwrap_or(false);
                Ok(Target { key: String::new(), name: cfg.name, kind: cfg.kind, prod })
            }
            Mode::Multi { .. } => {
                let needle = args
                    .get("connection")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| t!("缺少 connection：請先呼叫 list_connections，再以 connection 參數指定連線名稱").to_string())?;
                let c = self.find(needle).await?;
                Ok(Target { key: c.id, name: c.name, kind: c.kind, prod: c.prod })
            }
        }
    }

    /// 取得（必要時建立）這次呼叫的連線上下文。
    pub async fn ctx(&self, args: &Value) -> Result<DbToolCtx, String> {
        let target = self.target(args).await?;
        let mut g = self.ctxs.lock().await;
        if let Some(c) = g.get(&target.key) {
            return Ok(c.clone());
        }
        let (cfg, flag) = match &self.mode {
            Mode::Single(conn) => (resolve::resolve(conn).await.map_err(|e| e.message())?, conn.database.clone()),
            Mode::Multi { .. } => (resolve::resolve_saved_by(&target.key, None).await.map_err(|e| e.message())?, None),
        };
        let id = cfg.id.clone();
        let ns = default_namespace(cfg.kind, flag.as_deref(), cfg.database.as_deref());
        self.mgr.connect(cfg).await.map_err(|e| e.message())?;
        let c = DbToolCtx::from_manager(self.mgr.clone(), &id, ns.as_deref())?.with_allow(self.allow.clone());
        g.insert(target.key, c.clone());
        Ok(c)
    }

    /// 收尾：釋放所有連線池（含 SSH 通道）。
    pub async fn shutdown(&self) {
        let all: Vec<DbToolCtx> = self.ctxs.lock().await.drain().map(|(_, c)| c).collect();
        for c in all {
            self.mgr.disconnect(&c.conn_id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_namespace_only_comes_from_the_flag() {
        assert_eq!(default_namespace(DbKind::Postgres, None, Some("shop")), None);
        assert_eq!(default_namespace(DbKind::Postgres, Some("public"), Some("shop")).as_deref(), Some("public"));
        assert_eq!(default_namespace(DbKind::Mysql, None, Some("shop")).as_deref(), Some("shop"));
        assert_eq!(default_namespace(DbKind::Mysql, Some(" "), Some("shop")).as_deref(), Some("shop"));
        assert_eq!(default_namespace(DbKind::Mssql, Some("b"), Some("a")).as_deref(), Some("b"));
    }
}
