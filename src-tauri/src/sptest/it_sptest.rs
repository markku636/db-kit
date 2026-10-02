//! 預存程序整合測試引擎的端到端測試（需三個真實引擎，見 scripts/dev-sptest/docker-compose.yml）。
//!
//!   docker compose -f scripts/dev-sptest/docker-compose.yml up -d
//!   cargo test --lib sptest::it_sptest -- --ignored --test-threads=1
//!
//! 同一份測試檔（表名 / 程序名不帶 schema，參數名用來源風格）跑三個引擎：表名靠開場的 USE /
//! search_path 解析，參數名靠 `norm_param`（`CustomerID` ≈ `p_customer_id`）。
#![cfg(test)]

use std::collections::BTreeMap;

use super::model::TestFile;
use super::report::Verdict;
use super::run::{run_file, ExecMode, RunOptions};
use super::session;
use super::EngineRef;
use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::manager::ConnectionManager;

const MSSQL_SCHEMA: &str = include_str!("../../../scripts/dev-sptest/mssql/schema.sql");
const MSSQL_ROUTINES: &str = include_str!("../../../scripts/dev-sptest/mssql/routines.sql");
const PG_SCHEMA: &str = include_str!("../../../scripts/dev-sptest/pg/schema.sql");
const PG_ROUTINES: &str = include_str!("../../../scripts/dev-sptest/pg/routines.sql");
const MY_SCHEMA: &str = include_str!("../../../scripts/dev-sptest/mysql/schema.sql");
const MY_ROUTINES: &str = include_str!("../../../scripts/dev-sptest/mysql/routines.sql");

const SUITE: &str = r#"{
  "version": 1,
  "target": {"kind": "mssql", "database": "sptest"},
  "fixtures": {
    "base": {"steps": [
      {"insert": "customers", "rows": [{"customer_id": ">>cid", "name": "Ann", "credit": "100.00", "is_active": true}]},
      {"insert": "products", "rows": [{"product_id": ">>pid", "name": "Pen", "price": "12.50", "stock": 10}]}
    ]}
  },
  "scenarios": [
    {"id": "place_then_cancel", "use": ["base"], "steps": [
      {"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": 2},
       "capture": {"order_id": ">>oid"},
       "expect": {"result_sets": [{"rows": [{"qty": 2, "total": "25.00", "status": "NEW"}]}],
                  "effects": {"orders": {"inserted": [{"qty": 2, "total": "25.00", "status": "NEW"}]},
                              "products": {"updated": [{"before": {"stock": 10}, "after": {"product_id": "<<pid", "stock": 8}}]}},
                  "effects_strict": true}},
      {"query": "SELECT stock FROM products WHERE product_id = @pid", "expect": [{"stock": 8}]},
      {"call": "usp_cancel_order", "params": {"OrderID": "<<oid"},
       "expect": {"effects": {"orders": {"updated": [{"after": {"order_id": "<<oid", "status": "CANCELLED"}}]}, "products": {"updated": 1}}}},
      {"query": "SELECT stock FROM products WHERE product_id = @pid", "expect": [{"stock": 10}]},
      {"call": "usp_cancel_order", "params": {"OrderID": "<<oid"}, "expect_error": {"class": "user_raised", "message_contains": "cancellable"}}
    ]},
    {"id": "qty_cases", "use": ["base"],
     "cases": [{"name": "two", "vars": {"qty": 2, "total": "25.00"}}, {"name": "zero", "vars": {"qty": 0, "total": "0"}, "expect_error": {"class": "user_raised"}}],
     "steps": [
      {"call": "usp_place_order", "params": {"CustomerID": "<<cid", "ProductID": "<<pid", "Qty": "<<qty"},
       "expect": {"result_sets": [{"rows": [{"qty": "<<qty", "total": "<<total"}]}]}}
    ]},
    {"id": "missing_customer", "use": ["base"], "steps": [
      {"call": "usp_place_order", "params": {"CustomerID": 999999, "ProductID": "<<pid", "Qty": 1}, "expect_error": {"class": "user_raised"}}
    ]},
    {"id": "adjust_credit", "use": ["base"], "steps": [
      {"call": "usp_adjust_credit", "params": {"CustomerID": "<<cid", "Delta": "12.5", "NewBalance": ">>bal"},
       "expect": {"out": {"NewBalance": "112.50"}, "effects": {"customers": {"updated": [{"after": {"customer_id": "<<cid", "credit": "112.50"}}]}}}},
      {"query": "SELECT credit FROM customers WHERE customer_id = @cid", "expect": [{"credit": "<<bal"}]}
    ]},
    {"id": "skipped_one", "skip": "not now", "steps": [{"sql": "SELECT 1"}]}
  ]
}"#;

