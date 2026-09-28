// DBA 審查的共用小工具：人設 → 審查者（系統提示 + agent 參數）、預設人設、結構審查的上下文。
// 執行前審查（審查並執行）的審查者由後端 review_run_prepare 組好；編輯器 SQL 與資料表結構的
// 審查在前端組，規則一致：人設本文 + 預載技能是系統提示，資料庫工具指引由後端送出時補上。
import { api, KIND_META, type ColumnInfo, type DbKind, type ForeignKeyInfo, type IndexInfo } from "./api";
import { findEntry, libSettings, personaInfo, personas, personaSystemPrompt, renderTask } from "./aiLibrary";
import { fencedBlock, headerVars } from "./aiReview";
import { t } from "./i18n";
import type { DbaReviewer } from "./useDbaReview";

/** 後端 dbtools::TOOL_NAMES（人設沒限定工具時 = 全部）。 */
export const ALL_DB_TOOLS = ["list_databases", "list_tables", "describe_table", "sample_rows", "run_query", "explain_query"];

/** 依連線是否為正式環境挑預設 DBA 人設（與後端 AiLibrarySettings::dba_persona_for 同規則）。 */
export function defaultDbaPersona(prod: boolean): string {
  const s = libSettings();
  const pick = (prod ? s.dba_persona_prod || s.dba_persona : s.dba_persona)?.trim();
  if (pick && findEntry("agent", pick)) return pick;
  const fallback = prod ? "dba-prod-gatekeeper" : "dba-senior";
  return findEntry("agent", fallback) ? fallback : (personas("dba")[0]?.name ?? fallback);
}

/** 會審預設陣容（設定裡不存在的人設略過；一個都不剩就退回預設人設）。 */
export function panelPersonas(prod: boolean): string[] {
  const list = libSettings().panel_personas.filter((n) => !!findEntry("agent", n));
  return list.length ? list : [defaultDbaPersona(prod)];
}

export function reviewersFor(names: readonly string[]): DbaReviewer[] {
  return names
    .map((n) => findEntry("agent", n))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => {
      const info = personaInfo(e);
      return {
        persona: e.name,
        title: info.title,
        system: personaSystemPrompt(e.name),
        maxTurns: info.maxTurns,
        dbTools: info.dbTools ? (info.toolAllow ?? ALL_DB_TOOLS) : null,
      };
    });
}

// ---- 資料表結構審查（review-schema）的上下文 ----

function columnLine(c: ColumnInfo): string {
  const flags = [c.key === "PRI" ? "PK" : null, c.nullable ? null : "NOT NULL", c.default != null && c.default !== "" ? `DEFAULT ${c.default}` : null, c.extra?.trim() || null]
    .filter(Boolean)
    .join(", ");
  const comment = c.comment?.trim() ? ` — ${c.comment.trim()}` : "";
  return `- ${c.name} ${c.data_type}${flags ? `（${flags}）` : ""}${comment}`;
}

function indexLine(i: IndexInfo): string {
  return `- ${i.name}(${i.columns.join(", ")})${i.primary ? " PK" : i.unique ? " UNIQUE" : ""}`;
}

const MAX_DDL_CHARS = 12000;
const MAX_COLS = 200;

/**
 * 組結構審查的提示：DDL、欄位、索引、外鍵、表資訊各抓各的，任何一支失敗只讓那段留白
 * （範本會說明「無法取得」），不讓整個審查因為一個權限不足的查詢而開不起來。
 */
export async function buildSchemaReviewPrompt(opts: { connId: string; kind: DbKind; db: string; table: string; uiLang: string }): Promise<string> {
  const { connId, kind, db, table, uiLang } = opts;
  const [ddl, cols, idx, fks, info] = await Promise.all([
    api.tableDdl(connId, db, table).catch(() => ""),
    api.tableColumns(connId, db, table).catch(() => [] as ColumnInfo[]),
    api.tableIndexes(connId, db, table).catch(() => [] as IndexInfo[]),
    api.listForeignKeys(connId, db, table).catch(() => [] as ForeignKeyInfo[]),
    api.tableInfo(connId, db, table).catch(() => [] as [string, string][]),
  ]);
  const ddlText = (ddl ?? "").trim();
  return renderTask("review-schema", {
    ...headerVars(kind, db, uiLang),
    table: db ? `${db}.${table}` : table,
    ddl: ddlText ? fencedBlock("sql", ddlText.length > MAX_DDL_CHARS ? `${ddlText.slice(0, MAX_DDL_CHARS)}\n-- …` : ddlText) : "",
    columns: cols.slice(0, MAX_COLS).map(columnLine).join("\n") + (cols.length > MAX_COLS ? `\n${t("（另有 {n} 個欄位未列出）", { n: cols.length - MAX_COLS })}` : ""),
    indexes: idx.map(indexLine).join("\n"),
    foreign_keys: fks.slice(0, 60).map((f) => `- ${f.name ? `${f.name}: ` : ""}${f.column} → ${f.ref_table}(${f.ref_column})`).join("\n"),
    table_info: info.filter(([, v]) => v != null && v !== "").slice(0, 30).map(([k, v]) => `- ${k}: ${v}`).join("\n"),
  });
}

export function kindLabel(kind: DbKind | null | undefined): string {
  return kind ? KIND_META[kind].label : "SQL";
}
