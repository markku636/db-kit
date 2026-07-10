// i18n 覆蓋率棘輪：抽出所有 t("…") 的 key，比對 src/locales/en.ts。**開發期工具，不進 build。**
//
// 刻意**不**做成 eslint rule / build gate：遷移期間會讓建置長紅，扼殺「逐檔 commit」的節奏。
// 它的用途是回答兩個問題：
//   1. 還有哪些 key 沒有英文譯文？（缺漏）
//   2. 譯文表裡有哪些 key 已經沒人用了？（過時）
//
//   node scripts/i18n-scan.mjs             # 摘要 + 缺漏清單
//   node scripts/i18n-scan.mjs --json      # 缺漏的 key 陣列（給翻譯用）
//   node scripts/i18n-scan.mjs --stale     # 只列出過時的 key
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CJK = /[一-鿿]/;
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const onlyStale = args.includes("--stale");

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "locales") walk(p); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p.replaceAll("\\", "/"));
  }
})("src");

/** 收集 t("…") 的第一參數（字串字面值）。t(TABLE[k]) 這種動態 key 無法靜態解析，另外統計。 */
const used = new Map(); // key -> [file:line]
let dynamic = 0;
for (const f of files) {
  const src = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "t" && n.arguments.length) {
      const a = n.arguments[0];
      if (ts.isStringLiteral(a)) {
        if (CJK.test(a.text)) {
          const at = `${f}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
          if (!used.has(a.text)) used.set(a.text, []);
          used.get(a.text).push(at);
        }
      } else dynamic++;
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
}

// 從 en.ts 取 key（用 AST，避免執行它）
const enSrc = ts.createSourceFile("src/locales/en.ts", readFileSync("src/locales/en.ts", "utf8"), ts.ScriptTarget.Latest, true);
const translated = new Set();
(function walk(n) {
  if (ts.isPropertyAssignment(n)) {
    const k = n.name;
    if (ts.isStringLiteral(k)) translated.add(k.text);
    else if (ts.isIdentifier(k)) translated.add(k.text); // 中文可以當作合法的 identifier key
  }
  ts.forEachChild(n, walk);
})(enSrc);

const missing = [...used.keys()].filter((k) => !translated.has(k)).sort();
const stale = [...translated].filter((k) => CJK.test(k) && !used.has(k)).sort();

if (asJson) { console.log(JSON.stringify(missing, null, 2)); process.exit(0); }
if (onlyStale) { stale.forEach((k) => console.log(k)); process.exit(0); }

console.log(`使用中的 key：${used.size}`);
console.log(`已有英文譯文：${used.size - missing.length}`);
console.log(`缺英文譯文：  ${missing.length}`);
console.log(`過時（en.ts 有、程式碼沒用）：${stale.length}`);
console.log(`動態 key（t(TABLE[x])，無法靜態檢查）：${dynamic}`);

if (missing.length) {
  // 依檔案分組，方便逐檔補
  const byFile = new Map();
  for (const k of missing) {
    const f = used.get(k)[0].split(":")[0];
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(k);
  }
  console.log("\n缺漏（前 20 檔）：");
  [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)
    .forEach(([f, ks]) => console.log(`  ${String(ks.length).padStart(4)}  ${f}`));
}
process.exitCode = missing.length ? 1 : 0;
