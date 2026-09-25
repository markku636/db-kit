// 私鑰欄位下的一行檢查結果（Xshell 選好金鑰時顯示的摘要）：格式 · 類型 · 指紋、要不要密語、
// 私鑰旁邊（或指定路徑）的 OpenSSH 憑證。解密很吃 CPU：輸入停下 350 ms 才問後端。
import { useEffect, useState } from "react";
import { BadgeCheck, CircleAlert, KeyRound, Lock } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { Icon, Spinner } from "./ui/index";
import { certForever, certTone, keyTypeLabel, shortFingerprint } from "./sshKeys";
import type { SshCertInfo, SshKeyInspect } from "./sshTypes";

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function CertLine({ cert }: { cert: SshCertInfo }) {
  const t = useT();
  const tone = certTone(cert, Math.floor(Date.now() / 1000));
  const who = cert.principals.length ? cert.principals.join(", ") : t("（不限主體）");
  const until = certForever(cert.valid_before)
    ? t("永久有效")
    : t("到 {date}", { date: new Date(cert.valid_before * 1000).toLocaleString(undefined, { hour12: false }) });
  const problem =
    cert.matches_key === false ? t("這張憑證簽的不是這把金鑰")
      : cert.validity === "expired" ? t("憑證已過期")
      : cert.validity === "not_yet_valid" ? t("憑證尚未生效")
      : null;
  return (
    <div className={`flex items-center gap-1.5 ${tone === "bad" ? "text-danger" : tone === "warn" ? "text-warning" : "text-fg/55"}`}
      title={`${cert.path}\nKey ID: ${cert.key_id}\nCA: ${cert.ca_fingerprint}`}>
      <Icon icon={BadgeCheck} size={12} className="shrink-0" />
      <span className="truncate">
        {t("OpenSSH 憑證")}：{who} · {until}{problem ? ` · ${problem}` : ""}
      </span>
    </div>
  );
}

export default function SshKeyStatus({ path, passphrase, certificatePath = "" }: { path: string; passphrase: string; certificatePath?: string }) {
  // 結果連同它檢查的是哪個路徑一起記：換了檔案（或改選金鑰庫的金鑰）就不能再顯示上一個檔案的結果；
  // 只改密語 / 憑證路徑時則先留著舊結果，免得每打一個字就閃一下。
  const [res, setRes] = useState<{ path: string; r: SshKeyInspect } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = path.trim();
    if (!p) { setRes(null); return; }
    let alive = true;
    setBusy(true);
    const h = setTimeout(() => {
      api.sshKeyInspect({ kind: "path", path: p }, passphrase || null, certificatePath.trim() || null)
        .then((r) => { if (alive) setRes({ path: p, r }); })
        .catch((e) => { if (alive) setRes({ path: p, r: { status: "invalid", format: null, info: null, message: errMsg(e), cert: null } }); })
        .finally(() => { if (alive) setBusy(false); });
    }, 350);
    return () => { alive = false; clearTimeout(h); };
  }, [path, passphrase, certificatePath]);

  if (!path.trim()) return null;
  const current = res && res.path === path.trim() ? res.r : null;
  return <StatusView res={current} busy={busy} />;
}

function StatusView({ res, busy }: { res: SshKeyInspect | null; busy: boolean }) {
  const t = useT();
  if (!res) {
    return busy ? <div className="flex items-center gap-1.5 text-xs text-fg/45 mt-1"><Spinner size={11} />{t("檢查私鑰…")}</div> : null;
  }
  const info = res.info;
  const summary = info ? `${info.format} · ${keyTypeLabel(info.algorithm, info.bits)} · ${shortFingerprint(info.fingerprint)}` : res.format ?? "";
  return (
    <div data-testid="ssh-key-status" data-status={res.status} className="text-xs mt-1 space-y-0.5">
      {res.status === "ok" && info && (
        <div className="flex items-center gap-1.5 text-fg/60" title={`${info.fingerprint}${info.comment ? `\n${info.comment}` : ""}`}>
          <Icon icon={KeyRound} size={12} className="text-success shrink-0" />
          <span className="truncate">{summary}{info.encrypted ? ` · ${t("受密語保護")}` : ""}</span>
        </div>
      )}
      {res.status === "need_passphrase" && (
        <div className="flex items-center gap-1.5 text-fg/60" title={info?.fingerprint ?? ""}>
          <Icon icon={Lock} size={12} className="text-warning shrink-0" />
          <span className="truncate">{t("受密語保護")}{summary ? ` · ${summary}` : ""}</span>
        </div>
      )}
      {(res.status === "bad_passphrase" || res.status === "unsupported" || res.status === "invalid") && (
        <div className="flex items-start gap-1.5 text-danger">
          <Icon icon={CircleAlert} size={12} className="shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap break-words">{res.message ?? t("無法使用這把私鑰")}</span>
        </div>
      )}
      {res.cert && <CertLine cert={res.cert} />}
    </div>
  );
}
