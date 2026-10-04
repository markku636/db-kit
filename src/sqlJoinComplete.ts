import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { ErRelation } from "./api";
import { schemaTableMap, statementTables, stripNoise } from "./sqlContextComplete";
import { t } from "./i18n";

// JOIN 條件補全：游標停在 `JOIN 新表 [別名] ON ` 之後時，依外鍵提示 `新別名.fk = 舊別名.pk`
// （新表與語句前面已出現的表之間，兩個方向的外鍵都算）。沒有對得上的外鍵時，退而用欄名推測：
// 兩邊都有同名的 *_id 欄、或「舊表.id ↔ 新表.<舊表單數>_id」，並標明是推測。

const JOIN_ON = /\bjoin\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$]+)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$]+))*)(?:\s+(?:as\s+)?([\w$]+))?\s+on\s+([\w$]*)$/i;

export interface JoinSuggestion {
  text: string;
  /** fk = 外鍵；guess = 依欄名推測。 */
  source: "fk" | "guess";
}

const bareName = (s: string) => s.split(".").pop()!.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase();
const singular = (s: string) => s.replace(/ies$/i, "y").replace(/(ses|xes)$/i, (m) => m.slice(0, -2)).replace(/s$/i, "");

/**
 * @param before 目前語句從開頭到游標（已去字串 / 註解）
 */
export function joinSuggestions(before: string, relations: ErRelation[], schema?: SQLNamespace): JoinSuggestion[] | null {
  const m = JOIN_ON.exec(before);
  if (!m) return null;
  const newTable = bareName(m[1]);
  const newAlias = m[2] && !/^on$/i.test(m[2]) ? m[2] : m[1].split(".").pop()!.replace(/^[`"[]|[`"\]]$/g, "");
  const prev = statementTables(before.slice(0, m.index)).map((r) => ({ table: bareName(r.table), ref: r.alias ?? r.table.split(".").pop()! }));
  if (prev.length === 0) return [];
  const out: JoinSuggestion[] = [];
  const seen = new Set<string>();
  const add = (text: string, source: JoinSuggestion["source"]) => {
    if (!seen.has(text.toLowerCase())) { seen.add(text.toLowerCase()); out.push({ text, source }); }
  };
  for (const p of prev) {
    for (const r of relations) {
      const from = r.from_table.toLowerCase();
      const to = r.to_table.toLowerCase();
      if (from === newTable && to === p.table) add(`${newAlias}.${r.from_column} = ${p.ref}.${r.to_column}`, "fk");
      else if (to === newTable && from === p.table) add(`${newAlias}.${r.to_column} = ${p.ref}.${r.from_column}`, "fk");
    }
  }
  if (out.length > 0 || !schema) return out;
  // 推測：沒有外鍵定義（MyISAM、刻意不建 FK 的庫）時依欄名。
  const map = schemaTableMap(schema);
  const colsOf = (tbl: string) => map.get(tbl)?.columns ?? [];
  const newCols = colsOf(newTable);
  for (const p of prev) {
    const prevCols = colsOf(p.table);
    for (const c of newCols) {
      if (/_id$/i.test(c) && prevCols.some((x) => x.toLowerCase() === c.toLowerCase())) add(`${newAlias}.${c} = ${p.ref}.${c}`, "guess");
    }
    const fkToPrev = `${singular(p.table)}_id`;
    if (prevCols.some((x) => x.toLowerCase() === "id")) {
      const c = newCols.find((x) => x.toLowerCase() === fkToPrev);
      if (c) add(`${newAlias}.${c} = ${p.ref}.id`, "guess");
    }
    const fkToNew = `${singular(newTable)}_id`;
    if (newCols.some((x) => x.toLowerCase() === "id")) {
      const c = prevCols.find((x) => x.toLowerCase() === fkToNew);
      if (c) add(`${newAlias}.id = ${p.ref}.${c}`, "guess");
    }
  }
  return out;
}

/** CodeMirror 補全來源。loadRelations 由呼叫端快取（每個連線 + 庫只抓一次）。 */
export function joinOnCompletion(loadRelations: () => Promise<ErRelation[]>, schema?: SQLNamespace): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const doc = ctx.state.doc.toString();
    const stmtStart = doc.lastIndexOf(";", ctx.pos - 1) + 1;
    const { text } = stripNoise(doc.slice(stmtStart, ctx.pos));
    if (!/\bon\s+[\w$]*$/i.test(text)) return null;
    let relations: ErRelation[] = [];
    try { relations = await loadRelations(); } catch { /* 沒有 FK 資訊就只用推測 */ }
    const sugg = joinSuggestions(text, relations, schema);
    if (!sugg || sugg.length === 0) return null;
    const word = /[\w$]*$/.exec(text)![0];
    return {
      from: ctx.pos - word.length,
      options: sugg.map((s, i) => ({
        label: s.text,
        type: "keyword",
        detail: s.source === "fk" ? t("外鍵") : t("依欄名推測"),
        boost: 99 - i,
      })),
      filter: false,
    };
  };
}
