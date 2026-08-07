import { describe, it, expect } from "vitest";
import {
  analyzeBatch,
  analyzeStatement,
  effectiveRows,
  foldImpactTotals,
  isReadOnlyProbeSql,
  maskSql,
  splitTopLevel,
} from "./impact";
import type { DbKind } from "./api";

// 收集所有正向案例產出的探測 SQL，最後統一斷言「每一條都通過唯讀檢查」。
// 這是本模組最重要的一條防線：探測是唯一會因為「評估」而對 prod 多打查詢的地方。
const produced: { kind: DbKind; sql: string }[] = [];

function one(kind: DbKind, sql: string) {
  const item = analyzeStatement(kind, sql);
  for (const p of item.probes) {
    produced.push({ kind, sql: p.countSql }, { kind, sql: p.previewSql });
    if (p.undoSelect) produced.push({ kind, sql: p.undoSelect });
  }
  return item;
}

describe("maskSql — 位移保留", () => {
  it("遮罩與原文等長，且括號深度正確", () => {
    const sql = "UPDATE t SET a=(SELECT max(x) FROM y) WHERE id=1";
    const m = maskSql("mysql", sql);
    expect(m.mask).toHaveLength(sql.length);
    expect(m.depth).toHaveLength(sql.length);
    // 頂層 WHERE 的位移在遮罩上與原文對得起來
    const at = m.mask.indexOf("WHERE");
    expect(sql.slice(at, at + 5)).toBe("WHERE");
    expect(m.depth[at]).toBe(0);
    // 子查詢內的 SELECT 深度為 1
    const sub = m.mask.indexOf("SELECT", 1);
    expect(m.depth[sub]).toBe(1);
  });

  it("字面值遮成單一 token、註解遮成空白（不黏住鄰接關鍵字）", () => {
    const m = maskSql("mysql", "UPDATE/*c*/t SET a=1");
    expect(m.mask).toContain("UPDATE     t SET");
  });

  it("splitTopLevel 只在深度 0 切", () => {
    const m = maskSql("postgres", "a, b(1,2), c");
    expect(splitTopLevel(m, 0, m.src.length, ",")).toEqual(["a", "b(1,2)", "c"]);
  });
});

describe("UPDATE 改寫", () => {
  it("基本 WHERE", () => {
    const r = one("mysql", "UPDATE t SET a=1 WHERE id>10");
    expect(r.op).toBe("update");
    expect(r.write).toBe(true);
    expect(r.hasWhere).toBe(true);
    expect(r.severity).toBe(1);
    expect(r.irreversible).toBe(false);
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t WHERE id>10");
    expect(r.probes[0].undoSelect).toBe("SELECT * FROM t WHERE id>10");
    expect(r.probes[0].confidence).toBe("exact");
  });

  it("SET 子句裡的子查詢 WHERE 不算頂層（不誤判為安全）", () => {
    const r = one("mysql", "UPDATE `t` SET a=(SELECT max(x) FROM y WHERE y.z=1)");
    expect(r.hasWhere).toBe(false);
    expect(r.severity).toBe(2);
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM `t`");
  });

  it("MySQL 多表 JOIN → upperBound", () => {
    const r = one("mysql", "UPDATE a JOIN b ON a.id=b.aid SET a.x=1 WHERE b.y=2");
    expect(r.probes[0].confidence).toBe("upperBound");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM a JOIN b ON a.id=b.aid WHERE b.y=2");
  });

  it("PostgreSQL UPDATE … FROM → 併入來源並標 upperBound", () => {
    const r = one("postgres", "UPDATE t SET a=1 FROM o WHERE t.id=o.id");
    expect(r.probes[0].confidence).toBe("upperBound");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t, o WHERE t.id=o.id");
  });

  it("保留別名原文", () => {
    const r = one("postgres", "UPDATE t AS x SET a=1 WHERE x.b=2");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t AS x WHERE x.b=2");
  });

  it("ORDER BY / LIMIT 尾巴砍掉，LIMIT 存為 rowCap", () => {
    const r = one("mysql", "UPDATE t SET a=1 WHERE b=2 ORDER BY id LIMIT 5");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t WHERE b=2");
    expect(r.probes[0].rowCap).toBe(5);
    expect(effectiveRows(100, 5)).toBe(5);
    expect(effectiveRows(3, 5)).toBe(3);
  });

  it("RETURNING 尾巴砍掉", () => {
    const r = one("postgres", "UPDATE t SET a=1 WHERE b=2 RETURNING *");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t WHERE b=2");
  });

  it("MSSQL TOP (n) → rowCap，預覽用 TOP 而非 LIMIT", () => {
    const r = one("mssql", "UPDATE TOP (10) t SET a=1 WHERE x=1");
    expect(r.probes[0].rowCap).toBe(10);
    expect(r.probes[0].previewSql).toBe("SELECT TOP (20) * FROM t WHERE x=1");
  });
});

