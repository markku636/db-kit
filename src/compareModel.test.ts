import { describe, it, expect } from "vitest";
import type { SchemaDiff, SyncStatement, TableDiff } from "./api";
import {
  buildAiSummaryPrompt, buildCompareRows, buildSyncScript, describeDiffForAi, normalizeDdl, pairSideBySide,
  renameTableInSchema, sameFamily, snapshotFileName, splitStatements, summarizeRows, tableHasDiff,
} from "./compareModel";
import { diffLines } from "./diff";

const td = (name: string, extra: Partial<TableDiff> = {}): TableDiff => ({
  name, columns_added: [], columns_removed: [], columns_changed: [], indexes_added: [], indexes_removed: [], indexes_changed: [],
  fks_added: [], fks_removed: [], fks_changed: [], ddl_differs: false, ...extra,
});
const schema = (p: Partial<SchemaDiff> = {}): SchemaDiff => ({
  src_kind: "mysql", dst_kind: "mysql", src_db: "a", dst_db: "b", cross_engine: false,
  tables_added: [], tables_removed: [], tables_changed: [], tables_identical: [], views_added: [], views_removed: [], views_changed: [],
  routines_added: [], routines_removed: [], routines_changed: [],
  summary: { tables_added: 0, tables_removed: 0, tables_changed: 0, views_added: 0, views_removed: 0, views_changed: 0, routines_added: 0, routines_removed: 0, routines_changed: 0, total: 0 },
  ...p,
});
describe("buildCompareRows", () => {
  it("maps每種結構狀態，表在前視圖在後", () => {
    const s = schema({
      tables_added: ["only_src"], tables_removed: ["only_dst"],
      tables_changed: [td("changed", { columns_added: [{ name: "x", data_type: "int", nullable: true, key: "", default: null, extra: "", comment: "" }] })],
      tables_identical: ["same"],
      views_changed: [{ name: "v", routine_type: null, src: "a", dst: "b" }],
      routines_added: [{ name: "sp_new", routine_type: "procedure", src: "x", dst: null }],
    });
    const rows = buildCompareRows(s, null, null);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.only_src.status).toBe("source_only");
    expect(by.only_dst.status).toBe("target_only");
    expect(by.same.status).toBe("identical");
    expect(by.changed.status).toBe("differs");
    expect(by.v.objType).toBe("view");
    expect(by.v.status).toBe("differs");
    expect(by.sp_new.objType).toBe("routine");
    expect(rows.map((r) => r.objType)).toEqual(["table", "table", "table", "table", "view", "routine"]);
  });

  it("keeps target-only tables even though they can never be picked", () => {
    // picked 是來源表的子集；僅目標有的表不在其中，但必須留在列表上（同步腳本會 DROP 它）。
    const s = schema({ tables_removed: ["legacy_log"], tables_identical: ["kept"] });
    const rows = buildCompareRows(s, new Set(["kept"]), null);
    expect(rows.map((r) => r.name).sort()).toEqual(["kept", "legacy_log"]);
    expect(rows.find((r) => r.name === "legacy_log")?.status).toBe("target_only");
  });

  it("honours picked and the in-flight table", () => {
    const s = schema({ tables_identical: ["a", "b"], tables_added: ["z"] });
    const rows = buildCompareRows(s, new Set(["a", "b"]), "b");
    expect(rows.find((r) => r.name === "z")).toBeUndefined(); // 未勾選的來源表
    expect(rows.find((r) => r.name === "b")?.status).toBe("running");
    expect(summarizeRows(rows).running).toBe(1);
  });
});

