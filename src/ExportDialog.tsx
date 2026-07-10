import { useState } from "react";
import { Upload } from "lucide-react";
import { api, DataQuery, ExportFormat } from "./api";
import { pickSaveFile, toast } from "./ui";
import { Modal, Button, Input } from "./ui/index";
import { useT } from "./i18n";

const FORMATS: { v: ExportFormat; label: string; ext: string }[] = [
  { v: "csv", label: "CSV", ext: "csv" },
  { v: "tsv", label: "TSV", ext: "tsv" },
  { v: "xlsx", label: "Excel (.xlsx)", ext: "xlsx" },
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
  const t = useT();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [includeHeader, setIncludeHeader] = useState(true);
  const [allRows, setAllRows] = useState(true);
  const [bom, setBom] = useState(true);
  const [nullText, setNullText] = useState("");
  const [sqlTable, setSqlTable] = useState(table);
  const [busy, setBusy] = useState(false);

  const meta = FORMATS.find((f) => f.v === format)!;
  const isCsv = format === "csv" || format === "tsv";
  const isXlsx = format === "xlsx";
  // CSV/TSV 與 Excel 都用得到欄位標題；BOM / NULL 顯示僅文字格式適用。
  const showHeader = isCsv || isXlsx;

  const run = async () => {
    if (busy) return;
    setBusy(true); // 點擊即進入載入狀態（涵蓋原生另存對話框開啟期間），同時作為防重入鎖
    try {
      const out = await pickSaveFile(`${table}.${meta.ext}`, [{ name: meta.label, extensions: [meta.ext] }]);
      if (!out) return; // 取消：finally 會還原 busy
      const res = await api.exportTable(connId, database, table, query, {
        format,
        include_header: includeHeader,
        all_rows: allRows,
        bom: isCsv ? bom : false,
        null_text: isCsv ? nullText : null,
        sql_table: format === "sql" ? sqlTable : null,
      }, out);
      toast.success(t("已匯出 {rows} 列（{bytes}）→ {path}", { rows: res.rows, bytes: formatBytes(res.bytes), path: res.path }));
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("匯出失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={<>匯出資料 · <span className="mono text-fg/60">{table}</span></>}
      icon={Upload}
      size="sm"
      zClass="z-50"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
        <Button variant="primary" loading={busy} onClick={run} disabled={busy}>{t("選擇位置並匯出")}</Button>
      </>}
    >
      <div>
            <span className="text-xs text-fg/50 mb-1 block">{t("格式")}</span>
            <div className="flex gap-2 flex-wrap">
              {FORMATS.map((f) => (
                <button key={f.v} type="button" onClick={() => setFormat(f.v)}
                  className={`px-3 py-1 rounded text-sm border ${
                    format === f.v ? "border-accent bg-accent/15 text-accent" : "border-fg/10 text-fg/50"
                  }`}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={allRows} onChange={(e) => setAllRows(e.target.checked)} />
            {t("匯出全部符合的列（取消＝只匯出目前頁；含目前的篩選與排序）")}
          </label>

          {showHeader && (
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={includeHeader} onChange={(e) => setIncludeHeader(e.target.checked)} />
              {t("含欄位標題")}{isXlsx ? t("（首列粗體）") : ""}
            </label>
          )}

          {isCsv && (
            <>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={bom} onChange={(e) => setBom(e.target.checked)} />
                {t("加 UTF-8 BOM（方便 Excel 開啟）")}
              </label>
              <label className="block">
                <span className="text-xs text-fg/50 mb-1 block">{t("NULL 顯示為")}</span>
                <Input inputSize="md" value={nullText} onChange={(e) => setNullText(e.target.value)}
                  placeholder={t("（空白）")} />
              </label>
            </>
          )}

          {format === "sql" && (
            <label className="block">
              <span className="text-xs text-fg/50 mb-1 block">{t("INSERT 目標表名")}</span>
              <Input inputSize="md" value={sqlTable} onChange={(e) => setSqlTable(e.target.value)} />
            </label>
          )}
    </Modal>
  );
}


function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
