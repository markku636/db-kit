import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { api, onKafkaAlert, ConnectionConfig, DbKind, KIND_META, PoolStatus, QueryResult, TableInfo, RoutineInfo, type ExportFormat, type SearchHit } from "./api";
import { useStore, type SelectedNode } from "./store";
import { useTheme } from "./theme";
import { LANGUAGES, useLang, useT, type Lang } from "./i18n";
import { APP_NAME } from "./brand";
import { EDITOR_THEMES, getEditorThemeDef, type EditorThemeId } from "./editorThemes";
import TableView, { CellInspector } from "./TableView";
import InfoPanel from "./InfoPanel";
import AssistantPanel from "./AssistantPanel";
import type { SqlSubmit, SqlEditorHandle } from "./SqlEditor";
import { useSqlSchema } from "./useSqlSchema";
import { useAssistant } from "./assistant";
import type { PaletteItem } from "./CommandPalette";
import lazyOverlay from "./ui/lazyOverlay";
import { loadConnColors, persistConnColors, setConnColor, CONN_COLOR_PALETTE } from "./connColors";
import { kindIcon } from "./kindIcons";
import { friendlyDbError } from "./dbErrors";
import { checkForUpdate, isNewer, autoCheckEnabled, setAutoCheckEnabled, type UpdateInfo } from "./updateCheck";
import { loadPins, persistPins, togglePin, isPinned, removePinsForConn, type PinnedTable } from "./pins";
import { toast, uiConfirm, uiPrompt, UiHost, copyToClipboard, pickSaveFile, pickOpenFile, useEscToClose } from "./ui";
import {
  QUERY_HISTORY_KEY, loadQueryHistory, pushQueryHistory,
  resultToTsv, resultToJson, resultToCsv, resultToMarkdown, fmtElapsed, fmtRelativeTime, type QueryHistoryEntry, splitSqlStatements, splitSqlStatementsWithRanges, statementAtOffset, isDangerousStatement, isWriteStatement, isDangerousRedisCommand,
  rectToTsv, rectToMarkdown, rangeStats,
  quoteIdent, qualifiedName, isMysqlFamily, supportsRoutines,
  buildDropTable, buildDropView, buildDropRoutine, buildTruncateTable, buildRenameTable, buildDuplicateTable, isSystemDatabase,
  buildTableMaintenance, buildInsertAllRows, tableSizesSql,
  buildDeleteAllRows, buildInsertValues, buildGrantTemplate,
  formatSql, minifySql, transformKeywordCase, buildUseDatabase, hasExecutableSql,
  extractNamedParams, substituteNamedParams, isInternalKafkaTopic,
} from "./sql";
import type { SavedQuery } from "./sql";
import Select from "./ui/Select";
import { buildExplainJsonSql, parseExplainPlan, type PlanNode } from "./explain";
import type { MongoQueryEditorHandle } from "./MongoQueryEditor";
import type { ElasticQueryEditorHandle } from "./ElasticQueryEditor";
import { buildSqlNlPrompt, buildEsNlPrompt } from "./nlPrompt";
import { parseMongoExplain, withVerbosity, type MongoExplainModel } from "./mongoExplain";
import logoMark from "./assets/db-kit-hero.png";
import Icon from "./ui/Icon";
import { Button, EmptyState, Modal, Input, Field } from "./ui/index";
import {
  Plug, Network, DatabaseBackup, Upload, Download, Sparkles, Keyboard, Moon,
  Database, ChevronRight, Table2, Eye, FunctionSquare, Cog, FileCode2,
  Search, Loader2, Pencil, Trash2, X, Play, Clock, ArrowUp, ArrowDown,
  Wand2, FlaskConical, Plus, MousePointerClick, Zap, History, FolderOpen, Save, Star,
  GitBranch, FileText, Blocks, FilePlus2, MoreHorizontal, Info, Lock, Square, Palette,
  ScanSearch, Copy, ChevronDown, Globe, Layers,
  type LucideIcon,
} from "lucide-react";

// ---- Lazy 載入（code splitting）：對話框 / 工具面板全部條件掛載，開啟時才抓 chunk，
//      首包只留 App shell + TableView + InfoPanel/AssistantPanel。CodeMirror 全家桶
//      隨 SqlEditor / MongoQueryEditor 的 chunk 延後載入（manualChunks 見 vite.config.ts）。----
const ConnectionDialog = lazyOverlay(() => import("./ConnectionDialog"));
const BackupDialog = lazyOverlay(() => import("./BackupDialog"));
const ErDiagram = lazyOverlay(() => import("./ErDiagram"));
const RedisStatus = lazyOverlay(() => import("./RedisStatus"));
const RedisConsole = lazyOverlay(() => import("./RedisConsole"));
const MongoOpsPanel = lazyOverlay(() => import("./MongoOpsPanel"));
const KafkaConsumerGroups = lazyOverlay(() => import("./KafkaConsumerGroups"));
const KafkaClusterOverview = lazyOverlay(() => import("./KafkaClusterOverview"));
const KafkaMonitorPanel = lazyOverlay(() => import("./KafkaMonitorPanel"));
const KafkaConnectPanel = lazyOverlay(() => import("./KafkaConnectPanel"));
const KafkaAclPanel = lazyOverlay(() => import("./KafkaAclPanel"));
const KafkaSchemaViewer = lazyOverlay(() => import("./KafkaSchemaViewer"));
const KafkaCreateTopicDialog = lazyOverlay(() => import("./KafkaCreateTopicDialog"));
const EsClusterOverview = lazyOverlay(() => import("./EsClusterOverview"));
const EsMappingViewer = lazyOverlay(() => import("./EsMappingViewer"));
const RabbitMqOverview = lazyOverlay(() => import("./RabbitMqOverview"));
const RabbitMqPublishDialog = lazyOverlay(() => import("./RabbitMqPublishDialog"));
const NewKeyDialog = lazyOverlay(() => import("./NewKeyDialog"));
const CreateTableDialog = lazyOverlay(() => import("./CreateTableDialog"));
const ConnectionProperties = lazyOverlay(() => import("./ConnectionProperties"));
const TableProperties = lazyOverlay(() => import("./TableProperties"));
const RoutinesDialog = lazyOverlay(() => import("./RoutinesDialog"));
const SavedQueriesDialog = lazyOverlay(() => import("./SavedQueriesDialog"));
const CreateViewDialog = lazyOverlay(() => import("./CreateViewDialog"));
const ViewDesigner = lazyOverlay(() => import("./ViewDesigner"));
const ProcessListDialog = lazyOverlay(() => import("./ProcessListDialog"));
const ServerQueryDialog = lazyOverlay(() => import("./ServerQueryDialog"));
const UserManager = lazyOverlay(() => import("./UserManager"));
const DatabaseProperties = lazyOverlay(() => import("./DatabaseProperties"));
const SchemaCompare = lazyOverlay(() => import("./SchemaCompare"));
const SearchObjectsDialog = lazyOverlay(() => import("./SearchObjectsDialog"));
const AdvancedSearchDialog = lazyOverlay(() => import("./AdvancedSearchDialog"));
const ExportDialog = lazyOverlay(() => import("./ExportDialog"));
const ImportDialog = lazyOverlay(() => import("./ImportDialog"));
const DataDictionary = lazyOverlay(() => import("./DataDictionary"));
const DataGenerator = lazyOverlay(() => import("./DataGenerator"));
const QueryBuilder = lazyOverlay(() => import("./QueryBuilder"));
const TransferDialog = lazyOverlay(() => import("./TransferDialog"));
const DbTransferDialog = lazyOverlay(() => import("./DbTransferDialog"));
const CommandPalette = lazyOverlay(() => import("./CommandPalette"));
const AboutDialog = lazyOverlay(() => import("./AboutDialog"));
const DbDataDictionary = lazyOverlay(() => import("./DbDataDictionary"));
const DataSyncDialog = lazyOverlay(() => import("./DataSyncDialog"));
const ExplainPlan = lazyOverlay(() => import("./ExplainPlan"));
const MongoExplainPlan = lazyOverlay(() => import("./MongoExplainPlan"));
// 需要 ref 轉發的編輯器：直接 React.lazy（lazy 對 forwardRef 透明），使用處手動包 Suspense。
const SqlEditor = lazy(() => import("./SqlEditor"));
const MongoQueryEditor = lazy(() => import("./MongoQueryEditor"));
const ElasticQueryEditor = lazy(() => import("./ElasticQueryEditor"));
const NlQueryBar = lazy(() => import("./NlQueryBar"));

// ---- 依選取的樹節點，組「新查詢分頁」的起始 SQL（對標 DataGrip / Navicat：在物件上開查詢即帶範圍）----
//  - 資料表 / 檢視：USE db;（mysql / external）或 SET search_path（postgres）＋ 一條可執行的 SELECT … LIMIT 100；
//    sqlite 無多庫概念 → 僅 SELECT；mongo → find JSON；redis → 無此語意（回 undefined，開空白分頁）。
//  - 資料庫：僅 USE / search_path 前綴，游標留在空白處等使用者輸入。
//  - 連線 / 未選取：回 undefined（開乾淨空白分頁，僅切到該連線）。
function buildScopedSql(node: SelectedNode | null): string | undefined {
  if (!node || node.type === "connection") return undefined;
  const use = buildUseDatabase(node.kind, node.db); // sqlite / mongo / redis → null
  if (node.type === "database") return use ? `${use};\n\n` : undefined;
  // 資料表 / 檢視節點：
  if (node.kind === "mongo") {
    return JSON.stringify({ db: node.db, collection: node.table, filter: {} }, null, 2);
  }
  if (node.kind === "elastic") {
    return JSON.stringify({ index: node.table, query: { match_all: {} }, size: 200 }, null, 2);
  }
  if (node.kind === "redis" || node.kind === "kafka") return undefined;
  const select = `SELECT *\nFROM ${qualifiedName(node.kind, node.db, node.table)}\nLIMIT 100;`;
  return use ? `${use};\n\n${select}` : select;
}

// 依目前選取的樹節點開「新查詢分頁」：永遠開新分頁（不覆蓋現有編輯器內容），並切到該節點的連線。
// 工具列「新查詢」鈕與 Ctrl+N 共用此入口。
function openNodeScopedQueryTab() {
  const node = useStore.getState().selectedNode;
  useStore.getState().newQueryTab(buildScopedSql(node), node?.connId);
}

// ---- 可拖曳分隔線：記憶尺寸（localStorage）+ 指標拖曳調整 ----
function clampSize(v: number, min: number, max: number) {
  return Math.max(min, Math.min(v, max));
}

