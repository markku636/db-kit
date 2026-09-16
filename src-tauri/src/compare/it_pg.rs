//! PostgreSQL 16 的比對端到端驗證：合成 DDL（synthesized table_ddl）與值正規化。
//!
//! PG 沒有 SHOW CREATE TABLE，`table_ddl` 由 information_schema 重建，因此這一維度的重點是
//! 「合成出來的 DDL 到底還原了多少」——長度 / 精度 / identity / 序列 / 視圖本體的 schema 歸屬，
//! 以及索引、外鍵這些合成 DDL 不含、必須另外補語句的物件。
//!
//! 一律用**同一個連線**（ConnectionConfig.database 固定為真實資料庫 testdb），
//! 以 schema 名當作引擎的 "database" 參數；每個測試自備一組 `cmpb_*` schema，開頭先 DROP 再建，
//! 重跑才有決定性。最強的斷言是冪等：套用產生的語句後重新擷取再比對必須為空。

#![cfg(test)]

use std::time::Duration;

use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::manager::ConnectionManager;

fn no_cmp_progress(_: crate::compare::CompareProgress) {}

fn pg_cfg(id: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: id.into(),
        name: id.into(),
        kind: DbKind::Postgres,
        host: "127.0.0.1".into(),
        port: 15432,
        username: "postgres".into(),
        password: "test1234".into(),
        // 這是真實資料庫；schema 另外以「database 參數」傳給比對引擎。
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

/// 連上 PG 並把指定 schema 砍掉重建（重跑決定性）。
async fn pg_mgr(id: &str, schemas: &[&str]) -> ConnectionManager {
    let mgr = ConnectionManager::new();
    let mut last = String::new();
    let mut ok = false;
    for _ in 0..30 {
        match mgr.connect(pg_cfg(id)).await {
            Ok(_) => {
                ok = true;
                break;
            }
            Err(e) => {
                last = e.to_string();
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    assert!(ok, "PostgreSQL 連線失敗：{last}");
    for s in schemas {
        mgr.exec_ddl(id, &format!("DROP SCHEMA IF EXISTS {s} CASCADE")).await.unwrap();
        mgr.exec_ddl(id, &format!("CREATE SCHEMA {s}")).await.unwrap();
    }
    mgr
}

async fn cleanup(mgr: &ConnectionManager, id: &str, schemas: &[&str]) {
    for s in schemas {
        let _ = mgr.exec_ddl(id, &format!("DROP SCHEMA IF EXISTS {s} CASCADE")).await;
    }
    mgr.disconnect(id).await;
}

/// 取單格結果（不存在回 None）。
async fn scalar(mgr: &ConnectionManager, id: &str, sql: &str) -> Option<String> {
    mgr.query(id, sql)
        .await
        .unwrap_or_else(|e| panic!("查詢失敗：{sql}\n{e}"))
        .rows
        .first()
        .and_then(|r| r.first().cloned().flatten())
}

// ---------------------------------------------------------------------------
// 1. 結構冪等：合成 DDL + 另補索引 / 外鍵 + 視圖
// ---------------------------------------------------------------------------

/// capture → diff → generate → 套用 → 再 diff。
/// 同時釘住「合成 DDL 會靜默丟失型別長度 / 精度、序列指回來源 schema、視圖本體留在來源 schema」
/// 這幾個資料正確性風險——它們都通不過 diff（diff 看不見），只能直接問 catalog。
#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn compare_schema_pg_sync_is_idempotent() {
    use crate::compare::ddl::{self, SyncKind};
    use crate::compare::diff::{self, ColumnAttr};
    use crate::compare::schema;

    const SRC: &str = "cmpb_src";
    const DST: &str = "cmpb_dst";
    let id = "cmpb-idem";
    let mgr = pg_mgr(id, &[SRC, DST]).await;

    mgr.exec_ddl(
        id,
        r#"
        CREATE TABLE cmpb_src.parent (
            pid integer NOT NULL,
            pcode varchar(20) NOT NULL,
            CONSTRAINT parent_pkey PRIMARY KEY (pid)
        );
        CREATE TABLE cmpb_src.item (
            id integer NOT NULL,
            name varchar(50) NOT NULL DEFAULT 'n/a',
            price numeric(10,2) NOT NULL DEFAULT 0.00,
            memo text,
            active boolean NOT NULL DEFAULT true,
            created_at timestamp NOT NULL DEFAULT now(),
            touched_at timestamptz,
            payload jsonb,
            qty bigint NOT NULL DEFAULT 0,
            score numeric(8,3) NOT NULL DEFAULT 0,
            parent_id integer,
            CONSTRAINT item_pkey PRIMARY KEY (id),
            CONSTRAINT item_parent_fk FOREIGN KEY (parent_id) REFERENCES cmpb_src.parent (pid)
        );
        CREATE INDEX ix_item_name ON cmpb_src.item (name);
        CREATE UNIQUE INDEX ux_item_memo ON cmpb_src.item (memo);
        COMMENT ON COLUMN cmpb_src.item.name IS '品名';
        COMMENT ON COLUMN cmpb_src.item.qty IS '數量';
        CREATE TABLE cmpb_src.only_src (
            id serial,
            note varchar(50),
            amount numeric(12,4),
            parent_id integer,
            CONSTRAINT only_src_pkey PRIMARY KEY (id),
            CONSTRAINT only_src_parent_fk FOREIGN KEY (parent_id) REFERENCES cmpb_src.parent (pid)
        );
        CREATE INDEX ix_only_src_note ON cmpb_src.only_src (note);
        CREATE VIEW cmpb_src.v_item AS SELECT id, name FROM cmpb_src.item;
        "#,
    )
    .await
    .unwrap();

    // dst 的分歧：缺欄 / 多欄 / 長度縮短 / nullable / default / comment / 索引 / 外鍵 / 多一張表。
    mgr.exec_ddl(
        id,
        r#"
        CREATE TABLE cmpb_dst.parent (
            pid integer NOT NULL,
            pcode varchar(20) NOT NULL,
            CONSTRAINT parent_pkey PRIMARY KEY (pid)
        );
        CREATE TABLE cmpb_dst.item (
            id integer NOT NULL,
            name varchar(20) NOT NULL DEFAULT 'n/a',
            price numeric(10,2),
            memo text,
            active boolean NOT NULL DEFAULT false,
            created_at timestamp NOT NULL,
            touched_at timestamptz,
            payload jsonb,
            legacy integer,
            parent_id integer,
            CONSTRAINT item_pkey PRIMARY KEY (id)
        );
        CREATE INDEX ix_item_memo_dup ON cmpb_dst.item (memo);
        COMMENT ON COLUMN cmpb_dst.item.name IS '名稱';
        CREATE TABLE cmpb_dst.only_dst (id integer PRIMARY KEY);
        CREATE VIEW cmpb_dst.v_item AS SELECT id FROM cmpb_dst.item;
        "#,
    )
    .await
    .unwrap();

    // routines 另有專門測試；這裡排除，讓「再 diff 為空」的斷言只談表 / 視圖。
    let cap = schema::CaptureOptions { include_routines: false, ..Default::default() };
    let sa = schema::capture(&mgr, id, SRC, "src", &cap, None).await.unwrap();
    let sb = schema::capture(&mgr, id, DST, "dst", &cap, None).await.unwrap();
    assert_eq!(sa.tables.len(), 3, "{:?}", sa.tables.iter().map(|t| &t.name).collect::<Vec<_>>());
    assert_eq!(sa.views.len(), 1);

    let t_item = sa.table("item").unwrap();
    assert!(t_item.ddl_synthesized, "PG 的表 DDL 由 catalog 合成");
    assert!(t_item.ddl.as_deref().unwrap().starts_with("CREATE TABLE \"cmpb_src\".\"item\" ("));
    // 合成 DDL 不含索引 / 外鍵，這正是 create_table 要另補語句的前提。
    assert!(!t_item.ddl.as_deref().unwrap().contains("INDEX"));
    assert!(sa.view("v_item").unwrap().ddl.as_deref().unwrap().contains("CREATE OR REPLACE VIEW"));

    let d = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    assert_eq!(d.tables_added, vec!["only_src"]);
    assert_eq!(d.tables_removed, vec!["only_dst"]);
    assert_eq!(d.tables_identical, vec!["parent"]);
    assert_eq!(d.views_changed.len(), 1);
    let td = d.tables_changed.iter().find(|t| t.name == "item").unwrap();
    assert_eq!(td.columns_added.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["qty", "score"]);
    assert_eq!(td.columns_removed[0].name, "legacy");
    let attrs = |n: &str| {
        td.columns_changed.iter().find(|c| c.name == n).unwrap_or_else(|| panic!("{n} 應有差異")).attrs.clone()
    };
    assert_eq!(attrs("active"), vec![ColumnAttr::Default]);
    assert_eq!(attrs("created_at"), vec![ColumnAttr::Default]);
    assert_eq!(attrs("price"), vec![ColumnAttr::Nullable, ColumnAttr::Default]);
    // 欄位型別取自 format_type(atttypid, atttypmod)，帶得回長度：varchar(50) vs varchar(20)
    // 這種會截斷資料的縮短必須以 DataType 現形（另外還差一個註解）。
    assert_eq!(attrs("name"), vec![ColumnAttr::DataType, ColumnAttr::Comment]);
    assert_eq!(td.indexes_added.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["ix_item_name", "ux_item_memo"]);
    assert_eq!(td.indexes_removed[0].name, "ix_item_memo_dup");
    assert_eq!(td.fks_added[0].name, "item_parent_fk");

    let sync = ddl::SyncOptions { include_drops: true, ..Default::default() };
    let script = ddl::generate(&d, &sa, &sb, &sync).unwrap();
    let text = ddl::script_text(&script);
    let count = |k: SyncKind| script.statements.iter().filter(|s| s.kind == k).count();
    // 合成 DDL 的表：CREATE TABLE 之外必須另補 CREATE INDEX / ADD CONSTRAINT。
    assert_eq!(count(SyncKind::CreateTable), 1);
    assert_eq!(count(SyncKind::CreateIndex), 3, "{text}"); // ix_only_src_note + ix_item_name + ux_item_memo
    assert_eq!(count(SyncKind::AddForeignKey), 2, "{text}"); // only_src_parent_fk + item_parent_fk
    assert_eq!(count(SyncKind::DropIndex), 1);
    assert_eq!(count(SyncKind::DropTable), 1);
    assert_eq!(count(SyncKind::DropView), 1);
    assert_eq!(count(SyncKind::CreateView), 1);

    let create = &script.statements.iter().find(|s| s.kind == SyncKind::CreateTable).unwrap().sql;
    assert!(create.starts_with("CREATE TABLE \"cmpb_dst\".\"only_src\" ("), "{create}");
    // 合成 DDL 取自 format_type(atttypid, atttypmod)，長度與精度都保留得住。
    assert!(create.contains("\"note\" character varying(50)"), "{create}");
    assert!(create.contains("\"amount\" numeric(12,4)"), "{create}");
    // serial 的 DEFAULT 只能照抄（目標端自建序列不是同步能決定的事），指向「來源 schema」的
    // 序列會讓兩張表共用同一條序列 —— 語句本身不動，但必須留一筆 skipped 讓使用者看見。
    assert!(create.contains("nextval('cmpb_src.only_src_id_seq'::regclass)"), "{create}");
    assert_eq!(script.skipped.len(), 1, "只有序列共用這一項不可表達：{:?}", script.skipped);
    assert!(
        script.skipped[0].contains("only_src") && script.skipped[0].contains("cmpb_src"),
        "skipped 應指名是哪張表的序列指回來源 schema：{:?}",
        script.skipped
    );

    assert!(text.contains("ALTER TABLE \"cmpb_dst\".\"item\" ADD COLUMN \"qty\" bigint NOT NULL DEFAULT 0"), "{text}");
    assert!(text.contains("COMMENT ON COLUMN \"cmpb_dst\".\"item\".\"qty\" IS '數量'"), "{text}");
    // ADD COLUMN 同樣帶得回精度：numeric(8,3) 不再退化成無限精度 numeric。
    assert!(text.contains("ADD COLUMN \"score\" numeric(8,3) NOT NULL DEFAULT 0"), "{text}");
    assert!(text.contains("ALTER COLUMN \"active\" SET DEFAULT true"), "{text}");
    assert!(text.contains("ALTER COLUMN \"created_at\" SET DEFAULT now()"), "{text}");
    assert!(text.contains("ALTER COLUMN \"price\" SET NOT NULL"), "{text}");
    assert!(text.contains("ALTER COLUMN \"price\" SET DEFAULT 0.00"), "{text}");
    assert!(text.contains("COMMENT ON COLUMN \"cmpb_dst\".\"item\".\"name\" IS '品名'"), "{text}");
    assert!(text.contains("ALTER TABLE \"cmpb_dst\".\"item\" DROP COLUMN \"legacy\""), "{text}");
    assert!(text.contains("DROP INDEX \"cmpb_dst\".\"ix_item_memo_dup\""), "{text}");
    assert!(text.contains("ALTER TABLE \"cmpb_dst\".\"item\" ADD CONSTRAINT \"item_parent_fk\" FOREIGN KEY (\"parent_id\") REFERENCES \"cmpb_dst\".\"parent\" (\"pid\")"), "{text}");

    // CREATE INDEX 的索引名不可限定 schema（PG 文法不收；索引一定建在表所屬的 schema），
    // 只有 DROP INDEX 需要限定 —— 兩者共用同一個 helper 曾讓 PG 的結構同步必定失敗。
    for s in script.statements.iter().filter(|s| s.kind == SyncKind::CreateIndex) {
        assert!(!s.sql.contains(&format!("INDEX \"{DST}\".")), "索引名不得限定 schema：{}", s.sql);
        assert!(s.sql.contains(&format!("ON \"{DST}\".")), "表名仍須限定到目標 schema：{}", s.sql);
    }
    assert!(text.contains(&format!("DROP INDEX \"{DST}\".")), "DROP INDEX 才需要限定 schema：{text}");

    // 產生什麼就套用什麼，不再需要任何修補。
    for s in &script.statements {
        mgr.exec_ddl(id, &s.sql).await.unwrap_or_else(|e| panic!("套用失敗：{}\n{e}", s.sql));
    }

    let sb2 = schema::capture(&mgr, id, DST, "dst", &cap, None).await.unwrap();
    let d2 = diff::diff(&sa, &sb2, &diff::DiffOptions::default());
    assert_eq!(
        (d2.summary.tables_added, d2.summary.tables_removed, d2.summary.tables_changed),
        (0, 0, 0),
        "表結構同步後應零差異：{:?}",
        d2.tables_changed
    );
    assert_eq!((d2.summary.views_added, d2.summary.views_removed), (0, 0));
    // capture_view 以**裸名**包裝 pg_get_viewdef（限定到 schema 的話兩側定義文字永遠不等），
    // 視圖同步因此收斂得了：重建一次之後就不再被判為有差異。
    assert_eq!(d2.summary.views_changed, 0, "視圖同步後必須收斂：{:?}", d2.views_changed);

    // ---- diff 看不見、只能問 catalog 的三個資料正確性風險 ----
    // 前兩個（長度 / 精度）已由 format_type 補回，直接向 catalog 求證同步出去的欄位真的帶著它們。
    let len_of = |s: &str| format!(
        "SELECT character_maximum_length FROM information_schema.columns \
         WHERE table_schema='{s}' AND table_name='only_src' AND column_name='note'"
    );
    assert_eq!(scalar(&mgr, id, &len_of(SRC)).await.as_deref(), Some("50"));
    assert_eq!(scalar(&mgr, id, &len_of(DST)).await.as_deref(), Some("50"), "同步出去的 varchar 必須帶長度");
    let prec = scalar(
        &mgr,
        id,
        "SELECT numeric_precision FROM information_schema.columns \
         WHERE table_schema='cmpb_dst' AND table_name='item' AND column_name='score'",
    )
    .await;
    assert_eq!(prec.as_deref(), Some("8"), "ADD COLUMN 的 numeric 精度必須帶回");
    // 序列仍是共用的：CREATE TABLE 只能照抄來源的 nextval(...)，所以這裡「維持現狀」，
    // 由上面那筆 skipped 負責讓使用者知道要自建序列（而不是假裝已修好）。
    let seq = scalar(
        &mgr,
        id,
        "SELECT column_default FROM information_schema.columns \
         WHERE table_schema='cmpb_dst' AND table_name='only_src' AND column_name='id'",
    )
    .await
    .unwrap_or_default();
    assert!(seq.contains("cmpb_src"), "目標表的序列仍指回來源 schema（已列入 skipped），實得：{seq}");
    // 視圖確實被重建成來源定義（欄位變兩欄），但本體仍讀來源 schema 的表；
    // 這一項同樣無法自動改寫，改以語句上的 note 提醒。
    let vdef = scalar(&mgr, id, "SELECT pg_get_viewdef('cmpb_dst.v_item'::regclass, true)").await.unwrap_or_default();
    assert!(vdef.contains("name"), "視圖應已重建為來源定義：{vdef}");
    assert!(vdef.contains("cmpb_src.item"), "視圖本體仍指向來源 schema：{vdef}");
    let vnote = script
        .statements
        .iter()
        .find(|s| s.kind == SyncKind::CreateView)
        .and_then(|s| s.note.clone())
        .expect("CREATE VIEW 必須附上『本體仍指向來源 schema』的提示");
    assert!(vnote.contains(SRC) && vnote.contains(DST), "{vnote}");

    cleanup(&mgr, id, &[SRC, DST]).await;
}

// ---------------------------------------------------------------------------
// 2. DiffOptions：ignore_defaults / ignore_comments 只該壓掉對應屬性
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn compare_schema_pg_diff_options_suppress_only_target_attrs() {
    use crate::compare::diff::{self, ColumnAttr, DiffOptions};
    use crate::compare::schema;

    const SRC: &str = "cmpb_opt_src";
    const DST: &str = "cmpb_opt_dst";
    let id = "cmpb-opt";
    let mgr = pg_mgr(id, &[SRC, DST]).await;
    mgr.exec_ddl(
        id,
        r#"
        CREATE TABLE cmpb_opt_src.t (id integer NOT NULL, a integer DEFAULT 1, CONSTRAINT t_pkey PRIMARY KEY (id));
        COMMENT ON COLUMN cmpb_opt_src.t.a IS 'A';
        CREATE TABLE cmpb_opt_dst.t (id integer NOT NULL, a integer DEFAULT 2, CONSTRAINT t_pkey PRIMARY KEY (id));
        COMMENT ON COLUMN cmpb_opt_dst.t.a IS 'B';
        "#,
    )
    .await
    .unwrap();

    let cap = schema::CaptureOptions { include_routines: false, ..Default::default() };
    let sa = schema::capture(&mgr, id, SRC, "src", &cap, None).await.unwrap();
    let sb = schema::capture(&mgr, id, DST, "dst", &cap, None).await.unwrap();
    let attrs = |o: DiffOptions| {
        let r = diff::diff(&sa, &sb, &o);
        r.tables_changed.first().map(|t| t.columns_changed[0].attrs.clone()).unwrap_or_default()
    };
    assert_eq!(attrs(DiffOptions::default()), vec![ColumnAttr::Default, ColumnAttr::Comment]);
    assert_eq!(attrs(DiffOptions { ignore_defaults: true, ..Default::default() }), vec![ColumnAttr::Comment]);
    assert_eq!(attrs(DiffOptions { ignore_comments: true, ..Default::default() }), vec![ColumnAttr::Default]);
    let both = DiffOptions { ignore_defaults: true, ignore_comments: true, ..Default::default() };
    assert!(diff::diff(&sa, &sb, &both).is_empty(), "兩者皆忽略後應無差異");

    cleanup(&mgr, id, &[SRC, DST]).await;
}

// ---------------------------------------------------------------------------
// 3. 程序 / 觸發器的 DROP 形式 + 複合外鍵
// ---------------------------------------------------------------------------

/// DROP FUNCTION 需帶引數簽章、DROP TRIGGER 需帶所屬資料表——文字正確、順序（觸發器先於
/// 其觸發函式）正確，照產生順序執行得掉；跨 schema 的 CREATE 則一律進 skipped。
/// 順便釘住 PG driver 的複合外鍵逐位配對（不是笛卡兒積）。
#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn compare_schema_pg_routine_drops_and_composite_fk() {
    use crate::compare::ddl::{self, SyncKind};
    use crate::compare::schema::{self, group_fks};
    use crate::compare::diff;

    const SRC: &str = "cmpb_rt_src";
    const DST: &str = "cmpb_rt_dst";
    let id = "cmpb-rt";
    let mgr = pg_mgr(id, &[SRC, DST]).await;
    mgr.exec_ddl(
        id,
        r#"
        CREATE TABLE cmpb_rt_src.p (a integer NOT NULL, b integer NOT NULL, CONSTRAINT p_pkey PRIMARY KEY (a, b));
        CREATE TABLE cmpb_rt_src.c (
            x integer, y integer,
            CONSTRAINT c_fk FOREIGN KEY (x, y) REFERENCES cmpb_rt_src.p (a, b)
        );
        CREATE FUNCTION cmpb_rt_src.f_touch() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RETURN NEW; END;
        $fn$;
        CREATE TRIGGER trg_touch BEFORE UPDATE ON cmpb_rt_src.c
            FOR EACH ROW EXECUTE FUNCTION cmpb_rt_src.f_touch();
        CREATE TABLE cmpb_rt_dst.p (a integer NOT NULL, b integer NOT NULL, CONSTRAINT p_pkey PRIMARY KEY (a, b));
        CREATE FUNCTION cmpb_rt_dst.f_dead(n integer) RETURNS integer LANGUAGE sql AS $fn$ SELECT n $fn$;
        CREATE FUNCTION cmpb_rt_dst.f_dtrg() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RETURN NEW; END;
        $fn$;
        CREATE TRIGGER trg_dead BEFORE UPDATE ON cmpb_rt_dst.p
            FOR EACH ROW EXECUTE FUNCTION cmpb_rt_dst.f_dtrg();
        "#,
    )
    .await
    .unwrap();

    let cap = schema::CaptureOptions::default();
    let sa = schema::capture(&mgr, id, SRC, "src", &cap, None).await.unwrap();
    let sb = schema::capture(&mgr, id, DST, "dst", &cap, None).await.unwrap();
    assert_eq!(sa.routines.len(), 2, "函式 + 觸發器");
    assert_eq!(sb.routines.len(), 3);

    // PG driver 的 list_foreign_keys 以 pg_constraint 的 conkey / confkey 逐位配對
    //（unnest … WITH ORDINALITY），複合外鍵得到「2 欄、依欄序」而非 2×2 笛卡兒積。
    let fk = group_fks(&sa.table("c").unwrap().foreign_keys);
    assert_eq!(fk.len(), 1);
    assert_eq!(fk[0].columns, vec!["x", "y"], "{:?}", fk[0]);
    assert_eq!(fk[0].ref_columns, vec!["a", "b"], "{:?}", fk[0]);

    let d = diff::diff(&sa, &sb, &diff::DiffOptions::default());
    assert_eq!(d.tables_added, vec!["c"]);
    assert_eq!(d.routines_added.len(), 2);
    assert_eq!(d.routines_removed.len(), 3);

    let opts = ddl::SyncOptions { include_drops: true, include_routines: true, ..Default::default() };
    let script = ddl::generate(&d, &sa, &sb, &opts).unwrap();
    let sql_of = |k: SyncKind, name: &str| {
        script
            .statements
            .iter()
            .find(|s| s.kind == k && s.object == name)
            .unwrap_or_else(|| panic!("找不到 {name} 的 {k:?}"))
            .sql
            .clone()
    };
    // DROP 形式：函式帶 identity 簽章、觸發器帶所屬資料表。
    // pg_get_function_identity_arguments 會連參數名一起回（`n integer`），PG 的 DROP FUNCTION 接受。
    assert_eq!(sql_of(SyncKind::DropRoutine, "f_dead"), "DROP FUNCTION \"cmpb_rt_dst\".\"f_dead\"(n integer)");
    assert_eq!(sql_of(SyncKind::DropRoutine, "f_dtrg"), "DROP FUNCTION \"cmpb_rt_dst\".\"f_dtrg\"()");
    assert_eq!(sql_of(SyncKind::DropRoutine, "trg_dead"), "DROP TRIGGER \"trg_dead\" ON \"cmpb_rt_dst\".\"p\"");

    // 複合外鍵的 ADD CONSTRAINT 兩側各兩欄、依欄序，PG 收得下。
    let add_fk = sql_of(SyncKind::AddForeignKey, "c.c_fk");
    assert!(add_fk.contains("FOREIGN KEY (\"x\", \"y\")"), "{add_fk}");
    assert!(add_fk.contains("REFERENCES \"cmpb_rt_dst\".\"p\" (\"a\", \"b\")"), "{add_fk}");
    assert_eq!(add_fk.matches("\"x\"").count() + add_fk.matches("\"y\"").count(), 2, "{add_fk}");
    mgr.exec_ddl(id, &script.statements.iter().find(|s| s.kind == SyncKind::CreateTable).unwrap().sql).await.unwrap();
    mgr.exec_ddl(id, &add_fk).await.unwrap_or_else(|e| panic!("外鍵應可建立：{add_fk}\n{e}"));

    // 程序的 DROP 順序：觸發器排在其觸發函式之前（trg_dead 相依於 f_dtrg，反過來必然失敗）。
    let pos = |name: &str| script.statements.iter().position(|s| s.kind == SyncKind::DropRoutine && s.object == name).unwrap();
    assert!(pos("trg_dead") < pos("f_dtrg"), "觸發器必須先於其觸發函式卸除");
    assert!(
        mgr.exec_ddl(id, &sql_of(SyncKind::DropRoutine, "f_dtrg")).await.is_err(),
        "觸發器仍相依時 DROP FUNCTION 應失敗——這正是上面那個順序存在的理由"
    );
    // 照產生順序執行即可全數成功，不需要人工重排。
    for s in script.statements.iter().filter(|s| s.kind == SyncKind::DropRoutine) {
        mgr.exec_ddl(id, &s.sql).await.unwrap_or_else(|e| panic!("{}\n{e}", s.sql));
    }
    let left = schema::capture(&mgr, id, DST, "dst", &cap, None).await.unwrap();
    assert!(left.routines.is_empty(), "{:?}", left.routines.iter().map(|r| &r.info.name).collect::<Vec<_>>());

    // PG 的 pg_get_functiondef / pg_get_triggerdef 一律輸出來源 schema 限定名，跨 schema 套用
    // 等於「改到來源」（觸發器還會因同名同表已存在而失敗）→ 不得放進可執行語句，一律進 skipped。
    assert!(
        !script.statements.iter().any(|s| s.kind == SyncKind::CreateRoutine),
        "跨 schema 的 CREATE ROUTINE 不得產生語句：{:?}",
        script.statements.iter().filter(|s| s.kind == SyncKind::CreateRoutine).map(|s| &s.sql).collect::<Vec<_>>()
    );
    assert_eq!(script.skipped.len(), 2, "f_touch 與 trg_touch 各一筆：{:?}", script.skipped);
    for name in ["f_touch", "trg_touch"] {
        assert!(
            script.skipped.iter().any(|s| s.contains(name) && s.contains(SRC) && s.contains(DST)),
            "skipped 應指名物件與來源 / 目標 schema：{name} / {:?}",
            script.skipped
        );
    }

    cleanup(&mgr, id, &[SRC, DST]).await;
}

// ---------------------------------------------------------------------------
// 4. 值正規化 PG ↔ PG
// ---------------------------------------------------------------------------

/// jsonb 數值寫法、同一瞬間不同時區寫入的 timestamptz、numeric 尾零都該相等；
/// NULL 與空字串則不該相等（PG 的 null_equals_empty 預設 false）。
#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn compare_data_pg_value_normalization() {
    use crate::compare::data::{self, DataCompareOptions, TableRef};

    const SRC: &str = "cmpb_val_src";
    const DST: &str = "cmpb_val_dst";
    let id = "cmpb-val";
    let mgr = pg_mgr(id, &[SRC, DST]).await;
    let ddl = "CREATE TABLE {s}.vals (id integer NOT NULL, j jsonb, ts timestamptz, n numeric, s text, \
               CONSTRAINT vals_pkey PRIMARY KEY (id))";
    mgr.exec_ddl(id, &ddl.replace("{s}", SRC)).await.unwrap();
    mgr.exec_ddl(id, &ddl.replace("{s}", DST)).await.unwrap();
    // 同一瞬間、兩種 session 時區；jsonb 鍵序與數值寫法不同；numeric 尾零不同。
    mgr.exec_ddl(
        id,
        "SET TIME ZONE 'UTC'; \
         INSERT INTO cmpb_val_src.vals VALUES (1, '{\"b\": 2, \"a\": 1.0}', '2024-03-01 12:00:00', 1.0, 'x'); \
         INSERT INTO cmpb_val_src.vals VALUES (2, NULL, NULL, NULL, NULL);",
    )
    .await
    .unwrap();
    mgr.exec_ddl(
        id,
        "SET TIME ZONE 'Asia/Tokyo'; \
         INSERT INTO cmpb_val_dst.vals VALUES (1, '{\"a\": 1, \"b\": 2}', '2024-03-01 21:00:00', 1.00, 'x'); \
         INSERT INTO cmpb_val_dst.vals VALUES (2, NULL, NULL, NULL, '');",
    )
    .await
    .unwrap();

    let s = TableRef { conn_id: id.into(), database: SRC.into(), table: "vals".into() };
    let t = TableRef { conn_id: id.into(), database: DST.into(), table: "vals".into() };
    let r = data::compare_table(&mgr, "cmpb-val-1", &s, &t, &DataCompareOptions::default(), &no_cmp_progress)
        .await
        .unwrap();
    assert_eq!(
        (r.summary.inserts, r.summary.updates, r.summary.deletes, r.summary.compared_rows),
        (0, 1, 0, 1),
        "只有 NULL vs '' 該算差異：{:?}",
        r.samples
    );
    assert_eq!(r.summary.updates, 1);
    assert_eq!(r.samples.updates[0].changed, vec!["s"], "jsonb / timestamptz / numeric 都不該被判為差異");
    assert_eq!(r.summary.strategy_used, "merge_join");

    // null_equals_empty=true 時同一組資料應完全相同。
    let lax = DataCompareOptions { null_equals_empty: Some(true), ..Default::default() };
    let r2 = data::compare_table(&mgr, "cmpb-val-2", &s, &t, &lax, &no_cmp_progress).await.unwrap();
    assert_eq!((r2.summary.updates, r2.summary.compared_rows), (0, 2), "{:?}", r2.samples);

    cleanup(&mgr, id, &[SRC, DST]).await;
}

// ---------------------------------------------------------------------------
// 5. 文字主鍵 + collation 排序守衛
// ---------------------------------------------------------------------------

/// postgres:16 預設 en_US.utf8，ORDER BY 不是位元組序，merge_join 的順序守衛會跳；
/// 不論退到哪條路徑，計數都必須精確且與強制 HashDiff 一致。
#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn compare_data_pg_text_pk_strategy_agrees() {
    use crate::compare::data::{self, DataCompareOptions, Strategy, TableRef};

    const SRC: &str = "cmpb_key_src";
    const DST: &str = "cmpb_key_dst";
    let id = "cmpb-key";
    let mgr = pg_mgr(id, &[SRC, DST]).await;
    let ddl = "CREATE TABLE {s}.k (k text NOT NULL, v text, CONSTRAINT k_pkey PRIMARY KEY (k))";
    mgr.exec_ddl(id, &ddl.replace("{s}", SRC)).await.unwrap();
    mgr.exec_ddl(id, &ddl.replace("{s}", DST)).await.unwrap();
    mgr.exec_ddl(
        id,
        "INSERT INTO cmpb_key_src.k VALUES ('a','1'),('B','2'),('c','3'),('D','4'),('z z','5'); \
         INSERT INTO cmpb_key_dst.k VALUES ('a','9'),('B','2'),('c','3'),('z z','5'),('e','7');",
    )
    .await
    .unwrap();

    let s = TableRef { conn_id: id.into(), database: SRC.into(), table: "k".into() };
    let t = TableRef { conn_id: id.into(), database: DST.into(), table: "k".into() };
    let auto = data::compare_table(&mgr, "cmpb-key-auto", &s, &t, &DataCompareOptions::default(), &no_cmp_progress)
        .await
        .unwrap();
    let got = (auto.summary.inserts, auto.summary.updates, auto.summary.deletes, auto.summary.compared_rows);
    assert_eq!(got, (1, 1, 1, 3), "策略={} 警告={:?}", auto.summary.strategy_used, auto.summary.warnings);
    assert!(
        matches!(auto.summary.strategy_used.as_str(), "merge_join" | "hash_diff"),
        "{}",
        auto.summary.strategy_used
    );
    // postgres:16 預設 en_US.utf8（ORDER BY 給 a,B,c,D,z z），與位元組序不符 → 守衛跳、退到 hash_diff。
    // 若容器改成 C collation 會走 merge_join，計數仍須相同。
    assert_eq!(auto.summary.strategy_used, "hash_diff", "collation 若為 C 則應為 merge_join");
    assert!(!auto.summary.warnings.is_empty(), "退到 hash_diff 應留下警告");

    let forced = DataCompareOptions { strategy: Strategy::HashDiff, ..Default::default() };
    let hash = data::compare_table(&mgr, "cmpb-key-hash", &s, &t, &forced, &no_cmp_progress).await.unwrap();
    assert_eq!(hash.summary.strategy_used, "hash_diff");
    assert_eq!(
        (hash.summary.inserts, hash.summary.updates, hash.summary.deletes, hash.summary.compared_rows),
        got,
        "兩種策略的計數必須一致"
    );
    assert_eq!(hash.summary.truncated_reason, None);

    cleanup(&mgr, id, &[SRC, DST]).await;
}

