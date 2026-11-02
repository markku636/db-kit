// Production UI opt-in regression, using the shared fake Tauri backend.
// npm run build; DBKIT_PLAYWRIGHT=... DBKIT_CHROME=... node scripts/verify-tenon.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import * as FX from "./screenshot-fixtures.mjs";
import { installShim } from "./tauri-shim.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DBKIT_PLAYWRIGHT || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await preview({ root, preview: { port: 4178, strictPort: true } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.DBKIT_CHROME || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-TW" });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("https://**", r => r.abort());
  await page.addInitScript(({ shim, fx }) => {
    (0, eval)(`(${shim})`)(fx);
    const original = window.__TAURI_INTERNALS__.invoke;
    let status = { config: { enabled: false, url: "", auto_sync: false, profile: "" }, signed_in: false };
    window.__TENON_CALLS__ = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (!command.startsWith("tenon_")) return original(command, args);
      window.__TENON_CALLS__.push(command);
      if (command === "tenon_config_set") status = { config: { ...args.config, profile: "test-profile" }, signed_in: false };
      if (command === "tenon_login") status = { ...status, signed_in: true };
      if (command === "tenon_logout") status = { ...status, signed_in: false };
      if (command === "tenon_directory") return { devices: [{ id: "123456", name: "Test desktop", book: "Test book", book_guid: "book-1", online: true, tags: [], can_connect: true }] };
      return structuredClone(status);
    };
  }, { shim: installShim.toString(), fx: { ...FX, now: Date.now() } });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole("button", { name: "設定", exact: true }).first().click();
  const settings = page.getByTestId("tenon-settings");
  await settings.waitFor();
  assert.equal(await settings.getByRole("button", { name: "登入 Tenon", exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => [...new Set(window.__TENON_CALLS__)]), ["tenon_status"]);
  await settings.getByLabel("啟用 Tenon 整合", { exact: true }).check();
  assert.equal(await settings.getByLabel("Tenon 服務網址").inputValue(), "");
  assert.equal(await settings.getByRole("button", { name: "儲存設定" }).isDisabled(), true);
  await settings.getByLabel("Tenon 服務網址").fill("https://tenon.example.test");
  await settings.getByRole("button", { name: "儲存設定" }).click();
  await settings.getByRole("button", { name: "登入 Tenon", exact: true }).click();
  const login = page.getByRole("dialog").filter({ has: page.getByLabel("密碼", { exact: true }) });
  assert.equal(await login.getByLabel("帳號", { exact: true }).inputValue(), "");
  assert.equal(await login.getByLabel("密碼", { exact: true }).inputValue(), "");
  await login.getByLabel("帳號", { exact: true }).fill("test-user");
  await login.getByLabel("密碼", { exact: true }).fill("test-password");
  await login.getByRole("button", { name: "登入", exact: true }).click();
  await login.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__TENON_CALLS__.includes("tenon_directory")), false);
  // Disabling from settings must hide the entry and remove the sidebar directory.
  await settings.getByLabel("啟用 Tenon 整合", { exact: true }).uncheck();
  await settings.getByRole("button", { name: "儲存設定" }).click();
  await page.getByRole("region", { name: "Tenon 裝置目錄" }).waitFor({ state: "hidden" });
  assert.equal(await settings.getByRole("button", { name: /登入 Tenon|登出 Tenon/ }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: hidden by default, manual URL and credentials, opt-in sync, disable hides directory/login");
} finally {
  await browser?.close();
  await server.close();
}
