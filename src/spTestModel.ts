// 預存程序整合測試對話框的純邏輯（不碰 React / Tauri，可單元測試）：
// - 判定分類與計數、步驟實際輸出的一行摘要
// - 「採用實際值」：把某一步的實際輸出改寫成測試檔裡的期望
// - 範例情境庫：插入一個情境（必要時連 fixture）到目前的測試檔
// - 對應的 `dbk sp-test` 指令（GUI 設定 ↔ CLI / CI 的橋）
import type { SpTestFileReport, SpTestMode, SpTestScenarioReport, SpTestVerdict } from "./api";

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 算綠的判定（與後端 `Verdict::is_green` 一致）：CI 的 exit code 也看這個。 */
export const GREEN_VERDICTS: ReadonlySet<SpTestVerdict> = new Set<SpTestVerdict>(["pass", "skipped", "both_error"]);

export function isGreen(v: SpTestVerdict): boolean {
  return GREEN_VERDICTS.has(v);
}

/** 顯示順序：先紅後黃再綠，讓摘要列第一眼看到該處理的。 */
export const VERDICT_ORDER: SpTestVerdict[] = [
  "fail", "mismatch", "perf_fail", "error", "seed_error", "error_on_one_side", "both_error", "pass", "skipped",
];

export function countVerdicts(reports: SpTestFileReport[]): { verdict: SpTestVerdict; n: number }[] {
  const m = new Map<SpTestVerdict, number>();
  for (const r of reports) for (const s of r.scenarios) m.set(s.verdict, (m.get(s.verdict) ?? 0) + 1);
  return VERDICT_ORDER.filter((v) => m.has(v)).map((v) => ({ verdict: v, n: m.get(v)! }));
}

/** `--only` 用的名字：有 case 就是 `id/case`。 */
export function scenarioKey(s: Pick<SpTestScenarioReport, "id" | "case">): string {
  return s.case ? `${s.id}/${s.case}` : s.id;
}

// ---------------------------------------------------------------------------
// 步驟輸出（後端 StepOutcome 的前端型別；api.ts 只給 unknown）
// ---------------------------------------------------------------------------

export interface SpResultSet { columns: string[]; rows: (string | null)[][]; truncated?: boolean }
export interface SpTableEffect {
  table: string; columns: string[]; key: string[];
  inserted: (string | null)[][]; updated: [(string | null)[], (string | null)[]][]; deleted: (string | null)[][];
  incomplete?: boolean; keyless?: boolean; masked_cols?: string[];
}
export interface SpStepOutcome {
  kind: string;
  result_sets?: SpResultSet[];
  out?: Record<string, string | null>;
  return_code?: string | null;
  error?: { code?: string | null; class: string; message: string } | null;
  effects?: SpTableEffect[];
  tx_state?: string | null;
  elapsed_ms?: number;
  symbols?: Record<string, string>;
  symbol_cols?: Record<string, string>;
  masked_cols?: string[];
}

export function asOutcome(v: unknown): SpStepOutcome | null {
  return v && typeof v === "object" && typeof (v as SpStepOutcome).kind === "string" ? (v as SpStepOutcome) : null;
}

/** 一步輸出的結構化摘要（呈現層再翻譯）：結果集列數、OUT、副作用、錯誤。 */
export interface OutcomeSummary {
  sets: number[];
  out: [string, string | null][];
  returnCode: string | null;
  effects: { table: string; ins: number; upd: number; del: number }[];
  error: { class: string; message: string } | null;
}

export function summarizeOutcome(o: SpStepOutcome): OutcomeSummary {
  return {
    sets: (o.result_sets ?? []).map((s) => s.rows.length),
    out: Object.entries(o.out ?? {}),
    returnCode: o.return_code ?? null,
    effects: (o.effects ?? [])
      .map((e) => ({ table: e.table, ins: e.inserted.length, upd: e.updated.length, del: e.deleted.length }))
      .filter((e) => e.ins + e.upd + e.del > 0),
    error: o.error ? { class: o.error.class, message: o.error.message } : null,
  };
}

