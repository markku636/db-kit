//! 跨引擎（MySQL 8.4 ↔ PostgreSQL 16）比對整合驗證。
//!
//! 為什麼要另開一檔：跨引擎才會踩到「同值不同字」（1.50 vs 1.5、1 vs true、CHAR 補白）、
//! 「兩側排序規則不一致」（MySQL `_ai_ci` vs PG locale vs Rust 位元組序）與「DML 方言」三類問題，
//! 這些是 SQLite 對 SQLite 的既有測試永遠碰不到的。
//!
//! 需要 Docker：MySQL 127.0.0.1:13306、PostgreSQL 127.0.0.1:15432。
//! 每個測試開頭都會 DROP/CREATE 自己的 `cmpc_my` 資料庫與 `cmpc_pg` schema，重跑必定決定性；
//! 因此務必以 `--test-threads=1` 執行（同檔測試彼此會互相清掉物件）。

use crate::compare::data::{
    self, DataCompareOptions, DataDiffReport, RunMode, Strategy, TableRef,
};
use crate::compare::normalize::{infer_mode, CompareMode};
use crate::compare::{ddl, diff, schema};
use crate::db::{ColumnInfo, ConnectionConfig, DbKind, SshAuthMethod};
use crate::manager::ConnectionManager;

const MY: &str = "cmpc-src-my";
const PG: &str = "cmpc-dst-pg";
/// MySQL 的「資料庫」；PG 的「資料庫」參數其實是 schema，連線本身仍連 testdb。
const MYDB: &str = "cmpc_my";
const PGDB: &str = "cmpc_pg";

fn no_cmp_progress(_: crate::compare::CompareProgress) {}

fn cfg(kind: DbKind, port: u16, user: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: "cmpc".into(),
        name: "cmpc".into(),
        kind,
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
        password: "test1234".into(),
        database: Some("testdb".into()),
        max_connections: 5,
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
    }
}

