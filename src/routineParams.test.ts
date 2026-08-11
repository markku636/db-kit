import { describe, it, expect } from "vitest";
import {
  splitSignature,
  parseRoutineParams,
  isNumericType,
  routineArgLiteral,
  buildRoutineExecSql,
  formatSignature,
  outVarName,
} from "./routineParams";

describe("splitSignature", () => {
  it("splits on top-level commas only", () => {
    expect(splitSignature("IN a int, IN b varchar(10)")).toEqual(["IN a int", "IN b varchar(10)"]);
  });

  it("keeps commas inside type parentheses", () => {
    // 這是整個模組存在的理由：split(",") 會把 decimal(10,2) 剁成兩個假引數。
    expect(splitSignature("IN total decimal(10,2), IN note text")).toEqual([
      "IN total decimal(10,2)",
      "IN note text",
    ]);
  });

  it("keeps commas inside quoted enum values", () => {
    expect(splitSignature("IN s enum('a','b'), IN n int")).toEqual(["IN s enum('a','b')", "IN n int"]);
  });

  it("handles doubled quotes inside literals", () => {
    expect(splitSignature("IN s enum('it''s','b'), IN n int")).toEqual([
      "IN s enum('it''s','b')",
      "IN n int",
    ]);
  });

  it("returns empty for blank input", () => {
    expect(splitSignature("")).toEqual([]);
    expect(splitSignature("  ")).toEqual([]);
  });
});

describe("parseRoutineParams", () => {
  it("parses mysql mode/name/type triples", () => {
    expect(parseRoutineParams("mysql", "IN p_id int(11), OUT p_total decimal(10,2)")).toEqual([
      { mode: "IN", name: "p_id", type: "int(11)" },
      { mode: "OUT", name: "p_total", type: "decimal(10,2)" },
    ]);
  });

  it("handles multi-word types", () => {
    expect(parseRoutineParams("mysql", "IN n int unsigned")).toEqual([
      { mode: "IN", name: "n", type: "int unsigned" },
    ]);
  });

  it("treats missing mode as unspecified (mysql functions)", () => {
    expect(parseRoutineParams("mysql", "p1 int, p2 varchar(20)")).toEqual([
      { mode: "", name: "p1", type: "int" },
      { mode: "", name: "p2", type: "varchar(20)" },
    ]);
  });

  it("treats postgres signatures as type-only", () => {
    // pg_get_function_identity_arguments 給的是型別清單，照 MySQL 規則拆會把 integer 當成參數名。
    expect(parseRoutineParams("postgres", "integer, text")).toEqual([
      { mode: "", name: "", type: "integer" },
      { mode: "", name: "", type: "text" },
    ]);
    expect(parseRoutineParams("postgres", "timestamp without time zone")).toEqual([
      { mode: "", name: "", type: "timestamp without time zone" },
    ]);
  });

  it("returns empty for null / blank signature", () => {
    expect(parseRoutineParams("mysql", null)).toEqual([]);
    expect(parseRoutineParams("mysql", undefined)).toEqual([]);
    expect(parseRoutineParams("mysql", "")).toEqual([]);
  });
});

describe("isNumericType", () => {
  it("recognises numeric families", () => {
    for (const ty of ["int", "int(11)", "bigint", "decimal(10,2)", "double", "float", "bit(1)", "tinyint(1)"]) {
      expect(isNumericType(ty), ty).toBe(true);
    }
  });
  it("rejects string / temporal / json", () => {
    for (const ty of ["varchar(10)", "text", "datetime", "date", "json", "enum('a')", "blob"]) {
      expect(isNumericType(ty), ty).toBe(false);
    }
  });
  it("does not match types that merely start with a numeric word", () => {
    // \b 邊界：intern_name 不是數值型別。
    expect(isNumericType("interval")).toBe(false);
  });
});

describe("routineArgLiteral", () => {
  it("maps blank and NULL to SQL NULL", () => {
    expect(routineArgLiteral("mysql", "", "int")).toBe("NULL");
    expect(routineArgLiteral("mysql", "   ", "varchar(10)")).toBe("NULL");
    expect(routineArgLiteral("mysql", "null", "varchar(10)")).toBe("NULL");
    expect(routineArgLiteral("mysql", "NULL", "int")).toBe("NULL");
  });

  it("passes numeric values through unquoted", () => {
    expect(routineArgLiteral("mysql", "42", "int")).toBe("42");
    expect(routineArgLiteral("mysql", "-1.5", "decimal(10,2)")).toBe("-1.5");
  });

  it("quotes non-numeric values", () => {
    expect(routineArgLiteral("mysql", "TWD", "varchar(10)")).toBe("'TWD'");
    expect(routineArgLiteral("mysql", "2025-08-01", "date")).toBe("'2025-08-01'");
  });

  it("quotes a non-numeric value even in a numeric slot rather than emitting a bare identifier", () => {
    expect(routineArgLiteral("mysql", "abc", "int")).toBe("'abc'");
  });

  it("escapes quotes and backslashes per dialect", () => {
    expect(routineArgLiteral("mysql", "it's", "varchar(10)")).toBe("'it''s'");
    expect(routineArgLiteral("mysql", "a\\", "varchar(10)")).toBe("'a\\\\'");
    expect(routineArgLiteral("postgres", "a\\", "text")).toBe("'a\\'");
  });
});

