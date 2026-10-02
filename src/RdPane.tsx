// 遠端桌面分頁：連線生命週期（撥號 / 提示 / 斷線 / 重連）、工具列與全螢幕。畫面本身交給 RdpView / VncView。
//
// 全螢幕是「視窗全螢幕 + 分頁沉浸」兩件事一起做：Tauri 把視窗切成全螢幕（蓋掉工作列 / 選單列），
// 分頁本身改成 fixed 蓋住整個 app（側欄、分頁列都藏起來）。WebView2 的 HTML Fullscreen API 只會填滿 webview，
// 所以不用它。Ctrl+Alt+Enter 切換（遠端桌面客戶端的慣例）；工具列在全螢幕時縮成頂端中央的浮動條，滑到頂端才出現。
// Ctrl+Alt+Del、Win、Alt+Tab 這些本機 OS 會先吃掉的鍵走工具列的「送出按鍵」。
// RustDesk 的工具列另外多了切換螢幕、顯示設定、動作與聊天（RustDeskToolbar）；顯示偏好與「同步剪貼簿」
// 存回已存主機的設定（下次連同一台照舊），快速連線的只記在這個分頁。RustDesk 連線被對方中斷時自動重連（rdRetry.ts）。
import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  ClipboardPaste, Expand, Keyboard, Loader2, PlugZap, RefreshCw, Shrink, ShieldAlert, Unplug,
} from "lucide-react";
import { api, onRdAuthPrompt, onRdCertPrompt, onRdConnClosed, onRdGrabKey, onSshAuthPrompt, onSshHostKeyPrompt } from "./api";
import { useT } from "./i18n";
import { Button, Icon, IconButton, MenuPanel } from "./ui/index";
import { toast } from "./ui";
import type { RdTab } from "./rdTabs";
import type { RdAuthPrompt, RdCertPrompt, RdConnInfo, RdSession, RdStatus } from "./rdTypes";
import { defaultRdOptions } from "./rdTypes";
import type { SshAuthPrompt, SshHostKeyPrompt } from "./sshTypes";
import { rdEndpoint, rdProtocolLabel, rdSessionLabel, useRdSessions } from "./rdSessions";
import { onRdCommand, RD_META, useRdStatus } from "./rdStatus";
import { toArrayBuffer, type RdViewHandle } from "./rdView";
import { RdAuthPromptDialog, RdCertDialog } from "./RdPrompts";
import { SshAuthPromptDialog, SshHostKeyDialog } from "./SshPrompts";
import RdpView from "./RdpView";
// 靜態載入：view 必須在第一次 connect 之前就掛好（輸出在 rdConnect 回來前就會開始送）；noVNC 本體在 VncView 裡才 lazy。
import VncView from "./VncView";
import RustDeskView from "./RustDeskView";
import RustDeskToolbar from "./RustDeskToolbar";
import RustDeskChat from "./RustDeskChat";
import { prefsFromUi, prefsToUi, type RdChatMsg, type RustDeskPrefs, type RustDeskState } from "./rustdeskState";
import { useAssistant } from "./assistant";
import { useInfoPanel } from "./infoPanelState";
import { isRetryableClose, nextRetryDelay, RETRY_WINDOW_MS } from "./rdRetry";


function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
function errCode(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return null;
}

/** Ctrl+Alt+Enter：切全螢幕（不送給遠端）。 */
export function isFullscreenShortcut(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey?: boolean }): boolean {
  return e.key === "Enter" && e.ctrlKey && e.altKey;
}

const COMBOS: { id: string; label: string }[] = [
  { id: "ctrl_alt_del", label: "Ctrl+Alt+Del" },
  { id: "win", label: "Win" },
  { id: "alt_tab", label: "Alt+Tab" },
  { id: "ctrl_esc", label: "Ctrl+Esc" },
  { id: "print_screen", label: "PrintScreen" },
];

