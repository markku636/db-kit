import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AlertTriangle, Copy, Gauge, Lock, Play, Sparkles, Square } from "lucide-react";
import { api, KIND_META, type StressPlan, type StressProgress, type StressReport } from "./api";
import { useStore } from "./store";
import { toast, copyToClipboard } from "./ui";
import { Modal, Button, Badge, Field, FormGrid, Input, Select, Segmented, Textarea, Icon } from "./ui/index";
import TimeSeriesChart from "./ui/TimeSeriesChart";
import { extractNamedParams } from "./sql";
import { loadConnColors } from "./connColors";
import { isReadonly } from "./connReadonly";
import { expandParamPool, fmtMs, fmtRps, parseParamCsv, reportToMarkdown, seriesToPoints, validatePlan } from "./stress";
import { useLang, useT } from "./i18n";
import { useAssistant } from "./assistant";
import { buildStressAnalysisPrompt } from "./aiReview";

// 壓力測試對話框（致敬 SQLQueryStress）：對單一連線重複執行語句，量測 TPS 與延遲分佈。
// 這個視窗會「真的打」目標資料庫，因此版面刻意把目標連線 / 唯讀狀態放在最上方，
// 而寫入語句預設被後端唯讀守門擋下，要另外扳開危險開關。

type Mode = "iterations" | "duration";

// 取列上限 / 單次逾時的候選值（0 皆代表「不限制」，與後端 DTO 語意一致）。
const ROW_CAPS = [100, 1000, 10000, 0];
const TIMEOUTS_MS = [10_000, 30_000, 60_000, 0];

// 即時圖表保留的進度點上限（後端每 500ms 發一筆；長跑不至於無限吃記憶體）。
const MAX_POINTS = 3600;

type ParamTable = ReturnType<typeof parseParamCsv>;
type CsvState = { ok: true; table: ParamTable } | { ok: false; message: string } | null;

