import { describe, it, expect } from "vitest";
import { lintSql, maskCode, LINT_RULES, type LintFinding } from "./sqlLint";
import { stripCode } from "./sql";
import type { DbKind } from "./api";

// 測試輔助：只取規則代號（訊息內容另外驗，避免每次改文案就要改一整排斷言）。
const ids = (kind: DbKind, sql: string): string[] => lintSql(kind, sql).map((f) => f.id);
const has = (kind: DbKind, sql: string, id: string): boolean => ids(kind, sql).includes(id);
const only = (kind: DbKind, sql: string, id: string): LintFinding[] =>
  lintSql(kind, sql).filter((f) => f.id === id);

describe("LINT_RULES", () => {
  it("規則代號唯一且為 kebab-case", () => {
    const list = LINT_RULES.map((r) => r.id);
    expect(new Set(list).size).toBe(list.length);
    for (const id of list) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("依 error → warn → info 排列，且都有標題", () => {
    const order = { error: 0, warn: 1, info: 2 } as const;
    const seq = LINT_RULES.map((r) => order[r.severity]);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    for (const r of LINT_RULES) expect(r.title.length).toBeGreaterThan(0);
  });
});

describe("maskCode", () => {
  it("保長度、保換行（位移才能映回原字串）", () => {
    const sql = "SELECT 'a\nb' /* c\nd */ FROM t";
    const masked = maskCode(sql);
    expect(masked.length).toBe(sql.length);
    expect(masked.split("\n").length).toBe(sql.split("\n").length);
    expect(masked).toContain("SELECT");
    expect(masked).not.toContain("FROM t".slice(0, 0) + "a"); // 字串內容已被抹掉
  });

  it("與 sql.ts 的 stripCode 剝除同一批 token（防兩支剝離器日後漂移）", () => {
    const samples = [
      "SELECT 'it''s' , \"col\" , `x` FROM t -- 註解\nWHERE a = 1",
      "/* 前置區塊 */ DELETE FROM t",
      "SELECT $$ body ; $$ FROM t",
      "UPDATE t SET a = '--not a comment' WHERE b = 2",
    ];
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    for (const s of samples) expect(norm(maskCode(s))).toBe(norm(stripCode(s)));
  });

  it("刻意的差異：只有 maskCode 會遮 mssql 的 [識別字]（等長空白）", () => {
    const s = "SELECT [Union] FROM [t]";
    expect(maskCode(s)).toBe(s.replace(/\[[^\]]*\]/g, (x) => " ".repeat(x.length)));
  });

  it("孤立的 [ 不吃掉後文（沒有同行閉合的 ] 就當普通字元）", () => {
    const sql = "SELECT a[1 FROM t\nWHERE name LIKE '%x'";
    expect(maskCode(sql)).toContain("WHERE name LIKE");
  });
});

describe("lintSql — 輸入邊界", () => {
  it("空輸入 / 純空白 / 純註解 → 無結果", () => {
    expect(lintSql("mysql", "")).toEqual([]);
    expect(lintSql("mysql", "   \n  ")).toEqual([]);
    expect(lintSql("mysql", "-- 只有註解")).toEqual([]);
  });

  it("超長輸入直接放棄（不卡住 UI）", () => {
    const huge = `${"SELECT * FROM t;".repeat(20000)}`;
    expect(huge.length).toBeGreaterThan(200_000);
    expect(lintSql("mysql", huge)).toEqual([]);
  });
});

describe("no-where-dml", () => {
  it("命中：UPDATE / DELETE 沒有頂層 WHERE", () => {
    expect(has("mysql", "UPDATE users SET active = 0", "no-where-dml")).toBe(true);
    expect(has("mysql", "DELETE FROM audit_log", "no-where-dml")).toBe(true);
  });

  it("命中：WHERE 只出現在子查詢裡（頂層仍是全表）", () => {
    const sql = "UPDATE users SET tier = (SELECT tier FROM plans WHERE plans.id = 1)";
    expect(has("mysql", sql, "no-where-dml")).toBe(true);
  });

  it("不命中：有頂層 WHERE", () => {
    expect(has("mysql", "DELETE FROM audit_log WHERE created_at < '2020-01-01'", "no-where-dml")).toBe(false);
  });

  it("不命中：MySQL 的 UPDATE … LIMIT n 是刻意分批，影響列數有上界", () => {
    expect(has("mysql", "DELETE FROM audit_log ORDER BY id LIMIT 1000", "no-where-dml")).toBe(false);
  });

  it("不命中：字串 / 註解裡的字不算 WHERE，也不算 DELETE", () => {
    // 註解裡寫了 where，但語句本身沒有 → 仍要命中（證明註解沒被當成條件）
    expect(has("mysql", "UPDATE t SET a = 1 -- where id = 1", "no-where-dml")).toBe(true);
    // 語句開頭是 SELECT，只是欄位叫 deleted_at → 不可誤判成 DELETE
    expect(has("mysql", "SELECT deleted_at FROM t", "no-where-dml")).toBe(false);
  });

  it("不命中：JOIN 的 ON 就是篩選條件（T-SQL / MySQL 的多表 UPDATE 慣用寫法）", () => {
    expect(has("mssql", "UPDATE p SET p.qty = 0 FROM products p JOIN stale s ON s.id = p.id", "no-where-dml")).toBe(false);
    expect(has("mysql", "UPDATE a JOIN b ON b.a_id = a.id SET a.synced = 1", "no-where-dml")).toBe(false);
  });

  it("命中：逗號式多表 DELETE 沒有 WHERE（沒有 ON 可篩）", () => {
    expect(has("mysql", "DELETE a FROM a, b", "no-where-dml")).toBe(true);
  });

  it("字界：欄位名 nowhere 不是 WHERE 關鍵字", () => {
    expect(has("mysql", "UPDATE t SET nowhere = 1", "no-where-dml")).toBe(true);
  });

  it("severity 為 error 且位置落在關鍵字上", () => {
    const f = only("mysql", "  DELETE FROM t", "no-where-dml")[0];
    expect(f.severity).toBe("error");
    expect(f.from).toBe(2);
    expect(f.to).toBe(8);
  });
});

describe("missing-join-condition", () => {
  it("命中：逗號多表且完全沒有 WHERE", () => {
    expect(has("mysql", "SELECT a.id FROM users a, orders b", "missing-join-condition")).toBe(true);
  });

  it("命中：有 WHERE 但只有常數條件（沒有兩表的關聯）", () => {
    const sql = "SELECT a.id FROM users a, orders b WHERE a.active = 1";
    expect(has("mysql", sql, "missing-join-condition")).toBe(true);
  });

  it("不命中：WHERE 有等值關聯條件", () => {
    const sql = "SELECT a.id FROM users a, orders b WHERE a.id = b.user_id AND a.active = 1";
    expect(has("mysql", sql, "missing-join-condition")).toBe(false);
  });

  it("不命中：明確的 JOIN … ON", () => {
    const sql = "SELECT a.id FROM users a JOIN orders b ON a.id = b.user_id";
    expect(has("mysql", sql, "missing-join-condition")).toBe(false);
  });

  it("不命中：逗號在 SELECT 清單或函式參數裡（不是多表）", () => {
    expect(has("mysql", "SELECT id, name FROM users", "missing-join-condition")).toBe(false);
    expect(has("mysql", "SELECT CONCAT(a, b) FROM users", "missing-join-condition")).toBe(false);
  });

  it("不命中：關聯條件寫在被引號括起來的識別字上（遮罩後只剩點號，仍要認得出來）", () => {
    // GUI 工具產生的 SQL 幾乎都會把識別字加引號；認不出來就會對寫得完全正確的查詢報 error 級笛卡兒積。
    expect(has("mysql", "SELECT x FROM `a`, `b` WHERE `a`.`id` = `b`.`a_id`", "missing-join-condition")).toBe(false);
    expect(has("mssql", "SELECT x FROM [a] p, [b] q WHERE p.[id] = q.[a_id]", "missing-join-condition")).toBe(false);
    expect(has("postgres", 'SELECT x FROM "a" p, "b" q WHERE p."id" = q."a_id"', "missing-join-condition")).toBe(false);
  });

  it("命中：中括號識別字但真的沒有關聯條件", () => {
    expect(has("mssql", "SELECT x FROM [a], [b]", "missing-join-condition")).toBe(true);
  });

  it("不命中：FROM 後接表函式 / LATERAL（逗號是合法語法）", () => {
    const sql = "SELECT x FROM t, LATERAL unnest(t.arr) AS x";
    expect(has("postgres", sql, "missing-join-condition")).toBe(false);
  });
});

describe("non-sargable-func", () => {
  it("命中：WHERE 對欄位套日期 / 字串函式", () => {
    expect(has("mysql", "SELECT id FROM t WHERE YEAR(created_at) = 2024", "non-sargable-func")).toBe(true);
    expect(has("mysql", "SELECT id FROM t WHERE UPPER(name) = 'X'", "non-sargable-func")).toBe(true);
    expect(has("mssql", "SELECT id FROM t WHERE CAST(created_at AS DATE) = '2024-01-01'", "non-sargable-func")).toBe(true);
  });

  it("不命中：函式在 SELECT 清單而非 WHERE（不影響索引選擇）", () => {
    expect(has("mysql", "SELECT YEAR(created_at) FROM t WHERE id = 1", "non-sargable-func")).toBe(false);
  });

  it("不命中：改寫成範圍比較的正確寫法", () => {
    const sql = "SELECT id FROM t WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01'";
    expect(has("mysql", sql, "non-sargable-func")).toBe(false);
  });

  it("不命中：函式只作用在常數上（索引無關）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE name = UPPER('abc')", "non-sargable-func")).toBe(false);
    expect(has("mysql", "SELECT id FROM t WHERE created_at > DATE('2024-01-01')", "non-sargable-func")).toBe(false);
  });

  it("字界：自訂函式 fn_year / myyear 不是白名單的 YEAR", () => {
    expect(has("mysql", "SELECT id FROM t WHERE fn_year(created_at) = 2024", "non-sargable-func")).toBe(false);
    expect(has("mysql", "SELECT id FROM t WHERE myyear(created_at) = 2024", "non-sargable-func")).toBe(false);
  });

  it("不命中：巢狀呼叫（第一個運算元不是欄位）", () => {
    expect(has("mssql", "SELECT id FROM t WHERE CAST(GETDATE() AS DATE) = d", "non-sargable-func")).toBe(false);
  });
});

