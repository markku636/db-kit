// AI 輔助的 SQL 審查 / 調校 / 壓測分析：把「方言 + 資料表結構 + 規則引擎發現 + 執行計畫」
// 整理成範本變數，交給 AI 資源庫的範本（ai-library/prompts/review-sql、tune-sql、stress-analysis）渲染。
//
// 分工：措辭（段落標題、指示、「某段為空時要怎麼說」）全在範本檔，使用者可以改；本模組只做
// 「上下文提供者」——截斷、圍籬、逐項格式——這些是正確性的來源，留在程式碼裡用單元測試釘住。
// 唯一碰 api 的是 collectSchemaContext（要抓結構），它把所有 api 失敗都吞成「該段留白」。
import { api, KIND_META, type ColumnInfo, type DbKind, type IndexInfo } from "./api";
import { renderTask } from "./aiLibrary";
import { replyLanguageLine, t } from "./i18n";
import { rankTables } from "./nlPrompt";
import { statementTables } from "./sqlContextComplete";

// ---- 規則引擎 DTO ----
// 與 sqlLint.ts 同一份契約。這裡另立一份而非 import，是為了讓 prompt 組裝不相依規則引擎
// （TS 結構型別相容，sqlLint 的 LintFinding 可直接傳進來）；主線整併時改成 re-export 即可。

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

// ---- 上限 ----
// 沿 nlPrompt.ts 的做法：每一段各自夾一次上限。整包 prompt 只夾總長的話，前面一張 5000 欄的
// 寬表就能把後面的執行計畫整段擠掉，而計畫才是調校時最關鍵的輸入。
const MAX_DETAIL_TABLES = 6; // 審查只需要查詢真正碰到的表，比 NL→SQL（8）更收斂
const MAX_COLS_PER_TABLE = 60;
const MAX_INDEXES_PER_TABLE = 24;
const MAX_SCHEMA_CHARS = 6000;
const MAX_INDEX_CHARS = 3000;
export const MAX_SQL_CHARS = 8000;
const MAX_PLAN_CHARS = 12000;
const MAX_REPORT_CHARS = 8000;
const MAX_FINDINGS = 40;
const MAX_HOT_NODES = 12;
const MAX_ROW_COUNTS = 20;

// ---- 共用小工具 ----

/**
 * 把內容包成 fenced code block。圍籬取「比內容裡最長的反引號串再多一個」（作法沿用
 * stress.ts::reportToMarkdown）——附上的 SQL / JSON 本身可能含 ```（註解裡貼了 Markdown、
 * 字串欄位存了程式碼），固定用三個會提早收掉區塊，後半段內容就變成 prompt 指令的一部分。
 */
export function fencedBlock(lang: string, body: string): string {
  // 逐一比大小而非 Math.max(...runs)：本模組送進來的內容都先夾過上限，但這支是給主線複用的
  // 公開 API，一段含十萬個反引號的內容（貼上的結果集 / 匯出的 DDL）會讓展開的參數個數超過
  // 引擎上限，丟 RangeError: Maximum call stack size exceeded。
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body.trim()}\n${fence}`;
}

// 過長內容截斷後「明說被截斷」：模型看到半截 JSON 會當成完整計畫來推論，
// 寧可讓它知道資訊不全而回頭要，也不要它拿殘缺輸入下結論。
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n${t("…（內容過長，其餘已截斷）")}`;
}

/**
 * 夾上限後再包圍籬，且**截斷提示留在圍籬外**。
 * 提示若落在 ```sql 內，那行中文就成了「待審 SQL」的最後一行，而輸出格式又要求「保持原本
 * 語意改寫」——模型沒有理由不把它當語句的一部分。（超過 8000 字的寬 SELECT 就會踩到。）
 */
export function fencedClipBlock(lang: string, body: string, max: number): string {
  if (body.length <= max) return fencedBlock(lang, body);
  return `${fencedBlock(lang, body.slice(0, max))}\n${t("…（內容過長，其餘已截斷）")}`;
}

