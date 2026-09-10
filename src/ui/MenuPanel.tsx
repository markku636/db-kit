import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 右鍵 / 下拉選單的共用外殼：全螢幕背板（點擊或再按右鍵即關）＋ 浮起面板。
 *
 * 收斂原本散落在 App / TableView / Kafka* 的十餘個手刻 `fixed z-[90]` 面板 —— 它們各自
 * 只寫 `style={{ left: x, top: y }}`，於是有兩個共通的死路：
 *
 * 1. **超出視窗**：選單長（側欄連線選單就有 24 項、513px），在畫面下半部按右鍵時整段掉到
 *    視窗外，「刪除連線」這類收在底部的項目點不到。→ 先把位置夾回視窗內。
 * 2. **比視窗還高**：夾也沒用（視窗 560px 高、選單 513px + 邊距就已經塞不下），而面板沒有
 *    overflow，捲也捲不動 → 底部項目永遠構不到。→ 這時才給 maxHeight + 捲動。
 *
 * 捲動是「只在塞不下時才出現」：平常維持 `overflow: visible`，向右展開的子選單才不會被裁掉
 *（子選單是面板內的 `absolute left-full`）。真的塞不下時，能捲到底優先於子選單不被裁。
 */
export interface MenuPanelProps {
  x: number;
  y: number;
  onClose: () => void;
  /** 面板最小寬度（px），對應原本各處的 min-w-[150px] / [180px]…。 */
  minW?: number;

  /** 面板額外 class（沿用呼叫端原本的字級 / 內距差異）。 */
  className?: string;
  children: ReactNode;
}

/** 面板與視窗邊緣的最小間距（px）。 */
const EDGE = 8;

export default function MenuPanel({ x, y, onClose, minW = 180, className = "", children }: MenuPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number | null }>({ left: x, top: y, maxH: null });

  // Esc 關閉（與對話框一致；listener 只掛一次，onClose 走 ref 保持穩定）。
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // 量完真實尺寸再定位：先夾回視窗，塞不下才開捲動。
  // 量的是「內容自然高度」（scrollHeight）而非 rect 高度 —— 上一輪若已套過 maxHeight，
  // 拿 rect 會量到被限制後的高度，第二次就再也判斷不出它其實塞不下。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    const height = el.scrollHeight;
    const room = window.innerHeight - EDGE * 2;
    setPos({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
      maxH: height > room ? room : null,
    });
  }, [x, y]);

  return (
    <>
      <div
        className="fixed inset-0 z-[89]"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={ref}
        className={`fixed z-[90] bg-elevated border border-fg/10 rounded shadow-2xl py-1 text-sm ${className}`}
        style={{
          left: pos.left,
          top: pos.top,
          minWidth: minW,
          ...(pos.maxH === null ? null : { maxHeight: pos.maxH, overflowY: "auto" as const }),
        }}
      >
        {children}
      </div>
    </>
  );
}
