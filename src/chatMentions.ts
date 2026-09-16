// 對話輸入框的 `@` 提及：解析 → 展開成預先烘焙好的上下文 → 交代帶了什麼、沒帶什麼。
//
// 為什麼要有這層：助手雖然有唯讀資料庫工具可以自己查，但「自己查」要多花一到兩個回合，
// 而且它得先猜表名。使用者打 `@orders` 時已經明講了要看哪張表——直接把結構烘進 prompt
// 比讓模型繞一圈便宜得多。反過來，凡是**沒帶成**的提及一律要在上下文裡明說（見 skipped），
// 靜默丟掉一張表的後果不是「模型少知道一件事」，而是「模型自己編一張出來」。
//
// 本模組是純邏輯（不 import React、不碰 DOM），所有夾上限的工具沿用 aiReview.ts 那套，
// 不另立一份——兩份夾行邏輯必然漂移（一邊補了收尾圍籬、另一邊沒有，就是 prompt 壞掉）。
import { api, KIND_META, type ColumnInfo, type DbKind, type IndexInfo } from "./api";
import { clipMarkdown, clipTableLines, fencedClipBlock, joinLines } from "./aiReview";
import type { EditorSnapshot, MentionChip, MentionKind, MentionRef } from "./chatTypes";
import { replyLanguageLine, t } from "./i18n";
import { resultToMarkdown } from "./sql";

// ---- 文法 ----

/**
 * `@` 的左邊界。字串開頭、空白，或這幾個標點才算數——**這一關就是 `user@example.com`
 * 不會被當成提及的唯一理由**（`r` 不是邊界字元）。少了它，任何貼進來的 email、
 * 套件的 scope 名稱、Python decorator 都會變成假提及，然後上下文裡塞滿不存在的表。
 *
 * 半形 `([,;:` 之外同時收全形對應字（`（【「，、；：`）：本 app 的輸入絕大多數是中文，
 * 「（見 @orders）」這種寫法若不認全形括號，使用者只會覺得 @ 功能時靈時不靈。
 */
const BOUNDARY = /[\s([,;:：（【「，、；]/;

/**
 * 一個提及 token。名稱有兩種寫法：
 * - 雙引號包住的一段（可含空白 / 中文 / 斜線）——含空白的表名或檔名只有這條路。
 * - 裸名：先用寬鬆的字元類吃下來，再依前綴收斂（見 narrowBare），因為 `file:` 允許 `/`
 *   與多個 `.`，而表名只允許一個 `.`（`庫.表`）。兩套規則塞進同一條 regex 只會沒人看得懂。
 */
const TOKEN_RE = /@(?:(table|db|file):)?(?:"([^"\n]+)"|([A-Za-z0-9_$./-]+))/g;

/**
 * 裸寫時被保留的字。用 Map 而非物件字面值：物件查 `@constructor` / `@toString` 會命中
 * Object.prototype 上的東西而變成 truthy，那張表就會被解析成一個函式當 kind。
 * 真的有叫 query 的表時，寫 `@table:query` 或 `@"query"` 都能繞過。
 */
const RESERVED = new Map<string, MentionKind>([
  ["query", "query"],
  ["result", "result"],
  ["error", "error"],
]);

/** 裸名依前綴收斂到合法的形狀；回空字串表示這個 token 不成立。 */
function narrowBare(raw: string, isFile: boolean): string {
  // 檔名允許 `/` 與多個 `.`，但結尾的 `.` / `/` 幾乎都是句讀而非檔名的一部分
  // （「請看 @file:report.sql.」）——留著路徑就打不開，然後整段內容靜默消失。
  if (isFile) return raw.replace(/[./]+$/, "");
  // 表名最多一個 `.`（`庫.表`）。多出來的部分不吃，免得把後面接的句子一起吞進表名。
  return /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)?/.exec(raw)?.[0] ?? "";
}

/**
 * 解析出所有提及，附精確的字元位移（供輸入框把 token 換成 chip、或送出時改寫顯示文字）。
 *
 * 不會產生 kind = "run" 的 ref：那種提及是面板依「助手剛跑過的查詢」自己組出來的
 * （內容夾在 payload 裡），不是打字打出來的。
 */
