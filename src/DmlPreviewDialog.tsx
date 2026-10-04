import { useEffect, useState } from "react";
import { Eye, ShieldCheck } from "lucide-react";
import { api, type DmlPreview, type DmlStatementPreview } from "./api";
import { Badge, Button, Modal, Spinner } from "./ui/index";
import { useT } from "./i18n";

/**
 * 影響列預覽：把編輯器裡（或選取段）的 UPDATE / DELETE / INSERT 改寫成唯讀 SELECT，先看會碰到哪些列。
 * 不執行、不送 AI、不寫檔——與「審查並執行」共用同一套分析，所以這裡看到的列就是它會備份的前像。
 * 要真的執行（含備份與回滾腳本）時按「審查並執行…」接手。
 */
export default function DmlPreviewDialog({ connId, database, sql, onClose, onReviewRun }: {
  connId: string;
  database: string;
  sql: string;
  onClose: () => void;
  onReviewRun?: () => void;
}) {
  const t = useT();
  const [res, setRes] = useState<DmlPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.previewDml(connId, database, sql)
      .then((r) => { if (alive) setRes(r); })
      .catch((e) => { if (alive) setErr(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [connId, database, sql]);

  const writes = res?.statements.filter((s) => s.write) ?? [];

  return (
    <Modal
      onClose={onClose}
      codeZoom
      title={t("預覽影響列")}
      icon={Eye}
      size="xl"
      zClass="z-50"
      className="h-[82vh]"
      bodyClassName="p-5 space-y-4 overflow-auto"
      footer={
        <>
          {onReviewRun && (
            <Button variant="secondary" icon={ShieldCheck} onClick={onReviewRun}>{t("審查並執行…")}</Button>
          )}
          <Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>
        </>
      }
    >
      <div className="text-xs text-fg/50">
        {t("只執行唯讀 SELECT 找出每句寫入語句會碰到的列，不會改動資料。數字以目前狀態為準；同一份腳本前面的語句若改過同一張表，實際執行時可能不同。")}
      </div>
      {!res && !err && (
        <div className="flex items-center gap-2 text-sm text-fg/50"><Spinner size={14} /> {t("分析中…")}</div>
      )}
      {err && <div className="text-sm text-red-400 whitespace-pre-wrap" data-dml-preview-error>{err}</div>}
      {res && res.blockers.length > 0 && (
        <ul className="text-xs text-red-300/90 list-disc pl-5">
          {res.blockers.map((b, i) => <li key={i}>{t("第 {n} 句：{msg}", { n: b.index + 1, msg: b.message })}</li>)}
        </ul>
      )}
      {res && writes.length === 0 && (
        <div className="text-sm text-fg/50">{t("這段 SQL 沒有寫入語句，不需要預覽。")}</div>
      )}
      {writes.map((s) => <StatementBlock key={s.index} s={s} />)}
    </Modal>
  );
}

function StatementBlock({ s }: { s: DmlStatementPreview }) {
  const t = useT();
  const sqlOneLine = s.sql.split(/\s+/).join(" ");
  return (
    <section className="space-y-2" data-dml-preview-stmt={s.index}>
      <div className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-fg/40 mono shrink-0">#{s.index + 1}</span>
        <Badge tone={s.op === "delete" || s.op === "truncate" ? "danger" : s.op === "update" ? "warning" : "info"}>{s.op.toUpperCase()}</Badge>
        {s.estimated_rows !== null && (
          <span className="text-xs shrink-0" data-dml-preview-count>
            {s.estimate_exact ? t("影響 {n} 列", { n: s.estimated_rows.toLocaleString() }) : t("最多影響 {n} 列", { n: s.estimated_rows.toLocaleString() })}
          </span>
        )}
        <span className="mono text-xs text-fg/50 truncate" title={s.sql}>{sqlOneLine}</span>
      </div>
      {s.notes.filter((n) => n.level !== "info").map((n, i) => (
        <div key={i} className={`text-xs ${n.level === "error" ? "text-red-300/90" : "text-amber-300/90"}`}>⚠ {n.message}</div>
      ))}
      {s.detail && <div className="text-xs text-fg/50">{s.detail}</div>}
      {s.columns.length > 0 && s.rows.length > 0 && (
        <div className="space-y-1">
          <div className="overflow-auto max-h-72 rounded border border-white/10">
            <table className="text-xs mono w-full">
              <thead className="sticky top-0 bg-[rgb(var(--panel))]">
                <tr>{s.columns.map((c) => <th key={c} className="px-2 py-1 text-left text-fg/60 font-normal whitespace-nowrap">{c}</th>)}</tr>
              </thead>
              <tbody>
                {s.rows.map((r, i) => (
                  <tr key={i} className="border-t border-white/5">
                    {r.map((v, j) => (
                      <td key={j} className="px-2 py-1 whitespace-nowrap max-w-[24rem] truncate" title={v ?? "NULL"}>
                        {v === null ? <span className="text-fg/30 italic">NULL</span> : v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.truncated && <div className="text-xs text-fg/40">{t("只列出前 {n} 列。", { n: s.rows.length })}</div>}
        </div>
      )}
      {s.columns.length > 0 && s.rows.length === 0 && !s.detail && (
        <div className="text-xs text-fg/50">{t("目前沒有符合條件的列：這句不會改到任何資料。")}</div>
      )}
    </section>
  );
}
