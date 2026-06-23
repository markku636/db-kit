import { useMemo, useState } from "react";
import { api, DbKind } from "./api";
import { buildCreateTable, NewColumn } from "./sql";
import { toast, useEscToClose } from "./ui";

const emptyCol = (): NewColumn => ({
  name: "",
  type: "",
  notNull: false,
  pk: false,
  unique: false,
  default: "",
});

// 常見型別快捷（datalist 提示，仍可自由輸入）。
const TYPE_PRESETS: Record<string, string[]> = {
  postgres: ["SERIAL", "BIGSERIAL", "INT", "BIGINT", "NUMERIC(10,2)", "TEXT", "VARCHAR(255)", "BOOLEAN", "DATE", "TIMESTAMPTZ", "UUID", "JSONB"],
  mysql: ["INT AUTO_INCREMENT", "INT", "BIGINT", "DECIMAL(10,2)", "TEXT", "VARCHAR(255)", "TINYINT(1)", "DATE", "DATETIME", "TIMESTAMP", "JSON"],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"],
};

// 設計表結構（致敬 Navicat / DataGrip 的表設計器）：以欄位格組出 CREATE TABLE 並執行。
export default function CreateTableDialog({ connId, database, kind, onClose, onCreated }: {
  connId: string;
  database: string;
  kind: DbKind;
  onClose: () => void;
  onCreated?: () => void;
}) {
  useEscToClose(onClose);
  const defaultIdType =
    kind === "postgres" ? "SERIAL" : kind === "mysql" ? "INT AUTO_INCREMENT" : "INTEGER";
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<NewColumn[]>([
    { ...emptyCol(), name: "id", type: defaultIdType, pk: true, notNull: true },
  ]);
  const [busy, setBusy] = useState(false);
  const presets = TYPE_PRESETS[kind] ?? TYPE_PRESETS.sqlite;

  const setCol = (i: number, patch: Partial<NewColumn>) =>
    setColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const addCol = () => setColumns((cs) => [...cs, emptyCol()]);
  const removeCol = (i: number) => setColumns((cs) => (cs.length > 1 ? cs.filter((_, j) => j !== i) : cs));

  const valid = !!table.trim() && columns.some((c) => c.name.trim() && c.type.trim());
  const previewSql = useMemo(
    () => (valid ? buildCreateTable(kind, database, table, columns) : "—"),
    [valid, kind, database, table, columns],
  );

  const create = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await api.runQuery(connId, buildCreateTable(kind, database, table, columns));
      toast.success(`資料表「${table.trim()}」已建立`);
      onCreated?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "建立資料表失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[860px] max-w-[94vw] max-h-[88vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm">設計表結構</span>
          <span className="text-xs text-white/40 mono">{database}</span>
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-3 overflow-auto">
          <label className="block">
            <span className="text-xs text-white/50 mb-1 block">資料表名稱</span>
            <input autoFocus className={inputCls} value={table} onChange={(e) => setTable(e.target.value)}
              placeholder="例：users" />
          </label>

          <datalist id="atkit-type-presets">
            {presets.map((t) => <option key={t} value={t} />)}
          </datalist>

          <div className="border border-white/10 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#10161e] text-white/45 text-xs">
                <tr>
                  <th className="text-left px-2 py-1.5 font-normal">欄名</th>
                  <th className="text-left px-2 py-1.5 font-normal">型別</th>
                  <th className="px-2 py-1.5 font-normal w-10" title="Not Null">NN</th>
                  <th className="px-2 py-1.5 font-normal w-10" title="Primary Key">PK</th>
                  <th className="px-2 py-1.5 font-normal w-10" title="Unique">UQ</th>
                  <th className="text-left px-2 py-1.5 font-normal">預設值</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {columns.map((c, i) => (
                  <tr key={i} className="border-t border-white/5">
                    <td className="px-2 py-1">
                      <input className={cellCls} value={c.name} placeholder="欄名"
                        onChange={(e) => setCol(i, { name: e.target.value })} />
                    </td>
                    <td className="px-2 py-1">
                      <input className={cellCls} list="atkit-type-presets" value={c.type} placeholder="型別"
                        onChange={(e) => setCol(i, { type: e.target.value })} />
                    </td>
                    <td className="text-center"><input type="checkbox" checked={c.notNull}
                      onChange={(e) => setCol(i, { notNull: e.target.checked })} /></td>
                    <td className="text-center"><input type="checkbox" checked={c.pk}
                      onChange={(e) => setCol(i, { pk: e.target.checked, notNull: e.target.checked ? true : c.notNull })} /></td>
                    <td className="text-center"><input type="checkbox" checked={c.unique} disabled={c.pk}
                      onChange={(e) => setCol(i, { unique: e.target.checked })} /></td>
                    <td className="px-2 py-1">
                      <input className={cellCls} value={c.default} placeholder="（無）"
                        onChange={(e) => setCol(i, { default: e.target.value })} />
                    </td>
                    <td className="text-center">
                      <button type="button" title="刪除此欄" onClick={() => removeCol(i)}
                        className="px-1 text-white/25 hover:text-red-400 disabled:opacity-20" disabled={columns.length <= 1}>−</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={addCol}
              className="w-full px-2 py-1.5 text-xs text-white/50 hover:bg-white/5 border-t border-white/10">＋ 新增欄位</button>
          </div>

          <div>
            <span className="text-xs text-white/40 mb-1 block">SQL 預覽</span>
            <pre className="bg-black/30 border border-white/10 rounded p-3 text-xs mono text-white/70 overflow-auto max-h-40 whitespace-pre-wrap">{previewSql}</pre>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">取消</button>
          <button type="button" onClick={create} disabled={busy || !valid}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40">
            {busy ? "建立中…" : "建立資料表"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500";
const cellCls = "w-full bg-black/20 border border-white/10 rounded px-1.5 py-1 text-sm mono outline-none focus:border-blue-500";
