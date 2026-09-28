// AI 資源庫（ai-library/）的範本引擎：frontmatter 解析 + Mustache 子集渲染 + 任務組裝。
//
// 與後端 src-tauri/src/ai_library/{frontmatter,render}.rs 是**同一份規格的兩個實作**：
// 前端的 prompt builder 必須是同步函式（呼叫端遍布編輯器、助手、SSH），而 `dbk run` 與審查並執行
// 的提示在後端組。兩邊用 tests/fixtures/ai-render-cases.json 這份共用案例互相釘住，改規格要兩邊一起改。
//
// 規格：
// - `{{name}}` 代入變數；未知變數輸出空字串。
// - `{{#name}}…{{/name}}` 變數非空（trim 後）才輸出；`{{^name}}…{{/name}}` 變數為空才輸出；可巢狀。
// - `{{! 註解 }}` 不輸出。
// - 單獨佔一行的區段標籤 / 註解（前後只有空白）整行移除，連同換行——範本才能一行一個標籤地寫。
// - 結果去掉尾端換行（檔案結尾的換行、最後一個區段收掉後留下的換行都不該進 prompt）。

export type Vars = Readonly<Record<string, string | null | undefined>>;
export type FieldValue = string | string[];
export type Fields = Record<string, FieldValue>;

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

export interface ParsedDoc {
  fields: Fields;
  body: string;
  hasFrontmatter: boolean;
}

function unquote(s: string): string {
  const v = s.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** 以逗號切開，但不切引號內的逗號。 */
function splitList(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(unquote).filter((x) => x !== "");
}

/** 未加引號的純量去掉行尾 ` # 註解`。 */
function stripComment(s: string): string {
  if (s.startsWith('"') || s.startsWith("'")) return s;
  const i = s.search(/\s#/);
  return i >= 0 ? s.slice(0, i).trimEnd() : s;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * 解析 `---` 包起來的扁平 YAML frontmatter。只認得本資源庫用得到的形狀：
 * `key: 純量`、`key: [a, b]`、`key:` 接 `- 項目` 區塊清單、`key: |` / `key: >` 區塊字串。
 * 其他（巢狀物件、Claude Code 的 hooks 之類）略過不解析——後端存檔時會原樣保留那幾行。
 */
export function parseFrontmatter(raw: string): ParsedDoc {
  const text = normalizeNewlines(raw);
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: {}, body: trimBody(text), hasFrontmatter: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { fields: {}, body: trimBody(text), hasFrontmatter: false };
  const fields: Fields = {};
  const fm = lines.slice(1, end);
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i];
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = stripComment((m[2] ?? "").trim());
    if (rest === "") {
      const items: string[] = [];
      let j = i + 1;
      for (; j < fm.length; j++) {
        const li = /^\s*-\s+(.*)$/.exec(fm[j]);
        if (li) items.push(unquote(stripComment(li[1].trim())));
        else if (!fm[j].trim()) continue;
        else break;
      }
      if (items.length) {
        fields[key] = items;
        i = j - 1;
      }
      continue;
    }
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const block: string[] = [];
      let j = i + 1;
      for (; j < fm.length && (/^\s/.test(fm[j]) || !fm[j].trim()); j++) block.push(fm[j]);
      const indent = Math.min(...block.filter((b) => b.trim()).map((b) => b.length - b.trimStart().length));
      const body = block.map((b) => b.slice(Number.isFinite(indent) ? indent : 0));
      fields[key] = (rest.startsWith("|") ? body.join("\n") : body.join(" ")).trim();
      i = j - 1;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      fields[key] = splitList(rest.slice(1, -1));
      continue;
    }
    fields[key] = unquote(rest);
  }
  return { fields, body: trimBody(lines.slice(end + 1).join("\n")), hasFrontmatter: true };
}

/** 本文去掉開頭空行與結尾換行（檔案結尾的換行不屬於 prompt）。 */
function trimBody(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function fieldStr(f: Fields, key: string): string | undefined {
  const v = f[key];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}

/** 清單欄位：接受 YAML 清單與逗號分隔字串（Claude Code 的 `tools: Read, Grep` 就是後者）。 */
export function fieldList(f: Fields, key: string): string[] {
  const v = f[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : splitList(v);
}

export function fieldBool(f: Fields, key: string, dflt = false): boolean {
  const v = fieldStr(f, key)?.trim().toLowerCase();
  if (v === undefined || v === "") return dflt;
  return v === "true" || v === "yes" || v === "1" || v === "on";
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

type Tok =
  | { k: "text"; s: string }
  | { k: "var"; name: string }
  | { k: "open"; name: string; inverted: boolean }
  | { k: "close"; name: string }
  | { k: "comment" };

const NAME_CH = /[A-Za-z0-9_.-]/;
const isWs = (c: string | undefined): boolean => c === " " || c === "\t";

/**
 * 在 line[i]（必為 `{{` 開頭）試著讀一個標籤；讀不成回 null（呼叫端把 `{` 當普通字元往前走一格）。
 * 刻意手寫而不用正規式：後端（Rust，沒有 regex crate）用同一套逐字元規則，兩邊才不會在邊角案例分岔。
 */
function readTag(line: string, i: number): { tok: Tok; end: number } | null {
  let j = i + 2;
  if (line[j] === "!") {
    const close = line.indexOf("}}", j + 1);
    return close < 0 ? null : { tok: { k: "comment" }, end: close + 2 };
  }
  while (isWs(line[j])) j++;
  let sigil = "";
  if (line[j] === "#" || line[j] === "^" || line[j] === "/") sigil = line[j++];
  while (isWs(line[j])) j++;
  const start = j;
  while (j < line.length && NAME_CH.test(line[j])) j++;
  if (j === start) return null;
  const name = line.slice(start, j);
  while (isWs(line[j])) j++;
  if (line[j] !== "}" || line[j + 1] !== "}") return null;
  const tok: Tok =
    sigil === "#" || sigil === "^" ? { k: "open", name, inverted: sigil === "^" }
    : sigil === "/" ? { k: "close", name }
    : { k: "var", name };
  return { tok, end: j + 2 };
}

function tokenizeLine(line: string): Tok[] {
  const out: Tok[] = [];
  let text = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "{" && line[i + 1] === "{") {
      const t = readTag(line, i);
      if (t) {
        if (text) out.push({ k: "text", s: text });
        text = "";
        out.push(t.tok);
        i = t.end;
        continue;
      }
    }
    text += line[i++];
  }
  if (text) out.push({ k: "text", s: text });
  return out;
}

/**
 * 逐行切 token。一行去掉前後空白（空格 / tab）後恰好是**一個**區段標籤或註解，就是「獨立行」：
 * 整行連同換行一起移除，範本才能一行一個標籤地寫而不留空行。
 */
function tokenize(tpl: string): Tok[] {
  const lines = normalizeNewlines(tpl).split("\n");
  const out: Tok[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
    const inner = tokenizeLine(trimmed);
    if (inner.length === 1 && (inner[0].k === "open" || inner[0].k === "close" || inner[0].k === "comment")) {
      out.push(inner[0]);
      return;
    }
    out.push(...tokenizeLine(line));
    if (i < lines.length - 1) out.push({ k: "text", s: "\n" });
  });
  return out;
}

