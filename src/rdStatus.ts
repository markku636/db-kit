import { create } from "zustand";
import { Monitor, MonitorSmartphone, ScreenShare, type LucideIcon } from "lucide-react";
import type { RdProtocol, RdStatus } from "./rdTypes";

// 遠端桌面分頁的執行期狀態（不進主 store：畫面更新很頻繁，但這裡只放「狀態點」這種低頻資料，
// 讓側欄 / 分頁列不必訂閱 RdPane 的內部 state）。

export interface RdRuntime {
  status: RdStatus;
  /** 已連上時的安全層（`nla` / `ard` / `vnc-auth` …）與是否加密；分頁列 / 工具列顯示「未加密」徽章用。 */
  security?: string;
  encrypted?: boolean;
  error?: string | null;
  /** 斷線後正在等自動重連（RustDesk）。 */
  retrying?: boolean;
}

/** 這個分頁現在有沒有東西可以「中斷」：連著、正在撥號，或在等自動重連。 */
export function rdIsLive(r: RdRuntime | undefined): boolean {
  return !!r && (r.status === "connected" || r.status === "connecting" || !!r.retrying);
}

// 側欄 / 分頁列的右鍵選單要某個分頁「中斷連線」/「重新連線」：連線狀態在 RdPane 裡，由它登記處理函式。
export type RdCommand = "disconnect" | "reconnect";
const commandHandlers = new Map<string, (c: RdCommand) => void>();

/** RdPane 登記自己的處理函式；回傳取消登記。 */
export function onRdCommand(key: string, fn: (c: RdCommand) => void): () => void {
  commandHandlers.set(key, fn);
  return () => {
    if (commandHandlers.get(key) === fn) commandHandlers.delete(key);
  };
}

export function sendRdCommand(key: string, c: RdCommand): void {
  commandHandlers.get(key)?.(c);
}

interface RdStatusStore {
  rt: Record<string, RdRuntime>;
  patch: (key: string, p: Partial<RdRuntime>) => void;
  drop: (key: string) => void;
}

export const useRdStatus = create<RdStatusStore>((set) => ({
  rt: {},
  patch: (key, p) =>
    set((s) => ({ rt: { ...s.rt, [key]: { ...(s.rt[key] ?? { status: "connecting" }), ...p } } })),
  drop: (key) =>
    set((s) => {
      if (!(key in s.rt)) return {};
      const rt = { ...s.rt };
      delete rt[key];
      return { rt };
    }),
}));

/** 協定的圖示與色標（側欄、分頁列、KindPicker 共用）。 */
export const RD_META: Record<RdProtocol, { icon: LucideIcon; color: string }> = {
  rdp: { icon: Monitor, color: "#0ea5e9" },
  vnc: { icon: ScreenShare, color: "#a855f7" },
  rustdesk: { icon: MonitorSmartphone, color: "#f97316" },
};
