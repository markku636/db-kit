import { describe, it, expect } from "vitest";
import {
  RD_FRAME_HEADER_SIZE,
  RdFrameType,
  encodeRdRecords,
  parseRdMessage,
  pointerToCssCursor,
  type RdPointerBitmapRecord,
  type RdRecord,
} from "./rdFrames";

function rgba(w: number, h: number, seed = 0): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 7 + seed) & 0xff;
  return px;
}

describe("parseRdMessage", () => {
  it("手工排出的標頭：欄位位置與 little-endian", () => {
    const buf = new ArrayBuffer(RD_FRAME_HEADER_SIZE + 4);
    const dv = new DataView(buf);
    dv.setUint8(0, RdFrameType.RECT);
    dv.setUint16(4, 0x0102, true); // x
    dv.setUint16(6, 0x0304, true); // y
    dv.setUint16(8, 1, true); // w
    dv.setUint16(10, 1, true); // h
    dv.setUint32(12, 0xdeadbeef, true);
    new Uint8Array(buf, 16).set([10, 20, 30, 255]);
    const [rec] = parseRdMessage(buf);
    expect(rec.kind).toBe("rect");
    if (rec.kind !== "rect") return;
    expect([rec.x, rec.y, rec.w, rec.h]).toEqual([0x0102, 0x0304, 1, 1]);
    expect(Array.from(rec.pixels)).toEqual([10, 20, 30, 255]);
  });

  it("一則訊息多筆紀錄，編碼 → 解析來回一致", () => {
    const records: RdRecord[] = [
      { kind: "resize", w: 1920, h: 1080 },
      { kind: "rect", x: 10, y: 20, w: 3, h: 2, pixels: rgba(3, 2) },
      { kind: "pointerBitmap", w: 2, h: 2, hotX: 1, hotY: 0, pixels: rgba(2, 2, 99) },
      { kind: "pointerPos", x: 500, y: 600 },
      { kind: "pointerSystem", visible: false },
      { kind: "pointerSystem", visible: true },
      { kind: "rect", x: 0, y: 0, w: 1, h: 1, pixels: rgba(1, 1, 5) },
      { kind: "frameEnd", seq: 0xfffffffe },
    ];
    const buf = encodeRdRecords(records);
    expect(buf.byteLength).toBe(RD_FRAME_HEADER_SIZE * records.length + (6 + 4 + 1) * 4);
    const parsed = parseRdMessage(buf);
    expect(parsed.length).toBe(records.length);
    parsed.forEach((p, i) => {
      const r = records[i];
      if ("pixels" in r && "pixels" in p) {
        const { pixels: pp, ...pRest } = p;
        const { pixels: rp, ...rRest } = r;
        expect(pRest).toEqual(rRest);
        expect(Array.from(pp)).toEqual(Array.from(rp));
      } else {
        expect(p).toEqual(r);
      }
    });
  });

  it("空訊息回空陣列", () => {
    expect(parseRdMessage(new ArrayBuffer(0))).toEqual([]);
  });

  it("0×0 的 RECT 沒有酬載也合法", () => {
    const buf = encodeRdRecords([
      { kind: "rect", x: 1, y: 1, w: 0, h: 0, pixels: new Uint8ClampedArray(0) },
      { kind: "frameEnd", seq: 3 },
    ]);
    const parsed = parseRdMessage(buf);
    expect(parsed.map((r) => r.kind)).toEqual(["rect", "frameEnd"]);
  });

  it("像素是原 buffer 的視圖（零複製）", () => {
    const buf = encodeRdRecords([
      { kind: "frameEnd", seq: 1 },
      { kind: "rect", x: 0, y: 0, w: 2, h: 2, pixels: rgba(2, 2) },
      { kind: "pointerBitmap", w: 1, h: 1, hotX: 0, hotY: 0, pixels: rgba(1, 1) },
    ]);
    const [, rect, ptr] = parseRdMessage(buf);
    if (rect.kind !== "rect" || ptr.kind !== "pointerBitmap") throw new Error("型別不對");
    expect(rect.pixels.buffer).toBe(buf);
    expect(rect.pixels.byteOffset).toBe(RD_FRAME_HEADER_SIZE * 2);
    expect(rect.pixels.byteLength).toBe(16);
    expect(ptr.pixels.buffer).toBe(buf);
    expect(ptr.pixels.byteOffset).toBe(RD_FRAME_HEADER_SIZE * 3 + 16);
    // 改原 buffer，視圖跟著變。
    new Uint8Array(buf)[RD_FRAME_HEADER_SIZE * 2] = 0xab;
    expect(rect.pixels[0]).toBe(0xab);
  });

  it("標頭被截斷時丟出說明位置的錯誤", () => {
    const buf = encodeRdRecords([{ kind: "resize", w: 10, h: 10 }, { kind: "frameEnd", seq: 1 }]);
    expect(() => parseRdMessage(buf.slice(0, RD_FRAME_HEADER_SIZE + 5))).toThrow(/截斷.*位移 16.*5 bytes/);
    expect(() => parseRdMessage(buf.slice(0, 3))).toThrow(/截斷/);
  });

  it("像素酬載被截斷時丟錯", () => {
    const buf = encodeRdRecords([{ kind: "rect", x: 0, y: 0, w: 4, h: 4, pixels: rgba(4, 4) }]);
    expect(() => parseRdMessage(buf.slice(0, buf.byteLength - 1))).toThrow(/RECT（4×4）.*64 bytes.*63 bytes/);
    const ptr = encodeRdRecords([{ kind: "pointerBitmap", w: 2, h: 2, hotX: 0, hotY: 0, pixels: rgba(2, 2) }]);
    expect(() => parseRdMessage(ptr.slice(0, RD_FRAME_HEADER_SIZE))).toThrow(/POINTER_BITMAP/);
  });

  it("未知型別丟錯", () => {
    const buf = new ArrayBuffer(RD_FRAME_HEADER_SIZE);
    new DataView(buf).setUint8(0, 42);
    expect(() => parseRdMessage(buf)).toThrow(/未知的紀錄型別 42/);
  });

  it("POINTER_SYSTEM：flags 非 0 都當顯示", () => {
    const buf = new ArrayBuffer(RD_FRAME_HEADER_SIZE);
    const dv = new DataView(buf);
    dv.setUint8(0, RdFrameType.POINTER_SYSTEM);
    dv.setUint8(1, 1);
    expect(parseRdMessage(buf)).toEqual([{ kind: "pointerSystem", visible: true }]);
  });
});

