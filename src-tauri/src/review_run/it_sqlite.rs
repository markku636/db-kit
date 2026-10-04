//! 端到端：SQLite 檔案實際執行腳本 → 把產出的 rollback.sql 跑回去 → 資料必須與執行前逐位元組相同。
//!
//! 判準刻意是「回滾後整表內容與執行前一致」，而不是「產出的語句長得像我們預期」——
//! 後者只證明產生器照規格寫，前者才證明回滾真的有用。SQLite 免伺服器，每次 `cargo test` 都會跑。

use std::path::PathBuf;

use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::manager::ConnectionManager;

use super::report::{RunStatus, StmtStatus};
use super::run::{run, RunMode, RunOptions, RunOutcome, RunRequest};
use super::scan::split_statements;

struct Env {
    mgr: ConnectionManager,
    id: String,
    dir: PathBuf,
    db: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        // DBKIT_KEEP_REVIEW_OUT=1：保留輸出目錄以便目視檢查產出的檔案。
        if std::env::var_os("DBKIT_KEEP_REVIEW_OUT").is_some() {
            eprintln!("kept: {}", self.dir.display());
            return;
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn env(name: &str) -> Env {
    // Drop 當下 SQLite 檔還被連線池開著，Windows 刪不掉那個檔（目錄因此留著）；
    // 上一輪的行程結束後檔案就釋放了，所以在這裡清掉同一個測試留下的舊目錄。
    let prefix = format!("dbkit-review-run-{name}-");
    if let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let dir = std::env::temp_dir().join(format!("{prefix}{}-{}", std::process::id(), super::capture::now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("t.db");
    let id = format!("rr-{name}");
    let cfg = ConnectionConfig {
        id: id.clone(),
        name: format!("sqlite {name}"),
        kind: DbKind::Sqlite,
        host: String::new(),
        port: 0,
        username: String::new(),
        password: String::new(),
        database: Some(db.display().to_string()),
        max_connections: 3,
        ssh_enabled: false,
        ssh_host: String::new(),
        ssh_port: 0,
        ssh_username: String::new(),
        ssh_auth_method: SshAuthMethod::Password,
        ssh_password: String::new(),
        ssh_private_key_path: String::new(),
        ssh_passphrase: String::new(),
        options: Default::default(),
        otp_secret: String::new(),
    };
    let mgr = ConnectionManager::new();
    mgr.connect(cfg).await.unwrap();
    Env { mgr, id, dir, db }
}

impl Env {
    async fn exec(&self, sql: &str) {
        for (a, b) in split_statements(DbKind::Sqlite, sql) {
            self.mgr.query(&self.id, &sql[a..b]).await.unwrap_or_else(|e| panic!("{e:?}\n{}", &sql[a..b]));
        }
    }

    /// 整表內容的精確傾印（型別標記 + hex / 17 位有效數字），依所有欄位排序。
    async fn dump(&self, table: &str) -> Vec<Vec<Option<String>>> {
        let cols = self.mgr.table_columns(&self.id, "main", table).await.unwrap();
        if cols.is_empty() {
            return vec![];
        }
        let exprs: Vec<String> = cols
            .iter()
            .map(|c| format!("typeof(\"{0}\") || ':' || CASE typeof(\"{0}\") WHEN 'blob' THEN hex(\"{0}\") WHEN 'real' THEN printf('%.17g', \"{0}\") ELSE CAST(\"{0}\" AS TEXT) END", c.name))
            .collect();
        let order: Vec<String> = (1..=cols.len()).map(|i| i.to_string()).collect();
        let q = self.mgr.query_capped(&self.id, &format!("SELECT {} FROM \"{table}\" ORDER BY {}", exprs.join(", "), order.join(", ")), 0).await.unwrap();
        q.rows
    }

    async fn review(&self, script: &str, mode: RunMode, options: RunOptions) -> Result<RunOutcome, crate::error::AppError> {
        let out = self.dir.join("out");
        run(
            &self.mgr,
            &self.id,
            RunRequest {
                run_id: &format!("{}-{}", self.id, super::capture::now_ms()),
                conn_label: "sqlite test",
                database: "",
                script,
                out_dir: &out,
                mode,
                options,
                review: Some("VERDICT: CAUTION\n## Summary\nok".into()),
            },
            &|_| {},
        )
        .await
    }

    async fn apply_rollback(&self, outcome: &RunOutcome) -> String {
        let text = std::fs::read_to_string(PathBuf::from(&outcome.dir).join("rollback.sql")).unwrap();
        self.exec(&text).await;
        text
    }
}

fn ack() -> RunOptions {
    RunOptions { max_capture_rows: 0, allow_incomplete: true, confirm_prod: true }
}

#[tokio::test]
async fn mixed_dml_rolls_back_exactly() {
    let e = env("mixed").await;
    e.exec(
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT NOT NULL, total REAL, note TEXT);
         INSERT INTO orders VALUES (1, 'new', 10.5, NULL), (2, 'new', 0.1, 'it''s'), (3, 'paid', 99.99, '中文'), (4, 'paid', 1e-7, 'x');",
    )
    .await;
    let before = e.dump("orders").await;
    let script = "UPDATE orders SET status = 'cancelled', total = total * 2 WHERE status = 'new';
                  DELETE FROM orders WHERE id = 3;
                  INSERT INTO orders (id, status, total) VALUES (10, 'new', 1.0), (11, 'new', 2.0);
                  INSERT INTO orders (status, total) SELECT 'copy', total FROM orders WHERE id = 4;";
    let outcome = e.review(script, RunMode::Execute, RunOptions::default()).await.unwrap();
    let m = &outcome.manifest;
    assert_eq!(m.status, RunStatus::Completed, "{:?} {:#?}", m.stop_reason, m.statements.iter().map(|s| (&s.notes, s.rollback)).collect::<Vec<_>>());
    assert!(m.statements.iter().all(|s| s.status == StmtStatus::Ok));
    assert_eq!(m.statements[0].rows_affected, Some(2));
    assert_eq!(m.statements[0].diff[0].updated, 2);
    assert_eq!(m.statements[1].diff[0].deleted, 1);
    assert_eq!(m.statements[2].method, "keys");
    assert_eq!(m.statements[2].diff[0].inserted, 2);
    assert_eq!(m.statements[3].method, "key_range");
    assert_eq!(m.statements[3].diff[0].inserted, 1);
    assert_ne!(e.dump("orders").await, before, "腳本應該真的改到資料");

    let dir = PathBuf::from(&outcome.dir);
    for f in ["script.sql", "review.md", "rollback.sql", "diff.md", "report.md", "manifest.json"] {
        assert!(dir.join(f).exists(), "缺少 {f}");
    }
    assert!(outcome.manifest.files.iter().any(|f| f.starts_with("snapshots/01-before-")));
    assert_eq!(outcome.manifest.verdict, Some("caution"));
    let diff = std::fs::read_to_string(dir.join("diff.md")).unwrap();
    assert!(diff.contains("cancelled"), "diff.md 要列出修改後的值：{diff}");

    let rb = e.apply_rollback(&outcome).await;
    assert!(!rb.contains("【執行中】"), "最終版回滾不應帶執行中標記");
    assert_eq!(e.dump("orders").await, before, "回滾後應與執行前完全相同\n{rb}");
}

#[tokio::test]
async fn dependent_statements_capture_per_statement() {
    let e = env("dependent").await;
    e.exec(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT);
         INSERT INTO t VALUES (1, 'a'), (2, 'a'), (3, 'b');",
    )
    .await;
    let before = e.dump("t").await;
    // 第二句的條件依賴第一句的結果：開跑前一次抓前像的話，第二句的前像會是空的。
    let outcome = e.review("UPDATE t SET status = 'x' WHERE status = 'a'; DELETE FROM t WHERE status = 'x'", RunMode::Execute, RunOptions::default()).await.unwrap();
    assert_eq!(outcome.manifest.statements[1].diff[0].deleted, 2);
    assert!(e.dump("t").await.len() == 1);
    e.apply_rollback(&outcome).await;
    assert_eq!(e.dump("t").await, before);
}

#[tokio::test]
async fn blobs_reals_and_keyless_tables_round_trip() {
    let e = env("blobs").await;
    e.exec(
        "CREATE TABLE files (id INTEGER PRIMARY KEY, data BLOB, ratio REAL);
         CREATE TABLE logs (msg TEXT, n INTEGER);
         INSERT INTO logs VALUES ('dup', 1), ('dup', 1), ('other', 2);",
    )
    .await;
    // 超過 64 bytes、非合法 UTF-8 的 BLOB（driver 顯示用字串會截斷這種值）。
    let blob: String = (0..200u32).map(|i| format!("{:02X}", (i * 37 + 128) % 256)).collect();
    e.exec(&format!("INSERT INTO files VALUES (1, X'{blob}', 0.1 + 0.2), (2, X'', -0.0), (3, NULL, 1e300)")).await;
    let files_before = e.dump("files").await;
    let logs_before = e.dump("logs").await;
    let outcome = e
        .review("DELETE FROM files WHERE id <> 99; DELETE FROM logs WHERE msg = 'dup'", RunMode::Execute, RunOptions::default())
        .await
        .unwrap();
    assert_eq!(outcome.manifest.status, RunStatus::Completed);
    assert_eq!(e.dump("files").await.len(), 0);
    let rb = e.apply_rollback(&outcome).await;
    assert_eq!(e.dump("files").await, files_before, "BLOB / REAL 要逐位元組還原\n{rb}");
    assert_eq!(e.dump("logs").await, logs_before, "無主鍵表的重複列也要補回兩筆\n{rb}");
}

#[tokio::test]
async fn ddl_drop_table_and_drop_column_restore_structure_and_data() {
    let e = env("ddl").await;
    e.exec(
        "CREATE TABLE keep (id INTEGER PRIMARY KEY, a TEXT, b INTEGER);
         INSERT INTO keep VALUES (1, 'x', 5), (2, 'y', NULL);
         CREATE TABLE gone (id INTEGER PRIMARY KEY, v TEXT);
         INSERT INTO gone VALUES (1, 'one'), (2, 'two');",
    )
    .await;
    let keep_before = e.dump("keep").await;
    let gone_before = e.dump("gone").await;
    let outcome = e.review("ALTER TABLE keep DROP COLUMN b; DROP TABLE gone", RunMode::Execute, ack()).await.unwrap();
    assert_eq!(outcome.manifest.status, RunStatus::Completed, "{:?}", outcome.manifest.stop_reason);
    assert!(e.mgr.table_columns(&e.id, "main", "keep").await.unwrap().iter().all(|c| c.name != "b"));
    let rb = e.apply_rollback(&outcome).await;
    assert_eq!(e.dump("gone").await, gone_before, "DROP TABLE 要連資料一起建回來\n{rb}");
    // SQLite 的 ADD COLUMN 會把欄位加在最後；欄序相同時整表內容應一致。
    assert_eq!(e.dump("keep").await, keep_before, "DROP COLUMN 的值要寫回\n{rb}");
}

#[tokio::test]
async fn blockers_refuse_before_touching_anything() {
    let e = env("blockers").await;
    e.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)").await;
    let err = e.review("BEGIN; DELETE FROM t; COMMIT", RunMode::Execute, ack()).await.unwrap_err();
    assert!(err.message().contains("#1"), "{}", err.message());
    assert_eq!(e.dump("t").await.len(), 1);
    assert!(!e.dir.join("out").exists(), "被擋下時不應建立輸出目錄");
}

#[tokio::test]
async fn incomplete_rollback_requires_ack() {
    let e = env("ack").await;
    e.exec("CREATE TABLE nokey (a TEXT, b TEXT); INSERT INTO nokey VALUES ('1', 'x')").await;
    // 沒有鍵的 UPDATE 無法回滾：沒確認就不執行。
    let err = e.review("UPDATE nokey SET b = 'y'", RunMode::Execute, RunOptions::default()).await.unwrap_err();
    assert!(matches!(err, crate::error::AppError::NeedsConfirm(_)));
    assert_eq!(e.dump("nokey").await[0][1].as_deref(), Some("text:x"));
    let ok = e.review("UPDATE nokey SET b = 'y'", RunMode::Execute, ack()).await.unwrap();
    assert_eq!(ok.manifest.status, RunStatus::Completed);
    let rb = std::fs::read_to_string(PathBuf::from(&ok.dir).join("rollback.sql")).unwrap();
    assert!(rb.contains("-- [需人工確認]"), "{rb}");
}

#[tokio::test]
async fn capture_limit_stops_before_the_statement() {
    let e = env("limit").await;
    e.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, v INTEGER)").await;
    let values: Vec<String> = (1..=30).map(|i| format!("({i}, {i})")).collect();
    e.exec(&format!("INSERT INTO big VALUES {}", values.join(", "))).await;
    let opts = RunOptions { max_capture_rows: 10, allow_incomplete: false, confirm_prod: true };
    let err = e.review("DELETE FROM big WHERE v > 0", RunMode::Execute, opts).await.unwrap_err();
    assert!(matches!(err, crate::error::AppError::NeedsConfirm(_)), "探測就該發現超過上限：{err:?}");
    assert_eq!(e.dump("big").await.len(), 30);
}

