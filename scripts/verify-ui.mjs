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

// 少數情境需要與截圖不同的假資料（如「連線多到滿出側欄」要 40 筆而非 7 筆）。
// 在此以 fx 欄位覆寫；其餘情境仍共用 screenshot-fixtures.mjs 的那一份。
const MANY_GROUPS = [
  { id: "g-prod", name: "PROD" },
  { id: "g-stage", name: "STAGE" },
  { id: "g-dev", name: "DEV" },
];
const MANY_CONNECTIONS = Array.from({ length: 40 }, (_, i) => ({
  ...FX.CONNECTIONS[i % FX.CONNECTIONS.length],
  id: `many-${i}`,
  // 補零讓字典序＝建立序，最後一筆固定是 conn-39。
  name: `conn-${String(i).padStart(2, "0")}`,
  // 前 30 筆分三組、後 10 筆留未分組 —— 兩種區段都在畫面上。
  group_id: i < 30 ? MANY_GROUPS[i % 3].id : null,
}));
const CASE_FX = {
  "sidebar-scroll-reaches-last": { CONNECTIONS: MANY_CONNECTIONS, CONN_GROUPS: MANY_GROUPS },
};

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
  // 結構快取徽章：MySQL 查詢分頁要顯示快取時間並可點；Kafka 這種沒有欄位結構的連線不該出現。
  // 徽章是「自動完成用的是哪個時間點的結構」的唯一告知處，消失了使用者就只能盲信提示。
  async "schema-cache-badge"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(900);
    const badge = page.getByRole("button", { name: /^結構/ });
    const shown = (await badge.count()) > 0;
    check("MySQL 查詢分頁顯示結構快取徽章", shown, shown ? "" : await page.locator("#root").innerText());
    if (shown) {
      check("徽章顯示快取時間（固定年齡 → 2 小時前）", /2 小時前/.test(await badge.first().innerText()));
      const title = await badge.first().getAttribute("title");
      check("徽章提示說明快取時間與外部變更偵測不到", /結構快取更新於/.test(title ?? ""), title ?? "(無 title)");
    }

    // 沒有欄位結構的連線不顯示徽章（Kafka：主題不是表，沒有欄位可補全）
    await page.getByText("stream-kafka", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(700);
    check("Kafka 查詢分頁沒有結構快取徽章", (await page.getByRole("button", { name: /^結構/ }).count()) === 0);
  },

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

  // 唯讀連線：Kafka 的寫入入口（主題右鍵發佈 / 建刪主題、訊息瀏覽器的發佈列）要整批消失
  async "kafka-readonly-hides-writes"(page) {
    await page.getByText("stream-kafka", { exact: true }).first().dblclick();
    await sleep(1000);
    await page.getByText("stream-kafka", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    await page.getByText("設為唯讀模式（擋寫入 / DDL）", { exact: true }).click();
    await sleep(500);

    await page.getByText("cluster", { exact: true }).click();
    await page.waitForSelector('[data-tree-table="orders.events"]', { timeout: 8000 });
    await page.locator('[data-tree-table="orders.events"]').first().click({ button: "right" });
    await sleep(300);
    const items = await menuItems(page);
    check("唯讀：主題右鍵沒有「發佈訊息」", !items.some((i) => i.includes("發佈訊息")), items.join(" | "));
    check("唯讀：主題右鍵沒有「新增主題」", !items.some((i) => i.includes("新增主題")));
    check("唯讀：主題右鍵沒有「刪除主題」", !items.some((i) => i.includes("刪除主題")));
    check("唯讀：主題右鍵沒有「清空主題」", !items.some((i) => i.includes("清空主題")));
    check("唯讀：主題右鍵保留「瀏覽訊息」", items.some((i) => i.includes("瀏覽訊息")));
    await closeMenu(page);

    // 訊息瀏覽器：發佈 / CSV / 送往主題 應消失，匯出留著
    await page.locator('[data-tree-table="orders.events"]').first().click();
    await sleep(1000);
    check("唯讀：訊息瀏覽器沒有「發佈」鈕", (await page.getByRole("button", { name: /^發佈$/ }).count()) === 0);
    check("唯讀：訊息瀏覽器沒有「送往主題…」鈕", (await page.getByRole("button", { name: /送往主題/ }).count()) === 0);
    check("唯讀：訊息瀏覽器保留「匯出」鈕", (await page.getByRole("button", { name: /^匯出$/ }).count()) > 0);
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

  // 唯讀連線：Redis 的寫入入口（新增鍵 / 刪除命名空間 / FLUSHDB）要整批消失，讀取類保留
  async "redis-readonly-hides-writes"(page) {
    await page.getByText("cache-redis", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("cache-redis", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    await page.getByText("設為唯讀模式（擋寫入 / DDL）", { exact: true }).click();
    await sleep(500);

    // DB 節點：新增鍵 / 清空 DB 應消失，狀態 / 命令列 / 維運 / Pub-Sub 留著
    await page.getByText("0", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    let items = await menuItems(page);
    check("唯讀：DB 右鍵沒有「新增鍵」", !items.some((i) => i.includes("新增鍵")), items.join(" | "));
    check("唯讀：DB 右鍵沒有「清空 DB」", !items.some((i) => i.includes("清空 DB")));
    check("唯讀：DB 右鍵保留「伺服器狀態」", items.some((i) => i.includes("伺服器狀態")));
    await closeMenu(page);

    // 鍵樹命名空間：新增鍵 / 刪除整段應消失，複製 / 縮範圍留著
    await page.getByText("0", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="keys"]', { timeout: 8000 });
    await page.locator('[data-tree-table="keys"]').first().click();
    await sleep(1200);
    await page.getByText("session", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    items = await menuItems(page);
    check("唯讀：命名空間右鍵沒有「在此命名空間新增鍵」", !items.some((i) => i.includes("在此命名空間新增鍵")), items.join(" | "));
    check("唯讀：命名空間右鍵沒有「刪除此命名空間」", !items.some((i) => i.includes("刪除此命名空間")));
    check("唯讀：命名空間右鍵保留「複製前綴」", items.some((i) => i.includes("複製前綴")));
    await closeMenu(page);

    check("唯讀：工具列沒有「新增鍵」按鈕", (await page.getByRole("button", { name: /^新增鍵$/ }).count()) === 0);
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
    check("Redis 命名空間右鍵：只顯示此命名空間", items.some((i) => i.includes("只顯示此命名空間")));
    check("Redis 命名空間右鍵：複製前綴", items.some((i) => i.includes("複製前綴")));
    check("Redis 命名空間右鍵：刪除此命名空間", items.some((i) => i.includes("刪除此命名空間")));

    // 「只顯示此命名空間」應把 MATCH 樣式換成 session:*
    await page.getByText("只顯示此命名空間", { exact: true }).click();
    await sleep(900);
    const pat = await page.locator('input[placeholder*="MATCH"]').first().inputValue();
    check("只顯示此命名空間 → MATCH 樣式縮到該前綴", pat === "session:*", `pattern=${pat}`);

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

  // 側欄連線滿出頁面時，最後一筆必須滾得到（回歸：外殼曾經同時是 column flex 與捲動容器，
  // 子項被 flex-shrink 壓縮後捲動高度算不出來，最底下幾筆永遠碰不到）。
  async "sidebar-scroll-reaches-last"(page, caseFx) {
    // 40 筆連線（見 CASE_FX），在一般視窗高度下就會滿出側欄 —— 使用者回報的正是這個情境。
    const box = page.locator("[data-sidebar-scroll]").first();
    if (!(await box.count())) { check("側欄有獨立的捲動視窗", false, "找不到 [data-sidebar-scroll]"); return; }

    const m = await box.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    check("內容溢出時側欄真的產生捲動高度", m.scroll > m.client, `scrollHeight=${m.scroll} clientHeight=${m.client}`);

    // 用真實滑鼠滾輪捲（使用者回報的是「滾」不到，不是程式捲不到）：
    // 游標移到側欄上，連續滾到底。
    const bb = await box.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 400); await sleep(60); }
    await sleep(300);
    const after = await box.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    check("滑鼠滾輪可把側欄捲到底", after.top >= after.max - 2, `scrollTop=${after.top} max=${after.max}`);

    // 最後一筆連線捲到底後必須完整落在捲動視窗內。
    const conns = caseFx.CONNECTIONS;
    const lastName = conns[conns.length - 1].name;
    const last = page.getByText(lastName, { exact: true }).first();
    const rects = await box.evaluate((el, name) => {
      const c = el.getBoundingClientRect();
      const row = Array.from(el.querySelectorAll("span")).find((s) => s.textContent === name);
      const r = row?.getBoundingClientRect();
      return r ? { top: c.top, bottom: c.bottom, rowTop: r.top, rowBottom: r.bottom } : null;
    }, lastName);
    if (!rects) { check(`捲到底後找得到最後一筆連線（${lastName}）`, false); return; }
    // 容 1px 的次像素誤差。
    check(
      `捲到底後最後一筆（${lastName}）完整可見`,
      rects.rowBottom <= rects.bottom + 1 && rects.rowTop >= rects.top - 1,
      JSON.stringify(rects),
    );
    check(`最後一筆（${lastName}）可點擊`, await last.isVisible());

    // 搜尋列改成固定列後，捲到底仍要看得見（不能因為拿掉 sticky 就跟著捲走）。
    check("捲到底時搜尋列仍可見", await page.locator('input[placeholder="搜尋連線 / 表…"]').first().isVisible());
  },

  // 工具列星星：一鍵收藏目前查詢（自動命名、不跳對話框），再點一次取消收藏。
  // 原本只有「更多 → 收藏目前查詢…」一條路，要穿兩層 UI 才存得起來。
  async "query-toolbar-star-favorite"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(600);

    const star = page.locator('button[title*="一鍵收藏目前查詢"]');
    check("工具列有一鍵收藏的星星鈕", (await star.count()) > 0);

    // 編輯器是 lazy chunk，等它掛上；分頁開起來時已帶入 USE 範圍前綴，先清空才測得到停用態。
    await page.waitForSelector(".cm-content", { timeout: 8000 });
    await page.locator(".cm-content").first().click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await sleep(400);
    check("空 SQL 時星星停用", await star.first().isDisabled());

    await page.keyboard.type("SELECT * FROM orders WHERE id > 10");
    await sleep(400);
    check("輸入 SQL 後星星啟用", !(await star.first().isDisabled()));

    await star.first().click();
    await sleep(400);
    // 存起來後：星星轉成「已收藏」狀態（title 改為可取消收藏），名稱由 SQL 自動推導。
    const savedStar = page.locator('button[title*="已收藏為"]');
    check("一鍵收藏後星星轉為已收藏狀態", (await savedStar.count()) > 0);
    const savedTitle = (await savedStar.first().getAttribute("title")) ?? "";
    check("名稱由 SQL 自動推導為「SELECT orders」", savedTitle.includes("SELECT orders"), savedTitle);

    // 下拉清單裡看得到它。
    await page.locator('button[aria-label="收藏的查詢"]').first().click();
    await sleep(300);
    check("收藏清單列出剛存的查詢", (await page.getByText("SELECT orders", { exact: true }).count()) > 0);
    await closeMenu(page);

    // 再點一次＝取消收藏（同一顆鈕的 toggle 語意）。
    await savedStar.first().click();
    await sleep(400);
    check("再點一次即取消收藏", (await page.locator('button[title*="已收藏為"]').count()) === 0);
    check("取消後回到未收藏狀態", (await page.locator('button[title*="一鍵收藏目前查詢"]').count()) > 0);
  },

  // 查詢工具列的三階自適應：寬 → 圖示+文字；中 → 次要鈕只留圖示；窄 → 無下拉的次要鈕折進「更多」。
  // 重點是「絕不裁掉按鈕」：曾經用 justify-end + overflow-hidden 量測，放不下時溢位往左擠，
  // 最左邊的新查詢 / 歷史 / 收藏星星會被裁到看不見也點不到。
  async "query-toolbar-adapts-to-width"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(600);

    const fmt = page.locator('button[title*="格式化 SQL"]');
    const star = page.locator('button[title*="一鍵收藏目前查詢"], button[title*="已收藏為"]');
    // 寬度門檻刻意訂得寬鬆：查詢面板還要跟側欄、右側詳細資料分寬度，1280 的視窗實際只留給
    // 工具列 ~340px（量過），所以「完整標籤」得在很寬的視窗才看得到。
    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(700);
    check("寬版：格式化鈕帶文字標籤", (await fmt.first().innerText()).includes("格式化"), await fmt.first().innerText());

    // 窄版：無下拉的次要鈕整顆折進「更多」，主列只留關鍵動作。
    await page.setViewportSize({ width: 1000, height: 900 });
    await sleep(800);
    check("窄版：格式化鈕已離開主列", (await fmt.count()) === 0);
    // 這三顆永遠不折、也永遠不能被裁掉 —— 正是先前 overflow-hidden 版本會出事的地方。
    check("窄版：收藏星星仍可見可點", await star.first().isVisible());
    check("窄版：執行鈕仍可見", await page.getByRole("button", { name: /執行/ }).first().isVisible());
    check("窄版：新查詢鈕仍可見", await page.locator('button[title*="開新查詢分頁"]').first().isVisible());

    await page.locator('button[title*="更多工具"]').first().click();
    await sleep(300);
    // 工具列的下拉是 absolute z-[90]（錨在按鈕上），不是側欄右鍵那種 fixed z-[90]，
    // 所以不能共用 menuItems()。
    const more = await page.locator('div.absolute.z-\\[90\\] button').allTextContents();
    check("窄版：格式化落到「更多」選單裡", more.some((i) => i.includes("格式化")), more.join(" | "));
    check("窄版：建構器落到「更多」選單裡", more.some((i) => i.includes("建構器")));
    await closeMenu(page);

    // 拉回寬版要還原（遲滯不能把它永久卡在降階狀態）。
    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(900);
    check(
      "拉回寬版：格式化鈕回到主列且帶文字",
      (await page.locator('button[title*="格式化 SQL"]').first().innerText()).includes("格式化"),
    );
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
  const caseFx = { ...fx, ...(CASE_FX[name] ?? {}) };
  await page.addInitScript(installShim, caseFx);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#root");
  await sleep(1200);
  try { await CASES[name](page, caseFx); }
  catch (e) { check(`${name} 執行`, false, String(e).split("\n")[0]); }
  if (pageErrors.length) check(`${name} 無前端例外`, false, pageErrors[0]);
  await ctx.close();
}

await browser.close();
await server.close();
console.log(`\n通過 ${passed}、失敗 ${failures.length}`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); }
process.exit(failures.length ? 1 : 0);