describe("DELETE 改寫", () => {
  it("子查詢 WHERE 不影響頂層判定", () => {
    const r = one("mysql", "DELETE FROM t WHERE id IN (SELECT id FROM s WHERE x=1)");
    expect(r.hasWhere).toBe(true);
    expect(r.probes[0].confidence).toBe("exact");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t WHERE id IN (SELECT id FROM s WHERE x=1)");
  });

  it("MySQL DELETE a FROM a JOIN b → upperBound，標籤取被刪的表", () => {
    const r = one("mysql", "DELETE a FROM a JOIN b ON a.id=b.aid WHERE b.x=1");
    expect(r.probes[0].confidence).toBe("upperBound");
    expect(r.probes[0].label).toBe("a");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM a JOIN b ON a.id=b.aid WHERE b.x=1");
  });

  it("PostgreSQL DELETE … USING → 併入來源", () => {
    const r = one("postgres", "DELETE FROM t USING o WHERE t.id=o.id");
    expect(r.probes[0].confidence).toBe("upperBound");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t, o WHERE t.id=o.id");
  });

  it("MSSQL 第二個 FROM 才是真來源", () => {
    const r = one("mssql", "DELETE FROM a FROM a JOIN b ON a.id=b.aid WHERE b.x=1");
    expect(r.probes[0].confidence).toBe("upperBound");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM a JOIN b ON a.id=b.aid WHERE b.x=1");
  });

  it("MSSQL DELETE TOP (10)", () => {
    const r = one("mssql", "DELETE TOP (10) FROM t WHERE x=1");
    expect(r.probes[0].rowCap).toBe(10);
    expect(r.probes[0].previewSql.startsWith("SELECT TOP (20) *")).toBe(true);
  });

  it("MSSQL OUTPUT 子句夾在 FROM 與 WHERE 之間，必須砍掉", () => {
    const r = one("mssql", "DELETE FROM dbo.[Order Items] OUTPUT deleted.* WHERE qty=0");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM dbo.[Order Items] WHERE qty=0");
    // 引號識別字內的空白不可把表名切成半截
    expect(r.probes[0].label).toBe("dbo.[Order Items]");
  });

  it("Oracle 省略 FROM、預覽用 FETCH FIRST、計數子查詢別名不加 AS", () => {
    const r = one("oracle", "DELETE t alias WHERE alias.x=1");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t alias WHERE alias.x=1");
    expect(r.probes[0].previewSql).toBe("SELECT * FROM t alias WHERE alias.x=1 FETCH FIRST 20 ROWS ONLY");
  });

  it("無 WHERE → 全表、severity 2、仍有前像可存", () => {
    const r = one("sqlite", "DELETE FROM t");
    expect(r.hasWhere).toBe(false);
    expect(r.severity).toBe(2);
    expect(r.irreversible).toBe(false);
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t");
    expect(r.probes[0].undoSelect).toBe("SELECT * FROM t");
  });
});

describe("TRUNCATE / DROP / ALTER", () => {
  it("PostgreSQL 多表 TRUNCATE，選項字尾砍掉", () => {
    const r = one("postgres", "TRUNCATE TABLE a, b RESTART IDENTITY CASCADE");
    expect(r.op).toBe("truncate");
    expect(r.irreversible).toBe(true);
    expect(r.severity).toBe(2);
    expect(r.probes).toHaveLength(2);
    expect(r.probes.map((p) => p.countSql)).toEqual(["SELECT COUNT(*) FROM a", "SELECT COUNT(*) FROM b"]);
  });

  it("DROP TABLE 多表 + IF EXISTS + CASCADE", () => {
    const r = one("postgres", "DROP TABLE IF EXISTS a, b CASCADE");
    expect(r.op).toBe("drop_table");
    expect(r.irreversible).toBe(true);
    expect(r.targets).toEqual(["a", "b"]);
    expect(r.probes).toHaveLength(2);
  });

  it("DROP DATABASE 無單表可數", () => {
    const r = one("mysql", "DROP DATABASE app");
    expect(r.op).toBe("drop_database");
    expect(r.reason).toBe("wholeDatabase");
    expect(r.irreversible).toBe(true);
    expect(r.probes).toHaveLength(0);
  });

  it("DROP INDEX 不影響資料列", () => {
    const r = one("mysql", "DROP INDEX ix ON t");
    expect(r.op).toBe("drop_object");
    expect(r.reason).toBe("noRowImpact");
    expect(r.irreversible).toBe(true);
  });

  it("ALTER TABLE DROP COLUMN → 不可逆 + 該表列數", () => {
    const r = one("mysql", "ALTER TABLE t DROP COLUMN c");
    expect(r.op).toBe("alter_table");
    expect(r.irreversible).toBe(true);
    expect(r.severity).toBe(2);
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t");
  });

  it("ALTER TABLE ADD COLUMN → 不動既有資料", () => {
    const r = one("mysql", "ALTER TABLE t ADD COLUMN c INT");
    expect(r.irreversible).toBe(false);
    expect(r.severity).toBe(1);
    expect(r.probes).toHaveLength(1);
  });
});

