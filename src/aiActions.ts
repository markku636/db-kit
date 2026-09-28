// 編輯器內的 AI 動作（選一段 SQL → 解釋 / 最佳化 / 修正 / 加註解 / 轉方言 / 產測試資料 /
// 解讀執行計畫 / 依指示改寫）的 prompt 組裝與「要改哪一段」的定位。
//
// 與 aiReview.ts 同一套分工：本模組只組字串與算位移，不呼叫助手、不碰 Tauri、不碰 DOM
// ——措辭與位移才是效果與正確性的來源，抽成純函式後才能用單元測試釘住（見 aiActions.test.ts）。
// 共用的小工具（圍籬、夾上限、抬頭、結構 / 計畫 / 規則引擎段落）一律沿用 aiReview 匯出的那一份：
// 兩處各寫一份的話，日後只改其中一邊，同一個 app 裡就會出現兩種截斷行為與兩種方言抬頭。
import { KIND_META, type ColumnInfo, type DbKind } from "./api";
import { builtinSnapshot, findEntry, renderTask, resolveVariant } from "./aiLibrary";
import {
  fencedClipBlock,
  findingsVar,
  headerVars,
  hotNodesVar,
  planSummaryVar,
  planVar,
  schemaVars,
  sqlVar,
  MAX_SQL_CHARS,
  type LintFinding,
  type SchemaContext,
} from "./aiReview";
import { t, useLang } from "./i18n";
import { commentLangLine, extractFirstCodeBlock } from "./nlPrompt";
import { renderTemplate } from "./promptTemplate";
import { hasExecutableSql, statementSpanAtOffset } from "./sql";

// ---- 上限 ----
// 沿 aiReview.ts 的做法：每一段各自夾一次。只夾總長的話，一段貼進來的萬字錯誤訊息
// （gateway 常把整串 stack trace 回上來）就能把後面的結構與計畫整段擠掉。
const MAX_ERROR_CHARS = 4000;
const MAX_INSTRUCTION_CHARS = 4000;
const MAX_COLUMN_CHARS = 6000;

/** 一次最多請模型產幾列測試資料。再多就不是「測試資料」而是壓測資料了——那該用 DataGenerator。 */
export const MAX_TESTDATA_ROWS = 500;

// ---- 動作清單 ----

export type AiActionId =
  | "explain"
  | "optimize"
  | "fix"
  | "comment"
  | "convert"
  | "testdata"
  | "explainPlan"
  | "inline";

/**
 * chat：產出散文，直接渲染在助手面板。
 * edit：產出一段取代用的 SQL，以 diff 呈現後由使用者決定套不套用。
 * 這個分野決定 UI 怎麼接收回覆，不是純粹的分類標籤——搞錯會讓散文被當成 SQL 貼進編輯器。
 */
export type AiActionKind = "chat" | "edit";

export interface AiActionMeta {
  id: AiActionId;
  label: string;
  kind: AiActionKind;
  /** 缺少這項輸入時，選單該把這個動作變灰（而不是送出一份注定空轉的 prompt）。 */
  needs?: "error" | "plan" | "table";
}

/**
 * 選單的單一真相。
 *
 * label 刻意寫成 getter：這是 module-level 常數，若在模組初始化時就呼叫 `t()`，標籤會被凍結在
 * 「app 載入當下」的語言——使用者之後切到英文，選單仍是中文，而且切回來也不會更新（常數只算一次）。
 * 寫成 getter 後每次讀取都重新查表，語言切換即時生效；代價是別對這個陣列做淺拷貝
 * （`{...meta}` 會把當下的譯文定死）。
 */
export const AI_ACTIONS: readonly AiActionMeta[] = [
  { id: "explain", kind: "chat", get label() { return t("解釋這段 SQL"); } },
  { id: "optimize", kind: "edit", get label() { return t("最佳化"); } },
  { id: "fix", kind: "edit", needs: "error", get label() { return t("修正錯誤"); } },
  { id: "comment", kind: "edit", get label() { return t("加上註解"); } },
  { id: "convert", kind: "edit", get label() { return t("轉換方言"); } },
  { id: "testdata", kind: "edit", needs: "table", get label() { return t("產生測試資料"); } },
  { id: "explainPlan", kind: "chat", needs: "plan", get label() { return t("解讀執行計畫"); } },
  { id: "inline", kind: "edit", get label() { return t("依指示改寫…"); } },
];

