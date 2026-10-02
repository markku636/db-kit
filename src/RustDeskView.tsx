// RustDesk 畫面：後端（經 AGPL 的 dbk-rustdesk-bridge 輔助程式）轉來的仍是 VP9 / VP8 / AV1 位元流，
// 這裡用 WebView 內建的 WebCodecs `VideoDecoder` 解，畫到 <canvas>——不需要任何原生的影像解碼函式庫。
// 輸入（滑鼠 / 鍵盤）轉成 JSON 指令，經 `rd_write` → 後端 → 輔助程式 → 對方。
//
// Channel 訊息 = `[u8 型別][內容]`：1 = JSON 事件（第一則是 `connected`，帶螢幕清單與偏移；之後可能有
// `displays`（插拔螢幕）/ `switch_display`（某個螢幕的位置大小變了）/ `permission` / `clipboard` / `chat` /
// `block_input` / `msgbox` / `delay` / `cursor_data` / `cursor_id` / `cursor_position` / `follow_display` / `screenshot`），2 = 影像 `[u8 codec][u8 key][u8 display][u8 保留][i64 pts LE]` + 資料。
//
// 多螢幕（照 RustDesk 官方用戶端）：一次看一個螢幕，或「所有螢幕」照實際排列拼成一張。每個螢幕各自一條
// 影像串流、各自一個解碼器；不在看的螢幕的畫面（切換那一刻還在路上的）直接丟掉。
//
// 工具列要的狀態（螢幕、權限、聊天、連線品質）整包經 `onState` 交給 RdPane；顯示偏好（畫質 / 編碼 / 檢視方式…）
// 由 RdPane 從主機設定讀出來經 `prefs` 傳進來，連上時與改變時送給對方。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "./api";
import type { RdConnInfo } from "./rdTypes";
import { mouseButtonFromDom, scancodeForCode } from "./rdInput";
import { chordedChange, HeldKeys, lockModes, mouseModifiers, translatedChar } from "./rustdeskInput";
import { useT } from "./i18n";
import { toast } from "./ui";
import type { RdViewHandle } from "./rdView";
import { displayBounds, versionAtLeast, type RdDisplay, type RdMonitors } from "./rdMonitors";
import { startRecording as beginRecording, type RdRecording } from "./rdRecorder";
import {
  addMyChat, applyEvent, canTrueColor, DEFAULT_PREFS, initialState, probeCodecs, WEBCODECS,
  type RustDeskPrefs, type RustDeskState,
} from "./rustdeskState";
import { decoderCodec } from "./rdVideoProfile";
import { cursorPng, scaleBucket, type RdCursorImage } from "./rdCursor";

export interface RustDeskViewProps {
  viewOnly: boolean;
  isPaneShortcut: (e: KeyboardEvent | React.KeyboardEvent) => boolean;
  /** 主機設定的「同步剪貼簿」。 */
  clipboard: boolean;
  prefs: RustDeskPrefs;
  /** 工具列要的狀態變了；null = 沒有連線。 */
  onState?: (s: RustDeskState | null) => void;
}

/** codec 代碼（跟 bridge 的 session::Codec 一致）→ WebCodecs 的 codec 字串。 */
const CODEC: Record<number, string> = {
  1: WEBCODECS.vp9,
  2: WEBCODECS.vp8,
  3: WEBCODECS.av1,
  4: "avc1.42E01F",
  5: "hvc1.1.6.L93.B0",
};
const CODEC_NAME: Record<number, string> = { 1: "VP9", 2: "VP8", 3: "AV1", 4: "H.264", 5: "H.265" };

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

/** 工具列「動作」選單送給對方的。 */
export type RustDeskAction = "ctrl_alt_del" | "lock_screen" | "restart" | "refresh";

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

