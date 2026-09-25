// 可拖曳調整尺寸的面板：hook + 把手元件。原本住在 App.tsx（側欄 / 資訊面板 / 編輯器高度），
// SSH 終端機的 SFTP 分割面板也要用，故抽到共用層；行為與 App.tsx 原版完全一致。
import { useState, type PointerEvent as ReactPointerEvent } from "react";

function clampSize(v: number, min: number, max: number) {
  return Math.max(min, Math.min(v, max));
}

// axis "x" 調寬度、"y" 調高度；max 可為函式（依視窗大小動態算上限）。
export function useResizable(opts: {
  storageKey: string;
  initial: number;
  min: number;
  max: number | (() => number);
  axis: "x" | "y";
}) {
  const maxOf = () => (typeof opts.max === "function" ? opts.max() : opts.max);
  const [size, setSize] = useState<number>(() => {
    try {
      const v = localStorage.getItem(opts.storageKey);
      if (v != null) {
        const n = parseFloat(v);
        if (Number.isFinite(n)) return clampSize(n, opts.min, maxOf());
      }
    } catch {
      /* 忽略讀取失敗 */
    }
    return opts.initial;
  });

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = opts.axis === "x" ? e.clientX : e.clientY;
    const startSize = size;
    let latest = startSize;
    const move = (ev: PointerEvent) => {
      const cur = opts.axis === "x" ? ev.clientX : ev.clientY;
      latest = clampSize(startSize + (cur - start), opts.min, maxOf());
      setSize(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(opts.storageKey, String(latest)); } catch { /* 忽略寫入失敗 */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = opts.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return { size, onPointerDown };
}

/**
 * 同 useResizable，但拖曳方向相反（把手在面板左側 / 上方、面板在右 / 下：往左拖是變寬）。
 * 供靠右停靠的面板（SFTP）用；storage 與 clamp 行為一致。
 */
export function useResizableReverse(opts: Parameters<typeof useResizable>[0]) {
  const maxOf = () => (typeof opts.max === "function" ? opts.max() : opts.max);
  const [size, setSize] = useState<number>(() => {
    try {
      const v = localStorage.getItem(opts.storageKey);
      if (v != null) {
        const n = parseFloat(v);
        if (Number.isFinite(n)) return clampSize(n, opts.min, maxOf());
      }
    } catch {
      /* 忽略讀取失敗 */
    }
    return opts.initial;
  });
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = opts.axis === "x" ? e.clientX : e.clientY;
    const startSize = size;
    let latest = startSize;
    const move = (ev: PointerEvent) => {
      const cur = opts.axis === "x" ? ev.clientX : ev.clientY;
      latest = clampSize(startSize - (cur - start), opts.min, maxOf());
      setSize(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(opts.storageKey, String(latest)); } catch { /* 忽略寫入失敗 */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = opts.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };
  return { size, onPointerDown };
}

// 拖曳把手：axis "x" → 直立細條（調左右）、"y" → 水平細條（調上下）。
export function Splitter({ axis, onPointerDown }: { axis: "x" | "y"; onPointerDown: (e: ReactPointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      className={
        "shrink-0 bg-fg/10 hover:bg-accent/60 active:bg-accent transition-colors " +
        (axis === "x" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize")
      }
    />
  );
}
