import { useEffect, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { Button, Modal } from "./ui/index";
import { api, type UpdateInstallKind, type UpdateProgress } from "./api";
import { TextBlock } from "./MarkdownLite";
import { dismissVersion, useUpdateDialog } from "./updateCheck";
import { useT } from "./i18n";
import { APP_NAME } from "./brand";

// 有新版時的更新對話框：更新內容（Release 說明）+「立即更新」。後端 update_install 從 GitHub Release
// 下載這台電腦用的安裝檔、驗 SHA-256、啟動安裝程式後關閉 App，裝完由安裝程式重新開啟。
// 不支援自動安裝的（macOS / Linux / 開發版 / 免安裝版）只給「前往下載」。

type Phase =
  | { kind: "idle" }
  | { kind: "downloading"; downloaded: number; total: number }
  | { kind: "launching" }
  | { kind: "failed"; message: string };

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1);
}

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export default function UpdateDialog() {
  const t = useT();
  const info = useUpdateDialog((s) => s.info);
  const auto = useUpdateDialog((s) => s.auto);
  const close = useUpdateDialog((s) => s.close);
  // undefined = 還在問後端；null = 不支援自動安裝。
  const [support, setSupport] = useState<UpdateInstallKind | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  useEffect(() => {
    let alive = true;
    api.updateSupport().then((k) => { if (alive) setSupport(k ?? null); }).catch(() => { if (alive) setSupport(null); });
    return () => { alive = false; };
  }, []);
  if (!info) return null;

  const busy = phase.kind === "downloading" || phase.kind === "launching";
  // 下載 / 啟動安裝程式時不能關（關了下載也還在跑，裝的時候 App 會突然關掉）。
  const later = () => {
    if (busy) return;
    if (auto) dismissVersion(info.version);
    close();
  };
  const install = async () => {
    setPhase({ kind: "downloading", downloaded: 0, total: 0 });
    const ch = new Channel<UpdateProgress>();
    ch.onmessage = (p) => setPhase((cur) => (cur.kind === "downloading" ? { kind: "downloading", ...p } : cur));
    try {
      await api.updateInstall(info.version, ch);
      setPhase({ kind: "launching" });
    } catch (e) {
      setPhase({ kind: "failed", message: errText(e) });
    }
  };
  const openPage = () => api.openExternal(info.url).catch(() => {});
  const pct = phase.kind === "downloading" && phase.total > 0 ? Math.min(100, (phase.downloaded / phase.total) * 100) : null;

  return (
    <Modal
      open
      onClose={later}
      title={t("有新版 v{version}", { version: info.version })}
      icon={RefreshCw}
      size="md"
      noMaximize
      dismissOnBackdrop={false}
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={
        <>
          <Button variant="secondary" className="mr-auto" icon={ExternalLink} onClick={openPage}>{t("在 GitHub 查看")}</Button>
          <Button variant="secondary" disabled={busy} onClick={later}>{t("稍後")}</Button>
          {support === null ? (
            <Button variant="primary" icon={Download} onClick={openPage}>{t("前往下載")}</Button>
          ) : (
            <Button variant="primary" icon={Download} data-update-install="" loading={busy} disabled={support === undefined || busy}
              onClick={() => void install()}>
              {phase.kind === "failed" ? t("重試") : t("立即更新")}
            </Button>
          )}
        </>
      }
    >
      <div className="text-sm text-fg/70" data-update-current="">
        {t("目前版本 v{current}，最新版本 v{latest}", { current: __APP_VERSION__, latest: info.version })}
      </div>
      {info.notes?.trim() ? (
        <div className="max-h-[45vh] overflow-auto rounded border border-fg/10 bg-fg/[0.03] px-3 py-2 select-text" data-update-notes="">
          <TextBlock text={info.notes.trim()} />
        </div>
      ) : null}
      {support === null && (
        <div className="text-sm text-fg/60" data-update-manual="">
          {t("這個版本的 {app} 無法自動安裝更新（macOS / Linux 或免安裝版），請下載新版安裝檔。", { app: APP_NAME })}
        </div>
      )}
      {support && phase.kind === "idle" && (
        <div className="text-xs text-fg/50">
          {t("按「立即更新」會下載安裝檔並確認檔案完整，接著關閉 {app} 進行安裝，裝完自動重新開啟。", { app: APP_NAME })}
        </div>
      )}
      {phase.kind === "downloading" && (
        <div className="space-y-1" data-update-progress="">
          <div className="h-1.5 rounded bg-fg/10 overflow-hidden">
            <div className={`h-full bg-accent ${pct === null ? "w-1/3 animate-pulse" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
          <div className="text-xs text-fg/60 tabular-nums">
            {phase.total > 0
              ? t("下載中 {done} / {total} MB", { done: mb(phase.downloaded), total: mb(phase.total) })
              : t("下載中 {done} MB", { done: mb(phase.downloaded) })}
          </div>
        </div>
      )}
      {phase.kind === "launching" && (
        <div className="text-sm text-success" data-update-launching="">
          {t("已啟動安裝程式：{app} 即將關閉，更新完成後會自動重新開啟。", { app: APP_NAME })}
        </div>
      )}
      {phase.kind === "failed" && <div className="text-sm text-danger break-words" data-update-error="">{phase.message}</div>}
    </Modal>
  );
}
