// 版面巡檢：在三種尺寸各跑一次 verify-ui（DBKIT_LAYOUT_LINT=1，見 layout-lint.mjs），平行執行。
//
//   npm run build && npm run verify:layout
//   （Playwright 的路徑與 verify-ui 相同：DBKIT_PLAYWRIGHT / DBKIT_CHROME）
//
// 尺寸：1280×800（一般）、900×640（App 的最小視窗）、1280×800 + 介面字級 20px（放大介面）。
// 任何尺寸出現 wrap（短標籤被擠成多行）或 cut（按鈕被外層裁掉）就算失敗；hscroll / clipped 只列出。
// 非預設尺寸下，少數功能檢查本來就綁尺寸（例如「對話框不必捲動」），那些只列出、不影響結果。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// 每一輪各拿一個當下空著的 port：同一台機器常有好幾個 session 同時在跑 verify-ui，寫死的 port 會撞。
// 三個先同時佔住再一起放掉，才不會拿到同一個。
const freePorts = async (n) => {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => ok(srv));
  })));
  const ports = servers.map((s) => String(s.address().port));
  await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  return ports;
};
const [p1, p2, p3] = await freePorts(3);

const RUNS = [
  { name: "1280×800", env: { DBKIT_VIEWPORT: "1280x800", DBKIT_PORT: p1 } },
  { name: "900×640", env: { DBKIT_VIEWPORT: "900x640", DBKIT_PORT: p2 } },
  { name: "1280×800 · 字級 20px", env: { DBKIT_VIEWPORT: "1280x800", DBKIT_UI_FONT: "20", DBKIT_PORT: p3 } },
];

const run = ({ name, env }) => new Promise((done) => {
  let out = "";
  const child = spawn(process.execPath, [resolve(here, "verify-ui.mjs"), ...process.argv.slice(2)], {
    env: { ...process.env, ...env, DBKIT_LAYOUT_LINT: "1" },
  });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => done({ name, code, out }));
});

const results = await Promise.all(RUNS.map(run));
let failed = false;
for (const r of results) {
  const summary = r.out.slice(r.out.indexOf("\n版面巡檢"));
  console.log(`\n==== ${r.name} ====${summary.startsWith("\n版面巡檢") ? summary : `\n${r.out.slice(-2000)}`}`);
  if (r.code !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
