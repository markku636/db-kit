// 資料夾比對：兩邊的樹並排（同一列 = 同一個相對路徑），顏色標出相同 / 不同 / 只在一邊；
// 選取項目可以複製到另一邊、刪除、比對內容，或用同步規則（鏡像 / 更新）一次處理整棵樹。
//
// 掃描與對齊在後端（fcmp_scan），這裡只負責樹、篩選、選取與把操作送回後端（fcmp_sync）。
// 同步完一律重新掃描：以實際的檔案系統為準，不自己推測同步後的狀態。
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowLeftToLine, ArrowRightToLine, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, File, FileSearch,
  Folder, RefreshCw, Settings2, Square, Trash2, Workflow,
} from "lucide-react";
import { api, onFcmpProgress } from "./api";
import { useT } from "./i18n";
import { useStore } from "./store";
import { Button, Icon, IconButton, Input, MenuPanel, Modal, Segmented, Select, Spinner } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import { fmtBytes } from "./dockerModel";
import type { FcmpProgress, FolderDiff, SyncOp, SyncReport } from "./compareTypes";
import type { CompareMode } from "./compareTabs";
import { newJobId, sideSpec, type ReadySide } from "./compareIo";
import { DEFAULT_FOLDER, folderOpts, type FolderSettings } from "./compareSessions";
import {
  buildTree, contentCandidates, countFiles, dirKeys, flatten, opsForSelection, planSync, reaggregate,
  type FolderFilter, type SyncRule, type TreeNode,
} from "./folderCompareModel";
import { errCode, errMsg } from "./useRemoteSession";

const ROW_H = 24;
const LAST_SETTINGS = "dbk.compare.folder";
/** 掃描結果超過這麼多個項目就不自動全部展開（展開整棵二十萬項的樹會卡住畫面）。 */
const AUTO_EXPAND_MAX = 3000;

function loadLastSettings(): FolderSettings {
  try {
    const raw = localStorage.getItem(LAST_SETTINGS);
    return raw ? { ...DEFAULT_FOLDER, ...(JSON.parse(raw) as Partial<FolderSettings>) } : DEFAULT_FOLDER;
  } catch {
    return DEFAULT_FOLDER;
  }
}
function saveLastSettings(s: FolderSettings) {
  try { localStorage.setItem(LAST_SETTINGS, JSON.stringify(s)); } catch { /* ignore */ }
}

function fmtTime(sec: number | null): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 狀態 → 名稱的顏色與中間那欄的符號。 */
function statusStyle(n: TreeNode): { cls: string; glyph: string } {
  switch (n.status) {
    case "same": return { cls: "text-fg/75", glyph: "=" };
    case "diff": return { cls: "text-danger", glyph: n.row.newer === "left" ? "◀≠" : n.row.newer === "right" ? "≠▶" : "≠" };
    case "left_only": return { cls: "text-violet-400", glyph: "◀" };
    case "right_only": return { cls: "text-sky-400", glyph: "▶" };
    case "type_mismatch": return { cls: "text-amber-400", glyph: "≠" };
    case "unchecked": return { cls: "text-amber-300/80", glyph: "?" };
  }
}

interface Job { id: string; phase: FcmpProgress["phase"]; p: FcmpProgress | null }

interface Props {
  scope: string;
  left: ReadySide;
  right: ReadySide;
  active: boolean;
  onOpenPair: (leftRel: string, rightRel: string, mode: CompareMode) => void;
}