export function parseMentions(text: string): MentionRef[] {
  const out: MentionRef[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const at = m.index;
    if (at > 0 && !BOUNDARY.test(text[at - 1])) continue;
    const prefix = m[1] as "table" | "db" | "file" | undefined;
    const quoted = m[2] as string | undefined;
    let name: string;
    let to: number;
    if (quoted !== undefined) {
      name = quoted;
      to = at + m[0].length;
    } else {
      name = narrowBare(m[3], prefix === "file");
      if (!name) continue;
      // 收斂掉的尾巴要從位移扣回來，否則輸入框改寫時會把後面那個字一起吃掉。
      to = at + m[0].length - (m[3].length - name.length);
    }
    const base = { raw: text.slice(at, to), from: at, to };
    if (prefix === "db") {
      out.push({ kind: "db", ...base, db: name });
      continue;
    }
    if (prefix === "file") {
      out.push({ kind: "file", ...base, path: name });
      continue;
    }
    // 保留字只在「裸寫且無前綴」時成立。加引號等同明講「這是個名字」，
    // 所以 `@"result"` 指的是那張表，不是查詢結果。
    const reserved = prefix || quoted !== undefined ? undefined : RESERVED.get(name);
    if (reserved) {
      out.push({ kind: reserved, ...base });
      continue;
    }
    // 引號同樣關掉 `庫.表` 的拆分：使用者已經把整串框起來了，那就是完整的名字。
    const dot = quoted !== undefined ? -1 : name.indexOf(".");
    out.push(
      dot > 0
        ? { kind: "table", ...base, db: name.slice(0, dot), table: name.slice(dot + 1) }
        : { kind: "table", ...base, db: null, table: name },
    );
  }
  return out;
}

/** 提及在 UI / 純文字裡的顯示名。chips 與 stripMentions 共用同一份，免得兩處措辭漂移。 */
function labelOf(ref: MentionRef): string {
  switch (ref.kind) {
    case "db":
      return ref.db ?? "";
    case "file":
      return ref.path ?? "";
    case "query":
      return t("編輯器 SQL");
    case "result":
      return t("查詢結果");
    case "error":
      return t("最近一次錯誤");
    case "run":
      return t("執行結果");
    default:
      return ref.db ? `${ref.db}.${ref.table ?? ""}` : ref.table ?? "";
  }
}

/**
 * 把 token 換回純名字，供送出前的顯示文字與歷史記錄使用（`@table:orders` → `orders`）。
 *
 * 由後往前套用：每次替換都會改變後面所有字元的位移，從前面改的話第二個提及就切錯位置。
 * 這裡自己排序而非相信呼叫端：refs 常常是過濾過的子集，順序不保證還在。
 */
export function stripMentions(text: string, refs: MentionRef[]): string {
  let out = text;
  for (const ref of [...refs].sort((a, b) => b.from - a.from)) {
    if (ref.from < 0 || ref.to > out.length || ref.from >= ref.to) continue;
    out = out.slice(0, ref.from) + labelOf(ref) + out.slice(ref.to);
  }
  return out;
}

// ---- 上限 ----
// 每一段各自夾一次，總量再夾一次。只夾總量的話，一個 8000 字的 `@file` 就能把後面的
// `@result`（真正要被解讀的東西）整段擠掉；只夾單段的話，十個 `@table` 照樣爆掉上下文。
export const MENTION_BUDGET = 12 * 1024;
export const MAX_TABLE_CHARS = 2000;
export const MAX_RESULT_ROWS = 30;
export const MAX_RESULT_CHARS = 4096;
export const MAX_FILE_CHARS = 8192;
export const MAX_QUERY_CHARS = 8000;
export const MAX_DB_TABLES = 200;
/** 資料庫表名清單的字元上限（沿 nlPrompt.ts 的 3000）：200 個超長表名也塞不爆一段。 */
const MAX_DB_LIST_CHARS = 3000;

/**
 * 展開順序：便宜的先進場。
 *
 * 這個順序就是預算的優先序——排前面的先吃預算。error / run / query 完全不必連線（內容已在
 * 手上），table / db 各是一到兩次 RPC，file 要讀檔，result 則是最可能一口氣吃掉幾 KB 的那個。
 * 把 result 排最後是刻意的：它被擠掉時使用者最容易察覺（畫面上就有那張表對照），
 * 而一張被擠掉的表結構沒有人看得出來。
 */
