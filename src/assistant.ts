import { create } from "zustand";
import type { EditorSnapshot } from "./chatTypes";

// AI 助手面板的開關狀態（工具列按鈕切換；對話內容留在面板元件內）。
// 與 InfoPanel 一致用 localStorage 記住偏好；助手為選用功能，預設關閉。
const OPEN_KEY = "db-kit:assistantOpen";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

interface AssistantStore {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  // 由外部（如側欄右鍵「問 AI」）丟進來的待填問題；面板消費後清空。
  seed: string | null;
  // 是否在帶入 seed 後自動送出（如「AI 分析修正」一鍵修錯）；預設 false = 僅填入待使用者送出。
  seedSend: boolean;
  // 開面板並把 prompt 帶進輸入框。預設由使用者檢視後再送出；opts.send=true 則自動送出。
  ask: (prompt: string, opts?: { send?: boolean }) => void;
  clearSeed: () => void;
  /**
   * 查詢分頁發佈的「編輯器現況」（SQL / 選取 / 結果 / 錯誤），供聊天的 `@query`、`@result`、
   * `@error` 與 `/explain`、`/fix` 取用。
   *
   * 為何要這條橋：QueryPane 的這些狀態是分頁區域狀態，切分頁就整個卸載，助手面板拿不到；
   * 而把它們搬進全域 store 會讓每次打字都觸發全 app re-render。折衷是「分頁主動發佈一份快照」，
   * 只存參照不複製資料列，消費端再以 connId 比對確認沒過期。
   */
  editor: EditorSnapshot | null;
  publishEditor: (s: EditorSnapshot | null) => void;
}

export const useAssistant = create<AssistantStore>((set, get) => ({
  open: readOpen(),
  setOpen: (v) => {
    try { localStorage.setItem(OPEN_KEY, v ? "1" : "0"); } catch { /* 忽略 */ }
    set({ open: v });
  },
  toggle: () => get().setOpen(!get().open),
  seed: null,
  seedSend: false,
  ask: (prompt, opts) => {
    get().setOpen(true);
    set({ seed: prompt, seedSend: !!opts?.send });
  },
  clearSeed: () => set({ seed: null, seedSend: false }),
  editor: null,
  // 卸載時不清空（傳 null 才清）：切到表分頁再回來的空窗期，使用者對「剛才那段查詢」的提問
  // 不該突然失去上下文。過期與否由消費端以 connId 判斷。
  publishEditor: (s) => set({ editor: s }),
}));
