// 遠端桌面工具列下拉選單的項目（RustDesk / VNC 工具列共用）：小標題、分隔線、單選 / 勾選項、動作。
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Icon } from "./ui/index";

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-2 pb-1 text-[11px] text-fg/40 select-none">{children}</div>;
}

export function MenuSep() {
  return <div className="my-1 border-t border-fg/10" />;
}

/** 單選 / 勾選項：左邊一格放勾。 */
export function MenuOption({ checked, onClick, children, disabled, testid, role = "menuitemradio" }: {
  checked: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  testid?: string;
  role?: "menuitemradio" | "menuitemcheckbox";
}) {
  return (
    <button type="button" role={role} aria-checked={checked} disabled={disabled} data-rd-opt={testid} onClick={onClick}
      className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80 disabled:opacity-40 disabled:pointer-events-none">
      <span className="w-3.5 shrink-0 text-accent">{checked && <Icon icon={Check} size={13} />}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

export function MenuAction({ onClick, children, testid, danger }: { onClick: () => void; children: ReactNode; testid?: string; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" data-rd-action={testid} onClick={onClick}
      className={`block w-full text-left pl-8 pr-3 py-1.5 hover:bg-fg/10 truncate ${danger ? "text-danger" : "text-fg/80"}`}>
      {children}
    </button>
  );
}
