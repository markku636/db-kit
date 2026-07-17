import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { api, type RabbitExchange } from "./api";
import { Modal, Button, Field, Input, Textarea } from "./ui/index";
import { toast } from "./ui";
import { useT } from "./i18n";

// 發布訊息對話框（仿 KafkaProduceDialog）：exchange 下拉（預設 default exchange ""）、
// routing key（若從佇列開啟則預設佇列名）、payload、persistent 勾選。送出走 api.rabbitmqPublish。
export default function RabbitMqPublishDialog({ connId, onClose, onSent, initialRoutingKey }: {
  connId: string; onClose: () => void; onSent?: () => void; initialRoutingKey?: string;
}) {
  const t = useT();
  const [exchanges, setExchanges] = useState<RabbitExchange[]>([]);
  const [exchange, setExchange] = useState("");
  const [routingKey, setRoutingKey] = useState(initialRoutingKey ?? "");
  const [payload, setPayload] = useState("");
  const [persistent, setPersistent] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.rabbitmqExchanges(connId).then(setExchanges).catch(() => {});
  }, [connId]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.rabbitmqPublish(connId, exchange, routingKey, payload, persistent);
      if (res.confirmed) toast.success(t("已發布（broker 已確認）"));
      else toast.info(t("已發布（未收到 broker 確認）"));
      onSent?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("發布失敗"));
    } finally {
      setBusy(false);
    }
  };

  const prettify = () => {
    try {
      setPayload(JSON.stringify(JSON.parse(payload), null, 2));
    } catch {
      /* 非 JSON，忽略 */
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={t("發布訊息")}
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
        <Field label={t("交換器（exchange）")}>
          <select
            value={exchange}
            onChange={(e) => setExchange(e.target.value)}
            className="w-full bg-inset border border-fg/10 rounded px-2 py-1.5 outline-none focus:border-accent"
          >
            <option value="">{t("（預設交換器）")}</option>
            {exchanges.filter((x) => x.name !== "").map((x) => (
              <option key={x.name} value={x.name}>{x.name}（{x.exchange_type}）</option>
            ))}
          </select>
        </Field>
        <Field label={t("路由鍵（routing key）")} hint={exchange === "" ? t("預設交換器：routing key 即目標佇列名。") : undefined}>
          <Input value={routingKey} onChange={(e) => setRoutingKey(e.target.value)} placeholder={t("佇列名 / 繫結鍵")} />
        </Field>
        <Field label="Payload">
          <Textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={8} className="mono" />
        </Field>
        <div className="flex items-center gap-3">
          <button type="button" onClick={prettify} className="text-xs text-accent hover:underline">{t("JSON 美化")}</button>
          <label className="flex items-center gap-1.5 cursor-pointer text-fg/60 text-xs ml-auto">
            <input type="checkbox" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} />
            {t("持久化（persistent，delivery mode 2）")}
          </label>
        </div>
      </div>
    </Modal>
  );
}
