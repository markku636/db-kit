import { describe, expect, it } from "vitest";
import { CAN_CANCEL_QUERY, LIST_SQL, killSql } from "./processList";

describe("killSql", () => {
  it("MySQL / PG 沿用原本的語句", () => {
    expect(killSql("mysql", ["42"], true)?.sql).toBe("KILL QUERY 42");
    expect(killSql("mysql", ["42"], false)?.sql).toBe("KILL 42");
    expect(killSql("postgres", ["7"], true)?.sql).toBe("SELECT pg_cancel_backend(7)");
  });
  it("SQL Server 只有 KILL 工作階段", () => {
    expect(killSql("mssql", ["55"], false)?.sql).toBe("KILL 55");
    expect(CAN_CANCEL_QUERY.mssql).toBeUndefined();
  });
  it("Oracle 用 sid,serial# 識別", () => {
    expect(killSql("oracle", ["12", "3456"], false)).toEqual({ id: "12,3456", sql: "ALTER SYSTEM KILL SESSION '12,3456' IMMEDIATE" });
    expect(killSql("oracle", ["12", "3456"], true)?.sql).toBe("ALTER SYSTEM CANCEL SQL '12, 3456'");
  });
  it("識別不是純數字一律拒絕（防注入）", () => {
    expect(killSql("mysql", ["1; DROP TABLE x"], false)).toBeNull();
    expect(killSql("oracle", ["12", "1' OR '1"], false)).toBeNull();
    expect(killSql("mssql", [null], false)).toBeNull();
  });
  it("五種引擎都有清單語句", () => {
    for (const k of ["mysql", "mariadb", "postgres", "mssql", "oracle"] as const) expect(LIST_SQL[k]).toBeTruthy();
  });
});
