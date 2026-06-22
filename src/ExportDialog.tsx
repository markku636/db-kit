import { useState } from "react";
import { api, DataQuery, ExportFormat } from "./api";
import { pickSaveFile, toast } from "./ui";

const FORMATS: { v: ExportFormat; label: string; ext: string }[] = [
  { v: "csv", label: "CSV", ext: "csv" },
  { v: "tsv", label: "TSV", ext: "tsv" },
  { v: "json", label: "JSON", ext: "json" },
  { v: "sql", label: "SQL (INSERT)", ext: "sql" },
  { v: "markdown", label: "Markdown", ext: "md" },
];

export default function ExportDialog({ connId, database, table, query, onClose }: {
  connId: string;
  database: string;
  table: string;
  query: DataQuery;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [includeHeader, setIncludeHeader] = useState(true);
  const [allRows, setAllRows] = useState(true);
  const [bom, setBom] = useState(true);
  const [nullText, setNullText] = useState("");
  const [sqlTable, setSqlTable] = useState(table);
  const [busy, setBusy] = useState(false);

  const meta = FORMATS.find((f) => f.v === format)!;
  const isCsv = format === "csv" || format === "tsv";

  const run = async () => {
    if (busy) return; // 防重入：另存對話框開啟期間 busy 仍為 false，避免重複觸發
    const out = await pickSaveFile(`${table}.${meta.ext}`, [{ name: meta.label, extensions: [meta.ext] }]);
    if (!out) return;
    setBusy(true);
    try {
      const res = await api.exportTable(connId, database, table, query, {
        format,
        include_header: includeHeader,
        all_rows: allRows,
        bom: isCsv ? bom : false,
        null_text: isCsv ? nullText : null,
        sql_table: format === "sql" ? sqlTable : null,
      }, out);
      toast.success(`已匯出 ${res.rows} 列（${formatBytes(res.bytes)}）→ ${res.path}`);
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "匯出失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#1a212b] w-[440px] rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 font-medium text-sm">
          匯出資料 · <span className="mono text-white/60">{table}</span>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <span className="text-xs text-white/50 mb-1 block">格式</span>
            <div className="flex gap-2 flex-wrap">
              {FORMATS.map((f) => (
                <button key={f.v} type="button" onClick={() => setFormat(f.v)}
                  className={`px-3 py-1 rounded text-sm border ${
                    format === f.v ? "border-blue-500 bg-blue-500/15 text-blue-300" : "border-white/10 text-white/50"
                  }`}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={allRows} onChange={(e) => setAllRows(e.target.checked)} />
            匯出全部符合的列（取消＝只匯出目前頁；含目前的篩選與排序）
          </label>

          {isCsv && (
            <>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={includeHeader} onChange={(e) => setIncludeHeader(e.target.checked)} />
                含欄位標題
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={bom} onChange={(e) => setBom(e.target.checked)} />
                加 UTF-8 BOM（方便 Excel 開啟）
              </label>
              <label className="block">
                <span className="text-xs text-white/50 mb-1 block">NULL 顯示為</span>
                <input className={inputCls} value={nullText} onChange={(e) => setNullText(e.target.value)}
                  placeholder="（空白）" />
              </label>
            </>
          )}

          {format === "sql" && (
            <label className="block">
              <span className="text-xs text-white/50 mb-1 block">INSERT 目標表名</span>
              <input className={inputCls} value={sqlTable} onChange={(e) => setSqlTable(e.target.value)} />
            </label>
          )}
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">取消</button>
          <button type="button" onClick={run} disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50">
            {busy ? "匯出中…" : "選擇位置並匯出"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
