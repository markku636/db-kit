import type { SQLNamespace } from "@codemirror/lang-sql";
import { refKey, schemaTableMap, statementTables, stripNoise } from "./sqlContextComplete";
import { t } from "./i18n";

// 語意診斷：拿已載入的結構（與自動完成同一份）比對語句裡的表名與「限定欄位」（alias.col），
// 找不到就畫黃線。原則是**寧可漏報、不可誤報**——結構快取可能過期、方言語法千奇百怪，
// 只在很確定的時候才說話：
// - 表：只看 FROM / JOIN / UPDATE / INTO 後面直接接的名字；跳過 CTE、同份腳本裡 CREATE 的表、
//   暫存表（#t / @t）、表函式 `f(...)`、系統目錄（information_schema / pg_catalog / sys / dual…），
//   以及還沒載入結構的其他資料庫。
// - 欄：只看 `限定詞.欄名`，限定詞要能唯一對回一張已知、且欄位清單非空的表；裸欄名一律不判
//   （SELECT 別名、函式、相關子查詢都會讓裸欄名判斷誤報）。
// - 只檢查 DML（SELECT / WITH / INSERT / UPDATE / DELETE / MERGE）；DDL 的名字本來就可能還不存在。

export interface SemanticIssue {
  from: number;
  to: number;
  message: string;
}

