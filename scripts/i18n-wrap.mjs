// i18n codemod：把原始碼裡的繁中字面值包成 t("…")。**開發期工具，不進 build。**
//
// 用 TypeScript 自己的 compiler API 走 AST，不用正則 —— 專案有 1,693 行中文註解，
// 正則分不出「註解」與「字串」，AST 天然分得出（註解不是節點）。
//
//   node scripts/i18n-wrap.mjs --dry src/ExportDialog.tsx     # 只看會改什麼
//   node scripts/i18n-wrap.mjs src/ExportDialog.tsx           # 就地改寫
//   node scripts/i18n-wrap.mjs --dry $(git ls-files 'src/*.tsx')
//
// 會處理：
//   JSX 文字、JSX 屬性字串、一般字串字面值、無插值的樣板字串、
//   插值樣板（轉成 t("… {n} …", { n })）
//
// 不會處理（列入 TODO 報告，交人工）：
//   - 一個元素裡有 ≥2 段中文文字節點（句子被 {expr} 切開，逐段翻譯必錯）
//   - 插值樣板的某個 span 是巢狀樣板 / 箭頭函式等複雜表達式
//   - 檔案裡已有名為 t 的區域變數（會被遮蔽）
//
// 硬性跳過：見 SKIP_FILES / SKIP_ATTRS / SKIP_DECLS。
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, dirname, basename } from "node:path";

const CJK = /[一-鿿]/;

// 整檔跳過。
const SKIP_FILES = new Set([
  "i18n.ts",        // 自己
  "brand.ts",       // 品牌名永不翻譯（且是 qland overlay 的 patch 錨點）
  "updateCheck.ts", // overlay 整檔覆蓋，兩份會 drift
]);

// 這些 JSX 屬性的字串不是給人看的。
const SKIP_ATTRS = new Set(["lang", "className", "key", "id", "type", "role", "name", "src", "href", "data-testid"]);

// 這些宣告底下的字串不可包：
//   DEFAULT_SNIPPETS      會被序列化進 localStorage，翻譯即污染使用者資料
//   PALETTE_GROUP_LABEL   這張表的值「就是」t() 的 key，包了會變成 t(t("連線"))
const SKIP_DECLS = new Set(["DEFAULT_SNIPPETS", "PALETTE_GROUP_LABEL"]);

const isCjk = (s) => CJK.test(s);
const q = (s) => JSON.stringify(s);

/**
 * 這個樣板是「產生 HTML / 多行文件」的骨架，不是一句文案。
 * 整段當成翻譯 key 會得到一個 800 字元、含標籤與插值的怪物；譯者無從下手，
 * 而且它內部的 ["欄位","型別",…] 本來就會被逐一包起來 —— 兩者的編輯區間會重疊。
 * 一律不動骨架，只包裡面的字串，骨架裡的文字（<h3>索引</h3>）列入 TODO 交人工。
 *
 * 注意 `-- 唯讀：GRANT SELECT ON ${q} TO <role>;` 這種要放行：它有 `<role>` 但沒有結束標籤。
 */
function isMarkupSkeleton(raw) {
  return raw.includes("\n") || /<\/[a-zA-Z]|<!DOCTYPE|<(table|html|head|body|div|span|li|ul|ol|h[1-6]|a\s|thead|tbody|tr|td|th)\b/i.test(raw);
}

/** 由檔案位置推出 import 路徑（src/ui/Modal.tsx → ../i18n）。 */
function i18nSpecifier(file) {
  const rel = relative(dirname(file), "src/i18n").replaceAll("\\", "/");
  return rel.startsWith(".") ? rel : "./" + rel;
}

/** 元件＝名稱首字大寫的 function 宣告 / 變數。hooks 只能放在這裡面。 */
function componentNameOf(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
    let p = node.parent;
    // const X = memo(function () {…}) / const X = (props) => …
    while (p && (ts.isCallExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  }
  return null;
}

/** 往上找最近的「元件函式」；找不到代表這個字串在 module scope 或普通工具函式裡。 */
function enclosingComponent(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isClassDeclaration(n)) return null; // class component 用不了 hook（ErrorBoundary）
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      const name = componentNameOf(n);
      if (name && /^[A-Z]/.test(name) && n.body && ts.isBlock(n.body)) return n;
    }
  }
  return null;
}

