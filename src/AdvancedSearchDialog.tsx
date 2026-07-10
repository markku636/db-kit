import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Crosshair, Download, Search, X } from "lucide-react";
import { api, DbKind, ExportFormat, ExportOptions, SearchHit, SearchOptions } from "./api";
import { useStore } from "./store";
import { toast, pickSaveFile } from "./ui";
import { Modal, Button } from "./ui/index";
import Icon from "./ui/Icon";

// 進階物件搜尋（致敬 Redgate SQL Search 進階版）。與既有 SearchObjectsDialog 並存、不共用：
// 以「表格」呈現結果（物件名稱 / 資料庫(Schema) / 型別 / 命中於 / 詳細，欄位可排序），
// 支援整字比對（whole word）與萬用字元（wildcards * ?）、底部可調高度的定義預覽（高亮命中），
// 以及「在物件總管中選取」把物件在側欄樹展開＋捲動＋highlight。後端共用 search_objects。

const TYPE_META: Record<string, { label: string; color: string }> = {
  table: { label: "資料表", color: "#3b82f6" },
  view: { label: "視圖", color: "#8b5cf6" },
  column: { label: "欄位", color: "#06b6d4" },
  index: { label: "索引", color: "#f59e0b" },
  procedure: { label: "預存程序", color: "#22c55e" },
  function: { label: "函式", color: "#10b981" },
  trigger: { label: "觸發器", color: "#ef4444" },
  foreign_key: { label: "外鍵", color: "#ec4899" },
  collection: { label: "集合", color: "#22c55e" },
  key: { label: "鍵", color: "#ef4444" },
};

const MATCH_LABEL: Record<string, string> = {
  name: "名稱",
  definition: "定義",
  comment: "註解",
};

// 各資料庫種類可搜尋的物件型別（顯示順序＝型別 chips 順序）。
function typesForKind(kind: DbKind): string[] {
  switch (kind) {
    case "sqlite":
      return ["table", "view", "column", "index", "trigger"];
    case "mongo":
      return ["collection"];
    case "redis":
      return ["key"];
    default: // mysql / mariadb / postgres / oracle / mssql
      return ["table", "view", "column", "index", "procedure", "function", "trigger", "foreign_key"];
  }
}

// 把命中文字以 <mark> 高亮（依大小寫模式；萬用字元 / 整字模式仍以字面 term 定位第一個出現處）。
function highlight(text: string, term: string, cs: boolean) {
  if (!term) return text;
  // 萬用字元字元本身不做字面高亮（避免把 * ? 當普通字比對），退化為不高亮。
  const literal = term.replace(/[*?]/g, "");
  if (!literal) return text;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, cs ? "g" : "gi"));
  return parts.map((p, i) => {
    const isHit = cs ? p === literal : p.toLowerCase() === literal.toLowerCase();
    return isHit ? (
      <mark key={i} className="bg-blue-500/40 text-fg rounded px-0.5">{p}</mark>
    ) : (
      <span key={i}>{p}</span>
    );
  });
}

// 篩選偏好持久化（跨開啟記住比對範圍 / 型別 / 進階旗標；資料庫選擇因連線而異，不持久化）。
const PREFS_KEY = "dbkit:advsearch:prefs";
type Prefs = {
  types?: string[];
  matchNames?: boolean;
  matchDefs?: boolean;
  matchComments?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  wildcards?: boolean;
};
function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

