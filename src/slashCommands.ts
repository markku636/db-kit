// AI 對話輸入框的斜線命令：把一句 `/explain`、`/fix`、`/sql …` 展開成「要送出的 prompt」
// 或「面板自己要做的事」。
//
// 與 aiActions.ts / chatMentions.ts 同一套分工：本模組只做解析與組裝，不呼叫助手、不碰 DOM、
// 不 import React（vitest 跑在 node 環境）。prompt 本體一律轉交既有的 builder——
// 斜線命令與編輯器右鍵選單問的是同一件事，措辭若各寫一份，同一個 app 裡的「解釋這段 SQL」
// 就會因為入口不同而得到不同品質的回答，而且只有其中一份會被測試釘住。
//
// 唯一會碰 api 的是 collectSchemaContext / buildSqlNlPrompt / buildEsNlPrompt 這幾支被轉呼叫的
// 函式（它們各自把失敗吞成「該段留白」），所以 expandSlash 是 async 但不會因為連線斷掉而丟例外。
import { KIND_META, type AgentMode, type DbKind } from "./api";
import {
  buildExplainPrompt,
  buildFixPrompt,
  buildOptimizePrompt,
  type ActionCtx,
} from "./aiActions";
import { collectSchemaContext, joinLines } from "./aiReview";
import type { EditorSnapshot, MentionRef } from "./chatTypes";
import { t } from "./i18n";
import { buildEsNlPrompt, buildSqlNlPrompt } from "./nlPrompt";
import { lintSql } from "./sqlLint";

// ---- 命令清單 ----

export interface SlashCommand {
  /** 含前導斜線的完整命令名（`/explain`）。比對與顯示共用同一份，省掉兩邊各自拼接斜線的機會。 */
  name: string;
  /** 參數需求。UI 用它決定送出鍵要不要變灰、以及自動完成要不要在選到之後保留游標等輸入。 */
  args: "none" | "optional" | "required";
  /** 自動完成選單上的一行說明。 */
  hint: string;
}

/**
 * 命令的單一真相。
 *
 * hint 寫成 getter 的理由與 aiActions.ts 的 AI_ACTIONS 相同：這是 module-level 常數，
 * 在模組初始化時就呼叫 `t()` 會把說明凍結在「app 載入當下」的語言，之後切語言不會更新
 * （常數只算一次）。代價是別對這個陣列做淺拷貝——`{...cmd}` 會把當下的譯文定死。
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/explain", args: "optional", get hint() { return t("解釋 SQL（不給參數就用編輯器裡選取的、或整段內容）"); } },
  { name: "/fix", args: "none", get hint() { return t("修正編輯器裡最近一次執行失敗的語句"); } },
  { name: "/optimize", args: "optional", get hint() { return t("最佳化 SQL（附上規則引擎的檢查結果）"); } },
  { name: "/sql", args: "required", get hint() { return t("用一句話描述需求，生成查詢語句"); } },
  { name: "/schema", args: "required", get hint() { return t("說明某張資料表的結構與設計（可寫成 庫.表）"); } },
  { name: "/clear", args: "none", get hint() { return t("清空對話並開始新的一輪"); } },
  { name: "/export", args: "none", get hint() { return t("把目前的對話匯出成檔案"); } },
  { name: "/new", args: "none", get hint() { return t("開新話題（保留畫面上的對話，但不再一起送給模型）"); } },
];

/**
 * 解析輸入的第一個詞。不是命令（或認不出來）就回 null，由呼叫端當成一般訊息送出。
 *
 * 三個刻意的決定：
 *
 * 1. **只認訊息開頭**：句中的 `/usr/bin/mysql`、日期 `2024/01` 都不該變成命令。
 *    前導空白先去掉——貼上常會帶進空白，而使用者看到的仍然是「開頭就是斜線」。
 * 2. **前綴要唯一才算數**：`/expl` 只可能是 `/explain`，但 `/exp` 同時像 `/explain` 與
 *    `/export`，這時一律回 null。猜錯的代價不對等——猜成 `/explain` 會把整個編輯器的內容
 *    送給模型（慢、花錢、還可能夾帶正式環境的語句），而回 null 只是讓使用者把字打完。
 *    裸寫一個 `/` 同樣落在這條（每一條都符合前綴）。
 * 3. **大小寫不敏感**：輸入法切換或行動鍵盤的自動大寫會產生 `/Explain`，那顯然還是同一條命令。
 */
