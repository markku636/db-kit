// VNC 畫面：noVNC（@novnc/novnc，MPL-2.0）跑在 webview 裡，底層不是 WebSocket 而是 VncChannel——
// 位元組經 Tauri 的 `rd_write` / Channel 跟後端互通。認證（含 macOS 螢幕共享的 ARD）後端已經做完，
// noVNC 看到的是一台「不需密碼」的伺服器，所以密碼從頭到尾不進 JS。
// noVNC 自己處理解碼、鍵盤（keysym）、剪貼簿、縮放；這裡接生命週期與工具列（VncToolbar）的動作：
// 畫質、游標點、截圖、錄影、重新整理、電源（XVP）、虛擬鍵盤 / 系統鍵（rawKey）、把剪貼簿文字逐字打過去。
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type RFBType from "@novnc/novnc";
import { api } from "./api";
import { useT } from "./i18n";
import { toast } from "./ui";
import type { RdConnInfo, RdResizeMode } from "./rdTypes";
import { VncChannel } from "./vncChannel";
import type { RdViewHandle } from "./rdView";
import { startRecording as beginRecording, type RdRecording } from "./rdRecorder";
import { CAPS_SCANCODE, isShiftScancode, keysymsForText, vncKeyForScancode, XK } from "./vncKeys";
import { VNC_QUALITY_LEVELS, type VncQuality } from "./vncPrefs";

/** 工具列要的連線狀態。 */
export interface VncState {
  /** 伺服器支援 XVP 電源操作（關機 / 重新開機 / 重設）。 */
  power: boolean;
  /** 伺服器報的桌面名稱（ServerInit）。 */
  desktopName: string;
  recording: boolean;
  /** 這個分頁最近一次的錄影 / 截圖檔（「開啟資料夾」用）。 */
  lastRecording: string | null;
  lastShot: string | null;
}

const INITIAL: VncState = { power: false, desktopName: "", recording: false, lastRecording: null, lastShot: null };

export interface VncViewProps {
  resizeMode: RdResizeMode;
  viewOnly: boolean;
  shared: boolean;
  clipboard: boolean;
  quality: VncQuality;
  dotCursor: boolean;
  onState?: (s: VncState) => void;
}

// noVNC 第一次打開 VNC 分頁才下載（manualChunks 另切 novnc 一包）。
type RfbModule = typeof import("@novnc/novnc");
let rfbModule: Promise<RfbModule> | null = null;
const loadRfb = () => (rfbModule ??= import("@novnc/novnc"));

/** noVNC 沒有公開「整張重送」；用它自己的 FramebufferUpdateRequest 編碼器送一個非增量的請求（noVNC 1.7 的內部欄位）。 */
interface RfbInternals {
  _sock?: unknown;
  _fbWidth?: number;
  _fbHeight?: number;
  _rfbConnectionState?: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e));

