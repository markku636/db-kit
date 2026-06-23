import { useMemo, useState } from "react";
import { api, DbKind } from "./api";
import { buildCreateView } from "./sql";
import { toast, useEscToClose } from "./ui";

// 新增視圖：輸入名稱 + SELECT → CREATE VIEW（走 exec_ddl 簡單協定，與其他 DDL 一致）。
export default function CreateViewDialog({ connId, database, kind, onClose, onCreated }: {
  connId: string;
  database: string;
  kind: DbKind;
  onClose: () => void;
  onCreated?: () => void;
}) {
  useEscToClose(onClose);
  const [name, setName] = useState("");
  const [select, setSelect] = useState("SELECT * FROM ");
  const [busy, setBusy] = useState(false);

  const valid = !!name.trim() && /\bselect\b/i.test(select);
  const previewSql = useMemo(
    () => (valid ? buildCreateView(kind, database, name, select) : "—"),
    [valid, kind, database, name, select],
  );

  const create = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await api.execDdl(connId, buildCreateView(kind, database, name, select));
      toast.success(`視圖「${name.trim()}」已建立`);
      onCreated?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "建立視圖失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[640px] max-w-[94vw] max-h-[88vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm">新增視圖</span>
          <span className="text-xs text-white/40 mono">{database}</span>
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-3 overflow-auto">
          <label className="block">
            <span className="text-xs text-white/50 mb-1 block">視圖名稱</span>
            <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)}
              placeholder="例：active_users" />
          </label>
          <label className="block">
            <span className="text-xs text-white/50 mb-1 block">SELECT 查詢</span>
            <textarea className={`${inputCls} h-40 resize-none`} value={select} spellCheck={false}
              onChange={(e) => setSelect(e.target.value)} placeholder="SELECT ..." />
          </label>
          <div>
            <span className="text-xs text-white/40 mb-1 block">SQL 預覽</span>
            <pre className="bg-black/30 border border-white/10 rounded p-3 text-xs mono text-white/70 overflow-auto max-h-32 whitespace-pre-wrap">{previewSql}</pre>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">取消</button>
          <button type="button" onClick={create} disabled={busy || !valid}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40">
            {busy ? "建立中…" : "建立視圖"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm mono outline-none focus:border-blue-500";
