import { create } from "zustand";
import { ConnectionConfig } from "./api";

// 一個開啟的表分頁
export interface OpenTab {
  key: string;        // connId:database:table 唯一鍵
  connId: string;
  database: string;
  table: string;
  view: "data" | "structure"; // 結構 / 資料 分頁
}

interface AppStore {
  // 已儲存的連線設定（持久化於磁碟，密碼存 OS keychain；啟動時載入清單）
  connections: ConnectionConfig[];
  // 目前已開啟連線的 id 集合
  connectedIds: Set<string>;
  // 當前選取的連線
  activeId: string | null;
  // 已開啟的表分頁
  tabs: OpenTab[];
  activeTabKey: string | null;
  // 由側欄「產生 SQL」送往查詢編輯器的待載入語句（消費後清空）。
  pendingSql: string | null;

  setConnections: (cs: ConnectionConfig[]) => void;
  addConnection: (c: ConnectionConfig) => void;
  removeConnection: (id: string) => void;
  setActive: (id: string | null) => void;
  markConnected: (id: string) => void;
  markDisconnected: (id: string) => void;

  openTable: (connId: string, database: string, table: string) => void;
  closeTab: (key: string) => void;
  closeOtherTabs: (key: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (key: string) => void;
  setTabView: (key: string, view: "data" | "structure") => void;
  // 將一段 SQL 載入查詢編輯器並切到查詢分頁。
  requestQuery: (sql: string) => void;
  clearPendingSql: () => void;
}

export const useStore = create<AppStore>((set) => ({
  connections: [],
  connectedIds: new Set(),
  activeId: null,
  tabs: [],
  activeTabKey: null,
  pendingSql: null,

  setConnections: (cs) => set({ connections: cs }),
  addConnection: (c) =>
    set((s) => ({ connections: [...s.connections.filter((x) => x.id !== c.id), c] })),
  removeConnection: (id) =>
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    })),
  setActive: (id) => set({ activeId: id }),
  markConnected: (id) =>
    set((s) => ({ connectedIds: new Set(s.connectedIds).add(id) })),
  markDisconnected: (id) =>
    set((s) => {
      const next = new Set(s.connectedIds);
      next.delete(id);
      // 同時關閉該連線底下所有分頁
      const tabs = s.tabs.filter((t) => t.connId !== id);
      return {
        connectedIds: next,
        tabs,
        // "__query__" 是查詢分頁的哨兵鍵，從不在 tabs 內；它屬於仍連線的連線，
        // 中斷其他連線時應保留，不該把使用者踢離查詢編輯器。
        activeTabKey:
          s.activeTabKey === "__query__" || tabs.some((t) => t.key === s.activeTabKey)
            ? s.activeTabKey
            : tabs.length ? tabs[tabs.length - 1].key : null,
      };
    }),

  openTable: (connId, database, table) =>
    set((s) => {
      const key = `${connId}:${database}:${table}`;
      if (s.tabs.some((t) => t.key === key)) {
        return { activeTabKey: key };
      }
      const tab: OpenTab = { key, connId, database, table, view: "data" };
      return { tabs: [...s.tabs, tab], activeTabKey: key };
    }),
  closeTab: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      return {
        tabs,
        activeTabKey:
          s.activeTabKey === key ? tabs.length ? tabs[tabs.length - 1].key : null : s.activeTabKey,
      };
    }),
  // 關閉除 key 以外的所有表分頁；保留 key 並設為作用中。
  closeOtherTabs: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key === key);
      return { tabs, activeTabKey: tabs.length ? key : null };
    }),
  closeAllTabs: () => set({ tabs: [], activeTabKey: null }),
  // 設定待載入 SQL 並切到查詢分頁（QueryPane 掛載後消費）。
  requestQuery: (sql) => set({ pendingSql: sql, activeTabKey: "__query__" }),
  clearPendingSql: () => set({ pendingSql: null }),
  setActiveTab: (key) => set({ activeTabKey: key }),
  setTabView: (key, view) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, view } : t)),
    })),
}));
