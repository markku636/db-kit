import { describe, expect, it } from "vitest";
import {
  addMyChat, applyEvent, canRestart, DEFAULT_PREFS, initialState, isWindowsPeer, MAX_CHAT, prefsFromUi, prefsToUi,
} from "./rustdeskState";

describe("prefs（存在主機的 options.ui）", () => {
  it("沒存過 / 存了怪值 → 預設", () => {
    expect(prefsFromUi(undefined)).toEqual(DEFAULT_PREFS);
    expect(prefsFromUi({ rustdesk_quality: "ultra", rustdesk_view: "zoom", rustdesk_codec: "h264" })).toEqual(DEFAULT_PREFS);
  });
  it("來回一樣；跟預設一樣的不寫進檔案；別的鍵保留", () => {
    const p = { view: "original", quality: "low", codec: "vp8", stats: true, lockAfterEnd: true } as const;
    const ui = prefsToUi(p, { fullscreen: "1" });
    expect(ui).toEqual({
      fullscreen: "1", rustdesk_view: "original", rustdesk_quality: "low", rustdesk_codec: "vp8",
      rustdesk_stats: "1", rustdesk_lock_after_end: "1",
    });
    expect(prefsFromUi(ui)).toEqual(p);
    expect(prefsToUi(DEFAULT_PREFS, ui)).toEqual({ fullscreen: "1" });
  });
});

describe("applyEvent", () => {
  it("connected：對方系統 / 版本，權限重設為全開", () => {
    let s = initialState();
    s = applyEvent(s, { type: "permission", name: "keyboard", enabled: false }).state;
    s = applyEvent(s, { type: "connected", peer: { platform: "Windows", version: "1.4.9" } }).state;
    expect([s.platform, s.version, s.perms.keyboard]).toEqual(["Windows", "1.4.9", true]);
    expect(isWindowsPeer(s)).toBe(true);
  });

  it("權限：一開始只送被關掉的；沒變就回同一個物件；不認得的忽略", () => {
    const s0 = initialState();
    const s1 = applyEvent(s0, { type: "permission", name: "restart", enabled: false }).state;
    expect(s1.perms.restart).toBe(false);
    expect(s1.perms.keyboard).toBe(true);
    expect(applyEvent(s1, { type: "permission", name: "restart", enabled: false }).state).toBe(s1);
    expect(applyEvent(s1, { type: "permission", name: "teleport", enabled: false }).state).toBe(s1);
  });

  it("重新啟動只給 Windows / Linux / macOS 且有權限的對方", () => {
    const s = { ...initialState(), platform: "Linux" };
    expect(canRestart(s)).toBe(true);
    expect(canRestart({ ...s, platform: "Android" })).toBe(false);
    expect(canRestart({ ...s, perms: { ...s.perms, restart: false } })).toBe(false);
  });

  it("聊天：對方的訊息排在後面；自己的也記；最多留 MAX_CHAT 則", () => {
    let s = applyEvent(initialState(), { type: "chat", text: "在嗎" }, 1000).state;
    s = addMyChat(s, "在", 2000);
    expect(s.chat).toEqual([{ from: "peer", text: "在嗎", at: 1000 }, { from: "me", text: "在", at: 2000 }]);
    expect(applyEvent(s, { type: "chat", text: "" }).state).toBe(s);
    for (let i = 0; i < MAX_CHAT + 5; i++) s = addMyChat(s, String(i));
    expect(s.chat.length).toBe(MAX_CHAT);
    expect(s.chat[s.chat.length - 1].text).toBe(String(MAX_CHAT + 4));
  });

  it("封鎖輸入：成功才改狀態；失敗回提示", () => {
    const s = initialState();
    expect(applyEvent(s, { type: "block_input", on: true, ok: true }).state.blockInput).toBe(true);
    const r = applyEvent(s, { type: "block_input", on: true, ok: false });
    expect(r.state.blockInput).toBe(false);
    expect(r.notice).toBe("block_on_failed");
  });

  it("延遲：只在顯示連線品質時記", () => {
    const s = initialState();
    expect(applyEvent(s, { type: "delay", ms: 30 }).state).toBe(s);
    const on = { ...s, stats: { fps: 30, kbps: 100, delay: null, codec: "VP9", width: 1920, height: 1080 } };
    expect(applyEvent(on, { type: "delay", ms: 30 }).state.stats?.delay).toBe(30);
  });
});
