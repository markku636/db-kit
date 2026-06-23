import { useEffect, useState } from "react";
import { api, ColumnInfo, DbKind, IndexInfo } from "./api";

// 資料表 / 視圖 / 集合屬性：唯讀彙整欄位、索引與列數（沿用既有 API，免後端改動）。
export default function TableProperties({ connId, db, table, kind, objKind, onClose }: {
  connId: string;
  db: string;
  table: string;
  kind: DbKind;
  objKind: string; // "table" | "view"（Mongo 為集合）
  onClose: () => void;
}) {
  const [cols, setCols] = useState<ColumnInfo[] | null>(null);
  const [idx, setIdx] = useState<IndexInfo[] | null>(null);
  const [rows, setRows] = useState<number | null | "loading" | "error">("loading");

  const isMongo = kind === "mongo";
  const objLabel = isMongo ? "集合" : objKind === "view" ? "視圖" : "資料表";

  useEffect(() => {
    let alive = true;
    api.tableColumns(connId, db, table).then((c) => alive && setCols(c)).catch(() => alive && setCols([]));
    api.tableIndexes(connId, db, table).then((i) => alive && setIdx(i)).catch(() => alive && setIdx([]));
    // 列數：以分頁查詢的 total_rows 取得（後端原已為分頁計算）。大表 COUNT 可能較慢，獨立載入。
    api
      .tableData(connId, db, table, { page: 1, page_size: 1, filters: [], sorts: [] })
      .then((d) => alive && setRows(d.total_rows))
      .catch(() => alive && setRows("error"));
    return () => { alive = false; };
  }, [connId, db, table]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[560px] max-w-[94vw] max-h-[88vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm truncate">{table}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-white/50">{objLabel}</span>
          <span className="text-xs text-white/40 mono">{db}</span>
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-4 overflow-auto text-sm">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="列數" value={rows === "loading" ? "計算中…" : rows === "error" ? "—" : rows == null ? "—" : rows.toLocaleString()} />
            <Stat label={isMongo ? "欄位（取樣）" : "欄位數"} value={cols == null ? "…" : String(cols.length)} />
            <Stat label="索引數" value={idx == null ? "…" : String(idx.length)} />
          </div>

          <Section title={`欄位（${cols?.length ?? 0}）`}>
            {cols == null ? <Empty text="載入中…" /> : cols.length === 0 ? <Empty text="（無）" /> : (
              <table className="w-full text-xs">
                <thead className="text-white/40">
                  <tr><Th>欄名</Th><Th>型別</Th><Th>NULL</Th><Th>鍵</Th><Th>預設</Th></tr>
                </thead>
                <tbody>
                  {cols.map((c) => (
                    <tr key={c.name} className="border-t border-white/5">
                      <Td mono>{c.name}</Td>
                      <Td>{c.data_type}</Td>
                      <Td>{c.nullable ? "是" : "否"}</Td>
                      <Td>{c.key || "—"}</Td>
                      <Td mono>{c.default ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title={`索引（${idx?.length ?? 0}）`}>
            {idx == null ? <Empty text="載入中…" /> : idx.length === 0 ? <Empty text="（無）" /> : (
              <table className="w-full text-xs">
                <thead className="text-white/40">
                  <tr><Th>名稱</Th><Th>欄位</Th><Th>唯一</Th><Th>主鍵</Th></tr>
                </thead>
                <tbody>
                  {idx.map((ix) => (
                    <tr key={ix.name} className="border-t border-white/5">
                      <Td mono>{ix.name}</Td>
                      <Td mono>{ix.columns.join(", ")}</Td>
                      <Td>{ix.unique ? "是" : "否"}</Td>
                      <Td>{ix.primary ? "是" : "否"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">關閉</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-white/10 px-3 py-2">
      <div className="text-xs text-white/40">{label}</div>
      <div className="text-base mono text-white/90 mt-0.5">{value}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-white/45 uppercase tracking-wide mb-1.5">{title}</div>
      <div className="rounded border border-white/10 overflow-hidden">{children}</div>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="text-white/40 text-xs px-3 py-2">{text}</div>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-normal px-3 py-1.5">{children}</th>;
}
function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td className={`px-3 py-1 text-white/80 ${mono ? "mono" : ""}`}>{children}</td>;
}
