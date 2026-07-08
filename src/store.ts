import { create } from "zustand";
import { ConnectionConfig, DbKind } from "./api";
import { loadReadonly, persistReadonly, setReadonlyFlag, type ReadonlyMap } from "./connReadonly";
import {
  loadSavedQueries,
  persistSavedQueries,
  upsertSavedQuery,
  updateSavedQuery as applySavedQueryUpdate,
  removeSavedQuery as dropSavedQuery,
  reorderSavedQueries as moveSavedQuery,
  loadSnippets,
  persistSnippets,
  upsertSnippet,
  removeSnippet as dropSnippet,
  mergeSnippets,
  type SavedQuery,
  type SqlSnippet,
} from "./sql";

// 一個開啟的表分頁
export interface OpenTab {
  key: string;        // connId:database:table 唯一鍵
  connId: string;
  database: string;
  table: string;
  view: "data" | "structure"; // 結構 / 資料 分頁
  objKind: string;    // "table" | "view"（視圖不可新增資料列）
}

// 右側「詳細資料」面板目前選取的樹節點（單擊即選；對標 Navicat 物件資訊面板）。
export type SelectedNode =
  | { type: "connection"; connId: string }
  | { type: "database"; connId: string; db: string; kind: DbKind }
  | { type: "table"; connId: string; db: string; table: string; kind: DbKind; objKind: string };

interface AppStore {
  // 已儲存的連線設定（持久化於磁碟，密碼存 OS keychain；啟動時載入清單）
  connections: ConnectionConfig[];
  // 目前已開啟連線的 id 集合
  connectedIds: Set<string>;
  // 唯讀連線（connId → true）：擋查詢編輯器寫入 / DDL 與資料格編輯，避免正式環境誤改。
  readonlyConns: ReadonlyMap;
  // 當前選取的連線
  activeId: string | null;
  // 已開啟的表分頁
  tabs: OpenTab[];
  activeTabKey: string | null;
  // 查詢分頁（多開）：id 清單，永遠含預設「__query__」（home，不可關）；額外分頁為 __query__:2、:3…
  queryTabs: string[];
  // 由側欄「產生 SQL」送往查詢編輯器的待載入語句（消費後清空）。
  pendingSql: string | null;
  // 待開啟新增列對話框的分頁鍵（右鍵「新增資料列」→ 開表後由該分頁消費）。
  pendingInsert: string | null;
  // 外鍵導覽：開啟被參照表並套用 col=value 篩選（開表後由該分頁消費）。
  pendingFilter: { key: string; column: string; value: string } | null;
  // 資料重載信號：key（connId:db:table）→ nonce，外部操作（如 TRUNCATE）後遞增以強制開啟中的資料頁重載。
  dataReload: Record<string, number>;
  // 右側詳細資料面板目前選取的節點（單擊樹節點即更新）。
  selectedNode: SelectedNode | null;
  // 收藏查詢（全域，localStorage）：反應式 slice，側欄與各查詢分頁編輯器共用單一來源。
  savedQueries: SavedQuery[];
  // SQL 片段庫（含 builtin，反應式）：編輯器自動完成 + 管理 + 匯入後即時更新。
  snippets: SqlSnippet[];
  // 收藏查詢管理視窗開啟狀態（跨 Sidebar / QueryPane 觸發；null = 關閉）。
  // seedSql 非 null → 直接開「新增」編輯模式並預填 SQL；editName 非 null → 開該筆「編輯」模式。
  savedMgr: { seedSql: string | null; editName: string | null } | null;

  setConnections: (cs: ConnectionConfig[]) => void;
  addConnection: (c: ConnectionConfig) => void;
  removeConnection: (id: string) => void;
  setActive: (id: string | null) => void;
  markConnected: (id: string) => void;
  markDisconnected: (id: string) => void;
  // 切換連線唯讀（持久化）。
  setConnReadonly: (id: string, ro: boolean) => void;