const IDENT = "(?:`[^`]+`|\"[^\"]+\"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)";
const REF = IDENT + "(?:\\s*\\.\\s*" + IDENT + ")*";
const TABLE_AT = new RegExp("\\b(from|join|update|into)(\\s+)(" + REF + ")", "gi");
const QUALIFIED_COL = /(?<![\w$.`"\]])([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)\b(?!\s*[.(])/g;
const CTE_NAME = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([A-Za-z_][\w$]*)\s*(?:\([^()]*\))?\s+as\s*(?:(?:not\s+)?materialized\s*)?\(/gi;
const CREATED = /\bcreate\s+(?:or\s+replace\s+)?(?:global\s+|local\s+)?(?:temp(?:orary)?\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?([^\s(]+)/gi;
const DML_START = /^\s*(select|with|insert|update|delete|merge|replace)\b/i;
const NOT_TABLE = new Set(["lateral", "only", "unnest", "select", "values", "table", "dual", "set"]);
const SYSTEM_DB = new Set(["information_schema", "pg_catalog", "sys", "mysql", "performance_schema", "sqlite_schema", "pg_toast"]);
const SYSTEM_BARE = /^(pg_|sqlite_|sys|information_schema|all_|user_|dba_|v\$)/i;

function unquote(s: string): string {
  const a = s[0];
  const b = s[s.length - 1];
  if ((a === "`" && b === "`") || (a === '"' && b === '"') || (a === "[" && b === "]")) return s.slice(1, -1);
  return s;
}

/** 函式參數裡的 FROM（`EXTRACT(YEAR FROM d)`、`SUBSTRING(s FROM 2)`、`TRIM(x FROM s)`）不是表參照。 */
const FROM_IN_CALL = new Set(["extract", "substring", "substr", "trim", "position", "overlay", "convert", "cast"]);
function enclosingCall(s: string, idx: number): string | null {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = s[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        const m = /([A-Za-z_][\w$]*)\s*$/.exec(s.slice(0, i));
        return m ? m[1].toLowerCase() : "";
      }
      depth--;
    }
  }
  return null;
}

function splitRef(ref: string): { db: string | null; table: string } {
  const parts = ref.split(".").map((p) => unquote(p.trim()));
  if (parts.length === 1) return { db: null, table: parts[0] };
  return { db: parts[0], table: parts.slice(1).join(".") };
}

type Entry = NonNullable<ReturnType<ReturnType<typeof schemaTableMap>["get"]>>;

/** 一段語句的檢查上下文。 */
interface StmtCtx {
  piece: string;
  start: number;
  selectLike: boolean;
  skipNames: Set<string>;
  lookup: (db: string | null, table: string) => Entry | undefined;
  dbLoaded: (db: string) => boolean;
}

/** 這個 FROM / JOIN / UPDATE / INTO 後面的名字值不值得判（排除函式參數、表函式、CTE、系統目錄…）。 */
function isCheckableTableRef(c: StmtCtx, m: RegExpExecArray, db: string | null, table: string): boolean {
  const kw = m[1].toLowerCase();
  const after = c.piece.slice(m.index + m[0].length).trimStart();
  if (kw !== "into" && after.startsWith("(")) return false; // 表函式
  if (kw === "into" && c.selectLike) return false; // SELECT … INTO 的目標是新表或變數
  if (kw === "from") {
    if (/\bdistinct\s+$/i.test(c.piece.slice(0, m.index))) return false; // IS [NOT] DISTINCT FROM
    const call = enclosingCall(c.piece, m.index);
    if (call !== null && FROM_IN_CALL.has(call)) return false;
  }
  const low = table.toLowerCase();
  if (!table || NOT_TABLE.has(low) || c.skipNames.has(low)) return false;
  if (/^[#@]/.test(table) || SYSTEM_BARE.test(table)) return false;
  if (db && SYSTEM_DB.has(db.toLowerCase())) return false;
  // 其他庫的結構還沒載入（或是 MSSQL 的 schema 限定）→ 不判。
  if (db && !c.dbLoaded(db) && !c.lookup(db, table)) return false;
  return true;
}

/** 表參照檢查；回傳表參照在語句內的範圍（欄位檢查要避開 `db.table`）。 */
function checkTables(c: StmtCtx, issues: SemanticIssue[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  TABLE_AT.lastIndex = 0;
  for (let m = TABLE_AT.exec(c.piece); m; m = TABLE_AT.exec(c.piece)) {
    const raw = m[3];
    const rel = m.index + m[1].length + m[2].length;
    spans.push([rel, rel + raw.length]);
    const { db, table } = splitRef(raw);
    if (!isCheckableTableRef(c, m, db, table) || c.lookup(db, table)) continue;
    issues.push({
      from: c.start + rel,
      to: c.start + rel + raw.length,
      message: t("找不到資料表 {table}（依目前載入的結構；剛建立的表請重新整理結構）", { table: raw }),
    });
  }
  return spans;
}

/** `限定詞.欄名` 檢查：限定詞（別名或表名）要唯一對回一張欄位已知的表。 */
function checkColumns(c: StmtCtx, tableSpans: Array<[number, number]>, issues: SemanticIssue[]): void {
  const qual = new Map<string, Entry | null>();
  const bind = (q: string, e: Entry | undefined) => {
    if (!e) return;
    const k = q.toLowerCase();
    const prev = qual.get(k);
    if (prev === undefined) qual.set(k, e);
    else if (prev !== e) qual.set(k, null); // 同一個限定詞對到兩張表（子查詢重用別名）→ 不判
  };
  for (const r of statementTables(c.piece)) {
    const e = c.lookup(r.db, r.table);
    if (r.alias) bind(r.alias, e);
    bind(r.table.split(".").pop() ?? r.table, e);
  }
  if (qual.size === 0) return;
  QUALIFIED_COL.lastIndex = 0;
  for (let m = QUALIFIED_COL.exec(c.piece); m; m = QUALIFIED_COL.exec(c.piece)) {
    const at = m.index;
    if (tableSpans.some(([a, b]) => at >= a && at < b)) continue; // 這是 db.table，不是欄位
    const e = qual.get(m[1].toLowerCase());
    if (!e || e.columns.length === 0) continue;
    const col = m[2];
    if (e.columns.some((x) => x.toLowerCase() === col.toLowerCase())) continue;
    const from = c.start + at + m[1].length + 1;
    issues.push({ from, to: from + col.length, message: t("{table} 沒有欄位 {col}", { table: e.name, col }) });
  }
}

/**
 * @param currentDb 目前資料庫（`currentDb.t` 視同裸名 `t`）。
 */
export function lintSqlSemantics(doc: string, schema: SQLNamespace | undefined, currentDb?: string | null): SemanticIssue[] {
  if (!schema || doc.length > 200_000) return [];
  const map = schemaTableMap(schema);
  if (map.size === 0) return [];
  const loadedDbs = new Set<string>();
  for (const e of map.values()) if (e.db) loadedDbs.add(e.db.toLowerCase());
  const cur = currentDb?.toLowerCase() ?? null;
  const lookup = (db: string | null, table: string) => {
    const d = db?.toLowerCase() ?? null;
    if (d === null || d === cur) return map.get(refKey(null, table)) ?? map.get(refKey(db, table));
    return map.get(refKey(db, table));
  };
  const dbLoaded = (db: string) => db.toLowerCase() === cur || loadedDbs.has(db.toLowerCase());

  const { text } = stripNoise(doc);
  // 整份腳本裡 CREATE 的表 / 視圖：同一份腳本後面引用它們是合法的。
  const created = new Set<string>();
  CREATED.lastIndex = 0;
  for (let m = CREATED.exec(text); m; m = CREATED.exec(text)) created.add(splitRef(m[1]).table.toLowerCase());

  const issues: SemanticIssue[] = [];
  let start = 0;
  for (const piece of text.split(";")) {
    const stmtStart = start;
    start += piece.length + 1;
    const head = DML_START.exec(piece);
    if (!head) continue;
    const skipNames = new Set(created);
    CTE_NAME.lastIndex = 0;
    for (let m = CTE_NAME.exec(piece); m; m = CTE_NAME.exec(piece)) skipNames.add(m[1].toLowerCase());
    const c: StmtCtx = { piece, start: stmtStart, selectLike: /^(select|with)$/i.test(head[1]), skipNames, lookup, dbLoaded };
    const spans = checkTables(c, issues);
    checkColumns(c, spans, issues);
  }
  return issues;
}
