// RustDesk 對方的游標圖（官方用戶端也是把畫面上的游標換成對方的游標形狀）：bridge 送 RGBA，這裡做成 CSS cursor
// （`url(data:…) 熱點x 熱點y, default`）。照畫面縮放比例縮放；Chromium 的游標圖最大 128×128，太大會被忽略，所以再縮到放得下。

export interface RdCursorImage {
  width: number;
  height: number;
  hotx: number;
  hoty: number;
  rgba: Uint8ClampedArray;
}

/** Chromium 收的游標圖上限。 */
export const MAX_CSS_CURSOR = 128;

/** 縮放後的大小與熱點（最小 1 像素、最大 128）。 */
export function cursorBox(c: Pick<RdCursorImage, "width" | "height" | "hotx" | "hoty">, scale: number) {
  let s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const big = Math.max(c.width, c.height) * s;
  if (big > MAX_CSS_CURSOR) s *= MAX_CSS_CURSOR / big;
  const w = Math.max(1, Math.round(c.width * s));
  const h = Math.max(1, Math.round(c.height * s));
  return { w, h, hx: Math.min(w - 1, Math.round(c.hotx * s)), hy: Math.min(h - 1, Math.round(c.hoty * s)) };
}

/** 游標圖 → PNG data URL（縮放過）與熱點。 */
export function cursorPng(c: RdCursorImage, scale: number): { url: string; w: number; h: number; hx: number; hy: number } | null {
  const box = cursorBox(c, scale);
  const src = document.createElement("canvas");
  src.width = c.width;
  src.height = c.height;
  const sctx = src.getContext("2d");
  if (!sctx) return null;
  sctx.putImageData(new ImageData(new Uint8ClampedArray(c.rgba), c.width, c.height), 0, 0);
  const out = document.createElement("canvas");
  out.width = box.w;
  out.height = box.h;
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.imageSmoothingEnabled = box.w < c.width;
  octx.drawImage(src, 0, 0, box.w, box.h);
  return { url: out.toDataURL("image/png"), ...box };
}

/** 縮放比例取到 0.05 一格（畫面縮放一點點時不必重做游標圖）。 */
export function scaleBucket(scale: number): number {
  return Math.max(0.05, Math.round(scale * 20) / 20);
}
