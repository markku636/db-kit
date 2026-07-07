import { create } from "zustand";
import { EDITOR_THEMES, getEditorThemeDef, buildAppVars, type EditorThemeId } from "./editorThemes";

// 深 / 淺（派生自目前變體，供既有消費者：ThemeToggle、編輯器 resolveEditorTheme 的 appTheme 參數）。
export type Theme = "dark" | "light";

const THEME_ID_KEY = "dbkit:themeId";
const LEGACY_THEME_KEY = "dbkit:theme"; // 舊：app 深/淺
const LEGACY_EDITOR_KEY = "dbkit:editorTheme"; // 舊：編輯器配色（auto + 7 寶石）

// 統一主題：整個 app 由單一「變體」驅動。預設深色＝Amethyst(Dracula Pro)；淺色＝Moonstone(Alucard)。
const DEFAULT_DARK: EditorThemeId = "amethyst";
const LIGHT_ID: EditorThemeId = "moonstone";

function isThemeId(v: unknown): v is EditorThemeId {
  return typeof v === "string" && EDITOR_THEMES.some((d) => d.id === v);
}

function themeOf(id: EditorThemeId): Theme {
  return getEditorThemeDef(id)?.dark ? "dark" : "light";
}

// 讀取偏好：新 key 優先；否則相容遷移舊 key（editorTheme 的寶石 → 直接用；auto/無 → 依舊 app 深/淺）。
export function readStoredThemeId(): EditorThemeId {
  try {
    const v = localStorage.getItem(THEME_ID_KEY);
    if (isThemeId(v)) return v;
    const oldEditor = localStorage.getItem(LEGACY_EDITOR_KEY);
    if (isThemeId(oldEditor)) return oldEditor; // 舊指定寶石（排除 "auto"）
    if (localStorage.getItem(LEGACY_THEME_KEY) === "light") return LIGHT_ID;
  } catch {
    /* localStorage 不可用時退回預設 */
  }
  return DEFAULT_DARK;
}

// 把變體整套 --c-* 寫進 <html>，並依深/淺 toggle .light（色階由 styles.css 的 rgb(var(--x)/alpha) 消費）。
export function applyAppTheme(id: EditorThemeId) {
  const def = getEditorThemeDef(id);
  if (!def) return;
  const root = document.documentElement;
  for (const [k, val] of Object.entries(buildAppVars(def))) root.style.setProperty(k, val);
  root.classList.toggle("light", !def.dark);
}

interface ThemeStore {
  themeId: EditorThemeId; // 單一真相：目前套用的變體
  theme: Theme; // 派生（dark/light），供既有消費者
  darkVariant: EditorThemeId; // 記住上次深色變體，供深/淺切換還原
  setThemeId: (id: EditorThemeId) => void;
  toggle: () => void; // 深色變體 ⇄ Alucard(淺)
}

export const useTheme = create<ThemeStore>((set, get) => {
  const initial = readStoredThemeId();
  return {
    themeId: initial,
    theme: themeOf(initial),
    darkVariant: themeOf(initial) === "dark" ? initial : DEFAULT_DARK,
    setThemeId: (id) => {
      applyAppTheme(id);
      try {
        localStorage.setItem(THEME_ID_KEY, id);
      } catch {
        /* ignore */
      }
      set((s) => ({
        themeId: id,
        theme: themeOf(id),
        darkVariant: themeOf(id) === "dark" ? id : s.darkVariant,
      }));
    },
    toggle: () => {
      const s = get();
      s.setThemeId(s.theme === "light" ? s.darkVariant : LIGHT_ID);
    },
  };
});
