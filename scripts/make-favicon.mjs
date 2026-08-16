// 由品牌標誌產生網頁 favicon（瀏覽器分頁 / apple-touch-icon）。
//
// 來源 src/assets/logo-mark.png 是「海豹吉祥物 + 火焰 + MAGIDB CONNECT 字標」
// 的寬版插畫（1536x1024）。圖示需要正方形且在 16~32px 仍可辨識，因此只取
// 「海豹吉祥物」這個品牌角色，置中 contain 進正方形（透明邊），輸出到 public/。
//
// 桌面 App 圖示走另一條線：來源是 brand/icon-source.png（圓角藍色圖磚），
// 見 scripts/make-app-icon.mjs。
//
// 重新產生：  node scripts/make-favicon.mjs
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(root, "src/assets/logo-mark.png");
const OUT = resolve(root, "public");

// 海豹吉祥物在原圖中的範圍（由 alpha 內容分布量測）。左界取 535 以排除左下角
// 魔術帽邊緣（帽緣右界 x≈530，僅出現在 y≥540），僅犧牲極細的鬍鬚尖端。
const CROP = { left: 533, top: 4, width: 577, height: 655 };

// 輸出尺寸：.ico 內含的多解析度 + apple-touch + 給 <link> 用的 png。
const ICO_SIZES = [16, 32, 48];
const PNG_SIZES = [32, 180];

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

async function squareMark(size) {
  // 取吉祥物 → contain 進正方形（透明邊），高品質縮放。
  return sharp(SRC)
    .extract(CROP)
    .resize(size, size, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
}

await mkdir(OUT, { recursive: true });

// 1) favicon.ico（多解析度，給瀏覽器分頁與舊環境最佳相容）
const icoBuffers = await Promise.all(ICO_SIZES.map((s) => squareMark(s)));
await writeFile(resolve(OUT, "favicon.ico"), await pngToIco(icoBuffers));

// 2) png（現代瀏覽器與 apple-touch-icon）
for (const s of PNG_SIZES) {
  const name = s === 180 ? "apple-touch-icon.png" : `favicon-${s}.png`;
  await writeFile(resolve(OUT, name), await squareMark(s));
}

console.log("favicon 產生完成 →", OUT);
console.log("  favicon.ico (16/32/48)、favicon-32.png、apple-touch-icon.png");
console.log("桌面 App 圖示請跑 npm run make:app-icon（來源 brand/icon-source.png）");
