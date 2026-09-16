// AI 助手的「工具呼叫」顯示狀態機，以及「這次對話要附哪條連線」的挑選規則。
//
// 兩件事都只吃資料、不碰 React 也不碰 Tauri：事件的合併規則是四種供應商各自的怪癖疊出來的
// （見 applyToolEvent 上的註解），寫在元件的 useState 裡就只能靠人工點過四種供應商才驗得到，
// 而 CLI 那條路徑還得先裝好 dbk 與 MCP。抽成純函式後，每一種到達順序都能用單元測試釘住
// （見 agentTools.test.ts）；面板只負責把 ToolCallView 畫出來。
import { isProdConn, type AgentEvent, type ConnectionConfig, type DbKind } from "./api";
import type { SelectedNode } from "./store";

// ---- 工具名稱 ----

// 後端 agent.rs::strip_mcp_prefix 已經先剝過一次，這裡是第二道防線。
// 事件是跨進程送來的字串：後端改 MCP server 名稱、或新增一種供應商而漏接剝除時，前端不會有
// 任何編譯期警告，只會在徽章上冒出 `mcp__dbkit__run_query` 這種長名字把整列擠掉，
// 而且 isSqlToolCall 的白名單也會跟著比對失敗。剝第二次對裸名沒有副作用。
const MCP_PREFIX = "mcp__";

/**
 * `mcp__dbkit__run_query` / `dbkit:run_query` → `run_query`；裸名原樣回傳。
 *
 * 規則刻意與 Rust 端 strip_mcp_prefix 一字不差（含「冒號一律當成 server 前綴剝掉」這條）。
 * 兩邊對同一個名字給出不同答案時，壞的不只是徽章文字：isSqlToolCall 比對的是剝完的名字，
 * 一旦不一致，使用者看到的明明是 run_query，卻既沒有語法高亮也沒有「貼回查詢編輯器」。
 */
export function displayToolName(raw: string): string {
  let n = (raw ?? "").trim();
  if (n.startsWith(MCP_PREFIX)) {
    n = n.slice(MCP_PREFIX.length);
    // 只切掉第一段 server 名：工具名自己含 `__` 時（sample__rows）後半段必須原封不動留著。
    const sep = n.indexOf("__");
    if (sep >= 0) n = n.slice(sep + 2);
  }
  const colon = n.indexOf(":");
  return colon >= 0 ? n.slice(colon + 1) : n;
}

// ---- 工具呼叫列表 ----

/** 面板上的一筆工具呼叫：串流中的「開始」與「結果」兩種事件合併後的單一列。 */
export interface ToolCallView {
  /** React key 兼配對鍵：供應商給的 tool_id；沒給時是本地代號（見 localId）。 */
  id: string;
  name: string;
  /** 工具參數（JSON 字串，run_query 即為 SQL 所在）。 */
  input?: string;
  /** 結果預覽（後端已夾過長度）。 */
  preview?: string;
  rows?: number;
  truncated?: boolean;
  ms?: number;
  error?: boolean;
  /** 已收到 tool_result。false = 仍在跑，UI 轉圈。 */
  done: boolean;
}

// 沒有 tool_id 的呼叫得自己編一個 key。用「目前列數」而不是 randomUUID：這支 reducer 必須是
// 純函式——同一串事件重播兩次要得到逐欄相同的結果，否則測試釘不住，React 也會因為 key 每次
// 都變而把整串徽章重掛。`#` 開頭在任何供應商的 tool id 裡都不會出現（Anthropic 是 `toolu_`、
// OpenAI 是 `call_`），正好拿來分辨「這列還沒綁到真 id，可以被後到的 tool_id 認領」。
const LOCAL_ID_PREFIX = "#";
const localId = (slot: number): string => `${LOCAL_ID_PREFIX}${slot}`;
const isLocalId = (id: string): boolean => id.startsWith(LOCAL_ID_PREFIX);

// 空字串一律當成「這筆事件沒帶這個欄位」。CLI 供應商的 content_block_start 會先送一筆參數
// 為空的 tool 事件，照字面寫進去就把後到的完整參數蓋掉——使用者看到的會是一筆沒有 SQL 的
// run_query，而「助手到底跑了什麼查詢」正是這個面板存在的唯一理由。
// 回傳原字串而非 trim 過的：只用 trim 判斷「是不是空白」，預覽內容的排版要原樣留著。
function nonEmpty(v: string | null | undefined): string | undefined {
  return v && v.trim() ? v : undefined;
}

