import { describe, it, expect } from "vitest";
import { formatRedisKeyForCopy, isSupportedRedisKeyType, redisPageHint, buildRedisKeyExport, mergeRedisKeyExports } from "./redisKeyValueFormat";

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

  it("過濾後只匯出部分成員也要標 partial，避免匯回刪掉完整鍵", () => {
    const s = JSON.parse(buildRedisKeyExport("h", page({
      type_: "hash", ttl: -1, total: 1000, cursor: 0, fields: ["a"], members: ["1"],
    })));
    expect(s[0].exported).toBe(1);
    expect(s[0].partial).toBe(true);
    const l = JSON.parse(buildRedisKeyExport("l", page({
      type_: "list", ttl: -1, total: 100, cursor: 0, members: ["v"],
    })));
    expect(l[0].partial).toBe(true);
    // 沒過濾、全部載到 → 可安全匯回。
    const full = JSON.parse(buildRedisKeyExport("h2", page({
      type_: "hash", ttl: -1, total: 1, cursor: 0, fields: ["a"], members: ["1"],
    })));
    expect(full[0].partial).toBe(false);
  });

  it("zset 的 ±inf 分數寫成字面字串，不會被 JSON.stringify 變成 null", () => {
    const s = JSON.parse(buildRedisKeyExport("z", page({
      type_: "zset", ttl: -1, total: 2, cursor: 0, members: ["hi", "lo"], scores: [Infinity, -Infinity],
    })));
    expect(s[0].value).toEqual([
      { member: "hi", score: "+inf" },
      { member: "lo", score: "-inf" },
    ]);
  });

  it("輸出為可供後端匯入的單元素陣列，依型別帶不同 value 結構", () => {
    const h = JSON.parse(buildRedisKeyExport("h", page({
      type_: "hash", ttl: -1, total: 1, cursor: 0, fields: ["a"], members: ["1"],
    })));
    expect(Array.isArray(h)).toBe(true);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ key: "h", type: "hash", ttl: -1, total: 1, partial: false });
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

describe("mergeRedisKeyExports", () => {
  it("合併成單一可匯回的陣列，並略過壞掉的片段", () => {
    const a = buildRedisKeyExport("a", page({ type_: "string", members: ["1"] }));
    const b = buildRedisKeyExport("b", page({ type_: "list", members: ["x", "y"], total: 2 }));
    const merged = JSON.parse(mergeRedisKeyExports([a, "not json", b]));
    expect(merged).toHaveLength(2);
    expect(merged.map((k: any) => k.key)).toEqual(["a", "b"]);
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
