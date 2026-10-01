// RustDesk 畫面：後端（經 AGPL 的 dbk-rustdesk-bridge 輔助程式）轉來的仍是 VP9 / VP8 / AV1 位元流，
// 這裡用 WebView 內建的 WebCodecs `VideoDecoder` 解，畫到 <canvas>——不需要任何原生的影像解碼函式庫。
// 輸入（滑鼠 / 鍵盤）轉成 JSON 指令，經 `rd_write` → 後端 → 輔助程式 → 對方。
//
// Channel 訊息 = `[u8 型別][內容]`：1 = JSON 事件（第一則是 `connected`，帶螢幕清單與偏移；之後可能有
// `displays`（插拔螢幕）/ `switch_display`（某個螢幕的位置大小變了）），
// 2 = 影像 `[u8 codec][u8 key][u8 display][u8 保留][i64 pts LE]` + 資料。
//
// 多螢幕（照 RustDesk 官方用戶端）：一次看一個螢幕，或「所有螢幕」照實際排列拼成一張。每個螢幕各自一條
// 影像串流、各自一個解碼器；不在看的螢幕的畫面（切換那一刻還在路上的）直接丟掉。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "./api";
import type { RdConnInfo } from "./rdTypes";
import { mouseButtonFromDom, scancodeForCode } from "./rdInput";
import { useT } from "./i18n";
import type { RdViewHandle } from "./rdView";
import { displayBounds, versionAtLeast, type RdDisplay, type RdMonitors } from "./rdMonitors";

