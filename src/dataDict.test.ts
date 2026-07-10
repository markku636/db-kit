import { describe, it, expect, afterEach } from "vitest";
import { buildDbDictMarkdown, buildDbDictHtml, type TableDoc } from "./dataDict";
import { useLang } from "./i18n";
import type { ColumnInfo } from "./api";

const col = (name: string, type: string, nullable = true): ColumnInfo => ({
  name, data_type: type, nullable, key: "", default: null, extra: "", comment: "",
});

const tables: TableDoc[] = [
  { name: "users", cols: [col("id", "int", false), col("name", "varchar(50)")], idx: [{ name: "pk", columns: ["id"], unique: true, primary: true }], fks: [] },
  { name: "orders", cols: [col("id", "int", false), col("user_id", "int")], idx: [], fks: [{ name: "fk_u", column: "user_id", ref_table: "users", ref_column: "id" }] },
];

// 每個測試後還原語言，避免 en 模式外洩污染其他測試（既有中文斷言仰賴預設 zh-TW）。
afterEach(() => {
  useLang.setState({ lang: "zh-TW", catalog: {} });
});

describe("buildDbDictMarkdown", () => {
  it("含標題 / 目錄 / 每表欄位表，外鍵 / 索引按需呈現", () => {
    const md = buildDbDictMarkdown("shop", tables);
    expect(md).toContain("# 資料庫文件：shop");
    expect(md).toContain("共 2 張資料表");
    // 目錄連結（GitHub 風錨點）。
    expect(md).toContain("- [users](#users)（2 欄）");
    expect(md).toContain("- [orders](#orders)（2 欄）");
    // users 有索引、無外鍵。
    expect(md).toContain("## users");
    expect(md).toContain("**索引**");
    // orders 有外鍵。
    expect(md).toContain("**外鍵**");
    expect(md).toContain("| fk_u | user_id | users | id |");
  });

  it("Markdown 表格內的 | 與換行被跳脫", () => {
    const md = buildDbDictMarkdown("d", [{ name: "t", cols: [col("a|b", "text")], idx: [], fks: [] }]);
    expect(md).toContain("a\\|b");
  });
});

describe("buildDbDictHtml", () => {
  it("含 TOC 錨點連結與每表 section，HTML 特殊字元跳脫", () => {
    const html = buildDbDictHtml("shop", [{ name: "t<x>", cols: [col("c", "int")], idx: [], fks: [] }]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('資料庫文件：shop');
    // 表名跳脫 + 錨點。
    expect(html).toContain("t&lt;x&gt;");
    expect(html).toContain('id="t-x"');
    expect(html).toContain('href="#t-x"');
  });
});

describe("buildDbDictHtml — 語言切換", () => {
  it("lang 屬性隨 UI 語言輸出（zh-Hant / en），其餘位元組不變", () => {
    const zh = buildDbDictHtml("shop", tables);
    expect(zh).toContain('<html lang="zh-Hant">');

    useLang.setState({ lang: "en", catalog: {} });
    const en = buildDbDictHtml("shop", tables);
    expect(en).toContain('<html lang="en">');

    // 譯文表為空 → identity fallback：除 lang 屬性外，en 與 zh 逐位元組相同。
    expect(en.replace('lang="en"', 'lang="zh-Hant"')).toBe(zh);
  });
});
