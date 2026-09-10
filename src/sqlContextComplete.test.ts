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

// 跨庫版：目前庫的表在頂層，額外庫 Other 掛巢狀（見 schemaCache.toMultiDbSqlNamespace）。
// Other 也有一張 PayList，欄位完全不同——「限定名要對到正確那一張」的關鍵樣本。
const CROSS_SCHEMA = {
  ...SCHEMA,
  Other: {
    PayList: ["OtherId", "OtherName"],
    Ledger: ["LedgerId", "Amount"],
  },
};

/** 表參照壓成 `db.table` / `table` 字串，讓斷言讀得下去。 */
const refs = (sql: string) => statementTables(sql).map((r) => (r.db ? `${r.db}.${r.table}` : r.table));
const aliases = (sql: string) => statementTables(sql).map((r) => r.alias);

describe("statementTables（FROM/JOIN 表解析）", () => {
  it("解析反引號表名（截圖情境）", () => {
    expect(refs("SELECT * FROM `SitePayListV2` WHERE ")).toEqual(["SitePayListV2"]);
  });
  // 跨庫查詢的前提：db 限定不能被丟掉，否則 dbB.orders 會拿目前庫 orders 的欄位。
  it("保留 db. 限定、JOIN 多表", () => {
    expect(refs("SELECT * FROM Siebog.PayList p JOIN PayGroup g ON g.Id = p.GroupId")).toEqual([
      "Siebog.PayList",
      "PayGroup",
    ]);
  });
  it("三段式取後兩段當表名（SQL Server 的 schema.table 慣例）", () => {
    expect(refs("SELECT * FROM shop.sales.orders")).toEqual(["shop.sales.orders"]);
    expect(statementTables("SELECT * FROM shop.sales.orders")[0]).toMatchObject({
      db: "shop",
      table: "sales.orders",
    });
  });
  it("解析別名（`t x` 與 `t AS x`）", () => {
    expect(aliases("SELECT * FROM Siebog.PayList p JOIN PayGroup AS g ON g.Id = p.GroupId")).toEqual(["p", "g"]);
  });
  // 沒有別名時，接續的子句關鍵字不能被當成別名（否則 `FROM t WHERE` 會生出一個叫 where 的別名）。
  it("子句關鍵字不會被誤認為別名", () => {
    expect(aliases("SELECT * FROM PayList WHERE Id = 1")).toEqual([null]);
    expect(aliases("SELECT * FROM PayList ORDER BY Id")).toEqual([null]);
    expect(aliases("SELECT * FROM PayList JOIN PayGroup ON 1=1")).toEqual([null, null]);
  });
  it("FROM 清單逗號接續（含別名）", () => {
    expect(refs("SELECT * FROM PayList p, Other.PayGroup g WHERE ")).toEqual(["PayList", "Other.PayGroup"]);
    expect(aliases("SELECT * FROM PayList p, Other.PayGroup g WHERE ")).toEqual(["p", "g"]);
  });
  it("UPDATE / INSERT INTO", () => {
    expect(refs("UPDATE SitePayListV2 SET Status = 1")).toEqual(["SitePayListV2"]);
    expect(refs("INSERT INTO PayList (Id, PayName) VALUES (1, 'x')")).toEqual(["PayList"]);
  });
  it("WHERE 之後的字不會被誤吞成清單接續", () => {
    expect(refs("SELECT * FROM PayList WHERE PayName = 1")).toEqual(["PayList"]);
  });
  it("同名但不同庫的兩張表各自成立（不會被去重掉）", () => {
    expect(refs("SELECT * FROM PayList a JOIN Other.PayList b ON 1=1")).toEqual(["PayList", "Other.PayList"]);
  });
});

describe("stripNoise（字串 / 註解遮蔽）", () => {
  it("等長替換保持位移", () => {
    const { text } = stripNoise("SELECT 'from x' -- from y\nFROM t");
    expect(text).toHaveLength("SELECT 'from x' -- from y\nFROM t".length);
    expect(text).not.toContain("from x");
    expect(refs(text)).toEqual(["t"]);
  });
});

describe("analyzeSqlContext（語境判斷）", () => {
  it("WHERE + 空白 → 欄語境自動跳窗（截圖情境）", () => {
    const doc = "SELECT * FROM `SitePayListV2` WHERE ";
    const a = analyzeSqlContext(doc, doc.length)!;
    expect(a).toMatchObject({ mode: "column", word: "", autoPop: true });
    expect(a.tables).toEqual([{ db: null, table: "SitePayListV2", alias: null }]);
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
    const a = analyzeSqlContext("SELECT  FROM PayList", 7)!;
    expect(a).toMatchObject({ mode: "column", autoPop: true });
    expect(a.tables.map((r) => r.table)).toEqual(["PayList"]);
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
    const a = analyzeSqlContext(doc, doc.length)!;
    expect(a).toMatchObject({ mode: "column", autoPop: true });
    expect(a.tables.map((r) => r.table)).toEqual(["PayList", "PayGroup"]);
  });
  it("LIMIT 後不提示", () => {
    const doc = "SELECT * FROM PayList LIMIT ";
    expect(analyzeSqlContext(doc, doc.length)).toBeNull();
  });
  it("`表名.` 限定名後回 qualifier（本 source 只在該名是未載入的庫時才接手）", () => {
    const doc = "SELECT * FROM PayList p WHERE p.";
    expect(analyzeSqlContext(doc, doc.length)).toMatchObject({ mode: "qualifier", qualifier: "p" });
  });
  it("兩段限定（`db.表.`）不接手——那是內建 source 的守備範圍", () => {
    const doc = "SELECT * FROM Other.PayList WHERE Other.PayList.";
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
    const a = analyzeSqlContext(doc, doc.length)!;
    expect(a.mode).toBe("column");
    expect(a.tables.map((r) => r.table)).toEqual(["PayGroup"]);
  });
});