describe("INSERT", () => {
  it("VALUES tuple 數（靜態）", () => {
    const r = one("mysql", "INSERT INTO t (a,b) VALUES (1,2),(3,4)");
    expect(r.staticRows).toBe(2);
    expect(r.staticExact).toBe(true);
    expect(r.probes).toHaveLength(0);
    expect(r.write).toBe(true);
    expect(r.targets).toEqual(["t"]);
  });

  it("巢狀子查詢不誤數 tuple", () => {
    const r = one("mysql", "INSERT INTO t VALUES (1,(SELECT max(x) FROM y)),(2,(SELECT 1))");
    expect(r.staticRows).toBe(2);
  });

  it("INSERT … SELECT → 包成子查詢計數，無前像可存", () => {
    const r = one("mysql", "INSERT INTO t SELECT * FROM s WHERE x=1");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) AS total FROM (SELECT * FROM s WHERE x=1) AS _sub");
    expect(r.probes[0].undoSelect).toBeNull();
  });

  it("Oracle 子查詢別名不加 AS", () => {
    const r = one("oracle", "INSERT INTO t SELECT * FROM s WHERE x=1");
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) AS total FROM (SELECT * FROM s WHERE x=1) _sub");
  });

  it("ON DUPLICATE KEY UPDATE → tuple 數不保證等於落地列數", () => {
    const r = one("mysql", "INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a=a+1");
    expect(r.staticRows).toBe(1);
    expect(r.staticExact).toBe(false);
  });

  it("MySQL INSERT … SET", () => {
    const r = one("mysql", "INSERT INTO t SET a=1");
    expect(r.staticRows).toBe(1);
  });

  it("REPLACE INTO 會先刪掉衝突列 → 不可逆", () => {
    const r = one("mysql", "REPLACE INTO t VALUES (1,2)");
    expect(r.op).toBe("replace");
    expect(r.irreversible).toBe(true);
    expect(r.staticRows).toBe(1);
  });
});

describe("遮罩健壯性 —— 字面值 / 註解裡的關鍵字不算數", () => {
  it("字面值裡的 where 不被當子句", () => {
    const r = one("mysql", "DELETE FROM t WHERE name='a where b'");
    expect(r.hasWhere).toBe(true);
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t WHERE name='a where b'");
  });

  it("字面值裡的 where 不讓無 WHERE 的語句被誤判為安全", () => {
    const r = one("mysql", "UPDATE t SET s='where x'");
    expect(r.hasWhere).toBe(false);
    expect(r.severity).toBe(2);
  });

  it("MySQL 反斜線結尾字串不錯位", () => {
    const r = one("mysql", "DELETE FROM t WHERE a='x\\\\' AND b=1");
    expect(r.hasWhere).toBe(true);
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t WHERE a='x\\\\' AND b=1");
  });

  it("行註解 / 區塊註解裡的 WHERE 不算", () => {
    expect(analyzeStatement("mysql", "UPDATE t SET a=1 -- WHERE x").hasWhere).toBe(false);
    expect(analyzeStatement("mysql", "UPDATE t /* WHERE x */ SET a=1").hasWhere).toBe(false);
  });

  it("PostgreSQL $$ 區塊裡的 WHERE 不算，只認真正的頂層 WHERE", () => {
    const r = one("postgres", "UPDATE t SET body=$$ WHERE $$ WHERE id=1");
    expect(r.hasWhere).toBe(true);
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM t WHERE id=1");
  });

  it("MSSQL 方括號識別字正確遮罩", () => {
    const r = one("mssql", "UPDATE [my table] SET [where]=1 WHERE id=1");
    expect(r.hasWhere).toBe(true);
    expect(r.probes[0].countSql).toBe("SELECT COUNT(*) FROM [my table] WHERE id=1");
  });
});

