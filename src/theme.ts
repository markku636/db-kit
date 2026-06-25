import { create } from "zustand";

export type Theme = "dark" | "light";

const STORAGE_KEY = "dbkit:theme";

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
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  theme: readStoredTheme(),
  setTheme: (t) => {
    applyTheme(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
    set({ theme: t });
  },
  toggle: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));
