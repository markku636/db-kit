// SSH 終端機分頁：xterm.js 前端 + 後端 russh PTY（見 src-tauri/src/ssh/terminal.rs）。
//
// 生命週期：掛載即連線（分頁是使用者主動開的），輸出走 Tauri Channel（raw bytes，每終端一條），
// 輸入走 ssh_term_write。分頁切走時不卸載（MainArea 常駐所有 SSH pane、只切 display），
// 所以 buffer 與 shell 都留著；真正關閉分頁才 teardown。
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronDown, ChevronUp, Eraser, PanelRightClose, PanelRightOpen, RefreshCw, Search, Sparkles, X,
} from "lucide-react";
import { api, onSshAuthPrompt, onSshConnClosed, onSshHostKeyPrompt, onSshTermExit } from "./api";
import type { SshTab } from "./sshTabs";
import type { SshAuthPrompt, SshHostKeyPrompt, SshStatus } from "./sshTypes";
import { DEFAULT_RUNTIME, sshTail, teardownSshTab, termRegistry, useSshTerminals } from "./sshTerminals";
import { useSshPrefs } from "./sshPrefs";
import { useSshSessions } from "./sshSessions";
import { xtermThemeFor } from "./sshTerminalTheme";
import { guessOs, guessShell } from "./sshCapture";
import { b64ToBytes, binaryToB64, utf8ToB64 } from "./sshBytes";
import { isAppReserved } from "./ui/keyScope";
import { SshAuthPromptDialog, SshHostKeyDialog } from "./SshPrompts";
import SshComposeBar from "./SshComposeBar";
import { useTheme } from "./theme";
import { EDITOR_THEMES, getEditorThemeDef } from "./editorThemes";
import { t, useT } from "./i18n";
import { Button, Icon, IconButton, MenuPanel, Spinner, useModalView } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import { Splitter, useResizableReverse } from "./ui/resizable";
import { useStore } from "./store";
import { useAssistant } from "./assistant";
import { explainOutputAsk, fixLastErrorAsk, summarizeSessionAsk } from "./sshAiPrompts";
import type { TerminalSnapshot } from "./chatTypes";

const SftpPanel = lazy(() => import("./SftpPanel"));
const NlShellBar = lazy(() => import("./NlShellBar"));

const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, "Noto Sans Mono CJK TC", "Microsoft JhengHei", monospace';

/** Channel 的訊息在正式 Tauri 下是 ArrayBuffer；假後端（verify-ui shim）可能給 Uint8Array 或 base64 字串。 */
function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (typeof v === "string") return b64ToBytes(v);
  return new Uint8Array(0);
}

