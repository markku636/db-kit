import { describe, expect, it } from "vitest";
import type { SpTestFileReport } from "./api";
import {
  adoptActual, buildCliCommand, countVerdicts, expandedSteps, insertRecipe, mergeReports, RECIPE_KEYS, rowsToExpect, scenarioKey, shellQuote,
  summarizeOutcome, type SpStepOutcome,
} from "./spTestModel";

const FILE = JSON.stringify({
  version: 1,
  target: { kind: "mssql", database: "sptest" },
  routine: "usp_place_order",
  fixtures: {
    base: {
      steps: [
        { insert: "customers", rows: [{ customer_id: ">>cid", name: "Ann" }] },
        { insert: "products", rows: [{ product_id: ">>pid", name: "Pen", price: "12.50", stock: 10 }] },
      ],
    },
  },
  scenarios: [
    {
      id: "happy",
      use: ["base"],
      steps: [
        { call: "usp_place_order", params: { CustomerID: "<<cid", ProductID: "<<pid", Qty: 2 }, capture: { order_id: ">>oid" } },
        { query: "SELECT stock FROM products WHERE product_id = @pid", expect: [{ stock: 0 }] },
      ],
    },
  ],
});

const CALL_OUTCOME: SpStepOutcome = {
  kind: "call",
  result_sets: [{ columns: ["order_id", "qty", "total", "status", "created_at"], rows: [["101", "2", "25.00", "NEW", "2026-10-03 10:00:00"]] }],
  out: { NewBalance: "112.50" },
  effects: [
    { table: "orders", columns: ["order_id", "qty"], key: ["order_id"], inserted: [["101", "2"]], updated: [], deleted: [] },
    { table: "products", columns: ["product_id", "stock"], key: ["product_id"], inserted: [], updated: [[["7", "10"], ["7", "8"]]], deleted: [] },
    { table: "audit_log", columns: ["id"], key: ["id"], inserted: [], updated: [], deleted: [] },
  ],
  symbols: { cid: "3", pid: "7", oid: "101" },
  symbol_cols: { cid: "customer_id", pid: "product_id", oid: "order_id" },
  masked_cols: ["order_id", "created_at"],
};

describe("adoptActual", () => {
  it("call：結果集 / OUT / 副作用數量寫成期望，符號換回 <<sym、遮罩欄略過", () => {
    const res = adoptActual(FILE, "happy", 2, CALL_OUTCOME);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const step = JSON.parse(res.text).scenarios[0].steps[0];
    expect(step.expect.result_sets).toEqual([{ rows: [{ order_id: "<<oid", qty: 2, total: "25.00", status: "NEW" }] }]);
    expect(step.expect.out).toEqual({ NewBalance: "112.50" });  // 鍵沿用 params 不存在時的原名
    expect(step.expect.effects).toEqual({ orders: { inserted: 1 }, products: { updated: 1 } });
    // 其他鍵保留
    expect(step.capture).toEqual({ order_id: ">>oid" });
  });

  it("query：第一個結果集寫進 expect", () => {
    const o: SpStepOutcome = { kind: "query", result_sets: [{ columns: ["stock"], rows: [["8"]] }] };
    const res = adoptActual(FILE, "happy", 3, o);
    expect(res.ok && JSON.parse(res.text).scenarios[0].steps[1].expect).toEqual([{ stock: 8 }]);
  });

  it("出錯：改成 expect_error、拿掉 expect", () => {
    const o: SpStepOutcome = { kind: "query", error: { class: "not_found", message: "Invalid object name 'productz'.\nmore" } };
    const res = adoptActual(FILE, "happy", 3, o);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const step = JSON.parse(res.text).scenarios[0].steps[1];
    expect(step.expect).toBeUndefined();
    expect(step.expect_error).toEqual({ class: "not_found", message_contains: "Invalid object name 'productz'." });
  });

  it("fixture 的步驟、不存在的情境 / 步驟、壞 JSON 都拒絕", () => {
    expect(adoptActual(FILE, "happy", 1, CALL_OUTCOME)).toEqual({ ok: false, reason: "fixture_step" });
    expect(adoptActual(FILE, "nope", 2, CALL_OUTCOME)).toEqual({ ok: false, reason: "scenario" });
    expect(adoptActual(FILE, "happy", 9, CALL_OUTCOME)).toEqual({ ok: false, reason: "step" });
    expect(adoptActual("{", "happy", 2, CALL_OUTCOME)).toEqual({ ok: false, reason: "parse" });
  });

  it("數字：整數轉 number、小數與超長數字維持字串、NULL 保留", () => {
    const rows = rowsToExpect({ columns: ["a", "b", "c", "d"], rows: [["-3", "1.50", "12345678901234567890", null]] }, { kind: "query" });
    expect(rows).toEqual([{ a: -3, b: "1.50", c: "12345678901234567890", d: null }]);
  });

  it("符號只在欄名對得上（或都是 *id）時才換", () => {
    const o: SpStepOutcome = { kind: "query", symbols: { pid: "7" }, symbol_cols: { pid: "product_id" } };
    const rows = rowsToExpect({ columns: ["ProductID", "stock", "parent_id"], rows: [["7", "7", "7"]] }, o);
    expect(rows).toEqual([{ ProductID: "<<pid", stock: 7, parent_id: "<<pid" }]);
  });
});

