import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import Icon from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dangerSolid";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-1.5 font-medium rounded select-none " +
  "transition-[background-color,box-shadow,transform,color,border-color] duration-100 " +
  "disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent/60";

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-3 text-[13px]",
  md: "h-8 px-3.5 text-sm",
  // 單一任務的全螢幕畫面（鎖定畫面）用：工具列密度的 28 / 32px 放在大片留白裡會小得像連結。
  lg: "h-10 px-4 text-sm gap-2",
};

// primary 用 bg-accent + 明確白字（不依賴 fg 翻轉）；其餘用語意表面色，含 :active 按壓變深。
const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent/90 active:bg-accent/80 shadow-e1",
  secondary: "bg-fg/5 border border-fg/10 text-fg/90 hover:bg-fg/10 active:bg-fg/[0.14]",
  ghost: "text-fg/70 hover:bg-fg/10 active:bg-fg/[0.14]",
  danger: "bg-danger/15 text-danger hover:bg-danger/25 active:bg-danger/30",
  dangerSolid: "bg-danger text-white hover:bg-danger/90 active:bg-danger/80 shadow-e1",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  full?: boolean;
}

export default function Button({
  variant = "secondary",
  size = "sm",
  icon,
  iconRight,
  loading = false,
  full = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const iconSize = size === "lg" ? 16 : 14;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`${base} ${sizes[size]} ${variants[variant]} ${full ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {loading ? (
        <Icon icon={Loader2} size={iconSize} className="animate-spin" />
      ) : icon ? (
        <Icon icon={icon} size={iconSize} />
      ) : null}
      {children}
      {iconRight && !loading ? <Icon icon={iconRight} size={iconSize} /> : null}
    </button>
  );
}
