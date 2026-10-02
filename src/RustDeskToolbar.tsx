// RustDesk 連線的工具列（照官方用戶端的工具列）：切換螢幕、「顯示」選單（檢視方式 / 畫質 / 編碼 / 連線品質 /
// 剪貼簿 / 結束後鎖定）、「動作」選單（Ctrl+Alt+Del / 鎖定畫面 / 封鎖輸入 / 重新啟動 / 重新整理）、聊天、錄影。
// 依對方給的權限與對方的系統決定哪些項目出現（跟官方一樣：例如封鎖輸入只有 Windows 對方才有）。
import { useState, type ReactNode, type RefObject } from "react";
import { Check, Circle, MessageSquare, MonitorCog, Square, Zap } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { Icon, IconButton, MenuPanel } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import RdMonitorBar from "./RdMonitorBar";
import type { RdViewHandle } from "./rdView";
import { canRestart, isWindowsPeer, type RdCodecPref, type RdQuality, type RustDeskPrefs, type RustDeskState } from "./rustdeskState";

function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-2 pb-1 text-[11px] text-fg/40 select-none">{children}</div>;
}

function MenuSep() {
  return <div className="my-1 border-t border-fg/10" />;
}

/** 單選 / 勾選項：左邊一格放勾。 */
function MenuOption({ checked, onClick, children, disabled, testid, role = "menuitemradio" }: {
  checked: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  testid?: string;
  role?: "menuitemradio" | "menuitemcheckbox";
}) {
  return (
    <button type="button" role={role} aria-checked={checked} disabled={disabled} data-rd-opt={testid} onClick={onClick}
      className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80 disabled:opacity-40 disabled:pointer-events-none">
      <span className="w-3.5 shrink-0 text-accent">{checked && <Icon icon={Check} size={13} />}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

function MenuAction({ onClick, children, testid, danger }: { onClick: () => void; children: ReactNode; testid?: string; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" data-rd-action={testid} onClick={onClick}
      className={`block w-full text-left pl-8 pr-3 py-1.5 hover:bg-fg/10 truncate ${danger ? "text-danger" : "text-fg/80"}`}>
      {children}
    </button>
  );
}

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
  /** 主機名稱（錄影檔名用）。 */
  hostName: string;
}

export default function RustDeskToolbar({ state, prefs, onPrefs, clipboard, onClipboard, viewOnly, view, chatOpen, unread, onChat, hostName }: RustDeskToolbarProps) {
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
            {(control || canRestart(state)) && <MenuSep />}
            <MenuAction testid="refresh" onClick={() => act("refresh")}>{t("重新整理畫面")}</MenuAction>
            {state.lastRecording && <MenuAction testid="reveal_recording" onClick={revealRecording}>{t("開啟錄影資料夾")}</MenuAction>}
          </div>
        </MenuPanel>
      )}
    </>
  );
}