// ---------------------------------------------------------------------------
// 6. 截斷：max_rows 以下不得輸出 DELETE
// ---------------------------------------------------------------------------

/// 掃描被 max_rows 截斷時，目標「多出」的列可能只是還沒掃到的來源列，因此 DELETE 一律不輸出
/// （但計數仍保留）。列數必須大於 PAGE_SIZE 才能在截斷前先看到差異。
#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn compare_data_pg_truncation_suppresses_deletes() {
    use crate::compare::data::{self, DataCompareOptions, RunMode, TableRef, TruncReason};

    const SRC: &str = "cmpb_trunc_src";
    const DST: &str = "cmpb_trunc_dst";
    let id = "cmpb-trunc";
    let mgr = pg_mgr(id, &[SRC, DST]).await;
    let ddl = "CREATE TABLE {s}.t (id integer NOT NULL, v text, CONSTRAINT t_pkey PRIMARY KEY (id))";
    mgr.exec_ddl(id, &ddl.replace("{s}", SRC)).await.unwrap();
    mgr.exec_ddl(id, &ddl.replace("{s}", DST)).await.unwrap();
    mgr.exec_ddl(id, "INSERT INTO cmpb_trunc_src.t SELECT g, 'v' || g FROM generate_series(1, 2500) g").await.unwrap();
    mgr.exec_ddl(
        id,
        "INSERT INTO cmpb_trunc_dst.t SELECT g, 'v' || g FROM generate_series(1, 2500) g; \
         INSERT INTO cmpb_trunc_dst.t SELECT -g, 'ghost' FROM generate_series(1, 5) g; \
         UPDATE cmpb_trunc_dst.t SET v = 'X' WHERE id = 1;",
    )
    .await
    .unwrap();

    let s = TableRef { conn_id: id.into(), database: SRC.into(), table: "t".into() };
    let t = TableRef { conn_id: id.into(), database: DST.into(), table: "t".into() };
    let opts = DataCompareOptions { mode: RunMode::Sql, include_deletes: true, max_rows: 2000, ..Default::default() };
    let r = data::compare_table(&mgr, "cmpb-trunc-1", &s, &t, &opts, &no_cmp_progress).await.unwrap();
    assert_eq!(r.summary.truncated_reason, Some(TruncReason::MaxRows), "{:?}", r.summary);
    assert_eq!(r.summary.deletes, 5, "負數 id 在最前面，截斷前就掃到了");
    assert!(r.summary.deletes_suppressed, "截斷時不得輸出 DELETE");
    let sql = r.sql.expect("sql 模式應回文字");
    assert!(!sql.contains("DELETE"), "{sql}");
    assert!(sql.contains("UPDATE \"cmpb_trunc_dst\".\"t\" SET \"v\" = 'v1' WHERE \"id\" = '1'"), "{sql}");

    // 不截斷時 DELETE 正常輸出。
    let full = DataCompareOptions { mode: RunMode::Sql, include_deletes: true, ..Default::default() };
    let r2 = data::compare_table(&mgr, "cmpb-trunc-2", &s, &t, &full, &no_cmp_progress).await.unwrap();
    assert_eq!(r2.summary.truncated_reason, None);
    assert!(!r2.summary.deletes_suppressed);
    assert!(r2.sql.unwrap().contains("DELETE FROM \"cmpb_trunc_dst\".\"t\" WHERE \"id\" = '-1'"));

    cleanup(&mgr, id, &[SRC, DST]).await;
}

