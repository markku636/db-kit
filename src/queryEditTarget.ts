// 從一段 SELECT 推出「可以安全寫回的單一資料表」。
//
// 這裡的預設是「看不懂就不給編輯」：猜錯的代價是把 UPDATE 打到別張表 / 別一列上，猜保守的代價
// 只是使用者得回資料表分頁去改。所以只認最單純的形狀 —— 單一 FROM 表，沒有 JOIN、逗號多表、
// 子查詢、UNION、GROUP BY、DISTINCT、CTE，也不是多語句批次。
//
// 欄位別名 / 運算式不在這裡擋：呼叫端會拿結果欄名去比對實體欄位清單，對不上就整個結果集不給編輯
//（那份比對同時也擋掉了 `SELECT MAX(x)` 這種沒有 GROUP BY 的聚合）。

export interface EditTarget {
  /** FROM 上顯式寫出的庫 / schema（`db.tbl`）；沒寫則為 null，由呼叫端沿用「目前資料庫」。 */
  database: string | null;
  table: string;
}

interface Tok {
  /** 識別字已去引號；關鍵字比對一律用 lower。 */
  text: string;
  lower: string;
  /** quoted＝被 `` `x` `` / `"x"` / `[x]` 包起來的識別字（不參與關鍵字比對）。 */
  quoted: boolean;
}

// FROM 之後遇到這些字就代表表名部分結束。
const FROM_STOP = new Set([
  "where", "order", "limit", "offset", "fetch", "for", "window", "union", "group",
  "having", "into", "procedure", "lock", "option", "with", "qualify", "connect", "start", "sample",
]);

// 出現在頂層就直接放棄的字：多表 / 集合運算 / 分組 / 去重 / SELECT INTO。
const REJECT = new Set([
  "join", "union", "intersect", "except", "minus", "distinct", "distinctrow",
  "into", "group", "having", "straight_join", "natural", "cross", "apply", "using",
]);

/** 切詞：略過空白與註解，字串常值收成單一 token，引號識別字去引號後標記 quoted。 */
function tokenize(sql: string): Tok[] | null {
  const out: Tok[] = [];
  const n = sql.length;
  let i = 0;
  const push = (text: string, quoted: boolean) => out.push({ text, lower: text.toLowerCase(), quoted });
  while (i < n) {
    const ch = sql[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { i++; continue; }
    // 行註解：-- 或 #（MySQL）
    if ((ch === "-" && sql[i + 1] === "-") || ch === "#") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return null; // 註解沒收尾＝這段 SQL 本來就不完整
      i = end + 2;
      continue;
    }
    // 字串常值：內容不解析，整段當一個 token（'' 與 \' 皆視為跳脫）。
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      push("'", false); // 內容無關，只要留一個「這裡有東西」的占位
      continue;
    }
    // 引號識別字：`x` / "x" / [x]
    if (ch === "`" || ch === '"' || ch === "[") {
      const close = ch === "`" ? "`" : ch === '"' ? '"' : "]";
      let j = i + 1;
      let val = "";
      while (j < n) {
        if (sql[j] === close) {
          if (sql[j + 1] === close && close !== "]") { val += close; j += 2; continue; } // `` / "" 跳脫
          break;
        }
        val += sql[j];
        j++;
      }
      if (j >= n) return null;
      push(val, true);
      i = j + 1;
      continue;
    }
    // 一般識別字 / 數字（點號另成一顆 token，`db.tbl` 才拆得出兩段名稱）。
    if (/[A-Za-z0-9_$@\u0080-\uFFFF]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$@\u0080-\uFFFF]/.test(sql[j])) j++;
      push(sql.slice(i, j), false);
      i = j;
      continue;
    }
    push(ch, false);
    i++;
  }
  return out;
}

export function parseEditTarget(sql: string): EditTarget | null {
  const toks = tokenize(sql ?? "");
  if (!toks || toks.length === 0) return null;
  if (toks[0].quoted || toks[0].lower !== "select") return null;

  // 多語句批次不處理：分號只允許出現在最後一顆 token。
  for (let k = 0; k < toks.length - 1; k++) if (!toks[k].quoted && toks[k].text === ";") return null;

  let depth = 0;
  let fromAt = -1;
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.quoted) continue;
    if (tk.text === "(") { depth++; continue; }
    if (tk.text === ")") { depth--; continue; }
    if (depth !== 0) continue;
    if (REJECT.has(tk.lower)) return null;
    if (fromAt < 0 && tk.lower === "from") fromAt = k;
  }
  if (fromAt < 0) return null;

  // FROM 到下一個頂層關鍵字之間就是表名（＋可選別名）。
  const parts: Tok[] = [];
  for (let k = fromAt + 1; k < toks.length; k++) {
    const tk = toks[k];
    if (!tk.quoted && (FROM_STOP.has(tk.lower) || tk.text === ";")) break;
    parts.push(tk);
  }
  if (parts.length === 0) return null;
  // 括號＝衍生表 / 子查詢；逗號＝隱式多表；兩者都不給。
  for (const p of parts) if (!p.quoted && (p.text === "(" || p.text === ")" || p.text === "," || p.text === "'")) return null;

  const isName = (tk: Tok | undefined) => !!tk && (tk.quoted || /^[A-Za-z_$@\u0080-\uFFFF][\w$@\u0080-\uFFFF]*$/.test(tk.text));
  if (!isName(parts[0])) return null;

  let database: string | null = null;
  let table = parts[0].text;
  let rest = 1;
  if (parts[1] && !parts[1].quoted && parts[1].text === "." && isName(parts[2])) {
    database = parts[0].text;
    table = parts[2].text;
    rest = 3;
    // 三段式名稱（db.schema.tbl）指到哪一層要看驅動，不猜。
    if (parts[3] && !parts[3].quoted && parts[3].text === ".") return null;
  }

  // 剩下的只能是別名：`t` 或 `AS t`。其餘（表值函式參數、hint…）一律放棄。
  const tail = parts.slice(rest);
  if (tail.length === 0) return { database, table };
  if (tail.length === 1 && isName(tail[0])) return { database, table };
  if (tail.length === 2 && !tail[0].quoted && tail[0].lower === "as" && isName(tail[1])) return { database, table };
  return null;
}
