import { describe, it, expect } from "vitest";
import { buildRedisTree, keysUnderPrefix, segmentLabel } from "./redisTree";

describe("buildRedisTree", () => {
  it("預設以冒號分層，並把既是資料夾又是鍵的節點記下來", () => {
    const root = buildRedisTree(["user:1:name", "user:1", "user:2:name"]);
    expect(root.count).toBe(3);
    const user = root.children.get("user")!;
    expect(user.path).toBe("user");
    expect(user.count).toBe(3);
    expect(user.children.has("1")).toBe(true);
    expect(user.children.get("1")!.leafKey).toBe("user:1");
  });
  it("自訂分隔符（ARDM --separator）", () => {
    const root = buildRedisTree(["app..cache..a", "app..cache..b"], "..");
    const app = root.children.get("app")!;
    expect(app.path).toBe("app");
    const cache = app.children.get("cache")!;
    expect(cache.path).toBe("app..cache");
    expect(cache.count).toBe(2);
  });
  it("空分隔符退回冒號", () => {
    expect(buildRedisTree(["a:b"], "").children.has("a")).toBe(true);
  });
});

describe("segmentLabel", () => {
  it("空片段有可見標籤，一般片段原樣", () => {
    expect(segmentLabel("")).toBe("‹空›");
    expect(segmentLabel("user")).toBe("user");
  });
  it("user::profile 這種鍵會產生空片段節點", () => {
    const root = buildRedisTree(["user::profile"]);
    const user = root.children.get("user")!;
    expect(user.children.has("")).toBe(true);
    expect(segmentLabel([...user.children.values()][0].seg)).toBe("‹空›");
  });
});

describe("keysUnderPrefix", () => {
  it("只收真正屬於該命名空間的鍵，不誤收同前綴的其他鍵", () => {
    const keys = ["user:1", "user:2:name", "user:10", "users:1"];
    expect(keysUnderPrefix(keys, "user")).toEqual(["user:1", "user:2:name", "user:10"]);
  });
  it("跟著自訂分隔符", () => {
    expect(keysUnderPrefix(["a..b", "a..c", "ab"], "a", "..")).toEqual(["a..b", "a..c"]);
  });
});
