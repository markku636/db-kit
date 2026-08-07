// 正式環境（prod）寫入前的「影響評估」核心：把 UPDATE / DELETE / TRUNCATE / INSERT / DDL
// 靜態解析成結構化評估項，並改寫出「保證唯讀」的 COUNT / 受影響列預覽 / 還原用 SELECT。
// 純函式、無 React / Tauri 相依（見 impact.test.ts）。
//
// 為什麼不直接用 sql.ts 的 stripCode / stripParens：那兩支把每個字串 / 註解 / 括號區塊
// 塌成單一空白，位移全毀 —— 它們服務的是「有沒有頂層 WHERE」這種布林判斷，而這裡要
// 「從 WHERE 切到句尾」再拿**原文**重組 SQL（引號、大小寫、schema 前綴都得保真），
// 必須保住每個字元的位置。故另立一份等長遮罩 maskSql。
//
// 為什麼不寫完整 SQL parser：六個方言的 DML 在 FROM / USING / JOIN / TOP / LIMIT /
// RETURNING / OUTPUT 上呈組合爆炸，一個「大致對」的 parser 會在未涵蓋語法上**靜默切錯
// WHERE**，端出看似合理的假數字 —— 那正是本功能最不能出的錯（使用者會被假數字說服後
// 按下執行）。這裡只回答三個問題：目標是誰、頂層 WHERE 在哪、尾巴砍到哪；答不出來就
// 明確回報「無法估算」，寧可少給資訊也不給錯資訊。
import type { DbKind } from "./api";
import { extractNamedParams, isMysqlFamily, isWriteStatement } from "./sql";

// 遮罩填充字元：非空白、非運算子 —— 被遮的區塊仍算「單一 token」，不會讓 `UPDATE'x'SET`
// 這種相鄰寫法黏成一個字。註解則遮成空白（註解本來就是分隔符），兩者分開處理才不會讓
// `UPDATE/*c*/t` 黏成 `UPDATEt`。
const FILL = "\u0001";

/** 預覽「受影響列」時取的列數。 */
export const PREVIEW_ROWS = 20;

// ---- 位移保留式遮罩 ----

export interface MaskedSql {
  /** 原文（重組 SQL 一律從這裡切）。 */
  src: string;
  /** 與 src 等長：字面值 / 引號識別字 / $$ 區塊 → FILL；註解 → 空白；其餘原樣。 */
  mask: string;
  /** 與 src 等長：該位移的括號深度（`(` 與 `)` 都記「外層」深度）。 */
  depth: Int32Array;
}

// PostgreSQL 的 E'…' 字面值一律認反斜線轉義（其餘情境依方言決定）。
function isPgEscapeString(kind: DbKind, sql: string, quoteAt: number): boolean {
  if (kind !== "postgres") return false;
  const prev = sql[quoteAt - 1];
  if (prev !== "E" && prev !== "e") return false;
  const before = sql[quoteAt - 2];
  return before === undefined || !/\w/.test(before);
}

/**
 * 把 SQL 掃成「等長遮罩 + 括號深度」。方言差異只影響三件事：
 * mssql 的 [識別字]、mysql 家族的反斜線字串轉義、postgres 的 E'…' 與 $tag$ 區塊。
 */
export function maskSql(kind: DbKind, sql: string): MaskedSql {
  const n = sql.length;
  const out = new Array<string>(n);
  const depth = new Int32Array(n);
  // MySQL 家族（與講 MySQL 方言的 external gateway）預設把 \ 當字串轉義字元；
  // PostgreSQL（standard_conforming_strings）與 SQLite / MSSQL 視 \ 為字面字元。
  const backslash = isMysqlFamily(kind) || kind === "external";
  let d = 0;
  let i = 0;
  const fill = (from: number, to: number, ch: string) => {
    for (let k = from; k < to; k++) {
      out[k] = ch;
      depth[k] = d;
    }
  };
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      const stop = nl < 0 ? n : nl; // 換行本身保留（仍是分隔符）
      fill(i, stop, " ");
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      fill(i, stop, " ");
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      // 反引號是識別字（MySQL / SQLite），只認加倍轉義，不認反斜線。
      const esc = ch !== "`" && (backslash || isPgEscapeString(kind, sql, i));
      let j = i + 1;
      while (j < n) {
        if (esc && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2; // 加倍轉義
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      const stop = Math.min(j, n);
      fill(i, stop, FILL);
      i = stop;
      continue;
    }
    // [識別字] 只在 MSSQL 認：其餘方言的 `[` 可能是 PG 的陣列下標 a[1]，不可誤吃。
    if (ch === "[" && kind === "mssql") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "]") {
          if (sql[j + 1] === "]") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      const stop = Math.min(j, n);
      fill(i, stop, FILL);
      i = stop;
      continue;
    }
    // PostgreSQL dollar-quoting：$$ … $$ / $tag$ … $tag$。tag 需以字母 / 底線開頭，
    // 故 PG 的參數佔位符 $1 不會誤入。
    if (ch === "$" && kind === "postgres") {
      const dm = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (dm) {
        const tag = dm[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? n : end + tag.length;
        fill(i, stop, FILL);
        i = stop;
        continue;
      }
    }
    if (ch === "(") {
      out[i] = ch;
      depth[i] = d;
      d++;
      i++;
      continue;
    }
    if (ch === ")") {
      if (d > 0) d--;
      out[i] = ch;
      depth[i] = d;
      i++;
      continue;
    }
    out[i] = ch;
    depth[i] = d;
    i++;
  }
  return { src: sql, mask: out.join(""), depth };
}