/** 未知的主題 id（舊存檔）退回第一個內建主題，xterm 永遠拿得到一份完整配色。 */
function themeDef(id: string) {
  return getEditorThemeDef(id) ?? EDITOR_THEMES[0];
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
function errCode(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return null;
}

export default function SshTerminalPane({ tab, active }: { tab: SshTab; active: boolean }) {
  const t = useT();
  const rt = useSshTerminals((s) => s.rt[tab.key]);
  const patch = useSshTerminals((s) => s.patch);
  const themeId = useTheme((s) => s.themeId);
  const { codeFontSize } = useModalView();
  // 主機設定的「字級覆寫」（options.ui.font_size）優先；沒設就跟 app 的程式碼字級（Ctrl+= / − / 0 可調）。
  const fontOverride = useSshSessions((s) => {
    const n = Number(s.sessions.find((x) => x.id === tab.sessionId)?.options.ui?.font_size);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const fontSize = fontOverride ?? codeFontSize;
  const prefs = useSshPrefs();
  const closeSshTab = useStore((s) => s.closeSshTab);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const termIdRef = useRef<string | null>(null);
  const connIdRef = useRef<string>("");
  const statusRef = useRef<SshStatus>("connecting");
  const activeRef = useRef(active);
  activeRef.current = active;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const tapsRef = useRef(new Set<(b: Uint8Array) => void>());
  const unlistenRef = useRef<(() => void)[]>([]);

  const [authPrompt, setAuthPrompt] = useState<SshAuthPrompt | null>(null);
  const [hostKey, setHostKey] = useState<SshHostKeyPrompt | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [aiMenu, setAiMenu] = useState<{ x: number; y: number } | null>(null);
  const [nlOpen, setNlOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const sftp = useResizableReverse({ storageKey: "dbkit:sshSftpWidth", initial: 380, min: 280, max: () => Math.max(320, window.innerWidth * 0.6), axis: "x" });

  const setStatus = (status: SshStatus, extra: Partial<Parameters<typeof patch>[1]> = {}) => {
    statusRef.current = status;
    patch(tab.key, { status, ...extra });
  };
  const dropListeners = () => {
    for (const un of unlistenRef.current) { try { un(); } catch { /* 已卸載 */ } }
    unlistenRef.current = [];
  };

  // ---- 連線 / 重連 / 結束 ----
  const onEnded = (connId: string, reason: string) => {
    if (connIdRef.current !== connId) return;
    termIdRef.current = null;
    setStatus("disconnected", { termId: null, error: reason });
    termRef.current?.write(`\r\n\x1b[90m── ${reason} ──\x1b[0m\r\n`);
  };

  const connect = async () => {
    const term = termRef.current;
    if (!term) return;
    const connId = crypto.randomUUID();
    connIdRef.current = connId;
    termIdRef.current = null;
    setStatus("connecting", { connId, termId: null, sftpId: null, error: null });
    // 提問事件要在 invoke 之前就掛上：host key 對話框可能在 sshConnect 回來前就需要回答。
    const unHost = await onSshHostKeyPrompt(connId, setHostKey);
    const unAuth = await onSshAuthPrompt(connId, setAuthPrompt);
    try {
      const info = await api.sshConnect(connId, tab.target);
      // 已被取消 / 卸載：TCP 撥號階段按取消時後端還沒有東西可斷，連線可能照樣完成 —— 這裡補斷，不留孤兒連線。
      if (connIdRef.current !== connId) { void api.sshDisconnect(connId).catch(() => undefined); return; }
      const ch = new Channel<ArrayBuffer>();
      ch.onmessage = (buf) => {
        const u8 = toBytes(buf);
        term.write(u8);
        for (const f of tapsRef.current) f(u8);
      };
      const termId = await api.sshTermOpen(connId, term.cols, term.rows, ch);
      if (connIdRef.current !== connId) { void api.sshTermClose(termId).catch(() => undefined); return; }
      termIdRef.current = termId;
      const unExit = await onSshTermExit(termId, (e) => {
        const reason = e.status != null
          ? t("shell 已結束（代碼 {code}）", { code: e.status })
          : e.signal ? t("shell 被信號 {sig} 終止", { sig: e.signal }) : t("shell 已結束");
        onEnded(connId, reason);
      });
      const unClosed = await onSshConnClosed(connId, (e) => onEnded(connId, e.reason || t("連線已中斷")));
      unlistenRef.current.push(unExit, unClosed);
      setStatus("connected", { termId, host: info.host, user: info.username, title: null, error: null });
      if (activeRef.current) term.focus();
    } catch (e) {
      if (connIdRef.current !== connId) return;
      if (errCode(e) === "ERR_SSH_CANCELLED") {
        setStatus("disconnected", { error: null });
        term.write(`\r\n\x1b[90m── ${t("已取消連線")} ──\x1b[0m\r\n`);
      } else {
        const msg = errMsg(e);
        setStatus("error", { error: msg });
        term.write(`\r\n\x1b[31m✗ ${msg}\x1b[0m\r\n`);
      }
    } finally {
      unHost();
      unAuth();
      setAuthPrompt(null);
      setHostKey(null);
    }
  };

  const reconnect = () => {
    if (statusRef.current === "connecting") return;
    dropListeners();
    const old = connIdRef.current;
    if (old) void api.sshDisconnect(old).catch(() => undefined);
    termRef.current?.write(`\r\n\x1b[90m── ${t("重新連線")} ──\x1b[0m\r\n`);
    void connect();
  };

  const cancelConnect = () => {
    const id = connIdRef.current;
    if (!id) return;
    // 先讓 connect() 認不得這次連線（撥號完成後它會自己補斷），再請後端丟掉待答提示。
    connIdRef.current = "";
    setStatus("disconnected", { error: null });
    termRef.current?.write(`\r\n\x1b[90m── ${t("已取消連線")} ──\x1b[0m\r\n`);
    void api.sshDisconnect(id).catch(() => undefined);
  };

  // ---- 掛載：建 xterm、接後端、登錄；卸載：釋放一切 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const p = prefsRef.current;
    const term = new Terminal({
      allowProposedApi: true,
      scrollback: p.scrollback,
      cursorBlink: p.cursorBlink,
      cursorStyle: "block",
      fontFamily: MONO,
      fontSize,
      theme: xtermThemeFor(themeDef(themeId)),
      macOptionIsMeta: true,
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
      // WebGL 在 RDP / VM 可能沒有 GPU：載入失敗或中途 context lost 都退回 DOM renderer。
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch { /* DOM renderer */ }
    }
    fit.fit();

    term.onData((d) => { const id = termIdRef.current; if (id) void api.sshTermWrite(id, utf8ToB64(d)).catch(() => undefined); });
    term.onBinary((d) => { const id = termIdRef.current; if (id) void api.sshTermWrite(id, binaryToB64(d)).catch(() => undefined); });
    term.onResize(({ cols, rows }) => { const id = termIdRef.current; if (id) void api.sshTermResize(id, cols, rows).catch(() => undefined); });
    term.onTitleChange((title) => patch(tab.key, { title }));
    // OSC 7（file://host/path）：bash / zsh 常見設定會在每次提示符回報 cwd。
    term.parser.registerOscHandler(7, (data) => {
      try { patch(tab.key, { cwd: decodeURIComponent(new URL(data).pathname) }); } catch { /* 非 URL 格式就略過 */ }
      return true;
    });
    term.onSelectionChange(() => {
      if (prefsRef.current.copyOnSelect && term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
    });
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // app 保留鍵（切分頁 / 新終端 / 縮放 / 搜尋 / 複製貼上）不進 shell，讓它照常冒泡給 window。
      if (isAppReserved(ev)) return false;
      // 斷線後按 Enter 直接重連（Xshell 慣例）。
      if (statusRef.current !== "connected" && statusRef.current !== "connecting" && ev.key === "Enter") { reconnect(); return false; }
      return true;
    });
    // Ctrl+V / 瀏覽器選單貼上走的是原生 paste 事件，xterm 在內層 textarea 自己接走——不攔的話，
    // 多行內容每一行都會被當成 Enter 直接執行，繞過「多行貼上先確認」。在容器的 capture 階段先攔下，
    // 確認後再交給 term.paste（它會照 shell 的要求包 bracketed paste）。單行照舊不打擾。
    const onNativePaste = (ev: ClipboardEvent) => {
      const text = ev.clipboardData?.getData("text/plain") ?? "";
      if (!prefsRef.current.warnMultilinePaste || multilineCount(text) <= 1) return;
      ev.preventDefault();
      ev.stopPropagation();
      void confirmMultilinePaste(text).then((ok) => {
        if (!ok) return;
        term.paste(text);
        term.focus();
      });
    };
    host.addEventListener("paste", onNativePaste, true);

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    termRegistry.set(tab.key, {
      term,
      sendLine: async (line) => {
        const id = termIdRef.current;
        if (!id || statusRef.current !== "connected") throw new Error(t("終端機尚未連線"));
        await api.sshTermSendLine(id, line);
      },
      tapData: (fn) => { tapsRef.current.add(fn); return () => { tapsRef.current.delete(fn); }; },
      focus: () => term.focus(),
      reconnect,
    });
    useSshTerminals.setState((s) => ({ rt: { ...s.rt, [tab.key]: { ...DEFAULT_RUNTIME, connId: "", host: "", user: "" } } }));
    void connect();

    return () => {
      host.removeEventListener("paste", onNativePaste, true);
      dropListeners();
      void teardownSshTab(tab.key);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // 只在掛載時跑一次：主題 / 字級 / 偏好的後續變動各有自己的 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 容器尺寸變動 → fit（80ms 去抖；隱藏中量到 0 尺寸時不動，等顯示那一刻再 fit）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fitRef.current?.fit(), 80);
    });
    ro.observe(host);
    return () => { ro.disconnect(); window.clearTimeout(timer); };
  }, []);

  // 切成作用中：display 從 none 變回來，下一幀才量得到尺寸。
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => { fitRef.current?.fit(); termRef.current?.focus(); });
    return () => cancelAnimationFrame(id);
  }, [active]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermThemeFor(themeDef(themeId));
  }, [themeId]);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    if (activeRef.current) fitRef.current?.fit();
  }, [fontSize]);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.scrollback = prefs.scrollback;
    term.options.cursorBlink = prefs.cursorBlink;
  }, [prefs.scrollback, prefs.cursorBlink]);

  // ---- 發佈終端機快照給 AI 助手（作用中分頁：狀態變動即時、輸出 750ms 去抖）----
  const status = rt?.status ?? "connecting";
  const hasRt = !!rt;
  useEffect(() => {
    if (!active || !hasRt) return;
    const publish = () => {
      const cur = useSshTerminals.getState().rt[tab.key];
      if (!cur) return;
      const tail = sshTail(tab.key, 200);
      const snap: TerminalSnapshot = {
        tabKey: tab.key,
        termId: cur.termId,
        title: tab.title,
        host: cur.host,
        user: cur.user,
        connId: tab.connId ?? null,
        status: cur.status,
        os: guessOs(tail),
        shell: guessShell(tail),
        cwd: cur.cwd,
        lastCommand: cur.lastCommand,
        lastOutput: cur.lastOutput,
        tail,
        updatedAt: Date.now(),
      };
      useAssistant.getState().publishTerminal(snap);
    };
    publish();
    let timer: number | undefined;
    const tap = () => { window.clearTimeout(timer); timer = window.setTimeout(publish, 750); };
    const taps = tapsRef.current;
    taps.add(tap);
    return () => { taps.delete(tap); window.clearTimeout(timer); };
    // 刻意不依賴整個 rt：OSC 標題每個提示符都會變，那不影響快照內容，卻會讓監聽整組重掛。
  }, [active, hasRt, tab.key, tab.title, tab.connId, rt?.status, rt?.cwd, rt?.lastCommand, rt?.lastOutput, rt?.termId]);

  // ---- 剪貼簿 ----
  const copySelection = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
    term.clearSelection();
  };
  const pasteFromClipboard = async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { toast.error(t("無法讀取剪貼簿")); return; }
    if (!text) return;
    if (multilineCount(text) > 1 && prefsRef.current.warnMultilinePaste && !(await confirmMultilinePaste(text))) return;
    termRef.current?.paste(text);
    termRef.current?.focus();
  };

  const onKeyDownCapture = (e: ReactKeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "c") { e.preventDefault(); e.stopPropagation(); copySelection(); }
    else if (k === "v") { e.preventDefault(); e.stopPropagation(); void pasteFromClipboard(); }
    else if (k === "f") { e.preventDefault(); e.stopPropagation(); setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); }
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    if (e.shiftKey) { setCtxMenu({ x: e.clientX, y: e.clientY }); return; }
    if (term.hasSelection()) { copySelection(); return; }
    if (prefsRef.current.rightClickPaste) void pasteFromClipboard();
    else setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  // ---- 搜尋 ----
  const findNext = () => { if (searchQ) searchRef.current?.findNext(searchQ, { incremental: false }); };
  const findPrev = () => { if (searchQ) searchRef.current?.findPrevious(searchQ); };
  const closeSearch = () => { setSearchOpen(false); searchRef.current?.clearDecorations(); termRef.current?.focus(); };

  // ---- AI 快速動作 ----
  const snapshotNow = (): TerminalSnapshot | null => {
    const cur = useSshTerminals.getState().rt[tab.key];
    if (!cur) return null;
    const tail = sshTail(tab.key, 200);
    return {
      tabKey: tab.key, termId: cur.termId, title: tab.title, host: cur.host, user: cur.user, connId: tab.connId ?? null,
      status: cur.status, os: guessOs(tail), shell: guessShell(tail), cwd: cur.cwd, lastCommand: cur.lastCommand,
      lastOutput: cur.lastOutput, tail, updatedAt: Date.now(),
    };
  };
  const askAi = (kind: "explain" | "fix" | "summarize", selection?: string) => {
    const snap = snapshotNow();
    if (!snap) return;
    useAssistant.getState().publishTerminal(snap);
    const q = kind === "explain" ? explainOutputAsk(snap, selection ?? null)
      : kind === "fix" ? fixLastErrorAsk(snap)
      : summarizeSessionAsk(snap);
    if (!q) { toast.info(t("還沒有透過指令列送出過指令，沒有可修正的對象")); return; }
    useAssistant.getState().ask(q.display, { send: true, extraContext: q.extraContext, extraChips: q.chips });
  };

  const toggleSftp = () => patch(tab.key, { sftpOpen: !rt?.sftpOpen });

  const dot = status === "connected" ? "bg-success" : status === "connecting" ? "bg-warning animate-pulse" : "bg-danger";
  const label = rt?.title || (rt?.user && rt?.host ? `${rt.user}@${rt.host}` : tab.title);

  return (
    <div className={active ? "flex-1 flex flex-col min-w-0 min-h-0" : "hidden"} onKeyDownCapture={onKeyDownCapture}>
      {/* 工具條 */}
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-fg/10 bg-panel text-xs">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />
        <span className="truncate text-fg/80 mono" title={label}>{label}</span>
        {rt?.cwd && <span className="truncate text-fg/35 mono hidden md:inline" title={rt.cwd}>{rt.cwd}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {(status === "disconnected" || status === "error") && (
            <Button variant="primary" size="sm" icon={RefreshCw} onClick={reconnect}>{t("重新連線")}</Button>
          )}
          <IconButton icon={Sparkles} label={t("AI 協助")} active={!!aiMenu || nlOpen}
            onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAiMenu({ x: r.left, y: r.bottom + 4 }); }} />
          <IconButton icon={Search} label={t("搜尋（Ctrl+Shift+F）")} active={searchOpen}
            onClick={() => { if (searchOpen) closeSearch(); else { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); } }} />
          <IconButton icon={Eraser} label={t("清空畫面")} onClick={() => { termRef.current?.clear(); termRef.current?.focus(); }} />
          <IconButton icon={rt?.sftpOpen ? PanelRightClose : PanelRightOpen} label={rt?.sftpOpen ? t("關閉 SFTP") : t("開啟 SFTP")}
            active={!!rt?.sftpOpen} disabled={status !== "connected"} onClick={toggleSftp} />
        </div>
      </div>

      {searchOpen && (
        <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-fg/10 bg-panel">
          <input
            ref={searchInputRef}
            value={searchQ}
            onChange={(e) => { setSearchQ(e.target.value); searchRef.current?.findNext(e.target.value, { incremental: true }); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) findPrev(); else findNext(); }
              else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
            }}
            placeholder={t("搜尋終端機內容…")}
            className="mono flex-1 min-w-0 bg-inset border border-fg/10 rounded px-2 py-0.5 text-xs outline-none focus:border-accent/60"
          />
          <IconButton icon={ChevronUp} label={t("上一個（Shift+Enter）")} onClick={findPrev} />
          <IconButton icon={ChevronDown} label={t("下一個（Enter）")} onClick={findNext} />
          <IconButton icon={X} label={t("關閉搜尋")} onClick={closeSearch} />
        </div>
      )}

      <div className="flex-1 flex min-h-0 min-w-0">
        <div className="relative flex-1 min-w-0 min-h-0 bg-app">
          <div ref={hostRef} className="absolute inset-0 pl-1 pt-1" onContextMenu={onContextMenu} />
          {status === "connecting" && (
            <div className="absolute inset-0 flex items-center justify-center bg-app/70">
              <div className="flex items-center gap-3 px-4 py-2 rounded bg-elevated border border-fg/10 text-xs shadow-lg">
                <Spinner size={14} />
                <span>{t("連線中：{target}", { target: tab.title })}</span>
                <Button size="sm" onClick={cancelConnect}>{t("取消")}</Button>
              </div>
            </div>
          )}
          {(status === "disconnected" || status === "error") && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded bg-elevated border border-fg/10 text-xs shadow-lg max-w-[90%]">
              <span className={`w-2 h-2 rounded-full shrink-0 ${status === "error" ? "bg-danger" : "bg-warning"}`} />
              <span className="truncate">{rt?.error || t("連線已中斷")}</span>
              <Button variant="primary" size="sm" icon={RefreshCw} onClick={reconnect}>{t("重新連線")}</Button>
              <Button size="sm" onClick={() => closeSshTab(tab.key)}>{t("關閉分頁")}</Button>
            </div>
          )}
        </div>
        {rt?.sftpOpen && rt.connId && (
          <>
            <Splitter axis="x" onPointerDown={sftp.onPointerDown} />
            <div style={{ width: sftp.size }} className="shrink-0 min-w-0 flex flex-col bg-panel">
              <Suspense fallback={<div className="p-3 text-xs text-fg/40">{t("載入中…")}</div>}>
                <SftpPanel
                  tabKey={tab.key}
                  connId={rt.connId}
                  onCd={(path) => { void termRegistry.get(tab.key)?.sendLine(`cd ${shellQuote(path)}`).catch(() => undefined); termRef.current?.focus(); }}
                  onClose={() => patch(tab.key, { sftpOpen: false })}
                />
              </Suspense>
            </div>
          </>
        )}
      </div>

      {nlOpen && (
        <Suspense fallback={null}>
          <NlShellBar
            snapshot={snapshotNow()}
            onClose={() => { setNlOpen(false); termRef.current?.focus(); }}
            onApply={(cmd) => { useSshTerminals.getState().insertCompose(tab.key, cmd); setNlOpen(false); }}
          />
        </Suspense>
      )}
      <SshComposeBar tabKey={tab.key} />

      {authPrompt && (
        <SshAuthPromptDialog
          prompt={authPrompt}
          onReply={(answers) => { setAuthPrompt(null); void api.sshAuthAnswer(authPrompt.prompt_id, answers).catch((e) => toast.error(errMsg(e))); }}
          onCancel={() => { setAuthPrompt(null); void api.sshAuthAnswer(authPrompt.prompt_id, null).catch(() => undefined); }}
        />
      )}
      {hostKey && (
        <SshHostKeyDialog
          info={hostKey}
          onReply={(d) => { setHostKey(null); void api.sshHostkeyAnswer(hostKey.prompt_id, d).catch((e) => toast.error(errMsg(e))); }}
        />
      )}

      {ctxMenu && (
        <MenuPanel x={ctxMenu.x} y={ctxMenu.y} minW={160} onClose={() => setCtxMenu(null)}>
          {([
            [t("複製"), () => copySelection(), !termRef.current?.hasSelection()],
            [t("貼上"), () => void pasteFromClipboard(), false],
            [t("全選"), () => termRef.current?.selectAll(), false],
            [t("清空畫面"), () => termRef.current?.clear(), false],
            [t("搜尋"), () => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); }, false],
            [t("解釋選取的輸出"), () => askAi("explain", termRef.current?.getSelection() || undefined), !termRef.current?.hasSelection()],
          ] as [string, () => void, boolean][]).map(([label, fn, disabled]) => (
            <button key={label} type="button" disabled={disabled}
              onClick={() => { setCtxMenu(null); fn(); }}
              className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80 disabled:opacity-40 disabled:pointer-events-none">
              {label}
            </button>
          ))}
        </MenuPanel>
      )}
      {aiMenu && (
        <MenuPanel x={aiMenu.x} y={aiMenu.y} minW={200} onClose={() => setAiMenu(null)}>
          {([
            [t("解釋這段輸出"), () => askAi("explain", termRef.current?.hasSelection() ? termRef.current.getSelection() : undefined)],
            [t("修正這個錯誤"), () => askAi("fix")],
            [t("摘要這個 session"), () => askAi("summarize")],
            [t("用自然語言產生指令…"), () => setNlOpen(true)],
          ] as [string, () => void][]).map(([label, fn]) => (
            <button key={label} type="button"
              onClick={() => { setAiMenu(null); fn(); }}
              className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80">
              <Icon icon={Sparkles} size={12} className="inline mr-1.5 text-accent/80" />{label}
            </button>
          ))}
        </MenuPanel>
      )}
    </div>
  );
}

/** 貼上內容有幾行（結尾那個換行不算一行：複製整行時常帶著它）。 */
function multilineCount(text: string): number {
  return text ? text.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
}

/** 多行貼上的確認框；Ctrl+V 與 Ctrl+Shift+V / 右鍵貼上共用同一句話。 */
function confirmMultilinePaste(text: string): Promise<boolean> {
  return uiConfirm(t("貼上內容含 {n} 行，將逐行送出執行。確定？", { n: multilineCount(text) }), {
    title: t("多行貼上"),
    confirmText: t("貼上"),
  });
}

/** POSIX 單引號包裹（路徑含空白 / 引號時 cd 仍正確）。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
