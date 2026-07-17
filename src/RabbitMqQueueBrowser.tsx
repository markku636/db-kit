import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { api, type RabbitMessage } from "./api";
import Icon from "./ui/Icon";
import { copyToClipboard } from "./ui";
import { useT } from "./i18n";

// RabbitMQ 佇列訊息瀏覽器（TableView 內嵌，仿 KafkaMessageBrowser）：
// basic.get 取出 N 則訊息並（預設）重新入列。常駐黃色警告條說明 basic.get 的副作用；
// stream 佇列不支援 basic.get，直接顯示提示、不呼叫 peek。
export default function RabbitMqQueueBrowser({ connId, queue }: { connId: string; queue: string }) {
  const t = useT();
  const [count, setCount] = useState(10);
  const [requeue, setRequeue] = useState(true);
  const [rows, setRows] = useState<RabbitMessage[]>([]);
  // 佇列類型：TableView 不傳，故自行以 queueDetail 取得（用來判斷 stream）。
  const [queueType, setQueueType] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const isStream = queueType === "stream";

  useEffect(() => {
    let alive = true;
    setQueueType(null);
    api.rabbitmqQueueDetail(connId, queue)
      .then((q) => { if (alive) setQueueType(q.queue_type); })
      .catch(() => { if (alive) setQueueType(""); }); // 取不到類型時視為非 stream，仍允許 peek
    return () => { alive = false; };
  }, [connId, queue]);

  const load = useCallback(async () => {
    if (isStream) return;
    setBusy(true);
    setErr(null);
    try {
      const ms = await api.rabbitmqPeek(connId, queue, Math.max(1, count), requeue);
      setRows(ms);
      setLoaded(true);
    } catch (e: any) {
      setErr(e?.message ?? t("讀取失敗"));
    } finally {
      setBusy(false);
    }
  }, [connId, queue, count, requeue, isStream, t]);

  const pretty = (payload: string): string => {
    try {
      return JSON.stringify(JSON.parse(payload), null, 2);
    } catch {
      return payload;
    }
  };

  const prettyProps = (props: string): string => {
    try {
      return JSON.stringify(JSON.parse(props), null, 2);
    } catch {
      return props;
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 text-xs">
      {/* 工具列 */}
      <div className="px-3 py-2 border-b border-fg/10 flex flex-wrap items-center gap-2">
        <label className="text-fg/40">{t("取出則數")}</label>
        <input
          type="number"
          min={1}
          value={count}
          onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
          disabled={isStream}
          className="w-20 bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent disabled:opacity-40"
        />
        <label className="flex items-center gap-1.5 cursor-pointer text-fg/60">
          <input type="checkbox" checked={requeue} onChange={(e) => setRequeue(e.target.checked)} disabled={isStream} />
          {t("重新入列（requeue）")}
        </label>
        <button
          type="button"
          onClick={load}
          disabled={busy || isStream}
          className="px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40 inline-flex items-center gap-1"
        >
          <Icon icon={RefreshCw} size={13} /> {t("重新整理")}
        </button>
        <span className="text-fg/30 ml-auto">{queue}{queueType ? ` · ${queueType}` : ""}</span>
      </div>

      {/* 常駐黃色警告條 */}
      <div className="px-3 py-2 border-b border-fg/10 bg-amber-500/10 text-amber-300/90 flex items-start gap-2 leading-relaxed">
        <Icon icon={AlertTriangle} size={13} className="shrink-0 mt-0.5" />
        <span>{t("basic.get 會取出訊息再重新入列（標記 redelivered、可能改變順序）；quorum 佇列會累加 delivery count。")}</span>
      </div>

      {err && <div className="px-3 py-1.5 text-red-400 mono break-all border-b border-fg/10">{err}</div>}

      {/* 訊息卡片列表 */}
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {isStream ? (
          <div className="text-fg/40 bg-inset/50 rounded p-4 text-center">
            {t("stream 佇列不支援 basic.get 瀏覽。")}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-fg/30 text-center py-6">
            {loaded ? t("佇列中沒有可取出的訊息。") : t("按「重新整理」以 basic.get 取出訊息。")}
          </div>
        ) : (
          rows.map((m, i) => (
            <div key={i} className="border border-fg/10 rounded bg-inset/40">
              <div className="px-3 py-1.5 border-b border-fg/10 flex flex-wrap items-center gap-2 text-fg/50">
                <span className="text-fg/70">#{i + 1}</span>
                {m.redelivered && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{t("已重送")}</span>
                )}
                {m.routing_key !== "" && (
                  <span>{t("路由鍵")}: <span className="text-fg/80 mono">{m.routing_key}</span></span>
                )}
                <span>{t("交換器")}: <span className="text-fg/80 mono">{m.exchange || t("（預設）")}</span></span>
                {m.message_count >= 0 && (
                  <span className="ml-auto text-fg/40">{t("剩餘 {n} 則", { n: m.message_count })}</span>
                )}
                <button
                  type="button"
                  onClick={() => copyToClipboard(m.payload, t("已複製"))}
                  className="text-fg/40 hover:text-accent"
                >
                  {t("複製 payload")}
                </button>
              </div>
              <div className="p-3 space-y-2">
                <div>
                  <div className="text-fg/35 mb-1">payload</div>
                  <pre className="bg-inset rounded p-2 mono whitespace-pre-wrap break-all">{pretty(m.payload)}</pre>
                </div>
                {m.properties && m.properties !== "{}" && (
                  <div>
                    <div className="text-fg/35 mb-1">properties</div>
                    <pre className="bg-inset rounded p-2 mono whitespace-pre-wrap break-all text-fg/70">{prettyProps(m.properties)}</pre>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
