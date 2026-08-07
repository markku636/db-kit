import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildReviewPrompt,
  buildStressAnalysisPrompt,
  buildTunePrompt,
  collectSchemaContext,
  fencedBlock,
  type LintFinding,
  type ReviewInput,
  type SchemaContext,
  type TuneInput,
} from "./aiReview";

// api 只 mock 掉三支會被 collectSchemaContext 呼叫的方法，其餘（KIND_META 等常數）保留真值——
// prompt 的方言標籤就是從 KIND_META 來的，整包換成假的就測不到真正會送出的字串。
const mocks = vi.hoisted(() => ({
  listTables: vi.fn(),
  tableColumns: vi.fn(),
  tableIndexes: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const schema: SchemaContext = {
  tables: "- orders: id int PK NOT NULL, user_id int, amount decimal(10,2)",
  indexes: "- orders: PRIMARY(id) PK; idx_user(user_id)",
};

const findings: LintFinding[] = [
  {
    id: "select-star",
    severity: "warn",
    line: 1,
    col: 8,
    from: 7,
    to: 8,
    message: "使用了 SELECT *",
    hint: "只列出真正需要的欄位",
  },
];

const review: ReviewInput = {
  kind: "mysql",
  db: "sakila",
  sql: "SELECT * FROM orders WHERE user_id = 1",
  findings,
  schema,
  planJson: null,
  uiLang: "zh-TW",
};

const tune: TuneInput = {
  ...review,
  planSummary: { nodes: 5, tables: 2, maxCost: 1238.2 },
  hotNodes: ["orders：全表掃描，成本 980", "Nested Loop：估計 12000 列"],
  rowCounts: { orders: 1200000 },
};

describe("fencedBlock", () => {
  it("一般內容用三個反引號", () => {
    expect(fencedBlock("sql", "SELECT 1")).toBe("```sql\nSELECT 1\n```");
  });

  it("內容含 ``` 時圍籬多一個（否則區塊會提早收掉）", () => {
    expect(fencedBlock("sql", "SELECT '```' AS a")).toBe("````sql\nSELECT '```' AS a\n````");
  });

  it("圍籬永遠比內容最長的反引號串多一個", () => {
    expect(fencedBlock("json", "{\"a\":\"````\"}")).toBe("`````json\n{\"a\":\"````\"}\n`````");
    expect(fencedBlock("sql", "SELECT `a`")).toBe("```sql\nSELECT `a`\n```");
  });

  it("去除內容前後空白", () => {
    expect(fencedBlock("sql", "\n\nSELECT 1\n\n")).toBe("```sql\nSELECT 1\n```");
  });

  it("內容含十萬個反引號串也不丟 RangeError（本函式開放給主線複用，未必先夾過上限）", () => {
    const body = "`x`".repeat(200_000);
    expect(() => fencedBlock("sql", body)).not.toThrow();
    expect(fencedBlock("sql", body).startsWith("``sql")).toBe(false); // 圍籬至少三個
  });
});

describe("buildReviewPrompt", () => {
  it("抬頭帶方言 label 與資料庫名", () => {
    const p = buildReviewPrompt(review);
    expect(p).toContain("MySQL");
    expect(p).toContain("sakila");
    expect(p.indexOf("MySQL")).toBeLessThan(p.indexOf("【待審 SQL】"));
  });

  it("方言 label 取自 KIND_META（不是 kind 字串本身）", () => {
    expect(buildReviewPrompt({ ...review, kind: "postgres" })).toContain("PostgreSQL");
  });

  it("要求逐條點評（含規則引擎看不出來的）與一段可執行的改寫 SQL", () => {
    const p = buildReviewPrompt(review);
    expect(p).toContain("規則引擎已標出的問題");
    expect(p).toContain("規則引擎看不出來的問題");
    expect(p).toContain("```sql 區塊");
  });

  it("SQL 包在 fenced block 裡", () => {
    const p = buildReviewPrompt(review);
    expect(p).toContain("```sql\nSELECT * FROM orders WHERE user_id = 1\n```");
  });

  it("含 ``` 的 SQL 用四個反引號的圍籬", () => {
    const p = buildReviewPrompt({ ...review, sql: "SELECT 1 -- ```json" });
    expect(p).toContain("````sql\nSELECT 1 -- ```json\n````");
  });

  it("findings 非空：帶出規則代號 / 位置 / 訊息 / 建議", () => {
    const p = buildReviewPrompt(review);
    expect(p).toContain("select-star");
    expect(p).toContain("warn");
    expect(p).toContain("第 1 行第 8 欄");
    expect(p).toContain("使用了 SELECT *");
    expect(p).toContain("只列出真正需要的欄位");
  });

  it("findings 為空：明說「已檢查、沒有發現」而非留白", () => {
    const p = buildReviewPrompt({ ...review, findings: [] });
    expect(p).toContain("沒有發現問題");
    expect(p).toContain("不是沒有執行");
  });

  it("planJson 有值：以 ```json 區塊附上", () => {
    const p = buildReviewPrompt({ ...review, planJson: '{"query_block":{"select_id":1}}' });
    expect(p).toContain('```json\n{"query_block":{"select_id":1}}\n```');
  });

  it("planJson 無值：明說未取得並禁止杜撰", () => {
    const p = buildReviewPrompt(review);
    expect(p).toContain("未取得執行計畫");
    expect(p).toContain("不要杜撰");
    expect(p).not.toContain("```json");
  });

  it("帶上結構與索引；缺結構時明說不要假設索引存在", () => {
    expect(buildReviewPrompt(review)).toContain("idx_user(user_id)");
    const p = buildReviewPrompt({ ...review, schema: { tables: "", indexes: "" } });
    expect(p).toContain("請勿假設任何索引存在");
  });

  it("uiLang 為 en 時加上英文回覆要求；zh-TW 不加", () => {
    expect(buildReviewPrompt({ ...review, uiLang: "en" })).toContain("Reply in English.");
    expect(buildReviewPrompt({ ...review, uiLang: "en-US" })).toContain("Reply in English.");
    expect(buildReviewPrompt(review)).not.toContain("Reply in English.");
  });

  it("超長 SQL 的截斷提示落在圍籬外（在裡面會被當成待改寫語句的最後一行）", () => {
    const sql = "SELECT " + Array.from({ length: 1500 }, (_, i) => `col_${i}`).join(", ") + " FROM orders";
    const p = buildReviewPrompt({ ...review, sql });
    expect(p).toContain("\n```\n…（內容過長，其餘已截斷）");
    expect(p).not.toContain("…（內容過長，其餘已截斷）\n```");
  });

  it("超長執行計畫同樣夾上限，提示在 ```json 區塊外", () => {
    const planJson = `{"x":"${"y".repeat(20_000)}"}`;
    const p = buildReviewPrompt({ ...review, planJson });
    expect(p.length).toBeLessThan(20_000);
    expect(p).toContain("\n```\n…（內容過長，其餘已截斷）");
  });

  it("呼叫端自備的超大 schema 也會被夾上限（SchemaContext 未必出自 collectSchemaContext）", () => {
    const huge = "- t: " + "x".repeat(200_000);
    const p = buildReviewPrompt({ ...review, schema: { tables: huge, indexes: huge } });
    expect(p.length).toBeLessThan(20_000);
    expect(p).toContain("…（內容過長，其餘已截斷）");
  });

  it("一般大小的 schema 原樣帶過，不會被誤截", () => {
    const p = buildReviewPrompt(review);
    expect(p).toContain(schema.tables);
    expect(p).toContain(schema.indexes);
    expect(p).not.toContain("內容過長");
  });
});

describe("buildTunePrompt", () => {
  it("四個段落要求都在（診斷 / 索引 DDL / 改寫 / 效益與風險）", () => {
    const p = buildTunePrompt(tune);
    expect(p).toContain("瓶頸診斷");
    expect(p).toContain("建議索引");
    expect(p).toContain("改寫後的 SQL");
    expect(p).toContain("預期效益與風險");
    // 風險要具體講寫入成本與空間，否則模型只會說「索引有代價」。
    expect(p).toContain("INSERT / UPDATE / DELETE");
    expect(p).toContain("磁碟空間");
  });

  it("要求讀計畫講、不要泛論", () => {
    const p = buildTunePrompt(tune);
    expect(p).toContain("指名節點");
    expect(p).toContain("泛論");
  });

  it("帶出計畫摘要與熱點節點", () => {
    const p = buildTunePrompt(tune);
    expect(p).toContain("節點數 5");
    expect(p).toContain("資料表 2");
    expect(p).toContain("1,238.2");
    expect(p).toContain("- orders：全表掃描，成本 980");
    expect(p).toContain("- Nested Loop：估計 12000 列");
  });

  it("planSummary 為 null / maxCost 未知時不炸且明說", () => {
    expect(buildTunePrompt({ ...tune, planSummary: null })).toContain("(無計畫摘要)");
    expect(buildTunePrompt({ ...tune, planSummary: { nodes: 1, tables: 1, maxCost: null } })).toContain("(未知)");
  });

  it("hotNodes 為空時明說未標出熱點", () => {
    expect(buildTunePrompt({ ...tune, hotNodes: [] })).toContain("(未標出熱點節點)");
  });

  it("rowCounts 有值才出現該段，且加千分位", () => {
    expect(buildTunePrompt(tune)).toContain("- orders: 1,200,000");
    const p = buildTunePrompt({ ...tune, rowCounts: undefined });
    expect(p).not.toContain("【資料表列數估計】");
  });

  it("沿用審查的 findings / plan / 語系規則", () => {
    expect(buildTunePrompt({ ...tune, findings: [] })).toContain("沒有發現問題");
    expect(buildTunePrompt({ ...tune, planJson: '{"Plan":{}}' })).toContain('```json\n{"Plan":{}}\n```');
    expect(buildTunePrompt(tune)).toContain("未取得執行計畫");
    expect(buildTunePrompt({ ...tune, uiLang: "en" })).toContain("Reply in English.");
  });
});

describe("buildStressAnalysisPrompt", () => {
  const stress = {
    kind: "mysql" as const,
    sql: "SELECT * FROM orders WHERE id = :id",
    reportMarkdown: "# 壓力測試報告\n\n| P99 | 812 ms |",
    planJson: null,
    schema,
    uiLang: "zh-TW",
  };

  it("交代方言（壓測情境沒有資料庫名）", () => {
    const p = buildStressAnalysisPrompt(stress);
    expect(p).toContain("MySQL");
    expect(p).toContain("壓力測試報告");
  });

  it("要求從百分位形狀判讀瓶頸類型", () => {
    const p = buildStressAnalysisPrompt(stress);
    expect(p).toContain("p99 遠大於 p50");
    expect(p).toContain("排隊");
    expect(p).toContain("鎖競爭");
    expect(p).toContain("整體平坦但偏高");
  });

  it("要求解讀錯誤分組與下一步該量什麼", () => {
    const p = buildStressAnalysisPrompt(stress);
    expect(p).toContain("錯誤分組的意義");
    expect(p).toContain("下一步該量什麼");
  });

  it("原樣嵌入報告 Markdown，並另附受測語句", () => {
    const p = buildStressAnalysisPrompt(stress);
    expect(p).toContain("| P99 | 812 ms |");
    expect(p).toContain("```sql\nSELECT * FROM orders WHERE id = :id\n```");
  });

  it("schema 省略 / 為 null 也不炸", () => {
    const p = buildStressAnalysisPrompt({ ...stress, schema: null });
    expect(p).toContain("請勿假設任何索引存在");
    expect(() => buildStressAnalysisPrompt({ kind: "postgres", sql: "SELECT 1", reportMarkdown: "x", uiLang: "en" })).not.toThrow();
  });

  it("planJson 有 / 無與英文語系", () => {
    expect(buildStressAnalysisPrompt({ ...stress, planJson: "[]" })).toContain("```json\n[]\n```");
    expect(buildStressAnalysisPrompt(stress)).toContain("未取得執行計畫");
    expect(buildStressAnalysisPrompt({ ...stress, uiLang: "en" })).toContain("Reply in English.");
  });

  it("報告被夾斷在 ```sql 區塊中間時補回收尾圍籬（否則後面所有段落都被讀成程式碼）", () => {
    // reportToMarkdown 把受測語句放在報告最尾端，語句一長就正好被上限切在區塊中間。
    const reportMarkdown = `${"a\n".repeat(3985)}\`\`\`sql\nSELECT ${"col, ".repeat(60)}1\n\`\`\``;
    const p = buildStressAnalysisPrompt({ ...stress, reportMarkdown });
    expect(reportMarkdown.length).toBeGreaterThan(8000); // 前提：確實會被截
    expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(p).toContain("\n```\n…（內容過長，其餘已截斷）");
    // 截斷後仍要讀得到後面的段落標題。
    expect(p).toContain("【受測語句】");
  });

  it("報告沒超過上限時不動它（不會平白多一道圍籬）", () => {
    const reportMarkdown = "# 壓力測試報告\n\n```sql\nSELECT 1\n```";
    const p = buildStressAnalysisPrompt({ ...stress, reportMarkdown });
    expect(p).toContain(reportMarkdown);
    expect(p).not.toContain("內容過長");
  });
});

describe("collectSchemaContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTables.mockResolvedValue([
      { name: "orders", kind: "table" },
      { name: "users", kind: "table" },
      { name: "audit_log", kind: "table" },
    ]);
    mocks.tableColumns.mockImplementation(async (_id: string, _db: string, table: string) => [
      { name: "id", data_type: "int", nullable: false, key: "PRI", default: null, extra: "" },
      { name: `${table}_note`, data_type: "text", nullable: true, key: "", default: null, extra: "" },
    ]);
    mocks.tableIndexes.mockResolvedValue([
      { name: "PRIMARY", columns: ["id"], unique: true, primary: true },
    ]);
  });

  it("挑出 SQL 提到的表並組出欄位 / 索引兩段", async () => {
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT * FROM orders JOIN users USING (id)");
    expect(ctx.tables).toContain("- orders: id int PK NOT NULL, orders_note text");
    expect(ctx.tables).toContain("- users:");
    expect(ctx.indexes).toContain("- orders: PRIMARY(id) PK");
    // 不相關的表不進 prompt（rankTables 只挑相關者）。
    expect(ctx.tables).not.toContain("audit_log");
  });

  it("反引號括住的識別字也挑得到（不能先 stripCode）", async () => {
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT * FROM `orders`");
    expect(ctx.tables).toContain("- orders:");
  });

  it("selectedTable 一定入選", async () => {
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT 1", "audit_log");
    expect(ctx.tables).toContain("- audit_log:");
  });

  it("某張表抓不到欄位時不整個炸掉，其他表照常", async () => {
    mocks.tableColumns.mockImplementation(async (_id: string, _db: string, table: string) => {
      if (table === "orders") throw new Error("permission denied");
      return [{ name: "id", data_type: "int", nullable: false, key: "PRI", default: null, extra: "" }];
    });
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT * FROM orders JOIN users USING (id)");
    expect(ctx.tables).not.toContain("- orders:");
    expect(ctx.tables).toContain("- users: id int PK NOT NULL");
    // 欄位失敗不連累索引：兩支 api 各自 catch。
    expect(ctx.indexes).toContain("- orders: PRIMARY(id) PK");
  });

  it("索引抓不到時欄位仍在", async () => {
    mocks.tableIndexes.mockRejectedValue(new Error("boom"));
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT * FROM orders");
    expect(ctx.tables).toContain("- orders:");
    expect(ctx.indexes).toBe("");
  });

  it("表沒有任何索引時明寫「(無索引)」", async () => {
    mocks.tableIndexes.mockResolvedValue([]);
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT * FROM orders");
    expect(ctx.indexes).toContain("- orders: (無索引)");
  });

  it("listTables 失敗 → 回空字串而非丟例外", async () => {
    mocks.listTables.mockRejectedValue(new Error("connection lost"));
    await expect(collectSchemaContext("c1", "sakila", "SELECT 1")).resolves.toEqual({ tables: "", indexes: "" });
    expect(mocks.tableColumns).not.toHaveBeenCalled();
  });

  it("表有零個欄位時明寫「(無欄位資訊)」而非留下冒號後空白", async () => {
    mocks.tableColumns.mockResolvedValue([]);
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT * FROM orders");
    expect(ctx.tables).toContain("- orders: (無欄位資訊)");
  });

  it("寬表超過上限時整行整行地砍，不會把欄位名切成半截", async () => {
    const wide = ["orders", "users", "payments", "shipments", "invoices", "refunds"];
    mocks.listTables.mockResolvedValue(wide.map((name) => ({ name, kind: "table" })));
    mocks.tableColumns.mockImplementation(async (_id: string, _db: string, table: string) =>
      Array.from({ length: 60 }, (_, i) => ({
        name: `${table}_column_with_a_pretty_long_name_${i}`,
        data_type: "varchar(255)", nullable: true, key: "", default: null, extra: "",
      })),
    );
    const ctx = await collectSchemaContext("c1", "sakila", `SELECT * FROM ${wide.join(" JOIN ")}`);
    // 每一行都必須是完整的一張表（`- 表名: …`），最後一個欄位不能是被切一半的名字。
    for (const line of ctx.tables.split("\n")) {
      if (line.startsWith("（")) continue; // 截斷註記
      expect(line.startsWith("- ")).toBe(true);
      expect(line.endsWith("varchar(255)")).toBe(true);
    }
    expect(ctx.tables).toMatch(/（另有 \d+ 張表因內容過長未列出。）/);
  });

  it("挑表達到上限時明說「未列出的表不代表沒有索引」（否則會建議去建已存在的索引）", async () => {
    const many = ["orders", "users", "payments", "shipments", "invoices", "refunds", "coupons", "carts"];
    mocks.listTables.mockResolvedValue(many.map((name) => ({ name, kind: "table" })));
    const ctx = await collectSchemaContext("c1", "sakila", `SELECT * FROM ${many.join(" JOIN ")}`);
    expect(ctx.indexes).toContain("未列出的表不代表沒有索引");
    expect(ctx.tables).toContain("僅列出與這段 SQL 最相關的 6 張表");
  });

  it("表少於上限（沒東西被丟掉）時不加那句註記", async () => {
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT * FROM orders");
    expect(ctx.tables).not.toContain("僅列出");
    expect(ctx.indexes).not.toContain("僅列出");
  });

  it("UNIQUE 索引標註得出來", async () => {
    mocks.tableIndexes.mockResolvedValue([
      { name: "uq_email", columns: ["email", "tenant_id"], unique: true, primary: false },
    ]);
    const ctx = await collectSchemaContext("c1", "sakila", "SELECT * FROM users");
    expect(ctx.indexes).toContain("- users: uq_email(email, tenant_id) UNIQUE");
  });
});
