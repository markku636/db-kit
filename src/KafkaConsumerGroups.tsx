import { useEffect, useMemo, useState } from "react";
import { Users, X } from "lucide-react";
import {
  api,
  type KafkaConsumerGroup,
  type KafkaGroupDetail,
  type KafkaStartPosition,
} from "./api";
import { toast, useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

type ResetMode = "beginning" | "end";

// 消費者群組面板（側欄 overlay，仿 MongoOpsPanel）：群組清單 + 成員 + Lag + 重設位移。
export default function KafkaConsumerGroups({ connId, connName, initialGroup, onClose }: {
  connId: string; connName: string; initialGroup?: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [groups, setGroups] = useState<KafkaConsumerGroup[]>([]);
  const [selected, setSelected] = useState<string | null>(initialGroup ?? null);
  const [detail, setDetail] = useState<KafkaGroupDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resetTopic, setResetTopic] = useState("");
  const [resetMode, setResetMode] = useState<ResetMode>("beginning");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.kafkaConsumerGroups(connId).then(setGroups).catch((e) => setErr(e?.message ?? String(e)));
  }, [connId]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setErr(null);
    api.kafkaGroupDetail(connId, selected).then(setDetail).catch((e) => setErr(e?.message ?? String(e)));
  }, [connId, selected]);

  const topics = useMemo(
    () => Array.from(new Set((detail?.offsets ?? []).map((o) => o.topic))).sort(),
    [detail]
  );

  const doReset = async () => {
    if (!selected || !resetTopic) { toast.error(t("請選擇主題")); return; }
    const target: KafkaStartPosition = resetMode === "beginning" ? { type: "beginning" } : { type: "end" };
    setBusy(true);
    try {
      await api.kafkaResetOffsets(connId, { group: selected, topic: resetTopic, target, partitions: null });
      toast.success(t("已重設 {group} / {topic} 位移", { group: selected, topic: resetTopic }));
      api.kafkaGroupDetail(connId, selected).then(setDetail).catch(() => {});
    } catch (e: any) {
      toast.error(e?.message ?? t("重設失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[860px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Users} size={14} className="text-amber-300/90" />
          <span className="font-medium text-sm">{t("消費者群組")} · {connName}</span>
          <span className="text-xs text-fg/35">{groups.length} {t("個")}</span>
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        <div className="flex-1 min-h-0 flex text-xs">
          {/* 群組清單 */}
          <div className="w-56 border-r border-fg/10 overflow-auto">
            {groups.map((g) => (
              <button
                key={g.group_id}
                onClick={() => setSelected(g.group_id)}
                className={`w-full text-left px-3 py-2 border-b border-fg/5 hover:bg-fg/5 ${selected === g.group_id ? "bg-accent/10" : ""}`}
              >
                <div className="truncate" title={g.group_id}>{g.group_id}</div>
                <div className="text-fg/35">{g.state} · {g.members} {t("成員")}</div>
              </button>
            ))}
            {groups.length === 0 && <div className="px-3 py-4 text-fg/30">{t("無消費者群組")}</div>}
          </div>

          {/* 群組詳細 */}
          <div className="flex-1 min-w-0 overflow-auto p-3">
            {detail ? (
              <div className="space-y-4">
                <div className="text-fg/60">{detail.group_id} · <span className="text-fg/40">{detail.state}</span></div>

                <div>
                  <div className="text-fg/40 mb-1">Lag</div>
                  <table className="w-full text-left mono">
                    <thead className="text-fg/40">
                      <tr>
                        <th className="px-2 py-1 font-normal">Topic</th>
                        <th className="px-2 py-1 font-normal">P</th>
                        <th className="px-2 py-1 font-normal">Current</th>
                        <th className="px-2 py-1 font-normal">Log-End</th>
                        <th className="px-2 py-1 font-normal">Lag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.offsets.map((o, i) => (
                        <tr key={i} className="border-b border-fg/5">
                          <td className="px-2 py-1 text-fg/70 max-w-[200px] truncate" title={o.topic}>{o.topic}</td>
                          <td className="px-2 py-1 text-fg/50">{o.partition}</td>
                          <td className="px-2 py-1 text-fg/50">{o.current}</td>
                          <td className="px-2 py-1 text-fg/50">{o.log_end}</td>
                          <td className={`px-2 py-1 ${o.lag > 0 ? "text-amber-300" : "text-fg/50"}`}>{o.lag}</td>
                        </tr>
                      ))}
                      {detail.offsets.length === 0 && (
                        <tr><td colSpan={5} className="px-2 py-3 text-fg/30">{t("無已提交位移")}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {detail.members.length > 0 && (
                  <div>
                    <div className="text-fg/40 mb-1">{t("成員")}</div>
                    {detail.members.map((m) => (
                      <div key={m.member_id} className="mono text-fg/60 mb-0.5">
                        {m.client_id} <span className="text-fg/30">@ {m.host}</span> — {m.assignments.join(", ") || "—"}
                      </div>
                    ))}
                  </div>
                )}

                {/* 重設位移 */}
                <div className="border-t border-fg/10 pt-3">
                  <div className="text-fg/40 mb-1">{t("重設位移")}（{t("群組須 Empty")}）</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select value={resetTopic} onChange={(e) => setResetTopic(e.target.value)} className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent">
                      <option value="">{t("選擇主題…")}</option>
                      {topics.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                    </select>
                    <select value={resetMode} onChange={(e) => setResetMode(e.target.value as ResetMode)} className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent">
                      <option value="beginning">{t("最舊")}</option>
                      <option value="end">{t("最新")}</option>
                    </select>
                    <button type="button" onClick={doReset} disabled={busy} className="px-3 py-1 rounded bg-danger/80 hover:bg-danger text-white disabled:opacity-40">{t("重設")}</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-fg/30">{t("左側選一個群組查看 Lag。")}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
