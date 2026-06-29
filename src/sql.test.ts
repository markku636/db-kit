import { describe, it, expect } from "vitest";
import {
  splitSqlStatements,
  splitSqlStatementsWithRanges,
  statementAtOffset,
  hasExecutableSql,
  buildUseDatabase,
  parseClipboardGrid,
  rectToTsv,
  rangeStats,
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
  buildCreateTable,
  buildDropTable,
  buildDropView,
  buildTruncateTable,
  buildRenameTable,
  buildDuplicateTable,
  buildInsertAllRows,
  buildDeleteAllRows,
  buildInsertValues,
  buildGrantTemplate,
  buildCreateView,
  viewDefinitionSql,
  buildReplaceView,
  buildRoutineCall,
  buildTableMaintenance,
  tableOptionsSql,
  buildAlterTableOptions,
  buildConvertCharset,
  databaseOptionsSql,
  buildAlterDatabaseCharset,
  tableSizesSql,
  diffNameLists,
  diffColumns,
  buildAddColumnsDdl,
  buildModifyColumnsDdl,
  buildAddForeignKey,
  buildRenameIndex,
  buildCreateFulltextIndex,
  buildDropForeignKey,
  buildRowUpdate,
  buildRowDelete,
  formatSql,
  resultToMarkdown,
  isSystemDatabase,
  isDangerousStatement,
  mysqlAccount,
  buildCreateUser,
  buildDropUser,
  buildAlterUserPassword,
  buildSetUserLock,
  buildAlterUserLimits,
  buildAlterUserSsl,
  showGrantsSql,
  grantScope,
  buildGrant,
  buildRevoke,
  buildDropRoutine,
  userListSql,
  isDangerousRedisCommand,
  lintSqlStructure,
  type NewColumn,
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
  it("drops comment-only fragments (trailing / standalone comments)", () => {
    // 尾端的 `-- 11` 不是可執行語句，過去會被當成一條空查詢送 DB 而報錯。
    expect(splitSqlStatements("SELECT 1;\n-- 11")).toEqual(["SELECT 1"]);
    expect(splitSqlStatements("SELECT 1; /* note */")).toEqual(["SELECT 1"]);
    expect(splitSqlStatements("-- only a comment")).toEqual([]);
    expect(splitSqlStatements("/* block only */\n\n")).toEqual([]);
    // 但語句內含的尾端註解要保留（仍是可執行語句的一部分）。
    expect(splitSqlStatements("SELECT 1 -- c\n;")).toEqual(["SELECT 1 -- c"]);
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

describe("splitSqlStatementsWithRanges / statementAtOffset", () => {
  it("returns trimmed text with correct offsets", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const spans = splitSqlStatementsWithRanges(sql);
    expect(spans.map((s) => s.text)).toEqual(["SELECT 1", "SELECT 2"]);
    expect(spans[0]).toMatchObject({ from: 0, to: 8 });
    // 第二條從換行後的 'S' 起算。
    expect(sql.slice(spans[1].from, spans[1].to)).toBe("SELECT 2");
  });
  it("does not split on semicolons inside strings/comments/dollar-quotes", () => {
    expect(splitSqlStatementsWithRanges("SELECT ';'; SELECT 2").map((s) => s.text)).toEqual([
      "SELECT ';'",
      "SELECT 2",
    ]);
    expect(
      splitSqlStatementsWithRanges("DO $t$ BEGIN; END $t$; SELECT 2").map((s) => s.text)
    ).toEqual(["DO $t$ BEGIN; END $t$", "SELECT 2"]);
  });
  it("finds the statement under the cursor offset", () => {
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3";
    expect(statementAtOffset(sql, 3)).toBe("SELECT 1"); // 第一條中間
    expect(statementAtOffset(sql, 13)).toBe("SELECT 2"); // 第二條中間
    expect(statementAtOffset(sql, sql.length)).toBe("SELECT 3"); // 結尾
  });
  it("attributes cursor in inter-statement whitespace to the following statement", () => {
    const sql = "SELECT 1;\n\nSELECT 2";
    // 位移 10 在兩條語句之間的空白，應歸後一條。
    expect(statementAtOffset(sql, 10)).toBe("SELECT 2");
  });
  it("returns null for empty / whitespace-only input", () => {
    expect(statementAtOffset("   \n  ", 2)).toBeNull();
  });
  it("skips comment-only spans so the cursor lands on a real statement", () => {
    const sql = "SELECT 1;\nSELECT 2;\n-- trailing note";
    // 尾端的純註解片段被濾掉，不成為一條語句。
    expect(splitSqlStatementsWithRanges(sql).map((s) => s.text)).toEqual(["SELECT 1", "SELECT 2"]);
    // 游標停在尾端註解 → 落到最後一條真正可執行的語句。
    expect(statementAtOffset(sql, sql.length - 1)).toBe("SELECT 2");
    // 整段只有註解 → 無可執行語句。
    expect(statementAtOffset("-- nothing to run", 3)).toBeNull();
  });
});

describe("hasExecutableSql", () => {
  it("is true when non-comment SQL remains, false for blank / comment-only", () => {
    expect(hasExecutableSql("SELECT 1")).toBe(true);
    expect(hasExecutableSql("SELECT 1 -- trailing")).toBe(true);
    expect(hasExecutableSql("-- 11")).toBe(false);
    expect(hasExecutableSql("/* block */")).toBe(false);
    expect(hasExecutableSql("   \n  ")).toBe(false);
    // 字串內的 -- 不算註解，仍是可執行內容。
    expect(hasExecutableSql("SELECT '-- not a comment'")).toBe(true);
  });
});

describe("buildUseDatabase", () => {
  it("builds USE for mysql / external and SET search_path for postgres", () => {
    expect(buildUseDatabase("mysql", "Siebog")).toBe("USE `Siebog`");
    expect(buildUseDatabase("external", "Siebog")).toBe("USE `Siebog`");
    expect(buildUseDatabase("postgres", "public")).toBe('SET search_path TO "public"');
  });
  it("escapes identifiers and returns null when not applicable", () => {
    expect(buildUseDatabase("mysql", "we`ird")).toBe("USE `we``ird`");
    expect(buildUseDatabase("mysql", "")).toBeNull();
    expect(buildUseDatabase("sqlite", "x")).toBeNull();
    expect(buildUseDatabase("mongo", "x")).toBeNull();
  });
});

describe("buildDropRoutine", () => {
  const base = { name: "do_thing", routine_type: "procedure", parent: null, signature: null };
  it("MySQL: procedure / function / event / trigger keywords (qualified, IF EXISTS)", () => {
    expect(buildDropRoutine("mysql", "app", { ...base, routine_type: "procedure" })).toBe("DROP PROCEDURE IF EXISTS `app`.`do_thing`");
    expect(buildDropRoutine("mysql", "app", { ...base, routine_type: "function" })).toBe("DROP FUNCTION IF EXISTS `app`.`do_thing`");
    expect(buildDropRoutine("mysql", "app", { ...base, routine_type: "event" })).toBe("DROP EVENT IF EXISTS `app`.`do_thing`");
    expect(buildDropRoutine("mysql", "app", { ...base, routine_type: "trigger" })).toBe("DROP TRIGGER IF EXISTS `app`.`do_thing`");
  });
  it("PostgreSQL: function/procedure carry the arg signature; trigger drops ON its parent table", () => {
    expect(buildDropRoutine("postgres", "public", { ...base, routine_type: "function", signature: "integer, text" }))
      .toBe('DROP FUNCTION IF EXISTS "public"."do_thing"(integer, text)');
    expect(buildDropRoutine("postgres", "public", { ...base, routine_type: "procedure", signature: "" }))
      .toBe('DROP PROCEDURE IF EXISTS "public"."do_thing"()');
    expect(buildDropRoutine("postgres", "public", { name: "trg", routine_type: "trigger", parent: "users", signature: null }))
      .toBe('DROP TRIGGER IF EXISTS "trg" ON "public"."users"');
  });
  it("SQLite: only triggers exist; no schema qualifier", () => {
    expect(buildDropRoutine("sqlite", "main", { name: "trg", routine_type: "trigger", parent: null, signature: null }))
      .toBe("DROP TRIGGER IF EXISTS `trg`");
  });
});

describe("userListSql", () => {
  it("selects the expected MySQL user columns and ordering", () => {
    const s = userListSql();
    expect(s).toContain("FROM mysql.user");
    expect(s).toContain("account_locked");
    expect(s).toContain("max_user_connections");
    expect(s).toContain("ORDER BY User, Host");
  });
});

describe("rangeStats", () => {
  it("counts total cells, numeric cells, and sums/averages numbers", () => {
    const s = rangeStats(["10", "20", "30", "x", null, ""]);
    expect(s.count).toBe(6);
    expect(s.numCount).toBe(3);
    expect(s.sum).toBe(60);
    expect(s.avg).toBe(20);
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
  });
  it("strips thousands separators and handles decimals/negatives", () => {
    const s = rangeStats(["1,000", "-2.5", "3.5"]);
    expect(s.sum).toBe(1001);
    expect(s.min).toBe(-2.5);
    expect(s.max).toBe(1000);
  });
  it("no numeric cells → zeros (no Infinity leakage)", () => {
    const s = rangeStats(["a", null, "  "]);
    expect(s).toEqual({ count: 3, numCount: 0, sum: 0, avg: 0, min: 0, max: 0 });
  });
});

describe("rectToTsv", () => {
  const grid = [
    ["a1", "b1", "c1"],
    ["a2", null, "c2"],
    ["a3", "b3", "c3"],
  ];
  const get = (r: number, c: number) => grid[r][c];
  it("extracts a rectangle as TSV (rows × cols), NULL → empty", () => {
    expect(rectToTsv(get, [0, 1], [0, 1])).toBe("a1\tb1\na2\t");
    expect(rectToTsv(get, [1, 2], [1, 2])).toBe("\tc2\nb3\tc3");
  });
  it("respects the given column order (e.g. skipping a hidden middle column)", () => {
    expect(rectToTsv(get, [0, 2], [0, 2])).toBe("a1\tc1\na3\tc3");
  });
  it("single cell → just that value", () => {
    expect(rectToTsv(get, [2], [1])).toBe("b3");
  });
});

describe("parseClipboardGrid", () => {
  it("parses a TSV block into a 2D array", () => {
    expect(parseClipboardGrid("a\tb\tc\n1\t2\t3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });
  it("treats plain text as 1x1", () => {
    expect(parseClipboardGrid("hello")).toEqual([["hello"]]);
  });
  it("strips a single trailing newline (CRLF or LF) without dropping interior blanks", () => {
    expect(parseClipboardGrid("a\tb\r\n1\t2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    // 內部空白格保留。
    expect(parseClipboardGrid("a\t\tc")).toEqual([["a", "", "c"]]);
  });
});

describe("lintSqlStructure", () => {
  it("passes clean procedural SQL (no false positives on BEGIN…END)", () => {
    const sp = "CREATE PROCEDURE p(IN a INT)\nBEGIN\n  IF a > 0 THEN SELECT a; END IF;\nEND";
    expect(lintSqlStructure(sp)).toEqual([]);
  });
  it("flags an unmatched opening paren", () => {
    const marks = lintSqlStructure("SELECT foo(a, b");
    expect(marks).toHaveLength(1);
    expect(marks[0].message).toContain("未配對的左括號");
  });
  it("flags a surplus closing paren", () => {
    const marks = lintSqlStructure("SELECT a)");
    expect(marks).toHaveLength(1);
    expect(marks[0].message).toContain("多餘的右括號");
  });
  it("flags an unterminated string", () => {
    const marks = lintSqlStructure("SELECT 'abc");
    expect(marks).toHaveLength(1);
    expect(marks[0].message).toContain("未結束的字串");
  });
  it("ignores parens / quotes inside strings, comments and dollar-quotes", () => {
    expect(lintSqlStructure("SELECT ')(' , `c)x`")).toEqual([]);
    expect(lintSqlStructure("SELECT 1 /* ( ( */ -- )\nFROM t")).toEqual([]);
    expect(lintSqlStructure("AS $$ BEGIN x := ')'; END $$")).toEqual([]);
  });
  it("flags an unterminated block comment and dollar-quote", () => {
    expect(lintSqlStructure("SELECT 1 /* open").map((m) => m.message)).toContain("未結束的區塊註解 /* */");
    expect(lintSqlStructure("AS $$ BEGIN")[0].message).toContain("未結束的 $$ 區塊");
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

describe("buildCreateTable", () => {
  const cols = (arr: Partial<NewColumn>[]): NewColumn[] =>
    arr.map((c) => ({ name: "", type: "", notNull: false, pk: false, unique: false, default: "", ...c }));

  it("PostgreSQL: PK + NOT NULL + DEFAULT, double-quote idents", () => {
    const sql = buildCreateTable("postgres", "public", "users", cols([
      { name: "id", type: "SERIAL", pk: true, notNull: true },
      { name: "name", type: "VARCHAR(50)", notNull: true },
      { name: "age", type: "INT", default: "0" },
    ]));
    expect(sql).toBe(
      'CREATE TABLE "public"."users" (\n' +
        '  "id" SERIAL NOT NULL,\n' +
        '  "name" VARCHAR(50) NOT NULL,\n' +
        '  "age" INT DEFAULT 0,\n' +
        '  PRIMARY KEY ("id")\n' +
        ");",
    );
  });

  it("MySQL: backtick idents + composite PK + UNIQUE", () => {
    const sql = buildCreateTable("mysql", "testdb", "t", cols([
      { name: "a", type: "INT", pk: true },
      { name: "b", type: "INT", pk: true },
      { name: "email", type: "VARCHAR(100)", unique: true },
    ]));
    expect(sql).toBe(
      "CREATE TABLE `testdb`.`t` (\n" +
        "  `a` INT,\n" +
        "  `b` INT,\n" +
        "  `email` VARCHAR(100) UNIQUE,\n" +
        "  PRIMARY KEY (`a`, `b`)\n" +
        ");",
    );
  });

  it("SQLite: no db prefix; filters columns missing name or type", () => {
    const sql = buildCreateTable("sqlite", "main", "t", cols([
      { name: "id", type: "INTEGER", pk: true },
      { name: "", type: "TEXT" },
      { name: "v", type: "" },
    ]));
    expect(sql).toBe("CREATE TABLE `t` (\n  `id` INTEGER,\n  PRIMARY KEY (`id`)\n);");
  });

  it("PK column does not also emit UNIQUE (PK already unique)", () => {
    const sql = buildCreateTable("postgres", "public", "t", cols([
      { name: "id", type: "INT", pk: true, unique: true },
    ]));
    expect(sql).not.toContain("UNIQUE");
  });
});

describe("table/database lifecycle DDL", () => {
  it("buildDropTable qualifies per kind", () => {
    expect(buildDropTable("postgres", "public", "t")).toBe('DROP TABLE "public"."t";');
    expect(buildDropTable("mysql", "db", "t")).toBe("DROP TABLE `db`.`t`;");
    expect(buildDropTable("sqlite", "main", "t")).toBe("DROP TABLE `t`;");
  });

  it("buildTruncateTable: SQLite falls back to DELETE FROM", () => {
    expect(buildTruncateTable("postgres", "public", "t")).toBe('TRUNCATE TABLE "public"."t";');
    expect(buildTruncateTable("mysql", "db", "t")).toBe("TRUNCATE TABLE `db`.`t`;");
    expect(buildTruncateTable("sqlite", "main", "t")).toBe("DELETE FROM `t`;");
  });

  it("buildRenameTable: MySQL RENAME TABLE, others ALTER … RENAME TO", () => {
    expect(buildRenameTable("mysql", "db", "old", "new")).toBe("RENAME TABLE `db`.`old` TO `db`.`new`;");
    expect(buildRenameTable("postgres", "public", "old", "new")).toBe('ALTER TABLE "public"."old" RENAME TO "new";');
    expect(buildRenameTable("sqlite", "main", "old", "new")).toBe("ALTER TABLE `old` RENAME TO `new`;");
  });

  it("buildDropView uses DROP VIEW (not DROP TABLE) and qualifies", () => {
    expect(buildDropView("postgres", "public", "v")).toBe('DROP VIEW "public"."v";');
    expect(buildDropView("mysql", "db", "v")).toBe("DROP VIEW `db`.`v`;");
  });

  it("buildDuplicateTable: per-kind LIKE / INCLUDING ALL / AS SELECT", () => {
    expect(buildDuplicateTable("mysql", "db", "t", "t_copy")).toBe("CREATE TABLE `db`.`t_copy` LIKE `db`.`t`;");
    expect(buildDuplicateTable("postgres", "public", "t", "t_copy")).toBe(
      'CREATE TABLE "public"."t_copy" (LIKE "public"."t" INCLUDING ALL);',
    );
    expect(buildDuplicateTable("sqlite", "main", "t", "t_copy")).toBe(
      "CREATE TABLE `t_copy` AS SELECT * FROM `t` WHERE 0;",
    );
  });

  it("buildInsertAllRows: INSERT INTO dst SELECT * FROM src", () => {
    expect(buildInsertAllRows("mysql", "db", "t", "t_copy")).toBe("INSERT INTO `db`.`t_copy` SELECT * FROM `db`.`t`;");
    expect(buildInsertAllRows("postgres", "public", "t", "t_copy")).toBe('INSERT INTO "public"."t_copy" SELECT * FROM "public"."t";');
  });

  it("buildDeleteAllRows: DELETE FROM qualified per kind", () => {
    expect(buildDeleteAllRows("mysql", "db", "t")).toBe("DELETE FROM `db`.`t`;");
    expect(buildDeleteAllRows("postgres", "public", "t")).toBe('DELETE FROM "public"."t";');
    expect(buildDeleteAllRows("sqlite", "main", "t")).toBe("DELETE FROM `t`;");
  });

  it("buildInsertValues: dialect-aware identifier + literal quoting, NULL passthrough", () => {
    const cols = ["id", "name"];
    const rows = [["1", "O'Brien"], ["2", null]];
    expect(buildInsertValues("mysql", "db", "t", cols, rows)).toBe(
      "INSERT INTO `db`.`t` (`id`, `name`) VALUES ('1', 'O''Brien');\n" +
      "INSERT INTO `db`.`t` (`id`, `name`) VALUES ('2', NULL);",
    );
    // PostgreSQL：雙引號識別字、反斜線不加倍（standard_conforming_strings）。
    expect(buildInsertValues("postgres", "public", "t", ["c"], [["a\\b"]])).toBe(
      `INSERT INTO "public"."t" ("c") VALUES ('a\\b');`,
    );
    // MySQL：反斜線需加倍。
    expect(buildInsertValues("mysql", "db", "t", ["c"], [["a\\b"]])).toBe(
      "INSERT INTO `db`.`t` (`c`) VALUES ('a\\\\b');",
    );
  });

  it("buildGrantTemplate: MySQL / PostgreSQL templates, SQLite n/a", () => {
    const my = buildGrantTemplate("mysql", "db", "t");
    expect(my).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON `db`.`t` TO 'user'@'%';");
    expect(my).toContain("FLUSH PRIVILEGES;");
    const pg = buildGrantTemplate("postgres", "public", "t");
    expect(pg).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."t" TO <role>;');
    expect(pg).not.toContain("FLUSH PRIVILEGES");
  });

  it("buildCreateView qualifies the name and trims the SELECT", () => {
    expect(buildCreateView("postgres", "public", "v ", " SELECT 1 ")).toBe('CREATE VIEW "public"."v" AS\nSELECT 1;');
    expect(buildCreateView("mysql", "db", "v", "SELECT * FROM t")).toBe("CREATE VIEW `db`.`v` AS\nSELECT * FROM t;");
  });

  it("viewDefinitionSql: MySQL information_schema, PG pg_get_viewdef (escaped)", () => {
    expect(viewDefinitionSql("mysql", "db", "v")).toBe(
      "SELECT VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = 'db' AND TABLE_NAME = 'v'",
    );
    expect(viewDefinitionSql("postgres", "public", "v")).toBe(
      `SELECT pg_get_viewdef('"public"."v"'::regclass, true) AS def`,
    );
  });

  it("buildReplaceView uses CREATE OR REPLACE VIEW and qualifies", () => {
    expect(buildReplaceView("mysql", "db", "v", "SELECT 1")).toBe("CREATE OR REPLACE VIEW `db`.`v` AS\nSELECT 1;");
    expect(buildReplaceView("postgres", "public", "v ", " SELECT 2 ")).toBe('CREATE OR REPLACE VIEW "public"."v" AS\nSELECT 2;');
  });

  it("tableOptionsSql: information_schema.TABLES for engine/comment/auto_increment/collation", () => {
    expect(tableOptionsSql("db", "t")).toBe(
      "SELECT ENGINE, TABLE_COMMENT, AUTO_INCREMENT, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'db' AND TABLE_NAME = 't'",
    );
  });
  it("buildConvertCharset: CONVERT TO CHARACTER SET (+ optional COLLATE)", () => {
    expect(buildConvertCharset("db", "t", "utf8mb4", "")).toBe("ALTER TABLE `db`.`t` CONVERT TO CHARACTER SET utf8mb4");
    expect(buildConvertCharset("db", "t", "utf8mb4", "utf8mb4_unicode_ci")).toBe(
      "ALTER TABLE `db`.`t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
    );
  });
  it("databaseOptionsSql / buildAlterDatabaseCharset", () => {
    expect(databaseOptionsSql("shop")).toBe(
      "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'shop'",
    );
    expect(buildAlterDatabaseCharset("shop", "utf8mb4", "")).toBe("ALTER DATABASE `shop` CHARACTER SET utf8mb4");
    expect(buildAlterDatabaseCharset("shop", "utf8mb4", "utf8mb4_general_ci")).toBe(
      "ALTER DATABASE `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci",
    );
  });
  it("diffNameLists: only-in-source / only-in-target / common (sorted, deduped)", () => {
    expect(diffNameLists(["a", "b", "c"], ["b", "c", "d"])).toEqual({
      onlyInSource: ["a"], onlyInTarget: ["d"], common: ["b", "c"],
    });
    expect(diffNameLists(["x", "x"], [])).toEqual({ onlyInSource: ["x"], onlyInTarget: [], common: [] });
  });
  it("diffColumns: added / removed / changed (type or nullability)", () => {
    const src = [
      { name: "id", data_type: "int", nullable: false },
      { name: "name", data_type: "varchar(50)", nullable: true },
      { name: "extra", data_type: "text", nullable: true },
    ];
    const tgt = [
      { name: "id", data_type: "int", nullable: false },
      { name: "name", data_type: "varchar(100)", nullable: false },
      { name: "old", data_type: "int", nullable: true },
    ];
    expect(diffColumns(src, tgt)).toEqual({
      added: ["extra"],
      removed: ["old"],
      changed: [{ name: "name", source: "varchar(50) NULL", target: "varchar(100) NOT NULL" }],
    });
  });

  it("buildAddColumnsDdl: ALTER ADD COLUMN per column (type + nullability)", () => {
    expect(buildAddColumnsDdl("mysql", "db", "t", [
      { name: "a", data_type: "int", nullable: false },
      { name: "b", data_type: "varchar(50)", nullable: true },
    ])).toBe(
      "ALTER TABLE `db`.`t` ADD COLUMN `a` int NOT NULL;\nALTER TABLE `db`.`t` ADD COLUMN `b` varchar(50);",
    );
  });

  it("buildModifyColumnsDdl: MySQL MODIFY COLUMN, PG ALTER COLUMN TYPE + nullability", () => {
    expect(buildModifyColumnsDdl("mysql", "db", "t", [{ name: "a", data_type: "bigint", nullable: false }])).toBe(
      "ALTER TABLE `db`.`t` MODIFY COLUMN `a` bigint NOT NULL;",
    );
    expect(buildModifyColumnsDdl("postgres", "public", "t", [{ name: "a", data_type: "bigint", nullable: true }])).toBe(
      'ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE bigint USING "a"::bigint, ALTER COLUMN "a" DROP NOT NULL;',
    );
  });

  it("tableSizesSql: escapes schema, base tables only, ordered by size", () => {
    const s = tableSizesSql("shop");
    expect(s).toContain("FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'shop' AND TABLE_TYPE = 'BASE TABLE'");
    expect(s).toContain("ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC");
    expect(s).toContain("total_mb");
  });
  it("buildAlterTableOptions: combines changed parts; null when none", () => {
    expect(buildAlterTableOptions("db", "t", { engine: "InnoDB" })).toBe("ALTER TABLE `db`.`t` ENGINE = InnoDB");
    expect(buildAlterTableOptions("db", "t", { comment: "hi" })).toBe("ALTER TABLE `db`.`t` COMMENT = 'hi'");
    expect(buildAlterTableOptions("db", "t", { autoIncrement: 100 })).toBe("ALTER TABLE `db`.`t` AUTO_INCREMENT = 100");
    expect(buildAlterTableOptions("db", "t", { engine: "MyISAM", comment: "x", autoIncrement: 5 })).toBe(
      "ALTER TABLE `db`.`t` ENGINE = MyISAM, COMMENT = 'x', AUTO_INCREMENT = 5",
    );
    // 空註解（清除）仍會輸出 COMMENT = ''；註解含單引號跳脫；無變動回 null。
    expect(buildAlterTableOptions("db", "t", { comment: "" })).toBe("ALTER TABLE `db`.`t` COMMENT = ''");
    expect(buildAlterTableOptions("db", "t", { comment: "a'b" })).toBe("ALTER TABLE `db`.`t` COMMENT = 'a''b'");
    expect(buildAlterTableOptions("db", "t", {})).toBeNull();
  });

  it("buildTableMaintenance: <OP> TABLE `db`.`t`", () => {
    expect(buildTableMaintenance("ANALYZE", "db", "t")).toBe("ANALYZE TABLE `db`.`t`");
    expect(buildTableMaintenance("OPTIMIZE", "db", "t")).toBe("OPTIMIZE TABLE `db`.`t`");
    expect(buildTableMaintenance("CHECK", "shop", "orders")).toBe("CHECK TABLE `shop`.`orders`");
    expect(buildTableMaintenance("REPAIR", "db", "t")).toBe("REPAIR TABLE `db`.`t`");
  });

  it("buildRoutineCall: function via SELECT, procedure via CALL, per-kind", () => {
    expect(buildRoutineCall("mysql", "db", "fn", "function", "1, 2")).toBe("SELECT `db`.`fn`(1, 2) AS result");
    expect(buildRoutineCall("mysql", "db", "p", "procedure", "'x'")).toBe("CALL `db`.`p`('x')");
    expect(buildRoutineCall("postgres", "public", "fn", "function", "")).toBe('SELECT * FROM "public"."fn"()');
    expect(buildRoutineCall("postgres", "public", "p", "procedure", "3")).toBe('CALL "public"."p"(3)');
  });

  it("buildAddForeignKey: ALTER ADD CONSTRAINT … FOREIGN KEY … REFERENCES", () => {
    expect(buildAddForeignKey("mysql", "db", "orders", "fk_o_u", "user_id", "users", "id")).toBe(
      "ALTER TABLE `db`.`orders` ADD CONSTRAINT `fk_o_u` FOREIGN KEY (`user_id`) REFERENCES `db`.`users` (`id`);",
    );
    expect(buildAddForeignKey("postgres", "public", "orders", "fk_o_u", "user_id", "users", "id")).toBe(
      'ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_o_u" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id");',
    );
    // 參照動作：ON DELETE / ON UPDATE 子句（留空則不輸出）。
    expect(buildAddForeignKey("mysql", "db", "orders", "fk_o_u", "user_id", "users", "id", "CASCADE", "SET NULL")).toBe(
      "ALTER TABLE `db`.`orders` ADD CONSTRAINT `fk_o_u` FOREIGN KEY (`user_id`) REFERENCES `db`.`users` (`id`) ON DELETE CASCADE ON UPDATE SET NULL;",
    );
    expect(buildAddForeignKey("mysql", "db", "orders", "fk_o_u", "user_id", "users", "id", "", "CASCADE")).toBe(
      "ALTER TABLE `db`.`orders` ADD CONSTRAINT `fk_o_u` FOREIGN KEY (`user_id`) REFERENCES `db`.`users` (`id`) ON UPDATE CASCADE;",
    );
  });

  it("buildCreateFulltextIndex: CREATE FULLTEXT INDEX with composite columns", () => {
    expect(buildCreateFulltextIndex("db", "articles", "ft_body", ["title", "body"])).toBe(
      "CREATE FULLTEXT INDEX `ft_body` ON `db`.`articles` (`title`, `body`)",
    );
  });

  it("buildRenameIndex: MySQL ALTER TABLE RENAME INDEX, PG ALTER INDEX", () => {
    expect(buildRenameIndex("mysql", "db", "t", "ix_old", "ix_new")).toBe(
      "ALTER TABLE `db`.`t` RENAME INDEX `ix_old` TO `ix_new`;",
    );
    expect(buildRenameIndex("postgres", "public", "t", "ix_old", "ix_new")).toBe(
      'ALTER INDEX "public"."ix_old" RENAME TO "ix_new";',
    );
  });

  it("buildDropForeignKey: MySQL DROP FOREIGN KEY, PG DROP CONSTRAINT", () => {
    expect(buildDropForeignKey("mysql", "db", "orders", "fk_o_u")).toBe("ALTER TABLE `db`.`orders` DROP FOREIGN KEY `fk_o_u`;");
    expect(buildDropForeignKey("postgres", "public", "orders", "fk_o_u")).toBe('ALTER TABLE "public"."orders" DROP CONSTRAINT "fk_o_u";');
  });

  it("buildRowUpdate / buildRowDelete: quoted idents, escaped values, PK WHERE", () => {
    expect(buildRowUpdate("mysql", "t", ["a", "b"], ["1", "x'y"], ["id"], ["5"])).toBe(
      "UPDATE `t` SET `a` = '1', `b` = 'x''y' WHERE `id` = '5';",
    );
    expect(buildRowDelete("postgres", "t", ["id"], ["5"])).toBe('DELETE FROM "t" WHERE "id" = \'5\';');
    // 複合主鍵以 AND 串接；NULL 值以 NULL 呈現。
    expect(buildRowDelete("mysql", "t", ["a", "b"], ["1", null])).toBe("DELETE FROM `t` WHERE `a` = '1' AND `b` = NULL;");
  });
});

describe("formatSql", () => {
  it("breaks before major clauses; indents AND/OR/ON", () => {
    expect(formatSql("select a, b from t where x = 1 and y = 2 order by a")).toBe(
      "select a, b\nfrom t\nwhere x = 1\n  and y = 2\norder by a",
    );
  });
  it("keeps multi-word clauses together (group by / left join), no double break", () => {
    expect(formatSql("select a from x left join y on x.id = y.xid group by a")).toBe(
      "select a\nfrom x\nleft join y\n  on x.id = y.xid\ngroup by a",
    );
  });
  it("never reformats inside string literals or comments (semantics-safe)", () => {
    // 'from where' 為字串字面值，不可被換行；-- 註解原樣保留。
    expect(formatSql("select 'from where and x' as c from t")).toBe("select 'from where and x' as c\nfrom t");
    expect(formatSql("select 1 -- from where\nfrom t")).toBe("select 1 -- from where\nfrom t");
  });
  it("does not match keywords embedded in identifiers (from_date)", () => {
    expect(formatSql("select from_date from t")).toBe("select from_date\nfrom t");
  });
});

describe("resultToMarkdown", () => {
  it("renders a markdown table, escaping pipes and newlines", () => {
    const r = { columns: ["id", "name"], rows: [["1", "a|b"], ["2", "x\ny"]], rows_affected: 0 };
    expect(resultToMarkdown(r)).toBe("| id | name |\n| --- | --- |\n| 1 | a\\|b |\n| 2 | x y |");
  });
  it("empty columns → empty string", () => {
    expect(resultToMarkdown({ columns: [], rows: [], rows_affected: 0 })).toBe("");
  });
});

describe("isDangerousStatement", () => {
  it("flags UPDATE/DELETE without WHERE and TRUNCATE", () => {
    expect(isDangerousStatement("DELETE FROM t")).toBe(true);
    expect(isDangerousStatement("UPDATE t SET a = 1")).toBe(true);
    expect(isDangerousStatement("TRUNCATE TABLE t")).toBe(true);
  });
  it("allows statements with a real WHERE, and non-mutating statements", () => {
    expect(isDangerousStatement("DELETE FROM t WHERE id = 1")).toBe(false);
    expect(isDangerousStatement("UPDATE t SET a = 1 WHERE id = 2")).toBe(false);
    expect(isDangerousStatement("SELECT * FROM t")).toBe(false);
    expect(isDangerousStatement("INSERT INTO t VALUES (1)")).toBe(false);
  });
  it("does not count WHERE that appears only inside a string or comment", () => {
    expect(isDangerousStatement("UPDATE t SET name = 'where' ")).toBe(true);
    expect(isDangerousStatement("DELETE FROM t -- where id=1")).toBe(true);
  });
  it("flags UPDATE/DELETE whose only WHERE is inside a subquery (still affects all rows)", () => {
    // 子查詢內的 WHERE 不算頂層條件——這些語句其實會影響整張表。
    expect(isDangerousStatement("UPDATE t SET a = (SELECT MAX(b) FROM u WHERE u.x = 1)")).toBe(true);
    expect(isDangerousStatement("DELETE FROM t USING (SELECT id FROM u WHERE x=1) s")).toBe(true);
  });
  it("still allows a real top-level WHERE even with a subquery present", () => {
    expect(isDangerousStatement("DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x = 1)")).toBe(false);
    expect(isDangerousStatement("UPDATE t SET a = (SELECT 1) WHERE id = 2")).toBe(false);
    expect(isDangerousStatement("UPDATE t SET a = 1 WHERE id IN (1, 2, 3)")).toBe(false);
  });
});

describe("isDangerousRedisCommand", () => {
  it("flags FLUSHALL / FLUSHDB (case-insensitive, optional DB prefix)", () => {
    expect(isDangerousRedisCommand("FLUSHALL")).toBe(true);
    expect(isDangerousRedisCommand("flushdb")).toBe(true);
    expect(isDangerousRedisCommand("FLUSHALL ASYNC")).toBe(true);
    expect(isDangerousRedisCommand("1: FLUSHDB")).toBe(true);
  });
  it("does not flag safe / targeted commands", () => {
    expect(isDangerousRedisCommand("GET key")).toBe(false);
    expect(isDangerousRedisCommand("DEL user:1")).toBe(false);
    expect(isDangerousRedisCommand("SCAN 0")).toBe(false);
    // 不誤傷以 flush 開頭的鍵名（非指令）
    expect(isDangerousRedisCommand("GET flushall_count")).toBe(false);
  });
});

describe("isSystemDatabase", () => {
  it("PostgreSQL: pg_* and information_schema are system; public/user are not", () => {
    expect(isSystemDatabase("postgres", "pg_catalog")).toBe(true);
    expect(isSystemDatabase("postgres", "pg_toast")).toBe(true);
    expect(isSystemDatabase("postgres", "information_schema")).toBe(true);
    expect(isSystemDatabase("postgres", "public")).toBe(false);
    expect(isSystemDatabase("postgres", "app")).toBe(false);
    // pg_ 前綴比對大小寫敏感（與後端一致）：引號保留大小寫的使用者 schema 不算系統。
    expect(isSystemDatabase("postgres", "PG_data")).toBe(false);
  });
  it("MySQL: mysql/sys/performance_schema/information_schema are system (case-insensitive)", () => {
    expect(isSystemDatabase("mysql", "mysql")).toBe(true);
    expect(isSystemDatabase("mysql", "SYS")).toBe(true);
    expect(isSystemDatabase("mysql", "performance_schema")).toBe(true);
    expect(isSystemDatabase("mysql", "testdb")).toBe(false);
  });
  it("MongoDB: admin/config/local are system", () => {
    expect(isSystemDatabase("mongo", "admin")).toBe(true);
    expect(isSystemDatabase("mongo", "config")).toBe(true);
    expect(isSystemDatabase("mongo", "local")).toBe(true);
    expect(isSystemDatabase("mongo", "shop")).toBe(false);
  });
});

describe("MySQL user management DDL", () => {
  it("mysqlAccount quotes user and host as string literals, not identifiers", () => {
    expect(mysqlAccount("app", "%")).toBe("'app'@'%'");
    expect(mysqlAccount("localhost", "localhost")).toBe("'localhost'@'localhost'");
    // 單引號 / 反斜線需跳脫（防注入）。
    expect(mysqlAccount("o'brien", "10.0.0.1")).toBe("'o''brien'@'10.0.0.1'");
    expect(mysqlAccount("a\\b", "%")).toBe("'a\\\\b'@'%'");
  });
  it("buildCreateUser: with password emits IDENTIFIED BY; empty password omits it", () => {
    expect(buildCreateUser("app", "%", "p@ss")).toBe("CREATE USER 'app'@'%' IDENTIFIED BY 'p@ss'");
    expect(buildCreateUser("app", "localhost", "")).toBe("CREATE USER 'app'@'localhost'");
    // 密碼含單引號須跳脫。
    expect(buildCreateUser("u", "%", "a'b")).toBe("CREATE USER 'u'@'%' IDENTIFIED BY 'a''b'");
  });
  it("buildDropUser / buildAlterUserPassword / buildSetUserLock", () => {
    expect(buildDropUser("app", "%")).toBe("DROP USER 'app'@'%'");
    expect(buildAlterUserPassword("app", "%", "new")).toBe("ALTER USER 'app'@'%' IDENTIFIED BY 'new'");
    expect(buildSetUserLock("app", "%", true)).toBe("ALTER USER 'app'@'%' ACCOUNT LOCK");
    expect(buildSetUserLock("app", "%", false)).toBe("ALTER USER 'app'@'%' ACCOUNT UNLOCK");
  });
  it("showGrantsSql targets the account", () => {
    expect(showGrantsSql("app", "%")).toBe("SHOW GRANTS FOR 'app'@'%'");
  });
  it("buildAlterUserSsl: REQUIRE NONE/SSL/X509", () => {
    expect(buildAlterUserSsl("app", "%", "NONE")).toBe("ALTER USER 'app'@'%' REQUIRE NONE");
    expect(buildAlterUserSsl("app", "%", "SSL")).toBe("ALTER USER 'app'@'%' REQUIRE SSL");
    expect(buildAlterUserSsl("app", "%", "X509")).toBe("ALTER USER 'app'@'%' REQUIRE X509");
  });
  it("buildAlterUserLimits: WITH MAX_… clauses; floors/clamps; null when empty", () => {
    expect(buildAlterUserLimits("app", "%", { queries: 100, userConnections: 5 })).toBe(
      "ALTER USER 'app'@'%' WITH MAX_QUERIES_PER_HOUR 100 MAX_USER_CONNECTIONS 5",
    );
    expect(buildAlterUserLimits("app", "%", { queries: 0, updates: 0, connections: 0, userConnections: 0 })).toBe(
      "ALTER USER 'app'@'%' WITH MAX_QUERIES_PER_HOUR 0 MAX_UPDATES_PER_HOUR 0 MAX_CONNECTIONS_PER_HOUR 0 MAX_USER_CONNECTIONS 0",
    );
    expect(buildAlterUserLimits("app", "%", { queries: -5.7 })).toBe("ALTER USER 'app'@'%' WITH MAX_QUERIES_PER_HOUR 0");
    expect(buildAlterUserLimits("app", "%", {})).toBeNull();
  });
  it("grantScope: global / db-level / table-level (backtick-quoted idents)", () => {
    expect(grantScope(null, null)).toBe("*.*");
    expect(grantScope("shop", null)).toBe("`shop`.*");
    expect(grantScope("shop", "orders")).toBe("`shop`.`orders`");
    // 識別字內反引號加倍跳脫。
    expect(grantScope("a`b", null)).toBe("`a``b`.*");
  });
  it("buildGrant / buildRevoke: privileges verbatim, scope + account composed", () => {
    expect(buildGrant(["SELECT", "INSERT"], "`shop`.*", "app", "%")).toBe(
      "GRANT SELECT, INSERT ON `shop`.* TO 'app'@'%'",
    );
    expect(buildGrant(["ALL PRIVILEGES"], "*.*", "admin", "localhost")).toBe(
      "GRANT ALL PRIVILEGES ON *.* TO 'admin'@'localhost'",
    );
    expect(buildGrant(["SELECT"], "`shop`.*", "app", "%", true)).toBe(
      "GRANT SELECT ON `shop`.* TO 'app'@'%' WITH GRANT OPTION",
    );
    expect(buildRevoke(["DELETE"], "`shop`.`orders`", "app", "%")).toBe(
      "REVOKE DELETE ON `shop`.`orders` FROM 'app'@'%'",
    );
  });
});