/**
 * 可作為「轉換方言」目標的類型。只列 SQL 方言：Mongo / Redis / Kafka / Elasticsearch 沒有
 * 可對應的語句形式，列進來只會讓模型硬掰一段跑不動的東西。
 */
export const DIALECT_TARGETS: readonly DbKind[] = [
  "mysql",
  "mariadb",
  "postgres",
  "mssql",
  "oracle",
  "sqlite",
];

/**
 * 排除來源方言後的目標清單。
 * MySQL ↔ MariaDB 刻意**不**互相排除：兩者雖同源，序列（SEQUENCE）、RETURNING、JSON 型別與
 * 部分函式已經分家，「幫我轉成 MariaDB 能跑的」是真實需求，不是無意義的自我轉換。
 */
export function dialectTargetsFor(kind: DbKind): DbKind[] {
  return DIALECT_TARGETS.filter((k) => k !== kind);
}

// ---- 目標定位 ----

export interface AiTarget {
  from: number;
  to: number;
  /** 恆等於 `doc.slice(from, to)`——動作套用回編輯器時是用 from/to 取代，文字與位移對不上就會改錯地方。 */
  text: string;
  scope: "selection" | "statement" | "document";
}

/** 去掉兩端空白後的位移範圍；整段都是空白時回 null。 */
function trimmedSpan(doc: string, from: number, to: number): { from: number; to: number } | null {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(doc[a])) a++;
  while (b > a && /\s/.test(doc[b - 1])) b--;
  return b > a ? { from: a, to: b } : null;
}

/**
 * 決定 AI 動作要處理哪一段：選取 > 游標所在語句 > 整份文件。
 *
 * 選取優先是 DataGrip / DBeaver 的既有手感——使用者特地圈起來就是要只改那一段。選取範圍會先
 * 去掉兩端空白：從行首拖到下一行行首很容易多框到換行，把換行一起送去改寫，模型回來的那段就
 * 不含換行，套用後兩條語句會黏成一行。
 *
 * 游標落在語句之間的空白時取「後一條」（沿用 statementSpanAtOffset 的既定行為，與 Ctrl+Enter
 * 執行游標所在語句一致）；整份文件是保底：分號切不出語句、但內容確實不是純註解 / 空白時，
 * 與其什麼都不做，不如讓使用者拿整份去問。
 *
 * 回傳 null 代表「沒有可處理的 SQL」，呼叫端應該讓動作變灰而不是送出空 prompt。
 */
export function resolveAiTarget(
  doc: string,
  sel: { from: number; to: number } | null,
  cursor: number,
): AiTarget | null {
  if (sel) {
    // from/to 可能是原始的 anchor/head（反向拖曳時 from > to）。不先正規化，slice 會回空字串，
    // 使用者明明選了東西卻被當成沒選。
    const lo = Math.max(0, Math.min(sel.from, sel.to));
    const hi = Math.min(doc.length, Math.max(sel.from, sel.to));
    const span = lo < hi ? trimmedSpan(doc, lo, hi) : null;
    if (span) return { ...span, text: doc.slice(span.from, span.to), scope: "selection" };
  }

  // 游標可能超出範圍（文件剛被外部改短、或呼叫端傳了上一版的位移）；夾住再查，
  // 否則 statementSpanAtOffset 會落到「找不到 from >= offset 的語句」而回最後一條，語意剛好相反。
  const at = statementSpanAtOffset(doc, Math.max(0, Math.min(doc.length, cursor)));
  if (at) return { from: at.from, to: at.to, text: at.text, scope: "statement" };

  const whole = trimmedSpan(doc, 0, doc.length);
  if (!whole) return null;
  const text = doc.slice(whole.from, whole.to);
  // 純註解 / 空白不是「可處理的 SQL」：送出去只會換來一段「你想問什麼？」。
  if (!hasExecutableSql(text)) return null;
  return { ...whole, text, scope: "document" };
}

// ---- 共用輸入 ----

export interface ActionCtx {
  kind: DbKind;
  db: string;
  sql: string;
  schema: SchemaContext | null;
  uiLang: string;
}

/** 編輯型動作的抬頭變數：共用抬頭 + 註解語言（契約的最後一條）。 */
function editVars(kind: DbKind, db: string, uiLang: string): Record<string, string> {
  // commentLangLine 回傳的是可直接串在句尾的片語（前導換行），這裡當獨立一行用，故去掉兩端空白。
  return { ...headerVars(kind, db, uiLang), comment_language: commentLangLine(uiLang).trim() };
}

