import { describe, expect, it } from "vitest";
import { joinSuggestions } from "./sqlJoinComplete";

const rels = [
  { from_table: "orders", from_column: "customer_id", to_table: "customers", to_column: "customer_id" },
  { from_table: "order_items", from_column: "order_id", to_table: "orders", to_column: "order_id" },
];
const texts = (before: string, r = rels, schema?: Parameters<typeof joinSuggestions>[2]) =>
  joinSuggestions(before, r, schema)?.map((s) => `${s.source}:${s.text}`) ?? null;

describe("joinSuggestions", () => {
  it("新表在外鍵的子方 / 父方都能推", () => {
    expect(texts("SELECT * FROM orders o JOIN customers c ON ")).toEqual(["fk:c.customer_id = o.customer_id"]);
    expect(texts("SELECT * FROM orders o JOIN order_items oi ON ")).toEqual(["fk:oi.order_id = o.order_id"]);
  });
  it("沒有別名時用表名；AS 別名也認；ON 後已打一半照樣提示", () => {
    expect(texts("SELECT * FROM orders JOIN customers ON ")).toEqual(["fk:customers.customer_id = orders.customer_id"]);
    expect(texts("SELECT * FROM orders AS o LEFT JOIN customers AS c ON c")).toEqual(["fk:c.customer_id = o.customer_id"]);
  });
  it("多表 join 時對前面每張表都找", () => {
    expect(texts("SELECT * FROM customers c JOIN orders o ON o.customer_id = c.customer_id JOIN order_items i ON ")).toEqual(["fk:i.order_id = o.order_id"]);
  });
  it("沒有外鍵時依欄名推測（同名 *_id、id ↔ <單數>_id）", () => {
    const schema = { orders: ["id", "customer_id"], customers: ["id", "name"], shipments: ["id", "order_id", "customer_id"] };
    expect(texts("SELECT * FROM orders o JOIN customers c ON ", [], schema)).toEqual(["guess:c.id = o.customer_id"]);
    expect(texts("SELECT * FROM orders o JOIN shipments s ON ", [], schema)).toEqual(["guess:s.customer_id = o.customer_id", "guess:s.order_id = o.id"]);
  });
  it("不在 JOIN … ON 位置時回 null；前面沒有表時回空", () => {
    expect(texts("SELECT * FROM orders WHERE ")).toBeNull();
    expect(texts("SELECT * FROM orders o JOIN customers c ON c.x = 1 AND ")).toBeNull();
    expect(texts("JOIN customers c ON ")).toEqual([]);
  });
});
