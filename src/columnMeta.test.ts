import { describe, it, expect } from "vitest";
import { isReadOnlyColumnExtra, isBinaryColumnType } from "./columnMeta";

describe("isReadOnlyColumnExtra", () => {
  it("認得 SQL Server 的 identity / computed 指標", () => {
    expect(isReadOnlyColumnExtra("identity")).toBe(true);
    expect(isReadOnlyColumnExtra("computed")).toBe(true);
    expect(isReadOnlyColumnExtra("identity computed")).toBe(true);
    expect(isReadOnlyColumnExtra("IDENTITY")).toBe(true);
  });
  it("一般欄位可編輯", () => {
    expect(isReadOnlyColumnExtra("")).toBe(false);
    expect(isReadOnlyColumnExtra(undefined)).toBe(false);
    expect(isReadOnlyColumnExtra("PRI")).toBe(false);
  });
});

describe("isBinaryColumnType", () => {
  it("varbinary / binary / image 唯讀，文字型別照常", () => {
    for (const t of ["varbinary", "varbinary(max)", "VARBINARY(8)", "binary(16)", "image"]) {
      expect(isBinaryColumnType(t)).toBe(true);
    }
    for (const t of ["varchar(50)", "nvarchar(MAX)", "int", "uniqueidentifier", ""]) {
      expect(isBinaryColumnType(t)).toBe(false);
    }
  });
});
