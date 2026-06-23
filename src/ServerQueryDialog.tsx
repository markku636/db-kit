import { useCallback, useEffect, useState } from "react";
import { api, QueryResult } from "./api";
import { useEscToClose } from "./ui";

// 通用唯讀結果檢視器：執行一段 SQL（如使用者 / 角色、伺服器變數）並以表格呈現，可重新整理。
export default function ServerQueryDialog({ connId, title, sql, onClose }: {
  connId: string;
  title: string;
  sql: string;
  onClose: () => void;
}) {
  useEscToClose(onClose);
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[860px] max-w-[96vw] h-[78vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm">{title}</span>
          {res && <span className="text-xs text-white/40">{res.rows.length} 筆</span>}
          <button type="button" onClick={() => refresh()} disabled={busy}
            className="ml-auto text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">{busy ? "讀取中…" : "重新整理"}</button>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white">✕</button>
        </div>
        <div className="flex-1 overflow-auto">
          {err ? (
            <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
          ) : !res ? (
            <div className="text-white/40 text-sm p-5">讀取中…</div>
          ) : res.rows.length === 0 ? (
            <div className="text-white/40 text-sm p-5">（無資料）</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#10161e] text-white/45">
                <tr>{res.columns.map((c) => <th key={c} className="text-left px-3 py-1.5 font-normal whitespace-nowrap">{c}</th>)}</tr>
              </thead>
              <tbody>
                {res.rows.map((row, i) => (
                  <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                    {row.map((v, j) => (
                      <td key={j} className="px-3 py-1 mono text-white/80 max-w-[360px] truncate" title={v ?? "NULL"}>
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
