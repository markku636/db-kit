// RustDesk 畫面：後端（經 AGPL 的 dbk-rustdesk-bridge 輔助程式）轉來的仍是 VP9 / VP8 / AV1 位元流，
// 這裡用 WebView 內建的 WebCodecs `VideoDecoder` 解，畫到 <canvas>——不需要任何原生的影像解碼函式庫。
// 輸入（滑鼠 / 鍵盤）轉成 JSON 指令，經 `rd_write` → 後端 → 輔助程式 → 對方。
//
// Channel 訊息 = `[u8 型別][內容]`：1 = JSON 事件（第一則是 `connected`，帶螢幕清單與偏移），
// 2 = 影像 `[u8 codec][u8 key][u8 display][u8 保留][i64 pts LE]` + 資料。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "./api";
import type { RdConnInfo } from "./rdTypes";
import { mouseButtonFromDom, scancodeForCode } from "./rdInput";
import { useT } from "./i18n";
import type { RdViewHandle } from "./rdView";

export interface RustDeskViewProps {
  viewOnly: boolean;
  isPaneShortcut: (e: KeyboardEvent | React.KeyboardEvent) => boolean;
}

/** codec 代碼（跟 bridge 的 session::Codec 一致）→ WebCodecs 的 codec 字串。 */
const CODEC: Record<number, string> = {
  1: "vp09.00.10.08",
  2: "vp8",
  3: "av01.0.08M.08",
  4: "avc1.42E01F",
  5: "hvc1.1.6.L93.B0",
};

// RustDesk 的滑鼠 mask：低 3 bits 型別、其上是按鍵（見 hbb_common 的 input 常數）。
const MOUSE = { MOVE: 0, DOWN: 1, UP: 2, WHEEL: 3 } as const;
/** DOM 按鍵（mouseButtonFromDom 的結果：0 左 1 中 2 右 3 上一頁 4 下一頁）→ RustDesk 按鍵位元。 */
const BUTTON_BIT = [0x01, 0x04, 0x02, 0x08, 0x10];

/** 解析影像訊息的標頭（純函式，單元測試用）。 */
export function parseRustDeskVideo(buf: ArrayBuffer): { codec: number; key: boolean; display: number; pts: number; data: Uint8Array } | null {
  const u8 = new Uint8Array(buf);
  if (u8.length < 13 || u8[0] !== 2) return null;
  const dv = new DataView(buf);
  return {
    codec: u8[1],
    key: u8[2] !== 0,
    display: u8[3],
    // pts 是 i64 毫秒；Number 夠用（2^53 毫秒 ≈ 28 萬年）。
    pts: Number(dv.getBigInt64(5, true)),
    data: new Uint8Array(buf, 13),
  };
}

type Display = { x: number; y: number; width: number; height: number };