// axis "x" 調寬度、"y" 調高度；max 可為函式（依視窗大小動態算上限）。
// 回傳目前尺寸與要綁在分隔線上的 onPointerDown；拖曳結束才寫回 localStorage。
function useResizable(opts: {
  storageKey: string;
  initial: number;
  min: number;
  max: number | (() => number);
  axis: "x" | "y";
}) {
  const maxOf = () => (typeof opts.max === "function" ? opts.max() : opts.max);
  const [size, setSize] = useState<number>(() => {
    try {
      const v = localStorage.getItem(opts.storageKey);
      if (v != null) {
        const n = parseFloat(v);
        if (Number.isFinite(n)) return clampSize(n, opts.min, maxOf());
      }
    } catch {
      /* 忽略讀取失敗 */
    }
    return opts.initial;
  });

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = opts.axis === "x" ? e.clientX : e.clientY;
    const startSize = size;
    let latest = startSize;
    const move = (ev: PointerEvent) => {
      const cur = opts.axis === "x" ? ev.clientX : ev.clientY;
      latest = clampSize(startSize + (cur - start), opts.min, maxOf());
      setSize(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(opts.storageKey, String(latest)); } catch { /* 忽略寫入失敗 */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = opts.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return { size, onPointerDown };
}

// 拖曳把手：axis "x" → 直立細條（調左右）、"y" → 水平細條（調上下）。
function Splitter({ axis, onPointerDown }: { axis: "x" | "y"; onPointerDown: (e: ReactPointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      className={
        "shrink-0 bg-fg/10 hover:bg-accent/60 active:bg-accent transition-colors " +
        (axis === "x" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize")
      }
    />
  );
}

export default function App() {
  const t = useT();
  // null = 關閉；{ initial } = 開啟（initial 為 null 表新增、為連線表示編輯）
  const [dialog, setDialog] = useState<{ initial: ConnectionConfig | null } | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [erOpen, setErOpen] = useState(false);
  // 進階物件搜尋（全螢幕 Modal）：null = 關閉。放 App 級以便工具列 / 側欄 / 快捷鍵共用。
  const [advSearch, setAdvSearch] = useState<{ connId: string; kind: DbKind } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 啟動密碼閘門：checking（查詢中）→ locked（需輸入密碼）/ open（已解鎖或未設密碼）。
  const [lockState, setLockState] = useState<"checking" | "locked" | "open">("checking");
  // 開場動畫狀態：show → leaving（淡出）→ done（卸載）。每次啟動只播一次；
  // prefers-reduced-motion 使用者直接跳過（原本只停動畫仍要乾等計時，形同懲罰）。
  const [splash, setSplash] = useState<"show" | "leaving" | "done">(() => {
    try {
      if (sessionStorage.getItem("dbkit:splashed")) return "done";
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "done";
      return "show";
    } catch { return "show"; }
  });
  const onSplashDone = () => {
    try { sessionStorage.setItem("dbkit:splashed", "1"); } catch {}
    setSplash("done");
  };
  const { connections, connectedIds, activeId } = useStore();
  const savedMgr = useStore((s) => s.savedMgr);
  const activeConn = connections.find((c) => c.id === activeId) ?? null;
  // 左側連線樹寬度：可拖曳分隔線調整，記憶於 localStorage。
  const sidebar = useResizable({
    storageKey: "dbkit:sidebarWidth",
    initial: 256, // 對應原本 w-64
    min: 180,
    max: () => Math.min(640, window.innerWidth * 0.6),
    axis: "x",
  });
  // ER 圖僅關聯式（MySQL 系 / PostgreSQL / SQLite / MSSQL / Oracle）支援外鍵關係；Mongo / Redis 不適用。
  const canEr =
    !!activeConn &&
    connectedIds.has(activeConn.id) &&
    (isMysqlFamily(activeConn.kind) || activeConn.kind === "postgres" || activeConn.kind === "sqlite" || activeConn.kind === "mssql" || activeConn.kind === "oracle");
  // 進階搜尋：連線已連上即可用（外部 / MSSQL 等由對話框內部依 kind gate 選項）。
  const canAdvSearch = !!activeConn && connectedIds.has(activeConn.id);

  // React 首屏（開場動畫或主介面）接手後，移除 index.html 的靜態骨架屏。
  useEffect(() => {
    const el = document.getElementById("boot-splash");
    if (el) requestAnimationFrame(() => el.remove());
  }, []);

  // 查詢防護（row cap / 逾時）：啟動時把 localStorage 設定同步到後端（後端內建預設 1000 / 關閉）。
  useEffect(() => {
    const g = loadQueryGuard();
    api.setQueryGuard(g.maxRows, g.timeoutMs).catch(() => {});
  }, []);

  // Kafka 告警：全域訂閱，面板未開也彈 toast（OS 通知另由後端送）。
  useEffect(() => {
    let un: (() => void) | undefined;
    onKafkaAlert((e) => toast.info(`Kafka 告警：${e.message}`)).then((u) => { un = u; });
    return () => un?.();
  }, []);

  // 全域快捷鍵 Ctrl/Cmd+Shift+G：開啟進階物件搜尋（有 modal 開啟時讓路；需已選取並連線）。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "g" || e.key === "G")) {
        if (document.body.dataset.modalCount) return;
        if (!activeConn || !connectedIds.has(activeConn.id)) return;
        e.preventDefault();
        setAdvSearch({ connId: activeConn.id, kind: activeConn.kind });
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [activeConn, connectedIds]);

  // 啟動時並行發出鎖定狀態查詢與連線清單載入（清單本就不含密碼，僅暫存 promise；
  // 解鎖後才寫入 store，鎖定語意不變，省掉一段串行 IPC）。
  const savedConnsRef = useRef<Promise<ConnectionConfig[]> | null>(null);
  useEffect(() => {
    savedConnsRef.current = api.listSavedConnections().catch(() => [] as ConnectionConfig[]);
    api
      .hasStartupPassword()
      .then((has) => setLockState(has ? "locked" : "open"))
      .catch(() => setLockState("open"));
  }, []);

  // 解鎖後才把連線清單寫入 store（僅清單，不自動連線；密碼留在 keychain）。
  useEffect(() => {
    if (lockState !== "open") return;
    (savedConnsRef.current ?? api.listSavedConnections())
      .then((saved) =>
        useStore
          .getState()
          .setConnections(saved.map((c) => ({ ...c, password: c.password ?? "" })))
      )
      .catch(() => {});
  }, [lockState]);

  // 啟動時套用目前變體的整套 --c-* CSS 變數（與 index.html 防閃爍腳本的 .light 類別互補）。
  useEffect(() => {
    useTheme.getState().setThemeId(useTheme.getState().themeId);
  }, []);

  // F1 切換快捷鍵說明。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "F1") { e.preventDefault(); setHelpOpen((v) => !v); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 開場動畫：每次啟動固定 1.5s（不分首次），並扣掉 bundle 載入已流逝的時間
  //（骨架屏 + splash 的總感知時間不疊加）；按任意鍵可直接跳過（點擊由 SplashScreen onSkip 處理）。
  useEffect(() => {
    if (splash !== "show") return;
    const full = 1500;
    const timer = setTimeout(() => setSplash("leaving"), Math.max(300, full - performance.now()));
    const skip = () => setSplash("leaving");
    window.addEventListener("keydown", skip);
    return () => { clearTimeout(timer); window.removeEventListener("keydown", skip); };
  }, [splash]);

  // 鎖定畫面（z-300）會直接蓋住開場動畫（z-200），播了也看不到 → 直接標記完成，
  // 解鎖後也不再補播。
  useEffect(() => {
    if (lockState === "locked" && splash !== "done") onSplashDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockState]);

  // 加密匯出所有連線（**含**密碼 / SSH 機密 / OTP，從 keychain 取出，用 passphrase 派生金鑰 AES-256-GCM 加密）。
  const exportConnections = async () => {
    const conns = useStore.getState().connections;
    if (conns.length === 0) { toast.info(t("沒有可匯出的連線")); return; }
    const passphrase = await uiPrompt(t("設定匯出檔的加密密碼（passphrase）"), {
      title: t("加密匯出連線"), placeholder: t("至少 8 碼，匯入時需輸入相同密碼"), confirmText: t("匯出"),
    });
    if (!passphrase) return;
    if (passphrase.length < 8) { toast.error(t("passphrase 至少 8 碼")); return; }
    const path = await pickSaveFile("db-kit-connections.dbkitenc", [{ name: t("db-kit 加密連線"), extensions: ["dbkitenc"] }]);
    if (!path) return;
    try {
      const n = await api.exportConnectionsEncrypted(path, passphrase);
      toast.success(t("已加密匯出 {n} 個連線（含密碼）", { n }));
    } catch (e: any) {
      toast.error(e?.message ?? t("匯出失敗"));
    }
  };
  // 從加密檔匯入連線：輸入 passphrase 解密，機密寫回 keychain、設定 upsert，再重載連線清單。
  const importConnections = async () => {
    const path = await pickOpenFile([{ name: t("db-kit 加密連線"), extensions: ["dbkitenc"] }]);
    if (!path) return;
    const passphrase = await uiPrompt(t("輸入匯入檔的加密密碼（passphrase）"), { title: t("解密匯入連線"), confirmText: t("匯入") });
    if (!passphrase) return;
    try {
      const n = await api.importConnectionsEncrypted(path, passphrase);
      const saved = await api.listSavedConnections();
      useStore.getState().setConnections(saved.map((c) => ({ ...c, password: c.password ?? "" } as ConnectionConfig)));
      toast.success(n > 0 ? t("已匯入 {n} 個連線（含密碼）", { n }) : t("檔案內沒有連線"));
    } catch (e: any) {
      toast.error(t("匯入失敗：{msg}", { msg: e?.message ?? t("passphrase 錯誤或檔案損毀") }));
    }
  };

  // 啟動密碼閘門：未解鎖前只顯示開場動畫 + 鎖定畫面，不掛載主介面（避免鎖定時仍抓連線資料）。
  if (lockState !== "open") {
    return (
      <div className="h-full bg-app">
        {splash !== "done" && (
          <SplashScreen leaving={splash === "leaving"} onDone={onSplashDone} onSkip={() => setSplash("leaving")} />
        )}
        {lockState === "locked" && <LockScreen onUnlock={() => setLockState("open")} />}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {splash !== "done" && (
        <SplashScreen leaving={splash === "leaving"} onDone={onSplashDone} onSkip={() => setSplash("leaving")} />
      )}
      <Toolbar
        onNewConnection={() => setDialog({ initial: null })}
        onBackup={() => activeConn && setBackupOpen(true)}
        canBackup={!!activeConn}
        onEr={() => canEr && setErOpen(true)}
        canEr={canEr}
        onAdvSearch={() => activeConn && canAdvSearch && setAdvSearch({ connId: activeConn.id, kind: activeConn.kind })}
        canAdvSearch={canAdvSearch}
        onHelp={() => setHelpOpen(true)}
        onAbout={() => setAboutOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onExportConns={exportConnections}
        onImportConns={importConnections}
      />
      <div className="flex-1 flex min-h-0">
        <Sidebar
          width={sidebar.size}
          onEdit={(c) => setDialog({ initial: c })}
          onAdvSearch={(id, k) => setAdvSearch({ connId: id, kind: k })}
        />
        <Splitter axis="x" onPointerDown={sidebar.onPointerDown} />
        <MainArea onNewConnection={() => setDialog({ initial: null })} />
        <InfoPanel />
        <AssistantPanel />
      </div>
      <StatusBar />
      {dialog && (
        <ConnectionDialog
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSaved={async (c) => {
            try {
              await api.saveConnection(c);
              toast.success(dialog.initial ? t("連線已更新") : t("連線已儲存"));
            } catch (e: any) {
              toast.error(e?.message ?? t("儲存連線失敗"));
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
      {advSearch && (
        <AdvancedSearchDialog connId={advSearch.connId} kind={advSearch.kind} onClose={() => setAdvSearch(null)} />
      )}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {savedMgr && (
        <SavedQueriesDialog
          seedSql={savedMgr.seedSql}
          editName={savedMgr.editName}
          onClose={() => useStore.getState().closeSavedManager()}
        />
      )}
      <UiHost />
    </div>
  );

  function StatusBar() {
  const t = useT();
    const active = connections.find((c) => c.id === activeId);
    const isConnected = !!active && connectedIds.has(active.id);
    return (
      <div className="h-7 bg-panel border-t border-fg/10 px-3 flex items-center text-xs text-fg/40 gap-4 min-w-0">
        <span className="shrink-0">{APP_NAME}</span>
        {active && (
          <span
            className="flex items-center gap-1.5 min-w-0"
            title={`${KIND_META[active.kind].label} · ${active.host}:${active.port}${isConnected ? t(" · 已連線") : t(" · 未連線")}`}
          >
            <span
              className={`shrink-0 flex ${isConnected ? "" : "text-fg/35"}`}
              style={isConnected ? { color: KIND_META[active.kind].color } : undefined}
            >
              <Icon icon={kindIcon(active.kind)} size={13} />
            </span>
            <span className="truncate">
              {KIND_META[active.kind].label} · {active.host}:{active.port}
              {isConnected ? t(" · 已連線") : t(" · 未連線")}
            </span>
          </span>
        )}
        {isConnected && active && <PoolStatusBadge connId={active.id} />}
      </div>
    );
  }
}

// ---- 開場動畫：去背標誌進場 + 柔光暈 + 輪廓高光掃過，隨後淡出；點擊可跳過 ----
function SplashScreen({ leaving, onDone, onSkip }: { leaving: boolean; onDone: () => void; onSkip?: () => void }) {
  return (
    <div
      className={`splash${leaving ? " splash--leaving" : ""}`}
      onAnimationEnd={(e) => { if (e.animationName === "splash-fade-out") onDone(); }}
      onClick={onSkip}
      role="presentation"
    >
      <div className="splash__stage">
        <div className="splash__glow" />
        <div className="splash__logo-wrap" style={{ ["--logo-src" as string]: `url(${logoMark})` }}>
          <img src={logoMark} alt="MAGIDB Connect" className="splash__logo" draggable={false} />
          <div className="splash__shine" />
        </div>
      </div>
    </div>
  );
}

// 啟動密碼鎖定畫面：全螢幕不透明覆蓋（疊在開場動畫之上），驗證通過才 onUnlock 進入主介面。
function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const t = useT();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const submit = async () => {
    if (busy || !pw) return;
    setBusy(true);
    try {
      const ok = await api.verifyStartupPassword(pw);
      if (ok) { onUnlock(); return; }
      setErr(true);
      setPw("");
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[300] grid place-items-center bg-app">
      <div className="w-[320px] max-w-[88vw] flex flex-col items-center gap-6">
        <img src={logoMark} alt="DB Kit" className="w-16 h-16 rounded-2xl shadow-e4" draggable={false} />
        <div className="text-center space-y-1">
          <div className="text-base font-semibold text-fg/90">{t("DB Kit 已鎖定")}</div>
          <div className="text-xs text-fg/50">{t("輸入啟動密碼以繼續")}</div>
        </div>
        <div className="w-full space-y-2.5">
          <Input
            type="password"
            inputSize="md"
            autoFocus
            value={pw}
            invalid={err}
            placeholder={t("啟動密碼")}
            aria-label={t("啟動密碼")}
            onChange={(e) => { setPw(e.target.value); setErr(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          {err && <div className="text-[11px] text-danger text-center">{t("密碼不正確，請再試一次")}</div>}
          <Button variant="primary" full icon={Lock} loading={busy} disabled={!pw} onClick={submit}>
            {t("解鎖")}
          </Button>
        </div>
        {/* 忘記密碼的自救指引：解法只寫在 CHANGELOG 對被鎖在外面的人毫無幫助（死路型 UX）。 */}
        <div className="text-center">
          {!showForgot ? (
            <button type="button" onClick={() => setShowForgot(true)}
              className="text-[11px] text-fg/35 hover:text-fg/60 underline decoration-dotted">
              {t("忘記密碼？")}
            </button>
          ) : (
            <div className="text-[11px] text-fg/50 leading-relaxed max-w-[300px] text-left space-y-1.5">
              <p>
                {t("啟動密碼只是開啟 App 的閘門。刪除設定目錄中的")}
                <span className="mono"> app_settings.json </span>{t("即可解除，")}
                <span className="text-fg/70">{t("不影響已儲存的連線")}</span>{t("（連線機密存於系統 keychain）。")}
              </p>
              <p className="mono break-all text-fg/40">%APPDATA%\dev.dbkit.app\app_settings.json</p>
              <button type="button"
                onClick={() => copyToClipboard("%APPDATA%\\dev.dbkit.app\\app_settings.json", t("已複製路徑"))}
                className="underline decoration-dotted hover:text-fg/70">{t("複製路徑")}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- 查詢防護設定（row cap / 逾時）：UI 偏好層級，持久化於 localStorage，啟動與變更時同步後端 ----
const QUERY_GUARD_KEY = "dbkit:queryGuard";
interface QueryGuard { maxRows: number; timeoutMs: number; }
const DEFAULT_QUERY_GUARD: QueryGuard = { maxRows: 1000, timeoutMs: 0 };
function loadQueryGuard(): QueryGuard {
  try {
    const raw = localStorage.getItem(QUERY_GUARD_KEY);
    if (!raw) return DEFAULT_QUERY_GUARD;
    const p = JSON.parse(raw) as Partial<QueryGuard>;
    return {
      maxRows: Number.isFinite(p.maxRows) && (p.maxRows as number) >= 0 ? (p.maxRows as number) : DEFAULT_QUERY_GUARD.maxRows,
      timeoutMs: Number.isFinite(p.timeoutMs) && (p.timeoutMs as number) >= 0 ? (p.timeoutMs as number) : DEFAULT_QUERY_GUARD.timeoutMs,
    };
  } catch { return DEFAULT_QUERY_GUARD; }
}
function persistQueryGuard(g: QueryGuard) {
  try { localStorage.setItem(QUERY_GUARD_KEY, JSON.stringify(g)); } catch {}
  api.setQueryGuard(g.maxRows, g.timeoutMs).catch(() => {});
}

// 設定對話框：「啟動密碼」（app-lock 閘門，不加密連線資料）與「查詢防護」（row cap / 逾時）。
function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const [hasPw, setHasPw] = useState<boolean | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [guard, setGuard] = useState<QueryGuard>(loadQueryGuard);
  const [autoUpdate, setAutoUpdate] = useState<boolean>(autoCheckEnabled);
  const themeId = useTheme((s) => s.themeId);
  const setThemeId = useTheme((s) => s.setThemeId);
  // 迷你預覽用的主題定義（統一後恆有值）。
  const previewDef = getEditorThemeDef(themeId);
  const updateGuard = (patch: Partial<QueryGuard>) => {
    setGuard((g) => {
      const merged = { ...g, ...patch };
      persistQueryGuard(merged);
      return merged;
    });
  };

  // 開啟時重置欄位並查詢目前是否已設定啟動密碼。
  useEffect(() => {
    if (!open) return;
    setCurrent(""); setNext(""); setConfirm(""); setHasPw(null);
    api.hasStartupPassword().then(setHasPw).catch(() => setHasPw(false));
  }, [open]);

  const save = async () => {
    if (busy) return;
    if (next.length < 4) { toast.error(t("密碼至少 4 碼")); return; }
    if (next !== confirm) { toast.error(t("兩次輸入的密碼不一致")); return; }
    setBusy(true);
    try {
      await api.setStartupPassword(hasPw ? current : null, next);
      toast.success(hasPw ? t("已更新啟動密碼") : t("已啟用啟動密碼"));
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("設定失敗"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !current) return;
    const ok = await uiConfirm(t("移除後，下次開啟 DB Kit 將不再需要輸入密碼。確定移除啟動密碼？"), {
      title: t("移除啟動密碼"), danger: true, confirmText: t("移除"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.clearStartupPassword(current);
      toast.success(t("已移除啟動密碼"));
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("移除失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("設定")}
      icon={Cog}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("關閉")}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!next || !confirm || (!!hasPw && !current)}
            onClick={save}
          >
            {hasPw ? t("更新密碼") : t("啟用")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <div className="text-sm font-medium text-fg/90 flex items-center gap-2">
            <Icon icon={Globe} size={15} /> {t("語言")}
          </div>
          <p className="text-xs text-fg/50 leading-relaxed">
            {t("介面語言，變更立即生效、不需重啟；後端錯誤訊息與 dbk 命令列輸出也會跟著切換。上方工具列亦可快速切換。")}
          </p>
          <Field label={t("介面語言")}>
            <Select selectSize="md" value={lang}
              onChange={(e) => { void setLang(e.target.value as Lang); }}>
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="space-y-3">
          <div className="text-sm font-medium text-fg/90 flex items-center gap-2">
            <Icon icon={Palette} size={15} /> {t("主題")}
          </div>
          <p className="text-xs text-fg/50 leading-relaxed">
            {t("整個 app 的配色與深淺（側欄 / 工具列 / 表格 / 對話框 / 編輯器 / AI 助手），變更立即生效。「光亮」為唯一的淺色配色，其餘皆為深色；上方工具列亦可快速切換。")}
          </p>
          <Field label={t("配色主題")}>
            <Select selectSize="md" value={themeId}
              onChange={(e) => setThemeId(e.target.value as EditorThemeId)}>
              <option value="moonstone">{t("光亮")}</option>
              <option value="amethyst">{t("暗黑")}</option>
              {EDITOR_THEMES.filter((d) => d.id !== "moonstone" && d.id !== "amethyst").map((d) => (
                <option key={d.id} value={d.id}>{t(d.label)}</option>
              ))}
            </Select>
          </Field>
          {previewDef && (
            <div
              className="rounded-md px-3 py-2 mono text-xs leading-relaxed border border-fg/10"
              style={{ backgroundColor: previewDef.colors.bg, color: previewDef.colors.fg }}
            >
              <span style={{ color: previewDef.colors.keyword }}>SELECT</span> *{" "}
              <span style={{ color: previewDef.colors.keyword }}>FROM</span> users{" "}
              <span style={{ color: previewDef.colors.keyword }}>WHERE</span> name{" "}
              <span style={{ color: previewDef.colors.operator }}>=</span>{" "}
              <span style={{ color: previewDef.colors.string }}>'mark'</span>{" "}
              <span style={{ color: previewDef.colors.keyword }}>AND</span> id{" "}
              <span style={{ color: previewDef.colors.operator }}>=</span>{" "}
              <span style={{ color: previewDef.colors.number }}>1</span>;{" "}
              <span style={{ color: previewDef.colors.comment }}>{t("-- 註解")}</span>
            </div>
          )}
        </div>
        <div className="pt-4 border-t border-fg/10">
          <div className="text-sm font-medium text-fg/90 flex items-center gap-2">
            <Icon icon={Lock} size={15} /> {t("啟動密碼")}
            {hasPw === true && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> {t("已啟用")}
              </span>
            )}
            {hasPw === false && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-fg/40">
                <span className="w-1.5 h-1.5 rounded-full bg-fg/30" /> {t("未啟用")}
              </span>
            )}
          </div>
          <p className="text-xs text-fg/50 mt-1.5 leading-relaxed">
            {t("啟用後，每次開啟 {app} 需先輸入此密碼才能進入。此密碼僅作為開啟 App 的閘門，", { app: APP_NAME })}
            <span className="text-fg/70">{t("不會加密你的連線資料")}</span>{t("（連線機密仍存於作業系統 keychain，")}
            <span className="mono"> dbk </span>{t("CLI 不受影響）。")}
          </p>
        </div>
        {hasPw ? (
          <Field label={t("目前密碼")}>
            <Input type="password" inputSize="md" value={current} placeholder={t("輸入目前的啟動密碼")}
              onChange={(e) => setCurrent(e.target.value)} />
          </Field>
        ) : null}
        <Field label={hasPw ? t("新密碼") : t("設定密碼")} hint={t("至少 4 碼")}>
          <Input type="password" inputSize="md" value={next} placeholder={t("輸入密碼")}
            onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t("確認密碼")}>
          <Input type="password" inputSize="md" value={confirm} placeholder={t("再次輸入密碼")}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        </Field>
        {hasPw ? (
          <div className="pt-3 border-t border-fg/10 flex items-center gap-2">
            <Button variant="danger" disabled={busy || !current} onClick={remove}>{t("移除啟動密碼")}</Button>
            {!current && <span className="text-[11px] text-fg/40">{t("需先輸入目前密碼")}</span>}
          </div>
        ) : null}
        <div className="pt-4 border-t border-fg/10 space-y-3">
          <div className="text-sm font-medium text-fg/90 flex items-center gap-2">
            <Icon icon={Zap} size={15} /> {t("查詢防護")}
          </div>
          <p className="text-xs text-fg/50 leading-relaxed">
            {t("防止誤跑")} <span className="mono">SELECT *</span> {t("大表把記憶體塞爆：查詢結果超過上限即截斷並顯示提示")}{" "}
            {t("（取完整結果請改用匯出）。變更立即生效。")}
          </p>
          <Field label={t("結果列數上限")}>
            <Select selectSize="md" value={String(guard.maxRows)}
              onChange={(e) => updateGuard({ maxRows: Number(e.target.value) })}>
              <option value="100">{t("100 列")}</option>
              <option value="1000">{t("1,000 列（預設）")}</option>
              <option value="10000">{t("10,000 列")}</option>
              <option value="100000">{t("100,000 列")}</option>
              <option value="0">{t("不限（不建議）")}</option>
            </Select>
          </Field>
          <Field label={t("查詢逾時")} hint={t("逾時後伺服器端查詢可能仍在執行，可從行程清單手動終止；MSSQL 僅支援本端逾時")}>
            <Select selectSize="md" value={String(guard.timeoutMs)}
              onChange={(e) => updateGuard({ timeoutMs: Number(e.target.value) })}>
              <option value="0">{t("關閉（預設）")}</option>
              <option value="30000">{t("30 秒")}</option>
              <option value="60000">{t("60 秒")}</option>
              <option value="300000">{t("5 分鐘")}</option>
            </Select>
          </Field>
        </div>
        <div className="pt-4 border-t border-fg/10 space-y-2">
          <label className="flex items-center gap-2 text-sm text-fg/80 cursor-pointer select-none">
            <input type="checkbox" checked={autoUpdate}
              onChange={(e) => { setAutoUpdate(e.target.checked); setAutoCheckEnabled(e.target.checked); }} />
            {t("啟動時自動檢查更新")}
          </label>
          <p className="text-xs text-fg/50 leading-relaxed">
            {t("每天最多向 GitHub 查一次最新版本（延後於啟動 10 秒後進行）；離線 / 內網環境可關閉。\r\n            「關於」對話框的手動檢查不受影響。")}
          </p>
        </div>
      </div>
    </Modal>
  );
}

// 連線池即時狀態徽章（每 4 秒輪詢 `pool_status`，呼應規劃 3.5 的連線生命週期監控）。
function PoolStatusBadge({ connId }: { connId: string }) {
  const t = useT();
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
      .then((ms) => toast.success(t("連線正常 · 延遲 {ms} ms", { ms })))
      .catch((e) => toast.error(t("連線檢測失敗：{e}", { e: String(e) })))
      .finally(() => setPinging(false));
  };
  if (!pool) return null;
  return (
    <button
      type="button"
      onClick={ping}
      disabled={pinging}
      title={t("點擊 Ping：檢測連線是否仍有效並量測往返延遲（含 SSH 通道）")}
      className="ml-auto tabular-nums hover:text-fg/90 disabled:opacity-50 cursor-pointer"
    >
      {pinging ? (
        <span className="inline-flex items-center gap-1"><Icon icon={Loader2} size={12} className="animate-spin" />{t("檢測中…")}</span>
      ) : pool.size > 0 ? (
        <span className="inline-flex items-center gap-1"><Icon icon={Zap} size={12} />{t("池")} {pool.in_use}/{pool.size}{pool.idle ? t(" · 閒置 {idle}", { idle: pool.idle }) : ""}</span>
      ) : (
        /* Mongo / Redis 未公開連線池統計（size=0），顯示 Ping 而非誤導的「池 0/0」 */
        <span className="inline-flex items-center gap-1"><Icon icon={Zap} size={12} />Ping</span>
      )}
    </button>
  );
}

// ---- 上方大圖示工具列（Navicat 風格識別特徵）----
function Toolbar({ onNewConnection, onBackup, canBackup, onEr, canEr, onAdvSearch, canAdvSearch, onHelp, onAbout, onSettings, onExportConns, onImportConns }: {
  onNewConnection: () => void;
  onBackup: () => void;
  canBackup: boolean;
  onEr: () => void;
  canEr: boolean;
  onAdvSearch: () => void;
  canAdvSearch: boolean;
  onHelp: () => void;
  onAbout: () => void;
  onSettings: () => void;
  onExportConns: () => void;
  onImportConns: () => void;
}) {
  const t = useT();
  const assistantOpen = useAssistant((s) => s.open);
  // 到 GitHub 查最新 Release（每天最多一次，失敗安靜略過）；比目前版本新才顯示標記。
  // 延後 10 秒發出：啟動最忙的時間窗（載入連線 / 首屏渲染）完全讓路；可於設定關閉自動檢查。
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    if (!autoCheckEnabled()) return;
    const timer = window.setTimeout(() => {
      checkForUpdate()
        .then((r) => { if (r && isNewer(r.version, __APP_VERSION__)) setUpdate(r); })
        .catch(() => {});
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, []);
  const tools: { icon: ReactNode; label: string; onClick: () => void; disabled: boolean; active?: boolean; hint?: string }[] = [
    { icon: <Icon icon={Plug} size={20} />, label: t("連線"), onClick: onNewConnection, disabled: false },
    { icon: <Icon icon={Network} size={20} />, label: t("ER 圖"), onClick: onEr, disabled: !canEr, hint: t("需先連線到 MySQL / PostgreSQL / SQLite") },
    { icon: <Icon icon={ScanSearch} size={20} />, label: t("進階搜尋"), onClick: onAdvSearch, disabled: !canAdvSearch, hint: t("需先選取並連線一個連線（Ctrl+Shift+G）") },
    { icon: <Icon icon={DatabaseBackup} size={20} />, label: t("備份"), onClick: onBackup, disabled: !canBackup, hint: t("需先選取並連線一個連線") },
    { icon: <Icon icon={Star} size={20} />, label: t("收藏查詢"), onClick: () => useStore.getState().openSavedManager(), disabled: false },
    { icon: <Icon icon={Upload} size={20} />, label: t("匯出連線"), onClick: onExportConns, disabled: false },
    { icon: <Icon icon={Download} size={20} />, label: t("匯入連線"), onClick: onImportConns, disabled: false },
    { icon: <Icon icon={Sparkles} size={20} />, label: t("AI 助手"), onClick: () => useAssistant.getState().toggle(), disabled: false, active: assistantOpen },
    { icon: <Icon icon={Keyboard} size={20} />, label: t("快捷鍵 (F1)"), onClick: onHelp, disabled: false },
    { icon: <Icon icon={Cog} size={20} />, label: t("設定"), onClick: onSettings, disabled: false },
    { icon: <Icon icon={Info} size={20} />, label: t("關於"), onClick: onAbout, disabled: false },
  ];

  // 工具列放不下時收成純圖示（標籤退到 title tooltip）。
  //
  // 為何需要量測而非寫死斷點：標籤寬度取決於語言（"Import connections" ≈「匯入連線」的 2.4 倍），
  // 一個固定的 px 斷點對兩種語言都不會剛好。且視窗最小寬 900px 時，連中文都塞不下 —— 這是本次
  // 之前就存在、只是被英文放大的問題。
  //
  // 遲滯（hysteresis）：收合後 scrollWidth 會縮小，若直接拿它判斷就會來回震盪。故在「展開狀態下」
  // 記住所需的完整寬度 neededRef，只有可用寬度重新超過它才展開回去。
  const barRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const neededRef = useRef(0);
  // 換語言 → 標籤長度變了，先前記住的 neededRef 失效，重新從展開狀態量一次。
  useLayoutEffect(() => { neededRef.current = 0; setCompact(false); }, [t]);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      if (!compact) {
        if (bar.scrollWidth > bar.clientWidth) {
          neededRef.current = bar.scrollWidth;
          setCompact(true);
        }
      } else if (neededRef.current && bar.clientWidth >= neededRef.current) {
        setCompact(false);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [compact, t]);

  return (
    <div ref={barRef} className="h-16 bg-bar border-b border-fg/10 flex items-center px-3 gap-1">
      <div className="font-semibold text-fg/90 mr-4 pl-1 flex items-baseline gap-1.5 shrink-0">
        <span>{APP_NAME}</span>
        <button
          type="button"
          onClick={onAbout}
          title={t("版本 {version} · 點擊開啟「關於 {app}」", { version: __APP_VERSION__, app: APP_NAME })}
          className="text-[11px] font-normal text-fg/40 tabular-nums hover:text-fg/70 hover:underline focus-visible:outline-2 focus-visible:outline-accent/60 rounded"
        >v{__APP_VERSION__}</button>
        {update && (
          <button
            type="button"
            onClick={() => api.openExternal(update.url).catch(() => {})}
            title={t("點擊前往下載 v{version}", { version: update.version })}
            className="self-center text-[11px] font-medium text-accent hover:underline inline-flex items-center gap-1 focus-visible:outline-2 focus-visible:outline-accent/60 rounded"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />
            {t("有新版 v{version}", { version: update.version })}
          </button>
        )}
      </div>
      {/* 英文標籤約為中文的 1.6 倍寬（「匯入連線」4 字 vs "Import connections" 18 字），
          原本的 w-16 固定寬會把字裁掉，故改為 min-w-16 + 內距撐開、不換行。
          放不下時整列改為純圖示（compact），文字退到 title —— 見 useLayoutEffect 的量測。 */}
      {tools.map((tool) => (
        <button
          type="button"
          key={tool.label}
          onClick={tool.onClick}
          disabled={tool.disabled}
          title={tool.disabled && tool.hint ? tool.hint : tool.label}
          {...(tool.active !== undefined ? { "aria-pressed": tool.active } : {})}
          className={`${compact ? "w-11" : "min-w-16 px-2"} shrink-0 h-12 flex flex-col items-center justify-center rounded hover:bg-fg/5 disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-accent/60 ${
            tool.active ? "bg-accent/12 text-accent" : ""
          }`}
        >
          <span className="text-lg leading-none">{tool.icon}</span>
          {!compact && <span className="text-[11px] text-fg/60 mt-1 whitespace-nowrap">{tool.label}</span>}
        </button>
      ))}
      {/* 主題 + 語言靠右成組；compact 時一併收窄並收起圖示，否則 900px（視窗最小寬）仍塞不下。 */}
      <div className="ml-auto shrink-0 flex items-center gap-3 pl-3">
        <LanguageMenu compact={compact} />
        <ThemeMenu compact={compact} />
      </div>
    </div>
  );
}

// 工具列右側的兩個下拉共用外框：compact 時收起圖示並收窄，讓 900px 的最小視窗仍放得下。
const MENU_BOX = (compact: boolean) =>
  `shrink-0 flex items-center gap-1.5 ${compact ? "w-24" : "w-32"}`;

// ---- 主題選擇（配色 + 深淺整併）：工具列右側；所有配色平鋪為單層清單，取代原深淺滑桿 ----
function ThemeMenu({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const themeId = useTheme((s) => s.themeId);
  const setThemeId = useTheme((s) => s.setThemeId);
  return (
    <div className={MENU_BOX(compact)} title={t("主題（配色 + 深淺）")}>
      {!compact && <Icon icon={Palette} size={16} className="text-fg/55 shrink-0" />}
      <Select selectSize="sm" value={themeId}
        onChange={(e) => setThemeId(e.target.value as EditorThemeId)}>
        <option value="moonstone">{t("光亮")}</option>
        <option value="amethyst">{t("暗黑")}</option>
        {EDITOR_THEMES.filter((d) => d.id !== "moonstone" && d.id !== "amethyst").map((d) => (
          <option key={d.id} value={d.id}>{t(d.label)}</option>
        ))}
      </Select>
    </div>
  );
}

// ---- 介面語言：與 ThemeMenu 同規格，選項來自 i18n 的 LANGUAGES 單一真相。
// 語言名一律以該語言自己的寫法呈現（繁體中文 / English），不隨當前介面語言翻譯 —— 這樣
// 誤切到看不懂的語言時，使用者仍找得回自己的母語。
function LanguageMenu({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  return (
    <div className={MENU_BOX(compact)} title={t("語言")}>
      {!compact && <Icon icon={Globe} size={16} className="text-fg/55 shrink-0" />}
      <Select selectSize="sm" value={lang}
        onChange={(e) => { void setLang(e.target.value as Lang); }}>
        {LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>{l.label}</option>
        ))}
      </Select>
    </div>
  );
}

// ---- 快捷鍵說明（F1 開啟）----
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const t = useT();
  const groups: [string, [string, string][]][] = [
    [t("全域"), [
      ["Ctrl+K", t("命令面板：跳到連線 / 資料庫 / 資料表，或執行動作")],
      ["Ctrl+Shift+G", t("進階物件搜尋（名稱 / 定義 / 註解 / 萬用字元 / 整字）")],
    ]],
    [t("查詢編輯器"), [
      ["F6", t("執行整段查詢")],
      ["Ctrl+Enter", t("執行游標所在語句或選取段")],
      ["Ctrl+N", t("開新查詢分頁（依選取的連線 / 資料庫 / 資料表帶入範圍）")],
      ["Ctrl+Shift+N", t("新增連線")],
      ["Ctrl+Space", t("自動完成（表名 / 欄名 / 關鍵字）")],
      ["Tab", t("縮排")],
      ["Ctrl+/", t("切換 SQL 行註解")],
      ["Ctrl+Shift+F", t("格式化 SQL")],
      ["Ctrl+S / Ctrl+O", t("另存 / 開啟 .sql 檔")],
      [t("工具列下拉"), t("切換目前連線 / 資料庫；「視覺化解釋」看執行計畫")],
    ]],
    [t("資料表格"), [
      [t("方向鍵 / Tab"), t("移動選取儲存格（Tab 於列尾換行）")],
      ["Home / End", t("本列首 / 末欄（Ctrl+ 跳整表角落）")],
      ["PageUp / PageDown", t("上 / 下移約 20 列")],
      ["Enter / F2", t("編輯選取格（Enter 送出後下移）")],
      [t("直接打字"), t("覆寫式編輯該格")],
      ["Delete", t("將選取格設為 NULL")],
      [t("Shift+點選 / Shift+方向鍵"), t("框選矩形範圍（Ctrl+C 複製整塊、Delete 整塊設 NULL）")],
      ["Ctrl+A", t("框選整頁所有儲存格")],
      [t("Shift+點列號"), t("選取整列（狀態列顯示格數 / 加總 / 平均）")],
      ["Ctrl+C / Ctrl+V", t("複製 / 貼上（區塊 TSV；單值貼到框選範圍＝整塊填入）")],
      ["Ctrl+S", t("套用待套用的儲存格編輯")],
      ["F5", t("重新整理目前頁")],
      [t("雙擊儲存格"), t("編輯；雙擊欄分隔線自動符合寬度")],
      [t("點欄標題 / Shift+點"), t("排序 / 多欄排序")],
      [t("右鍵"), t("複製 / 篩選 / 設 NULL / 還原此格 / 刪除")],
    ]],
    [t("查詢結果表格"), [
      [t("方向鍵 / Tab"), t("移動選取（Tab 於列尾換行）")],
      ["Home / End", t("本列首 / 末欄（Ctrl+ 跳整頁角落）")],
      [t("Shift+點選 / Shift+方向鍵"), t("框選矩形範圍")],
      [t("Ctrl+A / Shift+點列號"), t("框選整頁 / 選取整列")],
      ["Ctrl+C", t("複製選取格或整塊 (TSV)；工具列顯示範圍統計")],
      [t("雙擊 / 右鍵"), t("檢視內容 / 整列；複製值 / 標題 / 列 / 欄 / 範圍")],
    ]],
    [t("分頁與導覽"), [
      ["Ctrl+Tab / Ctrl+Shift+Tab", t("切換下一 / 上一個分頁")],
      ["Ctrl+1…9", t("跳到第 N 個分頁（9＝最後）")],
      [t("Ctrl+W / 中鍵點分頁"), t("關閉作用中分頁")],
      [t("Ctrl+F 或 /"), t("聚焦左側搜尋框")],
      ["Esc", t("關閉對話框 / 選單 / 取消選取")],
      ["F1", t("顯示 / 隱藏本說明")],
    ]],
  ];
  return (
    <Modal open onClose={onClose} title={t("鍵盤快捷鍵")} icon={Keyboard} size="md">
      <div className="space-y-4">
        {groups.map(([title, rows]) => (
          <div key={title}>
            <div className="text-xs text-fg/40 mb-1.5">{title}</div>
            <div className="space-y-1">
              {rows.map(([k, desc]) => (
                <div key={k} className="flex items-baseline gap-3 text-sm">
                  <kbd className="shrink-0 min-w-[150px] mono text-[11px] text-accent bg-inset border border-fg/10 rounded px-1.5 py-0.5">{k}</kbd>
                  <span className="text-fg/70">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// 一個資料庫展開後的物件集合（依 Navicat 樹狀分組：資料表 / 檢視 / 函式）。
interface DbObjects {
  tables: TableInfo[];   // 一般資料表 / 集合（kind !== "view"）
  views: TableInfo[];    // 視圖（kind === "view"）
  routines: RoutineInfo[]; // 預存程序 + 函式
}
// 把 list_tables（含表 + 視圖）與 list_routines（含程序 / 函式 / 觸發器）拆成樹狀分組。
const splitDbObjects = (tables: TableInfo[], routines: RoutineInfo[]): DbObjects => ({
  tables: tables.filter((tbl) => tbl.kind !== "view"),
  views: tables.filter((tbl) => tbl.kind === "view"),
  routines: routines.filter((r) => r.routine_type === "procedure" || r.routine_type === "function"),
});
// 物件分組資料夾預設展開狀態：全部預設收合（展開資料庫時不自動攤開資料表，避免大量物件一次塞滿）。
const FOLDER_DEFAULT_OPEN: Record<string, boolean> = { tables: false, views: false, functions: false, queries: false };

// ---- 右鍵選單樹（支援巢狀子選單）：對標 Navicat 的多層選單（複製資料表 / 維護 / 傾印 SQL）----
type MenuNode =
  | { kind: "item"; label: string; onClick: () => void; danger?: boolean }
  | { kind: "sep" }
  | { kind: "sub"; label: string; children: MenuNode[] };

// 右鍵選單外框：點擊背景關閉，並把面板位置夾在視窗內（選單變長後，於下半部點擊不致溢出視窗底部、
// 讓刪除 / 截斷等項目無法點按）。不使用 overflow-auto，以免裁切向右展開的子選單。
function MenuPanel({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscToClose(onClose); // Esc 關閉選單，與對話框一致
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
  }, [x, y]);
  return (
    <>
      <div className="fixed inset-0 z-[89]"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref}
        className="fixed z-[90] min-w-[180px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
        style={{ left: pos.left, top: pos.top }}>
        {children}
      </div>
    </>
  );
}

// 遞迴渲染選單節點；子選單以滑鼠懸停展開，定位於父項右側（左側連線樹空間充足，固定向右展開）。
function MenuItems({ nodes, onClose }: { nodes: MenuNode[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <>
      {nodes.map((n, i) => {
        if (n.kind === "sep") return <div key={i} className="my-1 border-t border-fg/10" />;
        if (n.kind === "sub")
          return (
            <div key={i} className="relative"
              onMouseEnter={() => setOpenSub(i)}
              onMouseLeave={() => setOpenSub((s) => (s === i ? null : s))}>
              <button type="button"
                className="flex items-center w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80">
                <span className="flex-1">{n.label}</span>
                <Icon icon={ChevronRight} size={13} className="text-fg/30 ml-3 shrink-0" />
              </button>
              {openSub === i && (
                <div className="absolute left-full top-0 -mt-1 min-w-[180px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 z-[91]">
                  <MenuItems nodes={n.children} onClose={onClose} />
                </div>
              )}
            </div>
          );
        return (
          <button key={i} type="button"
            onClick={() => { onClose(); n.onClick(); }}
            className={`block w-full text-left px-3 py-1.5 hover:bg-fg/10 ${n.danger ? "text-danger" : "text-fg/80"}`}>
            {n.label}
          </button>
        );
      })}
    </>
  );
}

// ---- 左側連線/物件樹 ----
function Sidebar({ onEdit, width, onAdvSearch }: { onEdit: (c: ConnectionConfig) => void; width: number; onAdvSearch: (connId: string, kind: DbKind) => void }) {
  const t = useT();
  const { connections, connectedIds, activeId, setActive, selectedNode, selectNode, readonlyConns } = useStore();
  const [databases, setDatabases] = useState<Record<string, string[]>>({});
  // 已展開的資料庫: 鍵為 connId:db，值為樹狀分組（資料表 / 檢視 / 函式）
  const [expandedDbs, setExpandedDbs] = useState<Record<string, DbObjects>>({});
  // 載入物件中（展開資料庫時顯示 loading）的 connId:db 集合
  const [loadingDbs, setLoadingDbs] = useState<Set<string>>(new Set());
  // 各資料庫底下分組資料夾的展開狀態，鍵為 connId:db:type
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>({});
  // 連線中（顯示 loading）的 id 集合
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  // 右鍵選單（連線節點）
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // 命令面板（Ctrl/Cmd+K）：跨連線快速跳轉。
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        if (document.body.dataset.modalCount) return; // 有對話框時讓路
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  // 釘選 / 常用資料表（致敬 Navicat Favorites）：localStorage 持久化。
  const [pins, setPins] = useState<PinnedTable[]>(loadPins);
  const togglePinned = (p: PinnedTable) =>
    setPins((list) => { const next = togglePin(list, p); persistPins(next); return next; });
  // 連線色標（致敬 Navicat connection color）：per-連線 顏色，localStorage 持久化。
  const [connColors, setConnColors] = useState(loadConnColors);
  const applyConnColor = (id: string, color: string) =>
    setConnColors((m) => { const next = setConnColor(m, id, color); persistConnColors(next); return next; });
  // 右鍵選單（Redis DB 節點）
  const [dbMenu, setDbMenu] = useState<{ connId: string; db: string; x: number; y: number } | null>(null);
  // Redis 伺服器狀態面板
  const [status, setStatus] = useState<{ id: string; name: string } | null>(null);
  // Redis 命令列
  const [console_, setConsole] = useState<{ id: string; name: string; db: string } | null>(null);
  // Mongo 監控面板（serverStatus / dbStats / currentOp / Profiler）。
  const [mongoOps, setMongoOps] = useState<{ id: string; name: string; db: string } | null>(null);
  const [kafkaGroups, setKafkaGroups] = useState<{ id: string; name: string } | null>(null);
  const [kafkaOverview, setKafkaOverview] = useState<{ id: string; name: string } | null>(null);
  const [kafkaMonitor, setKafkaMonitor] = useState<{ id: string; name: string } | null>(null);
  const [kafkaConnect, setKafkaConnect] = useState<{ id: string; name: string } | null>(null);
  const [kafkaAcl, setKafkaAcl] = useState<{ id: string; name: string } | null>(null);
  const [kafkaSchema, setKafkaSchema] = useState<{ id: string; name: string } | null>(null);
  const [kafkaCreateTopic, setKafkaCreateTopic] = useState<{ connId: string } | null>(null);
  // Elasticsearch / OpenSearch 叢集總覽面板。
  const [esOverview, setEsOverview] = useState<{ id: string; name: string } | null>(null);
  // Elasticsearch / OpenSearch 索引 Mapping 檢視器。
  const [esMapping, setEsMapping] = useState<{ connId: string; index: string } | null>(null);
  // RabbitMQ 總覽面板。
  const [rabbitOverview, setRabbitOverview] = useState<{ id: string; name: string } | null>(null);
  // RabbitMQ 發布訊息對話框（從連線 / db 層開啟時 routingKey 空；從佇列開啟時預填佇列名）。
  const [rabbitPublish, setRabbitPublish] = useState<{ connId: string; routingKey?: string } | null>(null);
  // 新增 Redis 鍵對話框
  const [newKey, setNewKey] = useState<{ connId: string; db: string } | null>(null);
  // 設計表結構（CREATE TABLE）對話框：帶連線 / 資料庫 / 種類。
  const [designTable, setDesignTable] = useState<{ connId: string; db: string; kind: DbKind } | null>(null);
  // 連線屬性檢視（唯讀 + 即時狀態）。
  const [connProps, setConnProps] = useState<ConnectionConfig | null>(null);
  // 預存程序 / 觸發器瀏覽器。initial 帶入時直接開該 routine 的定義編輯器（樹狀雙擊用）。
  const [routines, setRoutines] = useState<{ connId: string; db: string; kind: DbKind; initial?: RoutineInfo; initialAction?: "edit" | "exec"; newType?: string } | null>(null);
  // 函式 / 預存程序樹節點右鍵選單。
  const [routineMenu, setRoutineMenu] = useState<{ connId: string; db: string; kind: DbKind; routine: RoutineInfo; x: number; y: number } | null>(null);
  // 新增視圖對話框。
  const [createView, setCreateView] = useState<{ connId: string; db: string; kind: DbKind } | null>(null);
  // 處理程序 / 工作階段檢視。
  const [procList, setProcList] = useState<{ connId: string; kind: DbKind } | null>(null);
  // 通用伺服器查詢檢視（使用者 / 角色等）。
  const [serverQuery, setServerQuery] = useState<{ connId: string; title: string; sql: string } | null>(null);
  const [userMgr, setUserMgr] = useState<{ connId: string } | null>(null);
  const [viewDesign, setViewDesign] = useState<{ connId: string; db: string; view: string; kind: DbKind } | null>(null);
  const [dbProps, setDbProps] = useState<{ connId: string; db: string } | null>(null);
  const [schemaCompare, setSchemaCompare] = useState<{ connId: string; db: string; kind: DbKind } | null>(null);
  // SQL Search（全資料庫物件搜尋：名稱 / 定義內文 / 註解）。
  const [searchObjs, setSearchObjs] = useState<{ connId: string; kind: DbKind } | null>(null);
  // 連線 / 表 搜尋過濾字串
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  // 每個資料庫節點獨立的表名過濾（key = `${connId}:${db}`）。大型 schema（如 1700+ 張表）好找。
  const [dbFilter, setDbFilter] = useState<Record<string, string>>({});
  // 頂部框「跨資料庫表名搜尋」（涵蓋尚未展開的庫）：命中以內嵌結果列呈現，點擊開表 + 樹中定位。
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchSeqRef = useRef(0);
  // 右鍵選單（SQL 表節點：產生 SQL）。objKind 為物件種類（"table" | "view"），決定生命週期 DDL。
  const [tableMenu, setTableMenu] = useState<
    { connId: string; db: string; table: string; kind: DbKind; objKind: string; x: number; y: number } | null
  >(null);
  // 右鍵選單（物件分組資料夾：資料表 / 檢視 / 函式 / 查詢）。type 決定附加動作，一律含「新增查詢」。
  const [folderMenu, setFolderMenu] = useState<
    { connId: string; db: string; kind: DbKind; type: string; x: number; y: number } | null
  >(null);
  // 資料表 / 集合屬性檢視。
  const [tableProps, setTableProps] = useState<
    { connId: string; db: string; table: string; kind: DbKind; objKind: string } | null
  >(null);
  // 由資料表右鍵觸發的對話框（匯入 / 匯出 / 資料字典 / 資料產生 / 逆向至模型）。
  const [importTbl, setImportTbl] = useState<{ connId: string; db: string; table: string } | null>(null);
  const [exportTbl, setExportTbl] = useState<{ connId: string; db: string; table: string } | null>(null);
  const [transferTbl, setTransferTbl] = useState<{ connId: string; db: string; table: string } | null>(null);
  const [builderTbl, setBuilderTbl] = useState<{ connId: string; db: string; table: string; kind: DbKind } | null>(null);
  const [syncTbl, setSyncTbl] = useState<{ connId: string; db: string; table: string } | null>(null);
  const [dbTransfer, setDbTransfer] = useState<{ connId: string; db: string } | null>(null);
  const [dbDict, setDbDict] = useState<{ connId: string; db: string; kind: DbKind } | null>(null);
  const [dataDict, setDataDict] = useState<{ connId: string; db: string; table: string; kind: DbKind } | null>(null);
  const [dataGen, setDataGen] = useState<{ connId: string; db: string; table: string; kind: DbKind } | null>(null);
  const [erTable, setErTable] = useState<{ connId: string; db: string; table: string } | null>(null);

  // Ctrl/Cmd+F 或 "/" 聚焦側欄搜尋框。defaultPrevented + inField 守衛避免搶走資料表內尋找 / 編輯器輸入。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (document.body.dataset.modalCount) return; // 有對話框開啟時不要把焦點搶到背後的側欄
      const el = e.target as HTMLElement | null;
      // 別搶走可聚焦 / 互動元素的焦點：輸入框、編輯器，以及 tabIndex=0 的結果表格容器 / 欄標題、按鈕等。
      const interactive = !!el?.closest(
        "input,textarea,select,button,a[href],[contenteditable='true'],[tabindex]:not([tabindex='-1']),[role='button'],[role='menuitem'],[role='textbox']"
      );
      const inField =
        el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || !!el?.isContentEditable || interactive;
      const wantFocus =
        ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F") && !inField) ||
        (e.key === "/" && !inField);
      if (!wantFocus) return;
      e.preventDefault();
      filterRef.current?.focus();
      filterRef.current?.select();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // 頂部框：term ≥ 2 時 debounce 300ms 跨資料庫搜尋表名（含未展開的庫）。目標＝目前 active 且已連線者，
  // 否則第一個已連線者。驅動不支援搜尋（如 redis）→ 靜默不顯示內嵌結果，不影響既有樹搜尋。
  useEffect(() => {
    const term = filter.trim();
    if (term.length < 2) { setSearchHits(null); setSearchBusy(false); return; }
    const target =
      connections.find((c) => c.id === activeId && connectedIds.has(c.id)) ??
      connections.find((c) => connectedIds.has(c.id));
    if (!target) { setSearchHits(null); setSearchBusy(false); return; }
    const seq = ++searchSeqRef.current;
    setSearchBusy(true);
    const h = setTimeout(() => {
      api
        .searchObjects(target.id, {
          term,
          databases: null,
          types: ["table", "view"],
          match_names: true,
          match_definitions: false,
          match_comments: false,
          case_sensitive: false,
          limit: 200,
        })
        .then((hits) => {
          if (searchSeqRef.current !== seq) return;
          setSearchHits(hits);
          setSearchBusy(false);
        })
        .catch(() => {
          if (searchSeqRef.current !== seq) return;
          setSearchHits(null); // Unsupported / 錯誤：靜默，維持既有已展開庫的樹搜尋
          setSearchBusy(false);
        });
    }, 300);
    return () => clearTimeout(h);
  }, [filter, activeId, connectedIds, connections]);

  // Esc 關閉側欄右鍵選單（連線 / 資料庫 / 程序 / 表），與對話框一致。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(null);
      setDbMenu(null);
      setRoutineMenu(null);
      setTableMenu(null);
      setFolderMenu(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

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
      // 連線失敗改用對話框（取代 6 秒 toast）：訊息可讀完、可全選複製，附友善提示與重試。
      const raw = e?.message ?? t("連線失敗");
      const hint = friendlyDbError(cfg.kind, raw);
      setBusy(id, false); // 先解除 connecting 狀態，避免重試被防重入擋下
      const retry = await uiConfirm(hint ? `${hint}\n\n${raw}` : raw, {
        title: t("連線失敗：{name}", { name: cfg.name }),
        confirmText: t("重試"),
      });
      if (retry) void doConnect(id);
      return;
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

  // 命令面板項目：連線 / 資料庫 / 已載入的資料表（含視圖）/ 常用動作。
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    for (const c of connections) {
      items.push({
        id: `conn:${c.id}`, label: c.name, hint: KIND_META[c.kind].label, group: "conn", icon: Database,
        run: () => { setActive(c.id); selectNode({ type: "connection", connId: c.id }); if (!connectedIds.has(c.id)) toggleConnect(c.id); },
      });
    }
    for (const [connId, dbs] of Object.entries(databases)) {
      const cn = connections.find((c) => c.id === connId)?.name ?? "";
      for (const db of dbs) items.push({ id: `db:${connId}:${db}`, label: db, hint: cn, group: "db", icon: Database, run: () => setActive(connId) });
    }
    for (const [key, objs] of Object.entries(expandedDbs)) {
      const ci = key.indexOf(":");
      const connId = key.slice(0, ci);
      const db = key.slice(ci + 1);
      const cn = connections.find((c) => c.id === connId)?.name ?? "";
      for (const obj of [...objs.tables, ...objs.views]) {
        items.push({
          id: `tbl:${key}:${obj.name}`, label: obj.name, hint: `${cn} · ${db}`, group: obj.kind === "view" ? "view" : "table", icon: Table2,
          run: () => { setActive(connId); useStore.getState().openTable(connId, db, obj.name, "data", obj.kind); },
        });
      }
    }
    // 切到第一個查詢分頁（不寫死 __query__：第一個「查詢」分頁可被關掉）。
    items.push({ id: "act:query", label: t("開啟查詢編輯器"), group: "action", icon: FileCode2, run: () => { const s = useStore.getState(); s.setActiveTab(s.queryTabs[0]); } });
    items.push({
      id: "act:advsearch", label: t("進階物件搜尋…"), group: "action", icon: Search,
      run: () => {
        const c = connections.find((x) => x.id === activeId);
        if (c && connectedIds.has(c.id)) onAdvSearch(c.id, c.kind);
        else toast.info(t("請先選取並連線一個連線"));
      },
    });
    items.push({ id: "act:theme", label: t("切換深淺色主題"), group: "action", icon: Moon, run: () => useTheme.getState().toggle() });
    // 釘選的常用表（含未展開資料庫者）也納入索引，確保最愛永遠可搜尋。
    for (const p of pins) {
      if (!connections.some((c) => c.id === p.connId)) continue;
      const cn = connections.find((c) => c.id === p.connId)?.name ?? "";
      items.push({
        id: `pin:${p.connId}:${p.db}:${p.table}`, label: p.table, hint: `★ ${cn} · ${p.db}`, group: "pinned", icon: Star,
        run: () => { setActive(p.connId); useStore.getState().openTable(p.connId, p.db, p.table, "data", p.kind); },
      });
    }
    return items;
    // t 必須在依賴內：切換語言時 useT() 會換一個新的函式參考，此 memo 才會重算出新語言的標籤。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, connectedIds, databases, expandedDbs, pins, activeId, onAdvSearch, t]);

  const refreshDbs = async (id: string) => {
    if (!connectedIds.has(id)) return;
    try {
      await api.clearCache(id).catch(() => {}); // 外部 gateway：清快取以強制重抓（其餘驅動 no-op）
      const dbs = await api.listDatabases(id);
      setDatabases((d) => ({ ...d, [id]: dbs }));
      toast.success(t("已重新整理"));
    } catch (e: any) {
      toast.error(e?.message ?? t("重新整理失敗"));
    }
  };

  const deleteConn = async (id: string, name: string) => {
    const ok = await uiConfirm(t("刪除連線「{name}」？此動作會一併移除已儲存的密碼。", { name }), {
      title: t("刪除連線"),
      danger: true,
      confirmText: t("刪除"),
    });
    if (!ok) return;
    try {
      await api.removeSavedConnection(id);
    } catch {
      // 即使後端清理失敗，仍從前端移除
    }
    useStore.getState().markDisconnected(id);
    useStore.getState().removeConnection(id);
    setPins((list) => { const next = removePinsForConn(list, id); persistPins(next); return next; });
    toast.success(t("連線已刪除"));
  };

  const setDbLoading = (key: string, on: boolean) =>
    setLoadingDbs((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  // 分組資料夾展開狀態：未設定者採該類型預設值。
  const isFolderOpen = (dbKey: string, type: string) =>
    folderOpen[`${dbKey}:${type}`] ?? FOLDER_DEFAULT_OPEN[type];
  const toggleFolder = (dbKey: string, type: string) =>
    setFolderOpen((o) => ({ ...o, [`${dbKey}:${type}`]: !isFolderOpen(dbKey, type) }));

  // 讀取某資料庫的物件（表 + 視圖 + 程序 / 函式）。程序清單失敗不阻斷表載入。
  const fetchDbObjects = async (connId: string, kind: DbKind, db: string): Promise<DbObjects> => {
    const [tables, routines] = await Promise.all([
      api.listTables(connId, db),
      supportsRoutines(kind) ? api.listRoutines(connId, db).catch(() => [] as RoutineInfo[]) : Promise.resolve([] as RoutineInfo[]),
    ]);
    return splitDbObjects(tables, routines);
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
    const cfg = connections.find((c) => c.id === connId);
    if (!cfg) return;
    setDbLoading(key, true);
    try {
      const objs = await fetchDbObjects(connId, cfg.kind, db);
      setExpandedDbs((e) => ({ ...e, [key]: objs }));
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取表失敗"));
    } finally {
      setDbLoading(key, false);
    }
  };

  // 確保某資料庫已展開（載入 objects）；已展開則 no-op。供內嵌跨庫搜尋結果「點擊定位」用。
  const ensureDbExpanded = async (connId: string, db: string) => {
    const key = `${connId}:${db}`;
    if (expandedDbs[key]) return;
    const cfg = connections.find((c) => c.id === connId);
    if (!cfg) return;
    setDbLoading(key, true);
    try {
      const objs = await fetchDbObjects(connId, cfg.kind, db);
      setExpandedDbs((e) => ({ ...e, [key]: objs }));
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取表失敗"));
    } finally {
      setDbLoading(key, false);
    }
  };

  // 「在物件總管中選取」：消費進階搜尋發出的 revealRequest（展開資料庫 → 展開資料夾 →
  // 選取節點 → 捲入可視範圍）。以 nonce 觸發，即使目標相同也重跑。
  const revealRequest = useStore((s) => s.revealRequest);
  useEffect(() => {
    if (!revealRequest) return;
    const { connId, db, table, objKind } = revealRequest;
    const cfg = connections.find((c) => c.id === connId);
    if (!cfg || !connectedIds.has(connId)) return;
    let cancelled = false;
    (async () => {
      setActive(connId);
      await ensureDbExpanded(connId, db); // async：載入該庫物件（若尚未展開）
      if (cancelled) return;
      const dbKey = `${connId}:${db}`;
      const folder = objKind === "view" ? "views" : "tables";
      setFolderOpen((o) => ({ ...o, [`${dbKey}:${folder}`]: true })); // 展開對應資料夾
      selectNode({ type: "table", connId, db, table, kind: cfg.kind, objKind });
      // async 展開 + 資料夾展開後，節點需數個 frame 才進 DOM → rAF 重試（上限 ~20 frame）。
      let tries = 0;
      const tick = () => {
        if (cancelled) return;
        const el = Array.from(document.querySelectorAll<HTMLElement>("[data-tree-table]")).find(
          (n) => n.dataset.treeConn === connId && n.dataset.treeDb === db && n.dataset.treeTable === table
        );
        if (el) {
          el.scrollIntoView({ block: "nearest" });
          return;
        }
        if (tries++ < 20) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest?.nonce]);

  // 強制重載某資料庫的表 / 集合清單（新增 / 刪除表 / 集合後刷新樹狀）。
  // 註：折疊中的節點會被展開以呈現剛建立的項目（刻意，符合「建立後即見」預期）。
  const refreshTables = async (connId: string, db: string) => {
    const cfg = connections.find((c) => c.id === connId);
    if (!cfg) return;
    const key = `${connId}:${db}`;
    setDbLoading(key, true);
    try {
      await api.clearCache(connId).catch(() => {}); // 外部 gateway：清快取以強制重抓（其餘驅動 no-op）
      const objs = await fetchDbObjects(connId, cfg.kind, db);
      setExpandedDbs((e) => ({ ...e, [key]: objs }));
    } catch (e: any) {
      // 與同檔 toggleDb 的錯誤處理一致：DDL 已成功，僅清單刷新失敗時告知使用者手動重整。
      console.warn("refreshTables failed", e);
      toast.error(t("清單刷新失敗，請手動重新整理該資料庫"));
    } finally {
      setDbLoading(key, false);
    }
  };

  // Redis：清空指定 DB（FLUSHDB）。沿用既有 query 通道（DB 前綴語法、無鍵引數，安全）。
  const flushDb = async (connId: string, db: string) => {
    const ok = await uiConfirm(t("清空 DB {db} 的所有鍵？此動作無法復原。", { db }), {
      title: t("清空資料庫"),
      danger: true,
      confirmText: t("清空"),
    });
    if (!ok) return;
    try {
      await api.runQuery(connId, `${db}:FLUSHDB`);
      toast.success(t("DB {db} 已清空", { db }));
    } catch (e: any) {
      toast.error(e?.message ?? t("清空失敗"));
    }
  };

  // 轉儲整庫結構 SQL（致敬 Navicat / DBeaver）：取所有表的建表 SQL → 另存檔。
  const dumpSchema = async (connId: string, db: string) => {
    try {
      const sql = await api.schemaDump(connId, db);
      const out = await pickSaveFile(`${db}_schema.sql`, [{ name: "SQL", extensions: ["sql"] }]);
      if (!out) return;
      await api.saveTextFile(out, sql);
      toast.success(t("已匯出結構 SQL → {out}", { out }));
    } catch (e: any) {
      toast.error(e?.message ?? t("匯出結構失敗"));
    }
  };

  // 新增集合（MongoDB，schemaless）：提示名稱 → createCollection → 刷新樹狀。
  const createCollection = async (connId: string, db: string) => {
    const name = await uiPrompt(t("集合名稱"), { title: t("新增集合"), placeholder: t("例：users") });
    if (!name?.trim()) return;
    try {
      await api.createCollection(connId, db, name.trim());
      toast.success(t("集合「{trim}」已建立", { trim: name.trim() }));
      refreshTables(connId, db);
    } catch (e: any) {
      toast.error(e?.message ?? t("建立集合失敗"));
    }
  };

  // 新增資料庫 / schema：MySQL CREATE DATABASE、PostgreSQL CREATE SCHEMA、MongoDB 具現化。
  const createDatabase = async (connId: string, kind: DbKind) => {
    const isPg = kind === "postgres";
    const label = isPg ? t("Schema 名稱") : t("資料庫名稱");
    const name = await uiPrompt(label, { title: isPg ? t("新增 Schema") : t("新增資料庫"), placeholder: t("例：app") });
    if (!name?.trim()) return;
    try {
      await api.createDatabase(connId, name.trim());
      toast.success(t("{kind}「{name}」已建立", { kind: isPg ? "Schema" : t("資料庫"), name: name.trim() }));
      refreshDbs(connId);
    } catch (e: any) {
      toast.error(e?.message ?? t("新增失敗"));
    }
  };

  // 刪除資料庫 / schema（DROP DATABASE / DROP SCHEMA CASCADE / Mongo drop）。
  // 高破壞且 CASCADE 不可逆，採 type-to-confirm（須輸入正確名稱）取代單鍵確認。後端另有系統庫硬擋。
  const dropDatabase = async (connId: string, db: string, kind: DbKind) => {
    const noun = kind === "postgres" ? "Schema" : t("資料庫");
    const cascade = kind === "postgres" ? "DROP SCHEMA … CASCADE" : isMysqlFamily(kind) ? "DROP DATABASE" : "dropDatabase";
    const isDefault = kind === "postgres" && db === "public";
    const warn = isDefault ? t("\n注意：「{db}」是此連線的預設工作 schema。", { db }) : "";
    const typed = await uiPrompt(
      t("此操作將執行 {cascade}，連帶刪除「{db}」下所有資料表 / 視圖 / 物件，無法復原。{warn}\n請輸入「{v4}」以確認：", { cascade, db, warn, v4: db }),
      { title: t("刪除{noun}", { noun }), confirmText: t("刪除"), placeholder: db },
    );
    if (typed == null) return; // 取消
    if (typed.trim() !== db) {
      toast.error(t("名稱不符，已取消刪除"));
      return;
    }
    try {
      await api.dropDatabase(connId, db);
      useStore.getState().closeTablesUnder(connId, db);
      toast.success(t("已刪除{noun}「{db}」", { noun, db }));
      refreshDbs(connId);
    } catch (e: any) {
      toast.error(e?.message ?? t("刪除失敗"));
    }
  };

  // ---- 產生 SQL（致敬 Navicat / DBeaver 的 SQL 範本）----
  const quoteId = quoteIdent;
  const qualified = qualifiedName;
  type TblRef = { connId: string; db: string; table: string; kind: DbKind; objKind?: string };
  // 產生的 SQL 一律「向右開新查詢分頁」並切過去（對標 SSMS 的 Select Top N / New Query）：
  // 不覆蓋使用者目前編輯器裡的草稿。newQueryTab 會一併切換連線並帶入 pendingSql 給新分頁消費。
  const sendQuery = (connId: string, sql: string) => {
    useStore.getState().newQueryTab(sql, connId);
  };
  // 對資料庫節點「新增查詢」：開新查詢分頁，並以 USE / search_path 把後續查詢限定到此資料庫 / schema。
  // SQLite 為單檔無多庫概念，開空白新分頁即可。
  const newQueryForDb = (connId: string, db: string, kind: DbKind) => {
    const stmt = buildUseDatabase(kind, db);
    if (stmt) sendQuery(connId, `${stmt};\n\n`);
    else useStore.getState().newQueryTab(undefined, connId);
  };
  const genSelect = (m: TblRef) =>
    sendQuery(m.connId, `SELECT *\nFROM ${qualified(m.kind, m.db, m.table)}\nLIMIT 100;`);
  // 明列欄位的 SELECT（避免 SELECT *，便於刪減欄位；致敬 DataGrip / Navicat 的展開 *）。
  const genSelectColumns = async (m: TblRef) => {
    try {
      const cols = await api.tableColumns(m.connId, m.db, m.table);
      if (cols.length === 0) { genSelect(m); return; }
      const names = cols.map((c) => quoteId(m.kind, c.name)).join(", ");
      sendQuery(m.connId, `SELECT ${names}\nFROM ${qualified(m.kind, m.db, m.table)}\nLIMIT 100;`);
    } catch (e: any) {
      toast.error(e?.message ?? t("產生 SELECT 失敗"));
    }
  };
  const genMongoFind = (m: TblRef) =>
    sendQuery(m.connId, JSON.stringify({ db: m.db, collection: m.table, filter: {} }, null, 2));
  const genMongoAggregate = (m: TblRef) =>
    sendQuery(
      m.connId,
      JSON.stringify(
        { db: m.db, collection: m.table, pipeline: [{ $match: {} }, { $group: { _id: null, count: { $sum: 1 } } }] },
        null,
        2,
      ),
    );
  const genMongoInsert = (m: TblRef) =>
    sendQuery(m.connId, JSON.stringify({ db: m.db, collection: m.table, insert: [{}] }, null, 2));
  const genCount = (m: TblRef) =>
    sendQuery(m.connId, `SELECT COUNT(*) FROM ${qualified(m.kind, m.db, m.table)};`);
  const genInsert = async (m: TblRef) => {
    try {
      const cols = await api.tableColumns(m.connId, m.db, m.table);
      const names = cols.map((c) => quoteId(m.kind, c.name)).join(", ");
      const vals = cols.map(() => "NULL").join(", ");
      sendQuery(m.connId, `INSERT INTO ${qualified(m.kind, m.db, m.table)} (${names})\nVALUES (${vals});`);
    } catch (e: any) {
      toast.error(e?.message ?? t("產生 INSERT 失敗"));
    }
  };
  const copyDdl = async (m: TblRef) => {
    try {
      await copyToClipboard(await api.tableDdl(m.connId, m.db, m.table), t("已複製建表 SQL"));
    } catch (e: any) {
      toast.error(e?.message ?? t("取得建表 SQL 失敗"));
    }
  };

  // ---- 資料表 / 集合生命週期（rename / truncate / drop）----
  const renameTable = async (m: TblRef) => {
    const name = await uiPrompt(t("新名稱"), { title: t("重新命名資料表"), defaultValue: m.table });
    if (!name?.trim() || name.trim() === m.table) return;
    try {
      await api.runQuery(m.connId, buildRenameTable(m.kind, m.db, m.table, name.trim()));
      // 舊分頁鍵已失效：關閉並以新名重開，保留原檢視（data / structure）。
      const oldKey = `${m.connId}:${m.db}:${m.table}`;
      const oldTab = useStore.getState().tabs.find((tab) => tab.key === oldKey);
      useStore.getState().closeTableTab(m.connId, m.db, m.table);
      if (oldTab) useStore.getState().openTable(m.connId, m.db, name.trim(), oldTab.view);
      toast.success(t("已重新命名為「{trim}」", { trim: name.trim() }));
      refreshTables(m.connId, m.db);
    } catch (e: any) {
      toast.error(e?.message ?? t("重新命名失敗"));
    }
  };
  // 清空資料表（DELETE 全部列）：可在交易內復原、會觸發 trigger、不重設自增。對標 Navicat「清空資料表」。
  const emptyTable = async (m: TblRef) => {
    const ok = await uiConfirm(t("清空資料表「{table}」的所有資料列（DELETE）？此操作會逐列刪除（觸發 trigger）。", { table: m.table }), {
      title: t("清空資料表"), danger: true, confirmText: t("清空"),
    });
    if (!ok) return;
    try {
      await api.runQuery(m.connId, buildDeleteAllRows(m.kind, m.db, m.table));
      useStore.getState().bumpDataReload(m.connId, m.db, m.table);
      toast.success(t("已清空「{table}」", { table: m.table }));
    } catch (e: any) {
      toast.error(e?.message ?? t("清空失敗"));
    }
  };
  // 截斷資料表（TRUNCATE）：立即清空、無法復原、不觸發 trigger，通常重設自增。對標 Navicat「截斷資料表」。
  const truncateTable = async (m: TblRef) => {
    const ok = await uiConfirm(t("截斷資料表「{table}」（TRUNCATE）？立即清空且無法復原。", { table: m.table }), {
      title: t("截斷資料表"), danger: true, confirmText: t("截斷"),
    });
    if (!ok) return;
    try {
      await api.runQuery(m.connId, buildTruncateTable(m.kind, m.db, m.table));
      // 資料表仍存在（不關分頁）；若該表資料頁開著，強制重載以反映清空。
      useStore.getState().bumpDataReload(m.connId, m.db, m.table);
      toast.success(t("已截斷「{table}」", { table: m.table }));
    } catch (e: any) {
      toast.error(e?.message ?? t("截斷失敗"));
    }
  };
  const dropTable = async (m: TblRef) => {
    const isView = m.objKind === "view";
    const noun = isView ? t("視圖") : t("資料表");
    const ok = await uiConfirm(t("刪除{noun}「{table}」？此動作無法復原。", { noun, table: m.table }), {
      title: t("刪除{noun}", { noun }), danger: true, confirmText: t("刪除"),
    });
    if (!ok) return;
    try {
      const sql = isView ? buildDropView(m.kind, m.db, m.table) : buildDropTable(m.kind, m.db, m.table);
      await api.runQuery(m.connId, sql);
      useStore.getState().closeTableTab(m.connId, m.db, m.table); // 物件消失，連帶關分頁
      toast.success(t("已刪除{noun}「{table}」", { noun, table: m.table }));
      refreshTables(m.connId, m.db);
    } catch (e: any) {
      toast.error(e?.message ?? t("刪除失敗"));
    }
  };
  const dropCollection = async (m: TblRef) => {
    const ok = await uiConfirm(t("刪除集合「{table}」？此動作無法復原。", { table: m.table }), {
      title: t("刪除集合"), danger: true, confirmText: t("刪除"),
    });
    if (!ok) return;
    try {
      await api.dropCollection(m.connId, m.db, m.table);
      useStore.getState().closeTableTab(m.connId, m.db, m.table); // 物件消失，連帶關分頁
      toast.success(t("已刪除集合「{table}」", { table: m.table }));
      refreshTables(m.connId, m.db);
    } catch (e: any) {
      toast.error(e?.message ?? t("刪除失敗"));
    }
  };
  // 複製資料表結構：產生 CREATE TABLE 語句送往查詢編輯器，供使用者檢視後執行（不直接執行 DDL）。
  const duplicateTable = async (m: TblRef, withData = false) => {
    const name = await uiPrompt(withData ? t("複製為新資料表名稱（含資料）") : t("複製為新資料表名稱"), {
      title: withData ? t("複製資料表（含資料）") : t("複製資料表"), defaultValue: `${m.table}_copy`, placeholder: t("新表名"),
    });
    if (!name?.trim()) return;
    const dst = name.trim();
    let sql = buildDuplicateTable(m.kind, m.db, m.table, dst);
    if (withData) sql += "\n" + buildInsertAllRows(m.kind, m.db, m.table, dst);
    sendQuery(m.connId, sql);
  };

  // ---- 資料表維護 / 傾印 / 權限（對標 Navicat 子選單）----
  // 維護（MySQL）：ANALYZE / CHECK / OPTIMIZE / REPAIR，結果以伺服器查詢檢視器顯示。
  const maint = (m: TblRef, op: "ANALYZE" | "CHECK" | "OPTIMIZE" | "REPAIR") =>
    setServerQuery({ connId: m.connId, title: `${op} TABLE：${m.table}`, sql: buildTableMaintenance(op, m.db, m.table) });

  // 傾印 SQL 檔案：結構（table_ddl）；可選含資料（逐頁讀取後組方言感知的字面值 INSERT，上限 MAX 列）。
  const dumpTableSql = async (m: TblRef, withData: boolean) => {
    const path = await pickSaveFile(`${m.table}.sql`, [{ name: "SQL", extensions: ["sql"] }]);
    if (!path) return;
    try {
      let out = (await api.tableDdl(m.connId, m.db, m.table)).trim();
      if (out && !out.endsWith(";")) out += ";";
      out += "\n\n";
      if (withData) {
        const PAGE = 2000, MAX = 100000;
        // 後端把 DateTime<Utc> 顯示為「… UTC」；重載時 MySQL/PG 不接受該字面值，故傾印前剝除
        //（僅比對完整時間戳格式，不會誤傷以 " UTC" 結尾的一般文字）。
        const tsUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? UTC$/;
        // 後端把二進位欄位顯示為截斷的 0x…(N bytes) 或 <unrenderable>，無法在前端還原原始位元組 → 僅警示。
        const binCell = /^0x[0-9a-fA-F]*\.\.\. \(\d+ bytes\)$/;
        const norm = (rows: (string | null)[][]) =>
          rows.map((r) => r.map((v) => (v != null && tsUtc.test(v) ? v.slice(0, -4) : v)));
        let binaryWarn = false;
        const scan = (rows: (string | null)[][]) => {
          for (const r of rows) for (const v of r) if (v != null && (v === "<unrenderable>" || binCell.test(v))) { binaryWarn = true; return; }
        };
        // 先讀第一頁取得欄位 / 主鍵 / 總列數。
        const first = await api.tableData(m.connId, m.db, m.table, { page: 0, page_size: PAGE, filters: [], sorts: [] });
        const cols = first.columns;
        const truncated = first.total_rows > MAX;
        const onePage = first.rows.length < PAGE || first.total_rows <= first.rows.length;
        const pk = first.primary_key ?? [];
        const chunks: string[] = [];
        let total = 0;
        const add = (rows: (string | null)[][]) => {
          const room = MAX - total;
          if (room <= 0 || rows.length === 0) return;
          const take = rows.slice(0, room);
          scan(take);
          chunks.push(buildInsertValues(m.kind, m.db, m.table, cols, norm(take)));
          total += take.length;
        };
        if (onePage) {
          add(first.rows);
        } else {
          // 跨頁 OFFSET 分頁需穩定排序，否則可能漏列 / 重複。有主鍵則以主鍵排序，
          // 無主鍵則以全部欄位排序，皆自第 0 頁以該排序重抓，確保各頁順序一致。
          const sorts = (pk.length ? pk : cols).map((c) => ({ column: c, dir: "asc" as const }));
          let page = 0;
          while (total < MAX) {
            const pd = await api.tableData(m.connId, m.db, m.table, { page, page_size: PAGE, filters: [], sorts });
            add(pd.rows);
            if (pd.rows.length < PAGE) break;
            page += 1;
          }
        }
        out += chunks.length ? chunks.join("\n") + "\n" : t("-- （無資料）") + "\n";
        if (truncated) toast.info(t("資料超過 {MAX} 列，僅傾印前 {v2} 列", { MAX, v2: MAX }));
        if (binaryWarn) toast.info(t("含二進位欄位，傾印的二進位值不完整；建議用「備份」做位元組精確匯出。"));
      }
      await api.saveTextFile(path, out);
      toast.success(t("已傾印 SQL（{mode}）", { mode: withData ? t("結構與資料") : t("結構") }));
    } catch (e: any) {
      toast.error(e?.message ?? t("傾印失敗"));
    }
  };

  // 設定權限：產生 GRANT / REVOKE 範本到查詢編輯器（MySQL / PostgreSQL）。
  const genGrant = (m: TblRef) => {
    if (!isMysqlFamily(m.kind) && m.kind !== "postgres") return;
    sendQuery(m.connId, buildGrantTemplate(m.kind, m.db, m.table));
  };

  // 問 AI：選取該資料表（讓助手附帶其 schema），並把問題帶進助手輸入框。
  const askAiTable = (
    m: { connId: string; db: string; table: string; kind: DbKind; objKind: string },
    prompt: string,
  ) => {
    useStore.getState().selectNode({ type: "table", connId: m.connId, db: m.db, table: m.table, kind: m.kind, objKind: m.objKind });
    useAssistant.getState().ask(prompt);
  };

  // 右鍵 Data View →「查詢 log」：選取節點（讓 NlQueryBar 的 buildEsNlPrompt 以此為目標索引）、
  // 開一個新查詢分頁，並請該分頁掛載後自動展開既有的 NlQueryBar（不新增任何 prompt 邏輯，
  // 完整複用 src/NlQueryBar.tsx + src/nlPrompt.ts::buildEsNlPrompt，已支援一鍵「套用到編輯器」）。
  const onQueryLog = (dataView: { connId: string; db: string; table: string; kind: DbKind; objKind: string }) => {
    useStore.getState().selectNode({
      type: "table", connId: dataView.connId, db: dataView.db,
      table: dataView.table, kind: dataView.kind, objKind: dataView.objKind,
    });
    useStore.getState().requestNlAutoOpen();
    useStore.getState().newQueryTab(undefined, dataView.connId);
  };

  // 依物件種類組出資料表右鍵選單樹（item / 分隔線 / 子選單）；交由 <MenuItems> 遞迴渲染。
  // 物件資料夾（資料表 / 檢視 / 函式 / 查詢）右鍵選單：一律提供「新增查詢」（開該資料庫的空白查詢），
  // 並依資料夾種類附上對應的新增動作，末端加「重新整理」重載清單。
  const folderMenuNodes = (m: NonNullable<typeof folderMenu>): MenuNode[] => {
    const it = (label: string, onClick: () => void, danger?: boolean): MenuNode => ({ kind: "item", label, onClick, danger });
    const sep: MenuNode = { kind: "sep" };
    const ro = readonlyConns[m.connId] === true;
    const nodes: MenuNode[] = [it(t("新增查詢"), () => newQueryForDb(m.connId, m.db, m.kind))];
    if (m.type === "tables" && !ro)
      nodes.push(it(t("新增資料表…"), () => setDesignTable({ connId: m.connId, db: m.db, kind: m.kind })));
    if (m.type === "views")
      nodes.push(it(t("新增視圖…"), () => setCreateView({ connId: m.connId, db: m.db, kind: m.kind })));
    if (m.type === "functions" && (isMysqlFamily(m.kind) || m.kind === "postgres" || m.kind === "external"))
      nodes.push(it(t("預存程序 / 觸發器…"), () => setRoutines({ connId: m.connId, db: m.db, kind: m.kind })));
    nodes.push(sep);
    nodes.push(it(t("重新整理"), () => refreshTables(m.connId, m.db)));
    return nodes;
  };

  const tableMenuNodes = (m: NonNullable<typeof tableMenu>): MenuNode[] => {
    const it = (label: string, onClick: () => void, danger?: boolean): MenuNode => ({ kind: "item", label, onClick, danger });
    const sep: MenuNode = { kind: "sep" };
    if (m.kind === "mongo") {
      return [
        it(t("開啟集合"), () => useStore.getState().openTable(m.connId, m.db, m.table)),
        it(t("屬性…"), () => setTableProps({ connId: m.connId, db: m.db, table: m.table, kind: m.kind, objKind: m.objKind })),
        sep,
        it(t("查詢此集合（find）"), () => genMongoFind(m)),
        it(t("聚合範本（aggregate）"), () => genMongoAggregate(m)),
        it(t("插入範本（insert）"), () => genMongoInsert(m)),
        it(t("複製集合名"), () => copyToClipboard(m.table, t("已複製集合名"))),
        sep,
        it(t("問 AI：解釋這個集合"), () => askAiTable(m, t("請解釋 MongoDB 集合 {db}.{table} 的用途與常見欄位結構。", { db: m.db, table: m.table }))),
        sep,
        it(t("重新整理"), () => refreshTables(m.connId, m.db)),
        it(t("刪除集合"), () => dropCollection(m), true),
      ];
    }
    if (m.kind === "kafka") {
      const ro = readonlyConns[m.connId] === true;
      const nodes: MenuNode[] = [
        it(t("瀏覽訊息"), () => useStore.getState().openTable(m.connId, m.db, m.table, "data", m.objKind)),
        it(t("主題設定 / 分區"), () => useStore.getState().openTable(m.connId, m.db, m.table, "structure", m.objKind)),
        it(t("複製主題名"), () => copyToClipboard(m.table, t("已複製主題名"))),
        it(t("重新整理"), () => refreshTables(m.connId, m.db)),
      ];
      if (!ro && !isInternalKafkaTopic(m.table)) {
        nodes.push(sep);
        nodes.push(it(t("清空主題…"), async () => {
          // 雙重確認：danger confirm + 輸入主題名。清空保留主題與設定；compacted 主題 broker 會拒絕。
          if (!(await uiConfirm(
            t("將刪除主題「{name}」所有分區中的全部訊息（保留主題與設定）。已提交位移低於新起點的消費者群組，將依其 auto.offset.reset 跳位。此操作不可復原。", { name: m.table }),
            { danger: true, confirmText: t("繼續") },
          ))) return;
          const typed = await uiPrompt(t("請輸入主題名稱以確認清空"), { placeholder: m.table });
          if (typed === null) return;
          if (typed !== m.table) {
            toast.error(t("輸入的主題名稱不符，已取消"));
            return;
          }
          try {
            const rs = await api.kafkaDeleteRecords(m.connId, m.table, null, null);
            const failed = rs.filter((r) => r.error);
            if (failed.length) toast.error(t("部分分區清空失敗：{detail}", { detail: failed.map((r) => `#${r.partition} ${r.error}`).join("; ") }));
            else toast.success(t("已清空主題 {name}（{n} 個分區）", { name: m.table, n: rs.length }));
          } catch (e: any) {
            toast.error(e?.message ?? t("清空失敗"));
          }
        }, true));
        nodes.push(it(t("刪除主題"), async () => {
          if (!(await uiConfirm(t("確定刪除主題「{name}」？此操作不可復原。", { name: m.table })))) return;
          try {
            await api.kafkaDeleteTopic(m.connId, m.table);
            toast.success(t("已刪除主題 {name}", { name: m.table }));
            refreshTables(m.connId, m.db);
          } catch (e: any) {
            toast.error(e?.message ?? t("刪除失敗"));
          }
        }, true));
      }
      return nodes;
    }
    if (m.kind === "elastic") {
      if (m.objKind === "data_view") {
        // Data View（分組後的 data stream）：與單一索引選單完全分開——
        // 真正的 data stream 不合法用 DELETE /{index} 刪除（須走未串接的 _data_stream API），
        // 故刻意不提供「刪除」；其餘動作複用單一索引既有的處理函式，僅替換文案。
        return [
          it(t("查詢 log"), () => onQueryLog(m)),
          sep,
          it(t("開啟 Data View"), () => useStore.getState().openTable(m.connId, m.db, m.table, "data", m.objKind)),
          it(t("檢視 Mapping…"), () => setEsMapping({ connId: m.connId, index: m.table })),
          it(t("複製 Data View 名稱"), () => copyToClipboard(m.table, t("已複製 Data View 名稱"))),
          it(t("重新整理"), () => refreshTables(m.connId, m.db)),
        ];
      }
      const ro = readonlyConns[m.connId] === true;
      const nodes: MenuNode[] = [
        it(t("開啟索引"), () => useStore.getState().openTable(m.connId, m.db, m.table, "data", m.objKind)),
        it(t("檢視 Mapping…"), () => setEsMapping({ connId: m.connId, index: m.table })),
        it(t("複製索引名"), () => copyToClipboard(m.table, t("已複製索引名"))),
        it(t("重新整理"), () => refreshTables(m.connId, m.db)),
      ];
      if (!ro) {
        nodes.push(sep);
        nodes.push(it(t("刪除索引…"), async () => {
          if (!(await uiConfirm(
            t("確定刪除索引「{name}」？此操作不可復原。", { name: m.table }),
            { title: t("刪除索引"), danger: true, confirmText: t("刪除") },
          ))) return;
          try {
            await api.esDeleteIndex(m.connId, m.table);
            toast.success(t("已刪除索引 {name}", { name: m.table }));
            refreshTables(m.connId, m.db);
          } catch (e: any) {
            toast.error(e?.message ?? t("刪除失敗"));
          }
        }, true));
      }
      return nodes;
    }
    if (m.kind === "rabbitmq") {
      const ro = readonlyConns[m.connId] === true;
      const nodes: MenuNode[] = [
        it(t("瀏覽訊息"), () => useStore.getState().openTable(m.connId, m.db, m.table, "data", m.objKind)),
        it(t("佇列詳情"), () => useStore.getState().openTable(m.connId, m.db, m.table, "structure", m.objKind)),
        it(t("複製佇列名"), () => copyToClipboard(m.table, t("已複製佇列名"))),
        it(t("重新整理"), () => refreshTables(m.connId, m.db)),
      ];
      if (!ro) {
        nodes.splice(2, 0, it(t("發布到此佇列…"), () => setRabbitPublish({ connId: m.connId, routingKey: m.table })));
        nodes.push(sep);
        nodes.push(it(t("清空佇列…"), async () => {
          // 雙重確認：danger confirm + 輸入佇列名。清空保留佇列本身。
          if (!(await uiConfirm(
            t("將刪除佇列「{name}」中的全部訊息（保留佇列本身）。此操作不可復原。", { name: m.table }),
            { danger: true, confirmText: t("繼續") },
          ))) return;
          const typed = await uiPrompt(t("請輸入佇列名稱以確認清空"), { placeholder: m.table });
          if (typed === null) return;
          if (typed !== m.table) {
            toast.error(t("輸入的佇列名稱不符，已取消"));
            return;
          }
          try {
            await api.rabbitmqPurge(m.connId, m.table);
            toast.success(t("已清空佇列 {name}", { name: m.table }));
            refreshTables(m.connId, m.db);
          } catch (e: any) {
            toast.error(e?.message ?? t("清空失敗"));
          }
        }, true));
        nodes.push(it(t("刪除佇列…"), async () => {
          if (!(await uiConfirm(
            t("確定刪除佇列「{name}」？此操作不可復原。", { name: m.table }),
            { title: t("刪除佇列"), danger: true, confirmText: t("刪除") },
          ))) return;
          try {
            await api.rabbitmqDeleteQueue(m.connId, m.table);
            toast.success(t("已刪除佇列 {name}", { name: m.table }));
            refreshTables(m.connId, m.db);
          } catch (e: any) {
            toast.error(e?.message ?? t("刪除失敗"));
          }
        }, true));
      }
      return nodes;
    }
    const isView = m.objKind === "view";
    const isMyPg = isMysqlFamily(m.kind) || m.kind === "postgres";
    // 唯讀連線：隱藏會寫入 / 破壞資料的動作（新增列 / 匯入 / 產生資料 / 改名 / 複製含資料 / 清空 / 截斷 / 刪除）。
    const ro = readonlyConns[m.connId] === true;
    const nodes: MenuNode[] = [];
    // 開啟 / 設計
    nodes.push(it(isView ? t("開啟視圖") : t("開啟資料表"), () => useStore.getState().openTable(m.connId, m.db, m.table, "data", m.objKind)));
    nodes.push(it(isPinned(pins, m) ? t("取消釘選") : t("釘選到常用"), () => togglePinned({ connId: m.connId, db: m.db, table: m.table, kind: m.objKind ?? "table" })));
    nodes.push(it(t("屬性…"), () => setTableProps({ connId: m.connId, db: m.db, table: m.table, kind: m.kind, objKind: m.objKind })));
    if (!isView) {
      nodes.push(it(t("設計資料表"), () => useStore.getState().openTable(m.connId, m.db, m.table, "structure")));
      if (!ro) nodes.push(it(t("新增資料表…"), () => setDesignTable({ connId: m.connId, db: m.db, kind: m.kind })));
      if (!ro) nodes.push(it(t("新增資料列…"), () => {
        useStore.getState().openTable(m.connId, m.db, m.table);
        useStore.getState().requestInsert(`${m.connId}:${m.db}:${m.table}`);
      }));
    }
    // 設計檢視：載入 SELECT 定義編輯後 CREATE OR REPLACE。僅 MySQL / PG。
    if (isView && isMyPg) nodes.push(it(t("設計檢視…"), () => setViewDesign({ connId: m.connId, db: m.db, view: m.table, kind: m.kind })));
    if (isView) nodes.push(it(t("新增檢視…"), () => setCreateView({ connId: m.connId, db: m.db, kind: m.kind })));
    // 查詢產生
    nodes.push(sep);
    nodes.push(it(t("查詢前 100 筆"), () => genSelect(m)));
    nodes.push(it(t("查詢前 100 筆（明列欄位）"), () => genSelectColumns(m)));
    nodes.push(it("SELECT COUNT(*)", () => genCount(m)));
    nodes.push(it(t("產生 INSERT 範本"), () => genInsert(m)));
    nodes.push(it(t("複製建表 SQL"), () => copyDdl(m)));
    nodes.push(it(t("複製表名"), () => copyToClipboard(m.table, t("已複製表名"))));
    // 問 AI（帶入此表 schema）
    nodes.push({
      kind: "sub", label: t("問 AI"), children: [
        it(t("解釋這張表"), () => askAiTable(m, t("請解釋資料表 {db}.{table} 的用途，以及每個欄位代表什麼。", { db: m.db, table: m.table }))),
        it(t("寫常用查詢"), () => askAiTable(m, t("針對資料表 {db}.{table}，寫出 5 個實用的 SQL 查詢，每個都加上中文註解說明用途。", { db: m.db, table: m.table }))),
        it(t("最佳化建議"), () => askAiTable(m, t("檢視資料表 {db}.{table} 的結構與索引，給我效能與設計上的最佳化建議。", { db: m.db, table: m.table }))),
      ],
    });
    // 匯入 / 匯出 / 傾印 / 文件 / 資料產生
    nodes.push(sep);
    if (!isView && !ro) nodes.push(it(t("匯入精靈…"), () => setImportTbl({ connId: m.connId, db: m.db, table: m.table })));
    nodes.push(it(t("匯出精靈…"), () => setExportTbl({ connId: m.connId, db: m.db, table: m.table })));
    if (isMysqlFamily(m.kind) || m.kind === "postgres" || m.kind === "sqlite")
      nodes.push(it(t("查詢建構器…"), () => setBuilderTbl({ connId: m.connId, db: m.db, table: m.table, kind: m.kind })));
    if (!isView && (isMysqlFamily(m.kind) || m.kind === "postgres" || m.kind === "sqlite"))
      nodes.push(it(t("資料傳輸…"), () => setTransferTbl({ connId: m.connId, db: m.db, table: m.table })));
    if (!isView && (isMysqlFamily(m.kind) || m.kind === "postgres" || m.kind === "sqlite"))
      nodes.push(it(t("資料比對 / 同步…"), () => setSyncTbl({ connId: m.connId, db: m.db, table: m.table })));
    nodes.push({
      kind: "sub", label: t("傾印 SQL 檔案"), children: [
        it(t("結構"), () => dumpTableSql(m, false)),
        ...(!isView ? [it(t("結構與資料"), () => dumpTableSql(m, true))] : []),
      ],
    });
    nodes.push(it(t("資料字典…"), () => setDataDict({ connId: m.connId, db: m.db, table: m.table, kind: m.kind })));
    if (!isView && !ro) nodes.push(it(t("資料產生…"), () => setDataGen({ connId: m.connId, db: m.db, table: m.table, kind: m.kind })));
    // 維護 / 權限 / 模型
    const tail: MenuNode[] = [];
    if (!isView && isMysqlFamily(m.kind)) {
      tail.push({
        kind: "sub", label: t("維護"), children: [
          it(t("分析資料表 (ANALYZE)"), () => maint(m, "ANALYZE")),
          it(t("檢查資料表 (CHECK)"), () => maint(m, "CHECK")),
          it(t("最佳化資料表 (OPTIMIZE)"), () => maint(m, "OPTIMIZE")),
          it(t("修復資料表 (REPAIR)"), () => maint(m, "REPAIR")),
        ],
      });
    }
    if (isMyPg) tail.push(it(t("設定權限…"), () => genGrant(m)));
    // 逆向至模型：關聯式（MySQL 系 / PG / SQLite）皆有外鍵關係可視化。
    if (isMysqlFamily(m.kind) || m.kind === "postgres" || m.kind === "sqlite")
      tail.push(it(t("逆向至模型…"), () => setErTable({ connId: m.connId, db: m.db, table: m.table })));
    if (tail.length) { nodes.push(sep); nodes.push(...tail); }
    // 生命週期（唯讀連線全部隱藏，避免破壞資料 / 結構）
    if (!ro) {
      nodes.push(sep);
      // 視圖改名：PG 容許 ALTER … RENAME；MySQL/SQLite 不支援 view 改名，隱藏以免必定失敗。
      if (!isView || m.kind === "postgres") nodes.push(it(t("重新命名…"), () => renameTable(m)));
      if (!isView) nodes.push({
        kind: "sub", label: t("複製資料表"), children: [
          it(t("結構…"), () => duplicateTable(m)),
          it(t("含資料…"), () => duplicateTable(m, true)),
        ],
      });
      if (!isView) nodes.push(it(t("清空資料表（DELETE）"), () => emptyTable(m), true));
      if (!isView) nodes.push(it(t("截斷資料表（TRUNCATE）"), () => truncateTable(m), true));
      nodes.push(it(isView ? t("刪除視圖") : t("刪除資料表"), () => dropTable(m), true));
    }
    // 重新整理
    nodes.push(sep);
    nodes.push(it(t("重新整理"), () => refreshTables(m.connId, m.db)));
    return nodes;
  };

  // 刪除函式 / 預存程序（樹節點右鍵）。
  const dropRoutine = async (connId: string, db: string, kind: DbKind, r: RoutineInfo) => {
    const label = r.routine_type === "procedure" ? t("預存程序") : t("函式");
    const ok = await uiConfirm(t("刪除{label}「{name}」？此動作無法復原。", { label, name: r.name }), { title: t("刪除{label}", { label }), danger: true, confirmText: t("刪除") });
    if (!ok) return;
    try {
      await api.execDdl(connId, buildDropRoutine(kind, db, r));
      toast.success(t("已刪除{label}「{name}」", { label, name: r.name }));
      refreshTables(connId, db);
    } catch (e: any) {
      toast.error(e?.message ?? t("刪除失敗"));
    }
  };
  // 複製函式 / 預存程序的建立 SQL（讀取定義後置入剪貼簿）。
  const copyRoutineDdl = async (connId: string, db: string, r: RoutineInfo) => {
    try {
      await copyToClipboard(await api.routineDefinition(connId, db, r.name, r.routine_type), t("已複製建立 SQL"));
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取定義失敗"));
    }
  };
  // 組函式 / 預存程序右鍵選單樹（對標 Navicat：設計 / 執行 / 新增 / 複製 / 刪除）。
  const routineMenuNodes = (m: NonNullable<typeof routineMenu>): MenuNode[] => {
    const it = (label: string, onClick: () => void, danger?: boolean): MenuNode => ({ kind: "item", label, onClick, danger });
    const sep: MenuNode = { kind: "sep" };
    const r = m.routine;
    const label = r.routine_type === "procedure" ? t("程序") : t("函式");
    // external（gateway）連線為唯讀：不提供新增 / 刪除（按了必被後端擋下）。
    const ro = m.kind === "external" || readonlyConns[m.connId] === true;
    return [
      it(t("設計{label}", { label }), () => setRoutines({ connId: m.connId, db: m.db, kind: m.kind, initial: r })),
      it(t("執行{label}…", { label }), () => setRoutines({ connId: m.connId, db: m.db, kind: m.kind, initial: r, initialAction: "exec" })),
      ...(ro ? [] : [
        sep,
        it(t("新增函式…"), () => setRoutines({ connId: m.connId, db: m.db, kind: m.kind, newType: "function" })),
        it(t("新增程序…"), () => setRoutines({ connId: m.connId, db: m.db, kind: m.kind, newType: "procedure" })),
      ]),
      sep,
      it(t("複製名稱"), () => copyToClipboard(r.name, t("已複製名稱"))),
      it(t("複製建立 SQL"), () => copyRoutineDdl(m.connId, m.db, r)),
      ...(ro ? [] : [
        sep,
        it(t("刪除{label}…", { label }), () => dropRoutine(m.connId, m.db, m.kind, r), true),
      ]),
      sep,
      it(t("重新整理"), () => refreshTables(m.connId, m.db)),
    ];
  };

  const menuConn = menu ? connections.find((x) => x.id === menu.id) ?? null : null;

  // 搜尋過濾：連線依名稱、物件依名稱；搜尋物件名也會讓其所屬連線浮現。
  const q = filter.trim().toLowerCase();
  const objNames = (o: DbObjects) =>
    [...o.tables, ...o.views].map((x) => x.name).concat(o.routines.map((r) => r.name));
  const connTableMatches = (connId: string) =>
    Object.entries(expandedDbs).some(
      ([k, o]) => k.startsWith(`${connId}:`) && objNames(o).some((n) => n.toLowerCase().includes(q))
    );
  const connVisible = (c: ConnectionConfig) =>
    !q || c.name.toLowerCase().includes(q) || connTableMatches(c.id);
  const tableVisible = (connName: string, tName: string) =>
    !q || connName.toLowerCase().includes(q) || tName.toLowerCase().includes(q);
  const visibleConns = connections.filter(connVisible);
  // 跨庫搜尋 / 全資料庫搜尋的目標連線：目前 active 且已連線者，否則第一個已連線者。
  const searchTarget =
    connections.find((c) => c.id === activeId && connectedIds.has(c.id)) ??
    connections.find((c) => connectedIds.has(c.id)) ?? null;

  return (
    <div style={{ width }} className="shrink-0 bg-panel overflow-y-auto text-sm flex flex-col">
      {connections.length > 0 && (
        <div className="sticky top-0 z-10 bg-panel p-2 border-b border-fg/10">
          <div className="relative">
            <Icon icon={Search} size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg/35" />
            <input
              ref={filterRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { if (filter) setFilter(""); else filterRef.current?.blur(); }
              }}
              placeholder={t("搜尋連線 / 表…")}
              title={t("搜尋連線或表名稱（Ctrl+F 或 /）")}
              className="w-full bg-inset border border-fg/10 rounded pl-7 pr-6 py-1 text-xs outline-none focus:border-accent"
            />
            {filter && (
              <button type="button" onClick={() => setFilter("")} title={t("清除")}
                className="absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded text-fg/30 hover:text-fg/70 hover:bg-fg/10">
                <Icon icon={X} size={12} />
              </button>
            )}
          </div>
          {connectedIds.size > 1 && (
            <div className="flex justify-end mt-1">
              <button type="button" onClick={() => { connections.filter((c) => connectedIds.has(c.id)).forEach((c) => doDisconnect(c.id)); }}
                title={t("中斷所有已連線的連線")}
                className="text-[11px] text-fg/40 hover:text-fg/70 inline-flex items-center gap-1">
                <Icon icon={Plug} size={11} />{t("全部中斷（")}{connectedIds.size}）
              </button>
            </div>
          )}
        </div>
      )}
      {q.length >= 2 && searchTarget && (searchBusy || searchHits !== null) && (() => {
        // 跨資料庫表名搜尋結果（含尚未展開的庫），依資料庫分組。點擊 → 開表 + 樹中展開定位。
        const hits = searchHits ?? [];
        const groups: [string, SearchHit[]][] = [];
        const idx = new Map<string, SearchHit[]>();
        for (const h of hits) {
          let arr = idx.get(h.database);
          if (!arr) { arr = []; idx.set(h.database, arr); groups.push([h.database, arr]); }
          arr.push(h);
        }
        const capped = hits.length >= 200;
        return (
          <div className="border-b border-fg/10 py-1">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-fg/35 flex items-center gap-1">
              <Icon icon={Search} size={11} className="text-sky-300/80" />
              <span>{t("跨庫表名")}{hits.length > 0 ? `（${hits.length}${capped ? "+" : ""}）` : ""}</span>
              {searchBusy && <Icon icon={Loader2} size={11} className="animate-spin ml-auto text-fg/40" />}
            </div>
            {!searchBusy && hits.length === 0 && (
              <div className="px-3 py-1 text-[11px] text-fg/30">{t("查無符合的表")}</div>
            )}
            {groups.map(([db, ghits]) => (
              <div key={db}>
                <div className="px-3 py-0.5 text-[10px] text-fg/40 flex items-center gap-1">
                  <Icon icon={Database} size={10} className="shrink-0" />
                  <span className="truncate flex-1">{db}</span>
                  <span className="text-fg/25 tabular-nums">{ghits.length}</span>
                </div>
                {ghits.map((h) => (
                  <div key={`${db}:${h.object_type}:${h.object_name}`}
                    className="flex items-center gap-1.5 pl-6 pr-3 py-1 cursor-pointer hover:bg-fg/5"
                    onClick={() => {
                      setActive(searchTarget.id);
                      selectNode({ type: "table", connId: searchTarget.id, db, table: h.object_name, kind: searchTarget.kind, objKind: h.object_type });
                      useStore.getState().openTable(searchTarget.id, db, h.object_name, "data", h.object_type as TableInfo["kind"]);
                      void ensureDbExpanded(searchTarget.id, db);
                    }}
                    title={t("{name} · {db} · {object_name}（點擊開啟並在樹中定位）", { name: searchTarget.name, db, object_name: h.object_name })}>
                    <Icon icon={h.object_type === "view" ? Eye : Table2} size={12}
                      className={`shrink-0 ${h.object_type === "view" ? "text-purple-300/80" : "text-sky-300/70"}`} />
                    <span className="truncate">{h.object_name}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      })()}
      {(() => {
        // ★ 常用：釘選的資料表（跨連線）。依搜尋字過濾、只顯示連線仍存在者。
        const visiblePins = pins.filter((p) =>
          connections.some((c) => c.id === p.connId) && (!q || p.table.toLowerCase().includes(q) || p.db.toLowerCase().includes(q)),
        );
        if (visiblePins.length === 0) return null;
        return (
          <div className="border-b border-fg/10 py-1">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-fg/35 flex items-center gap-1">
              <Icon icon={Star} size={11} className="text-amber-300" />{t("常用")}
            </div>
            {visiblePins.map((p) => {
              const cn = connections.find((c) => c.id === p.connId)?.name ?? "";
              return (
                <div key={`${p.connId} ${p.db} ${p.table}`}
                  className="group flex items-center gap-1.5 px-3 py-1 cursor-pointer hover:bg-fg/5"
                  onClick={() => { setActive(p.connId); useStore.getState().openTable(p.connId, p.db, p.table, "data", p.kind); }}
                  title={`${cn} · ${p.db} · ${p.table}`}>
                  <Icon icon={p.kind === "view" ? Eye : Table2} size={12} className="text-fg/30 shrink-0" />
                  <span className="truncate flex-1">{p.table}</span>
                  <span className="text-[10px] text-fg/30 truncate max-w-[90px]">{p.db}</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); togglePinned(p); }} title={t("取消釘選")} aria-label={t("取消釘選")}
                    className="w-4 h-4 shrink-0 items-center justify-center rounded text-fg/30 hover:text-amber-300 hidden group-hover:flex">
                    <Icon icon={X} size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        );
      })()}
      {connections.length === 0 && (
        <div className="p-4 text-fg/30 text-xs leading-relaxed">
          {t("尚無連線。點上方「連線」新增一個，雙擊以建立連線（右鍵有更多選項）。")}
        </div>
      )}
      {q && visibleConns.length === 0 && !searchBusy && !(searchHits && searchHits.length > 0) && (
        <div className="p-4 text-xs text-fg/40 space-y-2">
          <div>{t("查無符合「{filter}」的連線或表。", { filter })}</div>
          {searchTarget ? (
            <Button variant="secondary" size="sm" icon={Search}
              onClick={() => setSearchObjs({ connId: searchTarget.id, kind: searchTarget.kind })}>
              {t("全資料庫搜尋（含定義 / 註解）…")}
            </Button>
          ) : (
            <div className="text-fg/30">{t("連線後即可搜尋全部資料庫的表名。")}</div>
          )}
        </div>
      )}
      {visibleConns.map((c) => {
        const meta = KIND_META[c.kind];
        const connected = connectedIds.has(c.id);
        const busy = connecting.has(c.id);
        return (
          <div key={c.id}>
            <div
              onClick={() => { setActive(c.id); selectNode({ type: "connection", connId: c.id }); }}
              onDoubleClick={() => toggleConnect(c.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setActive(c.id);
                selectNode({ type: "connection", connId: c.id });
                setMenu({ id: c.id, x: e.clientX, y: e.clientY });
              }}
              style={connColors[c.id] ? { boxShadow: `inset 3px 0 0 ${connColors[c.id]}` } : undefined}
              className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer ${
                activeId === c.id ? "relative bg-accent/12 before:content-[''] before:absolute before:left-0 before:inset-y-0 before:w-[2px] before:bg-accent" : "hover:bg-fg/5"
              }`}
            >
              {busy ? (
                <span className="w-3.5 h-3.5 shrink-0 grid place-items-center">
                  <Icon icon={Loader2} size={14} className="text-fg/50 animate-spin" />
                </span>
              ) : (
                // 依資料庫類型顯示圖示（取代原狀態圓點）：已連線=亮色（kind 色）、未連線=灰暗。
                <span
                  className={`shrink-0 flex ${connected ? "" : "text-fg/35"}`}
                  style={connected ? { color: meta.color } : undefined}
                  title={connected ? `${meta.label}${t(" · 已連線")}` : `${meta.label}${t(" · 未連線")}`}
                >
                  <Icon icon={kindIcon(c.kind)} size={14} />
                </span>
              )}
              <span className="truncate flex-1" title={`${c.name} · ${KIND_META[c.kind].label} · ${c.host}:${c.port}`}>{c.name}</span>
              {readonlyConns[c.id] && <span className="shrink-0 text-[9px] px-1 rounded bg-amber-400/20 text-amber-300/90" title={t("唯讀模式：擋寫入 / DDL 與資料格編輯")}>{t("唯讀")}</span>}
              <button type="button" title={t("編輯連線")}
                onClick={(e) => { e.stopPropagation(); onEdit(c); }}
                className="w-5 h-5 shrink-0 items-center justify-center rounded text-fg/40 hover:bg-fg/15 hover:text-fg/80 hidden group-hover:flex">
                <Icon icon={Pencil} size={13} />
              </button>
              <button type="button" title={t("刪除連線")}
                onClick={(e) => { e.stopPropagation(); deleteConn(c.id, c.name); }}
                className="w-5 h-5 shrink-0 items-center justify-center rounded text-fg/40 hover:bg-fg/15 hover:text-red-300 hidden group-hover:flex">
                <Icon icon={Trash2} size={13} />
              </button>
            </div>
            {connected && databases[c.id] && databases[c.id].length === 0 && (
              <div className="pl-7 pr-3 py-1 text-fg/25 text-xs">{t("（無資料庫）")}</div>
            )}
            {connected &&
              (databases[c.id] ?? []).map((db) => {
                const dbKey = `${c.id}:${db}`;
                const objs = expandedDbs[dbKey];
                const loading = loadingDbs.has(dbKey);
                const isRedis = c.kind === "redis";
                // external（gateway）走 SQL 分支：用資料夾 + 每庫篩選框（適合大量表），右鍵亦可新增查詢。
                const isSqlKind = isMysqlFamily(c.kind) || c.kind === "postgres" || c.kind === "sqlite" || c.kind === "external" || c.kind === "mssql" || c.kind === "oracle";
                const canRoutines = supportsRoutines(c.kind);

                // 樹中的單一資料表 / 視圖節點（沿用選取 / 雙擊開啟 / 右鍵產生 SQL）。indent 控制縮排深度。
                const objNode = (obj: TableInfo, indent: string) => (
                  <div
                    key={`${obj.kind}:${obj.name}`}
                    data-tree-conn={c.id}
                    data-tree-db={db}
                    data-tree-table={obj.name}
                    onClick={() => {
                      setActive(c.id);
                      selectNode({ type: "table", connId: c.id, db, table: obj.name, kind: c.kind, objKind: obj.kind });
                      // 單擊即開啟資料分頁（openTable 會去重：已開的表只切換、不重複開）。
                      useStore.getState().openTable(c.id, db, obj.name, "data", obj.kind);
                    }}
                    onContextMenu={
                      c.kind !== "redis"
                        ? (e) => {
                            e.preventDefault();
                            setActive(c.id);
                            selectNode({ type: "table", connId: c.id, db, table: obj.name, kind: c.kind, objKind: obj.kind });
                            setTableMenu({ connId: c.id, db, table: obj.name, kind: c.kind, objKind: obj.kind, x: e.clientX, y: e.clientY });
                          }
                        : undefined
                    }
                    className={`${indent} pr-3 py-1.5 text-fg/55 cursor-pointer truncate flex items-center gap-1.5 ${
                      selectedNode?.type === "table" && selectedNode.connId === c.id &&
                      selectedNode.db === db && selectedNode.table === obj.name
                        ? "relative bg-accent/12 before:content-[''] before:absolute before:left-0 before:inset-y-0 before:w-[2px] before:bg-accent" : "hover:bg-fg/5"
                    }`}
                    title={t("單擊開啟資料；右鍵可產生 SELECT / 更多動作")}
                  >
                    <Icon icon={obj.kind === "view" ? Eye : obj.kind === "data_view" ? Layers : Table2} size={14}
                      className={`shrink-0 ${
                        obj.kind === "view" ? "text-purple-300/80" : obj.kind === "data_view" ? "text-teal-300/80" : "text-sky-300/70"
                      }`} />
                    <span className="truncate">{obj.name}</span>
                  </div>
                );

                // 樹中的單一函式 / 預存程序節點（雙擊開定義編輯器；圖示 + tooltip 區分種類）。
                const routineNode = (r: RoutineInfo) => {
                  const isProc = r.routine_type === "procedure";
                  return (
                    <div
                      key={`${r.routine_type}:${r.name}:${r.signature ?? ""}`}
                      onDoubleClick={() => setRoutines({ connId: c.id, db, kind: c.kind, initial: r })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setActive(c.id);
                        setRoutineMenu({ connId: c.id, db, kind: c.kind, routine: r, x: e.clientX, y: e.clientY });
                      }}
                      className="pl-16 pr-3 py-1 text-fg/55 hover:bg-fg/5 cursor-pointer truncate flex items-center gap-1.5"
                      title={t("{type}「{name}」（雙擊設計 / 編輯；右鍵更多）", { type: isProc ? t("預存程序") : t("函式"), name: r.name })}
                    >
                      <Icon icon={isProc ? Cog : FunctionSquare} size={14}
                        className={`shrink-0 ${isProc ? "text-amber-300/90" : "text-emerald-300/80"}`} />
                      <span className="truncate">{r.name}</span>
                    </div>
                  );
                };

                // 物件分組資料夾（資料表 / 檢視 / 函式）。收藏查詢已移至側欄頂層「收藏查詢」區。
                const folderNode = (type: string, glyphIcon: LucideIcon, color: string, label: string, count: number, body: ReactNode) => {
                  // 搜尋/篩選命中時自動展開：使用者手動/預設展開，或（全域搜尋或本庫篩選中且此資料夾有命中）。
                  // 清除搜尋後 filtering=false，open 回落到手動/預設狀態，不寫入 folderOpen、不殘留。
                  const filtering = !!q || !!(dbFilter[dbKey] ?? "").trim();
                  const open = isFolderOpen(dbKey, type) || (filtering && count > 0);
                  return (
                    <div key={type}>
                      <div
                        onClick={() => toggleFolder(dbKey, type)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setActive(c.id);
                          setFolderMenu({ connId: c.id, db, kind: c.kind, type, x: e.clientX, y: e.clientY });
                        }}
                        className="pl-11 pr-3 py-1.5 hover:bg-fg/5 cursor-pointer flex items-center gap-1.5 select-none"
                      >
                        <Icon icon={ChevronRight} size={13} className={`shrink-0 text-fg/35 transition-transform ${open ? "rotate-90" : ""}`} />
                        <Icon icon={glyphIcon} size={14} className={`shrink-0 ${color}`} />
                        <span className="text-fg/70 truncate flex-1">{label}</span>
                        <span className="text-fg/30 text-[11px] tabular-nums">{count}</span>
                      </div>
                      {open && (count > 0 ? body : <div className="pl-16 pr-3 py-1 text-fg/25 text-xs">{t("（無）")}</div>)}
                    </div>
                  );
                };

                return (
                  <div key={db}>
                    <div
                      onClick={() => {
                        toggleDb(c.id, db);
                        setActive(c.id);
                        selectNode({ type: "database", connId: c.id, db, kind: c.kind });
                      }}
                      onContextMenu={(isRedis || isSqlKind || c.kind === "mongo" || c.kind === "kafka" || c.kind === "elastic" || c.kind === "rabbitmq") ? (e) => {
                        e.preventDefault();
                        setActive(c.id);
                        selectNode({ type: "database", connId: c.id, db, kind: c.kind });
                        setDbMenu({ connId: c.id, db, x: e.clientX, y: e.clientY });
                      } : undefined}
                      className={`pl-7 pr-3 py-1.5 text-fg/70 cursor-pointer truncate flex items-center gap-1.5 ${
                        selectedNode?.type === "database" && selectedNode.connId === c.id && selectedNode.db === db
                          ? "relative bg-accent/12 before:content-[''] before:absolute before:left-0 before:inset-y-0 before:w-[2px] before:bg-accent" : "hover:bg-fg/5"
                      }`}
                    >
                      <span className="w-3 flex items-center justify-center shrink-0">
                        {loading
                          ? <Icon icon={Loader2} size={13} className="text-fg/40 animate-spin" />
                          : <Icon icon={ChevronRight} size={13} className={`text-fg/35 transition-transform ${objs ? "rotate-90" : ""}`} />}
                      </span>
                      <span className="shrink-0 flex" style={{ color: meta.color }}><Icon icon={Database} size={14} /></span>
                      <span className="truncate">{db}</span>
                    </div>

                    {objs && isSqlKind && (() => {
                      // 每庫獨立篩選（與全域搜尋 AND）；套用後再算數量，使資料夾徽章與顯示列數一致。
                      const dq = (dbFilter[dbKey] ?? "").trim().toLowerCase();
                      const dbMatch = (name: string) => !dq || name.toLowerCase().includes(dq);
                      const vTables = objs.tables.filter((o) => tableVisible(c.name, o.name) && dbMatch(o.name));
                      const vViews = objs.views.filter((o) => tableVisible(c.name, o.name) && dbMatch(o.name));
                      const vRoutines = objs.routines.filter((r) => tableVisible(c.name, r.name) && dbMatch(r.name));
                      return (
                        <>
                          <div className="pl-11 pr-3 py-1">
                            <div className="relative">
                              <Icon icon={Search} size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg/30" />
                              <input
                                value={dbFilter[dbKey] ?? ""}
                                onChange={(e) => setDbFilter((m) => ({ ...m, [dbKey]: e.target.value }))}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => { if (e.key === "Escape" && (dbFilter[dbKey] ?? "")) { e.stopPropagation(); setDbFilter((m) => ({ ...m, [dbKey]: "" })); } }}
                                placeholder={t("篩選 {db} 表名…", { db })}
                                title={t("只篩選此資料庫的表 / 檢視 / 函式名稱")}
                                className="w-full bg-inset border border-fg/10 rounded pl-6 pr-2 py-0.5 text-[11px] outline-none focus:border-accent"
                              />
                            </div>
                          </div>
                          {folderNode("tables", Table2, "text-sky-300/80", t("資料表"), vTables.length,
                            <>{vTables.map((o) => objNode(o, "pl-16"))}</>)}
                          {folderNode("views", Eye, "text-purple-300/80", t("檢視"), vViews.length,
                            <>{vViews.map((o) => objNode(o, "pl-16"))}</>)}
                          {canRoutines && folderNode("functions", FunctionSquare, "text-amber-300/90", t("函式"), vRoutines.length,
                            <>{vRoutines.map(routineNode)}</>)}
                        </>
                      );
                    })()}

                    {objs && !isSqlKind && (
                      <>
                        {objs.tables.filter((o) => tableVisible(c.name, o.name)).map((o) => objNode(o, "pl-12"))}
                        {objs.tables.length === 0 && (
                          <div className="pl-12 pr-3 py-1 text-fg/25 text-xs">{t("無表")}</div>
                        )}
                      </>
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
          <div className="fixed z-[90] min-w-[150px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: menu.x, top: menu.y }}>
            {(
              [
                [connectedIds.has(menu.id) ? t("中斷連線") : t("連線"), () => toggleConnect(menu.id), false],
                ...(connectedIds.has(menu.id)
                  ? [[t("重新整理資料庫"), () => refreshDbs(menu.id), false] as [string, () => void, boolean]]
                  : []),
                ...(connectedIds.has(menu.id) && (isMysqlFamily(menuConn.kind) || menuConn.kind === "postgres" || menuConn.kind === "sqlite")
                  ? [[t("新增查詢"), () => newQueryForDb(menuConn.id, menuConn.database ?? "", menuConn.kind), false] as [string, () => void, boolean]]
                  : []),
                ...(connectedIds.has(menu.id) && menuConn.kind === "redis"
                  ? [
                      [t("伺服器狀態"), () => setStatus({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean],
                      [t("命令列"), () => setConsole({ id: menuConn.id, name: menuConn.name, db: "0" }), false] as [string, () => void, boolean],
                    ]
                  : []),
                ...(connectedIds.has(menu.id) && menuConn.kind === "mongo"
                  ? [[t("監控面板"), () => setMongoOps({ id: menuConn.id, name: menuConn.name, db: menuConn.database ?? "" }), false] as [string, () => void, boolean]]
                  : []),
                ...(connectedIds.has(menu.id) && menuConn.kind === "kafka"
                  ? [
                      [t("叢集總覽…"), () => setKafkaOverview({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean],
                      [t("監控與告警…"), () => setKafkaMonitor({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean],
                      [t("新增主題…"), () => setKafkaCreateTopic({ connId: menuConn.id }), false] as [string, () => void, boolean],
                      [t("消費者群組…"), () => setKafkaGroups({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean],
                      ...(menuConn.options?.kafka_sr_url
                        ? [[t("Schema Registry…"), () => setKafkaSchema({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean]]
                        : []),
                      ...(menuConn.options?.kafka_connect_url
                        ? [[t("連接器…"), () => setKafkaConnect({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean]]
                        : []),
                      [t("ACL…"), () => setKafkaAcl({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean],
                    ]
                  : []),
                ...(connectedIds.has(menu.id) && menuConn.kind === "elastic"
                  ? [[t("叢集總覽…"), () => setEsOverview({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean]]
                  : []),
                ...(connectedIds.has(menu.id) && menuConn.kind === "rabbitmq"
                  ? [
                      [t("總覽…"), () => setRabbitOverview({ id: menuConn.id, name: menuConn.name }), false] as [string, () => void, boolean],
                      ...(readonlyConns[menu.id]
                        ? []
                        : [[t("發布訊息…"), () => setRabbitPublish({ connId: menuConn.id }), false] as [string, () => void, boolean]]),
                    ]
                  : []),
                ...(connectedIds.has(menu.id)
                  ? [["SQL Search…", () => setSearchObjs({ connId: menuConn.id, kind: menuConn.kind }), false] as [string, () => void, boolean]]
                  : []),
                ...(connectedIds.has(menu.id)
                  ? [[t("進階搜尋…"), () => onAdvSearch(menuConn.id, menuConn.kind), false] as [string, () => void, boolean]]
                  : []),
                ...(connectedIds.has(menu.id) && (isMysqlFamily(menuConn.kind) || menuConn.kind === "postgres")
                  ? [
                      [t("處理程序…"), () => setProcList({ connId: menuConn.id, kind: menuConn.kind }), false] as [string, () => void, boolean],
                      isMysqlFamily(menuConn.kind)
                        ? [t("使用者管理…"), () => setUserMgr({ connId: menuConn.id }), false] as [string, () => void, boolean]
                        : [t("使用者 / 角色…"), () => setServerQuery({
                            connId: menuConn.id,
                            title: t("使用者 / 角色"),
                            sql: "SELECT rolname AS role, rolsuper AS superuser, rolcreatedb AS createdb, rolcanlogin AS login, rolreplication AS replication FROM pg_roles ORDER BY rolname",
                          }), false] as [string, () => void, boolean],
                      [t("伺服器變數…"), () => setServerQuery({
                        connId: menuConn.id,
                        title: t("伺服器變數 / 設定"),
                        sql: menuConn.kind === "postgres"
                          ? "SELECT name, setting, unit, category FROM pg_settings ORDER BY category, name"
                          : "SHOW VARIABLES",
                      }), false] as [string, () => void, boolean],
                    ]
                  : []),
                [readonlyConns[menu.id] ? t("關閉唯讀模式") : t("設為唯讀模式（擋寫入 / DDL）"), () => useStore.getState().setConnReadonly(menu.id, !readonlyConns[menu.id]), false],
                [t("屬性…"), () => setConnProps(menuConn), false],
                [t("編輯…"), () => onEdit(menuConn), false],
                [t("複製連線…"), () => onEdit({ ...menuConn, id: crypto.randomUUID(), name: t("{name} 複本", { name: menuConn.name }), password: "" }), false],
                [t("刪除"), () => deleteConn(menuConn.id, menuConn.name), true],
              ] as [string, () => void, boolean][]
            ).map(([label, fn, danger]) => (
              <button key={label} type="button"
                onClick={() => { setMenu(null); fn(); }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-fg/10 ${danger ? "text-danger" : "text-fg/80"}`}>
                {label}
              </button>
            ))}
            {/* 連線色標：選色即標記（致敬 Navicat connection color），用以區分環境。 */}
            <div className="border-t border-fg/10 mt-1 pt-1.5 px-3 pb-1">
              <div className="text-[11px] text-fg/40 mb-1">{t("顏色標記")}</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {CONN_COLOR_PALETTE.map((p) => {
                  const active = (connColors[menu.id] ?? "") === p.value;
                  return (
                    <button key={p.name} type="button" title={t(p.name)}
                      onClick={() => { applyConnColor(menu.id, p.value); setMenu(null); }}
                      className={`w-4 h-4 rounded-full border ${active ? "ring-2 ring-accent ring-offset-1 ring-offset-elevated" : "border-fg/20"} ${p.value ? "" : "grid place-items-center"}`}
                      style={p.value ? { background: p.value } : undefined}>
                      {!p.value && <Icon icon={X} size={10} className="text-fg/50" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}

      {dbMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setDbMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setDbMenu(null); }} />
          <div className="fixed z-[90] min-w-[150px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: dbMenu.x, top: dbMenu.y }}>
            {(() => {
              const dbConn = connections.find((x) => x.id === dbMenu.connId);
              const editConn = () => { if (dbConn) onEdit(dbConn); };
              const items: [string, () => void, boolean][] =
                dbConn?.kind === "redis"
                  ? [
                      [t("新增鍵…"), () => setNewKey({ connId: dbMenu.connId, db: dbMenu.db }), false],
                      [t("伺服器狀態"), () => { if (dbConn) setStatus({ id: dbConn.id, name: dbConn.name }); }, false],
                      [t("命令列"), () => { if (dbConn) setConsole({ id: dbConn.id, name: dbConn.name, db: dbMenu.db }); }, false],
                      [t("編輯屬性…"), editConn, false],
                      [t("清空 DB（FLUSHDB）"), () => flushDb(dbMenu.connId, dbMenu.db), true],
                    ]
                  : dbConn?.kind === "kafka"
                  ? [
                      [t("叢集總覽…"), () => { if (dbConn) setKafkaOverview({ id: dbConn.id, name: dbConn.name }); }, false] as [string, () => void, boolean],
                      [t("監控與告警…"), () => { if (dbConn) setKafkaMonitor({ id: dbConn.id, name: dbConn.name }); }, false] as [string, () => void, boolean],
                      [t("新增主題…"), () => setKafkaCreateTopic({ connId: dbMenu.connId }), false] as [string, () => void, boolean],
                      [t("消費者群組…"), () => { if (dbConn) setKafkaGroups({ id: dbConn.id, name: dbConn.name }); }, false] as [string, () => void, boolean],
                      [t("編輯屬性…"), editConn, false] as [string, () => void, boolean],
                    ]
                  : dbConn?.kind === "elastic"
                  ? [
                      [t("叢集總覽…"), () => { if (dbConn) setEsOverview({ id: dbConn.id, name: dbConn.name }); }, false] as [string, () => void, boolean],
                      [t("編輯屬性…"), editConn, false] as [string, () => void, boolean],
                    ]
                  : dbConn?.kind === "rabbitmq"
                  ? [
                      [t("總覽…"), () => { if (dbConn) setRabbitOverview({ id: dbConn.id, name: dbConn.name }); }, false] as [string, () => void, boolean],
                      ...(readonlyConns[dbMenu.connId]
                        ? []
                        : [[t("發布訊息…"), () => setRabbitPublish({ connId: dbMenu.connId }), false] as [string, () => void, boolean]]),
                      [t("編輯屬性…"), editConn, false] as [string, () => void, boolean],
                    ]
                  : dbConn?.kind === "mongo"
                  ? ((): [string, () => void, boolean][] => {
                      const arr: [string, () => void, boolean][] = [
                        [t("新增集合…"), () => createCollection(dbMenu.connId, dbMenu.db), false],
                        [t("新增資料庫…"), () => { if (dbConn) createDatabase(dbMenu.connId, dbConn.kind); }, false],
                        [t("監控面板"), () => { if (dbConn) setMongoOps({ id: dbConn.id, name: dbConn.name, db: dbMenu.db }); }, false],
                        [t("編輯屬性…"), editConn, false],
                      ];
                      // 系統庫（admin/config/local）不顯示刪除（後端亦硬擋）。
                      if (!isSystemDatabase("mongo", dbMenu.db))
                        arr.push([t("刪除資料庫…"), () => { if (dbConn) dropDatabase(dbMenu.connId, dbMenu.db, dbConn.kind); }, true]);
                      return arr;
                    })()
                  : ((): [string, () => void, boolean][] => {
                      const k = dbConn?.kind;
                      const noun = k === "postgres" ? "Schema" : t("資料庫");
                      const arr: [string, () => void, boolean][] = [
                        [t("新增查詢"), () => { if (dbConn) newQueryForDb(dbMenu.connId, dbMenu.db, dbConn.kind); }, false],
                        [t("設計表結構…"), () => { if (dbConn) setDesignTable({ connId: dbMenu.connId, db: dbMenu.db, kind: dbConn.kind }); }, false],
                      ];
                      // SQLite 為單檔，無多資料庫概念，故不顯示新增 / 刪除資料庫。
                      if (k !== "sqlite") arr.push([t("新增{noun}…", { noun }), () => { if (dbConn) createDatabase(dbMenu.connId, dbConn.kind); }, false]);
                      arr.push([t("新增視圖…"), () => { if (dbConn) setCreateView({ connId: dbMenu.connId, db: dbMenu.db, kind: dbConn.kind }); }, false]);
                      arr.push([t("預存程序 / 觸發器…"), () => { if (dbConn) setRoutines({ connId: dbMenu.connId, db: dbMenu.db, kind: dbConn.kind }); }, false]);
                      arr.push([t("匯出結構 SQL…"), () => dumpSchema(dbMenu.connId, dbMenu.db), false]);
                      if (isMysqlFamily(k)) arr.push([t("資料表大小報表…"), () => setServerQuery({
                        connId: dbMenu.connId, title: t("資料表大小：{db}", { db: dbMenu.db }), sql: tableSizesSql(dbMenu.db),
                      }), false]);
                      if ((isMysqlFamily(k) || k === "postgres") && dbConn) arr.push([t("結構比對…"), () => setSchemaCompare({ connId: dbMenu.connId, db: dbMenu.db, kind: dbConn.kind }), false]);
                      if (isMysqlFamily(k) || k === "postgres" || k === "sqlite") arr.push([t("資料傳輸（整庫）…"), () => setDbTransfer({ connId: dbMenu.connId, db: dbMenu.db }), false]);
                      if ((isMysqlFamily(k) || k === "postgres" || k === "sqlite") && dbConn) arr.push([t("資料庫文件…"), () => setDbDict({ connId: dbMenu.connId, db: dbMenu.db, kind: dbConn.kind }), false]);
                      if (isMysqlFamily(k)) arr.push([t("資料庫屬性…"), () => setDbProps({ connId: dbMenu.connId, db: dbMenu.db }), false]);
                      arr.push([t("編輯屬性…"), editConn, false]);
                      // 系統 schema / 庫，以及 MySQL 系使用中的預設庫，不顯示刪除（後端亦硬擋）。
                      const isDefault = isMysqlFamily(k) && dbConn?.database === dbMenu.db;
                      if (k !== "sqlite" && k && !isSystemDatabase(k, dbMenu.db) && !isDefault)
                        arr.push([t("刪除{noun}…", { noun }), () => { if (dbConn) dropDatabase(dbMenu.connId, dbMenu.db, dbConn.kind); }, true]);
                      return arr;
                    })();
              // 重新整理：重載此資料庫節點的表 / 集合 / 鍵清單（適用所有種類）。
              items.unshift([t("重新整理"), () => refreshTables(dbMenu.connId, dbMenu.db), false]);
              return items.map(([label, fn, danger]) => (
                <button key={label} type="button"
                  onClick={() => { setDbMenu(null); fn(); }}
                  className={`block w-full text-left px-3 py-1.5 hover:bg-fg/10 ${danger ? "text-danger" : "text-fg/80"}`}>
                  {label}
                </button>
              ));
            })()}
          </div>
        </>
      )}

      {folderMenu && (
        <MenuPanel x={folderMenu.x} y={folderMenu.y} onClose={() => setFolderMenu(null)}>
          <MenuItems nodes={folderMenuNodes(folderMenu)} onClose={() => setFolderMenu(null)} />
        </MenuPanel>
      )}

      {tableMenu && (
        <MenuPanel x={tableMenu.x} y={tableMenu.y} onClose={() => setTableMenu(null)}>
          <MenuItems nodes={tableMenuNodes(tableMenu)} onClose={() => setTableMenu(null)} />
        </MenuPanel>
      )}

      {routineMenu && (
        <MenuPanel x={routineMenu.x} y={routineMenu.y} onClose={() => setRoutineMenu(null)}>
          <MenuItems nodes={routineMenuNodes(routineMenu)} onClose={() => setRoutineMenu(null)} />
        </MenuPanel>
      )}

      {status && (
        <RedisStatus connId={status.id} connName={status.name} onClose={() => setStatus(null)} />
      )}

      {kafkaGroups && (
        <KafkaConsumerGroups connId={kafkaGroups.id} connName={kafkaGroups.name} onClose={() => setKafkaGroups(null)} />
      )}

      {kafkaOverview && (
        <KafkaClusterOverview connId={kafkaOverview.id} connName={kafkaOverview.name} onClose={() => setKafkaOverview(null)} />
      )}

      {kafkaMonitor && (
        <KafkaMonitorPanel connId={kafkaMonitor.id} connName={kafkaMonitor.name} onClose={() => setKafkaMonitor(null)} />
      )}

      {kafkaConnect && (
        <KafkaConnectPanel connId={kafkaConnect.id} connName={kafkaConnect.name} onClose={() => setKafkaConnect(null)} />
      )}

      {kafkaAcl && (
        <KafkaAclPanel connId={kafkaAcl.id} connName={kafkaAcl.name} onClose={() => setKafkaAcl(null)} />
      )}

      {kafkaSchema && (
        <KafkaSchemaViewer connId={kafkaSchema.id} connName={kafkaSchema.name} onClose={() => setKafkaSchema(null)} />
      )}

      {esOverview && (
        <EsClusterOverview connId={esOverview.id} connName={esOverview.name} onClose={() => setEsOverview(null)} />
      )}

      {esMapping && (
        <EsMappingViewer connId={esMapping.connId} index={esMapping.index} onClose={() => setEsMapping(null)} />
      )}

      {rabbitOverview && (
        <RabbitMqOverview connId={rabbitOverview.id} connName={rabbitOverview.name} onClose={() => setRabbitOverview(null)} />
      )}

      {rabbitPublish && (
        <RabbitMqPublishDialog
          connId={rabbitPublish.connId}
          initialRoutingKey={rabbitPublish.routingKey}
          onClose={() => setRabbitPublish(null)}
        />
      )}

      {kafkaCreateTopic && (
        <KafkaCreateTopicDialog
          connId={kafkaCreateTopic.connId}
          onClose={() => setKafkaCreateTopic(null)}
          onCreated={() => {
            const c = connections.find((x) => x.id === kafkaCreateTopic.connId);
            if (c) refreshTables(kafkaCreateTopic.connId, "cluster");
          }}
        />
      )}

      {console_ && (
        <RedisConsole
          connId={console_.id}
          connName={console_.name}
          initialDb={console_.db}
          onClose={() => setConsole(null)}
        />
      )}

      {mongoOps && (
        <MongoOpsPanel
          connId={mongoOps.id}
          connName={mongoOps.name}
          database={mongoOps.db}
          readonly={readonlyConns[mongoOps.id] === true}
          onClose={() => setMongoOps(null)}
        />
      )}

      {newKey && (
        <NewKeyDialog
          connId={newKey.connId}
          database={newKey.db}
          onClose={() => setNewKey(null)}
          onCreated={() => refreshTables(newKey.connId, newKey.db)}
        />
      )}

      {designTable && (
        <CreateTableDialog
          connId={designTable.connId}
          database={designTable.db}
          kind={designTable.kind}
          onClose={() => setDesignTable(null)}
          onCreated={() => refreshTables(designTable.connId, designTable.db)}
        />
      )}

      {connProps && (
        <ConnectionProperties
          conn={connProps}
          connected={connectedIds.has(connProps.id)}
          onClose={() => setConnProps(null)}
        />
      )}

      {tableProps && (
        <TableProperties
          connId={tableProps.connId}
          db={tableProps.db}
          table={tableProps.table}
          kind={tableProps.kind}
          objKind={tableProps.objKind}
          onClose={() => setTableProps(null)}
        />
      )}

      {routines && (
        <RoutinesDialog
          connId={routines.connId}
          db={routines.db}
          kind={routines.kind}
          initial={routines.initial ?? null}
          initialAction={routines.initialAction}
          newType={routines.newType}
          onClose={() => setRoutines(null)}
        />
      )}

      {createView && (
        <CreateViewDialog
          connId={createView.connId}
          database={createView.db}
          kind={createView.kind}
          onClose={() => setCreateView(null)}
          onCreated={() => refreshTables(createView.connId, createView.db)}
        />
      )}

      {procList && (
        <ProcessListDialog connId={procList.connId} kind={procList.kind} onClose={() => setProcList(null)} />
      )}

      {serverQuery && (
        <ServerQueryDialog connId={serverQuery.connId} title={serverQuery.title} sql={serverQuery.sql}
          onClose={() => setServerQuery(null)} />
      )}

      {userMgr && (
        <UserManager connId={userMgr.connId} onClose={() => setUserMgr(null)} />
      )}

      {dbProps && (
        <DatabaseProperties connId={dbProps.connId} db={dbProps.db} onClose={() => setDbProps(null)} />
      )}

      {schemaCompare && (
        <SchemaCompare connId={schemaCompare.connId} kind={schemaCompare.kind} sourceDb={schemaCompare.db} onClose={() => setSchemaCompare(null)} />
      )}

      {viewDesign && (
        <ViewDesigner connId={viewDesign.connId} db={viewDesign.db} view={viewDesign.view} kind={viewDesign.kind}
          onClose={() => setViewDesign(null)} />
      )}

      {searchObjs && (
        <SearchObjectsDialog connId={searchObjs.connId} kind={searchObjs.kind} onClose={() => setSearchObjs(null)} />
      )}

      {importTbl && (
        <ImportDialog connId={importTbl.connId} database={importTbl.db} table={importTbl.table}
          onDone={() => {
            refreshTables(importTbl.connId, importTbl.db);
            useStore.getState().bumpDataReload(importTbl.connId, importTbl.db, importTbl.table);
          }}
          onClose={() => setImportTbl(null)} />
      )}

      {exportTbl && (
        <ExportDialog connId={exportTbl.connId} database={exportTbl.db} table={exportTbl.table}
          query={{ page: 0, page_size: 1000, filters: [], sorts: [] }}
          onClose={() => setExportTbl(null)} />
      )}

      {transferTbl && (
        <TransferDialog connId={transferTbl.connId} database={transferTbl.db} table={transferTbl.table}
          onClose={() => setTransferTbl(null)} />
      )}

      {builderTbl && (
        <QueryBuilder connId={builderTbl.connId} kind={builderTbl.kind} initialDb={builderTbl.db} initialTable={builderTbl.table}
          onClose={() => setBuilderTbl(null)}
          onUse={(sql) => { sendQuery(builderTbl.connId, sql); setBuilderTbl(null); }} />
      )}

      {syncTbl && (
        <DataSyncDialog connId={syncTbl.connId} database={syncTbl.db} table={syncTbl.table}
          onClose={() => setSyncTbl(null)}
          onUse={(sql, targetConnId) => { sendQuery(targetConnId, sql); setSyncTbl(null); }} />
      )}

      {dbTransfer && (
        <DbTransferDialog connId={dbTransfer.connId} database={dbTransfer.db} onClose={() => setDbTransfer(null)} />
      )}

      {dbDict && (
        <DbDataDictionary connId={dbDict.connId} db={dbDict.db} onClose={() => setDbDict(null)} />
      )}

      {palette && <CommandPalette items={paletteItems} onClose={() => setPalette(false)} />}

      {dataDict && (
        <DataDictionary connId={dataDict.connId} db={dataDict.db} table={dataDict.table} kind={dataDict.kind}
          onClose={() => setDataDict(null)} />
      )}

      {dataGen && (
        <DataGenerator connId={dataGen.connId} db={dataGen.db} table={dataGen.table} kind={dataGen.kind}
          onGenerate={(sql) => { sendQuery(dataGen.connId, sql); setDataGen(null); }}
          onClose={() => setDataGen(null)} />
      )}

      {erTable && (
        <ErDiagram connId={erTable.connId} initialDb={erTable.db} focusTable={erTable.table}
          onClose={() => setErTable(null)} />
      )}
    </div>
  );
}

// ---- 中央主工作區：分頁式（表分頁 + 查詢） ----
function MainArea({ onNewConnection }: { onNewConnection: () => void }) {
  const t = useT();
  const { connections, activeId, connectedIds, tabs, activeTabKey, setActiveTab, closeTab, closeOtherTabs, closeAllTabs,
    queryTabs, addQueryTab, closeQueryTab, closeOtherQueryTabs, closeAllQueryTabs } = useStore();
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [queryTabMenu, setQueryTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const queryTabRef = useRef<HTMLButtonElement>(null);

  const canUse = activeId && connectedIds.has(activeId);
  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? null;
  // 作用中的查詢分頁 id（非表分頁時）：解析未知 / null → 第一個查詢分頁（home 可被關掉，不能寫死 __query__）。
  const activeQueryId = activeTabKey && queryTabs.includes(activeTabKey) ? activeTabKey : queryTabs[0];

  // 分頁鍵盤操作：Ctrl/Cmd+N 開新查詢、Ctrl/Cmd+Shift+N 新增連線、Ctrl/Cmd+W 關閉、
  // Ctrl+Tab / Ctrl+Shift+Tab 循環、Ctrl+1..9 跳轉（9=最後一個，含查詢分頁）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (document.body.dataset.modalCount) return; // 有對話框開啟時不要在背後切換 / 關閉分頁
      if (e.key === "n" || e.key === "N") {
        // Ctrl+N 開「新查詢分頁」：依目前選取的樹節點帶入範圍（USE + SELECT / USE / 空白）；Ctrl+Shift+N 新增連線。
        // 永遠開新分頁、不覆蓋現有編輯器內容（對標 DataGrip New Query Console）。
        // 焦點在一般輸入框（側欄搜尋 / 對話框欄位 / 下拉）時不攔截，避免誤觸；查詢編輯器仍可用。
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "SELECT")) return;
        e.preventDefault();
        if (e.shiftKey) onNewConnection();
        else openNodeScopedQueryTab();
        return;
      }
      if (e.key === "w" || e.key === "W") {
        // 表分頁 → 關表；查詢分頁 → 關該查詢分頁（僅剩一個時 closeQueryTab 會自行忽略）。
        if (activeTabKey && tabs.some((tab) => tab.key === activeTabKey)) { e.preventDefault(); closeTab(activeTabKey); return; }
        if (activeTabKey && queryTabs.length > 1 && queryTabs.includes(activeTabKey)) { e.preventDefault(); closeQueryTab(activeTabKey); return; }
        return;
      }
      if (e.key === "t" || e.key === "T") { e.preventDefault(); addQueryTab(); return; } // Ctrl+T 新增查詢分頁
      // 所有表分頁後接所有查詢分頁，組成可循環 / 跳轉的鍵序列。
      const keys = [...tabs.map((tab) => tab.key), ...queryTabs];
      if (e.key === "Tab") {
        e.preventDefault();
        const cur = keys.indexOf(activeTabKey ?? "");
        const dir = e.shiftKey ? -1 : 1;
        const base = cur < 0 ? 0 : cur;
        setActiveTab(keys[(base + dir + keys.length) % keys.length]);
      } else if (/^[1-9]$/.test(e.key)) {
        const d = Number(e.key);
        const idx = d === 9 ? keys.length - 1 : d - 1;
        if (idx >= 0 && idx < keys.length) {
          e.preventDefault();
          setActiveTab(keys[idx]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, activeTabKey, setActiveTab, closeTab, onNewConnection, queryTabs, addQueryTab, closeQueryTab]);

  // 作用中分頁捲入可視範圍（Ctrl+W / Ctrl+Tab 切換後不會被擠到畫面外；含查詢分頁）。
  useEffect(() => {
    const onQuery = activeTabKey == null || queryTabs.includes(activeTabKey);
    const el = onQuery ? queryTabRef.current : activeTabRef.current;
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabKey, queryTabs]);

  if (!canUse && tabs.length === 0) {
    const noConns = connections.length === 0;
    return (
      <div className="flex-1 flex items-center justify-center min-w-0">
        <EmptyState
          icon={noConns ? Database : MousePointerClick}
          title={noConns ? t("尚未建立任何連線") : t("選擇一個連線開始")}
          hint={
            noConns
              ? t("建立第一個資料庫連線，即可瀏覽資料表、執行查詢與管理結構。")
              : t("雙擊左側的連線以建立連線，再單擊資料表即可在此開啟。")
          }
          action={
            noConns ? (
              <Button variant="primary" size="md" icon={Plus} onClick={onNewConnection}>
                {t("新增連線")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* 分頁列（中鍵關閉、右鍵選單） */}
      <div className="flex items-stretch bg-panel border-b border-fg/10 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            ref={tab.key === activeTabKey ? activeTabRef : undefined}
            onClick={() => setActiveTab(tab.key)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.key); } }}
            onContextMenu={(e) => {
              e.preventDefault();
              setActiveTab(tab.key);
              setTabMenu({ key: tab.key, x: e.clientX, y: e.clientY });
            }}
            title={t("{database} · {table}（中鍵關閉）", { database: tab.database, table: tab.table })}
            className={`flex items-center gap-2 pl-3 pr-2 py-1.5 text-xs border-r border-fg/10 cursor-pointer whitespace-nowrap ${
              tab.key === activeTabKey ? "bg-app text-fg shadow-[inset_0_-2px_0_rgb(var(--c-accent))]" : "text-fg/50 hover:bg-fg/5"
            }`}
          >
            <Icon
              icon={tab.objKind === "view" ? Eye : tab.objKind === "data_view" ? Layers : Table2}
              size={13}
              className={`shrink-0 ${
                tab.objKind === "view" ? "text-purple-300/70" : tab.objKind === "data_view" ? "text-teal-300/70" : "text-sky-300/70"
              }`}
            />
            <span className="mono">{tab.table}</span>
            <button
              type="button"
              aria-label={t("關閉分頁 {table}", { table: tab.table })}
              title={t("關閉分頁")}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.key);
              }}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-fg/15 text-fg/40 hover:text-fg/80"
            >
              <Icon icon={X} size={12} />
            </button>
          </div>
        ))}
        {queryTabs.map((qid, i) => {
          const isActive = !activeTab && activeQueryId === qid;
          return (
            <QueryTabButton
              key={qid}
              label={i === 0 ? t("查詢") : t("查詢 {n}", { n: i + 1 })}
              active={isActive}
              closable={queryTabs.length > 1}
              btnRef={isActive ? queryTabRef : undefined}
              onActivate={() => setActiveTab(qid)}
              onClose={() => closeQueryTab(qid)}
              onContextMenu={(e) => {
                e.preventDefault(); // 攔掉 WebView 預設右鍵選單
                setActiveTab(qid);
                // 只剩一個查詢分頁時無任何可執行動作 → 不開空選單。
                if (queryTabs.length <= 1) return;
                setQueryTabMenu({ id: qid, x: e.clientX, y: e.clientY });
              }}
            />
          );
        })}
        <button type="button" onClick={addQueryTab} title={t("新增查詢分頁（Ctrl+T）")}
          aria-label={t("新增查詢分頁")}
          className="px-2 py-1.5 text-fg/40 hover:text-fg/80 hover:bg-fg/5 border-r border-fg/10 shrink-0">
          <Icon icon={Plus} size={14} />
        </button>
      </div>

      {/* 內容：表分頁 → 資料格；否則 → 對應查詢分頁的編輯器（key 隨分頁 → 各自獨立狀態與草稿）。 */}
      {activeTab ? (
        <TableView tab={activeTab} />
      ) : (
        <QueryPane key={activeQueryId} tabId={activeQueryId} />
      )}

      {tabMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setTabMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }} />
          <div className="fixed z-[90] min-w-[140px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: tabMenu.x, top: tabMenu.y }}>
            {(
              [
                [t("關閉"), () => closeTab(tabMenu.key)],
                [t("關閉其他"), () => closeOtherTabs(tabMenu.key)],
                [t("全部關閉"), () => closeAllTabs()],
              ] as [string, () => void][]
            ).map(([label, fn]) => (
              <button key={label} type="button"
                onClick={() => { setTabMenu(null); fn(); }}
                className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80">
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {queryTabMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setQueryTabMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setQueryTabMenu(null); }} />
          <div className="fixed z-[90] min-w-[140px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: queryTabMenu.x, top: queryTabMenu.y }}>
            {(() => {
              const qid = queryTabMenu.id;
              // 任一查詢分頁（含第一個「查詢」）皆可關，前提是關完仍留得下至少一個。
              // 只剩一個時 onContextMenu 已擋掉，不會走到這裡。
              const items: [string, () => void][] = [
                [t("關閉查詢"), () => closeQueryTab(qid)],
                [t("關閉其他查詢"), () => closeOtherQueryTabs(qid)],
                [t("全部關閉查詢"), () => closeAllQueryTabs()],
              ];
              return items.map(([label, fn]) => (
                <button key={label} type="button"
                  onClick={() => { setQueryTabMenu(null); fn(); }}
                  className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80">
                  {label}
                </button>
              ));
            })()}
          </div>
        </>
      )}
    </div>
  );
}

// 單一查詢分頁鈕（受控）：可關閉者（額外分頁）顯示關閉鈕，中鍵亦可關。home「查詢」不可關。
// 右鍵選單由呼叫端提供（onContextMenu 掛在外框，含關閉鈕區域）。
function QueryTabButton({ label, active, closable, onActivate, onClose, onContextMenu, btnRef }: {
  label: string;
  active: boolean;
  closable: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  btnRef?: React.Ref<HTMLButtonElement>;
}) {
  const t = useT();
  return (
    <div
      onContextMenu={onContextMenu}
      className={`group flex items-center border-r border-fg/10 shrink-0 ${
        active ? "bg-app text-fg shadow-[inset_0_-2px_0_rgb(var(--c-accent))]" : "text-fg/50 hover:bg-fg/5"
      }`}
    >
      <button
        ref={btnRef}
        type="button"
        onClick={onActivate}
        onAuxClick={(e) => { if (e.button === 1 && closable) { e.preventDefault(); onClose(); } }}
        title={closable ? t("{label}（中鍵關閉）", { label }) : label}
        className={`flex items-center gap-1.5 ${closable ? "pl-3 pr-1.5" : "px-3"} py-1.5 text-xs`}
      >
        <Icon icon={FileCode2} size={14} className="text-blue-300/80" />{label}
      </button>
      {closable && (
        <button
          type="button"
          aria-label={t("關閉 {label}", { label })}
          title={t("關閉查詢分頁")}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="mr-1 w-5 h-5 flex items-center justify-center rounded hover:bg-fg/15 text-fg/40 hover:text-fg/80"
        >
          <Icon icon={X} size={12} />
        </button>
      )}
    </div>
  );
}

// 各資料庫的查詢預設值 / 提示語法（SQL 與鍵值/文件型語法不同）。
// 註：對 Redis 而言 "SELECT 1" 是「切換到 DB 1」的真實指令，不可拿來當通用預設。
const QUERY_DEFAULTS: Record<DbKind, string> = {
  mysql: "SELECT 1",
  mariadb: "SELECT 1",
  postgres: "SELECT 1",
  sqlite: "SELECT 1",
  mssql: "SELECT 1",
  oracle: "SELECT 1 FROM DUAL",
  mongo: '{ "db": "", "collection": "", "filter": {} }',
  redis: "PING",
  kafka: "", // Kafka 無查詢編輯器
  elastic: '{ "index": "", "query": { "match_all": {} }, "size": 200 }',
  rabbitmq: "", // RabbitMQ 無查詢編輯器（走專屬佇列瀏覽 / 發布面板）
  external: "SELECT 1",
};
// 僅關聯式資料庫支援 EXPLAIN 查詢計畫分析（MSSQL 回 SHOWPLAN XML，於結果格顯示、不走 JSON 視覺樹）。
// oracle 一併納入：除了 explain 表格（EXPLAIN PLAN + DBMS_XPLAN 文字 grid），也讓 Oracle
// 走 SQL 編輯器與 `;` 多語句切割（Oracle 單次 execute 不接受多語句）。
const EXPLAIN_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite", "mssql", "oracle"];

// 支援查詢面板「目前資料庫」選擇器（以 USE / search_path 把查詢限定到所選庫）的連線類型：
// 關聯式多庫（MySQL / PostgreSQL）＋ 外部 gateway（driver 以 strip_leading_use 切站）。
// SQLite 為單檔無多庫；Mongo / Redis 的資料庫切換走各自指令，不在此列。
const DB_SELECT_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "external"];

// 查詢編輯器內容 per-連線 持久化（重開 / 切換連線後沿用上次的查詢）。
// 查詢內容持久化鍵：每連線 × 每查詢分頁。預設 home 分頁沿用舊鍵（向後相容，既有草稿不遺失）。
const sqlStoreKey = (id: string, tabId = "__query__") =>
  tabId === "__query__" ? `db-kit:querySql:${id}` : `db-kit:querySql:${id}:${tabId}`;
// 「目前資料庫」選擇 per-連線 持久化（切換連線 / 重開後沿用上次選的庫）。
const queryDbStoreKey = (id: string) => `db-kit:queryDb:${id}`;
function loadPersistedSql(id: string | null | undefined, kind: DbKind | undefined, tabId = "__query__"): string {
  if (id) {
    try {
      const s = localStorage.getItem(sqlStoreKey(id, tabId));
      if (s != null) return s;
    } catch {
      /* 忽略讀取失敗 */
    }
  }
  return kind ? QUERY_DEFAULTS[kind] : "SELECT 1";
}

// 一次執行的每條語句結果（供「摘要」面板逐條列出，致敬 Navicat 摘要分頁）。
interface StmtRun { sql: string; ok: boolean; message: string; ms: number; }
interface RunSummary { startedAt: number; finishedAt: number; total: number; processed: number; success: number; errors: number; statements: StmtRun[]; }
// 單一結果集（SSMS 風格）：多語句批次中每條有回傳結果集的語句各佔一格；sql=產生它的原語句（不含注入的 USE 前綴）、ms=該語句耗時。
// sent：實際送到後端的語句（含 USE / search_path 前綴），供匯出完整結果時原樣重跑；
// sql 為使用者原語句（顯示 / 摘要用，不含注入前綴）。
// setIdx：本格在該次 run_query_multi 回傳陣列中的索引（含無欄位的 DML 結果）；
// 匯出重跑後取同位結果集。單結果集呼叫恆為 0。
interface ResultSetEntry { res: QueryResult; sql: string; ms: number; sent?: string; setIdx?: number; }

// 毫秒時間戳 → 本地「YYYY-MM-DD HH:mm:ss」（摘要面板的開始 / 結束時間）。
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 「摘要」面板：執行統計（處理數 / 成功 / 錯誤 / 起訖時間 / 總耗時）＋逐條語句結果表。
function RunSummaryView({ summary }: { summary: RunSummary }) {
  const t = useT();
  const total = summary.finishedAt - summary.startedAt;
  return (
    <div className="p-3 text-xs">
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 max-w-2xl mb-3">
        <div className="flex justify-between"><span className="text-fg/50">{t("已處理的查詢")}</span><span className="text-fg/80">{summary.processed < summary.total ? t("{processed} / {total}（其餘已略過）", { processed: summary.processed, total: summary.total }) : summary.processed}</span></div>
        <div className="flex justify-between"><span className="text-fg/50">{t("開始時間")}</span><span className="text-fg/80">{fmtClock(summary.startedAt)}</span></div>
        <div className="flex justify-between"><span className="text-fg/50">{t("成功")}</span><span className="text-emerald-400">{summary.success}</span></div>
        <div className="flex justify-between"><span className="text-fg/50">{t("結束時間")}</span><span className="text-fg/80">{fmtClock(summary.finishedAt)}</span></div>
        <div className="flex justify-between"><span className="text-fg/50">{t("錯誤")}</span><span className={summary.errors ? "text-red-400" : "text-fg/80"}>{summary.errors}</span></div>
        <div className="flex justify-between"><span className="text-fg/50">{t("運行時間")}</span><span className="text-fg/80">{fmtElapsed(total)}</span></div>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-fg/40 border-b border-fg/10">
            <th className="py-1 pr-3 font-medium">{t("查詢")}</th>
            <th className="py-1 pr-3 font-medium">{t("訊息")}</th>
            <th className="py-1 pr-3 font-medium w-24">{t("查詢時間")}</th>
          </tr>
        </thead>
        <tbody>
          {summary.statements.map((s, i) => (
            <tr key={i} className="border-b border-fg/5 align-top">
              <td className="py-1 pr-3 mono text-fg/70 max-w-[40ch] truncate" title={s.sql}>{s.sql}</td>
              <td className={`py-1 pr-3 whitespace-pre-wrap break-words ${s.ok ? "text-emerald-400" : "text-red-400"}`}>{s.message}</td>
              <td className="py-1 pr-3 text-fg/60">{fmtElapsed(s.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- 查詢面板：上 SQL、下結果（F6 執行） ----
function QueryPane({ tabId = "__query__" }: { tabId?: string }) {
  const t = useT();
  const { activeId } = useStore();
  // 目前連線是否唯讀（反應式）：供工具列徽章與寫入提示。
  const activeReadonly = useStore((s) => !!s.activeId && s.readonlyConns[s.activeId] === true);
  const kind = useStore((s) => s.connections.find((c) => c.id === activeId)?.kind);
  // 連線選擇器：列出已連線的連線供查詢面板直接切換目標（致敬 Navicat 連線下拉）。
  const connections = useStore((s) => s.connections);
  const connectedIds = useStore((s) => s.connectedIds);
  const supportsExplain = !!kind && EXPLAIN_KINDS.includes(kind);
  // 編輯器選擇與選取追蹤：SQL-like 連線（含 external gateway，講 MySQL 方言）用 CodeMirror SqlEditor。
  // 與 supportsExplain（EXPLAIN 查詢計畫能力）是兩個關注點——external 走 gateway、
  // 不進 EXPLAIN_KINDS（那會誤開前端多語句切分），視覺化解釋另有 supportsVisualExplain gate。
  const supportsSqlEditor = supportsExplain || kind === "external";
  // 視覺化解釋（解釋分頁）支援的類型：能取得 JSON 執行計畫者（MySQL / PostgreSQL / 外部 gateway；SQLite 無）。
  const supportsVisualExplain = !!kind && (isMysqlFamily(kind) || kind === "postgres" || kind === "external");
  // Mongo explain：獨立 gate —— 不可把 mongo 加進 EXPLAIN_KINDS（那同時 gate SQL 切割 / 參數 / 編輯器選擇）。
  const supportsMongoExplain = kind === "mongo";
  // 「目前資料庫」選擇器：把查詢以 USE / search_path 限定到所選庫（MySQL / PostgreSQL / 外部 gateway）。
  const supportsDbSelect = !!kind && DB_SELECT_KINDS.includes(kind);
  const [dbList, setDbList] = useState<string[]>([]);
  const [queryDb, setQueryDb] = useState<string>("");
  // 自動完成 schema（僅關聯式）；SQL 編輯器目前選取段（供 queryToRun 只跑選取段）。
  // 對「queryDb 即資料庫名」的 kind（mysql 家族 + external/qland gateway），把工具列選的資料庫
  // 帶進去當 databaseOverride，讓自動完成對準目前選的庫（如 Siebog），與實際 USE queryDb 執行一致；
  // 未選（空字串）→ undefined → useSqlSchema 回退連線預設庫。postgres 的 queryDb 是 schema 非 DB，維持原行為。
  const schemaDb = kind && (isMysqlFamily(kind) || kind === "external") ? (queryDb || undefined) : undefined;
  const schema = useSqlSchema(activeId, kind, schemaDb);
  const [editorSel, setEditorSel] = useState<string | null>(null);
  const [sql, setSql] = useState(() => loadPersistedSql(activeId, kind, tabId));
  // 具名參數數量（記憶化，避免每次 render 重新 tokenize SQL）。
  const paramCount = useMemo(() => (supportsSqlEditor ? extractNamedParams(sql).length : 0), [supportsSqlEditor, sql]);
  // 結果集清單（SSMS 風格）：多語句批次中每條有回傳結果集的語句各佔一格、堆疊「同時」顯示；
  // 單語句 / 純 DML / 分析模式只有一筆。activeResult 標記工具列（複製 / 匯出 / 問 AI）作用的結果集。
  const [resultSets, setResultSets] = useState<ResultSetEntry[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const activeIdx = resultSets.length > 0 ? Math.min(activeResult, resultSets.length - 1) : 0;
  const result = resultSets[activeIdx]?.res ?? null;
  // 以單一結果覆蓋結果區（分析模式 / 視覺化解釋回退 / 清空等單結果路徑）；null = 清空。
  const setResult = useCallback((res: QueryResult | null, sql = "") => {
    setResultSets(res ? [{ res, sql, ms: 0 }] : []);
    setActiveResult(0);
  }, []);
  // 執行序號：每次成功寫入新結果集時遞增。多結果格以「序號-索引」為 key，
  // 重跑同形狀批次時整格重掛（重置各格的捲動位置 / 排序 / 篩選，避免新結果停在舊捲動深處像缺列）。
  const [runSeq, setRunSeq] = useState(0);
  // 各結果格摺疊狀態（多結果集時）：摺疊只藏內容不卸載，保留該格排序 / 篩選；新批次到達時重置。
  const [collapsedSets, setCollapsedSets] = useState<Record<number, boolean>>({});
  // 寫入一批新結果集（執行成功、或中途失敗但已有部分結果）：作用中重設為第一格、重置摺疊、遞增序號。
  const applyResultSets = useCallback((sets: ResultSetEntry[]) => {
    setResultSets(sets);
    setActiveResult(0);
    setCollapsedSets({});
    setRunSeq((n) => n + 1);
  }, []);
  // 結果表格目前的可視列（排序 + 篩選後）；複製 / 匯出依此而非原始 result，使輸出與所見一致。
  // 多結果集時只綁「作用中」那格的表格回報。
  const [resultView, setResultView] = useState<(string | null)[][] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 發生錯誤時實際送出的語句（供「AI 分析修正」帶進助手；queryToRun() 之後可能因選取改變而不同）。
  const [errSql, setErrSql] = useState<string | null>(null);
  // 多語句批次中實際出錯的那一條（單句時為 null）；供 AI prompt 與「第 N 條」錯誤訊息對位。
  const [errStmt, setErrStmt] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [nlOpen, setNlOpen] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  // 執行中的即時回饋：經過時間（250ms 更新）與多語句進度「第 N/M 條」。
  const [liveMs, setLiveMs] = useState<number | null>(null);
  const [runProgress, setRunProgress] = useState<{ done: number; total: number } | null>(null);
  // 軟取消：使用者按「停止」後，多語句批次在語句邊界中止（已完成的結果保留）。
  // 單條長查詢無法中斷本端等待（後端取消為 deferred），由查詢逾時設定兜底。
  const cancelRef = useRef(false);
  useEffect(() => {
    if (!running) { setLiveMs(null); return; }
    const t0 = performance.now();
    setLiveMs(0);
    const timer = window.setInterval(() => setLiveMs(performance.now() - t0), 250);
    // 編輯器聚焦時 Esc 也會冒泡到 window：執行中按 Esc = 停止。
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelRef.current = true; };
    window.addEventListener("keydown", onKey);
    return () => { window.clearInterval(timer); window.removeEventListener("keydown", onKey); };
  }, [running]);
  const [history, setHistory] = useState<QueryHistoryEntry[]>(loadQueryHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  // 收藏查詢 / SQL 片段：反應式 store slice（側欄、各查詢分頁、匯入後皆即時同步）。
  const saved = useStore((s) => s.savedQueries);
  const [showSaved, setShowSaved] = useState(false);
  const snippets = useStore((s) => s.snippets);
  const [showSnippets, setShowSnippets] = useState(false);
  // 工具列「更多」溢位選單：收納次要動作（開啟 / 另存 / 收藏 / 壓縮 / 大小寫 / 分析 / 視覺化解釋），讓主列不擁擠。
  const [showMore, setShowMore] = useState(false);
  // 結果列的「複製 ▾」「匯出 ▾」溢位選單：四種複製格式 + 全部結果集動作都收進下拉，主列只留三顆。
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const editorRef = useRef<SqlEditorHandle>(null);
  // 下方分頁（致敬 Navicat 結果 / 摘要 / 解釋）：result=結果表格、summary=執行摘要、explain=視覺化執行計畫。
  const [bottomTab, setBottomTab] = useState<"result" | "summary" | "explain">("result");
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [plan, setPlan] = useState<PlanNode | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  // Mongo 執行計畫（與 SQL 的 plan 分開：階段指標與成本模型不同，各自渲染器）。
  const [mongoPlan, setMongoPlan] = useState<{ model: MongoExplainModel; raw: string } | null>(null);
  // executionStats 會「實際執行」查詢；queryPlanner 只做計畫（便宜），供昂貴管線選用。
  const [mongoVerbosity, setMongoVerbosity] = useState<"queryPlanner" | "executionStats" | "allPlansExecution">("executionStats");
  const mongoEditorRef = useRef<MongoQueryEditorHandle>(null);
  const elasticEditorRef = useRef<ElasticQueryEditorHandle>(null);
  // 視覺化查詢建構器（致敬 Navicat SQL Builder）：僅關聯式（mysql/postgres/sqlite）。
  const [builderOpen, setBuilderOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 編輯器高度：可拖曳分隔線調整（編輯器 ↔ 結果），記憶於 localStorage。
  const editor = useResizable({
    storageKey: "dbkit:editorHeight",
    initial: 176, // 對應原本 h-44
    min: 100,
    max: () => Math.max(160, window.innerHeight * 0.7),
    axis: "y",
  });

  // Esc 關閉歷史 / 收藏 / 更多 / 複製 / 匯出下拉（與選單 / 對話框一致）。
  useEffect(() => {
    if (!showHistory && !showSaved && !showSnippets && !showMore && !showCopyMenu && !showExportMenu) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setShowHistory(false); setShowSaved(false); setShowSnippets(false);
      setShowMore(false); setShowCopyMenu(false); setShowExportMenu(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [showHistory, showSaved, showSnippets, showMore, showCopyMenu, showExportMenu]);

  // 更新並持久化目前連線的查詢內容（使用者輸入 / 載入歷史 / Tab 縮排都走這裡）。
  // 空字串改用 removeItem（而非存 ""）：否則 loadPersistedSql 會把 "" 當「上次內容」回傳，
  // 使該連線永遠開成空白（吃不到預設起手式）。
  const persistSql = (v: string) => {
    setSql(v);
    if (activeId) {
      try {
        if (v) localStorage.setItem(sqlStoreKey(activeId, tabId), v);
        else localStorage.removeItem(sqlStoreKey(activeId, tabId));
      } catch { /* 忽略 */ }
    }
  };

  // AI 生成查詢：SQL 編輯器類型與 Elasticsearch 支援；用本地 claude CLI 把自然語言轉成語句。
  const supportsNlQuery = supportsSqlEditor || kind === "elastic";
  const nlLang: "sql" | "json" = kind === "elastic" ? "json" : "sql";

  // 消費側欄「查詢 log」的一次性自動展開請求（比照下方 pendingSql 消費慣例）。
  // key={activeQueryId} 使 QueryPane 每次切換查詢分頁都是全新掛載，nlOpen 必為初始 false，
  // 故用「掛載時讀一次」而非訂閱式 useStore((s)=>s.pendingNlOpen)，避免其他分頁的旗標誤觸發。
  useEffect(() => {
    if (useStore.getState().pendingNlOpen && supportsNlQuery) {
      useStore.getState().clearPendingNlOpen();
      setNlOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 生成用 prompt：注入 schema（SQL）或 mapping（ES）。選中表 / index 取自側欄節點。
  const buildNlPrompt = async (nlText: string): Promise<string> => {
    const uiLang = useLang.getState().lang;
    const node = useStore.getState().selectedNode;
    if (kind === "elastic") {
      const targetIndex = node && node.type === "table" && node.kind === "elastic" ? node.table : null;
      return buildEsNlPrompt({ connId: activeId!, nl: nlText, targetIndex, uiLang });
    }
    const db = queryDb || connections.find((c) => c.id === activeId)?.database || "";
    const selectedTable = node && node.type === "table" ? node.table : null;
    return buildSqlNlPrompt({ connId: activeId!, kind: kind!, db, nl: nlText, selectedTable, uiLang });
  };
  // 套用生成語句：原草稿非空先存入查詢歷史（同 Ctrl+N 路徑），再填入編輯器。
  const applyNlStatement = (code: string) => {
    if (sql.trim()) setHistory((h) => pushQueryHistory(h, sql, connections.find((c) => c.id === activeId)?.name));
    persistSql(code);
    toast.success(t("已帶入編輯器（原內容已存入歷史）"));
    (kind === "elastic" ? elasticEditorRef : editorRef).current?.focus?.();
  };

  // 切換連線：載入該連線上次的查詢內容（或該類型預設），並清掉殘留結果。
  // 用 raw setSql（非 persistSql），避免把載入動作又寫回 localStorage。
  useEffect(() => {
    setSql(loadPersistedSql(activeId, kind, tabId));
    setResult(null);
    setErr(null);
    setErrSql(null);
    setErrStmt(null);
    setElapsed(null);
    setEditorSel(null); // 清掉前一個連線殘留的選取，避免執行時誤跑舊片段
    // 清掉前一個連線殘留的摘要 / 執行計畫，並退回「結果」分頁（新連線可能不支援解釋分頁）。
    setSummary(null);
    setPlan(null);
    setPlanErr(null);
    setBottomTab("result");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // 切換連線：載入「目前資料庫」清單供選擇器使用，並還原上次的選擇（無則用連線設定的預設 database）。
  useEffect(() => {
    if (!activeId || !supportsDbSelect) { setDbList([]); setQueryDb(""); return; }
    let alive = true;
    const conn = useStore.getState().connections.find((c) => c.id === activeId);
    let restored = "";
    try { restored = localStorage.getItem(queryDbStoreKey(activeId)) || ""; } catch { /* 忽略 */ }
    // PostgreSQL 的選擇器是 schema（list_databases 回 schema 名），conn.database 卻是「資料庫」名，
    // 不可拿來當 search_path 預設（會選到不存在的 schema）→ PG 預設留空（伺服器預設 search_path）。
    const fallback = kind === "postgres" ? "" : (conn?.database || "");
    setQueryDb(restored || fallback);
    api.listDatabases(activeId)
      .then((dbs) => { if (alive) setDbList(dbs); })
      .catch(() => { if (alive) setDbList([]); });
    return () => { alive = false; };
  }, [activeId, supportsDbSelect, kind]);

  // 變更「目前資料庫」並持久化（per 連線）。
  const changeQueryDb = (db: string) => {
    setQueryDb(db);
    if (activeId) { try { localStorage.setItem(queryDbStoreKey(activeId), db); } catch { /* 忽略 */ } }
  };

  // 消費側欄「產生 SQL」送來的待載入語句（在 activeId 載入之後執行，故會覆蓋之）。
  // 空字串 = Ctrl+N 開新查詢：清空前先把目前草稿存進歷史（可從「歷史」救回），避免誤觸永久遺失。
  const pendingSql = useStore((s) => s.pendingSql);
  useEffect(() => {
    if (pendingSql != null) {
      // 空字串＝Ctrl+N / 工具列「新查詢」：清空編輯器、把原草稿存進歷史，並給可見回饋（避免被誤以為沒作用）。
      if (pendingSql === "") {
        const had = sql.trim().length > 0;
        if (had) setHistory((h) => pushQueryHistory(h, sql));
        persistSql("");
        // 開新查詢＝全新起點：一併清掉上一輪的結果 / 錯誤 / 耗時，結果區不殘留舊資料。
        setResult(null); setResultView(null); setErr(null); setErrSql(null); setErrStmt(null); setElapsed(null);
        toast.success(had ? t("已開新查詢（原內容已存入歷史）") : t("已開新查詢"));
        setTimeout(() => editorRef.current?.focus(), 0);
      } else {
        persistSql(pendingSql);
      }
      useStore.getState().clearPendingSql();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSql]);

  // 取得要執行的語句：若編輯器有反白選取，只跑選取段（致敬 DataGrip / DBeaver）。
  // SQL 編輯器（CodeMirror）的選取走 editorSel；mongo/redis textarea 走 taRef。
  const queryToRun = () => {
    if (supportsSqlEditor) {
      if (editorSel?.trim()) return editorSel;
      return sql;
    }
    const ta = taRef.current;
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      const sel = sql.slice(ta.selectionStart, ta.selectionEnd).trim();
      if (sel) return sel;
    }
    return sql;
  };

  // SQL 編輯器送出：有選取→跑選取；F6→整段；否則→跑游標所在語句（Ctrl+Enter）。
  const onEditorSubmit = (s: SqlSubmit) => {
    if (running) return;
    const q = s.selection?.trim() ? s.selection : s.runAll ? sql : statementAtOffset(sql, s.cursorOffset) ?? sql;
    execute("run", q);
  };

  const execute = async (mode: "run" | "analyze", overrideQuery?: string) => {
    if (!activeId || running) return;
    let q = overrideQuery && overrideQuery.trim() ? overrideQuery : queryToRun();
    if (!q.trim()) return;
    // 參數化查詢（致敬 Navicat）：偵測 `:name` 參數，逐一提示輸入後代入（SQL-like 連線）。
    if (kind && (EXPLAIN_KINDS.includes(kind) || kind === "external" || kind === "mssql")) {
      const params = extractNamedParams(q);
      if (params.length) {
        const values: Record<string, string> = {};
        for (const p of params) {
          const v = await uiPrompt(t("參數 :{p} 的值", { p }), { title: t("參數化查詢"), placeholder: `:${p}`, confirmText: t("確定") });
          if (v === null) return; // 任一取消 → 中止整次執行
          values[p] = v;
        }
        q = substituteNamedParams(kind, q, values);
      }
    }
    setErr(null);
    setErrSql(null);
    setErrStmt(null);
    setPlan(null); // 新查詢使先前的視覺化執行計畫失效
    setPlanErr(null);
    setSummary(null); // 清掉前一次的摘要（避免早退路徑殘留舊統計 / 紅色錯誤數）
    setBottomTab("result");
    cancelRef.current = false;
    setRunProgress(null);
    setRunning(true);
    const t0 = performance.now();
    try {
      if (mode === "analyze") {
        // 開跑即清掉上次結果：執行期間顯示 loading 空狀態，避免舊資料被誤認為本次結果。
        setResult(null);
        setResultView(null);
        setResult(await api.explainQuery(activeId, q));
      } else {
        // SQL：拆成多條語句依序執行（sqlx 不允許單次多語句）。
        // 非 SQL（Mongo / Redis）維持單一指令。純註解 / 空白片段已於切分時濾除。
        const isSql = !!kind && (EXPLAIN_KINDS.includes(kind) || kind === "mssql");
        const isSqlLike = isSql || kind === "external"; // external（gateway）也講 SQL，但不走前端切分
        const userStatements = isSql ? splitSqlStatements(q) : [q];
        // 純註解 / 空白（如尾端 `-- 註記`）不是可執行語句 → 不送 DB，避免「Query was empty」類錯誤。
        // isSql 經切分後可能為空；external 未切分，逐條檢查是否全為註解。
        if (isSqlLike && userStatements.every((s) => !hasExecutableSql(s))) {
          toast.info(t("僅含註解，無可執行語句"));
          return;
        }
        // 唯讀連線：擋下任何寫入 / DDL 語句（INSERT/UPDATE/DELETE/CREATE/ALTER/DROP… 與交易控制）。
        const roState = useStore.getState();
        if (isSqlLike && roState.activeId && roState.readonlyConns[roState.activeId] === true && userStatements.some((s) => isWriteStatement(s))) {
          toast.error(t("此連線為唯讀，已擋下寫入 / DDL 語句。可在連線右鍵關閉「唯讀模式」。"));
          return;
        }
        // 「目前資料庫」選擇器：把所選庫以 USE / search_path 前綴併入「每一條」語句一起送出。
        // mysql/postgres driver 會偵測開頭 USE / SET search_path，在「同一條」連線先切庫再執行
        // （避免 USE 與查詢落在 pool 不同連線而失效）；external 由 gateway strip_leading_use 處理。
        // 使用者查詢若已自帶開頭 USE / SET search_path（側欄「新增查詢」）則不重複加。
        const usePrefix =
          supportsDbSelect && queryDb && !/^\s*(use\s|set\s+search_path)/i.test(q)
            ? buildUseDatabase(kind!, queryDb)
            : null;
        const sentStatements = usePrefix ? userStatements.map((s) => `${usePrefix};\n${s}`) : userStatements;
        // 防手滑：無 WHERE 的 UPDATE/DELETE 或 TRUNCATE 會影響整張表，先確認（external 亦講 MySQL，需納入）。
        const dangerCount = isSqlLike ? userStatements.filter((s) => isDangerousStatement(s)).length : 0;
        if (dangerCount > 0) {
          const ok = await uiConfirm(
            t("偵測到 {dangerCount} 條無 WHERE 的 UPDATE / DELETE 或 TRUNCATE，將影響整張表的所有資料列。確定執行？", { dangerCount }),
            { title: t("危險操作確認"), danger: true, confirmText: t("仍要執行") },
          );
          if (!ok) return; // finally 會還原 running 狀態
        }
        // Redis：FLUSHALL / FLUSHDB 會清空資料且無法復原，先確認。
        if (kind === "redis" && isDangerousRedisCommand(q)) {
          const ok = await uiConfirm(
            t("FLUSHALL / FLUSHDB 會清空資料庫且無法復原。確定執行？"),
            { title: t("危險指令確認"), danger: true, confirmText: t("仍要執行") },
          );
          if (!ok) return;
        }
        // 守門全數通過、真正開跑 → 先清掉上次的查詢結果（執行期間顯示 loading 空狀態，
        // 舊資料不再殘留被誤認為本次結果）。提前 return 的路徑（純註解 / 唯讀 / 取消確認）不清。
        setResult(null);
        setResultView(null);
        const sets: ResultSetEntry[] = []; // 每條有結果集（columns>0）的語句各收一格（SSMS 風格堆疊顯示）
        let affected = 0;
        const runs: StmtRun[] = []; // 逐條語句結果（供「摘要」面板；記錄使用者原語句，不含注入的 USE 前綴）
        const startedAt = Date.now();
        const snapshot = (): RunSummary => ({
          startedAt,
          finishedAt: Date.now(),
          // external 整批多結果集對位展開後，摘要列數可能多於語句數（一句 CALL 展成 K 列）。
          total: Math.max(userStatements.length, runs.length),
          processed: runs.length,
          success: runs.filter((r) => r.ok).length,
          errors: runs.filter((r) => !r.ok).length,
          statements: runs.slice(),
        });
        for (let si = 0; si < sentStatements.length; si++) {
          // 軟取消：語句邊界檢查（已完成的結果集保留顯示；停在正在跑的那條之前）。
          if (cancelRef.current) {
            toast.info(t("已在第 {si} 條語句後停止（先前結果已保留）", { si }));
            break;
          }
          if (sentStatements.length > 1) setRunProgress({ done: si, total: sentStatements.length });
          const tStmt = performance.now();
          let resArr: QueryResult[];
          try {
            // 多結果集入口：單結果集驅動回單元素陣列（行為同 runQuery）；
            // external（gateway）整批一次呼叫、MSSQL 的 EXEC 多結果集則回多元素。
            resArr = await api.runQueryMulti(activeId, sentStatements[si]);
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            runs.push({ sql: userStatements[si], ok: false, message: msg, ms: performance.now() - tStmt });
            setSummary(snapshot());
            // SSMS 行為：失敗前已取回的結果集照樣顯示（錯誤橫幅在上、部分結果在下），不必重跑前面的 SELECT。
            if (sets.length > 0) applyResultSets(sets);
            const wrapped = new Error(
              userStatements.length > 1 ? t("第 {n} 條語句失敗：{msg}", { n: si + 1, msg }) : msg,
            );
            // 多語句批次：記住「出錯的那一條」，供 AI 分析修正對位（整批仍存在 errSql）。
            (wrapped as any).failedSql = userStatements[si];
            // 告知外層 catch 已寫入部分結果，別再清空。
            (wrapped as any).keepResults = sets.length > 0;
            throw wrapped;
          }
          const ms = performance.now() - tStmt;
          // 逐集開格：有欄位的結果集各佔一格；無欄位者（DML）累計影響列數。
          // setIdx 記回傳陣列原始索引（含 DML 元素），匯出重跑後取同位。
          const grids: { res: QueryResult; setIdx: number }[] = [];
          let stmtAffected = 0;
          resArr.forEach((r, k) => {
            if (r.columns.length > 0) grids.push({ res: r, setIdx: k });
            else stmtAffected += r.rows_affected;
          });
          affected += stmtAffected;
          // external 整批送出：嘗試以 client 端切分對位各格標籤（僅當語句數 === 結果集數）；
          // 不符（批內含 DML / 一句 CALL 展多集）則各格標整批原文，靠「結果 N」序號區分。
          const stmtLabels =
            kind === "external" && grids.length > 1
              ? (() => {
                  const spans = splitSqlStatementsWithRanges(userStatements[si]);
                  return spans.length === grids.length ? spans.map((x) => x.text) : null;
                })()
              : null;
          // gateway 整批為單一呼叫，無逐句耗時 → 各格（與摘要各列）標整批耗時。
          for (let gi = 0; gi < grids.length; gi++) {
            sets.push({
              res: grids[gi].res,
              sql: stmtLabels ? stmtLabels[gi] : userStatements[si],
              ms,
              sent: sentStatements[si],
              setIdx: grids[gi].setIdx,
            });
          }
          if (stmtLabels) {
            for (let gi = 0; gi < grids.length; gi++) {
              runs.push({ sql: stmtLabels[gi], ok: true, message: t("{length} 列", { length: grids[gi].res.rows.length }), ms });
            }
          } else {
            runs.push({
              sql: userStatements[si],
              ok: true,
              message:
                grids.length > 1
                  ? t("{length} 個結果集", { length: grids.length })
                  : grids.length === 1
                    ? t("{length} 列", { length: grids[0].res.rows.length })
                    : t("OK（影響 {stmtAffected} 列）", { stmtAffected }),
              ms,
            });
          }
        }
        // 有任何結果集 → 全部「同時」顯示（SSMS 風格，多個時堆疊）；否則顯示累計影響列數。
        if (sets.length > 0) applyResultSets(sets);
        else setResult({ columns: [], rows: [], rows_affected: affected }, q);
        setSummary(snapshot());
        if (userStatements.length > 1) toast.success(t("已執行 {length} 條語句", { length: userStatements.length }));
      }
      setElapsed(performance.now() - t0);
      setHistory((h) => pushQueryHistory(h, q, connections.find((c) => c.id === activeId)?.name));
    } catch (e: any) {
      setElapsed(performance.now() - t0);
      setErr(e?.message ?? (mode === "analyze" ? t("分析失敗") : t("查詢失敗")));
      setErrSql(q); // 整批（完整編輯器內容）—供安全一鍵貼回
      setErrStmt((e?.failedSql as string | undefined) ?? null); // 多語句時的失敗單句
      // 中途失敗但已寫入部分結果集（keepResults）→ 保留顯示；其餘照舊清空。
      if (!e?.keepResults) setResult(null);
    } finally {
      setRunning(false);
      setRunProgress(null);
    }
  };

  // 視覺化解釋：跑 EXPLAIN FORMAT=JSON（PG：(FORMAT JSON)），解析成計畫樹後切到「解釋」分頁。
  // 一次只解析「單一語句」：有反白用反白、否則用編輯器內容；多於一條則請使用者反白要解釋的語句。
  const runVisualExplain = async () => {
    if (!activeId || running || !supportsVisualExplain) return;
    const stmts = splitSqlStatements(editorSel?.trim() ? editorSel : sql);
    if (stmts.length > 1) { toast.info(t("視覺化解釋一次只能解析一條語句，請反白要解釋的語句")); return; }
    const base = (stmts[0] ?? "").trim();
    if (!base) { toast.info(t("沒有可解釋的語句")); return; }
    const explainSql = kind ? buildExplainJsonSql(kind, base) : null;
    if (!explainSql) { toast.info(t("此查詢無法產生執行計畫")); return; }
    setRunning(true);
    setPlan(null); // 清掉舊計畫，讓「解釋中…」狀態顯示，避免誤讀前一次的計畫
    setPlanErr(null);
    setErr(null); setErrSql(null); setErrStmt(null); // 清掉前一次查詢的錯誤橫幅，保持分頁一致
    setBottomTab("explain");
    const t0 = performance.now();
    try {
      // 「目前資料庫」前綴併入同段送出（mysql/postgres driver 同連線切庫；external 由 gateway 處理）。
      const usePrefix =
        supportsDbSelect && queryDb && !/^\s*(use\s|set\s+search_path)/i.test(base)
          ? buildUseDatabase(kind!, queryDb)
          : null;
      const res = await api.runQuery(activeId, usePrefix ? `${usePrefix};\n${explainSql}` : explainSql);
      const cell = res.rows?.[0]?.[0] ?? null;
      const node = cell ? parseExplainPlan(kind!, cell) : null;
      if (node) { setPlan(node); setPlanErr(null); }
      else { setPlan(null); setPlanErr(t("無法解析執行計畫 JSON（原始輸出見「結果」分頁）")); setResult(res); setBottomTab("result"); }
      setElapsed(performance.now() - t0);
    } catch (e: any) {
      setElapsed(performance.now() - t0);
      setPlan(null);
      setPlanErr(e?.message ?? t("視覺化解釋失敗"));
    } finally {
      setRunning(false);
    }
  };

  // Mongo 執行計畫：把查詢 DSL（注入 verbosity）原樣送給後端 explain，解析成 stage 樹切到「解釋」分頁。
  // 解析失敗時原始 JSON 落到「結果」分頁（與 SQL 視覺化解釋相同的 fallback 模式）。
  const runMongoExplain = async () => {
    if (!activeId || running || !supportsMongoExplain) return;
    const dsl = sql.trim();
    if (!dsl) { toast.info(t("沒有可解釋的查詢")); return; }
    setRunning(true);
    setMongoPlan(null);
    setPlanErr(null);
    setErr(null); setErrSql(null); setErrStmt(null);
    setBottomTab("explain");
    const t0 = performance.now();
    try {
      const res = await api.explainQuery(activeId, withVerbosity(dsl, mongoVerbosity));
      const raw = res.rows?.[0]?.[0] ?? "";
      const model = raw ? parseMongoExplain(raw) : null;
      if (model) { setMongoPlan({ model, raw }); setPlanErr(null); }
      else {
        setMongoPlan(null);
        setPlanErr(t("無法解析執行計畫 JSON（原始輸出見「結果」分頁）"));
        setResult(res);
        setBottomTab("result");
      }
      setElapsed(performance.now() - t0);
    } catch (e: any) {
      setElapsed(performance.now() - t0);
      setMongoPlan(null);
      setPlanErr(e?.message ?? t("執行計畫失敗"));
    } finally {
      setRunning(false);
    }
  };

  // 收藏目前查詢：開收藏管理視窗的「新增」模式並預填目前 SQL（可一併填名稱 / 分組 / 說明）。
  const saveCurrentQuery = () => {
    const q = sql.trim();
    if (!q) return;
    useStore.getState().openSavedManager({ seedSql: q });
  };
  const deleteSaved = (name: string) => useStore.getState().removeSavedQuery(name);

  // 片段：傳給編輯器的精簡形（穩定 identity，避免每次 render 重建編輯器 extensions）。
  const editorSnippets = useMemo(
    () => snippets.map((s) => ({ name: s.name, body: s.body, desc: s.desc })),
    [snippets],
  );
  // 插入片段到游標處（編輯器）；非 SQL 連線則退而附加到結尾。
  const insertSnippet = (body: string) => {
    if (editorRef.current) editorRef.current.insertText(body);
    else persistSql(sql ? `${sql}\n${body}` : body);
    setShowSnippets(false);
  };
  // 把目前選取（或整段）SQL 存成具名片段。
  const saveAsSnippet = async () => {
    const body = (editorSel ?? sql).trim();
    if (!body) { toast.info(t("沒有可儲存的 SQL")); return; }
    const name = await uiPrompt(t("片段名稱（輸入此名即可自動完成展開）："), { title: t("新增 SQL 片段"), placeholder: t("例如：active_users"), confirmText: t("儲存") });
    if (name === null || !name.trim()) return;
    useStore.getState().addSnippet({ name: name.trim(), body });
    toast.success(t("已新增片段"));
  };
  const deleteSnippet = (name: string) => useStore.getState().removeSnippet(name);

  // 開啟 .sql 檔到編輯器（致敬 Navicat 查詢檔案）。
  const openSqlFile = async () => {
    const path = await pickOpenFile([{ name: "SQL", extensions: ["sql", "txt"] }]);
    if (!path) return;
    try {
      persistSql(await api.readTextFile(path));
      toast.success(t("已開啟檔案"));
    } catch (e: any) {
      toast.error(e?.message ?? t("開啟失敗"));
    }
  };
  // 將目前查詢另存為 .sql 檔。
  const saveSqlFile = async () => {
    if (!sql.trim()) return;
    const path = await pickSaveFile("query.sql", [{ name: "SQL", extensions: ["sql"] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, sql);
      toast.success(t("已另存 SQL"));
    } catch (e: any) {
      toast.error(e?.message ?? t("另存失敗"));
    }
  };

  // 查詢面板快捷鍵：Ctrl/Cmd+S 另存 .sql、Ctrl/Cmd+O 開啟 .sql、Ctrl/Cmd+Shift+F 格式化 SQL
  //（以 ref 取最新函式，listener 只掛一次）。僅在查詢分頁掛載時存在；有對話框開啟時讓路。
  const formatCurrent = () => { if (supportsSqlEditor && sql.trim()) persistSql(formatSql(sql)); };
  const toggleNl = () => { if (supportsNlQuery) setNlOpen((v) => !v); };
  const fileShortcutRef = useRef({ saveSqlFile, openSqlFile, formatCurrent, toggleNl });
  fileShortcutRef.current = { saveSqlFile, openSqlFile, formatCurrent, toggleNl };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (document.body.dataset.modalCount) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey) {
        if (k === "f") { e.preventDefault(); fileShortcutRef.current.formatCurrent(); } // Ctrl/Cmd+Shift+F 格式化
        else if (k === "a") { e.preventDefault(); fileShortcutRef.current.toggleNl(); } // Ctrl/Cmd+Shift+A AI 生成
        return;
      }
      if (k === "s") { e.preventDefault(); fileShortcutRef.current.saveSqlFile(); }
      else if (k === "o") { e.preventDefault(); fileShortcutRef.current.openSqlFile(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // 匯出查詢結果到檔案：依副檔名選 CSV / JSON / TSV / Markdown。
  // 複製 / 匯出的資料來源：若結果表格回報了可視列（且欄數相符）則用之（含排序 / 篩選），否則用原始結果。
  const exportRes =
    result && resultView && (resultView.length === 0 || resultView[0].length === result.columns.length)
      ? { ...result, rows: resultView }
      : result;

  const exportResult = async () => {
    if (!result || result.columns.length === 0 || !exportRes) return;
    const path = await pickSaveFile("query-result.csv", [
      { name: "CSV", extensions: ["csv"] },
      { name: "Excel (.xlsx)", extensions: ["xlsx"] },
      { name: "JSON", extensions: ["json"] },
      { name: "TSV", extensions: ["tsv", "txt"] },
      { name: "SQL (INSERT)", extensions: ["sql"] },
      { name: "Markdown", extensions: ["md"] },
    ]);
    if (!path) return;
    // 依副檔名選格式；統一走後端 export_rows（與表格匯出同一套 render，xlsx 等二進位亦可）。
    const lower = path.toLowerCase();
    const fmt: ExportFormat = lower.endsWith(".xlsx")
      ? "xlsx"
      : lower.endsWith(".json")
      ? "json"
      : lower.endsWith(".md")
      ? "markdown"
      : lower.endsWith(".sql")
      ? "sql"
      : lower.endsWith(".tsv") || lower.endsWith(".txt")
      ? "tsv"
      : "csv";
    const opts = {
      format: fmt,
      include_header: true,
      all_rows: true,
      bom: fmt === "csv" || fmt === "tsv",
      sql_table: fmt === "sql" ? "result" : null,
    };
    try {
      // 結果被後端 row cap 截斷、且畫面未做 client-side 排序 / 篩選、語句為唯讀時 →
      // 走 export_query 由後端重新執行取「完整」結果寫檔（上限 100 萬列，不經 IPC 往返）。
      // 有排序 / 篩選（所見即所得契約）或寫入語句（避免重執行副作用）→ 照舊匯出畫面資料。
      const entry = resultSets[activeIdx];
      const viewFiltered = !!resultView && resultView.length !== result.rows.length;
      const canRerun =
        !!activeId && !!entry?.res.truncated && !!(entry.sent ?? entry.sql) &&
        !viewFiltered && !isWriteStatement(entry.sql);
      if (canRerun) {
        const res = await api.exportQuery(activeId, entry.sent ?? entry.sql, opts, path);
        toast.success(t("已重新執行查詢並匯出完整結果 {rows} 列 · {toUpperCase}", { rows: res.rows, toUpperCase: fmt.toUpperCase() }));
      } else {
        const res = await api.exportRows(exportRes.columns, exportRes.rows, opts, path);
        toast.success(t("已匯出 {rows} 列 · {toUpperCase}", { rows: res.rows, toUpperCase: fmt.toUpperCase() }));
      }
    } catch (e: any) {
      toast.error(e?.message ?? t("匯出失敗"));
    }
  };

  // 全部匯出：多語句批次的所有結果集一次寫檔。xlsx 單檔多工作表（結果1..N）、
  // markdown / json / sql 單檔分節、csv / tsv 拆編號多檔（{base}-1..-N，單檔無法表達多張異構表）。
  // 各格用原始結果（client 端排序 / 篩選僅綁作用中格，單格匯出才吃）；截斷的格照畫面資料匯出並提示。
  const exportAllResults = async () => {
    if (resultSets.length < 2) return;
    const path = await pickSaveFile("query-results.xlsx", [
      { name: "Excel (.xlsx)", extensions: ["xlsx"] },
      { name: "CSV", extensions: ["csv"] },
      { name: "JSON", extensions: ["json"] },
      { name: "TSV", extensions: ["tsv", "txt"] },
      { name: "SQL (INSERT)", extensions: ["sql"] },
      { name: "Markdown", extensions: ["md"] },
    ]);
    if (!path) return;
    const lower = path.toLowerCase();
    const fmt: ExportFormat = lower.endsWith(".xlsx")
      ? "xlsx"
      : lower.endsWith(".json")
      ? "json"
      : lower.endsWith(".md")
      ? "markdown"
      : lower.endsWith(".sql")
      ? "sql"
      : lower.endsWith(".tsv") || lower.endsWith(".txt")
      ? "tsv"
      : "csv";
    const opts = {
      format: fmt,
      include_header: true,
      all_rows: true,
      bom: fmt === "csv" || fmt === "tsv",
      sql_table: fmt === "sql" ? "result" : null,
    };
    try {
      const sets = resultSets.map((s) => ({ sql: s.sql, columns: s.res.columns, rows: s.res.rows }));
      const res = await api.exportRowsMulti(sets, opts, path);
      // csv/tsv 拆成編號多檔（使用者選的 base 檔名本身不會產生）→ 明示實際檔名樣式，免得找不到檔案。
      const firstName = res.path.replace(/^.*[\\/]/, "");
      const files =
        fmt === "csv" || fmt === "tsv"
          ? t(" · 已拆成 {length} 個檔案（{firstName} … -{v3}）", { length: resultSets.length, firstName, v3: resultSets.length })
          : "";
      const truncNote = resultSets.some((s) => s.res.truncated) ? t("；內含已截斷結果集（僅匯出畫面資料）") : "";
      toast.success(t("已匯出 {length} 個結果集 · 共 {toLocaleString} 列 · {toUpperCase}{files}{truncNote}", { length: resultSets.length, toLocaleString: res.rows.toLocaleString(), toUpperCase: fmt.toUpperCase(), files, truncNote }));
    } catch (e: any) {
      toast.error(e?.message ?? t("匯出失敗"));
    }
  };

  // 複製全部：所有結果集串成 Markdown 分節（## 結果 N + 原 SQL + 表格）進剪貼簿 —
  // 貼文件 / Jira / AI 都可直接讀（CSV/TSV 混多表頭貼上會壞，故剪貼簿統一用 MD）。
  const copyAllResults = () => {
    if (resultSets.length < 2) return;
    const md = resultSets
      .map((s, i) => `## ${t("結果")} ${i + 1}\n\n\`\`\`sql\n${s.sql.trim()}\n\`\`\`\n\n${resultToMarkdown(s.res)}`)
      .join("\n\n");
    copyToClipboard(md, t("已複製 {length} 個結果集 (Markdown)", { length: resultSets.length }));
  };

  // 把目前查詢與結果（限前 30 列）帶進 AI 助手分析。
  const askAiResult = () => {
    if (!result || result.columns.length === 0 || !exportRes) return;
    const MAX = 30;
    const limited: QueryResult = { ...exportRes, rows: exportRes.rows.slice(0, MAX) };
    const note = exportRes.rows.length > MAX ? t("\n（僅附前 {MAX} 列，共 {length} 列）", { MAX, length: exportRes.rows.length }) : "";
    // 多結果集：帶「作用中」那格對應的單條語句，讓 AI 拿到的查詢與結果一一對應。
    const srcSql = resultSets.length > 1 && resultSets[activeIdx]?.sql ? resultSets[activeIdx].sql : queryToRun();
    const prompt =
      t("以下是我在 db-kit 執行的查詢與結果，請幫我分析（資料意義、可能的異常或趨勢、可優化的查詢寫法，並可建議下一步查詢）：\n\n") +
      t("查詢：\n```sql\n{srcSql}\n```\n\n結果：\n{limited}{note}", { srcSql, limited: resultToMarkdown(limited), note });
    useAssistant.getState().ask(prompt);
  };

  // 把出錯的 SQL + 錯誤訊息帶進 AI 助手，請它分析原因並給出修正後的 SQL（一鍵自動送出）。
  const askAiFixError = () => {
    if (!err) return;
    const dialect = kind === "external" ? t("MySQL（透過 External gateway）") : (kind ?? "SQL");
    const full = errSql ?? queryToRun();
    // 多語句批次：errStmt 為失敗的那一條，與整批不同 → 同時給「失敗單句」與「完整批次」，
    // 讓 AI 不必自己數第幾條，並要求回傳完整批次以利一鍵貼回（不丟失其他正確語句）。
    const multi = !!errStmt && errStmt.trim() !== "" && errStmt.trim() !== full.trim();
    const sqlSection = multi
      ? t("這是多語句批次，失敗的是其中這一條（請回傳修正後的【完整批次】，保留其他正確語句）：\n") +
        t("```sql\n{errStmt}\n```\n\n完整批次：\n```sql\n{full}\n```\n\n", { errStmt, full })
      : `SQL：\n\`\`\`sql\n${full}\n\`\`\`\n\n`;
    const prompt =
      t("以下 SQL 在 db-kit 執行時發生錯誤。請幫我：①用中文簡述錯誤原因；") +
      t("②給出修正後、可直接執行的 SQL（放進 ```sql 程式碼區塊，方便我一鍵貼回編輯器）。\n\n") +
      t("資料庫類型：{dialect}\n\n", { dialect }) +
      sqlSection +
      t("錯誤訊息：\n```\n{err}\n```", { err });
    useAssistant.getState().ask(prompt, { send: true });
  };

  if (!activeId) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg/25 text-sm">
        {t("請先選取一個已連線的連線。")}
      </div>
    );
  }

  const rowsInfo =
    resultSets.length > 1
      ? t("{length} 個結果集 · 共 {toLocaleString} 列", { length: resultSets.length, toLocaleString: resultSets.reduce((n, s) => n + s.res.rows.length, 0).toLocaleString() })
      : result &&
        (result.columns.length > 0
          ? t("{length} 列", { length: result.rows.length })
          : t("影響 {rows_affected} 列", { rows_affected: result.rows_affected }));

  // 連線選擇器清單：已連線的連線（含目前 activeId，即使尚未在 connectedIds 也保留，避免下拉空白）。
  const runnableConns = connections.filter((c) => connectedIds.has(c.id) || c.id === activeId);

  return (
    // min-h-0：column flex item 預設 min-height:auto 不會小於內容高，結果列一多整個面板
    // 會撐破視窗（畫過狀態列）；鎖住後高度交給內層「結果」容器的 overflow-auto 捲動。
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="shrink-0">
        <div className="flex items-center justify-between px-3 py-1.5 bg-bar">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-fg/40 shrink-0">{t("查詢")}</span>
            {runnableConns.length > 0 && (
              <Select
                selectSize="sm"
                value={activeId ?? ""}
                onChange={(e) => useStore.getState().setActive(e.target.value)}
                title={t("目前連線：查詢執行的目標連線（Ctrl+Shift+N 新增連線）")}
                className="max-w-[180px] text-xs"
              >
                {runnableConns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            )}
            {activeReadonly && (
              <span className="text-[10px] px-1 rounded bg-amber-400/20 text-amber-300/90 shrink-0" title={t("此連線為唯讀模式：擋寫入 / DDL")}>{t("唯讀")}</span>
            )}
            {supportsDbSelect && (
              <Select
                selectSize="sm"
                value={queryDb}
                onChange={(e) => changeQueryDb(e.target.value)}
                title={t("目前資料庫：查詢會以 USE / search_path 限定到所選資料庫")}
                className="max-w-[180px] text-xs"
              >
                <option value="">{kind === "postgres" ? t("（預設 schema）") : t("（預設資料庫）")}</option>
                {/* 確保目前選取值即使尚未載入清單 / 已不在清單也仍顯示 */}
                {queryDb && !dbList.includes(queryDb) && <option value={queryDb}>{queryDb}</option>}
                {dbList.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            )}
          </div>
          <div className="flex flex-wrap justify-end items-center gap-x-1.5 gap-y-1 [&>*]:shrink-0 [&_button]:whitespace-nowrap">
            <button type="button" onClick={openNodeScopedQueryTab}
              title={t("開新查詢分頁：依目前選取的連線 / 資料庫 / 資料表帶入範圍（Ctrl+N）")}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70">
              <Icon icon={FilePlus2} size={13} />{t("新查詢")}
            </button>
            <div className="w-px self-stretch my-1 bg-fg/10" />
            <div className="relative">
              <button type="button" onClick={() => setShowHistory((s) => !s)}
                disabled={history.length === 0}
                title={t("查詢歷史")}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 disabled:opacity-30">
                <Icon icon={History} size={13} />{t("歷史")}{history.length ? `（${history.length}）` : ""}
              </button>
              {showHistory && history.length > 0 && (
                <>
                  <div className="fixed inset-0 z-[89]" onClick={() => setShowHistory(false)} />
                  <div className="absolute right-0 mt-1 z-[90] w-[460px] max-h-[360px] overflow-auto bg-elevated border border-fg/10 rounded-lg shadow-2xl py-1">
                    <div className="flex items-center justify-between gap-2 px-3 py-1 text-[11px] text-fg/40 border-b border-fg/10">
                      <span className="shrink-0">{t("最近查詢")}</span>
                      <input
                        autoFocus
                        value={historyFilter}
                        onChange={(e) => setHistoryFilter(e.target.value)}
                        placeholder={t("輸入以過濾…")}
                        className="flex-1 min-w-0 bg-inset border border-fg/10 rounded px-2 py-0.5 text-xs text-fg/80 outline-none focus:border-accent/60"
                      />
                      <button type="button"
                        onClick={() => { setHistory([]); try { localStorage.removeItem(QUERY_HISTORY_KEY); } catch {} setShowHistory(false); }}
                        className="hover:text-fg/80 shrink-0">{t("清除")}</button>
                    </div>
                    {history
                      .filter((h) => !historyFilter.trim() || h.sql.toLowerCase().includes(historyFilter.trim().toLowerCase()))
                      .map((h, i) => (
                        <button key={i} type="button"
                          onClick={() => { persistSql(h.sql); setShowHistory(false); }}
                          title={h.sql}
                          className="flex w-full items-baseline gap-2 text-left px-3 py-1.5 text-xs hover:bg-fg/10">
                          <span className="mono text-fg/70 truncate flex-1">{h.sql}</span>
                          {h.connName && <span className="text-fg/35 shrink-0 max-w-[90px] truncate">{h.connName}</span>}
                          <span className="text-fg/30 shrink-0 tabular-nums">{fmtRelativeTime(h.at)}</span>
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
            <div className="relative">
              <button type="button" onClick={() => setShowSaved((s) => !s)}
                title={t("收藏的查詢")}
                className="text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70">
                {t("收藏")}{saved.length ? `（${saved.length}）` : ""}
              </button>
              {showSaved && (
                <>
                  <div className="fixed inset-0 z-[89]" onClick={() => setShowSaved(false)} />
                  <div className="absolute right-0 mt-1 z-[90] w-[420px] max-h-[320px] overflow-auto bg-elevated border border-fg/10 rounded-lg shadow-2xl py-1">
                    <div className="flex items-center justify-between px-3 py-1 text-[11px] text-fg/40 border-b border-fg/10">
                      <span>{t("收藏的查詢")}</span>
                      <button type="button" onClick={() => { setShowSaved(false); useStore.getState().openSavedManager(); }}
                        className="inline-flex items-center gap-1 text-accent hover:underline">
                        <Icon icon={Cog} size={11} />{t("管理 / 匯入匯出")}
                      </button>
                    </div>
                    {saved.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-fg/40">{t("尚無收藏。用「更多 → 收藏目前查詢」新增，或按上方「管理」匯入。")}</div>
                    ) : (() => {
                      // 依 group 分組顯示（未分組置底、組內依名稱排序）。
                      const gmap = new Map<string, SavedQuery[]>();
                      for (const q of saved) {
                        const g = q.group?.trim() || "";
                        if (!gmap.has(g)) gmap.set(g, []);
                        gmap.get(g)!.push(q);
                      }
                      const named = [...gmap.keys()].filter((g) => g).sort((a, b) => a.localeCompare(b));
                      const order = gmap.has("") ? [...named, ""] : named;
                      const showHeaders = named.length > 0;
                      const rowOf = (q: SavedQuery) => (
                        <div key={q.name} className="group flex items-center hover:bg-fg/10">
                          <button type="button"
                            onClick={() => { persistSql(q.sql); setShowSaved(false); }}
                            title={q.sql}
                            className="flex-1 inline-flex items-center gap-1.5 text-left px-3 py-1.5 text-xs truncate">
                            <Icon icon={Star} size={12} className="text-amber-300 shrink-0" /><span className="truncate">{q.name}</span>
                          </button>
                          <button type="button" onClick={() => { setShowSaved(false); useStore.getState().openSavedManager({ editName: q.name }); }} title={t("編輯")} aria-label={t("編輯")}
                            className="px-1.5 text-fg/30 hover:text-fg/80"><Icon icon={Pencil} size={13} /></button>
                          <button type="button" onClick={() => deleteSaved(q.name)} title={t("刪除收藏")} aria-label={t("刪除收藏")}
                            className="px-2 text-fg/30 hover:text-red-400"><Icon icon={X} size={13} /></button>
                        </div>
                      );
                      return order.map((g) => (
                        <div key={g || "__ungrouped__"}>
                          {showHeaders && (
                            <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-fg/35">{g || t("（未分組）")}</div>
                          )}
                          {gmap.get(g)!.slice().sort((a, b) => a.name.localeCompare(b.name)).map(rowOf)}
                        </div>
                      ));
                    })()}
                  </div>
                </>
              )}
            </div>
            {supportsSqlEditor && (
              <div className="relative">
                <button type="button" onClick={() => setShowSnippets((s) => !s)}
                  title={t("SQL 片段：插入常用骨架（編輯器內輸入片段名亦可自動完成展開）")}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70">
                  <Icon icon={FileCode2} size={13} />{t("片段")}
                </button>
                {showSnippets && (
                  <>
                    <div className="fixed inset-0 z-[89]" onClick={() => setShowSnippets(false)} />
                    <div className="absolute right-0 mt-1 z-[90] w-[460px] max-h-[360px] overflow-auto bg-elevated border border-fg/10 rounded-lg shadow-2xl py-1">
                      <div className="flex items-center justify-between px-3 py-1 text-[11px] text-fg/40 border-b border-fg/10">
                        <span>{t("SQL 片段（點擊插入游標處）")}</span>
                        <button type="button" onClick={saveAsSnippet} className="inline-flex items-center gap-1 text-accent hover:underline">
                          <Icon icon={Plus} size={11} />{t("從選取 / 目前 SQL 新增")}
                        </button>
                      </div>
                      {snippets.map((s) => (
                        <div key={s.name} className="group flex items-start hover:bg-fg/10">
                          <button type="button" onClick={() => insertSnippet(s.body)} title={s.body}
                            className="flex-1 text-left px-3 py-1.5 min-w-0">
                            <div className="flex items-center gap-1.5 text-xs">
                              <Icon icon={FileCode2} size={12} className="text-sky-300 shrink-0" />
                              <span className="mono truncate">{s.name}</span>
                              {s.desc && <span className="text-fg/40 truncate">— {t(s.desc)}</span>}
                              {s.builtin && <span className="ml-auto text-[9px] text-fg/30 px-1 rounded bg-fg/10 shrink-0">{t("內建")}</span>}
                            </div>
                          </button>
                          {!s.builtin && (
                            <button type="button" onClick={() => deleteSnippet(s.name)} title={t("刪除片段")} aria-label={t("刪除片段")}
                              className="px-2 py-1.5 text-fg/30 hover:text-red-400"><Icon icon={X} size={13} /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {supportsExplain && (
              <button type="button" onClick={() => setBuilderOpen(true)} disabled={running}
                title={t("視覺化查詢建構器：勾選表 / 欄、視覺化 JOIN、條件 / 排序 / 聚合，產生 SELECT 並帶入編輯器")}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 disabled:opacity-40">
                <Icon icon={Blocks} size={13} />{t("建構器")}
              </button>
            )}
            {supportsNlQuery && (
              <button type="button" onClick={() => setNlOpen((v) => !v)}
                title={t("用自然語言生成查詢語句（本地 Claude CLI）(Ctrl+Shift+A)")}
                className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                  nlOpen ? "border-accent/50 bg-accent/12 text-accent" : "border-fg/15 hover:bg-fg/10 text-fg/70"}`}>
                <Icon icon={Sparkles} size={13} />{t("AI 生成")}
              </button>
            )}
            {supportsSqlEditor && (
              <button type="button" onClick={() => persistSql(formatSql(sql))} disabled={running || !sql.trim()}
                title={t("格式化 SQL：主要子句換行（僅調整字面值外空白，不改語意）(Ctrl+Shift+F)")}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 disabled:opacity-40">
                <Icon icon={Wand2} size={13} />{t("格式化")}
              </button>
            )}
            <div className="relative">
              <button type="button" onClick={() => setShowMore((s) => !s)}
                title={t("更多工具：檔案 / 收藏 / SQL 轉換 / 執行計畫")}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70">
                <Icon icon={MoreHorizontal} size={13} />{t("更多")}
              </button>
              {showMore && (
                <>
                  <div className="fixed inset-0 z-[89]" onClick={() => setShowMore(false)} />
                  <div className="absolute right-0 mt-1 z-[90] w-56 bg-elevated border border-fg/10 rounded-lg shadow-2xl py-1">
                    <div className="px-3 py-1 text-[11px] text-fg/40">{t("檔案 / 收藏")}</div>
                    <button type="button" onClick={() => { setShowMore(false); openSqlFile(); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10">
                      <Icon icon={FolderOpen} size={13} className="text-fg/45" />{t("開啟 .sql 檔…")}
                    </button>
                    <button type="button" onClick={() => { setShowMore(false); saveSqlFile(); }} disabled={!sql.trim()}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10 disabled:opacity-40">
                      <Icon icon={Save} size={13} className="text-fg/45" />{t("另存為 .sql 檔…")}
                    </button>
                    <button type="button" onClick={() => { setShowMore(false); saveCurrentQuery(); }} disabled={!sql.trim()}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10 disabled:opacity-40">
                      <Icon icon={Star} size={13} className="text-fg/45" />{t("收藏目前查詢…")}
                    </button>
                    <button type="button" onClick={() => { setShowMore(false); useStore.getState().openSavedManager(); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10">
                      <Icon icon={Cog} size={13} className="text-fg/45" />{t("管理收藏 / 匯入匯出…")}
                    </button>
                    {supportsSqlEditor && (
                      <>
                        <div className="px-3 py-1 mt-1 text-[11px] text-fg/40 border-t border-fg/10">{t("SQL 轉換")}</div>
                        <button type="button" onClick={() => { setShowMore(false); persistSql(minifySql(sql)); }} disabled={!sql.trim()}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10 disabled:opacity-40">
                          <Icon icon={FileText} size={13} className="text-fg/45" />{t("壓縮成單行")}
                        </button>
                        <button type="button" onClick={() => { setShowMore(false); persistSql(transformKeywordCase(sql, true)); }} disabled={!sql.trim()}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10 disabled:opacity-40">
                          <span className="w-[13px] text-center text-fg/45 font-bold text-[10px]">AB</span>{t("關鍵字轉大寫")}
                        </button>
                        <button type="button" onClick={() => { setShowMore(false); persistSql(transformKeywordCase(sql, false)); }} disabled={!sql.trim()}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10 disabled:opacity-40">
                          <span className="w-[13px] text-center text-fg/45 font-bold text-[10px]">ab</span>{t("關鍵字轉小寫")}
                        </button>
                      </>
                    )}
                    {(supportsExplain || supportsVisualExplain || supportsMongoExplain) && (
                      <div className="px-3 py-1 mt-1 text-[11px] text-fg/40 border-t border-fg/10">{t("執行計畫")}</div>
                    )}
                    {supportsExplain && (
                      <button type="button" onClick={() => { setShowMore(false); execute("analyze"); }} disabled={running}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10 disabled:opacity-40">
                        <Icon icon={FlaskConical} size={13} className="text-fg/45" />{t("分析（EXPLAIN 表格）")}
                      </button>
                    )}
                    {supportsVisualExplain && (
                      <button type="button" onClick={() => { setShowMore(false); runVisualExplain(); }} disabled={running}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10 disabled:opacity-40">
                        <Icon icon={GitBranch} size={13} className="text-fg/45" />{t("視覺化解釋")}
                      </button>
                    )}
                    {supportsMongoExplain && (
                      <>
                        {/* 詳細度：executionStats 會「實際執行」查詢（昂貴管線改選 queryPlanner）。 */}
                        <div className="flex items-center gap-2 px-3 py-1.5 text-xs" onClick={(e) => e.stopPropagation()}>
                          <span className="text-fg/45 shrink-0">{t("詳細度")}</span>
                          <select value={mongoVerbosity}
                            onChange={(e) => setMongoVerbosity(e.target.value as typeof mongoVerbosity)}
                            title={t("executionStats / allPlansExecution 會實際執行查詢；queryPlanner 只做計畫（便宜）")}
                            className="flex-1 min-w-0 bg-inset border border-fg/10 rounded px-1 py-0.5 text-xs outline-none cursor-pointer">
                            <option value="executionStats">{t("executionStats（實際執行）")}</option>
                            <option value="queryPlanner">{t("queryPlanner（僅計畫）")}</option>
                            <option value="allPlansExecution">{t("allPlansExecution（所有候選）")}</option>
                          </select>
                        </div>
                        <button type="button" onClick={() => { setShowMore(false); runMongoExplain(); }} disabled={running}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-fg/75 hover:bg-fg/10 disabled:opacity-40">
                          <Icon icon={GitBranch} size={13} className="text-fg/45" />{t("執行計畫（explain）")}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            {paramCount > 0 && (
              <span className="text-[11px] text-sky-300/80 px-1" title={t("偵測到具名參數 :name；執行時會逐一提示輸入並安全代入")}>
                ⟨{paramCount} {t("參數⟩")}
              </span>
            )}
            {running ? (
              <button type="button"
                // 執行中變紅色「停止」（軟取消）：多語句批次於語句邊界中止、保留已完成結果；
                // 單條長查詢無法中斷（由查詢逾時兜底）。Esc 同效。
                onClick={() => { cancelRef.current = true; }}
                title={t("停止（Esc）：於下一條語句前中止，已完成的結果保留")}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-600/80 hover:bg-red-600">
                <Icon icon={Square} size={13} />
                {t("停止")}{runProgress ? t("（第 {done}/{total} 條）", { done: runProgress.done + 1, total: runProgress.total }) : ""}
              </button>
            ) : (
              <button type="button"
                // SQL 編輯器：綠鈕對齊 F6——有選取只跑選取段，否則整段全跑；
                // 只跑「游標所在語句」請按 Ctrl+Enter。
                // 非 SQL（mongo / redis textarea）維持單一指令直接執行。
                // 編輯器 lazy chunk 尚未掛載（editorRef 為 null）時退回 execute("run") 整段執行，避免點擊靜默無效。
                onClick={() => supportsSqlEditor && editorRef.current ? editorRef.current.submit(true) : execute("run")}
                title={t("執行整段（F6）；有選取時只跑選取段；游標所在語句請按 Ctrl+Enter")}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-600/80 hover:bg-green-600 disabled:opacity-50">
                <Icon icon={Play} size={13} />
                {t("執行 (F6)")}
              </button>
            )}
          </div>
        </div>
        {supportsNlQuery && nlOpen && (
          <Suspense fallback={null}>
            <NlQueryBar
              open={nlOpen}
              onClose={() => setNlOpen(false)}
              lang={nlLang}
              buildPrompt={buildNlPrompt}
              onApply={applyNlStatement}
              lastError={err ? { message: err, sql: errStmt ?? errSql ?? sql } : null}
            />
          </Suspense>
        )}
        {supportsSqlEditor ? (
          // SQL（mysql/postgres/sqlite/mssql/oracle/external gateway）：CodeMirror 編輯器 — 語法高亮 +
          // 行號 + 即時檢查 + 表/欄自動完成；F6 整段、Ctrl+Enter 游標所在語句或選取段、Ctrl+/ 註解、Tab 縮排。
          <div style={{ height: editor.size }} className="overflow-hidden bg-app border-t border-fg/10">
            <Suspense fallback={<div className="h-full w-full bg-well/50 animate-pulse" />}>
              <SqlEditor
                ref={editorRef}
                value={sql}
                onChange={persistSql}
                kind={kind!}
                schema={schema}
                snippets={editorSnippets}
                onSubmit={onEditorSubmit}
                onSelectionChange={setEditorSel}
                autoFocus
                placeholder={t("SQL 查詢（F6 整段、Ctrl+Enter 執行游標所在語句／選取段；Ctrl+/ 註解、Tab 縮排）")}
              />
            </Suspense>
          </div>
        ) : kind === "mongo" ? (
          // Mongo：CodeMirror JSON 編輯器 — 語法高亮 + 即時 JSON lint + DSL 鍵 / $運算子 / 欄位名補全。
          <div style={{ height: editor.size }} className="overflow-hidden bg-app border-t border-fg/10">
            <Suspense fallback={<div className="h-full w-full bg-well/50 animate-pulse" />}>
              <MongoQueryEditor
                ref={mongoEditorRef}
                value={sql}
                onChange={persistSql}
                connId={activeId}
                onSubmit={() => execute("run")}
                autoFocus
                placeholder={t("find：{ \"db\":\"..\", \"collection\":\"..\", \"filter\":{}, \"sort\":{}, \"limit\":200 }　|　聚合：{ …, \"pipeline\":[ { \"$match\":{} } ] }　|　插入：{ …, \"insert\":[ { \"k\":\"v\" } ] }（F6 / Ctrl+Enter 執行）")}
              />
            </Suspense>
          </div>
        ) : kind === "elastic" ? (
          // Elasticsearch：CodeMirror JSON 編輯器 — Query DSL envelope（頂層 "index" + search body）。
          <div style={{ height: editor.size }} className="overflow-hidden bg-app border-t border-fg/10">
            <Suspense fallback={<div className="h-full w-full bg-well/50 animate-pulse" />}>
              <ElasticQueryEditor
                ref={elasticEditorRef}
                value={sql}
                onChange={persistSql}
                connId={activeId}
                onSubmit={() => execute("run")}
                autoFocus
                placeholder={t("查詢：{ \"index\":\"logs-*\", \"query\":{ \"match\":{ \"msg\":\"error\" } }, \"size\":200, \"sort\":[{ \"@timestamp\":\"desc\" }] }　|　計數：{ \"index\":\"..\", \"count\":true, \"query\":{} }（F6 / Ctrl+Enter 執行）")}
              />
            </Suspense>
          </div>
        ) : (
          <textarea
            ref={taRef}
            style={{ height: editor.size }}
            className="block w-full bg-app p-3 outline-none mono text-sm border-t border-fg/10 focus:bg-well"
            value={sql}
            onChange={(e) => persistSql(e.target.value)}
            spellCheck={false}
            placeholder={t("Redis 指令，如 GET key、HGETALL key、SCAN 0（前綴 1: 可指定 DB）")}
            onKeyDown={(e) => {
              if (e.key === "F6" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
                e.preventDefault();
                execute("run");
              } else if (e.key === "Tab") {
                // Tab 插入兩個空格（而非跳離編輯器），符合指令編輯習慣。
                e.preventDefault();
                const ta = e.currentTarget;
                const s = ta.selectionStart;
                const en = ta.selectionEnd;
                const next = sql.slice(0, s) + "  " + sql.slice(en);
                persistSql(next);
                requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
              }
            }}
          />
        )}
        {/* 狀態列已併入下方分頁列右側 */}
      </div>
      <Splitter axis="y" onPointerDown={editor.onPointerDown} />
      <div className="flex-1 flex flex-col min-h-0">
        {/* 下方分頁列：結果 / 摘要 / 解釋（致敬 Navicat）；右側為執行回饋與複製 / 匯出 */}
        <div className="shrink-0 flex flex-wrap items-center gap-x-1 gap-y-1 px-2 py-0.5 bg-panel border-t border-fg/10 text-[11px]">
          {((["result", "summary", ...(supportsVisualExplain || supportsMongoExplain ? (["explain"] as const) : [])]) as ("result" | "summary" | "explain")[]).map((key) => {
            const label = key === "result" ? t("結果") : key === "summary" ? t("摘要") : t("解釋");
            return (
              <button key={key} type="button" onClick={() => setBottomTab(key)}
                className={`px-2.5 py-1.5 border-b-2 -mb-px transition-colors ${bottomTab === key ? "border-accent text-fg/90" : "border-transparent text-fg/45 hover:text-fg/70"}`}>
                {label}
                {key === "summary" && summary && summary.errors > 0 && <span className="ml-1 text-red-400">{summary.errors}</span>}
                {key === "explain" && (plan || mongoPlan) && <span className="ml-1 text-emerald-400">●</span>}
              </button>
            );
          })}
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-fg/45 pr-1">
            {running && liveMs !== null ? (
              <span className="inline-flex items-center gap-1 text-fg/70" title={t("執行中經過時間")}>
                <Icon icon={Loader2} size={12} className="animate-spin" />
                {runProgress ? t("第 {done}/{total} 條 · ", { done: runProgress.done + 1, total: runProgress.total }) : ""}{fmtElapsed(liveMs)}
              </span>
            ) : elapsed !== null && <span className="inline-flex items-center gap-1" title={t("執行時間")}><Icon icon={Clock} size={12} />{fmtElapsed(elapsed)}</span>}
            {bottomTab === "result" && result?.truncated && (
              <span className="inline-flex items-center gap-1.5 text-amber-400/90"
                title={t("後端已於列數上限截斷（防止大結果集塞爆記憶體；上限可於設定調整；取完整結果請用匯出）")}>
                {t("已截斷於 {n} 列", { n: result.rows.length.toLocaleString() })}
              </span>
            )}
            {bottomTab === "result" && rowsInfo && <span>{rowsInfo}</span>}
            {bottomTab === "result" && result && result.columns.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {resultSets.length > 1 && (
                  <button type="button"
                    onClick={() => document.querySelector(`[data-result-section="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" })}
                    className="text-accent/80 hover:text-accent"
                    title={t("複製 / 匯出 / 問 AI 作用於此結果集（點任一結果格可切換）；點此捲至該格")}>
                    {t("結果")} {activeIdx + 1}
                  </button>
                )}
                {/* 複製 ▾：主鍵直接複製 CSV（最常用），四種格式與「全部結果集」收進下拉，主列不再平鋪四顆。 */}
                <div className="relative">
                  <button type="button" onClick={() => setShowCopyMenu((s) => !s)}
                    title={t("複製目前所見（含排序 / 篩選）")}
                    className="inline-flex items-center gap-1 hover:text-fg/80">
                    <Icon icon={Copy} size={12} />{t("複製")}<Icon icon={ChevronDown} size={11} className="text-fg/40" />
                  </button>
                  {showCopyMenu && (
                    <>
                      <div className="fixed inset-0 z-[89]" onClick={() => setShowCopyMenu(false)} />
                      <div className="absolute right-0 bottom-full mb-1 z-[90] w-52 bg-elevated border border-fg/10 rounded-lg shadow-2xl py-1 text-xs">
                        {([
                          ["CSV", resultToCsv, t("已複製結果 (CSV)")],
                          ["TSV", resultToTsv, t("已複製結果 (TSV)")],
                          ["JSON", resultToJson, t("已複製結果 (JSON)")],
                          ["Markdown", resultToMarkdown, t("已複製結果 (Markdown)")],
                        ] as [string, (r: QueryResult) => string, string][]).map(([label, fn, msg]) => (
                          <button key={label} type="button"
                            onClick={() => { setShowCopyMenu(false); if (exportRes) copyToClipboard(fn(exportRes), msg); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg/75 hover:bg-fg/10">
                            <Icon icon={Copy} size={12} className="text-fg/45" />{t("複製為")} {label}
                          </button>
                        ))}
                        {resultSets.length > 1 && (
                          <button type="button" onClick={() => { setShowCopyMenu(false); copyAllResults(); }}
                            title={t("把全部結果集串成 Markdown 分節複製（## 結果 N + 原 SQL + 表格）")}
                            className="flex w-full items-center gap-2 px-3 py-1.5 mt-1 text-left text-accent/90 hover:bg-fg/10 border-t border-fg/10">
                            <Icon icon={Copy} size={12} className="text-accent/60" />{t("複製全部結果集")}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {/* 匯出 ▾：單一結果集時只有一項（點主鍵即開匯出對話框）；多結果集才多一項「全部結果集匯出」。 */}
                <div className="relative">
                  <button type="button"
                    onClick={() => (resultSets.length > 1 ? setShowExportMenu((s) => !s) : exportResult())}
                    title={t("匯出結果")} className="inline-flex items-center gap-1 hover:text-fg/80">
                    <Icon icon={Download} size={12} />{t("匯出")}
                    {resultSets.length > 1 && <Icon icon={ChevronDown} size={11} className="text-fg/40" />}
                  </button>
                  {showExportMenu && (
                    <>
                      <div className="fixed inset-0 z-[89]" onClick={() => setShowExportMenu(false)} />
                      <div className="absolute right-0 bottom-full mb-1 z-[90] w-56 bg-elevated border border-fg/10 rounded-lg shadow-2xl py-1 text-xs">
                        <button type="button" onClick={() => { setShowExportMenu(false); exportResult(); }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg/75 hover:bg-fg/10">
                          <Icon icon={Download} size={12} className="text-fg/45" />{t("匯出目前結果…")}
                        </button>
                        <button type="button" onClick={() => { setShowExportMenu(false); exportAllResults(); }}
                          title={t("全部結果集一次匯出：Excel 一格一工作表；CSV/TSV 拆編號多檔；JSON/MD/SQL 單檔分節")}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-accent/90 hover:bg-fg/10">
                          <Icon icon={Download} size={12} className="text-accent/60" />{t("全部結果集匯出…")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <button type="button" onClick={askAiResult} title={t("把這份結果帶進 AI 助手分析")} className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"><Icon icon={Sparkles} size={12} />{t("問 AI")}</button>
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {bottomTab === "result" && (
            <>
              {err && (
                <div className="p-3 space-y-2">
                  {(() => {
                    const hint = friendlyDbError(kind, err);
                    return hint ? (
                      <div className="text-amber-300/90 text-sm flex items-start gap-1.5">
                        <Icon icon={Info} size={14} className="mt-0.5 shrink-0" />
                        <span>{hint}</span>
                      </div>
                    ) : null;
                  })()}
                  <div className="text-red-400 text-sm mono whitespace-pre-wrap break-words">{err}</div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={askAiFixError}
                      title={t("把這段 SQL 與錯誤訊息帶進 AI 助手，分析原因並給出修正後的 SQL")}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-blue-400/40 text-blue-300 hover:bg-blue-400/10">
                      <Icon icon={Sparkles} size={13} />{t("AI 分析修正")}
                    </button>
                    <button type="button" onClick={() => copyToClipboard(err, t("已複製錯誤訊息"))}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 text-fg/60 hover:bg-fg/5">
                      {t("複製錯誤")}
                    </button>
                    {/* errStmt === 整份內容時不顯示（反白全部沒有定位價值；external 整批送出失敗時 errStmt 恆為整批）。 */}
                    {errStmt && supportsSqlEditor && errStmt.trim() !== sql.trim() && sql.indexOf(errStmt) >= 0 && (
                      <button type="button"
                        onClick={() => {
                          const off = sql.indexOf(errStmt);
                          editorRef.current?.selectRange(off, off + errStmt.length);
                        }}
                        title={t("在編輯器中反白失敗的那條語句")}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 text-fg/60 hover:bg-fg/5">
                        {t("定位失敗語句")}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {resultSets.length > 1 ? (
                // 多結果集（SSMS 風格）：逐格堆疊、同時可見、各自捲動（sticky 表頭相對各格生效）。
                // 點 / 聚焦任一格（含表格內部）把它設為「作用中」→ 右上複製 / 匯出 / 問 AI 對其生效。
                // content-visibility:auto：畫面外的格跳過 layout / paint，大批次不卡；
                // 每格渲染列數上限按格數均分（總 DOM 列數有預算），複製 / 匯出仍取全部列。
                <div className="p-2 space-y-2">
                  {resultSets.map((s, i) => {
                    const collapsed = !!collapsedSets[i];
                    return (
                      <section key={`${runSeq}-${i}`} data-result-section={i}
                        onMouseDownCapture={() => setActiveResult(i)}
                        onFocusCapture={() => setActiveResult(i)}
                        className={`rounded-md border overflow-hidden [content-visibility:auto] [contain-intrinsic-size:auto_300px] ${i === activeIdx ? "border-accent/50" : "border-fg/10"}`}>
                        <header onClick={() => setActiveResult(i)} title={s.sql}
                          className="flex items-center gap-2 px-2.5 py-1 bg-bar text-[11px] cursor-pointer select-none border-b border-fg/10">
                          <button type="button" aria-label={collapsed ? t("展開結果") : t("摺疊結果")} title={collapsed ? t("展開") : t("摺疊")}
                            onClick={(e) => { e.stopPropagation(); setCollapsedSets((m) => ({ ...m, [i]: !m[i] })); }}
                            className="shrink-0 text-fg/40 hover:text-fg/80">
                            <Icon icon={ChevronRight} size={12} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
                          </button>
                          <span className={`shrink-0 font-medium ${i === activeIdx ? "text-accent" : "text-fg/60"}`}>{t("結果")} {i + 1}</span>
                          <span className="mono text-fg/35 truncate flex-1">{s.sql.replace(/\s+/g, " ").trim().slice(0, 200)}</span>
                          {s.res.truncated && (
                            <span className="shrink-0 text-amber-400/90"
                              title={t("後端已於列數上限截斷（取完整結果請用匯出）")}>
                              {t("已截斷")}
                            </span>
                          )}
                          <span className="text-fg/45 shrink-0">{s.res.rows.length} {t("列 ·")} {fmtElapsed(s.ms)}</span>
                        </header>
                        {/* 摺疊用 display:none 而非卸載：保留該格排序 / 篩選 / 選取狀態 */}
                        <div style={collapsed ? { display: "none" } : undefined} className="max-h-[45vh] overflow-auto">
                          <ResultTable result={s.res}
                            maxRender={Math.max(100, Math.floor(2000 / resultSets.length))}
                            onViewChange={i === activeIdx ? setResultView : undefined} />
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : (
                result && <ResultTable result={result} onViewChange={setResultView} />
              )}
              {!result && !err && (
                <EmptyState compact icon={running ? Loader2 : Play}
                  title={running ? t("執行中…") : t("尚無查詢結果")}
                  hint={running ? undefined : t("按 F6 執行整段，或 Ctrl+Enter 執行游標所在語句／選取段。")}
                  className={running ? "[&_svg]:animate-spin" : ""} />
              )}
            </>
          )}
          {bottomTab === "summary" && (
            summary
              ? <RunSummaryView summary={summary} />
              : <EmptyState compact icon={FileText} title={t("尚無執行摘要")} hint={t("執行查詢後，這裡會列出每條語句的結果與耗時。")} />
          )}
          {bottomTab === "explain" && (
            mongoPlan
              ? <MongoExplainPlan model={mongoPlan.model} raw={mongoPlan.raw} />
              : plan
              ? <ExplainPlan node={plan} />
              : planErr
                ? <div className="p-3 text-amber-300 text-sm whitespace-pre-wrap break-words">{planErr}</div>
                : <EmptyState compact icon={running ? Loader2 : GitBranch}
                    title={running ? t("解釋中…") : t("尚無執行計畫")}
                    hint={running ? undefined : t("按「視覺化解釋」以執行計畫樹呈現查詢。")}
                    className={running ? "[&_svg]:animate-spin" : ""} />
          )}
        </div>
      </div>
      {builderOpen && activeId && kind && (
        <QueryBuilder
          connId={activeId}
          kind={kind}
          initialDb={queryDb}
          onClose={() => setBuilderOpen(false)}
          onUse={(generated) => { persistSql(generated); setBuilderOpen(false); }}
        />
      )}
    </div>
  );
}

// memo：多結果集堆疊時，父層（QueryPane）因作用中表格回報 resultView 而頻繁重渲染（每個篩選鍵擊 / 排序點擊），
// 不 memo 會讓其餘 N-1 個大表格跟著全數 reconcile；props（result / onViewChange / maxRender）皆為穩定 identity。
const ResultTable = memo(function ResultTable({ result, onViewChange, maxRender = 2000 }: { result: QueryResult; onViewChange?: (rows: (string | null)[][]) => void; maxRender?: number }) {
  const t = useT();
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  // 範圍選取（Shift+點選第二角）：null = 單格。Ctrl+C 複製整個矩形為 TSV，狀態列顯示統計。
  const [rangeEnd, setRangeEnd] = useState<{ r: number; c: number } | null>(null);
  const [menu, setMenu] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const [colMenu, setColMenu] = useState<{ c: number; x: number; y: number } | null>(null);
  const [inspect, setInspect] = useState<{ r: number; c: number } | null>(null);
  const [rowDetail, setRowDetail] = useState<number | null>(null);
  // 單擊即開檢視窗後，雙擊肌肉記憶的第二下會落在遮罩上把窗關掉 —— 開窗後 300ms 內忽略關閉。
  const inspectOpenedAt = useRef(0);
  const openInspect = (r: number, c: number) => {
    inspectOpenedAt.current = Date.now();
    setInspect({ r, c });
  };

  // 手刻的「整列詳情」浮層：開啟期間計入 modalCount（讓 Ctrl+W/Tab、"/" 等全域快捷鍵讓路），並支援 Esc 關閉。
  useEffect(() => {
    if (rowDetail === null) return;
    const b = document.body;
    b.dataset.modalCount = String(Number(b.dataset.modalCount ?? "0") + 1);
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setRowDetail(null); } };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      const m = Number(b.dataset.modalCount ?? "1") - 1;
      if (m <= 0) delete b.dataset.modalCount;
      else b.dataset.modalCount = String(m);
    };
  }, [rowDetail]);

  // 點欄位標題做 client-side 排序（asc → desc → 無）；數字欄以數值比較，NULL 最後。
  const [sort, setSort] = useState<{ c: number; dir: "asc" | "desc" } | null>(null);
  const sortedRows = useMemo(() => {
    if (!sort) return result.rows;
    const { c, dir } = sort;
    const f = dir === "asc" ? 1 : -1;
    return [...result.rows].sort((ra, rb) => {
      const a = ra[c];
      const b = rb[c];
      if (a === null && b === null) return 0;
      if (a === null) return 1; // NULL 排最後（不受方向影響）
      if (b === null) return -1;
      const na = Number(a);
      const nb = Number(b);
      const bothNum = a !== "" && b !== "" && !Number.isNaN(na) && !Number.isNaN(nb);
      return (bothNum ? na - nb : a < b ? -1 : a > b ? 1 : 0) * f;
    });
  }, [result.rows, sort]);

  // client-side 篩選：任一儲存格含關鍵字（不分大小寫）。在排序後套用。
  const [rfilter, setRfilter] = useState("");
  // 篩選框預設收合成一顆放大鏡（w-64 的輸入框恆常展開會把結果格標頭擠滿）。
  // 展開來源：點 icon 或格內 Ctrl+F；收合條件：Esc / blur 且字串為空（有篩選字時恆保持展開，
  // 否則使用者看不出結果已被篩過）。
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const openFilter = useCallback(() => {
    setFilterOpen(true);
    requestAnimationFrame(() => filterRef.current?.focus());
  }, []);
  const viewRows = useMemo(() => {
    const q = rfilter.trim().toLowerCase();
    if (!q) return sortedRows;
    return sortedRows.filter((row) => row.some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [sortedRows, rfilter]);
  // 選取 / 框選為 viewRows 的位置索引；排序 / 篩選會重排 viewRows，故清除避免高亮指向錯誤列。
  useEffect(() => { setSelected(null); setRangeEnd(null); }, [sort, rfilter]);
  // 將目前可視列（排序 + 篩選後）回報給父層，使複製 / 匯出與所見一致。
  useEffect(() => { onViewChange?.(viewRows); }, [viewRows, onViewChange]);
  // 新查詢結果到達時重置排序 / 篩選 / 選取（避免沿用上一個查詢的狀態，例如欄序失效或舊篩選字）。
  useEffect(() => { setSort(null); setRfilter(""); setSelected(null); setRangeEnd(null); }, [result]);

  // 大結果集只渲染前 N 列，避免數萬列 DOM 卡死 UI；複製 / 匯出仍取全部。
  // 多結果集堆疊時由父層按格數縮小上限（總 DOM 列數有預算）。
  const MAX_RENDER = maxRender;
  const rendered = viewRows.length > MAX_RENDER ? viewRows.slice(0, MAX_RENDER) : viewRows;

  const cell = (r: number, c: number) => viewRows[r]?.[c] ?? null;
  const copyCell = (r: number, c: number) => copyToClipboard(cell(r, c) ?? "", t("已複製儲存格"));
  const copyRowTsv = (r: number) =>
    copyToClipboard(viewRows[r].map((v) => v ?? "").join("\t"), t("已複製整列 (TSV)"));
  const copyRowJson = (r: number) =>
    copyToClipboard(
      JSON.stringify(Object.fromEntries(result.columns.map((c, j) => [c, viewRows[r][j] ?? null])), null, 2),
      t("已複製整列 (JSON)")
    );
  const copyCol = (c: number) =>
    copyToClipboard(viewRows.map((row) => row[c] ?? "").join("\n"), t("已複製整欄"));
  const copyHeader = (c: number) => copyToClipboard(result.columns[c] ?? "", t("已複製標題"));
  // 標題+值：單行「欄名: 值」（貼聊天 / 文件用；機器格式已有整列 TSV/JSON）。NULL → 空字串同「複製值」。
  const copyHeaderValue = (r: number, c: number) =>
    copyToClipboard(`${result.columns[c] ?? ""}: ${cell(r, c) ?? ""}`, t("已複製標題+值"));
  // 整列含標題列：兩行 TSV（標題列 + 資料列），可直接貼 Excel 對欄（SSMS Copy with Headers）。
  const copyRowTsvWithHeader = (r: number) =>
    copyToClipboard(
      `${result.columns.join("\t")}\n${viewRows[r].map((v) => v ?? "").join("\t")}`,
      t("已複製整列（含標題列）")
    );
  const toggleSort = (ci: number) =>
    setSort((s) => (s?.c === ci ? (s.dir === "asc" ? { c: ci, dir: "desc" } : null) : { c: ci, dir: "asc" }));

  // 範圍選取矩形（結果集無隱藏欄，欄序即 0..n-1）：Shift+點選第二角。
  const rangeBox = selected && rangeEnd
    ? { r1: Math.min(selected.r, rangeEnd.r), r2: Math.max(selected.r, rangeEnd.r), c1: Math.min(selected.c, rangeEnd.c), c2: Math.max(selected.c, rangeEnd.c) }
    : null;
  const inRange = (r: number, c: number) =>
    !!rangeBox && r >= rangeBox.r1 && r <= rangeBox.r2 && c >= rangeBox.c1 && c <= rangeBox.c2;
  const rangeRC = () => {
    if (!rangeBox) return null;
    const rows = Array.from({ length: rangeBox.r2 - rangeBox.r1 + 1 }, (_, k) => rangeBox.r1 + k);
    const cols = Array.from({ length: rangeBox.c2 - rangeBox.c1 + 1 }, (_, k) => rangeBox.c1 + k);
    return { rows, cols };
  };
  const copyRange = () => {
    const rc = rangeRC();
    if (!rc) return;
    copyToClipboard(rectToTsv((r, c) => cell(r, c), rc.rows, rc.cols), t("已複製 {length}×{v2} 區塊 (TSV)", { length: rc.rows.length, v2: rc.cols.length }));
  };
  const copyRangeMarkdown = () => {
    const rc = rangeRC();
    if (!rc) return;
    copyToClipboard(rectToMarkdown((r, c) => cell(r, c), rc.rows, rc.cols, (c) => result.columns[c]), t("已複製 {length}×{v2} 區塊 (Markdown)", { length: rc.rows.length, v2: rc.cols.length }));
  };
  // 框選範圍統計（Excel 狀態列手感）。以 selected/rangeEnd/viewRows 為相依重算。
  const selStats = useMemo(() => {
    if (!rangeBox) return null;
    const vals: (string | null)[] = [];
    for (let r = rangeBox.r1; r <= rangeBox.r2; r++) for (let c = rangeBox.c1; c <= rangeBox.c2; c++) vals.push(viewRows[r]?.[c] ?? null);
    return { rows: rangeBox.r2 - rangeBox.r1 + 1, colsN: rangeBox.c2 - rangeBox.c1 + 1, ...rangeStats(vals) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, rangeEnd, viewRows]);
  const fmtNum = (n: number) =>
    Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  // 鍵盤導覽時將作用中的儲存格（框選遠端角 rangeEnd，否則選取格）捲入可視範圍。
  const activeCell = rangeEnd ?? selected;
  const activeCellRef = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    activeCellRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, rangeEnd]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Esc 先關開啟中的選單，其次取消儲存格 / 範圍選取。
      if (menu || colMenu) { setMenu(null); setColMenu(null); }
      else { setSelected(null); setRangeEnd(null); }
      return;
    }
    // Ctrl+F：展開篩選框並聚焦（收合狀態下唯一的鍵盤入口）。
    if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      openFilter();
      return;
    }
    // Ctrl+A：框選整頁所有儲存格（接著 Ctrl+C 複製、或工具列看統計）。
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      if (rendered.length === 0 || result.columns.length === 0) return;
      setSelected({ r: 0, c: 0 });
      setRangeEnd({ r: rendered.length - 1, c: result.columns.length - 1 });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      if (!selected) return;
      if (rangeEnd) copyRange();
      else copyCell(selected.r, selected.c);
      e.preventDefault();
      return;
    }
    // 鍵盤導覽：方向鍵移動選取、Home/End 跳列首尾欄、Ctrl+Home/End 跳整頁角落；
    // Shift+方向鍵延伸框選；Tab / Shift+Tab 逐格移動（列尾 / 列首換行）。
    const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Tab", "PageUp", "PageDown"];
    if (!navKeys.includes(e.key)) return;
    const maxR = rendered.length - 1;
    const maxC = result.columns.length - 1;
    if (maxR < 0 || maxC < 0) return;
    e.preventDefault();
    if (!selected) { setSelected({ r: 0, c: 0 }); setRangeEnd(null); return; }
    if (e.key === "Tab") {
      let tr = selected.r, tc = selected.c;
      if (e.shiftKey) { if (tc > 0) tc--; else if (tr > 0) { tr--; tc = maxC; } }
      else { if (tc < maxC) tc++; else if (tr < maxR) { tr++; tc = 0; } }
      setSelected({ r: tr, c: tc }); setRangeEnd(null);
      return;
    }
    const base = e.shiftKey ? (rangeEnd ?? selected) : selected;
    let nr = base.r;
    let nc = base.c;
    if (e.key === "ArrowDown") nr = Math.min(maxR, base.r + 1);
    else if (e.key === "ArrowUp") nr = Math.max(0, base.r - 1);
    else if (e.key === "ArrowRight") nc = Math.min(maxC, base.c + 1);
    else if (e.key === "ArrowLeft") nc = Math.max(0, base.c - 1);
    else if (e.key === "PageDown") nr = Math.min(maxR, base.r + 20);
    else if (e.key === "PageUp") nr = Math.max(0, base.r - 20);
    else if (e.key === "Home") { nc = 0; if (e.ctrlKey) nr = 0; }
    else if (e.key === "End") { nc = maxC; if (e.ctrlKey) nr = maxR; }
    if (e.shiftKey) setRangeEnd({ r: nr, c: nc });
    else { setSelected({ r: nr, c: nc }); setRangeEnd(null); }
  };

  // 非 SELECT（無欄位）只顯示影響列數。放在所有 hooks 之後，避免同一實例在 SELECT↔非 SELECT
  // 切換時 hook 數量改變而觸發 React「rendered fewer/more hooks」錯誤。
  if (result.columns.length === 0) {
    return (
      <div className="p-3 text-fg/50 text-sm">
        {t("影響列數：")}{result.rows_affected}
      </div>
    );
  }

  return (
    <div className="outline-none" tabIndex={0} onKeyDown={onKey}>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-fg/10 bg-panel sticky top-0 z-10">
        {filterOpen || rfilter ? (
          <div className="relative">
            <Icon icon={Search} size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-fg/35 pointer-events-none" />
            <input
              ref={filterRef}
              value={rfilter}
              onChange={(e) => setRfilter(e.target.value)}
              // Esc：先清空，再收合（兩段式，與側欄搜尋一致）。stopPropagation 免得順帶取消儲存格選取。
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (rfilter) setRfilter("");
                else setFilterOpen(false);
              }}
              onBlur={() => { if (!rfilter) setFilterOpen(false); }}
              placeholder={t("篩選結果（任一欄含關鍵字）…")}
              className="w-64 bg-inset border border-fg/10 rounded pl-7 pr-6 py-1 text-xs outline-none focus:border-accent"
            />
            {rfilter && (
              <button type="button" onClick={() => { setRfilter(""); setFilterOpen(false); }} title={t("清除篩選")} aria-label={t("清除篩選")}
                className="absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded text-fg/30 hover:text-fg/70 hover:bg-fg/10">
                <Icon icon={X} size={12} />
              </button>
            )}
          </div>
        ) : (
          <button type="button" onClick={openFilter} title={t("篩選結果（Ctrl+F）")} aria-label={t("篩選結果")}
            className="w-7 h-7 flex items-center justify-center rounded text-fg/40 hover:text-fg/80 hover:bg-fg/10">
            <Icon icon={Search} size={14} />
          </button>
        )}
        <span className="text-xs text-fg/40">
          {rfilter.trim() ? t("{length} / {v2} 列", { length: viewRows.length, v2: result.rows.length }) : t("{length} 列", { length: result.rows.length })}
        </span>
        {selStats && (
          <span className="ml-auto text-xs text-fg/45 mono whitespace-nowrap" title={t("框選範圍統計（Shift+點選）")}>
            {t("已選 {rows}×{colsN}（{count} 格）", { rows: selStats.rows, colsN: selStats.colsN, count: selStats.count })}
            {selStats.numCount > 0 &&
              t(" · 數值 {numCount} · Σ {sum} · 平均 {avg}", { numCount: selStats.numCount, sum: fmtNum(selStats.sum), avg: fmtNum(selStats.avg) })}
            {selStats.numCount > 1 &&
              t(" · 最小 {min} · 最大 {max}", { min: fmtNum(selStats.min), max: fmtNum(selStats.max) })}
          </span>
        )}
      </div>
      <table className="text-sm border-collapse w-full">
        <thead className="sticky top-[34px] bg-bar">
          <tr>
            <th className="text-left px-3 py-1.5 border-b border-fg/15 text-fg/30 w-12 bg-bar">#</th>
            {result.columns.map((c, ci) => (
              <th key={c} scope="col" tabIndex={0} onClick={() => toggleSort(ci)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort(ci); } }}
                {...(sort?.c === ci ? { "aria-sort": sort.dir === "asc" ? "ascending" : "descending" } : {})}
                onContextMenu={(e) => { e.preventDefault(); setColMenu({ c: ci, x: e.clientX, y: e.clientY }); }}
                title={t("點擊排序（再點切換 / 取消）；右鍵更多")}
                className="text-left px-3 py-1.5 border-b border-fg/15 font-medium whitespace-nowrap cursor-pointer select-none hover:bg-fg/5 bg-bar focus-visible:outline-2 focus-visible:outline-accent/60 focus-visible:-outline-offset-2">
                {c}
                {sort?.c === ci && <Icon icon={sort.dir === "asc" ? ArrowUp : ArrowDown} size={12} className="ml-1 inline text-accent" />}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="mono">
          {rendered.map((row, i) => {
            const rowSel = selected?.r === i;
            return (
            <tr key={i} className={rowSel ? "bg-accent/[0.06]" : "hover:bg-fg/5"}>
              <td
                onClick={(e) => {
                  // 與資料表格一致：點列號看整列表單；Shift+點選整列（接著 Ctrl+C 複製整列 / 看統計）。
                  const lastC = result.columns.length - 1;
                  if (e.shiftKey) {
                    const anchorR = selected ? selected.r : i;
                    setSelected({ r: anchorR, c: 0 });
                    setRangeEnd({ r: i, c: lastC });
                    (e.currentTarget.closest("[tabindex]") as HTMLElement | null)?.focus();
                  } else setRowDetail(i);
                }}
                title={t("點看整列表單、Shift+點選整列")}
                className={`px-3 py-1 border-b border-fg/5 text-fg/30 tabular-nums cursor-pointer select-none hover:bg-fg/5 hover:text-fg/60 ${rowSel ? "text-accent/90" : "bg-fg/[0.015]"}`}>{i + 1}</td>
              {row.map((c, j) => (
                <td key={j}
                  ref={activeCell?.r === i && activeCell?.c === j ? activeCellRef : undefined}
                  onClick={(e) => {
                    // Shift+點選：以選取格為錨點框選矩形（Ctrl+C 整塊複製）；
                    // 一般點選：選取 + 開檢視窗（與「點列號看整列表單」同一互動語言；長 JSON 免雙擊）。
                    if (e.shiftKey && selected) setRangeEnd({ r: i, c: j });
                    else { setSelected({ r: i, c: j }); setRangeEnd(null); openInspect(i, j); }
                    (e.currentTarget.closest("[tabindex]") as HTMLElement | null)?.focus();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!inRange(i, j)) { setSelected({ r: i, c: j }); setRangeEnd(null); }
                    setMenu({ r: i, c: j, x: e.clientX, y: e.clientY });
                  }}
                  className={`px-3 py-1 border-b border-fg/5 align-middle cursor-cell ${
                    selected?.r === i && selected?.c === j ? "ring-1 ring-inset ring-accent " : ""
                  }${
                    selected?.r === i && selected?.c === j ? "bg-accent/15" : inRange(i, j) ? "bg-accent/10" : ""
                  }`}
                  title={c == null ? t("NULL（點擊檢視）") : c}>
                  {/* 單行截斷 + 上限寬度：長字串（Memo / RefTransId / JSON）不再換行撐爆列高；完整值看 title 提示、點擊檢視、或點列號看整列。 */}
                  {c === null ? <span className="text-fg/30 italic">NULL</span> : <div className="truncate max-w-[60ch]">{c}</div>}
                </td>
              ))}
            </tr>
          )})}
        </tbody>
      </table>

      {viewRows.length > MAX_RENDER && (
        <div className="px-3 py-2 text-xs text-amber-300/80 bg-amber-500/5 border-t border-fg/10">
          {t("僅渲染前 {rendered} / 已取回 {fetched} 列（避免卡頓）；「複製 / 匯出」仍取全部已取回列。", { rendered: MAX_RENDER.toLocaleString(), fetched: viewRows.length.toLocaleString() })}
        </div>
      )}

      {colMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setColMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setColMenu(null); }} />
          <div className="fixed z-[90] min-w-[150px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: colMenu.x, top: colMenu.y }}>
            {(
              [
                [t("升冪排序 ▲"), () => setSort({ c: colMenu.c, dir: "asc" })],
                [t("降冪排序 ▼"), () => setSort({ c: colMenu.c, dir: "desc" })],
                ...(sort ? [[t("清除排序"), () => setSort(null)] as [string, () => void]] : []),
                [t("複製欄名"), () => copyToClipboard(result.columns[colMenu.c], t("已複製欄名"))],
                [t("複製整欄"), () => copyCol(colMenu.c)],
              ] as [string, () => void][]
            ).map(([label, fn]) => (
              <button key={label} type="button"
                onClick={() => { setColMenu(null); fn(); }}
                className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80">
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {inspect && (
        <CellInspector
          column={result.columns[inspect.c]}
          value={cell(inspect.r, inspect.c)}
          editable={false}
          onSave={() => {}}
          onClose={() => { if (Date.now() - inspectOpenedAt.current > 300) setInspect(null); }}
        />
      )}

      {rowDetail !== null && viewRows[rowDetail] && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[95]" onClick={() => setRowDetail(null)}>
          <div className="bg-elevated w-[560px] max-w-[92vw] max-h-[84vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-2">
              <span className="font-medium text-sm">{t("列詳情")}</span>
              <span className="text-xs text-fg/40">{t("第 {n} 列", { n: rowDetail + 1 })}</span>
              <button type="button" onClick={() => setRowDetail(null)} className="ml-auto text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
            </div>
            <div className="overflow-auto divide-y divide-fg/5">
              {result.columns.map((col, j) => {
                const v = viewRows[rowDetail][j];
                return (
                  <div key={col} className="flex gap-3 px-4 py-1.5 text-sm hover:bg-fg/5">
                    <span className="text-fg/45 w-40 shrink-0 mono break-all">{col}</span>
                    <span className="text-fg/85 mono break-all flex-1">{v === null ? <span className="text-fg/30 italic">NULL</span> : v}</span>
                  </div>
                );
              })}
            </div>
            <div className="px-5 py-3 border-t border-fg/10 flex justify-end">
              <button type="button" onClick={() => setRowDetail(null)}
                className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">{t("關閉")}</button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-[90] min-w-[160px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: menu.x, top: menu.y }}>
            {(
              [
                [t("檢視內容…"), () => openInspect(menu.r, menu.c)],
                [t("檢視此列（表單）…"), () => setRowDetail(menu.r)],
                [t("複製值"), () => copyCell(menu.r, menu.c)],
                [t("複製標題"), () => copyHeader(menu.c)],
                [t("複製標題+值"), () => copyHeaderValue(menu.r, menu.c)],
                ...(rangeEnd && inRange(menu.r, menu.c)
                  ? [
                      [t("複製範圍 (TSV)"), () => copyRange()] as [string, () => void],
                      [t("複製範圍 (Markdown)"), () => copyRangeMarkdown()] as [string, () => void],
                    ]
                  : []),
                [t("複製整列 (TSV)"), () => copyRowTsv(menu.r)],
                [t("複製整列（含標題列）"), () => copyRowTsvWithHeader(menu.r)],
                [t("複製整列 (JSON)"), () => copyRowJson(menu.r)],
                [t("複製整欄"), () => copyCol(menu.c)],
              ] as [string, () => void][]
            ).map(([label, fn]) => (
              <button key={label} type="button"
                onClick={() => { setMenu(null); fn(); }}
                className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80">
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
});
