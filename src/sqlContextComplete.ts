import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";

// 上下文感知的 SQL 欄位自動提示：解析當前語句的 FROM/JOIN 子句，
// 在 SELECT / WHERE / ON / ORDER BY… 等「欄位語境」直接提示該表欄位（免打 `表名.` 前綴），
// 並在打完子句關鍵字（含空白）當下自動跳窗 —— 補 @codemirror/lang-sql 預設 schema 補全
// 「空前綴不觸發、頂層不出欄位」的空缺。純文件掃描、不打後端。

// 可帶引號的識別字：`t`、"t"、[t]、裸字；表參照可帶 db. 前綴（取末段）。
const IDENT = "(?:`[^`]+`|\"[^\"]+\"|\\[[^\\]]+\\]|[\\w$]+)";
const TABLE_REF = new RegExp("\\b(from|join|update|into)\\s+(" + IDENT + "(?:\\s*\\.\\s*" + IDENT + ")*)", "gi");
// FROM/UPDATE 清單的逗號接續（`FROM a x, b y` — 可夾別名）。別名限單一裸字，
// 後面必須緊跟逗號才算清單延續（WHERE / JOIN 等關鍵字不會誤吞）。
const LIST_CONT = new RegExp("^(?:[ \\t]+(?:as\\s+)?[\\w$]+)?\\s*,\\s*(" + IDENT + "(?:\\s*\\.\\s*" + IDENT + ")*)", "i");

// 字串 / 註解以等長空白替換（位移不變），避免其中的 from/where 誤導解析。
const NOISE = /'(?:[^'\\]|\\.)*'|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g;

const TABLE_KW = new Set(["from", "join", "update", "into", "use"]);
// 這些關鍵字後面不是表也不是欄（數字 / 常量 / 語法糖）→ 不提示。
const NONE_KW = new Set(["values", "limit", "offset", "call", "show", "describe", "explain"]);
// 子句分類掃描：游標前最後一個命中的關鍵字決定語境（TABLE_KW → 表、NONE_KW → 無、其餘 → 欄）。
const CLAUSE_RE = /\b(select|from|join|update|into|use|where|having|on|and|or|set|when|then|else|by|between|not|in|like|is|distinct|using|case|end|values|limit|offset|call|show|describe|explain)\b/gi;
// 自動跳窗時機（空前綴、非 Ctrl+Space）：欄語境關鍵字 + 至少一個空白之後…
const POP_KW = /\b(select|where|and|or|on|having|when|then|else|by|set|between|not|in|like|is|distinct|using)\s+$/i;
// …或逗號 / 左括號 / 比較運算子之後（空白可有可無）。一般識別字後不跳（打完欄名別彈窗）。
const POP_SYM = /(,|\(|=|<|>|<>|!=)\s*$/;
const POP_TABLE = /\b(from|join|update|into)\s+$/i;

export interface SqlContext {
  mode: "column" | "table";
  /** 語句中出現的表名（去引號、去 db. 前綴、依出現序去重）。 */
  tables: string[];
  /** 已輸入的字前綴與其在整份文件中的起點。 */
  word: string;
  wordFrom: number;
  /** 空前綴時是否應自動跳窗（剛打完子句關鍵字 / 逗號 / 運算子）。 */
  autoPop: boolean;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === "`" && b === "`") || (a === '"' && b === '"') || (a === "[" && b === "]")) return s.slice(1, -1);
  }
  return s;
}

/**
 * 去除字串 / 註解（等長空白替換），並回傳被替換的區段（供「游標在其中則不提示」判斷）。
 * open=true 代表開放式區段（行註解直到換行前都算在內 → 端點含入）；字串 / 區塊註解有閉合符號，端點視為已離開。
 */
export function stripNoise(sql: string): { text: string; spans: Array<{ s: number; e: number; open: boolean }> } {
  const spans: Array<{ s: number; e: number; open: boolean }> = [];
  const text = sql.replace(NOISE, (m: string, ...args: unknown[]) => {
    const off = args[args.length - 2] as number;
    spans.push({ s: off, e: off + m.length, open: m.startsWith("--") || m.startsWith("#") });
    return " ".repeat(m.length);
  });
  return { text, spans };
}

/** 解析語句中 FROM/JOIN/UPDATE/INTO 參照的表名（含 FROM/UPDATE 清單的逗號接續）。 */
export function statementTables(stmt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (ref: string) => {
    const parts = ref.split(".");
    const name = unquote(parts[parts.length - 1].trim());
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  };
  TABLE_REF.lastIndex = 0;
  for (let m = TABLE_REF.exec(stmt); m; m = TABLE_REF.exec(stmt)) {
    push(m[2]);
    const kw = m[1].toLowerCase();
    if (kw === "from" || kw === "update") {
      let idx = TABLE_REF.lastIndex;
      for (;;) {
        const mm = LIST_CONT.exec(stmt.slice(idx));
        if (!mm) break;
        push(mm[1]);
        idx += mm[0].length;
      }
    }
  }
  return out;
}

