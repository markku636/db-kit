// 「SSH 操作紀錄」視窗的開關與開啟時的篩選：從終端機狀態列、側欄主機右鍵開的會先篩好那台主機。
import { create } from "zustand";

export interface SshOpLogFilter {
  /** 只看這台已存主機。 */
  sessionId?: string | null;
  /** 臨時連線沒有主機 id，用 `user@host` 篩。 */
  host?: string;
  /** 篩選選單上顯示的名稱。 */
  label?: string;
}

interface SshOpLogState {
  open: boolean;
  filter: SshOpLogFilter;
  show: (filter?: SshOpLogFilter) => void;
  close: () => void;
}

export const useSshOpLog = create<SshOpLogState>((set) => ({
  open: false,
  filter: {},
  show: (filter = {}) => set({ open: true, filter }),
  close: () => set({ open: false }),
}));
