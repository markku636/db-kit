// AI 資源庫的前端狀態：人設（agents/）、技能（skills/）、任務範本（prompts/）、輸出契約（contracts/）。
//
// 事實來源在檔案系統：內建（repo 的 ai-library/，隨 App 升級）< 個人（<設定目錄>/ai-library/）
// < 團隊資料夾（可多個）。分層、覆蓋與 lint 都在後端做（`ai_library_load`），GUI 與 dbk 共用一套；
// 前端只拿快照來挑語言變體與渲染。
//
// 快照回來之前（或在 vitest 裡）用打包進 bundle 的內建檔頂著：prompt builder 是同步函式，
// 呼叫端遍布編輯器 / 助手 / SSH，不能因為「資源庫還沒載完」就組不出提示。
import { create } from "zustand";
import {
  composeSystem,
  composeTask,
  fieldBool,
  fieldList,
  fieldStr,
  parseFrontmatter,
  type Fields,
  type Vars,
} from "./promptTemplate";
import { t, useLang } from "./i18n";

export type LibKind = "agent" | "skill" | "prompt" | "contract";

export interface LibVariant {
  fields: Fields;
  body: string;
  /** 檔案原文（編輯器顯示用）。 */
  raw: string;
  /** 磁碟路徑；內建為 `builtin:<相對路徑>`。 */
  path: string | null;
}

export interface LibSource {
  layer: string;
  layerLabel: string;
  path: string | null;
}

export interface LibEntry {
  kind: LibKind;
  name: string;
  /** 勝出的那一層：`builtin` | `personal` | `team:<n>`。 */
  layer: string;
  layerLabel: string;
  writable: boolean;
  /** 語言變體；`""` = 基底檔。 */
  variants: Record<string, LibVariant>;
  /** 被這一筆蓋掉的較低層（由高到低）。 */
  shadowed: LibSource[];
  /** 有覆蓋時附上內建版本，供「還原內建」與比對。 */
  builtin?: Record<string, LibVariant> | null;
}

export interface LibIssue {
  level: "error" | "warn" | "info";
  kind?: LibKind | null;
  name?: string | null;
  path?: string | null;
  message: string;
}

export interface TeamDir {
  path: string;
  label: string;
  writable: boolean;
}

export interface AiLibrarySettings {
  team_dirs: TeamDir[];
  assistant_persona: string | null;
  dba_persona: string | null;
  dba_persona_prod: string | null;
  panel_personas: string[];
  /** 助手對話勾選中的技能；null = 尚未從 localStorage 遷移。 */
  active_skills: string[] | null;
  sync: { claude_user: boolean; codex_user: boolean; project_dirs: string[]; include: string[] };
  migrated_local_v1: boolean;
}

export interface LibraryDirs {
  personal: string;
  teams: { path: string; label: string; writable: boolean; exists: boolean }[];
}

export interface LibrarySnapshot {
  entries: LibEntry[];
  issues: LibIssue[];
  dirs: LibraryDirs | null;
  settings: AiLibrarySettings;
}

export const DEFAULT_SETTINGS: AiLibrarySettings = {
  team_dirs: [],
  assistant_persona: "assistant",
  dba_persona: "dba-senior",
  dba_persona_prod: "dba-prod-gatekeeper",
  panel_personas: ["dba-performance", "dba-security", "dba-prod-gatekeeper"],
  active_skills: null,
  sync: { claude_user: true, codex_user: true, project_dirs: [], include: [] },
  migrated_local_v1: false,
};

// ---------------------------------------------------------------------------
// 內建檔（打包進 bundle 的 fallback）
// ---------------------------------------------------------------------------

export const LIB_LANGS = ["zh-TW", "zh-CN", "en", "ja", "ko", "vi"] as const;
const LANG_SET = new Set<string>(LIB_LANGS);

/** 與 src/i18n.ts 的 FALLBACK 同一張表：日 / 韓 / 越查無變體時退到英文。 */
const LANG_FALLBACK: Record<string, string> = { ja: "en", ko: "en", vi: "en" };

