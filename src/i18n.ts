import { useMemo } from "react";
import { create } from "zustand";

// 介面語言。以「繁中原文」作為 translation key，查無翻譯時回傳 key 本身（identity fallback）。
// 好處：未遷移的元件照常渲染中文、既有測試的中文斷言逐字元不變、不需發明上千個 dotted key。
export type Lang = "zh-TW" | "zh-CN" | "en" | "ja" | "ko";

const LANG_KEY = "dbkit:lang"; // 與 theme.ts 的 THEME_ID_KEY 同前綴

// 單一真相：工具列選單與設定對話框共用（避免 theme 目前那種兩處各寫一份 <option> 的漂移）。
// label 一律以該語言自己的寫法呈現，誤切之後才找得回自己的母語。
export const LANGUAGES: readonly { id: Lang; label: string }[] = [
  { id: "zh-TW", label: "繁體中文" },
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
];

/** 英文等有單複數之分的語言用；中文一律只填字串。 */
export interface Plural {
  one: string;
  other: string;
}

/** 翻譯表：繁中原文 → 譯文（或單複數對）。 */
export type Catalog = Readonly<Record<string, string | Plural>>;

/** 插值參數。`{name}` 佔位符對應同名 key；`n` 另有選擇單複數的語意。 */
export type Params = Readonly<Record<string, string | number>>;

function isLang(v: unknown): v is Lang {
  return LANGUAGES.some((l) => l.id === v);
}

/** 讀取偏好；無 / 不合法一律回 zh-TW（不偵測 OS locale，避免既有使用者升級後突然變英文）。 */
export function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (isLang(v)) return v;
  } catch {
    /* localStorage 不可用時退回預設 */
  }
  return "zh-TW";
}

/** 以 `{name}` 為佔位符做執行期取代（與 Rust 端 `tf!` 共用同一套慣例）。 */
export function interpolate(tpl: string, params?: Params): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

/** 依 `params.n` 選單 / 複數形；catalog 值為字串時直接回傳。 */
function selectForm(value: string | Plural, params?: Params): string {
  if (typeof value === "string") return value;
  return params && Number(params.n) === 1 ? value.one : value.other;
}

interface LangStore {
  lang: Lang;
  catalog: Catalog;
  /** 次選譯文表（見 FALLBACK）。查不到才用，查不到就 identity fallback 回繁中原文。 */
  fallback: Catalog;
  setLang: (l: Lang) => Promise<void>;
}

// 譯文表的載入器。zh-TW 是原文所以沒有表；其餘各語一包，vite 會各自切 chunk，
// 使用者只會下載自己那一包（＋下面 FALLBACK 指到的那一包）。
const LOADERS: Record<Exclude<Lang, "zh-TW">, () => Promise<{ default: Catalog }>> = {
  "zh-CN": () => import("./locales/zh-CN"),
  en: () => import("./locales/en"),
  ja: () => import("./locales/ja"),
  ko: () => import("./locales/ko"),
};

/**
 * 次選語言。日 / 韓查無譯文時退到英文，而不是直接露出繁中 ——
 * 對日文使用者來說中文漢字勉強能猜，對韓文使用者則完全無法閱讀；英文是兩者都通的最小公倍數。
 *
 * 簡中不列入：它的 key 就是繁中原文，退回原文本來就看得懂（只是字體是繁體），
 * 不值得為此多下載一包英文。
 */
const FALLBACK: Partial<Record<Lang, Lang>> = { ja: "en", ko: "en" };

async function loadOne(l: Lang): Promise<Catalog> {
  if (l === "zh-TW") return {};
  return (await LOADERS[l]()).default;
}

/** 載入某語言的主表與次選表。任一包載入失敗都讓呼叫端 catch，退回 identity fallback。 */
async function loadCatalog(l: Lang): Promise<Pick<LangStore, "catalog" | "fallback">> {
  const fb = FALLBACK[l];
  const [catalog, fallback] = await Promise.all([loadOne(l), fb ? loadOne(fb) : Promise.resolve({})]);
  return { catalog, fallback };
}