  openTable: (connId: string, database: string, table: string, view?: "data" | "structure", objKind?: string) => void;
  closeTab: (key: string) => void;
  closeOtherTabs: (key: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (key: string) => void;
  // 多查詢分頁：新增一個查詢分頁並切過去 / 關閉某查詢分頁（預設 __query__ 不可關）。
  addQueryTab: () => void;
  // 開「新查詢分頁」並可帶入起始 SQL（由新分頁的 QueryPane 掛載後消費）與切換連線。
  // 供側欄節點 / Ctrl+N / 工具列「新查詢」共用：永遠開新分頁、不覆蓋現有編輯器內容。
  newQueryTab: (sql?: string, connId?: string) => void;
  closeQueryTab: (id: string) => void;
  setTabView: (key: string, view: "data" | "structure") => void;
  // 物件被刪除時連帶關閉其分頁（沿用 markDisconnected 的清理慣例）。
  closeTableTab: (connId: string, database: string, table: string) => void;
  closeTablesUnder: (connId: string, database: string) => void;
  // 將一段 SQL 載入查詢編輯器並切到查詢分頁。
  requestQuery: (sql: string) => void;
  clearPendingSql: () => void;
  // 要求某分頁開啟新增列對話框（右鍵新增資料列）。
  requestInsert: (key: string) => void;
  clearPendingInsert: () => void;
  // 外鍵導覽：開啟被參照的資料表並套用 col=value 篩選。
  openTableFiltered: (connId: string, database: string, table: string, column: string, value: string) => void;
  clearPendingFilter: () => void;
  // 遞增某表的資料重載 nonce（TRUNCATE 後呼叫，使開啟中的資料頁重新查詢）。
  bumpDataReload: (connId: string, database: string, table: string) => void;
  // 設定詳細資料面板選取的節點（null 清空）。
  selectNode: (node: SelectedNode | null) => void;

  // 收藏查詢 mutation（純轉換 → persist → set；對標 setConnReadonly）。
  addSavedQuery: (sq: SavedQuery) => void;             // 新增 / 同名覆蓋；蓋時間戳
  updateSavedQuery: (oldName: string, sq: SavedQuery) => void; // 編輯（可改名）
  removeSavedQuery: (name: string) => void;
  reorderSavedQueries: (from: number, to: number) => void;
  replaceSavedQueries: (list: SavedQuery[]) => void;   // 匯入用（整批取代）
  // 片段 mutation。
  addSnippet: (snip: SqlSnippet) => void;
  removeSnippet: (name: string) => void;
  replaceSnippets: (userList: SqlSnippet[]) => void;   // 匯入用；傳入使用者片段，內部 merge builtin
  // 開 / 關收藏查詢管理視窗。
  openSavedManager: (opts?: { seedSql?: string | null; editName?: string | null }) => void;
  closeSavedManager: () => void;
}

export const useStore = create<AppStore>((set) => ({
  connections: [],
  connectedIds: new Set(),
  readonlyConns: loadReadonly(),
  activeId: null,
  tabs: [],
  activeTabKey: null,
  queryTabs: ["__query__"],
  pendingSql: null,
  pendingInsert: null,
  pendingFilter: null,
  dataReload: {},
  selectedNode: null,
  savedQueries: loadSavedQueries(),
  snippets: loadSnippets(),
  savedMgr: null,

  setConnReadonly: (id, ro) =>
    set((s) => {
      const next = setReadonlyFlag(s.readonlyConns, id, ro);
      persistReadonly(next);
      return { readonlyConns: next };
    }),
  setConnections: (cs) => set({ connections: cs }),
  addConnection: (c) =>
    set((s) => ({ connections: [...s.connections.filter((x) => x.id !== c.id), c] })),
  removeConnection: (id) =>
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
      selectedNode: s.selectedNode?.connId === id ? null : s.selectedNode,
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
        // 中斷連線後，該連線底下的資料庫 / 表節點已不可見，連帶清空詳細資料選取。
        selectedNode: s.selectedNode?.connId === id ? null : s.selectedNode,
        // "__query__" 是查詢分頁的哨兵鍵，從不在 tabs 內；它屬於仍連線的連線，
        // 中斷其他連線時應保留，不該把使用者踢離查詢編輯器。
        activeTabKey:
          s.activeTabKey === "__query__" || tabs.some((t) => t.key === s.activeTabKey)
            ? s.activeTabKey
            : tabs.length ? tabs[tabs.length - 1].key : "__query__",
      };
    }),