const KIND_ORDER: Record<MentionKind, number> = {
  error: 0,
  run: 1,
  query: 2,
  table: 3,
  db: 4,
  file: 5,
  result: 6,
};

export interface MentionEnv {
  connId: string | null;
  kind: DbKind | null;
  db: string;
  editor: EditorSnapshot | null;
  uiLang: string;
}

// ---- 展開 ----

interface Expanded {
  label: string;
  text: string;
  skipped?: MentionChip["skipped"];
}

function columnLine(c: ColumnInfo): string {
  return `${c.name} ${c.data_type}${c.key === "PRI" ? " PK" : ""}${c.nullable ? "" : " NOT NULL"}`;
}

function indexLine(i: IndexInfo): string {
  return `${i.name}(${i.columns.join(", ")})${i.primary ? " PK" : i.unique ? " UNIQUE" : ""}`;
}

/** 同一個資料庫只 list 一次：`@a @b @c` 三張同庫的表不該打三次 list_tables。 */
function makeLister(env: MentionEnv): (database: string) => Promise<string[] | null> {
  const cache = new Map<string, Promise<string[] | null>>();
  return (database: string) => {
    const key = database.toLowerCase();
    let p = cache.get(key);
    if (!p) {
      const id = env.connId;
      // 失敗回 null（而非 []）：「列不出來」與「這個庫真的沒有表」是兩件事，
      // 前者不該讓每一張被提及的表都掛上「不存在」的標記。
      p = id
        ? api.listTables(id, database).then((ts) => ts.map((x) => x.name)).catch(() => null)
        : Promise.resolve(null);
      cache.set(key, p);
    }
    return p;
  };
}

/** 編輯器快照必須屬於目前這條連線；不然它講的是另一個資料庫的事（見 EditorSnapshot）。 */
function usableEditor(env: MentionEnv): EditorSnapshot | null {
  const ed = env.editor;
  return ed && ed.connId === env.connId ? ed : null;
}

async function expandTable(
  ref: MentionRef,
  env: MentionEnv,
  list: (database: string) => Promise<string[] | null>,
): Promise<Expanded> {
  const wanted = ref.table ?? "";
  const label = ref.db ? `${ref.db}.${wanted}` : wanted;
  const owner = ref.db ?? env.db;
  if (!env.connId) {
    return {
      label,
      skipped: "unavailable",
      text: t("【資料表 {name}】目前沒有連線，取不到它的結構。請不要自行假設它有哪些欄位。", { name: label }),
    };
  }
  const names = await list(owner);
  // 對一次清單順便把大小寫對回實際表名（使用者打 @ORDERS、實際是 orders）。
  // 列不出來時（names 為 null）不做這關：寧可直接去問欄位，也不要因為權限不足就誤報「不存在」。
  const real = names ? names.find((n) => n.toLowerCase() === wanted.toLowerCase()) : wanted;
  if (!real) {
    // 明寫「沒有這張表」是硬性要求。只把它從上下文裡拿掉的話，模型會照著使用者提到的名字
    // 編出一份欄位來回答，而使用者完全看不出那是編的。
    return {
      label,
      skipped: "missing",
      text: t("【資料表 {name}】{db} 裡沒有這張表（名字打錯，或目前的帳號看不到它）。請不要自行假設它存在或它有哪些欄位。", {
        name: label,
        db: owner,
      }),
    };
  }
  // 欄位與索引各自 catch（沿 aiReview.collectSchemaContext 的慣例）：讀不到索引時
  // 不該連欄位一起丟掉，那是兩次獨立的查詢。
  const [cols, idx] = await Promise.all([
    api.tableColumns(env.connId, owner, real).catch(() => null),
    api.tableIndexes(env.connId, owner, real).catch(() => null),
  ]);
  if (!cols && !idx) {
    return {
      label,
      skipped: "unavailable",
      text: t("【資料表 {name}】讀不到欄位與索引（連線中斷或權限不足）。請不要自行假設它的結構。", { name: label }),
    };
  }
  const lines = [
    cols ? t("- 欄位：{list}", { list: cols.length ? cols.map(columnLine).join(", ") : t("(無欄位資訊)") }) : null,
    // 「一個索引都沒有」本身就是最有用的訊號，明寫而不是讓這行消失。
    idx ? t("- 索引：{list}", { list: idx.length ? idx.map(indexLine).join("; ") : t("(無索引)") }) : null,
  ].filter((s): s is string => s != null);
  // clipTableLines 的超長註記寫的是「另有 N 張表」，這裡一個 ref 只有欄位 / 索引兩行，
  // 措辭略有出入。仍沿用它而不自己再寫一份：重點是「不把欄位名切成半截」與「有交代」，
  // 為了措辭另立一份夾行邏輯，兩邊遲早漂移。
  return { label, text: `${t("【資料表 {name}】", { name: label })}\n${clipTableLines(lines, MAX_TABLE_CHARS)}` };
}

