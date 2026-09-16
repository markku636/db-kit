import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Ban, CheckCircle2, Download, Eye, FunctionSquare, GitCompareArrows, Loader2,
  MinusCircle, PlusCircle, Sparkles, Square, Table2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type DbKind, type DbSchema, type SchemaDiff, type SyncStatement } from "./api";
import { useStore } from "./store";
import { pickSaveFile, toast } from "./ui";
import { Button, EmptyState, Icon, Modal, Segmented } from "./ui/index";
import {
  buildAiSummaryPrompt, buildCompareRows, describeDiffForAi, summarizeRows,
  type CompareRow, type CompareTarget, type RowStatus,
} from "./compareModel";
import { buildCompareHtml, buildCompareJson, buildCompareMarkdown, STATUS_LABEL, type CompareReport } from "./compareReport";
import { useCompareRun } from "./useCompareRun";
import { useAiSummary } from "./useAiSummary";
import CompareTargetPicker from "./CompareTargetPicker";
import TableCompareView from "./TableCompareView";
import SchemaDiffView from "./SchemaDiffView";
import SyncScriptPanel, { type StatementOutcome } from "./SyncScriptPanel";
import { useT } from "./i18n";

const STATUS_ICON: Record<RowStatus, { icon: LucideIcon; cls: string }> = {
  identical: { icon: CheckCircle2, cls: "text-emerald-400" },
  differs: { icon: AlertTriangle, cls: "text-amber-300" },
  source_only: { icon: PlusCircle, cls: "text-green-300" },
  target_only: { icon: MinusCircle, cls: "text-red-300" },
  pending: { icon: Ban, cls: "text-fg/20" },
  running: { icon: Loader2, cls: "text-accent animate-spin" },
};
const OBJ_ICON: Record<CompareRow["objType"], LucideIcon> = { table: Table2, view: Eye, routine: FunctionSquare };

/**
 * 整庫結構比對（對標 Navicat 的 Structure Synchronization）。
 * 目標可以是同連線的另一個庫、**另一條連線**的庫，或一份結構快照檔。
 * 只比結構：表 / 視圖 / 程序的欄位、索引、外鍵與定義；資料列比對不在這裡（CLI 的 `dbk compare data`）。
 */
