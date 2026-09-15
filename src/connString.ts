// 連線字串的「貼上即解析」支援：前端便宜判別 + 解析結果 → 表單欄位的純映射。
//
// 為什麼要有前端判別：真正的解析在後端（parse_connection_url，與 dbk --url 同一套），但
// 「使用者剛才貼進主機欄的這段文字，到底是連線字串還是單純的主機名？」這個問題必須在
// 發 IPC 之前就答完，否則每次貼上都要往返一次、而且貼密碼時會被誤攔。
//
// 判別原則：**保守優先**。寧可漏判（使用者自己去用上方的連線字串欄）也不要劫持一次正常的貼上——
// 誤攔的後果是使用者的輸入被吃掉、表單欄位還被改寫，比沒有這個功能更糟。

import { DbKind, KIND_META, ParsedUrl } from "./api";

// ---------------------------------------------------------------------------
// 判別
// ---------------------------------------------------------------------------

// 已知 scheme：必須與後端 db/conn_url/mod.rs 的 scheme_kind 對照表一致。
// 刻意**不含** http / https —— Elastic 的「節點 URL」欄位本來就收完整 URL，
// 攔下來反而是幫倒忙（見 ConnectionDialog 的 esHostIsUrl）。
const KNOWN_SCHEMES = new Set([
  "mysql", "mariadb", "postgres", "postgresql",
  "mongodb", "mongodb+srv", "mongo",
  "redis", "rediss", "valkey", "valkeys",
  "mssql", "sqlserver", "oracle", "kafka",
  "elasticsearch", "opensearch", "elastic",
  "amqp", "amqps", "sqlite",
]);

// libpq 專屬鍵（與後端 LIBPQ_MARKERS 一致）：與 ADO.NET 的識別鍵不重疊，故可當判別依據。
const LIBPQ_MARKERS = ["host", "hostaddr", "dbname", "sslmode", "sslrootcert", "application_name"];

// 分號 KV 的位址 / 資料庫識別鍵（ADO.NET + Npgsql 聯集，與後端 SEMICOLON_MARKERS 一致）。
const SEMICOLON_MARKERS = [
  "server", "data source", "address", "addr", "network address",
  "database", "initial catalog", "databasename", "host",
];

/** 剝掉外層引號與 `export NAME=` 前綴（後端 normalize 的最小前端鏡像，只為判別用）。 */
function stripNoise(text: string): string {
  let s = text.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === "`") && s[s.length - 1] === s[0]) {
      s = s.slice(1, -1).trim();
    }
    s = s.replace(/^export\s+/i, "");
    // 只剝「全大寫變數名 = 含 :// 的值」——小寫的 host=… 是 libpq 字串本體，不可剝。
    const env = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(s);
    if (env && env[2].includes("://")) s = env[2].trim();
    if (s === before) break;
  }
  return s;
}

/** 以 sep 切段後，是否每一段都是 `key=value`（空段忽略）。 */
function allTokensAreKv(s: string, sep: RegExp): boolean {
  const parts = s.split(sep).filter((t) => t.length > 0);
  return parts.length >= 2 && parts.every((t) => t.includes("="));
}

/** 以 sep 切段後，是否命中任一識別鍵。 */
function hasMarker(s: string, sep: RegExp, markers: string[]): boolean {
  return s.split(sep).some((seg) => {
    const eq = seg.indexOf("=");
    if (eq <= 0) return false;
    return markers.includes(seg.slice(0, eq).trim().toLowerCase());
  });
}

/**
 * 這段文字看起來是連線字串嗎？
 *
 * 命中任一即為真：已知 scheme 的 URL（含 `dialect+driver` 後綴）、`jdbc:` 前綴、
 * Oracle TNS descriptor、Kafka properties、分號 KV（ADO.NET / Npgsql）、libpq 空白 KV。
 *
 * 明確**不**命中：裸主機名、單一 token、含空白但無 `=` 的句子（如 SQL 片段）、
 * 未知 scheme 的 URL（含 http/https）。
 */
