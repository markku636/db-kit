import { useEffect, useRef, useState } from "react";
import { FileCode2, FolderOpen, Play, Square } from "lucide-react";
import { api, isProdConn, onSqlFileProgress, type SqlFileProgress, type SqlFileReport } from "./api";
import { useStore } from "./store";
import { pickOpenFile, uiConfirm } from "./ui";
import { Badge, Button, Modal } from "./ui/index";
import { useT } from "./i18n";

/**
 * 執行 SQL 檔：選一個 .sql，在同一條專屬連線上逐句執行（USE / SET / 交易 / 暫存表跨句有效），
 * 顯示進度與每句錯誤（含行號）。遇錯即停或繼續執行二選一；取消於下一句開始前生效。
 * 切句規則與傾印檔的特例（DELIMITER、GO、psql 指令行、COPY FROM stdin）見 src-tauri/src/sqlfile.rs。
 */
export default function SqlFileDialog({ connId, database, onClose, onDone }: {
  connId: string;
  database: string;
  onClose: () => void;
  /** 執行結束（有語句成功）後呼叫：讓外層重新整理物件樹。 */
  onDone?: () => void;
}) {
  const t = useT();
  const conn = useStore((s) => s.connections.find((c) => c.id === connId));
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const [path, setPath] = useState("");
  const [continueOnError, setContinueOnError] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SqlFileProgress | null>(null);
  const [report, setReport] = useState<SqlFileReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => () => { if (runIdRef.current) void api.runSqlFileCancel(runIdRef.current); }, []);

  const pick = async () => {
    const p = await pickOpenFile([{ name: "SQL", extensions: ["sql", "txt"] }]);
    if (p) { setPath(p); setReport(null); setError(null); }
  };

  const run = async () => {
    if (!path || readonly) return;
    if (conn && isProdConn(conn) && !(await uiConfirm(
      t("「{name}」是正式環境。確定要對它執行整份 SQL 檔？", { name: conn.name }),
      { title: t("正式環境"), danger: true, confirmText: t("執行") },
    ))) return;
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunning(true);
    setReport(null);
    setError(null);
    setProgress(null);
    const unlisten = await onSqlFileProgress(runId, setProgress);
    try {
      const r = await api.runSqlFile(runId, connId, database, path, { continue_on_error: continueOnError });
      setReport(r);
      if (r.executed > 0) onDone?.();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      unlisten();
      runIdRef.current = null;
      setRunning(false);
    }
  };

  const fileName = path.split(/[\\/]/).pop() ?? path;
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Modal
      onClose={onClose}
      title={t("執行 SQL 檔")}
      icon={FileCode2}
      size="lg"
      zClass="z-50"
      bodyClassName="p-5 space-y-3 overflow-auto max-h-[70vh]"
      footer={
        <>
          {running
            ? <Button variant="secondary" icon={Square} onClick={() => { if (runIdRef.current) void api.runSqlFileCancel(runIdRef.current); }}>{t("取消")}</Button>
            : <Button variant="primary" icon={Play} disabled={!path || readonly} onClick={() => void run()} data-sql-file-run>{t("執行")}</Button>}
          <Button variant="secondary" onClick={onClose} disabled={running}>{t("關閉")}</Button>
        </>
      }
    >
      <div className="text-xs text-fg/50">
        {t("目標：{conn}{db}", { conn: conn?.name ?? connId, db: database ? ` · ${database}` : "" })}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" icon={FolderOpen} onClick={() => void pick()} disabled={running} data-sql-file-pick>{t("選擇檔案…")}</Button>
        <span className="mono text-xs text-fg/70 truncate" title={path} data-sql-file-path>{path ? fileName : t("尚未選擇")}</span>
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input type="checkbox" checked={continueOnError} disabled={running} onChange={(e) => setContinueOnError(e.target.checked)} />
        {t("某句失敗時繼續執行後面的語句（預設遇錯即停）")}
      </label>
      {readonly && <div className="text-xs text-red-400">{t("此連線為唯讀模式，不能執行 SQL 檔。")}</div>}
      <div className="text-xs text-fg/40">
        {t("整份檔案在同一條連線上逐句執行，USE / SET / 交易 / 暫存表跨句有效。支援 MySQL 的 DELIMITER 與 SQL Server 的 GO；PostgreSQL 的 psql 指令行會略過，COPY … FROM stdin 資料區塊不支援（請用 --inserts 匯出）。取消於下一句開始前生效。")}
      </div>

      {running && (
        <div className="space-y-1" data-sql-file-progress>
          <div className="h-1.5 rounded bg-fg/10 overflow-hidden"><div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} /></div>
          <div className="text-xs text-fg/60 mono">
            {progress
              ? t("{done} / {total} 句 · 失敗 {failed} · {s} 秒", { done: progress.done, total: progress.total, failed: progress.failed, s: (progress.elapsed_ms / 1000).toFixed(1) })
              : t("讀取檔案…")}
          </div>
        </div>
      )}
      {error && <div className="text-sm text-red-400 whitespace-pre-wrap" data-sql-file-error>{error}</div>}

      {report && (
        <div className="space-y-2" data-sql-file-report>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="success">{t("成功 {n}", { n: report.executed })}</Badge>
            {report.failed > 0 && <Badge tone="danger">{t("失敗 {n}", { n: report.failed })}</Badge>}
            {report.cancelled && <Badge tone="warning">{t("已取消")}</Badge>}
            {report.stopped_on_error && <Badge tone="warning">{t("遇錯已停止")}</Badge>}
            <span className="text-xs text-fg/50 mono">{t("共 {total} 句 · {s} 秒", { total: report.total, s: (report.elapsed_ms / 1000).toFixed(1) })}</span>
          </div>
          {(report.cancelled || report.stopped_on_error) && (
            <div className="text-xs text-fg/50">{t("沒有執行到的語句：{n} 句。", { n: report.total - report.executed - report.failed })}</div>
          )}
          {report.skipped_meta > 0 && <div className="text-xs text-fg/50">{t("略過 {n} 行 psql 指令。", { n: report.skipped_meta })}</div>}
          {report.errors.length > 0 && (
            <ul className="space-y-2">
              {report.errors.map((e) => (
                <li key={e.index} className="rounded border border-red-500/20 bg-red-500/5 p-2 text-xs space-y-1">
                  <div className="text-red-300">{t("第 {line} 行：{msg}", { line: e.line, msg: e.message })}</div>
                  <pre className="mono text-fg/50 whitespace-pre-wrap break-all max-h-24 overflow-auto">{e.sql}</pre>
                </li>
              ))}
            </ul>
          )}
          {report.errors_omitted > 0 && <div className="text-xs text-fg/40">{t("另有 {n} 筆錯誤未列出。", { n: report.errors_omitted })}</div>}
        </div>
      )}
    </Modal>
  );
}