async function expandDb(
  ref: MentionRef,
  env: MentionEnv,
  list: (database: string) => Promise<string[] | null>,
): Promise<Expanded> {
  const name = ref.db ?? "";
  if (!env.connId) {
    return {
      label: name,
      skipped: "unavailable",
      text: t("【資料庫 {db}】目前沒有連線，列不出它的資料表。請不要自行假設它有哪些表。", { db: name }),
    };
  }
  const names = await list(name);
  if (!names) {
    return {
      label: name,
      skipped: "unavailable",
      text: t("【資料庫 {db}】列不出資料表（連線中斷或權限不足）。請不要自行假設它有哪些表。", { db: name }),
    };
  }
  if (!names.length) return { label: name, text: t("【資料庫 {db}】裡沒有任何資料表。", { db: name }) };
  const listed = names.slice(0, MAX_DB_TABLES).join(", ").slice(0, MAX_DB_LIST_CHARS);
  // 只列前 N 張時一定要講「共幾張」：不然模型會把這份清單當成完整的，
  // 然後斷言某張沒列出來的表「不存在」。
  const head =
    names.length > MAX_DB_TABLES
      ? t("【資料庫 {db}】共 {total} 張表，以下只列出前 {n} 張：", { db: name, total: names.length, n: MAX_DB_TABLES })
      : t("【資料庫 {db}】共 {total} 張表：", { db: name, total: names.length });
  return { label: name, text: `${head}\n${listed}` };
}

/** 依副檔名挑圍籬語言；認不出來就留空（fencedBlock 接受空字串）。 */
function fenceLangOf(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? "";
  if (ext === "sql" || ext === "json" || ext === "js" || ext === "ts" || ext === "css" || ext === "html") return ext;
  if (ext === "py") return "python";
  if (ext === "sh") return "bash";
  if (ext === "md") return "markdown";
  return "";
}

async function expandFile(ref: MentionRef): Promise<Expanded> {
  const path = ref.path ?? "";
  const body = await api.readTextFile(path).catch(() => null);
  if (body === null) {
    // 讀不到就明說，且明說「不要猜內容」。使用者常提及還沒存檔的路徑，
    // 模型看到一個檔名而沒有內容時，非常樂意「回想」出一份合理的內容來。
    return {
      label: path,
      skipped: "unavailable",
      text: t("【檔案 {path}】讀不到這個檔案（路徑不存在、不是純文字，或它是助手工作資料夾裡的相對路徑）。請不要自行假設它的內容。", {
        path,
      }),
    };
  }
  return { label: path, text: `${t("【檔案 {path}】", { path })}\n${fencedClipBlock(fenceLangOf(path), body, MAX_FILE_CHARS)}` };
}