/**
 * 分析文件 pos 處的補全語境。回傳 null 代表不由本 source 提示
 * （游標在字串 / 註解 / 未閉合引號內、`表名.` 限定名後、或非表非欄語境）。
 */
export function analyzeSqlContext(doc: string, pos: number): SqlContext | null {
  // 當前語句 = 游標前後最近分號之間（FROM 在游標後也解析得到）。
  const prevSemi = doc.lastIndexOf(";", pos - 1);
  let nextSemi = doc.indexOf(";", pos);
  if (nextSemi < 0) nextSemi = doc.length;
  const offset = prevSemi + 1;
  const { text: stmt, spans } = stripNoise(doc.slice(offset, nextSemi));
  const cur = pos - offset;
  for (const { s, e, open } of spans) if (cur > s && (cur < e || (open && cur <= e))) return null;
  const beforeAll = stmt.slice(0, cur);
  // 未閉合的字串 / 反引號識別字（NOISE 只吃成對引號，落單引號會殘留）。
  if (((beforeAll.match(/'/g) ?? []).length & 1) === 1) return null;
  if (((beforeAll.match(/`/g) ?? []).length & 1) === 1) return null;
  const word = /[\w$]*$/.exec(beforeAll)![0];
  const before = beforeAll.slice(0, beforeAll.length - word.length);
  // `表名.` 限定名 → 交給預設 schema source（避免重複項）。
  if (/\.\s*$/.test(before)) return null;

  let last: string | null = null;
  CLAUSE_RE.lastIndex = 0;
  for (let m = CLAUSE_RE.exec(before); m; m = CLAUSE_RE.exec(before)) last = m[1].toLowerCase();
  if (!last || NONE_KW.has(last)) return null;

  const tables = statementTables(stmt);
  const wordFrom = offset + cur - word.length;
  if (TABLE_KW.has(last)) {
    return {
      mode: "table",
      tables,
      word,
      wordFrom,
      autoPop: word === "" && (POP_TABLE.test(before) || /,\s*$/.test(before)),
    };
  }
  return {
    mode: "column",
    tables,
    word,
    wordFrom,
    autoPop: word === "" && (POP_KW.test(before) || POP_SYM.test(before)),
  };
}

interface TableEntry {
  name: string;
  columns: string[];
}

/** 把 SQLNamespace 攤平成「小寫表名 → 欄位」查找表（含 db.table 巢狀、self/children 形態）。 */
export function schemaTableMap(schema: SQLNamespace): Map<string, TableEntry> {
  const map = new Map<string, TableEntry>();
  const add = (name: string, cols: readonly (string | Completion)[]) => {
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, { name, columns: cols.map((c) => (typeof c === "string" ? c : c.label)) });
  };
  const visit = (ns: SQLNamespace) => {
    if (Array.isArray(ns)) return;
    for (const [key, val] of Object.entries(ns)) {
      if (Array.isArray(val)) add(key, val as readonly (string | Completion)[]);
      else if (val && typeof val === "object") {
        if ("self" in val && "children" in val) {
          const ch = (val as { children: SQLNamespace }).children;
          if (Array.isArray(ch)) add(key, ch as readonly (string | Completion)[]);
          else visit(ch);
        } else visit(val as SQLNamespace);
      }
    }
  };
  visit(schema);
  return map;
}

/**
 * 建立 CompletionSource。與預設 schema source 的分工：
 * - 欄語境：本 source 出「語句內各表的欄位」（預設 source 頂層不出欄位 → 無重複）。
 * - 表語境：只在「空前綴 + 剛打完 FROM/JOIN/逗號」自動跳表名補預設 source 的空缺；
 *   一開始打字或 Ctrl+Space 即回 null 讓預設 source 接手（避免重複項）。
 */
export function sqlContextCompletion(schema: SQLNamespace): CompletionSource {
  const tableMap = schemaTableMap(schema);
  const allTables: Completion[] = Array.from(tableMap.values(), (t) => ({
    label: t.name,
    type: "class",
    boost: 1,
  }));
  return (ctx: CompletionContext): CompletionResult | null => {
    const a = analyzeSqlContext(ctx.state.doc.toString(), ctx.pos);
    if (!a) return null;
    if (a.mode === "table") {
      if (ctx.explicit || a.word !== "" || !a.autoPop || allTables.length === 0) return null;
      return { from: ctx.pos, options: allTables };
    }
    const entries: TableEntry[] = [];
    for (const t of a.tables) {
      const e = tableMap.get(t.toLowerCase());
      if (e && e.columns.length > 0) entries.push(e);
    }
    if (entries.length === 0) return null;
    if (a.word === "" && !ctx.explicit && !a.autoPop) return null;
    const multi = entries.length > 1;
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const e of entries) {
      for (const col of e.columns) {
        const key = col.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ label: col, type: "property", boost: 1, ...(multi ? { detail: e.name } : {}) });
      }
    }
    if (options.length === 0) return null;
    return { from: a.wordFrom, options, validFor: /^[\w$]*$/ };
  };
}
