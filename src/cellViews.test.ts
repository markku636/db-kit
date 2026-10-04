import { describe, expect, it } from "vitest";
import { detectImage, hexDump, jsonPathJoin, parseHexValue, parseStructuredJson } from "./cellViews";

// 1×1 透明 PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("cellViews", () => {
  it("parseHexValue：0x 開頭偶數長度才算；接受截斷記號", () => {
    expect(Array.from(parseHexValue("0x48690a")!)).toEqual([0x48, 0x69, 0x0a]);
    expect(parseHexValue("0x123")).toBeNull();
    expect(parseHexValue("hello")).toBeNull();
    expect(parseHexValue("0xdeadbeef…")!.length).toBe(4);
  });
  it("hexDump：16 位元組一列、不可見字元顯示為點、超過上限註明", () => {
    const lines = hexDump(new TextEncoder().encode("Hello\tWorld"));
    expect(lines[0]).toMatch(/^00000000 {2}48 65 6c 6c 6f 09 57 6f 72 6c 64 +\|Hello\.World\|$/);
    expect(hexDump(new Uint8Array(40), 32)).toHaveLength(3);
    expect(hexDump(new Uint8Array(40), 32)[2]).toContain("8 more bytes");
  });
  it("detectImage：data URL、純 base64、完整 0x 十六進位；文字與截斷的二進位不算", () => {
    expect(detectImage(`data:image/png;base64,${PNG_B64}`)).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(detectImage(PNG_B64)).toBe(`data:image/png;base64,${PNG_B64}`);
    const hex = "0x" + Array.from(atob(PNG_B64), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    expect(detectImage(hex)).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(detectImage(hex.slice(0, 40) + "…")).toBeNull();
    expect(detectImage("just some long text that is not an image at all")).toBeNull();
    expect(detectImage("https://example.com/a.png")).toBeNull();
  });
  it("jsonPathJoin / parseStructuredJson", () => {
    expect(jsonPathJoin(jsonPathJoin(jsonPathJoin("$", "a"), 0), "b-c")).toBe('$.a[0]["b-c"]');
    expect(parseStructuredJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseStructuredJson("42")).toBeNull();
    expect(parseStructuredJson("{oops")).toBeNull();
  });
});
