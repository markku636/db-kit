import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, KeyRound, Circle } from "lucide-react";
import { api } from "./api";
import Icon from "./ui/Icon";
import { useT } from "./i18n";
import {
  compareSegments, redisPatternHistoryKey, recordRedisPattern, normalizeAutoRefreshMs,
  loadExpandedPaths, redisExpandedKey,
} from "./redisUiFormat";
import { buildRedisTree, keysUnderPrefix, segmentLabel, toggleKeySelection, redisSeparatorKey, type RedisTreeNode } from "./redisTree";

export const REDIS_TREE_LIMIT = 10000;
const LIMIT = REDIS_TREE_LIMIT;
const INDENT = 14;

type Row =
  | { kind: "folder"; seg: string; path: string; depth: number; count: number; expanded: boolean; selfKey?: string }
  | { kind: "leaf"; seg: string; key: string; depth: number };

function flatten(root: RedisTreeNode, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const sorted = (n: RedisTreeNode) => [...n.children.values()].sort((a, b) => compareSegments(a.seg, b.seg));
  const walk = (node: RedisTreeNode, depth: number) => {
    for (const child of sorted(node)) {
      if (child.children.size > 0) {
        const isExp = expanded.has(child.path);
        // 此節點本身可能也是一個完整 key（既是資料夾又是鍵）→ selfKey 帶出，
        // 由資料夾列名稱直接開啟，確保收合時仍可存取（不再藏進展開區塊內）。
        rows.push({ kind: "folder", seg: child.seg, path: child.path, depth, count: child.count, expanded: isExp, selfKey: child.leafKey });
        if (isExp) walk(child, depth + 1);
      } else {
        rows.push({ kind: "leaf", seg: child.seg, key: child.leafKey ?? child.path, depth });
      }
    }
  };
  walk(root, 0);
  return rows;
}

// 收集所有資料夾路徑（供「展開全部」）。
function allFolderPaths(root: RedisTreeNode): string[] {
  const paths: string[] = [];
  const walk = (n: RedisTreeNode) => {
    for (const ch of n.children.values()) {
      if (ch.children.size > 0) { paths.push(ch.path); walk(ch); }
    }
  };
  walk(root);
  return paths;
}

