// 通用 xterm 視圖（Docker log / exec 用）：建終端、載 addon、跟主題 / 字級 / SSH 偏好走，
// 容器尺寸變動自動 fit。資料怎麼來、輸入送去哪，由呼叫端透過 onReady / onData / onResize 決定。
//
// SSH 終端（SshTerminalPane）有大量 SSH 專屬的接線（host key / 認證提問、OSC 7、錄製…）仍各自維護；
// 這裡只放兩邊共通的 xterm 骨架設定（字型、CJK 寬字、WebGL 退回 DOM、保留鍵放行）。
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import { writeClipboardText } from "../clipboard";
import { useSshPrefs } from "../sshPrefs";
import { xtermThemeFor } from "../sshTerminalTheme";
import { useTheme } from "../theme";
import { EDITOR_THEMES, getEditorThemeDef } from "../editorThemes";
import { b64ToBytes, binaryToB64, utf8ToB64 } from "../sshBytes";
import { isAppReserved } from "./keyScope";
import { useModalView } from "./modalChrome";

const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, "Noto Sans Mono CJK TC", "Microsoft JhengHei", monospace';

export interface XtermHandle {
  term: Terminal;
  search: SearchAddon;
  fit: () => void;
}

/** Channel 的訊息在正式 Tauri 下是 ArrayBuffer；假後端（verify-ui shim）可能給 Uint8Array、陣列或 base64 字串。 */
export function channelBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (typeof v === "string") return b64ToBytes(v);
  return new Uint8Array(0);
}

export interface XtermViewProps {
  /** 終端建好後呼叫一次；可回傳清理函式（卸載時執行）。 */
  onReady: (h: XtermHandle) => void | (() => void);
  /** 互動輸入（已轉 base64，可直接送後端）。唯讀視圖不給。 */
  onData?: (b64: string) => void;
  onResize?: (cols: number, rows: number) => void;
  /** 唯讀（log）：關閉輸入、`\n` 自動換成 `\r\n`。 */
  readOnly?: boolean;
  /** 在可見時自動取得焦點。 */
  autoFocus?: boolean;
  className?: string;
}

export default function XtermView({ onReady, onData, onResize, readOnly = false, autoFocus = false, className = "" }: XtermViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const themeId = useTheme((s) => s.themeId);
  const { codeFontSize } = useModalView();
  // 回呼存 ref：父元件每次 render 給新的函式也不必重建終端。
  const cb = useRef({ onReady, onData, onResize });
  cb.current = { onReady, onData, onResize };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const p = useSshPrefs.getState();
    const term = new Terminal({
      allowProposedApi: true,
      scrollback: readOnly ? Math.max(p.scrollback, 10000) : p.scrollback,
      cursorBlink: !readOnly && p.cursorBlink,
      cursorStyle: readOnly ? "underline" : "block",
      cursorInactiveStyle: "none",
      disableStdin: readOnly,
      convertEol: readOnly,
      fontFamily: MONO,
      fontSize: codeFontSize,
      theme: xtermThemeFor(getEditorThemeDef(themeId) ?? EDITOR_THEMES[0]),
      allowTransparency: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11"; // CJK 寬字必載，否則中文錯位
    term.loadAddon(new WebLinksAddon((_e, uri) => { void api.openExternal(uri).catch(() => undefined); }));
    term.open(host);
    if (p.renderer !== "dom") {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch { /* DOM renderer */ }
    }
    try { fit.fit(); } catch { /* 隱藏中量不到尺寸 */ }
    term.onData((d) => cb.current.onData?.(utf8ToB64(d)));
    term.onBinary((d) => cb.current.onData?.(binaryToB64(d)));
    term.onResize(({ cols, rows }) => cb.current.onResize?.(cols, rows));
    term.onSelectionChange(() => {
      if (useSshPrefs.getState().copyOnSelect && term.hasSelection()) {
        void writeClipboardText(term.getSelection()).catch(() => undefined);
      }
    });
    // app 保留鍵（切分頁 / 縮放 / 搜尋…）不進容器 shell，讓它照常冒泡給 window。
    term.attachCustomKeyEventHandler((ev) => !(ev.type === "keydown" && isAppReserved(ev)));
    termRef.current = term;
    fitRef.current = fit;
    const cleanup = cb.current.onReady({ term, search, fit: () => { try { fit.fit(); } catch { /* 隱藏中 */ } } });
    if (autoFocus) term.focus();
    return () => {
      if (typeof cleanup === "function") cleanup();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 只在掛載時建一次；主題 / 字級各有 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermThemeFor(getEditorThemeDef(themeId) ?? EDITOR_THEMES[0]);
  }, [themeId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = codeFontSize;
    try { fitRef.current?.fit(); } catch { /* 隱藏中 */ }
  }, [codeFontSize]);

  // 容器尺寸變動 → fit（80ms 去抖；隱藏中量到 0 尺寸時不動）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { try { fitRef.current?.fit(); } catch { /* 隱藏中 */ } }, 80);
    });
    ro.observe(host);
    return () => { ro.disconnect(); window.clearTimeout(timer); };
  }, []);

  return <div ref={hostRef} className={`min-h-0 min-w-0 overflow-hidden ${className}`} data-xterm-view />;
}
