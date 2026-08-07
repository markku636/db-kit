// SQL 靜態審查規則引擎 —— 對標 Redgate SQL Prompt 的 code analysis 與 SonarQube 的 SQL rules：
// 確定性、可重現、離線可用（不需要 claude CLI）、即時。回報的是「寫法 / 效能 / 風險」建議，
// 呈現在查詢面板的獨立「審查」分頁。
//
// 與 sql.ts 的 lintSqlStructure 是刻意分開的兩件事：那支只報「在任何合法 SQL 都必為錯」的結構
// 問題（未配對括號、未結束的字串 / 註解），因此可以無條件畫成編輯器裡的紅色波浪底線；本模組報的
// 是「可能有問題」的風格與效能建議 —— 同樣畫成底線只會變成永遠關不掉的噪音，故走獨立分頁。
//
// 全域設計原則：**寧可漏報，不要誤報**。使用者對「亮紅燈但其實沒事」的容忍度極低，一次誤報就會
// 讓整個審查分頁被永久忽略；漏掉一條建議則幾乎無感。因此每條規則都刻意收窄命中條件（函式白名單、
// 只認頂層括號深度、字面樣式要完全吻合），寧可放過寫法古怪的真問題，也不對似是而非的寫法開火。
import type { DbKind } from "./api";
import { splitSqlStatementsWithRanges, stripParens } from "./sql";
import { t } from "./i18n";

export type LintSeverity = "error" | "warn" | "info";

export interface LintFinding {
  id: string; // kebab-case 規則代號，如 "select-star"
  severity: LintSeverity;
  line: number; // 1-based
  col: number; // 1-based
  from: number; // 字元位移（與 CodeMirror 文件位移一致）
  to: number;
  message: string; // 已 t() 過
  hint: string; // 已 t() 過，講「該怎麼改」
}

export type LintRuleId =
  | "no-where-dml"
  | "missing-join-condition"
  | "non-sargable-func"
  | "leading-wildcard-like"
  | "not-in-subquery"
  | "or-chain"
  | "union-vs-union-all"
  | "select-star-with-join"
  | "nolock"
  | "implicit-cast-literal"
  | "select-star"
  | "order-by-without-limit"
  | "distinct-with-group-by"
  | "count-star-exists"
  | "cursor-loop";

// ---- 上限（沿 nlPrompt.ts 的常數慣例；審查在輸入時同步跑，不能讓病態輸入卡住 UI 執行緒）----
// 超過此長度視為「貼了一份傾印檔」，直接放棄審查。對外開放給 UI：
// lintSql 對「乾淨」與「太長沒審」都回空陣列，呼叫端要能分辨這兩件事才不會顯示成「沒問題」。
export const MAX_SQL_CHARS = 200_000;
const MAX_FINDINGS = 200; // 單次回報上限：列到第 200 條時使用者早已停止閱讀
const MAX_PATTERN_CHARS = 24; // 訊息中回顯 LIKE 樣式的字元上限

// 嚴重度（同時決定 LINT_RULES 的排列順序：error → warn → info）。
const SEVERITY: Record<LintRuleId, LintSeverity> = {
  "no-where-dml": "error",
  "missing-join-condition": "error",
  "non-sargable-func": "warn",
  "leading-wildcard-like": "warn",
  "not-in-subquery": "warn",
  "or-chain": "warn",
  "union-vs-union-all": "warn",
  "select-star-with-join": "warn",
  nolock: "warn",
  "implicit-cast-literal": "warn",
  "select-star": "info",
  "order-by-without-limit": "info",
  "distinct-with-group-by": "info",
  "count-star-exists": "info",
  "cursor-loop": "info",
};

// 規則標題以 thunk 保存而非常數字串：t() 讀的是當下語言，模組載入時就求值會把標題凍在啟動語言，
// 切語言後規則清單（審查分頁的篩選器 / 圖例）會留在舊語言。LINT_RULES 以 getter 對外仍是 string。
const RULE_TITLES: Record<LintRuleId, () => string> = {
  "no-where-dml": () => t("UPDATE / DELETE 沒有 WHERE"),
  "missing-join-condition": () => t("缺少表關聯條件（笛卡兒積）"),
  "non-sargable-func": () => t("條件對欄位套用函式"),
  "leading-wildcard-like": () => t("LIKE 以萬用字元開頭"),
  "not-in-subquery": () => t("NOT IN 子查詢"),
  "or-chain": () => t("同欄位的 OR 等值串"),
  "union-vs-union-all": () => t("UNION 而非 UNION ALL"),
  "select-star-with-join": () => t("JOIN 查詢使用 SELECT *"),
  nolock: () => t("NOLOCK / 未認可讀取"),
  "implicit-cast-literal": () => t("疑似隱式型別轉換"),
  "select-star": () => t("使用 SELECT *"),
  "order-by-without-limit": () => t("ORDER BY 沒有限制筆數"),
  "distinct-with-group-by": () => t("DISTINCT 與 GROUP BY 併用"),
  "count-star-exists": () => t("以 COUNT(*) 判斷有無"),
  "cursor-loop": () => t("游標 / 迴圈逐列處理"),
};

