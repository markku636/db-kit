// 二進位比對：兩個檔逐位元組比（同一個位移對同一個位移），差異區段由後端一次算好，
// 十六進位視圖只在捲到的地方分頁讀取（大檔也不必整個載進記憶體）。唯讀。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { Button, IconButton, Spinner } from "./ui/index";
import { fmtBytes } from "./dockerModel";
import type { BinDiff } from "./compareTypes";
import { localPathOf, newJobId, type ReadySide } from "./compareIo";
import { errMsg } from "./useRemoteSession";

const COLS = 16;
const ROW_H = 20;
const PAGE = 4096;

/** 位移是否落在某個差異區段（ranges 依位移排序、互不重疊）。 */
export function inRanges(ranges: readonly [number, number][], off: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, len] = ranges[mid];
    if (off < s) hi = mid - 1;
    else if (off >= s + len) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 第一個起點 > off（dir=1）或 < off（dir=-1）的差異區段起點；沒有回 null。 */
export function nextRange(ranges: readonly [number, number][], off: number, dir: 1 | -1): number | null {
  if (dir === 1) {
    for (const [s] of ranges) if (s > off) return s;
    return null;
  }
  for (let i = ranges.length - 1; i >= 0; i--) if (ranges[i][0] < off) return ranges[i][0];
  return null;
}

const hex2 = (b: number) => b.toString(16).padStart(2, "0");
const printable = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·");

class PageCache {
  pages = new Map<number, Uint8Array>();
  loading = new Set<number>();
  constructor(public path: string) {}
  get(page: number) { return this.pages.get(page); }
}