describe("leading-wildcard-like", () => {
  it("命中：'%x' 與 '%x%'", () => {
    expect(has("mysql", "SELECT id FROM t WHERE name LIKE '%abc'", "leading-wildcard-like")).toBe(true);
    expect(has("mysql", "SELECT id FROM t WHERE name LIKE '%abc%'", "leading-wildcard-like")).toBe(true);
    expect(has("postgres", "SELECT id FROM t WHERE name ILIKE '%abc%'", "leading-wildcard-like")).toBe(true);
  });

  it("不命中：前綴比對 'abc%'（可走索引）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE name LIKE 'abc%'", "leading-wildcard-like")).toBe(false);
  });

  it("不命中：樣式不是字面值（拼出來的就不猜）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE name LIKE CONCAT('%', ?)", "leading-wildcard-like")).toBe(false);
  });

  it("不命中：註解裡的 LIKE '%x'", () => {
    expect(has("mysql", "SELECT id FROM t WHERE id = 1 -- name LIKE '%abc'", "leading-wildcard-like")).toBe(false);
  });

  it("命中：mssql 的 N'…' 與 postgres 的 E'…' 前綴字面值", () => {
    // mssql 的字串幾乎清一色寫成 N'…'，不吃這個前綴等於整個方言靜默漏報。
    expect(has("mssql", "SELECT id FROM t WHERE name LIKE N'%abc%'", "leading-wildcard-like")).toBe(true);
    expect(has("postgres", "SELECT id FROM t WHERE name LIKE E'%abc%'", "leading-wildcard-like")).toBe(true);
    expect(has("mssql", "SELECT id FROM t WHERE name LIKE N'abc%'", "leading-wildcard-like")).toBe(false);
  });

  it("回報範圍涵蓋 LIKE 到樣式結尾", () => {
    const sql = "SELECT id FROM t WHERE name LIKE '%abc'";
    const f = only("mysql", sql, "leading-wildcard-like")[0];
    expect(sql.slice(f.from, f.to)).toBe("LIKE '%abc'");
  });
});

