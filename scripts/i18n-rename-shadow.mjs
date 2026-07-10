// 把區域變數 / 參數名 `t` 改名，讓 i18n 的 t() 不被遮蔽。**開發期工具，不進 build。**
//
// 為何不能只用正則：`t` 是一個字母，正則分不出「同一個 binding 的所有引用」與「別的 t」。
// 這裡用 TypeScript LanguageService 的 findRenameLocations —— 它做的是真正的 scope 分析。
//
//   node scripts/i18n-rename-shadow.mjs --dry
//   node scripts/i18n-rename-shadow.mjs
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";

const dry = process.argv.includes("--dry");

const cfg = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ".");
// 一律用絕對路徑當 key：findRenameLocations 回傳的 fileName 是絕對路徑，
// 若這裡存相對路徑，寫回會落到另一個 map 條目、原檔永遠不變（症狀：同一個 binding 無限改名）。
const abs = (f) => ts.sys.resolvePath(f).replaceAll("\\", "/");
const fileNames = parsed.fileNames.filter((f) => !f.includes(".test.")).map(abs);

const versions = new Map(fileNames.map((f) => [f, 0]));
const contents = new Map(fileNames.map((f) => [f, readFileSync(f, "utf8")]));

const host = {
  getScriptFileNames: () => fileNames,
  getScriptVersion: (f) => String(versions.get(f) ?? 0),
  getScriptSnapshot: (f) =>
    contents.has(f) ? ts.ScriptSnapshot.fromString(contents.get(f)) : (ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f)) : undefined),
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => parsed.options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());

/** 依宣告的形狀挑一個有意義的新名字。看不出來就用 item / val。 */
function pickName(decl, src) {
  if (ts.isParameter(decl)) {
    // 找外層呼叫：xs.map((t) => …) 的 xs
    let call = decl.parent?.parent;
    while (call && !ts.isCallExpression(call)) call = call.parent;
    const recv = call && ts.isPropertyAccessExpression(call.expression)
      ? call.expression.expression.getText(src) : "";
    if (/tables?$/i.test(recv) || /\btables\b/i.test(recv)) return "tbl";
    if (/THEMES?$/i.test(recv)) return "th";
    if (/toasts?$/i.test(recv)) return "n";
    if (/tabs?$/i.test(recv)) return "tab";
    if (/types?$|presets?$/i.test(recv)) return "opt";
    if (/views?$/i.test(recv)) return "view";
    // 型別註記是 string 的獨立函式參數（如 canViewDef(t: string)）
    if (decl.type && decl.type.kind === ts.SyntaxKind.StringKeyword) return "kind";
    return "item";
  }
  const init = decl.initializer;
  const txt = init ? init.getText(src) : "";
  if (/^setTimeout|^setInterval|^window\.setTimeout/.test(txt)) return "timer";
  if (/\.trim\(\)$/.test(txt)) return "trimmed";
  if (/\.target\b/.test(txt)) return "target";
  if (/uiPrompt|prompt\(/.test(txt)) return "input";
  if (/routine_type/.test(txt)) return "routineType";
  if (/tableByName|\.tables\b/.test(txt)) return "tbl";
  if (/new Set|Set\(/.test(txt)) return "seen";
  return "val";
}

/**
 * 這個檔案裡有「非註解」的中文嗎？只有這種檔案之後會被插入 t(…)，才需要清 shadow。
 * 用 AST 判斷（註解不是節點），避免把 fuzzy.ts 這類只有中文註解的檔案也改掉。
 */
const CJK = /[一-鿿]/;
function hasTranslatableCjk(file) {
  const src = ts.createSourceFile(file, contents.get(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const walk = (n) => {
    if (found) return;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n) || ts.isTemplateExpression(n)) &&
        CJK.test(n.getText(src))) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return found;
}

/** 收集所有名為 t、且不是 `const t = useT()` 的宣告位置。 */
function collect(file) {
  const src = ts.createSourceFile(file, contents.get(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const walk = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        ts.isIdentifier(node.name) && node.name.text === "t") {
      const isTranslator = node.initializer && /useT\(\)/.test(node.initializer.getText(src));
      if (!isTranslator) out.push({ pos: node.name.getStart(src), name: pickName(node, src) });
    }
    ts.forEachChild(node, walk);
  };
  walk(src);
  return out;
}

// 一次處理一個宣告：rename → 立刻更新記憶體內容 + version，避免位移失效。
let renamed = 0;
const seen = new Set();
const targets = fileNames.filter(hasTranslatableCjk);
console.log(`掃描 ${targets.length} / ${fileNames.length} 個有可翻譯中文的檔案\n`);
for (const file of targets) {
  for (;;) {
    const decls = collect(file);
    if (!decls.length) break;
    const { pos, name } = decls[0];
    const locs = service.findRenameLocations(file, pos, false, false, {});
    if (!locs?.length) { console.error(`! ${file}@${pos}: 找不到 rename 位置`); break; }

    if (seen.has(`${file}:${pos}`)) {
      console.error(`! ${file}@${pos}: 改名沒生效（同一位置被處理兩次）—— 中止`);
      process.exit(1);
    }
    seen.add(`${file}:${pos}`);

    // 依檔案分組套用（同一個 binding 的引用可能跨檔 —— 匯出的 helper 參數）
    const byFile = new Map();
    for (const l of locs) {
      const f = l.fileName.replaceAll("\\", "/");
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(l.textSpan);
    }
    for (const [f, spans] of byFile) {
      let text = contents.get(f) ?? readFileSync(f, "utf8");
      for (const s of [...spans].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, s.start) + name + text.slice(s.start + s.length);
      }
      contents.set(f, text);
      versions.set(f, (versions.get(f) ?? 0) + 1);
    }
    renamed++;
    console.log(`  ${file}: t → ${name} (${locs.length} 處引用)`);
  }
}

if (!dry) for (const [f, text] of contents) writeFileSync(f, text, "utf8");
console.log(`\n改名 ${renamed} 個 binding${dry ? "（dry-run，未寫檔）" : ""}`);
