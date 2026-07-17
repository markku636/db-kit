// 自然語言 → 查詢語句的 prompt 組裝與輸出截取（NL→SQL / NL→ES DSL）。
// 純函式 + 少量 async schema 抓取，供 NlQueryBar 使用；核心邏輯以 nlPrompt.test.ts 覆蓋。
import { api, KIND_META, type DbKind, type TableInfo } from "./api";
import { fuzzyScore } from "./fuzzy";

// ---- 輸出截取 ----

/**
 * 從（可能含說明文字的）回覆中截取第一個符合語言的 fenced code block。
 * - 優先取標註為 langs 之一的區塊；否則取第一個無語言標註的區塊。
 * - 找不到 code block 時回 null（呼叫端可再走 SQL_LEAD fallback）。
 */
export function extractFirstCodeBlock(text: string, langs: string[]): string | null {
  const re = /```([\w+-]*)\r?\n([\s\S]*?)```/g;
  let firstUnlabeled: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lang = m[1].toLowerCase();
    const code = m[2].replace(/\s+$/, "");
    if (langs.includes(lang)) return code;
    if (lang === "" && firstUnlabeled === null) firstUnlabeled = code;
  }
  return firstUnlabeled;
}

// ---- 表挑選 ----

/**
 * 依自然語言挑最相關的資料表（給模型注入完整欄位的候選）。
 * 規則：表名逐字出現在 NL 中 → 高分；否則 fuzzy 子序列評分；selectedTable 必入選並置頂。
 * 回傳表名清單（至多 limit 個），供後續抓欄位。
 */
export function rankTables(nl: string, tables: string[], selectedTable: string | null, limit = 8): string[] {
  const q = nl.toLowerCase();
  const scored = tables.map((name) => {
    const lower = name.toLowerCase();
    let score = q.includes(lower) ? 1000 - lower.length : (fuzzyScore(lower, q) ?? -Infinity);
    if (selectedTable && name === selectedTable) score = Infinity;
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter((s) => s.score > -Infinity).slice(0, limit).map((s) => s.name);
  // selectedTable 一定在（即使 fuzzy 全落空）。
  if (selectedTable && !picked.includes(selectedTable) && tables.includes(selectedTable)) {
    picked.unshift(selectedTable);
    if (picked.length > limit) picked.pop();
  }
  return picked;
}

// ---- 上限 ----
const MAX_TABLES_LISTED = 200;
const MAX_DETAIL_TABLES = 8;
const MAX_COLS_PER_TABLE = 80;
const MAX_SCHEMA_CHARS = 8000;
const MAX_MAPPING_CHARS = 6000;

// en 語系時要求 SQL 註解用英文（沿 buildContext 慣例）。
function commentLangLine(uiLang: string): string {
  return uiLang.startsWith("en") ? "\nWrite any SQL comments in English." : "";
}

export interface SqlPromptOpts {
  connId: string;
  kind: DbKind;
  db: string;
  nl: string;
  selectedTable: string | null;
  uiLang: string;
}

/**
 * NL → SQL：注入方言 + 全表名清單（保底）+ 最相關表的完整欄位。
 * 只輸出一個 ```sql 區塊。
 */
export async function buildSqlNlPrompt(opts: SqlPromptOpts): Promise<string> {
  const { connId, kind, db, nl, selectedTable, uiLang } = opts;
  const label = KIND_META[kind].label;

  let allTables: TableInfo[] = [];
  try {
    allTables = await api.listTables(connId, db);
  } catch {
    /* 抓不到表清單仍可生成（模型靠 NL 猜） */
  }
  const tableNames = allTables.map((t) => t.name);
  const listed = tableNames.slice(0, MAX_TABLES_LISTED).join(", ").slice(0, 3000);

  // 挑最相關的表抓完整欄位（並行）。
  const picked = rankTables(nl, tableNames, selectedTable, MAX_DETAIL_TABLES);
  const detailed = await Promise.all(
    picked.map(async (table) => {
      try {
        const cols = await api.tableColumns(connId, db, table);
        const body = cols
          .slice(0, MAX_COLS_PER_TABLE)
          .map((c) => `${c.name} ${c.data_type}${c.key === "PRI" ? " PK" : ""}${c.nullable ? "" : " NOT NULL"}`)
          .join(", ");
        return `- ${table}: ${body}`;
      } catch {
        return null;
      }
    }),
  );
  const schema = detailed.filter(Boolean).join("\n").slice(0, MAX_SCHEMA_CHARS);

  return [
    `你是 SQL 產生器。只輸出一個 \`\`\`sql 程式碼區塊，區塊外不得有任何文字；`,
    `需要說明或標註假設時，用 SQL 註解（--）寫在語句上方。`,
    `規則：方言為 ${label}；優先使用下方結構中存在的表與欄位；`,
    `SELECT 無明確筆數需求時加 LIMIT 200；除非使用者明確要求，不產生 DDL。${commentLangLine(uiLang)}`,
    ``,
    `【資料庫環境】`,
    `類型：${label}`,
    `資料庫：${db || "(預設)"}`,
    `全部資料表（${tableNames.length} 張）：${listed || "(無法取得，請依需求推斷)"}`,
    ``,
    `【最相關資料表結構】`,
    schema || "(無法取得欄位，請依表名與需求推斷)",
    ``,
    `【使用者需求】`,
    nl,
  ].join("\n");
}

export interface EsPromptOpts {
  connId: string;
  nl: string;
  /** 目標 index（側欄選中的 index 或使用者於編輯器指定的）。 */
  targetIndex: string | null;
  uiLang: string;
}

/**
 * NL → Elasticsearch Query DSL：注入 index 清單 + 目標 index 的 raw mapping。
 * 只輸出一個 ```json 區塊，格式須為查詢 envelope（頂層含 "index"）。
 */
export async function buildEsNlPrompt(opts: EsPromptOpts): Promise<string> {
  const { connId, nl, targetIndex, uiLang } = opts;

  let indices: string[] = [];
  try {
    indices = (await api.esIndices(connId)).map((i) => i.index);
  } catch {
    /* 抓不到 index 清單仍可生成 */
  }
  const listed = indices.slice(0, MAX_TABLES_LISTED).join(", ").slice(0, 3000);

  let mapping = "";
  const idx = targetIndex ?? indices[0] ?? null;
  if (idx) {
    try {
      mapping = (await api.esMapping(connId, idx)).slice(0, MAX_MAPPING_CHARS);
    } catch {
      /* mapping 不可得則省略，模型靠 index 名與 NL 推斷 */
    }
  }

  return [
    `你是 Elasticsearch Query DSL 產生器。只輸出一個 \`\`\`json 程式碼區塊，區塊外不得有任何文字。`,
    `輸出格式（查詢 envelope）：頂層必含 "index"（字串，可萬用字元），其餘鍵為 _search 的 body`,
    `（query / aggs / size / from / sort / _source 等）。純計數用 { "index":"..", "count":true, "query":{...} }。`,
    `規則：日期範圍用 range + ISO8601；聚合放 aggs 且以「單層」為限（勿巢狀）；未指定筆數時 size 用 200。${commentLangLine(uiLang)}`,
    ``,
    `【叢集環境】`,
    `全部索引（${indices.length} 個）：${listed || "(無法取得，請依需求推斷)"}`,
    idx ? `目標索引：${idx}` : `目標索引：(未指定，請於 "index" 填入最合適者)`,
    ``,
    `【目標索引 mapping】`,
    mapping || "(無法取得 mapping，請依索引名與需求推斷欄位)",
    ``,
    `【使用者需求】`,
    nl,
  ].join("\n");
}
