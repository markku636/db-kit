import { useEffect, useState } from "react";
import { Server, X } from "lucide-react";
import { api, type EsClusterHealth, type EsIndexInfo, type EsNodeInfo } from "./api";
import { useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

// Elasticsearch / OpenSearch 叢集總覽（連線右鍵 overlay，仿 KafkaClusterOverview 版面）：
// health 色塊 + flavor/version 徽章、統計磚（節點 / 資料節點 / 主分片 / 總分片 / 未指派）、
// 節點表、索引表。單次快照（health / nodes / indices 三呼叫），不做背景取樣。
export default function EsClusterOverview({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [health, setHealth] = useState<EsClusterHealth | null>(null);
  const [nodes, setNodes] = useState<EsNodeInfo[]>([]);
  const [indices, setIndices] = useState<EsIndexInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.esClusterHealth(connId), api.esNodes(connId), api.esIndices(connId)])
      .then(([h, n, i]) => {
        if (!alive) return;
        setHealth(h);
        setNodes(n);
        setIndices(i);
      })
      .catch((e) => { if (alive) setErr(e?.message ?? String(e)); });
    return () => { alive = false; };
  }, [connId]);

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[860px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Server} size={14} className="text-yellow-300/90" />
          <span className="font-medium text-sm">{t("叢集總覽")} · {connName}</span>
          {health && (
            <span className={`inline-flex items-center gap-1.5 ${statusTone(health.status)}`}>
              <span className="w-2 h-2 rounded-full bg-current" />
              <span className="uppercase text-[11px] font-medium">{health.status}</span>
            </span>
          )}
          {health && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/60">
              {flavorLabel(health.flavor)} {health.version}
            </span>
          )}
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        <div className="flex-1 min-h-0 overflow-auto p-4 text-xs space-y-4">
          {health && (
            <>
              {/* 統計磚 */}
              <div className="grid grid-cols-5 gap-2">
                <StatTile label={t("節點數")} value={health.number_of_nodes} />
                <StatTile label={t("資料節點")} value={health.number_of_data_nodes} />
                <StatTile label={t("主分片")} value={health.active_primary_shards} />
                <StatTile label={t("總分片")} value={health.active_shards} />
                <StatTile
                  label={t("未指派")}
                  value={health.unassigned_shards}
                  tone={health.unassigned_shards > 0 ? "danger" : "dim"}
                />
              </div>

              {/* 節點表 */}
              <div>
                <div className="text-fg/40 mb-1">{t("節點")}（{nodes.length}）</div>
                <table className="w-full text-left mono">
                  <thead className="text-fg/40">
                    <tr>
                      <th className="px-2 py-1 font-normal">{t("名稱")}</th>
                      <th className="px-2 py-1 font-normal">{t("版本")}</th>
                      <th className="px-2 py-1 font-normal">{t("角色")}</th>
                      <th className="px-2 py-1 font-normal text-right">{t("堆積 %")}</th>
                      <th className="px-2 py-1 font-normal text-right">CPU</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodes.map((n) => (
                      <tr key={n.name} className="border-b border-fg/5">
                        <td className="px-2 py-1 text-fg/80">{n.name}</td>
                        <td className="px-2 py-1 text-fg/60">{n.version}</td>
                        <td className="px-2 py-1 text-fg/60 break-all">{n.roles}</td>
                        <td className="px-2 py-1 text-fg/70 text-right">{n.heap_percent}</td>
                        <td className="px-2 py-1 text-fg/70 text-right">{n.cpu}</td>
                      </tr>
                    ))}
                    {nodes.length === 0 && (
                      <tr><td colSpan={5} className="px-2 py-2 text-fg/30">{t("無節點")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* 索引表 */}
              <div>
                <div className="text-fg/40 mb-1">{t("索引")}（{indices.length}）</div>
                <table className="w-full text-left mono">
                  <thead className="text-fg/40">
                    <tr>
                      <th className="px-2 py-1 font-normal">{t("索引")}</th>
                      <th className="px-2 py-1 font-normal">{t("健康")}</th>
                      <th className="px-2 py-1 font-normal">{t("狀態")}</th>
                      <th className="px-2 py-1 font-normal text-right">{t("文件數")}</th>
                      <th className="px-2 py-1 font-normal text-right">{t("大小")}</th>
                      <th className="px-2 py-1 font-normal text-right">{t("主分片")}</th>
                      <th className="px-2 py-1 font-normal text-right">{t("副本")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {indices.map((i) => (
                      <tr key={i.index} className="border-b border-fg/5">
                        <td className="px-2 py-1 text-fg/80 break-all">{i.index}</td>
                        <td className={`px-2 py-1 ${statusTone(i.health)}`}>{i.health}</td>
                        <td className="px-2 py-1 text-fg/60">{i.status}</td>
                        <td className="px-2 py-1 text-fg/70 text-right tabular-nums">{i.docs_count}</td>
                        <td className="px-2 py-1 text-fg/70 text-right">{i.store_size}</td>
                        <td className="px-2 py-1 text-fg/70 text-right tabular-nums">{i.pri}</td>
                        <td className="px-2 py-1 text-fg/70 text-right tabular-nums">{i.rep}</td>
                      </tr>
                    ))}
                    {indices.length === 0 && (
                      <tr><td colSpan={7} className="px-2 py-2 text-fg/30">{t("無索引")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* 底部：叢集識別資訊 */}
              <div className="border-t border-fg/10 pt-2 text-fg/35 mono space-y-0.5">
                <div>cluster: {health.cluster_name}</div>
                {health.relocating_shards > 0 && <div>relocating shards: {health.relocating_shards}</div>}
              </div>
            </>
          )}
          {!health && !err && <div className="text-fg/30">{t("載入中…")}</div>}
        </div>
      </div>
    </div>
  );
}

// health / index health 色調：green→success、yellow→warning、red→danger。
function statusTone(status: string): string {
  return status === "green" ? "text-success"
    : status === "yellow" ? "text-warning"
    : status === "red" ? "text-danger"
    : "text-fg/60";
}

// flavor 顯示名稱（後端回 elasticsearch / opensearch 小寫）。
function flavorLabel(flavor: string): string {
  return flavor === "opensearch" ? "OpenSearch"
    : flavor === "elasticsearch" ? "Elasticsearch"
    : flavor;
}

function StatTile({ label, value, tone }: {
  label: string; value: number; tone?: "warn" | "danger" | "dim";
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
