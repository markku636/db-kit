import { useEffect, useState } from "react";
import { api, type KafkaConfigEntry, type KafkaPartitionInfo } from "./api";
import { useT } from "./i18n";

// 主題設定（TableView「設定」分頁，唯讀）：分區表 + 設定表。刪除主題走側欄右鍵。
export default function KafkaTopicConfig({ connId, topic }: { connId: string; topic: string }) {
  const t = useT();
  const [partitions, setPartitions] = useState<KafkaPartitionInfo[]>([]);
  const [config, setConfig] = useState<KafkaConfigEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.kafkaTopicPartitions(connId, topic).then((p) => alive && setPartitions(p)).catch((e) => alive && setErr(e?.message ?? String(e)));
    api.kafkaTopicConfig(connId, topic).then((c) => alive && setConfig(c)).catch(() => {});
    return () => { alive = false; };
  }, [connId, topic]);

  return (
    <div className="h-full overflow-auto p-3 text-xs space-y-4">
      {err && <div className="text-red-400 mono break-all">{err}</div>}

      <div>
        <div className="text-fg/40 mb-1">{t("分區")}（{partitions.length}）</div>
        <table className="w-full text-left mono">
          <thead className="text-fg/40">
            <tr>
              <th className="px-2 py-1 font-normal">Partition</th>
              <th className="px-2 py-1 font-normal">Leader</th>
              <th className="px-2 py-1 font-normal">Replicas</th>
              <th className="px-2 py-1 font-normal">ISR</th>
              <th className="px-2 py-1 font-normal">Low</th>
              <th className="px-2 py-1 font-normal">High</th>
            </tr>
          </thead>
          <tbody>
            {partitions.map((p) => (
              <tr key={p.partition} className="border-b border-fg/5">
                <td className="px-2 py-1">{p.partition}</td>
                <td className="px-2 py-1 text-fg/60">{p.leader}</td>
                <td className="px-2 py-1 text-fg/60">{p.replicas.join(", ")}</td>
                <td className="px-2 py-1 text-fg/60">{p.isr.join(", ")}</td>
                <td className="px-2 py-1 text-fg/50">{p.low}</td>
                <td className="px-2 py-1 text-fg/50">{p.high}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="text-fg/40 mb-1">{t("設定")}（{config.length}）</div>
        <table className="w-full text-left mono">
          <tbody>
            {config.map((c) => (
              <tr key={c.name} className="border-b border-fg/5">
                <td className="px-2 py-1 text-fg/60 align-top w-1/2">
                  {c.name}
                  {!c.is_default && <span className="ml-1 text-accent/70 text-[10px]">*</span>}
                </td>
                <td className="px-2 py-1 text-fg/80 break-all">{c.is_sensitive ? "••••" : c.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
