// RustDesk 多螢幕：對方的螢幕清單、目前在看哪幾個，以及畫面 / 工具列要的幾何計算（純函式，單元測試用）。
//
// 座標都是對方的虛擬桌面座標（`PeerInfo.displays` 的 x / y / width / height；主螢幕左上是 0,0，
// 擺在左邊 / 上面的螢幕是負的）。滑鼠事件也送這個座標。

export interface RdDisplay {
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
}

export interface RdMonitors {
  displays: RdDisplay[];
  /** 正在看的螢幕（索引）：一個 = 單一螢幕；多個 = 同時看（拼成一張）。 */
  shown: number[];
  /** 對方能同時送好幾個螢幕（RustDesk 1.2.4 起）；舊版只能一次一個。 */
  multi: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 對方的 RustDesk 版本 ≥ `min`（`1.2.4` 這種格式；看不懂的當成新版——新版才會漏填）。 */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).slice(0, 3).map((p) => parseInt(p, 10));
  const a = parse(version ?? "");
  if (a.length < 2 || a.some((n) => Number.isNaN(n))) return true;
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** 螢幕有位置大小（`all` 拼圖、工具列的排列圖都要）。 */
export function hasGeometry(d: RdDisplay | undefined): d is RdDisplay {
  return !!d && d.width > 0 && d.height > 0;
}

/** 這幾個螢幕合起來的外框；有螢幕缺大小就算不出來。 */
export function displayBounds(displays: RdDisplay[], set: number[]): Box | null {
  const ds = set.map((i) => displays[i]);
  if (!ds.length || !ds.every(hasGeometry)) return null;
  const x = Math.min(...ds.map((d) => d.x));
  const y = Math.min(...ds.map((d) => d.y));
  const r = Math.max(...ds.map((d) => d.x + d.width));
  const b = Math.max(...ds.map((d) => d.y + d.height));
  return { x, y, w: r - x, h: b - y };
}

export function allDisplays(m: Pick<RdMonitors, "displays">): number[] {
  return m.displays.map((_, i) => i);
}

/** 能不能「所有螢幕」一起看：對方支援、不只一個螢幕、每個都有位置大小。 */
export function canShowAll(m: RdMonitors): boolean {
  return m.multi && m.displays.length > 1 && displayBounds(m.displays, allDisplays(m)) != null;
}

export function showingAll(m: RdMonitors): boolean {
  return m.shown.length > 1;
}

/** 工具列「所有螢幕」圖示：把每個螢幕按實際排列縮進 `w × h` 的框（置中、留 `gap` 縫）。 */
export function miniLayout(displays: RdDisplay[], w: number, h: number, gap = 1): Box[] {
  const box = displayBounds(displays, displays.map((_, i) => i));
  if (!box) return [];
  const s = Math.min(w / box.w, h / box.h);
  const ox = (w - box.w * s) / 2;
  const oy = (h - box.h * s) / 2;
  return displays.map((d) => ({
    x: ox + (d.x - box.x) * s + gap / 2,
    y: oy + (d.y - box.y) * s + gap / 2,
    w: Math.max(1, d.width * s - gap),
    h: Math.max(1, d.height * s - gap),
  }));
}