fn cfg(kind: DbKind, port: u16, user: &str, pass: &str, db: Option<&str>, id: &str) -> ConnectionConfig {
    let mut options = BTreeMap::new();
    if kind == DbKind::Mssql {
        options.insert("trust_server_certificate".to_string(), "true".to_string());
    }
    ConnectionConfig {
        id: id.into(),
        name: id.into(),
        kind,
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
        password: pass.into(),
        database: db.map(|s| s.to_string()),
        max_connections: 4,
        ssh_enabled: false,
        ssh_host: String::new(),
        ssh_port: 0,
        ssh_username: String::new(),
        ssh_auth_method: SshAuthMethod::Password,
        ssh_password: String::new(),
        ssh_private_key_path: String::new(),
        ssh_passphrase: String::new(),
        options,
        otp_secret: String::new(),
    }
}

async fn connect_retry(mgr: &ConnectionManager, c: &ConnectionConfig) {
    for i in 0..90 {
        match mgr.connect(c.clone()).await {
            Ok(()) => return,
            Err(e) => {
                if i == 89 {
                    panic!("連線失敗 {}：{e:?}", c.id);
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }
}

/// 去掉 `--` 整行註解後以 `term` 切句。
fn split_sql(sql: &str, term: &str) -> Vec<String> {
    let body: String = sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n");
    body.split(term).map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| s.to_string()).collect()
}

fn mssql_batches(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in sql.lines() {
        if line.trim().eq_ignore_ascii_case("GO") {
            if !cur.trim().is_empty() {
                out.push(cur.trim().to_string());
            }
            cur.clear();
        } else if !line.trim_start().starts_with("--") {
            cur.push_str(line);
            cur.push('\n');
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

async fn exec_all(mgr: &ConnectionManager, id: &str, stmts: &[String]) {
    for s in stmts {
        mgr.exec_ddl(id, s).await.unwrap_or_else(|e| panic!("{id}: {e:?}\n{s}"));
    }
}

/// 連三個引擎並重建樣本庫。回（mgr, [mssql, pg, mysql] 的 EngineRef）。
async fn setup() -> (ConnectionManager, Vec<EngineRef>) {
    let mgr = ConnectionManager::new();
    // MSSQL：先連 master 建庫，再以 sptest 為預設庫連第二條（USE 不能跨池化連線）。
    let master = cfg(DbKind::Mssql, 11435, "sa", "Test1234!", None, "sp-ms-master");
    connect_retry(&mgr, &master).await;
    mgr.exec_ddl("sp-ms-master", "IF DB_ID('sptest') IS NULL CREATE DATABASE sptest").await.unwrap();
    let ms = cfg(DbKind::Mssql, 11435, "sa", "Test1234!", Some("sptest"), "sp-ms");
    connect_retry(&mgr, &ms).await;
    let batches: Vec<String> = mssql_batches(MSSQL_SCHEMA)
        .into_iter()
        .chain(mssql_batches(MSSQL_ROUTINES))
        .filter(|b| !b.to_ascii_uppercase().starts_with("IF DB_ID") && !b.to_ascii_uppercase().starts_with("USE "))
        .collect();
    exec_all(&mgr, "sp-ms", &batches).await;

    let pg = cfg(DbKind::Postgres, 15433, "postgres", "test1234", Some("postgres"), "sp-pg");
    connect_retry(&mgr, &pg).await;
    exec_all(&mgr, "sp-pg", &split_sql(PG_SCHEMA, ";\n")).await;
    let routines: Vec<String> = split_sql(PG_ROUTINES, "$$;").into_iter().map(|s| format!("{s} $$")).collect();
    exec_all(&mgr, "sp-pg", &routines).await;

    let my = cfg(DbKind::Mysql, 13307, "root", "test1234", None, "sp-my");
    connect_retry(&mgr, &my).await;
    exec_all(&mgr, "sp-my", &split_sql(MY_SCHEMA, ";\n")).await;
    // `DELIMITER $$` 之前是逐句的 USE / DROP；之後到 `DELIMITER ;` 是以 `$$` 結尾的程序本體（本體內有 `;`，不能再切）。
    // 先去註解行（檔頭註解裡就寫著「DELIMITER $$」字樣，不先去掉會切在註解上）。
    let body: String = MY_ROUTINES.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n");
    let (head, tail) = body.split_once("DELIMITER $$").expect("routines.sql 應有 DELIMITER $$");
    let tail = tail.split("DELIMITER ;").next().unwrap_or("");
    let mut stmts: Vec<String> = split_sql(head, ";\n").into_iter().filter(|s| !s.to_ascii_uppercase().starts_with("USE ")).collect();
    for chunk in tail.split("$$") {
        if !chunk.trim().is_empty() {
            stmts.push(chunk.trim().to_string());
        }
    }
    exec_all(&mgr, "sp-my", &stmts).await;

    let targets = vec![
        EngineRef { conn_id: "sp-ms".into(), database: "sptest".into() },
        EngineRef { conn_id: "sp-pg".into(), database: "sptest".into() },
        EngineRef { conn_id: "sp-my".into(), database: "sptest".into() },
    ];
    (mgr, targets)
}

fn suite() -> TestFile {
    serde_json::from_str(SUITE).unwrap()
}

async fn counts(mgr: &ConnectionManager, t: &EngineRef) -> Vec<i64> {
    let kind = mgr.kind(&t.conn_id).unwrap();
    let mut out = Vec::new();
    for table in ["customers", "products", "orders"] {
        let q = match kind {
            DbKind::Mssql => format!("SELECT COUNT(*) FROM [sptest].[dbo].[{table}]"),
            _ => format!("SELECT COUNT(*) FROM sptest.{table}"),
        };
        let r = mgr.query_capped(&t.conn_id, &q, 1).await.unwrap();
        out.push(r.rows[0][0].clone().unwrap().parse().unwrap());
    }
    out
}

fn noop(_: super::Progress) {}

// ---------------------------------------------------------------------------
// r1：會話層——語句出錯後下一句仍可跑、交易仍開、收場乾淨。
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn session_recovers_after_statement_error() {
    let (mgr, targets) = setup().await;
    for t in &targets {
        let kind = mgr.kind(&t.conn_id).unwrap();
        let mut s = session::open(&mgr, &t.conn_id).await.unwrap();
        for stmt in super::render::open_stmts(kind, &t.database, &Default::default()) {
            assert!(s.batch(&stmt, 0).await.error.is_none(), "{kind:?} open: {stmt}");
        }
        assert!(s.batch(&super::render::savepoint_stmt(kind, "s1"), 0).await.error.is_none());
        let ins = match kind {
            DbKind::Mssql => "INSERT INTO dbo.customers (name) VALUES (N'tmp')",
            _ => "INSERT INTO customers (name) VALUES ('tmp')",
        };
        assert!(s.batch(ins, 0).await.error.is_none(), "{kind:?} insert");
        // 出錯
        let bad = s.batch("SELECT * FROM no_such_table_xyz", 0).await;
        let err = bad.error.expect("應該出錯");
        let class = super::errclass::classify(kind, err.number, err.sqlstate.as_deref());
        assert_eq!(class, super::errclass::ErrorClass::NotFound, "{kind:?}: {err:?}");
        // 回到 savepoint 後連線仍可用、交易仍開
        assert!(s.batch(&super::render::rollback_to_stmt(kind, "s1"), 0).await.error.is_none(), "{kind:?} rollback to");
        let ok = s.batch("SELECT 1 AS x", 0).await;
        assert!(ok.error.is_none(), "{kind:?} after error: {:?}", ok.error);
        assert_eq!(ok.sets.iter().find(|r| !r.rows.is_empty()).unwrap().rows[0][0].as_deref(), Some("1"));
        if kind == DbKind::Mssql {
            let st = s.batch("SELECT @@TRANCOUNT AS tc", 0).await;
            assert_eq!(st.sets.iter().find(|r| !r.rows.is_empty()).unwrap().rows[0][0].as_deref(), Some("1"));
        }
        // MSSQL 的 call batch：出錯後仍回部分結果集
        if kind == DbKind::Mssql {
            let r = s.batch("SELECT N'__dbk_begin' AS __dbk_marker; SELECT 7 AS a; SELECT * FROM no_such_table_xyz; SELECT 8 AS b;", 0).await;
            assert!(r.error.is_some());
            assert!(r.sets.iter().any(|x| x.columns == vec!["a".to_string()]), "{:?}", r.sets);
            assert!(!r.sets.iter().any(|x| x.columns == vec!["b".to_string()]));
            assert!(s.batch("SELECT 1 AS x", 0).await.error.is_none());
        }
        // MySQL：CALL 的多結果集 + OUT
        if matches!(kind, DbKind::Mysql) {
            let r = s.batch("CALL sptest.usp_two_sets(1)", 0).await;
            assert!(r.error.is_none(), "{:?}", r.error);
            assert_eq!(r.sets.len(), 2, "{:?}", r.sets);
            assert!(s.batch("SET @__o = NULL", 0).await.error.is_none());
        }
        assert!(s.batch(super::render::close_stmt(kind), 0).await.error.is_none());
        drop(s);
        let n = counts(&mgr, t).await;
        assert_eq!(n[0], 0, "{kind:?} 應已 rollback");
    }
}

// ---------------------------------------------------------------------------
// a / a2 / d / e / f：同一份情境在三引擎各自 assert 通過；跑完三表計數不變。
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn suite_passes_on_every_engine() {
    let (mgr, targets) = setup().await;
    let file = suite();
    for t in &targets {
        let before = counts(&mgr, t).await;
        let rep = run_file(&mgr, "it-a", std::slice::from_ref(t), &file, "usp_place_order.json", &RunOptions::default(), &noop).await.unwrap();
        for s in &rep.scenarios {
            let diffs: Vec<_> = s.steps.iter().flat_map(|st| st.differences.iter()).collect();
            assert!(
                matches!(s.verdict, Verdict::Pass | Verdict::Skipped),
                "{} / {}: {:?} err={:?} diffs={:#?}",
                t.conn_id,
                s.display_name(),
                s.verdict,
                s.error,
                diffs
            );
        }
        assert_eq!(rep.scenarios.len(), 6, "{}: cases 應展開成 6 筆", t.conn_id);
        assert_eq!(rep.scenarios.iter().filter(|s| s.verdict == Verdict::Skipped).count(), 1);
        assert_eq!(counts(&mgr, t).await, before, "{}: 跑完應 rollback 乾淨", t.conn_id);
        // 錯誤情境確實記錄了錯誤類別
        let mc = rep.scenarios.iter().find(|s| s.id == "missing_customer").unwrap();
        let oc = mc.steps[2].outcomes.values().next().unwrap();
        assert_eq!(oc.error.as_ref().unwrap().class, super::errclass::ErrorClass::UserRaised);
        // OUT 參數
        let ac = rep.scenarios.iter().find(|s| s.id == "adjust_credit").unwrap();
        let oc = ac.steps[2].outcomes.values().next().unwrap();
        assert!(oc.out.values().any(|v| v.as_deref().map(|x| x.starts_with("112.5")).unwrap_or(false)), "{:?}", oc.out);
    }
}

// ---------------------------------------------------------------------------
// 斷言失敗要被抓到（期望寫錯 → fail、未預期錯誤 → error）。
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn wrong_expectations_fail() {
    let (mgr, targets) = setup().await;
    let mut file = suite();
    file.scenarios.truncate(1);
    // 把 total 期望改錯
    let json = serde_json::to_string(&file).unwrap().replace("\"total\": \"25.00\"", "\"total\": \"26.00\"").replace("\"total\":\"25.00\"", "\"total\":\"26.00\"");
    let file: TestFile = serde_json::from_str(&json).unwrap();
    let rep = run_file(&mgr, "it-w", std::slice::from_ref(&targets[1]), &file, "x.json", &RunOptions::default(), &noop).await.unwrap();
    assert_eq!(rep.scenarios[0].verdict, Verdict::Fail);
    let kinds: Vec<&str> = rep.scenarios[0].steps[2].differences.iter().map(|d| d.kind.as_str()).collect();
    assert!(kinds.contains(&"cell"), "{kinds:?}");
    // 未預期錯誤：呼叫不存在的客戶但沒寫 expect_error
    let f2: TestFile = serde_json::from_str(
        r#"{"version": 1, "target": {"kind": "mysql", "database": "sptest"},
            "scenarios": [{"id": "boom", "steps": [{"insert": "products", "rows": [{"product_id": ">>pid", "name": "P", "price": "1", "stock": 1}]},
                                                  {"call": "usp_place_order", "params": {"CustomerID": 1, "ProductID": "<<pid", "Qty": 1}},
                                                  {"sql": "SELECT 1"}]}]}"#,
    )
    .unwrap();
    let rep = run_file(&mgr, "it-w2", std::slice::from_ref(&targets[2]), &f2, "y.json", &RunOptions::default(), &noop).await.unwrap();
    assert_eq!(rep.scenarios[0].verdict, Verdict::Error, "{:?}", rep.scenarios[0]);
    assert_eq!(rep.scenarios[0].steps.len(), 2, "出錯後不應再跑後面的步驟");
}

// ---------------------------------------------------------------------------
// b：record → golden 通過；基線被改 → fail 並定位。
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn golden_roundtrip_detects_drift() {
    let (mgr, targets) = setup().await;
    let file = suite();
    let dir = std::env::temp_dir().join(format!("dbkit-sptest-golden-{}", std::process::id()));
    let opts = RunOptions { mode: ExecMode::Record, golden_dir: Some(dir.clone()), ..Default::default() };
    let rep = run_file(&mgr, "it-g1", std::slice::from_ref(&targets[0]), &file, "usp_place_order.json", &opts, &noop).await.unwrap();
    assert!(rep.all_green(), "{:?}", rep.scenarios.iter().map(|s| (s.display_name(), s.verdict, s.error.clone())).collect::<Vec<_>>());
    let path = super::report::golden_path(&dir, "mssql", "usp_place_order", "place_then_cancel", None);
    assert!(path.exists(), "{}", path.display());
    let opts = RunOptions { mode: ExecMode::Golden, golden_dir: Some(dir.clone()), ..Default::default() };
    let rep = run_file(&mgr, "it-g2", std::slice::from_ref(&targets[0]), &file, "usp_place_order.json", &opts, &noop).await.unwrap();
    assert!(rep.all_green(), "{:?}", rep.scenarios.iter().map(|s| (s.display_name(), s.verdict, s.error.clone(), s.steps.iter().flat_map(|st| st.differences.clone()).collect::<Vec<_>>())).collect::<Vec<_>>());
    // 竄改基線：把 25.00 改成 20.00
    let text = std::fs::read_to_string(&path).unwrap().replace("25.00", "20.00");
    std::fs::write(&path, text).unwrap();
    let rep = run_file(&mgr, "it-g3", std::slice::from_ref(&targets[0]), &file, "usp_place_order.json", &opts, &noop).await.unwrap();
    let s = rep.scenarios.iter().find(|s| s.id == "place_then_cancel").unwrap();
    assert_eq!(s.verdict, Verdict::Fail);
    assert!(s.steps[2].differences.iter().any(|d| d.kind.starts_with("golden:")), "{:?}", s.steps[2].differences);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// c / d：diff——正確版 pass（identity / created_at 不同仍通過）、錯誤版 mismatch 指到 products。
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn diff_good_passes_and_bad_mismatches() {
    let (mgr, targets) = setup().await;
    let file = suite();
    let opts = RunOptions { mode: ExecMode::Diff, ..Default::default() };
    for pair in [[0usize, 1], [2, 1]] {
        let ts = vec![targets[pair[0]].clone(), targets[pair[1]].clone()];
        let rep = run_file(&mgr, "it-d1", &ts, &file, "usp_place_order.json", &opts, &noop).await.unwrap();
        for s in &rep.scenarios {
            assert!(
                matches!(s.verdict, Verdict::Pass | Verdict::Skipped | Verdict::BothError),
                "{:?}: {} {:?} err={:?} {:#?}",
                rep.targets,
                s.display_name(),
                s.verdict,
                s.error,
                s.steps.iter().flat_map(|st| st.differences.clone()).collect::<Vec<_>>()
            );
        }
        let mc = rep.scenarios.iter().find(|s| s.id == "missing_customer").unwrap();
        assert_eq!(mc.verdict, Verdict::BothError, "{:?}", mc);
    }
    // PG 用漏掉庫存扣減的版本
    let mut bad = suite();
    bad.routines = vec![super::model::TableMap { name: "usp_place_order".into(), pg: Some("usp_place_order_bad".into()), ..Default::default() }];
    bad.scenarios.retain(|s| s.id == "place_then_cancel");
    let ts = vec![targets[0].clone(), targets[1].clone()];
    let rep = run_file(&mgr, "it-d2", &ts, &bad, "usp_place_order.json", &opts, &noop).await.unwrap();
    let s = &rep.scenarios[0];
    assert!(matches!(s.verdict, Verdict::Fail | Verdict::Mismatch), "{:?} {:?}", s.verdict, s.error);
    let all: Vec<_> = s.steps.iter().flat_map(|st| st.differences.iter()).collect();
    assert!(all.iter().any(|d| d.location.contains("products")), "{all:#?}");
}

// ---------------------------------------------------------------------------
// g：盤點——寫入目標與簽名。
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn inspect_finds_write_targets_and_signature() {
    let (mgr, targets) = setup().await;
    for t in &targets {
        let kind = mgr.kind(&t.conn_id).unwrap();
        let w = super::inspect::write_targets(&mgr, &t.conn_id, kind, &t.database, "usp_place_order").await.unwrap();
        let lower: Vec<String> = w.iter().map(|s| s.to_ascii_lowercase()).collect();
        assert!(lower.iter().any(|s| s.ends_with("orders")) && lower.iter().any(|s| s.ends_with("products")), "{kind:?}: {w:?}");
        let sig = super::inspect::routine_sig(&mgr, &t.conn_id, kind, &t.database, "usp_adjust_credit").await.unwrap();
        assert_eq!(sig.params.len(), 3, "{kind:?}: {sig:?}");
        assert!(sig.params[2].mode.is_output(), "{kind:?}: {sig:?}");
        assert!(sig.find_param("NewBalance").is_some());
        let f = super::inspect::routine_sig(&mgr, &t.conn_id, kind, &t.database, "usp_place_order").await.unwrap();
        if kind == DbKind::Postgres {
            assert_eq!(f.kind, super::inspect::RoutineKind::Function);
            assert!(f.returns_set);
            assert_eq!(f.params.len(), 3, "{f:?}");
        }
    }
}

// ---------------------------------------------------------------------------
// h：JUnit。
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn junit_has_one_testcase_per_expanded_scenario() {
    let (mgr, targets) = setup().await;
    let file = suite();
    let rep = run_file(&mgr, "it-j", std::slice::from_ref(&targets[1]), &file, "usp_place_order.json", &RunOptions::default(), &noop).await.unwrap();
    let xml = super::report::to_junit(std::slice::from_ref(&rep));
    assert_eq!(xml.matches("<testcase ").count(), 6);
    assert!(xml.contains("name=\"qty_cases/zero\""));
    assert!(xml.contains("<skipped"));
    assert!(xml.contains("tests=\"6\""));
}
