import { describe, it, expect } from "vitest";
import { diffLines } from "./diff";

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
