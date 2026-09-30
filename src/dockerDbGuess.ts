// 從 Docker 容器推測「這是哪種資料庫、怎麼連」，產生新增連線對話框的預填值（純函式，可單測）。
//
// 依據：映像名稱判斷類型、發布的埠決定連線埠、官方映像慣用的環境變數取帳密與預設資料庫。
// 主機用 Docker daemon 的位址（本機 daemon → 127.0.0.1）；Docker 連線走 SSH 通道時一併沿用同一組 SSH 設定。

import type { ConnectionConfig, DbKind } from "./api";
import type { DockerContainerDetail, DockerPort } from "./dockerTypes";
import { dockerHostAddress, envMap } from "./dockerModel";

interface Rule {
  kind: DbKind;
  port: number;
  /** 映像名（去掉 registry 與 tag）比對。 */
  match: RegExp;
  creds: (env: Record<string, string>, repo: string) => { username: string; password: string; database: string };
  options?: Record<string, string>;
}

const first = (env: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) if (env[k]) return env[k];
  return "";
};

// 順序有意義：mariadb 要在 mysql 前（bitnami/mariadb 不該被 mysql 規則吃掉）。
const RULES: Rule[] = [
  {
    kind: "mariadb",
    port: 3306,
    match: /(^|\/)mariadb$/,
    creds: (e) => ({
      username: first(e, "MARIADB_USER", "MYSQL_USER") && !first(e, "MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD")
        ? first(e, "MARIADB_USER", "MYSQL_USER") : "root",
      password: first(e, "MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD") || first(e, "MARIADB_PASSWORD", "MYSQL_PASSWORD"),
      database: first(e, "MARIADB_DATABASE", "MYSQL_DATABASE"),
    }),
  },
  {
    kind: "mysql",
    port: 3306,
    match: /(^|\/)(mysql|mysql-server|percona|percona-server)$/,
    creds: (e) => ({
      username: first(e, "MYSQL_USER") && !first(e, "MYSQL_ROOT_PASSWORD") ? first(e, "MYSQL_USER") : "root",
      password: first(e, "MYSQL_ROOT_PASSWORD") || first(e, "MYSQL_PASSWORD"),
      database: first(e, "MYSQL_DATABASE"),
    }),
  },
  {
    kind: "postgres",
    port: 5432,
    match: /(^|\/)(postgres|postgresql|postgis|timescaledb(-ha)?|pgvector)$/,
    creds: (e) => {
      const username = first(e, "POSTGRES_USER", "POSTGRESQL_USERNAME") || "postgres";
      return {
        username,
        password: first(e, "POSTGRES_PASSWORD", "POSTGRESQL_PASSWORD"),
        database: first(e, "POSTGRES_DB", "POSTGRESQL_DATABASE") || username,
      };
    },
  },
  {
    kind: "mssql",
    port: 1433,
    match: /(^|\/)(mssql\/server|azure-sql-edge)$/,
    creds: (e) => ({ username: "sa", password: first(e, "MSSQL_SA_PASSWORD", "SA_PASSWORD"), database: "" }),
    options: { encrypt: "true", trust_server_certificate: "true" },
  },
  {
    kind: "mongo",
    port: 27017,
    match: /(^|\/)(mongo|mongodb|mongodb-community-server)$/,
    creds: (e) => ({
      username: first(e, "MONGO_INITDB_ROOT_USERNAME", "MONGODB_ROOT_USER"),
      password: first(e, "MONGO_INITDB_ROOT_PASSWORD", "MONGODB_ROOT_PASSWORD"),
      database: first(e, "MONGO_INITDB_DATABASE", "MONGODB_DATABASE"),
    }),
  },
  {
    kind: "redis",
    port: 6379,
    match: /(^|\/)(redis|redis-stack|redis-stack-server|valkey|keydb)$/,
    creds: (e) => ({ username: "", password: first(e, "REDIS_PASSWORD", "VALKEY_PASSWORD"), database: "" }),
  },
  {
    kind: "rabbitmq",
    port: 5672,
    match: /(^|\/)rabbitmq$/,
    creds: (e) => ({
      username: first(e, "RABBITMQ_DEFAULT_USER", "RABBITMQ_USERNAME") || "guest",
      password: first(e, "RABBITMQ_DEFAULT_PASS", "RABBITMQ_PASSWORD") || "guest",
      database: "",
    }),
  },
  {
    kind: "elastic",
    port: 9200,
    match: /(^|\/)(elasticsearch|opensearch)$/,
    creds: (e) => {
      if (e.OPENSEARCH_INITIAL_ADMIN_PASSWORD) return { username: "admin", password: e.OPENSEARCH_INITIAL_ADMIN_PASSWORD, database: "" };
      return { username: e.ELASTIC_PASSWORD ? "elastic" : "", password: e.ELASTIC_PASSWORD ?? "", database: "" };
    },
  },
  {
    kind: "kafka",
    port: 9092,
    match: /(^|\/)(kafka|cp-kafka|cp-server)$/,
    creds: () => ({ username: "", password: "", database: "" }),
  },
  {
    kind: "oracle",
    port: 1521,
    match: /(^|\/)(oracle-xe|oracle-free|database\/(free|express|enterprise))$/,
    // 預設 PDB 服務名：Free → FREEPDB1、XE → XEPDB1（ORACLE_DATABASE 另建的 PDB 以它為準）。
    creds: (e, repo) => ({
      username: e.APP_USER || "system",
      password: e.APP_USER ? e.APP_USER_PASSWORD ?? "" : first(e, "ORACLE_PASSWORD", "ORACLE_PWD"),
      database: e.ORACLE_DATABASE || (/free/.test(repo) ? "FREEPDB1" : /xe|express/.test(repo) ? "XEPDB1" : ""),
    }),
  },
];