/** 規則總表（供審查分頁列出圖例 / 篩選器）。順序即 error → warn → info。 */
export const LINT_RULES: readonly { id: string; severity: LintSeverity; title: string }[] =
  (Object.keys(SEVERITY) as LintRuleId[]).map((id) => ({
    id,
    severity: SEVERITY[id],
    get title() {
      return RULE_TITLES[id]();
    },
  }));

// ---- 詞法遮罩 ----

// 把一段文字換成等長空白，但保留換行 —— 保長度才能把位移映回原字串，保換行才能算對行號。
function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/**
 * sql.ts 的 `stripCode` 的**保長度**版本：同一套掃描規則（字串 / 識別字 / 註解 / dollar-quote），
 * 但被剝掉的區段換成等長空白而非單一空白。
 *
 * 為什麼不直接用 stripCode：它把每個被剝掉的區段收成一個空白，索引因此與原字串對不上 ——
 * 只要語句前面有一段註解或字串，回報的 from / to 就會整段偏移，畫在編輯器上是錯的位置。
 * 本模組每條規則都要回報位移，故一律在這份等長遮罩上比對。
 * （sqlLint.test.ts 有一條測試把兩者的 token 序列釘在一起，避免日後其中一支改了規則而漂移。）
 *
 * 唯一**刻意**多做的一件事：連 mssql 的 `[識別字]` 也一起遮掉（stripCode 沒處理）。
 * 那是本模組專屬的需求，見下方註解。
 */
export function maskCode(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } j++; break; }
        j++;
      }
      out += blank(sql.slice(i, j)); i = j; continue;
    }
    if (two === "--") { let j = i; while (j < n && sql[j] !== "\n") j++; out += blank(sql.slice(i, j)); i = j; continue; }
    if (two === "/*") { let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "*/") j++; const e = Math.min(n, j + 2); out += blank(sql.slice(i, e)); i = e; continue; }
    if (two === "$$") { let j = i + 2; while (j < n && sql.slice(j, j + 2) !== "$$") j++; const e = Math.min(n, j + 2); out += blank(sql.slice(i, e)); i = e; continue; }
    // mssql 的 [識別字]：不遮掉的話兩個方向都會出錯 —— 欄位叫 [Union] / [Order By] 會被當成關鍵字而誤報，
    // 而 `UPDATE t SET [Where] = 1` 反倒因為看到 "where" 而漏報「無條件更新」（error 級的漏報最傷）。
    // 只認同一行內就閉合的 `]`，免得一個孤立的 `[` 把後面整份 SQL 都吃掉。
    if (ch === "[") {
      const close = sql.indexOf("]", i + 1);
      const nl = sql.indexOf("\n", i + 1);
      if (close > 0 && (nl < 0 || close < nl)) { out += blank(sql.slice(i, close + 1)); i = close + 1; continue; }
    }
    out += ch; i++;
  }
  return out;
}

// 每個字元所在的括號深度（左右括號本身算「外層」深度，這樣往回掃時 `(` 會落在較淺的深度而成為群組邊界）。
// 遮罩後字串 / 註解裡的括號已成空白，不會污染深度。
function parenDepths(code: string): number[] {
  const d = new Array<number>(code.length);
  let cur = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") { d[i] = cur; cur++; }
    else if (ch === ")") { if (cur > 0) cur--; d[i] = cur; }
    else d[i] = cur;
  }
  return d;
}

// 由原文的引號位置讀出字串字面值（'' 為轉義）。未結束的字串回 null —— 那是 lintSqlStructure
// 的守備範圍，本模組不猜。
function readStringLiteral(raw: string, at: number): { value: string; end: number } | null {
  if (raw[at] !== "'") return null;
  let v = "";
  let i = at + 1;
  while (i < raw.length) {
    if (raw[i] === "'") {
      if (raw[i + 1] === "'") { v += "'"; i += 2; continue; }
      return { value: v, end: i + 1 };
    }
    v += raw[i];
    i++;
  }
  return null;
}

/**
 * 從 at 起跳過空白後讀出字串字面值。
 * 允許 mssql 的 `N'…'` 與 postgres 的 `E'…'` 前綴 —— mssql 的字串字面值幾乎清一色寫成 N'…'，
 * 不吃這個前綴等於整個 mssql 方言的 LIKE 樣式與字面值比對規則全部靜默漏報。
 * 前綴必須緊貼引號（SQL 本來就不允許中間有空白），故不會把某個欄位名的尾字誤吃成前綴。
 */
function literalAfter(raw: string, at: number): { value: string; end: number } | null {
  let k = at;
  while (k < raw.length && /\s/.test(raw[k])) k++;
  if (/[NnEe]/.test(raw[k] ?? "") && raw[k + 1] === "'") k++;
  return readStringLiteral(raw, k);
}

// ---- 子句切割 ----

// 會結束一段 WHERE 條件的後續子句關鍵字。
const WHERE_END = /\b(group\s+by|order\s+by|having|limit|offset|window|union|intersect|except|returning|fetch|for\s+update)\b/gi;

/**
 * 各段 WHERE 條件的範圍（語句內位移，不含 WHERE 關鍵字本身）。
 * 子查詢的 WHERE 也會各自成為一段（其括號深度不同），因此靠深度就能區分「本層條件」與「子查詢條件」。
 */
