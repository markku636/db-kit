//! SQL Server 結構比對的端到端整合測試（需兩台真實 SQL Server 2022）。
//!
//! 兩台**獨立**伺服器、一個 ConnectionManager：來源 `127.0.0.1:11433 / cmp_src`、
//! 目標 `127.0.0.1:11434 / cmp_dst`——這才逼得出「來源庫 != 目標庫」與三部式限定名的問題。
//! 以 `cargo test --lib compare::it_mssql -- --ignored --test-threads=1` 執行；
//! 四個測試共用同兩個資料庫，各自先 DROP 再 CREATE，順序執行下可重複跑。
//!
//! 正確性的判準與 SQLite 版一致：capture → diff → generate → 逐句 exec_ddl → 再 diff 必須為零。
#![cfg(test)]

use std::collections::BTreeMap;

use crate::compare::{ddl, diff, schema, snapshot};
use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::manager::ConnectionManager;

const SRC_DB: &str = "cmp_src";
const DST_DB: &str = "cmp_dst";

/// SQL Server 2022 預設要求加密，容器用自簽憑證 → 必須 trust_server_certificate。
fn mssql_cfg(id: &str, port: u16, database: &str) -> ConnectionConfig {
    let mut options = BTreeMap::new();
    options.insert("trust_server_certificate".to_string(), "true".to_string());
    ConnectionConfig {
        id: id.into(),
        name: id.into(),
        kind: DbKind::Mssql,
        host: "127.0.0.1".into(),
        port,
        username: "sa".into(),
        password: "Test1234!".into(),
        database: Some(database.to_string()),
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

/// 兩條連線（A=來源 11433 / B=目標 11434），並把兩庫重建成測試基準狀態。
async fn setup(tag: &str) -> (ConnectionManager, String, String) {
    let a = format!("mssql-{tag}-src");
    let b = format!("mssql-{tag}-dst");
    let mgr = ConnectionManager::new();
    mgr.connect(mssql_cfg(&a, 11433, SRC_DB)).await.expect("連線來源 11433");
    mgr.connect(mssql_cfg(&b, 11434, DST_DB)).await.expect("連線目標 11434");
    reset(&mgr, &a, SRC_SQL).await;
    reset(&mgr, &b, DST_SQL).await;
    (mgr, a, b)
}

/// 先清掉所有測試物件（含前一輪同步在目標上建出來的），再依序建立。
/// CREATE SCHEMA / VIEW / PROCEDURE / TRIGGER 都必須是批次第一句，所以逐句送。
async fn reset(mgr: &ConnectionManager, id: &str, script: &[&str]) {
    for sql in TEARDOWN_SQL.iter().chain(script.iter()) {
        mgr.exec_ddl(id, sql).await.unwrap_or_else(|e| panic!("{id} 準備失敗：{sql}\n{e}"));
    }
}

/// 拆表順序：先觸發器 / 視圖 / 程序，再 orders（帶外鍵）→ customers，最後單獨存在的表。
const TEARDOWN_SQL: &[&str] = &[
    "DROP TRIGGER IF EXISTS sales.tr_orders_touch",
    "DROP VIEW IF EXISTS sales.v_orders",
    "DROP PROCEDURE IF EXISTS dbo.sp_order_total",
    "DROP TABLE IF EXISTS sales.orders",
    "DROP TABLE IF EXISTS dbo.customers",
    "DROP TABLE IF EXISTS dbo.audit_log",
    "DROP TABLE IF EXISTS dbo.legacy_notes",
    "DROP TABLE IF EXISTS dbo.quirks",
    "IF SCHEMA_ID('sales') IS NULL EXEC('CREATE SCHEMA sales')",
];

/// 來源：涵蓋 int / bigint / decimal / nvarchar / varchar / bit / datetime2 / date / uniqueidentifier、
/// NOT NULL、DEFAULT、IDENTITY、非叢集索引、UNIQUE 索引、雙欄外鍵、非 dbo schema、視圖、程序、觸發器。
/// （MSSQL driver 的 table_columns 不讀擴充屬性，ColumnInfo.comment 恆為空 → 刻意不放欄位註解。）
const SRC_SQL: &[&str] = &[
    "CREATE TABLE dbo.customers (
        id INT IDENTITY(1,1) NOT NULL,
        code NVARCHAR(50) NOT NULL,
        email NVARCHAR(50) NULL,
        note VARCHAR(20) NULL,
        is_active BIT NOT NULL CONSTRAINT df_customers_active DEFAULT ((1)),
        credit DECIMAL(12,2) NOT NULL CONSTRAINT df_customers_credit DEFAULT ((0)),
        created_on DATE NULL,
        CONSTRAINT pk_customers PRIMARY KEY (id),
        CONSTRAINT uq_customers_id_code UNIQUE (id, code)
    )",
    "CREATE INDEX ix_customers_email ON dbo.customers (email)",
    "CREATE TABLE sales.orders (
        order_id BIGINT IDENTITY(1,1) NOT NULL,
        customer_id INT NOT NULL,
        customer_code NVARCHAR(50) NOT NULL,
        qty BIGINT NOT NULL,
        total DECIMAL(12,2) NOT NULL,
        memo VARCHAR(20) NULL,
        paid BIT NOT NULL,
        ordered_on DATE NULL,
        ordered_at DATETIME2 NULL,
        ref_guid UNIQUEIDENTIFIER NULL,
        CONSTRAINT pk_orders PRIMARY KEY (order_id),
        CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id, customer_code)
            REFERENCES dbo.customers (id, code)
    )",
    "CREATE INDEX ix_orders_customer ON sales.orders (customer_id)",
    "CREATE UNIQUE INDEX ux_orders_ref ON sales.orders (ref_guid)",
    "CREATE TABLE dbo.audit_log (
        id INT IDENTITY(1,1) NOT NULL,
        action NVARCHAR(50) NOT NULL,
        at_utc DATETIME2 NULL CONSTRAINT df_audit_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT pk_audit_log PRIMARY KEY (id)
    )",
    "CREATE INDEX ix_audit_action ON dbo.audit_log (action)",
    "CREATE VIEW sales.v_orders AS SELECT order_id, customer_id, total FROM sales.orders",
    "CREATE PROCEDURE dbo.sp_order_total AS BEGIN SET NOCOUNT ON; SELECT SUM(total) AS total FROM sales.orders; END",
    "CREATE TRIGGER sales.tr_orders_touch ON sales.orders AFTER INSERT AS BEGIN SET NOCOUNT ON; END",
];