/**
 * 找出這筆事件該落在哪一列；-1 = 要新增一列。
 *
 * 三條規則各自對應一種真實供應商的行為，少一條就會在面板上多出或少掉一列：
 * - HTTP 供應商：`tool` 事件只有名字（沒有 tool_id），`tool_result` 才帶 id。純靠 id 比對的話，
 *   同一次呼叫會變成「一列轉圈轉到天荒地老」＋「一列憑空出現的結果」。
 * - CLI 供應商（MCP）：同一次呼叫的 `tool` 會來兩次（串流的 content_block_start 帶 id 但沒有
 *   參數、完整 assistant 訊息帶 id 也帶參數），靠 id 才併得回同一列。
 * - 平行呼叫：已經綁到別的 tool_id 的列不可以被後來的 id 認領（isLocalId 那一關），否則兩次
 *   list_tables 疊成一列——而「助手到底查了幾次」正是使用者要從這裡讀出來的資訊。
 */
function findSlot(list: ToolCallView[], id: string, name: string): number {
  if (id) {
    const exact = list.findIndex((v) => v.id === id);
    if (exact >= 0) return exact;
  }
  // 由後往前找：同名的舊呼叫早就 done 了，往回數第一筆未完成的才是「現在這次」。
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i];
    if (v.done) continue;
    if (id && !isLocalId(v.id)) continue;
    // 任一邊沒有名字就不拿來否決：tool_result 不保證回聲工具名，硬要求同名等於永遠配不到，
    // 結果就是每個結果都自成一列。
    if (name && v.name && v.name !== name) continue;
    return i;
  }
  return -1;
}

/**
 * 把一筆 agent-stream 事件併進工具呼叫列表，回傳新陣列（絕不改動傳入的陣列或其元素）。
 *
 * 核心約束是「後到的事件不准用 undefined 蓋掉先前的值」：這些欄位是分批到齊的，
 * 一筆事件沒帶參數不代表這次呼叫沒有參數。
 */
export function applyToolEvent(list: ToolCallView[], e: AgentEvent): ToolCallView[] {
  // 其他 kind 回傳同一個陣列參考，讓 React 的 setState / useMemo 直接跳過重繪。
  // 這裡若順手寫成 [...list]，text 事件（Claude 是 token 級增量，一次問答數千筆）
  // 每來一個字就把整串工具徽章重畫一次。
  if (e.kind !== "tool" && e.kind !== "tool_result") return list;

  const id = (e.tool_id ?? "").trim();
  const name = displayToolName(e.tool ?? "");
  const at = findSlot(list, id, name);
  const prev = at >= 0 ? list[at] : null;

  const merged: ToolCallView = {
    // 認領真 id 之後 React key 會從 `#0` 變成 `toolu_…`，那一列因此重掛一次：一顆徽章重掛沒有
    // 代價，而不認領的話，後續同 id 的事件就再也對不回這一列。
    id: id || prev?.id || localId(list.length),
    name: name || prev?.name || "",
    input: nonEmpty(e.tool_input) ?? prev?.input,
    preview: nonEmpty(e.tool_output_preview) ?? prev?.preview,
    // 用 ?? 而非 ||：查詢回 0 列是有意義的結果（「條件沒中」與「還沒拿到列數」得看得出差別），
    // || 會把 0 當成沒有值而退回 undefined，面板就不顯示列數了。
    rows: e.tool_rows ?? prev?.rows,
    truncated: e.tool_truncated ?? prev?.truncated,
    ms: e.tool_ms ?? prev?.ms,
    error: e.is_error ?? prev?.error,
    // `tool` 事件不把已完成的呼叫打回未完成：CLI 的完整 assistant 訊息有機會晚於 tool_result
    // 才到，照 kind 硬寫 false 的話，面板會在結果都印出來之後又轉起圈圈，而且再也不會停。
    done: e.kind === "tool_result" ? true : (prev?.done ?? false),
  };

  const next = list.slice();
  if (at >= 0) next[at] = merged;
  else next.push(merged);
  return next;
}

// ---- 參數是不是 SQL ----