const VncView = forwardRef<RdViewHandle, VncViewProps>(function VncView(
  { resizeMode, viewOnly, shared, clipboard, quality, dotCursor, onState },
  ref,
) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const chRef = useRef<VncChannel | null>(null);
  const rfbRef = useRef<RFBType | null>(null);
  const rfbClassRef = useRef<RfbModule["default"] | null>(null);
  const propsRef = useRef({ resizeMode, viewOnly, shared, clipboard, quality, dotCursor, onState });
  propsRef.current = { resizeMode, viewOnly, shared, clipboard, quality, dotCursor, onState };
  // 剪貼簿來回：記住最後從遠端拿到的與最後送出的，同一段文字不在兩邊來回彈。
  const lastRemoteRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);
  // rawKey（虛擬鍵盤 / 系統鍵攔截）：按著的 Shift、CapsLock 開關、每顆按下的鍵送了哪個 keysym（放開送同一個）。
  const keysRef = useRef({ shift: new Set<number>(), caps: false, down: new Map<number, [number, string]>() });

  const stRef = useRef<VncState>(INITIAL);
  const publish = (s: VncState) => {
    stRef.current = s;
    propsRef.current.onState?.(s);
  };

  useEffect(() => { void loadRfb(); }, []);

  // 畫面取得焦點：把本機剪貼簿的新文字交給遠端（後端讀，免得 webview 跳權限詢問搶走焦點）。
  const syncLocalClipboard = async () => {
    const rfb = rfbRef.current;
    if (!rfb || !propsRef.current.clipboard || propsRef.current.viewOnly) return;
    try {
      const text = await api.rdClipboardRead();
      if (!text || text === lastRemoteRef.current || text === lastSentRef.current) return;
      lastSentRef.current = text;
      rfb.clipboardPasteFrom(text);
    } catch { /* 讀不到剪貼簿：略過 */ }
  };

  const apply = (rfb: RFBType) => {
    const p = propsRef.current;
    rfb.viewOnly = p.viewOnly;
    // 「遠端跟著調整解析度」也開縮放：伺服器不支援改解析度（或改不到剛好的大小）時，至少整張看得到。
    rfb.scaleViewport = p.resizeMode === "scale" || p.resizeMode === "remote";
    rfb.resizeSession = p.resizeMode === "remote";
    rfb.clipViewport = p.resizeMode === "none";
    rfb.dragViewport = false;
    rfb.background = "#000";
    rfb.focusOnClick = true;
    rfb.showDotCursor = p.dotCursor;
    const [q, c] = VNC_QUALITY_LEVELS[p.quality];
    rfb.qualityLevel = q;
    rfb.compressionLevel = c;
  };
  useEffect(() => { if (rfbRef.current) apply(rfbRef.current); }, [resizeMode, viewOnly, quality, dotCursor]);

  // ---- 錄影（錄 noVNC 的畫布，跟 RustDesk 分頁同一套：rdRecorder → 錄影資料夾） ----
  const recRef = useRef<RdRecording | null>(null);
  const stopRecording = async () => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    publish({ ...stRef.current, recording: false });
    try {
      const path = await r.stop();
      if (path) {
        publish({ ...stRef.current, lastRecording: path });
        toast.success(t("錄影已存到 {path}", { path }));
      }
    } catch (e) {
      toast.error(t("錄影存檔失敗：{e}", { e: errText(e) }));
    }
  };
  const startRecordingNow = async (name: string) => {
    const c = hostRef.current?.querySelector("canvas");
    if (recRef.current || !c || !rfbRef.current) return;
    try {
      recRef.current = await beginRecording(c, name, (e) => {
        toast.error(t("錄影寫入失敗，已停止：{e}", { e: errText(e) }));
        void stopRecording();
      });
    } catch (e) {
      const msg = e instanceof Error && e.message === "MediaRecorder" ? t("這個環境的瀏覽器元件不支援錄影") : errText(e);
      toast.error(t("無法開始錄影：{e}", { e: msg }));
      return;
    }
    publish({ ...stRef.current, recording: true });
  };

  const teardown = () => {
    void stopRecording();
    const rfb = rfbRef.current;
    rfbRef.current = null;
    try { rfb?.disconnect(); } catch { /* 已斷 */ }
    chRef.current?.markClosed();
    chRef.current = null;
    keysRef.current = { shift: new Set(), caps: false, down: new Map() };
    // noVNC 把 <canvas> 掛在 target 底下；換連線時清乾淨。
    if (hostRef.current) hostRef.current.replaceChildren();
  };
  useEffect(() => teardown, []); // eslint-disable-line react-hooks/exhaustive-deps

  const key = (sym: number, code: string | null, down: boolean) => rfbRef.current?.sendKey(sym, code, down);

  useImperativeHandle(ref, () => ({
    reset(connId: string) {
      teardown();
      publish({ ...INITIAL, lastRecording: stRef.current.lastRecording, lastShot: stRef.current.lastShot });
      chRef.current = new VncChannel({
        write: (bytes) => api.rdWrite(connId, bytes),
        close: () => api.rdDisconnect(connId),
      });
    },
    output(buf: ArrayBuffer) {
      chRef.current?.deliver(buf);
    },
    connected(_info: RdConnInfo) {
      const ch = chRef.current;
      const host = hostRef.current;
      if (!ch || !host) return;
      void loadRfb().then(({ default: RFB }) => {
        if (chRef.current !== ch) return; // 已被下一次連線取代
        rfbClassRef.current = RFB;
        const rfb = new RFB(host, ch, { shared: propsRef.current.shared });
        apply(rfb);
        rfb.addEventListener("clipboard", (e) => {
          const text = (e as CustomEvent<{ text: string }>).detail?.text;
          if (propsRef.current.clipboard && text) {
            lastRemoteRef.current = text;
            void api.rdClipboardWrite(text).catch(() => undefined);
          }
        });
        rfb.addEventListener("desktopname", (e) => {
          const name = (e as CustomEvent<{ name: string }>).detail?.name;
          if (name) publish({ ...stRef.current, desktopName: name });
        });
        rfb.addEventListener("capabilities", () => {
          publish({ ...stRef.current, power: !!rfb.capabilities?.power });
        });
        rfbRef.current = rfb;
        ch.markOpen();
        rfb.focus();
      });
    },
    disconnected() {
      void stopRecording();
      chRef.current?.markClosed();
    },
    combo(name: string) {
      const rfb = rfbRef.current;
      if (!rfb || propsRef.current.viewOnly) return;
      switch (name) {
        case "ctrl_alt_del": rfb.sendCtrlAltDel(); break;
        case "win": key(XK.Super_L, "MetaLeft", true); key(XK.Super_L, "MetaLeft", false); break;
        case "alt_tab":
          key(XK.Alt_L, "AltLeft", true); key(XK.Tab, "Tab", true); key(XK.Tab, "Tab", false); key(XK.Alt_L, "AltLeft", false);
          break;
        case "ctrl_esc":
          key(XK.Control_L, "ControlLeft", true); key(XK.Escape, "Escape", true);
          key(XK.Escape, "Escape", false); key(XK.Control_L, "ControlLeft", false);
          break;
        case "print_screen": key(XK.Print, "PrintScreen", true); key(XK.Print, "PrintScreen", false); break;
      }
    },
    paste(text: string) {
      // 逐字打過去（跟 RDP 一樣；遠端的密碼欄 / 登入畫面不讓貼上時用）。不帶 code：照字送 keysym，不走 QEMU 的鍵位事件；
      // 要 Shift 的字包一層 Shift（見 keysymsForText）。
      if (!rfbRef.current || propsRef.current.viewOnly) return;
      for (const [sym, shift] of keysymsForText(text)) {
        if (shift) key(XK.Shift_L, null, true);
        key(sym, null, true);
        key(sym, null, false);
        if (shift) key(XK.Shift_L, null, false);
      }
    },
    focus() {
      rfbRef.current?.focus();
    },
    refresh() {
      const r = rfbRef.current as unknown as RfbInternals | null;
      const RFB = rfbClassRef.current;
      if (!r || !RFB || !r._sock || !r._fbWidth || !r._fbHeight || r._rfbConnectionState !== "connected") return;
      RFB.messages.fbUpdateRequest(r._sock, false, 0, 0, r._fbWidth, r._fbHeight);
    },
    desktopSize() {
      const c = hostRef.current?.querySelector("canvas");
      return { w: c?.width ?? 0, h: c?.height ?? 0 };
    },
    rawKey(sc: number, down: boolean) {
      if (!rfbRef.current || propsRef.current.viewOnly) return;
      const k = keysRef.current;
      if (isShiftScancode(sc)) {
        if (down) k.shift.add(sc);
        else k.shift.delete(sc);
      }
      if (sc === CAPS_SCANCODE && down) k.caps = !k.caps;
      // 放開時送按下那時的 keysym（中間 Shift 放掉了也一樣），伺服器才不會以為有鍵一直按著。
      const m = (!down && k.down.get(sc)) || vncKeyForScancode(sc, k.shift.size > 0, k.caps);
      if (!m) return;
      if (down) k.down.set(sc, m);
      else k.down.delete(sc);
      key(m[0], m[1], down);
    },
    startRecording(name: string) { return startRecordingNow(name); },
    stopRecording() { return stopRecording(); },
    async screenshot(name: string) {
      const rfb = rfbRef.current;
      if (!rfb) return null;
      const blob = await new Promise<Blob | null>((resolve) => rfb.toBlob(resolve, "image/png"));
      if (!blob) return null;
      const path = await api.rdScreenshotSave(name, new Uint8Array(await blob.arrayBuffer()));
      publish({ ...stRef.current, lastShot: path });
      return path;
    },
    power(op: "shutdown" | "reboot" | "reset") {
      const rfb = rfbRef.current;
      if (!rfb || propsRef.current.viewOnly) return;
      if (op === "shutdown") rfb.machineShutdown();
      else if (op === "reboot") rfb.machineReboot();
      else rfb.machineReset();
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="rd-surface flex-1 min-h-0 min-w-0 bg-black overflow-hidden" data-rd-vnc=""
    onFocusCapture={() => void syncLocalClipboard()} />;
});

export default VncView;
