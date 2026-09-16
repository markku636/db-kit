import { afterEach, describe, expect, it } from "vitest";
import type { SchemaDiff, SyncStatement } from "./api";
import type { CompareReport, } from "./compareReport";
import { buildCompareHtml, buildCompareJson, buildCompareMarkdown, flattenTableDiff } from "./compareReport";
import { useLang } from "./i18n";

const schema: SchemaDiff = {
  src_kind: "mysql", dst_kind: "mysql", src_db: "a", dst_db: "b", cross_engine: false,
  tables_added: ["n"], tables_removed: [], tables_identical: ["same"],
  tables_changed: [{
    name: "t", columns_added: [{ name: "x|y", data_type: "int", nullable: false, key: "", default: "0", extra: "", comment: "" }],
    columns_removed: [], columns_changed: [{ name: "c", src: { name: "c", data_type: "bigint", nullable: true, key: "", default: null, extra: "", comment: "" }, dst: { name: "c", data_type: "int", nullable: true, key: "", default: null, extra: "", comment: "" }, attrs: ["data_type"] }],
    indexes_added: [{ name: "ix", columns: ["x"], unique: true, primary: false }], indexes_removed: [], indexes_changed: [],
    fks_added: [], fks_removed: [], fks_changed: [], ddl_differs: false,
  }],
  views_added: [], views_removed: [], views_changed: [{ name: "v", routine_type: null, src: "SELECT 1 <b>", dst: "SELECT 2" }],
  routines_added: [], routines_removed: [], routines_changed: [],
  summary: { tables_added: 1, tables_removed: 0, tables_changed: 1, views_added: 0, views_removed: 0, views_changed: 1, routines_added: 0, routines_removed: 0, routines_changed: 0, total: 3 },
};
const stmts: SyncStatement[] = [
  { sql: "ALTER TABLE `t` ADD COLUMN `x|y` int", kind: "add_column", object: "t.x|y", destructive: false, note: null },
  { sql: "DROP TABLE `gone`;", kind: "drop_table", object: "gone", destructive: true, note: null },
];
const report: CompareReport = {
  source: "prod / a", target: "test / b", generatedAt: Date.UTC(2026, 8, 15, 1, 2, 3),
  rows: [
    { name: "same", objType: "table", status: "identical" },
    { name: "t", objType: "table", status: "differs" },
    { name: "n", objType: "table", status: "source_only" },
    { name: "v", objType: "view", status: "differs" },
  ],
  schema, statements: stmts, skipped: ["foo <bar>"],
  aiSummary: "這次以新增為主，但含 1 句 DROP TABLE <gone>，建議先備份。",
};

afterEach(() => useLang.setState({ lang: "zh-TW", catalog: {} }));

describe("compareReport", () => {
  it("flattens table diffs one row per change", () => {
    const rows = flattenTableDiff(schema.tables_changed[0]);
    expect(rows.map((r) => r.change)).toEqual(["新增", "變更（data_type）", "新增"]);
    expect(rows[0].source).toBe("int NOT NULL DEFAULT 0");
  });

  it("markdown has summary, object table, per-table sections and script", () => {
    const md = buildCompareMarkdown(report);
    expect(md).toContain("# 比對報告：prod / a → test / b");
    expect(md).toContain("產生時間：2026-09-15 01:02:03（UTC）");
    expect(md).toContain("| 相同 | 1 |");
    expect(md).toContain("## AI 總結");
    expect(md).toContain("建議先備份");
    expect(md).toContain("| t | table | 有差異 |  |");
    expect(md).not.toMatch(/\| same \|/); // 相同的表不逐列列出
    expect(md).toContain("### t");
    expect(md).toContain("| 欄位 | x\\|y | 新增 |"); // 管線跳脫
    expect(md).toContain("### v");
    expect(md).toContain("## 同步腳本（2 句，1 句為破壞性）");
    expect(md).toContain("-- [destructive]\nDROP TABLE `gone`;");
    expect(md).toContain("- foo <bar>");
  });

  it("html escapes content and switches lang attribute", () => {
    const html = buildCompareHtml(report);
    expect(html).toContain('<html lang="zh-Hant">');
    expect(html).toContain("SELECT 1 &lt;b&gt;");
    expect(html).toContain("<li>foo &lt;bar&gt;</li>");
    // AI 總結也要跳脫（模型輸出同樣是不可信的文字）
    expect(html).toContain('<div class="ai">');
    expect(html).toContain("DROP TABLE &lt;gone&gt;");
    expect(html).toContain("x|y");
    useLang.setState({ lang: "en", catalog: {} });
    expect(buildCompareHtml(report)).toContain('<html lang="en">');
  });

  it("json round-trips the essentials", () => {
    const j = JSON.parse(buildCompareJson(report));
    expect(j.summary.differs).toBe(2);
    expect(j.ai_summary).toContain("建議先備份");
    expect(j.statements).toHaveLength(2);
    expect(j.schema.tables_changed[0].name).toBe("t");
    expect(j.generated_at).toBe("2026-09-15T01:02:03.000Z");
  });
});
