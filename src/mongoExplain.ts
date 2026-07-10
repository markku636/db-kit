
import { t } from "./i18n";// MongoDB explain 輸出解析：把 find / aggregate 的 explain JSON（relaxed extJSON）正規化成
// stage 樹 + 摘要，供 MongoExplain 元件視覺化。純函式、無 React / Tauri 相依（見 mongoExplain.test.ts）。
//
// 需容忍的形狀差異：
// - 傳統：queryPlanner.winningPlan 巢狀 inputStage / inputStages
// - SBE（MongoDB 6+）：winningPlan.queryPlan 內才是傳統計畫
// - executionStats：executionStages 同構樹帶指標（nReturned / keysExamined / docsExamined…）
// - sharded：winningPlan.shards[] / executionStats.executionStages.shards[]，每片自帶子計畫
// - aggregate：頂層 stages[]（$cursor 內含 find 計畫；其餘管線階段各為一節點）
//   或 sharded aggregate 的頂層 shards:{name:{stages|queryPlanner…}}

export interface MongoPlanStage {
  stage: string; // COLLSCAN / IXSCAN / FETCH / SORT / $group…
  detail?: string; // 索引名 / 方向 / 過濾摘要
  indexName?: string;
  nReturned?: number;
  executionTimeMillis?: number; // executionTimeMillisEstimate（每階段為估計值）
  keysExamined?: number;
  docsExamined?: number;
  shard?: string; // sharded：此子樹所屬分片名
  warn?: boolean; // COLLSCAN（全集合掃描）/ 記憶體 SORT — 效能警訊
  children: MongoPlanStage[];
}

export interface MongoExplainSummary {
  nReturned: number | null;
  keysExamined: number | null;
  docsExamined: number | null;
  executionTimeMillis: number | null;
  indexes: string[]; // 用到的索引名（去重）
  collscan: boolean; // 樹中含 COLLSCAN
}

