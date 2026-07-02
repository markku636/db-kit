import { describe, it, expect } from "vitest";
import { isNewer } from "./updateCheck";

describe("版本比較（isNewer）", () => {
  it("數值比較而非字典序：0.2.10 比 0.2.9 新", () => {
    expect(isNewer("0.2.10", "0.2.9")).toBe(true);
    expect(isNewer("0.2.9", "0.2.10")).toBe(false);
  });

  it("相同版本不算新", () => {
    expect(isNewer("0.2.4", "0.2.4")).toBe(false);
  });

  it("較舊 / 較新的一般情境", () => {
    expect(isNewer("0.2.5", "0.2.4")).toBe(true);
    expect(isNewer("0.2.3", "0.2.4")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.3.0", "0.2.99")).toBe(true);
  });

  it("忽略開頭的 v 前綴（大小寫皆可）", () => {
    expect(isNewer("v0.2.5", "0.2.4")).toBe(true);
    expect(isNewer("0.2.5", "v0.2.4")).toBe(true);
    expect(isNewer("V0.2.4", "v0.2.4")).toBe(false);
  });

  it("砍掉 pre-release / build metadata 後比較主版本", () => {
    // 1.0.0-beta 的主版本 1.0.0 > 0.9.9
    expect(isNewer("1.0.0-beta", "0.9.9")).toBe(true);
    // 主版本相同（pre-release 與 build 一律忽略）→ 不算新
    expect(isNewer("1.0.0-beta", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0+build.5", "1.0.0")).toBe(false);
  });

  it("段數不同時缺的補 0", () => {
    expect(isNewer("0.3", "0.2.9")).toBe(true);
    expect(isNewer("0.2", "0.2.0")).toBe(false);
    expect(isNewer("0.2.1", "0.2")).toBe(true);
  });

  it("無法解析的段以 0 計，不丟例外", () => {
    expect(isNewer("", "0.0.0")).toBe(false);
    expect(isNewer("0.2.x", "0.2.0")).toBe(false);
  });
});