export function looksLikeConnectionString(text: string): boolean {
  const s = stripNoise(text);
  if (!s) return false;

  // 1. scheme://（未知 scheme 一律不攔——可能是使用者要貼進 Elastic 節點 URL 之類的欄位）
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//.exec(s);
  if (m) {
    const scheme = m[1].toLowerCase();
    return KNOWN_SCHEMES.has(scheme) || KNOWN_SCHEMES.has(scheme.split("+")[0]);
  }

  // 2. JDBC（dialect 白名單由後端把關，前端只認前綴）
  if (/^jdbc:/i.test(s)) return true;

  // 3. Oracle TNS descriptor
  if (s.startsWith("(") && /\(\s*DESCRIPTION\s*=/i.test(s)) return true;

  // 4. Kafka properties（點號鍵與其他方言不重疊）
  if (/(^|[\s;])bootstrap\.servers\s*=/i.test(s)) return true;

  // 5. 分號 KV（ADO.NET / Npgsql）。`;` 的存在 + 識別鍵即足夠，不要求每段都是 KV
  //    （ODBC 的 `Driver={...}` 等段落形式較雜）。
  if (s.includes(";") && hasMarker(s, /;/, SEMICOLON_MARKERS)) return true;

  // 6. libpq 空白 KV。三條缺一不可，見後端 conn_url/mod.rs 的偵測優先序註解。
  if (/\s/.test(s) && allTokensAreKv(s, /\s+/) && hasMarker(s, /\s+/, LIBPQ_MARKERS)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// 解析結果 → 表單欄位
// ---------------------------------------------------------------------------

/**
 * 匯入會動到的表單欄位快照。
 *
 * 只收「連線字串有可能填到」的欄位——名稱 / SSH / OTP / prod / 唯讀都不在內，
 * 因為匯入不碰它們，復原也就不需要還原它們。這一份型別同時服務三件事：
 * 快照（復原用）、純映射的輸入與輸出、以及變動摘要的 diff 來源。
 */
export interface ConnFormFields {
  kind: DbKind;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  // MySQL / MariaDB / PostgreSQL
  sslMode: string;
  sslCa: string;
  // Redis
  redisTls: boolean;
  redisTlsInsecure: boolean;
  // MongoDB
  mongoSrv: boolean;
  mongoAuthSource: string;
  mongoTls: boolean;
  mongoReplicaSet: string;
  mongoDirect: boolean;
  mongoTlsCa: string;
  mongoTlsInsecure: boolean;
  // SQL Server
  mssqlEncrypt: boolean;
  mssqlTrust: boolean;
  mssqlCaPath: string;
  // Oracle
  oracleConnectType: string;
  oracleClientDir: string;
  // Kafka
  kafkaProtocol: string;
  kafkaSaslMech: string;
  kafkaCaPath: string;
  kafkaSkipVerify: boolean;
  // Elasticsearch / OpenSearch
  esAuth: string;
  esTls: boolean;
  esSslCa: string;
  esSslInsecure: boolean;
  esKibanaUrl: string;
  // RabbitMQ
  rabbitVhost: string;
  rabbitTls: boolean;
  rabbitMgmtUrl: string;
}

/** 單一欄位的變動（供「已填入」摘要渲染；label 與遮罩由呼叫端決定）。 */
export interface ChangedField {
  key: keyof ConnFormFields;
  from: string | number | boolean;
  to: string | number | boolean;
}

export interface ApplyResult {
  next: ConnFormFields;
  changed: ChangedField[];
}

// 類型專屬欄位的預設值：換類型時一併重設，避免帶著前一個類型的殘值
// （ssl_mode 詞彙 PG「require」與 MySQL 系「required」不同，跨類型沿用會直接連不上）。
const KIND_SCOPED_DEFAULTS: Omit<ConnFormFields, "kind" | "host" | "port" | "username" | "password" | "database"> = {
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
  // mssql 的加密預設為開（對齊 ConnectionDialog 的初始值與 mssql.rs 的 encrypt!="false"）。
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
};

/**
 * 各類型的慣例預設帳號。換類型且字串未提帳號時套用，否則會留著前一個類型的殘值
 * （例：從 MySQL 換到 Redis 卻還掛著 `root`）。
 * kafka / elastic 無 root 慣例；rabbitmq 為 guest；redis 6.0 前無帳號概念（ACL 預設 `default`）。
 */
function defaultUsername(kind: DbKind): string {
  if (kind === "kafka" || kind === "elastic" || kind === "redis") return "";
  if (kind === "rabbitmq") return "guest";
  return "root";
}

/** options map 的布林編碼有兩種（mongo 系 "1" / redis 系 "true"），統一在此判讀。 */
function optBool(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

/**
 * 解析結果套進表單欄位（純函式，不碰 React state）。
 *
 * 語意：**字串沒提到的欄位保留現值**（使用者可能先手填一半再貼上補齊），
 * 只有兩個例外——換類型時重設類型專屬欄位，以及換類型且未提帳號時套用慣例預設帳號。
 */
export function applyParsedToForm(p: ParsedUrl, cur: ConnFormFields): ApplyResult {
  // 後端可能先於前端認識新 kind（分階段上線）；未知 kind 不索引 KIND_META，只填主機等欄位。
  const knownKind = p.kind && p.kind !== "external" && p.kind in KIND_META ? p.kind : null;

  let next: ConnFormFields = { ...cur };

  if (knownKind) {
    if (knownKind !== cur.kind) {
      next = { ...next, ...KIND_SCOPED_DEFAULTS, kind: knownKind };
      next.username = defaultUsername(knownKind);
    }
    next.kind = knownKind;
    // port 用解析值，缺省補該 kind 預設（不沿用前一個 kind 的埠）。
    next.port = p.port ?? KIND_META[knownKind].defaultPort;
  } else if (p.port != null) {
    next.port = p.port;
  }

  if (p.host) next.host = p.host;
  // `!= null` 而非 truthy：空字串是有意義的值（redis://:pass@ 的 username 就是 ""）。
  if (p.username != null) next.username = p.username;
  if (p.password != null) next.password = p.password;
  if (p.database != null) next.database = p.database;

  const o = p.options ?? {};
  if (o.ssl_mode != null) next.sslMode = o.ssl_mode;
  if (o.ssl_ca != null) next.sslCa = o.ssl_ca;
  if (o.redis_tls != null) next.redisTls = optBool(o.redis_tls);
  if (o.redis_tls_insecure != null) next.redisTlsInsecure = optBool(o.redis_tls_insecure);
  if (o.mongo_srv != null) next.mongoSrv = optBool(o.mongo_srv);
  if (o.mongo_auth_source != null) next.mongoAuthSource = o.mongo_auth_source;
  if (o.mongo_replica_set != null) next.mongoReplicaSet = o.mongo_replica_set;
  if (o.mongo_direct != null) next.mongoDirect = optBool(o.mongo_direct);
  if (o.mongo_tls_ca != null) next.mongoTlsCa = o.mongo_tls_ca;
  if (o.mongo_tls_insecure != null) next.mongoTlsInsecure = optBool(o.mongo_tls_insecure);
  // tlsCAFile / tlsAllowInvalidCertificates 隱含 TLS（Atlas / DocumentDB 字串常不帶 tls=true）——
  // 不連動 mongo_tls 的話 CA 欄位會被 gate 隱藏、buildOptions 會把匯入值靜默剔除。
  if (o.mongo_tls != null || o.mongo_tls_ca != null || o.mongo_tls_insecure != null) {
    next.mongoTls = o.mongo_tls != null ? optBool(o.mongo_tls) : true;
  }
  if (o.encrypt != null) next.mssqlEncrypt = o.encrypt !== "false";
  if (o.trust_server_certificate != null) next.mssqlTrust = optBool(o.trust_server_certificate);
  if (o.trust_cert_ca != null) next.mssqlCaPath = o.trust_cert_ca;
  // Oracle：沒有這條，SID 字串匯入後會靜默被當成 service name 連線。
  if (o.connect_type != null) next.oracleConnectType = o.connect_type;
  if (o.client_dir != null) next.oracleClientDir = o.client_dir;
  // Kafka：沒有這兩條，protocol 會留在 PLAINTEXT，而 build() 的 usesAuth 會把 SASL 帳密清空存檔。
  if (o.kafka_security_protocol != null) next.kafkaProtocol = o.kafka_security_protocol;
  if (o.kafka_sasl_mechanism != null) next.kafkaSaslMech = o.kafka_sasl_mechanism;
  if (o.kafka_ssl_ca != null) next.kafkaCaPath = o.kafka_ssl_ca;
  if (o.kafka_ssl_insecure != null) next.kafkaSkipVerify = optBool(o.kafka_ssl_insecure);
  // Elastic：沒有 es_auth 這條，認證方式會留在 none，而 build() 的 usesAuth 會把帳密清空存檔。
  if (o.es_auth != null) next.esAuth = o.es_auth;
  if (o.es_tls != null) next.esTls = optBool(o.es_tls);
  if (o.es_ssl_ca != null) next.esSslCa = o.es_ssl_ca;
  if (o.es_ssl_insecure != null) next.esSslInsecure = optBool(o.es_ssl_insecure);
  if (o.es_kibana_url != null) next.esKibanaUrl = o.es_kibana_url;
  if (o.rabbitmq_vhost != null) next.rabbitVhost = o.rabbitmq_vhost;
  if (o.rabbitmq_tls != null) next.rabbitTls = optBool(o.rabbitmq_tls);
  if (o.rabbitmq_mgmt_url != null) next.rabbitMgmtUrl = o.rabbitmq_mgmt_url;

  return { next, changed: diffFields(cur, next) };
}

/** 逐欄比對，回傳真正變動的欄位（順序固定＝ConnFormFields 的宣告順序，摘要讀起來才穩定）。 */
export function diffFields(before: ConnFormFields, after: ConnFormFields): ChangedField[] {
  const out: ChangedField[] = [];
  for (const key of Object.keys(after) as (keyof ConnFormFields)[]) {
    if (before[key] !== after[key]) out.push({ key, from: before[key], to: after[key] });
  }
  return out;
}
