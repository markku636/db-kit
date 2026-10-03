import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle, ArrowDown, ArrowLeftRight, ArrowUp, Ban, CheckCircle2, ChevronDown, ChevronRight, Download, Eye, FunctionSquare,
  GitCompareArrows, Loader2, MinusCircle, PlusCircle, SlidersHorizontal, Sparkles, Square, Table2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type DbKind, type DbSchema, type SchemaDiff, type SyncStatement } from "./api";
import { useStore } from "./store";
import { pickSaveFile, toast } from "./ui";
import { Badge, Button, EmptyState, Icon, IconButton, Modal, Segmented, Splitter, useResizable } from "./ui/index";
import {
  buildAiSummaryPrompt, buildCompareRows, countNonDefaultOptions, describeDiffForAi, filterRows, parseCompareOptions, parseStatusFilter,
  rowKey, statementOwner, summarizeRows, toCaptureOptions, toDiffOptions, toSyncOptions,
  COMPARE_OPTIONS_KEY, DEFAULT_COMPARE_OPTIONS, FILTERABLE_STATUSES, STATUS_FILTER_KEY,
  type ChangeCounts, type CompareOptions, type CompareRow, type CompareTarget, type RowStatus,
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
const OBJ_TYPES: readonly CompareRow["objType"][] = ["table", "view", "routine"];

const hasDiff = (r: CompareRow) => r.status === "differs" || r.status === "source_only" || r.status === "target_only";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 忽略寫入失敗 */ } };

interface CompareResult {
  target: CompareTarget; src: DbSchema; dst: DbSchema; diff: SchemaDiff;
  statements: SyncStatement[]; skipped: string[]; opts: CompareOptions;
  /** 每跑一次 +1：drill-in 元件以它為 key，重新比對後細節才會跟著換。 */
  runNo: number;
}

