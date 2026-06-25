// 產生 App 開場動畫（SplashScreen）用的「品牌標誌」dhero.png。
//
// 開場動畫（src/App.tsx SplashScreen + styles.css .splash__*）會：
//   1) <img> 顯示這張圖（width min(46vw,440px)，帶 drop-shadow 與彈跳/浮動）
//   2) .splash__shine 以「圖的 alpha」當 CSS mask，讓白色高光只掃過標誌輪廓
// 因此這張圖必須是「主體去背、透明背景」，高光與陰影才會貼合輪廓。
//
// 構圖：吉祥物（取自 logo-mark.png 的海豹）+ db-kit 字標 + MAGIDB CONNECT，全部畫在透明底上。
// 輸出：docs/dhero.png（給人看 / README）與 src/assets/dhero.png（給 App import）。
//
// 重新產生：  node scripts/make-splash.mjs
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOGO = resolve(root, 'src/assets/logo-mark.png')
const OUT_DOCS = resolve(root, 'docs/dhero.png')
const OUT_ASSET = resolve(root, 'src/assets/dhero.png')

// 吉祥物在原圖 (1536x1024) 的範圍（沿用 make-favicon.mjs 量測值）。
const MASCOT_CROP = { left: 533, top: 4, width: 577, height: 655 }

const W = 1000
const H = 940
const C = { fg: '#e9eef7', accent: '#3b82f6', flame: '#f97316' }

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

// 吉祥物：裁切 → 縮放（contain、保留透明）
const MASCOT_W = 540
const mascotAspect = MASCOT_CROP.width / MASCOT_CROP.height
const MASCOT_H = Math.round(MASCOT_W / mascotAspect)
const mascot = await sharp(LOGO)
  .extract(MASCOT_CROP)
  .resize(MASCOT_W, MASCOT_H, { fit: 'contain', background: TRANSPARENT })
  .png()
  .toBuffer()

// 文字層（透明底 SVG）：db-kit 字標 + MAGIDB CONNECT + 標語
const textTop = 40 + MASCOT_H + 30
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${C.accent}"/>
      <stop offset="1" stop-color="${C.flame}"/>
    </linearGradient>
  </defs>
  <text x="${W / 2}" y="${textTop + 80}" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-size="104" font-weight="800"
        letter-spacing="-2" fill="${C.fg}">db-kit</text>
  <text x="${W / 2}" y="${textTop + 124}" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-size="27" font-weight="700"
        letter-spacing="7" fill="url(#brand)">MAGIDB CONNECT</text>
  <text x="${W / 2}" y="${textTop + 158}" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-size="20" font-style="italic"
        fill="${C.flame}" fill-opacity="0.95">Making Data Connections Magical</text>
</svg>`

const out = await sharp({ create: { width: W, height: H, channels: 4, background: TRANSPARENT } })
  .composite([
    { input: mascot, left: Math.round((W - MASCOT_W) / 2), top: 40 },
    { input: Buffer.from(svg), left: 0, top: 0 },
  ])
  .png()
  .toBuffer()

await sharp(out).toFile(OUT_DOCS)
await sharp(out).toFile(OUT_ASSET)
console.log('splash 標誌產生完成（透明底）→')
console.log('  ', OUT_DOCS)
console.log('  ', OUT_ASSET, '（App 由此 import）')
