import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AArrowDown, AArrowUp, Maximize2, Minimize2 } from "lucide-react";
import IconButton from "./IconButton";
import { useT } from "../i18n";

/**
 * 跳窗的檢視偏好：最大化 / 還原，與程式碼字級。
 *
 * 兩者都是**全域**偏好而非 per-跳窗 state —— 看一份長預存程序常常要連開好幾個跳窗
 *（清單 → 編輯 → 執行結果），每開一個都要重新放大一次沒有意義。存進 localStorage，
 * 重開 app 也留著。
 *
 * 字級走 CSS 變數 `--code-font-size`：三個 CodeMirror 編輯器的主題與 `.code-scale`
 * 區塊都讀它，所以查詢編輯器本體會跟著一起變。同一件事只有一個開關，不會出現
 *「跳窗裡放大了、關掉跳窗又變回小字」。
 */

const MAX_KEY = "db-kit:modalMaximized";
const FONT_KEY = "db-kit:codeFontSize";

export const CODE_FONT_DEFAULT = 13;
export const CODE_FONT_MIN = 10;
export const CODE_FONT_MAX = 28;

/** 最大化時蓋掉外殼自己的 w-[…] / h-[…] / max-w-[…] / 圓角（Tailwind `!` = important）。 */
export const MAXIMIZED_SHELL = "!w-screen !h-screen !max-w-none !max-h-none !rounded-none";

function readFont(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(n) && n >= CODE_FONT_MIN && n <= CODE_FONT_MAX) return n;
  } catch {
    /* localStorage 不可用時用預設 */
  }
  return CODE_FONT_DEFAULT;
}

function readMaximized(): boolean {
  try {
    return localStorage.getItem(MAX_KEY) === "1";
  } catch {
    return false;
  }
}

let maximized = readMaximized();
let codeFontSize = readFont();

const subs = new Set<() => void>();
const emit = () => subs.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};

// 字級是 CSS 變數，寫在 <html> 上讓整個 app（含跳窗外的查詢編輯器）一起生效。
// 模組載入即套一次：CodeMirror 主題以 var() 取值，變數沒設好會退回 fallback 而閃一下小字。
function applyFont() {
  document.documentElement.style.setProperty("--code-font-size", `${codeFontSize}px`);
}
applyFont();

export function setCodeFontSize(px: number) {
  const next = Math.min(CODE_FONT_MAX, Math.max(CODE_FONT_MIN, Math.round(px)));
  if (next === codeFontSize) return;
  codeFontSize = next;
  applyFont();
  try { localStorage.setItem(FONT_KEY, String(next)); } catch { /* 忽略 */ }
  emit();
}

export function setMaximized(next: boolean) {
  if (next === maximized) return;
  maximized = next;
  try { localStorage.setItem(MAX_KEY, next ? "1" : "0"); } catch { /* 忽略 */ }
  emit();
}

// Ctrl/Cmd +（=）/ -（_）/ 0 調整程式碼字級。以引用計數裝一次全域監聽：
// 有幾個跳窗開著都只有一個 handler，巢狀跳窗不會一次跳兩級。
// 只在有跳窗掛載時生效（hook 的生命週期就是條件），故不會攔掉一般瀏覽情境的縮放。
let listeners = 0;
function onKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key === "=" || e.key === "+") { e.preventDefault(); setCodeFontSize(codeFontSize + 1); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); setCodeFontSize(codeFontSize - 1); }
  else if (e.key === "0") { e.preventDefault(); setCodeFontSize(CODE_FONT_DEFAULT); }
}

/** 讀取 / 操作跳窗檢視偏好。回傳的 `shellClass` 直接串到跳窗外殼的 class 後面。 */
export function useModalView() {
  const maxed = useSyncExternalStore(subscribe, () => maximized, () => false);
  const font = useSyncExternalStore(subscribe, () => codeFontSize, () => CODE_FONT_DEFAULT);
  useEffect(() => {
    if (listeners++ === 0) window.addEventListener("keydown", onKey);
    return () => { if (--listeners === 0) window.removeEventListener("keydown", onKey); };
  }, []);
  const toggleMaximized = useCallback(() => setMaximized(!maximized), []);
  return {
    maximized: maxed,
    codeFontSize: font,
    toggleMaximized,
    shellClass: maxed ? MAXIMIZED_SHELL : "",
  };
}

export interface ModalViewControlsProps {
  /** 這個跳窗裝的是程式碼 / 等寬內容時給 true，才會出現字級調整鈕（否則按了看不出差別）。 */
  code?: boolean;
  className?: string;
}

/**
 * 跳窗標題列的檢視控制組（字級 −/＋、最大化）。放在關閉鈕左邊。
 * 每個跳窗都是同一組全域偏好的遙控器，不持有自己的 state。
 */
export default function ModalViewControls({ code = false, className = "" }: ModalViewControlsProps) {
  const t = useT();
  const { maximized, codeFontSize: font, toggleMaximized } = useModalView();
  return (
    <div className={`flex items-center gap-0.5 shrink-0 ${className}`}>
      {code && (
        <>
          <IconButton icon={AArrowDown} iconSize={15} label={t("縮小程式碼字級 (Ctrl+-)")}
            disabled={font <= CODE_FONT_MIN} onClick={() => setCodeFontSize(font - 1)} />
          <button type="button" onClick={() => setCodeFontSize(CODE_FONT_DEFAULT)}
            title={t("程式碼字級 {n}px（點一下回預設 {d}px）", { n: font, d: CODE_FONT_DEFAULT })}
            className="w-7 h-7 grid place-items-center rounded text-[10px] tabular-nums text-fg/40 hover:text-fg hover:bg-fg/10">
            {font}
          </button>
          <IconButton icon={AArrowUp} iconSize={15} label={t("放大程式碼字級 (Ctrl++)")}
            disabled={font >= CODE_FONT_MAX} onClick={() => setCodeFontSize(font + 1)} />
        </>
      )}
      <IconButton icon={maximized ? Minimize2 : Maximize2} iconSize={15} active={maximized}
        label={maximized ? t("還原視窗大小") : t("最大化")} onClick={toggleMaximized} />
    </div>
  );
}