export default function FolderComparePane({ scope, left, right, onOpenPair }: Props) {
  const t = useT();
  const tab = useStore((s) => s.compareTabs.find((x) => x.key === scope));
  const updateCompareTab = useStore((s) => s.updateCompareTab);
  const [settings, setSettings] = useState<FolderSettings>(() => tab?.folder ?? loadLastSettings());
  const [excludesText, setExcludesText] = useState(settings.excludes.join("; "));
  const [showOpts, setShowOpts] = useState(false);
  const [diff, setDiff] = useState<FolderDiff | null>(null);
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FolderFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const listRef = useRef<HTMLDivElement>(null);

  const specs = useMemo(() => ({ a: sideSpec(left), b: sideSpec(right) }), [left, right]);
  const specsKey = JSON.stringify(specs);

  const applySettings = (s: FolderSettings) => {
    setSettings(s);
    saveLastSettings(s);
    updateCompareTab(scope, { folder: s });
  };

  /** 跑一個帶進度的後端工作；取消不算錯誤。 */
  const runJob = useCallback(async <T,>(phase: Job["phase"], fn: (jobId: string) => Promise<T>): Promise<T | null> => {
    const id = newJobId();
    setJob({ id, phase, p: null });
    const un = await onFcmpProgress(id, (p) => setJob((j) => (j && j.id === id ? { ...j, p } : j)));
    try {
      return await fn(id);
    } catch (e) {
      if (errCode(e) !== "ERR_COMPARE_CANCELLED") throw e;
      toast.info(t("已取消"));
      return null;
    } finally {
      un();
      setJob((j) => (j && j.id === id ? null : j));
    }
  }, [t]);

  const contentCheck = useCallback(async (nodes: TreeNode[], rootsNow: TreeNode[]) => {
    const pairs = nodes.map((n) => ({ key: n.key, left: n.row.left!.rel, right: n.row.right!.rel }));
    if (!pairs.length) { toast.info(t("沒有需要比對內容的檔案")); return; }
    const res = await runJob("content", (id) => api.fcmpContentCheck(id, scope, specs.a, specs.b, pairs));
    if (!res) return;
    const byKey = new Map(res.map((r) => [r.key, r]));
    let failed = 0;
    for (const n of nodes) {
      const r = byKey.get(n.key);
      if (!r) continue;
      if (r.equal === null) { failed++; continue; }
      n.row = { ...n.row, status: r.equal ? "same" : "diff" };
    }
    reaggregate(rootsNow);
    setVersion((v) => v + 1);
    if (failed) toast.error(t("{n} 個檔案讀不到，內容未比對", { n: failed }));
  }, [runJob, scope, specs, t]);

  const scan = useCallback(async (s: FolderSettings = settings) => {
    setError(null);
    try {
      const d = await runJob("scan", (id) => api.fcmpScan(id, specs.a, specs.b, folderOpts(s)));
      if (!d) return;
      const tree = buildTree(d.rows);
      setDiff(d);
      setRoots(tree);
      setSelected(new Set());
      setExpanded(new Set(d.rows.length <= AUTO_EXPAND_MAX ? dirKeys(tree, true) : []));
      setVersion((v) => v + 1);
      if (s.criteria === "content") await contentCheck(contentCandidates(tree, false), tree);
    } catch (e) {
      setError(errMsg(e));
    }
    // specsKey 代表兩邊；settings 由呼叫端傳入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specsKey, runJob, contentCheck]);

  useEffect(() => { void scan(); /* 兩邊換了就重掃 */ }, [specsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => flatten(roots, expanded, filter), [roots, expanded, filter, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => countFiles(roots), [roots, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const byKey = useMemo(() => {
    const m = new Map<string, TreeNode>();
    const walk = (ns: TreeNode[]) => { for (const n of ns) { m.set(n.key, n); walk(n.children); } };
    walk(roots);
    return m;
  }, [roots]);
  const selectedNodes = useMemo(() => [...selected].map((k) => byKey.get(k)).filter((n): n is TreeNode => !!n), [selected, byKey]);

  const toggle = (n: TreeNode) => setExpanded((s) => { const x = new Set(s); if (x.has(n.key)) x.delete(n.key); else x.add(n.key); return x; });

  const clickRow = (e: ReactMouseEvent, n: TreeNode, idx: number) => {
    if (e.shiftKey && anchorRef.current) {
      const a = rows.findIndex((r) => r.key === anchorRef.current);
      const [lo, hi] = a < idx ? [a, idx] : [idx, a];
      setSelected(new Set(rows.slice(Math.max(lo, 0), hi + 1).map((r) => r.key)));
      return;
    }
    anchorRef.current = n.key;
    if (e.ctrlKey || e.metaKey) setSelected((s) => { const x = new Set(s); if (x.has(n.key)) x.delete(n.key); else x.add(n.key); return x; });
    else setSelected(new Set([n.key]));
  };

  const openNode = (n: TreeNode, mode: CompareMode = "text") => {
    if (n.isDir && n.row.status !== "type_mismatch") { toggle(n); return; }
    if (!n.row.left || !n.row.right || n.row.left.is_dir || n.row.right.is_dir) { toast.info(t("兩邊都有這個檔案才能比較內容")); return; }
    onOpenPair(n.row.left.rel, n.row.right.rel, mode);
  };

  // ---- 執行操作 ----
  const execute = async (ops: SyncOp[], confirmTitle: string) => {
    if (!ops.length) { toast.info(t("沒有需要處理的項目")); return; }
    const copies = ops.filter((o) => o.kind === "copy_lr" || o.kind === "copy_rl").length;
    const deletes = ops.length - copies;
    const msg = deletes
      ? t("將複製 {c} 項、刪除 {d} 項。刪除無法復原，確定嗎？", { c: copies, d: deletes })
      : t("將複製 {c} 項（目的地的同名檔會被覆蓋），確定嗎？", { c: copies });
    if (!(await uiConfirm(msg, { title: confirmTitle, danger: deletes > 0, confirmText: t("執行") }))) return;
    try {
      const rep = await runJob("sync", (id) => api.fcmpSync(id, scope, specs.a, specs.b, settings.excludes, ops));
      if (rep) report(rep);
    } catch (e) {
      toast.error(errMsg(e));
    }
    await scan();
  };

  const report = (r: SyncReport) => {
    if (r.failed.length) {
      toast.error(t("{n} 項失敗：{first}", { n: r.failed.length, first: `${r.failed[0][0]} — ${r.failed[0][1]}` }));
    } else {
      toast.success(t("完成：複製 {c} 項、刪除 {d} 項", { c: r.copied, d: r.deleted }));
    }
    if (r.mtime_not_kept) toast.info(t("{n} 個檔案無法保留修改時間（FTP），重新比較時可能仍顯示時間不同", { n: r.mtime_not_kept }));
  };

  const act = (kind: SyncOp["kind"]) => {
    const ops = opsForSelection(kind, selectedNodes);
    const title = kind === "copy_lr" ? t("複製到右邊") : kind === "copy_rl" ? t("複製到左邊") : kind === "delete_left" ? t("刪除左邊") : t("刪除右邊");
    void execute(ops, title);
  };

  // 前景分頁的鍵盤：Enter 開啟比較、Ctrl+A 全選可見列。焦點要在清單裡。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && selectedNodes.length === 1) { e.preventDefault(); openNode(selectedNodes[0]); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) { e.preventDefault(); setSelected(new Set(rows.map((r) => r.key))); }
    else if (e.key === "ArrowRight" && selectedNodes.length === 1 && selectedNodes[0].isDir) setExpanded((s) => new Set(s).add(selectedNodes[0].key));
    else if (e.key === "ArrowLeft" && selectedNodes.length === 1 && selectedNodes[0].isDir) setExpanded((s) => { const x = new Set(s); x.delete(selectedNodes[0].key); return x; });
  };

  const busy = !!job;
  const hasSel = selectedNodes.length > 0;
  const filterOptions: { value: FolderFilter; label: string }[] = [
    { value: "all", label: t("全部") },
    { value: "diff", label: t("不同（{n}）", { n: counts.diff + counts.left_only + counts.right_only + counts.unchecked }) },
    { value: "left_only", label: t("只在左（{n}）", { n: counts.left_only }) },
    { value: "right_only", label: t("只在右（{n}）", { n: counts.right_only }) },
    { value: "same", label: t("相同（{n}）", { n: counts.same }) },
  ];

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 10);

  const sideCell = (n: TreeNode, side: "left" | "right", cls: string) => {
    const m = side === "left" ? n.row.left : n.row.right;
    const indent = { paddingLeft: `${n.depth * 14 + 4}px` };
    if (!m) return <div className="flex-1 min-w-0 flex items-center" style={indent}><span className="text-fg/15 select-none">—</span></div>;
    return (
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <div className="flex-1 min-w-0 flex items-center gap-1" style={indent}>
          {n.isDir && side === "left" ? (
            <button type="button" tabIndex={-1} className="w-4 h-4 shrink-0 flex items-center justify-center text-fg/40 hover:text-fg"
              onClick={(e) => { e.stopPropagation(); toggle(n); }} aria-label={expanded.has(n.key) ? t("收合") : t("展開")}>
              <Icon icon={expanded.has(n.key) ? ChevronDown : ChevronRight} size={12} />
            </button>
          ) : <span className="w-4 shrink-0" />}
          <Icon icon={m.is_dir ? Folder : File} size={13} className={`shrink-0 ${m.is_dir ? "text-amber-300/70" : "text-fg/40"}`} />
          <span className={`truncate ${cls}`} title={m.rel}>{m.name}</span>
        </div>
        <span className="w-20 shrink-0 text-right text-fg/45 mono tabular-nums">{m.is_dir ? "" : fmtBytes(m.size)}</span>
        <span className="w-32 shrink-0 text-fg/45 mono tabular-nums hidden lg:block">{fmtTime(m.mtime)}</span>
      </div>
    );
  };

  const phaseText = (j: Job) => {
    const p = j.p;
    if (j.phase === "scan") return t("掃描中… 左 {l} · 右 {r}", { l: p?.left ?? 0, r: p?.right ?? 0 });
    if (j.phase === "content") return t("比對內容… {done}/{total}", { done: p?.done ?? 0, total: p?.total ?? 0 });
    return p?.items
      ? t("同步中… {done}/{total} · {bytes}", { done: p.items[0], total: p.items[1], bytes: `${fmtBytes(p.done)} / ${fmtBytes(p.total ?? 0)}` })
      : t("準備同步…");
  };
  const pct = job?.p && job.p.total ? Math.min(100, (job.p.done / job.p.total) * 100) : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="folder-compare">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-fg/10 bg-panel text-xs overflow-x-auto">
        <IconButton icon={RefreshCw} label={t("重新比較")} onClick={() => void scan()} disabled={busy} />
        <IconButton icon={FileSearch} label={t("比對內容（選取的項目；沒選 = 全部大小相同的檔）")} disabled={busy || !roots.length}
          onClick={() => void contentCheck(contentCandidates(hasSel ? selectedNodes : roots, true), roots)} />
        <div className="w-px h-4 bg-fg/10 mx-1" />
        <IconButton icon={ArrowRightToLine} label={t("選取的項目複製到右邊")} onClick={() => act("copy_lr")} disabled={busy || !hasSel} data-testid="fcmp-copy-lr" />
        <IconButton icon={ArrowLeftToLine} label={t("選取的項目複製到左邊")} onClick={() => act("copy_rl")} disabled={busy || !hasSel} />
        <IconButton icon={Trash2} label={t("刪除選取的項目…")} disabled={busy || !hasSel}
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }} />
        <Button size="sm" variant="secondary" icon={Workflow} className="whitespace-nowrap shrink-0" disabled={busy || !roots.length}
          onClick={() => setSyncOpen(true)} data-testid="fcmp-sync">{t("同步…")}</Button>
        <div className="w-px h-4 bg-fg/10 mx-1" />
        <IconButton icon={ChevronsUpDown} label={t("全部展開")} onClick={() => setExpanded(new Set(dirKeys(roots)))} />
        <IconButton icon={ChevronsDownUp} label={t("全部收合")} onClick={() => setExpanded(new Set())} />
        <IconButton icon={Settings2} label={t("比對規則")} active={showOpts} onClick={() => setShowOpts((v) => !v)} />
        <div className="ml-2 shrink-0" data-testid="fcmp-filter">
          <Segmented<FolderFilter> size="sm" value={filter} onChange={setFilter} options={filterOptions} ariaLabel={t("篩選")} />
        </div>
      </div>

      {showOpts && (
        <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 border-b border-fg/10 bg-panel/60 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-fg/60 whitespace-nowrap">{t("判斷相同")}</span>
            <div className="w-44">
              <Select value={settings.criteria} onChange={(e) => { const s = { ...settings, criteria: e.target.value as FolderSettings["criteria"] }; applySettings(s); void scan(s); }}>
                <option value="size_mtime">{t("大小與修改時間")}</option>
                <option value="size">{t("只看大小")}</option>
                <option value="content">{t("內容（逐位元組）")}</option>
              </Select>
            </div>
          </label>
          <label className="flex items-center gap-1.5 whitespace-nowrap">
            <input type="checkbox" checked={settings.ignore_hour_offset}
              onChange={(e) => { const s = { ...settings, ignore_hour_offset: e.target.checked }; applySettings(s); void scan(s); }} />
            {t("忽略整小時的時差")}
          </label>
          <label className="flex items-center gap-1.5 whitespace-nowrap">
            <input type="checkbox" checked={settings.case_insensitive}
              onChange={(e) => { const s = { ...settings, case_insensitive: e.target.checked }; applySettings(s); void scan(s); }} />
            {t("名稱不分大小寫")}
          </label>
          <label className="flex items-center gap-2 flex-1 min-w-[16rem]">
            <span className="text-fg/60 whitespace-nowrap">{t("排除")}</span>
            <Input className="flex-1 mono" value={excludesText} placeholder=".git; node_modules; *.log"
              onChange={(e) => setExcludesText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              onBlur={() => {
                const excludes = excludesText.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
                if (JSON.stringify(excludes) === JSON.stringify(settings.excludes)) return;
                const s = { ...settings, excludes };
                applySettings(s);
                void scan(s);
              }} />
          </label>
        </div>
      )}

      {diff && (diff.errors.length > 0 || diff.skipped > 0) && (
        <div className="shrink-0 px-3 py-1 text-[11px] text-amber-200/90 bg-amber-500/10 border-b border-amber-500/20 truncate"
          title={diff.errors.map(([s, p, m]) => `${s === "left" ? t("左") : t("右")} ${p}: ${m}`).join("\n")}>
          {diff.errors.length > 0 && t("{n} 個資料夾讀不到（滑鼠移過來看明細）。", { n: diff.errors.length })}
          {diff.skipped > 0 && ` ${t("略過 {n} 個指向資料夾的連結或特殊檔。", { n: diff.skipped })}`}
        </div>
      )}

      <div className="shrink-0 flex items-center text-[11px] text-fg/45 border-b border-fg/10 bg-panel/40 select-none">
        <div className="flex-1 min-w-0 flex gap-2 px-2 py-1"><span className="flex-1">{t("左邊")}</span><span className="w-20 text-right">{t("大小")}</span><span className="w-32 hidden lg:block">{t("修改時間")}</span></div>
        <div className="w-10 shrink-0 text-center" />
        <div className="flex-1 min-w-0 flex gap-2 px-2 py-1"><span className="flex-1">{t("右邊")}</span><span className="w-20 text-right">{t("大小")}</span><span className="w-32 hidden lg:block">{t("修改時間")}</span></div>
      </div>

      <div ref={listRef} className="relative flex-1 min-h-0 overflow-auto outline-none text-xs" tabIndex={0}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} onKeyDown={onKeyDown} data-testid="fcmp-list">
        {error ? (
          <div className="p-6 flex flex-col items-center gap-3 text-fg/60">
            <div className="text-danger text-center break-all max-w-xl">{error}</div>
            <Button size="sm" icon={RefreshCw} onClick={() => void scan()}>{t("重試")}</Button>
          </div>
        ) : !diff ? null : rows.length === 0 ? (
          <div className="p-6 text-center text-fg/50">{filter === "all" ? t("兩邊都是空的資料夾") : t("沒有符合篩選的項目")}</div>
        ) : (
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {rows.slice(start, end).map((n, i) => {
              const idx = start + i;
              const st = statusStyle(n);
              const sel = selected.has(n.key);
              return (
                <div key={n.key} data-key={n.key}
                  className={`absolute left-0 right-0 flex items-center cursor-default ${sel ? "bg-accent/20" : idx % 2 ? "bg-fg/[0.02]" : ""} hover:bg-fg/[0.06]`}
                  style={{ top: idx * ROW_H, height: ROW_H }}
                  onClick={(e) => clickRow(e, n, idx)}
                  onDoubleClick={() => openNode(n)}
                  onContextMenu={(e) => { e.preventDefault(); if (!selected.has(n.key)) setSelected(new Set([n.key])); setMenu({ x: e.clientX, y: e.clientY }); }}>
                  <div className="flex-1 min-w-0 px-2">{sideCell(n, "left", st.cls)}</div>
                  <div className={`w-10 shrink-0 text-center mono ${st.cls}`} title={n.status}>{st.glyph}</div>
                  <div className="flex-1 min-w-0 px-2">{sideCell(n, "right", st.cls)}</div>
                </div>
              );
            })}
          </div>
        )}
        {job && !diff && (
          <div className="absolute inset-0 flex items-center justify-center"><Spinner size={16} /></div>
        )}
      </div>

      <div className="h-7 shrink-0 flex items-center gap-3 px-3 border-t border-fg/10 bg-panel text-[11px] text-fg/55">
        {job ? (
          <>
            <Spinner size={12} />
            <span className="truncate" data-testid="fcmp-progress">{phaseText(job)}</span>
            {pct !== null && <div className="w-40 h-1.5 rounded bg-fg/10 overflow-hidden"><div className="h-full bg-accent" style={{ width: `${pct}%` }} /></div>}
            {job.p?.current && <span className="truncate mono text-fg/40 min-w-0 flex-1">{job.p.current}</span>}
            <Button size="sm" variant="ghost" icon={Square} className="ml-auto whitespace-nowrap" onClick={() => void api.fcmpCancel(job.id)}>{t("取消")}</Button>
          </>
        ) : diff ? (
          <span data-testid="fcmp-summary">
            {t("左 {l} 項 · 右 {r} 項 · 相同 {same} · 不同 {diff} · 只在左 {lo} · 只在右 {ro}", {
              l: diff.left_count, r: diff.right_count, same: counts.same, diff: counts.diff + counts.unchecked, lo: counts.left_only, ro: counts.right_only,
            })}
            {hasSel && ` · ${t("已選 {n} 項", { n: selectedNodes.length })}`}
          </span>
        ) : null}
      </div>

      {menu && (
        <MenuPanel x={menu.x} y={menu.y} minW={200} onClose={() => setMenu(null)}>
          {(() => {
            const one = selectedNodes.length === 1 ? selectedNodes[0] : null;
            const pair = one && one.row.left && one.row.right && !one.row.left.is_dir && !one.row.right.is_dir;
            const items: [string, () => void, boolean?][] = [];
            if (pair) {
              items.push([t("文字比較"), () => openNode(one, "text")]);
              items.push([t("二進位比較"), () => openNode(one, "binary")]);
            }
            items.push([t("比對內容"), () => void contentCheck(contentCandidates(selectedNodes, true), roots)]);
            items.push([t("複製到右邊"), () => act("copy_lr")]);
            items.push([t("複製到左邊"), () => act("copy_rl")]);
            if (selectedNodes.some((n) => n.row.left)) items.push([t("刪除左邊…"), () => act("delete_left"), true]);
            if (selectedNodes.some((n) => n.row.right)) items.push([t("刪除右邊…"), () => act("delete_right"), true]);
            return items.map(([label, fn, danger]) => (
              <button key={label} type="button" disabled={busy}
                onClick={() => { setMenu(null); fn(); }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-fg/10 disabled:opacity-40 ${danger ? "text-danger" : "text-fg/80"}`}>
                {label}
              </button>
            ));
          })()}
        </MenuPanel>
      )}

      {syncOpen && (
        <SyncDialog roots={roots} initial={settings.rule ?? "mirror_lr"} left={left} right={right}
          onClose={() => setSyncOpen(false)}
          onRun={(rule, ops) => {
            setSyncOpen(false);
            if (rule !== settings.rule) applySettings({ ...settings, rule });
            void execute(ops, t("同步"));
          }} />
      )}
    </div>
  );
}

function sideName(s: ReadySide): string {
  return s.kind === "remote" ? `${s.host}:${s.path}` : s.kind === "local" ? s.path : "";
}

function SyncDialog({ roots, initial, left, right, onClose, onRun }: {
  roots: TreeNode[];
  initial: SyncRule;
  left: ReadySide;
  right: ReadySide;
  onClose: () => void;
  onRun: (rule: SyncRule, ops: SyncOp[]) => void;
}) {
  const t = useT();
  const [rule, setRule] = useState<SyncRule>(initial);
  const plan = useMemo(() => planSync(roots, rule), [roots, rule]);
  const RULES: { id: SyncRule; title: string; hint: string }[] = [
    { id: "mirror_lr", title: t("鏡像：左 → 右"), hint: t("讓右邊變得跟左邊一模一樣：不同的覆蓋、只在右邊的刪除。") },
    { id: "mirror_rl", title: t("鏡像：右 → 左"), hint: t("讓左邊變得跟右邊一模一樣：不同的覆蓋、只在左邊的刪除。") },
    { id: "update_lr", title: t("更新右邊"), hint: t("把左邊較新或右邊沒有的檔複製到右邊，不刪任何東西。") },
    { id: "update_rl", title: t("更新左邊"), hint: t("把右邊較新或左邊沒有的檔複製到左邊，不刪任何東西。") },
    { id: "update_both", title: t("兩邊互相更新"), hint: t("各自補上對方沒有的，不同的以較新的一邊為準；分不出新舊的列為衝突、不處理。") },
  ];
  const label = (o: SyncOp) =>
    o.kind === "copy_lr" ? "→" : o.kind === "copy_rl" ? "←" : o.kind === "delete_left" ? t("刪左") : t("刪右");
  const copies = plan.ops.filter((o) => o.kind === "copy_lr" || o.kind === "copy_rl").length;
  const deletes = plan.ops.length - copies;
  return (
    <Modal open onClose={onClose} title={t("同步資料夾")} icon={Workflow} size="lg"
      footer={
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg/50">{t("複製 {c} · 刪除 {d} · 衝突 {x}", { c: copies, d: deletes, x: plan.conflicts.length })}</span>
          <Button className="ml-auto" variant="ghost" onClick={onClose}>{t("取消")}</Button>
          <Button variant={deletes ? "danger" : "primary"} disabled={!plan.ops.length} onClick={() => onRun(rule, plan.ops)} data-testid="fcmp-sync-run">
            {t("開始同步")}
          </Button>
        </div>
      }>
      <div className="p-4 flex flex-col gap-3 text-xs">
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-fg/60 mono">
          <span>{t("左")}</span><span className="truncate">{sideName(left)}</span>
          <span>{t("右")}</span><span className="truncate">{sideName(right)}</span>
        </div>
        <div className="flex flex-col gap-1">
          {RULES.map((r) => (
            <label key={r.id} className={`flex items-start gap-2 p-2 rounded border cursor-pointer ${rule === r.id ? "border-accent/60 bg-accent/10" : "border-fg/10 hover:bg-fg/5"}`}>
              <input type="radio" name="sync-rule" checked={rule === r.id} onChange={() => setRule(r.id)} className="mt-0.5" />
              <span><span className="font-medium">{r.title}</span><span className="block text-fg/50">{r.hint}</span></span>
            </label>
          ))}
        </div>
        <div className="rounded border border-fg/10 max-h-64 overflow-auto" data-testid="fcmp-sync-preview">
          {plan.ops.length === 0 ? (
            <div className="p-3 text-fg/50">{t("兩邊已經一致，沒有需要處理的項目。")}</div>
          ) : (
            plan.ops.slice(0, 500).map((o, i) => (
              <div key={i} className={`flex gap-2 px-2 py-0.5 mono ${o.kind.startsWith("delete") ? "text-danger" : "text-fg/80"}`}>
                <span className="w-8 shrink-0 text-center">{label(o)}</span>
                <span className="truncate">{o.src}{o.is_dir ? "/" : ""}</span>
              </div>
            ))
          )}
          {plan.ops.length > 500 && <div className="px-2 py-1 text-fg/40">{t("…還有 {n} 項", { n: plan.ops.length - 500 })}</div>}
        </div>
        {plan.conflicts.length > 0 && (
          <div className="text-amber-300/90">
            {t("{n} 個項目分不出該往哪邊（例如兩邊都改過、或一邊是資料夾一邊是檔案），不會處理：", { n: plan.conflicts.length })}
            <span className="mono ml-1">{plan.conflicts.slice(0, 5).map((n) => n.key).join(", ")}{plan.conflicts.length > 5 ? "…" : ""}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
