import { useEffect, useRef, useState } from "react";
import { Activity, RefreshCw, X } from "lucide-react";
import {
  api,
  onKafkaMetrics,
  type KafkaHealthReport,
  type KafkaMonitorConfig,
  type KafkaSample,
} from "./api";
import { toast, useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import TimeSeriesChart, { type TsPoint } from "./ui/TimeSeriesChart";
import { useT } from "./i18n";
import type { UnlistenFn } from "@tauri-apps/api/event";

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
          {tab === "charts" && <ChartsTab connId={connId} />}
          {tab === "alerts" && <div className="p-6 text-fg/30 text-sm">{t("尚未設定告警規則。")}</div>}
        </div>
      </div>
    </div>
  );
}

const MAX_POINTS = 2880;

function ChartsTab({ connId }: { connId: string }) {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [interval, setIntervalSecs] = useState(30);
  const [topics, setTopics] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [allTopics, setAllTopics] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<string[]>([]);
  const [samples, setSamples] = useState<KafkaSample[]>([]);
  const [windowH, setWindowH] = useState(1);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    api.kafkaMonitorStatus(connId).then((s) => {
      setRunning(s.running);
      if (s.config) {
        setIntervalSecs(s.config.interval_secs || 30);
        setTopics(s.config.topics);
        setGroups(s.config.groups);
      }
    }).catch(() => {});
    api.kafkaMetricsHistory(connId).then(setSamples).catch(() => {});
    api.kafkaTopics(connId).then((ts) => setAllTopics(ts.map((x) => x.name).sort())).catch(() => {});
    api.kafkaConsumerGroups(connId).then((gs) => setAllGroups(gs.map((g) => g.group_id).sort())).catch(() => {});
    onKafkaMetrics(connId, (s) => {
      setSamples((prev) => {
        const next = [...prev, s];
        return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
      });
    }).then((u) => { unlistenRef.current = u; });
    return () => { unlistenRef.current?.(); };
  }, [connId]);

  const applyConfig = (enabled: boolean) => {
    const cfg: KafkaMonitorConfig = { enabled, interval_secs: interval, topics, groups };
    if (enabled) {
      api.kafkaMonitorStart(connId, cfg).then(() => setRunning(true)).catch((e) => toast.error(e?.message ?? String(e)));
    } else {
      api.kafkaMonitorStop(connId).then(() => setRunning(false)).catch((e) => toast.error(e?.message ?? String(e)));
    }
  };

  const toggleIn = (list: string[], setList: (v: string[]) => void, item: string) => {
    setList(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  const latest = samples[samples.length - 1];

  // 依時間窗過濾樣本。
  const windowed = (() => {
    if (samples.length === 0) return [];
    const cutoff = (latest?.ts ?? 0) - windowH * 3600 * 1000;
    return samples.filter((s) => s.ts >= cutoff);
  })();
  const seriesFor = (pick: (s: KafkaSample) => number | undefined): TsPoint[] =>
    windowed
      .map((s) => ({ t: s.ts, v: pick(s) }))
      .filter((p): p is TsPoint => p.v != null);

  return (
    <div className="p-4 text-xs space-y-4">
      {/* 取樣控制 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => applyConfig(!running)}
          className={`px-3 py-1 rounded ${running ? "bg-danger/80 hover:bg-danger text-white" : "bg-accent/80 hover:bg-accent text-white"}`}
        >
          {running ? t("停止取樣") : t("開始取樣")}
        </button>
        <label className="text-fg/40">{t("間隔（秒）")}</label>
        <input
          type="number" min={10} max={300} value={interval}
          onChange={(e) => setIntervalSecs(Math.min(300, Math.max(10, Number(e.target.value) || 30)))}
          className="w-20 bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent"
        />
        {running && <span className="text-emerald-300/70">{t("取樣中")}（{samples.length} {t("點")}）</span>}
        <div className="ml-auto inline-flex rounded border border-fg/15 overflow-hidden">
          {[1, 6, 24].map((h) => (
            <button key={h} type="button" onClick={() => setWindowH(h)}
              className={`px-2 py-1 ${windowH === h ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/10"}`}>
              {h}h
            </button>
          ))}
        </div>
      </div>
      <div className="text-fg/30">{t("變更清單 / 間隔後按「開始取樣」套用")}</div>

      {/* 叢集健康即時值 + 分區趨勢 */}
      {latest && (
        <>
          <div className="grid grid-cols-4 gap-2">
            <Tile label="Brokers" value={latest.health.brokers} />
            <Tile label={t("分區數")} value={latest.health.partitions} />
            <Tile label={t("離線分區")} value={latest.health.offline} tone={latest.health.offline > 0 ? "danger" : "dim"} />
            <Tile label={t("未同步複寫")} value={latest.health.urp} tone={latest.health.urp > 0 ? "warn" : "dim"} />
          </div>
          <div className="text-fg/50">
            <TimeSeriesChart label={t("分區數")} points={seriesFor((s) => s.health.partitions)} height={90} />
          </div>
        </>
      )}

      {/* 監看主題 */}
      <div>
        <div className="text-fg/40 mb-1">{t("監看主題")}（{topics.length}）</div>
        <div className="flex flex-wrap gap-1 mb-2">
          {allTopics.slice(0, 60).map((tp) => (
            <button key={tp} type="button" onClick={() => toggleIn(topics, setTopics, tp)}
              className={`px-1.5 py-0.5 rounded border text-[11px] ${topics.includes(tp) ? "bg-accent/20 text-accent border-accent/30" : "border-fg/10 text-fg/50 hover:bg-fg/10"}`}>
              {tp}
            </button>
          ))}
        </div>
        <div className="space-y-3">
          {topics.map((tp) => (
            <div key={tp} className="text-emerald-400/70">
              <TimeSeriesChart label={`${tp} · ${t("訊息數")}`} points={seriesFor((s) => s.topic_end[tp])} height={90} />
            </div>
          ))}
        </div>
      </div>

      {/* 監看群組 */}
      <div>
        <div className="text-fg/40 mb-1">{t("監看群組")}（{groups.length}）</div>
        <div className="flex flex-wrap gap-1 mb-2">
          {allGroups.slice(0, 60).map((g) => (
            <button key={g} type="button" onClick={() => toggleIn(groups, setGroups, g)}
              className={`px-1.5 py-0.5 rounded border text-[11px] ${groups.includes(g) ? "bg-accent/20 text-accent border-accent/30" : "border-fg/10 text-fg/50 hover:bg-fg/10"}`}>
              {g}
            </button>
          ))}
        </div>
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g} className="text-amber-300/70">
              <TimeSeriesChart label={`${g} · Lag`} points={seriesFor((s) => s.group_lag[g])} height={90} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: "warn" | "danger" | "dim" }) {
  const cls = tone === "warn" ? "text-amber-300" : tone === "danger" ? "text-red-400" : tone === "dim" ? "text-fg/50" : "text-fg/90";
  return (
    <div className="bg-inset rounded px-3 py-2 border border-fg/5">
      <div className="text-fg/40 text-[10px]">{label}</div>
      <div className={`text-lg mono ${cls}`}>{value}</div>
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
