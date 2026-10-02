// RustDesk 畫面的位元流 profile → WebCodecs 的 codec 字串。真彩（4:4:4）時對方送 VP9 profile 1 / AV1 High profile，
// 用 profile 0 的設定解會失敗（實測 Chrome：EncodingError），所以每張關鍵畫面看一下 profile、不一樣就重設解碼器。
// 協定本身沒標色度，位元流裡有：VP9 關鍵畫面第一個位元組（frame_marker + profile），AV1 序列標頭 OBU 的 seq_profile。

/** VP9 畫面的 profile（0–3）；不是 VP9 畫面（frame_marker 不對）→ null。 */
export function vp9Profile(data: Uint8Array): number | null {
  if (!data.length) return null;
  const b = data[0];
  if (b >> 6 !== 2) return null;
  return ((b >> 5) & 1) | (((b >> 4) & 1) << 1);
}

function leb128(data: Uint8Array, at: number): { value: number; len: number } | null {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const b = data[at + i];
    if (b === undefined) return null;
    value += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) return { value, len: i + 1 };
  }
  return null;
}

/** AV1 的 seq_profile（0 = Main 4:2:0、1 = High 4:4:4、2 = Professional）；沒有序列標頭 → null。 */
export function av1Profile(data: Uint8Array): number | null {
  let pos = 0;
  while (pos < data.length) {
    const h = data[pos];
    const type = (h >> 3) & 0xf;
    const ext = (h >> 2) & 1;
    const hasSize = (h >> 1) & 1;
    let p = pos + 1 + ext;
    let size = data.length - p;
    if (hasSize) {
      const l = leb128(data, p);
      if (!l) return null;
      p += l.len;
      size = l.value;
    }
    if (type === 1) return p < data.length ? data[p] >> 5 : null; // OBU_SEQUENCE_HEADER
    if (!hasSize) return null;
    pos = p + size;
  }
  return null;
}

/** 關鍵畫面要用的 WebCodecs codec 字串；`codec` 是 bridge 的代碼（1 VP9、2 VP8、3 AV1）。認不出來 → `fallback`。 */
export function decoderCodec(codec: number, key: Uint8Array, fallback: string): string {
  if (codec === 1) {
    const p = vp9Profile(key);
    if (p === 1) return "vp09.01.10.08.03";
    if (p === 0) return "vp09.00.10.08";
  }
  if (codec === 3) {
    const p = av1Profile(key);
    if (p === 1) return "av01.1.08M.08.0.000";
    if (p === 0) return "av01.0.08M.08";
  }
  return fallback;
}