describe("encodeRdRecords", () => {
  it("像素長度不符丟錯", () => {
    expect(() => encodeRdRecords([{ kind: "rect", x: 0, y: 0, w: 2, h: 2, pixels: rgba(1, 1) }])).toThrow(/不符/);
  });

  it("reserved 欄寫 0、非 frameEnd 的 seq 寫 0", () => {
    const buf = encodeRdRecords([{ kind: "pointerPos", x: 1, y: 2 }]);
    const dv = new DataView(buf);
    expect(dv.getUint16(2, true)).toBe(0);
    expect(dv.getUint32(12, true)).toBe(0);
  });
});

describe("pointerToCssCursor", () => {
  const rec = (w: number, h: number, hotX: number, hotY: number): RdPointerBitmapRecord => ({
    kind: "pointerBitmap",
    w,
    h,
    hotX,
    hotY,
    pixels: rgba(w, h),
  });

  it("組成 url(...) 熱點, auto，並把像素 / 尺寸交給注入的編碼器", () => {
    const calls: [number, number, number][] = [];
    const css = pointerToCssCursor(rec(32, 32, 5, 7), (px, w, h) => {
      calls.push([px.length, w, h]);
      return "data:image/png;base64,AAAA";
    });
    expect(css).toBe("url(data:image/png;base64,AAAA) 5 7, auto");
    expect(calls).toEqual([[32 * 32 * 4, 32, 32]]);
  });

  it("熱點夾在圖內", () => {
    expect(pointerToCssCursor(rec(16, 16, 40, 16), () => "x")).toBe("url(x) 15 15, auto");
  });

  it("空點陣圖回 none、不呼叫編碼器", () => {
    let called = false;
    expect(
      pointerToCssCursor(rec(0, 0, 0, 0), () => {
        called = true;
        return "x";
      }),
    ).toBe("none");
    expect(called).toBe(false);
  });
});

describe("剪貼簿紀錄", () => {
  it("UTF-8 文字來回一致，可跟其他紀錄混在同一則訊息", () => {
    const buf = encodeRdRecords([{ kind: "clipboard", text: "遠端 copy ✓" }, { kind: "frameEnd", seq: 3 }]);
    expect(parseRdMessage(buf)).toEqual([{ kind: "clipboard", text: "遠端 copy ✓" }, { kind: "frameEnd", seq: 3 }]);
  });
  it("長度超過 64 KiB 用高 16 bits", () => {
    const text = "x".repeat(70_000);
    const [r] = parseRdMessage(encodeRdRecords([{ kind: "clipboard", text }]));
    expect(r).toEqual({ kind: "clipboard", text });
  });
  it("酬載被截斷就丟錯", () => {
    const buf = encodeRdRecords([{ kind: "clipboard", text: "hello" }]);
    expect(() => parseRdMessage(buf.slice(0, buf.byteLength - 1))).toThrow();
  });
});
