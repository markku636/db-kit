import { create } from "zustand";
import { api } from "./api";
import type { SshFolder, SshPlacement, SshSession } from "./sshTypes";

// SSH 主機清單：側欄「SSH 主機」區塊與主機對話框共用的資料 store，加上幾支可單測的純函式。
// 純函式放前面、store 放後面；測試只碰純函式（store 一呼叫就會 invoke Tauri）。

/** 顯示名稱：有名稱用名稱，否則 user@host。 */
export function sessionLabel(s: Pick<SshSession, "name" | "username" | "host">): string {
  const name = s.name?.trim();
  if (name) return name;
  return s.username ? `${s.username}@${s.host}` : s.host;
}

function byLabel(a: SshSession, b: SshSession): number {
  return sessionLabel(a).localeCompare(sessionLabel(b), undefined, { sensitivity: "base", numeric: true });
}

export interface SshSessionGroup {
  folder: SshFolder;
  sessions: SshSession[];
}

export interface GroupedSshSessions {
  /** 依 folders 原順序；空資料夾也保留（使用者剛建好還沒放東西）。 */
  groups: SshSessionGroup[];
  /** 未分類（folder_id 為 null 或指到不存在的資料夾）。 */
  loose: SshSession[];
}

/** 把 sessions 依資料夾分組；各組內依顯示名稱排序（不分大小寫、數字自然序）。v1 不做巢狀資料夾。 */
export function groupSessions(folders: SshFolder[], sessions: SshSession[]): GroupedSshSessions {
  const byFolder = new Map<string, SshSession[]>();
  for (const f of folders) byFolder.set(f.id, []);
  const loose: SshSession[] = [];
  for (const s of sessions) {
    const bucket = s.folder_id ? byFolder.get(s.folder_id) : undefined;
    if (bucket) bucket.push(s);
    else loose.push(s);
  }
  return {
    groups: folders.map((folder) => ({ folder, sessions: (byFolder.get(folder.id) ?? []).sort(byLabel) })),
    loose: loose.sort(byLabel),
  };
}

/** 側欄搜尋：比對名稱 / 主機 / 使用者（不分大小寫、前後空白忽略）；空字串回原陣列。 */
export function filterSessions(sessions: SshSession[], q: string): SshSession[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter(
    (s) =>
      s.name.toLowerCase().includes(needle) ||
      s.host.toLowerCase().includes(needle) ||
      s.username.toLowerCase().includes(needle),
  );
}

/** 避免同名資料夾："base" 已存在就 "base 2"、"base 3"…（不分大小寫）。空名稱給「新資料夾」。 */
export function uniqueFolderName(folders: Pick<SshFolder, "name">[], base: string): string {
  const b = base.trim() || "新資料夾";
  const taken = new Set(folders.map((f) => f.name.trim().toLowerCase()));
  if (!taken.has(b.toLowerCase())) return b;
  for (let i = 2; ; i++) {
    const cand = `${b} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

/** 回存版面用：每個 session 落在哪個資料夾。 */
export function sessionsToPlacements(sessions: SshSession[]): SshPlacement[] {
  return sessions.map((s) => ({ id: s.id, folder_id: s.folder_id ?? null }));
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errMsg(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? String(e);
}

export interface SshSessionsStore {
  folders: SshFolder[];
  sessions: SshSession[];
  /** 已成功載入過一次（側欄據此決定顯示空狀態還是載入中）。 */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** 新增或更新（依 id）。password / passphrase 非空才寫入 keychain，null = 保留既有。 */
  save: (s: SshSession, password?: string | null, passphrase?: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addFolder: (name: string, parentId?: string | null) => Promise<SshFolder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  /** 刪資料夾：裡面的 session 移到未分類、子資料夾往上掛到它的父層。 */
  removeFolder: (id: string) => Promise<void>;
  moveToFolder: (sessionId: string, folderId: string | null) => Promise<void>;
  saveLayout: () => Promise<void>;
}

/**
 * 樂觀更新：先改本地 state 再呼叫後端；失敗就重新 load() 把畫面拉回真相，並把錯誤往上丟給呼叫端 toast。
 */
export const useSshSessions = create<SshSessionsStore>((set, get) => {
  // 失敗後的回復：重新載入（load 自己會吞錯並寫 error），再把原錯誤丟回去
  const rollback = async (e: unknown): Promise<never> => {
    await get().load();
    throw e;
  };

  return {
    folders: [],
    sessions: [],
    loaded: false,
    loading: false,
    error: null,

    load: async () => {
      set({ loading: true });
      try {
        const file = await api.sshSessionsList();
        set({ folders: file.folders ?? [], sessions: file.sessions ?? [], loaded: true, loading: false, error: null });
      } catch (e) {
        set({ loading: false, error: errMsg(e) });
      }
    },

    save: async (s, password, passphrase) => {
      const cur = get().sessions;
      const exists = cur.some((x) => x.id === s.id);
      set({ sessions: exists ? cur.map((x) => (x.id === s.id ? s : x)) : [...cur, s] });
      try {
        await api.sshSessionSave(s, password ?? null, passphrase ?? null);
      } catch (e) {
        await rollback(e);
      }
    },

    remove: async (id) => {
      set({ sessions: get().sessions.filter((x) => x.id !== id) });
      try {
        await api.sshSessionRemove(id);
      } catch (e) {
        await rollback(e);
      }
    },

    addFolder: async (name, parentId = null) => {
      const folder: SshFolder = { id: newId(), name: uniqueFolderName(get().folders, name), parent_id: parentId };
      set({ folders: [...get().folders, folder] });
      await get().saveLayout();
      return folder;
    },

    renameFolder: async (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set({ folders: get().folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) });
      await get().saveLayout();
    },

    removeFolder: async (id) => {
      const target = get().folders.find((f) => f.id === id);
      if (!target) return;
      set({
        folders: get()
          .folders.filter((f) => f.id !== id)
          .map((f) => (f.parent_id === id ? { ...f, parent_id: target.parent_id } : f)),
        sessions: get().sessions.map((s) => (s.folder_id === id ? { ...s, folder_id: null } : s)),
      });
      await get().saveLayout();
    },

    moveToFolder: async (sessionId, folderId) => {
      set({ sessions: get().sessions.map((s) => (s.id === sessionId ? { ...s, folder_id: folderId } : s)) });
      await get().saveLayout();
    },

    saveLayout: async () => {
      const { folders, sessions } = get();
      try {
        await api.sshSessionsLayoutSave(folders, sessionsToPlacements(sessions));
      } catch (e) {
        await rollback(e);
      }
    },
  };
});