/**
 * 夾一段 Markdown 的上限，並補回被切斷的圍籬。
 * 壓測報告尾端就是一個 ```sql 區塊，切在區塊中間會留下沒收尾的圍籬——後面的
 * 【受測語句】【現有索引】【執行計畫】會整段被模型當成程式碼讀。
 */
export function clipMarkdown(md: string, max: number): string {
  if (md.length <= max) return md;
  const head = md.slice(0, max);
  let open: string | null = null;
  for (const line of head.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (open === null) open = m[1];
    else if (m[1][0] === open[0] && m[1].length >= open.length) open = null;
  }
  return `${open === null ? head : `${head}\n${open}`}\n${t("…（內容過長，其餘已截斷）")}`;
}

/**
 * 逐「行」夾上限。直接 slice 會把最後一張表切在欄位名中間（`orders_colum`），模型會把半截
 * 名字當成真欄位拿去建索引；寧可整行不要，並明說少了幾張表。
 * 註記本身可能讓結果略微超過 max，這點刻意容許——重點是「不切在字中間」與「有交代」。
 */
export function clipTableLines(lines: string[], max: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = kept.length ? line.length + 1 : line.length;
    if (used + cost > max) break;
    kept.push(line);
    used += cost;
  }
  // 連第一行都放不下（單張超寬表）時仍給出前半段，總比整段留白好。
  if (!kept.length) return lines.length ? clip(lines[0], max) : "";
  const rest = lines.length - kept.length;
  if (rest > 0) kept.push(t("（另有 {n} 張表因內容過長未列出。）", { n: rest }));
  return kept.join("\n");
}

// 以 null 表示「這行不出現」，讓各 builder 用同一個陣列骨架寫（空字串仍是有意義的空行）。
export function joinLines(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => p != null).join("\n");
}

/**
 * 範本共用的抬頭變數：方言、資料庫、回覆語言。
 * 先講身分再講方言，模型才不會拿 PostgreSQL 的語法去改 MySQL 的查詢（身分那行在範本裡）。
 * db 為 null 表示該情境沒有資料庫名（壓測分析只帶 kind）。
 */
export function headerVars(kind: DbKind, db: string | null, uiLang: string): Record<string, string> {
  return {
    dialect: KIND_META[kind].label,
    database: (db ?? "").trim(),
    // 非繁中語系時要求整段回覆用該語言（比照 nlPrompt.ts 的 commentLangLine；差別在這裡是
    // 整段回覆而非只有 SQL 註解，因為這幾支 prompt 的產出主體都是散文分析）。
    reply_language: replyLanguageLine(uiLang) ?? "",
  };
}

/**
 * 規則引擎發現的逐條清單；空清單回空字串。
 * 空清單若留成空區段，模型會讀成「規則引擎的結果沒附上」而自行腦補一份——範本在變數為空時
 * 明講「檢查過但沒發現」，順便把「所以請找規則以外的問題」講明。
 */
export function findingsVar(findings: LintFinding[]): string {
  if (findings.length === 0) return "";
  const rows = findings.slice(0, MAX_FINDINGS).map((f) =>
    t("- [{severity}] {id}（第 {line} 行第 {col} 欄）：{message}　建議：{hint}", {
      severity: f.severity,
      id: f.id,
      line: f.line,
      col: f.col,
      message: f.message,
      hint: f.hint,
    }),
  );
  const rest = findings.length - MAX_FINDINGS;
  if (rest > 0) rows.push(t("（另有 {n} 條未列出）", { n: rest }));
  return rows.join("\n");
}

/**
 * 執行計畫區塊（```json 圍籬，夾上限）；沒有計畫回空字串。
 * 沒有計畫時範本會明講「沒有」並禁止杜撰：模型很願意編出 cost 數字，而編出來的熱點會直接誤導調校。
 */
export function planVar(planJson: string | null | undefined): string {
  const raw = (planJson ?? "").trim();
  return raw ? fencedClipBlock("json", raw, MAX_PLAN_CHARS) : "";
}

// collectSchemaContext 附加註記後會略超過 MAX_SCHEMA_CHARS，外層再夾時留這點餘裕，
// 免得剛好把「另有 N 張表未列出」那行切掉。
const SCHEMA_SLACK = 256;

