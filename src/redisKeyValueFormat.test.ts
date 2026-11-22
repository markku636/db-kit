import { describe, it, expect } from "vitest";
import { formatRedisKeyForCopy, isSupportedRedisKeyType, redisPageHint, buildRedisKeyExport } from "./redisKeyValueFormat";

const page = (over: Record<string, unknown>) => ({
  type_: "string", total: 0, ttl: -1, cursor: 0, truncated: false, fields: [], members: [], scores: [], ...over,
});

describe("isSupportedRedisKeyType", () => {
  it("認得後端實作的型別", () => {
    for (const t of ["none", "string", "list", "set", "hash", "zset", "stream"]) {
      expect(isSupportedRedisKeyType(t)).toBe(true);
    }
  });
  it("模組型別不該被當成空集合渲染", () => {
    for (const t of ["ReJSON-RL", "TSDB-TYPE", "MBullet", ""]) {
      expect(isSupportedRedisKeyType(t)).toBe(false);
    }
  });
});

describe("buildRedisKeyExport", () => {
  it("大 string 只載到預覽時標 partial，避免匯回覆蓋完整值", () => {
    const s = JSON.parse(buildRedisKeyExport("k", page({
      type_: "string", ttl: -1, members: ["prefix"], truncated: true,
    })));
    expect(s[0].partial).toBe(true);
    const full = JSON.parse(buildRedisKeyExport("k", page({
      type_: "string", ttl: -1, members: ["value"], truncated: false,
    })));
    expect(full[0].partial).toBe(false);
  });

  it("輸出為可供後端匯入的單元素陣列，依型別帶不同 value 結構", () => {
    const h = JSON.parse(buildRedisKeyExport("h", page({
      type_: "hash", ttl: -1, total: 2, cursor: 0, fields: ["a"], members: ["1"],
    })));
    expect(Array.isArray(h)).toBe(true);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ key: "h", type: "hash", ttl: -1, total: 2, partial: false });
    expect(h[0].value).toEqual([{ field: "a", value: "1" }]);
    const z = JSON.parse(buildRedisKeyExport("z", page({
      type_: "zset", ttl: 60, total: 2, cursor: 1, members: ["m"], scores: [2],
    })));
    expect(z[0].value).toEqual([{ member: "m", score: 2 }]);
    expect(z[0].partial).toBe(true);
    const s = JSON.parse(buildRedisKeyExport("s", page({ type_: "string", ttl: 5, total: 1, cursor: 0, members: ["v"] })));
    expect(s[0].value).toBe("v");
    expect(s[0].partial).toBe(false);
  });
});

describe("redisPageHint", () => {
  it("過濾後整頁無符合但還有更多時明確提示，不是單純的 0 筆", () => {
    expect(redisPageHint(true, 0, true)).toBe("此頁沒有符合的項目，但還有更多未掃描；繼續載入或清除過濾。");
    expect(redisPageHint(true, 0, false)).toBe("已載入 {count} 筆");
    expect(redisPageHint(true, 3, true)).toBe("已載入 {count} 筆");
    expect(redisPageHint(false, 0, true)).toBe("已載入 {count} 筆");
  });
});

describe("formatRedisKeyForCopy", () => {
  it("string 取完整值，不顯示筆數", () => {
    expect(formatRedisKeyForCopy(page({ members: ["hello"], total: 1 }))).toEqual({
      text: "hello", shown: 0, partial: false,
    });
  });
  it("hash 帶 field=、zset 帶 score", () => {
    expect(formatRedisKeyForCopy(page({
      type_: "hash", fields: ["name", "age"], members: ["Ann", "30"], total: 2,
    })).text).toBe("name=Ann\nage=30");
    expect(formatRedisKeyForCopy(page({
      type_: "zset", members: ["a", "b"], scores: [1.5, 2], total: 2,
    })).text).toBe("1.5 a\n2 b");
  });
  it("stream 保留每筆 ID，不再只貼出沒有身份的 JSON", () => {
    expect(formatRedisKeyForCopy(page({
      type_: "stream", fields: ["1700000000000-0", "1700000000001-0"],
      members: ['{"a":1}', '{"b":2}'], total: 2,
    })).text).toBe('1700000000000-0 {"a":1}\n1700000000001-0 {"b":2}');
  });
  it("list / set 照舊每行一個成員", () => {
    expect(formatRedisKeyForCopy(page({ type_: "list", members: ["x", "y"], total: 2 })).text).toBe("x\ny");
  });
  it("只複製到第一頁時標 partial（string 永遠不算）", () => {
    const r = formatRedisKeyForCopy(page({ type_: "hash", fields: ["a"], members: ["1"], total: 5000 }));
    expect(r.partial).toBe(true);
    expect(r.shown).toBe(1);
    expect(formatRedisKeyForCopy(page({ members: ["x"], total: 5000 })).partial).toBe(false);
  });
});
