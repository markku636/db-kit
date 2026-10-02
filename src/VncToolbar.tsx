// VNC 連線的工具列：「顯示設定」選單（檢視方式 / 畫質 / 只看不控制 / 同步剪貼簿 / 游標點）、「動作」選單
// （Ctrl+Alt+Del / 重新整理畫面 / 電源 / 開啟截圖或錄影資料夾）、截圖、錄影。
// 顯示設定改了就存回已存主機（下次連同一台照舊）；電源只在伺服器支援 XVP 時出現（QEMU / Proxmox 這類虛擬機主控台）。
import { useState, type RefObject } from "react";
import { Camera, Circle, MonitorCog, Square, Zap } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { IconButton, MenuPanel } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import { MenuAction, MenuHeading, MenuOption, MenuSep } from "./RdMenu";
import type { RdViewHandle } from "./rdView";
import type { RdResizeMode } from "./rdTypes";
import type { VncState } from "./VncView";
import type { VncPrefs, VncQuality } from "./vncPrefs";

export interface VncToolbarProps {
  state: VncState;
  prefs: VncPrefs;
  onPrefs: (p: VncPrefs) => void;
  view: RefObject<RdViewHandle | null>;
  /** 主機名稱（截圖 / 錄影檔名用）。 */
  hostName: string;
  /** 使用者叫對方關機了：接下來的斷線不自動重連。 */
  onShutdown: () => void;
}

const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e);

