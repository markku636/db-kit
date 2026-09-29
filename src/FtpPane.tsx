// FTP 主機的分頁：只有檔案面板，沒有終端機。
//
// 連線流程與 SSH 終端機分頁相同（ssh_connect 依主機的協定走 FTP；密碼 / FTPS 憑證的提問用同一套對話框），
// 連上後檔案面板用同一個 connId 開瀏覽工作階段（ssh_sftp_open），上傳下載、續傳、衝突處理都與 SFTP 共用。
// 分頁切走時不卸載（MainArea 常駐所有 SSH 分頁），真正關閉分頁才 teardown。
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ExternalLink, FolderOpen, RefreshCw, Unplug } from "lucide-react";
import { api, onSshAuthPrompt, onSshHostKeyPrompt } from "./api";
import type { SshTab } from "./sshTabs";
import type { SshAuthPrompt, SshHostKeyPrompt, SshStatus } from "./sshTypes";
import { DEFAULT_RUNTIME, teardownSshTab, useSshTerminals } from "./sshTerminals";
import { openSftpWindow, useSftpWindows } from "./sftpWindowBridge";
import { SshAuthPromptDialog, SshHostKeyDialog } from "./SshPrompts";
import { useT } from "./i18n";
import { Button, Icon, Spinner } from "./ui/index";
import { toast } from "./ui";
import { useStore } from "./store";

const SftpPanel = lazy(() => import("./SftpPanel"));

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
function errCode(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return null;
}

