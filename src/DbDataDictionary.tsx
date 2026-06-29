import { useEffect, useState } from "react";
import { api, ColumnInfo, IndexInfo, ForeignKeyInfo } from "./api";
import { toast, copyToClipboard, pickSaveFile } from "./ui";
import { Modal, Button, Segmented } from "./ui/index";
import { BookText } from "lucide-react";
import { buildDbDictMarkdown, buildDbDictHtml, type TableDoc } from "./dataDict";

// 整庫資料字典 / 文件（致敬 Navicat 的 HTML 文件 / 模型報表）：彙整資料庫所有資料表的
// 欄位 / 索引 / 外鍵成一份含目錄的文件，可複製或另存 Markdown / HTML。
const MAX_TABLES = 200;

export default function DbDataDictionary({ connId, db, onClose }: {
  connId: string;
  db: string;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState<TableDoc[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"md" | "html">("md");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ts = (await api.listTables(connId, db)).filter((t) => t.kind === "table");
        if (cancelled) return;
        const target = ts.slice(0, MAX_TABLES);
        setTruncated(ts.length > MAX_TABLES);
        setProgress({ done: 0, total: target.length });
        const results: TableDoc[] = new Array(target.length);
        let idx = 0;
        let done = 0;
        // 限併發 6，個別表失敗不影響整體（缺索引 / 外鍵以空陣列代）。
        const worker = async () => {
          while (idx < target.length && !cancelled) {
            const myi = idx++;
            const t = target[myi];
            const [cols, ix, fks] = await Promise.all([
              api.tableColumns(connId, db, t.name).catch(() => [] as ColumnInfo[]),
              api.tableIndexes(connId, db, t.name).catch(() => [] as IndexInfo[]),
              api.listForeignKeys(connId, db, t.name).catch(() => [] as ForeignKeyInfo[]),
            ]);
            results[myi] = { name: t.name, cols, idx: ix, fks };
            done++;
            if (!cancelled) setProgress({ done, total: target.length });
          }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        if (!cancelled) setDocs(results.filter(Boolean));
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "讀取結構失敗");
      }
    })();
    return () => { cancelled = true; };
  }, [connId, db]);

  const content = docs ? (view === "md" ? buildDbDictMarkdown(db, docs) : buildDbDictHtml(db, docs)) : "";

  const save = async () => {
    const ext = view === "md" ? "md" : "html";
    const path = await pickSaveFile(`${db}-dictionary.${ext}`, [{ name: view === "md" ? "Markdown" : "HTML", extensions: [ext] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, content);
      toast.success(`已儲存資料庫文件（${docs?.length ?? 0} 張表）`);
    } catch (e: any) {
      toast.error(e?.message ?? "儲存失敗");
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={<>資料庫文件 · <span className="mono text-fg/60">{db}</span></>}
      icon={BookText}
      size="xl"
      className="h-[80vh]"
      bodyClassName="p-0 flex flex-col min-h-0"
      footer={<>
        <span className="mr-auto text-[11px] text-fg/40">
          {docs ? `${docs.length} 張表${truncated ? `（前 ${MAX_TABLES} 張）` : ""}` : progress ? `載入中 ${progress.done}/${progress.total}` : ""}
        </span>
        <Segmented ariaLabel="格式" value={view} onChange={(v) => setView(v as "md" | "html")}
          options={[{ value: "md", label: "Markdown" }, { value: "html", label: "HTML" }]} />
        <Button onClick={() => copyToClipboard(content)} disabled={!docs}>複製</Button>
        <Button variant="primary" onClick={save} disabled={!docs}>另存…</Button>
      </>}
    >
      {err ? (
        <div className="p-4 text-red-400 text-sm whitespace-pre-wrap break-words">{err}</div>
      ) : !docs ? (
        <div className="p-6 text-fg/50 text-sm">產生中…{progress ? ` ${progress.done}/${progress.total}` : ""}</div>
      ) : (
        <pre className="flex-1 overflow-auto p-4 text-xs mono text-fg/80 whitespace-pre-wrap break-words">{content}</pre>
      )}
    </Modal>
  );
}
