// RDP 畫面：後端送來的差異區塊畫到 <canvas>，滑鼠 / 鍵盤轉成 8-byte 輸入紀錄送回去。
// 連線生命週期（撥號、提示、斷線、全螢幕）在 RdPane；這裡只管「畫」跟「收輸入」，透過 handle 讓 RdPane 驅動。
//
// 畫面：record 先排隊，下一個 animation frame 一次畫完再 ack（`rd_frame_ack`）——後端靠 ack 反壓，
// 前端忙的時候新的更新會在後端併成一塊，不會在 IPC 裡越排越長。
// 座標：canvas 的像素 = 遠端像素；CSS 用 object-fit: contain 縮放（scale / remote 模式）或 1:1（none），
// 滑鼠座標依實際顯示的矩形換算回遠端像素。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "./api";
import type { RdConnInfo, RdResizeMode } from "./rdTypes";
import { parseRdMessage, pointerToCssCursor, type RdRecord } from "./rdFrames";
import { lockFlagsFromEvent, mouseButtonFromDom, RdInputEncoder, WheelAccumulator } from "./rdInput";
import type { RdViewHandle } from "./rdView";

export interface RdpViewProps {
  resizeMode: RdResizeMode;
  viewOnly: boolean;
  /** 同步剪貼簿文字（遠端複製 → 寫進本機剪貼簿；畫面取得焦點時把本機剪貼簿交給遠端）。 */
  clipboard: boolean;
  /** 焦點在畫面上時的鍵盤事件要不要交給外層（Ctrl+Alt+Enter 切全螢幕）。 */
  isPaneShortcut: (e: KeyboardEvent | React.KeyboardEvent) => boolean;
}

/** RGBA → data URL（游標圖）。 */
function rgbaToDataUrl(rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")?.putImageData(new ImageData(rgba, w, h), 0, 0);
  return c.toDataURL("image/png");
}

