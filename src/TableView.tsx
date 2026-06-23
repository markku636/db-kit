import { useEffect, useState } from "react";
import {
  api, ColumnInfo, ErRelation, Filter, IndexInfo, KeyDetail, KeyEdit, PagedData, RowInsert, Sort, SortDir,
} from "./api";
import { OpenTab, useStore } from "./store";
import { toast, uiConfirm, uiPrompt, copyToClipboard } from "./ui";
import { quoteIdent, sqlLiteral, buildRowUpdate, buildRowDelete } from "./sql";
import ExportDialog from "./ExportDialog";
import ImportDialog from "./ImportDialog";
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
      <div className="flex items-center gap-1 px-2 py-1 bg-[#161c25] border-b border-white/10">
        <span className="text-xs text-white/40 mr-2 pl-1">{tab.table}</span>
        {(["data", "structure"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setTabView(tab.key, v)}
            className={`text-xs px-3 py-1 rounded ${
              tab.view === v ? "bg-white/10 text-white" : "text-white/50 hover:bg-white/5"
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
  const [applying, setApplying] = useState(false);

  // 排序與篩選
  const [sorts, setSorts] = useState<Sort[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
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
  const [rowMenu, setRowMenu] = useState<{ r: number; key: string; ttl: string | null; x: number; y: number } | null>(null);

  // SQL 表的儲存格右鍵選單 / 內容檢視器 / 選取（鍵盤導覽）/「以此列為範本」預填值
  const [cellMenu, setCellMenu] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const [inspect, setInspect] = useState<{ r: number; c: number } | null>(null);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
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
    setHiddenPersist(next);
  };
  const showAllColumns = () => setHiddenPersist([]);

  // 欄位標題右鍵選單
  const [colMenu, setColMenu] = useState<{ col: string; ci: number; x: number; y: number } | null>(null);

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
        }
      })
      .catch((e) => !cancelled && setErr(e?.message ?? "讀取失敗"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  };

  useEffect(load, [tab.connId, tab.database, tab.table, page, pageSize, sorts, filters, matchAny, reloadNonce]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total_rows / pageSize)) : 1;
  const startRow = data ? page * pageSize : 0;
  const editable = !!data && data.primary_key.length > 0;
  // 新增列不需主鍵（INSERT 不依賴 PK）；只有更新 / 刪除個別列才需 PK 來定位。視圖不可插入。
  const insertable = !!data && data.columns.length > 0 && tab.objKind !== "view";
  const dirtyCount = Object.keys(edits).length;
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

  const applyEdits = async () => {
    if (!data || dirtyCount === 0) return;
    setApplying(true);
    setErr(null);
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
      }
      load();
    } catch (e: any) {
      setErr(e?.message ?? "套用失敗");
    } finally {
      setApplying(false);
    }
  };

  // 點欄位標題循環切換排序：無 → asc → desc → 無。
  // Shift+點擊：多欄排序——在既有排序上附加 / 切換 / 移除此欄（致敬 DataGrip / DBeaver）。
  const toggleSort = (col: string, additive: boolean) => {
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
    if (!(await uiConfirm("確定刪除此列？此動作無法復原。", { title: "刪除列", danger: true, confirmText: "刪除" }))) return;
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
  const filterByCell = (r: number, c: number, exclude: boolean) => {
    if (!data) return;
    const col = data.columns[c];
    const v = cellValue(r, c);
    const f: Filter =
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
        ["編輯儲存格", () => setEditing({ r, c }), false],
        ["設為 NULL", () => commitEdit(r, c, "", true), false],
        ["以此列為範本新增…", () => duplicateRow(r), false],
        ["刪除此列", () => deleteRow(r), true]
      );
    }
    return items;
  };

  // 鍵盤導覽：方向鍵 / Tab 移動選取，Enter / F2 編輯，Ctrl+C 複製，Esc 取消選取，F5 重新整理。
  const onGridKey = (e: React.KeyboardEvent) => {
    if (!data || editing) return;
    if (e.key === "F5") { e.preventDefault(); load(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) { e.preventDefault(); setShowFind(true); return; }
    if (!selected) return;
    const maxR = data.rows.length - 1;
    if (maxR < 0) return;
    let { r, c } = selected;
    const k = e.key;
    // 左右移動時跳過隱藏欄（只在可見欄之間移動）。
    const visIdx = data.columns.map((_, j) => j).filter((j) => !isHidden(data.columns[j]));
    const pos = visIdx.indexOf(c);
    if (k === "ArrowDown") r = Math.min(maxR, r + 1);
    else if (k === "ArrowUp") r = Math.max(0, r - 1);
    else if (k === "ArrowRight" || (k === "Tab" && !e.shiftKey)) {
      if (pos >= 0 && pos < visIdx.length - 1) c = visIdx[pos + 1];
    } else if (k === "ArrowLeft" || (k === "Tab" && e.shiftKey)) {
      if (pos > 0) c = visIdx[pos - 1];
    }
    else if (k === "Enter" || k === "F2") {
      if (editable) { setEditing({ r, c }); e.preventDefault(); }
      return;
    } else if (k === "Escape") { setSelected(null); return; }
    else if ((e.ctrlKey || e.metaKey) && (k === "c" || k === "C")) {
      copyCell(r, c); e.preventDefault(); return;
    } else return;
    e.preventDefault();
    setSelected({ r, c });
  };

  // ---- Redis 鍵列右鍵操作 ----
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
      load();
    } catch (e: any) {
      setErr(e?.message ?? "重新命名失敗");
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
      load();
    } catch (e: any) {
      setErr(e?.message ?? "設定 TTL 失敗");
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
      <div className="flex items-center gap-1 px-2 py-1 bg-[#10161e] border-b border-white/10 text-xs">
        <button
          onClick={async () => {
            if (dirtyCount > 0 && !(await uiConfirm("有未套用的變更，重新整理將放棄。確定？", { title: "放棄變更", danger: true, confirmText: "放棄並重整" }))) return;
            load();
          }}
          disabled={loading}
          title="重新整理（重新讀取目前頁）"
          className="px-2 py-1 rounded hover:bg-white/10 text-white/50 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {loading ? "↻ 讀取中…" : "↻ 重新整理"}
        </button>
        <button
          onClick={() => setShowFind((s) => !s)}
          title="在目前頁即時尋找（Ctrl+F）"
          className={`px-2 py-1 rounded hover:bg-white/10 ${find ? "text-yellow-300" : "text-white/50"}`}
        >
          🔍 尋找
        </button>
        <button
          onClick={() => setShowFilter((s) => !s)}
          className={`px-2 py-1 rounded hover:bg-white/10 ${
            filters.length ? "text-amber-300" : "text-white/50"
          }`}
        >
          ⧩ 篩選{filters.length ? `（${filters.length}）` : ""}
        </button>
        <button
          onClick={() => insertable && setInserting(true)}
          disabled={!insertable}
          title={insertable ? "新增列" : "無欄位可新增"}
          className="px-2 py-1 rounded hover:bg-white/10 text-white/50 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ＋ 新增列
        </button>
        {sorts.length > 0 && (
          <button
            onClick={() => setSorts([])}
            className="px-2 py-1 rounded hover:bg-white/10 text-white/50"
          >
            ⇅ 清除排序
          </button>
        )}
        <button
          onClick={() => data && data.columns.length > 0 && setExporting(true)}
          disabled={!data || data.columns.length === 0}
          title="匯出資料（CSV / TSV / JSON / SQL / Markdown）"
          className="px-2 py-1 rounded hover:bg-white/10 text-white/50 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ⬇ 匯出
        </button>
        {isSqlKind && (
          <button
            type="button"
            onClick={() => setImporting(true)}
            title="從 CSV 匯入資料到此表"
            className="px-2 py-1 rounded hover:bg-white/10 text-white/50"
          >
            ⬆ 匯入
          </button>
        )}
      </div>

      {showFind && data && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-[#0d131a] border-b border-white/10 text-xs">
          <input autoFocus value={find} onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setShowFind(false); setFind(""); } }}
            placeholder="在目前頁即時尋找…"
            className="bg-black/30 border border-white/10 rounded px-2 py-1 outline-none focus:border-blue-500 min-w-[220px]" />
          <span className="text-white/40">{findLower ? `${matchCount} 格符合` : ""}</span>
          <button type="button" onClick={() => { setShowFind(false); setFind(""); }}
            className="ml-auto px-1.5 py-1 rounded hover:bg-white/10 text-white/40">✕</button>
        </div>
      )}

      {showFilter && data && (
        <FilterBar
          columns={data.columns}
          filters={filters}
          matchAny={matchAny}
          onApply={(f, any) => { setPage(0); setMatchAny(any); setFilters(f); }}
        />
      )}

      <div className="at-grid flex-1 overflow-auto outline-none" tabIndex={0} onKeyDown={onGridKey}>
        {err && <div className="p-3 text-red-400 text-sm mono">{err}</div>}
        {data && data.columns.length > 0 && (
          <table
            className={`text-sm border-collapse transition-opacity ${loading ? "opacity-50" : ""}`}
            style={{
              tableLayout: "fixed",
              width: 48 + data.columns.filter((c) => !isHidden(c)).reduce((a, c) => a + colWidth(c), 0) + (editable ? 32 : 0),
            }}
          >
            <thead className="sticky top-0 bg-[#1a212b]">
              <tr>
                <th className="text-left px-3 py-1.5 border-b border-white/10 text-white/30 w-12">#</th>
                {data.columns.map((c, ci) => {
                  if (isHidden(c)) return null;
                  const dir = sortDirOf(c);
                  const order = sortOrderOf(c);
                  return (
                    <th
                      key={c}
                      onClick={(e) => toggleSort(c, e.shiftKey)}
                      onContextMenu={(e) => { e.preventDefault(); setColMenu({ col: c, ci, x: e.clientX, y: e.clientY }); }}
                      title="點擊排序；Shift+點擊可多欄排序；右鍵更多"
                      style={{ width: colWidth(c) }}
                      className="relative text-left px-3 py-1.5 border-b border-white/10 font-medium whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer select-none hover:bg-white/5"
                    >
                      {c}
                      {data.primary_key.includes(c) && (
                        <span className="ml-1 text-[10px] text-blue-400">PK</span>
                      )}
                      {dir && (
                        <span className="ml-1 text-[10px] text-amber-300">
                          {dir === "asc" ? "▲" : "▼"}
                          {order > 0 && <span className="ml-0.5 text-white/40">{order}</span>}
                        </span>
                      )}
                      <span
                        onPointerDown={(e) => startResize(c, e)}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(c, ci); }}
                        title="拖曳調整欄寬；雙擊自動符合內容"
                        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-500/50"
                      />
                    </th>
                  );
                })}
                {editable && <th className="w-8 border-b border-white/10" />}
              </tr>
            </thead>
            <tbody className="mono">
              {data.rows.map((row, i) => (
                <tr
                  key={i}
                  className="odd:bg-white/[0.025] hover:bg-white/5 group"
                  onContextMenu={isRedis && keyIdx >= 0 ? (e) => {
                    const key = row[keyIdx];
                    if (key == null) return;
                    e.preventDefault();
                    setRowMenu({
                      r: i,
                      key,
                      ttl: ttlIdx >= 0 ? row[ttlIdx] : null,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  } : undefined}
                >
                  <td
                    onClick={() => setRowDetail(i)}
                    title="檢視整列"
                    className="px-3 py-1 border-b border-white/5 text-white/30 cursor-pointer hover:bg-white/5 hover:text-white/60"
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
                          setSelected({ r: i, c: j });
                          (e.currentTarget.closest(".at-grid") as HTMLElement | null)?.focus();
                        }}
                        onDoubleClick={() => {
                          if (redisKeyCol) setDetailKey(val);
                          else if (editable) setEditing({ r: i, c: j });
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
                        className={`px-3 py-1 border-b border-white/5 whitespace-nowrap overflow-hidden text-ellipsis ${
                          dirty ? "bg-amber-500/15" : ""
                        } ${
                          selected?.r === i && selected?.c === j ? "ring-1 ring-inset ring-blue-500 bg-blue-500/10" : ""
                        } ${redisKeyCol ? "cursor-pointer text-blue-300" : editable ? "cursor-cell" : ""}`}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={val}
                            onCommit={(raw, setNull) => commitEdit(i, j, raw, setNull)}
                            onCancel={() => setEditing(null)}
                          />
                        ) : val === null ? (
                          <span className="text-white/30 italic">NULL</span>
                        ) : findLower ? (
                          highlight(val, findLower)
                        ) : (
                          val
                        )}
                      </td>
                    );
                  })}
                  {editable && (
                    <td className="px-1 py-1 border-b border-white/5 text-center">
                      <button
                        onClick={() => deleteRow(i)}
                        title="刪除此列"
                        className="w-5 h-5 rounded text-white/20 group-hover:text-red-400 hover:bg-red-500/20"
                      >
                        −
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.columns.length > 0 && data.rows.length === 0 && (
          <div className="p-3 text-white/40 text-sm">無符合條件的資料。</div>
        )}
      </div>

      {/* 底部導覽列（Navicat 手感） */}
      <div className="h-9 bg-[#11161d] border-t border-white/10 flex items-center px-3 gap-1 text-sm">
        <NavBtn label="⏮" disabled={page === 0 || loading} onClick={() => navPage(0)} title="第一頁" />
        <NavBtn label="◀" disabled={page === 0 || loading} onClick={() => navPage(page - 1)} title="上一頁" />
        <span className="px-1 text-white/60 mono text-xs flex items-center gap-1">
          <input
            key={page}
            defaultValue={page + 1}
            title="輸入頁碼後按 Enter 跳頁"
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const n = parseInt((e.target as HTMLInputElement).value, 10);
              if (Number.isFinite(n) && n >= 1 && n <= totalPages && n - 1 !== page) navPage(n - 1);
            }}
            className="w-10 bg-black/30 border border-white/10 rounded px-1 py-0.5 text-xs text-center outline-none focus:border-blue-500"
          />
          / {totalPages}
        </span>
        <NavBtn label="▶" disabled={page + 1 >= totalPages || loading} onClick={() => navPage(page + 1)} title="下一頁" />
        <NavBtn label="⏭" disabled={page + 1 >= totalPages || loading} onClick={() => navPage(totalPages - 1)} title="最後一頁" />
        <select
          value={pageSize}
          onChange={(e) => changePageSize(Number(e.target.value))}
          title="每頁列數"
          className="ml-2 bg-black/30 border border-white/10 rounded px-1.5 py-0.5 text-xs outline-none focus:border-blue-500 text-white/60"
        >
          {[100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>{n} / 頁</option>
          ))}
        </select>

        <div className="w-px h-4 bg-white/10 mx-2" />
        <button
          onClick={applyEdits}
          disabled={dirtyCount === 0 || applying}
          title="套用變更"
          className="h-6 px-2 flex items-center gap-1 rounded text-xs bg-green-600/80 hover:bg-green-600 disabled:opacity-25 disabled:bg-transparent disabled:hover:bg-transparent"
        >
          ✓ 套用{dirtyCount > 0 ? `（${dirtyCount}）` : ""}
        </button>
        <button
          onClick={() => { setEdits({}); setEditing(null); }}
          disabled={dirtyCount === 0 || applying}
          title="捨棄變更"
          className="h-6 px-2 flex items-center rounded text-xs hover:bg-white/10 disabled:opacity-25 disabled:hover:bg-transparent"
        >
          ✗ 捨棄
        </button>

        {/* 選取儲存格資訊（Excel 名稱框手感） */}
        {selected && data && data.rows[selected.r] && (
          <span className="ml-auto mr-3 text-white/45 text-xs truncate max-w-[40%]" title={cellValue(selected.r, selected.c) ?? "NULL"}>
            <span className="text-white/30">{data.columns[selected.c]}</span>
            {" = "}
            {cellValue(selected.r, selected.c) === null
              ? <span className="italic text-white/30">NULL</span>
              : cellValue(selected.r, selected.c)}
          </span>
        )}
        <span className={`${selected && data && data.rows[selected.r] ? "" : "ml-auto"} text-white/40 text-xs`}>
          {applying
            ? "處理中…"
            : data
            ? `顯示 ${data.rows.length ? startRow + 1 : 0}–${startRow + data.rows.length} · 共 ${data.total_rows} 列${editable ? "" : " · 無主鍵唯讀"}`
            : loading
            ? "讀取中…"
            : ""}
        </span>
      </div>

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
          onClose={() => { setDetailKey(null); load(); }}
        />
      )}

      {rowMenu && (
        <>
          <div className="fixed inset-0 z-[89]"
            onClick={() => setRowMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setRowMenu(null); }} />
          <div className="fixed z-[90] min-w-[150px] bg-[#1a212b] border border-white/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: rowMenu.x, top: rowMenu.y }}>
            {(
              [
                ["檢視內容", () => setDetailKey(rowMenu.key), false],
                ["複製鍵名", () => copyToClipboard(rowMenu.key, "已複製鍵名"), false],
                ["重新命名…", () => renameKey(rowMenu.key), false],
                ["設定 TTL…", () => setKeyTtl(rowMenu.key, rowMenu.ttl), false],
                ["刪除", () => deleteRow(rowMenu.r), true],
              ] as [string, () => void, boolean][]
            ).map(([label, fn, danger]) => (
              <button key={label} type="button"
                onClick={() => { setRowMenu(null); fn(); }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-white/10 ${danger ? "text-red-300" : "text-white/80"}`}>
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
          <div className="fixed z-[90] min-w-[180px] bg-[#1a212b] border border-white/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: cellMenu.x, top: cellMenu.y }}>
            {cellMenuItems(cellMenu.r, cellMenu.c).map((it, idx) => {
              if (it === "sep") return <div key={`sep-${idx}`} className="my-1 border-t border-white/10" />;
              const [label, fn, danger] = it;
              return (
                <button key={label} type="button"
                  onClick={() => { setCellMenu(null); fn(); }}
                  className={`block w-full text-left px-3 py-1.5 hover:bg-white/10 ${danger ? "text-red-300" : "text-white/80"}`}>
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
          <div className="fixed z-[90] min-w-[170px] bg-[#1a212b] border border-white/10 rounded shadow-2xl py-1 text-sm"
            style={{ left: colMenu.x, top: colMenu.y }}>
            {(
              [
                ["升冪排序 ▲", () => { setPage(0); setSorts([{ column: colMenu.col, dir: "asc" }]); }],
                ["降冪排序 ▼", () => { setPage(0); setSorts([{ column: colMenu.col, dir: "desc" }]); }],
                ...(sorts.length ? [["清除排序", () => setSorts([])] as [string, () => void]] : []),
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
                className="block w-full text-left px-3 py-1.5 hover:bg-white/10 text-white/80">
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
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[560px] max-w-[92vw] max-h-[82vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2 text-sm">
          <span className="font-medium">第 {rowNo} 列</span>
          <span className="text-white/30 text-xs">{columns.length} 欄{editable ? "（可編輯）" : "（唯讀）"}</span>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" disabled={!hasPrev} onClick={onPrev} title="上一列"
              className="w-6 h-6 rounded hover:bg-white/10 disabled:opacity-30">↑</button>
            <button type="button" disabled={!hasNext} onClick={onNext} title="下一列"
              className="w-6 h-6 rounded hover:bg-white/10 disabled:opacity-30">↓</button>
            <button type="button" onClick={onClose} className="ml-1 text-white/40 hover:text-white">✕</button>
          </div>
        </div>
        <div className="p-4 overflow-auto space-y-1.5">
          {columns.map((c, ci) => (
            <div key={c} className="flex items-start gap-2">
              <span className="text-xs text-white/50 w-32 shrink-0 truncate text-right pt-1.5 mono" title={c}>{c}</span>
              {editable ? (
                <RowField value={values[ci]} onSave={(raw, setNull) => onEdit(ci, raw, setNull)} />
              ) : (
                <span className="flex-1 mono text-sm break-all py-1" data-selectable>
                  {values[ci] === null ? <span className="text-white/30 italic">NULL</span> : values[ci]}
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
        className={`flex-1 bg-black/30 border rounded px-2 py-1 text-sm mono outline-none focus:border-blue-500 ${
          value === null ? "border-white/10 text-white/40 italic" : "border-white/10"
        }`}
        placeholder={value === null ? "NULL" : ""} />
      <button type="button" onMouseDown={(e) => { e.preventDefault(); onSave("", true); }}
        title="設為 NULL" className="text-[10px] text-white/40 hover:text-white/70 shrink-0">NULL</button>
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
  const formatJson = () => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      toast.error("不是有效的 JSON");
    }
  };
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[660px] max-w-[92vw] max-h-[82vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm mono truncate">{column}</span>
          {value === null && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50">NULL</span>}
          <span className="ml-auto text-[11px] text-white/40 tabular-nums"
            title="字元數 / UTF-8 位元組數（位元組數對應多數資料庫的 VARCHAR 長度上限）">
            {text.length} 字元 · {new TextEncoder().encode(text).length} bytes
          </span>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white">✕</button>
        </div>
        <div className="p-4 flex-1 overflow-auto">
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)}
            readOnly={!editable} title="儲存格內容"
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            className="w-full h-72 bg-black/30 border border-white/10 rounded p-3 mono text-sm outline-none focus:border-blue-500 resize-none break-all" />
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex items-center gap-2">
          {showFormat && (
            <button type="button" onClick={formatJson}
              className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">格式化 JSON</button>
          )}
          <button type="button" onClick={() => copyToClipboard(text, "已複製")}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">複製</button>
          <div className="ml-auto flex gap-2">
            {editable && (
              <button type="button" onClick={() => { onSave("", true); onClose(); }}
                className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5 text-white/70">設為 NULL</button>
            )}
            {editable && (
              <button type="button" disabled={!dirty} onClick={() => { onSave(text, false); onClose(); }}
                className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40">套用變更</button>
            )}
            <button type="button" onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">關閉</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Redis 鍵詳情：依型別呈現五種資料結構，並支援元素級編輯
function KeyDetailModal({ connId, database, table, rkey, onClose }: {
  connId: string; database: string; table: string; rkey: string; onClose: () => void;
}) {
  const [detail, setDetail] = useState<KeyDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .keyDetail(connId, database, rkey)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setErr(e?.message ?? "讀取失敗"));
    return () => { cancelled = true; };
  }, [connId, database, rkey, nonce]);

  const reload = () => setNonce((n) => n + 1);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#1a212b] w-[560px] max-h-[80vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm mono truncate">{rkey}</span>
          {detail && (
            <>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">{detail.type_}</span>
              <span className="text-xs text-white/40">
                TTL: {detail.ttl < 0 ? "無到期" : `${detail.ttl}s`}
              </span>
            </>
          )}
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>
        <div className="p-4 overflow-auto">
          {err && <div className="text-red-400 text-sm mono mb-2 break-all">{err}</div>}
          {!detail && !err && <div className="text-white/40 text-sm">讀取中…</div>}
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
    return <div className="text-white/40 text-sm">（此鍵已不存在）</div>;
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
          <th className="text-left px-2 py-1 border-b border-white/10 w-1/3">field</th>
          <th className="text-left px-2 py-1 border-b border-white/10">value</th>
          <th className="w-8 border-b border-white/10" />
        </tr></thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i} className="hover:bg-white/5 group">
              <td className="px-2 py-1 border-b border-white/5 break-all text-white/70">{f}</td>
              <td className="px-2 py-1 border-b border-white/5 break-all">
                <InlineEdit value={entries[i] ?? ""} onSave={(v) => edit({ action: "hash_set", field: f, value: v })} />
              </td>
              <DelCell busy={busy} onClick={() => edit({ action: "hash_remove", field: f })} />
            </tr>
          ))}
          <tr>
            <td className="px-2 py-1"><AddInput value={addA} onChange={setAddA} placeholder="field" /></td>
            <td className="px-2 py-1"><AddInput value={addB} onChange={setAddB} placeholder="value" /></td>
            <AddCell busy={busy} onClick={() => addA && edit({ action: "hash_set", field: addA, value: addB })} />
          </tr>
        </tbody>
      </table>
    );
  }

  if (type_ === "zset") {
    return (
      <table className="text-sm border-collapse w-full mono">
        <thead><tr>
          <th className="text-left px-2 py-1 border-b border-white/10 w-24">score</th>
          <th className="text-left px-2 py-1 border-b border-white/10">member</th>
          <th className="w-8 border-b border-white/10" />
        </tr></thead>
        <tbody>
          {entries.map((m, i) => (
            <tr key={i} className="hover:bg-white/5 group">
              <td className="px-2 py-1 border-b border-white/5 text-white/60">
                <InlineEdit value={String(scores[i] ?? 0)} type="number"
                  onSave={(v) => { const s = Number(v); if (Number.isFinite(s)) edit({ action: "zset_add", member: m, score: s }); }} />
              </td>
              <td className="px-2 py-1 border-b border-white/5 break-all">{m}</td>
              <DelCell busy={busy} onClick={() => edit({ action: "zset_remove", member: m })} />
            </tr>
          ))}
          <tr>
            <td className="px-2 py-1"><AddInput value={addB} onChange={setAddB} placeholder="score" type="number" /></td>
            <td className="px-2 py-1"><AddInput value={addA} onChange={setAddA} placeholder="member" /></td>
            <AddCell busy={busy}
              onClick={() => { const s = Number(addB); if (addA && Number.isFinite(s)) edit({ action: "zset_add", member: addA, score: s }); }} />
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
        <th className="text-left px-2 py-1 border-b border-white/10 w-12 text-white/30">{isList ? "#" : ""}</th>
        <th className="text-left px-2 py-1 border-b border-white/10">value</th>
        <th className="w-8 border-b border-white/10" />
      </tr></thead>
      <tbody>
        {entries.map((v, i) => (
          <tr key={i} className="hover:bg-white/5 group">
            <td className="px-2 py-1 border-b border-white/5 text-white/30">{isList ? i : ""}</td>
            <td className="px-2 py-1 border-b border-white/5 break-all">
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
              <label className="text-[10px] text-white/40 flex items-center gap-1">
                <input type="checkbox" checked={addFront} onChange={(e) => setAddFront(e.target.checked)} />
                前端
              </label>
            )}
          </td>
          <td className="px-2 py-1"><AddInput value={addA} onChange={setAddA} placeholder="value" /></td>
          <AddCell busy={busy}
            onClick={() => addA && edit(isList ? { action: "list_push", value: addA, front: addFront } : { action: "set_add", member: addA })} />
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
        className="cursor-text hover:bg-white/10 rounded px-1 -mx-1 inline-block min-w-[2rem]">
        {value === "" ? <span className="text-white/25">（空）</span> : value}
      </span>
    );
  }
  return (
    <input autoFocus type={type} value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { setEditing(false); if (text !== value) onSave(text); }
        else if (e.key === "Escape") { setEditing(false); setText(value); }
      }}
      onBlur={() => { setEditing(false); if (text !== value) onSave(text); }}
      className="bg-black/50 border border-blue-500 rounded px-1 py-0.5 outline-none w-full" />
  );
}

function StringEditor({ value, onSave, busy }: {
  value: string; onSave: (v: string) => void; busy: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="space-y-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} title="字串值"
        className="w-full h-40 bg-black/30 border border-white/10 rounded p-3 mono text-sm outline-none focus:border-blue-500 resize-none break-all" />
      <div className="flex justify-end">
        <button type="button" disabled={busy || text === value} onClick={() => onSave(text)}
          className="px-3 py-1 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40">
          {busy ? "儲存中…" : "儲存"}
        </button>
      </div>
    </div>
  );
}

function DelCell({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <td className="px-1 py-1 border-b border-white/5 text-center">
      <button type="button" onClick={onClick} disabled={busy} title="刪除"
        className="w-5 h-5 rounded text-white/20 group-hover:text-red-400 hover:bg-red-500/20 disabled:opacity-30">
        −
      </button>
    </td>
  );
}

function AddCell({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <td className="px-1 py-1 text-center">
      <button type="button" onClick={onClick} disabled={busy} title="新增"
        className="w-5 h-5 rounded text-white/30 hover:text-green-400 hover:bg-green-500/20 disabled:opacity-30">
        ＋
      </button>
    </td>
  );
}

function AddInput({ value, onChange, placeholder, type = "text" }: {
  value: string; onChange: (v: string) => void; placeholder: string; type?: string;
}) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className="w-full bg-black/30 border border-white/10 rounded px-1.5 py-0.5 text-sm outline-none focus:border-blue-500" />
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
  filters: Filter[];
  matchAny: boolean;
  onApply: (filters: Filter[], matchAny: boolean) => void;
}) {
  const blank = (): Filter => ({ column: columns[0] ?? "", op: "=", value: "" });
  const [rows, setRows] = useState<Filter[]>(filters.length ? filters : [blank()]);
  const [any, setAny] = useState(matchAny);

  // 外部 filters 變更（例如清除）時同步回來。
  useEffect(() => {
    setRows(filters.length ? filters : [blank()]);
    setAny(matchAny);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, matchAny]);

  const update = (i: number, patch: Partial<Filter>) =>
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
    <div className="px-2 py-1.5 bg-[#0d131a] border-b border-white/10 text-xs space-y-1.5">
      {rows.length > 1 && (
        <div className="flex items-center gap-1 text-white/40">
          <span>符合</span>
          {([["false", "全部 (AND)"], ["true", "任一 (OR)"]] as [string, string][]).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setAny(v === "true")}
              className={`px-2 py-0.5 rounded border ${
                any === (v === "true") ? "border-blue-500 bg-blue-500/15 text-blue-300" : "border-white/10 text-white/50"
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
            className="bg-black/30 border border-white/10 rounded px-1.5 py-1 outline-none">
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={r.op} title="運算子" onChange={(e) => update(i, { op: e.target.value })}
            className="bg-black/30 border border-white/10 rounded px-1.5 py-1 outline-none">
            {FILTER_OPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          {opNeedsValue(r.op) && (
            <input value={r.value ?? ""} onChange={(e) => update(i, { value: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder={r.op === "like" ? "%關鍵字%" : "值"}
              className="bg-black/30 border border-white/10 rounded px-2 py-1 outline-none focus:border-blue-500 min-w-[140px]" />
          )}
          <button onClick={() => removeRow(i)} disabled={rows.length === 1}
            title="移除此條件"
            className="px-1.5 py-1 rounded hover:bg-white/10 text-white/40 disabled:opacity-30">
            −
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-0.5">
        <button onClick={addRow}
          className="px-2 py-1 rounded hover:bg-white/10 text-white/60">＋ 新增條件</button>
        <button onClick={apply}
          className="px-2 py-1 rounded bg-blue-600/80 hover:bg-blue-600">套用</button>
        <button onClick={clear}
          className="px-2 py-1 rounded hover:bg-white/10 text-white/50">清除</button>
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
    const cols: string[] = [];
    const vals: (string | null)[] = [];
    for (const c of columns) {
      if (nulls[c]) { cols.push(c); vals.push(null); continue; }
      if (c in values) { cols.push(c); vals.push(values[c]); }
      // 未填且未標 NULL 的欄位略過，交由 DB 預設值處理
    }
    onSubmit({ columns: cols, values: vals });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#1a212b] w-[480px] max-h-[80vh] flex flex-col rounded-lg border border-white/10 shadow-2xl">
        <div className="px-5 py-3 border-b border-white/10 font-medium text-sm">新增列</div>
        <div className="p-4 space-y-2 overflow-y-auto">
          <p className="text-xs text-white/40">未填寫且未標 NULL 的欄位，交由資料庫預設值處理。</p>
          {columns.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className="text-xs text-white/60 w-28 truncate text-right">{c}</span>
              <input
                disabled={nulls[c]}
                value={nulls[c] ? "" : values[c] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [c]: e.target.value }))}
                className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-sm outline-none focus:border-blue-500 disabled:opacity-40"
                placeholder={nulls[c] ? "NULL" : "（預設）"}
              />
              <label className="text-[10px] text-white/40 flex items-center gap-1 shrink-0">
                <input type="checkbox" checked={!!nulls[c]}
                  onChange={(e) => setNulls((n) => ({ ...n, [c]: e.target.checked }))} />
                NULL
              </label>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">取消</button>
          <button onClick={submit} disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">
            {busy ? "新增中…" : "新增"}
          </button>
        </div>
      </div>
    </div>
  );
}

// 儲存格編輯器：Enter 套用、Esc 取消、按鈕設為 NULL
function CellEditor({ initial, onCommit, onCancel }: {
  initial: string | null;
  onCommit: (raw: string, setNull: boolean) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial ?? "");
  return (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(text, false);
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onCommit(text, false)}
        className="bg-black/50 border border-blue-500 rounded px-1 py-0.5 outline-none w-full min-w-[80px]"
      />
      <button
        onMouseDown={(e) => { e.preventDefault(); onCommit("", true); }}
        title="設為 NULL"
        className="text-[10px] text-white/40 hover:text-white/70 shrink-0"
      >
        NULL
      </button>
    </span>
  );
}

function NavBtn({ label, onClick, disabled, title }: {
  label: string; onClick: () => void; disabled?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-7 h-6 flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-25 disabled:hover:bg-transparent text-xs"
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
  const [fks, setFks] = useState<ErRelation[] | null>(null); // 此表的外鍵（取自 ER 模型並過濾）

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
    // 外鍵：取 ER 模型並過濾出本表為來源者（僅 SQL；失敗視為無）。
    if (isSql) {
      api
        .erModel(tab.connId, tab.database)
        .then((m) => !cancelled && setFks(m.relations.filter((r) => r.from_table === tab.table)))
        .catch(() => !cancelled && setFks([]));
    } else {
      setFks([]);
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

  const createIndexFn = async (name: string, columns: string[], unique: boolean) => {
    if (!name.trim() || columns.length === 0) { toast.error("請填索引名稱並至少選一欄"); return; }
    setBusy(true);
    try {
      await api.createIndex(tab.connId, tab.database, tab.table, name.trim(), columns, unique);
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
  if (!cols) return <div className="p-3 text-white/40 text-sm">讀取中…</div>;

  return (
    <div className="flex-1 overflow-auto">
      {isSql && (
        <div className="flex items-center gap-1 px-2 py-1 bg-[#10161e] border-b border-white/10 text-xs">
          <button type="button" onClick={() => setAdding((s) => !s)} disabled={busy}
            className="px-2 py-1 rounded hover:bg-white/10 text-white/60 disabled:opacity-40">
            ＋ 新增欄位
          </button>
          <button type="button" onClick={viewDdl}
            title="檢視 / 複製建表 SQL（CREATE 語句）"
            className="px-2 py-1 rounded hover:bg-white/10 text-white/60">
            📋 建表 SQL
          </button>
          {busy && <span className="text-white/40">處理中…</span>}
        </div>
      )}
      {adding && isSql && <AddColumnForm busy={busy} onCancel={() => setAdding(false)}
        onSubmit={(op) => doAlter(op, "欄位已新增")} />}
      <table className="text-sm border-collapse w-full">
        <thead className="sticky top-0 bg-[#1a212b]">
          <tr>
            {["欄位", "型別", "可空", "鍵", "預設", "額外"].map((h) => (
              <th key={h} className="text-left px-3 py-1.5 border-b border-white/10 font-medium">
                {h}
              </th>
            ))}
            {isSql && <th className="w-20 border-b border-white/10" />}
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.name} className="hover:bg-white/5 group">
              <td className="px-3 py-1 border-b border-white/5 font-medium">
                {rename?.col === c.name ? (
                  <input autoFocus value={rename.to}
                    onChange={(e) => setRename({ col: c.name, to: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && rename.to && rename.to !== c.name)
                        doAlter({ op: "rename_column", old: c.name, new: rename.to }, "欄位已改名");
                      else if (e.key === "Escape") setRename(null);
                    }}
                    onBlur={() => setRename(null)}
                    className="bg-black/50 border border-blue-500 rounded px-1 py-0.5 outline-none" />
                ) : (
                  c.name
                )}
              </td>
              <td className="px-3 py-1 border-b border-white/5 mono text-white/70">{c.data_type}</td>
              <td className="px-3 py-1 border-b border-white/5 text-white/60">{c.nullable ? "YES" : "NO"}</td>
              <td className="px-3 py-1 border-b border-white/5">
                {c.key && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">{c.key}</span>
                )}
              </td>
              <td className="px-3 py-1 border-b border-white/5 mono text-white/50">
                {c.default ?? <span className="text-white/25 italic">—</span>}
              </td>
              <td className="px-3 py-1 border-b border-white/5 text-white/50 text-xs">{c.extra}</td>
              {isSql && (
                <td className="px-2 py-1 border-b border-white/5 text-right whitespace-nowrap">
                  <button type="button" title="改名" disabled={busy}
                    onClick={() => setRename({ col: c.name, to: c.name })}
                    className="px-1 text-white/20 group-hover:text-white/70 hover:bg-white/15 rounded disabled:opacity-40">✎</button>
                  <button type="button" title="刪除欄位" disabled={busy}
                    onClick={() => dropCol(c.name)}
                    className="px-1 text-white/20 group-hover:text-red-400 hover:bg-red-500/20 rounded disabled:opacity-40">−</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/* 索引區（致敬商用工具的結構檢視） */}
      {indexes && (indexes.length > 0 || canIndex) && (
        <div className="mt-2">
          <div className="px-3 py-1.5 text-xs text-white/40 bg-[#10161e] border-y border-white/10 flex items-center gap-2">
            <span>索引（{indexes.length}）</span>
            {canIndex && (
              <button type="button" onClick={() => setAddingIndex((s) => !s)} disabled={busy}
                className="px-1.5 py-0.5 rounded hover:bg-white/10 text-white/60 disabled:opacity-40">＋ 新增索引</button>
            )}
          </div>
          {addingIndex && canIndex && cols && (
            <AddIndexForm columns={cols.map((c) => c.name)} busy={busy}
              onCancel={() => setAddingIndex(false)} onSubmit={createIndexFn} />
          )}
          {indexes.length === 0 && <div className="px-3 py-2 text-white/30 text-xs">尚無索引。</div>}
          {indexes.length > 0 && (
          <table className="text-sm border-collapse w-full">
            <thead className="bg-[#1a212b]">
              <tr>
                {["名稱", "欄位", "唯一", "主鍵"].map((h) => (
                  <th key={h} className="text-left px-3 py-1.5 border-b border-white/10 font-medium">{h}</th>
                ))}
                {canIndex && <th className="w-12 border-b border-white/10" />}
              </tr>
            </thead>
            <tbody>
              {indexes.map((ix) => (
                <tr key={ix.name} className="hover:bg-white/5 group">
                  <td className="px-3 py-1 border-b border-white/5 mono">{ix.name}</td>
                  <td className="px-3 py-1 border-b border-white/5 mono text-white/70">{ix.columns.join(", ")}</td>
                  <td className="px-3 py-1 border-b border-white/5">
                    {ix.unique && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">UNIQUE</span>}
                  </td>
                  <td className="px-3 py-1 border-b border-white/5">
                    {ix.primary && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">PK</span>}
                  </td>
                  {canIndex && (
                    <td className="px-2 py-1 border-b border-white/5 text-right">
                      {!ix.primary && (
                        <button type="button" title="刪除索引" disabled={busy}
                          onClick={() => dropIndexByName(ix.name)}
                          className="px-1 text-white/20 group-hover:text-red-400 hover:bg-red-500/20 rounded disabled:opacity-40">−</button>
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
      {isSql && fks && fks.length > 0 && (
        <div className="mt-2">
          <div className="px-3 py-1.5 text-xs text-white/40 bg-[#10161e] border-y border-white/10">
            外鍵（{fks.length}）
          </div>
          <table className="text-sm border-collapse w-full">
            <thead className="bg-[#1a212b]">
              <tr>
                {["欄位", "參照", "參照欄位"].map((h) => (
                  <th key={h} className="text-left px-3 py-1.5 border-b border-white/10 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fks.map((fk, i) => (
                <tr key={`${fk.from_column}-${i}`} className="hover:bg-white/5">
                  <td className="px-3 py-1 border-b border-white/5 mono">{fk.from_column}</td>
                  <td className="px-3 py-1 border-b border-white/5 mono text-white/50">→ {fk.to_table}</td>
                  <td className="px-3 py-1 border-b border-white/5 mono">{fk.to_column}</td>
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

function AddColumnForm({ onSubmit, onCancel, busy }: {
  onSubmit: (op: AlterOp) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [dataType, setDataType] = useState("");
  const [nullable, setNullable] = useState(true);
  const [def, setDef] = useState("");
  const ic = "bg-black/30 border border-white/10 rounded px-2 py-1 text-sm outline-none focus:border-blue-500";
  const submit = () => {
    if (!name.trim() || !dataType.trim()) { toast.error("請填欄位名稱與型別"); return; }
    onSubmit({ op: "add_column", name: name.trim(), data_type: dataType.trim(), nullable, default: def.trim() || null });
  };
  return (
    <div className="flex flex-wrap items-end gap-2 px-3 py-2 bg-[#0d131a] border-b border-white/10 text-xs">
      <label className="block"><span className="text-white/50 block mb-0.5">欄位名稱</span>
        <input className={ic} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block"><span className="text-white/50 block mb-0.5">型別</span>
        <input className={ic} value={dataType} onChange={(e) => setDataType(e.target.value)} placeholder="如 VARCHAR(50) / INT" /></label>
      <label className="block"><span className="text-white/50 block mb-0.5">預設值（選填）</span>
        <input className={ic} value={def} onChange={(e) => setDef(e.target.value)} placeholder="如 0 / 'x' / CURRENT_TIMESTAMP" /></label>
      <label className="flex items-center gap-1 pb-1.5 select-none">
        <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} /> 可空
      </label>
      <button type="button" onClick={submit} disabled={busy}
        className="px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">新增</button>
      <button type="button" onClick={onCancel}
        className="px-3 py-1.5 rounded border border-white/15 hover:bg-white/5">取消</button>
    </div>
  );
}

// 新增索引表單：名稱 + 欄位多選（依點選順序組複合索引）+ 唯一。
function AddIndexForm({ columns, busy, onSubmit, onCancel }: {
  columns: string[];
  busy: boolean;
  onSubmit: (name: string, columns: string[], unique: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const toggle = (c: string) => setSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  const ic = "bg-black/30 border border-white/10 rounded px-2 py-1 text-sm outline-none focus:border-blue-500";
  return (
    <div className="px-3 py-2 bg-[#0d131a] border-b border-white/10 text-xs space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="text-white/50 block mb-0.5">索引名稱</span>
          <input className={ic} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 idx_email" /></label>
        <label className="flex items-center gap-1 pb-1.5 select-none">
          <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> 唯一
        </label>
      </div>
      <div>
        <span className="text-white/50 block mb-1">欄位（可多選，依點選順序組複合索引）</span>
        <div className="flex flex-wrap gap-1.5">
          {columns.map((c) => {
            const i = sel.indexOf(c);
            return (
              <button key={c} type="button" onClick={() => toggle(c)}
                className={`px-2 py-0.5 rounded border ${i >= 0 ? "border-blue-500 bg-blue-500/15 text-blue-300" : "border-white/10 text-white/50"}`}>
                {c}{i >= 0 ? `（${i + 1}）` : ""}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => onSubmit(name, sel, unique)} disabled={busy}
          className="px-3 py-1 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50">建立</button>
        <button type="button" onClick={onCancel}
          className="px-3 py-1 rounded border border-white/15 hover:bg-white/5">取消</button>
      </div>
    </div>
  );
}