// 內嵌精簡版可調大小 hook（僅 axis:"y"，供底部預覽窗格）；對標 App.tsx 的 useResizable，
// 避免跨檔匯出。拖曳結束才寫入 localStorage。
function clampSize(v: number, min: number, max: number) {
  return Math.max(min, Math.min(v, max));
}
function useResizableY(storageKey: string, initial: number, min: number, max: () => number) {
  const [size, setSize] = useState<number>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v != null) {
        const n = parseFloat(v);
        if (Number.isFinite(n)) return clampSize(n, min, max());
      }
    } catch {
      /* 忽略讀取失敗 */
    }
    return initial;
  });
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientY;
    const startSize = size;
    let latest = startSize;
    const move = (ev: PointerEvent) => {
      // 底部窗格：向上拖（clientY 變小）應增高 → 取反向差值。
      latest = clampSize(startSize - (ev.clientY - start), min, max());
      setSize(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(storageKey, String(latest)); } catch { /* 忽略寫入失敗 */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };
  return { size, onPointerDown };
}

type SortCol = "name" | "database" | "type" | "matched" | "detail";
const COLS: { col: SortCol; label: string }[] = [
  { col: "name", label: "物件名稱" },
  { col: "database", label: "資料庫 (Schema)" },
  { col: "type", label: "型別" },
  { col: "matched", label: "命中於" },
  { col: "detail", label: "詳細" },
];