function whereRegions(code: string, depth: number[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const re = /\bwhere\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const d = depth[m.index];
    const from = m.index + m[0].length;
    let to = code.length;
    for (let i = from; i < code.length; i++) if (depth[i] < d) { to = i; break; } // 括號收掉 → 本層結束
    const tail = code.slice(from, to);
    const te = new RegExp(WHERE_END.source, "gi");
    let tm: RegExpExecArray | null;
    while ((tm = te.exec(tail)) !== null) {
      if (depth[from + tm.index] === d) { to = from + tm.index; break; } // 同深度的後續子句 → 本層結束
    }
    out.push({ from, to });
  }
  return out;
}

// 第一個位於頂層（深度 0）的關鍵字。re 必須是 global。
function firstAtDepth0(code: string, depth: number[], re: RegExp): RegExpExecArray | null {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(code)) !== null) if (depth[m.index] === 0) return m;
  return null;
}

// ---- 單一語句的分析上下文 ----

interface Stmt {
  kind: DbKind;
  raw: string; // 語句原文（位移與 code 逐字對齊）
  code: string; // 等長遮罩：只剩「真正的程式碼」
  depth: number[];
  emit: (id: LintRuleId, from: number, to: number, message: string, hint: string) => void;
}

// ---- 規則實作 ----

// error：UPDATE / DELETE 頂層無 WHERE → 改到 / 刪掉全表。
function ruleNoWhereDml(s: Stmt): void {
  const m = /^(\s*)(update|delete)\b/i.exec(s.code);
  if (!m) return; // 只認「語句開頭就是 DML」：預存程序本體裡的 DELETE 交給人工審查，不冒誤報的險
  // 頂層才算數：UPDATE t SET a = (SELECT … WHERE …) 的 WHERE 在子查詢裡，去掉括號後才看得出沒有條件。
  const top = stripParens(s.code);
  if (/\bwhere\b/i.test(top)) return;
  // MySQL 的 `UPDATE … LIMIT n` / `DELETE … LIMIT n` 是刻意的分批處理，影響列數有上界，不是「改到全表」。
  if (/\blimit\b/i.test(top)) return;
  // T-SQL 的 `UPDATE p SET … FROM p JOIN s ON …` 與 MySQL 的 `UPDATE a JOIN b ON … SET …`：
  // 沒有 WHERE 是正常的，JOIN 的 ON 本身就是篩選條件，說它「影響每一列」是錯的。
  if (/\bjoin\b/i.test(top)) return;
  const kw = m[2].toUpperCase();
  s.emit(
    "no-where-dml",
    m[1].length,
    m[1].length + m[2].length,
    t("{kw} 沒有 WHERE 條件，會影響資料表的每一列", { kw }),
    t("補上 WHERE 限定範圍；若真的要清空整張表，請改用 TRUNCATE 並先確認已備份。"),
  );
}

// 一側的「欄位參照」。點號兩邊的識別字都允許缺席：被引號 / 中括號括起來的識別字遮罩後只剩空白，
// `` `a`.`id` `` 會變成 " . "，只剩那個點還看得見。少了這一條，凡是把識別字都加引號的查詢
// （GUI 工具產生的 SQL 幾乎都這樣，三種方言各有 ` " []）都會被判成沒有關聯條件而報笛卡兒積 ——
// 那是 error 級的誤報，殺傷力最大。反方向不會鬆掉：字面值（'abc' / 5）遮罩後不含點，
// 故 `col = 5` / `col = '5'` 仍然不會被當成表關聯。
const COL_REF = String.raw`(?:[A-Za-z_][\w$]*\s*\.\s*[\w$]*|\.\s*[\w$]*|[A-Za-z_][\w$]*)`;
// 兩個欄位參照相等 —— 只要 WHERE 裡出現一次就當作「有寫關聯條件」（刻意寬鬆，寧可漏報）。
const JOIN_EQ = new RegExp(`${COL_REF}\\s*=\\s*${COL_REF}`);

// error：逗號式多表但 WHERE 沒有任何等值關聯 → 笛卡兒積（列數相乘，常是打字漏掉條件）。
function ruleMissingJoinCondition(s: Stmt): void {
  if (!/^\s*select\b/i.test(s.code)) return; // 只審 SELECT：多表 DELETE / UPDATE 語法各家不同，不冒險
  const fm = firstAtDepth0(s.code, s.depth, /\bfrom\b/gi);
  if (!fm) return;
  const start = fm.index + fm[0].length;
  let end = s.code.length;
  const term = /\b(where|group\s+by|order\s+by|having|limit|offset|window|union|intersect|except|returning|fetch|into|join)\b/gi;
  term.lastIndex = start;
  let tm: RegExpExecArray | null;
  while ((tm = term.exec(s.code)) !== null) if (s.depth[tm.index] === 0) { end = tm.index; break; }
  const seg = s.code.slice(start, end);
  // 表函式 / LATERAL / Oracle DUAL 合法地以逗號串在 FROM 後面，且沒有「關聯條件」可寫，一律略過。
  if (/\b(lateral|unnest|generate_series|json_table|openjson|jsonb_to_recordset|xmltable|dual)\b/i.test(seg)) return;
  let commas = 0;
  for (let i = start; i < end; i++) if (s.code[i] === "," && s.depth[i] === 0) commas++;
  if (commas === 0) return;
  const hasEq = whereRegions(s.code, s.depth).some(
    (r) => (s.depth[r.from] ?? 0) === 0 && JOIN_EQ.test(s.code.slice(r.from, r.to)),
  );
  if (hasEq) return;
  s.emit(
    "missing-join-condition",
    fm.index,
    fm.index + fm[0].length,
    t("FROM 以逗號串接 {n} 張表，但 WHERE 沒有對應的關聯條件，結果會是笛卡兒積", { n: commas + 1 }),
    t("改寫成 JOIN … ON，或在 WHERE 補上兩表的等值關聯條件。"),
  );
}

