import { describe, it, expect } from "vitest";
import type { SchemaDiff, SyncStatement, TableDiff } from "./api";
import {
  buildAiSummaryPrompt, buildCompareRows, buildSyncScript, countNonDefaultOptions, describeDiffForAi, filterRows, foldUnchanged, hunkStarts,
  normalizeDdl, numberPairs, pairSideBySide, parseCompareOptions, parseStatusFilter, renameTableInSchema, sameFamily, snapshotFileName,
  splitStatements, statementOwner, summarizeRows, tableDiffChanges, tableHasDiff, toCaptureOptions, toDiffOptions, toSyncOptions,
  DEFAULT_COMPARE_OPTIONS, type RowStatus,
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

describe("差異摘要徽章 / 狀態篩選", () => {
  const col = (name: string) => ({ name, data_type: "int", nullable: true, key: "", default: null, extra: "", comment: "" });
  it("tableDiffChanges 數欄位 / 索引 / 外鍵的增刪改；只有 DDL 不同時標 ddlOnly", () => {
    const c = tableDiffChanges(td("t", {
      columns_added: [col("a")], columns_changed: [{ name: "b", src: col("b"), dst: col("b"), attrs: ["data_type"] }],
      indexes_removed: [{ name: "ix", columns: ["a"], unique: false, primary: false }],
    }));
    expect(c.columns).toEqual({ add: 1, del: 0, chg: 1 });
    expect(c.indexes).toEqual({ add: 0, del: 1, chg: 0 });
    expect(c.fks).toEqual({ add: 0, del: 0, chg: 0 });
    expect(c.ddlOnly).toBe(false);
    expect(tableDiffChanges(td("u", { ddl_differs: true })).ddlOnly).toBe(true);
  });

  it("buildCompareRows 把 changes 掛在有差異的表上", () => {
    const rows = buildCompareRows(schema({ tables_changed: [td("t", { columns_added: [col("a")] }), td("same")] }), null, null);
    expect(rows.find((r) => r.name === "t")?.changes?.columns.add).toBe(1);
    expect(rows.find((r) => r.name === "same")?.changes).toBeUndefined();
  });

  it("parseStatusFilter：預設只看三種差異；壞值 / 空陣列退回預設；合法值照收", () => {
    expect([...parseStatusFilter(null)].sort()).toEqual(["differs", "source_only", "target_only"]);
    expect([...parseStatusFilter("garbage")].sort()).toEqual(["differs", "source_only", "target_only"]);
    expect([...parseStatusFilter("[]")].sort()).toEqual(["differs", "source_only", "target_only"]);
    expect([...parseStatusFilter('["identical","bogus"]')]).toEqual(["identical"]);
  });

  it("filterRows：狀態晶片 + 搜尋字；進行中 / 未比對的列不受晶片影響", () => {
    const rows = buildCompareRows(schema({ tables_identical: ["kept", "other"], tables_added: ["Added"] }), null, "kept");
    const on = new Set<RowStatus>(["source_only"]);
    expect(filterRows(rows, on, "").map((r) => r.name).sort()).toEqual(["Added", "kept"]); // kept 正在跑
    expect(filterRows(rows, on, "add").map((r) => r.name)).toEqual(["Added"]);
    expect(filterRows(rows, new Set(["identical"]), "").map((r) => r.name)).toEqual(["kept", "other"]);
  });
});

describe("比對選項", () => {
  it("parseCompareOptions：缺的補預設、非布林丟掉、壞 JSON 回預設", () => {
    expect(parseCompareOptions(null)).toEqual(DEFAULT_COMPARE_OPTIONS);
    expect(parseCompareOptions("{oops")).toEqual(DEFAULT_COMPARE_OPTIONS);
    const o = parseCompareOptions('{"ignore_case":true,"match_by_content":"yes","unknown":1}');
    expect(o.ignore_case).toBe(true);
    expect(o.match_by_content).toBe(true); // 非布林 → 保留預設 true
    expect((o as unknown as Record<string, unknown>).unknown).toBeUndefined();
  });

  it("轉成後端三種選項物件；countNonDefaultOptions 數與預設不同的欄位", () => {
    const o = { ...DEFAULT_COMPARE_OPTIONS, ignore_comments: true, include_views: false };
    expect(toDiffOptions(o)).toEqual({ ignore_case: false, ignore_comments: true, ignore_defaults: false, match_by_content: true });
    expect(toCaptureOptions(o)).toEqual({ include_ddl: true, include_views: false, include_routines: true, tables: null });
    expect(toCaptureOptions(o, ["a"]).tables).toEqual(["a"]);
    expect(toSyncOptions(o).include_views).toBe(false);
    expect(toSyncOptions(o).include_drops).toBe(true);
    expect(countNonDefaultOptions(o)).toBe(2);
    expect(countNonDefaultOptions(DEFAULT_COMPARE_OPTIONS)).toBe(0);
  });
});

describe("statementOwner", () => {
  const st = (kind: SyncStatement["kind"], object: string): SyncStatement => ({ sql: "", kind, object, destructive: false, note: null });
  const rows = buildCompareRows(schema({
    tables_changed: [td("orders", { columns_added: [{ name: "x", data_type: "int", nullable: true, key: "", default: null, extra: "", comment: "" }] }), td("sales.orders", { ddl_differs: true })],
    tables_removed: ["legacy_log"], views_changed: [{ name: "orders", routine_type: null, src: "a", dst: "b" }],
    routines_added: [{ name: "sp_x", routine_type: "procedure", src: "x", dst: null }],
  }), null, null);

  it("欄位 / 索引語句歸到所屬的表，整表語句歸到自己", () => {
    expect(statementOwner(st("add_column", "orders.x"), rows)).toBe("table:orders");
    expect(statementOwner(st("create_index", "orders.ix_a"), rows)).toBe("table:orders");
    expect(statementOwner(st("drop_table", "legacy_log"), rows)).toBe("table:legacy_log");
  });

  it("SQL Server 帶 schema 的表名（sales.orders）取最長前綴，不會誤歸到 sales", () => {
    expect(statementOwner(st("alter_column", "sales.orders.total"), rows)).toBe("table:sales.orders");
  });

  it("視圖 / 程序語句只在同類型的列裡找（同名的表與視圖分得開）", () => {
    expect(statementOwner(st("create_view", "orders"), rows)).toBe("view:orders");
    expect(statementOwner(st("create_routine", "sp_x"), rows)).toBe("routine:sp_x");
    expect(statementOwner(st("drop_index", "unknown.ix"), rows)).toBeNull();
  });
});

describe("並排 DDL：行號、差異段、摺疊", () => {
  const pairs = numberPairs(pairSideBySide(diffLines("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk", "a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk")));

  it("numberPairs 兩側各自編號，缺的一側為 null，changed 標在 del / add 列", () => {
    const p = numberPairs(pairSideBySide(diffLines("a\nb", "a\nb\nc")));
    expect(p.map((x) => [x.ln, x.rn, x.changed])).toEqual([[1, 1, false], [2, 2, false], [null, 3, true]]);
  });

  it("hunkStarts 只記每段差異的第一列", () => {
    expect(hunkStarts(pairs)).toEqual([1, 9]);
    expect(hunkStarts([{ changed: true }, { changed: true }, { changed: false }, { changed: true }])).toEqual([0, 3]);
  });

  it("foldUnchanged 留差異前後各 context 行，其餘縮成摺疊；展開過的攤開", () => {
    const items = foldUnchanged(pairs, 1, new Set());
    expect(items).toEqual([
      { kind: "row", index: 0 }, { kind: "row", index: 1 }, { kind: "row", index: 2 },
      { kind: "fold", from: 3, to: 8 },
      { kind: "row", index: 8 }, { kind: "row", index: 9 }, { kind: "row", index: 10 },
    ]);
    expect(foldUnchanged(pairs, 1, new Set([3])).filter((x) => x.kind === "fold")).toEqual([]);
    // 只有 1–2 行相同時不值得摺
    const short = [{ changed: true }, { changed: false }, { changed: false }, { changed: true }];
    expect(foldUnchanged(short, 0, new Set()).every((x) => x.kind === "row")).toBe(true);
    expect(foldUnchanged([{ changed: false }, { changed: false }, { changed: false }, { changed: false }], 1, new Set())).toEqual([{ kind: "fold", from: 0, to: 4 }]);
  });
});
