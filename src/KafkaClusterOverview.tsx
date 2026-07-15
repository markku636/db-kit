import { useEffect, useMemo, useState } from "react";
import { Server, X } from "lucide-react";
import { api, type KafkaClusterInfo, type KafkaConfigEntry } from "./api";
import { useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

// 叢集總覽（連線右鍵 overlay，仿 RedisStatus / KafkaConsumerGroups 版面）：
// 統計磚（brokers / topics / partitions / URP / offline）+ broker 表（點列看該 broker 設定）。
// 靜態快照：單次 metadata 計算，不做背景取樣（趨勢圖表屬監控面板）。
export default function KafkaClusterOverview({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [info, setInfo] = useState<KafkaClusterInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selBroker, setSelBroker] = useState<number | null>(null);
  const [config, setConfig] = useState<KafkaConfigEntry[]>([]);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api.kafkaClusterInfo(connId).then(setInfo).catch((e) => setErr(e?.message ?? String(e)));
  }, [connId]);

  useEffect(() => {
    if (selBroker === null) { setConfig([]); return; }
    setCfgErr(null);
    api.kafkaBrokerConfig(connId, selBroker)
      .then(setConfig)
      .catch((e) => { setConfig([]); setCfgErr(e?.message ?? String(e)); });
  }, [connId, selBroker]);

  const shownConfig = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return config;
    return config.filter((c) => c.name.toLowerCase().includes(q));
  }, [config, filter]);

  const healthy = info != null && info.under_replicated === 0 && info.offline_partitions === 0;

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[860px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Server} size={14} className="text-cyan-300/90" />
          <span className="font-medium text-sm">{t("叢集總覽")} · {connName}</span>
          {info && (
            healthy
              ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">{t("健康")}</span>
              : <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{t("需注意")}</span>
          )}
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        <div className="flex-1 min-h-0 overflow-auto p-4 text-xs space-y-4">
          {info && (
            <>
              {/* 統計磚 */}
              <div className="grid grid-cols-5 gap-2">
                <StatTile label="Brokers" value={info.broker_count} />
                <StatTile
                  label={t("主題數")}
                  value={info.topic_count}
                  sub={info.internal_topic_count > 0 ? `+${info.internal_topic_count} ${t("內部")}` : undefined}
                />
                <StatTile label={t("分區數")} value={info.partition_count} />
                <StatTile
                  label={t("未同步複寫")}
                  value={info.under_replicated}
                  tone={info.under_replicated > 0 ? "warn" : "dim"}
                />
                <StatTile
                  label={t("離線分區")}
                  value={info.offline_partitions}
                  tone={info.offline_partitions > 0 ? "danger" : "dim"}
                />
              </div>

              {/* Broker 表 */}
              <div>
                <div className="text-fg/40 mb-1">Brokers</div>
                <table className="w-full text-left mono">
                  <thead className="text-fg/40">
                    <tr>
                      <th className="px-2 py-1 font-normal">ID</th>
                      <th className="px-2 py-1 font-normal">Host</th>
                      <th className="px-2 py-1 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {info.brokers.map((b) => (
                      <tr
                        key={b.id}
                        onClick={() => setSelBroker(selBroker === b.id ? null : b.id)}
                        className={`border-b border-fg/5 cursor-pointer hover:bg-fg/5 ${selBroker === b.id ? "bg-accent/10" : ""}`}
                      >
                        <td className="px-2 py-1">{b.id}</td>
                        <td className="px-2 py-1 text-fg/70">{b.host}:{b.port}</td>
                        <td className="px-2 py-1 text-right space-x-1">
                          {b.id === info.controller_id && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">{t("控制器")}</span>
                          )}
                          {b.id === info.orig_broker_id && (
                            <span className="text-[10px] text-fg/35">{t("已連線")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selBroker === null && <div className="mt-1 text-fg/30">{t("點選 broker 檢視其設定")}</div>}
              </div>

              {/* Broker 設定 */}
              {selBroker !== null && (
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-fg/40">{t("Broker 設定")}（#{selBroker} · {shownConfig.length}）</span>
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder={t("篩選設定…")}
                      className="ml-auto w-48 bg-inset border border-fg/10 rounded px-2 py-0.5 outline-none focus:border-accent"
                    />
                  </div>
                  {cfgErr && <div className="text-red-400 mono break-all mb-1">{cfgErr}</div>}
                  <table className="w-full text-left mono">
                    <tbody>
                      {shownConfig.map((c) => (
                        <tr key={c.name} className="border-b border-fg/5">
                          <td className="px-2 py-1 text-fg/60 align-top w-1/2 break-all">
                            {c.name}
                            {!c.is_default && <span className="ml-1 text-accent/70 text-[10px]">*</span>}
                          </td>
                          <td className="px-2 py-1 text-fg/80 break-all">{c.is_sensitive ? "••••" : c.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 底部：叢集識別資訊 */}
              <div className="border-t border-fg/10 pt-2 text-fg/35 mono space-y-0.5">
                <div>bootstrap: {info.bootstrap}</div>
                {info.cluster_id && <div>cluster.id: {info.cluster_id}</div>}
                <div>librdkafka: {info.librdkafka_version}</div>
              </div>
            </>
          )}
          {!info && !err && <div className="text-fg/30">{t("載入中…")}</div>}
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, sub, tone }: {
  label: string; value: number; sub?: string; tone?: "warn" | "danger" | "dim";
}) {
  const valueCls =
    tone === "warn" ? "text-amber-300"
    : tone === "danger" ? "text-red-400"
    : tone === "dim" ? "text-fg/50"
    : "text-fg/90";
  return (
    <div className="bg-inset rounded px-3 py-2 border border-fg/5">
      <div className="text-fg/40 text-[10px]">{label}</div>
      <div className={`text-lg mono ${valueCls}`}>
        {value}
        {sub && <span className="ml-1 text-[10px] text-fg/35">{sub}</span>}
      </div>
    </div>
  );
}
