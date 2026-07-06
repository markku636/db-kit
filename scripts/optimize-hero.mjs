// 壓縮開場動畫 hero 圖（src/assets/db-kit-hero.png），原地覆蓋。
//
// 顯示端最大 min(62vw, 620px)（styles.css .splash__logo），2x DPI 也只需 1240px 寬；
// 原圖 3230x1312 過採樣 2.6 倍。縮到 1280 寬 + palette 量化，體積 ~5MB → 數百 KB，
// 啟動時少下載/解碼一張大圖，也直接縮小內嵌前端資產的 exe。
//
// 注意：路徑與副檔名不可改（qland overlay 以同路徑整檔覆蓋 db-kit-hero.png）。
// 重新產生：  node scripts/optimize-hero.mjs
import sharp from 'sharp'
import { statSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(root, 'src/assets/db-kit-hero.png')
const TMP = SRC + '.tmp'

const before = statSync(SRC).size
const meta = await sharp(SRC).metadata()

await sharp(SRC)
  .resize({ width: 1280, withoutEnlargement: true })
  .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
  .toFile(TMP)

renameSync(TMP, SRC)
const after = statSync(SRC).size
console.log(`db-kit-hero.png: ${meta.width}x${meta.height} ${(before / 1024).toFixed(0)} KB → 1280w ${(after / 1024).toFixed(0)} KB`)