describe("not-in-subquery", () => {
  it("命中：NOT IN (SELECT …)", () => {
    const sql = "SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM banned)";
    expect(has("mysql", sql, "not-in-subquery")).toBe(true);
  });

  it("不命中：NOT IN 值清單（沒有 NULL 語意陷阱）", () => {
    expect(has("mysql", "SELECT id FROM users WHERE id NOT IN (1, 2, 3)", "not-in-subquery")).toBe(false);
  });

  it("不命中：IN (SELECT …)（NULL 不會讓整個條件翻盤）", () => {
    const sql = "SELECT id FROM users WHERE id IN (SELECT user_id FROM vip)";
    expect(has("mysql", sql, "not-in-subquery")).toBe(false);
  });
});

describe("or-chain", () => {
  it("命中：同欄位 3 個 OR 等值", () => {
    const sql = "SELECT id FROM t WHERE status = 'a' OR status = 'b' OR status = 'c'";
    expect(has("mysql", sql, "or-chain")).toBe(true);
  });

  it("命中：包在括號裡的 OR 串", () => {
    const sql = "SELECT id FROM t WHERE (status = 1 OR status = 2 OR status = 3) AND active = 1";
    expect(has("mysql", sql, "or-chain")).toBe(true);
  });

  it("不命中：只有 2 個（改 IN 沒有明顯好處）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE status = 'a' OR status = 'b'", "or-chain")).toBe(false);
  });

  it("不命中：3 個 OR 但欄位各不相同", () => {
    const sql = "SELECT id FROM t WHERE a = 1 OR b = 2 OR c = 3";
    expect(has("mysql", sql, "or-chain")).toBe(false);
  });

  it("不命中：同欄位散在被 AND 隔開的不同括號群組（不是同一條 OR 鏈）", () => {
    const sql = "SELECT id FROM t WHERE (a = 1 OR x = 2) AND (a = 3 OR y = 4) AND (a = 5 OR z = 6)";
    expect(has("mysql", sql, "or-chain")).toBe(false);
  });

  it("不命中：非等值比較（IN 改寫不適用）", () => {
    const sql = "SELECT id FROM t WHERE score >= 1 OR score >= 2 OR score >= 3";
    expect(has("mysql", sql, "or-chain")).toBe(false);
  });

  it("不命中：被 OR 串起來的是複合括號群組（改成 IN 會把群組裡的其他條件弄丟）", () => {
    // LEAD_EQ 會跳過前導括號直接讀到 kind，若不排除複合條件就會建議 kind IN ('x','y','z')，
    // 那等於把 v 的三個條件整組刪掉 —— 是實質錯誤的建議，不只是噪音。
    const andGroups = "SELECT id FROM t WHERE (kind = 'x' AND v > 1) OR (kind = 'y' AND v > 2) OR (kind = 'z' AND v > 3)";
    expect(has("mysql", andGroups, "or-chain")).toBe(false);
    const orGroups = "SELECT id FROM t WHERE (a = 1 OR b = 1) OR (a = 2 OR c = 2) OR (a = 3 OR d = 3)";
    expect(has("mysql", orGroups, "or-chain")).toBe(false);
  });

  it("命中：每一項各自加括號的 OR 鏈仍是同一條鏈", () => {
    expect(has("mysql", "SELECT id FROM t WHERE ((a = 1) OR (a = 2) OR (a = 3))", "or-chain")).toBe(true);
  });

  it("回報範圍剛好蓋住整條鏈（含結尾的字串字面值，且不含前後空白）", () => {
    const sql = "UPDATE t SET a = 1 WHERE s = 'x' OR s = 'y' OR s = 'z'";
    const f = only("mysql", sql, "or-chain")[0];
    expect(sql.slice(f.from, f.to)).toBe("s = 'x' OR s = 'y' OR s = 'z'");
  });

  it("訊息點名欄位", () => {
    const f = only("mysql", "SELECT id FROM t WHERE status = 1 OR status = 2 OR status = 3", "or-chain")[0];
    expect(f.message).toContain("status");
    expect(f.severity).toBe("warn");
  });
});