/** 在遮罩上找「括號深度 0」的關鍵字位移；-1 = 找不到。re 不必自帶 g 旗標。 */
export function findTopKeyword(m: MaskedSql, re: RegExp, from = 0): number {
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  rx.lastIndex = Math.max(0, from);
  let hit: RegExpExecArray | null;
  while ((hit = rx.exec(m.mask)) !== null) {
    if (m.depth[hit.index] === 0) return hit.index;
    if (rx.lastIndex === hit.index) rx.lastIndex++; // 零寬比對防呆
  }
  return -1;
}

/** 在 [from, to) 依「深度 0 的分隔字元」切開，回傳已 trim 的原文片段（略過空片段）。 */
export function splitTopLevel(m: MaskedSql, from: number, to: number, sep: string): string[] {
  const parts: string[] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    if (m.mask[i] === sep && m.depth[i] === 0) {
      const v = m.src.slice(start, i).trim();
      if (v) parts.push(v);
      start = i + 1;
    }
  }
  const last = m.src.slice(start, to).trim();
  if (last) parts.push(last);
  return parts;
}

// ---- 評估型別 ----

export type ImpactOp =
  | "update"
  | "delete"
  | "truncate"
  | "insert"
  | "replace"
  | "merge"
  | "drop_table"
  | "drop_object"
  | "drop_database"
  | "alter_table"
  | "create"
  | "other";

/** exact＝COUNT 等於實際影響列數；upperBound＝JOIN / USING fan-out 可能重複計數，實際 ≤ 此值。 */
export type ImpactConfidence = "exact" | "upperBound";

/** probes 為空時的機器可讀理由（文案由 UI 對映，測試才不會綁字串）。 */
export type ImpactUnknownReason =
  | "noRowImpact" // 不影響任何既有資料列（CREATE / GRANT / DROP INDEX…）
  | "mergeBranches" // MERGE 的 MATCHED / NOT MATCHED 分支需分別評估
  | "writingCte" // CTE 內含寫入 —— 保留 WITH 前綴去探測會真的寫入資料
  | "procedureBody" // CALL / EXEC / DO：程序內容不可分析
  | "unresolvedParams" // 仍含未代入的 :name 具名參數
  | "bulkLoad" // LOAD DATA / COPY … FROM：來源在檔案端
  | "wholeDatabase" // DROP DATABASE / SCHEMA：無單一表可計數
  | "unparsed"; // 句型不在可分析白名單

export interface ImpactProbe {
  /** 顯示標籤（多目標語句用表名）。 */
  label: string;
  /** COUNT 探測 SQL（不含尾分號、不含 USE 前綴；保證唯讀）。 */
  countSql: string;
  /** 受影響列預覽（已套方言 row limit）。 */
  previewSql: string;
  /** 「還原用 SELECT」＝同 WHERE 的無 limit SELECT *；null＝不適用（INSERT 的列尚不存在）。 */
  undoSelect: string | null;
  confidence: ImpactConfidence;
  /** MySQL `UPDATE … LIMIT n` / MSSQL `DELETE TOP (n)`：實際影響列數 = min(count, rowCap)。 */
  rowCap: number | null;
  /** true＝述詞改寫失敗，這是**整表**列數而非受影響列數，UI 必須另外標示。 */
  fallbackWholeTable: boolean;
}