export function parseSlash(text: string): { cmd: SlashCommand; arg: string } | null {
  const body = text.replace(/^\s+/, "");
  if (!body.startsWith("/")) return null;

  // 用第一個空白字元切（含換行）：`/sql\n上個月的訂單` 這種多行輸入很常見，
  // 只認半形空格的話，整段會被當成一個認不出來的命令名。
  const sp = body.search(/\s/);
  const token = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
  const arg = (sp < 0 ? "" : body.slice(sp + 1)).trim();

  const exact = SLASH_COMMANDS.find((c) => c.name === token);
  if (exact) return { cmd: exact, arg };
  const hits = SLASH_COMMANDS.filter((c) => c.name.startsWith(token));
  return hits.length === 1 ? { cmd: hits[0], arg } : null;
}

// ---- 展開結果 ----

export type SlashAction =
  /** 送出一輪。prompt 是完整指令文、display 是氣泡上顯示的短句，兩者刻意分家（見 displayOf）。 */
  | { kind: "send"; prompt: string; display: string; mentions?: MentionRef[]; mode?: AgentMode; ignoreSession?: boolean }
  /** 面板自己處理，不送出任何東西。 */
  | { kind: "local"; action: "clear" | "export" | "new" }
  /** 前置條件不成立。訊息直接顯示在對話裡，且**不佔用一輪對話**——見 info()。 */
  | { kind: "info"; message: string };

export interface SlashEnv {
  connId: string | null;
  kind: DbKind | null;
  db: string;
  /** 查詢分頁發佈的現況（見 assistant.ts::publishEditor）。過期與否由 usableEditor 判斷。 */
  editor: EditorSnapshot | null;
  /** 側欄選中的表。餵給 collectSchemaContext / NL prompt 當「一定要帶上的那張表」。 */
  selectedTable: string | null;
  uiLang: string;
}

/**
 * 前置條件不成立時回這個，而不是硬送一輪。
 * 沒有 SQL 可解釋就送出 `/explain`，換回來的是一句「請提供你要解釋的 SQL」——使用者等了幾秒、
 * 花了額度，得到的資訊比本地一行提示還少。
 */
function info(message: string): SlashAction {
  return { kind: "info", message };
}

// ---- 共用小工具 ----

/**
 * 編輯器快照必須屬於目前這條連線。
 *
 * 規則與 chatMentions.ts::usableEditor 相同（那一支沒有匯出，故在此重寫兩行而非改動它）：
 * 快照會活過連線切換，使用者在 A 連線跑出錯誤、切到 B 連線再打 `/fix`，照舊展開的話，
 * 模型會拿 B 的方言去修 A 的語句，而且完全看不出哪裡不對。
 */
function usableEditor(env: SlashEnv): EditorSnapshot | null {
  const ed = env.editor;
  return ed && ed.connId === env.connId ? ed : null;
}

/**
 * 決定命令要處理哪一段 SQL：參數 > 編輯器選取 > 整份內容。
 *
 * 選取優先是編輯器內 AI 動作的既有手感（見 aiActions.resolveAiTarget）：使用者特地圈起來
 * 就是只要問那一段，把整個分頁三千行都送過去只會稀釋重點。全空回空字串，由呼叫端給提示。
 */
function targetSql(arg: string, env: SlashEnv): string {
  const typed = arg.trim();
  if (typed) return typed;
  const ed = usableEditor(env);
  if (!ed) return "";
  return (ed.selection ?? "").trim() || ed.sql.trim();
}

/** 氣泡上的摘要長度。超過就截斷——這是一行標題，不是內容。 */
const MAX_DISPLAY_CHARS = 80;

/**
 * 使用者訊息氣泡要顯示的文字。
 *
 * 一定要與 prompt 分家：展開後的 prompt 動輒好幾 KB（輸出格式、結構、索引、執行計畫），
 * 貼進氣泡等於把整串對話洗掉，而使用者連自己下了哪一條命令都認不出來。
 * 取第一個非空白行而非直接 slice：SQL 常以 `--` 註解或空行開頭，取到的會是一片空白。
 */