#[tokio::test]
async fn backup_mode_writes_files_without_executing() {
    let e = env("backup").await;
    e.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b')").await;
    let before = e.dump("t").await;
    let outcome = e.review("UPDATE t SET v = 'z' WHERE id = 1; DELETE FROM t WHERE id = 2", RunMode::Backup, RunOptions::default()).await.unwrap();
    assert_eq!(outcome.manifest.status, RunStatus::BackupOnly);
    assert_eq!(e.dump("t").await, before, "只備份模式不可改到資料");
    let dir = PathBuf::from(&outcome.dir);
    assert!(dir.join("rollback.sql").exists());
    assert!(!dir.join("diff.md").exists());
    // 預估回滾在「真的執行了」之後套用，也要能還原。
    e.exec("UPDATE t SET v = 'z' WHERE id = 1; DELETE FROM t WHERE id = 2").await;
    e.apply_rollback(&outcome).await;
    assert_eq!(e.dump("t").await, before);
    let _ = &e.db;
}

/// 影響列預覽：UPDATE / DELETE 列出會被改到的列（依 WHERE），帶鍵的 INSERT 列出會撞鍵的既有列，
/// 而且預覽本身不改任何資料。
#[tokio::test]
async fn preview_lists_affected_rows_without_writing() {
    let e = env("preview").await;
    e.exec("CREATE TABLE acct (id INTEGER PRIMARY KEY, owner TEXT, balance INTEGER); \
            INSERT INTO acct VALUES (1, 'amy', 10), (2, 'bob', 20), (3, 'cat', 30), (4, 'dan', 40);")
        .await;
    let script = "UPDATE acct SET balance = balance + 1 WHERE balance >= 30;\n\
                  DELETE FROM acct WHERE owner = 'amy';\n\
                  INSERT INTO acct (id, owner, balance) VALUES (2, 'dup', 0), (9, 'new', 0);\n\
                  SELECT * FROM acct;";
    let p = super::preview::preview(&e.mgr, &e.id, "", script).await.unwrap();
    assert_eq!(p.statements.len(), 4);

    let upd = &p.statements[0];
    assert!(upd.write);
    assert_eq!(upd.estimated_rows, Some(2));
    let ids: Vec<_> = upd.rows.iter().map(|r| r[0].clone().unwrap()).collect();
    assert_eq!(ids, vec!["3", "4"], "UPDATE 預覽的是 WHERE 命中的列");
    assert_eq!(upd.columns, vec!["id", "owner", "balance"]);

    let del = &p.statements[1];
    assert_eq!(del.rows.len(), 1);
    assert_eq!(del.rows[0][1].as_deref(), Some("amy"));

    let ins = &p.statements[2];
    assert_eq!(ins.rows.len(), 1, "只有 id=2 已存在：{:?}", ins.rows);
    assert_eq!(ins.rows[0][0].as_deref(), Some("2"));

    let sel = &p.statements[3];
    assert!(!sel.write);
    assert!(sel.rows.is_empty(), "讀取語句不擷取");

    // 預覽不得改資料。
    let q = e.mgr.query_capped(&e.id, "SELECT SUM(balance), COUNT(*) FROM acct", 0).await.unwrap();
    assert_eq!(q.rows[0][0].as_deref(), Some("100"));
    assert_eq!(q.rows[0][1].as_deref(), Some("4"));
}