// Redis 命名空間鍵樹：仿 Another Redis Desktop Manager 的左側鍵樹，
// 把 user:1:name 之類的鍵依 ":" 分組成可摺疊資料夾。葉節點＝實際鍵。
export default function RedisKeyTree({ connId, database, nonce, focus, onOpenKey, onContextKey, onContextFolder, onContextBlank, onBulkDelete, onImportKeys }: {
  connId: string;
  database: string;
  nonce: number;
  // 外部要求把 SCAN MATCH 樣式換掉（右鍵「只顯示此命名空間 / 顯示全部鍵」）。
  // 帶 seq 是為了讓「同一個樣式再按一次」也能重新套用。
  focus?: { pattern: string; seq: number; exactKeys?: string[] } | null;
  onOpenKey: (key: string) => void;
  onContextKey: (key: string, x: number, y: number) => void;
  // 資料夾（命名空間）右鍵：帶出該前綴與其底下所有鍵，供「在此新增鍵 / 整段刪除」。
  onContextFolder?: (prefix: string, keys: string[], truncated: boolean, x: number, y: number) => void;
  // 空白處右鍵：只提供「新增鍵 / 重新整理」。
  onContextBlank?: (x: number, y: number) => void;
  // 多選模式下的批次刪除（仿 ARDM 的 Multiple Select/Delete）。
  onBulkDelete?: (keys: string[]) => void;
  // 由父層提供的匯入 JSON 動作（唯讀連線不傳入，按鈕就不顯示）。
  onImportKeys?: () => void;
}) {
  const t = useT();
  const [patternInput, setPatternInput] = useState("*");
  const [pattern, setPattern] = useState("*");
  // ARDM 的 search history：過濾樣式記在瀏覽器，下次直接從下拉選舊的。
  const [patternHistory, setPatternHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(redisPatternHistoryKey(connId, database));
      const v: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    } catch { return []; }
  });
  const [keys, setKeys] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return loadExpandedPaths(localStorage.getItem(redisExpandedKey(connId, database))); }
    catch { return new Set(); }
  });
  const persistExpanded = (next: Set<string>) => {
    try { localStorage.setItem(redisExpandedKey(connId, database), JSON.stringify([...next])); } catch { /* 忽略 */ }
  };
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [autoRefreshMs, setAutoRefreshMs] = useState<number>(() => {
    try { return normalizeAutoRefreshMs(localStorage.getItem(`dbkit:redisAutoRefresh:${connId}:${database}`)); }
    catch { return 0; }
  });
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    const id = window.setInterval(() => setRefreshNonce((n) => n + 1), autoRefreshMs);
    return () => window.clearInterval(id);
  }, [autoRefreshMs]);
  // ARDM 的 --separator：某些命名慣例用 / 或 :: 分層，固定冒號會整包擠在同一層。
  const [separator, setSeparator] = useState<string>(() => {
    try {
      return localStorage.getItem(redisSeparatorKey(connId, database)) ?? ":";
    } catch { return ":"; }
  });
  const didInit = useRef(false);
  // 資料夾節點本身也可能是一個 key（user 與 user:name 同時存在）；SCAN 樣式 user:* 不會
  // 帶回 user，所以由選單額外傳進來，在取樣後合併，避免這個鍵憑空消失。
  const exactKeysRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .redisKeys(connId, database, pattern || "*", LIMIT)
      .then((res) => {
        if (cancelled) return;
        const extra = exactKeysRef.current;
        setKeys(extra.length ? [...new Set([...res.keys, ...extra])] : res.keys);
        setTruncated(res.truncated);
      })
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [connId, database, pattern, nonce, refreshNonce]);

  // 外部（右鍵選單）換樣式：同步輸入框與實際查詢的樣式，並重置「首次自動展開」的判定，
  // 讓縮到單一命名空間後可以再次自動展開。
  useEffect(() => {
    if (!focus) return;
    exactKeysRef.current = focus.exactKeys ?? [];
    setPatternInput(focus.pattern);
    setPattern(focus.pattern);
    didInit.current = false;
  }, [focus?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const tree = useMemo(() => (keys ? buildRedisTree(keys, separator) : null), [keys, separator]);

  // 首次載入：鍵不多時自動展開全部，方便瀏覽。
  useEffect(() => {
    if (!tree || didInit.current) return;
    didInit.current = true;
    if ((keys?.length ?? 0) <= 200) { const n = new Set(allFolderPaths(tree)); setExpanded(n); persistExpanded(n); }
  }, [tree, keys]);

  const rows = useMemo(() => (tree ? flatten(tree, expanded) : []), [tree, expanded]);

  const toggle = (path: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      persistExpanded(n);
      return n;
    });

  const activateKey = (key: string) => {
    if (multiSelect) setSelectedKeys((s) => toggleKeySelection(s, key));
    else onOpenKey(key);
  };
  const selectedClass = (key: string) =>
    multiSelect && selectedKeys.has(key) ? "bg-accent/20 ring-1 ring-accent/50" : "";

  const apply = () => {
    const next = patternInput.trim() || "*";
    setPattern(next);
    setPatternHistory((h) => {
      const updated = recordRedisPattern(h, next);
      try { localStorage.setItem(redisPatternHistoryKey(connId, database), JSON.stringify(updated)); } catch { /* 忽略 */ }
      return updated;
    });
  };

  // 某命名空間底下的所有鍵（含「自己也是一個鍵」的節點）。前綴比對走原字串，不經 glob。
  const keysUnder = (prefix: string) => keysUnderPrefix(keys ?? [], prefix, separator);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 工具列：MATCH 樣式 + 展開/收合 */}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1 bg-inset border-b border-fg/10 text-xs">
        <input
          value={patternInput}
          list="redis-pattern-history"
          onChange={(e) => setPatternInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) apply(); }}
          placeholder={t("MATCH 樣式，如 user:*")}
          className="w-48 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent"
        />
        <datalist id="redis-pattern-history">
          {patternHistory.map((p) => <option key={p} value={p} />)}
        </datalist>
        <button type="button" onClick={apply} className="px-2 py-1 rounded hover:bg-fg/10 whitespace-nowrap text-fg/60">{t("套用")}</button>
        <div className="w-px h-4 bg-fg/10 mx-1" />
        <button type="button" onClick={() => { if (tree) { const n = new Set(allFolderPaths(tree)); setExpanded(n); persistExpanded(n); } }}
          className="px-2 py-1 rounded hover:bg-fg/10 whitespace-nowrap text-fg/60">{t("展開全部")}</button>
        <button type="button" onClick={() => { setExpanded(new Set()); persistExpanded(new Set()); }}
          className="px-2 py-1 rounded hover:bg-fg/10 whitespace-nowrap text-fg/60">{t("收合全部")}</button>
        <label className="ml-2 flex items-center gap-1 text-fg/40" title={t("鍵名分層用的分隔符，預設為 :（對應 ARDM 的 --separator）")}>
          {t("分隔")}
          <input
            value={separator}
            onChange={(e) => {
              const next = e.target.value || ":";
              setSeparator(next);
              setExpanded(new Set());
              try { localStorage.setItem(redisSeparatorKey(connId, database), next); } catch { /* 忽略 */ }
            }}
            aria-label={t("鍵名分隔符")}
            className="w-10 bg-inset border border-fg/10 rounded px-1 py-0.5 mono outline-none focus:border-accent text-center"
          />
        </label>
        {onBulkDelete && <button type="button" onClick={() => { setMultiSelect((v) => !v); setSelectedKeys(new Set()); }}
          title={t("多選鍵後一次刪除（仿 ARDM）")}
          className={`px-2 py-1 rounded border whitespace-nowrap ${multiSelect ? "border-accent text-accent" : "border-fg/15 text-fg/50 hover:bg-fg/10"}`}>
          {t("多選")}
        </button>}
        {onImportKeys && <button type="button" onClick={onImportKeys} title={t("從 JSON 檔匯入鍵（仿 ARDM）")}
          className="px-2 py-1 rounded border border-fg/15 text-fg/50 hover:bg-fg/10 whitespace-nowrap">{t("匯入鍵")}</button>}
        {onBulkDelete && multiSelect && selectedKeys.size > 0 && (
          <>
            <span className="text-fg/40">{t("已選 {n}", { n: selectedKeys.size })}</span>
            <button type="button" onClick={() => { onBulkDelete?.([...selectedKeys]); setSelectedKeys(new Set()); }}
              className="px-2 py-1 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15">{t("刪除選取")}</button>
            <button type="button" onClick={() => setSelectedKeys(new Set())}
              className="px-2 py-1 rounded border border-fg/15 text-fg/50 hover:bg-fg/10">{t("清除")}</button>
          </>
        )}
        <select value={autoRefreshMs} aria-label={t("自動重整")} title={t("自動重整鍵樹（仿 ARDM）")}
          onChange={(e) => {
            const next = normalizeAutoRefreshMs(e.target.value);
            setAutoRefreshMs(next);
            try { localStorage.setItem(`dbkit:redisAutoRefresh:${connId}:${database}`, String(next)); } catch { /* 忽略 */ }
          }}
          className="bg-inset border border-fg/10 rounded px-1 py-0.5 text-xs text-fg/50 outline-none focus:border-accent">
          <option value={0}>{t("自動重整：關")}</option>
          <option value={5000}>5s</option>
          <option value={15000}>15s</option>
          <option value={30000}>30s</option>
        </select>
        <span className="ml-auto text-fg/40">
          {loading ? t("讀取中…") : keys ? t("{count} 個鍵", { count: keys.length }) + (truncated ? t("（已達 {LIMIT} 上限）", { LIMIT }) : "") : ""}
        </span>
      </div>

      <div
        className="flex-1 overflow-auto py-1"
        onContextMenu={(e) => {
          if (!onContextBlank) return;
          e.preventDefault();
          onContextBlank(e.clientX, e.clientY);
        }}
      >
        {err && <div className="p-3 text-red-400 text-sm mono break-all">{err}</div>}
        {truncated && (
          <div className="mx-2 mb-1 px-2 py-1 rounded bg-amber-500/10 text-amber-300 text-[11px]">
            {t("鍵數超過 {LIMIT}，僅顯示前 {LIMIT} 個；可用 MATCH 樣式縮小範圍。", { LIMIT })}
          </div>
        )}
        {keys && keys.length === 0 && !err && (
          <div className="p-3 text-fg/40 text-sm">{t("（無符合的鍵）")}</div>
        )}
        {rows.map((r, i) =>
          r.kind === "folder" ? (
            <div
              key={`f:${r.path}`}
              onClick={() => toggle(r.path)}
              onContextMenu={(e) => {
                if (!onContextFolder) return;
                e.preventDefault();
                e.stopPropagation();
                onContextFolder(r.path, keysUnder(r.path), truncated, e.clientX, e.clientY);
              }}
              title={t("命名空間 {path}（{count} 個鍵）；右鍵可在此新增鍵或整段刪除", { path: r.path, count: r.count })}
              style={{ paddingLeft: 8 + r.depth * INDENT }}
              className="flex items-center gap-1 pr-3 py-0.5 cursor-pointer hover:bg-fg/5 text-sm select-none"
            >
              <span className="text-fg/30 w-3 inline-flex items-center justify-center">
                <Icon icon={ChevronRight} size={12} className={r.expanded ? "transition-transform rotate-90" : "transition-transform"} />
              </span>
              <Icon icon={Folder} size={14} className="text-amber-300/80" />
              {r.selfKey != null ? (
                <span
                  onClick={(e) => { e.stopPropagation(); activateKey(r.selfKey!); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextKey(r.selfKey!, e.clientX, e.clientY); }}
                  title={t("{selfKey}（此節點本身也是一個鍵，點此開啟）", { selfKey: r.selfKey })}
                  className={`truncate text-blue-300 hover:underline ${selectedClass(r.selfKey!)}`}
                >{segmentLabel(r.seg)}</span>
              ) : (
                <span className="truncate text-fg/80">{segmentLabel(r.seg)}</span>
              )}
              <span className="text-[10px] text-fg/30 ml-1">({r.count})</span>
              {r.selfKey != null && <Icon icon={KeyRound} size={12} className="text-blue-300/70 ml-0.5" title={t("此節點本身也是一個鍵")} />}
            </div>
          ) : (
            <div
              key={`k:${r.key}:${i}`}
              onClick={() => activateKey(r.key)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextKey(r.key, e.clientX, e.clientY); }}
              title={r.key}
              style={{ paddingLeft: 8 + r.depth * INDENT + 16 }}
              className={`flex items-center gap-1.5 pr-3 py-0.5 cursor-pointer hover:bg-fg/5 text-sm mono text-blue-300/90 ${selectedClass(r.key)}`}
            >
              <Icon icon={Circle} size={10} className="text-fg/25" />
              <span className="truncate">{segmentLabel(r.seg)}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
