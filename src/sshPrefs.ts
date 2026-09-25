import { create } from "zustand";

// SSH 終端機的使用者偏好（設定對話框「SSH 終端機」小節）與命令列輸入條的歷史。
// 與 theme.ts / aiProvider.ts 同一套慣例：localStorage 持久化、讀寫都 try/catch、模組載入時讀一次。

export interface SshPrefs {
  /** 選取文字時自動複製（PuTTY 風格）。 */
  copyOnSelect: boolean;
  /** 無選取時右鍵 = 貼上。 */
  rightClickPaste: boolean;
  /** 貼上內容含換行時先確認（每一行都會被 shell 執行）。 */
  warnMultilinePaste: boolean;
  /** auto = 先試 WebGL、失敗退 DOM；dom = 直接用 DOM renderer（RDP / VM 軟體渲染時較穩）。 */
  renderer: "auto" | "dom";
  /** 回捲行數；常駐 N 個 xterm 時記憶體與它成正比，故設上限。 */
  scrollback: number;
  cursorBlink: boolean;
}

export const DEFAULT_SSH_PREFS: SshPrefs = {
  copyOnSelect: false,
  rightClickPaste: true,
  warnMultilinePaste: true,
  renderer: "auto",
  scrollback: 5000,
  cursorBlink: true,
};

export const SCROLLBACK_MIN = 500;
export const SCROLLBACK_MAX = 50000;

const PREFS_KEY = "dbkit:ssh.prefs";
const HISTORY_KEY = "dbkit:ssh.composeHistory";
/** 命令列歷史上限（與 SshComposeBar 的 ↑/↓ 共用）。 */
export const COMPOSE_HISTORY_MAX = 200;

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** 把存檔（或任何 unknown）整理成合法偏好：缺欄補預設、scrollback 夾在 500–50000、renderer 認不得就 auto。 */
export function normalizeSshPrefs(raw: unknown): SshPrefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sb = Number(o.scrollback);
  const scrollback = Number.isFinite(sb)
    ? Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(sb)))
    : DEFAULT_SSH_PREFS.scrollback;
  return {
    copyOnSelect: bool(o.copyOnSelect, DEFAULT_SSH_PREFS.copyOnSelect),
    rightClickPaste: bool(o.rightClickPaste, DEFAULT_SSH_PREFS.rightClickPaste),
    warnMultilinePaste: bool(o.warnMultilinePaste, DEFAULT_SSH_PREFS.warnMultilinePaste),
    renderer: o.renderer === "dom" ? "dom" : "auto",
    scrollback,
    cursorBlink: bool(o.cursorBlink, DEFAULT_SSH_PREFS.cursorBlink),
  };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readPrefs(): SshPrefs {
  try {
    const raw = storage()?.getItem(PREFS_KEY);
    return normalizeSshPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SSH_PREFS };
  }
}

function writePrefs(p: SshPrefs): void {
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* 忽略寫入失敗 */
  }
}

export interface SshPrefsStore extends SshPrefs {
  /** 局部更新；一律經 normalize 後才落地，UI 塞進來的怪值不會存進檔。 */
  set: (p: Partial<SshPrefs>) => void;
}

export const useSshPrefs = create<SshPrefsStore>((set, get) => ({
  ...readPrefs(),
  set: (p) => {
    const cur = get();
    const next = normalizeSshPrefs({ ...pickPrefs(cur), ...p });
    writePrefs(next);
    set(next);
  },
}));

/** 從 store 狀態抽出純偏好欄位（去掉 set 方法）。 */
export function pickPrefs(s: SshPrefs): SshPrefs {
  return {
    copyOnSelect: s.copyOnSelect,
    rightClickPaste: s.rightClickPaste,
    warnMultilinePaste: s.warnMultilinePaste,
    renderer: s.renderer,
    scrollback: s.scrollback,
    cursorBlink: s.cursorBlink,
  };
}

// ---- 命令列輸入條歷史（舊 → 新；↑ 從尾端往回走）----

export function loadComposeHistory(): string[] {
  try {
    const raw = storage()?.getItem(HISTORY_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-COMPOSE_HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

/**
 * 追加一條歷史並回傳新清單。空白行不記；與上一條相同不重複（連打三次 ls 只留一條）；超過上限丟最舊的。
 */
export function pushComposeHistory(line: string): string[] {
  const text = line.replace(/\s+$/, "");
  const cur = loadComposeHistory();
  if (!text.trim()) return cur;
  if (cur[cur.length - 1] === text) return cur;
  const next = [...cur, text].slice(-COMPOSE_HISTORY_MAX);
  try {
    storage()?.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 忽略寫入失敗 */
  }
  return next;
}