function underSkippedDecl(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && SKIP_DECLS.has(n.name.text)) return true;
  }
  return false;
}

/**
 * 這個節點在任何函式裡面嗎？不在 = 模組初始化時求值。
 *
 * 模組層級的常數表**不可**包 t()：它只在 import 時求值一次，切換語言不會重算。
 * 正確作法是常數存繁中原文當資料、消費端才 t(TABLE[k])（見 PALETTE_GROUP_LABEL）。
 * 這個守門也讓 codemod 具冪等性 —— 否則重跑會把 i18n-unwrap-module.mjs 的成果又包回去。
 */
function insideFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) ||
        ts.isMethodDeclaration(p) || ts.isGetAccessor(p)) return true;
  }
  return false;
}

function insideTCall(node) {
  const p = node.parent;
  return p && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "t" && p.arguments[0] === node;
}

function insideImportExport(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return true;
  }
  return false;
}

/**
 * 從表達式推一個像樣的佔位符名稱。譯者看到 `已匯出 {rows} 列（{bytes}）` 才知道要填什麼；
 * 看到 `{v1} {v2}` 只能猜。
 */
function nameOf(e) {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) return nameOf(e.expression);
  if (ts.isElementAccessExpression(e)) return nameOf(e.expression);
  if (ts.isCallExpression(e)) {
    // formatBytes(res.bytes) → bytes（先看引數，其次看被呼叫者）
    if (e.arguments.length === 1) {
      const a = nameOf(e.arguments[0]);
      if (a) return a;
    }
    return nameOf(e.expression);
  }
  return null;
}

/** 樣板字串 → ("鍵", { 參數 })。無法安全轉換時回 null（交人工）。 */
function templateToKey(node, src) {
  let key = node.head.text;
  const params = [];
  const used = new Set();
  for (const span of node.templateSpans) {
    const e = span.expression;
    // 三元 / 巢狀樣板 / 箭頭函式：把整句拆成兩種譯文才對，機器換不了。
    if (ts.isConditionalExpression(e) || ts.isTemplateExpression(e) || ts.isArrowFunction(e) ||
        ts.isBinaryExpression(e)) return null;

    let name = nameOf(e);
    if (!name || used.has(name) || !/^[A-Za-z_$][\w$]*$/.test(name)) name = `v${params.length + 1}`;
    used.add(name);
    params.push([name, e.getText(src)]);
    key += `{${name}}` + span.literal.text;
  }
  if (!isCjk(key)) return null;
  const args = params.map(([n, expr]) => (n === expr ? n : `${n}: ${expr}`)).join(", ");
  return { key, args };
}

