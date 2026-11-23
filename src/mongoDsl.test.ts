import { describe, it, expect } from "vitest";
import { isMongoWriteDsl, isTruncatedMongoCell } from "./mongoDsl";

describe("isTruncatedMongoCell", () => {
  it("認得後端的截斷標記但不會誤判正常值", () => {
    expect(isTruncatedMongoCell("abc…⟪+1234 bytes⟫")).toBe(true);
    expect(isTruncatedMongoCell("abc")).toBe(false);
    expect(isTruncatedMongoCell("abc…⟪+12 bytes⟫ more")).toBe(false);
  });
});

describe("isMongoWriteDsl", () => {
  it("擋下 insert / update / delete", () => {
    expect(isMongoWriteDsl('{"collection":"u","insert":[{"a":1}]}')).toBe(true);
    expect(isMongoWriteDsl('{"collection":"u","update":{"filter":{"a":1},"set":{"b":2}}}')).toBe(true);
    expect(isMongoWriteDsl('{"collection":"u","delete":{"a":1}}')).toBe(true);
  });
  it("擋下 $out / $merge（含巢狀）", () => {
    expect(isMongoWriteDsl('{"collection":"u","pipeline":[{"$out":"dst"}]}')).toBe(true);
    expect(isMongoWriteDsl('{"collection":"u","pipeline":[{"$facet":{"x":[{"$merge":"dst"}]}}]}')).toBe(true);
  });
  it("只讀形式放行", () => {
    expect(isMongoWriteDsl('{"collection":"u","filter":{"a":1},"limit":10}')).toBe(false);
    expect(isMongoWriteDsl('{"collection":"u","pipeline":[{"$match":{"a":1}},{"$group":{"_id":"$a"}}]}')).toBe(false);
    expect(isMongoWriteDsl("not json")).toBe(false);
  });
});
