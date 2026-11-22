import { describe, it, expect } from "vitest";
import { loadRedisDbNames, redisDbLabel, serializeRedisDbNames, setRedisDbName } from "./redisDbNames";

describe("redisDbNames", () => {
  it("set / get：不同連線的同名 DB 各自獨立", () => {
    let m = setRedisDbName({}, "conn-a", "0", "  production  ");
    expect(redisDbLabel(m, "conn-a", "0")).toBe("production");
    expect(redisDbLabel(m, "conn-b", "0")).toBeNull();
    m = setRedisDbName(m, "conn-b", "0", "dev");
    expect(redisDbLabel(m, "conn-a", "0")).toBe("production");
    expect(redisDbLabel(m, "conn-b", "0")).toBe("dev");
  });
  it("空名稱移除標籤；過長截到 40 字", () => {
    let m = setRedisDbName({}, "c", "1", "cache");
    m = setRedisDbName(m, "c", "1", "   ");
    expect(redisDbLabel(m, "c", "1")).toBeNull();
    expect(redisDbLabel(setRedisDbName({}, "c", "1", "x".repeat(100)), "c", "1")).toHaveLength(40);
  });
  it("序列化後讀回；壞資料當空", () => {
    const m = setRedisDbName({}, "c", "0", "prod");
    expect(loadRedisDbNames(serializeRedisDbNames(m))).toEqual(m);
    expect(loadRedisDbNames("not json")).toEqual({});
    expect(loadRedisDbNames('{"a":5}')).toEqual({});
  });
});