// ---------------------------------------------------------------------------
// 採用實際值
// ---------------------------------------------------------------------------

const normCol = (s: string) => s.replace(/^@/, "").replace(/_/g, "").toLowerCase();

/** 參數名正規化（同後端 `norm_param`）：`@CustomerID` / `p_customer_id` / `customer_id` → `customerid`。 */
export function normParam(name: string): string {
  const s = name.trim().replace(/^@/, "").toLowerCase();
  return s.replace(/^(p_|in_|io_)/, "").replace(/_/g, "");
}

/** 「同一個符號」的判定與後端一致：值相等，且欄名對得上（或兩邊都是 *id 欄）。 */
function symbolFor(col: string, value: string, o: SpStepOutcome): string | null {
  const syms = o.symbols ?? {};
  const cols = o.symbol_cols ?? {};
  for (const [name, v] of Object.entries(syms)) {
    if (v !== value) continue;
    const src = cols[name];
    if (!src) continue;
    const a = normCol(src);
    const b = normCol(col);
    if (a === b || (a.endsWith("id") && b.endsWith("id"))) return name;
  }
  return null;
}

/** 儲存格 → 期望值：整數轉數字（安全範圍內），其餘維持字串（小數寫字串才不會被 JSON 吃掉尾零）。 */
function cellToExpect(v: string | null): unknown {
  if (v === null) return null;
  if (/^-?\d{1,15}$/.test(v)) return Number(v);
  return v;
}

/** 一個結果集 → 期望列：自動編號 / 時間預設值欄（masked_cols）若對不到符號就略過——每次執行都不同。 */
export function rowsToExpect(set: SpResultSet, o: SpStepOutcome, maxRows = 20): Record<string, unknown>[] {
  const masked = new Set((o.masked_cols ?? []).map(normCol));
  return set.rows.slice(0, maxRows).map((row) => {
    const out: Record<string, unknown> = {};
    set.columns.forEach((c, i) => {
      const v = row[i] ?? null;
      const sym = v !== null ? symbolFor(c, v, o) : null;
      if (sym) { out[c] = `<<${sym}`; return; }
      if (masked.has(normCol(c))) return;
      out[c] = cellToExpect(v);
    });
    return out;
  });
}

export type AdoptResult = { ok: true; text: string } | { ok: false; reason: "parse" | "scenario" | "fixture_step" | "step" | "kind" };

type Json = Record<string, unknown>;

/**
 * 把報表裡某一步（展開後的索引：fixture 步驟在前）的實際輸出寫成該步的期望。
 * - call：結果集 → `result_sets`、OUT → `out`、副作用 → `effects` 的數量；出錯 → 改成 `expect_error`。
 * - query / sql：結果集 → `expect`；出錯 → `expect_error`。
 * fixture 的步驟不改（同一個 fixture 被多個情境共用，改它會連帶影響別的情境）。
 */