export interface MongoExplainModel {
  root: MongoPlanStage;
  /** verbosity=queryPlanner 時為 null（未實際執行，無統計）。 */
  summary: MongoExplainSummary | null;
  ns?: string;
  server?: string;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// 過濾條件的單行摘要（過長截斷；只供 detail 顯示）。
function filterSummary(f: unknown): string | undefined {
  if (!f || typeof f !== "object" || Object.keys(f as object).length === 0) return undefined;
  const s = JSON.stringify(f);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

// 由「計畫節點」（winningPlan 或 executionStages，同構）遞迴建 stage 樹。
// executionStages 帶指標，winningPlan 不帶——欄位缺漏即 undefined，UI 自然略過。
function nodeToStage(p: any): MongoPlanStage {
  // SBE 包裝：winningPlan.queryPlan 才是傳統計畫（slotBasedPlan 略過不展示）。
  const n = p?.queryPlan && typeof p.queryPlan === "object" ? p.queryPlan : p ?? {};
  const stage = String(n.stage ?? n.mode ?? "STAGE");
  const children: MongoPlanStage[] = [];
  if (n.inputStage) children.push(nodeToStage(n.inputStage));
  if (Array.isArray(n.inputStages)) for (const s of n.inputStages) children.push(nodeToStage(s));
  // sharded：SHARD_MERGE / SINGLE_SHARD 底下的 shards[]（find 的 queryPlanner 形）。
  if (Array.isArray(n.shards)) {
    for (const sh of n.shards) {
      const inner = sh.winningPlan ?? sh.executionStages ?? {};
      const st = nodeToStage(inner);
      st.shard = typeof sh.shardName === "string" ? sh.shardName : undefined;
      children.push(st);
    }
  }
  const details: string[] = [];
  if (typeof n.indexName === "string") details.push(t("索引 {indexName}", { indexName: n.indexName }));
  if (typeof n.direction === "string") details.push(n.direction);
  const fs = filterSummary(n.filter);
  if (fs) details.push(fs);
  return {
    stage,
    detail: details.length ? details.join(" · ") : undefined,
    indexName: typeof n.indexName === "string" ? n.indexName : undefined,
    nReturned: num(n.nReturned),
    executionTimeMillis: num(n.executionTimeMillisEstimate) ?? num(n.executionTimeMillis),
    keysExamined: num(n.keysExamined),
    docsExamined: num(n.docsExamined),
    // 記憶體排序（無索引支撐）：blocking stage；SBE 下 SORT 亦同。
    warn: stage === "COLLSCAN" || stage === "SORT",
    children,
  };
}

// aggregate 的 stages[]：$cursor 展開內部 find 計畫，其餘以運算子名為節點。
function pipelineToStage(stages: any[]): MongoPlanStage {
  const children: MongoPlanStage[] = [];
  for (const s of stages) {
    if (!s || typeof s !== "object") continue;
    const cursor = s.$cursor ?? s.$geoNearCursor;
    if (cursor && typeof cursor === "object") {
      const inner = parsePlannerAndStats(cursor);
      if (inner) {
        children.push(inner.root);
        continue;
      }
    }
    const op = Object.keys(s).find((k) => k.startsWith("$"));
    children.push({
      stage: op ?? "STAGE",
      nReturned: num(s.nReturned),
      executionTimeMillis: num(s.executionTimeMillisEstimate),
      warn: false,
      children: [],
    });
  }
  return { stage: "PIPELINE", warn: false, children };
}

// 單一（或單分片）計畫本體：優先用 executionStats.executionStages（帶指標），否則 winningPlan。
function parsePlannerAndStats(doc: any): { root: MongoPlanStage; hasStats: boolean } | null {
  const planner = doc?.queryPlanner;
  const stats = doc?.executionStats;
  if (stats?.executionStages && typeof stats.executionStages === "object") {
    // sharded 的 executionStages 也可能帶 shards[]（nodeToStage 已處理）。
    return { root: nodeToStage(stats.executionStages), hasStats: true };
  }
  if (planner?.winningPlan && typeof planner.winningPlan === "object") {
    return { root: nodeToStage(planner.winningPlan), hasStats: false };
  }
  return null;
}

function walk(root: MongoPlanStage, fn: (s: MongoPlanStage) => void) {
  fn(root);
  for (const c of root.children) walk(c, fn);
}

/** 解析 explain 原始 JSON 字串。無法辨識形狀時回 null（呼叫端顯示原始 JSON）。 */
export function parseMongoExplain(raw: string): MongoExplainModel | null {
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  let root: MongoPlanStage | null = null;
  let hasStats = false;

  if (Array.isArray(doc.stages)) {
    // aggregate（未整段下推）：頂層 stages[]。
    root = pipelineToStage(doc.stages);
    hasStats = doc.stages.some((s: any) => num(s?.nReturned) !== undefined || s?.$cursor?.executionStats);
  } else if (doc.shards && typeof doc.shards === "object" && !Array.isArray(doc.shards)) {
    // sharded aggregate：shards:{name:{stages|queryPlanner…}}。
    const children: MongoPlanStage[] = [];
    for (const [name, sh] of Object.entries<any>(doc.shards)) {
      let st: MongoPlanStage | null = null;
      if (Array.isArray(sh?.stages)) st = pipelineToStage(sh.stages);
      else {
        const inner = parsePlannerAndStats(sh);
        if (inner) {
          st = inner.root;
          hasStats = hasStats || inner.hasStats;
        }
      }
      if (st) {
        st.shard = name;
        children.push(st);
      }
    }
    if (children.length === 0) return null;
    root = { stage: "SHARD_MERGE", warn: false, children };
  } else {
    const inner = parsePlannerAndStats(doc);
    if (!inner) return null;
    root = inner.root;
    hasStats = inner.hasStats;
  }

  const indexes = new Set<string>();
  let collscan = false;
  walk(root, (s) => {
    if (s.indexName) indexes.add(s.indexName);
    if (s.stage === "COLLSCAN") collscan = true;
  });

  const stats = doc.executionStats;
  const summary: MongoExplainSummary | null =
    hasStats || stats
      ? {
          nReturned: num(stats?.nReturned) ?? null,
          keysExamined: num(stats?.totalKeysExamined) ?? null,
          docsExamined: num(stats?.totalDocsExamined) ?? null,
          executionTimeMillis: num(stats?.executionTimeMillis) ?? null,
          indexes: [...indexes],
          collscan,
        }
      : null;

  return {
    root,
    summary,
    ns: typeof doc?.queryPlanner?.namespace === "string" ? doc.queryPlanner.namespace : undefined,
    server: typeof doc?.serverInfo?.host === "string" ? doc.serverInfo.host : undefined,
  };
}

/** 在查詢 DSL 中注入 / 覆寫 verbosity（送 explain 前用；不動編輯器原文）。解析失敗回原字串。 */
export function withVerbosity(dsl: string, verbosity: string): string {
  try {
    const v = JSON.parse(dsl);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      v.verbosity = verbosity;
      return JSON.stringify(v);
    }
  } catch {
    /* 交給後端報格式錯誤 */
  }
  return dsl;
}
