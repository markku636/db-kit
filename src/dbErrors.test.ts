import { describe, expect, it } from "vitest";
import { friendlyDbError } from "./dbErrors";

describe("friendlyDbError", () => {
  it("MySQL 1045 → 帳密提示", () => {
    expect(friendlyDbError("mysql", "error returned from database: 1045 (28000): Access denied for user 'root'@'localhost'"))
      .toMatch(/帳號或密碼錯誤/);
  });

  it("MariaDB 共用 MySQL 規則", () => {
    expect(friendlyDbError("mariadb", "1146 (42S02): Table 'test.nope' doesn't exist")).toMatch(/資料表不存在/);
  });

  it("PG 42P01 → relation 不存在", () => {
    expect(friendlyDbError("postgres", 'relation "users" does not exist')).toMatch(/relation.*不存在|資料表（relation）不存在/);
  });

  it("PG statement timeout → 逾時提示", () => {
    expect(friendlyDbError("postgres", "57014 canceling statement due to statement timeout")).toMatch(/逾時/);
  });

  it("Oracle 缺 Instant Client → 安裝提示", () => {
    expect(friendlyDbError("oracle", "DPI-1047: Cannot locate a 64-bit Oracle Client library")).toMatch(/Instant Client/);
  });

  it("跨類型 connection refused 不分 kind", () => {
    expect(friendlyDbError(undefined, "Connection refused (os error 10061)")).toMatch(/無法連上伺服器/);
  });

  it("kind 不符的專屬規則不誤傷", () => {
    // MySQL 1045 規則不應套用到 postgres 錯誤字串上
    expect(friendlyDbError("postgres", "some other 1045 error")).toBeNull();
  });

  it("查無對應回 null（照舊顯示原文）", () => {
    expect(friendlyDbError("mysql", "something completely unknown")).toBeNull();
    expect(friendlyDbError("mysql", "")).toBeNull();
  });
});
