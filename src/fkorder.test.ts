import { describe, it, expect } from "vitest";
import { topoSortByFk } from "./fkorder";

describe("topoSortByFk", () => {
  it("被參照的表排在參照者之前", () => {
    // orders 參照 users → users 應在 orders 之前。
    const out = topoSortByFk(["orders", "users"], [{ from_table: "orders", to_table: "users" }]);
    expect(out.indexOf("users")).toBeLessThan(out.indexOf("orders"));
    expect(out.sort()).toEqual(["orders", "users"]);
  });

  it("多層相依：order_items → orders → users", () => {
    const out = topoSortByFk(
      ["order_items", "orders", "users"],
      [{ from_table: "order_items", to_table: "orders" }, { from_table: "orders", to_table: "users" }],
    );
    expect(out.indexOf("users")).toBeLessThan(out.indexOf("orders"));
    expect(out.indexOf("orders")).toBeLessThan(out.indexOf("order_items"));
  });

  it("環不致無限遞迴，且輸出涵蓋全部表", () => {
    const out = topoSortByFk(["a", "b"], [{ from_table: "a", to_table: "b" }, { from_table: "b", to_table: "a" }]);
    expect(out.slice().sort()).toEqual(["a", "b"]);
  });

  it("忽略不在集合內的關係與自我參照", () => {
    const out = topoSortByFk(["a"], [{ from_table: "a", to_table: "a" }, { from_table: "a", to_table: "z" }]);
    expect(out).toEqual(["a"]);
  });
});
