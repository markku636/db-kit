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
  ChevronDown, ChevronUp, Eraser, ExternalLink, FolderOpen, PanelRightClose, PanelRightOpen, RefreshCw, Search, Sparkles, Unplug, X,
} from "lucide-react";
import { api, onSshAuthPrompt, onSshConnClosed, onSshHostKeyPrompt, onSshTermExit } from "./api";
import type { SshTab } from "./sshTabs";
import type { SshAuthPrompt, SshHostKeyPrompt, SshStatus } from "./sshTypes";
import { DEFAULT_RUNTIME, sshTail, teardownSshTab, termRegistry, useSshTerminals } from "./sshTerminals";
import { useSshPrefs } from "./sshPrefs";
import { sessionLabel, useSshSessions } from "./sshSessions";
import { xtermThemeFor } from "./sshTerminalTheme";
import { guessOs, guessShell } from "./sshCapture";
import { b64ToBytes, binaryToB64, utf8ToB64 } from "./sshBytes";
import { readClipboardText, writeClipboardText } from "./clipboard";
import { isAppReserved } from "./ui/keyScope";
import { SshAuthPromptDialog, SshHostKeyDialog } from "./SshPrompts";
import SshComposeBar from "./SshComposeBar";
import SshStatusBar from "./SshStatusBar";
import { bufferLinesToText, createRecorder, defaultLogName, type SessionRecorder } from "./sshSessionLog";
import { disconnectKind } from "./sshDisconnect";
import { shellQuote, terminalDir } from "./sshCwd";
import { CommandTracker, type TrackedCommand } from "./sshCommandTracker";
import { redactSecrets } from "./sshOpLog";
import { useSshOpLog } from "./sshOpLogStore";
import { openSftpWindow, useSftpWindows } from "./sftpWindowBridge";
import { useTheme } from "./theme";
import { EDITOR_THEMES, getEditorThemeDef } from "./editorThemes";
import { t, useT } from "./i18n";
import { Button, Icon, IconButton, MenuPanel, Spinner, useModalView } from "./ui/index";
import { pickSaveFile, toast, uiConfirm } from "./ui";
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

