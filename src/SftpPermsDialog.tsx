// SFTP「權限」對話框（Xftp 內容頁的 chmod）：3×3 勾選格與八進位輸入互相同步。
// 只改權限位元；擁有者 / 群組 / 時間不動（後端只送 permissions 一個屬性）。
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { api } from "./api";
import type { SftpEntry } from "./sshTypes";
import { useT } from "./i18n";
import { Button, Field, Input, Modal } from "./ui/index";
import { toast } from "./ui";
import { defaultMode, hasPerm, parseOctal, toOctal, togglePerm, type PermWhat, type PermWho } from "./sftpText";

export interface SftpPermsDialogProps {
  sftpId: string;
  entry: SftpEntry;
  onClose: () => void;
  onChanged: (e: SftpEntry) => void;
}

const WHO: PermWho[] = ["owner", "group", "other"];
const WHAT: PermWhat[] = ["r", "w", "x"];

export default function SftpPermsDialog({ sftpId, entry, onClose, onChanged }: SftpPermsDialogProps) {
  const t = useT();
  const initial = defaultMode(entry.permissions, entry.is_dir);
  const [mode, setMode] = useState(initial);
  const [octal, setOctal] = useState(toOctal(initial));
  const [saving, setSaving] = useState(false);
  const octalValid = parseOctal(octal) != null;

  const whoLabel: Record<PermWho, string> = { owner: t("擁有者"), group: t("群組"), other: t("其他人") };
  const whatLabel: Record<PermWhat, string> = { r: t("讀取"), w: t("寫入"), x: entry.is_dir ? t("進入") : t("執行") };

  const toggle = (who: PermWho, what: PermWhat) => {
    const next = togglePerm(mode, who, what);
    setMode(next);
    setOctal(toOctal(next));
  };
  const onOctal = (v: string) => {
    setOctal(v);
    const n = parseOctal(v);
    if (n != null) setMode(n);
  };

  const apply = async () => {
    const n = parseOctal(octal);
    if (n == null || saving) return;
    setSaving(true);
    try {
      const st = await api.sshSftpChmod(sftpId, entry.path, n);
      toast.success(t("已變更「{name}」的權限為 {mode}", { name: entry.name, mode: toOctal(n) }));
      onChanged(st);
      onClose();
    } catch (e) {
      toast.error(t("變更權限失敗：{msg}", { msg: e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("權限：{name}", { name: entry.name })}
      icon={KeyRound}
      size="sm"
      noMaximize
      zClass="z-[110]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" loading={saving} disabled={!octalValid || (mode & 0o7777) === initial} onClick={() => void apply()}>{t("套用")}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm" data-testid="sftp-perms">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-xs text-fg/45">
              <th className="text-left font-normal pb-1" />
              {WHAT.map((w) => <th key={w} className="font-normal pb-1">{whatLabel[w]}</th>)}
            </tr>
          </thead>
          <tbody>
            {WHO.map((who) => (
              <tr key={who}>
                <td className="py-1 text-fg/70">{whoLabel[who]}</td>
                {WHAT.map((what) => (
                  <td key={what} className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`${whoLabel[who]} ${whatLabel[what]}`}
                      checked={hasPerm(mode, who, what)}
                      onChange={() => toggle(who, what)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <Field label={t("八進位")} hint={t("3～4 位數，例如 644、0755；第一位可含 setuid / setgid / sticky")} error={octalValid ? undefined : t("請輸入 3～4 位 0～7 的數字")}>
          <Input
            value={octal}
            onChange={(e) => onOctal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void apply(); } }}
            className="mono w-28"
            aria-label={t("八進位")}
          />
        </Field>
        <div className="text-xs text-fg/45">
          {t("目前：{mode}", { mode: entry.mode })}{entry.owner || entry.uid != null ? ` · ${entry.owner ?? entry.uid}${entry.group || entry.gid != null ? `:${entry.group ?? entry.gid}` : ""}` : ""}
        </div>
      </div>
    </Modal>
  );
}