/**
 * 所有「編輯型」動作共用的輸出契約（contracts/sql-edit.md，鎖定不可覆蓋），逐行回傳。
 * 它要吃 uiLang（註解語言那行），而且測試要能逐條斷言「每一支 edit builder 都真的帶上了它」。
 *
 * 第 3 條是整個 diff 檢視能不能用的關鍵：模型很樂意順手把語句重排成它喜歡的格式，
 * 一旦重排，逐行 diff 就是「每一行都改了」，使用者根本看不出真正的改動在哪，
 * 這個功能也就退化成「把整段換掉，自己看著辦」。
 */
export function editOutputLines(uiLang: string): string[] {
  const c = findEntry("contract", "sql-edit") ?? findEntry("contract", "sql-edit", builtinSnapshot());
  if (!c) return [];
  // 契約文字跟著介面語言（與範本同一條規則：t() 時代文字語言就是目前的譯文表）。
  const body = resolveVariant(c, useLang.getState().lang).body;
  return renderTemplate(body, { comment_language: commentLangLine(uiLang).trim() }).split("\n");
}

// ---- ① 解釋 ----

/**
 * 解釋：純散文，範本刻意**不**要求程式碼區塊。
 * 要求了的話，模型會覺得「解釋完總要附一段改寫」，而 UI 這條路徑沒有 diff 也沒有套用按鈕，
 * 那段 SQL 只會變成一坨沒人能用的文字；真的想改，使用者會再按「最佳化」。
 */
export function buildExplainPrompt(ctx: ActionCtx): string {
  const { kind, db, sql, schema, uiLang } = ctx;
  return renderTask("explain", { ...headerVars(kind, db, uiLang), sql: sqlVar(sql), ...schemaVars(schema) });
}

// ---- ② 最佳化 ----

export interface OptimizeInput extends ActionCtx {
  findings: LintFinding[];
  planJson?: string | null;
}

/**
 * 最佳化：與 aiReview 的「調校」分工不同——調校產出的是診斷報告加索引 DDL，這裡產出的是
 * **一段要直接取代原語句的 SQL**。因此範本要求索引建議只能以註解形式附帶：把 CREATE INDEX 混進輸出，
 * 貼回編輯器就會把使用者的查詢換成一段 DDL。
 */
export function buildOptimizePrompt(input: OptimizeInput): string {
  const { kind, db, sql, schema, uiLang, findings, planJson } = input;
  return renderTask(
    "optimize",
    {
      ...editVars(kind, db, uiLang),
      sql: sqlVar(sql),
      lint_findings: findingsVar(findings),
      ...schemaVars(schema),
      plan: planVar(planJson),
    },
  );
}

// ---- ③ 修正錯誤 ----

export interface FixInput extends ActionCtx {
  error: string;
  /** 多語句批次時，真正失敗的那一條；與 sql 相同或未提供則視為單語句。 */
  failedStmt?: string | null;
}

/**
 * 修正：把錯誤訊息與出錯的語句一起送出，要求回一段可直接執行的 SQL。
 *
 * 多語句批次的處理沿用 App.tsx::askAiFixError 的既有行為：失敗的那一條與整批不同時，**兩段都給**
 * （模型不必自己數第幾條會出錯），並明確要求回傳修正後的完整批次。少了這條要求，模型只會回失敗的
 * 那一句，而套用是整段取代——其餘原本正確的語句會就這樣被刪掉。`failed_statement` 非空即代表多語句。
 */
export function buildFixPrompt(input: FixInput): string {
  const { kind, db, sql, schema, uiLang, error, failedStmt } = input;
  const failed = (failedStmt ?? "").trim();
  const multi = failed !== "" && failed !== sql.trim();
  return renderTask(
    "fix",
    {
      ...editVars(kind, db, uiLang),
      sql: sqlVar(sql),
      failed_statement: multi ? fencedClipBlock("sql", failed, MAX_SQL_CHARS) : "",
      error: fencedClipBlock("", error.trim() || t("(未提供錯誤訊息)"), MAX_ERROR_CHARS),
      ...schemaVars(schema),
    },
  );
}

// ---- ④ 加上註解 ----

/**
 * 加註解：唯一一個「輸入與輸出必須逐字元相同，只多出註解行」的動作。
 * 共用的輸出契約已經講過「沒被要求改的行要照抄」，範本再強調一次是因為這支動作**整段**都沒被要求改
 * ——模型很容易把「加註解」讀成「整理一下這段 SQL」，於是順手改了大小寫與縮排，diff 就滿江紅。
 */
