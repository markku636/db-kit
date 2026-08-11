import { beforeEach, describe, it, expect, vi } from "vitest";
import { buildSqlNlPrompt, extractFirstCodeBlock, rankTables } from "./nlPrompt";

// 只 mock 掉 buildSqlNlPrompt 會用到的兩支；KIND_META 等常數保留真值（方言標籤由它而來）。
const mocks = vi.hoisted(() => ({ listTables: vi.fn(), tableColumns: vi.fn() }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

describe("extractFirstCodeBlock", () => {
  it("取第一個符合語言的 fenced block", () => {
    const text = "說明文字\n```sql\nSELECT 1;\n```\n更多";
    expect(extractFirstCodeBlock(text, ["sql"])).toBe("SELECT 1;");
  });

  it("多個 block：取第一個符合語言者（跳過不符語言的）", () => {
    const text = "```json\n{}\n```\n```sql\nSELECT 2;\n```";
    expect(extractFirstCodeBlock(text, ["sql"])).toBe("SELECT 2;");
  });

  it("無語言標註的 block 作為 fallback", () => {
    const text = "```\nSELECT 3;\n```";
    expect(extractFirstCodeBlock(text, ["sql"])).toBe("SELECT 3;");
  });

  it("有符合語言時，優先於無標註 block", () => {
    const text = "```\nplain\n```\n```json\n{\"index\":\"x\"}\n```";
    expect(extractFirstCodeBlock(text, ["json"])).toBe('{"index":"x"}');
  });

  it("未閉合 / 無 block → null", () => {
    expect(extractFirstCodeBlock("```sql\nSELECT 1;", ["sql"])).toBeNull();
    expect(extractFirstCodeBlock("沒有任何區塊", ["sql"])).toBeNull();
  });

  it("去除區塊尾端空白", () => {
    expect(extractFirstCodeBlock("```sql\nSELECT 1;\n\n\n```", ["sql"])).toBe("SELECT 1;");
  });
});

describe("rankTables", () => {
  const tables = ["orders", "order_items", "users", "products", "audit_log"];

  it("表名逐字出現在 NL 中者優先", () => {
    const r = rankTables("列出所有 orders 的金額", tables, null, 3);
    expect(r[0]).toBe("orders");
  });

  it("selectedTable 必入選並置頂", () => {
    const r = rankTables("完全不相關的描述 zzz", tables, "audit_log", 2);
    expect(r).toContain("audit_log");
    expect(r[0]).toBe("audit_log");
  });

  it("limit 生效", () => {
    const r = rankTables("orders users products", tables, null, 2);
    expect(r.length).toBe(2);
  });

  it("selectedTable 不在候選也不會塞入不存在的表", () => {
    const r = rankTables("orders", tables, "not_a_table", 3);
    expect(r).not.toContain("not_a_table");
  });
});

describe("buildSqlNlPrompt（跨庫）", () => {
  const base = {
    connId: "c1",
    kind: "mysql" as const,
    db: "shop",
    nl: "列出每個客戶最近一筆出貨",
    selectedTable: null,
    uiLang: "zh-TW",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTables.mockImplementation(async (_id: string, database: string) =>
      database === "warehouse"
        ? [{ name: "shipments", kind: "table" }, { name: "inventory", kind: "table" }]
        : [{ name: "customers", kind: "table" }, { name: "orders", kind: "table" }],
    );
    mocks.tableColumns.mockImplementation(async (_id: string, _db: string, table: string) => [
      { name: "id", data_type: "int", nullable: false, key: "PRI", default: null, extra: "" },
      { name: `${table}_note`, data_type: "text", nullable: true, key: "", default: null, extra: "" },
    ]);
  });

  // 沒宣告跨庫的人是絕大多數：他們的 prompt 必須一個字都沒變。
  it("沒有 crossDbs 時完全維持單庫輸出（不提跨庫、不多打 api）", async () => {
    const p = await buildSqlNlPrompt(base);
    expect(p).not.toContain("可跨資料庫查詢");
    expect(p).toContain("全部資料表（2 張）：customers, orders");
    expect(mocks.listTables).toHaveBeenCalledTimes(1);
    expect(p).toBe(await buildSqlNlPrompt({ ...base, crossDbs: [] }));
  });

  it("有 crossDbs 時把其他庫的表以限定名列出，並加上跨庫規則", async () => {
    const p = await buildSqlNlPrompt({ ...base, crossDbs: ["warehouse"] });
    expect(p).toContain("warehouse.shipments");
    expect(p).toContain("warehouse.inventory");
    expect(p).toContain("可跨資料庫查詢");
    expect(p).toContain("全部資料表（4 張）");
  });

  // rankTables 是拿「表名」當 query 去比對 NL；`庫.表` 帶著點幾乎不可能是 NL 的子序列，
  // 照 label 評分會把跨庫的表全部淘汰掉——這條測試就是釘住「用裸名評分」。
  it("跨庫的表也會被挑進「最相關結構」並附完整欄位", async () => {
    const p = await buildSqlNlPrompt({ ...base, nl: "shipments 最近一筆", crossDbs: ["warehouse"] });
    expect(p).toContain("- warehouse.shipments: id int PK NOT NULL");
    expect(mocks.tableColumns).toHaveBeenCalledWith("c1", "warehouse", "shipments");
  });

  it("跨庫清單含目前庫時略過（不會列成 shop.orders）", async () => {
    const p = await buildSqlNlPrompt({ ...base, crossDbs: ["shop"] });
    expect(p).not.toContain("shop.orders");
    expect(p).toContain("全部資料表（2 張）");
  });

  it("某個跨庫列不出表時只讓它缺席，其餘照常", async () => {
    mocks.listTables.mockImplementation(async (_id: string, database: string) => {
      if (database === "denied") throw new Error("access denied");
      return [{ name: "orders", kind: "table" }];
    });
    const p = await buildSqlNlPrompt({ ...base, crossDbs: ["denied"] });
    expect(p).toContain("全部資料表（1 張）：orders");
    expect(p).not.toContain("可跨資料庫查詢");
  });
});
