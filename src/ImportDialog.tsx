import { useEffect, useState } from "react";
import { api, ImportResult, ImportPreview } from "./api";
import { pickOpenFile, toast } from "./ui";
import { Modal, Button, Segmented, Input } from "./ui/index";
import { Download } from "lucide-react";

// CSV / Excel 匯入對話框（致敬 Navicat / DBeaver 匯入精靈）：選檔 → 預覽欄位 / 前幾列 → 逐列寫入。
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
  const [trim, setTrim] = useState(false);
  // 重新指定欄名（覆蓋檔案表頭）：把不一致的檔案欄名對齊到目標表欄位（致敬 Navicat 匯入欄位對應）。
  const [overrideNames, setOverrideNames] = useState(false);
  const [columns, setColumns] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  // 選定的檔案 + 預覽（檔案的自然欄名 / 前幾列）。
  const [filePath, setFilePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [targetCols, setTargetCols] = useState<string[]>([]);
  const isExcel = !!filePath && /\.(xlsx|xls)$/i.test(filePath);

  // 載入目標表欄位，供對照（避免欄位不符這個最常見的匯入錯誤）。
  useEffect(() => {
    api.tableColumns(connId, database, table)
      .then((cs) => setTargetCols(cs.map((c) => c.name)))
      .catch(() => setTargetCols([]));
  }, [connId, database, table]);

  const pickFile = async () => {
    const path = await pickOpenFile([
      { name: "CSV / TSV / Excel", extensions: ["csv", "tsv", "txt", "xlsx", "xls"] },
    ]);
    if (!path) return;
    setFilePath(path);
    setResult(null);
  };

  // 選檔 / 改分隔字元 / 表頭設定後重新預覽（顯示檔案自然欄名，不套用覆蓋名以便對照）。
  useEffect(() => {
    if (!filePath) { setPreview(null); return; }
    let alive = true;
    api.importPreview(filePath, { delimiter, has_header: hasHeader, columns: null })
      .then((pv) => { if (alive) setPreview(pv); })
      .catch((e: any) => { if (alive) { setPreview(null); toast.error(e?.message ?? "預覽失敗"); } });
    return () => { alive = false; };
  }, [filePath, delimiter, hasHeader]);

  const doImport = async () => {
    if (busy || !filePath) return;
    const useCols = !hasHeader || overrideNames;
    const cols = useCols ? columns.split(",").map((c) => c.trim()).filter(Boolean) : null;
    if (useCols && (!cols || cols.length === 0)) {
      toast.error(overrideNames ? "請先填要套用的欄名（逗號分隔）" : "無表頭時請先填欄名（逗號分隔）");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const opts = { delimiter, has_header: hasHeader, empty_as_null: emptyAsNull, columns: cols, stop_on_error: stopOnError, trim };
      const res = isExcel
        ? await api.importExcel(connId, database, table, filePath, opts)
        : await api.importCsv(connId, database, table, filePath, opts);
      setResult(res);
      if (res.failed === 0) toast.success(`已匯入 ${res.imported} 列${isExcel ? "（Excel）" : ""}`);
      else toast.error(`匯入 ${res.imported} 列、失敗 ${res.failed} 列`);
      onDone?.(); // 重新整理資料格以顯示已匯入的列
    } catch (e: any) {
      toast.error(e?.message ?? "匯入失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={<>匯入 CSV / Excel · <span className="mono text-fg/60">{table}</span></>}
      icon={Download}
      size="md"
      zClass="z-50"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{result ? "關閉" : "取消"}</Button>
        <Button variant="secondary" onClick={pickFile}>{filePath ? "重新選檔" : "選擇檔案…"}</Button>
        <Button variant="primary" loading={busy} onClick={doImport} disabled={busy || !filePath}>匯入</Button>
      </>}
    >
      {targetCols.length > 0 && (
        <div className="text-[11px] text-fg/45">目標欄位（{targetCols.length}）：<span className="mono">{targetCols.join(", ")}</span></div>
      )}
      {filePath && (
        <div className="text-xs text-fg/55 truncate" title={filePath}>
          檔案：<span className="mono">{filePath.split(/[\\/]/).pop()}</span>
          {preview && <span className="text-fg/40"> · 約 {preview.total_rows} 列資料 · {preview.columns.length} 欄</span>}
          {preview && !overrideNames && targetCols.length > 0 && preview.columns.length !== targetCols.length && (
            <span className="text-amber-400"> · 欄數與目標（{targetCols.length}）不同，可能需「重新指定欄名」</span>
          )}
        </div>
      )}
      {preview && preview.columns.length > 0 && (
        <div className="rounded border border-fg/10 overflow-auto max-h-44">
          <table className="text-[11px] border-collapse w-full">
            <thead>
              <tr className="text-left text-fg/40">
                {preview.columns.map((c, i) => <th key={i} className="px-2 py-1 font-medium border-b border-fg/10 whitespace-nowrap bg-app/40">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-fg/5">
                  {preview.columns.map((_, ci) => <td key={ci} className="px-2 py-0.5 mono text-fg/70 max-w-[160px] truncate" title={row[ci] ?? ""}>{row[ci] ?? ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3">
            <span className="text-xs text-fg/50">分隔字元</span>
            <Segmented
              ariaLabel="分隔字元"
              value={delimiter}
              onChange={setDelimiter}
              options={[
                { value: ",", label: "逗號 ," },
                { value: "\t", label: "Tab" },
                { value: ";", label: "分號 ;" },
              ]}
            />
            <span className="text-[11px] text-fg/35">Excel 忽略此項</span>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
            第一列為欄名
          </label>
          {hasHeader && (
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={overrideNames} onChange={(e) => setOverrideNames(e.target.checked)} />
              重新指定欄名（覆蓋檔案表頭，對齊到目標欄位）
            </label>
          )}
          {(!hasHeader || overrideNames) && (
            <label className="block">
              <span className="text-xs text-fg/50 mb-1 block">欄名（逗號分隔，依檔案欄序對應目標欄位）</span>
              <Input inputSize="md" value={columns} onChange={(e) => setColumns(e.target.value)}
                placeholder="id, name, qty" />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
            去除每格前後空白（資料清理）
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} />
            空欄位視為 NULL（建議開：避免空字串塞進數值 / 日期欄而失敗）
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} />
            遇錯即停（取消＝盡量匯入，回報失敗列與錯誤）
          </label>

          {result && (
            <div className="mt-1 text-sm rounded border border-fg/10 bg-inset p-3 space-y-1">
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
    </Modal>
  );
}

