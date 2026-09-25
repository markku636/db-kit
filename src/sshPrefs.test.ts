import { describe, it, expect, beforeEach } from "vitest";

// node 測試環境無 localStorage，提供最小記憶體實作（須在 import 受測模組前備妥：store 載入時就讀偏好）。
const __mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in __mem ? __mem[k] : null),
  setItem: (k: string, v: string) => { __mem[k] = String(v); },
  removeItem: (k: string) => { delete __mem[k]; },
  clear: () => { for (const k of Object.keys(__mem)) delete __mem[k]; },
  key: () => null,
  length: 0,
} as unknown as Storage;

const {
  DEFAULT_SSH_PREFS, normalizeSshPrefs, useSshPrefs, pickPrefs,
  loadComposeHistory, pushComposeHistory, COMPOSE_HISTORY_MAX,
} = await import("./sshPrefs");

describe("normalizeSshPrefs", () => {
  it("非物件 / 空物件 → 預設值", () => {
    for (const junk of [null, undefined, "x", 5, [], {}]) {
      expect(normalizeSshPrefs(junk)).toEqual(DEFAULT_SSH_PREFS);
    }
  });

  it("scrollback 夾在 500–50000，非數字退回預設", () => {
    expect(normalizeSshPrefs({ scrollback: 10 }).scrollback).toBe(500);
    expect(normalizeSshPrefs({ scrollback: 999999 }).scrollback).toBe(50000);
    expect(normalizeSshPrefs({ scrollback: "1234" }).scrollback).toBe(1234);
    expect(normalizeSshPrefs({ scrollback: 1234.6 }).scrollback).toBe(1235);
    expect(normalizeSshPrefs({ scrollback: "abc" }).scrollback).toBe(DEFAULT_SSH_PREFS.scrollback);
  });

  it("renderer 只認 auto / dom，其餘 auto；布林欄位非布林退回預設", () => {
    expect(normalizeSshPrefs({ renderer: "dom" }).renderer).toBe("dom");
    expect(normalizeSshPrefs({ renderer: "webgl" }).renderer).toBe("auto");
    expect(normalizeSshPrefs({ copyOnSelect: "yes", rightClickPaste: 0 })).toMatchObject({
      copyOnSelect: false,
      rightClickPaste: true,
    });
    expect(normalizeSshPrefs({ copyOnSelect: true, cursorBlink: false })).toMatchObject({ copyOnSelect: true, cursorBlink: false });
  });
});

describe("useSshPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
    useSshPrefs.setState({ ...DEFAULT_SSH_PREFS });
  });

  it("set 局部更新並持久化到 dbkit:ssh.prefs（經 normalize）", () => {
    useSshPrefs.getState().set({ scrollback: 100000, renderer: "dom" });
    expect(useSshPrefs.getState().scrollback).toBe(50000);
    expect(useSshPrefs.getState().renderer).toBe("dom");
    expect(useSshPrefs.getState().copyOnSelect).toBe(false);
    expect(JSON.parse(localStorage.getItem("dbkit:ssh.prefs")!)).toEqual(pickPrefs(useSshPrefs.getState()));
  });
});

describe("命令列歷史", () => {
  beforeEach(() => localStorage.clear());

  it("空白不記、連續重複不記、舊 → 新排序", () => {
    expect(pushComposeHistory("   ")).toEqual([]);
    pushComposeHistory("ls");
    pushComposeHistory("ls");
    pushComposeHistory("pwd  ");
    pushComposeHistory("ls");
    expect(loadComposeHistory()).toEqual(["ls", "pwd", "ls"]);
  });

  it("超過上限丟最舊的", () => {
    for (let i = 0; i < COMPOSE_HISTORY_MAX + 5; i++) pushComposeHistory(`cmd ${i}`);
    const h = loadComposeHistory();
    expect(h).toHaveLength(COMPOSE_HISTORY_MAX);
    expect(h[0]).toBe("cmd 5");
    expect(h[h.length - 1]).toBe(`cmd ${COMPOSE_HISTORY_MAX + 4}`);
  });

  it("存檔損毀退回空清單", () => {
    localStorage.setItem("dbkit:ssh.composeHistory", "{not json");
    expect(loadComposeHistory()).toEqual([]);
    localStorage.setItem("dbkit:ssh.composeHistory", JSON.stringify(["a", 1, null, "b"]));
    expect(loadComposeHistory()).toEqual(["a", "b"]);
  });
});
