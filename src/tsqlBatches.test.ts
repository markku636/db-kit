import { describe, it, expect } from "vitest";
import { splitTsqlBatches, splitForGuard, TSQL_GO_REPEAT_MAX } from "./sql";

describe("splitTsqlBatches（MSSQL 依 GO 切批次）", () => {
  it("沒有 GO 時整段是一個批次，分號不切", () => {
    const sql = "DECLARE @id int = 5;\nSELECT * FROM t WHERE id = @id;";
    expect(splitTsqlBatches(sql)).toEqual([sql]);
  });

  it("GO 獨立成行才切，不分大小寫、可帶行尾註解", () => {
    const sql = "CREATE TABLE a (x int)\ngo\nINSERT a VALUES (1)\n  GO  -- 第二批\nSELECT * FROM a";
    expect(splitTsqlBatches(sql)).toEqual(["CREATE TABLE a (x int)", "INSERT a VALUES (1)", "SELECT * FROM a"]);
  });

  it("CRLF 換行也認得 GO", () => {
    expect(splitTsqlBatches("SELECT 1\r\nGO\r\nSELECT 2\r\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("程序本體內的分號與 BEGIN/END 不會被拆開", () => {
    const proc = "CREATE PROCEDURE dbo.p AS\nBEGIN\n  SET NOCOUNT ON;\n  SELECT 1;\nEND";
    expect(splitTsqlBatches(`${proc}\nGO\nEXEC dbo.p`)).toEqual([proc, "EXEC dbo.p"]);
  });

  it("字串、區塊註解（含巢狀）、[識別字] 裡的 GO 行不算分隔", () => {
    const inString = "SELECT 'a\nGO\nb'";
    expect(splitTsqlBatches(inString)).toEqual([inString]);
    const inComment = "/* x /* 巢狀 */\nGO\n*/ SELECT 1";
    expect(splitTsqlBatches(inComment)).toEqual([inComment]);
    const inBracket = "SELECT 1 AS [a\nGO\nb]";
    expect(splitTsqlBatches(inBracket)).toEqual([inBracket]);
  });

  it("行註解裡的引號不會打開字串", () => {
    expect(splitTsqlBatches("SELECT 1 -- it's\nGO\nSELECT 2")).toEqual(["SELECT 1 -- it's", "SELECT 2"]);
  });

  it("GOTO、GO 後面接別的字、以 GO 開頭的識別字都不是分隔", () => {
    const sql = "GOTO done\nGO_table\nGO x\ndone: SELECT 1";
    expect(splitTsqlBatches(sql)).toEqual([sql]);
  });

  it("GO n 重複該批次 n 次，且有上限", () => {
    expect(splitTsqlBatches("INSERT t DEFAULT VALUES\nGO 3")).toEqual(Array(3).fill("INSERT t DEFAULT VALUES"));
    expect(splitTsqlBatches("SELECT 1\nGO 999999").length).toBe(TSQL_GO_REPEAT_MAX);
  });

  it("純註解 / 空白批次濾掉", () => {
    expect(splitTsqlBatches("GO\n-- 只有註解\nGO\n\nSELECT 1\nGO\n")).toEqual(["SELECT 1"]);
    expect(splitTsqlBatches("")).toEqual([]);
  });
});

describe("splitForGuard（守門掃描單位）", () => {
  it("MSSQL 先切 GO 再切分號：第二句的 DROP 也看得到", () => {
    expect(splitForGuard("SELECT 1; DROP TABLE t\nGO\nDELETE FROM u", "mssql")).toEqual([
      "SELECT 1",
      "DROP TABLE t",
      "DELETE FROM u",
    ]);
  });

  it("其他方言照舊依分號切", () => {
    expect(splitForGuard("SELECT 1; SELECT 2", "mysql")).toEqual(["SELECT 1", "SELECT 2"]);
  });
});
