// Pod log（唯讀 xterm）：選容器、tail N 行、時間戳、持續跟隨、前一個容器實例（CrashLoop 時看當機前的輸出）。
// 改選項就關掉舊串流、清畫面、重開一條（同 DockerLogView）。
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { ArrowDownToLine, Eraser, Pause, Play, Search } from "lucide-react";
import { api, onK8sStreamEnd } from "./api";
import XtermView, { channelBytes, type XtermHandle } from "./ui/XtermView";
import { IconButton, Select } from "./ui/index";
import { useT } from "./i18n";

const TAILS = [100, 500, 1000, 5000, 0] as const;

export default function K8sLogView({ connId, ns, pod, containers, initialContainer }: {
  connId: string;
  ns: string;
  pod: string;
  containers: string[];
  initialContainer: string;
}) {
  const t = useT();
  const [container, setContainer] = useState(initialContainer);
  const [tail, setTail] = useState<number>(500);
  const [timestamps, setTimestamps] = useState(false);
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const xt = useRef<XtermHandle | null>(null);
  const streamRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    if (!containers.includes(container) && containers.length > 0) setContainer(containers.includes(initialContainer) ? initialContainer : containers[0]);
  }, [containers, container, initialContainer]);

  const stop = useCallback(() => {
    genRef.current += 1;
    unlistenRef.current?.();
    unlistenRef.current = null;
    const sid = streamRef.current;
    streamRef.current = null;
    if (sid) void api.k8sStreamClose(sid).catch(() => undefined);
    setLive(false);
  }, []);

  const start = useCallback(async () => {
    stop();
    const gen = genRef.current;
    const term = xt.current?.term;
    if (!term) return;
    term.reset();
    setErr(null);
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (m) => { if (genRef.current === gen) term.write(channelBytes(m)); };
    const fl = follow && !previous;
    try {
      const sid = await api.k8sLogsOpen(connId, ns, pod, { container, tail, timestamps, follow: fl, previous, since_seconds: 0 }, ch);
      if (genRef.current !== gen) {
        void api.k8sStreamClose(sid).catch(() => undefined);
        return;
      }
      streamRef.current = sid;
      setLive(fl);
      const un = await onK8sStreamEnd(sid, (p) => {
        if (genRef.current !== gen) return;
        streamRef.current = null;
        setLive(false);
        if (p.error) setErr(p.error);
        else if (fl) term.write(`\r\n\x1b[90m── ${t("容器已停止輸出")} ──\x1b[0m\r\n`);
      });
      if (genRef.current !== gen) un();
      else unlistenRef.current = un;
    } catch (e: any) {
      if (genRef.current === gen) setErr(e?.message ?? String(e));
    }
  }, [connId, ns, pod, container, tail, timestamps, follow, previous, stop, t]);

  useEffect(() => {
    if (xt.current) void start();
  }, [start]);

  useEffect(() => stop, [stop]);

  const doSearch = (dir: "next" | "prev") => {
    const s = xt.current?.search;
    if (!s || !query) return;
    if (dir === "next") s.findNext(query);
    else s.findPrevious(query);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-fg/10 bg-bar text-xs flex-wrap">
        <IconButton
          icon={live ? Pause : Play}
          label={live ? t("停止跟隨") : t("開始跟隨")}
          onClick={() => { if (live) stop(); else { setFollow(true); setPrevious(false); void start(); } }}
        />
        {containers.length > 1 && (
          <label className="flex items-center gap-1 text-fg/60">
            {t("容器")}
            <Select value={container} onChange={(e) => setContainer(e.target.value)} className="w-40">
              {containers.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </label>
        )}
        <label className="flex items-center gap-1 text-fg/60">
          {t("最近")}
          <Select value={String(tail)} onChange={(e) => setTail(Number(e.target.value))} className="w-24">
            {TAILS.map((n) => <option key={n} value={n}>{n === 0 ? t("全部") : t("{n} 行", { n })}</option>)}
          </Select>
        </label>
        <label className="flex items-center gap-1 cursor-pointer select-none text-fg/60">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          {t("時間戳")}
        </label>
        <label className="flex items-center gap-1 cursor-pointer select-none text-fg/60">
          <input type="checkbox" checked={follow} disabled={previous} onChange={(e) => setFollow(e.target.checked)} />
          {t("持續跟隨")}
        </label>
        <label className="flex items-center gap-1 cursor-pointer select-none text-fg/60" title={t("上一個容器實例（重啟前）的 log")}>
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
          {t("重啟前")}
        </label>
        <div className="ml-auto flex items-center gap-1">
          <div className="relative">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg/30" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doSearch(e.shiftKey ? "prev" : "next"); }}
              placeholder={t("搜尋 log…")}
              className="w-40 bg-inset border border-fg/10 rounded pl-6 pr-2 py-0.5 outline-none focus:border-accent"
            />
          </div>
          <IconButton icon={ArrowDownToLine} label={t("捲到最底")} onClick={() => xt.current?.term.scrollToBottom()} />
          <IconButton icon={Eraser} label={t("清除畫面")} onClick={() => xt.current?.term.clear()} />
        </div>
      </div>
      {err && <div className="px-3 py-1 text-xs text-danger mono break-all border-b border-fg/10">{err}</div>}
      <XtermView
        readOnly
        className="flex-1 p-1 bg-inset"
        onReady={(h) => {
          xt.current = h;
          return () => { xt.current = null; };
        }}
      />
    </div>
  );
}
