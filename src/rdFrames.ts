// RDP 分頁的畫面訊息解析（後端 → 前端）。後端把解碼好的 RGBA 區塊、游標與尺寸變更
// 打包成二進位紀錄，經 Tauri Channel 以 ArrayBuffer 送來；一則訊息可能塞好幾筆紀錄。
//
// 為什麼自訂二進位格式而不是 JSON / base64：一個 1920×1080 的全畫面更新就是 8 MB 的像素，
// 任何文字編碼都要多一倍記憶體與一次完整複製；這裡的像素直接是原 ArrayBuffer 上的
// Uint8ClampedArray 視圖（零複製），可以原封不動丟給 `new ImageData(...)` / putImageData。
//
// 每筆紀錄 16 bytes 標頭（little-endian）：
//   [u8 type][u8 flags][u16 reserved][u16 a][u16 b][u16 c][u16 d][u32 seq]
// 後面接該型別的酬載（見 `RdFrameType`）。

/** 紀錄型別；數值與後端 `rd::rdp::frames` 一致，改動要兩邊同步。 */
export const RdFrameType = {
  /** a = x、b = y、c = w、d = h；酬載 w*h*4 bytes RGBA。 */
  RECT: 1,
  /** a = w、b = h；遠端桌面尺寸變了（重新配置 canvas）。 */
  RESIZE: 2,
  /** a = w、b = h、c = hotX、d = hotY；酬載 w*h*4 bytes RGBA。 */
  POINTER_BITMAP: 3,
  /** a = x、b = y；遠端移動了游標（例如程式呼叫 SetCursorPos）。 */
  POINTER_POS: 4,
  /** flags 0 = 隱藏、1 = 系統預設箭頭。 */
  POINTER_SYSTEM: 5,
  /** seq = 畫面編號；畫完之後要回 ack，後端才會送下一批（流量控制）。 */
  FRAME_END: 6,
  /** a = 長度低 16 bits、b = 高 16 bits；酬載是遠端剪貼簿的 UTF-8 文字。 */
  CLIPBOARD: 7,
} as const;

export const RD_FRAME_HEADER_SIZE = 16;

export type RdRectRecord = {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  /** 指向原訊息 buffer 的視圖（不是複本）；訊息處理完之前不要轉手給會 detach 它的 API。 */
  pixels: Uint8ClampedArray<ArrayBuffer>;
};
export type RdResizeRecord = { kind: "resize"; w: number; h: number };
export type RdPointerBitmapRecord = {
  kind: "pointerBitmap";
  w: number;
  h: number;
  hotX: number;
  hotY: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
};
export type RdPointerPosRecord = { kind: "pointerPos"; x: number; y: number };
export type RdPointerSystemRecord = { kind: "pointerSystem"; visible: boolean };
export type RdFrameEndRecord = { kind: "frameEnd"; seq: number };
export type RdClipboardRecord = { kind: "clipboard"; text: string };

export type RdRecord =
  | RdRectRecord
  | RdResizeRecord
  | RdPointerBitmapRecord
  | RdPointerPosRecord
  | RdPointerSystemRecord
  | RdFrameEndRecord
  | RdClipboardRecord;

/**
 * 解析一則後端訊息。像素是零複製視圖；格式不對（標頭 / 酬載被截斷、未知型別）直接丟錯——
 * 這代表前後端版本不一致或 IPC 出錯，硬撐著畫只會畫出一片垃圾，不如讓上層斷線並顯示原因。
 */
export function parseRdMessage(buf: ArrayBuffer): RdRecord[] {
  const dv = new DataView(buf);
  const total = buf.byteLength;
  const out: RdRecord[] = [];
  let off = 0;
  while (off < total) {
    if (total - off < RD_FRAME_HEADER_SIZE) {
      throw new Error(`RDP 畫面訊息被截斷：位移 ${off} 只剩 ${total - off} bytes，不足 ${RD_FRAME_HEADER_SIZE} bytes 標頭`);
    }
    const type = dv.getUint8(off);
    const flags = dv.getUint8(off + 1);
    const a = dv.getUint16(off + 4, true);
    const b = dv.getUint16(off + 6, true);
    const c = dv.getUint16(off + 8, true);
    const d = dv.getUint16(off + 10, true);
    const seq = dv.getUint32(off + 12, true);
    const body = off + RD_FRAME_HEADER_SIZE;
    const pixelsAt = (w: number, h: number, what: string): Uint8ClampedArray<ArrayBuffer> => {
      const len = w * h * 4;
      if (total - body < len) {
        throw new Error(
          `RDP 畫面訊息被截斷：${what}（${w}×${h}）於位移 ${off} 需要 ${len} bytes 像素，只剩 ${total - body} bytes`,
        );
      }
      return new Uint8ClampedArray(buf, body, len);
    };
    switch (type) {
      case RdFrameType.RECT: {
        const pixels = pixelsAt(c, d, "RECT");
        out.push({ kind: "rect", x: a, y: b, w: c, h: d, pixels });
        off = body + pixels.byteLength;
        break;
      }
      case RdFrameType.RESIZE:
        out.push({ kind: "resize", w: a, h: b });
        off = body;
        break;
      case RdFrameType.POINTER_BITMAP: {
        const pixels = pixelsAt(a, b, "POINTER_BITMAP");
        out.push({ kind: "pointerBitmap", w: a, h: b, hotX: c, hotY: d, pixels });
        off = body + pixels.byteLength;
        break;
      }
      case RdFrameType.POINTER_POS:
        out.push({ kind: "pointerPos", x: a, y: b });
        off = body;
        break;
      case RdFrameType.POINTER_SYSTEM:
        out.push({ kind: "pointerSystem", visible: flags !== 0 });
        off = body;
        break;
      case RdFrameType.FRAME_END:
        out.push({ kind: "frameEnd", seq });
        off = body;
        break;
      case RdFrameType.CLIPBOARD: {
        const len = a + b * 0x10000;
        if (total - body < len) {
          throw new Error(`RDP 剪貼簿訊息被截斷：位移 ${off} 需要 ${len} bytes，只剩 ${total - body} bytes`);
        }
        out.push({ kind: "clipboard", text: new TextDecoder().decode(new Uint8Array(buf, body, len)) });
        off = body + len;
        break;
      }
      default:
        throw new Error(`RDP 畫面訊息於位移 ${off} 出現未知的紀錄型別 ${type}`);
    }
  }
  return out;
}

