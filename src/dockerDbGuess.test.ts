import { describe, expect, it } from "vitest";
import { guessDbFromContainer, imageRepo, looksLikeDbImage } from "./dockerDbGuess";
import type { DockerContainerDetail } from "./dockerTypes";

const detail = (over: Partial<DockerContainerDetail>): DockerContainerDetail => ({
  id: "abc",
  name: "db",
  image: "postgres:16",
  image_id: "sha256:1",
  created: "",
  state: "running",
  running: true,
  paused: false,
  restarting: false,
  oom_killed: false,
  pid: 1,
  exit_code: 0,
  error: "",
  started_at: "",
  finished_at: "",
  restart_count: 0,
  restart_policy: "",
  health: "",
  health_log: [],
  tty: false,
  hostname: "",
  user: "",
  working_dir: "",
  entrypoint: [],
  cmd: [],
  env: [],
  labels: {},
  ports: [],
  mounts: [],
  networks: [],
  network_mode: "",
  raw: "",
  ...over,
});

const local = { host: "", ssh_enabled: false };

describe("imageRepo", () => {
  it("去掉 registry / library / tag / digest", () => {
    expect(imageRepo("postgres:16-alpine")).toBe("postgres");
    expect(imageRepo("docker.io/library/mysql:8")).toBe("mysql");
    expect(imageRepo("mcr.microsoft.com/mssql/server:2022-latest")).toBe("mssql/server");
    expect(imageRepo("localhost:5000/team/redis@sha256:ab")).toBe("team/redis");
    expect(imageRepo("bitnami/postgresql")).toBe("bitnami/postgresql");
  });
});

describe("guessDbFromContainer", () => {
  it("postgres：發布埠 + POSTGRES_* 帳密，本機 daemon 走 127.0.0.1", () => {
    const g = guessDbFromContainer(
      detail({
        image: "postgres:16",
        env: ["POSTGRES_USER=app", "POSTGRES_PASSWORD=s3cret", "POSTGRES_DB=shop"],
        ports: [{ private_port: 5432, public_port: 15432, ip: "0.0.0.0", proto: "tcp" }],
      }),
      local,
    )!;
    expect(g.kind).toBe("postgres");
    expect(g.published).toBe(true);
    expect(g.prefill).toMatchObject({ host: "127.0.0.1", port: 15432, username: "app", password: "s3cret", database: "shop" });
  });

  it("postgres 沒設 POSTGRES_USER → postgres / 資料庫同名", () => {
    const g = guessDbFromContainer(detail({ env: ["POSTGRES_PASSWORD=x"] }), local)!;
    expect(g.prefill).toMatchObject({ username: "postgres", database: "postgres" });
  });

  it("mariadb 不被 mysql 規則吃掉；root 密碼優先", () => {
    const g = guessDbFromContainer(detail({ image: "mariadb:11", env: ["MARIADB_ROOT_PASSWORD=r", "MARIADB_DATABASE=d"] }), local)!;
    expect(g.kind).toBe("mariadb");
    expect(g.prefill).toMatchObject({ username: "root", password: "r", database: "d" });
  });

  it("mysql 只有一般使用者時用該使用者", () => {
    const g = guessDbFromContainer(
      detail({ image: "mysql:8", env: ["MYSQL_USER=u", "MYSQL_PASSWORD=p", "MYSQL_RANDOM_ROOT_PASSWORD=yes"] }),
      local,
    )!;
    expect(g.prefill).toMatchObject({ username: "u", password: "p" });
  });

  it("mssql：sa + 信任伺服器憑證", () => {
    const g = guessDbFromContainer(
      detail({ image: "mcr.microsoft.com/mssql/server:2022-latest", env: ["MSSQL_SA_PASSWORD=Pw1!"] }),
      local,
    )!;
    expect(g.kind).toBe("mssql");
    expect(g.prefill.options).toMatchObject({ trust_server_certificate: "true" });
    expect(g.prefill).toMatchObject({ username: "sa", password: "Pw1!" });
  });

  it("遠端 TCP daemon 用其主機名；沿用 SSH 設定", () => {
    const g = guessDbFromContainer(
      detail({ image: "redis:7", ports: [{ private_port: 6379, public_port: 6380, ip: "0.0.0.0", proto: "tcp" }] }),
      { host: "tcp://build01.lan:2376", ssh_enabled: true, ssh_host: "jump", ssh_port: 22, ssh_username: "ops" },
    )!;
    expect(g.prefill).toMatchObject({ kind: "redis", host: "build01.lan", port: 6380, ssh_enabled: true, ssh_host: "jump" });
  });

  it("綁在特定 IP 時連那個 IP", () => {
    const g = guessDbFromContainer(
      detail({ image: "mongo", ports: [{ private_port: 27017, public_port: 27018, ip: "10.1.2.3", proto: "tcp" }] }),
      local,
    )!;
    expect(g.prefill).toMatchObject({ host: "10.1.2.3", port: 27018 });
  });

  it("沒發布埠 → 退回容器 IP 與預設埠，published=false", () => {
    const g = guessDbFromContainer(
      detail({ networks: [{ name: "bridge", ip: "172.17.0.5", gateway: "", mac: "", aliases: [] }] }),
      local,
    )!;
    expect(g.published).toBe(false);
    expect(g.prefill).toMatchObject({ host: "172.17.0.5", port: 5432 });
  });

  it("oracle free 預設 FREEPDB1", () => {
    const g = guessDbFromContainer(detail({ image: "gvenzl/oracle-free:23", env: ["ORACLE_PASSWORD=o"] }), local)!;
    expect(g.prefill).toMatchObject({ kind: "oracle", username: "system", password: "o", database: "FREEPDB1" });
  });

  it("認不得的映像回 null", () => {
    expect(guessDbFromContainer(detail({ image: "nginx:latest" }), local)).toBeNull();
    expect(looksLikeDbImage("nginx")).toBe(false);
    expect(looksLikeDbImage("bitnami/redis:7")).toBe(true);
  });
});
