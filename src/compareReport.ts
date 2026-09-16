// 比對報告產生（Markdown / HTML / JSON）。純函式，鏡射 dataDict.ts 的做法，可單元測試。
import type { SchemaDiff, SyncStatement, TableDiff } from "./api";
import type { CompareRow } from "./compareModel";
import { summarizeRows } from "./compareModel";
import { htmlLangAttr, t, useLang } from "./i18n";

export interface CompareReport {
  source: string;
  target: string;
  generatedAt: number;
  rows: CompareRow[];
  schema: SchemaDiff | null;
  statements: SyncStatement[];
  skipped: string[];
  /** AI 產生的風險 / 執行建議總結（未產生則為 null）。 */
  aiSummary?: string | null;
}

const mdCell = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export const STATUS_LABEL: Record<CompareRow["status"], () => string> = {
  identical: () => t("相同"),
  differs: () => t("有差異"),
  source_only: () => t("僅來源有"),
  target_only: () => t("僅目標有"),
  pending: () => t("未比對"),
  running: () => t("進行中"),
};

/** 一張表的結構差異攤成 (類別, 物件, 變更, 來源, 目標) 列。 */
export function flattenTableDiff(td: TableDiff): { kind: string; object: string; change: string; source: string; target: string }[] {
  const out: { kind: string; object: string; change: string; source: string; target: string }[] = [];
  const colSpec = (c: { data_type: string; nullable: boolean; default: string | null; extra: string; comment?: string | null }) =>
    `${c.data_type}${c.nullable ? "" : " NOT NULL"}${c.default != null && c.default !== "" ? ` DEFAULT ${c.default}` : ""}${c.extra ? ` ${c.extra}` : ""}`;
  for (const c of td.columns_added) out.push({ kind: t("欄位"), object: c.name, change: t("新增"), source: colSpec(c), target: "" });
  for (const c of td.columns_removed) out.push({ kind: t("欄位"), object: c.name, change: t("刪除"), source: "", target: colSpec(c) });
  for (const c of td.columns_changed) out.push({ kind: t("欄位"), object: c.name, change: `${t("變更")}（${c.attrs.join(", ")}）`, source: colSpec(c.src), target: colSpec(c.dst) });
  const idx = (i: { columns: string[]; unique: boolean; primary: boolean }) => `${i.primary ? "PK " : i.unique ? "UNIQUE " : ""}(${i.columns.join(", ")})`;
  for (const i of td.indexes_added) out.push({ kind: t("索引"), object: i.name, change: t("新增"), source: idx(i), target: "" });
  for (const i of td.indexes_removed) out.push({ kind: t("索引"), object: i.name, change: t("刪除"), source: "", target: idx(i) });
  for (const i of td.indexes_changed) out.push({ kind: t("索引"), object: i.name, change: i.renamed ? t("改名") : t("變更"), source: `${i.src.name} ${idx(i.src)}`, target: `${i.dst.name} ${idx(i.dst)}` });
  const fk = (f: { columns: string[]; ref_table: string; ref_columns: string[] }) => `(${f.columns.join(", ")}) → ${f.ref_table}(${f.ref_columns.join(", ")})`;
  for (const f of td.fks_added) out.push({ kind: t("外鍵"), object: f.name, change: t("新增"), source: fk(f), target: "" });
  for (const f of td.fks_removed) out.push({ kind: t("外鍵"), object: f.name, change: t("刪除"), source: "", target: fk(f) });
  for (const f of td.fks_changed) out.push({ kind: t("外鍵"), object: f.name, change: f.renamed ? t("改名") : t("變更"), source: `${f.src.name} ${fk(f.src)}`, target: `${f.dst.name} ${fk(f.dst)}` });
  if (td.ddl_differs && out.length === 0) out.push({ kind: t("DDL"), object: td.name, change: t("僅 DDL 文字不同（charset / engine 等）"), source: "", target: "" });
  return out;
}

export function buildCompareMarkdown(r: CompareReport): string {
  const out: string[] = [];
  out.push(t("# 比對報告：{source} → {target}", { source: r.source, target: r.target }), "");
  out.push(t("產生時間：{time}（UTC）", { time: fmtTime(r.generatedAt) }), "");
  const c = summarizeRows(r.rows);
  out.push(t("## 摘要"), "");
  out.push(t("| 狀態 | 數量 |"), "| --- | --- |");
  for (const k of ["identical", "differs", "source_only", "target_only"] as const) {
    if (c[k] > 0) out.push(`| ${STATUS_LABEL[k]()} | ${c[k]} |`);
  }
  out.push("");
  if (r.aiSummary) out.push(t("## AI 總結"), "", r.aiSummary.trim(), "");
  const listed = r.rows.filter((x) => x.status !== "identical" && x.status !== "pending");
  if (listed.length) {
    out.push(t("## 物件"), "");
    out.push(t("| 物件 | 類型 | 狀態 | 說明 |"), "| --- | --- | --- | --- |");
    for (const x of listed) {
      out.push(`| ${mdCell(x.name)} | ${x.objType} | ${STATUS_LABEL[x.status]()} | ${mdCell(x.detail)} |`);
    }
    out.push("");
  }
  if (r.schema) {
    for (const td of r.schema.tables_changed) {
      const rows = flattenTableDiff(td);
      if (!rows.length) continue;
      out.push(`### ${td.name}`, "");
      out.push(t("| 類別 | 物件 | 變更 | 來源 | 目標 |"), "| --- | --- | --- | --- | --- |");
      for (const x of rows) out.push(`| ${x.kind} | ${mdCell(x.object)} | ${mdCell(x.change)} | ${mdCell(x.source)} | ${mdCell(x.target)} |`);
      out.push("");
    }
    for (const v of [...r.schema.views_changed, ...r.schema.routines_changed]) {
      out.push(`### ${v.name}${v.routine_type ? ` (${v.routine_type})` : ""}`, "", t("**來源**"), "", "```sql", v.src ?? "", "```", "", t("**目標**"), "", "```sql", v.dst ?? "", "```", "");
    }
  }
  if (r.statements.length) {
    out.push(t("## 同步腳本（{n} 句，{d} 句為破壞性）", { n: r.statements.length, d: r.statements.filter((s) => s.destructive).length }), "", "```sql");
    for (const s of r.statements) {
      if (s.destructive) out.push("-- [destructive]");
      out.push(s.sql.replace(/;?\s*$/, ";"));
    }
    out.push("```", "");
  }
  if (r.skipped.length) {
    out.push(t("## 未能自動產生"), "");
    for (const s of r.skipped) out.push(`- ${s}`);
    out.push("");
  }
  return out.join("\n");
}

