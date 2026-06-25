import { useEffect, useRef, useState } from "react";
import { CircleDot } from "lucide-react";
import { api } from "./api";
import { uiConfirm } from "./ui";
import { isDangerousRedisCommand } from "./sql";
import Icon from "./ui/Icon";
import { Modal } from "./ui/index";

interface Entry {
  db: string;
  cmd: string;
  lines: string[];
  error?: boolean;
}

// Redis 命令列：仿 Another Redis Desktop Manager 的 Console。
// 沿用既有 query 通道（後端已支援 "db:CMD" 前綴語法與任意指令）。
// 指令歷史以 ↑/↓ 瀏覽；輸入 clear 可清空畫面。
export default function RedisConsole({ connId, connName, initialDb = "0", onClose }: {
  connId: string; connName: string; initialDb?: string; onClose: () => void;
}) {
  const [db, setDb] = useState(initialDb);
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState<number>(-1); // -1 = 不在歷史中
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 新輸出時自動捲到底。
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const run = async () => {
    const cmd = input.trim();
    if (!cmd || busy) return;
    setHistory((h) => (h[h.length - 1] === cmd ? h : [...h, cmd]));
    setHistPos(-1);
    setInput("");

    // 本地指令：清空畫面。
    if (cmd.toLowerCase() === "clear" || cmd.toLowerCase() === "cls") {
      setEntries([]);
      return;
    }

    // FLUSHALL / FLUSHDB 會清空資料且無法復原，先確認；取消則還原輸入方便修改。
    if (isDangerousRedisCommand(cmd)) {
      const ok = await uiConfirm("FLUSHALL / FLUSHDB 會清空資料庫且無法復原。確定執行？",
        { title: "危險指令確認", danger: true, confirmText: "仍要執行" });
      if (!ok) { setInput(cmd); inputRef.current?.focus(); return; }
    }

    // 已自帶 "n:" DB 前綴（限 1~18 位數字，確保後端 i64 也能解析）則照送並沿用該 DB，
    // 否則套用目前選取的 DB。effDb 用於畫面標註，避免結果歸錯 DB。
    const m = /^(\d{1,18}):/.exec(cmd);
    const effDb = m ? m[1] : db;
    const wire = m ? cmd : `${db}:${cmd}`;
    setBusy(true);
    try {
      const res = await api.runQuery(connId, wire);
      const lines = res.rows.length
        ? res.rows.map((r) => r[0] ?? "(nil)")
        : [`(已執行；影響 ${res.rows_affected} 列)`];
      setEntries((e) => [...e, { db: effDb, cmd, lines }]);
    } catch (err: any) {
      setEntries((e) => [...e, { db: effDb, cmd, lines: [err?.message ?? "錯誤"], error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); run(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) { e.preventDefault(); setEntries([]); return; }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!history.length) return;
      const pos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      setHistPos(pos);
      setInput(history[pos]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histPos < 0) return;
      const pos = histPos + 1;
      if (pos >= history.length) { setHistPos(-1); setInput(""); }
      else { setHistPos(pos); setInput(history[pos]); }
    }
  };

  return (
    <Modal
      onClose={onClose}
      size="lg"
      zClass="z-50"
      className="h-[70vh]"
      bodyClassName="p-0 flex flex-col overflow-hidden"
      title={
        <div className="flex items-center gap-3 w-full">
          <Icon icon={CircleDot} size={14} className="text-red-400" />
          <span className="font-medium text-sm">命令列 · {connName}</span>
          <label className="ml-auto text-xs text-fg/50 flex items-center gap-1.5">
            DB
            <input value={db} onChange={(e) => setDb(e.target.value.replace(/[^\d]/g, "") || "0")}
              title="目前資料庫；指令可自帶 n: 前綴覆寫"
              className="w-12 bg-inset border border-fg/10 rounded px-1.5 py-0.5 text-center mono outline-none focus:border-accent" />
          </label>
          <button type="button" onClick={() => setEntries([])} title="清空畫面"
            className="text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70">清空</button>
        </div>
      }
    >
      <div className="flex-1 overflow-auto p-3 mono text-xs leading-relaxed" onClick={() => inputRef.current?.focus()}>
        {entries.length === 0 && (
          <div className="text-fg/30">輸入 Redis 指令並按 Enter，如 GET key、HGETALL key、KEYS *。輸入 clear 或按 Ctrl+L 清空。</div>
        )}
        {entries.map((en, i) => (
          <div key={i} className="mb-1.5">
            <div className="text-emerald-400/90">
              <span className="text-fg/30">{en.db}&gt;</span> {en.cmd}
            </div>
            {en.lines.map((ln, j) => (
              <div key={j} className={`whitespace-pre-wrap break-all ${en.error ? "text-red-400" : "text-fg/75"}`}>
                {en.lines.length > 1 && !en.error ? <span className="text-fg/30">{j + 1}) </span> : null}{ln}
              </div>
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-fg/10 px-3 py-2 flex items-center gap-2 mono text-sm">
        <span className="text-fg/30 shrink-0">{db}&gt;</span>
        <input ref={inputRef} autoFocus value={input} disabled={busy}
          onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
          placeholder={busy ? "執行中…" : "輸入指令…"}
          className="flex-1 bg-transparent outline-none text-fg/90 placeholder:text-fg/40/25" />
      </div>
    </Modal>
  );
}
