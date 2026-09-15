import { describe, expect, it } from "vitest";
import { applyParsedToForm, ConnFormFields, looksLikeConnectionString } from "./connString";
import { ParsedUrl } from "./api";

// 以 MySQL 的出廠預設當基準（對齊 ConnectionDialog 的 useState 初始值）。
const base = (over: Partial<ConnFormFields> = {}): ConnFormFields => ({
  kind: "mysql",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "",
  database: "",
  sslMode: "",
  sslCa: "",
  redisTls: false,
  redisTlsInsecure: false,
  mongoSrv: false,
  mongoAuthSource: "",
  mongoTls: false,
  mongoReplicaSet: "",
  mongoDirect: false,
  mongoTlsCa: "",
  mongoTlsInsecure: false,
  mssqlEncrypt: true,
  mssqlTrust: false,
  mssqlCaPath: "",
  oracleConnectType: "service",
  oracleClientDir: "",
  kafkaProtocol: "PLAINTEXT",
  kafkaSaslMech: "PLAIN",
  kafkaCaPath: "",
  kafkaSkipVerify: false,
  esAuth: "none",
  esTls: false,
  esSslCa: "",
  esSslInsecure: false,
  esKibanaUrl: "",
  rabbitVhost: "/",
  rabbitTls: false,
  rabbitMgmtUrl: "",
  ...over,
});

const parsed = (over: Partial<ParsedUrl> = {}): ParsedUrl => ({
  kind: null,
  host: null,
  port: null,
  username: null,
  password: null,
  database: null,
  options: {},
  ...over,
});

describe("looksLikeConnectionString", () => {
  it("認得已知 scheme 的 URL", () => {
    expect(looksLikeConnectionString("postgresql://ranai_user:ranai_pass_2026@localhost:5434/ranai")).toBe(true);
    expect(looksLikeConnectionString("mysql://u:p@h:3306/db")).toBe(true);
    expect(looksLikeConnectionString("mongodb+srv://u:p@cluster0.example.mongodb.net/db")).toBe(true);
    expect(looksLikeConnectionString("rediss://:tok@x.upstash.io:6379")).toBe(true);
    expect(looksLikeConnectionString("valkeys://h:6380")).toBe(true);
    expect(looksLikeConnectionString("amqps://u:p@h/vhost")).toBe(true);
    expect(looksLikeConnectionString("sqlserver://sa:pw@h:1433")).toBe(true);
  });

  it("認得 dialect+driver 後綴", () => {
    expect(looksLikeConnectionString("postgresql+psycopg2://h/db")).toBe(true);
    expect(looksLikeConnectionString("mysql+pymysql://h/db")).toBe(true);
    expect(looksLikeConnectionString("redis+tls://h:6380")).toBe(true);
  });

  it("認得 JDBC 前綴", () => {
    expect(looksLikeConnectionString("jdbc:sqlserver://h:1433;databaseName=db")).toBe(true);
    expect(looksLikeConnectionString("jdbc:oracle:thin:@//h:1521/svc")).toBe(true);
  });

  it("認得 ADO.NET / Npgsql 分號字串", () => {
    expect(looksLikeConnectionString("Server=tcp:db.example.com,1433;Database=mydb;User ID=sa;Password=pw")).toBe(true);
    expect(looksLikeConnectionString("Host=pg;Port=5432;Database=app;Username=u;Password=p")).toBe(true);
  });

  it("認得 libpq 空白字串", () => {
    expect(looksLikeConnectionString("host=localhost port=5434 dbname=ranai user=u")).toBe(true);
    expect(looksLikeConnectionString("hostaddr=10.0.0.5 dbname=d sslmode=require")).toBe(true);
  });

  it("認得 Oracle TNS descriptor 與 Kafka properties", () => {
    expect(looksLikeConnectionString("(DESCRIPTION=(ADDRESS=(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=s)))")).toBe(true);
    expect(looksLikeConnectionString("bootstrap.servers=pkc-x.confluent.cloud:9092\nsecurity.protocol=SASL_SSL")).toBe(true);
  });

  it("容忍引號與 export 前綴", () => {
    expect(looksLikeConnectionString('"postgres://h/db"')).toBe(true);
    expect(looksLikeConnectionString("export DATABASE_URL=postgres://h/db")).toBe(true);
    expect(looksLikeConnectionString('DATABASE_URL="postgres://h/db"')).toBe(true);
  });

  // ---- 負向：這些都不可以被攔（誤攔會吃掉使用者的正常輸入）----

  it("不攔裸主機名與 IP", () => {
    expect(looksLikeConnectionString("db.internal")).toBe(false);
    expect(looksLikeConnectionString("127.0.0.1")).toBe(false);
    expect(looksLikeConnectionString("localhost:5432")).toBe(false);
    expect(looksLikeConnectionString("h1:9092,h2:9092")).toBe(false);
  });

  it("不攔密碼與隨機字串", () => {
    expect(looksLikeConnectionString("ranai_pass_2026")).toBe(false);
    expect(looksLikeConnectionString("p@ssw0rd!")).toBe(false);
    // 含 :// 但 scheme 不在已知表內。
    expect(looksLikeConnectionString("weird://h/db")).toBe(false);
    expect(looksLikeConnectionString("https://es.example.com:9243")).toBe(false);
  });

  it("不攔 SQL 與含空白但無 KV 的文字", () => {
    expect(looksLikeConnectionString("SELECT 1 FROM t")).toBe(false);
    expect(looksLikeConnectionString("SELECT 1 FROM t WHERE a = 1")).toBe(false);
    expect(looksLikeConnectionString("some random text")).toBe(false);
  });

  it("不攔沒有識別鍵的 KV 文字", () => {
    expect(looksLikeConnectionString("a=1 b=2")).toBe(false);
    expect(looksLikeConnectionString("foo=1;bar=2")).toBe(false);
  });

  it("不攔空字串", () => {
    expect(looksLikeConnectionString("")).toBe(false);
    expect(looksLikeConnectionString("   ")).toBe(false);
  });
});

