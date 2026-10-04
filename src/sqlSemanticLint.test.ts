import { describe, expect, it } from "vitest";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { lintSqlSemantics } from "./sqlSemanticLint";

const schema: SQLNamespace = {
  orders: ["order_id", "customer_id", "status", "total"],
  customers: ["customer_id", "name"],
  archive: { old_orders: ["order_id", "archived_at"] },
};
const lint = (sql: string, db: string | null = "shop") => lintSqlSemantics(sql, schema, db);
const words = (sql: string, db?: string | null) => lint(sql, db).map((i) => sql.slice(i.from, i.to));

describe("lintSqlSemantics：會報的", () => {
  it("找不到的表（FROM / JOIN / UPDATE / INSERT INTO）", () => {
    expect(words("SELECT * FROM orderz")).toEqual(["orderz"]);
    expect(words("SELECT * FROM orders o JOIN custs c ON c.id = o.customer_id")).toEqual(["custs"]);
    expect(words("UPDATE nope SET a = 1")).toEqual(["nope"]);
    expect(words("INSERT INTO nope (a) VALUES (1)")).toEqual(["nope"]);
  });
  it("限定欄位：別名或表名對回已知表，欄位不存在", () => {
    expect(words("SELECT o.stauts FROM orders o")).toEqual(["stauts"]);
    expect(words("SELECT orders.nme FROM orders WHERE orders.status = 'x'")).toEqual(["nme"]);
    expect(words("SELECT c.name, o.bogus FROM orders o JOIN customers c ON c.customer_id = o.customer_id")).toEqual(["bogus"]);
  });
  it("已載入的其他庫也查得到；位置對得上原文", () => {
    const sql = "SELECT a.nope FROM archive.old_orders a";
    expect(words(sql)).toEqual(["nope"]);
    expect(words("SELECT * FROM archive.missing")).toEqual(["archive.missing"]);
  });
  it("目前庫限定視同裸名", () => {
    expect(words("SELECT * FROM shop.orders")).toEqual([]);
    expect(words("SELECT * FROM shop.orderz")).toEqual(["shop.orderz"]);
  });
});

describe("lintSqlSemantics：不該報的（寧可漏報）", () => {
  it("CTE、同份腳本 CREATE 的表、暫存表、表函式", () => {
    expect(lint("WITH recent AS (SELECT * FROM orders) SELECT r.x FROM recent r")).toEqual([]);
    expect(lint("CREATE TABLE tmp_x (id int); INSERT INTO tmp_x VALUES (1); SELECT * FROM tmp_x")).toEqual([]);
    expect(lint("SELECT * FROM #tmp; SELECT * FROM @tv")).toEqual([]);
    expect(lint("SELECT * FROM generate_series(1, 3) g")).toEqual([]);
    expect(lint("SELECT * FROM orders o, LATERAL (SELECT 1) x")).toEqual([]);
  });
  it("函式參數裡的 FROM、IS DISTINCT FROM、SELECT INTO", () => {
    expect(lint("SELECT EXTRACT(YEAR FROM created_at), SUBSTRING(name FROM 2), TRIM(BOTH ' ' FROM name) FROM orders")).toEqual([]);
    expect(lint("SELECT * FROM orders WHERE status IS DISTINCT FROM other_col")).toEqual([]);
    expect(lint("SELECT * INTO new_table FROM orders")).toEqual([]);
    expect(lint("SELECT total INTO @t FROM orders")).toEqual([]);
  });
  it("系統目錄、未載入的庫、MSSQL schema 限定、字串與註解", () => {
    expect(lint("SELECT * FROM information_schema.tables; SELECT * FROM pg_stat_activity; SELECT 1 FROM dual; SELECT * FROM sys.objects")).toEqual([]);
    expect(lint("SELECT * FROM otherdb.whatever")).toEqual([]);
    expect(lint("SELECT * FROM dbo.anything")).toEqual([]);
    expect(lint("SELECT 'FROM nope' AS x FROM orders -- FROM nope2\n/* JOIN nope3 */")).toEqual([]);
  });
  it("裸欄名、未知限定詞、函式呼叫、別名衝突都不判", () => {
    expect(lint("SELECT whatever FROM orders")).toEqual([]);
    expect(lint("SELECT x.y FROM orders")).toEqual([]);
    expect(lint("SELECT pg_catalog.now(), o.order_id FROM orders o")).toEqual([]);
    expect(lint("SELECT t.name FROM orders t WHERE EXISTS (SELECT 1 FROM customers t WHERE t.name = 'a')")).toEqual([]);
    expect(lint("INSERT INTO orders (status) VALUES ('a') ON CONFLICT (order_id) DO UPDATE SET status = excluded.status")).toEqual([]);
  });
  it("DDL 不檢查；沒有結構時不檢查", () => {
    expect(lint("DROP TABLE IF EXISTS nope; ALTER TABLE nope2 ADD c int")).toEqual([]);
    expect(lintSqlSemantics("SELECT * FROM nope", undefined)).toEqual([]);
    expect(lintSqlSemantics("SELECT * FROM nope", {})).toEqual([]);
  });
});
