import { useEffect, useState } from "react";
import { Rabbit, X } from "lucide-react";
import { api, type RabbitOverview } from "./api";
import { useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

// RabbitMQ 總覽（連線右鍵 overlay，仿 KafkaClusterOverview / EsClusterOverview 版面）：
// 版本 / node 徽章 + 統計磚（佇列 / 連線 / consumer / ready / unacked）+ 收發速率磚。
// 單次快照（api.rabbitmqOverview），不做背景取樣。
export default function RabbitMqOverview({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [info, setInfo] = useState<RabbitOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.rabbitmqOverview(connId)
      .then((o) => { if (alive) setInfo(o); })
      .catch((e) => { if (alive) setErr(e?.message ?? String(e)); });
    return () => { alive = false; };
  }, [connId]);

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[720px] max-w-[95vw] max-h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Rabbit} size={14} className="text-pink-300/90" />
          <span className="font-medium text-sm">{t("總覽")} · {connName}</span>
          {info && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/60">
              RabbitMQ {info.rabbitmq_version}
            </span>
          )}
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        <div className="flex-1 min-h-0 overflow-auto p-4 text-xs space-y-4">
          {info && (
            <>
              {/* 統計磚 */}
              <div className="grid grid-cols-5 gap-2">
                <StatTile label={t("佇列數")} value={info.queue_total} />
                <StatTile label={t("連線數")} value={info.connection_total} />
                <StatTile label={t("Consumer 數")} value={info.consumer_total} />
                <StatTile label={t("待處理（ready）")} value={info.messages_ready} />
                <StatTile
                  label={t("未確認（unacked）")}
                  value={info.messages_unacked}
                  tone={info.messages_unacked > 0 ? "warn" : "dim"}
                />
              </div>

              {/* 收發速率 */}
              <div className="grid grid-cols-2 gap-2">
                <StatTile label={t("發布速率（/秒）")} value={fmtRate(info.publish_rate)} />
                <StatTile label={t("傳遞速率（/秒）")} value={fmtRate(info.deliver_rate)} />
              </div>

              {/* 底部：節點識別資訊 */}
              <div className="border-t border-fg/10 pt-2 text-fg/35 mono space-y-0.5">
                <div>node: {info.node}</div>
                <div>RabbitMQ: {info.rabbitmq_version}</div>
                <div>Erlang/OTP: {info.erlang_version}</div>
              </div>
            </>
          )}
          {!info && !err && <div className="text-fg/30">{t("載入中…")}</div>}
        </div>
      </div>
    </div>
  );
}

// 速率保留一位小數（後端回浮點 msg/s）。
function fmtRate(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : "0.0";
}

function StatTile({ label, value, tone }: {
  label: string; value: number | string; tone?: "warn" | "danger" | "dim";
}) {
  const valueCls =
    tone === "warn" ? "text-amber-300"
    : tone === "danger" ? "text-red-400"
    : tone === "dim" ? "text-fg/50"
    : "text-fg/90";
  return (
    <div className="bg-inset rounded px-3 py-2 border border-fg/5">
      <div className="text-fg/40 text-[10px]">{label}</div>
      <div className={`text-lg mono ${valueCls}`}>{value}</div>
    </div>
  );
}
