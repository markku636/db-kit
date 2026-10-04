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
//
// 版面巡檢（跑版：字被擠成直排、按鈕被裁、不該有的橫向捲軸）：npm run verify:layout 在三種尺寸各跑一次，
// 細節見 layout-lint.mjs 與下方 DBKIT_LAYOUT_LINT / DBKIT_VIEWPORT / DBKIT_UI_FONT。
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import * as FX from "./screenshot-fixtures.mjs";
import { installShim } from "./tauri-shim.mjs";
import { collectLayoutIssues, installLayoutLint } from "./layout-lint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// App 畫面的文字：#root 再加上掛在 body 上的對話框（ui/Modal 用 portal 掛到 body，不在 #root 裡），但不含通知 toast。
const appText = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("#root");
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) => !root?.contains(d));
    return [root, ...dialogs].map((el) => el?.innerText ?? "").join("\n");
  });

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
// GitHub 最新 Release（updateCheck 直打 api.github.com；情境沒給就回 404，不打真的 GitHub）。
const FX_RELEASE = {
  tag_name: "v9.9.9",
  html_url: "https://github.com/markku636/db-kit/releases/tag/v9.9.9",
  // 跟 scripts/changelog-section.mjs 組的一樣：該版段落（沒有標題）+「## 下載」安裝指引。
  body: "**更好用了。**\n\n- 新功能 A\n- 修正 B\n\n## 下載\n\n| 平台 | 檔案 |\n|------|------|\n| Windows | `.exe` |",
};
// SSH 終端機情境改用 xterm 的 DOM renderer：無頭 Chrome 的 WebGL 不保證可用，
// 而且只有 DOM 渲染的文字才在 .xterm-rows 讀得到（WebGL 畫在 canvas 上）。
const SSH_STORAGE_SEED = { ...FX.STORAGE_SEED, "dbkit:ssh.prefs": { renderer: "dom" } };
// 側欄多一台 FTP 主機（explicit FTPS）：只有檔案面板的分頁。
const FTP_SESSION = {
  ...FX.SSH_SESSIONS.sessions[1], id: "ftp-files", name: "files", host: "ftp.example.com", port: 21, username: "deploy",
  auth: "password", protocol: "ftp", ftp: { tls: "explicit", active: false },
};
const FTP_SESSIONS = { ...FX.SSH_SESSIONS, sessions: [...FX.SSH_SESSIONS.sessions, FTP_SESSION] };
// 容器與映像情境的 fixtures：在共用那份上加 Docker / Registry / Harbor 三個連線與它們的樹。
// xterm 用 DOM renderer（WebGL 畫布讀不到文字）。
const CONTAINER_FX = {
  STORAGE_SEED: SSH_STORAGE_SEED,
  CONNECTIONS: [...FX.CONNECTIONS, ...FX.CONTAINER_CONNECTIONS],
  DATABASES: {
    ...FX.DATABASES,
    "c-docker": ["containers", "images", "volumes", "networks"],
    "c-registry": FX.REGISTRY_REPOS,
    "c-harbor": FX.HARBOR_PROJECTS,
  },
  TABLES: {
    ...FX.TABLES,
    "c-docker:containers": FX.DOCKER_CONTAINERS.map((c) => ({ name: c.name, kind: `container-${c.state}` })),
    "c-docker:images": FX.DOCKER_IMAGES.map((i) => ({ name: i.reference, kind: i.dangling ? "image-dangling" : "image" })),
    "c-docker:volumes": FX.DOCKER_VOLUMES.map((v) => ({ name: v.name, kind: "volume" })),
    "c-docker:networks": FX.DOCKER_NETWORKS.map((n) => ({ name: n.name, kind: "network" })),
    ...Object.fromEntries(Object.entries(FX.REGISTRY_TAGS).map(([r, tags]) => [`c-registry:${r}`, tags.map((name) => ({ name, kind: "tag" }))])),
    ...Object.fromEntries(Object.entries(FX.HARBOR_REPOS).map(([p, rs]) => [`c-harbor:${p}`, rs.map((r) => ({ name: r.name, kind: "repository" }))])),
  },
};
// Kubernetes 情境：多一個 kubeconfig 型的 Kubernetes 連線（namespace demo 有 Pod / StatefulSet / Service…）。
const K8S_FX = {
  STORAGE_SEED: SSH_STORAGE_SEED,
  CONNECTIONS: [...FX.CONNECTIONS, ...FX.K8S_CONNECTIONS],
  DATABASES: { ...FX.DATABASES, "c-k8s": FX.K8S_NAMESPACES },
  TABLES: { ...FX.TABLES, ...FX.K8S_TREE },
};
// 分組一致性情境：prod-mysql 與 analytics-pg 在同一個沒有 kind 的舊群組裡（升級要拆開），另加一條未分組的 PostgreSQL。
const GROUPING_CONNECTIONS = [
  ...FX.CONNECTIONS.map((c) => (c.id === "c-mysql" || c.id === "c-pg" ? { ...c, group_id: "g-legacy" } : c)),
  { ...FX.CONNECTIONS.find((c) => c.id === "c-pg"), id: "c-pg2", name: "local-pg", host: "127.0.0.1", group_id: null },
];
const GROUPING_GROUPS = [{ id: "g-legacy", name: "正式環境" }];
// 進階匯出情境：PostgreSQL 有一個有成員的群組 + 一個空群組 + 一條未分組；prod-mysql 標成 PROD；
// SSH 主機（PROD 資料夾）與遠端桌面（OFFICE 資料夾）沿用共用 fixtures。
const EXPORT_CONNECTIONS = [
  ...FX.CONNECTIONS.map((c) =>
    c.id === "c-pg" ? { ...c, group_id: "g-pg-new" } : c.id === "c-mysql" ? { ...c, options: { prod: "1" } } : c),
  { ...FX.CONNECTIONS.find((c) => c.id === "c-pg"), id: "c-pg2", name: "local-pg", host: "127.0.0.1", group_id: null },
];
const EXPORT_GROUPS = [
  { id: "g-pg-new", name: "新群組", kind: "postgres" },
  { id: "g-pg-empty", name: "空群組", kind: "postgres" },
];
const CASE_FX = {
  "sidebar-grouping-consistent": { CONNECTIONS: GROUPING_CONNECTIONS, CONN_GROUPS: GROUPING_GROUPS, RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "export-dialog-by-group": { CONNECTIONS: EXPORT_CONNECTIONS, CONN_GROUPS: EXPORT_GROUPS, RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "sidebar-scroll-reaches-last": { CONNECTIONS: MANY_CONNECTIONS, CONN_GROUPS: MANY_GROUPS },
  "ssh-terminal": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-ai-suggest": { STORAGE_SEED: SSH_STORAGE_SEED },
  "sftp-edit-and-chmod": { STORAGE_SEED: SSH_STORAGE_SEED },
  "sftp-multi-select": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-key-manager": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-host-import": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-disconnect-overlay": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-jump-host": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-terminal-theme": { STORAGE_SEED: SSH_STORAGE_SEED },
  // 一台 SSH 主機都沒有：側欄區塊與分頁列按鈕都不該出現，從「新增連線」加第一台。
  "ssh-from-conn-string": { STORAGE_SEED: SSH_STORAGE_SEED, SSH_SESSIONS: { version: 1, folders: [], sessions: [] } },
  "ssh-host-paste": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-host-quick-actions": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-host-menu-sftp-window": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ssh-host-dialog-fits": { STORAGE_SEED: SSH_STORAGE_SEED },
  "tab-menu-close-others": { STORAGE_SEED: SSH_STORAGE_SEED },
  // 助手面板開到最窄（300px）：選項列要往下一行掉，不能把標籤擠成一字一行。
  "assistant-ssh-mode": { STORAGE_SEED: { ...SSH_STORAGE_SEED, "db-kit:assistantWidth": 300 } },
  "ssh-status-and-log": { STORAGE_SEED: SSH_STORAGE_SEED },
  "info-panel-ssh-details": { STORAGE_SEED: SSH_STORAGE_SEED },
  "sftp-window-host": { STORAGE_SEED: SSH_STORAGE_SEED },
  "sftp-window-view": { STORAGE_SEED: SSH_STORAGE_SEED },
  "ftp-host": { STORAGE_SEED: SSH_STORAGE_SEED, SSH_SESSIONS: FTP_SESSIONS },
  // 同一個情境換成預設的渲染器（WebGL，開不起來才退回 DOM）：issue #7 的使用者用的就是預設值。
  "ssh-disconnect-overlay-webgl": {},
  // 容器與映像：連線 / 樹資料另外合併（文件截圖用的 CONNECTIONS 不含這三個）。
  "docker-tree-menu": CONTAINER_FX,
  "docker-container-tab": CONTAINER_FX,
  "docker-create-db-conn": CONTAINER_FX,
  "docker-readonly-hides-writes": CONTAINER_FX,
  "docker-conn-dialog-tls": CONTAINER_FX,
  "docker-overview": CONTAINER_FX,
  "registry-tag-view": CONTAINER_FX,
  "harbor-artifacts": CONTAINER_FX,
  "k8s-tree-menu": K8S_FX,
  "k8s-pod-tab": K8S_FX,
  "k8s-create-db-conn": K8S_FX,
  "k8s-readonly-hides-writes": K8S_FX,
  "k8s-conn-dialog": K8S_FX,
  "k8s-overview-apply": K8S_FX,
  // 遠端桌面：有一台 RDP、一台 VNC（Mac）主機（rd-from-conn-string 用預設的「一台都沒有」）。
  "rd-rdp-session": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-vnc-session": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-vnc-toolbar": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-vnc-encryption": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-vnc-keyboard": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-cert-prompt": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rdp-file-import": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-session": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-2fa": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-2fa-trust": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-wait-accept": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-monitors": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-toolbar": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-keyboard": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-files": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "rd-rustdesk-display": { RD_SESSIONS: FX.RD_SESSIONS_DEMO },
  "update-dialog-install": { GITHUB_RELEASE: FX_RELEASE },
  "update-dialog-manual": { GITHUB_RELEASE: FX_RELEASE },
  "update-dialog-error": { GITHUB_RELEASE: FX_RELEASE },
  "update-auto-popup": { GITHUB_RELEASE: FX_RELEASE },
};

// ui/Field 的 <label> 沒有 htmlFor（沒和 input 綁定），getByLabel 找不到：改以「標籤文字所在的欄位」取第一個輸入框。
const fieldInput = (page, label) =>
  page.locator("label").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*?$`) })
    .first().locator("xpath=..").locator("input, textarea").first();
// xterm 目前畫面（DOM renderer）的純文字。
const termText = (page) => page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? "");
async function openSshWeb01(page) {
  const tree = page.locator("[data-ssh-host-tree]");
  await tree.getByText("web-01", { exact: true }).first().dblclick();
  await page.waitForFunction(
    () => (document.querySelector(".xterm-rows")?.innerText ?? "").includes("deploy@web-01"), null, { timeout: 10000 },
  ).catch(() => {});
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
// 連上 dev-cluster、展開 namespace demo 與指定的種類資料夾。
async function openK8sFolder(page, folder) {
  await page.getByText("dev-cluster", { exact: true }).first().dblclick();
  await sleep(900);
  await page.getByText("demo", { exact: true }).first().click();
  await page.getByText(folder, { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.getByText(folder, { exact: true }).first().click();
  await sleep(300);
}

const CASES = {
  // ---- 進階匯出連線：照側欄分段 / 群組列出，含 SSH 主機與遠端桌面 ----
  async "export-dialog-by-group"(page) {
    // 用按鈕名稱找：視窗窄時工具列收成純圖示，標籤只剩 title。
    await page.getByRole("button", { name: "匯出連線", exact: true }).first().click();
    const dlg = page.locator('[role="dialog"]').filter({ hasText: "進階匯出連線" });
    await dlg.waitFor({ timeout: 4000 });
    const blocks = await dlg.locator("[data-export-block]").evaluateAll((els) => els.map((e) => e.getAttribute("data-export-block")));
    check("匯出清單照側欄分段：資料庫各種類在前，接著 SSH 主機、遠端桌面",
      blocks[0] === "db:mysql" && blocks.includes("db:postgres") && blocks.at(-2) === "ssh" && blocks.at(-1) === "rd", blocks.join(" | "));
    const pgBlock = dlg.locator('[data-export-block="db:postgres"]');
    const pgGroup = pgBlock.locator('[data-export-group="新群組"]');
    check("PostgreSQL 段裡有「新群組」，成員在群組底下", (await pgGroup.innerText()).includes("analytics-pg"));
    check("空群組不列出", (await dlg.locator('[data-export-group="空群組"]').count()) === 0);
    check("SSH 主機照資料夾分組", (await dlg.locator('[data-export-block="ssh"] [data-export-group="PROD"]').innerText()).includes("web-01"));
    check("遠端桌面照資料夾分組", (await dlg.locator('[data-export-block="rd"] [data-export-group="OFFICE"]').innerText()).includes("win-srv01"));
    const footer = async () => (await dlg.innerText()).match(/將匯出 (\d+) \/ (\d+) 個連線/)?.slice(1).map(Number) ?? [];
    const total = EXPORT_CONNECTIONS.length + FX.SSH_SESSIONS.sessions.length + FX.RD_SESSIONS_DEMO.sessions.length;
    check("預設全選（資料庫 + SSH + 遠端桌面）", String(await footer()) === `${total},${total}`, String(await footer()));

    // 取消整個群組 → 該段變半勾；取消整段 SSH → 兩台都不選。
    await pgGroup.locator("label input").first().click();
    const pgHead = pgBlock.locator("label input").first();
    check("取消群組：PostgreSQL 段變半勾", await pgHead.evaluate((el) => el.indeterminate && !el.checked));
    await dlg.locator('[data-export-block="ssh"] label input').first().click();
    check("取消群組 + 整段 SSH 後的計數", (await footer())[0] === total - 1 - FX.SSH_SESSIONS.sessions.length, String(await footer()));
    await pgHead.click(); // 半勾 → 整段勾回來
    check("半勾的段再按一下 = 整段全選", await pgHead.evaluate((el) => el.checked && !el.indeterminate));

    // 篩選群組名：只留那一組。
    await dlg.getByPlaceholder("以名稱 / 主機 / 類型篩選").fill("office");
    const shown = await dlg.locator("[data-export-block]").evaluateAll((els) => els.map((e) => e.getAttribute("data-export-block")));
    check("篩選「office」：只留遠端桌面段（OFFICE 資料夾 + office-pc）",
      shown.join() === "rd" && (await dlg.locator('[data-export-group="OFFICE"]').innerText()).includes("win-srv01"), shown.join());
    await dlg.getByPlaceholder("以名稱 / 主機 / 類型篩選").fill("");

    // 只勾 SSH 主機匯出：資料庫連線送空陣列（不是「全部」）。
    await dlg.getByRole("button", { name: "全不選" }).click();
    await dlg.locator('[data-export-block="ssh"] label input').first().click();
    const pw = dlg.locator('input[type="password"]');
    await pw.nth(0).fill("passphrase-1");
    await pw.nth(1).fill("passphrase-1");
    await dlg.getByRole("button", { name: "選擇位置並匯出" }).click();
    await sleep(500);
    const sent = await page.evaluate(() => window.__DBKIT_CONN_EXPORT__?.scope ?? null);
    check("只勾 SSH 主機：ids / rd_ids 送空陣列、ssh_ids 送兩台",
      !!sent && sent.ids.length === 0 && sent.rd_ids.length === 0 && sent.ssh_ids.length === FX.SSH_SESSIONS.sessions.length && sent.include_rd === true,
      JSON.stringify(sent));
    check("匯出完關閉對話框", (await page.locator('[role="dialog"]').filter({ hasText: "進階匯出連線" }).count()) === 0);
  },

  // ---- Kubernetes ----
  async "k8s-tree-menu"(page) {
    await openK8sFolder(page, "Pods");
    check("k8s 樹：namespace 下有種類資料夾", (await page.getByText("StatefulSets", { exact: true }).count()) > 0 && (await page.getByText("Services", { exact: true }).count()) > 0);
    const pod = page.locator('[data-tree-table="pods/pg-0"]').first();
    await pod.waitFor({ timeout: 6000 }).catch(() => {});
    check("Pod 節點只顯示名稱（不帶 pods/ 前綴）", (await pod.innerText().catch(() => "")).trim() === "pg-0");
    await pod.click({ button: "right" });
    await sleep(300);
    let items = await menuItems(page);
    const has = (x) => items.some((i) => i === x || i.includes(x));
    check("Pod 右鍵：Log / Shell / YAML / 轉發埠 / 建立資料庫連線 / 刪除", has("Log…") && has("Shell…") && has("YAML…") && has("轉發埠…") && has("建立資料庫連線…") && has("刪除 Pod"), items.join(" | "));
    await closeMenu(page);
    await page.getByText("dev-cluster", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    items = await menuItems(page);
    check("k8s 連線右鍵：叢集總覽 / 套用 YAML，沒有 SQL 搜尋", has("叢集總覽…") && has("套用 YAML…") && !items.some((i) => i.includes("SQL Search") || i.includes("新增查詢")), items.join(" | "));
    await closeMenu(page);
  },

  async "k8s-pod-tab"(page) {
    await openK8sFolder(page, "Pods");
    await page.locator('[data-tree-table="pods/redis-7c9d8-abcde"]').first().click();
    await page.getByText("redis:7-alpine", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    const info = await appText(page);
    check("Pod 概要：容器映像與節點", info.includes("redis:7-alpine") && info.includes("node-1"), info.slice(0, 300));
    const allTerm = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows")].map((e) => e.innerText).join("\n"));
    await page.getByRole("radio", { name: "Log" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows")].some((e) => e.innerText.includes("Ready to accept")), null, { timeout: 6000 }).catch(() => {});
    check("Log 子頁串流出 log", (await allTerm()).includes("Ready to accept connections"));
    await page.getByRole("radio", { name: "Shell" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows")].some((e) => e.innerText.includes("/ #")), null, { timeout: 6000 }).catch(() => {});
    await page.locator(".xterm-helper-textarea").last().focus();
    await page.keyboard.type("hostname");
    await page.keyboard.press("Enter");
    await sleep(400);
    check("Shell 輸入送到 Pod 並回顯", /hostname[\s\S]*redis-7c9d8-abcde/.test(await allTerm()), (await allTerm()).slice(-200));
    await page.getByRole("radio", { name: "YAML" }).click();
    await page.getByText("kind: Pod").first().waitFor({ timeout: 6000 }).catch(() => {});
    check("YAML 子頁顯示物件", (await page.locator('[data-testid="k8s-yaml"]').innerText().catch(() => "")).includes("kind: Pod"));
    await page.getByRole("radio", { name: "資源" }).click();
    await page.getByText("3m", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    check("資源子頁顯示 CPU 用量", (await page.getByText("3m", { exact: true }).count()) > 0);
  },

  async "k8s-create-db-conn"(page) {
    await openK8sFolder(page, "StatefulSets");
    await page.locator('[data-tree-table="statefulsets/pg"]').first().click({ button: "right" });
    await sleep(300);
    await page.getByText("建立資料庫連線…", { exact: true }).click();
    await page.getByText("經由 Kubernetes port-forward 連線", { exact: true }).waitFor({ timeout: 6000 }).catch(() => {});
    const vals = {
      user: await fieldInput(page, "使用者").inputValue().catch(() => null),
      target: await fieldInput(page, "目標").inputValue().catch(() => null),
      port: await fieldInput(page, "遠端埠").inputValue().catch(() => null),
      ns: await fieldInput(page, "Namespace").inputValue().catch(() => null),
      ssh: await page.getByText("透過 SSH Tunnel 連線", { exact: true }).count(),
    };
    check("從 StatefulSet 預填：app / sts/pg / 5432 / demo，SSH 區塊收起", vals.user === "app" && vals.target === "sts/pg" && vals.port === "5432" && vals.ns === "demo" && vals.ssh === 0, JSON.stringify(vals));
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await sleep(400);
    const saved = (await page.evaluate(() => window.__DBKIT_CONN_SAVES__ ?? [])).at(-1);
    const o = saved?.options ?? {};
    check("存成經由 port-forward 的 PostgreSQL（密碼取自 Secret）",
      saved?.kind === "postgres" && saved?.password === "secret" && o.k8s_conn === "c-k8s" && o.k8s_target === "sts/pg" && o.k8s_port === "5432" && o.k8s_ns === "demo" && !saved?.ssh_enabled,
      JSON.stringify(saved));
  },

  async "k8s-readonly-hides-writes"(page) {
    await page.getByText("dev-cluster", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("dev-cluster", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    await page.getByText("設為唯讀模式（擋寫入 / DDL）", { exact: true }).click();
    await sleep(400);
    await page.getByText("demo", { exact: true }).first().click();
    await page.getByText("Deployments", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await page.getByText("Deployments", { exact: true }).first().click();
    await page.locator('[data-tree-table="deployments/redis"]').first().click({ button: "right" });
    await sleep(300);
    const items = await menuItems(page);
    check("唯讀：Deployment 右鍵沒有調整副本 / 重新啟動 / 刪除", !items.some((i) => i.includes("調整副本數") || i === "重新啟動" || i.startsWith("刪除")), items.join(" | "));
    check("唯讀：仍可看 YAML / 事件", items.includes("YAML…") && items.includes("事件…"));
    await closeMenu(page);
    await page.locator('[data-tree-table="deployments/redis"]').first().click();
    await page.getByText("RollingUpdate").first().waitFor({ timeout: 6000 }).catch(() => {});
    check("唯讀：分頁沒有調整副本 / 刪除按鈕",
      (await page.getByRole("button", { name: "調整副本數", exact: true }).count()) === 0 && (await page.getByRole("button", { name: "刪除", exact: true }).count()) === 0);
  },

  async "k8s-conn-dialog"(page) {
    await page.getByRole("button", { name: "連線", exact: true }).first().click();
    await page.getByRole("radiogroup", { name: "連線類型" }).waitFor({ timeout: 5000 }).catch(() => {});
    await page.getByRole("radio", { name: "Kubernetes" }).click();
    await page.getByText("Context", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    await sleep(400);
    const opts = await page.locator("select").evaluateAll((els) => els.flatMap((e) => [...e.options].map((o) => o.textContent)));
    check("kubeconfig 模式：列出 context（current 標★）", opts.includes("dev ★") && opts.includes("prod-eks"), opts.join(" | "));
    check("kubeconfig 模式：沒有使用者 / 密碼欄", (await fieldInput(page, "使用者").count()) === 0 && (await fieldInput(page, "密碼").count()) === 0);
    await page.locator("select").filter({ hasText: "prod-eks" }).selectOption("prod-eks");
    await sleep(200);
    check("選 exec plugin 的 context 顯示說明", (await appText(page)).includes("exec plugin（aws）"));
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await sleep(400);
    const saved = (await page.evaluate(() => window.__DBKIT_CONN_SAVES__ ?? [])).at(-1);
    check("存下 context（host 為 server、不存帳密）",
      saved?.kind === "kubernetes" && saved?.options?.k8s_context === "prod-eks" && (saved?.host ?? "").includes("eks.amazonaws.com") && saved?.password === "" && saved?.port === 0,
      JSON.stringify(saved));
  },

  async "k8s-overview-apply"(page) {
    await page.getByText("dev-cluster", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("dev-cluster", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    await page.getByText("叢集總覽…", { exact: true }).click();
    await page.getByText("v1.33.4+k3s1").first().waitFor({ timeout: 6000 }).catch(() => {});
    const text = await appText(page);
    check("總覽：版本 / 節點 / 警告事件", text.includes("v1.33.4+k3s1") && text.includes("node-1") && text.includes("BackOff"), text.slice(0, 300));
    await page.getByRole("button", { name: "套用 YAML…", exact: true }).click();
    await page.locator('[data-testid="k8s-apply-editor"]').waitFor({ timeout: 5000 }).catch(() => {});
    await page.getByRole("button", { name: "試套用", exact: true }).click();
    await page.getByText("可套用（created）").first().waitFor({ timeout: 5000 }).catch(() => {});
    const acts = await page.evaluate(() => window.__DBKIT_K8S_ACTIONS__);
    check("套用 YAML：試套用送出 dryRun 並顯示結果", acts.includes("dry-apply") && (await page.getByText("可套用（created）").count()) > 0, JSON.stringify(acts));
  },

  // ---- 容器與映像（Docker / Registry / Harbor）----
  async "docker-tree-menu"(page) {
    await page.getByText("local-docker", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("容器", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="shop-db"]', { timeout: 8000 });
    check("Docker 樹：四個分類", (await page.getByText("映像", { exact: true }).count()) > 0 && (await page.getByText("網路", { exact: true }).count()) > 0);
    await page.locator('[data-tree-table="shop-db"]').first().click({ button: "right" });
    await sleep(300);
    let items = await menuItems(page);
    const has = (s) => items.some((i) => i === s || i.includes(s));
    check("執行中容器右鍵：Log / Shell / 停止 / 重新啟動", has("Log…") && has("Shell…") && has("停止") && has("重新啟動"), items.join(" | "));
    check("執行中容器右鍵：建立資料庫連線 / 刪除", has("建立資料庫連線…") && has("刪除…"));
    check("執行中容器右鍵沒有「啟動」", !items.includes("啟動"));
    await closeMenu(page);
    await page.locator('[data-tree-table="shop-api"]').first().click({ button: "right" });
    await sleep(300);
    items = await menuItems(page);
    check("已停止容器右鍵：有啟動、沒有 Shell", items.includes("啟動") && !items.some((i) => i.includes("Shell")), items.join(" | "));
    await closeMenu(page);
    await page.getByText("local-docker", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    items = await menuItems(page);
    check("Docker 連線右鍵：總覽 / 拉取映像", items.some((i) => i.includes("總覽")) && items.some((i) => i.includes("拉取映像")), items.join(" | "));
    check("Docker 連線右鍵：沒有 SQL 搜尋 / 新增查詢", !items.some((i) => i.includes("SQL Search") || i.includes("新增查詢") || i.includes("進階搜尋")));
    await closeMenu(page);
  },

  async "docker-container-tab"(page) {
    await page.getByText("local-docker", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("容器", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="shop-db"]', { timeout: 8000 });
    await page.locator('[data-tree-table="shop-db"]').first().click();
    await page.getByText("POSTGRES_PASSWORD", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    const text = await appText(page);
    check("容器資訊：埠映射 15432", text.includes("15432"), text.slice(0, 300));
    check("容器資訊：機密環境變數預設遮罩", text.includes("POSTGRES_PASSWORD") && !text.includes("s3cret-demo"));
    check("容器資訊：一般環境變數照常顯示", text.includes("/var/lib/postgresql/data"));
    const allTerm = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows")].map((e) => e.innerText).join("\n"));
    await page.getByRole("radio", { name: "Log" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows")].some((e) => e.innerText.includes("starting PostgreSQL")), null, { timeout: 6000 }).catch(() => {});
    check("Log 子頁串流出 log", (await allTerm()).includes("starting PostgreSQL"), (await allTerm()).slice(0, 200));
    await page.getByRole("radio", { name: "Shell" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows")].some((e) => e.innerText.includes("/ #")), null, { timeout: 6000 }).catch(() => {});
    check("Shell 子頁連上並出現提示符", (await allTerm()).includes("/ #"));
    await page.locator(".xterm-helper-textarea").last().focus();
    await page.keyboard.type("hostname");
    await page.keyboard.press("Enter");
    await sleep(400);
    check("Shell 輸入送到容器並回顯輸出", /hostname[\s\S]*shop-db/.test(await allTerm()), (await allTerm()).slice(-200));
    await page.getByRole("radio", { name: "Log" }).click();
    await sleep(200);
    check("切回 Log 時 log 還在（子頁不卸載）", (await allTerm()).includes("starting PostgreSQL"));
    await page.getByRole("radio", { name: "資源" }).click();
    await page.getByText("3.2%", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    check("資源子頁顯示 CPU", (await page.getByText("3.2%", { exact: true }).count()) > 0);
    await page.getByRole("radio", { name: "資訊" }).click();
    await page.getByRole("button", { name: "停止", exact: true }).first().click();
    await page.getByRole("button", { name: "停止", exact: true }).last().click(); // 確認對話框
    await sleep(400);
    const acts = await page.evaluate(() => window.__DBKIT_DOCKER_ACTIONS__);
    check("動作列「停止」確認後送出", acts.includes("stop:shop-db"), JSON.stringify(acts));
  },

  async "docker-create-db-conn"(page) {
    await page.getByText("local-docker", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("容器", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="shop-db"]', { timeout: 8000 });
    await page.locator('[data-tree-table="shop-db"]').first().click({ button: "right" });
    await sleep(300);
    await page.getByText("建立資料庫連線…", { exact: true }).click();
    await fieldInput(page, "主機").waitFor({ timeout: 6000 }).catch(() => {});
    const vals = {
      title: await page.getByText("新增連線", { exact: true }).count(),
      host: await fieldInput(page, "主機").inputValue().catch(() => null),
      port: await fieldInput(page, "埠").inputValue().catch(() => null),
      user: await fieldInput(page, "使用者").inputValue().catch(() => null),
      db: await fieldInput(page, "資料庫（選填）").inputValue().catch(() => null),
      name: await fieldInput(page, "名稱").inputValue().catch(() => null),
    };
    check("從 postgres 容器預填新增連線：127.0.0.1:15432 / shop / shop",
      vals.title > 0 && vals.host === "127.0.0.1" && vals.port === "15432" && vals.user === "shop" && vals.db === "shop" && vals.name === "shop-db",
      JSON.stringify(vals));
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await sleep(400);
    const saved = (await page.evaluate(() => window.__DBKIT_CONN_SAVES__ ?? [])).at(-1);
    check("存成 PostgreSQL 連線（新 id、帶容器 env 的密碼）", saved?.kind === "postgres" && saved?.password === "s3cret-demo" && saved?.id !== "c-docker", JSON.stringify(saved));
  },

  async "docker-readonly-hides-writes"(page) {
    await page.getByText("local-docker", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("local-docker", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    await page.getByText("設為唯讀模式（擋寫入 / DDL）", { exact: true }).click();
    await sleep(400);
    await page.getByText("容器", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="shop-db"]', { timeout: 8000 });
    await page.locator('[data-tree-table="shop-db"]').first().click({ button: "right" });
    await sleep(300);
    const items = await menuItems(page);
    check("唯讀：容器右鍵沒有啟停 / 刪除 / Shell", !items.some((i) => ["停止", "重新啟動", "刪除…", "Shell…", "重新命名…"].includes(i)), items.join(" | "));
    check("唯讀：仍可看 Log", items.includes("Log…"));
    await closeMenu(page);
    await page.locator('[data-tree-table="shop-db"]').first().click();
    await page.getByText("POSTGRES_PASSWORD", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    check("唯讀：容器分頁沒有停止 / 刪除按鈕",
      (await page.getByRole("button", { name: "停止", exact: true }).count()) === 0 && (await page.getByRole("button", { name: "刪除", exact: true }).count()) === 0);
  },

  async "docker-conn-dialog-tls"(page) {
    await page.getByRole("button", { name: "連線", exact: true }).first().click();
    await page.getByRole("radiogroup", { name: "連線類型" }).waitFor({ timeout: 5000 }).catch(() => {});
    check("類型選擇器有「容器與映像」三種", (await page.getByRole("radio", { name: "Docker" }).count()) === 1
      && (await page.getByRole("radio", { name: "Registry" }).count()) === 1 && (await page.getByRole("radio", { name: "Harbor" }).count()) === 1);
    await page.getByRole("radio", { name: "Docker" }).click();
    await fieldInput(page, "Socket / Pipe 路徑（選填）").waitFor({ timeout: 5000 }).catch(() => {});
    check("Docker 預設本機：socket 路徑欄、沒有埠 / 帳密 / SSH",
      (await fieldInput(page, "Socket / Pipe 路徑（選填）").count()) === 1
      && (await fieldInput(page, "埠").count()) === 0
      && (await fieldInput(page, "使用者").count()) === 0
      && (await page.getByText("透過 SSH Tunnel 連線", { exact: true }).count()) === 0);
    await page.getByRole("radio", { name: "TLS" }).click();
    await sleep(200);
    check("切到 TLS：埠 2376、CA / 用戶端憑證 / 私鑰欄出現",
      (await fieldInput(page, "埠").inputValue().catch(() => "")) === "2376"
      && (await fieldInput(page, "CA 憑證路徑（選填）").count()) === 1
      && (await fieldInput(page, "用戶端憑證（cert.pem，選填）").count()) === 1
      && (await fieldInput(page, "用戶端私鑰（key.pem，選填）").count()) === 1);
    await fieldInput(page, "主機").fill("docker.lan");
    await fieldInput(page, "CA 憑證路徑（選填）").fill("C:/certs/ca.pem");
    await fieldInput(page, "用戶端憑證（cert.pem，選填）").fill("C:/certs/cert.pem");
    await fieldInput(page, "用戶端私鑰（key.pem，選填）").fill("C:/certs/key.pem");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await sleep(400);
    const saved = (await page.evaluate(() => window.__DBKIT_CONN_SAVES__ ?? [])).at(-1);
    const o = saved?.options ?? {};
    check("存下 TLS 設定（docker_tls / ca / cert / key，不存帳密）",
      saved?.kind === "docker" && saved?.host === "docker.lan" && saved?.port === 2376 && o.docker_tls === "1"
      && o.docker_tls_ca === "C:/certs/ca.pem" && o.docker_tls_cert === "C:/certs/cert.pem" && o.docker_tls_key === "C:/certs/key.pem"
      && saved?.username === "" && saved?.password === "", JSON.stringify(saved));
  },

  async "docker-overview"(page) {
    await page.getByText("local-docker", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("local-docker", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    await page.getByText("總覽…", { exact: true }).click();
    await page.getByText("Docker 27.3.1 · API 1.47", { exact: true }).waitFor({ timeout: 6000 }).catch(() => {});
    const text = await appText(page);
    check("總覽：引擎版本與容器分組", text.includes("Docker 27.3.1") && text.includes("shop") && text.includes("edge-nginx"), text.slice(0, 300));
    check("總覽：磁碟用量與清理", text.includes("建置快取") && text.includes("刪除所有已停止的容器"));
  },

  async "registry-tag-view"(page) {
    await page.getByText("team-registry", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("acme/shop-api", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="1.4.2"]', { timeout: 8000 });
    await page.locator('[data-tree-table="1.4.2"]').first().click();
    await page.getByText("Layers（2）", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    const text = await appText(page);
    check("tag 分頁：digest / layers / 映像設定", text.includes("sha256:9f8e7d6c") && /layers（2）/i.test(text) && text.includes("8080/tcp"), text.slice(0, 300));
    check("tag 分頁：pull 參照去掉預設埠", text.includes("registry.example.test/acme/shop-api:1.4.2"));
    await page.getByRole("button", { name: "拉到 Docker…", exact: true }).click();
    await sleep(400);
    check("沒連 Docker 時提示先連線", (await page.getByText("請先連線到一個 Docker 連線，才能把映像拉下來", { exact: true }).count()) > 0);
    await page.getByText("local-docker", { exact: true }).first().dblclick();
    await sleep(900);
    await page.locator('[data-tree-table="1.4.2"]').first().click();
    await page.getByRole("button", { name: "拉到 Docker…", exact: true }).click();
    await page.getByRole("button", { name: "拉取", exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    const img = await fieldInput(page, "映像").inputValue().catch(() => null);
    check("拉取對話框預填映像與 registry 帳號", img === "registry.example.test/acme/shop-api:1.4.2"
      && (await fieldInput(page, "Registry 使用者（選填）").inputValue().catch(() => null)) === "ci", String(img));
    await page.getByRole("button", { name: "拉取", exact: true }).click();
    await sleep(400);
    const pulls = await page.evaluate(() => window.__DBKIT_DOCKER_PULLS__);
    check("拉取用 registry 連線的已存密碼（credConn）", pulls.at(-1)?.credConn === "c-registry" && pulls.at(-1)?.id === "c-docker", JSON.stringify(pulls));
  },

  async "harbor-artifacts"(page) {
    await page.getByText("corp-harbor", { exact: true }).first().dblclick();
    await sleep(900);
    await page.getByText("acme", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="team/worker"]', { timeout: 8000 });
    await page.locator('[data-tree-table="shop-api"]').first().click();
    await page.getByText("H2 M3 L2", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    const text = await appText(page);
    check("artifact 表：tag / 平台 / 掃描摘要", text.includes("1.4.2") && text.includes("latest") && text.includes("linux/amd64") && text.includes("H2 M3 L2"), text.slice(0, 300));
    check("未掃描的 artifact 標示「未掃描」", text.includes("未掃描"));
    await page.getByText("H2 M3 L2", { exact: true }).first().click();
    await page.getByText("CVE-2026-1111", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    check("點掃描摘要看弱點明細", (await page.getByText("CVE-2026-1111", { exact: true }).count()) > 0 && (await page.getByText("3.0.14", { exact: true }).count()) > 0);
    await page.getByRole("button", { name: "掃描弱點" }).first().click();
    await sleep(300);
    const acts = await page.evaluate(() => window.__DBKIT_DOCKER_ACTIONS__);
    check("「掃描弱點」送出掃描", acts.some((a) => a.startsWith("harbor-scan:sha256:1234")), JSON.stringify(acts));
    await page.getByText("acme", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    await page.getByText("專案資訊…", { exact: true }).click();
    await page.getByText("推送時自動掃描", { exact: true }).first().waitFor({ timeout: 6000 }).catch(() => {});
    check("專案資訊面板", (await page.getByText("推送時自動掃描", { exact: true }).count()) > 0 && (await appText(page)).includes("10.0 GB"));
  },
  // SSH 終端機：側欄「SSH 主機」雙擊開分頁 → xterm 印 banner → 鍵入有回聲 → 指令列送 ls → SFTP 列出檔案 → 分頁右鍵。
  async "ssh-terminal"(page) {
    check("側欄有「SSH 主機」區塊", (await page.locator("[data-ssh-host-tree]").count()) > 0);
    await openSshWeb01(page);
    check("終端機分頁開啟並印出提示符", (await termText(page)).includes("deploy@web-01"), (await termText(page)).slice(0, 200));

    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("echo hi");
    await sleep(300);
    check("鍵入的字元有回聲", (await termText(page)).includes("echo hi"));
    await page.keyboard.press("Enter");
    await sleep(400);
    check("Enter 後回到新的提示符", ((await termText(page)).match(/deploy@web-01/g) ?? []).length >= 2);

    const compose = page.getByTestId("ssh-compose");
    check("有命令列輸入條", (await compose.count()) > 0);
    await compose.fill("ls");
    await compose.press("Enter");
    await sleep(500);
    check("指令列送出的 ls 有輸出", (await termText(page)).includes("backup.tar.gz"), (await termText(page)).slice(-300));

    // Ctrl+V 走原生 paste 事件、由 xterm 自己接——多行內容不先確認的話，每一行都會被當成 Enter 執行。
    const pasteInto = (text) => page.evaluate((s) => {
      const ta = document.querySelector(".xterm-helper-textarea");
      const dt = new DataTransfer();
      dt.setData("text/plain", s);
      ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
    await page.locator(".xterm-helper-textarea").first().focus();
    await pasteInto("pwd\nls");
    await sleep(300);
    check("Ctrl+V 多行貼上先跳確認框", (await page.getByText(/貼上內容含 2 行/).count()) > 0);
    await page.getByRole("button", { name: "取消", exact: true }).last().click();
    await sleep(300);
    check("取消多行貼上後什麼都沒送出", !(await termText(page)).includes("/home/deploy"));
    await pasteInto("pwd\nls");
    await sleep(300);
    await page.getByRole("button", { name: "貼上", exact: true }).last().click();
    await sleep(500);
    check("確認後多行貼上逐行執行", (await termText(page)).includes("/home/deploy"), (await termText(page)).slice(-300));
    // 單行但結尾帶換行（網頁三連擊選取常這樣）貼上後也會立刻執行，一樣要先問。
    await pasteInto("whoami\n");
    await sleep(300);
    check("單行但結尾有換行的貼上也先確認", (await page.getByText(/結尾有換行/).count()) > 0);
    await page.getByRole("button", { name: "取消", exact: true }).last().click();
    await sleep(200);

    await page.getByTestId("ssh-sftp-toggle").click();
    const sftp = page.getByTestId("sftp-panel");
    await sftp.getByText("backup.tar.gz", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    // 開在家目錄而不是根目錄：開啟後更新 sftpId 會觸發重列，曾經拿舊的 "/" 蓋掉家目錄。
    check("SFTP 面板開在家目錄並列出檔案",
      (await sftp.getByText("logs", { exact: true }).count()) > 0 && (await sftp.getByText("backup.tar.gz", { exact: true }).count()) > 0,
      (await sftp.innerText().catch(() => "(no sftp panel)")).slice(0, 300));
    check("麵包屑停在 /home/deploy", (await sftp.getByRole("button", { name: "deploy", exact: true }).count()) > 0);
    if ((await sftp.getByText("logs", { exact: true }).count()) > 0) {
      await sftp.getByText("logs", { exact: true }).first().dblclick();
      await sftp.getByText("app.log", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
      check("雙擊資料夾進入 logs", (await sftp.getByText("app.log", { exact: true }).count()) > 0);
    }
    // 關掉再打開：回到剛才的資料夾，不是重新從家目錄開始。
    await page.getByRole("button", { name: "關閉 SFTP" }).first().click();
    await sleep(300);
    await page.getByTestId("ssh-sftp-toggle").click();
    await sftp.getByText("app.log", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("SFTP 面板重開後回到上次的資料夾", (await sftp.getByText("app.log", { exact: true }).count()) > 0);

    await page.locator("span.mono", { hasText: "web-01" }).first().click({ button: "right" });
    await sleep(300);
    const items = await menuItems(page);
    const has = (s) => items.some((i) => i.includes(s));
    check("終端機分頁右鍵：複製分頁", has("複製分頁"), items.join(" | "));
    check("終端機分頁右鍵：開啟 SFTP", has("開啟 SFTP"));
    check("終端機分頁右鍵：關閉", has("關閉"));
    await closeMenu(page);
    check("沒有未實作的 SSH command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // SFTP 的 Xftp 式操作：雙擊文字檔在 App 內開編輯器 → 改內容 → Ctrl+S 存回遠端；右鍵「權限…」改成 755。
  // 另外釘住一個審閱時發現的坑：對話框沒有走 portal，編輯器裡的 Backspace 會冒泡到檔案清單，
  // 不擋的話就是「刪一個字，面板跳回上一層」。
  async "sftp-edit-and-chmod"(page) {
    await openSshWeb01(page);
    await page.getByTestId("ssh-sftp-toggle").click();
    const sftp = page.getByTestId("sftp-panel");
    await sftp.getByText("app", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await sftp.getByText("app", { exact: true }).first().dblclick();
    await sftp.getByText("package.json", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    await sftp.getByText("package.json", { exact: true }).first().dblclick();
    const editor = page.getByTestId("sftp-editor");
    await editor.locator(".cm-content").first().waitFor({ timeout: 8000 }).catch(() => {});
    check("雙擊 1 MiB 以內的檔案在 App 內開編輯器", (await editor.locator(".cm-content").count()) > 0);
    check("編輯器載入遠端內容", /web-01-app/.test(await editor.innerText().catch(() => "")));

    await editor.locator(".cm-content").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("// edited");
    await page.keyboard.press("Backspace");
    await sleep(200);
    check("編輯器裡按 Backspace 不會讓 SFTP 跳回上一層", (await sftp.getByText("server.js", { exact: true }).count()) > 0);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__DBKIT_SFTP_WRITES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const writes = await page.evaluate(() => window.__DBKIT_SFTP_WRITES__);
    check("Ctrl+S 存回遠端（覆寫原檔，不是新增）",
      writes.length === 1 && writes[0].path === "/home/deploy/app/package.json" && writes[0].createNew === false,
      JSON.stringify(writes).slice(0, 200));
    check("存回去的是改過的內容", writes.length === 1 && writes[0].content.includes("// edite") && writes[0].content.includes("web-01-app"));
    await page.getByRole("button", { name: "關閉", exact: true }).last().click();
    await sleep(300);
    check("存檔後關閉不再問未儲存", (await editor.count()) === 0);

    await sftp.getByText("server.js", { exact: true }).first().click({ button: "right" });
    await sleep(200);
    await page.locator('div.fixed.z-\\[90\\] button', { hasText: "權限…" }).first().click();
    const perms = page.getByTestId("sftp-perms");
    await perms.waitFor({ timeout: 5000 }).catch(() => {});
    check("右鍵「權限…」開啟權限對話框", (await perms.count()) > 0);
    await page.getByLabel("八進位").first().fill("755");
    await page.getByRole("button", { name: "套用", exact: true }).first().click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_CHMOD__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const chmods = await page.evaluate(() => window.__DBKIT_SFTP_CHMOD__);
    check("chmod 送出 0755", chmods.length === 1 && chmods[0].path === "/home/deploy/app/server.js" && chmods[0].mode === 0o755,
      JSON.stringify(chmods));
    await sleep(300);
    check("清單的權限欄就地更新成 rwxr-xr-x", (await sftp.getByText("-rwxr-xr-x", { exact: true }).count()) > 0);
    check("沒有未實作的 SFTP command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // 終端機配色跟著主題：xterm 四周內距透出的外框底色＝xterm 自己的底色（不會框出一圈高一階的畫布色）；
  // 文字色照各變體配套的終端機配色（TERM_PALETTES）：深色變體共用一組文字色、淺色另一組，淡字灰各變體不同。
  async "ssh-terminal-theme"(page) {
    await openSshWeb01(page);
    const probe = () => page.evaluate(() => {
      const xterm = document.querySelector(".xterm");
      const frame = xterm?.parentElement?.parentElement; // .xterm → hostRef（pl-1 pt-1）→ 外框
      const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
      // DOM renderer 把 ANSI 色寫成 .xterm-fg-N { color: … } 規則（1 = red、8 = brightBlack）。
      const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
      const ansi = (n) => css.match(new RegExp(`\\.xterm-fg-${n}\\s*\\{\\s*color:\\s*([^;}]+)`))?.[1]?.trim().toLowerCase() ?? null;
      // xterm 6 的 .xterm 本身透明，主題底色畫在捲動容器上。
      return {
        frame: bg(frame), xterm: bg(xterm?.querySelector(".xterm-scrollable-element")),
        fg: getComputedStyle(document.querySelector(".xterm-rows")).color, red: ansi(1), dim: ansi(8),
      };
    });
    const pickTheme = (id) => page.locator("select").filter({ has: page.locator(`option[value="${id}"]`) }).first().selectOption(id);
    const expected = {
      amethyst: { fg: "rgb(248, 248, 242)", red: "#ff9580", dim: "#7970a9" },
      jade: { fg: "rgb(248, 248, 242)", red: "#ff9580", dim: "#70a99f" },
      moonstone: { fg: "rgb(31, 31, 31)", red: "#cb3a2a", dim: "#635d97" },
    };
    const bgs = new Set();
    for (const [id, want] of Object.entries(expected)) {
      await pickTheme(id);
      await sleep(300);
      const p = await probe();
      check(`${id}：終端機外框底色＝xterm 底色`, p.frame === p.xterm, JSON.stringify(p));
      check(`${id}：前景 / red / 淡字灰＝該變體的終端機配色`, p.fg === want.fg && p.red === want.red && p.dim === want.dim, JSON.stringify(p));
      bgs.add(p.xterm);
    }
    check("切換主題時終端機底色跟著變", bgs.size === 3, JSON.stringify([...bgs]));
  },

  // 詳細資料面板：預設收合（只留窄邊條）；展開後單擊 SSH 主機顯示它的設定；單擊資料庫節點換回資料庫摘要，
  // 兩邊的選取互斥（主機那列不再亮著）。展開的選擇會記住。
  async "info-panel-ssh-details"(page) {
    const panel = page.getByTestId("info-panel");
    check("詳細資料面板預設收合", (await panel.getAttribute("data-open").catch(() => null)) === "false");
    await page.getByRole("button", { name: "顯示詳細資料面板", exact: true }).click();
    await sleep(200);
    check("按一下展開", (await panel.getAttribute("data-open").catch(() => null)) === "true");
    check("展開的選擇會記住", await page.evaluate(() => localStorage.getItem("db-kit:infoPanel") === "open"));
    const tree = page.locator("[data-ssh-host-tree]");
    await tree.getByText("web-01", { exact: true }).first().click();
    await sleep(300);
    let txt = await panel.innerText().catch(() => "");
    check("單擊 SSH 主機顯示主機、使用者、認證方式與跳板機",
      /10\.20\.0\.15:22/.test(txt) && /deploy/.test(txt) && /私鑰/.test(txt) && /不經跳板機/.test(txt), txt.slice(0, 300));
    await page.getByText("prod-mysql", { exact: true }).first().click();
    await sleep(300);
    txt = await panel.innerText().catch(() => "");
    check("單擊資料庫連線換回資料庫摘要", /類型/.test(txt) && !/認證方式/.test(txt), txt.slice(0, 200));
    const rowLit = await page.evaluate(() => document.querySelector('[data-ssh-host="ssh-web01"]')?.className.includes("bg-accent/15") ?? null);
    check("選了資料庫節點後 SSH 主機那列不再亮著", rowLit === false, String(rowLit));
  },

  // 終端機狀態列 + 工作階段記錄 + 儲存畫面內容：記錄檔先清空寫標頭、之後追加去完色碼的輸出、停止時寫結束時間；
  // 儲存畫面內容存的是整個捲動緩衝區的文字。
  async "ssh-status-and-log"(page) {
    await openSshWeb01(page);
    const bar = page.getByTestId("ssh-status-bar");
    await bar.waitFor({ timeout: 5000 }).catch(() => {});
    const barText = await bar.innerText().catch(() => "");
    check("狀態列顯示主機、終端大小、編碼", /deploy@/.test(barText) && /\d+×\d+/.test(barText) && /UTF-8/.test(barText), barText);
    await bar.getByRole("button", { name: "開始記錄工作階段…" }).click();
    await page.waitForFunction(() => window.__DBKIT_SSH_LOG__.length > 0, null, { timeout: 5000 }).catch(() => {});
    let log = await page.evaluate(() => window.__DBKIT_SSH_LOG__);
    check("開始記錄：清空檔案並寫標頭", log[0]?.truncate === true && /工作階段記錄/.test(log[0]?.text ?? ""), JSON.stringify(log[0]));
    check("記錄中有標示", /記錄中/.test(await bar.innerText().catch(() => "")));
    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("echo log-me");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__DBKIT_SSH_LOG__.some((e) => !e.truncate && e.text.includes("log-me")), null, { timeout: 5000 }).catch(() => {});
    log = await page.evaluate(() => window.__DBKIT_SSH_LOG__);
    const body = log.filter((e) => !e.truncate).map((e) => e.text).join("");
    check("輸出每秒追加進記錄檔，而且沒有色碼", body.includes("log-me") && !body.includes("\x1b"), JSON.stringify(body.slice(0, 200)));
    await bar.getByRole("button", { name: "停止記錄" }).click();
    await sleep(300);
    log = await page.evaluate(() => window.__DBKIT_SSH_LOG__);
    check("停止時寫結束時間", /結束於/.test(log.at(-1)?.text ?? ""), JSON.stringify(log.at(-1)));
    check("停止後不再標示記錄中", !/記錄中/.test(await bar.innerText().catch(() => "")));
    await bar.getByRole("button", { name: "儲存畫面內容…" }).click();
    await page.waitForFunction(() => window.__DBKIT_SAVED_FILES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const saved = await page.evaluate(() => window.__DBKIT_SAVED_FILES__.at(-1));
    check("儲存畫面內容：整個畫面的文字", /deploy@web-01/.test(saved?.content ?? "") && /log-me/.test(saved?.content ?? ""), JSON.stringify(saved).slice(0, 200));
    check("沒有未實作的 SSH command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // SSH 操作紀錄：Enter 執行的指令從畫面讀（不記鍵盤），所以 sudo 密碼提示下打的字、命令列輸入條在密碼提示上送的字
  // 都不會進紀錄（也不進命令列歷史）；指令裡的 -p密碼換成 ***；以空白開頭的不記。狀態列開的紀錄視窗只列這台主機。
  async "ssh-oplog"(page) {
    await openSshWeb01(page);
    const oplog = () => page.evaluate(() => window.__DBKIT_SSH_OPLOG__.map((e) => ({ ...e })));
    const commands = async () => (await oplog()).filter((e) => e.kind === "command").map((e) => e.detail);
    const waitCmd = (text) => page.waitForFunction(
      (s) => window.__DBKIT_SSH_OPLOG__.some((e) => e.kind === "command" && e.detail === s), text, { timeout: 6000 },
    ).catch(() => {});
    const typeLine = async (s) => {
      await page.locator(".xterm-helper-textarea").first().focus();
      await page.keyboard.type(s);
      await page.keyboard.press("Enter");
    };
    check("連線有記下來（帶這台主機的 id）", (await oplog()).some((e) => e.kind === "connect" && e.session_id === "ssh-web01" && e.user === "deploy"),
      JSON.stringify(await oplog()).slice(0, 300));

    await typeLine("echo audit-1");
    await waitCmd("echo audit-1");
    const first = (await oplog()).find((e) => e.detail === "echo audit-1");
    check("鍵盤打的指令記下來（不含提示符、來源是鍵盤）", first?.source === "keyboard", JSON.stringify(first));

    // sudo：假 shell 跟真的一樣，密碼提示下不回顯
    await typeLine("sudo systemctl restart nginx");
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.innerText ?? "").includes("[sudo] password for deploy:"), null, { timeout: 5000 }).catch(() => {});
    await typeLine("Hunter2Secret");
    await waitCmd("sudo systemctl restart nginx");
    await sleep(2300); // 等過回顯等待時間：密碼那一行若會被記，這時一定已經記了
    check("假 shell 確實收到了密碼（測試本身有效）", (await page.evaluate(() => window.__DBKIT_SSH_SECRETS__)).includes("Hunter2Secret"));
    check("sudo 指令有記", (await commands()).includes("sudo systemctl restart nginx"), JSON.stringify(await commands()));
    check("密碼提示下打的密碼沒有進紀錄", !JSON.stringify(await oplog()).includes("Hunter2Secret"), JSON.stringify(await commands()));

    // 命令列輸入條在密碼提示上送出：是密碼，不記紀錄也不進歷史
    await typeLine("sudo uptime");
    await page.waitForFunction(() => window.__DBKIT_SSH_OPLOG__.some((e) => e.detail === "sudo uptime"), null, { timeout: 6000 }).catch(() => {});
    const compose = page.getByTestId("ssh-compose");
    await compose.fill("ComposePw9");
    await compose.press("Enter");
    await page.waitForFunction(() => window.__DBKIT_SSH_SECRETS__.includes("ComposePw9"), null, { timeout: 5000 }).catch(() => {});
    await sleep(400);
    check("輸入條在密碼提示上送的字沒有進紀錄", !JSON.stringify(await oplog()).includes("ComposePw9"));
    const history = await page.evaluate(() => localStorage.getItem("dbkit:ssh.composeHistory") ?? "");
    check("也沒有進命令列歷史", !history.includes("ComposePw9"), history);
    await compose.fill("ls");
    await compose.press("Enter");
    await waitCmd("ls");
    check("輸入條送的一般指令有記（來源是命令列）", (await oplog()).some((e) => e.detail === "ls" && e.source === "compose"));

    await typeLine("mysql -uroot -pS3cr3t shop");
    await waitCmd("mysql -uroot -p*** shop");
    check("指令裡的密碼換成 ***", (await commands()).includes("mysql -uroot -p*** shop") && !JSON.stringify(await oplog()).includes("S3cr3t"),
      JSON.stringify(await commands()));

    await typeLine(" echo hidden");
    await typeLine("pwd");
    await waitCmd("pwd");
    check("以空白開頭的指令不記", !(await commands()).some((c) => c.includes("echo hidden")), JSON.stringify(await commands()));

    // 紀錄視窗：狀態列開的只列這台；可依種類、關鍵字篩
    await page.getByTestId("ssh-status-bar").getByRole("button", { name: "這台主機的操作紀錄" }).click();
    const dlg = page.getByTestId("ssh-oplog");
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    await sleep(400);
    const rows = dlg.getByTestId("ssh-oplog-row");
    const text = await dlg.innerText().catch(() => "");
    check("紀錄視窗列出指令與連線", text.includes("echo audit-1") && text.includes("sudo systemctl restart nginx") && /連線/.test(text), text.slice(0, 400));
    check("視窗裡也看不到密碼", !text.includes("Hunter2Secret") && !text.includes("ComposePw9") && !text.includes("S3cr3t"));
    await dlg.getByRole("radio", { name: "指令" }).click();
    await sleep(400);
    const kinds = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
    check("篩「指令」只剩指令", kinds.length >= 5 && kinds.every((k) => k === "command"), JSON.stringify(kinds));
    await dlg.getByRole("textbox", { name: "搜尋" }).fill("audit");
    await sleep(700);
    check("關鍵字篩選", (await rows.count()) === 1 && /echo audit-1/.test(await rows.first().innerText()), String(await rows.count()));
    await page.getByRole("button", { name: "關閉", exact: true }).last().click();
    await sleep(300);
    check("關閉紀錄視窗", (await dlg.count()) === 0);

    // 設定裡的開關：關掉之後不記
    await page.locator('button[title="設定"]').first().click();
    const st = page.getByTestId("ssh-oplog-settings");
    await st.waitFor({ timeout: 5000 }).catch(() => {});
    await st.scrollIntoViewIfNeeded().catch(() => {});
    check("設定裡有操作紀錄的開關與資料夾", (await st.count()) === 1 && /ssh-oplog/.test(await st.innerText().catch(() => "")));
    await st.getByRole("checkbox").uncheck();
    await sleep(300);
    await page.keyboard.press("Escape");
    await sleep(300);
    await typeLine("echo while-off");
    await sleep(2500);
    check("關掉後不再記", !(await commands()).includes("echo while-off"), JSON.stringify(await commands()));
    check("沒有未實作的 SSH command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // 跳板機：主機設定可選另一台已存主機當跳板機（不能選自己），存下去的是那台的 id；清掉就回到直連。
  async "ssh-jump-host"(page) {
    const tree = page.locator("[data-ssh-host-tree]");
    await tree.getByText("web-01", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    const edit = async () => {
      await tree.getByText("web-01", { exact: true }).first().click({ button: "right" });
      await sleep(150);
      await page.locator('div.fixed.z-\\[90\\] button', { hasText: "編輯…" }).first().click();
    };
    await edit();
    const sel = page.getByLabel("跳板機", { exact: true });
    await sel.waitFor({ timeout: 5000 }).catch(() => {});
    check("有其他主機時跳板機下拉可以選", await sel.isEnabled().catch(() => false));
    const opts = await sel.locator("option").allTextContents();
    check("跳板機清單不含自己", !opts.some((o) => o.startsWith("web-01")) && opts.some((o) => o.includes("bastion.example.com")), JSON.stringify(opts));
    await sel.selectOption("ssh-bastion");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_SSH_SESSION_SAVES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    let saves = await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__);
    check("存下去的是跳板機那台的 id", saves.at(-1)?.jump_session_id === "ssh-bastion", JSON.stringify(saves.at(-1)?.jump_session_id));
    await edit();
    await sel.waitFor({ timeout: 5000 }).catch(() => {});
    const reopened = await sel.inputValue().catch((e) => "ERR " + e.message.slice(0, 80));
    check("再打開時帶出已選的跳板機", reopened === "ssh-bastion", JSON.stringify({ reopened, selects: await sel.count(), sessions: await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__.length) }));
    await sel.selectOption("");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_SSH_SESSION_SAVES__.length > 1, null, { timeout: 5000 }).catch(() => {});
    saves = await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__);
    check("清掉跳板機就回到直連（null）", saves.at(-1)?.jump_session_id === null, JSON.stringify(saves.at(-1)?.jump_session_id));
  },

  // 沒有 SSH 主機的人看不到 SSH（側欄區塊、分頁列按鈕）；第一台從「新增連線」加：
  // 類型選擇器有 SSH / SFTP 卡片，連線字串欄貼 sftp:// 就轉到 SSH 主機對話框並填好欄位。
  async "ssh-from-conn-string"(page) {
    check("沒有主機時側欄沒有 SSH 區塊", (await page.locator("[data-ssh-host-tree]").count()) === 0);
    // 分頁列要有連線（或開著分頁）才會出現：先連一個資料庫，「沒有 SSH 按鈕」才有意義。
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await page.getByRole("button", { name: "新增查詢分頁", exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    check("沒有主機時分頁列沒有 SSH 按鈕",
      (await page.getByRole("button", { name: "新增查詢分頁", exact: true }).count()) === 1
      && (await page.getByRole("button", { name: "新增 SSH 終端機", exact: true }).count()) === 0);

    const newConn = async () => {
      await page.getByRole("button", { name: "連線", exact: true }).first().click(); // 工具列「連線」＝新增連線
      await page.getByRole("radiogroup", { name: "連線類型" }).waitFor({ timeout: 5000 }).catch(() => {});
    };
    await newConn();
    const card = page.getByRole("radio", { name: "SSH / SFTP" });
    check("類型選擇器有 SSH / SFTP", (await card.count()) === 1);
    await card.click();
    const sshTitle = page.getByText("新增 SSH 主機", { exact: true });
    await sshTitle.first().waitFor({ timeout: 5000 }).catch(() => {});
    check("點 SSH / SFTP 改開 SSH 主機對話框", (await sshTitle.count()) > 0 && (await page.getByRole("radiogroup", { name: "連線類型" }).count()) === 0);
    // 第一台主機：沒有別台可當跳板機——下拉停用、提示講怎麼做，而不是只剩一個「直連」選項像沒做完。
    const jumpSel = page.getByLabel("跳板機", { exact: true });
    check("一台主機都沒有時跳板機下拉停用並說明怎麼做",
      (await jumpSel.isDisabled().catch(() => false)) && (await page.getByText(/還沒有其他主機可當跳板機/).count()) > 0);
    const importLink = page.getByRole("button", { name: "從 ~/.ssh/config、.xsh 匯入…", exact: true });
    check("新增 SSH 主機對話框有匯入入口", (await importLink.count()) === 1);
    await importLink.click();
    await page.getByText("匯入 SSH 主機", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("匯入入口打得開匯入對話框", (await page.getByText("匯入 SSH 主機", { exact: true }).count()) > 0);
    await page.keyboard.press("Escape");
    await sleep(300);

    await newConn();
    const url = page.getByPlaceholder("postgresql://user:pass@localhost:5432/dbname");
    await url.fill("sftp://deploy@10.0.0.9:2022/~/logs");
    await url.press("Enter");
    await page.getByLabel("主機", { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    const vals = {
      host: await page.getByLabel("主機", { exact: true }).inputValue().catch(() => null),
      port: await page.getByLabel("埠", { exact: true }).inputValue().catch(() => null),
      user: await page.getByLabel("使用者", { exact: true }).inputValue().catch(() => null),
      sftp: await page.getByLabel("開啟時一併展開 SFTP 面板").isChecked().catch(() => null),
      dir: await page.getByLabel("SFTP 起始資料夾", { exact: true }).inputValue().catch(() => null),
    };
    check("sftp:// 字串填好主機 / 埠 / 使用者 / SFTP 設定",
      vals.host === "10.0.0.9" && vals.port === "2022" && vals.user === "deploy" && vals.sftp === true && vals.dir === "~/logs", JSON.stringify(vals));
    check("顯示「已依連線字串填入」", (await page.getByText("已依連線字串填入，請確認後儲存").count()) > 0);
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_SSH_SESSION_SAVES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const saved = (await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__)).at(-1);
    check("存下去帶 SFTP 設定", saved?.options?.ui?.open_sftp === "1" && saved?.options?.ui?.sftp_dir === "~/logs", JSON.stringify(saved?.options?.ui));

    const tree = page.locator("[data-ssh-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    check("有了第一台主機，側欄 SSH 區塊出現", (await tree.getByText("deploy@10.0.0.9", { exact: true }).count()) > 0);
    const sshBtn = page.getByRole("button", { name: "新增 SSH 終端機", exact: true });
    await sshBtn.waitFor({ timeout: 5000 }).catch(() => {});
    check("分頁列 SSH 按鈕出現", (await sshBtn.count()) === 1, String(await sshBtn.count()));
    await tree.getByText("deploy@10.0.0.9", { exact: true }).first().dblclick();
    const panel = page.getByTestId("sftp-panel");
    await panel.getByText("app.log", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    check("sftp:// 建的主機一開就展開 SFTP，停在起始資料夾", (await panel.getByText("app.log", { exact: true }).count()) > 0);
  },

  // 遠端桌面：沒有主機時側欄不顯示；新增連線有 RDP / VNC / RustDesk 卡片；貼 vnc:// 字串轉交遠端桌面對話框並拆好欄位。
  async "rd-from-conn-string"(page) {
    check("沒有遠端桌面主機時側欄沒有該區塊", (await page.locator("[data-rd-host-tree]").count()) === 0);
    const newConn = async () => {
      await page.getByRole("button", { name: "連線", exact: true }).first().click();
      await page.getByRole("radiogroup", { name: "連線類型" }).waitFor({ timeout: 5000 }).catch(() => {});
    };
    await newConn();
    for (const name of ["RDP", "VNC / Mac", "RustDesk"]) {
      check(`類型選擇器有「${name}」`, (await page.getByRole("radio", { name, exact: true }).count()) === 1);
    }
    await page.getByRole("radio", { name: "VNC / Mac", exact: true }).click();
    const title = page.getByText("新增遠端桌面", { exact: true });
    await title.first().waitFor({ timeout: 5000 }).catch(() => {});
    check("點 VNC 卡片改開遠端桌面對話框", (await title.count()) > 0 && (await page.getByRole("radiogroup", { name: "連線類型" }).count()) === 0);
    await page.keyboard.press("Escape");
    await sleep(300);

    await newConn();
    const url = page.getByPlaceholder("postgresql://user:pass@localhost:5432/dbname");
    await url.fill("vnc://demo@mac-mini.local:1?ViewOnly=1");
    await url.press("Enter");
    await page.getByLabel("主機", { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    const vals = {
      host: await page.getByLabel("主機", { exact: true }).inputValue().catch(() => null),
      port: await page.getByLabel("埠", { exact: true }).inputValue().catch(() => null),
      user: await page.getByLabel("使用者", { exact: true }).inputValue().catch(() => null),
    };
    check("vnc:// 字串拆好主機 / 顯示編號轉埠 / 使用者", vals.host === "mac-mini.local" && vals.port === "5901" && vals.user === "demo", JSON.stringify(vals));
    check("顯示「已依連線字串填入」", (await page.getByText("已依連線字串填入，請確認後儲存").count()) > 0);
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_RD_SESSION_SAVES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const saved = (await page.evaluate(() => window.__DBKIT_RD_SESSION_SAVES__)).at(-1)?.session;
    check("存下去是 VNC、只看不控制", saved?.protocol === "vnc" && saved?.port === 5901 && saved?.options?.view_only === true, JSON.stringify(saved));
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    check("有了第一台主機，側欄遠端桌面區塊出現", (await tree.getByText("demo@mac-mini.local", { exact: true }).count()) > 0);
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // RustDesk 用 ID 連線：ID / 中繼伺服器欄位不用展開進階設定就看得到；貼上 RustDesk 匯出的伺服器設定字串一次填好三欄；存下去帶著走。
  async "rd-rustdesk-id-dialog"(page) {
    await page.getByRole("button", { name: "連線", exact: true }).first().click();
    await page.getByRole("radiogroup", { name: "連線類型" }).waitFor({ timeout: 5000 }).catch(() => {});
    await page.getByRole("radio", { name: "RustDesk", exact: true }).click();
    const idServer = page.getByLabel("ID 伺服器", { exact: true });
    await idServer.waitFor({ timeout: 5000 }).catch(() => {});
    check("RustDesk 的 ID 伺服器欄位直接看得到（不在進階設定裡）", (await idServer.count()) === 1 && (await page.getByLabel("中繼伺服器", { exact: true }).count()) === 1);
    // 照 RustDesk 的匯出格式：base64Url(JSON) 整串倒過來。
    const cfg = { host: "proxy.example.com", relay: "relay.example.com", api: "", key: "mpTh+jqLYRIiUxay7yPv9Mo+1eB7MIxHRbyRSe0000=" };
    const exported = [...Buffer.from(JSON.stringify(cfg)).toString("base64url")].reverse().join("");
    await idServer.evaluate((el, text) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, exported);
    const vals = {
      id: await idServer.inputValue().catch(() => null),
      relay: await page.getByLabel("中繼伺服器", { exact: true }).inputValue().catch(() => null),
      key: await page.getByLabel("Key", { exact: true }).inputValue().catch(() => null),
    };
    check("貼上設定字串填好 ID 伺服器 / 中繼伺服器 / Key", vals.id === cfg.host && vals.relay === cfg.relay && vals.key === cfg.key, JSON.stringify(vals));
    check("顯示「已依設定字串填入」", (await page.locator("[data-rd-server-filled]").count()) === 1);
    await page.getByLabel("對方 ID", { exact: true }).fill("216 830 407");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_RD_SESSION_SAVES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const saved = (await page.evaluate(() => window.__DBKIT_RD_SESSION_SAVES__)).at(-1)?.session;
    check("存下去：ID 去掉空白、伺服器設定都在", saved?.protocol === "rustdesk" && saved?.host === "216830407"
      && saved?.options?.rustdesk_server === cfg.host && saved?.options?.rustdesk_relay_server === cfg.relay && saved?.options?.rustdesk_key === cfg.key,
      JSON.stringify(saved?.options));
  },

  // RDP 分頁：畫出後端送的差異區塊、ack、鍵盤送掃描碼且 Ctrl+W 進遠端、工具列組合鍵、全螢幕切換、斷線覆蓋層。
  async "rd-rdp-session"(page) {
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    check("側欄有「遠端桌面」區塊", (await tree.count()) > 0);
    await tree.getByText("win-srv01", { exact: true }).first().dblclick();
    const canvas = page.locator("[data-rd-rdp] canvas");
    await page.waitForFunction(() => document.querySelector("[data-rd-rdp] canvas")?.dataset.rdSize === "320x200", null, { timeout: 8000 }).catch(() => {});
    check("畫布是遠端桌面的尺寸", (await canvas.getAttribute("data-rd-size").catch(() => null)) === "320x200");
    const px = await page.evaluate(() => {
      const c = document.querySelector("[data-rd-rdp] canvas");
      const g = c?.getContext("2d");
      return g ? [Array.from(g.getImageData(10, 10, 1, 1).data), Array.from(g.getImageData(300, 10, 1, 1).data)] : null;
    });
    check("畫出後端送的像素（左藍右橘）", !!px && px[0][2] === 200 && px[1][0] === 240, JSON.stringify(px));
    await page.waitForFunction(() => window.__DBKIT_RD_ACKS__.includes(1), null, { timeout: 3000 }).catch(() => {});
    check("畫完回 ack", await page.evaluate(() => window.__DBKIT_RD_ACKS__.includes(1)));

    // 剪貼簿：本機剛複製的文字，畫面取得焦點時交給遠端；遠端複製的文字寫進本機剪貼簿。
    // 連上時畫面已經拿到焦點：先移開（模擬切去別的程式複製），再點回來才會觸發 focus。
    await canvas.blur();
    await page.evaluate(() => { window.__DBKIT_RD_LOCAL_CLIP__ = "本機複製的文字"; });
    await canvas.click({ position: { x: 20, y: 20 } });
    await page.waitForFunction(() => window.__DBKIT_RD_CLIPBOARD__.length > 0, null, { timeout: 3000 }).catch(() => {});
    check("畫面取得焦點時把本機剪貼簿交給遠端", await page.evaluate(() => window.__DBKIT_RD_CLIPBOARD__.at(-1) === "本機複製的文字"));
    await page.evaluate(() => {
      const t = new TextEncoder().encode("遠端複製的文字");
      const h = new Uint8Array(16);
      h[0] = 7; h[4] = t.length & 0xff; h[5] = t.length >> 8;
      window.__DBKIT_RD_PUSH__([...h, ...t]);
    });
    await page.waitForFunction(() => window.__DBKIT_RD_CLIP_WRITES__.length > 0, null, { timeout: 3000 }).catch(() => {});
    check("遠端複製的文字寫進本機剪貼簿", await page.evaluate(() => window.__DBKIT_RD_CLIP_WRITES__.at(-1) === "遠端複製的文字"));
    await page.evaluate(() => { window.__DBKIT_RD_LOCAL_CLIP__ = "遠端複製的文字"; });
    await canvas.blur();
    await canvas.click({ position: { x: 22, y: 22 } });
    await sleep(300);
    check("剛從遠端拿到的文字不會又送回遠端", await page.evaluate(() => window.__DBKIT_RD_CLIPBOARD__.length === 1));

    await canvas.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("a");
    await page.keyboard.press("Control+w");
    // 等到 Ctrl+W 的 W（0x11）也送到了才讀（前面的滑鼠紀錄早就在了，不能只等「有東西」）。
    await page.waitForFunction(() => {
      for (const b of window.__DBKIT_RD_INPUTS__) for (let i = 0; i + 8 <= b.length; i += 8) if (b[i] === 1 && b[i + 2] === 0x11) return true;
      return false;
    }, null, { timeout: 3000 }).catch(() => {});
    const recs = await page.evaluate(() => {
      const out = [];
      for (const b of window.__DBKIT_RD_INPUTS__) for (let i = 0; i + 8 <= b.length; i += 8) out.push(b.slice(i, i + 8));
      return out;
    });
    check("按 A 送出掃描碼 0x1E", recs.some((r) => r[0] === 1 && r[2] === 0x1e), JSON.stringify(recs.slice(0, 6)));
    check("滑鼠點擊送出按鍵紀錄", recs.some((r) => r[0] === 4));
    check("Ctrl+W 進遠端、不關分頁", (await page.locator("[data-rd-tab]").count()) === 1 && recs.some((r) => r[0] === 1 && r[2] === 0x11));

    await page.getByRole("button", { name: "送出按鍵", exact: true }).click();
    await page.locator('[data-rd-combo="ctrl_alt_del"]').click();
    await page.waitForFunction(() => window.__DBKIT_RD_KEYS__.length > 0, null, { timeout: 3000 }).catch(() => {});
    check("工具列送 Ctrl+Alt+Del", await page.evaluate(() => window.__DBKIT_RD_KEYS__.includes("ctrl_alt_del")));

    await page.getByTestId("rd-fullscreen").click();
    await sleep(200);
    check("全螢幕：分頁蓋住整個 app 並切視窗全螢幕",
      (await page.locator("[data-rd-immersive]").count()) === 1 && (await page.evaluate(() => window.__DBKIT_RD_FULLSCREEN__.at(-1))) === true);
    check("全螢幕時有浮動工具列", (await page.locator("[data-rd-floatbar]").count()) === 1);
    await page.waitForFunction(() => window.__DBKIT_RD_GRAB__.at(-1) === window.__DBKIT_RD_LAST_CONN__, null, { timeout: 3000 }).catch(() => {});
    check("全螢幕時請後端攔系統鍵", await page.evaluate(() => window.__DBKIT_RD_GRAB__.at(-1) === window.__DBKIT_RD_LAST_CONN__));
    const before = await page.evaluate(() => window.__DBKIT_RD_INPUTS__.length);
    await page.evaluate(() => window.__DBKIT_EMIT__("rd-grab-key", { conn_id: window.__DBKIT_RD_LAST_CONN__, scancode: 0xe05b, down: true }));
    await page.waitForFunction((n) => window.__DBKIT_RD_INPUTS__.length > n, before, { timeout: 3000 }).catch(() => {});
    const winRec = await page.evaluate((n) => window.__DBKIT_RD_INPUTS__.slice(n).flat(), before);
    check("攔到的 Win 鍵以掃描碼 0xE05B 送到遠端", winRec[0] === 1 && winRec[2] === 0x5b && winRec[3] === 0xe0, JSON.stringify(winRec.slice(0, 8)));
    await canvas.click({ position: { x: 40, y: 40 } });
    await page.keyboard.press("Control+Alt+Enter");
    await sleep(200);
    check("Ctrl+Alt+Enter 離開全螢幕",
      (await page.locator("[data-rd-immersive]").count()) === 0 && (await page.evaluate(() => window.__DBKIT_RD_FULLSCREEN__.at(-1))) === false);
    check("離開全螢幕就不再攔系統鍵", await page.evaluate(() => window.__DBKIT_RD_GRAB__.at(-1) === null));

    await page.evaluate(() => window.__DBKIT_EMIT__("rd-conn-closed", { conn_id: window.__DBKIT_RD_LAST_CONN__, reason: "遠端主機結束了工作階段" }));
    const overlay = page.locator('[data-rd-overlay="disconnected"]');
    await overlay.waitFor({ timeout: 3000 }).catch(() => {});
    check("斷線顯示覆蓋層與原因", (await overlay.getByText("遠端主機結束了工作階段").count()) > 0);
    await overlay.getByRole("button", { name: "重新連線", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_RD_CONNECTS__.length >= 2, null, { timeout: 3000 }).catch(() => {});
    check("按「重新連線」重撥", await page.evaluate(() => window.__DBKIT_RD_CONNECTS__.length >= 2));
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // VNC 加密：主機設定可以指定「VeNCrypt 加密（TLS）」；連上後依後端報的安全層顯示徽章——
  // 匿名 TLS 標「未驗證伺服器」（有加密、沒驗身分），X509 不標，明文標「未加密」。
  async "rd-vnc-encryption"(page) {
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("mac-mini", { exact: true }).first().click({ button: "right" });
    await page.getByRole("button", { name: "編輯…", exact: true }).click();
    await page.getByRole("button", { name: /進階設定/ }).click();
    const sel = page.locator("select").filter({ has: page.locator('option[value="tls"]') });
    check("認證方式有「VeNCrypt 加密（TLS）」", (await sel.count()) === 1
      && ((await sel.locator('option[value="tls"]').textContent()) ?? "").includes("VeNCrypt 加密"));
    await sel.selectOption("tls");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await sleep(300);
    check("存成 vnc_security = tls", (await page.evaluate(() => window.__DBKIT_RD_SESSION_SAVES__.at(-1)?.session?.options?.vnc_security)) === "tls");

    const open = async (sec) => {
      await page.evaluate((s) => { window.__DBKIT_RD_VNC_SEC__ = s; }, sec);
      await tree.getByText("mac-mini", { exact: true }).first().dblclick();
      await page.waitForFunction(() => document.querySelector("[data-rd-vnc] canvas")?.width === 64, null, { timeout: 10000 }).catch(() => {});
      await sleep(200);
      const r = { anon: await page.locator("[data-rd-anon-tls]").count(), plain: await page.locator("[data-rd-unencrypted]").count() };
      await page.getByRole("button", { name: "中斷連線", exact: true }).first().click();
      await sleep(200);
      return r;
    };
    let r = await open({ security: "vencrypt-tls-vnc", encrypted: true });
    check("匿名 TLS：標「未驗證伺服器」、不標未加密", r.anon === 1 && r.plain === 0, JSON.stringify(r));
    await page.evaluate(() => { window.__DBKIT_RD_VNC_SEC__ = { security: "vencrypt-x509-vnc", encrypted: true }; });
    await page.getByRole("button", { name: "重新連線", exact: true }).first().click().catch(() => {});
    await page.waitForFunction(() => document.querySelector("[data-rd-vnc] canvas")?.width === 64 && !document.querySelector("[data-rd-overlay]"), null, { timeout: 10000 }).catch(() => {});
    await sleep(200);
    r = { anon: await page.locator("[data-rd-anon-tls]").count(), plain: await page.locator("[data-rd-unencrypted]").count() };
    check("X509：兩種徽章都沒有", r.anon === 0 && r.plain === 0, JSON.stringify(r));
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // VNC 分頁（Mac 螢幕共享）：真的 noVNC 經 VncChannel 走完假伺服器的握手並畫出畫面；未加密徽章；鍵盤 / 組合鍵走 rd_write。
  async "rd-vnc-session"(page) {
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("mac-mini", { exact: true }).first().dblclick();
    await page.waitForFunction(() => {
      const c = document.querySelector("[data-rd-vnc] canvas");
      return !!c && c.width === 64 && c.height === 48;
    }, null, { timeout: 10000 }).catch(() => {});
    const size = await page.evaluate(() => { const c = document.querySelector("[data-rd-vnc] canvas"); return c ? `${c.width}x${c.height}` : null; });
    check("noVNC 畫布是伺服器的桌面尺寸", size === "64x48", String(size));
    await sleep(400);
    const px = await page.evaluate(() => {
      const c = document.querySelector("[data-rd-vnc] canvas");
      return c ? Array.from(c.getContext("2d").getImageData(5, 5, 1, 1).data) : null;
    });
    check("畫出伺服器送的畫面（綠）", !!px && px[1] > 150 && px[0] < 80, JSON.stringify(px));
    check("未加密的連線有徽章", (await page.locator("[data-rd-unencrypted]").count()) > 0);
    const first = await page.evaluate(() => window.__DBKIT_RD_WRITES__[0]);
    check("noVNC 的第一筆是 RFB 版本字串（走假握手）", !!first && String.fromCharCode(...first).startsWith("RFB 003.008"), JSON.stringify(first));
    await page.locator("[data-rd-vnc] canvas").click({ position: { x: 10, y: 10 } });
    await page.keyboard.press("b");
    await page.getByRole("button", { name: "送出按鍵", exact: true }).click();
    await page.locator('[data-rd-combo="ctrl_alt_del"]').click();
    await sleep(300);
    const writes = await page.evaluate(() => window.__DBKIT_RD_WRITES__);
    const keyEvents = writes.flatMap((w) => {
      const out = [];
      for (let i = 0; i + 8 <= w.length; i++) if (w[i] === 4 && (w[i + 1] === 0 || w[i + 1] === 1) && w[i + 2] === 0 && w[i + 3] === 0) out.push(w.slice(i, i + 8));
      return out;
    });
    const sym = (k) => ((k[4] << 24) | (k[5] << 16) | (k[6] << 8) | k[7]) >>> 0;
    check("按鍵經 rd_write 送出 KeyEvent（b）", keyEvents.some((k) => sym(k) === 0x62), JSON.stringify(keyEvents.slice(0, 4)));
    check("Ctrl+Alt+Del 經 noVNC 送出", keyEvents.some((k) => sym(k) === 0xffff));
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // VNC 工具列：顯示設定（檢視方式 / 畫質 → SetEncodings / 只看不控制 / 游標點，都存回主機）、動作（重新整理 →
  // 非增量的畫面請求、伺服器支援 XVP 才有電源，先問過才送）、截圖（PNG 存檔）、錄影（WebM）、桌面名稱。
  async "rd-vnc-toolbar"(page) {
    await page.evaluate(() => { window.__DBKIT_RD_VNC_XVP__ = true; });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("mac-mini", { exact: true }).first().dblclick();
    await page.waitForFunction(() => document.querySelector("[data-rd-vnc] canvas")?.width === 64, null, { timeout: 10000 }).catch(() => {});
    await sleep(300);
    const msgs = () => page.evaluate(() => window.__DBKIT_RD_VNC_MSGS__ ?? []);
    const i32s = (m) => { const out = []; for (let i = 4; i + 4 <= m.length; i += 4) out.push((m[i] << 24) | (m[i + 1] << 16) | (m[i + 2] << 8) | m[i + 3]); return out; };
    const lastEncodings = async () => i32s((await msgs()).filter((m) => m[0] === 2).at(-1) ?? []);
    const menu = (which) => page.locator(`[data-rd-menu="${which}"]`);
    const opt = (id) => page.locator(`[data-rd-opt="${id}"]`);
    const action = (id) => page.locator(`[data-rd-action="${id}"]`);
    const lastSave = () => page.evaluate(() => window.__DBKIT_RD_SESSION_SAVES__.at(-1)?.session);
    check("工具列有顯示設定、動作、截圖、錄影", (await menu("display").count()) === 1 && (await menu("actions").count()) === 1
      && (await page.locator("[data-rd-screenshot]").count()) === 1 && (await page.locator("[data-rd-record]").count()) === 1);
    check("標題列帶伺服器報的桌面名稱", ((await page.locator("[data-rd-desktop-name]").textContent().catch(() => "")) ?? "").includes("demo-mac"));
    let enc = await lastEncodings();
    check("預設畫質平衡：JPEG 品質 6、壓縮 2", enc.includes(-32 + 6) && enc.includes(-256 + 2), JSON.stringify(enc.filter((e) => e < -20)));

    // ---- 顯示設定 ----
    await menu("display").click();
    check("顯示設定：預設縮放、平衡、可控制、同步剪貼簿、不畫游標點",
      (await opt("view-scale").getAttribute("aria-checked")) === "true" && (await opt("quality-balanced").getAttribute("aria-checked")) === "true"
      && (await opt("view-only").getAttribute("aria-checked")) === "false" && (await opt("clipboard").getAttribute("aria-checked")) === "true"
      && (await opt("dot-cursor").getAttribute("aria-checked")) === "false");
    await opt("quality-best").click();
    await sleep(300);
    enc = await lastEncodings();
    check("選最佳畫質 → 重送 SetEncodings（品質 9、壓縮 1）", enc.includes(-32 + 9) && enc.includes(-256 + 1), JSON.stringify(enc.filter((e) => e < -20)));
    check("畫質存回主機設定", (await lastSave())?.options?.ui?.vnc_quality === "best", JSON.stringify((await lastSave())?.options?.ui));
    await menu("display").click();
    await opt("view-none").click();
    await sleep(300);
    check("原始大小存回主機設定", (await lastSave())?.options?.resize_mode === "none");
    await menu("display").click();
    check("選單跟著勾原始大小", (await opt("view-none").getAttribute("aria-checked")) === "true");
    await opt("dot-cursor").click();
    await sleep(200);
    check("游標點存回主機設定", (await lastSave())?.options?.ui?.vnc_dot_cursor === "1");
    await menu("display").click();
    await opt("view-only").click();
    await sleep(300);
    check("只看不控制存回主機設定、送出按鍵變灰", (await lastSave())?.options?.view_only === true
      && (await page.getByRole("button", { name: "送出按鍵", exact: true }).isDisabled()));
    const keysBefore = (await msgs()).filter((m) => m[0] === 4).length;
    await page.locator("[data-rd-vnc] canvas").click({ position: { x: 10, y: 10 } });
    await page.keyboard.press("x");
    await sleep(200);
    check("只看不控制時按鍵不送出", (await msgs()).filter((m) => m[0] === 4).length === keysBefore);
    await menu("display").click();
    await opt("view-only").click();
    await sleep(300);
    await menu("display").click();
    await opt("view-scale").click();
    await sleep(300);

    // ---- 動作 ----
    const fullReqs = async () => (await msgs()).filter((m) => m[0] === 3 && m[1] === 0).length;
    const before = await fullReqs();
    await menu("actions").click();
    check("伺服器支援 XVP：動作有重新開機 / 關機 / 強制重設", (await action("power_reboot").count()) === 1
      && (await action("power_shutdown").count()) === 1 && (await action("power_reset").count()) === 1);
    await action("refresh").click();
    await sleep(300);
    check("重新整理畫面 → 送非增量的 FramebufferUpdateRequest", (await fullReqs()) === before + 1, `${before} → ${await fullReqs()}`);
    await menu("actions").click();
    await action("power_reboot").click();
    const confirmBtn = page.getByRole("button", { name: "重新開機", exact: true });
    await confirmBtn.waitFor({ timeout: 3000 }).catch(() => {});
    const xvp = async () => (await msgs()).filter((m) => m[0] === 250);
    check("重新開機先問過", (await page.getByText(/要讓這台機器重新開機嗎/).count()) === 1 && (await xvp()).length === 0);
    await confirmBtn.click();
    await sleep(300);
    check("確認後送 XVP 重新開機（版本 1、操作 3）", JSON.stringify((await xvp()).at(-1)) === JSON.stringify([250, 0, 1, 3]), JSON.stringify(await xvp()));

    // ---- 截圖 ----
    await page.locator("[data-rd-screenshot]").click();
    await page.waitForFunction(() => (window.__DBKIT_RD_SHOTS__ ?? []).length > 0, null, { timeout: 5000 }).catch(() => {});
    const shot = await page.evaluate(() => (window.__DBKIT_RD_SHOTS__ ?? [])[0]);
    check("截圖存成 PNG、檔名用主機名稱", !!shot && shot.name === "mac-mini" && JSON.stringify(shot.head) === JSON.stringify([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      && shot.bytes > 50, JSON.stringify(shot));
    check("提示截圖存到哪裡", (await page.getByText(/截圖已存到/).count()) > 0);
    await menu("actions").click();
    await action("reveal_shot").click();
    await sleep(200);
    check("動作選單「開啟截圖資料夾」", (await page.evaluate(() => window.__DBKIT_RD_REVEALS__ ?? [])).at(-1) === shot?.path);

    // ---- 錄影 ----
    const rec = page.locator("[data-rd-record]");
    await rec.click();
    await page.waitForFunction(() => document.querySelector("[data-rd-record]")?.getAttribute("data-rd-record") === "on", null, { timeout: 5000 }).catch(() => {});
    check("開始錄影 → 按鈕變停止", (await rec.getAttribute("data-rd-record")) === "on");
    for (const rgb of [[200, 40, 40], [40, 40, 200], [200, 200, 40], [20, 200, 60]]) {
      await page.evaluate((c) => window.__DBKIT_RD_VNC_FRAME__(c), rgb);
      await sleep(450);
    }
    await rec.click();
    await page.waitForFunction(() => document.querySelector("[data-rd-record]")?.getAttribute("data-rd-record") === "off", null, { timeout: 5000 }).catch(() => {});
    await sleep(500);
    const r0 = Object.values(await page.evaluate(() => window.__DBKIT_RD_RECORDINGS__ ?? {}))[0];
    check("停止錄影 → 寫了 WebM、檔名用主機名稱", !!r0 && r0.stopped && r0.name === "mac-mini" && r0.bytes > 200
      && JSON.stringify(r0.head) === JSON.stringify([0x1a, 0x45, 0xdf, 0xa3]), JSON.stringify(r0));
    await menu("actions").click();
    check("動作選單有「開啟錄影資料夾」", (await action("reveal_recording").count()) === 1);
    await page.keyboard.press("Escape");
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // VNC 鍵盤與重連：「把剪貼簿文字送到遠端」逐字打過去；虛擬鍵盤（Shift 按住時送大寫 / 符號 keysym、放開送同一個）；
  // 對方斷線自動重連；使用者叫對方關機後的斷線不重連。
  async "rd-vnc-keyboard"(page) {
    await page.evaluate(() => { window.__DBKIT_RD_VNC_XVP__ = true; });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("mac-mini", { exact: true }).first().dblclick();
    await page.waitForFunction(() => document.querySelector("[data-rd-vnc] canvas")?.width === 64, null, { timeout: 10000 }).catch(() => {});
    await sleep(300);
    const keys = async (from = 0) => (await page.evaluate(() => window.__DBKIT_RD_VNC_MSGS__ ?? []))
      .filter((m) => m[0] === 4).slice(from)
      .map((m) => [m[1] === 1 ? "d" : "u", ((m[4] << 24) | (m[5] << 16) | (m[6] << 8) | m[7]) >>> 0]);
    const syms = (ks) => ks.filter((k) => k[0] === "d").map((k) => k[1]);

    // ---- 把剪貼簿文字送到遠端 ----
    await page.evaluate(() => { window.__DBKIT_RD_LOCAL_CLIP__ = "Hi!\n中"; });
    let n = (await keys()).length;
    await page.getByRole("button", { name: "把剪貼簿文字送到遠端", exact: true }).click();
    await sleep(400);
    let got = await keys(n);
    check("剪貼簿文字逐字打過去：大寫與 ! 包一層 Shift（照實體鍵盤打字的順序）", JSON.stringify(got) === JSON.stringify([
      ["d", 0xffe1], ["d", 0x48], ["u", 0x48], ["u", 0xffe1], ["d", 0x69], ["u", 0x69],
      ["d", 0xffe1], ["d", 0x21], ["u", 0x21], ["u", 0xffe1], ["d", 0xff0d], ["u", 0xff0d], ["d", 0x01004e2d], ["u", 0x01004e2d]]), JSON.stringify(got));

    // ---- 虛擬鍵盤 ----
    await page.getByRole("button", { name: "送出按鍵", exact: true }).click();
    await page.locator("[data-rd-vk-toggle]").click();
    const vk = page.locator("[data-rd-vk]");
    await vk.waitFor({ timeout: 3000 }).catch(() => {});
    check("VNC 也有虛擬鍵盤", (await vk.count()) === 1);
    const vkKey = (sc) => vk.locator(`[data-vk-key="${sc}"]`).first();
    n = (await keys()).length;
    await vkKey(0x1e).click();
    await sleep(200);
    got = await keys(n);
    check("虛擬鍵盤 A → 送小寫 a 按下放開", JSON.stringify(got) === JSON.stringify([["d", 0x61], ["u", 0x61]]), JSON.stringify(got));
    n = (await keys()).length;
    await vkKey(0x2a).click();
    await vkKey(0x1e).click();
    await sleep(200);
    got = await keys(n);
    check("Shift 按住再按 A → Shift、大寫 A，按完 Shift 自動放開", JSON.stringify(got) === JSON.stringify([["d", 0xffe1], ["d", 0x41], ["u", 0x41], ["u", 0xffe1]]), JSON.stringify(got));
    n = (await keys()).length;
    await vkKey(0x2a).click();
    await vkKey(0x02).click();
    await vkKey(0xe053).click();
    await sleep(200);
    got = await keys(n);
    check("Shift + 1 → !；Delete 照送", JSON.stringify(syms(got)) === JSON.stringify([0xffe1, 0x21, 0xffff]), JSON.stringify(got));
    await page.getByRole("button", { name: "關閉虛擬鍵盤", exact: true }).click();

    // ---- 對方斷線：自動重連 ----
    const connects = () => page.evaluate(() => window.__DBKIT_RD_CONNECTS__.length);
    const c0 = await connects();
    const connId = await page.evaluate(() => window.__DBKIT_RD_LAST_CONN__);
    await page.evaluate((id) => window.__DBKIT_EMIT__("rd-conn-closed", { conn_id: id, reason: "遠端主機關閉了連線" }), connId);
    await page.locator("[data-rd-retry]").waitFor({ timeout: 3000 }).catch(() => {});
    check("對方斷線 → 顯示倒數自動重連", (await page.locator("[data-rd-retry]").count()) === 1);
    await page.waitForFunction((c) => window.__DBKIT_RD_CONNECTS__.length > c, c0, { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector("[data-rd-overlay]") && document.querySelector("[data-rd-vnc] canvas")?.width === 64, null, { timeout: 8000 }).catch(() => {});
    check("自動重連上、畫面回來", (await connects()) === c0 + 1 && (await page.locator("[data-rd-overlay]").count()) === 0);

    // ---- 叫對方關機之後斷線：不重連 ----
    await sleep(300);
    await page.locator('[data-rd-menu="actions"]').click();
    await page.locator('[data-rd-action="power_shutdown"]').click();
    const okBtn = page.getByRole("button", { name: "關機", exact: true });
    await okBtn.waitFor({ timeout: 3000 }).catch(() => {});
    await okBtn.click();
    await sleep(300);
    check("確認後送 XVP 關機（操作 2）", JSON.stringify((await page.evaluate(() => window.__DBKIT_RD_VNC_MSGS__)).filter((m) => m[0] === 250).at(-1)) === JSON.stringify([250, 0, 1, 2]));
    const c1 = await connects();
    const id2 = await page.evaluate(() => window.__DBKIT_RD_LAST_CONN__);
    await page.evaluate((id) => window.__DBKIT_EMIT__("rd-conn-closed", { conn_id: id, reason: "遠端主機關閉了連線" }), id2);
    await sleep(2500);
    check("關機後的斷線不自動重連", (await connects()) === c1 && (await page.locator("[data-rd-retry]").count()) === 0
      && (await page.locator('[data-rd-overlay="disconnected"]').count()) === 1);
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // RDP 憑證 TOFU：首次連線問指紋，接受後才連上。
  async "rd-cert-prompt"(page) {
    await page.evaluate(() => { window.__DBKIT_RD_PROMPT__ = "cert"; });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("win-srv01", { exact: true }).first().dblclick();
    const fp = page.getByText("SHA256:0Rd3mOCertFpXq1zW9vB7nK5jH3gF1dS8aP6oI4uY2t");
    await fp.first().waitFor({ timeout: 5000 }).catch(() => {});
    check("首次連線顯示伺服器憑證指紋", (await fp.count()) > 0);
    check("連上之前畫面是「正在連線」", (await page.locator('[data-rd-overlay="connecting"]').count()) === 1);
    await page.getByRole("button", { name: "接受並儲存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-rd-rdp] canvas")?.dataset.rdSize === "320x200", null, { timeout: 5000 }).catch(() => {});
    check("接受後連上", (await page.locator("[data-rd-overlay]").count()) === 0 && (await page.evaluate(() => window.__DBKIT_RD_ANSWERS__.includes("accept_save"))));
  },

  // RustDesk：真的 RustDesk 錄下來的 VP9 關鍵畫面經 WebCodecs 解出來；未加密徽章；鍵盤 / 滑鼠 / Ctrl+Alt+Del 走對的路。
  async "rd-rustdesk-session"(page) {
    // 先把 AI 助手與詳細資料面板打開：開 RustDesk 分頁時要自動收起來
    await page.getByRole("button", { name: "AI 助手", exact: true }).first().click();
    await page.getByRole("button", { name: "顯示詳細資料面板", exact: true }).click();
    await sleep(300);
    const panels = () => page.evaluate(() => ({
      info: document.querySelector('[data-testid="info-panel"]')?.getAttribute("data-open"),
      assistant: document.querySelectorAll('[data-testid="assistant-options"]').length,
      saved: [localStorage.getItem("db-kit:infoPanel"), localStorage.getItem("db-kit:assistantOpen")],
    }));
    const before = await panels();
    check("（前提）AI 助手與詳細資料面板是開著的", before.info === "true" && before.assistant > 0, JSON.stringify(before));
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    await sleep(300);
    const after = await panels();
    check("開 RustDesk 分頁 → AI 助手與詳細資料面板收起來（並記住）", after.info === "false" && after.assistant === 0
      && after.saved[0] === "closed" && after.saved[1] === "0", JSON.stringify(after));
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    const size = await page.evaluate(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize ?? null);
    check("WebCodecs 解出 RustDesk 的 VP9 畫面（1024×768）", size === "1024x768", String(size));
    check("Direct IP 標示未加密", (await page.locator("[data-rd-unencrypted]").count()) > 0);
    const canvas = page.locator("[data-rd-rustdesk] canvas");
    await canvas.click({ position: { x: 50, y: 50 } });
    await page.keyboard.press("a");
    await page.getByRole("button", { name: "送出按鍵", exact: true }).click();
    await page.locator('[data-rd-combo="ctrl_alt_del"]').click();
    await sleep(400);
    const cmds = await page.evaluate(() => window.__DBKIT_RD_WRITES__.map((b) => { try { return JSON.parse(String.fromCharCode(...b)); } catch { return null; } }).filter(Boolean));
    check("滑鼠點擊送出 RustDesk 的 mouse 指令（左鍵按下 mask 9）", cmds.some((c) => c.t === "mouse" && c.mask === 9), JSON.stringify(cmds.slice(0, 4)));
    check("按 A 送出掃描碼 0x1E", cmds.some((c) => c.t === "key" && c.down === true && c.scancode === 0x1e));
    // 對方按鍵是按在「目前游標」上：按下前一定先把游標移到同一點（節流省掉的最後一筆移動不會讓點擊點偏）。
    const down9 = cmds.findIndex((c) => c.t === "mouse" && c.mask === 9);
    const before9 = cmds[down9 - 1];
    check("按下前先送游標移到同一點", down9 > 0 && before9.t === "mouse" && before9.mask === 0 && before9.x === cmds[down9].x && before9.y === cmds[down9].y,
      JSON.stringify(cmds.slice(Math.max(0, down9 - 2), down9 + 1)));
    const keyA = cmds.find((c) => c.t === "key" && c.scancode === 0x1e);
    check("按鍵帶著本機的 CapsLock / NumLock 狀態（對方照著切）", typeof keyA?.caps === "boolean" && typeof keyA?.num === "boolean", JSON.stringify(keyA));
    // Ctrl + 點選：滑鼠指令帶 ctrl（沒帶的話對方按下前會把 Ctrl 放開，變成單純的點選）
    await canvas.click({ position: { x: 60, y: 60 } });
    await page.keyboard.down("Control");
    await canvas.click({ position: { x: 64, y: 64 } });
    await page.keyboard.up("Control");
    // 按著 Shift 時畫面失去焦點：對方的 Shift 要放開（不然一直按著）
    await page.keyboard.down("Shift");
    await page.getByRole("button", { name: "送出按鍵", exact: true }).focus();
    await sleep(300);
    await page.keyboard.up("Shift");
    const cmds2 = await page.evaluate(() => window.__DBKIT_RD_WRITES__.map((b) => { try { return JSON.parse(String.fromCharCode(...b)); } catch { return null; } }).filter(Boolean));
    check("Ctrl + 點選：mouse 指令帶 ctrl", cmds2.some((c) => c.t === "mouse" && c.mask === 9 && c.ctrl === true),
      JSON.stringify(cmds2.filter((c) => c.t === "mouse" && c.mask === 9)));
    const shiftDown = cmds2.findIndex((c) => c.t === "key" && c.scancode === 0x2a && c.down === true);
    check("按著 Shift 離開畫面 → 送出 Shift 放開", shiftDown >= 0 && cmds2.slice(shiftDown + 1).some((c) => c.t === "key" && c.scancode === 0x2a && c.down === false),
      JSON.stringify(cmds2.slice(Math.max(0, shiftDown))));
    check("Ctrl+Alt+Del 經後端送（不是拆成三個鍵）", await page.evaluate(() => window.__DBKIT_RD_KEYS__.includes("ctrl_alt_del")));
    check("只有一個螢幕：工具列沒有切換螢幕", (await page.locator("[data-rd-monitors]").count()) === 0);

    // 對方中斷（對方登入 / 登出作業系統、重新開機時 RustDesk 服務會重啟）→ 倒數自動重連；重撥失敗就加倍再等，對方回來就連上。
    const connects = () => page.evaluate(() => window.__DBKIT_RD_CONNECTS__.length);
    const n0 = await connects();
    await page.evaluate(() => {
      window.__DBKIT_RD_FAIL__ = "對方不在線上：對方電腦沒開 RustDesk，或它連不到 ID 伺服器";
      window.__DBKIT_EMIT__("rd-conn-closed", { conn_id: window.__DBKIT_RD_LAST_CONN__, reason: "remote closed the connection" });
    });
    const retry = page.locator("[data-rd-retry]");
    await retry.waitFor({ timeout: 3000 }).catch(() => {});
    check("對方中斷 → 顯示倒數自動重新連線", (await retry.count()) > 0, await page.locator("[data-rd-overlay]").innerText().catch(() => "（沒有覆蓋層）"));
    await page.waitForFunction((n) => window.__DBKIT_RD_CONNECTS__.length > n, n0, { timeout: 4000 }).catch(() => {});
    check("約 1 秒後自動重撥", (await connects()) === n0 + 1, String((await connects()) - n0));
    await retry.waitFor({ timeout: 3000 }).catch(() => {});
    check("重撥失敗（對方還沒回來）→ 繼續倒數、顯示原因", (await retry.count()) > 0
      && (await page.locator("[data-rd-error]").innerText().catch(() => "")).includes("對方不在線上"));
    await page.evaluate(() => { window.__DBKIT_RD_FAIL__ = null; });
    await page.waitForFunction((n) => window.__DBKIT_RD_CONNECTS__.length > n + 1, n0, { timeout: 5000 }).catch(() => {});
    await page.locator("[data-rd-overlay]").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    check("對方回來 → 自動連上（第 2 次重撥）", (await connects()) === n0 + 2 && (await page.locator("[data-rd-overlay]").count()) === 0,
      `${(await connects()) - n0} 次`);
    // 對方手動中斷：不自動重連（官方 check_if_retry）
    await page.evaluate(() => window.__DBKIT_EMIT__("rd-conn-closed", { conn_id: window.__DBKIT_RD_LAST_CONN__, reason: "Closed manually by the peer" }));
    await sleep(1600);
    check("對方手動中斷 → 不自動重連，只留「重新連線」", (await retry.count()) === 0 && (await connects()) === n0 + 2
      && (await page.locator('[data-rd-overlay="disconnected"]').getByRole("button", { name: "重新連線", exact: true }).count()) === 1);

    // 右鍵選單：分頁 / 側欄主機都能「中斷連線」，斷了之後分頁右鍵變成「重新連線」
    const tabMenu = async () => {
      await page.locator("[data-rd-tab]").first().click({ button: "right" });
      await sleep(150);
    };
    const menuItem = (name) => page.locator("[data-menu-panel]").getByRole("button", { name, exact: true });
    const overlayOf = (st) => page.locator(`[data-rd-overlay="${st}"]`);
    await tabMenu();
    check("斷線中：分頁右鍵有「重新連線」、沒有「中斷連線」", (await menuItem("重新連線").count()) >= 1 && (await menuItem("中斷連線").count()) === 0);
    await menuItem("重新連線").last().click();
    await overlayOf("connecting").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    await sleep(200);
    check("分頁右鍵「重新連線」→ 重撥並連上", (await connects()) === n0 + 3 && (await page.locator("[data-rd-overlay]").count()) === 0);
    const hostRow = page.locator("[data-rd-host-tree]").getByText("office-pc", { exact: true }).first();
    await hostRow.click({ button: "right" });
    await sleep(150);
    check("連著：側欄主機右鍵有「中斷連線」", (await menuItem("中斷連線").count()) === 1);
    await menuItem("中斷連線").click();
    await overlayOf("disconnected").waitFor({ timeout: 3000 }).catch(() => {});
    check("側欄右鍵「中斷連線」→ 分頁斷線", (await overlayOf("disconnected").count()) === 1
      && (await page.evaluate(() => window.__DBKIT_RD_CONNECTS__.length)) === n0 + 3);
    await hostRow.click({ button: "right" });
    await sleep(150);
    check("斷了之後側欄主機右鍵就沒有「中斷連線」", (await menuItem("中斷連線").count()) === 0);
    await page.keyboard.press("Escape");
    await tabMenu();
    await menuItem("重新連線").last().click();
    await overlayOf("connecting").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    await sleep(200);
    await tabMenu();
    await menuItem("中斷連線").click();
    await overlayOf("disconnected").waitFor({ timeout: 3000 }).catch(() => {});
    check("分頁右鍵「中斷連線」→ 斷線", (await overlayOf("disconnected").count()) === 1);
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // RustDesk 工具列：顯示設定（檢視方式 / 畫質 / 編碼 / 連線品質 / 同步剪貼簿）存回主機設定並送給對方；
  // 動作（Ctrl+Alt+Del / 鎖定畫面 / 封鎖輸入 / 重新啟動要先確認 / 重新整理）依對方權限出現；剪貼簿雙向；聊天。
  async "rd-rustdesk-toolbar"(page) {
    await page.evaluate(() => { window.__DBKIT_RD_PEER__ = { platform: "Windows" }; });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    const cmds = () => page.evaluate(() => window.__DBKIT_RD_WRITES__.map((b) => { try { return JSON.parse(new TextDecoder().decode(new Uint8Array(b))); } catch { return null; } }).filter(Boolean));
    const lastCmd = async (t) => (await cmds()).filter((c) => c.t === t).pop();
    const push = (ev) => page.evaluate((e) => window.__DBKIT_RD_PUSH__([1, ...new TextEncoder().encode(JSON.stringify(e))]), ev);
    const menu = (which) => page.locator(`[data-rd-menu="${which}"]`);
    const opt = (id) => page.locator(`[data-rd-opt="${id}"]`);
    const action = (id) => page.locator(`[data-rd-action="${id}"]`);
    const saves = () => page.evaluate(() => window.__DBKIT_RD_SESSION_SAVES__.map((s) => s.session));
    check("工具列有顯示設定、動作、聊天", (await menu("display").count()) === 1 && (await menu("actions").count()) === 1
      && (await page.locator("[data-rd-chat-toggle]").count()) === 1);

    // ---- 顯示設定 ----
    await menu("display").click();
    check("顯示設定：預設適應視窗、畫質平衡、編碼自動", (await opt("view-adaptive").getAttribute("aria-checked")) === "true"
      && (await opt("quality-balanced").getAttribute("aria-checked")) === "true" && (await opt("codec-auto").getAttribute("aria-checked")) === "true");
    check("編碼只列這個瀏覽器解得了的（VP9 / VP8 一定有）", (await opt("codec-vp9").count()) === 1 && (await opt("codec-vp8").count()) === 1);
    await opt("quality-low").click();
    await sleep(300);
    check("選「最佳反應速度」→ 送 quality low", (await lastCmd("quality"))?.level === "low", JSON.stringify(await lastCmd("quality")));
    check("畫質存回主機設定", (await saves()).at(-1)?.options?.ui?.rustdesk_quality === "low", JSON.stringify((await saves()).at(-1)?.options?.ui));
    await menu("display").click();
    await opt("codec-vp8").click();
    await sleep(300);
    const codec = await lastCmd("codec");
    check("選 VP8 → 送 codec（偏好 vp8 + 能解哪些）", codec?.prefer === "vp8" && codec?.vp9 === true && codec?.vp8 === true, JSON.stringify(codec));
    await menu("display").click();
    await opt("view-original").click();
    await sleep(300);
    const view = await page.evaluate(() => {
      const w = document.querySelector("[data-rd-rustdesk]");
      const c = w?.querySelector("canvas");
      return { mode: w?.dataset.rdView, width: c?.style.width ?? "", overflow: w ? getComputedStyle(w).overflow : "" };
    });
    check("原始大小：畫面 1:1、超出可捲動", view.mode === "original" && view.width === "" && view.overflow === "auto", JSON.stringify(view));
    await menu("display").click();
    await opt("stats").click();
    const stats = page.locator("[data-rd-stats]");
    await stats.waitFor({ timeout: 3000 }).catch(() => {});
    await push({ type: "delay", ms: 23, bitrate: 2000 });
    await sleep(1300);
    const statsText = await stats.textContent().catch(() => "");
    check("顯示連線品質：FPS / 延遲 / 編碼與解析度", /FPS/.test(statsText) && statsText.includes("23 ms") && statsText.includes("1024×768"), statsText);
    await menu("display").click();
    await opt("clipboard").click();
    await sleep(300);
    const tog = await lastCmd("toggle");
    check("關掉同步剪貼簿 → 告訴對方停用剪貼簿，並存回主機設定", tog?.name === "disable_clipboard" && tog?.on === true
      && (await saves()).at(-1)?.options?.clipboard === false, JSON.stringify(tog));
    await menu("display").click();
    await opt("clipboard").click();
    await sleep(300);

    // ---- 動作 ----
    await menu("actions").click();
    check("Windows 對方：動作有 Ctrl+Alt+Del / 鎖定畫面 / 封鎖輸入 / 重新啟動 / 重新整理",
      (await action("ctrl_alt_del").count()) === 1 && (await action("lock_screen").count()) === 1 && (await action("block_input").count()) === 1
      && (await action("restart").count()) === 1 && (await action("refresh").count()) === 1);
    await action("lock_screen").click();
    await sleep(200);
    check("鎖定對方畫面 → 送 lock_screen", !!(await lastCmd("lock_screen")));
    await menu("actions").click();
    await action("block_input").click();
    await sleep(200);
    check("封鎖輸入 → 送 toggle block_input on", (await cmds()).some((c) => c.t === "toggle" && c.name === "block_input" && c.on === true));
    await push({ type: "block_input", on: true, ok: true });
    await sleep(200);
    await menu("actions").click();
    check("對方回成功 → 選項改成解除封鎖", (await action("block_input").textContent()).includes("解除封鎖"));
    await action("restart").click();
    const confirmBtn = page.getByRole("button", { name: "重新啟動", exact: true });
    await confirmBtn.waitFor({ timeout: 3000 }).catch(() => {});
    check("重新啟動先問過", (await page.getByText(/要重新啟動對方的電腦嗎/).count()) === 1 && !(await lastCmd("restart")));
    await confirmBtn.click();
    await sleep(200);
    check("確認後送 restart", !!(await lastCmd("restart")));
    // 對方關掉重新啟動 / 封鎖輸入的權限 → 選單裡就沒有
    await push({ type: "permission", name: "restart", enabled: false });
    await push({ type: "permission", name: "block_input", enabled: false });
    await sleep(200);
    await menu("actions").click();
    check("對方關掉權限 → 重新啟動、封鎖輸入不再出現", (await action("restart").count()) === 0 && (await action("block_input").count()) === 0);
    await page.keyboard.press("Escape");

    // ---- 剪貼簿 ----
    await push({ type: "clipboard", text: "對方複製的文字" });
    await sleep(300);
    check("對方複製 → 寫進本機剪貼簿", (await page.evaluate(() => window.__DBKIT_RD_CLIP_WRITES__)).includes("對方複製的文字"));
    await page.evaluate(() => { window.__DBKIT_RD_LOCAL_CLIP__ = "本機複製的文字"; });
    await page.locator("[data-rd-rustdesk] canvas").click({ position: { x: 20, y: 20 } });
    await sleep(400);
    check("回到畫面時把本機剪貼簿送給對方", (await lastCmd("clipboard"))?.text === "本機複製的文字", JSON.stringify(await lastCmd("clipboard")));
    await page.getByRole("button", { name: "把剪貼簿文字送到遠端", exact: true }).click();
    await sleep(300);
    check("「把剪貼簿文字送到遠端」→ 整段打過去（type_text）", (await lastCmd("type_text"))?.text === "本機複製的文字");

    // ---- 聊天 ----
    await push({ type: "chat", text: "你好，我是對方" });
    const chat = page.locator("[data-rd-chat]");
    await chat.waitFor({ timeout: 3000 }).catch(() => {});
    check("對方傳訊息 → 聊天面板自己打開並顯示", (await chat.count()) === 1
      && (await page.locator('[data-rd-chat-msg="peer"]').textContent().catch(() => "")).includes("你好，我是對方"));
    const input = page.locator("[data-rd-chat-input]");
    await input.fill("收到");
    await input.press("Enter");
    await sleep(300);
    check("輸入後 Enter → 送 chat、面板顯示自己的訊息", (await lastCmd("chat"))?.text === "收到"
      && (await page.locator('[data-rd-chat-msg="me"]').count()) === 1 && (await input.inputValue()) === "");
    await page.getByRole("button", { name: "關閉聊天", exact: true }).click();
    await push({ type: "chat", text: "再一則" });
    await sleep(300);
    check("關掉後對方再傳 → 再打開", (await chat.count()) === 1 && (await page.locator('[data-rd-chat-msg="peer"]').count()) === 2);
    await page.getByRole("button", { name: "關閉聊天", exact: true }).click();

    // ---- 錄影 ----
    await page.evaluate(() => { window.__DBKIT_RD_KEEP_REC__ = true; });
    const rec = page.locator("[data-rd-record]");
    check("工具列有錄影按鈕", (await rec.getAttribute("data-rd-record")) === "off");
    await rec.click();
    await page.waitForFunction(() => document.querySelector("[data-rd-record]")?.getAttribute("data-rd-record") === "on", null, { timeout: 5000 }).catch(() => {});
    await sleep(200); // 假後端每個 command 晚 30ms 才收到
    check("開始錄影 → 按鈕變停止、告訴對方正在錄影", (await rec.getAttribute("data-rd-record")) === "on" && (await lastCmd("record"))?.on === true);
    // 錄影期間畫面有更新（MediaRecorder 才有東西錄）
    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.__DBKIT_RD_KEYFRAME__(0)); await sleep(500); }
    await rec.click();
    await page.waitForFunction(() => document.querySelector("[data-rd-record]")?.getAttribute("data-rd-record") === "off", null, { timeout: 5000 }).catch(() => {});
    await sleep(500);
    const recs = Object.values(await page.evaluate(() => window.__DBKIT_RD_RECORDINGS__ ?? {}));
    const r0 = recs[0];
    check("停止錄影 → 告訴對方停止、檔案寫了好幾段 WebM", (await lastCmd("record"))?.on === false && recs.length === 1 && r0.stopped
      && r0.chunks >= 2 && r0.bytes > 1000 && JSON.stringify(r0.head) === JSON.stringify([0x1a, 0x45, 0xdf, 0xa3]), JSON.stringify(r0));
    check("錄影檔名用主機名稱", r0?.name === "office-pc", r0?.name);
    // 把寫出去的每一段接回來，交給 <video> 播：讀得出畫面大小 = 檔案是完整可播的 WebM
    const played = await page.evaluate(async () => {
      const r = Object.values(window.__DBKIT_RD_RECORDINGS__)[0];
      const url = URL.createObjectURL(new Blob(r.data, { type: "video/webm" }));
      const v = document.createElement("video");
      v.muted = true;
      const ok = await new Promise((res) => {
        v.onloadedmetadata = () => res(true);
        v.onerror = () => res(false);
        setTimeout(() => res(false), 5000);
        v.src = url;
      });
      return { ok, w: v.videoWidth, h: v.videoHeight };
    });
    check("錄出來的 WebM 播得動、畫面大小跟遠端畫面一樣", played.ok && played.w === 1024 && played.h === 768, JSON.stringify(played));
    check("提示存到哪裡", (await page.getByText(/錄影已存到/).count()) > 0);
    await menu("actions").click();
    await action("reveal_recording").click();
    await sleep(200);
    check("動作選單「開啟錄影資料夾」", (await page.evaluate(() => window.__DBKIT_RD_REVEALS__ ?? [])).at(-1) === r0?.path);
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // RustDesk 鍵盤：翻譯模式（打得出字的鍵送字、快捷鍵照位置）、輸入作業系統密碼（沒存先問、勾記住之後直接打、可清除）、
  // 虛擬鍵盤（修飾鍵按住到下一個鍵、按著 Shift 顯示符號、CapsLock、焦點留在遠端畫面、關掉時放開修飾鍵）。
  async "rd-rustdesk-keyboard"(page) {
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    const cmds = () => page.evaluate(() => window.__DBKIT_RD_WRITES__.map((b) => { try { return JSON.parse(new TextDecoder().decode(new Uint8Array(b))); } catch { return null; } }).filter(Boolean));
    const since = async (n) => (await cmds()).slice(n);
    const menu = (which) => page.locator(`[data-rd-menu="${which}"]`);
    const opt = (id) => page.locator(`[data-rd-opt="${id}"]`);
    const action = (id) => page.locator(`[data-rd-action="${id}"]`);
    const canvas = page.locator("[data-rd-rustdesk] canvas");
    const sessionId = await page.evaluate(() => window.__DBKIT_RD_CONNECTS__.at(-1)?.target?.id);

    // ---- 鍵盤模式 ----
    await menu("display").click();
    check("鍵盤模式：預設「對應」", (await opt("keyboard-map").getAttribute("aria-checked")) === "true");
    await opt("keyboard-translate").click();
    await sleep(300);
    check("選「翻譯」存回主機設定", (await page.evaluate(() => window.__DBKIT_RD_SESSION_SAVES__.at(-1)?.session?.options?.ui?.rustdesk_keyboard)) === "translate");
    await canvas.click({ position: { x: 30, y: 30 } });
    let n = (await cmds()).length;
    await page.keyboard.press("a");
    await page.keyboard.press("Shift+B");
    await page.keyboard.press("Control+c");
    await sleep(300);
    let got = await since(n);
    const chars = got.filter((c) => c.t === "char").map((c) => c.text).join("");
    check("翻譯模式：a、Shift+B 送字（a、B），不送 A / B 的位置", chars === "aB"
      && !got.some((c) => c.t === "key" && (c.scancode === 0x1e || c.scancode === 0x30)), JSON.stringify(got));
    check("翻譯模式：Ctrl+C 照位置送（Ctrl、C 的掃描碼按下放開）",
      got.some((c) => c.t === "key" && c.scancode === 0x2e && c.down) && got.some((c) => c.t === "key" && c.scancode === 0x2e && !c.down)
      && got.some((c) => c.t === "key" && c.scancode === 0x1d && c.down));
    await menu("display").click();
    await opt("keyboard-map").click();
    await sleep(200);
    await canvas.click({ position: { x: 30, y: 30 } });
    n = (await cmds()).length;
    await page.keyboard.press("a");
    await sleep(200);
    got = await since(n);
    check("換回「對應」：a 照位置送 0x1E", got.some((c) => c.t === "key" && c.scancode === 0x1e && c.down) && !got.some((c) => c.t === "char"));

    // ---- 輸入作業系統密碼 ----
    const osInputs = () => page.evaluate(() => window.__DBKIT_RD_OS_INPUTS__);
    await menu("actions").click();
    await action("os_password").click();
    const dlg = page.locator("[data-rd-os-password]");
    await dlg.waitFor({ timeout: 3000 }).catch(() => {});
    check("沒存過：問作業系統密碼（預設勾記住）", (await dlg.count()) === 1 && (await page.locator("[data-rd-os-remember]").isChecked()));
    await dlg.fill("Ubuntu#123");
    await page.locator("[data-rd-os-submit]").click();
    await sleep(300);
    check("打過去：送出輸入的密碼", (await osInputs()).at(-1)?.password === "Ubuntu#123", JSON.stringify(await osInputs()));
    check("勾了記住：存進這台主機", (await page.evaluate((id) => window.__DBKIT_RD_OS_PASSWORDS__[id], sessionId)) === "Ubuntu#123");
    await menu("actions").click();
    await action("os_password").click();
    await sleep(300);
    check("存過之後：直接打，不再問", (await dlg.count()) === 0 && (await osInputs()).length === 2);
    await menu("actions").click();
    await action("os_password_set").click();
    await page.locator("[data-rd-os-clear]").waitFor({ timeout: 3000 }).catch(() => {});
    check("設定作業系統密碼：有存時可以清除", (await page.locator("[data-rd-os-clear]").count()) === 1);
    await page.locator("[data-rd-os-clear]").click();
    await sleep(300);
    check("清除後就不存了", (await page.evaluate((id) => window.__DBKIT_RD_OS_PASSWORDS__[id], sessionId)) === undefined
      && (await dlg.count()) === 0);

    // ---- 虛擬鍵盤 ----
    await page.getByRole("button", { name: "送出按鍵", exact: true }).click();
    await page.locator("[data-rd-vk-toggle]").click();
    const vk = page.locator("[data-rd-vk]");
    await vk.waitFor({ timeout: 3000 }).catch(() => {});
    check("「送出按鍵」選單打開虛擬鍵盤", (await vk.count()) === 1);
    const vkey = (sc) => vk.locator(`[data-vk-key="${sc}"]`).first();
    await canvas.click({ position: { x: 30, y: 30 } });
    n = (await cmds()).length;
    await vkey(0x2a).click();
    await sleep(150);
    check("按 Shift：標成按住、送出 Shift 按下", (await vkey(0x2a).getAttribute("data-vk-held")) === "" &&
      (await since(n)).some((c) => c.t === "key" && c.scancode === 0x2a && c.down));
    check("按住 Shift 時數字鍵顯示符號（1 → !）", (await vkey(0x02).textContent()) === "!");
    await vkey(0x1e).click();
    await sleep(150);
    got = (await since(n)).filter((c) => c.t === "key").map((c) => `${c.scancode.toString(16)}${c.down ? "↓" : "↑"}`);
    check("Shift + A：Shift↓ A↓ A↑ Shift↑，之後 Shift 自動放開", got.join(" ") === "2a↓ 1e↓ 1e↑ 2a↑"
      && (await vkey(0x2a).getAttribute("data-vk-held")) === null, got.join(" "));
    check("點虛擬鍵盤不會搶走遠端畫面的焦點", await page.evaluate(() => document.activeElement?.tagName === "CANVAS"));
    n = (await cmds()).length;
    await vkey(0x3a).click();
    await vkey(0xe05b).click();
    await vkey(0x1d).click();
    await sleep(150);
    got = (await since(n)).filter((c) => c.t === "key").map((c) => `${c.scancode.toString(16)}${c.down ? "↓" : "↑"}`);
    check("CapsLock 送按下放開（校正對方指示燈）；Win、Ctrl 都按住", got.join(" ") === "3a↓ 3a↑ e05b↓ 1d↓", got.join(" "));
    await vk.getByRole("button", { name: "關閉虛擬鍵盤", exact: true }).click();
    await sleep(200);
    got = (await since(n)).filter((c) => c.t === "key").map((c) => `${c.scancode.toString(16)}${c.down ? "↓" : "↑"}`);
    check("關掉虛擬鍵盤：按住的 Win、Ctrl 放開", (await vk.count()) === 0 && got.slice(-2).join(" ") === "1d↑ e05b↑", got.join(" "));
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // RustDesk 檔案傳輸：工具列打開雙窗格（左本機、右對方；另開傳檔連線、借畫面連線的密碼），
  // 左邊選了按「上傳 →」傳到右邊目前的資料夾，右邊下載直接放進左邊目前的資料夾；對方關掉傳檔權限時按鈕不出現；關掉就斷傳檔連線。
  async "rd-rustdesk-files"(page) {
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    const toggle = page.locator("[data-rd-files-toggle]");
    check("工具列有「檔案傳輸」", (await toggle.count()) === 1);
    const rdConn = await page.evaluate(() => window.__DBKIT_RD_LAST_CONN__);
    await toggle.click();
    const panel = page.locator('[data-rd-files="connected"]');
    await panel.waitFor({ timeout: 5000 }).catch(() => {});
    const files = () => page.evaluate(() => window.__DBKIT_RD_FILES__);
    const first = (await files())[0];
    check("另開傳檔連線、借畫面連線登入成功的密碼", (await panel.count()) === 1 && first?.op === "connect" && first?.via === rdConn && first?.connId !== rdConn,
      JSON.stringify(await files()));
    const local = page.locator("[data-local-pane]");
    const remote = panel.locator("[data-testid=sftp-panel]");
    await remote.locator('tr[data-name="backup.tar.gz"]').waitFor({ timeout: 5000 }).catch(() => {});
    check("左邊列出本機（家目錄）、右邊列出對方的家目錄",
      (await local.locator('tr[data-name="report.pdf"]').count()) === 1 && (await remote.locator('tr[data-name="backup.tar.gz"]').count()) === 1
      && (await local.locator("[data-local-path]").getAttribute("data-local-path")) === "C:\\Users\\me");
    // 上傳：左邊選兩個檔案 → 上傳 → 右邊目前資料夾
    await local.locator('tr[data-name="report.pdf"]').click();
    await local.locator('tr[data-name="notes.txt"]').click({ modifiers: ["Control"] });
    await local.locator("[data-local-upload]").click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_BATCH__.some((b) => b.kind === "upload"), null, { timeout: 5000 }).catch(() => {});
    const up = (await page.evaluate(() => window.__DBKIT_SFTP_BATCH__)).find((b) => b.kind === "upload");
    check("左邊選了按「上傳 →」：上傳到右邊目前的資料夾", up?.remoteDir === "/home/deploy"
      && JSON.stringify(up?.locals) === JSON.stringify(["C:\\Users\\me\\report.pdf", "C:\\Users\\me\\notes.txt"]), JSON.stringify(up));
    // 下載：先在左邊進 Documents，右邊選檔案按下載 → 直接放進 Documents（不另外問存到哪）
    await local.locator('tr[data-name="Documents"]').dblclick();
    await local.locator('tr[data-name="plan.docx"]').waitFor({ timeout: 3000 }).catch(() => {});
    await remote.locator('tr[data-name="backup.tar.gz"]').click();
    await remote.getByRole("button", { name: "下載選取的項目", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_BATCH__.some((b) => b.kind === "download"), null, { timeout: 5000 }).catch(() => {});
    const down = (await page.evaluate(() => window.__DBKIT_SFTP_BATCH__)).find((b) => b.kind === "download");
    check("右邊下載：直接放進左邊目前的資料夾", down?.localDir === "C:\\Users\\me\\Documents"
      && JSON.stringify(down?.remotes) === JSON.stringify(["/home/deploy/backup.tar.gz"]), JSON.stringify(down));
    // 關掉：斷傳檔連線、畫面還在
    await page.locator("[data-rd-files-close]").click();
    await sleep(300);
    const ops = (await files()).map((f) => f.op);
    check("關掉檔案傳輸：斷傳檔連線，遠端畫面還連著", (await page.locator("[data-rd-files]").count()) === 0 && ops.at(-1) === "disconnect"
      && (await page.locator("[data-rd-overlay]").count()) === 0, JSON.stringify(ops));
    // 連不上：顯示原因、可以重試
    await page.evaluate(() => { window.__DBKIT_RD_FILES_FAIL__ = "對方的 RustDesk 沒有回應（資料夾可能不存在或沒有權限）"; });
    await toggle.click();
    await page.locator('[data-rd-files="error"]').waitFor({ timeout: 3000 }).catch(() => {});
    check("連不上：顯示原因與「重新連線」", (await page.locator("[data-rd-files-error]").innerText().catch(() => "")).includes("沒有回應")
      && (await page.locator('[data-rd-files="error"]').getByRole("button", { name: "重新連線", exact: true }).count()) === 1);
    await page.evaluate(() => { window.__DBKIT_RD_FILES_FAIL__ = null; });
    await page.locator('[data-rd-files="error"]').getByRole("button", { name: "重新連線", exact: true }).click();
    await panel.waitFor({ timeout: 3000 }).catch(() => {});
    check("重新連線 → 連上", (await panel.count()) === 1);
    await page.locator("[data-rd-files-close]").click();
    // 對方關掉傳檔權限：按鈕不出現
    await page.evaluate(() => window.__DBKIT_RD_PUSH__([1, ...new TextEncoder().encode(JSON.stringify({ type: "permission", name: "file", enabled: false }))]));
    await sleep(300);
    check("對方關掉傳檔權限：沒有「檔案傳輸」", (await toggle.count()) === 0);
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // RustDesk 多螢幕：工具列每個螢幕一顆（目前的標亮）+「所有螢幕」；切過去送 displays 指令、滑鼠座標換成那個螢幕的；
  // 所有螢幕 = 照排列拼成一張；對方拔掉螢幕剩一個 → 按鈕收起、退回單一螢幕。
  async "rd-rustdesk-monitors"(page) {
    await page.evaluate(() => {
      window.__DBKIT_RD_DISPLAYS__ = [
        { x: 0, y: 0, width: 1024, height: 768, name: "\\\\.\\DISPLAY1" },
        { x: 1024, y: 0, width: 1024, height: 768, name: "\\\\.\\DISPLAY2" },
      ];
    });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    const canvasSize = () => page.evaluate(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize ?? null);
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    const bar = page.locator("[data-rd-monitors]");
    const mon = (id) => page.locator(`[data-rd-monitor="${id}"]`);
    check("兩個螢幕：工具列有螢幕 1、2 和「所有螢幕」", (await bar.count()) === 1 && (await mon(0).count()) === 1 && (await mon(1).count()) === 1 && (await mon("all").count()) === 1);
    check("螢幕按鈕的說明有編號與解析度", (await mon(1).getAttribute("title")) === "螢幕 2（1024×768）", await mon(1).getAttribute("title"));
    check("一開始看的是螢幕 1", (await mon(0).getAttribute("aria-pressed")) === "true" && (await mon(1).getAttribute("aria-pressed")) === "false");

    const cmds = () => page.evaluate(() => window.__DBKIT_RD_WRITES__.map((b) => { try { return JSON.parse(new TextDecoder().decode(new Uint8Array(b))); } catch { return null; } }).filter(Boolean));
    await mon(1).click();
    await sleep(200);
    check("切到螢幕 2：送 displays [1]", (await cmds()).some((c) => c.t === "displays" && JSON.stringify(c.set) === "[1]"), JSON.stringify((await cmds()).slice(-3)));
    check("螢幕 2 標亮", (await mon(1).getAttribute("aria-pressed")) === "true" && (await mon(0).getAttribute("aria-pressed")) === "false");
    await page.evaluate(() => window.__DBKIT_RD_KEYFRAME__(1));
    await sleep(300);
    const canvas = page.locator("[data-rd-rustdesk] canvas");
    const clickAt = async (fx) => {
      const b = await canvas.boundingBox();
      await page.mouse.click(b.x + b.width * fx, b.y + b.height / 2);
      await sleep(200);
      return (await cmds()).filter((c) => c.t === "mouse" && c.mask === 9).pop();
    };
    let m = await clickAt(0.5);
    check("點螢幕 2 的正中央 → 座標在螢幕 2（x ≈ 1024 + 512）", m && Math.abs(m.x - 1536) <= 8 && Math.abs(m.y - 384) <= 8, JSON.stringify(m));

    await mon("all").click();
    await sleep(200);
    check("所有螢幕：送 displays [0,1]", (await cmds()).some((c) => c.t === "displays" && JSON.stringify(c.set) === "[0,1]"));
    await page.evaluate(() => { window.__DBKIT_RD_KEYFRAME__(0); window.__DBKIT_RD_KEYFRAME__(1); });
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "2048x768", null, { timeout: 5000 }).catch(() => {});
    check("兩個螢幕照排列拼成一張（2048×768）", (await canvasSize()) === "2048x768", String(await canvasSize()));
    check("「所有螢幕」標亮、個別螢幕不亮", (await mon("all").getAttribute("aria-pressed")) === "true" && (await mon(0).getAttribute("aria-pressed")) === "false");
    m = await clickAt(0.25);
    check("拼圖左半 → 螢幕 1 的座標", m && Math.abs(m.x - 512) <= 12, JSON.stringify(m));
    m = await clickAt(0.75);
    check("拼圖右半 → 螢幕 2 的座標", m && Math.abs(m.x - 1536) <= 12, JSON.stringify(m));

    // 全螢幕的浮動工具列也有切換螢幕
    await page.getByTestId("rd-fullscreen").click();
    await sleep(200);
    check("全螢幕的浮動工具列也有切換螢幕", (await page.locator("[data-rd-floatbar] [data-rd-monitors]").count()) === 1);
    await page.getByTestId("rd-fullscreen").click().catch(() => {});
    await sleep(200);

    // 對方拔掉第二個螢幕：送新的清單 → 按鈕收起、退回螢幕 1
    await page.evaluate(() => {
      const ev = new TextEncoder().encode(JSON.stringify({ type: "displays", displays: [{ x: 0, y: 0, width: 1024, height: 768, name: "" }] }));
      window.__DBKIT_RD_PUSH__([1, ...ev]);
    });
    await sleep(300);
    check("剩一個螢幕：切換螢幕收起", (await bar.count()) === 0);
    check("退回螢幕 1：送 displays [0]", JSON.stringify((await cmds()).filter((c) => c.t === "displays").pop()?.set) === "[0]");
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0));
  },

  // RustDesk 畫面與游標：自訂縮放、對方游標形狀、顯示對方游標、跟著對方切螢幕、真彩、滾輪反向、截圖。
  async "rd-rustdesk-display"(page) {
    await page.evaluate(() => {
      window.__DBKIT_RD_PEER__ = { platform: "Linux" };
      window.__DBKIT_RD_DISPLAYS__ = [
        { x: 0, y: 0, width: 1024, height: 768, name: "a" },
        { x: 1024, y: 0, width: 1024, height: 768, name: "b" },
      ];
    });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    const cmds = () => page.evaluate(() => window.__DBKIT_RD_WRITES__.map((b) => { try { return JSON.parse(new TextDecoder().decode(new Uint8Array(b))); } catch { return null; } }).filter(Boolean));
    const lastCmd = async (t) => (await cmds()).filter((c) => c.t === t).pop();
    const lastToggle = async (name) => (await cmds()).filter((c) => c.t === "toggle" && c.name === name).pop();
    const push = (ev) => page.evaluate((e) => window.__DBKIT_RD_PUSH__([1, ...new TextEncoder().encode(JSON.stringify(e))]), ev);
    const menu = (which) => page.locator(`[data-rd-menu="${which}"]`);
    const opt = (id) => page.locator(`[data-rd-opt="${id}"]`);
    const action = (id) => page.locator(`[data-rd-action="${id}"]`);
    const ui = async () => (await page.evaluate(() => window.__DBKIT_RD_SESSION_SAVES__.map((s) => s.session))).at(-1)?.options?.ui ?? {};
    const canvas = page.locator("[data-rd-rustdesk] canvas");
    const cursorCss = () => canvas.evaluate((c) => c.style.cursor);

    // ---- 自訂縮放 ----
    await menu("display").click();
    check("顯示設定有自訂縮放", (await opt("view-custom").count()) === 1);
    await opt("view-custom").click();
    await page.getByText(/縮放比例/).waitFor({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press("Control+A");
    await page.keyboard.type("50");
    await page.keyboard.press("Enter");
    await sleep(300);
    const custom = await page.evaluate(() => {
      const w = document.querySelector("[data-rd-rustdesk]");
      const c = w?.querySelector("canvas");
      return { mode: w?.dataset.rdView, width: c?.style.width ?? "", height: c?.style.height ?? "", overflow: w ? getComputedStyle(w).overflow : "" };
    });
    check("自訂縮放 50% → 畫面 512×384、可捲動", custom.mode === "custom" && custom.width === "512px" && custom.height === "384px" && custom.overflow === "auto", JSON.stringify(custom));
    check("縮放存回主機設定", (await ui()).rustdesk_view === "custom" && (await ui()).rustdesk_scale === "50", JSON.stringify(await ui()));
    let b = await canvas.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(200);
    let m = (await cmds()).filter((c) => c.t === "mouse" && c.mask === 9).pop();
    check("縮放後點正中央 → 對方座標也是正中央", m && Math.abs(m.x - 512) <= 4 && Math.abs(m.y - 384) <= 4, JSON.stringify(m));
    await menu("display").click();
    check("選單顯示目前的比例", (await opt("view-custom").textContent()).includes("50%"), await opt("view-custom").textContent());
    await page.keyboard.press("Escape");

    // ---- 對方游標形狀 ----
    const rgba = (w, h, rgb) => {
      const u8 = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) u8.set([...rgb, 255], i * 4);
      return Buffer.from(u8).toString("base64");
    };
    await push({ type: "cursor_data", id: "42", hotx: 4, hoty: 6, width: 8, height: 12, rgba: rgba(8, 12, [255, 0, 0]) });
    await sleep(200);
    const c42 = await cursorCss();
    check("對方送游標圖 → 畫面上的游標換成那個（照 50% 縮放，熱點 2 3）", /^url\("?data:image\/png/.test(c42) && / 2 3, default$/.test(c42), c42.slice(-40));
    await push({ type: "cursor_data", id: "7", hotx: 0, hoty: 0, width: 16, height: 16, rgba: rgba(16, 16, [0, 0, 255]) });
    await sleep(200);
    const c7 = await cursorCss();
    await push({ type: "cursor_id", id: "42" });
    await sleep(200);
    check("換游標、再用編號換回之前的游標", c7 !== c42 && / 0 0, default$/.test(c7) && (await cursorCss()) === c42);
    await push({ type: "cursor_data", id: "bad", hotx: 0, hoty: 0, width: 4, height: 4, rgba: rgba(2, 2, [0, 0, 0]) });
    await sleep(100);
    check("大小不符的游標圖不理", (await cursorCss()) === c42);

    // ---- 顯示對方游標 ----
    await menu("display").click();
    await opt("remote-cursor").click();
    await sleep(300);
    check("顯示對方游標 → 告訴對方、存回主機設定", (await lastToggle("show_remote_cursor"))?.on === true && (await ui()).rustdesk_remote_cursor === "1");
    await push({ type: "cursor_position", x: 200, y: 100 });
    await sleep(200);
    const overlay = page.locator("[data-rd-remote-cursor]");
    const ov = await overlay.evaluate((o) => ({ display: o.style.display, left: parseFloat(o.style.left), top: parseFloat(o.style.top) }));
    const wrapBox = await page.locator("[data-rd-rustdesk]").boundingBox();
    b = await canvas.boundingBox();
    // 對方 (200, 100) × 50% → 畫面上 (100, 50)，減掉熱點 (2, 3)
    const ex = b.x - wrapBox.x + 100 - 2;
    const ey = b.y - wrapBox.y + 50 - 3;
    check("對方那邊移動游標 → 畫在對方游標的位置、本機游標先藏起來", ov.display === "block" && Math.abs(ov.left - ex) <= 1 && Math.abs(ov.top - ey) <= 1
      && (await cursorCss()) === "none", JSON.stringify({ ov, ex, ey }));
    await page.mouse.move(b.x + 30, b.y + 30);
    await page.mouse.move(b.x + 40, b.y + 40);
    await sleep(200);
    check("本機一動滑鼠 → 換回本機游標", (await overlay.evaluate((o) => o.style.display)) === "none" && (await cursorCss()) === c42);

    // ---- 跟著對方切螢幕 ----
    await menu("display").click();
    check("兩個螢幕：有跟著對方游標 / 焦點視窗", (await opt("follow-cursor").count()) === 1 && (await opt("follow-window").count()) === 1);
    await opt("follow-cursor").click();
    await sleep(300);
    check("跟著對方游標 → 告訴對方", (await lastToggle("follow_remote_cursor"))?.on === true && (await ui()).rustdesk_follow_cursor === "1");
    await push({ type: "follow_display", display: 1 });
    await sleep(300);
    check("對方游標到螢幕 2 → 跟著切過去", JSON.stringify((await lastCmd("displays"))?.set) === "[1]"
      && (await page.locator('[data-rd-monitor="1"]').getAttribute("aria-pressed")) === "true");
    await page.locator('[data-rd-monitor="0"]').click();
    await sleep(200);

    // ---- 真彩 ----
    await menu("display").click();
    const canTrue = (await opt("true-color").count()) === 1;
    if (canTrue) {
      await opt("true-color").click();
      await sleep(300);
      const cc = await lastCmd("codec");
      check("真彩 → 送 codec i444、存回主機設定", cc?.i444 === true && (await ui()).rustdesk_true_color === "1", JSON.stringify(cc));
    } else {
      await page.keyboard.press("Escape");
      check("這個瀏覽器解不了 4:4:4 → 沒有真彩選項", true);
    }

    // ---- 滾輪反向 ----
    await menu("display").click();
    await opt("view-adaptive").click();
    await sleep(200);
    b = await canvas.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, 120);
    await sleep(200);
    const normal = (await cmds()).filter((c) => c.t === "mouse" && c.mask === 3).pop();
    await menu("display").click();
    await opt("reverse-wheel").click();
    await sleep(200);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, 120);
    await sleep(200);
    const rev = (await cmds()).filter((c) => c.t === "mouse" && c.mask === 3).pop();
    check("滾輪反向：往下捲送的方向反過來", normal?.y === -1 && rev?.y === 1 && (await ui()).rustdesk_reverse_wheel === "1", JSON.stringify({ normal, rev }));

    // ---- 截圖：請對方擷取（原始畫質），PNG 回來交給後端存進截圖資料夾 ----
    await menu("actions").click();
    await action("screenshot").click();
    await sleep(300);
    const shot = await lastCmd("screenshot");
    await menu("actions").click();
    check("截圖（動作選單）→ 請對方擷取正在看的螢幕；等回覆時不能再按", shot?.display === 0 && (await action("screenshot").count()) === 0, JSON.stringify(shot));
    await page.keyboard.press("Escape");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
    await push({ type: "screenshot", png });
    await sleep(300);
    const saved = (await page.evaluate(() => window.__DBKIT_RD_SHOTS__ ?? [])).at(-1);
    check("對方回 PNG → 存檔（檔名用主機名稱）、提示存到哪裡", saved?.name === "office-pc" && saved?.bytes === 12 && saved?.head?.[1] === 0x50
      && (await page.getByText(/截圖已存到/).count()) > 0, JSON.stringify(saved));
    await menu("actions").click();
    await action("reveal_screenshot").click();
    await sleep(200);
    check("動作選單「開啟截圖資料夾」", (await page.evaluate(() => window.__DBKIT_RD_REVEALS__ ?? [])).at(-1) === saved?.path);
    await menu("actions").click();
    await action("screenshot").click();
    await sleep(300);
    await push({ type: "screenshot", error: "Wayland 不支援" });
    await sleep(300);
    check("對方截圖失敗 → 顯示原因", (await page.getByText(/截圖存檔失敗：Wayland 不支援/).count()) > 0);
    check("沒有未實作的遠端桌面 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // RustDesk 對方開了雙重驗證：問的是驗證碼（不是密碼、不能記住），錯了顯示原因再問，對了就連上。
  async "rd-rustdesk-2fa"(page) {
    await page.evaluate(() => { window.__DBKIT_RD_PROMPT__ = "otp"; });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    const otp = page.locator("[data-rd-otp]");
    await otp.waitFor({ timeout: 5000 }).catch(() => {});
    check("對話框問驗證碼", (await otp.count()) === 1 && (await page.getByText("雙重驗證", { exact: true }).count()) > 0);
    check("說明驗證碼從哪裡來", (await page.locator("[data-rd-auth-notice]").textContent().catch(() => ""))?.includes("驗證器 App"));
    check("驗證碼欄不是密碼欄、沒有「記住密碼」", (await otp.getAttribute("type")) !== "password"
      && (await otp.getAttribute("inputmode")) === "numeric" && (await page.getByText("記住密碼（存在系統鑰匙圈）").count()) === 0);
    await otp.fill("111111");
    await otp.press("Enter");
    const err = page.locator("[data-rd-auth-error]");
    await err.waitFor({ timeout: 5000 }).catch(() => {});
    check("驗證碼錯：顯示原因、再問一次", (await err.textContent().catch(() => ""))?.includes("驗證碼錯誤") && (await otp.inputValue().catch(() => "x")) === "");
    await otp.fill("123 456");
    await otp.press("Enter");
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    const answers = await page.evaluate(() => window.__DBKIT_RD_ANSWERS__);
    check("驗證碼對了就連上", (await page.locator("[data-rd-overlay]").count()) === 0, JSON.stringify(answers));
    check("驗證碼不記住", answers.length === 2 && answers.every((a) => a && a.remember === false), JSON.stringify(answers));
  },

  // 對方允許「信任這台裝置」：驗證碼對話框多一個勾選項，勾了答案帶 remember；驗證碼只收數字、滿 6 位才能送。
  async "rd-rustdesk-2fa-trust"(page) {
    await page.evaluate(() => { window.__DBKIT_RD_PROMPT__ = "otp"; window.__DBKIT_RD_TRUST__ = true; });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    const otp = page.locator("[data-rd-otp]");
    await otp.waitFor({ timeout: 5000 }).catch(() => {});
    const trust = page.locator("[data-rd-trust]");
    check("有「信任這台裝置」勾選項", (await trust.count()) === 1 && (await page.getByText("信任這台裝置（之後連這台不用再輸入驗證碼）").count()) === 1);
    const connect = page.getByRole("dialog").filter({ has: otp }).getByRole("button", { name: "連線", exact: true });
    await otp.fill("12a3");
    check("驗證碼只收數字、不滿 6 位不能送", (await otp.inputValue()) === "123" && (await connect.isDisabled()));
    await otp.press("Enter");
    check("不滿 6 位按 Enter 不送出", (await page.evaluate(() => window.__DBKIT_RD_ANSWERS__.length)) === 0);
    await trust.check();
    await otp.fill("123 4567");
    check("貼上帶空白的驗證碼：拿掉空白、最多 6 位", (await otp.inputValue()) === "123456" && !(await connect.isDisabled()));
    await connect.click();
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    const answers = await page.evaluate(() => window.__DBKIT_RD_ANSWERS__);
    check("勾了信任 → 答案帶 remember、連上", (await page.locator("[data-rd-overlay]").count()) === 0
      && answers.length === 1 && answers[0]?.password === "123456" && answers[0]?.remember === true, JSON.stringify(answers));
  },

  // 對方只能按「接受」（不收密碼）：只顯示「等待對方接受」、沒有密碼欄，只能取消；對方按了就連上。
  async "rd-rustdesk-wait-accept"(page) {
    await page.evaluate(() => { window.__DBKIT_RD_PROMPT__ = "wait"; });
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.getByText("office-pc", { exact: true }).first().dblclick();
    const waiting = page.locator("[data-rd-wait-accept]");
    await waiting.waitFor({ timeout: 5000 }).catch(() => {});
    check("顯示等待對方接受", (await waiting.count()) === 1 && (await page.getByText("等待對方接受", { exact: true }).count()) > 0
      && ((await waiting.textContent()) ?? "").includes("不能用密碼登入"));
    const dlg = page.getByRole("dialog").filter({ has: waiting });
    check("沒有密碼欄、沒有「連線」鈕，只能取消", (await dlg.locator("input").count()) === 0
      && (await dlg.getByRole("button", { name: "連線", exact: true }).count()) === 0
      && (await dlg.getByRole("button", { name: "取消", exact: true }).count()) === 1);
    await page.evaluate(() => window.__DBKIT_RD_ACCEPT__());
    await page.waitForFunction(() => document.querySelector("[data-rd-rustdesk] canvas")?.dataset.rdSize === "1024x768", null, { timeout: 10000 }).catch(() => {});
    check("對方按了接受 → 連上、等待對話框收掉", (await page.locator("[data-rd-overlay]").count()) === 0 && (await waiting.count()) === 0);
  },

  // 自動更新（NSIS 安裝的 Windows 版）：「關於」檢查到新版 → 更新對話框列出更新內容 →「立即更新」顯示下載進度、
  // 後端拿到的是那個版本 → 告知 App 會關閉並在裝完後重開。
  async "update-dialog-install"(page) {
    await page.evaluate(() => { window.__DBKIT_UPDATE_SUPPORT__ = "nsis"; });
    await page.getByRole("button", { name: "關於", exact: true }).click();
    await page.getByRole("button", { name: "檢查更新", exact: true }).click();
    const found = page.getByText("有新版 v9.9.9，點擊更新", { exact: true });
    await found.waitFor({ timeout: 5000 }).catch(() => {});
    check("「關於」查到新版", (await found.count()) === 1);
    await found.click();
    const notes = page.locator("[data-update-notes]");
    await notes.waitFor({ timeout: 5000 }).catch(() => {});
    const notesText = (await notes.textContent().catch(() => "")) ?? "";
    check("更新對話框：標題是新版本、列出更新內容", (await page.getByText("有新版 v9.9.9", { exact: true }).count()) > 0
      && notesText.includes("新功能 A"), notesText);
    check("不列 Release 頁的下載指引", !notesText.includes("平台") && !notesText.includes("下載"), notesText);
    check("「關於」對話框收起來了", (await page.getByRole("button", { name: "檢查更新", exact: true }).count()) === 0);
    const cur = (await page.locator("[data-update-current]").textContent().catch(() => "")) ?? "";
    check("寫出目前版本與最新版本", cur.includes("v9.9.9") && /目前版本 v\d+\.\d+\.\d+/.test(cur), cur);
    const install = page.locator("[data-update-install]");
    await install.click();
    const progress = page.locator("[data-update-progress]");
    await progress.waitFor({ timeout: 3000 }).catch(() => {});
    check("下載時顯示進度（MB）", ((await progress.textContent().catch(() => "")) ?? "").includes("MB"));
    check("下載中不能按「稍後」", await page.getByRole("button", { name: "稍後", exact: true }).isDisabled().catch(() => false));
    const done = page.locator("[data-update-launching]");
    await done.waitFor({ timeout: 5000 }).catch(() => {});
    check("裝好前告知 App 會關閉、裝完自動重開", ((await done.textContent().catch(() => "")) ?? "").includes("重新開啟"));
    check("後端拿到的是新版本號", await page.evaluate(() => JSON.stringify(window.__DBKIT_UPDATE_INSTALLS__) === "[\"9.9.9\"]"));
    check("沒有未實作的 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0), await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // 不支援自動安裝（macOS / Linux / 免安裝版）：只給「前往下載」，開的是 Release 頁面；失敗訊息看得到。
  async "update-dialog-manual"(page) {
    await page.getByRole("button", { name: "關於", exact: true }).click();
    await page.getByRole("button", { name: "檢查更新", exact: true }).click();
    const found = page.getByText("有新版 v9.9.9，點擊更新", { exact: true });
    await found.waitFor({ timeout: 5000 }).catch(() => {});
    await found.click();
    const manual = page.locator("[data-update-manual]");
    await manual.waitFor({ timeout: 5000 }).catch(() => {});
    check("說明這個版本不能自動安裝", (await manual.count()) === 1 && (await page.locator("[data-update-install]").count()) === 0);
    await page.getByRole("button", { name: "前往下載", exact: true }).click();
    await sleep(200);
    check("「前往下載」開 Release 頁面", await page.evaluate(() => window.__DBKIT_EXTERNAL_OPENS__.includes("https://github.com/markku636/db-kit/releases/tag/v9.9.9")));
    await page.getByRole("button", { name: "稍後", exact: true }).click();
    await sleep(200);
    check("「稍後」關閉對話框", (await manual.count()) === 0);
  },

  // 下載失敗：錯誤原因寫在對話框裡，按鈕變「重試」。
  async "update-dialog-error"(page) {
    await page.evaluate(() => { window.__DBKIT_UPDATE_SUPPORT__ = "msi"; window.__DBKIT_UPDATE_FAIL__ = "更新失敗：下載的安裝檔 SHA-256 對不上"; });
    await page.getByRole("button", { name: "關於", exact: true }).click();
    await page.getByRole("button", { name: "檢查更新", exact: true }).click();
    const found = page.getByText("有新版 v9.9.9，點擊更新", { exact: true });
    await found.waitFor({ timeout: 5000 }).catch(() => {});
    await found.click();
    await page.locator("[data-update-install]").click();
    const err = page.locator("[data-update-error]");
    await err.waitFor({ timeout: 5000 }).catch(() => {});
    check("失敗原因顯示在對話框", ((await err.textContent().catch(() => "")) ?? "").includes("SHA-256"));
    check("按鈕變「重試」", ((await page.locator("[data-update-install]").textContent().catch(() => "")) ?? "").includes("重試"));
  },

  // 啟動 10 秒後自動查：有新版就自動跳出更新對話框；按「稍後」後同一版不再自動跳，但標題列仍有「有新版」可點開。
  async "update-auto-popup"(page) {
    await page.clock.install();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root");
    await page.clock.runFor(1500);
    await page.clock.runFor(11_000);
    const dlg = page.locator("[data-update-current]");
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    check("啟動後自動跳出更新對話框", (await dlg.count()) === 1);
    await page.getByRole("button", { name: "稍後", exact: true }).click();
    await page.clock.runFor(500);
    check("按「稍後」記住這一版", await page.evaluate(() => localStorage.getItem("db-kit:updateDismissed") === "9.9.9"));
    const badge = page.getByRole("button", { name: /有新版 v9\.9\.9/ });
    check("標題列仍顯示「有新版」", (await badge.count()) === 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root");
    await page.clock.runFor(12_000);
    await page.getByRole("button", { name: /有新版 v9\.9\.9/ }).waitFor({ timeout: 5000 }).catch(() => {});
    check("同一版重開不再自動跳", (await dlg.count()) === 0 && (await page.getByRole("button", { name: /有新版 v9\.9\.9/ }).count()) === 1);
    await page.getByRole("button", { name: /有新版 v9\.9\.9/ }).click();
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    check("點標題列的「有新版」開啟更新對話框", (await dlg.count()) === 1);
  },

  // 匯入 .rdp（mstsc 存的 UTF-16LE）：帶進對話框，網域拆開、全螢幕 / 解析度進進階設定。
  async "rd-rdp-file-import"(page) {
    const tree = page.locator("[data-rd-host-tree]");
    await tree.waitFor({ timeout: 5000 }).catch(() => {});
    await tree.hover();
    await page.getByRole("button", { name: "匯入 .rdp 連線檔", exact: true }).click();
    await page.getByLabel("主機", { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    const vals = {
      host: await page.getByLabel("主機", { exact: true }).inputValue().catch(() => null),
      port: await page.getByLabel("埠", { exact: true }).inputValue().catch(() => null),
      user: await page.getByLabel("使用者", { exact: true }).inputValue().catch(() => null),
      domain: await page.getByLabel("網域", { exact: true }).inputValue().catch(() => null),
      fs: await page.getByLabel("連線後直接全螢幕").isChecked().catch(() => null),
      w: await page.getByLabel("寬", { exact: true }).inputValue().catch(() => null),
    };
    check(".rdp 檔帶入主機 / 埠 / 帳號 / 網域 / 全螢幕 / 解析度",
      vals.host === "rdp.example.com" && vals.port === "3390" && vals.user === "alice" && vals.domain === "CORP" && vals.fs === true && vals.w === "1600",
      JSON.stringify(vals));
  },

  // SSH 主機對話框的主機欄：貼 ssh 指令 / user@host:port 會拆進各欄位（跳板機對到已存主機）。
  async "ssh-host-paste"(page) {
    const tree = page.locator("[data-ssh-host-tree]");
    await tree.getByText("web-01", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await tree.getByRole("button", { name: "新增 SSH 主機", exact: true }).first().click();
    const host = page.getByLabel("主機", { exact: true });
    await host.waitFor({ timeout: 5000 }).catch(() => {});
    const paste = (text) => host.evaluate((el, s) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", s);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
    const read = async () => ({
      host: await host.inputValue(),
      port: await page.getByLabel("埠", { exact: true }).inputValue(),
      user: await page.getByLabel("使用者", { exact: true }).inputValue(),
      jump: await page.getByLabel("跳板機", { exact: true }).inputValue(),
    });
    await paste("ssh -p 2200 -J web-01 root@10.1.2.3");
    await sleep(200);
    let v = await read();
    check("貼 ssh 指令：主機 / 埠 / 使用者 / 跳板機", v.host === "10.1.2.3" && v.port === "2200" && v.user === "root" && v.jump === "ssh-web01", JSON.stringify(v));
    await paste("ops@db.internal:2022");
    await sleep(200);
    v = await read();
    check("貼 user@host:port：拆開，跳板機維持", v.host === "db.internal" && v.port === "2022" && v.user === "ops" && v.jump === "ssh-web01", JSON.stringify(v));
    await paste("ssh -J nobody@nowhere a@b");
    await sleep(200);
    check("跳板機對不到已存主機時說明", (await page.getByText("找不到跳板機「nobody@nowhere」", { exact: false }).count()) > 0);
  },

  // SSH 主機對話框：常用欄位一個畫面看得完（不必捲動）；SFTP / 終端機設定收在「進階設定」。
  async "ssh-host-dialog-fits"(page) {
    const tree = page.locator("[data-ssh-host-tree]");
    await tree.getByText("web-01", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await tree.getByRole("button", { name: "新增 SSH 主機", exact: true }).first().click();
    await page.getByLabel("主機", { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    const body = () => page.evaluate(() => {
      const b = document.querySelector('[role="dialog"]')?.children[1];
      return b ? { scroll: b.scrollHeight, client: b.clientHeight } : null;
    });
    const m = await body();
    check("新增 SSH 主機對話框不必捲動", !!m && m.scroll <= m.client + 1, JSON.stringify(m));
    check("進階設定預設收起", (await page.getByLabel("SFTP 起始資料夾", { exact: true }).count()) === 0);
    await page.getByRole("button", { name: "進階設定（SFTP、終端機）" }).click();
    check("展開進階設定看得到 SFTP 與終端機設定",
      (await page.getByLabel("SFTP 起始資料夾", { exact: true }).count()) === 1 && (await page.getByText("啟動指令", { exact: true }).count()) === 1);
    await page.keyboard.press("Escape");
    await sleep(300);
    // 編輯一台全是預設值的主機：進階設定維持收起（有非預設值才自己展開，見 ssh-from-conn-string 的 sftp:// 主機）。
    await tree.getByText("web-01", { exact: true }).first().click({ button: "right" });
    await sleep(150);
    await page.locator('div.fixed.z-\\[90\\] button', { hasText: "編輯…" }).first().click();
    await page.getByLabel("主機", { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    check("預設值的主機編輯時進階設定仍收起", (await page.getByLabel("SFTP 起始資料夾", { exact: true }).count()) === 0);
  },

  // 分頁右鍵的「關閉其他 / 全部關閉」：表、查詢、終端機三種分頁一起算（以前只關表分頁 = 按了沒反應）。
  async "tab-menu-close-others"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("shop", { exact: true }).nth(1).click();
    await sleep(700);
    await page.getByText("資料表", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="orders"]', { timeout: 8000 }).catch(() => {});
    await page.locator('[data-tree-table="orders"]').first().click();
    await sleep(600);
    await openSshWeb01(page);
    const bar = page.locator("[data-tab-bar]");
    const tabTexts = async () => (await bar.innerText()).replace(/\s+/g, " ");
    const before = await tabTexts();
    check("三種分頁都開著", /orders/.test(before) && before.includes("查詢") && before.includes("web-01"), before);
    await bar.getByText(/orders/).first().click({ button: "right" });
    await sleep(200);
    await page.locator('div.fixed.z-\\[90\\] button', { hasText: /^關閉其他$/ }).first().click();
    await sleep(500);
    const after = await tabTexts();
    check("表分頁的「關閉其他」連查詢與終端機一起關", /orders/.test(after) && !after.includes("查詢") && !after.includes("web-01") && (await page.locator(".xterm").count()) === 0, after);
    await page.getByRole("button", { name: "新增查詢分頁", exact: true }).click();
    await sleep(300);
    await bar.getByText("查詢", { exact: true }).first().click({ button: "right" });
    await sleep(200);
    const items = await menuItems(page);
    check("查詢分頁右鍵也有三種一起算的「全部關閉」", items.includes("全部關閉"), items.join(" | "));
    await page.locator('div.fixed.z-\\[90\\] button', { hasText: /^全部關閉$/ }).first().click();
    await sleep(500);
    const none = await tabTexts();
    check("全部關閉 → 一個分頁都不剩", !/orders/.test(none) && !none.includes("查詢"), none);
  },

  // 助手面板的 SSH 模式：停在終端機上時說明、建議、附帶內容都以主機為主，資料庫工具與內建技能收起來；
  // 切回資料庫分頁就恢復。面板最窄時選項列往下一行掉，標籤不能被擠成一字一行。
  async "assistant-ssh-mode"(page) {
    // 勾一個內建技能：SSH 模式下它不算數（技能按鈕不帶數字），切回資料庫分頁才算。
    await page.evaluate(() => localStorage.setItem("db-kit:aiSkillsOn", JSON.stringify(["sql-perf"])));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root");
    await sleep(1200);
    await openSshWeb01(page);
    await page.getByRole("button", { name: "AI 助手", exact: true }).first().click();
    const opts = page.getByTestId("assistant-options");
    await opts.waitFor({ timeout: 5000 }).catch(() => {});
    const badge = page.getByTitle("正在看 SSH 終端機：建議與附帶內容都以這台主機為主");
    check("標題列標出正在看哪台主機", (await badge.count()) === 1 && (await badge.innerText()).includes("web-01"));
    const optText = await opts.innerText();
    check("SSH 模式：附帶的是終端機畫面、沒有資料庫工具", optText.includes("附帶終端機畫面") && !optText.includes("資料庫工具"), optText);
    check("SSH 模式：建議換成主機相關的", (await page.getByRole("button", { name: "檢查主機資源用量" }).count()) === 1
      && (await page.getByRole("button", { name: "最佳化一段 SQL" }).count()) === 0);
    const skillsBtn = opts.locator('button[title*="點擊勾選 / 編輯技能"]');
    const skillsLabel = async () => (await skillsBtn.innerText()).replace(/\s+/g, "");
    check("SSH 模式：勾著的內建（資料庫）技能不算數", (await skillsLabel()) === "技能"
      && ((await skillsBtn.getAttribute("title")) ?? "").includes("SSH 模式只套用自訂技能"), await skillsLabel());
    // 每個選項都是單行（高度 < 26px）：流動排版往下掉，而不是把字壓扁。
    const tall = async () => opts.evaluate((el) =>
      [...el.querySelectorAll("label, select, input:not([type=checkbox]), button")].map((x) => Math.round(x.getBoundingClientRect().height)).filter((h) => h >= 26));
    check("面板最窄時選項沒有被擠成多行（SSH 模式）", (await tall()).length === 0, JSON.stringify(await tall()));

    await page.locator("[data-tab-bar]").getByText("查詢", { exact: true }).first().click();
    await sleep(500);
    const dbText = await opts.innerText();
    check("切回查詢分頁：資料庫工具回來、徽章消失", dbText.includes("資料庫工具") && (await badge.count()) === 0, dbText);
    check("切回查詢分頁：資料庫建議回來", (await page.getByRole("button", { name: "最佳化一段 SQL" }).count()) === 1);
    check("切回查詢分頁：勾著的內建技能又算數", (await skillsLabel()) === "技能1", await skillsLabel());
    check("面板最窄時選項沒有被擠成多行（資料庫模式）", (await tall()).length === 0, JSON.stringify(await tall()));
  },

  // 側欄主機列：沒連線是灰的、連上亮起；滑過有快速按鈕，已連線時按 SFTP 是切回那個分頁、不另開連線。
  async "ftp-host"(page) {
    const tree = page.locator("[data-ssh-host-tree]");
    const row = tree.locator('[data-ssh-host="ftp-files"]');
    await row.waitFor({ timeout: 8000 }).catch(() => {});
    await row.hover();
    check("FTP 主機的快速按鈕是「開啟」「在獨立視窗開啟」，沒有終端機",
      await row.getByRole("button", { name: "開啟", exact: true }).isVisible().catch(() => false)
      && await row.getByRole("button", { name: "在獨立視窗開啟", exact: true }).isVisible().catch(() => false)
      && await row.getByRole("button", { name: "編輯 FTP 主機", exact: true }).isVisible().catch(() => false)
      && (await row.getByRole("button", { name: "開啟終端機", exact: true }).count()) === 0);
    await row.dblclick();
    const pane = page.getByTestId("ftp-pane");
    const panel = pane.getByTestId("sftp-panel");
    await panel.getByText("backup.tar.gz", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    check("雙擊開出只有檔案面板的分頁，列得出登入後的資料夾", (await panel.getByText("backup.tar.gz", { exact: true }).count()) > 0);
    check("沒有終端機", (await page.locator(".xterm-rows").count()) === 0);
    check("面板標題是 FTPS", (await panel.getByText("FTPS", { exact: true }).count()) > 0);
    check("沒有跟終端機有關的按鈕、也不能把面板關掉",
      (await panel.getByRole("button", { name: /跟隨終端機/ }).count()) === 0
      && (await panel.getByRole("button", { name: /到終端機目前的資料夾|看不出終端機/ }).count()) === 0
      && (await panel.getByRole("button", { name: "關閉 SFTP", exact: true }).count()) === 0);
    await panel.getByText("backup.tar.gz", { exact: true }).first().click({ button: "right" });
    const items = await menuItems(page);
    check("右鍵選單有下載、沒有「在終端機 cd 到此」",
      items.some((x) => x.startsWith("下載")) && !items.some((x) => x.includes("在終端機 cd 到此")), items.join(" | "));
    await closeMenu(page);
    check("分頁列標出 FTPS", (await page.getByTitle("files（FTPS，中鍵關閉）", { exact: true }).count()) === 1);
    await row.hover();
    check("連上之後快速按鈕變成「切到分頁」", await row.getByRole("button", { name: "切到分頁", exact: true }).isVisible().catch(() => false));

    await page.getByRole("button", { name: "新增 SSH 終端機", exact: true }).click();
    await sleep(200);
    const picker = await menuItems(page);
    check("「新增 SSH 終端機」只列 SSH 主機", picker.some((x) => x.includes("web-01")) && !picker.some((x) => x.includes("files")), picker.join(" | "));
    await closeMenu(page);

    // 編輯：協定是 FTP，沒有 SSH 專屬欄位；切協定時埠跟著換預設值
    await row.hover();
    await row.getByRole("button", { name: "編輯 FTP 主機", exact: true }).click();
    await page.getByText("編輯 FTP 主機", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    const proto = page.getByRole("radiogroup", { name: "協定" });
    check("編輯對話框：協定選 FTP、加密是 explicit、沒有認證方式與跳板機",
      (await proto.getByRole("radio", { name: "FTP / FTPS（只有檔案）" }).getAttribute("aria-checked")) === "true"
      && (await page.getByLabel("加密", { exact: true }).inputValue().catch(() => null)) === "explicit"
      && (await page.getByRole("radiogroup", { name: "認證方式" }).count()) === 0
      && (await page.getByLabel("跳板機", { exact: true }).count()) === 0);
    const port = page.getByLabel("埠", { exact: true });
    await page.getByLabel("加密", { exact: true }).selectOption("implicit");
    const implicitPort = await port.inputValue();
    await proto.getByRole("radio", { name: "SSH / SFTP（終端機與檔案）" }).click();
    const sshPort = await port.inputValue();
    const sshFields = (await page.getByRole("radiogroup", { name: "認證方式" }).count()) === 1;
    check("加密換成 implicit → 990；切成 SSH → 22，出現認證方式", implicitPort === "990" && sshPort === "22" && sshFields, `${implicitPort} / ${sshPort}`);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await sleep(300);

    // 新增連線 → FTP / FTPS 卡片
    await page.getByRole("button", { name: "連線", exact: true }).first().click();
    await page.getByRole("radiogroup", { name: "連線類型" }).waitFor({ timeout: 5000 }).catch(() => {});
    await page.getByRole("radio", { name: "FTP / FTPS" }).click();
    await page.getByText("新增 FTP 主機", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("「FTP / FTPS」卡片開出新增 FTP 主機、預設 21 埠與 explicit TLS",
      (await page.getByText("新增 FTP 主機", { exact: true }).count()) > 0
      && (await port.inputValue().catch(() => null)) === "21"
      && (await page.getByLabel("加密", { exact: true }).inputValue().catch(() => null)) === "explicit"
      && (await page.getByText("已依連線字串填入，請確認後儲存").count()) === 0);
    const host = page.getByLabel("主機", { exact: true });
    await host.evaluate((el, text) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, "ftps://anon@files.example.org/pub");
    await sleep(200);
    check("主機欄貼上 ftps:// 拆進欄位（implicit、990）",
      (await host.inputValue()) === "files.example.org" && (await port.inputValue()) === "990"
      && (await page.getByLabel("加密", { exact: true }).inputValue()) === "implicit"
      && (await page.getByLabel("使用者", { exact: true }).inputValue()) === "anon");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_SSH_SESSION_SAVES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const saved = (await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__)).at(-1);
    check("存下去是 FTP 主機、帶加密方式與起始資料夾",
      saved?.protocol === "ftp" && saved?.ftp?.tls === "implicit" && saved?.port === 990 && saved?.options?.ui?.sftp_dir === "/pub" && !saved?.options?.ui?.open_sftp,
      JSON.stringify({ protocol: saved?.protocol, ftp: saved?.ftp, port: saved?.port, ui: saved?.options?.ui }));
    check("沒有未實作的 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  async "ssh-host-quick-actions"(page) {
    const tree = page.locator("[data-ssh-host-tree]");
    const row = tree.locator('[data-ssh-host="ssh-web01"]');
    await row.waitFor({ timeout: 8000 }).catch(() => {});
    check("還沒連線：沒有已連線標記", (await row.getAttribute("data-connected")) === null);
    await row.hover();
    check("滑過有快速按鈕", await row.getByRole("button", { name: "開啟終端機", exact: true }).isVisible()
      && await row.getByRole("button", { name: "開啟 SFTP", exact: true }).isVisible()
      && await row.getByRole("button", { name: "編輯 SSH 主機", exact: true }).isVisible());
    await row.getByRole("button", { name: "開啟終端機", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-ssh-host="ssh-web01"]')?.hasAttribute("data-connected"), null, { timeout: 8000 }).catch(() => {});
    check("連上後主機列亮起", (await row.getAttribute("data-connected")) === "");
    const terms = await page.locator(".xterm").count();
    await row.hover();
    check("已連線時按鈕變成「切到終端機」", (await row.getByRole("button", { name: "切到終端機", exact: true }).count()) === 1);
    await row.getByRole("button", { name: "開啟 SFTP", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_WINDOWS__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const wins = await page.evaluate(() => window.__DBKIT_SFTP_WINDOWS__);
    check("已連線時按 SFTP：開獨立視窗、沿用原分頁的連線",
      wins.length === 1 && wins[0].op === "open" && (await page.locator(".xterm").count()) === terms && (await page.getByTestId("sftp-panel").count()) === 0,
      JSON.stringify({ wins, before: terms, after: await page.locator(".xterm").count() }));
    await row.hover();
    await row.getByRole("button", { name: "編輯 SSH 主機", exact: true }).click();
    await page.getByText("編輯 SSH 主機", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("編輯按鈕打開這台的設定", (await page.getByLabel("主機", { exact: true }).inputValue().catch(() => "")) === "10.20.0.15");
  },

  // 側欄主機右鍵「開啟 SFTP」：開獨立視窗（跟終端機工具列的 SFTP 鈕一樣），不是展開側邊面板。
  // 還沒連線的主機先開終端機分頁（視窗用它的連線），連上才開視窗。
  async "ssh-host-menu-sftp-window"(page) {
    const row = page.locator('[data-ssh-host-tree] [data-ssh-host="ssh-web01"]');
    await row.waitFor({ timeout: 8000 }).catch(() => {});
    await row.click({ button: "right" });
    await page.locator('div.fixed.z-\\[90\\] button', { hasText: "開啟 SFTP" }).first().click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_WINDOWS__.length > 0, null, { timeout: 8000 }).catch(() => {});
    const wins = await page.evaluate(() => window.__DBKIT_SFTP_WINDOWS__);
    check("右鍵「開啟 SFTP」：連上後開獨立視窗",
      wins.length === 1 && wins[0].op === "open" && wins[0].title === "web-01 · deploy@10.20.0.15 — SFTP", JSON.stringify(wins));
    check("有開終端機分頁、沒有展開側邊面板",
      (await page.locator(".xterm").count()) === 1 && (await page.getByTestId("sftp-panel").count()) === 0);
    await sleep(300);
    check("只開一次視窗", (await page.evaluate(() => window.__DBKIT_SFTP_WINDOWS__.length)) === 1);
  },

  // 斷線後終端機上方的提示列：兩顆按鈕必須真的點得到（issue #7：提示列被 xterm 的圖層蓋住，看得到按不到）。
  // Playwright 的 click 會先確認沒有別的元素擋在上面，被擋住就失敗並說是誰擋的。
  async "ssh-disconnect-overlay"(page, opts = {}) {
    if (!opts.skipOpen) await openSshWeb01(page);
    const first = await page.evaluate(() => window.__DBKIT_SSH_LAST_CONN__);
    const closeConn = (id, reason = "遠端主機已強制關閉一個現存的連線。 (os error 10054)") =>
      page.evaluate(([c, r]) => window.__DBKIT_EMIT__("ssh-conn-closed", { conn_id: c, reason: r }), [id, reason]);
    await closeConn(first);
    const bar = page.getByTestId("ssh-disconnected");
    await bar.waitFor({ timeout: 5000 }).catch(() => {});
    check("斷線後顯示提示列與原因", /10054/.test(await bar.innerText().catch(() => "")));
    check("提示列標題講人話（os error 10054 → 遠端主機中斷了連線）", /遠端主機中斷了連線/.test(await bar.innerText().catch(() => "")));
    let err = "";
    await bar.getByRole("button", { name: "重新連線", exact: true }).click({ timeout: 3000 }).catch((e) => { err = String(e.message).split("\n").slice(0, 30).join(" | "); });
    check("提示列的「重新連線」點得到", !err, err);
    await page.waitForFunction((c) => window.__DBKIT_SSH_LAST_CONN__ && window.__DBKIT_SSH_LAST_CONN__ !== c, first, { timeout: 5000 }).catch(() => {});
    const second = await page.evaluate(() => window.__DBKIT_SSH_LAST_CONN__);
    check("按下去真的重新連線", !!second && second !== first);
    await sleep(600);
    // 第二次用很長的英文原因（英文系統語系的 Windows 就是這樣）：以前按鈕被擠成「重新連 / 線」兩行、提示蓋在輸出上。
    await closeConn(second, "An existing connection was forcibly closed by the remote host. ".repeat(4) + "(os error 10054)");
    await bar.waitFor({ timeout: 5000 }).catch(() => {});
    await sleep(200);
    const layout = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="ssh-disconnected"]');
      const screen = document.querySelector(".xterm-screen");
      // 按鈕裡文字排成幾行：各文字節點的行框頂端，差超過 4px 就算另一行。
      const lines = (btn) => {
        const tops = [];
        const walk = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const rect of r.getClientRects()) if (!tops.some((t) => Math.abs(t - rect.top) <= 4)) tops.push(rect.top);
        }
        return tops.length;
      };
      return {
        barBottom: el?.getBoundingClientRect().bottom ?? 0,
        screenTop: screen?.getBoundingClientRect().top ?? -1,
        buttons: [...(el?.querySelectorAll("button") ?? [])].map((b) => ({ text: b.textContent, lines: lines(b) })),
      };
    });
    check("斷線提示列不蓋住終端機畫面", layout.barBottom > 0 && layout.barBottom <= layout.screenTop + 0.5, JSON.stringify(layout));
    check("原因很長時按鈕的字仍然不換行", layout.buttons.length === 2 && layout.buttons.every((b) => b.lines === 1), JSON.stringify(layout.buttons));
    err = "";
    await bar.getByRole("button", { name: "關閉分頁", exact: true }).click({ timeout: 3000 }).catch((e) => { err = String(e.message).split("\n").slice(0, 30).join(" | "); });
    check("提示列的「關閉分頁」點得到", !err, err);
    await sleep(300);
    check("按下去分頁真的關掉", (await page.locator(".xterm").count()) === 0);
  },
  async "ssh-disconnect-overlay-webgl"(page) {
    const tree = page.locator("[data-ssh-host-tree]");
    await tree.getByText("web-01", { exact: true }).first().dblclick();
    await page.locator(".xterm").first().waitFor({ timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => !!window.__DBKIT_SSH_LAST_CONN__, null, { timeout: 10000 }).catch(() => {});
    await sleep(800);
    check("用的是 WebGL 渲染器（有 canvas）", (await page.locator(".xterm canvas").count()) > 0, String(await page.locator(".xterm canvas").count()));
    await CASES["ssh-disconnect-overlay"].call(this, page, { skipOpen: true });
  },

  // 匯入主機：~/.ssh/config 讀出的主機，已經有的預設不勾、有提醒的列出來；私鑰與憑證跟著帶；
  // .xsh 資料夾的子資料夾變成主機資料夾，參照的金鑰在金鑰庫有同名的就直接接上。
  async "ssh-host-import"(page) {
    const tree = page.locator("[data-ssh-host-tree]");
    await tree.getByText("web-01", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await tree.getByRole("button", { name: "匯入 SSH 主機", exact: true }).first().click();
    const dlg = page.getByTestId("ssh-import");
    await dlg.locator("[data-import-index]").first().waitFor({ timeout: 5000 }).catch(() => {});
    check("開啟就讀預設的 ~/.ssh/config", (await dlg.locator("[data-import-index]").count()) === 3);
    const box = (name) => dlg.getByRole("checkbox", { name, exact: true });
    check("已經在清單裡的主機預設不勾", !(await box("web-01").isChecked()) && (await box("db-prod").isChecked()));
    const dlgText = await dlg.innerText().catch(() => "");
    check("列出跳板機與不支援設定的提醒", /經 db-prod/.test(dlgText) && /ProxyCommand/.test(dlgText), dlgText.slice(0, 300));
    await page.getByRole("button", { name: "匯入 2 台", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_SSH_SESSION_SAVES__.length >= 2, null, { timeout: 5000 }).catch(() => {});
    const saves = await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__);
    const db = saves.find((s) => s.name === "db-prod");
    check("私鑰與憑證跟著帶進主機設定",
      db?.auth === "key" && /id_db$/.test(db?.private_key_path ?? "") && /id_db-cert\.pub$/.test(db?.certificate_path ?? ""), JSON.stringify(db));
    const app = saves.find((s) => s.name === "app.internal");
    check("沒有私鑰的先設成密碼認證", app?.auth === "password" && app?.private_key_path === "", JSON.stringify(app));
    check("ProxyJump 接到同一批匯入的主機", !!db?.id && app?.jump_session_id === db?.id, JSON.stringify({ app: app?.jump_session_id, db: db?.id }));
    await tree.getByText("db-prod", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("匯入後側欄看得到新主機", (await tree.getByText("db-prod", { exact: true }).count()) > 0);

    // .xsh 資料夾
    await tree.getByRole("button", { name: "匯入 SSH 主機", exact: true }).first().click();
    await dlg.getByRole("radio", { name: ".xsh 工作階段檔" }).click().catch(async () => {
      await dlg.getByText(".xsh 工作階段檔", { exact: true }).click();
    });
    await dlg.getByRole("checkbox", { name: "api-01", exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    check("讀 .xsh 資料夾，子資料夾顯示出來", /PROD \/ api/.test(await dlg.innerText().catch(() => "")));
    const before = await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__.length);
    await page.getByRole("button", { name: "匯入 2 台", exact: true }).click();
    await page.waitForFunction((n) => window.__DBKIT_SSH_SESSION_SAVES__.length >= n + 2, before, { timeout: 5000 }).catch(() => {});
    const api01 = (await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__)).find((s) => s.name === "api-01");
    check(".xsh 參照的金鑰在金鑰庫有同名的就直接接上", api01?.auth === "key" && api01?.private_key_path === "keystore:key-prod" && api01?.port === 2200,
      JSON.stringify(api01));
    await tree.getByText("PROD / api", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("子資料夾變成主機資料夾", (await tree.getByText("PROD / api", { exact: true }).count()) > 0);
    check("沒有未實作的 SSH command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // SSH 金鑰管理（Xshell 的使用者金鑰管理員）：貼上公鑰 → 說明這是公鑰；貼上加密私鑰 → 要密語、錯的密語
  // 講明是密語錯、對的才能匯入；產生新金鑰 → 拿得到公鑰那一行；主機設定從金鑰庫選 → 存下去的是 keystore:<id>。
  async "ssh-key-manager"(page) {
    const tree = page.locator("[data-ssh-host-tree]");
    await tree.getByText("web-01", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await tree.getByRole("button", { name: "SSH 金鑰", exact: true }).first().click();
    const mgr = page.getByTestId("ssh-key-manager");
    await mgr.waitFor({ timeout: 5000 }).catch(() => {});
    check("側欄「SSH 主機」標題列開得出金鑰管理", (await mgr.count()) > 0);
    // 清單是非同步載入的（先顯示「載入中…」）：等到第一列出現再比對內容，別在忙碌的機器上讀到載入中的畫面。
    await mgr.locator("[data-key-id]").first().waitFor({ timeout: 5000 }).catch(() => {});
    check("列出金鑰庫裡的金鑰（名稱 / 類型 / 密語 / 憑證）",
      /prod-deploy/.test(await mgr.innerText().catch(() => "")) && /Ed25519/.test(await mgr.innerText().catch(() => "")));

    // 貼上公鑰 → 明確說明
    await mgr.getByRole("button", { name: "貼上金鑰…" }).click();
    await page.getByLabel("貼上私鑰內容").fill("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKE me@laptop");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByText(/這是公鑰，不是私鑰/).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("貼上公鑰 → 說明這是公鑰、該選私鑰", (await page.getByText(/這是公鑰，不是私鑰/).count()) > 0);
    check("不能用的金鑰「匯入」按不下去", await page.getByRole("button", { name: "匯入", exact: true }).isDisabled().catch(() => false));
    await page.getByRole("button", { name: "返回", exact: true }).click();

    // 貼上加密私鑰 → 密語錯 / 對
    await mgr.getByRole("button", { name: "貼上金鑰…" }).click();
    await page.getByLabel("貼上私鑰內容").fill("-----BEGIN OPENSSH PRIVATE KEY-----\nENCRYPTED-DEMO\n-----END OPENSSH PRIVATE KEY-----");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    const pass = page.getByLabel("私鑰密語", { exact: true });
    await pass.waitFor({ timeout: 5000 }).catch(() => {});
    check("加密私鑰先要密語", (await pass.count()) > 0);
    await pass.fill("wrong");
    await page.getByRole("button", { name: "解開", exact: true }).click();
    await page.getByText(/密語不正確/).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("密語錯 → 講明是密語不正確", (await page.getByText(/密語不正確/).count()) > 0);
    await pass.fill("right-one");
    await page.getByRole("button", { name: "解開", exact: true }).click();
    const importView = page.getByTestId("ssh-key-import");
    await importView.getByText("SHA256:pasted0kLx3VbQ9nZr7TfYwHc2Jm5Ud8Ae1Gs4Ki6Po").first().waitFor({ timeout: 5000 }).catch(() => {});
    check("解開後顯示指紋", (await importView.getByText("SHA256:pasted0kLx3VbQ9nZr7TfYwHc2Jm5Ud8Ae1Gs4Ki6Po").count()) > 0);
    await importView.getByLabel("名稱", { exact: true }).fill("pasted key");
    await page.getByRole("button", { name: "匯入", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_KEY_IMPORTS__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const imports = await page.evaluate(() => window.__DBKIT_KEY_IMPORTS__);
    check("匯入帶的是解得開的那個密語與名稱",
      imports.length === 1 && imports[0].passphrase === "right-one" && imports[0].name === "pasted key" && imports[0].source.kind === "text",
      JSON.stringify(imports));
    await mgr.getByText("pasted key", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("匯入後清單多了一把", (await mgr.locator("[data-key-id]").count()) === 2);

    // 產生新金鑰
    await mgr.getByRole("button", { name: "產生新金鑰…" }).click();
    await page.getByRole("button", { name: "產生", exact: true }).click();
    const pub = page.getByTestId("ssh-key-public");
    await pub.waitFor({ timeout: 5000 }).catch(() => {});
    check("產生後拿得到 authorized_keys 那一行", /^ssh-ed25519 /.test(await pub.inputValue().catch(() => "")));
    await page.getByRole("button", { name: "完成", exact: true }).click();
    check("產生後清單多了一把", (await mgr.locator("[data-key-id]").count()) === 3);
    await page.keyboard.press("Escape");
    await sleep(200);

    // 主機設定：從金鑰庫選 → 存下去的是 keystore:<id>
    await tree.getByText("web-01", { exact: true }).first().click({ button: "right" });
    await sleep(150);
    await page.locator('div.fixed.z-\\[90\\] button', { hasText: "編輯…" }).first().click();
    await page.getByRole("button", { name: "金鑰庫…" }).first().waitFor({ timeout: 5000 }).catch(() => {});
    await page.getByRole("button", { name: "金鑰庫…" }).first().click();
    const row = page.locator('[data-testid=ssh-key-manager] [data-key-id="key-prod"]');
    await row.waitFor({ timeout: 5000 }).catch(() => {});
    await row.getByRole("button", { name: "使用", exact: true }).click();
    const chip = page.getByTestId("ssh-key-chip");
    await chip.waitFor({ timeout: 5000 }).catch(() => {});
    check("選了之後欄位顯示金鑰名稱而不是 id", /prod-deploy/.test(await chip.innerText().catch(() => "")));
    const status = page.getByTestId("ssh-key-status");
    await status.first().waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => /OpenSSH 憑證/.test(document.querySelector("[data-testid=ssh-key-status]")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
    const statusText = await status.first().innerText().catch(() => "");
    check("欄位下顯示金鑰檢查結果與憑證", /Ed25519/.test(statusText) && /OpenSSH 憑證/.test(statusText), statusText);
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await page.waitForFunction(() => window.__DBKIT_SSH_SESSION_SAVES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const saves = await page.evaluate(() => window.__DBKIT_SSH_SESSION_SAVES__);
    check("存下去的是 keystore:<id>", saves.length === 1 && saves[0].private_key_path === "keystore:key-prod", JSON.stringify(saves).slice(0, 300));
    check("沒有未實作的 SSH command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // SFTP 多選（檔案總管 / Xftp 慣例）：單擊、Ctrl 單擊、Shift 單擊、Ctrl+A；右鍵點在選取裡 → 對整組操作。
  // 批次下載 / 上傳必須是「一個工作、帶全部路徑」（不是每項各開一個傳輸），同名時問覆蓋 / 略過；
  // Delete 刪多項先確認、取消後一個都沒刪。
  async "sftp-multi-select"(page) {
    await openSshWeb01(page);
    await page.getByTestId("ssh-sftp-toggle").click();
    const sftp = page.getByTestId("sftp-panel");
    await sftp.getByText("backup.tar.gz", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    const row = (n) => sftp.locator(`tr[data-name="${n}"]`);
    const selected = () => sftp.locator('tr[aria-selected="true"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
    const menuBtn = (text) => page.locator('div.fixed.z-\\[90\\] button', { hasText: text }).first();

    await row("app").click();
    await row("backup.tar.gz").click({ modifiers: ["Control"] });
    let got = await selected();
    check("Ctrl 單擊加選", JSON.stringify(got) === JSON.stringify(["app", "backup.tar.gz"]), JSON.stringify(got));
    await row("app").click();
    await row("backup.tar.gz").click({ modifiers: ["Shift"] });
    got = await selected();
    check("Shift 單擊選一段（隱藏檔不算）", JSON.stringify(got) === JSON.stringify(["app", "logs", "backup.tar.gz"]), JSON.stringify(got));
    check("狀態列顯示已選取 3 項", /已選取 3 項/.test(await page.getByTestId("sftp-status").innerText().catch(() => "")));

    // 右鍵點在選取裡 → 整組；本機已有其中的 logs → 三選一，選「略過同名」
    await page.evaluate(() => { window.__DBKIT_DIALOG_OPEN__ = "C:\\Users\\demo\\Downloads"; window.__DBKIT_LOCAL_EXISTING__ = ["logs"]; });
    await row("logs").click({ button: "right" });
    await sleep(150);
    check("右鍵點在選取裡保留整組（選單是「下載 3 項…」）", (await menuBtn("下載 3 項…").count()) > 0, (await menuItems(page)).join(" | "));
    await menuBtn("下載 3 項…").click();
    const skipBtn = page.getByRole("button", { name: "略過同名", exact: true }).first();
    await skipBtn.waitFor({ timeout: 5000 }).catch(() => {});
    check("本機已有其中一項 → 問覆蓋 / 略過同名", (await page.getByText(/目的地已有 1 個同名項目：logs/).count()) > 0);
    await skipBtn.click().catch(() => {});
    await page.waitForFunction(() => window.__DBKIT_SFTP_BATCH__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const batch = await page.evaluate(() => window.__DBKIT_SFTP_BATCH__);
    check("批次下載是一個工作、帶全部三個路徑、策略 skip",
      batch.length === 1 && batch[0].kind === "download" && batch[0].localDir === "C:\\Users\\demo\\Downloads" && batch[0].onConflict === "skip"
        && JSON.stringify(batch[0].remotes) === JSON.stringify(["/home/deploy/app", "/home/deploy/logs", "/home/deploy/backup.tar.gz"]),
      JSON.stringify(batch));
    await page.getByText("已下載 app 等 3 項").first().waitFor({ timeout: 5000 }).catch(() => {});
    check("完成提示寫出批次名稱", (await page.getByText("已下載 app 等 3 項").count()) > 0);

    // Ctrl+A → Delete：確認框列出數量與資料夾；取消 → 一個都沒刪
    await row("app").click();
    await page.keyboard.press("Control+a");
    check("Ctrl+A 全選看得到的項目", (await selected()).length === 3);
    await page.keyboard.press("Delete");
    const confirmText = page.getByText(/刪除這 3 個項目（其中 2 個資料夾連同全部內容）/);
    await confirmText.first().waitFor({ timeout: 5000 }).catch(() => {});
    check("Delete 刪多項先確認，並講明含資料夾", (await confirmText.count()) > 0);
    await page.getByRole("button", { name: "取消", exact: true }).last().click();
    await sleep(200);
    check("取消後一個都沒刪", await page.evaluate(() => window.__DBKIT_SFTP_REMOVES__.length === 0));

    // 換資料夾清空選取；兩個檔 Shift 選取 → Delete → 確認 → 依畫面順序刪、非遞迴
    await row("logs").dblclick();
    await sftp.getByText("app.log", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    check("換資料夾後選取清空", (await selected()).length === 0);
    await row("app.log").click();
    await row("error.log").click({ modifiers: ["Shift"] });
    await page.keyboard.press("Delete");
    await page.getByText(/刪除這 2 個項目？/).first().waitFor({ timeout: 5000 }).catch(() => {});
    await page.getByRole("button", { name: "刪除", exact: true }).last().click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_REMOVES__.length >= 2, null, { timeout: 5000 }).catch(() => {});
    const removes = await page.evaluate(() => window.__DBKIT_SFTP_REMOVES__);
    check("確認後依畫面順序刪兩個檔（非遞迴）",
      JSON.stringify(removes) === JSON.stringify([
        { path: "/home/deploy/logs/app.log", recursive: false }, { path: "/home/deploy/logs/error.log", recursive: false },
      ]), JSON.stringify(removes));

    // 一次上傳兩個檔，其中 app.log 撞名 → 三選一，選「覆蓋」
    await page.evaluate(() => { window.__DBKIT_DIALOG_OPEN__ = ["C:\\tmp\\app.log", "C:\\tmp\\new.txt"]; });
    await sftp.getByRole("button", { name: "上傳檔案", exact: true }).first().click();
    const clash = page.getByText(/目的地已有 1 個同名項目：app\.log/);
    await clash.first().waitFor({ timeout: 5000 }).catch(() => {});
    check("上傳多檔時部分同名 → 三選一", (await clash.count()) > 0);
    await page.getByRole("button", { name: "覆蓋", exact: true }).last().click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_BATCH__.length > 1, null, { timeout: 5000 }).catch(() => {});
    const up = (await page.evaluate(() => window.__DBKIT_SFTP_BATCH__))[1];
    check("批次上傳到目前資料夾：兩個檔一個工作、策略 overwrite",
      up?.kind === "upload" && up.remoteDir === "/home/deploy/logs" && up.locals.length === 2 && up.onConflict === "overwrite", JSON.stringify(up));
    await page.evaluate(() => { delete window.__DBKIT_DIALOG_OPEN__; delete window.__DBKIT_LOCAL_EXISTING__; });
    check("沒有未實作的 SFTP command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // SFTP 與終端機所在的資料夾：工具列上帶字的「SFTP」（開獨立視窗）緊鄰「AI 協助」；在終端機 cd 之後打開側邊面板就列那裡
  // （假 shell 跟 Ubuntu 一樣用視窗標題回報 `user@host: ~/dir`）；關掉再開：終端機沒動 → 回到面板上次的位置，
  // 終端機換了 → 跳過去；「跟隨終端機」開著時 cd 一下面板就跟著換；放大 / 還原面板時終端機藏起來再回來。
  async "sftp-follow-terminal"(page) {
    await openSshWeb01(page);
    const toggle = page.getByTestId("ssh-sftp-toggle");
    const winBtn = page.getByTestId("ssh-sftp-window");
    check("工具列有帶字的 SFTP 按鈕", (await winBtn.innerText().catch(() => "")).includes("SFTP"));
    const prev = await winBtn.evaluate((el) => el.previousElementSibling?.getAttribute("aria-label") ?? "").catch(() => "");
    check("SFTP 按鈕緊鄰「AI 協助」", prev === "AI 協助", prev);
    const compose = page.getByTestId("ssh-compose");
    const run = async (cmd) => { await compose.fill(cmd); await compose.press("Enter"); await sleep(400); };
    await run("cd logs");
    const label = await page.locator("span.mono", { hasText: "deploy@web-01" }).first().innerText().catch(() => "");
    check("終端機的視窗標題回報目前的資料夾", label.includes("deploy@web-01: ~/logs"), label);

    await toggle.click();
    const sftp = page.getByTestId("sftp-panel");
    const shows = async (name) => {
      await sftp.getByText(name, { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
      return (await sftp.getByText(name, { exact: true }).count()) > 0;
    };
    check("在終端機 cd 之後打開 SFTP：直接列出那個資料夾", await shows("app.log"), (await sftp.innerText().catch(() => "")).slice(0, 200));

    await sftp.getByRole("button", { name: "deploy", exact: true }).click();
    await shows("backup.tar.gz");
    await toggle.click();
    await sleep(200);
    await toggle.click();
    check("終端機沒換資料夾：重開回到面板上次的位置", await shows("backup.tar.gz"));
    await toggle.click();
    await run("cd ../app");
    await toggle.click();
    check("終端機換了資料夾：重開跳到終端機那裡", await shows("server.js"));

    await sftp.getByRole("button", { name: "/", exact: true }).click();
    await shows("etc");
    await sftp.getByRole("button", { name: /到終端機目前的資料夾/ }).click();
    check("「到終端機目前的資料夾」跳回 ~/app", await shows("server.js"));

    const follow = sftp.getByRole("button", { name: /跟隨終端機切換資料夾/ });
    await follow.click();
    check("跟隨終端機的開關變成開", (await follow.getAttribute("aria-pressed")) === "true");
    await run("cd ~/logs");
    check("跟隨開著：終端機 cd 之後面板跟著換", await shows("error.log"));
    await follow.click();
    await run("cd ~");
    await sleep(300);
    check("跟隨關掉：終端機 cd 面板不動", (await sftp.getByText("error.log", { exact: true }).count()) > 0);

    await sftp.getByRole("button", { name: "放大 SFTP 面板" }).click();
    await sleep(200);
    check("放大 SFTP：終端機暫時收起", !(await page.locator(".xterm").first().isVisible()));
    await sftp.getByRole("button", { name: "還原 SFTP 面板大小" }).click();
    await sleep(200);
    check("還原：終端機回來", await page.locator(".xterm").first().isVisible());
    check("沒有未實作的 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // SFTP 獨立視窗（主視窗這一側）：工具列的「SFTP」開視窗、側邊面板鈕留在最右邊；視窗打招呼 → 推連線狀態，
  // 終端機 cd → 推新的資料夾；視窗要求 cd → 送進 shell；側邊面板「移到獨立視窗」帶著所在資料夾、只帶一次；
  // 側邊面板拖著檔案經過 → 提示改用獨立視窗；關分頁 → 收掉視窗。
  async "sftp-window-host"(page) {
    await openSshWeb01(page);
    const winBtn = page.getByTestId("ssh-sftp-window");
    const toggle = page.getByTestId("ssh-sftp-toggle");
    check("SFTP 視窗鈕緊鄰「AI 協助」",
      (await winBtn.evaluate((el) => el.previousElementSibling?.getAttribute("aria-label") ?? "").catch(() => "")) === "AI 協助");
    check("側邊面板鈕在工具列最右邊", await toggle.evaluate((el) => el.nextElementSibling === null).catch(() => false));
    const windows = () => page.evaluate(() => window.__DBKIT_SFTP_WINDOWS__);
    await winBtn.click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_WINDOWS__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const opened = (await windows())[0];
    check("按 SFTP：開獨立視窗（帶分頁鍵與主機）",
      opened?.op === "open" && String(opened.tabKey).startsWith("__ssh__:") && opened.title === "web-01 · deploy@10.20.0.15 — SFTP", JSON.stringify(opened));
    check("視窗開著：SFTP 鈕亮起", /text-accent/.test((await winBtn.getAttribute("class")) ?? ""));
    check("開視窗不會順手打開側邊面板", (await page.getByTestId("sftp-panel").count()) === 0);
    const tabKey = opened?.tabKey;
    const emitTo = (event, extra = {}) => page.evaluate(([e, p]) => window.__DBKIT_EMIT__(e, p), [event, { tabKey, ...extra }]);
    const lastState = () => page.evaluate((k) => window.__DBKIT_EMITTED__
      .filter((e) => e.event === "sftp-win-state" && e.payload?.tabKey === k).map((e) => e.payload).at(-1) ?? null, tabKey);

    await emitTo("sftp-win-hello");
    await sleep(200);
    let st = await lastState();
    check("視窗打招呼 → 主視窗推連線狀態", st?.status === "connected" && !!st.connId && st.locked === false && st.initialDir === null, JSON.stringify(st));
    const compose = page.getByTestId("ssh-compose");
    await compose.fill("cd logs");
    await compose.press("Enter");
    await sleep(500);
    st = await lastState();
    check("終端機 cd 之後：新的資料夾推給視窗", /~\/logs/.test(st?.title ?? ""), JSON.stringify(st));
    await emitTo("sftp-win-cd", { path: "/var/log/my app" });
    await sleep(400);
    const writes = await page.evaluate(() => window.__DBKIT_SSH_WRITES__);
    check("視窗的「在終端機 cd 到此」送進 shell（路徑有空白也對）", writes.includes("cd '/var/log/my app'"), JSON.stringify(writes));
    await emitTo("sftp-win-bye");
    await sleep(150);
    check("視窗關掉：SFTP 鈕不再亮", !/text-accent/.test((await winBtn.getAttribute("class")) ?? ""));

    await toggle.click();
    const sftp = page.getByTestId("sftp-panel");
    await sftp.locator('tr[data-name="app.log"]').waitFor({ timeout: 5000 }).catch(() => {});
    // 側邊面板收不到檔案路徑：拖著檔案經過要提示改用獨立視窗，放開也只是提示。
    const dragFile = (type) => sftp.evaluate((el, ty) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "a.txt"));
      el.querySelector("[data-sftp-list]").dispatchEvent(new DragEvent(ty, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, type);
    await dragFile("dragover");
    await sleep(100);
    check("側邊面板拖著檔案經過：提示改用獨立視窗", (await page.getByTestId("sftp-drag-hint").count()) === 1);
    await dragFile("drop");
    await sleep(150);
    check("放開：提示收起、說明怎麼拖放上傳", (await page.getByTestId("sftp-drag-hint").count()) === 0
      && (await page.getByText(/拖放上傳請在 SFTP 獨立視窗裡進行/).count()) > 0);

    await sftp.getByRole("button", { name: "移到獨立視窗（可拖放檔案上傳）" }).click();
    await page.waitForFunction(() => window.__DBKIT_SFTP_WINDOWS__.length > 1, null, { timeout: 5000 }).catch(() => {});
    await sleep(150);
    check("「移到獨立視窗」：開視窗、收起側邊面板", (await windows())[1]?.op === "open" && (await sftp.count()) === 0, JSON.stringify(await windows()));
    await emitTo("sftp-win-hello");
    await sleep(200);
    st = await lastState();
    check("移過去的視窗從面板所在的資料夾開始", st?.initialDir === "/home/deploy/logs", JSON.stringify(st));
    await emitTo("sftp-win-hello");
    await sleep(200);
    check("起始資料夾只帶一次（視窗重新載入就照一般規則）", (await lastState())?.initialDir === null);

    await page.getByRole("button", { name: /^關閉分頁 web-01/ }).first().click();
    await page.waitForFunction((k) => window.__DBKIT_SFTP_WINDOWS__.some((w) => w.op === "close" && w.tabKey === k), tabKey, { timeout: 5000 }).catch(() => {});
    check("關掉終端機分頁：SFTP 視窗跟著收掉", (await windows()).some((w) => w.op === "close" && w.tabKey === tabKey), JSON.stringify(await windows()));
    check("沒有未實作的 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // SFTP 獨立視窗（視窗這一側，直接開 sftp.html）：等主視窗推狀態才開面板、開在終端機所在的資料夾；
  // 系統檔案拖進來（Tauri drag-drop 事件）→ 游標在資料夾那一列就上傳到那個資料夾、否則目前的資料夾，撞名照樣問；
  // 「在終端機 cd 到此」推回主視窗；斷線提示、重新連線後在新連線上重開；鎖定遮罩；有傳輸在跑時關窗先問。
  async "sftp-window-view"(page) {
    const tabKey = "__ssh__:t-win";
    await page.goto(new URL(`sftp.html?tab=${encodeURIComponent(tabKey)}`, page.url()).href, { waitUntil: "domcontentloaded" });
    await page.getByTestId("sftp-window-waiting").waitFor({ timeout: 5000 }).catch(() => {});
    const helloSent = () => page.evaluate((k) => window.__DBKIT_EMITTED__.some((e) => e.event === "sftp-win-hello" && e.payload?.tabKey === k), tabKey);
    await page.waitForFunction((k) => window.__DBKIT_EMITTED__.some((e) => e.event === "sftp-win-hello" && e.payload?.tabKey === k), tabKey, { timeout: 5000 }).catch(() => {});
    check("視窗一開就向主視窗打招呼", await helloSent());
    check("還沒收到狀態：顯示等待中、不開 sftp 通道",
      (await page.getByTestId("sftp-window-waiting").count()) === 1 && (await page.evaluate(() => window.__DBKIT_SFTP_OPENS__.length)) === 0);
    const base = { tabKey, connId: "c-win-1", status: "connected", title: "deploy@web-01: ~", cwd: null, host: "web-01", user: "deploy", startDir: null, initialDir: null, locked: false };
    const state = (p) => page.evaluate((s) => window.__DBKIT_EMIT__("sftp-win-state", s), { ...base, ...p });
    await state({});
    const sftp = page.getByTestId("sftp-panel");
    const row = (n) => sftp.locator(`tr[data-name="${n}"]`);
    await row("backup.tar.gz").waitFor({ timeout: 5000 }).catch(() => {});
    const opens = () => page.evaluate(() => window.__DBKIT_SFTP_OPENS__);
    check("收到狀態：在主視窗的連線上開 sftp、列出家目錄",
      (await row("backup.tar.gz").count()) === 1 && JSON.stringify(await opens()) === JSON.stringify(["c-win-1"]), JSON.stringify(await opens()));
    check("視窗標題帶主機", (await page.title()).includes("deploy@web-01"), await page.title());
    check("狀態列提示可以拖檔案進來", (await page.getByText(/可把檔案或資料夾拖進來上傳/).count()) > 0);

    // 系統拖放：position 是實體像素（headless 的 devicePixelRatio = 1）
    const center = async (loc) => {
      const b = await loc.boundingBox();
      return b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : { x: 0, y: 0 };
    };
    const drag = (event, payload) => page.evaluate(([e, p]) => window.__DBKIT_EMIT__(e, p), [event, payload]);
    const batches = () => page.evaluate(() => window.__DBKIT_SFTP_BATCH__);
    const onLogs = await center(row("logs"));
    await drag("tauri://drag-enter", { paths: ["C:\\tmp\\report.csv"], position: onLogs });
    await drag("tauri://drag-over", { position: onLogs });
    await sleep(150);
    check("拖到資料夾那一列：那一列亮起、提示放進那個資料夾",
      (await row("logs").getAttribute("data-drop")) === "true"
      && (await page.getByTestId("sftp-drop-target").getAttribute("data-dir").catch(() => "")) === "/home/deploy/logs");
    await drag("tauri://drag-drop", { paths: ["C:\\tmp\\report.csv", "C:\\tmp\\photos"], position: onLogs });
    await page.waitForFunction(() => window.__DBKIT_SFTP_BATCH__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const up1 = (await batches())[0];
    check("放在資料夾上：整批上傳到那個資料夾",
      up1?.kind === "upload" && up1.remoteDir === "/home/deploy/logs" && up1.onConflict === "fail"
      && JSON.stringify(up1.locals) === JSON.stringify(["C:\\tmp\\report.csv", "C:\\tmp\\photos"]), JSON.stringify(up1));
    check("放開後拖放提示收起", (await page.getByTestId("sftp-drop-target").count()) === 0);

    const listBox = await sftp.locator("[data-sftp-list]").boundingBox();
    const blank = { x: Math.round(listBox.x + listBox.width / 2), y: Math.round(listBox.y + listBox.height - 12) };
    await drag("tauri://drag-enter", { paths: ["C:\\tmp\\backup.tar.gz"], position: blank });
    await sleep(100);
    check("拖到空白處：目標是目前的資料夾", (await page.getByTestId("sftp-drop-target").getAttribute("data-dir").catch(() => "")) === "/home/deploy");
    await drag("tauri://drag-leave", {});
    await sleep(100);
    check("拖出視窗：提示收起", (await page.getByTestId("sftp-drop-target").count()) === 0);
    await drag("tauri://drag-drop", { paths: ["C:\\tmp\\backup.tar.gz"], position: blank });
    const resumeChoice = page.getByRole("button", { name: "續傳", exact: true }).last();
    await resumeChoice.waitFor({ timeout: 5000 }).catch(() => {});
    check("拖進來的檔案撞名：照樣先問（可選續傳）", (await page.getByText(/遠端已有「backup\.tar\.gz」/).count()) > 0);
    await resumeChoice.click().catch(() => {});
    await page.waitForFunction(() => window.__DBKIT_SFTP_BATCH__.length > 1, null, { timeout: 5000 }).catch(() => {});
    const up2 = (await batches())[1];
    check("選「續傳」→ 上傳到目前的資料夾、帶 resume", up2?.remoteDir === "/home/deploy" && up2.onConflict === "resume", JSON.stringify(up2));

    await row("app").click({ button: "right" });
    await sleep(150);
    await page.locator('div.fixed.z-\\[90\\] button', { hasText: "在終端機 cd 到此" }).first().click();
    await sleep(200);
    check("「在終端機 cd 到此」推回主視窗", await page.evaluate((k) => window.__DBKIT_EMITTED__
      .some((e) => e.event === "sftp-win-cd" && e.payload?.tabKey === k && e.payload.path === "/home/deploy/app"), tabKey));

    await state({ status: "disconnected" });
    await sleep(150);
    check("主視窗斷線：顯示斷線提示", /連線已中斷/.test(await page.getByTestId("sftp-window-banner").innerText().catch(() => "")));
    await state({ connId: "c-win-2", status: "connected" });
    await page.waitForFunction(() => window.__DBKIT_SFTP_OPENS__.length > 1, null, { timeout: 5000 }).catch(() => {});
    check("重新連線（新的連線 id）：提示收起、在新連線上重開 sftp",
      (await page.getByTestId("sftp-window-banner").count()) === 0 && (await opens()).at(-1) === "c-win-2", JSON.stringify(await opens()));

    await state({ connId: "c-win-2", locked: true });
    await sleep(150);
    check("App 鎖定：視窗蓋上遮罩、清單不能操作",
      (await page.getByTestId("sftp-window-locked").count()) === 1 && await sftp.evaluate((el) => !!el.closest("[inert]")));
    await state({ connId: "c-win-2", locked: false });
    await sleep(150);
    check("解鎖：遮罩拿掉", (await page.getByTestId("sftp-window-locked").count()) === 0 && await sftp.evaluate((el) => !el.closest("[inert]")));

    // 有傳輸在跑時關窗：先問；取消就不關，確定才 destroy。
    const destroyed = () => page.evaluate(() => window.__DBKIT_WINDOW_CALLS__.includes("plugin:window|destroy"));
    await page.evaluate(() => { window.__DBKIT_SFTP_SLOW__ = true; });
    await row("logs").waitFor({ timeout: 5000 }).catch(() => {});
    await drag("tauri://drag-drop", { paths: ["C:\\tmp\\big.iso"], position: blank });
    await sftp.locator('[data-testid="sftp-job"][data-state="running"]').first().waitFor({ timeout: 5000 }).catch(() => {});
    await sftp.getByRole("button", { name: "關閉 SFTP", exact: true }).click();
    const ask = page.getByText(/還有 1 個傳輸沒完成/);
    await ask.first().waitFor({ timeout: 5000 }).catch(() => {});
    check("有傳輸在跑：關窗前先問", (await ask.count()) > 0);
    await page.getByRole("button", { name: "取消", exact: true }).last().click().catch(() => {});
    await sleep(200);
    check("按取消：不關窗", !(await destroyed()));
    await sftp.getByRole("button", { name: "關閉 SFTP", exact: true }).click();
    await page.getByRole("button", { name: "關閉視窗", exact: true }).last().click({ timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => window.__DBKIT_WINDOW_CALLS__.includes("plugin:window|destroy"), null, { timeout: 5000 }).catch(() => {});
    check("確定關閉：跟主視窗說再見、銷毀視窗", await destroyed()
      && await page.evaluate((k) => window.__DBKIT_EMITTED__.some((e) => e.event === "sftp-win-bye" && e.payload?.tabKey === k), tabKey));
    check("沒有未實作的 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // 移動：剪下（Ctrl+X）→ 到別的資料夾 Ctrl+V → rename 到那裡；「移動到…」輸入目的資料夾；搬進自己裡面擋下。
  // 斷點續傳：下載傳到一半斷線 → 那一列變成失敗、有「續傳」→ 按下去以 resume 重新開始 → 完成。
  // 上傳遇到遠端同名 → 可選「續傳」。
  async "sftp-move-and-resume"(page) {
    await openSshWeb01(page);
    await page.getByTestId("ssh-sftp-toggle").click();
    const sftp = page.getByTestId("sftp-panel");
    await sftp.getByText("backup.tar.gz", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    const row = (n) => sftp.locator(`tr[data-name="${n}"]`);
    const menuBtn = (text) => page.locator('div.fixed.z-\\[90\\] button', { hasText: text }).first();
    const renames = () => page.evaluate(() => window.__DBKIT_SFTP_RENAMES__);

    await row("logs").dblclick();
    await row("app.log").waitFor({ timeout: 5000 }).catch(() => {});
    await row("app.log").click();
    await page.keyboard.press("Control+x");
    await sleep(150);
    check("Ctrl+X 剪下：狀態列有提示、那一列畫淡",
      /已剪下 1 項/.test(await page.getByTestId("sftp-clip").innerText().catch(() => "")) && /opacity-50/.test((await row("app.log").getAttribute("class")) ?? ""));
    await sftp.getByRole("button", { name: "deploy", exact: true }).click();
    await row("backup.tar.gz").waitFor({ timeout: 5000 }).catch(() => {});
    await row("backup.tar.gz").click();
    await page.keyboard.press("Control+v");
    await page.waitForFunction(() => window.__DBKIT_SFTP_RENAMES__.length > 0, null, { timeout: 5000 }).catch(() => {});
    check("到別的資料夾 Ctrl+V：搬過去",
      JSON.stringify(await renames()) === JSON.stringify([{ from: "/home/deploy/logs/app.log", to: "/home/deploy/app.log" }]), JSON.stringify(await renames()));
    check("貼上後剪下提示消失", (await page.getByTestId("sftp-clip").count()) === 0);

    await row("backup.tar.gz").click({ button: "right" });
    await sleep(150);
    await menuBtn("移動到…").click();
    await page.getByText("把「backup.tar.gz」移到哪個資料夾？").first().waitFor({ timeout: 5000 }).catch(() => {});
    await page.keyboard.press("Control+a");
    await page.keyboard.type("/home/deploy/app");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__DBKIT_SFTP_RENAMES__.length > 1, null, { timeout: 5000 }).catch(() => {});
    check("「移動到…」輸入目的資料夾",
      JSON.stringify((await renames())[1]) === JSON.stringify({ from: "/home/deploy/backup.tar.gz", to: "/home/deploy/app/backup.tar.gz" }), JSON.stringify(await renames()));

    await row("app").click({ button: "right" });
    await sleep(150);
    await menuBtn("移動到…").click();
    await page.getByText("把「app」移到哪個資料夾？").first().waitFor({ timeout: 5000 }).catch(() => {});
    await page.keyboard.press("Control+a");
    await page.keyboard.type("/home/deploy/app/lib");
    await page.keyboard.press("Enter");
    await page.getByText("不能把「app」移到它自己裡面").first().waitFor({ timeout: 5000 }).catch(() => {});
    check("搬進自己裡面：擋下、不送 rename", (await page.getByText("不能把「app」移到它自己裡面").count()) > 0 && (await renames()).length === 2);

    // 斷點續傳
    await page.evaluate(() => { window.__DBKIT_SFTP_FAIL_NEXT__ = 1; });
    await row("backup.tar.gz").click({ button: "right" });
    await sleep(150);
    await menuBtn("下載…").click();
    const failed = sftp.locator('[data-testid="sftp-job"][data-state="error"]');
    await failed.first().waitFor({ timeout: 5000 }).catch(() => {});
    check("傳到一半斷線：那一列標成失敗", (await failed.count()) === 1);
    const resume = failed.getByRole("button", { name: /續傳/ });
    check("失敗的傳輸有「續傳」", (await resume.count()) === 1);
    await resume.click().catch(() => {});
    await page.getByText("已下載 backup.tar.gz").first().waitFor({ timeout: 5000 }).catch(() => {});
    const tr = await page.evaluate(() => window.__DBKIT_SFTP_TRANSFERS__);
    check("「續傳」用同一個來源 / 目的地、帶 resume 重新開始",
      tr.length === 2 && tr[1].remote === "/home/deploy/backup.tar.gz" && tr[1].local === tr[0].local && tr[1].resume === true && tr[0].resume === false,
      JSON.stringify(tr));
    check("續傳完成、失敗的那一列換掉", (await page.getByText("已下載 backup.tar.gz").count()) > 0 && (await failed.count()) === 0);

    // 上傳一個遠端已有的檔 → 可選「續傳」
    await page.evaluate(() => { window.__DBKIT_DIALOG_OPEN__ = ["C:\\tmp\\backup.tar.gz"]; });
    await sftp.getByRole("button", { name: "上傳檔案", exact: true }).first().click();
    const resumeChoice = page.getByRole("button", { name: "續傳", exact: true }).last();
    await resumeChoice.waitFor({ timeout: 5000 }).catch(() => {});
    check("上傳遇到遠端同名：可選「續傳」", (await page.getByText(/遠端已有「backup\.tar\.gz」/).count()) > 0 && (await resumeChoice.count()) > 0);
    await resumeChoice.click().catch(() => {});
    await page.waitForFunction(() => window.__DBKIT_SFTP_BATCH__.length > 0, null, { timeout: 5000 }).catch(() => {});
    const up = (await page.evaluate(() => window.__DBKIT_SFTP_BATCH__))[0];
    check("選「續傳」→ 批次上傳帶 resume", up?.kind === "upload" && up.onConflict === "resume" && up.remoteDir === "/home/deploy", JSON.stringify(up));
    await page.evaluate(() => { delete window.__DBKIT_DIALOG_OPEN__; });
    check("沒有未實作的 command", await page.evaluate(() => window.__DBKIT_UNKNOWN__.length === 0),
      await page.evaluate(() => window.__DBKIT_UNKNOWN__.join(",")));
  },

  // AI 協助（建議模式）：終端機開著時問 AI → 回覆的 bash 區塊有「送到終端機」→ 指令進命令列輸入條、不直接執行；
  // 危險指令（rm -rf）按「執行並回饋」先跳確認框，取消後假 shell 一行都沒收到。AI 本身沒有 shell 工具。
  async "ssh-ai-suggest"(page) {
    await openSshWeb01(page);
    await page.getByRole("button", { name: "AI 助手" }).first().click();
    await sleep(600);
    // 停在終端機上：助手是 SSH 模式，輸入框提示也換成問主機的。
    const input = page.getByPlaceholder(/問這台主機的事/).first();
    check("AI 面板有輸入框", (await input.count()) > 0);
    await input.fill("列出 nginx 狀態");
    await input.press("Enter");
    await page.waitForFunction(() => (document.querySelector("#root")?.innerText ?? "").includes("systemctl status nginx"), null, { timeout: 8000 }).catch(() => {});
    const sendBtn = page.getByRole("button", { name: "送到終端機" });
    check("bash 區塊有「送到終端機」", (await sendBtn.count()) > 0, (await appText(page)).slice(-500));
    if ((await sendBtn.count()) > 0) {
      await sendBtn.first().click();
      await sleep(300);
      const compose = page.getByTestId("ssh-compose");
      const val = await compose.inputValue();
      const writes = await page.evaluate(() => window.__DBKIT_SSH_WRITES__.length);
      check("指令進了命令列輸入條、沒有直接執行", /systemctl status nginx/.test(val) && writes === 0, `compose=${JSON.stringify(val)} writes=${writes}`);
      await compose.fill("");
    }

    await input.fill("幫我刪除 /tmp 的暫存");
    await input.press("Enter");
    await page.waitForFunction(() => (document.querySelector("#root")?.innerText ?? "").includes("rm -rf /tmp/cache"), null, { timeout: 8000 }).catch(() => {});
    const runBtn = page.getByRole("button", { name: "執行並回饋" });
    check("危險 bash 區塊也有「執行並回饋」", (await runBtn.count()) > 0, (await appText(page)).slice(-500));
    if ((await runBtn.count()) > 0) {
      await runBtn.last().click();
      await sleep(500);
      check("危險指令先跳確認框（標出遞迴刪除）", (await page.getByText(/遞迴刪除/).count()) > 0, (await appText(page)).slice(-400));
      const cancel = page.getByRole("button", { name: "取消", exact: true });
      if ((await cancel.count()) > 0) await cancel.last().click();
      await sleep(300);
      check("取消後沒有任何指令送進 shell", await page.evaluate(() => window.__DBKIT_SSH_WRITES__.length === 0));
    }
  },

  // 結構快取徽章：MySQL 查詢分頁要顯示快取時間並可點；Kafka 這種沒有欄位結構的連線不該出現。
  // 徽章是「自動完成用的是哪個時間點的結構」的唯一告知處，消失了使用者就只能盲信提示。
  async "schema-cache-badge"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(900);
    const badge = page.getByRole("button", { name: /^結構/ });
    const shown = (await badge.count()) > 0;
    check("MySQL 查詢分頁顯示結構快取徽章", shown, shown ? "" : await appText(page));
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

  // 收藏下拉：面板要完整露出，不能被祖先的 overflow-hidden 裁掉（issue #2）。
  // 分裂鈕用 overflow-hidden 讓左右兩半共用一組圓角；定位若掛在同一個 div，
  // 下拉會連著被裁成按鈕大小的一條縫。DOM 與文字都還在，只有量「可見範圍」才驗得出來。
  async "saved-queries-dropdown-not-clipped"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(900);

    await page.getByRole("button", { name: "收藏的查詢", exact: true }).first().click();
    await sleep(300);
    const panel = page.locator('div[class~="absolute"][class~="z-[90]"]').filter({ hasText: "管理 / 匯入匯出" }).first();
    check("收藏下拉會開啟", (await panel.count()) > 0);
    if ((await panel.count()) === 0) return;

    // 面板自身的盒子一定是 420×N —— 被裁的是「畫得出來」的部分，
    // 所以往上逐層與會裁切的祖先取交集，量真正看得到的範圍。
    const vis = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (!/visible/.test(cs.overflowX + " " + cs.overflowY)) {
          const pr = p.getBoundingClientRect();
          box = { l: Math.max(box.l, pr.left), t: Math.max(box.t, pr.top),
                  r: Math.min(box.r, pr.right), b: Math.min(box.b, pr.bottom) };
        }
      }
      return { w: Math.round(r.width), h: Math.round(r.height),
               visW: Math.round(Math.max(0, box.r - box.l)), visH: Math.round(Math.max(0, box.b - box.t)) };
    });
    check("收藏下拉沒被裁掉寬度", vis.visW >= vis.w - 1, `面板 ${vis.w}px，看得到 ${vis.visW}px`);
    check("收藏下拉沒被裁掉高度", vis.visH >= vis.h - 1, `面板 ${vis.h}px，看得到 ${vis.visH}px`);
    check("收藏下拉列出收藏的查詢",
      (await panel.getByText("每日營收", { exact: true }).count()) > 0,
      (await panel.innerText()).replace(/\s+/g, " ").slice(0, 160));
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
    const body = await appText(page);
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
    const body = await appText(page);
    check("關光查詢分頁後顯示空狀態", body.includes("已關閉所有查詢分頁"), body.slice(0, 120));
    await page.getByRole("button", { name: /新增查詢分頁/ }).first().click();
    await sleep(500);
    check("按「+」後回到查詢分頁", !(await appText(page)).includes("已關閉所有查詢分頁"));
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

  // 查詢分頁的「審查」分頁：規則引擎在打字當下就要列出發現，點擊可跳到編輯器對應位置。
  // 這條驗的是 glue（分頁存在 / 徽章 / 面板內容 / AI 入口），規則本身由 sqlLint.test.ts 覆蓋。
  async "sql-review-tab"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(900);

    // 一段刻意寫壞的 SQL：無 WHERE 的 UPDATE（error）+ 前綴萬用字元 LIKE（warn）。
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("UPDATE orders SET status = 'x';\nSELECT * FROM orders WHERE note LIKE '%abc%';");
    await sleep(700);

    // 下方分頁鈕的名稱是「審查」後面可能接徽章（數字 / ●）；工具列的「審查並執行」同樣以「審查」開頭，要排除。
    const tab = page.getByRole("button", { name: /^審查(?!並執行)/ });
    check("查詢分頁有「審查」分頁", (await tab.count()) > 0);
    await tab.first().click();
    await sleep(500);

    const body = await appText(page);
    check("審查列出無 WHERE 的 UPDATE（error）", body.includes("沒有 WHERE 條件"), body.slice(0, 400));
    check("審查列出前綴萬用字元 LIKE（warn）", body.includes("萬用字元開頭"));
    check("審查顯示規則代號", body.includes("no-where-dml"));
    check("審查面板有「DBA 審查」入口", (await page.getByRole("button", { name: "DBA 審查", exact: true }).count()) > 0);
    check("審查面板列出 DBA 人設", body.includes("資深 DBA") && body.includes("正式環境守門員"));
    check("審查面板標明規則引擎的侷限", body.includes("規則引擎只檢查寫法樣式"));

    // 點一筆 finding 應在編輯器選取對應範圍（不丟例外、選取非空）。
    await page.getByText("沒有 WHERE 條件", { exact: false }).first().click();
    await sleep(300);
    const sel = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    check("點擊 finding 會在編輯器選取該段", sel.length > 0, `selection=${JSON.stringify(sel)}`);

    // 清空 SQL → 應回到空狀態而非「沒有發現問題」（兩者語意不同）。
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await sleep(600);
    check("清空後顯示空狀態", (await appText(page)).includes("尚無可審查的 SQL"));
  },

  // 側欄連線滿出頁面時，最後一筆必須滾得到（回歸：外殼曾經同時是 column flex 與捲動容器，
  // 子項被 flex-shrink 壓縮後捲動高度算不出來，最底下幾筆永遠碰不到）。
  // 側欄分組一致：資料庫依種類分區、SSH 主機、遠端桌面三區用同一套群組行為
  //（區塊標題新增群組 + inline 命名、右鍵移到群組、拖曳排序 / 換群組 / 群組換位、刪群組先確認、搜尋時群組展開）。
  // 舊版沒有 kind 的跨種類群組要依成員種類拆開並落地。
  async "sidebar-grouping-consistent"(page) {
    const kinds = [...new Set(GROUPING_CONNECTIONS.map((c) => c.kind))];
    const kindSections = page.locator("[data-conn-kind]");
    check("資料庫連線依種類各一區", (await kindSections.count()) === kinds.length, `${await kindSections.count()} vs ${kinds.length}`);
    const pg = page.locator('[data-conn-kind="postgres"]');
    const my = page.locator('[data-conn-kind="mysql"]');
    const ssh = page.locator("[data-ssh-host-tree]");
    const rd = page.locator("[data-rd-host-tree]");
    const headerOf = (section) => section.locator(":scope > div").first();
    // 區塊標題是 CSS uppercase，innerText 會變大寫。
    check("種類區塊標題帶數量", /postgresql \(2\)/i.test(await headerOf(pg).innerText()), await headerOf(pg).innerText());

    await sleep(300);
    const layout = await page.evaluate(() => window.__DBKIT_CONN_LAYOUT__);
    const legacy = (layout?.groups ?? []).filter((g) => g.name === "正式環境");
    check("舊的跨種類群組依成員種類拆開並落地",
      legacy.length === 2 && new Set(legacy.map((g) => g.kind)).size === 2 && legacy.every((g) => g.kind),
      JSON.stringify(layout?.groups ?? null));
    check("拆開後分別出現在 MySQL / PostgreSQL 區塊",
      (await my.locator("[data-group-row]", { hasText: "正式環境" }).count()) === 1
      && (await pg.locator("[data-group-row]", { hasText: "正式環境" }).count()) === 1);

    const groupOf = (loc) => loc.evaluate((el) => el.closest("[data-group-section]")?.getAttribute("data-group-section") ?? null);
    const newGroup = async (section, name) => {
      await headerOf(section).hover();
      await headerOf(section).getByRole("button", { name: "新增群組", exact: true }).click();
      const input = section.getByLabel("群組名稱", { exact: true });
      if (!(await input.count())) return null;
      await input.fill(name);
      await input.press("Enter");
      await sleep(200);
      const row = section.locator("[data-group-row]", { hasText: name });
      return (await row.count()) === 1 ? row.getAttribute("data-group-row") : null;
    };
    const moveViaMenu = async (item, name) => {
      await item.click({ button: "right" });
      const btn = page.getByRole("button", { name: `移到「${name}」`, exact: true });
      if (!(await btn.count())) return false;
      await btn.click();
      await sleep(200);
      return true;
    };

    // HTML5 拖曳：按下 → 在目標上移兩次（第一次 dragover 可能早於 React 把拖曳狀態畫上去）→ 放開。
    const dragOnto = async (src, dst, position) => {
      await src.hover();
      await page.mouse.down();
      await dst.hover({ position });
      await sleep(50);
      await dst.hover({ position });
      await page.mouse.up();
      await sleep(250);
    };
    const items = {
      pg: pg.getByText("local-pg", { exact: true }),
      ssh: ssh.locator('[data-ssh-host="ssh-bastion"]'),
      rd: rd.locator('[data-rd-host="rd-mac"]'),
    };
    const gids = {};
    for (const [key, label, section] of [["pg", "資料庫（PostgreSQL）", pg], ["ssh", "SSH 主機", ssh], ["rd", "遠端桌面", rd]]) {
      const gid = await newGroup(section, "QA");
      gids[key] = gid;
      check(`${label}：區塊標題「新增群組」→ 直接輸入名稱建立群組`, !!gid);
      if (!gid) continue;
      const moved = await moveViaMenu(items[key], "QA");
      check(`${label}：右鍵有「移到「QA」」`, moved);
      check(`${label}：移到群組後出現在該群組底下`, (await groupOf(items[key])) === gid, String(await groupOf(items[key])));
    }

    // 拖曳：SSH 主機拖到另一台的上半部 → 進同一個群組、排在它前面。
    const web = ssh.locator('[data-ssh-host="ssh-web01"]');
    await dragOnto(items.ssh, web, { x: 30, y: 3 });
    const prodIds = await ssh.locator('[data-group-section="sf-prod"] [data-ssh-host]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-ssh-host")));
    check("拖曳：主機拖到另一台上方 → 進同一群組、排在它前面", JSON.stringify(prodIds) === JSON.stringify(["ssh-bastion", "ssh-web01"]), JSON.stringify(prodIds));

    // 拖曳：連線拖到種類區塊標題 → 移出群組。
    const pm = my.getByText("prod-mysql", { exact: true });
    await dragOnto(pm, headerOf(my), { x: 60, y: 8 });
    check("拖曳：連線拖到區塊標題上 → 移出群組", (await groupOf(pm)) === "", String(await groupOf(pm)));

    // 拖曳群組列：QA 拖到「正式環境」上方 → 群組換位。
    if (gids.pg) {
      const legacyRow = pg.locator("[data-group-row]", { hasText: "正式環境" });
      await dragOnto(pg.locator(`[data-group-row="${gids.pg}"]`), legacyRow, { x: 30, y: 2 });
      const order = await pg.locator("[data-group-row]").evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ""));
      check("拖曳群組列 → 群組換位", order.length === 2 && order[0].startsWith("QA"), JSON.stringify(order));
    }

    // 刪有成員的群組：先確認，成員回到未分組。
    if (gids.rd) {
      const row = rd.locator(`[data-group-row="${gids.rd}"]`);
      await row.hover();
      await row.getByRole("button", { name: "刪除群組", exact: true }).click();
      // uiConfirm 的確認框不在 Modal 堆疊裡（沒有 role="dialog"），用訊息文字找它所在的那一層。
      const msg = page.getByText(/群組「QA」底下還有 1 個項目/);
      await msg.first().waitFor({ timeout: 3000 }).catch(() => {});
      check("刪除有成員的群組會先確認", (await msg.count()) > 0);
      const dlg = page.locator("div").filter({ has: msg }).filter({ has: page.getByRole("button", { name: "刪除群組", exact: true }) }).last();
      await dlg.getByRole("button", { name: "刪除群組", exact: true }).click();
      await sleep(250);
      check("刪除群組後成員回到未分組", (await rd.locator("[data-group-row]", { hasText: "QA" }).count()) === 0 && (await groupOf(items.rd)) === "");
    }

    // 搜尋時摺起來的群組照樣展開。
    await ssh.locator('[data-group-row="sf-prod"]').click();
    await sleep(150);
    check("點群組列 → 摺疊", (await web.count()) === 0);
    await page.getByPlaceholder("搜尋連線 / 表…").fill("web-01");
    await sleep(250);
    check("搜尋時摺起來的群組照樣展開", (await web.count()) === 1);
    await page.getByPlaceholder("搜尋連線 / 表…").fill("");
  },

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

    // 畫面上最後一筆連線（側欄依種類分區，所以不是 fixture 陣列的最後一筆）捲到底後必須完整落在捲動視窗內。
    const lastName = await box.evaluate((el) => {
      const sections = el.querySelectorAll("[data-conn-kind]");
      const rows = sections[sections.length - 1]?.querySelectorAll("[draggable=\"true\"]:not([data-group-row])") ?? [];
      return rows[rows.length - 1]?.querySelector("span.truncate")?.textContent ?? "";
    });
    check("捲到底後找得到畫面上最後一筆連線", lastName !== "" && caseFx.CONNECTIONS.some((c) => c.name === lastName), lastName);
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

  // 大結果集列虛擬化：2 萬列全部捲得到，但 DOM 只放可視範圍；鍵盤 Ctrl+End 跳到最後一格也要捲過去。
  async "result-grid-virtualized"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await page.waitForSelector(".cm-content", { timeout: 8000 });
    await page.locator(".cm-content").first().click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("SELECT * FROM big_rows");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => document.body.innerText.includes("row-1"), null, { timeout: 10_000 }).catch(() => {});
    const domRows = await page.evaluate(() => {
      const tb = [...document.querySelectorAll("tbody.mono")].find((b) => b.textContent?.includes("row-1"));
      return tb ? tb.querySelectorAll("tr").length : -1;
    });
    check("2 萬列結果只渲染可視範圍的列", domRows > 0 && domRows < 300, `dom rows=${domRows}`);
    check("不再出現「僅渲染前 N 列」截斷提示", !(await appText(page)).includes("僅渲染前"));
    // 點第一格後 Ctrl+End → 最後一列最後一格，必須被捲進來（虛擬化前它根本不存在於 DOM）。
    // 點儲存格會開檢視窗（開窗後 300ms 內不收關閉），等一下再 Esc 關掉，焦點回到結果格。
    await page.getByText("row-1", { exact: true }).first().click();
    await sleep(500);
    await page.keyboard.press("Escape");
    await sleep(300);
    await page.keyboard.press("Control+End");
    await page.waitForFunction(() => document.body.innerText.includes("row-20000"), null, { timeout: 5000 }).catch(() => {});
    const dbg = await page.evaluate(() => {
      const a = document.activeElement;
      const tb = [...document.querySelectorAll("tbody.mono")].find((b) => b.querySelector("td"));
      let p = tb?.parentElement; while (p && !/auto|scroll/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
      return `active=${a?.tagName}.${a?.className?.toString().slice(0, 40)} scroller=${p?.className?.toString().slice(0, 40)} st=${p?.scrollTop} sh=${p?.scrollHeight} ch=${p?.clientHeight}`;
    });
    check("Ctrl+End 捲到第 20000 列", (await appText(page)).includes("row-20000"), dbg);
  },

  // 影響列預覽：更多 → 預覽影響列… 只列出會被改到的列，不執行；可一鍵轉交審查並執行。
  async "dml-preview"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await page.waitForSelector(".cm-content", { timeout: 8000 });
    await page.locator(".cm-content").first().click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("UPDATE orders SET status = 'shipped' WHERE order_id IN (1001, 1002)");
    await page.locator('button[title*="更多工具"]').first().click();
    await sleep(300);
    const item = page.locator('[data-testid="dml-preview-open"]');
    check("更多選單有「預覽影響列…」", (await item.count()) === 1);
    await item.click();
    await page.locator("[data-dml-preview-stmt]").first().waitFor({ timeout: 8000 }).catch(() => {});
    const body = await appText(page);
    check("列出影響列數", (await page.locator("[data-dml-preview-count]").first().innerText()).includes("2"), body.replace(/\s+/g, " ").slice(0, 200));
    check("列出會被改到的列", body.includes("1001") && body.includes("1002"));
    check("讀取語句不列出", (await page.locator("[data-dml-preview-stmt]").count()) === 1);
    await page.getByRole("button", { name: "審查並執行…", exact: true }).click();
    await sleep(800);
    check("轉交審查並執行後預覽關閉", (await page.locator("[data-dml-preview-stmt]").count()) === 0);
  },

  // 執行 SQL 檔：資料庫右鍵 → 選檔 → 執行；遇錯即停時列出錯誤行號與沒執行到的句數。
  async "sql-file-run"(page) {
    // 唯讀連線：選單照樣有（與其他寫入項目一致），但對話框說明原因、執行鈕停用。
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("shop", { exact: true }).nth(1).click({ button: "right" });
    await sleep(300);
    const items = await menuItems(page);
    check("資料庫右鍵：執行 SQL 檔…", items.some((i) => i.includes("執行 SQL 檔")), items.join(" | "));
    await page.getByText("執行 SQL 檔…", { exact: true }).click();
    await page.locator("[data-sql-file-pick]").waitFor({ timeout: 8000 });
    check("唯讀連線說明不能執行", (await appText(page)).includes("此連線為唯讀模式"));
    check("未選檔時執行鈕停用", await page.locator("[data-sql-file-run]").isDisabled());
    await page.keyboard.press("Escape");
    await sleep(400);

    await page.getByText("analytics-pg", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("warehouse", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    await page.getByText("執行 SQL 檔…", { exact: true }).click();
    await page.locator("[data-sql-file-pick]").waitFor({ timeout: 8000 });
    await page.evaluate(() => { window.__DBKIT_DIALOG_OPEN__ = "C:\\work\\migrate_v2.sql"; });
    await page.locator("[data-sql-file-pick]").click();
    await sleep(300);
    check("顯示選到的檔名", (await page.locator("[data-sql-file-path]").innerText()).includes("migrate_v2.sql"));
    await page.locator("[data-sql-file-run]").click();
    await page.locator("[data-sql-file-report]").waitFor({ timeout: 8000 }).catch(() => {});
    const body = await appText(page);
    check("報告列出成功 / 失敗", body.includes("成功 6") && body.includes("失敗 1"), body.replace(/\s+/g, " ").slice(0, 240));
    check("錯誤帶行號", body.includes("第 18 行"));
    check("遇錯即停時說明沒執行到的句數", body.includes("沒有執行到的語句：5 句"));
  },

  // 查詢工具列的三階自適應：寬 → 圖示+文字；中 → 次要鈕只留圖示；窄 → 無下拉的次要鈕折進「更多」。
  // 重點是「絕不裁掉按鈕」：曾經用 justify-end + overflow-hidden 量測，放不下時溢位往左擠，
  // 最左邊的新查詢 / 歷史 / 收藏星星會被裁到看不見也點不到。
  async "query-toolbar-adapts-to-width"(page) {
    // 門檻是在「右側詳細資料展開」的版面下量的；詳細資料改成預設收合後 1000px 的查詢區多出約 260px、
    // 就不夠窄了。這裡先展開它，照原本的版面驗自適應本身（不是驗面板預設值）。
    await page.getByRole("button", { name: "顯示詳細資料面板", exact: true }).click().catch(() => {});
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(600);

    const fmt = page.locator('button[title*="格式化 SQL"]');
    const star = page.locator('button[title*="一鍵收藏目前查詢"], button[title*="已收藏為"]');
    // 寬度門檻刻意訂得寬鬆：查詢面板還要跟側欄、右側詳細資料分寬度，1280 的視窗實際只留給
    // 工具列 ~340px（量過），所以「完整標籤」得在很寬的視窗才看得到。
    //
    // 2026-09-16 由 1920 上調到 2200：AI 那組按鈕進了工具列之後實測（1440 / 1600 / 1920 /
    // 2200 / 2560）門檻整個往上移 —— 1440 與 1600 連格式化鈕都折進「更多」，1920 只剩圖示，
    // 要到 2200 才看得到文字。本案驗的是「三階自適應會動」，不是某個像素值，所以改門檻而不是
    // 改元件；但這代表**一般 1920 螢幕上的查詢工具列已經是純圖示**，工具列是否過擠值得回頭看。
    await page.setViewportSize({ width: 2200, height: 900 });
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

    // 拉回寬版要還原（遲滯不能把它永久卡在降階狀態）。門檻同上，2026-09-16 起是 2200。
    await page.setViewportSize({ width: 2200, height: 900 });
    await sleep(900);
    check(
      "拉回寬版：格式化鈕回到主列且帶文字",
      (await page.locator('button[title*="格式化 SQL"]').first().innerText()).includes("格式化"),
    );
  },

  // 全域介面字級：設定裡改一次，整份 rem 基準（<html> 的 font-size）跟著變，
  // 連 text-[11px] 這種任意值小標籤也一起放大（靠 styles.css 的 rem 覆寫，見該檔註解）。
  // 這是最容易默默失效的一環：Tailwind 會把任意值編成固定 px，只要覆寫沒生效或被
  // utilities 蓋回去，畫面就是「大字配一排小到看不清的標籤」，而且不會有任何錯誤。
  async "ui-font-size-global"(page) {
    const rootPx = () =>
      page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const tinyPx = () =>
      page.evaluate(() => {
        const el = [...document.querySelectorAll("*")].find((e) => e.classList.contains("text-[11px]"));
        return el ? parseFloat(getComputedStyle(el).fontSize) : null;
      });
    const codeVar = () =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--code-font-size").trim());

    check("預設介面字級 16px（未設定過的使用者外觀不變）", (await rootPx()) === 16);
    check("預設下 text-[11px] 仍是 11px", (await tinyPx()) === 11);

    await page.locator('button[title="設定"]').first().click();
    await sleep(600);
    const picker = page.locator('select:has(option:text-is("標準（預設）"))');
    check("設定對話框有介面字級下拉", (await picker.count()) > 0);

    await picker.selectOption("20");
    await sleep(400);
    check("選「特大」後 rem 基準變 20px", (await rootPx()) === 20, String(await rootPx()));
    // 11 / 16 × 20 = 13.75：任意值小標籤有跟著等比長大，不是停在 11px。
    check("text-[11px] 等比放大到 13.75px", Math.abs((await tinyPx()) - 13.75) < 0.05, String(await tinyPx()));
    check("程式碼字級不受介面字級影響（仍 13px）", (await codeVar()) === "13px", await codeVar());
    check(
      "偏好寫進 localStorage（下次啟動可還原）",
      (await page.evaluate(() => localStorage.getItem("dbkit:uiFontSize"))) === "20",
    );

    await picker.selectOption("16");
    await sleep(400);
    check("選回「標準（預設）」即還原 16px", (await rootPx()) === 16);
    check("還原後 text-[11px] 回到 11px", (await tinyPx()) === 11);
  },

  // AI 助手多對話（issue #4）：以前整個助手只有一串，換個庫接著問就串了庫，想乾淨開始只能「清空」——
  // 而清空是不可逆的。這裡驗的是使用者實際的動線：既有的幾串讀得回來、切換不丟訊息、開新的一串
  // 不會吃掉舊的、刪掉作用中的那串會接手下一串。
  async "assistant-conversations"(page) {
    // 先種兩串既有對話再重載：這同時驗了 chatSessions.loadArchive 真的讀得回落地的存檔。
    // 兩串刻意用不同供應商（claude / codex）：供應商是全域單一設定，切對話時若不跟著切，
    // 另一串的 session id 就會因為「供應商對不上」被丟掉，每次切回去都得重講一遍。
    await page.evaluate(() => {
      const mk = (id, title, text, at, provider, sid) => ({
        id, title, agentSessionId: sid, agentProvider: provider,
        connId: null, connName: "prod-mysql", createdAt: at, updatedAt: at,
        messages: [{ id: `${id}-m`, role: "user", text, tools: [], pending: false, error: false }],
      });
      localStorage.setItem("db-kit:assistantSessions", JSON.stringify({
        conversations: [
          mk("c1", "", "訂單表有哪些欄位？", 1, "claude", "sess-claude-1"),
          mk("c2", "庫存盤點", "庫存怎麼算", 2, "codex", "thread-codex-2"),
        ],
        activeId: "c1",
      }));
      localStorage.setItem("db-kit:aiProvider", "claude"); // 純字串，不是 JSON（見 aiProvider.readProvider）
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root");
    await sleep(1200);

    await page.getByRole("button", { name: "AI 助手" }).first().click();
    await sleep(600);
    check("助手面板開啟並顯示作用中那串的訊息", await page.getByText("訂單表有哪些欄位？").first().isVisible());

    const listBtn = page.getByRole("button", { name: /^對話清單/ });
    check("標題列有對話清單入口", (await listBtn.count()) > 0);
    await listBtn.first().click();
    await sleep(400);
    // 沒取過名的那串從第一則使用者訊息推導標題；取過名的用使用者給的名字。
    check("清單列出未命名那串（標題取自第一則提問）", (await page.getByText("訂單表有哪些欄位？").count()) >= 2);
    check("清單列出已命名那串", await page.getByText("庫存盤點", { exact: true }).first().isVisible());

    // 清單要標出每串是哪個供應商 —— 切過去模型換了，沒標的話無從得知。
    const listText = await appText(page);
    check("清單標出各串的供應商", /Claude Code/.test(listText) && /OpenAI Codex/.test(listText),
      listText.slice(0, 200));

    const providerSel = page.locator("select").filter({ hasText: "OpenAI Codex" }).first();
    check("目前供應商是 Claude", (await providerSel.inputValue()) === "claude");

    await page.getByText("庫存盤點", { exact: true }).first().click();
    await sleep(600);
    check("切換過去看得到那串的歷史", await page.getByText("庫存怎麼算").first().isVisible());
    check("切換後不再顯示前一串的訊息", (await page.getByText("訂單表有哪些欄位？").count()) === 0);
    // 這串是 Codex 開的 → 供應商選擇器要跟著切過去，否則它的 thread 接不回來。
    check("供應商跟著對話切到 Codex", (await providerSel.inputValue()) === "codex");
    check("Codex 那串的 session id 沒被丟掉", await page.evaluate(() => {
      const a = JSON.parse(localStorage.getItem("db-kit:assistantSessions"));
      return a.conversations.find((c) => c.id === "c2")?.agentSessionId === "thread-codex-2";
    }));

    // 切回去：歷史必須還在（這正是「清空」做不到、而 issue #4 要的東西）。
    await listBtn.first().click();
    await sleep(400);
    await page.getByText("訂單表有哪些欄位？").first().click();
    await sleep(600);
    check("切回來歷史仍在", await page.getByText("訂單表有哪些欄位？").first().isVisible());
    check("供應商跟著切回 Claude", (await providerSel.inputValue()) === "claude");
    check("切回來後 Claude 那串的 session id 仍在", await page.evaluate(() => {
      const a = JSON.parse(localStorage.getItem("db-kit:assistantSessions"));
      return a.conversations.find((c) => c.id === "c1")?.agentSessionId === "sess-claude-1";
    }));

    await page.getByRole("button", { name: /^開新對話/ }).first().click();
    await sleep(500);
    check("開新對話後是空白對話", (await page.getByText("庫存怎麼算").count()) === 0);
    await listBtn.first().click();
    await sleep(400);
    check("開新對話不吃掉舊的兩串", (await page.getByText("庫存盤點", { exact: true }).count()) >= 1);
    check("清單計數跟著長到 3", /對話清單（3）/.test(await listBtn.first().getAttribute("title")));

    // 刪掉作用中的空白那串 → 接手清單上的下一串，而不是留下指不到的 activeId（會整頁白掉）。
    await page.getByRole("button", { name: "刪除對話" }).first().click();
    await sleep(600);
    const stillThere = await appText(page);
    check("刪除作用中那串後面板仍可用", stillThere.includes("AI 助手"));
    check("刪除後落地存檔剩兩串", await page.evaluate(() =>
      JSON.parse(localStorage.getItem("db-kit:assistantSessions")).conversations.length === 2));
  },

  // 結構比對（v0.30）：資料表右鍵與資料庫右鍵都要有入口；兩個對話框都能開、單表能比出結果，
  // 且整段沒有前端例外——shim 少一個 command 就是 pageerror，這裡會抓到。
  // 審查並執行：查詢分頁工具列開對話框 → 分析結果（回滾等級 / 注意事項）→ AI 審查串流帶出結論徽章 →
  // 唯讀連線只能「只產生備份」→ 產生後切到結果分頁、列出輸出檔案。
  // ---- 預存程序整合測試 ----
  async "sp-test-dialog"(page) {
    // 對話框讀 localStorage 的偏好決定資料夾；shim 的 sp_test_load_dir 回 fixture，先把資料夾塞好。
    await page.evaluate(() => localStorage.setItem("dbkit.sptest.prefs", JSON.stringify({ dir: "C:/sptests", mode: "assert", goldenDir: "" })));
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("shop", { exact: true }).nth(1).click({ button: "right" });
    await sleep(300);
    const items = await menuItems(page);
    check("資料庫右鍵：預存程序整合測試…", items.some((i) => i.includes("預存程序整合測試")), items.join(" | "));
    await page.getByText("預存程序整合測試…", { exact: true }).click();
    await sleep(900);
    check("對話框列出資料夾裡的測試檔", (await page.locator('[data-testid="sp-test-file"]').count()) === 1);
    check("編輯器載入測試檔內容", ((await page.locator('[data-testid="sp-test-editor"]').inputValue()).includes("place_then_cancel")));
    check("沒有從程序開啟時不能 AI 產生情境", !(await page.locator('[data-testid="sp-test-generate"]').isEnabled()));
    await page.locator('[data-testid="sp-test-run"]').click();
    await page.waitForFunction(() => document.body.innerText.includes("qty_cases / zero"), null, { timeout: 8000 }).catch(() => {});
    const body = await appText(page);
    check("結果列出每個展開後的情境", body.includes("place_then_cancel") && body.includes("qty_cases / two") && body.includes("qty_cases / zero"), body.replace(/\s+/g, " ").slice(0, 300));
    check("失敗的情境標為失敗", body.includes("失敗"));
    await page.getByText("qty_cases / zero", { exact: false }).first().click();
    await sleep(300);
    const after = await appText(page);
    check("展開失敗情境顯示差異（類型 / 期望 / 實際）", after.includes("error_class") && after.includes("user_raised") && after.includes("Division by 0"), after.replace(/\s+/g, " ").slice(0, 300));

    // v0.56：說明面板、摘要列、逐步輸出、採用實際值、只重跑單一情境、插入範例、CLI 指令
    check("說明面板預設展開（三步上手 + CLI 指令）", await page.locator('[data-testid="sp-test-help"]').isVisible());
    const cli = await page.locator('[data-testid="sp-test-cli"]').innerText();
    check("說明面板的 CLI 指令對應目前設定", cli.startsWith("dbk sp-test run ") && cli.includes("--conn prod-mysql") && cli.includes("-d shop") && cli.includes("usp_place_order.json"), cli);
    const summary = await page.locator('[data-testid="sp-test-summary"]').innerText();
    check("摘要列依判定計數（失敗 1、通過 2）", summary.includes("失敗 1") && summary.includes("通過 2"), summary);
    check("失敗情境的步驟清單：fixture 步驟標來源、call 有實際輸出摘要",
      (await page.locator('[data-sp-scenario="qty_cases/zero"] [data-sp-step="#1 insert"]').innerText()).includes("[base] customers")
      && (await page.locator('[data-sp-scenario="qty_cases/zero"] [data-sp-step="#3 call"]').innerText()).includes("divide_by_zero"));
    check("cases 展開的情境不提供採用實際值（會蓋掉 <<qty 之類的變數）", (await page.locator('[data-sp-scenario="qty_cases/zero"] [data-sp-adopt]').count()) === 0);
    await page.locator('[data-testid="sp-test-only-failed"]').check();
    await sleep(200);
    check("只看未通過：通過的情境藏起來", (await page.locator('[data-sp-scenario="place_then_cancel"]').count()) === 0 && (await page.locator('[data-sp-scenario="qty_cases/zero"]').count()) === 1);
    await page.locator('[data-testid="sp-test-only-failed"]').uncheck();
    await sleep(200);
    await page.locator('[data-sp-scenario="place_then_cancel"] button').first().click();
    await sleep(300);
    const placeRow = await page.locator('[data-sp-scenario="place_then_cancel"] [data-sp-step="#3 call"]').innerText();
    check("call 步驟摘要：程序名、副作用（orders +1、products ~1）", placeRow.includes("orders +1") && placeRow.includes("products ~1") && placeRow.includes("usp_place_order"), placeRow);
    await page.locator('[data-sp-scenario="place_then_cancel"] [data-sp-step="#3 call"] > div').first().click();
    await sleep(300);
    const detail = await page.locator('[data-sp-scenario="place_then_cancel"] [data-sp-step-detail="#3 call"]').innerText();
    check("點步驟展開實際輸出：結果集表格與副作用前後像", detail.includes("order_id") && detail.includes("516") && detail.includes("副作用 products") && detail.includes("前") && detail.includes("後"), detail.slice(0, 200));
    check("預期中的錯誤步驟顯示錯誤類別", (await page.locator('[data-sp-scenario="place_then_cancel"] [data-sp-step="#6 call"]').innerText()).includes("user_raised"));
    check("fixture 步驟沒有採用實際值", (await page.locator('[data-sp-scenario="place_then_cancel"] [data-sp-adopt="#1 insert"]').count()) === 0);
    await page.locator('[data-sp-scenario="place_then_cancel"] [data-sp-adopt="#3 call"]').click();
    await sleep(300);
    await page.getByText("測試檔", { exact: true }).first().click();
    await sleep(300);
    const adopted = JSON.parse(await page.locator('[data-testid="sp-test-editor"]').inputValue());
    const placeStep = adopted.scenarios[0].steps[0];
    check("採用實際值：result_sets 換回符號、遮罩欄略過、副作用寫成數量",
      JSON.stringify(placeStep.expect) === JSON.stringify({ result_sets: [{ rows: [{ order_id: "<<oid", qty: 2, total: "25.00", status: "NEW" }] }], effects: { orders: { inserted: 1 }, products: { updated: 1 } } }),
      JSON.stringify(placeStep.expect));
    await page.locator('[data-testid="sp-test-recipes"]').click();
    await sleep(200);
    check("插入範例選單列出 8 種", (await page.locator("[data-sp-recipe]").count()) === 8);
    await page.locator('[data-sp-recipe="error"]').click();
    await sleep(300);
    const withRecipe = JSON.parse(await page.locator('[data-testid="sp-test-editor"]').inputValue());
    const ins = withRecipe.scenarios.at(-1);
    check("插入範例：情境接在最後、用既有 fixture、程序名取檔案的 routine",
      ins.id === "rejects_bad_input" && ins.use[0] === "base" && ins.steps[0].call === "usp_place_order" && ins.steps[0].expect_error.class === "user_raised", JSON.stringify(ins));
    await page.getByRole("radio", { name: "結果", exact: true }).last().click();
    await sleep(200);
    await page.locator('[data-sp-rerun="qty_cases/zero"]').click();
    await page.waitForFunction(() => (window.__DBKIT_SPTEST_RUNS__ ?? []).length >= 2, null, { timeout: 5000 }).catch(() => {});
    await sleep(400);
    const runs = await page.evaluate(() => window.__DBKIT_SPTEST_RUNS__);
    check("只重跑單一情境：送出 only = id/case", JSON.stringify(runs.at(-1).only) === JSON.stringify(["qty_cases/zero"]), JSON.stringify(runs));
    const summary2 = await page.locator('[data-testid="sp-test-summary"]').innerText();
    check("重跑結果併回原報表（3 個情境都在、失敗歸零）", summary2.includes("通過 3") && !summary2.includes("失敗"), summary2);
    await page.locator('[data-testid="sp-test-help-toggle"]').click();
    await sleep(200);
    check("說明面板可收合", (await page.locator('[data-testid="sp-test-help"]').count()) === 0);
    await page.locator('[data-testid="sp-test-help-toggle"]').click();
    await page.keyboard.press("Escape");
    await sleep(300);
  },

  // 從程序右鍵開：「新檔」走後端盤點產生骨架（前置資料、參數、錯誤分支情境），AI 產生情境可用。
  async "sp-test-from-routine"(page) {
    await page.evaluate(() => localStorage.setItem("dbkit.sptest.prefs", JSON.stringify({ dir: "C:/sptests", mode: "assert", goldenDir: "", help: true })));
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("shop", { exact: true }).nth(1).click();
    await sleep(700);
    await page.getByText("預存程序", { exact: true }).first().click();
    await sleep(700);
    await page.getByText("sp_close_order", { exact: true }).first().click({ button: "right" });
    await sleep(300);
    const items = await menuItems(page);
    check("程序右鍵：整合測試…", items.some((i) => i.includes("整合測試…")), items.join(" | "));
    await page.getByText("整合測試…", { exact: true }).click();
    await sleep(900);
    check("從程序開啟時 AI 產生情境可用", await page.locator('[data-testid="sp-test-generate"]').isEnabled());
    check("說明面板的第一步提到從程序產生骨架", (await page.locator('[data-testid="sp-test-help"]').innerText()).includes("sp_close_order"));
    await page.locator('[data-testid="sp-test-new"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="sp-test-file"]').length === 2, null, { timeout: 5000 }).catch(() => {});
    await sleep(500);
    check("新檔出現在檔案清單", (await page.locator('[data-testid="sp-test-file"]').allInnerTexts()).some((x) => x.includes("sp_close_order.json")));
    const text = await page.locator('[data-testid="sp-test-editor"]').inputValue();
    check("新檔內容是後端產生的骨架（fixture + happy_path + 錯誤分支情境）", text.includes("happy_path") && text.includes("error_order_already_closed") && text.includes("<<order_id"), text.slice(0, 200));
    await page.keyboard.press("Escape");
    await sleep(300);
  },

  async "review-run-dialog"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(900);
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("UPDATE orders SET status = 'cancelled' WHERE status = 'pending';\nDELETE FROM order_notes WHERE created_at < '2025-01-01';");
    await sleep(500);

    const open = page.locator('[data-testid="review-run-open"]');
    check("查詢分頁工具列有「審查並執行」", (await open.count()) > 0);
    await open.first().click();
    await page.waitForFunction(() => document.body.innerText.includes("完整回滾"), null, { timeout: 8000 }).catch(() => {});
    let body = await appText(page);
    check("對話框列出語句與回滾等級", body.includes("完整回滾") && body.includes("部分回滾"), body.replace(/\s+/g, " ").slice(0, 300));
    check("部分回滾的語句自動展開注意事項", body.includes("attachment"));
    check("需要確認時出現勾選框", body.includes("我了解有 1 句沒有完整回滾"));
    check("輸出目錄沿用上次設定", (await page.locator('input[value="C:\\\\Users\\\\demo\\\\db-kit-backups"]').count()) > 0);

    // 開啟時自動審查：串流完成後出現結論徽章。
    await page.waitForFunction(() => document.body.innerText.includes("注意風險後再執行"), null, { timeout: 15_000 }).catch(() => {});
    // 結論在串流第一段就出現；串流結束（出現「重新審查」）前兩個動作鈕都該是停用的。
    check("AI 串流中不能產生備份", !(await page.getByRole("button", { name: "只產生備份", exact: true }).first().isEnabled()));
    await page.getByRole("button", { name: "重新審查", exact: true }).first().waitFor({ timeout: 15_000 }).catch(() => {});
    body = await appText(page);
    check("AI 審查串流並顯示結論徽章", body.includes("注意風險後再執行"));
    check("正式環境連線預設用守門員人設", (await page.getByRole("button", { name: /正式環境守門員/ }).count()) > 0);
    check("DBA 查資料庫的紀錄列在結果裡", body.includes("工具呼叫（1）"));
    check("結論那一行不重複出現在內文", !body.includes("VERDICT: CAUTION"));

    const exec = page.getByRole("button", { name: "執行（含備份）", exact: true });
    check("唯讀連線不能執行", (await exec.count()) > 0 && !(await exec.first().isEnabled()));
    check("說明為什麼不能執行", body.includes("此連線為唯讀模式，只能產生備份"));
    const backup = page.getByRole("button", { name: "只產生備份", exact: true });
    check("唯讀連線仍可只產生備份", (await backup.count()) > 0 && (await backup.first().isEnabled()));
    await backup.first().click();
    await page.waitForFunction(() => document.body.innerText.includes("已產生審查與備份（未執行）"), null, { timeout: 8000 }).catch(() => {});
    body = await appText(page);
    check("產生備份後切到結果分頁", body.includes("已產生審查與備份（未執行）"), body.replace(/\s+/g, " ").slice(0, 300));
    check("結果列出輸出檔案", body.includes("rollback.sql") && body.includes("snapshots/01-before-orders.json"));
    check("結果可以回滾分頁查看腳本", (await page.getByText("回滾腳本", { exact: true }).count()) > 0);
  },

  // 編輯器 DBA 審查：下方「審查」分頁 → 選人設 → DBA 審查（agent 模式先查一次資料庫）→ 結論徽章 →
  // 回覆裡的修正 SQL 一鍵走差異預覽（直接用那段 SQL，不再呼叫模型）。
  async "dba-review-editor"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("查詢", { exact: true }).first().click();
    await sleep(900);
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("UPDATE orders SET status = 'cancelled' WHERE status = 'pending';");
    await sleep(600);
    await page.getByRole("button", { name: /^審查(?!並執行)/ }).first().click();
    await sleep(500);
    const run = page.getByRole("button", { name: "DBA 審查", exact: true });
    check("審查分頁有 DBA 審查鈕", (await run.count()) > 0);
    await run.first().click();
    await page.waitForFunction(() => document.body.innerText.includes("注意風險後再執行"), null, { timeout: 15_000 }).catch(() => {});
    await page.getByRole("button", { name: "重新審查", exact: true }).first().waitFor({ timeout: 15_000 }).catch(() => {});
    const body = await appText(page);
    check("DBA 審查顯示結論徽章", body.includes("注意風險後再執行"), body.replace(/\s+/g, " ").slice(0, 300));
    check("DBA 審查列出工具呼叫", body.includes("工具呼叫（1）"));
    check("DBA 審查有「在助手中追問」", (await page.getByRole("button", { name: "在助手中追問" }).count()) > 0);
    const apply = page.getByRole("button", { name: /套用到編輯器/ });
    check("修正 SQL 有「套用到編輯器」", (await apply.count()) > 0);
    await apply.first().click();
    await sleep(800);
    const diff = await page.locator("body").innerText();
    check("套用走差異預覽", diff.includes("套用 DBA 建議的修正"), diff.replace(/\s+/g, " ").slice(0, 200));
    check("差異預覽不再呼叫模型（沒有重新生成）", (await page.getByRole("button", { name: "重新生成" }).count()) === 0);
  },

  // AI 資源庫：設定 → 開啟 AI 資源庫 → 分頁排成「人設 ＋ 技能 ＋ 提示範本 → 送給 AI」、運作方式說明誰用到什麼 →
  // 內建項目直接可改（沒存就換分頁會先問）→ 技能標示用在哪裡、點預載它的人設會跳過去 → 範本預覽帶出鎖定的契約 →
  // 來源與同步分頁列出同步計畫。
  async "ai-library-dialog"(page) {
    await page.getByRole("button", { name: /設定/ }).first().click();
    await sleep(600);
    await page.getByRole("button", { name: /開啟 AI 資源庫/ }).first().click();
    await page.waitForFunction(() => document.body.innerText.includes("正式環境守門員"), null, { timeout: 8000 }).catch(() => {});
    let body = await page.locator("body").innerText();
    check("資源庫列出內建 DBA 人設", body.includes("正式環境守門員") && body.includes("效能調校 DBA"), body.replace(/\s+/g, " ").slice(0, 300));
    check("資料模型架構師、DBA 導師已不內建", !body.includes("資料模型架構師") && !body.includes("dba-mentor"));
    check("分頁排成組合流程並各附一句用途",
      body.includes("AI 扮演誰") && body.includes("附加的專業知識") && body.includes("每個 AI 動作的指令") && body.includes("送給 AI"));
    check("運作方式說明各功能用到哪些部分",
      body.includes("請誰來做") && body.includes("讓它多懂什麼") && body.includes("這次要做什麼") &&
      body.includes("DBA 審查 / 會審") && body.includes("你在「技能」分頁勾選的"));
    // 運作方式的「DBA 審查」那一列有 ? 鈕：點了跳出三個入口的教學，關掉回到資源庫。
    await page.getByRole("button", { name: "DBA 審查怎麼用" }).first().click();
    await sleep(300);
    body = await page.locator("body").innerText();
    check("點 ? 跳出 DBA 審查教學、列出三個入口",
      body.includes("從哪裡開始（三個入口）") && body.includes("審查並執行") && body.includes("DBA 審查結構…") && body.includes("review-pre-exec"));
    await page.getByRole("button", { name: "知道了", exact: true }).click();
    await sleep(300);
    body = await page.locator("body").innerText();
    check("關掉教學後資源庫還在", !body.includes("從哪裡開始（三個入口）") && body.includes("AI 扮演誰"));
    check("人設分成 DBA 審查者 / 助手兩群，使用中的有標示", body.includes("DBA 審查者") && body.includes("使用中"));
    // 人設列右鍵：直接設成預設 / 加入會審（寫進資源庫設定），不必繞去「來源與同步」。
    await page.getByText("dba-security", { exact: true }).first().click({ button: "right" });
    await sleep(200);
    const pItems = await menuItems(page);
    check("人設右鍵選單：設為預設 / 正式環境預設 / 會審",
      ["設為 DBA 審查預設", "設為正式環境 DBA 審查預設", "移出多位 DBA 會審"].every((s) => pItems.some((i) => i.includes(s))), pItems.join(" | "));
    await page.locator('div.fixed.z-\\[90\\] button', { hasText: "設為 DBA 審查預設" }).first().click();
    await sleep(300);
    const sets = await page.evaluate(() => window.__DBKIT_AI_SETTINGS_SET__);
    check("點「設為 DBA 審查預設」寫進設定", sets.length === 1 && sets[0].dba_persona === "dba-security", JSON.stringify(sets));
    await page.getByText("assistant", { exact: true }).first().click({ button: "right" });
    await sleep(200);
    check("助手人設的右鍵選單：設為 AI 助手人設", (await menuItems(page)).some((i) => i.includes("設為 AI 助手人設")));
    // 不按 Esc（會連資源庫一起關掉）：點選單的背板收掉。
    await page.locator(String.raw`div.fixed.inset-0.z-\[89\]`).last().click({ position: { x: 5, y: 5 } });
    await sleep(150);
    // 從設定開的：資源庫疊在設定對話框上面，取最後一個 dialog。
    const lib = page.locator('[role="dialog"]').last();
    // 以前 shell 進場動畫用 forwards、終點的 transform 留在 shell 上，裡面再開的對話框會以外層 shell 為定位基準、
    // 右半截出界。等進場動畫跑完再量。
    await sleep(300);
    // 外層 shell 帶著 transform（動畫中途、或日後任何會建立定位基準的樣式）時也不能偏掉：對話框掛在 body 上（issue #8）。
    await page.locator('[role="dialog"]').first().evaluate((el) => { el.style.transform = "translateY(0.5px)"; });
    await sleep(100);
    const box = await lib.boundingBox();
    const vw = page.viewportSize()?.width ?? 0;
    check("從設定裡開的資源庫整個在視窗內", !!box && box.x >= 0 && box.x + box.width <= vw + 1, JSON.stringify({ box, vw }));
    const libClose = await lib.getByRole("button", { name: "關閉", exact: true }).first().boundingBox();
    check("資源庫的關閉鈕看得到", !!libClose && libClose.x + libClose.width <= vw + 1, JSON.stringify({ libClose, vw }));
    await page.locator('[role="dialog"]').first().evaluate((el) => { el.style.transform = ""; });
    const persona = lib.locator("textarea").first();
    check("內建人設可以直接編輯", await persona.isEditable());
    check("內建項目的存檔鈕說明會存成自訂版本", (await lib.getByRole("button", { name: "儲存為自訂版本" }).count()) === 1);
    await persona.fill(`${await persona.inputValue()}\n（測試修改）`);
    await sleep(200);
    check("改了之後標示未儲存、存檔鈕可按",
      (await lib.innerText()).includes("未儲存") && (await lib.getByRole("button", { name: "儲存為自訂版本" }).isEnabled()));
    await page.getByRole("radio", { name: "技能" }).first().click();
    await sleep(300);
    check("有沒存的修改時換分頁先問", (await page.locator("body").innerText()).includes("有未儲存的修改，要捨棄嗎？"));
    // 確認框在通知區旁邊渲染，DOM 順序比設定對話框的「取消」還前面：從訊息往上找它自己的按鈕。
    await page.getByText("有未儲存的修改，要捨棄嗎？", { exact: true }).locator("..").getByRole("button", { name: "取消", exact: true }).click();
    await sleep(300);
    check("取消後留在原本的編輯內容", (await persona.inputValue()).includes("（測試修改）"));
    await lib.getByRole("button", { name: "捨棄變更" }).click();
    await sleep(200);
    await page.getByRole("radio", { name: "技能" }).first().click().catch(() => page.getByText("技能", { exact: true }).first().click());
    await sleep(400);
    body = await page.locator("body").innerText();
    check("捨棄後換分頁不再問", !body.includes("有未儲存的修改，要捨棄嗎？"));
    check("技能分頁列出內建技能", body.includes("線上 DDL") && body.includes("鎖與併發風險"));
    check("技能列表直接標出被人設預載的技能", body.includes("預載 ×"));
    await page.getByText("鎖與併發風險", { exact: true }).first().click();
    await sleep(300);
    body = await lib.innerText();
    check("技能標示助手對話有沒有啟用、哪些人設預載它", body.includes("AI 助手對話：") && body.includes("預載它的人設："));
    await lib.getByRole("button", { name: "正式環境守門員" }).first().click();
    await sleep(400);
    check("點預載它的人設就跳到那位人設",
      (await page.getByRole("radio", { name: "人設" }).first().getAttribute("aria-checked")) === "true" && (await lib.innerText()).includes("正式環境 DBA 審查"));
    await page.getByRole("radio", { name: "提示範本" }).first().click().catch(() => page.getByText("提示範本", { exact: true }).first().click());
    await sleep(400);
    await page.getByText("DBA 審查 SQL", { exact: true }).first().click();
    await sleep(400);
    body = await page.locator("body").innerText();
    check("範本顯示可用變數", body.includes("{{sql}}") && body.includes("{{lint_findings}}"));
    check("範本顯示鎖定的輸出契約", body.includes("輸出契約（鎖定，不可修改）") && body.includes("VERDICT: STOP"));
    await page.getByRole("button", { name: "預覽", exact: true }).first().click();
    await sleep(400);
    body = await page.locator("body").innerText();
    check("預覽以範例資料渲染", body.includes("預覽（以範例資料渲染）") && body.includes("SELECT o.id, o.status FROM orders"));
    // review-* 範本的標頭也有 ? 鈕：教學標出目前這個範本的入口，點別的範本名稱就跳過去。
    await page.getByRole("button", { name: "DBA 審查怎麼用" }).last().click();
    await sleep(300);
    check("從範本開的教學標出目前這個範本", (await page.locator("body").innerText()).includes("目前這個範本"));
    await page.getByRole("button", { name: "review-pre-exec", exact: true }).click();
    await sleep(400);
    body = await page.locator("body").innerText();
    check("點教學裡的範本名稱跳到那個範本", !body.includes("從哪裡開始（三個入口）") && body.includes("DBA review before execution"));
    await page.getByRole("radio", { name: "來源與同步" }).first().click().catch(() => page.getByText("來源與同步", { exact: true }).first().click());
    await sleep(400);
    await page.getByRole("button", { name: "預覽同步計畫" }).first().click();
    await sleep(500);
    body = await page.locator("body").innerText();
    check("同步計畫列出新增與衝突", body.includes("dba-senior.md") && body.includes("衝突（略過）"));
    check("同步計畫附上 MCP 註冊提示", body.includes("claude mcp add dbkit"));
    // 點資源庫外面的空白處：關掉的是資源庫本身，設定對話框留著。
    await page.mouse.click(4, Math.round((page.viewportSize()?.height ?? 600) / 2));
    await sleep(300);
    body = await page.locator("body").innerText();
    check("點空白處只關掉資源庫、設定還在",
      !body.includes("AI 扮演誰") && (await page.getByRole("button", { name: /開啟 AI 資源庫/ }).count()) > 0);
  },

  // 助手的技能收成工具列上的一顆按鈕（帶啟用數），點了才開 AI 資源庫的「技能」分頁：勾選框在列表上，
  // 右側就是編輯器。以前八個技能平鋪在輸入區上方，佔掉兩三行。
  async "assistant-skills-collapsed"(page) {
    // shim 的資源庫是內建 fallback（active_skills = null），選取會沿用舊版的 localStorage 鍵。
    await page.evaluate(() => localStorage.setItem("db-kit:aiSkillsOn", JSON.stringify(["sql-perf"])));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root");
    await sleep(1200);
    await page.getByRole("button", { name: "AI 助手" }).first().click();
    await sleep(600);
    const btn = page.locator('button[title*="點擊勾選 / 編輯技能"]');
    check("助手工具列有技能按鈕", (await btn.count()) === 1);
    const label = (await btn.first().innerText().catch(() => "")).replace(/\s+/g, "");
    check("技能按鈕顯示啟用數", label === "技能1", label);
    check("技能按鈕提示列出啟用的技能", ((await btn.first().getAttribute("title")) ?? "").includes("SQL 效能診斷"));
    const panel = await appText(page);
    check("輸入區不再平鋪技能清單", !panel.includes("線上 DDL") && !panel.includes("鎖與併發風險"));
    await btn.first().click();
    await page.waitForFunction(() => document.body.innerText.includes("線上 DDL"), null, { timeout: 8000 }).catch(() => {});
    const body = await page.locator("body").innerText();
    check("點技能按鈕開啟 AI 資源庫的技能分頁", body.includes("AI 資源庫") && body.includes("線上 DDL") && body.includes("鎖與併發風險"),
      body.replace(/\s+/g, " ").slice(0, 300));
    check("技能分頁說明勾選的用途與數量", body.includes("已勾 1 個"));
    check("技能分頁右側就是編輯器", body.includes("技能內容（SKILL.md 本文）"));
    const perf = page.getByRole("checkbox", { name: "在助手對話啟用 SQL 效能診斷" });
    check("已啟用的技能勾選框是勾起的", (await perf.count()) === 1 && (await perf.isChecked()));
    check("沒啟用的技能勾選框沒勾", !(await page.getByRole("checkbox", { name: "在助手對話啟用 線上 DDL" }).isChecked()));
  },

  async "compare-dialogs-open"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    // 「常用」釘選區也有 shop / orders 字樣，取 nth(1) 才是樹裡的節點；表在「資料表」資料夾下，先展開。
    await page.getByText("shop", { exact: true }).nth(1).click();
    await sleep(700);
    await page.getByText("資料表", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="orders"]', { timeout: 8000 });
    await sleep(300);
    await page.locator('[data-tree-table="orders"]').first().click({ button: "right" });
    await sleep(300);
    let items = await menuItems(page);
    check("資料表右鍵：結構比對…", items.some((i) => i.includes("結構比對")), items.join(" | "));
    check("資料表右鍵：舊的「資料比對 / 同步」已移除", !items.some((i) => i.includes("資料比對 / 同步")));
    check("資料表右鍵：獨立的「資料比對…」", items.some((i) => i === "資料比對…" || i.startsWith("資料比對…")), items.join(" | "));
    await page.getByText("結構比對…", { exact: true }).click();
    // 整套跑時機器忙，固定 sleep 會偶發抓不到——等到對話框真的畫出來。
    await page.getByText("比對目標", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    check("單表比對對話框開啟", (await page.getByText("比對目標", { exact: true }).count()) > 0);
    check("單表比對只談結構，沒有資料分頁", !(await appText(page)).includes("含 DELETE"));
    // 一開就要是可按的狀態：目標庫預設挑「非來源」的庫，而不是把來源自己填進去。
    check("單表比對預設目標不是來源自己",
      !(await appText(page)).includes("來源與目標是同一張表"));
    const cmpBtn = page.getByRole("button", { name: "比對", exact: true }).first();
    check("單表比對「比對」鈕開啟即可按", await cmpBtn.isEnabled());
    await cmpBtn.click();
    await sleep(1500);
    const body = await appText(page);
    check("單表比對顯示結構結果", /有差異|結構相同|僅來源有|僅目標有/.test(body), body.replace(/\s+/g, " ").slice(0, 200));
    check("單表比對列出同步語句", body.includes("同步語句"));
    await page.keyboard.press("Escape");
    await sleep(400);

    await page.getByText("shop", { exact: true }).nth(1).click({ button: "right" });
    await sleep(300);
    items = await menuItems(page);
    check("資料庫右鍵：結構比對…", items.some((i) => i.includes("結構比對")), items.join(" | "));
    check("資料庫右鍵：儲存結構快照…", items.some((i) => i.includes("儲存結構快照")));
    await page.getByText("結構比對…", { exact: true }).click();
    await sleep(900);
    check("整庫比對對話框開啟", (await page.getByRole("button", { name: /比對選取的/ }).count()) > 0);
    check("整庫比對列出來源資料表", (await page.getByText("資料表（", { exact: false }).count()) > 0);
    check("整庫比對預設目標不是來源庫",
      !(await appText(page)).includes("目標與來源是同一個資料庫"));

    // 跨連線：目標連線下拉要列出同族的另一條連線（prod-mysql 之外還有 external 家族的…這裡只驗有下拉）
    await page.locator("select").filter({ has: page.locator('option[value="shop_archive"]') })
      .filter({ hasNot: page.locator('option[value="information_schema"]') }).first().selectOption("shop_archive");
    await sleep(400);
    await page.getByRole("button", { name: /比對選取的/ }).click();
    await sleep(2500);
    const after = await appText(page);
    check("整庫比對跑出結果與同步腳本", after.includes("同步語句"), after.replace(/\s+/g, " ").slice(0, 200));
    check("整庫比對有 AI 總結區塊", after.includes("AI 總結"));
    check("整庫比對不再出現資料比對選項", !after.includes("快速預檢") && !after.includes("兩者"));

    // AI 總結：shim 會把假回覆以 agent-stream 事件一段段送回，驗的是串流累積真的有渲染出來。
    await page.getByRole("button", { name: "產生總結", exact: true }).click();
    let streamed = false;
    try {
      await page.waitForFunction(() => document.body.innerText.includes("建議順序"), null, { timeout: 15_000 });
      streamed = true;
    } catch { /* 下面的 check 會報 */ }
    check("AI 總結串流回填", streamed, (await appText(page)).replace(/\s+/g, " ").slice(0, 200));
    check("AI 總結完成後可重新產生", (await page.getByRole("button", { name: "重新產生", exact: true }).count()) > 0);
    // v0.31 操作改版（對標 Redgate / Navicat 的結構比對）：狀態晶片、物件勾選驅動腳本、差異摘要、
    // drill-in 導覽、DDL 檢視器、換方向、比對選項。少一個 data-* 掛鉤就是這裡紅。
    const chips = page.locator("[data-status-chip]");
    check("結果清單有四顆狀態晶片", (await chips.count()) === 4, String(await chips.count()));
    check("「相同」晶片預設關（相同的物件先藏起來）",
      (await page.locator('[data-status-chip="identical"]').getAttribute("aria-checked")) === "false");
    check("清單依類型分組，分組標題有三態勾選框", (await page.locator("[data-group-include]").count()) >= 1);
    const selCount = async () => Number(await page.locator("[data-sync-selected]").first().getAttribute("data-sync-selected"));
    const selBefore = await selCount();
    await page.locator('[data-compare-include="orders"]').uncheck();
    await sleep(300);
    const selAfter = await selCount();
    check("勾掉 orders 後，屬於它的語句退出同步腳本", selAfter < selBefore, `${selBefore} → ${selAfter}`);
    check("被排除的語句標示「已排除」", (await page.getByText("已排除", { exact: true }).count()) > 0);
    await page.locator('[data-compare-include="orders"]').check();
    await sleep(300);
    check("勾回 orders 語句回來", (await selCount()) === selBefore, `${await selCount()} vs ${selBefore}`);
    const ordersRow = page.locator('[data-compare-row="table:orders"]');
    const ordersText = (await ordersRow.innerText()).replace(/\s+/g, " ");
    check("orders 列有差異摘要徽章（欄 +1 ~1、索引 +1）", /欄 ?\+1 ?~1/.test(ordersText) && /索引 ?\+1/.test(ordersText), ordersText);
    check("legacy_log 列標 DROP", /DROP/.test(await page.locator('[data-compare-row="table:legacy_log"]').innerText()));

    // drill-in：上一個 / 下一個物件不必回清單；DDL 檢視有只看差異與差異導覽。
    await ordersRow.getByRole("button").first().click();
    await sleep(900);
    // 分組標題的「3 / 13」也長這樣，所以不能用文字找，要用 drill-in 標題自己的掛鉤。
    const counter = page.locator("[data-drill-pos]").first();
    check("drill-in 標題有「N / 總數」與上一個 / 下一個物件", (await counter.count()) > 0 && (await page.getByRole("button", { name: "下一個物件", exact: true }).count()) > 0);
    const posBefore = (await counter.count()) ? await counter.innerText() : "";
    await page.getByRole("radio", { name: "DDL", exact: true }).click();
    await sleep(400);
    check("DDL 並排檢視有「只看差異」與差異導覽", (await page.getByRole("button", { name: /只看差異/ }).count()) > 0
      && (await page.getByRole("button", { name: "下一處差異", exact: true }).count()) > 0);
    check("DDL 並排檢視掛載（含行號欄）", (await page.locator("[data-side-by-side]").count()) > 0);
    await page.getByRole("button", { name: "下一個物件", exact: true }).click();
    await sleep(700);
    check("「下一個物件」真的跳到下一個", (await counter.innerText()) !== posBefore, `${posBefore} → ${await counter.innerText()}`);
    await page.getByRole("button", { name: "回到彙總", exact: true }).click();
    await sleep(300);

    // 換方向：來源標籤換成原本的目標，結果作廢回到選表狀態。
    const srcBefore = await page.locator("[data-compare-source]").first().innerText();
    await page.getByRole("button", { name: "交換來源與目標", exact: true }).click();
    await sleep(700);
    const srcAfter = await page.locator("[data-compare-source]").first().innerText();
    check("⇄ 把來源換成原本的目標（shop_archive）", srcAfter.includes("shop_archive") && !srcBefore.includes("shop_archive"), `${srcBefore} → ${srcAfter}`);
    check("換方向後結果作廢，回到選表狀態", (await page.getByRole("button", { name: /比對選取的/ }).count()) > 0);

    // 比對選項：面板開得起來、寫進 localStorage、Esc 只關面板不關對話框。
    await page.getByRole("button", { name: /^選項/ }).click();
    await sleep(300);
    check("選項面板列出規則與範圍", (await page.locator('[data-compare-opt="ignore_comments"]').count()) === 1
      && (await page.locator('[data-compare-opt="include_views"]').count()) === 1);
    await page.locator('[data-compare-opt="ignore_comments"]').check();
    await sleep(200);
    check("比對選項寫進 localStorage", ((await page.evaluate(() => localStorage.getItem("dbkit:compare:options"))) ?? "").includes('"ignore_comments":true'));
    await page.locator('[data-compare-opt="ignore_comments"]').uncheck();
    await sleep(100);
    await page.keyboard.press("Escape");
    await sleep(300);
    check("Esc 只關選項面板，對話框還在", (await page.locator('[data-compare-opt="ignore_comments"]').count()) === 0
      && (await page.getByRole("button", { name: /比對選取的/ }).count()) > 0);
  },

  // ---- 檔案 / 資料夾 / 二進位比對 ----
  // 資料比對獨立成一個對話框：只產生同步 SQL、送到目標的查詢編輯器，不在這裡直接套用。
  async "data-compare-dialog"(page) {
    await page.getByText("prod-mysql", { exact: true }).first().dblclick();
    await sleep(1200);
    await page.getByText("shop", { exact: true }).nth(1).click();
    await sleep(700);
    await page.getByText("資料表", { exact: true }).first().click();
    await page.waitForSelector('[data-tree-table="orders"]', { timeout: 8000 });
    await page.locator('[data-tree-table="orders"]').first().click({ button: "right" });
    await sleep(300);
    await page.getByText("資料比對…", { exact: true }).click();
    const runBtn = page.locator("[data-data-compare-run]");
    await runBtn.waitFor({ timeout: 8000 });
    // 目標庫清單非同步載入，載完才會預設一個非來源的庫、鈕才亮。
    await page.waitForFunction(() => !document.querySelector("[data-data-compare-run]")?.disabled, null, { timeout: 5000 }).catch(() => {});
    check("資料比對對話框開啟、預設目標可按", await runBtn.isEnabled());
    check("對話框沒有「直接套用」", !(await appText(page)).includes("直接執行"));
    await page.locator('[data-data-compare-opt="include_deletes"]').check();
    await runBtn.click();
    await page.locator("[data-data-compare-result]").waitFor({ timeout: 8000 });
    const body = await appText(page);
    check("摘要列出新增 / 更新 / 刪除", /新增 3/.test(body) && /更新 2/.test(body) && /刪除 1/.test(body), body.replace(/\s+/g, " ").slice(0, 240));
    check("只在目標的欄位有提示", body.includes("legacy_flag"));
    check("預設顯示更新樣本", (await page.locator('[data-data-compare-samples="updates"]').count()) === 1);
    await page.getByRole("radio", { name: /新增 \(3\)/ }).click();
    check("切到新增樣本", (await page.locator('[data-data-compare-samples="inserts"]').innerText()).includes("128735"));
    check("同步 SQL 顯示", (await page.locator("[data-data-compare-sql]").innerText()).includes("UPDATE"));
    await page.locator("[data-data-compare-send]").click();
    await sleep(600);
    check("送出後對話框關閉", (await page.locator("[data-data-compare-run]").count()) === 0);
    check("SQL 送進查詢編輯器", (await appText(page)).includes("128735"));
  },
  async "compare-text"(page) {
    await startCompare(page, "文字比對", "C:\\work\\old\\app.conf", "C:\\work\\new\\app.conf");
    await page.waitForSelector('[data-testid="text-compare"] .cm-mergeView', { timeout: 8000 });
    await sleep(400);
    const summary = await page.locator('[data-testid="cmp-summary"]').innerText();
    check("文字比對：列出差異數", /處不同/.test(summary), summary);
    check("文字比對：分頁標題是兩邊檔名（同名只寫一次）", (await page.locator("[data-cmp-tab]").first().innerText()).includes("app.conf"));
    const ctl = page.locator(".dbk-merge-ctl").first();
    check("文字比對：每一塊有 → / ← 兩顆套用鈕", (await ctl.locator("button").count()) === 2);
    // 第一塊（port）套到右邊：右邊的 port 變回 5432，右邊標成已修改。
    await ctl.locator("button").first().dispatchEvent("mousedown");
    await sleep(300);
    const right = await page.locator(".cm-mergeView .cm-editor").nth(1).innerText();
    check("文字比對：→ 把這一塊套到右邊", right.includes("port = 5432") && !right.includes("port = 6432"), right.slice(0, 200));
    const saveB = page.locator('[data-testid="cmp-save-b"]');
    check("文字比對：右邊修改後「存右邊」可按", await saveB.isEnabled());
    await saveB.click();
    await sleep(400);
    const writes = await page.evaluate(() => window.__DBKIT_CMP_WRITES__);
    check("文字比對：存回右邊的檔案", writes.length === 1 && writes[0].path === "C:\\work\\new\\app.conf" && writes[0].content.includes("port = 5432"), JSON.stringify(writes));
    check("文字比對：存檔帶開檔時的 mtime（衝突偵測）", writes[0]?.expectedMtime != null);
    await noUnknownCommands(page, "文字比對");
  },

  async "compare-folder"(page) {
    await startCompare(page, "資料夾比對", "C:\\work\\site", "C:\\deploy\\site");
    await page.waitForSelector('[data-testid="fcmp-summary"]', { timeout: 8000 });
    const summary = await page.locator('[data-testid="fcmp-summary"]').innerText();
    check("資料夾比對：統計", summary.includes("只在左 1") && summary.includes("只在右 1") && summary.includes("不同 1"), summary);
    const scans = await page.evaluate(() => window.__DBKIT_FCMP_SCANS__);
    check("資料夾比對：預設排除 .git / node_modules", JSON.stringify(scans[0]?.opts?.excludes) === JSON.stringify([".git", "node_modules"]), JSON.stringify(scans[0]?.opts));
    const list = page.locator('[data-testid="fcmp-list"]');
    check("資料夾比對：子資料夾有差異就自動展開", (await list.getByText("app.conf", { exact: true }).count()) > 0);

    await page.locator('[data-testid="fcmp-filter"]').getByRole("radio", { name: /只在左/ }).click();
    await sleep(200);
    const rowsLeftOnly = await list.locator("[data-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
    check("資料夾比對：「只在左」篩選", JSON.stringify(rowsLeftOnly) === JSON.stringify(["new.txt"]), JSON.stringify(rowsLeftOnly));
    await list.locator('[data-key="new.txt"]').click();
    await page.locator('[data-testid="fcmp-copy-lr"]').click();
    await page.getByRole("button", { name: "執行", exact: true }).click();
    await sleep(500);
    let syncs = await page.evaluate(() => window.__DBKIT_FCMP_SYNCS__);
    check("資料夾比對：選取項目複製到右邊", JSON.stringify(syncs[0]) === JSON.stringify([{ kind: "copy_lr", src: "new.txt", dst: "new.txt", is_dir: false }]), JSON.stringify(syncs));
    check("資料夾比對：同步後重新掃描", (await page.evaluate(() => window.__DBKIT_FCMP_SCANS__.length)) === 2);

    await page.locator('[data-testid="fcmp-filter"]').getByRole("radio", { name: "全部", exact: true }).click();
    await page.locator('[data-testid="fcmp-sync"]').click();
    await page.getByText("鏡像：左 → 右", { exact: true }).click();
    const preview = await page.locator('[data-testid="fcmp-sync-preview"]').innerText();
    check("同步：鏡像預覽列出覆蓋與刪除", preview.includes("conf/app.conf") && preview.includes("new.txt") && preview.includes("old.log") && preview.includes("刪右"), preview);
    await page.locator('[data-testid="fcmp-sync-run"]').click();
    await page.getByRole("button", { name: "執行", exact: true }).click();
    await sleep(500);
    syncs = await page.evaluate(() => window.__DBKIT_FCMP_SYNCS__);
    const kinds = (syncs[1] ?? []).map((o) => `${o.kind}:${o.src}`).sort();
    check("同步：鏡像的操作清單", JSON.stringify(kinds) === JSON.stringify(["copy_lr:conf/app.conf", "copy_lr:new.txt", "delete_right:old.log"]), JSON.stringify(syncs[1]));
    await noUnknownCommands(page, "資料夾比對");
  },

  async "compare-binary"(page) {
    await startCompare(page, "二進位比對", "C:\\work\\old\\app.conf", "C:\\work\\new\\app.conf");
    await page.waitForSelector('[data-testid="bin-summary"]', { timeout: 8000 });
    await sleep(300);
    const s = await page.locator('[data-testid="bin-summary"]').innerText();
    check("二進位比對：列出不同的區段", /段不同/.test(s), s);
    check("二進位比對：十六進位位移欄", (await appText(page)).includes("00000000"));
    // 同一個分頁可切回文字比對。
    await page.locator('[data-testid="compare-pane"]').getByRole("radio", { name: "文字", exact: true }).click();
    await page.waitForSelector('[data-testid="text-compare"]', { timeout: 8000 });
    check("二進位 → 文字比對切換", true);
    await noUnknownCommands(page, "二進位比對");
  },

  async "compare-saved-session"(page) {
    await openNewCompare(page);
    const launcher = page.locator('[data-testid="compare-launcher"]');
    await launcher.locator('[data-testid="cmp-left"] input').first().fill("C:\\work\\old\\app.conf");
    await launcher.locator('[data-testid="cmp-right"] input').first().fill("C:\\work\\new\\app.conf");
    await launcher.getByRole("button", { name: "存成比對…", exact: true }).click();
    await page.getByRole("button", { name: "確定", exact: true }).click().catch(() => {});
    await sleep(400);
    const saves = await page.evaluate(() => window.__DBKIT_CMP_SESSION_SAVES__);
    const s = saves.at(-1)?.sessions?.[0];
    check("已存的比對：寫進 compare_sessions.json 的格式", !!s && s.mode === "text" && s.left.side === "local" && s.left.path === "C:\\work\\old\\app.conf" && Array.isArray(s.folder?.excludes), JSON.stringify(saves));
    check("已存的比對：出現在啟動畫面", (await launcher.getByText("已存的比對", { exact: true }).count()) > 0);
    await noUnknownCommands(page, "已存的比對");
  },
};

/** 開新比對分頁：有分頁列就按分頁列的鈕，沒有（沒連任何資料庫）就按空狀態的鈕。 */
async function openNewCompare(page) {
  const bar = page.locator('[data-testid="new-compare-tab"]');
  if (await bar.count()) await bar.click();
  else await page.locator('[data-testid="new-compare-empty"]').click();
}

/** 開一個新比對分頁、選模式、填左右兩邊的本機路徑、開始比對。 */
async function startCompare(page, modeLabel, left, right) {
  await openNewCompare(page);
  const launcher = page.locator('[data-testid="compare-launcher"]');
  await launcher.waitFor({ timeout: 6000 });
  await launcher.getByRole("radio", { name: modeLabel, exact: true }).click();
  await launcher.locator('[data-testid="cmp-left"] input').first().fill(left);
  await launcher.locator('[data-testid="cmp-right"] input').first().fill(right);
  await launcher.locator('[data-testid="cmp-start"]').click();
}

async function noUnknownCommands(page, what) {
  const unknown = await page.evaluate(() => window.__DBKIT_UNKNOWN__);
  check(`${what}：沒有未實作的 command`, unknown.length === 0, unknown.join(", "));
}

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
const server = await preview({ root, preview: { port: Number(process.env.DBKIT_PORT) || 4174, strictPort: true } });
const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:4174/";
console.log(`preview → ${url}`);

const browser = await chromium.launch({ executablePath: process.env.DBKIT_CHROME || undefined });
const fx = { ...FX, now: Date.parse("2026-07-02T21:00:00Z") };

// 版面巡檢（見 layout-lint.mjs）：DBKIT_LAYOUT_LINT=1 在每個情境裡持續掃跑版，最後彙整列出
// （DBKIT_LAYOUT_OUT=<檔案> 另存 JSON）。DBKIT_VIEWPORT=900x640 換視窗大小（900 是 App 的最小寬度）、
// DBKIT_UI_FONT=20 換介面字級——這兩個也可以不開巡檢、單純拿來在別的尺寸跑一般檢查。
const LINT = process.env.DBKIT_LAYOUT_LINT === "1";
const [VW, VH] = (process.env.DBKIT_VIEWPORT || "1280x800").split("x").map(Number);
const UI_FONT = Number(process.env.DBKIT_UI_FONT) || null;
const lintFound = new Map();

for (const name of want) {
  if (!CASES[name]) { failures.push(`未知情境：${name}`); continue; }
  console.log(`→ ${name}`);
  const ctx = await browser.newContext({ viewport: { width: VW || 1280, height: VH || 800 }, locale: "zh-TW", colorScheme: "dark" });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  const caseFx = { ...fx, ...(CASE_FX[name] ?? {}) };
  if (UI_FONT) caseFx.STORAGE_SEED = { ...(caseFx.STORAGE_SEED ?? {}), "dbkit:uiFontSize": UI_FONT };
  await page.addInitScript(installShim, caseFx);
  await page.route("https://api.github.com/**", (r) =>
    caseFx.GITHUB_RELEASE ? r.fulfill({ json: caseFx.GITHUB_RELEASE }) : r.fulfill({ status: 404, json: { message: "Not Found" } }));
  if (LINT) await page.addInitScript(installLayoutLint);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#root");
  await sleep(1200);
  try { await CASES[name](page, caseFx); }
  catch (e) { check(`${name} 執行`, false, String(e).split("\n")[0]); }
  if (pageErrors.length) check(`${name} 無前端例外`, false, pageErrors[0]);
  if (LINT) {
    for (const it of await collectLayoutIssues(page)) {
      const key = `${it.kind}|${it.where}|${it.text}`;
      const prev = lintFound.get(key);
      if (prev) prev.cases.add(name);
      else lintFound.set(key, { ...it, cases: new Set([name]) });
    }
  }
  await ctx.close();
}

if (LINT) {
  const all = [...lintFound.values()].map((it) => ({ ...it, cases: [...it.cases] }));
  console.log(`\n版面巡檢（${VW}×${VH}${UI_FONT ? `、介面字級 ${UI_FONT}px` : ""}）：${all.length} 筆`);
  for (const kind of ["wrap", "cut", "clipped", "hscroll"]) {
    const list = all.filter((it) => it.kind === kind);
    if (!list.length) continue;
    console.log(`  [${kind}] ${list.length}`);
    for (const it of list) console.log(`    ${it.where} 「${it.text}」 w=${it.w}${it.lines ? ` 行=${it.lines}` : ""}${it.over ? ` 超出=${it.over}` : ""} ← ${it.cases.slice(0, 3).join(", ")}`);
  }
  if (process.env.DBKIT_LAYOUT_OUT) writeFileSync(process.env.DBKIT_LAYOUT_OUT, JSON.stringify(all, null, 2));
  // wrap（字被擠成多行）與 cut（按鈕被裁掉）一律算失敗；hscroll / clipped 常有合理的例外，只列出。
  for (const it of all.filter((x) => x.kind === "wrap" || x.kind === "cut")) {
    failures.push(`版面 ${it.kind}：${it.where} 「${it.text}」 ← ${it.cases[0]}`);
  }
}

await browser.close();
await server.close();
// 非預設尺寸下，少數功能檢查本來就綁尺寸（例如「對話框不必捲動」「預設字級 16px」），不拿來判定成敗。
const sizeBound = LINT && ((VW || 1280) !== 1280 || (VH || 800) !== 800 || !!UI_FONT);
const counted = sizeBound ? failures.filter((f) => f.startsWith("版面 ")) : failures;
console.log(`\n通過 ${passed}、失敗 ${failures.length}${sizeBound ? `（非預設尺寸：只有 ${counted.length} 筆版面問題算數）` : ""}`);
if (failures.length) { for (const f of failures) console.log(`  ${counted.includes(f) ? "✗" : "·"} ${f}`); }
process.exit(counted.length ? 1 : 0);
