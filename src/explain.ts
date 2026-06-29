// EXPLAIN 執行計畫解析：把 MySQL `EXPLAIN FORMAT=JSON` 與 PostgreSQL `EXPLAIN (FORMAT JSON)`
// 的 JSON 輸出正規化成一棵 PlanNode 樹，供 ExplainPlan 元件視覺化（致敬 Navicat 視覺化解釋）。
// 純函式、無 React / Tauri 相依，便於單元測試（見 explain.test.ts）。
import type { DbKind } from "./api";

export interface PlanNode {
  label: string; // 節點主標題（操作 / 表名）
  kind: "query_block" | "join" | "op" | "table"; // 概略分類，供配色 / 圖示
  cost: number | null; // 顯示成本（MySQL 單表步驟成本；PG Total Cost＝子樹累積，供顯示）
  selfCost?: number | null; // 「自身/獨佔」成本，排除子節點累積，供熱點判斷（PG＝Total − Σ子Total）
  rows: number | null; // 估計列數
  detail?: string; // 次要資訊（access type / key / relation…）
  children: PlanNode[];
}

// 包一段查詢成「取得 JSON 執行計畫」的語句。回 null 表示該類型不支援。
// 去掉尾端分號（EXPLAIN 後接帶分號的單句仍可，但多一層保險）。
export function buildExplainJsonSql(kind: DbKind, query: string): string | null {
  const q = query.trim().replace(/;\s*$/, "").trim();
  if (!q) return null;
  if (kind === "mysql" || kind === "external") return `EXPLAIN FORMAT=JSON ${q}`;
  if (kind === "postgres") return `EXPLAIN (FORMAT JSON) ${q}`;
  return null; // sqlite / mongo / redis 無 JSON 計畫
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null; // 空字串視為「未知」而非 0
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---- MySQL：query_block 巢狀結構 ----
function mysqlCost(o: any): number | null {
  return num(o?.cost_info?.query_cost ?? o?.cost_info?.prefix_cost ?? o?.cost_info?.read_cost);
}

function mysqlTable(t: any): PlanNode | null {
  if (!t) return null;
  const children: PlanNode[] = [];
  if (t.materialized_from_subquery?.query_block) children.push(mysqlBlock(t.materialized_from_subquery.query_block));
  for (const s of t.attached_subqueries ?? []) if (s?.query_block) children.push(mysqlBlock(s.query_block));
  // MySQL 的 prefix_cost 是「join 前綴累積成本」，沿 nested_loop 單調遞增 → 最後一張表永遠最大，
  // 不能拿來判斷熱點。改用單表步驟成本 read_cost + eval_cost；無則退回 prefix_cost。累積值留在 detail。
  const ci = t.cost_info ?? {};
  const read = num(ci.read_cost), evalc = num(ci.eval_cost);
  const stepCost = read != null || evalc != null ? (read ?? 0) + (evalc ?? 0) : num(ci.prefix_cost ?? ci.read_cost);
  const prefix = num(ci.prefix_cost);
  const detail = [
    t.access_type && `access: ${t.access_type}`,
    t.key && `key: ${t.key}`,
    t.possible_keys && !t.key && `possible: ${(t.possible_keys as string[]).join(", ")}`,
    prefix != null && `prefix ${prefix}`,
  ].filter(Boolean).join("　");
  return {
    label: t.table_name ?? "table",
    kind: "table",
    cost: stepCost,
    rows: num(t.rows_produced_per_join ?? t.rows_examined_per_scan),
    detail: detail || undefined,
    children,
  };
}

// 從一個帶操作的物件（query_block / ordering_operation…）萃取子節點。
function mysqlOps(o: any): PlanNode[] {
  const out: PlanNode[] = [];
  if (!o || typeof o !== "object") return out; // 防禦非預期 JSON，避免遞迴時崩潰
  if (Array.isArray(o.nested_loop)) {
    const tables = o.nested_loop.map((x: any) => mysqlTable(x.table)).filter(Boolean) as PlanNode[];
    // 單表不必包 Nested Loop；多表才以 join 節點聚合。
    if (tables.length === 1) out.push(tables[0]);
    else if (tables.length > 1) out.push({ label: "Nested Loop", kind: "join", cost: null, rows: null, children: tables });
  }
  if (o.table) { const n = mysqlTable(o.table); if (n) out.push(n); }
  for (const key of ["ordering_operation", "grouping_operation", "duplicates_removal"] as const) {
    if (o[key]) out.push({ label: prettyKey(key), kind: "op", cost: mysqlCost(o[key]), rows: null, children: mysqlOps(o[key]) });
  }
  if (o.union_result) {
    const specs = (o.union_result.query_specifications ?? [])
      .filter((s: any) => s?.query_block)
      .map((s: any) => mysqlBlock(s.query_block));
    out.push({ label: "Union", kind: "op", cost: null, rows: null, children: specs });
  }
  return out;
}

function prettyKey(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function mysqlBlock(qb: any): PlanNode {
  const children = mysqlOps(qb);
  // 帶 message 的計畫（如 "No tables used" / "Impossible WHERE" / "Select tables optimized away"）
  // 把訊息放進 detail，否則使用者只看到一個空白 Query Block。
  const detail = [qb?.select_id != null ? `select #${qb.select_id}` : null, qb?.message ?? null]
    .filter(Boolean)
    .join("　");
  // 若 query_block 只是單一操作的外殼（且自身無成本 / 無訊息），直接回那個子節點，避免多一層空殼。
  if (children.length === 1 && mysqlCost(qb) == null && !qb?.message) return children[0];
  return {
    label: "Query Block",
    kind: "query_block",
    cost: mysqlCost(qb),
    rows: null,
    detail: detail || undefined,
    children,
  };
}

// ---- PostgreSQL：Plan 巢狀結構 ----
function pgNode(p: any): PlanNode {
  const detail = [
    p["Relation Name"] && `rel: ${p["Relation Name"]}`,
    p["Index Name"] && `index: ${p["Index Name"]}`,
    p["Join Type"] && `${p["Join Type"]} join`,
  ].filter(Boolean).join("　");
  const children: PlanNode[] = Array.isArray(p.Plans) ? p.Plans.map(pgNode) : [];
  // PG 的 Total Cost 是「含子樹」的累積值，根節點永遠最大、無法當熱點。改用獨佔成本＝
  // 本節點 Total 減去各直接子節點 Total（pgAdmin / explain.depesz 的標準算法），凸顯真正最耗
  // 工的節點；浮點誤差夾到 0。MySQL 路徑的 cost 已是步驟成本，不另設 selfCost（退回用 cost）。
  const total = num(p["Total Cost"]);
  const childSum = children.reduce((a, c) => a + (c.cost ?? 0), 0);
  const selfCost = total == null ? null : Math.max(0, Number((total - childSum).toFixed(4)));
  return {
    label: p["Node Type"] ?? "Plan",
    kind: p["Relation Name"] ? "table" : "op",
    cost: total,
    selfCost,
    rows: num(p["Plan Rows"]),
    detail: detail || undefined,
    children,
  };
}

// 解析 EXPLAIN JSON 的「儲存格文字」成 PlanNode；無法解析回 null。
export function parseExplainPlan(kind: DbKind, jsonText: string): PlanNode | null {
  if (!jsonText || !jsonText.trim()) return null;
  let root: any;
  try {
    root = JSON.parse(jsonText);
  } catch {
    return null;
  }
  try {
    if (kind === "postgres") {
      const plan = Array.isArray(root) ? root[0]?.Plan : root?.Plan;
      return plan ? pgNode(plan) : null;
    }
    // mysql / external（gateway 講 MySQL）
    const qb = root?.query_block;
    return qb ? mysqlBlock(qb) : null;
  } catch {
    return null;
  }
}

// 計畫摘要統計：節點數、表掃描數、最大單點成本（粗略「熱點」提示）。
// maxCost 刻意排除 query_block（其成本是整段查詢的總和，永遠最大），讓熱點比較落在
// 各操作 / 表的步驟成本之間，凸顯真正的瓶頸節點。
export function planSummary(node: PlanNode | null): { nodes: number; tables: number; maxCost: number | null } {
  let nodes = 0, tables = 0, maxCost: number | null = null;
  const walk = (n: PlanNode) => {
    nodes++;
    if (n.kind === "table") tables++;
    // 熱點以「獨佔成本」比較（PG 用 selfCost 排除子樹累積；MySQL 無 selfCost → 退回步驟 cost）。
    const c = n.selfCost ?? n.cost;
    if (n.kind !== "query_block" && c != null && (maxCost == null || c > maxCost)) maxCost = c;
    n.children.forEach(walk);
  };
  if (node) walk(node);
  return { nodes, tables, maxCost };
}