// 對每段 WHERE 條件執行 fn（seg 為條件文字，offset 為它在語句內的起始位移）。
function forEachWhere(s: Stmt, fn: (seg: string, offset: number) => void): void {
  for (const r of whereRegions(s.code, s.depth)) fn(s.code.slice(r.from, r.to), r.from);
}

// 會讓索引失效的常見函式白名單。刻意用白名單而非「任何函式呼叫」：使用者自訂函式 / 表函式 /
// 型別建構子都長得像函式呼叫，全部開火必然誤報。
const NON_SARGABLE_FUNCS = [
  "year", "month", "day", "dayofmonth", "dayofweek", "dayofyear", "hour", "minute", "second",
  "week", "quarter", "weekday", "monthname", "date", "datepart", "datename", "dateadd", "datediff",
  "date_format", "str_to_date", "to_char", "to_date", "trunc", "extract", "unix_timestamp",
  "timestampdiff", "from_unixtime", "convert_tz",
  "upper", "lower", "ucase", "lcase", "trim", "ltrim", "rtrim", "substr", "substring", "mid",
  "left", "right", "concat", "concat_ws", "replace", "reverse", "lpad", "rpad", "format",
  "length", "len", "char_length", "character_length",
  "cast", "convert", "coalesce", "ifnull", "isnull", "nvl", "round", "floor", "ceil", "ceiling",
  "abs", "mod",
];
// `(^|[^\w$.])` 取代 lookbehind：確保 `myyear(` / `t.year(` 這種不會被當成 YEAR()。
// 括號內只允許 `[^()]*`，巢狀呼叫（CAST(GETDATE() AS DATE)）自動落空 —— 那時第一個運算元不是欄位。
const NON_SARGABLE_RE = new RegExp(
  `(^|[^\\w$.])(${NON_SARGABLE_FUNCS.join("|")})\\s*\\(([^()]*)\\)\\s*(<>|!=|<=|>=|=|<|>|\\bbetween\\b|\\blike\\b|\\bin\\b)`,
  "gi",
);
// 括號內第一個運算元必須是「裸欄位參照」，後面才允許逗號參數或 CAST 的 `AS 型別`。
// UPPER('abc') 遮罩後括號內只剩空白 → 不符 → 不開火（比較的是常數，索引無關）。
const FUNC_ARG_IS_COLUMN = /^\s*[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?\s*(?:,[\s\S]*|as\s[\s\S]*)?$/i;

// warn：WHERE 對欄位套函式 → 索引存的是原值，最佳化器無法用它比對函式結果，只能全表掃描。
function ruleNonSargableFunc(s: Stmt): void {
  forEachWhere(s, (seg, offset) => {
    const re = new RegExp(NON_SARGABLE_RE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg)) !== null) {
      if (!FUNC_ARG_IS_COLUMN.test(m[3])) continue;
      const fnStart = offset + m.index + m[1].length;
      const callEnd = s.code.indexOf(")", fnStart) + 1;
      const fn = m[2].toUpperCase();
      s.emit(
        "non-sargable-func",
        fnStart,
        callEnd > fnStart ? callEnd : fnStart + fn.length,
        t("WHERE 對欄位套用了 {fn}()，該欄位上的索引會失效", { fn }),
        t("把運算搬到條件的另一側，例如 YEAR(col) = 2024 改寫成 col >= '2024-01-01' AND col < '2025-01-01'。"),
      );
    }
  });
}

// warn：LIKE '%x' / '%x%' → B-Tree 索引依前綴排序，樣式沒有前綴就無從定位，只能逐列比對。
function ruleLeadingWildcardLike(s: Stmt): void {
  forEachWhere(s, (seg, offset) => {
    const re = /\bi?like\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg)) !== null) {
      // 讀樣式必須看**原文**：遮罩把字串換成了空白，在 code 上跳空白會直接跨過樣式本身。
      // 樣式必須是字面值；LIKE CONCAT('%', ?) 這種看不出來就不猜。
      const lit = literalAfter(s.raw, offset + m.index + m[0].length);
      if (!lit || !lit.value.startsWith("%")) continue;
      const pat = lit.value.length > MAX_PATTERN_CHARS ? `${lit.value.slice(0, MAX_PATTERN_CHARS)}…` : lit.value;
      s.emit(
        "leading-wildcard-like",
        offset + m.index,
        lit.end,
        t("LIKE 樣式以萬用字元開頭（{pat}），索引無法命中", { pat }),
        t("改成前綴比對（'abc%'）；真的需要「包含」語意時請改用全文索引 / 搜尋引擎。"),
      );
    }
  });
}