/** 把 `prompts/fix.en.md` 這類相對路徑拆成 (種類, 分組鍵, 語言)。不認得的路徑回 null。 */
export function classifyPath(rel: string): { kind: LibKind; group: string; lang: string; stem: string } | null {
  const p = rel.replace(/\\/g, "/").replace(/^\.?\/?/, "");
  const parts = p.split("/");
  const file = parts[parts.length - 1];
  if (!file.toLowerCase().endsWith(".md")) return null;
  const splitLang = (name: string): { stem: string; lang: string } => {
    const base = name.slice(0, -3);
    const dot = base.lastIndexOf(".");
    if (dot > 0 && LANG_SET.has(base.slice(dot + 1))) return { stem: base.slice(0, dot), lang: base.slice(dot + 1) };
    return { stem: base, lang: "" };
  };
  const top = parts[0];
  if (top === "skills") {
    if (parts.length !== 3) return null;
    const { stem, lang } = splitLang(file);
    if (stem !== "SKILL") return null;
    return { kind: "skill", group: `skills/${parts[1]}`, lang, stem: parts[1] };
  }
  const kind: LibKind | null = top === "agents" ? "agent" : top === "prompts" ? "prompt" : top === "contracts" ? "contract" : null;
  if (!kind || parts.length < 2) return null;
  if (kind !== "agent" && parts.length !== 2) return null;
  const { stem, lang } = splitLang(file);
  return { kind, group: `${parts.slice(0, -1).join("/")}/${stem}`, lang, stem };
}

/** 一組相對路徑 → 檔案內容，組成單層的 entries（不做分層；後端做）。 */
export function entriesFromFiles(files: Record<string, string>, layer: string, layerLabel: string, pathPrefix: string): LibEntry[] {
  const groups = new Map<string, { kind: LibKind; stem: string; variants: Record<string, LibVariant> }>();
  for (const [rel, raw] of Object.entries(files)) {
    const c = classifyPath(rel);
    if (!c) continue;
    const doc = parseFrontmatter(raw);
    const g = groups.get(c.group) ?? { kind: c.kind, stem: c.stem, variants: {} };
    g.variants[c.lang] = { fields: doc.fields, body: doc.body, raw, path: `${pathPrefix}${rel}` };
    groups.set(c.group, g);
  }
  const out: LibEntry[] = [];
  for (const g of groups.values()) {
    const base = g.variants[""];
    if (!base) continue;
    out.push({
      kind: g.kind,
      name: fieldStr(base.fields, "name")?.trim() || g.stem,
      layer,
      layerLabel,
      writable: false,
      variants: g.variants,
      shadowed: [],
      builtin: null,
    });
  }
  return out;
}