export function adoptActual(fileText: string, scenarioId: string, stepIndex: number, o: SpStepOutcome): AdoptResult {
  let file: Json;
  try { file = JSON.parse(fileText) as Json; } catch { return { ok: false, reason: "parse" }; }
  const scenarios = Array.isArray(file.scenarios) ? (file.scenarios as Json[]) : [];
  const sc = scenarios.find((s) => s.id === scenarioId);
  if (!sc) return { ok: false, reason: "scenario" };
  const fixtures = (file.fixtures ?? {}) as Record<string, { steps?: unknown[] }>;
  const uses = Array.isArray(sc.use) ? (sc.use as string[]) : [];
  const fixtureSteps = uses.reduce((n, u) => n + (fixtures[u]?.steps?.length ?? 0), 0);
  if (stepIndex < fixtureSteps) return { ok: false, reason: "fixture_step" };
  const steps = Array.isArray(sc.steps) ? (sc.steps as Json[]) : [];
  const step = steps[stepIndex - fixtureSteps];
  if (!step) return { ok: false, reason: "step" };

  const sets = o.result_sets ?? [];
  if (o.error) {
    const ee: Json = { class: o.error.class };
    const msg = o.error.message.split("\n")[0].trim();
    if (msg) ee.message_contains = msg.length > 80 ? msg.slice(0, 80) : msg;
    delete step.expect;
    step.expect_error = ee;
  } else if (typeof step.call === "string") {
    const exp: Json = {};
    if (sets.length > 0) exp.result_sets = sets.map((s) => ({ rows: rowsToExpect(s, o) }));
    // OUT 一律寫字面值：它多半同時被 `">>sym"` 擷取，寫成 `"<<sym"` 會變成「自己等於自己」、永遠通過。
    // 鍵名用測試檔 params 裡的寫法（引擎回的是 `p_new_balance` / `@NewBalance` 這種原名）。
    const outEntries = Object.entries(o.out ?? {});
    if (outEntries.length > 0) {
      const paramKeys = Object.keys((step.params ?? {}) as Json);
      exp.out = Object.fromEntries(outEntries.map(([k, v]) => [paramKeys.find((p) => normParam(p) === normParam(k)) ?? k, cellToExpect(v)]));
    }
    const effects: Json = {};
    for (const e of o.effects ?? []) {
      const counts: Json = {};
      if (e.inserted.length) counts.inserted = e.inserted.length;
      if (e.updated.length) counts.updated = e.updated.length;
      if (e.deleted.length) counts.deleted = e.deleted.length;
      if (Object.keys(counts).length) effects[e.table] = counts;
    }
    if (Object.keys(effects).length > 0) exp.effects = effects;
    delete step.expect_error;
    step.expect = exp;
  } else if (typeof step.query === "string" || typeof step.sql === "string") {
    delete step.expect_error;
    step.expect = sets.length > 0 ? rowsToExpect(sets[0], o) : [];
  } else {
    return { ok: false, reason: "kind" };
  }
  return { ok: true, text: JSON.stringify(file, null, 2) };
}

// ---------------------------------------------------------------------------
// 範例情境庫
// ---------------------------------------------------------------------------

export type RecipeKey = "happy" | "error" | "out" | "cases" | "flow" | "invariant" | "strict" | "compare";

export interface RecipeCtx { routine: string; fixture: string | null }

interface RecipeBody { scenario: Json; fixtures?: Record<string, Json> }

const SEED_FIXTURE: Json = {
  description: "TODO: seed rows the routine needs",
  steps: [{ insert: "table_name", rows: [{ id: ">>id", name: "sample" }] }],
};