/// 執行 SQL 檔（sqlfile.rs）：整份在同一條專屬連線上跑——暫存表與交易跨句仍有效；
/// 遇錯即停 vs. 繼續執行兩種模式的計數與行號正確。
#[tokio::test]
async fn sql_file_runs_on_one_session() {
    let e = env("sqlfile").await;
    let path = e.dir.join("script.sql");
    std::fs::write(
        &path,
        "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n\
         CREATE TEMP TABLE scratch (v TEXT);\n\
         INSERT INTO scratch VALUES ('a'), ('b');\n\
         BEGIN;\n\
         INSERT INTO t (v) SELECT v FROM scratch;\n\
         COMMIT;\n\
         INSERT INTO nope VALUES (1);\n\
         INSERT INTO t (v) VALUES ('c');\n",
    )
    .unwrap();
    let p = path.display().to_string();
    let noop = |_: crate::sqlfile::SqlFileProgress| {};

    let stop = crate::sqlfile::run(&e.mgr, &e.id, "", &p, &Default::default(), "sf-1", &noop).await.unwrap();
    assert_eq!((stop.total, stop.executed, stop.failed), (8, 6, 1));
    assert!(stop.stopped_on_error);
    assert_eq!(stop.errors[0].line, 7, "錯誤行號指到 INSERT INTO nope");
    let q = e.mgr.query_capped(&e.id, "SELECT COUNT(*) FROM t", 0).await.unwrap();
    assert_eq!(q.rows[0][0].as_deref(), Some("2"), "暫存表的列經交易寫進 t：證明整份在同一條連線上");

    e.exec("DROP TABLE t").await;
    let opts = crate::sqlfile::SqlFileOptions { continue_on_error: true };
    let cont = crate::sqlfile::run(&e.mgr, &e.id, "", &p, &opts, "sf-2", &noop).await.unwrap();
    assert_eq!((cont.executed, cont.failed), (7, 1));
    assert!(!cont.stopped_on_error);
    let q = e.mgr.query_capped(&e.id, "SELECT COUNT(*) FROM t", 0).await.unwrap();
    assert_eq!(q.rows[0][0].as_deref(), Some("3"));
}
