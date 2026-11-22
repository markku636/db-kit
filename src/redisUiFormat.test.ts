import { describe, it, expect } from "vitest";
import { fmtUptime, compareSegments, effectiveRedisDb } from "./redisUiFormat";

describe("fmtUptime", () => {
  it("不到一分鐘顯示秒數，不再顯示 0m", () => {
    expect(fmtUptime("45")).toBe("45s");
    expect(fmtUptime("90")).toBe("1m");
    expect(fmtUptime("59")).toBe("59s");
  });
  it("分鐘 / 小時 / 天照舊", () => {
    expect(fmtUptime("3600")).toBe("1h 0m");
    expect(fmtUptime("3661")).toBe("1h 1m");
    expect(fmtUptime("90061")).toBe("1d 1h");
  });
  it("缺值或 0 顯示破折號", () => {
    expect(fmtUptime(undefined)).toBe("—");
    expect(fmtUptime("0")).toBe("—");
    expect(fmtUptime("abc")).toBe("—");
  });
});

describe("effectiveRedisDb", () => {
  it("用連線設定的 DB 索引，沒設定或不在清單裡退回第一個", () => {
    expect(effectiveRedisDb("2", ["0", "1", "2"])).toBe("2");
    expect(effectiveRedisDb("9", ["0", "1", "2"])).toBe("0");
    expect(effectiveRedisDb(null, ["0", "3"])).toBe("0");
    expect(effectiveRedisDb("", [])).toBe("0");
  });
});

describe("compareSegments", () => {
  it("數字片段用自然排序：user:2 在 user:10 前面", () => {
    expect(["user:10", "user:2", "user:1"].sort(compareSegments)).toEqual(["user:1", "user:2", "user:10"]);
    expect(["s100", "s2", "s10"].sort(compareSegments)).toEqual(["s2", "s10", "s100"]);
  });
});