export default function AdvancedSearchDialog({ connId, kind, onClose }: {
  connId: string;
  kind: DbKind;
  onClose: () => void;
}) {
  const allTypes = useMemo(() => typesForKind(kind), [kind]);
  const prefs = useMemo(loadPrefs, []);

  // 能力 gate（one flag = one concern）：依 DbKind 決定哪些選項可用 / 可見。
  const caps = useMemo(() => {
    const relational =
      kind === "mysql" || kind === "mariadb" || kind === "postgres" ||
      kind === "sqlite" || kind === "mssql" || kind === "oracle";
    return {
      defs: kind === "mysql" || kind === "mariadb" || kind === "postgres" || kind === "sqlite", // 定義內文
      comments: kind === "mysql" || kind === "mariadb" || kind === "postgres" || kind === "oracle", // 註解
      wholeWord: kind !== "external" && kind !== "redis", // qland 忽略、redis 為 glob
      wildcards: kind !== "external" && kind !== "redis", // qland 忽略；redis 原生 glob → 隱藏、恆送 true
      caseSensitive: kind !== "redis",
      preview: relational, // tableDdl / routineDefinition 僅關聯式
      nameOnly: kind === "mssql" || kind === "external", // 後端目前僅名稱搜尋
    };
  }, [kind]);

  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0); // 選取列（sortedResults 索引）

  // 篩選狀態（從上次偏好還原）
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(() => {
    const saved = prefs.types?.filter((t) => allTypes.includes(t));
    return saved && saved.length ? new Set(saved) : new Set(allTypes);
  });
  const [matchNames, setMatchNames] = useState(prefs.matchNames ?? true);
  const [matchDefs, setMatchDefs] = useState(prefs.matchDefs ?? true);
  const [matchComments, setMatchComments] = useState(prefs.matchComments ?? true);
  const [caseSensitive, setCaseSensitive] = useState(prefs.caseSensitive ?? false);
  const [wholeWord, setWholeWord] = useState(prefs.wholeWord ?? false);
  const [wildcards, setWildcards] = useState(prefs.wildcards ?? false);

  // 資料庫多選
  const [dbs, setDbs] = useState<string[]>([]);
  const [selectedDbs, setSelectedDbs] = useState<Set<string>>(new Set());
  const [dbPanel, setDbPanel] = useState(false);

  // 排序（client 端，不重查）；null = 保留後端 finalize_hits 順序。
  const [sort, setSort] = useState<{ col: SortCol; dir: "asc" | "desc" } | null>(null);

  // 定義預覽（底部窗格）
  const [preview, setPreview] = useState<{ hit: SearchHit; ddl: string | null; loading: boolean; err: string | null } | null>(null);
  const previewPane = useResizableY("dbkit:advsearch:previewH", 240, 120, () => window.innerHeight * 0.6);

  const LIMIT = 1000;
  const aliveRef = useRef(true);
  const seqRef = useRef(0); // 搜尋請求序號，丟棄過期回應
  const previewSeqRef = useRef(0); // 預覽請求序號
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 載入可選資料庫（預設全選）。
  useEffect(() => {
    let alive = true;
    api
      .listDatabases(connId)
      .then((list) => {
        if (!alive) return;
        setDbs(list);
        setSelectedDbs(new Set(list));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connId]);

  // 持久化篩選偏好。
  useEffect(() => {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          types: Array.from(enabledTypes),
          matchNames,
          matchDefs,
          matchComments,
          caseSensitive,
          wholeWord,
          wildcards,
        } as Prefs)
      );
    } catch {
      /* 忽略 localStorage 失敗 */
    }
  }, [enabledTypes, matchNames, matchDefs, matchComments, caseSensitive, wholeWord, wildcards]);

  const effMatchNames = matchNames || caps.nameOnly;
  const hasScope = effMatchNames || (caps.defs && matchDefs) || (caps.comments && matchComments);
  const allTypesOn = enabledTypes.size === allTypes.length;
  const allDbsOn = dbs.length > 0 && selectedDbs.size === dbs.length;

  const toggleType = (t: string) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const toggleDb = (d: string) => {
    setSelectedDbs((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  };

  const search = async () => {
    const p = term.trim();
    if (!p) {
      setResults(null);
      setErr(null);
      return;
    }
    if (!hasScope) {
      setErr("請至少勾選一個比對範圍（名稱 / 定義 / 註解）。");
      setResults(null);
      return;
    }
    if (enabledTypes.size === 0) {
      setErr("請至少勾選一個物件型別。");
      setResults(null);
      return;
    }
    const seq = ++seqRef.current;
    setBusy(true);
    setErr(null);
    const opts: SearchOptions = {
      term: p,
      databases: allDbsOn || dbs.length === 0 ? null : Array.from(selectedDbs),
      types: allTypesOn ? null : Array.from(enabledTypes),
      match_names: effMatchNames,
      match_definitions: caps.defs && matchDefs,
      match_comments: caps.comments && matchComments,
      case_sensitive: caps.caseSensitive && caseSensitive,
      whole_word: caps.wholeWord && wholeWord && !wildcards,
      wildcards: kind === "redis" ? true : caps.wildcards && wildcards,
      limit: LIMIT,
    };
    try {
      const hits = await api.searchObjects(connId, opts);
      if (!aliveRef.current || seqRef.current !== seq) return; // 過期回應丟棄
      setResults(hits);
      setTruncated(hits.length >= LIMIT);
      setActiveIdx(0);
    } catch (e: any) {
      if (!aliveRef.current || seqRef.current !== seq) return;
      setErr(e?.message ?? "搜尋失敗");
      setResults(null);
    } finally {
      if (aliveRef.current && seqRef.current === seq) setBusy(false);
    }
  };

  // 即時搜尋：term / 篩選變動後 debounce 280ms 自動搜尋（空字串清空結果）。
  useEffect(() => {
    if (!term.trim()) {
      setResults(null);
      setErr(null);
      return;
    }
    const h = setTimeout(() => {
      void search();
    }, 280);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, enabledTypes, matchNames, matchDefs, matchComments, caseSensitive, wholeWord, wildcards, selectedDbs, dbs]);

  // client 端排序（不重查）。null → 保留後端順序。
  const sortedResults = useMemo(() => {
    if (!results) return [] as SearchHit[];
    if (!sort) return results;
    const { col, dir } = sort;
    const f = dir === "asc" ? 1 : -1;
    const key = (h: SearchHit) =>
      col === "name"
        ? h.object_name
        : col === "database"
        ? h.database + " " + (h.parent ?? "")
        : col === "type"
        ? TYPE_META[h.object_type]?.label ?? h.object_type
        : col === "matched"
        ? MATCH_LABEL[h.matched_in] ?? h.matched_in
        : h.snippet ?? h.extra ?? "";
    return [...results].sort((a, b) => key(a).localeCompare(key(b)) * f);
  }, [results, sort]);

  const toggleSort = (col: SortCol) =>
    setSort((s) => (s?.col === col ? (s.dir === "asc" ? { col, dir: "desc" } : null) : { col, dir: "asc" }));

  // 排序 / 結果變動後，選取列歸零。
  useEffect(() => {
    setActiveIdx(0);
  }, [sort, results]);

  // 選取項捲動進可視範圍。
  useEffect(() => {
    rowRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // 目標資料表：table/view/collection 用自身；column/index/trigger/foreign_key/key 用 parent。
  const revealTarget = (h: SearchHit): { table: string; objKind: string } | null => {
    if (h.object_type === "table" || h.object_type === "view" || h.object_type === "collection")
      return { table: h.object_name, objKind: h.object_type === "view" ? "view" : "table" };
    if (["column", "index", "trigger", "foreign_key", "key"].includes(h.object_type) && h.parent)
      return { table: h.parent, objKind: "table" };
    return null;
  };
  const revealInTree = (h: SearchHit) => {
    const t = revealTarget(h);
    if (!t) {
      toast.info("此結果無對應資料表可定位");
      return;
    }
    useStore.getState().revealInTree(connId, h.database, t.table, t.objKind);
    onClose(); // 關閉全螢幕對話框，露出側欄
  };

  const canPreview = (h: SearchHit) =>
    caps.preview && ["table", "view", "procedure", "function", "trigger"].includes(h.object_type);

  const showDef = async (h: SearchHit) => {
    if (!canPreview(h)) {
      setPreview(null);
      return;
    }
    const seq = ++previewSeqRef.current;
    setPreview({ hit: h, ddl: null, loading: true, err: null });
    try {
      const ddl =
        h.object_type === "table" || h.object_type === "view"
          ? await api.tableDdl(connId, h.database, h.object_name)
          : await api.routineDefinition(connId, h.database, h.object_name, h.object_type);
      if (!aliveRef.current || previewSeqRef.current !== seq) return;
      setPreview({ hit: h, ddl, loading: false, err: null });
    } catch (e: any) {
      if (!aliveRef.current || previewSeqRef.current !== seq) return;
      setPreview({ hit: h, ddl: null, loading: false, err: e?.message ?? "讀取定義失敗" });
    }
  };

  // 選取列變更 → 載入預覽（可預覽型別）。
  useEffect(() => {
    const h = sortedResults[activeIdx];
    if (h) void showDef(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, sortedResults]);

  // 對話框鍵盤：↑↓ 移動選取、Enter 在物件總管中選取（無結果時 Enter 立即搜尋）。
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      if (!sortedResults.length) return;
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, sortedResults.length - 1));
    } else if (e.key === "ArrowUp") {
      if (!sortedResults.length) return;
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (sortedResults.length) {
        const h = sortedResults[Math.max(0, Math.min(activeIdx, sortedResults.length - 1))];
        if (h) revealInTree(h);
      } else {
        void search();
      }
    }
  };

  const exportCsv = async () => {
    if (!sortedResults.length) return;
    const cols = ["物件名稱", "資料庫", "父物件", "型別", "命中於", "詳細"];
    const rows: (string | null)[][] = sortedResults.map((h) => [
      h.object_name,
      h.database,
      h.parent ?? "",
      TYPE_META[h.object_type]?.label ?? h.object_type,
      MATCH_LABEL[h.matched_in] ?? h.matched_in,
      h.snippet ?? h.extra ?? "",
    ]);
    const path = await pickSaveFile("advanced-search.csv", [
      { name: "CSV", extensions: ["csv"] },
      { name: "Excel (.xlsx)", extensions: ["xlsx"] },
      { name: "TSV", extensions: ["tsv"] },
      { name: "Markdown", extensions: ["md"] },
    ]);
    if (!path) return;
    const lower = path.toLowerCase();
    const format: ExportFormat = lower.endsWith(".xlsx")
      ? "xlsx"
      : lower.endsWith(".tsv")
      ? "tsv"
      : lower.endsWith(".md")
      ? "markdown"
      : "csv";
    const options: ExportOptions = { format, include_header: true, bom: format === "csv" || format === "tsv" };
    try {
      const res = await api.exportRows(cols, rows, options, path);
      toast.success(`已匯出 ${res.rows} 列 · ${format.toUpperCase()}`);
    } catch (e: any) {
      toast.error(e?.message ?? "匯出失敗");
    }
  };

  const TypeBadge = ({ t }: { t: string }) => {
    const meta = TYPE_META[t];
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta?.color ?? "#888" }} />
        <span className="text-fg/70">{meta?.label ?? t}</span>
      </span>
    );
  };

  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          進階物件搜尋
          <span className="text-xs text-fg/40 font-normal">名稱 · 定義 · 註解 · 萬用字元 · 整字</span>
        </span>
      }
      icon={Search}
      size="full"
      zClass="z-[95]"
      className="h-[86vh]"
      bodyClassName="p-0 flex flex-col min-h-0"
      footer={
        <>
          {results && (
            <span className="mr-auto text-xs text-fg/40">
              {results.length} 筆{truncated ? `（已達上限 ${LIMIT}）` : ""}　·　↑↓ 選擇、Enter 定位
            </span>
          )}
          <Button variant="secondary" icon={Download} onClick={() => void exportCsv()} disabled={!results?.length}>
            匯出 CSV
          </Button>
          <Button variant="secondary" onClick={onClose}>關閉</Button>
        </>
      }
    >
      <div className="flex flex-col min-h-0 flex-1" onKeyDown={onDialogKeyDown}>
        {/* 搜尋輸入 */}
        <div className="px-5 py-3 border-b border-fg/10 flex gap-2 items-center">
          <input
            autoFocus
            className="flex-1 bg-inset border border-fg/10 rounded px-2 py-1.5 text-sm outline-none focus:border-accent"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="即時搜尋名稱與定義內文…（↑↓ 選擇、Enter 在物件總管中選取）"
          />
          {busy && <span className="text-xs text-fg/40 shrink-0">搜尋中…</span>}
          <button
            type="button"
            onClick={() => void search()}
            disabled={!term.trim()}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40"
          >
            搜尋
          </button>
        </div>

        {/* 篩選列 */}
        <div className="px-5 py-2.5 border-b border-fg/10 flex flex-col gap-2 text-xs">
          {/* 比對範圍 + 大小寫 + 整字 + 萬用字元 + 資料庫 */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-fg/40">比對範圍：</span>
            <label className={`flex items-center gap-1 ${caps.nameOnly ? "opacity-60" : "cursor-pointer"}`}>
              <input
                type="checkbox"
                disabled={caps.nameOnly}
                checked={effMatchNames}
                onChange={(e) => setMatchNames(e.target.checked)}
              />
              名稱
            </label>
            <label className={`flex items-center gap-1 ${caps.defs ? "cursor-pointer" : "opacity-40"}`}>
              <input
                type="checkbox"
                disabled={!caps.defs}
                checked={caps.defs && matchDefs}
                onChange={(e) => setMatchDefs(e.target.checked)}
              />
              定義內文
            </label>
            <label className={`flex items-center gap-1 ${caps.comments ? "cursor-pointer" : "opacity-40"}`}>
              <input
                type="checkbox"
                disabled={!caps.comments}
                checked={caps.comments && matchComments}
                onChange={(e) => setMatchComments(e.target.checked)}
              />
              註解
            </label>
            <span className="w-px h-4 bg-fg/10" />
            {caps.caseSensitive && (
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
                區分大小寫
              </label>
            )}
            {caps.wholeWord && (
              <label
                className={`flex items-center gap-1 ${wildcards ? "opacity-40" : "cursor-pointer"}`}
                title="僅比對完整單字（底線 / 數字視為單字的一部分）"
              >
                <input
                  type="checkbox"
                  disabled={wildcards}
                  checked={wholeWord && !wildcards}
                  onChange={(e) => setWholeWord(e.target.checked)}
                />
                僅比對完整單字
              </label>
            )}
            {caps.wildcards && (
              <label className="flex items-center gap-1 cursor-pointer" title="* 比對任意長度、? 比對單一字元">
                <input type="checkbox" checked={wildcards} onChange={(e) => setWildcards(e.target.checked)} />
                使用萬用字元
              </label>
            )}

            {/* 資料庫多選 */}
            {dbs.length > 0 && (
              <div className="relative ml-auto">
                <button
                  type="button"
                  onClick={() => setDbPanel((v) => !v)}
                  className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/5 inline-flex items-center gap-1"
                >
                  資料庫：{allDbsOn ? `全部（${dbs.length}）` : `${selectedDbs.size}/${dbs.length}`}
                  <Icon icon={ChevronDown} size={13} />
                </button>
                {dbPanel && (
                  <>
                    <div className="fixed inset-0 z-[96]" onClick={() => setDbPanel(false)} />
                    <div className="absolute right-0 mt-1 z-[97] w-56 max-h-72 overflow-auto bg-elevated border border-fg/15 rounded-lg shadow-2xl p-1.5">
                      <div className="flex gap-2 px-1.5 py-1 border-b border-fg/10 mb-1">
                        <button type="button" className="text-blue-400 hover:underline" onClick={() => setSelectedDbs(new Set(dbs))}>全選</button>
                        <button type="button" className="text-fg/50 hover:underline" onClick={() => setSelectedDbs(new Set())}>清除</button>
                      </div>
                      {dbs.map((d) => (
                        <label key={d} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-fg/5 cursor-pointer">
                          <input type="checkbox" checked={selectedDbs.has(d)} onChange={() => toggleDb(d)} />
                          <span className="truncate" title={d}>{d}</span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* 物件型別 chips */}
          {allTypes.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-fg/40">物件型別：</span>
              <button
                type="button"
                onClick={() => setEnabledTypes(allTypesOn ? new Set() : new Set(allTypes))}
                className="px-2 py-0.5 rounded border border-fg/15 hover:bg-fg/5 text-fg/60"
              >
                {allTypesOn ? "全不選" : "全選"}
              </button>
              {allTypes.map((t) => {
                const on = enabledTypes.has(t);
                const meta = TYPE_META[t];
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleType(t)}
                    className={`px-2 py-0.5 rounded border flex items-center gap-1.5 ${
                      on ? "border-fg/20 bg-fg/5" : "border-fg/10 opacity-45"
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ background: meta?.color ?? "#888" }} />
                    {meta?.label ?? t}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 結果表格 + 底部預覽 */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-auto min-h-0">
            {err ? (
              <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
            ) : !results ? (
              <div className="text-fg/40 text-sm p-5">
                開始輸入即可即時搜尋連線上所有資料庫的物件（最多 {LIMIT} 筆）。
              </div>
            ) : results.length === 0 ? (
              <div className="text-fg/40 text-sm p-5">查無符合的物件。</div>
            ) : (
              <table className="text-sm border-collapse w-full">
                <thead className="sticky top-0 z-[1]">
                  <tr>
                    {COLS.map(({ col, label }) => (
                      <th
                        key={col}
                        scope="col"
                        tabIndex={0}
                        onClick={() => toggleSort(col)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleSort(col);
                          }
                        }}
                        {...(sort?.col === col ? { "aria-sort": sort.dir === "asc" ? "ascending" : "descending" } : {})}
                        className="text-left px-3 py-1.5 border-b border-fg/15 font-medium whitespace-nowrap cursor-pointer select-none hover:bg-fg/5 bg-inset"
                      >
                        {label}
                        {sort?.col === col && (
                          <Icon icon={sort.dir === "asc" ? ArrowUp : ArrowDown} size={12} className="ml-1 inline text-accent" />
                        )}
                      </th>
                    ))}
                    <th className="w-10 border-b border-fg/15 bg-inset" aria-label="定位" />
                  </tr>
                </thead>
                <tbody className="mono">
                  {sortedResults.map((h, i) => {
                    const active = i === activeIdx;
                    return (
                      <tr
                        key={`${h.database}.${h.parent ?? ""}.${h.object_name}.${h.object_type}.${i}`}
                        ref={(el) => {
                          rowRefs.current[i] = el;
                        }}
                        onClick={() => setActiveIdx(i)}
                        onDoubleClick={() => revealInTree(h)}
                        className={`cursor-pointer ${active ? "bg-blue-500/15" : "hover:bg-fg/5"}`}
                        title="雙擊 / Enter 在物件總管中選取"
                      >
                        <td className="px-3 py-1 truncate max-w-[240px] text-fg/85">{highlight(h.object_name, term, caseSensitive)}</td>
                        <td className="px-3 py-1 text-fg/60 truncate max-w-[200px]" title={`${h.database}${h.parent ? " · " + h.parent : ""}`}>
                          {h.database}
                          {h.parent ? ` · ${h.parent}` : ""}
                        </td>
                        <td className="px-3 py-1"><TypeBadge t={h.object_type} /></td>
                        <td className="px-3 py-1 text-fg/60">{MATCH_LABEL[h.matched_in] ?? h.matched_in}</td>
                        <td className="px-3 py-1 text-fg/50 truncate max-w-[360px]">
                          {h.snippet ? highlight(h.snippet, term, caseSensitive) : h.extra ?? ""}
                        </td>
                        <td className="px-1 text-center">
                          <button
                            type="button"
                            title="在物件總管中選取"
                            onClick={(e) => {
                              e.stopPropagation();
                              revealInTree(h);
                            }}
                            className="text-blue-400 hover:text-blue-300 align-middle"
                          >
                            <Icon icon={Crosshair} size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* 底部定義預覽窗格（可調高度） */}
          {preview && (
            <>
              <Splitter onPointerDown={previewPane.onPointerDown} />
              <div style={{ height: previewPane.size }} className="shrink-0 border-t border-fg/10 flex flex-col bg-well/40 min-h-0">
                <div className="px-3 py-2 border-b border-fg/10 flex items-center gap-2 text-xs">
                  <TypeBadge t={preview.hit.object_type} />
                  <span className="mono truncate" title={preview.hit.object_name}>{preview.hit.object_name}</span>
                  <button
                    type="button"
                    onClick={() => revealInTree(preview.hit)}
                    className="ml-2 text-blue-400 hover:underline inline-flex items-center gap-1"
                  >
                    <Icon icon={Crosshair} size={13} />在物件總管中選取
                  </button>
                  <button
                    type="button"
                    aria-label="關閉預覽"
                    title="關閉預覽"
                    onClick={() => setPreview(null)}
                    className="ml-auto text-fg/40 hover:text-fg"
                  >
                    <Icon icon={X} size={16} />
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-3 text-[11px] mono whitespace-pre-wrap leading-relaxed">
                  {preview.loading ? (
                    <span className="text-fg/40">讀取中…</span>
                  ) : preview.err ? (
                    <span className="text-red-300">{preview.err}</span>
                  ) : (
                    highlight(preview.ddl ?? "", term, caseSensitive)
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// 拖曳把手（底部窗格用；內嵌精簡版，對標 App.tsx 的 Splitter axis="y"）。
function Splitter({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="horizontal"
      className="shrink-0 h-1 cursor-row-resize bg-fg/10 hover:bg-accent/60 active:bg-accent transition-colors"
    />
  );
}
