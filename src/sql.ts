// 純函式工具：查詢歷史 / 收藏 / 結果序列化 / SQL 多語句切分 / 跨資料庫識別字跳脫。
// 抽離自 App.tsx / TableView.tsx 以便單元測試（見 sql.test.ts）且不依賴 React / Tauri。
import type { DbKind, QueryResult } from "./api";

// ---- 跨資料庫識別字 / 字面值跳脫（MySQL / PostgreSQL / SQLite 一致性關鍵）----
// 識別字：PostgreSQL 用雙引號，其餘（MySQL / SQLite）用反引號；內部引號加倍轉義。
export function quoteIdent(kind: DbKind, id: string): string {
  return kind === "postgres" ? `"${id.replace(/"/g, '""')}"` : `\`${id.replace(/`/g, "``")}\``;
}
// 限定名：SQLite 不加 schema / db 前綴；MySQL / PostgreSQL 為 db.table（PG 之 db 即 schema）。
export function qualifiedName(kind: DbKind, db: string, table: string): string {
  return kind === "sqlite" ? quoteIdent(kind, table) : `${quoteIdent(kind, db)}.${quoteIdent(kind, table)}`;
}
// SQL 字串字面值：NULL → NULL，其餘以單引號包裹並轉義內部單引號。
// MySQL 預設把反斜線當字串轉義字元，故需加倍（否則含 \ 的值會被誤解，如 \b = 退格）；
// PostgreSQL（standard_conforming_strings）與 SQLite 視 \ 為字面字元，不可加倍（否則多出反斜線）。
export function sqlLiteral(kind: DbKind, v: string | null): string {
  if (v === null) return "NULL";
  const escaped =
    kind === "mysql" ? v.replace(/\\/g, "\\\\").replace(/'/g, "''") : v.replace(/'/g, "''");
  return `'${escaped}'`;
}

// ---- 查詢歷史（localStorage，最近在前，去重，上限 50）----
export const QUERY_HISTORY_KEY = "at-kit:queryHistory";
const QUERY_HISTORY_CAP = 50;

export function loadQueryHistory(): string[] {
  try {
    const raw = localStorage.getItem(QUERY_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushQueryHistory(prev: string[], q: string): string[] {
  const trimmed = q.trim();
  if (!trimmed) return prev;
  const next = [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, QUERY_HISTORY_CAP);
  try {
    localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 忽略寫入失敗 */
  }
  return next;
}

// ---- 收藏查詢（具名，localStorage）----
export const SAVED_QUERIES_KEY = "at-kit:savedQueries";
export interface SavedQuery {
  name: string;
  sql: string;
}
export function loadSavedQueries(): SavedQuery[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SAVED_QUERIES_KEY) || "[]");
    return Array.isArray(arr)
      ? arr.filter((x) => x && typeof x.name === "string" && typeof x.sql === "string")
      : [];
  } catch {
    return [];
  }
}
export function persistSavedQueries(list: SavedQuery[]) {
  try {
    localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(list));
  } catch {
    /* 忽略寫入失敗 */
  }
}

// ---- 結果序列化（複製 / 匯出）----
export function resultToTsv(r: QueryResult): string {
  const head = r.columns.join("\t");
  const body = r.rows.map((row) => row.map((c) => c ?? "").join("\t")).join("\n");
  return body ? `${head}\n${body}` : head;
}
export function resultToJson(r: QueryResult): string {
  return JSON.stringify(
    r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i] ?? null]))),
    null,
    2
  );
}
// RFC4180 風格 CSV：含逗號 / 引號 / 換行的欄位以雙引號包裹並轉義。
export function resultToCsv(r: QueryResult): string {
  const esc = (v: string | null) => {
    const s = v ?? "";
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = r.columns.map(esc).join(",");
  const body = r.rows.map((row) => row.map(esc).join(",")).join("\n");
  return body ? `${head}\n${body}` : head;
}
export function fmtElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// 以分號切分多條 SQL，但略過字串字面量（' " `）、註解（-- 行、/* */ 區塊）
// 與 PostgreSQL dollar-quoting（$$ … $$ / $tag$ … $tag$，函式 / DO 區塊本體常含分號）內的分號。
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inS = false, inD = false, inBack = false, lineC = false, blockC = false;
  let dollar: string | null = null; // 作用中的 $tag$ 結束標記
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (dollar) {
      // dollar-quote 內：原樣複製，遇到相同結束標記才離開。
      if (ch === "$" && sql.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length - 1;
        dollar = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (lineC) { cur += ch; if (ch === "\n") lineC = false; continue; }
    if (blockC) { cur += ch; if (ch === "*" && nx === "/") { cur += nx; i++; blockC = false; } continue; }
    if (inS) { cur += ch; if (ch === "'") { if (nx === "'") { cur += nx; i++; } else inS = false; } continue; }
    if (inD) { cur += ch; if (ch === '"') { if (nx === '"') { cur += nx; i++; } else inD = false; } continue; }
    if (inBack) { cur += ch; if (ch === "`") inBack = false; continue; }
    if (ch === "-" && nx === "-") { lineC = true; cur += ch; continue; }
    if (ch === "/" && nx === "*") { blockC = true; cur += ch + nx; i++; continue; }
    if (ch === "'") { inS = true; cur += ch; continue; }
    if (ch === '"') { inD = true; cur += ch; continue; }
    if (ch === "`") { inBack = true; cur += ch; continue; }
    if (ch === "$") {
      // PostgreSQL dollar-quote 開頭標記 $$ 或 $tag$（$1 之類參數不符，會落到一般字元）。
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) { dollar = m[0]; cur += dollar; i += dollar.length - 1; continue; }
    }
    if (ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
