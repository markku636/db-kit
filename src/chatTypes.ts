// AI 對話面板的資料形狀（純型別，零執行期程式碼）。
//
// 獨立成一個檔案而非放在 chatMentions.ts / AssistantPanel.tsx 裡，是為了切斷循環相依：
// 訊息（ChatMsg）要引用工具呼叫，工具層（agentTools.ts）又要引用訊息裡的執行結果，
// 兩邊直接互相 import 會讓 vite 在 dev 模式下拿到半初始化的模組。型別集中在最底層即可解套。
import type { DbKind, QueryResult } from "./api";

// ---- @ 提及 ----

/**
 * 一則 @ 提及的種類。
 * - table / db / file：指向資料庫物件或工作資料夾裡的檔案，展開時要去抓內容。
 * - query / result / error：指向查詢分頁的現況（見 EditorSnapshot），不必連線也能展開。
 * - run：指向對話中「助手剛剛跑過的那次查詢」，內容隨 ref 夾帶（見 MentionRef.payload），
 *   所以展開時完全不碰 api——那次結果已經過去了，重跑一次未必拿到同一份資料。
 */
export type MentionKind = "table" | "db" | "file" | "query" | "result" | "error" | "run";

/** 從輸入文字解析出來的一則提及。from / to 是字元位移（與 CodeMirror 文件位移一致）。 */
export interface MentionRef {
  kind: MentionKind;
  /** 原始 token（含 `@`）。改寫顯示文字時要用它算長度，不能從 kind 反推。 */
  raw: string;
  from: number;
  to: number;
  /** table：限定的資料庫（null = 目前資料庫）；db：被提及的資料庫名。 */
  db?: string | null;
  table?: string;
  path?: string;
  /** 僅 run：夾帶的內容本體。 */
  payload?: string;
}

/** 展開結果的收據：UI 用它顯示「這則訊息實際帶了什麼」與「什麼沒帶成」。 */
export interface MentionChip {
  kind: MentionKind;
  label: string;
  /** 這則提及實際塞進上下文的字元數；被略過者為 0。 */
  bytes: number;
  db?: string | null;
  table?: string;
  path?: string;
  /**
   * 沒帶成的原因。**沒帶成一定要留下痕跡**——靜默丟掉一張表，模型會自己編一張出來。
   * - missing：物件不存在（打錯 / 沒權限）。
   * - budget：內容超出總預算被擠掉。
   * - unavailable：目前狀態拿不到（沒連線、編輯器快照過期、檔案讀不到）。
   */
  skipped?: "missing" | "budget" | "unavailable";
}

/** 助手在對話中實際跑過的一次查詢。留存在訊息裡，供 `@run` 回頭引用與 UI 重播。 */
export interface ChatRunResult {
  sql: string;
  columns: string[];
  rows: (string | null)[][];
  rowsAffected: number;
  truncated: boolean;
  error: string | null;
  ms: number;
}

// ---- 對話 ----

export type ChatRole = "user" | "assistant";

export interface ChatMsg {
  id: string;
  role: ChatRole;
  text: string;
  tools: string[];
  pending: boolean;
  error: boolean;
  /** 本則回應耗時（result.duration_ms）。 */
  ms?: number;
  mentions?: MentionChip[];
  /** 本則訊息注入的上下文字元數（含自動上下文），供 UI 顯示「約 N tokens」。 */
  ctxBytes?: number;
  /** 「新話題」分隔線：session 在這裡斷開，之前的訊息不再送給模型。 */
  divider?: boolean;
  /**
   * 工具呼叫明細。刻意留成 unknown[]：真正的型別住在 agentTools.ts，而那支模組要 import
   * 本檔的 ChatRunResult——寫成具體型別就成了循環相依。面板取用時自行 cast。
   */
  toolCalls?: unknown[];
  /** tool_id → 該次執行的結果（與 toolCalls 對號）。 */
  runs?: Record<string, ChatRunResult>;
}

// ---- 編輯器快照 ----

/**
 * 查詢分頁對外公布的現況，讓對話面板能展開 `@query` / `@result` / `@error`。
 *
 * 帶 connId 而非只帶 sql，是因為快照會活過連線切換：使用者在 A 連線跑出錯誤、切到 B 連線
 * 再問「這個錯誤怎麼回事」，若照舊展開，模型會拿 B 的方言去解讀 A 的錯誤訊息。
 * 展開端一律比對 connId，不合就當成過期（見 chatMentions.ts）。
 */
export interface EditorSnapshot {
  tabId: string;
  connId: string | null;
  kind: DbKind | undefined;
  db: string;
  sql: string;
  /** 目前選取的片段（無選取為 null）。有選取時 `@query` 只帶選取的部分。 */
  selection: string | null;
  result: QueryResult | null;
  /** 產生 result 的那段 SQL；可能與 sql 不同（跑完之後又改了編輯器內容）。 */
  resultSql: string | null;
  error: { message: string; sql: string } | null;
  updatedAt: number;
}
