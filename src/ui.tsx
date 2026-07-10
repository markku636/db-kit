import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t, useT } from "./i18n";

// 對話框共用：按 Esc 關閉（onClose 以 ref 保持穩定，listener 只掛一次）。
export function useEscToClose(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") ref.current(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}

// 手刻覆蓋層（非 ui/Modal）掛載期間計入 body.dataset.modalCount，
// 讓全域鍵盤處理（分頁切換 Ctrl+W/Ctrl+Tab/Ctrl+1-9、側欄 "/" 聚焦等）在其開啟時讓路，
// 不會在可見的覆蓋層「背後」誤動作。自帶 Esc 處理的覆蓋層用這個。
export function useModalCount() {
  useEffect(() => {
    const b = document.body;
    b.dataset.modalCount = String(Number(b.dataset.modalCount ?? "0") + 1);
    return () => {
      const m = Number(b.dataset.modalCount ?? "1") - 1;
      if (m <= 0) delete b.dataset.modalCount;
      else b.dataset.modalCount = String(m);
    };
  }, []);
}

// 手刻覆蓋層共用：計入 modalCount + Esc 關閉（stopPropagation 避免底層其他 Esc 監聽連帶反應）。
// 用於 RowDetailModal / CellInspector / KeyDetailModal / InsertDialog 等非 ui/Modal 的浮層。
export function useModalOverlay(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useModalCount();
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); ref.current(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}

// ---- Toast 通知 + 確認對話框 共用狀態 ----

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

interface ConfirmReq {
  message: string;
  title?: string;
  danger?: boolean;
  confirmText?: string;
  resolve: (ok: boolean) => void;
}

interface PromptReq {
  message: string;
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  resolve: (value: string | null) => void;
}

interface UiStore {
  toasts: Toast[];
  confirmReq: ConfirmReq | null;
  promptReq: PromptReq | null;
  pushToast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  requestConfirm: (req: ConfirmReq) => void;
  resolveConfirm: (ok: boolean) => void;
  requestPrompt: (req: PromptReq) => void;
  resolvePrompt: (value: string | null) => void;
}

let toastSeq = 1;

export const useUi = create<UiStore>((set, get) => ({
  toasts: [],
  confirmReq: null,
  promptReq: null,
  pushToast: (kind, text) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    const ttl = kind === "error" ? 6000 : 3200;
    setTimeout(() => get().dismissToast(id), ttl);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((n) => n.id !== id) })),
  // 若已有待回應的請求，先以「取消」結束它（resolve），避免其 Promise 永遠懸而不決。
  requestConfirm: (req) => {
    const prev = get().confirmReq;
    if (prev) prev.resolve(false);
    set({ confirmReq: req });
  },
  resolveConfirm: (ok) => {
    const req = get().confirmReq;
    set({ confirmReq: null });
    req?.resolve(ok);
  },
  requestPrompt: (req) => {
    const prev = get().promptReq;
    if (prev) prev.resolve(null);
    set({ promptReq: req });
  },
  resolvePrompt: (value) => {
    const req = get().promptReq;
    set({ promptReq: null });
    req?.resolve(value);
  },
}));

export const toast = {
  success: (text: string) => useUi.getState().pushToast("success", text),
  error: (text: string) => useUi.getState().pushToast("error", text),
  info: (text: string) => useUi.getState().pushToast("info", text),
};

/** 以 Promise 取代瀏覽器 confirm()，配合 <UiHost /> 的樣式化對話框。 */
export function uiConfirm(
  message: string,
  opts?: { title?: string; danger?: boolean; confirmText?: string }
): Promise<boolean> {
  return new Promise((resolve) => {
    useUi.getState().requestConfirm({ message, resolve, ...opts });
  });
}

/** 以 Promise 取代瀏覽器 prompt()。取消回傳 null、確定回傳輸入字串。 */
export function uiPrompt(
  message: string,
  opts?: { title?: string; defaultValue?: string; placeholder?: string; confirmText?: string }
): Promise<string | null> {
  return new Promise((resolve) => {
    useUi.getState().requestPrompt({ message, resolve, ...opts });
  });
}

// ---- 剪貼簿 ----

/**
 * 複製文字到系統剪貼簿。優先用 navigator.clipboard（Tauri webview 在安全環境支援），
 * 失敗則退回隱藏 textarea + execCommand。成功 / 失敗都跳 toast 回饋。
 */
export async function copyToClipboard(text: string, label = t("已複製")): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast.success(label);
      return true;
    }
  } catch {
    /* 落到下方 fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) {
      toast.success(label);
      return true;
    }
  } catch {
    /* ignore */
  }
  toast.error(t("複製失敗"));
  return false;
}

// ---- 原生檔案選擇器（Tauri dialog plugin）----

type Filter = { name: string; extensions: string[] };