/// 目標：缺欄（email）、多欄（legacy_flag）、int→bigint（qty）、可空性（note）、
/// 缺索引（ix_customers_email / ux_orders_ref）、多索引（ix_customers_legacy）、缺外鍵、
/// 視圖本體不同、程序本體不同、缺觸發器、只有目標有的表（legacy_notes）。
/// customer_id 另外做成 smallint：那一欄被 ix_orders_customer 蓋住，逼出 SQL Server
/// 「ALTER COLUMN 動不了被索引參照的欄位」這條限制。
const DST_SQL: &[&str] = &[
    "CREATE TABLE dbo.customers (
        id INT IDENTITY(1,1) NOT NULL,
        code NVARCHAR(50) NOT NULL,
        note VARCHAR(20) NOT NULL,
        is_active BIT NOT NULL CONSTRAINT df_customers_active DEFAULT ((1)),
        credit DECIMAL(12,2) NOT NULL CONSTRAINT df_customers_credit DEFAULT ((0)),
        created_on DATE NULL,
        legacy_flag BIT NULL,
        CONSTRAINT pk_customers PRIMARY KEY (id),
        CONSTRAINT uq_customers_id_code UNIQUE (id, code)
    )",
    "CREATE INDEX ix_customers_legacy ON dbo.customers (legacy_flag)",
    "CREATE TABLE sales.orders (
        order_id BIGINT IDENTITY(1,1) NOT NULL,
        customer_id SMALLINT NOT NULL,
        customer_code NVARCHAR(50) NOT NULL,
        qty INT NOT NULL,
        total DECIMAL(12,2) NOT NULL,
        memo VARCHAR(20) NULL,
        paid BIT NOT NULL,
        ordered_on DATE NULL,
        ordered_at DATETIME2 NULL,
        ref_guid UNIQUEIDENTIFIER NULL,
        CONSTRAINT pk_orders PRIMARY KEY (order_id)
    )",
    "CREATE INDEX ix_orders_customer ON sales.orders (customer_id)",
    "CREATE TABLE dbo.legacy_notes (
        id INT NOT NULL,
        body NVARCHAR(50) NULL,
        CONSTRAINT pk_legacy_notes PRIMARY KEY (id)
    )",
    "CREATE VIEW sales.v_orders AS SELECT order_id, customer_id FROM sales.orders",
    "CREATE PROCEDURE dbo.sp_order_total AS BEGIN SET NOCOUNT ON; SELECT COUNT(*) AS n FROM sales.orders; END",
];

