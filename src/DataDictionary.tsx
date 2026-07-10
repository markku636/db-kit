import { useEffect, useState } from "react";
import { api, ColumnInfo, IndexInfo, ForeignKeyInfo, DbKind } from "./api";
import { toast, copyToClipboard, pickSaveFile } from "./ui";
import { Modal, Button } from "./ui/index";
import { BookText } from "lucide-react";
import { useT, useLang } from "./i18n";

// 資料字典：彙整單一資料表的結構（欄位 / 索引 / 外鍵）成可閱讀文件，並可另存 Markdown / HTML。
// 對標 Navicat「資料字典」。後端的 table_columns / table_indexes / list_foreign_keys 皆已支援。
export default function DataDictionary({ connId, db, table, kind, onClose }: {
  connId: string;
  db: string;
  table: string;
  kind: DbKind;
  onClose: () => void;
}) {
  const t = useT();
  const [cols, setCols] = useState<ColumnInfo[]>([]);
  const [idx, setIdx] = useState<IndexInfo[]>([]);
  const [fks, setFks] = useState<ForeignKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    // 索引 / 外鍵對視圖或部分方言可能不適用：各自獨立 catch，缺一不致全失敗。
    Promise.all([
      api.tableColumns(connId, db, table),
      api.tableIndexes(connId, db, table).catch(() => [] as IndexInfo[]),
      api.listForeignKeys(connId, db, table).catch(() => [] as ForeignKeyInfo[]),
    ])
      .then(([c, i, f]) => {
        if (cancelled) return;
        setCols(c);
        setIdx(i);
        setFks(f);
      })
      .catch((e) => { if (!cancelled) setErr(e?.message ?? t("讀取結構失敗")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connId, db, table]);

  const title = kind === "sqlite" ? table : `${db}.${table}`;

  // ---- 文件產生 ----
  const yn = (b: boolean) => (b ? t("是") : t("否"));
  const md = () => {
    const lines: string[] = [];
    lines.push(t("# 資料字典：{title}", { title }), "");
    lines.push(t("## 欄位"), "");
    lines.push(t("| 欄位 | 型別 | 可空 | 鍵 | 預設 | 額外 | 註解 |"));
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const c of cols) {
      const cell = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${cell(c.name)} | ${cell(c.data_type)} | ${yn(c.nullable)} | ${cell(c.key)} | ${cell(c.default)} | ${cell(c.extra)} | ${cell(c.comment)} |`);
    }
    if (idx.length) {
      lines.push("", t("## 索引"), "");
      lines.push(t("| 名稱 | 欄位 | 唯一 | 主鍵 |"));
      lines.push("| --- | --- | --- | --- |");
      for (const i of idx) lines.push(`| ${i.name} | ${i.columns.join(", ")} | ${yn(i.unique)} | ${yn(i.primary)} |`);
    }
    if (fks.length) {
      lines.push("", t("## 外鍵"), "");
      lines.push(t("| 名稱 | 欄位 | 參照表 | 參照欄位 |"));
      lines.push("| --- | --- | --- | --- |");
      for (const f of fks) lines.push(`| ${f.name} | ${f.column} | ${f.ref_table} | ${f.ref_column} |`);
    }
    lines.push("");
    return lines.join("\n");
  };

  const esc = (s: string | null | undefined) =>
    (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = () => {
    const th = (xs: string[]) => `<tr>${xs.map((x) => `<th>${x}</th>`).join("")}</tr>`;
    const tr = (xs: (string | null | undefined)[]) => `<tr>${xs.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`;
    const colRows = cols
      .map((c) => tr([c.name, c.data_type, yn(c.nullable), c.key, c.default, c.extra, c.comment]))
      .join("\n");
    const idxBlock = idx.length
      ? `<h2>${t("索引")}</h2><table>${th([t("名稱"), t("欄位"), t("唯一"), t("主鍵")])}${idx.map((i) => tr([i.name, i.columns.join(", "), yn(i.unique), yn(i.primary)])).join("")}</table>`
      : "";
    const fkBlock = fks.length
      ? `<h2>${t("外鍵")}</h2><table>${th([t("名稱"), t("欄位"), t("參照表"), t("參照欄位")])}${fks.map((f) => tr([f.name, f.column, f.ref_table, f.ref_column])).join("")}</table>`
      : "";
    return `<!DOCTYPE html>
<html lang="${useLang.getState().lang === "en" ? "en" : "zh-Hant"}"><head><meta charset="utf-8"><title>${t("資料字典：{title}", { title: esc(title) })}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2937; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 6px; }
  th, td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; }
  th { background: #f3f4f6; }
</style></head><body>
<h1>${t("資料字典：{title}", { title: esc(title) })}</h1>
<h2>${t("欄位")}</h2>
<table>${th([t("欄位"), t("型別"), t("可空"), t("鍵"), t("預設"), t("額外"), t("註解")])}
${colRows}</table>
${idxBlock}
${fkBlock}
</body></html>`;
  };

  const saveAs = async (kindLabel: "md" | "html") => {
    const ext = kindLabel;
    const content = kindLabel === "md" ? md() : html();
    const path = await pickSaveFile(`${table}-dict.${ext}`, [{ name: kindLabel.toUpperCase(), extensions: [ext] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, content);
      toast.success(t("已另存 {toUpperCase}", { toUpperCase: kindLabel.toUpperCase() }));
    } catch (e: any) {
      toast.error(e?.message ?? t("另存失敗"));
    }
  };

  const cellCls = "border border-fg/10 px-2 py-1 text-left align-top";
  const headCls = "border border-fg/10 px-2 py-1 text-left bg-fg/5 font-medium";

  return (
    <Modal
      onClose={onClose}
      title={<span className="flex items-center gap-2"><span className="font-medium text-sm">{t("資料字典")}</span><span className="text-xs text-fg/40 mono">{title}</span></span>}
      icon={BookText}
      size="lg"
      zClass="z-[95]"
      className="!w-[820px] max-w-[94vw] h-[80vh]"
      bodyClassName="flex-1 overflow-auto p-5 text-xs"
      footer={<>
        <Button variant="secondary" onClick={() => copyToClipboard(md(), t("已複製 Markdown"))} disabled={loading || !!err}>{t("複製 Markdown")}</Button>
        <Button variant="secondary" onClick={() => saveAs("md")} disabled={loading || !!err}>{t("另存 Markdown")}</Button>
        <Button variant="primary" onClick={() => saveAs("html")} disabled={loading || !!err}>{t("另存 HTML")}</Button>
      </>}
    >
      {loading && <div className="text-fg/40">{t("讀取中…")}</div>}
          {err && <div className="text-red-400 mono">{err}</div>}
          {!loading && !err && (
            <>
              <div className="font-medium text-sm mb-1">{t("欄位（")}{cols.length}）</div>
              <table className="w-full mb-4">
                <thead><tr>{[t("欄位"), t("型別"), t("可空"), t("鍵"), t("預設"), t("額外"), t("註解")].map((h) => <th key={h} className={headCls}>{h}</th>)}</tr></thead>
                <tbody>
                  {cols.map((c) => (
                    <tr key={c.name}>
                      <td className={`${cellCls} mono`}>{c.name}</td>
                      <td className={`${cellCls} mono`}>{c.data_type}</td>
                      <td className={cellCls}>{yn(c.nullable)}</td>
                      <td className={cellCls}>{c.key}</td>
                      <td className={`${cellCls} mono`}>{c.default ?? ""}</td>
                      <td className={cellCls}>{c.extra}</td>
                      <td className={cellCls}>{c.comment ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {idx.length > 0 && (
                <>
                  <div className="font-medium text-sm mb-1">{t("索引（")}{idx.length}）</div>
                  <table className="w-full mb-4">
                    <thead><tr>{[t("名稱"), t("欄位"), t("唯一"), t("主鍵")].map((h) => <th key={h} className={headCls}>{h}</th>)}</tr></thead>
                    <tbody>
                      {idx.map((i) => (
                        <tr key={i.name}>
                          <td className={`${cellCls} mono`}>{i.name}</td>
                          <td className={`${cellCls} mono`}>{i.columns.join(", ")}</td>
                          <td className={cellCls}>{yn(i.unique)}</td>
                          <td className={cellCls}>{yn(i.primary)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {fks.length > 0 && (
                <>
                  <div className="font-medium text-sm mb-1">{t("外鍵（")}{fks.length}）</div>
                  <table className="w-full">
                    <thead><tr>{[t("名稱"), t("欄位"), t("參照表"), t("參照欄位")].map((h) => <th key={h} className={headCls}>{h}</th>)}</tr></thead>
                    <tbody>
                      {fks.map((f) => (
                        <tr key={f.name + f.column}>
                          <td className={`${cellCls} mono`}>{f.name}</td>
                          <td className={`${cellCls} mono`}>{f.column}</td>
                          <td className={`${cellCls} mono`}>{f.ref_table}</td>
                          <td className={`${cellCls} mono`}>{f.ref_column}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
    </Modal>
  );
}