export interface ImpactItem {
  /** 在批次中的 0-based 序號。 */
  index: number;
  /** 使用者原語句（不含注入的 USE 前綴）。 */
  sql: string;
  op: ImpactOp;
  /** false＝SELECT / SHOW / EXPLAIN…，不列入影響評估。 */
  write: boolean;
  /** 目標物件（保留原文引用形式）。 */
  targets: string[];
  /** 僅 update / delete 有意義；false＝無頂層 WHERE，將影響整張表。 */
  hasWhere: boolean | null;
  /** INSERT … VALUES 的 tuple 數（靜態可知，無需探測）。 */
  staticRows: number | null;
  /** false＝含 ON DUPLICATE / ON CONFLICT，實際落地列數可能與 staticRows 不同。 */
  staticExact: boolean;
  /**
   * 無法用「還原用 SELECT」保住前像、或會直接摧毀物件的操作
   * （TRUNCATE / DROP / 破壞性 ALTER / REPLACE / MERGE）。
   * UPDATE / DELETE 不算 —— 它們有前像可先撈下來存著。
   */
  irreversible: boolean;
  /** 0 低 / 1 中 / 2 高（全表寫入、不可逆 DDL）。 */
  severity: 0 | 1 | 2;
  probes: ImpactProbe[];
  /** probes 為空時的理由；probes 非空時為 null。 */
  reason: ImpactUnknownReason | null;
}

// ---- 探測 SQL 的唯讀安全閘 ----

/**
 * 探測 SQL 必須是純讀取。任一條不過就不得送往資料庫。
 *
 * 這是本功能唯一的災難級失敗模式：`WITH d AS (DELETE … RETURNING *) …` 若被當成無害的
 * CTE 前綴保留下來，「評估」本身就會真的刪掉 prod 資料。故用白名單起手 + 全深度黑名單掃描，
 * 且刻意寧枉勿縱 —— 誤拒只是使用者少看到一個數字，誤放是直接改到正式資料。
 */
export function isReadOnlyProbeSql(kind: DbKind, sql: string): boolean {
  const m = maskSql(kind, sql);
  if (!/^\s*(select|with)\b/i.test(m.mask)) return false;
  // 多語句：探測一次只送一條，分號後還有內容就拒絕。
  const semi = m.mask.indexOf(";");
  if (semi >= 0 && m.mask.slice(semi + 1).trim()) return false;
  // 任何深度都不得出現寫入 / DDL 關鍵字。字面值與註解已被遮罩，裡頭的字不算數。
  // 含 into：T-SQL 的 `SELECT … INTO newtable` 會建表；含 set：擋掉誤帶的 SET search_path。
  // \b…\b 不會誤中 update_log / order_items / created_at（底線與字母都屬 \w）。
  return !/\b(insert|update|delete|merge|truncate|drop|alter|create|replace|grant|revoke|call|exec|execute|do|copy|load|lock|commit|rollback|savepoint|set|into)\b/i.test(
    m.mask,
  );
}

// ---- 方言差異 ----

// 子查詢計數包裝：Oracle 的 FROM 子查詢別名不可加 AS（`) AS _sub` 是語法錯誤）。
// 不複用 sql.ts 的 buildCountQuery —— 那支只吃視覺建構器的 QbSpec，且寫死 AS _sub。
function wrapCount(kind: DbKind, inner: string): string {
  return `SELECT COUNT(*) AS total FROM (${inner}) ${kind === "oracle" ? "_sub" : "AS _sub"}`;
}

// 預覽前 N 列：MSSQL 的 TOP 必須緊跟 SELECT（不能事後 append），Oracle 12c+ 用
// FETCH FIRST（11g 無此語法，屬已知限制），其餘方言用 LIMIT。
function limitTail(kind: DbKind, n: number): string {
  if (kind === "mssql") return "";
  return kind === "oracle" ? ` FETCH FIRST ${n} ROWS ONLY` : ` LIMIT ${n}`;
}
function limitHead(kind: DbKind, n: number): string {
  return kind === "mssql" ? `TOP (${n}) ` : "";
}

// ---- 小工具 ----

const cut = (m: MaskedSql, from: number, to: number) => m.src.slice(from, Math.max(from, to)).trim();

/**
 * 從來源運算式取出第一個表名（顯示標籤，也是述詞改寫失敗時的整表保底來源）。
 * 必須用遮罩掃 —— 引號識別字內可以有空白（`dbo.[Order Items]`、`"my table"`），
 * 直接用 /^[^\s,(]+/ 會把它切成半截，端出 `SELECT COUNT(*) FROM dbo.[Order` 這種爛 SQL。
 */
function firstTable(kind: DbKind, expr: string): string {
  const s = expr.trim();
  if (!s) return s;
  const m = maskSql(kind, s);
  for (let i = 0; i < m.mask.length; i++) {
    const c = m.mask[i];
    if (c === "," || c === "(" || /\s/.test(c)) return s.slice(0, i);
  }
  return s;
}