fn cap() -> schema::CaptureOptions {
    schema::CaptureOptions::default()
}

fn sync_all() -> ddl::SyncOptions {
    ddl::SyncOptions {
        include_drops: true,
        include_indexes: true,
        include_fks: true,
        include_views: true,
        include_routines: true,
    }
}

async fn capture_src(mgr: &ConnectionManager, id: &str, opts: &schema::CaptureOptions) -> schema::DbSchema {
    schema::capture(mgr, id, SRC_DB, "src", opts, None).await.expect("擷取來源結構")
}

async fn capture_dst(mgr: &ConnectionManager, id: &str, opts: &schema::CaptureOptions) -> schema::DbSchema {
    schema::capture(mgr, id, DST_DB, "dst", opts, None).await.expect("擷取目標結構")
}

fn attrs_of<'a>(td: &'a diff::TableDiff, col: &str) -> &'a [diff::ColumnAttr] {
    &td.columns_changed.iter().find(|c| c.name == col).unwrap_or_else(|| panic!("{col} 應有變更")).attrs
}

/// 深度結構冪等：兩台伺服器、非 dbo schema、十一種差異 → 同步後必須零差異。
#[tokio::test]
#[ignore]
async fn mssql_schema_sync_is_idempotent_cross_connection() {
    let (mgr, a, b) = setup("deep").await;
    let opts = cap();
    let sa = capture_src(&mgr, &a, &opts).await;
    let sb = capture_dst(&mgr, &b, &opts).await;

    // list_tables 對非 dbo 回 `schema.table`，整條管線都要原樣帶著這個點號。
    assert!(sa.table("sales.orders").is_some(), "來源應有 sales.orders：{:?}", sa.tables.iter().map(|t| &t.name).collect::<Vec<_>>());
    assert!(sa.tables.iter().all(|t| t.ddl_synthesized), "MSSQL 的表 DDL 由 catalog 合成");
    assert_eq!(sa.views.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), vec!["sales.v_orders"]);
    // 型別必須帶長度 / 精度，否則同步出去的 ALTER COLUMN 會把欄位截成 (1)。
    let cust = sa.table("customers").expect("來源 dbo.customers");
    let ty = |n: &str| cust.columns.iter().find(|c| c.name == n).unwrap().data_type.as_str();
    assert_eq!(ty("code"), "nvarchar(50)");
    assert_eq!(ty("note"), "varchar(20)");
    assert_eq!(ty("credit"), "decimal(12,2)");
    assert_eq!(ty("created_on"), "date");
    assert_eq!(cust.columns.iter().find(|c| c.name == "id").unwrap().extra, "identity");

    let d = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    assert_eq!(d.tables_added, vec!["audit_log"]);
    assert_eq!(d.tables_removed, vec!["legacy_notes"]);
    assert_eq!(d.views_changed.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), vec!["sales.v_orders"]);
    assert_eq!(d.routines_changed.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["sp_order_total"]);
    assert_eq!(d.routines_added.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["sales.tr_orders_touch"]);
    assert!(d.routines_removed.is_empty());

    let td_c = d.tables_changed.iter().find(|t| t.name == "customers").expect("customers 應有差異");
    assert_eq!(td_c.columns_added.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["email"]);
    assert_eq!(td_c.columns_removed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["legacy_flag"]);
    // 只有可空性不同 → attrs 必須恰好是 Nullable（型別 / 預設值 / identity 都相同）。
    assert_eq!(attrs_of(td_c, "note"), [diff::ColumnAttr::Nullable]);
    assert_eq!(td_c.indexes_added.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["ix_customers_email"]);
    assert_eq!(td_c.indexes_removed.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["ix_customers_legacy"]);

    let td_o = d.tables_changed.iter().find(|t| t.name == "sales.orders").expect("sales.orders 應有差異");
    assert_eq!(attrs_of(td_o, "qty"), [diff::ColumnAttr::DataType]);
    assert_eq!(attrs_of(td_o, "customer_id"), [diff::ColumnAttr::DataType]);
    assert_eq!(td_o.indexes_added.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["ux_orders_ref"]);
    assert!(td_o.indexes_added[0].unique);
    assert_eq!(td_o.fks_added.len(), 1);
    assert_eq!(td_o.fks_added[0].columns, vec!["customer_id", "customer_code"]);
    assert_eq!(td_o.fks_added[0].ref_table, "customers");
    assert!(td_o.columns_added.is_empty() && td_o.columns_removed.is_empty());

    let script = ddl::generate(&d, &sa, &sb, &sync_all()).expect("產生同步 DDL");
    assert!(script.skipped.is_empty(), "此案例應全部可表達：{:?}", script.skipped);
    // 合成 DDL 不含索引 → 只在來源有的表必須另外補 CREATE INDEX。
    assert!(
        script.statements.iter().any(|s| s.kind == ddl::SyncKind::CreateIndex && s.object == "audit_log.ix_audit_action"),
        "audit_log 的索引應另外補：{:?}",
        script.statements.iter().map(|s| &s.sql).collect::<Vec<_>>()
    );
    assert!(script.statements.iter().any(|s| s.kind == ddl::SyncKind::DropTable && s.destructive));
    // 被索引參照的欄位：必須自動卸索引 → 改欄位 → 重建索引，而不是送出一句必定失敗的 ALTER COLUMN。
    let kinds: Vec<(ddl::SyncKind, &str)> =
        script.statements.iter().map(|s| (s.kind, s.object.as_str())).collect();
    let at = |k: ddl::SyncKind, obj: &str| {
        kinds.iter().position(|x| *x == (k, obj)).unwrap_or_else(|| panic!("找不到 {k:?} / {obj}：{kinds:?}"))
    };
    assert!(at(ddl::SyncKind::DropIndex, "sales.orders.ix_orders_customer") < at(ddl::SyncKind::AlterColumn, "sales.orders.customer_id"));
    assert!(at(ddl::SyncKind::AlterColumn, "sales.orders.customer_id") < at(ddl::SyncKind::CreateIndex, "sales.orders.ix_orders_customer"));

    for s in &script.statements {
        mgr.exec_ddl(&b, &s.sql).await.unwrap_or_else(|e| panic!("套用失敗（{:?}）：{}\n{e}", s.kind, s.sql));
    }

    let sb2 = capture_dst(&mgr, &b, &opts).await;
    let d2 = diff::diff(&sa, &sb2, &diff::DiffOptions::default());
    assert!(
        d2.is_empty(),
        "同步後應零差異：{:?}\n表：{:?}\n視圖：{:?}\n程序：{:?}",
        d2.summary,
        d2.tables_changed.iter().map(|t| (&t.name, &t.columns_added, &t.columns_removed, &t.columns_changed, &t.indexes_added, &t.indexes_removed, &t.fks_added)).collect::<Vec<_>>(),
        d2.views_changed.iter().map(|v| (&v.name, &v.src, &v.dst)).collect::<Vec<_>>(),
        d2.routines_changed.iter().map(|r| (&r.name, &r.src, &r.dst)).collect::<Vec<_>>()
    );
    // 真的建出來了，不是「diff 看不見」：ALTER COLUMN 沒把 varchar(20) 截成 varchar(1)。
    let note = sb2.table("customers").unwrap().columns.iter().find(|c| c.name == "note").unwrap();
    assert_eq!((note.data_type.as_str(), note.nullable), ("varchar(20)", true));

    // 再跑一次 generate：零差異 → 零語句（冪等）。
    let again = ddl::generate(&d2, &sa, &sb2, &sync_all()).expect("再次產生");
    assert!(again.statements.is_empty() && again.skipped.is_empty(), "{:?} / {:?}", again.statements, again.skipped);

    mgr.disconnect(&a).await;
    mgr.disconnect(&b).await;
}

