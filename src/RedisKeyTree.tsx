import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, KeyRound, Circle } from "lucide-react";
import { api } from "./api";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

const LIMIT = 10000;
const SEP = ":";
const INDENT = 14;

// 命名空間樹節點：依 ":" 切分 key 而成的資料夾結構。
interface TNode {
  seg: string;                 // 此層片段名
  path: string;                // 累積路徑
  children: Map<string, TNode>;
  leafKey?: string;            // 此節點本身是一個完整 key 時的鍵名
  count: number;               // 子樹內的鍵數（含自身）
}

type Row =
  | { kind: "folder"; seg: string; path: string; depth: number; count: number; expanded: boolean; selfKey?: string }
  | { kind: "leaf"; seg: string; key: string; depth: number };

function buildTree(keys: string[]): TNode {
  const root: TNode = { seg: "", path: "", children: new Map(), count: 0 };
  for (const key of keys) {
    const parts = key.split(SEP);
    let node = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = i === 0 ? parts[i] : `${acc}${SEP}${parts[i]}`;
      let child = node.children.get(parts[i]);
      if (!child) {
        child = { seg: parts[i], path: acc, children: new Map(), count: 0 };
        node.children.set(parts[i], child);
      }
      node = child;
    }
    node.leafKey = key;
  }
  const count = (n: TNode): number => {
    let c = n.leafKey != null ? 1 : 0;
    for (const ch of n.children.values()) c += count(ch);
    n.count = c;
    return c;
  };
  count(root);
  return root;
}

function flatten(root: TNode, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const sorted = (n: TNode) => [...n.children.values()].sort((a, b) => a.seg.localeCompare(b.seg));
  const walk = (node: TNode, depth: number) => {
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
function allFolderPaths(root: TNode): string[] {
  const paths: string[] = [];
  const walk = (n: TNode) => {
    for (const ch of n.children.values()) {
      if (ch.children.size > 0) { paths.push(ch.path); walk(ch); }
    }
  };
  walk(root);
  return paths;
}

// Redis 命名空間鍵樹：仿 Another Redis Desktop Manager 的左側鍵樹，
// 把 user:1:name 之類的鍵依 ":" 分組成可摺疊資料夾。葉節點＝實際鍵。
export default function RedisKeyTree({ connId, database, nonce, onOpenKey, onContextKey }: {
  connId: string;
  database: string;
  nonce: number;
  onOpenKey: (key: string) => void;
  onContextKey: (key: string, x: number, y: number) => void;
}) {
  const t = useT();
  const [patternInput, setPatternInput] = useState("*");
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const didInit = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .redisKeys(connId, database, pattern || "*", LIMIT)
      .then((res) => {
        if (cancelled) return;
        setKeys(res.keys);
        setTruncated(res.truncated);
      })
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [connId, database, pattern, nonce]);

  const tree = useMemo(() => (keys ? buildTree(keys) : null), [keys]);

  // 首次載入：鍵不多時自動展開全部，方便瀏覽。
  useEffect(() => {
    if (!tree || didInit.current) return;
    didInit.current = true;
    if ((keys?.length ?? 0) <= 200) setExpanded(new Set(allFolderPaths(tree)));
  }, [tree, keys]);

  const rows = useMemo(() => (tree ? flatten(tree, expanded) : []), [tree, expanded]);

  const toggle = (path: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });

  const apply = () => setPattern(patternInput.trim() || "*");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 工具列：MATCH 樣式 + 展開/收合 */}
      <div className="flex items-center gap-1 px-2 py-1 bg-inset border-b border-fg/10 text-xs">
        <input
          value={patternInput}
          onChange={(e) => setPatternInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) apply(); }}
          placeholder={t("MATCH 樣式，如 user:*")}
          className="w-48 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent"
        />
        <button type="button" onClick={apply} className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60">{t("套用")}</button>
        <div className="w-px h-4 bg-fg/10 mx-1" />
        <button type="button" onClick={() => tree && setExpanded(new Set(allFolderPaths(tree)))}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60">{t("展開全部")}</button>
        <button type="button" onClick={() => setExpanded(new Set())}
          className="px-2 py-1 rounded hover:bg-fg/10 text-fg/60">{t("收合全部")}</button>
        <span className="ml-auto text-fg/40">
          {loading ? t("讀取中…") : keys ? `${keys.length} 個鍵${truncated ? t("（已達 {LIMIT} 上限）", { LIMIT }) : ""}` : ""}
        </span>
      </div>

      <div className="flex-1 overflow-auto py-1">
        {err && <div className="p-3 text-red-400 text-sm mono break-all">{err}</div>}
        {truncated && (
          <div className="mx-2 mb-1 px-2 py-1 rounded bg-amber-500/10 text-amber-300 text-[11px]">
            鍵數超過 {LIMIT}，僅顯示前 {LIMIT} 個；可用 MATCH 樣式縮小範圍。
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
              style={{ paddingLeft: 8 + r.depth * INDENT }}
              className="flex items-center gap-1 pr-3 py-0.5 cursor-pointer hover:bg-fg/5 text-sm select-none"
            >
              <span className="text-fg/30 w-3 inline-flex items-center justify-center">
                <Icon icon={ChevronRight} size={12} className={r.expanded ? "transition-transform rotate-90" : "transition-transform"} />
              </span>
              <Icon icon={Folder} size={14} className="text-amber-300/80" />
              {r.selfKey != null ? (
                <span
                  onClick={(e) => { e.stopPropagation(); onOpenKey(r.selfKey!); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextKey(r.selfKey!, e.clientX, e.clientY); }}
                  title={t("{selfKey}（此節點本身也是一個鍵，點此開啟）", { selfKey: r.selfKey })}
                  className="truncate text-blue-300 hover:underline"
                >{r.seg}</span>
              ) : (
                <span className="truncate text-fg/80">{r.seg}</span>
              )}
              <span className="text-[10px] text-fg/30 ml-1">({r.count})</span>
              {r.selfKey != null && <Icon icon={KeyRound} size={12} className="text-blue-300/70 ml-0.5" title={t("此節點本身也是一個鍵")} />}
            </div>
          ) : (
            <div
              key={`k:${r.key}:${i}`}
              onClick={() => onOpenKey(r.key)}
              onContextMenu={(e) => { e.preventDefault(); onContextKey(r.key, e.clientX, e.clientY); }}
              title={r.key}
              style={{ paddingLeft: 8 + r.depth * INDENT + 16 }}
              className="flex items-center gap-1.5 pr-3 py-0.5 cursor-pointer hover:bg-fg/5 text-sm mono text-blue-300/90"
            >
              <Icon icon={Circle} size={10} className="text-fg/25" />
              <span className="truncate">{r.seg}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
