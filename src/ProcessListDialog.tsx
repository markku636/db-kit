import { useCallback, useEffect, useState } from "react";
import { api, DbKind, QueryResult } from "./api";
import { toast, uiConfirm } from "./ui";

// 列出目前連線 / 工作階段（致敬 Navicat 的伺服器監控）。沿用既有 runQuery（清單）+ execDdl（終止），免後端改動。
const LIST_SQL: Partial<Record<DbKind, string>> = {
  mysql: "SHOW FULL PROCESSLIST",
  postgres:
    "SELECT pid, usename, client_addr::text, datname, state, " +
    "EXTRACT(EPOCH FROM (now() - query_start))::int AS sec, query " +
    "FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state IS NOT NULL ORDER BY query_start NULLS LAST",
};

export default function ProcessListDialog({ connId, kind, onClose }: {
  connId: string;
  kind: DbKind;
  onClose: () => void;
}) {
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sql = LIST_SQL[kind];

  const refresh = useCallback(async () => {
    if (!sql) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.runQuery(connId, sql));
    } catch (e: any) {
      setErr(e?.message ?? "讀取失敗");
    } finally {
      setBusy(false);
    }
  }, [connId, sql]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 終止：以每列第一欄為工作階段 ID（MySQL Id / PG pid）。ID 僅接受純數字（防注入）。
  const kill = async (row: (string | null)[]) => {
    const id = (row[0] ?? "").trim();
    if (!/^\d+$/.test(id)) { toast.error("無法辨識工作階段 ID"); return; }
    const ok = await uiConfirm(`終止工作階段 ${id}？`, { title: "終止連線", danger: true, confirmText: "終止" });
    if (!ok) return;
    try {
      await api.execDdl(connId, kind === "postgres" ? `SELECT pg_terminate_backend(${id})` : `KILL ${id}`);
      toast.success(`已送出終止 ${id}`);
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "終止失敗");
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[920px] max-w-[96vw] h-[80vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm">處理程序 / 工作階段</span>
          {res && <span className="text-xs text-white/40">{res.rows.length} 筆</span>}
          <button type="button" onClick={() => refresh()} disabled={busy}
            className="ml-auto text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">{busy ? "讀取中…" : "重新整理"}</button>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white">✕</button>
        </div>

        <div className="flex-1 overflow-auto">
          {!sql ? (
            <div className="text-white/40 text-sm p-5">此資料庫種類不支援工作階段檢視。</div>
          ) : err ? (
            <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
          ) : !res ? (
            <div className="text-white/40 text-sm p-5">讀取中…</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#10161e] text-white/45">
                <tr>
                  <th className="w-16 px-2 py-1.5" aria-label="操作" />
                  {res.columns.map((c) => <th key={c} className="text-left px-2 py-1.5 font-normal whitespace-nowrap">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {res.rows.map((row, i) => (
                  <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                    <td className="px-2 py-1 text-center">
                      <button type="button" onClick={() => kill(row)}
                        className="text-[11px] px-1.5 py-0.5 rounded text-red-400 hover:bg-red-500/15">終止</button>
                    </td>
                    {row.map((v, j) => (
                      <td key={j} className="px-2 py-1 mono text-white/80 max-w-[340px] truncate" title={v ?? "NULL"}>
                        {v ?? <span className="text-white/30">NULL</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">關閉</button>
        </div>
      </div>
    </div>
  );
}
