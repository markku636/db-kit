import { useState } from "react";
import { AlertTriangle, Check, Wand2, X } from "lucide-react";
import { useT } from "./i18n";
import { asOutcome, summarizeOutcome, type ExpandedStep, type SpStepOutcome } from "./spTestModel";

/** 結果集（最多 20 列）的小表格。 */
function MiniTable({ columns, rows }: { columns: string[]; rows: (string | null)[][] }) {
  const t = useT();
  if (rows.length === 0) return <div className="text-fg/50 italic">{t("（0 列）")}</div>;
  return (
    <div className="overflow-auto max-h-48 border border-line/50 rounded">
      <table className="text-xs font-mono">
        <thead className="bg-fg/5 sticky top-0"><tr>{columns.map((c, i) => <th key={`${i}:${c}`} className="px-2 py-0.5 text-left font-medium text-fg/60">{c}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, 20).map((r, i) => (
            // 結果集列沒有穩定 id，且不會重排（唯讀呈現）——用位置當 key 是安全的。
            <tr key={i} className="border-t border-line/30">{r.map((v, j) => <td key={`${j}:${columns[j] ?? ""}`} className="px-2 py-0.5 whitespace-nowrap">{v ?? <span className="text-fg/40">NULL</span>}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > 20 && <div className="px-2 py-0.5 text-fg/50">{t("…共 {n} 列", { n: rows.length })}</div>}
    </div>
  );
}

function hasEffect(o: SpStepOutcome): boolean {
  return (o.effects ?? []).some((e) => e.inserted.length + e.updated.length + e.deleted.length > 0);
}

/** 一步在一個引擎上的完整輸出：錯誤、每個結果集、OUT、副作用前後像。 */
function OutcomeDetail({ o }: { o: SpStepOutcome }) {
  const t = useT();
  const sets = o.result_sets ?? [];
  const out = Object.entries(o.out ?? {});
  const effects = (o.effects ?? []).filter((e) => e.inserted.length + e.updated.length + e.deleted.length > 0);
  if (!o.error && sets.length === 0 && out.length === 0 && !hasEffect(o)) {
    return <div className="text-fg/50 italic">{t("沒有結果集、OUT 參數或副作用")}</div>;
  }
  return (
    <div className="space-y-1">
      {o.error && <div className="text-warning">{o.error.class}{o.error.code ? ` (${o.error.code})` : ""}：{o.error.message}</div>}
      {sets.map((rs, k) => (
        <div key={`set-${k}:${rs.columns.join(",")}`}>
          <div className="text-fg/50">{t("結果集 #{n}", { n: k + 1 })}</div>
          <MiniTable columns={rs.columns} rows={rs.rows} />
        </div>
      ))}
      {out.length > 0 && <div className="font-mono">{out.map(([k, v]) => <div key={k}>OUT {k} = {v ?? "NULL"}</div>)}</div>}
      {effects.map((e) => (
        <div key={e.table}>
          <div className="text-fg/50">{t("副作用 {table}：新增 {ins}、更新 {upd}、刪除 {del}", { table: e.table, ins: e.inserted.length, upd: e.updated.length, del: e.deleted.length })}</div>
          {e.inserted.length > 0 && <MiniTable columns={e.columns} rows={e.inserted} />}
          {e.updated.length > 0 && <MiniTable columns={["", ...e.columns]} rows={e.updated.flatMap(([b, a]) => [[t("前"), ...b], [t("後"), ...a]])} />}
          {e.deleted.length > 0 && <MiniTable columns={e.columns} rows={e.deleted} />}
        </div>
      ))}
    </div>
  );
}

export interface SpTestStepRowProps {
  label: string;
  /** 引擎標籤 → 後端 StepOutcome（diff 模式兩個）。 */
  outcomes: Record<string, unknown>;
  differenceCount: number;
  /** 測試檔裡對應的步驟（來源 fixture、程序名 / SQL）；檔案解析不了時沒有。 */
  source?: ExpandedStep;
  /** 有給才顯示「採用實際值」。 */
  onAdopt?: (o: SpStepOutcome) => void;
}

/**
 * 結果分頁裡的一步：狀態圖示、步驟名、來源、實際輸出的一行摘要；點開看完整輸出。
 * ✓ = 沒有差異；⚠ = 出錯但是預期中的（或差分兩邊都錯）；✗ = 有差異。
 */
export default function SpTestStepRow({ label, outcomes, differenceCount, source, onAdopt }: SpTestStepRowProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const list = Object.entries(outcomes)
    .map(([eng, v]) => [eng, asOutcome(v)] as const)
    .filter((x): x is readonly [string, SpStepOutcome] => x[1] !== null);
  const anyErr = list.some(([, o]) => o.error);
  const describe = (o: SpStepOutcome) => {
    const sum = summarizeOutcome(o);
    const parts: string[] = [];
    if (sum.error) parts.push(t("錯誤 {cls}：{msg}", { cls: sum.error.class, msg: sum.error.message.split("\n")[0].slice(0, 80) }));
    if (sum.sets.length) parts.push(t("結果集 {sets}", { sets: sum.sets.map((n) => t("{n} 列", { n })).join(" + ") }));
    if (sum.out.length) parts.push(`OUT ${sum.out.map(([k, v]) => `${k}=${v ?? "NULL"}`).join(", ")}`);
    if (sum.returnCode !== null) parts.push(`return ${sum.returnCode}`);
    for (const e of sum.effects) parts.push(`${e.table} ${[e.ins && `+${e.ins}`, e.upd && `~${e.upd}`, e.del && `-${e.del}`].filter(Boolean).join(" ")}`);
    return parts.join(" · ");
  };
  let icon = <Check size={13} className="text-success shrink-0" />;
  if (differenceCount > 0) icon = <X size={13} className="text-danger shrink-0" />;
  else if (anyErr) icon = <AlertTriangle size={13} className="text-warning shrink-0" />;
  const single = list.length === 1 ? list[0][1] : null;

  return (
    <div className="border-t border-line/30" data-sp-step={label}>
      <div className="flex items-center gap-2 py-1 pl-1 pr-2 hover:bg-fg/5 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        {icon}
        <span className="font-mono whitespace-nowrap">{label}</span>
        {source && <span className="text-fg/60 truncate max-w-[16rem]" title={source.target}>{source.fixture ? `[${source.fixture}] ` : ""}{source.target}</span>}
        <span className="text-fg/50 truncate flex-1 min-w-0">
          {list.map(([eng, o]) => (list.length > 1 ? `${eng}: ${describe(o)}` : describe(o))).join("　|　")}
        </span>
        {onAdopt && single && (
          <button type="button" className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-line hover:bg-fg/10 text-[11px]"
            title={t("把這一步的實際輸出寫成期望（寫進編輯器，未儲存）")} data-sp-adopt={label}
            onClick={(e) => { e.stopPropagation(); onAdopt(single); }}>
            <Wand2 size={11} />{t("採用實際值")}
          </button>
        )}
        <span className="shrink-0 text-fg/40 tabular-nums">{list[0]?.[1].elapsed_ms ?? 0} ms</span>
      </div>
      {open && (
        <div className="pl-6 pr-2 pb-2 space-y-2" data-sp-step-detail={label}>
          {list.map(([eng, o]) => (
            <div key={eng} className="space-y-1">
              {list.length > 1 && <div className="text-fg/60 font-medium">{eng}</div>}
              <OutcomeDetail o={o} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
