// RustDesk 連線的工具列（照官方用戶端的工具列）：切換螢幕、「顯示」選單（檢視方式 / 畫質 / 編碼 / 連線品質 /
// 剪貼簿 / 結束後鎖定 / 鍵盤模式）、「動作」選單（Ctrl+Alt+Del / 鎖定畫面 / 封鎖輸入 / 重新啟動 / 輸入作業系統密碼 /
// 重新整理）、檔案傳輸、聊天、錄影。依對方給的權限與對方的系統決定哪些項目出現（跟官方一樣：例如封鎖輸入只有 Windows 對方才有）。
import { useEffect, useState, type RefObject } from "react";
import { Circle, FolderSync, MessageSquare, MonitorCog, Square, Zap } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { IconButton, MenuPanel } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import { MenuAction, MenuHeading, MenuOption, MenuSep } from "./RdMenu";
import RdMonitorBar from "./RdMonitorBar";
import RdOsPasswordDialog from "./RdOsPasswordDialog";
import type { RdViewHandle } from "./rdView";
import { canRestart, isWindowsPeer, type RdCodecPref, type RdQuality, type RustDeskPrefs, type RustDeskState } from "./rustdeskState";

export interface RustDeskToolbarProps {
  state: RustDeskState;
  prefs: RustDeskPrefs;
  onPrefs: (p: RustDeskPrefs) => void;
  /** 主機設定的「同步剪貼簿」。 */
  clipboard: boolean;
  onClipboard: (on: boolean) => void;
  viewOnly: boolean;
  view: RefObject<RdViewHandle | null>;
  chatOpen: boolean;
  unread: number;
  onChat: () => void;
  /** 檔案傳輸面板開著沒。 */
  filesOpen: boolean;
  onFiles: () => void;
  /** 主機名稱（錄影檔名用）。 */
  hostName: string;
  /** 已存主機的 id（作業系統密碼存在它底下）；快速連線 = null（每次問）。 */
  sessionId: string | null;
}

