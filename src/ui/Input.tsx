import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export type ControlSize = "sm" | "md" | "lg";

const fieldBase =
  "w-full rounded bg-inset border text-sm placeholder:text-fg/30 outline-none " +
  "transition-colors focus:ring-2 focus:ring-accent/20 " +
  "disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-fg/[0.03]";

const heights: Record<ControlSize, string> = {
  sm: "h-7 px-2.5",
  md: "h-8 px-3",
  lg: "h-10 px-3.5", // 與 Button size="lg" 同高，鎖定畫面這類單欄表單上下對齊
};

function stateCls(invalid?: boolean) {
  return invalid
    ? "border-danger/60 focus:border-danger focus:ring-danger/20"
    : "border-fg/10 focus:border-accent/60";
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  inputSize?: ControlSize;
}

export function Input({ invalid, inputSize = "sm", className = "", ...rest }: InputProps) {
  return <input className={`${fieldBase} ${heights[inputSize]} ${stateCls(invalid)} ${className}`} {...rest} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid, className = "", ...rest }: TextareaProps) {
  return <textarea className={`${fieldBase} px-2.5 py-1.5 ${stateCls(invalid)} ${className}`} {...rest} />;
}

export default Input;
