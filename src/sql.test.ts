import { describe, it, expect } from "vitest";
import {
  splitSqlStatements,
  resultToCsv,
  resultToTsv,
  resultToJson,
  fmtElapsed,
  pushQueryHistory,
  quoteIdent,
  qualifiedName,
  sqlLiteral,
  loadSavedQueries,
  persistSavedQueries,
  loadQueryHistory,
  SAVED_QUERIES_KEY,
  QUERY_HISTORY_KEY,
} from "./sql";

describe("splitSqlStatements", () => {
  it("splits on top-level semicolons", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });
  it("ignores semicolons in single-quoted strings", () => {
    expect(splitSqlStatements("SELECT ';'")).toEqual(["SELECT ';'"]);
  });
  it("handles escaped single quotes ('')", () => {
    expect(splitSqlStatements("SELECT 'it''s ok'; SELECT 2")).toEqual(["SELECT 'it''s ok'", "SELECT 2"]);
  });
  it("ignores semicolons in line comments", () => {
    expect(splitSqlStatements("SELECT 1 -- a;b\nFROM t")).toEqual(["SELECT 1 -- a;b\nFROM t"]);
  });
  it("ignores semicolons in block comments", () => {
    expect(splitSqlStatements("/* a; b */ SELECT 1")).toEqual(["/* a; b */ SELECT 1"]);
  });
  it("ignores semicolons in backtick / double-quote identifiers", () => {
    expect(splitSqlStatements("SELECT `c;1` FROM t; SELECT 2")).toEqual(["SELECT `c;1` FROM t", "SELECT 2"]);
    expect(splitSqlStatements('SELECT "a;b"')).toEqual(['SELECT "a;b"']);
  });
  it("handles doubled backticks (escaped backtick inside identifier) without mis-splitting", () => {
    // MySQL 以 `` 表示識別字內的字面反引號；其後的分號仍在識別字內，不應切分。
    expect(splitSqlStatements("SELECT `a``b;c` FROM t; SELECT 2")).toEqual([
      "SELECT `a``b;c` FROM t",
      "SELECT 2",
    ]);
  });
  it("skips empty statements", () => {
    expect(splitSqlStatements("  ; ; SELECT 1 ;")).toEqual(["SELECT 1"]);
  });
  it("ignores semicolons inside PostgreSQL dollar-quoted bodies ($$ and $tag$)", () => {
    const fn =
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN UPDATE t SET x=1; DELETE FROM u; END; $$ LANGUAGE plpgsql; SELECT 1";
    expect(splitSqlStatements(fn)).toEqual([
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN UPDATE t SET x=1; DELETE FROM u; END; $$ LANGUAGE plpgsql",
      "SELECT 1",
    ]);
    expect(splitSqlStatements("DO $tag$ BEGIN; PERFORM 1; END $tag$; SELECT 2")).toEqual([
      "DO $tag$ BEGIN; PERFORM 1; END $tag$",
      "SELECT 2",
    ]);
  });
  it("does not mistake $1 placeholders for dollar-quotes", () => {
    expect(splitSqlStatements("SELECT $1; SELECT $2")).toEqual(["SELECT $1", "SELECT $2"]);
  });
});

describe("result serialization", () => {
  const r = { columns: ["a", "b,c"], rows: [["x", 'y"z'], [null, "p\nq"]], rows_affected: 0 };
  it("CSV escapes commas / quotes / newlines / null", () => {
    expect(resultToCsv(r)).toBe('a,"b,c"\nx,"y""z"\n,"p\nq"');
  });
  it("CSV with no rows is just the header", () => {
    expect(resultToCsv({ columns: ["id"], rows: [], rows_affected: 0 })).toBe("id");
  });
  it("TSV joins by tab, null → empty", () => {
    expect(resultToTsv({ columns: ["a", "b"], rows: [["1", null]], rows_affected: 0 })).toBe("a\tb\n1\t");
  });
  it("JSON maps columns to values with null", () => {
    expect(JSON.parse(resultToJson({ columns: ["a", "b"], rows: [["1", null]], rows_affected: 0 }))).toEqual([
      { a: "1", b: null },
    ]);
  });
});

describe("fmtElapsed", () => {
  it("ms under 1s", () => expect(fmtElapsed(523)).toBe("523 ms"));
  it("seconds at/over 1s", () => expect(fmtElapsed(1500)).toBe("1.50 s"));
});