/** 各範例的骨架。值都是佔位（table_name / Param1 / column），插入後照自己的程序改。 */
export const RECIPES: Record<RecipeKey, (c: RecipeCtx) => RecipeBody> = {
  happy: (c) => ({
    scenario: {
      id: "happy_path", use: [c.fixture ?? "base"],
      steps: [{
        call: c.routine, params: { Param1: "<<id" }, capture: { new_id: ">>new_id" },
        expect: { result_sets: [{ rows: [{ column: "value" }] }], effects: { table_name: { inserted: 1 } } },
      }],
    },
  }),
  error: (c) => ({
    scenario: {
      id: "rejects_bad_input", use: [c.fixture ?? "base"],
      steps: [{ call: c.routine, params: { Param1: -1 }, expect_error: { class: "user_raised", message_contains: "TODO" } }],
    },
  }),
  out: (c) => ({
    scenario: {
      id: "out_param", use: [c.fixture ?? "base"],
      steps: [
        { call: c.routine, params: { Param1: "<<id", Result: ">>result" }, expect: { out: { Result: "TODO" } } },
        { query: "SELECT column FROM table_name WHERE id = @id", expect: [{ column: "<<result" }] },
      ],
    },
  }),
  cases: (c) => ({
    scenario: {
      id: "data_driven", use: [c.fixture ?? "base"],
      cases: [
        { name: "small", vars: { qty: 1, expected: "TODO" } },
        { name: "zero", vars: { qty: 0 }, expect_error: { class: "user_raised" } },
      ],
      steps: [{ call: c.routine, params: { Param1: "<<id", Qty: "<<qty" }, expect: { result_sets: [{ rows: [{ column: "<<expected" }] }] } }],
    },
  }),
  flow: (c) => ({
    scenario: {
      id: "business_flow", use: [c.fixture ?? "base"],
      steps: [
        { call: c.routine, params: { Param1: "<<id" }, capture: { new_id: ">>new_id" } },
        { query: "SELECT status FROM table_name WHERE id = @new_id", expect: [{ status: "TODO" }] },
        { call: "next_procedure", params: { Id: "<<new_id" } },
        { query: "SELECT status FROM table_name WHERE id = @new_id", expect: [{ status: "TODO" }] },
      ],
    },
  }),
  invariant: (c) => ({
    scenario: {
      id: "invariant_holds", use: [c.fixture ?? "base"],
      steps: [
        { call: c.routine, params: { Param1: "<<id" } },
        { query: "SELECT SUM(amount) AS total FROM table_name", expect: [{ total: "TODO" }] },
      ],
    },
  }),
  strict: (c) => ({
    scenario: {
      id: "touches_only_expected_tables", use: [c.fixture ?? "base"],
      steps: [{ call: c.routine, params: { Param1: "<<id" }, expect: { effects: { table_name: { updated: 1 } }, effects_strict: true } }],
    },
  }),
  compare: (c) => ({
    scenario: {
      id: "state_restored", use: [c.fixture ?? "base"],
      steps: [
        { query: "SELECT * FROM table_name WHERE id = @id", expect: [{ id: "<<id" }], capture: { "*": ">>before" } },
        { call: c.routine, params: { Param1: "<<id" } },
        { call: "undo_procedure", params: { Param1: "<<id" } },
        { query: "SELECT * FROM table_name WHERE id = @id", expect: [{ id: "<<id" }], capture: { "*": ">>after" } },
        { compare: ["<<before", "<<after"] },
      ],
    },
  }),
};

export const RECIPE_KEYS = Object.keys(RECIPES) as RecipeKey[];

/** 插入範例：情境 id 撞名就加序號；用到的 fixture 不存在時補一個佔位 fixture（已存在的不動）。 */
export function insertRecipe(fileText: string, key: RecipeKey, routine: string | undefined): { ok: true; text: string; id: string } | { ok: false } {
  let file: Json;
  try { file = JSON.parse(fileText) as Json; } catch { return { ok: false }; }
  if (!file || typeof file !== "object" || Array.isArray(file)) return { ok: false };
  const fixtures = (file.fixtures && typeof file.fixtures === "object" ? file.fixtures : {}) as Record<string, Json>;
  const firstFixture = Object.keys(fixtures)[0] ?? null;
  const body = RECIPES[key]({ routine: (file.routine as string | undefined) ?? routine ?? "procedure_name", fixture: firstFixture });
  const scenarios = Array.isArray(file.scenarios) ? (file.scenarios as Json[]) : [];
  const ids = new Set(scenarios.map((s) => s.id));
  const base = body.scenario.id as string;
  let id = base;
  for (let i = 2; ids.has(id); i++) id = `${base}_${i}`;
  const scenario: Json = { ...body.scenario, id };
  for (const u of (scenario.use as string[] | undefined) ?? []) {
    if (!fixtures[u]) fixtures[u] = structuredClone(SEED_FIXTURE);
  }
  if (Object.keys(fixtures).length > 0) file.fixtures = fixtures;
  file.scenarios = [...scenarios, scenario];
  return { ok: true, text: JSON.stringify(file, null, 2), id };
}

// ---------------------------------------------------------------------------
// 對應的 CLI 指令
// ---------------------------------------------------------------------------

/** 殼層引號：有空白 / 特殊字元才加雙引號（Windows cmd、PowerShell、bash 都吃）。 */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