// warn：NOT IN (SELECT …) → 子查詢結果只要有一個 NULL，整個條件恆為 unknown，查詢會靜默回傳 0 列。
function ruleNotInSubquery(s: Stmt): void {
  const re = /\bnot\s+in\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.code)) !== null) {
    let k = m.index + m[0].length;
    while (k < s.code.length && /\s/.test(s.code[k])) k++;
    if (!/^select\b/i.test(s.code.slice(k, k + 10))) continue; // NOT IN (1, 2, 3) 沒有這個問題
    s.emit(
      "not-in-subquery",
      m.index,
      m.index + m[0].length,
      t("NOT IN 接子查詢：子查詢只要回傳一個 NULL，整個條件就恆為 unknown（結果 0 列）"),
      t("改用 NOT EXISTS（對 NULL 語意正確），或在子查詢加上 IS NOT NULL。"),
    );
  }
}

// 條件項最左側的「欄位 =」。只認單一等號：`a >= 1` / `a <> 1` / `a != 1` 都不會落入 IN 改寫。
const LEAD_EQ = /^[\s(]*([A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?)\s*=\s*/;
function leadEqColumn(term: string): string {
  // 條件項裡還留著 AND / OR，代表它整個是一組複合條件（`(a = 1 AND b = 2)`）而不是單一等值比較：
  // LEAD_EQ 會跳過前導括號直接讀到 a，於是 `(a=1 AND b>1) OR (a=2 AND b>2) OR (a=3 AND b>3)`
  // 會被數成「a 出現三次」而建議改寫成 a IN (1,2,3) —— 那會把 b 的條件整組弄丟，是實質錯誤的建議。
  // 這裡切出來的項已經在本層被 AND / OR 切開，殘留的連接詞必定來自更深的括號群組，故一律不採計。
  if (/\b(and|or)\b/i.test(term)) return "";
  const m = LEAD_EQ.exec(term);
  return m ? m[1].replace(/\s+/g, "").toLowerCase() : "";
}

// warn：同一欄位 3 個以上的 OR 等值 → 可讀性差，且部分最佳化器對長 OR 串會放棄索引改走全掃。
// 以「相同括號深度的 AND / OR」把條件切成項；只有被 OR 連續串起來的項算同一條鏈，
// 中間夾了 AND（或跨越括號群組邊界）就斷鏈 —— 否則 `(a=1 OR x=2) AND (a=3 OR y=4) AND (a=5 OR z=6)`
// 會被數成「a 出現 3 次」而誤報。另外只有「單純的等值比較」才計數，見 leadEqColumn。
function ruleOrChain(s: Stmt): void {
  for (const r of whereRegions(s.code, s.depth)) {
    const seg = s.code.slice(r.from, r.to);
    const dep = s.depth.slice(r.from, r.to);
    const ops: { at: number; end: number; op: string; d: number }[] = [];
    const re = /\b(and|or)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg)) !== null) {
      ops.push({ at: m.index, end: m.index + m[0].length, op: m[1].toLowerCase(), d: dep[m.index] });
    }
    const levels = [...new Set(ops.filter((o) => o.op === "or").map((o) => o.d))];
    for (const lv of levels) {
      const lvOps = ops.filter((o) => o.d === lv);
      if (lvOps.length === 0) continue;
      // 以該層的連接詞切出條件項；首項往回、末項往後掃到深度掉出本層為止（即所屬括號群組的邊界）。
      let gs = lvOps[0].at;
      while (gs > 0 && dep[gs - 1] >= lv) gs--;
      let ge = lvOps[lvOps.length - 1].end;
      while (ge < seg.length && dep[ge] >= lv) ge++;
      const bounds: { from: number; to: number }[] = [];
      let cursor = gs;
      for (const o of lvOps) { bounds.push({ from: cursor, to: o.at }); cursor = o.end; }
      bounds.push({ from: cursor, to: ge });

      let cols: string[] = [];
      let chainFrom = -1;
      let chainTo = -1;
      const add = (col: string, from: number, to: number) => {
        if (chainFrom < 0) chainFrom = from;
        chainTo = to;
        cols.push(col);
      };
      const flush = () => {
        const counts = new Map<string, number>();
        for (const c of cols) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
        for (const [col, n] of counts) {
          if (n < 3) continue;
          // 回報範圍收斂到非空白字元：使用者點擊 finding 會選取這段，範圍前後掛著空白很難看。
          // 只能依**原文**收邊 —— 在遮罩上收會把結尾的字串字面值（已成空白）一起吃掉。
          let a = chainFrom;
          let b = chainTo;
          while (a < b && /\s/.test(s.raw[r.from + a] ?? "")) a++;
          while (b > a && /\s/.test(s.raw[r.from + b - 1] ?? "")) b--;
          s.emit(
            "or-chain",
            r.from + a,
            r.from + b,
            t("同一組 OR 條件裡對同一欄位 {col} 做了 {n} 次等值比較", { col, n }),
            t("改寫成 {col} IN (…)：語意相同、可讀性較好，最佳化器也較容易挑到索引。", { col }),
          );
          break;
        }
        cols = [];
        chainFrom = -1;
        chainTo = -1;
      };
      for (let i = 0; i < bounds.length; i++) {
        const b = bounds[i];
        // 這一項若中途掉出本層深度，代表它橫跨了括號群組邊界：前半屬於目前鏈，後半是新鏈的開頭。
        let cut = -1;
        for (let k = b.from; k < b.to; k++) if (dep[k] < lv) cut = k;
        if (cut >= 0) {
          add(leadEqColumn(seg.slice(b.from, cut)), b.from, cut);
          flush();
          add(leadEqColumn(seg.slice(cut + 1, b.to)), cut + 1, b.to);
        } else {
          add(leadEqColumn(seg.slice(b.from, b.to)), b.from, b.to);
        }
        if (lvOps[i]?.op === "and") flush(); // AND 斷鏈
      }
      flush();
    }
  }
}