export async function pickOpenFile(filters?: Filter[]): Promise<string | null> {
  const res = await open({ multiple: false, directory: false, filters });
  return typeof res === "string" ? res : null;
}

export async function pickDirectory(): Promise<string | null> {
  const res = await open({ multiple: false, directory: true });
  return typeof res === "string" ? res : null;
}

export async function pickSaveFile(defaultPath?: string, filters?: Filter[]): Promise<string | null> {
  const res = await save({ defaultPath, filters });
  return res ?? null;
}

// ---- 掛在 App 根的通知 / 確認渲染層 ----

export function UiHost() {
  const t = useT();
  const { toasts, dismissToast, confirmReq, resolveConfirm, promptReq, resolvePrompt } = useUi();

  // Esc 取消最上層的 confirm / prompt：用 capture 階段，先於 Modal 的 bubble 監聽並 stopPropagation，
  // 避免 Esc 關掉底下的對話框（confirm/prompt 不在 Modal 堆疊內，否則會被 Modal 攔走）。
  useEffect(() => {
    if (!confirmReq && !promptReq) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (promptReq) resolvePrompt(null);
      else resolveConfirm(false);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [confirmReq, promptReq, resolveConfirm, resolvePrompt]);

  const kindStyle = (k: Toast["kind"]) =>
    k === "success"
      ? "border-green-500/40 bg-green-500/15 text-green-200"
      : k === "error"
      ? "border-red-500/40 bg-red-500/15 text-red-200"
      : "border-fg/15 bg-fg/10 text-fg/80";

  return (
    <>
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[90vw]"
        role="region"
        aria-label={t("通知")}
      >
        {toasts.map((n) => {
          const cls = `toast-in px-3 py-2 rounded-md shadow-lg text-sm border cursor-pointer break-words ${kindStyle(n.kind)}`;
          // 錯誤用 alert/assertive（立即播報），其餘用 status/polite。以字面值滿足 a11y lint。
          return n.kind === "error" ? (
            <div key={n.id} role="alert" aria-live="assertive" onClick={() => dismissToast(n.id)} className={cls}>
              {n.text}
            </div>
          ) : (
            <div key={n.id} role="status" aria-live="polite" onClick={() => dismissToast(n.id)} className={cls}>
              {n.text}
            </div>
          );
        })}
      </div>

      {confirmReq && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[110]"
          onClick={() => resolveConfirm(false)}
        >
          <div
            className="bg-elevated w-[380px] max-w-[92vw] rounded-lg border border-fg/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-fg/10 font-medium text-sm">
              {confirmReq.title ?? t("確認")}
            </div>
            <div className="p-5 text-sm text-fg/80 whitespace-pre-wrap break-words">
              {confirmReq.message}
            </div>
            <div className="px-5 py-3 border-t border-fg/10 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => resolveConfirm(false)}
                className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5"
              >
                {t("取消")}
              </button>
              <button
                type="button"
                onClick={() => resolveConfirm(true)}
                className={`px-3 py-1.5 text-sm rounded text-white ${
                  confirmReq.danger ? "bg-danger hover:bg-danger/90" : "bg-accent hover:bg-accent/90"
                }`}
              >
                {confirmReq.confirmText ?? t("確定")}
              </button>
            </div>
          </div>
        </div>
      )}

      {promptReq && <PromptDialog key={promptReq.message + (promptReq.title ?? "")} />}
    </>
  );
}

// 文字輸入對話框（uiPrompt）。Enter 送出、Esc 取消。
function PromptDialog() {
  const t = useT();
  const { promptReq, resolvePrompt } = useUi();
  const [text, setText] = useState(promptReq?.defaultValue ?? "");
  // 新請求（即使 message+title 相同）也要重設輸入內容，避免沿用上一個的殘留文字。
  useEffect(() => { setText(promptReq?.defaultValue ?? ""); }, [promptReq]);
  if (!promptReq) return null;
  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[110]"
      onClick={() => resolvePrompt(null)}
    >
      <div
        className="bg-elevated w-[380px] max-w-[92vw] rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-fg/10 font-medium text-sm">
          {promptReq.title ?? t("輸入")}
        </div>
        <div className="p-5 space-y-3">
          <div className="text-sm text-fg/80 whitespace-pre-wrap break-words">
            {promptReq.message}
          </div>
          <input
            autoFocus
            value={text}
            placeholder={promptReq.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") resolvePrompt(text);
              else if (e.key === "Escape") resolvePrompt(null);
            }}
            className="w-full bg-inset border border-fg/10 rounded px-2 py-1.5 text-sm mono outline-none focus:border-accent"
          />
        </div>
        <div className="px-5 py-3 border-t border-fg/10 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => resolvePrompt(null)}
            className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={() => resolvePrompt(text)}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90"
          >
            {promptReq.confirmText ?? t("確定")}
          </button>
        </div>
      </div>
    </div>
  );
}