export default function RdPane({ tab, active }: { tab: RdTab; active: boolean }) {
  const t = useT();
  const sessions = useRdSessions((s) => s.sessions);
  // 目前的主機設定（已存主機讀 store，重連時就吃得到剛改的設定；ad_hoc 用分頁帶的那份）。
  const session: RdSession | null = useMemo(() => {
    if (tab.target.kind === "ad_hoc") return tab.target.session;
    return sessions.find((s) => s.id === tab.sessionId) ?? null;
  }, [tab.target, tab.sessionId, sessions]);
  const opts = session?.options ?? defaultRdOptions();
  const protocol = session?.protocol ?? tab.protocol;

  const viewRef = useRef<RdViewHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const connIdRef = useRef<string>("");
  const unlistenRef = useRef<(() => void)[]>([]);
  const [status, setStatusState] = useState<RdStatus>("connecting");
  const statusRef = useRef<RdStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<RdConnInfo | null>(null);
  const [cert, setCert] = useState<RdCertPrompt | null>(null);
  const [auth, setAuth] = useState<RdAuthPrompt | null>(null);
  const [sshKey, setSshKey] = useState<SshHostKeyPrompt | null>(null);
  const [sshAuth, setSshAuth] = useState<SshAuthPrompt | null>(null);
  const [immersive, setImmersive] = useState(false);
  const immersiveRef = useRef(false);
  const [barShown, setBarShown] = useState(true);
  const [keysMenu, setKeysMenu] = useState<{ x: number; y: number } | null>(null);
  const wantFullscreen = useRef(!!tab.fullscreen || opts.ui?.fullscreen === "1");

  // ---- RustDesk：工具列狀態、顯示偏好、聊天 ----
  const [rdState, setRdState] = useState<RustDeskState | null>(null);
  const [chat, setChat] = useState<RdChatMsg[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeen, setChatSeen] = useState(0);
  const saveRdSession = useRdSessions((s) => s.save);
  const saved = tab.target.kind === "session" && session != null;
  const [localPrefs, setLocalPrefs] = useState<RustDeskPrefs>(() => prefsFromUi(opts.ui));
  const [localClipboard, setLocalClipboard] = useState(opts.clipboard);
  const savedPrefs = useMemo(() => prefsFromUi(opts.ui), [opts.ui]);
  const rdPrefs = saved ? savedPrefs : localPrefs;
  const rdClipboard = saved ? opts.clipboard : localClipboard;
  const setRdPrefs = (p: RustDeskPrefs) => {
    if (saved && session) void saveRdSession({ ...session, options: { ...session.options, ui: prefsToUi(p, session.options.ui) } });
    else setLocalPrefs(p);
  };
  const setRdClipboard = (on: boolean) => {
    if (saved && session) void saveRdSession({ ...session, options: { ...session.options, clipboard: on } });
    else setLocalClipboard(on);
  };
  const onRdState = (s: RustDeskState | null) => {
    setRdState(s);
    if (s) setChat(s.chat);
  };
  const peerMsgs = chat.filter((m) => m.from === "peer").length;
  const unread = chatOpen ? 0 : Math.max(0, peerMsgs - chatSeen);
  // 對方傳訊息來：打開聊天（官方用戶端也會跳出來），但不搶走畫面的鍵盤焦點。
  const lastPeerMsgs = useRef(0);
  useEffect(() => {
    if (peerMsgs > lastPeerMsgs.current) setChatOpen(true);
    lastPeerMsgs.current = peerMsgs;
  }, [peerMsgs]);
  useEffect(() => { if (chatOpen) setChatSeen(peerMsgs); }, [chatOpen, peerMsgs]);

  const setStatus = (s: RdStatus, extra: { error?: string | null; info?: RdConnInfo | null } = {}) => {
    statusRef.current = s;
    setStatusState(s);
    if ("error" in extra) setError(extra.error ?? null);
    if ("info" in extra) setInfo(extra.info ?? null);
    useRdStatus.getState().patch(tab.key, {
      status: s,
      error: extra.error ?? null,
      security: extra.info?.security,
      encrypted: extra.info?.encrypted,
    });
  };

  const dropListeners = () => {
    for (const un of unlistenRef.current) { try { un(); } catch { /* 已卸載 */ } }
    unlistenRef.current = [];
  };

  // ---- 全螢幕 ----
  const setFullscreen = (on: boolean) => {
    if (immersiveRef.current === on) return;
    immersiveRef.current = on;
    setImmersive(on);
    setBarShown(true);
    void api.rdSetFullscreen(on).catch((e) => toast.error(errMsg(e)));
    // 版面變了之後把焦點還給畫面（鍵盤要繼續進遠端）。
    window.setTimeout(() => viewRef.current?.focus(), 50);
  };
  // 全螢幕時工具列 2.5 秒後收起，滑到頂端再出現。
  useEffect(() => {
    if (!immersive || !barShown) return;
    const id = window.setTimeout(() => setBarShown(false), 2500);
    return () => window.clearTimeout(id);
  }, [immersive, barShown]);
  // 全螢幕 + 作用中 + 已連線：請後端攔 Win / Alt+Tab / Alt+F4 / Ctrl+Esc 轉給這條連線（Windows 才有）。
  // 離開全螢幕、切走、斷線就放掉——非全螢幕時 Alt+Tab 仍該留給本機切視窗。
  useEffect(() => {
    if (!immersive || !active || status !== "connected") return;
    const id = connIdRef.current;
    if (!id) return;
    let un: (() => void) | null = null;
    let alive = true;
    void onRdGrabKey(id, (k) => viewRef.current?.rawKey(k.scancode, k.down)).then((u) => {
      if (alive) un = u; else u();
    });
    void api.rdKeyboardGrab(id).catch(() => undefined);
    return () => {
      alive = false;
      un?.();
      void api.rdKeyboardGrab(null).catch(() => undefined);
    };
  }, [immersive, active, status]);
  // 切到別的分頁 / 關掉分頁時離開全螢幕（視窗全螢幕是整個 app 共用的狀態）。
  useEffect(() => { if (!active && immersiveRef.current) setFullscreen(false); }, [active]);

  // ---- RustDesk 斷線自動重連（rdRetry.ts；對方登入 / 登出作業系統、重新開機時連線一定會斷一下） ----
  const retryRef = useRef<{ since: number; delay: number; timer: number } | null>(null);
  const [retrying, setRetrying] = useState(false);
  /** 下一次自動重連的時間（倒數用）；正在撥號時 null。 */
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [retryAt]);
  const stopRetry = () => {
    if (retryRef.current) window.clearTimeout(retryRef.current.timer);
    retryRef.current = null;
    setRetrying(false);
    setRetryAt(null);
  };
  /** 排下一次自動重連；超過時限 → false（停止，留給使用者按「重新連線」）。 */
  const scheduleRetry = (): boolean => {
    const r = retryRef.current ?? { since: Date.now(), delay: 0, timer: 0 };
    if (Date.now() - r.since > RETRY_WINDOW_MS) {
      stopRetry();
      return false;
    }
    r.delay = nextRetryDelay(r.delay);
    window.clearTimeout(r.timer);
    r.timer = window.setTimeout(() => {
      setRetryAt(null);
      redial();
    }, r.delay * 1000);
    retryRef.current = r;
    setRetrying(true);
    setRetryAt(Date.now() + r.delay * 1000);
    return true;
  };

  // ---- 連線 ----
  const onEnded = (connId: string, reason: string | null) => {
    if (connIdRef.current !== connId) return;
    viewRef.current?.disconnected();
    setStatus("disconnected", { error: reason, info: null });
    if (protocol === "rustdesk" && isRetryableClose(reason)) scheduleRetry();
  };

  const connect = async () => {
    const connId = crypto.randomUUID();
    connIdRef.current = connId;
    setStatus("connecting", { error: null, info: null });
    viewRef.current?.reset(connId);
    // 提問事件在 invoke 之前就掛上（憑證 / 密碼可能在 rdConnect 回來前就要答）。經 SSH 時 SSH 那段的提問同一個 conn id。
    const unCert = await onRdCertPrompt(connId, setCert);
    const unAuth = await onRdAuthPrompt(connId, setAuth);
    const unHost = await onSshHostKeyPrompt(connId, setSshKey);
    const unSsh = await onSshAuthPrompt(connId, setSshAuth);
    const unClosed = await onRdConnClosed(connId, (e) => onEnded(connId, e.reason));
    unlistenRef.current.push(unClosed);
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => { if (connIdRef.current === connId) viewRef.current?.output(toArrayBuffer(buf)); };
    const root = rootRef.current;
    const w = Math.max(640, Math.round(root?.clientWidth ?? 1280));
    const h = Math.max(480, Math.round((root?.clientHeight ?? 800) - (immersiveRef.current ? 0 : 32)));
    const dpr = window.devicePixelRatio || 1;
    try {
      const got = await api.rdConnect(connId, tab.target, w, h, Math.round(dpr * 100), ch);
      if (connIdRef.current !== connId) { void api.rdDisconnect(connId).catch(() => undefined); return; }
      viewRef.current?.connected(got);
      setStatus("connected", { error: null, info: got });
      stopRetry();
      if (wantFullscreen.current) {
        wantFullscreen.current = false;
        if (active) setFullscreen(true);
      }
    } catch (e) {
      if (connIdRef.current !== connId) return;
      const code = errCode(e);
      if (code === "ERR_RD_CANCELLED" || code === "ERR_SSH_CANCELLED") {
        stopRetry();
        setStatus("disconnected", { error: null });
      } else {
        setStatus("error", { error: errMsg(e) });
        // 自動重連中（對方的服務還沒起來 / 還沒回到線上）：再排下一次；密碼錯就停。
        if (retryRef.current && (code === "ERR_RD_AUTH" || !scheduleRetry())) stopRetry();
      }
    } finally {
      unCert(); unAuth(); unHost(); unSsh();
      setCert(null); setAuth(null); setSshKey(null); setSshAuth(null);
    }
  };

  const disconnect = () => {
    stopRetry();
    const id = connIdRef.current;
    connIdRef.current = "";
    dropListeners();
    viewRef.current?.disconnected();
    setStatus("disconnected", { error: null, info: null });
    if (id) void api.rdDisconnect(id).catch(() => undefined);
  };

  /** 丟掉舊連線再撥一次（自動重連也走這裡）。 */
  const redial = () => {
    const old = connIdRef.current;
    dropListeners();
    if (old) void api.rdDisconnect(old).catch(() => undefined);
    void connect();
  };

  const reconnect = () => {
    if (statusRef.current === "connecting") return;
    stopRetry();
    redial();
  };

  // 側欄 / 分頁列右鍵選單的「中斷連線」/「重新連線」；側欄靠 retrying 判斷要不要給「中斷連線」。
  const commandRef = useRef({ disconnect, reconnect });
  commandRef.current = { disconnect, reconnect };
  useEffect(() => onRdCommand(tab.key, (c) => commandRef.current[c]()), [tab.key]);
  useEffect(() => { useRdStatus.getState().patch(tab.key, { retrying }); }, [tab.key, retrying]);

  useEffect(() => {
    // RustDesk 分頁：把 AI 助手與詳細資料面板收起來，遠端畫面拿到整個寬度（要用再自己打開，不會一直被收）。
    if (protocol === "rustdesk") {
      useAssistant.getState().setOpen(false);
      useInfoPanel.getState().setOpen(false);
    }
    void connect();
    return () => {
      if (retryRef.current) window.clearTimeout(retryRef.current.timer);
      retryRef.current = null;
      const id = connIdRef.current;
      connIdRef.current = "";
      dropListeners();
      if (id) void api.rdDisconnect(id).catch(() => undefined);
      if (immersiveRef.current) void api.rdSetFullscreen(false).catch(() => undefined);
      useRdStatus.getState().drop(tab.key);
    };
    // 只在掛載時連一次；重連走 reconnect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切回這個分頁：焦點回畫面；RDP 請後端整張重送（隱藏期間 canvas 沒被清，但保險）。
  useEffect(() => {
    if (!active || statusRef.current !== "connected") return;
    viewRef.current?.focus();
  }, [active]);

  const pasteClipboard = async () => {
    try {
      const text = await api.rdClipboardRead();
      if (!text) { toast.info(t("剪貼簿沒有文字")); return; }
      viewRef.current?.paste(text);
      viewRef.current?.focus();
    } catch (e) {
      toast.error(t("無法讀取剪貼簿：{e}", { e: errMsg(e) }));
    }
  };

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (isFullscreenShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      setFullscreen(!immersiveRef.current);
    }
  };

  const meta = RD_META[protocol];
  const label = session ? rdSessionLabel(session) : tab.title;
  const endpoint = session ? rdEndpoint(session) : "";
  const unencrypted = status === "connected" && info && !info.encrypted;
  const dot = status === "connected" ? "bg-success" : status === "connecting" ? "bg-warning animate-pulse" : "bg-danger";

  const toolbarButtons = (
    <>
      {protocol === "rustdesk" && status === "connected" && rdState && (
        <RustDeskToolbar state={rdState} prefs={rdPrefs} onPrefs={setRdPrefs} clipboard={rdClipboard} onClipboard={setRdClipboard}
          viewOnly={opts.view_only} view={viewRef} chatOpen={chatOpen} unread={unread}
          onChat={() => { setChatOpen((o) => !o); viewRef.current?.focus(); }} hostName={label} />
      )}
      {unencrypted && (
        <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded bg-warning/15 text-warning text-[11px] shrink-0"
          title={info?.security === "rustdesk-id"
            ? t("這條連線的畫面與鍵盤內容沒有加密：沒有填 ID 伺服器的 Key（或填錯），無法驗證對方的身分。在主機設定填入正確的 Key 就會加密。")
            : t("這條連線的畫面與鍵盤內容沒有加密；建議在主機設定改成「經 SSH 主機連線」。")} data-rd-unencrypted="">
          <Icon icon={ShieldAlert} size={11} />{t("未加密")}
        </span>
      )}
      <IconButton icon={Keyboard} label={t("送出按鍵")} disabled={status !== "connected" || opts.view_only}
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setKeysMenu({ x: r.left, y: r.bottom + 4 }); }} />
      <IconButton icon={ClipboardPaste} label={t("把剪貼簿文字送到遠端")} disabled={status !== "connected" || opts.view_only}
        onClick={() => void pasteClipboard()} />
      {protocol === "rdp" && (
        <IconButton icon={RefreshCw} label={t("重新整理畫面")} disabled={status !== "connected"} onClick={() => viewRef.current?.refresh()} />
      )}
      <IconButton data-testid="rd-fullscreen" icon={immersive ? Shrink : Expand}
        label={immersive ? t("離開全螢幕（Ctrl+Alt+Enter）") : t("全螢幕（Ctrl+Alt+Enter）")}
        active={immersive} onClick={() => setFullscreen(!immersive)} />
      {status === "connected" || status === "connecting" ? (
        <IconButton icon={Unplug} label={t("中斷連線")} onClick={disconnect} />
      ) : (
        <IconButton icon={PlugZap} label={t("重新連線")} onClick={reconnect} />
      )}
    </>
  );

  const rootClass = !active
    ? "hidden"
    : immersive
      ? "fixed inset-0 z-[80] flex flex-col bg-black"
      : "flex-1 flex flex-col min-w-0 min-h-0";

  return (
    <div ref={rootRef} className={rootClass} onKeyDownCapture={onKeyDownCapture} data-rd-pane={tab.key} data-rd-immersive={immersive ? "" : undefined}
      onMouseMove={immersive ? (e) => { if (e.clientY < 6) setBarShown(true); } : undefined}>
      {!immersive && (
        <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-fg/10 bg-panel text-xs">
          <Icon icon={meta.icon} size={13} style={{ color: meta.color }} />
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />
          <span className="truncate text-fg/80" title={label}>{label}</span>
          <span className="text-fg/35 shrink-0">{rdProtocolLabel(protocol)}{endpoint ? ` · ${endpoint}` : ""}</span>
          <div className="ml-auto flex items-center gap-0.5">{toolbarButtons}</div>
        </div>
      )}
      {immersive && (
        <div className={`absolute top-0 left-1/2 -translate-x-1/2 z-10 transition-transform duration-200 ${barShown ? "translate-y-0" : "-translate-y-full"}`}
          onMouseEnter={() => setBarShown(true)} data-rd-floatbar="">
          <div className="flex items-center gap-1 px-2 h-8 rounded-b-lg bg-panel/95 border border-t-0 border-fg/15 shadow-lg text-xs">
            <Icon icon={meta.icon} size={13} style={{ color: meta.color }} />
            <span className="truncate max-w-[240px] text-fg/80">{label}</span>
            <span className="w-px h-4 bg-fg/15 mx-1" />
            {toolbarButtons}
          </div>
        </div>
      )}

      <div className="relative flex-1 min-h-0 flex">
        {protocol === "vnc" ? (
          <VncView ref={viewRef} resizeMode={opts.resize_mode} viewOnly={opts.view_only} shared={opts.vnc_shared}
            clipboard={opts.clipboard} />
        ) : protocol === "rdp" ? (
          <RdpView ref={viewRef} resizeMode={opts.resize_mode} viewOnly={opts.view_only} clipboard={opts.clipboard} isPaneShortcut={isFullscreenShortcut} />
        ) : (
          <RustDeskView ref={viewRef} viewOnly={opts.view_only} isPaneShortcut={isFullscreenShortcut}
            clipboard={rdClipboard} prefs={rdPrefs} onState={onRdState} />
        )}
        {protocol === "rustdesk" && chatOpen && (
          <RustDeskChat messages={chat} peerName={label} connected={status === "connected"}
            onSend={(s) => viewRef.current?.sendChat?.(s)}
            onClose={() => { setChatOpen(false); viewRef.current?.focus(); }} />
        )}
        {status !== "connected" && (
          <div className="absolute inset-0 flex items-center justify-center bg-app/80" data-rd-overlay={status}>
            <div className="max-w-md w-full mx-4 rounded-lg border border-fg/10 bg-panel p-5 text-sm space-y-3 text-center">
              <div className="flex items-center justify-center gap-2 text-fg/80">
                {status === "connecting" ? <Icon icon={Loader2} size={16} className="animate-spin" /> : <Icon icon={meta.icon} size={16} style={{ color: meta.color }} />}
                <span>
                  {status === "connecting"
                    ? (retrying ? t("正在重新連線到 {host}…", { host: endpoint || label }) : t("正在連線到 {host}…", { host: endpoint || label }))
                    : retryAt != null
                      ? <span data-rd-retry="">{t("連線中斷，{n} 秒後自動重新連線…", { n: Math.max(0, Math.ceil((retryAt - now) / 1000)) })}</span>
                      : status === "error" ? t("連線失敗") : t("已中斷連線")}
                </span>
              </div>
              {error && <div className="text-xs text-danger break-words whitespace-pre-wrap" data-rd-error="">{error}</div>}
              {retrying && (
                <div className="text-xs text-fg/50">{t("對方登入、登出作業系統或重新開機時，RustDesk 連線會中斷一下，會自動連回來。")}</div>
              )}
              {status === "error" && protocol === "vnc" && (
                <div className="text-xs text-fg/50">{t("連 Mac 時若畫面一直是黑的，請到 Mac 的「系統設定 → 一般 → 共享 → 螢幕共享」確認已開啟，並允許這個帳號。")}</div>
              )}
              <div className="flex justify-center gap-2">
                {status === "connecting" ? (
                  <Button variant="secondary" onClick={disconnect}>{t("取消")}</Button>
                ) : retryAt != null ? (
                  <>
                    <Button variant="primary" icon={PlugZap} onClick={reconnect}>{t("立即重新連線")}</Button>
                    <Button variant="secondary" onClick={stopRetry}>{t("取消")}</Button>
                  </>
                ) : (
                  <Button variant="primary" icon={PlugZap} onClick={reconnect}>{t("重新連線")}</Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {keysMenu && (
        <MenuPanel x={keysMenu.x} y={keysMenu.y} minW={160} onClose={() => setKeysMenu(null)}>
          {COMBOS.map((c) => (
            <button key={c.id} type="button" data-rd-combo={c.id}
              onClick={() => { setKeysMenu(null); viewRef.current?.combo(c.id); viewRef.current?.focus(); }}
              className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80 mono">
              {c.label}
            </button>
          ))}
        </MenuPanel>
      )}

      {cert && (
        <RdCertDialog info={cert} onReply={(d) => { const p = cert; setCert(null); void api.rdCertAnswer(p.prompt_id, d).catch(() => undefined); }} />
      )}
      {auth && (
        <RdAuthPromptDialog prompt={auth} canRemember={tab.target.kind === "session"}
          onReply={(a) => { const p = auth; setAuth(null); void api.rdAuthAnswer(p.prompt_id, a).catch(() => undefined); }}
          onCancel={() => { const p = auth; setAuth(null); void api.rdAuthAnswer(p.prompt_id, null).catch(() => undefined); }} />
      )}
      {sshKey && (
        <SshHostKeyDialog info={sshKey} onReply={(d) => { const p = sshKey; setSshKey(null); void api.sshHostkeyAnswer(p.prompt_id, d).catch(() => undefined); }} />
      )}
      {sshAuth && (
        <SshAuthPromptDialog prompt={sshAuth}
          onReply={(a) => { const p = sshAuth; setSshAuth(null); void api.sshAuthAnswer(p.prompt_id, a).catch(() => undefined); }}
          onCancel={() => { const p = sshAuth; setSshAuth(null); void api.sshAuthAnswer(p.prompt_id, null).catch(() => undefined); }} />
      )}
    </div>
  );
}
