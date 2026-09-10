// 產生簡體中文對照表：`src/locales/zh-CN.ts` 與 `src-tauri/src/locales/zh_cn.rs`。
//
//   node scripts/i18n-gen-zhcn.mjs            # 重新產生兩個檔案
//   node scripts/i18n-gen-zhcn.mjs --audit 列  # 只列出含某字的轉換結果，供人工複查
//
// 為什麼用產生的、而不是像 ja / ko 那樣手寫？
//   簡中與繁中的差異是**系統性**的：字形（資料→资料）＋用語（軟體→软件）。逐條手打 2500 句
//   只會引入手滑，交給 OpenCC 反而逐字精準；真正需要人判斷的只有下面 GLOSSARY 那份詞表。
//
// 兩段式轉換：
//   1. GLOSSARY —— OpenCC 會轉錯或不會轉的**領域用語**，先換成哨兵（sentinel）佔位。
//      這些是台灣 / 大陸資料庫術語真正分歧的地方：查詢≠查找、交易=事務、預存程序=存儲過程，
//      以及最容易錯的「列」：台灣的「列」是 row（大陸叫「行」）、「欄」是 column（大陸叫「列」）。
//   2. OpenCC `twp → cn` —— 其餘部分做字形＋通用 IT 用語轉換（軟體→软件、檔案→文件…）。
//   哨兵是控制字元，OpenCC 不會動它，最後再換回譯文，因此 GLOSSARY 的結果不會被二次轉換。
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const OpenCC = require("opencc-js");

const convert = OpenCC.Converter({ from: "twp", to: "cn" });

// ---- 詞表 ----------------------------------------------------------------
// 一律「繁中原文 → 簡中譯詞」。長詞優先套用（下方會自動依長度排序），故 `欄位` 會先於 `欄` 命中。

/**
 * 不可被「列 → 行」「欄 → 列」波及的詞：這裡的「列」不是 row（佇列 / 列印 / 列出…）。
 * 值為 OpenCC 的轉換結果，唯獨 UI 元件名（工具列 / 狀態列…）大陸叫「欄」，只能手動指定。
 */
const KEEP = {
  佇列: "队列", 列印: "打印", 列表: "列表", 列出: "列出", 列舉: "枚举", 序列: "序列",
  陣列: "数组", 排列: "排列", 系列: "系列", 並列: "并列", 條列: "条列", 羅列: "罗列", 明列: "明列",
  工具列: "工具栏", 狀態列: "状态栏", 命令列: "命令行", 側欄: "侧边栏",
  // 「標題列」兩義：跳窗的 title bar（→ 标题栏）與表格的表頭列（→ 标题行，AXIS 已處理）。
  // 只鎖定前者的完整說法，長鍵先命中，不誤傷「已複製整列（含標題列）」。
  跳窗標題列: "跳窗标题栏",
  欄位: "字段", 欄名: "字段名",
};

/**
 * 領域用語表。挑選標準：OpenCC 轉出來**語意會跑掉**的詞。
 * 純字形差異（資料→资料）不列在這裡，交給 OpenCC。
 */
const GLOSSARY = {
  // 資料庫核心術語 —— OpenCC 會轉成日常用語，在 DB 情境下是錯的
  查詢: "查询", // OpenCC → 查找
  預存程序: "存储过程", // OpenCC → 预存进程
  交易: "事务", // DB transaction；OpenCC 原樣保留成「交易」
  定序: "排序规则", // collation
  資料列: "数据行",
  列數: "行数",
  筆數: "条数",
  分割區: "分区",
  位移: "偏移量", // Kafka offset
  唯讀: "只读",
  設定檔: "配置文件",
  預設: "默认", // OpenCC 只做字形 → 预设
  範本: "模板",
  序列化: "序列化",
  執行緒: "线程", // 必須早於「執行」命中，否則會變成「执行绪」
  執行: "执行", // OpenCC → 运行；SQL 情境一律「执行」
  指標: "指标", // OpenCC → 指针；這裡講的是效能指標
  回傳: "返回",
  傳回: "返回",
  語意: "语义",
  工作階段: "会话", // session
  萬用字元: "通配符",

  // 一般軟體用語
  複製: "复制", // OpenCC → 拷贝
  套用: "应用",
  復原: "恢复", // 全部出現在「此操作無法復原」
  產生: "生成",
  尋找: "查找",
  略過: "跳过",
  逾時: "超时",
  憑證: "证书", // TLS cert；OpenCC → 凭证（單據）
  帳號: "账号", // 帐 → 账
  帳戶: "账户",
  位元組: "字节",
  位元: "位",
  字級: "字号", // font size；OpenCC → 字级，大陸慣用「字号」
  新增: "新增", // 大陸同樣通用，擋掉 OpenCC 的「添加」以免與「附加」混用
};

/** 整句覆寫：同一個詞在不同句子裡語意不同，只能逐句指定。 */
const SENTENCE = {
  // 「檢視」多數是動詞（查看），少數是 SQL VIEW 這個物件（视图）
  檢視: "视图",
  "檢視 / 編輯內容…": "查看 / 编辑内容…",
  "檢視 / 複製建表 SQL（CREATE 語句）": "查看 / 复制建表 SQL（CREATE 语句）",
  "設計檢視：": "设计视图：",
  "設計檢視…": "设计视图…",
  "新增檢視…": "新增视图…",
  "只篩選此資料庫的表 / 檢視 / 函式名稱": "只筛选此数据库的表 / 视图 / 函数名称",
  "命名空間樹狀檢視（依 : 分組）": "命名空间树状视图（依 : 分组）",

  // 這裡的「欄」指單一儲存格所屬的欄位（→ 字段），不是 AXIS 的 欄→列；
  // 而「目前」在大陸慣用「当前」，但整體換掉會波及太多句子，故逐句指定。
  "產生 UPDATE 腳本（僅此欄）": "生成 UPDATE 脚本（仅此字段）",
  "以目前內容產生 UPDATE 腳本，送到查詢編輯器（不直接寫入資料庫）":
    "以当前内容生成 UPDATE 脚本，送到查询编辑器（不直接写入数据库）",
};

