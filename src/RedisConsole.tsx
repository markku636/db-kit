import { useEffect, useRef, useState } from "react";
import { CircleDot } from "lucide-react";
import { api } from "./api";
import { uiConfirm } from "./ui";
import { useStore } from "./store";
import { fmtElapsed, isDangerousRedisCommand, isReadOnlyRedisCommand } from "./sql";
import { completeRedisCommand, isBlockingKeysCommand, redisCommandHint } from "./redisCommandHints";
import {
  formatRedisConsoleLines, loadRedisConsoleHistory, recordRedisConsoleHistory,
  REDIS_CONSOLE_HISTORY_KEY, redisConsoleHistoryKey, serializeRedisConsoleHistory,
} from "./redisConsoleFormat";
import { normalizeRedisDbInput, parseRedisDbPrefix } from "./redisUiFormat";
import Icon from "./ui/Icon";
import { Modal } from "./ui/index";
import { useT } from "./i18n";

interface Entry {
  db: string;
  cmd: string;
  lines: string[];
  error?: boolean;
  /** 執行耗時（毫秒），仿 ARDM 的 execution log。 */
  ms?: number;
}

// Redis 命令列：仿 Another Redis Desktop Manager 的 Console。
// 沿用既有 query 通道（後端已支援 "db:CMD" 前綴語法與任意指令）。
// 指令歷史以 ↑/↓ 瀏覽；輸入 clear 可清空畫面。
export default function RedisConsole({ connId, connName, initialDb = "0", onClose }: {
  connId: string; connName: string; initialDb?: string; onClose: () => void;
}) {
  const t = useT();
  // 唯讀連線：Console 是任意指令通道，同樣要擋寫入（否則唯讀模式等於形同虛設）。
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const [db, setDb] = useState(initialDb);
  const [availableDbs, setAvailableDbs] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    api.listDatabases(connId).then((dbs) => { if (alive) setAvailableDbs(dbs.map(String)); }).catch(() => { /* 保留自由輸入 */ });
    return () => { alive = false; };
  }, [connId]);
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  // 指令歷史跨視窗保存（仿 Another Redis Desktop Manager 的 execution log）：
  // 關掉主控台再開，↑ 仍能叫回之前打過的指令。
  const [history, setHistory] = useState<string[]>(() => {
    try {
      // 舊版只有一份全域歷史，首次讀取時沿用，之後寫入各自的 key。
      const raw = localStorage.getItem(redisConsoleHistoryKey(connId)) ?? localStorage.getItem(REDIS_CONSOLE_HISTORY_KEY);
      return loadRedisConsoleHistory(raw);
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(redisConsoleHistoryKey(connId), serializeRedisConsoleHistory(history)); }
    catch { /* localStorage 不可用時只保存在記憶體 */ }
  }, [history, connId]);
  const [histPos, setHistPos] = useState<number>(-1); // -1 = 不在歷史中
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 目前輸入的指令語法 / 候選（redis-cli 風格的即時提示）。
  const hint = redisCommandHint(input);
  const inputRef = useRef<HTMLInputElement>(null);

  // 新輸出時自動捲到底。
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const run = async () => {
    const cmd = input.trim();
    if (!cmd || busy) return;
    const currentDb = normalizeRedisDbInput(db);
    if (currentDb == null) {
      setInput("");
      setEntries((e) => [...e, { db, cmd, error: true, lines: [t("資料庫索引無效，請輸入 1～18 位數字。")] }]);
      return;
    }
    setInput("");

    // 本地指令：清空畫面。
    if (cmd.toLowerCase() === "clear" || cmd.toLowerCase() === "cls") {
      setEntries([]);
      return;
    }

    // 唯讀連線：只放行白名單內的讀取指令（對齊 SQL 查詢編輯器在唯讀模式下擋寫入 / DDL 的行為）。
    // 不送出、直接在畫面上回報，使用者才知道是被本機擋下而非伺服器拒絕。
    if (readonly && !isReadOnlyRedisCommand(cmd)) {
      setEntries((e) => [...e, {
        db, cmd, error: true,
        lines: [t("此連線為唯讀，已擋下非讀取指令。可在連線右鍵關閉「唯讀模式」。")],
      }]);
      inputRef.current?.focus();
      return;
    }

    // FLUSHALL / FLUSHDB 會清空資料且無法復原，先確認；取消則還原輸入方便修改。
    if (isDangerousRedisCommand(cmd)) {
      const ok = await uiConfirm(t("FLUSHALL / FLUSHDB 會清空資料庫且無法復原。確定執行？"),
        { title: t("危險指令確認"), danger: true, confirmText: t("仍要執行") });
      if (!ok) { setInput(cmd); inputRef.current?.focus(); return; }
    }

    // KEYS 一次掃完整個 keyspace，期間 Redis 不處理任何其他指令；鍵多的正式環境會整台卡住好幾秒。
    if (isBlockingKeysCommand(cmd)) {
      const ok = await uiConfirm(t("KEYS 會一次掃描所有鍵，掃描期間 Redis 無法處理其他指令；鍵很多時正式環境會卡住。建議改用 SCAN 0 MATCH 樣式 COUNT 1000 分批查。仍要執行 KEYS？"),
        { title: t("可能阻塞 Redis"), danger: true, confirmText: t("仍要執行") });
      if (!ok) { setInput(cmd); inputRef.current?.focus(); return; }
    }

    // 已自帶 "n:" DB 前綴（限 1~18 位數字，確保後端 i64 也能解析）則照送並沿用該 DB，
    // 否則套用目前選取的 DB。effDb 用於畫面標註，避免結果歸錯 DB。
    const p = parseRedisDbPrefix(cmd);
    const effDb = p?.db ?? currentDb;
    const wire = p ? `${p.db}:${p.rest}` : `${currentDb}:${cmd}`;
    // 歷史只在確定要送出的指令上記一筆：取消 FLUSH/KEYS 確認或沒通過唯讀擋下的
    // 指令不該在按 ↑ 時跑出來（以前在確認前就記，取消還留一條 FLUSHALL）。
    setHistory((h) => recordRedisConsoleHistory(h, cmd));
    setHistPos(-1);
    setBusy(true);
    const t0 = performance.now();
    try {
      const res = await api.runQuery(connId, wire);
      const lines = formatRedisConsoleLines(res, t);
      setEntries((e) => [...e, { db: effDb, cmd, lines, ms: performance.now() - t0 }]);
    } catch (err: any) {
      setEntries((e) => [...e, { db: effDb, cmd, lines: [err?.message ?? t("錯誤")], error: true, ms: performance.now() - t0 }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); run(); return; }
    // Tab：補完指令名稱（只在還沒開始打參數時）。
    if (e.key === "Tab" && !e.shiftKey) {
      const done = completeRedisCommand(input);
      if (done) { e.preventDefault(); setInput(done); }
      return;
    }
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
          <span className="font-medium text-sm">{t("命令列 ·")} {connName}</span>
          <label className="ml-auto text-xs text-fg/50 flex items-center gap-1.5">
            DB
            <input value={db} list="redis-console-dbs" onChange={(e) => setDb(e.target.value.replace(/[^\d]/g, "").slice(0, 18))}
              title={t("目前資料庫；指令可自帶 n: 前綴覆寫")}
              className="w-12 bg-inset border border-fg/10 rounded px-1.5 py-0.5 text-center mono outline-none focus:border-accent" />
            <datalist id="redis-console-dbs">
              {availableDbs.map((d) => <option key={d} value={d} />)}
            </datalist>
          </label>
          <button type="button" onClick={() => setEntries([])} title={t("清空畫面")}
            className="text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70">{t("清空")}</button>
        </div>
      }
    >
      <div className="flex-1 overflow-auto p-3 mono text-xs leading-relaxed" onClick={() => inputRef.current?.focus()}>
        {entries.length === 0 && (
          <div className="text-fg/30">{t("輸入 Redis 指令並按 Enter，如 GET key、HGETALL key、SCAN 0 MATCH user:*。Tab 補完指令名稱；輸入 clear 或按 Ctrl+L 清空。")}</div>
        )}
        {entries.map((en, i) => (
          <div key={i} className="mb-1.5">
            <div className="text-emerald-400/90">
              <span className="text-fg/30">{en.db}&gt;</span> {en.cmd}
              {en.ms != null && <span className="text-fg/25"> · {fmtElapsed(en.ms)}</span>}
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

      {hint.syntax != null && (
        <div className="border-t border-fg/10 px-3 py-1 mono text-[11px] text-fg/45 truncate" data-redis-hint title={`${hint.command} ${hint.syntax}`}>
          <span className="text-fg/70">{hint.command}</span> {hint.syntax}
        </div>
      )}
      {hint.syntax == null && hint.candidates.length > 0 && (
        <div className="border-t border-fg/10 px-3 py-1 mono text-[11px] text-fg/40 truncate" data-redis-hint title={t("按 Tab 補完第一個")}>
          {hint.candidates.join("  ")}
        </div>
      )}
      <div className="border-t border-fg/10 px-3 py-2 flex items-center gap-2 mono text-sm">
        <span className="text-fg/30 shrink-0">{db}&gt;</span>
        <input ref={inputRef} autoFocus value={input} disabled={busy}
          onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
          placeholder={busy ? t("執行中…") : t("輸入指令…")}
          className="flex-1 bg-transparent outline-none text-fg/90 placeholder:text-fg/40/25" />
      </div>
    </Modal>
  );
}
