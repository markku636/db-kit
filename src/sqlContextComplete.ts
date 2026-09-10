import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { TableColumns } from "./api";

// 上下文感知的 SQL 欄位自動提示：解析當前語句的 FROM/JOIN 子句，
// 在 SELECT / WHERE / ON / ORDER BY… 等「欄位語境」直接提示該表欄位（免打 `表名.` 前綴），
// 並在打完子句關鍵字（含空白）當下自動跳窗 —— 補 @codemirror/lang-sql 預設 schema 補全
// 「空前綴不觸發、頂層不出欄位」的空缺。語境判斷純文件掃描；唯一會打後端的是跨庫的
// 按需載入（`其他庫.` 與 `FROM 其他庫.表`），且每個庫只載一次。

// 可帶引號的識別字：`t`、"t"、[t]、裸字；表參照可帶 db. 前綴（跨庫查詢會用到，故保留不丟）。
const IDENT = "(?:`[^`]+`|\"[^\"]+\"|\\[[^\\]]+\\]|[\\w$]+)";
const REF = IDENT + "(?:\\s*\\.\\s*" + IDENT + ")*";
const TABLE_REF = new RegExp("\\b(from|join|update|into)\\s+(" + REF + ")", "gi");
// FROM/UPDATE 清單的逗號接續（`FROM a x, b y`）。緊跟逗號才算清單延續（WHERE / JOIN 不會誤吞）。
const LIST_CONT = new RegExp("^\\s*,\\s*(" + REF + ")", "i");
// 表參照之後的別名：`t x` / `t AS x`。
const ALIAS_AFTER = /^[ \t]+(?:as[ \t]+)?([\w$]+)/i;
// 出現在「別名位置」但其實是接續子句的字——把它們當別名會讓 `FROM t WHERE` 認出一個叫 where 的別名。
const NOT_ALIAS = new Set([
  "as", "on", "using", "where", "group", "order", "having", "limit", "offset", "fetch",
  "join", "inner", "left", "right", "full", "outer", "cross", "natural", "straight_join",
  "union", "intersect", "except", "set", "values", "into", "select", "insert", "update",
  "delete", "for", "window", "partition", "with", "force", "use", "ignore", "lock", "and", "or",
]);
// 「限定名後打點」時取出限定字（`dbB.` → dbB）。前面不能再有一個點——`dbB.customers.` 是
// 兩段限定，那是內建 source 的守備範圍。
const QUALIFIER_END = new RegExp("(?:^|[^\\w$.])(" + IDENT + ")\\s*\\.\\s*$");

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

/** 語句中的一筆表參照（去引號）。db 為 null 代表沒寫限定名 → 目前資料庫。 */
export interface TableRef {
  db: string | null;
  table: string;
  alias: string | null;
}