/** 結構與索引兩段（抓不到為空字串，範本會說明「無法取得」並禁止假設索引存在）。 */
export function schemaVars(schema: SchemaContext | null | undefined): { schema: string; indexes: string } {
  // 這裡再夾一次上限：SchemaContext 不保證出自 collectSchemaContext（主線可能改餵結構快取），
  // 而一張 5000 欄的寬表就足以把後面的執行計畫擠出模型的上下文，計畫才是調校最關鍵的輸入。
  const bound = (s: string, max: number): string =>
    s.length <= max ? s : clipTableLines(s.split("\n"), max);
  return {
    schema: bound(schema?.tables ?? "", MAX_SCHEMA_CHARS + SCHEMA_SLACK),
    indexes: bound(schema?.indexes ?? "", MAX_INDEX_CHARS + SCHEMA_SLACK),
  };
}

/** 待審 / 待改的 SQL：夾上限後包 ```sql 圍籬（截斷提示在圍籬外）。 */
export function sqlVar(sql: string): string {
  return fencedClipBlock("sql", sql, MAX_SQL_CHARS);
}

// ---- 上下文蒐集（本模組唯一會碰 api 的地方）----

export interface SchemaContext {
  /** 每行一張表的欄位摘要（`- 表名: 欄位 型別 …`）；完全抓不到時為空字串。 */
  tables: string;
  /** 每行一張表的索引摘要；完全抓不到時為空字串。 */
  indexes: string;
}

function columnLine(c: ColumnInfo): string {
  return `${c.name} ${c.data_type}${c.key === "PRI" ? " PK" : ""}${c.nullable ? "" : " NOT NULL"}`;
}

function indexLine(i: IndexInfo): string {
  return `${i.name}(${i.columns.join(", ")})${i.primary ? " PK" : i.unique ? " UNIQUE" : ""}`;
}

/** 一筆入選的表：db = null 代表目前資料庫。 */
interface TableRef {
  db: string | null;
  table: string;
}

/**
 * 找出 SQL 裡以 `其他庫.表` 明確限定、且真的存在的跨庫參照。
 *
 * 「真的存在」這一關不能省：限定名可能是打錯的、可能指向沒有權限的庫，直接拿去打
 * tableColumns 只會換來一串失敗；先用 list_tables 對一次也順便把大小寫對回實際表名。
 * 同一個庫只列一次表。
 */
async function resolveCrossDbTables(
  connId: string,
  currentDb: string,
  sql: string,
  limit: number,
): Promise<TableRef[]> {
  const current = currentDb.toLowerCase();
  const wanted = statementTables(sql).filter((r) => r.db && r.db.toLowerCase() !== current);
  if (wanted.length === 0) return [];

  const listed = new Map<string, Promise<string[]>>();
  const listOf = (d: string): Promise<string[]> => {
    const key = d.toLowerCase();
    let p = listed.get(key);
    if (!p) {
      p = api.listTables(connId, d).then((ts) => ts.map((x) => x.name)).catch(() => []);
      listed.set(key, p);
    }
    return p;
  };

  const out: TableRef[] = [];
  for (const r of wanted) {
    if (out.length >= limit) break;
    const real = (await listOf(r.db!)).find((n) => n.toLowerCase() === r.table.toLowerCase());
    if (real) out.push({ db: r.db!, table: real });
  }
  return out;
}

/**
 * 抓「與這段 SQL 最相關的表」的欄位與索引，組成兩段文字。
 *
 * 挑表刻意用**原始 SQL**而非 sql.ts 的 stripCode()：識別字常被引號包住（`orders` /
 * "orders"），而 stripCode 連同引號內容一起抹成空白，正好抹掉我們要比對的表名。
 * 反過來，註解或字串字面值提到的表只會讓 prompt 多帶一張表（幾百個字元），代價小得多。
 */
