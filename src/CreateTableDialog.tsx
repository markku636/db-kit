import { useMemo, useState } from "react";
import { Minus, Plus, Table2 } from "lucide-react";
import { api, DbKind } from "./api";
import { buildCreateTable, isMysqlFamily, NewColumn, TYPE_PRESETS } from "./sql";
import { toast } from "./ui";
import { Modal, Button } from "./ui/index";
import Icon from "./ui/Icon";

const emptyCol = (): NewColumn => ({
  name: "",
  type: "",
  notNull: false,
  pk: false,
  unique: false,
  default: "",
});

// 設計表結構（致敬 Navicat / DataGrip 的表設計器）：以欄位格組出 CREATE TABLE 並執行。
export default function CreateTableDialog({ connId, database, kind, onClose, onCreated }: {
  connId: string;
  database: string;
  kind: DbKind;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const defaultIdType =
    kind === "postgres" ? "SERIAL"
      : isMysqlFamily(kind) ? "INT AUTO_INCREMENT"
      : kind === "oracle" ? "NUMBER GENERATED AS IDENTITY" // 12c+
      : "INTEGER";
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

  // 重複欄名（不分大小寫，對齊多數資料庫）——提前在前端攔，免得送出後才收到 DB 錯誤。
  const dupCol = (() => {
    const seen = new Set<string>();
    for (const c of columns) {
      const n = c.name.trim().toLowerCase();
      if (!n) continue;
      if (seen.has(n)) return c.name.trim();
      seen.add(n);
    }
    return null;
  })();
  const valid = !!table.trim() && columns.some((c) => c.name.trim() && c.type.trim()) && !dupCol;
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
    <Modal
      onClose={onClose}
      title={<span className="flex items-center gap-2">設計表結構<span className="text-xs text-fg/40 mono">{database}</span></span>}
      icon={Table2}
      size="xl"
      zClass="z-[95]"
      className="!w-[860px]"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button variant="primary" loading={busy} disabled={busy || !valid} onClick={create}>建立資料表</Button>
      </>}
    >
          <label className="block">
            <span className="text-xs text-fg/50 mb-1 block">資料表名稱</span>
            <input autoFocus className={inputCls} value={table} onChange={(e) => setTable(e.target.value)}
              placeholder="例：users" />
          </label>

          <datalist id="dbkit-type-presets">
            {presets.map((t) => <option key={t} value={t} />)}
          </datalist>

          <div className="border border-fg/10 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-inset text-fg/45 text-xs">
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
                  <tr key={i} className="border-t border-fg/5">
                    <td className="px-2 py-1">
                      <input className={cellCls} value={c.name} placeholder="欄名"
                        onChange={(e) => setCol(i, { name: e.target.value })} />
                    </td>
                    <td className="px-2 py-1">
                      <input className={cellCls} list="dbkit-type-presets" value={c.type} placeholder="型別"
                        onChange={(e) => setCol(i, { type: e.target.value })} />
                    </td>
                    <td className="text-center"><input type="checkbox" aria-label="Not Null（不可為空）" checked={c.notNull}
                      onChange={(e) => setCol(i, { notNull: e.target.checked })} /></td>
                    <td className="text-center"><input type="checkbox" aria-label="主鍵（Primary Key）" checked={c.pk}
                      onChange={(e) => setCol(i, { pk: e.target.checked, notNull: e.target.checked ? true : c.notNull })} /></td>
                    <td className="text-center"><input type="checkbox" aria-label="唯一（Unique）" checked={c.unique} disabled={c.pk}
                      onChange={(e) => setCol(i, { unique: e.target.checked })} /></td>
                    <td className="px-2 py-1">
                      <input className={cellCls} value={c.default} placeholder="（無）"
                        onChange={(e) => setCol(i, { default: e.target.value })} />
                    </td>
                    <td className="text-center">
                      <button type="button" title="刪除此欄" onClick={() => removeCol(i)}
                        className="px-1 text-fg/25 hover:text-red-400 disabled:opacity-20" disabled={columns.length <= 1}><Icon icon={Minus} size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={addCol}
              className="w-full px-2 py-1.5 text-xs text-fg/50 hover:bg-fg/5 border-t border-fg/10 inline-flex items-center justify-center gap-1"><Icon icon={Plus} size={13} /> 新增欄位</button>
          </div>

          {dupCol && (
            <div className="text-xs text-danger">欄名重複：「{dupCol}」——請改名後再建立。</div>
          )}

          <div>
            <span className="text-xs text-fg/40 mb-1 block">SQL 預覽</span>
            <pre className="bg-inset border border-fg/10 rounded p-3 text-xs mono text-fg/70 overflow-auto max-h-40 whitespace-pre-wrap">{previewSql}</pre>
          </div>
    </Modal>
  );
}

const inputCls = "w-full bg-inset border border-fg/10 rounded px-2 py-1.5 text-sm outline-none focus:border-accent";
const cellCls = "w-full bg-inset border border-fg/10 rounded px-1.5 py-1 text-sm mono outline-none focus:border-accent";