/// 容器剛起來時可能還沒 ready，與 it_tests 的 connect_retry_* 同樣重試。
async fn connect_retry(mgr: &ConnectionManager, c: &ConnectionConfig) {
    for i in 0..60 {
        match mgr.connect(c.clone()).await {
            Ok(()) => return,
            Err(e) => {
                if i == 59 {
                    panic!("連線失敗 {}：{e:?}", c.id);
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}

/// 兩側連線 + 乾淨的 `cmpc_my` / `cmpc_pg`。
async fn setup() -> ConnectionManager {
    let mgr = ConnectionManager::new();
    let mut my = cfg(DbKind::Mysql, 13306, "root");
    my.id = MY.into();
    let mut pg = cfg(DbKind::Postgres, 15432, "postgres");
    pg.id = PG.into();
    connect_retry(&mgr, &my).await;
    connect_retry(&mgr, &pg).await;
    mgr.query(MY, "DROP DATABASE IF EXISTS cmpc_my").await.unwrap();
    mgr.query(MY, "CREATE DATABASE cmpc_my").await.unwrap();
    mgr.query(PG, "DROP SCHEMA IF EXISTS cmpc_pg CASCADE").await.unwrap();
    mgr.query(PG, "CREATE SCHEMA cmpc_pg").await.unwrap();
    mgr
}

async fn teardown(mgr: ConnectionManager) {
    let _ = mgr.query(MY, "DROP DATABASE IF EXISTS cmpc_my").await;
    let _ = mgr.query(PG, "DROP SCHEMA IF EXISTS cmpc_pg CASCADE").await;
    mgr.disconnect(MY).await;
    mgr.disconnect(PG).await;
}

/// 兩側「同一張邏輯表」的引擎原生 DDL。
fn my_ddl(t: &str) -> String {
    format!(
        "CREATE TABLE cmpc_my.{t} (id INT PRIMARY KEY, code VARCHAR(20), amount DECIMAL(10,2), \
         flag TINYINT(1), ts DATETIME, note TEXT NULL, name CHAR(10))"
    )
}
fn pg_ddl(t: &str) -> String {
    format!(
        "CREATE TABLE cmpc_pg.{t} (id integer PRIMARY KEY, code varchar(20), amount numeric(10,2), \
         flag boolean, ts timestamp, note text NULL, name char(10))"
    )
}

fn tref(id: &str, db: &str, t: &str) -> TableRef {
    TableRef { conn_id: id.into(), database: db.into(), table: t.into() }
}

fn mode_of(src: &[ColumnInfo], dst: &[ColumnInfo], name: &str) -> CompareMode {
    let s = src.iter().find(|c| c.name.eq_ignore_ascii_case(name)).expect("來源缺欄位");
    let d = dst.iter().find(|c| c.name.eq_ignore_ascii_case(name)).expect("目標缺欄位");
    infer_mode(&s.data_type, &d.data_type)
}

fn counts(r: &DataDiffReport) -> (u64, u64, u64) {
    (r.summary.inserts, r.summary.updates, r.summary.deletes)
}

/// 找某一列的 update 樣本（以主鍵值）。
fn upd_changed<'a>(r: &'a DataDiffReport, pk: &str) -> &'a [String] {
    let i = r.columns.iter().position(|c| c.eq_ignore_ascii_case(&r.pk[0])).unwrap();
    let s = r
        .samples
        .updates
        .iter()
        .find(|u| u.src[i].as_deref() == Some(pk))
        .unwrap_or_else(|| panic!("找不到 pk={pk} 的 update 樣本：{:?}", r.samples.updates));
    &s.changed
}

// ---------------------------------------------------------------------------
// 1. 邏輯相同的列以各自引擎原生型別表達時必須判為相同
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "需要 Docker MySQL:13306 + PostgreSQL:15432"]
async fn cross_identical_rows_compare_equal() {
    let mgr = setup().await;
    mgr.query(MY, &my_ddl("t1")).await.unwrap();
    mgr.query(PG, &pg_ddl("t1")).await.unwrap();
    // 兩側寫法刻意不同：MySQL DECIMAL 顯示 "1.50"、PG numeric 也是 "1.50"，但 flag / name / note 走不同路徑。
    mgr.query(
        MY,
        "INSERT INTO cmpc_my.t1 VALUES \
         (1,'a1',1.50,1,'2024-01-02 03:04:05',NULL,'ab'), \
         (2,'a2',0.00,0,'2024-01-02 03:04:05','','cd')",
    )
    .await
    .unwrap();
    mgr.query(
        PG,
        "INSERT INTO cmpc_pg.t1 VALUES \
         (1,'a1',1.5,true,'2024-01-02 03:04:05',NULL,'ab'), \
         (2,'a2',0,false,'2024-01-02 03:04:05','','cd')",
    )
    .await
    .unwrap();

    // 先把 infer_mode 的實際選擇釘住：模式選錯就是靜默漏報的根源。
    let sc = mgr.table_columns(MY, MYDB, "t1").await.unwrap();
    let dc = mgr.table_columns(PG, PGDB, "t1").await.unwrap();
    let types: Vec<String> = sc
        .iter()
        .map(|c| {
            let d = dc.iter().find(|d| d.name.eq_ignore_ascii_case(&c.name)).unwrap();
            format!("{}: {} / {} -> {:?}", c.name, c.data_type, d.data_type, infer_mode(&c.data_type, &d.data_type))
        })
        .collect();
    println!("[cmpc] infer_mode:\n  {}", types.join("\n  "));
    assert_eq!(mode_of(&sc, &dc, "id"), CompareMode::Numeric);
    assert_eq!(mode_of(&sc, &dc, "amount"), CompareMode::Numeric);
    assert_eq!(mode_of(&sc, &dc, "flag"), CompareMode::Bool);
    assert_eq!(mode_of(&sc, &dc, "ts"), CompareMode::DateTime);
    assert_eq!(mode_of(&sc, &dc, "note"), CompareMode::Text);
    assert_eq!(mode_of(&sc, &dc, "name"), CompareMode::CharPad);
    // PG 的 varchar 拼作 "character varying"，base_type 以空白切詞只會留下 "character"；
    // is_charpad 特別擋掉這一種拼法，varchar 才不會被當成定長 CHAR 而兩側 rtrim
    //（否則尾空白差異會靜默漏報——下面 trailing-space 案例就是證明）。
    assert_eq!(
        mode_of(&sc, &dc, "code"),
        CompareMode::Text,
        "varchar(20) vs character varying 必須是 Text"
    );

    let s = tref(MY, MYDB, "t1");
    let d = tref(PG, PGDB, "t1");
    let r = data::compare_table(&mgr, "cmpc-1", &s, &d, &DataCompareOptions::default(), &no_cmp_progress)
        .await
        .unwrap();
    assert_eq!(counts(&r), (0, 0, 0), "原生表達的同值列不應有差異：{:?}", r.samples);
    assert_eq!(r.summary.compared_rows, 2);
    assert_eq!(r.summary.strategy_used, "merge_join");
    assert!(r.summary.truncated_reason.is_none());

    // NULL vs ''：null_equals_empty 預設 false（無 Oracle 側）→ 必須算一筆 update。
    mgr.query(PG, "UPDATE cmpc_pg.t1 SET note = '' WHERE id = 1").await.unwrap();
    let r = data::compare_table(&mgr, "cmpc-1b", &s, &d, &DataCompareOptions::default(), &no_cmp_progress)
        .await
        .unwrap();
    assert_eq!(counts(&r), (0, 1, 0), "NULL vs '' 應算差異：{:?}", r.samples);
    assert_eq!(upd_changed(&r, "1"), ["note"]);
    mgr.query(PG, "UPDATE cmpc_pg.t1 SET note = NULL WHERE id = 1").await.unwrap();

    // varchar 的尾空白是真實資料差異（兩側都是變長型別，沒有補白語意），必須被抓到。
    mgr.query(MY, "UPDATE cmpc_my.t1 SET code = 'a1  ' WHERE id = 1").await.unwrap();
    let raw = mgr.query(MY, "SELECT LENGTH(code) FROM cmpc_my.t1 WHERE id = 1").await.unwrap();
    assert_eq!(raw.rows[0][0].as_deref(), Some("4"), "MySQL VARCHAR 確實保留尾空白");
    let r = data::compare_table(&mgr, "cmpc-1c", &s, &d, &DataCompareOptions::default(), &no_cmp_progress)
        .await
        .unwrap();
    assert_eq!(counts(&r), (0, 1, 0), "varchar 尾空白差異不得被靜默忽略：{:?}", r.samples);
    assert_eq!(upd_changed(&r, "1"), ["code"]);

    teardown(mgr).await;
}

// ---------------------------------------------------------------------------
// 2. 真實差異必須被抓到，且 changed 欄位精準
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "需要 Docker MySQL:13306 + PostgreSQL:15432"]
async fn cross_real_differences_are_detected() {
    let mgr = setup().await;
    mgr.query(MY, &my_ddl("t2")).await.unwrap();
    mgr.query(PG, &pg_ddl("t2")).await.unwrap();
    mgr.query(
        MY,
        "INSERT INTO cmpc_my.t2 VALUES \
         (1,'only-my',1.00,1,'2024-01-02 03:04:05',NULL,'x'), \
         (2,'same',2.00,0,'2024-01-02 03:04:05',NULL,'x'), \
         (3,'amt',1.50,1,'2024-01-02 03:04:05',NULL,'x'), \
         (4,'flg',1.00,1,'2024-01-02 03:04:05',NULL,'x')",
    )
    .await
    .unwrap();
    mgr.query(
        PG,
        "INSERT INTO cmpc_pg.t2 VALUES \
         (2,'same',2,false,'2024-01-02 03:04:05',NULL,'x'), \
         (3,'amt',1.51,true,'2024-01-02 03:04:05',NULL,'x'), \
         (4,'flg',1,false,'2024-01-02 03:04:05',NULL,'x'), \
         (5,'only-pg',9.99,true,'2024-01-02 03:04:05',NULL,'x')",
    )
    .await
    .unwrap();

    let r = data::compare_table(
        &mgr,
        "cmpc-2",
        &tref(MY, MYDB, "t2"),
        &tref(PG, PGDB, "t2"),
        &DataCompareOptions::default(),
        &no_cmp_progress,
    )
    .await
    .unwrap();
    assert_eq!(counts(&r), (1, 2, 1), "{:?}", r.samples);
    assert_eq!(r.summary.compared_rows, 1);
    assert_eq!((r.summary.src_rows, r.summary.dst_rows), (4, 4));
    // 0.01 的差只影響 amount，不可牽連其他欄。
    assert_eq!(upd_changed(&r, "3"), ["amount"]);
    assert_eq!(upd_changed(&r, "4"), ["flag"]);
    let ins_id = r.columns.iter().position(|c| c == "id").unwrap();
    assert_eq!(r.samples.inserts[0][ins_id].as_deref(), Some("1"));
    assert_eq!(r.samples.deletes[0][ins_id].as_deref(), Some("5"));

    teardown(mgr).await;
}

