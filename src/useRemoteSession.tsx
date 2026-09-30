// 比對分頁的一邊是遠端主機時：自己開一條連線 + 檔案工作階段（SFTP / FTP），分頁關掉就收掉。
//
// 連線流程與 FtpPane 相同（ssh_connect 依主機協定走 SSH 或 FTP；密碼 / host key / FTPS 憑證的
// 提問用同一套對話框），連上後 ssh_sftp_open 拿 sftp_id，之後的比對 / 下載 / 上傳都帶它。
// 不借用終端機分頁的連線：那個分頁隨時可能被關掉，比對跑到一半通道就沒了。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, onSshAuthPrompt, onSshHostKeyPrompt } from "./api";
import type { SshAuthPrompt, SshHostKeyPrompt, SshTargetRef } from "./sshTypes";
import { SshAuthPromptDialog, SshHostKeyDialog } from "./SshPrompts";
import { toast } from "./ui";

export type RemoteStatus = "idle" | "connecting" | "connected" | "error" | "cancelled";

export interface RemoteSession {
  status: RemoteStatus;
  sftpId: string | null;
  home: string;
  error: string | null;
  reconnect: () => void;
  cancel: () => void;
  /** 連線提問的對話框（掛在呼叫端的 JSX 裡）。 */
  prompts: ReactNode;
}

export function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
export function errCode(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return null;
}

/** `target` 為 null（這一邊不是遠端）時什麼都不做，回 idle。target 以 JSON 比較，內容沒變不重連。 */
export function useRemoteSession(target: SshTargetRef | null): RemoteSession {
  const [status, setStatus] = useState<RemoteStatus>(target ? "connecting" : "idle");
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [home, setHome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [authPrompt, setAuthPrompt] = useState<SshAuthPrompt | null>(null);
  const [hostKey, setHostKey] = useState<SshHostKeyPrompt | null>(null);
  const connIdRef = useRef("");
  const sftpRef = useRef<string | null>(null);
  const targetKey = target ? JSON.stringify(target) : "";
  const targetRef = useRef(target);
  targetRef.current = target;

  const teardown = useCallback(() => {
    const conn = connIdRef.current;
    const sftp = sftpRef.current;
    connIdRef.current = "";
    sftpRef.current = null;
    if (sftp) void api.sshSftpClose(sftp).catch(() => undefined);
    if (conn) void api.sshDisconnect(conn).catch(() => undefined);
  }, []);

  const connect = useCallback(async () => {
    const t = targetRef.current;
    teardown();
    setSftpId(null);
    if (!t) { setStatus("idle"); return; }
    const connId = crypto.randomUUID();
    connIdRef.current = connId;
    setStatus("connecting");
    setError(null);
    // 提問事件要在 invoke 之前就掛上：對話框可能在 sshConnect 回來前就需要回答。
    const unHost = await onSshHostKeyPrompt(connId, setHostKey);
    const unAuth = await onSshAuthPrompt(connId, setAuthPrompt);
    try {
      await api.sshConnect(connId, t);
      if (connIdRef.current !== connId) { void api.sshDisconnect(connId).catch(() => undefined); return; }
      const opened = await api.sshSftpOpen(connId);
      if (connIdRef.current !== connId) {
        void api.sshSftpClose(opened.sftp_id).catch(() => undefined);
        void api.sshDisconnect(connId).catch(() => undefined);
        return;
      }
      sftpRef.current = opened.sftp_id;
      setSftpId(opened.sftp_id);
      setHome(opened.home);
      setStatus("connected");
    } catch (e) {
      if (connIdRef.current !== connId) return;
      if (errCode(e) === "ERR_SSH_CANCELLED") setStatus("cancelled");
      else { setStatus("error"); setError(errMsg(e)); }
    } finally {
      unHost();
      unAuth();
      setAuthPrompt(null);
      setHostKey(null);
    }
  }, [teardown]);

  useEffect(() => {
    void connect();
    return teardown;
    // targetKey：同一台主機的 target 物件每次 render 都是新的，只在內容變了才重連。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const cancel = useCallback(() => {
    const id = connIdRef.current;
    connIdRef.current = "";
    setStatus("cancelled");
    if (id) void api.sshDisconnect(id).catch(() => undefined);
  }, []);

  const prompts = (
    <>
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
    </>
  );

  return { status, sftpId, home, error, reconnect: () => void connect(), cancel, prompts };
}
