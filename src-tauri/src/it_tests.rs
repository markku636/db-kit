//! 整合驗證測試（針對 Docker 真實資料庫）。
//!
//! - 純函式測試（scheduler / 持久化序列化）正常 `cargo test` 即跑。
//! - 需要 Docker 服務的測試標 `#[ignore]`，以 `cargo test -- --ignored` 執行。
//!   先起容器：MySQL:13306 / PostgreSQL:15432 / MongoDB:27018 / Redis:16379。
#![cfg(test)]

use std::time::Duration;

use crate::db::mongo::MongoDriver;
use crate::db::mysql::MysqlDriver;
use crate::db::postgres::PostgresDriver;
use crate::db::redis::RedisDriver;
use crate::db::sqlite::SqliteDriver;
use crate::db::{
    AlterOp, CellEdit, ConnectionConfig, DataQuery, DatabaseDriver, DbKind, Filter, KeyEdit,
    QueryResult, RowDelete, RowInsert, Sort, SortDir, SshAuthMethod,
};

fn cfg(kind: DbKind, host: &str, port: u16, user: &str, pass: &str, db: Option<&str>) -> ConnectionConfig {
    ConnectionConfig {
        id: "it".into(),
        name: "it".into(),
        kind,
        host: host.into(),
        port,
        username: user.into(),
        password: pass.into(),
        database: db.map(|s| s.to_string()),
        max_connections: 5,
        ssh_enabled: false,
        ssh_host: String::new(),
        ssh_port: 0,
        ssh_username: String::new(),
        ssh_auth_method: SshAuthMethod::Password,
        ssh_password: String::new(),
        ssh_private_key_path: String::new(),
        ssh_passphrase: String::new(),
    }
}

fn filt(col: &str, op: &str, val: Option<&str>) -> Filter {
    Filter { column: col.into(), op: op.into(), value: val.map(|s| s.to_string()) }
}
fn dq(filters: Vec<Filter>, sorts: Vec<Sort>) -> DataQuery {
    DataQuery { page: 0, page_size: 100, filters, sorts, match_any: false }
}
/// 同 dq 但 match_any=true（OR 模式），用於驗證 OR 篩選路徑。
fn dq_or(filters: Vec<Filter>, sorts: Vec<Sort>) -> DataQuery {
    DataQuery { page: 0, page_size: 100, filters, sorts, match_any: true }
}
fn ins(cols: &[&str], vals: &[&str]) -> RowInsert {
    RowInsert {
        columns: cols.iter().map(|s| s.to_string()).collect(),
        values: vals.iter().map(|s| Some(s.to_string())).collect(),
    }
}
fn sv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}
fn col_at(cols: &[String], name: &str) -> usize {
    cols.iter().position(|c| c == name).unwrap_or_else(|| panic!("找不到欄位 {name}"))
}
/// EXPLAIN 結果應有列、且至少一格有非空內容（查詢計畫文字）。
fn explain_nonempty(r: &QueryResult) -> bool {
    !r.rows.is_empty()
        && r.rows.iter().any(|row| row.iter().any(|c| c.as_deref().is_some_and(|s| !s.is_empty())))
}

/// 驗證 DDL 編輯（alter_table）：新增 → 改名 → 刪除欄位，逐步以 table_columns 確認。
/// 表須先存在；跨 SQL driver 共用（含 SQLite 較受限的 ALTER 支援）。
async fn assert_ddl_column_ops(d: &impl DatabaseDriver, db: &str, table: &str) {
    d.alter_table(db, table, &AlterOp::AddColumn {
        name: "note".into(),
        data_type: "TEXT".into(),
        nullable: true,
        default: None,
    })
    .await
    .unwrap();
    assert!(
        d.table_columns(db, table).await.unwrap().iter().any(|c| c.name == "note"),
        "新增欄位 note 應出現"
    );
    d.alter_table(db, table, &AlterOp::RenameColumn { old: "note".into(), new: "memo".into() })
        .await
        .unwrap();
    let cols = d.table_columns(db, table).await.unwrap();
    assert!(cols.iter().any(|c| c.name == "memo"), "改名後 memo 應存在");
    assert!(!cols.iter().any(|c| c.name == "note"), "改名後 note 應消失");
    d.alter_table(db, table, &AlterOp::DropColumn { name: "memo".into() }).await.unwrap();
    assert!(
        !d.table_columns(db, table).await.unwrap().iter().any(|c| c.name == "memo"),
        "刪除欄位 memo 應消失"
    );
}

// ============================ 純函式 ============================

#[test]
fn filter_op_sql_maps_operators() {
    use crate::db::{filter_op_sql, op_needs_value};
    // 所有 driver 篩選共用的運算子 → SQL 對應（單一真相來源；回歸會打掉所有篩選）。
    assert_eq!(filter_op_sql("="), Some("="));
    assert_eq!(filter_op_sql("!="), Some("<>"));
    assert_eq!(filter_op_sql(">"), Some(">"));
    assert_eq!(filter_op_sql(">="), Some(">="));
    assert_eq!(filter_op_sql("<"), Some("<"));
    assert_eq!(filter_op_sql("<="), Some("<="));
    assert_eq!(filter_op_sql("like"), Some("LIKE"));
    assert_eq!(filter_op_sql("is_null"), Some("IS NULL"));
    assert_eq!(filter_op_sql("is_not_null"), Some("IS NOT NULL"));
    assert_eq!(filter_op_sql("bogus"), None, "未知運算子應回 None（被拒）");
    // is_null / is_not_null 不需綁定值；其餘需要。
    assert!(!op_needs_value("is_null"));
    assert!(!op_needs_value("is_not_null"));
    assert!(op_needs_value("="));
    assert!(op_needs_value("like"));
}

#[test]
fn bytes_to_display_renders() {
    use crate::db::bytes_to_display;
    // 合法 UTF-8 → 原樣字串。
    assert_eq!(bytes_to_display(b"hello"), "hello");
    assert_eq!(bytes_to_display("台北".as_bytes()), "台北");
    // 非合法 UTF-8 → 0x 十六進位。
    assert_eq!(bytes_to_display(&[0xff, 0x00, 0x10]), "0xff0010");
    // 超過 64 bytes → 截斷的十六進位 + 總長度標註。
    let big = vec![0xffu8; 100];
    let out = bytes_to_display(&big);
    assert!(out.starts_with("0x") && out.contains("100 bytes"), "{out}");
    assert!(out.len() < 100 * 2, "應截斷，不應輸出全部 200 個 hex 字元");
}

#[test]
fn validate_column_spec_blocks_injection() {
    use crate::db::validate_column_spec;
    // 合法型別 / 預設值放行（含括號、逗號、ENUM 字串、關鍵字、跳脫單引號）。
    assert!(validate_column_spec("VARCHAR(50)", None).is_ok());
    assert!(validate_column_spec("DECIMAL(10,2)", Some("0")).is_ok());
    assert!(validate_column_spec("ENUM('a','b')", None).is_ok());
    assert!(validate_column_spec("TIMESTAMP", Some("CURRENT_TIMESTAMP")).is_ok());
    assert!(validate_column_spec("TEXT", Some("'O''Brien'")).is_ok());
    // 空型別拒絕。
    assert!(validate_column_spec("   ", None).is_err());
    // 注入向量：分號 / 行註解 / 區塊註解 / 換行 → 拒絕。
    assert!(validate_column_spec("INT; DROP TABLE t", None).is_err());
    assert!(validate_column_spec("INT", Some("0; DELETE FROM t")).is_err());
    assert!(validate_column_spec("INT -- x", None).is_err());
    assert!(validate_column_spec("INT", Some("0 /* x */")).is_err());
    assert!(validate_column_spec("INT\nDROP", None).is_err());
}

#[test]
fn collect_relations_builds_fk() {
    use crate::db::collect_relations;
    // 每列為 [from_table, from_col, to_table, to_col]；from/to 表為空者應略過。
    let rows: Vec<Vec<Option<String>>> = vec![
        vec![Some("orders".into()), Some("customer_id".into()), Some("customers".into()), Some("id".into())],
        vec![Some("".into()), None, Some("".into()), None],
    ];
    let (rels, fk_cols) = collect_relations(&rows, |r, i| r[i].clone());
    assert_eq!(rels.len(), 1, "空關係應被略過");
    assert_eq!(rels[0].from_table, "orders");
    assert_eq!(rels[0].from_column, "customer_id");
    assert_eq!(rels[0].to_table, "customers");
    assert_eq!(rels[0].to_column, "id");
    assert!(fk_cols.contains(&("orders".to_string(), "customer_id".to_string())));
}

#[test]
fn scheduler_next_run() {
    use crate::scheduler::{compute_next_run, Cadence};
    use chrono::{Duration as Cd, Local, TimeZone, Timelike};

    let now = Local.with_ymd_and_hms(2026, 6, 22, 10, 0, 0).unwrap();

    let n = compute_next_run(&Cadence::EveryMinutes { minutes: 30 }, now).unwrap();
    assert_eq!(n, now + Cd::minutes(30));

    let n = compute_next_run(&Cadence::EveryHours { hours: 2 }, now).unwrap();
    assert_eq!(n, now + Cd::hours(2));

    // 今天稍晚 → 當天
    let n = compute_next_run(&Cadence::DailyAt { hour: 15, minute: 30 }, now).unwrap();
    assert_eq!((n.hour(), n.minute()), (15, 30));
    assert_eq!(n.date_naive(), now.date_naive());

    // 今天較早 → 隔天
    let n = compute_next_run(&Cadence::DailyAt { hour: 9, minute: 0 }, now).unwrap();
    assert_eq!(n.date_naive(), now.date_naive() + Cd::days(1));
}

#[test]
fn persisted_connection_drops_secrets() {
    let mut c = cfg(DbKind::Mysql, "h", 3306, "u", "PW_dbsecret", Some("db"));
    c.ssh_enabled = true;
    c.ssh_host = "bastion".into();
    c.ssh_password = "PW_sshsecret".into();
    c.ssh_passphrase = "PW_phsecret".into();

    let p = crate::store::PersistedConnection::from(&c);
    let json = serde_json::to_string(&p).unwrap();
    // 磁碟格式不得含任何 secret
    assert!(!json.contains("PW_"), "persisted json 不應含 secret：{json}");
    assert!(json.contains("bastion"), "非 secret 的 ssh_host 應保留");

    let back = p.to_config();
    assert_eq!(back.password, "");
    assert_eq!(back.ssh_password, "");
    assert_eq!(back.ssh_passphrase, "");
    assert!(back.ssh_enabled);
    assert_eq!(back.ssh_host, "bastion");
}

// ============================ SQLite（本機檔案）============================