/// 快照：存 → 讀 → 與即時擷取零差異（含非 dbo 表名、合成 DDL、程序定義）。
#[tokio::test]
#[ignore]
async fn mssql_snapshot_round_trip_matches_live_capture() {
    let (mgr, a, b) = setup("snap").await;
    let opts = cap();
    let sa = capture_src(&mgr, &a, &opts).await;

    let path = std::env::temp_dir().join(format!("dbkit_mssql_snap_{}.json", std::process::id()));
    let info = snapshot::save(&path, &sa).await.expect("存快照");
    assert!(info.bytes > 0);
    assert_eq!(info.tables, sa.tables.len());
    assert_eq!(info.routines, sa.routines.len());

    let loaded = snapshot::load(&path).await.expect("讀快照").schema;
    assert_eq!(loaded.kind, DbKind::Mssql);
    assert!(loaded.table("sales.orders").is_some(), "非 dbo 表名要能經 JSON 來回");
    let d = diff::diff(&sa, &loaded, &diff::DiffOptions::default());
    assert!(d.is_empty(), "快照 vs 即時應零差異：{:?}", d.summary);
    // 快照當來源、即時目標當目標：與「兩邊都即時」得到同一份差異摘要。
    let sb = capture_dst(&mgr, &b, &opts).await;
    let live = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    let from_snap = diff::diff(&loaded, &sb, &diff::DiffOptions::default());
    assert_eq!(from_snap.summary.total, live.summary.total);

    let _ = std::fs::remove_file(&path);
    mgr.disconnect(&a).await;
    mgr.disconnect(&b).await;
}

