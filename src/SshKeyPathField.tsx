// 私鑰欄位（SSH 主機對話框與資料庫連線的 SSH Tunnel 共用）：檔案路徑，或金鑰庫裡的一把金鑰
// （`keystore:<id>`，顯示成名稱而不是 id）；底下即時顯示檢查結果（格式 / 類型 / 指紋 / 密語 / 憑證）。
import { lazy, Suspense, useEffect, useState, type KeyboardEvent } from "react";
import { FolderOpen, KeyRound } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { Button, Icon, Input } from "./ui/index";
import { pickOpenFile } from "./ui";
import { keyTypeLabel, keystoreId, keystoreRef } from "./sshKeys";
import SshKeyStatus from "./SshKeyStatus";
import type { SshStoredKey } from "./sshTypes";

const SshKeyManager = lazy(() => import("./SshKeyManager"));

export interface SshKeyPathFieldProps {
  value: string;
  onChange: (v: string) => void;
  /** 對話框裡目前填的密語（檢查狀態用；留空 = 只看得出要不要密語）。 */
  passphrase: string;
  /** 指定的憑證路徑（空 = 找私鑰旁邊的 -cert.pub）。 */
  certificatePath?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
}

export default function SshKeyPathField({ value, onChange, passphrase, certificatePath = "", onKeyDown, placeholder }: SshKeyPathFieldProps) {
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [stored, setStored] = useState<SshStoredKey | null | undefined>(undefined);
  const id = keystoreId(value);

  // 金鑰庫的金鑰顯示名稱；管理視窗關掉後重抓一次（可能剛改過名）。
  useEffect(() => {
    if (!id) { setStored(undefined); return; }
    let alive = true;
    api.sshKeysList()
      .then((ks) => { if (alive) setStored(ks.find((k) => k.id === id) ?? null); })
      .catch(() => { if (alive) setStored(null); });
    return () => { alive = false; };
  }, [id, pickerOpen]);

  const browse = async () => {
    const p = await pickOpenFile();
    if (p) onChange(p);
  };

  return (
    <div>
      {id ? (
        <div className="flex gap-2 items-center">
          <div data-testid="ssh-key-chip" className="flex-1 min-w-0 flex items-center gap-2 px-2 h-8 rounded border border-fg/10 bg-inset text-sm">
            <Icon icon={KeyRound} size={13} className="text-accent shrink-0" />
            <span className="truncate">
              {stored ? stored.name : stored === null ? t("金鑰庫裡找不到這把金鑰（可能已刪除）") : t("金鑰庫的金鑰")}
            </span>
            {stored && <span className="text-xs text-fg/45 shrink-0">{keyTypeLabel(stored.algorithm, stored.bits)}</span>}
          </div>
          <Button variant="secondary" icon={KeyRound} className="shrink-0" onClick={() => setPickerOpen(true)}>{t("更換…")}</Button>
          <Button variant="secondary" icon={FolderOpen} className="shrink-0" onClick={() => void browse()}>{t("改用檔案")}</Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
            placeholder={placeholder ?? t("例如 C:\\\\Users\\\\me\\\\.ssh\\\\id_ed25519")} aria-label={t("私鑰檔路徑")} />
          <Button variant="secondary" icon={FolderOpen} onClick={() => void browse()} title={t("瀏覽…")} className="shrink-0">{t("瀏覽")}</Button>
          <Button variant="secondary" icon={KeyRound} onClick={() => setPickerOpen(true)} title={t("從金鑰庫選擇，或匯入 / 產生金鑰")} className="shrink-0">
            {t("金鑰庫…")}
          </Button>
        </div>
      )}
      <SshKeyStatus path={value} passphrase={passphrase} certificatePath={certificatePath} />
      {pickerOpen && (
        <Suspense fallback={null}>
          <SshKeyManager open onClose={() => setPickerOpen(false)} selectedId={id}
            onPick={(k) => { setStored(k); onChange(keystoreRef(k.id)); setPickerOpen(false); }} />
        </Suspense>
      )}
    </div>
  );
}