describe("union-vs-union-all", () => {
  it("命中：UNION", () => {
    expect(has("mysql", "SELECT a FROM t1 UNION SELECT a FROM t2", "union-vs-union-all")).toBe(true);
  });

  it("不命中：UNION ALL", () => {
    expect(has("mysql", "SELECT a FROM t1 UNION ALL SELECT a FROM t2", "union-vs-union-all")).toBe(false);
  });

  it("不命中：字串裡的 union", () => {
    expect(has("mysql", "SELECT 'union' AS kw FROM t WHERE id = 1", "union-vs-union-all")).toBe(false);
  });
});

describe("select-star / select-star-with-join", () => {
  it("無 JOIN → info 級 select-star", () => {
    const f = only("mysql", "SELECT * FROM users WHERE id = 1", "select-star")[0];
    expect(f.severity).toBe("info");
  });

  it("有 JOIN → warn 級 select-star-with-join（且不重複報 select-star）", () => {
    const sql = "SELECT * FROM users a JOIN orders b ON a.id = b.user_id";
    const list = ids("mysql", sql);
    expect(list).toContain("select-star-with-join");
    expect(list).not.toContain("select-star");
  });

  it("命中：mssql 的 SELECT TOP (n) *", () => {
    const f = only("mssql", "SELECT TOP (10) * FROM dbo.Users ORDER BY Id", "select-star")[0];
    expect(f).toBeDefined();
  });

  it("不命中：COUNT(*)", () => {
    expect(has("mysql", "SELECT COUNT(*) FROM users WHERE id = 1", "select-star")).toBe(false);
  });

  it("JOIN 只在子查詢 / 衍生表 / UNION 另一側 → 外層其實只有一張表，不可升級成 warn", () => {
    const cases = [
      "SELECT * FROM a WHERE id IN (SELECT id FROM b JOIN c ON b.id = c.id)",
      "SELECT * FROM (SELECT a.id FROM a JOIN b ON a.id = b.id) x",
      "SELECT * FROM a UNION ALL SELECT b.id FROM b JOIN c ON b.id = c.id",
    ];
    for (const sql of cases) {
      const list = ids("mysql", sql);
      expect(list).toContain("select-star");
      expect(list).not.toContain("select-star-with-join");
    }
  });

  it("不命中：EXISTS (SELECT * …) 是慣用法", () => {
    const sql = "SELECT id FROM a WHERE EXISTS (SELECT * FROM b WHERE b.a_id = a.id)";
    const list = ids("mysql", sql);
    expect(list).not.toContain("select-star");
    expect(list).not.toContain("select-star-with-join");
  });
});