export async function collectSchemaContext(
  connId: string,
  db: string,
  sql: string,
  selectedTable?: string | null,
): Promise<SchemaContext> {
  let names: string[] = [];
  try {
    names = (await api.listTables(connId, db)).map((x) => x.name);
  } catch {
    // 連線斷了 / 權限不足也要能送出 prompt——模型至少還看得到 SQL 與執行計畫。
    return { tables: "", indexes: "" };
  }

  // 跨庫（同一連線、`其他庫.表`）：這些參照是使用者親手寫下的，相關性無須再猜，直接排在
  // 候選最前面。少了它們，模型看到的是半份結構——然後它會替另一半編出欄位與索引來。
  const cross = await resolveCrossDbTables(connId, db, sql, MAX_DETAIL_TABLES);
  const room = Math.max(0, MAX_DETAIL_TABLES - cross.length);
  const picked: TableRef[] = [
    ...cross,
    ...(room ? rankTables(sql, names, selectedTable ?? null, room) : []).map((table) => ({ db: null, table })),
  ];

  const parts = await Promise.all(
    picked.map(async (ref) => {
      // 跨庫的表以 `庫.表` 標示，同庫維持裸名（既有輸出格式不動）。
      const label = ref.db ? `${ref.db}.${ref.table}` : ref.table;
      const owner = ref.db ?? db;
      // 欄位與索引各自 catch：某張表讀不到索引時不該連它的欄位一起丟掉
      // （沿 nlPrompt.ts 的慣例——單一 api 失敗只讓那一塊留白，不讓整個 prompt 生不出來）。
      const [cols, idx] = await Promise.all([
        api.tableColumns(connId, owner, ref.table).catch(() => null),
        api.tableIndexes(connId, owner, ref.table).catch(() => null),
      ]);
      return {
        // 欄位為零筆（權限受限的 view、不支援欄位內省的類型）也明寫，比留下 `- orders: ` 這種
        // 冒號後空白的行清楚——後者模型會讀成格式壞掉而自行補一份欄位。
        table: cols
          ? `- ${label}: ${cols.length ? cols.slice(0, MAX_COLS_PER_TABLE).map(columnLine).join(", ") : t("(無欄位資訊)")}`
          : null,
        // 「一個索引都沒有」本身就是調校時最有用的訊號，明寫出來而不是讓該表消失。
        index: idx
          ? `- ${label}: ${idx.length ? idx.slice(0, MAX_INDEXES_PER_TABLE).map(indexLine).join("; ") : t("(無索引)")}`
          : null,
      };
    }),
  );

  // 挑表有上限（8 表 JOIN 只會帶到 6 張）。不講明的話，模型會把「沒列出來」讀成「沒有索引」，
  // 進而建議去建一個其實早就存在的索引。
  const note =
    picked.length >= MAX_DETAIL_TABLES && names.length + cross.length > picked.length
      ? t("（僅列出與這段 SQL 最相關的 {n} 張表；未列出的表不代表沒有索引。）", { n: picked.length })
      : null;

  const section = (key: "table" | "index", max: number): string => {
    const lines = parts.map((p) => p[key]).filter((s): s is string => s != null);
    if (!lines.length) return ""; // 完全抓不到時留空，由 schemaSections 說明「無法取得」
    return joinLines([clipTableLines(lines, max), note]);
  };

  return { tables: section("table", MAX_SCHEMA_CHARS), indexes: section("index", MAX_INDEX_CHARS) };
}

// ---- ① 審查 ----

export interface ReviewInput {
  kind: DbKind;
  db: string;
  sql: string;
  findings: LintFinding[];
  schema: SchemaContext;
  planJson?: string | null;
  uiLang: string;
}

/** 審查範本的變數（DBA 審查面板也用它，好讓「編輯本次提示」看到的是同一份上下文）。 */
export function reviewVars(input: ReviewInput): Record<string, string> {
  const { kind, db, sql, findings, schema, planJson, uiLang } = input;
  return {
    ...headerVars(kind, db, uiLang),
    sql: sqlVar(sql),
    lint_findings: findingsVar(findings),
    ...schemaVars(schema),
    plan: planVar(planJson),
  };
}