export default function BinaryComparePane({ scope, left, right }: { scope: string; left: ReadySide; right: ReadySide }) {
  const t = useT();
  const [paths, setPaths] = useState<{ a: string; b: string } | null>(null);
  const [diff, setDiff] = useState<BinDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [tick, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const listRef = useRef<HTMLDivElement>(null);
  const caches = useRef<{ a: PageCache; b: PageCache } | null>(null);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setErr(null);
    setPaths(null);
    (async () => {
      const [a, b] = await Promise.all([localPathOf(scope, left), localPathOf(scope, right)]);
      if (!alive) return;
      caches.current = { a: new PageCache(a), b: new PageCache(b) };
      setPaths({ a, b });
      const d = await api.fcmpBinaryDiff(newJobId(), a, b);
      if (alive) setDiff(d);
    })().catch((e) => { if (alive) setErr(errMsg(e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, JSON.stringify(left), JSON.stringify(right), reload]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [diff]);

  const total = diff ? Math.max(diff.size_a, diff.size_b) : 0;
  const rowCount = Math.ceil(total / COLS);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewH) / ROW_H) + 5);

  // 讀進畫面上需要的分頁（兩邊各自）。
  const ensurePages = useCallback((fromRow: number, toRow: number) => {
    const c = caches.current;
    if (!c) return;
    const p0 = Math.floor((fromRow * COLS) / PAGE);
    const p1 = Math.floor((toRow * COLS) / PAGE);
    for (const cache of [c.a, c.b]) {
      for (let p = p0; p <= p1; p++) {
        if (cache.pages.has(p) || cache.loading.has(p)) continue;
        cache.loading.add(p);
        api.fcmpReadBytes(cache.path, p * PAGE, PAGE)
          .then((bytes) => { cache.pages.set(p, bytes); setTick((x) => x + 1); })
          .catch(() => { cache.pages.set(p, new Uint8Array()); })
          .finally(() => cache.loading.delete(p));
      }
    }
  }, []);

  useEffect(() => { if (diff) ensurePages(first, last); }, [diff, first, last, ensurePages]);

  const byteAt = (cache: PageCache | undefined, size: number, off: number): number | null => {
    if (!cache || off >= size) return null;
    const page = cache.get(Math.floor(off / PAGE));
    if (!page) return -1; // 還在讀
    const i = off % PAGE;
    return i < page.length ? page[i] : null;
  };

  const jump = (dir: 1 | -1) => {
    if (!diff || !listRef.current) return;
    const curOff = Math.floor(scrollTop / ROW_H) * COLS + (dir === 1 ? COLS - 1 : 0);
    const target = nextRange(diff.ranges, curOff, dir);
    if (target === null) return;
    listRef.current.scrollTop = Math.max(0, Math.floor(target / COLS) * ROW_H - ROW_H * 3);
  };

  const summary = useMemo(() => {
    if (!diff) return "";
    if (diff.diff_bytes === 0) return t("內容完全相同（{size}）", { size: fmtBytes(diff.size_a) });
    return t("{n} 段不同，共 {bytes} 個位元組{more}", {
      n: diff.ranges.length,
      bytes: diff.diff_bytes.toLocaleString(),
      more: diff.truncated ? t("（差異區段太多，只列出前 {n} 段）", { n: diff.ranges.length }) : "",
    });
  }, [diff, t]);

  void tick; // 分頁讀進來後觸發重繪

  const renderSide = (cache: PageCache | undefined, size: number, rowOff: number) => {
    const hexCells: ReactNode[] = [];
    let ascii = "";
    const asciiDiff: boolean[] = [];
    for (let i = 0; i < COLS; i++) {
      const off = rowOff + i;
      const b = byteAt(cache, size, off);
      const d = !!diff && off < total && inRanges(diff.ranges, off);
      hexCells.push(
        <span key={i} className={`${i === 8 ? "ml-2" : ""} ${d ? "bg-danger/25 text-danger rounded-sm" : b === null ? "text-fg/15" : ""}`}>
          {b === null ? "  " : b < 0 ? "··" : hex2(b)}
        </span>,
      );
      ascii += b === null ? " " : b < 0 ? "·" : printable(b);
      asciiDiff.push(d);
    }
    return (
      <div className="flex-1 min-w-0 flex gap-3 px-2">
        <span className="flex gap-[0.45em]">{hexCells}</span>
        <span className="whitespace-pre text-fg/60">
          {ascii.split("").map((ch, i) => <span key={i} className={asciiDiff[i] ? "bg-danger/25 text-danger" : ""}>{ch}</span>)}
        </span>
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="binary-compare">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-fg/10 bg-panel text-xs">
        <IconButton icon={ArrowUp} label={t("上一段差異")} onClick={() => jump(-1)} disabled={!diff?.ranges.length} />
        <IconButton icon={ArrowDown} label={t("下一段差異")} onClick={() => jump(1)} disabled={!diff?.ranges.length} />
        <IconButton icon={RefreshCw} label={t("重新比較")} onClick={() => setReload((r) => r + 1)} />
        <span className="ml-2 text-fg/60 truncate" data-testid="bin-summary">{summary}</span>
        {diff && (
          <span className="ml-auto text-fg/45 mono whitespace-nowrap">
            {fmtBytes(diff.size_a)} · {fmtBytes(diff.size_b)}
          </span>
        )}
      </div>
      {err ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-xs p-6">
          <div className="text-danger break-all text-center max-w-xl">{err}</div>
          <Button size="sm" icon={RefreshCw} onClick={() => setReload((r) => r + 1)}>{t("重試")}</Button>
        </div>
      ) : !diff || !paths ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-xs text-fg/50"><Spinner size={14} />{t("比對中…")}</div>
      ) : (
        <div ref={listRef} className="flex-1 min-h-0 overflow-auto mono text-[12px]" onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
          <div style={{ height: rowCount * ROW_H, position: "relative", minWidth: "64rem" }}>
            {Array.from({ length: Math.max(0, last - first) }, (_, i) => {
              const row = first + i;
              const off = row * COLS;
              const rowDiff = diff.ranges.length > 0 && Array.from({ length: COLS }, (_, k) => off + k).some((o) => o < total && inRanges(diff.ranges, o));
              return (
                <div key={row} className={`absolute left-0 right-0 flex items-center ${rowDiff ? "bg-danger/[0.06]" : ""}`} style={{ top: row * ROW_H, height: ROW_H }}>
                  <span className="w-24 shrink-0 px-2 text-fg/35 tabular-nums">{off.toString(16).padStart(8, "0")}</span>
                  {renderSide(caches.current?.a, diff.size_a, off)}
                  <span className="w-px self-stretch bg-fg/10" />
                  {renderSide(caches.current?.b, diff.size_b, off)}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
