import { useEffect, useState } from "react";
import { Activity, RefreshCw, X } from "lucide-react";
import { api, type KafkaHealthReport } from "./api";
import { useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

type Tab = "risk" | "charts" | "alerts";

// 監控與告警面板（連線右鍵 overlay）。與叢集總覽分工：總覽=靜態資訊，本面板=風險/圖表/告警。
export default function KafkaMonitorPanel({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [tab, setTab] = useState<Tab>("risk");

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[960px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Activity} size={14} className="text-emerald-300/90" />
          <span className="font-medium text-sm">{t("監控與告警")} · {connName}</span>
          <div className="ml-4 flex gap-1 text-xs">
            {(["risk", "charts", "alerts"] as Tab[]).map((tb) => (
              <button
                key={tb}
                onClick={() => setTab(tb)}
                className={`px-2.5 py-1 rounded ${tab === tb ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/10"}`}
              >
                {tb === "risk" ? t("風險") : tb === "charts" ? t("圖表") : t("告警")}
              </button>
            ))}
          </div>
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {tab === "risk" && <RiskTab connId={connId} />}
          {tab === "charts" && <div className="p-6 text-fg/30 text-sm">{t("尚未啟用背景取樣（見「圖表」設定）。")}</div>}
          {tab === "alerts" && <div className="p-6 text-fg/30 text-sm">{t("尚未設定告警規則。")}</div>}
        </div>
      </div>
    </div>
  );
}

const SEV_CLS: Record<string, string> = {
  high: "bg-red-500/15 text-red-300",
  medium: "bg-amber-500/15 text-amber-300",
  info: "bg-sky-500/15 text-sky-300",
};

function RiskTab({ connId }: { connId: string }) {
  const t = useT();
  const [report, setReport] = useState<KafkaHealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const scan = () => {
    setBusy(true);
    setErr(null);
    api.kafkaHealthScan(connId)
      .then(setReport)
      .catch((e) => setErr(e?.message ?? String(e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => { scan(); }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sevLabel = (s: string) => (s === "high" ? t("高") : s === "medium" ? t("中") : t("資訊"));

  // 以 kind + value 組出可翻譯的說明（不依賴後端字串）。
  const detailOf = (kind: string, value: number): string => {
    switch (kind) {
      case "rf1": return t("複本因子為 1，broker 故障即遺失資料");
      case "offline": return t("{n} 個分區無 leader（離線）", { n: value });
      case "urp": return t("{n} 個分區未同步複寫（URP）", { n: value });
      case "under_min_isr": return t("{n} 個分區 ISR 低於 min.insync.replicas，可能拒絕寫入", { n: value });
      case "group_lag": return t("消費者群組總 lag {n}", { n: value });
      default: return "";
    }
  };

  return (
    <div className="p-4 text-xs space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={scan}
          disabled={busy}
          className="px-3 py-1 rounded bg-accent/80 hover:bg-accent text-white disabled:opacity-40 inline-flex items-center gap-1"
        >
          <Icon icon={RefreshCw} size={13} /> {t("重新掃描")}
        </button>
        {report && (
          <span className="text-fg/40">
            {t("主題 {topics} · 分區 {partitions}", { topics: report.topics_total, partitions: report.partitions_total })}
          </span>
        )}
      </div>

      {err && <div className="text-red-400 mono break-all">{err}</div>}

      {report && report.items.length === 0 && !err && (
        <div className="py-8 text-center text-emerald-300/80">{t("未發現風險，叢集健康。")}</div>
      )}

      <div className="space-y-1.5">
        {report?.items.map((it, i) => (
          <div key={i} className="flex items-start gap-2 bg-inset rounded px-3 py-2 border border-fg/5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${SEV_CLS[it.severity] ?? SEV_CLS.info}`}>{sevLabel(it.severity)}</span>
            <div className="min-w-0">
              <div className="text-fg/70 mono truncate" title={it.target}>{it.target}</div>
              <div className="text-fg/50">{detailOf(it.kind, it.value)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
