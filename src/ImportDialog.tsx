import { useState } from "react";
import { api, ImportResult } from "./api";
import { pickOpenFile, toast } from "./ui";
import { Modal, Button, Segmented, Input } from "./ui/index";
import { Download } from "lucide-react";

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
  const [trim, setTrim] = useState(false);
  // 重新指定欄名（覆蓋檔案表頭）：把不一致的檔案欄名對齊到目標表欄位（致敬 Navicat 匯入欄位對應）。
  const [overrideNames, setOverrideNames] = useState(false);
  const [columns, setColumns] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = async () => {
    if (busy) return; // 防重入：開檔對話框期間避免重複觸發
    // 需要自訂欄名：無表頭，或勾選「重新指定欄名」覆蓋表頭。
    const useCols = !hasHeader || overrideNames;
    const cols = useCols ? columns.split(",").map((c) => c.trim()).filter(Boolean) : null;
    if (useCols && (!cols || cols.length === 0)) {
      toast.error(overrideNames ? "請先填要套用的欄名（逗號分隔）" : "無表頭時請先填欄名（逗號分隔）");
      return;
    }
    const path = await pickOpenFile([
      { name: "CSV / TSV / Excel", extensions: ["csv", "tsv", "txt", "xlsx", "xls"] },
    ]);
    if (!path) return;
    // 依副檔名選匯入器：xlsx/xls 走 Excel（忽略分隔字元），其餘走 CSV。
    const isExcel = /\.(xlsx|xls)$/i.test(path);
    setBusy(true);
    setResult(null);
    try {
      const opts = {
        delimiter,
        has_header: hasHeader,
        empty_as_null: emptyAsNull,
        columns: cols,
        stop_on_error: stopOnError,
        trim,
      };
      const res = isExcel
        ? await api.importExcel(connId, database, table, path, opts)
        : await api.importCsv(connId, database, table, path, opts);
      setResult(res);
      if (res.failed === 0) {
        toast.success(`已匯入 ${res.imported} 列${isExcel ? "（Excel）" : ""}`);
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
    <Modal
      onClose={onClose}
      title={<>匯入 CSV / Excel · <span className="mono text-fg/60">{table}</span></>}
      icon={Download}
      size="sm"
      zClass="z-50"
      className="!w-[460px]"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{result ? "關閉" : "取消"}</Button>
        <Button variant="primary" loading={busy} onClick={run} disabled={busy}>選擇檔案並匯入</Button>
      </>}
    >
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

