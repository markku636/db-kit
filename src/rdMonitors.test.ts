import { describe, expect, it } from "vitest";
import { canShowAll, displayBounds, miniLayout, versionAtLeast, type RdDisplay, type RdMonitors } from "./rdMonitors";

// 主螢幕 1920×1080 在 0,0；第二個 1280×1024 擺在左邊（x 是負的）、往下錯開 56。
const TWO: RdDisplay[] = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: -1280, y: 56, width: 1280, height: 1024 },
];

describe("versionAtLeast", () => {
  it("1.2.4 起才能同時看好幾個螢幕", () => {
    expect(versionAtLeast("1.4.9", "1.2.4")).toBe(true);
    expect(versionAtLeast("1.2.4", "1.2.4")).toBe(true);
    expect(versionAtLeast("1.2.3", "1.2.4")).toBe(false);
    expect(versionAtLeast("1.1.10", "1.2.4")).toBe(false);
    expect(versionAtLeast("1.10.0", "1.2.4")).toBe(true);
  });
  it("看不懂的版本當成新版", () => {
    expect(versionAtLeast("", "1.2.4")).toBe(true);
    expect(versionAtLeast(undefined, "1.2.4")).toBe(true);
    expect(versionAtLeast("nightly", "1.2.4")).toBe(true);
  });
});

describe("displayBounds", () => {
  it("合起來的外框（含負座標）", () => {
    expect(displayBounds(TWO, [0, 1])).toEqual({ x: -1280, y: 0, w: 3200, h: 1080 });
    expect(displayBounds(TWO, [1])).toEqual({ x: -1280, y: 56, w: 1280, h: 1024 });
  });
  it("缺大小或沒有螢幕 → null", () => {
    expect(displayBounds([{ x: 0, y: 0, width: 0, height: 0 }, TWO[0]], [0, 1])).toBeNull();
    expect(displayBounds(TWO, [])).toBeNull();
    expect(displayBounds(TWO, [5])).toBeNull();
  });
});

describe("canShowAll", () => {
  const m = (over: Partial<RdMonitors>): RdMonitors => ({ displays: TWO, shown: [0], multi: true, ...over });
  it("對方支援、兩個以上、都有大小才給「所有螢幕」", () => {
    expect(canShowAll(m({}))).toBe(true);
    expect(canShowAll(m({ multi: false }))).toBe(false);
    expect(canShowAll(m({ displays: [TWO[0]] }))).toBe(false);
    expect(canShowAll(m({ displays: [TWO[0], { x: 0, y: 0, width: 0, height: 0 }] }))).toBe(false);
  });
});

describe("miniLayout", () => {
  it("照實際排列縮進圖示框：左邊的螢幕畫在左邊，比例不變、置中", () => {
    const [a, b] = miniLayout(TWO, 16, 12, 0);
    expect(b.x).toBeLessThan(a.x);
    expect(a.w / a.h).toBeCloseTo(1920 / 1080, 5);
    // 外框 3200×1080 縮到寬 16 → 高 5.4，上下各留 (12 - 5.4) / 2
    expect(b.x).toBeCloseTo(0, 5);
    expect(a.x + a.w).toBeCloseTo(16, 5);
    expect(a.y).toBeCloseTo((12 - 5.4) / 2, 5);
  });
  it("縫讓相鄰螢幕分得開；算不出來就空的", () => {
    const [a, b] = miniLayout(TWO, 16, 12, 1);
    expect(b.x + b.w).toBeLessThan(a.x);
    expect(miniLayout([{ x: 0, y: 0, width: 0, height: 0 }], 16, 12)).toEqual([]);
  });
});