// warn：UNION 會為了去重而排序整個結果集；多數情境兩側本來就不重疊，白付一次排序成本。
function ruleUnionVsUnionAll(s: Stmt): void {
  const re = /\bunion\b(\s+all\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.code)) !== null) {
    if (m[1]) continue;
    s.emit(
      "union-vs-union-all",
      m.index,
      m.index + 5,
      t("UNION 會為了去除重複列而排序整個結果集"),
      t("確認兩側結果本來就不會重複的話，改用 UNION ALL。"),
    );
  }
}

/**
 * 這個 SELECT **自己這一層**有沒有 JOIN：同一括號深度，且不跨越集合運算子。
 * 不能拿整句 `/\bjoin\b/` 判斷 —— 子查詢裡或 UNION 另一側的 JOIN 與這個 SELECT * 的欄位撞名無關，
 * 那樣會把單表查詢的 SELECT * 從 info 誤升成 warn，還宣稱「兩表同名欄位會互相覆蓋」（實際只有一張表）。
 */
function hasJoinInScope(s: Stmt, at: number): boolean {
  const d = s.depth[at] ?? 0;
  let end = s.code.length;
  for (let i = at; i < s.code.length; i++) if (s.depth[i] < d) { end = i; break; } // 括號收掉 → 本層結束
  let m: RegExpExecArray | null;
  const setOp = /\b(union|intersect|except)\b/gi;
  const head = s.code.slice(at, end);
  while ((m = setOp.exec(head)) !== null) {
    if (s.depth[at + m.index] === d) { end = at + m.index; break; } // 同深度的集合運算子 → 換另一個查詢區塊
  }
  const re = /\bjoin\b/gi;
  const scope = s.code.slice(at, end);
  while ((m = re.exec(scope)) !== null) if (s.depth[at + m.index] === d) return true;
  return false;
}

// info / warn：SELECT *。同一層有 JOIN 時升級成 warn（欄位撞名 + 傳輸與記憶體浪費），否則只是建議。
function ruleSelectStar(s: Stmt): void {
  // 允許中間夾 mssql 的 TOP n / TOP (n) PERCENT，否則 `SELECT TOP (10) *` 會整條漏掉。
  const re = /\bselect\b(?:\s+(?:all|distinct)\b)?(?:\s+top\s*\(?\s*\d+\s*\)?(?:\s+percent\b)?)?\s*\*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.code)) !== null) {
    // EXISTS (SELECT * …) 是標準慣用法：最佳化器根本不取欄位，開火只會製造噪音。
    if (/\bexists\s*\(\s*$/i.test(s.code.slice(Math.max(0, m.index - 40), m.index))) continue;
    const from = m.index;
    const to = m.index + m[0].length;
    if (hasJoinInScope(s, m.index)) {
      s.emit(
        "select-star-with-join",
        from,
        to,
        t("有 JOIN 的查詢使用 SELECT *：兩表同名欄位會互相覆蓋，也多傳了用不到的欄位"),
        t("明確列出需要的欄位，並以表別名限定（a.id, b.name）。"),
      );
    } else {
      s.emit(
        "select-star",
        from,
        to,
        t("SELECT * 會取回所有欄位；日後資料表加欄位時，這句查詢的行為會跟著改變"),
        t("列出實際需要的欄位，減少傳輸量並讓涵蓋索引有機會生效。"),
      );
    }
  }
}

// warn（僅 mssql）：NOLOCK / READ UNCOMMITTED 允許讀到未提交的資料，還可能重複讀或漏讀已存在的列。
function ruleNolock(s: Stmt): void {
  if (s.kind !== "mssql") return;
  const re = /\b(nolock|readuncommitted|read\s+uncommitted)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.code)) !== null) {
    s.emit(
      "nolock",
      m.index,
      m.index + m[0].length,
      t("{kw} 為未認可讀取：可能讀到未提交的資料，也可能重複讀或漏讀已存在的列", { kw: m[0].toUpperCase() }),
      t("改用 READ COMMITTED SNAPSHOT 隔離層級；只有在明知會讀到髒資料且可接受時才保留。"),
    );
  }
}

