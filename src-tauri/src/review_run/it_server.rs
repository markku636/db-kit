//! 端到端（真實伺服器）：MySQL 8 / PostgreSQL 16 實際執行 → 套用 rollback.sql → 整表內容必須與執行前一致。
//!
//! 需要 Docker：MySQL 127.0.0.1:13306、PostgreSQL 127.0.0.1:15432（root / postgres，密碼 test1234；
//! 與 compare::it_* 同一組容器）。執行：
//! `cargo test --no-default-features --lib review_run::it_server -- --ignored --test-threads=1`
//!
//! 傾印刻意**不用** codec.rs 的運算式（那是被測物）：MySQL 一律 `HEX(col)`、PG 用 `row_to_json`，
//! 兩者都是伺服器自己的文字化，與回滾產生器走不同的路。

use std::path::PathBuf;
use std::time::Duration;

use crate::db::{ConnectionConfig, DbKind, SshAuthMethod};
use crate::manager::ConnectionManager;

use super::report::RunStatus;
use super::run::{run, RunMode, RunOptions, RunOutcome, RunRequest};
use super::scan::split_statements;

fn cfg(kind: DbKind, id: &str, db: &str) -> ConnectionConfig {
    let (port, user) = match kind {
        DbKind::Mysql => (13306, "root"),
        _ => (15432, "postgres"),
    };
    ConnectionConfig {
        id: id.into(),
        name: id.into(),
        kind,
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
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

struct Srv {
    mgr: ConnectionManager,
    id: String,
    kind: DbKind,
    db: String,
    out: PathBuf,
}

impl Drop for Srv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.out);
    }
}