export function buildCommentPrompt(ctx: ActionCtx): string {
  const { kind, db, sql, schema, uiLang } = ctx;
  return renderTask("comment", { ...editVars(kind, db, uiLang), sql: sqlVar(sql), ...schemaVars(schema) });
}

// ---- ⑤ 轉換方言 ----

export interface ConvertInput extends ActionCtx {
  target: DbKind;
}

/**
 * 轉方言。範本最重要的一條是「轉不過去就留 TODO」：一個看起來能跑、語意卻不同的替代寫法，
 * 比一行顯眼的 -- TODO 危險得多——前者會被直接執行，而且直到資料算錯了才會被發現。
 * 抬頭的「方言：…」講的是來源；目標方言另列一行，避免模型把抬頭當成輸出目標。
 */
export function buildConvertPrompt(input: ConvertInput): string {
  const { kind, db, sql, schema, uiLang, target } = input;
  return renderTask(
    "convert",
    {
      ...editVars(kind, db, uiLang),
      target_dialect: KIND_META[target].label,
      sql: sqlVar(sql),
      ...schemaVars(schema),
    },
  );
}

// ---- ⑥ 產生測試資料 ----

export interface TestDataInput {
  kind: DbKind;
  db: string;
  table: string;
  columns: ColumnInfo[];
  rows: number;
  uiLang: string;
}

/** 欄位摘要。旗標是模型唯一的約束來源：少標一個 NOT NULL，回來的 INSERT 就會插不進去。 */
function testDataColumnLine(c: ColumnInfo): string {
  const flags = [
    c.key === "PRI" ? t("主鍵") : null,
    c.nullable ? t("可為 NULL") : t("NOT NULL"),
    // auto_increment（MySQL）/ IDENTITY（SQL Server）：填了值不是被忽略就是直接報錯，必須標出來。
    /auto_?increment|identity|nextval/i.test(c.extra ?? "") ? t("自動產生，請勿填值") : null,
    c.default != null && c.default !== "" ? t("預設 {v}", { v: c.default }) : null,
    c.comment?.trim() ? t("註解：{v}", { v: c.comment.trim() }) : null,
  ].filter((s): s is string => s != null);
  return `- ${c.name} ${c.data_type}（${flags.join("、")}）`;
}

/**
 * 欄位清單夾上限。原則與 aiReview 的 clipTableLines 相同——整行整行地砍，絕不切在字中間
 * （直接 slice 會留下 `order_dat` 這種半截欄位名，模型會拿它去組 INSERT，插進去才發現沒這欄）。
 * 沒有直接複用那一支，是因為它的註記寫的是「另有 N 張表未列出」：用在欄位清單上，模型會讀成
 * 「還有別的資料表沒給我」，然後自己補一份別張表的欄位進來。量詞錯了比截斷本身更貴。
 */
function clipColumnLines(lines: string[], max: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = kept.length ? line.length + 1 : line.length;
    if (used + cost > max) break;
    kept.push(line);
    used += cost;
  }
  // 連第一行都放不下（單一欄位帶了超長註解）時仍給出前半段，總比整段留白好。
  if (!kept.length) return lines.length ? lines[0].slice(0, max) : "";
  const rest = lines.length - kept.length;
  if (rest > 0) kept.push(t("（另有 {n} 個欄位因內容過長未列出；請只使用上面列出的欄位。）", { n: rest }));
  return kept.join("\n");
}

/**
 * 產生測試資料。列數一定要夾上限：UI 的輸入框攔得住手滑，但參數也可能來自快捷鍵重播或設定檔，
 * 而「請產生 100000 列」換來的不是十萬列，是一份被截斷的半截 INSERT——語法壞掉且不易察覺。
 */
export function buildTestDataPrompt(input: TestDataInput): string {
  const { kind, db, table, columns, rows, uiLang } = input;
  // Math.floor(NaN) / 0 都落到 1：與其產出一段「請產生 NaN 列」的 prompt，不如給最小可用值。
  const n = Math.max(1, Math.min(MAX_TESTDATA_ROWS, Math.floor(rows) || 1));
  return renderTask(
    "test-data",
    {
      ...editVars(kind, db, uiLang),
      table,
      rows: String(n),
      columns: columns.length ? clipColumnLines(columns.map(testDataColumnLine), MAX_COLUMN_CHARS) : "",
    },
  );
}