// 疑似「數值欄位被寫成字串」的字面值。三道獨立的保守條件，全過才算數（拿不到 schema，只能靠字面樣式）：
//   1. 純數字 —— 混了字母就是普通字串比較。
//   2. 無前導零 —— '007' / '0912345678' 幾乎必然是補零代碼或電話，那本來就是字串欄位，加引號才對。
//   3. 至少兩位數 —— 單一位數（'0' / '1' / '2'）壓倒性地是 CHAR(1) / ENUM 的狀態旗標，
//      而真正會痛的隱式轉換（整表轉型 + 索引失效）幾乎都發生在多位數的 ID / 金額上。
const NUMERIC_LOOKING = /^[1-9]\d{1,17}$/;
// 名字本身就在講「編號 / 代碼」的欄位一律略過：它們是最常見的 zero-padded 字串欄，
// 這條規則拿不到 schema，只能靠命名把最大宗的誤報壓下去。
const CODE_LIKE_COLUMN = /(^|_)(no|code|sn|zip|zipcode|postcode|phone|tel|mobile|barcode|serial|account|card|uuid|guid)$/i;
// 日期時間欄位（含 created_at / OrderDate / log_date / ym 這類駝峰與底線寫法）。
const TEMPORAL_COLUMN = /(^|_)(at|dt|ts|ym|ymd|day|month|year)$|(date|time|stamp)$/i;
// yyyymm / yyyymmdd 樣式的字面值：`= '20240101'` 幾乎必然是在跟日期欄位比較，不是數值 ID。
const DATE_LOOKING = /^(19|20)\d{2}(\d{2}){1,2}$/;

// warn：`col = '123'` —— 欄位若是數值型別，資料庫會把整欄轉型再比較，索引因此失效（MySQL 尤甚）。
function ruleImplicitCastLiteral(s: Stmt): void {
  forEachWhere(s, (seg, offset) => {
    const re = /(^|[^\w$.])([A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?)\s*(<>|!=|<=|>=|=|<|>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg)) !== null) {
      // 同 leading-wildcard-like：讀字面值看原文，否則會跳過被遮罩成空白的字面值本身。
      const lit = literalAfter(s.raw, offset + m.index + m[0].length);
      if (!lit || !NUMERIC_LOOKING.test(lit.value)) continue;
      const col = m[2].replace(/\s+/g, "");
      const tail = col.split(".").pop() ?? col;
      if (CODE_LIKE_COLUMN.test(tail)) continue;
      // 日期時間欄位：這條規則的建議（去掉引號）套在日期欄位上是錯的 —— 多數資料庫會直接語法 / 型別錯誤，
      // MySQL 雖然吃得下也是另一種問題。欄名或字面值任一方看起來像日期就退場。
      if (TEMPORAL_COLUMN.test(tail) || DATE_LOOKING.test(lit.value)) continue;
      s.emit(
        "implicit-cast-literal",
        offset + m.index + m[1].length,
        lit.end,
        t("{col} 與純數字字串 '{v}' 比較：欄位若為數值型別會發生隱式轉換", { col, v: lit.value }),
        t("數值欄位請去掉引號（{col} = {v}）；欄位本來就是字串型別則可忽略。", { col, v: lit.value }),
      );
    }
  });
}

// info：頂層 ORDER BY 但沒有任何限制筆數的子句 → 伺服器得排完整個結果集才回第一列。
function ruleOrderByWithoutLimit(s: Stmt): void {
  // 只看頂層：視窗函式 OVER(ORDER BY …)、GROUP_CONCAT(… ORDER BY …) 都在括號內，深度 > 0。
  const om = firstAtDepth0(s.code, s.depth, /\border\s+by\b/gi);
  if (!om) return;
  const limited =
    /\blimit\b/i.test(s.code) || // mysql / postgres / sqlite
    /\bselect\s+(?:all\s+|distinct\s+)?top\b/i.test(s.code) || // mssql
    /\bfetch\s+(first|next)\b/i.test(s.code) || // oracle 12c+ / mssql / postgres
    /\brownum\b/i.test(s.code); // oracle 11g
  if (limited) return;
  s.emit(
    "order-by-without-limit",
    om.index,
    om.index + om[0].length,
    t("有 ORDER BY 卻沒有限制筆數：資料庫必須排序整個結果集才能回傳第一列"),
    t("加上 LIMIT / TOP / FETCH FIRST n ROWS ONLY；只是要看資料的話取前幾百列就夠。"),
  );
}

// info：DISTINCT 與 GROUP BY 併用 —— GROUP BY 本身已經讓每組只剩一列，DISTINCT 通常是多餘的排序成本；
// 若真的還會重複，代表 SELECT 清單有沒被分組的欄位，那是查詢寫錯而不是該加 DISTINCT。
function ruleDistinctWithGroupBy(s: Stmt): void {
  const dm = firstAtDepth0(s.code, s.depth, /\bselect\s+distinct\b/gi);
  if (!dm) return;
  const gm = firstAtDepth0(s.code, s.depth, /\bgroup\s+by\b/gi);
  if (!gm) return;
  s.emit(
    "distinct-with-group-by",
    dm.index,
    dm.index + dm[0].length,
    t("DISTINCT 與 GROUP BY 同時出現，其中一個通常是多餘的"),
    t("先確認分組鍵；若分組後仍有重複，多半是 SELECT 清單含了未分組的欄位，應修正查詢而非加 DISTINCT。"),
  );
}

