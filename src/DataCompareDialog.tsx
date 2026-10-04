import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ArrowRight, Copy, Rows3, Save, Send, Square } from "lucide-react";
import { api, onCompareProgress, type CompareProgress, type DataDiffReport, type DbKind } from "./api";
import { useStore } from "./store";
import { copyToClipboard, pickSaveFile, toast } from "./ui";
import { Badge, Button, Icon, IconButton, Input, Modal, Segmented } from "./ui/index";
import type { CompareTarget } from "./compareModel";
import CompareTargetPicker from "./CompareTargetPicker";
import { useT } from "./i18n";

/**
 * 單表資料列比對：以主鍵比對來源與目標兩表，列出新增 / 更新 / 刪除筆數與樣本，產生讓目標與來源一致的同步 SQL。
 *
 * 刻意與「結構比對」分開成獨立對話框（v0.30 的取捨仍成立：兩件事擠在同一框只會讓結構比對難用），
 * 而且**這裡不直接套用到目標**——同步 SQL 只能複製、存檔或送到目標連線的查詢編輯器，
 * 真正執行時就走編輯器既有的正式環境確認 / 審查並執行，不另開一條會改資料的捷徑。
 * 引擎與 `dbk compare data` 共用（`src-tauri/src/compare/data.rs`）：主鍵排序串流 merge-join，無列數上限。
 */
