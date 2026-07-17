import { useCallback, useEffect, useState } from "react";
import { api, type RabbitQueue } from "./api";
import { useStore } from "./store";
import { toast, uiConfirm, uiPrompt } from "./ui";
import { useT } from "./i18n";

// RabbitMQ 佇列詳情（TableView「詳情」分頁，仿 KafkaTopicConfig）：屬性表 + 危險區。
// 危險區在唯讀連線隱藏；清空（purge）需 danger confirm + 輸入佇列名雙重確認。
export default function RabbitMqQueueDetail({ connId, queue }: { connId: string; queue: string }) {
  const t = useT();
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const [detail, setDetail] = useState<RabbitQueue | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    api.rabbitmqQueueDetail(connId, queue)
      .then(setDetail)
      .catch((e) => setErr(e?.message ?? String(e)));
  }, [connId, queue]);
  useEffect(() => { load(); }, [load]);

  const purge = async () => {
    if (!(await uiConfirm(
      t("將刪除佇列「{name}」中的全部訊息（保留佇列本身）。此操作不可復原。", { name: queue }),
      { danger: true, confirmText: t("繼續") },
    ))) return;
    const typed = await uiPrompt(t("請輸入佇列名稱以確認清空"), { placeholder: queue });
    if (typed === null) return;
    if (typed !== queue) {
      toast.error(t("輸入的佇列名稱不符，已取消"));
      return;
    }
    try {
      await api.rabbitmqPurge(connId, queue);
      toast.success(t("已清空佇列 {name}", { name: queue }));
      load();
    } catch (e: any) {
      toast.error(e?.message ?? t("清空失敗"));
    }
  };

  const deleteQueue = async () => {
    if (!(await uiConfirm(
      t("確定刪除佇列「{name}」？此操作不可復原。", { name: queue }),
      { title: t("刪除佇列"), danger: true, confirmText: t("刪除") },
    ))) return;
    try {
      await api.rabbitmqDeleteQueue(connId, queue);
      toast.success(t("已刪除佇列 {name}", { name: queue }));
    } catch (e: any) {
      toast.error(e?.message ?? t("刪除失敗"));
    }
  };

  return (
    <div className="h-full overflow-auto p-3 text-xs space-y-4">
      {err && <div className="text-red-400 mono break-all">{err}</div>}

      {detail && (
        <div>
          <div className="text-fg/40 mb-1">{t("佇列屬性")}</div>
          <table className="w-full text-left mono">
            <tbody>
              <Row label={t("類型")} value={detail.queue_type} />
              <Row label={t("狀態")} value={detail.state} />
              <Row label="vhost" value={detail.vhost} />
              <Row label={t("持久化（durable）")} value={detail.durable ? t("是") : t("否")} />
              <Row label={t("自動刪除（auto-delete）")} value={detail.auto_delete ? t("是") : t("否")} />
              <Row label={t("訊息總數")} value={detail.messages} />
              <Row label={t("待處理（ready）")} value={detail.messages_ready} />
              <Row label={t("未確認（unacked）")} value={detail.messages_unacked} />
              <Row label={t("Consumer 數")} value={detail.consumers} />
              <Row label={t("記憶體（bytes）")} value={detail.memory} />
            </tbody>
          </table>
        </div>
      )}

      {!readonly && detail && (
        <div className="border border-danger/30 rounded">
          <div className="px-3 py-1.5 border-b border-danger/20 text-danger/90">{t("危險區")}</div>
          <div className="p-3 space-y-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={purge}
                className="px-3 py-1 rounded bg-danger/15 text-danger hover:bg-danger/25"
              >
                {t("清空佇列…")}
              </button>
              <span className="text-fg/40">{t("刪除佇列中的全部訊息，保留佇列與繫結。")}</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={deleteQueue}
                className="px-3 py-1 rounded bg-danger/15 text-danger hover:bg-danger/25"
              >
                {t("刪除佇列…")}
              </button>
              <span className="text-fg/40">{t("刪除佇列本身（含其訊息與繫結）。")}</span>
            </div>
          </div>
        </div>
      )}

      {!detail && !err && <div className="text-fg/30">{t("載入中…")}</div>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <tr className="border-b border-fg/5">
      <td className="px-2 py-1 text-fg/50 align-top w-[45%]">{label}</td>
      <td className="px-2 py-1 text-fg/80 break-all">{value}</td>
    </tr>
  );
}
