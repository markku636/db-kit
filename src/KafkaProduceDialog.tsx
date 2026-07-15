import { useState } from "react";
import { Send } from "lucide-react";
import { api, type KafkaHeader } from "./api";
import { Modal, Button, Field, Input, Textarea } from "./ui/index";
import { toast } from "./ui";
import { useT } from "./i18n";

// 發佈訊息對話框（仿 NewKeyDialog）。
export default function KafkaProduceDialog({ connId, topic, onClose, onSent }: {
  connId: string; topic: string; onClose: () => void; onSent?: () => void;
}) {
  const t = useT();
  const [partition, setPartition] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [headers, setHeaders] = useState<KafkaHeader[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.kafkaProduce(connId, {
        topic,
        partition: partition.trim() === "" ? null : Number(partition),
        key: key === "" ? null : key,
        value: value === "" ? null : value,
        headers: headers.filter((h) => h.key.trim()),
      });
      toast.success(t("已送出 → partition {p} / offset {o}", { p: res.partition, o: res.offset }));
      onSent?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("發佈失敗"));
    } finally {
      setBusy(false);
    }
  };

  const prettify = () => {
    try {
      setValue(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      /* 非 JSON，忽略 */
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={`${t("發佈訊息")} · ${topic}`}
      icon={Send}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{t("送出")}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex gap-3">
          <Field label={t("分區（空白＝自動）")} className="w-40">
            <Input value={partition} onChange={(e) => setPartition(e.target.value)} placeholder={t("自動")} />
          </Field>
          <Field label="Key" className="flex-1">
            <Input value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        </div>
        <Field label="Value">
          <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={7} className="mono" />
        </Field>
        <button type="button" onClick={prettify} className="text-xs text-accent hover:underline">{t("JSON 美化")}</button>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-fg/40 text-xs">Headers</span>
            <button type="button" onClick={() => setHeaders((h) => [...h, { key: "", value: "" }])} className="text-xs text-accent hover:underline">+ {t("新增")}</button>
          </div>
          {headers.map((h, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <Input value={h.key} onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="key" className="flex-1" />
              <Input value={h.value} onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="value" className="flex-1" />
              <button type="button" onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))} className="px-2 text-fg/40 hover:text-red-400">×</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