export interface RustDeskViewProps {
  viewOnly: boolean;
  isPaneShortcut: (e: KeyboardEvent | React.KeyboardEvent) => boolean;
  /** 對方的螢幕清單 / 正在看哪幾個變了（工具列的切換螢幕按鈕用）；null = 沒有連線。 */
  onMonitors?: (m: RdMonitors | null) => void;
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

/** 對方 1.2.4 起畫面才帶螢幕編號、才能同時送好幾個螢幕（官方 `is_support_multi_ui_session`）。 */
const MULTI_DISPLAY_VERSION = "1.2.4";
/** 等關鍵畫面時，多久可以再請對方送一張（毫秒）。 */
const KEYFRAME_ASK_MS = 1500;
/** `keyAskRef` 裡代表「全部螢幕」的鍵。 */
const ALL = -1;

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

function toDisplay(d: unknown): RdDisplay {
  const o = (d ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { x: n(o.x), y: n(o.y), width: n(o.width), height: n(o.height), name: typeof o.name === "string" ? o.name : "" };
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

type Decoder = { dec: VideoDecoder | null; codec: number; needKey: boolean };

const RustDeskView = forwardRef<RdViewHandle, RustDeskViewProps>(function RustDeskView({ viewOnly, isPaneShortcut, onMonitors }, ref) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connIdRef = useRef("");
  const liveRef = useRef(false);
  /** 每個螢幕一個解碼器（各自一條 VP9 / VP8 / AV1 串流）。 */
  const decodersRef = useRef(new Map<number, Decoder>());
  /** 上次請對方重送關鍵畫面的時間（每個螢幕；`ALL` = 全部）。 */
  const keyAskRef = useRef(new Map<number, number>());
  const monRef = useRef<RdMonitors>({ displays: [], shown: [0], multi: true });
  /** 使用者選的螢幕：斷線重連後套回去。 */
  const wantedRef = useRef<number[] | null>(null);
  const onMonitorsRef = useRef(onMonitors);
  useEffect(() => { onMonitorsRef.current = onMonitors; }, [onMonitors]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [unsupported, setUnsupported] = useState<string | null>(null);

  const publish = (m: RdMonitors | null) => {
    if (m) monRef.current = m;
    onMonitorsRef.current?.(m && { ...m, displays: [...m.displays], shown: [...m.shown] });
  };

  /** 送指令給對方（換螢幕、要關鍵畫面：只看不控時也要能用）。 */
  const write = (cmd: object) => {
    if (!liveRef.current) return;
    void api.rdWrite(connIdRef.current, new TextEncoder().encode(JSON.stringify(cmd))).catch(() => undefined);
  };
  /** 輸入（滑鼠 / 鍵盤）：只看不控時不送。 */
  const send = (cmd: object) => {
    if (!viewOnly) write(cmd);
  };

  /** 請對方重送關鍵畫面（同一個螢幕一段時間內只問一次）。 */
  const askKeyframe = (display: number) => {
    const now = performance.now();
    if (now - (keyAskRef.current.get(display) ?? -Infinity) < KEYFRAME_ASK_MS) return;
    if (now - (keyAskRef.current.get(ALL) ?? -Infinity) < KEYFRAME_ASK_MS) return;
    keyAskRef.current.set(display, now);
    write({ t: "refresh" });
  };

  const closeDecoder = (display: number) => {
    const d = decodersRef.current.get(display);
    decodersRef.current.delete(display);
    try { d?.dec?.close(); } catch { /* 已關 */ }
  };
  const closeAll = () => {
    for (const k of [...decodersRef.current.keys()]) closeDecoder(k);
  };
  useEffect(() => closeAll, []);

  /** 解出來的一張畫面：一個螢幕 = 畫布就是那張的大小；所有螢幕 = 畫布是外框，各自畫到自己的位置。 */
  const draw = (display: number, frame: VideoFrame) => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    const { displays, shown } = monRef.current;
    if (c && ctx && shown.includes(display)) {
      const box = shown.length > 1 ? displayBounds(displays, shown) : null;
      const w = box ? box.w : frame.displayWidth;
      const h = box ? box.h : frame.displayHeight;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
        setSize({ w, h });
        // 拼圖時改大小會清掉其他螢幕已經畫好的部分：請對方都重送一張。
        if (box) askKeyframe(ALL);
      }
      const d = displays[display];
      if (box && d) ctx.drawImage(frame, d.x - box.x, d.y - box.y, d.width, d.height);
      else ctx.drawImage(frame, 0, 0);
    }
    frame.close();
  };

  const ensureDecoder = (display: number, codec: number): Decoder | null => {
    const cur = decodersRef.current.get(display);
    if (cur && cur.codec === codec) return cur;
    closeDecoder(display);
    if (typeof VideoDecoder === "undefined") {
      setUnsupported("WebCodecs");
      return null;
    }
    const entry: Decoder = { dec: null, codec, needKey: true };
    const dec = new VideoDecoder({
      output: (frame) => draw(display, frame),
      // 解碼器壞了：丟掉、等下一張關鍵畫面，並請對方馬上送一張。
      error: () => {
        if (decodersRef.current.get(display) === entry) decodersRef.current.delete(display);
        askKeyframe(display);
      },
    });
    dec.configure({ codec: CODEC[codec] ?? CODEC[1], optimizeForLatency: true });
    entry.dec = dec;
    decodersRef.current.set(display, entry);
    return entry;
  };

  /** 換成看這幾個螢幕（一個 = 切過去；多個 = 拼起來一起看）。`remember` = 使用者選的（重連後套回去）。 */
  const showDisplays = (set: number[], remember = true) => {
    const m = monRef.current;
    const valid = [...new Set(set)].filter((i) => Number.isInteger(i) && i >= 0 && i < Math.max(1, m.displays.length));
    if (!valid.length) return;
    if (valid.length > 1 && !(m.multi && displayBounds(m.displays, valid))) return;
    if (remember) wantedRef.current = valid;
    if (sameSet(valid, m.shown)) return;
    for (const k of [...decodersRef.current.keys()]) if (!valid.includes(k)) closeDecoder(k);
    // 指令本身就會要每個螢幕的關鍵畫面：短時間內不必再問。
    const now = performance.now();
    for (const k of [ALL, ...valid]) keyAskRef.current.set(k, now);
    publish({ ...m, shown: valid });
    write({ t: "displays", set: valid });
  };

  /** 對方送來新的螢幕清單（插拔螢幕 / 改排列）。 */
  const onDisplays = (list: RdDisplay[]) => {
    const m = monRef.current;
    const was = m.shown;
    let next: number[];
    if (was.length > 1) next = list.length > 1 && m.multi ? list.map((_, i) => i) : [0];
    else next = was.filter((i) => i < list.length);
    if (!next.length) next = [0];
    monRef.current = { ...m, displays: list };
    if (sameSet(next, was)) publish(monRef.current);
    else showDisplays(next, false);
  };

  /** 對方說某個螢幕的位置大小（切過去之後 / 換了解析度）。 */
  const onSwitchDisplay = (ev: Record<string, unknown>) => {
    const i = ev.display;
    const m = monRef.current;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0) return;
    const d = toDisplay(ev);
    const displays = [...m.displays];
    if (d.width > 0 && d.height > 0 && i < displays.length) displays[i] = { ...displays[i], x: d.x, y: d.y, width: d.width, height: d.height };
    // 舊版對方的畫面不帶螢幕編號：它說換了就跟著換。
    const shown = !m.multi && m.shown[0] !== i && i < Math.max(1, displays.length) ? [i] : m.shown;
    publish({ ...m, displays, shown });
  };

  /** client 座標 → 遠端螢幕座標（object-fit: contain + 目前螢幕 / 拼圖外框的偏移）。 */
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
    const { displays, shown } = monRef.current;
    const origin = (shown.length > 1 ? displayBounds(displays, shown) : null) ?? displays[shown[0]] ?? { x: 0, y: 0 };
    return [x + origin.x, y + origin.y];
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
      closeAll();
      keyAskRef.current.clear();
      monRef.current = { displays: [], shown: [0], multi: true };
      publish(null);
    },
    output(buf: ArrayBuffer) {
      const u8 = new Uint8Array(buf);
      if (u8[0] === 1) {
        try {
          const ev = JSON.parse(new TextDecoder().decode(u8.subarray(1)));
          if (ev.type === "connected") {
            const peer = ev.peer ?? {};
            const displays = Array.isArray(peer.displays) ? peer.displays.map(toDisplay) : [];
            const cur = typeof peer.current_display === "number" && peer.current_display >= 0 ? peer.current_display : 0;
            publish({ displays, shown: [cur], multi: versionAtLeast(peer.version, MULTI_DISPLAY_VERSION) });
          } else if (ev.type === "displays" && Array.isArray(ev.displays)) {
            onDisplays(ev.displays.map(toDisplay));
          } else if (ev.type === "switch_display") {
            onSwitchDisplay(ev);
          }
        } catch { /* 壞的 JSON：略過 */ }
        return;
      }
      const v = parseRustDeskVideo(buf);
      if (!v) return;
      const { shown, multi } = monRef.current;
      // 舊版對方的畫面都標 0：就是正在看的那個。
      const display = multi ? v.display : shown[0];
      if (!shown.includes(display)) return; // 換螢幕那一刻還在路上的舊畫面
      const d = ensureDecoder(display, v.codec);
      if (!d?.dec) return;
      if (d.needKey && !v.key) {
        // 要從關鍵畫面開始解；遲遲等不到就請對方送一張。
        askKeyframe(display);
        return;
      }
      d.needKey = false;
      try {
        d.dec.decode(new EncodedVideoChunk({ type: v.key ? "key" : "delta", timestamp: v.pts * 1000, data: v.data }));
      } catch {
        closeDecoder(display);
        askKeyframe(display);
      }
    },
    connected(_info: RdConnInfo) {
      liveRef.current = true;
      // 斷線重連：套回使用者上次選的螢幕。
      const want = wantedRef.current;
      if (want) showDisplays(want, false);
      canvasRef.current?.focus();
    },
    disconnected() {
      liveRef.current = false;
      closeAll();
      publish(null);
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
    refresh() { write({ t: "refresh" }); },
    desktopSize: () => size,
    rawKey(sc: number, down: boolean) { send({ t: "key", down, scancode: sc }); },
    showDisplays(set: number[]) {
      showDisplays(set);
      canvasRef.current?.focus();
    },
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
