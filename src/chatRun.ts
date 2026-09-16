// 「在聊天室裡直接跑這段 SQL」的守門與 prompt 組裝：助手回覆裡每個 ```sql 區塊旁那顆執行鈕。
//
// 這是全程式裡手滑成本最高的入口——語句不是使用者打的，是模型生的，而使用者只按了一下。
// 查詢面板至少還有「把 SQL 讀過一遍才按執行」這層人為防線，這裡連那層都沒有，所以守門規則
// 必須和查詢面板**完全一致**（見 App.tsx 的 runQuery：唯讀硬擋、正式環境確認、危險語句確認），
// 否則同一條 DELETE 在查詢面板被擋下、在聊天室卻一路放行。
//
// 全模組為純函式（不碰 React / DOM / Tauri），判斷規則一律轉呼 sql.ts 既有的偵測器：
// 守門邏輯若在這裡另寫一份，漂移的那天不會有人發現，只會有人少一張表。
import type { DbKind, QueryResult, ReviewRunOutcome } from "./api";
import { clipMarkdown, fencedBlock, fencedClipBlock, joinLines } from "./aiReview";
import type { ChatRunResult } from "./chatTypes";
import { t } from "./i18n";
import { supportsReviewRun } from "./reviewRun";
import {
  buildUseDatabase,
  fmtElapsed,
  hasExecutableSql,
  isDangerousStatement,
  isWriteStatement,
  resultToMarkdown,
  splitSqlStatements,
} from "./sql";

/**
 * 可以從聊天室直接執行的連線類型。
 *
 * 刻意只收「講 SQL」的方言：Mongo 的 DSL / Redis 指令 / ES Query DSL 的程式碼區塊仍然可以複製、
 * 可以貼進編輯器，只是不給一鍵執行——sql.ts 的 isWriteStatement / isDangerousStatement 是針對
 * SQL 關鍵字寫的，拿去掃 `db.orders.deleteMany({})` 一個字都掃不到，等於完全沒有守門。
 * （external gateway 講 MySQL 方言，兩支偵測器對它有效，故納入。）
 */
export const RUN_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite", "mssql", "oracle", "external"];

/**
 * 可以用「目前資料庫」前綴限定的連線類型（對齊 App.tsx 的 DB_SELECT_KINDS）。
 *
 * 不能改用「buildUseDatabase 回傳非 null」當條件：它對 mssql 也給得出 `USE [db]`，但只有
 * mysql / postgres driver 有 split_leading_use / split_leading_set_search_path 會把前綴切出來、
 * 在同一條連線上先切庫再跑（external 由 gateway 自行 strip）。mssql driver 沒有那段處理，
 * 前綴只會變成「一次送兩句」的批次丟給 driver。
 * DB_SELECT_KINDS 在 App.tsx 是模組私有常數，只能在這裡再寫一份——改動時兩邊要一起改。
 */
const DB_SELECT_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "external"];

// 語句自帶「切庫」語法時不再加前綴（側欄「新增查詢」產生的 SQL 就自帶）。
// 正則刻意不帶 g：帶 g 的 RegExp 物件會在 test() 之間記住 lastIndex，逐條語句掃時會一句中一句不中。
const OWN_DB_SCOPE_RE = /^\s*(use\s|set\s+search_path)/i;

// 送回模型的結果列數上限。30 是與查詢面板「帶進 AI 助手分析」同一個數字（App.tsx askAiResult）；
// 兩處不一致的話，同一份結果從兩個入口送出去會得到不同的分析結論。
const MAX_FEEDBACK_ROWS = 30;
// 30 列仍可能很大（一張 200 欄的寬表）。字元數另外夾一次，否則光是結果表格就把對話前文擠出上下文。
const MAX_RESULT_CHARS = 6000;
// 錯誤訊息通常短，但有些 driver 會把整段查詢連同位置標記一起回傳。
const MAX_ERROR_CHARS = 2000;

/**
 * 守門結果。ok:false 的三種理由都是「連確認框都不該跳」的硬擋；ok:true 才帶出真正要送出的語句，
 * 以及呼叫端必須依序跳的確認（confirm 為空陣列 = 可以直接跑）。
 */