export default function DataCompareDialog({ connId, kind, database, table, onClose, onUse }: {
  connId: string;
  kind: DbKind;
  database: string;
  table: string;
  onClose: () => void;
  onUse: (sql: string, targetConnId: string) => void;
}) {
  const t = useT();
  const connections = useStore((s) => s.connections);
  const [source, setSource] = useState({ connId, db: database, table });
  const srcKind = connections.find((c) => c.id === source.connId)?.kind ?? kind;
  const srcName = connections.find((c) => c.id === source.connId)?.name ?? source.connId;
  const [target, setTarget] = useState<CompareTarget>({ mode: "live", connId, db: "", table: undefined });
  const [includeDeletes, setIncludeDeletes] = useState(false);
  const [trimSpaces, setTrimSpaces] = useState(false);
  const [ignoreCols, setIgnoreCols] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CompareProgress | null>(null);
  const [report, setReport] = useState<DataDiffReport | null>(null);
  const [ran, setRan] = useState<{ dstConnId: string; dstLabel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleTab, setSampleTab] = useState<"updates" | "inserts" | "deletes">("updates");
  const runIdRef = useRef<string | null>(null);

  // 關窗時若還在跑，順手取消（後端在下一頁邊界收手）。
  useEffect(() => () => { if (runIdRef.current) void api.compareDataCancel(runIdRef.current); }, []);

  const live = target.mode === "live" ? target : null;
  const dstTable = live?.table ?? source.table;
  const sameTable = !!live && live.connId === source.connId && live.db === source.db && dstTable === source.table;
  const ready = !!live && !!live.db && !!live.table && !sameTable && !running;
  const dstName = live ? connections.find((c) => c.id === live.connId)?.name ?? "" : "";

  const swap = () => {
    if (!live?.table) return;
    const next = { connId: live.connId, db: live.db, table: live.table };
    setTarget({ mode: "live", connId: source.connId, db: source.db, table: source.table });
    setSource(next);
    setReport(null);
  };

  const run = async () => {
    if (!live?.table) return;
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunning(true);
    setError(null);
    setReport(null);
    setProgress(null);
    const unlisten = await onCompareProgress(runId, setProgress);
    try {
      const r = await api.compareDataTable(
        runId,
        { conn_id: source.connId, database: source.db, table: source.table },
        { conn_id: live.connId, database: live.db, table: live.table },
        {
          mode: "sql",
          include_deletes: includeDeletes,
          ignore_trailing_spaces: trimSpaces,
          ignore_columns: ignoreCols.split(",").map((s) => s.trim()).filter(Boolean),
        },
      );
      setReport(r);
      setRan({ dstConnId: live.connId, dstLabel: `${dstName} · ${live.db} · ${live.table}` });
      const s = r.summary;
      setSampleTab(s.updates > 0 ? "updates" : s.inserts > 0 ? "inserts" : "deletes");
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      runIdRef.current = null;
      setRunning(false);
    }
  };

  const cancel = () => { if (runIdRef.current) void api.compareDataCancel(runIdRef.current); };

  const sql = report?.sql ?? "";
  const s = report?.summary;
  const identical = !!s && s.inserts + s.updates + s.deletes === 0 && !s.truncated_reason && !s.cancelled;

  const saveSql = async () => {
    const path = await pickSaveFile(`${source.table}-data-sync.sql`, [{ name: "SQL", extensions: ["sql"] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, sql);
      toast.success(t("已儲存"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Modal
      onClose={onClose}
      codeZoom
      title={<>{t("資料比對 ·")} <span className="mono text-fg/60">{source.table}</span></>}
      icon={Rows3}
      size="xl"
      zClass="z-50"
      className="h-[82vh]"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="mono text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 truncate" data-compare-source>{srcName} · {source.db} · {source.table}</span>
        <IconButton icon={ArrowLeftRight} label={t("交換來源與目標")} iconSize={14} box="w-6 h-6" disabled={!live?.table || sameTable || running} onClick={swap} />
        <Icon icon={ArrowRight} size={14} className="text-fg/30 shrink-0" />
        <span className="text-xs text-fg/40 shrink-0">{t("比對目標")}</span>
      </div>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <CompareTargetPicker srcConnId={source.connId} srcKind={srcKind} srcDb={source.db} srcTable={source.table} withTable allowSnapshot={false}
            value={target} onChange={setTarget} disabled={running} />
        </div>
        {running
          ? <Button variant="secondary" icon={Square} onClick={cancel}>{t("取消")}</Button>
          : <Button variant="primary" icon={Rows3} disabled={!ready} onClick={() => void run()} data-data-compare-run>{t("比對")}</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={includeDeletes} disabled={running} onChange={(e) => setIncludeDeletes(e.target.checked)} data-data-compare-opt="include_deletes" />
          {t("產生 DELETE（刪除目標多出的列）")}
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={trimSpaces} disabled={running} onChange={(e) => setTrimSpaces(e.target.checked)} />
          {t("忽略字串尾端空白")}
        </label>
        <label className="flex items-center gap-2">
          <span className="text-fg/60 shrink-0">{t("忽略欄位")}</span>
          <Input className="w-56" value={ignoreCols} disabled={running} placeholder={t("以逗號分隔，例如 updated_at")}
            onChange={(e) => setIgnoreCols(e.target.value)} />
        </label>
      </div>
      {sameTable && <div className="text-xs text-red-400">{t("來源與目標是同一張表，請改選其他連線 / 資料庫 / 資料表。")}</div>}

      {running && (
        <div className="text-xs text-fg/60 space-y-1" data-data-compare-progress>
          <div className="progress-track" role="progressbar"><div className="progress-thumb" /></div>
          {progress && (
            <div className="mono">
              {t("已掃描 來源 {src} / 目標 {dst} 列 · 新增 {ins} · 更新 {upd} · 刪除 {del}", {
                src: progress.src_rows.toLocaleString(), dst: progress.dst_rows.toLocaleString(),
                ins: progress.inserts, upd: progress.updates, del: progress.deletes,
              })}
            </div>
          )}
        </div>
      )}
      {error && <div className="text-sm text-red-400 whitespace-pre-wrap" data-data-compare-error>{error}</div>}

      {!report && !running && !error && (
        <div className="text-xs text-fg/40">
          {t("以主鍵比對兩表的資料列（只比兩邊都有的欄位），算出讓目標與來源一致所需的 INSERT / UPDATE / DELETE。結果只產生 SQL，不會直接改動目標——請檢查後送到目標連線的查詢編輯器執行。沒有主鍵的表無法比對。")}
        </div>
      )}

      {report && s && (
        <div className="space-y-3" data-data-compare-result>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {identical
              ? <Badge tone="success">{t("資料相同")}</Badge>
              : <>
                <Badge tone="success">{t("新增 {n}", { n: s.inserts.toLocaleString() })}</Badge>
                <Badge tone="warning">{t("更新 {n}", { n: s.updates.toLocaleString() })}</Badge>
                <Badge tone={s.deletes_suppressed ? "neutral" : "danger"}>{t("刪除 {n}", { n: s.deletes.toLocaleString() })}</Badge>
              </>}
            <span className="text-xs text-fg/50 mono">
              {t("來源 {src} 列 · 目標 {dst} 列 · 主鍵 {pk} · {ms} ms", {
                src: s.src_rows.toLocaleString(), dst: s.dst_rows.toLocaleString(), pk: report.pk.join(", "), ms: s.elapsed_ms.toLocaleString(),
              })}
            </span>
          </div>
          {(s.truncated_reason || s.cancelled || s.deletes_suppressed || s.warnings.length > 0
            || report.skipped_src_columns.length > 0 || report.skipped_dst_columns.length > 0) && (
            <ul className="text-xs text-amber-300/90 list-disc pl-5 space-y-0.5">
              {s.cancelled && <li>{t("已取消：以下只是部分結果。")}</li>}
              {s.truncated_reason && <li>{t("比對提前結束（{reason}），結果不完整。", { reason: s.truncated_reason })}</li>}
              {s.deletes_suppressed && s.deletes > 0 && <li>{t("未勾「產生 DELETE」：目標多出的 {n} 列只列出、不產生刪除語句。", { n: s.deletes })}</li>}
              {report.skipped_src_columns.length > 0 && <li>{t("只在來源的欄位未比對：{cols}", { cols: report.skipped_src_columns.join(", ") })}</li>}
              {report.skipped_dst_columns.length > 0 && <li>{t("只在目標的欄位未比對：{cols}", { cols: report.skipped_dst_columns.join(", ") })}</li>}
              {s.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          {!identical && (
            <>
              <Segmented
                value={sampleTab}
                onChange={(v) => setSampleTab(v as typeof sampleTab)}
                options={[
                  { value: "updates", label: t("更新 ({n})", { n: s.updates }) },
                  { value: "inserts", label: t("新增 ({n})", { n: s.inserts }) },
                  { value: "deletes", label: t("刪除 ({n})", { n: s.deletes }) },
                ]}
              />
              <SampleTable report={report} tab={sampleTab} />
            </>
          )}

          {sql && ran && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-fg/70">{t("同步 SQL")}</span>
                <span className="text-xs text-fg/40 truncate">→ {ran.dstLabel}</span>
                <div className="flex-1" />
                <Button size="sm" variant="secondary" icon={Copy} onClick={() => void copyToClipboard(sql)}>{t("複製")}</Button>
                <Button size="sm" variant="secondary" icon={Save} onClick={() => void saveSql()}>{t("存檔…")}</Button>
                <Button size="sm" variant="primary" icon={Send} onClick={() => onUse(sql, ran.dstConnId)} data-data-compare-send>{t("送到目標的查詢編輯器")}</Button>
              </div>
              <pre className="mono text-xs bg-black/25 rounded p-3 max-h-64 overflow-auto whitespace-pre" data-data-compare-sql>{sql}</pre>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** 差異樣本：更新列逐欄並排（改到的欄位標色），新增 / 刪除列直接列出。樣本有上限（後端 sample_cap）。 */
function SampleTable({ report, tab }: { report: DataDiffReport; tab: "updates" | "inserts" | "deletes" }) {
  const t = useT();
  const cols = report.columns;
  const cell = (v: string | null) => v === null ? <span className="text-fg/30 italic">NULL</span> : v;
  const total = tab === "updates" ? report.summary.updates : tab === "inserts" ? report.summary.inserts : report.summary.deletes;
  const shown = tab === "updates" ? report.samples.updates.length : report.samples[tab].length;
  if (shown === 0) return <div className="text-xs text-fg/40">{t("沒有這類差異。")}</div>;
  return (
    <div className="space-y-1">
      <div className="overflow-auto max-h-72 rounded border border-white/10" data-data-compare-samples={tab}>
        <table className="text-xs mono w-full">
          <thead className="sticky top-0 bg-[rgb(var(--panel))]">
            <tr>
              {tab === "updates" && <th className="px-2 py-1 text-left text-fg/40 font-normal" />}
              {cols.map((c) => <th key={c} className="px-2 py-1 text-left text-fg/60 font-normal whitespace-nowrap">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {tab === "updates"
              ? report.samples.updates.map((u, i) => (
                <UpdateRows key={i} cols={cols} src={u.src} dst={u.dst} changed={new Set(u.changed)} cell={cell} />
              ))
              : report.samples[tab].map((row, i) => (
                <tr key={i} className="border-t border-white/5">
                  {row.map((v, j) => <td key={j} className="px-2 py-1 whitespace-nowrap">{cell(v)}</td>)}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {shown < total && <div className="text-xs text-fg/40">{t("只顯示前 {shown} 筆樣本（共 {total} 筆）；同步 SQL 含全部。", { shown, total })}</div>}
    </div>
  );
}

function UpdateRows({ cols, src, dst, changed, cell }: {
  cols: string[]; src: (string | null)[]; dst: (string | null)[]; changed: Set<string>; cell: (v: string | null) => React.ReactNode;
}) {
  const t = useT();
  return (
    <>
      <tr className="border-t border-white/10">
        <td className="px-2 py-1 text-blue-300/80 whitespace-nowrap">{t("來源")}</td>
        {cols.map((c, j) => <td key={c} className={`px-2 py-1 whitespace-nowrap ${changed.has(c) ? "bg-emerald-500/15 text-emerald-200" : ""}`}>{cell(src[j] ?? null)}</td>)}
      </tr>
      <tr>
        <td className="px-2 py-1 text-fg/40 whitespace-nowrap">{t("目標")}</td>
        {cols.map((c, j) => <td key={c} className={`px-2 py-1 whitespace-nowrap ${changed.has(c) ? "bg-red-500/15 text-red-200 line-through decoration-red-300/40" : "text-fg/50"}`}>{cell(dst[j] ?? null)}</td>)}
      </tr>
    </>
  );
}
