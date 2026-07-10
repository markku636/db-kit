import { describe, it, expect } from "vitest";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { analyzeSqlContext, statementTables, schemaTableMap, stripNoise, sqlContextCompletion } from "./sqlContextComplete";

// 最小 CompletionContext 假件：source 只用到 state.doc.toString / pos / explicit。
const ctx = (doc: string, pos = doc.length, explicit = false) =>
  ({ state: { doc: { toString: () => doc } }, pos, explicit }) as unknown as CompletionContext;

const SCHEMA = {
  SitePayListV2: ["SiteId", "PayId", "Setting", "Status"],
  PayList: ["Id", "PayName"],
  PayGroup: ["Id", "GroupName", "PayCode"],
};

describe("statementTables（FROM/JOIN 表解析）", () => {
  it("解析反引號表名（截圖情境）", () => {
    expect(statementTables("SELECT * FROM `SitePayListV2` WHERE ")).toEqual(["SitePayListV2"]);
  });
  it("解析 db.table 取末段、JOIN 多表", () => {
    expect(statementTables("SELECT * FROM Siebog.PayList p JOIN PayGroup g ON g.Id = p.GroupId")).toEqual([
      "PayList",
      "PayGroup",
    ]);
  });
  it("FROM 清單逗號接續（含別名）", () => {
    expect(statementTables("SELECT * FROM PayList p, PayGroup g WHERE ")).toEqual(["PayList", "PayGroup"]);
  });
  it("UPDATE / INSERT INTO", () => {
    expect(statementTables("UPDATE SitePayListV2 SET Status = 1")).toEqual(["SitePayListV2"]);
    expect(statementTables("INSERT INTO PayList (Id, PayName) VALUES (1, 'x')")).toEqual(["PayList"]);
  });
  it("WHERE 之後的字不會被誤吞成清單接續", () => {
    expect(statementTables("SELECT * FROM PayList WHERE PayName = 1")).toEqual(["PayList"]);
  });
});

describe("stripNoise（字串 / 註解遮蔽）", () => {
  it("等長替換保持位移", () => {
    const { text } = stripNoise("SELECT 'from x' -- from y\nFROM t");
    expect(text).toHaveLength("SELECT 'from x' -- from y\nFROM t".length);
    expect(text).not.toContain("from x");
    expect(statementTables(text)).toEqual(["t"]);
  });
});

describe("analyzeSqlContext（語境判斷）", () => {
  it("WHERE + 空白 → 欄語境自動跳窗（截圖情境）", () => {
    const doc = "SELECT * FROM `SitePayListV2` WHERE ";
    const a = analyzeSqlContext(doc, doc.length);
    expect(a).toMatchObject({ mode: "column", tables: ["SitePayListV2"], word: "", autoPop: true });
  });
  it("WHERE Pa → 欄語境、帶字前綴、起點正確", () => {
    const doc = "SELECT * FROM PayList WHERE Pa";
    const a = analyzeSqlContext(doc, doc.length)!;
    expect(a.mode).toBe("column");
    expect(a.word).toBe("Pa");
    expect(a.wordFrom).toBe(doc.length - 2);
    expect(a.autoPop).toBe(false);
  });
  it("識別字後的空白不自動跳（打完欄名別彈窗）", () => {
    const doc = "SELECT * FROM PayList WHERE PayName ";
    const a = analyzeSqlContext(doc, doc.length)!;
    expect(a.mode).toBe("column");
    expect(a.autoPop).toBe(false);
  });
  it("比較運算子後自動跳", () => {
    const doc = "SELECT * FROM PayList WHERE Id = ";
    expect(analyzeSqlContext(doc, doc.length)).toMatchObject({ mode: "column", autoPop: true });
  });
  it("SELECT | …FROM 在游標後也解析得到（編輯既有查詢）", () => {
    const doc = "SELECT  FROM PayList";
    expect(analyzeSqlContext(doc, 7)).toMatchObject({ mode: "column", tables: ["PayList"], autoPop: true });
  });
  it("FROM + 空白 → 表語境自動跳", () => {
    const doc = "SELECT * FROM ";
    expect(analyzeSqlContext(doc, doc.length)).toMatchObject({ mode: "table", autoPop: true });
  });
  it("ORDER BY / GROUP BY → 欄語境", () => {
    const doc = "SELECT * FROM PayList ORDER BY ";
    expect(analyzeSqlContext(doc, doc.length)).toMatchObject({ mode: "column", autoPop: true });
  });
  it("JOIN … ON → 欄語境、兩表都在", () => {
    const doc = "SELECT * FROM PayList p JOIN PayGroup g ON ";
    expect(analyzeSqlContext(doc, doc.length)).toMatchObject({
      mode: "column",
      tables: ["PayList", "PayGroup"],
      autoPop: true,
    });
  });
  it("LIMIT 後不提示", () => {
    const doc = "SELECT * FROM PayList LIMIT ";
    expect(analyzeSqlContext(doc, doc.length)).toBeNull();
  });
  it("`表名.` 限定名後不提示（讓預設 source 接手）", () => {
    const doc = "SELECT * FROM PayList p WHERE p.";
    expect(analyzeSqlContext(doc, doc.length)).toBeNull();
  });
  it("游標在字串 / 未閉合字串內不提示", () => {
    const closed = "SELECT * FROM t WHERE a = 'x y' ";
    expect(analyzeSqlContext(closed, closed.indexOf("x y") + 1)).toBeNull(); // 'x| y'
    const open = "SELECT * FROM t WHERE a = 'x ";
    expect(analyzeSqlContext(open, open.length)).toBeNull();
  });
  it("游標在行註解內不提示", () => {
    const doc = "SELECT * FROM t -- WHERE ";
    expect(analyzeSqlContext(doc, doc.length)).toBeNull();
  });
  it("多語句以分號隔離（只看當前語句的表）", () => {
    const doc = "SELECT 1; SELECT * FROM PayGroup WHERE ";
    expect(analyzeSqlContext(doc, doc.length)).toMatchObject({ mode: "column", tables: ["PayGroup"] });
  });
});

