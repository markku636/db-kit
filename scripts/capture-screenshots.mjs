// 產生 README 用的介面預覽圖（docs/screenshots/*.png）—— 真實畫面截圖。
//
// 作法：用 vite preview 起 production build，Playwright 開 1280×800 的 Chromium，
// 在頁面載入前注入 window.__TAURI_INTERNALS__ 的 invoke shim（scripts/screenshot-fixtures.mjs
// 的假資料），所以不需要 Tauri 後端、也不需要任何真實資料庫，畫面卻是真的 UI /
// 真的主題 / 真的元件。
//
// 前置：
//   npm run build                       # 先產出 dist/
//   npm i -D playwright                 # 未安裝時本腳本會提示
//   npx playwright install chromium     # 或用 DBKIT_CHROME 指向現成的 chrome/chromium
//
// 執行：
//   node scripts/capture-screenshots.mjs             # 全部
//   node scripts/capture-screenshots.mjs 04-redis    # 指定其中幾張
//
// 注意：必須拍 production build，不能拍 `npm run dev`——dev 的 React.StrictMode 會雙掛載
// effect，TableView 的 count 請求被 countSigRef 吃掉，分頁器會永遠停在「…」。
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import sharp from "sharp";
import * as FX from "./screenshot-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(root, "docs/screenshots");
const W = 1280;
const H = 800;
const DSF = 2; // 2× 擷取再縮到 1600 寬，字邊比直接拍 1600 乾淨

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 注入頁面的 Tauri shim（會被序列化，只能用參數帶資料進去）────────────
import { installShim } from "./tauri-shim.mjs";

// ── 共用步驟 ───────────────────────────────────────────────────────────
async function shot(page, name) {
  await page.mouse.move(1300, 690); // 移開滑鼠，免得列上還掛著 hover 的小圖示
  await sleep(300);
  const raw = resolve(OUT, `.${name}.raw.png`);
  await page.screenshot({ path: raw });
  await sharp(raw).resize({ width: 1600 }).png({ compressionLevel: 9, palette: true }).toFile(resolve(OUT, `${name}.png`));
  await rm(raw, { force: true });
  const unknown = await page.evaluate(() => window.__DBKIT_UNKNOWN__ ?? []);
  if (unknown.length) console.log(`  ⚠ shim 未實作的 command：${[...new Set(unknown)].join(", ")}`);
  console.log(`  ✓ ${name}.png`);
}

// 連線 prod-mysql → 展開 shop → 開 orders 資料分頁
async function openOrders(page) {
  await page.getByText("prod-mysql", { exact: true }).dblclick();
  await sleep(900);
  // 「常用」釘選區也有 shop / orders 字樣，取 nth(1) 才是樹裡的節點
  await page.getByText("shop", { exact: true }).nth(1).click();
  await sleep(700);
  await page.getByText("資料表", { exact: true }).first().click();
  await page.waitForSelector('[data-tree-table="orders"]', { timeout: 8000 });
  await sleep(400);
  await page.locator('[data-tree-table="orders"]').first().click();
  await sleep(1000);
}

// 連線 prod-mysql → 資料庫 shop 右鍵 →「結構比對…」（整庫）
async function openCompareDialog(page) {
  // .first()：連線開起來之後「prod-mysql」在分頁列與常用區也會出現，嚴格模式會抱怨多個命中。
  // 不能改成「已經有 shop 就跳過」——常用釘選區一開始就有 shop，那樣連線永遠不會展開。
  await page.getByText("prod-mysql", { exact: true }).first().dblclick();
  await sleep(1200);
  await page.getByText("shop", { exact: true }).nth(1).click({ button: "right" });
  await sleep(400);
  await page.getByText("結構比對…", { exact: true }).click();
  await sleep(1200);
}

// 開對話框 → 目標選 shop_archive → 按「比對選取的 N 表」→ 等結果出來
async function runCompare(page) {
  await openCompareDialog(page);
  await page.locator("select")
    .filter({ has: page.locator('option[value="shop_archive"]') })
    .filter({ hasNot: page.locator('option[value="information_schema"]') })
    .first()
    .selectOption("shop_archive");
  await sleep(500);
  await page.getByRole("button", { name: /比對選取的/ }).click();
  await sleep(2400);
}