export interface CliArgs {
  mode: SpTestMode;
  /** 測試資料夾或單一檔案的路徑。 */
  path: string;
  conn: string;
  database: string;
  goldenDir?: string;
  dst?: { conn: string; database: string } | null;
  only?: string[];
  ci?: boolean;
}

/** GUI 目前的設定 → 等價的 `dbk sp-test` 指令。`ci` 多帶 `--junit` + `--exit-code`。 */
export function buildCliCommand(a: CliArgs): string {
  const parts = ["dbk", "sp-test", a.mode === "diff" ? "diff" : "run", shellQuote(a.path), "--conn", shellQuote(a.conn), "-d", shellQuote(a.database)];
  if (a.mode === "diff" && a.dst) {
    parts.push("--dst", shellQuote(a.dst.conn));
    if (a.dst.database && a.dst.database !== a.database) parts.push("--dst-db", shellQuote(a.dst.database));
  } else if (a.mode === "record" || a.mode === "golden") {
    parts.push("--mode", a.mode, "--golden", shellQuote(a.goldenDir || "golden"));
  }
  if (a.only && a.only.length > 0) parts.push("--only", shellQuote(a.only.join(",")));
  if (a.ci) parts.push("--junit", a.mode === "diff" ? "reports/diff.xml" : "reports/sp-test.xml", "--exit-code");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// 展開後的步驟（報表的步驟索引 = fixture 步驟在前、情境步驟在後）
// ---------------------------------------------------------------------------

export interface ExpandedStep {
  /** 來自哪個 fixture；情境本身的步驟為 null。 */
  fixture: string | null;
  kind: "insert" | "call" | "query" | "sql" | "compare" | "snapshot" | "unknown";
  /** 一行描述：程序名 / 表名 / SQL 開頭。 */
  target: string;
}

function stepKind(st: Json): ExpandedStep["kind"] {
  for (const k of ["insert", "call", "query", "sql", "compare", "snapshot"] as const) if (k in st) return k;
  return "unknown";
}

function stepTarget(st: Json, kind: ExpandedStep["kind"]): string {
  const v = st[kind];
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v !== "string") return "";
  const one = v.replace(/\s+/g, " ").trim();
  return one.length > 70 ? `${one.slice(0, 70)}…` : one;
}

/** 測試檔裡某情境展開後的步驟清單；檔案解析不了或找不到情境回 null。 */
export function expandedSteps(fileText: string, scenarioId: string): ExpandedStep[] | null {
  let file: Json;
  try { file = JSON.parse(fileText) as Json; } catch { return null; }
  const sc = (Array.isArray(file.scenarios) ? (file.scenarios as Json[]) : []).find((s) => s.id === scenarioId);
  if (!sc) return null;
  const fixtures = (file.fixtures ?? {}) as Record<string, { steps?: Json[] }>;
  const out: ExpandedStep[] = [];
  for (const u of Array.isArray(sc.use) ? (sc.use as string[]) : []) {
    for (const st of fixtures[u]?.steps ?? []) {
      const kind = stepKind(st);
      out.push({ fixture: u, kind, target: stepTarget(st, kind) });
    }
  }
  for (const st of Array.isArray(sc.steps) ? (sc.steps as Json[]) : []) {
    const kind = stepKind(st);
    out.push({ fixture: null, kind, target: stepTarget(st, kind) });
  }
  return out;
}

/** 單一情境重跑的結果併回原報表：同檔、同 `id/case` 的列換新，其餘保留。 */
export function mergeReports(prev: SpTestFileReport[], next: SpTestFileReport[]): SpTestFileReport[] {
  const out = prev.map((r) => ({ ...r, scenarios: [...r.scenarios] }));
  for (const n of next) {
    const r = out.find((x) => x.file === n.file && x.mode === n.mode);
    if (!r) { out.push(n); continue; }
    for (const s of n.scenarios) {
      const i = r.scenarios.findIndex((x) => scenarioKey(x) === scenarioKey(s));
      if (i >= 0) r.scenarios[i] = s; else r.scenarios.push(s);
    }
    r.started_at = n.started_at;
  }
  return out;
}