export type RunClassification =
  | { ok: false; reason: "unsupported" | "readonly" | "empty" }
  | { ok: true; statements: string[]; confirm: Array<"prod" | "danger" | "write"> };

/**
 * 判斷一段來自聊天室的 SQL 能不能執行、執行前要問幾道。
 *
 * statements 是「真的會送出去的東西」：SQL 方言逐條切分（sqlx 不允許單次多語句），
 * external 整段當一個批次送（gateway 自己會拆，前端切了反而破壞它的多結果集對位）。
 *
 * 但**守門一律掃切分後的版本**，連 external 也不例外。App.tsx 對 external 是拿整批去問
 * isWriteStatement，而那支只看第一個關鍵字——`SELECT 1; DROP TABLE users` 在唯讀連線上
 * 就這樣整批放行。執行單位與掃描單位本來就不必相同，分開之後那個洞才補得起來。
 */
export function classifyForRun(
  sql: string,
  kind: DbKind | null | undefined,
  opts: { readonly: boolean; prod: boolean },
): RunClassification {
  if (!kind || !RUN_KINDS.includes(kind)) return { ok: false, reason: "unsupported" };
  // 純註解片段送 DB 只會換來「Query was empty」之類的語法錯誤，而那個錯誤會被回饋給模型、
  // 引它去「修正」一段其實沒問題的註解。
  if (!hasExecutableSql(sql)) return { ok: false, reason: "empty" };

  const scanned = splitSqlStatements(sql);
  // 只有分號時 hasExecutableSql 仍為真（`;` 去掉註解後長度不為零），但切完一條都不剩。
  if (scanned.length === 0) return { ok: false, reason: "empty" };

  const statements = kind === "external" ? [sql.trim()] : scanned;

  // 唯讀是硬擋不是確認：使用者把連線設成唯讀，就是明講「這條連線上我不打算寫東西」。
  // 給一個「仍要執行」按鈕等於把那個設定退化成裝飾品。
  if (opts.readonly && scanned.some((s) => isWriteStatement(s))) return { ok: false, reason: "readonly" };

  // 由重到輕排：呼叫端照順序跳確認，最嚴重的那道要先出現，使用者才不會在連按兩次 Enter 之後
  // 才看到「這是正式環境」。以固定順序的布林組出來，天生不會重複、也不需要再去重。
  const confirm: Array<"prod" | "danger" | "write"> = [];
  if (opts.prod) confirm.push("prod");
  if (scanned.some((s) => isDangerousStatement(s))) confirm.push("danger");
  if (scanned.some((s) => isWriteStatement(s))) confirm.push("write");

  return { ok: true, statements, confirm };
}

/**
 * 把「目前資料庫」以 USE / SET search_path 前綴併進**每一條**語句。
 *
 * 前綴必須跟語句黏在同一次送出：driver 偵測到開頭的切庫語句時會取同一條連線先切再跑，
 * 分兩次送則兩句可能落在 pool 的不同連線上，切庫就白切了（見 postgres.rs 的 search_path 快取）。
 *
 * 兩層「已經自帶作用域就不要插手」：
 * 1. **整批的第一條**就自帶切庫 → 整批都不加（App.tsx 就是對整段編輯器文字做這個判斷）。
 *    少了這層，`USE analytics; SELECT …` 會被拆成兩條，而第二條被補上選擇器的 `USE shop`，
 *    等於默默把模型指定的資料庫換掉——查出來的是另一個庫的資料，而且不會有任何錯誤。
 * 2. 其餘逐條檢查：重複的 USE 不會壞，但會讓回饋給模型的 SQL 與它寫的那段對不上。
 */
export function prepareStatements(statements: string[], kind: DbKind, db: string | null): string[] {
  const name = (db ?? "").trim();
  const use = name && DB_SELECT_KINDS.includes(kind) ? buildUseDatabase(kind, name) : null;
  if (!use) return statements;
  if (statements.length > 0 && OWN_DB_SCOPE_RE.test(statements[0])) return statements;
  return statements.map((s) => (OWN_DB_SCOPE_RE.test(s) ? s : `${use};\n${s}`));
}

