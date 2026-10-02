// RustDesk 檔案傳輸（照官方用戶端的檔案傳輸視窗：左邊本機、右邊對方）。蓋在遠端畫面上，遠端連線照常在後面。
//
// 另開一條 RustDesk 傳檔連線（`rd_files_connect`，對方不送畫面；借畫面連線登入成功的密碼，對方開了雙重驗證時
// 可能要再輸入一次驗證碼）。右邊是 db-kit 共用的檔案面板（SftpPanel：瀏覽、上傳、下載、續傳、同名處理、傳輸清單，
// 後端把這條連線當成第三種檔案後端），左邊是本機（LocalFilesPane）：左邊選了按「上傳 →」傳到右邊目前的資料夾，
// 右邊下載的放進左邊目前的資料夾。關掉面板就關掉傳檔連線。
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { FolderSync, Loader2, PlugZap, X } from "lucide-react";
import { api, onRdAuthPrompt, onSshAuthPrompt, onSshHostKeyPrompt } from "./api";
import { useT } from "./i18n";
import { Button, Icon, IconButton, Spinner } from "./ui/index";
import type { RdTab } from "./rdTabs";
import type { RdAuthPrompt } from "./rdTypes";
import type { SshAuthPrompt, SshHostKeyPrompt } from "./sshTypes";
import { RdAuthPromptDialog } from "./RdPrompts";
import { SshAuthPromptDialog, SshHostKeyDialog } from "./SshPrompts";
import { DEFAULT_RUNTIME, teardownSshTab, useSshTerminals } from "./sshTerminals";
import LocalFilesPane from "./LocalFilesPane";

const SftpPanel = lazy(() => import("./SftpPanel"));

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
function errCode(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return null;
}

export interface RdFilesPanelProps {
  tab: RdTab;
  /** 同一台的畫面連線（借它登入成功的密碼）。 */
  viaConnId: string;
  /** 主機名稱（標題）。 */
  label: string;
  onClose: () => void;
}

export default function RdFilesPanel({ tab, viaConnId, label, onClose }: RdFilesPanelProps) {
  const t = useT();
  const filesKey = `${tab.key}:files`;
  const [connId] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<RdAuthPrompt | null>(null);
  const [sshKey, setSshKey] = useState<SshHostKeyPrompt | null>(null);
  const [sshAuth, setSshAuth] = useState<SshAuthPrompt | null>(null);
  const [localDir, setLocalDir] = useState<string | null>(null);
  const [uploadReq, setUploadReq] = useState<{ seq: number; paths: string[] } | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const alive = useRef(true);

  const connect = async () => {
    setStatus("connecting");
    setError(null);
    await teardownSshTab(filesKey);
    useSshTerminals.setState((s) => ({
      rt: { ...s.rt, [filesKey]: { ...DEFAULT_RUNTIME, connId, host: "", user: "", sftpOpen: true, sftpWinRequest: false } },
    }));
    const unAuth = await onRdAuthPrompt(connId, setAuth);
    const unHost = await onSshHostKeyPrompt(connId, setSshKey);
    const unSsh = await onSshAuthPrompt(connId, setSshAuth);
    try {
      await api.rdFilesConnect(connId, tab.target, viaConnId || undefined);
      if (!alive.current) return;
      useSshTerminals.getState().patch(filesKey, { status: "connected" });
      setStatus("connected");
    } catch (e) {
      if (!alive.current) return;
      const code = errCode(e);
      if (code === "ERR_RD_CANCELLED" || code === "ERR_SSH_CANCELLED") { onClose(); return; }
      setStatus("error");
      setError(errMsg(e));
    } finally {
      unAuth(); unHost(); unSsh();
      setAuth(null); setSshKey(null); setSshAuth(null);
    }
  };

  useEffect(() => {
    alive.current = true;
    void connect();
    return () => {
      alive.current = false;
      void teardownSshTab(filesKey);
      void api.rdFilesDisconnect(connId).catch(() => undefined);
    };
    // 只在打開時連一次；重連走 connect()。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-app" data-rd-files={status}>
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-fg/10 bg-panel text-xs">
        <Icon icon={FolderSync} size={13} className="text-accent shrink-0" />
        <span className="truncate text-fg/80">{t("檔案傳輸：{host}", { host: label })}</span>
        {status === "connecting" && <Icon icon={Loader2} size={12} className="animate-spin text-fg/50 shrink-0" />}
        <IconButton icon={X} className="ml-auto" label={t("關閉檔案傳輸")} onClick={onClose} data-rd-files-close="" />
      </div>
      {status === "connected" ? (
        <div className="flex-1 min-h-0 flex">
          <div className="w-1/2 min-w-0 flex border-r border-fg/10">
            <LocalFilesPane onDirChange={setLocalDir} refreshKey={localRefresh} canUpload
              onUpload={(paths) => setUploadReq((r) => ({ seq: (r?.seq ?? 0) + 1, paths }))} />
          </div>
          <div className="w-1/2 min-w-0 flex">
            <Suspense fallback={<div className="flex-1 grid place-items-center"><Spinner /></div>}>
              <SftpPanel tabKey={filesKey} connId={connId} title={t("對方")} localDir={localDir} uploadRequest={uploadReq}
                onDownloaded={() => setLocalRefresh((n) => n + 1)} />
            </Suspense>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md w-full mx-4 rounded-lg border border-fg/10 bg-panel p-5 text-sm space-y-3 text-center">
            <div className="flex items-center justify-center gap-2 text-fg/80">
              {status === "connecting" && <Icon icon={Loader2} size={16} className="animate-spin" />}
              <span>{status === "connecting" ? t("正在開啟檔案傳輸…") : t("無法開啟檔案傳輸")}</span>
            </div>
            {error && <div className="text-xs text-danger break-words whitespace-pre-wrap" data-rd-files-error="">{error}</div>}
            {status === "error" && (
              <div className="text-xs text-fg/50">{t("對方停在登入畫面時，RustDesk 要等有人登入作業系統之後才能傳檔。")}</div>
            )}
            <div className="flex justify-center gap-2">
              {status === "error" && <Button variant="primary" icon={PlugZap} onClick={() => void connect()}>{t("重新連線")}</Button>}
              <Button variant="secondary" onClick={onClose}>{status === "connecting" ? t("取消") : t("關閉")}</Button>
            </div>
          </div>
        </div>
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
