import { useEffect, useMemo, useRef, useState } from "react";
import {
  ListTree, Table2, Plus, Minus, BarChart3, Network, Settings, Terminal,
  RefreshCw, Search, Filter, Trash2, ArrowUpDown, Download, Upload, X, Check,
  ArrowUp, ArrowDown, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight,
  Copy, Pencil, Columns3,
} from "lucide-react";
import Icon from "./ui/Icon";
import { Button, EmptyState } from "./ui/index";
import {
  api, ColumnInfo, DbKind, ErRelation, Filter as FilterCond, ForeignKeyInfo, IndexInfo, KeyDetail, KeyEdit, KeyPage, PagedData, RowInsert, Sort, SortDir,
} from "./api";
import { OpenTab, useStore } from "./store";
import { toast, uiConfirm, uiPrompt, copyToClipboard, useModalCount, useModalOverlay } from "./ui";
import { quoteIdent, sqlLiteral, buildRowUpdate, buildRowDelete, buildAddForeignKey, buildDropForeignKey, buildRenameIndex, buildCreateFulltextIndex, parseClipboardGrid, rectToTsv, rangeStats, TYPE_PRESETS } from "./sql";
import ExportDialog from "./ExportDialog";
import ImportDialog from "./ImportDialog";
import RedisKeyTree from "./RedisKeyTree";
import NewKeyDialog from "./NewKeyDialog";
import RedisStatus from "./RedisStatus";
import RedisConsole from "./RedisConsole";
import PubSubPanel from "./PubSubPanel";
import RedisOpsPanel from "./RedisOpsPanel";
import { AlterOp } from "./api";

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
            {v === "data" ? "資料" : "結構"}
          </button>
        ))}
      </div>
      {tab.view === "data" ? <DataPane tab={tab} /> : <StructurePane tab={tab} />}
    </div>
  );
}