describe("applyParsedToForm", () => {
  it("填入使用者回報的 PostgreSQL 字串並列出變動", () => {
    const { next, changed } = applyParsedToForm(
      parsed({
        kind: "postgres",
        host: "localhost",
        port: 5434,
        username: "ranai_user",
        password: "ranai_pass_2026",
        database: "ranai",
      }),
      base(),
    );
    expect(next.kind).toBe("postgres");
    expect(next.host).toBe("localhost");
    expect(next.port).toBe(5434);
    expect(next.username).toBe("ranai_user");
    expect(next.password).toBe("ranai_pass_2026");
    expect(next.database).toBe("ranai");
    const keys = changed.map((c) => c.key);
    expect(keys).toContain("kind");
    expect(keys).toContain("port");
    expect(keys).toContain("database");
  });

  it("變動摘要只含真正改變的欄位", () => {
    // host 與 port 都與現值相同 → 不應出現在摘要裡。
    const { changed } = applyParsedToForm(
      parsed({ kind: "mysql", host: "127.0.0.1", port: 3306, username: "root" }),
      base(),
    );
    expect(changed).toEqual([]);
  });

  it("缺 port 時補該類型預設埠", () => {
    const { next } = applyParsedToForm(parsed({ kind: "postgres", host: "h" }), base());
    expect(next.port).toBe(5432);
  });

  it("換類型時重設類型專屬欄位", () => {
    const cur = base({ kind: "postgres", sslMode: "verify-full", sslCa: "/etc/ca.pem" });
    const { next } = applyParsedToForm(parsed({ kind: "mysql", host: "h" }), cur);
    // PG 的 verify-full 在 MySQL 系無此詞彙，必須清掉而不是沿用。
    expect(next.sslMode).toBe("");
    expect(next.sslCa).toBe("");
  });

  it("換類型且字串未提帳號時套用慣例預設帳號", () => {
    expect(applyParsedToForm(parsed({ kind: "kafka", host: "h" }), base()).next.username).toBe("");
    expect(applyParsedToForm(parsed({ kind: "elastic", host: "h" }), base()).next.username).toBe("");
    expect(applyParsedToForm(parsed({ kind: "rabbitmq", host: "h" }), base()).next.username).toBe("guest");
    expect(applyParsedToForm(parsed({ kind: "redis", host: "h" }), base()).next.username).toBe("");
    expect(applyParsedToForm(parsed({ kind: "postgres", host: "h" }), base()).next.username).toBe("root");
  });

  it("字串有帳號時以字串為準（含空字串）", () => {
    // redis://:pass@h 的 username 是 ""，必須套用而非退回預設。
    const { next } = applyParsedToForm(
      parsed({ kind: "redis", host: "h", username: "", password: "secret" }),
      base(),
    );
    expect(next.username).toBe("");
    expect(next.password).toBe("secret");
  });

  it("字串沒提到的欄位保留現值", () => {
    const cur = base({ kind: "postgres", database: "keepme", username: "alice" });
    const { next } = applyParsedToForm(parsed({ kind: "postgres", host: "newhost" }), cur);
    expect(next.database).toBe("keepme");
    expect(next.username).toBe("alice");
    expect(next.host).toBe("newhost");
  });

  it("未知 / external kind 不改類型，只填其他欄位", () => {
    const { next } = applyParsedToForm(parsed({ host: "h", port: 1234 }), base());
    expect(next.kind).toBe("mysql");
    expect(next.host).toBe("h");
    expect(next.port).toBe(1234);
  });

  // ---- 三個帳密遺失 bug 的回歸 ----

  it("Elastic：es_auth 必須套用，否則存檔時帳密會被清空", () => {
    const { next } = applyParsedToForm(
      parsed({ kind: "elastic", host: "https://es.example.com:9243", username: "elastic", password: "pw", options: { es_auth: "basic" } }),
      base(),
    );
    expect(next.esAuth).toBe("basic");
    expect(next.username).toBe("elastic");
    expect(next.password).toBe("pw");
  });

  it("Kafka：security protocol 必須套用，否則 SASL 帳密會被清空", () => {
    const { next } = applyParsedToForm(
      parsed({
        kind: "kafka",
        host: "pkc-x.confluent.cloud:9092",
        username: "KEY",
        password: "SECRET",
        options: { kafka_security_protocol: "SASL_SSL", kafka_sasl_mechanism: "PLAIN" },
      }),
      base(),
    );
    expect(next.kafkaProtocol).toBe("SASL_SSL");
    expect(next.kafkaSaslMech).toBe("PLAIN");
    expect(next.username).toBe("KEY");
    expect(next.password).toBe("SECRET");
  });

  it("Oracle：connect_type 必須套用，否則 SID 會被當成 service name", () => {
    const { next } = applyParsedToForm(
      parsed({ kind: "oracle", host: "h", port: 1521, database: "ORCL", options: { connect_type: "sid" } }),
      base(),
    );
    expect(next.oracleConnectType).toBe("sid");
    expect(next.database).toBe("ORCL");
  });

  // ---- options 布林的兩種編碼 ----

  it("判讀 mongo 系 \"1\" 與 redis 系 \"true\" 兩種布林編碼", () => {
    const r = applyParsedToForm(parsed({ kind: "redis", host: "h", options: { redis_tls: "true", redis_tls_insecure: "true" } }), base());
    expect(r.next.redisTls).toBe(true);
    expect(r.next.redisTlsInsecure).toBe(true);

    const m = applyParsedToForm(parsed({ kind: "mongo", host: "h", options: { mongo_srv: "1", mongo_direct: "1" } }), base());
    expect(m.next.mongoSrv).toBe(true);
    expect(m.next.mongoDirect).toBe(true);
  });

  it("mongo 的 CA / insecure 隱含開啟 TLS", () => {
    const { next } = applyParsedToForm(
      parsed({ kind: "mongo", host: "h", options: { mongo_tls_ca: "/etc/rds.pem" } }),
      base(),
    );
    expect(next.mongoTls).toBe(true);
    expect(next.mongoTlsCa).toBe("/etc/rds.pem");
  });

  it("MSSQL 的 encrypt=false 要關掉加密", () => {
    const { next } = applyParsedToForm(
      parsed({ kind: "mssql", host: "h", options: { encrypt: "false" } }),
      base(),
    );
    expect(next.mssqlEncrypt).toBe(false);
  });

  it("RabbitMQ 的 vhost 與 TLS", () => {
    const { next } = applyParsedToForm(
      parsed({ kind: "rabbitmq", host: "h", options: { rabbitmq_vhost: "myvhost", rabbitmq_tls: "1" } }),
      base(),
    );
    expect(next.rabbitVhost).toBe("myvhost");
    expect(next.rabbitTls).toBe(true);
  });
});
