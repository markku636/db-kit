import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ListTree, Table2, Plus, Minus, BarChart3, Network, Settings, Terminal,
  RefreshCw, Search, Filter, Trash2, ArrowUpDown, Download, Upload, X, Check,
  ArrowUp, ArrowDown, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight,
  Copy, Pencil, Columns3,
} from "lucide-react";
import Icon from "./ui/Icon";
import { Button, EmptyState } from "./ui/index";
import {
  api, ColumnInfo, ColumnStats, DbKind, ErRelation, Filter as FilterCond, ForeignKeyInfo, IndexInfo, KeyDetail, KeyEdit, KeyPage,
  MongoIndexOptions, MongoIndexStat, MongoValidation, PagedData, RowInsert, Sort, SortDir,
} from "./api";
import { OpenTab, useStore } from "./store";
import { toast, uiConfirm, uiPrompt, copyToClipboard, pickSaveFile, useModalCount, useModalOverlay } from "./ui";
import { quoteIdent, qualifiedName, sqlLiteral, buildRowUpdate, buildRowDelete, buildRowSelect, buildAddForeignKey, buildDropForeignKey, buildRenameIndex, buildCreateFulltextIndex, parseClipboardGrid, rectToTsv, rectToMarkdown, rangeStats, buildInClause, buildInsertValues, TYPE_PRESETS } from "./sql";
import RedisKeyTree from "./RedisKeyTree";
import lazyOverlay from "./ui/lazyOverlay";
import ProgressBar from "./ui/ProgressBar";
import { AlterOp } from "./api";
import { t, useT } from "./i18n";

// 條件掛載的對話框 / 面板改 lazy（code splitting）：開啟時才抓 chunk，首包不含其程式碼。
const ExportDialog = lazyOverlay(() => import("./ExportDialog"));
const ImportDialog = lazyOverlay(() => import("./ImportDialog"));
const NewKeyDialog = lazyOverlay(() => import("./NewKeyDialog"));
const RedisStatus = lazyOverlay(() => import("./RedisStatus"));
const RedisConsole = lazyOverlay(() => import("./RedisConsole"));
const PubSubPanel = lazyOverlay(() => import("./PubSubPanel"));
const RedisOpsPanel = lazyOverlay(() => import("./RedisOpsPanel"));

const PAGE_SIZE = 100;
const DEFAULT_COL_W = 160;
const MIN_COL_W = 60;

// 將 text 中符合 q（已轉小寫）的片段以 <mark> 標示，供即時尋找用。q 為空則原樣回傳。
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  if (!lower.includes(q)) return text;
  const parts: React.ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(q, i);
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={idx} className="bg-yellow-400/70 text-black rounded-sm">{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

// 由 connId 查出該連線是否為 Redis（決定雙擊列開「鍵詳情」而非編輯）
function useIsRedis(connId: string): boolean {
  return useStore((s) => s.connections.find((c) => c.id === connId)?.kind === "redis");
}

export default function TableView({ tab }: { tab: OpenTab }) {
  const t = useT();
  const setTabView = useStore((s) => s.setTabView);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 結構 / 資料 分頁切換（Navicat 手感） */}
      <div className="flex items-center gap-1 px-2 py-1 bg-bar border-b border-fg/10">
        <span className="text-xs text-fg/40 mr-2 pl-1">{tab.table}</span>
        {(["data", "structure"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setTabView(tab.key, v)}
            className={`text-xs px-3 py-1 rounded ${
              tab.view === v ? "bg-fg/10 text-fg" : "text-fg/50 hover:bg-fg/5"
            }`}
          >
            {v === "data" ? t("資料") : t("結構")}
          </button>
        ))}
      </div>
      {tab.view === "data" ? <DataPane tab={tab} /> : <StructurePane tab={tab} />}
    </div>
  );
}