/** base64 → bytes；壞的 → null。 */
function fromBase64(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** 截圖等對方回覆最多等多久（毫秒）。 */
const SCREENSHOT_TIMEOUT_MS = 20000;

/** 每個螢幕的解碼器；`codecStr` = 設定時用的 codec 字串（真彩時是 4:4:4 的 profile）。 */
type Decoder = { dec: VideoDecoder | null; codec: number; codecStr: string; needKey: boolean };

const RustDeskView = forwardRef<RdViewHandle, RustDeskViewProps>(function RustDeskView(
  { viewOnly, isPaneShortcut, clipboard, prefs, onState }, ref,
) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connIdRef = useRef("");
  const liveRef = useRef(false);
  /** 每個螢幕一個解碼器（各自一條 VP9 / VP8 / AV1 串流）。 */
  const decodersRef = useRef(new Map<number, Decoder>());
  /** 上次請對方重送關鍵畫面的時間（每個螢幕；`ALL` = 全部）。 */
  const keyAskRef = useRef(new Map<number, number>());
  const stRef = useRef<RustDeskState>(initialState());
  /** 使用者選的螢幕：斷線重連後套回去。 */
  const wantedRef = useRef<number[] | null>(null);
  const onStateRef = useRef(onState);
  useEffect(() => { onStateRef.current = onState; }, [onState]);
  const optsRef = useRef({ viewOnly, clipboard, prefs });
  useEffect(() => { optsRef.current = { viewOnly, clipboard, prefs }; }, [viewOnly, clipboard, prefs]);
  // 剪貼簿來回：記住最後從對方拿到的與最後送出的，免得同一段文字在兩邊來回彈。
  const lastRemoteClipRef = useRef<string | null>(null);
  const lastSentClipRef = useRef<string | null>(null);
  /** 連線品質：這一秒收到幾張畫面、多少資料。 */
  const meterRef = useRef({ frames: 0, bytes: 0, codec: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [stats, setStats] = useState<RustDeskState["stats"]>(null);

  const publish = (s: RustDeskState | null) => {
    if (s) stRef.current = s;
    if (s) setStats(s.stats);
    onStateRef.current?.(s && { ...s, monitors: { ...s.monitors, displays: [...s.monitors.displays], shown: [...s.monitors.shown] } });
  };
  const setMonitors = (m: RdMonitors) => publish({ ...stRef.current, monitors: m });

  /** 送指令給對方（換螢幕、要關鍵畫面、畫質…：只看不控時也要能用）。 */
  const write = (cmd: object) => {
    if (!liveRef.current) return;
    void api.rdWrite(connIdRef.current, new TextEncoder().encode(JSON.stringify(cmd))).catch(() => undefined);
  };
  /** 輸入（滑鼠 / 鍵盤 / 打字）：只看不控時不送。 */
  const send = (cmd: object) => {
    if (!optsRef.current.viewOnly) write(cmd);
  };

  /** 剪貼簿同步開著：主機設定開、不是只看不控、對方也允許。 */
  const clipboardOn = () => optsRef.current.clipboard && !optsRef.current.viewOnly && stRef.current.perms.clipboard;

  /** 本機剪貼簿有新文字 → 送給對方（畫面拿到焦點時檢查，跟 RDP 一樣）。 */
  const syncLocalClipboard = async () => {
    if (!liveRef.current || !clipboardOn()) return;
    try {
      // 後端讀系統剪貼簿（navigator.clipboard.readText 會跳權限詢問、搶走畫面焦點）。
      const text = await api.rdClipboardRead();
      if (!text || text === lastRemoteClipRef.current || text === lastSentClipRef.current) return;
      lastSentClipRef.current = text;
      write({ t: "clipboard", text });
    } catch { /* 讀不到剪貼簿：略過 */ }
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

  // ---- 錄影（官方用戶端的「錄影」：錄這端看到的畫面；開始 / 停止時告訴對方） ----
  const recRef = useRef<RdRecording | null>(null);
  const stopRecording = async () => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    publish({ ...stRef.current, recording: false });
    write({ t: "record", on: false });
    try {
      const path = await r.stop();
      if (path) {
        stRef.current = { ...stRef.current, lastRecording: path };
        if (liveRef.current) publish(stRef.current);
        toast.success(t("錄影已存到 {path}", { path }));
      }
    } catch (e) {
      toast.error(t("錄影存檔失敗：{e}", { e: e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e) }));
    }
  };
  const startRecordingNow = async (name: string) => {
    const c = canvasRef.current;
    if (recRef.current || !c || !liveRef.current) return;
    try {
      recRef.current = await beginRecording(c, name, (e) => {
        toast.error(t("錄影寫入失敗，已停止：{e}", { e: String((e as { message?: unknown })?.message ?? e) }));
        void stopRecording();
      });
    } catch (e) {
      const msg = e instanceof Error && e.message === "MediaRecorder"
        ? t("這個環境的瀏覽器元件不支援錄影")
        : String((e as { message?: unknown })?.message ?? e);
      toast.error(t("無法開始錄影：{e}", { e: msg }));
      return;
    }
    publish({ ...stRef.current, recording: true });
    write({ t: "record", on: true });
  };
  // 分頁關掉：把錄到的部分存好。
  useEffect(() => () => { void stopRecording(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 這個 WebView 能解哪些編碼（工具列的「編碼」選單只列解得了的）。
  useEffect(() => {
    let alive = true;
    void probeCodecs().then((codecs) => {
      if (alive) publish({ ...stRef.current, codecs });
    });
    return () => { alive = false; };
  }, []);

  /** 解出來的一張畫面：一個螢幕 = 畫布就是那張的大小；所有螢幕 = 畫布是外框，各自畫到自己的位置。 */
  const draw = (display: number, frame: VideoFrame) => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    const { displays, shown } = stRef.current.monitors;
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
      meterRef.current.frames++;
    }
    frame.close();
  };

  /** `key` = 這張是關鍵畫面的資料：看它的 profile（真彩 4:4:4 是另一個 profile），跟解碼器的設定不一樣就重設。 */
  const ensureDecoder = (display: number, codec: number, key: Uint8Array | null): Decoder | null => {
    const cur = decodersRef.current.get(display);
    const want = key ? decoderCodec(codec, key, CODEC[codec] ?? CODEC[1]) : (cur?.codec === codec ? cur.codecStr : CODEC[codec] ?? CODEC[1]);
    if (cur && cur.codec === codec && cur.codecStr === want) return cur;
    closeDecoder(display);
    if (typeof VideoDecoder === "undefined") {
      setUnsupported("WebCodecs");
      return null;
    }
    const entry: Decoder = { dec: null, codec, codecStr: want, needKey: true };
    const dec = new VideoDecoder({
      output: (frame) => draw(display, frame),
      // 解碼器壞了：丟掉、等下一張關鍵畫面，並請對方馬上送一張。
      error: () => {
        if (decodersRef.current.get(display) === entry) decodersRef.current.delete(display);
        askKeyframe(display);
      },
    });
    dec.configure({ codec: want, optimizeForLatency: true });
    entry.dec = dec;
    decodersRef.current.set(display, entry);
    return entry;
  };

  /** 換成看這幾個螢幕（一個 = 切過去；多個 = 拼起來一起看）。`remember` = 使用者選的（重連後套回去）。 */
  const showDisplays = (set: number[], remember = true) => {
    const m = stRef.current.monitors;
    const valid = [...new Set(set)].filter((i) => Number.isInteger(i) && i >= 0 && i < Math.max(1, m.displays.length));
    if (!valid.length) return;
    if (valid.length > 1 && !(m.multi && displayBounds(m.displays, valid))) return;
    if (remember) wantedRef.current = valid;
    if (sameSet(valid, m.shown)) return;
    for (const k of [...decodersRef.current.keys()]) if (!valid.includes(k)) closeDecoder(k);
    // 指令本身就會要每個螢幕的關鍵畫面：短時間內不必再問。
    const now = performance.now();
    for (const k of [ALL, ...valid]) keyAskRef.current.set(k, now);
    setMonitors({ ...m, shown: valid });
    write({ t: "displays", set: valid });
  };

  /** 對方送來新的螢幕清單（插拔螢幕 / 改排列）。 */
  const onDisplays = (list: RdDisplay[]) => {
    const m = stRef.current.monitors;
    const was = m.shown;
    let next: number[];
    if (was.length > 1) next = list.length > 1 && m.multi ? list.map((_, i) => i) : [0];
    else next = was.filter((i) => i < list.length);
    if (!next.length) next = [0];
    stRef.current = { ...stRef.current, monitors: { ...m, displays: list } };
    if (sameSet(next, was)) publish(stRef.current);
    else showDisplays(next, false);
  };

  /** 對方說某個螢幕的位置大小（切過去之後 / 換了解析度）。 */
  const onSwitchDisplay = (ev: Record<string, unknown>) => {
    const i = ev.display;
    const m = stRef.current.monitors;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0) return;
    const d = toDisplay(ev);
    const displays = [...m.displays];
    if (d.width > 0 && d.height > 0 && i < displays.length) displays[i] = { ...displays[i], x: d.x, y: d.y, width: d.width, height: d.height };
    // 舊版對方的畫面不帶螢幕編號：它說換了就跟著換。
    const shown = !m.multi && m.shown[0] !== i && i < Math.max(1, displays.length) ? [i] : m.shown;
    setMonitors({ ...m, displays, shown });
  };

  // ---- 偏好：連上時整組送一次（`applyAll`），之後改哪個送哪個 ----
  const sendQuality = (q: RustDeskPrefs["quality"]) => write({ t: "quality", level: q });
  /** 偏好的編碼 + 這端能解哪些；真彩只在解得了 4:4:4 時要。 */
  const sendCodec = () => {
    const { codec, trueColor } = optsRef.current.prefs;
    const c = stRef.current.codecs;
    write({ t: "codec", prefer: codec, vp9: c.vp9, vp8: c.vp8, av1: c.av1, i444: trueColor && canTrueColor(c) });
  };
  const sendClipboardToggle = () => write({ t: "toggle", name: "disable_clipboard", on: !(optsRef.current.clipboard && !optsRef.current.viewOnly) });
  const sendToggle = (name: string, on: boolean) => write({ t: "toggle", name, on });
  const applyAll = () => {
    const p = optsRef.current.prefs;
    // 對方預設就是「平衡」、編碼照登入時宣告的、游標相關都關著：跟預設一樣就不送。
    if (p.quality !== DEFAULT_PREFS.quality) sendQuality(p.quality);
    if (p.codec !== DEFAULT_PREFS.codec || p.trueColor) sendCodec();
    if (p.lockAfterEnd) sendToggle("lock_after_session_end", true);
    if (p.showRemoteCursor) sendToggle("show_remote_cursor", true);
    if (p.followRemoteCursor) sendToggle("follow_remote_cursor", true);
    if (p.followRemoteWindow) sendToggle("follow_remote_window", true);
    if (!optsRef.current.clipboard || optsRef.current.viewOnly) sendClipboardToggle();
  };
  useEffect(() => { sendQuality(prefs.quality); }, [prefs.quality]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sendCodec(); }, [prefs.codec, prefs.trueColor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sendToggle("lock_after_session_end", prefs.lockAfterEnd); }, [prefs.lockAfterEnd]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sendToggle("show_remote_cursor", prefs.showRemoteCursor); }, [prefs.showRemoteCursor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sendToggle("follow_remote_cursor", prefs.followRemoteCursor); }, [prefs.followRemoteCursor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sendToggle("follow_remote_window", prefs.followRemoteWindow); }, [prefs.followRemoteWindow]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sendClipboardToggle(); }, [clipboard, viewOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 連線品質：每秒算一次 FPS / 速率（只在打開時） ----
  useEffect(() => {
    if (!prefs.stats) {
      if (stRef.current.stats) publish({ ...stRef.current, stats: null });
      return;
    }
    meterRef.current.frames = 0;
    meterRef.current.bytes = 0;
    const id = window.setInterval(() => {
      if (!liveRef.current) return;
      const m = meterRef.current;
      const c = canvasRef.current;
      publish({
        ...stRef.current,
        stats: {
          fps: m.frames,
          kbps: Math.round(m.bytes / 1024),
          delay: stRef.current.stats?.delay ?? null,
          codec: CODEC_NAME[m.codec] ?? "",
          width: c?.width ?? 0,
          height: c?.height ?? 0,
        },
      });
      m.frames = 0;
      m.bytes = 0;
    }, 1000);
    return () => window.clearInterval(id);
  }, [prefs.stats]);

  /** 畫布在畫面上的位置與比例：適應視窗 = object-fit: contain（含留白）；原始大小 / 自訂縮放 = 畫布就是那個大小。 */
  const surface = () => {
    const c = canvasRef.current;
    if (!c || !c.width || !c.height) return null;
    const r = c.getBoundingClientRect();
    let scale = r.width / c.width;
    let ox = 0;
    let oy = 0;
    if (optsRef.current.prefs.view === "adaptive") {
      scale = Math.min(r.width / c.width, r.height / c.height);
      ox = (r.width - c.width * scale) / 2;
      oy = (r.height - c.height * scale) / 2;
    }
    return scale ? { c, r, scale, ox, oy } : null;
  };
  /** 畫布左上角在遠端的座標（目前螢幕 / 拼圖外框）。 */
  const origin = () => {
    const { displays, shown } = stRef.current.monitors;
    return (shown.length > 1 ? displayBounds(displays, shown) : null) ?? displays[shown[0]] ?? { x: 0, y: 0 };
  };
  /** client 座標 → 遠端螢幕座標。 */
  const toRemote = (clientX: number, clientY: number): [number, number] | null => {
    const s = surface();
    if (!s) return null;
    const x = Math.max(0, Math.min(s.c.width - 1, Math.floor((clientX - s.r.left - s.ox) / s.scale)));
    const y = Math.max(0, Math.min(s.c.height - 1, Math.floor((clientY - s.r.top - s.oy) / s.scale)));
    const o = origin();
    return [x + o.x, y + o.y];
  };
  /** 遠端座標 → 在外框（可捲動的那層）裡的位置；不在看的範圍內 → null。 */
  const fromRemote = (rx: number, ry: number): [number, number] | null => {
    const s = surface();
    const wrap = s?.c.parentElement;
    if (!s || !wrap) return null;
    const o = origin();
    const x = rx - o.x;
    const y = ry - o.y;
    if (x < 0 || y < 0 || x >= s.c.width || y >= s.c.height) return null;
    const w = wrap.getBoundingClientRect();
    return [x * s.scale + s.ox + s.r.left - w.left + wrap.scrollLeft, y * s.scale + s.oy + s.r.top - w.top + wrap.scrollTop];
  };

  // ---- 游標（官方用戶端也是）：畫面上的游標換成對方的游標形狀，照畫面縮放比例；
  // 開了「顯示對方游標」時，對方那邊有人移動游標 → 畫在對方游標的位置（本機游標先藏起來，本機一動就換回來）。 ----
  const cursorsRef = useRef(new Map<string, RdCursorImage>());
  const cursorIdRef = useRef<string | null>(null);
  const cursorPngRef = useRef(new Map<string, ReturnType<typeof cursorPng>>());
  /** 對方游標被對方那邊移動到的位置（遠端座標）；本機動了滑鼠 = null。 */
  const remotePosRef = useRef<[number, number] | null>(null);
  const overlayRef = useRef<HTMLImageElement>(null);
  const currentCursor = () => {
    const id = cursorIdRef.current;
    const img = id == null ? undefined : cursorsRef.current.get(id);
    const s = surface();
    if (!img || !s) return null;
    const bucket = scaleBucket(s.scale);
    const key = `${id}@${bucket}`;
    let png = cursorPngRef.current.get(key);
    if (png === undefined) {
      if (cursorPngRef.current.size > 256) cursorPngRef.current.clear();
      png = cursorPng(img, bucket);
      cursorPngRef.current.set(key, png);
    }
    return png;
  };
  const applyCursor = () => {
    const c = canvasRef.current;
    const o = overlayRef.current;
    if (!c) return;
    const png = currentCursor();
    const rp = remotePosRef.current;
    const at = rp && png && optsRef.current.prefs.showRemoteCursor ? fromRemote(rp[0], rp[1]) : null;
    c.style.cursor = at ? "none" : png ? `url(${png.url}) ${png.hx} ${png.hy}, default` : "";
    if (!o) return;
    if (at && png) {
      if (o.getAttribute("src") !== png.url) o.src = png.url;
      o.style.left = `${Math.round(at[0] - png.hx)}px`;
      o.style.top = `${Math.round(at[1] - png.hy)}px`;
      o.style.display = "block";
    } else o.style.display = "none";
  };
  useEffect(() => {
    if (!prefs.showRemoteCursor) remotePosRef.current = null;
    applyCursor();
  }, [size, prefs.view, prefs.scale, prefs.showRemoteCursor]); // eslint-disable-line react-hooks/exhaustive-deps
  // 分頁大小變了（適應視窗時比例跟著變）。
  useEffect(() => {
    const wrap = canvasRef.current?.parentElement;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => applyCursor());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onCursorData = (ev: Record<string, unknown>) => {
    const { id, hotx, hoty, width, height, rgba } = ev;
    if (typeof id !== "string" || typeof rgba !== "string") return;
    if (![hotx, hoty, width, height].every((n) => typeof n === "number" && Number.isInteger(n))) return;
    const w = width as number;
    const h = height as number;
    const bytes = fromBase64(rgba);
    if (!bytes || w <= 0 || h <= 0 || bytes.length !== w * h * 4) return;
    cursorsRef.current.set(id, { width: w, height: h, hotx: hotx as number, hoty: hoty as number, rgba: new Uint8ClampedArray(bytes.buffer) });
    for (const k of [...cursorPngRef.current.keys()]) if (k.startsWith(`${id}@`)) cursorPngRef.current.delete(k);
    // 對方送游標圖時就是換成這個游標了（官方也是收到 CursorData 就套用）。
    cursorIdRef.current = id;
    applyCursor();
  };

  // ---- 截圖（官方的「截圖」：對方擷取那個螢幕原始畫質的畫面、編成 PNG 回來；後端存進截圖資料夾） ----
  const shotRef = useRef<{ name: string; resolve: (path: string | null) => void; reject: (e: Error) => void; timer: number } | null>(null);
  /** 收掉等著的截圖（回傳它，讓呼叫的人決定成功 / 失敗）。 */
  const takeShot = () => {
    const s = shotRef.current;
    shotRef.current = null;
    if (s) window.clearTimeout(s.timer);
    return s;
  };
  /** 回傳存檔路徑；沒連線（或上一張還在等）→ null；對方回錯誤 / 沒回應 / 存檔失敗 → reject。 */
  const takeScreenshot = (name: string): Promise<string | null> => {
    if (!liveRef.current || shotRef.current) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        takeShot();
        reject(new Error(t("對方沒有回應（對方的 RustDesk 可能太舊）")));
      }, SCREENSHOT_TIMEOUT_MS);
      shotRef.current = { name, resolve, reject, timer };
      write({ t: "screenshot", display: stRef.current.monitors.shown[0] ?? 0 });
    });
  };
  const onScreenshot = (ev: Record<string, unknown>) => {
    const s = takeShot();
    if (!s) return; // 逾時之後才回來的：已經回報過了
    const png = typeof ev.png === "string" ? fromBase64(ev.png) : null;
    if (!png?.length) {
      s.reject(new Error(String(ev.error ?? "empty screenshot")));
      return;
    }
    api.rdScreenshotSave(s.name, png).then((path) => {
      if (liveRef.current) publish({ ...stRef.current, lastScreenshot: path });
      else stRef.current = { ...stRef.current, lastScreenshot: path };
      s.resolve(path);
    }, (e) => s.reject(e instanceof Error ? e : new Error(String((e as { message?: unknown })?.message ?? e))));
  };
  // 分頁關掉：等著的截圖不會回來了。
  useEffect(() => () => { takeShot()?.resolve(null); }, []);

  // 滑鼠移動節流到 ~120 Hz（每筆都是一則 JSON）；被省掉的最後一筆稍後補送，按下 / 放開前也先補——
  // 對方按鍵是按在「目前游標」上，不補的話點下去的位置會是幾毫秒前的（雙擊小圖示會點偏）。
  const moveRef = useRef<{ at: number; sent: string; pending: { x: number; y: number; mods: object } | null; timer: number }>(
    { at: 0, sent: "", pending: null, timer: 0 });
  /** `force`：按下 / 放開前一定送（對方那邊的人可能動過游標）。 */
  const sendMove = (x: number, y: number, mods: object, force = false) => {
    const m = moveRef.current;
    m.pending = null;
    m.at = performance.now();
    if (!force && m.sent === `${x},${y}`) return;
    m.sent = `${x},${y}`;
    send({ t: "mouse", mask: MOUSE.MOVE, x, y, ...mods });
  };
  useEffect(() => () => window.clearTimeout(moveRef.current.timer), []);
  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toRemote(e.clientX, e.clientY);
    if (!p) return;
    if (remotePosRef.current) {
      remotePosRef.current = null;
      applyCursor();
    }
    const mods = mouseModifiers(e);
    let type: "down" | "up" | null = e.type === "pointerdown" ? "down" : e.type === "pointerup" ? "up" : null;
    if (e.type === "pointermove") {
      // 按著一顆再按 / 放另一顆：瀏覽器只給 pointermove。
      type = chordedChange(e.button, e.buttons);
      if (!type) {
        const m = moveRef.current;
        const wait = 8 - (performance.now() - m.at);
        if (wait > 0) {
          m.pending = { x: p[0], y: p[1], mods };
          if (!m.timer) {
            m.timer = window.setTimeout(() => {
              m.timer = 0;
              if (m.pending) sendMove(m.pending.x, m.pending.y, m.pending.mods);
            }, wait);
          }
          return;
        }
        sendMove(p[0], p[1], mods);
        return;
      }
    }
    const b = mouseButtonFromDom(e.button);
    if (b == null || !type) return;
    if (e.type === "pointerdown") {
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
    sendMove(p[0], p[1], mods, true);
    send({ t: "mouse", mask: (type === "down" ? MOUSE.DOWN : MOUSE.UP) | (BUTTON_BIT[b] << 3), x: p[0], y: p[1], ...mods });
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      const p = optsRef.current.prefs;
      // 原始大小 / 自訂縮放時滾輪留給本機捲動（畫面比分頁大）；按住 Shift 則照樣送給對方。
      if (p.view !== "adaptive" && !e.shiftKey) {
        const wrap = c.parentElement;
        if (wrap && (wrap.scrollHeight > wrap.clientHeight || wrap.scrollWidth > wrap.clientWidth)) return;
      }
      e.preventDefault();
      // RustDesk 的滾輪：x / y 是格數的正負號（官方用戶端每格送 ±1）；「滾輪反向」兩個方向都反過來。
      const dir = p.reverseWheel ? -1 : 1;
      const y = (e.deltaY === 0 ? 0 : e.deltaY > 0 ? -1 : 1) * dir;
      const x = (e.deltaX === 0 ? 0 : e.deltaX > 0 ? 1 : -1) * dir;
      if (x || y) send({ t: "mouse", mask: MOUSE.WHEEL, x, y });
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 鍵盤：帶鎖定鍵狀態；記住按著的鍵，畫面失去焦點時放開 ----
  /** 最近一次知道的本機 CapsLock / NumLock（鍵盤 hook 攔到的鍵沒有事件物件可問）。 */
  const locksRef = useRef({ caps: false, num: false });
  const [held] = useState(() => new HeldKeys());
  const sendKey = (scancode: number, down: boolean) => {
    if (optsRef.current.viewOnly || !liveRef.current) return;
    held.update(scancode, down);
    send({ t: "key", down, scancode, ...locksRef.current });
  };
  const releaseKeys = () => {
    for (const k of held.releaseAll()) send({ t: "key", ...k, ...locksRef.current });
  };

  const onKey = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (isPaneShortcut(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const sc = scancodeForCode(e.code);
    locksRef.current = lockModes(e);
    // 翻譯模式：打得出字的鍵送那個字（只送按下）；之前照位置按下去的鍵（例如按著 Ctrl 時）放開照樣照位置送。
    if (optsRef.current.prefs.keyboard === "translate" && !(e.type === "keyup" && sc != null && held.has(sc))) {
      if (e.key === "Dead") return; // 重音之類的組字鍵：等下一個鍵組出字再送（官方也略過）
      const ch = translatedChar(e);
      if (ch != null) {
        if (e.type === "keydown") send({ t: "char", text: ch });
        return;
      }
    }
    if (sc == null) return;
    sendKey(sc, e.type === "keydown");
  };

  /** 對方的事件（影像以外）。 */
  const onEvent = (ev: Record<string, unknown>) => {
    if (ev.type === "connected") {
      const peer = (ev.peer ?? {}) as Record<string, unknown>;
      const displays = Array.isArray(peer.displays) ? peer.displays.map(toDisplay) : [];
      const cur = typeof peer.current_display === "number" && peer.current_display >= 0 ? peer.current_display : 0;
      const multi = versionAtLeast(typeof peer.version === "string" ? peer.version : "", MULTI_DISPLAY_VERSION);
      const next = applyEvent(stRef.current, ev).state;
      publish({ ...next, monitors: { displays, shown: [cur], multi } });
      return;
    }
    if (ev.type === "displays" && Array.isArray(ev.displays)) return onDisplays(ev.displays.map(toDisplay));
    if (ev.type === "switch_display") return onSwitchDisplay(ev);
    if (ev.type === "cursor_data") return onCursorData(ev);
    if (ev.type === "cursor_id") {
      if (typeof ev.id === "string") {
        cursorIdRef.current = ev.id;
        applyCursor();
      }
      return;
    }
    if (ev.type === "cursor_position") {
      if (typeof ev.x === "number" && typeof ev.y === "number" && optsRef.current.prefs.showRemoteCursor) {
        remotePosRef.current = [ev.x, ev.y];
        applyCursor();
      }
      return;
    }
    if (ev.type === "follow_display") {
      // 對方的游標 / 焦點視窗移到另一個螢幕（開了「跟著」才會送）：一次看一個螢幕時跟著切過去。
      const p = optsRef.current.prefs;
      const d = ev.display;
      if ((p.followRemoteCursor || p.followRemoteWindow) && typeof d === "number" && stRef.current.monitors.shown.length === 1) showDisplays([d], false);
      return;
    }
    if (ev.type === "screenshot") return onScreenshot(ev);
    if (ev.type === "clipboard" && typeof ev.text === "string") {
      if (clipboardOn()) {
        lastRemoteClipRef.current = ev.text;
        void api.rdClipboardWrite(ev.text).catch(() => undefined);
      }
      return;
    }
    if (ev.type === "msgbox") {
      // 對方的訊息框（英文原文，例如重新啟動沒有權限）。
      const text = [ev.title, ev.text].filter((x) => typeof x === "string" && x).join("：");
      if (text) (String(ev.msgtype).includes("error") ? toast.error : toast.info)(t("對方：{text}", { text }));
      return;
    }
    const { state, notice } = applyEvent(stRef.current, ev);
    if (notice === "block_on_failed") toast.error(t("對方沒有封鎖輸入（需要對方的 RustDesk 已安裝並允許封鎖輸入）"));
    if (notice === "block_off_failed") toast.error(t("對方沒有解除封鎖輸入"));
    if (state !== stRef.current) publish(state);
  };

  useImperativeHandle(ref, () => ({
    reset(connId: string) {
      void stopRecording();
      connIdRef.current = connId;
      liveRef.current = false;
      closeAll();
      keyAskRef.current.clear();
      held.clear();
      moveRef.current.sent = "";
      lastRemoteClipRef.current = null;
      lastSentClipRef.current = null;
      // 對方重連會重送游標圖；等著的截圖不會回來了。
      cursorsRef.current.clear();
      cursorPngRef.current.clear();
      cursorIdRef.current = null;
      remotePosRef.current = null;
      applyCursor();
      takeShot()?.resolve(null);
      // 聊天記錄、最近一次錄影 / 截圖跨重連保留（同一個分頁）；其他都重來。
      const prev = stRef.current;
      stRef.current = {
        ...initialState(), codecs: prev.codecs, chat: prev.chat, lastRecording: prev.lastRecording, lastScreenshot: prev.lastScreenshot,
      };
      publish(null);
    },
    output(buf: ArrayBuffer) {
      const u8 = new Uint8Array(buf);
      if (u8[0] === 1) {
        try {
          onEvent(JSON.parse(new TextDecoder().decode(u8.subarray(1))));
        } catch { /* 壞的 JSON：略過 */ }
        return;
      }
      const v = parseRustDeskVideo(buf);
      if (!v) return;
      const { shown, multi } = stRef.current.monitors;
      // 舊版對方的畫面都標 0：就是正在看的那個。
      const display = multi ? v.display : shown[0];
      if (!shown.includes(display)) return; // 換螢幕那一刻還在路上的舊畫面
      meterRef.current.bytes += v.data.byteLength;
      meterRef.current.codec = v.codec;
      const d = ensureDecoder(display, v.codec, v.key ? v.data : null);
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
      applyAll();
      // 斷線重連：套回使用者上次選的螢幕。
      const want = wantedRef.current;
      if (want) showDisplays(want, false);
      canvasRef.current?.focus();
      void syncLocalClipboard();
    },
    disconnected() {
      // 斷線：錄到的部分存起來（對方已經不在，不必通知）。
      void stopRecording();
      takeShot()?.resolve(null);
      liveRef.current = false;
      closeAll();
      held.clear();
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
      for (const k of keys) sendKey(k, true);
      for (const k of [...keys].reverse()) sendKey(k, false);
    },
    // 「把剪貼簿文字送到遠端」：整段交給對方打出來（對方的登入畫面這類不能貼上的地方也行）。
    paste(text: string) { if (text) send({ t: "type_text", text }); },
    focus() { canvasRef.current?.focus(); },
    refresh() { write({ t: "refresh" }); },
    desktopSize: () => size,
    rawKey(sc: number, down: boolean) { sendKey(sc, down); },
    showDisplays(set: number[]) {
      showDisplays(set);
      canvasRef.current?.focus();
    },
    action(name: RustDeskAction) {
      if (name === "refresh") write({ t: "refresh" });
      else if (name === "restart") write({ t: "restart" });
      else if (name === "ctrl_alt_del") {
        // 經後端的 RdCtl::Keys（跟「送出按鍵」選單同一條路；連線元件依對方系統決定怎麼送）。
        if (liveRef.current && !viewOnly) void api.rdSendKeys(connIdRef.current, "ctrl_alt_del").catch(() => undefined);
      } else if (name === "lock_screen") send({ t: "lock_screen" });
      canvasRef.current?.focus();
    },
    setBlockInput(on: boolean) {
      // 結果（成功 / 失敗）由對方的 back_notification 回來再更新狀態。
      send({ t: "toggle", name: "block_input", on });
    },
    startRecording(name: string) { return startRecordingNow(name); },
    screenshot(name: string) { return takeScreenshot(name); },
    stopRecording() { return stopRecording(); },
    async inputOsPassword(password?: string) {
      if (!liveRef.current || optsRef.current.viewOnly) return;
      await api.rdInputOsPassword(connIdRef.current, password);
    },
    sendChat(text: string) {
      const s = text.trim();
      if (!s || !liveRef.current) return;
      write({ t: "chat", text: s });
      publish(addMyChat(stRef.current, s));
    },
  }), [viewOnly, size]);

  // 原始大小 = 畫布 1:1（CSS 像素）；自訂縮放 = 照百分比；這兩種都可以捲動。
  const fit = prefs.view === "adaptive";
  const canvasStyle: React.CSSProperties | undefined = fit
    ? { width: "100%", height: "100%", objectFit: "contain" }
    : prefs.view === "custom" && size.w
      ? { width: (size.w * prefs.scale) / 100, height: (size.h * prefs.scale) / 100 }
      : undefined;
  return (
    <div className={`flex-1 min-h-0 min-w-0 bg-black relative ${fit ? "overflow-hidden" : "overflow-auto"}`} data-rd-rustdesk=""
      data-rd-view={prefs.view}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="rd-surface outline-none block"
        style={canvasStyle}
        data-rd-size={size.w ? `${size.w}x${size.h}` : undefined}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerUp={onPointer}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKey}
        onKeyUp={onKey}
        onFocus={() => void syncLocalClipboard()}
        onBlur={releaseKeys}
      />
      <img ref={overlayRef} alt="" draggable={false} className="absolute pointer-events-none select-none max-w-none"
        style={{ display: "none" }} data-rd-remote-cursor="" />
      {stats && (
        <div className="absolute top-2 left-2 px-2 py-1 rounded bg-black/85 text-white/90 text-[11px] mono leading-4 pointer-events-none select-none"
          data-rd-stats="">
          <div>{t("畫面 {fps} FPS · {kbps} KB/s", { fps: stats.fps, kbps: stats.kbps })}</div>
          <div>{t("延遲 {ms}", { ms: stats.delay == null ? "—" : `${stats.delay} ms` })}</div>
          <div>{[stats.codec, stats.width ? `${stats.width}×${stats.height}` : ""].filter(Boolean).join(" · ")}</div>
        </div>
      )}
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-fg/70 p-6 text-center">
          {t("這個環境的瀏覽器元件不支援 {what}，無法顯示 RustDesk 畫面。", { what: unsupported })}
        </div>
      )}
    </div>
  );
});

export default RustDeskView;
