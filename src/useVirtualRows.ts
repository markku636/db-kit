import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// 資料格的列虛擬化：只把可視範圍（加上下緩衝）的 <tr> 放進 DOM，上下各一列 spacer 撐出總高度。
// 刻意沿用原本的 <table>（不改成 div grid）：欄寬 / sticky 表頭 / border-collapse / 既有的選取與編輯邏輯都不必動。
//
// 捲動容器不是 table 自己：往上找第一個可捲動的祖先（TableView 的 .at-grid、查詢結果的結果面板）。
// 多結果集堆疊在同一個捲動容器裡也成立——每張表各自用「表頂到容器頂」的距離換算可視列。
// 列高假設一致（儲存格皆單行截斷）；實際高度由已渲染的列平均量出，量到不同就更新。

/** 少於此列數就全畫：小結果集行為與以前完全一樣（也讓既有 UI 測試不受影響）。 */
export const VIRTUALIZE_MIN_ROWS = 200;
const OVERSCAN = 12;
const DEFAULT_ROW_H = 27;

export interface VirtualRows {
  /** 要渲染的列區間 [start, end)。 */
  start: number;
  end: number;
  /** 上 / 下 spacer 高度（px）；0 時不必畫 spacer。 */
  padTop: number;
  padBottom: number;
  /** 掛在 <table> 上。 */
  tableRef: (el: HTMLTableElement | null) => void;
  /** 把第 r 列捲進可視範圍（鍵盤導覽用；sticky 表頭與 extraTop 的遮擋已扣掉）。 */
  ensureVisible: (r: number) => void;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return null;
}

/**
 * @param count 總列數
 * @param extraTop 表頭上方另外 sticky 的高度（例如查詢結果的工具列 34px）
 */
export function useVirtualRows(count: number, extraTop = 0): VirtualRows {
  const enabled = count >= VIRTUALIZE_MIN_ROWS;
  const [table, setTable] = useState<HTMLTableElement | null>(null);
  const [rowH, setRowH] = useState(DEFAULT_ROW_H);
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: Math.min(count, 60) });
  const scrollerRef = useRef<HTMLElement | null>(null);
  const rowHRef = useRef(rowH);
  rowHRef.current = rowH;

  const geometry = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!table || !scroller) return null;
    const sRect = scroller.getBoundingClientRect();
    const tRect = table.getBoundingClientRect();
    const headH = table.tHead?.offsetHeight ?? 0;
    // 第 0 列在捲動內容座標系中的位置。
    const bodyTop = tRect.top - sRect.top + scroller.scrollTop + headH;
    return { scroller, headH, bodyTop };
  }, [table]);

  const recompute = useCallback(() => {
    if (!enabled) return;
    const g = geometry();
    if (!g) return;
    const h = rowHRef.current;
    const top = g.scroller.scrollTop - g.bodyTop;
    const first = Math.max(0, Math.floor(top / h) - OVERSCAN);
    const last = Math.min(count, Math.ceil((top + g.scroller.clientHeight) / h) + OVERSCAN);
    setRange((p) => (p.start === first && p.end === Math.max(first, last) ? p : { start: first, end: Math.max(first, last) }));
  }, [enabled, geometry, count]);

  // 綁捲動容器的 scroll / resize（rAF 節流）。
  useEffect(() => {
    if (!enabled || !table) return;
    const scroller = scrollParent(table);
    scrollerRef.current = scroller;
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; recompute(); });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(scroller);
    recompute();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, table, recompute]);

  // 結果換了（列數變動）→ 重算一次；列數變少時區間不可超出。
  useEffect(() => {
    if (!enabled) return;
    setRange((p) => (p.end > count ? { start: Math.min(p.start, count), end: count } : p));
    recompute();
  }, [enabled, count, recompute]);

  // 量實際列高：已渲染列的平均（扣掉 spacer）。
  const start = enabled ? Math.min(range.start, count) : 0;
  const end = enabled ? Math.min(range.end, count) : count;
  const padTop = enabled ? start * rowH : 0;
  const padBottom = enabled ? Math.max(0, (count - end) * rowH) : 0;
  useLayoutEffect(() => {
    if (!enabled || !table?.tBodies[0]) return;
    const n = end - start;
    if (n <= 0) return;
    const measured = (table.tBodies[0].offsetHeight - padTop - padBottom) / n;
    if (measured > 8 && Math.abs(measured - rowH) > 0.5) setRowH(measured);
  }, [enabled, table, start, end, padTop, padBottom, rowH]);

  const ensureVisible = useCallback((r: number) => {
    if (!enabled) return;
    const g = geometry();
    if (!g) return;
    const h = rowHRef.current;
    const rowTop = g.bodyTop + r * h;
    const occluded = g.headH + extraTop; // sticky 表頭（+ 工具列）蓋住的高度
    const viewTop = g.scroller.scrollTop + occluded;
    const viewBottom = g.scroller.scrollTop + g.scroller.clientHeight;
    if (rowTop < viewTop) g.scroller.scrollTop = rowTop - occluded;
    else if (rowTop + h > viewBottom) g.scroller.scrollTop = rowTop + h - g.scroller.clientHeight;
    recompute();
  }, [enabled, geometry, extraTop, recompute]);

  return { start, end, padTop, padBottom, tableRef: setTable, ensureVisible };
}
