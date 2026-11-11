import { describe, it, expect } from "vitest";
import { splitTsqlBatches, splitForGuard, scopeTsqlBatches, tsqlUseTarget, TSQL_GO_REPEAT_MAX } from "./sql";
import { prepareStatements } from "./chatRun";

describe("tsqlUseTarget", () => {
  it("認得方括號、雙引號、裸名與前導註解", () => {
    expect(tsqlUseTarget("USE [Sales DB];\nSELECT 1")).toBe("Sales DB");
    expect(tsqlUseTarget("-- 切庫\nuse shop")).toBe("shop");
    expect(tsqlUseTarget("USE [a]]b]")).toBe("a]b");
    expect(tsqlUseTarget('USE "q""db"')).toBe('q"db');
  });
  it("不是 USE 開頭就回 null", () => {
    expect(tsqlUseTarget("SELECT 1")).toBeNull();
    expect(tsqlUseTarget("user_stats")).toBeNull();
  });
});

describe("scopeTsqlBatches（SSMS 式的目前資料庫）", () => {
  it("每個批次前補上目前的庫", () => {
    expect(scopeTsqlBatches(["SELECT 1", "SELECT 2"], "shop")).toEqual({
      sent: ["USE [shop];\nSELECT 1", "USE [shop];\nSELECT 2"],
      lastDb: "shop",
    });
  });
  it("批次自己 USE 了別的庫，後面的批次沿用", () => {
    const r = scopeTsqlBatches(["USE [hr]", "SELECT * FROM emp", "USE crm;\nSELECT 1", "SELECT 2"], "shop");
    expect(r.sent).toEqual(["USE [hr]", "USE [hr];\nSELECT * FROM emp", "USE crm;\nSELECT 1", "USE [crm];\nSELECT 2"]);
    expect(r.lastDb).toBe("crm");
  });
  it("沒選庫時不加前綴", () => {
    expect(scopeTsqlBatches(["SELECT 1"], "")).toEqual({ sent: ["SELECT 1"], lastDb: "" });
  });
  it("庫名含 ] 會正確跳脫", () => {
    expect(scopeTsqlBatches(["SELECT 1"], "a]b").sent[0]).toBe("USE [a]]b];\nSELECT 1");
  });
});

describe("prepareStatements：AI 聊天執行 MSSQL 批次", () => {
  it("與查詢分頁同一套規則", () => {
    expect(prepareStatements(["SELECT 1", "USE hr", "SELECT 2"], "mssql", "shop")).toEqual([
      "USE [shop];\nSELECT 1",
      "USE hr",
      "USE [hr];\nSELECT 2",
    ]);
  });
});

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