/**
 * SQL 審查（DBA 審查）：規則引擎的發現 + 結構 + （可選）計畫 → 第一行結論 + 逐條點評 + 一段可直接執行的改寫。
 * 範本刻意要求「同意 / 不同意都要講理由」——規則引擎有誤報，讓模型無條件附和只會放大誤報。
 * 審查者的身分由系統提示裡的 DBA 人設決定，範本只講任務。
 */
export function buildReviewPrompt(input: ReviewInput): string {
  return renderTask("review-sql", reviewVars(input));
}

// ---- ② 調校 ----

export interface TuneInput extends ReviewInput {
  planSummary: { nodes: number; tables: number; maxCost: number | null } | null;
  /** 熱點節點的簡述（主線由 explain.ts 的 PlanNode 樹整理後傳入）。 */
  hotNodes: string[];
  rowCounts?: Record<string, number>;
}

// 大數字加千分位：模型判斷「這張表值不值得建索引」時，1200000 與 1,200,000 的可讀性差很多。
export function fmtInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(n);
}

/** 計畫摘要一行；沒有摘要回空字串（範本會寫「(無計畫摘要)」）。 */
export function planSummaryVar(s: TuneInput["planSummary"]): string {
  if (!s) return "";
  return t("節點數 {nodes}、資料表 {tables}、最大單點成本 {cost}", {
    nodes: s.nodes,
    tables: s.tables,
    cost: s.maxCost == null ? t("(未知)") : fmtInt(s.maxCost),
  });
}

/** 熱點節點清單；沒有回空字串（範本會寫「(未標出熱點節點)」）。 */
export function hotNodesVar(hotNodes: string[]): string {
  return hotNodes.slice(0, MAX_HOT_NODES).map((h) => `- ${h}`).join("\n");
}

/**
 * 效能調校：比審查多帶計畫摘要 / 熱點 / 列數估計，並要求「索引 DDL」與「改寫」分開兩個區塊
 * （UI 的一鍵貼回只會取第一個 ```sql，兩者混在一起會把 DDL 跟查詢一起貼進編輯器）。
 */
export function buildTunePrompt(input: TuneInput): string {
  const { kind, db, sql, findings, schema, planJson, uiLang, planSummary, hotNodes, rowCounts } = input;
  const counts = Object.entries(rowCounts ?? {}).slice(0, MAX_ROW_COUNTS);
  return renderTask(
    "tune-sql",
    {
      ...headerVars(kind, db, uiLang),
      sql: sqlVar(sql),
      plan_summary: planSummaryVar(planSummary),
      hot_nodes: hotNodesVar(hotNodes),
      row_counts: counts.map(([name, n]) => `- ${name}: ${fmtInt(n)}`).join("\n"),
      lint_findings: findingsVar(findings),
      ...schemaVars(schema),
      plan: planVar(planJson),
    },
  );
}

// ---- ③ 壓測分析 ----

export interface StressInput {
  kind: DbKind;
  sql: string;
  /** 來自 stress.ts::reportToMarkdown。 */
  reportMarkdown: string;
  planJson?: string | null;
  schema?: SchemaContext | null;
  uiLang: string;
}

/**
 * 壓測報告分析：重點是「從百分位的形狀反推瓶頸類型」，而不是把報告數字複誦一次。
 * 報告本身是 Markdown，直接原樣嵌入（不再包 fence）——它有標題與表格，包起來反而更難讀；
 * 而它內部已經有一個 ```sql 區塊，包起來還得再算一次圍籬。
 * 報告內雖然通常已含語句，範本仍另列一段：reportMarkdown 由呼叫端組裝，不保證含 SQL。
 */
export function buildStressAnalysisPrompt(input: StressInput): string {
  const { kind, sql, reportMarkdown, planJson, schema, uiLang } = input;
  return renderTask(
    "stress-analysis",
    {
      ...headerVars(kind, null, uiLang),
      report: clipMarkdown(reportMarkdown.trim(), MAX_REPORT_CHARS),
      sql: sqlVar(sql),
      ...schemaVars(schema),
      plan: planVar(planJson),
    },
  );
}
