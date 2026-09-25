import { create } from "zustand";
import type { EditorSnapshot, MentionChip, TerminalSnapshot } from "./chatTypes";

/** `ask()` 附帶的隱藏上下文：由終端機快速動作（解釋輸出 / 修正錯誤）帶進來，不顯示在輸入框、只進 prompt。 */
export interface AskOpts {
  send?: boolean;
  extraContext?: string;
  extraChips?: MentionChip[];
}

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
  ask: (prompt: string, opts?: AskOpts) => void;
  // seed 的隱藏上下文（只在 send=true 時有意義：退回「填入輸入框」時無處可放，會被丟掉）。
  seedOpts: AskOpts | null;
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
  /**
   * SSH 終端機分頁發佈的「終端機現況」（主機、最近指令、畫面尾端），供 `@term` / `@output` /
   * `@lastcmd` 與自動上下文取用。與 editor 同一套橋接理由；過期與否由消費端以 tabKey 是否仍開著判斷。
   */
  terminal: TerminalSnapshot | null;
  publishTerminal: (s: TerminalSnapshot | null) => void;
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
    set({ seed: prompt, seedSend: !!opts?.send, seedOpts: opts ?? null });
  },
  seedOpts: null,
  clearSeed: () => set({ seed: null, seedSend: false, seedOpts: null }),
  editor: null,
  // 卸載時不清空（傳 null 才清）：切到表分頁再回來的空窗期，使用者對「剛才那段查詢」的提問
  // 不該突然失去上下文。過期與否由消費端以 connId 判斷。
  publishEditor: (s) => set({ editor: s }),
  terminal: null,
  publishTerminal: (s) => set({ terminal: s }),
}));