#[tokio::test]
async fn sqlite_crud_and_backup() {
    let dbfile = "atkit_it_test.db";
    let bakfile = "atkit_it_test.bak";
    let _ = std::fs::remove_file(dbfile);
    let _ = std::fs::remove_file(bakfile);
    let _ = std::fs::remove_file(format!("{dbfile}.bak"));
    let c = cfg(DbKind::Sqlite, "", 0, "", "", Some(dbfile));

    {
        let d = SqliteDriver::connect(&c).await.unwrap();
        d.query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();
        d.create_index("main", "t", "ix_name", &sv(&["name"]), true).await.unwrap();
        d.insert_row("main", "t", &ins(&["id", "name"], &["1", "a"])).await.unwrap();
        d.insert_row("main", "t", &ins(&["id", "name"], &["2", "b"])).await.unwrap();
        assert_eq!(d.table_data("main", "t", &dq(vec![], vec![])).await.unwrap().total_rows, 2);
        // DDL + 索引（驗證 SQLite table_ddl / table_indexes）
        let ddl = d.table_ddl("main", "t").await.unwrap();
        assert!(ddl.to_uppercase().contains("CREATE TABLE"), "SQLite 建表 SQL：{ddl}");
        let idx = d.table_indexes("main", "t").await.unwrap();
        assert!(idx.iter().any(|x| x.name == "ix_name" && x.unique && x.columns == sv(&["name"])), "SQLite 索引：{idx:?}");
        // 刪除索引（驗證 drop_index）
        d.drop_index("main", "t", "ix_name").await.unwrap();
        assert!(!d.table_indexes("main", "t").await.unwrap().iter().any(|x| x.name == "ix_name"), "ix_name 應已刪除");
        // EXPLAIN QUERY PLAN：SQLite 回傳非空計畫
        assert!(explain_nonempty(&d.explain("SELECT * FROM t").await.unwrap()), "SQLite EXPLAIN 應回傳非空計畫");
        // DDL 編輯（alter_table）：SQLite 對 ALTER 支援較受限，明確驗證新增 / 改名 / 刪除欄位皆可。
        d.query("DROP TABLE IF EXISTS ddl_t").await.unwrap();
        d.query("CREATE TABLE ddl_t (id INTEGER PRIMARY KEY)").await.unwrap();
        assert_ddl_column_ops(&d, "main", "ddl_t").await;
        d.query("DROP TABLE IF EXISTS ddl_t").await.unwrap();
        // 寫入帶 RETURNING（SQLite 3.35+）：query() 應回傳該列。用獨立表後清理。
        d.query("DROP TABLE IF EXISTS ret_t").await.unwrap();
        d.query("CREATE TABLE ret_t (id INTEGER PRIMARY KEY, a TEXT)").await.unwrap();
        let ret = d.query("INSERT INTO ret_t (id, a) VALUES (7, 'rx') RETURNING id, a").await.unwrap();
        assert_eq!(ret.rows.len(), 1, "SQLite INSERT ... RETURNING 應回傳 1 列");
        assert_eq!(ret.rows[0][col_at(&ret.columns, "id")].as_deref(), Some("7"));
        d.query("DROP TABLE IF EXISTS ret_t").await.unwrap();
        // 無主鍵的表（SQLite 以 pragma table_info 偵測；隱含 rowid 不算 PK）：primary_key 應為空、編輯應被拒。
        d.query("DROP TABLE IF EXISTS nopk").await.unwrap();
        d.query("CREATE TABLE nopk (a INTEGER, b TEXT)").await.unwrap();
        d.insert_row("main", "nopk", &ins(&["a", "b"], &["1", "x"])).await.unwrap();
        let pdnopk = d.table_data("main", "nopk", &dq(vec![], vec![])).await.unwrap();
        assert!(pdnopk.primary_key.is_empty(), "SQLite 無 PK 表的 primary_key 應為空：{:?}", pdnopk.primary_key);
        assert!(
            d.delete_row("main", "nopk", &RowDelete { pk_columns: vec![], pk_values: vec![] }).await.is_err(),
            "SQLite 無主鍵的 delete 應被拒"
        );
        d.query("DROP TABLE IF EXISTS nopk").await.unwrap();
        d.close().await;
    }

    // 備份（檔案複製）
    let res = crate::backup::backup(&c, "main", bakfile).await.unwrap();
    assert_eq!(res.method, "file-copy");
    assert!(res.bytes > 0);

    // 刪一列
    {
        let d = SqliteDriver::connect(&c).await.unwrap();
        d.delete_row("main", "t", &RowDelete { pk_columns: sv(&["id"]), pk_values: vec![Some("1".into())] })
            .await
            .unwrap();
        assert_eq!(d.table_data("main", "t", &dq(vec![], vec![])).await.unwrap().total_rows, 1);
        d.close().await;
    }

    // 還原 → 回到 2 列
    crate::backup::restore(&c, "main", bakfile).await.unwrap();
    {
        let d = SqliteDriver::connect(&c).await.unwrap();
        assert_eq!(d.table_data("main", "t", &dq(vec![], vec![])).await.unwrap().total_rows, 2);
        d.close().await;
    }

    // 還原安全（負向）：非 SQLite 檔應被拒絕，且現有資料庫不被覆蓋（validate_sqlite_file）。
    let garbage = format!("{bakfile}.garbage");
    tokio::fs::write(&garbage, b"this is not a sqlite database file").await.unwrap();
    assert!(
        crate::backup::restore(&c, "main", &garbage).await.is_err(),
        "還原非 SQLite 檔應失敗"
    );
    let _ = std::fs::remove_file(&garbage);
    {
        let d = SqliteDriver::connect(&c).await.unwrap();
        assert_eq!(
            d.table_data("main", "t", &dq(vec![], vec![])).await.unwrap().total_rows,
            2,
            "還原失敗後原資料庫應完好（未被非法檔覆蓋）"
        );
        d.close().await;
    }

    let _ = std::fs::remove_file(dbfile);
    let _ = std::fs::remove_file(bakfile);
    // restore 的安全備份（<dst>.bak）一併清理，避免遺留測試產物。
    let _ = std::fs::remove_file(format!("{dbfile}.bak"));
}

/// CSV 匯入端到端（透過 ConnectionManager + SQLite，免 Docker）：
/// 驗證引號含逗號的欄位、空欄位→NULL、整數欄位匯入、匯入列數統計。
#[tokio::test]
async fn import_csv_into_sqlite() {
    let dbfile = "atkit_import_test.db";
    let _ = std::fs::remove_file(dbfile);
    let c = cfg(DbKind::Sqlite, "", 0, "", "", Some(dbfile));
    let mgr = crate::manager::ConnectionManager::new();
    mgr.connect(c.clone()).await.unwrap();
    let id = c.id.as_str();
    mgr.query(id, "CREATE TABLE imp (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)")
        .await
        .unwrap();

    // 表頭 + 含引號逗號的欄位 + 空 qty（→ NULL）+ 整數欄位。
    let csv = "id,name,qty\n1,\"Smith, J\",5\n2,Bob,\n3,Carol,9";
    let opts = crate::import::ImportOptions {
        delimiter: None,
        has_header: true,
        empty_as_null: true,
        columns: None,
        stop_on_error: false,
    };
    let res = crate::import::import_csv(&mgr, id, "main", "imp", csv, &opts).await.unwrap();
    assert_eq!(res.imported, 3, "應匯入 3 列，錯誤：{:?}", res.errors);
    assert_eq!(res.failed, 0);

    let pd = mgr
        .table_data(
            id,
            "main",
            "imp",
            &dq(vec![], vec![Sort { column: "id".into(), dir: SortDir::Asc }]),
        )
        .await
        .unwrap();
    assert_eq!(pd.total_rows, 3);
    assert_eq!(
        pd.rows[0][col_at(&pd.columns, "name")].as_deref(),
        Some("Smith, J"),
        "引號內逗號應正確解析為單一欄位"
    );
    assert_eq!(pd.rows[1][col_at(&pd.columns, "qty")], None, "空欄位應為 NULL");
    assert_eq!(pd.rows[2][col_at(&pd.columns, "qty")].as_deref(), Some("9"), "整數欄位應匯入");

    mgr.disconnect(id).await;
    let _ = std::fs::remove_file(dbfile);
}