/**
 * 整庫結構比對（對標 Navicat 的 Structure Synchronization / Redgate SQL Compare 的操作模式）。
 * 目標可以是同連線的另一個庫、**另一條連線**的庫，或一份結構快照檔；來源與目標可一鍵對調。
 * 左欄是物件清單：狀態晶片篩選、依類型分組、每列有差異摘要與「包含在同步腳本」的勾選框；
 * 右欄是彙總（AI 總結 + 同步腳本）或單一物件的 drill-in（上一個 / 下一個可直接跳）。
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
  const [source, setSource] = useState({ connId, db: sourceDb });
  const srcKind = connections.find((c) => c.id === source.connId)?.kind ?? kind;
  const srcName = connections.find((c) => c.id === source.connId)?.name ?? source.connId;
  const srcLabel = `${srcName} · ${source.db}`;

  const [target, setTarget] = useState<CompareTarget>({ mode: "live", connId, db: "", table: undefined });
  const [opts, setOpts] = useState<CompareOptions>(() => parseCompareOptions(lsGet(COMPARE_OPTIONS_KEY)));
  const [optsOpen, setOptsOpen] = useState(false);
  const [srcTables, setSrcTables] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [statusOn, setStatusOn] = useState<Set<RowStatus>>(() => parseStatusFilter(lsGet(STATUS_FILTER_KEY)));
  const [collapsed, setCollapsed] = useState<Set<CompareRow["objType"]>>(new Set());
  // 被排除在同步腳本外的物件（rowKey）。存「排除」而非「包含」：重新比對後新出現的物件預設就是包含。
  const [excludedObjs, setExcludedObjs] = useState<Set<string>>(new Set());

  const run = useCompareRun();
  const ai = useAiSummary();
  const [phase, setPhase] = useState<"idle" | "capture" | "diff" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [drill, setDrill] = useState<CompareRow | null>(null);
  const [reportFmt, setReportFmt] = useState<"md" | "html" | "json">("md");
  const left = useResizable({ storageKey: "dbkit:compare:leftWidth", initial: 340, min: 240, max: () => Math.max(320, window.innerWidth * 0.5), axis: "x" });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listTables(source.connId, source.db)
      .then((ts) => {
        const names = ts.filter((x) => x.kind === "table").map((x) => x.name);
        setSrcTables(names);
        setPicked(new Set(names));
      })
      .catch((e) => toast.error(e?.message ?? t("讀取資料表失敗")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.connId, source.db]);
  useEffect(() => lsSet(COMPARE_OPTIONS_KEY, JSON.stringify(opts)), [opts]);
  useEffect(() => lsSet(STATUS_FILTER_KEY, JSON.stringify([...statusOn])), [statusOn]);

  const dstConnId = target.mode === "live" ? target.connId : null;
  const dstName = target.mode === "live" ? connections.find((c) => c.id === target.connId)?.name ?? "" : "";
  const dstLabel = target.mode === "live"
    ? `${dstName} · ${target.db}`
    : target.schema ? t("快照 · {db}", { db: target.schema.database }) : t("快照");
  const crossConn = target.mode === "live" && target.connId !== source.connId;
  const sameDb = target.mode === "live" && target.connId === source.connId && target.db === source.db;
  const ready = (target.mode === "live" ? !!target.db && !sameDb : !!target.schema) && picked.size > 0;
  const canSwap = target.mode === "live" && !!target.db && !sameDb && !run.running;
  const optsStale = !!result && JSON.stringify(result.opts) !== JSON.stringify(opts);
  const nonDefault = countNonDefaultOptions(opts);

  // 來源與目標對調：改的是狀態，不必關掉對話框重開。結果與 drill-in 作廢（方向反了，腳本也反了）。
  const swap = () => {
    if (target.mode !== "live" || !canSwap) return;
    const next = { connId: target.connId, db: target.db };
    setTarget({ mode: "live", connId: source.connId, db: source.db, table: undefined });
    setSource(next);
    setResult(null);
    setDrill(null);
    setErr(null);
    setExcludedObjs(new Set());
    ai.reset();
  };

  // keep = true（套用同步後重跑）時舊結果留在畫面上直到新結果到手，畫面不會閃回空狀態。
  const compare = async (keep = false) => {
    if (!ready || run.running) return;
    setErr(null);
    if (!keep) { setResult(null); setDrill(null); }
    ai.reset();
    const tables = srcTables.filter((x) => picked.has(x));
    const o = opts;
    try {
      await run.start(async (runId) => {
        setPhase("capture");
        const src = await api.captureSchema(runId, source.connId, source.db, srcLabel, toCaptureOptions(o));
        const dst = target.mode === "live"
          ? await api.captureSchema(runId, target.connId, target.db, dstLabel, toCaptureOptions(o))
          : target.schema!;
        setPhase("diff");
        const diff = await api.diffSchema(src, dst, toDiffOptions(o));
        let statements: SyncStatement[] = [];
        let skipped: string[] = [];
        if (!diff.cross_engine) {
          // 同步範圍＝勾選的表 ∪ 兩側的視圖 / 程序（後者不在表清單裡，不該被勾選框篩掉）。
          const scope = [...tables, ...src.views.map((v) => v.name), ...dst.views.map((v) => v.name),
            ...diff.tables_removed];
          const sc = await api.generateSchemaSync(src, dst, toDiffOptions(o), toSyncOptions(o), scope);
          statements = sc.statements;
          skipped = sc.skipped;
        }
        setResult((prev) => ({ target, src, dst, diff, statements, skipped, opts: o, runNo: (prev?.runNo ?? 0) + 1 }));
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
  const diffTotal = counts.differs + counts.source_only + counts.target_only;
  const visibleTables = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? srcTables.filter((x) => x.toLowerCase().includes(f)) : srcTables;
  }, [srcTables, filter]);
  const visibleRows = useMemo(() => filterRows(rows, statusOn, filter), [rows, filter, statusOn]);
  const groups = useMemo(
    () => OBJ_TYPES.map((type) => ({ type, rows: visibleRows.filter((r) => r.objType === type), total: rows.filter((r) => r.objType === type).length }))
      .filter((g) => g.total > 0),
    [rows, visibleRows],
  );
  // 畫面上的順序（跳過收合的分組）：鍵盤 ↑↓ 與 drill-in 的上一個 / 下一個都照這個走。
  const navRows = useMemo(() => groups.flatMap((g) => (collapsed.has(g.type) ? [] : g.rows)), [groups, collapsed]);
  const drillIdx = drill ? navRows.findIndex((r) => rowKey(r) === rowKey(drill)) : -1;
  const excludedCount = useMemo(() => rows.filter((r) => hasDiff(r) && excludedObjs.has(rowKey(r))).length, [rows, excludedObjs]);

  const togglePicked = (name: string) => setPicked((p) => { const n = new Set(p); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const toggleObj = (r: CompareRow) => setExcludedObjs((p) => { const n = new Set(p); const k = rowKey(r); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const setGroupIncluded = (g: { rows: CompareRow[] }, on: boolean) =>
    setExcludedObjs((p) => { const n = new Set(p); for (const r of g.rows) if (hasDiff(r)) { on ? n.delete(rowKey(r)) : n.add(rowKey(r)); } return n; });
  const toggleStatus = (s: RowStatus) => setStatusOn((p) => {
    const n = new Set(p);
    if (n.has(s)) { if (n.size > 1) n.delete(s); } else n.add(s);
    return n;
  });
  const objectOn = useCallback((s: SyncStatement) => {
    const k = statementOwner(s, rows);
    return !k || !excludedObjs.has(k);
  }, [rows, excludedObjs]);

  const selectRow = (r: CompareRow | null) => {
    setDrill(r);
    if (r) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-compare-row="${CSS.escape(rowKey(r))}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const step = (delta: number) => {
    const n = navRows.length;
    if (!n) return;
    const i = drillIdx < 0 ? (delta > 0 ? 0 : n - 1) : (((drillIdx + delta) % n) + n) % n;
    selectRow(navRows[i]);
  };
  const onListKey = (e: ReactKeyboardEvent) => {
    if (!result || navRows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = drillIdx < 0 ? 0 : Math.min(navRows.length - 1, Math.max(0, drillIdx + (e.key === "ArrowDown" ? 1 : -1)));
      selectRow(navRows[i]);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      selectRow(navRows[e.key === "Home" ? 0 : navRows.length - 1]);
    } else if (e.key === " " && drill) {
      e.preventDefault();
      if (hasDiff(drill)) toggleObj(drill);
    } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
      e.preventDefault();
      setDrill(null);
    }
  };

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
    if (fails === 0) toast.success(t("已成功執行 {ok} 句，重新比對中…", { ok: out.length }));
    else toast.error(t("執行完成：{ok} 句成功，{fail} 句失敗", { ok: out.length - fails, fail: fails }));
    void compare(true); // 套用後重新比對，讓清單反映目前狀態（舊結果留著直到新結果到手）
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
    const path = await pickSaveFile(`${source.db}-compare.${ext}`, [{ name: reportFmt.toUpperCase(), extensions: [ext] }]);
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
  const GROUP_LABEL: Record<CompareRow["objType"], string> = { table: t("資料表"), view: t("視圖"), routine: t("程序 / 函式") };

  return (
    <Modal onClose={onClose} title={<>{t("結構比對 ·")} <span className="mono text-fg/60">{source.db}</span></>}
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
      {/* 工具列：來源 ⇄ 目標 → 選項 → 比對 */}
      <div className="px-4 py-2.5 border-b border-fg/10 space-y-2">
        <div className="flex items-start gap-2 flex-wrap text-sm">
          <span className="mono text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 shrink-0 mt-1" data-compare-source>{t("來源：")}{srcLabel}</span>
          <IconButton icon={ArrowLeftRight} label={t("交換來源與目標")} iconSize={14} box="w-6 h-6" className="mt-0.5" disabled={!canSwap} onClick={swap} />
          <span className="text-fg/40 text-xs shrink-0 mt-1.5">{t("目標")}</span>
          <div className="flex-1 min-w-[22rem]">
            <CompareTargetPicker srcConnId={source.connId} srcKind={srcKind} srcDb={source.db} withTable={false} allowSnapshot
              value={target} onChange={setTarget} disabled={run.running} />
          </div>
          <span className="flex items-center gap-2 mt-1">
            <span className="relative">
              <Button icon={SlidersHorizontal} disabled={run.running} onClick={() => setOptsOpen((v) => !v)} aria-expanded={optsOpen}>
                {t("選項")}{nonDefault > 0 && <Badge tone="accent">{nonDefault}</Badge>}
              </Button>
              {optsOpen && (
                <Popover onClose={() => setOptsOpen(false)}>
                  <CompareOptionsForm value={opts} onChange={setOpts} />
                </Popover>
              )}
            </span>
            {run.running && <Button variant="danger" size="sm" icon={Square} onClick={run.cancel}>{t("取消")}</Button>}
            <Button variant="primary" icon={GitCompareArrows} loading={run.running} disabled={!ready || run.running} onClick={() => compare()}>
              {run.running ? t("比對中…") : result ? t("重新比對") : t("比對選取的 {n} 表", { n: picked.size })}
            </Button>
          </span>
        </div>
        {crossConn && !run.running && (
          <div className="text-[11px] text-fg/45">{t("跨連線比對：來源 {a}，目標 {b}（同步 SQL 會送到目標連線）", { a: srcName, b: dstName })}</div>
        )}
        {optsStale && !run.running && <div className="text-[11px] text-amber-300">{t("比對選項已變更，按「重新比對」才會套用。")}</div>}
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
        {/* 左：比對前是資料表多選、比對後是分組的結果列（狀態晶片篩選 + 物件勾選） */}
        <div className="shrink-0 flex flex-col min-h-0" style={{ width: left.size }}>
          <div className="p-2 space-y-1.5 border-b border-fg/10">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-fg/50">{result ? t("比對結果") : t("資料表（{a}/{b}）", { a: picked.size, b: srcTables.length })}</span>
              {!result ? (
                <span className="flex items-center gap-2">
                  <button type="button" onClick={() => setPicked(new Set(srcTables))} className="text-accent hover:underline">{t("全選")}</button>
                  <button type="button" onClick={() => setPicked(new Set())} className="text-accent hover:underline">{t("全不選")}</button>
                </span>
              ) : (
                <button type="button" disabled={run.running} onClick={() => { setResult(null); setDrill(null); ai.reset(); }} className="text-accent hover:underline disabled:opacity-40">{t("重選資料表")}</button>
              )}
            </div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("搜尋…")}
              className="w-full text-xs px-2 py-1 rounded border border-fg/15 bg-app outline-none" />
            {result && (
              <div className="flex items-center gap-1 flex-wrap" role="group" aria-label={t("依狀態篩選")}>
                {FILTERABLE_STATUSES.map((s) => {
                  const on = statusOn.has(s);
                  const st = STATUS_ICON[s];
                  return (
                    <button key={s} type="button" role="checkbox" aria-checked={on} onClick={() => toggleStatus(s)} data-status-chip={s}
                      className={`inline-flex items-center gap-1 h-6 px-1.5 rounded-full border text-[11px] tabular-nums transition-colors ${
                        on ? "bg-fg/10 border-fg/20 text-fg/85" : "border-fg/10 text-fg/40 hover:text-fg/70 hover:bg-fg/5"}`}>
                      <Icon icon={st.icon} size={11} className={on ? st.cls : "opacity-50"} />
                      {STATUS_LABEL[s]()}
                      <span className="text-fg/45">{counts[s]}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div ref={listRef} tabIndex={0} onKeyDown={onListKey} aria-label={t("比對結果")}
            className="flex-1 overflow-auto p-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
            {!result
              ? visibleTables.map((name) => (
                <label key={name} className="flex items-center gap-2 px-2 h-6 text-xs hover:bg-fg/5 cursor-pointer">
                  <input type="checkbox" checked={picked.has(name)} onChange={() => togglePicked(name)} disabled={run.running} />
                  <Icon icon={Table2} size={12} className="text-fg/30" />
                  <span className="truncate flex-1 mono">{name}</span>
                  {runningTable === name && <Icon icon={Loader2} size={11} className="animate-spin text-accent" />}
                </label>
              ))
              : groups.map((g) => {
                const isCollapsed = collapsed.has(g.type);
                const diffRows = g.rows.filter(hasDiff);
                const onCount = diffRows.filter((r) => !excludedObjs.has(rowKey(r))).length;
                return (
                  <div key={g.type} className="mb-1">
                    <div className="flex items-center gap-1 px-1 h-6 text-[11px] text-fg/55 select-none">
                      <button type="button" className="flex items-center gap-1 flex-1 min-w-0 text-left hover:text-fg/85"
                        onClick={() => setCollapsed((p) => { const n = new Set(p); n.has(g.type) ? n.delete(g.type) : n.add(g.type); return n; })}>
                        <Icon icon={isCollapsed ? ChevronRight : ChevronDown} size={12} />
                        <Icon icon={OBJ_ICON[g.type]} size={11} className="text-fg/35" />
                        <span>{GROUP_LABEL[g.type]}</span>
                        <span className="text-fg/35 tabular-nums">{g.rows.length}{g.rows.length !== g.total ? ` / ${g.total}` : ""}</span>
                      </button>
                      {diffRows.length > 0 && (
                        <TriCheckbox checked={onCount === diffRows.length} indeterminate={onCount > 0 && onCount < diffRows.length}
                          onChange={(on) => setGroupIncluded({ rows: g.rows }, on)} title={t("包含 / 排除這一組全部物件")} />
                      )}
                    </div>
                    {!isCollapsed && g.rows.map((r) => {
                      const st = STATUS_ICON[r.status];
                      const active = !!drill && rowKey(drill) === rowKey(r);
                      const diffy = hasDiff(r);
                      const inc = !excludedObjs.has(rowKey(r));
                      return (
                        <div key={rowKey(r)} data-compare-row={rowKey(r)}
                          className={`flex items-center gap-1.5 pl-2 pr-1.5 h-6 rounded text-xs ${active ? "bg-accent/15" : "hover:bg-fg/5"} ${diffy && !inc ? "opacity-50" : ""}`}>
                          <input type="checkbox" data-compare-include={r.name} checked={diffy && inc} disabled={!diffy} onChange={() => toggleObj(r)}
                            title={diffy ? t("包含在同步腳本") : t("結構相同，無需同步")} />
                          <button type="button" onClick={() => selectRow(active ? null : r)} title={r.detail}
                            className="flex-1 min-w-0 flex items-center gap-1.5 text-left">
                            <Icon icon={st.icon} size={12} className={st.cls} />
                            <span className="truncate flex-1 mono">{r.name}</span>
                            <ChangeBadges row={r} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            {result && visibleRows.length === 0 && (
              <div className="px-2 py-3 text-xs text-fg/40">
                {diffTotal === 0 ? t("兩邊結構一致。") : t("無相符物件")}
              </div>
            )}
          </div>
        </div>
        <Splitter axis="x" onPointerDown={left.onPointerDown} />

        {/* 右：drill-in 或彙總 */}
        <div className="flex-1 min-w-0 overflow-auto p-4">
          {!result && !run.running && (
            <EmptyState icon={GitCompareArrows} title={t("選擇目標後按「比對」")}
              hint={t("目標可以是同一條連線的其他資料庫、另一條連線，或一份結構快照檔。差異以來源為基準：僅來源有 = 目標需新增，僅目標有 = 目標多出。按「⇄」可對調方向。")} />
          )}
          {result && drill && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Icon icon={OBJ_ICON[drill.objType]} size={14} className="text-fg/40" />
                <span className="mono">{drill.name}</span>
                <span className="text-xs text-fg/50">{STATUS_LABEL[drill.status]()}</span>
                <span className="ml-auto flex items-center gap-1">
                  <IconButton icon={ArrowUp} label={t("上一個物件")} iconSize={14} box="w-6 h-6" disabled={navRows.length < 2} onClick={() => step(-1)} />
                  <span className="text-[11px] tabular-nums text-fg/45" data-drill-pos>{drillIdx + 1} / {navRows.length}</span>
                  <IconButton icon={ArrowDown} label={t("下一個物件")} iconSize={14} box="w-6 h-6" disabled={navRows.length < 2} onClick={() => step(1)} />
                  <button type="button" className="ml-2 text-xs text-accent hover:underline" onClick={() => setDrill(null)}>{t("回到彙總")}</button>
                </span>
              </div>
              {drill.objType === "table" ? (
                <TableCompareView key={`${drill.name}:${result.runNo}`} srcConnId={source.connId} srcDb={source.db} srcTable={drill.name} target={result.target}
                  dstTable={drill.name} srcLabel={srcLabel} dstLabel={dstLabel}
                  preloaded={{ src: result.src, dst: result.dst }} onUse={onUse} autoRun />
              ) : (
                <TextDrill diff={result.diff} row={drill} srcLabel={srcLabel} dstLabel={dstLabel} />
              )}
            </div>
          )}
          {result && !drill && (
            <div className="space-y-3">
              <div className="text-xs text-fg/50">
                {t("{n} 個物件；點左側任一列可查看該表的欄位 / 索引 / 外鍵差異（↑↓ 移動、空白鍵切換包含）。", { n: rows.length })}
                {excludedCount > 0 && <span className="ml-1 text-amber-300">{t("已排除 {n} 個物件，其語句不會進同步腳本。", { n: excludedCount })}</span>}
              </div>

              {/* AI 總結 */}
              <div className="rounded border border-fg/10 bg-inset p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Icon icon={Sparkles} size={13} className="text-accent" />
                  <span className="text-fg/70">{t("AI 總結")}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {ai.running && <Button size="sm" variant="danger" onClick={ai.cancel}>{t("停止")}</Button>}
                    <Button size="sm" icon={Sparkles} loading={ai.running} disabled={ai.running || diffTotal === 0}
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
                onExecute={result.target.mode === "live" ? execute : undefined}
                objectOn={objectOn} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** 每列右側的差異摘要：有差異的表顯示欄 / 索引 / 外鍵的增刪改數，僅一側有的顯示會產生的動作。 */
function ChangeBadges({ row }: { row: CompareRow }) {
  const t = useT();
  if (row.status === "source_only") return <Badge tone="success" className="mono">CREATE</Badge>;
  if (row.status === "target_only") return <Badge tone="danger" className="mono">DROP</Badge>;
  if (row.status !== "differs") return null;
  const c = row.changes;
  if (!c) return <Badge tone="warning">{t("定義不同")}</Badge>;
  if (c.ddlOnly) return <span title={t("欄位 / 索引 / 外鍵相同，只有 DDL 文字不同")}><Badge tone="neutral" className="mono">DDL</Badge></span>;
  const part = (label: string, x: ChangeCounts) => (x.add + x.del + x.chg > 0 ? (
    <span key={label} className="inline-flex items-center gap-0.5 mono text-[10px] text-fg/50 tabular-nums">
      <span>{label}</span>
      {x.add > 0 && <span className="text-green-300">+{x.add}</span>}
      {x.chg > 0 && <span className="text-amber-300">~{x.chg}</span>}
      {x.del > 0 && <span className="text-red-300">−{x.del}</span>}
    </span>
  ) : null);
  return <span className="flex items-center gap-1.5 shrink-0">{part(t("欄"), c.columns)}{part(t("索引"), c.indexes)}{part(t("外鍵"), c.fks)}</span>;
}

/** 三態勾選框（分組標題用）：全包含 / 部分 / 全排除。 */
function TriCheckbox({ checked, indeterminate, onChange, title }: { checked: boolean; indeterminate: boolean; onChange: (on: boolean) => void; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} title={title} data-group-include />;
}

/** 貼在按鈕下方的小面板：點外面或 Esc 關閉（Esc 攔在 capture 階段，才不會連對話框一起關掉）。 */
function Popover({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); } };
    // 延後一拍再掛：開啟它的那一下點擊還在冒泡，馬上掛會立刻被自己關掉。
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="dialog" className="absolute right-0 top-full mt-1 z-30 w-[19rem] rounded-md border border-fg/10 bg-elevated shadow-e3 p-2 text-xs space-y-1">
      {children}
    </div>
  );
}

/** 比對選項表單（規則 + 範圍）；值存 localStorage，下次開對話框沿用。 */
function CompareOptionsForm({ value, onChange }: { value: CompareOptions; onChange: (v: CompareOptions) => void }) {
  const t = useT();
  const row = (k: keyof CompareOptions, label: string, hint?: string) => (
    <label className="flex items-start gap-2 px-1 py-0.5 rounded hover:bg-fg/5 cursor-pointer select-none">
      <input type="checkbox" className="mt-0.5" checked={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} data-compare-opt={k} />
      <span className="min-w-0">
        <span className="text-fg/85">{label}</span>
        {hint && <span className="block text-[10px] text-fg/40 leading-snug">{hint}</span>}
      </span>
    </label>
  );
  return (
    <div className="space-y-1">
      <div className="px-1 text-[10px] uppercase tracking-wide text-fg/40">{t("比對規則")}</div>
      {row("ignore_case", t("忽略名稱大小寫"), t("MySQL 在 Linux 區分表名、Windows 不區分；跨環境比對時勾這個。"))}
      {row("ignore_comments", t("忽略註解"), t("只差註解的欄位視為相同。"))}
      {row("ignore_defaults", t("忽略預設值"))}
      {row("match_by_content", t("索引 / 外鍵以定義配對"), t("名稱不同但定義相同時視為改名，而不是一刪一增。"))}
      <div className="px-1 pt-1.5 border-t border-fg/10 text-[10px] uppercase tracking-wide text-fg/40">{t("比對範圍")}</div>
      {row("include_views", t("視圖"))}
      {row("include_routines", t("預存程序 / 函式"))}
      <div className="pt-1.5 border-t border-fg/10 flex justify-end">
        <button type="button" className="text-accent hover:underline disabled:opacity-40" disabled={countNonDefaultOptions(value) === 0}
          onClick={() => onChange({ ...DEFAULT_COMPARE_OPTIONS })}>{t("還原預設")}</button>
      </div>
    </div>
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
