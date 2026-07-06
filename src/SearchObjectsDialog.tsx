import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { api, DbKind, SearchHit, SearchOptions } from "./api";
import { useStore } from "./store";
import { toast } from "./ui";
import { Modal, Button } from "./ui/index";
import Icon from "./ui/Icon";

// 全資料庫物件搜尋（致敬 Red Gate SQL Search）。
// 不只比對名稱，也比對 view / procedure / function / trigger 的「定義內文」與註解，
// 跨連線上所有資料庫 / schema；以後端 search_objects（參數綁定，防注入）實作。
// 體驗：即時搜尋（debounce）、↑↓ / Enter 鍵盤導覽、記住上次的比對範圍與型別篩選。

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

// 各資料庫種類可搜尋的物件型別（顯示順序＝結果分組順序）。
function typesForKind(kind: DbKind): string[] {
  switch (kind) {
    case "sqlite":
      return ["table", "view", "column", "index", "trigger"];
    case "mongo":
      return ["collection"];
    case "redis":
      return ["key"];
    default: // mysql / postgres
      return ["table", "view", "column", "index", "procedure", "function", "trigger", "foreign_key"];
  }
}

// 可檢視完整定義（DDL）的型別。
const canViewDef = (t: string) => ["view", "procedure", "function", "trigger"].includes(t);

// 篩選偏好持久化（跨開啟記住比對範圍與型別；資料庫選擇因連線而異，不持久化）。
const PREFS_KEY = "dbkit:sqlsearch:prefs";
type Prefs = {
  types?: string[];
  matchNames?: boolean;
  matchDefs?: boolean;
  matchComments?: boolean;
  caseSensitive?: boolean;
};
function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

// 把命中文字以 <mark> 高亮（依大小寫模式）。
function highlight(text: string, term: string, cs: boolean) {
  if (!term) return text;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, cs ? "g" : "gi"));
  return parts.map((p, i) => {
    const isHit = cs ? p === term : p.toLowerCase() === term.toLowerCase();
    return isHit ? (
      <mark key={i} className="bg-blue-500/40 text-fg rounded px-0.5">{p}</mark>
    ) : (
      <span key={i}>{p}</span>
    );
  });
}