export default function RustDeskToolbar({
  state, prefs, onPrefs, clipboard, onClipboard, viewOnly, view, chatOpen, unread, onChat, hostName, sessionId, filesOpen, onFiles,
}: RustDeskToolbarProps) {
  const t = useT();
  const [menu, setMenu] = useState<{ which: "display" | "actions"; x: number; y: number } | null>(null);
  const open = (which: "display" | "actions") => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ which, x: r.left, y: r.bottom + 4 });
  };
  const close = () => setMenu(null);
  const set = (patch: Partial<RustDeskPrefs>) => {
    onPrefs({ ...prefs, ...patch });
    close();
    view.current?.focus();
  };
  const act = (name: "ctrl_alt_del" | "lock_screen" | "restart" | "refresh") => {
    close();
    view.current?.action?.(name);
  };
  const restart = async () => {
    close();
    const ok = await uiConfirm(t("要重新啟動對方的電腦嗎？連線會中斷，對方開機完成、RustDesk 啟動後才能再連上。"),
      { title: t("重新啟動對方電腦"), danger: true, confirmText: t("重新啟動") });
    if (ok) view.current?.action?.("restart");
    else view.current?.focus();
  };

  const [recBusy, setRecBusy] = useState(false);
  const toggleRecording = async () => {
    if (recBusy) return;
    setRecBusy(true);
    try {
      if (state.recording) await view.current?.stopRecording?.();
      else await view.current?.startRecording?.(hostName);
    } finally {
      setRecBusy(false);
      view.current?.focus();
    }
  };
  const revealRecording = () => {
    close();
    if (state.lastRecording) void api.rdRecordReveal(state.lastRecording).catch((e) => toast.error(String(e?.message ?? e)));
  };

  // ---- 輸入作業系統密碼（官方 OS Password）：有存就直接打，沒存就問 ----
  const [osDialog, setOsDialog] = useState<"input" | "set" | null>(null);
  const [hasOs, setHasOs] = useState(false);
  const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e);
  const sendOsPassword = async (pw?: string) => {
    try {
      await view.current?.inputOsPassword?.(pw);
    } catch (e) {
      toast.error(t("無法輸入作業系統密碼：{e}", { e: errText(e) }));
    }
    view.current?.focus();
  };
  const typeOsPassword = async () => {
    close();
    const stored = sessionId ? await api.rdHasOsPassword(sessionId).catch(() => false) : false;
    setHasOs(stored);
    if (stored) await sendOsPassword();
    else setOsDialog("input");
  };
  /** 存 / 清除（null）這台主機的作業系統密碼；`closeDialog` = 存完把對話框關掉並提示。 */
  const saveOsPassword = async (pw: string | null, closeDialog = true) => {
    if (!sessionId) return;
    try {
      await api.rdOsPasswordSet(sessionId, pw);
      setHasOs(!!pw);
      if (closeDialog) {
        setOsDialog(null);
        toast.success(pw ? t("已記住這台主機的作業系統密碼") : t("已清除這台主機的作業系統密碼"));
        view.current?.focus();
      }
    } catch (e) {
      toast.error(errText(e));
    }
  };
  // 開「設定作業系統密碼」時查一下有沒有存（決定要不要給「清除」）。
  useEffect(() => {
    if (osDialog !== "set" || !sessionId) return;
    let alive = true;
    void api.rdHasOsPassword(sessionId).then((v) => { if (alive) setHasOs(v); }).catch(() => undefined);
    return () => { alive = false; };
  }, [osDialog, sessionId]);

  const p = state.perms;
  const control = !viewOnly && p.keyboard;
  const qualities: { id: RdQuality; label: string }[] = [
    { id: "best", label: t("最佳畫質") },
    { id: "balanced", label: t("平衡") },
    { id: "low", label: t("最佳反應速度") },
  ];
  const codecs: { id: RdCodecPref; label: string; ok: boolean }[] = [
    { id: "auto", label: t("自動"), ok: true },
    { id: "vp9", label: "VP9", ok: state.codecs.vp9 },
    { id: "vp8", label: "VP8", ok: state.codecs.vp8 },
    { id: "av1", label: "AV1", ok: state.codecs.av1 },
  ];

  return (
    <>
      {state.monitors.displays.length > 1 && (
        <RdMonitorBar monitors={state.monitors} onPick={(s) => view.current?.showDisplays?.(s)} />
      )}
      <IconButton icon={MonitorCog} label={t("顯示設定")} data-rd-menu="display" active={menu?.which === "display"} onClick={open("display")} />
      <IconButton icon={Zap} label={t("動作")} data-rd-menu="actions" active={menu?.which === "actions"} onClick={open("actions")} />
      {p.file && (
        <IconButton icon={FolderSync} label={t("檔案傳輸")} data-rd-files-toggle="" active={filesOpen} onClick={onFiles} />
      )}
      <span className="relative inline-flex">
        <IconButton icon={MessageSquare} label={t("聊天")} data-rd-chat-toggle="" active={chatOpen} onClick={onChat} />
        {unread > 0 && !chatOpen && (
          <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-danger text-white text-[10px] leading-[14px] text-center pointer-events-none"
            data-rd-chat-unread={unread}>{unread > 9 ? "9+" : unread}</span>
        )}
      </span>
      {(p.recording || state.recording) && (
        <IconButton icon={state.recording ? Square : Circle} data-rd-record={state.recording ? "on" : "off"} disabled={recBusy}
          label={state.recording ? t("停止錄影") : t("開始錄影（存到「影片 / db-kit」）")}
          active={state.recording} className={state.recording ? "!text-danger animate-pulse" : ""}
          onClick={() => void toggleRecording()} />
      )}

      {menu?.which === "display" && (
        <MenuPanel x={menu.x} y={menu.y} minW={220} onClose={close}>
          <div role="menu" aria-label={t("顯示設定")} data-rd-display-menu="">
            <MenuHeading>{t("檢視方式")}</MenuHeading>
            <MenuOption checked={prefs.view === "adaptive"} testid="view-adaptive" onClick={() => set({ view: "adaptive" })}>{t("適應視窗")}</MenuOption>
            <MenuOption checked={prefs.view === "original"} testid="view-original" onClick={() => set({ view: "original" })}>{t("原始大小")}</MenuOption>
            <MenuSep />
            <MenuHeading>{t("畫質")}</MenuHeading>
            {qualities.map((q) => (
              <MenuOption key={q.id} checked={prefs.quality === q.id} testid={`quality-${q.id}`} onClick={() => set({ quality: q.id })}>{q.label}</MenuOption>
            ))}
            <MenuSep />
            <MenuHeading>{t("編碼")}</MenuHeading>
            {codecs.filter((c) => c.ok).map((c) => (
              <MenuOption key={c.id} checked={prefs.codec === c.id} testid={`codec-${c.id}`} onClick={() => set({ codec: c.id })}>{c.label}</MenuOption>
            ))}
            <MenuSep />
            <MenuOption role="menuitemcheckbox" checked={prefs.stats} testid="stats" onClick={() => set({ stats: !prefs.stats })}>{t("顯示連線品質")}</MenuOption>
            {p.clipboard && (
              <MenuOption role="menuitemcheckbox" checked={clipboard && !viewOnly} disabled={viewOnly} testid="clipboard"
                onClick={() => { onClipboard(!clipboard); close(); view.current?.focus(); }}>{t("同步剪貼簿")}</MenuOption>
            )}
            {p.keyboard && (
              <MenuOption role="menuitemcheckbox" checked={prefs.lockAfterEnd} disabled={viewOnly} testid="lock-after-end"
                onClick={() => set({ lockAfterEnd: !prefs.lockAfterEnd })}>{t("連線結束後鎖定對方畫面")}</MenuOption>
            )}
            {control && (
              <>
                <MenuSep />
                <MenuHeading>{t("鍵盤模式")}</MenuHeading>
                <MenuOption checked={prefs.keyboard === "map"} testid="keyboard-map" onClick={() => set({ keyboard: "map" })}>
                  {t("對應（照按鍵位置，對方用自己的鍵盤配置）")}
                </MenuOption>
                <MenuOption checked={prefs.keyboard === "translate"} testid="keyboard-translate" onClick={() => set({ keyboard: "translate" })}>
                  {t("翻譯（送本機打出的字）")}
                </MenuOption>
              </>
            )}
          </div>
        </MenuPanel>
      )}

      {menu?.which === "actions" && (
        <MenuPanel x={menu.x} y={menu.y} minW={220} onClose={close}>
          <div role="menu" aria-label={t("動作")} data-rd-actions-menu="">
            {control && <MenuAction testid="ctrl_alt_del" onClick={() => act("ctrl_alt_del")}>{t("送出 Ctrl+Alt+Del")}</MenuAction>}
            {control && <MenuAction testid="lock_screen" onClick={() => act("lock_screen")}>{t("鎖定對方畫面")}</MenuAction>}
            {control && p.block_input && isWindowsPeer(state) && (
              <MenuAction testid="block_input" onClick={() => { close(); view.current?.setBlockInput?.(!state.blockInput); }}>
                {state.blockInput ? t("解除封鎖對方的鍵盤滑鼠") : t("封鎖對方的鍵盤滑鼠")}
              </MenuAction>
            )}
            {canRestart(state) && <MenuAction testid="restart" danger onClick={() => void restart()}>{t("重新啟動對方電腦…")}</MenuAction>}
            {control && (
              <>
                <MenuSep />
                <MenuAction testid="os_password" onClick={() => void typeOsPassword()}>{t("輸入作業系統密碼")}</MenuAction>
                {sessionId && <MenuAction testid="os_password_set" onClick={() => { close(); setOsDialog("set"); }}>{t("設定作業系統密碼…")}</MenuAction>}
              </>
            )}
            {(control || canRestart(state)) && <MenuSep />}
            <MenuAction testid="refresh" onClick={() => act("refresh")}>{t("重新整理畫面")}</MenuAction>
            {state.lastRecording && <MenuAction testid="reveal_recording" onClick={revealRecording}>{t("開啟錄影資料夾")}</MenuAction>}
          </div>
        </MenuPanel>
      )}

      {osDialog && (
        <RdOsPasswordDialog mode={osDialog} canRemember={!!sessionId} hasStored={hasOs}
          onClose={() => { setOsDialog(null); view.current?.focus(); }}
          onClear={() => void saveOsPassword(null)}
          onSubmit={(pw, remember) => {
            if (osDialog === "set") { void saveOsPassword(pw); return; }
            setOsDialog(null);
            void (async () => {
              if (remember && sessionId) await saveOsPassword(pw, false);
              await sendOsPassword(pw);
            })();
          }} />
      )}
    </>
  );
}
