import { describe, expect, it } from "vitest";
import { parseRustDeskVideo } from "./RustDeskView";
// 真的 RustDesk 1.4.9 錄下來的一則影像訊息（見 scripts/screenshot-fixtures.mjs）。
// @ts-expect-error fixtures 是給 Playwright 用的純 JS，沒有型別宣告
import { RUSTDESK_VP9_KEYFRAME_B64 } from "../scripts/screenshot-fixtures.mjs";

function fromB64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

describe("parseRustDeskVideo", () => {
  it("解出真的 RustDesk 關鍵畫面的標頭（VP9、key、display 0）", () => {
    const v = parseRustDeskVideo(fromB64(RUSTDESK_VP9_KEYFRAME_B64));
    expect(v).not.toBeNull();
    expect(v!.codec).toBe(1);
    expect(v!.key).toBe(true);
    expect(v!.display).toBe(0);
    // VP9 關鍵畫面的 frame marker：第一個 byte 的高 2 bits 是 0b10。
    expect(v!.data[0] >> 6).toBe(0b10);
  });

  it("pts 是 little-endian i64；資料是零複製視圖", () => {
    const buf = new ArrayBuffer(13 + 3);
    const u8 = new Uint8Array(buf);
    u8.set([2, 2, 0, 1, 0]);
    new DataView(buf).setBigInt64(5, 12345n, true);
    u8.set([7, 8, 9], 13);
    const v = parseRustDeskVideo(buf)!;
    expect(v).toMatchObject({ codec: 2, key: false, display: 1, pts: 12345 });
    expect(Array.from(v.data)).toEqual([7, 8, 9]);
    expect(v.data.buffer).toBe(buf);
  });

  it("不是影像 / 太短 → null", () => {
    expect(parseRustDeskVideo(new Uint8Array([1, 123]).buffer)).toBeNull();
    expect(parseRustDeskVideo(new Uint8Array([2, 1, 1]).buffer)).toBeNull();
  });
});