const SHOTS = {
  async "01-data-grid"(page) {
    await openOrders(page);
    await sleep(700);
    await shot(page, "01-data-grid");
  },

  async "02-query-editor"(page) {
    await openOrders(page);
    // 分頁列的「查詢」分頁；不能用子字串比對，會選到工具列的「收藏查詢」按鈕
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(800);
    await page.locator(".cm-content").first().click();
    await page.keyboard.press("Control+a"); // 清掉預設的 SELECT 1
    await page.keyboard.type(FX.DEMO_SQL, { delay: 1 });
    await sleep(400);
    await page.keyboard.press("F6");
    await sleep(1600);
    await page.keyboard.press("Control+Home"); // 編輯器捲回第 1 行
    await sleep(3200);                          // 等「已執行 2 條語句」的 toast 淡出
    await shot(page, "02-query-editor");
  },

  async "03-er-diagram"(page) {
    await openOrders(page);
    await page.getByRole("button", { name: /ER 圖/ }).click();
    await sleep(2000);
    await shot(page, "03-er-diagram");
  },

  async "04-redis"(page) {
    await page.getByText("cache-redis", { exact: true }).dblclick();
    await sleep(1200);
    await page.getByText("0", { exact: true }).first().click(); // db 0
    await page.waitForSelector('[data-tree-table="keys"]', { timeout: 8000 });
    await page.locator('[data-tree-table="keys"]').first().click();
    await sleep(1200);
    // 不點鍵：值編輯器是 modal，會把整棵鍵樹壓在遮罩下。改選連線節點，右側顯示 Redis 連線資訊。
    await page.getByText("cache-redis", { exact: true }).click();
    await sleep(1200);
    await shot(page, "04-redis");
  },

  async "06-kafka"(page) {
    await page.getByText("stream-kafka", { exact: true }).dblclick();
    await sleep(900);
    await page.getByText("cluster", { exact: true }).click(); // 展開合成 cluster 節點 → 主題直接列在其下
    await sleep(700);
    await page.waitForSelector('[data-tree-table="orders.events"]', { timeout: 8000 });
    await page.locator('[data-tree-table="orders.events"]').first().click(); // 單擊開訊息瀏覽器
    await sleep(1000);
    // 分頁列也有「查詢」home 分頁按鈕，取 last 才是訊息瀏覽器工具列的查詢鈕
    await page.getByRole("button", { name: "查詢", exact: true }).last().click(); // 消費近期訊息（shim 直接回假資料）
    await sleep(1500);
    await shot(page, "06-kafka");
  },

  // 右鍵預存程序 →「執行程序…」的引數表單：方向 / 名稱 / 型別各一欄，下方即時顯示送出的 SQL。
  // 走右鍵而非雙擊——雙擊進的是設計編輯器，那只是一個 SQL 編輯器，沒什麼好拍的。
  async "09-routine-exec"(page) {
    await openOrders(page);
    await page.getByText("函式", { exact: true }).first().click(); // 展開 routines 資料夾
    await sleep(700);
    await page.getByText("sp_close_order", { exact: true }).first().click({ button: "right" });
    await sleep(500);
    await page.getByText("執行程序…", { exact: true }).click();
    await sleep(900);
    // 填前兩個 IN 引數；第三個是 OUT，沒有輸入格（值由程序寫回）。
    const inputs = page.locator('input[placeholder="留空 = NULL"]');
    await inputs.nth(0).fill("48127");
    await inputs.nth(1).fill("客服代結");
    await sleep(600); // 等下方 SQL 預覽跟上
    await shot(page, "09-routine-exec");
  },

  async "05-advanced-search"(page) {
    await openOrders(page);
    await page.getByRole("button", { name: /進階搜尋/ }).click();
    await sleep(600);
    await page.keyboard.type("order", { delay: 20 });
    await page.keyboard.press("Enter");
    await sleep(1200);
    await shot(page, "05-advanced-search");
  },

  // 整庫結構 / 資料比對：資料庫右鍵 →「結構 / 資料比對…」，目標改成 shop_archive（同連線跨庫，
  // 預設目標與來源同庫會被擋下），模式選「兩者」，按下比對後拍逐表狀態 + 彙總同步腳本。
  async "10-schema-compare"(page) {
    await runCompare(page);
    // 順便把 AI 總結跑出來——那一格空著時截圖看不出這個功能存在。
    await page.getByRole("button", { name: "產生總結", exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes("建議順序"), null, { timeout: 15_000 });
    await sleep(400);
    await shot(page, "10-schema-compare");
  },

  // ── docs/compare.md 的教學圖 ──────────────────────────────────────────
  // 與 10-schema-compare 的差別：那張是「功能長怎樣」的門面圖，這幾張是「第幾步該按哪裡」，
  // 所以刻意停在中間狀態（選單打開、還沒比、確認框跳出來）。

  // 入口：資料庫右鍵選單，同時看得到「結構比對…」與「儲存結構快照…」。
  async "compare-guide-01-menu"(page) {
    await page.getByText("prod-mysql", { exact: true }).dblclick();
    await sleep(1200);
    await page.getByText("shop", { exact: true }).nth(1).click({ button: "right" });
    await sleep(500);
    await shot(page, "compare-guide-01-menu");
  },

  // 比對前：目標選擇器（連線 / 資料庫）+ 左欄的資料表多選。
  async "compare-guide-02-setup"(page) {
    await openCompareDialog(page);
    await sleep(600);
    await shot(page, "compare-guide-02-setup");
  },

  // 單一資料表：多一個「資料表」下拉，可以比不同名字的兩張表。
  async "compare-guide-03-table"(page) {
    await page.getByText("prod-mysql", { exact: true }).dblclick();
    await sleep(1200);
    await page.getByText("shop", { exact: true }).nth(1).click();
    await sleep(700);
    await page.getByText("資料表", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="orders"]', { timeout: 8000 });
    await sleep(300);
    await page.locator('[data-tree-table="orders"]').first().click({ button: "right" });
    await sleep(400);
    await page.getByText("結構比對…", { exact: true }).click();
    await sleep(1400);
    await shot(page, "compare-guide-03-table");
  },

  // 目標改用快照檔：載入後會顯示種類 / 庫名 / 擷取時間 / 表數。
  async "compare-guide-04-snapshot"(page) {
    await openCompareDialog(page);
    await page.getByRole("radio", { name: "快照檔案", exact: true }).click();
    await sleep(400);
    await page.getByRole("button", { name: /選擇快照檔/ }).click();
    await sleep(900);
    await shot(page, "compare-guide-04-snapshot");
  },

  // 差異細節：點結果列展開某張表的欄位 / 索引 / 外鍵差異與並排 DDL。
  async "compare-guide-05-drilldown"(page) {
    await runCompare(page);
    await page.locator('button:has-text("orders")').first().click();
    await sleep(1200);
    await shot(page, "compare-guide-05-drilldown");
  },

  // 破壞性確認框：勾了「包含破壞性語句」再按「直接執行」才會跳出來。
  async "compare-guide-06-confirm"(page) {
    // 示範資料把 prod-mysql 設成唯讀（那正是 10-schema-compare 那張「無法執行」的由來），
    // 但這張要拍的就是執行前的確認框，所以先關掉唯讀。
    // 不先 dblclick：連線節點不展開也右鍵得到，而 runCompare 自己會展開——
    // 這裡多按一次反而會把剛展開的樹收回去。
    await page.getByText("prod-mysql", { exact: true }).first().click({ button: "right" });
    await sleep(400);
    await page.getByText("關閉唯讀模式", { exact: true }).click();
    await sleep(500);
    await runCompare(page);
    // 破壞性那組預設不勾，勾了「直接執行」才送得出去。
    await page.locator('label:has-text("包含破壞性語句") input[type="checkbox"]').first().check();
    await sleep(400);
    await page.getByRole("button", { name: "直接執行", exact: true }).click();
    await sleep(800);
    await shot(page, "compare-guide-06-confirm");
  },

  // 審查並執行：查詢分頁工具列的盾牌鈕 → AI 審查串流完、左側逐句的回滾等級與注意事項。
  // 示範資料把 prod-mysql 設成唯讀；這幾張要拍的是可以執行的狀態，先關掉唯讀。
  async "12-review-run"(page) {
    await openReviewRun(page);
    await page.locator('label:has-text("我了解有") input[type="checkbox"]').first().check();
    await sleep(300);
    await shot(page, "12-review-run");
  },

  // 執行後的結果分頁：輸出目錄、檔案清單與逐欄的執行前 / 執行後差異。
  async "13-review-run-diff"(page) {
    await runReviewRun(page);
    // 捲到「執行前後差異」標題，讓畫面從差異表開始（上方的輸出檔案清單另見 README 說明）。
    await page.getByText("執行前後差異", { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    await sleep(300);
    await shot(page, "13-review-run-diff");
  },

  // 回滾腳本：最後一句排最前面，無法安全還原的列以註解列出並寫明原因。
  async "14-review-run-rollback"(page) {
    await runReviewRun(page);
    await page.getByText("回滾腳本", { exact: true }).first().click();
    await sleep(500);
    await shot(page, "14-review-run-rollback");
  },

  // 整庫資料字典：資料庫右鍵 →「資料庫文件…」，等逐表結構抓完後拍 Markdown 預覽。
  async "11-db-docs"(page) {
    await page.getByText("prod-mysql", { exact: true }).dblclick();
    await sleep(1200);
    await page.getByText("shop", { exact: true }).nth(1).click({ button: "right" });
    await sleep(400);
    await page.getByText("資料庫文件…", { exact: true }).click();
    await sleep(2600);
    await shot(page, "11-db-docs");
  },
};

// 審查並執行：關唯讀 → 開查詢分頁 → 貼腳本 → 按盾牌鈕 → 等 AI 審查串流完。
const REVIEW_SQL =
  "UPDATE orders SET status = 'cancelled' WHERE status = 'pending' AND placed_at < '2026-01-01';\n" +
  "DELETE FROM order_notes WHERE created_at < '2025-01-01';";
async function openReviewRun(page) {
  await page.getByText("prod-mysql", { exact: true }).first().click({ button: "right" });
  await sleep(400);
  await page.getByText("關閉唯讀模式", { exact: true }).click();
  await sleep(500);
  await page.getByText("prod-mysql", { exact: true }).first().dblclick();
  await sleep(1200);
  await page.getByText("查詢", { exact: true }).first().click();
  await sleep(900);
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(REVIEW_SQL);
  await sleep(500);
  await page.locator('[data-testid="review-run-open"]').first().click();
  await page.getByRole("button", { name: "重新審查", exact: true }).first().waitFor({ timeout: 20000 });
  await sleep(600);
}
async function runReviewRun(page) {
  await openReviewRun(page);
  await page.locator('label:has-text("我了解有") input[type="checkbox"]').first().check();
  await sleep(300);
  await page.getByRole("button", { name: "執行（含備份）", exact: true }).click();
  await sleep(600);
  await page.getByRole("button", { name: "執行", exact: true }).last().click(); // 確認框
  await page.waitForFunction(() => document.body.innerText.includes("已執行完成"), null, { timeout: 8000 });
  // 等「已執行」toast 自己消失，截圖右下角才乾淨。
  await page.waitForFunction(() => !document.body.innerText.includes("已執行，備份與差異已寫入輸出目錄"), null, { timeout: 15000 }).catch(() => {});
  await sleep(400);
}

// ── main ───────────────────────────────────────────────────────────────
if (!existsSync(resolve(root, "dist/index.html"))) {
  console.error("找不到 dist/ —— 請先 `npm run build`（本腳本拍的是 production build）。");
  process.exit(1);
}

// playwright 不是 db-kit 的相依（只有產圖時才用）。DBKIT_PLAYWRIGHT 可指向別處已安裝的套件目錄。
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.DBKIT_PLAYWRIGHT || "playwright")); }
catch {
  console.error("找不到 playwright —— 請先 `npm i -D playwright && npx playwright install chromium`，");
  console.error("或設 DBKIT_PLAYWRIGHT=<某處的 node_modules/playwright> 借用現成安裝。");
  process.exit(1);
}

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
await mkdir(OUT, { recursive: true });