// ---------------------------------------------------------------------------
// 3. 字串主鍵：兩側排序規則與 Rust 比較器三方不一致，計數仍須精確
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "需要 Docker MySQL:13306 + PostgreSQL:15432"]
async fn cross_string_pk_survives_collation_disagreement() {
    let mgr = setup().await;
    mgr.query(MY, "CREATE TABLE cmpc_my.t3 (k VARCHAR(20) PRIMARY KEY, v VARCHAR(20))").await.unwrap();
    mgr.query(PG, "CREATE TABLE cmpc_pg.t3 (k varchar(20) PRIMARY KEY, v varchar(20))").await.unwrap();
    // MySQL utf8mb4_0900_ai_ci 大小寫 / 重音不敏感、PG en_US.utf8 又是另一套，Rust 則是位元組序。
    mgr.query(
        MY,
        "INSERT INTO cmpc_my.t3 VALUES ('a','1'),('B','2'),('c','3'),('D','4'),('é','5'),('Z','6')",
    )
    .await
    .unwrap();
    // 少 'D'（→ insert）、多 'q'（→ delete）、'c' 的值不同（→ update）。
    mgr.query(
        PG,
        "INSERT INTO cmpc_pg.t3 VALUES ('a','1'),('B','2'),('c','3x'),('é','5'),('Z','6'),('q','9')",
    )
    .await
    .unwrap();

    // 兩台伺服器實際回的順序（僅記錄，不斷言：locale 由容器決定）。
    let so = mgr.query(MY, "SELECT GROUP_CONCAT(k ORDER BY k) FROM cmpc_my.t3").await.unwrap();
    let dorder = mgr.query(PG, "SELECT string_agg(k, ',' ORDER BY k) FROM cmpc_pg.t3").await.unwrap();
    println!("[cmpc] MySQL order = {:?} / PG order = {:?}", so.rows[0][0], dorder.rows[0][0]);

    let s = tref(MY, MYDB, "t3");
    let d = tref(PG, PGDB, "t3");
    let auto = data::compare_table(&mgr, "cmpc-3a", &s, &d, &DataCompareOptions::default(), &no_cmp_progress)
        .await
        .unwrap();
    println!(
        "[cmpc] auto strategy={} truncated={:?} warnings={:?}",
        auto.summary.strategy_used, auto.summary.truncated_reason, auto.summary.warnings
    );
    assert_eq!(counts(&auto), (1, 1, 1), "手算期望：insert D / update c / delete q，{:?}", auto.samples);
    assert_eq!(auto.summary.compared_rows, 4, "a / B / é / Z 四列相同");
    assert!(
        auto.summary.truncated_reason.is_none(),
        "排序不一致必須退回 hash_diff 完成，而不是以 pk_order_mismatch 截斷"
    );

    let hd = DataCompareOptions { strategy: Strategy::HashDiff, ..Default::default() };
    let hash = data::compare_table(&mgr, "cmpc-3b", &s, &d, &hd, &no_cmp_progress).await.unwrap();
    assert_eq!(hash.summary.strategy_used, "hash_diff");
    assert_eq!(counts(&hash), counts(&auto), "指定 hash_diff 與 auto 必須一致");
    assert_eq!(hash.summary.compared_rows, auto.summary.compared_rows);
    assert!(hash.summary.truncated_reason.is_none());

    teardown(mgr).await;
}

