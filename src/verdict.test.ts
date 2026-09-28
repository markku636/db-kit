import { describe, it, expect } from "vitest";
import { combineVerdicts, parseVerdict, stripVerdictLine } from "./verdict";
import { combinedReviewText, type DbaRun } from "./useDbaReview";

describe("combineVerdicts（會審取最嚴格）", () => {
  it("STOP > CAUTION > GO", () => {
    expect(combineVerdicts(["go", "caution"])).toBe("caution");
    expect(combineVerdicts(["go", "stop", "caution"])).toBe("stop");
    expect(combineVerdicts(["go", "go"])).toBe("go");
  });

  it("沒給結論的審查者視為 CAUTION（沒意見不等於沒問題）", () => {
    expect(combineVerdicts(["go", null])).toBe("caution");
    expect(combineVerdicts([undefined])).toBe("caution");
  });

  it("沒有任何審查者回 null", () => {
    expect(combineVerdicts([])).toBeNull();
  });
});

describe("parseVerdict 仍與後端同規則", () => {
  it("第一個非空行、容許粗體與全形冒號", () => {
    expect(parseVerdict("\n**VERDICT：STOP**\n理由")).toBe("stop");
    expect(parseVerdict("說明\nVERDICT: GO")).toBeNull();
    expect(stripVerdictLine("VERDICT: GO\n\n## 摘要")).toBe("## 摘要");
  });
});

describe("combinedReviewText", () => {
  const run = (title: string, text: string): DbaRun => ({
    persona: title, title, text, running: false, queued: false, error: null, tools: [], verdict: parseVerdict(text), mode: "review",
  });

  it("單人照原文；會審每位一節並以分隔線隔開", () => {
    expect(combinedReviewText([run("A", "VERDICT: GO\nok")])).toBe("VERDICT: GO\nok");
    expect(combinedReviewText([run("A", "a"), run("B", "  b  "), run("C", "")])).toBe("# A\n\na\n\n---\n\n# B\n\nb");
    expect(combinedReviewText([])).toBe("");
  });
});
