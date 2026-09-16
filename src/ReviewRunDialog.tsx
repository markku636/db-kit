import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, FileCode2, FolderOpen, Info, Loader2, Play,
  RefreshCw, RotateCcw, Settings2, ShieldAlert, ShieldCheck, Sparkles, Square, XCircle,
} from "lucide-react";
import {
  api, onReviewRunProgress,
  type ReviewPrepared, type ReviewRollbackLevel, type ReviewRunMode, type ReviewRunOutcome, type ReviewRunProgress,
  type ReviewStatement,
} from "./api";
import { useStore, type ReviewRunRequest } from "./store";
import { copyToClipboard, pickDirectory, toast, uiConfirm } from "./ui";
import { Badge, Button, Icon, Modal, Segmented } from "./ui/index";
import type { BadgeTone } from "./ui/index";
import { useOneShotGenerate } from "./useOneShotGenerate";
import { parseBlocks, TextBlock } from "./MarkdownLite";
import AiSettingsDialog from "./AiSettingsDialog";
import {
  backupBlockReason, executeBlockReason, incompleteCount, joinPath, loadReviewRunPrefs, MAX_CAPTURE_ROWS,
  MAX_SAMPLE_ROWS, opLabel, parseVerdict, saveReviewRunPrefs, stripVerdictLine, summarizeStatements,
  type ExecuteBlockReason, type ReviewRunPrefs, type Verdict,
} from "./reviewRun";
import { useT } from "./i18n";

type Tab = "review" | "script" | "result" | "rollback";

const LEVEL_TONE: Record<ReviewRollbackLevel, BadgeTone> = {
  not_needed: "neutral",
  full: "success",
  partial: "warning",
  none: "danger",
};

/**
 * 審查並執行：AI 審查 → 逐句擷取前像並產生回滾腳本 → 執行 → 擷取後像比對差異 → 全部寫進輸出目錄。
 *
 * 入口有兩個（查詢分頁工具列、AI 助手對話裡的 SQL 區塊），透過 store 的 reviewRun 請求開啟；
 * 核心全在後端（src-tauri/src/review_run/），這裡只負責蒐集選項、串流 AI 審查與呈現結果——
 * `dbk run` 走的是同一份分析、同一份提示、同一份回滾產生器。
 */
