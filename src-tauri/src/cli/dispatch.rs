//! 指令分派：解析連線 → 連線 → 呼叫 manager / store / export / backup → 渲染。
//! 全部唯讀 / 匯出；`query` / `explain` 另過唯讀守門。

use crate::db::{DataQuery, Filter, SearchOptions, Sort, SortDir};
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;
use crate::store::{self, PersistedConnection};

use super::args::{
    Cli, Command, ConnArgs, ConnCmd, DbCmd, ExportArgs, Format, RedisCmd, RoutineCmd, SearchArgs,
    TableCmd,
};
use super::{guard, render, resolve};

pub async fn dispatch(cli: Cli) -> AppResult<()> {
    let fmt = cli.conn.format;
    let conn = cli.conn.clone();
    match cli.command {
        // ---- 不需建立連線 ----
        Command::Conn(ConnCmd::List) => conn_list(fmt).await,
        Command::Conn(ConnCmd::Export { path, passphrase }) => conn_export(&path, &passphrase).await,
        Command::Conn(ConnCmd::Test) => {
            let cfg = resolve::resolve(&conn).await?;
            ConnectionManager::new().test(&cfg).await?;
            println!("連線成功");
            Ok(())
        }
        Command::Backup(b) => {
            // 備份直接以 config 打 backup::backup（讀 DB 產 dump 檔），不經 manager 連線。
            let cfg = resolve::resolve(&conn).await?;
            let res = crate::backup::backup(&cfg, &b.database, &b.to).await?;
            println!("已備份：{}（{} bytes，方式 {}）", res.path, res.bytes, res.method);
            Ok(())
        }
        // ---- 其餘需建立連線 ----
        other => run_connected(&conn, fmt, other).await,
    }
}

/// 建立連線 → 執行 → 收尾釋放（含 SSH 通道 / 連線池）。
async fn run_connected(conn: &ConnArgs, fmt: Format, command: Command) -> AppResult<()> {
    let cfg = resolve::resolve(conn).await?;
    let id = cfg.id.clone();
    let db = conn
        .database
        .clone()
        .or_else(|| cfg.database.clone())
        .unwrap_or_default();
    let mgr = ConnectionManager::new();
    mgr.connect(cfg).await?;
    let res = exec(&mgr, &id, &db, fmt, command).await;
    mgr.disconnect(&id).await;
    res
}

async fn exec(
    mgr: &ConnectionManager,
    id: &str,
    db: &str,
    fmt: Format,
    command: Command,
) -> AppResult<()> {
    match command {
        Command::Conn(ConnCmd::Ping) => {
            let start = std::time::Instant::now();
            mgr.ping(id).await?;
            println!("{} ms", start.elapsed().as_millis());
        }
        Command::Conn(_) => unreachable!("conn list/test/export 在連線前已處理"),

        Command::Db(DbCmd::List) => {
            let dbs = mgr.list_databases(id).await?;
            render::emit_list(fmt, "database", &dbs);
        }

        Command::Table(tc) => exec_table(mgr, id, db, fmt, tc).await?,

        Command::Query { sql, max_rows } => {
            guard::ensure_read_only(&sql)?;
            let cap = max_rows.unwrap_or_else(crate::db::limits::row_cap);
            let q = mgr.query_capped(id, &sql, cap).await?;
            if q.columns.is_empty() {
                println!("(無欄位；{} 列受影響)", q.rows_affected);
            } else {
                render::emit(fmt, &q.columns, &q.rows);
            }
            if q.truncated {
                eprintln!("(結果已截斷於 {cap} 列；用 --max-rows 0 取完整結果)");
            }
        }
        Command::Explain { sql } => {
            guard::ensure_read_only(&sql)?;
            let q = mgr.explain(id, &sql).await?;
            render::emit(fmt, &q.columns, &q.rows);
        }
        Command::ColumnStats { table, column } => {
            let s = mgr.column_stats(id, db, &table, &column).await?;
            render::emit_value(fmt, &s);
        }
        Command::Routine(rc) => match rc {
            RoutineCmd::List => {
                let v = mgr.list_routines(id, db).await?;
                render::emit_value(fmt, &v);
            }
            RoutineCmd::Def { name, routine_type } => {
                let d = mgr.routine_definition(id, db, &name, &routine_type).await?;
                print_text(&d);
            }
        },
        Command::Search(s) => {
            let opts = build_search(s);
            let hits = mgr.search_objects(id, &opts).await?;
            render::emit_value(fmt, &hits);
        }
        Command::SchemaDump => {
            let s = crate::export::schema_dump(mgr, id, db).await?;
            print!("{s}");
        }
        Command::Export(e) => exec_export(mgr, id, db, e).await?,
        Command::ErModel => {
            let m = mgr.er_model(id, db).await?;
            if let Format::Json = fmt {
                render::emit_value(fmt, &m);
            } else {
                println!("資料表：{}　關係：{}", m.tables.len(), m.relations.len());
                let cols = vec![
                    "from_table".to_string(),
                    "from_column".to_string(),
                    "to_table".to_string(),
                    "to_column".to_string(),
                ];
                let rows = m
                    .relations
                    .iter()
                    .map(|r| {
                        vec![
                            Some(r.from_table.clone()),
                            Some(r.from_column.clone()),
                            Some(r.to_table.clone()),
                            Some(r.to_column.clone()),
                        ]
                    })
                    .collect::<Vec<_>>();
                render::emit(fmt, &cols, &rows);
            }
        }
        Command::ServerInfo => {
            let sections = mgr.server_info(id).await?;
            if let Format::Json = fmt {
                render::emit_value(fmt, &sections);
            } else {
                for sec in &sections {
                    println!("[{}]", sec.name);
                    render::emit_pairs(fmt, &sec.items);
                    println!();
                }
            }
        }
        Command::Redis(rc) => exec_redis(mgr, id, db, fmt, rc).await?,

        // 連線前已處理。
        Command::Backup(_) => unreachable!("backup 在連線前已處理"),
    }
    Ok(())
}

