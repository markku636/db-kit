// 把「模組初始化時就求值」的 t("…") 解回純字串字面值。**開發期工具，不進 build。**
//
// 為什麼：`const HEAD = { max_questions: t("查詢/時") }` 在 import 時求值一次，
// 之後切換語言不會重算 —— 畫面會停在啟動時的語言。
//
// 正確作法與 PALETTE_GROUP_LABEL 一致：常數表存「繁中原文」當資料，
// 到消費端（render / 呼叫時）才 t(TABLE[k])。本腳本只負責解包，消費端需人工補 t()。
//
//   node scripts/i18n-unwrap-module.mjs --dry
//   node scripts/i18n-unwrap-module.mjs
import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dry = process.argv.includes("--dry");

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p.replaceAll("\\", "/"));
  }
})("src");

/** 這個節點是否被任何函式包住？沒有 = 模組初始化時求值。 */
function insideFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) ||
        ts.isMethodDeclaration(p) || ts.isGetAccessor(p)) return true;
  }
  return false;
}

let total = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("t(")) continue;
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "t" &&
        n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0]) && !insideFunction(n)) {
      edits.push({ start: n.getStart(src), end: n.getEnd(), text: n.arguments[0].getText(src) });
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  if (!edits.length) continue;

  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (!dry) writeFileSync(file, out, "utf8");
  total += edits.length;
  console.log(`✓ ${file}: 解包 ${edits.length} 處（消費端需補 t()）`);
}
console.log(`\n合計解包 ${total} 處${dry ? "（dry-run）" : ""}`);