function displayOf(name: string, detail: string): string {
  const line = detail.split("\n").map((s) => s.trim()).find((s) => s !== "") ?? "";
  const head =
    line.length > MAX_DISPLAY_CHARS ? t("{text}…", { text: line.slice(0, MAX_DISPLAY_CHARS) }) : line;
  return head ? t("{name} {text}", { name, text: head }) : name;
}

/**
 * 有 SQL 方言的連線種類。
 *
 * 照抄 agentTools.ts 的同名集合（那一份沒有匯出）。不用 `KIND_META[kind].category === "relational"`
 * 判斷的理由也一樣：external（gateway 驅動）打的是 SQL，分類卻掛在 "other"，漏掉它等於
 * 打包版的使用者永遠用不了 `/sql`。
 */
const SQL_DIALECT_KINDS: ReadonlySet<DbKind> = new Set<DbKind>([
  "mysql",
  "mariadb",
  "postgres",
  "sqlite",
  "mssql",
  "oracle",
  "external",
]);

/**
 * 組出 aiActions 的共用輸入。schema 交給 collectSchemaContext——它會把所有 api 失敗吞成
 * 「該段留白」，所以連線斷了也照樣送得出 prompt（模型至少還看得到 SQL）。
 * 沒有連線時直接給 null，讓 schemaSections 印出「請勿假設任何索引存在」。
 */
async function actionCtx(env: SlashEnv, kind: DbKind, sql: string): Promise<ActionCtx> {
  return {
    kind,
    db: env.db,
    sql,
    uiLang: env.uiLang,
    schema: env.connId ? await collectSchemaContext(env.connId, env.db, sql, env.selectedTable) : null,
  };
}

/** 三支 SQL 類命令共用的前置檢查訊息：沒有方言就沒有正確答案。 */
function noKindInfo(): SlashAction {
  return info(t("請先選一條連線：不知道是哪一種資料庫，AI 只能用猜的方言回答。"));
}

// ---- ① /explain ----

async function expandExplain(arg: string, env: SlashEnv): Promise<SlashAction> {
  const sql = targetSql(arg, env);
  if (!sql) {
    return info(t("沒有可以解釋的 SQL。請在 /explain 後面直接貼上語句，或先在查詢分頁裡選取一段。"));
  }
  if (!env.kind) return noKindInfo();
  return {
    kind: "send",
    prompt: buildExplainPrompt(await actionCtx(env, env.kind, sql)),
    display: displayOf("/explain", sql),
  };
}

// ---- ② /fix ----

async function expandFix(env: SlashEnv): Promise<SlashAction> {
  const ed = usableEditor(env);
  const err = ed?.error ?? null;
  if (!ed || !err) {
    // 明說「要先執行過」：使用者常以為 /fix 會自己去看編輯器裡哪裡寫錯了。
    return info(t("目前沒有失敗的查詢可以修正。請先在查詢分頁執行一次，/fix 才拿得到錯誤訊息與出錯的語句。"));
  }
  if (!env.kind) return noKindInfo();

  // 送出的是**整份編輯器內容**而非只有出錯那一條：套用修正是整段取代，只回失敗的那一句
  // 等於把其餘原本正確的語句刪掉（buildFixPrompt 的多語句路徑就是為此存在）。
  // 分頁在執行後被清空時退回錯誤自帶的語句，總比送出一份空 SQL 好。
  const sql = ed.sql.trim() || err.sql.trim();
  const prompt = buildFixPrompt({
    ...(await actionCtx(env, env.kind, sql)),
    error: err.message,
    failedStmt: err.sql,
  });

  return {
    kind: "send",
    prompt,
    // 氣泡上顯示錯誤訊息而非 SQL：使用者回頭捲動對話時，認出這一輪靠的是「哪一個錯誤」。
    display: displayOf("/fix", err.message),
    // 收據用的提及：讓訊息底下長出一顆「最近一次錯誤」的 chip，使用者才看得出這一輪帶了什麼。
    // from/to 都給 0 是刻意的——這個 ref 不是從輸入文字解析來的，沒有對應的位移；
    // chatMentions.stripMentions 會跳過 from >= to 的 ref，所以它不會去改寫顯示文字。
    mentions: [{ kind: "error", raw: "@error", from: 0, to: 0 }],
  };
}