/**
 * QueryResult（後端的 snake_case DTO）→ 聊天訊息裡存的執行結果。
 * res 為 null 代表這次沒有結果集可讀（多半是失敗）；各欄位一律給安全預設值而不留 undefined，
 * 因為這份物件會被序列化進 localStorage，缺欄位的舊訊息重載後會在渲染端炸成 undefined.length。
 */
export function toChatRunResult(
  sql: string,
  res: QueryResult | null,
  ms: number,
  error: string | null,
): ChatRunResult {
  return {
    sql,
    columns: res?.columns ?? [],
    rows: res?.rows ?? [],
    rowsAffected: res?.rows_affected ?? 0,
    // truncated 專指「後端達到 row cap 而截斷」。undefined（非查詢語句 / 舊後端）一律當 false，
    // 否則回饋 prompt 會對模型宣告一個不存在的截斷，引它去加不必要的 LIMIT。
    truncated: res?.truncated ?? false,
    error,
    ms,
  };
}

/**
 * 存進 localStorage 前把結果列夾到 30 列。
 *
 * 助手面板會把最近 60 則訊息整包 JSON 存進 localStorage；一則未夾的結果（後端 row cap 可到數千列）
 * 就足以撐破配額，而 setItem 失敗是整包一起失敗——使用者會發現整段對話都沒存到。
 * 刻意**不**順手把 truncated 設成 true：那個旗標是後端的截斷訊號，這裡只是本地存檔的取捨，
 * 混用之後 runFeedbackPrompt 會對模型宣稱「資料庫截斷了結果」。
 * 沒超過上限時原物件回傳（維持參照相等，渲染端不會因此多重畫一次）。
 */
export function persistableRun(r: ChatRunResult): ChatRunResult {
  if (r.rows.length <= MAX_FEEDBACK_ROWS) return r;
  return { ...r, rows: r.rows.slice(0, MAX_FEEDBACK_ROWS) };
}

// 結果列數的交代文字。「附了幾列 / 一共幾列 / 後端是不是還截斷過」三件事要分開講：
// 模型看到 30 列就會拿 30 當母體算比例、下結論（「這批訂單全部集中在三月」），
// 而它其實只看到前 30 列。沒明講的話，錯的不是模型是我們。
function rowCountNote(total: number, shown: number, truncated: boolean): string {
  const base = total > shown
    ? t("（僅附前 {shown} 列，共 {total} 列）", { shown, total })
    : t("（共 {total} 列）", { total });
  return truncated
    ? `${base}${t("（後端已達列數上限而截斷，實際符合的列數可能更多，請勿把這裡的列數當成總數）")}`
    : base;
}

function resultSection(r: ChatRunResult): string {
  // 沒有欄位 = 不是查詢（UPDATE / DDL）。resultToMarkdown 此時回空字串，直接放進 prompt 會讓
  // 「執行結果」底下一片空白，模型會讀成「失敗了但沒給錯誤」而開始猜。影響列數才是這種語句的結果。
  if (r.columns.length === 0) {
    return t("沒有結果集（非查詢語句）；影響 {n} 列。", { n: r.rowsAffected });
  }
  const shown = r.rows.slice(0, MAX_FEEDBACK_ROWS);
  const table = resultToMarkdown({
    columns: r.columns,
    rows: shown,
    rows_affected: r.rowsAffected,
    truncated: r.truncated,
  });
  return joinLines([
    rowCountNote(r.rows.length, shown.length, r.truncated),
    // 用 clipMarkdown 而非直接 slice：表格被切在半行會留下欄數對不上的一列，Markdown 解析器
    // 會把後面的指令段一起吃進表格（clipMarkdown 另外還會補回被切斷的圍籬）。
    clipMarkdown(table, MAX_RESULT_CHARS),
  ]);
}

