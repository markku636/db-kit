import { useEffect, useRef, useState } from "react";
import { api, ConnectionConfig, DbKind, KIND_META, PoolStatus, QueryResult, TableInfo } from "./api";
import { useStore } from "./store";
import ConnectionDialog from "./ConnectionDialog";
import TableView from "./TableView";
import BackupDialog from "./BackupDialog";
import ErDiagram from "./ErDiagram";
import RedisStatus from "./RedisStatus";
import NewKeyDialog from "./NewKeyDialog";
import { toast, uiConfirm, uiPrompt, UiHost, copyToClipboard, pickSaveFile } from "./ui";
import {
  QUERY_HISTORY_KEY, loadQueryHistory, pushQueryHistory,
  loadSavedQueries, persistSavedQueries,
  resultToTsv, resultToJson, resultToCsv, fmtElapsed, splitSqlStatements,
  quoteIdent, qualifiedName,
} from "./sql";
import type { SavedQuery } from "./sql";

export default function App() {
  // null = 關閉；{ initial } = 開啟（initial 為 null 表新增、為連線表示編輯）
  const [dialog, setDialog] = useState<{ initial: ConnectionConfig | null } | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [erOpen, setErOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const { connections, connectedIds, activeId } = useStore();
  const activeConn = connections.find((c) => c.id === activeId) ?? null;
  // ER 圖僅關聯式（MySQL / PostgreSQL / SQLite）支援外鍵關係；Mongo / Redis 不適用。
  const canEr =
    !!activeConn &&
    connectedIds.has(activeConn.id) &&
    (activeConn.kind === "mysql" || activeConn.kind === "postgres" || activeConn.kind === "sqlite");

  // 啟動時載入已存連線清單（僅清單，不自動連線；密碼留在 keychain）。
  useEffect(() => {
    api
      .listSavedConnections()
      .then((saved) =>
        useStore
          .getState()
          .setConnections(saved.map((c) => ({ ...c, password: c.password ?? "" })))
      )
      .catch(() => {});
  }, []);

  // F1 切換快捷鍵說明。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "F1") { e.preventDefault(); setHelpOpen((v) => !v); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <Toolbar
        onNewConnection={() => setDialog({ initial: null })}
        onBackup={() => activeConn && setBackupOpen(true)}
        canBackup={!!activeConn}
        onEr={() => canEr && setErOpen(true)}
        canEr={canEr}
        onHelp={() => setHelpOpen(true)}
      />
      <div className="flex-1 flex min-h-0">
        <Sidebar onEdit={(c) => setDialog({ initial: c })} />
        <MainArea />
      </div>
      <StatusBar />
      {dialog && (
        <ConnectionDialog
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSaved={async (c) => {
            try {
              await api.saveConnection(c);
              toast.success(dialog.initial ? "連線已更新" : "連線已儲存");
            } catch (e: any) {
              toast.error(e?.message ?? "儲存連線失敗");
            }
            useStore.getState().addConnection(c);
            useStore.getState().setActive(c.id);
            setDialog(null);
          }}
        />
      )}
      {backupOpen && activeConn && (
        <BackupDialog
          conn={activeConn}
          database={null}
          onClose={() => setBackupOpen(false)}
        />
      )}
      {erOpen && activeConn && canEr && (
        <ErDiagram connId={activeConn.id} onClose={() => setErOpen(false)} />
      )}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      <UiHost />
    </div>
  );

  function StatusBar() {
    const active = connections.find((c) => c.id === activeId);
    const isConnected = !!active && connectedIds.has(active.id);
    return (
      <div className="h-7 bg-[#11161d] border-t border-white/10 px-3 flex items-center text-xs text-white/40 gap-4">
        <span>at-kit</span>
        {active && (
          <span className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: isConnected ? KIND_META[active.kind].color : "transparent",
                border: `1px solid ${KIND_META[active.kind].color}`,
              }}
            />
            {KIND_META[active.kind].label} · {active.host}:{active.port}
            {isConnected ? " · 已連線" : " · 未連線"}
          </span>
        )}
        {isConnected && active && <PoolStatusBadge connId={active.id} />}
      </div>
    );
  }
}

// 連線池即時狀態徽章（每 4 秒輪詢 `pool_status`，呼應規劃 3.5 的連線生命週期監控）。
function PoolStatusBadge({ connId }: { connId: string }) {
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [pinging, setPinging] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      api
        .poolStatus(connId)
        .then((p) => !cancelled && setPool(p))
        .catch(() => !cancelled && setPool(null));
    };
    tick();
    const timer = window.setInterval(tick, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [connId]);
  const ping = () => {
    if (pinging) return;
    setPinging(true);
    api
      .pingConnection(connId)
      .then((ms) => toast.success(`連線正常 · 延遲 ${ms} ms`))
      .catch((e) => toast.error(`連線檢測失敗：${String(e)}`))
      .finally(() => setPinging(false));
  };
  if (!pool) return null;
  return (
    <button
      type="button"
      onClick={ping}
      disabled={pinging}
      title="點擊 Ping：檢測連線是否仍有效並量測往返延遲（含 SSH 通道）"
      className="ml-auto tabular-nums hover:text-white/90 disabled:opacity-50 cursor-pointer"
    >
      {pinging
        ? "⏳ 檢測中…"
        : pool.size > 0
        ? <>⚡ 池 {pool.in_use}/{pool.size}{pool.idle ? ` · 閒置 ${pool.idle}` : ""}</>
        /* Mongo / Redis 未公開連線池統計（size=0），顯示 Ping 而非誤導的「池 0/0」 */
        : <>⚡ Ping</>}
    </button>
  );
}