  openTable: (connId, database, table, view = "data", objKind = "table") =>
    set((s) => {
      const key = `${connId}:${database}:${table}`;
      if (s.tabs.some((t) => t.key === key)) {
        // 已開啟：切到該分頁，並套用指定檢視（如從右鍵「設計表結構」直接進結構頁）。
        return { activeTabKey: key, tabs: s.tabs.map((t) => (t.key === key ? { ...t, view } : t)) };
      }
      const tab: OpenTab = { key, connId, database, table, view, objKind };
      return { tabs: [...s.tabs, tab], activeTabKey: key };
    }),
  closeTab: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      return {
        tabs,
        // 沒有表分頁時退回查詢分頁哨兵（而非 null），使查詢分頁標示為作用中、鍵盤切換索引正確。
        activeTabKey:
          s.activeTabKey === key ? (tabs.length ? tabs[tabs.length - 1].key : "__query__") : s.activeTabKey,
      };
    }),
  // 關閉除 key 以外的所有表分頁；保留 key 並設為作用中。
  closeOtherTabs: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key === key);
      return { tabs, activeTabKey: tabs.length ? key : "__query__" };
    }),
  closeAllTabs: () => set({ tabs: [], activeTabKey: "__query__" }),
  // 新增查詢分頁：產生不重複 id（__query__:N）並切過去。
  addQueryTab: () =>
    set((s) => {
      let n = 2;
      while (s.queryTabs.includes(`__query__:${n}`)) n++;
      const id = `__query__:${n}`;
      return { queryTabs: [...s.queryTabs, id], activeTabKey: id };
    }),
  // 開新查詢分頁並（可選）帶入起始 SQL / 切換連線：新分頁掛載後由其 QueryPane 消費 pendingSql 載入。
  // sql 為 undefined → 開乾淨空白分頁（pendingSql 設 null，不觸發清空/存歷史路徑）。
  newQueryTab: (sql, connId) =>
    set((s) => {
      let n = 2;
      while (s.queryTabs.includes(`__query__:${n}`)) n++;
      const id = `__query__:${n}`;
      return {
        queryTabs: [...s.queryTabs, id],
        activeTabKey: id,
        pendingSql: sql ?? null,
        activeId: connId ?? s.activeId,
      };
    }),
  // 關閉查詢分頁：預設 home「__query__」不可關；關掉作用中者則切到相鄰查詢分頁。
  closeQueryTab: (id) =>
    set((s) => {
      if (id === "__query__" || s.queryTabs.length <= 1) return {};
      const queryTabs = s.queryTabs.filter((t) => t !== id);
      const activeTabKey =
        s.activeTabKey === id ? queryTabs[queryTabs.length - 1] : s.activeTabKey;
      return { queryTabs, activeTabKey };
    }),
  // 設定待載入 SQL 並切到查詢分頁（QueryPane 掛載後消費）。作用中已是某查詢分頁則留在原分頁，
  // 否則（在表分頁）切到 home 查詢分頁。
  requestQuery: (sql) =>
    set((s) => ({
      pendingSql: sql,
      activeTabKey: s.queryTabs.includes(s.activeTabKey ?? "") ? s.activeTabKey : s.queryTabs[0],
    })),
  clearPendingSql: () => set({ pendingSql: null }),
  requestInsert: (key) => set({ pendingInsert: key }),
  clearPendingInsert: () => set({ pendingInsert: null }),
  // 開啟（或切到）被參照表，並排入 col=value 篩選；TableView 掛載 / pendingFilter 變動時消費。
  openTableFiltered: (connId, database, table, column, value) =>
    set((s) => {
      const key = `${connId}:${database}:${table}`;
      const tabs = s.tabs.some((t) => t.key === key)
        ? s.tabs.map((t) => (t.key === key ? { ...t, view: "data" as const } : t))
        : [...s.tabs, { key, connId, database, table, view: "data" as const, objKind: "table" }];
      return { tabs, activeTabKey: key, pendingFilter: { key, column, value } };
    }),
  clearPendingFilter: () => set({ pendingFilter: null }),
  setActiveTab: (key) => set({ activeTabKey: key }),
  setTabView: (key, view) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, view } : t)),
    })),
  closeTableTab: (connId, database, table) =>
    set((s) => {
      const key = `${connId}:${database}:${table}`;
      const tabs = s.tabs.filter((t) => t.key !== key);
      return {
        tabs,
        activeTabKey:
          s.activeTabKey === key ? (tabs.length ? tabs[tabs.length - 1].key : "__query__") : s.activeTabKey,
      };
    }),
  closeTablesUnder: (connId, database) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => !(t.connId === connId && t.database === database));
      // 保留查詢編輯器哨兵鍵；作用中分頁若被關閉則退回最後一個。
      const stillActive = s.activeTabKey === "__query__" || tabs.some((t) => t.key === s.activeTabKey);
      return {
        tabs,
        activeTabKey: stillActive ? s.activeTabKey : tabs.length ? tabs[tabs.length - 1].key : "__query__",
      };
    }),
  bumpDataReload: (connId, database, table) =>
    set((s) => {
      const key = `${connId}:${database}:${table}`;
      return { dataReload: { ...s.dataReload, [key]: (s.dataReload[key] ?? 0) + 1 } };
    }),
  selectNode: (node) => set({ selectedNode: node }),

  // ---- 收藏查詢 ----
  addSavedQuery: (sq) =>
    set((s) => {
      const now = Date.now();
      const stamped: SavedQuery = { ...sq, createdAt: sq.createdAt ?? now, updatedAt: now };
      const next = upsertSavedQuery(s.savedQueries, stamped);
      persistSavedQueries(next);
      return { savedQueries: next };
    }),
  updateSavedQuery: (oldName, sq) =>
    set((s) => {
      const stamped: SavedQuery = { ...sq, updatedAt: Date.now() };
      const next = applySavedQueryUpdate(s.savedQueries, oldName, stamped);
      persistSavedQueries(next);
      return { savedQueries: next };
    }),
  removeSavedQuery: (name) =>
    set((s) => {
      const next = dropSavedQuery(s.savedQueries, name);
      persistSavedQueries(next);
      return { savedQueries: next };
    }),
  reorderSavedQueries: (from, to) =>
    set((s) => {
      const next = moveSavedQuery(s.savedQueries, from, to);
      persistSavedQueries(next);
      return { savedQueries: next };
    }),
  replaceSavedQueries: (list) =>
    set(() => {
      persistSavedQueries(list);
      return { savedQueries: list };
    }),

  // ---- SQL 片段 ----
  addSnippet: (snip) =>
    set((s) => {
      const next = upsertSnippet(s.snippets, snip);
      persistSnippets(next);
      return { snippets: next };
    }),
  removeSnippet: (name) =>
    set((s) => {
      const next = dropSnippet(s.snippets, name);
      persistSnippets(next);
      return { snippets: next };
    }),
  replaceSnippets: (userList) =>
    set(() => {
      // userList 為使用者片段（不含 builtin）；mergeSnippets 疊回 builtin 並標記，persistSnippets 只存 diff。
      const next = mergeSnippets(userList);
      persistSnippets(next);
      return { snippets: next };
    }),

  openSavedManager: (opts) =>
    set({ savedMgr: { seedSql: opts?.seedSql ?? null, editName: opts?.editName ?? null } }),
  closeSavedManager: () => set({ savedMgr: null }),
}));