const RustDeskView = forwardRef<RdViewHandle, RustDeskViewProps>(function RustDeskView({ viewOnly, isPaneShortcut }, ref) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connIdRef = useRef("");
  const liveRef = useRef(false);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const codecRef = useRef<number>(0);
  const needKeyRef = useRef(true);
  const displayRef = useRef<Display>({ x: 0, y: 0, width: 0, height: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [unsupported, setUnsupported] = useState<string | null>(null);

  const send = (cmd: object) => {
    if (!liveRef.current || viewOnly) return;
    void api.rdWrite(connIdRef.current, new TextEncoder().encode(JSON.stringify(cmd))).catch(() => undefined);
  };

  const closeDecoder = () => {
    try { decoderRef.current?.close(); } catch { /* 已關 */ }
    decoderRef.current = null;
    codecRef.current = 0;
    needKeyRef.current = true;
  };
  useEffect(() => closeDecoder, []);

  const ensureDecoder = (codec: number): VideoDecoder | null => {
    if (decoderRef.current && codecRef.current === codec) return decoderRef.current;
    closeDecoder();
    if (typeof VideoDecoder === "undefined") {
      setUnsupported("WebCodecs");
      return null;
    }
    const d = new VideoDecoder({
      output: (frame) => {
        const c = canvasRef.current;
        if (c) {
          if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
            c.width = frame.displayWidth;
            c.height = frame.displayHeight;
            setSize({ w: frame.displayWidth, h: frame.displayHeight });
          }
          c.getContext("2d")?.drawImage(frame, 0, 0);
        }
        frame.close();
      },
      // 解碼器壞了：丟掉、等下一張關鍵畫面，並請對方馬上送一張。
      error: () => {
        closeDecoder();
        send({ t: "refresh" });
      },
    });
    d.configure({ codec: CODEC[codec] ?? CODEC[1], optimizeForLatency: true });
    decoderRef.current = d;
    codecRef.current = codec;
    needKeyRef.current = true;
    return d;
  };

  /** client 座標 → 遠端螢幕座標（object-fit: contain + 目前螢幕的偏移）。 */
  const toRemote = (clientX: number, clientY: number): [number, number] | null => {
    const c = canvasRef.current;
    if (!c || !c.width || !c.height) return null;
    const r = c.getBoundingClientRect();
    const scale = Math.min(r.width / c.width, r.height / c.height);
    if (!scale) return null;
    const ox = (r.width - c.width * scale) / 2;
    const oy = (r.height - c.height * scale) / 2;
    const x = Math.max(0, Math.min(c.width - 1, Math.floor((clientX - r.left - ox) / scale)));
    const y = Math.max(0, Math.min(c.height - 1, Math.floor((clientY - r.top - oy) / scale)));
    return [x + displayRef.current.x, y + displayRef.current.y];
  };

  const lastMove = useRef(0);
  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toRemote(e.clientX, e.clientY);
    if (!p) return;
    if (e.type === "pointermove") {
      // 滑鼠移動節流到 ~120 Hz：每筆都是一則 JSON，沒必要比螢幕更新還密。
      const now = performance.now();
      if (now - lastMove.current < 8) return;
      lastMove.current = now;
      send({ t: "mouse", mask: MOUSE.MOVE, x: p[0], y: p[1] });
      return;
    }
    const b = mouseButtonFromDom(e.button);
    if (b == null) return;
    if (e.type === "pointerdown") {
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
    send({ t: "mouse", mask: (e.type === "pointerdown" ? MOUSE.DOWN : MOUSE.UP) | (BUTTON_BIT[b] << 3), x: p[0], y: p[1] });
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // RustDesk 的滾輪：x / y 是格數的正負號（官方用戶端每格送 ±1）。
      const y = e.deltaY === 0 ? 0 : e.deltaY > 0 ? -1 : 1;
      const x = e.deltaX === 0 ? 0 : e.deltaX > 0 ? 1 : -1;
      if (x || y) send({ t: "mouse", mask: MOUSE.WHEEL, x, y });
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOnly]);

  const onKey = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (isPaneShortcut(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const sc = scancodeForCode(e.code);
    if (sc == null) return;
    send({ t: "key", down: e.type === "keydown", scancode: sc });
  };

  useImperativeHandle(ref, () => ({
    reset(connId: string) {
      connIdRef.current = connId;
      liveRef.current = false;
      closeDecoder();
    },
    output(buf: ArrayBuffer) {
      const u8 = new Uint8Array(buf);
      if (u8[0] === 1) {
        try {
          const ev = JSON.parse(new TextDecoder().decode(u8.subarray(1)));
          if (ev.type === "connected") {
            const cur = ev.peer?.displays?.[ev.peer?.current_display ?? 0];
            if (cur) displayRef.current = { x: cur.x ?? 0, y: cur.y ?? 0, width: cur.width ?? 0, height: cur.height ?? 0 };
          }
        } catch { /* 壞的 JSON：略過 */ }
        return;
      }
      const v = parseRustDeskVideo(buf);
      if (!v) return;
      const d = ensureDecoder(v.codec);
      if (!d) return;
      if (needKeyRef.current && !v.key) return; // 要從關鍵畫面開始解
      needKeyRef.current = false;
      try {
        d.decode(new EncodedVideoChunk({ type: v.key ? "key" : "delta", timestamp: v.pts * 1000, data: v.data }));
      } catch {
        closeDecoder();
        send({ t: "refresh" });
      }
    },
    connected(_info: RdConnInfo) {
      liveRef.current = true;
      canvasRef.current?.focus();
    },
    disconnected() {
      liveRef.current = false;
      closeDecoder();
    },
    combo(name: string) {
      if (name === "ctrl_alt_del") {
        if (liveRef.current && !viewOnly) void api.rdSendKeys(connIdRef.current, name).catch(() => undefined);
        return;
      }
      const seq: Record<string, number[]> = { win: [0xe05b], alt_tab: [0x38, 0x0f], ctrl_esc: [0x1d, 0x01], print_screen: [0xe037] };
      const keys = seq[name];
      if (!keys) return;
      for (const k of keys) send({ t: "key", down: true, scancode: k });
      for (const k of [...keys].reverse()) send({ t: "key", down: false, scancode: k });
    },
    paste() { /* 這一版的 RustDesk 還沒接剪貼簿 */ },
    focus() { canvasRef.current?.focus(); },
    refresh() { send({ t: "refresh" }); },
    desktopSize: () => size,
    rawKey(sc: number, down: boolean) { send({ t: "key", down, scancode: sc }); },
  }), [viewOnly, size]);

  return (
    <div className="flex-1 min-h-0 min-w-0 bg-black overflow-hidden relative" data-rd-rustdesk="">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="rd-surface outline-none block"
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
        data-rd-size={size.w ? `${size.w}x${size.h}` : undefined}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerUp={onPointer}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKey}
        onKeyUp={onKey}
      />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-fg/70 p-6 text-center">
          {t("這個環境的瀏覽器元件不支援 {what}，無法顯示 RustDesk 畫面。", { what: unsupported })}
        </div>
      )}
    </div>
  );
});

export default RustDeskView;
