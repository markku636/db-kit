import { useEffect, useState } from "react";
import { api, DbKind } from "./api";
import { useEscToClose, toast } from "./ui";
import { viewDefinitionSql, buildReplaceView, formatSql } from "./sql";

// 設計檢視（對標 Navicat「設計檢視」）：載入既有視圖的 SELECT 定義，編輯後以 CREATE OR REPLACE VIEW 套用。
// MySQL 透過 information_schema.VIEWS（僅 SELECT，免解析）；PostgreSQL 透過 pg_get_viewdef。
export default function ViewDesigner({ connId, db, view, kind, onClose, onSaved }: {
  connId: string;
  db: string;
  view: string;
  kind: DbKind;
  onClose: () => void;
  onSaved?: () => void;
}) {
  useEscToClose(onClose);
  const [select, setSelect] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await api.runQuery(connId, viewDefinitionSql(kind, db, view));
        const def = r.rows[0]?.[0] ?? "";
        if (alive) setSelect(def);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? "載入視圖定義失敗");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [connId, db, view, kind]);

  const save = async () => {
    if (!select.trim()) { toast.error("SELECT 定義不可為空"); return; }
    setBusy(true);
    try {
      await api.execDdl(connId, buildReplaceView(kind, db, view, select));
      toast.success(`視圖 ${view} 已更新`);
      onSaved?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "更新視圖失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[820px] max-w-[96vw] h-[76vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm">設計檢視：{db}.{view}</span>
          <button type="button" onClick={() => setSelect((s) => formatSql(s))} disabled={loading || busy}
            className="ml-auto text-xs text-white/60 hover:text-white disabled:opacity-40">格式化</button>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white">✕</button>
        </div>
        <div className="px-5 py-2 text-xs text-white/40 border-b border-white/10">
          編輯下方 SELECT 後按「儲存」，將以 CREATE OR REPLACE VIEW 套用。
        </div>
        <div className="flex-1 overflow-hidden p-3">
          {loading ? (
            <div className="text-white/40 text-sm p-2">載入中…</div>
          ) : err ? (
            <div className="text-red-300 text-sm p-2 mono whitespace-pre-wrap">{err}</div>
          ) : (
            <textarea value={select} onChange={(e) => setSelect(e.target.value)} spellCheck={false}
              className="w-full h-full bg-[#0c1118] border border-white/10 rounded p-3 mono text-xs text-white/85 resize-none outline-none focus:border-blue-500/50" />
          )}
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">取消</button>
          <button type="button" onClick={save} disabled={loading || busy}
            className="px-3 py-1.5 text-sm rounded bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40">{busy ? "儲存中…" : "儲存"}</button>
        </div>
      </div>
    </div>
  );
}
