// 由品牌圖磚 brand/icon-source.png 產生桌面 App 圖示來源 src-tauri/app-icon.png。
//
// brand/icon-source.png（1024）是「圓角藍色圖磚 + 海豹吉祥物」的完整構圖，
// 吉祥物含尾鰭橫跨整張畫布，主體（頭＋帽）因此只佔一半左右 —— 縮到工作列 /
// 搜尋結果的 16~32px 後五官糊成一團，看不出是誰。
//
// 這裡把畫面往吉祥物的頭部推近（ZOOM 倍率、以 CENTER 為中心裁切），尾鰭讓它
// 出血到畫布外，讓臉在小尺寸佔到足夠面積；再把原圖的 alpha 貼回去，圓角圖磚
// 的外框才不會被裁切破壞。
//
// 重新產生：
//   npm run make:app-icon                     # 產生 src-tauri/app-icon.png
//   npm run tauri icon src-tauri/app-icon.png # 由來源產生 src-tauri/icons/ 全套圖示
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(root, "brand/icon-source.png");
const OUT = resolve(root, "src-tauri/app-icon.png");

const SIZE = 1024; // 來源與輸出皆為 1024 見方
// 推近倍率與裁切中心（以 1024 來源的座標計）。中心稍微偏上偏左：帽頂 y≈20，
// 1.3 倍下仍留得住整頂帽子，右側尾鰭與底部肚子則出血裁掉。
const ZOOM = 1.3;
const CENTER = { x: 464, y: 406 };

const scaled = Math.round(SIZE * ZOOM);
const clamp = (v) => Math.max(0, Math.min(scaled - SIZE, Math.round(v)));
const left = clamp(CENTER.x * ZOOM - SIZE / 2);
const top = clamp(CENTER.y * ZOOM - SIZE / 2);

// 原圖 alpha（圓角圖磚的外框）—— 裁切後貼回，維持一模一樣的圓角輪廓。
const alpha = await sharp(SRC).ensureAlpha().extractChannel(3).toColourspace("b-w").png().toBuffer();

const zoomed = await sharp(SRC)
  .resize(scaled, scaled, { kernel: "lanczos3" })
  .extract({ left, top, width: SIZE, height: SIZE })
  .removeAlpha()
  .png()
  .toBuffer();

await writeFile(OUT, await sharp(zoomed).joinChannel(alpha).png({ compressionLevel: 9 }).toBuffer());

console.log(`App 圖示來源 → ${OUT}（${SIZE}²，推近 ${ZOOM}×）`);
console.log("接著跑 npm run tauri icon src-tauri/app-icon.png 重生 src-tauri/icons/");
