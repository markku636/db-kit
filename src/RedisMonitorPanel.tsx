import { useEffect, useRef, useState } from "react";
import { CircleDot, X, Play, Pause, Trash2 } from "lucide-react";
import { api, onRedisMonitor, onRedisMonitorError } from "./api";
import { pickSaveFile, toast, useModalOverlay } from "./ui";
import { IconButton, ModalViewControls, useModalView } from "./ui/index";
import Icon from "./ui/Icon";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useT } from "./i18n";
import { appendMonitorLine, monitorLineMatches } from "./redisUiFormat";
import { acquireRedisPanel, releaseRedisPanel } from "./redisPanelOwnership";

// Redis MONITOR 面板（仿 Another Redis Desktop Manager 的 Monitor）：
// 背景任務用專屬連線跑 MONITOR，每行經 Tauri 事件即時推來；關閉面板自動停止。
export default function RedisMonitorPanel({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const { shellClass } = useModalView();
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const unlistenErrRef = useRef<UnlistenFn | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const ownerId = useRef(`monitor-${crypto.randomUUID()}`);
  // 「暫停」只停止自動捲動，不丟資料：繼續後仍看得到暫停期間收到的指令。

  useEffect(() => {
    acquireRedisPanel(connId, ownerId.current);
    let alive = true;
    void Promise.all([
      onRedisMonitor(connId, (line) => {
        if (!alive) return;
        setLines((prev) => appendMonitorLine(prev, line));
      }),
      onRedisMonitorError(connId, (msg) => { if (alive) setErr(msg); }),
    ]).then(([a, b]) => {
      if (!alive) { a(); b(); return; }
      unlistenRef.current = a;
      unlistenErrRef.current = b;
    });
    return () => {
      alive = false;
      unlistenRef.current?.();
      unlistenErrRef.current?.();
      // 只有最後一個面板關掉才停後端任務，另一個還開著就不會突然沒資料。
      if (releaseRedisPanel(connId, ownerId.current) === 0) {
        api.redisMonitorStop(connId).catch(() => { /* 忽略 */ });
      }
    };
  }, [connId]);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, paused]);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.redisMonitorStart(connId);
      setRunning(true);
    } catch (e: any) {
      setErr(e?.message ?? t("啟動監視失敗"));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api.redisMonitorStop(connId);
      setRunning(false);
    } catch (e: any) {
      setErr(e?.message ?? t("停止監視失敗"));
    } finally {
      setBusy(false);
    }
  };

  const visible = filter.trim() ? lines.filter((l) => monitorLineMatches(l, filter)) : lines;

  const exportLog = async () => {
    if (!lines.length) return;
    const path = await pickSaveFile("redis-monitor.log", [{ name: "Log", extensions: ["log", "txt"] }]);
    if (!path) return;
    try {
      await api.writeTextFile(path, lines.join("\n"));
      toast.success(t("已匯出 {n} 行監視紀錄", { n: lines.length }));
    } catch (e: any) {
      toast.error(e?.message ?? t("匯出失敗"));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className={`bg-app w-[820px] max-w-[95vw] h-[78vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl ${shellClass}`}
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={CircleDot} size={14} className={running ? "text-emerald-400" : "text-fg/30"} />
          <span className="font-medium text-sm">{t("監視 ·")} {connName}</span>
          <span className="text-xs text-fg/35">{running ? t("監視中") : t("未啟動")} · {lines.length} {t("行")}</span>
          <ModalViewControls className="ml-auto" />
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="text-fg/40 hover:text-fg" />
        </div>

        <div className="px-4 py-2 border-b border-fg/10 flex flex-wrap items-center gap-2 text-xs">
          {running ? (
            <button type="button" onClick={stop} disabled={busy}
              className="px-3 py-1 rounded bg-amber-600/80 hover:bg-amber-600 disabled:opacity-40">{t("停止")}</button>
          ) : (
            <button type="button" onClick={start} disabled={busy}
              className="px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">{t("開始監視")}</button>
          )}
          <button type="button" onClick={() => setPaused((p) => !p)} title={t("暫停 / 繼續顯示")}
            className={`px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 inline-flex items-center gap-1 ${paused ? "text-amber-300" : "text-fg/60"}`}>
            {paused ? <><Icon icon={Play} size={14} /> {t("繼續")}</> : <><Icon icon={Pause} size={14} /> {t("暫停")}</>}
          </button>
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={t("過濾內容（子字串）")}
            className="w-48 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent" />
          <button type="button" onClick={exportLog} disabled={!lines.length} title={t("匯出監視紀錄")}
            className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60 disabled:opacity-30">{t("匯出")}</button>
          <button type="button" onClick={() => setLines([])} title={t("清空畫面")}
            className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1">
            <Icon icon={Trash2} size={13} /> {t("清空")}
          </button>
        </div>

        {err && <div className="px-4 py-2 text-xs text-red-400 border-b border-fg/10 break-all">{err}</div>}

        <div className="flex-1 overflow-auto p-3 mono text-xs leading-relaxed">
          {visible.length === 0 && (
            <div className="text-fg/35">{running ? t("等待指令…") : t("按「開始監視」即時顯示伺服器收到的指令。")}</div>
          )}
          {visible.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all text-fg/75 border-b border-fg/5 py-0.5">{line}</div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="px-4 py-2 border-t border-fg/10 text-[11px] text-fg/35">
          {t("MONITOR 會輸出伺服器收到的所有指令（含其他連線），僅保留最近 500 行。")}
        </div>
      </div>
    </div>
  );
}