async fn exec_table(
    mgr: &ConnectionManager,
    id: &str,
    db: &str,
    fmt: Format,
    tc: TableCmd,
) -> AppResult<()> {
    match tc {
        TableCmd::List => {
            let v = mgr.list_tables(id, db).await?;
            render::emit_value(fmt, &v);
        }
        TableCmd::Columns { table } => {
            let v = mgr.table_columns(id, db, &table).await?;
            render::emit_value(fmt, &v);
        }
        TableCmd::Data {
            table,
            page,
            page_size,
            filter,
            sort,
            match_any,
        } => {
            let query = DataQuery {
                page,
                page_size,
                filters: parse_filters(&filter)?,
                sorts: parse_sorts(&sort)?,
                match_any,
                count: true,
            };
            let pd = mgr.table_data(id, db, &table, &query).await?;
            render::emit(fmt, &pd.columns, &pd.rows);
            if let Format::Table = fmt {
                println!(
                    "(第 {} 頁，每頁 {}，共 {} 列)",
                    pd.page, pd.page_size, pd.total_rows
                );
            }
        }
        TableCmd::Info { table } => {
            let info = mgr.table_info(id, db, &table).await?;
            render::emit_pairs(fmt, &info);
        }
        TableCmd::Ddl { table } => {
            let ddl = mgr.table_ddl(id, db, &table).await?;
            print_text(&ddl);
        }
        TableCmd::Indexes { table } => {
            let v = mgr.table_indexes(id, db, &table).await?;
            render::emit_value(fmt, &v);
        }
        TableCmd::ForeignKeys { table } => {
            let v = mgr.list_foreign_keys(id, db, &table).await?;
            render::emit_value(fmt, &v);
        }
    }
    Ok(())
}

async fn exec_export(
    mgr: &ConnectionManager,
    id: &str,
    db: &str,
    e: ExportArgs,
) -> AppResult<()> {
    let query = DataQuery {
        page: 0,
        page_size: 0,
        filters: parse_filters(&e.filter)?,
        sorts: parse_sorts(&e.sort)?,
        match_any: e.match_any,
        count: true,
    };
    let opts = crate::export::ExportOptions {
        format: e.data_format.clone(),
        include_header: !e.no_header,
        delimiter: e.delimiter.clone(),
        null_text: e.null_text.clone(),
        sql_table: None,
        all_rows: true,
        bom: e.bom,
    };
    let res = crate::export::export(mgr, id, db, &e.table, &query, &opts, &e.to).await?;
    println!(
        "已匯出 {} 列到 {}（{} bytes，{} 格式）",
        res.rows, res.path, res.bytes, res.format
    );
    Ok(())
}

async fn exec_redis(
    mgr: &ConnectionManager,
    id: &str,
    db: &str,
    fmt: Format,
    rc: RedisCmd,
) -> AppResult<()> {
    match rc {
        RedisCmd::Keys { pattern, limit } => {
            let rk = mgr.scan_keys(id, db, &pattern, limit).await?;
            render::emit_list(fmt, "key", &rk.keys);
            if rk.truncated {
                eprintln!("(已達上限 {limit}，可能仍有更多鍵)");
            }
        }
        RedisCmd::Key { key } => match mgr.key_detail(id, db, &key).await? {
            Some(kd) => render::emit_value(fmt, &kd),
            None => println!("(鍵不存在)"),
        },
        RedisCmd::Slowlog { count } => {
            let v = mgr.redis_driver(id)?.slowlog(count).await?;
            render::emit_value(fmt, &v);
        }
        RedisCmd::Clients => {
            let v = mgr.redis_driver(id)?.clients().await?;
            render::emit_value(fmt, &v);
        }
        RedisCmd::BigKeys { sample, top } => {
            let v = mgr.redis_driver(id)?.big_keys(db, sample, top).await?;
            render::emit_value(fmt, &v);
        }
    }
    Ok(())
}

// ---- 不需連線：連線清單 / 加密匯出 ----