export interface SqlContext {
  /**
   * - `column` / `table`：由本 source 提示欄位 / 表名
   * - `qualifier`：游標停在 `xxx.` 之後。本 source 只在 xxx 是「尚未載入結構的資料庫」時
   *   接手（按需載入），其餘一律讓給 lang-sql 內建 source——它已經會走巢狀命名空間，
   *   也會自己解析 `FROM db.t AS x` 的別名。
   */
  mode: "column" | "table" | "qualifier";
  /** 語句中出現的表參照（依出現序去重；保留 db 限定與別名）。 */
  tables: TableRef[];
  /** mode = "qualifier" 時，點號前的那一段（去引號）。 */
  qualifier?: string;
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

/** 表參照鍵：`db.table` 或裸 `table`（小寫）。同一份 key 規則也用於 schemaTableMap。 */
export function refKey(db: string | null, table: string): string {
  return (db ? `${db}.${table}` : table).toLowerCase();
}

/**
 * 把 `dbB.customers` / `dbB.sales.orders` 拆成 (db, table)。
 *
 * 三段式取後兩段當表名——後端的 list_tables 對非 dbo 的 SQL Server 物件本來就回
 * `schema.table`（見 mssql.rs），所以「前面是庫、後面整串是表」才對得起既有的表名慣例。
 */
function splitRef(ref: string): { db: string | null; table: string } {
  const parts = ref.split(".").map((p) => unquote(p.trim()));
  if (parts.length === 1) return { db: null, table: parts[0] };
  if (parts.length === 2) return { db: parts[0], table: parts[1] };
  return { db: parts[0], table: parts.slice(1).join(".") };
}

/**
 * 解析語句中 FROM/JOIN/UPDATE/INTO 參照的表（含 FROM/UPDATE 清單的逗號接續與別名）。
 *
 * db 限定**刻意保留**：`FROM dbB.orders` 與目前庫的 `orders` 是兩張不同的表，
 * 丟掉限定就會拿錯一張表的欄位去提示——跨庫 join 兩張同名表時尤其致命。
 */
export function statementTables(stmt: string): TableRef[] {
  const out: TableRef[] = [];
  const seen = new Set<string>();
  // 解析一筆參照與其後的別名，回傳掃描該吃掉到哪裡。
  const push = (ref: string, from: number): number => {
    const { db, table } = splitRef(ref);
    let next = from;
    let alias: string | null = null;
    const am = ALIAS_AFTER.exec(stmt.slice(from));
    if (am && !NOT_ALIAS.has(am[1].toLowerCase())) {
      alias = am[1];
      next = from + am[0].length;
    }
    const key = refKey(db, table);
    if (table && !seen.has(key)) {
      seen.add(key);
      out.push({ db, table, alias });
    }
    return next;
  };
  TABLE_REF.lastIndex = 0;
  for (let m = TABLE_REF.exec(stmt); m; m = TABLE_REF.exec(stmt)) {
    let idx = push(m[2], TABLE_REF.lastIndex);
    const kw = m[1].toLowerCase();
    if (kw === "from" || kw === "update") {
      for (;;) {
        const mm = LIST_CONT.exec(stmt.slice(idx));
        if (!mm) break;
        idx = push(mm[1], idx + mm[0].length);
      }
    }
    // 別名與清單接續已經吃掉的範圍不必再掃一次（也避免把別名當成新的表參照）。
    TABLE_REF.lastIndex = Math.max(TABLE_REF.lastIndex, idx);
  }
  return out;
}

/**
 * 分析文件 pos 處的補全語境。回傳 null 代表不由本 source 提示
 * （游標在字串 / 註解 / 未閉合引號內、或非表非欄語境）。
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
  const wordStart = offset + cur - word.length;
  // `xxx.` 限定名：本 source 只在 xxx 是「還沒載入結構的資料庫」時接手（見 sqlContextCompletion），
  // 其餘（表名、別名、多段限定）一律讓給預設 schema source，避免重複項。
  if (/\.\s*$/.test(before)) {
    const q = QUALIFIER_END.exec(before);
    if (!q) return null;
    return {
      mode: "qualifier",
      qualifier: unquote(q[1]),
      tables: statementTables(stmt),
      word,
      wordFrom: wordStart,
      autoPop: false,
    };
  }

  let last: string | null = null;
  CLAUSE_RE.lastIndex = 0;
  for (let m = CLAUSE_RE.exec(before); m; m = CLAUSE_RE.exec(before)) last = m[1].toLowerCase();
  if (!last || NONE_KW.has(last)) return null;

  const tables = statementTables(stmt);
  const wordFrom = wordStart;
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
  /** null = 目前資料庫（namespace 頂層的裸表名）。 */
  db: string | null;
  columns: string[];
}

/**
 * 把 SQLNamespace 攤平成「參照 → 欄位」查找表。
 *
 * 鍵有兩種，對應 toMultiDbSqlNamespace 的兩層形態：頂層（目前庫）的表用裸名 `orders`，
 * 巢狀（跨庫）的表用 `dbb.orders`。兩者不互相覆蓋——跨庫 join 兩張同名表時，
 * 只有限定名分得出來誰是誰。
 */
export function schemaTableMap(schema: SQLNamespace): Map<string, TableEntry> {
  const map = new Map<string, TableEntry>();
  const add = (db: string | null, name: string, cols: readonly (string | Completion)[]) => {
    const key = refKey(db, name);
    if (!map.has(key)) {
      map.set(key, { name, db, columns: cols.map((c) => (typeof c === "string" ? c : c.label)) });
    }
  };
  // depth 0 = 目前庫的表；depth 1 = 某個庫底下的表。再深的（理論上不會出現）不再往下鑽。
  const visit = (ns: SQLNamespace, db: string | null) => {
    if (Array.isArray(ns)) return;
    for (const [rawKey, val] of Object.entries(ns)) {
      const key = rawKey.replace(/\\\./g, "."); // 還原 toMultiDbSqlNamespace 對庫名的點跳脫
      if (Array.isArray(val)) add(db, key, val as readonly (string | Completion)[]);
      else if (val && typeof val === "object") {
        if ("self" in val && "children" in val) {
          const ch = (val as { children: SQLNamespace }).children;
          if (Array.isArray(ch)) add(db, key, ch as readonly (string | Completion)[]);
          else if (db === null) visit(ch, key);
        } else if (db === null) visit(val as SQLNamespace, key);
      }
    }
  };
  visit(schema, null);
  return map;
}

