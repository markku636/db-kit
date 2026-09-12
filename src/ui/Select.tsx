import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import Icon from "./Icon";
import type { ControlSize } from "./Input";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  selectSize?: ControlSize;
}

/** 原生 <select> 包裝：沿用 Input 樣式 + 自訂 chevron，保留原生鍵盤 / 無障礙。 */
export default function Select({ selectSize = "sm", className = "", children, ...rest }: SelectProps) {
  const h = { sm: "h-7 pl-2.5 pr-7", md: "h-8 pl-3 pr-8", lg: "h-10 pl-3.5 pr-9" }[selectSize];
  return (
    <div className="relative">
      <select
        className={
          `w-full appearance-none rounded bg-inset border border-fg/10 text-sm outline-none cursor-pointer ` +
          `transition-colors focus:border-accent/60 focus:ring-2 focus:ring-accent/20 ` +
          `disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-fg/[0.03] ${h} ${className}`
        }
        {...rest}
      >
        {children}
      </select>
      <Icon
        icon={ChevronDown}
        size={14}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-fg/40"
      />
    </div>
  );
}