export default function VncToolbar({ state, prefs, onPrefs, view, hostName, onShutdown }: VncToolbarProps) {
  const t = useT();
  const [menu, setMenu] = useState<{ which: "display" | "actions"; x: number; y: number } | null>(null);
  const open = (which: "display" | "actions") => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ which, x: r.left, y: r.bottom + 4 });
  };
  const close = () => setMenu(null);
  const set = (patch: Partial<VncPrefs>) => {
    onPrefs({ ...prefs, ...patch });
    close();
    view.current?.focus();
  };

  const [busy, setBusy] = useState<"shot" | "rec" | null>(null);
  const screenshot = async () => {
    if (busy) return;
    setBusy("shot");
    try {
      const path = await view.current?.screenshot?.(hostName);
      if (path) toast.success(t("截圖已存到 {path}", { path }));
    } catch (e) {
      toast.error(t("截圖存檔失敗：{e}", { e: errText(e) }));
    } finally {
      setBusy(null);
      view.current?.focus();
    }
  };
  const toggleRecording = async () => {
    if (busy) return;
    setBusy("rec");
    try {
      if (state.recording) await view.current?.stopRecording?.();
      else await view.current?.startRecording?.(hostName);
    } finally {
      setBusy(null);
      view.current?.focus();
    }
  };
  const reveal = (path: string) => {
    close();
    void api.rdRecordReveal(path).catch((e) => toast.error(errText(e)));
  };

  const power = async (op: "shutdown" | "reboot" | "reset") => {
    close();
    const text = {
      shutdown: [t("要讓這台機器關機嗎？連線會中斷。"), t("關機"), t("關機")],
      reboot: [t("要讓這台機器重新開機嗎？連線會中斷。"), t("重新開機"), t("重新開機")],
      reset: [t("要強制重設這台機器嗎？就像按下實體的重設鍵，還沒存的資料會不見。"), t("強制重設"), t("強制重設")],
    }[op];
    const ok = await uiConfirm(text[0], { title: text[1], danger: true, confirmText: text[2] });
    if (ok) {
      if (op === "shutdown") onShutdown();
      view.current?.power?.(op);
    }
    view.current?.focus();
  };

  const views: { id: RdResizeMode; label: string }[] = [
    { id: "scale", label: t("縮放到分頁大小") },
    { id: "remote", label: t("遠端跟著調整解析度") },
    { id: "none", label: t("原始大小（捲動）") },
  ];
  const qualities: { id: VncQuality; label: string }[] = [
    { id: "best", label: t("最佳畫質") },
    { id: "balanced", label: t("平衡") },
    { id: "low", label: t("最佳反應速度") },
  ];
  const control = !prefs.viewOnly;

  return (
    <>
      <IconButton icon={MonitorCog} label={t("顯示設定")} data-rd-menu="display" active={menu?.which === "display"} onClick={open("display")} />
      <IconButton icon={Zap} label={t("動作")} data-rd-menu="actions" active={menu?.which === "actions"} onClick={open("actions")} />
      <IconButton icon={Camera} label={t("截圖（存到「圖片 / db-kit」）")} data-rd-screenshot="" disabled={busy === "shot"}
        onClick={() => void screenshot()} />
      <IconButton icon={state.recording ? Square : Circle} data-rd-record={state.recording ? "on" : "off"} disabled={busy === "rec"}
        label={state.recording ? t("停止錄影") : t("開始錄影（存到「影片 / db-kit」）")}
        active={state.recording} className={state.recording ? "!text-danger animate-pulse" : ""}
        onClick={() => void toggleRecording()} />

      {menu?.which === "display" && (
        <MenuPanel x={menu.x} y={menu.y} minW={220} onClose={close}>
          <div role="menu" aria-label={t("顯示設定")} data-rd-display-menu="">
            <MenuHeading>{t("檢視方式")}</MenuHeading>
            {views.map((v) => (
              <MenuOption key={v.id} checked={prefs.view === v.id} testid={`view-${v.id}`} onClick={() => set({ view: v.id })}>{v.label}</MenuOption>
            ))}
            <MenuSep />
            <MenuHeading>{t("畫質（伺服器支援 Tight / JPEG 編碼時）")}</MenuHeading>
            {qualities.map((q) => (
              <MenuOption key={q.id} checked={prefs.quality === q.id} testid={`quality-${q.id}`} onClick={() => set({ quality: q.id })}>{q.label}</MenuOption>
            ))}
            <MenuSep />
            <MenuOption role="menuitemcheckbox" checked={prefs.viewOnly} testid="view-only" onClick={() => set({ viewOnly: !prefs.viewOnly })}>
              {t("只看不控制")}
            </MenuOption>
            <MenuOption role="menuitemcheckbox" checked={prefs.clipboard && control} disabled={!control} testid="clipboard"
              onClick={() => set({ clipboard: !prefs.clipboard })}>{t("同步剪貼簿")}</MenuOption>
            <MenuOption role="menuitemcheckbox" checked={prefs.dotCursor} testid="dot-cursor" onClick={() => set({ dotCursor: !prefs.dotCursor })}>
              {t("遠端沒有游標時顯示一個點")}
            </MenuOption>
          </div>
        </MenuPanel>
      )}

      {menu?.which === "actions" && (
        <MenuPanel x={menu.x} y={menu.y} minW={220} onClose={close}>
          <div role="menu" aria-label={t("動作")} data-rd-actions-menu="">
            {control && (
              <MenuAction testid="ctrl_alt_del" onClick={() => { close(); view.current?.combo("ctrl_alt_del"); view.current?.focus(); }}>
                {t("送出 Ctrl+Alt+Del")}
              </MenuAction>
            )}
            <MenuAction testid="refresh" onClick={() => { close(); view.current?.refresh(); view.current?.focus(); }}>{t("重新整理畫面")}</MenuAction>
            {state.power && control && (
              <>
                <MenuSep />
                <MenuHeading>{t("電源")}</MenuHeading>
                <MenuAction testid="power_reboot" danger onClick={() => void power("reboot")}>{t("重新開機…")}</MenuAction>
                <MenuAction testid="power_shutdown" danger onClick={() => void power("shutdown")}>{t("關機…")}</MenuAction>
                <MenuAction testid="power_reset" danger onClick={() => void power("reset")}>{t("強制重設…")}</MenuAction>
              </>
            )}
            {(state.lastShot || state.lastRecording) && <MenuSep />}
            {state.lastShot && <MenuAction testid="reveal_shot" onClick={() => reveal(state.lastShot!)}>{t("開啟截圖資料夾")}</MenuAction>}
            {state.lastRecording && (
              <MenuAction testid="reveal_recording" onClick={() => reveal(state.lastRecording!)}>{t("開啟錄影資料夾")}</MenuAction>
            )}
          </div>
        </MenuPanel>
      )}
    </>
  );
}
