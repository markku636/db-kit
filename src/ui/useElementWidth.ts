import { useEffect, useState, type RefObject } from "react";

/**
 * 元素目前的內容寬度（px，ResizeObserver 追蹤）；還沒量到時回 null。
 * 給「依容器寬度收起次要欄位」用：Tailwind 3 沒有容器查詢，原生 @container 在較舊的 WebKitGTK
 * （Linux 版 Tauri）上也不支援。門檻請用 rem 算（見 remPx），介面字級放大時才會跟著提早收欄。
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(Math.round(w));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** 目前 1rem 是多少 px（跟著全域介面字級）。 */
export function remPx(): number {
  const n = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(n) && n > 0 ? n : 16;
}