// ---------------------------------------------------------------------------
// 4. 跨引擎結構差異：型別只看家族，且不得產生同步 DDL
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "需要 Docker MySQL:13306 + PostgreSQL:15432"]
async fn cross_schema_diff_by_family_and_refuses_ddl() {
    let mgr = setup().await;
    mgr.query(MY, &format!("{} ", my_ddl("t4")).replace("name CHAR(10))", "name CHAR(10), diffcol VARCHAR(10))"))
        .await
        .unwrap();
    mgr.query(PG, &pg_ddl("t4").replace("name char(10))", "name char(10), diffcol integer)")).await.unwrap();

    let opts = schema::CaptureOptions::default();
    let sa = schema::capture(&mgr, MY, MYDB, "my", &opts, None).await.unwrap();
    let sb = schema::capture(&mgr, PG, PGDB, "pg", &opts, None).await.unwrap();
    let d = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    assert!(d.cross_engine, "MySQL vs PG 必須標記 cross_engine");
    assert!(d.tables_added.is_empty() && d.tables_removed.is_empty());
    assert_eq!(d.tables_changed.len(), 1, "只有 t4 且只因 diffcol 有差：{:?}", d.summary);
    let td = &d.tables_changed[0];
    let changed: Vec<&str> = td.columns_changed.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        changed,
        vec!["diffcol"],
        "int/integer、tinyint(1)/boolean、decimal/numeric、datetime/timestamp 屬同家族不該回報"
    );
    assert_eq!(td.columns_changed[0].attrs, vec![diff::ColumnAttr::DataType]);
    assert!(td.columns_added.is_empty() && td.columns_removed.is_empty());
    assert!(td.indexes_added.is_empty() && td.indexes_removed.is_empty() && td.indexes_changed.is_empty(), "主鍵索引以 primary 旗標配對：{:?}", td.indexes_changed);

    // 跨引擎不可能產生正確的同步 DDL → 必須明確拒絕。
    let e = ddl::generate(&d, &sa, &sb, &ddl::SyncOptions::default()).unwrap_err();
    assert!(matches!(e, crate::error::AppError::Unsupported(_)), "應回 Unsupported，實際 {e:?}");

    teardown(mgr).await;
}