const STATUS_COLOR: Record<CompareRow["status"], string> = {
  identical: "#059669", differs: "#d97706", source_only: "#2563eb", target_only: "#dc2626",
  pending: "#9ca3af", running: "#9ca3af",
};

export function buildCompareHtml(r: CompareReport): string {
  const th = (xs: string[]) => `<tr>${xs.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>`;
  const tr = (xs: (string | number | null | undefined)[]) => `<tr>${xs.map((x) => `<td>${esc(x == null ? "" : String(x))}</td>`).join("")}</tr>`;
  const c = summarizeRows(r.rows);
  const summary = (["identical", "differs", "source_only", "target_only"] as const)
    .filter((k) => c[k] > 0)
    .map((k) => `<span class="pill" style="background:${STATUS_COLOR[k]}">${esc(STATUS_LABEL[k]())} ${c[k]}</span>`)
    .join(" ");
  const ai = r.aiSummary
    ? `<h2>${t("AI 總結")}</h2><div class="ai">${esc(r.aiSummary.trim()).replace(/\n/g, "<br>")}</div>`
    : "";
  const listed = r.rows.filter((x) => x.status !== "identical" && x.status !== "pending");
  const objects = listed.length
    ? `<h2>${t("物件")}</h2><table>${th([t("物件"), t("類型"), t("狀態"), t("說明")])}${listed.map((x) =>
      `<tr><td>${esc(x.name)}</td><td>${x.objType}</td><td style="color:${STATUS_COLOR[x.status]}">${esc(STATUS_LABEL[x.status]())}</td><td>${esc(x.detail)}</td></tr>`).join("")}</table>`
    : "";
  const tables = (r.schema?.tables_changed ?? []).map((td) => {
    const rows = flattenTableDiff(td);
    if (!rows.length) return "";
    return `<section><h3>${esc(td.name)}</h3><table>${th([t("類別"), t("物件"), t("變更"), t("來源"), t("目標")])}${rows.map((x) => tr([x.kind, x.object, x.change, x.source, x.target])).join("")}</table></section>`;
  }).join("");
  const texts = [...(r.schema?.views_changed ?? []), ...(r.schema?.routines_changed ?? [])].map((v) =>
    `<section><h3>${esc(v.name)}${v.routine_type ? ` (${esc(v.routine_type)})` : ""}</h3><div class="cols"><pre>${esc(v.src)}</pre><pre>${esc(v.dst)}</pre></div></section>`).join("");
  const script = r.statements.length
    ? `<h2>${t("同步腳本（{n} 句，{d} 句為破壞性）", { n: r.statements.length, d: r.statements.filter((s) => s.destructive).length })}</h2><pre>${r.statements.map((s) => `${s.destructive ? "-- [destructive]\n" : ""}${esc(s.sql.replace(/;?\s*$/, ";"))}`).join("\n")}</pre>`
    : "";
  const skipped = r.skipped.length ? `<h2>${t("未能自動產生")}</h2><ul>${r.skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : "";
  const title = t("比對報告：{source} → {target}", { source: r.source, target: r.target });
  return `<!DOCTYPE html>
<html lang="${htmlLangAttr(useLang.getState().lang)}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2937; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; } h3 { font-size: 13px; margin-top: 14px; color: #6b7280; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 6px; }
  th, td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  .pill { display: inline-block; color: #fff; border-radius: 999px; padding: 2px 10px; font-size: 12px; margin-right: 6px; }
  pre { background: #f9fafb; border: 1px solid #e5e7eb; padding: 8px; font-size: 12px; overflow: auto; white-space: pre-wrap; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ai { background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 6px; padding: 10px 12px; font-size: 13px; line-height: 1.7; }
</style></head><body>
<h1>${esc(title)}</h1>
<p>${t("產生時間：{time}（UTC）", { time: fmtTime(r.generatedAt) })}</p>
<p>${summary}</p>
${ai}
${objects}
${tables}
${texts}
${script}
${skipped}
</body></html>`;
}

export function buildCompareJson(r: CompareReport): string {
  return JSON.stringify(
    {
      source: r.source,
      target: r.target,
      generated_at: new Date(r.generatedAt).toISOString(),
      summary: summarizeRows(r.rows),
      ai_summary: r.aiSummary ?? null,
      rows: r.rows.map((x) => ({ name: x.name, type: x.objType, status: x.status, detail: x.detail ?? null })),
      schema: r.schema,
      statements: r.statements,
      skipped: r.skipped,
    },
    null,
    2,
  );
}
