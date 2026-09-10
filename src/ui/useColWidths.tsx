import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../i18n";

// 表格欄寬共用邏輯：查詢結果格、處理程序、伺服器查詢、Routine 執行結果、Kafka 訊息表共用。
// （資料表瀏覽 TableView 因有 per-table localStorage 持久化與隱藏欄，維持自己的實作。）
export const COL_MIN_W = 60; // 下限防止拖到看不見
const COL_DEFAULT_W = 160;
/** text-xs 表格（處理程序 / 伺服器查詢等對話框）用的量測字型。 */
export const COL_FONT_XS = '12px "JetBrains Mono", "Cascadia Code", Consolas, monospace';

/**
 * 可拖曳調整的表格欄寬。
 * 預設依內容自動量測（表頭 + 抽樣前 200 列，夾在 [COL_MIN_W, maxAuto]），維持「內容剛好」的觀感；
 * 拖曳表頭右緣改寬、雙擊分隔線恢復自動寬（配 <ColResizer>）。
 * 欄位集（簽章）變動時重置手動調整；同欄位集的資料重載（重跑 / 重新整理）保留使用者調過的寬度。
 * 使用端：<table style={{ tableLayout: "fixed", width: tableWidth(固定欄總寬) }}>、
 * 各 <th> 加 style={{ width: colWidth(ci) }} + relative + overflow-hidden，內放 <ColResizer>。
 */
export function useColWidths(
  columns: string[],
  rows: (string | null)[][],
  opts?: {
    /** 自動量測上限（px），預設 560 ≈ 60ch 的視覺 */
    maxAuto?: number;
    /** 量測字型，預設 13px mono（text-sm 表格）；text-xs 表格傳 '12px …' */
    font?: string;
  }
) {
  const maxAuto = opts?.maxAuto ?? 560;
  const font = opts?.font ?? '13px "JetBrains Mono", "Cascadia Code", Consolas, monospace';
  const autoWidths = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return columns.map(() => COL_DEFAULT_W);
    ctx.font = font;
    return columns.map((c, ci) => {
      let max = ctx.measureText(c).width + 26; // 表頭文字 + 排序徽章預留
      for (let r = 0; r < rows.length && r < 200; r++) {
        const v = rows[r][ci];
        if (v == null) continue;
        const w = ctx.measureText(v.length > 100 ? v.slice(0, 100) : v).width;
        if (w > max) max = w;
      }
      return Math.min(maxAuto, Math.max(COL_MIN_W, Math.ceil(max) + 24));
    });
  }, [columns, rows, maxAuto, font]);

  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const sig = JSON.stringify(columns);
  const prevSig = useRef(sig);
  useEffect(() => {
    if (prevSig.current !== sig) { prevSig.current = sig; setOverrides({}); }
  }, [sig]);

  const colWidth = (ci: number) => overrides[ci] ?? autoWidths[ci] ?? COL_DEFAULT_W;
  /** 表格總寬 = 各欄寬總和 + 固定欄（列號 / 操作鈕等）的 extra px。 */
  const tableWidth = (extra = 0) => extra + columns.reduce((a, _c, ci) => a + colWidth(ci), 0);

  // 拖曳中的表頭格；供下方 layout effect 把被拖的界線留在可視範圍內。
  const dragTh = useRef<HTMLElement | null>(null);
  // 拖曳中自動水平捲動，讓被拖的界線不會被推出捲動容器外（等同 Excel / Navicat 的行為）。
  // 少了這段，最後一欄一旦被拉寬到超出容器，它的右緣就落在容器外、把手再也抓不到。
  useLayoutEffect(() => {
    const th = dragTh.current;
    const sc = th && scrollParentX(th);
    if (!th || !sc) return;
    const sr = sc.getBoundingClientRect();
    const edge = th.getBoundingClientRect().right;
    const clientRight = sr.left + sc.clientWidth; // clientWidth 已扣掉垂直捲軸
    if (edge > clientRight) sc.scrollLeft += edge - clientRight;
    else if (edge < sr.left) sc.scrollLeft -= sr.left - edge;
  }, [overrides]);

  // 拖曳表頭右緣調整（move/up 掛在 window 上，拖出表頭也能追蹤）。
  const startResize = (ci: number, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidth(ci);
    dragTh.current = (e.currentTarget as HTMLElement).closest("th");
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(COL_MIN_W, startW + (ev.clientX - startX));
      setOverrides((w) => ({ ...w, [ci]: next }));
    };
    const onUp = () => {
      dragTh.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const resetCol = (ci: number) =>
    setOverrides((w) => { const nw = { ...w }; delete nw[ci]; return nw; });

  return { colWidth, tableWidth, startResize, resetCol };
}

/** 往上找最近的水平捲動容器（拖曳欄寬時要靠它把界線捲回可視範圍）。 */
function scrollParentX(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const ox = getComputedStyle(n).overflowX;
    if (ox === "auto" || ox === "scroll") return n;
  }
  return null;
}

/** 表頭右緣的拖曳把手：掛在 position:relative 的 <th> 內；點擊不冒泡（不誤觸表頭排序）。 */
export function ColResizer({ onStart, onReset }: { onStart: (e: ReactPointerEvent) => void; onReset: () => void }) {
  const t = useT();
  return (
    <span
      onPointerDown={onStart}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => { e.stopPropagation(); onReset(); }}
      title={t("拖曳調整欄寬；雙擊恢復自動寬度")}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-accent/50"
    />
  );
}
