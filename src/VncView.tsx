// VNC 畫面：noVNC（@novnc/novnc，MPL-2.0）跑在 webview 裡，底層不是 WebSocket 而是 VncChannel——
// 位元組經 Tauri 的 `rd_write` / Channel 跟後端互通。認證（含 macOS 螢幕共享的 ARD）後端已經做完，
// noVNC 看到的是一台「不需密碼」的伺服器，所以密碼從頭到尾不進 JS。
// noVNC 自己處理解碼、鍵盤（keysym）、剪貼簿、縮放；這裡只接生命週期與工具列動作。
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type RFBType from "@novnc/novnc";
import { api } from "./api";
import type { RdConnInfo, RdResizeMode } from "./rdTypes";
import { VncChannel } from "./vncChannel";
import type { RdViewHandle } from "./rdView";

export interface VncViewProps {
  resizeMode: RdResizeMode;
  viewOnly: boolean;
  shared: boolean;
  clipboard: boolean;
  onDesktopName?: (name: string) => void;
}

// noVNC 第一次打開 VNC 分頁才下載（manualChunks 另切 novnc 一包）。
let rfbModule: Promise<typeof import("@novnc/novnc")> | null = null;
const loadRfb = () => (rfbModule ??= import("@novnc/novnc"));

// X11 keysym（noVNC 的 sendKey 吃這個）。
const XK = { Control_L: 0xffe3, Alt_L: 0xffe9, Super_L: 0xffeb, Tab: 0xff09, Escape: 0xff1b, Print: 0xff61 };
// 後端鍵盤 hook 攔到的系統鍵（set-1 掃描碼）→ [keysym, KeyboardEvent.code]。只列 hook 會攔的那幾個。
const GRAB_KEYSYM: Record<number, [number, string]> = {
  0xe05b: [0xffeb, "MetaLeft"], 0xe05c: [0xffec, "MetaRight"], 0xe05d: [0xff67, "ContextMenu"],
  0x0f: [0xff09, "Tab"], 0x01: [0xff1b, "Escape"], 0x3e: [0xffc1, "F4"], 0x39: [0x0020, "Space"],
};

const VncView = forwardRef<RdViewHandle, VncViewProps>(function VncView(
  { resizeMode, viewOnly, shared, clipboard, onDesktopName },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chRef = useRef<VncChannel | null>(null);
  const rfbRef = useRef<RFBType | null>(null);
  const propsRef = useRef({ resizeMode, viewOnly, shared, clipboard, onDesktopName });
  propsRef.current = { resizeMode, viewOnly, shared, clipboard, onDesktopName };
  // 剪貼簿來回：記住最後從遠端拿到的與最後送出的，同一段文字不在兩邊來回彈。
  const lastRemoteRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);

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
    rfb.scaleViewport = p.resizeMode === "scale";
    rfb.resizeSession = p.resizeMode === "remote";
    rfb.clipViewport = p.resizeMode === "none";
    rfb.dragViewport = false;
    rfb.background = "#000";
    rfb.focusOnClick = true;
  };
  useEffect(() => { if (rfbRef.current) apply(rfbRef.current); }, [resizeMode, viewOnly]);

  const teardown = () => {
    const rfb = rfbRef.current;
    rfbRef.current = null;
    try { rfb?.disconnect(); } catch { /* 已斷 */ }
    chRef.current?.markClosed();
    chRef.current = null;
    // noVNC 把 <canvas> 掛在 target 底下；換連線時清乾淨。
    if (hostRef.current) hostRef.current.replaceChildren();
  };
  useEffect(() => teardown, []);

  const key = (sym: number, code: string, down: boolean) => rfbRef.current?.sendKey(sym, code, down);

  useImperativeHandle(ref, () => ({
    reset(connId: string) {
      teardown();
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
          if (name) propsRef.current.onDesktopName?.(name);
        });
        rfbRef.current = rfb;
        ch.markOpen();
        rfb.focus();
      });
    },
    disconnected() {
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
      rfbRef.current?.clipboardPasteFrom(text);
    },
    focus() {
      rfbRef.current?.focus();
    },
    refresh() { /* noVNC 自己會要增量更新 */ },
    desktopSize() {
      const c = hostRef.current?.querySelector("canvas");
      return { w: c?.width ?? 0, h: c?.height ?? 0 };
    },
    rawKey(sc: number, down: boolean) {
      const k = GRAB_KEYSYM[sc];
      if (k && !propsRef.current.viewOnly) key(k[0], k[1], down);
    },
  }), []);

  return <div ref={hostRef} className="rd-surface flex-1 min-h-0 min-w-0 bg-black overflow-hidden" data-rd-vnc=""
    onFocusCapture={() => void syncLocalClipboard()} />;
});

export default VncView;