async fn connect(kind: DbKind, name: &str, db: &str) -> Srv {
    let mgr = ConnectionManager::new();
    let id = format!("rr-{name}");
    for i in 0..60 {
        match mgr.connect(cfg(kind, &id, "stressdb")).await {
            Ok(()) => break,
            Err(e) if i == 59 => panic!("連線失敗：{e:?}"),
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
    let out = std::env::temp_dir().join(format!("dbkit-rr-{name}-{}", super::capture::now_ms()));
    let s = Srv { mgr, id, kind, db: db.into(), out };
    match kind {
        DbKind::Mysql => {
            s.raw(&format!("DROP DATABASE IF EXISTS `{db}`")).await;
            s.raw(&format!("CREATE DATABASE `{db}` CHARACTER SET utf8mb4")).await;
        }
        _ => {
            s.raw(&format!("DROP SCHEMA IF EXISTS \"{db}\" CASCADE")).await;
            s.raw(&format!("CREATE SCHEMA \"{db}\"")).await;
        }
    }
    s
}

impl Srv {
    fn prefix(&self) -> String {
        match self.kind {
            DbKind::Mysql => format!("USE `{}`;\n", self.db),
            _ => format!("SET search_path TO \"{}\";\n", self.db),
        }
    }

    async fn raw(&self, sql: &str) {
        self.mgr.query(&self.id, sql).await.unwrap_or_else(|e| panic!("{e:?}\n{sql}"));
    }

    async fn exec(&self, sql: &str) {
        for (a, b) in split_statements(self.kind, sql) {
            let stmt = format!("{}{}", self.prefix(), &sql[a..b]);
            self.mgr.query(&self.id, &stmt).await.unwrap_or_else(|e| panic!("{e:?}\n{stmt}"));
        }
    }

    async fn dump(&self, table: &str) -> Vec<Vec<Option<String>>> {
        let sql = match self.kind {
            DbKind::Mysql => {
                let cols = self.mgr.table_columns(&self.id, &self.db, table).await.unwrap();
                let exprs: Vec<String> = cols.iter().map(|c| format!("HEX(`{}`)", c.name)).collect();
                format!("SELECT {} FROM `{}`.`{table}` ORDER BY 1", exprs.join(", "), self.db)
            }
            _ => format!("SELECT row_to_json(_row)::text FROM \"{}\".\"{table}\" _row ORDER BY 1", self.db),
        };
        self.mgr.query_capped(&self.id, &sql, 0).await.unwrap_or_else(|e| panic!("{e:?}\n{sql}")).rows
    }

    async fn review(&self, script: &str, mode: RunMode, options: RunOptions) -> RunOutcome {
        run(
            &self.mgr,
            &self.id,
            RunRequest {
                run_id: &format!("{}-{}", self.id, super::capture::now_ms()),
                conn_label: &self.id,
                database: &self.db,
                script,
                out_dir: &self.out,
                mode,
                options,
                review: None,
            },
            &|_| {},
        )
        .await
        .unwrap_or_else(|e| panic!("{}", e.message()))
    }

    /// 以使用者的方式套用 rollback.sql：整份丟給同一個執行器（逐句，含檔頭的 SET）。
    async fn apply_rollback(&self, o: &RunOutcome) -> String {
        let text = std::fs::read_to_string(PathBuf::from(&o.dir).join("rollback.sql")).unwrap();
        for (a, b) in split_statements(self.kind, &text) {
            let stmt = &text[a..b];
            self.mgr.query(&self.id, stmt).await.unwrap_or_else(|e| panic!("{e:?}\n{stmt}\n---\n{text}"));
        }
        text
    }
}

fn opts() -> RunOptions {
    RunOptions { max_capture_rows: 0, allow_incomplete: true, confirm_prod: true }
}

#[tokio::test]
#[ignore = "需要 Docker MySQL:13306"]
async fn mysql_types_round_trip() {
    let s = connect(DbKind::Mysql, "my-types", "rr_my").await;
    s.exec(
        "CREATE TABLE t (
            id INT PRIMARY KEY AUTO_INCREMENT,
            bin VARBINARY(300), blb BLOB, js JSON, ts TIMESTAMP(6) NULL, dt DATETIME(3), d DATE, tm TIME(3),
            dec1 DECIMAL(30,10), dbl DOUBLE, flt FLOAT, bitv BIT(8), en ENUM('a','b''c'), txt TEXT, vc VARCHAR(50),
            gen INT GENERATED ALWAYS AS (CHAR_LENGTH(vc) * 2) VIRTUAL, pt POINT NULL, yr YEAR, ui BIGINT UNSIGNED,
            upd TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         )",
    )
    .await;
    let big_bin: String = (0..280u32).map(|i| format!("{:02X}", (i * 53 + 1) % 256)).collect();
    s.exec(&format!(
        "INSERT INTO t (id, bin, blb, js, ts, dt, d, tm, dec1, dbl, flt, bitv, en, txt, vc, pt, yr, ui, upd) VALUES
         (1, X'{big_bin}', X'00FF00', '{{\"k\": \"中文 \\\\\" q\", \"n\": [1, 2.5]}}', '2024-02-29 23:59:59.123456', '2024-01-01 00:00:00.999', '1999-12-31', '-12:34:56.789',
          '12345678901234567890.0123456789', 0.1, 3.14159, b'10100101', 'b''c', 'back\\\\slash ''quote'' 😀', 'x', ST_GeomFromText('POINT(1 2)', 4326), 2024, 18446744073709551615, '2020-01-01 00:00:00'),
         (2, X'', NULL, 'null', NULL, NULL, NULL, NULL, -0.5, -0.0, 1e-30, b'0', 'a', '', NULL, NULL, NULL, 0, '2020-01-01 00:00:00'),
         (3, X'41', X'42', '[]', '1970-01-01 00:00:01', '9999-12-31 23:59:59.999', '1000-01-01', '838:59:59', 0, 1.7976931348623157e308, -3.4e38, b'11111111', NULL, NULL, 'z', NULL, 1901, 1, '2020-01-01 00:00:00')"
    ))
    .await;
    let before = s.dump("t").await;
    let script = "UPDATE t SET bin = X'DEAD', js = JSON_SET(js, '$.k', 'x'), ts = NOW(6), dbl = dbl / 2, txt = CONCAT(txt, '!') WHERE id IN (1, 3);
                  DELETE FROM t WHERE id = 2;
                  INSERT INTO t (vc, bitv, ui) VALUES ('new1', b'1', 5), ('new2', NULL, NULL);
                  INSERT INTO t (id, vc) VALUES (100, 'explicit') ON DUPLICATE KEY UPDATE vc = 'dup';
                  INSERT INTO t (id, vc) VALUES (1, 'clash') ON DUPLICATE KEY UPDATE vc = VALUES(vc)";
    let o = s.review(script, RunMode::Execute, RunOptions::default()).await;
    assert_eq!(o.manifest.status, RunStatus::Completed, "{:?} {:#?}", o.manifest.stop_reason, o.manifest.statements);
    assert_ne!(s.dump("t").await, before);
    let rb = s.apply_rollback(&o).await;
    // ON UPDATE CURRENT_TIMESTAMP 在回滾的 UPDATE 會再跳一次：upd 欄位由回滾明確寫回，所以仍應相等。
    assert_eq!(s.dump("t").await, before, "MySQL 型別往返失敗\n{rb}");
}

#[tokio::test]
#[ignore = "需要 Docker MySQL:13306"]
async fn mysql_ddl_round_trip() {
    let s = connect(DbKind::Mysql, "my-ddl", "rr_my_ddl").await;
    s.exec(
        "CREATE TABLE parent (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL, note TEXT, KEY ix_name (name));
         INSERT INTO parent VALUES (1, 'a', 'n1'), (2, 'b', NULL);
         CREATE TABLE doomed (id BIGINT PRIMARY KEY, payload JSON, created DATETIME(6));
         INSERT INTO doomed VALUES (1, '{\"a\": 1}', '2024-05-05 05:05:05.555555'), (2, NULL, NULL);",
    )
    .await;
    let parent_before = s.dump("parent").await;
    let doomed_before = s.dump("doomed").await;
    let o = s
        .review(
            "ALTER TABLE parent DROP COLUMN note; ALTER TABLE parent DROP INDEX ix_name; CREATE TABLE fresh (id INT PRIMARY KEY); DROP TABLE doomed",
            RunMode::Execute,
            opts(),
        )
        .await;
    assert_eq!(o.manifest.status, RunStatus::Completed, "{:?}", o.manifest.stop_reason);
    let rb = s.apply_rollback(&o).await;
    assert_eq!(s.dump("doomed").await, doomed_before, "{rb}");
    assert_eq!(s.dump("parent").await, parent_before, "{rb}");
    let idx = s.mgr.table_indexes(&s.id, &s.db, "parent").await.unwrap();
    assert!(idx.iter().any(|i| i.name == "ix_name"), "索引要建回來：{idx:?}\n{rb}");
    let tables = s.mgr.list_tables(&s.id, &s.db).await.unwrap();
    assert!(!tables.iter().any(|t| t.name == "fresh"), "新建的表要被刪掉\n{rb}");
}

#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn postgres_types_round_trip() {
    let s = connect(DbKind::Postgres, "pg-types", "rr_pg").await;
    s.exec(
        "CREATE TYPE mood AS ENUM ('ok', 'sad');
         CREATE TABLE t (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            b bytea, j jsonb, jt json, ts timestamptz, t timestamp(3), d date, iv interval, n numeric(40,15),
            f8 double precision, f4 real, arr text[], u uuid, bo boolean, txt text,
            g int GENERATED ALWAYS AS (length(txt)) STORED, m mood, ip inet, rng int4range
         )",
    )
    .await;
    s.exec(
        "INSERT INTO t (b, j, jt, ts, t, d, iv, n, f8, f4, arr, u, bo, txt, m, ip, rng) OVERRIDING SYSTEM VALUE VALUES
         ('\\x00ff10'::bytea, '{\"k\": \"中文 \\\" q\", \"n\": [1, 2.5]}', '{ \"spaced\" : true }', '2024-02-29 23:59:59.123456+08', '2024-01-01 00:00:00.999', 'infinity', '1 year 2 mons -3 days 04:05:06.789', 12345678901234567890.123456789012345,
          0.1, 3.14159, ARRAY['a', 'b\"c', NULL, 'd,e'], 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', true, E'line1\\nline2 \\\\ ''q''', 'sad', '192.168.0.1/24', '[1,10)'),
         (NULL, 'null', NULL, NULL, NULL, NULL, NULL, 'NaN', 'Infinity', '-0', '{}', NULL, false, '', NULL, NULL, 'empty'),
         (''::bytea, '[]', '[]', '1970-01-01 00:00:00+00', '0001-01-01 00:00:00', '4713-01-01 BC', '0', -0.000000000000001, 1.7976931348623157e308, 1e-37, NULL, NULL, NULL, NULL, 'ok', '::1', NULL)",
    )
    .await;
    let before = s.dump("t").await;
    let script = "UPDATE t SET b = '\\xdead', j = j || '{\"x\": 1}', ts = now(), f8 = f8 / 2, arr = array_append(arr, 'z') WHERE id <> 2;
                  DELETE FROM t WHERE id = 2;
                  INSERT INTO t (txt, m) VALUES ('new', 'ok');
                  INSERT INTO t (id, txt) OVERRIDING SYSTEM VALUE VALUES (1, 'clash') ON CONFLICT (id) DO UPDATE SET txt = excluded.txt";
    let o = s.review(script, RunMode::Execute, RunOptions::default()).await;
    assert_eq!(o.manifest.status, RunStatus::Completed, "{:?} {:#?}", o.manifest.stop_reason, o.manifest.statements);
    assert_ne!(s.dump("t").await, before);
    let rb = s.apply_rollback(&o).await;
    assert_eq!(s.dump("t").await, before, "PostgreSQL 型別往返失敗\n{rb}");
}

#[tokio::test]
#[ignore = "需要 Docker PostgreSQL:15432"]
async fn postgres_ddl_and_truncate_round_trip() {
    let s = connect(DbKind::Postgres, "pg-ddl", "rr_pg_ddl").await;
    s.exec(
        "CREATE TABLE a (id int PRIMARY KEY, v text NOT NULL, w numeric(10,2));
         CREATE INDEX ix_a_v ON a (v);
         INSERT INTO a VALUES (1, 'x', 1.50), (2, 'y', NULL);
         CREATE TABLE logs (msg text, at timestamptz);
         INSERT INTO logs VALUES ('dup', '2024-01-01 00:00:00+00'), ('dup', '2024-01-01 00:00:00+00');",
    )
    .await;
    let a_before = s.dump("a").await;
    let logs_before = s.dump("logs").await;
    let o = s
        .review(
            "ALTER TABLE a DROP COLUMN w; DROP INDEX ix_a_v; TRUNCATE logs; ALTER TABLE a ADD COLUMN extra int DEFAULT 7",
            RunMode::Execute,
            opts(),
        )
        .await;
    assert_eq!(o.manifest.status, RunStatus::Completed, "{:?}", o.manifest.stop_reason);
    let rb = s.apply_rollback(&o).await;
    assert_eq!(s.dump("logs").await, logs_before, "{rb}");
    assert_eq!(s.dump("a").await, a_before, "{rb}");
    let idx = s.mgr.table_indexes(&s.id, &s.db, "a").await.unwrap();
    assert!(idx.iter().any(|i| i.name == "ix_a_v"), "{idx:?}\n{rb}");
}

// ---------------------------------------------------------------------------
// SQL Server 2022（127.0.0.1:11433，sa / Test_1234!）
// docker run -d --name dbkit-rr-mssql -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Test_1234!" -p 11433:1433 mcr.microsoft.com/mssql/server:2022-latest
// ---------------------------------------------------------------------------

fn ms_cfg(id: &str, db: &str) -> ConnectionConfig {
    let mut c = cfg(DbKind::Mysql, id, db);
    c.kind = DbKind::Mssql;
    c.port = 11433;
    c.username = "sa".into();
    c.password = "Test_1234!".into();
    c.options.insert("trust_server_certificate".into(), "true".into());
    c
}

async fn connect_mssql(name: &str, db: &str) -> Srv {
    let admin = ConnectionManager::new();
    let aid = format!("rr-{name}-admin");
    for i in 0..20 {
        match admin.connect(ms_cfg(&aid, "master")).await {
            Ok(()) => break,
            Err(e) if i == 19 => panic!("SQL Server 連線失敗：{e:?}"),
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
    let q = |sql: String| {
        let admin = &admin;
        let aid = aid.clone();
        async move { admin.query(&aid, &sql).await.unwrap_or_else(|e| panic!("{e:?}\n{sql}")) }
    };
    q(format!("IF DB_ID(N'{db}') IS NOT NULL BEGIN ALTER DATABASE [{db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{db}] END")).await;
    q(format!("CREATE DATABASE [{db}]")).await;
    admin.disconnect(&aid).await;
    let mgr = ConnectionManager::new();
    let id = format!("rr-{name}");
    mgr.connect(ms_cfg(&id, db)).await.unwrap();
    let out = std::env::temp_dir().join(format!("dbkit-rr-{name}-{}", super::capture::now_ms()));
    Srv { mgr, id, kind: DbKind::Mssql, db: db.into(), out }
}

impl Srv {
    async fn ms_exec(&self, sql: &str) {
        // 測試資料走 simple_query（exec_ddl）：一般查詢路徑會把 CREATE SCHEMA 包進 sp_executesql 而語法錯誤。
        for (a, b) in split_statements(DbKind::Mssql, sql) {
            let stmt = &sql[a..b];
            self.mgr.exec_ddl(&self.id, stmt).await.unwrap_or_else(|e| panic!("{e:?}\n{stmt}"));
        }
    }

    /// 伺服器自己的二進位表示（rowversion 每次寫入都會變，不列入）。
    async fn ms_dump(&self, table: &str, cols: &[&str]) -> Vec<Vec<Option<String>>> {
        let exprs: Vec<String> = cols.iter().map(|c| format!("CONVERT(varchar(max), CAST([{c}] AS varbinary(max)), 1)")).collect();
        let sql = format!("SELECT {} FROM {table} ORDER BY 1", exprs.join(", "));
        self.mgr.query_capped(&self.id, &sql, 0).await.unwrap_or_else(|e| panic!("{e:?}\n{sql}")).rows
    }
}

#[tokio::test]
#[ignore = "需要 Docker SQL Server:11433"]
async fn mssql_types_identity_and_schema_round_trip() {
    let s = connect_mssql("ms-types", "rr_ms").await;
    s.ms_exec(
        "CREATE TABLE dbo.t (
            id int IDENTITY(1,1) PRIMARY KEY,
            nv nvarchar(50), v varchar(20), vb varbinary(max), dt2 datetime2(7), dt datetime, dto datetimeoffset(7),
            d date, tm time(7), dec1 decimal(38,10), f float, r real, m money, b bit, g uniqueidentifier,
            x xml, geo geography, calc AS (LEN(nv) * 2), rv rowversion
         )
         GO
         CREATE SCHEMA sales
         GO
         CREATE TABLE sales.items (code nvarchar(10) NOT NULL PRIMARY KEY, qty int, price decimal(9,2))",
    )
    .await;
    let blob: String = (0..300u32).map(|i| format!("{:02X}", (i * 71 + 3) % 256)).collect();
    s.ms_exec(&format!(
        "INSERT INTO dbo.t (nv, v, vb, dt2, dt, dto, d, tm, dec1, f, r, m, b, g, x, geo) VALUES
         (N'中文 ''q'' 😀', 'ascii', 0x{blob}, '2024-02-29T23:59:59.1234567', '2024-01-02T03:04:05.997', '2024-02-29T23:59:59.1234567+08:00',
          '0001-01-01', '23:59:59.9999999', 1234567890123456789012345678.0123456789, 0.1, 3.14159, 922337203685477.5807, 1, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          N'<a x=\"1\">t&amp;</a>', geography::STGeomFromText('POINT(121.5 25.03)', 4326)),
         (N'', NULL, 0x, NULL, NULL, NULL, NULL, NULL, -0.0000000001, -1.7976931348623157E+308, NULL, -0.0001, 0, NULL, NULL, NULL),
         (NULL, NULL, NULL, '9999-12-31T23:59:59.9999999', '1753-01-01T00:00:00', '0001-01-01T00:00:00-14:00', '9999-12-31', '00:00:00', 0, 1e-300, 1e-38, 0, NULL, NULL, N'<r/>', NULL)
         GO
         INSERT INTO sales.items VALUES (N'A1', 1, 9.99), (N'B2', NULL, NULL)"
    ))
    .await;
    let cols = ["id", "nv", "v", "vb", "dt2", "dt", "dto", "d", "tm", "dec1", "f", "r", "m", "b", "g", "x", "geo", "calc"];
    let before = s.ms_dump("dbo.t", &cols).await;
    let items_before = s.ms_dump("sales.items", &["code", "qty", "price"]).await;
    let script = "UPDATE dbo.t SET nv = N'改', vb = 0xDEAD, dto = SYSDATETIMEOFFSET(), f = f / 2 WHERE id <> 2;
                  DELETE FROM dbo.t WHERE id = 2;
                  INSERT INTO dbo.t (nv) VALUES (N'new');
                  UPDATE i SET i.qty = 42 FROM sales.items i WHERE i.code = N'A1';
                  DELETE FROM sales.items WHERE code = N'B2'";
    let o = s.review(script, RunMode::Execute, RunOptions::default()).await;
    assert_eq!(o.manifest.status, RunStatus::Completed, "{:?} {:#?}", o.manifest.stop_reason, o.manifest.statements);
    assert_ne!(s.ms_dump("dbo.t", &cols).await, before);
    let rb = s.apply_rollback(&o).await;
    assert_eq!(s.ms_dump("dbo.t", &cols).await, before, "SQL Server 型別往返失敗\n{rb}");
    assert_eq!(s.ms_dump("sales.items", &["code", "qty", "price"]).await, items_before, "{rb}");
}

#[tokio::test]
#[ignore = "需要 Docker SQL Server:11433"]
async fn mssql_ddl_round_trip() {
    let s = connect_mssql("ms-ddl", "rr_ms_ddl").await;
    s.ms_exec(
        "CREATE TABLE dbo.a (id int NOT NULL PRIMARY KEY, name nvarchar(20) NOT NULL, note nvarchar(max) NULL)
         GO
         CREATE INDEX ix_a_name ON dbo.a (name)
         GO
         INSERT INTO dbo.a VALUES (1, N'x', N'n1'), (2, N'y', NULL)
         GO
         CREATE TABLE dbo.doomed (id bigint NOT NULL PRIMARY KEY, payload varbinary(100) NULL)
         GO
         INSERT INTO dbo.doomed VALUES (1, 0x0102), (2, NULL)",
    )
    .await;
    let a_before = s.ms_dump("dbo.a", &["id", "name", "note"]).await;
    let d_before = s.ms_dump("dbo.doomed", &["id", "payload"]).await;
    let o = s
        .review("DROP INDEX ix_a_name ON dbo.a; ALTER TABLE dbo.a DROP COLUMN note; DROP TABLE dbo.doomed", RunMode::Execute, opts())
        .await;
    assert_eq!(o.manifest.status, RunStatus::Completed, "{:?}", o.manifest.stop_reason);
    let rb = s.apply_rollback(&o).await;
    assert_eq!(s.ms_dump("dbo.doomed", &["id", "payload"]).await, d_before, "{rb}");
    assert_eq!(s.ms_dump("dbo.a", &["id", "name", "note"]).await, a_before, "{rb}");
    let idx = s.mgr.table_indexes(&s.id, &s.db, "a").await.unwrap();
    assert!(idx.iter().any(|i| i.name == "ix_a_name"), "{idx:?}\n{rb}");
}
