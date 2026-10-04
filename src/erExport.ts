import type { ErModel, ErTable } from "./api";

// ER 圖匯出：由模型 + 目前的卡片位置直接組出獨立的 SVG（不擷取 DOM）——
// 畫面上的卡片是 HTML，截圖會受縮放、捲動位置、深色主題影響；這裡固定淺底、裁到內容範圍，
// 貼進文件 / 簡報都乾淨。PNG 由同一份 SVG 在 canvas 上光柵化。
// 幾何與 ErDiagram 一致（卡寬 210、表頭 26、每欄 20），使用者拖好的佈局原樣保留。

export const ER_CARD_W = 210;
const HEAD_H = 26;
const ROW_H = 20;
const PAD = 24;
const FONT = `"Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", sans-serif`;
const MONO = `"JetBrains Mono", "Cascadia Code", Consolas, monospace`;

export const erCardHeight = (t: ErTable) => HEAD_H + t.columns.length * ROW_H + 4;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 超過寬度的字截斷加 …（以字元數估算；CJK 算兩格）。 */
function fit(s: string, maxUnits: number): string {
  let units = 0;
  let out = "";
  for (const ch of s) {
    const w = /[⺀-￿]/.test(ch) ? 2 : 1;
    if (units + w > maxUnits) return out + "…";
    units += w;
    out += ch;
  }
  return out;
}

export function erToSvg(model: ErModel, pos: Record<string, { x: number; y: number }>, title?: string): { svg: string; width: number; height: number } {
  const placed = model.tables.filter((t) => pos[t.name]);
  if (placed.length === 0) return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`, width: 1, height: 1 };
  const minX = Math.min(...placed.map((t) => pos[t.name].x));
  const minY = Math.min(...placed.map((t) => pos[t.name].y));
  const maxX = Math.max(...placed.map((t) => pos[t.name].x + ER_CARD_W));
  const maxY = Math.max(...placed.map((t) => pos[t.name].y + erCardHeight(t)));
  const titleH = title ? 28 : 0;
  const ox = PAD - minX;
  const oy = PAD + titleH - minY;
  const width = Math.ceil(maxX - minX + PAD * 2);
  const height = Math.ceil(maxY - minY + PAD * 2 + titleH);
  const byName = new Map(placed.map((t) => [t.name, t]));
  const center = (n: string) => {
    const t = byName.get(n);
    if (!t) return null;
    const p = pos[n];
    return { x: p.x + ox + ER_CARD_W / 2, y: p.y + oy + erCardHeight(t) / 2 };
  };

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  if (title) parts.push(`<text x="${PAD}" y="${PAD + 14}" font-family='${FONT}' font-size="15" font-weight="600" fill="#111827">${esc(title)}</text>`);
  // 關聯線先畫（在卡片底下）。
  for (const r of model.relations) {
    const a = center(r.from_table);
    const b = center(r.to_table);
    if (!a || !b) continue;
    parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#3b82f6" stroke-width="1.5" opacity="0.6"><title>${esc(`${r.from_table}.${r.from_column} → ${r.to_table}.${r.to_column}`)}</title></line>`);
  }
  for (const t of placed) {
    const x = pos[t.name].x + ox;
    const y = pos[t.name].y + oy;
    const h = erCardHeight(t);
    parts.push(`<g>`);
    parts.push(`<rect x="${x}" y="${y}" width="${ER_CARD_W}" height="${h}" rx="4" fill="#ffffff" stroke="#cbd5e1"/>`);
    parts.push(`<path d="M${x} ${y + 4}a4 4 0 0 1 4 -4h${ER_CARD_W - 8}a4 4 0 0 1 4 4v${HEAD_H - 4}h-${ER_CARD_W}z" fill="#dbeafe"/>`);
    parts.push(`<text x="${x + 8}" y="${y + 17}" font-family='${FONT}' font-size="12" font-weight="600" fill="#1e3a8a">${esc(fit(t.name, 30))}</text>`);
    t.columns.forEach((c, i) => {
      const cy = y + HEAD_H + i * ROW_H;
      if (i > 0) parts.push(`<line x1="${x}" y1="${cy}" x2="${x + ER_CARD_W}" y2="${cy}" stroke="#f1f5f9"/>`);
      const mark = c.pk ? `<text x="${x + 6}" y="${cy + 14}" font-size="10" fill="#d97706">PK</text>`
        : c.fk ? `<text x="${x + 6}" y="${cy + 14}" font-size="10" fill="#2563eb">FK</text>` : "";
      parts.push(mark);
      parts.push(`<text x="${x + 26}" y="${cy + 14}" font-family='${FONT}' font-size="11" fill="${c.fk ? "#1d4ed8" : "#111827"}">${esc(fit(c.name, 20))}</text>`);
      parts.push(`<text x="${x + ER_CARD_W - 6}" y="${cy + 14}" text-anchor="end" font-family='${MONO}' font-size="10" fill="#94a3b8">${esc(fit(c.data_type, 12))}</text>`);
    });
    parts.push(`</g>`);
  }
  parts.push(`</svg>`);
  return { svg: parts.join(""), width, height };
}

/** SVG → PNG（base64，不含 data: 前綴）。scale = 2 給高解析度螢幕 / 簡報用。 */
export async function svgToPngBase64(svg: string, width: number, height: number, scale = 2): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG render failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  } finally {
    URL.revokeObjectURL(url);
  }
}
