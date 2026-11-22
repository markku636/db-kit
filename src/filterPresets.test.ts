import { describe, it, expect } from "vitest";
import { loadFilterPresets, recordFilterPreset } from "./filterPresets";

describe("filter presets", () => {
  const f = [{ column: "status", op: "=", value: "1" }];
  it("同名覆蓋並略過壞資料", () => {
    let p = recordFilterPreset([], "active", f, false);
    p = recordFilterPreset(p, "active", [{ column: "name", op: "like", value: "a" }], true);
    expect(p).toHaveLength(1);
    expect(p[0].filters[0].column).toBe("name");
    expect(p[0].matchAny).toBe(true);
    expect(loadFilterPresets(JSON.stringify([...p, { name: 1 }, null]))).toHaveLength(1);
    expect(loadFilterPresets("broken")).toEqual([]);
  });
  it("空篩選不存", () => {
    expect(recordFilterPreset([], "x", [], false)).toEqual([]);
  });
});