// ---------------------------------------------------------------------------
// 5. 欄名大小寫：交集忽略大小寫，報表用來源拼法
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "需要 Docker MySQL:13306 + PostgreSQL:15432"]
async fn cross_column_name_case_is_ignored_but_reported_as_src() {
    let mgr = setup().await;
    mgr.query(MY, "CREATE TABLE cmpc_my.t5 (id INT PRIMARY KEY, Amount DECIMAL(10,2))").await.unwrap();
    mgr.query(PG, "CREATE TABLE cmpc_pg.t5 (id integer PRIMARY KEY, amount numeric(10,2))").await.unwrap();
    mgr.query(MY, "INSERT INTO cmpc_my.t5 VALUES (1,1.50),(2,2.00)").await.unwrap();
    mgr.query(PG, "INSERT INTO cmpc_pg.t5 VALUES (1,1.5),(2,2)").await.unwrap();

    let r = data::compare_table(
        &mgr,
        "cmpc-5",
        &tref(MY, MYDB, "t5"),
        &tref(PG, PGDB, "t5"),
        &DataCompareOptions::default(),
        &no_cmp_progress,
    )
    .await
    .unwrap();
    assert_eq!(r.columns, vec!["id", "Amount"], "欄位清單應是來源拼法");
    assert!(r.skipped_src_columns.is_empty() && r.skipped_dst_columns.is_empty(), "大小寫不同不算缺欄");
    assert_eq!(counts(&r), (0, 0, 0), "{:?}", r.samples);
    assert_eq!(r.summary.compared_rows, 2);

    // 反向：目標欄名大小寫不同時仍可寫入（DML 用目標拼法）。
    mgr.query(MY, "INSERT INTO cmpc_my.t5 VALUES (3,3.30)").await.unwrap();
    let ap = DataCompareOptions { mode: RunMode::Apply, ..Default::default() };
    let r = data::compare_table(&mgr, "cmpc-5b", &tref(MY, MYDB, "t5"), &tref(PG, PGDB, "t5"), &ap, &no_cmp_progress)
        .await
        .unwrap();
    let a = r.apply.expect("apply 模式應回結果");
    assert_eq!((a.applied, a.failed), (1, 0), "{:?}", a.errors);

    teardown(mgr).await;
}

