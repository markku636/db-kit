import { useEffect, useState } from "react";
import { KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { Modal, Field, Input, Button } from "./ui/index";
import { useT } from "./i18n";
import type { SshAuthPrompt, SshHostKeyDecision, SshHostKeyPrompt } from "./sshTypes";

// SSH 連線期間由後端事件觸發的兩種提問（ssh-auth-prompt / ssh-hostkey-prompt）。
// 終端機分頁與主機對話框的「測試連線」都會用到；答案由呼叫端經 api.sshAuthAnswer / sshHostkeyAnswer
// 回給後端（這裡只收 onReply / onCancel），元件本身不碰 invoke，verify-ui 假後端下也能單獨渲染。
// z-[110]：得壓在主機對話框（z-50）與一般對話框（z-[100]）之上；後端等答案時 russh 事件迴圈是擋住的，
// 所以不允許點背板關閉——關掉等於取消連線，要走明確的按鈕。

const PROMPT_Z = "z-[110]";

export interface SshAuthPromptDialogProps {
  prompt: SshAuthPrompt;
  onReply: (answers: string[]) => void;
  /** 使用者取消（Esc / 取消鈕）：呼叫端應回 answers=null，連線會以 SshCancelled 結束。 */
  onCancel: () => void;
}

/** 密碼 / 私鑰密語 / keyboard-interactive 提問。每個 prompts[i] 一個輸入欄；echo=false 用密碼欄；Enter 送出。 */
export function SshAuthPromptDialog({ prompt, onReply, onCancel }: SshAuthPromptDialogProps) {
  const t = useT();
  const [answers, setAnswers] = useState<string[]>(() => prompt.prompts.map(() => ""));
  // 同一條連線可能連問好幾輪（KI 的密碼接 OTP）：換了 prompt 就清空欄位，別把上一輪的答案帶過去。
  useEffect(() => {
    setAnswers(prompt.prompts.map(() => ""));
  }, [prompt]);

  const title =
    prompt.kind === "password" ? t("密碼") : prompt.kind === "passphrase" ? t("私鑰密語") : t("鍵盤互動認證");
  const fallbackLabel = prompt.kind === "passphrase" ? t("私鑰密語") : prompt.kind === "password" ? t("密碼") : t("回應");
  const name = prompt.name?.trim() ?? "";
  const instructions = prompt.instructions?.trim() ?? "";

  const submit = () => onReply(prompt.prompts.map((_, i) => answers[i] ?? ""));
  const setAt = (i: number, v: string) =>
    setAnswers((prev) => {
      const next = prev.slice();
      next[i] = v;
      return next;
    });

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      icon={KeyRound}
      size="sm"
      zClass={PROMPT_Z}
      noMaximize
      dismissOnBackdrop={false}
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit}>{t("確定")}</Button>
        </>
      }
    >
      {name && <div className="text-sm font-medium break-words">{name}</div>}
      {instructions && <div className="text-sm text-fg/70 whitespace-pre-wrap break-words">{instructions}</div>}
      {prompt.prompts.length === 0 ? (
        <div className="text-sm text-fg/60">{t("伺服器沒有要求輸入，按「確定」繼續。")}</div>
      ) : (
        prompt.prompts.map((p, i) => (
          <Field key={i} label={p.prompt.replace(/[:：]\s*$/, "").trim() || fallbackLabel}>
            <Input
              type={p.echo ? "text" : "password"}
              autoFocus={i === 0}
              autoComplete="off"
              spellCheck={false}
              value={answers[i] ?? ""}
              onChange={(e) => setAt(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </Field>
        ))
      )}
    </Modal>
  );
}

export interface SshHostKeyDialogProps {
  info: SshHostKeyPrompt;
  onReply: (decision: SshHostKeyDecision) => void;
}

/**
 * 主機金鑰確認。new = 首次連線（TOFU，預設鈕「接受並儲存」）；
 * changed = 指紋與 ssh_known_hosts.json 不符 → danger 樣式、列出新舊指紋，「接受並更新」用危險色。
 * Esc / 關閉 = 拒絕。
 */
export function SshHostKeyDialog({ info, onReply }: SshHostKeyDialogProps) {
  const t = useT();
  const changed = info.status === "changed";
  const host = info.host_id;
  return (
    <Modal
      open
      onClose={() => onReply("reject")}
      title={changed ? t("主機金鑰已變更") : t("首次連線")}
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
            {t("{host} 的主機金鑰已變更！可能遭到中間人攻擊", { host })}
          </div>
          <div className="text-sm text-fg/70">
            {t("若這台主機最近重裝或更換過金鑰，這是正常的；否則請先向管理者確認，不要接受。")}
          </div>
          <FingerprintRow label={t("舊指紋")} value={info.old_fingerprint || t("（未知）")} />
          <FingerprintRow label={t("新指紋")} value={`${info.key_type} ${info.fingerprint}`} />
        </>
      ) : (
        <>
          <div className="text-sm break-words">{t("首次連線到 {host}，指紋：{fp}", { host, fp: info.fingerprint })}</div>
          <FingerprintRow label={t("金鑰類型")} value={info.key_type} />
          <div className="text-xs text-fg/50">
            {t("請與主機管理者核對指紋後再接受。「接受並儲存」會記住這把金鑰，之後指紋變更時會警告。")}
          </div>
        </>
      )}
    </Modal>
  );
}

function FingerprintRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-xs flex gap-2 items-baseline">
      <span className="text-fg/50 shrink-0">{label}</span>
      <code className="mono break-all select-text text-fg/90">{value}</code>
    </div>
  );
}
