// 視覺化執行計畫：把 explain.ts 解析出的 PlanNode 樹以「上到下、子節點縮排 + 連接線」呈現，
// 每個節點顯示操作 / 表名、累積成本與估計列數，成本熱點標紅（致敬 Navicat 視覺化解釋）。
import type { PlanNode } from "./explain";
import { planSummary } from "./explain";

const KIND_STYLE: Record<PlanNode["kind"], { dot: string; label: string }> = {
  query_block: { dot: "bg-blue-400", label: "查詢區塊" },
  join: { dot: "bg-purple-400", label: "Join" },
  op: { dot: "bg-amber-400", label: "操作" },
  table: { dot: "bg-emerald-400", label: "資料表" },
};

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return Math.round(n).toLocaleString();
  return String(Math.round(n * 100) / 100);
}

function PlanNodeView({ node, maxCost }: { node: PlanNode; maxCost: number | null }) {
  const st = KIND_STYLE[node.kind];
  // 成本熱點：接近最大單點成本者標紅，快速指出瓶頸。
  const hot = node.cost != null && maxCost != null && maxCost > 0 && node.cost >= maxCost * 0.66;
  return (
    <div className="relative">
      <div className="flex items-start gap-2 py-1">
        <span className={`mt-1.5 h-2.5 w-2.5 rounded-sm shrink-0 ${st.dot}`} title={st.label} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium text-fg/90 break-all">{node.label}</span>
            {node.cost != null && (
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded ${hot ? "bg-red-500/15 text-red-300" : "bg-fg/10 text-fg/60"}`}
                title="成本估計（cost；MySQL 為單表步驟成本，PostgreSQL 為子樹總成本）"
              >
                cost {fmtNum(node.cost)}
              </span>
            )}
            {node.rows != null && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/60" title="估計列數">
                rows {fmtNum(node.rows)}
              </span>
            )}
          </div>
          {node.detail && <div className="text-[11px] text-fg/45 mt-0.5 break-all">{node.detail}</div>}
        </div>
      </div>
      {node.children.length > 0 && (
        <div className="ml-[8px] border-l border-fg/15 pl-3">
          {node.children.map((c, i) => (
            <PlanNodeView key={i} node={c} maxCost={maxCost} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExplainPlan({ node }: { node: PlanNode }) {
  const s = planSummary(node);
  return (
    <div className="p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg/50 mb-2">
        <span>節點 {s.nodes}</span>
        <span>資料表 {s.tables}</span>
        {s.maxCost != null && <span>最高成本 {fmtNum(s.maxCost)}</span>}
        <span className="ml-auto inline-flex items-center gap-2">
          {Object.entries(KIND_STYLE).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className={`h-2 w-2 rounded-sm ${v.dot}`} />
              {v.label}
            </span>
          ))}
        </span>
      </div>
      <PlanNodeView node={node} maxCost={s.maxCost} />
    </div>
  );
}