// COUNT / 預覽查詢不需要（且部分方言的子查詢不允許）RETURNING / OUTPUT / ORDER BY / LIMIT。
const TAIL_RE = /\b(returning|output|order\s+by|limit|offset|fetch\s+first|fetch\s+next)\b/gi;

function findTail(m: MaskedSql, from: number): number {
  const idx = findTopKeyword(m, TAIL_RE, from);
  return idx < 0 ? m.src.length : idx;
}

// MySQL 的 `UPDATE … LIMIT n` / `DELETE … LIMIT n` 是「最多動 n 列」，要併進實際影響列數。
function findRowCap(m: MaskedSql, from: number): number | null {
  const idx = findTopKeyword(m, /\blimit\b/gi, from);
  if (idx < 0) return null;
  const hit = /^\s*(\d+)/.exec(m.src.slice(idx + 5));
  return hit ? Number(hit[1]) : null;
}

function hasTopIn(m: MaskedSql, re: RegExp, from: number, to: number): boolean {
  const idx = findTopKeyword(m, re, from);
  return idx >= 0 && idx < to;
}

interface ProbeOpts {
  confidence?: ImpactConfidence;
  rowCap?: number | null;
  fallbackWholeTable?: boolean;
  /** 已成形的完整查詢（INSERT … SELECT 用）；給了就不再由 source / where 組。 */
  ready?: { countSql: string; previewSql: string; undoSelect: string | null };
}

// 引擎自我驗證：任何一條產出的探測 SQL 沒通過唯讀檢查就整個丟棄（對話框送出前還會再驗一次）。
function makeProbe(kind: DbKind, label: string, source: string, where: string, opts: ProbeOpts = {}): ImpactProbe | null {
  const probe: ImpactProbe = {
    label,
    countSql: opts.ready ? opts.ready.countSql : `SELECT COUNT(*) FROM ${source}${where}`,
    previewSql: opts.ready
      ? opts.ready.previewSql
      : `SELECT ${limitHead(kind, PREVIEW_ROWS)}* FROM ${source}${where}${limitTail(kind, PREVIEW_ROWS)}`,
    undoSelect: opts.ready ? opts.ready.undoSelect : `SELECT * FROM ${source}${where}`,
    confidence: opts.confidence ?? "exact",
    rowCap: opts.rowCap ?? null,
    fallbackWholeTable: opts.fallbackWholeTable ?? false,
  };
  if (!isReadOnlyProbeSql(kind, probe.countSql)) return null;
  if (!isReadOnlyProbeSql(kind, probe.previewSql)) return null;
  if (probe.undoSelect && !isReadOnlyProbeSql(kind, probe.undoSelect)) return null;
  return probe;
}

/**
 * 帶保底的 probe 產生：述詞改寫過不了唯讀檢查時，退回「整表列數」並標 fallbackWholeTable，
 * 讓 UI 說清楚「這是整表 N 列，不是受影響列數」—— 而不是把猜出來的數字端上桌。
 */
function pushProbe(
  kind: DbKind,
  item: ImpactItem,
  label: string,
  source: string,
  where: string,
  opts: ProbeOpts,
  fallbackSource: string | null,
): void {
  const p = makeProbe(kind, label, source, where, opts);
  if (p) {
    item.probes.push(p);
    return;
  }
  if (fallbackSource) {
    const fb = makeProbe(kind, label, fallbackSource, "", { fallbackWholeTable: true });
    if (fb) {
      item.probes.push(fb);
      return;
    }
  }
  item.reason = "unparsed";
}

// ---- 逐句型分析 ----

