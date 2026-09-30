// 匯入 Windows 遠端桌面連線的 .rdp 檔。純函式（可單測）：
//   - decodeRdpFileBytes：位元組 → 文字。mstsc 存檔是 UTF-16LE 帶 BOM（FF FE）；也收 UTF-16BE、UTF-8（有無 BOM）。
//   - parseRdpFile：一行一個 `key:型別:值`（型別 s / i / b），CRLF、空行、認不得的鍵都略過。
//     值本身可能含冒號（`full address:s:host:3390`），只切前兩個冒號。
// 鍵的意思與 rdConnString.ts 的 Microsoft `rdp://` URI 完全相同，共用 applyRdpKeyValue。
// `password 51:b:` 是 DPAPI 加密的密碼，只有存檔那台電腦的那個使用者能解，不匯入、只提醒。

import { applyRdpKeyValue, blankParsedRd, type ParsedRd } from "./rdConnString";

function utf16(b: Uint8Array, start: number, littleEndian: boolean): string {
  const parts: string[] = [];
  let units: number[] = [];
  for (let i = start; i + 1 < b.length; i += 2) {
    units.push(littleEndian ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
    // 分段轉字串，避免大檔把 fromCharCode 的參數個數撐爆。
    if (units.length === 8192) { parts.push(String.fromCharCode(...units)); units = []; }
  }
  if (units.length) parts.push(String.fromCharCode(...units));
  return parts.join("");
}

/** .rdp 檔位元組 → 文字（BOM 已剝掉）。 */
export function decodeRdpFileBytes(bytes: Uint8Array): string {
  const b = bytes;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return utf16(b, 2, true);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16(b, 2, false);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  // 沒有 BOM 的 UTF-16：檔案開頭一定是 ASCII 鍵名，每兩個 byte 就有一個 0。
  if (b.length >= 4 && b[0] !== 0 && b[1] === 0 && b[2] !== 0 && b[3] === 0) return utf16(b, 0, true);
  if (b.length >= 4 && b[0] === 0 && b[1] !== 0 && b[2] === 0 && b[3] !== 0) return utf16(b, 0, false);
  return new TextDecoder("utf-8").decode(b);
}

/** 解析 .rdp 檔內容；沒有 `full address` 回 null。名稱預設用主機（呼叫端可改用檔名）。 */
export function parseRdpFile(text: string): ParsedRd | null {
  const p = blankParsedRd("rdp");
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const m = /^([^:]+):([a-z]):(.*)$/i.exec(raw.trim());
    if (m) applyRdpKeyValue(p, m[1], m[3]);
  }
  if (!p.host) return null;
  p.name = p.host;
  return p;
}