function recordBodySize(r: RdRecord): number {
  if (r.kind === "clipboard") return new TextEncoder().encode(r.text).length;
  return r.kind === "rect" || r.kind === "pointerBitmap" ? r.w * r.h * 4 : 0;
}

/**
 * `parseRdMessage` 的反向：把紀錄打包成一則訊息。只給單元測試與 Playwright shim 合成假畫面用，
 * 正式路徑由後端打包。像素長度必須剛好 w*h*4，否則丟錯（避免合成出後端不可能送的訊息）。
 */
export function encodeRdRecords(records: readonly RdRecord[]): ArrayBuffer {
  let size = 0;
  for (const r of records) {
    const body = recordBodySize(r);
    if ((r.kind === "rect" || r.kind === "pointerBitmap") && r.pixels.length !== body) {
      throw new Error(`${r.kind} 的像素長度 ${r.pixels.length} 與 ${r.w}×${r.h}×4 = ${body} 不符`);
    }
    size += RD_FRAME_HEADER_SIZE + body;
  }
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;
  const header = (type: number, flags: number, a: number, b: number, c: number, d: number, seq: number) => {
    dv.setUint8(off, type);
    dv.setUint8(off + 1, flags);
    dv.setUint16(off + 2, 0, true);
    dv.setUint16(off + 4, a, true);
    dv.setUint16(off + 6, b, true);
    dv.setUint16(off + 8, c, true);
    dv.setUint16(off + 10, d, true);
    dv.setUint32(off + 12, seq >>> 0, true);
    off += RD_FRAME_HEADER_SIZE;
  };
  for (const r of records) {
    switch (r.kind) {
      case "rect":
        header(RdFrameType.RECT, 0, r.x, r.y, r.w, r.h, 0);
        bytes.set(r.pixels, off);
        off += r.pixels.length;
        break;
      case "resize":
        header(RdFrameType.RESIZE, 0, r.w, r.h, 0, 0, 0);
        break;
      case "pointerBitmap":
        header(RdFrameType.POINTER_BITMAP, 0, r.w, r.h, r.hotX, r.hotY, 0);
        bytes.set(r.pixels, off);
        off += r.pixels.length;
        break;
      case "pointerPos":
        header(RdFrameType.POINTER_POS, 0, r.x, r.y, 0, 0, 0);
        break;
      case "pointerSystem":
        header(RdFrameType.POINTER_SYSTEM, r.visible ? 1 : 0, 0, 0, 0, 0, 0);
        break;
      case "frameEnd":
        header(RdFrameType.FRAME_END, 0, 0, 0, 0, 0, r.seq);
        break;
      case "clipboard": {
        const t = new TextEncoder().encode(r.text);
        header(RdFrameType.CLIPBOARD, 0, t.length & 0xffff, t.length >>> 16, 0, 0, 0);
        bytes.set(t, off);
        off += t.length;
        break;
      }
    }
  }
  return buf;
}

/**
 * 遠端游標點陣圖 → CSS `cursor` 值。PNG 編碼要用瀏覽器的 canvas，這裡讓呼叫端注入
 * `toDataUrl`（正式版用 OffscreenCanvas / canvas.toDataURL，測試給假函式），本模組才能在 node 下測。
 * 熱點夾在圖內：超出範圍時 Chrome 會整個忽略這個游標。空點陣圖（0×0）視為隱藏。
 * 注意瀏覽器對自訂游標有尺寸上限（多數 128×128），Windows 游標通常 32 / 48，一般不會碰到。
 */
export function pointerToCssCursor(
  rec: RdPointerBitmapRecord,
  toDataUrl: (rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number) => string,
): string {
  if (rec.w <= 0 || rec.h <= 0) return "none";
  const hx = Math.min(Math.max(0, rec.hotX), rec.w - 1);
  const hy = Math.min(Math.max(0, rec.hotY), rec.h - 1);
  return `url(${toDataUrl(rec.pixels, rec.w, rec.h)}) ${hx} ${hy}, auto`;
}