function expandQuery(env: MentionEnv): Expanded {
  const label = t("編輯器 SQL");
  const ed = usableEditor(env);
  if (!ed) {
    return {
      label,
      skipped: "unavailable",
      text: t("【編輯器 SQL】取不到編輯器內容（沒有開啟的查詢分頁，或它屬於另一條連線）。"),
    };
  }
  const sel = (ed.selection ?? "").trim();
  const sql = sel || ed.sql;
  if (!sql.trim()) return { label, skipped: "unavailable", text: t("【編輯器 SQL】編輯器目前是空的。") };
  // 有選取就只帶選取的部分：使用者反白一段再問「這段怎麼改」，指的就是那一段，
  // 把整個分頁三千行都送過去反而稀釋掉重點。但要講明這是片段，否則模型會回頭抱怨語法不完整。
  const head = sel ? t("【編輯器 SQL】（使用者目前選取的片段）") : t("【編輯器 SQL】");
  return { label, text: `${head}\n${fencedClipBlock("sql", sql, MAX_QUERY_CHARS)}` };
}

function expandResult(env: MentionEnv): Expanded {
  const label = t("查詢結果");
  const ed = usableEditor(env);
  if (!ed) {
    return {
      label,
      skipped: "unavailable",
      text: t("【查詢結果】取不到查詢結果（沒有開啟的查詢分頁，或它屬於另一條連線）。"),
    };
  }
  const r = ed.result;
  if (!r || !r.columns.length) {
    return {
      label,
      skipped: "unavailable",
      text: t("【查詢結果】目前沒有結果可附上（還沒執行，或上一次執行沒有回傳資料列）。"),
    };
  }
  const total = r.rows.length;
  const shown = Math.min(total, MAX_RESULT_ROWS);
  // 「附上幾列 / 一共幾列 / 後端是不是還截過一次」三件事都得講。少講任何一件，
  // 模型都會把這 30 列當成全部，然後給出「這個欄位只有三種值」之類的錯誤結論。
  const note = r.truncated
    ? t("以下附上前 {shown} 列；本次載入 {total} 列，且後端已達列數上限截斷，實際符合條件的列數多於 {total}。統計性的結論請勿依據這份樣本下。", {
        shown,
        total,
      })
    : t("以下附上前 {shown} 列，本次查詢共 {total} 列。", { shown, total });
  const md = clipMarkdown(resultToMarkdown({ ...r, rows: r.rows.slice(0, shown) }), MAX_RESULT_CHARS);
  return {
    label,
    text: joinLines([
      t("【查詢結果】"),
      ed.resultSql ? t("來源語句：") : null,
      ed.resultSql ? fencedClipBlock("sql", ed.resultSql, MAX_QUERY_CHARS) : null,
      note,
      md,
    ]),
  };
}

function expandError(env: MentionEnv): Expanded {
  const label = t("最近一次錯誤");
  const ed = usableEditor(env);
  if (!ed) {
    return {
      label,
      skipped: "unavailable",
      text: t("【最近一次錯誤】取不到錯誤訊息（沒有開啟的查詢分頁，或它屬於另一條連線）。"),
    };
  }
  if (!ed.error) return { label, skipped: "unavailable", text: t("【最近一次錯誤】目前沒有錯誤可附上。") };
  return {
    label,
    text: joinLines([
      t("【最近一次錯誤】"),
      t("錯誤訊息：{message}", { message: ed.error.message }),
      ed.error.sql ? t("出錯的語句：") : null,
      ed.error.sql ? fencedClipBlock("sql", ed.error.sql, MAX_QUERY_CHARS) : null,
    ]),
  };
}

function expandRun(ref: MentionRef): Expanded {
  const label = t("執行結果");
  const body = (ref.payload ?? "").trim();
  // run 的內容一律隨 ref 夾帶、絕不重跑：那次執行已經過去了，同一句 SQL 現在跑未必是同一份
  // 資料（別人剛寫進去、或那根本是個有副作用的語句）。拿不到 payload 就明說，不要假裝有。
  if (!body) return { label, skipped: "unavailable", text: t("【先前的執行結果】這次執行沒有留下可引用的內容。") };
  return { label, text: `${t("【先前的執行結果】")}\n${clipMarkdown(body, MAX_RESULT_CHARS)}` };
}

function expandOne(
  ref: MentionRef,
  env: MentionEnv,
  list: (database: string) => Promise<string[] | null>,
): Promise<Expanded> {
  switch (ref.kind) {
    case "table":
      return expandTable(ref, env, list);
    case "db":
      return expandDb(ref, env, list);
    case "file":
      return expandFile(ref);
    case "query":
      return Promise.resolve(expandQuery(env));
    case "result":
      return Promise.resolve(expandResult(env));
    case "error":
      return Promise.resolve(expandError(env));
    default:
      return Promise.resolve(expandRun(ref));
  }
}