describe("必須回「無法估算」的保守邊界", () => {
  const cases: [DbKind, string, string][] = [
    ["oracle", "MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.a=s.a", "mergeBranches"],
    ["postgres", "WITH d AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT * FROM d", "writingCte"],
    ["mysql", "CALL sp_x(1)", "procedureBody"],
    ["mssql", "EXEC dbo.p", "procedureBody"],
    ["postgres", "DO $$ BEGIN UPDATE t SET a=1; END $$", "procedureBody"],
    ["mysql", "DROP DATABASE app", "wholeDatabase"],
    ["mysql", "LOAD DATA INFILE 'x' INTO TABLE t", "bulkLoad"],
    ["postgres", "COPY t FROM '/x'", "bulkLoad"],
    ["mysql", "UPDATE t SET a=:v WHERE id=:id", "unresolvedParams"],
    ["mssql", "UPDATE t SET a=1 WHERE CURRENT OF cur", "unparsed"],
    ["mysql", "UPDATE t WHERE x=1", "unparsed"],
    ["mysql", "CREATE TABLE t (id INT)", "noRowImpact"],
    ["mysql", "GRANT SELECT ON t TO u", "noRowImpact"],
  ];
  for (const [kind, sql, reason] of cases) {
    it(`${reason}: ${sql.slice(0, 44)}`, () => {
      const r = analyzeStatement(kind, sql);
      expect(r.write).toBe(true);
      expect(r.probes).toHaveLength(0);
      expect(r.reason).toBe(reason);
    });
  }

  it("INSERT … SELECT 內含寫入 CTE → 拒絕探測", () => {
    const r = analyzeStatement("postgres", "INSERT INTO b WITH d AS (DELETE FROM a RETURNING *) SELECT * FROM d");
    expect(r.probes).toHaveLength(0);
    expect(r.reason).toBe("writingCte");
  });
});

describe("讀取型語句不列入評估", () => {
  it("SELECT / SHOW / EXPLAIN / 唯讀 CTE", () => {
    for (const sql of ["SELECT 1", "SHOW TABLES", "EXPLAIN SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x"]) {
      const r = analyzeStatement("mysql", sql);
      expect(r.write).toBe(false);
      expect(r.reason).toBeNull();
      expect(r.probes).toHaveLength(0);
    }
  });

  it("COPY … TO 是匯出，不是寫入", () => {
    expect(analyzeStatement("postgres", "COPY t TO '/x'").write).toBe(false);
  });
});

describe("isReadOnlyProbeSql 安全閘", () => {
  it("拒絕會寫入 / 建物件 / 多語句的查詢", () => {
    const bad = [
      "SELECT * INTO n FROM t",
      "WITH d AS (DELETE FROM a RETURNING *) SELECT 1",
      "SET search_path TO x",
      "SELECT 1; DROP TABLE t",
      "UPDATE t SET a=1",
      "TRUNCATE t",
    ];
    for (const sql of bad) expect(isReadOnlyProbeSql("postgres", sql)).toBe(false);
  });

  it("放行純讀取，且不因欄名含關鍵字前綴而誤拒", () => {
    expect(isReadOnlyProbeSql("mysql", "SELECT COUNT(*) FROM order_items WHERE created_at > 1 AND deleted_at IS NULL")).toBe(
      true,
    );
    expect(isReadOnlyProbeSql("postgres", "WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
  });

  it("字面值裡的寫入關鍵字不算數", () => {
    expect(isReadOnlyProbeSql("mysql", "SELECT COUNT(*) FROM t WHERE action='delete'")).toBe(true);
  });

  it("所有正向案例產出的探測 SQL 全部通過唯讀檢查", () => {
    expect(produced.length).toBeGreaterThan(30);
    for (const { kind, sql } of produced) {
      expect(isReadOnlyProbeSql(kind, sql), sql).toBe(true);
    }
  });
});

describe("批次與彙總", () => {
  it("analyzeBatch 標序號、分辨讀寫", () => {
    const items = analyzeBatch("mysql", ["SELECT 1", "DELETE FROM t WHERE a=1"]);
    expect(items[0].write).toBe(false);
    expect(items[1].index).toBe(1);
    expect(items[1].write).toBe(true);
  });

  it("foldImpactTotals：exact 相加、upperBound 轉不精確、null 計入待估", () => {
    expect(foldImpactTotals([{ rows: 10, confidence: "exact", rowCap: null }, { rows: 5, confidence: "exact", rowCap: null }])).toEqual(
      { total: 15, exact: true, pending: 0 },
    );
    expect(foldImpactTotals([{ rows: 10, confidence: "upperBound", rowCap: null }])).toEqual({
      total: 10,
      exact: false,
      pending: 0,
    });
    expect(foldImpactTotals([{ rows: null, confidence: "exact", rowCap: null }])).toEqual({
      total: 0,
      exact: true,
      pending: 1,
    });
    // rowCap 生效：LIMIT 5 的 UPDATE 即使符合條件的有 100 列，實際也只會動 5 列
    expect(foldImpactTotals([{ rows: 100, confidence: "exact", rowCap: 5 }]).total).toBe(5);
    // 整表保底同樣不算精確
    expect(
      foldImpactTotals([{ rows: 9, confidence: "exact", rowCap: null, fallbackWholeTable: true }]).exact,
    ).toBe(false);
  });
});
