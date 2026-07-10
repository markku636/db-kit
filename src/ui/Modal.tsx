import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Icon from "./Icon";
import { useT } from "../i18n";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

// 開啟中的對話框堆疊（後進者為最上層）：Esc 僅關最上層，避免巢狀對話框一次全關。
const modalStack: symbol[] = [];

const widths: Record<ModalSize, string> = {
  sm: "w-[420px]",
  md: "w-[560px]",
  lg: "w-[720px]",
  xl: "w-[920px]",
  full: "w-[1100px]",
};

export interface ModalProps {
  open?: boolean;
  onClose: () => void;
  title?: ReactNode;
  icon?: LucideIcon;
  size?: ModalSize;
  footer?: ReactNode;
  danger?: boolean;
  dismissOnBackdrop?: boolean;
  /** z-index class，巢狀對話框可調高（預設 z-[100]）。 */
  zClass?: string;
  /** 內容區 class，預設 p-5 overflow-auto。傳 "" 可自行控制 padding。 */
  bodyClassName?: string;
  /** shell 額外 class（例如自訂高度）。 */
  className?: string;
  children: ReactNode;
}

/**
 * 統一對話框外殼：玻璃背板 + 浮起 shell + 標題列（圖示 + 關閉鈕）+ 內容 + footer。
 * 收斂原本散落 13 個對話框各自手刻的 fixed/bg-black/50/header/footer 樣板，
 * 並集中處理 Esc 關閉。背板與 shell 帶輕量進場動畫（gated 在 prefers-reduced-motion）。
 */
export default function Modal({
  open = true,
  onClose,
  title,
  icon,
  size = "md",
  footer,
  danger = false,
  dismissOnBackdrop = true,
  zClass = "z-[100]",
  bodyClassName = "p-5 overflow-auto",
  className = "",
  children,
}: ModalProps) {
  const t = useT();
  const shellRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol("modal");

  // Esc 關閉（僅最上層對話框回應）+ Tab 焦點環陷阱（鍵盤焦點不會逃出對話框）。
  // modalStack 維持開啟順序（後進＝最上層）；body.dataset.modalCount 供其他鍵盤處理
  //（如分頁切換）判斷「有對話框開啟」而讓路。
  useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    modalStack.push(id);
    document.body.dataset.modalCount = String(Number(document.body.dataset.modalCount ?? "0") + 1);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (modalStack[modalStack.length - 1] !== id) return; // 僅最上層對話框回應
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && shellRef.current?.contains(document.activeElement)) {
        const f = Array.from(
          shellRef.current.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null);
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        const act = document.activeElement as HTMLElement;
        if (e.shiftKey && act === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && act === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = modalStack.lastIndexOf(id);
      if (i !== -1) modalStack.splice(i, 1);
      const m = Number(document.body.dataset.modalCount ?? "1") - 1;
      if (m <= 0) delete document.body.dataset.modalCount;
      else document.body.dataset.modalCount = String(m);
    };
  }, [open, onClose]);

  // 開啟時：記住先前焦點；若對話框內沒有元素自動聚焦（autoFocus），把焦點帶進外殼，
  // 確保鍵盤使用者一進對話框焦點就在內部。關閉時還原回先前焦點。
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const shell = shellRef.current;
      if (!shell || shell.contains(document.activeElement)) return;
      const focusable = shell.querySelector<HTMLElement>(
        'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
      );
      (focusable ?? shell).focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 ${zClass} grid place-items-center bg-black/40 backdrop-blur-sm modal-backdrop-in`}
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      <div
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`bg-elevated rounded-lg border border-fg/10 shadow-e4 flex flex-col max-h-[88vh] max-w-[94vw] outline-none ${widths[size]} modal-shell-in ${className}`}
      >
        {title !== undefined && (
          <div
            className={`h-11 px-5 flex items-center gap-2.5 shrink-0 border-b ${
              danger ? "border-danger/30" : "border-fg/10"
            }`}
          >
            {icon && <Icon icon={icon} size={16} className={danger ? "text-danger" : "text-fg/50"} />}
            <div className="text-sm font-medium truncate">{title}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("關閉")}
              className="ml-auto w-7 h-7 grid place-items-center rounded text-fg/40 hover:text-fg hover:bg-fg/10 active:bg-fg/[0.14] shrink-0"
            >
              <Icon icon={X} size={16} />
            </button>
          </div>
        )}
        <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-fg/10 bg-app/40 flex items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
