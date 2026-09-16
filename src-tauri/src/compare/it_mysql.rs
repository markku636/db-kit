//! MySQL 8.4 真實伺服器的比對深度驗證（所有物件皆以 `cmpa_` 前綴，與其他代理共用容器）。
//!
//! 這裡補的是 CLI 煙霧測試碰不到的深水區：索引 / 外鍵 / 視圖 / 程序 / 觸發器、欄位屬性
//! （預設值、註解、AUTO_INCREMENT、ON UPDATE）、DiffOptions 的三個開關、整庫資料比對的
//! 略過與套用、以及跨兩頁（>4500 列）的分頁。
//!
//! 最強的正確性檢查是**冪等**：擷取 → 差異 → 產生 → 套用 → 再擷取再差異必須為空 / 全零。
//! 每個測試自行 DROP + CREATE 自己的資料庫，重跑才具決定性。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::compare::{data, ddl, diff, schema, snapshot};
use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::manager::ConnectionManager;

fn no_cmp_progress(_: crate::compare::CompareProgress) {}

/// ConnectionConfig 無 Default，逐欄建構（同 it_tests::cfg）。
fn my_cfg(id: &str, db: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: id.into(),
        name: id.into(),
        kind: DbKind::Mysql,
        host: "127.0.0.1".into(),
        port: 13306,
        username: "root".into(),
        password: "test1234".into(),
        database: Some(db.into()),
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

/// 容器剛起時連不上屬正常，重試到逾時才視為失敗。
async fn connect(mgr: &ConnectionManager, id: &str, db: &str) {
    for i in 0..60 {
        match mgr.connect(my_cfg(id, db)).await {
            Ok(()) => return,
            Err(e) => {
                if i == 59 {
                    panic!("MySQL 連線失敗：{e:?}");
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

/// 重建測試資料庫；DROP 在前，重跑才不受上一輪殘留影響。
async fn fresh_dbs(tag: &str, dbs: &[&str]) -> ConnectionManager {
    let mgr = ConnectionManager::new();
    let boot = format!("cmpa-boot-{tag}");
    connect(&mgr, &boot, "testdb").await;
    for db in dbs {
        mgr.exec_ddl(&boot, &format!("DROP DATABASE IF EXISTS `{db}`")).await.unwrap();
        mgr.exec_ddl(&boot, &format!("CREATE DATABASE `{db}` DEFAULT CHARACTER SET utf8mb4")).await.unwrap();
    }
    mgr.disconnect(&boot).await;
    mgr
}

/// 收尾：共用伺服器，測完就把自己的資料庫清掉。
async fn drop_dbs(mgr: &ConnectionManager, tag: &str, dbs: &[&str]) {
    let boot = format!("cmpa-clean-{tag}");
    connect(mgr, &boot, "testdb").await;
    for db in dbs {
        let _ = mgr.exec_ddl(&boot, &format!("DROP DATABASE IF EXISTS `{db}`")).await;
    }
    mgr.disconnect(&boot).await;
}

async fn ddl_all(mgr: &ConnectionManager, id: &str, stmts: &[&str]) {
    for s in stmts {
        mgr.exec_ddl(id, s).await.unwrap_or_else(|e| panic!("前置 DDL 失敗：{s}\n{e}"));
    }
}

/// 父表：複合外鍵需要被參照側有涵蓋 (id, code) 的唯一索引。
const PARENT_DDL: &str = "CREATE TABLE cmpa_parent (\
  id INT NOT NULL AUTO_INCREMENT, code VARCHAR(20) NOT NULL, \
  PRIMARY KEY (id), UNIQUE KEY uk_parent_ref (id, code)\
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";

// ---------------------------------------------------------------------------
// 1 + 2：結構深度冪等 + 快照往返
// ---------------------------------------------------------------------------

/// 結構：各式預設值 / 中文註解 / AUTO_INCREMENT / 次要索引 / 唯一索引 / 複合外鍵 /
/// 視圖 / 程序 / 觸發器全上；目標在欄位、索引、外鍵、視圖、程序各缺一角。
/// 擷取 → 差異（逐項斷言）→ 產生 → 套用 → 再差異必須為空。
#[tokio::test]
#[ignore = "需要 Docker MySQL:13306"]
async fn cmpa_schema_deep_sync_is_idempotent() {
    const SRC: &str = "cmpa_src";
    const DST: &str = "cmpa_dst";
    let mgr = fresh_dbs("schema", &[SRC, DST]).await;
    connect(&mgr, "cmpa-src", SRC).await;
    connect(&mgr, "cmpa-dst", DST).await;

    // 來源：note 刻意放在最後一欄——MySQL 的 ADD COLUMN 一律追加到尾端，欄序才對得起來。
    // fk_child_parent 這個索引也刻意先於 ix_qty 宣告：SHOW CREATE TABLE 依建立序列出索引，
    // 而同步是按索引名排序建立（fk_ < ix_），順序一致，原始 DDL 才會逐字相同。
    ddl_all(
        &mgr,
        "cmpa-src",
        &[
            PARENT_DDL,
            "CREATE TABLE cmpa_child (\
               id INT NOT NULL AUTO_INCREMENT, \
               pid INT NOT NULL, \
               pcode VARCHAR(20) NOT NULL, \
               name VARCHAR(50) NOT NULL DEFAULT 'abc' COMMENT '名稱欄位', \
               qty BIGINT NOT NULL DEFAULT 0, \
               created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \
               note VARCHAR(100) NULL, \
               PRIMARY KEY (id), \
               UNIQUE KEY uk_child_name (name), \
               KEY fk_child_parent (pid, pcode), \
               KEY ix_qty (qty), \
               CONSTRAINT fk_child_parent FOREIGN KEY (pid, pcode) REFERENCES cmpa_parent (id, code)\
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE cmpa_only_src (\
               id INT NOT NULL AUTO_INCREMENT, v VARCHAR(10) NULL, PRIMARY KEY (id)\
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE VIEW cmpa_v AS SELECT id, name FROM cmpa_child WHERE qty > 0",
            // 程序本體寫成單行：套用時整句直送，不可切在 `;` 上。
            "CREATE PROCEDURE cmpa_sp(IN n INT) BEGIN SELECT n + 1; END",
            "CREATE TRIGGER cmpa_trg BEFORE INSERT ON cmpa_child FOR EACH ROW SET NEW.qty = NEW.qty + 1",
        ],
    )
    .await;

    // 目標：缺 note、多 legacy、qty int（來源 bigint）、name 可空 / 預設 / 註解 / 長度皆不同、
    // 缺 ix_qty 與外鍵（及其索引）、多 ix_legacy、視圖本體不同、程序本體不同、多一支程序。
    ddl_all(
        &mgr,
        "cmpa-dst",
        &[
            PARENT_DDL,
            "CREATE TABLE cmpa_child (\
               id INT NOT NULL AUTO_INCREMENT, \
               pid INT NOT NULL, \
               pcode VARCHAR(20) NOT NULL, \
               name VARCHAR(80) NULL DEFAULT 'xyz' COMMENT '舊名稱', \
               qty INT NOT NULL DEFAULT 0, \
               created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \
               legacy VARCHAR(10) NULL, \
               PRIMARY KEY (id), \
               UNIQUE KEY uk_child_name (name), \
               KEY ix_legacy (legacy)\
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE cmpa_only_dst (\
               id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)\
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE VIEW cmpa_v AS SELECT id, name FROM cmpa_child WHERE qty > 100",
            "CREATE PROCEDURE cmpa_sp(IN n INT) BEGIN SELECT n + 2; END",
            "CREATE PROCEDURE cmpa_sp_gone() BEGIN SELECT 0; END",
        ],
    )
    .await;

    let copts = schema::CaptureOptions::default();
    let sa = schema::capture(&mgr, "cmpa-src", SRC, "src", &copts, None).await.unwrap();
    let sb = schema::capture(&mgr, "cmpa-dst", DST, "dst", &copts, None).await.unwrap();
    assert_eq!(sa.tables.len(), 3, "{:?}", sa.tables.iter().map(|t| &t.name).collect::<Vec<_>>());
    assert_eq!(sa.views.len(), 1);
    assert!(sa.warnings.is_empty(), "擷取不應有警告：{:?}", sa.warnings);
    // AUTO_INCREMENT 走 extra 欄位；中文註解要原樣帶回（utf8mb4 解碼）。
    let child = sa.table("cmpa_child").unwrap();
    let byname = |t: &schema::TableSchema, n: &str| t.columns.iter().find(|c| c.name == n).cloned().unwrap();
    assert!(byname(child, "id").extra.to_ascii_lowercase().contains("auto_increment"));
    assert_eq!(byname(child, "name").comment, "名稱欄位");
    assert_eq!(byname(child, "name").default.as_deref(), Some("abc"));
    assert_eq!(byname(child, "created").default.as_deref(), Some("CURRENT_TIMESTAMP"));
    // MySQL 8.4 已不回整數顯示寬度。
    assert_eq!(byname(child, "qty").data_type, "bigint");

    // ---- 差異：逐項斷言 ----
    let d = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    assert!(!d.cross_engine);
    assert_eq!(d.tables_added, vec!["cmpa_only_src"]);
    assert_eq!(d.tables_removed, vec!["cmpa_only_dst"]);
    assert_eq!(d.tables_identical, vec!["cmpa_parent"], "父表兩側相同");
    assert_eq!(d.tables_changed.len(), 1);
    let td = &d.tables_changed[0];
    assert_eq!(td.name, "cmpa_child");
    assert_eq!(td.columns_added.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["note"]);
    assert_eq!(td.columns_removed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["legacy"]);
    let cc = |n: &str| td.columns_changed.iter().find(|c| c.name == n).unwrap_or_else(|| panic!("缺欄位變更 {n}"));
    use diff::ColumnAttr::*;
    // attrs 必須「剛好」列出不同的屬性：name 四項全差、qty 只差型別。
    assert_eq!(cc("name").attrs, vec![DataType, Nullable, Default, Comment]);
    assert_eq!(cc("qty").attrs, vec![DataType]);
    assert_eq!(td.columns_changed.len(), 2, "created 兩側相同不應入列：{:?}", td.columns_changed.iter().map(|c| &c.name).collect::<Vec<_>>());
    assert_eq!(
        td.indexes_added.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
        vec!["fk_child_parent", "ix_qty"]
    );
    assert_eq!(td.indexes_removed.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["ix_legacy"]);
    assert!(td.indexes_changed.is_empty(), "唯一索引 uk_child_name 兩側同定義");
    assert_eq!(td.fks_added.len(), 1);
    assert_eq!(td.fks_added[0].name, "fk_child_parent");
    assert_eq!(td.fks_added[0].columns, vec!["pid", "pcode"], "複合外鍵須摺疊成一筆");
    assert_eq!(td.fks_added[0].ref_columns, vec!["id", "code"]);
    assert_eq!(td.fks_added[0].ref_table, "cmpa_parent");
    assert_eq!(d.views_changed.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), vec!["cmpa_v"]);
    assert_eq!(
        d.routines_added.iter().map(|r| (r.name.as_str(), r.routine_type.as_deref().unwrap_or(""))).collect::<Vec<_>>(),
        vec![("cmpa_trg", "trigger")]
    );
    assert_eq!(d.routines_removed.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["cmpa_sp_gone"]);
    assert_eq!(d.routines_changed.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["cmpa_sp"]);

    // ---- 2：快照往返 ----
    let snap = std::env::temp_dir().join(format!("cmpa_snap_{}.json", std::process::id()));
    let info = snapshot::save(&snap, &sa).await.unwrap();
    assert!(info.bytes > 0 && info.tables == 3 && info.views == 1);
    let loaded = snapshot::load(&snap).await.unwrap().schema;
    assert!(
        diff::diff(&sa, &loaded, &diff::DiffOptions::default()).is_empty(),
        "快照載回應與即時擷取零差異"
    );
    tokio::fs::write(&snap, b"{ not json").await.unwrap();
    assert!(snapshot::load(&snap).await.is_err(), "壞快照必須大聲失敗");
    let _ = std::fs::remove_file(&snap);

    // ---- 產生並套用 ----
    let sync = ddl::SyncOptions {
        include_drops: true,
        include_indexes: true,
        include_fks: true,
        include_views: true,
        include_routines: true,
    };
    let script = ddl::generate(&d, &sa, &sb, &sync).unwrap();
    assert!(script.skipped.is_empty(), "此案例全部可表達：{:?}", script.skipped);
    assert!(script.destructive_count > 0);
    assert!(script.statements.iter().any(|s| s.kind == ddl::SyncKind::DropTable && s.destructive));
    // MySQL 的視圖同步只有一句（SQLite 才會 DROP+CREATE 兩句）；而程序本體本來就含 `;`，
    // 若比照 SQLite 切 ";\n" 反而會把 CREATE PROCEDURE 切碎，故整句直送。
    for s in &script.statements {
        mgr.exec_ddl("cmpa-dst", &s.sql).await.unwrap_or_else(|e| panic!("套用失敗：{}\n{e}", s.sql));
    }

    let sb2 = schema::capture(&mgr, "cmpa-dst", DST, "dst", &copts, None).await.unwrap();
    let d2 = diff::diff(&sa, &sb2, &diff::DiffOptions::default());
    if !d2.is_empty() {
        for t in &d2.tables_changed {
            let s_ddl = sa.table(&t.name).and_then(|x| x.ddl.clone()).unwrap_or_default();
            let d_ddl = sb2.table(&t.name).and_then(|x| x.ddl.clone()).unwrap_or_default();
            panic!(
                "同步後仍有差異：表 {} ddl_differs={} 欄增{:?} 欄減{:?} 欄改{:?} 索增{:?} 索減{:?}\n--- src ---\n{s_ddl}\n--- dst ---\n{d_ddl}",
                t.name,
                t.ddl_differs,
                t.columns_added.iter().map(|c| &c.name).collect::<Vec<_>>(),
                t.columns_removed.iter().map(|c| &c.name).collect::<Vec<_>>(),
                t.columns_changed.iter().map(|c| (&c.name, &c.attrs)).collect::<Vec<_>>(),
                t.indexes_added.iter().map(|i| &i.name).collect::<Vec<_>>(),
                t.indexes_removed.iter().map(|i| &i.name).collect::<Vec<_>>(),
            );
        }
        panic!(
            "同步後仍有差異：{:?} 視圖改{:?} 程序增{:?} 減{:?} 改{:?}",
            d2.summary,
            d2.views_changed.iter().map(|v| &v.name).collect::<Vec<_>>(),
            d2.routines_added.iter().map(|r| &r.name).collect::<Vec<_>>(),
            d2.routines_removed.iter().map(|r| &r.name).collect::<Vec<_>>(),
            d2.routines_changed.iter().map(|r| &r.name).collect::<Vec<_>>(),
        );
    }

    // 再跑一次產生：零差異 → 零語句（真正的冪等）。
    let script2 = ddl::generate(&d2, &sa, &sb2, &sync).unwrap();
    assert!(script2.statements.is_empty() && script2.skipped.is_empty());

    // MySQL 只在「連線的預設資料庫 != 視圖所屬資料庫」時把庫名寫進 SHOW CREATE VIEW；
    // 擷取端已用 schema::strip_db_qualifier 把 `db`. 剝掉，定義文字因此與「從哪條連線擷取」無關。
    // 此刻 cmpa_src / cmpa_dst 的視圖已完全一致，換一條 default database 不同的連線擷取仍須判為相同。
    connect(&mgr, "cmpa-neutral", "testdb").await;
    let na = schema::capture(&mgr, "cmpa-neutral", SRC, "n-src", &copts, None).await.unwrap();
    let nb = schema::capture(&mgr, "cmpa-neutral", DST, "n-dst", &copts, None).await.unwrap();
    assert!(
        !na.view("cmpa_v").unwrap().ddl.as_deref().unwrap().contains(&format!("`{SRC}`.")),
        "擷取時就不該留下來源庫限定名：{:?}",
        na.view("cmpa_v").and_then(|v| v.ddl.clone())
    );
    let dn = diff::diff(&na, &nb, &diff::DiffOptions::default());
    assert_eq!(
        dn.views_changed.len(),
        0,
        "同一個視圖不得因擷取連線的預設資料庫不同而被判為不同\nsrc={:?}\ndst={:?}",
        na.view("cmpa_v").and_then(|v| v.ddl.clone()),
        nb.view("cmpa_v").and_then(|v| v.ddl.clone())
    );
    assert!(dn.tables_changed.is_empty(), "表的 DDL 不受 default database 影響");
    // 產生的視圖 DDL 也不再指回來源庫：把目標視圖砍掉，改以第三方連線重新產生一次即可驗證。
    mgr.exec_ddl("cmpa-dst", "DROP VIEW cmpa_v").await.unwrap();
    let nb2 = schema::capture(&mgr, "cmpa-neutral", DST, "n-dst", &copts, None).await.unwrap();
    let dn2 = diff::diff(&na, &nb2, &diff::DiffOptions::default());
    assert_eq!(dn2.views_added, vec!["cmpa_v"]);
    let sn = ddl::generate(&dn2, &na, &nb2, &sync).unwrap();
    let vsql = sn
        .statements
        .iter()
        .find(|s| s.kind == ddl::SyncKind::CreateView)
        .map(|s| s.sql.clone())
        .expect("應產生 CREATE VIEW");
    assert!(vsql.contains(&format!("`{DST}`.`cmpa_v`")), "視圖名已限定到目標庫：{vsql}");
    assert!(!vsql.contains(&format!("`{SRC}`.")), "本體不得再指回來源庫：{vsql}");
    // 本體的表名未限定資料庫（語句的 note 也這麼提醒），要在目標庫的連線環境下執行。
    mgr.exec_ddl("cmpa-dst", &vsql).await.unwrap_or_else(|e| panic!("套用失敗：{vsql}\n{e}"));
    let nb3 = schema::capture(&mgr, "cmpa-neutral", DST, "n-dst", &copts, None).await.unwrap();
    assert!(
        diff::diff(&na, &nb3, &diff::DiffOptions::default()).views_changed.is_empty(),
        "重建後的視圖應與來源零差異：{:?}",
        nb3.view("cmpa_v").and_then(|v| v.ddl.clone())
    );

    mgr.disconnect("cmpa-src").await;
    mgr.disconnect("cmpa-dst").await;
    mgr.disconnect("cmpa-neutral").await;
    drop_dbs(&mgr, "schema", &[SRC, DST]).await;
}

// ---------------------------------------------------------------------------
// 3：DiffOptions 三個開關各自只抑制自己那一項
// ---------------------------------------------------------------------------

/// ignore_case / ignore_comments / ignore_defaults 必須只壓掉自己負責的差異；
/// 順便釘住 `extra` 對 ON UPDATE CURRENT_TIMESTAMP 的盲區。
#[tokio::test]
#[ignore = "需要 Docker MySQL:13306"]
async fn cmpa_diff_options_narrow_each_attribute() {
    const A: &str = "cmpa_opt_a";
    const B: &str = "cmpa_opt_b";
    let mgr = fresh_dbs("opt", &[A, B]).await;
    connect(&mgr, "cmpa-opt-a", A).await;
    connect(&mgr, "cmpa-opt-b", B).await;

    // 只差大小寫的表名（Linux 的 MySQL 表名區分大小寫）。
    ddl_all(
        &mgr,
        "cmpa-opt-a",
        &[
            "CREATE TABLE CmpaCase (id INT NOT NULL PRIMARY KEY, v VARCHAR(10) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE cmpa_attr (id INT NOT NULL PRIMARY KEY, v VARCHAR(10) NULL DEFAULT 'a' COMMENT '甲') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE cmpa_upd (id INT NOT NULL PRIMARY KEY, ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        ],
    )
    .await;
    ddl_all(
        &mgr,
        "cmpa-opt-b",
        &[
            "CREATE TABLE cmpacase (id INT NOT NULL PRIMARY KEY, v VARCHAR(10) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE cmpa_attr (id INT NOT NULL PRIMARY KEY, v VARCHAR(10) NULL DEFAULT 'b' COMMENT '乙') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE cmpa_upd (id INT NOT NULL PRIMARY KEY, ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        ],
    )
    .await;

    let copts = schema::CaptureOptions::default();
    let sa = schema::capture(&mgr, "cmpa-opt-a", A, "a", &copts, None).await.unwrap();
    let sb = schema::capture(&mgr, "cmpa-opt-b", B, "b", &copts, None).await.unwrap();

    let attrs_of = |d: &diff::SchemaDiff, t: &str| -> Vec<diff::ColumnAttr> {
        d.tables_changed
            .iter()
            .find(|x| x.name == t)
            .and_then(|x| x.columns_changed.iter().find(|c| c.name == "v"))
            .map(|c| c.attrs.clone())
            .unwrap_or_default()
    };
    use diff::ColumnAttr::*;

    let base = diff::DiffOptions::default();
    let d0 = diff::diff(&sa, &sb, &base);
    assert_eq!(d0.tables_added, vec!["CmpaCase"], "表名大小寫預設視為不同");
    assert_eq!(d0.tables_removed, vec!["cmpacase"]);
    assert_eq!(attrs_of(&d0, "cmpa_attr"), vec![Default, Comment]);

    // ignore_case：只把大小寫配對起來，欄位差異照舊。
    let d1 = diff::diff(&sa, &sb, &diff::DiffOptions { ignore_case: true, ..diff::DiffOptions::default() });
    assert!(d1.tables_added.is_empty() && d1.tables_removed.is_empty(), "大小寫應配對");
    assert!(d1.tables_identical.contains(&"CmpaCase".to_string()));
    assert_eq!(attrs_of(&d1, "cmpa_attr"), vec![Default, Comment], "ignore_case 不得順手壓掉欄位差異");

    // ignore_comments：只剩預設值。
    let d2 = diff::diff(&sa, &sb, &diff::DiffOptions { ignore_comments: true, ..diff::DiffOptions::default() });
    assert_eq!(attrs_of(&d2, "cmpa_attr"), vec![Default]);
    assert_eq!(d2.tables_added, vec!["CmpaCase"], "ignore_comments 不影響名稱比對");

    // ignore_defaults：只剩註解。
    let d3 = diff::diff(&sa, &sb, &diff::DiffOptions { ignore_defaults: true, ..diff::DiffOptions::default() });
    assert_eq!(attrs_of(&d3, "cmpa_attr"), vec![Comment]);
    assert_eq!(d3.tables_added, vec!["CmpaCase"]);

    // ON UPDATE CURRENT_TIMESTAMP 只存在於 EXTRA，而 normalize_extra 只認 auto_increment /
    // generated（刻意不放寬：DEFAULT_GENERATED 這類雜訊一放進來就會製造假差異），
    // 兩側 EXTRA（"DEFAULT_GENERATED on update CURRENT_TIMESTAMP" vs "DEFAULT_GENERATED"）
    // 因此被收斂成同一個空集合 → 結構化比對看不見這個差異，只剩原始 DDL 這條線索。
    let upd = d0.tables_changed.iter().find(|x| x.name == "cmpa_upd").expect("cmpa_upd 應因原始 DDL 不同而入列");
    assert!(upd.is_empty(), "結構化比對（欄位 / 索引 / 外鍵）看不見 ON UPDATE 差異");
    assert!(upd.ddl_differs, "只剩原始 DDL 這條線索");
    // 產不出補救語句是必然的，但「只有原始 DDL 不同」這一整類（字元集 / 儲存引擎 / 註解 /
    // ON UPDATE…）必須留下一筆 skipped，否則使用者會看到「同步完成」卻永遠不收斂。
    let sc = ddl::generate(
        &d0,
        &sa,
        &sb,
        &ddl::SyncOptions { include_drops: true, include_routines: true, ..ddl::SyncOptions::default() },
    )
    .unwrap();
    assert!(
        !sc.statements.iter().any(|s| s.object.starts_with("cmpa_upd")),
        "ON UPDATE 差異產不出語句"
    );
    let upd_skips: Vec<&String> = sc.skipped.iter().filter(|s| s.contains("cmpa_upd")).collect();
    assert_eq!(upd_skips.len(), 1, "只有原始 DDL 不同必須恰好留一筆 skipped：{:?}", sc.skipped);

    mgr.disconnect("cmpa-opt-a").await;
    mgr.disconnect("cmpa-opt-b").await;
    drop_dbs(&mgr, "opt", &[A, B]).await;
}

// ---------------------------------------------------------------------------
// 4：整庫資料比對
// ---------------------------------------------------------------------------

/// 整庫：預檢相同的表略過、無主鍵表略過、視圖完全不進表列、單側表列在 only_in_*；
/// 套用（含 DELETE）後再跑一次必須全零。
#[tokio::test]
#[ignore = "需要 Docker MySQL:13306"]
async fn cmpa_compare_database_skips_and_applies() {
    use data::{DataCompareOptions, DbCompareOptions, DbRef, RunMode, TableStatus};
    const A: &str = "cmpa_data_a";
    const B: &str = "cmpa_data_b";
    let mgr = fresh_dbs("data", &[A, B]).await;
    connect(&mgr, "cmpa-data-a", A).await;
    connect(&mgr, "cmpa-data-b", B).await;

    for id in ["cmpa-data-a", "cmpa-data-b"] {
        ddl_all(
            &mgr,
            id,
            &[
                "CREATE TABLE cmpa_same (id INT NOT NULL PRIMARY KEY, v VARCHAR(10) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE cmpa_diff (id INT NOT NULL PRIMARY KEY, v VARCHAR(10) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE cmpa_nopk (x INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE VIEW cmpa_vw AS SELECT id FROM cmpa_same",
            ],
        )
        .await;
        mgr.query(id, "INSERT INTO cmpa_same (id, v) VALUES (1,'x'),(2,'y'),(3,'z')").await.unwrap();
        mgr.query(id, "INSERT INTO cmpa_nopk (x) VALUES (1)").await.unwrap();
    }
    mgr.query("cmpa-data-a", "INSERT INTO cmpa_diff (id, v) VALUES (1,'a'),(2,'b'),(4,'d')").await.unwrap();
    mgr.query("cmpa-data-b", "INSERT INTO cmpa_diff (id, v) VALUES (1,'a'),(2,'B'),(3,'c')").await.unwrap();
    ddl_all(&mgr, "cmpa-data-a", &["CREATE TABLE cmpa_only_a (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB"]).await;
    ddl_all(&mgr, "cmpa-data-b", &["CREATE TABLE cmpa_only_b (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB"]).await;

    let s = DbRef { conn_id: "cmpa-data-a".into(), database: A.into() };
    let t = DbRef { conn_id: "cmpa-data-b".into(), database: B.into() };
    let report = |precheck: bool, mode: RunMode, tables: Option<Vec<String>>| DbCompareOptions {
        table: DataCompareOptions { mode, include_deletes: mode == RunMode::Apply, ..DataCompareOptions::default() },
        tables,
        precheck,
        precheck_only: false,
    };

    let r = data::compare_database(&mgr, "cmpa-db-1", &s, &t, &report(true, RunMode::Report, None), &no_cmp_progress)
        .await
        .unwrap();
    assert_eq!(r.only_in_src, vec!["cmpa_only_a"]);
    assert_eq!(r.only_in_dst, vec!["cmpa_only_b"]);
    assert!(r.tables.iter().all(|e| e.table != "cmpa_vw"), "視圖不得進入資料比對");
    let by = |n: &str| {
        r.tables.iter().find(|e| e.table == n).unwrap_or_else(|| {
            panic!("缺 {n}：{:?}", r.tables.iter().map(|e| &e.table).collect::<Vec<_>>())
        })
    };
    assert_eq!(by("cmpa_same").status, TableStatus::Skipped, "{:?}", by("cmpa_same").reason);
    assert!(by("cmpa_same").precheck.as_ref().unwrap().likely_identical);
    assert_eq!(by("cmpa_nopk").status, TableStatus::Skipped);
    assert!(by("cmpa_nopk").reason.is_some(), "略過必須附理由");
    assert!(by("cmpa_nopk").precheck.is_none(), "無主鍵連預檢都不做");
    assert_eq!(by("cmpa_diff").status, TableStatus::Compared);
    let sum = &by("cmpa_diff").report.as_ref().unwrap().summary;
    assert_eq!((sum.inserts, sum.updates, sum.deletes, sum.compared_rows), (1, 1, 1, 1), "{sum:?}");
    assert_eq!(sum.strategy_used, "merge_join");
    assert_eq!((r.totals.inserts, r.totals.updates, r.totals.deletes), (1, 1, 1));

    // options.tables 只限縮「要比的表」，單側表清單不受影響。
    let r2 = data::compare_database(
        &mgr,
        "cmpa-db-2",
        &s,
        &t,
        &report(false, RunMode::Report, Some(vec!["cmpa_diff".into()])),
        &no_cmp_progress,
    )
    .await
    .unwrap();
    assert_eq!(r2.tables.iter().map(|e| e.table.as_str()).collect::<Vec<_>>(), vec!["cmpa_diff"]);
    assert_eq!(r2.only_in_src, vec!["cmpa_only_a"]);

    // 套用（含 DELETE）。
    let r3 = data::compare_database(&mgr, "cmpa-db-3", &s, &t, &report(false, RunMode::Apply, None), &no_cmp_progress)
        .await
        .unwrap();
    let ap = r3.tables.iter().find(|e| e.table == "cmpa_diff").unwrap().report.as_ref().unwrap().apply.clone().unwrap();
    assert_eq!((ap.applied, ap.failed), (3, 0), "{:?}", ap.errors);
    assert!(ap.transactional);

    // 再跑一次：全零。
    let r4 = data::compare_database(&mgr, "cmpa-db-4", &s, &t, &report(false, RunMode::Report, None), &no_cmp_progress)
        .await
        .unwrap();
    assert_eq!((r4.totals.inserts, r4.totals.updates, r4.totals.deletes), (0, 0, 0), "套用後應零差異");
    let again = r4.tables.iter().find(|e| e.table == "cmpa_diff").unwrap().report.as_ref().unwrap();
    assert_eq!(again.summary.compared_rows, 3);

    mgr.disconnect("cmpa-data-a").await;
    mgr.disconnect("cmpa-data-b").await;
    drop_dbs(&mgr, "data", &[A, B]).await;
}

// ---------------------------------------------------------------------------
// 5：跨頁（>4500 列，超過兩頁）
// ---------------------------------------------------------------------------

/// 單一 INT 主鍵走 keyset 分頁（PAGE_SIZE=2000）：目標在中段與尾端各缺 100 列，
/// 計數要精確、策略要是 merge_join，且進度回呼看得到 src_rows 逐頁遞增。
#[tokio::test]
#[ignore = "需要 Docker MySQL:13306"]
async fn cmpa_paging_over_two_pages_exact_counts() {
    use data::{DataCompareOptions, TableRef};
    const A: &str = "cmpa_page_a";
    const B: &str = "cmpa_page_b";
    let mgr = fresh_dbs("page", &[A, B]).await;
    connect(&mgr, "cmpa-page-a", A).await;
    connect(&mgr, "cmpa-page-b", B).await;
    for id in ["cmpa-page-a", "cmpa-page-b"] {
        ddl_all(
            &mgr,
            id,
            &["CREATE TABLE cmpa_big (id INT NOT NULL PRIMARY KEY, v VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"],
        )
        .await;
    }
    let seed = |id: &'static str, ranges: Vec<(i32, i32)>| {
        let mgr = &mgr;
        async move {
            let mut vals: Vec<String> = Vec::new();
            for (lo, hi) in ranges {
                for i in lo..=hi {
                    vals.push(format!("({i},'v{i}')"));
                }
            }
            for chunk in vals.chunks(1000) {
                mgr.query(id, &format!("INSERT INTO cmpa_big (id, v) VALUES {}", chunk.join(","))).await.unwrap();
            }
        }
    };
    seed("cmpa-page-a", vec![(1, 4600)]).await;
    // 目標缺 2001..2100（中段）與 4501..4600（尾端）。
    seed("cmpa-page-b", vec![(1, 2000), (2101, 4500)]).await;

    let s = TableRef { conn_id: "cmpa-page-a".into(), database: A.into(), table: "cmpa_big".into() };
    let t = TableRef { conn_id: "cmpa-page-b".into(), database: B.into(), table: "cmpa_big".into() };

    let max_src = Arc::new(AtomicU64::new(0));
    let ticks = Arc::new(AtomicU64::new(0));
    let (ms, tk) = (max_src.clone(), ticks.clone());
    let cb = move |p: crate::compare::CompareProgress| {
        if p.phase == "scan" {
            tk.fetch_add(1, Ordering::Relaxed);
            ms.fetch_max(p.src_rows, Ordering::Relaxed);
        }
    };
    let r = data::compare_table(&mgr, "cmpa-page-1", &s, &t, &DataCompareOptions::default(), &cb).await.unwrap();
    assert_eq!(
        (r.summary.inserts, r.summary.updates, r.summary.deletes, r.summary.compared_rows),
        (200, 0, 0, 4400),
        "{:?}",
        r.summary
    );
    assert_eq!((r.summary.src_rows, r.summary.dst_rows), (4600, 4400));
    assert_eq!(r.summary.strategy_used, "merge_join");
    assert!(r.summary.truncated_reason.is_none() && !r.summary.deletes_suppressed);
    assert_eq!(max_src.load(Ordering::Relaxed), 4600);
    assert!(ticks.load(Ordering::Relaxed) > 4000, "每輪迴圈都回報，應遠多於頁數");

    mgr.disconnect("cmpa-page-a").await;
    mgr.disconnect("cmpa-page-b").await;
    drop_dbs(&mgr, "page", &[A, B]).await;
}
