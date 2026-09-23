import { useEffect, useState } from "react";
import { Copy, ExternalLink, SquareTerminal } from "lucide-react";
import { api, type AgentProvider, type AgentStatus } from "./api";
import { providerMeta } from "./aiProvider";
import { copyToClipboard, toast } from "./ui";
import Icon from "./ui/Icon";
import { IconButton } from "./ui/index";
import { useT } from "./i18n";

// CLI 供應商（claude / codex）還沒裝或還沒登入時的提示內容：右側助手面板與 NL 查詢列共用。
// 外框（琥珀色底）由宿主決定，這裡只管內容。
//
// 流程：顯示這台機器的官方安裝指令（可複製）→「在終端機安裝」開一個看得見的終端機視窗去跑
// （見 agent_setup.rs）→ 使用者切回 App 時自動重新偵測。裝好但沒登入時同一套換成「在終端機登入」。

interface Props {
  provider: AgentProvider;
  status: AgentStatus;
  detecting: boolean;
  onDetect: () => void | Promise<void>;
}

export default function CliSetupHint({ provider, status, detecting, onDetect }: Props) {
  const t = useT();
  const meta = providerMeta(provider);
  const action = status.installed ? "login" : "install";
  const cmd = status.install_cmd ?? "";
  const [launching, setLaunching] = useState(false);
  // 開過終端機的是哪個動作：裝好之後 action 變成 login，等待狀態自然失效，換顯示登入按鈕。
  const [openedFor, setOpenedFor] = useState<"install" | "login" | null>(null);
  const waiting = openedFor === action;

  // 終端機是另一個視窗：使用者跑完切回 App 就重測一次。裝好 / 登入好了，宿主會把整個提示收掉。
  useEffect(() => {
    if (!waiting) return;
    const onFocus = () => void onDetect();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waiting, onDetect]);

  const openTerminal = async () => {
    setLaunching(true);
    try {
      await api.agentSetupTerminal(provider, action);
      setOpenedFor(action);
    } catch (e) {
      toast.error((e as { message?: string })?.message ?? String(e));
    } finally {
      setLaunching(false);
    }
  };

  const link = "underline hover:text-amber-100 disabled:opacity-50";
  const primary = "inline-flex items-center gap-1 rounded border border-amber-400/40 px-2 py-0.5 " +
    "hover:bg-amber-400/10 disabled:opacity-50 disabled:hover:bg-transparent";

  return (
    <div>
      {action === "install"
        ? t("找不到 {cli} CLI，請先安裝 {name}。", { cli: meta.cli, name: meta.label })
        : t("尚未登入 {name}。請在終端機執行 {cmd} 並用你的訂閱帳號登入。", { name: meta.label, cmd: meta.loginCmd })}

      {action === "install" && cmd && (
        <div className="mt-1.5 flex items-center gap-1 rounded bg-inset border border-fg/10 pl-2 pr-0.5 py-0.5 font-mono text-fg/80">
          <code className="flex-1 min-w-0 truncate select-all" title={cmd}>{cmd}</code>
          <IconButton icon={Copy} label={t("複製指令")} box="w-5 h-5" iconSize={12} onClick={() => void copyToClipboard(cmd)} />
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {(action === "login" || cmd) && (
          <button type="button" onClick={() => void openTerminal()} disabled={launching} className={primary}
            title={action === "install"
              ? t("開一個終端機視窗執行上面這行官方安裝指令")
              : t("開一個終端機視窗執行 {cmd}，照畫面指示用瀏覽器登入", { cmd: meta.loginCmd })}>
            <Icon icon={SquareTerminal} size={12} />
            {action === "install" ? t("在終端機安裝") : t("在終端機登入")}
          </button>
        )}
        {action === "install" && meta.installDocs && (
          <button type="button" onClick={() => api.openExternal(meta.installDocs).catch(() => {})}
            className={`inline-flex items-center gap-0.5 ${link}`}>
            {t("安裝說明")} <Icon icon={ExternalLink} size={10} />
          </button>
        )}
        <button type="button" onClick={() => void onDetect()} disabled={detecting} className={link}>
          {detecting ? t("偵測中…") : t("重新偵測")}
        </button>
      </div>

      {waiting && (
        <div className="mt-1 opacity-80">{t("已開啟終端機視窗。跑完之後切回這裡，會自動重新偵測。")}</div>
      )}
    </div>
  );
}
