import { useState } from "react";
import { api, ImportResult } from "./api";
import { pickOpenFile, toast } from "./ui";

// CSV 匯入對話框（致敬 Navicat / DBeaver 匯入精靈）。逐列以 insert_row 寫入目標表。
export default function ImportDialog({ connId, database, table, onDone, onClose }: {
  connId: string;
  database: string;
  table: string;
  onDone?: () => void;
  onClose: () => void;
}) {
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [stopOnError, setStopOnError] = useState(false);
  const [columns, setColumns] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = async () => {
    if (busy) return; // 防重入：開檔對話框期間避免重複觸發
    const cols = hasHeader ? null : columns.split(",").map((c) => c.trim()).filter(Boolean);
    if (!hasHeader && (!cols || cols.length === 0)) {
      toast.error("無表頭時請先填欄名（逗號分隔）");
      return;
    }
    const path = await pickOpenFile([{ name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] }]);
    if (!path) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await api.importCsv(connId, database, table, path, {
        delimiter,
        has_header: hasHeader,
        empty_as_null: emptyAsNull,
        columns: cols,
        stop_on_error: stopOnError,
      });
      setResult(res);
      if (res.failed === 0) {
        toast.success(`已匯入 ${res.imported} 列`);
      } else {
        toast.error(`匯入 ${res.imported} 列、失敗 ${res.failed} 列`);
      }
      onDone?.(); // 重新整理資料格以顯示已匯入的列
    } catch (e: any) {
      toast.error(e?.message ?? "匯入失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#1a212b] w-[460px] rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 font-medium text-sm">
          匯入 CSV · <span className="mono text-white/60">{table}</span>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/50">分隔字元</span>
            <div className="flex gap-2">
              {[[",", "逗號 ,"], ["\t", "Tab"], [";", "分號 ;"]].map(([v, label]) => (
                <button key={label} type="button" onClick={() => setDelimiter(v)}
                  className={`px-2.5 py-1 rounded text-sm border ${
                    delimiter === v ? "border-blue-500 bg-blue-500/15 text-blue-300" : "border-white/10 text-white/50"
                  }`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
            第一列為欄名
          </label>
          {!hasHeader && (
            <label className="block">
              <span className="text-xs text-white/50 mb-1 block">欄名（逗號分隔，依 CSV 欄序對應）</span>
              <input className={inputCls} value={columns} onChange={(e) => setColumns(e.target.value)}
                placeholder="id, name, qty" />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} />
            空欄位視為 NULL（建議開：避免空字串塞進數值 / 日期欄而失敗）
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} />
            遇錯即停（取消＝盡量匯入，回報失敗列與錯誤）
          </label>

          {result && (
            <div className="mt-1 text-sm rounded border border-white/10 bg-black/20 p-3 space-y-1">
              <div>
                匯入 <span className="text-emerald-400">{result.imported}</span> 列
                {result.failed > 0 && <> · 失敗 <span className="text-red-400">{result.failed}</span> 列</>}
              </div>
              {result.errors.length > 0 && (
                <ul className="text-xs text-red-300/80 mono max-h-32 overflow-auto list-disc pl-4">
                  {result.errors.map((er, i) => <li key={i}>{er}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">
            {result ? "關閉" : "取消"}
          </button>
          <button type="button" onClick={run} disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50">
            {busy ? "匯入中…" : "選擇檔案並匯入"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500";
