import { create } from "zustand";

// 右側「詳細資料」面板的展開 / 收合（記住偏好）。放在 store 裡，別處（例如開 RustDesk 分頁時）才能幫忙收合。
// 預設收合（只留窄邊條）：開著查詢或終端機時它多半只是佔寬度。
// 換了 key（舊的 db-kit:infoPanelOpen 沒存過就等於展開），讓所有人都先回到收合一次。
const PANEL_KEY = "db-kit:infoPanel";

function readOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === "open";
  } catch {
    return false;
  }
}

interface InfoPanelStore {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

export const useInfoPanel = create<InfoPanelStore>((set, get) => ({
  open: readOpen(),
  setOpen: (v) => {
    try { localStorage.setItem(PANEL_KEY, v ? "open" : "closed"); } catch { /* 忽略 */ }
    set({ open: v });
  },
  toggle: () => get().setOpen(!get().open),
}));
