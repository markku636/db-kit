// 儲存格檢視器的純函式：十六進位傾印、圖片偵測、JSON 路徑。抽出來以便單元測試（見 cellViews.test.ts）。

/** `0x48656c6c6f` → bytes；不是 0x 開頭的偶數長度十六進位字串回 null。 */
export function parseHexValue(v: string | null): Uint8Array | null {
  if (!v) return null;
  const m = /^0x([0-9a-fA-F]*)(…|\.\.\.)?$/.exec(v.trim());
  if (!m || m[1].length % 2 !== 0) return null;
  const out = new Uint8Array(m[1].length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(m[1].slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 經典的 16 位元組一列傾印：`00000000  48 65 6c …  |Hel…|`。max 之後截斷並註明。 */
export function hexDump(bytes: Uint8Array, max = 4096): string[] {
  const lines: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.slice(off, Math.min(off + 16, n));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(16 * 3 - 1, " ");
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes`);
  return lines;
}

const MAGIC: Array<[string, number[]]> = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/webp", [0x52, 0x49, 0x46, 0x46]],
  ["image/bmp", [0x42, 0x4d]],
];

function sniff(bytes: Uint8Array): string | null {
  for (const [mime, sig] of MAGIC) {
    if (sig.every((b, i) => bytes[i] === b)) {
      if (mime === "image/webp" && String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") continue;
      return mime;
    }
  }
  return null;
}

function b64ToBytes(b64: string, limit = 64): Uint8Array | null {
  try {
    const bin = atob(b64.slice(0, Math.ceil(limit / 3) * 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * 儲存格值是不是一張圖：`data:image/...;base64,…`、純 base64（檔頭是 PNG / JPEG / GIF / WebP / BMP）、
 * 或完整的 0x 十六進位（結尾沒有截斷記號）。回可直接給 <img src> 的 data URL；不是圖回 null。
 * 不載入外部網址（隱私：開檢視窗不該對外連線）。
 */
export function detectImage(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  const dataUrl = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (dataUrl) return `data:${dataUrl[1]};base64,${dataUrl[2].replace(/\s/g, "")}`;
  if (s.length >= 32 && /^[A-Za-z0-9+/=\r\n]+$/.test(s)) {
    const head = b64ToBytes(s.replace(/\s/g, ""));
    const mime = head && sniff(head);
    if (mime) return `data:${mime};base64,${s.replace(/\s/g, "")}`;
  }
  const bytes = parseHexValue(s);
  if (bytes && !/(…|\.\.\.)$/.test(s)) {
    const mime = sniff(bytes);
    if (mime) {
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return `data:${mime};base64,${btoa(bin)}`;
    }
  }
  return null;
}

/** JSONPath 片段：識別字用 `.key`，其餘用 `["key"]`；陣列 `[i]`。 */
export function jsonPathJoin(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/** 值是不是結構化 JSON（物件 / 陣列）；是的話回解析結果。 */
export function parseStructuredJson(v: string | null): object | null {
  if (!v) return null;
  const s = v.trim();
  if (!(s.startsWith("{") || s.startsWith("["))) return null;
  try {
    const p: unknown = JSON.parse(s);
    return p !== null && typeof p === "object" ? (p as object) : null;
  } catch {
    return null;
  }
}