async fn conn_list(fmt: Format) -> AppResult<()> {
    let dir = store::headless_config_dir()?;
    let all = store::load_all_in(&dir).await?;
    let columns = vec![
        "name".to_string(),
        "kind".to_string(),
        "host".to_string(),
        "port".to_string(),
        "user".to_string(),
        "database".to_string(),
        "id".to_string(),
    ];
    let rows = all
        .iter()
        .map(|c| {
            vec![
                Some(c.name.clone()),
                Some(c.kind.as_str().to_string()),
                Some(c.host.clone()),
                Some(c.port.to_string()),
                Some(c.username.clone()),
                c.database.clone(),
                Some(c.id.clone()),
            ]
        })
        .collect::<Vec<_>>();
    render::emit(fmt, &columns, &rows);
    Ok(())
}

/// 與 GUI `export_connections_encrypted` 同檔格式（flatten base + 4 個 keychain 機密），可被 GUI 匯入。
#[derive(serde::Serialize)]
struct ExportedConn {
    #[serde(flatten)]
    base: PersistedConnection,
    password: String,
    ssh_password: String,
    ssh_passphrase: String,
    otp_secret: String,
}

async fn conn_export(path: &str, passphrase: &str) -> AppResult<()> {
    if passphrase.is_empty() {
        return Err(AppError::Storage("請提供 --passphrase".into()));
    }
    let dir = store::headless_config_dir()?;
    let conns = store::load_all_in(&dir).await?;
    let exported: Vec<ExportedConn> = conns
        .into_iter()
        .map(|c| {
            let id = c.id.clone();
            ExportedConn {
                password: store::kc_get(&id).unwrap_or_default(),
                ssh_password: store::kc_get(&store::ssh_account(&id)).unwrap_or_default(),
                ssh_passphrase: store::kc_get(&store::ssh_passphrase_account(&id))
                    .unwrap_or_default(),
                otp_secret: store::kc_get(&store::otp_account(&id)).unwrap_or_default(),
                base: c,
            }
        })
        .collect();
    let count = exported.len();
    let plain =
        serde_json::to_vec(&exported).map_err(|e| AppError::Storage(format!("序列化失敗：{e}")))?;
    let blob = crate::conn_crypto::encrypt(&plain, passphrase)?;
    tokio::fs::write(path, blob)
        .await
        .map_err(|e| AppError::Storage(format!("寫入失敗：{e}")))?;
    println!("已加密匯出 {count} 筆連線到 {path}");
    Ok(())
}

// ---- 小工具 ----

/// 文字結果（DDL / routine def）原樣輸出，確保結尾換行。
fn print_text(s: &str) {
    print!("{s}");
    if !s.ends_with('\n') {
        println!();
    }
}

fn build_search(s: SearchArgs) -> SearchOptions {
    // 三個比對範圍皆未指定時，預設比對名稱。
    let (match_names, match_definitions, match_comments) =
        if !s.names && !s.definitions && !s.comments {
            (true, false, false)
        } else {
            (s.names, s.definitions, s.comments)
        };
    SearchOptions {
        term: s.term,
        databases: if s.databases.is_empty() {
            None
        } else {
            Some(s.databases)
        },
        types: if s.types.is_empty() {
            None
        } else {
            Some(s.types)
        },
        match_names,
        match_definitions,
        match_comments,
        case_sensitive: s.case_sensitive,
        limit: s.limit,
        whole_word: s.whole_word,
        wildcards: s.wildcards,
    }
}

fn parse_filters(specs: &[String]) -> AppResult<Vec<Filter>> {
    specs.iter().map(|s| parse_filter(s)).collect()
}

fn parse_filter(spec: &str) -> AppResult<Filter> {
    // col:op[:value]
    let mut parts = spec.splitn(3, ':');
    let column = parts.next().unwrap_or("").trim().to_string();
    let op = parts.next().unwrap_or("").trim().to_string();
    let value = parts.next().map(|v| v.to_string());
    if column.is_empty() || op.is_empty() {
        return Err(AppError::Query(format!(
            "篩選格式錯誤（應為 col:op[:value]）：{spec}"
        )));
    }
    if crate::db::filter_op_sql(&op).is_none() {
        return Err(AppError::Query(format!("不支援的篩選運算子：{op}")));
    }
    let value = if crate::db::op_needs_value(&op) {
        value
    } else {
        None
    };
    Ok(Filter { column, op, value })
}

fn parse_sorts(specs: &[String]) -> AppResult<Vec<Sort>> {
    specs.iter().map(|s| parse_sort(s)).collect()
}

fn parse_sort(spec: &str) -> AppResult<Sort> {
    let mut parts = spec.splitn(2, ':');
    let column = parts.next().unwrap_or("").trim().to_string();
    let dir = parts.next().unwrap_or("asc").trim().to_ascii_lowercase();
    if column.is_empty() {
        return Err(AppError::Query(format!(
            "排序格式錯誤（應為 col:asc|desc）：{spec}"
        )));
    }
    let dir = match dir.as_str() {
        "asc" | "" => SortDir::Asc,
        "desc" => SortDir::Desc,
        other => return Err(AppError::Query(format!("排序方向需為 asc/desc：{other}"))),
    };
    Ok(Sort { column, dir })
}