/// 單表範圍：CaptureOptions.tables = ["sales.orders"]，內嵌 schema 的名稱要活著走完整條管線。
#[tokio::test]
#[ignore]
async fn mssql_single_table_scope_keeps_schema_prefix() {
    let (mgr, a, b) = setup("one").await;
    // 單表比對不牽涉程序 / 函式 / 觸發器（retain_tables 也會把它們清掉）。
    let only = schema::CaptureOptions {
        tables: Some(vec!["sales.orders".to_string()]),
        include_routines: false,
        ..schema::CaptureOptions::default()
    };
    let sa = capture_src(&mgr, &a, &only).await;
    let sb = capture_dst(&mgr, &b, &only).await;
    assert_eq!(sa.tables.len(), 1, "只該擷取一張表：{:?}", sa.tables.iter().map(|t| &t.name).collect::<Vec<_>>());
    assert_eq!(sa.tables[0].name, "sales.orders");
    assert!(sa.views.is_empty(), "sales.v_orders 不在清單內");
    assert!(!sa.tables[0].columns.is_empty() && !sa.tables[0].foreign_keys.is_empty());

    let d = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    assert!(d.tables_added.is_empty() && d.tables_removed.is_empty());
    assert_eq!(d.tables_changed.len(), 1);
    assert_eq!(d.tables_changed[0].name, "sales.orders");

    // 單表 drill-in：程序不同步，只留這張表的語句。
    let mut scoped = d.clone();
    scoped.retain_tables(&["sales.orders".to_string()]);
    let script = ddl::generate(&scoped, &sa, &sb, &sync_all()).expect("單表同步 DDL");
    assert!(!script.statements.is_empty());
    for s in &script.statements {
        assert!(s.sql.contains("[sales].[orders]"), "名稱中的點號不可被當成表名的一部分：{}", s.sql);
        mgr.exec_ddl(&b, &s.sql).await.unwrap_or_else(|e| panic!("套用失敗：{}\n{e}", s.sql));
    }
    let sb2 = capture_dst(&mgr, &b, &only).await;
    let d2 = diff::diff(&sa, &sb2, &diff::DiffOptions::default());
    assert!(d2.is_empty(), "單表同步後應零差異：{:?}", d2.summary);

    mgr.disconnect(&a).await;
    mgr.disconnect(&b).await;
}