export default function FtpPane({ tab, active }: { tab: SshTab; active: boolean }) {
  const t = useT();
  const rt = useSshTerminals((s) => s.rt[tab.key]);
  const patch = useSshTerminals((s) => s.patch);
  const closeSshTab = useStore((s) => s.closeSshTab);
  const protocol = tab.ftp?.label ?? "FTP";

  const connIdRef = useRef("");
  const statusRef = useRef<SshStatus>("connecting");
  const [authPrompt, setAuthPrompt] = useState<SshAuthPrompt | null>(null);
  const [hostKey, setHostKey] = useState<SshHostKeyPrompt | null>(null);

  const setStatus = (status: SshStatus, extra: Partial<Parameters<typeof patch>[1]> = {}) => {
    statusRef.current = status;
    patch(tab.key, { status, ...extra });
  };

  const connect = async () => {
    const connId = crypto.randomUUID();
    connIdRef.current = connId;
    setStatus("connecting", { connId, sftpId: null, error: null });
    // 提問事件要在 invoke 之前就掛上：密碼 / 憑證對話框可能在 sshConnect 回來前就需要回答。
    const unHost = await onSshHostKeyPrompt(connId, setHostKey);
    const unAuth = await onSshAuthPrompt(connId, setAuthPrompt);
    try {
      const info = await api.sshConnect(connId, tab.target);
      // 已被取消 / 卸載：連線可能照樣完成 —— 這裡補斷，不留孤兒連線。
      if (connIdRef.current !== connId) { void api.sshDisconnect(connId).catch(() => undefined); return; }
      setStatus("connected", { host: info.host, user: info.username, error: null });
    } catch (e) {
      if (connIdRef.current !== connId) return;
      if (errCode(e) === "ERR_SSH_CANCELLED") setStatus("disconnected", { error: null });
      else setStatus("error", { error: errMsg(e) });
    } finally {
      unHost();
      unAuth();
      setAuthPrompt(null);
      setHostKey(null);
    }
  };

  const reconnect = () => {
    if (statusRef.current === "connecting") return;
    const old = connIdRef.current;
    if (old) void api.sshDisconnect(old).catch(() => undefined);
    void connect();
  };

  const cancelConnect = () => {
    const id = connIdRef.current;
    if (!id) return;
    // 先讓 connect() 認不得這次連線（登入完成後它會自己補斷），再請後端丟掉待答提示。
    connIdRef.current = "";
    setStatus("disconnected", { error: null });
    void api.sshDisconnect(id).catch(() => undefined);
  };

  useEffect(() => {
    useSshTerminals.setState((s) => ({
      rt: { ...s.rt, [tab.key]: { ...DEFAULT_RUNTIME, connId: "", host: "", user: "", sftpOpen: true, sftpWinRequest: !!tab.openSftpWin } },
    }));
    void connect();
    return () => { void teardownSshTab(tab.key); };
    // 只在掛載時跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = rt?.status ?? "connecting";
  const who = rt?.user && rt?.host ? `${rt.user}@${rt.host}` : "";
  const label = who || tab.title;
  const winOpen = useSftpWindows((s) => !!s.open[tab.key]);
  /** 獨立視窗（可以把檔案拖進去上傳）；`initialDir` = 分頁裡的面板目前所在的資料夾。 */
  const openWin = async (initialDir?: string) => {
    const title = who && who !== tab.title ? `${tab.title} · ${who}` : tab.title || who;
    try {
      await openSftpWindow(tab.key, { title, initialDir, protocol });
    } catch (e) {
      toast.error(t("無法開啟檔案視窗：{msg}", { msg: errMsg(e) }));
    }
  };
  // 側欄「在獨立視窗開啟」：等連上才開，開一次就清掉要求。
  const winRequest = !!rt?.sftpWinRequest;
  useEffect(() => {
    if (!winRequest || status !== "connected") return;
    patch(tab.key, { sftpWinRequest: false });
    void openWin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winRequest, status]);

  const dot = status === "connected" ? "bg-success" : status === "connecting" ? "bg-warning animate-pulse" : "bg-danger";
  const ended = status === "disconnected" || status === "error";

  return (
    <div data-testid="ftp-pane" className={active ? "flex-1 flex flex-col min-w-0 min-h-0" : "hidden"}>
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-fg/10 bg-panel text-xs">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />
        <span className="shrink-0 px-1 rounded bg-fg/10 text-fg/60 text-[10px] font-medium">{protocol}</span>
        <span className="truncate text-fg/80 mono" title={label}>{label}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" data-testid="ftp-window" aria-label={t("在獨立視窗開啟")}
            title={t("在獨立視窗開啟：可以拖到另一個螢幕，把檔案拖進去就上傳")}
            disabled={status !== "connected"} onClick={() => void openWin()}
            className={"h-7 px-2 inline-flex items-center gap-1 rounded shrink-0 transition-colors text-xs font-medium " +
              "disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent/60 " +
              (winOpen ? "bg-accent/12 text-accent" : "text-fg/60 hover:text-fg hover:bg-fg/10 active:bg-fg/[0.14]")}>
            <Icon icon={FolderOpen} size={15} />{t("獨立視窗")}<Icon icon={ExternalLink} size={11} className="opacity-60" />
          </button>
        </div>
      </div>

      {ended && (
        <div data-testid="ftp-disconnected" role="alert"
          className={`shrink-0 flex items-center gap-3 px-3 py-2 border-b text-xs ${status === "error" ? "bg-danger/10 border-danger/25" : "bg-warning/10 border-warning/25"}`}>
          <Icon icon={Unplug} size={16} className={`shrink-0 ${status === "error" ? "text-danger" : "text-warning"}`} />
          <div className="min-w-0 flex-1 leading-snug">
            <div className="font-medium text-fg/90 truncate">{status === "error" ? t("連線失敗") : t("已取消連線")}</div>
            {rt?.error && <div className="truncate text-fg/50 mono text-[11px]" title={rt.error}>{rt.error}</div>}
          </div>
          <Button variant="primary" size="sm" icon={RefreshCw} className="shrink-0 whitespace-nowrap" onClick={reconnect}>{t("重新連線")}</Button>
          <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={() => closeSshTab(tab.key)}>{t("關閉分頁")}</Button>
        </div>
      )}

      <div className="relative flex-1 min-h-0 flex flex-col bg-panel">
        {status === "connected" && rt?.connId && (
          <Suspense fallback={<div className="p-3 text-xs text-fg/40">{t("載入中…")}</div>}>
            <SftpPanel tabKey={tab.key} connId={rt.connId} title={protocol} onPopOut={(p) => void openWin(p)} />
          </Suspense>
        )}
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
    </div>
  );
}
