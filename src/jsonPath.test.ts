import { describe, it, expect } from "vitest";
import { projectJson, projectText } from "./jsonPath";

describe("projectJson", () => {
  const obj = { user: { id: 42, name: "amy" }, items: [{ id: 1 }, { id: 2 }], tag: null };

  it("dotted path", () => {
    expect(projectJson(obj, ".user.name")).toBe("amy");
    expect(projectJson(obj, "user.id")).toBe("42");
  });

  it("array index", () => {
    expect(projectJson(obj, ".items[0].id")).toBe("1");
    expect(projectJson(obj, ".items[1].id")).toBe("2");
  });

  it("missing path → ∅", () => {
    expect(projectJson(obj, ".user.nope")).toBe("∅");
    expect(projectJson(obj, ".items[9].id")).toBe("∅");
  });

  it("null value renders as null", () => {
    expect(projectJson(obj, ".tag")).toBe("null");
  });

  it("object value serialized", () => {
    expect(projectJson(obj, ".user")).toBe('{"id":42,"name":"amy"}');
  });

  it("multi-path joins with path= labels", () => {
    expect(projectJson(obj, ".user.id, .user.name")).toBe(".user.id=42 · .user.name=amy");
  });

  it("invalid path token", () => {
    expect(projectJson(obj, ".a[x]")).toBe(".a[x]=?");
  });
});

describe("projectText", () => {
  it("parses JSON text then projects", () => {
    expect(projectText('{"n":5}', ".n")).toBe("5");
  });
  it("non-JSON returns null", () => {
    expect(projectText("not json", ".n")).toBeNull();
  });
  it("null text returns null", () => {
    expect(projectText(null, ".n")).toBeNull();
  });
});
