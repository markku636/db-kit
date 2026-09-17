import { describe, expect, it } from "vitest";
import type { ChatMsg } from "./chatTypes";
import {
  activeConversation,
  addConversation,
  CHAT_SESSIONS_KEY,
  conversationTitle,
  loadArchive,
  migrateLegacy,
  newConversation,
  normalizeArchive,
  pruneArchive,
  removeConversation,
  saveArchive,
  sortedConversations,
  updateConversation,
  type ChatArchive,
} from "./chatSessions";

const msg = (role: "user" | "assistant", text: string): ChatMsg => ({
  id: crypto.randomUUID(),
  role,
  text,
  tools: [],
  pending: false,
  error: false,
});

/** 只實作本模組會用到的兩支方法的假 storage。 */
function fakeStorage(limit = Infinity) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new DOMException("quota", "QuotaExceededError");
      map.set(k, v);
    },
  };
}

describe("conversationTitle", () => {
  it("沒有訊息也沒取名時回 null（由 UI 決定佔位字樣）", () => {
    expect(conversationTitle(newConversation())).toBeNull();
  });
  it("從第一則使用者訊息推導，只取第一行", () => {
    const c = newConversation();
    c.messages = [msg("assistant", "你好"), msg("user", "訂單表有哪些欄位？\nSELECT * FROM orders")];
    expect(conversationTitle(c)).toBe("訂單表有哪些欄位？");
  });
  it("過長時截斷並加省略號", () => {
    const c = newConversation();
    c.messages = [msg("user", "a".repeat(80))];
    expect(conversationTitle(c)).toBe(`${"a".repeat(32)}…`);
  });
  it("手動取過名就以它為準（改了第一則訊息也不會跳掉）", () => {
    const c = { ...newConversation(), title: "庫存盤點" };
    c.messages = [msg("user", "訂單表有哪些欄位？")];
    expect(conversationTitle(c)).toBe("庫存盤點");
  });
});

describe("多對話的增刪切換", () => {
  it("新增即切換過去", () => {
    const a0 = normalizeArchive(null);
    const c = newConversation();
    const a1 = addConversation(a0, c);
    expect(a1.activeId).toBe(c.id);
    expect(a1.conversations).toHaveLength(2);
  });

  it("刪掉作用中的那串會接手下一串，而不是留下一個指不到的 activeId", () => {
    const a = removeConversation(
      { conversations: [newConversation(), newConversation(), newConversation()], activeId: "" } as ChatArchive,
      "nope",
    );
    expect(a.conversations).toHaveLength(3); // 找不到就原樣

    const list = [newConversation(), newConversation(), newConversation()];
    const before: ChatArchive = { conversations: list, activeId: list[1].id };
    const after = removeConversation(before, list[1].id);
    expect(after.conversations.map((c) => c.id)).toEqual([list[0].id, list[2].id]);
    expect(after.activeId).toBe(list[2].id);
    expect(activeConversation(after).id).toBe(list[2].id);
  });

  it("刪到一串不剩時自動補一串空的（面板永遠要有地方可以打字）", () => {
    const only = newConversation();
    const after = removeConversation({ conversations: [only], activeId: only.id }, only.id);
    expect(after.conversations).toHaveLength(1);
    expect(after.conversations[0].id).not.toBe(only.id);
    expect(after.activeId).toBe(after.conversations[0].id);
  });

  it("更新某一串會推進 updatedAt，且不動到其他串", () => {
    const a = normalizeArchive(null);
    const id = a.activeId;
    const next = updateConversation(a, id, (c) => ({ ...c, messages: [msg("user", "hi")] }), 5_000);
    expect(next.conversations[0].messages).toHaveLength(1);
    expect(next.conversations[0].updatedAt).toBe(5_000);
    // 找不到 id 時原樣回傳（不可憑空生出一串）。
    expect(updateConversation(a, "nope", (c) => c)).toBe(a);
  });

  it("清單依最後更新時間排序，不動 archive 本身的順序", () => {
    const [x, y, z] = [newConversation(), newConversation(), newConversation()];
    const a: ChatArchive = {
      conversations: [{ ...x, updatedAt: 1 }, { ...y, updatedAt: 3 }, { ...z, updatedAt: 2 }],
      activeId: x.id,
    };
    expect(sortedConversations(a).map((c) => c.id)).toEqual([y.id, z.id, x.id]);
    expect(a.conversations.map((c) => c.id)).toEqual([x.id, y.id, z.id]);
  });
});