export default function CompareDialog({ connId, kind, sourceDb, onClose, onUse }: {
  connId: string;
  kind: DbKind;
  sourceDb: string;
  onClose: () => void;
  onUse: (sql: string, targetConnId: string) => void;
}) {
  const t = useT();
  const connections = useStore((s) => s.connections);
  const srcName = connections.find((c) => c.id === connId)?.name ?? connId;
  const srcLabel = `${srcName} · ${sourceDb}`;

  const [target, setTarget] = useState<CompareTarget>({ mode: "live", connId, db: "", table: undefined });
  const [srcTables, setSrcTables] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<RowStatus | "all">("all");
  const [hideIdentical, setHideIdentical] = useState(true);

  const run = useCompareRun();
  const ai = useAiSummary();
  const [phase, setPhase] = useState<"idle" | "capture" | "diff" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    target: CompareTarget; src: DbSchema; dst: DbSchema; diff: SchemaDiff;
    statements: SyncStatement[]; skipped: string[];
  } | null>(null);
  const [drill, setDrill] = useState<CompareRow | null>(null);
  const [reportFmt, setReportFmt] = useState<"md" | "html" | "json">("md");

  useEffect(() => {
    api.listTables(connId, sourceDb)
      .then((ts) => {
        const names = ts.filter((x) => x.kind === "table").map((x) => x.name);
        setSrcTables(names);
        setPicked(new Set(names));
      })
      .catch((e) => toast.error(e?.message ?? t("讀取資料表失敗")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, sourceDb]);

  const dstConnId = target.mode === "live" ? target.connId : null;
  const dstName = target.mode === "live" ? connections.find((c) => c.id === target.connId)?.name ?? "" : "";
  const dstLabel = target.mode === "live"
    ? `${dstName} · ${target.db}`
    : target.schema ? t("快照 · {db}", { db: target.schema.database }) : t("快照");
  const crossConn = target.mode === "live" && target.connId !== connId;
  const sameDb = target.mode === "live" && target.connId === connId && target.db === sourceDb;
  const ready = (target.mode === "live" ? !!target.db && !sameDb : !!target.schema) && picked.size > 0;

  const compare = async () => {
    if (!ready || run.running) return;
    setErr(null);
    setResult(null);
    setDrill(null);
    ai.reset();
    const tables = srcTables.filter((x) => picked.has(x));
    try {
      await run.start(async (runId) => {
        setPhase("capture");
        const src = await api.captureSchema(runId, connId, sourceDb, srcLabel);
        const dst = target.mode === "live"
          ? await api.captureSchema(runId, target.connId, target.db, dstLabel)
          : target.schema!;
        setPhase("diff");
        const diff = await api.diffSchema(src, dst);
        let statements: SyncStatement[] = [];
        let skipped: string[] = [];
        if (!diff.cross_engine) {
          // 同步範圍＝勾選的表 ∪ 兩側的視圖 / 程序（後者不在表清單裡，不該被勾選框篩掉）。
          const scope = [...tables, ...src.views.map((v) => v.name), ...dst.views.map((v) => v.name),
            ...diff.tables_removed];
          const sc = await api.generateSchemaSync(src, dst, undefined, { include_drops: true, include_routines: true }, scope);
          statements = sc.statements;
          skipped = sc.skipped;
        }
        setResult({ target, src, dst, diff, statements, skipped });
        setPhase("done");
      });
    } catch (e: any) {
      setErr(e?.message ?? t("比對失敗"));
      setPhase("idle");
    }
  };

  const runningTable = run.running && run.progress?.phase === "capture" ? run.progress.table : null;
  const rows = useMemo(() => buildCompareRows(result?.diff ?? null, picked, runningTable), [result, picked, runningTable]);
  const counts = useMemo(() => summarizeRows(rows), [rows]);
  const visibleTables = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? srcTables.filter((x) => x.toLowerCase().includes(f)) : srcTables;
  }, [srcTables, filter]);
  const visibleRows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows.filter((r) =>
      (statusFilter === "all" ? !(hideIdentical && r.status === "identical") : r.status === statusFilter)
      && (!f || r.name.toLowerCase().includes(f)));
  }, [rows, filter, statusFilter, hideIdentical]);
  const toggle = (name: string) => setPicked((p) => { const n = new Set(p); n.has(name) ? n.delete(name) : n.add(name); return n; });

  const execute = async (stmts: SyncStatement[]): Promise<StatementOutcome[]> => {
    if (!result || result.target.mode !== "live") return [];
    const dstId = result.target.connId;
    const out: StatementOutcome[] = [];
    for (let i = 0; i < stmts.length; i++) {
      try {
        await api.execDdl(dstId, stmts[i].sql);
        out.push({ index: i, ok: true });
      } catch (e: any) {
        out.push({ index: i, ok: false, error: e?.message ?? String(e) });
      }
    }
    const fails = out.filter((o) => !o.ok).length;
    if (fails === 0) toast.success(t("已成功執行 {ok} 句", { ok: out.length }));
    else toast.error(t("執行完成：{ok} 句成功，{fail} 句失敗", { ok: out.length - fails, fail: fails }));
    return out;
  };

  const summarize = () => {
    if (!result) return;
    ai.run(buildAiSummaryPrompt(describeDiffForAi(result.diff, srcLabel, dstLabel, result.statements, result.skipped)));
  };

  const exportReport = async () => {
    if (!result) return;
    const rep: CompareReport = {
      source: srcLabel, target: dstLabel, generatedAt: Date.now(), rows,
      schema: result.diff, statements: result.statements, skipped: result.skipped,
      aiSummary: ai.text || null,
    };
    const content = reportFmt === "md" ? buildCompareMarkdown(rep) : reportFmt === "html" ? buildCompareHtml(rep) : buildCompareJson(rep);
    const ext = reportFmt === "md" ? "md" : reportFmt;
    const path = await pickSaveFile(`${sourceDb}-compare.${ext}`, [{ name: reportFmt.toUpperCase(), extensions: [ext] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, content);
      toast.success(t("已匯出比對報告 → {path}", { path }));
    } catch (e: any) {
      toast.error(e?.message ?? t("儲存失敗"));
    }
  };

  const phaseText = phase === "capture"
    ? t("擷取結構中… {i}/{n}", { i: run.progress?.table_index ?? 0, n: run.progress?.table_count ?? 0 })
    : phase === "diff" ? t("比對結構中…") : "";

  return (
    <Modal onClose={onClose} title={<>{t("結構比對 ·")} <span className="mono text-fg/60">{sourceDb}</span></>}
      icon={GitCompareArrows} size="full" zClass="z-[95]" codeZoom className="h-[86vh]" bodyClassName="p-0 flex flex-col min-h-0"
      footer={<>
        <span className="mr-auto text-[11px] text-fg/40">
          {result && (
            <>
              {STATUS_LABEL.identical()} {counts.identical} · {STATUS_LABEL.differs()} {counts.differs}
              {" · "}{STATUS_LABEL.source_only()} {counts.source_only} · {STATUS_LABEL.target_only()} {counts.target_only}
            </>
          )}
        </span>
        <Segmented size="sm" ariaLabel={t("報告格式")} value={reportFmt} onChange={setReportFmt}
          options={[{ value: "md", label: "Markdown" }, { value: "html", label: "HTML" }, { value: "json", label: "JSON" }]} />
        <Button icon={Download} disabled={!result} onClick={exportReport}>{t("匯出報告…")}</Button>
        <Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>
      </>}>
      {/* 工具列：來源 → 目標 → 比對 */}
      <div className="px-4 py-3 border-b border-fg/10 space-y-2">
        <div className="flex items-start gap-2 flex-wrap text-sm">
          <span className="mono text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 shrink-0 mt-1">{t("來源：")}{srcLabel}</span>
          <span className="text-fg/40 text-xs shrink-0 mt-1.5">{t("→ 目標")}</span>
          <div className="flex-1 min-w-[22rem]">
            <CompareTargetPicker srcConnId={connId} srcKind={kind} srcDb={sourceDb} withTable={false} allowSnapshot
              value={target} onChange={setTarget} disabled={run.running} />
          </div>
          <span className="flex items-center gap-2 mt-1">
            {run.running && <Button variant="danger" size="sm" icon={Square} onClick={run.cancel}>{t("取消")}</Button>}
            <Button variant="primary" icon={GitCompareArrows} loading={run.running} disabled={!ready || run.running} onClick={compare}>
              {run.running ? t("比對中…") : t("比對選取的 {n} 表", { n: picked.size })}
            </Button>
          </span>
        </div>
        {crossConn && !run.running && (
          <div className="text-[11px] text-fg/45">{t("跨連線比對：來源 {a}，目標 {b}（同步 SQL 會送到目標連線）", { a: srcName, b: dstName })}</div>
        )}
        {run.running && (
          <div className="space-y-1">
            <div className="h-1 rounded bg-fg/10 overflow-hidden">
              <div className="h-full bg-accent transition-[width] duration-300"
                style={{ width: run.progress && run.progress.table_count > 0 ? `${Math.round((run.progress.table_index / run.progress.table_count) * 100)}%` : "8%" }} />
            </div>
            <div className="text-[11px] text-fg/45 mono">{phaseText}</div>
          </div>
        )}
        {sameDb && <div className="text-xs text-red-400">{t("目標與來源是同一個資料庫，請改選其他連線或資料庫。")}</div>}
        {err && <div className="text-xs text-red-400 whitespace-pre-wrap break-words">{err}</div>}
        {result?.diff.cross_engine && <div className="text-xs text-amber-300">{t("兩側資料庫種類不同：型別僅以家族比對，且不產生同步 DDL。")}</div>}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 左：比對前是資料表多選、比對後是結果列 */}
        <div className="w-[20rem] shrink-0 border-r border-fg/10 flex flex-col min-h-0">
          <div className="p-2 space-y-1.5 border-b border-fg/10">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-fg/50">{result ? t("比對結果") : t("資料表（{a}/{b}）", { a: picked.size, b: srcTables.length })}</span>
              {!result && (
                <span className="flex items-center gap-2">
                  <button type="button" onClick={() => setPicked(new Set(srcTables))} className="text-accent hover:underline">{t("全選")}</button>
                  <button type="button" onClick={() => setPicked(new Set())} className="text-accent hover:underline">{t("全不選")}</button>
                </span>
              )}
            </div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("搜尋…")}
              className="w-full text-xs px-2 py-1 rounded border border-fg/15 bg-app outline-none" />
            {result && (
              <div className="flex items-center gap-2">
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as RowStatus | "all")}
                  className="flex-1 text-[11px] bg-well border border-fg/15 rounded px-1.5 py-0.5">
                  <option value="all">{t("全部狀態")}</option>
                  {(["differs", "source_only", "target_only", "identical"] as RowStatus[]).map((s) =>
                    <option key={s} value={s}>{STATUS_LABEL[s]()} ({counts[s]})</option>)}
                </select>
                {statusFilter === "all" && (
                  <label className="inline-flex items-center gap-1 text-[11px] text-fg/50 cursor-pointer select-none whitespace-nowrap">
                    <input type="checkbox" checked={hideIdentical} onChange={(e) => setHideIdentical(e.target.checked)} />
                    {t("隱藏相同")}
                  </label>
                )}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-auto p-1">
            {!result
              ? visibleTables.map((name) => (
                <label key={name} className="flex items-center gap-2 px-2 py-0.5 text-xs hover:bg-fg/5 cursor-pointer">
                  <input type="checkbox" checked={picked.has(name)} onChange={() => toggle(name)} disabled={run.running} />
                  <Icon icon={Table2} size={12} className="text-fg/30" />
                  <span className="truncate flex-1 mono">{name}</span>
                  {runningTable === name && <Icon icon={Loader2} size={11} className="animate-spin text-accent" />}
                </label>
              ))
              : visibleRows.map((r) => {
                const st = STATUS_ICON[r.status];
                const active = drill?.name === r.name && drill?.objType === r.objType;
                return (
                  <button type="button" key={`${r.objType}:${r.name}`} onClick={() => setDrill(active ? null : r)} title={r.detail}
                    className={`w-full flex items-center gap-2 px-2 py-0.5 text-xs rounded text-left ${active ? "bg-accent/15" : "hover:bg-fg/5"}`}>
                    <Icon icon={st.icon} size={12} className={st.cls} />
                    <Icon icon={OBJ_ICON[r.objType]} size={11} className="text-fg/25" />
                    <span className="truncate flex-1 mono">{r.name}</span>
                  </button>
                );
              })}
            {result && visibleRows.length === 0 && (
              <div className="px-2 py-3 text-xs text-fg/40">
                {counts.differs + counts.source_only + counts.target_only === 0 ? t("兩邊結構一致。") : t("無相符物件")}
              </div>
            )}
          </div>
        </div>

        {/* 右：drill-in 或彙總 */}
        <div className="flex-1 min-w-0 overflow-auto p-4">
          {!result && !run.running && (
            <EmptyState icon={GitCompareArrows} title={t("選擇目標後按「比對」")}
              hint={t("目標可以是同一條連線的其他資料庫、另一條連線，或一份結構快照檔。差異以來源為基準：僅來源有 = 目標需新增，僅目標有 = 目標多出。")} />
          )}
          {result && drill && drill.objType === "table" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Icon icon={Table2} size={14} className="text-fg/40" /><span className="mono">{drill.name}</span>
                <button type="button" className="ml-auto text-xs text-accent hover:underline" onClick={() => setDrill(null)}>{t("回到彙總")}</button>
              </div>
              <TableCompareView key={drill.name} srcConnId={connId} srcDb={sourceDb} srcTable={drill.name} target={result.target}
                dstTable={drill.name} srcLabel={srcLabel} dstLabel={dstLabel}
                preloaded={{ src: result.src, dst: result.dst }} onUse={onUse} autoRun />
            </div>
          )}
          {result && drill && drill.objType !== "table" && (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Icon icon={OBJ_ICON[drill.objType]} size={14} className="text-fg/40" /><span className="mono">{drill.name}</span>
                <span className="text-xs text-fg/50">{STATUS_LABEL[drill.status]()}</span>
                <button type="button" className="ml-auto text-xs text-accent hover:underline" onClick={() => setDrill(null)}>{t("回到彙總")}</button>
              </div>
              <TextDrill diff={result.diff} row={drill} srcLabel={srcLabel} dstLabel={dstLabel} />
            </div>
          )}
          {result && !drill && (
            <div className="space-y-3">
              <div className="text-xs text-fg/50">
                {t("{n} 個物件；點左側任一列可查看該表的欄位 / 索引 / 外鍵差異。", { n: rows.length })}
              </div>

              {/* AI 總結 */}
              <div className="rounded border border-fg/10 bg-inset p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Icon icon={Sparkles} size={13} className="text-accent" />
                  <span className="text-fg/70">{t("AI 總結")}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {ai.running && <Button size="sm" variant="danger" onClick={ai.cancel}>{t("停止")}</Button>}
                    <Button size="sm" icon={Sparkles} loading={ai.running} disabled={ai.running || counts.differs + counts.source_only + counts.target_only === 0}
                      onClick={summarize}>{ai.text ? t("重新產生") : t("產生總結")}</Button>
                  </span>
                </div>
                {ai.error && <div className="text-[11px] text-red-400 whitespace-pre-wrap">{ai.error}</div>}
                {ai.text
                  ? <div className="text-xs text-fg/80 whitespace-pre-wrap leading-relaxed">{ai.text}</div>
                  : !ai.running && <div className="text-[11px] text-fg/35">{t("用目前設定的 AI 供應商，把差異總結成風險與執行建議（不會送出資料內容，只送結構差異摘要）。")}</div>}
              </div>

              <SyncScriptPanel statements={result.statements} skipped={result.skipped}
                header={t("同步：{src} → {dst}", { src: srcLabel, dst: dstLabel })}
                dstConnId={result.target.mode === "live" ? result.target.connId : null} dstLabel={dstLabel}
                onSend={dstConnId ? (sql) => onUse(sql, dstConnId) : undefined}
                onExecute={result.target.mode === "live" ? execute : undefined} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** 視圖 / 程序的定義文字 drill-in：以並排文字 diff 呈現。 */
function TextDrill({ diff, row, srcLabel, dstLabel }: { diff: SchemaDiff; row: CompareRow; srcLabel: string; dstLabel: string }) {
  const t = useT();
  const tc = row.objType === "view"
    ? diff.views_changed.find((v) => v.name === row.name)
    : [...diff.routines_changed, ...diff.routines_added, ...diff.routines_removed].find((r) => r.name === row.name);
  if (!tc) return <div className="text-xs text-fg/40">{t("此物件僅一側存在或無定義可比對。")}</div>;
  return <SchemaDiffView text={tc} srcLabel={srcLabel} dstLabel={dstLabel} />;
}
