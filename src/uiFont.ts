import { create } from "zustand";

/**
 * 全域介面字級：整個 app 的 rem 基準。
 *
 * Tailwind 的字級（text-xs / text-sm…）與間距刻度（p-2 / gap-3 / w-7…）都是 rem，
 * 所以只要改 `<html>` 的 font-size，文字與版面會**等比**一起長大 —— 不會出現
 *「字變大了但列高沒跟上」的擠壓。實作上寫 CSS 變數 `--ui-font-size`，由 styles.css
 * 的 `:root { font-size: var(--ui-font-size) }` 消費（index.html 的開機腳本會在
 * React 掛載前先寫一次，避免先以預設字級繪製一幀再跳動）。
 *
 * 與**程式碼字級**（`--code-font-size`，見 ui/modalChrome.tsx）是兩件事：
 * 那個只管查詢編輯器與 SQL / JSON 等程式碼區塊，且以絕對 px 指定 —— 想把介面放大
 * 但把 SQL 維持在慣用字級（或反過來）是常見需求，硬綁在一起反而難用。
 */

export const UI_FONT_KEY = "dbkit:uiFontSize"; // 與 theme.ts / i18n.ts 同前綴

export const UI_FONT_DEFAULT = 16; // 瀏覽器預設值＝現行外觀（text-sm 即 14px）
export const UI_FONT_MIN = 12;
export const UI_FONT_MAX = 22;

/**
 * 設定對話框提供的刻度（px）。刻意只給 6 段而非任意數值：介面字級牽動整份版面，
 * 逐 px 微調既難挑也容易調出半殘的版位；文案（特小 / 小 / 標準…）寫在設定對話框裡，
 * 才進得了 t("…") 的 i18n 靜態掃描。
 */
export const UI_FONT_STEPS: readonly number[] = [12, 14, 16, 18, 20, 22];

/** 夾到合法範圍並取整；非數字（NaN / Infinity）一律回預設。 */
export function clampUiFontSize(px: number): number {
  if (!Number.isFinite(px)) return UI_FONT_DEFAULT;
  return Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, Math.round(px)));
}

/** 讀取偏好；無 / 不合法一律回預設（判準需與 index.html 的開機腳本一致）。 */
export function readStoredUiFontSize(): number {
  try {
    const n = Number(localStorage.getItem(UI_FONT_KEY));
    if (Number.isFinite(n) && n >= UI_FONT_MIN && n <= UI_FONT_MAX) return Math.round(n);
  } catch {
    /* localStorage 不可用時退回預設 */
  }
  return UI_FONT_DEFAULT;
}

/** 寫進 <html> 的 CSS 變數；styles.css 以 `:root { font-size: var(--ui-font-size) }` 消費。 */
export function applyUiFontSize(px: number) {
  document.documentElement.style.setProperty("--ui-font-size", `${px}px`);
}

interface UiFontStore {
  size: number; // 目前介面字級（px）
  setSize: (px: number) => void;
}

export const useUiFont = create<UiFontStore>((set) => {
  const initial = readStoredUiFontSize();
  // 模組載入即套一次：開機腳本沒跑到（測試 / 非 Tauri 環境）時仍能對齊儲存值。
  if (typeof document !== "undefined") applyUiFontSize(initial);
  return {
    size: initial,
    setSize: (px) => {
      const next = clampUiFontSize(px);
      applyUiFontSize(next);
      try {
        localStorage.setItem(UI_FONT_KEY, String(next));
      } catch {
        /* 忽略：偏好存不下來不影響本次生效 */
      }
      set({ size: next });
    },
  };
});