/** 跨庫補全所需的外部資訊（由查詢分頁提供；對話框不傳即維持單庫行為）。 */
export interface CrossDbOptions {
  /** 此連線可見的資料庫清單——用來判斷 `xxx.` 的 xxx 是不是一個庫。 */
  databases?: string[];
  /** 已載入結構的資料庫（這些由內建 source 走巢狀命名空間處理，本 source 不插手）。 */
  loaded?: string[];
  /** 目前資料庫的名字——`目前庫.表` 這種寫法要對得回頂層的裸表名。 */
  currentDb?: string | null;
  /**
   * 按需載入某個庫的結構，resolve 出該庫的表與欄位。
   *
   * 回的是「表 + 欄位」而不只是表名：`FROM 其他庫.表` 之後的欄語境也靠這一趟載入，
   * 而載回來的東西要等下一次 render 才進得了 schema prop——使用者的補全視窗就在這一次。
   */
  onNeedDatabase?: (db: string) => Promise<TableColumns[]>;
}

/**
 * 建立 CompletionSource。與預設 schema source 的分工：
 * - 欄語境：本 source 出「語句內各表的欄位」（預設 source 頂層不出欄位 → 無重複）。
 * - 表語境：只在「空前綴 + 剛打完 FROM/JOIN/逗號」自動跳表名補預設 source 的空缺；
 *   一開始打字或 Ctrl+Space 即回 null 讓預設 source 接手（避免重複項）。
 */