/**
 * 同一個目標只展開一次。`@orders` 與 `@table:orders` 寫在同一句裡是很常見的（改到一半），
 * 兩份一模一樣的結構除了吃掉預算之外沒有任何作用。run 以 raw 區分，因為兩次不同的執行
 * 本來就該各自附上。
 */
function dedupKey(ref: MentionRef): string {
  if (ref.kind === "run") return `run|${ref.raw}`;
  return [ref.kind, (ref.db ?? "").toLowerCase(), (ref.table ?? "").toLowerCase(), ref.path ?? ""].join("|");
}

/**
 * 抬頭。**永遠會輸出**，即使每一則提及都被預算擠掉——模型至少要知道自己在看哪一種方言、
 * 哪一個資料庫，不然它會拿 PostgreSQL 的語法去改 MySQL 的查詢。
 * 也因為它不可被擠掉，所以不計入 MENTION_BUDGET（它是固定的一百來個字元）。
 */
function headerSection(env: MentionEnv): string {
  const label = env.kind ? KIND_META[env.kind].label : null;
  const name = env.db.trim();
  return joinLines([
    t("【使用者以 @ 指定的參考內容】以下是使用者明確要你參考的東西；沒有附上的部分請不要自行假設。"),
    label && name
      ? t("方言：{label}；資料庫：{db}", { label, db: name })
      : label
        ? t("方言：{label}", { label })
        : name
          ? t("資料庫：{db}", { db: name })
          : null,
    replyLanguageLine(env.uiLang),
  ]);
}

/**
 * 把提及展開成一段可直接接在使用者訊息前的上下文，並回報每一則的下場。
 *
 * chips 依**展開順序**回傳（而非使用者打字的順序）：它同時是預算的收據，
 * 「誰先吃到預算、誰被擠掉」只有照消耗順序讀才說得通。
 */
