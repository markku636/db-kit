import { useEffect, useState } from "react";
import { create } from "zustand";
import { open, save } from "@tauri-apps/plugin-dialog";

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
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
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
  success: (t: string) => useUi.getState().pushToast("success", t),
  error: (t: string) => useUi.getState().pushToast("error", t),
  info: (t: string) => useUi.getState().pushToast("info", t),
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
export async function copyToClipboard(text: string, label = "已複製"): Promise<boolean> {
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
  toast.error("複製失敗");
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
  const { toasts, dismissToast, confirmReq, resolveConfirm, promptReq } = useUi();

  const kindStyle = (k: Toast["kind"]) =>
    k === "success"
      ? "border-green-500/40 bg-green-500/15 text-green-200"
      : k === "error"
      ? "border-red-500/40 bg-red-500/15 text-red-200"
      : "border-white/15 bg-white/10 text-white/80";

  return (
    <>
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[90vw]">
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => dismissToast(t.id)}
            className={`px-3 py-2 rounded-md shadow-lg text-sm border cursor-pointer break-words ${kindStyle(t.kind)}`}
          >
            {t.text}
          </div>
        ))}
      </div>

      {confirmReq && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110]"
          onClick={() => resolveConfirm(false)}
        >
          <div
            className="bg-[#1a212b] w-[380px] max-w-[92vw] rounded-lg border border-white/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-white/10 font-medium text-sm">
              {confirmReq.title ?? "確認"}
            </div>
            <div className="p-5 text-sm text-white/80 whitespace-pre-wrap break-words">
              {confirmReq.message}
            </div>
            <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => resolveConfirm(false)}
                className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => resolveConfirm(true)}
                className={`px-3 py-1.5 text-sm rounded ${
                  confirmReq.danger ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500"
                }`}
              >
                {confirmReq.confirmText ?? "確定"}
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
  const { promptReq, resolvePrompt } = useUi();
  const [text, setText] = useState(promptReq?.defaultValue ?? "");
  // 新請求（即使 message+title 相同）也要重設輸入內容，避免沿用上一個的殘留文字。
  useEffect(() => { setText(promptReq?.defaultValue ?? ""); }, [promptReq]);
  if (!promptReq) return null;
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110]"
      onClick={() => resolvePrompt(null)}
    >
      <div
        className="bg-[#1a212b] w-[380px] max-w-[92vw] rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-white/10 font-medium text-sm">
          {promptReq.title ?? "輸入"}
        </div>
        <div className="p-5 space-y-3">
          <div className="text-sm text-white/80 whitespace-pre-wrap break-words">
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
            className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm mono outline-none focus:border-blue-500"
          />
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => resolvePrompt(null)}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => resolvePrompt(text)}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500"
          >
            {promptReq.confirmText ?? "確定"}
          </button>
        </div>
      </div>
    </div>
  );
}