export const useLang = create<LangStore>((set) => ({
  lang: readStoredLang(),
  catalog: {},
  fallback: {},
  setLang: async (l) => {
    const { catalog, fallback } = await loadCatalog(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
    applyDocLang(l);
    // 後端（Tauri command）與 dbk CLI 共用 app_settings.json 的 lang；失敗不擋 UI 切換。
    // 延遲 import：讓 i18n.ts 不靜態相依 api.ts —— 否則每個 import 本模組的單元測試都會拉進
    // Tauri runtime，且 api.ts 日後想用 t() 就會形成循環。
    void import("./api").then(({ api }) => api.setLang(l)).catch(() => {});
    set({ lang: l, catalog, fallback });
  },
}));

function resolve(s: Pick<LangStore, "catalog" | "fallback">, zh: string, params?: Params): string {
  const hit = s.catalog[zh] ?? s.fallback[zh];
  return interpolate(hit === undefined ? zh : selectForm(hit, params), params);
}

/**
 * 翻譯。**module-level 函式**，可在 React 之外呼叫 —— 本專案的 `toast.*`、`uiConfirm`、
 * `paletteItems` builder、`dbErrors.ts` 都不在 render 階段，用 hook 取不到。
 *
 *   t("連線")                        → "Connect"
 *   t("已匯出 {n} 列", { n: 3 })      → "Exported 3 rows"
 */
export function t(zh: string, params?: Params): string {
  return resolve(useLang.getState(), zh, params);
}

/**
 * 元件內用：訂閱語言，使切換時重繪。
 *
 * 兩個刻意的性質：
 *
 * 1. **參考身分綁在 catalog 上**（而非永遠是同一個 `t`）。這樣它才能安全地放進
 *    `useMemo` / `useCallback` 的依賴陣列 —— 否則像 Sidebar 的 paletteItems 那種
 *    「在 useMemo 裡產生譯文」的地方，切語言後 memo 不會失效，畫面會留在舊語言。
 *
 * 2. **不把 catalog 關進閉包**，而是委派給讀取即時 store 的 `t`。元件裡的非同步
 *    callback（`catch (e) { toast.error(t("讀取失敗")) }`）常常在語言切換之後才執行；
 *    若閉包捕捉了當時的 catalog，那則 toast 會冒出上一個語言。委派後永遠是當前語言，
 *    因此 `t` 不放進依賴陣列也不會有正確性問題（eslint 的 exhaustive-deps 仍會提醒）。
 */
export function useT(): typeof t {
  const catalog = useLang((s) => s.catalog);
  // catalog 是刻意的「身分標記」而非被讀取的值：換了語言就換一個 t 參考，讓下游 memo 失效。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo<typeof t>(() => (zh, params) => t(zh, params), [catalog]);
}

/**
 * `<html lang>` 用的 BCP 47 標籤。中文兩種寫法必須分辨 script（`zh-Hant` / `zh-Hans`），
 * 否則瀏覽器可能挑到錯的字型（簡中字面配繁體字型會出現異體字）。
 * 匯出的產物（資料字典 / 資料庫文件 HTML）與 app 本身共用這個對照。
 */
export function htmlLangAttr(l: string): string {
  if (l.startsWith("zh-CN") || l.startsWith("zh-Hans")) return "zh-Hans";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("ko")) return "ko";
  if (l.startsWith("en")) return "en";
  return "zh-Hant";
}

/**
 * 給 LLM 的「請用這個語言回答」指示（AI 審查 / 調校 / 助手 / NL 轉查詢共用）。
 * 提示本文以繁中撰寫，故 zh-TW 回 `null`（不需多此一舉的指示）。
 */
export function replyLanguageLine(uiLang: string): string | null {
  if (uiLang.startsWith("en")) return "Reply in English.";
  if (uiLang.startsWith("ja")) return "日本語で回答してください。";
  if (uiLang.startsWith("ko")) return "한국어로 답변해 주세요.";
  if (uiLang.startsWith("zh-CN") || uiLang.startsWith("zh-Hans")) return "请用简体中文回答。";
  return null;
}

/**
 * 語言的英文名，供「請用 X 寫註解」這類**嵌在英文句子裡**的 prompt 片語使用。
 * zh-TW 回 `null`（prompt 原文即繁中，不需指示）。
 */
export function promptLanguageName(uiLang: string): string | null {
  if (uiLang.startsWith("en")) return "English";
  if (uiLang.startsWith("ja")) return "Japanese";
  if (uiLang.startsWith("ko")) return "Korean";
  if (uiLang.startsWith("zh-CN") || uiLang.startsWith("zh-Hans")) return "Simplified Chinese";
  return null;
}

/** 同步套用 <html lang>；供啟動時在首次繪製前呼叫。 */
export function applyDocLang(l: Lang): void {
  document.documentElement.lang = htmlLangAttr(l);
}
