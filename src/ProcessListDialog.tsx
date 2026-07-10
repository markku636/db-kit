import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api, DbKind, QueryResult } from "./api";
import { toast, uiConfirm } from "./ui";
import { Modal, Button } from "./ui/index";

// 列出目前連線 / 工作階段（致敬 Navicat 的伺服器監控）。沿用既有 runQuery（清單）+ execDdl（終止），免後端改動。
const LIST_SQL: Partial<Record<DbKind, string>> = {
  mysql: "SHOW FULL PROCESSLIST",
  mariadb: "SHOW FULL PROCESSLIST",
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
  const [auto, setAuto] = useState(false);
  const sql = LIST_SQL[kind];

  // silent：自動更新時不切換 busy（避免按鈕文字每 3 秒閃動）。
  const refresh = useCallback(async (silent = false) => {
    if (!sql) return;
    if (!silent) setBusy(true);
    setErr(null);
    try {
      setRes(await api.runQuery(connId, sql));
    } catch (e: any) {
      setErr(e?.message ?? "讀取失敗");
    } finally {
      if (!silent) setBusy(false);
    }
  }, [connId, sql]);

  useEffect(() => { void refresh(); }, [refresh]);
  // 自動更新：每 3 秒靜默重載；關閉 / 卸載時清除計時器。
  useEffect(() => {
    if (!auto || !sql) return;
    const timer = setInterval(() => { void refresh(true); }, 3000);
    return () => clearInterval(timer);
  }, [auto, sql, refresh]);

  // 終止：以每列第一欄為工作階段 ID（MySQL Id / PG pid）。ID 僅接受純數字（防注入）。
  // queryOnly=true 僅取消目前查詢（保留連線）：MySQL KILL QUERY / PG pg_cancel_backend。
  const kill = async (row: (string | null)[], queryOnly: boolean) => {
    const id = (row[0] ?? "").trim();
    if (!/^\d+$/.test(id)) { toast.error("無法辨識工作階段 ID"); return; }
    const verb = queryOnly ? "取消查詢" : "終止連線";
    const ok = await uiConfirm(`${verb}（工作階段 ${id}）？`, { title: verb, danger: true, confirmText: verb });
    if (!ok) return;
    const sql = kind === "postgres"
      ? `SELECT pg_${queryOnly ? "cancel" : "terminate"}_backend(${id})`
      : `KILL ${queryOnly ? "QUERY " : ""}${id}`;
    try {
      await api.execDdl(connId, sql);
      toast.success(`已送出${verb} ${id}`);
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? `${verb}失敗`);
    }
  };

  return (
    <Modal
      onClose={onClose}
      size="xl"
      zClass="z-[95]"
      className="h-[80vh]"
      bodyClassName="overflow-auto"
      icon={Activity}
      title={
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-sm">處理程序 / 工作階段</span>
          {res && <span className="text-xs text-fg/40">{res.rows.length} 筆</span>}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-fg/55">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            自動更新（3 秒）
          </label>
          <button type="button" onClick={() => refresh()} disabled={busy}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">{busy ? "讀取中…" : "重新整理"}</button>
        </div>
      }
      footer={<Button variant="secondary" onClick={onClose}>關閉</Button>}
    >
      {!sql ? (
            <div className="text-fg/40 text-sm p-5">此資料庫種類不支援工作階段檢視。</div>
          ) : err ? (
            <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
          ) : !res ? (
            <div className="text-fg/40 text-sm p-5">讀取中…</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-inset text-fg/45">
                <tr>
                  <th className="w-24 px-2 py-1.5" aria-label="操作" />
                  {res.columns.map((c) => <th key={c} className="text-left px-2 py-1.5 font-normal whitespace-nowrap">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {res.rows.map((row, i) => (
                  <tr key={i} className="border-t border-fg/5 hover:bg-fg/5">
                    <td className="px-2 py-1 text-center whitespace-nowrap">
                      <button type="button" onClick={() => kill(row, true)} title="取消目前查詢（保留連線）"
                        className="text-[11px] px-1.5 py-0.5 rounded text-amber-300 hover:bg-amber-500/15">取消</button>
                      <button type="button" onClick={() => kill(row, false)} title="終止整個連線"
                        className="text-[11px] px-1.5 py-0.5 rounded text-red-400 hover:bg-red-500/15">終止</button>
                    </td>
                    {row.map((v, j) => (
                      <td key={j} className="px-2 py-1 mono text-fg/80 max-w-[340px] truncate" title={v ?? "NULL"}>
                        {v ?? <span className="text-fg/30">NULL</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </Modal>
  );
}