/// CSV 匯入錯誤處理：欄數不符回報失敗（含列號）、stop_on_error 遇錯即中止回 Err。
#[tokio::test]
async fn import_csv_reports_errors() {
    let dbfile = "atkit_import_err_test.db";
    let _ = std::fs::remove_file(dbfile);
    let c = cfg(DbKind::Sqlite, "", 0, "", "", Some(dbfile));
    let mgr = crate::manager::ConnectionManager::new();
    mgr.connect(c.clone()).await.unwrap();
    let id = c.id.as_str();
    mgr.query(id, "CREATE TABLE imp (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();

    // 檔案第 3 列欄數不符（3 欄 vs 表頭 2 欄）→ 該列失敗，其餘成功匯入。
    let csv = "id,name\n1,a\n2,b,extra\n3,c";
    let opts = crate::import::ImportOptions {
        delimiter: None,
        has_header: true,
        empty_as_null: true,
        columns: None,
        stop_on_error: false,
    };
    let res = crate::import::import_csv(&mgr, id, "main", "imp", csv, &opts).await.unwrap();
    assert_eq!(res.imported, 2, "應匯入 id 1、3 兩列");
    assert_eq!(res.failed, 1, "欄數不符的列應計為失敗");
    assert!(
        res.errors.iter().any(|e| e.contains("第 3 列") && e.contains("欄數")),
        "錯誤訊息應標明列號與原因：{:?}",
        res.errors
    );

    // 重複主鍵（id=1 已存在）+ stop_on_error → 應在該列中止並回 Err。
    let opts_stop = crate::import::ImportOptions {
        delimiter: None,
        has_header: true,
        empty_as_null: true,
        columns: None,
        stop_on_error: true,
    };
    assert!(
        crate::import::import_csv(&mgr, id, "main", "imp", "id,name\n1,dup", &opts_stop).await.is_err(),
        "重複主鍵 + stop_on_error 應回 Err"
    );

    mgr.disconnect(id).await;
    let _ = std::fs::remove_file(dbfile);
}

/// 結構轉儲（schema_dump）：應含資料庫中每個表的建表 SQL。
#[tokio::test]
async fn schema_dump_lists_all_tables() {
    let dbfile = "atkit_dump_test.db";
    let _ = std::fs::remove_file(dbfile);
    let c = cfg(DbKind::Sqlite, "", 0, "", "", Some(dbfile));
    let mgr = crate::manager::ConnectionManager::new();
    mgr.connect(c.clone()).await.unwrap();
    let id = c.id.as_str();
    mgr.query(id, "CREATE TABLE aa (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();
    mgr.query(id, "CREATE TABLE bb (id INTEGER PRIMARY KEY)").await.unwrap();

    let dump = crate::export::schema_dump(&mgr, id, "main").await.unwrap();
    let upper = dump.to_uppercase();
    assert!(upper.matches("CREATE TABLE").count() >= 2, "轉儲應含兩個建表語句：{dump}");
    assert!(dump.contains("aa") && dump.contains("bb"), "轉儲應含兩表名：{dump}");

    mgr.disconnect(id).await;
    let _ = std::fs::remove_file(dbfile);
}

/// 匯出管線端到端（export()：分頁取資料 → render → 寫檔）。先前僅 render() 被單元測試。
#[tokio::test]
async fn export_table_to_csv_file() {
    let dbfile = "atkit_export_test.db";
    let outfile = "atkit_export_out.csv";
    let _ = std::fs::remove_file(dbfile);
    let _ = std::fs::remove_file(outfile);
    let c = cfg(DbKind::Sqlite, "", 0, "", "", Some(dbfile));
    let mgr = crate::manager::ConnectionManager::new();
    mgr.connect(c.clone()).await.unwrap();
    let id = c.id.as_str();
    mgr.query(id, "CREATE TABLE ex (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();
    mgr.query(id, "INSERT INTO ex (id, name) VALUES (1, 'a'), (2, 'b,c')").await.unwrap();

    let q = DataQuery {
        page: 0,
        page_size: 100,
        filters: vec![],
        sorts: vec![Sort { column: "id".into(), dir: SortDir::Asc }],
        match_any: false,
    };
    let opts = crate::export::ExportOptions {
        format: "csv".into(),
        include_header: true,
        delimiter: None,
        null_text: None,
        sql_table: None,
        all_rows: true,
        bom: false,
    };
    let res = crate::export::export(&mgr, id, "main", "ex", &q, &opts, outfile).await.unwrap();
    assert_eq!(res.rows, 2, "應匯出 2 列");
    let content = std::fs::read_to_string(outfile).unwrap();
    assert!(content.contains("id,name"), "應含表頭：{content}");
    assert!(content.contains("\"b,c\""), "含逗號的值應被引號包裹：{content}");

    mgr.disconnect(id).await;
    let _ = std::fs::remove_file(dbfile);
    let _ = std::fs::remove_file(outfile);
}

/// 匯出 → 重新匯入往返：驗證 export 的引號跳脫與 import 的解析對稱（含逗號 / 引號 / 換行的值）。
#[tokio::test]
async fn export_import_round_trip() {
    let dbfile = "atkit_rt_test.db";
    let csvfile = "atkit_rt.csv";
    let _ = std::fs::remove_file(dbfile);
    let _ = std::fs::remove_file(csvfile);
    let c = cfg(DbKind::Sqlite, "", 0, "", "", Some(dbfile));
    let mgr = crate::manager::ConnectionManager::new();
    mgr.connect(c.clone()).await.unwrap();
    let id = c.id.as_str();
    mgr.query(id, "CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT)").await.unwrap();
    // 含逗號 / 內嵌引號 / 換行的值——最易在 export/import 之間錯位。
    mgr.query(id, "INSERT INTO src (id, v) VALUES (1, 'a,b'), (2, 'he said \"hi\"'), (3, 'line1\nline2')")
        .await
        .unwrap();

    let q = DataQuery {
        page: 0,
        page_size: 100,
        filters: vec![],
        sorts: vec![Sort { column: "id".into(), dir: SortDir::Asc }],
        match_any: false,
    };
    let eopts = crate::export::ExportOptions {
        format: "csv".into(),
        include_header: true,
        delimiter: None,
        null_text: None,
        sql_table: None,
        all_rows: true,
        bom: false,
    };
    crate::export::export(&mgr, id, "main", "src", &q, &eopts, csvfile).await.unwrap();

    mgr.query(id, "CREATE TABLE dst (id INTEGER PRIMARY KEY, v TEXT)").await.unwrap();
    let content = std::fs::read_to_string(csvfile).unwrap();
    let iopts = crate::import::ImportOptions {
        delimiter: None,
        has_header: true,
        empty_as_null: false, // 真往返：不把空字串轉 NULL
        columns: None,
        stop_on_error: true,
    };
    assert_eq!(
        crate::import::import_csv(&mgr, id, "main", "dst", &content, &iopts).await.unwrap().imported,
        3,
        "往返應匯入 3 列"
    );
    let pd = mgr.table_data(id, "main", "dst", &q).await.unwrap();
    let vi = col_at(&pd.columns, "v");
    assert_eq!(pd.rows[0][vi].as_deref(), Some("a,b"), "含逗號的值應往返一致");
    assert_eq!(pd.rows[1][vi].as_deref(), Some("he said \"hi\""), "含引號的值應往返一致");
    assert_eq!(pd.rows[2][vi].as_deref(), Some("line1\nline2"), "含換行的值應往返一致");

    mgr.disconnect(id).await;
    let _ = std::fs::remove_file(dbfile);
    let _ = std::fs::remove_file(csvfile);
}

/// 欄位資料剖析（column_stats）：總數 / 非空 / 相異（含 NULL 與重複值）。
#[tokio::test]
async fn column_stats_counts() {
    let dbfile = "atkit_stats_test.db";
    let _ = std::fs::remove_file(dbfile);
    let c = cfg(DbKind::Sqlite, "", 0, "", "", Some(dbfile));
    let mgr = crate::manager::ConnectionManager::new();
    mgr.connect(c.clone()).await.unwrap();
    let id = c.id.as_str();
    mgr.query(id, "CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT)").await.unwrap();
    // v：'a','b','a',NULL,NULL → 總 5、非空 3、相異 2（a,b）。
    mgr.query(id, "INSERT INTO s (id, v) VALUES (1,'a'),(2,'b'),(3,'a'),(4,NULL),(5,NULL)").await.unwrap();
    let st = mgr.column_stats(id, "main", "s", "v").await.unwrap();
    assert_eq!(st.total, 5, "總列數");
    assert_eq!(st.non_null, 3, "非空值數（排除 2 個 NULL）");
    assert_eq!(st.distinct, 2, "相異值數（a, b）");
    assert_eq!(st.min.as_deref(), Some("a"), "最小值");
    assert_eq!(st.max.as_deref(), Some("b"), "最大值");

    // SQLite 觸發器（exec_ddl 簡單協定處理內部 ;）+ list / definition。
    mgr.exec_ddl(id, "CREATE TRIGGER s_trg AFTER INSERT ON s BEGIN SELECT 1; END").await.unwrap();
    let rs = mgr.list_routines(id, "main").await.unwrap();
    assert!(
        rs.iter().any(|r| r.name == "s_trg" && r.routine_type == "trigger" && r.parent.as_deref() == Some("s")),
        "SQLite 觸發器應出現且帶所屬表，實得：{rs:?}"
    );
    let tdef = mgr.routine_definition(id, "main", "s_trg", "trigger").await.unwrap();
    assert!(tdef.contains("s_trg"), "觸發器定義應含名稱");
    mgr.exec_ddl(id, "DROP TRIGGER s_trg").await.unwrap();
    assert!(
        !mgr.list_routines(id, "main").await.unwrap().iter().any(|r| r.name == "s_trg"),
        "刪除後觸發器應消失"
    );

    mgr.disconnect(id).await;
    let _ = std::fs::remove_file(dbfile);
}

// ============================ MySQL（Docker）============================

async fn connect_retry_mysql() -> MysqlDriver {
    let c = cfg(DbKind::Mysql, "127.0.0.1", 13306, "root", "test1234", Some("testdb"));
    for i in 0..60 {
        match MysqlDriver::connect(&c).await {
            Ok(d) => return d,
            Err(e) => {
                if i == 59 {
                    panic!("MySQL 連線失敗：{e:?}");
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    unreachable!()
}

#[tokio::test]
#[ignore = "需要 Docker MySQL:13306"]
async fn mysql_full() {
    let d = connect_retry_mysql().await;
    d.ping().await.unwrap();
    d.query("DROP TABLE IF EXISTS t").await.unwrap();
    d.query("CREATE TABLE t (id VARCHAR(8) PRIMARY KEY, a VARCHAR(8), b VARCHAR(50))").await.unwrap();
    for (id, a, b) in [("1", "2", "xy"), ("2", "5", "xb"), ("3", "9", "xa"), ("4", "1", "qq")] {
        d.insert_row("testdb", "t", &ins(&["id", "a", "b"], &[id, a, b])).await.unwrap();
    }

    // 多欄複合篩選 AND：a >= "3" 且 b LIKE "x%" → 期望 id 2、3
    let pd = d
        .table_data(
            "testdb",
            "t",
            &dq(
                vec![filt("a", ">=", Some("3")), filt("b", "like", Some("x%"))],
                vec![Sort { column: "id".into(), dir: SortDir::Asc }],
            ),
        )
        .await
        .unwrap();
    assert_eq!(pd.total_rows, 2, "多欄 AND 篩選應命中 2 列");
    assert_eq!(pd.primary_key, sv(&["id"]));
    let i = col_at(&pd.columns, "id");
    let ids: Vec<&str> = pd.rows.iter().map(|r| r[i].as_deref().unwrap()).collect();
    assert_eq!(ids, vec!["2", "3"]);

    // OR 篩選（match_any=true）：a = '2' OR a = '9' → id 1、3（驗證 MySQL OR 串接）
    let por = d
        .table_data(
            "testdb",
            "t",
            &dq_or(
                vec![filt("a", "=", Some("2")), filt("a", "=", Some("9"))],
                vec![Sort { column: "id".into(), dir: SortDir::Asc }],
            ),
        )
        .await
        .unwrap();
    let oids: Vec<&str> = por.rows.iter().map(|r| r[col_at(&por.columns, "id")].as_deref().unwrap()).collect();
    assert_eq!(oids, vec!["1", "3"], "MySQL OR 篩選 (a=2 OR a=9) 應命中 id 1、3");

    // 篩選運算子 is_null / is_not_null / !=（含三值邏輯）— 獨立表，確認與 PG 行為一致。
    d.query("DROP TABLE IF EXISTS opf").await.unwrap();
    d.query("CREATE TABLE opf (id INT PRIMARY KEY, v VARCHAR(8))").await.unwrap();
    d.insert_row("testdb", "opf", &ins(&["id", "v"], &["1", "x"])).await.unwrap();
    d.insert_row("testdb", "opf", &ins(&["id", "v"], &["2", "y"])).await.unwrap();
    d.insert_row("testdb", "opf", &ins(&["id"], &["3"])).await.unwrap(); // v = NULL
    assert_eq!(
        d.table_data("testdb", "opf", &dq(vec![filt("v", "is_null", None)], vec![])).await.unwrap().rows.len(),
        1, "MySQL is_null 應命中 1 列"
    );
    assert_eq!(
        d.table_data("testdb", "opf", &dq(vec![filt("v", "is_not_null", None)], vec![])).await.unwrap().total_rows,
        2, "MySQL is_not_null 應命中 2 列"
    );
    let mne = d.table_data("testdb", "opf", &dq(vec![filt("v", "!=", Some("x"))], vec![])).await.unwrap();
    assert_eq!(mne.rows.len(), 1, "MySQL != 'x' 應命中 1 列（NULL 排除）");
    assert_eq!(mne.rows[0][col_at(&mne.columns, "id")].as_deref(), Some("2"));
    d.query("DROP TABLE IF EXISTS opf").await.unwrap();

    // update
    d.update_cell("testdb", "t", &CellEdit {
        column: "b".into(),
        new_value: Some("XX".into()),
        pk_columns: sv(&["id"]),
        pk_values: vec![Some("3".into())],
    }).await.unwrap();
    let pd2 = d.table_data("testdb", "t", &dq(vec![filt("id", "=", Some("3"))], vec![])).await.unwrap();
    assert_eq!(pd2.rows[0][col_at(&pd2.columns, "b")].as_deref(), Some("XX"));

    // delete
    d.delete_row("testdb", "t", &RowDelete { pk_columns: sv(&["id"]), pk_values: vec![Some("4".into())] })
        .await
        .unwrap();
    assert_eq!(d.table_data("testdb", "t", &dq(vec![], vec![])).await.unwrap().total_rows, 3);

    // 欄位資料剖析（column_stats，MySQL 真實庫）：a = 2,5,9（3 列、皆非空、皆相異）。
    let cs = d.column_stats("testdb", "t", "a").await.unwrap();
    assert_eq!((cs.total, cs.non_null, cs.distinct), (3, 3, 3), "MySQL column_stats 應為 (3,3,3)：{cs:?}");
    assert_eq!((cs.min.as_deref(), cs.max.as_deref()), (Some("2"), Some("9")), "MySQL 範圍應為 [2,9]：{cs:?}");

    // metadata
    let dbs = d.list_databases().await.unwrap();
    assert!(dbs.contains(&"testdb".to_string()), "list_databases 未含 testdb，實得：{dbs:?}");
    assert!(d.list_tables("testdb").await.unwrap().iter().any(|t| t.name == "t"));
    assert!(d.table_columns("testdb", "t").await.unwrap().iter().any(|c| c.name == "a"));
    // table_info：MySQL 應含「引擎」與「資料大小」等統計。
    let tinfo = d.table_info("testdb", "t").await.unwrap();
    assert!(tinfo.iter().any(|(k, _)| k == "引擎"), "MySQL table_info 應含引擎，實得：{tinfo:?}");
    // ModifyColumn：改欄位型別（INT → VARCHAR）。
    d.alter_table("testdb", "t", &AlterOp::AddColumn { name: "mc".into(), data_type: "INT".into(), nullable: true, default: None }).await.unwrap();
    d.alter_table("testdb", "t", &AlterOp::ModifyColumn { name: "mc".into(), data_type: "VARCHAR(20)".into(), nullable: true }).await.unwrap();
    assert!(
        d.table_columns("testdb", "t").await.unwrap().iter().any(|c| c.name == "mc" && c.data_type.to_lowercase().contains("varchar")),
        "MySQL 改型別後 mc 應為 varchar"
    );
    d.alter_table("testdb", "t", &AlterOp::DropColumn { name: "mc".into() }).await.unwrap();
    // SetDefault：設定 → 清除欄位預設值。
    d.alter_table("testdb", "t", &AlterOp::AddColumn { name: "dc".into(), data_type: "INT".into(), nullable: true, default: None }).await.unwrap();
    d.alter_table("testdb", "t", &AlterOp::SetDefault { name: "dc".into(), default: Some("5".into()) }).await.unwrap();
    assert!(
        d.table_columns("testdb", "t").await.unwrap().iter().any(|c| c.name == "dc" && c.default.as_deref().is_some_and(|v| v.contains('5'))),
        "MySQL 預設值應為 5"
    );
    d.alter_table("testdb", "t", &AlterOp::SetDefault { name: "dc".into(), default: None }).await.unwrap();
    d.alter_table("testdb", "t", &AlterOp::DropColumn { name: "dc".into() }).await.unwrap();
    // 外鍵 list / drop（建父子表 → ADD CONSTRAINT → list_foreign_keys → DROP）。
    d.query("DROP TABLE IF EXISTS fk_child").await.ok();
    d.query("DROP TABLE IF EXISTS fk_parent").await.ok();
    d.query("CREATE TABLE fk_parent (id INT PRIMARY KEY)").await.unwrap();
    d.query("CREATE TABLE fk_child (id INT, pid INT)").await.unwrap();
    d.exec_ddl("ALTER TABLE fk_child ADD CONSTRAINT fk_c FOREIGN KEY (pid) REFERENCES fk_parent(id)").await.unwrap();
    let fks = d.list_foreign_keys("testdb", "fk_child").await.unwrap();
    assert!(
        fks.iter().any(|f| f.name == "fk_c" && f.column == "pid" && f.ref_table == "fk_parent" && f.ref_column == "id"),
        "MySQL 外鍵應列出，實得：{fks:?}"
    );
    d.exec_ddl("ALTER TABLE fk_child DROP FOREIGN KEY fk_c").await.unwrap();
    assert!(d.list_foreign_keys("testdb", "fk_child").await.unwrap().is_empty(), "刪除後外鍵應消失");
    d.query("DROP TABLE fk_child").await.unwrap();
    d.query("DROP TABLE fk_parent").await.unwrap();

    // 新增 / 刪除資料庫（CREATE / DROP DATABASE）→ 出現後消失。
    d.query("DROP DATABASE IF EXISTS atkit_newdb").await.unwrap();
    d.create_database("atkit_newdb").await.unwrap();
    assert!(d.list_databases().await.unwrap().contains(&"atkit_newdb".to_string()), "新增資料庫應出現於清單");
    d.drop_database("atkit_newdb").await.unwrap();
    assert!(!d.list_databases().await.unwrap().contains(&"atkit_newdb".to_string()), "刪除後資料庫應消失");
    // 安全護欄：系統庫與使用中的預設庫（testdb）皆不可刪除。
    assert!(d.drop_database("mysql").await.is_err(), "系統庫 mysql 不可刪除");
    assert!(d.drop_database("information_schema").await.is_err(), "系統庫 information_schema 不可刪除");
    assert!(d.drop_database("testdb").await.is_err(), "使用中的預設庫不可刪除");

    // 預存程序（exec_ddl 走簡單查詢協定，驗證 prepared 不支援的 CREATE PROCEDURE 可建立）。
    d.exec_ddl("DROP PROCEDURE IF EXISTS atkit_p1").await.unwrap();
    d.exec_ddl("CREATE PROCEDURE atkit_p1() BEGIN SELECT 1; END").await.unwrap();
    let routines = d.list_routines("testdb").await.unwrap();
    assert!(
        routines.iter().any(|r| r.name == "atkit_p1" && r.routine_type == "procedure"),
        "新增的預存程序應出現，實得：{routines:?}"
    );
    let pdef = d.routine_definition("testdb", "atkit_p1", "procedure").await.unwrap();
    assert!(pdef.to_uppercase().contains("PROCEDURE"), "程序定義應含 PROCEDURE");
    d.exec_ddl("DROP PROCEDURE atkit_p1").await.unwrap();
    assert!(
        !d.list_routines("testdb").await.unwrap().iter().any(|r| r.name == "atkit_p1"),
        "刪除後程序應消失"
    );
    // 觸發器（附所屬資料表）。
    d.query("DROP TABLE IF EXISTS atkit_trg_t").await.unwrap();
    d.query("CREATE TABLE atkit_trg_t (id INT)").await.unwrap();
    d.exec_ddl("CREATE TRIGGER atkit_trg BEFORE INSERT ON atkit_trg_t FOR EACH ROW SET NEW.id = NEW.id + 1").await.unwrap();
    assert!(
        d.list_routines("testdb").await.unwrap().iter().any(|r| r.name == "atkit_trg" && r.parent.as_deref() == Some("atkit_trg_t")),
        "觸發器應出現且帶所屬表"
    );
    d.exec_ddl("DROP TRIGGER atkit_trg").await.unwrap();
    d.query("DROP TABLE atkit_trg_t").await.unwrap();
    // 事件（MySQL 事件排程器）：建立 / 列出 / 取定義 / 刪除。
    d.exec_ddl("DROP EVENT IF EXISTS atkit_evt").await.unwrap();
    d.exec_ddl("CREATE EVENT atkit_evt ON SCHEDULE EVERY 1 DAY DO SELECT 1").await.unwrap();
    assert!(
        d.list_routines("testdb").await.unwrap().iter().any(|r| r.name == "atkit_evt" && r.routine_type == "event"),
        "事件應出現於 list_routines"
    );
    let edef = d.routine_definition("testdb", "atkit_evt", "event").await.unwrap();
    assert!(edef.to_uppercase().contains("EVENT"), "事件定義應含 EVENT：{edef}");
    d.exec_ddl("DROP EVENT atkit_evt").await.unwrap();
    assert!(
        !d.list_routines("testdb").await.unwrap().iter().any(|r| r.name == "atkit_evt"),
        "刪除後事件應消失"
    );

    // 建表 DDL + 索引（驗證本次新增的 table_ddl / table_indexes）
    let ddl = d.table_ddl("testdb", "t").await.unwrap();
    assert!(ddl.to_uppercase().contains("CREATE TABLE"), "建表 SQL 應含 CREATE TABLE：{ddl}");
    let idx = d.table_indexes("testdb", "t").await.unwrap();
    assert!(idx.iter().any(|x| x.primary && x.columns == sv(&["id"])), "應有 id 主鍵索引：{idx:?}");

    // 建立 / 刪除索引（驗證 create_index / drop_index：MySQL）
    d.create_index("testdb", "t", "ix_a", &sv(&["a"]), false).await.unwrap();
    assert!(d.table_indexes("testdb", "t").await.unwrap().iter().any(|x| x.name == "ix_a"), "ix_a 應已建立");
    d.drop_index("testdb", "t", "ix_a").await.unwrap();
    assert!(!d.table_indexes("testdb", "t").await.unwrap().iter().any(|x| x.name == "ix_a"), "ix_a 應已刪除");

    // EXPLAIN 查詢計畫：MySQL 回傳非空計畫
    assert!(explain_nonempty(&d.explain("SELECT * FROM t").await.unwrap()), "MySQL EXPLAIN 應回傳非空計畫");

    // DDL 編輯（alter_table：新增 / 改名 / 刪除欄位）— 獨立表。
    d.query("DROP TABLE IF EXISTS ddl_t").await.unwrap();
    d.query("CREATE TABLE ddl_t (id INT PRIMARY KEY)").await.unwrap();
    assert_ddl_column_ops(&d, "testdb", "ddl_t").await;
    d.query("DROP TABLE IF EXISTS ddl_t").await.unwrap();

    // ER 圖外鍵探索（MySQL，InnoDB）：建父子表 + FK → 應探索出關係。
    d.query("DROP TABLE IF EXISTS er_child").await.unwrap();
    d.query("DROP TABLE IF EXISTS er_parent").await.unwrap();
    d.query("CREATE TABLE er_parent (id INT PRIMARY KEY)").await.unwrap();
    d.query("CREATE TABLE er_child (id INT PRIMARY KEY, pid INT, FOREIGN KEY (pid) REFERENCES er_parent(id))")
        .await
        .unwrap();
    let er = d.er_model("testdb").await.unwrap();
    assert!(
        er.relations.iter().any(|r| r.from_table == "er_child"
            && r.from_column == "pid"
            && r.to_table == "er_parent"
            && r.to_column == "id"),
        "MySQL ER 應探索出 er_child.pid → er_parent.id：{:?}",
        er.relations
    );
    d.query("DROP TABLE IF EXISTS er_child").await.unwrap();
    d.query("DROP TABLE IF EXISTS er_parent").await.unwrap();

    // 型別呈現回歸測試（headline：DATETIME / TIMESTAMP / JSON 不再 <unrenderable>）
    d.query("DROP TABLE IF EXISTS types_t").await.unwrap();
    d.query("CREATE TABLE types_t (id INT PRIMARY KEY, dt DATETIME NULL, ts TIMESTAMP NULL, j JSON NULL, amt DECIMAL(10,2) NULL)").await.unwrap();
    d.query("INSERT INTO types_t (id, dt, ts, j, amt) VALUES (1, '2026-06-23 12:34:56', '2026-06-23 12:34:56', '{\"k\": 1}', 123.45)").await.unwrap();
    let td = d.table_data("testdb", "types_t", &dq(vec![], vec![])).await.unwrap();
    let row0 = &td.rows[0];
    let dt = row0[col_at(&td.columns, "dt")].as_deref().unwrap();
    assert!(dt.contains("2026-06-23 12:34:56") && !dt.contains("unrenderable"), "DATETIME 應正確呈現：{dt}");
    let ts = row0[col_at(&td.columns, "ts")].as_deref().unwrap();
    assert!(ts.contains("2026-06-23") && !ts.contains("unrenderable"), "TIMESTAMP 應正確呈現：{ts}");
    let j = row0[col_at(&td.columns, "j")].as_deref().unwrap();
    assert!(j.contains("\"k\"") && !j.contains("unrenderable"), "JSON 應正確呈現：{j}");
    // DECIMAL（金額常見）回歸：bigdecimal 應正確呈現，非 <unrenderable>。
    let amt = row0[col_at(&td.columns, "amt")].as_deref().unwrap();
    assert!(amt.contains("123.45") && !amt.contains("unrenderable"), "MySQL DECIMAL 應正確呈現：{amt}");

    // 整數主鍵 + JSON 欄位 CRUD（MySQL 寬鬆型別會 coerce text→int；與 PG 修正後行為對齊，
    // 確保兩者對「整數主鍵」表都能 insert / update / delete）。
    d.insert_row("testdb", "types_t", &ins(&["id", "j"], &["2", "{\"v\": 2}"])).await.unwrap();
    d.update_cell("testdb", "types_t", &CellEdit {
        column: "j".into(),
        new_value: Some("{\"v\": 22}".into()),
        pk_columns: sv(&["id"]),
        pk_values: vec![Some("2".into())],
    }).await.unwrap();
    let r2 = d.table_data("testdb", "types_t", &dq(vec![filt("id", "=", Some("2"))], vec![])).await.unwrap();
    assert!(
        r2.rows[0][col_at(&r2.columns, "j")].as_deref().unwrap().contains("22"),
        "MySQL 整數主鍵 + JSON 更新應生效"
    );
    d.delete_row("testdb", "types_t", &RowDelete { pk_columns: sv(&["id"]), pk_values: vec![Some("2".into())] })
        .await
        .unwrap();
    assert_eq!(
        d.table_data("testdb", "types_t", &dq(vec![filt("id", "=", Some("2"))], vec![])).await.unwrap().rows.len(),
        0,
        "MySQL 整數主鍵刪除應移除該列"
    );
    d.query("DROP TABLE IF EXISTS types_t").await.unwrap();

    // 數值範圍篩選回歸（MySQL 寬鬆型別：col >= ? 會原生數值比較，非字典序）。
    // 與 PG 修正後行為對齊：ids={1,2,10,30}，id >= 3 → {10,30}。
    d.query("DROP TABLE IF EXISTS nr").await.unwrap();
    d.query("CREATE TABLE nr (id INT PRIMARY KEY)").await.unwrap();
    for v in ["1", "2", "10", "30"] {
        d.insert_row("testdb", "nr", &ins(&["id"], &[v])).await.unwrap();
    }
    let nr = d
        .table_data(
            "testdb",
            "nr",
            &dq(vec![filt("id", ">=", Some("3"))], vec![Sort { column: "id".into(), dir: SortDir::Asc }]),
        )
        .await
        .unwrap();
    let ni = col_at(&nr.columns, "id");
    let ng: Vec<&str> = nr.rows.iter().map(|r| r[ni].as_deref().unwrap()).collect();
    assert_eq!(ng, vec!["10", "30"], "MySQL int 欄位 >= 應原生數值比較（非字典序）");
    d.query("DROP TABLE IF EXISTS nr").await.unwrap();

    // 無主鍵的表（MySQL 的 PK 偵測 SQL 與 PG 不同）：primary_key 應為空、編輯應被拒。
    d.query("DROP TABLE IF EXISTS nopk").await.unwrap();
    d.query("CREATE TABLE nopk (a INT, b VARCHAR(8))").await.unwrap();
    d.insert_row("testdb", "nopk", &ins(&["a", "b"], &["1", "x"])).await.unwrap();
    let pdnopk = d.table_data("testdb", "nopk", &dq(vec![], vec![])).await.unwrap();
    assert!(pdnopk.primary_key.is_empty(), "MySQL 無 PK 表的 primary_key 應為空：{:?}", pdnopk.primary_key);
    assert!(
        d.update_cell("testdb", "nopk", &CellEdit {
            column: "b".into(),
            new_value: Some("y".into()),
            pk_columns: vec![],
            pk_values: vec![],
        }).await.is_err(),
        "MySQL 無主鍵的 update 應被拒"
    );
    d.query("DROP TABLE IF EXISTS nopk").await.unwrap();

    d.close().await;
}

// ============================ PostgreSQL（Docker）============================

async fn connect_retry_pg() -> PostgresDriver {
    let c = cfg(DbKind::Postgres, "127.0.0.1", 15432, "postgres", "test1234", Some("testdb"));
    for i in 0..60 {
        match PostgresDriver::connect(&c).await {
            Ok(d) => return d,
            Err(e) => {
                if i == 59 {
                    panic!("PostgreSQL 連線失敗：{e:?}");
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    unreachable!()
}

#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn postgres_full() {
    let d = connect_retry_pg().await;
    d.ping().await.unwrap();
    d.query("DROP TABLE IF EXISTS t").await.unwrap();
    d.query("CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b TEXT)").await.unwrap();
    for (id, a, b) in [("1", "2", "xy"), ("2", "5", "xb"), ("3", "9", "xa"), ("4", "1", "qq")] {
        d.insert_row("public", "t", &ins(&["id", "a", "b"], &[id, a, b])).await.unwrap();
    }

    // 多欄複合篩選 AND（$N 佔位符）：a >= "3" 且 b LIKE "x%" → id 2、3
    let pd = d
        .table_data(
            "public",
            "t",
            &dq(
                vec![filt("a", ">=", Some("3")), filt("b", "like", Some("x%"))],
                vec![Sort { column: "id".into(), dir: SortDir::Asc }],
            ),
        )
        .await
        .unwrap();
    assert_eq!(pd.total_rows, 2, "PG 多欄 AND 篩選應命中 2 列");
    assert_eq!(pd.primary_key, sv(&["id"]));
    let i = col_at(&pd.columns, "id");
    let ids: Vec<&str> = pd.rows.iter().map(|r| r[i].as_deref().unwrap()).collect();
    assert_eq!(ids, vec!["2", "3"]);

    // OR 篩選（match_any=true）：a = '2' OR a = '9' → id 1、3（驗證 build_where 的 OR 串接）
    let por = d
        .table_data(
            "public",
            "t",
            &dq_or(
                vec![filt("a", "=", Some("2")), filt("a", "=", Some("9"))],
                vec![Sort { column: "id".into(), dir: SortDir::Asc }],
            ),
        )
        .await
        .unwrap();
    let oids: Vec<&str> = por.rows.iter().map(|r| r[col_at(&por.columns, "id")].as_deref().unwrap()).collect();
    assert_eq!(oids, vec!["1", "3"], "PG OR 篩選 (a=2 OR a=9) 應命中 id 1、3");

    // 篩選運算子 is_null / is_not_null / !=（含 SQL 三值邏輯：!= 排除 NULL）— 獨立表。
    d.query("DROP TABLE IF EXISTS opf").await.unwrap();
    d.query("CREATE TABLE opf (id INT PRIMARY KEY, v TEXT)").await.unwrap();
    d.insert_row("public", "opf", &ins(&["id", "v"], &["1", "x"])).await.unwrap();
    d.insert_row("public", "opf", &ins(&["id", "v"], &["2", "y"])).await.unwrap();
    d.insert_row("public", "opf", &ins(&["id"], &["3"])).await.unwrap(); // v = NULL
    let isnull = d.table_data("public", "opf", &dq(vec![filt("v", "is_null", None)], vec![])).await.unwrap();
    assert_eq!(isnull.rows.len(), 1, "is_null 應命中 1 列");
    assert_eq!(isnull.rows[0][col_at(&isnull.columns, "id")].as_deref(), Some("3"));
    let notnull = d.table_data("public", "opf", &dq(vec![filt("v", "is_not_null", None)], vec![])).await.unwrap();
    assert_eq!(notnull.total_rows, 2, "is_not_null 應命中 2 列");
    let ne = d.table_data("public", "opf", &dq(vec![filt("v", "!=", Some("x"))], vec![])).await.unwrap();
    assert_eq!(ne.rows.len(), 1, "!= 'x' 應命中 1 列（NULL 依三值邏輯被排除）");
    assert_eq!(ne.rows[0][col_at(&ne.columns, "id")].as_deref(), Some("2"));
    d.query("DROP TABLE IF EXISTS opf").await.unwrap();

    d.update_cell("public", "t", &CellEdit {
        column: "b".into(),
        new_value: Some("XX".into()),
        pk_columns: sv(&["id"]),
        pk_values: vec![Some("3".into())],
    }).await.unwrap();
    let pd2 = d.table_data("public", "t", &dq(vec![filt("id", "=", Some("3"))], vec![])).await.unwrap();
    assert_eq!(pd2.rows[0][col_at(&pd2.columns, "b")].as_deref(), Some("XX"));

    d.delete_row("public", "t", &RowDelete { pk_columns: sv(&["id"]), pk_values: vec![Some("4".into())] })
        .await
        .unwrap();
    assert_eq!(d.table_data("public", "t", &dq(vec![], vec![])).await.unwrap().total_rows, 3);

    assert!(d.list_databases().await.unwrap().contains(&"public".to_string()));
    assert!(d.list_tables("public").await.unwrap().iter().any(|t| t.name == "t"));
    // table_info：PG 應含「總大小」統計。
    let tinfo = d.table_info("public", "t").await.unwrap();
    assert!(tinfo.iter().any(|(k, _)| k == "總大小"), "PG table_info 應含總大小，實得：{tinfo:?}");
    // ModifyColumn：改欄位型別（INT → text，含 USING 轉型）。
    d.alter_table("public", "t", &AlterOp::AddColumn { name: "mc".into(), data_type: "INT".into(), nullable: true, default: None }).await.unwrap();
    d.alter_table("public", "t", &AlterOp::ModifyColumn { name: "mc".into(), data_type: "text".into(), nullable: true }).await.unwrap();
    assert!(
        d.table_columns("public", "t").await.unwrap().iter().any(|c| c.name == "mc" && c.data_type.to_lowercase().contains("text")),
        "PG 改型別後 mc 應為 text"
    );
    d.alter_table("public", "t", &AlterOp::DropColumn { name: "mc".into() }).await.unwrap();
    // SetDefault：設定 → 清除欄位預設值。
    d.alter_table("public", "t", &AlterOp::AddColumn { name: "dc".into(), data_type: "INT".into(), nullable: true, default: None }).await.unwrap();
    d.alter_table("public", "t", &AlterOp::SetDefault { name: "dc".into(), default: Some("5".into()) }).await.unwrap();
    assert!(
        d.table_columns("public", "t").await.unwrap().iter().any(|c| c.name == "dc" && c.default.as_deref().is_some_and(|v| v.contains('5'))),
        "PG 預設值應為 5"
    );
    d.alter_table("public", "t", &AlterOp::SetDefault { name: "dc".into(), default: None }).await.unwrap();
    d.alter_table("public", "t", &AlterOp::DropColumn { name: "dc".into() }).await.unwrap();
    // 外鍵 list / drop（PG）。
    d.query("DROP TABLE IF EXISTS fk_child").await.ok();
    d.query("DROP TABLE IF EXISTS fk_parent").await.ok();
    d.query("CREATE TABLE fk_parent (id INT PRIMARY KEY)").await.unwrap();
    d.query("CREATE TABLE fk_child (id INT, pid INT)").await.unwrap();
    d.exec_ddl("ALTER TABLE fk_child ADD CONSTRAINT fk_c FOREIGN KEY (pid) REFERENCES fk_parent(id)").await.unwrap();
    let fks = d.list_foreign_keys("public", "fk_child").await.unwrap();
    assert!(
        fks.iter().any(|f| f.name == "fk_c" && f.column == "pid" && f.ref_table == "fk_parent" && f.ref_column == "id"),
        "PG 外鍵應列出，實得：{fks:?}"
    );
    d.exec_ddl("ALTER TABLE fk_child DROP CONSTRAINT fk_c").await.unwrap();
    assert!(d.list_foreign_keys("public", "fk_child").await.unwrap().is_empty(), "刪除後外鍵應消失");
    d.query("DROP TABLE fk_child").await.unwrap();
    d.query("DROP TABLE fk_parent").await.unwrap();

    // 新增 / 刪除資料庫（PG → CREATE / DROP SCHEMA CASCADE）→ 出現後消失。
    d.query("DROP SCHEMA IF EXISTS atkit_newschema CASCADE").await.unwrap();
    d.create_database("atkit_newschema").await.unwrap();
    assert!(d.list_databases().await.unwrap().contains(&"atkit_newschema".to_string()), "新增 schema 應出現");
    d.drop_database("atkit_newschema").await.unwrap();
    assert!(!d.list_databases().await.unwrap().contains(&"atkit_newschema".to_string()), "刪除後 schema 應消失");
    // 安全護欄：系統 schema（pg_*、information_schema）不可刪除。
    assert!(d.drop_database("pg_catalog").await.is_err(), "系統 schema pg_catalog 不可刪除");
    assert!(d.drop_database("information_schema").await.is_err(), "系統 schema information_schema 不可刪除");

    // 函式（exec_ddl 簡單協定處理 $$ dollar-quoting）+ list / definition + 重載簽章。
    d.exec_ddl("DROP FUNCTION IF EXISTS atkit_fn(int)").await.unwrap();
    d.exec_ddl("DROP FUNCTION IF EXISTS atkit_fn(text)").await.unwrap();
    d.exec_ddl("CREATE OR REPLACE FUNCTION atkit_fn(p int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN p + 1; END; $$").await.unwrap();
    // 重載：同名不同簽章。
    d.exec_ddl("CREATE OR REPLACE FUNCTION atkit_fn(p text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN p; END; $$").await.unwrap();
    let rl = d.list_routines("public").await.unwrap();
    let fns: Vec<_> = rl.iter().filter(|r| r.name == "atkit_fn" && r.routine_type == "function").collect();
    assert_eq!(fns.len(), 2, "兩個重載皆應列出，實得：{fns:?}");
    // pg_get_function_identity_arguments 含參數名（如 "p integer"），即 DROP / ALTER 可直接採用的形式。
    assert!(fns.iter().any(|r| r.signature.as_deref() == Some("p integer")), "應有 p integer 簽章，實得：{fns:?}");
    assert!(fns.iter().any(|r| r.signature.as_deref() == Some("p text")), "應有 p text 簽章");
    let fdef = d.routine_definition("public", "atkit_fn", "function").await.unwrap();
    assert!(fdef.contains("atkit_fn"), "PG 函式定義應含函式名");
    // 以 buildDropRoutine 產出的簽章形式刪除指定重載（無簽章的 DROP 對重載會報 not unique）。
    d.exec_ddl("DROP FUNCTION IF EXISTS atkit_fn(p integer)").await.unwrap();
    d.exec_ddl("DROP FUNCTION IF EXISTS atkit_fn(p text)").await.unwrap();
    assert!(
        !d.list_routines("public").await.unwrap().iter().any(|r| r.name == "atkit_fn"),
        "刪除後 PG 函式應消失"
    );

    // 建表 DDL（欄位重建）+ 索引（pg_index）
    let ddl = d.table_ddl("public", "t").await.unwrap();
    assert!(ddl.to_uppercase().contains("CREATE TABLE"), "PG 建表 SQL 應含 CREATE TABLE：{ddl}");
    let idx = d.table_indexes("public", "t").await.unwrap();
    assert!(idx.iter().any(|x| x.primary && x.columns == sv(&["id"])), "PG 應有 id 主鍵索引：{idx:?}");

    // 建立 / 刪除索引（驗證 create_index / drop_index：PG）
    d.create_index("public", "t", "ix_a", &sv(&["a"]), false).await.unwrap();
    assert!(d.table_indexes("public", "t").await.unwrap().iter().any(|x| x.name == "ix_a"), "PG ix_a 應已建立");
    d.drop_index("public", "t", "ix_a").await.unwrap();
    assert!(!d.table_indexes("public", "t").await.unwrap().iter().any(|x| x.name == "ix_a"), "PG ix_a 應已刪除");

    // EXPLAIN 查詢計畫（商用工具常見功能）：應回傳非空計畫
    assert!(explain_nonempty(&d.explain("SELECT * FROM t").await.unwrap()), "PG EXPLAIN 應回傳非空計畫");

    // 寫入語句帶 RETURNING：query() 應回傳該列（而非僅影響筆數）。用獨立表後清理。
    d.query("DROP TABLE IF EXISTS ret_t").await.unwrap();
    d.query("CREATE TABLE ret_t (id INT PRIMARY KEY, a TEXT)").await.unwrap();
    let ret = d.query("INSERT INTO ret_t (id, a) VALUES (7, 'rx') RETURNING id, a").await.unwrap();
    assert_eq!(ret.rows.len(), 1, "PG INSERT ... RETURNING 應回傳 1 列");
    assert_eq!(ret.rows[0][col_at(&ret.columns, "id")].as_deref(), Some("7"));
    assert_eq!(ret.rows[0][col_at(&ret.columns, "a")].as_deref(), Some("rx"));
    d.query("DROP TABLE IF EXISTS ret_t").await.unwrap();

    // DDL 編輯（alter_table：新增 / 改名 / 刪除欄位）— 獨立表，避免干擾其他斷言。
    d.query("DROP TABLE IF EXISTS ddl_t").await.unwrap();
    d.query("CREATE TABLE ddl_t (id INT PRIMARY KEY)").await.unwrap();
    assert_ddl_column_ops(&d, "public", "ddl_t").await;
    d.query("DROP TABLE IF EXISTS ddl_t").await.unwrap();

    // ER 圖外鍵探索（er_model）：建父子表 + FK → 應探索出關係，且子表 FK 欄標記 fk。
    d.query("DROP TABLE IF EXISTS er_child").await.unwrap();
    d.query("DROP TABLE IF EXISTS er_parent").await.unwrap();
    d.query("CREATE TABLE er_parent (id INT PRIMARY KEY)").await.unwrap();
    d.query("CREATE TABLE er_child (id INT PRIMARY KEY, pid INT REFERENCES er_parent(id))").await.unwrap();
    let er = d.er_model("public").await.unwrap();
    assert!(
        er.relations.iter().any(|r| r.from_table == "er_child"
            && r.from_column == "pid"
            && r.to_table == "er_parent"
            && r.to_column == "id"),
        "ER 應探索出 er_child.pid → er_parent.id：{:?}",
        er.relations
    );
    let child = er.tables.iter().find(|t| t.name == "er_child").expect("er_child 應在 ER 模型");
    assert!(child.columns.iter().any(|c| c.name == "pid" && c.fk), "er_child.pid 應標記為 fk");
    d.query("DROP TABLE IF EXISTS er_child").await.unwrap();
    d.query("DROP TABLE IF EXISTS er_parent").await.unwrap();

    // 型別呈現回歸測試（headline：TIMESTAMPTZ / JSONB 不再 <unrenderable>）
    d.query("DROP TABLE IF EXISTS types_t").await.unwrap();
    // 涵蓋更多常見型別的 <unrenderable> 回歸：BOOLEAN / UUID / NUMERIC（cell_to_string 皆應處理）。
    d.query("CREATE TABLE types_t (id INT PRIMARY KEY, ts TIMESTAMPTZ, j JSONB, b BOOLEAN, u UUID, n NUMERIC)")
        .await
        .unwrap();
    d.query(
        "INSERT INTO types_t (id, ts, j, b, u, n) VALUES (1, '2026-06-23 12:34:56+00', '{\"k\": 1}', true, '00000000-0000-0000-0000-000000000001', 123.45)",
    )
    .await
    .unwrap();
    let td = d.table_data("public", "types_t", &dq(vec![], vec![])).await.unwrap();
    let row0 = &td.rows[0];
    let ts = row0[col_at(&td.columns, "ts")].as_deref().unwrap();
    assert!(ts.contains("2026-06-23") && !ts.contains("unrenderable"), "PG TIMESTAMPTZ 應正確呈現：{ts}");
    let j = row0[col_at(&td.columns, "j")].as_deref().unwrap();
    assert!(j.contains("\"k\"") && !j.contains("unrenderable"), "PG JSONB 應正確呈現：{j}");
    assert_eq!(row0[col_at(&td.columns, "b")].as_deref(), Some("true"), "PG BOOLEAN 應呈現 true");
    let u = row0[col_at(&td.columns, "u")].as_deref().unwrap();
    assert!(u.contains("00000000-0000-0000-0000-000000000001") && !u.contains("unrenderable"), "PG UUID 應正確呈現：{u}");
    let n = row0[col_at(&td.columns, "n")].as_deref().unwrap();
    assert!(n.contains("123.45") && !n.contains("unrenderable"), "PG NUMERIC 應正確呈現：{n}");
    // 非文字欄位篩選（驗證 build_where 的等值比較：int 欄位 = '1'）
    let intf = d.table_data("public", "types_t", &dq(vec![filt("id", "=", Some("1"))], vec![])).await.unwrap();
    assert_eq!(intf.rows.len(), 1, "PG int 欄位篩選 id=1 應命中 1 列");

    // 數值欄位「排序運算子」原生比較回歸：避免 col::text 造成字典序（'10' < '2'）。
    // ids={1,2,10,30}，id >= 3 → 原生數值應得 {10,30}；若退化成字典序會誤成 {30}。
    for extra in ["2", "10", "30"] {
        d.insert_row("public", "types_t", &ins(&["id"], &[extra])).await.unwrap();
    }
    let ge = d
        .table_data(
            "public",
            "types_t",
            &dq(
                vec![filt("id", ">=", Some("3"))],
                vec![Sort { column: "id".into(), dir: SortDir::Asc }],
            ),
        )
        .await
        .unwrap();
    let gi = col_at(&ge.columns, "id");
    let got: Vec<&str> = ge.rows.iter().map(|r| r[gi].as_deref().unwrap()).collect();
    assert_eq!(got, vec!["10", "30"], "PG int 欄位 >= 應走原生數值比較（非字典序）");

    // 寫入路徑對「整數主鍵 + JSONB 欄位」回歸：修正前 text 綁定使非文字欄位
    // 無法 insert（上面 ins 已驗證）/ update / delete（integer/jsonb = text 報錯）。
    // update：整數主鍵定位（id::text = '10'）+ 更新 JSONB 欄位（$1::jsonb）。
    d.update_cell("public", "types_t", &CellEdit {
        column: "j".into(),
        new_value: Some("{\"updated\": true}".into()),
        pk_columns: sv(&["id"]),
        pk_values: vec![Some("10".into())],
    }).await.unwrap();
    let upd = d.table_data("public", "types_t", &dq(vec![filt("id", "=", Some("10"))], vec![])).await.unwrap();
    let jv = upd.rows[0][col_at(&upd.columns, "j")].as_deref().unwrap();
    assert!(jv.contains("updated"), "PG 整數主鍵 + JSONB 更新應生效：{jv}");

    // delete：整數主鍵定位刪除 id=30。
    d.delete_row("public", "types_t", &RowDelete { pk_columns: sv(&["id"]), pk_values: vec![Some("30".into())] })
        .await
        .unwrap();
    let after = d.table_data("public", "types_t", &dq(vec![filt("id", "=", Some("30"))], vec![])).await.unwrap();
    assert_eq!(after.rows.len(), 0, "PG 整數主鍵刪除應移除該列");
    d.query("DROP TABLE IF EXISTS types_t").await.unwrap();

    // 複合主鍵 CRUD（接合表常見場景；驗證多欄 WHERE 的 ::text 轉型與 $n 編號正確），
    // 兼測「把整數欄位更新為 NULL」（SET n = $1::int4，值為 NULL → NULL::int4）。
    d.query("DROP TABLE IF EXISTS ck").await.unwrap();
    d.query("CREATE TABLE ck (a INT, b TEXT, n INT, note TEXT, PRIMARY KEY (a, b))").await.unwrap();
    d.insert_row("public", "ck", &ins(&["a", "b", "n", "note"], &["1", "x", "5", "n1"])).await.unwrap();
    d.insert_row("public", "ck", &ins(&["a", "b", "n", "note"], &["2", "y", "9", "n2"])).await.unwrap();
    let pk = d.table_data("public", "ck", &dq(vec![], vec![])).await.unwrap().primary_key;
    assert_eq!(pk, sv(&["a", "b"]), "PG 複合主鍵偵測應為 (a,b)：{pk:?}");
    d.update_cell("public", "ck", &CellEdit {
        column: "note".into(),
        new_value: Some("updated".into()),
        pk_columns: sv(&["a", "b"]),
        pk_values: vec![Some("1".into()), Some("x".into())],
    }).await.unwrap();
    d.update_cell("public", "ck", &CellEdit {
        column: "n".into(),
        new_value: None,
        pk_columns: sv(&["a", "b"]),
        pk_values: vec![Some("1".into()), Some("x".into())],
    }).await.unwrap();
    let ck1 = d.table_data("public", "ck", &dq(vec![filt("a", "=", Some("1"))], vec![])).await.unwrap();
    assert_eq!(ck1.rows[0][col_at(&ck1.columns, "note")].as_deref(), Some("updated"), "PG 複合主鍵更新 note");
    assert_eq!(ck1.rows[0][col_at(&ck1.columns, "n")], None, "PG 整數欄位應可更新為 NULL");
    d.delete_row("public", "ck", &RowDelete {
        pk_columns: sv(&["a", "b"]),
        pk_values: vec![Some("2".into()), Some("y".into())],
    }).await.unwrap();
    assert_eq!(
        d.table_data("public", "ck", &dq(vec![], vec![])).await.unwrap().total_rows,
        1,
        "PG 複合主鍵刪除應只移除 (2,y)"
    );

    // 注入安全回歸：含 SQL 中繼字元的值應被「字面儲存」（參數化綁定，udt 轉型不破壞參數化）。
    let payload = "'); DROP TABLE ck; --";
    d.insert_row("public", "ck", &ins(&["a", "b", "n", "note"], &["3", "z", "0", payload])).await.unwrap();
    let inj = d.table_data("public", "ck", &dq(vec![filt("a", "=", Some("3"))], vec![])).await.unwrap();
    assert_eq!(
        inj.rows[0][col_at(&inj.columns, "note")].as_deref(),
        Some(payload),
        "含 SQL 中繼字元的值應字面儲存（未被當語句執行）"
    );
    // ck 表仍在、且現有 2 列（(1,x) 與 (3,…)）→ 證明 DROP 未被執行。
    assert_eq!(
        d.table_data("public", "ck", &dq(vec![], vec![])).await.unwrap().total_rows,
        2,
        "注入字串不應觸發 DROP（表與資料仍在）"
    );
    d.query("DROP TABLE IF EXISTS ck").await.unwrap();

    // 無主鍵的表：primary_key 應為空，且 update_cell / delete_row 應被拒（無法安全定位列）。
    d.query("DROP TABLE IF EXISTS nopk").await.unwrap();
    d.query("CREATE TABLE nopk (a INT, b TEXT)").await.unwrap();
    d.insert_row("public", "nopk", &ins(&["a", "b"], &["1", "x"])).await.unwrap();
    let pdnopk = d.table_data("public", "nopk", &dq(vec![], vec![])).await.unwrap();
    assert!(pdnopk.primary_key.is_empty(), "無 PK 表的 primary_key 應為空：{:?}", pdnopk.primary_key);
    assert!(
        d.update_cell("public", "nopk", &CellEdit {
            column: "b".into(),
            new_value: Some("y".into()),
            pk_columns: vec![],
            pk_values: vec![],
        }).await.is_err(),
        "無主鍵的 update 應被拒"
    );
    assert!(
        d.delete_row("public", "nopk", &RowDelete { pk_columns: vec![], pk_values: vec![] }).await.is_err(),
        "無主鍵的 delete 應被拒"
    );
    d.query("DROP TABLE IF EXISTS nopk").await.unwrap();

    d.close().await;
}

// ============================ Redis（Docker）— 重點：結構編輯 ============================

#[tokio::test]
#[ignore = "需要 Docker Redis:16379"]
async fn redis_full() {
    let c = cfg(DbKind::Redis, "127.0.0.1", 16379, "", "", None);
    let d = RedisDriver::connect(&c).await.unwrap();
    d.ping().await.unwrap();
    d.query("0:FLUSHDB").await.unwrap();

    // string：insert_row(SET) → key_detail → update_cell（值 / TTL）
    d.insert_row("0", "keys", &ins(&["key", "value"], &["s1", "hello"])).await.unwrap();
    let det = d.key_detail("0", "s1").await.unwrap().unwrap();
    assert_eq!(det.type_, "string");
    assert_eq!(det.entries.first().map(String::as_str), Some("hello"));
    d.update_cell("0", "keys", &CellEdit {
        column: "value".into(),
        new_value: Some("world".into()),
        pk_columns: sv(&["key"]),
        pk_values: vec![Some("s1".into())],
    }).await.unwrap();
    assert_eq!(d.key_detail("0", "s1").await.unwrap().unwrap().entries[0], "world");
    d.update_cell("0", "keys", &CellEdit {
        column: "ttl".into(),
        new_value: Some("100".into()),
        pk_columns: sv(&["key"]),
        pk_values: vec![Some("s1".into())],
    }).await.unwrap();
    let ttl = d.key_detail("0", "s1").await.unwrap().unwrap().ttl;
    assert!(ttl > 0 && ttl <= 100, "TTL 應被設定，實得 {ttl}");

    // hash
    d.key_edit("0", "h1", &KeyEdit::HashSet { field: "f1".into(), value: "v1".into() }).await.unwrap();
    d.key_edit("0", "h1", &KeyEdit::HashSet { field: "f2".into(), value: "v2".into() }).await.unwrap();
    assert_eq!(d.key_detail("0", "h1").await.unwrap().unwrap().fields.len(), 2);
    d.key_edit("0", "h1", &KeyEdit::HashRemove { field: "f1".into() }).await.unwrap();
    let h = d.key_detail("0", "h1").await.unwrap().unwrap();
    assert_eq!(h.fields, sv(&["f2"]));
    assert_eq!(h.entries, sv(&["v2"]));

    // list（LPUSH/RPUSH/LSET/LREM）
    d.key_edit("0", "l1", &KeyEdit::ListPush { value: "a".into(), front: false }).await.unwrap(); // [a]
    d.key_edit("0", "l1", &KeyEdit::ListPush { value: "b".into(), front: false }).await.unwrap(); // [a,b]
    d.key_edit("0", "l1", &KeyEdit::ListPush { value: "z".into(), front: true }).await.unwrap();   // [z,a,b]
    d.key_edit("0", "l1", &KeyEdit::ListSet { index: 1, value: "A".into() }).await.unwrap();        // [z,A,b]
    assert_eq!(d.key_detail("0", "l1").await.unwrap().unwrap().entries, sv(&["z", "A", "b"]));
    d.key_edit("0", "l1", &KeyEdit::ListRemove { value: "A".into(), count: 1 }).await.unwrap();      // [z,b]
    assert_eq!(d.key_detail("0", "l1").await.unwrap().unwrap().entries, sv(&["z", "b"]));

    // set（SADD/SREM）
    d.key_edit("0", "set1", &KeyEdit::SetAdd { member: "m1".into() }).await.unwrap();
    d.key_edit("0", "set1", &KeyEdit::SetAdd { member: "m2".into() }).await.unwrap();
    let mut members = d.key_detail("0", "set1").await.unwrap().unwrap().entries;
    members.sort();
    assert_eq!(members, sv(&["m1", "m2"]));
    d.key_edit("0", "set1", &KeyEdit::SetRemove { member: "m1".into() }).await.unwrap();
    assert_eq!(d.key_detail("0", "set1").await.unwrap().unwrap().entries, sv(&["m2"]));

    // zset（ZADD/ZREM，含分數）
    d.key_edit("0", "zs1", &KeyEdit::ZsetAdd { member: "z1".into(), score: 1.5 }).await.unwrap();
    d.key_edit("0", "zs1", &KeyEdit::ZsetAdd { member: "z2".into(), score: 2.5 }).await.unwrap();
    let z = d.key_detail("0", "zs1").await.unwrap().unwrap();
    assert_eq!(z.type_, "zset");
    assert_eq!(z.entries, sv(&["z1", "z2"])); // 依分數升冪
    assert_eq!(z.scores, vec![1.5, 2.5]);
    d.key_edit("0", "zs1", &KeyEdit::ZsetRemove { member: "z1".into() }).await.unwrap();
    assert_eq!(d.key_detail("0", "zs1").await.unwrap().unwrap().entries, sv(&["z2"]));

    // 移除最後一個元素 → key 消失（TYPE = none）
    d.key_edit("0", "zs1", &KeyEdit::ZsetRemove { member: "z2".into() }).await.unwrap();
    assert_eq!(d.key_detail("0", "zs1").await.unwrap().unwrap().type_, "none");

    // 改名（RENAMENX）：s1 → s1b 成功；再改成已存在的 h1 應被拒（不覆蓋，兩鍵皆保留）。
    d.key_edit("0", "s1", &KeyEdit::Rename { new_key: "s1b".into() }).await.unwrap();
    assert_eq!(d.key_detail("0", "s1").await.unwrap().unwrap().type_, "none", "原鍵 s1 改名後應消失");
    assert_eq!(d.key_detail("0", "s1b").await.unwrap().unwrap().type_, "string", "新鍵 s1b 應存在");
    assert!(
        d.key_edit("0", "s1b", &KeyEdit::Rename { new_key: "h1".into() }).await.is_err(),
        "改名到既有鍵 h1 應被 RENAMENX 拒絕"
    );
    assert_eq!(d.key_detail("0", "s1b").await.unwrap().unwrap().type_, "string", "被拒後 s1b 仍在");
    assert_eq!(d.key_detail("0", "h1").await.unwrap().unwrap().type_, "hash", "被拒後 h1 型別不變");

    // 刪除 key（DEL via delete_row）：刪 s1b → 消失，回報刪 1 個。
    let n = d
        .delete_row("0", "keys", &RowDelete { pk_columns: sv(&["key"]), pk_values: vec![Some("s1b".into())] })
        .await
        .unwrap();
    assert_eq!(n, 1, "DEL 應回報刪除 1 個鍵");
    assert_eq!(d.key_detail("0", "s1b").await.unwrap().unwrap().type_, "none", "刪除後 s1b 應消失");

    d.close().await;
}

// ============================ MongoDB（Docker）============================

async fn connect_retry_mongo() -> MongoDriver {
    let c = cfg(DbKind::Mongo, "127.0.0.1", 27018, "", "", Some("testdb"));
    for i in 0..60 {
        match MongoDriver::connect(&c).await {
            Ok(d) => return d,
            Err(e) => {
                if i == 59 {
                    panic!("MongoDB 連線失敗：{e:?}");
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    unreachable!()
}

#[tokio::test]
#[ignore = "需要 Docker MongoDB:27018"]
async fn mongo_full() {
    let d = connect_retry_mongo().await;
    d.ping().await.unwrap();
    // 每次跑用獨立 collection，避免殘留資料干擾。
    let coll = format!("people_{}", std::process::id());

    for (name, age, city) in [("alice", "30", "x"), ("bob", "25", "y"), ("carol", "40", "x")] {
        d.insert_row("testdb", &coll, &ins(&["name", "age", "city"], &[name, age, city])).await.unwrap();
    }

    // table_info（collStats）：應含文件數，且為 3。
    let cinfo = d.table_info("testdb", &coll).await.unwrap();
    assert!(
        cinfo.iter().any(|(k, v)| k == "文件數" && v == "3"),
        "Mongo table_info 應含文件數=3，實得：{cinfo:?}"
    );

    // 多欄複合篩選 AND：age >= 30 且 city = "x" → alice、carol
    let pd = d
        .table_data(
            "testdb",
            &coll,
            &dq(vec![filt("age", ">=", Some("30")), filt("city", "=", Some("x"))], vec![]),
        )
        .await
        .unwrap();
    assert_eq!(pd.rows.len(), 2, "Mongo 多欄 AND 篩選應命中 2 筆");
    assert_eq!(pd.primary_key, sv(&["_id"]));

    // OR 篩選（match_any=true）：city = 'y' OR age >= 40 → bob、carol（驗證 Mongo $or）
    let mor = d
        .table_data(
            "testdb",
            &coll,
            &dq_or(vec![filt("city", "=", Some("y")), filt("age", ">=", Some("40"))], vec![]),
        )
        .await
        .unwrap();
    assert_eq!(mor.rows.len(), 2, "Mongo OR 篩選 (city=y OR age>=40) 應命中 2 筆");

    // 多欄排序（驗證 serde_json preserve_order：JSON 物件鍵序不被字母重排）。
    // sort {city:1, age:1}（city 主、age 次）：x(alice 30, carol 40)、y(bob 25) → [alice, carol, bob]。
    // 若鍵被重排成 {age, city}（字母序），會變成依 age → [bob, alice, carol]（錯）。
    let q_multi = format!(
        "{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"filter\":{{}},\"sort\":{{\"city\":1,\"age\":1}}}}"
    );
    let qm = d.query(&q_multi).await.unwrap();
    let names: Vec<String> = qm
        .rows
        .iter()
        .map(|r| {
            let v: serde_json::Value = serde_json::from_str(r[0].as_deref().unwrap()).unwrap();
            v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string()
        })
        .collect();
    assert_eq!(names, vec!["alice", "carol", "bob"], "多欄 sort 應依 city 主、age 次（鍵序保留）：{names:?}");

    // 取一筆 _id 做 update / delete
    let idi = col_at(&pd.columns, "_id");
    let namei = col_at(&pd.columns, "name");
    let alice = pd.rows.iter().find(|r| r[namei].as_deref() == Some("alice")).unwrap();
    let alice_id = alice[idi].clone().unwrap();

    d.update_cell("testdb", &coll, &CellEdit {
        column: "city".into(),
        new_value: Some("z".into()),
        pk_columns: sv(&["_id"]),
        pk_values: vec![Some(alice_id.clone())],
    }).await.unwrap();
    let pd2 = d.table_data("testdb", &coll, &dq(vec![filt("city", "=", Some("z"))], vec![])).await.unwrap();
    assert_eq!(pd2.rows.len(), 1);

    d.delete_row("testdb", &coll, &RowDelete { pk_columns: sv(&["_id"]), pk_values: vec![Some(alice_id)] })
        .await
        .unwrap();
    let pd3 = d.table_data("testdb", &coll, &dq(vec![], vec![])).await.unwrap();
    assert_eq!(pd3.rows.len(), 2);

    // like 篩選（驗證 like_to_regex 的萬用字元轉換 + 錨定）：剩 bob、carol。
    // name LIKE 'car%' → 只 carol（開頭符合）。
    let likef = d.table_data("testdb", &coll, &dq(vec![filt("name", "like", Some("car%"))], vec![])).await.unwrap();
    assert_eq!(likef.rows.len(), 1, "Mongo name LIKE 'car%' 應只命中 carol");
    assert_eq!(likef.rows[0][col_at(&likef.columns, "name")].as_deref(), Some("carol"));
    // name LIKE 'car'（無萬用字元）→ 整字串比對，不應因「子字串包含」而命中 carol。
    let exact = d.table_data("testdb", &coll, &dq(vec![filt("name", "like", Some("car"))], vec![])).await.unwrap();
    assert_eq!(exact.rows.len(), 0, "Mongo LIKE 'car' 應整字串比對（錨定），不命中 carol");

    // 索引（驗證 Mongo list_indexes：至少有預設 _id_ 索引）
    let idx = d.table_indexes("testdb", &coll).await.unwrap();
    assert!(idx.iter().any(|x| x.name == "_id_" || x.primary), "Mongo 應有 _id 索引：{idx:?}");

    // 建立 / 刪除索引（驗證 Mongo create_index / drop_index：與關聯式 driver 對齊）
    d.create_index("testdb", &coll, "ix_city", &sv(&["city"]), false).await.unwrap();
    assert!(
        d.table_indexes("testdb", &coll).await.unwrap().iter().any(|x| x.name == "ix_city"),
        "Mongo ix_city 應已建立"
    );
    d.drop_index("testdb", &coll, "ix_city").await.unwrap();
    assert!(
        !d.table_indexes("testdb", &coll).await.unwrap().iter().any(|x| x.name == "ix_city"),
        "Mongo ix_city 應已刪除"
    );

    // 新增集合（create_collection）→ 出現於集合清單（唯一命名避免重跑衝突）。
    let nc = format!("nc_{}", std::process::id());
    d.create_collection("testdb", &nc).await.unwrap();
    assert!(
        d.list_tables("testdb").await.unwrap().iter().any(|t| t.name == nc),
        "新增的集合 {nc} 應出現於清單"
    );
    // 刪除集合（drop_collection）→ 從清單消失（兼作清理）。
    d.drop_collection("testdb", &nc).await.unwrap();
    assert!(
        !d.list_tables("testdb").await.unwrap().iter().any(|t| t.name == nc),
        "刪除後集合 {nc} 應消失"
    );
    // 安全護欄：MongoDB 系統庫不可刪除。
    assert!(d.drop_database("admin").await.is_err(), "Mongo 系統庫 admin 不可刪除");
    assert!(d.drop_database("config").await.is_err(), "Mongo 系統庫 config 不可刪除");

    // query() JSON 介面 + limit（驗證 sort/projection/limit 擴充）：2 筆中 limit 1 → 回 1 筆
    let q = format!("{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"filter\":{{}},\"limit\":1}}");
    let qr = d.query(&q).await.unwrap();
    assert_eq!(qr.rows.len(), 1, "Mongo query limit=1 應回 1 筆");

    // query() sort：依 age 升冪（刪除 alice 後剩 bob=25、carol=40）→ 首筆應為 bob
    let q_sort =
        format!("{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"filter\":{{}},\"sort\":{{\"age\":1}}}}");
    let qs = d.query(&q_sort).await.unwrap();
    assert_eq!(qs.rows.len(), 2);
    let first: serde_json::Value = serde_json::from_str(qs.rows[0][0].as_deref().unwrap()).unwrap();
    assert_eq!(first.get("name").and_then(|v| v.as_str()), Some("bob"), "sort age 升冪首筆應為 bob");

    // query() projection + filter：city=x（carol）只取 name、排除 _id → 文件僅含 name 欄
    let q_proj = format!(
        "{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"filter\":{{\"city\":\"x\"}},\"projection\":{{\"name\":1,\"_id\":0}}}}"
    );
    let qp = d.query(&q_proj).await.unwrap();
    assert_eq!(qp.rows.len(), 1, "city=x 過濾後應只剩 carol");
    let doc: serde_json::Value = serde_json::from_str(qp.rows[0][0].as_deref().unwrap()).unwrap();
    let obj = doc.as_object().unwrap();
    assert!(obj.contains_key("name"), "projection 應含 name：{obj:?}");
    assert!(!obj.contains_key("city"), "projection 應排除 city：{obj:?}");
    assert!(!obj.contains_key("_id"), "projection 應排除 _id：{obj:?}");

    // 聚合管線（aggregate）：$match city=x → $group 加總 age。剩 bob(y)、carol(x,40) → totalAge 40。
    let aggq = format!(
        "{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"pipeline\":[{{\"$match\":{{\"city\":\"x\"}}}},{{\"$group\":{{\"_id\":null,\"totalAge\":{{\"$sum\":\"$age\"}}}}}}]}}"
    );
    let ar = d.query(&aggq).await.unwrap();
    assert_eq!(ar.rows.len(), 1, "聚合應回一筆 group 結果");
    let raw = ar.rows[0][0].as_deref().unwrap();
    assert!(raw.contains("totalAge") && raw.contains("40"), "聚合 $sum age 應得 totalAge=40：{raw}");

    // 批次插入（insert_many via query JSON）：Mongo 的「匯入 JSON」對稱能力。
    let before = d.table_data("testdb", &coll, &dq(vec![], vec![])).await.unwrap().total_rows;
    let insq = format!(
        "{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"insert\":[{{\"name\":\"dave\",\"age\":50}},{{\"name\":\"erin\",\"age\":60}}]}}"
    );
    let ir = d.query(&insq).await.unwrap();
    assert_eq!(ir.rows_affected, 2, "insert_many 應插入 2 筆");
    let after = d.table_data("testdb", &coll, &dq(vec![], vec![])).await.unwrap().total_rows;
    assert_eq!(after, before + 2, "集合應多 2 筆文件");

    // 批次更新（update_many via query JSON）：age >= 50（dave、erin）的 city 設為 senior → 修改 2 筆。
    let upq = format!(
        "{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"update\":{{\"filter\":{{\"age\":{{\"$gte\":50}}}},\"set\":{{\"city\":\"senior\"}}}}}}"
    );
    assert_eq!(d.query(&upq).await.unwrap().rows_affected, 2, "update_many 應修改 2 筆");
    // 安全防護：空 filter 的 update 應被拒（避免誤改整個集合，與 delete 一致）。
    let badupd = format!("{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"update\":{{\"set\":{{\"x\":1}}}}}}");
    assert!(d.query(&badupd).await.is_err(), "空 filter 的 update 應被拒");
    // 批次刪除（delete_many）：刪 city = senior → 刪除 2 筆。
    let delq = format!("{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"delete\":{{\"city\":\"senior\"}}}}");
    assert_eq!(d.query(&delq).await.unwrap().rows_affected, 2, "delete_many 應刪除 2 筆");
    // 安全防護：空 filter 的 delete 應被拒（避免誤刪整個集合）。
    let badq = format!("{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"delete\":{{}}}}");
    assert!(d.query(&badq).await.is_err(), "空 filter 的 delete 應被拒");

    // 自訂字串 _id 的 CRUD（Mongo 常見：非 ObjectId 的 _id）：以字串 _id 插入 → 依 _id 查 → 依 _id 刪。
    let insid = format!("{{\"db\":\"testdb\",\"collection\":\"{coll}\",\"insert\":[{{\"_id\":\"custom1\",\"name\":\"zoe\"}}]}}");
    assert_eq!(d.query(&insid).await.unwrap().rows_affected, 1, "字串 _id 插入應成功");
    let one = d.table_data("testdb", &coll, &dq(vec![filt("_id", "=", Some("custom1"))], vec![])).await.unwrap();
    assert_eq!(one.rows.len(), 1, "依字串 _id 應查得文件");
    d.delete_row("testdb", &coll, &RowDelete { pk_columns: sv(&["_id"]), pk_values: vec![Some("custom1".into())] })
        .await
        .unwrap();
    let gone = d.table_data("testdb", &coll, &dq(vec![filt("_id", "=", Some("custom1"))], vec![])).await.unwrap();
    assert_eq!(gone.rows.len(), 0, "依字串 _id 刪除後應消失");

    d.close().await;
}