describe("pruneArchive", () => {
  it("每串只留最近 60 則訊息", () => {
    const c = newConversation();
    c.messages = Array.from({ length: 75 }, (_, i) => msg("user", `m${i}`));
    const out = pruneArchive({ conversations: [c], activeId: c.id });
    expect(out.conversations[0].messages).toHaveLength(60);
    expect(out.conversations[0].messages[0].text).toBe("m15");
  });

  it("超過上限時丟最久沒動的，但作用中的那串一定留著", () => {
    const list = Array.from({ length: 8 }, (_, i) => ({ ...newConversation(), updatedAt: i }));
    const stale = list[0]; // updatedAt 最小 → 本該最先被丟
    const out = pruneArchive({ conversations: list, activeId: stale.id }, 3);
    const ids = out.conversations.map((c) => c.id);
    expect(ids).toContain(stale.id);
    expect(out.conversations).toHaveLength(4); // 最近 3 串 + 被保住的作用中那串
  });
});

describe("normalizeArchive", () => {
  it("空 / 壞輸入一律給出一串可用的空對話", () => {
    for (const bad of [null, undefined, {}, { conversations: "nope" }, { conversations: [null, 3] }]) {
      const a = normalizeArchive(bad);
      expect(a.conversations).toHaveLength(1);
      expect(a.activeId).toBe(a.conversations[0].id);
    }
  });

  it("activeId 指不到任何一串時退回第一串", () => {
    const c = newConversation();
    expect(normalizeArchive({ conversations: [c], activeId: "ghost" }).activeId).toBe(c.id);
  });

  it("重開後不留下永遠等不到結果的 pending 訊息", () => {
    const c = newConversation();
    c.messages = [{ ...msg("assistant", ""), pending: true }];
    expect(normalizeArchive({ conversations: [c], activeId: c.id }).conversations[0].messages[0].pending).toBe(false);
  });
});

describe("舊版單串對話的遷移", () => {
  it("migrateLegacy 把舊對話收成第一串並保留 session id", () => {
    const a = migrateLegacy({ messages: [msg("user", "舊的問題")], sessionId: "s1", sessionProvider: "claude" });
    expect(a.conversations).toHaveLength(1);
    expect(a.conversations[0].messages[0].text).toBe("舊的問題");
    expect(a.conversations[0].agentSessionId).toBe("s1");
    expect(a.conversations[0].agentProvider).toBe("claude");
    expect(a.activeId).toBe(a.conversations[0].id);
  });

  it("loadArchive 沒有新版存檔時吃舊版的鍵（升級後對話不該憑空消失）", () => {
    const s = fakeStorage();
    s.map.set("db-kit:assistantChat", JSON.stringify({ messages: [msg("user", "升級前問的")], sessionId: "s9" }));
    const a = loadArchive(s);
    expect(a.conversations[0].messages[0].text).toBe("升級前問的");
    expect(a.conversations[0].agentSessionId).toBe("s9");
  });

  it("舊版存檔是空的就當成全新（不生出一串空殼歷史）", () => {
    const s = fakeStorage();
    s.map.set("db-kit:assistantChat", JSON.stringify({ messages: [] }));
    expect(loadArchive(s).conversations[0].messages).toEqual([]);
  });

  it("壞掉的 JSON 不可讓面板開不起來", () => {
    const s = fakeStorage();
    s.map.set(CHAT_SESSIONS_KEY, "{不是 JSON");
    const a = loadArchive(s);
    expect(a.conversations).toHaveLength(1);
  });
});

describe("saveArchive 的配額退讓", () => {
  it("正常情況整份寫入並回落地份數", () => {
    const s = fakeStorage();
    const a: ChatArchive = { conversations: [newConversation(), newConversation()], activeId: "" };
    expect(saveArchive({ ...a, activeId: a.conversations[0].id }, s)).toBe(2);
    expect(JSON.parse(s.map.get(CHAT_SESSIONS_KEY)!).conversations).toHaveLength(2);
  });

  it("配額爆掉時逐步丟最舊的再試，而不是整份放棄", () => {
    const big = (i: number) => {
      const c = newConversation();
      c.updatedAt = i;
      c.messages = [msg("user", "x".repeat(400))];
      return c;
    };
    const list = [big(1), big(2), big(3)];
    // 上限只放得下大約一串的量。
    const s = fakeStorage(900);
    const saved = saveArchive({ conversations: list, activeId: list[2].id }, s);
    expect(saved).toBeGreaterThan(0);
    expect(saved).toBeLessThan(3);
    // 留下來的必須含作用中的那串。
    const kept = JSON.parse(s.map.get(CHAT_SESSIONS_KEY)!) as ChatArchive;
    expect(kept.conversations.some((c) => c.id === list[2].id)).toBe(true);
  });

  it("連一串都塞不下時回 0（呼叫端據此提醒使用者）", () => {
    const c = newConversation();
    c.messages = [msg("user", "y".repeat(5000))];
    expect(saveArchive({ conversations: [c], activeId: c.id }, fakeStorage(100))).toBe(0);
  });
});
