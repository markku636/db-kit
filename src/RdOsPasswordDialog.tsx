// RustDesk「輸入作業系統密碼」的對話框（照官方工具列的 OS Password：對方停在登入 / 鎖定畫面時，一鍵把密碼打進去）。
// - input：問密碼 → 打過去；已存主機可勾「記住」，之後直接打、不再問。
// - set：改 / 清除這台主機存的密碼（存在系統鑰匙圈，不寫進設定檔）。
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button, Field, Input, Modal } from "./ui/index";
import { useT } from "./i18n";

export interface RdOsPasswordDialogProps {
  mode: "input" | "set";
  /** 已存主機（可以記住密碼）。 */
  canRemember: boolean;
  /** 這台主機已經存了一組。 */
  hasStored: boolean;
  onSubmit: (password: string, remember: boolean) => void;
  onClear?: () => void;
  onClose: () => void;
}

export default function RdOsPasswordDialog({ mode, canRemember, hasStored, onSubmit, onClear, onClose }: RdOsPasswordDialogProps) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const ready = password.length > 0;
  const submit = () => { if (ready) onSubmit(password, mode === "set" || (canRemember && remember)); };
  return (
    <Modal
      open
      onClose={onClose}
      title={mode === "set" ? t("作業系統密碼") : t("輸入作業系統密碼")}
      icon={KeyRound}
      size="sm"
      noMaximize
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={
        <>
          {mode === "set" && hasStored && onClear && (
            <Button variant="secondary" className="mr-auto text-danger" onClick={onClear} data-rd-os-clear="">{t("清除已存的密碼")}</Button>
          )}
          <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={!ready} data-rd-os-submit="">{mode === "set" ? t("儲存") : t("輸入")}</Button>
        </>
      }
    >
      <div className="text-sm text-fg/70 break-words">
        {mode === "set"
          ? t("對方電腦（Windows / Ubuntu…）登入用的密碼，不是 RustDesk 的連線密碼。存在這台電腦的系統鑰匙圈。")
          : t("會先點一下對方畫面叫出密碼框，再把密碼打過去並按 Enter。對方停在登入或鎖定畫面時使用。")}
      </div>
      <Field label={t("作業系統密碼")}>
        <Input
          type="password"
          autoFocus
          autoComplete="off"
          data-rd-os-password=""
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        />
      </Field>
      {mode === "input" && canRemember && (
        <label className="flex items-center gap-2 text-sm text-fg/70 select-none">
          <input type="checkbox" data-rd-os-remember="" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t("記住這台主機的作業系統密碼（存在系統鑰匙圈）")}
        </label>
      )}
    </Modal>
  );
}