// ---- 上方大圖示工具列（Navicat 風格識別特徵）----
function Toolbar({ onNewConnection, onBackup, canBackup, onEr, canEr, onHelp }: {
  onNewConnection: () => void;
  onBackup: () => void;
  canBackup: boolean;
  onEr: () => void;
  canEr: boolean;
  onHelp: () => void;
}) {
  const tools = [
    { icon: "🔌", label: "連線", onClick: onNewConnection, disabled: false },
    { icon: "🗺", label: "ER 圖", onClick: onEr, disabled: !canEr },
    { icon: "💾", label: "備份", onClick: onBackup, disabled: !canBackup },
    { icon: "⌨", label: "快捷鍵", onClick: onHelp, disabled: false },
  ];
  return (
    <div className="h-16 bg-[#161c25] border-b border-white/10 flex items-center px-3 gap-1">
      <div className="font-semibold text-white/90 mr-4 pl-1">at-kit</div>
      {tools.map((t) => (
        <button
          type="button"
          key={t.label}
          onClick={t.onClick}
          disabled={t.disabled}
          className="w-16 h-12 flex flex-col items-center justify-center rounded hover:bg-white/5 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <span className="text-lg leading-none">{t.icon}</span>
          <span className="text-[11px] text-white/60 mt-1">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---- 快捷鍵說明（F1 開啟）----
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const groups: [string, [string, string][]][] = [
    ["查詢編輯器", [
      ["F6 / Ctrl+Enter", "執行查詢（反白則只執行選取段）"],
      ["Tab", "插入兩個空格縮排"],
      ["Ctrl+/", "切換選取行的 SQL 註解"],
      ["★ / 收藏", "收藏 / 載回常用查詢"],
    ]],
    ["資料表格", [
      ["方向鍵 / Tab", "移動選取儲存格（略過隱藏欄）"],
      ["Enter / F2", "編輯選取儲存格"],
      ["Ctrl+C", "複製選取儲存格"],
      ["F5", "重新整理目前頁"],
      ["雙擊儲存格", "編輯；雙擊欄分隔線自動符合寬度"],
      ["點列號", "整列表單檢視"],
      ["右鍵", "複製 / 篩選 / 設 NULL / 刪除 等"],
      ["點欄標題 / Shift+點", "排序 / 多欄排序"],
    ]],
    ["分頁與全域", [
      ["Ctrl+W", "關閉作用中表分頁"],
      ["中鍵點分頁", "關閉分頁"],
      ["Esc", "關閉對話框 / 取消選取"],
      ["F1", "顯示 / 隱藏本說明"],
    ]],
  ];
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[560px] max-w-[92vw] max-h-[82vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center text-sm">
          <span className="font-medium">⌨ 鍵盤快捷鍵</span>
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>
        <div className="p-5 overflow-auto space-y-4">
          {groups.map(([title, rows]) => (
            <div key={title}>
              <div className="text-xs text-white/40 mb-1.5">{title}</div>
              <div className="space-y-1">
                {rows.map(([k, desc]) => (
                  <div key={k} className="flex items-baseline gap-3 text-sm">
                    <kbd className="shrink-0 min-w-[120px] mono text-[11px] text-blue-300 bg-black/30 border border-white/10 rounded px-1.5 py-0.5">{k}</kbd>
                    <span className="text-white/70">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- 左側連線/物件樹 ----
function Sidebar({ onEdit }: { onEdit: (c: ConnectionConfig) => void }) {
  const { connections, connectedIds, activeId, setActive } = useStore();
  const [databases, setDatabases] = useState<Record<string, string[]>>({});
  // 已展開的資料庫: 鍵為 connId:db
  const [expandedDbs, setExpandedDbs] = useState<Record<string, TableInfo[]>>({});
  // 連線中（顯示 loading）的 id 集合
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  // 右鍵選單（連線節點）
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // 右鍵選單（Redis DB 節點）
  const [dbMenu, setDbMenu] = useState<{ connId: string; db: string; x: number; y: number } | null>(null);
  // Redis 伺服器狀態面板
  const [status, setStatus] = useState<{ id: string; name: string } | null>(null);
  // 新增 Redis 鍵對話框
  const [newKey, setNewKey] = useState<{ connId: string; db: string } | null>(null);
  // 連線 / 表 搜尋過濾字串
  const [filter, setFilter] = useState("");
  // 右鍵選單（SQL 表節點：產生 SQL）
  const [tableMenu, setTableMenu] = useState<
    { connId: string; db: string; table: string; kind: DbKind; x: number; y: number } | null
  >(null);

  const setBusy = (id: string, on: boolean) =>
    setConnecting((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const doConnect = async (id: string) => {
    const cfg = connections.find((c) => c.id === id);
    if (!cfg || connectedIds.has(id) || connecting.has(id)) return;
    setBusy(id, true);
    try {
      await api.connect(cfg);
      useStore.getState().markConnected(id);
      const dbs = await api.listDatabases(id);
      setDatabases((d) => ({ ...d, [id]: dbs }));
    } catch (e: any) {
      toast.error(e?.message ?? "連線失敗");
    } finally {
      setBusy(id, false);
    }
  };

  const doDisconnect = async (id: string) => {
    await api.disconnect(id);
    useStore.getState().markDisconnected(id);
    setDatabases((d) => ({ ...d, [id]: [] }));
    setExpandedDbs((e) => {
      const n = { ...e };
      Object.keys(n)
        .filter((k) => k.startsWith(`${id}:`))
        .forEach((k) => delete n[k]);
      return n;
    });
  };

  const toggleConnect = (id: string) =>
    connectedIds.has(id) ? doDisconnect(id) : doConnect(id);

  const refreshDbs = async (id: string) => {
    if (!connectedIds.has(id)) return;
    try {
      const dbs = await api.listDatabases(id);
      setDatabases((d) => ({ ...d, [id]: dbs }));
      toast.success("已重新整理");
    } catch (e: any) {
      toast.error(e?.message ?? "重新整理失敗");
    }
  };

  const deleteConn = async (id: string, name: string) => {
    const ok = await uiConfirm(`刪除連線「${name}」？此動作會一併移除已儲存的密碼。`, {
      title: "刪除連線",
      danger: true,
      confirmText: "刪除",
    });
    if (!ok) return;
    try {
      await api.removeSavedConnection(id);
    } catch {
      // 即使後端清理失敗，仍從前端移除
    }
    useStore.getState().markDisconnected(id);
    useStore.getState().removeConnection(id);
    toast.success("連線已刪除");
  };

  const toggleDb = async (connId: string, db: string) => {
    const key = `${connId}:${db}`;
    if (expandedDbs[key]) {
      setExpandedDbs((e) => {
        const next = { ...e };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const tables = await api.listTables(connId, db);
      setExpandedDbs((e) => ({ ...e, [key]: tables }));
    } catch (e: any) {
      toast.error(e?.message ?? "讀取表失敗");
    }
  };

  // Redis：清空指定 DB（FLUSHDB）。沿用既有 query 通道（DB 前綴語法、無鍵引數，安全）。
  const flushDb = async (connId: string, db: string) => {
    const ok = await uiConfirm(`清空 DB ${db} 的所有鍵？此動作無法復原。`, {
      title: "清空資料庫",
      danger: true,
      confirmText: "清空",
    });
    if (!ok) return;
    try {
      await api.runQuery(connId, `${db}:FLUSHDB`);
      toast.success(`DB ${db} 已清空`);
    } catch (e: any) {
      toast.error(e?.message ?? "清空失敗");
    }
  };

  // 轉儲整庫結構 SQL（致敬 Navicat / DBeaver）：取所有表的建表 SQL → 另存檔。
  const dumpSchema = async (connId: string, db: string) => {
    try {
      const sql = await api.schemaDump(connId, db);
      const out = await pickSaveFile(`${db}_schema.sql`, [{ name: "SQL", extensions: ["sql"] }]);
      if (!out) return;
      await api.saveTextFile(out, sql);
      toast.success(`已匯出結構 SQL → ${out}`);
    } catch (e: any) {
      toast.error(e?.message ?? "匯出結構失敗");
    }
  };

  // ---- 產生 SQL（致敬 Navicat / DBeaver 的 SQL 範本）----
  const quoteId = quoteIdent;
  const qualified = qualifiedName;
  type TblRef = { connId: string; db: string; table: string; kind: DbKind };
  const sendQuery = (connId: string, sql: string) => {
    useStore.getState().setActive(connId);
    useStore.getState().requestQuery(sql);
  };
  const genSelect = (m: TblRef) =>
    sendQuery(m.connId, `SELECT *\nFROM ${qualified(m.kind, m.db, m.table)}\nLIMIT 100;`);
  const genMongoFind = (m: TblRef) =>
    sendQuery(m.connId, JSON.stringify({ db: m.db, collection: m.table, filter: {} }, null, 2));
  const genCount = (m: TblRef) =>
    sendQuery(m.connId, `SELECT COUNT(*) FROM ${qualified(m.kind, m.db, m.table)};`);
  const genInsert = async (m: TblRef) => {
    try {
      const cols = await api.tableColumns(m.connId, m.db, m.table);
      const names = cols.map((c) => quoteId(m.kind, c.name)).join(", ");
      const vals = cols.map(() => "NULL").join(", ");
      sendQuery(m.connId, `INSERT INTO ${qualified(m.kind, m.db, m.table)} (${names})\nVALUES (${vals});`);
    } catch (e: any) {
      toast.error(e?.message ?? "產生 INSERT 失敗");
    }
  };
  const copyDdl = async (m: TblRef) => {
    try {
      await copyToClipboard(await api.tableDdl(m.connId, m.db, m.table), "已複製建表 SQL");
    } catch (e: any) {
      toast.error(e?.message ?? "取得建表 SQL 失敗");
    }
  };

  const menuConn = menu ? connections.find((x) => x.id === menu.id) ?? null : null;

  // 搜尋過濾：連線依名稱、表依名稱；搜尋表名也會讓其所屬連線浮現。
  const q = filter.trim().toLowerCase();
  const connTableMatches = (connId: string) =>
    Object.entries(expandedDbs).some(
      ([k, ts]) => k.startsWith(`${connId}:`) && ts.some((t) => t.name.toLowerCase().includes(q))
    );
  const connVisible = (c: ConnectionConfig) =>
    !q || c.name.toLowerCase().includes(q) || connTableMatches(c.id);
  const tableVisible = (connName: string, tName: string) =>
    !q || connName.toLowerCase().includes(q) || tName.toLowerCase().includes(q);
  const visibleConns = connections.filter(connVisible);

  return (
    <div className="w-64 bg-[#131922] border-r border-white/10 overflow-y-auto text-sm flex flex-col">
      {connections.length > 0 && (
        <div className="sticky top-0 z-10 bg-[#131922] p-2 border-b border-white/10">
          <div className="relative">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜尋連線 / 表…"
              title="搜尋連線或表名稱"
              className="w-full bg-black/30 border border-white/10 rounded pl-2 pr-6 py-1 text-xs outline-none focus:border-blue-500"
            />
            {filter && (
              <button type="button" onClick={() => setFilter("")} title="清除"
                className="absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded text-white/30 hover:text-white/70 hover:bg-white/10">
                ×
              </button>
            )}
          </div>
        </div>
      )}
      {connections.length === 0 && (
        <div className="p-4 text-white/30 text-xs leading-relaxed">
          尚無連線。點上方「連線」新增一個，雙擊以建立連線（右鍵有更多選項）。
        </div>
      )}
      {q && visibleConns.length === 0 && (
        <div className="p-4 text-white/30 text-xs">查無符合「{filter}」的連線或表。</div>
      )}
      {visibleConns.map((c) => {
        const meta = KIND_META[c.kind];
        const connected = connectedIds.has(c.id);
        const busy = connecting.has(c.id);
        return (
          <div key={c.id}>
            <div
              onClick={() => setActive(c.id)}
              onDoubleClick={() => toggleConnect(c.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setActive(c.id);
                setMenu({ id: c.id, x: e.clientX, y: e.clientY });
              }}
              className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer ${
                activeId === c.id ? "bg-white/10" : "hover:bg-white/5"
              }`}
            >
              {busy ? (
                <span className="w-2 h-2 shrink-0 rounded-full border border-white/50 border-t-transparent animate-spin" />
              ) : (
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: connected ? meta.color : "transparent", border: `1px solid ${meta.color}` }}
                />
              )}
              <span className="truncate flex-1">{c.name}</span>
              <button type="button" title="編輯連線"
                onClick={(e) => { e.stopPropagation(); onEdit(c); }}
                className="w-4 h-4 shrink-0 items-center justify-center rounded text-white/30 hover:bg-white/15 hover:text-white/80 hidden group-hover:flex">
                ✎
              </button>
              <button type="button" title="刪除連線"
                onClick={(e) => { e.stopPropagation(); deleteConn(c.id, c.name); }}
                className="w-4 h-4 shrink-0 items-center justify-center rounded text-white/30 hover:bg-white/15 hover:text-red-300 hidden group-hover:flex">
                ×
              </button>
            </div>
            {connected &&
              (databases[c.id] ?? []).map((db) => {
                const dbKey = `${c.id}:${db}`;
                const tables = expandedDbs[dbKey];
                const isRedis = c.kind === "redis";
                const isSqlKind = c.kind === "mysql" || c.kind === "postgres" || c.kind === "sqlite";
                return (
                  <div key={db}>
                    <div
                      onClick={() => toggleDb(c.id, db)}
                      onContextMenu={(isRedis || isSqlKind) ? (e) => {
                        e.preventDefault();
                        setActive(c.id);
                        setDbMenu({ connId: c.id, db, x: e.clientX, y: e.clientY });
                      } : undefined}
                      className="pl-7 pr-3 py-1 text-white/70 hover:bg-white/5 cursor-pointer truncate flex items-center gap-1"
                    >
                      <span className="text-white/30 text-[10px] w-3">{tables ? "▼" : "▶"}</span>
                      <span className="truncate">{db}</span>
                    </div>
                    {tables &&
                      tables.filter((t) => tableVisible(c.name, t.name)).map((t) => (
                        <div
                          key={t.name}
                          onDoubleClick={() =>
                            useStore.getState().openTable(c.id, db, t.name)
                          }
                          onContextMenu={
                            c.kind !== "redis"
                              ? (e) => {
                                  e.preventDefault();
                                  setActive(c.id);
                                  setTableMenu({ connId: c.id, db, table: t.name, kind: c.kind, x: e.clientX, y: e.clientY });
                                }
                              : undefined
                          }
                          className="pl-12 pr-3 py-1 text-white/55 hover:bg-white/5 cursor-pointer truncate flex items-center gap-1.5"
                          title="雙擊開啟；右鍵產生查詢"
                        >
                          <span className="text-[10px]">{t.kind === "view" ? "◫" : "▦"}</span>
                          <span className="truncate">{t.name}</span>
                        </div>
                      ))}
                    {tables && tables.length === 0 && (
                      <div className="pl-12 pr-3 py-1 text-white/25 text-xs">無表</div>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })}

      {menu && menuConn && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-[90] min-w-[150px] bg-[#1a212b] border border-white/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: menu.x, top: menu.y }}>
            {(
              [
                [connectedIds.has(menu.id) ? "中斷連線" : "連線", () => toggleConnect(menu.id), false],
                ...(connectedIds.has(menu.id)
                  ? [["重新整理資料庫", () => refreshDbs(menu.id), false] as [string, () => void, boolean]]
                  : []),
                ...(connectedIds.has(menu.id) && menuConn.kind === "redis"
                  ? [["伺服器狀態", () => setStatus({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean]]
                  : []),
                ["編輯…", () => onEdit(menuConn), false],
                ["複製連線…", () => onEdit({ ...menuConn, id: crypto.randomUUID(), name: `${menuConn.name} 複本`, password: "" }), false],
                ["刪除", () => deleteConn(menuConn.id, menuConn.name), true],
              ] as [string, () => void, boolean][]
            ).map(([label, fn, danger]) => (
              <button key={label} type="button"
                onClick={() => { setMenu(null); fn(); }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-white/10 ${danger ? "text-red-300" : "text-white/80"}`}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {dbMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setDbMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setDbMenu(null); }} />
          <div className="fixed z-[90] min-w-[150px] bg-[#1a212b] border border-white/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: dbMenu.x, top: dbMenu.y }}>
            {(() => {
              const dbConn = connections.find((x) => x.id === dbMenu.connId);
              const items: [string, () => void, boolean][] =
                dbConn?.kind === "redis"
                  ? [
                      ["新增鍵…", () => setNewKey({ connId: dbMenu.connId, db: dbMenu.db }), false],
                      ["伺服器狀態", () => { if (dbConn) setStatus({ id: dbConn.id, name: dbConn.name }); }, false],
                      ["清空 DB（FLUSHDB）", () => flushDb(dbMenu.connId, dbMenu.db), true],
                    ]
                  : [
                      ["匯出結構 SQL…", () => dumpSchema(dbMenu.connId, dbMenu.db), false],
                    ];
              return items.map(([label, fn, danger]) => (
                <button key={label} type="button"
                  onClick={() => { setDbMenu(null); fn(); }}
                  className={`block w-full text-left px-3 py-1.5 hover:bg-white/10 ${danger ? "text-red-300" : "text-white/80"}`}>
                  {label}
                </button>
              ));
            })()}
          </div>
        </>
      )}

      {tableMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setTableMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setTableMenu(null); }} />
          <div className="fixed z-[90] min-w-[170px] bg-[#1a212b] border border-white/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: tableMenu.x, top: tableMenu.y }}>
            {(
              tableMenu.kind === "mongo"
                ? ([
                    ["開啟集合", () => useStore.getState().openTable(tableMenu.connId, tableMenu.db, tableMenu.table)],
                    ["查詢此集合", () => genMongoFind(tableMenu)],
                    ["複製集合名", () => copyToClipboard(tableMenu.table, "已複製集合名")],
                  ] as [string, () => void][])
                : ([
                    ["開啟資料表", () => useStore.getState().openTable(tableMenu.connId, tableMenu.db, tableMenu.table)],
                    ["查詢前 100 筆", () => genSelect(tableMenu)],
                    ["SELECT COUNT(*)", () => genCount(tableMenu)],
                    ["產生 INSERT 範本", () => genInsert(tableMenu)],
                    ["複製建表 SQL", () => copyDdl(tableMenu)],
                    ["複製表名", () => copyToClipboard(tableMenu.table, "已複製表名")],
                  ] as [string, () => void][])
            ).map(([label, fn]) => (
              <button key={label} type="button"
                onClick={() => { setTableMenu(null); fn(); }}
                className="block w-full text-left px-3 py-1.5 hover:bg-white/10 text-white/80">
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {status && (
        <RedisStatus connId={status.id} connName={status.name} onClose={() => setStatus(null)} />
      )}

      {newKey && (
        <NewKeyDialog
          connId={newKey.connId}
          database={newKey.db}
          onClose={() => setNewKey(null)}
          onCreated={() => {/* 鍵列表於該 DB 的分頁開啟時由使用者自行重新整理 */}}
        />
      )}
    </div>
  );
}

// ---- 中央主工作區：分頁式（表分頁 + 查詢） ----
function MainArea() {
  const { activeId, connectedIds, tabs, activeTabKey, setActiveTab, closeTab, closeOtherTabs, closeAllTabs } =
    useStore();
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);

  const canUse = activeId && connectedIds.has(activeId);
  const activeTab = tabs.find((t) => t.key === activeTabKey) ?? null;

  // Ctrl/Cmd+W 關閉作用中的表分頁（查詢分頁不關）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "w" || e.key === "W") &&
        activeTabKey &&
        activeTabKey !== "__query__"
      ) {
        e.preventDefault();
        closeTab(activeTabKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTabKey, closeTab]);

  if (!canUse && tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-white/25 text-sm">
        雙擊左側連線以建立連線，再雙擊表即可開啟。
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* 分頁列（中鍵關閉、右鍵選單） */}
      <div className="flex items-stretch bg-[#11161d] border-b border-white/10 overflow-x-auto">
        {tabs.map((t) => (
          <div
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.key); } }}
            onContextMenu={(e) => {
              e.preventDefault();
              setActiveTab(t.key);
              setTabMenu({ key: t.key, x: e.clientX, y: e.clientY });
            }}
            title={`${t.database} · ${t.table}（中鍵關閉）`}
            className={`flex items-center gap-2 pl-3 pr-2 py-1.5 text-xs border-r border-white/10 cursor-pointer whitespace-nowrap ${
              t.key === activeTabKey ? "bg-[#0f1419] text-white" : "text-white/50 hover:bg-white/5"
            }`}
          >
            <span className="mono">{t.table}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.key);
              }}
              className="w-4 h-4 flex items-center justify-center rounded hover:bg-white/15 text-white/40"
            >
              ×
            </button>
          </div>
        ))}
        <QueryTabButton />
      </div>

      {/* 內容 */}
      {activeTab ? (
        <TableView tab={activeTab} />
      ) : (
        <QueryPane />
      )}

      {tabMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setTabMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }} />
          <div className="fixed z-[90] min-w-[140px] bg-[#1a212b] border border-white/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: tabMenu.x, top: tabMenu.y }}>
            {(
              [
                ["關閉", () => closeTab(tabMenu.key)],
                ["關閉其他", () => closeOtherTabs(tabMenu.key)],
                ["全部關閉", () => closeAllTabs()],
              ] as [string, () => void][]
            ).map(([label, fn]) => (
              <button key={label} type="button"
                onClick={() => { setTabMenu(null); fn(); }}
                className="block w-full text-left px-3 py-1.5 hover:bg-white/10 text-white/80">
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function QueryTabButton() {
  const { activeTabKey, setActiveTab } = useStore();
  return (
    <button
      onClick={() => setActiveTab("__query__" as any)}
      className={`px-3 py-1.5 text-xs border-r border-white/10 ${
        activeTabKey === "__query__" ? "bg-[#0f1419] text-white" : "text-white/50 hover:bg-white/5"
      }`}
    >
      ⌗ 查詢
    </button>
  );
}

// 各資料庫的查詢預設值 / 提示語法（SQL 與鍵值/文件型語法不同）。
// 註：對 Redis 而言 "SELECT 1" 是「切換到 DB 1」的真實指令，不可拿來當通用預設。
const QUERY_DEFAULTS: Record<DbKind, string> = {
  mysql: "SELECT 1",
  postgres: "SELECT 1",
  sqlite: "SELECT 1",
  mongo: '{ "db": "", "collection": "", "filter": {} }',
  redis: "PING",
};
// 僅關聯式資料庫支援 EXPLAIN 查詢計畫分析。
const EXPLAIN_KINDS: DbKind[] = ["mysql", "postgres", "sqlite"];

// 查詢編輯器內容 per-連線 持久化（重開 / 切換連線後沿用上次的查詢）。
const sqlStoreKey = (id: string) => `at-kit:querySql:${id}`;
function loadPersistedSql(id: string | null | undefined, kind: DbKind | undefined): string {
  if (id) {
    try {
      const s = localStorage.getItem(sqlStoreKey(id));
      if (s != null) return s;
    } catch {
      /* 忽略讀取失敗 */
    }
  }
  return kind ? QUERY_DEFAULTS[kind] : "SELECT 1";
}

// ---- 查詢面板：上 SQL、下結果（F6 執行） ----
function QueryPane() {
  const { activeId } = useStore();
  const kind = useStore((s) => s.connections.find((c) => c.id === activeId)?.kind);
  const supportsExplain = !!kind && EXPLAIN_KINDS.includes(kind);
  const [sql, setSql] = useState(() => loadPersistedSql(activeId, kind));
  const [result, setResult] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [history, setHistory] = useState<string[]>(loadQueryHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [saved, setSaved] = useState<SavedQuery[]>(loadSavedQueries);
  const [showSaved, setShowSaved] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 更新並持久化目前連線的查詢內容（使用者輸入 / 載入歷史 / Tab 縮排都走這裡）。
  const persistSql = (v: string) => {
    setSql(v);
    if (activeId) {
      try { localStorage.setItem(sqlStoreKey(activeId), v); } catch { /* 忽略 */ }
    }
  };

  // 切換連線：載入該連線上次的查詢內容（或該類型預設），並清掉殘留結果。
  // 用 raw setSql（非 persistSql），避免把載入動作又寫回 localStorage。
  useEffect(() => {
    setSql(loadPersistedSql(activeId, kind));
    setResult(null);
    setErr(null);
    setElapsed(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // 消費側欄「產生 SQL」送來的待載入語句（在 activeId 載入之後執行，故會覆蓋之）。
  const pendingSql = useStore((s) => s.pendingSql);
  useEffect(() => {
    if (pendingSql != null) {
      persistSql(pendingSql);
      useStore.getState().clearPendingSql();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSql]);

  // 取得要執行的語句：若編輯器有反白選取，只跑選取段（致敬 DataGrip / DBeaver）。
  const hasSelection = () => {
    const ta = taRef.current;
    return !!ta && ta.selectionStart !== ta.selectionEnd;
  };
  const queryToRun = () => {
    const ta = taRef.current;
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      const sel = sql.slice(ta.selectionStart, ta.selectionEnd).trim();
      if (sel) return sel;
    }
    return sql;
  };

  const execute = async (mode: "run" | "analyze") => {
    if (!activeId || running) return;
    const q = queryToRun();
    if (!q.trim()) return;
    setErr(null);
    setRunning(true);
    const t0 = performance.now();
    try {
      if (mode === "analyze") {
        setResult(await api.explainQuery(activeId, q));
      } else {
        // SQL：拆成多條語句依序執行（sqlx 不允許單次多語句）。
        // 非 SQL（Mongo / Redis）維持單一指令。
        const isSql = !!kind && EXPLAIN_KINDS.includes(kind);
        const statements = isSql ? splitSqlStatements(q) : [q];
        let lastResultSet: QueryResult | null = null; // 最後一個有結果集（columns>0）的語句
        let affected = 0;
        for (let si = 0; si < statements.length; si++) {
          let res: QueryResult;
          try {
            res = await api.runQuery(activeId, statements[si]);
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            throw new Error(statements.length > 1 ? `第 ${si + 1} 條語句失敗：${msg}` : msg);
          }
          if (res.columns.length > 0) lastResultSet = res;
          else affected += res.rows_affected;
        }
        // 有任何結果集 → 顯示最後一個結果集；否則顯示累計影響列數。
        setResult(lastResultSet ?? { columns: [], rows: [], rows_affected: affected });
        if (statements.length > 1) toast.success(`已執行 ${statements.length} 條語句`);
      }
      setElapsed(performance.now() - t0);
      setHistory((h) => pushQueryHistory(h, q));
    } catch (e: any) {
      setElapsed(performance.now() - t0);
      setErr(e?.message ?? (mode === "analyze" ? "分析失敗" : "查詢失敗"));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  // 收藏目前查詢（具名）。
  const saveCurrentQuery = async () => {
    const q = sql.trim();
    if (!q) return;
    const name = await uiPrompt("收藏名稱：", { title: "收藏查詢", placeholder: "例如：每日活躍用戶", confirmText: "收藏" });
    if (name === null || !name.trim()) return;
    const nm = name.trim();
    setSaved((s) => {
      const next = [{ name: nm, sql: q }, ...s.filter((x) => x.name !== nm)];
      persistSavedQueries(next);
      return next;
    });
    toast.success("已收藏");
  };
  const deleteSaved = (name: string) =>
    setSaved((s) => {
      const next = s.filter((x) => x.name !== name);
      persistSavedQueries(next);
      return next;
    });

  // 匯出查詢結果到檔案：依副檔名選 CSV / JSON / TSV。
  const exportResult = async () => {
    if (!result || result.columns.length === 0) return;
    const path = await pickSaveFile("query-result.csv", [
      { name: "CSV", extensions: ["csv"] },
      { name: "JSON", extensions: ["json"] },
      { name: "TSV", extensions: ["tsv", "txt"] },
    ]);
    if (!path) return;
    const lower = path.toLowerCase();
    const content = lower.endsWith(".json")
      ? resultToJson(result)
      : lower.endsWith(".tsv") || lower.endsWith(".txt")
      ? resultToTsv(result)
      : resultToCsv(result);
    try {
      await api.saveTextFile(path, content);
      toast.success(`已匯出 ${result.rows.length} 列`);
    } catch (e: any) {
      toast.error(e?.message ?? "匯出失敗");
    }
  };

  if (!activeId) {
    return (
      <div className="flex-1 flex items-center justify-center text-white/25 text-sm">
        請先選取一個已連線的連線。
      </div>
    );
  }

  const rowsInfo =
    result &&
    (result.columns.length > 0
      ? `${result.rows.length} 列`
      : `影響 ${result.rows_affected} 列`);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="border-b border-white/10">
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#161c25]">
          <span className="text-xs text-white/40">查詢</span>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <button type="button" onClick={() => setShowHistory((s) => !s)}
                disabled={history.length === 0}
                title="查詢歷史"
                className="text-xs px-2 py-1 rounded border border-white/15 hover:bg-white/10 text-white/70 disabled:opacity-30">
                🕘 歷史{history.length ? `（${history.length}）` : ""}
              </button>
              {showHistory && history.length > 0 && (
                <>
                  <div className="fixed inset-0 z-[89]" onClick={() => setShowHistory(false)} />
                  <div className="absolute right-0 mt-1 z-[90] w-[420px] max-h-[320px] overflow-auto bg-[#1a212b] border border-white/10 rounded-lg shadow-2xl py-1">
                    <div className="flex items-center justify-between px-3 py-1 text-[11px] text-white/40 border-b border-white/10">
                      <span>最近查詢</span>
                      <button type="button"
                        onClick={() => { setHistory([]); try { localStorage.removeItem(QUERY_HISTORY_KEY); } catch {} setShowHistory(false); }}
                        className="hover:text-white/80">清除</button>
                    </div>
                    {history.map((h, i) => (
                      <button key={i} type="button"
                        onClick={() => { persistSql(h); setShowHistory(false); }}
                        title="載入到編輯器"
                        className="block w-full text-left px-3 py-1.5 text-xs mono text-white/70 hover:bg-white/10 truncate">
                        {h}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button type="button" onClick={saveCurrentQuery} title="收藏目前查詢"
              className="text-xs px-2 py-1 rounded border border-white/15 hover:bg-white/10 text-white/70">★</button>
            <div className="relative">
              <button type="button" onClick={() => setShowSaved((s) => !s)} disabled={saved.length === 0}
                title="收藏的查詢"
                className="text-xs px-2 py-1 rounded border border-white/15 hover:bg-white/10 text-white/70 disabled:opacity-30">
                收藏{saved.length ? `（${saved.length}）` : ""}
              </button>
              {showSaved && saved.length > 0 && (
                <>
                  <div className="fixed inset-0 z-[89]" onClick={() => setShowSaved(false)} />
                  <div className="absolute right-0 mt-1 z-[90] w-[420px] max-h-[320px] overflow-auto bg-[#1a212b] border border-white/10 rounded-lg shadow-2xl py-1">
                    <div className="px-3 py-1 text-[11px] text-white/40 border-b border-white/10">收藏的查詢</div>
                    {saved.map((q) => (
                      <div key={q.name} className="group flex items-center hover:bg-white/10">
                        <button type="button"
                          onClick={() => { persistSql(q.sql); setShowSaved(false); }}
                          title={q.sql}
                          className="flex-1 text-left px-3 py-1.5 text-xs truncate">
                          <span className="text-amber-300">★</span> {q.name}
                        </button>
                        <button type="button" onClick={() => deleteSaved(q.name)} title="刪除收藏"
                          className="px-2 text-white/30 hover:text-red-400">×</button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            {supportsExplain && (
              <button type="button" onClick={() => execute("analyze")} disabled={running}
                title="EXPLAIN：查看查詢執行計畫"
                className="text-xs px-2 py-1 rounded border border-white/15 hover:bg-white/10 text-white/70 disabled:opacity-40">
                🔬 分析
              </button>
            )}
            <button type="button" onClick={() => execute("run")} disabled={running}
              title="執行 (F6 / Ctrl+Enter)；若有反白選取，只執行選取段"
              className="text-xs px-2 py-1 rounded bg-green-600/80 hover:bg-green-600 disabled:opacity-50">
              {running ? "執行中…" : hasSelection() ? "▶ 執行選取" : "▶ 執行 (F6)"}
            </button>
          </div>
        </div>
        <textarea
          ref={taRef}
          className="w-full h-40 min-h-[80px] bg-[#0f1419] p-3 outline-none mono text-sm resize-y focus:bg-[#0c1116]"
          value={sql}
          onChange={(e) => persistSql(e.target.value)}
          spellCheck={false}
          placeholder={
            kind === "redis"
              ? "Redis 指令，如 GET key、HGETALL key、SCAN 0（前綴 1: 可指定 DB）"
              : kind === "mongo"
              ? 'find：{ "db":"..", "collection":"..", "filter":{}, "sort":{}, "projection":{}, "limit":200 }　|　聚合：{ …, "pipeline":[ { "$match":{} }, { "$group":{} } ] }　|　插入：{ …, "insert":[ { "k":"v" } ] }'
              : "SQL 查詢（F6 或 Ctrl+Enter 執行；反白可只跑選取段）"
          }
          onKeyDown={(e) => {
            if (e.key === "F6" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
              e.preventDefault();
              execute("run");
            } else if (e.key === "Tab") {
              // Tab 插入兩個空格（而非跳離編輯器），符合 SQL 編輯習慣。
              e.preventDefault();
              const ta = e.currentTarget;
              const s = ta.selectionStart;
              const en = ta.selectionEnd;
              const next = sql.slice(0, s) + "  " + sql.slice(en);
              persistSql(next);
              requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
            } else if ((e.ctrlKey || e.metaKey) && e.key === "/") {
              // Ctrl+/ 切換選取行的 SQL 行註解（-- ）。
              e.preventDefault();
              const ta = e.currentTarget;
              const blockStart = sql.lastIndexOf("\n", ta.selectionStart - 1) + 1;
              let blockEnd = sql.indexOf("\n", ta.selectionEnd);
              if (blockEnd === -1) blockEnd = sql.length;
              const lines = sql.slice(blockStart, blockEnd).split("\n");
              const allCommented = lines.every((ln) => ln.trim() === "" || ln.trimStart().startsWith("-- "));
              const newLines = lines.map((ln) => {
                if (ln.trim() === "") return ln;
                const lead = ln.length - ln.trimStart().length;
                if (allCommented) {
                  const idx = ln.indexOf("-- ");
                  return idx >= 0 ? ln.slice(0, idx) + ln.slice(idx + 3) : ln;
                }
                return ln.slice(0, lead) + "-- " + ln.slice(lead);
              });
              const newBlock = newLines.join("\n");
              persistSql(sql.slice(0, blockStart) + newBlock + sql.slice(blockEnd));
              requestAnimationFrame(() => { ta.selectionStart = blockStart; ta.selectionEnd = blockStart + newBlock.length; });
            }
          }}
        />
        {/* 狀態列：執行時間 + 列數 / 錯誤（致敬商用工具的執行回饋） */}
        <div className="flex items-center gap-3 px-3 py-1 bg-[#11161d] text-[11px] text-white/45 min-h-[22px]">
          {elapsed !== null && <span title="執行時間">⏱ {fmtElapsed(elapsed)}</span>}
          {rowsInfo && <span>{rowsInfo}</span>}
          {result && result.columns.length > 0 && (
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={() => copyToClipboard(resultToTsv(result), "已複製結果 (TSV)")}
                className="hover:text-white/80">複製 TSV</button>
              <button type="button" onClick={() => copyToClipboard(resultToJson(result), "已複製結果 (JSON)")}
                className="hover:text-white/80">複製 JSON</button>
              <button type="button" onClick={exportResult}
                className="hover:text-white/80">⬇ 匯出</button>
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {err && <div className="p-3 text-red-400 text-sm mono whitespace-pre-wrap break-words">{err}</div>}
        {result && <ResultTable result={result} />}
      </div>
    </div>
  );
}

function ResultTable({ result }: { result: QueryResult }) {
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [menu, setMenu] = useState<{ r: number; c: number; x: number; y: number } | null>(null);

  if (result.columns.length === 0) {
    return (
      <div className="p-3 text-white/50 text-sm">
        影響列數：{result.rows_affected}
      </div>
    );
  }

  const cell = (r: number, c: number) => result.rows[r]?.[c] ?? null;
  const copyCell = (r: number, c: number) => copyToClipboard(cell(r, c) ?? "", "已複製儲存格");
  const copyRowTsv = (r: number) =>
    copyToClipboard(result.rows[r].map((v) => v ?? "").join("\t"), "已複製整列 (TSV)");
  const copyRowJson = (r: number) =>
    copyToClipboard(
      JSON.stringify(Object.fromEntries(result.columns.map((c, j) => [c, result.rows[r][j] ?? null])), null, 2),
      "已複製整列 (JSON)"
    );
  const copyCol = (c: number) =>
    copyToClipboard(result.rows.map((row) => row[c] ?? "").join("\n"), "已複製整欄");

  const onKey = (e: React.KeyboardEvent) => {
    if (!selected) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      copyCell(selected.r, selected.c);
      e.preventDefault();
    } else if (e.key === "Escape") setSelected(null);
  };

  return (
    <div className="outline-none" tabIndex={0} onKeyDown={onKey}>
      <table className="text-sm border-collapse w-full">
        <thead className="sticky top-0 bg-[#1a212b]">
          <tr>
            <th className="text-left px-3 py-1.5 border-b border-white/10 text-white/30 w-12">#</th>
            {result.columns.map((c) => (
              <th key={c} className="text-left px-3 py-1.5 border-b border-white/10 font-medium whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="mono">
          {result.rows.map((row, i) => (
            <tr key={i} className="odd:bg-white/[0.025] hover:bg-white/5">
              <td className="px-3 py-1 border-b border-white/5 text-white/30">{i + 1}</td>
              {row.map((c, j) => (
                <td key={j}
                  onClick={(e) => { setSelected({ r: i, c: j }); (e.currentTarget.closest("[tabindex]") as HTMLElement | null)?.focus(); }}
                  onContextMenu={(e) => { e.preventDefault(); setSelected({ r: i, c: j }); setMenu({ r: i, c: j, x: e.clientX, y: e.clientY }); }}
                  className={`px-3 py-1 border-b border-white/5 align-top cursor-cell ${
                    selected?.r === i && selected?.c === j ? "ring-1 ring-inset ring-blue-500 bg-blue-500/10" : ""
                  }`}
                  title={c ?? "NULL"}>
                  {c === null ? <span className="text-white/30 italic">NULL</span> : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {menu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-[90] min-w-[160px] bg-[#1a212b] border border-white/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: menu.x, top: menu.y }}>
            {(
              [
                ["複製值", () => copyCell(menu.r, menu.c)],
                ["複製整列 (TSV)", () => copyRowTsv(menu.r)],
                ["複製整列 (JSON)", () => copyRowJson(menu.r)],
                ["複製整欄", () => copyCol(menu.c)],
              ] as [string, () => void][]
            ).map(([label, fn]) => (
              <button key={label} type="button"
                onClick={() => { setMenu(null); fn(); }}
                className="block w-full text-left px-3 py-1.5 hover:bg-white/10 text-white/80">
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