export default function ReviewRunDialog({ request, onClose }: { request: ReviewRunRequest; onClose: () => void }) {
  const t = useT();
  const conn = useStore((s) => s.connections.find((c) => c.id === request.connId) ?? null);
  const readonly = useStore((s) => s.readonlyConns[request.connId] === true);
  const connLabel = conn?.name ?? request.connId;

  const [prefs, setPrefs] = useState<ReviewRunPrefs>(loadReviewRunPrefs);
  useEffect(() => saveReviewRunPrefs(prefs), [prefs]);
  const [showOptions, setShowOptions] = useState(false);

  const [prep, setPrep] = useState<ReviewPrepared | null>(null);
  const [prepErr, setPrepErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 分析時用的選項：改了擷取上限 / 樣本列數之後要重新分析，按鈕才亮。
  const [analyzedWith, setAnalyzedWith] = useState<{ maxRows: number; sampleRows: number } | null>(null);

  const ai = useOneShotGenerate({ mode: "review" });
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const verdict = useMemo(() => parseVerdict(ai.text), [ai.text]);

  const [tab, setTab] = useState<Tab>("review");
  const [ackIncomplete, setAckIncomplete] = useState(false);
  const [ackProd, setAckProd] = useState(false);
  const [running, setRunning] = useState<ReviewRunMode | null>(null);
  const [progress, setProgress] = useState<ReviewRunProgress | null>(null);
  const [outcome, setOutcome] = useState<ReviewRunOutcome | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const analyze = async (withAi: boolean) => {
    setLoading(true);
    setPrepErr(null);
    setAckIncomplete(false);
    ai.cancel();
    ai.reset();
    try {
      const res = await api.reviewRunPrepare(request.connId, connLabel, request.database, request.sql, prefs.maxRows, prefs.sampleRows);
      setPrep(res);
      setAnalyzedWith({ maxRows: prefs.maxRows, sampleRows: prefs.sampleRows });
      // 有問題的語句預設展開：使用者第一眼就該看到理由，不是一排綠勾。
      setExpanded(new Set(res.prepared.statements.filter((s) => s.notes.some((n) => n.level !== "info")).map((s) => s.index)));
      if (withAi && res.prepared.has_writes && res.prepared.blockers.length === 0) void ai.run(res.prompt);
    } catch (e: any) {
      setPrep(null);
      setPrepErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void analyze(prefs.autoReview);
    // 只在開啟時分析一次；之後由「重新分析」按鈕觸發。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const p = prep?.prepared ?? null;
  const summary = useMemo(() => summarizeStatements(p?.statements ?? []), [p]);
  const optionsStale = !!analyzedWith && (analyzedWith.maxRows !== prefs.maxRows || analyzedWith.sampleRows !== prefs.sampleRows);

  const execBlock = executeBlockReason({
    loading, running: running !== null, prepared: p, readonly, outDir: prefs.outDir, aiRunning: ai.running,
    ackIncomplete, ackProd,
  });
  const backupBlock = backupBlockReason({ loading, running: running !== null, prepared: p, outDir: prefs.outDir, aiRunning: ai.running });

  const blockText = (r: ExecuteBlockReason | null): string | null => {
    switch (r) {
      case null: return null;
      case "loading": return t("分析中…");
      case "running": return t("執行中…");
      case "blocked": return t("腳本含本流程不支援的語句");
      case "noWrites": return t("腳本沒有寫入語句，不需要審查並執行");
      case "readonly": return t("此連線為唯讀模式，只能產生備份");
      case "noOutDir": return t("請先選擇輸出目錄");
      case "aiRunning": return t("AI 審查進行中，完成或停止後才能繼續");
      case "needsAck": return t("請勾選確認：有語句沒有完整回滾");
      case "needsProdAck": return t("請勾選確認：這是正式環境");
    }
  };

  const chooseDir = async () => {
    const dir = await pickDirectory();
    if (dir) setPrefs((x) => ({ ...x, outDir: dir }));
  };

  const start = async (mode: ReviewRunMode) => {
    if (!p) return;
    if (mode === "execute") {
      const lines = [
        t("將在「{name}」執行 {n} 句寫入語句；每句執行前先備份前像，檔案寫到：", { name: connLabel, n: summary.writes }),
        prefs.outDir,
      ];
      if (summary.destructive > 0) lines.push("", t("其中 {n} 句為破壞性操作（DROP / TRUNCATE / 無 WHERE 的寫入）。", { n: summary.destructive }));
      if (verdict === "stop") lines.push("", t("AI 審查結論是「不建議執行」。"));
      const ok = await uiConfirm(lines.join("\n"), { title: t("確認執行"), danger: true, confirmText: t("執行") });
      if (!ok) return;
    }
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunning(mode);
    setRunErr(null);
    setOutcome(null);
    setProgress(null);
    const unlisten = await onReviewRunProgress(runId, setProgress);
    try {
      const res = await api.reviewRunStart({
        runId,
        id: request.connId,
        connLabel,
        database: request.database,
        script: request.sql,
        outDir: prefs.outDir,
        mode,
        options: { max_capture_rows: prefs.maxRows, allow_incomplete: ackIncomplete, confirm_prod: ackProd },
        review: ai.text.trim() ? ai.text : null,
      });
      setOutcome(res);
      setTab("result");
      request.onDone?.(res);
      const st = res.manifest.status;
      if (st === "completed" || st === "backup_only") toast.success(mode === "execute" ? t("已執行，備份與差異已寫入輸出目錄") : t("已產生審查與備份"));
      else toast.error(res.manifest.stop_reason ?? t("未完成"));
    } catch (e: any) {
      setRunErr(e?.message ?? String(e));
    } finally {
      unlisten();
      runIdRef.current = null;
      setRunning(null);
      setProgress(null);
    }
  };

  const cancelRun = () => {
    if (runIdRef.current) void api.reviewRunCancel(runIdRef.current).catch(() => {});
  };

  const close = () => {
    if (running) {
      toast.info(t("執行中無法關閉；請先按「取消」，會在目前這句結束後停下"));
      return;
    }
    onClose();
  };

  const openRollbackInTab = async () => {
    if (!outcome) return;
    try {
      const text = await api.readTextFile(joinPath(outcome.dir, "rollback.sql"));
      useStore.getState().newQueryTab(text, request.connId);
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取失敗"));
    }
  };

  const reviewRollback = async () => {
    if (!outcome) return;
    try {
      const text = await api.readTextFile(joinPath(outcome.dir, "rollback.sql"));
      useStore.getState().openReviewRun({ connId: request.connId, database: request.database, sql: text, origin: request.origin });
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取失敗"));
    }
  };

  const toggle = (i: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  const progressText = (pr: ReviewRunProgress | null): string => {
    if (!pr) return running === "execute" ? t("執行中…") : t("產生備份中…");
    const n = pr.index + 1;
    switch (pr.phase) {
      case "prepare": return t("分析中…");
      case "capture_before": return t("第 {n}/{total} 句：擷取前像", { n, total: pr.total });
      case "execute": return t("第 {n}/{total} 句：執行中", { n, total: pr.total });
      case "capture_after": return t("第 {n}/{total} 句：擷取後像", { n, total: pr.total });
      case "write": return t("寫出檔案…");
      default: return t("完成");
    }
  };

  const tabs = [
    { value: "review" as const, label: t("AI 審查") },
    { value: "script" as const, label: t("腳本") },
    ...(outcome ? [{ value: "result" as const, label: t("結果") }, { value: "rollback" as const, label: t("回滾腳本") }] : []),
  ];

  const footer = (
    <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs min-w-0">
        {p && p.needs_ack && (
          <label className="flex items-center gap-1.5 cursor-pointer select-none text-amber-300">
            <input type="checkbox" checked={ackIncomplete} onChange={(e) => setAckIncomplete(e.target.checked)} />
            {t("我了解有 {n} 句沒有完整回滾", { n: incompleteCount(p.statements) })}
          </label>
        )}
        {p && p.prod && (
          <label className="flex items-center gap-1.5 cursor-pointer select-none text-red-300">
            <input type="checkbox" checked={ackProd} onChange={(e) => setAckProd(e.target.checked)} />
            {t("這是正式環境，我確認要執行")}
          </label>
        )}
        {running ? (
          <span className="inline-flex items-center gap-1.5 text-fg/60">
            <Icon icon={Loader2} size={13} className="animate-spin" />{progressText(progress)}
          </span>
        ) : (
          execBlock && execBlock !== "loading" && <span className="text-fg/45">{blockText(execBlock)}</span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {running ? (
          <Button variant="danger" icon={Square} onClick={cancelRun}>{t("取消")}</Button>
        ) : (
          <Button variant="ghost" onClick={close}>{t("關閉")}</Button>
        )}
        <Button icon={FileCode2} disabled={!!backupBlock} loading={running === "backup"} onClick={() => start("backup")}
          title={blockText(backupBlock) ?? t("只擷取前像、產生審查與回滾腳本，不執行")}>
          {t("只產生備份")}
        </Button>
        <Button variant={summary.destructive > 0 || p?.prod ? "dangerSolid" : "primary"} icon={Play}
          disabled={!!execBlock} loading={running === "execute"} onClick={() => start("execute")}
          title={blockText(execBlock) ?? t("逐句：擷取前像 → 寫入回滾腳本 → 執行 → 擷取後像")}>
          {t("執行（含備份）")}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal onClose={close} size="full" icon={ShieldCheck} dismissOnBackdrop={false} codeZoom
      title={<span className="inline-flex items-center gap-2">
        {t("審查並執行")}
        <span className="text-xs font-normal text-fg/50">{connLabel}{p ? ` · ${p.database}` : ""}</span>
        {p?.prod && <Badge tone="danger">PROD</Badge>}
        {readonly && <Badge tone="warning">{t("唯讀")}</Badge>}
      </span>}
      bodyClassName="p-0 overflow-hidden" footer={footer} className="h-[86vh]">
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        {/* ---- 左：語句分析與設定 ---- */}
        <div className="md:w-[420px] shrink-0 border-b md:border-b-0 md:border-r border-fg/10 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-fg/10 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Icon icon={FolderOpen} size={13} className="text-fg/45 shrink-0" />
              <input value={prefs.outDir} onChange={(e) => setPrefs((x) => ({ ...x, outDir: e.target.value }))}
                placeholder={t("輸出目錄（每次在底下建立子目錄）")} spellCheck={false}
                className="flex-1 min-w-0 bg-well border border-fg/10 rounded px-2 py-1 mono text-[12px] outline-none focus:border-accent/60" />
              <Button size="sm" onClick={chooseDir}>{t("瀏覽…")}</Button>
            </div>
            <button type="button" onClick={() => setShowOptions((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-fg/50 hover:text-fg/80">
              <Icon icon={showOptions ? ChevronDown : ChevronRight} size={12} />
              <Icon icon={Settings2} size={12} />{t("選項")}
            </button>
            {showOptions && (
              <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-1.5 text-xs pl-4">
                <span className="text-fg/60">{t("每句擷取上限（列）")}</span>
                <input type="number" min={1} max={MAX_CAPTURE_ROWS} value={prefs.maxRows}
                  onChange={(e) => setPrefs((x) => ({ ...x, maxRows: Math.max(1, Math.min(MAX_CAPTURE_ROWS, Number(e.target.value) || 1)) }))}
                  className="w-28 bg-well border border-fg/10 rounded px-2 py-0.5 tabular-nums outline-none focus:border-accent/60" />
                <span className="text-fg/60">{t("附前像樣本給 AI（列）")}</span>
                <span className="flex items-center gap-2">
                  <input type="number" min={0} max={MAX_SAMPLE_ROWS} value={prefs.sampleRows}
                    onChange={(e) => setPrefs((x) => ({ ...x, sampleRows: Math.max(0, Math.min(MAX_SAMPLE_ROWS, Number(e.target.value) || 0)) }))}
                    className="w-16 bg-well border border-fg/10 rounded px-2 py-0.5 tabular-nums outline-none focus:border-accent/60" />
                  <span className="text-[11px] text-fg/40">{prefs.sampleRows > 0 ? t("資料會送給 AI 供應商") : t("0 = 只送結構與列數")}</span>
                </span>
                <span className="text-fg/60">{t("開啟時自動審查")}</span>
                <input type="checkbox" className="justify-self-start" checked={prefs.autoReview}
                  onChange={(e) => setPrefs((x) => ({ ...x, autoReview: e.target.checked }))} />
                {optionsStale && (
                  <div className="col-span-2 flex items-center gap-2 text-amber-300/90">
                    {t("選項已變更，重新分析後才會生效")}
                    <Button size="sm" icon={RefreshCw} onClick={() => analyze(false)} disabled={loading || running !== null}>{t("重新分析")}</Button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2">
            {loading && (
              <div className="flex items-center gap-2 text-xs text-fg/55"><Icon icon={Loader2} size={13} className="animate-spin" />{t("分析語句並探測資料表…")}</div>
            )}
            {prepErr && (
              <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 whitespace-pre-wrap">
                {prepErr}
                <div className="mt-2"><Button size="sm" icon={RefreshCw} onClick={() => analyze(false)}>{t("重試")}</Button></div>
              </div>
            )}
            {p && (
              <>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Badge>{t("寫入 {n} 句", { n: summary.writes })}</Badge>
                  {summary.full > 0 && <Badge tone="success">{t("完整回滾 {n}", { n: summary.full })}</Badge>}
                  {summary.partial > 0 && <Badge tone="warning">{t("部分回滾 {n}", { n: summary.partial })}</Badge>}
                  {summary.none > 0 && <Badge tone="danger">{t("無回滾 {n}", { n: summary.none })}</Badge>}
                  {summary.writes > 0 && (
                    <span className="text-fg/45">{t("約 {n} 列", { n: `${summary.estimateUpperBound ? "≤" : ""}${summary.estimatedRows.toLocaleString()}` })}</span>
                  )}
                </div>
                {p.blockers.length > 0 && (
                  <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 space-y-1">
                    <div className="font-semibold flex items-center gap-1.5"><Icon icon={XCircle} size={13} />{t("這份腳本不能在本流程執行")}</div>
                    {p.blockers.map((b, k) => <div key={k}>#{b.index + 1}：{b.message}</div>)}
                  </div>
                )}
                {p.statements.map((st) => (
                  <StatementRow key={st.index} st={st} open={expanded.has(st.index)} onToggle={() => toggle(st.index)}
                    record={outcome?.manifest.statements.find((r) => r.index === st.index) ?? null} />
                ))}
              </>
            )}
          </div>
        </div>

        {/* ---- 右：AI 審查 / 腳本 / 結果 ---- */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-fg/10">
            <Segmented options={tabs} value={tab} onChange={setTab} size="sm" />
            {tab === "review" && (
              <div className="ml-auto flex items-center gap-2">
                {verdict && <VerdictBadge verdict={verdict} />}
                {ai.running ? (
                  <Button size="sm" variant="danger" icon={Square} onClick={ai.cancel}>{t("停止")}</Button>
                ) : (
                  <Button size="sm" icon={Sparkles} disabled={!prep || loading || running !== null || !p?.has_writes}
                    onClick={() => prep && void ai.run(prep.prompt)}>
                    {ai.text ? t("重新審查") : t("AI 審查")}
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-4">
            {runErr && (
              <div className="mb-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 whitespace-pre-wrap">{runErr}</div>
            )}
            {tab === "review" && (
              <ReviewPane text={ai.text} running={ai.running} error={ai.error} hasWrites={!!p?.has_writes}
                onOpenSettings={() => setAiSettingsOpen(true)} />
            )}
            {tab === "script" && (
              <pre className="mono text-[12px] leading-relaxed whitespace-pre-wrap break-words bg-well rounded border border-fg/10 p-3">{request.sql}</pre>
            )}
            {tab === "result" && outcome && (
              <ResultPane outcome={outcome} onOpenRollback={openRollbackInTab} onReviewRollback={reviewRollback} />
            )}
            {tab === "rollback" && outcome && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" icon={FileCode2} onClick={openRollbackInTab}>{t("在查詢分頁開啟")}</Button>
                  <Button size="sm" icon={RotateCcw} onClick={reviewRollback}>{t("以審查並執行回滾")}</Button>
                  <span className="text-[11px] text-fg/45">{t("最後一句排在最前面；被註解掉的語句需人工確認")}</span>
                </div>
                <pre className="mono text-[12px] leading-relaxed whitespace-pre overflow-auto bg-well rounded border border-fg/10 p-3">{outcome.rollback_preview}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
      {aiSettingsOpen && <AiSettingsDialog open onClose={() => setAiSettingsOpen(false)} />}
    </Modal>
  );
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const t = useT();
  const map: Record<Verdict, { tone: BadgeTone; label: string }> = {
    go: { tone: "success", label: t("可以執行") },
    caution: { tone: "warning", label: t("注意風險後再執行") },
    stop: { tone: "danger", label: t("不建議執行") },
  };
  return <Badge tone={map[verdict].tone} dot>{t("AI：{label}", { label: map[verdict].label })}</Badge>;
}

function LevelBadge({ level }: { level: ReviewRollbackLevel }) {
  const t = useT();
  const label: Record<ReviewRollbackLevel, string> = {
    not_needed: t("不需回滾"),
    full: t("完整回滾"),
    partial: t("部分回滾"),
    none: t("無回滾"),
  };
  return <Badge tone={LEVEL_TONE[level]}>{label[level]}</Badge>;
}

function StatementRow({ st, open, onToggle, record }: {
  st: ReviewStatement;
  open: boolean;
  onToggle: () => void;
  record: ReviewRunOutcome["manifest"]["statements"][number] | null;
}) {
  const t = useT();
  const oneLine = st.sql.replace(/\s+/g, " ");
  const noteIcon = (lv: string) => (lv === "error" ? XCircle : lv === "warn" ? AlertTriangle : Info);
  const noteCls = (lv: string) => (lv === "error" ? "text-red-300" : lv === "warn" ? "text-amber-300" : "text-fg/50");
  return (
    <div className={`rounded border ${st.destructive ? "border-red-500/25" : "border-fg/10"} bg-panel`}>
      <button type="button" onClick={onToggle} className="w-full text-left px-2.5 py-1.5 flex items-start gap-2">
        <Icon icon={open ? ChevronDown : ChevronRight} size={12} className="mt-1 text-fg/40 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-fg/40 tabular-nums">#{st.index + 1}</span>
            <span className={`font-semibold ${st.write ? "text-fg/85" : "text-fg/45"}`}>{opLabel(st.op)}</span>
            {st.targets.length > 0 && <span className="mono text-fg/60 truncate max-w-[180px]" title={st.targets.join(", ")}>{st.targets.join(", ")}</span>}
            {st.write && <LevelBadge level={st.rollback} />}
            {st.destructive && <Badge tone="danger">{t("破壞性")}</Badge>}
            {st.write && st.estimated_rows != null && (
              <span className="text-fg/45 tabular-nums">{t("約 {n} 列", { n: `${st.estimate_exact ? "" : "≤"}${st.estimated_rows.toLocaleString()}` })}</span>
            )}
            {record && record.status === "ok" && <Icon icon={CheckCircle2} size={12} className="text-emerald-400" />}
            {record && record.status === "failed" && <Icon icon={XCircle} size={12} className="text-red-400" />}
          </div>
          <div className="mono text-[11px] text-fg/55 truncate" title={st.sql}>{oneLine}</div>
        </div>
        {st.notes.some((n) => n.level === "error") && <Icon icon={ShieldAlert} size={13} className="mt-0.5 text-red-300 shrink-0" />}
      </button>
      {open && (
        <div className="px-3 pb-2 pl-7 space-y-1.5 text-[11px]">
          {st.notes.length === 0 && st.write && <div className="text-fg/45">{t("前像擷取方式：{m}", { m: st.method })}</div>}
          {st.notes.map((n, k) => (
            <div key={k} className={`flex items-start gap-1.5 ${noteCls(n.level)}`}>
              <Icon icon={noteIcon(n.level)} size={12} className="mt-0.5 shrink-0" />
              <span className="break-words">{n.message}</span>
            </div>
          ))}
          {record && (
            <div className="text-fg/55 space-y-0.5 border-t border-fg/10 pt-1.5">
              {record.status === "ok" && <div>{t("影響 {n} 列 · {ms} ms", { n: record.rows_affected ?? 0, ms: record.elapsed_ms ?? 0 })}</div>}
              {record.error && <div className="text-red-300 break-words">{record.error}</div>}
              {record.diff.map((d, k) => (
                <div key={k}>{t("{table}：修改 {u}、新增 {i}、刪除 {d}", { table: d.table, u: d.updated, i: d.inserted, d: d.deleted })}</div>
              ))}
              {(record.rollback_statements > 0 || record.rollback_disabled > 0) && (
                <div>{t("回滾語句 {n} 句，需人工確認 {m} 句", { n: record.rollback_statements, m: record.rollback_disabled })}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewPane({ text, running, error, hasWrites, onOpenSettings }: {
  text: string;
  running: boolean;
  error: string | null;
  hasWrites: boolean;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const body = stripVerdictLine(text);
  const blocks = useMemo(() => parseBlocks(body), [body]);
  let content: ReactNode;
  if (!text && running) {
    content = <div className="flex items-center gap-2 text-xs text-fg/55"><Icon icon={Loader2} size={13} className="animate-spin" />{t("AI 審查中…")}</div>;
  } else if (!text) {
    content = (
      <div className="text-xs text-fg/50 space-y-2 max-w-xl">
        <p>{hasWrites
          ? t("按「AI 審查」讓 AI 檢查這份腳本：預期的前後差異、風險、修正建議，以及回滾腳本沒涵蓋到的部分。")
          : t("這份腳本沒有寫入語句。")}</p>
        <p className="text-fg/40">{t("送出的內容：腳本、語句分析、目標表結構與估算列數；前像樣本預設不送（可在左側「選項」開啟）。")}</p>
      </div>
    );
  } else {
    content = (
      <div className="space-y-2 max-w-4xl">
        {blocks.map((b, i) => b.type === "code"
          ? (
            <div key={i} className="rounded border border-fg/10 overflow-hidden bg-well">
              <div className="flex items-center px-2 py-1 bg-fg/5 text-[10px] text-fg/45">
                <span className="uppercase tracking-wide">{b.lang || "code"}</span>
                <button type="button" className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-fg/10 hover:text-fg"
                  onClick={() => { copyToClipboard(b.code); toast.success(t("已複製")); }}>
                  <Icon icon={Copy} size={11} />{t("複製")}
                </button>
              </div>
              <pre className="p-2 overflow-auto text-[12px] mono leading-relaxed">{b.code}</pre>
            </div>
          )
          : <TextBlock key={i} text={b.text} />)}
        {running && <Icon icon={Loader2} size={13} className="animate-spin text-fg/40" />}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <div className="whitespace-pre-wrap">{error}</div>
          <button type="button" onClick={onOpenSettings} className="mt-1 underline hover:text-red-200">{t("開啟 AI 設定")}</button>
          <div className="mt-1 text-red-300/70">{t("沒有 AI 審查也可以繼續：備份、回滾腳本與差異報告不受影響。")}</div>
        </div>
      )}
      {content}
    </div>
  );
}

function ResultPane({ outcome, onOpenRollback, onReviewRollback }: {
  outcome: ReviewRunOutcome;
  onOpenRollback: () => void;
  onReviewRollback: () => void;
}) {
  const t = useT();
  const m = outcome.manifest;
  const statusLabel: Record<typeof m.status, string> = {
    backup_only: t("已產生審查與備份（未執行）"),
    completed: t("已執行完成"),
    failed: t("執行失敗，後面的語句沒有執行"),
    cancelled: t("已取消"),
    stopped: t("已中止"),
  };
  const good = m.status === "completed" || m.status === "backup_only";
  const diffBlocks = useMemo(() => parseBlocks(outcome.diff_preview), [outcome.diff_preview]);
  return (
    <div className="space-y-4 max-w-5xl">
      <div className={`rounded border px-3 py-2 text-sm ${good ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
        <div className={`font-semibold flex items-center gap-1.5 ${good ? "text-emerald-300" : "text-red-300"}`}>
          <Icon icon={good ? CheckCircle2 : XCircle} size={14} />{statusLabel[m.status]}
        </div>
        {m.stop_reason && <div className="mt-1 text-xs text-red-300 whitespace-pre-wrap">{m.stop_reason}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="mono text-fg/70 break-all">{outcome.dir}</span>
          <Button size="sm" icon={FolderOpen} onClick={() => api.reviewRunReveal(outcome.dir).catch((e) => toast.error(e?.message ?? String(e)))}>{t("開啟資料夾")}</Button>
          <Button size="sm" icon={Copy} onClick={() => { copyToClipboard(outcome.dir); toast.success(t("已複製")); }}>{t("複製路徑")}</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={FileCode2} onClick={onOpenRollback}>{t("在查詢分頁開啟回滾腳本")}</Button>
        <Button size="sm" icon={RotateCcw} onClick={onReviewRollback}>{t("以審查並執行回滾")}</Button>
      </div>

      <div className="text-xs text-fg/60">
        <div className="font-semibold text-fg/80 mb-1">{t("輸出的檔案")}</div>
        <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
          {m.files.map((f) => <li key={f} className="mono truncate" title={f}>{f}</li>)}
        </ul>
      </div>

      {outcome.diff_preview && (
        <div className="space-y-2">
          {diffBlocks.map((b, i) => b.type === "code"
            ? <pre key={i} className="p-2 overflow-auto text-[12px] mono leading-relaxed bg-well rounded border border-fg/10">{b.code}</pre>
            : <TextBlock key={i} text={b.text} />)}
        </div>
      )}
    </div>
  );
}