describe("pushQueryHistory", () => {
  it("dedupes to front", () => expect(pushQueryHistory(["b", "a"], "a")).toEqual(["a", "b"]));
  it("trims and skips empty", () => {
    expect(pushQueryHistory(["a"], "  ")).toEqual(["a"]);
    expect(pushQueryHistory([], "  x  ")).toEqual(["x"]);
  });
  it("caps at 50", () =>
    expect(pushQueryHistory(Array.from({ length: 50 }, (_, i) => "q" + i), "new").length).toBe(50));
});

describe("cross-DB quoting", () => {
  it("MySQL/SQLite use backticks (doubled inside)", () => {
    expect(quoteIdent("mysql", "t`x")).toBe("`t``x`");
    expect(quoteIdent("sqlite", "t")).toBe("`t`");
  });
  it("PostgreSQL uses double quotes (doubled inside)", () => {
    expect(quoteIdent("postgres", 'a"b')).toBe('"a""b"');
  });
  it("qualifiedName: SQLite unqualified, others db.table", () => {
    expect(qualifiedName("mysql", "db", "t")).toBe("`db`.`t`");
    expect(qualifiedName("postgres", "public", "t")).toBe('"public"."t"');
    expect(qualifiedName("sqlite", "main", "t")).toBe("`t`");
  });
  it("sqlLiteral: NULL passthrough + single-quote escaping", () => {
    expect(sqlLiteral("mysql", null)).toBe("NULL");
    expect(sqlLiteral("mysql", "O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral("postgres", "x")).toBe("'x'");
  });
  it("sqlLiteral: MySQL escapes backslash; PostgreSQL/SQLite keep it literal", () => {
    // MySQL 預設把 \ 當轉義字元 → 需加倍，否則 'a\b' 的 \b 會被當退格。
    expect(sqlLiteral("mysql", "a\\b")).toBe("'a\\\\b'");
    // PostgreSQL（standard_conforming_strings）與 SQLite 視 \ 為字面 → 不可加倍。
    expect(sqlLiteral("postgres", "a\\b")).toBe("'a\\b'");
    expect(sqlLiteral("sqlite", "a\\b")).toBe("'a\\b'");
    // 反斜線後接單引號：MySQL 需各自轉義。
    expect(sqlLiteral("mysql", "\\'")).toBe("'\\\\'''");
  });
});

// node 測試環境無 localStorage，提供最小記憶體實作供持久化守衛測試。
const __mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in __mem ? __mem[k] : null),
  setItem: (k: string, v: string) => { __mem[k] = String(v); },
  removeItem: (k: string) => { delete __mem[k]; },
  clear: () => { for (const k of Object.keys(__mem)) delete __mem[k]; },
  key: () => null,
  length: 0,
} as unknown as Storage;

describe("localStorage persistence guards", () => {
  it("saved queries: round-trips valid, filters corrupt entries & non-JSON", () => {
    localStorage.removeItem(SAVED_QUERIES_KEY);
    persistSavedQueries([{ name: "a", sql: "SELECT 1" }, { name: "b", sql: "SELECT 2" }]);
    expect(loadSavedQueries()).toEqual([{ name: "a", sql: "SELECT 1" }, { name: "b", sql: "SELECT 2" }]);
    // 損壞項（缺欄位 / 型別錯 / 非物件 / null）應被過濾，只保留合法項。
    localStorage.setItem(
      SAVED_QUERIES_KEY,
      JSON.stringify([{ name: "ok", sql: "x" }, { name: 1 }, { sql: "y" }, "bad", null]),
    );
    expect(loadSavedQueries()).toEqual([{ name: "ok", sql: "x" }]);
    // 非 JSON → 回空陣列（不丟例外）。
    localStorage.setItem(SAVED_QUERIES_KEY, "{not json");
    expect(loadSavedQueries()).toEqual([]);
  });

  it("query history: keeps only strings, tolerates corrupt storage", () => {
    localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(["a", 1, "b", null, { x: 1 }]));
    expect(loadQueryHistory()).toEqual(["a", "b"]);
    localStorage.setItem(QUERY_HISTORY_KEY, "not json");
    expect(loadQueryHistory()).toEqual([]);
  });
});