// ---------------------------------------------------------------------------
// 7. 套用：壞列隔離
// ---------------------------------------------------------------------------

/// stop_on_error=true → 整批回滾（目標完全不變）；預設 → 逐句重放，好的套用、壞的計入 failed
/// 且 transactional 轉 false。
#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn compare_data_pg_apply_isolates_bad_rows() {
    use crate::compare::data::{self, DataCompareOptions, RunMode, TableRef};

    const SRC: &str = "cmpb_bad_src";
    const DST: &str = "cmpb_bad_dst";
    let id = "cmpb-bad";
    let mgr = pg_mgr(id, &[SRC, DST]).await;
    mgr.exec_ddl(
        id,
        "CREATE TABLE cmpb_bad_src.u (id integer NOT NULL, name text, CONSTRAINT u_pkey PRIMARY KEY (id)); \
         INSERT INTO cmpb_bad_src.u VALUES (1,'a'),(2,'a'),(3,'c'); \
         CREATE TABLE cmpb_bad_dst.u (id integer NOT NULL, name text UNIQUE, CONSTRAINT u_pkey PRIMARY KEY (id));",
    )
    .await
    .unwrap();

    let s = TableRef { conn_id: id.into(), database: SRC.into(), table: "u".into() };
    let t = TableRef { conn_id: id.into(), database: DST.into(), table: "u".into() };
    let strict = DataCompareOptions { mode: RunMode::Apply, stop_on_error: true, ..Default::default() };
    assert!(data::compare_table(&mgr, "cmpb-bad-strict", &s, &t, &strict, &no_cmp_progress).await.is_err());
    assert_eq!(scalar(&mgr, id, "SELECT COUNT(*) FROM cmpb_bad_dst.u").await.as_deref(), Some("0"), "整批應回滾");

    let lenient = DataCompareOptions { mode: RunMode::Apply, ..Default::default() };
    let r = data::compare_table(&mgr, "cmpb-bad-lenient", &s, &t, &lenient, &no_cmp_progress).await.unwrap();
    let ap = r.apply.expect("apply 模式應回套用結果");
    assert_eq!(ap.applied, 2, "{:?}", ap.errors);
    assert_eq!(ap.failed, 1);
    assert!(!ap.transactional, "有逐句重放就不算整批交易");
    assert_eq!(ap.errors.len(), 1);
    assert_eq!(scalar(&mgr, id, "SELECT COUNT(*) FROM cmpb_bad_dst.u").await.as_deref(), Some("2"));

    cleanup(&mgr, id, &[SRC, DST]).await;
}