// 有 SQL 方言的連線種類。
// 不用 KIND_META[kind].category === "relational" 判斷：external（gateway 驅動）打的是 SQL，
// 分類卻掛在 "other"，漏掉它等於下游打包版的助手永遠不高亮、也給不了「貼回編輯器」。
// 也不重用 sql.ts 的 supportsSchemaCompare——那份名單少了 external，只是「碰巧很像」，
// 哪天有人為了結構比對增刪一個 kind，這裡就跟著一起錯。
const SQL_DIALECT_KINDS: ReadonlySet<DbKind> = new Set<DbKind>([
  "mysql",
  "mariadb",
  "postgres",
  "sqlite",
  "mssql",
  "oracle",
  "external",
]);

// 參數裡放的是「語句」的工具。describe_table / sample_rows 的參數是表名與筆數，
// 拿 SQL 去染只會得到一團看起來像壞掉的紅字。
const SQL_TOOLS: ReadonlySet<string> = new Set(["run_query", "explain_query"]);

/**
 * 這次工具呼叫的參數是不是該連線方言的 SQL——UI 據此決定要不要語法高亮、
 * 以及要不要給「貼回查詢編輯器」。
 *
 * Mongo 與 Redis 也有 run_query，但參數分別是 JSON 管線與一行 Redis 指令：
 * 用 SQL 高亮去染會把 `$match` 標成錯誤，而「貼回 SQL 編輯器」更是貼了就跑不動。
 */
export function isSqlToolCall(v: ToolCallView, kind: DbKind | null | undefined): boolean {
  if (!kind || !SQL_DIALECT_KINDS.has(kind)) return false;
  // 再剝一次前綴：ToolCallView 未必出自 applyToolEvent（面板重新載入歷史對話時是從存檔還原的，
  // 而存檔可能是舊版前端寫下、名字還沒剝乾淨的）。
  return SQL_TOOLS.has(displayToolName(v.name));
}

// ---- 要附給這次對話的連線 ----

/** 附給 agentSend 的連線資訊（後端據此建立 DbToolCtx）。 */
export interface DbTarget {
  connectionId: string;
  /** 工具省略 database 參數時的預設庫；無「目前庫」可言時為 null。 */
  database: string | null;
  kind: DbKind;
  /** 正式環境連線：後端會在工具說明裡多提醒模型把查詢放輕（見 dbtools::DbToolCtx）。 */
  prod: boolean;
}

/**
 * zustand store 的最小結構子集。
 * dbTarget 收這個而不是直接讀 useStore，是為了能在 node 環境下測——store 一被 import 就會
 * 讀 localStorage 還原 session、載入收藏查詢，整串副作用跟本函式的邏輯完全無關。
 */
export interface DbTargetState {
  activeId: string | null;
  connectedIds: Set<string>;
  connections: ConnectionConfig[];
  selectedNode: SelectedNode | null;
}

/**
 * 挑出這次對話要附帶的連線；null = 這一輪不給助手任何資料庫工具（行為與舊版完全相同）。
 *
 * 「已連線」這關不能省：沒連線的連線在後端 ConnectionManager 裡根本沒有 pool，附上去的下場是
 * 模型每支工具都收到一串 not connected，然後開始憑印象猜資料表結構——那比沒有工具更糟。
 *
 * 預設庫的優先序：側欄選取的節點 > 連線設定的預設庫 > null。節點排前面是因為它就是使用者
 * 此刻正在看的東西：問「這張表有幾列」時指的一定是側欄裡反白的那個庫，不是設定裡填的那個。
 */
export function dbTarget(s: DbTargetState): DbTarget | null {
  const id = s.activeId;
  if (!id || !s.connectedIds.has(id)) return null;
  const conn = s.connections.find((c) => c.id === id);
  if (!conn) return null;

  // 節點必須屬於 activeId：切換作用中連線並不會清掉 selectedNode，拿 A 連線的庫名去當 B 連線的
  // 預設庫，工具只會安靜地查到零張表（庫不存在與庫是空的，回傳長得一模一樣）。
  const node = s.selectedNode;
  const fromNode = node && node.connId === id && "db" in node ? node.db.trim() : "";

  return {
    connectionId: id,
    database: fromNode || (conn.database ?? "").trim() || null,
    kind: conn.kind,
    prod: isProdConn(conn),
  };
}
