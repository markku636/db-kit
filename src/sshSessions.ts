import { create } from "zustand";
import { api } from "./api";
import type { SshFolder, SshPlacement, SshSession } from "./sshTypes";
import { applyPlacementsTo, type Placement } from "./sidebarGroups";

// SSH 主機清單：側欄「SSH 主機」區塊與主機對話框共用的資料 store，加上幾支可單測的純函式。
// 純函式放前面、store 放後面；測試只碰純函式（store 一呼叫就會 invoke Tauri）。

/** 顯示名稱：有名稱用名稱，否則 user@host。 */
export function sessionLabel(s: Pick<SshSession, "name" | "username" | "host">): string {
  const name = s.name?.trim();
  if (name) return name;
  return s.username ? `${s.username}@${s.host}` : s.host;
}

/** 分組 / 搜尋 / 版面只看這幾個欄位：遠端桌面主機（rdSessions.ts）共用同一套。 */
export interface HostLike {
  id: string;
  name: string;
  host: string;
  username: string;
  folder_id: string | null;
}

function byLabel(a: HostLike, b: HostLike): number {
  return sessionLabel(a).localeCompare(sessionLabel(b), undefined, { sensitivity: "base", numeric: true });
}

export interface SshSessionGroup<S extends HostLike = SshSession, F extends { id: string } = SshFolder> {
  folder: F;
  sessions: S[];
}

export interface GroupedSshSessions<S extends HostLike = SshSession, F extends { id: string } = SshFolder> {
  /** 依 folders 原順序；空資料夾也保留（使用者剛建好還沒放東西）。 */
  groups: SshSessionGroup<S, F>[];
  /** 未分類（folder_id 為 null 或指到不存在的資料夾）。 */
  loose: S[];
}

/**
 * 把 sessions 依群組（folder_id）分組；組內維持陣列順序（＝使用者拖曳排出來的順序）。不做巢狀群組。
 * 舊版存檔是依名稱排序顯示的，後端第一次讀到舊檔時會先依名稱排好寫回（ssh/sessions.rs 的 v2 遷移）。
 */
export function groupSessions<S extends HostLike, F extends { id: string }>(folders: F[], sessions: S[]): GroupedSshSessions<S, F> {
  const byFolder = new Map<string, S[]>();
  for (const f of folders) byFolder.set(f.id, []);
  const loose: S[] = [];
  for (const s of sessions) {
    const bucket = s.folder_id ? byFolder.get(s.folder_id) : undefined;
    if (bucket) bucket.push(s);
    else loose.push(s);
  }
  return {
    groups: folders.map((folder) => ({ folder, sessions: byFolder.get(folder.id) ?? [] })),
    loose,
  };
}

/**
 * 主機設定裡可選的跳板機：排除自己，以及跳板機鏈最後會繞回自己的（A 經 B、B 又經 A）。
 * 鏈上指到已刪除的主機就當作到此為止。依顯示名稱排序。
 */
export function jumpChoices(sessions: readonly SshSession[], selfId: string): SshSession[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const leadsToSelf = (start: SshSession): boolean => {
    const seen = new Set<string>();
    let cur: SshSession | undefined = start;
    while (cur) {
      if (cur.id === selfId) return true;
      if (seen.has(cur.id)) return false; // 別人之間的迴圈，與自己無關
      seen.add(cur.id);
      cur = cur.jump_session_id ? byId.get(cur.jump_session_id) : undefined;
    }
    return false;
  };
  return sessions.filter((s) => s.id !== selfId && !leadsToSelf(s)).sort(byLabel);
}

/** 側欄搜尋：比對名稱 / 主機 / 使用者（不分大小寫、前後空白忽略）；空字串回原陣列。 */
export function filterSessions<S extends HostLike>(sessions: S[], q: string): S[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter(
    (s) =>
      s.name.toLowerCase().includes(needle) ||
      s.host.toLowerCase().includes(needle) ||
      s.username.toLowerCase().includes(needle),
  );
}

/** 避免同名資料夾："base" 已存在就 "base 2"、"base 3"…（不分大小寫）。空名稱給「新群組」。 */
export function uniqueFolderName(folders: Pick<SshFolder, "name">[], base: string): string {
  const b = base.trim() || "新群組";
  const taken = new Set(folders.map((f) => f.name.trim().toLowerCase()));
  if (!taken.has(b.toLowerCase())) return b;
  for (let i = 2; ; i++) {
    const cand = `${b} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

/** 回存版面用：每個 session 落在哪個資料夾。 */
export function sessionsToPlacements(sessions: HostLike[]): SshPlacement[] {
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
  /** 側欄拖曳 / 搬移 / 群組增刪改：一次換掉群組清單與主機順序（先更新畫面再落地，失敗就重新載入並把錯誤丟回）。 */
  applyLayout: (folders: SshFolder[], placements: Placement[]) => Promise<void>;
  /** 側欄單擊選取的主機（右側「詳細資料」面板顯示它）；與資料庫樹的 selectedNode 互斥，由側欄兩邊各自清掉對方。 */
  selectedId: string | null;
  select: (id: string | null) => void;
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
    selectedId: null,
    select: (id) => set({ selectedId: id }),

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

    applyLayout: async (folders, placements) => {
      set({ folders, sessions: applyPlacementsTo(get().sessions, placements, (s, folder_id) => ({ ...s, folder_id })) });
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