// UPDATE 的形狀（跨方言）：
//   MySQL    UPDATE [LOW_PRIORITY][IGNORE] t [JOIN u ON …] SET … [WHERE …][ORDER BY …][LIMIT n]
//   PG       UPDATE [ONLY] t [AS x] SET … [FROM other] [WHERE …][RETURNING …]
//   MSSQL    UPDATE [TOP (n)] t SET … [OUTPUT …][FROM other][WHERE …]
//   SQLite   UPDATE [OR ROLLBACK|ABORT|REPLACE|FAIL|IGNORE] t SET … [FROM other][WHERE …]
//   Oracle   UPDATE t [alias] SET … [WHERE …]
function analyzeUpdate(kind: DbKind, m: MaskedSql, item: ImpactItem): void {
  item.op = "update";
  item.write = true;
  item.severity = 1;
  const hm = /^\s*update\s+(?:(?:low_priority|ignore|only)\s+|or\s+(?:rollback|abort|replace|fail|ignore)\s+|top\s*\(?\s*\d+\s*\)?\s+)*/i.exec(
    m.mask,
  );
  const headerEnd = hm ? hm[0].length : 0;
  const topHit = hm ? /\btop\s*\(?\s*(\d+)/i.exec(hm[0]) : null;
  const setIdx = findTopKeyword(m, /\bset\b/gi, headerEnd);
  if (setIdx < 0) {
    item.reason = "unparsed";
    return;
  }
  const target = cut(m, headerEnd, setIdx);
  item.targets = [target];
  // 頂層 WHERE：SET 子句裡的子查詢 WHERE 必在括號內（SQL 規定子查詢要加括號）→ depth>0
  // 自動跳過。這正是 sql.ts::isDangerousStatement 的判準，只是這裡保住了位移。
  const whereIdx = findTopKeyword(m, /\bwhere\b/gi, setIdx);
  item.hasWhere = whereIdx >= 0;
  if (!item.hasWhere) item.severity = 2;
  // 定位更新（WHERE CURRENT OF cur）沒有可重跑的述詞。
  if (whereIdx >= 0 && /^\s*current\s+of\b/i.test(m.mask.slice(whereIdx + 5))) {
    item.reason = "unparsed";
    return;
  }
  const bodyEnd = whereIdx >= 0 ? whereIdx : findTail(m, setIdx);
  let source = target;
  let confidence: ImpactConfidence = "exact";
  // PG / MSSQL / SQLite 的 `UPDATE t SET … FROM other`：其他來源要一起帶進計數，但
  // fan-out 會讓同一個目標列被算多次（要精確得用 COUNT(DISTINCT pk)，純函式拿不到 schema）
  // → 誠實標成上限，不假裝等號。
  const fromIdx = findTopKeyword(m, /\bfrom\b/gi, setIdx);
  if (fromIdx >= 0 && fromIdx < bodyEnd) {
    source = `${target}, ${cut(m, fromIdx + 4, bodyEnd)}`;
    confidence = "upperBound";
  }
  if (hasTopIn(m, /\bjoin\b|,/gi, headerEnd, setIdx)) confidence = "upperBound";
  const where = whereIdx >= 0 ? ` WHERE ${cut(m, whereIdx + 5, findTail(m, whereIdx + 5))}` : "";
  pushProbe(
    kind,
    item,
    firstTable(kind, target),
    source,
    where,
    {
      confidence,
      rowCap: findRowCap(m, whereIdx >= 0 ? whereIdx : setIdx) ?? (topHit ? Number(topHit[1]) : null),
    },
    firstTable(kind, target),
  );
}

// DELETE 的形狀（跨方言）：
//   MySQL  DELETE [LOW_PRIORITY][QUICK][IGNORE] a[, b] FROM a JOIN b … WHERE …
//   MSSQL  DELETE [TOP (n)] [FROM] a [OUTPUT …] [FROM a JOIN b …] WHERE …  ← 第二個 FROM 才是來源
//   PG     DELETE FROM [ONLY] t [AS x] [USING other] WHERE … [RETURNING …]
//   Oracle DELETE [FROM] t [alias] WHERE …
//   SQLite DELETE FROM t WHERE …
function analyzeDelete(kind: DbKind, m: MaskedSql, item: ImpactItem): void {
  item.op = "delete";
  item.write = true;
  item.severity = 1;
  const hm = /^\s*delete\s+(?:(?:low_priority|quick|ignore)\s+|top\s*\(?\s*\d+\s*\)?\s+)*/i.exec(m.mask);
  const headerEnd = hm ? hm[0].length : 0;
  const topHit = hm ? /\btop\s*\(?\s*(\d+)/i.exec(hm[0]) : null;
  const whereIdx = findTopKeyword(m, /\bwhere\b/gi, headerEnd);
  item.hasWhere = whereIdx >= 0;
  if (!item.hasWhere) item.severity = 2;
  if (whereIdx >= 0 && /^\s*current\s+of\b/i.test(m.mask.slice(whereIdx + 5))) {
    item.reason = "unparsed";
    return;
  }
  // 來源子句的結束點：WHERE 之前，但 T-SQL 的 `DELETE FROM t OUTPUT deleted.* WHERE …`
  // 會把 OUTPUT 夾在中間 —— 只看 WHERE 會把 OUTPUT 子句一起抄進 FROM，產出語法錯誤的探測。
  const bodyEnd = whereIdx >= 0 ? Math.min(whereIdx, findTail(m, headerEnd)) : findTail(m, headerEnd);
  const from1 = findTopKeyword(m, /\bfrom\b/gi, headerEnd);
  let confidence: ImpactConfidence = "exact";
  let source: string;
  let label: string;
  if (from1 < 0 || from1 >= bodyEnd) {
    // Oracle 的 `DELETE t WHERE …`（省略 FROM）。
    source = cut(m, headerEnd, bodyEnd);
    label = firstTable(kind, source);
  } else {
    const preFrom = cut(m, headerEnd, from1); // MySQL `DELETE a FROM a JOIN b` 的 a
    const from2 = findTopKeyword(m, /\bfrom\b/gi, from1 + 4);
    const usingIdx = findTopKeyword(m, /\busing\b/gi, from1 + 4);
    const hasFrom2 = from2 >= 0 && from2 < bodyEnd;
    const start = hasFrom2 ? from2 + 4 : from1 + 4;
    const hasUsing = usingIdx >= 0 && usingIdx > start && usingIdx < bodyEnd;
    const main = cut(m, start, hasUsing ? usingIdx : bodyEnd);
    source = hasUsing ? `${main}, ${cut(m, usingIdx + 5, bodyEnd)}` : main;
    label = firstTable(kind, preFrom || main);
    if (preFrom || hasFrom2 || hasUsing) confidence = "upperBound";
  }
  if (hasTopIn(m, /\bjoin\b/gi, headerEnd, bodyEnd)) confidence = "upperBound";
  item.targets = [label];
  const where = whereIdx >= 0 ? ` WHERE ${cut(m, whereIdx + 5, findTail(m, whereIdx + 5))}` : "";
  pushProbe(
    kind,
    item,
    label,
    source,
    where,
    {
      confidence,
      rowCap: findRowCap(m, whereIdx >= 0 ? whereIdx : headerEnd) ?? (topHit ? Number(topHit[1]) : null),
    },
    label,
  );
}

function analyzeTruncate(kind: DbKind, m: MaskedSql, item: ImpactItem): void {
  item.op = "truncate";
  item.write = true;
  item.irreversible = true;
  item.severity = 2;
  item.hasWhere = false;
  const hm = /^\s*truncate\s+(?:table\s+)?/i.exec(m.mask);
  const from = hm ? hm[0].length : 0;
  // 尾端選項：PG 的 RESTART / CONTINUE IDENTITY、CASCADE / RESTRICT、Oracle 的 DROP / REUSE STORAGE。
  const tailIdx = findTopKeyword(m, /\b(restart|continue|cascade|restrict|drop|reuse)\b/gi, from);
  const to = tailIdx < 0 ? m.src.length : tailIdx;
  const targets = splitTopLevel(m, from, to, ","); // PG 支援 TRUNCATE a, b
  item.targets = targets;
  if (!targets.length) {
    item.reason = "unparsed";
    return;
  }
  for (const tgt of targets) pushProbe(kind, item, firstTable(kind, tgt), tgt, "", {}, null);
}

function analyzeInsert(kind: DbKind, m: MaskedSql, item: ImpactItem, op: "insert" | "replace"): void {
  item.op = op;
  item.write = true;
  item.severity = 1;
  // REPLACE INTO 會先刪掉主鍵 / 唯一鍵衝突的既有列，前像救不回來。
  if (op === "replace") item.irreversible = true;
  const hm = /^\s*(?:insert|replace)\s+(?:(?:low_priority|delayed|high_priority|ignore)\s+|or\s+(?:rollback|abort|replace|fail|ignore)\s+)*(?:into\s+)?/i.exec(
    m.mask,
  );
  const headerEnd = hm ? hm[0].length : 0;
  const upsertIdx = findTopKeyword(m, /\bon\s+(?:duplicate|conflict)\b/gi, headerEnd);
  const tailIdx = findTopKeyword(m, /\b(?:returning|output)\b/gi, headerEnd);
  const end = Math.min(upsertIdx < 0 ? m.src.length : upsertIdx, tailIdx < 0 ? m.src.length : tailIdx);
  if (upsertIdx >= 0) item.staticExact = false; // upsert：實際落地列數與 tuple 數不一定相等
  const bodyIdx = findTopKeyword(m, /\b(values|value|select|with|set|default\s+values)\b/gi, headerEnd);
  // 目標表：header 之後到欄位清單 `(` 或語句主體為止。
  let targetEnd = bodyIdx >= 0 ? bodyIdx : end;
  for (let k = headerEnd; k < targetEnd; k++) {
    if (m.mask[k] === "(" && m.depth[k] === 0) {
      targetEnd = k;
      break;
    }
  }
  const target = cut(m, headerEnd, targetEnd);
  if (target) item.targets = [target];
  if (bodyIdx < 0) {
    item.reason = "unparsed";
    return;
  }
  const body = /^\w+(?:\s+values)?/i.exec(m.mask.slice(bodyIdx))?.[0].toLowerCase().replace(/\s+/g, " ") ?? "";
  if (body === "values" || body === "value") {
    // tuple 數 = 主體區間內「深度 0 的 (」個數。巢狀子查詢 (SELECT …) 在深度 ≥1，不會誤數。
    let tuples = 0;
    for (let k = bodyIdx; k < end; k++) if (m.mask[k] === "(" && m.depth[k] === 0) tuples++;
    item.staticRows = tuples;
    return;
  }
  if (body === "set" || body === "default values") {
    item.staticRows = 1;
    return;
  }
  if (body === "select" || body === "with") {
    const inner = cut(m, bodyIdx, end);
    // 來源本身含寫入（PG 可寫 CTE）→ 探測會真的寫入，直接拒絕。
    if (!isReadOnlyProbeSql(kind, inner)) {
      item.reason = "writingCte";
      return;
    }
    const p = makeProbe(kind, firstTable(kind, target), "", "", {
      confidence: item.staticExact ? "exact" : "upperBound",
      ready: {
        countSql: wrapCount(kind, inner),
        previewSql: `SELECT ${limitHead(kind, PREVIEW_ROWS)}* FROM (${inner}) ${
          kind === "oracle" ? "_sub" : "AS _sub"
        }${limitTail(kind, PREVIEW_ROWS)}`,
        undoSelect: null, // 新增的列尚不存在，沒有前像可保存
      },
    });
    if (p) item.probes.push(p);
    else item.reason = "unparsed";
    return;
  }
  item.reason = "unparsed";
}

function analyzeDrop(kind: DbKind, m: MaskedSql, item: ImpactItem): void {
  item.write = true;
  item.irreversible = true;
  const hm = /^\s*drop\s+(materialized\s+view|table|view|database|schema|index|sequence|procedure|function|trigger|type|user|role|extension|tablespace|synonym|package)\s+(?:if\s+exists\s+)?/i.exec(
    m.mask,
  );
  if (!hm) {
    item.op = "drop_object";
    item.severity = 2;
    item.reason = "unparsed";
    return;
  }
  const what = hm[1].toLowerCase().replace(/\s+/g, " ");
  const from = hm[0].length;
  if (what === "database" || what === "schema") {
    item.op = "drop_database";
    item.severity = 2;
    item.targets = [cut(m, from, m.src.length)];
    item.reason = "wholeDatabase";
    return;
  }
  if (what !== "table") {
    item.op = "drop_object";
    item.severity = 1;
    item.targets = [cut(m, from, m.src.length)];
    item.reason = "noRowImpact";
    return;
  }
  item.op = "drop_table";
  item.severity = 2;
  const tailIdx = findTopKeyword(m, /\b(cascade|restrict|purge)\b/gi, from);
  const to = tailIdx < 0 ? m.src.length : tailIdx;
  const targets = splitTopLevel(m, from, to, ",");
  item.targets = targets;
  if (!targets.length) {
    item.reason = "unparsed";
    return;
  }
  for (const tgt of targets) pushProbe(kind, item, firstTable(kind, tgt), tgt, "", {}, null);
}

function analyzeAlter(kind: DbKind, m: MaskedSql, item: ImpactItem): void {
  item.write = true;
  const hm = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?/i.exec(m.mask);
  if (!hm) {
    // ALTER VIEW / INDEX / USER / SEQUENCE… 不動既有資料列。
    item.op = "other";
    item.severity = 1;
    item.reason = "noRowImpact";
    return;
  }
  item.op = "alter_table";
  const from = hm[0].length;
  const actIdx = findTopKeyword(
    m,
    /\b(add|drop|modify|change|alter|rename|convert|engine|set|enable|disable|validate|comment|auto_increment)\b/gi,
    from,
  );
  const target = cut(m, from, actIdx < 0 ? m.src.length : actIdx);
  item.targets = [target];
  const actions = actIdx < 0 ? "" : m.mask.slice(actIdx);
  // 會讓既有資料消失的動作：刪欄、改型別（可能截斷）。純 ADD 不動既有資料。
  const destructive = /\b(drop|modify|change)\b/i.test(actions) || /\balter\s+(?:column\s+)?\S+\s+type\b/i.test(actions);
  item.irreversible = destructive;
  item.severity = destructive ? 2 : 1;
  if (!target) {
    item.reason = "unparsed";
    return;
  }
  pushProbe(kind, item, firstTable(kind, target), target, "", {}, null);
}

// ---- 對外入口 ----

/** 遮罩上的第一個關鍵字（小寫）；純註解 / 空白回空字串。 */
function firstKeyword(m: MaskedSql): string {
  const hit = /[a-zA-Z_]\w*/.exec(m.mask);
  return hit ? hit[0].toLowerCase() : "";
}

export function analyzeStatement(kind: DbKind, sql: string): ImpactItem {
  const item: ImpactItem = {
    index: 0,
    sql,
    op: "other",
    write: false,
    targets: [],
    hasWhere: null,
    staticRows: null,
    staticExact: true,
    irreversible: false,
    severity: 0,
    probes: [],
    reason: null,
  };
  const raw = sql.trim().replace(/;\s*$/, "").trim();
  if (!raw) return item;
  const m = maskSql(kind, raw);
  switch (firstKeyword(m)) {
    case "update":
      analyzeUpdate(kind, m, item);
      break;
    case "delete":
      analyzeDelete(kind, m, item);
      break;
    case "truncate":
      analyzeTruncate(kind, m, item);
      break;
    case "insert":
      analyzeInsert(kind, m, item, "insert");
      break;
    case "replace":
      analyzeInsert(kind, m, item, "replace");
      break;
    case "merge":
      // MATCHED / NOT MATCHED 兩支的語意不同（一支改、一支插），單一 COUNT 推不出來；
      // 硬算會低估或高估，寧可不給數字。
      item.op = "merge";
      item.write = true;
      item.irreversible = true;
      item.severity = 2;
      item.reason = "mergeBranches";
      break;
    case "drop":
      analyzeDrop(kind, m, item);
      break;
    case "alter":
      analyzeAlter(kind, m, item);
      break;
    case "with":
      if (/\b(insert|update|delete|merge)\b/i.test(m.mask)) {
        item.write = true;
        item.severity = 2;
        item.op = (/\b(insert|update|delete|merge)\b/i.exec(m.mask)?.[1].toLowerCase() as ImpactOp) ?? "other";
        item.reason = "writingCte";
      }
      break;
    case "create":
      item.write = true;
      item.op = "create";
      item.severity = 1;
      item.reason = "noRowImpact";
      break;
    case "call":
    case "exec":
    case "execute":
    case "do":
      item.write = true;
      item.severity = 1;
      item.reason = "procedureBody";
      break;
    case "load":
      item.write = true;
      item.severity = 1;
      item.reason = "bulkLoad";
      break;
    case "copy":
      // COPY t FROM '檔案' 是寫入；COPY t TO '檔案' 是匯出（讀）。
      if (findTopKeyword(m, /\bfrom\b/gi, 0) >= 0) {
        item.write = true;
        item.severity = 1;
        item.reason = "bulkLoad";
      }
      break;
    default:
      if (isWriteStatement(raw)) {
        item.write = true;
        item.severity = 1;
        // GRANT / REVOKE / RENAME / SET / 交易控制…：改的是權限 / 結構 / 連線狀態，不動資料列。
        item.reason = /^(grant|revoke|rename|comment|set|lock|begin|start|commit|rollback|savepoint|vacuum|reindex|cluster)\b/i.test(
          raw,
        )
          ? "noRowImpact"
          : "unparsed";
      }
      break;
  }
  // 未代入的具名參數：探測 SQL 送出去會直接語法錯誤（手動評估入口才會遇到，
  // execute() 走到這裡時參數已代入）。
  if (item.write && item.probes.length && extractNamedParams(raw).length > 0) {
    item.probes = [];
    item.reason = "unresolvedParams";
  }
  // 讀取型語句不列入影響評估。
  if (!item.write) {
    item.probes = [];
    item.reason = null;
  }
  if (item.probes.length) item.reason = null;
  return item;
}

export function analyzeBatch(kind: DbKind, statements: string[]): ImpactItem[] {
  return statements.map((s, i) => ({ ...analyzeStatement(kind, s), index: i }));
}

// ---- 彙總 ----

/** 實際影響列數：帶 LIMIT / TOP 上限時取 min。 */
export function effectiveRows(count: number, rowCap: number | null): number {
  return rowCap == null ? count : Math.min(count, rowCap);
}

export interface ImpactRowValue {
  /** 已探測到的列數；null＝尚未估算 / 失敗 / 無法估算。 */
  rows: number | null;
  confidence: ImpactConfidence;
  rowCap: number | null;
  fallbackWholeTable?: boolean;
}

/**
 * 合計。exact 只描述「已數到的那些」精不精確（有 upperBound 或整表保底就是 false）；
 * 待估項另由 pending 回報，兩者 UI 各自呈現，不混為一談。
 */
export function foldImpactTotals(values: ImpactRowValue[]): { total: number; exact: boolean; pending: number } {
  let total = 0;
  let exact = true;
  let pending = 0;
  for (const v of values) {
    if (v.rows === null) {
      pending++;
      continue;
    }
    total += effectiveRows(v.rows, v.rowCap);
    if (v.confidence === "upperBound" || v.fallbackWholeTable) exact = false;
  }
  return { total, exact, pending };
}
