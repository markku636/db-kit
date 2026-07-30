// UI 冒煙檢查：在真實 production build 上驗右鍵選單與分頁行為（不需 Tauri 後端 / 不需真資料庫）。
//
// 與 capture-screenshots.mjs 同一套機制：vite preview 起 dist/，Playwright 開頁面前注入
// tauri-shim.mjs 的假 invoke（假資料見 screenshot-fixtures.mjs）。差別在於它不拍圖，
// 而是斷言「該有的選項在、不該有的不在」，跑完回非零 exit code 表示有回歸。
//
// 前置與執行（playwright 非本專案相依，可借用他處安裝）：
//   npm run build
//   node scripts/verify-ui.mjs
//   DBKIT_PLAYWRIGHT=<某處>/node_modules/playwright-core DBKIT_CHROME=<某處>/chrome.exe node scripts/verify-ui.mjs
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import * as FX from "./screenshot-fixtures.mjs";
import { installShim } from "./tauri-shim.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// 目前開啟的右鍵選單裡的所有項目文字（選單一律是 fixed z-[90] 的面板）。
const menuItems = (page) =>
  page.locator('div.fixed.z-\\[90\\] button').allTextContents();

async function closeMenu(page) {
  await page.keyboard.press("Escape");
  await page.mouse.click(640, 780); // 點遮罩收掉選單
  await sleep(150);
}