describe("AI 摘要輸入", () => {
  it("只摘要有差異的部分，並點出破壞性語句與無法自動產生的項目", () => {
    const s = schema({
      tables_added: ["n"], tables_removed: ["gone"], tables_identical: ["same"],
      tables_changed: [td("t", {
        columns_added: [{ name: "x", data_type: "int", nullable: true, key: "", default: null, extra: "", comment: "" }],
        columns_changed: [{ name: "c", src: { name: "c", data_type: "bigint", nullable: false, key: "", default: null, extra: "", comment: "" }, dst: { name: "c", data_type: "int", nullable: true, key: "", default: null, extra: "", comment: "" }, attrs: ["data_type", "nullable"] }],
      })],
    });
    const stmts: SyncStatement[] = [
      { sql: "A", kind: "add_column", object: "t.x", destructive: false, note: null },
      { sql: "B", kind: "drop_table", object: "gone", destructive: true, note: null },
    ];
    const d = describeDiffForAi(s, "prod / a", "test / b", stmts, ["t：字元集不同"]);
    expect(d).toContain("來源：prod / a（mysql）");
    expect(d).toContain("僅來源有的資料表（目標需新增）：n");
    expect(d).toContain("僅目標有的資料表（目標多出）：gone");
    expect(d).toContain("欄位 c 的 data_type/nullable 不同（來源 bigint NOT NULL → 目標 int）");
    expect(d).toContain("1 句為破壞性：drop_table gone");
    expect(d).toContain("無法自動產生語句的變更：t：字元集不同");
    expect(d).not.toContain("same"); // 相同的表不進摘要，省 token
    // 提示詞要求風險與順序，且明確禁止輸出 SQL
    const p = buildAiSummaryPrompt(d);
    expect(p).toContain("不要輸出 SQL");
    expect(p).toContain(d);
  });
});

describe("statements", () => {
  const st = (sql: string, destructive = false): SyncStatement => ({ sql, kind: "add_column", object: "t", destructive, note: null });
  it("splits and builds a ;-terminated script with header and markers", () => {
    const { safe, destructive } = splitStatements([st("A"), st("B", true), st("C;")]);
    expect(safe.map((s) => s.sql)).toEqual(["A", "C;"]);
    expect(destructive.map((s) => s.sql)).toEqual(["B"]);
    const script = buildSyncScript([st("A"), st("B", true), st("C;")], "x → y\nline2");
    expect(script).toBe("-- x → y\n-- line2\n\nA;\n\n-- [destructive]\nB;\n\nC;\n");
    // 冪等：再組一次不會多分號。
    expect(buildSyncScript([st("C;")])).toBe("C;\n");
  });
});

describe("ddl helpers", () => {
  it("normalizes ddl noise and pairs diff lines side by side", () => {
    expect(normalizeDdl("CREATE TABLE t (\r\n  id int  \r\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4\n\n"))
      .toBe("CREATE TABLE t (\n  id int\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    const pairs = pairSideBySide(diffLines("a\nx\nc", "a\ny\nz\nc"));
    expect(pairs).toEqual([
      { left: { type: "same", text: "a" }, right: { type: "same", text: "a" } },
      { left: { type: "del", text: "x" }, right: { type: "add", text: "y" } },
      { left: null, right: { type: "add", text: "z" } },
      { left: { type: "same", text: "c" }, right: { type: "same", text: "c" } },
    ]);
  });
  it("misc pure helpers", () => {
    expect(tableHasDiff(td("t"))).toBe(false);
    expect(tableHasDiff(td("t", { ddl_differs: true }))).toBe(true);
    expect(sameFamily("mysql", "mariadb")).toBe(true);
    expect(sameFamily("mysql", "postgres")).toBe(false);
    expect(snapshotFileName("my db/x", new Date(2026, 8, 15, 9, 5))).toBe("my_db_x-schema-20260915-0905.json");
    const s = renameTableInSchema({ kind: "mysql", database: "d", captured_at_ms: 0, label: "", tables: [{ name: "old", kind: "table", columns: [], indexes: [], foreign_keys: [], ddl: null, ddl_synthesized: false, warnings: [] }], views: [], routines: [], warnings: [] }, "old", "new");
    expect(s.tables[0].name).toBe("new");
  });
});
