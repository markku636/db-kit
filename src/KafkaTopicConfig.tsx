import { useCallback, useEffect, useMemo, useState } from "react";
import { Eraser, Pencil, Plus, RotateCcw } from "lucide-react";
import { api, type KafkaConfigEntry, type KafkaPartitionInfo } from "./api";
import { useStore } from "./store";
import { isInternalKafkaTopic } from "./sql";
import { Modal, Button, Field, Input } from "./ui/index";
import { toast, uiConfirm, uiPrompt } from "./ui";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

// 主題設定（TableView「設定」分頁）：分區表 + 設定表（可編輯 / 還原預設）。
// 唯讀連線與內部主題隱藏所有寫入入口；刪除主題仍走側欄右鍵。
export default function KafkaTopicConfig({ connId, topic }: { connId: string; topic: string }) {
  const t = useT();
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const canEdit = !readonly && !isInternalKafkaTopic(topic);
  const [partitions, setPartitions] = useState<KafkaPartitionInfo[]>([]);
  const [config, setConfig] = useState<KafkaConfigEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(() => {
    api.kafkaTopicPartitions(connId, topic).then(setPartitions).catch((e) => setErr(e?.message ?? String(e)));
    api.kafkaTopicConfig(connId, topic).then(setConfig).catch(() => {});
  }, [connId, topic]);
  useEffect(() => { load(); }, [load]);

  const shownConfig = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return config;
    return config.filter((c) => c.name.toLowerCase().includes(q));
  }, [config, filter]);

  const editConfig = async (c: KafkaConfigEntry) => {
    const v = await uiPrompt(t("設定 {name}", { name: c.name }), {
      defaultValue: c.value,
      confirmText: t("儲存"),
    });
    if (v === null) return;
    try {
      await api.kafkaSetTopicConfig(connId, topic, c.name, v);
      toast.success(t("已更新 {name}", { name: c.name }));
      load();
    } catch (e: any) {
      toast.error(e?.message ?? t("設定更新失敗"));
    }
  };

  const revertConfig = async (c: KafkaConfigEntry) => {
    if (!(await uiConfirm(t("將「{name}」還原為預設值？", { name: c.name })))) return;
    try {
      await api.kafkaSetTopicConfig(connId, topic, c.name, null);
      toast.success(t("已還原 {name}", { name: c.name }));
      load();
    } catch (e: any) {
      toast.error(e?.message ?? t("設定更新失敗"));
    }
  };

  const emptyPartition = async (p: number) => {
    if (!(await uiConfirm(
      t("將刪除分區 #{p} 的全部訊息（清到最新位移）。此操作不可復原。", { p }),
      { danger: true, confirmText: t("清空") },
    ))) return;
    try {
      const rs = await api.kafkaDeleteRecords(connId, topic, [p], null);
      const bad = rs.find((r) => r.error);
      if (bad) toast.error(t("部分分區清空失敗：{detail}", { detail: `#${bad.partition} ${bad.error}` }));
      else toast.success(t("已清空分區 #{p}", { p }));
      load();
    } catch (e: any) {
      toast.error(e?.message ?? t("清空失敗"));
    }
  };

  return (
    <div className="h-full overflow-auto p-3 text-xs space-y-4">
      {err && <div className="text-red-400 mono break-all">{err}</div>}

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-fg/40">{t("分區")}（{partitions.length}）</span>
          {canEdit && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="ml-auto flex items-center gap-1 text-accent hover:underline"
            >
              <Icon icon={Plus} size={12} /> {t("加分割區…")}
            </button>
          )}
        </div>
        <table className="w-full text-left mono">
          <thead className="text-fg/40">
            <tr>
              <th className="px-2 py-1 font-normal">Partition</th>
              <th className="px-2 py-1 font-normal">Leader</th>
              <th className="px-2 py-1 font-normal">Replicas</th>
              <th className="px-2 py-1 font-normal">ISR</th>
              <th className="px-2 py-1 font-normal">Low</th>
              <th className="px-2 py-1 font-normal">High</th>
              {canEdit && <th className="px-2 py-1 font-normal" />}
            </tr>
          </thead>
          <tbody>
            {partitions.map((p) => (
              <tr key={p.partition} className="border-b border-fg/5 group">
                <td className="px-2 py-1">{p.partition}</td>
                <td className="px-2 py-1 text-fg/60">{p.leader}</td>
                <td className="px-2 py-1 text-fg/60">{p.replicas.join(", ")}</td>
                <td className="px-2 py-1 text-fg/60">{p.isr.join(", ")}</td>
                <td className="px-2 py-1 text-fg/50">{p.low}</td>
                <td className="px-2 py-1 text-fg/50">{p.high}</td>
                {canEdit && (
                  <td className="px-2 py-1 w-14 text-right">
                    <button
                      type="button"
                      onClick={() => emptyPartition(p.partition)}
                      title={t("清空此分區（刪除訊息）")}
                      className="opacity-0 group-hover:opacity-100 text-fg/40 hover:text-red-400"
                    >
                      <Icon icon={Eraser} size={12} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-fg/40">{t("設定")}（{shownConfig.length}）</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("篩選設定…")}
            className="ml-auto w-48 bg-inset border border-fg/10 rounded px-2 py-0.5 outline-none focus:border-accent"
          />
        </div>
        <table className="w-full text-left mono">
          <tbody>
            {shownConfig.map((c) => {
              const overridden = c.source === "DynamicTopic";
              return (
                <tr key={c.name} className="border-b border-fg/5 group">
                  <td className="px-2 py-1 text-fg/60 align-top w-[42%] break-all">{c.name}</td>
                  <td className="px-2 py-1 text-fg/80 break-all">{c.is_sensitive ? "••••" : c.value}</td>
                  <td className="px-2 py-1 align-top w-20">
                    {overridden
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">{t("已覆寫")}</span>
                      : <span className="text-[10px] text-fg/30" title={c.source}>{t("預設")}</span>}
                  </td>
                  <td className="px-2 py-1 align-top w-16 text-right whitespace-nowrap">
                    {canEdit && !c.is_sensitive && (
                      <span className="opacity-0 group-hover:opacity-100 space-x-1.5">
                        <button
                          type="button"
                          onClick={() => editConfig(c)}
                          title={t("編輯設定")}
                          className="text-fg/40 hover:text-accent"
                        >
                          <Icon icon={Pencil} size={12} />
                        </button>
                        {overridden && (
                          <button
                            type="button"
                            onClick={() => revertConfig(c)}
                            title={t("還原為預設")}
                            className="text-fg/40 hover:text-amber-300"
                          >
                            <Icon icon={RotateCcw} size={12} />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <AddPartitionsDialog
          connId={connId}
          topic={topic}
          current={partitions.length}
          onClose={() => setAddOpen(false)}
          onDone={load}
        />
      )}
    </div>
  );
}

// 加分割區對話框：輸入「新總數」（Kafka 只能增不能減）。
function AddPartitionsDialog({ connId, topic, current, onClose, onDone }: {
  connId: string; topic: string; current: number; onClose: () => void; onDone: () => void;
}) {
  const t = useT();
  const [total, setTotal] = useState(current + 1);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (total <= current) {
      toast.error(t("新分區數必須大於目前的 {n}", { n: current }));
      return;
    }
    setBusy(true);
    try {
      await api.kafkaAddPartitions(connId, topic, total);
      toast.success(t("已將分區數增加為 {n}", { n: total }));
      onDone();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("加分割區失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={t("加分割區")}
      icon={Plus}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{t("套用")}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="text-fg/50 text-xs">{t("目前 {n} 個分區", { n: current })}</div>
        <Field label={t("新分區總數")}>
          <Input
            type="number"
            value={total}
            onChange={(e) => setTotal(Math.max(current + 1, Number(e.target.value) || current + 1))}
          />
        </Field>
        <div className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5 leading-relaxed">
          {t("分區數只能增加、無法減少。依 key 雜湊分派的訊息在增加分區後會改變落點——同一 key 的新舊訊息可能位於不同分區，依賴 per-key 順序的消費者將受影響。此操作不可復原。")}
        </div>
      </div>
    </Modal>
  );
}
