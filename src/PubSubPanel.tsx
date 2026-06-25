import { useEffect, useRef, useState } from "react";
import { CircleDot, X, Play, Pause } from "lucide-react";
import { api, onRedisPubSub, onRedisPubSubError, PubSubMessage } from "./api";
import { toast, useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import type { UnlistenFn } from "@tauri-apps/api/event";

interface Line {
  channel: string;
  pattern: string | null;
  payload: string;
  at: string;
}

const MAX_LINES = 2000;

// Redis Pub/Sub 面板：仿 Another Redis Desktop Manager 的訂閱 / 發佈。
// 訂閱以後端背景任務持有專屬連線，訊息經 Tauri 事件即時推來；本面板關閉時自動取消訂閱。
export default function PubSubPanel({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  useModalOverlay(onClose); // Esc 關閉 + 計入 modalCount
  const [channelsInput, setChannelsInput] = useState("");
  const [patternsInput, setPatternsInput] = useState("*");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 發佈
  const [pubChannel, setPubChannel] = useState("");
  const [pubMessage, setPubMessage] = useState("");

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const unlistenErrRef = useRef<UnlistenFn | null>(null);
  const pausedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // 卸載時收掉監聽 + 取消訂閱（避免背景任務洩漏）。
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenErrRef.current?.();
      api.redisUnsubscribe(connId).catch(() => { /* 忽略 */ });
    };
  }, [connId]);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, paused]);

  const splitTokens = (s: string) =>
    s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);

  const subscribe = async () => {
    const channels = splitTokens(channelsInput);
    const patterns = splitTokens(patternsInput);
    if (channels.length === 0 && patterns.length === 0) {
      setErr("請至少輸入一個頻道或樣式（如 news 或 user:*）");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // 先掛事件監聽，再送出訂閱，避免錯過開頭訊息。
      if (!unlistenRef.current) {
        unlistenRef.current = await onRedisPubSub(connId, (m: PubSubMessage) => {
          if (pausedRef.current) return;
          setLines((prev) => {
            const next = [...prev, {
              channel: m.channel, pattern: m.pattern, payload: m.payload,
              at: new Date().toLocaleTimeString(),
            }];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        });
      }
      if (!unlistenErrRef.current) {
        unlistenErrRef.current = await onRedisPubSubError((msg) => setErr(msg));
      }
      await api.redisSubscribe(connId, channels, patterns);
      setSubscribed(true);
    } catch (e: any) {
      setErr(e?.message ?? "訂閱失敗");
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async () => {
    setBusy(true);
    try {
      await api.redisUnsubscribe(connId);
      setSubscribed(false);
    } catch (e: any) {
      setErr(e?.message ?? "取消訂閱失敗");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!pubChannel.trim()) { setErr("請輸入發佈頻道"); return; }
    try {
      const n = await api.redisPublish(connId, pubChannel.trim(), pubMessage);
      toast.success(`已發佈到 ${pubChannel.trim()}（${n} 個訂閱者）`);
      setPubMessage("");
    } catch (e: any) {
      setErr(e?.message ?? "發佈失敗");
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[760px] max-w-[94vw] h-[78vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={CircleDot} size={14} className={subscribed ? "text-emerald-400" : "text-fg/30"} />
          <span className="font-medium text-sm">Pub/Sub · {connName}</span>
          <span className="text-xs text-fg/35">{subscribed ? "訂閱中" : "未訂閱"} · {lines.length} 則</span>
          <IconButton icon={X} label="關閉" iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        {/* 訂閱列 */}
        <div className="px-4 py-2 border-b border-fg/10 flex flex-wrap items-center gap-2 text-xs">
          <label className="text-fg/40">頻道</label>
          <input value={channelsInput} onChange={(e) => setChannelsInput(e.target.value)}
            disabled={subscribed} placeholder="news, chat（空白 / 逗號分隔）"
            className="flex-1 min-w-[140px] bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent disabled:opacity-50" />
          <label className="text-fg/40">樣式</label>
          <input value={patternsInput} onChange={(e) => setPatternsInput(e.target.value)}
            disabled={subscribed} placeholder="user:*"
            className="w-32 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent disabled:opacity-50" />
          {subscribed ? (
            <button type="button" onClick={unsubscribe} disabled={busy}
              className="px-3 py-1 rounded bg-amber-600/80 hover:bg-amber-600 text-fg disabled:opacity-40">取消訂閱</button>
          ) : (
            <button type="button" onClick={subscribe} disabled={busy}
              className="px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">訂閱</button>
          )}
          <button type="button" onClick={() => setPaused((p) => !p)} title="暫停 / 繼續接收"
            className={`px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 inline-flex items-center gap-1 ${paused ? "text-amber-300" : "text-fg/60"}`}>
            {paused ? <><Icon icon={Play} size={14} /> 繼續</> : <><Icon icon={Pause} size={14} /> 暫停</>}
          </button>
          <button type="button" onClick={() => setLines([])} title="清空訊息"
            className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60">清空</button>
        </div>

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        {/* 訊息流 */}
        <div className="flex-1 overflow-auto p-3 mono text-xs leading-relaxed">
          {lines.length === 0 && (
            <div className="text-fg/30">訂閱後，符合的訊息會即時顯示在這裡。</div>
          )}
          {lines.map((l, i) => (
            <div key={i} className="mb-1 flex gap-2">
              <span className="text-fg/25 shrink-0">{l.at}</span>
              <span className="text-emerald-400/90 shrink-0 max-w-[180px] truncate" title={l.channel}>
                {l.channel}{l.pattern ? <span className="text-fg/30"> ({l.pattern})</span> : null}
              </span>
              <span className="text-fg/80 whitespace-pre-wrap break-all">{l.payload}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* 發佈列 */}
        <div className="border-t border-fg/10 px-4 py-2 flex items-center gap-2 text-xs">
          <span className="text-fg/40 shrink-0">發佈</span>
          <input value={pubChannel} onChange={(e) => setPubChannel(e.target.value)} placeholder="頻道"
            className="w-32 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent" />
          <input value={pubMessage} onChange={(e) => setPubMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") publish(); }} placeholder="訊息內容…"
            className="flex-1 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent" />
          <button type="button" onClick={publish}
            className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-fg">送出</button>
        </div>
      </div>
    </div>
  );
}