/** 執行的指令記進 SSH 操作紀錄（密碼參數先換成 ***；關掉紀錄時後端不寫）。 */
function logCommand(c: TrackedCommand<{ connId: string; cwd: string | null }>) {
  if (!c.ctx.connId) return;
  void api.sshOplogCommand({ conn_id: c.ctx.connId, detail: redactSecrets(c.text), ts: c.ts, cwd: c.ctx.cwd, source: c.source })
    .catch(() => undefined);
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
  // SFTP 面板放大成整個分頁（暫時收起終端機，檔案清單才有地方並排大小 / 時間 / 權限）。
  const [sftpMax, setSftpMax] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 狀態列：終端大小、連線時間；工作階段記錄（開著時每秒把去完 ANSI 的輸出追加進檔案）。
  const [termSize, setTermSize] = useState<{ cols: number; rows: number } | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const recRef = useRef<{ path: string; rec: SessionRecorder; timer: number; untap: () => void } | null>(null);
  const jumpLabel = useSshSessions((s) => {
    const me = s.sessions.find((x) => x.id === tab.sessionId);
    const j = me?.jump_session_id ? s.sessions.find((x) => x.id === me.jump_session_id) : undefined;
    return j ? sessionLabel(j) : null;
  });

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

    // 操作紀錄：Enter 時從畫面讀出執行的指令（不記鍵盤，密碼提示下打的字不會回顯，所以讀不到）。
    const tracker = new CommandTracker(term, logCommand, () => ({
      connId: connIdRef.current,
      cwd: terminalDir(useSshTerminals.getState().rt[tab.key]),
    }));
    term.onData((d) => {
      const id = termIdRef.current;
      if (!id) return;
      tracker.onInput(d);
      void api.sshTermWrite(id, utf8ToB64(d)).catch(() => undefined);
    });
    term.onBinary((d) => { const id = termIdRef.current; if (id) void api.sshTermWrite(id, binaryToB64(d)).catch(() => undefined); });
    term.onResize(({ cols, rows }) => {
      setTermSize({ cols, rows });
      const id = termIdRef.current;
      if (id) void api.sshTermResize(id, cols, rows).catch(() => undefined);
    });
    setTermSize({ cols: term.cols, rows: term.rows });
    term.onTitleChange((title) => patch(tab.key, { title }));
    // OSC 7（file://host/path）：bash / zsh 常見設定會在每次提示符回報 cwd。
    term.parser.registerOscHandler(7, (data) => {
      try { patch(tab.key, { cwd: decodeURIComponent(new URL(data).pathname) }); } catch { /* 非 URL 格式就略過 */ }
      return true;
    });
    term.onSelectionChange(() => {
      if (prefsRef.current.copyOnSelect && term.hasSelection()) void writeClipboardText(term.getSelection()).catch(() => undefined);
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
      if (!prefsRef.current.warnMultilinePaste || !pasteRunsImmediately(text)) return;
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
      sendLine: async (line, source = "app") => {
        const id = termIdRef.current;
        if (!id || statusRef.current !== "connected") throw new Error(t("終端機尚未連線"));
        // 送出前先看游標停在哪：在密碼提示上送的是密碼，不記。
        tracker.noteSent(line, source);
        await api.sshTermSendLine(id, line);
      },
      atSecretPrompt: () => tracker.atSecretPrompt(),
      tapData: (fn) => { tapsRef.current.add(fn); return () => { tapsRef.current.delete(fn); }; },
      focus: () => term.focus(),
      reconnect,
    });
    useSshTerminals.setState((s) => ({ rt: { ...s.rt, [tab.key]: { ...DEFAULT_RUNTIME, connId: "", host: "", user: "", sftpOpen: !!tab.openSftp, sftpWinRequest: !!tab.openSftpWin } } }));
    void connect();

    return () => {
      host.removeEventListener("paste", onNativePaste, true);
      dropListeners();
      tracker.dispose();
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

  // ---- 狀態列：連線時間、儲存畫面內容、記錄工作階段 ----
  const status0 = rt?.status;
  useEffect(() => { setConnectedAt(status0 === "connected" ? Date.now() : null); }, [status0]);

  const targetLabel = () => (rt?.user && rt?.host ? `${rt.user}@${rt.host}` : tab.title);
  const flushRecording = () => {
    const r = recRef.current;
    if (!r) return;
    const text = r.rec.take();
    if (text) void api.sshSessionLogWrite(r.path, text, false).catch((e) => toast.error(errMsg(e)));
  };
  const stopRecording = (silent = false) => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    r.untap();
    window.clearInterval(r.timer);
    const tail = r.rec.flush() + t("# 結束於 {time}", { time: new Date().toLocaleString(undefined, { hour12: false }) }) + "\n";
    void api.sshSessionLogWrite(r.path, tail, false).catch(() => undefined);
    setRecording(null);
    if (!silent) toast.success(t("已停止記錄：{path}", { path: r.path }));
  };
  const startRecording = async () => {
    if (recRef.current) return;
    const label = targetLabel();
    const path = await pickSaveFile(defaultLogName(label, new Date()), [{ name: t("記錄檔"), extensions: ["log", "txt"] }]);
    if (!path) return;
    const header = t("# db-kit SSH 工作階段記錄：{target} · 開始於 {time}", { target: label, time: new Date().toLocaleString(undefined, { hour12: false }) }) + "\n";
    try {
      await api.sshSessionLogWrite(path, header, true);
    } catch (e) {
      toast.error(errMsg(e));
      return;
    }
    const rec = createRecorder();
    const tap = (b: Uint8Array) => rec.push(b);
    tapsRef.current.add(tap);
    recRef.current = { path, rec, timer: window.setInterval(flushRecording, 1000), untap: () => { tapsRef.current.delete(tap); } };
    setRecording(path);
    toast.success(t("開始記錄到 {path}", { path }));
  };
  // 關分頁 / 卸載時把記錄收尾（寫進最後一段與結束時間）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => stopRecording(true), []);

  const saveScreen = async () => {
    const term = termRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lines: { text: string; wrapped: boolean }[] = [];
    for (let i = 0; i < buf.length; i++) {
      const l = buf.getLine(i);
      if (l) lines.push({ text: l.translateToString(true), wrapped: l.isWrapped });
    }
    const text = bufferLinesToText(lines);
    if (!text) { toast.info(t("畫面是空的")); return; }
    const path = await pickSaveFile(defaultLogName(targetLabel(), new Date(), "txt"), [{ name: t("文字檔"), extensions: ["txt", "log"] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, text);
      toast.success(t("已儲存畫面內容到 {path}", { path }));
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  // ---- 剪貼簿（走後端讀寫，見 clipboard.ts：Linux / macOS 的 webview 讀不到、寫不進）----
  const copySelection = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void writeClipboardText(term.getSelection()).catch(() => toast.error(t("複製失敗")));
    term.clearSelection();
  };
  const pasteFromClipboard = async () => {
    let text = "";
    try { text = await readClipboardText(); } catch { toast.error(t("無法讀取剪貼簿")); return; }
    if (!text) return;
    if (pasteRunsImmediately(text) && prefsRef.current.warnMultilinePaste && !(await confirmMultilinePaste(text))) return;
    termRef.current?.paste(text);
    termRef.current?.focus();
  };

  const onKeyDownCapture = (e: ReactKeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || !e.shiftKey) return;
    // 只在焦點位於 xterm 本身時才當成終端機的複製 / 貼上 / 搜尋。這個分頁裡還有命令列輸入條、
    // SFTP 面板與它的編輯器——在那裡按 Ctrl+Shift+V 是要貼進那個輸入框，被這裡攔走就會變成
    // 「把剪貼簿貼進 shell」，而帶換行的單行內容貼進去就直接執行了。
    if (!hostRef.current?.contains(e.target as Node)) return;
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

  const toggleSftp = () => { if (rt?.sftpOpen) setSftpMax(false); patch(tab.key, { sftpOpen: !rt?.sftpOpen }); };
  const closeSftp = () => { setSftpMax(false); patch(tab.key, { sftpOpen: false }); termRef.current?.focus(); };
  const sftpOpen = !!rt?.sftpOpen;
  const sftpShown = sftpOpen && !!rt?.connId;
  const maximized = sftpShown && sftpMax;

  const dot = status === "connected" ? "bg-success" : status === "connecting" ? "bg-warning animate-pulse" : "bg-danger";
  const label = rt?.title || (rt?.user && rt?.host ? `${rt.user}@${rt.host}` : tab.title);
  // 斷線提示列的標題：認得的 OS 錯誤講人話（原文照樣放第二行），其餘依狀態。
  const ended = status === "disconnected" || status === "error";
  const endKind = disconnectKind(rt?.error);
  const endTitle = endKind === "reset" ? t("遠端主機中斷了連線")
    : endKind === "timeout" ? t("連線逾時")
    : endKind === "refused" ? t("連線被拒絕")
    : endKind === "unreachable" ? t("連不到主機")
    : status === "error" ? t("連線失敗") : t("連線已中斷");
  const sftpLabel = sftpOpen ? t("關閉 SFTP") : t("開啟 SFTP");
  const sftpWinOpen = useSftpWindows((s) => !!s.open[tab.key]);
  /** SFTP 獨立視窗；`initialDir` = 從側邊面板移過去時面板所在的資料夾。 */
  const openSftpWin = async (initialDir?: string) => {
    // 視窗標題：主機名稱（分頁上那個）加上實際連到哪裡，工作列上好認。
    const who = rt?.user && rt?.host ? `${rt.user}@${rt.host}` : "";
    const title = who && who !== tab.title ? `${tab.title} · ${who}` : tab.title || who;
    try {
      await openSftpWindow(tab.key, { title, initialDir });
      return true;
    } catch (e) {
      toast.error(t("無法開啟 SFTP 視窗：{msg}", { msg: errMsg(e) }));
      return false;
    }
  };
  // 側欄「開啟 SFTP」要的是獨立視窗，但視窗用的是這個分頁的連線：等連上才開，開一次就清掉要求。
  const sftpWinRequest = !!rt?.sftpWinRequest;
  useEffect(() => {
    if (!sftpWinRequest || status !== "connected") return;
    patch(tab.key, { sftpWinRequest: false });
    void openSftpWin();
    // openSftpWin 每次 render 都是新的；只看要求與連線狀態。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpWinRequest, status]);

  return (
    <div className={active ? "flex-1 flex flex-col min-w-0 min-h-0" : "hidden"} onKeyDownCapture={onKeyDownCapture}>
      {/* 工具條 */}
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-fg/10 bg-panel text-xs">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />
        <span className="truncate text-fg/80 mono" title={label}>{label}</span>
        {rt?.cwd && <span className="truncate text-fg/35 mono hidden md:inline" title={rt.cwd}>{rt.cwd}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={Sparkles} label={t("AI 協助")} active={!!aiMenu || nlOpen}
            onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAiMenu({ x: r.left, y: r.bottom + 4 }); }} />
          {/* 帶字的按鈕：檔案瀏覽是終端機分頁的第二個主要功能。開的是獨立視窗（可以拖到另一個螢幕、
              把檔案拖進去上傳）；要跟終端機並排，用最右邊的側邊面板鈕。 */}
          <button type="button" data-testid="ssh-sftp-window" aria-label={t("SFTP 獨立視窗")}
            title={t("在獨立視窗開 SFTP：瀏覽終端機所在的資料夾，把檔案拖進去就上傳，傳到一半中斷可以續傳")}
            disabled={status !== "connected"} onClick={() => void openSftpWin()}
            className={"h-7 px-2 inline-flex items-center gap-1 rounded shrink-0 transition-colors text-xs font-medium " +
              "disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent/60 " +
              (sftpWinOpen ? "bg-accent/12 text-accent" : "text-fg/60 hover:text-fg hover:bg-fg/10 active:bg-fg/[0.14]")}>
            <Icon icon={FolderOpen} size={15} />SFTP<Icon icon={ExternalLink} size={11} className="opacity-60" />
          </button>
          <IconButton icon={Search} label={t("搜尋（Ctrl+Shift+F）")} active={searchOpen}
            onClick={() => { if (searchOpen) closeSearch(); else { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); } }} />
          <IconButton icon={Eraser} label={t("清空畫面")} onClick={() => { termRef.current?.clear(); termRef.current?.focus(); }} />
          <IconButton data-testid="ssh-sftp-toggle" icon={sftpOpen ? PanelRightClose : PanelRightOpen} label={sftpLabel}
            aria-pressed={sftpOpen} active={sftpOpen} disabled={status !== "connected"} onClick={toggleSftp} />
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
        {/* 放大 SFTP 時只是藏起來（不卸載）：shell 與畫面都留著，縮回來時 ResizeObserver 會重新 fit。 */}
        <div className={maximized ? "hidden" : "flex-1 min-w-0 min-h-0 flex flex-col"}>
          {ended && (
            // 斷線提示是終端機上緣佔版面的一條，不是浮層：不會蓋住畫面上的輸出，也不跟 xterm 的圖層搶 z-index（issue #7）。
            // 按鈕不換行、不被壓縮；原因太長就截斷，完整原文在 tooltip。
            <div data-testid="ssh-disconnected" role="alert"
              className={`shrink-0 flex items-center gap-3 px-3 py-2 border-b text-xs ${status === "error" ? "bg-danger/10 border-danger/25" : "bg-warning/10 border-warning/25"}`}>
              <Icon icon={Unplug} size={16} className={`shrink-0 ${status === "error" ? "text-danger" : "text-warning"}`} />
              <div className="min-w-0 flex-1 leading-snug">
                <div className="font-medium text-fg/90 truncate">{endTitle}</div>
                {rt?.error && <div className="truncate text-fg/50 mono text-[11px]" title={rt.error}>{rt.error}</div>}
              </div>
              <span className="hidden lg:inline shrink-0 whitespace-nowrap text-fg/40">{t("在終端機按 Enter 也能重新連線")}</span>
              <Button variant="primary" size="sm" icon={RefreshCw} className="shrink-0 whitespace-nowrap" onClick={reconnect}>{t("重新連線")}</Button>
              <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={() => closeSshTab(tab.key)}>{t("關閉分頁")}</Button>
            </div>
          )}
          <div className="relative flex-1 min-w-0 min-h-0 bg-app">
            {/* isolate：xterm 自己的圖層（WebGL 渲染器的 xterm-link-layer canvas、scrollbar、decoration…）都帶 z-index，
                不關在這個 stacking context 裡就會蓋到疊在上面的「連線中」提示，看得到按不到（issue #7）。 */}
            <div ref={hostRef} className="absolute inset-0 pl-1 pt-1 isolate" onContextMenu={onContextMenu} />
            {status === "connecting" && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-app/70">
                <div className="flex items-center gap-3 px-4 py-2 rounded bg-elevated border border-fg/10 text-xs shadow-lg">
                  <Spinner size={14} />
                  <span>{t("連線中：{target}", { target: tab.title })}</span>
                  <Button size="sm" onClick={cancelConnect}>{t("取消")}</Button>
                </div>
              </div>
            )}
          </div>
        </div>
        {sftpShown && rt && (
          <>
            {!maximized && <Splitter axis="x" onPointerDown={sftp.onPointerDown} />}
            <div style={maximized ? undefined : { width: sftp.size }}
              className={`${maximized ? "flex-1" : "shrink-0"} min-w-0 flex flex-col bg-panel`}>
              <Suspense fallback={<div className="p-3 text-xs text-fg/40">{t("載入中…")}</div>}>
                <SftpPanel
                  tabKey={tab.key}
                  connId={rt.connId}
                  onCd={(path) => {
                    void termRegistry.get(tab.key)?.sendLine(`cd ${shellQuote(path)}`).catch(() => undefined);
                    // 放大時終端機是藏起來的：cd 過去就是要看它，縮回來。
                    setSftpMax(false);
                    termRef.current?.focus();
                  }}
                  onClose={closeSftp}
                  maximized={maximized}
                  onToggleMaximize={() => setSftpMax((v) => !v)}
                  onPopOut={(p) => { void openSftpWin(p).then((ok) => { if (ok) closeSftp(); }); }}
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
      <SshStatusBar label={label} jump={jumpLabel} size={termSize} status={status} connectedAt={connectedAt} recording={recording}
        onSave={() => void saveScreen()} onToggleRecord={() => { if (recording) stopRecording(); else void startRecording(); }}
        onOpLog={() => useSshOpLog.getState().show(tab.sessionId
          ? { sessionId: tab.sessionId, label: tab.title }
          : { host: rt?.user && rt?.host ? `${rt.user}@${rt.host}` : "", label: targetLabel() })} />
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

/**
 * 貼上後會不會有東西「不按 Enter 就被執行」：內容裡只要有換行就會。
 * 單行但結尾帶換行（網頁上三連擊選取指令常這樣）一樣會立刻跑——只算多行的話這種剛好漏掉。
 * shell 有開 bracketed paste（bash 5.1+ / zsh 預設）時其實不會立刻執行，但前端看不出對方有沒有開，寧可多問。
 */
function pasteRunsImmediately(text: string): boolean {
  return /[\r\n]/.test(text);
}

/** 會立刻執行的貼上的確認框；Ctrl+V 與 Ctrl+Shift+V / 右鍵貼上共用。 */
function confirmMultilinePaste(text: string): Promise<boolean> {
  const n = multilineCount(text);
  const msg = n > 1
    ? t("貼上內容含 {n} 行，將逐行送出執行。確定？", { n })
    : t("貼上的內容結尾有換行，貼上後會立刻執行：{cmd}。確定？", { cmd: text.trim().slice(0, 120) });
  return uiConfirm(msg, { title: t("多行貼上"), confirmText: t("貼上") });
}