// ---- 轉換 ----------------------------------------------------------------

const RULES = [...Object.entries(KEEP), ...Object.entries(GLOSSARY)].sort(
  (a, b) => b[0].length - a[0].length,
);

/**
 * 台灣的「列」是 row、「欄」是 column，大陸剛好各挪一格（行 / 列）。
 * 先做 列→行 再做 欄→列，順序不能顛倒：否則「欄」轉出來的「列」會被下一條再轉成「行」。
 * KEEP 已在前面吃掉所有不是 row 的「列」。
 */
const AXIS = [["列", "行"], ["欄", "列"]];

function toSimplified(zh) {
  if (Object.hasOwn(SENTENCE, zh)) return SENTENCE[zh];

  const kept = [];
  const stash = (repl) => `\u0001${kept.push(repl) - 1}\u0001`;
  let s = zh;
  for (const [from, to] of RULES) s = s.replaceAll(from, () => stash(to));
  for (const [from, to] of AXIS) s = s.replaceAll(from, () => stash(to));
  return convert(s).replace(/\u0001(\d+)\u0001/g, (_, i) => kept[Number(i)]);
}

// ---- 取 key ---------------------------------------------------------------

/** 前端：從 en.ts 取 key（用 AST，避免執行它）。保留原順序，兩個檔並排看得出對應。 */
function frontendKeys() {
  const path = "src/locales/en.ts";
  const src = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const keys = [];
  (function walk(n) {
    if (ts.isPropertyAssignment(n)) {
      const k = n.name;
      const name = ts.isStringLiteral(k) ? k.text : ts.isIdentifier(k) ? k.text : null;
      // one / other 是單複數子鍵，不是 translation key
      if (name && name !== "one" && name !== "other") keys.push(name);
    }
    ts.forEachChild(n, walk);
  })(src);
  return keys;
}

/** 後端：從 en.rs 的 match 臂取左側字面值。 */
function backendKeys() {
  const src = readFileSync("src-tauri/src/locales/en.rs", "utf8");
  const keys = [];
  for (const line of src.split("\n")) {
    const m = /^\s*"((?:[^"\\]|\\.)*)"\s*=>/.exec(line);
    if (m) keys.push(JSON.parse(`"${m[1]}"`));
  }
  return keys;
}

// ---- 產生 -----------------------------------------------------------------

const HEADER_TS = `import type { Catalog } from "../i18n";

// 繁中原文 → 簡體中文對照表。**由 \`node scripts/i18n-gen-zhcn.mjs\` 產生，請勿手改。**
//
// 要修正用詞請改產生器裡的 GLOSSARY / SENTENCE 再重跑 —— 直接改這裡會在下次重跑時被蓋掉。
// 轉換方式見該腳本開頭：領域詞表（查詢→查询、列→行…）＋ OpenCC twp→cn。
//
// key 順序與 en.ts 完全一致，兩檔並排即可逐條比對。
const zhCN: Catalog = {
`;

function emitFrontend() {
  const keys = frontendKeys();
  const body = keys
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(toSimplified(k))},`)
    .join("\n");
  writeFileSync("src/locales/zh-CN.ts", `${HEADER_TS}${body}\n};\n\nexport default zhCN;\n`, "utf8");
  return keys.length;
}

function emitBackend() {
  const keys = backendKeys();
  const body = keys
    .map((k) => `        ${JSON.stringify(k)} => ${JSON.stringify(toSimplified(k))},`)
    .join("\n");
  const out = `//! 繁中原文 → 簡體中文對照表。**由 \`node scripts/i18n-gen-zhcn.mjs\` 產生，請勿手改。**
//!
//! 要修正用詞請改產生器裡的 GLOSSARY / SENTENCE 再重跑。key 與 \`en.rs\` 一一對應。
#![allow(clippy::match_same_arms)]

/// 查表：找到回簡中，否則 \`None\`（由 \`i18n::lookup\` 做 identity fallback）。
pub fn lookup(zh: &str) -> Option<&'static str> {
    Some(match zh {
${body}
        _ => return None,
    })
}
`;
  writeFileSync("src-tauri/src/locales/zh_cn.rs", out, "utf8");
  return keys.length;
}

const auditAt = process.argv.indexOf("--audit");
if (auditAt >= 0) {
  const needle = process.argv[auditAt + 1] ?? "";
  const seen = new Set();
  for (const k of [...frontendKeys(), ...backendKeys()]) {
    if (!k.includes(needle) || seen.has(k)) continue;
    seen.add(k);
    console.log(`${k.replace(/\n/g, "\\n")}\n  → ${toSimplified(k).replace(/\n/g, "\\n")}`);
  }
  process.exit(0);
}

console.log(`src/locales/zh-CN.ts：${emitFrontend()} 條`);
console.log(`src-tauri/src/locales/zh_cn.rs：${emitBackend()} 條`);