const server = await preview({ root, preview: { port: 4173, strictPort: true } });
const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:4173/";
console.log(`preview → ${url}`);

const browser = await chromium.launch({
  executablePath: process.env.DBKIT_CHROME || undefined, // 想借用系統 / 其他專案的 chromium 時設它
  args: ["--force-color-profile=srgb", "--font-render-hinting=none"],
});
// 假資料 + 一個固定時間戳（查詢歷史用；不能在頁面內取 Date.now()，否則每次產圖都不一樣）
const fx = { ...FX, now: Date.parse("2026-07-02T21:00:00Z") };

let failed = 0;
for (const name of want) {
  if (!SHOTS[name]) { console.log(`× 未知的截圖：${name}（可用：${Object.keys(SHOTS).join(", ")}）`); failed++; continue; }
  console.log(`→ ${name}`);
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: DSF,
    reducedMotion: "reduce", locale: "zh-TW", colorScheme: "dark",
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 160)));
  await page.addInitScript(installShim, fx);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#root");
  await sleep(1200);
  try { await SHOTS[name](page); }
  catch (e) { console.log(`  ✗ 失敗：${String(e).split("\n")[0]}`); failed++; }
  await ctx.close();
}

await browser.close();
await server.close();
console.log(failed ? `完成（${failed} 張失敗）` : "完成");
process.exit(failed ? 1 : 0);
