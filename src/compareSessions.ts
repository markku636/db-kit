// 已存的比對（後端 filecmp/sessions.rs，設定目錄的 compare_sessions.json；dbk diff / sync --session 共用同一份）
// 與最近的比對（只在這台機器的 localStorage，不同步給 dbk）。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { FolderCriteria, FolderOpts } from "./compareTypes";
import type { CompareMode, Endpoint } from "./compareTabs";
import type { SyncRule } from "./folderCompareModel";
import type { SshSession } from "./sshTypes";
import { sessionLabel } from "./sshSessions";

export type SessionSide = { side: "local"; path: string } | { side: "remote"; session_id: string; path: string };

export interface FolderSettings {
  excludes: string[];
  criteria: FolderCriteria;
  tolerance_secs: number;
  ignore_hour_offset: boolean;
  case_insensitive: boolean;
  rule: SyncRule | null;
}

export interface CompareSession {
  id: string;
  name: string;
  mode: CompareMode;
  left: SessionSide;
  right: SessionSide;
  folder: FolderSettings;
  updated_at: number;
}

interface SessionsFile { version: number; sessions: CompareSession[] }

export const DEFAULT_FOLDER: FolderSettings = {
  excludes: [".git", "node_modules"],
  criteria: "size_mtime",
  tolerance_secs: 2,
  ignore_hour_offset: false,
  case_insensitive: false,
  rule: null,
};

export function folderOpts(s: FolderSettings): FolderOpts {
  return {
    excludes: s.excludes,
    criteria: s.criteria,
    tolerance_secs: s.tolerance_secs,
    ignore_hour_offset: s.ignore_hour_offset,
    case_insensitive: s.case_insensitive,
  };
}

/** 分頁上的來源 → 存檔格式。貼上的文字不能存（回 null）。 */
export function toSessionSide(ep: Endpoint): SessionSide | null {
  if (ep.side === "local") return { side: "local", path: ep.path };
  if (ep.side === "remote" && ep.target.kind === "session") return { side: "remote", session_id: ep.target.id, path: ep.path };
  return null;
}

/** 存檔格式 → 分頁上的來源。主機已經被刪掉回 null。 */
export function fromSessionSide(s: SessionSide, hosts: readonly SshSession[]): Endpoint | null {
  if (s.side === "local") return { side: "local", path: s.path };
  const h = hosts.find((x) => x.id === s.session_id);
  if (!h) return null;
  return { side: "remote", target: { kind: "session", id: h.id }, sessionId: h.id, label: sessionLabel(h), path: s.path };
}

interface Store {
  loaded: boolean;
  sessions: CompareSession[];
  error: string | null;
  load: () => Promise<void>;
  upsert: (s: CompareSession) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

async function persist(sessions: CompareSession[]) {
  const file: SessionsFile = { version: 1, sessions };
  await invoke<void>("cmp_sessions_save", { file });
}

export const useCompareSessions = create<Store>((set, get) => ({
  loaded: false,
  sessions: [],
  error: null,
  load: async () => {
    try {
      const f = await invoke<SessionsFile>("cmp_sessions_load");
      const sessions = f.sessions.map((s) => ({ ...s, folder: { ...DEFAULT_FOLDER, ...s.folder } }));
      set({ loaded: true, sessions, error: null });
    } catch (e) {
      set({ loaded: true, error: String((e as { message?: string })?.message ?? e) });
    }
  },
  upsert: async (s) => {
    const cur = get().sessions;
    const next = cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [...cur, s];
    await persist(next);
    set({ sessions: next });
  },
  remove: async (id) => {
    const next = get().sessions.filter((x) => x.id !== id);
    await persist(next);
    set({ sessions: next });
  },
}));

// ---- 最近的比對（localStorage；每個瀏覽器設定檔一份，讀寫失敗就當沒有）----

const RECENT_KEY = "dbk.compare.recent";
const RECENT_MAX = 12;

export interface RecentCompare { mode: CompareMode; left: Endpoint; right: Endpoint; at: number }

export function loadRecent(): RecentCompare[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const v = raw ? (JSON.parse(raw) as RecentCompare[]) : [];
    return Array.isArray(v) ? v.filter((r) => r && r.left && r.right && r.left.side !== "paste" && r.right.side !== "paste") : [];
  } catch {
    return [];
  }
}

/** 記一筆（貼上的文字不記：內容可能很大，也可能是機密）。同一組來源只留最新的一筆。 */
export function pushRecent(r: Omit<RecentCompare, "at">) {
  if (r.left.side === "paste" || r.right.side === "paste") return;
  try {
    const sig = (x: Omit<RecentCompare, "at">) => JSON.stringify([x.mode, x.left, x.right]);
    const list = [{ ...r, at: Date.now() }, ...loadRecent().filter((x) => sig(x) !== sig(r))].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 私密視窗 / 停用儲存：不記就是了 */
  }
}

export function clearRecent() {
  try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
}
