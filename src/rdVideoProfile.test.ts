import { describe, expect, it } from "vitest";
import { av1Profile, decoderCodec, vp9Profile } from "./rdVideoProfile";
import { cursorBox, scaleBucket } from "./rdCursor";

describe("rdVideoProfile", () => {
  it("VP9：第一個位元組的 frame_marker + profile", () => {
    // 對方真彩時的關鍵畫面開頭（Docker 被控端實測 0xA3 = 10 1 0 0011）= profile 1；平常 0x82 = profile 0
    expect(vp9Profile(new Uint8Array([0xa3, 0x49, 0x83, 0x42]))).toBe(1);
    expect(vp9Profile(new Uint8Array([0xa2, 0x49]))).toBe(1);
    expect(vp9Profile(new Uint8Array([0x82, 0x49]))).toBe(0);
    expect(vp9Profile(new Uint8Array([0x92]))).toBe(2);
    expect(vp9Profile(new Uint8Array([0x02]))).toBeNull(); // frame_marker 不對
    expect(vp9Profile(new Uint8Array([]))).toBeNull();
  });

  it("AV1：跳過 temporal delimiter，讀序列標頭的 seq_profile", () => {
    // TD OBU（type 2, has_size, size 0）+ 序列標頭 OBU（type 1, has_size, size 2, seq_profile = 1）
    const high = new Uint8Array([0x12, 0x00, 0x0a, 0x02, 0x20, 0x00]);
    expect(av1Profile(high)).toBe(1);
    const main = new Uint8Array([0x12, 0x00, 0x0a, 0x02, 0x00, 0x00]);
    expect(av1Profile(main)).toBe(0);
    expect(av1Profile(new Uint8Array([0x12, 0x00, 0x32, 0x01, 0x00]))).toBeNull(); // 沒有序列標頭（frame OBU）
  });

  it("關鍵畫面 → 解碼器設定；認不出來用原本的", () => {
    expect(decoderCodec(1, new Uint8Array([0xa2]), "x")).toBe("vp09.01.10.08.03");
    expect(decoderCodec(1, new Uint8Array([0x82]), "x")).toBe("vp09.00.10.08");
    expect(decoderCodec(3, new Uint8Array([0x0a, 0x01, 0x20]), "x")).toBe("av01.1.08M.08.0.000");
    expect(decoderCodec(2, new Uint8Array([0x9d]), "vp8")).toBe("vp8");
    expect(decoderCodec(1, new Uint8Array([0x00]), "vp09.00.10.08")).toBe("vp09.00.10.08");
  });
});

describe("rdCursor", () => {
  it("照畫面比例縮放游標圖與熱點；最大 128、最小 1", () => {
    expect(cursorBox({ width: 32, height: 32, hotx: 10, hoty: 20 }, 0.5)).toEqual({ w: 16, h: 16, hx: 5, hy: 10 });
    expect(cursorBox({ width: 9, height: 16, hotx: 4, hoty: 8 }, 1)).toEqual({ w: 9, h: 16, hx: 4, hy: 8 });
    const big = cursorBox({ width: 256, height: 128, hotx: 255, hoty: 0 }, 1);
    expect([big.w, big.h, big.hx]).toEqual([128, 64, 127]);
    expect(cursorBox({ width: 2, height: 2, hotx: 1, hoty: 1 }, 0.01)).toEqual({ w: 1, h: 1, hx: 0, hy: 0 });
  });

  it("縮放比例取 0.05 一格", () => {
    expect(scaleBucket(0.512)).toBe(0.5);
    expect(scaleBucket(0.526)).toBe(0.55);
    expect(scaleBucket(0)).toBe(0.05);
  });
});