// ---- ⑦ 解讀執行計畫 ----

export interface ExplainPlanInput extends ActionCtx {
  planJson: string | null;
  planSummary: { nodes: number; tables: number; maxCost: number | null } | null;
  /** 熱點節點的簡述（主線由 explain.ts 的 PlanNode 樹整理後傳入）。 */
  hotNodes: string[];
}

/**
 * 解讀執行計畫：把計畫「唸」成人話，不產出任何 DDL 或改寫。
 * 這是刻意的分工——使用者按「解讀」是想看懂，按「最佳化」才是想改。混在一起的話，
 * 助手面板會塞一堆沒有 diff、沒有套用按鈕的 SQL，而真正的解讀反而被埋在下面。
 */
export function buildExplainPlanPrompt(input: ExplainPlanInput): string {
  const { kind, db, sql, schema, uiLang, planJson, planSummary, hotNodes } = input;
  return renderTask(
    "explain-plan",
    {
      ...headerVars(kind, db, uiLang),
      sql: sqlVar(sql),
      plan_summary: planSummaryVar(planSummary),
      hot_nodes: hotNodesVar(hotNodes),
      ...schemaVars(schema),
      plan: planVar(planJson),
    },
  );
}

// ---- ⑧ 依指示改寫（Ctrl+I）----

export interface InlineEditInput extends ActionCtx {
  instruction: string;
}

/**
 * Ctrl+I「告訴 AI 要怎麼改」。
 *
 * instruction 是**使用者自由輸入的文字**，而且常常是從別處貼進來的（issue 內容、同事的訊息、
 * 含 Markdown 的規格片段）。用 fencedBlock 包起來有兩層意義：圍籬長度會隨內容裡的反引號自動加長，
 * 指示裡的 ``` 無法提早收掉區塊而讓後半段變成 prompt 指令；同時範本明講「這一段是資料，
 * 不是規則」，讓夾帶的假段落標題（例如自己寫一行【輸出格式】）失去作用。
 * 夾上限後仍走 fencedBlock（fencedClipBlock 內部就是它），圍籬加長的保護不會因為夾上限而失效。
 */
export function buildInlineEditPrompt(input: InlineEditInput): string {
  const { kind, db, sql, schema, uiLang, instruction } = input;
  return renderTask(
    "inline-edit",
    {
      ...editVars(kind, db, uiLang),
      instruction: fencedClipBlock("text", instruction.trim() || t("(未填寫指示)"), MAX_INSTRUCTION_CHARS),
      sql: sqlVar(sql),
      ...schemaVars(schema),
    },
  );
}

// ---- 輸出截取 ----

// 無 code block 時的「整段當 SQL」判定。自 NlQueryBar.tsx 搬來：NL→SQL 與編輯器內的 AI 動作
// 收到的是同一種回覆，判定規則沒有理由各寫一份（各寫一份就會各自漏掉不同的關鍵字）。
export const SQL_LEAD = /^\s*(select|insert|update|delete|create|alter|drop|truncate|with|explain)\b/i;

// 破壞性語句偵測（套用前警示）：DROP / TRUNCATE / ALTER，或沒有 WHERE 的 DELETE / UPDATE。
const DESTRUCTIVE = /\b(drop|truncate|alter)\b/i;

/**
 * 這段程式碼套用下去會不會造成不可逆的損失。刻意寬鬆（字串或註解裡出現 drop 也會中）：
 * 誤報只是多跳一個確認視窗，漏報是使用者一鍵刪掉整張表。
 */
export function isDestructive(code: string): boolean {
  if (DESTRUCTIVE.test(code)) return true;
  const noWhere = /\b(delete\s+from|update)\b/i.test(code) && !/\bwhere\b/i.test(code);
  return noWhere;
}

/**
 * 從助手回覆裡截出「要套用的 SQL」。
 * 先找 ```sql（或無語言標註的）區塊；沒有區塊時，整段看起來就是 SQL 就整段採用
 * ——本機模型常常忘了加圍籬，為此丟掉一段可用的語句太可惜。兩者都不成立回 null，
 * 由呼叫端顯示「沒截到語句」，而不是把一段散文塞進 diff。
 */
export function extractSqlProposal(text: string): string | null {
  const code = (extractFirstCodeBlock(text, ["sql"]) ?? "").replace(/\s+$/, "");
  if (code) return code;
  const bare = text.trim();
  return SQL_LEAD.test(bare) ? bare : null;
}
