import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { MySQL, schemaCompletionSource, sql } from "@codemirror/lang-sql";
import { toMultiDbSqlNamespace } from "./schemaCache";

// 契約測試：跨庫補全整個押在 @codemirror/lang-sql 的兩個行為上——
//   (1) SQLNamespace 的巢狀物件會變成 `庫.表.欄` 三層補全
//   (2) 內建 source 自己解析 `FROM 庫.表 別名` 的別名
// 這兩件事都不是我們寫的，卻是 toMultiDbSqlNamespace 之所以夠用的全部理由。
// 升版把它們改掉時，該壞的是這個檔案，而不是使用者的補全。

const NS = toMultiDbSqlNamespace(
  [
    { table: "orders", columns: ["id", "total"] },
    { table: "users", columns: ["id", "email"] },
  ],
  [{ database: "other_db", tables: [{ table: "customers", columns: ["cust_id", "cust_name"] }] }],
);

/** 在 doc 末端跑一次內建 schema source，回傳候選 label。 */
function complete(doc: string): string[] {
  const state = EditorState.create({
    doc,
    extensions: [sql({ dialect: MySQL, schema: NS })],
  });
  const source = schemaCompletionSource({ dialect: MySQL, schema: NS });
  const res = source(new CompletionContext(state, doc.length, true));
  if (!res || res instanceof Promise) return [];
  return res.options.map((o) => o.label);
}

describe("跨庫命名空間（lang-sql 契約）", () => {
  it("頂層出目前庫的表，額外庫以庫名出現", () => {
    const labels = complete("SELECT * FROM ");
    expect(labels).toContain("orders");
    expect(labels).toContain("users");
    expect(labels).toContain("other_db");
  });

  it("`其他庫.` → 該庫的表", () => {
    expect(complete("SELECT * FROM other_db.")).toEqual(["customers"]);
  });

  it("`其他庫.表.` → 該表的欄位", () => {
    expect(complete("SELECT other_db.customers.")).toEqual(["cust_id", "cust_name"]);
  });

  // 別名解析是內建的（getAliases），所以我們的 source 對 `別名.` 一律讓位。
  it("`FROM 其他庫.表 別名` 之後的 `別名.` → 該表的欄位", () => {
    expect(complete("SELECT * FROM other_db.customers c WHERE c.")).toEqual(["cust_id", "cust_name"]);
  });

  it("目前庫的表用裸名，別名一樣通", () => {
    expect(complete("SELECT * FROM orders o WHERE o.")).toEqual(["id", "total"]);
  });

  it("額外庫的表不會汙染裸名（只能以 其他庫.表 取用）", () => {
    expect(complete("SELECT * FROM ")).not.toContain("customers");
  });
});
