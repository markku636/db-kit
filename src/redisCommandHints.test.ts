import { describe, it, expect } from "vitest";
import { completeRedisCommand, isBlockingKeysCommand, redisCommandHint } from "./redisCommandHints";

describe("redisCommandHint", () => {
  it("完整的指令名稱給語法（不分大小寫、可帶 DB 前綴）", () => {
    expect(redisCommandHint("hset user:1 name")).toMatchObject({ command: "HSET", syntax: "key field value [field value ...]" });
    expect(redisCommandHint("3:get k").command).toBe("GET");
  });
  it("打一半給候選，短的排前面", () => {
    const c = redisCommandHint("hg").candidates;
    expect(c[0]).toBe("HGET");
    expect(c).toContain("HGETALL");
  });
  it("未知指令後已經打了空白就不再給候選", () => {
    expect(redisCommandHint("FOO bar")).toEqual({ command: null, syntax: null, candidates: [] });
  });
  it("RedisJSON 的點號指令也認得", () => {
    expect(redisCommandHint("json.get k").command).toBe("JSON.GET");
  });
});

describe("completeRedisCommand", () => {
  it("補完第一個字詞並保留 DB 前綴", () => {
    expect(completeRedisCommand("hgeta")).toBe("HGETALL ");
    expect(completeRedisCommand("2:zr")).toBe("2:ZREM ");
  });
  it("已經在打參數、或沒有候選時不動", () => {
    expect(completeRedisCommand("GET k")).toBeNull();
    expect(completeRedisCommand("qqq")).toBeNull();
  });
});

describe("isBlockingKeysCommand", () => {
  it("認得 KEYS（含 DB 前綴），不誤判其他指令", () => {
    expect(isBlockingKeysCommand("KEYS *")).toBe(true);
    expect(isBlockingKeysCommand("1:keys user:*")).toBe(true);
    expect(isBlockingKeysCommand("HKEYS h")).toBe(false);
    expect(isBlockingKeysCommand("SCAN 0")).toBe(false);
  });
});