// info：COUNT(*) > 0 / = 0 → 得數完全部符合的列；EXISTS 找到第一列就能短路離開。
function ruleCountStarExists(s: Stmt): void {
  const re = /\bcount\s*\(\s*\*\s*\)\s*(<>|!=|>=|<=|>|<|=)\s*(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.code)) !== null) {
    const op = m[1];
    const n = Number(m[2]);
    const isExistence =
      ((op === ">" || op === "=" || op === "<>" || op === "!=") && n === 0) ||
      ((op === ">=" || op === "<") && n === 1);
    if (!isExistence) continue;
    s.emit(
      "count-star-exists",
      m.index,
      m.index + m[0].length,
      t("用 COUNT(*) {op} {n} 判斷「有沒有資料」，必須數完所有符合的列", { op, n }),
      t("改用 EXISTS / NOT EXISTS，找到第一列就能短路離開；若是接在 GROUP BY 後的 HAVING COUNT(*) > 0，該條件恆真可直接刪掉。"),
    );
  }
}

// 游標 / 逐列迴圈的特徵。刻意用「兩個詞連在一起」的樣式而非單一 CURSOR / FETCH，
// 免得 `OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY` 或名為 cursor 的欄位被誤判。
const CURSOR_PATTERNS = [
  /\bcursor\s+for\b/i, // mssql / postgres：DECLARE c CURSOR FOR SELECT …
  /\bcursor\s+[\w$#]+\s+is\b/i, // oracle PL/SQL：CURSOR c IS SELECT …
  /\bfetch\s+next\s+from\b/i, // 逐列取值（`FETCH NEXT n ROWS ONLY` 沒有 FROM，不會誤中）
  /\bwhile\s+@@fetch_status\b/i, // mssql 的游標迴圈慣用寫法
  /\bfor\s+[\w$#]+\s+in\s*\(\s*select\b/i, // oracle PL/SQL 的隱式游標迴圈：FOR rec IN (SELECT …) LOOP
];
// 刻意**不**把「任何 WHILE 迴圈」算進來：分批 DELETE / UPDATE（每圈處理一萬列）也是 WHILE，
// 而那正是我們會建議的寫法 —— 對它開火等於教使用者把對的事改成錯的。

// info：游標逐列處理在關聯式資料庫幾乎恆比集合運算慢一到兩個數量級（每列一次來回 + 逐列鎖）。
function ruleCursorLoop(s: Stmt): void {
  if (s.kind !== "mssql" && s.kind !== "oracle" && s.kind !== "postgres") return;
  for (const p of CURSOR_PATTERNS) {
    const m = p.exec(s.code);
    if (!m) continue;
    s.emit(
      "cursor-loop",
      m.index,
      m.index + m[0].length,
      t("以游標 / 迴圈逐列處理：每列都要一次來回與鎖定，通常比集合運算慢一到兩個數量級"),
      t("改寫成單一 UPDATE / INSERT … SELECT / MERGE 等集合運算；真的需要逐列時請限縮批次大小。"),
    );
    return; // 一句只報一次，避免同一段游標程式碼刷屏
  }
}

const RULES: ((s: Stmt) => void)[] = [
  ruleNoWhereDml,
  ruleMissingJoinCondition,
  ruleNonSargableFunc,
  ruleLeadingWildcardLike,
  ruleNotInSubquery,
  ruleOrChain,
  ruleUnionVsUnionAll,
  ruleSelectStar,
  ruleNolock,
  ruleImplicitCastLiteral,
  ruleOrderByWithoutLimit,
  ruleDistinctWithGroupBy,
  ruleCountStarExists,
  ruleCursorLoop,
];

// ---- 行列換算 ----

function lineStarts(sql: string): number[] {
  const starts = [0];
  for (let i = 0; i < sql.length; i++) if (sql[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineColOf(starts: number[], off: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, col: off - starts[lo] + 1 };
}

/**
 * 對一份（可能含多條語句的）SQL 做靜態審查。
 * 逐句分析（子句判斷才不會跨語句串味），位移一律換算回整份文件的絕對位移，結果依 from 排序。
 */
export function lintSql(kind: DbKind, sql: string): LintFinding[] {
  if (!sql || sql.length > MAX_SQL_CHARS) return [];
  const findings: LintFinding[] = [];
  const seen = new Set<string>(); // 同一規則同一位置只報一次
  const starts = lineStarts(sql);

  for (const span of splitSqlStatementsWithRanges(sql)) {
    const code = maskCode(span.text);
    const stmt: Stmt = {
      kind,
      raw: span.text,
      code,
      depth: parenDepths(code),
      emit: (id, from, to, message, hint) => {
        if (findings.length >= MAX_FINDINGS) return;
        const abs = span.from + from;
        const key = `${id}@${abs}`;
        if (seen.has(key)) return;
        seen.add(key);
        const { line, col } = lineColOf(starts, abs);
        findings.push({ id, severity: SEVERITY[id], line, col, from: abs, to: span.from + to, message, hint });
      },
    };
    for (const rule of RULES) rule(stmt);
  }

  findings.sort((a, b) => a.from - b.from || a.to - b.to || a.id.localeCompare(b.id));
  return findings;
}
