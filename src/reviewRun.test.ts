import { describe, expect, it } from "vitest";
import type { ReviewPrepared, ReviewStatement } from "./api";
import {
  backupBlockReason,
  DEFAULT_REVIEW_RUN_PREFS,
  executeBlockReason,
  incompleteCount,
  joinPath,
  opLabel,
  parseReviewRunPrefs,
  parseVerdict,
  stripVerdictLine,
  summarizeStatements,
  supportsReviewRun,
} from "./reviewRun";

function stmt(over: Partial<ReviewStatement>): ReviewStatement {
  return {
    index: 0,
    sql: "UPDATE t SET a = 1 WHERE id = 1",
    op: "update",
    write: true,
    destructive: false,
    has_where: true,
    method: "predicate",
    targets: ["shop.t"],
    estimated_rows: 1,
    estimate_exact: true,
    rollback: "full",
    notes: [],
    ...over,
  };
}

function prepared(over: Partial<ReviewPrepared["prepared"]> = {}): ReviewPrepared["prepared"] {
  return {
    kind: "mysql",
    database: "shop",
    prod: false,
    max_capture_rows: 10000,
    statements: [stmt({})],
    blockers: [],
    needs_ack: false,
    has_writes: true,
    ...over,
  };
}

describe("supportsReviewRun", () => {
  it("只收六種內建 SQL 引擎", () => {
    for (const k of ["mysql", "mariadb", "postgres", "sqlite", "mssql", "oracle"] as const) expect(supportsReviewRun(k)).toBe(true);
    for (const k of ["external", "mongo", "redis", "kafka", "elastic", "rabbitmq"] as const) expect(supportsReviewRun(k)).toBe(false);
    expect(supportsReviewRun(null)).toBe(false);
  });
});

describe("parseReviewRunPrefs", () => {
  it("缺值 / 壞 JSON 退回預設", () => {
    expect(parseReviewRunPrefs(null)).toEqual(DEFAULT_REVIEW_RUN_PREFS);
    expect(parseReviewRunPrefs("{oops")).toEqual(DEFAULT_REVIEW_RUN_PREFS);
    expect(parseReviewRunPrefs("42")).toEqual(DEFAULT_REVIEW_RUN_PREFS);
  });

  it("各欄位獨立驗證並夾在範圍內", () => {
    const p = parseReviewRunPrefs(JSON.stringify({ outDir: "D:\\bak", maxRows: 9e9, sampleRows: -3, autoReview: "yes" }));
    expect(p).toEqual({ outDir: "D:\\bak", maxRows: 1_000_000, sampleRows: 0, autoReview: true });
    expect(parseReviewRunPrefs(JSON.stringify({ maxRows: "250", sampleRows: 99, autoReview: false }))).toMatchObject({
      maxRows: 250,
      sampleRows: 20,
      autoReview: false,
    });
  });
});

describe("parseVerdict / stripVerdictLine", () => {
  it("與後端同一套寬鬆規則", () => {
    expect(parseVerdict("VERDICT: GO\n## Summary")).toBe("go");
    expect(parseVerdict("\n  **VERDICT: CAUTION**\n")).toBe("caution");
    expect(parseVerdict("# VERDICT：STOP")).toBe("stop");
    expect(parseVerdict("verdict stop")).toBe("stop");
    expect(parseVerdict("Looks fine\nVERDICT: GO")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });

  it("只去掉開頭那一行結論", () => {
    expect(stripVerdictLine("VERDICT: GO\n\n## Summary\nok")).toBe("## Summary\nok");
    expect(stripVerdictLine("## Summary\nVERDICT: GO")).toBe("## Summary\nVERDICT: GO");
  });
});

describe("summarizeStatements / incompleteCount", () => {
  it("只計寫入語句", () => {
    const stmts = [
      stmt({ rollback: "full", estimated_rows: 3 }),
      stmt({ index: 1, rollback: "partial", estimated_rows: 10, estimate_exact: false, destructive: true }),
      stmt({ index: 2, rollback: "none", estimated_rows: null }),
      stmt({ index: 3, write: false, rollback: "not_needed", op: "read", estimated_rows: 999 }),
    ];
    expect(summarizeStatements(stmts)).toEqual({
      writes: 3, full: 1, partial: 1, none: 1, destructive: 1, estimatedRows: 13, estimateUpperBound: true,
    });
    expect(incompleteCount(stmts)).toBe(2);
  });
});

describe("executeBlockReason", () => {
  const base = { loading: false, running: false, prepared: prepared(), readonly: false, outDir: "D:\\bak", aiRunning: false, ackIncomplete: false, ackProd: false };

  it("全部條件滿足才可執行", () => {
    expect(executeBlockReason(base)).toBeNull();
  });

  it("依序回報第一個理由", () => {
    expect(executeBlockReason({ ...base, running: true, loading: true })).toBe("running");
    expect(executeBlockReason({ ...base, prepared: null })).toBe("loading");
    expect(executeBlockReason({ ...base, prepared: prepared({ blockers: [{ index: 0, issue: "tx_control", message: "x" }] }) })).toBe("blocked");
    expect(executeBlockReason({ ...base, prepared: prepared({ has_writes: false }) })).toBe("noWrites");
    expect(executeBlockReason({ ...base, readonly: true })).toBe("readonly");
    expect(executeBlockReason({ ...base, outDir: "  " })).toBe("noOutDir");
    expect(executeBlockReason({ ...base, aiRunning: true })).toBe("aiRunning");
    expect(executeBlockReason({ ...base, prepared: prepared({ needs_ack: true }) })).toBe("needsAck");
    expect(executeBlockReason({ ...base, prepared: prepared({ needs_ack: true }), ackIncomplete: true })).toBeNull();
    expect(executeBlockReason({ ...base, prepared: prepared({ prod: true }) })).toBe("needsProdAck");
    expect(executeBlockReason({ ...base, prepared: prepared({ prod: true }), ackProd: true })).toBeNull();
  });

  it("只產生備份：唯讀連線、需要確認的情況都不擋", () => {
    const b = { loading: false, running: false, prepared: prepared({ needs_ack: true, prod: true }), outDir: "/tmp/x", aiRunning: false };
    expect(backupBlockReason(b)).toBeNull();
    expect(backupBlockReason({ ...b, outDir: "" })).toBe("noOutDir");
  });
});

describe("joinPath / opLabel", () => {
  it("沿用目錄的分隔符", () => {
    expect(joinPath("D:\\bak\\run-1", "rollback.sql")).toBe("D:\\bak\\run-1\\rollback.sql");
    expect(joinPath("D:\\bak\\run-1\\", "rollback.sql")).toBe("D:\\bak\\run-1\\rollback.sql");
    expect(joinPath("/home/u/bak/", "diff.md")).toBe("/home/u/bak/diff.md");
    // 後端回的 Windows 路徑可能混用（使用者輸入 D:/bak，子目錄以 \ 接上）。
    expect(joinPath("D:/bak\\run-1", "x")).toBe("D:/bak\\run-1/x");
  });

  it("語句類型顯示", () => {
    expect(opLabel("create_table")).toBe("CREATE TABLE");
    expect(opLabel("update")).toBe("UPDATE");
  });
});