// ---- 資料分頁：表格 + 底部導覽列 ----
function DataPane({ tab }: { tab: OpenTab }) {
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
  const isSqlKind = connKind === "mysql" || connKind === "postgres" || connKind === "sqlite";
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ key: string; ttl: string | null; x: number; y: number } | null>(null);
  // Redis 鍵檢視模式：樹狀（命名空間資料夾）/ 網格（key 列表）。記憶於 localStorage。
  const [redisView, setRedisView] = useState<"tree" | "grid">(() => {
    try { return localStorage.getItem("at-kit:redisKeyView") === "grid" ? "grid" : "tree"; }
    catch { return "tree"; }
  });
  const treeMode = isRedis && redisView === "tree";
  const setRedisViewPersist = (v: "tree" | "grid") => {
    setRedisView(v);
    try { localStorage.setItem("at-kit:redisKeyView", v); } catch { /* 忽略 */ }
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
      toast.info("至少需保留一欄");
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

  // Esc 關閉儲存格 / 欄位右鍵選單（與對話框、側欄選單一致）。
  useEffect(() => {
    if (!cellMenu && !colMenu) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setCellMenu(null); setColMenu(null); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [cellMenu, colMenu]);

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

  const load = () => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .tableData(tab.connId, tab.database, tab.table, {
        page,
        page_size: pageSize,
        filters,
        sorts,
        match_any: matchAny,
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setEdits({});
          setEditing(null);
          setSelected(null); // 重載後清除選取，避免指向已不存在的列
          setRangeEnd(null); // 同時清除框選範圍（列索引在重載後可能失效）
        }
      })
      .catch((e) => !cancelled && setErr(e?.message ?? "讀取失敗"))
      .finally(() => !cancelled && setLoading(false));
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
  const editable = !!data && data.primary_key.length > 0;
  // 新增列不需主鍵（INSERT 不依賴 PK）；只有更新 / 刪除個別列才需 PK 來定位。視圖不可插入。
  const insertable = !!data && data.columns.length > 0 && tab.objKind !== "view";
  const dirtyCount = Object.keys(edits).length;
  // 排序 / 篩選會觸發重載並放棄待套用編輯（與換頁 / 重整的保護一致），先確認。
  const guardDiscard = async (): Promise<boolean> =>
    dirtyCount === 0 ||
    (await uiConfirm("有未套用的變更，排序 / 篩選將重新載入並放棄。確定？", { title: "放棄變更", danger: true, confirmText: "放棄並繼續" }));
  // 範圍選取矩形邊界（以可見欄序位計）：供儲存格判斷是否被框選、Ctrl+C 區塊複製定位。
  const rangeVisIdx = data ? data.columns.map((_, j) => j).filter((j) => !isHidden(data.columns[j])) : [];
  const rangeRect =
    selected && rangeEnd
      ? {
          r1: Math.min(selected.r, rangeEnd.r),
          r2: Math.max(selected.r, rangeEnd.r),
          pmin: Math.min(rangeVisIdx.indexOf(selected.c), rangeVisIdx.indexOf(rangeEnd.c)),
          pmax: Math.max(rangeVisIdx.indexOf(selected.c), rangeVisIdx.indexOf(rangeEnd.c)),
        }
      : null;
  const inRange = (i: number, j: number): boolean => {
    if (!rangeRect || i < rangeRect.r1 || i > rangeRect.r2) return false;
    const p = rangeVisIdx.indexOf(j);
    return p >= rangeRect.pmin && p <= rangeRect.pmax;
  };
  // Redis 鍵列右鍵需定位 key / ttl 欄。
  const keyIdx = data ? data.columns.indexOf("key") : -1;
  const ttlIdx = data ? data.columns.indexOf("ttl") : -1;

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
        const pkValues = data.primary_key.map(
          (pkCol) => data.rows[r][data.columns.indexOf(pkCol)]
        );
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
      const msg = e?.message ?? "未知錯誤";
      // 逐筆套用：失敗前已套用的 (applied) 筆已寫入 DB。明確告知部分套用狀態，
      // 重新套用是安全的（已套用者會以相同值覆寫，等同無變化）。
      setErr(
        applied > 0
          ? `已套用 ${applied}/${total} 筆，第 ${applied + 1} 筆失敗：${msg}。修正後可再次套用（已套用者會以相同值覆寫，不會重複）。`
          : `套用失敗：${msg}`
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
    const pkValues = data.primary_key.map(
      (pkCol) => data.rows[r][data.columns.indexOf(pkCol)]
    );
    const editsNote = dirtyCount > 0 ? `\n（將同時放棄 ${dirtyCount} 筆未套用的編輯）` : "";
    if (!(await uiConfirm("確定刪除此列？此動作無法復原。" + editsNote, { title: "刪除列", danger: true, confirmText: "刪除" }))) return;
    setApplying(true);
    setErr(null);
    try {
      await api.deleteRow(tab.connId, tab.database, tab.table, {
        pk_columns: data.primary_key,
        pk_values: pkValues,
      });
      load();
    } catch (e: any) {
      setErr(e?.message ?? "刪除失敗");
    } finally {
      setApplying(false);
    }
  };

  const toggleMark = (r: number) =>
    setMarked((m) => { const n = new Set(m); if (n.has(r)) n.delete(r); else n.add(r); return n; });

  // 批次刪除已標記列：先擷取各列主鍵值（避免逐筆刪除後索引位移），再逐筆依主鍵刪除，最後重載。
  const bulkDelete = async () => {
    if (!data || !editable || marked.size === 0) return;
    const idxs = [...marked];
    const bulkEditsNote = dirtyCount > 0 ? `\n（將同時放棄 ${dirtyCount} 筆未套用的編輯）` : "";
    if (!(await uiConfirm(`確定刪除選取的 ${idxs.length} 列？此動作無法復原。` + bulkEditsNote,
      { title: "刪除選取列", danger: true, confirmText: `刪除 ${idxs.length} 列` }))) return;
    const pkSets = idxs.map((r) => data.primary_key.map((pk) => data.rows[r][data.columns.indexOf(pk)]));
    setApplying(true);
    setErr(null);
    try {
      for (const pkValues of pkSets)
        await api.deleteRow(tab.connId, tab.database, tab.table, { pk_columns: data.primary_key, pk_values: pkValues });
      setMarked(new Set());
      load();
    } catch (e: any) {
      setErr(e?.message ?? "批次刪除失敗");
      load(); // 反映可能的部分刪除結果
    } finally {
      setApplying(false);
    }
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
      setErr(e?.message ?? "新增失敗");
    } finally {
      setApplying(false);
    }
  };

  // ---- SQL 表儲存格：複製 / 重製 / 鍵盤導覽（致敬 DBeaver / TablePlus）----
  // 取某列目前各欄值（含尚未套用的編輯）。
  const rowValues = (r: number): (string | null)[] =>
    data ? data.columns.map((_, j) => cellValue(r, j)) : [];

  const copyCell = (r: number, c: number) =>
    copyToClipboard(cellValue(r, c) ?? "", "已複製儲存格");
  const copyRowTsv = (r: number) =>
    copyToClipboard(rowValues(r).map((v) => v ?? "").join("\t"), "已複製整列 (TSV)");
  const copyRowJson = (r: number) => {
    if (!data) return;
    const vals = rowValues(r);
    const obj = Object.fromEntries(data.columns.map((c, j) => [c, vals[j] ?? null]));
    copyToClipboard(JSON.stringify(obj, null, 2), "已複製整列 (JSON)");
  };
  const copyRowInsert = (r: number) => {
    if (!data) return;
    // 共用 sql.ts 的跨資料庫跳脫（PostgreSQL 雙引號、其餘反引號；字面值單引號轉義）。
    const k = connKind ?? "mysql";
    const cols = data.columns.map((c) => quoteIdent(k, c)).join(", ");
    const lits = rowValues(r).map((v) => sqlLiteral(k, v)).join(", ");
    copyToClipboard(`INSERT INTO ${quoteIdent(k, tab.table)} (${cols}) VALUES (${lits});`, "已複製為 INSERT");
  };
  // 由某列產生 UPDATE / DELETE（需主鍵定位）。
  const pkValuesOf = (r: number): (string | null)[] =>
    data ? data.primary_key.map((pk) => cellValue(r, data.columns.indexOf(pk))) : [];
  const copyRowUpdate = (r: number) => {
    if (!data) return;
    const k = connKind ?? "mysql";
    copyToClipboard(
      buildRowUpdate(k, tab.table, data.columns, rowValues(r), data.primary_key, pkValuesOf(r)),
      "已複製為 UPDATE",
    );
  };
  const copyRowDelete = (r: number) => {
    if (!data) return;
    const k = connKind ?? "mysql";
    copyToClipboard(buildRowDelete(k, tab.table, data.primary_key, pkValuesOf(r)), "已複製為 DELETE");
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
  const colStats = async (col: string) => {
    try {
      const s = await api.columnStats(tab.connId, tab.database, tab.table, col);
      const range = s.min !== null || s.max !== null ? ` · 範圍 [${s.min ?? "?"}, ${s.max ?? "?"}]` : "";
      toast.info(`欄位「${col}」：${s.total} 列 · ${s.non_null} 非空 · ${s.distinct} 相異值${range}`);
    } catch (e: any) {
      toast.error(e?.message ?? "取得欄位統計失敗");
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
      ["檢視內容…", () => setInspect({ r, c }), false],
      ["複製值", () => copyCell(r, c), false],
      // 右鍵落在框選範圍內：提供整塊複製（滑鼠路徑，與 Ctrl+C 一致）。
      ...(rangeEnd && inRange(r, c)
        ? [["複製範圍 (TSV)", () => copyRange(), false] as [string, () => void, boolean]]
        : []),
      ["複製整列 (JSON)", () => copyRowJson(r), false],
      ["複製整列 (TSV)", () => copyRowTsv(r), false],
      // INSERT 範本僅對 SQL 資料庫有意義（Mongo 用 JSON）。
      ...(isSqlKind ? [["複製為 INSERT", () => copyRowInsert(r), false] as [string, () => void, boolean]] : []),
      // UPDATE / DELETE 範本需主鍵定位。
      ...(isSqlKind && editable
        ? [
            ["複製為 UPDATE", () => copyRowUpdate(r), false] as [string, () => void, boolean],
            ["複製為 DELETE", () => copyRowDelete(r), false] as [string, () => void, boolean],
          ]
        : []),
      "sep",
      ["篩選此值", () => filterByCell(r, c, false), false],
      ["排除此值", () => filterByCell(r, c, true), false],
    ];
    if (editable) {
      items.push(
        "sep",
        ["編輯儲存格", () => openEditor(r, c), false],
        ["設為 NULL", () => commitEdit(r, c, "", true), false]
      );
      // 框選範圍內：整塊設 NULL（滑鼠路徑，與 Delete 一致）。
      if (rangeEnd && inRange(r, c)) items.push(["範圍設為 NULL", () => nullRange(), false]);
      // 此格有待套用編輯時，提供單格還原（不影響其他待套用編輯）。
      if (`${r}:${c}` in edits) items.push(["還原此格", () => revertCell(r, c), false]);
      items.push(
        ["以此列為範本新增…", () => duplicateRow(r), false],
        ["刪除此列", () => deleteRow(r), true]
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
    copyToClipboard(rectToTsv((rr, cc) => cellValue(rr, cc), rows, b.cols), `已複製 ${rows.length}×${b.cols.length} 區塊 (TSV)`);
  };
  const nullRange = () => {
    const b = rangeBounds();
    if (!b) return;
    for (let rr = b.r1; rr <= b.r2; rr++) for (const cc of b.cols) commitEdit(rr, cc, "", true);
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
                toast.success(`已填入 ${n} 格`);
              } else {
                commitEdit(baseR, baseC, v, false);
                toast.success("已貼上到儲存格");
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
            toast.success(`已貼上 ${applied} 格（待套用）`);
          })
          .catch(() => toast.error("無法讀取剪貼簿"));
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
    const nv = await uiPrompt("輸入新的鍵名：", {
      title: "重新命名鍵", defaultValue: key, confirmText: "重新命名",
    });
    if (nv === null || nv.trim() === "" || nv === key) return;
    setApplying(true);
    setErr(null);
    try {
      await api.keyEdit(tab.connId, tab.database, key, { action: "rename", new_key: nv });
      toast.success("已重新命名");
      refresh();
    } catch (e: any) {
      const msg = e?.message ?? "重新命名失敗";
      setErr(msg);
      toast.error(msg); // 樹狀模式未掛載網格的錯誤橫幅，改用 toast 確保可見
    } finally {
      setApplying(false);
    }
  };

  const setKeyTtl = async (key: string, current: string | null) => {
    const v = await uiPrompt("TTL 秒數（-1 表示永不過期）：", {
      title: "設定 TTL", defaultValue: current ?? "-1", confirmText: "套用",
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
      toast.success("已設定 TTL");
      refresh();
    } catch (e: any) {
      const msg = e?.message ?? "設定 TTL 失敗";
      setErr(msg);
      toast.error(msg);
    } finally {
      setApplying(false);
    }
  };

  // 依鍵名刪除（鍵樹與右鍵選單共用，不需網格列索引）。
  const deleteKey = async (key: string) => {
    if (!(await uiConfirm(`確定刪除鍵「${key}」？此動作無法復原。`, { title: "刪除鍵", danger: true, confirmText: "刪除" }))) return;
    setApplying(true);
    setErr(null);
    try {
      await api.deleteRow(tab.connId, tab.database, tab.table, { pk_columns: ["key"], pk_values: [key] });
      toast.success("已刪除");
      refresh();
    } catch (e: any) {
      const msg = e?.message ?? "刪除失敗";
      setErr(msg);
      toast.error(msg);
    } finally {
      setApplying(false);
    }
  };

  // 切換頁面前，若有未套用的變更先確認（避免靜默丟失編輯）。
  const navPage = async (target: number) => {
    if (dirtyCount > 0 && !(await uiConfirm("有未套用的變更，切換頁面將放棄。確定？", { title: "放棄變更", danger: true, confirmText: "放棄並切換" }))) return;
    setPage(target);
  };
  // 變更每頁列數同樣會重載並丟棄編輯，故套用相同的未套用變更確認。
  const changePageSize = async (n: number) => {
    if (dirtyCount > 0 && !(await uiConfirm("有未套用的變更，變更每頁列數將放棄。確定？", { title: "放棄變更", danger: true, confirmText: "放棄並變更" }))) return;
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
                title={v === "tree" ? "命名空間樹狀檢視（依 : 分組）" : "鍵列表（網格）"}
                className={`px-2 py-1 inline-flex items-center gap-1 ${redisView === v ? "bg-fg/15 text-fg" : "text-fg/50 hover:bg-fg/5"}`}
              >
                {v === "tree"
                  ? <><Icon icon={ListTree} size={14} /> 樹狀</>
                  : <><Icon icon={Table2} size={14} /> 網格</>}
              </button>
            ))}
          </div>
        )}
        {isRedis && (
          <>
            <button type="button" onClick={() => setShowNewKey(true)} title="新增鍵（String/List/Set/Hash/ZSet）"
              className="px-2 py-1 rounded hover:bg-fg/10 text-emerald-300 inline-flex items-center gap-1"><Icon icon={Plus} size={14} /> 新增鍵</button>
            <button type="button" onClick={() => setShowStatus(true)} title="伺服器狀態（INFO，可自動刷新）"
              className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={BarChart3} size={14} /> 狀態</button>
            <button type="button" onClick={() => setShowPubSub(true)} title="Pub/Sub 訂閱與發佈"
              className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={Network} size={14} /> Pub/Sub</button>
            <button type="button" onClick={() => setShowOps(true)} title="維運：慢查詢 / 用戶端 / 大鍵"
              className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={Settings} size={14} /> 維運</button>
            <button type="button" onClick={() => setShowConsole(true)} title="Redis 命令列"
              className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={Terminal} size={14} /> 命令列</button>
            <div className="w-px h-4 bg-fg/10 mx-1" />
          </>
        )}
        <button
          onClick={async () => {
            if (dirtyCount > 0 && !(await uiConfirm("有未套用的變更，重新整理將放棄。確定？", { title: "放棄變更", danger: true, confirmText: "放棄並重整" }))) return;
            load();
          }}
          disabled={loading}
          title="重新整理（重新讀取目前頁）"
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 disabled:opacity-40 disabled:hover:bg-transparent inline-flex items-center gap-1"
        >
          <Icon icon={RefreshCw} size={14} className={loading ? "animate-spin" : ""} /> {loading ? "讀取中…" : "重新整理"}
        </button>
        <button
          onClick={() => setShowFind((s) => !s)}
          title="在目前頁即時尋找（Ctrl+F）"
          className={`px-2 py-1 rounded hover:bg-fg/10 inline-flex items-center gap-1 ${find ? "text-yellow-300" : "text-fg/50"}`}
        >
          <Icon icon={Search} size={14} /> 尋找
        </button>
        <button
          onClick={() => setShowFilter((s) => !s)}
          className={`px-2 py-1 rounded hover:bg-fg/10 inline-flex items-center gap-1 ${
            filters.length ? "text-amber-300" : "text-fg/50"
          }`}
        >
          <Icon icon={Filter} size={14} /> 篩選{filters.length ? `（${filters.length}）` : ""}
        </button>
        <button
          onClick={() => insertable && setInserting(true)}
          disabled={!insertable}
          title={insertable ? "新增列" : "無欄位可新增"}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 disabled:opacity-30 disabled:hover:bg-transparent inline-flex items-center gap-1"
        >
          <Icon icon={Plus} size={14} /> 新增列
        </button>
        {editable && marked.size > 0 && (
          <button
            onClick={bulkDelete}
            disabled={applying}
            title="刪除已勾選的列"
            className="px-2 py-1 rounded hover:bg-red-500/20 text-red-300 disabled:opacity-30 inline-flex items-center gap-1"
          >
            <Icon icon={Trash2} size={14} /> 刪除選取（{marked.size}）
          </button>
        )}
        {sorts.length > 0 && (
          <button
            type="button"
            onClick={async () => { if (await guardDiscard()) setSorts([]); }}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 inline-flex items-center gap-1"
          >
            <Icon icon={ArrowUpDown} size={14} /> 清除排序
          </button>
        )}
        <button
          onClick={() => data && data.columns.length > 0 && setExporting(true)}
          disabled={!data || data.columns.length === 0}
          title="匯出資料（CSV / TSV / JSON / SQL / Markdown）"
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 disabled:opacity-30 disabled:hover:bg-transparent inline-flex items-center gap-1"
        >
          <Icon icon={Download} size={14} /> 匯出
        </button>
        {isSqlKind && (
          <button
            type="button"
            onClick={() => setImporting(true)}
            title="從 CSV 匯入資料到此表"
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50 inline-flex items-center gap-1"
          >
            <Icon icon={Upload} size={14} /> 匯入
          </button>
        )}
        {hidden.length > 0 && (
          <button
            type="button"
            onClick={showAllColumns}
            title={`已隱藏 ${hidden.length} 欄，點此全部顯示`}
            className="ml-auto px-2 py-1 rounded hover:bg-fg/10 text-fg/50 inline-flex items-center gap-1"
          >
            <Icon icon={Columns3} size={14} /> 已隱藏 {hidden.length} 欄
          </button>
        )}
      </div>

      {showFind && data && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-well border-b border-fg/10 text-xs">
          <input autoFocus value={find} onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setShowFind(false); setFind(""); } }}
            placeholder="在目前頁即時尋找…"
            className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent min-w-[220px]" />
          <span className="text-fg/40">{findLower ? `${matchCount} 格符合` : ""}</span>
          <button type="button" onClick={() => { setShowFind(false); setFind(""); }}
            aria-label="關閉尋找" title="關閉尋找"
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
      <div ref={gridRef} className="at-grid flex-1 overflow-auto outline-none" tabIndex={0} onKeyDown={onGridKey}>
        {err && <div className="p-3 text-red-400 text-sm mono">{err}</div>}
        {!data && loading && !err && (
          <div className="p-6 text-fg/40 text-sm flex items-center gap-2">
            <Icon icon={RefreshCw} size={14} className="animate-spin" /> 讀取中…
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
                    <input type="checkbox" title="全選 / 取消本頁"
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
                  return (
                    <th
                      key={c}
                      scope="col"
                      tabIndex={0}
                      {...(dir ? { "aria-sort": dir === "asc" ? "ascending" : "descending" } : {})}
                      onClick={(e) => toggleSort(c, e.shiftKey)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort(c, e.shiftKey); } }}
                      onContextMenu={(e) => { e.preventDefault(); setColMenu({ col: c, ci, x: e.clientX, y: e.clientY }); }}
                      title="點擊排序；Shift+點擊可多欄排序；右鍵更多"
                      style={{ width: colWidth(c) }}
                      className="relative text-left px-3 py-1.5 border-b border-fg/10 font-medium whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer select-none hover:bg-fg/5 focus-visible:outline-2 focus-visible:outline-accent/60 focus-visible:-outline-offset-2"
                    >
                      {c}
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
                        title="拖曳調整欄寬；雙擊自動符合內容"
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
                <tr
                  key={i}
                  className={`${selected?.r === i ? "bg-accent/[0.06]" : "hover:bg-fg/5"} group`}
                  onContextMenu={isRedis && keyIdx >= 0 ? (e) => {
                    const key = row[keyIdx];
                    if (key == null) return;
                    e.preventDefault();
                    setRowMenu({
                      key,
                      ttl: ttlIdx >= 0 ? row[ttlIdx] : null,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  } : undefined}
                >
                  {editable && (
                    <td className="px-1 py-1 border-b border-fg/5 text-center">
                      <input type="checkbox" title="勾選以批次刪除"
                        checked={marked.has(i)} onChange={() => toggleMark(i)} />
                    </td>
                  )}
                  <td
                    onClick={() => setRowDetail(i)}
                    title="檢視整列"
                    className={`px-3 py-1 border-b border-fg/5 cursor-pointer hover:bg-fg/5 hover:text-fg/60 tabular-nums ${
                      marked.has(i) ? "text-red-300 bg-red-500/10" : selected?.r === i ? "text-accent/90" : "text-fg/30"
                    }`}
                  >
                    {startRow + i + 1}
                  </td>
                  {row.map((_, j) => {
                    const colName = data.columns[j];
                    if (isHidden(colName)) return null;
                    const key = `${i}:${j}`;
                    const isEditing = editing?.r === i && editing?.c === j;
                    const val = cellValue(i, j);
                    const dirty = key in edits;
                    // Redis 的 key 欄：雙擊開鍵詳情；其餘照常（ttl 可編輯）
                    const redisKeyCol = isRedis && colName === "key";
                    return (
                      <td
                        key={j}
                        onClick={(e) => {
                          // Shift+點選：以目前選取格為錨點框選矩形範圍（Ctrl+C 整塊複製）；一般點選則重置為單格。
                          if (e.shiftKey && selected) setRangeEnd({ r: i, c: j });
                          else { setSelected({ r: i, c: j }); setRangeEnd(null); }
                          (e.currentTarget.closest(".at-grid") as HTMLElement | null)?.focus();
                        }}
                        onDoubleClick={() => {
                          if (redisKeyCol) setDetailKey(val);
                          else if (editable) openEditor(i, j);
                        }}
                        onContextMenu={
                          isRedis
                            ? undefined
                            : (e) => {
                                e.preventDefault();
                                setSelected({ r: i, c: j });
                                setCellMenu({ r: i, c: j, x: e.clientX, y: e.clientY });
                              }
                        }
                        title={redisKeyCol ? "雙擊檢視鍵內容" : val ?? "NULL"}
                        className={`px-3 py-1 border-b border-fg/5 whitespace-nowrap overflow-hidden text-ellipsis ${
                          selected?.r === i && selected?.c === j ? "ring-1 ring-inset ring-accent " : ""
                        }${
                          dirty ? "bg-amber-500/15" : selected?.r === i && selected?.c === j ? "bg-accent/15" : inRange(i, j) ? "bg-accent/10" : ""
                        } ${redisKeyCol ? "cursor-pointer text-blue-300" : editable ? "cursor-cell" : ""}`}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={val}
                            seed={editSeed}
                            onCommit={(raw, setNull) => commitEdit(i, j, raw, setNull)}
                            onCancel={() => setEditing(null)}
                            onAdvance={(dir) => advanceCell(i, j, dir)}
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
                        onClick={() => deleteRow(i)}
                        title="刪除此列"
                        className="w-5 h-5 inline-flex items-center justify-center rounded text-fg/20 group-hover:text-red-400 hover:bg-red-500/20"
                      >
                        <Icon icon={Minus} size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.columns.length > 0 && data.rows.length === 0 && (
          <EmptyState
            compact
            icon={filters.length ? Filter : Table2}
            title={filters.length ? "無符合篩選的資料" : "此表沒有資料"}
            action={
              filters.length ? (
                <Button variant="secondary" size="sm" icon={X} onClick={() => setFilters([])}>
                  清除篩選
                </Button>
              ) : insertable ? (
                <Button variant="secondary" size="sm" icon={Plus} onClick={() => setInserting(true)}>
                  新增資料列
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      {/* 底部導覽列（Navicat 手感） */}
      <div className="h-9 bg-panel border-t border-fg/10 flex items-center px-3 gap-1 text-sm">
        <NavBtn label={<Icon icon={ChevronsLeft} size={16} />} disabled={page === 0 || loading} onClick={() => navPage(0)} title="第一頁" />
        <NavBtn label={<Icon icon={ChevronLeft} size={16} />} disabled={page === 0 || loading} onClick={() => navPage(page - 1)} title="上一頁" />
        <span className="px-1 text-fg/60 mono text-xs flex items-center gap-1">
          <input
            key={page}
            defaultValue={page + 1}
            title="輸入頁碼後按 Enter 跳頁"
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const n = parseInt((e.target as HTMLInputElement).value, 10);
              if (Number.isFinite(n) && n >= 1 && n <= totalPages && n - 1 !== page) navPage(n - 1);
            }}
            className="w-10 bg-inset border border-fg/10 rounded px-1 py-0.5 text-xs text-center outline-none focus:border-accent"
          />
          / {totalPages}
        </span>
        <NavBtn label={<Icon icon={ChevronRight} size={16} />} disabled={page + 1 >= totalPages || loading} onClick={() => navPage(page + 1)} title="下一頁" />
        <NavBtn label={<Icon icon={ChevronsRight} size={16} />} disabled={page + 1 >= totalPages || loading} onClick={() => navPage(totalPages - 1)} title="最後一頁" />
        <select
          value={pageSize}
          onChange={(e) => changePageSize(Number(e.target.value))}
          title="每頁列數"
          className="ml-2 bg-inset border border-fg/10 rounded px-1.5 py-0.5 text-xs outline-none focus:border-accent text-fg/60"
        >
          {[100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>{n} / 頁</option>
          ))}
        </select>

        <div className="w-px h-4 bg-fg/10 mx-2" />
        <button
          onClick={applyEdits}
          disabled={dirtyCount === 0 || applying}
          title="套用變更"
          className="h-6 px-2 flex items-center gap-1 rounded text-xs bg-green-600/80 hover:bg-green-600 disabled:opacity-25 disabled:bg-transparent disabled:hover:bg-transparent"
        >
          <Icon icon={Check} size={14} /> 套用{dirtyCount > 0 ? `（${dirtyCount}）` : ""}
        </button>
        <button
          onClick={() => { setEdits({}); setEditing(null); }}
          disabled={dirtyCount === 0 || applying}
          title="捨棄變更"
          className="h-6 px-2 flex items-center gap-1 rounded text-xs hover:bg-fg/10 disabled:opacity-25 disabled:hover:bg-transparent"
        >
          <Icon icon={X} size={14} /> 捨棄
        </button>

        {/* 框選範圍統計 / 單一選取格資訊（Excel 狀態列手感） */}
        {selectionStats ? (
          <span className="ml-auto mr-3 text-fg/45 text-xs mono whitespace-nowrap" title="框選範圍統計（含待套用編輯值）">
            已選 {selectionStats.rows}×{selectionStats.colsN}（{selectionStats.count} 格）
            {selectionStats.numCount > 0 &&
              ` · 數值 ${selectionStats.numCount} · Σ ${fmtNum(selectionStats.sum)} · 平均 ${fmtNum(selectionStats.avg)}`}
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
            ? "處理中…"
            : data
            ? `顯示 ${data.rows.length ? startRow + 1 : 0}–${startRow + data.rows.length} · 共 ${data.total_rows} 列${editable ? "" : " · 無主鍵唯讀"}`
            : loading
            ? "讀取中…"
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
                ["檢視內容", () => setDetailKey(rowMenu.key), false],
                ["複製鍵名", () => copyToClipboard(rowMenu.key, "已複製鍵名"), false],
                ["重新命名…", () => renameKey(rowMenu.key), false],
                ["設定 TTL…", () => setKeyTtl(rowMenu.key, rowMenu.ttl), false],
                ["刪除", () => deleteKey(rowMenu.key), true],
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
                ["升冪排序 ▲", async () => { if (await guardDiscard()) { setPage(0); setSorts([{ column: colMenu.col, dir: "asc" }]); } }],
                ["降冪排序 ▼", async () => { if (await guardDiscard()) { setPage(0); setSorts([{ column: colMenu.col, dir: "desc" }]); } }],
                ...(sorts.length ? [["清除排序", async () => { if (await guardDiscard()) setSorts([]); }] as [string, () => void]] : []),
                ["自動符合寬度", () => autoFitColumn(colMenu.col, colMenu.ci)],
                ["複製欄名", () => copyToClipboard(colMenu.col, "已複製欄名")],
                ["複製整欄（本頁）", () => copyToClipboard(data.rows.map((_, ri) => cellValue(ri, colMenu.ci) ?? "").join("\n"), "已複製整欄")],
                ...(isSqlKind ? [["欄位統計（總數/非空/相異）", () => colStats(colMenu.col)] as [string, () => void]] : []),
                ["隱藏此欄", () => hideColumn(colMenu.col)],
                ...(hidden.length ? [["顯示所有欄", () => showAllColumns()] as [string, () => void]] : []),
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
  useModalCount(); // 開啟期間讓全域快捷鍵（Ctrl+W/Tab、"/"）讓路，不在背後動作
  // 記錄瀏覽器鍵盤：↑/PageUp 上一列、↓/PageDown 下一列、Esc 關閉（編輯欄位時方向鍵交給輸入框）。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      const t = e.target as HTMLElement | null;
      const inField = t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || !!t?.isContentEditable;
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
          <span className="font-medium">第 {rowNo} 列</span>
          <span className="text-fg/30 text-xs">{columns.length} 欄{editable ? "（可編輯）" : "（唯讀）"}</span>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" disabled={!hasPrev} onClick={onPrev} title="上一列"
              className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-fg/10 disabled:opacity-30"><Icon icon={ArrowUp} size={14} /></button>
            <button type="button" disabled={!hasNext} onClick={onNext} title="下一列"
              className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-fg/10 disabled:opacity-30"><Icon icon={ArrowDown} size={14} /></button>
            <button type="button" onClick={onClose} aria-label="關閉" title="關閉" className="ml-1 text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
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
        title="設為 NULL" className="text-[10px] text-fg/40 hover:text-fg/70 shrink-0">NULL</button>
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
  const [text, setText] = useState(value ?? "");
  const dirty = editable && text !== (value ?? "");
  useModalOverlay(onClose); // 計入 modalCount + 視窗層級 Esc（不再僅靠 textarea 聚焦才能 Esc）
  const formatJson = () => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      toast.error("不是有效的 JSON");
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
            title="字元數 / UTF-8 位元組數（位元組數對應多數資料庫的 VARCHAR 長度上限）">
            {text.length} 字元 · {new TextEncoder().encode(text).length} bytes
          </span>
          <button type="button" onClick={onClose} aria-label="關閉" title="關閉" className="text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
        </div>
        <div className="p-4 flex-1 overflow-auto">
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)}
            readOnly={!editable} title={editable ? "儲存格內容（Ctrl+Enter 套用）" : "儲存格內容"}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && editable && dirty) { e.preventDefault(); onSave(text, false); onClose(); }
            }}
            className="w-full h-72 bg-inset border border-fg/10 rounded p-3 mono text-sm outline-none focus:border-accent resize-none break-all" />
        </div>
        <div className="px-5 py-3 border-t border-fg/10 flex items-center gap-2">
          {showFormat && (
            <button type="button" onClick={formatJson}
              className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">格式化 JSON</button>
          )}
          <button type="button" onClick={() => copyToClipboard(text, "已複製")}
            className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">複製</button>
          <div className="ml-auto flex gap-2">
            {editable && (
              <button type="button" onClick={() => { onSave("", true); onClose(); }}
                className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5 text-fg/70">設為 NULL</button>
            )}
            {editable && (
              <button type="button" disabled={!dirty} onClick={() => { onSave(text, false); onClose(); }}
                title="套用變更 (Ctrl+Enter)"
                className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">套用變更</button>
            )}
            <button type="button" onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">關閉</button>
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
      .catch((e) => setErr(e?.message ?? "讀取失敗"))
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
      .catch((e) => !cancelled && setErr(e?.message ?? "讀取失敗"))
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
      .catch((e) => setErr(e?.message ?? "讀取失敗"))
      .finally(() => setLoading(false));
  };

  // 編輯後重載：保留目前過濾、回到第一頁。
  const reload = () => loadFirst(filter);
  const applyFilter = () => setFilter(filterInput.trim());

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
                TTL: {page.ttl < 0 ? "無到期" : `${page.ttl}s`}
              </span>
              {isCollection && page.total >= 0 && (
                <span className="text-xs text-fg/35">共 {page.total} 筆</span>
              )}
            </>
          )}
          <button type="button" onClick={onClose} aria-label="關閉" title="關閉" className="ml-auto text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
        </div>

        {/* 成員過濾（僅集合型）。Enter 或「套用」重載第一頁。 */}
        {isCollection && (
          <div className="px-4 py-2 border-b border-fg/10 flex items-center gap-2 text-xs">
            <input value={filterInput} onChange={(e) => setFilterInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyFilter(); }}
              placeholder={page!.type_ === "hash" ? "過濾 field（支援 * ?）" : page!.type_ === "list" ? "過濾子字串" : "過濾成員（支援 * ?）"}
              className="flex-1 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent" />
            <button type="button" onClick={applyFilter}
              className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60">套用</button>
            {filter && (
              <button type="button" onClick={() => { setFilterInput(""); setFilter(""); }}
                className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/40">清除</button>
            )}
          </div>
        )}

        <div className="p-4 overflow-auto">
          {err && <div className="text-red-400 text-sm mono mb-2 break-all">{err}</div>}
          {!page && !err && <div className="text-fg/40 text-sm">讀取中…</div>}
          {detail && (
            <KeyDetailBody
              detail={detail}
              connId={connId}
              database={database}
              table={table}
              rkey={rkey}
              reload={reload}
              onError={setErr}
            />
          )}
          {isCollection && (
            <div className="mt-3 flex items-center gap-3 text-xs text-fg/40">
              <span>已載入 {members.length} 筆{filter ? "（已過濾）" : ""}</span>
              {cursor !== 0 && (
                <button type="button" onClick={loadMore} disabled={loading}
                  className="px-3 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 disabled:opacity-40">
                  {loading ? "載入中…" : "載入更多"}
                </button>
              )}
              {cursor === 0 && members.length > 0 && <span className="text-fg/25">已全部載入</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KeyDetailBody({ detail, connId, database, table, rkey, reload, onError }: {
  detail: KeyDetail;
  connId: string; database: string; table: string; rkey: string;
  reload: () => void;
  onError: (msg: string | null) => void;
}) {
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
      onError(e?.message ?? "操作失敗");
    } finally {
      setBusy(false);
    }
  };
  const edit = (e: KeyEdit) => run(() => api.keyEdit(connId, database, rkey, e));

  if (type_ === "none") {
    return <div className="text-fg/40 text-sm">（此鍵已不存在）</div>;
  }

  if (type_ === "string") {
    return (
      <StringEditor
        value={entries[0] ?? ""}
        busy={busy}
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
                前端
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
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  if (!editing) {
    return (
      <span onClick={() => { setText(value); setEditing(true); }} title="點擊編輯"
        className="cursor-text hover:bg-fg/10 rounded px-1 -mx-1 inline-block min-w-[2rem]">
        {value === "" ? <span className="text-fg/25">（空）</span> : value}
      </span>
    );
  }
  return (
    <input autoFocus type={type} value={text}
      aria-label="編輯值"
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

function StringEditor({ value, onSave, busy }: {
  value: string; onSave: (v: string) => void; busy: boolean;
}) {
  const [text, setText] = useState(value);
  const [view, setView] = useState<ValueView>("raw");
  useEffect(() => setText(value), [value]);

  const prettyJson = tryPrettyJson(text);
  const isJson = prettyJson !== null;

  return (
    <div className="space-y-2">
      {/* 檢視模式：原始（可編輯）/ JSON 美化 / Hex。 */}
      <div className="flex items-center gap-1 text-xs">
        {(["raw", "json", "hex"] as ValueView[]).map((v) => (
          <button key={v} type="button" onClick={() => setView(v)}
            className={`px-2 py-0.5 rounded ${view === v ? "bg-fg/15 text-fg" : "text-fg/45 hover:bg-fg/10"}`}>
            {v === "raw" ? "原始" : v === "json" ? "JSON" : "Hex"}
          </button>
        ))}
        {view === "json" && isJson && (
          <button type="button" onClick={() => setText(prettyJson!)} disabled={busy}
            title="把美化後的 JSON 回填到編輯區（切到「原始」後可儲存）"
            className="ml-auto px-2 py-0.5 rounded border border-fg/15 hover:bg-fg/10 text-fg/55">回填美化結果</button>
        )}
        <span className="ml-auto text-fg/30">{byteLen(text)} bytes</span>
      </div>

      {view === "raw" && (
        <textarea value={text} onChange={(e) => setText(e.target.value)} title="字串值"
          className="w-full h-40 bg-inset border border-fg/10 rounded p-3 mono text-sm outline-none focus:border-accent resize-none break-all" />
      )}
      {view === "json" && (
        <pre className="w-full h-40 overflow-auto bg-inset border border-fg/10 rounded p-3 mono text-sm whitespace-pre-wrap break-all">
          {isJson ? prettyJson : <span className="text-fg/35">（非有效 JSON）</span>}
        </pre>
      )}
      {view === "hex" && (
        <pre className="w-full h-40 overflow-auto bg-inset border border-fg/10 rounded p-3 mono text-xs whitespace-pre">
          {toHexDump(text)}
        </pre>
      )}

      <div className="flex justify-end">
        <button type="button" disabled={busy || text === value || view !== "raw"} onClick={() => onSave(text)}
          title={view !== "raw" ? "切到「原始」模式才能儲存" : "儲存"}
          className="px-3 py-1 text-sm rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">
          {busy ? "儲存中…" : "儲存"}
        </button>
      </div>
    </div>
  );
}

// JSON 美化：可解析則回傳縮排字串，否則 null。
function tryPrettyJson(s: string): string | null {
  const t = s.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; }
}

// UTF-8 位元組長度。
function byteLen(s: string): number {
  try { return new TextEncoder().encode(s).length; } catch { return s.length; }
}

// 經典 hex dump：每列 16 位元組，左偏移、中段 hex、右側可列印字元。
function toHexDump(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length === 0) return "（空）";
  const max = 8192; // 避免超長字串卡渲染
  const view = bytes.subarray(0, max);
  const lines: string[] = [];
  for (let off = 0; off < view.length; off += 16) {
    const chunk = view.subarray(off, off + 16);
    const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(16 * 3 - 1, " ");
    const ascii = Array.from(chunk).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  if (bytes.length > max) lines.push(`… 已截斷，共 ${bytes.length} bytes`);
  return lines.join("\n");
}

function DelCell({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <td className="px-1 py-1 border-b border-fg/5 text-center">
      <button type="button" onClick={onClick} disabled={busy} title="刪除"
        className="w-5 h-5 inline-flex items-center justify-center rounded text-fg/20 group-hover:text-red-400 hover:bg-red-500/20 disabled:opacity-30">
        <Icon icon={Minus} size={14} />
      </button>
    </td>
  );
}

function AddCell({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <td className="px-1 py-1 text-center">
      <button type="button" onClick={onClick} disabled={busy} title="新增"
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
          <span>符合</span>
          {([["false", "全部 (AND)"], ["true", "任一 (OR)"]] as [string, string][]).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setAny(v === "true")}
              className={`px-2 py-0.5 rounded border ${
                any === (v === "true") ? "border-accent bg-accent/15 text-accent" : "border-fg/10 text-fg/50"
              }`}>
              {label}
            </button>
          ))}
          <span>條件</span>
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <select value={r.column} title="篩選欄位" onChange={(e) => update(i, { column: e.target.value })}
            className="bg-inset border border-fg/10 rounded px-1.5 py-1 outline-none">
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={r.op} title="運算子" onChange={(e) => update(i, { op: e.target.value })}
            className="bg-inset border border-fg/10 rounded px-1.5 py-1 outline-none">
            {FILTER_OPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          {opNeedsValue(r.op) && (
            <input value={r.value ?? ""} onChange={(e) => update(i, { value: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder={r.op === "like" ? "%關鍵字%" : "值"}
              className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent min-w-[140px]" />
          )}
          <button onClick={() => removeRow(i)} disabled={rows.length === 1}
            title="移除此條件"
            className="px-1.5 py-1 inline-flex items-center justify-center rounded hover:bg-fg/10 text-fg/40 disabled:opacity-30">
            <Icon icon={Minus} size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-0.5">
        <button onClick={addRow}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"><Icon icon={Plus} size={14} /> 新增條件</button>
        <button onClick={apply}
          className="px-2 py-1 rounded bg-accent text-white hover:bg-accent/90">套用</button>
        <button onClick={clear}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/50">清除</button>
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
        <div className="px-5 py-3 border-b border-fg/10 font-medium text-sm">新增列</div>
        <div className="p-4 space-y-2 overflow-y-auto">
          <p className="text-xs text-fg/40">未填寫且未標 NULL 的欄位，交由資料庫預設值處理。</p>
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
                placeholder={nulls[c] ? "NULL" : "（預設）"}
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
            className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5">取消</button>
          <button type="button" onClick={submit} disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">
            {busy ? "新增中…" : "新增"}
          </button>
        </div>
      </div>
    </div>
  );
}

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
        aria-label="編輯儲存格"
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
        title="設為 NULL"
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
  const kind = useStore((s) => s.connections.find((c) => c.id === tab.connId)?.kind);
  const isSql = kind === "mysql" || kind === "postgres" || kind === "sqlite";
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

  const viewDdl = async () => {
    try {
      setDdl(await api.tableDdl(tab.connId, tab.database, tab.table));
    } catch (e: any) {
      toast.error(e?.message ?? "取得建表 SQL 失敗");
    }
  };

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    api
      .tableColumns(tab.connId, tab.database, tab.table)
      .then((c) => !cancelled && setCols(c))
      .catch((e) => !cancelled && setErr(e?.message ?? "讀取失敗"));
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
    return () => {
      cancelled = true;
    };
  }, [tab.connId, tab.database, tab.table, nonce]);

  const doAlter = async (op: AlterOp, okMsg: string) => {
    setBusy(true);
    try {
      await api.alterTable(tab.connId, tab.database, tab.table, op);
      toast.success(okMsg);
      setAdding(false);
      setRename(null);
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? "結構變更失敗");
    } finally {
      setBusy(false);
    }
  };

  const dropCol = async (name: string) => {
    if (!(await uiConfirm(`刪除欄位「${name}」？此動作無法復原。`, { title: "刪除欄位", danger: true, confirmText: "刪除" }))) return;
    doAlter({ op: "drop_column", name }, "欄位已刪除");
  };
  // 修改欄位型別（MySQL / PostgreSQL；SQLite 不支援）。保留目前可空性。
  const modifyType = async (name: string, currentType: string, nullable: boolean) => {
    const t = await uiPrompt("新型別", { title: `修改欄位「${name}」型別`, defaultValue: currentType, placeholder: "如 VARCHAR(100) / int / text" });
    if (!t?.trim() || t.trim() === currentType) return;
    doAlter({ op: "modify_column", name, data_type: t.trim(), nullable }, "欄位型別已修改");
  };
  // 切換欄位可空（保留型別）；改 NOT NULL 若有 NULL 值會由 DB 報錯並以 toast 呈現。
  const toggleNull = (name: string, dataType: string, nullable: boolean) =>
    doAlter({ op: "modify_column", name, data_type: dataType, nullable: !nullable }, nullable ? "已設為 NOT NULL" : "已設為可空");
  // 設定 / 清除欄位預設值（值為原樣 DDL，如 0 / 'x' / CURRENT_TIMESTAMP；清空=移除）。
  const setColDefault = async (name: string, current: string | null) => {
    const v = await uiPrompt("預設值（清空=移除預設）", { title: `欄位「${name}」預設值`, defaultValue: current ?? "", placeholder: "如 0 / 'x' / CURRENT_TIMESTAMP" });
    if (v === null) return;
    const t = v.trim();
    doAlter({ op: "set_default", name, default: t === "" ? null : t }, t === "" ? "已移除預設值" : "預設值已設定");
  };
  // 新增外鍵（MySQL / PostgreSQL；走 exec_ddl）。
  const addFk = async (name: string, column: string, refTable: string, refColumn: string, onDelete: string, onUpdate: string) => {
    if (!kind) return;
    setBusy(true);
    try {
      await api.execDdl(tab.connId, buildAddForeignKey(kind, tab.database, tab.table, name, column, refTable, refColumn, onDelete, onUpdate));
      toast.success("外鍵已新增");
      setAddingFk(false);
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? "新增外鍵失敗");
    } finally {
      setBusy(false);
    }
  };
  const dropFk = async (name: string) => {
    if (!kind) return;
    if (!(await uiConfirm(`刪除外鍵「${name}」？`, { title: "刪除外鍵", danger: true, confirmText: "刪除" }))) return;
    setBusy(true);
    try {
      await api.execDdl(tab.connId, buildDropForeignKey(kind, tab.database, tab.table, name));
      toast.success("外鍵已刪除");
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? "刪除外鍵失敗");
    } finally {
      setBusy(false);
    }
  };

  const dropIndexByName = async (name: string) => {
    if (!(await uiConfirm(`刪除索引「${name}」？`, { title: "刪除索引", danger: true, confirmText: "刪除" }))) return;
    setBusy(true);
    try {
      await api.dropIndex(tab.connId, tab.database, tab.table, name);
      toast.success("索引已刪除");
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? "刪除索引失敗");
    } finally {
      setBusy(false);
    }
  };

  // 重新命名索引（僅 MySQL / PG；SQLite 無 ALTER INDEX RENAME）。
  const renameIndexByName = async (oldName: string) => {
    if (!kind) return;
    const nn = await uiPrompt(`重新命名索引「${oldName}」為：`, { title: "重新命名索引", defaultValue: oldName, confirmText: "重新命名" });
    if (nn === null || !nn.trim() || nn.trim() === oldName) return;
    setBusy(true);
    try {
      await api.execDdl(tab.connId, buildRenameIndex(kind, tab.database, tab.table, oldName, nn));
      toast.success("索引已重新命名");
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? "重新命名索引失敗");
    } finally {
      setBusy(false);
    }
  };

  const createIndexFn = async (name: string, columns: string[], type: "normal" | "unique" | "fulltext") => {
    if (!name.trim() || columns.length === 0) { toast.error("請填索引名稱並至少選一欄"); return; }
    setBusy(true);
    try {
      if (type === "fulltext") {
        await api.execDdl(tab.connId, buildCreateFulltextIndex(tab.database, tab.table, name.trim(), columns));
      } else {
        await api.createIndex(tab.connId, tab.database, tab.table, name.trim(), columns, type === "unique");
      }
      toast.success("索引已建立");
      setAddingIndex(false);
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? "建立索引失敗");
    } finally {
      setBusy(false);
    }
  };

  if (err) return <div className="p-3 text-red-400 text-sm mono">{err}</div>;
  if (!cols) return <div className="p-3 text-fg/40 text-sm">讀取中…</div>;

  return (
    <div className="flex-1 overflow-auto">
      {isSql && (
        <div className="flex items-center gap-1 px-2 py-1 bg-inset border-b border-fg/10 text-xs">
          <button type="button" onClick={() => setAdding((s) => !s)} disabled={busy}
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40 inline-flex items-center gap-1">
            <Icon icon={Plus} size={14} /> 新增欄位
          </button>
          <button type="button" onClick={viewDdl}
            title="檢視 / 複製建表 SQL（CREATE 語句）"
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1">
            <Icon icon={Copy} size={14} /> 建表 SQL
          </button>
          <button type="button" onClick={() => setNonce((n) => n + 1)} disabled={busy}
            title="重新讀取結構（外部變更後同步）"
            className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40 inline-flex items-center gap-1">
            <Icon icon={RefreshCw} size={14} /> 重新整理
          </button>
          {busy && <span className="text-fg/40">處理中…</span>}
        </div>
      )}
      {adding && isSql && <AddColumnForm kind={kind} busy={busy} onCancel={() => setAdding(false)}
        onSubmit={(op) => doAlter(op, "欄位已新增")} />}
      <table className="text-sm border-collapse w-full">
        <thead className="sticky top-0 bg-bar">
          <tr>
            {["欄位", "型別", "可空", "鍵", "預設", "額外"].map((h) => (
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
                        doAlter({ op: "rename_column", old: c.name, new: rename.to }, "欄位已改名");
                      else if (e.key === "Escape") setRename(null);
                    }}
                    onBlur={() => setRename(null)}
                    aria-label="欄位改名"
                    className="bg-inset border border-accent/70 rounded px-1 py-0.5 outline-none focus:ring-2 focus:ring-accent/20" />
                ) : (
                  c.name
                )}
              </td>
              <td className="px-3 py-1 border-b border-fg/5 mono text-fg/70">{c.data_type}</td>
              <td className="px-3 py-1 border-b border-fg/5 text-fg/60">
                {kind !== "sqlite" ? (
                  <button type="button" disabled={busy} title="點擊切換可空 / NOT NULL"
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
                  <button type="button" disabled={busy} title="點擊設定 / 清除預設值"
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
                  <button type="button" title="改名" disabled={busy}
                    onClick={() => setRename({ col: c.name, to: c.name })}
                    className="px-1 inline-flex items-center text-fg/20 group-hover:text-fg/70 hover:bg-fg/15 rounded disabled:opacity-40"><Icon icon={Pencil} size={14} /></button>
                  {kind !== "sqlite" && (
                    <button type="button" title="修改型別" disabled={busy}
                      onClick={() => modifyType(c.name, c.data_type, c.nullable)}
                      className="px-1 text-fg/20 group-hover:text-fg/70 hover:bg-fg/15 rounded disabled:opacity-40">型</button>
                  )}
                  <button type="button" title="刪除欄位" disabled={busy}
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
            <span>索引（{indexes.length}）</span>
            {canIndex && (
              <button type="button" onClick={() => setAddingIndex((s) => !s)} disabled={busy}
                className="px-1.5 py-0.5 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40 inline-flex items-center gap-1"><Icon icon={Plus} size={14} /> 新增索引</button>
            )}
          </div>
          {addingIndex && canIndex && cols && (
            <AddIndexForm columns={cols.map((c) => c.name)} busy={busy} allowFulltext={kind === "mysql"}
              onCancel={() => setAddingIndex(false)} onSubmit={createIndexFn} />
          )}
          {indexes.length === 0 && <div className="px-3 py-2 text-fg/30 text-xs">尚無索引。</div>}
          {indexes.length > 0 && (
          <table className="text-sm border-collapse w-full">
            <thead className="bg-elevated">
              <tr>
                {["名稱", "欄位", "唯一", "主鍵"].map((h) => (
                  <th key={h} className="text-left px-3 py-1.5 border-b border-fg/10 font-medium">{h}</th>
                ))}
                {canIndex && <th className="w-12 border-b border-fg/10" />}
              </tr>
            </thead>
            <tbody>
              {indexes.map((ix) => (
                <tr key={ix.name} className="hover:bg-fg/5 group">
                  <td className="px-3 py-1 border-b border-fg/5 mono">{ix.name}</td>
                  <td className="px-3 py-1 border-b border-fg/5 mono text-fg/70">{ix.columns.join(", ")}</td>
                  <td className="px-3 py-1 border-b border-fg/5">
                    {ix.unique && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">UNIQUE</span>}
                  </td>
                  <td className="px-3 py-1 border-b border-fg/5">
                    {ix.primary && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">PK</span>}
                  </td>
                  {canIndex && (
                    <td className="px-2 py-1 border-b border-fg/5 text-right whitespace-nowrap">
                      {!ix.primary && (kind === "mysql" || kind === "postgres") && (
                        <button type="button" title="重新命名索引" disabled={busy}
                          onClick={() => renameIndexByName(ix.name)}
                          className="px-1 inline-flex items-center text-fg/20 group-hover:text-blue-400 hover:bg-blue-500/20 rounded disabled:opacity-40"><Icon icon={Pencil} size={14} /></button>
                      )}
                      {!ix.primary && (
                        <button type="button" title="刪除索引" disabled={busy}
                          onClick={() => dropIndexByName(ix.name)}
                          className="px-1 inline-flex items-center text-fg/20 group-hover:text-red-400 hover:bg-red-500/20 rounded disabled:opacity-40"><Icon icon={Minus} size={14} /></button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      )}

      {/* 外鍵區（取自 ER 模型；致敬商用工具的結構檢視） */}
      {isSql && !isView && fks && (fks.length > 0 || kind !== "sqlite") && (
        <div className="mt-2">
          <div className="px-3 py-1.5 text-xs text-fg/40 bg-inset border-y border-fg/10 flex items-center gap-2">
            <span>外鍵（{fks.length}）</span>
            {kind !== "sqlite" && (
              <button type="button" onClick={() => setAddingFk((s) => !s)} disabled={busy}
                className="px-1.5 py-0.5 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40 inline-flex items-center gap-1"><Icon icon={Plus} size={14} /> 新增外鍵</button>
            )}
          </div>
          {addingFk && kind !== "sqlite" && cols && (
            <AddForeignKeyForm table={tab.table} columns={cols.map((c) => c.name)} busy={busy}
              onCancel={() => setAddingFk(false)} onSubmit={addFk} />
          )}
          {fks.length === 0 ? (
            <div className="px-3 py-2 text-fg/30 text-xs">尚無外鍵。</div>
          ) : (
            <table className="text-sm border-collapse w-full">
              <thead className="bg-elevated">
                <tr>
                  {["約束", "欄位", "參照", "參照欄位"].map((h) => (
                    <th key={h} className="text-left px-3 py-1.5 border-b border-fg/10 font-medium">{h}</th>
                  ))}
                  {kind !== "sqlite" && <th className="w-10 border-b border-fg/10" aria-label="操作" />}
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
                        <button type="button" title="刪除外鍵" disabled={busy} onClick={() => dropFk(fk.name)}
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
            被參照（{incomingFks.length}）
          </div>
          <table className="text-sm border-collapse w-full">
            <thead className="bg-elevated">
              <tr>
                {["來源表", "來源欄位", "參照本表欄位"].map((h) => (
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
        <CellInspector column={`${tab.table} · 建表 SQL`} value={ddl} editable={false}
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
  const [name, setName] = useState("");
  const [dataType, setDataType] = useState("");
  const [nullable, setNullable] = useState(true);
  const [def, setDef] = useState("");
  const ic = "bg-inset border border-fg/10 rounded px-2 py-1 text-sm outline-none focus:border-accent";
  // 常見型別下拉（依連線種類）；選後仍可於輸入框微調長度 / 精度（如 VARCHAR(50)）。
  const presets = (kind && TYPE_PRESETS[kind]) || [];
  const submit = () => {
    if (!name.trim() || !dataType.trim()) { toast.error("請填欄位名稱與型別"); return; }
    onSubmit({ op: "add_column", name: name.trim(), data_type: dataType.trim(), nullable, default: def.trim() || null });
  };
  return (
    <div className="flex flex-wrap items-end gap-2 px-3 py-2 bg-well border-b border-fg/10 text-xs">
      <label className="block"><span className="text-fg/50 block mb-0.5">欄位名稱</span>
        <input className={ic} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block"><span className="text-fg/50 block mb-0.5">型別</span>
        <div className="flex items-center gap-1">
          <select className={`${ic} cursor-pointer`} title="常見型別快捷"
            value={presets.includes(dataType) ? dataType : ""}
            onChange={(e) => { if (e.target.value) setDataType(e.target.value); }}>
            <option value="">選擇…</option>
            {presets.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className={`${ic} w-40`} value={dataType} onChange={(e) => setDataType(e.target.value)} placeholder="如 VARCHAR(50) / INT" />
        </div></label>
      <label className="block"><span className="text-fg/50 block mb-0.5">預設值（選填）</span>
        <input className={ic} value={def} onChange={(e) => setDef(e.target.value)} placeholder="如 0 / 'x' / CURRENT_TIMESTAMP" /></label>
      <label className="flex items-center gap-1 pb-1.5 select-none">
        <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} /> 可空
      </label>
      <button type="button" onClick={submit} disabled={busy}
        className="px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">新增</button>
      <button type="button" onClick={onCancel}
        className="px-3 py-1.5 rounded border border-fg/15 hover:bg-fg/5">取消</button>
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
      <select value={column} onChange={(e) => setColumn(e.target.value)} title="本表欄位" className={ic}>
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <span className="text-fg/40 text-xs">→</span>
      <input value={refTable} onChange={(e) => setRefTable(e.target.value)} placeholder="參照表" className={`${ic} w-28`} />
      <input value={refColumn} onChange={(e) => setRefColumn(e.target.value)} placeholder="參照欄位" className={`${ic} w-28`} />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={effName} title="約束名稱（留空自動產生）" className={`${ic} w-40`} />
      <select value={onDelete} onChange={(e) => setOnDelete(e.target.value)} title="ON DELETE" className={ic}>
        {FK_ACTIONS.map((a) => <option key={a} value={a}>{a ? `ON DELETE ${a}` : "ON DELETE（預設）"}</option>)}
      </select>
      <select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value)} title="ON UPDATE" className={ic}>
        {FK_ACTIONS.map((a) => <option key={a} value={a}>{a ? `ON UPDATE ${a}` : "ON UPDATE（預設）"}</option>)}
      </select>
      <button type="button" disabled={busy || !valid} onClick={() => onSubmit(effName, column, refTable, refColumn, onDelete, onUpdate)}
        className="px-2 py-1 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">建立</button>
      <button type="button" onClick={onCancel} className="px-2 py-1 text-xs rounded border border-fg/15 hover:bg-fg/5">取消</button>
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
  const [name, setName] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [type, setType] = useState<"normal" | "unique" | "fulltext">("normal");
  const toggle = (c: string) => setSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  const ic = "bg-inset border border-fg/10 rounded px-2 py-1 text-sm outline-none focus:border-accent";
  return (
    <div className="px-3 py-2 bg-well border-b border-fg/10 text-xs space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="text-fg/50 block mb-0.5">索引名稱</span>
          <input className={ic} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 idx_email" /></label>
        <label className="block"><span className="text-fg/50 block mb-0.5">類型</span>
          <select className={ic} value={type} onChange={(e) => setType(e.target.value as typeof type)} title="索引類型">
            <option value="normal">普通</option>
            <option value="unique">唯一</option>
            {allowFulltext && <option value="fulltext">全文 (FULLTEXT)</option>}
          </select></label>
      </div>
      <div>
        <span className="text-fg/50 block mb-1">欄位（可多選，依點選順序組複合索引）</span>
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
          className="px-3 py-1 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">建立</button>
        <button type="button" onClick={onCancel}
          className="px-3 py-1 rounded border border-fg/15 hover:bg-fg/5">取消</button>
      </div>
    </div>
  );
}
