import { create } from "zustand";
import { isEditorThemeChoice, type EditorThemeChoice } from "./editorThemes";

export type Theme = "dark" | "light";

const STORAGE_KEY = "dbkit:theme";
const EDITOR_THEME_KEY = "dbkit:editorTheme";

// 編輯器語法高亮主題偏好：預設 "auto"（跟隨 App 深淺色）；未知殘值容錯回 auto。
export function readStoredEditorTheme(): EditorThemeChoice {
  try {
    const v = localStorage.getItem(EDITOR_THEME_KEY);
    if (v && isEditorThemeChoice(v)) return v;
  } catch {
    /* localStorage 不可用時退回預設 */
  }
  return "auto";
}

// 讀取偏好：localStorage 優先。首次啟動預設深色（維持 db-kit 既有深色品牌與開場動畫一致性）。
export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* localStorage 不可用時退回預設 */
  }
  return "dark";
}

// 套用到 <html>：亮色加上 .light，深色移除（深色為 :root 預設）。
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("light", theme === "light");
}

interface ThemeStore {
  theme: Theme;
  editorTheme: EditorThemeChoice;
  setTheme: (t: Theme) => void;
  setEditorTheme: (t: EditorThemeChoice) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  theme: readStoredTheme(),
  editorTheme: readStoredEditorTheme(),
  setTheme: (t) => {
    applyTheme(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
    set({ theme: t });
  },
  setEditorTheme: (t) => {
    try {
      localStorage.setItem(EDITOR_THEME_KEY, t);
    } catch {
      /* ignore */
    }
    set({ editorTheme: t });
  },
  toggle: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));