export function sqlContextCompletion(schema: SQLNamespace, cross?: CrossDbOptions): CompletionSource {
  const tableMap = schemaTableMap(schema);
  // 表語境的自動跳窗只出「目前庫」的表：額外庫的表也塞進來的話，`FROM ` 一按就湧出十個庫的
  // 表名，那比沒有提示更糟——它們一律以 `db.table` 限定名經由內建 source 取用。
  const allTables: Completion[] = Array.from(tableMap.values())
    .filter((t) => t.db === null)
    .map((t) => ({ label: t.name, type: "class", boost: 1 }));
  const loaded = new Set((cross?.loaded ?? []).map((d) => d.toLowerCase()));
  const known = new Set((cross?.databases ?? []).map((d) => d.toLowerCase()));
  const currentDb = cross?.currentDb?.toLowerCase() ?? null;
  // 按需載入回來的表結構，補在 tableMap 之外：那一趟載入的結果要等下一次 render 才進 schema，
  // 而要開的補全視窗就在這一次。同一個 source 實例內共用，所以後續幾次按鍵是同步命中。
  const patch = new Map<string, TableEntry>();
  // 每個庫只載一次（打字每按一鍵都會進來一次）；載回來是空的（未連線 / 權限不足 / 空庫）記進
  // failed，之後一律同步回 null——否則每按一鍵都回一個註定沒有候選的 Promise。
  const inflight = new Map<string, Promise<TableColumns[]>>();
  const failed = new Set<string>();

  /**
   * 表參照 → 結構。限定名優先精確命中；命中不到時**只在該庫結構還沒載入**才退回同名的
   * 目前庫表——`USE shop; SELECT … FROM shop.orders` 這種自我限定的寫法（跨庫功能之前
   * 一律靠丟掉前綴才work）不能因此變成沒有提示。反過來，庫已載入卻沒這張表，那就是真的
   * 沒有，硬退回別庫的同名表只會給出錯的欄位。
   */
  const resolveRef = (t: TableRef): TableEntry | undefined => {
    const bare = () => tableMap.get(refKey(null, t.table));
    if (!t.db) return bare();
    const db = t.db.toLowerCase();
    if (currentDb && db === currentDb) return bare();
    return (
      tableMap.get(refKey(t.db, t.table)) ??
      patch.get(refKey(t.db, t.table)) ??
      (loaded.has(db) ? undefined : bare())
    );
  };

  /** 這個 `xxx.` 是不是「連線裡有、但結構還沒載」的庫？是的話回庫名，否則 null。 */
  const unloadedDb = (a: SqlContext): string | null => {
    const db = a.qualifier ?? "";
    const key = db.toLowerCase();
    if (!cross?.onNeedDatabase || !db || !known.has(key) || loaded.has(key) || failed.has(key)) return null;
    // 別名剛好與某個庫同名時（`FROM t nova` 後打 `nova.`），別名優先——它是本句明確的宣告。
    if (a.tables.some((r) => r.alias?.toLowerCase() === key)) return null;
    return db;
  };

  /**
   * 載一個庫的結構進 patch 並回傳它的表。同一個庫的併發 / 後續呼叫共用同一個 promise，
   * 所以「打點跳表名」與「限定名欄語境」兩條路加起來，每個庫也只會真的載一次。
   */
  const loadDatabase = (db: string): Promise<TableColumns[]> => {
    const key = db.toLowerCase();
    let p = inflight.get(key);
    if (!p) {
      p = cross!
        .onNeedDatabase!(db)
        .then((tables) => {
          for (const t of tables) patch.set(refKey(db, t.table), { name: t.table, db, columns: t.columns });
          if (tables.length === 0) failed.add(key);
          return tables;
        })
        .catch(() => {
          failed.add(key);
          return [] as TableColumns[];
        });
      inflight.set(key, p);
    }
    return p;
  };

  // 載進來並直接把表名回給這一次補全。之後 schema 更新，同樣的位置就換內建 source
  //（走巢狀命名空間）負責，所以這條非同步路徑每個庫只會走一次。
  const loadTables = async (db: string, a: SqlContext, ctx: CompletionContext) => {
    const tables = await loadDatabase(db);
    if (tables.length === 0 || ctx.aborted) return null;
    return {
      from: a.wordFrom,
      options: tables.map((t) => ({ label: t.table, type: "class", boost: 1 })),
      validFor: /^[\w$]*$/,
    };
  };

  /**
   * 這筆限定名（`FROM 其他庫.表`）指向的庫值不值得跑一趟載入？值得就回庫名。
   *
   * 與 unloadedDb（打點那條路）只差在 known 的處理：庫清單拿不到時（list_databases 失敗）
   * 這裡仍願意試一趟——寫在 FROM 後面的限定名是使用者明講的一張表，不像打點打到一半那樣
   * 容易只是誤觸。
   */
  const refNeedsLoad = (t: TableRef): string | null => {
    if (!cross?.onNeedDatabase || !t.db) return null;
    const key = t.db.toLowerCase();
    if (loaded.has(key) || failed.has(key) || (currentDb && key === currentDb)) return null;
    if (known.size > 0 && !known.has(key)) return null;
    return t.db;
  };

  /** 由語句中各表參照組出欄位候選（解析不到結構的參照略過）。 */
  const columnResult = (a: SqlContext): CompletionResult | null => {
    const entries: TableEntry[] = [];
    for (const t of a.tables) {
      const e = resolveRef(t);
      if (e && e.columns.length > 0) entries.push(e);
    }
    if (entries.length === 0) return null;
    const multi = entries.length > 1;
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const e of entries) {
      // 多表時標出欄位來自哪張表；跨庫時帶上庫名，兩張同名表才分得出來。
      const detail = e.db ? `${e.db}.${e.name}` : e.name;
      for (const col of e.columns) {
        const key = col.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ label: col, type: "property", boost: 1, ...(multi ? { detail } : {}) });
      }
    }
    if (options.length === 0) return null;
    return { from: a.wordFrom, options, validFor: /^[\w$]*$/ };
  };

  return (ctx: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null => {
    const a = analyzeSqlContext(ctx.state.doc.toString(), ctx.pos);
    if (!a) return null;
    if (a.mode === "qualifier") {
      // 絕大多數的 `xxx.`（表名 / 別名 / 已載入的庫）在這裡同步回 null 讓內建 source 接手；
      // 只有真的要去載一個庫時才回 Promise，不讓每一次打點都多等一個 microtask。
      const db = unloadedDb(a);
      return db ? loadTables(db, a, ctx) : null;
    }
    if (a.mode === "table") {
      if (ctx.explicit || a.word !== "" || !a.autoPop || allTables.length === 0) return null;
      return { from: ctx.pos, options: allTables };
    }
    // 不該跳窗的情形先擋掉（順序刻意排在載入之前：沒有窗要開，就不值得跑一趟整庫查詢）。
    if (a.word === "" && !ctx.explicit && !a.autoPop) return null;
    // `FROM 其他庫.表` 而該庫還沒載入結構：載進來，這一次就要提示得出欄位。少了這一段，
    // 「工具列沒選庫（預設庫＝清單第一個）＋ 一律寫全限定名」這個很常見的用法一個欄位都補不到。
    const wanted: string[] = [];
    for (const t of a.tables) {
      if (resolveRef(t)) continue;
      const db = refNeedsLoad(t);
      if (db && !wanted.includes(db)) wanted.push(db);
    }
    if (wanted.length > 0) {
      return Promise.all(wanted.map(loadDatabase)).then(() => (ctx.aborted ? null : columnResult(a)));
    }
    return columnResult(a);
  };
}