describe("buildRoutineExecSql", () => {
  const proc = { name: "Member_TpCurrency_Get", routine_type: "procedure" };

  it("builds a plain CALL for IN-only procedures", () => {
    const params = parseRoutineParams("mysql", "IN p_SiteId int, IN p_Currency varchar(10)");
    const { sql, outNames } = buildRoutineExecSql("mysql", "Siebog", proc, params, ["42", "TWD"]);
    expect(sql).toBe("CALL `Siebog`.`Member_TpCurrency_Get`(42, 'TWD')");
    expect(outNames).toEqual([]);
  });

  it("passes NULL for blank inputs", () => {
    const params = parseRoutineParams("mysql", "IN a int, IN b varchar(10)");
    const { sql } = buildRoutineExecSql("mysql", "d", proc, params, ["", ""]);
    expect(sql).toBe("CALL `d`.`Member_TpCurrency_Get`(NULL, NULL)");
  });

  it("wires OUT params through session variables and selects them back", () => {
    const params = parseRoutineParams("mysql", "IN a int, OUT total decimal(10,2)");
    const { sql, outNames } = buildRoutineExecSql("mysql", "d", proc, params, ["1", ""]);
    expect(sql).toBe("CALL `d`.`Member_TpCurrency_Get`(1, @total);\nSELECT @total AS `total`");
    expect(outNames).toEqual(["total"]);
  });

  it("seeds INOUT params with SET before the call", () => {
    const params = parseRoutineParams("mysql", "INOUT n int");
    const { sql } = buildRoutineExecSql("mysql", "d", proc, params, ["7"]);
    expect(sql).toBe("SET @n = 7;\nCALL `d`.`Member_TpCurrency_Get`(@n);\nSELECT @n AS `n`");
  });

  it("uses the mysql dialect for external gateway connections", () => {
    const params = parseRoutineParams("external", "IN a int, OUT b int");
    const { sql } = buildRoutineExecSql("external", "Siebog", proc, params, ["1", ""]);
    expect(sql).toBe("CALL `Siebog`.`Member_TpCurrency_Get`(1, @b);\nSELECT @b AS `b`");
  });

  it("does not invent session variables where the dialect has none", () => {
    // PG 沒有 @var；OUT 一律以值傳入（PG 程序的 OUT 由結果列回傳）。
    const params = parseRoutineParams("postgres", "integer, integer");
    const { sql, outNames } = buildRoutineExecSql("postgres", "public", proc, params, ["1", "2"]);
    expect(sql).toBe('CALL "public"."Member_TpCurrency_Get"(1, 2)');
    expect(outNames).toEqual([]);
  });

  it("builds SELECT for functions", () => {
    const fn = { name: "fn_rate", routine_type: "function" };
    const params = parseRoutineParams("mysql", "p1 int");
    const { sql } = buildRoutineExecSql("mysql", "d", fn, params, ["3"]);
    expect(sql).toBe("SELECT `d`.`fn_rate`(3) AS result");
  });

  it("handles a routine with no parameters", () => {
    const { sql } = buildRoutineExecSql("mysql", "d", proc, [], []);
    expect(sql).toBe("CALL `d`.`Member_TpCurrency_Get`()");
  });
});

describe("outVarName", () => {
  it("sanitises names into legal session variables", () => {
    expect(outVarName({ mode: "OUT", name: "p total", type: "int" }, 0)).toBe("@p_total");
    expect(outVarName({ mode: "OUT", name: "", type: "int" }, 2)).toBe("@p3");
  });
});

describe("formatSignature", () => {
  it("renders a compact parenthesised list", () => {
    expect(formatSignature(parseRoutineParams("mysql", "IN a int, OUT b decimal(10,2)")))
      .toBe("(IN a int, OUT b decimal(10,2))");
  });
  it("renders empty for no params", () => {
    expect(formatSignature([])).toBe("");
  });
});