export default function StressDialog({ connId, initialSql, onClose }: {
  connId: string;
  initialSql: string;
  onClose: () => void;
}) {
  const t = useT();
  const connections = useStore((s) => s.connections);
  const readonlyConns = useStore((s) => s.readonlyConns);

  const [sql, setSql] = useState(initialSql);
  const [mode, setMode] = useState<Mode>("iterations");
  const [perThread, setPerThread] = useState(100);
  const [secs, setSecs] = useState(30);
  const [rampSecs, setRampSecs] = useState(0);
  const [threads, setThreads] = useState(4);
  const [warmup, setWarmup] = useState(10);
  const [delayMs, setDelayMs] = useState(0);
  const [rowCap, setRowCap] = useState(1000);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [allowWrites, setAllowWrites] = useState(false);
  const [csv, setCsv] = useState("");

  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [progress, setProgress] = useState<StressProgress | null>(null);
  const [history, setHistory] = useState<StressProgress[]>([]);
  const [report, setReport] = useState<StressReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 報表要附的是「當時真的送出去的那段 SQL」：語句框在跑完後仍可編輯，
  // 若直接讀 sql，複製出來的 Markdown 會宣稱一段從未被壓測過的查詢。
  const [ranSql, setRanSql] = useState("");

  // run_id 放 ref：事件 handler 是在 listen 當下閉包起來的，用 state 會讀到舊值而濾掉自己的進度。
  const runIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Tauri 的 listen 註冊在全域，元件消失後 handler 仍會被呼叫 → 卸載時務必解除，否則洩漏。
  // 一併取消還在跑的壓測：對話框是唯一的觀測與煞車介面，它沒了還繼續打資料庫是最糟的狀況。
  useEffect(() => () => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    if (runIdRef.current) void api.stressCancel(runIdRef.current).catch(() => {});
  }, []);

  const conn = connections.find((c) => c.id === connId);
  const kind = conn?.kind ?? "mysql";
  const readonly = isReadonly(readonlyConns, connId);
  // 連線色標是 App 的區域 state + localStorage（不在 store 裡），開窗當下讀一次即可。
  const connColor = useMemo(() => loadConnColors()[connId] ?? "", [connId]);

  const paramNames = useMemo(() => extractNamedParams(sql), [sql]);

  // parseParamCsv 不丟例外（缺欄補空字串），「解析失敗」得自己判：沒有欄名列或沒有任何值列，
  // 都代表這段 CSV 無法展開成參數，此時直接把原語句拿去壓測會誤導使用者。
  const parsed = useMemo<CsvState>(() => {
    if (!csv.trim()) return null;
    try {
      const table = parseParamCsv(csv);
      if (table.headers.length === 0) return { ok: false, message: t("CSV 第一列需為欄名") };
      if (table.rows.length === 0) return { ok: false, message: t("CSV 只有欄名列，沒有任何參數值") };
      return { ok: true, table };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }, [csv, t]);

  // 參數展開在前端做（沿用 sql.ts 既有的方言跳脫），後端只收展開後的語句池。
  const pool = useMemo<{ statements: string[]; error: string | null }>(() => {
    const rows = parsed?.ok ? parsed.table.rows : [];
    if (rows.length === 0) return { statements: [sql], error: null };
    try {
      return { statements: expandParamPool(kind, sql, rows), error: null };
    } catch (e: any) {
      return { statements: [sql], error: e?.message ?? String(e) };
    }
  }, [kind, sql, parsed]);

  const buildPlan = (): StressPlan => ({
    statements: pool.statements,
    threads: Math.min(64, Math.max(1, threads)),
    mode: mode === "iterations"
      ? { kind: "iterations", per_thread: perThread }
      : { kind: "duration", secs, ramp_secs: rampSecs },
    warmup_iterations: warmup,
    delay_ms: delayMs,
    row_cap: rowCap,
    query_timeout_ms: timeoutMs,
    // 唯讀連線一律不放行：開關雖然 disabled，但先前扳開過的 state 仍可能留著。
    allow_writes: allowWrites && !readonly,
  });

  const start = async () => {
    if (running) return;
    if (!conn) { toast.error(t("找不到這個連線的設定")); return; }
    if (pool.error) { toast.error(pool.error); return; }
    // 語句帶具名參數、卻沒有可用的參數列時，送出的會是原封不動的 `:name`——
    // 對任何方言都是語法錯誤，整輪壓測只會量到「錯誤有多快」。CSV 解析失敗也走這裡，
    // 否則使用者看得到紅字卻仍按得下開始（欄位下的錯誤訊息不擋送出）。
    if (paramNames.length > 0 && !parsed?.ok) {
      toast.error(parsed ? parsed.message : t("語句含具名參數，請先在下方填入參數 CSV"));
      return;
    }
    const plan = buildPlan();
    const problem = validatePlan(plan);
    if (problem) { toast.error(problem); return; }

    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunning(true);
    setStopping(false);
    setErr(null);
    setReport(null);
    setProgress(null);
    setHistory([]);
    setStartedAt(Date.now());
    setRanSql(sql);
    try {
      // 先掛好監聽再送出：命令回來時整輪已經結束，晚掛會漏掉整段進度。
      unlistenRef.current?.();
      unlistenRef.current = await listen<StressProgress>("stress-progress", (e) => {
        if (e.payload.run_id !== runIdRef.current) return; // 別人的壓測（事件是全域廣播）
        setProgress(e.payload);
        setHistory((prev) => {
          const next = [...prev, e.payload];
          return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
        });
      });
      setReport(await api.stressRun(runId, conn, plan));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      runIdRef.current = null;
      setRunning(false);
      setStopping(false);
    }
  };

  // 停止只是設取消旗標；stressRun 仍會回傳（部分的）報表，由上面的 setReport 收下。
  const stop = async () => {
    const runId = runIdRef.current;
    if (!runId || stopping) return;
    setStopping(true);
    try {
      await api.stressCancel(runId);
    } catch (e: any) {
      setStopping(false);
      toast.error(e?.message ?? String(e));
    }
  };

  // 把報告丟給 AI 助手判讀（百分位的「形狀」比單一數字更能指出瓶頸類型）。
  // 語句用 ranSql（實際跑的那一份）而非編輯框現值——使用者可能在看報告時已經改了 SQL。
  const askAiAnalysis = () => {
    if (!report) return;
    useAssistant.getState().ask(
      buildStressAnalysisPrompt({
        kind,
        sql: ranSql,
        reportMarkdown: reportToMarkdown(report, ranSql),
        uiLang: useLang.getState().lang,
      }),
      { send: true },
    );
  };

  // 壓測進行中關窗會讓執行緒在背景繼續打，且進度無處可看 → 先擋下並提示。
  const requestClose = () => {
    if (running) { toast.error(t("壓測進行中，請先按「停止」再關閉")); return; }
    onClose();
  };

  // 完成後改用報表的每秒取樣（後端算得比進度事件細）；執行中則用累積的進度點。
  // 兩者的時間軸都是「自壓測開始的相對毫秒」，加上 startedAt 才對得回時鐘時間（hover 提示要用）。
  const chart = useMemo(() => (report
    ? {
        tps: seriesToPoints(report.series, "rps", startedAt),
        p95: seriesToPoints(report.series, "p95_ms", startedAt),
      }
    : {
        tps: history.map((p) => ({ t: startedAt + p.elapsed_ms, v: p.rps })),
        p95: history.map((p) => ({ t: startedAt + p.elapsed_ms, v: p.p95_ms })),
      }), [report, history, startedAt]);

  const meta = KIND_META[kind];
  const missingParams = parsed?.ok ? paramNames.filter((n) => !parsed.table.headers.includes(n)) : [];

  if (!conn) {
    return (
      <Modal onClose={onClose} title={t("壓力測試")} icon={Gauge} size="md"
        footer={<Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>}>
        <div className="text-sm text-danger">{t("找不到這個連線的設定")}</div>
      </Modal>
    );
  }

  return (
    <Modal
      size="full"
      title={t("壓力測試")}
      icon={Gauge}
      onClose={requestClose}
      dismissOnBackdrop={false}
      bodyClassName="p-5 space-y-4 overflow-auto"
      footer={running ? (
        <>
          <span className="mr-auto text-xs text-fg/40">{t("壓測進行中，請先按「停止」再關閉")}</span>
          <Button variant="secondary" disabled>{t("關閉")}</Button>
        </>
      ) : (
        <>
          <Button variant="secondary" onClick={requestClose}>{t("關閉")}</Button>
          {report && (
            <Button icon={Sparkles} onClick={askAiAnalysis}
              title={t("把這份報告與受測語句交給 AI 助手，請它從百分位的形狀反推瓶頸類型")}>
              {t("AI 分析結果")}
            </Button>
          )}
          {report && (
            <Button icon={Copy} onClick={() => copyToClipboard(reportToMarkdown(report, ranSql))}>
              {t("複製為 Markdown")}
            </Button>
          )}
          <Button variant="primary" icon={Play} onClick={start} disabled={!sql.trim()}>
            {report ? t("再跑一次") : t("開始壓測")}
          </Button>
        </>
      )}
    >
      {/* 目標連線：這是「你正要打爆哪一台」的最後確認 —— 色標 / 種類 / 唯讀一眼可辨。 */}
      <div
        className="flex items-center gap-2 rounded border border-fg/10 bg-inset px-3 py-2"
        style={connColor ? { boxShadow: `inset 3px 0 0 ${connColor}` } : undefined}
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
        <span className="text-sm font-medium truncate">{conn.name}</span>
        <Badge tone="neutral">{meta.label}</Badge>
        <span className="text-xs text-fg/40 mono truncate">
          {meta.fileBased ? conn.database ?? "" : `${conn.host}:${conn.port}`}
        </span>
        {readonly && (
          <Badge tone="warning" className="ml-1">
            <Icon icon={Lock} size={11} />{t("唯讀連線")}
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-fg/40">{t("壓測會實際對此連線送出查詢")}</span>
      </div>

      {/* SQL */}
      <Field
        label={t("語句")}
        hint={paramNames.length > 0
          ? t("偵測到 {n} 個具名參數：{names}", { n: paramNames.length, names: paramNames.join(", ") })
          : t("未偵測到具名參數（可用 :name 讓每次迭代帶不同值）")}
      >
        <Textarea
          rows={6}
          className="mono text-xs"
          value={sql}
          disabled={running}
          onChange={(e) => setSql(e.target.value)}
          placeholder={t("要重複執行的 SQL")}
        />
      </Field>

      {/* 設定 */}
      <FormGrid className="grid-cols-4">
        <Field label={t("模式")}>
          <Segmented
            full
            ariaLabel={t("模式")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "iterations", label: t("迭代次數"), disabled: running },
              { value: "duration", label: t("持續時間"), disabled: running },
            ]}
          />
        </Field>
        {mode === "iterations" ? (
          <NumField label={t("每執行緒迭代數")} min={1} value={perThread} onChange={setPerThread} disabled={running} />
        ) : (
          <>
            <NumField label={t("秒數")} min={1} value={secs} onChange={setSecs} disabled={running} />
            <NumField label={t("爬升秒數")} min={0} value={rampSecs} onChange={setRampSecs} disabled={running}
              hint={t("執行緒分批上線，避免瞬間全開")} />
          </>
        )}
        <NumField label={t("執行緒數")} min={1} max={64} value={threads} onChange={setThreads} disabled={running} />
        <NumField label={t("暖機迭代")} min={0} value={warmup} onChange={setWarmup} disabled={running}
          hint={t("不計入統計")} />
        <NumField label={t("每次間隔延遲（毫秒）")} min={0} value={delayMs} onChange={setDelayMs} disabled={running} />
        <Field label={t("取列上限")}>
          <Select selectSize="md" value={String(rowCap)} disabled={running}
            onChange={(e) => setRowCap(Number(e.target.value))}>
            {ROW_CAPS.map((c) => (
              <option key={c} value={c}>{c === 0 ? t("完整取回") : t("{n} 列", { n: c })}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("單次逾時")}>
          <Select selectSize="md" value={String(timeoutMs)} disabled={running}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}>
            {TIMEOUTS_MS.map((ms) => (
              <option key={ms} value={ms}>{ms === 0 ? t("不逾時") : t("{n} 秒", { n: ms / 1000 })}</option>
            ))}
          </Select>
        </Field>
        <Field
          label={t("危險選項")}
          hint={readonly
            ? t("此連線標記為唯讀，無法開啟寫入")
            : allowWrites
              ? t("寫入會被重複執行數千次且不可回復，請確認打的不是正式環境")
              : t("預設只放行查詢語句")}
        >
          <label className={`inline-flex items-center gap-1.5 text-sm select-none h-8 ${
            readonly || running ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
          }`}>
            <input
              type="checkbox"
              checked={allowWrites && !readonly}
              disabled={readonly || running}
              onChange={(e) => setAllowWrites(e.target.checked)}
            />
            <span className="inline-flex items-center gap-1 text-danger">
              <Icon icon={AlertTriangle} size={12} />{t("允許寫入語句")}
            </span>
          </label>
        </Field>
      </FormGrid>

      {/* 參數替換（對標 SQLQueryStress 的 Parameter Substitution） */}
      {paramNames.length > 0 && (
        <Field
          label={t("參數替換（CSV）")}
          hint={t("第一列為欄名，需對應 SQL 中的 :name；每列展開成一條語句，各 worker 輪替取用")}
          error={parsed && !parsed.ok ? parsed.message : pool.error ?? undefined}
        >
          <Textarea
            rows={4}
            className="mono text-xs"
            value={csv}
            disabled={running}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={paramNames.join(",")}
            invalid={!!(parsed && !parsed.ok)}
          />
          {parsed?.ok && (
            <div className="text-[11px] text-fg/45 space-y-0.5">
              <div>
                {t("已解析 {rows} 列 · 欄名：{cols} · 展開為 {n} 條語句", {
                  rows: parsed.table.rows.length,
                  cols: parsed.table.headers.join(", ") || "—",
                  n: pool.statements.length,
                })}
              </div>
              {missingParams.length > 0 && (
                <div className="text-warning">
                  {/* expandParamPool 對缺欄的參數是「代入空字串」而非保留 :name，訊息要照實說，
                      否則使用者會以為壓測打的是原查詢，實際上量到的是 `col = ''` 這種必然落空的條件。 */}
                  {t("CSV 沒有這些參數的欄位，將以空字串代入：{names}", { names: missingParams.join(", ") })}
                </div>
              )}
            </div>
          )}
        </Field>
      )}

      {err && <div className="text-xs text-danger whitespace-pre-wrap break-words">{err}</div>}

      {/* 執行中即時數字 + 趨勢。
          外層也認 report：跑太快（迭代少、查詢便宜）時一次進度事件都來不及發，progress 恆為 null、
          running 也已翻回 false —— 只看這兩者的話，明明 report.series 有資料，圖表卻整組不渲染。 */}
      {(running || progress || report) && (
        <div className="space-y-3 rounded border border-fg/10 bg-inset p-3">
          {(running || progress) && (
          <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg/50">
              {running ? t("壓測進行中") : t("最近一輪")}
              {progress ? ` · ${fmtMs(progress.elapsed_ms)}` : ""}
            </span>
            <Badge tone={progress && progress.errors > 0 ? "danger" : "neutral"}>
              {t("錯誤 {n}", { n: progress?.errors ?? 0 })}
            </Badge>
            {progress && <Badge tone="info">{t("進行中 {n}", { n: progress.in_flight })}</Badge>}
            {running && (
              <Button variant="dangerSolid" icon={Square} loading={stopping} onClick={stop} className="ml-auto">
                {t("停止")}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Stat label={t("已完成")} value={String(progress?.completed ?? 0)} />
            <Stat label="TPS" value={orDash(progress?.rps, fmtRps)} accent />
            <Stat label={t("平均延遲")} value={orDash(progress?.avg_ms, fmtMs)} />
            <Stat label="p95" value={orDash(progress?.p95_ms, fmtMs)} />
          </div>
          </>
          )}
          {/* 折線圖獨立判斷「有沒有點可畫」：資料在執行中來自進度事件、完成後改用報表的
              每秒取樣（後端算得比進度事件細），兩者都可能單獨存在。 */}
          {chart.tps.length >= 2 && (
            <div className="grid grid-cols-2 gap-4">
              <div className="text-accent">
                <TimeSeriesChart label="TPS" points={chart.tps} height={90} formatValue={fmtRps} />
              </div>
              <div className="text-amber-300/80">
                <TimeSeriesChart label={t("p95 延遲")} points={chart.p95} height={90} formatValue={fmtMs} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 報表 */}
      {report && (
        <div className="space-y-3 rounded border border-fg/10 bg-inset p-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{t("測試結果")}</span>
            <span className="text-xs text-fg/40">
              {t("{threads} 執行緒 · {mode} · 暖機 {warmup}", {
                threads: report.threads, mode: report.mode, warmup: report.warmup_iterations,
              })}
            </span>
            {report.cancelled && <Badge tone="warning">{t("已取消")}</Badge>}
          </div>

          <div className="flex flex-wrap gap-4 text-xs text-fg/60">
            <span>{t("完成數")} <b className="mono text-fg/90">{report.completed}</b></span>
            <span>{t("錯誤數")} <b className={`mono ${report.errors > 0 ? "text-danger" : "text-fg/90"}`}>{report.errors}</b></span>
            <span>{t("總列數")} <b className="mono text-fg/90">{report.rows_total}</b></span>
            <span>{t("耗時")} <b className="mono text-fg/90">{fmtMs(report.elapsed_ms)}</b></span>
            <span>TPS <b className="mono text-accent">{fmtRps(report.rps)}</b></span>
          </div>

          <table className="w-full text-left text-xs mono">
            <thead className="text-fg/40">
              <tr>
                {latencyCells(report, t).map((c) => (
                  <th key={c.k} className="px-2 py-1 font-normal">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-fg/5">
                {latencyCells(report, t).map((c) => (
                  <td key={c.k} className="px-2 py-1 text-fg/80">{fmtMs(c.v)}</td>
                ))}
              </tr>
            </tbody>
          </table>

          <div>
            <div className="text-xs text-fg/40 mb-1">{t("錯誤分組")}</div>
            {report.error_groups.length === 0 ? (
              <div className="text-xs text-fg/30">{t("沒有錯誤。")}</div>
            ) : (
              <div className="space-y-1 max-h-40 overflow-auto">
                {report.error_groups.map((g, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <Badge tone="danger">{g.count}</Badge>
                    <span className="mono text-fg/60 break-words min-w-0">{g.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// 延遲統計列（表頭 / 數值共用同一份定義，避免兩列漂移）。
function latencyCells(r: StressReport, t: (zh: string) => string) {
  return [
    { k: "min", label: t("最小"), v: r.min_ms },
    { k: "p50", label: "p50", v: r.p50_ms },
    { k: "p90", label: "p90", v: r.p90_ms },
    { k: "p95", label: "p95", v: r.p95_ms },
    { k: "p99", label: "p99", v: r.p99_ms },
    { k: "max", label: t("最大"), v: r.max_ms },
    { k: "avg", label: t("平均"), v: r.avg_ms },
    { k: "sd", label: t("標準差"), v: r.stddev_ms },
  ];
}

// 尚未收到第一筆進度時顯示破折號，而非把 undefined 丟進格式化函式。
function orDash(v: number | undefined, fmt: (n: number) => string): string {
  return v == null ? "—" : fmt(v);
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const cls = accent ? "text-accent" : "text-fg/90";
  return (
    <div className="bg-app/40 rounded px-3 py-2 border border-fg/5">
      <div className="text-fg/40 text-[10px]">{label}</div>
      <div className={`text-lg mono ${cls}`}>{value}</div>
    </div>
  );
}

// 數字欄位：type=number 空字串會變 NaN，統一收斂成 0，實際範圍交給 validatePlan 把關。
function NumField({ label, hint, value, onChange, min, max, disabled }: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        inputSize="md"
        className="mono"
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
      />
    </Field>
  );
}
