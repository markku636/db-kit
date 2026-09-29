import { describe, expect, it } from "vitest";
import {
  containerStateTone, dockerHostAddress, envMap, fmtBytes, fmtIso, groupByCompose, isLocalDockerHost,
  isSensitiveEnvKey, portLabel, splitEnv, stateFromObjKind,
} from "./dockerModel";
import type { DockerContainer } from "./dockerTypes";

describe("dockerModel", () => {
  it("fmtBytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(fmtBytes(3 * 1024 ** 4)).toBe("3.0 TB");
  });

  it("fmtIso 把 Docker 零值時間當空", () => {
    expect(fmtIso("0001-01-01T00:00:00Z")).toBe("");
    expect(fmtIso("")).toBe("");
  });

  it("狀態色調與 objKind", () => {
    expect(containerStateTone("running")).toBe("success");
    expect(containerStateTone("exited")).toBe("neutral");
    expect(stateFromObjKind("container-paused")).toBe("paused");
    expect(stateFromObjKind("image")).toBeNull();
  });

  it("env 解析與機密判斷", () => {
    expect(splitEnv("A=b=c")).toEqual(["A", "b=c"]);
    expect(splitEnv("FLAG")).toEqual(["FLAG", ""]);
    expect(envMap(["A=1", "A=2"])).toEqual({ A: "2" });
    expect(isSensitiveEnvKey("POSTGRES_PASSWORD")).toBe(true);
    expect(isSensitiveEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("PATH")).toBe(false);
  });

  it("portLabel", () => {
    expect(portLabel({ private_port: 5432, public_port: 15432, ip: "0.0.0.0", proto: "tcp" })).toBe("15432 → 5432/tcp");
    expect(portLabel({ private_port: 53, public_port: 53, ip: "127.0.0.1", proto: "udp" })).toBe("127.0.0.1:53 → 53/udp");
    expect(portLabel({ private_port: 6379, public_port: null, ip: "", proto: "tcp" })).toBe("6379/tcp");
  });

  it("compose 分組：有專案的排前、無專案的排最後", () => {
    const c = (name: string, project: string) => ({ name, compose_project: project }) as DockerContainer;
    const g = groupByCompose([c("a", ""), c("b", "shop"), c("c", "api"), c("d", "shop")]);
    expect(g.map((x) => x.project)).toEqual(["api", "shop", ""]);
    expect(g[1].items.map((x) => x.name)).toEqual(["b", "d"]);
  });

  it("本機 host 判讀與 daemon 位址", () => {
    expect(isLocalDockerHost("")).toBe(true);
    expect(isLocalDockerHost("npipe:////./pipe/docker_engine")).toBe(true);
    expect(isLocalDockerHost("/var/run/docker.sock")).toBe(true);
    expect(isLocalDockerHost("10.0.0.5")).toBe(false);
    expect(dockerHostAddress({ host: "" })).toBe("127.0.0.1");
    expect(dockerHostAddress({ host: "tcp://build01:2376" })).toBe("build01");
    expect(dockerHostAddress({ host: "https://[fd00::1]:2376" })).toBe("fd00::1");
    expect(dockerHostAddress({ host: "docker.lan" })).toBe("docker.lan");
  });
});
