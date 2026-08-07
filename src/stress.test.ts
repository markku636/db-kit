import { describe, it, expect } from "vitest";
import {
  expandParamPool,
  parseParamCsv,
  validatePlan,
  reportToMarkdown,
  fmtMs,
  fmtRps,
  seriesToPoints,
} from "./stress";
import type { StressPlan, StressReport } from "./api";

describe("expandParamPool", () => {
  it("每列參數各展開成一條完整語句", () => {
    const sql = "SELECT * FROM users WHERE id = :id AND name = :name";
    const pool = expandParamPool("mysql", sql, [
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
    expect(pool).toEqual([
      "SELECT * FROM users WHERE id = 1 AND name = 'alice'",
      "SELECT * FROM users WHERE id = 2 AND name = 'bob'",
    ]);
  });

  it("無具名參數 → 原語句單元素池", () => {
    const sql = "SELECT 1";
    expect(expandParamPool("mysql", sql, [{ id: "1" }])).toEqual([sql]);
  });

  it("rows 為空 → 原語句單元素池", () => {
    const sql = "SELECT * FROM t WHERE id = :id";
    expect(expandParamPool("mysql", sql, [])).toEqual([sql]);
  });

  it("缺該參數的列以空字串代入（不留 :name）", () => {
    const pool = expandParamPool("mysql", "SELECT * FROM t WHERE a = :a AND b = :b", [{ a: "1" }]);
    expect(pool).toEqual(["SELECT * FROM t WHERE a = 1 AND b = ''"]);
  });

  it("欄名可帶前導冒號", () => {
    const pool = expandParamPool("mysql", "SELECT * FROM t WHERE id = :id", [{ ":id": "7" }]);
    expect(pool).toEqual(["SELECT * FROM t WHERE id = 7"]);
  });

  // 注入安全性：值一律走 sql.ts 的方言跳脫，這裡釘住結果避免日後有人改寫成字串串接。
  it("值含單引號時仍正確跳脫（不衝出字串字面值）", () => {
    const pool = expandParamPool("mysql", "SELECT * FROM t WHERE name = :name", [
      { name: "O'Brien" },
      { name: "x' OR '1'='1" },
    ]);
    expect(pool[0]).toBe("SELECT * FROM t WHERE name = 'O''Brien'");
    expect(pool[1]).toBe("SELECT * FROM t WHERE name = 'x'' OR ''1''=''1'");
  });

  it("MySQL 反斜線加倍、PostgreSQL 不加倍（方言感知）", () => {
    const sql = "SELECT * FROM t WHERE p = :p";
    expect(expandParamPool("mysql", sql, [{ p: "a\\" }])).toEqual(["SELECT * FROM t WHERE p = 'a\\\\'"]);
    expect(expandParamPool("postgres", sql, [{ p: "a\\" }])).toEqual(["SELECT * FROM t WHERE p = 'a\\'"]);
  });

  it("SQL Server 走 N'…' 字面值", () => {
    expect(expandParamPool("mssql", "SELECT * FROM t WHERE n = :n", [{ n: "王" }])).toEqual([
      "SELECT * FROM t WHERE n = N'王'",
    ]);
  });

  // 參數名撞到 Object.prototype 成員時，用物件字面值承接會讀到繼承的函式而在 sqlLiteral 炸掉。
  it("參數名為 constructor / toString / __proto__ 也不炸（缺值時照樣代空字串）", () => {
    expect(expandParamPool("mysql", "SELECT :toString", [{ id: "1" }])).toEqual(["SELECT ''"]);
    expect(expandParamPool("mysql", "SELECT :constructor", [{ id: "1" }])).toEqual(["SELECT ''"]);
    expect(expandParamPool("mysql", "SELECT :__proto__", [{ id: "1" }])).toEqual(["SELECT ''"]);
    // 有給值時走一般路徑（值仍是字串字面值）。
    expect(expandParamPool("mysql", "SELECT :valueOf", [{ valueOf: "7" }])).toEqual(["SELECT 7"]);
  });

  it("字串 / 註解內的 :name 與 PG 的 ::type 不被當參數", () => {
    const sql = "SELECT ':id' AS lit, x::text FROM t WHERE id = :id";
    const pool = expandParamPool("postgres", sql, [{ id: "5" }]);
    expect(pool).toEqual(["SELECT ':id' AS lit, x::text FROM t WHERE id = 5"]);
  });
});

describe("parseParamCsv", () => {
  it("第一列為欄名，其餘為值", () => {
    const r = parseParamCsv("id,name\n1,alice\n2,bob");
    expect(r.headers).toEqual(["id", "name"]);
    expect(r.rows).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
  });

  it("欄名可帶前導冒號（直接從 SQL 複製）", () => {
    expect(parseParamCsv(":id,:name\n1,a").headers).toEqual(["id", "name"]);
  });

  it("引號內的逗號不切欄位", () => {
    const r = parseParamCsv('id,note\n1,"a,b,c"');
    expect(r.rows).toEqual([{ id: "1", note: "a,b,c" }]);
  });

  it("引號內的換行不切列", () => {
    const r = parseParamCsv('id,note\n1,"line1\nline2"\n2,plain');
    expect(r.rows).toEqual([
      { id: "1", note: "line1\nline2" },
      { id: "2", note: "plain" },
    ]);
  });

  it("引號內的 \"\" 還原成單一雙引號", () => {
    const r = parseParamCsv('id,note\n1,"say ""hi"""');
    expect(r.rows).toEqual([{ id: "1", note: 'say "hi"' }]);
  });

  it("空白行略過（含尾端多餘換行）", () => {
    const r = parseParamCsv("id\n1\n\n2\n\n\n");
    expect(r.rows).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("CRLF 與 BOM 不污染欄名 / 值", () => {
    const r = parseParamCsv("﻿id,name\r\n1,alice\r\n");
    expect(r.headers).toEqual(["id", "name"]);
    expect(r.rows).toEqual([{ id: "1", name: "alice" }]);
  });

  it("列的欄位數不足時補空字串", () => {
    const r = parseParamCsv("a,b,c\n1,2");
    expect(r.rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  // `""` 是明確寫出的空字串值，與「空白行」不同；單欄 CSV 曾因同一條規則被一起丟掉。
  it("單欄 CSV 的 \"\" 是空字串值，不當成空白行丟掉", () => {
    expect(parseParamCsv('note\n""\nx').rows).toEqual([{ note: "" }, { note: "x" }]);
    expect(parseParamCsv('note\n""').rows).toEqual([{ note: "" }]);
    // 未加引號的空白行仍然略過（尾端多餘換行的老行為不變）。
    expect(parseParamCsv("note\n  \nx").rows).toEqual([{ note: "x" }]);
  });

  it("欄名為 __proto__ 時值不會蒸發（不是在設原型）", () => {
    const { rows } = parseParamCsv("__proto__\n1");
    // 用計算屬性鍵寫期望值：字面值的 `{ __proto__: … }` 是設原型，會寫出一個空物件。
    expect(rows).toEqual([{ ["__proto__"]: "1" }]);
    expect(expandParamPool("mysql", "SELECT :__proto__", rows)).toEqual(["SELECT 1"]);
  });

  it("空字串 → 無欄名無列", () => {
    expect(parseParamCsv("")).toEqual({ headers: [], rows: [] });
    expect(parseParamCsv("   \n\n")).toEqual({ headers: [], rows: [] });
  });

  it("只有標題列 → 有欄名、無列", () => {
    const r = parseParamCsv("id,name\n");
    expect(r.headers).toEqual(["id", "name"]);
    expect(r.rows).toEqual([]);
  });

  // 解析 → 展開的完整路徑：CSV 內含單引號的值最終仍是安全的字面值。
  it("與 expandParamPool 串接：CSV 內的單引號值不破壞語句", () => {
    const { rows } = parseParamCsv('name\n"O\'Brien"\n');
    expect(expandParamPool("mysql", "SELECT * FROM t WHERE n = :name", rows)).toEqual([
      "SELECT * FROM t WHERE n = 'O''Brien'",
    ]);
  });
});

// 合法基準計畫；各測試只改一個欄位以隔離該條規則。
const basePlan: StressPlan = {
  statements: ["SELECT 1"],
  threads: 8,
  mode: { kind: "iterations", per_thread: 100 },
  warmup_iterations: 10,
  delay_ms: 0,
  row_cap: 100,
  query_timeout_ms: 5000,
  allow_writes: false,
};

describe("validatePlan", () => {
  it("合法計畫回 null（iterations / duration 皆然）", () => {
    expect(validatePlan(basePlan)).toBeNull();
    expect(validatePlan({ ...basePlan, mode: { kind: "duration", secs: 30, ramp_secs: 5 } })).toBeNull();
    // 邊界：threads 1 / 64、ramp = secs、warmup = 10000、delay = 60000 皆合法。
    expect(validatePlan({ ...basePlan, threads: 1 })).toBeNull();
    expect(validatePlan({ ...basePlan, threads: 64 })).toBeNull();
    expect(validatePlan({ ...basePlan, mode: { kind: "duration", secs: 10, ramp_secs: 10 } })).toBeNull();
    expect(validatePlan({ ...basePlan, warmup_iterations: 10000, delay_ms: 60000 })).toBeNull();
    expect(validatePlan({ ...basePlan, row_cap: 0, query_timeout_ms: 0 })).toBeNull();
  });

  it("statements 全空 → 擋", () => {
    expect(validatePlan({ ...basePlan, statements: [] })).toBe("請至少提供一條要壓測的語句");
    expect(validatePlan({ ...basePlan, statements: ["  ", "\n"] })).toBe("請至少提供一條要壓測的語句");
  });

  it("threads 超出 1..64 → 擋", () => {
    expect(validatePlan({ ...basePlan, threads: 0 })).toBe("執行緒數需為 1 到 64 之間的整數");
    expect(validatePlan({ ...basePlan, threads: 65 })).toBe("執行緒數需為 1 到 64 之間的整數");
  });

  it("iterations 模式 per_thread < 1 → 擋", () => {
    expect(validatePlan({ ...basePlan, mode: { kind: "iterations", per_thread: 0 } })).toBe(
      "每執行緒次數需至少 1 次",
    );
  });

  it("duration 模式 secs < 1 → 擋", () => {
    expect(validatePlan({ ...basePlan, mode: { kind: "duration", secs: 0, ramp_secs: 0 } })).toBe(
      "持續時間需至少 1 秒",
    );
  });

  it("duration 模式 ramp_secs > secs → 擋", () => {
    expect(validatePlan({ ...basePlan, mode: { kind: "duration", secs: 10, ramp_secs: 11 } })).toBe(
      "爬升時間不可超過持續時間",
    );
  });

  it("warmup_iterations > 10000 → 擋", () => {
    expect(validatePlan({ ...basePlan, warmup_iterations: 10001 })).toBe("暖機次數需為 0 到 10000 之間的整數");
  });

  it("delay_ms > 60000 → 擋", () => {
    expect(validatePlan({ ...basePlan, delay_ms: 60001 })).toBe(
      "每次查詢間隔需為 0 到 60000 毫秒之間的整數",
    );
  });

  it("row_cap 為負 → 擋", () => {
    expect(validatePlan({ ...basePlan, row_cap: -1 })).toBe("列數上限需為非負整數（0 表示不截斷）");
  });

  it("query_timeout_ms 為負 → 擋", () => {
    expect(validatePlan({ ...basePlan, query_timeout_ms: -1 })).toBe("查詢逾時需為非負整數（0 表示不逾時）");
  });

  it("NaN / 小數（input 常見）也被擋下", () => {
    expect(validatePlan({ ...basePlan, threads: Number.NaN })).toBe("執行緒數需為 1 到 64 之間的整數");
    expect(validatePlan({ ...basePlan, delay_ms: 1.5 })).toBe("每次查詢間隔需為 0 到 60000 毫秒之間的整數");
  });

  // type=number 收得下 1e30 / 20 位數字；放行的話 JSON 會寫成 `1e+30` 或超過 u64::MAX，
  // 後端 serde 只會回一句反序列化錯誤，使用者無從得知是哪個欄位打太大。
  it("超過 MAX_SAFE_INTEGER 的值在送出前就擋下（否則後端 serde 反序列化失敗）", () => {
    expect(validatePlan({ ...basePlan, mode: { kind: "iterations", per_thread: 1e30 } })).not.toBeNull();
    expect(validatePlan({ ...basePlan, mode: { kind: "duration", secs: 1e30, ramp_secs: 0 } })).not.toBeNull();
    expect(validatePlan({ ...basePlan, row_cap: 1e21 })).toBe("列數上限需為非負整數（0 表示不截斷）");
    expect(validatePlan({ ...basePlan, query_timeout_ms: 99999999999999999999 })).toBe(
      "查詢逾時需為非負整數（0 表示不逾時）",
    );
    // 邊界：MAX_SAFE_INTEGER 本身仍合法（u64 收得下）。
    expect(validatePlan({ ...basePlan, row_cap: Number.MAX_SAFE_INTEGER })).toBeNull();
  });
});

describe("fmtMs", () => {
  it("次毫秒用三位小數", () => {
    expect(fmtMs(0)).toBe("0.000 ms");
    expect(fmtMs(0.4567)).toBe("0.457 ms");
  });
  it("1 到 1000 毫秒用一位小數", () => {
    expect(fmtMs(1)).toBe("1.0 ms");
    expect(fmtMs(12.34)).toBe("12.3 ms");
    expect(fmtMs(999.9)).toBe("999.9 ms");
  });
  it("破秒轉成秒", () => {
    expect(fmtMs(1000)).toBe("1.00 s");
    expect(fmtMs(90500)).toBe("90.50 s");
  });
  it("非有限值回 -", () => {
    expect(fmtMs(Number.NaN)).toBe("-");
    expect(fmtMs(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("fmtRps", () => {
  it("千分位（不依賴 locale）", () => {
    expect(fmtRps(1234567)).toBe("1,234,567");
    expect(fmtRps(1000)).toBe("1,000");
    expect(fmtRps(999)).toBe("999");
  });
  it("小數值保留一位", () => {
    expect(fmtRps(0)).toBe("0.0");
    expect(fmtRps(12.34)).toBe("12.3");
    expect(fmtRps(99.99)).toBe("100.0");
  });
  it("非有限值回 -", () => {
    expect(fmtRps(Number.NaN)).toBe("-");
  });
});

describe("seriesToPoints", () => {
  const series = [
    { t_ms: 0, rps: 10, p95_ms: 1.5, errors: 0 },
    { t_ms: 1000, rps: 20, p95_ms: 2.5, errors: 3 },
  ];
  it("相對 t_ms 加上 baseTs 成絕對時間戳", () => {
    expect(seriesToPoints(series, "rps", 1_700_000_000_000)).toEqual([
      { t: 1_700_000_000_000, v: 10 },
      { t: 1_700_000_001_000, v: 20 },
    ]);
  });
  it("可取 p95_ms 欄位", () => {
    expect(seriesToPoints(series, "p95_ms", 0)).toEqual([
      { t: 0, v: 1.5 },
      { t: 1000, v: 2.5 },
    ]);
  });
  it("空序列 → 空陣列；非有限值壓成 0（避免 SVG path 整條消失）", () => {
    expect(seriesToPoints([], "rps", 0)).toEqual([]);
    expect(seriesToPoints([{ t_ms: 5, rps: Number.NaN, p95_ms: 0, errors: 0 }], "rps", 0)).toEqual([
      { t: 5, v: 0 },
    ]);
  });
});

const baseReport: StressReport = {
  elapsed_ms: 30000,
  completed: 12000,
  errors: 0,
  rows_total: 24000,
  rps: 400,
  avg_ms: 19.8,
  min_ms: 1.2,
  max_ms: 210.5,
  stddev_ms: 8.4,
  p50_ms: 18,
  p90_ms: 30,
  p95_ms: 42,
  p99_ms: 120,
  error_groups: [],
  series: [],
  threads: 8,
  mode: "duration",
  warmup_iterations: 10,
  cancelled: false,
};

describe("reportToMarkdown", () => {
  it("0 錯誤：設定 / 百分位 / TPS / 無錯誤字樣 / SQL 區塊", () => {
    const md = reportToMarkdown(baseReport, "SELECT 1;");
    expect(md).toContain("# 壓力測試報告");
    expect(md).toContain("| 執行緒 | 8 |");
    expect(md).toContain("| 模式 | duration |");
    expect(md).toContain("| 暖機次數（每執行緒） | 10 |");
    expect(md).toContain("| 中途取消 | 否 |");
    expect(md).toContain("| TPS（每秒查詢數） | 400 |");
    expect(md).toContain("| 總耗時 | 30.00 s |");
    expect(md).toContain("| P95 | 42.0 ms |");
    expect(md).toContain("| P99 | 120.0 ms |");
    expect(md).toContain("| 最小 | 1.2 ms |");
    expect(md).toContain("無錯誤。");
    expect(md).toContain("```sql\nSELECT 1;\n```");
    // 表格分隔列存在（Markdown 表格才成立）。
    expect(md).toContain("| --- | --- |");
  });

  it("有錯誤：列出分組表格、多行訊息收成單行、| 跳脫", () => {
    const md = reportToMarkdown(
      {
        ...baseReport,
        errors: 5,
        error_groups: [
          { message: "deadlock found\nwhen trying to get lock", count: 3 },
          { message: "col a | col b bad", count: 2 },
        ],
      },
      "SELECT 1;",
    );
    expect(md).not.toContain("無錯誤。");
    expect(md).toContain("| 3 | deadlock found when trying to get lock |");
    expect(md).toContain("| 2 | col a \\| col b bad |");
    expect(md).toContain("| 錯誤數 | 5 |");
  });

  it("錯誤分組只列前 10 組，其餘以計數帶過", () => {
    const groups = Array.from({ length: 13 }, (_, i) => ({ message: `err${i}`, count: 13 - i }));
    const md = reportToMarkdown({ ...baseReport, errors: 91, error_groups: groups }, "SELECT 1;");
    expect(md).toContain("| 13 | err0 |");
    expect(md).toContain("| 4 | err9 |");
    expect(md).not.toContain("| 3 | err10 |");
    expect(md).toContain("（另有 3 組錯誤未列出）");
  });

  it("cancelled 反映在設定摘要", () => {
    expect(reportToMarkdown({ ...baseReport, cancelled: true }, "SELECT 1;")).toContain("| 中途取消 | 是 |");
  });

  it("語句本身含 ``` 時圍籬自動加長（不會提早收掉區塊）", () => {
    const sql = "SELECT 1; -- ``` 這行有圍籬";
    const md = reportToMarkdown(baseReport, sql);
    expect(md).toContain("````sql\n" + sql + "\n````");
  });
});