export default function SearchObjectsDialog({ connId, kind, onClose }: {
  connId: string;
  kind: DbKind;
  onClose: () => void;
}) {
  const allTypes = useMemo(() => typesForKind(kind), [kind]);
  const supportsDefs = kind === "mysql" || kind === "mariadb" || kind === "postgres" || kind === "sqlite";
  const supportsComments = kind === "mysql" || kind === "mariadb" || kind === "postgres" || kind === "oracle";
  const prefs = useMemo(loadPrefs, []);

  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0); // 鍵盤導覽選取的扁平索引

  // 篩選狀態（從上次偏好還原）
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(() => {
    const saved = prefs.types?.filter((t) => allTypes.includes(t));
    return saved && saved.length ? new Set(saved) : new Set(allTypes);
  });
  const [matchNames, setMatchNames] = useState(prefs.matchNames ?? true);
  const [matchDefs, setMatchDefs] = useState(prefs.matchDefs ?? true);
  const [matchComments, setMatchComments] = useState(prefs.matchComments ?? true);
  const [caseSensitive, setCaseSensitive] = useState(prefs.caseSensitive ?? false);

  // 資料庫多選
  const [dbs, setDbs] = useState<string[]>([]);
  const [selectedDbs, setSelectedDbs] = useState<Set<string>>(new Set());
  const [dbPanel, setDbPanel] = useState(false);

  // 定義預覽
  const [preview, setPreview] = useState<{ hit: SearchHit; ddl: string | null; loading: boolean; err: string | null } | null>(null);

  const LIMIT = 500;
  const aliveRef = useRef(true);
  const seqRef = useRef(0); // 即時搜尋的請求序號，丟棄過期回應（避免亂序覆寫）
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
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
        JSON.stringify({ types: Array.from(enabledTypes), matchNames, matchDefs, matchComments, caseSensitive } as Prefs)
      );
    } catch {
      /* 忽略 localStorage 失敗（無痕模式等） */
    }
  }, [enabledTypes, matchNames, matchDefs, matchComments, caseSensitive]);

  const hasScope = matchNames || (supportsDefs && matchDefs) || (supportsComments && matchComments);
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
      match_names: matchNames,
      match_definitions: supportsDefs && matchDefs,
      match_comments: supportsComments && matchComments,
      case_sensitive: caseSensitive,
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
  }, [term, enabledTypes, matchNames, matchDefs, matchComments, caseSensitive, selectedDbs, dbs]);

  // 雙擊 / Enter → 開啟對應資料表 / 集合。
  const navigate = (h: SearchHit) => {
    let table: string | null = null;
    if (h.object_type === "table" || h.object_type === "view" || h.object_type === "collection") {
      table = h.object_name;
    } else if (["column", "index", "trigger", "foreign_key"].includes(h.object_type)) {
      table = h.parent ?? null;
    }
    if (table) {
      useStore.getState().openTable(connId, h.database, table);
      onClose();
    } else {
      toast.info("此結果無法直接開啟資料表");
    }
  };

  const showDef = async (h: SearchHit) => {
    setPreview({ hit: h, ddl: null, loading: true, err: null });
    try {
      const ddl =
        h.object_type === "view"
          ? await api.tableDdl(connId, h.database, h.object_name)
          : await api.routineDefinition(connId, h.database, h.object_name, h.object_type);
      if (!aliveRef.current) return;
      setPreview({ hit: h, ddl, loading: false, err: null });
    } catch (e: any) {
      if (!aliveRef.current) return;
      setPreview({ hit: h, ddl: null, loading: false, err: e?.message ?? "讀取定義失敗" });
    }
  };

  // 依型別分組（保留 allTypes 的顯示順序；後端已於型別內依相關性排序）。
  const grouped = useMemo(() => {
    if (!results) return [];
    const byType = new Map<string, SearchHit[]>();
    for (const h of results) {
      const arr = byType.get(h.object_type) ?? [];
      arr.push(h);
      byType.set(h.object_type, arr);
    }
    const order = [...allTypes, ...Array.from(byType.keys()).filter((t) => !allTypes.includes(t))];
    return order.filter((t) => byType.has(t)).map((t) => ({ type: t, hits: byType.get(t)! }));
  }, [results, allTypes]);

  // 扁平化（鍵盤導覽用），與顯示順序一致；各分組的起始扁平索引。
  const flat = useMemo(() => grouped.flatMap((g) => g.hits), [grouped]);
  const groupOffsets = useMemo(() => {
    const offs: number[] = [];
    let acc = 0;
    for (const g of grouped) {
      offs.push(acc);
      acc += g.hits.length;
    }
    return offs;
  }, [grouped]);

  // 選取項捲動進可視範圍。
  useEffect(() => {
    rowRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // 對話框鍵盤：↑↓ 移動選取、Enter 開啟選取項（無結果時 Enter 立即搜尋）。
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      if (!flat.length) return;
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      if (!flat.length) return;
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat.length) {
        const h = flat[Math.max(0, Math.min(activeIdx, flat.length - 1))];
        if (h) navigate(h);
      } else {
        void search();
      }
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          SQL Search · 全資料庫物件搜尋
          <span className="text-xs text-fg/40 font-normal">名稱 · 定義內文 · 註解</span>
        </span>
      }
      icon={Search}
      size="full"
      zClass="z-[95]"
      className="h-[82vh]"
      bodyClassName="p-0 flex flex-col min-h-0"
      footer={
        <>
          {results && (
            <span className="mr-auto text-xs text-fg/40">
              {results.length} 筆{truncated ? `（已達上限 ${LIMIT}）` : ""}　·　↑↓ 選擇、Enter / 雙擊開啟
            </span>
          )}
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
            placeholder="即時搜尋名稱與定義內文…（↑↓ 選擇、Enter 開啟）"
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
          {/* 比對範圍 + 大小寫 + 資料庫 */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-fg/40">比對範圍：</span>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={matchNames} onChange={(e) => setMatchNames(e.target.checked)} />
              名稱
            </label>
            <label className={`flex items-center gap-1 ${supportsDefs ? "cursor-pointer" : "opacity-40"}`}>
              <input
                type="checkbox"
                disabled={!supportsDefs}
                checked={supportsDefs && matchDefs}
                onChange={(e) => setMatchDefs(e.target.checked)}
              />
              定義內文
            </label>
            <label className={`flex items-center gap-1 ${supportsComments ? "cursor-pointer" : "opacity-40"}`}>
              <input
                type="checkbox"
                disabled={!supportsComments}
                checked={supportsComments && matchComments}
                onChange={(e) => setMatchComments(e.target.checked)}
              />
              註解
            </label>
            <span className="w-px h-4 bg-fg/10" />
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
              區分大小寫
            </label>

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

        {/* 結果 + 預覽 */}
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 overflow-auto min-w-0">
            {err ? (
              <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
            ) : !results ? (
              <div className="text-fg/40 text-sm p-5">
                開始輸入即可即時搜尋連線上所有資料庫的物件（最多 {LIMIT} 筆）。
              </div>
            ) : results.length === 0 ? (
              <div className="text-fg/40 text-sm p-5">查無符合的物件。</div>
            ) : (
              grouped.map((g, gi) => {
                const meta = TYPE_META[g.type];
                return (
                  <div key={g.type}>
                    <div className="sticky top-0 bg-inset/95 backdrop-blur px-4 py-1.5 flex items-center gap-2 text-xs text-fg/55 border-b border-fg/5">
                      <span className="w-2 h-2 rounded-full" style={{ background: meta?.color ?? "#888" }} />
                      <span className="font-medium">{meta?.label ?? g.type}</span>
                      <span className="text-fg/35">{g.hits.length}</span>
                    </div>
                    {g.hits.map((h, i) => {
                      const flatIdx = groupOffsets[gi] + i;
                      const active = flatIdx === activeIdx;
                      return (
                        <div
                          key={`${h.database}.${h.parent ?? ""}.${h.object_name}.${i}`}
                          ref={(el) => {
                            rowRefs.current[flatIdx] = el;
                          }}
                          onClick={() => setActiveIdx(flatIdx)}
                          onDoubleClick={() => navigate(h)}
                          className={`px-4 py-1.5 border-b border-fg/5 cursor-pointer group ${
                            active ? "bg-blue-500/15" : "hover:bg-fg/5"
                          }`}
                          title="雙擊或 Enter 開啟對應資料表 / 集合"
                        >
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-fg/85 mono truncate">
                              {highlight(h.object_name, term, caseSensitive)}
                            </span>
                            <span className="text-[10px] px-1 rounded bg-fg/10 text-fg/50 shrink-0">
                              {MATCH_LABEL[h.matched_in] ?? h.matched_in}
                            </span>
                            {h.extra && <span className="text-fg/35 mono truncate">{h.extra}</span>}
                            <span className="ml-auto text-fg/35 shrink-0 truncate" title={`${h.database}${h.parent ? " · " + h.parent : ""}`}>
                              {h.database}
                              {h.parent ? ` · ${h.parent}` : ""}
                            </span>
                            {canViewDef(h.object_type) && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void showDef(h);
                                }}
                                className="shrink-0 text-blue-400 hover:underline opacity-0 group-hover:opacity-100"
                              >
                                定義
                              </button>
                            )}
                          </div>
                          {h.snippet && (
                            <div className="mt-0.5 text-[11px] text-fg/45 mono truncate">
                              {highlight(h.snippet, term, caseSensitive)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          {/* 定義預覽側欄 */}
          {preview && (
            <div className="w-[400px] shrink-0 border-l border-fg/10 flex flex-col bg-well/40">
              <div className="px-3 py-2 border-b border-fg/10 flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-full" style={{ background: TYPE_META[preview.hit.object_type]?.color ?? "#888" }} />
                <span className="mono truncate" title={preview.hit.object_name}>{preview.hit.object_name}</span>
                <button type="button" aria-label="關閉預覽" title="關閉預覽" onClick={() => setPreview(null)} className="ml-auto text-fg/40 hover:text-fg"><Icon icon={X} size={16} /></button>
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
          )}
        </div>
      </div>
    </Modal>
  );
}
