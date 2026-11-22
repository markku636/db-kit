import { describe, it, expect } from "vitest";
import { isReadOnlyColumnExtra } from "./columnMeta";

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