// ---- 資料分頁：表格 + 底部導覽列 ----
function DataPane({ tab }: { tab: OpenTab }) {
  const t = useT();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PagedData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 待套用的編輯：key 為 `行索引:欄索引`，值為新字串（null 代表設為 NULL）
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  // 開啟編輯器時的初始覆寫文字：直接打字（overtype）以該鍵起頭、Backspace 清空後編輯；null = 沿用原值。
  const [editSeed, setEditSeed] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // 資料表捲動容器：鍵盤編輯（Enter/Tab 推進）後把焦點交還給它，讓方向鍵繼續運作。
  const gridRef = useRef<HTMLDivElement>(null);

  // 排序與篩選
  const [sorts, setSorts] = useState<Sort[]>([]);
  const [filters, setFilters] = useState<FilterCond[]>([]);
  const [matchAny, setMatchAny] = useState(false); // 多欄篩選：false=AND、true=OR
  const [showFilter, setShowFilter] = useState(false);
  // 即時尋找（client-side，標示目前頁符合的儲存格）
  const [find, setFind] = useState("");
  const [showFind, setShowFind] = useState(false);

  // 新增列 / 匯出 / 匯入對話框
  const [inserting, setInserting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  // Redis：雙擊 key 列顯示鍵詳情；右鍵叫出操作選單
  const isRedis = useIsRedis(tab.connId);
  const connKind = useStore((s) => s.connections.find((c) => c.id === tab.connId)?.kind);
  const isSqlKind = connKind === "mysql" || connKind === "mariadb" || connKind === "postgres" || connKind === "sqlite" || connKind === "mssql" || connKind === "oracle";
  const isMongo = connKind === "mongo";
  // Mongo：整份文件 JSON 編輯器（開啟時記錄列索引，用 row_ids 定位）。
  const [docEdit, setDocEdit] = useState<number | null>(null);
  // Mongo 欄位統計視窗（型別分布 / Top 值；SQL 種類走 toast 不開窗）。
  const [fieldStats, setFieldStats] = useState<{ col: string; stats: ColumnStats } | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ key: string; ttl: string | null; x: number; y: number } | null>(null);
  // Redis 鍵檢視模式：樹狀（命名空間資料夾）/ 網格（key 列表）。記憶於 localStorage。
  const [redisView, setRedisView] = useState<"tree" | "grid">(() => {
    try { return localStorage.getItem("db-kit:redisKeyView") === "grid" ? "grid" : "tree"; }
    catch { return "tree"; }
  });
  const treeMode = isRedis && redisView === "tree";
  const setRedisViewPersist = (v: "tree" | "grid") => {
    setRedisView(v);
    try { localStorage.setItem("db-kit:redisKeyView", v); } catch { /* 忽略 */ }
  };
  // Redis 動作列：把原本藏在右鍵的功能變成一眼可見的工具列按鈕。
  const connName = useStore((s) => s.connections.find((c) => c.id === tab.connId)?.name ?? "Redis");
  const [showNewKey, setShowNewKey] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [showPubSub, setShowPubSub] = useState(false);
  const [showOps, setShowOps] = useState(false);

  // SQL 表的儲存格右鍵選單 / 內容檢視器 / 選取（鍵盤導覽）/「以此列為範本」預填值
  const [cellMenu, setCellMenu] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const [inspect, setInspect] = useState<{ r: number; c: number } | null>(null);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  // 範圍選取（Shift+點選第二角）：null = 單格。Ctrl+C 複製整個矩形為 TSV。
  const [rangeEnd, setRangeEnd] = useState<{ r: number; c: number } | null>(null);
  // 批次刪除：以目前頁列索引標記欲刪除的列（資料重載時清空，避免索引失效）。
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [insertInitial, setInsertInitial] = useState<Record<string, string | null> | undefined>(undefined);
  // 整列表單檢視（點列號開啟，寬表友善）
  const [rowDetail, setRowDetail] = useState<number | null>(null);

  // 欄寬（以欄名為鍵），per-table 持久化於 localStorage。
  const widthsKey = `colw:${tab.connId}:${tab.database}:${tab.table}`;
  const [widths, setWidths] = useState<Record<string, number>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(widthsKey);
      setWidths(raw ? JSON.parse(raw) : {});
    } catch {
      setWidths({});
    }
  }, [widthsKey]);
  const colWidth = (c: string) => widths[c] ?? DEFAULT_COL_W;

  // 隱藏欄位（欄名集合），per-table 持久化於 localStorage。
  const hiddenKey = `colhide:${tab.connId}:${tab.database}:${tab.table}`;
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(hiddenKey);
      const arr = raw ? JSON.parse(raw) : [];
      setHidden(Array.isArray(arr) ? arr : []);
    } catch {
      setHidden([]);
    }
  }, [hiddenKey]);
  const isHidden = (c: string) => hidden.includes(c);
  const setHiddenPersist = (next: string[]) => {
    setHidden(next);
    try {
      localStorage.setItem(hiddenKey, JSON.stringify(next));
    } catch {
      /* 忽略寫入失敗 */
    }
  };
  const hideColumn = (c: string) => {
    const next = [...hidden.filter((x) => x !== c), c];
    if (data && next.length >= data.columns.length) {
      toast.info(t("至少需保留一欄"));
      return;
    }
    // 若隱藏的正是目前選取欄，清除選取，避免鍵盤導覽卡在不可見欄。
    if (data && selected && data.columns[selected.c] === c) setSelected(null);
    setRangeEnd(null); // 隱藏欄會改變可見欄序位，清除框選範圍避免區塊複製定位錯誤
    setHiddenPersist(next);
  };
  const showAllColumns = () => setHiddenPersist([]);

  // 欄位標題右鍵選單
  const [colMenu, setColMenu] = useState<{ col: string; ci: number; x: number; y: number } | null>(null);
  // 反向外鍵（被參照）多來源時的選擇器（值與候選關係）。
  const [refChooser, setRefChooser] = useState<{ x: number; y: number; value: string; options: ErRelation[] } | null>(null);

  // 外鍵：欄名 → 參照表 / 欄（供儲存格右鍵「跳至參照的列」導覽，致敬 Navicat / TablePlus）。僅 SQL 資料表。
  const [fkMap, setFkMap] = useState<Record<string, { ref_table: string; ref_column: string }>>({});
  useEffect(() => {
    if (!isSqlKind || tab.view !== "data") { setFkMap({}); return; }
    let alive = true;
    api.listForeignKeys(tab.connId, tab.database, tab.table)
      .then((fks) => {
        if (!alive) return;
        const m: Record<string, { ref_table: string; ref_column: string }> = {};
        for (const f of fks) m[f.column] = { ref_table: f.ref_table, ref_column: f.ref_column };
        setFkMap(m);
      })
      .catch(() => { if (alive) setFkMap({}); });
    return () => { alive = false; };
  }, [isSqlKind, tab.connId, tab.database, tab.table, tab.view]);

  // 欄位 comment：欄名 → COLUMN_COMMENT（供表頭 hover 顯示欄位說明，致敬 Navicat）。僅 SQL 資料表 + 資料分頁時載入。
  const [commentMap, setCommentMap] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!isSqlKind || tab.view !== "data") { setCommentMap({}); return; }
    let alive = true;
    api.tableColumns(tab.connId, tab.database, tab.table)
      .then((cols) => {
        if (!alive) return;
        const m: Record<string, string> = {};
        for (const col of cols) if (col.comment) m[col.name] = col.comment;
        setCommentMap(m);
      })
      .catch(() => { if (alive) setCommentMap({}); });
    return () => { alive = false; };
  }, [isSqlKind, tab.connId, tab.database, tab.table, tab.view]);

  // 外鍵導覽消費：pendingFilter 指向本分頁時，套用 col=value 篩選（被參照表開啟後即過濾出該列）。
  const pendingFilter = useStore((s) => s.pendingFilter);
  useEffect(() => {
    if (!pendingFilter || pendingFilter.key !== tab.key) return;
    setPage(0);
    setMatchAny(false);
    setFilters([{ column: pendingFilter.column, op: "=", value: pendingFilter.value }]);
    setShowFilter(true);
    useStore.getState().clearPendingFilter();
  }, [pendingFilter, tab.key]);

  // 反向外鍵（被參照）導覽：「尋找參照此列的列」。以 er_model 取得「哪些表的外鍵指向本表」，
  // 延遲載入（點選才抓）並快取於本分頁。多個來源時跳出小選單讓使用者挑。
  const incomingRelsRef = useRef<ErRelation[] | null>(null);
  useEffect(() => { incomingRelsRef.current = null; }, [tab.connId, tab.database, tab.table]);
  const findReferencing = async (r: number, c: number, x: number, y: number) => {
    const col = data?.columns[c];
    const val = cellValue(r, c);
    if (!col || val === null) return;
    try {
      if (!incomingRelsRef.current) {
        const m = await api.erModel(tab.connId, tab.database);
        incomingRelsRef.current = m.relations;
      }
      const incoming = incomingRelsRef.current.filter((rel) => rel.to_table === tab.table && rel.to_column === col);
      if (incoming.length === 0) { toast.info(t("沒有資料表以外鍵參照 {table}.{col}", { table: tab.table, col })); return; }
      if (incoming.length === 1) {
        useStore.getState().openTableFiltered(tab.connId, tab.database, incoming[0].from_table, incoming[0].from_column, val);
        return;
      }
      setRefChooser({ x, y, value: val, options: incoming });
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取參照關係失敗"));
    }
  };

  // Esc 關閉儲存格 / 欄位右鍵選單（與對話框、側欄選單一致）。
  useEffect(() => {
    if (!cellMenu && !colMenu && !refChooser) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setCellMenu(null); setColMenu(null); setRefChooser(null); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [cellMenu, colMenu, refChooser]);

  // 拖曳表頭右緣調整欄寬（在 window 上掛 move/up，拖出表頭也能追蹤）。
  const startResize = (col: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidth(col);
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(MIN_COL_W, startW + (ev.clientX - startX));
      setWidths((w) => ({ ...w, [col]: next }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidths((w) => {
        try {
          localStorage.setItem(widthsKey, JSON.stringify(w));
        } catch {
          /* 忽略寫入失敗 */
        }
        return w;
      });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 雙擊欄分隔線：依內容自動調整欄寬（致敬 Navicat / TablePlus 的 auto-fit）。
  // 以 canvas 量測表頭與目前頁各儲存格文字寬度，取最大值（含內距，夾在 [MIN, 600]）。
  const autoFitColumn = (col: string, colIndex: number) => {
    if (!data) return;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    ctx.font = '13px "JetBrains Mono", "Cascadia Code", Consolas, monospace';
    let max = ctx.measureText(col).width + 28; // 表頭 + PK/排序徽章預留
    for (const row of data.rows) {
      const v = row[colIndex];
      if (v == null) continue;
      const s = v.length > 200 ? v.slice(0, 200) : v;
      const w = ctx.measureText(s).width;
      if (w > max) max = w;
    }
    const next = Math.min(600, Math.max(MIN_COL_W, Math.ceil(max) + 24));
    setWidths((w) => {
      const nw = { ...w, [col]: next };
      try {
        localStorage.setItem(widthsKey, JSON.stringify(nw));
      } catch {
        /* 忽略寫入失敗 */
      }
      return nw;
    });
  };

  // 外部資料重載信號（如 TRUNCATE 後）：nonce 變動即觸發重新查詢，保留分頁 / 篩選狀態。
  const reloadNonce = useStore((s) => s.dataReload[tab.key] ?? 0);

  // 右鍵「新增資料列」要求：開啟新增列對話框（資料載入後 InsertDialog 才會實際渲染）。
  const pendingInsert = useStore((s) => s.pendingInsert);
  useEffect(() => {
    if (pendingInsert === tab.key) {
      setInserting(true);
      useStore.getState().clearPendingInsert();
    }
  }, [pendingInsert, tab.key]);

  // 記住上次「影響總數的輸入」簽章；相同表示只是翻頁 / 排序，可略過 count。
  const countSigRef = useRef<string>("");
  // 目前已知總列數（跨資料回應保序：count 回應先到時不被資料回應覆蓋）。
  const totalRef = useRef<number>(0);
  // count 請求進行中：分頁器總數顯示「…」。
  const [countPending, setCountPending] = useState(false);
  const load = () => {
    // 只有「影響總數的輸入」（表/篩選/reload）變動時才重算 count；純翻頁 / 排序沿用前次總數，
    // 避免大表 / Mongo 每翻一頁都重算 count（頁碼也不會因每次重算而跳動）。
    const countSig = JSON.stringify([tab.connId, tab.database, tab.table, filters, matchAny, reloadNonce]);
    const needCount = countSig !== countSigRef.current;
    countSigRef.current = countSig;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    // 資料請求恆 count:false（首屏不被大表 COUNT(*) 卡住）；需要重算總數時另發
    // page_size:1 的並行 count 請求補總數，期間分頁器顯示「…」。
    api
      .tableData(tab.connId, tab.database, tab.table, {
        page,
        page_size: pageSize,
        filters,
        sorts,
        match_any: matchAny,
        count: false,
      })
      .then((d) => {
        if (!cancelled) {
          setData({ ...d, total_rows: totalRef.current });
          setEdits({});
          setEditing(null);
          setSelected(null); // 重載後清除選取，避免指向已不存在的列
          setRangeEnd(null); // 同時清除框選範圍（列索引在重載後可能失效）
        }
      })
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")))
      .finally(() => !cancelled && setLoading(false));
    if (needCount) {
      setCountPending(true);
      api
        .tableData(tab.connId, tab.database, tab.table, {
          page: 0,
          page_size: 1,
          filters,
          sorts: [],
          match_any: matchAny,
          count: true,
        })
        .then((c) => {
          if (!cancelled) {
            totalRef.current = c.total_rows;
            setData((prev) => (prev ? { ...prev, total_rows: c.total_rows } : prev));
          }
        })
        .catch(() => {}) // count 失敗不影響資料呈現（總數維持前值）
        .finally(() => !cancelled && setCountPending(false));
    }
    return () => {
      cancelled = true;
    };
  };

  useEffect(load, [tab.connId, tab.database, tab.table, page, pageSize, sorts, filters, matchAny, reloadNonce]);
  // 資料集變動（換頁 / 排序 / 篩選 / 重載）即清除批次標記，避免列索引對不上資料。
  useEffect(() => { setMarked(new Set()); },
    [tab.connId, tab.database, tab.table, page, pageSize, sorts, filters, matchAny, reloadNonce]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total_rows / pageSize)) : 1;
  const startRow = data ? page * pageSize : 0;
  // 唯讀連線：資料格不可編輯（與寫入 / DDL 攔截一致），避免正式環境誤改。
  const readonly = useStore((s) => s.readonlyConns[tab.connId] === true);
  const editable = !!data && data.primary_key.length > 0 && !readonly;
  // 新增列不需主鍵（INSERT 不依賴 PK）；只有更新 / 刪除個別列才需 PK 來定位。視圖不可插入。
  const insertable = !!data && data.columns.length > 0 && tab.objKind !== "view";
  const dirtyCount = Object.keys(edits).length;
  // 排序 / 篩選會觸發重載並放棄待套用編輯（與換頁 / 重整的保護一致），先確認。
  const guardDiscard = async (): Promise<boolean> =>
    dirtyCount === 0 ||
    (await uiConfirm(t("有未套用的變更，排序 / 篩選將重新載入並放棄。確定？"), { title: t("放棄變更"), danger: true, confirmText: t("放棄並繼續") }));
  // 範圍選取矩形邊界（以可見欄序位計）：供儲存格判斷是否被框選、Ctrl+C 區塊複製定位。
  // useMemo：識別穩定 → DataRow 的 memo 比較才能在選取不變時略過重繪。
  const rangeVisIdx = useMemo(
    () => (data ? data.columns.map((_, j) => j).filter((j) => !hidden.includes(data.columns[j])) : []),
    [data, hidden],
  );
  const rangeRect = useMemo(
    () =>
      selected && rangeEnd
        ? {
            r1: Math.min(selected.r, rangeEnd.r),
            r2: Math.max(selected.r, rangeEnd.r),
            pmin: Math.min(rangeVisIdx.indexOf(selected.c), rangeVisIdx.indexOf(rangeEnd.c)),
            pmax: Math.max(rangeVisIdx.indexOf(selected.c), rangeVisIdx.indexOf(rangeEnd.c)),
          }
        : null,
    [selected, rangeEnd, rangeVisIdx],
  );
  const inRange = (i: number, j: number): boolean => {
    if (!rangeRect || i < rangeRect.r1 || i > rangeRect.r2) return false;
    const p = rangeVisIdx.indexOf(j);
    return p >= rangeRect.pmin && p <= rangeRect.pmax;
  };
  // Redis 鍵列右鍵需定位 key / ttl 欄。
  const keyIdx = data ? data.columns.indexOf("key") : -1;
  const ttlIdx = data ? data.columns.indexOf("ttl") : -1;

  // ---- DataRow（memo）的行級派生 props：選取移動 / 編輯 / 框選只重繪受影響的列 ----
  // 可見欄清單（含欄索引 j 與可見序位 pos）；columns / hidden 變動才重建。
  const visibleCols = useMemo<VisibleCol[]>(() => {
    if (!data) return [];
    let pos = 0;
    return data.columns
      .map((name, j) => ({ name, j }))
      .filter(({ name }) => !hidden.includes(name))
      .map(({ name, j }) => ({ name, j, pos: pos++ }));
  }, [data, hidden]);
  // 待套用編輯按列分組：無編輯的列拿到 undefined（識別穩定，不觸發重繪）。
  const editsByRow = useMemo(() => {
    const m: Record<number, Record<number, string | null>> = {};
    for (const k of Object.keys(edits)) {
      const idx = k.indexOf(":");
      const r = Number(k.slice(0, idx));
      const c = Number(k.slice(idx + 1));
      (m[r] ??= {})[c] = edits[k];
    }
    return m;
  }, [edits]);
  // 穩定的列事件處理器：DataRow 的 memo 不被 handler 識別變動打破。
  // 內部一律經 latestRef 讀「最新」state 與函式（updateLatest() 於下方各函式定義後呼叫），
  // 避免 stale closure（對齊 App.tsx fileShortcutRef 的既有慣例）。
  const latestRef = useRef<any>(null);
  const rowHandlers = useMemo<RowHandlers>(() => ({
    rowContext(e, i) {
      const L = latestRef.current;
      const row = L.data?.rows[i];
      if (!row || L.keyIdx < 0) return;
      const key = row[L.keyIdx];
      if (key == null) return;
      e.preventDefault();
      L.setRowMenu({ key, ttl: L.ttlIdx >= 0 ? row[L.ttlIdx] : null, x: e.clientX, y: e.clientY });
    },
    rowNumClick(e, i) {
      const L = latestRef.current;
      // 點列號看整列表單；Shift+點選整列（沿可見欄全寬，接著 Ctrl+C 複製整列 / 看統計）。
      if (e.shiftKey && L.rangeVisIdx.length > 0) {
        const anchorR = L.selected ? L.selected.r : i;
        L.setSelected({ r: anchorR, c: L.rangeVisIdx[0] });
        L.setRangeEnd({ r: i, c: L.rangeVisIdx[L.rangeVisIdx.length - 1] });
        gridRef.current?.focus();
      } else L.setRowDetail(i);
    },
    toggleMark: (i) => latestRef.current.toggleMark(i),
    cellClick(e, i, j) {
      const L = latestRef.current;
      // Shift+點選：以目前選取格為錨點框選矩形範圍（Ctrl+C 整塊複製）；一般點選則重置為單格。
      if (e.shiftKey && L.selected) L.setRangeEnd({ r: i, c: j });
      else { L.setSelected({ r: i, c: j }); L.setRangeEnd(null); }
      (e.currentTarget.closest(".at-grid") as HTMLElement | null)?.focus();
    },
    cellDoubleClick(i, j, redisKeyCol, val) {
      const L = latestRef.current;
      if (redisKeyCol) L.setDetailKey(val);
      else if (L.editable) L.openEditor(i, j);
    },
    cellContext(e, i, j) {
      const L = latestRef.current;
      e.preventDefault();
      // 右鍵落在框選範圍內時保留範圍（供「複製範圍 / 範圍設為 NULL」）；否則重置為單格。
      if (!(L.rangeEnd && L.inRange(i, j))) { L.setSelected({ r: i, c: j }); L.setRangeEnd(null); }
      L.setCellMenu({ r: i, c: j, x: e.clientX, y: e.clientY });
    },
    commitEdit: (r, c, raw, setNull) => latestRef.current.commitEdit(r, c, raw, setNull),
    cancelEdit: () => latestRef.current.setEditing(null),
    advanceCell: (r, c, dir) => latestRef.current.advanceCell(r, c, dir),
    deleteRow: (i) => latestRef.current.deleteRow(i),
  }), []);

  const cellValue = (r: number, c: number): string | null => {
    const key = `${r}:${c}`;
    if (key in edits) return edits[key];
    return data!.rows[r][c];
  };

  const commitEdit = (r: number, c: number, raw: string, setNull: boolean) => {
    const original = data!.rows[r][c];
    const next = setNull ? null : raw;
    const key = `${r}:${c}`;
    setEdits((e) => {
      const copy = { ...e };
      if (next === original) delete copy[key];
      else copy[key] = next;
      return copy;
    });
    setEditing(null);
  };

  // 開啟某格的就地編輯器。seed != null 時以該文字起頭（直接打字 / Backspace 清空）。
  const openEditor = (r: number, c: number, seed: string | null = null) => {
    setEditSeed(seed);
    setEditing({ r, c });
  };

  // 撤銷單一儲存格的待套用編輯（右鍵「還原此格」），不影響其他待套用編輯。
  const revertCell = (r: number, c: number) =>
    setEdits((e) => {
      const copy = { ...e };
      delete copy[`${r}:${c}`];
      return copy;
    });

  // 鍵盤編輯時 Enter/Tab 推進到下一格（Tab 於列尾換行、Shift 反向）。移動後把焦點交還資料表容器。
  const advanceCell = (r: number, c: number, dir: "down" | "up" | "right" | "left") => {
    if (!data) return;
    const maxR = data.rows.length - 1;
    const visIdx = data.columns.map((_, j) => j).filter((j) => !isHidden(data.columns[j]));
    const pos = visIdx.indexOf(c);
    let nr = r;
    let nc = c;
    if (dir === "down") nr = Math.min(maxR, r + 1);
    else if (dir === "up") nr = Math.max(0, r - 1);
    else if (dir === "right") {
      if (pos >= 0 && pos < visIdx.length - 1) nc = visIdx[pos + 1];
      else if (r < maxR) { nr = r + 1; nc = visIdx[0]; } // 列尾 Tab → 下一列首欄
    } else if (dir === "left") {
      if (pos > 0) nc = visIdx[pos - 1];
      else if (r > 0) { nr = r - 1; nc = visIdx[visIdx.length - 1]; } // 列首 Shift+Tab → 上一列末欄
    }
    setSelected({ r: nr, c: nc });
    setRangeEnd(null);
    requestAnimationFrame(() => gridRef.current?.focus());
  };

  // 主鍵定位值：Mongo 的 _id 用 row_ids（canonical extended JSON）以精確定位任意型別 _id
  // （ObjectId / Int64 / Date 等）；其他 driver 用原始格值。與 rows 對齊。
  const pkLocate = (r: number): (string | null)[] => {
    if (!data) return [];
    if (data.primary_key.length === 1 && data.primary_key[0] === "_id" && data.row_ids?.[r] != null) {
      return [data.row_ids[r]];
    }
    return data.primary_key.map((pkCol) => data.rows[r][data.columns.indexOf(pkCol)]);
  };

  const applyEdits = async () => {
    if (!data || dirtyCount === 0) return;
    setApplying(true);
    setErr(null);
    let applied = 0;
    const total = dirtyCount;
    try {
      for (const [key, newVal] of Object.entries(edits)) {
        const [rStr, cStr] = key.split(":");
        const r = Number(rStr);
        const c = Number(cStr);
        const pkValues = pkLocate(r);
        await api.updateCell(tab.connId, tab.database, tab.table, {
          column: data.columns[c],
          new_value: newVal,
          pk_columns: data.primary_key,
          pk_values: pkValues,
        });
        applied++;
      }
      load();
    } catch (e: any) {
      const msg = e?.message ?? t("未知錯誤");
      // 逐筆套用：失敗前已套用的 (applied) 筆已寫入 DB。明確告知部分套用狀態，
      // 重新套用是安全的（已套用者會以相同值覆寫，等同無變化）。
      setErr(
        applied > 0
          ? t("已套用 {applied}/{total} 筆，第 {next} 筆失敗：{msg}。修正後可再次套用（已套用者會以相同值覆寫，不會重複）。", { applied, total, next: applied + 1, msg })
          : t("套用失敗：{msg}", { msg })
      );
    } finally {
      setApplying(false);
    }
  };

  // 點欄位標題循環切換排序：無 → asc → desc → 無。
  // Shift+點擊：多欄排序——在既有排序上附加 / 切換 / 移除此欄（致敬 DataGrip / DBeaver）。
  const toggleSort = async (col: string, additive: boolean) => {
    if (!(await guardDiscard())) return;
    setPage(0);
    setSorts((prev) => {
      const existing = prev.find((s) => s.column === col);
      if (!additive) {
        if (!existing) return [{ column: col, dir: "asc" }];
        if (existing.dir === "asc") return [{ column: col, dir: "desc" }];
        return [];
      }
      const others = prev.filter((s) => s.column !== col);
      if (!existing) return [...others, { column: col, dir: "asc" }];
      if (existing.dir === "asc") return [...others, { column: col, dir: "desc" }];
      return others; // desc → 移除此欄
    });
  };
  const sortDirOf = (col: string): SortDir | null =>
    sorts.find((s) => s.column === col)?.dir ?? null;
  // 多欄排序時，此欄在排序序列中的次序（1-based）；單欄回 0（不顯示徽章）。
  const sortOrderOf = (col: string): number => {
    if (sorts.length < 2) return 0;
    const idx = sorts.findIndex((s) => s.column === col);
    return idx < 0 ? 0 : idx + 1;
  };

  const deleteRow = async (r: number) => {
    if (!data || !editable) return;
    const pkValues = pkLocate(r);
    const editsNote = dirtyCount > 0 ? t("\n（將同時放棄 {dirtyCount} 筆未套用的編輯）", { dirtyCount }) : "";
    if (!(await uiConfirm(t("確定刪除此列？此動作無法復原。") + editsNote, { title: t("刪除列"), danger: true, confirmText: t("刪除") }))) return;
    setApplying(true);
    setErr(null);
    try {
      await api.deleteRow(tab.connId, tab.database, tab.table, {
        pk_columns: data.primary_key,
        pk_values: pkValues,
      });
      load();
    } catch (e: any) {
      setErr(e?.message ?? t("刪除失敗"));
    } finally {
      setApplying(false);
    }
  };

  const toggleMark = (r: number) =>
    setMarked((m) => { const n = new Set(m); if (n.has(r)) n.delete(r); else n.add(r); return n; });

  // 每次 render 更新 rowHandlers 讀取的「最新」state / 函式（放在所有相依函式定義之後）。
  latestRef.current = {
    data, selected, rangeEnd, rangeVisIdx, editable, keyIdx, ttlIdx, inRange,
    toggleMark, setRowDetail, openEditor, commitEdit, advanceCell, deleteRow,
    setDetailKey, setCellMenu, setRowMenu, setSelected, setRangeEnd, setEditing,
  };

  // 批次刪除已標記列：先擷取各列主鍵值（避免逐筆刪除後索引位移），再逐筆依主鍵刪除，最後重載。
  const bulkDelete = async () => {
    if (!data || !editable || marked.size === 0) return;
    const idxs = [...marked];
    const bulkEditsNote = dirtyCount > 0 ? t("\n（將同時放棄 {dirtyCount} 筆未套用的編輯）", { dirtyCount }) : "";
    if (!(await uiConfirm(t("確定刪除選取的 {length} 列？此動作無法復原。", { length: idxs.length }) + bulkEditsNote,
      { title: t("刪除選取列"), danger: true, confirmText: t("刪除 {length} 列", { length: idxs.length }) }))) return;
    const pkSets = idxs.map((r) => pkLocate(r));
    setApplying(true);
    setErr(null);
    try {
      for (const pkValues of pkSets)
        await api.deleteRow(tab.connId, tab.database, tab.table, { pk_columns: data.primary_key, pk_values: pkValues });
      setMarked(new Set());
      load();
    } catch (e: any) {
      setErr(e?.message ?? t("批次刪除失敗"));
      load(); // 反映可能的部分刪除結果
    } finally {
      setApplying(false);
    }
  };

  // 匯出已勾選的列（本頁）：走後端 export_rows，依副檔名選格式（含 Excel）。
  const exportMarked = async () => {
    if (!data || marked.size === 0) return;
    const idxs = [...marked].sort((a, b) => a - b);
    const rows = idxs.map((i) => data.rows[i]);
    const path = await pickSaveFile(`${tab.table}-selection.csv`, [
      { name: "CSV", extensions: ["csv"] },
      { name: "Excel (.xlsx)", extensions: ["xlsx"] },
      { name: "JSON", extensions: ["json"] },
      { name: "TSV", extensions: ["tsv", "txt"] },
      { name: "SQL (INSERT)", extensions: ["sql"] },
      { name: "Markdown", extensions: ["md"] },
    ]);
    if (!path) return;
    const lower = path.toLowerCase();
    const fmt = lower.endsWith(".xlsx") ? "xlsx" : lower.endsWith(".json") ? "json"
      : lower.endsWith(".md") ? "markdown" : lower.endsWith(".sql") ? "sql"
      : lower.endsWith(".tsv") || lower.endsWith(".txt") ? "tsv" : "csv";
    try {
      const res = await api.exportRows(data.columns, rows, {
        format: fmt,
        include_header: true,
        all_rows: true,
        bom: fmt === "csv" || fmt === "tsv",
        sql_table: fmt === "sql" ? tab.table : null,
      }, path);
      toast.success(t("已匯出 {rows} 列 · {toUpperCase}", { rows: res.rows, toUpperCase: fmt.toUpperCase() }));
    } catch (e: any) {
      toast.error(e?.message ?? t("匯出失敗"));
    }
  };

  // 複製已勾選的列為 INSERT 語句到剪貼簿（SQL 連線；快速貼到別處）。
  const copyMarkedInsert = () => {
    if (!data || marked.size === 0 || !connKind) return;
    const idxs = [...marked].sort((a, b) => a - b);
    const rows = idxs.map((i) => data.rows[i]);
    copyToClipboard(buildInsertValues(connKind, tab.database, tab.table, data.columns, rows), t("已複製 {length} 列為 INSERT", { length: rows.length }));
  };

  const submitInsert = async (row: RowInsert) => {
    setApplying(true);
    setErr(null);
    try {
      await api.insertRow(tab.connId, tab.database, tab.table, row);
      setInserting(false);
      setInsertInitial(undefined);
      load();
    } catch (e: any) {
      setErr(e?.message ?? t("新增失敗"));
    } finally {
      setApplying(false);
    }
  };

  // ---- SQL 表儲存格：複製 / 重製 / 鍵盤導覽（致敬 DBeaver / TablePlus）----
  // 取某列目前各欄值（含尚未套用的編輯）。
  const rowValues = (r: number): (string | null)[] =>
    data ? data.columns.map((_, j) => cellValue(r, j)) : [];

  const copyCell = (r: number, c: number) =>
    copyToClipboard(cellValue(r, c) ?? "", t("已複製儲存格"));
  const copyRowTsv = (r: number) =>
    copyToClipboard(rowValues(r).map((v) => v ?? "").join("\t"), t("已複製整列 (TSV)"));
  const copyRowJson = (r: number) => {
    if (!data) return;
    const vals = rowValues(r);
    const obj = Object.fromEntries(data.columns.map((c, j) => [c, vals[j] ?? null]));
    copyToClipboard(JSON.stringify(obj, null, 2), t("已複製整列 (JSON)"));
  };
  const copyRowInsert = (r: number) => {
    if (!data) return;
    // 共用 sql.ts 的跨資料庫跳脫（PostgreSQL 雙引號、其餘反引號；字面值單引號轉義）。
    const k = connKind ?? "mysql";
    const cols = data.columns.map((c) => quoteIdent(k, c)).join(", ");
    const lits = rowValues(r).map((v) => sqlLiteral(k, v)).join(", ");
    copyToClipboard(`INSERT INTO ${quoteIdent(k, tab.table)} (${cols}) VALUES (${lits});`, t("已複製為 INSERT"));
  };
  // 由某列產生 UPDATE / DELETE（需主鍵定位）。
  const pkValuesOf = (r: number): (string | null)[] =>
    data ? data.primary_key.map((pk) => cellValue(r, data.columns.indexOf(pk))) : [];
  const copyRowUpdate = (r: number) => {
    if (!data) return;
    const k = connKind ?? "mysql";
    copyToClipboard(
      buildRowUpdate(k, tab.table, data.columns, rowValues(r), data.primary_key, pkValuesOf(r)),
      t("已複製為 UPDATE"),
    );
  };
  const copyRowDelete = (r: number) => {
    if (!data) return;
    const k = connKind ?? "mysql";
    copyToClipboard(buildRowDelete(k, tab.table, data.primary_key, pkValuesOf(r)), t("已複製為 DELETE"));
  };
  // 定位此列的 SELECT（唯讀安全：不寫入，readonly 連線亦可用）。
  const copyRowSelect = (r: number) => {
    if (!data) return;
    const k = connKind ?? "mysql";
    copyToClipboard(buildRowSelect(k, tab.table, data.primary_key, pkValuesOf(r)), t("已複製為 SELECT"));
  };
  const duplicateRow = (r: number) => {
    if (!data) return;
    const vals = rowValues(r);
    const init: Record<string, string | null> = {};
    data.columns.forEach((c, j) => (init[c] = vals[j]));
    setInsertInitial(init);
    setInserting(true);
  };
  // 欄位資料剖析（致敬 Navicat / DataGrip）：總數 / 非空 / 相異。
  // Mongo 回傳含型別分布 / Top 值等豐富統計（types 非空）→ 開統計視窗；SQL 維持輕量 toast。
  const colStats = async (col: string) => {
    try {
      const s = await api.columnStats(tab.connId, tab.database, tab.table, col);
      if (s.types && s.types.length > 0) {
        setFieldStats({ col, stats: s });
        return;
      }
      const range = s.min !== null || s.max !== null ? t(" · 範圍 [{min}, {max}]", { min: s.min ?? "?", max: s.max ?? "?" }) : "";
      toast.info(t("欄位「{col}」：{total} 列 · {non_null} 非空 · {distinct} 相異值{range}", { col, total: s.total, non_null: s.non_null, distinct: s.distinct, range }));
    } catch (e: any) {
      toast.error(e?.message ?? t("取得欄位統計失敗"));
    }
  };

  // 以某儲存格的值設定篩選（致敬 TablePlus / DBeaver 的「Filter by this value」）。
  const filterByCell = async (r: number, c: number, exclude: boolean) => {
    if (!data) return;
    if (!(await guardDiscard())) return;
    const col = data.columns[c];
    const v = cellValue(r, c);
    const f: FilterCond =
      v === null
        ? { column: col, op: exclude ? "is_not_null" : "is_null", value: null }
        : { column: col, op: exclude ? "!=" : "=", value: v };
    setPage(0);
    setMatchAny(false);
    setFilters([f]);
    setShowFilter(true);
  };

  // 儲存格選單項目（依是否可編輯增列）。"sep" 為分隔線。
  const cellMenuItems = (r: number, c: number): ([string, () => void, boolean] | "sep")[] => {
    const items: ([string, () => void, boolean] | "sep")[] = [
      [t("檢視內容…"), () => setInspect({ r, c }), false],
      [t("複製值"), () => copyCell(r, c), false],
      // 右鍵落在框選範圍內：提供整塊複製（滑鼠路徑，與 Ctrl+C 一致）。
      ...(rangeEnd && inRange(r, c)
        ? [
            [t("複製範圍 (TSV)"), () => copyRange(), false] as [string, () => void, boolean],
            [t("複製範圍 (Markdown)"), () => copyRangeMarkdown(), false] as [string, () => void, boolean],
          ]
        : []),
      [t("複製整列 (JSON)"), () => copyRowJson(r), false],
      [t("複製整列 (TSV)"), () => copyRowTsv(r), false],
      // INSERT 範本僅對 SQL 資料庫有意義（Mongo 用 JSON）。
      ...(isSqlKind ? [[t("複製為 INSERT"), () => copyRowInsert(r), false] as [string, () => void, boolean]] : []),
      // SELECT（定位此列）：需主鍵但唯讀安全，唯讀連線也提供。
      ...(isSqlKind && (data?.primary_key.length ?? 0) > 0
        ? [[t("複製為 SELECT（定位此列）"), () => copyRowSelect(r), false] as [string, () => void, boolean]]
        : []),
      // UPDATE / DELETE 範本需主鍵定位。
      ...(isSqlKind && editable
        ? [
            [t("複製為 UPDATE"), () => copyRowUpdate(r), false] as [string, () => void, boolean],
            [t("複製為 DELETE"), () => copyRowDelete(r), false] as [string, () => void, boolean],
          ]
        : []),
      // Mongo：整份文件 JSON 編輯（正確處理巢狀 / ObjectId / Date，避免表格逐格編輯破壞結構）。
      ...(isMongo && editable
        ? [[t("編輯文件（JSON）…"), () => setDocEdit(r), false] as [string, () => void, boolean]]
        : []),
      "sep",
      [t("篩選此值"), () => filterByCell(r, c, false), false],
      [t("排除此值"), () => filterByCell(r, c, true), false],
    ];
    // 外鍵導覽：此欄是外鍵且值非 NULL → 開被參照表並過濾到該列（致敬 Navicat / TablePlus）。
    const fkCol = data?.columns[c];
    const fk = fkCol ? fkMap[fkCol] : undefined;
    const fkVal = cellValue(r, c);
    if (fk && fkVal !== null) {
      items.push([
        t("跳至 {ref_table}（{ref_column} = {value}）", { ref_table: fk.ref_table, ref_column: fk.ref_column, value: fkVal.length > 18 ? fkVal.slice(0, 18) + "…" : fkVal }),
        () => useStore.getState().openTableFiltered(tab.connId, tab.database, fk.ref_table, fk.ref_column, fkVal),
        false,
      ]);
    }
    // 反向外鍵：主鍵欄位的儲存格 → 尋找參照此列的列（被哪些表的外鍵指到）。
    if (isSqlKind && fkCol && fkVal !== null && data?.primary_key.includes(fkCol)) {
      const mx = cellMenu?.x ?? 0;
      const my = cellMenu?.y ?? 0;
      items.push([t("尋找參照此列的列…"), () => findReferencing(r, c, mx, my), false]);
    }
    if (editable) {
      items.push(
        "sep",
        [t("編輯儲存格"), () => openEditor(r, c), false],
        [t("設為 NULL"), () => commitEdit(r, c, "", true), false]
      );
      // 框選範圍內：整塊設 NULL（滑鼠路徑，與 Delete 一致）。
      if (rangeEnd && inRange(r, c)) items.push([t("範圍填入值…"), () => fillRange(), false]);
      if (rangeEnd && inRange(r, c)) items.push([t("範圍設為 NULL"), () => nullRange(), false]);
      // 此格有待套用編輯時，提供單格還原（不影響其他待套用編輯）。
      if (`${r}:${c}` in edits) items.push([t("還原此格"), () => revertCell(r, c), false]);
      items.push(
        [t("以此列為範本新增…"), () => duplicateRow(r), false],
        [t("刪除此列"), () => deleteRow(r), true]
      );
    }
    return items;
  };

  // 框選範圍的列 / 可見欄邊界（錨點 = selected，遠端角 = rangeEnd）。欄被隱藏導致序位失效則回 null。
  const rangeBounds = (): { r1: number; r2: number; cols: number[] } | null => {
    if (!selected || !rangeEnd) return null;
    const p1 = rangeVisIdx.indexOf(selected.c), p2 = rangeVisIdx.indexOf(rangeEnd.c);
    if (p1 < 0 || p2 < 0) return null;
    return {
      r1: Math.min(selected.r, rangeEnd.r),
      r2: Math.max(selected.r, rangeEnd.r),
      cols: rangeVisIdx.slice(Math.min(p1, p2), Math.max(p1, p2) + 1),
    };
  };
  const copyRange = () => {
    const b = rangeBounds();
    if (!b) return;
    const rows = Array.from({ length: b.r2 - b.r1 + 1 }, (_, k) => b.r1 + k);
    copyToClipboard(rectToTsv((rr, cc) => cellValue(rr, cc), rows, b.cols), t("已複製 {length}×{v2} 區塊 (TSV)", { length: rows.length, v2: b.cols.length }));
  };
  const copyRangeMarkdown = () => {
    const b = rangeBounds();
    if (!b || !data) return;
    const rows = Array.from({ length: b.r2 - b.r1 + 1 }, (_, k) => b.r1 + k);
    copyToClipboard(
      rectToMarkdown((rr, cc) => cellValue(rr, cc), rows, b.cols, (c) => data.columns[c]),
      t("已複製 {length}×{v2} 區塊 (Markdown)", { length: rows.length, v2: b.cols.length }),
    );
  };
  const nullRange = () => {
    const b = rangeBounds();
    if (!b) return;
    for (let rr = b.r1; rr <= b.r2; rr++) for (const cc of b.cols) commitEdit(rr, cc, "", true);
  };
  // 範圍填值（Navicat 風「填滿」）：以同一值填入框選矩形的每一格（設 NULL 請用「範圍設為 NULL」）。
  const fillRange = async () => {
    const b = rangeBounds();
    if (!b) return;
    const v = await uiPrompt(t("填入框選範圍的值："), { title: t("範圍填值"), placeholder: t("值（留空＝空字串）"), confirmText: t("填入") });
    if (v === null) return;
    for (let rr = b.r1; rr <= b.r2; rr++) for (const cc of b.cols) commitEdit(rr, cc, v, false);
  };
  // 框選範圍統計（Excel 狀態列手感）：總格數 / 數值格數 / 加總 / 平均。含待套用編輯值；以 edits 為相依重算。
  const selectionStats = useMemo(() => {
    const b = rangeBounds();
    if (!b) return null;
    const vals: (string | null)[] = [];
    for (let rr = b.r1; rr <= b.r2; rr++) for (const cc of b.cols) vals.push(cellValue(rr, cc));
    return { rows: b.r2 - b.r1 + 1, colsN: b.cols.length, ...rangeStats(vals) };
    // rangeBounds / cellValue 為每次 render 重建的閉包，以其讀取的狀態為相依。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, rangeEnd, edits, data]);
  // 統計數字顯示：整數加千分位，含小數則限 2 位。
  const fmtNum = (n: number) =>
    Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  // 鍵盤導覽：方向鍵 / Tab 移動選取，Enter / F2 編輯，Ctrl+C 複製，Esc 取消選取，F5 重新整理。
  const onGridKey = (e: React.KeyboardEvent) => {
    if (!data || editing || applying) return;
    // 有覆蓋層開啟時（列詳情 / 儲存格檢視 / Redis 鍵詳情 / 新增列）停手，
    // 避免方向鍵在背後的資料表又移動選取（覆蓋層自有鍵盤處理）。
    if (rowDetail !== null || inspect || detailKey || inserting) return;
    if (e.key === "F5") { e.preventDefault(); load(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) { e.preventDefault(); setShowFind(true); return; }
    // Ctrl+S 套用待套用的儲存格編輯（上方守衛已排除對話框開啟 / 套用中的情況）。
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (dirtyCount > 0) applyEdits();
      return;
    }
    // Ctrl+A：框選整頁所有可見儲存格（接著 Ctrl+C 複製整頁、或狀態列看統計）。
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      if (data.rows.length === 0 || rangeVisIdx.length === 0) return;
      setSelected({ r: 0, c: rangeVisIdx[0] });
      setRangeEnd({ r: data.rows.length - 1, c: rangeVisIdx[rangeVisIdx.length - 1] });
      return;
    }
    if (!selected) return;
    const maxR = data.rows.length - 1;
    if (maxR < 0) return;
    let { r, c } = selected;
    const k = e.key;
    // 左右移動時跳過隱藏欄（只在可見欄之間移動）。
    const visIdx = data.columns.map((_, j) => j).filter((j) => !isHidden(data.columns[j]));
    const pos = visIdx.indexOf(c);
    // Shift+方向鍵：以選取格為錨點延伸 / 收縮矩形範圍（移動範圍的遠端角，不動錨點）。放在一般方向鍵前處理。
    if (e.shiftKey && (k === "ArrowDown" || k === "ArrowUp" || k === "ArrowRight" || k === "ArrowLeft")) {
      e.preventDefault();
      const far = rangeEnd ?? selected;
      const fpos = visIdx.indexOf(far.c);
      let nr = far.r;
      let nc = far.c;
      if (k === "ArrowDown") nr = Math.min(maxR, far.r + 1);
      else if (k === "ArrowUp") nr = Math.max(0, far.r - 1);
      else if (k === "ArrowRight") { if (fpos >= 0 && fpos < visIdx.length - 1) nc = visIdx[fpos + 1]; }
      else if (fpos > 0) nc = visIdx[fpos - 1];
      setRangeEnd({ r: nr, c: nc });
      return;
    }
    if (k === "ArrowDown") r = Math.min(maxR, r + 1);
    else if (k === "ArrowUp") r = Math.max(0, r - 1);
    else if (k === "ArrowRight" || (k === "Tab" && !e.shiftKey)) {
      if (pos >= 0 && pos < visIdx.length - 1) c = visIdx[pos + 1];
      else if (k === "Tab" && r < maxR) { r = r + 1; c = visIdx[0]; } // 列尾 Tab → 下一列首欄
    } else if (k === "ArrowLeft" || (k === "Tab" && e.shiftKey)) {
      if (pos > 0) c = visIdx[pos - 1];
      else if (k === "Tab" && r > 0) { r = r - 1; c = visIdx[visIdx.length - 1]; } // 列首 Shift+Tab → 上一列末欄
    }
    else if (k === "Home") {
      // Home → 本列首欄；Ctrl+Home → 整表左上角（試算表慣例）。
      c = visIdx[0];
      if (e.ctrlKey || e.metaKey) r = 0;
    } else if (k === "End") {
      // End → 本列末欄；Ctrl+End → 整表右下角。
      c = visIdx[visIdx.length - 1];
      if (e.ctrlKey || e.metaKey) r = maxR;
    } else if (k === "PageUp") {
      r = Math.max(0, r - 20);
    } else if (k === "PageDown") {
      r = Math.min(maxR, r + 20);
    }
    else if (k === "Enter" || k === "F2") {
      if (editable) { openEditor(r, c); e.preventDefault(); }
      return;
    } else if (k === "Escape") { setSelected(null); setRangeEnd(null); return; }
    else if ((e.ctrlKey || e.metaKey) && (k === "c" || k === "C")) {
      // 區塊複製：矩形範圍（含待套用編輯值）輸出為 TSV；無範圍則複製單格。
      e.preventDefault();
      if (rangeEnd) copyRange();
      else copyCell(r, c);
      return;
    }
    else if (editable && k === "Delete") {
      // Delete → 設為 NULL（最常見的破壞性編輯，免走右鍵選單）。有框選範圍則整塊設 NULL。
      e.preventDefault();
      if (rangeEnd) nullRange();
      else commitEdit(r, c, "", true);
      return;
    }
    else if (editable && k === "Backspace") {
      // Backspace → 清空後進入編輯（Excel 慣例）。
      openEditor(r, c, ""); e.preventDefault(); return;
    }
    else if ((e.ctrlKey || e.metaKey) && (k === "v" || k === "V")) {
      if (editable) {
        e.preventDefault();
        const baseR = r;
        const baseC = c;
        const startPos = pos; // 選取格在可見欄中的序位
        const rng = rangeEnd; // 框選範圍（用於單值填滿整塊）
        navigator.clipboard.readText()
          .then((txt) => {
            if (!txt) return;
            const grid = parseClipboardGrid(txt);
            // 單格：有框選範圍則整塊填入同一值（Excel 慣例）；否則貼到選取格。
            if (grid.length === 1 && grid[0].length === 1) {
              const v = grid[0][0];
              if (rng) {
                const r1 = Math.min(baseR, rng.r), r2 = Math.max(baseR, rng.r);
                const p1 = visIdx.indexOf(baseC), p2 = visIdx.indexOf(rng.c);
                const cols = visIdx.slice(Math.min(p1, p2), Math.max(p1, p2) + 1);
                let n = 0;
                for (let rr = r1; rr <= r2; rr++) for (const cc of cols) { commitEdit(rr, cc, v, false); n++; }
                toast.success(t("已填入 {n} 格", { n }));
              } else {
                commitEdit(baseR, baseC, v, false);
                toast.success(t("已貼上到儲存格"));
              }
              return;
            }
            // 區塊貼上：以選取格為左上角，沿可見欄 / 列範圍展開（超出範圍者略過），暫存待套用。
            let applied = 0;
            grid.forEach((rowVals, ri) => {
              const tr = baseR + ri;
              if (tr > maxR) return;
              rowVals.forEach((val, ci) => {
                const vp = startPos + ci;
                if (vp < 0 || vp >= visIdx.length) return;
                commitEdit(tr, visIdx[vp], val, false);
                applied++;
              });
            });
            toast.success(t("已貼上 {applied} 格（待套用）", { applied }));
          })
          .catch(() => toast.error(t("無法讀取剪貼簿")));
      }
      return;
    }
    else if (
      editable && k.length === 1 && k !== " " &&
      !e.ctrlKey && !e.metaKey && !e.altKey &&
      !e.nativeEvent.isComposing && (e.nativeEvent as KeyboardEvent).keyCode !== 229
    ) {
      // 直接打字（非空白、非組字）：以該鍵起頭開啟編輯器（overtype），省去先按 F2。
      // IME 組字中（注音/拼音，isComposing / keyCode 229）不在此攔截，避免吞掉組字鍵；
      // 空白鍵保留給捲動。需以中文覆寫時用 F2 / 雙擊開編輯器後組字。
      openEditor(r, c, k); e.preventDefault(); return;
    }
    else return;
    e.preventDefault();
    setSelected({ r, c });
    setRangeEnd(null); // 鍵盤導覽即重置範圍選取（範圍由 Shift+點選建立）
  };

  // ---- Redis 鍵列右鍵操作 ----
  // 重整：遞增資料重載 nonce → 同時刷新網格（load 的 effect 依賴）與鍵樹（nonce prop）。
  const refresh = () => useStore.getState().bumpDataReload(tab.connId, tab.database, tab.table);

  const renameKey = async (key: string) => {
    const nv = await uiPrompt(t("輸入新的鍵名："), {
      title: t("重新命名鍵"), defaultValue: key, confirmText: t("重新命名"),
    });
    if (nv === null || nv.trim() === "" || nv === key) return;
    setApplying(true);
    setErr(null);
    try {
      await api.keyEdit(tab.connId, tab.database, key, { action: "rename", new_key: nv });
      toast.success(t("已重新命名"));
      refresh();
    } catch (e: any) {
      const msg = e?.message ?? t("重新命名失敗");
      setErr(msg);
      toast.error(msg); // 樹狀模式未掛載網格的錯誤橫幅，改用 toast 確保可見
    } finally {
      setApplying(false);
    }
  };

  const setKeyTtl = async (key: string, current: string | null) => {
    const v = await uiPrompt(t("TTL 秒數（-1 表示永不過期）："), {
      title: t("設定 TTL"), defaultValue: current ?? "-1", confirmText: t("套用"),
    });
    if (v === null) return;
    setApplying(true);
    setErr(null);
    try {
      await api.updateCell(tab.connId, tab.database, tab.table, {
        column: "ttl",
        new_value: v,
        pk_columns: ["key"],
        pk_values: [key],
      });
      toast.success(t("已設定 TTL"));
      refresh();
    } catch (e: any) {
      const msg = e?.message ?? t("設定 TTL 失敗");
      setErr(msg);
      toast.error(msg);
    } finally {
      setApplying(false);
    }
  };

  // 依鍵名刪除（鍵樹與右鍵選單共用，不需網格列索引）。
  const deleteKey = async (key: string) => {
    if (!(await uiConfirm(t("確定刪除鍵「{key}」？此動作無法復原。", { key }), { title: t("刪除鍵"), danger: true, confirmText: t("刪除") }))) return;
    setApplying(true);
    setErr(null);
    try {
      await api.deleteRow(tab.connId, tab.database, tab.table, { pk_columns: ["key"], pk_values: [key] });
      toast.success(t("已刪除"));
      refresh();
    } catch (e: any) {
      const msg = e?.message ?? t("刪除失敗");
      setErr(msg);
      toast.error(msg);
    } finally {
      setApplying(false);
    }
  };

  // 切換頁面前，若有未套用的變更先確認（避免靜默丟失編輯）。
  const navPage = async (target: number) => {
    if (dirtyCount > 0 && !(await uiConfirm(t("有未套用的變更，切換頁面將放棄。確定？"), { title: t("放棄變更"), danger: true, confirmText: t("放棄並切換") }))) return;
    setPage(target);
  };
  // 變更每頁列數同樣會重載並丟棄編輯，故套用相同的未套用變更確認。
  const changePageSize = async (n: number) => {
    if (dirtyCount > 0 && !(await uiConfirm(t("有未套用的變更，變更每頁列數將放棄。確定？"), { title: t("放棄變更"), danger: true, confirmText: t("放棄並變更") }))) return;
    setPage(0);
    setPageSize(n);
  };

  // 即時尋找：目前頁符合的儲存格數（僅在尋找時計算）。
  const findLower = find.trim().toLowerCase();
  const matchCount =
    findLower && data
      ? data.rows.reduce(
          (acc, row, ri) =>
            acc +
            row.reduce((a, _c, ci) => {
              // 與渲染一致：跳過隱藏欄（否則計數會多於可見高亮數）。
              if (isHidden(data.columns[ci])) return a;
              const v = cellValue(ri, ci);
              return a + (v != null && v.toLowerCase().includes(findLower) ? 1 : 0);
            }, 0),
          0
        )
      : 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 動作列：重新整理 + 篩選切換 + 新增列 */}
      <div className="flex items-center gap-1 px-2 py-1 bg-inset border-b border-fg/10 text-xs">
        {isRedis && (
          <div className="flex items-center rounded border border-fg/10 overflow-hidden mr-1">
            {(["tree", "grid"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setRedisViewPersist(v)}
                title={v === "tree" ? t("命名空間樹狀檢視（依 : 分組）") : t("鍵列表（網格）")}
                className={`px-2 py-1 inline-flex items-center gap-1 ${redisView === v ? "bg-fg/15 text-fg" : "text-fg/50 hover:bg-fg/5"}`}
              >
                {v === "tree"
                  ? <><Icon icon={ListTree} size={14} /> {t("樹狀")}</>
                  : <><Icon icon={Table2} size={14} /> {t("網格")}</>}
              </button>
            ))}
          </div>
        )}
        {isRedis && (
          <>
            <button type="button" onClick={() => setShowNewKey(true)} title={t("新增鍵（String/List/Set/Hash/ZSet）")}
              className="px-2 py-1 rounded hover:bg-fg/10 text-emerald-300 inline-flex items-center gap-1"><Icon icon={Plus} size={14} /> {t("新增鍵")}</button>
            <button type="button" onClick={() => setShowStatus(true)} title={t("伺服器狀態（INFO，可自動刷新）")}
              className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={BarChart3} size={14} /> {t("狀態")}</button>
            <button type="button" onClick={() => setShowPubSub(true)} title={t("Pub/Sub 訂閱與發佈")}
              className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={Network} size={14} /> Pub/Sub</button>
            <button type="button" onClick={() => setShowOps(true)} title={t("維運：慢查詢 / 用戶端 / 大鍵")}
              className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={Settings} size={14} /> {t("維運")}</button>
            <button type="button" onClick={() => setShowConsole(true)} title={t("Redis 命令列")}
              className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={Terminal} size={14} /> {t("命令列")}</button>
            <div className="w-px h-4 bg-fg/10 mx-1" />
          </>
        )}
        <button
          onClick={async () => {
            if (dirtyCount > 0 && !(await uiConfirm(t("有未套用的變更，重新整理將放棄。確定？"), { title: t("放棄變更"), danger: true, confirmText: t("放棄並重整") }))) return;
            // Redis 網格：明確「重新整理」= 強制重掃 keyspace（清鍵快照）；一般翻頁則吃快照。
            if (isRedis && redisView === "grid") await api.clearCache(tab.connId).catch(() => {});
            load();
          }}
          disabled={loading}
          title={t("重新整理（重新讀取目前頁）")}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 disabled:opacity-40 disabled:hover:bg-transparent inline-flex items-center gap-1"
        >
          <Icon icon={RefreshCw} size={14} className={loading ? "animate-spin" : ""} /> {loading ? t("讀取中…") : t("重新整理")}
        </button>
        <button
          onClick={() => setShowFind((s) => !s)}
          title={t("在目前頁即時尋找（Ctrl+F）")}
          className={`px-2 py-1 rounded hover:bg-fg/10 inline-flex items-center gap-1 ${find ? "text-yellow-300" : "text-fg/50"}`}
        >
          <Icon icon={Search} size={14} /> {t("尋找")}
        </button>
        <button
          onClick={() => setShowFilter((s) => !s)}
          className={`px-2 py-1 rounded hover:bg-fg/10 inline-flex items-center gap-1 ${
            filters.length ? "text-amber-300" : "text-fg/50"
          }`}
        >
          <Icon icon={Filter} size={14} /> {t("篩選")}{filters.length ? `（${filters.length}）` : ""}
        </button>
        <button
          onClick={() => insertable && setInserting(true)}
          disabled={!insertable}
          title={insertable ? t("新增列") : t("無欄位可新增")}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 disabled:opacity-30 disabled:hover:bg-transparent inline-flex items-center gap-1"
        >
          <Icon icon={Plus} size={14} /> {t("新增列")}
        </button>
        {marked.size > 0 && (
          <button
            onClick={exportMarked}
            title={t("匯出已勾選的列（CSV / Excel / JSON / SQL…）")}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/70 inline-flex items-center gap-1"
          >
            <Icon icon={Upload} size={14} /> {t("匯出選取（")}{marked.size}）
          </button>
        )}
        {isSqlKind && marked.size > 0 && (
          <button
            onClick={copyMarkedInsert}
            title={t("複製已勾選的列為 INSERT 語句")}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/70 inline-flex items-center gap-1"
          >
            {t("複製為 INSERT（")}{marked.size}）
          </button>
        )}
        {editable && marked.size > 0 && (
          <button
            onClick={bulkDelete}
            disabled={applying}
            title={t("刪除已勾選的列")}
            className="px-2 py-1 rounded hover:bg-red-500/20 text-red-300 disabled:opacity-30 inline-flex items-center gap-1"
          >
            <Icon icon={Trash2} size={14} /> {t("刪除選取（")}{marked.size}）
          </button>
        )}
        {sorts.length > 0 && (
          <button
            type="button"
            onClick={async () => { if (await guardDiscard()) setSorts([]); }}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 inline-flex items-center gap-1"
          >
            <Icon icon={ArrowUpDown} size={14} /> {t("清除排序")}
          </button>
        )}
        <button
          onClick={() => data && data.columns.length > 0 && setExporting(true)}
          disabled={!data || data.columns.length === 0}
          title={t("匯出資料（CSV / TSV / JSON / SQL / Markdown）")}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 disabled:opacity-30 disabled:hover:bg-transparent inline-flex items-center gap-1"
        >
          <Icon icon={Download} size={14} /> {t("匯出")}
        </button>
        {isSqlKind && (
          <button
            type="button"
            onClick={() => setImporting(true)}
            title={t("從 CSV 匯入資料到此表")}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 inline-flex items-center gap-1"
          >
            <Icon icon={Upload} size={14} /> {t("匯入")}
          </button>
        )}
        {hidden.length > 0 && (
          <button
            type="button"
            onClick={showAllColumns}
            title={t("已隱藏 {length} 欄，點此全部顯示", { length: hidden.length })}
            className="ml-auto px-2 py-1 rounded hover:bg-fg/10 text-fg/50 inline-flex items-center gap-1"
          >
            <Icon icon={Columns3} size={14} /> {t("已隱藏 {length} 欄", { length: hidden.length })}
          </button>
        )}
      </div>

      {showFind && data && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-well border-b border-fg/10 text-xs">
          <input autoFocus value={find} onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setShowFind(false); setFind(""); } }}
            placeholder={t("在目前頁即時尋找…")}
            className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent min-w-[220px]" />
          <span className="text-fg/40">{findLower ? t("{matchCount} 格符合", { matchCount }) : ""}</span>
          <button type="button" onClick={() => { setShowFind(false); setFind(""); }}
            aria-label={t("關閉尋找")} title={t("關閉尋找")}
            className="ml-auto px-1.5 py-1 rounded hover:bg-fg/10 text-fg/40"><Icon icon={X} size={14} /></button>
        </div>
      )}

      {showFilter && data && (
        <FilterBar
          columns={data.columns}
          filters={filters}
          matchAny={matchAny}
          onApply={async (f, any) => { if (await guardDiscard()) { setPage(0); setMatchAny(any); setFilters(f); } }}
        />
      )}

      {treeMode ? (
        <RedisKeyTree
          key={`${tab.connId}:${tab.database}`}
          connId={tab.connId}
          database={tab.database}
          nonce={reloadNonce}
          onOpenKey={(k) => setDetailKey(k)}
          onContextKey={(k, x, y) => setRowMenu({ key: k, ttl: null, x, y })}
        />
      ) : (
      <>
      {/* 重載期間頂部細進度條：舊資料保持可見不閃白，仍有「正在載入」的視覺回饋 */}
      <ProgressBar active={loading && !!data} />
      <div ref={gridRef} className="at-grid flex-1 overflow-auto outline-none" tabIndex={0} onKeyDown={onGridKey}>
        {err && <div className="p-3 text-red-400 text-sm mono">{err}</div>}
        {!data && loading && !err && (
          <div className="p-6 text-fg/40 text-sm flex items-center gap-2">
            <Icon icon={RefreshCw} size={14} className="animate-spin" /> {t("讀取中…")}
          </div>
        )}
        {data && data.columns.length > 0 && (
          <table
            className={`text-sm border-collapse transition-opacity ${loading || applying ? "opacity-50" : ""} ${applying ? "pointer-events-none" : ""}`}
            style={{
              tableLayout: "fixed",
              width: 48 + data.columns.filter((c) => !isHidden(c)).reduce((a, c) => a + colWidth(c), 0) + (editable ? 64 : 0),
            }}
          >
            <thead className="sticky top-0 bg-bar">
              <tr>
                {editable && (
                  <th className="px-1 py-1.5 border-b border-fg/10 text-center w-8">
                    <input type="checkbox" title={t("全選 / 取消本頁")}
                      checked={data.rows.length > 0 && marked.size === data.rows.length}
                      ref={(el) => { if (el) el.indeterminate = marked.size > 0 && marked.size < data.rows.length; }}
                      onChange={() => setMarked(marked.size === data.rows.length ? new Set() : new Set(data.rows.map((_, i) => i)))} />
                  </th>
                )}
                <th className="text-left px-3 py-1.5 border-b border-fg/10 text-fg/30 w-12">#</th>
                {data.columns.map((c, ci) => {
                  if (isHidden(c)) return null;
                  const dir = sortDirOf(c);
                  const order = sortOrderOf(c);
                  const cmt = commentMap[c];
                  return (
                    <th
                      key={c}
                      scope="col"
                      tabIndex={0}
                      {...(dir ? { "aria-sort": dir === "asc" ? "ascending" : "descending" } : {})}
                      onClick={(e) => toggleSort(c, e.shiftKey)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort(c, e.shiftKey); } }}
                      onContextMenu={(e) => { e.preventDefault(); setColMenu({ col: c, ci, x: e.clientX, y: e.clientY }); }}
                      title={cmt ? t("{cmt}\n\n點擊排序；Shift+點擊可多欄排序；右鍵更多", { cmt }) : t("點擊排序；Shift+點擊可多欄排序；右鍵更多")}
                      style={{ width: colWidth(c) }}
                      className="relative text-left px-3 py-1.5 border-b border-fg/10 font-medium whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer select-none hover:bg-fg/5 focus-visible:outline-2 focus-visible:outline-accent/60 focus-visible:-outline-offset-2"
                    >
                      {/* 有 comment 的欄名加虛線底線，提示可 hover 看欄位說明 */}
                      <span className={cmt ? "border-b border-dotted border-fg/40" : undefined}>{c}</span>
                      {data.primary_key.includes(c) && (
                        <span className="ml-1 text-[10px] font-semibold text-amber-400">PK</span>
                      )}
                      {dir && (
                        <span className="ml-1 text-[10px] text-amber-300 inline-flex items-center align-middle">
                          <Icon icon={dir === "asc" ? ArrowUp : ArrowDown} size={12} />
                          {order > 0 && <span className="ml-0.5 text-fg/40">{order}</span>}
                        </span>
                      )}
                      <span
                        onPointerDown={(e) => startResize(c, e)}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(c, ci); }}
                        title={t("拖曳調整欄寬；雙擊自動符合內容")}
                        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-accent/50"
                      />
                    </th>
                  );
                })}
                {editable && <th className="w-8 border-b border-fg/10" />}
              </tr>
            </thead>
            <tbody className="mono">
              {data.rows.map((row, i) => (
                <DataRow
                  key={i}
                  row={row}
                  i={i}
                  startRow={startRow}
                  visibleCols={visibleCols}
                  editable={editable}
                  isRedis={isRedis}
                  hasKeyMenu={isRedis && keyIdx >= 0}
                  isMarked={marked.has(i)}
                  selRow={selected?.r === i}
                  selCol={selected?.r === i ? selected.c : null}
                  editingCol={editing?.r === i ? editing.c : null}
                  editSeed={editing?.r === i ? editSeed : null}
                  rowEdits={editsByRow[i]}
                  rangeCols={rangeRect && i >= rangeRect.r1 && i <= rangeRect.r2 ? rangeRect : null}
                  findLower={findLower}
                  h={rowHandlers}
                />
              ))}
            </tbody>
          </table>
        )}
        {data && data.columns.length > 0 && data.rows.length === 0 && (
          <EmptyState
            compact
            icon={filters.length ? Filter : Table2}
            title={filters.length ? t("無符合篩選的資料") : t("此表沒有資料")}
            action={
              filters.length ? (
                <Button variant="secondary" size="sm" icon={X} onClick={() => setFilters([])}>
                  {t("清除篩選")}
                </Button>
              ) : insertable ? (
                <Button variant="secondary" size="sm" icon={Plus} onClick={() => setInserting(true)}>
                  {t("新增資料列")}
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      {/* 底部導覽列（Navicat 手感） */}
      <div className="h-9 bg-panel border-t border-fg/10 flex items-center px-3 gap-1 text-sm">
        <NavBtn label={<Icon icon={ChevronsLeft} size={16} />} disabled={page === 0 || loading} onClick={() => navPage(0)} title={t("第一頁")} />
        <NavBtn label={<Icon icon={ChevronLeft} size={16} />} disabled={page === 0 || loading} onClick={() => navPage(page - 1)} title={t("上一頁")} />
        <span className="px-1 text-fg/60 mono text-xs flex items-center gap-1">
          <input
            key={page}
            defaultValue={page + 1}
            title={t("輸入頁碼後按 Enter 跳頁")}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const n = parseInt((e.target as HTMLInputElement).value, 10);
              if (Number.isFinite(n) && n >= 1 && n <= totalPages && n - 1 !== page) navPage(n - 1);
            }}
            className="w-10 bg-inset border border-fg/10 rounded px-1 py-0.5 text-xs text-center outline-none focus:border-accent"
          />
          / {totalPages}
        </span>
        <NavBtn label={<Icon icon={ChevronRight} size={16} />} disabled={page + 1 >= totalPages || loading} onClick={() => navPage(page + 1)} title={t("下一頁")} />
        <NavBtn label={<Icon icon={ChevronsRight} size={16} />} disabled={page + 1 >= totalPages || loading} onClick={() => navPage(totalPages - 1)} title={t("最後一頁")} />
        <select
          value={pageSize}
          onChange={(e) => changePageSize(Number(e.target.value))}
          title={t("每頁列數")}
          className="ml-2 bg-inset border border-fg/10 rounded px-1.5 py-0.5 text-xs outline-none focus:border-accent text-fg/60"
        >
          {[100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>{n} {t("/ 頁")}</option>
          ))}
        </select>

        <div className="w-px h-4 bg-fg/10 mx-2" />
        <button
          onClick={applyEdits}
          disabled={dirtyCount === 0 || applying}
          title={t("套用變更")}
          className="h-6 px-2 flex items-center gap-1 rounded text-xs bg-green-600/80 hover:bg-green-600 disabled:opacity-25 disabled:bg-transparent disabled:hover:bg-transparent"
        >
          <Icon icon={Check} size={14} /> {t("套用")}{dirtyCount > 0 ? `（${dirtyCount}）` : ""}
        </button>
        <button
          onClick={() => { setEdits({}); setEditing(null); }}
          disabled={dirtyCount === 0 || applying}
          title={t("捨棄變更")}
          className="h-6 px-2 flex items-center gap-1 rounded text-xs hover:bg-fg/10 disabled:opacity-25 disabled:hover:bg-transparent"
        >
          <Icon icon={X} size={14} /> {t("捨棄")}
        </button>

        {/* 框選範圍統計 / 單一選取格資訊（Excel 狀態列手感） */}
        {selectionStats ? (
          <span className="ml-auto mr-3 text-fg/45 text-xs mono whitespace-nowrap" title={t("框選範圍統計（含待套用編輯值）")}>
            {t("已選 {rows}×{colsN}（{count} 格）", { rows: selectionStats.rows, colsN: selectionStats.colsN, count: selectionStats.count })}
            {selectionStats.numCount > 0 &&
              t(" · 數值 {numCount} · Σ {sum} · 平均 {avg}", { numCount: selectionStats.numCount, sum: fmtNum(selectionStats.sum), avg: fmtNum(selectionStats.avg) })}
            {selectionStats.numCount > 1 &&
              t(" · 最小 {min} · 最大 {max}", { min: fmtNum(selectionStats.min), max: fmtNum(selectionStats.max) })}
          </span>
        ) : selected && data && data.rows[selected.r] ? (
          <span className="ml-auto mr-3 text-fg/45 text-xs truncate max-w-[40%]" title={cellValue(selected.r, selected.c) ?? "NULL"}>
            <span className="text-fg/30">{data.columns[selected.c]}</span>
            {" = "}
            {cellValue(selected.r, selected.c) === null
              ? <span className="italic text-fg/30">NULL</span>
              : cellValue(selected.r, selected.c)}
          </span>
        ) : null}
        <span className={`${selectionStats || (selected && data && data.rows[selected.r]) ? "" : "ml-auto"} text-fg/40 text-xs`}>
          {applying
            ? t("處理中…")
            : data
            ? t("顯示 {from}–{to} · 共 {total} 列", { from: data.rows.length ? startRow + 1 : 0, to: startRow + data.rows.length, total: countPending ? "…" : data.total_rows }) + (editable ? "" : readonly ? t(" · 連線唯讀") : t(" · 無主鍵唯讀"))
            : loading
            ? t("讀取中…")
            : ""}
        </span>
      </div>
      </>
      )}

      {inserting && data && (
        <InsertDialog
          columns={data.columns}
          initial={insertInitial}
          onCancel={() => { setInserting(false); setInsertInitial(undefined); }}
          onSubmit={submitInsert}
          busy={applying}
        />
      )}

      {exporting && data && (
        <ExportDialog
          connId={tab.connId}
          database={tab.database}
          table={tab.table}
          query={{ page: 0, page_size: pageSize, filters, sorts, match_any: matchAny }}
          onClose={() => setExporting(false)}
        />
      )}

      {importing && (
        <ImportDialog
          connId={tab.connId}
          database={tab.database}
          table={tab.table}
          onDone={() => load()}
          onClose={() => setImporting(false)}
        />
      )}

      {detailKey !== null && (
        <KeyDetailModal
          connId={tab.connId}
          database={tab.database}
          table={tab.table}
          rkey={detailKey}
          onClose={() => { setDetailKey(null); refresh(); }}
        />
      )}

      {showNewKey && (
        <NewKeyDialog
          connId={tab.connId}
          database={tab.database}
          onClose={() => setShowNewKey(false)}
          onCreated={() => refresh()}
        />
      )}
      {showStatus && (
        <RedisStatus connId={tab.connId} connName={connName} onClose={() => setShowStatus(false)} />
      )}
      {showConsole && (
        <RedisConsole connId={tab.connId} connName={connName} initialDb={tab.database} onClose={() => setShowConsole(false)} />
      )}
      {showPubSub && (
        <PubSubPanel connId={tab.connId} connName={connName} onClose={() => setShowPubSub(false)} />
      )}
      {showOps && (
        <RedisOpsPanel connId={tab.connId} connName={connName} database={tab.database} onClose={() => setShowOps(false)} />
      )}

      {rowMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setRowMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setRowMenu(null); }} />
          <div className="fixed z-[90] min-w-[150px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: rowMenu.x, top: rowMenu.y }}>
            {(
              [
                [t("檢視內容"), () => setDetailKey(rowMenu.key), false],
                [t("複製鍵名"), () => copyToClipboard(rowMenu.key, t("已複製鍵名")), false],
                [t("重新命名…"), () => renameKey(rowMenu.key), false],
                [t("設定 TTL…"), () => setKeyTtl(rowMenu.key, rowMenu.ttl), false],
                [t("刪除"), () => deleteKey(rowMenu.key), true],
              ] as [string, () => void, boolean][]
            ).map(([label, fn, danger]) => (
              <button key={label} type="button"
                onClick={() => { setRowMenu(null); fn(); }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-fg/10 ${danger ? "text-red-300" : "text-fg/80"}`}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* SQL 表儲存格右鍵選單 */}
      {cellMenu && data && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setCellMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setCellMenu(null); }} />
          <div className="fixed z-[90] min-w-[180px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: cellMenu.x, top: cellMenu.y }}>
            {cellMenuItems(cellMenu.r, cellMenu.c).map((it, idx) => {
              if (it === "sep") return <div key={`sep-${idx}`} className="my-1 border-t border-fg/10" />;
              const [label, fn, danger] = it;
              return (
                <button key={label} type="button"
                  onClick={() => { setCellMenu(null); fn(); }}
                  className={`block w-full text-left px-3 py-1.5 hover:bg-fg/10 ${danger ? "text-red-300" : "text-fg/80"}`}>
                  {label}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 欄位標題右鍵選單 */}
      {colMenu && data && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setColMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setColMenu(null); }} />
          <div className="fixed z-[90] min-w-[170px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: colMenu.x, top: colMenu.y }}>
            {(
              [
                [t("升冪排序 ▲"), async () => { if (await guardDiscard()) { setPage(0); setSorts([{ column: colMenu.col, dir: "asc" }]); } }],
                [t("降冪排序 ▼"), async () => { if (await guardDiscard()) { setPage(0); setSorts([{ column: colMenu.col, dir: "desc" }]); } }],
                ...(sorts.length ? [[t("清除排序"), async () => { if (await guardDiscard()) setSorts([]); }] as [string, () => void]] : []),
                [t("自動符合寬度"), () => autoFitColumn(colMenu.col, colMenu.ci)],
                [t("複製欄名"), () => copyToClipboard(colMenu.col, t("已複製欄名"))],
                [t("複製所有欄名（逗號分隔）"), () => copyToClipboard(data.columns.join(", "), t("已複製所有欄名"))],
                [t("複製整欄（本頁）"), () => copyToClipboard(data.rows.map((_, ri) => cellValue(ri, colMenu.ci) ?? "").join("\n"), t("已複製整欄"))],
                ...(isSqlKind && connKind ? [[t("複製整欄為 IN(...)（本頁）"), () => copyToClipboard(buildInClause(connKind, colMenu.col, data.rows.map((_, ri) => cellValue(ri, colMenu.ci))), t("已複製 IN 子句"))] as [string, () => void]] : []),
                ...(isSqlKind || isMongo ? [[t("欄位統計（總數/非空/相異）"), () => colStats(colMenu.col)] as [string, () => void]] : []),
                ...(isSqlKind && connKind ? [[t("相異值分布（Top 50）"), () => {
                  const qc = quoteIdent(connKind, colMenu.col);
                  const sql = `SELECT ${qc}, COUNT(*) AS n\nFROM ${qualifiedName(connKind, tab.database, tab.table)}\nGROUP BY ${qc}\nORDER BY n DESC\nLIMIT 50;`;
                  useStore.getState().setActive(tab.connId);
                  useStore.getState().requestQuery(sql);
                }] as [string, () => void]] : []),
                ...(isMongo ? [[t("相異值分布（Top 50）"), () => {
                  // 生成 $group 聚合 DSL 到查詢編輯器（與 SQL 版對稱）。
                  const dsl = JSON.stringify({
                    db: tab.database, collection: tab.table,
                    pipeline: [
                      { $group: { _id: `$${colMenu.col}`, n: { $sum: 1 } } },
                      { $sort: { n: -1 } }, { $limit: 50 },
                    ],
                  }, null, 2);
                  useStore.getState().setActive(tab.connId);
                  useStore.getState().requestQuery(dsl);
                }] as [string, () => void]] : []),
                [t("隱藏此欄"), () => hideColumn(colMenu.col)],
                ...(hidden.length ? [[t("顯示所有欄"), () => showAllColumns()] as [string, () => void]] : []),
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

      {/* 反向外鍵：多個來源表時的選擇器 */}
      {refChooser && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setRefChooser(null)}
            onContextMenu={(e) => { e.preventDefault(); setRefChooser(null); }} />
          <div className="fixed z-[90] min-w-[200px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: refChooser.x, top: refChooser.y }}>
            <div className="px-3 py-1 text-[11px] text-fg/40 border-b border-fg/10">{t("參照此列的資料表")}</div>
            {refChooser.options.map((rel) => (
              <button key={`${rel.from_table}.${rel.from_column}`} type="button"
                onClick={() => { const o = refChooser; setRefChooser(null); useStore.getState().openTableFiltered(tab.connId, tab.database, rel.from_table, rel.from_column, o.value); }}
                className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80 mono text-xs">
                {rel.from_table}.{rel.from_column}
              </button>
            ))}
          </div>
        </>
      )}

      {/* 儲存格內容檢視器（長文字 / JSON / 二進位） */}
      {inspect && data && (
        <CellInspector
          column={data.columns[inspect.c]}
          value={cellValue(inspect.r, inspect.c)}
          editable={editable}
          onSave={(raw, setNull) => commitEdit(inspect.r, inspect.c, raw, setNull)}
          onClose={() => setInspect(null)}
        />
      )}

      {rowDetail !== null && data && data.rows[rowDetail] && (
        <RowDetailModal
          rowNo={startRow + rowDetail + 1}
          columns={data.columns}
          values={data.columns.map((_, j) => cellValue(rowDetail, j))}
          editable={editable}
          hasPrev={rowDetail > 0}
          hasNext={rowDetail < data.rows.length - 1}
          onPrev={() => setRowDetail((r) => (r !== null && r > 0 ? r - 1 : r))}
          onNext={() => setRowDetail((r) => (r !== null && r < data.rows.length - 1 ? r + 1 : r))}
          onEdit={(ci, raw, setNull) => commitEdit(rowDetail, ci, raw, setNull)}
          onClose={() => setRowDetail(null)}
        />
      )}

      {docEdit !== null && data && data.row_ids?.[docEdit] != null && (
        <DocumentEditorModal
          connId={tab.connId}
          database={tab.database}
          table={tab.table}
          docId={data.row_ids[docEdit]}
          onClose={() => setDocEdit(null)}
          onSaved={() => { setDocEdit(null); load(); }}
        />
      )}

      {fieldStats && (
        <FieldStatsModal col={fieldStats.col} stats={fieldStats.stats} onClose={() => setFieldStats(null)} />
      )}
    </div>
  );
}

// Mongo 欄位統計視窗：型別分布橫條（混型欄位核心資訊）+ Top-10 值 + 缺欄 / null / 相異值 / 抽樣註記。
function FieldStatsModal({ col, stats, onClose }: { col: string; stats: ColumnStats; onClose: () => void }) {
  const t = useT();
  useModalOverlay(onClose);
  const typeTotal = stats.types.reduce((a, [, n]) => a + n, 0) || 1;
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-elevated w-[560px] max-w-[92vw] max-h-[80vh] overflow-auto rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-2">
          <Icon icon={BarChart3} size={14} className="text-green-400" />
          <span className="font-medium text-sm">{t("欄位統計 ·")} <span className="mono">{col}</span></span>
          <button type="button" onClick={onClose} className="ml-auto text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
        </div>
        <div className="p-4 space-y-4 text-sm">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-well border border-fg/10 px-2 py-1">{t("文件數")} <span className="mono font-semibold">{stats.total}</span></span>
            <span className="rounded bg-well border border-fg/10 px-2 py-1">{t("缺欄位")} <span className="mono font-semibold">{stats.missing}</span></span>
            <span className="rounded bg-well border border-fg/10 px-2 py-1">null <span className="mono font-semibold">{stats.null_count}</span></span>
            <span className="rounded bg-well border border-fg/10 px-2 py-1">
              {t("相異值")} <span className="mono font-semibold">{stats.distinct_capped ? `≥ ${stats.distinct}` : stats.distinct}</span>
            </span>
            {stats.sampled > 0 && (
              <span className="rounded border border-amber-300/40 bg-amber-500/10 px-2 py-1 text-amber-300"
                title={t("集合過大時基於隨機抽樣計算（total 為集合估計數，其餘統計基於樣本）")}>
                {t("抽樣 {sampled} 筆", { sampled: stats.sampled })}
              </span>
            )}
          </div>
          {stats.types.length > 0 && (
            <div>
              <div className="text-xs text-fg/50 mb-1.5">{t("BSON 型別分布")}</div>
              <div className="space-y-1">
                {stats.types.map(([t, n]) => (
                  <div key={t} className="flex items-center gap-2 text-xs">
                    <span className="mono w-20 shrink-0 text-fg/70">{t}</span>
                    <div className="flex-1 h-3 rounded bg-fg/10 overflow-hidden">
                      <div className="h-full bg-accent/60" style={{ width: `${Math.max(2, (n / typeTotal) * 100)}%` }} />
                    </div>
                    <span className="mono w-24 shrink-0 text-right text-fg/60">{n}（{((n / typeTotal) * 100).toFixed(1)}%）</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {stats.top_values.length > 0 && (
            <div>
              <div className="text-xs text-fg/50 mb-1.5">Top {stats.top_values.length} {t("值")}</div>
              <table className="w-full text-xs border-collapse">
                <tbody>
                  {stats.top_values.map(([v, n], i) => (
                    <tr key={i} className="hover:bg-fg/5">
                      <td className="px-2 py-1 border-b border-fg/5 mono break-all">{v}</td>
                      <td className="px-2 py-1 border-b border-fg/5 mono text-right text-fg/60 whitespace-nowrap w-20">{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(stats.min !== null || stats.max !== null) && (
            <div className="text-xs text-fg/50" title={t("min / max 依 BSON 型別排序；混型欄位跨型別比較可能看似奇怪")}>
              {t("範圍")} <span className="mono text-fg/70">[{stats.min ?? "?"}, {stats.max ?? "?"}]</span>{t("（依 BSON 型別排序）")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Mongo 整份文件 JSON 編輯器：取回 canonical extended JSON → 編輯 → 驗證 → 取代整份文件。
// 正確處理巢狀物件 / 陣列 / ObjectId / Date，避免表格逐格編輯把巢狀結構存成字串而破壞文件。
function DocumentEditorModal({ connId, database, table, docId, onClose, onSaved }: {
  connId: string; database: string; table: string; docId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .documentGet(connId, database, table, docId)
      .then((s) => { if (!cancelled) setText(s); })
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [connId, database, table, docId]);

  const save = async () => {
    // 前端先驗 JSON，錯誤即時回饋，不必往返後端。
    try { JSON.parse(text); } catch (e: any) { setErr(t("JSON 格式錯誤：{msg}", { msg: e?.message ?? e })); return; }
    setSaving(true);
    setErr(null);
    try {
      await api.documentReplace(connId, database, table, docId, text);
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? t("儲存失敗"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-elevated w-[640px] max-h-[85vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-2">
          <span className="font-medium text-sm">{t("編輯文件（JSON）")}</span>
          <span className="text-xs text-fg/40 mono truncate">{table}</span>
          <button type="button" onClick={onClose} aria-label={t("關閉")} title={t("關閉")} className="ml-auto text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
        </div>
        <div className="p-4 overflow-auto flex-1">
          {err && <div className="text-danger text-sm mono mb-2 break-all">{err}</div>}
          {loading ? (
            <div className="text-fg/40 text-sm">{t("讀取中…")}</div>
          ) : (
            <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
              className="w-full h-96 bg-inset border border-fg/10 rounded p-3 mono text-sm outline-none focus:border-accent resize-none" />
          )}
        </div>
        <div className="px-5 py-3 border-t border-fg/10 flex items-center gap-2">
          <span className="text-xs text-fg/35">{t("以 canonical extended JSON 呈現；_id 不可變更。")}</span>
          <button type="button" onClick={onClose} className="ml-auto px-3 py-1 text-sm rounded border border-fg/15 hover:bg-fg/10">{t("取消")}</button>
          <button type="button" onClick={save} disabled={saving || loading}
            className="px-3 py-1 text-sm rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">
            {saving ? t("儲存中…") : t("儲存")}
          </button>
        </div>
      </div>
    </div>
  );
}

// 整列表單檢視：寬表時逐欄檢視 / 編輯一列，可上下切換列（致敬 DBeaver 的「記錄檢視」）。
function RowDetailModal({ rowNo, columns, values, editable, hasPrev, hasNext, onPrev, onNext, onEdit, onClose }: {
  rowNo: number;
  columns: string[];
  values: (string | null)[];
  editable: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onEdit: (colIndex: number, raw: string, setNull: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  useModalCount(); // 開啟期間讓全域快捷鍵（Ctrl+W/Tab、"/"）讓路，不在背後動作
  // 記錄瀏覽器鍵盤：↑/PageUp 上一列、↓/PageDown 下一列、Esc 關閉（編輯欄位時方向鍵交給輸入框）。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      const target = e.target as HTMLElement | null;
      const inField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || !!target?.isContentEditable;
      if (inField) return;
      if ((e.key === "ArrowUp" || e.key === "PageUp") && hasPrev) { e.preventDefault(); onPrev(); }
      else if ((e.key === "ArrowDown" || e.key === "PageDown") && hasNext) { e.preventDefault(); onNext(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [hasPrev, hasNext, onPrev, onNext, onClose]);

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-elevated w-[560px] max-w-[92vw] max-h-[82vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-2 text-sm">
          <span className="font-medium">{t("第 {rowNo} 列", { rowNo })}</span>
          <span className="text-fg/30 text-xs">{columns.length} {t("欄")}{editable ? t("（可編輯）") : t("（唯讀）")}</span>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" disabled={!hasPrev} onClick={onPrev} title={t("上一列")}
              className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-fg/10 disabled:opacity-30"><Icon icon={ArrowUp} size={14} /></button>
            <button type="button" disabled={!hasNext} onClick={onNext} title={t("下一列")}
              className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-fg/10 disabled:opacity-30"><Icon icon={ArrowDown} size={14} /></button>
            <button type="button" onClick={onClose} aria-label={t("關閉")} title={t("關閉")} className="ml-1 text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
          </div>
        </div>
        <div className="p-4 overflow-auto space-y-1.5">
          {columns.map((c, ci) => (
            <div key={c} className="flex items-start gap-2">
              <span className="text-xs text-fg/50 w-32 shrink-0 truncate text-right pt-1.5 mono" title={c}>{c}</span>
              {editable ? (
                <RowField value={values[ci]} onSave={(raw, setNull) => onEdit(ci, raw, setNull)} />
              ) : (
                <span className="flex-1 mono text-sm break-all py-1" data-selectable>
                  {values[ci] === null ? <span className="text-fg/30 italic">NULL</span> : values[ci]}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 列表單內的單欄輸入：blur / Enter 套用變更；按鈕設 NULL。
function RowField({ value, onSave }: { value: string | null; onSave: (raw: string, setNull: boolean) => void }) {
  const t = useT();
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const commit = () => { if (text !== (value ?? "")) onSave(text, false); };
  return (
    <span className="flex-1 flex items-center gap-1">
      <input value={text} onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        className={`flex-1 bg-inset border rounded px-2 py-1 text-sm mono outline-none focus:border-accent ${
          value === null ? "border-fg/10 text-fg/40 italic" : "border-fg/10"
        }`}
        placeholder={value === null ? "NULL" : ""} />
      <button type="button" onMouseDown={(e) => { e.preventDefault(); onSave("", true); }}
        title={t("設為 NULL")} className="text-[10px] text-fg/40 hover:text-fg/70 shrink-0">NULL</button>
    </span>
  );
}

// 儲存格內容檢視器：檢視 / 編輯長文字、JSON、二進位預覽。可一鍵格式化 JSON、複製。
export function CellInspector({ column, value, editable, onSave, onClose, showFormat = true }: {
  column: string;
  value: string | null;
  editable: boolean;
  onSave: (raw: string, setNull: boolean) => void;
  onClose: () => void;
  // 是否顯示「格式化 JSON」（DDL 檢視等情境關閉）。
  showFormat?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState(value ?? "");
  const dirty = editable && text !== (value ?? "");
  useModalOverlay(onClose); // 計入 modalCount + 視窗層級 Esc（不再僅靠 textarea 聚焦才能 Esc）
  const formatJson = () => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      toast.error(t("不是有效的 JSON"));
    }
  };
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-elevated w-[660px] max-w-[92vw] max-h-[82vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-2">
          <span className="font-medium text-sm mono truncate">{column}</span>
          {value === null && <span className="text-[10px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/50">NULL</span>}
          <span className="ml-auto text-[11px] text-fg/40 tabular-nums"
            title={t("字元數 / UTF-8 位元組數（位元組數對應多數資料庫的 VARCHAR 長度上限）")}>
            {text.length} {t("字元 ·")} {new TextEncoder().encode(text).length} bytes
          </span>
          <button type="button" onClick={onClose} aria-label={t("關閉")} title={t("關閉")} className="text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
        </div>
        <div className="p-4 flex-1 overflow-auto">
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)}
            readOnly={!editable} title={editable ? t("儲存格內容（Ctrl+Enter 套用）") : t("儲存格內容")}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && editable && dirty) { e.preventDefault(); onSave(text, false); onClose(); }
            }}
            className="w-full h-72 bg-inset border border-fg/10 rounded p-3 mono text-sm outline-none focus:border-accent resize-none break-all" />
        </div>
        <div className="px-5 py-3 border-t border-fg/10 flex items-center gap-2">
          {showFormat && (
            <button type="button" onClick={formatJson}
              className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">{t("格式化 JSON")}</button>
          )}
          <button type="button" onClick={() => copyToClipboard(text, t("已複製"))}
            className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">{t("複製")}</button>
          <div className="ml-auto flex gap-2">
            {editable && (
              <button type="button" onClick={() => { onSave("", true); onClose(); }}
                className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5 text-fg/70">{t("設為 NULL")}</button>
            )}
            {editable && (
              <button type="button" disabled={!dirty} onClick={() => { onSave(text, false); onClose(); }}
                title={t("套用變更 (Ctrl+Enter)")}
                className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">{t("套用變更")}</button>
            )}
            <button type="button" onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">{t("關閉")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Redis 鍵詳情：依型別呈現五種資料結構，並支援元素級編輯。
// 大型集合（hash/list/set/zset）改用後端游標式分頁（redisKeyPage），不再一次全載；
// 並提供成員 / 欄位過濾（hash 比對 field、set/zset 比對 member、list 子字串）。
const KEY_PAGE = 200;
function KeyDetailModal({ connId, database, table, rkey, onClose }: {
  connId: string; database: string; table: string; rkey: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose); // Esc 關閉 + 計入 modalCount（先前完全沒有 Esc 處理）
  const [page, setPage] = useState<KeyPage | null>(null);
  // 累積已載入的成員（跨多頁），供 KeyDetailBody 以既有渲染呈現。
  const [members, setMembers] = useState<string[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [scores, setScores] = useState<number[]>([]);
  const [cursor, setCursor] = useState(0);     // 下一頁游標（0 = 已到底）
  const [filter, setFilter] = useState("");     // 已套用的過濾字串
  const [filterInput, setFilterInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 首頁載入（reset）：清空累積、從游標 0 開始。connId/db/key/filter 改變或 reload 時觸發。
  const loadFirst = (flt: string) => {
    setLoading(true);
    setErr(null);
    api
      .redisKeyPage(connId, database, rkey, 0, KEY_PAGE, flt)
      .then((p) => {
        setPage(p);
        setMembers(p.members);
        setFields(p.fields);
        setScores(p.scores);
        setCursor(p.cursor);
      })
      .catch((e) => setErr(e?.message ?? t("讀取失敗")))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .redisKeyPage(connId, database, rkey, 0, KEY_PAGE, filter)
      .then((p) => {
        if (cancelled) return;
        setPage(p);
        setMembers(p.members);
        setFields(p.fields);
        setScores(p.scores);
        setCursor(p.cursor);
      })
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // filter 透過 applyFilter 變更後一併重載；故列入依賴。
  }, [connId, database, rkey, filter]);

  const loadMore = () => {
    if (cursor === 0 || loading) return;
    setLoading(true);
    api
      .redisKeyPage(connId, database, rkey, cursor, KEY_PAGE, filter)
      .then((p) => {
        setMembers((m) => [...m, ...p.members]);
        setFields((f) => [...f, ...p.fields]);
        setScores((s) => [...s, ...p.scores]);
        setCursor(p.cursor);
      })
      .catch((e) => setErr(e?.message ?? t("讀取失敗")))
      .finally(() => setLoading(false));
  };

  // 編輯後重載：保留目前過濾、回到第一頁。
  const reload = () => loadFirst(filter);
  const applyFilter = () => setFilter(filterInput.trim());

  // 大 string 值：強制載入完整值（full=true），供編輯前取回被截斷的完整內容。
  const loadFull = () => {
    setLoading(true);
    api
      .redisKeyPage(connId, database, rkey, 0, KEY_PAGE, filter, true)
      .then((p) => { setPage(p); setMembers(p.members); setFields(p.fields); setScores(p.scores); setCursor(p.cursor); })
      .catch((e) => setErr(e?.message ?? t("讀取失敗")))
      .finally(() => setLoading(false));
  };

  // 以累積成員合成 KeyDetail 形狀，沿用既有 KeyDetailBody 渲染（entries = members）。
  const detail: KeyDetail | null = page
    ? { key: rkey, type_: page.type_, ttl: page.ttl, entries: members, fields, scores }
    : null;
  const isCollection = page != null && page.type_ !== "string" && page.type_ !== "none";

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-elevated w-[560px] max-h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-2">
          <span className="font-medium text-sm mono truncate">{rkey}</span>
          {page && (
            <>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">{page.type_}</span>
              <span className="text-xs text-fg/40">
                TTL: {page.ttl < 0 ? t("無到期") : `${page.ttl}s`}
              </span>
              {isCollection && page.total >= 0 && (
                <span className="text-xs text-fg/35">{t("共 {total} 筆", { total: page.total })}</span>
              )}
            </>
          )}
          <button type="button" onClick={onClose} aria-label={t("關閉")} title={t("關閉")} className="ml-auto text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
        </div>

        {/* 成員過濾（僅集合型）。Enter 或「套用」重載第一頁。 */}
        {isCollection && (
          <div className="px-4 py-2 border-b border-fg/10 flex items-center gap-2 text-xs">
            <input value={filterInput} onChange={(e) => setFilterInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyFilter(); }}
              placeholder={page!.type_ === "hash" ? t("過濾 field（支援 * ?）") : page!.type_ === "list" ? t("過濾子字串") : t("過濾成員（支援 * ?）")}
              className="flex-1 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent" />
            <button type="button" onClick={applyFilter}
              className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60">{t("套用")}</button>
            {filter && (
              <button type="button" onClick={() => { setFilterInput(""); setFilter(""); }}
                className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/40">{t("清除")}</button>
            )}
          </div>
        )}

        <div className="p-4 overflow-auto">
          {err && <div className="text-red-400 text-sm mono mb-2 break-all">{err}</div>}
          {!page && !err && <div className="text-fg/40 text-sm">{t("讀取中…")}</div>}
          {detail && (
            <KeyDetailBody
              detail={detail}
              connId={connId}
              database={database}
              table={table}
              rkey={rkey}
              reload={reload}
              onError={setErr}
              truncated={page?.truncated}
              valueBytes={page?.value_bytes}
              onLoadFull={loadFull}
            />
          )}
          {isCollection && (
            <div className="mt-3 flex items-center gap-3 text-xs text-fg/40">
              <span>{t("已載入 {count} 筆", { count: members.length })}{filter ? t("（已過濾）") : ""}</span>
              {cursor !== 0 && (
                <button type="button" onClick={loadMore} disabled={loading}
                  className="px-3 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 disabled:opacity-40">
                  {loading ? t("載入中…") : t("載入更多")}
                </button>
              )}
              {cursor === 0 && members.length > 0 && <span className="text-fg/25">{t("已全部載入")}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KeyDetailBody({ detail, connId, database, table, rkey, reload, onError, truncated, valueBytes, onLoadFull }: {
  detail: KeyDetail;
  connId: string; database: string; table: string; rkey: string;
  reload: () => void;
  onError: (msg: string | null) => void;
  truncated?: boolean;
  valueBytes?: number;
  onLoadFull?: () => void;
}) {
  const t = useT();
  const { type_, entries, fields, scores } = detail;
  const [busy, setBusy] = useState(false);
  // 新增列輸入（依型別語意不同：A = field/member/value，B = value/score）
  const [addA, setAddA] = useState("");
  const [addB, setAddB] = useState("");
  const [addFront, setAddFront] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onError(null);
      setAddA("");
      setAddB("");
      reload();
    } catch (e: any) {
      onError(e?.message ?? t("操作失敗"));
    } finally {
      setBusy(false);
    }
  };
  const edit = (e: KeyEdit) => run(() => api.keyEdit(connId, database, rkey, e));

  if (type_ === "none") {
    return <div className="text-fg/40 text-sm">{t("（此鍵已不存在）")}</div>;
  }

  if (type_ === "string") {
    return (
      <StringEditor
        value={entries[0] ?? ""}
        busy={busy}
        truncated={truncated}
        valueBytes={valueBytes}
        onLoadFull={onLoadFull}
        onSave={(v) =>
          run(() =>
            api.updateCell(connId, database, table, {
              column: "value",
              new_value: v,
              pk_columns: ["key"],
              pk_values: [rkey],
            })
          )
        }
      />
    );
  }

  if (type_ === "hash") {
    return (
      <table className="text-sm border-collapse w-full mono">
        <thead><tr>
          <th className="text-left px-2 py-1 border-b border-fg/10 w-1/3">field</th>
          <th className="text-left px-2 py-1 border-b border-fg/10">value</th>
          <th className="w-8 border-b border-fg/10" />
        </tr></thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i} className="hover:bg-fg/5 group">
              <td className="px-2 py-1 border-b border-fg/5 break-all text-fg/70">{f}</td>
              <td className="px-2 py-1 border-b border-fg/5 break-all">
                <InlineEdit value={entries[i] ?? ""} onSave={(v) => edit({ action: "hash_set", field: f, value: v })} />
              </td>
              <DelCell busy={busy} onClick={() => edit({ action: "hash_remove", field: f })} />
            </tr>
          ))}
          <tr>
            {(() => { const addHash = () => addA && edit({ action: "hash_set", field: addA, value: addB }); return (
            <>
            <td className="px-2 py-1"><AddInput value={addA} onChange={setAddA} placeholder="field" onEnter={addHash} /></td>
            <td className="px-2 py-1"><AddInput value={addB} onChange={setAddB} placeholder="value" onEnter={addHash} /></td>
            <AddCell busy={busy} onClick={addHash} />
            </>
            ); })()}
          </tr>
        </tbody>
      </table>
    );
  }

  if (type_ === "zset") {
    return (
      <table className="text-sm border-collapse w-full mono">
        <thead><tr>
          <th className="text-left px-2 py-1 border-b border-fg/10 w-24">score</th>
          <th className="text-left px-2 py-1 border-b border-fg/10">member</th>
          <th className="w-8 border-b border-fg/10" />
        </tr></thead>
        <tbody>
          {entries.map((m, i) => (
            <tr key={i} className="hover:bg-fg/5 group">
              <td className="px-2 py-1 border-b border-fg/5 text-fg/60">
                <InlineEdit value={String(scores[i] ?? 0)} type="number"
                  onSave={(v) => { const s = Number(v); if (Number.isFinite(s)) edit({ action: "zset_add", member: m, score: s }); }} />
              </td>
              <td className="px-2 py-1 border-b border-fg/5 break-all">{m}</td>
              <DelCell busy={busy} onClick={() => edit({ action: "zset_remove", member: m })} />
            </tr>
          ))}
          <tr>
            {(() => { const addZset = () => { const s = Number(addB); if (addA && Number.isFinite(s)) edit({ action: "zset_add", member: addA, score: s }); }; return (
            <>
            <td className="px-2 py-1"><AddInput value={addB} onChange={setAddB} placeholder="score" type="number" onEnter={addZset} /></td>
            <td className="px-2 py-1"><AddInput value={addA} onChange={setAddA} placeholder="member" onEnter={addZset} /></td>
            <AddCell busy={busy} onClick={addZset} />
            </>
            ); })()}
          </tr>
        </tbody>
      </table>
    );
  }

  // list / set
  const isList = type_ === "list";
  return (
    <table className="text-sm border-collapse w-full mono">
      <thead><tr>
        <th className="text-left px-2 py-1 border-b border-fg/10 w-12 text-fg/30">{isList ? "#" : ""}</th>
        <th className="text-left px-2 py-1 border-b border-fg/10">value</th>
        <th className="w-8 border-b border-fg/10" />
      </tr></thead>
      <tbody>
        {entries.map((v, i) => (
          <tr key={i} className="hover:bg-fg/5 group">
            <td className="px-2 py-1 border-b border-fg/5 text-fg/30">{isList ? i : ""}</td>
            <td className="px-2 py-1 border-b border-fg/5 break-all">
              {isList ? (
                <InlineEdit value={v} onSave={(nv) => edit({ action: "list_set", index: i, value: nv })} />
              ) : (
                // set 成員無法就地改名 → 移除舊 + 新增新
                <InlineEdit value={v} onSave={(nv) => {
                  if (nv !== v) run(async () => {
                    await api.keyEdit(connId, database, rkey, { action: "set_remove", member: v });
                    await api.keyEdit(connId, database, rkey, { action: "set_add", member: nv });
                  });
                }} />
              )}
            </td>
            {/* 註：list 刪除以值比對（LREM），重複值會刪到第一個相符項。 */}
            <DelCell busy={busy}
              onClick={() => edit(isList ? { action: "list_remove", value: v, count: 1 } : { action: "set_remove", member: v })} />
          </tr>
        ))}
        <tr>
          <td className="px-2 py-1">
            {isList && (
              <label className="text-[10px] text-fg/40 flex items-center gap-1">
                <input type="checkbox" checked={addFront} onChange={(e) => setAddFront(e.target.checked)} />
                {t("前端")}
              </label>
            )}
          </td>
          {(() => { const addLS = () => addA && edit(isList ? { action: "list_push", value: addA, front: addFront } : { action: "set_add", member: addA }); return (
          <>
          <td className="px-2 py-1"><AddInput value={addA} onChange={setAddA} placeholder="value" onEnter={addLS} /></td>
          <AddCell busy={busy} onClick={addLS} />
          </>
          ); })()}
        </tr>
      </tbody>
    </table>
  );
}

// 點擊就地編輯的儲存格（Enter 套用 / Esc 取消 / blur 套用）
function InlineEdit({ value, onSave, type = "text" }: {
  value: string; onSave: (v: string) => void; type?: string;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  if (!editing) {
    return (
      <span onClick={() => { setText(value); setEditing(true); }} title={t("點擊編輯")}
        className="cursor-text hover:bg-fg/10 rounded px-1 -mx-1 inline-block min-w-[2rem]">
        {value === "" ? <span className="text-fg/25">{t("（空）")}</span> : value}
      </span>
    );
  }
  return (
    <input autoFocus type={type} value={text}
      aria-label={t("編輯值")}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { setEditing(false); if (text !== value) onSave(text); }
        else if (e.key === "Escape") { setEditing(false); setText(value); }
      }}
      onBlur={() => { setEditing(false); if (text !== value) onSave(text); }}
      className="bg-inset border border-accent/70 rounded px-1 py-0.5 outline-none w-full focus:ring-2 focus:ring-accent/20" />
  );
}

type ValueView = "raw" | "json" | "hex";

function StringEditor({ value, onSave, busy, truncated, valueBytes, onLoadFull }: {
  value: string; onSave: (v: string) => void; busy: boolean;
  truncated?: boolean; valueBytes?: number; onLoadFull?: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(value);
  const [view, setView] = useState<ValueView>("raw");
  useEffect(() => setText(value), [value]);

  const prettyJson = tryPrettyJson(text);
  const isJson = prettyJson !== null;

  return (
    <div className="space-y-2">
      {truncated && (
        <div className="flex items-center gap-2 text-xs bg-warning/10 border border-warning/30 rounded px-3 py-2">
          <span className="text-warning">
            {t("值大小 {size}，僅載入前 64 KB 預覽。編輯前請先載入完整值，以免覆蓋時截斷資料。", { size: fmtBytes(valueBytes ?? 0) })}
          </span>
          {onLoadFull && (
            <button type="button" onClick={onLoadFull} disabled={busy}
              className="ml-auto shrink-0 px-2 py-1 rounded border border-warning/40 hover:bg-warning/15 text-warning disabled:opacity-40">
              {t("載入完整值")}
            </button>
          )}
        </div>
      )}
      {/* 檢視模式：原始（可編輯）/ JSON 美化 / Hex。 */}
      <div className="flex items-center gap-1 text-xs">
        {(["raw", "json", "hex"] as ValueView[]).map((v) => (
          <button key={v} type="button" onClick={() => setView(v)}
            className={`px-2 py-0.5 rounded ${view === v ? "bg-fg/15 text-fg" : "text-fg/45 hover:bg-fg/10"}`}>
            {v === "raw" ? t("原始") : v === "json" ? "JSON" : "Hex"}
          </button>
        ))}
        {view === "json" && isJson && (
          <button type="button" onClick={() => setText(prettyJson!)} disabled={busy}
            title={t("把美化後的 JSON 回填到編輯區（切到「原始」後可儲存）")}
            className="ml-auto px-2 py-0.5 rounded border border-fg/15 hover:bg-fg/10 text-fg/55">{t("回填美化結果")}</button>
        )}
        <span className="ml-auto text-fg/30">{byteLen(text)} bytes</span>
      </div>

      {view === "raw" && (
        <textarea value={text} onChange={(e) => setText(e.target.value)} title={t("字串值")}
          className="w-full h-40 bg-inset border border-fg/10 rounded p-3 mono text-sm outline-none focus:border-accent resize-none break-all" />
      )}
      {view === "json" && (
        <pre className="w-full h-40 overflow-auto bg-inset border border-fg/10 rounded p-3 mono text-sm whitespace-pre-wrap break-all">
          {isJson ? prettyJson : <span className="text-fg/35">{t("（非有效 JSON）")}</span>}
        </pre>
      )}
      {view === "hex" && (
        <pre className="w-full h-40 overflow-auto bg-inset border border-fg/10 rounded p-3 mono text-xs whitespace-pre">
          {toHexDump(text)}
        </pre>
      )}

      <div className="flex justify-end">
        <button type="button" disabled={busy || text === value || view !== "raw" || truncated} onClick={() => onSave(text)}
          title={truncated ? t("值已截斷，請先「載入完整值」再儲存") : view !== "raw" ? t("切到「原始」模式才能儲存") : t("儲存")}
          className="px-3 py-1 text-sm rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">
          {busy ? t("儲存中…") : t("儲存")}
        </button>
      </div>
    </div>
  );
}

// JSON 美化：可解析則回傳縮排字串，否則 null。
function tryPrettyJson(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { return null; }
}

// UTF-8 位元組長度。
function byteLen(s: string): number {
  try { return new TextEncoder().encode(s).length; } catch { return s.length; }
}

// 人類可讀的位元組數（B / KB / MB / GB）。
function fmtBytes(n: number): string {
  if (n < 0) return t("未知");
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

// 經典 hex dump：每列 16 位元組，左偏移、中段 hex、右側可列印字元。
function toHexDump(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length === 0) return t("（空）");
  const max = 8192; // 避免超長字串卡渲染
  const view = bytes.subarray(0, max);
  const lines: string[] = [];
  for (let off = 0; off < view.length; off += 16) {
    const chunk = view.subarray(off, off + 16);
    const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(16 * 3 - 1, " ");
    const ascii = Array.from(chunk).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  if (bytes.length > max) lines.push(t("… 已截斷，共 {length} bytes", { length: bytes.length }));
  return lines.join("\n");
}

function DelCell({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  const t = useT();
  return (
    <td className="px-1 py-1 border-b border-fg/5 text-center">
      <button type="button" onClick={onClick} disabled={busy} title={t("刪除")}
        className="w-5 h-5 inline-flex items-center justify-center rounded text-fg/20 group-hover:text-red-400 hover:bg-red-500/20 disabled:opacity-30">
        <Icon icon={Minus} size={14} />
      </button>
    </td>
  );
}

function AddCell({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  const t = useT();
  return (
    <td className="px-1 py-1 text-center">
      <button type="button" onClick={onClick} disabled={busy} title={t("新增")}
        className="w-5 h-5 inline-flex items-center justify-center rounded text-fg/30 hover:text-green-400 hover:bg-green-500/20 disabled:opacity-30">
        <Icon icon={Plus} size={14} />
      </button>
    </td>
  );
}

function AddInput({ value, onChange, placeholder, type = "text", onEnter }: {
  value: string; onChange: (v: string) => void; placeholder: string; type?: string; onEnter?: () => void;
}) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      onKeyDown={onEnter ? (e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } } : undefined}
      className="w-full bg-inset border border-fg/10 rounded px-1.5 py-0.5 text-sm outline-none focus:border-accent" />
  );
}

const FILTER_OPS: [string, string][] = [
  ["=", "="], ["!=", "≠"], [">", ">"], [">=", "≥"], ["<", "<"], ["<=", "≤"],
  ["like", "like"], ["is_null", "is null"], ["is_not_null", "not null"],
];
const opNeedsValue = (op: string) => op !== "is_null" && op !== "is_not_null";

// 篩選列：多欄複合條件（以 AND 串接；後端 build_where / Mongo filter 已支援）。
// 註：AND-only（OR 需改後端三個 build_where/filter）；Mongo 同欄多條件會覆蓋（後者勝）；
// Redis 僅 key 欄的 like/= 有效。
function FilterBar({ columns, filters, matchAny, onApply }: {
  columns: string[];
  filters: FilterCond[];
  matchAny: boolean;
  onApply: (filters: FilterCond[], matchAny: boolean) => void;
}) {
  const t = useT();
  const blank = (): FilterCond => ({ column: columns[0] ?? "", op: "=", value: "" });
  const [rows, setRows] = useState<FilterCond[]>(filters.length ? filters : [blank()]);
  const [any, setAny] = useState(matchAny);

  // 外部 filters 變更（例如清除）時同步回來。
  useEffect(() => {
    setRows(filters.length ? filters : [blank()]);
    setAny(matchAny);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, matchAny]);

  const update = (i: number, patch: Partial<FilterCond>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  const addRow = () => setRows((rs) => [...rs, blank()]);

  const apply = () => {
    const built = rows
      .filter((r) => r.column)
      .map((r) => ({
        column: r.column,
        op: r.op,
        value: opNeedsValue(r.op) ? r.value ?? "" : null,
      }));
    onApply(built, any);
  };
  const clear = () => { setRows([blank()]); setAny(false); onApply([], false); };

  return (
    <div className="px-2 py-1.5 bg-well border-b border-fg/10 text-xs space-y-1.5">
      {rows.length > 1 && (
        <div className="flex items-center gap-1 text-fg/40">
          <span>{t("符合")}</span>
          {([["false", t("全部 (AND)")], ["true", t("任一 (OR)")]] as [string, string][]).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setAny(v === "true")}
              className={`px-2 py-0.5 rounded border ${
                any === (v === "true") ? "border-accent bg-accent/15 text-accent" : "border-fg/10 text-fg/50"
              }`}>
              {label}
            </button>
          ))}
          <span>{t("條件")}</span>
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <select value={r.column} title={t("篩選欄位")} onChange={(e) => update(i, { column: e.target.value })}
            className="bg-inset border border-fg/10 rounded px-1.5 py-1 outline-none">
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={r.op} title={t("運算子")} onChange={(e) => update(i, { op: e.target.value })}
            className="bg-inset border border-fg/10 rounded px-1.5 py-1 outline-none">
            {FILTER_OPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          {opNeedsValue(r.op) && (
            <input value={r.value ?? ""} onChange={(e) => update(i, { value: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder={r.op === "like" ? t("%關鍵字%") : t("值")}
              className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent min-w-[140px]" />
          )}
          <button onClick={() => removeRow(i)} disabled={rows.length === 1}
            title={t("移除此條件")}
            className="px-1.5 py-1 inline-flex items-center justify-center rounded hover:bg-fg/10 text-fg/40 disabled:opacity-30">
            <Icon icon={Minus} size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-0.5">
        <button onClick={addRow}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={Plus} size={14} /> {t("新增條件")}</button>
        <button onClick={apply}
          className="px-2 py-1 rounded bg-accent text-white hover:bg-accent/90">{t("套用")}</button>
        <button onClick={clear}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50">{t("清除")}</button>
      </div>
    </div>
  );
}

// 新增列對話框
function InsertDialog({ columns, onSubmit, onCancel, busy, initial }: {
  columns: string[];
  onSubmit: (row: RowInsert) => void;
  onCancel: () => void;
  busy: boolean;
  // 「以此列為範本新增」的預填值：非 null → 帶入輸入框；null → 勾選 NULL。
  initial?: Record<string, string | null>;
}) {
  const t = useT();
  // 每欄一個值；nulls 標記哪些欄留 NULL（不送出 → 走 DB 預設）
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    if (initial) for (const [k, val] of Object.entries(initial)) if (val !== null) v[k] = val;
    return v;
  });
  const [nulls, setNulls] = useState<Record<string, boolean>>(() => {
    const n: Record<string, boolean> = {};
    if (initial) for (const [k, val] of Object.entries(initial)) if (val === null) n[k] = true;
    return n;
  });

  const submit = () => {
    if (busy) return;
    const cols: string[] = [];
    const vals: (string | null)[] = [];
    for (const c of columns) {
      if (nulls[c]) { cols.push(c); vals.push(null); continue; }
      if (c in values) { cols.push(c); vals.push(values[c]); }
      // 未填且未標 NULL 的欄位略過，交由 DB 預設值處理
    }
    onSubmit({ columns: cols, values: vals });
  };
  useModalOverlay(onCancel);

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-elevated w-[480px] max-h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl">
        <div className="px-5 py-3 border-b border-fg/10 font-medium text-sm">{t("新增列")}</div>
        <div className="p-4 space-y-2 overflow-y-auto">
          <p className="text-xs text-fg/40">{t("未填寫且未標 NULL 的欄位，交由資料庫預設值處理。")}</p>
          {columns.map((c, ci) => (
            <div key={c} className="flex items-center gap-2">
              <span className="text-xs text-fg/60 w-28 truncate text-right">{c}</span>
              <input
                autoFocus={ci === 0}
                disabled={nulls[c]}
                value={nulls[c] ? "" : values[c] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [c]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
                className="flex-1 bg-inset border border-fg/10 rounded px-2 py-1 text-sm outline-none focus:border-accent disabled:opacity-40"
                placeholder={nulls[c] ? "NULL" : t("（預設）")}
              />
              <label className="text-[10px] text-fg/40 flex items-center gap-1 shrink-0">
                <input type="checkbox" checked={!!nulls[c]}
                  onChange={(e) => setNulls((n) => ({ ...n, [c]: e.target.checked }))} />
                NULL
              </label>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-fg/10 flex justify-end gap-2">
          <button type="button" onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">{t("取消")}</button>
          <button type="button" onClick={submit} disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">
            {busy ? t("新增中…") : t("新增")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- 資料列（memo）：props 收斂為行級派生值，選取移動 / 框選 / 編輯只重繪受影響的列，
//      1000 列頁的互動從整表 reconcile 降為 O(變動列數)。handlers 為穩定物件（見 rowHandlers）。----
interface VisibleCol { j: number; name: string; pos: number; }
interface RowHandlers {
  rowContext: (e: React.MouseEvent, i: number) => void;
  rowNumClick: (e: React.MouseEvent, i: number) => void;
  toggleMark: (i: number) => void;
  cellClick: (e: React.MouseEvent<HTMLTableCellElement>, i: number, j: number) => void;
  cellDoubleClick: (i: number, j: number, redisKeyCol: boolean, val: string | null) => void;
  cellContext: (e: React.MouseEvent, i: number, j: number) => void;
  commitEdit: (r: number, c: number, raw: string, setNull: boolean) => void;
  cancelEdit: () => void;
  advanceCell: (r: number, c: number, dir: "down" | "up" | "right" | "left") => void;
  deleteRow: (i: number) => void;
}

const DataRow = memo(function DataRow({
  row, i, startRow, visibleCols, editable, isRedis, hasKeyMenu,
  isMarked, selRow, selCol, editingCol, editSeed, rowEdits, rangeCols, findLower, h,
}: {
  row: (string | null)[];
  i: number;
  startRow: number;
  visibleCols: VisibleCol[];
  editable: boolean;
  isRedis: boolean;
  /** Redis 鍵列右鍵選單可用（isRedis 且 key 欄存在） */
  hasKeyMenu: boolean;
  isMarked: boolean;
  selRow: boolean;
  /** 選取格落在本列時的欄索引；否則 null */
  selCol: number | null;
  /** 就地編輯格落在本列時的欄索引；否則 null */
  editingCol: number | null;
  editSeed: string | null;
  /** 本列的待套用編輯（欄索引 → 新值）；無編輯時 undefined（識別穩定） */
  rowEdits: Record<number, string | null> | undefined;
  /** 框選範圍與本列有交集時的可見欄序位界線；否則 null */
  rangeCols: { pmin: number; pmax: number } | null;
  findLower: string;
  h: RowHandlers;
}) {
  const t = useT();
  return (
    <tr
      className={`${selRow ? "bg-accent/[0.06]" : "hover:bg-fg/5"} group`}
      onContextMenu={hasKeyMenu ? (e) => h.rowContext(e, i) : undefined}
    >
      {editable && (
        <td className="px-1 py-1 border-b border-fg/5 text-center">
          <input type="checkbox" title={t("勾選以批次刪除")} checked={isMarked} onChange={() => h.toggleMark(i)} />
        </td>
      )}
      <td
        onClick={(e) => h.rowNumClick(e, i)}
        title={t("點看整列表單、Shift+點選整列")}
        className={`px-3 py-1 border-b border-fg/5 cursor-pointer hover:bg-fg/5 hover:text-fg/60 tabular-nums ${
          isMarked ? "text-red-300 bg-red-500/10" : selRow ? "text-accent/90" : "text-fg/30"
        }`}
      >
        {startRow + i + 1}
      </td>
      {visibleCols.map(({ j, name, pos }) => {
        const isEditing = editingCol === j;
        const dirty = !!rowEdits && j in rowEdits;
        const val = dirty ? rowEdits[j] : row[j];
        const isSel = selCol === j;
        const inR = !!rangeCols && pos >= rangeCols.pmin && pos <= rangeCols.pmax;
        // Redis 的 key 欄：雙擊開鍵詳情；其餘照常（ttl 可編輯）
        const redisKeyCol = isRedis && name === "key";
        return (
          <td
            key={j}
            onClick={(e) => h.cellClick(e, i, j)}
            onDoubleClick={() => h.cellDoubleClick(i, j, redisKeyCol, val)}
            onContextMenu={isRedis ? undefined : (e) => h.cellContext(e, i, j)}
            title={redisKeyCol ? t("雙擊檢視鍵內容") : val ?? "NULL"}
            className={`px-3 py-1 border-b border-fg/5 whitespace-nowrap overflow-hidden text-ellipsis ${
              isSel ? "ring-1 ring-inset ring-accent " : ""
            }${
              dirty ? "bg-amber-500/15" : isSel ? "bg-accent/15" : inR ? "bg-accent/10" : ""
            } ${redisKeyCol ? "cursor-pointer text-blue-300" : editable ? "cursor-cell" : ""}`}
          >
            {isEditing ? (
              <CellEditor
                initial={val}
                seed={editSeed}
                onCommit={(raw, setNull) => h.commitEdit(i, j, raw, setNull)}
                onCancel={h.cancelEdit}
                onAdvance={(dir) => h.advanceCell(i, j, dir)}
              />
            ) : val === null ? (
              <span className="text-fg/30 italic">NULL</span>
            ) : findLower ? (
              highlight(val, findLower)
            ) : (
              val
            )}
          </td>
        );
      })}
      {editable && (
        <td className="px-1 py-1 border-b border-fg/5 text-center">
          <button
            onClick={() => h.deleteRow(i)}
            title={t("刪除此列")}
            className="w-5 h-5 inline-flex items-center justify-center rounded text-fg/20 group-hover:text-red-400 hover:bg-red-500/20"
          >
            <Icon icon={Minus} size={14} />
          </button>
        </td>
      )}
    </tr>
  );
});

// 儲存格編輯器：Enter 套用、Esc 取消、按鈕設為 NULL
function CellEditor({ initial, seed, onCommit, onCancel, onAdvance }: {
  initial: string | null;
  /** 直接打字 / Backspace 清空時的初始覆寫文字；null = 沿用原值。 */
  seed?: string | null;
  onCommit: (raw: string, setNull: boolean) => void;
  onCancel: () => void;
  /** Enter/Tab 送出後推進到下一格（commit-and-advance）。 */
  onAdvance?: (dir: "down" | "up" | "right" | "left") => void;
}) {
  const t = useT();
  const [text, setText] = useState(seed != null ? seed : initial ?? "");
  // 防重複提交：Enter/Tab 推進會讓輸入框失焦，避免 onBlur 再次提交覆寫；Escape 取消亦忽略後續 blur。
  const committedRef = useRef(false);
  const commitOnce = (raw: string, setNull: boolean) => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(raw, setNull);
  };
  return (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        aria-label={t("編輯儲存格")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitOnce(text, false);
            onAdvance?.(e.shiftKey ? "up" : "down");
          } else if (e.key === "Tab") {
            e.preventDefault();
            commitOnce(text, false);
            onAdvance?.(e.shiftKey ? "left" : "right");
          } else if (e.key === "Escape") {
            committedRef.current = true; // 取消：忽略後續 blur 提交
            onCancel();
          }
        }}
        onBlur={() => commitOnce(text, false)}
        className="bg-inset border border-accent/70 rounded px-1 py-0.5 outline-none w-full min-w-[80px] focus:ring-2 focus:ring-accent/20"
      />
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); commitOnce("", true); }}
        title={t("設為 NULL")}
        className="text-[10px] text-fg/40 hover:text-fg/70 shrink-0"
      >
        NULL
      </button>
    </span>
  );
}

function NavBtn({ label, onClick, disabled, title }: {
  label: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-7 h-6 flex items-center justify-center rounded hover:bg-fg/10 disabled:opacity-25 disabled:hover:bg-transparent text-xs"
    >
      {label}
    </button>
  );
}

// ---- 結構分頁：欄位定義 ----
function StructurePane({ tab }: { tab: OpenTab }) {
  const t = useT();
  const kind = useStore((s) => s.connections.find((c) => c.id === tab.connId)?.kind);
  const isSql = kind === "mysql" || kind === "mariadb" || kind === "postgres" || kind === "sqlite" || kind === "oracle";
  // 索引管理（建立 / 刪除）關聯式與 MongoDB 皆支援；欄位 / DDL 編輯仍僅限 SQL。
  const canIndex = isSql || kind === "mongo";
  const [cols, setCols] = useState<ColumnInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rename, setRename] = useState<{ col: string; to: string } | null>(null);
  const [ddl, setDdl] = useState<string | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);
  const [addingIndex, setAddingIndex] = useState(false);
  const [fks, setFks] = useState<ForeignKeyInfo[] | null>(null); // 本表外鍵（含約束名，可刪除）
  const [incomingFks, setIncomingFks] = useState<ErRelation[] | null>(null); // 被哪些表參照（to_table = 本表）
  const [addingFk, setAddingFk] = useState(false);
  const isView = tab.objKind === "view";
  const roConn = useStore((s) => s.readonlyConns[tab.connId] === true);
  // Mongo：$indexStats（失敗 = null，索引表降級顯示 "—"）+ 集合驗證規則。
  const [ixStats, setIxStats] = useState<MongoIndexStat[] | null>(null);
  const [validation, setValidation] = useState<MongoValidation | null>(null);
  const [valText, setValText] = useState("");
  const [valLevel, setValLevel] = useState("strict");
  const [valAction, setValAction] = useState("error");
  const [valSaving, setValSaving] = useState(false);

  const viewDdl = async () => {
    try {
      setDdl(await api.tableDdl(tab.connId, tab.database, tab.table));
    } catch (e: any) {
      toast.error(e?.message ?? t("取得建表 SQL 失敗"));
    }
  };

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    api
      .tableColumns(tab.connId, tab.database, tab.table)
      .then((c) => !cancelled && setCols(c))
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")));
    // 索引：失敗或不支援則視為無索引（不擋欄位顯示）。
    api
      .tableIndexes(tab.connId, tab.database, tab.table)
      .then((ix) => !cancelled && setIndexes(ix))
      .catch(() => !cancelled && setIndexes([]));
    // 外鍵（本表）：用 list_foreign_keys（含約束名，可刪除）。被參照：取 ER 模型過濾 to_table。
    if (isSql) {
      api.listForeignKeys(tab.connId, tab.database, tab.table)
        .then((f) => !cancelled && setFks(f))
        .catch(() => !cancelled && setFks([]));
      api
        .erModel(tab.connId, tab.database)
        .then((m) => !cancelled && setIncomingFks(m.relations.filter((r) => r.to_table === tab.table)))
        .catch(() => !cancelled && setIncomingFks([]));
    } else {
      setFks([]);
      setIncomingFks([]);
    }
    // Mongo 專屬：索引使用統計（權限 / view 上失敗 → null 降級）+ 驗證規則。
    if (kind === "mongo") {
      api.mongoIndexStats(tab.connId, tab.database, tab.table)
        .then((s) => !cancelled && setIxStats(s))
        .catch(() => !cancelled && setIxStats(null));
      api.mongoGetValidation(tab.connId, tab.database, tab.table)
        .then((v) => {
          if (cancelled) return;
          setValidation(v);
          setValText(v.validator_json);
          setValLevel(v.level);
          setValAction(v.action);
        })
        .catch(() => !cancelled && setValidation(null));
    }
    return () => {
      cancelled = true;
    };
  }, [tab.connId, tab.database, tab.table, nonce, kind]);

  // Mongo 進階索引建立（方向 / 型別 + unique / sparse / hidden / TTL / partial）。
  const createMongoIndex = async (name: string, keys: [string, string][], options: MongoIndexOptions) => {
    setBusy(true);
    try {
      await api.mongoCreateIndex(tab.connId, tab.database, tab.table, name, keys, options);
      toast.success(t("索引已建立"));
      setAddingIndex(false);
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("建立索引失敗"));
    } finally {
      setBusy(false);
    }
  };

  // 儲存 / 清除集合驗證規則（collMod）。strict+error 會立即擋下不符寫入，需明確確認。
  const saveValidation = async (clear: boolean) => {
    const text = clear ? "" : valText.trim();
    if (text) {
      try { JSON.parse(text); } catch { toast.error(t("驗證規則需為合法 JSON（$jsonSchema）")); return; }
    }
    const danger = !clear && valLevel === "strict" && valAction === "error";
    const ok = await uiConfirm(
      clear
        ? t("清除此集合的驗證規則？")
        : t("套用驗證規則（level={level} / action={action}）？", { level: valLevel, action: valAction }) + (danger ? "\n" + t("strict + error 會立即阻擋不符合的寫入（含既有應用程式），請確認影響。") : ""),
      { title: clear ? t("清除驗證規則") : t("套用驗證規則"), danger, confirmText: clear ? t("清除") : t("套用") },
    );
    if (!ok) return;
    setValSaving(true);
    try {
      await api.mongoSetValidation(tab.connId, tab.database, tab.table, text, valLevel, valAction);
      toast.success(clear ? t("已清除驗證規則") : t("驗證規則已套用"));
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("設定驗證規則失敗"));
    } finally {
      setValSaving(false);
    }
  };

  const doAlter = async (op: AlterOp, okMsg: string) => {
    setBusy(true);
    try {
      await api.alterTable(tab.connId, tab.database, tab.table, op);
      toast.success(okMsg);
      setAdding(false);
      setRename(null);
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("結構變更失敗"));
    } finally {
      setBusy(false);
    }
  };

  const dropCol = async (name: string) => {
    if (!(await uiConfirm(t("刪除欄位「{name}」？此動作無法復原。", { name }), { title: t("刪除欄位"), danger: true, confirmText: t("刪除") }))) return;
    doAlter({ op: "drop_column", name }, t("欄位已刪除"));
  };
  // 修改欄位型別（MySQL / PostgreSQL；SQLite 不支援）。保留目前可空性。
  const modifyType = async (name: string, currentType: string, nullable: boolean) => {
    const input = await uiPrompt(t("新型別"), { title: t("修改欄位「{name}」型別", { name }), defaultValue: currentType, placeholder: t("如 VARCHAR(100) / int / text") });
    if (!input?.trim() || input.trim() === currentType) return;
    doAlter({ op: "modify_column", name, data_type: input.trim(), nullable }, t("欄位型別已修改"));
  };
  // 切換欄位可空（保留型別）；改 NOT NULL 若有 NULL 值會由 DB 報錯並以 toast 呈現。
  const toggleNull = (name: string, dataType: string, nullable: boolean) =>
    doAlter({ op: "modify_column", name, data_type: dataType, nullable: !nullable }, nullable ? t("已設為 NOT NULL") : t("已設為可空"));
  // 設定 / 清除欄位預設值（值為原樣 DDL，如 0 / 'x' / CURRENT_TIMESTAMP；清空=移除）。
  const setColDefault = async (name: string, current: string | null) => {
    const v = await uiPrompt(t("預設值（清空=移除預設）"), { title: t("欄位「{name}」預設值", { name }), defaultValue: current ?? "", placeholder: t("如 0 / 'x' / CURRENT_TIMESTAMP") });
    if (v === null) return;
    const trimmed = v.trim();
    doAlter({ op: "set_default", name, default: trimmed === "" ? null : trimmed }, trimmed === "" ? t("已移除預設值") : t("預設值已設定"));
  };
  // 新增外鍵（MySQL / PostgreSQL；走 exec_ddl）。
  const addFk = async (name: string, column: string, refTable: string, refColumn: string, onDelete: string, onUpdate: string) => {
    if (!kind) return;
    setBusy(true);
    try {
      await api.execDdl(tab.connId, buildAddForeignKey(kind, tab.database, tab.table, name, column, refTable, refColumn, onDelete, onUpdate));
      toast.success(t("外鍵已新增"));
      setAddingFk(false);
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("新增外鍵失敗"));
    } finally {
      setBusy(false);
    }
  };
  const dropFk = async (name: string) => {
    if (!kind) return;
    if (!(await uiConfirm(t("刪除外鍵「{name}」？", { name }), { title: t("刪除外鍵"), danger: true, confirmText: t("刪除") }))) return;
    setBusy(true);
    try {
      await api.execDdl(tab.connId, buildDropForeignKey(kind, tab.database, tab.table, name));
      toast.success(t("外鍵已刪除"));
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("刪除外鍵失敗"));
    } finally {
      setBusy(false);
    }
  };

  const dropIndexByName = async (name: string) => {
    if (!(await uiConfirm(t("刪除索引「{name}」？", { name }), { title: t("刪除索引"), danger: true, confirmText: t("刪除") }))) return;
    setBusy(true);
    try {
      await api.dropIndex(tab.connId, tab.database, tab.table, name);
      toast.success(t("索引已刪除"));
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("刪除索引失敗"));
    } finally {
      setBusy(false);
    }
  };

  // 重新命名索引（僅 MySQL / PG；SQLite 無 ALTER INDEX RENAME）。
  const renameIndexByName = async (oldName: string) => {
    if (!kind) return;
    const nn = await uiPrompt(t("重新命名索引「{oldName}」為：", { oldName }), { title: t("重新命名索引"), defaultValue: oldName, confirmText: t("重新命名") });
    if (nn === null || !nn.trim() || nn.trim() === oldName) return;
    setBusy(true);
    try {
      await api.execDdl(tab.connId, buildRenameIndex(kind, tab.database, tab.table, oldName, nn));
      toast.success(t("索引已重新命名"));
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("重新命名索引失敗"));
    } finally {
      setBusy(false);
    }
  };

  const createIndexFn = async (name: string, columns: string[], type: "normal" | "unique" | "fulltext") => {
    if (!name.trim() || columns.length === 0) { toast.error(t("請填索引名稱並至少選一欄")); return; }
    setBusy(true);
    try {
      if (type === "fulltext") {
        await api.execDdl(tab.connId, buildCreateFulltextIndex(tab.database, tab.table, name.trim(), columns));
      } else {
        await api.createIndex(tab.connId, tab.database, tab.table, name.trim(), columns, type === "unique");
      }
      toast.success(t("索引已建立"));
      setAddingIndex(false);
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("建立索引失敗"));
    } finally {
      setBusy(false);
    }
  };

  if (err) return <div className="p-3 text-red-400 text-sm mono">{err}</div>;
  if (!cols) return <div className="p-3 text-fg/40 text-sm">{t("讀取中…")}</div>;

  return (
    <div className="flex-1 overflow-auto">
      {isSql && (
        <div className="flex items-center gap-1 px-2 py-1 bg-inset border-b border-fg/10 text-xs">
          <button type="button" onClick={() => setAdding((s) => !s)} disabled={busy}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40 inline-flex items-center gap-1">
            <Icon icon={Plus} size={14} /> {t("新增欄位")}
          </button>
          <button type="button" onClick={viewDdl}
            title={t("檢視 / 複製建表 SQL（CREATE 語句）")}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1">
            <Icon icon={Copy} size={14} /> {t("建表 SQL")}
          </button>
          <button type="button" onClick={() => setNonce((n) => n + 1)} disabled={busy}
            title={t("重新讀取結構（外部變更後同步）")}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40 inline-flex items-center gap-1">
            <Icon icon={RefreshCw} size={14} /> {t("重新整理")}
          </button>
          {busy && <span className="text-fg/40">{t("處理中…")}</span>}
        </div>
      )}
      {adding && isSql && <AddColumnForm kind={kind} busy={busy} onCancel={() => setAdding(false)}
        onSubmit={(op) => doAlter(op, t("欄位已新增"))} />}
      <table className="text-sm border-collapse w-full">
        <thead className="sticky top-0 bg-bar">
          <tr>
            {[t("欄位"), t("型別"), t("可空"), t("鍵"), t("預設"), t("額外")].map((h) => (
              <th key={h} className="text-left px-3 py-1.5 border-b border-fg/10 font-medium">
                {h}
              </th>
            ))}
            {isSql && <th className="w-20 border-b border-fg/10" />}
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.name} className="hover:bg-fg/5 group">
              <td className="px-3 py-1 border-b border-fg/5 font-medium">
                {rename?.col === c.name ? (
                  <input autoFocus value={rename.to}
                    onChange={(e) => setRename({ col: c.name, to: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && rename.to && rename.to !== c.name)
                        doAlter({ op: "rename_column", old: c.name, new: rename.to }, t("欄位已改名"));
                      else if (e.key === "Escape") setRename(null);
                    }}
                    onBlur={() => setRename(null)}
                    aria-label={t("欄位改名")}
                    className="bg-inset border border-accent/70 rounded px-1 py-0.5 outline-none focus:ring-2 focus:ring-accent/20" />
                ) : (
                  c.name
                )}
              </td>
              <td className="px-3 py-1 border-b border-fg/5 mono text-fg/70">{c.data_type}</td>
              <td className="px-3 py-1 border-b border-fg/5 text-fg/60">
                {kind !== "sqlite" ? (
                  <button type="button" disabled={busy} title={t("點擊切換可空 / NOT NULL")}
                    onClick={() => toggleNull(c.name, c.data_type, c.nullable)}
                    className="hover:bg-fg/10 rounded px-1 disabled:opacity-40">{c.nullable ? "YES" : "NO"}</button>
                ) : (
                  c.nullable ? "YES" : "NO"
                )}
              </td>
              <td className="px-3 py-1 border-b border-fg/5">
                {c.key && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">{c.key}</span>
                )}
              </td>
              <td className="px-3 py-1 border-b border-fg/5 mono text-fg/50">
                {kind !== "sqlite" ? (
                  <button type="button" disabled={busy} title={t("點擊設定 / 清除預設值")}
                    onClick={() => setColDefault(c.name, c.default)}
                    className="hover:bg-fg/10 rounded px-1 disabled:opacity-40">
                    {c.default ?? <span className="text-fg/25 italic">—</span>}
                  </button>
                ) : (
                  c.default ?? <span className="text-fg/25 italic">—</span>
                )}
              </td>
              <td className="px-3 py-1 border-b border-fg/5 text-fg/50 text-xs">{c.extra}</td>
              {isSql && (
                <td className="px-2 py-1 border-b border-fg/5 text-right whitespace-nowrap">
                  <button type="button" title={t("改名")} disabled={busy}
                    onClick={() => setRename({ col: c.name, to: c.name })}
                    className="px-1 inline-flex items-center text-fg/20 group-hover:text-fg/70 hover:bg-fg/15 rounded disabled:opacity-40"><Icon icon={Pencil} size={14} /></button>
                  {kind !== "sqlite" && (
                    <button type="button" title={t("修改型別")} disabled={busy}
                      onClick={() => modifyType(c.name, c.data_type, c.nullable)}
                      className="px-1 text-fg/20 group-hover:text-fg/70 hover:bg-fg/15 rounded disabled:opacity-40">{t("型")}</button>
                  )}
                  <button type="button" title={t("刪除欄位")} disabled={busy}
                    onClick={() => dropCol(c.name)}
                    className="px-1 inline-flex items-center text-fg/20 group-hover:text-red-400 hover:bg-red-500/20 rounded disabled:opacity-40"><Icon icon={Minus} size={14} /></button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/* 索引區（致敬商用工具的結構檢視） */}
      {indexes && (indexes.length > 0 || canIndex) && (
        <div className="mt-2">
          <div className="px-3 py-1.5 text-xs text-fg/40 bg-inset border-y border-fg/10 flex items-center gap-2">
            <span>{t("索引（")}{indexes.length}）</span>
            {canIndex && (
              <button type="button" onClick={() => setAddingIndex((s) => !s)} disabled={busy}
                className="px-1.5 py-0.5 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40 inline-flex items-center gap-1"><Icon icon={Plus} size={14} /> {t("新增索引")}</button>
            )}
          </div>
          {addingIndex && canIndex && cols && (
            kind === "mongo" ? (
              <MongoAddIndexForm columns={cols.map((c) => c.name)} busy={busy}
                onCancel={() => setAddingIndex(false)} onSubmit={createMongoIndex} />
            ) : (
              <AddIndexForm columns={cols.map((c) => c.name)} busy={busy} allowFulltext={kind === "mysql" || kind === "mariadb"}
                onCancel={() => setAddingIndex(false)} onSubmit={createIndexFn} />
            )
          )}
          {indexes.length === 0 && <div className="px-3 py-2 text-fg/30 text-xs">{t("尚無索引。")}</div>}
          {indexes.length > 0 && (
          <table className="text-sm border-collapse w-full">
            <thead className="bg-elevated">
              <tr>
                {[t("名稱"), t("欄位"), t("唯一"), t("主鍵"), ...(kind === "mongo" ? [t("使用次數"), t("統計起始")] : [])].map((h) => (
                  <th key={h} className="text-left px-3 py-1.5 border-b border-fg/10 font-medium">{h}</th>
                ))}
                {canIndex && <th className="w-12 border-b border-fg/10" />}
              </tr>
            </thead>
            <tbody>
              {indexes.map((ix) => {
                // $indexStats 以名稱 join；整體失敗（權限 / view）→ null → 各列顯示 "—"。
                const st = ixStats?.find((s) => s.name === ix.name);
                return (
                <tr key={ix.name} className="hover:bg-fg/5 group">
                  <td className="px-3 py-1 border-b border-fg/5 mono">{ix.name}</td>
                  <td className="px-3 py-1 border-b border-fg/5 mono text-fg/70">{ix.columns.join(", ")}</td>
                  <td className="px-3 py-1 border-b border-fg/5">
                    {ix.unique && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">UNIQUE</span>}
                  </td>
                  <td className="px-3 py-1 border-b border-fg/5">
                    {ix.primary && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">PK</span>}
                  </td>
                  {kind === "mongo" && (
                    <>
                      <td className="px-3 py-1 border-b border-fg/5 mono text-fg/70">
                        {st ? st.ops : <span title={t("無法取得 $indexStats（權限不足或不支援）")}>—</span>}
                        {st && st.ops === 0 && !ix.primary && (
                          <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300"
                            title={t("自 {since} 起未被任何查詢使用（mongod 重啟會重置統計）", { since: st.since || t("統計起始") })}>{t("未使用")}</span>
                        )}
                      </td>
                      <td className="px-3 py-1 border-b border-fg/5 mono text-fg/50 whitespace-nowrap">
                        {st?.since ? st.since.replace("T", " ").slice(0, 19) : "—"}
                      </td>
                    </>
                  )}
                  {canIndex && (
                    <td className="px-2 py-1 border-b border-fg/5 text-right whitespace-nowrap">
                      {!ix.primary && (kind === "mysql" || kind === "mariadb" || kind === "postgres") && (
                        <button type="button" title={t("重新命名索引")} disabled={busy}
                          onClick={() => renameIndexByName(ix.name)}
                          className="px-1 inline-flex items-center text-fg/20 group-hover:text-blue-400 hover:bg-blue-500/20 rounded disabled:opacity-40"><Icon icon={Pencil} size={14} /></button>
                      )}
                      {!ix.primary && (
                        <button type="button" title={t("刪除索引")} disabled={busy}
                          onClick={() => dropIndexByName(ix.name)}
                          className="px-1 inline-flex items-center text-fg/20 group-hover:text-red-400 hover:bg-red-500/20 rounded disabled:opacity-40"><Icon icon={Minus} size={14} /></button>
                      )}
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
      )}

      {/* 驗證規則（Mongo）：JSON Schema validator + level / action（collMod）。 */}
      {kind === "mongo" && !isView && (
        <div className="mt-2">
          <div className="px-3 py-1.5 text-xs text-fg/40 bg-inset border-y border-fg/10 flex items-center gap-2">
            <span>{t("驗證規則")}{validation && validation.validator_json ? t("（已設定）") : t("（未設定）")}</span>
            {validation === null && <span className="text-fg/30">{t("— 無法讀取（權限不足或不支援）")}</span>}
          </div>
          {validation !== null && (
            <div className="p-3 space-y-2">
              <textarea
                value={valText}
                onChange={(e) => setValText(e.target.value)}
                spellCheck={false}
                readOnly={roConn}
                placeholder={'{ "$jsonSchema": { "bsonType": "object", "required": ["name"], "properties": { "name": { "bsonType": "string" } } } }'}
                className="w-full h-40 rounded bg-well border border-fg/10 p-2 mono text-xs outline-none focus:border-accent/60"
              />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-fg/50">level</span>
                <select value={valLevel} onChange={(e) => setValLevel(e.target.value)} disabled={roConn}
                  className="bg-inset border border-fg/10 rounded px-1.5 py-1 outline-none cursor-pointer"
                  title={t("off=不驗證；moderate=僅驗證新文件與原本合規的文件；strict=全部驗證")}>
                  <option value="off">off</option>
                  <option value="moderate">moderate</option>
                  <option value="strict">strict</option>
                </select>
                <span className="text-fg/50">action</span>
                <select value={valAction} onChange={(e) => setValAction(e.target.value)} disabled={roConn}
                  className="bg-inset border border-fg/10 rounded px-1.5 py-1 outline-none cursor-pointer"
                  title={t("warn=僅記錄警告；error=拒絕不符合的寫入")}>
                  <option value="warn">warn</option>
                  <option value="error">error</option>
                </select>
                {!roConn && (
                  <>
                    <Button variant="primary" size="sm" loading={valSaving} onClick={() => saveValidation(false)}>{t("套用")}</Button>
                    {validation.validator_json && (
                      <Button variant="secondary" size="sm" disabled={valSaving} onClick={() => saveValidation(true)}>{t("清除規則")}</Button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 外鍵區（取自 ER 模型；致敬商用工具的結構檢視） */}
      {isSql && !isView && fks && (fks.length > 0 || kind !== "sqlite") && (
        <div className="mt-2">
          <div className="px-3 py-1.5 text-xs text-fg/40 bg-inset border-y border-fg/10 flex items-center gap-2">
            <span>{t("外鍵（")}{fks.length}）</span>
            {kind !== "sqlite" && (
              <button type="button" onClick={() => setAddingFk((s) => !s)} disabled={busy}
                className="px-1.5 py-0.5 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40 inline-flex items-center gap-1"><Icon icon={Plus} size={14} /> {t("新增外鍵")}</button>
            )}
          </div>
          {addingFk && kind !== "sqlite" && cols && (
            <AddForeignKeyForm table={tab.table} columns={cols.map((c) => c.name)} busy={busy}
              onCancel={() => setAddingFk(false)} onSubmit={addFk} />
          )}
          {fks.length === 0 ? (
            <div className="px-3 py-2 text-fg/30 text-xs">{t("尚無外鍵。")}</div>
          ) : (
            <table className="text-sm border-collapse w-full">
              <thead className="bg-elevated">
                <tr>
                  {[t("約束"), t("欄位"), t("參照"), t("參照欄位")].map((h) => (
                    <th key={h} className="text-left px-3 py-1.5 border-b border-fg/10 font-medium">{h}</th>
                  ))}
                  {kind !== "sqlite" && <th className="w-10 border-b border-fg/10" aria-label={t("操作")} />}
                </tr>
              </thead>
              <tbody>
                {fks.map((fk) => (
                  <tr key={fk.name} className="hover:bg-fg/5 group">
                    <td className="px-3 py-1 border-b border-fg/5 mono text-fg/60">{fk.name}</td>
                    <td className="px-3 py-1 border-b border-fg/5 mono">{fk.column}</td>
                    <td className="px-3 py-1 border-b border-fg/5 mono text-fg/50">→ {fk.ref_table}</td>
                    <td className="px-3 py-1 border-b border-fg/5 mono">{fk.ref_column}</td>
                    {kind !== "sqlite" && (
                      <td className="px-2 py-1 border-b border-fg/5 text-right">
                        <button type="button" title={t("刪除外鍵")} disabled={busy} onClick={() => dropFk(fk.name)}
                          className="px-1 inline-flex items-center text-fg/20 group-hover:text-red-400 hover:bg-red-500/20 rounded disabled:opacity-40"><Icon icon={Minus} size={14} /></button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 被參照區：哪些表的外鍵指向本表（影響分析：刪除 / 改結構前先看） */}
      {isSql && incomingFks && incomingFks.length > 0 && (
        <div className="mt-2">
          <div className="px-3 py-1.5 text-xs text-fg/40 bg-inset border-y border-fg/10">
            {t("被參照（")}{incomingFks.length}）
          </div>
          <table className="text-sm border-collapse w-full">
            <thead className="bg-elevated">
              <tr>
                {[t("來源表"), t("來源欄位"), t("參照本表欄位")].map((h) => (
                  <th key={h} className="text-left px-3 py-1.5 border-b border-fg/10 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {incomingFks.map((fk, i) => (
                <tr key={`${fk.from_table}-${fk.from_column}-${i}`} className="hover:bg-fg/5">
                  <td className="px-3 py-1 border-b border-fg/5 mono">{fk.from_table}</td>
                  <td className="px-3 py-1 border-b border-fg/5 mono">{fk.from_column}</td>
                  <td className="px-3 py-1 border-b border-fg/5 mono text-fg/50">→ {fk.to_column}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ddl !== null && (
        <CellInspector column={t("{table} · 建表 SQL", { table: tab.table })} value={ddl} editable={false}
          showFormat={false} onSave={() => {}} onClose={() => setDdl(null)} />
      )}
    </div>
  );
}

function AddColumnForm({ kind, onSubmit, onCancel, busy }: {
  kind?: DbKind;
  onSubmit: (op: AlterOp) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [dataType, setDataType] = useState("");
  const [nullable, setNullable] = useState(true);
  const [def, setDef] = useState("");
  const ic = "bg-inset border border-fg/10 rounded px-2 py-1 text-sm outline-none focus:border-accent";
  // 常見型別下拉（依連線種類）；選後仍可於輸入框微調長度 / 精度（如 VARCHAR(50)）。
  const presets = (kind && TYPE_PRESETS[kind]) || [];
  const submit = () => {
    if (!name.trim() || !dataType.trim()) { toast.error(t("請填欄位名稱與型別")); return; }
    onSubmit({ op: "add_column", name: name.trim(), data_type: dataType.trim(), nullable, default: def.trim() || null });
  };
  return (
    <div className="flex flex-wrap items-end gap-2 px-3 py-2 bg-well border-b border-fg/10 text-xs">
      <label className="block"><span className="text-fg/50 block mb-0.5">{t("欄位名稱")}</span>
        <input className={ic} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block"><span className="text-fg/50 block mb-0.5">{t("型別")}</span>
        <div className="flex items-center gap-1">
          <select className={`${ic} cursor-pointer`} title={t("常見型別快捷")}
            value={presets.includes(dataType) ? dataType : ""}
            onChange={(e) => { if (e.target.value) setDataType(e.target.value); }}>
            <option value="">{t("選擇…")}</option>
            {presets.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
          <input className={`${ic} w-40`} value={dataType} onChange={(e) => setDataType(e.target.value)} placeholder={t("如 VARCHAR(50) / INT")} />
        </div></label>
      <label className="block"><span className="text-fg/50 block mb-0.5">{t("預設值（選填）")}</span>
        <input className={ic} value={def} onChange={(e) => setDef(e.target.value)} placeholder={t("如 0 / 'x' / CURRENT_TIMESTAMP")} /></label>
      <label className="flex items-center gap-1 pb-1.5 select-none">
        <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} /> {t("可空")}
      </label>
      <button type="button" onClick={submit} disabled={busy}
        className="px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">{t("新增")}</button>
      <button type="button" onClick={onCancel}
        className="px-3 py-1.5 rounded border border-fg/15 hover:bg-fg/5">{t("取消")}</button>
    </div>
  );
}

// 新增索引表單：名稱 + 欄位多選（依點選順序組複合索引）+ 唯一。
const FK_ACTIONS = ["", "CASCADE", "SET NULL", "RESTRICT", "NO ACTION", "SET DEFAULT"];

function AddForeignKeyForm({ table, columns, busy, onSubmit, onCancel }: {
  table: string;
  columns: string[];
  busy: boolean;
  onSubmit: (name: string, column: string, refTable: string, refColumn: string, onDelete: string, onUpdate: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [column, setColumn] = useState(columns[0] ?? "");
  const [refTable, setRefTable] = useState("");
  const [refColumn, setRefColumn] = useState("");
  const [name, setName] = useState("");
  const [onDelete, setOnDelete] = useState("");
  const [onUpdate, setOnUpdate] = useState("");
  const ic = "bg-inset border border-fg/10 rounded px-2 py-1 text-xs outline-none focus:border-accent";
  const effName = name.trim() || `fk_${table}_${column}`;
  const valid = !!column && !!refTable.trim() && !!refColumn.trim();
  return (
    <div className="px-3 py-2 bg-inset border-b border-fg/10 flex flex-wrap items-center gap-2">
      <select value={column} onChange={(e) => setColumn(e.target.value)} title={t("本表欄位")} className={ic}>
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <span className="text-fg/40 text-xs">→</span>
      <input value={refTable} onChange={(e) => setRefTable(e.target.value)} placeholder={t("參照表")} className={`${ic} w-28`} />
      <input value={refColumn} onChange={(e) => setRefColumn(e.target.value)} placeholder={t("參照欄位")} className={`${ic} w-28`} />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={effName} title={t("約束名稱（留空自動產生）")} className={`${ic} w-40`} />
      <select value={onDelete} onChange={(e) => setOnDelete(e.target.value)} title="ON DELETE" className={ic}>
        {FK_ACTIONS.map((a) => <option key={a} value={a}>{a ? `ON DELETE ${a}` : t("ON DELETE（預設）")}</option>)}
      </select>
      <select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value)} title="ON UPDATE" className={ic}>
        {FK_ACTIONS.map((a) => <option key={a} value={a}>{a ? `ON UPDATE ${a}` : t("ON UPDATE（預設）")}</option>)}
      </select>
      <button type="button" disabled={busy || !valid} onClick={() => onSubmit(effName, column, refTable, refColumn, onDelete, onUpdate)}
        className="px-2 py-1 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">{t("建立")}</button>
      <button type="button" onClick={onCancel} className="px-2 py-1 text-xs rounded border border-fg/15 hover:bg-fg/5">{t("取消")}</button>
    </div>
  );
}

// Mongo 進階索引表單：欄位 + 規格（1/-1/text/2dsphere/hashed）多列、unique / sparse / hidden、
// TTL 秒數（限單鍵、需日期欄位）、partialFilterExpression（JSON）。
function MongoAddIndexForm({ columns, busy, onSubmit, onCancel }: {
  columns: string[];
  busy: boolean;
  onSubmit: (name: string, keys: [string, string][], options: MongoIndexOptions) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<{ field: string; spec: string }[]>([{ field: "", spec: "1" }]);
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [ttl, setTtl] = useState("");
  const [partial, setPartial] = useState("");

  const valid = rows.filter((r) => r.field.trim());
  // Mongo 慣例名：field_spec 串接（如 status_1_created_-1）。
  const autoName = valid.map((r) => `${r.field.trim()}_${r.spec}`).join("_");
  const setRow = (i: number, patch: Partial<{ field: string; spec: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = () => {
    if (valid.length === 0) { toast.error(t("索引至少需一個欄位")); return; }
    if (ttl.trim() && valid.length > 1) { toast.error(t("TTL 索引僅支援單一欄位（且需為日期欄位）")); return; }
    if (partial.trim()) {
      try { JSON.parse(partial); } catch { toast.error(t("partialFilterExpression 需為合法 JSON")); return; }
    }
    onSubmit(
      (name.trim() || autoName),
      valid.map((r) => [r.field.trim(), r.spec] as [string, string]),
      {
        unique, sparse, hidden,
        expire_after_secs: ttl.trim() ? Math.max(0, Math.floor(Number(ttl))) : null,
        partial_filter_json: partial.trim() || null,
      },
    );
  };

  return (
    <div className="px-3 py-2 space-y-2 border-b border-fg/10 bg-well/50 text-xs">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <input list="mongo-index-fields" value={r.field} onChange={(e) => setRow(i, { field: e.target.value })}
            placeholder={t("欄位（可含 . 巢狀路徑）")}
            className="flex-1 h-7 rounded bg-inset border border-fg/10 px-2 outline-none focus:border-accent/60 mono" />
          <select value={r.spec} onChange={(e) => setRow(i, { spec: e.target.value })}
            className="h-7 bg-inset border border-fg/10 rounded px-1.5 outline-none cursor-pointer">
            <option value="1">{t("1（升冪）")}</option>
            <option value="-1">{t("-1（降冪）")}</option>
            <option value="text">text</option>
            <option value="2dsphere">2dsphere</option>
            <option value="hashed">hashed</option>
          </select>
          {rows.length > 1 && (
            <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              className="text-fg/30 hover:text-red-400"><Icon icon={Minus} size={14} /></button>
          )}
        </div>
      ))}
      <datalist id="mongo-index-fields">
        {columns.map((c) => <option key={c} value={c} />)}
      </datalist>
      <button type="button" onClick={() => setRows((rs) => [...rs, { field: "", spec: "1" }])}
        className="inline-flex items-center gap-1 text-fg/50 hover:text-fg/80"><Icon icon={Plus} size={13} />{t("加欄位")}</button>
      <div className="flex flex-wrap items-center gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName || t("索引名稱（留空自動）")}
          className="w-56 h-7 rounded bg-inset border border-fg/10 px-2 outline-none focus:border-accent/60 mono" />
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />{t("唯一（unique）")}
        </label>
        <label className="flex items-center gap-1 cursor-pointer select-none" title={t("缺此欄位的文件不納入索引")}>
          <input type="checkbox" checked={sparse} onChange={(e) => setSparse(e.target.checked)} />{t("稀疏（sparse）")}
        </label>
        <label className="flex items-center gap-1 cursor-pointer select-none" title={t("查詢計畫不使用、仍持續維護（4.4+）")}>
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />{t("隱藏（hidden）")}
        </label>
        <label className="flex items-center gap-1" title={t("到期自動刪除文件；僅單一日期欄位索引有效")}>
          {t("TTL 秒數")}
          <input type="number" value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="—"
            className="w-24 h-7 rounded bg-inset border border-fg/10 px-2 outline-none focus:border-accent/60" />
        </label>
      </div>
      <input value={partial} onChange={(e) => setPartial(e.target.value)}
        placeholder={t("部分索引條件 partialFilterExpression（選填 JSON，如 {\"status\":{\"$eq\":\"active\"}}）")}
        className="w-full h-7 rounded bg-inset border border-fg/10 px-2 outline-none focus:border-accent/60 mono" />
      <div className="flex gap-2">
        <Button variant="primary" size="sm" loading={busy} onClick={submit}>{t("建立索引")}</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>{t("取消")}</Button>
      </div>
    </div>
  );
}

function AddIndexForm({ columns, busy, allowFulltext, onSubmit, onCancel }: {
  columns: string[];
  busy: boolean;
  allowFulltext?: boolean;
  onSubmit: (name: string, columns: string[], type: "normal" | "unique" | "fulltext") => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [type, setType] = useState<"normal" | "unique" | "fulltext">("normal");
  const toggle = (c: string) => setSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  const ic = "bg-inset border border-fg/10 rounded px-2 py-1 text-sm outline-none focus:border-accent";
  return (
    <div className="px-3 py-2 bg-well border-b border-fg/10 text-xs space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="text-fg/50 block mb-0.5">{t("索引名稱")}</span>
          <input className={ic} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("如 idx_email")} /></label>
        <label className="block"><span className="text-fg/50 block mb-0.5">{t("類型")}</span>
          <select className={ic} value={type} onChange={(e) => setType(e.target.value as typeof type)} title={t("索引類型")}>
            <option value="normal">{t("普通")}</option>
            <option value="unique">{t("唯一")}</option>
            {allowFulltext && <option value="fulltext">{t("全文 (FULLTEXT)")}</option>}
          </select></label>
      </div>
      <div>
        <span className="text-fg/50 block mb-1">{t("欄位（可多選，依點選順序組複合索引）")}</span>
        <div className="flex flex-wrap gap-1.5">
          {columns.map((c) => {
            const i = sel.indexOf(c);
            return (
              <button key={c} type="button" onClick={() => toggle(c)}
                className={`px-2 py-0.5 rounded border ${i >= 0 ? "border-accent bg-accent/15 text-accent" : "border-fg/10 text-fg/50"}`}>
                {c}{i >= 0 ? `（${i + 1}）` : ""}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => onSubmit(name, sel, type)} disabled={busy}
          className="px-3 py-1 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">{t("建立")}</button>
        <button type="button" onClick={onCancel}
          className="px-3 py-1 rounded border border-fg/15 hover:bg-fg/5">{t("取消")}</button>
      </div>
    </div>
  );
}