/// 引擎表達不出來的 MSSQL 變更（具名預設約束 / IDENTITY / 主鍵 / 唯一索引蓋住的欄位）
/// 必須出現在 `skipped`，而不是靜默漏掉、也不是產出一句跑不動的語句。
#[tokio::test]
#[ignore]
async fn mssql_inexpressible_changes_land_in_skipped() {
    let (mgr, a, b) = setup("skip").await;
    // 另建一張只給本測試用的表（setup 建的那幾張刻意做成全可表達）。
    for (id, sql) in [
        (&a, "CREATE TABLE dbo.quirks (
                id INT NOT NULL,
                n INT NOT NULL CONSTRAINT df_quirks_n DEFAULT ((7)),
                seq INT IDENTITY(1,1) NOT NULL,
                tag NVARCHAR(50) NOT NULL,
                CONSTRAINT pk_quirks PRIMARY KEY (id)
             )"),
        (&b, "CREATE TABLE dbo.quirks (
                id INT NOT NULL,
                n INT NOT NULL CONSTRAINT df_quirks_n DEFAULT ((1)),
                seq INT NOT NULL,
                tag NVARCHAR(50) NULL,
                CONSTRAINT pk_quirks PRIMARY KEY (id, n)
             )"),
    ] {
        mgr.exec_ddl(id, "DROP TABLE IF EXISTS dbo.quirks").await.unwrap();
        mgr.exec_ddl(id, sql).await.unwrap();
    }
    mgr.exec_ddl(&b, "CREATE UNIQUE INDEX ux_quirks_tag ON dbo.quirks (tag)").await.unwrap();
    mgr.exec_ddl(&a, "CREATE UNIQUE INDEX ux_quirks_tag ON dbo.quirks (tag)").await.unwrap();

    let only = schema::CaptureOptions {
        tables: Some(vec!["quirks".to_string()]),
        include_routines: false,
        ..schema::CaptureOptions::default()
    };
    let sa = capture_src(&mgr, &a, &only).await;
    let sb = capture_dst(&mgr, &b, &only).await;
    let d = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    let td = &d.tables_changed[0];
    assert_eq!(attrs_of(td, "n"), [diff::ColumnAttr::Default]);
    assert_eq!(attrs_of(td, "seq"), [diff::ColumnAttr::Extra]);
    assert_eq!(attrs_of(td, "tag"), [diff::ColumnAttr::Nullable]);

    let script = ddl::generate(&d, &sa, &sb, &sync_all()).expect("產生同步 DDL");
    let joined = script.skipped.join(" | ");
    assert!(joined.contains("quirks.n"), "具名預設約束變更要記 skipped：{joined}");
    assert!(joined.contains("quirks.seq"), "identity 變更要記 skipped：{joined}");
    assert!(joined.contains("主鍵"), "主鍵變更要記 skipped：{joined}");
    assert!(joined.contains("ux_quirks_tag"), "唯一索引蓋住的欄位要記 skipped：{joined}");
    // 沒有一句是「產出來但跑不動」的：這裡真的一句都不該產。
    assert!(script.statements.is_empty(), "{:?}", script.statements.iter().map(|s| &s.sql).collect::<Vec<_>>());

    for id in [&a, &b] {
        mgr.exec_ddl(id, "DROP TABLE IF EXISTS dbo.quirks").await.unwrap();
    }
    mgr.disconnect(&a).await;
    mgr.disconnect(&b).await;
}

