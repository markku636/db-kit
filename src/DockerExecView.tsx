// 容器互動 shell（docker exec -it）：xterm ↔ 後端 hijack 串流。預設自動挑 bash / ash / sh，
// 可改指令與使用者。shell 結束後按 Enter 或「重新連線」再開一條。
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { RefreshCw, Unplug } from "lucide-react";
import { api, onDockerStreamEnd } from "./api";
import XtermView, { channelBytes, type XtermHandle } from "./ui/XtermView";
import { Button, Input } from "./ui/index";
import { useT } from "./i18n";

type Status = "idle" | "connecting" | "open" | "closed";

/** 指令列字串 → argv（支援單 / 雙引號，不做變數展開）。空白 → []（後端自動挑 shell）。 */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of s.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

export default function DockerExecView({ connId, container, running }: { connId: string; container: string; running: boolean }) {
  const t = useT();
  const [cmd, setCmd] = useState("");
  const [user, setUser] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const statusRef = useRef<Status>("idle");
  statusRef.current = status;
  const xt = useRef<XtermHandle | null>(null);
  const streamRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const genRef = useRef(0);

  const close = useCallback(() => {
    genRef.current += 1;
    unlistenRef.current?.();
    unlistenRef.current = null;
    const sid = streamRef.current;
    streamRef.current = null;
    if (sid) void api.dockerStreamClose(sid).catch(() => undefined);
  }, []);

  const open = useCallback(async () => {
    close();
    const gen = genRef.current;
    const h = xt.current;
    if (!h) return;
    const term = h.term;
    h.fit();
    setStatus("connecting");
    term.write(`\x1b[90m── ${t("連線到 {name}…", { name: container })} ──\x1b[0m\r\n`);
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (m) => { if (genRef.current === gen) term.write(channelBytes(m)); };
    try {
      const sid = await api.dockerExecOpen(connId, container, splitCommand(cmd), user.trim(), term.cols, term.rows, ch);
      if (genRef.current !== gen) {
        void api.dockerStreamClose(sid).catch(() => undefined);
        return;
      }
      streamRef.current = sid;
      setStatus("open");
      term.focus();
      const un = await onDockerStreamEnd(sid, (p) => {
        if (genRef.current !== gen) return;
        streamRef.current = null;
        setStatus("closed");
        const code = p.exit_code != null ? ` (exit ${p.exit_code})` : "";
        const why = p.error ? `：${p.error}` : "";
        term.write(`\r\n\x1b[90m── ${t("已結束")}${code}${why} · ${t("按 Enter 重新連線")} ──\x1b[0m\r\n`);
      });
      if (genRef.current !== gen) un();
      else unlistenRef.current = un;
    } catch (e: any) {
      if (genRef.current !== gen) return;
      setStatus("closed");
      term.write(`\r\n\x1b[91m${e?.message ?? String(e)}\x1b[0m\r\n`);
    }
  }, [connId, container, cmd, user, close, t]);

  useEffect(() => close, [close]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-fg/10 bg-bar text-xs">
        <Input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void open(); }}
          placeholder={t("指令（留空＝自動 bash / sh）")}
          className="w-64"
        />
        <Input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void open(); }}
          placeholder={t("使用者（選填，如 root）")}
          className="w-44"
        />
        <Button icon={RefreshCw} onClick={() => void open()} loading={status === "connecting"} disabled={!running}>
          {status === "open" ? t("重新連線") : t("連線")}
        </Button>
        {status === "open" && (
          <Button icon={Unplug} variant="ghost" onClick={() => {
            close();
            setStatus("closed");
            xt.current?.term.write(`\r\n\x1b[90m── ${t("已中斷")} ──\x1b[0m\r\n`);
          }}>
            {t("中斷")}
          </Button>
        )}
        {!running && <span className="text-warning">{t("容器未在執行，無法開啟 shell")}</span>}
      </div>
      <XtermView
        autoFocus
        className="flex-1 p-1 bg-inset"
        onData={(b64) => {
          const sid = streamRef.current;
          if (sid) void api.dockerExecWrite(sid, b64).catch(() => undefined);
          else if (statusRef.current === "closed" && b64 === "DQ==") void open(); // Enter（\r）重新連線
        }}
        onResize={(cols, rows) => {
          const sid = streamRef.current;
          if (sid) void api.dockerExecResize(sid, cols, rows).catch(() => undefined);
        }}
        onReady={(h) => {
          xt.current = h;
          if (running) void open();
          else h.term.write(`\x1b[90m── ${t("容器未在執行，無法開啟 shell")} ──\x1b[0m\r\n`);
          return () => { xt.current = null; };
        }}
      />
    </div>
  );
}
