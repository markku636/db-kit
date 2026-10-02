//! 執行會話：每個情境、每個引擎一條**專屬連線**，逐批送 SQL、收回所有結果集與錯誤碼。
//!
//! 為什麼不走 `DatabaseDriver`：trait 每次呼叫都從池子拿連線（交易跨不過兩次呼叫），
//! 錯誤被壓成 `AppError::Query(String)` 拿不到錯誤號 / SQLSTATE，而「兩邊都出錯」要比的正是類別。
//! tiberius 在批次中途出錯會在該句結束串流——已收到的結果集要保留（部分副作用是真實行為），
//! 所以回傳的是 `BatchOutcome { sets, error }` 而不是 `Result`。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::db::DbKind;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ResultSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    #[serde(default)]
    pub truncated: bool,
}

impl ResultSet {
    pub fn first_cell(&self, col: usize) -> Option<&str> {
        self.rows.first().and_then(|r| r.get(col)).and_then(|c| c.as_deref())
    }
}

/// 引擎回的錯誤：MSSQL 有錯誤號、PG 有 SQLSTATE、MySQL 兩者都有。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DbErr {
    pub number: Option<i64>,
    pub sqlstate: Option<String>,
    pub message: String,
}

impl DbErr {
    pub fn other(message: impl Into<String>) -> DbErr {
        DbErr { number: None, sqlstate: None, message: message.into() }
    }
}

#[derive(Debug, Default)]
pub struct BatchOutcome {
    pub sets: Vec<ResultSet>,
    pub error: Option<DbErr>,
}

impl BatchOutcome {
    pub fn into_result(self) -> Result<Vec<ResultSet>, DbErr> {
        match self.error {
            Some(e) => Err(e),
            None => Ok(self.sets),
        }
    }
}

#[async_trait]
pub trait EngineSession: Send {
    fn kind(&self) -> DbKind;
    /// 送一批 SQL（MSSQL 可多句；PG / MySQL 建議一句），收回所有結果集。`cap` = 每集列數上限（0 = 不限）。
    async fn batch(&mut self, sql: &str, cap: usize) -> BatchOutcome;
}

/// 依連線種類開專屬連線。
pub async fn open(mgr: &ConnectionManager, id: &str) -> AppResult<Box<dyn EngineSession>> {
    match mgr.kind(id)? {
        DbKind::Mssql => Ok(Box::new(MssqlSession { client: mgr.mssql_driver(id)?.dedicated_client().await? })),
        DbKind::Postgres => Ok(Box::new(PgSession { conn: mgr.postgres_driver(id)?.dedicated_connection().await? })),
        kind @ (DbKind::Mysql | DbKind::Mariadb) => {
            Ok(Box::new(MysqlSession { kind, conn: mgr.mysql_driver(id)?.dedicated_connection().await? }))
        }
        other => Err(AppError::Unsupported(tf!("預存程序測試尚不支援 {kind}", kind = format!("{other:?}")))),
    }
}

// ---------------------------------------------------------------------------
// SQL Server（tiberius simple_query）
// ---------------------------------------------------------------------------

pub struct MssqlSession {
    client: bb8_tiberius::rt::Client,
}

fn mssql_err(e: tiberius::error::Error) -> DbErr {
    match e {
        tiberius::error::Error::Server(te) => DbErr { number: Some(te.code() as i64), sqlstate: None, message: te.message().to_string() },
        other => DbErr::other(other.to_string()),
    }
}

#[async_trait]
impl EngineSession for MssqlSession {
    fn kind(&self) -> DbKind {
        DbKind::Mssql
    }