describe("schemaTableMap（不分大小寫查找）", () => {
  it("小寫鍵 → 原樣表名與欄位", () => {
    const map = schemaTableMap(SCHEMA);
    expect(map.get("sitepaylistv2")).toEqual({
      name: "SitePayListV2",
      db: null,
      columns: ["SiteId", "PayId", "Setting", "Status"],
    });
  });
  it("跨庫的表以 `db.table` 為鍵，與目前庫的同名表並存", () => {
    const map = schemaTableMap(CROSS_SCHEMA);
    expect(map.get("paylist")).toMatchObject({ db: null, columns: ["Id", "PayName"] });
    expect(map.get("other.paylist")).toMatchObject({
      db: "Other",
      name: "PayList",
      columns: ["OtherId", "OtherName"],
    });
  });
  it("還原庫名裡被跳脫的點", () => {
    const map = schemaTableMap({ "a\\.b": { t: ["c"] } });
    expect(map.get("a.b.t")).toMatchObject({ db: "a.b", name: "t" });
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
  // 跨庫功能之前，`db.table` 是把前綴丟掉才 work 的。庫沒載入時要維持這個行為，
  // 否則使用者寫慣的 `USE shop; SELECT … FROM shop.orders` 會突然沒有提示。
  it("庫結構未載入時，限定名退回同名的目前庫表", () => {
    const r = source(ctx("SELECT * FROM Siebog.PayList WHERE ")) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(["Id", "PayName"]);
  });
});

describe("sqlContextCompletion（跨庫）", () => {
  const cross = { databases: ["Shop", "Other", "NotLoaded"], loaded: ["Shop", "Other"], currentDb: "Shop" };
  const source = sqlContextCompletion(CROSS_SCHEMA, cross);

  it("限定到別的庫 → 出那個庫那張表的欄位，不是目前庫的同名表", () => {
    const r = source(ctx("SELECT * FROM Other.PayList WHERE ")) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(["OtherId", "OtherName"]);
  });

  it("跨庫 join 兩張同名表：欄位都在，detail 帶庫名分得出來", () => {
    const r = source(ctx("SELECT * FROM PayList a JOIN Other.PayList b ON ")) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(["Id", "PayName", "OtherId", "OtherName"]);
    expect(r.options[0].detail).toBe("PayList");
    expect(r.options[2].detail).toBe("Other.PayList");
  });

  it("以目前庫自我限定（`Shop.PayList`）對回頂層裸表名", () => {
    const r = source(ctx("SELECT * FROM Shop.PayList WHERE ")) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(["Id", "PayName"]);
  });

  // 庫已載入卻沒這張表 = 真的沒有。退回別庫的同名表只會給出錯的欄位。
  it("已載入的庫裡沒有那張表 → 不退回、不提示", () => {
    expect(source(ctx("SELECT * FROM Other.SitePayListV2 WHERE "))).toBeNull();
  });

  it("額外庫的表不進 `FROM ` 的裸名跳窗", () => {
    const pop = source(ctx("SELECT * FROM ")) as CompletionResult;
    expect(pop.options.map((o) => o.label)).toEqual(["SitePayListV2", "PayList", "PayGroup"]);
  });

  it("打未載入的庫名 + 點 → 按需載入並直接回該庫表名", async () => {
    const loads: string[] = [];
    const s = sqlContextCompletion(CROSS_SCHEMA, {
      ...cross,
      onNeedDatabase: async (db) => {
        loads.push(db);
        return [
          { table: "Alpha", columns: ["AlphaId"] },
          { table: "Beta", columns: ["BetaId"] },
        ];
      },
    });
    const doc = "SELECT * FROM NotLoaded.";
    const r = (await s(ctx(doc))) as CompletionResult;
    expect(loads).toEqual(["NotLoaded"]);
    expect(r.options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
    expect(r.from).toBe(doc.length);
  });

  it("已載入的庫 / 表名 / 別名後打點都不接手（交給內建 source，避免重複項）", () => {
    const calls: string[] = [];
    const s = sqlContextCompletion(CROSS_SCHEMA, {
      ...cross,
      onNeedDatabase: async (db) => {
        calls.push(db);
        return [{ table: "X", columns: ["XId"] }];
      },
    });
    // 同步回 null（不是 Promise）：每次打點都多等一個 microtask 沒有道理。
    expect(s(ctx("SELECT * FROM Other."))).toBeNull(); // 已載入
    expect(s(ctx("SELECT * FROM PayList p WHERE p."))).toBeNull(); // 別名
    expect(s(ctx("SELECT * FROM PayList WHERE PayList."))).toBeNull(); // 表名
    expect(calls).toEqual([]);
  });

  // 別名剛好跟某個庫同名時，本句的宣告優先——不然打 `nova.` 會去載一個庫而不是給 t 的欄位。
  it("別名與庫同名時別名優先", () => {
    const calls: string[] = [];
    const s = sqlContextCompletion(CROSS_SCHEMA, {
      ...cross,
      onNeedDatabase: async (db) => {
        calls.push(db);
        return [{ table: "X", columns: ["XId"] }];
      },
    });
    expect(s(ctx("SELECT * FROM PayList NotLoaded WHERE NotLoaded."))).toBeNull();
    expect(calls).toEqual([]);
  });

  // 工具列沒選庫時預設庫是「清單第一個」，於是「一律寫 `Siebog.表`」的人整個語句都限定到
  // 一個沒載入的庫——這條路徑沒有按需載入的話，欄位提示對他們等於不存在。
  it("`FROM 未載入庫.表` 之後的欄語境 → 載進來並直接出該表欄位", async () => {
    const loads: string[] = [];
    const s = sqlContextCompletion(CROSS_SCHEMA, {
      ...cross,
      onNeedDatabase: async (db) => {
        loads.push(db);
        return [{ table: "Alpha", columns: ["AlphaId", "AlphaName"] }];
      },
    });
    const doc = "SELECT * FROM NotLoaded.Alpha WHERE Alpha";
    const r = (await s(ctx(doc))) as CompletionResult;
    expect(loads).toEqual(["NotLoaded"]);
    expect(r.options.map((o) => o.label)).toEqual(["AlphaId", "AlphaName"]);
    expect(r.from).toBe(doc.length - "Alpha".length);
    // 載回來的結構留在 source 內，後續按鍵同步命中（不再回 Promise、也不再打一次）。
    const again = s(ctx("SELECT * FROM NotLoaded.Alpha WHERE ")) as CompletionResult;
    expect(again.options.map((o) => o.label)).toEqual(["AlphaId", "AlphaName"]);
    expect(loads).toEqual(["NotLoaded"]);
  });

  it("跨庫 join 一邊已載入一邊按需載入：欄位都到齊", async () => {
    const s = sqlContextCompletion(CROSS_SCHEMA, {
      ...cross,
      onNeedDatabase: async () => [{ table: "Alpha", columns: ["AlphaId"] }],
    });
    const r = (await s(ctx("SELECT * FROM PayList p JOIN NotLoaded.Alpha a ON "))) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(["Id", "PayName", "AlphaId"]);
    expect(r.options[2].detail).toBe("NotLoaded.Alpha");
  });

  it("載不到（未連線 / 權限不足）不重試，之後一律同步回 null", async () => {
    let calls = 0;
    const s = sqlContextCompletion(CROSS_SCHEMA, {
      ...cross,
      onNeedDatabase: async () => {
        calls += 1;
        return [];
      },
    });
    expect(await s(ctx("SELECT * FROM NotLoaded.Alpha WHERE "))).toBeNull();
    expect(s(ctx("SELECT * FROM NotLoaded.Alpha WHERE A"))).toBeNull(); // 同步，不是 Promise
    expect(calls).toBe(1);
  });

  it("不該跳窗的位置不會為了限定名跑一趟整庫載入", () => {
    let calls = 0;
    const s = sqlContextCompletion(CROSS_SCHEMA, {
      ...cross,
      onNeedDatabase: async () => {
        calls += 1;
        return [{ table: "Alpha", columns: ["AlphaId"] }];
      },
    });
    // 空前綴 + 不是剛打完關鍵字 / 逗號 / 運算子 → 本來就不跳窗，更不該為它查一整個庫。
    expect(s(ctx("SELECT * FROM NotLoaded.Alpha WHERE Id = 1 "))).toBeNull();
    expect(calls).toBe(0);
  });

  it("未限定的表名不會觸發按需載入（沒有庫可以指）", () => {
    let calls = 0;
    const s = sqlContextCompletion(CROSS_SCHEMA, {
      ...cross,
      onNeedDatabase: async () => {
        calls += 1;
        return [{ table: "Alpha", columns: ["AlphaId"] }];
      },
    });
    expect(s(ctx("SELECT * FROM Whatever WHERE "))).toBeNull();
    expect(calls).toBe(0);
  });

  it("沒給 onNeedDatabase（對話框情境）就完全不接手 qualifier", () => {
    const s = sqlContextCompletion(CROSS_SCHEMA, { databases: ["NotLoaded"] });
    expect(s(ctx("SELECT * FROM NotLoaded."))).toBeNull();
  });
});