// ---- ③ /optimize ----

async function expandOptimize(arg: string, env: SlashEnv): Promise<SlashAction> {
  const sql = targetSql(arg, env);
  if (!sql) {
    return info(t("沒有可以最佳化的 SQL。請在 /optimize 後面直接貼上語句，或先在查詢分頁裡選取一段。"));
  }
  if (!env.kind) return noKindInfo();

  const ctx = await actionCtx(env, env.kind, sql);
  return {
    kind: "send",
    // findings 一定要是真的跑過規則引擎的結果。給空陣列的話，findingsSection 會印出
    // 「規則引擎已檢查，沒有發現問題（不是沒有執行）」——那是一句謊話，模型會據此
    // 把注意力移開規則涵蓋得到的部分，真正的 SELECT * 與缺 WHERE 反而沒人講。
    // planJson 刻意不給：編輯器快照裡沒有執行計畫，planSection 會明說「未取得」並禁止杜撰。
    prompt: buildOptimizePrompt({ ...ctx, findings: lintSql(env.kind, sql) }),
    display: displayOf("/optimize", sql),
  };
}

// ---- ④ /sql ----

async function expandNl(arg: string, env: SlashEnv): Promise<SlashAction> {
  const nl = arg.trim();
  if (!nl) {
    return info(t("請在 /sql 後面用一句話描述你要查什麼，例如：/sql 上個月金額最高的十筆訂單。"));
  }
  // NL→查詢語句靠的是真實的表名與欄位（buildSqlNlPrompt 會去列表、抓欄位）。沒有連線時
  // 生出來的語句必然指向不存在的表，使用者卻要執行過才發現。
  if (!env.connId || !env.kind) {
    return info(t("請先連上資料庫：/sql 需要真實的表名與欄位，才生得出能直接執行的語句。"));
  }

  const { connId, kind, uiLang } = env;
  // generate 是一次性、零工具、單回合的模式，與聊天用的 advise / agent 不同。
  //
  // ignoreSession 這一項是必要的，不是保險：後端會為這一輪另發一個 session id，
  // 讓它寫回聊天的 session，接下來的對話就悄悄接到那段「只有一句 NL」的空歷史上，
  // 之前的上下文整個不見，而且畫面上沒有任何跡象（見 AssistantPanel::send）。
  const oneShot = { mode: "generate" as AgentMode, ignoreSession: true };

  if (kind === "elastic") {
    // 側欄選中的節點在 ES 是 index 而不是表，直接當成目標索引（與 NlQueryBar 同一套取法）。
    const prompt = await buildEsNlPrompt({ connId, nl, targetIndex: env.selectedTable, uiLang });
    return { kind: "send", prompt, display: displayOf("/sql", nl), ...oneShot };
  }
  if (!SQL_DIALECT_KINDS.has(kind)) {
    // Mongo / Redis / Kafka / RabbitMQ 沒有 SQL 方言。硬送出去換來的是一段跑不動的語句，
    // 而使用者會以為是模型不夠聰明，不會想到是這個入口本來就不適用。
    return info(t("{label} 沒有 SQL 方言，/sql 幫不上忙。請直接把需求說出來，助手會用它自己的查詢語法回答。", {
      label: KIND_META[kind].label,
    }));
  }

  // crossDbs 不給：SlashEnv 裡沒有「使用者已宣告要跨哪些庫」這項狀態，而亂猜一份庫名
  // 只會誘導模型生出跨庫語句去查根本沒載入的庫。不給就完全維持單庫行為。
  const prompt = await buildSqlNlPrompt({
    connId,
    kind,
    db: env.db,
    nl,
    selectedTable: env.selectedTable,
    uiLang,
  });
  return { kind: "send", prompt, display: displayOf("/sql", nl), ...oneShot };
}

