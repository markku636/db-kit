import { useState } from "react";
import { Plus } from "lucide-react";
import { api, type KafkaHeader } from "./api";
import { Modal, Button, Field, Input } from "./ui/index";
import { toast } from "./ui";
import { useT } from "./i18n";

// 建立主題對話框。
export default function KafkaCreateTopicDialog({ connId, onClose, onCreated }: {
  connId: string; onClose: () => void; onCreated?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [partitions, setPartitions] = useState(1);
  const [replication, setReplication] = useState(1);
  const [config, setConfig] = useState<KafkaHeader[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      toast.error(t("請輸入主題名稱"));
      return;
    }
    setBusy(true);
    try {
      await api.kafkaCreateTopic(connId, {
        name: name.trim(),
        partitions,
        replication,
        config: config.filter((c) => c.key.trim()),
      });
      toast.success(t("已建立主題 {name}", { name: name.trim() }));
      onCreated?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("建立主題失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={t("新增主題")}
      icon={Plus}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{t("建立")}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label={t("主題名稱")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-topic" />
        </Field>
        <div className="flex gap-3">
          <Field label={t("分區數")} className="flex-1">
            <Input type="number" value={partitions} onChange={(e) => setPartitions(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Field label={t("複本因子")} className="flex-1">
            <Input type="number" value={replication} onChange={(e) => setReplication(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-fg/40 text-xs">{t("設定（選填，如 retention.ms）")}</span>
            <button type="button" onClick={() => setConfig((c) => [...c, { key: "", value: "" }])} className="text-xs text-accent hover:underline">+ {t("新增")}</button>
          </div>
          {config.map((c, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <Input value={c.key} onChange={(e) => setConfig((cs) => cs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="retention.ms" className="flex-1" />
              <Input value={c.value} onChange={(e) => setConfig((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="604800000" className="flex-1" />
              <button type="button" onClick={() => setConfig((cs) => cs.filter((_, j) => j !== i))} className="px-2 text-fg/40 hover:text-red-400">×</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
