import { describe, it, expect, vi, beforeEach } from "vitest";

// api 只 mock 掉會被 expandMentions / buildAutoContext 呼叫的四支，其餘（KIND_META 等常數）
// 保留真值——抬頭的方言標籤就是從 KIND_META 來的，整包換掉就測不到真正會送出的字串。
const mocks = vi.hoisted(() => ({
  listTables: vi.fn(),
  tableColumns: vi.fn(),
  tableIndexes: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

// vitest 跑在 node 環境（無 jsdom）：buildAutoContext 會動態 import store，而 store 一載入
// 就會讀 localStorage。先補一份 in-memory 版本（同 store.test.ts）再 import。
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}
vi.stubGlobal("localStorage", new MemoryStorage());

const {
  MENTION_BUDGET,
  MAX_RESULT_ROWS,
  buildAutoContext,
  estimateContext,
  expandMentions,
  parseMentions,
  stripMentions,
} = await import("./chatMentions");
const { useStore } = await import("./store");
type MentionEnv = import("./chatMentions").MentionEnv;
type MentionRef = import("./chatTypes").MentionRef;
type EditorSnapshot = import("./chatTypes").EditorSnapshot;
type ConnectionConfig = import("./api").ConnectionConfig;

// ---- 共用夾具 ----

const env = (over?: Partial<MentionEnv>): MentionEnv => ({
  connId: "c1",
  kind: "mysql",
  db: "sakila",
  editor: null,
  uiLang: "zh-TW",
  ...over,
});

const snapshot = (over?: Partial<EditorSnapshot>): EditorSnapshot => ({
  tabId: "__query__",
  connId: "c1",
  kind: "mysql",
  db: "sakila",
  sql: "SELECT * FROM orders",
  selection: null,
  result: null,
  resultSql: null,
  error: null,
  updatedAt: 1,
  ...over,
});

const cols = (table: string, n = 2) =>
  Array.from({ length: n }, (_, i) => ({
    name: i === 0 ? "id" : `${table}_col_${i}`,
    data_type: i === 0 ? "int" : "varchar(255)",
    nullable: i !== 0,
    key: i === 0 ? "PRI" : "",
    default: null,
    extra: "",
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTables.mockResolvedValue([
    { name: "orders", kind: "table" },
    { name: "users", kind: "table" },
  ]);
  mocks.tableColumns.mockImplementation(async (_id: string, _db: string, table: string) => cols(table));
  mocks.tableIndexes.mockResolvedValue([{ name: "PRIMARY", columns: ["id"], unique: true, primary: true }]);
  mocks.readTextFile.mockResolvedValue("SELECT 1;");
});

// ---- 文法 ----

describe("parseMentions", () => {
  it("裸名 → 資料表，位移落在 @ 與最後一個字之後", () => {
    const refs = parseMentions("看 @orders 這張表");
    expect(refs).toEqual([
      { kind: "table", raw: "@orders", from: 2, to: 9, db: null, table: "orders" },
    ]);
  });

  it("前綴 table: / db: / file:", () => {
    expect(parseMentions("@table:orders")[0]).toMatchObject({ kind: "table", db: null, table: "orders" });
    expect(parseMentions("@db:shop")[0]).toMatchObject({ kind: "db", db: "shop" });
    expect(parseMentions("@file:queries/daily.sql")[0]).toMatchObject({ kind: "file", path: "queries/daily.sql" });
  });

  it("雙引號可含空白（含空白的表名 / 檔名只有這條路）", () => {
    expect(parseMentions('@table:"order details"')[0]).toMatchObject({ kind: "table", table: "order details" });
    expect(parseMentions('@file:"a b.sql"')[0]).toMatchObject({ kind: "file", path: "a b.sql" });
    // raw 要含引號，否則輸入框改寫時會少算兩個字元。
    expect(parseMentions('@file:"a b.sql"')[0].raw).toBe('@file:"a b.sql"');
  });

  it("一個點 = 庫.表", () => {
    expect(parseMentions("@shop.orders")[0]).toMatchObject({ kind: "table", db: "shop", table: "orders" });
    expect(parseMentions("@table:shop.orders")[0]).toMatchObject({ kind: "table", db: "shop", table: "orders" });
  });

  it("引號關掉庫.表 的拆分（使用者已經框起來了，那就是完整的名字）", () => {
    expect(parseMentions('@table:"a.b"')[0]).toMatchObject({ kind: "table", db: null, table: "a.b" });
  });

  // 沒有這一關，任何貼進來的 email 都會變成一張不存在的表塞進 prompt。
  it("email 不算提及（@ 左邊不是邊界字元）", () => {
    expect(parseMentions("請寄到 user@example.com 謝謝")).toEqual([]);
    expect(parseMentions("a@b")).toEqual([]);
  });

  it("全形標點也算左邊界（本 app 的輸入絕大多數是中文）", () => {
    expect(parseMentions("（@orders）")[0]).toMatchObject({ table: "orders", from: 1, to: 8 });
    expect(parseMentions("比較：@db:shop 與別的")[0]).toMatchObject({ kind: "db", db: "shop" });
    expect(parseMentions("a,@orders")[0]).toMatchObject({ table: "orders" });
  });

  it("保留字裸寫 → query / result / error；加前綴或引號則是同名的表", () => {
    expect(parseMentions("@query @result @error").map((r) => r.kind)).toEqual(["query", "result", "error"]);
    expect(parseMentions("@table:query")[0]).toMatchObject({ kind: "table", table: "query" });
    expect(parseMentions('@"result"')[0]).toMatchObject({ kind: "table", table: "result" });
  });

  // RESERVED 若用物件字面值，這裡會查到 Object.prototype.constructor 而把 kind 變成一個函式。
  it("叫 constructor / toString 的表不會撞到 Object.prototype", () => {
    expect(parseMentions("@constructor")[0]).toMatchObject({ kind: "table", table: "constructor" });
    expect(parseMentions("@toString")[0]).toMatchObject({ kind: "table", table: "toString" });
  });

  it("句尾標點不吃進名字，位移同步縮回來", () => {
    const [a] = parseMentions("@orders.");
    expect(a).toMatchObject({ table: "orders", db: null, to: 7, raw: "@orders" });
    const [b] = parseMentions("見 @file:report.sql.");
    expect(b).toMatchObject({ kind: "file", path: "report.sql" });
    expect(b.raw).toBe("@file:report.sql");
  });

  it("孤零零的 @ 不成立", () => {
    expect(parseMentions("@")).toEqual([]);
    expect(parseMentions("@ orders")).toEqual([]);
    expect(parseMentions("@@")).toEqual([]);
  });

  it("同一句多則提及：位移逐一精確", () => {
    const text = "請比較 @orders 與 @db:shop 的差異";
    const refs = parseMentions(text);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ from: 4, to: 11 });
    expect(refs[1]).toMatchObject({ from: 14, to: 22 });
    // 位移必須真的切得出原 token。
    expect(text.slice(refs[0].from, refs[0].to)).toBe("@orders");
    expect(text.slice(refs[1].from, refs[1].to)).toBe("@db:shop");
  });
});

describe("stripMentions", () => {
  it("token 換回純名字", () => {
    const one = (s: string) => stripMentions(s, parseMentions(s));
    expect(one("@table:orders")).toBe("orders");
    expect(one("@db:shop")).toBe("shop");
    expect(one('@file:"a b.sql"')).toBe("a b.sql");
    expect(one("@shop.orders")).toBe("shop.orders");
    expect(one("@query")).toBe("編輯器 SQL");
  });

  // 由前往後改的話，第一個替換就把第二個的位移推掉了。
  it("同一句兩則提及都要換對（由後往前套用）", () => {
    const text = "請比較 @table:orders 與 @db:shop 的差異";
    expect(stripMentions(text, parseMentions(text))).toBe("請比較 orders 與 shop 的差異");
  });

  it("位移越界的 ref 略過而不是丟例外（refs 常是過濾過的子集）", () => {
    const bad: MentionRef[] = [{ kind: "table", raw: "@x", from: 100, to: 200, db: null, table: "x" }];
    expect(stripMentions("短句", bad)).toBe("短句");
  });
});

// ---- 展開 ----

describe("expandMentions", () => {
  it("沒有提及時完全不輸出（免得模型去找不存在的附件）", async () => {
    await expect(expandMentions([], env())).resolves.toEqual({ context: "", chips: [] });
  });

  it("抬頭交代方言與資料庫，並附語系指示", async () => {
    const { context } = await expandMentions(parseMentions("@orders"), env({ uiLang: "en" }));
    expect(context.startsWith("【使用者以 @ 指定的參考內容】")).toBe(true);
    expect(context).toContain("方言：MySQL；資料庫：sakila");
    expect(context).toContain("Reply in English.");
  });

  it("資料表帶欄位與索引，chip 記錄實際字元數", async () => {
    const { context, chips } = await expandMentions(parseMentions("@orders"), env());
    expect(context).toContain("【資料表 orders】");
    expect(context).toContain("- 欄位：id int PK NOT NULL, orders_col_1 varchar(255)");
    expect(context).toContain("- 索引：PRIMARY(id) PK");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ kind: "table", label: "orders", table: "orders", db: null });
    expect(chips[0].bytes).toBeGreaterThan(20);
    expect(chips[0].skipped).toBeUndefined();
  });

  it("大小寫對回實際表名，同一個庫只 list 一次", async () => {
    const { context } = await expandMentions(parseMentions("@ORDERS @users"), env());
    expect(mocks.tableColumns).toHaveBeenCalledWith("c1", "sakila", "orders");
    expect(context).toContain("【資料表 users】");
    expect(mocks.listTables).toHaveBeenCalledTimes(1);
  });

  it("庫.表 去那個庫拿結構", async () => {
    mocks.listTables.mockImplementation(async (_id: string, database: string) =>
      database === "warehouse" ? [{ name: "shipments", kind: "table" }] : [{ name: "orders", kind: "table" }],
    );
    const { context, chips } = await expandMentions(parseMentions("@warehouse.shipments"), env());
    expect(mocks.tableColumns).toHaveBeenCalledWith("c1", "warehouse", "shipments");
    expect(context).toContain("【資料表 warehouse.shipments】");
    expect(chips[0]).toMatchObject({ label: "warehouse.shipments", db: "warehouse", table: "shipments" });
  });

  // 靜默丟掉一張表，模型會照著訊息裡的名字編一份欄位出來，而使用者看不出那是編的。
  it("表不存在 → chip 標 missing 且上下文明寫「沒有這張表」", async () => {
    const { context, chips } = await expandMentions(parseMentions("@nope"), env());
    expect(chips[0].skipped).toBe("missing");
    expect(context).toContain("【資料表 nope】");
    expect(context).toContain("沒有這張表");
    expect(context).toContain("請不要自行假設它存在");
    expect(mocks.tableColumns).not.toHaveBeenCalled();
  });

  it("list_tables 失敗時不誤報「不存在」，照樣去問欄位", async () => {
    mocks.listTables.mockRejectedValue(new Error("permission denied"));
    const { context, chips } = await expandMentions(parseMentions("@orders"), env());
    expect(chips[0].skipped).toBeUndefined();
    expect(context).toContain("- 欄位：id int PK NOT NULL");
  });

  it("欄位與索引各自 catch：索引掛了欄位仍在", async () => {
    mocks.tableIndexes.mockRejectedValue(new Error("boom"));
    const { context } = await expandMentions(parseMentions("@orders"), env());
    expect(context).toContain("- 欄位：id int PK NOT NULL");
    expect(context).not.toContain("- 索引：");
  });

  it("兩支都掛 → unavailable 並明說不要假設結構", async () => {
    mocks.tableColumns.mockRejectedValue(new Error("x"));
    mocks.tableIndexes.mockRejectedValue(new Error("x"));
    const { context, chips } = await expandMentions(parseMentions("@orders"), env());
    expect(chips[0].skipped).toBe("unavailable");
    expect(context).toContain("讀不到欄位與索引");
  });

  it("沒有索引 / 沒有欄位資訊都明寫（「一個索引都沒有」本身就是訊號）", async () => {
    mocks.tableIndexes.mockResolvedValue([]);
    mocks.tableColumns.mockResolvedValue([]);
    const { context } = await expandMentions(parseMentions("@orders"), env());
    expect(context).toContain("- 欄位：(無欄位資訊)");
    expect(context).toContain("- 索引：(無索引)");
  });

  it("單張表夾在 MAX_TABLE_CHARS，且不把欄位名切成半截", async () => {
    mocks.tableColumns.mockResolvedValue(cols("orders", 300));
    const { context, chips } = await expandMentions(parseMentions("@orders"), env());
    expect(context).toContain("…（內容過長，其餘已截斷）");
    expect(chips[0].bytes).toBeLessThan(2200);
  });

  it("@db: 列出表名並交代共幾張", async () => {
    const { context, chips } = await expandMentions(parseMentions("@db:sakila"), env());
    expect(context).toContain("【資料庫 sakila】共 2 張表：");
    expect(context).toContain("orders, users");
    expect(chips[0]).toMatchObject({ kind: "db", label: "sakila", db: "sakila" });
  });

  // 不講「共幾張」的話，模型會把這份清單當成完整的，然後斷言某張沒列出來的表不存在。
  it("超過 200 張時只列前 200 張並明講總數", async () => {
    mocks.listTables.mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => ({ name: `t${i}`, kind: "table" })),
    );
    const { context } = await expandMentions(parseMentions("@db:sakila"), env());
    expect(context).toContain("共 250 張表，以下只列出前 200 張：");
    expect(context).not.toContain("t249");
  });

  it("@db: 列不出來 → unavailable 且明說不要假設", async () => {
    mocks.listTables.mockRejectedValue(new Error("nope"));
    const { context, chips } = await expandMentions(parseMentions("@db:sakila"), env());
    expect(chips[0].skipped).toBe("unavailable");
    expect(context).toContain("列不出資料表");
  });

  it("@file: 讀得到就包成圍籬；讀不到明說而不是靜默消失", async () => {
    const ok = await expandMentions(parseMentions("@file:daily.sql"), env());
    expect(mocks.readTextFile).toHaveBeenCalledWith("daily.sql");
    expect(ok.context).toContain("【檔案 daily.sql】");
    expect(ok.context).toContain("```sql\nSELECT 1;\n```");
    expect(ok.chips[0]).toMatchObject({ kind: "file", path: "daily.sql" });

    mocks.readTextFile.mockRejectedValue(new Error("ENOENT"));
    const bad = await expandMentions(parseMentions("@file:missing.sql"), env());
    expect(bad.chips[0].skipped).toBe("unavailable");
    expect(bad.context).toContain("讀不到這個檔案");
    expect(bad.context).toContain("請不要自行假設它的內容");
  });

  it("@query 帶編輯器語句；有選取時只帶選取並講明是片段", async () => {
    const full = await expandMentions(parseMentions("@query"), env({ editor: snapshot() }));
    expect(full.context).toContain("```sql\nSELECT * FROM orders\n```");
    expect(full.context).not.toContain("選取的片段");

    const sel = await expandMentions(
      parseMentions("@query"),
      env({ editor: snapshot({ selection: "WHERE id = 1" }) }),
    );
    expect(sel.context).toContain("選取的片段");
    expect(sel.context).toContain("```sql\nWHERE id = 1\n```");
  });

  it("@error 帶訊息與出錯的語句", async () => {
    const { context } = await expandMentions(
      parseMentions("@error"),
      env({ editor: snapshot({ error: { message: "Unknown column 'x'", sql: "SELECT x FROM orders" } }) }),
    );
    expect(context).toContain("錯誤訊息：Unknown column 'x'");
    expect(context).toContain("```sql\nSELECT x FROM orders\n```");
  });

  // 快照會活過連線切換：拿 A 連線的錯誤去問 B 連線，模型會用錯方言解讀。
  it("編輯器快照屬於別條連線 → query / result / error 一律 unavailable", async () => {
    const stale = snapshot({ connId: "other" });
    const { context, chips } = await expandMentions(parseMentions("@query @result @error"), env({ editor: stale }));
    expect(chips.every((c) => c.skipped === "unavailable")).toBe(true);
    expect(context).toContain("屬於另一條連線");
  });

  it("@result 夾在 30 列並交代「附上幾列 / 共幾列」", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [String(i), `name_${i}`]);
    const editor = snapshot({
      result: { columns: ["id", "name"], rows, rows_affected: 0, truncated: false },
      resultSql: "SELECT id, name FROM users",
    });
    const { context } = await expandMentions(parseMentions("@result"), env({ editor }));
    expect(context).toContain(`以下附上前 ${MAX_RESULT_ROWS} 列，本次查詢共 50 列。`);
    expect(context).toContain("| id | name |");
    expect(context).toContain("| 29 | name_29 |");
    expect(context).not.toContain("name_30");
    expect(context).toContain("```sql\nSELECT id, name FROM users\n```");
  });

  // 後端已達 row cap 時，這 30 列連「本次載入的 50 列」都不是全部——不講明的話，
  // 模型會拿樣本去下「這個欄位只有三種值」之類的結論。
  it("後端已截斷時額外警告實際列數更多", async () => {
    const editor = snapshot({
      result: { columns: ["id"], rows: [["1"], ["2"]], rows_affected: 0, truncated: true },
    });
    const { context } = await expandMentions(parseMentions("@result"), env({ editor }));
    expect(context).toContain("以下附上前 2 列；本次載入 2 列，且後端已達列數上限截斷");
    expect(context).toContain("統計性的結論請勿依據這份樣本下");
  });

  it("沒有結果可附時明說，不是留白", async () => {
    const { context, chips } = await expandMentions(parseMentions("@result"), env({ editor: snapshot() }));
    expect(chips[0].skipped).toBe("unavailable");
    expect(context).toContain("目前沒有結果可附上");
  });

  it("@run 的內容隨 ref 夾帶，完全不碰 api", async () => {
    const ref: MentionRef = { kind: "run", raw: "@run:1", from: 0, to: 6, payload: "| a |\n| --- |\n| 1 |" };
    const { context, chips } = await expandMentions([ref], env());
    expect(context).toContain("【先前的執行結果】");
    expect(context).toContain("| a |");
    expect(chips[0].kind).toBe("run");
    expect(mocks.listTables).not.toHaveBeenCalled();

    const empty = await expandMentions([{ ...ref, payload: "" }], env());
    expect(empty.chips[0].skipped).toBe("unavailable");
  });

  it("沒有連線時 table / db 標 unavailable 而不是丟例外", async () => {
    const { context, chips } = await expandMentions(
      parseMentions("@orders @db:shop"),
      env({ connId: null, kind: null, db: "" }),
    );
    expect(chips.map((c) => c.skipped)).toEqual(["unavailable", "unavailable"]);
    expect(context).toContain("目前沒有連線");
    expect(mocks.listTables).not.toHaveBeenCalled();
    // kind / db 都沒有時抬頭仍在（只是少了方言那行）。
    expect(context.startsWith("【使用者以 @ 指定的參考內容】")).toBe(true);
  });

  it("展開順序：error → query → table → db → file → result", async () => {
    const editor = snapshot({
      result: { columns: ["id"], rows: [["1"]], rows_affected: 0, truncated: false },
      error: { message: "boom", sql: "" },
    });
    const { context } = await expandMentions(
      parseMentions("@result @file:a.sql @db:sakila @orders @query @error"),
      env({ editor }),
    );
    const at = (s: string) => context.indexOf(s);
    expect(at("【最近一次錯誤】")).toBeGreaterThan(-1);
    expect(at("【最近一次錯誤】")).toBeLessThan(at("【編輯器 SQL】"));
    expect(at("【編輯器 SQL】")).toBeLessThan(at("【資料表 orders】"));
    expect(at("【資料表 orders】")).toBeLessThan(at("【資料庫 sakila】"));
    expect(at("【資料庫 sakila】")).toBeLessThan(at("【檔案 a.sql】"));
    expect(at("【檔案 a.sql】")).toBeLessThan(at("【查詢結果】"));
  });

  it("同一個目標寫兩種寫法只展開一次", async () => {
    const { chips } = await expandMentions(parseMentions("@orders @table:orders @ORDERS"), env());
    expect(chips).toHaveLength(1);
    expect(mocks.tableColumns).toHaveBeenCalledTimes(1);
  });

  it("超出總預算：後面的 chip 標 budget、點名被丟掉的，抬頭照樣在", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `t${i}`);
    mocks.listTables.mockResolvedValue(names.map((name) => ({ name, kind: "table" })));
    // 每張表都超過 MAX_TABLE_CHARS，一段約 2 KB —— 12 KB 的總預算放不下十張。
    mocks.tableColumns.mockImplementation(async (_id: string, _db: string, table: string) => cols(table, 300));
    const { context, chips } = await expandMentions(parseMentions(names.map((n) => `@${n}`).join(" ")), env());

    const kept = chips.filter((c) => c.skipped === undefined);
    const over = chips.filter((c) => c.skipped === "budget");
    expect(kept.length).toBeGreaterThan(0);
    expect(over.length).toBeGreaterThan(0);
    expect(kept.length + over.length).toBe(10);
    // 被擠掉的不佔字數，且要被點名。
    expect(over.every((c) => c.bytes === 0)).toBe(true);
    expect(context).toContain("因為內容超出上限而沒有附上");
    for (const c of over) expect(context).toContain(c.label);
    // 抬頭不計入預算，永遠都在——模型至少要知道自己在看哪一種方言。
    expect(context.startsWith("【使用者以 @ 指定的參考內容】")).toBe(true);
    expect(context).toContain("方言：MySQL；資料庫：sakila");
    expect(estimateContext(chips).bytes).toBeLessThanOrEqual(MENTION_BUDGET);
  });
});