describe("adoptActual 用真實引擎輸出（MySQL，dbk sp-test run --format json 擷取）", () => {
  const REAL_FILE = JSON.stringify({
    version: 1, target: { kind: "mssql", database: "sptest" },
    fixtures: { base: { steps: [{ insert: "customers", rows: [{ customer_id: ">>cid", name: "Ann", credit: "100.00", is_active: true }] }] } },
    scenarios: [{ id: "top_up", use: ["base"], steps: [{ call: "usp_adjust_credit", params: { CustomerID: "<<cid", Delta: "12.5", NewBalance: ">>bal" } }] }],
  });
  const REAL: SpStepOutcome = {
    kind: "call",
    out: { p_new_balance: "112.50" },
    effects: [{
      table: "customers", columns: ["customer_id", "name", "credit", "is_active"], key: ["customer_id"], inserted: [],
      updated: [[["26", "Ann", "100.00", "1"], ["26", "Ann", "112.50", "1"]]], deleted: [], incomplete: false, keyless: false, masked_cols: ["customer_id"],
    }],
    elapsed_ms: 22,
    symbols: { bal: "112.50", cid: "26" },
    symbol_cols: { bal: "p_new_balance", cid: "customer_id" },
    masked_cols: ["customer_id"],
  };

  it("OUT 寫字面值（不寫成同一步擷取的 <<bal）、鍵名對回 params 的 NewBalance", () => {
    const res = adoptActual(REAL_FILE, "top_up", 1, REAL);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const exp = JSON.parse(res.text).scenarios[0].steps[0].expect;
    expect(exp).toEqual({ out: { NewBalance: "112.50" }, effects: { customers: { updated: 1 } } });
  });
});

describe("insertRecipe", () => {
  it("每個範例插得進去、id 撞名加序號、沿用既有 fixture", () => {
    let text = FILE;
    for (const k of RECIPE_KEYS) {
      const res = insertRecipe(text, k, "usp_x");
      expect(res.ok).toBe(true);
      if (res.ok) text = res.text;
    }
    const again = insertRecipe(text, "happy", "usp_x");
    expect(again.ok && again.id).toBe("happy_path_2");
    const f = JSON.parse(text);
    expect(f.scenarios).toHaveLength(1 + RECIPE_KEYS.length);
    expect(Object.keys(f.fixtures)).toEqual(["base"]);
    // 檔案自己的 routine 優先
    expect(f.scenarios[1].steps[0].call).toBe("usp_place_order");
    expect(f.scenarios[1].use).toEqual(["base"]);
  });

  it("沒有 fixture 的檔案補一個佔位 base", () => {
    const res = insertRecipe(JSON.stringify({ version: 1, target: { kind: "mysql", database: "d" }, scenarios: [] }), "error", "p");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const f = JSON.parse(res.text);
    expect(f.fixtures.base.steps[0].insert).toBe("table_name");
    expect(f.scenarios[0].steps[0].call).toBe("p");
  });

  it("壞 JSON 拒絕", () => {
    expect(insertRecipe("not json", "happy", "p")).toEqual({ ok: false });
    expect(insertRecipe("[]", "happy", "p")).toEqual({ ok: false });
  });
});