const BUILTIN_FILES: Record<string, string> = (() => {
  const raw = import.meta.glob("../ai-library/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k.replace(/^.*?ai-library\//, "")] = v;
  return out;
})();

export function builtinSnapshot(): LibrarySnapshot {
  return {
    entries: entriesFromFiles(BUILTIN_FILES, "builtin", "內建", "builtin:"),
    issues: [],
    dirs: null,
    settings: { ...DEFAULT_SETTINGS },
  };
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/** 存檔請求（對應後端 `ai_library::edit::SaveRequest`）。 */
export interface LibSaveRequest {
  kind: LibKind;
  name: string;
  new_name?: string | null;
  /** 語言變體；空字串 = 基底檔。 */
  lang?: string;
  /** 寫到哪一層：`personal` / `team:<n>`。 */
  layer: string;
  /** 只列要改的欄位：字串 = 純量、陣列 = 清單、null = 刪除。 */
  fields?: Record<string, string | string[] | null>;
  body?: string | null;
  /** 原文編輯模式：整份檔案內容（給了就忽略 fields / body）。 */
  raw?: string | null;
}

export type SyncAction = "create" | "update" | "unchanged" | "conflict" | "delete";

export interface SyncPlan {
  items: { target: string; path: string; action: SyncAction; source: string }[];
  mcp_hint: string;
}

export interface SyncReport {
  written: number;
  deleted: number;
  skipped: number;
  errors: string[];
}

interface AiLibraryStore {
  snapshot: LibrarySnapshot;
  /** 已拿到後端快照（false = 仍在用內建 fallback）。 */
  loaded: boolean;
  /** 最近一次載入 / 寫入失敗的訊息。 */
  error: string | null;
  setSnapshot: (s: LibrarySnapshot) => void;
}

export const useAiLibrary = create<AiLibraryStore>((set) => ({
  snapshot: builtinSnapshot(),
  loaded: false,
  error: null,
  setSnapshot: (s) => set({ snapshot: s, loaded: true, error: null }),
}));

// 延遲 import：讓本模組（被 prompt builder 靜態依賴）不把 Tauri runtime 拉進每一個單元測試。
async function backend() {
  return (await import("./api")).api;
}

async function withSnapshot(p: Promise<LibrarySnapshot>): Promise<LibrarySnapshot> {
  try {
    const s = await p;
    useAiLibrary.getState().setSnapshot(s);
    return s;
  } catch (e: any) {
    useAiLibrary.setState({ error: e?.message ?? String(e) });
    throw e;
  }
}

/** 從後端重新載入（啟動時、開資源庫對話框時、視窗取得焦點時）。失敗時保留目前的快照。 */
export async function loadAiLibrary(): Promise<LibrarySnapshot | null> {
  try {
    return await withSnapshot((await backend()).aiLibraryLoad());
  } catch {
    return null;
  }
}

export async function saveLibraryEntry(req: LibSaveRequest): Promise<LibrarySnapshot> {
  return withSnapshot((await backend()).aiLibrarySave(req));
}

export async function copyLibraryEntry(kind: LibKind, name: string, newName: string, layer: string): Promise<LibrarySnapshot> {
  return withSnapshot((await backend()).aiLibraryCopy(kind, name, newName, layer));
}

export async function deleteLibraryEntry(kind: LibKind, name: string, layer: string, lang?: string | null): Promise<LibrarySnapshot> {
  return withSnapshot((await backend()).aiLibraryDelete(kind, name, layer, lang));
}

/** 改設定（部分欄位即可）；寫檔成功才更新 store。 */
export async function updateLibrarySettings(patch: Partial<AiLibrarySettings>): Promise<LibrarySnapshot> {
  const cur = useAiLibrary.getState().snapshot.settings;
  return withSnapshot((await backend()).aiLibrarySettingsSet({ ...cur, ...patch }));
}

export function libSettings(): AiLibrarySettings {
  return useAiLibrary.getState().snapshot.settings;
}

export function findEntry(kind: LibKind, name: string, snap = useAiLibrary.getState().snapshot): LibEntry | null {
  return snap.entries.find((e) => e.kind === kind && e.name === name) ?? null;
}

export function entriesOf(kind: LibKind, snap = useAiLibrary.getState().snapshot): LibEntry[] {
  return snap.entries.filter((e) => e.kind === kind);
}

export interface Resolved {
  fields: Fields;
  body: string;
  /** 實際採用的語言（變體的語言，或基底檔宣告的 `dbkit-lang`，預設 zh-TW）。 */
  lang: string;
  path: string | null;
}

/** 依語言鏈（lang → 次選 → 基底）挑變體；變體的欄位疊在基底之上（名稱 / 說明可翻譯）。 */
export function resolveVariant(entry: LibEntry, lang: string): Resolved {
  const base = entry.variants[""];
  const chain = [lang, LANG_FALLBACK[lang]].filter((x): x is string => !!x);
  for (const l of chain) {
    const v = entry.variants[l];
    if (v) return { fields: { ...base.fields, ...v.fields }, body: v.body, lang: l, path: v.path };
  }
  return { fields: base.fields, body: base.body, lang: fieldStr(base.fields, "dbkit-lang") ?? "zh-TW", path: base.path };
}

function currentLang(): string {
  return useLang.getState().lang;
}

/** 顯示名稱：`dbkit-title` → `name`。 */
export function entryTitle(entry: LibEntry, lang = currentLang()): string {
  const r = resolveVariant(entry, lang);
  return fieldStr(r.fields, "dbkit-title")?.trim() || entry.name;
}

export function entryDescription(entry: LibEntry, lang = currentLang()): string {
  return fieldStr(resolveVariant(entry, lang).fields, "description")?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// 任務渲染
// ---------------------------------------------------------------------------

export interface TaskMeta {
  mode: string;
  contract: string | null;
  vars: string[];
  required: string[];
}

/** 任務登錄資訊一律取自基底檔（後端已把內建值疊進覆蓋檔的基底欄位）。 */
export function taskMeta(entry: LibEntry): TaskMeta {
  const f = entry.variants[""].fields;
  return {
    mode: fieldStr(f, "dbkit-mode") ?? "chat",
    contract: fieldStr(f, "dbkit-contract")?.trim() || null,
    vars: fieldList(f, "dbkit-vars"),
    required: fieldList(f, "dbkit-required"),
  };
}

export interface RenderedTask {
  text: string;
  /** 範本沒有直接輸出、已自動附在最後的必要變數。 */
  missing: string[];
  /** 範本實際採用的語言。 */
  lang: string;
}

/** 以指定本文（預覽 / 「編輯本次提示」用）或資源庫裡的範本渲染一個任務。 */
export function renderTaskWith(task: string, vars: Vars, opts: { lang?: string; body?: string } = {}): RenderedTask {
  const snap = useAiLibrary.getState().snapshot;
  const lang = opts.lang ?? currentLang();
  const entry = findEntry("prompt", task, snap) ?? findEntry("prompt", task, builtinSnapshot());
  if (!entry) throw new Error(`unknown AI task: ${task}`);
  const r = resolveVariant(entry, lang);
  const meta = taskMeta(entry);
  let contract: string | null = null;
  if (meta.contract) {
    // 契約只認內建層（後端已過濾）；語言跟著範本走，英文範本配英文契約。
    const c = findEntry("contract", meta.contract, snap) ?? findEntry("contract", meta.contract, builtinSnapshot());
    if (c) contract = resolveVariant(c, r.lang).body;
  }
  const { text, missing } = composeTask({ body: opts.body ?? r.body, vars, contract, required: meta.required });
  return { text, missing, lang: r.lang };
}

export function renderTask(task: string, vars: Vars, lang?: string): string {
  return renderTaskWith(task, vars, { lang }).text;
}

// ---------------------------------------------------------------------------
// 人設 / 技能
// ---------------------------------------------------------------------------

export type PersonaRole = "assistant" | "dba";

export function personas(role: PersonaRole, snap = useAiLibrary.getState().snapshot): LibEntry[] {
  return entriesOf("agent", snap).filter((e) => (fieldStr(e.variants[""].fields, "dbkit-role") ?? "assistant") === role);
}

export interface PersonaInfo {
  name: string;
  title: string;
  description: string;
  icon: string | null;
  body: string;
  skills: string[];
  maxTurns: number;
  dbTools: boolean;
  /** 允許的資料庫工具（去掉 `mcp__dbkit__` 前綴）；null = 全部。 */
  toolAllow: string[] | null;
}

export function personaInfo(entry: LibEntry, lang = currentLang()): PersonaInfo {
  const r = resolveVariant(entry, lang);
  const turns = Number(fieldStr(r.fields, "maxTurns"));
  const tools = fieldList(r.fields, "tools");
  const dbTools = tools.filter((x) => x.startsWith("mcp__dbkit__")).map((x) => x.slice("mcp__dbkit__".length));
  return {
    name: entry.name,
    title: fieldStr(r.fields, "dbkit-title")?.trim() || entry.name,
    description: fieldStr(r.fields, "description")?.trim() ?? "",
    icon: fieldStr(r.fields, "dbkit-icon")?.trim() || null,
    body: r.body,
    skills: fieldList(r.fields, "skills"),
    maxTurns: Number.isFinite(turns) && turns > 0 ? Math.min(40, Math.floor(turns)) : 10,
    dbTools: fieldBool(r.fields, "dbkit-db-tools", true),
    toolAllow: tools.length ? dbTools : null,
  };
}

export function skillInfo(entry: LibEntry, lang = currentLang()): { name: string; title: string; description: string; body: string } {
  const r = resolveVariant(entry, lang);
  return {
    name: entry.name,
    title: fieldStr(r.fields, "dbkit-title")?.trim() || entry.name,
    description: fieldStr(r.fields, "description")?.trim() ?? "",
    body: r.body,
  };
}

/**
 * 組某個人設的系統提示：人設本文 + 人設預載的技能 + 額外技能 + 片段（工具指引、SSH 守則…）。
 * 找不到人設時退回內建 `assistant`，再不行就只有片段——不讓一個打錯的設定值讓整個 AI 失能。
 */
export function personaSystemPrompt(
  personaName: string | null | undefined,
  opts: { extraSkills?: readonly string[]; fragments?: readonly string[]; lang?: string } = {},
): string {
  const snap = useAiLibrary.getState().snapshot;
  const lang = opts.lang ?? currentLang();
  const entry = (personaName ? findEntry("agent", personaName, snap) : null) ?? findEntry("agent", "assistant", snap);
  const info = entry ? personaInfo(entry, lang) : null;
  const names: string[] = [];
  for (const s of [...(info?.skills ?? []), ...(opts.extraSkills ?? [])]) if (!names.includes(s)) names.push(s);
  const skills = names
    .map((n) => findEntry("skill", n, snap))
    .filter((e): e is LibEntry => !!e)
    .map((e) => skillInfo(e, lang));
  return composeSystem(info?.body ?? "", skills, opts.fragments ?? [], t("技能"));
}