    async fn batch(&mut self, sql: &str, cap: usize) -> BatchOutcome {
        use futures::TryStreamExt;
        let mut out = BatchOutcome::default();
        let mut stream = match self.client.simple_query(sql).await {
            Ok(s) => s,
            Err(e) => {
                out.error = Some(mssql_err(e));
                return out;
            }
        };
        loop {
            match stream.try_next().await {
                Ok(Some(tiberius::QueryItem::Metadata(meta))) => out.sets.push(ResultSet {
                    columns: meta.columns().iter().map(|c| c.name().to_string()).collect(),
                    rows: vec![],
                    truncated: false,
                }),
                Ok(Some(tiberius::QueryItem::Row(row))) => {
                    let idx = row.result_index() as usize;
                    while out.sets.len() <= idx {
                        out.sets.push(ResultSet {
                            columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                            rows: vec![],
                            truncated: false,
                        });
                    }
                    let set = &mut out.sets[idx];
                    if cap > 0 && set.rows.len() >= cap {
                        set.truncated = true;
                        continue;
                    }
                    let cells = (0..set.columns.len()).map(|i| crate::db::mssql::cell_to_string(&row, i)).collect();
                    set.rows.push(cells);
                }
                Ok(None) => break,
                // 伺服器錯誤：串流到此為止，已收到的結果集保留；殘留的 token 由下一次 simple_query 前的 flush 清掉。
                Err(e) => {
                    out.error = Some(mssql_err(e));
                    break;
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// PostgreSQL / MySQL（sqlx fetch_many：簡單協定、多句、多結果集）
// ---------------------------------------------------------------------------

fn sqlx_err(e: sqlx::Error) -> DbErr {
    match e {
        sqlx::Error::Database(db) => {
            let number = db
                .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                .map(|m| m.number() as i64);
            DbErr { number, sqlstate: db.code().map(|c| c.to_string()), message: db.message().to_string() }
        }
        other => DbErr::other(other.to_string()),
    }
}

pub struct PgSession {
    conn: sqlx::postgres::PgConnection,
}

#[async_trait]
impl EngineSession for PgSession {
    fn kind(&self) -> DbKind {
        DbKind::Postgres
    }

    async fn batch(&mut self, sql: &str, cap: usize) -> BatchOutcome {
        use futures::StreamExt;
        use sqlx::{Column, Executor, Row};
        let mut out = BatchOutcome::default();
        let mut cur: Option<ResultSet> = None;
        let mut stream = self.conn.fetch_many(sql);
        while let Some(item) = stream.next().await {
            match item {
                Ok(sqlx::Either::Left(_done)) => out.sets.push(cur.take().unwrap_or_default()),
                Ok(sqlx::Either::Right(row)) => {
                    let set = cur.get_or_insert_with(|| ResultSet {
                        columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                        rows: vec![],
                        truncated: false,
                    });
                    if cap > 0 && set.rows.len() >= cap {
                        set.truncated = true;
                        continue;
                    }
                    let cells = (0..set.columns.len()).map(|i| crate::db::postgres::cell_to_string(&row, i)).collect();
                    set.rows.push(cells);
                }
                Err(e) => {
                    if let Some(c) = cur.take() {
                        out.sets.push(c);
                    }
                    out.error = Some(sqlx_err(e));
                    break;
                }
            }
        }
        if let Some(c) = cur.take() {
            out.sets.push(c);
        }
        out
    }
}

pub struct MysqlSession {
    kind: DbKind,
    conn: sqlx::MySqlConnection,
}

#[async_trait]
impl EngineSession for MysqlSession {
    fn kind(&self) -> DbKind {
        self.kind
    }

    async fn batch(&mut self, sql: &str, cap: usize) -> BatchOutcome {
        use futures::StreamExt;
        use sqlx::{Column, Executor, Row};
        let mut out = BatchOutcome::default();
        let mut cur: Option<ResultSet> = None;
        let mut stream = self.conn.fetch_many(sql);
        while let Some(item) = stream.next().await {
            match item {
                Ok(sqlx::Either::Left(_done)) => out.sets.push(cur.take().unwrap_or_default()),
                Ok(sqlx::Either::Right(row)) => {
                    let set = cur.get_or_insert_with(|| ResultSet {
                        columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                        rows: vec![],
                        truncated: false,
                    });
                    if cap > 0 && set.rows.len() >= cap {
                        set.truncated = true;
                        continue;
                    }
                    let cells = (0..set.columns.len()).map(|i| crate::db::mysql::cell_to_string(&row, i)).collect();
                    set.rows.push(cells);
                }
                Err(e) => {
                    if let Some(c) = cur.take() {
                        out.sets.push(c);
                    }
                    out.error = Some(sqlx_err(e));
                    break;
                }
            }
        }
        if let Some(c) = cur.take() {
            out.sets.push(c);
        }
        // CALL 的每個結果集各收一個 OK，最後程序本身再收一個 OK：多出來的空集砍掉，結果集數量才對得上。
        if out.error.is_none() && sql.trim_start().get(..4).map(|s| s.eq_ignore_ascii_case("call")).unwrap_or(false) {
            if let Some(last) = out.sets.last() {
                if last.columns.is_empty() && last.rows.is_empty() {
                    out.sets.pop();
                }
            }
        }
        out
    }
}