describe("estimateContext", () => {
  it("bytes 是各 chip 的總和，tokens 取 bytes / 3 四捨五入", () => {
    expect(estimateContext([])).toEqual({ bytes: 0, tokens: 0 });
    expect(estimateContext([
      { kind: "table", label: "a", bytes: 100 },
      { kind: "db", label: "b", bytes: 200 },
    ])).toEqual({ bytes: 300, tokens: 100 });
    // 400 / 3 = 133.33… → 133
    expect(estimateContext([{ kind: "file", label: "f", bytes: 400 }]).tokens).toBe(133);
    // 被擠掉的 chip 不計入。
    expect(estimateContext([{ kind: "table", label: "a", bytes: 0, skipped: "budget" }]).bytes).toBe(0);
  });
});

// ---- 自動上下文 ----

describe("buildAutoContext", () => {
  const conn = (over?: Partial<ConnectionConfig>): ConnectionConfig => ({
    id: "c1",
    name: "local",
    kind: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: "sakila",
    ...over,
  });

  beforeEach(() => {
    useStore.setState({ connections: [conn()], activeId: "c1", selectedNode: null });
  });

  it("沒有作用中的連線 → 空字串（不要平白灌一段沒內容的環境描述）", async () => {
    useStore.setState({ activeId: null });
    await expect(buildAutoContext(env())).resolves.toBe("");
  });

  it("帶類型 / 位址 / 預設資料庫", async () => {
    const ctx = await buildAutoContext(env());
    expect(ctx).toContain("資料庫類型：MySQL");
    expect(ctx).toContain("連線位址：127.0.0.1:3306");
    expect(ctx).toContain("預設資料庫：sakila");
    expect(ctx).toContain("【目前資料庫環境】");
  });

  it("檔案型資料庫不列連線位址（SQLite 沒有 host:port 可言）", async () => {
    useStore.setState({ connections: [conn({ kind: "sqlite", database: null })], activeId: "c1" });
    const ctx = await buildAutoContext(env());
    expect(ctx).toContain("資料庫類型：SQLite");
    expect(ctx).not.toContain("連線位址");
  });

  it("選取資料表時附上欄位", async () => {
    useStore.setState({
      selectedNode: { type: "table", connId: "c1", db: "sakila", table: "orders", kind: "mysql", objKind: "table" },
    });
    const ctx = await buildAutoContext(env());
    expect(ctx).toContain("目前選取資料表：sakila.orders");
    expect(ctx).toContain("欄位：id int PK NOT NULL");
  });

  // 同一份欄位清單出現兩次，模型會以為那是兩張剛好同名的表。
  it("skipTable 命中時不再抓一次欄位（裸名與 庫.表 兩種寫法都認）", async () => {
    useStore.setState({
      selectedNode: { type: "table", connId: "c1", db: "sakila", table: "orders", kind: "mysql", objKind: "table" },
    });
    const bare = await buildAutoContext(env(), { skipTable: "ORDERS" });
    expect(bare).toContain("目前選取資料表：sakila.orders");
    expect(bare).not.toContain("欄位：");
    expect(mocks.tableColumns).not.toHaveBeenCalled();

    const qualified = await buildAutoContext(env(), { skipTable: "sakila.orders" });
    expect(qualified).not.toContain("欄位：");

    // 提及的是別張表時照常帶。
    const other = await buildAutoContext(env(), { skipTable: "users" });
    expect(other).toContain("欄位：id int PK NOT NULL");
  });

  it("選取的節點屬於別條連線時不理它", async () => {
    useStore.setState({
      selectedNode: { type: "database", connId: "other", db: "shop", kind: "mysql" },
    });
    expect(await buildAutoContext(env())).not.toContain("目前選取資料庫");
  });

  it("抓欄位失敗不擋整段環境描述", async () => {
    mocks.tableColumns.mockRejectedValue(new Error("denied"));
    useStore.setState({
      selectedNode: { type: "table", connId: "c1", db: "sakila", table: "orders", kind: "mysql", objKind: "table" },
    });
    const ctx = await buildAutoContext(env());
    expect(ctx).toContain("目前選取資料表：sakila.orders");
    expect(ctx).not.toContain("欄位：");
  });

  it("非繁中語系附上回覆語言指示", async () => {
    expect(await buildAutoContext(env({ uiLang: "ja" }))).toContain("日本語で回答してください。");
    expect(await buildAutoContext(env())).not.toContain("Reply in English.");
  });
});
