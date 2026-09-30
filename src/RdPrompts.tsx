import { useEffect, useState } from "react";
import { KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { Modal, Field, Input, Button } from "./ui/index";
import { useT } from "./i18n";
import type { RdAuthAnswer, RdAuthPrompt, RdCertDecision, RdCertPrompt } from "./rdTypes";

// 遠端桌面連線期間的兩種提問（rd-auth-prompt / rd-cert-prompt）。同 SshPrompts：元件只收 onReply / onCancel，
// 不碰 invoke；z 值壓在一般對話框之上、不允許點背板關閉（關掉等於取消連線）。

const PROMPT_Z = "z-[110]";

export interface RdAuthPromptDialogProps {
  prompt: RdAuthPrompt;
  /** 已存主機才顯示「記住密碼」。 */
  canRemember: boolean;
  onReply: (a: RdAuthAnswer) => void;
  onCancel: () => void;
}

/** 帳號 / 密碼。`need_username` 時多一格帳號（RDP 沒存帳號、macOS 螢幕共享的 ARD 認證）。 */
export function RdAuthPromptDialog({ prompt, canRemember, onReply, onCancel }: RdAuthPromptDialogProps) {
  const t = useT();
  const [username, setUsername] = useState(prompt.username);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    setUsername(prompt.username);
    setPassword("");
  }, [prompt]);

  const submit = () => onReply({ username: username.trim(), password, remember: canRemember && remember });
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={t("遠端桌面登入")}
      icon={KeyRound}
      size="sm"
      zClass={PROMPT_Z}
      noMaximize
      dismissOnBackdrop={false}
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit}>{t("連線")}</Button>
        </>
      }
    >
      {prompt.error && <div className="text-sm text-danger break-words" data-rd-auth-error="">{prompt.error}</div>}
      {prompt.need_username && (
        <Field label={t("帳號")} hint={t("RDP 網域帳號可寫成 DOMAIN\\user")}>
          <Input autoFocus autoComplete="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={onEnter} />
        </Field>
      )}
      <Field label={t("密碼")}>
        <Input
          type="password"
          autoFocus={!prompt.need_username}
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={onEnter}
        />
      </Field>
      {canRemember && (
        <label className="flex items-center gap-2 text-sm text-fg/70 select-none">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t("記住密碼（存在系統鑰匙圈）")}
        </label>
      )}
    </Modal>
  );
}

export interface RdCertDialogProps {
  info: RdCertPrompt;
  onReply: (d: RdCertDecision) => void;
}

/**
 * RDP 伺服器憑證確認（TOFU）。Windows 的 RDP 憑證幾乎都是自簽，所以不走 CA 驗證，改成像 SSH host key 一樣
 * 第一次問、之後比對。changed = 指紋變了 → danger 樣式、列出新舊指紋。Esc / 關閉 = 拒絕。
 */
export function RdCertDialog({ info, onReply }: RdCertDialogProps) {
  const t = useT();
  const changed = info.status === "changed";
  const host = info.host_id;
  return (
    <Modal
      open
      onClose={() => onReply("reject")}
      title={changed ? t("遠端桌面憑證已變更") : t("首次連線")}
      icon={changed ? ShieldAlert : ShieldCheck}
      danger={changed}
      size="md"
      zClass={PROMPT_Z}
      noMaximize
      dismissOnBackdrop={false}
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={
        <>
          <Button variant="secondary" className="mr-auto" onClick={() => onReply("reject")}>{t("拒絕")}</Button>
          <Button variant="secondary" onClick={() => onReply("accept_once")}>{t("僅此次")}</Button>
          <Button variant={changed ? "dangerSolid" : "primary"} autoFocus={!changed} onClick={() => onReply("accept_save")}>
            {changed ? t("接受並更新") : t("接受並儲存")}
          </Button>
        </>
      }
    >
      {changed ? (
        <>
          <div className="text-sm font-medium text-danger break-words">
            {t("{host} 的憑證已變更！可能遭到中間人攻擊", { host })}
          </div>
          <div className="text-sm text-fg/70">
            {t("若這台主機最近重裝或更換過憑證，這是正常的；否則請先向管理者確認，不要接受。")}
          </div>
          <Row label={t("舊指紋")} value={info.old_fingerprint || t("（未知）")} />
          <Row label={t("新指紋")} value={info.fingerprint} />
        </>
      ) : (
        <>
          <div className="text-sm break-words">{t("首次連線到 {host}，伺服器憑證指紋：", { host })}</div>
          <Row label={t("指紋")} value={info.fingerprint} />
        </>
      )}
      {info.subject && <Row label={t("主體")} value={info.subject} />}
      {!changed && (
        <div className="text-xs text-fg/50">
          {t("遠端桌面多半使用自簽憑證。「接受並儲存」會記住這張憑證，之後憑證變更時會警告。")}
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-xs flex gap-2 items-baseline">
      <span className="text-fg/50 shrink-0">{label}</span>
      <code className="mono break-all select-text text-fg/90">{value}</code>
    </div>
  );
}
