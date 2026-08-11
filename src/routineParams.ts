// 預存程序 / 函式的引數簽章解析與呼叫組裝。
//
// 抽成獨立模組（不依賴 React / Tauri）以便單元測試；「執行」表單與清單顯示共用同一份解析，
// 免得兩處各拆一次而對不上。簽章字串的來源是後端 list_routines：
// - MySQL 家族 / external gateway：`IN p_id int(11), OUT p_total decimal(10,2)`（見 db/mysql.rs）
// - PostgreSQL：`pg_get_function_identity_arguments`，**只有型別沒有名稱**（`integer, text`）
import type { DbKind, RoutineInfo } from "./api";
import { buildRoutineCall, isMysqlFamily, quoteIdent, sqlLiteral } from "./sql";

export type ParamMode = "IN" | "OUT" | "INOUT" | "";

export interface RoutineParam {
  mode: ParamMode;
  /** PG 的簽章只有型別，此處為空字串。 */
  name: string;
  type: string;
}

/** OUT / INOUT 要用 session 變數接回值——只有 MySQL 方言（含講 MySQL 的 gateway）辦得到。 */
export const usesSessionVars = (kind: DbKind): boolean => isMysqlFamily(kind) || kind === "external";

const MODES = new Set(["IN", "OUT", "INOUT"]);

// 逐字掃描時共用的狀態機：括號深度 + 引號。抽出來是因為「拆引數」與「拆詞」只差在分隔條件。
function scanSplit(s: string, isSeparator: (c: string, depth: number) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) {
        // 連續兩個同引號是轉義（`enum('a''b')`），不算結束。
        if (s[i + 1] === quote) cur += s[++i];
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; cur += c; continue; }
    if (c === "(") { depth++; cur += c; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); cur += c; continue; }
    if (isSeparator(c, depth)) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 拆引數清單。**不能用 `split(",")`**——型別本身就含逗號（`decimal(10,2)`、`enum('a','b')`），
 * 一刀切下去會把一個引數剁成兩半，表單就多長出不存在的欄位。
 */
export function splitSignature(sig: string): string[] {
  return scanSplit(sig, (c, depth) => c === "," && depth === 0);
}

/** 拆一個引數內的詞。型別可能含空白（`int unsigned`、`timestamp without time zone`）故只切頂層。 */
function splitWords(part: string): string[] {
  return scanSplit(part, (c, depth) => depth === 0 && /\s/.test(c));
}

/** 解析簽章字串成結構化引數清單。空簽章 / null 回空陣列（＝無引數）。 */
export function parseRoutineParams(kind: DbKind, sig: string | null | undefined): RoutineParam[] {
  if (!sig || !sig.trim()) return [];
  return splitSignature(sig).map((part) => {
    const tokens = splitWords(part);
    let mode: ParamMode = "";
    if (tokens.length > 1 && MODES.has(tokens[0].toUpperCase())) {
      mode = tokens.shift()!.toUpperCase() as ParamMode;
    }
    // PG 給的是純型別清單，第一個詞是型別不是名稱——照 MySQL 規則硬拆會把 `integer` 當成參數名。
    if (kind === "postgres" && mode === "") return { mode, name: "", type: tokens.join(" ") };
    const name = tokens.length > 1 ? tokens.shift()! : "";
    return { mode, name, type: tokens.join(" ") };
  });
}

// 數值型別才放行裸值。預設方向刻意偏向「加引號」：字串與日期少了引號一定壞，
// 而數值多了引號 MySQL 會隱式轉型、多半仍跑得動——錯的那一側代價小很多。
const NUMERIC_TYPE = /^(tinyint|smallint|mediumint|bigint|int|integer|decimal|numeric|dec|fixed|float|double|real|bit|bool|boolean)\b/i;
export const isNumericType = (type: string): boolean => NUMERIC_TYPE.test(type.trim());

const LOOKS_NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * 把表單一格的輸入轉成 SQL 字面值。
 *
 * 留空 = `NULL`（不是空字串）：引數留白的意思幾乎總是「這個參數不給」，而不是「給一個長度 0
 * 的字串」。輸入一律當**資料**處理、原樣跳脫，不試圖辨認使用者是否已經自己加了引號——
 * 猜錯就是把資料吃掉或開一個注入口。要傳運算式（`NOW()`、子查詢）請用對話框的「編輯 SQL」。
 */
export function routineArgLiteral(kind: DbKind, value: string, type: string): string {
  const v = value.trim();
  if (v === "" || /^null$/i.test(v)) return "NULL";
  if (isNumericType(type) && LOOKS_NUMERIC.test(v)) return v;
  return sqlLiteral(kind, value);
}

/** session 變數名：以引數名為底，非法字元換底線；無名（PG）時用序號。 */
export function outVarName(p: RoutineParam, i: number): string {
  const base = (p.name || `p${i + 1}`).replace(/[^A-Za-z0-9_]/g, "_");
  return `@${base || `p${i + 1}`}`;
}

export interface RoutineExecSql {
  sql: string;
  /** 會以 SELECT 讀回的輸出引數名（空陣列 = 沒有 OUT / INOUT）。 */
  outNames: string[];
}

/**
 * 由表單值組出可執行的 SQL。
 *
 * OUT / INOUT 走 session 變數三段式（`SET` → `CALL` → `SELECT`），且**必須同一次送出**——
 * 分開送對 gateway 型連線是分開的 HTTP 請求，session 變數不保證還在，讀回來會是 NULL。
 */
export function buildRoutineExecSql(
  kind: DbKind,
  db: string,
  routine: Pick<RoutineInfo, "name" | "routine_type">,
  params: RoutineParam[],
  values: string[],
): RoutineExecSql {
  const sessionVars = usesSessionVars(kind);
  const pre: string[] = [];
  const outs: { v: string; label: string }[] = [];
  const args = params.map((p, i) => {
    const raw = values[i] ?? "";
    if (sessionVars && (p.mode === "OUT" || p.mode === "INOUT")) {
      const v = outVarName(p, i);
      // INOUT 要先把傳入值放進變數，否則程序讀到的是 NULL。
      if (p.mode === "INOUT") pre.push(`SET ${v} = ${routineArgLiteral(kind, raw, p.type)}`);
      outs.push({ v, label: p.name || v.slice(1) });
      return v;
    }
    return routineArgLiteral(kind, raw, p.type);
  });
  const call = buildRoutineCall(kind, db, routine.name, routine.routine_type, args.join(", "));
  const stmts = [...pre, call];
  if (outs.length) {
    stmts.push(`SELECT ${outs.map((o) => `${o.v} AS ${quoteIdent(kind, o.label)}`).join(", ")}`);
  }
  return { sql: stmts.join(";\n"), outNames: outs.map((o) => o.label) };
}

/** 清單顯示用的精簡簽章：`(IN p_id int, OUT p_total decimal)`；無引數回空字串。 */
export function formatSignature(params: RoutineParam[]): string {
  if (!params.length) return "";
  return `(${params.map((p) => [p.mode, p.name, p.type].filter(Boolean).join(" ")).join(", ")})`;
}