describe("nolock（僅 mssql）", () => {
  it("命中：WITH (NOLOCK) / READ UNCOMMITTED", () => {
    expect(has("mssql", "SELECT id FROM t WITH (NOLOCK) WHERE id = 1", "nolock")).toBe(true);
    expect(has("mssql", "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED", "nolock")).toBe(true);
  });

  it("方言感知：同樣的字在 mysql / postgres 不報", () => {
    expect(has("mysql", "SELECT id FROM t WITH (NOLOCK) WHERE id = 1", "nolock")).toBe(false);
    expect(has("postgres", "SELECT id FROM t WITH (NOLOCK) WHERE id = 1", "nolock")).toBe(false);
  });

  it("字界：欄位名 nolocked 不是 NOLOCK 提示", () => {
    expect(has("mssql", "SELECT nolocked FROM t WHERE id = 1", "nolock")).toBe(false);
  });
});

describe("implicit-cast-literal", () => {
  it("命中：純數字字串與欄位比較", () => {
    expect(has("mysql", "SELECT id FROM t WHERE user_id = '123'", "implicit-cast-literal")).toBe(true);
    expect(has("mysql", "SELECT id FROM t WHERE t.amount > '100'", "implicit-cast-literal")).toBe(true);
  });

  it("不命中：沒有引號的數值比較（本來就對）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE user_id = 123", "implicit-cast-literal")).toBe(false);
  });

  it("不命中：值不是純數字（就是普通字串比較）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE name = 'abc123'", "implicit-cast-literal")).toBe(false);
  });

  it("不命中：有前導零（幾乎必然是補零代碼，本來就是字串欄）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE ext_id = '007'", "implicit-cast-literal")).toBe(false);
  });

  it("不命中：單一位數（壓倒性是 CHAR(1) / ENUM 的狀態旗標）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE flag = '1' AND memo = 'note 123'", "implicit-cast-literal")).toBe(false);
    expect(has("mysql", "SELECT id FROM t WHERE gender = '0'", "implicit-cast-literal")).toBe(false);
  });

  it("不命中：欄名本身在講編號 / 代碼（壓最大宗的誤報）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE order_no = '123'", "implicit-cast-literal")).toBe(false);
    expect(has("mysql", "SELECT id FROM t WHERE zip = '100'", "implicit-cast-literal")).toBe(false);
  });

  it("不命中：UPDATE 的 SET 子句（不是條件，不影響索引選擇）", () => {
    expect(has("mysql", "UPDATE t SET status = '1' WHERE id = 5", "implicit-cast-literal")).toBe(false);
  });

  it("不命中：日期時間欄位或日期樣式的字面值（對它們建議「去掉引號」是錯的）", () => {
    expect(has("mysql", "SELECT id FROM t WHERE created_at >= '20240101'", "implicit-cast-literal")).toBe(false);
    expect(has("mssql", "SELECT id FROM t WHERE OrderDate = '20240101'", "implicit-cast-literal")).toBe(false);
    expect(has("mysql", "SELECT id FROM t WHERE ym = '202401'", "implicit-cast-literal")).toBe(false);
    expect(has("mysql", "SELECT id FROM t WHERE d = '20240101'", "implicit-cast-literal")).toBe(false);
  });

  it("命中：mssql 的 N'123' 前綴字面值", () => {
    expect(has("mssql", "SELECT id FROM t WHERE user_id = N'123'", "implicit-cast-literal")).toBe(true);
  });
});

