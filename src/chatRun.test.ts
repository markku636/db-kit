import { describe, it, expect } from "vitest";
import {
  RUN_KINDS,
  classifyForRun,
  persistableRun,
  prepareStatements,
  runFeedbackDisplay,
  runFeedbackPrompt,
  toChatRunResult,
} from "./chatRun";
import type { ChatRunResult } from "./chatTypes";
import type { DbKind, QueryResult } from "./api";

// 這裡刻意**沒有** vi.mock("./api")：chatRun 一支 api 方法都不呼叫（只用了 api.ts 的型別，
// 型別在編譯期就被抹掉）。透過 ./aiReview 間接載入的 ./api 在 node 環境下載得起來——它在 module
// scope 只是 import 了 Tauri facade，沒有真的 invoke。
// 補一層假 api 反而會把「有人日後在守門路徑上加了 api 呼叫」這個訊號吃掉：那種改動應該讓測試
// 當場炸掉（守門不該依賴任何會失敗、會慢、會被離線影響的東西），而不是安靜地通過。

const mk = (over: Partial<ChatRunResult> = {}): ChatRunResult => ({
  sql: "SELECT id, name FROM users",
  columns: ["id", "name"],
  rows: [["1", "amy"], ["2", null]],
  rowsAffected: 0,
  truncated: false,
  error: null,
  ms: 12,
  ...over,
});

const rowsOf = (n: number): (string | null)[][] =>
  Array.from({ length: n }, (_, i) => [String(i + 1), `name-${i + 1}`]);

// prompt 裡的資料列（表頭與分隔列之外的 `| … |` 行）。
const dataRowCount = (md: string): number =>
  md.split("\n").filter((l) => l.startsWith("| ")).length - 2;

const safe = { readonly: false, prod: false };