// ---------------------------------------------------------------------------
// 6. 產生的 DML 方言（兩個方向）
// ---------------------------------------------------------------------------

/// MySQL → PG：雙引號識別字、反斜線不加倍、無 N'' 前綴；套用後再比為零。
#[tokio::test]
#[ignore = "需要 Docker MySQL:13306 + PostgreSQL:15432"]
async fn cross_dml_dialect_mysql_to_pg() {
    let mgr = setup().await;
    mgr.query(MY, &my_ddl("t6")).await.unwrap();
    mgr.query(PG, &pg_ddl("t6")).await.unwrap();
    // code 內含反斜線與單引號：兩種方言的跳脫規則不同，是最容易產生壞語句的地方。
    mgr.query(
        MY,
        "INSERT INTO cmpc_my.t6 VALUES \
         (1,'a\\\\b',1.50,1,'2024-01-02 03:04:05','it''s','ab'), \
         (2,'plain',2.00,0,'2024-01-02 03:04:05',NULL,'cd')",
    )
    .await
    .unwrap();
    mgr.query(PG, "INSERT INTO cmpc_pg.t6 VALUES (2,'plain',2,false,'2024-01-02 03:04:05',NULL,'cd')")
        .await
        .unwrap();
    let raw = mgr.query(MY, "SELECT code FROM cmpc_my.t6 WHERE id = 1").await.unwrap();
    assert_eq!(raw.rows[0][0].as_deref(), Some("a\\b"), "MySQL 端實際存的是單一反斜線");

    let s = tref(MY, MYDB, "t6");
    let d = tref(PG, PGDB, "t6");
    let sql_opts = DataCompareOptions { mode: RunMode::Sql, include_deletes: true, ..Default::default() };
    let r = data::compare_table(&mgr, "cmpc-6a", &s, &d, &sql_opts, &no_cmp_progress).await.unwrap();
    let sql = r.sql.expect("sql 模式應回文字");
    println!("[cmpc] mysql->pg sql:\n{sql}");
    assert!(sql.contains("INSERT INTO \"cmpc_pg\".\"t6\""), "PG 方言應用雙引號限定：{sql}");
    assert!(!sql.contains('`'), "不可出現 MySQL 反引號：{sql}");
    assert!(!sql.contains("N'"), "不可出現 MSSQL 的 N'' 前綴：{sql}");
    assert!(sql.contains("'a\\b'"), "PG（standard_conforming_strings=on）反斜線不加倍：{sql}");
    assert!(sql.contains("'it''s'"), "單引號以加倍跳脫：{sql}");

    let ap_opts = DataCompareOptions { mode: RunMode::Apply, include_deletes: true, ..Default::default() };
    let r = data::compare_table(&mgr, "cmpc-6b", &s, &d, &ap_opts, &no_cmp_progress).await.unwrap();
    let a = r.apply.expect("apply 模式應回結果");
    assert_eq!((a.applied, a.failed), (1, 0), "套用失敗：{:?}", a.errors);
    let again = data::compare_table(&mgr, "cmpc-6c", &s, &d, &DataCompareOptions::default(), &no_cmp_progress)
        .await
        .unwrap();
    assert_eq!(counts(&again), (0, 0, 0), "套用後應冪等歸零：{:?}", again.samples);
    assert_eq!(again.summary.compared_rows, 2);

    teardown(mgr).await;
}