const RdpView = forwardRef<RdViewHandle, RdpViewProps>(function RdpView({ resizeMode, viewOnly, clipboard, isPaneShortcut }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connIdRef = useRef<string>("");
  const liveRef = useRef(false);
  const queueRef = useRef<RdRecord[]>([]);
  const rafRef = useRef<number>(0);
  const encRef = useRef(new RdInputEncoder());
  const wheelRef = useRef(new WheelAccumulator());
  const flushTimer = useRef<number | undefined>(undefined);
  const lockedRef = useRef(false);
  const [cursor, setCursor] = useState<string>("default");
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const modeRef = useRef(resizeMode);
  modeRef.current = resizeMode;
  const clipRef = useRef(clipboard && !viewOnly);
  clipRef.current = clipboard && !viewOnly;
  // 剪貼簿來回：記住最後從遠端拿到的與最後送出的，免得同一段文字在兩邊來回彈。
  const lastRemoteRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);

  const syncLocalClipboard = async () => {
    if (!clipRef.current || !liveRef.current) return;
    try {
      // 後端讀系統剪貼簿（navigator.clipboard.readText 會跳權限詢問、搶走畫面焦點）。
      const text = await api.rdClipboardRead();
      if (!text || text === lastRemoteRef.current || text === lastSentRef.current) return;
      lastSentRef.current = text;
      await api.rdClipboardSet(connIdRef.current, text);
    } catch { /* 讀不到剪貼簿：略過 */ }
  };

  // ---- 輸出 ----
  const paint = () => {
    rafRef.current = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const q = queueRef.current;
    queueRef.current = [];
    if (!canvas || !ctx) return;
    let ack = 0;
    for (const r of q) {
      switch (r.kind) {
        case "resize":
          if (canvas.width !== r.w || canvas.height !== r.h) {
            canvas.width = r.w;
            canvas.height = r.h;
          }
          setSize({ w: r.w, h: r.h });
          break;
        case "rect":
          if (r.w > 0 && r.h > 0) ctx.putImageData(new ImageData(r.pixels, r.w, r.h), r.x, r.y);
          break;
        case "frameEnd":
          ack = r.seq;
          break;
        case "pointerBitmap":
          setCursor(pointerToCssCursor(r, rgbaToDataUrl));
          break;
        case "pointerSystem":
          setCursor(r.visible ? "default" : "none");
          break;
        case "pointerPos":
          break;
        case "clipboard":
          if (clipRef.current) {
            lastRemoteRef.current = r.text;
            void api.rdClipboardWrite(r.text).catch(() => undefined);
          }
          break;
      }
    }
    if (ack && liveRef.current) void api.rdFrameAck(connIdRef.current, ack).catch(() => undefined);
  };

  // ---- 輸入 ----
  const flush = () => {
    flushTimer.current = undefined;
    const bytes = encRef.current.take();
    if (bytes && liveRef.current && !viewOnly) void api.rdInput(connIdRef.current, bytes).catch(() => undefined);
  };
  const scheduleFlush = () => {
    if (flushTimer.current === undefined) flushTimer.current = window.setTimeout(flush, 0);
  };

  /** client 座標 → 遠端像素（考慮 object-fit: contain 的留白）。 */
  const toRemote = (clientX: number, clientY: number): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width || !canvas.height) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    let scale = r.width / canvas.width;
    let ox = 0;
    let oy = 0;
    if (modeRef.current !== "none") {
      scale = Math.min(r.width / canvas.width, r.height / canvas.height);
      ox = (r.width - canvas.width * scale) / 2;
      oy = (r.height - canvas.height * scale) / 2;
    }
    const x = Math.floor((clientX - r.left - ox) / scale);
    const y = Math.floor((clientY - r.top - oy) / scale);
    return [Math.max(0, Math.min(canvas.width - 1, x)), Math.max(0, Math.min(canvas.height - 1, y))];
  };

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (viewOnly || !liveRef.current) return;
    const p = toRemote(e.clientX, e.clientY);
    if (!p) return;
    const enc = encRef.current;
    if (e.type === "pointermove") enc.move(p[0], p[1]);
    else {
      const b = mouseButtonFromDom(e.button);
      if (b == null) return;
      if (e.type === "pointerdown") {
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      enc.button(e.type === "pointerdown", b, p[0], p[1]);
      e.preventDefault();
    }
    scheduleFlush();
  };

  // wheel 要 passive: false 才能 preventDefault（React 的 onWheel 是 passive）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (viewOnly || !liveRef.current) return;
      const p = toRemote(e.clientX, e.clientY);
      if (!p) return;
      const { v, h } = wheelRef.current.push(e);
      if (v) encRef.current.wheel(v, false, p[0], p[1]);
      if (h) encRef.current.wheel(h, true, p[0], p[1]);
      if (v || h) scheduleFlush();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOnly]);

  const onKey = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (isPaneShortcut(e)) return; // 交給 RdPane（切全螢幕）
    e.preventDefault();
    e.stopPropagation();
    if (viewOnly || !liveRef.current) return;
    const down = e.type === "keydown";
    const enc = encRef.current;
    if (down && !lockedRef.current) {
      enc.syncLocks(lockFlagsFromEvent(e.nativeEvent));
      lockedRef.current = true;
    }
    if (!enc.key(down, e.code) && e.key.length > 0 && [...e.key].length === 1) {
      // 對不到掃描碼的鍵（部分國際鍵盤）：退回 Unicode 事件。
      for (let i = 0; i < e.key.length; i++) enc.unicode(down, e.key.charCodeAt(i));
    }
    scheduleFlush();
  };

  const onBlur = () => {
    lockedRef.current = false;
    if (!liveRef.current || viewOnly) return;
    encRef.current.releaseAll();
    flush();
  };

  // ---- 動態解析度（remote 模式）：容器大小變了 400 ms 後請遠端改解析度 ----
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      if (modeRef.current !== "remote" || !liveRef.current) return;
      if (!wrap.clientWidth || !wrap.clientHeight) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const dpr = window.devicePixelRatio || 1;
        void api.rdResize(connIdRef.current, wrap.clientWidth, wrap.clientHeight, Math.round(dpr * 100)).catch(() => undefined);
      }, 400);
    });
    ro.observe(wrap);
    return () => { ro.disconnect(); window.clearTimeout(timer); };
  }, []);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    window.clearTimeout(flushTimer.current);
  }, []);

  useImperativeHandle(ref, () => ({
    reset(connId: string) {
      connIdRef.current = connId;
      liveRef.current = false;
      queueRef.current = [];
      encRef.current = new RdInputEncoder();
      wheelRef.current.reset();
      lockedRef.current = false;
    },
    output(buf: ArrayBuffer) {
      try {
        queueRef.current.push(...parseRdMessage(buf));
      } catch (e) {
        console.error("[rdp] bad frame", e);
        return;
      }
      if (!rafRef.current) rafRef.current = requestAnimationFrame(paint);
    },
    connected(_info: RdConnInfo) {
      liveRef.current = true;
      canvasRef.current?.focus();
    },
    disconnected() {
      liveRef.current = false;
    },
    combo(name: string) {
      if (liveRef.current && !viewOnly) void api.rdSendKeys(connIdRef.current, name).catch(() => undefined);
    },
    paste(text: string) {
      // RDP 剪貼簿通道之後接；先用 Unicode 事件把文字打過去（適合短字串：密碼、指令）。
      if (!liveRef.current || viewOnly) return;
      const enc = encRef.current;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 13) continue;
        if (c === 10) {
          enc.key(true, "Enter");
          enc.key(false, "Enter");
          continue;
        }
        enc.unicode(true, c);
        enc.unicode(false, c);
      }
      flush();
    },
    focus() {
      canvasRef.current?.focus();
    },
    refresh() {
      if (liveRef.current) void api.rdRefresh(connIdRef.current).catch(() => undefined);
    },
    desktopSize: () => size,
    rawKey(sc: number, down: boolean) {
      if (!liveRef.current || viewOnly) return;
      encRef.current.scancode(down, sc);
      flush();
    },
  }), [viewOnly, size]);

  const fit = resizeMode !== "none";
  return (
    <div ref={wrapRef} className={`flex-1 min-h-0 min-w-0 bg-black ${fit ? "overflow-hidden" : "overflow-auto"}`} data-rd-rdp="">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="rd-surface outline-none block"
        style={fit ? { width: "100%", height: "100%", objectFit: "contain", cursor } : { cursor }}
        data-rd-size={size.w ? `${size.w}x${size.h}` : undefined}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerUp={onPointer}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKey}
        onKeyUp={onKey}
        onBlur={onBlur}
        onFocus={() => void syncLocalClipboard()}
      />
    </div>
  );
});

export default RdpView;
