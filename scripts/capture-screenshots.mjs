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
function installShim(fx) {
  try { sessionStorage.setItem("dbkit:splashed", "1"); } catch { /* 略過開場動畫 */ }
  try {
    for (const [k, v] of Object.entries(fx.STORAGE_SEED)) localStorage.setItem(k, JSON.stringify(v));
    localStorage.setItem("db-kit:queryHistory", JSON.stringify([
      { sql: "SELECT status, COUNT(*) FROM orders GROUP BY status;", at: fx.now - 60_000, ms: 42, conn: "prod-mysql" },
      { sql: "SELECT * FROM customers WHERE tier = 'gold' LIMIT 50;", at: fx.now - 900_000, ms: 18, conn: "prod-mysql" },
    ]));
  } catch { /* localStorage 不可用時就用預設值 */ }

  const unknown = [];
  window.__DBKIT_UNKNOWN__ = unknown;
  const one = (columns, cells) => ({ columns, rows: [cells], rows_affected: 0 });

  const queryFor = (sql) => {
    const s = String(sql || "").toLowerCase();
    if (s.includes("version()")) return [one(["VERSION()", "@@character_set_server", "@@collation_server"], ["8.0.36", "utf8mb4", "utf8mb4_0900_ai_ci"])];
    if (s.includes("default_character_set_name")) return [one(["cs", "coll"], ["utf8mb4", "utf8mb4_0900_ai_ci"])];
    if (s.includes("data_length + index_length")) return [one(["mb"], ["54.13"])];
    if (s.includes("explain")) return [fx.EXPLAIN_RESULT];
    if (s.includes("group by status")) return [fx.MULTI_RESULTS[0]];
    if (s.includes("order_items")) return [fx.MULTI_RESULTS[1]];
    if (s.startsWith("use ")) return [];
    return [one(["result"], ["ok"])];
  };

  const isMysql = ({ id }) => id === "c-mysql";
  const handlers = {
    has_startup_password: () => false,
    list_saved_connections: () => fx.CONNECTIONS,
    set_query_guard: () => null,
    connect: () => null,
    disconnect: () => null,
    test_connection: () => null,
    clear_cache: () => null,
    save_connection: () => null,
    open_external: () => null,
    claude_detect: () => ({ installed: true, version: "2.1.0", logged_in: true, path: "/usr/local/bin/claude" }),
    pool_status: () => ({ size: 3, idle: 2, in_use: 1 }),
    ping_connection: () => 12,
    list_databases: ({ id }) => fx.DATABASES[id] ?? [],
    list_tables: ({ id, database }) => fx.TABLES[`${id}:${database}`] ?? [],
    list_routines: (a) => (isMysql(a) ? fx.ROUTINES : []),
    schema_columns: (a) => (isMysql(a) ? Object.entries(fx.SCHEMA_COLUMNS).map(([table, columns]) => ({ table, columns })) : []),
    // 結構類只對 MySQL 連線回 orders 的資料，Redis / 其他連線回空，右側「詳細資料」才不會串味
    table_columns: (a) => (isMysql(a) ? fx.ORDERS_COLUMNS : []),
    table_indexes: (a) => (isMysql(a) ? fx.ORDERS_INDEXES : []),
    list_foreign_keys: (a) => (isMysql(a) ? fx.ORDERS_FKS : []),
    table_info: (a) => (isMysql(a) ? fx.ORDERS_INFO : []),
    table_data: () => fx.ORDERS_PAGED,
    table_ddl: () => "CREATE TABLE `orders` (\n  `order_id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  ...\n) ENGINE=InnoDB",
    er_model: () => fx.ER_MODEL,
    search_objects: () => fx.SEARCH_HITS,
    routine_definition: () => "CREATE PROCEDURE sp_close_order(IN p_order_id BIGINT)\nBEGIN\n  UPDATE orders SET status = 'delivered' WHERE order_id = p_order_id;\nEND",
    explain_query: () => fx.EXPLAIN_RESULT,
    redis_keys: () => fx.REDIS_KEYS,
    redis_key_page: () => fx.REDIS_KEY_PAGE,
    server_info: () => fx.REDIS_INFO,
    redis_slowlog: () => [],
    redis_clients: () => [],
    list_schedules: () => [],
    list_backup_history: () => [],
    run_query: ({ sql }) => queryFor(sql)[0] ?? { columns: [], rows: [], rows_affected: 0 },
    run_query_multi: ({ sql }) => queryFor(sql),
  };

  let nextCb = 1;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => nextCb++,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke(cmd, args) {
      if (cmd.startsWith("plugin:event|")) return Promise.resolve(1);
      if (cmd.startsWith("plugin:")) return Promise.resolve(null);
      const h = handlers[cmd];
      if (!h) { unknown.push(cmd); return Promise.reject(new Error(`screenshot shim: 未實作的 command ${cmd}`)); }
      // 給一點延遲，loading 狀態才不會閃成空白
      return new Promise((res) => setTimeout(() => res(h(args ?? {})), 30));
    },
  };
}

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

  async "05-advanced-search"(page) {
    await openOrders(page);
    await page.getByRole("button", { name: /進階搜尋/ }).click();
    await sleep(600);
    await page.keyboard.type("order", { delay: 20 });
    await page.keyboard.press("Enter");
    await sleep(1200);
    await shot(page, "05-advanced-search");
  },
};

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
