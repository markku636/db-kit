import { describe, it, expect } from "vitest";
import { mssqlEffectiveUsername, mssqlNeedsCredentials } from "./mssqlAuth";
import { authRequirement, type ConnectionConfig } from "./api";

describe("mssqlEffectiveUsername", () => {
  it("SQL Server 驗證原樣保留帳號", () => {
    expect(mssqlEffectiveUsername("sql", "root")).toBe("root");
    expect(mssqlEffectiveUsername("sql", "sa")).toBe("sa");
  });
  it("Windows 驗證只留網域帳號，清掉表單預設的 root / sa", () => {
    expect(mssqlEffectiveUsername("windows", "root")).toBe("");
    expect(mssqlEffectiveUsername("windows", "sa")).toBe("");
    expect(mssqlEffectiveUsername("windows", "  ")).toBe("");
    expect(mssqlEffectiveUsername("windows", String.raw`CORP\alice`)).toBe(String.raw`CORP\alice`);
    expect(mssqlEffectiveUsername("windows", String.raw` .\SQLEXPRESS`)).toBe(String.raw`.\SQLEXPRESS`);
  });
});

describe("mssqlNeedsCredentials", () => {
  it("Windows 驗證留空＝目前登入使用者，不需要帳密", () => {
    expect(mssqlNeedsCredentials({ mssql_auth: "windows" }, "")).toBe(false);
    expect(mssqlNeedsCredentials({ mssql_auth: "windows" }, "root")).toBe(false);
  });
  it("網域帳號與 SQL 帳號仍要密碼", () => {
    expect(mssqlNeedsCredentials({ mssql_auth: "windows" }, String.raw`CORP\alice`)).toBe(true);
    expect(mssqlNeedsCredentials({}, "sa")).toBe(true);
    expect(mssqlNeedsCredentials(undefined, "sa")).toBe(true);
  });
});

describe("authRequirement（MSSQL）", () => {
  const cfg = (over: Partial<ConnectionConfig>): ConnectionConfig => ({
    id: "x", name: "x", kind: "mssql", host: "h", port: 1433,
    username: "root", password: "", ...over,
  });
  it("Windows 驗證的表單預設 root 不再被前端擋下", () => {
    expect(authRequirement(cfg({ options: { mssql_auth: "windows" } }))).toBe("none");
  });
  it("SQL 驗證與網域帳號照舊要求帳密", () => {
    expect(authRequirement(cfg({}))).toBe("both");
    expect(authRequirement(cfg({ options: { mssql_auth: "windows" }, username: String.raw`CORP\alice` }))).toBe("both");
  });
});