export function truthy(v: string | null | undefined): boolean {
  return v != null && v.trim() !== "";
}

export function renderTemplate(tpl: string, vars: Vars): string {
  const toks = tokenize(tpl);
  const stack: { name: string; on: boolean }[] = [];
  let out = "";
  const active = () => stack.every((s) => s.on);
  for (const t of toks) {
    switch (t.k) {
      case "text":
        if (active()) out += t.s;
        break;
      case "var":
        if (active()) out += vars[t.name] ?? "";
        break;
      case "open": {
        const v = truthy(vars[t.name]);
        stack.push({ name: t.name, on: t.inverted ? !v : v });
        break;
      }
      case "close":
        // 名稱對不上的收尾標籤直接忽略（lint 會報）；不去亂關別的區段。
        if (stack.length && stack[stack.length - 1].name === t.name) stack.pop();
        break;
    }
  }
  return out.replace(/\n+$/, "");
}

/** 範本裡有沒有直接輸出這個變數（`{{name}}`，不含區段標籤）。 */
export function usesVar(tpl: string, name: string): boolean {
  return tokenize(tpl).some((t) => t.k === "var" && t.name === name);
}

/** 範本裡出現過的所有變數名（含區段），依出現順序去重，給 lint 比對「未知變數」。 */
export function referencedVars(tpl: string): string[] {
  const seen: string[] = [];
  for (const t of tokenize(tpl)) {
    if ((t.k === "var" || t.k === "open" || t.k === "close") && !seen.includes(t.name)) seen.push(t.name);
  }
  return seen;
}

/** 區段有沒有配對好：回傳第一個問題的描述（沒有問題回 null）。lint 用。 */
export function sectionProblem(tpl: string): string | null {
  const stack: string[] = [];
  for (const t of tokenize(tpl)) {
    if (t.k === "open") stack.push(t.name);
    else if (t.k === "close") {
      if (stack[stack.length - 1] !== t.name) return `{{/${t.name}}}`;
      stack.pop();
    }
  }
  return stack.length ? `{{#${stack[stack.length - 1]}}}` : null;
}

export interface ComposeInput {
  body: string;
  vars: Vars;
  /** 契約本文（未渲染）；無契約為 null。 */
  contract: string | null;
  required: readonly string[];
}

/**
 * 任務組裝：先渲染契約並當成 `{{contract}}` 變數，再渲染範本。
 * - 範本沒放 `{{contract}}`：契約附在最後——契約是解析器的依賴，使用者改範本時不可能把它弄丟。
 * - 必要變數沒被範本直接輸出：把該值附在最後（契約之前），並回報給 lint / 預覽顯示。
 */
export function composeTask(input: ComposeInput): { text: string; missing: string[] } {
  const contract = input.contract != null ? renderTemplate(input.contract, input.vars) : "";
  const vars = { ...input.vars, contract };
  let text = renderTemplate(input.body, vars);
  const missing = input.required.filter((r) => r !== "contract" && !usesVar(input.body, r));
  for (const r of missing) {
    const v = input.vars[r];
    if (truthy(v)) text = text ? `${text}\n\n${v}` : String(v);
  }
  if (contract && !usesVar(input.body, "contract")) text = text ? `${text}\n\n${contract}` : contract;
  return { text, missing };
}

/**
 * 系統提示組法（人設 + 預載技能 + 片段），與後端 `render::compose_system` 同一套。
 * skillLabel 是「技能」的在地化字樣（由呼叫端 t() 後傳入，保持本模組不相依 i18n）。
 */
export function composeSystem(
  persona: string,
  skills: readonly { title: string; body: string }[],
  fragments: readonly string[],
  skillLabel: string,
): string {
  const parts: string[] = [];
  if (persona.trim()) parts.push(persona.trim());
  for (const s of skills) {
    if (s.body.trim()) parts.push(`[${skillLabel}：${s.title}]\n${s.body.trim()}`);
  }
  for (const f of fragments) if (f.trim()) parts.push(f.trim());
  return parts.join("\n\n");
}