function processFile(file, { dry }) {
  if (SKIP_FILES.has(basename(file))) return { file, skipped: "skip-list" };
  const text = readFileSync(file, "utf8");
  if (!isCjk(text)) return { file, skipped: "no-cjk" };

  const EOL = text.includes("\r\n") ? "\r\n" : "\n"; // 專案的 .tsx 是 CRLF，插入 LF 會產生混行尾
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];   // { start, end, text }
  const todos = [];
  let moduleConsts = 0; // 模組層級常數：刻意不包（見 insideFunction）
  const componentsNeedingT = new Set();
  let needsModuleT = false;

  const noteScope = (node) => {
    const comp = enclosingComponent(node);
    if (comp) componentsNeedingT.add(comp);
    else needsModuleT = true;
  };

  const visit = (node) => {
    // ---- JSX 文字（含 <>…</> 片段）----
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const texts = node.children.filter((c) => ts.isJsxText(c) && c.text.trim() !== "");
      const cjkTexts = texts.filter((c) => isCjk(c.text));
      if (cjkTexts.length > 1) {
        todos.push({ line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
                     why: "元素內有多段中文文字（句子被 {expr} 切開）", snippet: node.getText(src).slice(0, 90).replace(/\s+/g, " ") });
      } else if (cjkTexts.length === 1) {
        const c = cjkTexts[0];
        // 必須用 pos/end 而非 getStart()：JsxText 的 getStart() 會跳過前導空白，
        // 但 c.text 含空白 —— 兩者相減會讓替換區間右移，把句子前半截留在原地。
        const raw = text.slice(c.pos, c.end);
        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;
        const body = raw.slice(lead, raw.length - trail);
        edits.push({ start: c.pos + lead, end: c.end - trail, text: `{t(${q(body)})}` });
        noteScope(c);
      }
    }

    // ---- JSX 屬性 ----
    if (ts.isJsxAttribute(node) && node.initializer) {
      const attr = node.name.getText(src);
      if (!SKIP_ATTRS.has(attr)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init) && isCjk(init.text)) {
          edits.push({ start: init.getStart(src), end: init.getEnd(), text: `{t(${q(init.text)})}` });
          noteScope(init);
        }
      }
    }

    // ---- 一般字串 / 樣板 ----
    const skip = insideTCall(node) || insideImportExport(node) || underSkippedDecl(node);
    if (!skip && !insideFunction(node) && !ts.isJsxText(node) &&
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
        isCjk(node.getText(src))) {
      // 不是 TODO，是刻意如此：常數存繁中原文當資料，消費端 t(TABLE[k])。只計數。
      moduleConsts++;
      ts.forEachChild(node, visit);
      return;
    }
    if (!skip) {
      const inJsxAttr = node.parent && ts.isJsxAttribute(node.parent);
      const isKey = node.parent && (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) && node.parent.name === node;
      const inJsxText = node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent));

      const at = () => src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
      const snip = () => node.getText(src).slice(0, 90).replace(/\s+/g, " ");

      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isCjk(node.text) && !isKey && !inJsxAttr && !inJsxText) {
        if (isMarkupSkeleton(node.text)) todos.push({ line: at(), why: "多行 / HTML 字串", snippet: snip() });
        else {
          edits.push({ start: node.getStart(src), end: node.getEnd(), text: `t(${q(node.text)})` });
          noteScope(node);
        }
      } else if (ts.isTemplateExpression(node) && isCjk(node.getText(src))) {
        if (isMarkupSkeleton(node.getText(src))) {
          // 骨架不動，但要繼續往下走，讓裡面的 ["欄位","型別"] 之類的字串各自被包。
          todos.push({ line: at(), why: "HTML / 多行樣板骨架（只包內部字串，骨架文字交人工）", snippet: snip() });
          ts.forEachChild(node, visit);
          return;
        }
        const r = templateToKey(node, src);
        if (r) {
          edits.push({ start: node.getStart(src), end: node.getEnd(), text: `t(${q(r.key)}, { ${r.args} })` });
          noteScope(node);
          return; // 整個樣板已被取代 —— 不可再往下包 span 內的字串，否則編輯區間重疊、輸出必壞
        }
        todos.push({ line: at(), why: "插值樣板含複雜表達式", snippet: snip() });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(src);

  // 防呆：任何重疊的編輯都會在套用時把彼此的內容切碎。寧可整檔中止，也不要靜默產生壞碼。
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      const line = src.getLineAndCharacterOfPosition(sorted[i].start).line + 1;
      return { file, skipped: `編輯區間重疊（行 ${line} 附近）—— codemod 有 bug，未寫檔`, todos };
    }
  }

  if (edits.length === 0) return { file, skipped: "nothing-to-wrap", todos, moduleConsts };

  // 頂層已經有別的 t（如 editorThemes.ts 的 `import { tags as t }`）→ 加了 import 會 duplicate identifier。
  for (const st of src.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
    const nb = st.importClause.namedBindings;
    if (ts.isNamedImports(nb) && nb.elements.some((el) => el.name.text === "t" && st.moduleSpecifier.getText(src) !== `"${i18nSpecifier(file)}"`)) {
      return { file, skipped: "頂層已 import 名為 t 的符號 —— 請先改別名", todos };
    }
  }

  // 區域變數 t 會遮蔽 import 進來的 t —— 先改名再跑 codemod，否則靜默壞掉。
  // 含解構（`({ t }: {t: string})`、`const [s, t] = …`）—— 這類 BindingElement 最容易漏。
  const shadow = [];
  const findShadow = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        ts.isIdentifier(node.name) && node.name.text === "t") {
      shadow.push(src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1);
    }
    ts.forEachChild(node, findShadow);
  };
  findShadow(src);
  const realShadow = shadow.filter((line) => {
    const src2 = text.split(/\r?\n/)[line - 1] ?? "";
    return !src2.includes("useT()");
  });
  if (realShadow.length) return { file, skipped: `區域變數 t 遮蔽（行 ${realShadow.join(", ")}）—— 請先改名`, todos };

  // 每個需要 t 的元件插入 const t = useT();（已有則跳過）
  const compEdits = [];
  for (const comp of componentsNeedingT) {
    const body = comp.body;
    const already = body.statements.some((s) =>
      ts.isVariableStatement(s) && s.getText(src).includes("useT()"));
    if (already) continue;
    const pos = body.getStart(src) + 1; // 緊接在 `{` 之後
    compEdits.push({ start: pos, end: pos, text: `${EOL}  const t = useT();` });
  }

  // ---- 產生新內容 ----
  // 兩批編輯的偏移量都是相對於「原始」source，所以必須**合併後一起**由後往前套用。
  // 分兩趟做會讓第二趟踩在第一趟改過的字串上，插入點全部位移（實測：const t = useT()
  // 會插到 interface 主體、JSX 屬性中間、甚至字串字面值裡）。
  const all = [...edits, ...compEdits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of all) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  // import：module scope 的字串用 t，元件內用 useT（它會訂閱語言、讓切換時重繪）。
  // 檔案已經 import 過 ./i18n（例如 Phase 0 手工加的 useT）時要**併進去**，不是跳過 ——
  // 否則新增的 module-level t() 會找不到符號。
  const names = [];
  if (needsModuleT) names.push("t");
  if (componentsNeedingT.size) names.push("useT");
  if (names.length) {
    const spec = i18nSpecifier(file);
    const existing = src.statements.find(
      (s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === spec,
    );
    if (existing) {
      const nb = existing.importClause?.namedBindings;
      const have = nb && ts.isNamedImports(nb) ? nb.elements.map((el) => el.name.text) : [];
      const add = names.filter((n) => !have.includes(n));
      if (add.length && nb) {
        const merged = [...have, ...add].join(", ");
        // 這個位置在檔頭、在所有 wrap 之前，`out` 的前綴與原檔相同，直接用原始偏移量安全。
        out = out.slice(0, nb.getStart(src)) + `{ ${merged} }` + out.slice(nb.getEnd());
      }
    } else {
      const lastImport = src.statements.findLast(ts.isImportDeclaration);
      const at = lastImport ? lastImport.getEnd() : 0;
      out = out.slice(0, at) + `${EOL}import { ${names.join(", ")} } from "${spec}";` + out.slice(at);
    }
  }

  if (!dry) writeFileSync(file, out, "utf8");
  return { file, wrapped: edits.length, components: compEdits.length, todos, moduleConsts };
}

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("用法: node scripts/i18n-wrap.mjs [--dry] <file...>");
  process.exit(1);
}

let totalWrapped = 0, totalTodos = 0, totalConsts = 0;
for (const f of files) {
  const r = processFile(f.replaceAll("\\", "/"), { dry });
  if (r.skipped) {
    if (r.skipped !== "no-cjk" && r.skipped !== "nothing-to-wrap") console.log(`- ${r.file}: 跳過（${r.skipped}）`);
  } else {
    totalWrapped += r.wrapped;
    console.log(`✓ ${r.file}: 包了 ${r.wrapped} 處，注入 ${r.components} 個 const t = useT()`);
  }
  totalConsts += r.moduleConsts ?? 0;
  for (const td of r.todos ?? []) {
    totalTodos++;
    console.log(`  TODO ${r.file}:${td.line}  ${td.why}\n       ${td.snippet}`);
  }
}
console.log(`\n合計：包了 ${totalWrapped} 處，${totalTodos} 處需人工，` +
  `${totalConsts} 處模組層級常數（刻意不包，由消費端翻譯）${dry ? "（dry-run，未寫檔）" : ""}`);
