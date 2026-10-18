import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "./api";
import { isMcpKind, isWritableKind, sameServerArgs, serverArgsOf, writableCount, type McpFormState } from "./mcpSetup";

const base: McpFormState = {
  scope: "all",
  connId: null,
  database: "",
  only: [],
  allowWrite: false,
  allowDestructive: false,
  allowProd: false,
  ssh: false,
  sshHosts: [],
  allowSshExec: false,
};

describe("serverArgsOf", () => {
  it("multi-connection mode keeps the allow-list and drops database", () => {
    const a = serverArgsOf({ ...base, only: ["a", "b"], database: "x" });
    expect(a.conn).toBeNull();
    expect(a.database).toBeNull();
    expect(a.connections).toEqual(["a", "b"]);
  });

  it("single connection ignores the allow-list", () => {
    const a = serverArgsOf({ ...base, scope: "one", connId: "c1", database: " shop ", only: ["a"] });
    expect(a.conn).toBe("c1");
    expect(a.database).toBe("shop");
    expect(a.connections).toEqual([]);
  });

  it("destructive / prod flags only travel with allowWrite", () => {
    const off = serverArgsOf({ ...base, allowDestructive: true, allowProd: true });
    expect(off.allowDestructive).toBe(false);
    expect(off.allowProd).toBe(false);
    const on = serverArgsOf({ ...base, allowWrite: true, allowDestructive: true });
    expect(on.allowDestructive).toBe(true);
    expect(on.allowProd).toBe(false);
  });

  it("SSH host list and exec only travel with ssh", () => {
    const off = serverArgsOf({ ...base, sshHosts: ["h1"], allowSshExec: true });
    expect(off.ssh).toBe(false);
    expect(off.sshHosts).toEqual([]);
    expect(off.allowSshExec).toBe(false);
    const on = serverArgsOf({ ...base, ssh: true, sshHosts: ["h1"], allowSshExec: true });
    expect(on).toMatchObject({ ssh: true, sshHosts: ["h1"], allowSshExec: true });
  });
});

describe("sameServerArgs", () => {
  it("ignores lang and order, notices real changes", () => {
    const a = { conn: null, connections: ["b", "a"], allowWrite: false, lang: "en" };
    const b = { conn: null, connections: ["a", "b"], allowWrite: false, lang: "zh-TW", allowProd: true };
    expect(sameServerArgs(a, b)).toBe(true);
    expect(sameServerArgs(a, { ...b, allowWrite: true })).toBe(false);
    expect(sameServerArgs(a, null)).toBe(false);
  });

  it("treats a host allow-list or exec as SSH on (same rule as the backend)", () => {
    const a = { conn: null, ssh: true, sshHosts: ["y", "x"], allowSshExec: true };
    expect(sameServerArgs(a, { conn: null, sshHosts: ["x", "y"], allowSshExec: true })).toBe(true);
    expect(sameServerArgs(a, { ...a, allowSshExec: false })).toBe(false);
    expect(sameServerArgs({ conn: null }, { conn: null, ssh: true })).toBe(false);
  });
});

describe("kinds", () => {
  it("knows which kinds dbk can serve and write", () => {
    expect(isMcpKind("mysql")).toBe(true);
    expect(isMcpKind("kafka")).toBe(false);
    expect(isWritableKind("redis")).toBe(false);
    expect(isWritableKind("postgres")).toBe(true);
  });

  it("counts writable connections", () => {
    const conns: Pick<ConnectionConfig, "id" | "kind" | "options">[] = [
      { id: "a", kind: "mysql", options: {} },
      { id: "b", kind: "postgres", options: { prod: "1" } },
      { id: "c", kind: "redis", options: {} },
    ];
    expect(writableCount(conns, base)).toBe(0);
    expect(writableCount(conns, { ...base, allowWrite: true })).toBe(1);
    expect(writableCount(conns, { ...base, allowWrite: true, allowProd: true })).toBe(2);
    expect(writableCount(conns, { ...base, allowWrite: true, scope: "one", connId: "c" })).toBe(0);
  });
});
