import { useState } from "react";
import type { MongoExplainModel, MongoPlanStage } from "./mongoExplain";
import { useT } from "./i18n";

// Mongo 執行計畫視覺化：摘要條（nReturned / keysExamined / docsExamined / 耗時 + 掃描比）
// + stage 樹（COLLSCAN 紅、IXSCAN 綠、blocking SORT 琥珀）+ 原始 JSON 摺疊。
// 與 ExplainPlan（SQL 計畫樹）分開：Mongo 階段的指標（keys/docs examined）與 SQL 成本模型不同。

// 各 stage 的語意配色：綠 = 用到索引、紅 = 全掃、琥珀 = 記憶體排序、灰 = 中性。
function stageColor(s: MongoPlanStage): string {
  if (s.stage === "COLLSCAN") return "text-red-400 border-red-400/40 bg-red-500/10";
  if (s.stage === "IXSCAN" || s.stage === "IDHACK" || s.stage === "DISTINCT_SCAN" || s.stage === "COUNT_SCAN")
    return "text-emerald-400 border-emerald-400/40 bg-emerald-500/10";
  if (s.stage === "SORT") return "text-amber-300 border-amber-300/40 bg-amber-500/10";
  return "text-fg/70 border-fg/15 bg-fg/5";
}

function StageNode({ node, depth }: { node: MongoPlanStage; depth: number }) {
  const t = useT();
  const metrics: string[] = [];
  if (node.nReturned !== undefined) metrics.push(t("回傳 {nReturned}", { nReturned: node.nReturned }));
  if (node.keysExamined !== undefined) metrics.push(t("鍵掃描 {keysExamined}", { keysExamined: node.keysExamined }));
  if (node.docsExamined !== undefined) metrics.push(t("文件掃描 {docsExamined}", { docsExamined: node.docsExamined }));
  if (node.executionTimeMillis !== undefined) metrics.push(`${node.executionTimeMillis} ms`);
  return (
    <div style={{ marginLeft: depth * 16 }} className="space-y-1">
      <div className={`inline-flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-xs ${stageColor(node)}`}>
        {node.shard && (
          <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">{node.shard}</span>
        )}
        <span className="mono font-semibold">{node.stage}</span>
        {node.stage === "COLLSCAN" && <span className="text-[10px]">{t("全集合掃描")}</span>}
        {node.stage === "SORT" && <span className="text-[10px]">{t("記憶體排序（無索引支撐）")}</span>}
        {node.detail && <span className="mono text-[11px] opacity-80">{node.detail}</span>}
        {metrics.length > 0 && <span className="text-[11px] opacity-70">{metrics.join(" · ")}</span>}
      </div>
      {node.children.map((c, i) => (
        <StageNode key={i} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function MongoExplain({ model, raw }: { model: MongoExplainModel; raw: string }) {
  const t = useT();
  const [showRaw, setShowRaw] = useState(false);
  const s = model.summary;
  // 掃描比 = docsExamined ÷ nReturned：>10 代表大量掃描才換到一筆結果（索引缺失的典型徵兆）。
  const ratio =
    s && s.nReturned !== null && s.nReturned > 0 && s.docsExamined !== null
      ? s.docsExamined / s.nReturned
      : null;
  return (
    <div className="space-y-3 p-3 text-sm">
      {(model.ns || model.server) && (
        <div className="text-[11px] text-fg/40 mono">
          {model.ns}
          {model.ns && model.server ? " @ " : ""}
          {model.server}
        </div>
      )}
      {s ? (
        <div className="flex flex-wrap gap-2 text-xs">
          {([
            [t("回傳文件"), s.nReturned],
            [t("鍵掃描"), s.keysExamined],
            [t("文件掃描"), s.docsExamined],
          ] as const).map(([label, v]) =>
            v === null ? null : (
              <span key={label} className="rounded bg-elevated border border-fg/10 px-2 py-1">
                {label} <span className="mono font-semibold">{v}</span>
              </span>
            ),
          )}
          {s.executionTimeMillis !== null && (
            <span className="rounded bg-elevated border border-fg/10 px-2 py-1">
              {t("耗時")} <span className="mono font-semibold">{s.executionTimeMillis} ms</span>
            </span>
          )}
          {ratio !== null && (
            <span
              title={t("文件掃描 ÷ 回傳：>10 表示大量掃描才換到一筆結果，通常代表缺索引")}
              className={`rounded border px-2 py-1 ${ratio > 10 ? "border-amber-300/40 bg-amber-500/10 text-amber-300" : "border-fg/10 bg-elevated"}`}
            >
              {t("掃描比")} <span className="mono font-semibold">{ratio.toFixed(1)}×</span>
            </span>
          )}
          {s.collscan ? (
            <span className="rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-red-400">COLLSCAN</span>
          ) : s.indexes.length > 0 ? (
            <span className="rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-emerald-400">
              {t("索引")} {s.indexes.join(", ")}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="text-xs text-fg/45">
          {t("verbosity=queryPlanner：僅計畫、未實際執行（無統計）。要看實際掃描數請改用 executionStats。")}
        </div>
      )}
      <StageNode node={model.root} depth={0} />
      <div>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="text-[11px] text-fg/40 hover:text-fg/70 underline underline-offset-2"
        >
          {showRaw ? t("隱藏原始 JSON") : t("顯示原始 JSON")}
        </button>
        {showRaw && (
          <pre className="mt-2 max-h-[40vh] overflow-auto rounded bg-well p-2 text-[11px] mono whitespace-pre-wrap break-all">
            {(() => {
              try {
                return JSON.stringify(JSON.parse(raw), null, 2);
              } catch {
                return raw;
              }
            })()}
          </pre>
        )}
      </div>
    </div>
  );
}