/**
 * 執行完之後回送給模型的那則訊息（完整版，進上下文而不進對話氣泡）。
 *
 * 失敗時的重點是「給出可以再按一次執行的修正語句」——模型的回覆裡只要有 ```sql 區塊，
 * 使用者就能再按一次執行鈕，這個迴圈才轉得起來；要求它先說明原因則是為了讓使用者在按下去
 * 之前看得懂自己在同意什麼。
 */
export function runFeedbackPrompt(r: ChatRunResult): string {
  const failed = r.error != null;
  return joinLines([
    t("以下是剛才在 MAGIDB CONNECT 直接執行這段 SQL 的結果，請接續分析。"),
    "",
    t("【已執行的 SQL】"),
    // 這段不夾上限：它是「實際送出去的那條語句」，被截斷的話模型改出來的修正版就會漏掉尾巴，
    // 而使用者會直接把那段漏了尾巴的 SQL 按下去執行。
    fencedBlock("sql", r.sql),
    "",
    failed ? t("【錯誤訊息】") : t("【執行結果】"),
    failed ? fencedClipBlock("text", r.error ?? "", MAX_ERROR_CHARS) : resultSection(r),
    "",
    t("耗時：{ms}", { ms: fmtElapsed(r.ms) }),
    "",
    t("【接下來】"),
    failed
      ? t("請先說明這段 SQL 為什麼失敗（指出是語法、物件不存在、型別、權限還是資料問題），再給一段修正後、可直接執行的 SQL，放進單一 ```sql 區塊：保持原本意圖，不要留佔位符或省略號。")
      : t("請根據這份結果接續分析：資料代表什麼、有沒有異常或值得注意的趨勢。若需要更多資料才能下結論，請直接給出下一段可執行的 SQL，放進單一 ```sql 區塊，並說明那段查詢要驗證什麼。"),
  ]);
}

/**
 * 顯示在使用者對話氣泡裡的短句。
 *
 * 氣泡只放這一句、完整結果另外進上下文：整張結果表格貼進氣泡會把對話捲成一片表格牆，
 * 而使用者回頭要找的是「我按過哪幾次執行」，不是那 30 列資料（結果另有自己的結果格可看）。
 * 注意要在 persistableRun 夾列數**之前**呼叫，否則超過 30 列的查詢會顯示成「30 列」。
 */
export function runFeedbackDisplay(r: ChatRunResult): string {
  if (r.error != null) return t("已執行 SQL（失敗）");
  if (r.columns.length === 0) return t("已執行 SQL（影響 {n} 列）", { n: r.rowsAffected });
  return t("已執行 SQL（{n} 列）", { n: r.rows.length });
}

/**
 * 模型寫的寫入語句改走「審查並執行」（AI 審查 → 逐句備份 → 回滾腳本）而不是只跳確認框。
 *
 * 這是全程式手滑成本最高的入口（見檔頭）：一條由模型產生、使用者只按了一下的 DELETE，
 * 最需要的就是「執行前先把會被改的列存下來」。只收審查並執行支援的連線種類——external
 * gateway 的結構 API 不可靠，仍走原本的確認框。
 */
export function routeToReviewRun(cls: RunClassification, kind: DbKind | null | undefined): boolean {
  return cls.ok && cls.confirm.includes("write") && supportsReviewRun(kind);
}

/**
 * 審查並執行的結果 → 聊天訊息裡存的執行結果（影響列數合計）。
 * 只產生備份（沒有執行）時回 null：那不是一次執行，不該在訊息上掛一個「已執行」的結果。
 */
export function reviewOutcomeToChatRun(sql: string, o: ReviewRunOutcome): ChatRunResult | null {
  const m = o.manifest;
  if (m.status === "backup_only") return null;
  const rowsAffected = m.statements.reduce((n, s) => n + (s.rows_affected ?? 0), 0);
  const ms = m.statements.reduce((n, s) => n + (s.elapsed_ms ?? 0), 0);
  const error = m.status === "completed" ? null : (m.stop_reason ?? t("未完成"));
  return { sql, columns: [], rows: [], rowsAffected, truncated: false, error, ms };
}
