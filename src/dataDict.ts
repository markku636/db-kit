// 整庫資料字典 / 文件產生（致敬 Navicat 的 HTML 文件 / 模型報表）。純函式，可單元測試。
import type { ColumnInfo, IndexInfo, ForeignKeyInfo } from "./api";
import { t, useLang } from "./i18n";

export interface TableDoc {
  name: string;
  cols: ColumnInfo[];
  idx: IndexInfo[];
  fks: ForeignKeyInfo[];
}

const yn = (b: boolean) => (b ? t("是") : t("否"));
const mdCell = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
// Markdown 標題 → GitHub 風錨點（小寫、空白轉 -、去除非字元）。
const anchor = (s: string) => s.toLowerCase().replace(/[^\w一-鿿]+/g, "-").replace(/^-+|-+$/g, "");

export function buildDbDictMarkdown(dbName: string, tables: TableDoc[]): string {
  const out: string[] = [];
  out.push(t("# 資料庫文件：{dbName}", { dbName }), "", t("共 {length} 張資料表。", { length: tables.length }), "");
  out.push(t("## 目錄"), "");
  for (const val of tables) out.push(t("- [{name}](#{v2})（{length} 欄）", { name: val.name, v2: anchor(val.name), length: val.cols.length }));
  out.push("");
  for (const val of tables) {
    out.push(`## ${val.name}`, "");
    out.push(t("| 欄位 | 型別 | 可空 | 鍵 | 預設 | 額外 | 註解 |"));
    out.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const c of val.cols) {
      out.push(`| ${mdCell(c.name)} | ${mdCell(c.data_type)} | ${yn(c.nullable)} | ${mdCell(c.key)} | ${mdCell(c.default)} | ${mdCell(c.extra)} | ${mdCell(c.comment)} |`);
    }
    if (val.idx.length) {
      out.push("", t("**索引**"), "");
      out.push(t("| 名稱 | 欄位 | 唯一 | 主鍵 |"), "| --- | --- | --- | --- |");
      for (const i of val.idx) out.push(`| ${mdCell(i.name)} | ${i.columns.join(", ")} | ${yn(i.unique)} | ${yn(i.primary)} |`);
    }
    if (val.fks.length) {
      out.push("", t("**外鍵**"), "");
      out.push(t("| 名稱 | 欄位 | 參照表 | 參照欄位 |"), "| --- | --- | --- | --- |");
      for (const f of val.fks) out.push(`| ${mdCell(f.name)} | ${mdCell(f.column)} | ${mdCell(f.ref_table)} | ${mdCell(f.ref_column)} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildDbDictHtml(dbName: string, tables: TableDoc[]): string {
  const th = (xs: string[]) => `<tr>${xs.map((x) => `<th>${x}</th>`).join("")}</tr>`;
  const tr = (xs: (string | null | undefined)[]) => `<tr>${xs.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`;
  const toc = tables.map((tbl) => `<li><a href="#${anchor(tbl.name)}">${esc(tbl.name)}</a>${t("（{length} 欄）", { length: tbl.cols.length })}</li>`).join("");
  const sections = tables.map((tbl) => {
    const colRows = tbl.cols.map((c) => tr([c.name, c.data_type, yn(c.nullable), c.key, c.default, c.extra, c.comment])).join("");
    const idxBlock = tbl.idx.length
      ? `<h3>${t("索引")}</h3><table>${th([t("名稱"), t("欄位"), t("唯一"), t("主鍵")])}${tbl.idx.map((i) => tr([i.name, i.columns.join(", "), yn(i.unique), yn(i.primary)])).join("")}</table>`
      : "";
    const fkBlock = tbl.fks.length
      ? `<h3>${t("外鍵")}</h3><table>${th([t("名稱"), t("欄位"), t("參照表"), t("參照欄位")])}${tbl.fks.map((f) => tr([f.name, f.column, f.ref_table, f.ref_column])).join("")}</table>`
      : "";
    return `<section><h2 id="${anchor(tbl.name)}">${esc(tbl.name)}</h2>` +
      `<table>${th([t("欄位"), t("型別"), t("可空"), t("鍵"), t("預設"), t("額外"), t("註解")])}${colRows}</table>${idxBlock}${fkBlock}</section>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="${useLang.getState().lang === "en" ? "en" : "zh-Hant"}"><head><meta charset="utf-8"><title>${t("資料庫文件：{dbName}", { dbName: esc(dbName) })}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2937; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; } h3 { font-size: 13px; margin-top: 14px; color: #6b7280; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 6px; }
  th, td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; }
  th { background: #f3f4f6; }
  nav ul { columns: 3; font-size: 13px; } a { color: #2563eb; text-decoration: none; }
</style></head><body>
<h1>${t("資料庫文件：{dbName}", { dbName: esc(dbName) })}</h1>
<p>${t("共 {length} 張資料表。", { length: tables.length })}</p>
<nav><ul>${toc}</ul></nav>
${sections}
</body></html>`;
}