describe("order-by-without-limit", () => {
  it("命中：ORDER BY 但沒有任何限制筆數", () => {
    expect(has("mysql", "SELECT id FROM t ORDER BY created_at DESC", "order-by-without-limit")).toBe(true);
  });

  it("不命中：mysql / postgres / sqlite 的 LIMIT", () => {
    expect(has("mysql", "SELECT id FROM t ORDER BY id LIMIT 100", "order-by-without-limit")).toBe(false);
    expect(has("sqlite", "SELECT id FROM t ORDER BY id LIMIT 10 OFFSET 5", "order-by-without-limit")).toBe(false);
  });

  it("不命中：mssql 的 TOP", () => {
    expect(has("mssql", "SELECT TOP 100 id FROM t ORDER BY id", "order-by-without-limit")).toBe(false);
    expect(has("mssql", "SELECT DISTINCT TOP (50) id FROM t ORDER BY id", "order-by-without-limit")).toBe(false);
  });

  it("不命中：oracle 的 FETCH FIRST / ROWNUM", () => {
    expect(has("oracle", "SELECT id FROM t ORDER BY id FETCH FIRST 10 ROWS ONLY", "order-by-without-limit")).toBe(false);
    expect(has("oracle", "SELECT id FROM t WHERE ROWNUM <= 10 ORDER BY id", "order-by-without-limit")).toBe(false);
  });

  it("不命中：視窗函式括號內的 ORDER BY（不是結果集排序）", () => {
    const sql = "SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn, id FROM t";
    expect(has("mssql", sql, "order-by-without-limit")).toBe(false);
  });
});