/** `docker.io/library/postgres:16-alpine@sha256:…` → `postgres`；`bitnami/postgresql:16` → `bitnami/postgresql`。 */
export function imageRepo(image: string): string {
  let s = image.split("@")[0];
  const lastSlash = s.lastIndexOf("/");
  const colon = s.lastIndexOf(":");
  if (colon > lastSlash) s = s.slice(0, colon);
  const parts = s.split("/");
  // 去掉 registry 段（含 . 或 : 或 localhost）與 docker hub 的 library/。
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === "localhost")) parts.shift();
  if (parts[0] === "library") parts.shift();
  return parts.join("/").toLowerCase();
}

/** 推測結果。`published=false` 表示沒發布埠：只能用容器 IP（Docker 在本機 Linux 才連得到）。 */
export interface DbGuess {
  kind: DbKind;
  host: string;
  port: number;
  published: boolean;
  prefill: Partial<ConnectionConfig>;
}

function pickPort(ports: DockerPort[], want: number): DockerPort | undefined {
  return ports.find((p) => p.private_port === want && p.public_port != null && (p.proto || "tcp") === "tcp");
}

/**
 * 推測容器是哪種資料庫並組出預填值；認不得回 null。
 * `docker` 為來源 Docker 連線：決定主機位址，並沿用它的 SSH 通道設定。
 */
export function guessDbFromContainer(
  c: DockerContainerDetail,
  docker: Pick<ConnectionConfig, "host" | "ssh_enabled" | "ssh_host" | "ssh_port" | "ssh_username" | "ssh_auth_method" | "ssh_private_key_path">,
): DbGuess | null {
  const repo = imageRepo(c.image);
  const rule = RULES.find((r) => r.match.test(repo));
  if (!rule) return null;
  const env = envMap(c.env);
  const creds = rule.creds(env, repo);
  const pub = pickPort(c.ports, rule.port);
  let host: string;
  let port: number;
  if (pub) {
    // 綁在特定 IP（非 0.0.0.0 / :: / 127.0.0.1）時就連那個 IP；否則用 daemon 位址。
    const bound = pub.ip && !["0.0.0.0", "::", "127.0.0.1", "::1"].includes(pub.ip) ? pub.ip : "";
    host = bound || dockerHostAddress(docker);
    port = pub.public_port!;
  } else {
    host = c.networks.find((n) => n.ip)?.ip || dockerHostAddress(docker);
    port = rule.port;
  }
  const prefill: Partial<ConnectionConfig> = {
    kind: rule.kind,
    name: c.name,
    host,
    port,
    username: creds.username,
    password: creds.password,
    database: creds.database || null,
    options: rule.options ? { ...rule.options } : undefined,
  };
  if (docker.ssh_enabled) {
    prefill.ssh_enabled = true;
    prefill.ssh_host = docker.ssh_host;
    prefill.ssh_port = docker.ssh_port;
    prefill.ssh_username = docker.ssh_username;
    prefill.ssh_auth_method = docker.ssh_auth_method;
    prefill.ssh_private_key_path = docker.ssh_private_key_path;
  }
  return { kind: rule.kind, host, port, published: !!pub, prefill };
}

/** 只看映像名的快速判斷（右鍵選單決定要不要顯示「建立資料庫連線」用，不需 inspect）。 */
export function looksLikeDbImage(image: string): boolean {
  const repo = imageRepo(image);
  return RULES.some((r) => r.match.test(repo));
}

/**
 * 只依映像與環境變數推測（Kubernetes 用：沒有「發布埠」，連線走 port-forward）。
 * 回傳 DB 類型、慣用埠、帳密與 kind 專屬 options；認不得回 null。
 */
export function guessDbFromImage(
  image: string,
  env: Record<string, string>,
): { kind: DbKind; port: number; username: string; password: string; database: string; options?: Record<string, string> } | null {
  const repo = imageRepo(image);
  const rule = RULES.find((r) => r.match.test(repo));
  if (!rule) return null;
  return { kind: rule.kind, port: rule.port, ...rule.creds(env, repo), options: rule.options ? { ...rule.options } : undefined };
}
