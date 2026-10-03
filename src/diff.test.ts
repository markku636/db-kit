import { describe, it, expect } from "vitest";
import { diffLines, diffTokens, tokenSimilarity, tokenize } from "./diff";

describe("diffLines", () => {
  it("identical → all same", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.type === "same")).toBe(true);
    expect(d.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("added line", () => {
    const d = diffLines("a\nc", "a\nb\nc");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("deleted line", () => {
    const d = diffLines("a\nb\nc", "a\nc");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("changed line = del + add", () => {
    const d = diffLines("a\nx\nc", "a\ny\nc");
    expect(d.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["x"]);
    expect(d.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["y"]);
  });

  it("reconstructs both sides", () => {
    const a = "one\ntwo\nthree";
    const b = "one\nTWO\nthree\nfour";
    const d = diffLines(a, b);
    expect(d.filter((l) => l.type !== "add").map((l) => l.text).join("\n")).toBe(a);
    expect(d.filter((l) => l.type !== "del").map((l) => l.text).join("\n")).toBe(b);
  });
});

describe("diffTokens", () => {
  it("只把變動的 token 標出來（型別長度 50 → 200）", () => {
    const d = diffTokens("`name` varchar(50) NOT NULL", "`name` varchar(200) NOT NULL");
    expect(d.filter((x) => x.type === "del").map((x) => x.text)).toEqual(["50"]);
    expect(d.filter((x) => x.type === "add").map((x) => x.text)).toEqual(["200"]);
    // 兩側各自拼回去要等於原文
    expect(d.filter((x) => x.type !== "add").map((x) => x.text).join("")).toBe("`name` varchar(50) NOT NULL");
    expect(d.filter((x) => x.type !== "del").map((x) => x.text).join("")).toBe("`name` varchar(200) NOT NULL");
  });

  it("tokenize：識別字 / 數字成組、空白成組、標點各自一個", () => {
    expect(tokenize("a_1 (b,c)")).toEqual(["a_1", " ", "(", "b", ",", "c", ")"]);
    expect(tokenize("欄位 int")).toEqual(["欄位", " ", "int"]);
  });

  it("tokenSimilarity：相同行為 1、整行重寫趨近 0", () => {
    expect(tokenSimilarity(diffTokens("abc def", "abc def"))).toBe(1);
    expect(tokenSimilarity(diffTokens("abc", "xyz"))).toBe(0);
    expect(tokenSimilarity(diffTokens("varchar(50)", "varchar(200)"))).toBeGreaterThan(0.6);
  });
});
