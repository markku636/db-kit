import { create } from "zustand";
import { api } from "./api";
import type { RdFolder, RdProtocol, RdSession } from "./rdTypes";
import { effectiveRdPort } from "./rdTypes";
import { groupSessions, filterSessions, sessionsToPlacements, uniqueFolderName } from "./sshSessions";
import { applyPlacementsTo, type Placement } from "./sidebarGroups";

// 遠端桌面主機清單：側欄「遠端桌面」區塊與主機對話框共用的資料 store。
// 分組 / 搜尋 / 資料夾命名直接沿用 sshSessions 的純函式（它們只看 name / host / username / folder_id）。

/** 顯示名稱：有名稱用名稱，否則 user@host（RustDesk 的 host 是對方 ID）。 */
export function rdSessionLabel(s: Pick<RdSession, "name" | "username" | "host">): string {
  const name = s.name?.trim();
  if (name) return name;
  return s.username ? `${s.username}@${s.host}` : s.host;
}

/** 協定的顯示名（徽章 / 選單）。 */
export function rdProtocolLabel(p: RdProtocol): string {
  return p === "rdp" ? "RDP" : p === "vnc" ? "VNC" : "RustDesk";
}

/** 詳細資料 / 提示用：`host:port`（RustDesk ID 不加 port）。 */
export function rdEndpoint(s: Pick<RdSession, "protocol" | "host" | "port">): string {
  if (s.protocol === "rustdesk" && !/[.:]/.test(s.host)) return s.host;
  return `${s.host}:${effectiveRdPort(s)}`;
}

export const groupRdSessions = (folders: RdFolder[], sessions: RdSession[]) => groupSessions(folders, sessions);

export const filterRdSessions = (sessions: RdSession[], q: string) => filterSessions(sessions, q);

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errMsg(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? String(e);
}

export interface RdSessionsStore {
  folders: RdFolder[];
  sessions: RdSession[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** 新增或更新（依 id）。password 非空才寫入 keychain，null = 保留既有。 */
  save: (s: RdSession, password?: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addFolder: (name: string, parentId?: string | null) => Promise<RdFolder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  removeFolder: (id: string) => Promise<void>;
  moveToFolder: (sessionId: string, folderId: string | null) => Promise<void>;
  saveLayout: () => Promise<void>;
  /** 側欄拖曳 / 搬移 / 群組增刪改：一次換掉群組清單與主機順序（先更新畫面再落地，失敗就重新載入並把錯誤丟回）。 */
  applyLayout: (folders: RdFolder[], placements: Placement[]) => Promise<void>;
}

/** 樂觀更新：先改本地 state 再呼叫後端；失敗就重新 load() 拉回真相，並把錯誤丟給呼叫端 toast。 */
export const useRdSessions = create<RdSessionsStore>((set, get) => {
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
        const file = await api.rdSessionsList();
        set({ folders: file.folders ?? [], sessions: file.sessions ?? [], loaded: true, loading: false, error: null });
      } catch (e) {
        set({ loading: false, error: errMsg(e) });
      }
    },

    save: async (s, password) => {
      const cur = get().sessions;
      const exists = cur.some((x) => x.id === s.id);
      set({ sessions: exists ? cur.map((x) => (x.id === s.id ? s : x)) : [...cur, s] });
      try {
        await api.rdSessionSave(s, password ?? null);
      } catch (e) {
        await rollback(e);
      }
    },

    remove: async (id) => {
      set({ sessions: get().sessions.filter((x) => x.id !== id) });
      try {
        await api.rdSessionRemove(id);
      } catch (e) {
        await rollback(e);
      }
    },

    addFolder: async (name, parentId = null) => {
      const folder: RdFolder = { id: newId(), name: uniqueFolderName(get().folders, name), parent_id: parentId };
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

    applyLayout: async (folders, placements) => {
      set({ folders, sessions: applyPlacementsTo(get().sessions, placements, (s, folder_id) => ({ ...s, folder_id })) });
      await get().saveLayout();
    },

    saveLayout: async () => {
      const { folders, sessions } = get();
      try {
        await api.rdSessionsLayoutSave(folders, sessionsToPlacements(sessions));
      } catch (e) {
        await rollback(e);
      }
    },
  };
});
