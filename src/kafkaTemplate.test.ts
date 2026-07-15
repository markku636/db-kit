import { describe, it, expect } from "vitest";
import { renderTemplate, hasTemplate } from "./kafkaTemplate";

describe("renderTemplate", () => {
  it("seq / now / nowIso", () => {
    expect(renderTemplate("{{seq}}", 42)).toBe("42");
    expect(Number(renderTemplate("{{now}}", 0))).toBeGreaterThan(0);
    expect(renderTemplate("{{nowIso}}", 0)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("int within range", () => {
    for (let i = 0; i < 50; i++) {
      const n = Number(renderTemplate("{{int 1 10}}", 0));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(10);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("float honours decimals", () => {
    const s = renderTemplate("{{float 0 1 3}}", 0);
    expect(s).toMatch(/^0\.\d{3}$|^1\.000$/);
  });

  it("uuid shape", () => {
    expect(renderTemplate("{{uuid}}", 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("oneOf picks from list", () => {
    for (let i = 0; i < 20; i++) {
      expect(["a", "b", "c"]).toContain(renderTemplate("{{oneOf a|b|c}}", 0));
    }
  });

  it("bool is true/false", () => {
    expect(["true", "false"]).toContain(renderTemplate("{{bool}}", 0));
  });

  it("word length", () => {
    expect(renderTemplate("{{word 8}}", 0)).toMatch(/^[a-z]{8}$/);
  });

  it("interpolates within JSON", () => {
    const out = renderTemplate('{"id":{{seq}},"tag":"{{oneOf x|y}}"}', 7);
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(7);
    expect(["x", "y"]).toContain(parsed.tag);
  });

  it("unknown / malformed placeholders kept verbatim", () => {
    expect(renderTemplate("{{nope}}", 0)).toBe("{{nope}}");
    expect(renderTemplate("{{int bad}}", 0)).toBe("{{int bad}}");
  });

  it("hasTemplate detects placeholders", () => {
    expect(hasTemplate("{{uuid}}")).toBe(true);
    expect(hasTemplate("plain text")).toBe(false);
  });
});
