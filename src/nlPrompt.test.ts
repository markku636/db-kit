import { describe, it, expect } from "vitest";
import { extractFirstCodeBlock, rankTables } from "./nlPrompt";

describe("extractFirstCodeBlock", () => {
  it("取第一個符合語言的 fenced block", () => {
    const text = "說明文字\n```sql\nSELECT 1;\n```\n更多";
    expect(extractFirstCodeBlock(text, ["sql"])).toBe("SELECT 1;");
  });

  it("多個 block：取第一個符合語言者（跳過不符語言的）", () => {
    const text = "```json\n{}\n```\n```sql\nSELECT 2;\n```";
    expect(extractFirstCodeBlock(text, ["sql"])).toBe("SELECT 2;");
  });

  it("無語言標註的 block 作為 fallback", () => {
    const text = "```\nSELECT 3;\n```";
    expect(extractFirstCodeBlock(text, ["sql"])).toBe("SELECT 3;");
  });

  it("有符合語言時，優先於無標註 block", () => {
    const text = "```\nplain\n```\n```json\n{\"index\":\"x\"}\n```";
    expect(extractFirstCodeBlock(text, ["json"])).toBe('{"index":"x"}');
  });

  it("未閉合 / 無 block → null", () => {
    expect(extractFirstCodeBlock("```sql\nSELECT 1;", ["sql"])).toBeNull();
    expect(extractFirstCodeBlock("沒有任何區塊", ["sql"])).toBeNull();
  });

  it("去除區塊尾端空白", () => {
    expect(extractFirstCodeBlock("```sql\nSELECT 1;\n\n\n```", ["sql"])).toBe("SELECT 1;");
  });
});

describe("rankTables", () => {
  const tables = ["orders", "order_items", "users", "products", "audit_log"];

  it("表名逐字出現在 NL 中者優先", () => {
    const r = rankTables("列出所有 orders 的金額", tables, null, 3);
    expect(r[0]).toBe("orders");
  });

  it("selectedTable 必入選並置頂", () => {
    const r = rankTables("完全不相關的描述 zzz", tables, "audit_log", 2);
    expect(r).toContain("audit_log");
    expect(r[0]).toBe("audit_log");
  });

  it("limit 生效", () => {
    const r = rankTables("orders users products", tables, null, 2);
    expect(r.length).toBe(2);
  });

  it("selectedTable 不在候選也不會塞入不存在的表", () => {
    const r = rankTables("orders", tables, "not_a_table", 3);
    expect(r).not.toContain("not_a_table");
  });
});
