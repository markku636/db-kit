// 終端機底部的狀態列：連到哪裡（經哪台跳板機）、終端大小、編碼、連線時間；右邊是「儲存畫面內容」與
// 「記錄工作階段」（記錄中顯示紅點）。
import { useEffect, useState } from "react";
import { Circle, FileDown, Square } from "lucide-react";
import { useT } from "./i18n";
import { IconButton } from "./ui/index";
import { fmtDuration } from "./sshSessionLog";
import type { SshStatus } from "./sshTypes";

export interface SshStatusBarProps {
  label: string;
  jump: string | null;
  size: { cols: number; rows: number } | null;
  status: SshStatus | undefined;
  connectedAt: number | null;
  /** 記錄中的檔案路徑（null = 沒在記錄） */
  recording: string | null;
  onSave: () => void;
  onToggleRecord: () => void;
}

export default function SshStatusBar({ label, jump, size, status, connectedAt, recording, onSave, onToggleRecord }: SshStatusBarProps) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!connectedAt) return;
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [connectedAt]);
  return (
    <div data-testid="ssh-status-bar" className="h-6 shrink-0 flex items-center gap-3 px-2 border-t border-fg/10 bg-panel text-[11px] text-fg/50 mono">
      <span className="truncate" title={label}>{label}</span>
      {jump && <span className="truncate text-fg/40" title={jump}>{t("經 {via}", { via: jump })}</span>}
      {size && <span title={t("終端機大小（欄 × 列）")}>{size.cols}×{size.rows}</span>}
      <span>UTF-8</span>
      {status === "connected" && connectedAt && <span title={t("連線時間")}>{fmtDuration(Math.max(0, now - connectedAt))}</span>}
      <span className="ml-auto flex items-center gap-1">
        {recording && (
          <span className="flex items-center gap-1 text-danger" title={recording}>
            <span className="w-2 h-2 rounded-full bg-danger animate-pulse" />
            {t("記錄中")}
          </span>
        )}
        <IconButton icon={FileDown} label={t("儲存畫面內容…")} box="w-5 h-5" iconSize={12} onClick={onSave} />
        <IconButton icon={recording ? Square : Circle} label={recording ? t("停止記錄") : t("開始記錄工作階段…")} box="w-5 h-5" iconSize={12}
          active={!!recording} onClick={onToggleRecord} />
      </span>
    </div>
  );
}
