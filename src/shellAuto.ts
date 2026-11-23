// AI 助手「自動執行安全指令」偏好。
// 只自動執行 shellGuard 判定為 safe 的 bash 區塊；confirm / block 一律留給使用者手動授權。
// 與其他偏好一致用 localStorage（非機密），設定對話框與助手面板共用同一份 store。
import { create } from "zustand";

const KEY = "db-kit:shellAutoExec";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

interface ShellAutoState {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
}

export const useShellAuto = create<ShellAutoState>((set) => ({
  enabled: read(),
  setEnabled: (value) => {
    try {
      localStorage.setItem(KEY, value ? "1" : "0");
    } catch {
      /* 隱私模式不可寫時仍讓本次工作階段生效 */
    }
    set({ enabled: value });
  },
}));
