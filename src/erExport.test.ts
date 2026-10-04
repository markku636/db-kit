import { describe, expect, it } from "vitest";
import { erCardHeight, erToSvg, ER_CARD_W } from "./erExport";
import type { ErModel } from "./api";

const model: ErModel = {
  tables: [
    { name: "orders", columns: [{ name: "id", data_type: "int", pk: true, fk: false }, { name: "customer_id", data_type: "int", pk: false, fk: true }] },
    { name: "customers", columns: [{ name: "id", data_type: "int", pk: true, fk: false }, { name: "name<&>", data_type: "varchar(50)", pk: false, fk: false }] },
    { name: "not_placed", columns: [] },
  ],
  relations: [{ from_table: "orders", from_column: "customer_id", to_table: "customers", to_column: "id" }],
};
const pos = { orders: { x: 300, y: 200 }, customers: { x: 600, y: 260 } };

describe("erToSvg", () => {
  it("裁到內容範圍（加邊距），不是整張 2400×1600 畫布", () => {
    const { width, height } = erToSvg(model, pos);
    expect(width).toBe(600 - 300 + ER_CARD_W + 48);
    expect(height).toBe(260 + erCardHeight(model.tables[1]) - 200 + 48);
  });
  it("每張有位置的表一張卡、每條關聯一條線；沒放的表略過", () => {
    const { svg } = erToSvg(model, pos);
    expect(svg).toContain(">orders<");
    expect(svg).toContain(">customers<");
    expect(svg).not.toContain("not_placed");
    expect(svg.match(/<line x1=/g)?.length).toBeGreaterThanOrEqual(1);
    expect(svg).toContain("orders.customer_id → customers.id");
  });
  it("跳脫 XML 特殊字元", () => {
    const { svg } = erToSvg(model, pos);
    expect(svg).toContain("name&lt;&amp;&gt;");
    expect(svg).not.toContain("name<&>");
  });
  it("標題放在上方並把內容往下推", () => {
    const a = erToSvg(model, pos);
    const b = erToSvg(model, pos, "shop");
    expect(b.height).toBe(a.height + 28);
    expect(b.svg).toContain(">shop</text>");
  });
});