/// PG → MySQL：反引號識別字；且 driver 讀 PG boolean 會得到 "true"/"false"，目標卻是 TINYINT(1)
/// ——render_for_target 依**目標欄位型別**把布林改寫成 1/0，這一段查證改寫後真的寫得進去。
#[tokio::test]
#[ignore = "需要 Docker MySQL:13306 + PostgreSQL:15432"]
async fn cross_dml_dialect_pg_to_mysql_boolean() {
    let mgr = setup().await;
    mgr.query(MY, &my_ddl("t7")).await.unwrap();
    mgr.query(PG, &pg_ddl("t7")).await.unwrap();
    mgr.query(
        PG,
        "INSERT INTO cmpc_pg.t7 VALUES \
         (1,'ins-t',1.5,true,'2024-01-02 03:04:05',NULL,'ab'), \
         (2,'ins-f',2,false,'2024-01-02 03:04:05',NULL,'cd'), \
         (3,'upd',3,true,'2024-01-02 03:04:05',NULL,'ef')",
    )
    .await
    .unwrap();
    // id=3 兩側都有，只有 flag 不同 → 走 UPDATE 路徑。
    mgr.query(MY, "INSERT INTO cmpc_my.t7 VALUES (3,'upd',3.00,0,'2024-01-02 03:04:05',NULL,'ef')")
        .await
        .unwrap();
    let mode = mgr.query(MY, "SELECT @@session.sql_mode").await.unwrap();
    println!("[cmpc] mysql sql_mode = {:?}", mode.rows[0][0]);

    let s = tref(PG, PGDB, "t7");
    let d = tref(MY, MYDB, "t7");
    let sql_opts = DataCompareOptions { mode: RunMode::Sql, ..Default::default() };
    let r = data::compare_table(&mgr, "cmpc-7a", &s, &d, &sql_opts, &no_cmp_progress).await.unwrap();
    let sql = r.sql.expect("sql 模式應回文字");
    println!("[cmpc] pg->mysql sql:\n{sql}");
    assert!(sql.contains("INSERT INTO `cmpc_my`.`t7`"), "MySQL 方言應用反引號限定：{sql}");
    assert!(!sql.contains('"'), "不可出現 PG 雙引號：{sql}");
    // 目標 flag 是 TINYINT(1) → 布林值一律寫成 1/0（'true' 會被 MySQL 以 1366 拒絕，
    // 而 WHERE flag = 'true' 更會被靜默轉成 0 而更新到錯的列）。
    assert!(!sql.contains("'true'") && !sql.contains("'false'"), "布林不得再字串化：{sql}");
    assert!(sql.contains("UPDATE `cmpc_my`.`t7` SET `flag` = '1' WHERE `id` = '3'"), "{sql}");
    let ins: Vec<&str> = sql.lines().filter(|l| l.starts_with("INSERT")).collect();
    assert_eq!(ins.len(), 2, "{sql}");
    assert!(ins.iter().any(|l| l.contains("'ins-t'") && l.contains(", '1', ")), "{ins:?}");
    assert!(ins.iter().any(|l| l.contains("'ins-f'") && l.contains(", '0', ")), "{ins:?}");

    let ap_opts = DataCompareOptions { mode: RunMode::Apply, ..Default::default() };
    let r = data::compare_table(&mgr, "cmpc-7b", &s, &d, &ap_opts, &no_cmp_progress).await.unwrap();
    let a = r.apply.expect("apply 模式應回結果");
    println!("[cmpc] pg->mysql apply = applied {} / failed {} / errors {:?}", a.applied, a.failed, a.errors);
    let got = mgr.query(MY, "SELECT id, flag FROM cmpc_my.t7 ORDER BY id").await.unwrap();
    println!("[cmpc] mysql t7 after apply = {:?}", got.rows);
    // 2 INSERT + 1 UPDATE 全部套用成功，PG → MySQL 的 boolean 欄位同步可用。
    assert_eq!((a.applied, a.failed), (3, 0), "errors={:?}", a.errors);
    assert!(a.errors.is_empty(), "{:?}", a.errors);
    assert_eq!(got.rows.len(), 3, "三列都應寫入：{:?}", got.rows);
    // sqlx 把 TINYINT(1) 的 type_info 命名成 BOOLEAN，driver 讀回來仍是 "true"/"false" 字面值；
    // render_for_target 只作用在「寫出去」那一側，讀回來的形式不變（比對走 CompareMode::Bool）。
    let flags: Vec<Option<&str>> = got.rows.iter().map(|r| r[1].as_deref()).collect();
    assert_eq!(flags, vec![Some("true"), Some("false"), Some("true")], "{:?}", got.rows);

    // 套用後再比一次：零差異（否則就只是「寫進去了但寫錯值」）。
    let again = data::compare_table(&mgr, "cmpc-7c", &s, &d, &DataCompareOptions::default(), &no_cmp_progress)
        .await
        .unwrap();
    assert_eq!(counts(&again), (0, 0, 0), "套用後應冪等歸零：{:?}", again.samples);
    assert_eq!(again.summary.compared_rows, 3);

    teardown(mgr).await;
}