// ---- ⑤ /schema ----

/**
 * 表名的結構在提及層已經定義好了（chatMentions 的 `庫.表`），這裡照同一條規則拆：
 * 只切**第一個**點，後面的原樣留在表名裡。兩邊規則若不一致，`/schema a.b.c` 與
 * `@a.b.c` 會指到不同的東西，而使用者完全沒有理由預期它們不同。
 */
function tableRefOf(name: string): MentionRef {
  const dot = name.indexOf(".");
  // raw 只是「這個 ref 對應哪個 token」的記錄；from/to 給 0 的理由同 /fix（見上）。
  const base = { raw: `@${name}`, from: 0, to: 0 };
  return dot > 0
    ? { kind: "table", ...base, db: name.slice(0, dot), table: name.slice(dot + 1) }
    : { kind: "table", ...base, db: null, table: name };
}

function expandSchema(arg: string, env: SlashEnv): SlashAction {
  const name = arg.trim();
  if (!name) return info(t("請指定資料表，例如：/schema orders 或 /schema sakila.orders。"));
  if (!env.connId) return info(t("請先連上資料庫：沒有連線就讀不到這張表的欄位與索引。"));

  const ref = tableRefOf(name);
  return {
    kind: "send",
    // prompt 刻意短：結構由 chatMentions.expandMentions 展開這則提及後接在前面，
    // 在這裡再寫一次方言與資料庫抬頭只會與它重複（它一定會輸出抬頭，見 headerSection）。
    prompt: joinLines([
      t("請說明資料表 {name} 的設計。", { name }),
      "",
      t("【說明重點】"),
      t("1. 用途：這張表在業務上記錄的是什麼，一列代表一件什麼事，看得出來與哪些表有關聯。"),
      t("2. 逐欄說明：每個欄位的意義、可能的取值與單位、可為 NULL 時的 NULL 代表什麼。看不出用途的欄位就直說看不出來——憑欄位名編一個合理的解釋，使用者無從分辨那是猜的。"),
      t("3. 鍵與索引設計：主鍵選得合不合理、每條既有索引服務的是哪一種查詢、有沒有被前綴涵蓋而重複的索引，以及常見查詢缺了哪一條索引。"),
      t("4. 可疑之處：型別與長度不合用（金額用浮點數、時間存字串、旗標用 varchar）、該有而沒有的 NOT NULL 或唯一鍵、命名不一致、看起來已經沒在用的欄位。"),
      t("請只根據上面附上的欄位與索引作答；沒附上的部分不要自行假設。"),
    ]),
    display: displayOf("/schema", name),
    mentions: [ref],
  };
}

// ---- 派送 ----

/**
 * 把一條命令展開成「要做什麼」。
 *
 * 回傳的 mentions 是給 chatMentions.expandMentions 用的：`/schema` 靠它把欄位與索引接在
 * prompt 前面（prompt 本身刻意不含結構），`/fix` 則只是為了讓訊息底下長出一顆錯誤 chip
 * ——錯誤內容已經由 buildFixPrompt 寫進 prompt 了，再展開一次會讓同一段訊息出現兩次
 * （幾百個字元，對 12KB 的提及預算無感），換來的是「這一輪帶了什麼」在畫面上看得見。
 */
export async function expandSlash(cmd: SlashCommand, arg: string, env: SlashEnv): Promise<SlashAction> {
  switch (cmd.name) {
    case "/explain":
      return expandExplain(arg, env);
    case "/fix":
      return expandFix(env);
    case "/optimize":
      return expandOptimize(arg, env);
    case "/sql":
      return expandNl(arg, env);
    case "/schema":
      return expandSchema(arg, env);
    case "/clear":
      return { kind: "local", action: "clear" };
    case "/export":
      return { kind: "local", action: "export" };
    case "/new":
      return { kind: "local", action: "new" };
    default:
      // 只有「呼叫端自己捏了一個 SlashCommand」才會走到這裡（parseSlash 只回清單裡的東西）。
      // 靜靜回 send 會送出一段空 prompt，回 info 至少讓人看得出是命令名對不上。
      return info(t("不認得這個命令：{name}", { name: cmd.name }));
  }
}