describe("classifyForRun：支援的連線類型", () => {
  it("七種 SQL 方言都放行", () => {
    expect(RUN_KINDS).toEqual(["mysql", "mariadb", "postgres", "sqlite", "mssql", "oracle", "external"]);
    for (const kind of RUN_KINDS) {
      expect(classifyForRun("SELECT 1", kind, safe).ok).toBe(true);
    }
  });

  it("非 SQL 方言一律 unsupported（守門器掃不到它們的關鍵字，放行等於沒有守門）", () => {
    for (const kind of ["mongo", "redis", "kafka", "elastic", "rabbitmq"] as DbKind[]) {
      expect(classifyForRun("db.users.find({})", kind, safe)).toEqual({ ok: false, reason: "unsupported" });
    }
  });

  it("沒有連線（null / undefined）也是 unsupported，不是 empty", () => {
    expect(classifyForRun("SELECT 1", null, safe)).toEqual({ ok: false, reason: "unsupported" });
    expect(classifyForRun("SELECT 1", undefined, safe)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("unsupported 比 empty 先判：沒有連線時連「是不是空的」都不必問", () => {
    expect(classifyForRun("-- 只是註解", "mongo", safe)).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("classifyForRun：空語句", () => {
  it("只有註解 → empty", () => {
    expect(classifyForRun("-- 先看一下 users 表\n/* 待補 */", "mysql", safe)).toEqual({ ok: false, reason: "empty" });
  });

  it("空字串 / 純空白 → empty", () => {
    expect(classifyForRun("", "mysql", safe)).toEqual({ ok: false, reason: "empty" });
    expect(classifyForRun("   \n\t ", "mysql", safe)).toEqual({ ok: false, reason: "empty" });
  });

  it("只有分號 → empty（hasExecutableSql 會說有東西，但切完一條都不剩）", () => {
    expect(classifyForRun(";;;", "mysql", safe)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("classifyForRun：唯讀連線是硬擋", () => {
  it("唯讀 + UPDATE → readonly，而且沒有 confirm 可以繞過", () => {
    const r = classifyForRun("UPDATE users SET name = 'x' WHERE id = 1", "mysql", { readonly: true, prod: false });
    expect(r).toEqual({ ok: false, reason: "readonly" });
  });

  it("唯讀 + DDL → readonly", () => {
    expect(classifyForRun("DROP TABLE users", "postgres", { readonly: true, prod: false }))
      .toEqual({ ok: false, reason: "readonly" });
  });

  it("唯讀 + 純讀取 → 照常放行", () => {
    const r = classifyForRun("SELECT * FROM users", "mysql", { readonly: true, prod: false });
    expect(r).toEqual({ ok: true, statements: ["SELECT * FROM users"], confirm: [] });
  });

  it("唯讀把多語句裡「任何一條」寫入都擋下（不是只看第一條）", () => {
    expect(classifyForRun("SELECT 1; SELECT 2; DELETE FROM users WHERE id = 1", "mysql", { readonly: true, prod: false }))
      .toEqual({ ok: false, reason: "readonly" });
  });

  it("external 整批送、但守門掃切分後的版本：SELECT 開頭的整批藏著 DROP 一樣擋下", () => {
    // 只看第一個關鍵字的話這批會被當成 SELECT 放行，唯讀連線就這樣被繞過。
    expect(classifyForRun("SELECT 1; DROP TABLE users", "external", { readonly: true, prod: false }))
      .toEqual({ ok: false, reason: "readonly" });
  });

  it("readonly 比 prod / danger 先判：擋下時不該再冒出任何確認框", () => {
    expect(classifyForRun("DELETE FROM users", "mysql", { readonly: true, prod: true }))
      .toEqual({ ok: false, reason: "readonly" });
  });
});

describe("classifyForRun：確認清單", () => {
  it("一般 SELECT → 可以直接跑，confirm 為空", () => {
    expect(classifyForRun("SELECT * FROM users WHERE id = 1", "mysql", safe))
      .toEqual({ ok: true, statements: ["SELECT * FROM users WHERE id = 1"], confirm: [] });
  });

  it("無 WHERE 的 DELETE → danger 與 write 都要（順序由重到輕）", () => {
    const r = classifyForRun("DELETE FROM t", "mysql", safe);
    expect(r).toMatchObject({ ok: true, confirm: ["danger", "write"] });
  });

  it("有 WHERE 的 DELETE 只要 write（不是危險語句）", () => {
    expect(classifyForRun("DELETE FROM t WHERE id = 1", "mysql", safe)).toMatchObject({ confirm: ["write"] });
  });

  it("TRUNCATE 也算危險語句", () => {
    expect(classifyForRun("TRUNCATE TABLE t", "mysql", safe)).toMatchObject({ confirm: ["danger", "write"] });
  });

  it("正式環境連線 → prod 排在最前面（讀取型語句也要問）", () => {
    expect(classifyForRun("SELECT 1", "mysql", { readonly: false, prod: true })).toMatchObject({ confirm: ["prod"] });
    expect(classifyForRun("DELETE FROM t", "mysql", { readonly: false, prod: true }))
      .toMatchObject({ confirm: ["prod", "danger", "write"] });
  });

  it("多條同類語句不會重複列出同一種確認", () => {
    const r = classifyForRun(
      "UPDATE a SET x = 1 WHERE id = 1; UPDATE b SET y = 2 WHERE id = 2; INSERT INTO c VALUES (1)",
      "mysql",
      safe,
    );
    expect(r).toMatchObject({ confirm: ["write"] });
  });

  it("多條危險語句也只列一次 danger", () => {
    const r = classifyForRun("DELETE FROM a; TRUNCATE TABLE b; UPDATE c SET x = 1", "mysql", { readonly: false, prod: true });
    expect(r).toMatchObject({ confirm: ["prod", "danger", "write"] });
    if (r.ok) expect(new Set(r.confirm).size).toBe(r.confirm.length);
  });

  it("可寫 CTE（WITH … DELETE …）算寫入——第一個關鍵字看不出來", () => {
    expect(classifyForRun("WITH d AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM d", "postgres", safe))
      .toMatchObject({ confirm: ["write"] });
  });

  it("字串字面值裡的 delete 不會誤判成寫入", () => {
    expect(classifyForRun("SELECT * FROM logs WHERE action = 'delete from users'", "mysql", safe))
      .toMatchObject({ confirm: [] });
  });
});

describe("classifyForRun：語句切分", () => {
  it("SQL 方言逐條切（sqlx 不接受單次多語句）", () => {
    const r = classifyForRun("SELECT 1;\nSELECT 2;\n-- 尾巴註解", "mysql", safe);
    expect(r).toMatchObject({ ok: true, statements: ["SELECT 1", "SELECT 2"] });
  });

  it("字串 / dollar-quote 裡的分號不切", () => {
    const r = classifyForRun("SELECT 'a;b' AS x", "mysql", safe);
    expect(r).toMatchObject({ statements: ["SELECT 'a;b' AS x"] });
  });

  it("external 整段當一個批次送，不切開（gateway 自己拆，前端切了會破壞多結果集對位）", () => {
    const r = classifyForRun("  SELECT 1; SELECT 2; SELECT 3  ", "external", safe);
    expect(r).toMatchObject({ ok: true, statements: ["SELECT 1; SELECT 2; SELECT 3"] });
  });
});

describe("prepareStatements", () => {
  it("MySQL：每一條都補上 USE 前綴（前綴必須與語句同一次送出才有效）", () => {
    expect(prepareStatements(["SELECT 1", "SELECT 2"], "mysql", "shop")).toEqual([
      "USE `shop`;\nSELECT 1",
      "USE `shop`;\nSELECT 2",
    ]);
  });

  it("PostgreSQL 用 SET search_path", () => {
    expect(prepareStatements(["SELECT 1"], "postgres", "public")).toEqual([
      'SET search_path TO "public";\nSELECT 1',
    ]);
  });

  it("external 講 MySQL 方言，同樣用反引號的 USE", () => {
    expect(prepareStatements(["SELECT 1"], "external", "shop")).toEqual(["USE `shop`;\nSELECT 1"]);
  });

  it("資料庫名以識別字跳脫（帶反引號的庫名不會衝出識別字）", () => {
    expect(prepareStatements(["SELECT 1"], "mysql", "we`ird")).toEqual(["USE `we``ird`;\nSELECT 1"]);
  });

  it("沒有資料庫（null / 空字串 / 純空白）→ 原樣", () => {
    expect(prepareStatements(["SELECT 1"], "mysql", null)).toEqual(["SELECT 1"]);
    expect(prepareStatements(["SELECT 1"], "mysql", "")).toEqual(["SELECT 1"]);
    expect(prepareStatements(["SELECT 1"], "mysql", "   ")).toEqual(["SELECT 1"]);
  });

  it("SQLite / Oracle 沒有「切換目前資料庫」語句 → 原樣", () => {
    expect(prepareStatements(["SELECT 1"], "sqlite", "main")).toEqual(["SELECT 1"]);
    expect(prepareStatements(["SELECT 1"], "oracle", "HR")).toEqual(["SELECT 1"]);
  });

  it("SQL Server 不加（driver 沒有切出開頭 USE 的處理，前綴會變成一次送兩句）", () => {
    expect(prepareStatements(["SELECT 1"], "mssql", "shop")).toEqual(["SELECT 1"]);
  });

  it("語句自帶 USE → 那一條不加", () => {
    expect(prepareStatements(["SELECT 1", "USE other; SELECT 2"], "mysql", "shop")).toEqual([
      "USE `shop`;\nSELECT 1",
      "USE other; SELECT 2",
    ]);
  });

  it("語句自帶 SET search_path → 那一條不加", () => {
    expect(prepareStatements(["set search_path TO x; SELECT 1"], "postgres", "public")).toEqual([
      "set search_path TO x; SELECT 1",
    ]);
  });

  it("整批的第一條自帶切庫 → 整批都不加（否則第二條會被選擇器的庫默默蓋掉）", () => {
    expect(prepareStatements(["USE analytics", "SELECT * FROM events"], "mysql", "shop")).toEqual([
      "USE analytics",
      "SELECT * FROM events",
    ]);
  });

  it("空陣列不會炸", () => {
    expect(prepareStatements([], "mysql", "shop")).toEqual([]);
  });
});

describe("toChatRunResult", () => {
  const res: QueryResult = { columns: ["id"], rows: [["1"], ["2"]], rows_affected: 0, truncated: true };

  it("snake_case DTO → camelCase 訊息欄位", () => {
    expect(toChatRunResult("SELECT id FROM t", res, 42, null)).toEqual({
      sql: "SELECT id FROM t",
      columns: ["id"],
      rows: [["1"], ["2"]],
      rowsAffected: 0,
      truncated: true,
      error: null,
      ms: 42,
    });
  });

  it("res 為 null（執行失敗）時各欄位給安全預設值，不留 undefined", () => {
    const r = toChatRunResult("DROP TABLE t", null, 7, "no such table: t");
    expect(r).toEqual({
      sql: "DROP TABLE t",
      columns: [],
      rows: [],
      rowsAffected: 0,
      truncated: false,
      error: "no such table: t",
      ms: 7,
    });
  });

  it("truncated 未帶（非查詢語句）一律當 false，不讓 undefined 流進 prompt", () => {
    const upd: QueryResult = { columns: [], rows: [], rows_affected: 3 };
    expect(toChatRunResult("UPDATE t SET x = 1", upd, 5, null)).toMatchObject({ truncated: false, rowsAffected: 3 });
  });
});

describe("persistableRun", () => {
  it("超過 30 列時夾到 30（整包對話要進 localStorage，一則就能撐破配額）", () => {
    const clipped = persistableRun(mk({ rows: rowsOf(120) }));
    expect(clipped.rows).toHaveLength(30);
    expect(clipped.rows[29]).toEqual(["30", "name-30"]);
  });

  it("恰好 30 列不夾", () => {
    expect(persistableRun(mk({ rows: rowsOf(30) })).rows).toHaveLength(30);
  });

  it("沒超過上限時原物件回傳（維持參照相等，渲染端不會多重畫一次）", () => {
    const r = mk({ rows: rowsOf(3) });
    expect(persistableRun(r)).toBe(r);
  });

  it("夾列數不會順手把 truncated 設成 true（那是後端的截斷訊號，不是本地存檔的取捨）", () => {
    expect(persistableRun(mk({ rows: rowsOf(80), truncated: false })).truncated).toBe(false);
    expect(persistableRun(mk({ rows: rowsOf(80), truncated: true })).truncated).toBe(true);
  });

  it("其餘欄位原封不動", () => {
    const r = persistableRun(mk({ rows: rowsOf(50), rowsAffected: 9, ms: 321, sql: "SELECT 1" }));
    expect(r).toMatchObject({ rowsAffected: 9, ms: 321, sql: "SELECT 1", error: null });
  });
});

describe("runFeedbackPrompt：成功且有結果集", () => {
  const p = runFeedbackPrompt(mk());

  it("附上實際執行的 SQL（fenced）", () => {
    expect(p).toContain("【已執行的 SQL】");
    expect(p).toContain("```sql\nSELECT id, name FROM users\n```");
  });

  it("結果以 Markdown 表格附上，NULL 走 resultToMarkdown 的既有寫法", () => {
    expect(p).toContain("【執行結果】");
    expect(p).toContain("| id | name |");
    expect(p).toContain("| 1 | amy |");
    expect(p).toContain("| 2 |  |");
  });

  it("明說共幾列", () => {
    expect(p).toContain("（共 2 列）");
    expect(p).not.toContain("僅附前");
  });

  it("沒有截斷時不提截斷（模型會為了不存在的截斷去加 LIMIT）", () => {
    expect(p).not.toContain("後端已達列數上限");
  });

  it("要求接續分析，並允許直接給下一段可執行的 SQL", () => {
    expect(p).toContain("接續分析");
    expect(p).toContain("```sql 區塊");
  });

  it("不出現錯誤段（沒有錯誤就不該讓模型去找錯）", () => {
    expect(p).not.toContain("【錯誤訊息】");
    expect(p).not.toContain("為什麼失敗");
  });

  it("附上耗時（要它分析效能就得給數字）", () => {
    expect(runFeedbackPrompt(mk({ ms: 1500 }))).toContain("耗時：1.50 s");
    expect(runFeedbackPrompt(mk({ ms: 12 }))).toContain("耗時：12 ms");
  });
});

describe("runFeedbackPrompt：超過 30 列", () => {
  const p = runFeedbackPrompt(mk({ rows: rowsOf(42) }));

  it("只附前 30 列，且明說 N of M（否則模型會拿 30 當母體算比例）", () => {
    expect(p).toContain("（僅附前 30 列，共 42 列）");
    expect(dataRowCount(p)).toBe(30);
  });

  it("第 31 列之後真的沒有進 prompt", () => {
    expect(p).toContain("name-30");
    expect(p).not.toContain("name-31");
  });
});

describe("runFeedbackPrompt：後端截斷", () => {
  it("明說後端達到列數上限，並要模型別把這裡的列數當成總數", () => {
    const p = runFeedbackPrompt(mk({ rows: rowsOf(5), truncated: true }));
    expect(p).toContain("（共 5 列）");
    expect(p).toContain("後端已達列數上限而截斷");
    expect(p).toContain("請勿把這裡的列數當成總數");
  });

  it("後端截斷 + 超過 30 列：兩種交代都要在", () => {
    const p = runFeedbackPrompt(mk({ rows: rowsOf(100), truncated: true }));
    expect(p).toContain("（僅附前 30 列，共 100 列）");
    expect(p).toContain("後端已達列數上限而截斷");
  });
});

describe("runFeedbackPrompt：沒有結果集的語句", () => {
  it("UPDATE / DDL 用影響列數交代，不留一段空白讓模型自己猜", () => {
    const p = runFeedbackPrompt(mk({ sql: "UPDATE t SET x = 1 WHERE id = 1", columns: [], rows: [], rowsAffected: 3 }));
    expect(p).toContain("沒有結果集（非查詢語句）；影響 3 列。");
    expect(p).toContain("【執行結果】");
    expect(p).not.toContain("| ");
  });
});

describe("runFeedbackPrompt：失敗", () => {
  const p = runFeedbackPrompt(mk({ columns: [], rows: [], error: "ERROR 1146 (42S02): Table 'shop.userz' doesn't exist" }));

  it("錯誤訊息 fenced 附上，且不再輸出結果段", () => {
    expect(p).toContain("【錯誤訊息】");
    expect(p).toContain("```text\nERROR 1146 (42S02): Table 'shop.userz' doesn't exist\n```");
    expect(p).not.toContain("【執行結果】");
    expect(p).not.toContain("沒有結果集");
  });

  it("要求先講失敗原因，再給一段可直接執行的修正 SQL（這樣才接得回執行鈕）", () => {
    expect(p).toContain("為什麼失敗");
    expect(p).toContain("修正後、可直接執行的 SQL");
    expect(p).toContain("```sql 區塊");
    expect(p).toContain("不要留佔位符");
  });

  it("空字串錯誤訊息仍走失敗分支（error 是 null 才算成功）", () => {
    expect(runFeedbackPrompt(mk({ error: "" }))).toContain("【錯誤訊息】");
  });

  it("超長錯誤訊息夾上限，且截斷提示留在圍籬外", () => {
    const p2 = runFeedbackPrompt(mk({ error: "x".repeat(5000) }));
    expect(p2).toContain("…（內容過長，其餘已截斷）");
    expect(p2).not.toMatch(/…（內容過長，其餘已截斷）[\s\S]*```text/);
  });
});

describe("runFeedbackPrompt：圍籬安全", () => {
  it("SQL 自身含 ``` 時圍籬加寬，區塊不會提早收掉（後半段會變成 prompt 指令）", () => {
    const p = runFeedbackPrompt(mk({ sql: "SELECT '```' AS md" }));
    expect(p).toContain("````sql\nSELECT '```' AS md\n````");
  });
});

describe("runFeedbackDisplay", () => {
  it("成功的查詢報列數", () => {
    expect(runFeedbackDisplay(mk({ rows: rowsOf(42) }))).toBe("已執行 SQL（42 列）");
  });

  it("零列也報得出來", () => {
    expect(runFeedbackDisplay(mk({ rows: [] }))).toBe("已執行 SQL（0 列）");
  });

  it("沒有結果集的語句報影響列數", () => {
    expect(runFeedbackDisplay(mk({ columns: [], rows: [], rowsAffected: 7 }))).toBe("已執行 SQL（影響 7 列）");
  });

  it("失敗只講失敗（錯誤細節在上下文裡，不塞進氣泡）", () => {
    expect(runFeedbackDisplay(mk({ error: "boom" }))).toBe("已執行 SQL（失敗）");
    expect(runFeedbackDisplay(mk({ columns: [], rows: [], rowsAffected: 0, error: "boom" }))).toBe("已執行 SQL（失敗）");
  });

  it("氣泡文字很短：整張表格貼進氣泡會把對話捲成表格牆", () => {
    expect(runFeedbackDisplay(mk({ rows: rowsOf(500) })).length).toBeLessThan(30);
  });
});
