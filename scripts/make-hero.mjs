// 產生 README 用的「產品介紹圖」(docs/hero.png)。
//
// 以品牌色與 App 實際深色主題（src/styles.css 的 cool-slate 變數）繪製一張
// 寬版橫幅：左側為品牌字標 / 標語 / 五大資料庫色標膠囊 / 技術棧，右側合成
// 既有的「魔術師海豹」吉祥物（取自 src/assets/logo-mark.png）。
//
// 重新產生：  node scripts/make-hero.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGO = resolve(root, "src/assets/logo-mark.png");
const OUT = resolve(root, "docs/hero.png");

const W = 1280;
const H = 520;

// 吉祥物在原圖 (1536x1024) 的範圍（沿用 make-favicon.mjs 量測值）。
const MASCOT_CROP = { left: 533, top: 4, width: 577, height: 655 };

// App 深色主題實際色票（src/styles.css）+ 五大資料庫色標（src/api.ts KIND_META）。
const C = {
  bgTop: "#0b0f16",
  bgBottom: "#161d28",
  panel: "#1b2330",
  fg: "#e4e9f2",
  dim: "#9aa7bd",
  accent: "#3b82f6", // 品牌藍
  flame: "#f97316", // 品牌火焰橘
};
const DBS = [
  { label: "MySQL", color: "#3b82f6", w: 120 },
  { label: "PostgreSQL", color: "#6366f1", w: 158 },
  { label: "SQLite", color: "#f59e0b", w: 116 },
  { label: "MongoDB", color: "#22c55e", w: 144 },
  { label: "Redis", color: "#ef4444", w: 104 },
];

// ---- 五大資料庫色標膠囊（一列排開） ----
const PILL_Y = 372;
const PILL_H = 42;
let px = 72;
const pills = DBS.map((d) => {
  const frag = `
    <g transform="translate(${px} ${PILL_Y})">
      <rect width="${d.w}" height="${PILL_H}" rx="21"
            fill="${C.panel}" stroke="${d.color}" stroke-opacity="0.55" stroke-width="1.5"/>
      <circle cx="24" cy="${PILL_H / 2}" r="6" fill="${d.color}"/>
      <text x="42" y="${PILL_H / 2 + 6}" font-family="Segoe UI, Arial, sans-serif"
            font-size="19" font-weight="600" fill="${C.fg}">${d.label}</text>
    </g>`;
  px += d.w + 12;
  return frag;
}).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.bgTop}"/>
      <stop offset="1" stop-color="${C.bgBottom}"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${C.accent}"/>
      <stop offset="1" stop-color="${C.flame}"/>
    </linearGradient>
    <radialGradient id="glowBlue" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.accent}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowFlame" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.flame}" stop-opacity="0.34"/>
      <stop offset="1" stop-color="${C.flame}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- 背景 + 景深光暈 -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="-150" y="-220" width="760" height="760" fill="url(#glowBlue)"/>
  <ellipse cx="1010" cy="250" rx="430" ry="430" fill="url(#glowFlame)"/>
  <rect width="${W}" height="${H}" fill="none" stroke="#2a3445" stroke-width="2"/>

  <!-- 品牌字標 eyebrow -->
  <g transform="translate(72 92)">
    <path d="M0 0 L5 13 L18 18 L5 23 L0 36 L-5 23 L-18 18 L-5 13 Z"
          transform="translate(9 0)" fill="url(#brand)"/>
    <text x="32" y="13" font-family="Segoe UI, Arial, sans-serif" font-size="22"
          font-weight="700" letter-spacing="5" fill="url(#brand)">MAGIDB CONNECT</text>
  </g>

  <!-- 主標題 -->
  <text x="70" y="210" font-family="Segoe UI, Arial, sans-serif" font-size="96"
        font-weight="800" fill="${C.fg}" letter-spacing="-2">db-kit</text>
  <rect x="74" y="228" width="170" height="6" rx="3" fill="url(#brand)"/>

  <!-- 標語 -->
  <text x="74" y="288" font-family="Microsoft JhengHei, Segoe UI, sans-serif" font-size="30"
        font-weight="600" fill="${C.fg}" fill-opacity="0.92">一站式跨平台資料庫管理工具</text>
  <text x="74" y="326" font-family="Segoe UI, Arial, sans-serif" font-size="21"
        font-style="italic" fill="${C.flame}" fill-opacity="0.95">Making Data Connections Magical</text>

  <!-- 五大資料庫色標 -->
  ${pills}

  <!-- 技術棧頁腳 -->
  <text x="74" y="466" font-family="Segoe UI, Arial, sans-serif" font-size="18"
        fill="${C.dim}">Tauri 2 · Rust · React · TypeScript　—　比 Electron 輕約 10×</text>
</svg>`;

// 1) 底圖（背景 + 文字 + 膠囊）
const base = await sharp(Buffer.from(svg)).png().toBuffer();

// 2) 吉祥物：裁切 → 縮放至右側區塊（contain，保留透明）
const MASCOT_H = 430;
const mascotAspect = MASCOT_CROP.width / MASCOT_CROP.height;
const mascotW = Math.round(MASCOT_H * mascotAspect);
const mascot = await sharp(LOGO)
  .extract(MASCOT_CROP)
  .resize(mascotW, MASCOT_H, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

const mascotLeft = W - mascotW - 96;
const mascotTop = Math.round((H - MASCOT_H) / 2);

await sharp(base)
  .composite([{ input: mascot, left: mascotLeft, top: mascotTop }])
  .png()
  .toFile(OUT);

console.log("hero 產生完成 →", OUT, `(${W}x${H})`);
