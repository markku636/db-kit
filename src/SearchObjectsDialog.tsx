import { useState } from "react";
import { api, DbKind, QueryResult } from "./api";
import { sqlLiteral } from "./sql";
import { useStore } from "./store";
import { useEscToClose } from "./ui";

// 跨資料庫 / schema 搜尋資料表與欄位（致敬 Navicat / DataGrip 的物件搜尋）。
// 以 information_schema + runQuery 實作；LIKE 樣式經 sqlLiteral 跳脫（防注入）。
function searchSql(kind: DbKind, pattern: string): string {
  const like = sqlLiteral(kind, `%${pattern}%`);
  if (kind === "postgres") {
    // 別名全部加雙引號：column / type 為保留字，未引號會語法錯誤。
    return (
      'SELECT table_schema AS "schema", table_name AS "table", column_name AS "column", data_type AS "type" ' +
      "FROM information_schema.columns " +
      "WHERE table_schema NOT IN ('pg_catalog','information_schema') " +
      `AND (table_name ILIKE ${like} OR column_name ILIKE ${like}) ` +
      "ORDER BY table_schema, table_name, ordinal_position LIMIT 300"
    );
  }
  // MySQL
  return (
    "SELECT TABLE_SCHEMA AS `schema`, TABLE_NAME AS `table`, COLUMN_NAME AS `column`, COLUMN_TYPE AS `type` " +
    "FROM information_schema.COLUMNS " +
    "WHERE TABLE_SCHEMA NOT IN ('mysql','sys','information_schema','performance_schema') " +
    `AND (TABLE_NAME LIKE ${like} OR COLUMN_NAME LIKE ${like}) ` +
    "ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT 300"
  );
}

export default function SearchObjectsDialog({ connId, kind, onClose }: {
  connId: string;
  kind: DbKind;
  onClose: () => void;
}) {
  useEscToClose(onClose);
  const [pattern, setPattern] = useState("");
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    const p = pattern.trim();
    if (!p || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.runQuery(connId, searchSql(kind, p)));
    } catch (e: any) {
      setErr(e?.message ?? "搜尋失敗");
    } finally {
      setBusy(false);
    }
  };

  // 雙擊結果 → 開啟該資料表（schema=第1欄、table=第2欄）。
  const openRow = (row: (string | null)[]) => {
    const schema = row[0];
    const table = row[1];
    if (schema && table) {
      useStore.getState().openTable(connId, schema, table);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[820px] max-w-[96vw] h-[78vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm">搜尋物件（資料表 / 欄位）</span>
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>
        <div className="px-5 py-3 border-b border-white/10 flex gap-2">
          <input autoFocus className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500"
            value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
            placeholder="輸入名稱片段（資料表或欄位），Enter 搜尋" />
          <button type="button" onClick={() => void search()} disabled={busy || !pattern.trim()}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40">{busy ? "搜尋中…" : "搜尋"}</button>
        </div>
        <div className="flex-1 overflow-auto">
          {err ? (
            <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
          ) : !res ? (
            <div className="text-white/40 text-sm p-5">輸入關鍵字搜尋資料表 / 欄位名稱（最多 300 筆）。</div>
          ) : res.rows.length === 0 ? (
            <div className="text-white/40 text-sm p-5">查無符合的物件。</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#10161e] text-white/45">
                <tr>{res.columns.map((c) => <th key={c} className="text-left px-3 py-1.5 font-normal">{c}</th>)}</tr>
              </thead>
              <tbody>
                {res.rows.map((row, i) => (
                  <tr key={i} onDoubleClick={() => openRow(row)} title="雙擊開啟資料表"
                    className="border-t border-white/5 hover:bg-white/5 cursor-pointer">
                    {row.map((v, j) => (
                      <td key={j} className="px-3 py-1 mono text-white/80">{v ?? <span className="text-white/30">NULL</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-5 py-2.5 border-t border-white/10 flex items-center">
          {res && <span className="text-xs text-white/40">{res.rows.length} 筆{res.rows.length >= 300 ? "（已達上限）" : ""}　·　雙擊列開啟資料表</span>}
          <button type="button" onClick={onClose} className="ml-auto px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">關閉</button>
        </div>
      </div>
    </div>
  );
}
