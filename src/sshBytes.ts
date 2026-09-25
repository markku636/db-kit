// xterm ↔ 後端的位元組編解碼（ssh_term_write 收 base64，見 api.ts 的 sshTermWrite）。
// xterm 的 onData 給一般 UTF-16 字串（要先做 UTF-8 編碼）；onBinary 給「每個字元 = 一個 0–255 位元組」的
// binary string（滑鼠回報等 8-bit 資料）。兩者進 base64 的路徑不同，混用會把 CJK 打成亂碼。

const CHUNK = 0x8000;

/** Uint8Array → base64。分段 fromCharCode：一次展開幾十萬個引數會爆呼叫堆疊（大段貼上就會）。 */
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 一般字串（xterm onData）→ UTF-8 → base64。 */
export function utf8ToB64(s: string): string {
  if (!s) return "";
  return bytesToB64(new TextEncoder().encode(s));
}

/** binary string（xterm onBinary，每字元一個位元組）→ base64。超過 0xff 的字元只取低 8 位，不丟例外。 */
export function binaryToB64(s: string): string {
  if (!s) return "";
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytesToB64(bytes);
}

/** base64 → 位元組（容忍空白 / 換行）。非法 base64 由 atob 丟出，呼叫端自行處理。 */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