/// 跨連線：每一句都必須指向目標庫 cmp_dst，絕不可漏出來源庫 cmp_src。
#[tokio::test]
#[ignore]
async fn mssql_generated_sql_targets_destination_database_only() {
    let (mgr, a, b) = setup("qual").await;
    let opts = cap();
    let sa = capture_src(&mgr, &a, &opts).await;
    let sb = capture_dst(&mgr, &b, &opts).await;
    let d = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    let script = ddl::generate(&d, &sa, &sb, &sync_all()).expect("產生同步 DDL");
    assert_eq!(script.target_db, DST_DB);

    for s in &script.statements {
        assert!(!s.sql.contains(SRC_DB), "語句不可指向來源庫：{}", s.sql);
        assert!(s.sql.contains(&format!("[{DST_DB}]")), "語句需限定到目標庫：{}", s.sql);
    }
    let find = |k: ddl::SyncKind, obj: &str| {
        script
            .statements
            .iter()
            .find(|s| s.kind == k && s.object == obj)
            .unwrap_or_else(|| panic!("找不到 {k:?} / {obj}"))
            .sql
            .clone()
    };
    assert!(find(ddl::SyncKind::CreateTable, "audit_log").starts_with(&format!("CREATE TABLE [{DST_DB}].[dbo].[audit_log] (")));
    assert_eq!(find(ddl::SyncKind::DropTable, "legacy_notes"), format!("DROP TABLE [{DST_DB}].[dbo].[legacy_notes]"));
    assert_eq!(
        find(ddl::SyncKind::AlterColumn, "sales.orders.qty"),
        format!("ALTER TABLE [{DST_DB}].[sales].[orders] ALTER COLUMN [qty] bigint NOT NULL")
    );
    assert_eq!(
        find(ddl::SyncKind::CreateIndex, "sales.orders.ux_orders_ref"),
        format!("CREATE UNIQUE INDEX [ux_orders_ref] ON [{DST_DB}].[sales].[orders] ([ref_guid])")
    );
    assert_eq!(
        find(ddl::SyncKind::DropIndex, "customers.ix_customers_legacy"),
        format!("DROP INDEX [ix_customers_legacy] ON [{DST_DB}].[dbo].[customers]")
    );
    assert_eq!(
        find(ddl::SyncKind::AddForeignKey, "sales.orders.fk_orders_customer"),
        format!(
            "ALTER TABLE [{DST_DB}].[sales].[orders] ADD CONSTRAINT [fk_orders_customer] \
             FOREIGN KEY ([customer_id], [customer_code]) REFERENCES [{DST_DB}].[dbo].[customers] ([id], [code])"
        )
    );
    // 視圖 / 程序 / 觸發器：T-SQL 不收三部式名稱，改由目標庫的 sp_executesql 指定資料庫。
    assert_eq!(
        find(ddl::SyncKind::DropView, "sales.v_orders"),
        format!("EXEC [{DST_DB}].sys.sp_executesql N'DROP VIEW [sales].[v_orders]'")
    );
    assert!(find(ddl::SyncKind::CreateView, "sales.v_orders")
        .starts_with(&format!("EXEC [{DST_DB}].sys.sp_executesql N'CREATE OR ALTER VIEW [sales].[v_orders] AS ")));
    assert_eq!(
        find(ddl::SyncKind::DropRoutine, "sp_order_total"),
        format!("EXEC [{DST_DB}].sys.sp_executesql N'DROP PROCEDURE [dbo].[sp_order_total]'")
    );
    assert!(find(ddl::SyncKind::CreateRoutine, "sales.tr_orders_touch")
        .starts_with(&format!("EXEC [{DST_DB}].sys.sp_executesql N'CREATE TRIGGER sales.tr_orders_touch ON sales.orders")));

    mgr.disconnect(&a).await;
    mgr.disconnect(&b).await;
}
