import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SLASH_COMMANDS,
  expandSlash,
  parseSlash,
  type SlashAction,
  type SlashCommand,
  type SlashEnv,
} from "./slashCommands";
import type { EditorSnapshot } from "./chatTypes";

// api 只 mock 掉會被轉呼叫的五支（collectSchemaContext 三支 + NL prompt 的 ES 兩支），
// 其餘（KIND_META 等常數）保留真值——prompt 裡的方言標籤就是從 KIND_META 來的，
// 整包換成假的就測不到真正會送出的字串。
const mocks = vi.hoisted(() => ({
  listTables: vi.fn(),
  tableColumns: vi.fn(),
  tableIndexes: vi.fn(),
  esIndices: vi.fn(),
  esMapping: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

// ---- 共用夾具 ----

const env = (over?: Partial<SlashEnv>): SlashEnv => ({
  connId: "c1",
  kind: "mysql",
  db: "sakila",
  editor: null,
  selectedTable: null,
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

const cmd = (name: string): SlashCommand => {
  const c = SLASH_COMMANDS.find((x) => x.name === name);
  if (!c) throw new Error(`no such command: ${name}`);
  return c;
};

/** 展開後斷言它是 send（其餘分支在測試裡直接讀 kind），省掉每個案例都寫一次縮小型別。 */
const send = async (name: string, arg: string, e: SlashEnv) => {
  const a = await expandSlash(cmd(name), arg, e);
  if (a.kind !== "send") throw new Error(`expected send, got ${a.kind}: ${JSON.stringify(a)}`);
  return a;
};

const kindOf = async (name: string, arg: string, e: SlashEnv): Promise<SlashAction["kind"]> =>
  (await expandSlash(cmd(name), arg, e)).kind;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTables.mockResolvedValue([
    { name: "orders", kind: "table" },
    { name: "users", kind: "table" },
  ]);
  mocks.tableColumns.mockImplementation(async (_id: string, _db: string, table: string) => [
    { name: "id", data_type: "int", nullable: false, key: "PRI", default: null, extra: "" },
    { name: `${table}_note`, data_type: "text", nullable: true, key: "", default: null, extra: "" },
  ]);
  mocks.tableIndexes.mockResolvedValue([{ name: "PRIMARY", columns: ["id"], unique: true, primary: true }]);
  mocks.esIndices.mockResolvedValue([{ index: "logs-2024" }]);
  mocks.esMapping.mockResolvedValue('{"properties":{"level":{"type":"keyword"}}}');
});

// ---- 清單 ----

describe("SLASH_COMMANDS", () => {
  it("十一條命令、名稱不重複且都帶前導斜線", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toEqual(["/explain", "/fix", "/optimize", "/sql", "/schema", "/shell", "/term", "/tfix", "/clear", "/export", "/new"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("每條都有說明（自動完成選單靠它，空字串會是一片空白）", () => {
    for (const c of SLASH_COMMANDS) expect(c.hint.trim().length).toBeGreaterThan(0);
  });
});

// ---- parseSlash ----

describe("parseSlash", () => {
  it("完全相符", () => {
    expect(parseSlash("/explain")).toEqual({ cmd: cmd("/explain"), arg: "" });
    expect(parseSlash("/clear")).toEqual({ cmd: cmd("/clear"), arg: "" });
  });

  it("參數取第一個空白之後的全部，並去掉兩端空白", () => {
    expect(parseSlash("/sql   上個月金額最高的十筆訂單   ")?.arg).toBe("上個月金額最高的十筆訂單");
    expect(parseSlash("/explain SELECT 1")?.arg).toBe("SELECT 1");
  });

  it("換行也算分隔（多行輸入很常見）", () => {
    const r = parseSlash("/sql\n上個月的訂單");
    expect(r?.cmd.name).toBe("/sql");
    expect(r?.arg).toBe("上個月的訂單");
  });

  it("參數內部的空白與換行原樣保留", () => {
    expect(parseSlash("/explain SELECT 1\nFROM orders")?.arg).toBe("SELECT 1\nFROM orders");
  });

  it("前綴唯一時成立", () => {
    expect(parseSlash("/expl")?.cmd.name).toBe("/explain");
    expect(parseSlash("/f")?.cmd.name).toBe("/fix");
    expect(parseSlash("/n")?.cmd.name).toBe("/new");
    expect(parseSlash("/o SELECT 1")?.cmd.name).toBe("/optimize");
  });

  // 猜錯的代價不對等：猜成 /explain 會把整個編輯器的內容送出去，回 null 只是讓人把字打完。
  it("前綴同時像多條時回 null，不猜", () => {
    expect(parseSlash("/exp")).toBeNull(); // explain / export
    expect(parseSlash("/e")).toBeNull();
    expect(parseSlash("/s")).toBeNull(); // sql / schema
  });

  it("裸寫一個斜線回 null（每一條都符合前綴）", () => {
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash("/ 幫我看看")).toBeNull();
  });

  it("不是命令一律回 null", () => {
    expect(parseSlash("explain this")).toBeNull();
    expect(parseSlash("/nope")).toBeNull();
    expect(parseSlash("")).toBeNull();
    // 句中的路徑不該被當成命令。
    expect(parseSlash("讀不到 /usr/local/bin/mysql")).toBeNull();
  });

  it("開頭的路徑仍然回 null（認不出來就是一般訊息）", () => {
    expect(parseSlash("/usr/local/bin/mysql 跑不起來")).toBeNull();
  });

  it("允許前導空白（貼上常會帶進來）", () => {
    expect(parseSlash("   /clear")?.cmd.name).toBe("/clear");
  });

  it("大小寫不敏感（行動鍵盤會自動大寫第一個字母）", () => {
    expect(parseSlash("/EXPLAIN")?.cmd.name).toBe("/explain");
    expect(parseSlash("/Sql 訂單")?.cmd.name).toBe("/sql");
  });
});

// ---- /sql ----

describe("/sql", () => {
  it("沒給參數 → info，不送出", async () => {
    const a = await expandSlash(cmd("/sql"), "", env());
    expect(a.kind).toBe("info");
    if (a.kind === "info") expect(a.message).toContain("描述");
  });

  it("有參數 → generate 模式且 ignoreSession（否則會蓋掉聊天的 session）", async () => {
    const a = await send("/sql", "上個月金額最高的十筆訂單", env());
    expect(a.mode).toBe("generate");
    expect(a.ignoreSession).toBe(true);
    expect(a.prompt).toContain("上個月金額最高的十筆訂單");
    expect(a.prompt).toContain("MySQL");
    // 真的去抓了結構（NL→SQL 靠真實表名才生得出能跑的語句）。
    expect(a.prompt).toContain("orders");
    expect(a.display).toContain("/sql");
    expect(a.display).toContain("上個月金額最高的十筆訂單");
  });

  it("elastic 走 ES 版 prompt（Query DSL，不是 SQL）", async () => {
    const a = await send("/sql", "昨天的錯誤日誌", env({ kind: "elastic", selectedTable: "logs-2024" }));
    expect(a.prompt).toContain("Elasticsearch Query DSL");
    expect(a.prompt).toContain("目標索引：logs-2024");
    expect(a.prompt).not.toContain("```sql");
    expect(a.mode).toBe("generate");
    expect(a.ignoreSession).toBe(true);
    expect(mocks.esMapping).toHaveBeenCalledWith("c1", "logs-2024");
  });

  it("沒有 SQL 方言的類型 → info 並點名該類型", async () => {
    const a = await expandSlash(cmd("/sql"), "最近的訂單", env({ kind: "mongo" }));
    expect(a.kind).toBe("info");
    if (a.kind === "info") expect(a.message).toContain("MongoDB");
    expect(mocks.listTables).not.toHaveBeenCalled();
  });

  it("external（gateway 驅動）算 SQL 方言——分類掛在 other，漏掉它等於打包版永遠用不了", async () => {
    expect(await kindOf("/sql", "最近的訂單", env({ kind: "external" }))).toBe("send");
  });

  it("沒有連線 → info（生出來的表名必然是編的）", async () => {
    expect(await kindOf("/sql", "最近的訂單", env({ connId: null }))).toBe("info");
    expect(await kindOf("/sql", "最近的訂單", env({ kind: null }))).toBe("info");
  });
});

// ---- /explain ----

describe("/explain", () => {
  it("參數優先於編輯器內容", async () => {
    const e = env({ editor: snapshot({ sql: "SELECT * FROM users", selection: "SELECT 2" }) });
    const a = await send("/explain", "SELECT 1 FROM dual", e);
    expect(a.prompt).toContain("SELECT 1 FROM dual");
    expect(a.prompt).not.toContain("SELECT * FROM users");
    expect(a.prompt).not.toContain("SELECT 2");
  });

  it("沒給參數時退到選取的片段", async () => {
    const e = env({
      editor: snapshot({ sql: "SELECT * FROM users;\nSELECT * FROM orders", selection: "  SELECT * FROM orders  " }),
    });
    const a = await send("/explain", "", e);
    expect(a.prompt).toContain("```sql\nSELECT * FROM orders\n```");
    expect(a.prompt).not.toContain("FROM users");
  });

  it("沒有選取時退到整份編輯器內容", async () => {
    const a = await send("/explain", "", env({ editor: snapshot({ sql: "SELECT * FROM orders", selection: "" }) }));
    expect(a.prompt).toContain("```sql\nSELECT * FROM orders\n```");
  });

  it("三層都拿不到 SQL → info", async () => {
    expect(await kindOf("/explain", "", env())).toBe("info");
    expect(await kindOf("/explain", "", env({ editor: snapshot({ sql: "   ", selection: null }) }))).toBe("info");
  });

  // 快照會活過連線切換：拿 B 連線的方言去解讀 A 連線的語句，錯得完全看不出來。
  it("快照屬於另一條連線時視為沒有內容", async () => {
    const e = env({ connId: "c2", editor: snapshot({ connId: "c1" }) });
    expect(await kindOf("/explain", "", e)).toBe("info");
  });

  it("帶上結構與索引（collectSchemaContext），並以 KIND_META 的方言標籤開頭", async () => {
    const a = await send("/explain", "SELECT * FROM orders", env({ kind: "postgres" }));
    expect(a.prompt).toContain("PostgreSQL");
    expect(a.prompt).toContain("- orders: id int PK NOT NULL");
    expect(a.prompt).toContain("- orders: PRIMARY(id) PK");
  });

  it("結構抓不到也照送（模型至少看得到 SQL）", async () => {
    mocks.listTables.mockRejectedValue(new Error("connection lost"));
    const a = await send("/explain", "SELECT * FROM orders", env());
    expect(a.prompt).toContain("請勿假設任何索引存在");
  });

  it("沒有連線 → schema 留白，仍然送得出去", async () => {
    const a = await send("/explain", "SELECT 1", env({ connId: null }));
    expect(a.prompt).toContain("請勿假設任何索引存在");
    expect(mocks.listTables).not.toHaveBeenCalled();
  });

  it("不知道方言 → info", async () => {
    expect(await kindOf("/explain", "SELECT 1", env({ kind: null }))).toBe("info");
  });

  it("display 只有命令與第一行，不是整包 prompt", async () => {
    const sql = "-- 月報\n\nSELECT * FROM orders WHERE created_at >= '2024-01-01'";
    const a = await send("/explain", sql, env());
    expect(a.display).toBe("/explain -- 月報");
    expect(a.display.length).toBeLessThan(100);
    expect(a.prompt.length).toBeGreaterThan(500);
  });

  it("display 過長時截斷", async () => {
    const a = await send("/explain", `SELECT ${"col_a, ".repeat(40)}1 FROM orders`, env());
    expect(a.display.endsWith("…")).toBe(true);
    expect(a.display.length).toBeLessThan(100);
  });
});

// ---- /optimize ----

describe("/optimize", () => {
  it("帶上真的跑過規則引擎的發現，而不是空清單", async () => {
    const a = await send("/optimize", "DELETE FROM orders", env());
    expect(a.prompt).toContain("no-where-dml");
    expect(a.prompt).toContain("沒有 WHERE");
    // 空陣列會印出「已檢查、沒有發現問題」——那是謊話，模型會因此把注意力移開。
    expect(a.prompt).not.toContain("沒有發現問題");
  });

  it("真的沒問題時才會出現「已檢查、沒有發現」", async () => {
    const a = await send("/optimize", "SELECT id FROM orders WHERE id = 1 LIMIT 1", env());
    expect(a.prompt).toContain("沒有發現問題");
  });

  it("SQL 包在 fenced block 裡，且要求只輸出一個 sql 區塊", async () => {
    const a = await send("/optimize", "DELETE FROM orders", env());
    expect(a.prompt).toContain("```sql\nDELETE FROM orders\n```");
    expect(a.prompt).toContain("只輸出一個 ```sql 程式碼區塊");
  });

  it("沒有執行計畫時明說未取得並禁止杜撰（快照裡沒有計畫）", async () => {
    const a = await send("/optimize", "SELECT * FROM orders", env());
    expect(a.prompt).toContain("未取得執行計畫");
    expect(a.prompt).toContain("不要杜撰");
  });

  it("沿用與 /explain 相同的取值順序（選取 > 整份）與空值處理", async () => {
    const e = env({ editor: snapshot({ sql: "SELECT * FROM users", selection: "DELETE FROM orders" }) });
    expect((await send("/optimize", "", e)).prompt).toContain("```sql\nDELETE FROM orders\n```");
    expect(await kindOf("/optimize", "", env())).toBe("info");
  });

  it("規則引擎依方言判斷（nolock 是 SQL Server 才有的問題）", async () => {
    const sql = "SELECT id FROM orders WITH (NOLOCK) WHERE id = 1";
    expect((await send("/optimize", sql, env({ kind: "mssql" }))).prompt).toContain("nolock");
  });
});

// ---- /fix ----

describe("/fix", () => {
  // 打錯欄位名而非表名：這樣結構段落才真的挑得到 orders（rankTables 是拿 SQL 去比對表名的），
  // 也才是「修正」最常見的樣子——表名打錯時模型除了說「沒這張表」以外幫不上忙。
  const failed = snapshot({
    sql: "SELECT nmae FROM orders",
    error: { message: "Unknown column 'nmae' in 'field list'", sql: "SELECT nmae FROM orders" },
  });

  it("沒有錯誤 → info（明說要先執行過）", async () => {
    expect(await kindOf("/fix", "", env())).toBe("info");
    const a = await expandSlash(cmd("/fix"), "", env({ editor: snapshot({ error: null }) }));
    expect(a.kind).toBe("info");
    if (a.kind === "info") expect(a.message).toContain("執行");
  });

  it("快照屬於另一條連線時也當成沒有錯誤", async () => {
    expect(await kindOf("/fix", "", env({ connId: "c2", editor: failed }))).toBe("info");
  });

  it("帶上錯誤訊息、失敗的語句與結構", async () => {
    const a = await send("/fix", "", env({ editor: failed }));
    expect(a.prompt).toContain("Unknown column 'nmae' in 'field list'");
    expect(a.prompt).toContain("```sql\nSELECT nmae FROM orders\n```");
    expect(a.prompt).toContain("【失敗的 SQL】");
    expect(a.prompt).toContain("- orders: id int PK NOT NULL");
  });

  // 套用修正是整段取代：只回失敗的那一條等於把其餘原本正確的語句刪掉。
  it("多語句批次：失敗語句與完整批次兩段都給", async () => {
    const ed = snapshot({
      sql: "SELECT 1;\nSELECT * FROM nope;",
      error: { message: "Table 'sakila.nope' doesn't exist", sql: "SELECT * FROM nope" },
    });
    const a = await send("/fix", "", env({ editor: ed }));
    expect(a.prompt).toContain("【失敗語句】");
    expect(a.prompt).toContain("【完整批次】");
    expect(a.prompt).toContain("SELECT 1;");
    expect(a.prompt).toContain("整批取代");
  });

  it("編輯器被清空時退回錯誤自帶的語句（不送出空 SQL）", async () => {
    const ed = snapshot({
      sql: "   ",
      error: { message: "syntax error", sql: "SELCT 1" },
    });
    const a = await send("/fix", "", env({ editor: ed }));
    expect(a.prompt).toContain("SELCT 1");
    expect(a.prompt).not.toContain("【失敗語句】"); // 兩者相同 → 單語句路徑
  });

  it("附一則 error 提及當收據，且 from/to 為 0（不是從文字解析來的）", async () => {
    const a = await send("/fix", "", env({ editor: failed }));
    expect(a.mentions).toEqual([{ kind: "error", raw: "@error", from: 0, to: 0 }]);
  });

  it("display 顯示錯誤訊息而非 SQL（回頭捲動時靠它認出這一輪）", async () => {
    const a = await send("/fix", "", env({ editor: failed }));
    expect(a.display).toBe("/fix Unknown column 'nmae' in 'field list'");
  });

  it("不知道方言 → info", async () => {
    expect(await kindOf("/fix", "", env({ kind: null, editor: failed }))).toBe("info");
  });
});

// ---- /schema ----

describe("/schema", () => {
  it("db.table 會把資料庫拆出來", async () => {
    const a = await send("/schema", "sakila.orders", env());
    expect(a.mentions).toEqual([
      { kind: "table", raw: "@sakila.orders", from: 0, to: 0, db: "sakila", table: "orders" },
    ]);
  });

  it("裸表名的 db 為 null（沿用目前資料庫）", async () => {
    const a = await send("/schema", "orders", env());
    expect(a.mentions?.[0]).toMatchObject({ kind: "table", db: null, table: "orders" });
  });

  it("只切第一個點（與 chatMentions 的 `庫.表` 同一條規則）", async () => {
    expect((await send("/schema", "sakila.dbo.orders", env())).mentions?.[0]).toMatchObject({
      db: "sakila",
      table: "dbo.orders",
    });
  });

  it("prompt 問到用途 / 逐欄意義 / 鍵與索引 / 可疑之處，且不自行編造結構", async () => {
    const a = await send("/schema", "orders", env());
    expect(a.prompt).toContain("orders");
    expect(a.prompt).toContain("用途");
    expect(a.prompt).toContain("逐欄說明");
    expect(a.prompt).toContain("鍵與索引設計");
    expect(a.prompt).toContain("可疑之處");
    expect(a.prompt).toContain("不要自行假設");
  });

  it("prompt 刻意短：結構由提及展開時接上，這裡不重複抓一次", async () => {
    const a = await send("/schema", "orders", env());
    expect(a.prompt.length).toBeLessThan(1000);
    expect(mocks.tableColumns).not.toHaveBeenCalled();
    expect(a.display).toBe("/schema orders");
  });

  it("沒給表名 → info", async () => {
    expect(await kindOf("/schema", "", env())).toBe("info");
  });

  it("沒有連線 → info（讀不到欄位與索引）", async () => {
    expect(await kindOf("/schema", "orders", env({ connId: null }))).toBe("info");
  });

  // 表名可以含空白，而多打的字會讓查表失敗並由 expandMentions 明說「沒這張表」，
  // 比默默拿第一個詞去答安全。
  it("含空白的參數原樣當成表名", async () => {
    expect((await send("/schema", "order items", env())).mentions?.[0]).toMatchObject({ table: "order items" });
  });
});

// ---- 本地命令 ----

describe("本地命令", () => {
  it("/clear、/export、/new 都不送出任何東西", async () => {
    expect(await expandSlash(cmd("/clear"), "", env())).toEqual({ kind: "local", action: "clear" });
    expect(await expandSlash(cmd("/export"), "", env())).toEqual({ kind: "local", action: "export" });
    expect(await expandSlash(cmd("/new"), "", env())).toEqual({ kind: "local", action: "new" });
  });

  it("即使沒有連線、沒有編輯器也照樣是本地動作", async () => {
    const bare = env({ connId: null, kind: null, editor: null });
    expect((await expandSlash(cmd("/clear"), "", bare)).kind).toBe("local");
    expect(mocks.listTables).not.toHaveBeenCalled();
  });

  it("多餘的參數不影響（使用者手殘多打字不該讓命令失效）", async () => {
    expect(await expandSlash(cmd("/new"), "話題", env())).toEqual({ kind: "local", action: "new" });
  });
});

// ---- 語系 ----

describe("語系", () => {
  it("uiLang 非繁中時要求以該語言回覆（一路傳到各 builder）", async () => {
    const e = env({ uiLang: "en" });
    expect((await send("/explain", "SELECT 1", e)).prompt).toContain("Reply in English.");
    expect((await send("/optimize", "SELECT 1", e)).prompt).toContain("Reply in English.");
    expect((await send("/sql", "recent orders", e)).prompt).toContain("Write any SQL comments in English.");
  });
});

// ---- 不認得的命令 ----

describe("expandSlash 的保底", () => {
  it("呼叫端自己捏的命令名回 info 而非空 prompt", async () => {
    const fake: SlashCommand = { name: "/whatever", args: "none", hint: "x" };
    const a = await expandSlash(fake, "", env());
    expect(a.kind).toBe("info");
    if (a.kind === "info") expect(a.message).toContain("/whatever");
  });
});

// ---- SSH 終端機：/shell、/term、/tfix ----

describe("SSH 終端機命令", () => {
  const term = (over?: Partial<import("./chatTypes").TerminalSnapshot>): import("./chatTypes").TerminalSnapshot => ({
    tabKey: "__ssh__:1",
    termId: "t1",
    title: "web-01",
    host: "10.20.0.15",
    user: "deploy",
    connId: null,
    status: "connected",
    os: "Ubuntu 22.04",
    shell: "bash",
    cwd: "/var/www",
    lastCommand: "systemctl status nginx",
    lastOutput: "● nginx.service - failed",
    tail: "deploy@web-01:~$ systemctl status nginx\n● nginx.service - failed",
    updatedAt: 1,
    ...over,
  });
  const withTerm = (over?: Partial<import("./chatTypes").TerminalSnapshot>) =>
    env({ connId: null, kind: null, db: "", terminal: term(over), terminalOpen: true });

  it("新命令不搶走既有的唯一前綴（/c → /clear、/f → /fix、/o → /optimize）", () => {
    expect(parseSlash("/c")?.cmd.name).toBe("/clear");
    expect(parseSlash("/f")?.cmd.name).toBe("/fix");
    expect(parseSlash("/o")?.cmd.name).toBe("/optimize");
    expect(parseSlash("/sh 找大檔")?.cmd.name).toBe("/shell");
    expect(parseSlash("/te")?.cmd.name).toBe("/term");
    expect(parseSlash("/tf")?.cmd.name).toBe("/tfix");
    expect(parseSlash("/t")).toBeNull(); // term / tfix
  });

  it("沒有開著的終端機 → info，不送出", async () => {
    for (const name of ["/shell", "/term", "/tfix"]) {
      const a = await expandSlash(cmd(name), "找出大檔", env());
      expect(a.kind).toBe("info");
      if (a.kind === "info") expect(a.message).toContain("SSH 主機");
    }
    // 快照還在但分頁已關：一樣視為沒有。
    const closed = await expandSlash(cmd("/term"), "", env({ terminal: term(), terminalOpen: false }));
    expect(closed.kind).toBe("info");
  });

  it("/shell：generate + ignoreSession，prompt 帶主機與需求，不需要資料庫連線", async () => {
    const a = await send("/shell", "找出佔最多空間的十個目錄", withTerm());
    expect(a.mode).toBe("generate");
    expect(a.ignoreSession).toBe(true);
    expect(a.prompt).toContain("找出佔最多空間的十個目錄");
    expect(a.prompt).toContain("deploy@10.20.0.15");
    expect(a.prompt).toContain("Ubuntu 22.04");
    expect(a.display).toContain("/shell");
  });

  it("/shell 沒給需求 → info", async () => {
    expect(await kindOf("/shell", "  ", withTerm())).toBe("info");
  });

  it("/term：輸出走 extraContext（圍籬 + 不可信前言），氣泡只顯示短句", async () => {
    const a = await send("/term", "", withTerm());
    expect(a.extraContext).toContain("nginx.service - failed");
    expect(a.extraContext).toContain("不可信的原始輸出資料");
    expect(a.display.length).toBeLessThan(40);
    expect(a.extraChips?.length).toBeGreaterThan(0);
  });

  it("/term、/tfix：沒透過指令列送過指令 → info（直接在終端機打的不會被擷取）", async () => {
    expect(await kindOf("/term", "", withTerm({ lastCommand: null, lastOutput: null }))).toBe("info");
    expect(await kindOf("/tfix", "", withTerm({ lastCommand: null, lastOutput: null }))).toBe("info");
  });

  it("/tfix：帶上失敗的指令與輸出", async () => {
    const a = await send("/tfix", "", withTerm());
    expect(a.extraContext).toContain("systemctl status nginx");
    expect(a.extraContext).toContain("nginx.service - failed");
  });
});
