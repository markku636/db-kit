import { describe, it, expect } from "vitest";
import { parseEditTarget } from "./queryEditTarget";

// 回 "db.table" / "table" / null，方便一行一個 case 對照。
const target = (sql: string) => {
  const r = parseEditTarget(sql);
  return r ? (r.database ? `${r.database}.${r.table}` : r.table) : null;
};

describe("查詢結果可寫回的目標表（parseEditTarget）", () => {
  it("單表 SELECT：認得表名、庫名與別名", () => {
    expect(target("SELECT * FROM Configuration WHERE ConfigKey = 1")).toBe("Configuration");
    expect(target("SELECT *\nFROM `Siebog`.`Configuration`\nWHERE x = 1")).toBe("Siebog.Configuration");
    expect(target("select ConfigKey, ConfigValue from Configuration c where c.Id > 1 order by Id")).toBe("Configuration");
    expect(target("SELECT c.* FROM Configuration AS c LIMIT 10")).toBe("Configuration");
    expect(target("SELECT TOP 10 * FROM [dbo].[Users]")).toBe("dbo.Users");
    expect(target('SELECT * FROM "public"."users"')).toBe("public.users");
    expect(target("SELECT * FROM t FOR UPDATE")).toBe("t");
  });

  it("註解不影響解析，字串常值裡的 -- 不會被當成註解", () => {
    expect(target("/* hi */ SELECT * FROM t")).toBe("t");
    expect(target("SELECT * FROM t -- 註解\nWHERE 1=1")).toBe("t");
    expect(target("SELECT * FROM t # MySQL 註解\nWHERE 1=1")).toBe("t");
    expect(target("SELECT * FROM t WHERE s = 'a -- not comment' AND j = 2")).toBe("t");
  });

  it("對不回原始列的形狀一律不給：多表 / 集合運算 / 分組 / 去重 / CTE / 子查詢當來源", () => {
    expect(target("SELECT * FROM a JOIN b ON a.id = b.id")).toBeNull();
    expect(target("SELECT * FROM a t1 LEFT JOIN b ON 1 = 1")).toBeNull();
    expect(target("SELECT * FROM a, b")).toBeNull();
    expect(target("SELECT DISTINCT x FROM a")).toBeNull();
    expect(target("SELECT x, COUNT(*) FROM a GROUP BY x")).toBeNull();
    expect(target("SELECT * FROM a UNION SELECT * FROM b")).toBeNull();
    expect(target("WITH q AS (SELECT 1) SELECT * FROM q")).toBeNull();
    expect(target("SELECT * FROM (SELECT 1) t")).toBeNull();
  });

  it("非 SELECT、多語句、三段式名稱不給", () => {
    expect(target("UPDATE a SET x = 1")).toBeNull();
    expect(target("DELETE FROM a")).toBeNull();
    expect(target("SELECT * FROM a; SELECT * FROM b")).toBeNull();
    expect(target("SELECT * FROM db.schema.tbl")).toBeNull();
    expect(target("")).toBeNull();
    expect(target("SELECT 1")).toBeNull();
  });

  it("WHERE 子句裡的子查詢不影響外層目標表（外層仍是單表）", () => {
    expect(target("SELECT * FROM t WHERE id IN (SELECT id FROM u)")).toBe("t");
  });

  it("聚合 / 運算式仍會回表名，靠呼叫端比對實體欄位把它擋下來", () => {
    // parseEditTarget 只負責「FROM 的形狀」；欄位是不是實體欄位由 ResultTable 拿
    // tableColumns 比對（MAX(id) 對不上任何欄名 → 整個結果集不給編輯）。
    expect(target("SELECT MAX(id) FROM t")).toBe("t");
  });
});