describe("distinct-with-group-by", () => {
  it("命中：同一層同時有 DISTINCT 與 GROUP BY", () => {
    const sql = "SELECT DISTINCT dept FROM emp GROUP BY dept";
    expect(has("mysql", sql, "distinct-with-group-by")).toBe(true);
  });

  it("不命中：GROUP BY 在子查詢裡（兩者不同層）", () => {
    const sql = "SELECT DISTINCT dept FROM (SELECT dept FROM emp GROUP BY dept) x";
    expect(has("mysql", sql, "distinct-with-group-by")).toBe(false);
  });

  it("不命中：只有其中一個", () => {
    expect(has("mysql", "SELECT DISTINCT dept FROM emp", "distinct-with-group-by")).toBe(false);
    expect(has("mysql", "SELECT dept FROM emp GROUP BY dept", "distinct-with-group-by")).toBe(false);
  });
});

describe("count-star-exists", () => {
  it("命中：COUNT(*) > 0 / = 0 / >= 1", () => {
    expect(has("mysql", "SELECT 1 FROM t HAVING COUNT(*) > 0", "count-star-exists")).toBe(true);
    expect(has("mysql", "SELECT 1 FROM t HAVING COUNT(*) = 0", "count-star-exists")).toBe(true);
    expect(has("mysql", "SELECT 1 FROM t HAVING COUNT(*) >= 1", "count-star-exists")).toBe(true);
  });

  it("不命中：真的在取數量", () => {
    expect(has("mysql", "SELECT COUNT(*) FROM t WHERE id = 1", "count-star-exists")).toBe(false);
    expect(has("mysql", "SELECT 1 FROM t HAVING COUNT(*) > 5", "count-star-exists")).toBe(false);
  });

  it("字界：counterparty 不是 COUNT", () => {
    expect(has("mysql", "SELECT counterparty FROM t WHERE id = 1", "count-star-exists")).toBe(false);
  });
});

describe("cursor-loop", () => {
  it("命中：mssql 的 DECLARE … CURSOR FOR", () => {
    expect(has("mssql", "DECLARE c CURSOR FOR SELECT id FROM t", "cursor-loop")).toBe(true);
  });

  it("命中：oracle 的 CURSOR … IS", () => {
    expect(has("oracle", "CURSOR c IS SELECT id FROM t", "cursor-loop")).toBe(true);
  });

  it("命中：oracle 的隱式游標迴圈 FOR rec IN (SELECT …)", () => {
    expect(has("oracle", "FOR rec IN (SELECT id FROM t) LOOP NULL; END LOOP", "cursor-loop")).toBe(true);
  });

  it("不命中：分批處理用的 WHILE 迴圈（那正是我們會建議的寫法）", () => {
    const sql = "DECLARE @i INT = 0; WHILE @i < 10 BEGIN SET @i = @i + 1; END";
    expect(has("mssql", sql, "cursor-loop")).toBe(false);
  });

  it("方言感知：mysql 不報（規則只掛 mssql / oracle / postgres）", () => {
    expect(has("mysql", "DECLARE c CURSOR FOR SELECT id FROM t", "cursor-loop")).toBe(false);
  });

  it("不命中：OFFSET … FETCH NEXT n ROWS ONLY 分頁（不是游標）", () => {
    const sql = "SELECT id FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY";
    expect(has("mssql", sql, "cursor-loop")).toBe(false);
  });
});