export async function expandMentions(
  refs: MentionRef[],
  env: MentionEnv,
): Promise<{ context: string; chips: MentionChip[] }> {
  // 一則提及都沒有時連抬頭都不給：這段上下文是要接在使用者訊息前面的，
  // 平白多一段「以下是你要參考的東西」然後什麼都沒有，只會讓模型去找不存在的附件。
  if (!refs.length) return { context: "", chips: [] };

  const ordered = refs
    .map((ref, i) => ({ ref, i }))
    // i 當第二鍵：同 kind 之間維持使用者打字的先後，先打的先吃預算。
    .sort((a, b) => KIND_ORDER[a.ref.kind] - KIND_ORDER[b.ref.kind] || a.i - b.i)
    .map((x) => x.ref);

  const seen = new Set<string>();
  const uniq = ordered.filter((ref) => {
    const key = dedupKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const list = makeLister(env);
  // 先平行抓完再依序算預算：抓取彼此獨立（五張表就是五組 RPC），
  // 排隊抓的話使用者按下送出後要空等好幾秒。
  const expanded = await Promise.all(uniq.map((ref) => expandOne(ref, env, list)));

  const chips: MentionChip[] = [];
  const parts: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (let i = 0; i < uniq.length; i++) {
    const ref = uniq[i];
    const ex = expanded[i];
    const chip: MentionChip = { kind: ref.kind, label: ex.label, bytes: 0 };
    if (ref.db !== undefined) chip.db = ref.db;
    if (ref.table !== undefined) chip.table = ref.table;
    if (ref.path !== undefined) chip.path = ref.path;
    const cost = ex.text.length + 2; // +2 = 段落之間的空行
    // 逐則判斷而非碰到第一個放不下就收攤：排在後面的 `@error` 只有兩百個字，
    // 不該因為前面一個超大的 `@file` 就一起陪葬。
    if (used + cost <= MENTION_BUDGET) {
      parts.push(ex.text);
      used += cost;
      chip.bytes = cost;
      if (ex.skipped) chip.skipped = ex.skipped;
    } else {
      chip.skipped = "budget";
      dropped.push(ex.label);
    }
    chips.push(chip);
  }

  // 被擠掉的要點名。模型知道「有東西沒附上、叫什麼名字」才有辦法回頭跟使用者要，
  // 不然它只會照著訊息裡殘留的名字硬答。
  const note = dropped.length
    ? t("（另有這些提及因為內容超出上限而沒有附上：{list}。需要其中哪一份請直接說。）", { list: dropped.join("、") })
    : null;

  return { context: [headerSection(env), ...parts, ...(note ? [note] : [])].join("\n\n"), chips };
}

/**
 * 給 UI 的體感估算。3 字元 ≈ 1 token 是中英混排的粗略中位數（純英文約 4、純中文約 1.5），
 * 刻意取偏保守的那一側——顯示出來的數字寧可比實際大，也不要讓使用者以為還有額度。
 * 呼叫端負責在畫面上加「約」字。
 */
export function estimateContext(chips: MentionChip[]): { bytes: number; tokens: number } {
  const bytes = chips.reduce((n, c) => n + (c.bytes || 0), 0);
  return { bytes, tokens: Math.round(bytes / 3) };
}

/**
 * 自動上下文：不論使用者有沒有打 @，都附上「他現在人在哪」（連線類型 / 位址 / 選取的節點）。
 * 由 AssistantPanel 的 buildContext 原樣搬過來，只多了 skipTable 與改用 env.uiLang。
 *
 * store 用動態 import 而非靜態：本模組其餘部分是純函式，而 store.ts 一載入就會讀
 * localStorage（見 store.test.ts 得先補一份 in-memory 版本）。靜態相依的話，日後任何
 * import 本模組的單元測試都得先補 localStorage 才跑得起來。i18n.ts 對 api.ts 用的是同一招。
 *
 * skipTable：使用者已經 @ 過的表不要再列一次欄位。同一份欄位清單出現兩次除了浪費預算，
 * 還會讓模型以為那是兩張不同的表（它看到的是兩段結構、名字剛好一樣）。
 */
export async function buildAutoContext(
  env: MentionEnv,
  opts?: { skipTable?: string | null },
): Promise<string> {
  const { useStore } = await import("./store");
  const s = useStore.getState();
  const conn = s.connections.find((c) => c.id === s.activeId) ?? null;
  if (!conn) return "";
  const meta = KIND_META[conn.kind];
  const lines: string[] = [t("資料庫類型：{label}", { label: meta.label })];
  if (!meta.fileBased) lines.push(t("連線位址：{host}:{port}", { host: conn.host, port: conn.port }));
  if (conn.database) lines.push(t("預設資料庫：{database}", { database: conn.database }));

  const node = s.selectedNode;
  const skip = (opts?.skipTable ?? "").trim().toLowerCase();
  if (node && node.connId === conn.id) {
    if (node.type === "database") {
      lines.push(t("目前選取資料庫：{db}", { db: node.db }));
    } else if (node.type === "table") {
      lines.push(t("目前選取{kind}：{db}.{table}", { kind: node.objKind === "view" ? t("視圖") : t("資料表"), db: node.db, table: node.table }));
      // 裸名與 `庫.表` 兩種寫法都要比對得到：使用者打的是 @orders，這裡的節點卻是 sakila.orders。
      const dup = skip !== "" && (skip === node.table.toLowerCase() || skip === `${node.db}.${node.table}`.toLowerCase());
      if (!dup) {
        try {
          const cols = await api.tableColumns(conn.id, node.db, node.table);
          if (cols.length) {
            const list = cols
              .slice(0, 80)
              .map((c) => `${c.name} ${c.data_type}${c.key === "PRI" ? " PK" : ""}${c.nullable ? "" : " NOT NULL"}`)
              .join(", ");
            lines.push(`${t("欄位：")}${list}${cols.length > 80 ? " …" : ""}`);
          }
        } catch { /* schema 為加值，失敗略過 */ }
      }
    }
  }
  const reply = replyLanguageLine(env.uiLang);
  return t("【目前資料庫環境】\n{join}\n（以上為使用者在 db-kit 的目前環境；若回答涉及 SQL，請貼合此資料庫類型與結構）", { join: lines.join("\n") }) + (reply ? ` ${reply}` : "");
}