describe("buildCliCommand", () => {
  it("assert / golden / diff / CI", () => {
    expect(buildCliCommand({ mode: "assert", path: "tests/", conn: "mssql-test", database: "sales" }))
      .toBe("dbk sp-test run tests/ --conn mssql-test -d sales");
    expect(buildCliCommand({ mode: "golden", path: "C:\\My Tests", conn: "prod copy", database: "sales", goldenDir: "C:\\My Tests\\golden" }))
      .toBe('dbk sp-test run "C:\\My Tests" --conn "prod copy" -d sales --mode golden --golden "C:\\My Tests\\golden"');
    expect(buildCliCommand({ mode: "diff", path: "tests/", conn: "ms", database: "sales", dst: { conn: "pg", database: "public" }, ci: true }))
      .toBe("dbk sp-test diff tests/ --conn ms -d sales --dst pg --dst-db public --junit reports/diff.xml --exit-code");
    expect(buildCliCommand({ mode: "diff", path: "t", conn: "a", database: "x", dst: { conn: "b", database: "x" }, only: ["s1", "s2/c"] }))
      .toBe("dbk sp-test diff t --conn a -d x --dst b --only s1,s2/c");
  });

  it("shellQuote", () => {
    expect(shellQuote("a-b_c.json")).toBe("a-b_c.json");
    expect(shellQuote('a "b"')).toBe('"a \\"b\\""');
  });
});

describe("報表輔助", () => {
  const rep = (scen: [string, string | undefined, string][]): SpTestFileReport => ({
    file: "a.json", mode: "assert", targets: ["mssql"], started_at: "t",
    scenarios: scen.map(([id, c, v]) => ({ id, case: c, verdict: v as never, mode_used: "wrapped", elapsed_ms: 1, steps: [] })),
  });

  it("countVerdicts 先紅後綠", () => {
    expect(countVerdicts([rep([["a", undefined, "pass"], ["b", undefined, "fail"], ["c", undefined, "pass"]])]))
      .toEqual([{ verdict: "fail", n: 1 }, { verdict: "pass", n: 2 }]);
  });

  it("mergeReports 只換重跑的那一列", () => {
    const prev = [rep([["a", undefined, "fail"], ["q", "zero", "fail"], ["q", "two", "pass"]])];
    const next = [rep([["q", "zero", "pass"]])];
    const merged = mergeReports(prev, next);
    expect(merged[0].scenarios.map((s) => `${scenarioKey(s)}:${s.verdict}`)).toEqual(["a:fail", "q/zero:pass", "q/two:pass"]);
    expect(prev[0].scenarios[1].verdict).toBe("fail");
  });

  it("expandedSteps 標出 fixture 來源", () => {
    const steps = expandedSteps(FILE, "happy")!;
    expect(steps.map((s) => `${s.fixture ?? "-"}:${s.kind}:${s.target}`)).toEqual([
      "base:insert:customers", "base:insert:products", "-:call:usp_place_order", "-:query:SELECT stock FROM products WHERE product_id = @pid",
    ]);
    expect(expandedSteps(FILE, "nope")).toBeNull();
  });

  it("summarizeOutcome 略過沒變化的表", () => {
    const s = summarizeOutcome(CALL_OUTCOME);
    expect(s.sets).toEqual([1]);
    expect(s.effects).toEqual([{ table: "orders", ins: 1, upd: 0, del: 0 }, { table: "products", ins: 0, upd: 1, del: 0 }]);
  });
});