describe("位移與行列換算", () => {
  it("前面有註解時，位移仍對得上原字串（stripCode 會壓縮長度，故不能直接拿它算）", () => {
    const sql = "-- 先備份\nDELETE FROM audit_log";
    const f = only("mysql", sql, "no-where-dml")[0];
    expect(sql.slice(f.from, f.to)).toBe("DELETE");
    expect(f.from).toBe(sql.indexOf("DELETE"));
    expect(f.line).toBe(2);
    expect(f.col).toBe(1);
  });

  it("前面有長字串字面值時，位移仍對得上", () => {
    const sql = "SELECT '一段很長的字串內容 aaaaaaaaaa' AS note FROM t WHERE name LIKE '%x'";
    const f = only("mysql", sql, "leading-wildcard-like")[0];
    expect(sql.slice(f.from, f.to)).toBe("LIKE '%x'");
  });

  it("區塊註解含換行時，行號仍正確", () => {
    const sql = "/* 說明\n第二行 */\nSELECT * FROM t";
    const f = only("mysql", sql, "select-star")[0];
    expect(f.line).toBe(3);
    expect(sql.slice(f.from, f.to)).toBe("SELECT *");
  });

  it("多語句：位移換算回整份文件，且依 from 排序", () => {
    const sql = "SELECT * FROM a;\nDELETE FROM b;\nSELECT c FROM d WHERE x LIKE '%y'";
    const list = lintSql("mysql", sql);
    expect(list.map((f) => f.from)).toEqual([...list.map((f) => f.from)].sort((x, y) => x - y));
    for (const f of list) expect(f.from).toBeGreaterThanOrEqual(0);
    expect(list.map((f) => f.id)).toContain("no-where-dml");
    const del = list.find((f) => f.id === "no-where-dml")!;
    expect(sql.slice(del.from, del.to)).toBe("DELETE");
    expect(del.line).toBe(2);
  });

  it("每筆結果的欄位都齊全且已 t() 過", () => {
    const list = lintSql("mysql", "SELECT * FROM a, b");
    expect(list.length).toBeGreaterThan(0);
    for (const f of list) {
      expect(LINT_RULES.some((r) => r.id === f.id && r.severity === f.severity)).toBe(true);
      expect(f.line).toBeGreaterThanOrEqual(1);
      expect(f.col).toBeGreaterThanOrEqual(1);
      expect(f.to).toBeGreaterThan(f.from);
      expect(f.message.length).toBeGreaterThan(0);
      expect(f.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("詞法遮罩：字面值 / 識別字 / 註解裡的字一律不算關鍵字", () => {
  it("被引號括起來的識別字即使叫 count / union / where 也不誤判", () => {
    const sql = "SELECT `count`, `union`, `where` FROM `select` WHERE `like` = 1";
    expect(lintSql("mysql", sql)).toEqual([]);
  });

  it("dollar-quote 區塊內的 DELETE 不算頂層 DML", () => {
    expect(lintSql("postgres", "DO $$ BEGIN DELETE FROM t; END $$")).toEqual([]);
  });

  it("被註解掉的條件不會被當成有效條件", () => {
    // 條件全在區塊註解裡 → 這句其實沒有 WHERE，必須命中
    expect(has("mysql", "UPDATE t SET a = 1 /* WHERE id = 1 */", "no-where-dml")).toBe(true);
  });

  it("mssql 的 [識別字]：欄位叫 [Union] / [Order By] 不是關鍵字", () => {
    expect(lintSql("mssql", "SELECT [Union] AS u FROM t WHERE id = 1")).toEqual([]);
    expect(lintSql("mssql", "SELECT [Order By] FROM t")).toEqual([]);
    expect(lintSql("mssql", "UPDATE [t] SET [a] = 1 WHERE [id] = 1")).toEqual([]);
  });

  it("反向：UPDATE t SET [Where] = 1 的 [Where] 是欄位不是條件，仍要報無條件更新", () => {
    expect(has("mssql", "UPDATE t SET [Where] = 1", "no-where-dml")).toBe(true);
  });

  it("字串內容不會被當成表關聯條件", () => {
    const sql = "SELECT x FROM a, b WHERE a.note = 'a.id = b.a_id'";
    expect(has("mysql", sql, "missing-join-condition")).toBe(true);
  });
});

describe("整體：乾淨的查詢不該有任何 warn / error", () => {
  it("寫得好的 SELECT 只可能有 info 級建議", () => {
    const sql =
      "SELECT u.id, u.name FROM users u JOIN orders o ON o.user_id = u.id " +
      "WHERE u.created_at >= '2024-01-01' AND u.status IN (1, 2) ORDER BY u.id LIMIT 100";
    expect(lintSql("mysql", sql)).toEqual([]);
  });

  it("寫得好的 DML 不報", () => {
    expect(lintSql("mysql", "UPDATE users SET active = 0 WHERE id = 42")).toEqual([]);
    expect(lintSql("postgres", "INSERT INTO t (a, b) VALUES (1, 2)")).toEqual([]);
  });
});