// ── 情境 ───────────────────────────────────────────────────────────────
const CASES = {
  // Kafka 主題右鍵：新增（發佈 / 建主題）· 修改（設定 / 分區）· 刪除（清空 / 刪除主題）
  async "kafka-topic-menu"(page) {
    await page.getByText("stream-kafka", { exact: true }).dblclick();
    await sleep(900);
    await page.getByText("cluster", { exact: true }).click();
    await page.waitForSelector('[data-tree-table="orders.events"]', { timeout: 8000 });
    await page.locator('[data-tree-table="orders.events"]').first().click({ button: "right" });
    await sleep(300);
    const items = await menuItems(page);
    const has = (s) => items.some((i) => i.includes(s));
    check("Kafka 主題右鍵：瀏覽訊息", has("瀏覽訊息"), items.join(" | "));
    check("Kafka 主題右鍵：發佈訊息…", has("發佈訊息"));
    check("Kafka 主題右鍵：從 CSV 批次發佈…", has("從 CSV 批次發佈"));
    check("Kafka 主題右鍵：新增主題…", has("新增主題"));
    check("Kafka 主題右鍵：消費者群組…", has("消費者群組"));
    check("Kafka 主題右鍵：主題設定 / 分區", has("主題設定"));
    check("Kafka 主題右鍵：清空主題…", has("清空主題"));
    check("Kafka 主題右鍵：刪除主題…", has("刪除主題"));
    await closeMenu(page);
  },

  // Kafka 連線的查詢分頁：不該再出現 Redis 指令提示，也不該有「執行」鈕
  async "kafka-query-pane"(page) {
    await page.getByText("stream-kafka", { exact: true }).dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(600);
    const body = await page.locator("#root").innerText();
    check("Kafka 查詢分頁不再顯示 Redis 指令提示", !body.includes("Redis 指令"));
    check("Kafka 查詢分頁顯示導引卡", body.includes("Kafka 連線不使用 SQL 查詢"));
    check("Kafka 查詢分頁沒有「執行」鈕", (await page.getByRole("button", { name: /執行 \(F6\)/ }).count()) === 0);
  },

  // 第一個「查詢」分頁可關；關到零時主區顯示空狀態，按「+」回到乾淨 home
  async "close-first-query-tab"(page) {
    await page.getByText("cache-redis", { exact: true }).dblclick();
    await sleep(900);
    const closeBtn = page.locator('button[title="關閉查詢分頁"]');
    check("第一個查詢分頁有關閉鈕", (await closeBtn.count()) > 0);
    await closeBtn.first().click();
    await sleep(500);
    const body = await page.locator("#root").innerText();
    check("關光查詢分頁後顯示空狀態", body.includes("已關閉所有查詢分頁"), body.slice(0, 120));
    await page.getByRole("button", { name: /新增查詢分頁/ }).first().click();
    await sleep(500);
    check("按「+」後回到查詢分頁", !(await page.locator("#root").innerText()).includes("已關閉所有查詢分頁"));
  },

  // Redis 側欄右鍵：連線層與 DB 層都能直達維運面板 / Pub/Sub（不必先開資料分頁）
  async "redis-sidebar-menus"(page) {
    // 連線名在側欄樹、狀態列與右側詳細資料都會出現，取第一個（樹裡的節點）
    await page.getByText("cache-redis", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("cache-redis", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    let items = await menuItems(page);
    check("Redis 連線右鍵：伺服器狀態", items.some((i) => i.includes("伺服器狀態")), items.join(" | "));
    check("Redis 連線右鍵：命令列", items.some((i) => i.includes("命令列")));
    check("Redis 連線右鍵：維運面板…", items.some((i) => i.includes("維運面板")));
    check("Redis 連線右鍵：Pub/Sub…", items.some((i) => i.includes("Pub/Sub")));
    await closeMenu(page);

    await page.getByText("0", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    items = await menuItems(page);
    check("Redis DB 右鍵：新增鍵…", items.some((i) => i.includes("新增鍵")), items.join(" | "));
    check("Redis DB 右鍵：維運面板…", items.some((i) => i.includes("維運面板")));
    check("Redis DB 右鍵：Pub/Sub…", items.some((i) => i.includes("Pub/Sub")));
    check("Redis DB 右鍵：清空 DB（FLUSHDB）", items.some((i) => i.includes("清空 DB")));
    await closeMenu(page);
  },

  // Redis 鍵樹：命名空間資料夾右鍵（新增鍵 / 複製前綴 / 刪除整段）、鍵節點右鍵
  async "redis-key-tree-menus"(page) {
    await page.getByText("cache-redis", { exact: true }).dblclick();
    await sleep(1200);
    await page.getByText("0", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="keys"]', { timeout: 8000 });
    await page.locator('[data-tree-table="keys"]').first().click();
    await sleep(1200);

    // 資料夾（命名空間）節點：鍵樹用 ":" 分組，fixtures 的鍵含 session: / cart: 等前綴。
    // 右鍵落在片段名的 span 上，事件冒泡到整列的 onContextMenu（資料夾處理器）。
    const folder = page.getByText("session", { exact: true }).first();
    await folder.click({ button: "right" });
    await sleep(300);
    let items = await menuItems(page);
    check("Redis 命名空間右鍵：在此命名空間新增鍵…", items.some((i) => i.includes("在此命名空間新增鍵")), items.join(" | "));
    check("Redis 命名空間右鍵：複製前綴", items.some((i) => i.includes("複製前綴")));
    check("Redis 命名空間右鍵：刪除此命名空間", items.some((i) => i.includes("刪除此命名空間")));
    await closeMenu(page);

    // 鍵（葉）節點：fixtures 的 cart:10427 展開後葉片段是 "10427"
    const leaf = page.locator("div.mono", { hasText: /^10427$/ }).first();
    if (await leaf.count()) {
      await leaf.click({ button: "right" });
      await sleep(300);
      items = await menuItems(page);
      check("Redis 鍵右鍵：檢視 / 編輯內容…", items.some((i) => i.includes("檢視 / 編輯內容")), items.join(" | "));
      check("Redis 鍵右鍵：新增鍵…", items.some((i) => i.includes("新增鍵")));
      check("Redis 鍵右鍵：複製鍵值", items.some((i) => i.includes("複製鍵值")));
      check("Redis 鍵右鍵：設定 TTL…", items.some((i) => i.includes("設定 TTL")));
      check("Redis 鍵右鍵：刪除", items.some((i) => i.trim() === "刪除"));
      await closeMenu(page);
    } else {
      check("Redis 鍵節點可右鍵", false, "找不到葉節點");
    }
  },
};

// ── main ───────────────────────────────────────────────────────────────
if (!existsSync(resolve(root, "dist/index.html"))) {
  console.error("找不到 dist/ —— 請先 `npm run build`（本腳本驗的是 production build）。");
  process.exit(1);
}

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.DBKIT_PLAYWRIGHT || "playwright")); }
catch {
  console.error("找不到 playwright —— 請先 `npm i -D playwright && npx playwright install chromium`，");
  console.error("或設 DBKIT_PLAYWRIGHT=<某處的 node_modules/playwright> 借用現成安裝。");
  process.exit(1);
}

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
const server = await preview({ root, preview: { port: 4174, strictPort: true } });
const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:4174/";
console.log(`preview → ${url}`);

const browser = await chromium.launch({ executablePath: process.env.DBKIT_CHROME || undefined });
const fx = { ...FX, now: Date.parse("2026-07-02T21:00:00Z") };

for (const name of want) {
  if (!CASES[name]) { failures.push(`未知情境：${name}`); continue; }
  console.log(`→ ${name}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW", colorScheme: "dark" });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  await page.addInitScript(installShim, fx);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#root");
  await sleep(1200);
  try { await CASES[name](page); }
  catch (e) { check(`${name} 執行`, false, String(e).split("\n")[0]); }
  if (pageErrors.length) check(`${name} 無前端例外`, false, pageErrors[0]);
  await ctx.close();
}

await browser.close();
await server.close();
console.log(`\n通過 ${passed}、失敗 ${failures.length}`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); }
process.exit(failures.length ? 1 : 0);