describe("schemaTableMap（不分大小寫查找）", () => {
  it("小寫鍵 → 原樣表名與欄位", () => {
    const map = schemaTableMap(SCHEMA);
    expect(map.get("sitepaylistv2")).toEqual({
      name: "SitePayListV2",
      columns: ["SiteId", "PayId", "Setting", "Status"],
    });
  });
});

describe("sqlContextCompletion（CompletionSource 行為）", () => {
  const source = sqlContextCompletion(SCHEMA);
  it("WHERE 後空前綴自動出該表欄位", () => {
    const r = source(ctx("SELECT * FROM `SitePayListV2` WHERE ")) as CompletionResult;
    expect(r).not.toBeNull();
    expect(r.options.map((o) => o.label)).toEqual(["SiteId", "PayId", "Setting", "Status"]);
  });
  it("表名不分大小寫也解析得到", () => {
    const r = source(ctx("SELECT * FROM sitepaylistv2 WHERE pay")) as CompletionResult;
    expect(r.options.some((o) => o.label === "PayId")).toBe(true);
    expect(r.from).toBe("SELECT * FROM sitepaylistv2 WHERE ".length);
  });
  it("多表欄位合併、同名欄去重、detail 標表名", () => {
    const r = source(ctx("SELECT * FROM PayList p JOIN PayGroup g ON ")) as CompletionResult;
    const labels = r.options.map((o) => o.label);
    expect(labels).toEqual(["Id", "PayName", "GroupName", "PayCode"]); // Id 只出一次
    expect(r.options[0].detail).toBe("PayList");
  });
  it("FROM 後空前綴自動出表名；開始打字即讓位給預設 source", () => {
    const pop = source(ctx("SELECT * FROM ")) as CompletionResult;
    expect(pop.options.map((o) => o.label)).toEqual(["SitePayListV2", "PayList", "PayGroup"]);
    expect(source(ctx("SELECT * FROM Pay"))).toBeNull();
  });
  it("語句沒有 FROM 表（或表不在 schema）→ null", () => {
    expect(source(ctx("SELECT * FROM Unknown WHERE "))).toBeNull();
    expect(source(ctx("WHERE "))).toBeNull();
  });
  it("Ctrl+Space（explicit）在 WHERE 後也出欄位", () => {
    const doc = "SELECT * FROM PayList WHERE Id = 1 AND PayName";
    // 識別字後 explicit：word=PayName
    const r = source(ctx(doc, doc.length, true)) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(["Id", "PayName"]);
  });
});
