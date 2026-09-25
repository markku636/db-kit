import { describe, it, expect } from "vitest";
import {
  EMPTY_SELECTION, clickSelect, contextSelect, moveSelect, pruneSelection, selectAll, selectedInOrder, single,
} from "./sftpSelection";

const order = ["app", "logs", "a.txt", "b.txt", "c.txt"];
const names = (s: { names: ReadonlySet<string> }) => [...s.names].sort();
const none = { ctrl: false, shift: false };

describe("clickSelect", () => {
  it("單擊只選這一個", () => {
    const s = clickSelect(single("app"), "b.txt", none, order);
    expect(names(s)).toEqual(["b.txt"]);
    expect(s.anchor).toBe("b.txt");
  });

  it("Ctrl 單擊切換，錨點跟著移", () => {
    let s = clickSelect(single("app"), "b.txt", { ctrl: true, shift: false }, order);
    expect(names(s)).toEqual(["app", "b.txt"]);
    s = clickSelect(s, "app", { ctrl: true, shift: false }, order);
    expect(names(s)).toEqual(["b.txt"]);
    expect(s.anchor).toBe("app");
  });

  it("Shift 單擊從錨點選到這裡（往上往下都行），錨點不動", () => {
    let s = clickSelect(single("logs"), "c.txt", { ctrl: false, shift: true }, order);
    expect(selectedInOrder(s, order)).toEqual(["logs", "a.txt", "b.txt", "c.txt"]);
    expect(s.anchor).toBe("logs");
    s = clickSelect(single("b.txt"), "app", { ctrl: false, shift: true }, order);
    expect(selectedInOrder(s, order)).toEqual(["app", "logs", "a.txt", "b.txt"]);
  });

  it("Shift+Ctrl 把範圍加進既有選取", () => {
    let s = clickSelect(single("app"), "c.txt", { ctrl: true, shift: false }, order); // app + c.txt, anchor c.txt
    s = clickSelect(s, "b.txt", { ctrl: true, shift: true }, order);
    expect(selectedInOrder(s, order)).toEqual(["app", "b.txt", "c.txt"]);
  });

  it("沒有錨點（或錨點已不在清單）時 Shift 退回單選", () => {
    expect(names(clickSelect(EMPTY_SELECTION, "a.txt", { ctrl: false, shift: true }, order))).toEqual(["a.txt"]);
    expect(names(clickSelect(single("gone"), "a.txt", { ctrl: false, shift: true }, order))).toEqual(["a.txt"]);
  });
});

describe("contextSelect / selectAll / prune / move", () => {
  it("右鍵點在選取裡 → 保留整組；點在外面 → 只選它", () => {
    const group = selectAll(["a.txt", "b.txt"]);
    expect(contextSelect(group, "b.txt")).toBe(group);
    expect(names(contextSelect(group, "logs"))).toEqual(["logs"]);
  });

  it("清單變了就丟掉看不到的名稱；沒變就回同一個物件（不觸發重繪）", () => {
    const s = selectAll(["a.txt", "b.txt"]);
    expect(pruneSelection(s, order)).toBe(s);
    const p = pruneSelection(s, ["b.txt", "logs"]);
    expect(names(p)).toEqual(["b.txt"]);
    expect(p.anchor).toBe("b.txt");
    expect(pruneSelection(s, [])).toEqual({ names: new Set(), anchor: null });
  });

  it("方向鍵移動錨點；Shift 延伸；邊界停住", () => {
    expect(moveSelect(single("app"), 1, order, false)).toEqual(single("logs"));
    expect(moveSelect(single("app"), -1, order, false)).toEqual(single("app"));
    expect(moveSelect(EMPTY_SELECTION, 1, order, false)).toEqual(single("app"));
    const ext = moveSelect(single("a.txt"), 1, order, true);
    expect(selectedInOrder(ext, order)).toEqual(["a.txt", "b.txt"]);
    expect(moveSelect(single("x"), 1, [], false)).toEqual(EMPTY_SELECTION);
  });
});
