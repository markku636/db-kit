import { useEffect, useMemo, useState } from "react";
import { Users, X } from "lucide-react";
import {
  api,
  type KafkaConsumerGroup,
  type KafkaGroupDetail,
  type KafkaOffsetPlanRow,
  type KafkaResetTarget,
} from "./api";
import { toast, uiConfirm, useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import Sparkline from "./ui/Sparkline";
import { useT } from "./i18n";

type ResetMode = "beginning" | "end" | "offset" | "timestamp" | "shift";

// 消費者群組面板（側欄 overlay，仿 MongoOpsPanel）：群組清單 + 成員 + Lag + 位移重設（含預覽）。
export default function KafkaConsumerGroups({ connId, connName, initialGroup, onClose }: {
  connId: string; connName: string; initialGroup?: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [groups, setGroups] = useState<KafkaConsumerGroup[]>([]);
  const [selected, setSelected] = useState<string | null>(initialGroup ?? null);
  const [detail, setDetail] = useState<KafkaGroupDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 重設參數。任一變動即作廢既有預覽（見 invalidate）。
  const [resetTopic, setResetTopic] = useState("");
  const [resetMode, setResetMode] = useState<ResetMode>("beginning");
  const [offsetInput, setOffsetInput] = useState("0");
  const [tsInput, setTsInput] = useState("");
  const [shiftInput, setShiftInput] = useState("-100");
  const [allParts, setAllParts] = useState<number[]>([]);
  const [checkedParts, setCheckedParts] = useState<Set<number>>(new Set());
  const [plan, setPlan] = useState<KafkaOffsetPlanRow[] | null>(null);

  const loadGroups = () =>
    api.kafkaConsumerGroups(connId).then(setGroups).catch((e) => setErr(e?.message ?? String(e)));
  useEffect(() => { loadGroups(); }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 若背景取樣有歷史，取每個群組的 lag 序列供清單旁 sparkline。
  const [lagHistory, setLagHistory] = useState<Record<string, number[]>>({});
  useEffect(() => {
    api.kafkaMetricsHistory(connId).then((samples) => {
      const map: Record<string, number[]> = {};
      for (const s of samples) {
        for (const [g, lag] of Object.entries(s.group_lag)) {
          (map[g] ??= []).push(lag);
        }
      }
      setLagHistory(map);
    }).catch(() => {});
  }, [connId]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setErr(null);
    setPlan(null);
    api.kafkaGroupDetail(connId, selected).then(setDetail).catch((e) => setErr(e?.message ?? String(e)));
  }, [connId, selected]);

  const topics = useMemo(
    () => Array.from(new Set((detail?.offsets ?? []).map((o) => o.topic))).sort(),
    [detail]
  );

  // 主題變更 → 抓該主題全部分區（不依賴群組已提交位移的分區集合）。
  useEffect(() => {
    setPlan(null);
    if (!resetTopic) { setAllParts([]); setCheckedParts(new Set()); return; }
    api.kafkaTopicPartitions(connId, resetTopic)
      .then((ps) => {
        const ids = ps.map((p) => p.partition).sort((a, b) => a - b);
        setAllParts(ids);
        setCheckedParts(new Set(ids));
      })
      .catch(() => { setAllParts([]); setCheckedParts(new Set()); });
  }, [connId, resetTopic]);

  const invalidate = () => setPlan(null);

  const buildTarget = (): KafkaResetTarget | null => {
    switch (resetMode) {
      case "beginning": return { type: "beginning" };
      case "end": return { type: "end" };
      case "offset": {
        const v = Number(offsetInput);
        if (!Number.isFinite(v) || v < 0) { toast.error(t("位移需為非負整數")); return null; }
        return { type: "offset", offset: Math.floor(v) };
      }
      case "timestamp": {
        const ms = tsInput ? new Date(tsInput).getTime() : NaN;
        if (!Number.isFinite(ms)) { toast.error(t("請選擇時間")); return null; }
        return { type: "timestamp", ts: ms };
      }
      case "shift": {
        const v = Number(shiftInput);
        if (!Number.isFinite(v) || !Number.isInteger(v) || v === 0) { toast.error(t("平移量需為非零整數")); return null; }
        return { type: "shift", by: v };
      }
    }
  };

  const buildReset = () => {
    if (!selected || !resetTopic) { toast.error(t("請選擇主題")); return null; }
    const target = buildTarget();
    if (!target) return null;
    const partitions = checkedParts.size === allParts.length ? null : Array.from(checkedParts).sort((a, b) => a - b);
    if (partitions !== null && partitions.length === 0) { toast.error(t("請至少勾選一個分區")); return null; }
    return { group: selected, topic: resetTopic, target, partitions };
  };

  const doPreview = async () => {
    const reset = buildReset();
    if (!reset) return;
    setBusy(true);
    try {
      setPlan(await api.kafkaPreviewResetOffsets(connId, reset));
    } catch (e: any) {
      toast.error(e?.message ?? t("預覽失敗"));
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    const reset = buildReset();
    if (!reset || !plan) return;
    const n = plan.filter((r) => r.target !== null).length;
    if (!(await uiConfirm(t("依預覽表套用位移重設（{n} 個分區）？", { n }), { danger: true, confirmText: t("套用") }))) return;
    setBusy(true);
    try {
      const applied = await api.kafkaResetOffsets(connId, reset);
      toast.success(t("已重設 {n} 個分區位移", { n: applied.filter((r) => r.target !== null).length }));
      setPlan(null);
      if (selected) api.kafkaGroupDetail(connId, selected).then(setDetail).catch(() => {});
    } catch (e: any) {
      toast.error(e?.message ?? t("重設失敗"));
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent";
  const groupEmpty = detail?.state === "Empty";

  const doDeleteGroup = async () => {
    if (!selected) return;
    if (!(await uiConfirm(
      t("確定刪除消費者群組「{name}」？已提交位移將一併刪除，不可復原。", { name: selected }),
      { danger: true, confirmText: t("刪除") },
    ))) return;
    setBusy(true);
    try {
      await api.kafkaDeleteGroup(connId, selected);
      toast.success(t("已刪除群組 {name}", { name: selected }));
      setSelected(null);
      setDetail(null);
      loadGroups();
    } catch (e: any) {
      toast.error(e?.message ?? t("刪除失敗"));
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
                <div className="flex items-center gap-1.5">
                  <div className="truncate flex-1" title={g.group_id}>{g.group_id}</div>
                  {lagHistory[g.group_id] && lagHistory[g.group_id].length >= 2 && (
                    <Sparkline points={lagHistory[g.group_id]} width={44} height={14} className="text-amber-300/70 shrink-0" />
                  )}
                </div>
                <div className="text-fg/35">{g.state} · {g.members} {t("成員")}</div>
              </button>
            ))}
            {groups.length === 0 && <div className="px-3 py-4 text-fg/30">{t("無消費者群組")}</div>}
          </div>

          {/* 群組詳細 */}
          <div className="flex-1 min-w-0 overflow-auto p-3">
            {detail ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="text-fg/60">{detail.group_id} · <span className="text-fg/40">{detail.state}</span></span>
                  <button
                    type="button"
                    onClick={doDeleteGroup}
                    disabled={busy || !groupEmpty}
                    title={groupEmpty ? undefined : t("群組須 Empty 才能刪除")}
                    className="ml-auto px-2 py-0.5 rounded text-red-400/80 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                  >
                    {t("刪除群組")}
                  </button>
                </div>

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

                {/* 位移重設（預覽 → 套用） */}
                <div className="border-t border-fg/10 pt-3 space-y-2">
                  <div className="text-fg/40">{t("重設位移")}（{t("群組須 Empty 才能套用")}）</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={resetTopic}
                      onChange={(e) => { setResetTopic(e.target.value); }}
                      className={inputCls}
                    >
                      <option value="">{t("選擇主題…")}</option>
                      {topics.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                    </select>
                    <select
                      value={resetMode}
                      onChange={(e) => { setResetMode(e.target.value as ResetMode); invalidate(); }}
                      className={inputCls}
                    >
                      <option value="beginning">{t("最舊")}</option>
                      <option value="end">{t("最新")}</option>
                      <option value="offset">{t("指定位移")}</option>
                      <option value="timestamp">{t("時間戳")}</option>
                      <option value="shift">{t("平移 ±N")}</option>
                    </select>
                    {resetMode === "offset" && (
                      <input
                        type="number" min={0} value={offsetInput}
                        onChange={(e) => { setOffsetInput(e.target.value); invalidate(); }}
                        className={`${inputCls} w-28`} placeholder="offset"
                      />
                    )}
                    {resetMode === "timestamp" && (
                      <input
                        type="datetime-local" value={tsInput}
                        onChange={(e) => { setTsInput(e.target.value); invalidate(); }}
                        className={inputCls}
                      />
                    )}
                    {resetMode === "shift" && (
                      <input
                        type="number" value={shiftInput}
                        onChange={(e) => { setShiftInput(e.target.value); invalidate(); }}
                        className={`${inputCls} w-24`} title={t("負數往回、正數往前")}
                      />
                    )}
                    <button
                      type="button" onClick={doPreview} disabled={busy || !resetTopic}
                      className="px-3 py-1 rounded bg-accent/80 hover:bg-accent text-white disabled:opacity-40"
                    >
                      {t("預覽")}
                    </button>
                    <button
                      type="button" onClick={doApply} disabled={busy || !plan || !groupEmpty}
                      title={groupEmpty ? undefined : t("群組須 Empty 才能套用")}
                      className="px-3 py-1 rounded bg-danger/80 hover:bg-danger text-white disabled:opacity-40"
                    >
                      {t("套用")}
                    </button>
                  </div>

                  {allParts.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-fg/60">
                      <span className="text-fg/40">{t("分區")}</span>
                      {allParts.map((p) => (
                        <label key={p} className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checkedParts.has(p)}
                            onChange={(e) => {
                              setCheckedParts((s) => {
                                const next = new Set(s);
                                if (e.target.checked) next.add(p); else next.delete(p);
                                return next;
                              });
                              invalidate();
                            }}
                          />
                          <span className="mono">#{p}</span>
                        </label>
                      ))}
                    </div>
                  )}

                  {plan && (
                    <table className="w-full text-left mono">
                      <thead className="text-fg/40">
                        <tr>
                          <th className="px-2 py-1 font-normal">P</th>
                          <th className="px-2 py-1 font-normal">{t("目前")}</th>
                          <th className="px-2 py-1 font-normal">{t("新位移")}</th>
                          <th className="px-2 py-1 font-normal">Low … High</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.map((r) => (
                          <tr key={r.partition} className="border-b border-fg/5">
                            <td className="px-2 py-1">{r.partition}</td>
                            <td className="px-2 py-1 text-fg/50">{r.current < 0 ? "—" : r.current}</td>
                            <td className="px-2 py-1">
                              {r.target === null
                                ? <span className="text-fg/30">{t("略過（無已提交位移）")}</span>
                                : <span className={r.target !== r.current ? "text-accent" : "text-fg/50"}>{r.target}</span>}
                            </td>
                            <td className="px-2 py-1 text-fg/40">{r.low} … {r.high}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
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
