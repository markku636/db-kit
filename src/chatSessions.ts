// AI 助手的「多對話」存放層：純函式 + localStorage，零 React / Tauri 相依（見 chatSessions.test.ts）。
//
// 以前整個助手只有一串對話：換個資料庫接著問，模型手上還握著上一個庫的表結構與結果，
// 答案就串了庫；想乾淨開始只能「清空」，而清空是不可逆的——過去問過的東西一併沒了。
// 「新話題」分隔線只斷開送給模型的上文，畫面上仍是同一串，找不回也切不回去。
//
// 這裡把對話改成一份可以並存、可以切換、各自留著歷史的清單：一個資料庫一串，
// 切走再切回來，上下文與畫面都還在原處。
import type { ChatMsg } from "./chatTypes";

/** 一串獨立的對話。畫面上的訊息、送回後端續聊的 session id、開串時的連線，綁在一起。 */
export interface ChatConversation {
  id: string;
  /**
   * 顯示用標題。空字串代表「還沒取過名」——清單會即時從第一則使用者訊息推導（見 conversationTitle），
   * 使用者手動改名後才寫進這裡。存推導結果而非即時算，會讓改了第一則訊息的對話標題突然跳掉。
   */
  title: string;
  messages: ChatMsg[];
  /** 後端 agent 的 session id（續聊用）。換供應商即作廢，見 agentProvider。 */
  agentSessionId: string | null;
  /**
   * 寫下 agentSessionId 時用的是哪個供應商。換供應商後那個 id 對新端點毫無意義，
   * 帶著它續聊只會讓後端去找一段不存在的歷史（CLI 更會直接以「找不到 session」失敗）。
   */
  agentProvider: string | null;
  /** 開這串對話時所在的連線。清單上顯示成副標，「這串是在哪個庫問的」一眼可辨。 */
  connId: string | null;
  connName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatArchive {
  conversations: ChatConversation[];
  /** 目前顯示的那一串。指向不存在的 id 時由 loadArchive 修正（見 normalizeArchive）。 */
  activeId: string;
}

export const CHAT_SESSIONS_KEY = "db-kit:assistantSessions";

/** 最多留幾串對話。超過時丟最久沒動的那些——localStorage 是有配額的，不能無限長。 */
export const MAX_CONVERSATIONS = 30;
/** 每串對話最多留幾則訊息（沿用單串時代的上限）。 */
export const MAX_MESSAGES = 60;

/** 標題推導取前幾個字。太長會把清單撐爆，太短又認不出是哪一串。 */
const TITLE_MAX = 32;

export function newConversation(
  conn: { id: string | null; name: string | null } = { id: null, name: null },
  now = Date.now(),
): ChatConversation {
  return {
    id: crypto.randomUUID(),
    title: "",
    messages: [],
    agentSessionId: null,
    agentProvider: null,
    connId: conn.id,
    connName: conn.name,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 清單上要顯示的標題：使用者取過名就用那個，否則從第一則使用者訊息推導。
 * 兩者皆無（剛開的空對話）回 null，由呼叫端決定顯示「新對話」之類的佔位字樣——
 * 這支模組不碰 i18n，翻譯是 UI 層的事。
 */
export function conversationTitle(c: ChatConversation): string | null {
  if (c.title.trim()) return c.title.trim();
  const first = c.messages.find((m) => m.role === "user" && m.text.trim());
  if (!first) return null;
  // 取第一行：貼一整段 SQL 進來提問時，整段擠進標題只會看到一片空白與換行。
  const line = first.text.trim().split("\n")[0].trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
}

/** 依 id 取對話；找不到回 null。 */
export function findConversation(a: ChatArchive, id: string): ChatConversation | null {
  return a.conversations.find((c) => c.id === id) ?? null;
}

/** 目前作用中的對話。normalizeArchive 保證恆有一串，所以這裡不會回 null。 */
export function activeConversation(a: ChatArchive): ChatConversation {
  return findConversation(a, a.activeId) ?? a.conversations[0];
}

/** 就地更新某一串（回新的 archive；同時把 updatedAt 推到現在）。找不到 id 則原樣回傳。 */
export function updateConversation(
  a: ChatArchive,
  id: string,
  patch: (c: ChatConversation) => ChatConversation,
  now = Date.now(),
): ChatArchive {
  if (!a.conversations.some((c) => c.id === id)) return a;
  return {
    ...a,
    conversations: a.conversations.map((c) => (c.id === id ? { ...patch(c), id: c.id, updatedAt: now } : c)),
  };
}

/** 新增一串並切過去。 */
export function addConversation(a: ChatArchive, c: ChatConversation): ChatArchive {
  return { conversations: [c, ...a.conversations], activeId: c.id };
}

/**
 * 移除一串。刪掉的若正是作用中的那串，就近接手「清單上的下一串」；
 * 全刪光則自動補一串空的——面板永遠要有地方可以打字。
 */
export function removeConversation(a: ChatArchive, id: string, now = Date.now()): ChatArchive {
  const idx = a.conversations.findIndex((c) => c.id === id);
  if (idx === -1) return a;
  const rest = a.conversations.filter((c) => c.id !== id);
  if (rest.length === 0) {
    const fresh = newConversation({ id: null, name: null }, now);
    return { conversations: [fresh], activeId: fresh.id };
  }
  if (a.activeId !== id) return { ...a, conversations: rest };
  return { conversations: rest, activeId: rest[Math.min(idx, rest.length - 1)].id };
}

/** 依最後更新時間排序（新到舊）供清單顯示。不動 archive 本身的順序。 */
export function sortedConversations(a: ChatArchive): ChatConversation[] {
  return [...a.conversations].sort((x, y) => y.updatedAt - x.updatedAt);
}

/**
 * 裁到可落地的大小：每串只留最近 MAX_MESSAGES 則訊息，整體只留最近動過的 MAX_CONVERSATIONS 串。
 * 作用中的那串一定留著（否則切回來會發現自己被丟了）。
 */
export function pruneArchive(a: ChatArchive, maxConversations = MAX_CONVERSATIONS): ChatArchive {
  const trimmed = a.conversations.map((c) =>
    c.messages.length > MAX_MESSAGES ? { ...c, messages: c.messages.slice(-MAX_MESSAGES) } : c,
  );
  if (trimmed.length <= maxConversations) return { ...a, conversations: trimmed };
  const byRecency = [...trimmed].sort((x, y) => y.updatedAt - x.updatedAt);
  const keep = new Set(byRecency.slice(0, maxConversations).map((c) => c.id));
  keep.add(a.activeId);
  return { ...a, conversations: trimmed.filter((c) => keep.has(c.id)) };
}

/** 讀回來的 JSON 不可信（手改過 / 舊版格式 / 半寫入）。補齊缺欄位、丟掉壞資料、保證恆有一串。 */
export function normalizeArchive(raw: unknown): ChatArchive {
  const obj = (raw ?? {}) as Partial<ChatArchive>;
  const list = Array.isArray(obj.conversations) ? obj.conversations : [];
  const conversations = list
    .filter((c): c is ChatConversation => !!c && typeof (c as ChatConversation).id === "string")
    .map((c) => ({
      id: c.id,
      title: typeof c.title === "string" ? c.title : "",
      messages: Array.isArray(c.messages)
        // pending 一律歸零：上次離開時若正在串流，重開後那則永遠等不到結果。
        ? c.messages.filter(Boolean).map((m) => ({ ...m, pending: false, tools: m.tools || [] }))
        : [],
      agentSessionId: typeof c.agentSessionId === "string" ? c.agentSessionId : null,
      agentProvider: typeof c.agentProvider === "string" ? c.agentProvider : null,
      connId: typeof c.connId === "string" ? c.connId : null,
      connName: typeof c.connName === "string" ? c.connName : null,
      createdAt: Number(c.createdAt) || Date.now(),
      updatedAt: Number(c.updatedAt) || Number(c.createdAt) || Date.now(),
    }));
  if (conversations.length === 0) {
    const fresh = newConversation();
    return { conversations: [fresh], activeId: fresh.id };
  }
  const activeId =
    typeof obj.activeId === "string" && conversations.some((c) => c.id === obj.activeId)
      ? obj.activeId
      : conversations[0].id;
  return { conversations, activeId };
}

/** 舊版單串格式（db-kit:assistantChat）的遷移來源。 */
export interface LegacyChat {
  messages?: ChatMsg[];
  sessionId?: string | null;
  sessionProvider?: string | null;
}

/**
 * 把舊版的單串對話收成第一串。升級後不該有人發現自己的對話不見了——
 * 即使它接下來會被關進清單裡的某一列。
 */
export function migrateLegacy(legacy: LegacyChat, now = Date.now()): ChatArchive {
  const c = newConversation({ id: null, name: null }, now);
  c.messages = (legacy.messages || []).map((m) => ({ ...m, pending: false, tools: m.tools || [] }));
  c.agentSessionId = legacy.sessionId ?? null;
  c.agentProvider = legacy.sessionProvider ?? null;
  return { conversations: [c], activeId: c.id };
}

/**
 * 寫回 localStorage。配額爆掉時**逐步丟掉最舊的對話再試**，而不是靜默放棄整份存檔——
 * 後者的後果是「這一輪之後的對話全部存不進去」，而且完全沒有徵兆。
 * 回傳實際落地的份數；一串都寫不進去（連當前這串都超額）回 0。
 */
export function saveArchive(a: ChatArchive, storage: Pick<Storage, "setItem"> = localStorage): number {
  let attempt = pruneArchive(a);
  for (;;) {
    try {
      storage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(attempt));
      return attempt.conversations.length;
    } catch {
      if (attempt.conversations.length <= 1) return 0;
      attempt = pruneArchive(attempt, attempt.conversations.length - 1);
    }
  }
}

/** 從 localStorage 讀回；沒有新版存檔時退回舊版單串格式做遷移。 */
export function loadArchive(
  storage: Pick<Storage, "getItem"> = localStorage,
  legacyKey = "db-kit:assistantChat",
): ChatArchive {
  try {
    const raw = storage.getItem(CHAT_SESSIONS_KEY);
    if (raw) return normalizeArchive(JSON.parse(raw));
  } catch { /* 壞掉的存檔當成沒有，往下走遷移 / 全新 */ }
  try {
    const legacy = storage.getItem(legacyKey);
    if (legacy) {
      const parsed = JSON.parse(legacy) as LegacyChat;
      if (parsed.messages?.length) return migrateLegacy(parsed);
    }
  } catch { /* 同上 */ }
  const fresh = newConversation();
  return { conversations: [fresh], activeId: fresh.id };
}
