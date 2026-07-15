import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Play, Pause, Trash2, RefreshCw, Send } from "lucide-react";
import {
  api,
  onKafkaError,
  onKafkaMessage,
  onKafkaScanProgress,
  type KafkaMessage,
  type KafkaPartitionInfo,
  type KafkaScanProgress,
  type KafkaStartPosition,
} from "./api";
import Icon from "./ui/Icon";
import { useT } from "./i18n";
import KafkaProduceDialog from "./KafkaProduceDialog";
import type { UnlistenFn } from "@tauri-apps/api/event";

type StartMode = "beginning" | "end" | "offset" | "timestamp";
type Deser = "auto" | "string" | "json" | "hex" | "avro";

// tail ring buffer 上限（守住記憶體，仿 PubSubPanel MAX_LINES）。
const MAX_ROWS = 5000;

// Kafka 訊息瀏覽器（TableView 內嵌）：一次性消費 + live-tail + 明細窗格。
export default function KafkaMessageBrowser({ connId, topic }: { connId: string; topic: string }) {
  const t = useT();
  const [partition, setPartition] = useState<number | null>(null);
  const [startMode, setStartMode] = useState<StartMode>("end");
  const [offsetInput, setOffsetInput] = useState("0");
  const [tsInput, setTsInput] = useState("");
  const [limit, setLimit] = useState(200);
  const [rows, setRows] = useState<KafkaMessage[]>([]);
  const [selected, setSelected] = useState<KafkaMessage | null>(null);
  const [filter, setFilter] = useState("");
  const [tailing, setTailing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [partitions, setPartitions] = useState<KafkaPartitionInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [producing, setProducing] = useState(false);
  // 進階列（反序列化等）。任一進階條件作用中則預設展開。
  const [advOpen, setAdvOpen] = useState(false);
  const [keyDeser, setKeyDeser] = useState<Deser>("auto");
  const [valueDeser, setValueDeser] = useState<Deser>("auto");
  // 搜尋更多（掃描直到命中 limit 筆）。
  const [searchMore, setSearchMore] = useState(false);
  const [maxScan, setMaxScan] = useState(50000);
  const [scanProg, setScanProg] = useState<KafkaScanProgress | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const advActive = keyDeser !== "auto" || valueDeser !== "auto" || searchMore;

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const unlistenErrRef = useRef<UnlistenFn | null>(null);
  const pausedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // 載入分區清單（供分區下拉 + watermark 顯示）。
  useEffect(() => {
    let alive = true;
    api
      .kafkaTopicPartitions(connId, topic)
      .then((p) => alive && setPartitions(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connId, topic]);

  // 卸載：收掉監聽 + 停 tail。
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenErrRef.current?.();
      api.kafkaTailStop(connId).catch(() => {});
    };
  }, [connId]);

  useEffect(() => {
    if (tailing && !paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows, tailing, paused]);

  const buildStart = (): KafkaStartPosition => {
    switch (startMode) {
      case "beginning":
        return { type: "beginning" };
      case "offset":
        return { type: "offset", offset: Number(offsetInput) || 0 };
      case "timestamp":
        return { type: "timestamp", ts: tsInput ? new Date(tsInput).getTime() : Date.now() };
      default:
        return { type: "end" };
    }
  };

  const consume = async () => {
    setBusy(true);
    setErr(null);
    setScanProg(null);
    setScanNote(null);
    // 掃描模式時把用戶端快速篩選字串下推為伺服端子字串篩選（才有「搜尋更多」意義）。
    const serverFilter = searchMore && filter.trim() ? filter.trim() : null;
    let unlistenProg: null | (() => void) = null;
    try {
      if (searchMore) {
        unlistenProg = await onKafkaScanProgress(connId, (p) => {
          if (p.topic === topic) setScanProg(p);
        });
      }
      const res = await api.kafkaConsume(connId, topic, {
        partition,
        start: buildStart(),
        limit,
        filter: serverFilter,
        key_deser: keyDeser === "auto" ? null : keyDeser,
        value_deser: valueDeser === "auto" ? null : valueDeser,
        scan: searchMore ? { max_scan: Math.max(1, maxScan) } : null,
      });
      setRows(res.messages);
      setSelected(res.messages.length ? res.messages[res.messages.length - 1] : null);
      if (searchMore) {
        const parts: string[] = [
          t("已掃描 {scanned} 筆 · 命中 {matched}", { scanned: res.scanned, matched: res.matched }),
        ];
        if (res.reached_end) parts.push(t("已掃到主題末端"));
        if (res.eval_errors > 0) parts.push(t("{n} 筆訊息評估失敗已略過", { n: res.eval_errors }));
        setScanNote(parts.join(" · "));
      }
    } catch (e: any) {
      setErr(e?.message ?? t("消費失敗"));
    } finally {
      unlistenProg?.();
      setScanProg(null);
      setBusy(false);
    }
  };

  const cancelScan = () => { api.kafkaJobCancel(connId, "scan").catch(() => {}); };

  const startTail = async () => {
    setErr(null);
    try {
      if (!unlistenRef.current) {
        unlistenRef.current = await onKafkaMessage(connId, (m) => {
          if (m.topic !== topic) return; // 額外保險（後端每連線一個 tail）
          if (pausedRef.current) return;
          setRows((prev) => {
            const next = [...prev, m];
            return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
          });
        });
      }
      if (!unlistenErrRef.current) {
        unlistenErrRef.current = await onKafkaError((msg) => setErr(msg));
      }
      await api.kafkaTailStart(connId, topic, partition, { type: "end" });
      setTailing(true);
    } catch (e: any) {
      setErr(e?.message ?? t("啟動即時接收失敗"));
    }
  };

  const stopTail = async () => {
    try {
      await api.kafkaTailStop(connId);
    } catch {
      /* 忽略 */
    }
    setTailing(false);
  };

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return rows;
    return rows.filter(
      (m) =>
        (m.key ?? "").toLowerCase().includes(f) ||
        (m.value ?? "").toLowerCase().includes(f) ||
        m.headers.some((h) => `${h.key}=${h.value}`.toLowerCase().includes(f))
    );
  }, [rows, filter]);

  const fmtTs = (ts: number) => (ts >= 0 ? new Date(ts).toLocaleString() : "-");

  const prettyValue = (m: KafkaMessage): string => {
    if (m.value == null) return "(null)";
    if (m.value_encoding === "json" || m.value_encoding === "avro") {
      try {
        return JSON.stringify(JSON.parse(m.value), null, 2);
      } catch {
        return m.value;
      }
    }
    return m.value;
  };

  return (
    <div className="flex flex-col h-full min-h-0 text-xs">
      {/* 工具列 */}
      <div className="px-3 py-2 border-b border-fg/10 flex flex-wrap items-center gap-2">
        <label className="text-fg/40">{t("分區")}</label>
        <select
          value={partition ?? ""}
          onChange={(e) => setPartition(e.target.value === "" ? null : Number(e.target.value))}
          className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent"
        >
          <option value="">{t("全部")}</option>
          {partitions.map((p) => (
            <option key={p.partition} value={p.partition}>
              #{p.partition} ({p.low}–{p.high})
            </option>
          ))}
        </select>

        <label className="text-fg/40">{t("起點")}</label>
        <select
          value={startMode}
          onChange={(e) => setStartMode(e.target.value as StartMode)}
          className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent"
        >
          <option value="end">{t("最新")}</option>
          <option value="beginning">{t("最舊")}</option>
          <option value="offset">Offset</option>
          <option value="timestamp">{t("時間")}</option>
        </select>
        {startMode === "offset" && (
          <input
            value={offsetInput}
            onChange={(e) => setOffsetInput(e.target.value)}
            className="w-24 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent"
            placeholder="offset"
          />
        )}
        {startMode === "timestamp" && (
          <input
            type="datetime-local"
            value={tsInput}
            onChange={(e) => setTsInput(e.target.value)}
            className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent"
          />
        )}

        <label className="text-fg/40">{t("筆數")}</label>
        <input
          type="number"
          value={limit}
          onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
          className="w-20 bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent"
        />

        <button
          type="button"
          onClick={consume}
          disabled={busy || tailing}
          className="px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40 inline-flex items-center gap-1"
        >
          <Icon icon={RefreshCw} size={13} /> {t("查詢")}
        </button>
        <button
          type="button"
          onClick={() => (tailing ? stopTail() : startTail())}
          className={`px-3 py-1 rounded border border-fg/15 hover:bg-fg/10 inline-flex items-center gap-1 ${tailing ? "text-emerald-300" : "text-fg/60"}`}
        >
          {tailing ? <><Icon icon={Pause} size={13} /> {t("停止")}</> : <><Icon icon={Play} size={13} /> {t("即時")}</>}
        </button>
        {tailing && (
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className={`px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 ${paused ? "text-amber-300" : "text-fg/60"}`}
          >
            {paused ? t("繼續") : t("暫停")}
          </button>
        )}
        <button
          type="button"
          onClick={() => { setRows([]); setSelected(null); }}
          className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"
        >
          <Icon icon={Trash2} size={13} /> {t("清空")}
        </button>
        <button
          type="button"
          onClick={() => setProducing(true)}
          className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60 inline-flex items-center gap-1"
        >
          <Icon icon={Send} size={13} /> {t("發佈")}
        </button>
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className={`px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 inline-flex items-center gap-1 ${advActive ? "text-accent" : "text-fg/60"}`}
          title={t("進階選項")}
        >
          <Icon icon={advOpen ? ChevronUp : ChevronDown} size={13} /> {t("進階")}
          {advActive && <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block" />}
        </button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("篩選 key / value / header…")}
          className="flex-1 min-w-[140px] bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent"
        />
      </div>

      {/* 進階列：反序列化選擇（之後擴充：篩選模式 / 搜尋更多 / 投影） */}
      {(advOpen || advActive) && (
        <div className="px-3 py-2 border-b border-fg/10 flex flex-wrap items-center gap-2 bg-inset/40">
          <label className="text-fg/40">{t("Key 反序列化")}</label>
          <select
            value={keyDeser}
            onChange={(e) => setKeyDeser(e.target.value as Deser)}
            className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent"
          >
            <option value="auto">{t("自動")}</option>
            <option value="string">{t("字串")}</option>
            <option value="json">JSON</option>
            <option value="hex">Hex</option>
            <option value="avro">Avro（SR）</option>
          </select>
          <label className="text-fg/40">{t("Value 反序列化")}</label>
          <select
            value={valueDeser}
            onChange={(e) => setValueDeser(e.target.value as Deser)}
            className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent"
          >
            <option value="auto">{t("自動")}</option>
            <option value="string">{t("字串")}</option>
            <option value="json">JSON</option>
            <option value="hex">Hex</option>
            <option value="avro">Avro（SR）</option>
          </select>
          <span className="w-px h-4 bg-fg/10" />
          <label className="flex items-center gap-1 cursor-pointer text-fg/60">
            <input type="checkbox" checked={searchMore} onChange={(e) => setSearchMore(e.target.checked)} />
            {t("搜尋更多")}
          </label>
          {searchMore && (
            <>
              <label className="text-fg/40">{t("最多掃描")}</label>
              <input
                type="number" min={1} value={maxScan}
                onChange={(e) => setMaxScan(Math.max(1, Number(e.target.value) || 1))}
                className="w-24 bg-inset border border-fg/10 rounded px-2 py-1 mono outline-none focus:border-accent"
              />
              <span className="text-fg/30">{t("掃描直到命中「筆數」筆或掃到上限；配合上方篩選框")}</span>
            </>
          )}
          {!searchMore && <span className="text-fg/30">{t("套用於下一次「查詢」（即時接收維持自動判斷）")}</span>}
        </div>
      )}

      {/* 掃描進度 / 結果摘要 */}
      {(scanProg || scanNote) && (
        <div className="px-3 py-1.5 border-b border-fg/10 flex items-center gap-3 text-fg/50">
          {scanProg ? (
            <>
              <span>{t("已掃描 {scanned} 筆 · 命中 {matched}", { scanned: scanProg.scanned, matched: scanProg.matched })}</span>
              <button type="button" onClick={cancelScan} className="px-2 py-0.5 rounded border border-fg/15 hover:bg-fg/10 text-fg/60">
                {t("取消掃描")}
              </button>
            </>
          ) : (
            <span>{scanNote}</span>
          )}
        </div>
      )}

      {err && <div className="px-3 py-1.5 text-red-400 mono break-all border-b border-fg/10">{err}</div>}

      {/* 訊息表格 + 明細 */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-auto">
          <table className="w-full text-left mono">
            <thead className="sticky top-0 bg-app text-fg/40">
              <tr>
                <th className="px-2 py-1 font-normal">P</th>
                <th className="px-2 py-1 font-normal">Offset</th>
                <th className="px-2 py-1 font-normal">{t("時間")}</th>
                <th className="px-2 py-1 font-normal">Key</th>
                <th className="px-2 py-1 font-normal">Value</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m, i) => (
                <tr
                  key={`${m.partition}-${m.offset}-${i}`}
                  onClick={() => setSelected(m)}
                  className={`cursor-pointer border-b border-fg/5 hover:bg-fg/5 ${selected === m ? "bg-accent/10" : ""}`}
                >
                  <td className="px-2 py-1 text-fg/50">{m.partition}</td>
                  <td className="px-2 py-1 text-fg/50">{m.offset}</td>
                  <td className="px-2 py-1 text-fg/40 whitespace-nowrap">{fmtTs(m.timestamp)}</td>
                  <td className="px-2 py-1 text-emerald-400/80 max-w-[160px] truncate" title={m.key ?? ""}>{m.key ?? ""}</td>
                  <td className="px-2 py-1 text-fg/80 max-w-[420px] truncate" title={m.value ?? ""}>{m.value ?? ""}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-fg/30">
                    {t("按「查詢」讀取近期訊息，或開「即時」接收新訊息。")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div ref={bottomRef} />
        </div>

        {/* 明細窗格 */}
        <div className="w-[40%] max-w-[520px] border-l border-fg/10 overflow-auto p-3">
          {selected ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-fg/60">
                <span className="text-fg/35">partition</span><span>{selected.partition}</span>
                <span className="text-fg/35">offset</span><span>{selected.offset}</span>
                <span className="text-fg/35">timestamp</span><span>{fmtTs(selected.timestamp)}</span>
                <span className="text-fg/35">encoding</span>
                <span>
                  {selected.value_encoding}
                  {selected.schema_id != null ? ` · schema #${selected.schema_id}` : ""}
                </span>
                {selected.truncated && (
                  <><span className="text-amber-400/70">{t("已截斷")}</span><span className="text-amber-400/70">{selected.value_bytes} bytes</span></>
                )}
              </div>
              {selected.key != null && (
                <div>
                  <div className="text-fg/35 mb-1">Key</div>
                  <pre className="bg-inset rounded p-2 mono whitespace-pre-wrap break-all">{selected.key}</pre>
                </div>
              )}
              <div>
                <div className="text-fg/35 mb-1">Value</div>
                <pre className="bg-inset rounded p-2 mono whitespace-pre-wrap break-all">{prettyValue(selected)}</pre>
              </div>
              {selected.headers.length > 0 && (
                <div>
                  <div className="text-fg/35 mb-1">Headers</div>
                  <table className="w-full mono">
                    <tbody>
                      {selected.headers.map((h, i) => (
                        <tr key={i} className="border-b border-fg/5">
                          <td className="px-1 py-0.5 text-emerald-400/80 align-top">{h.key}</td>
                          <td className="px-1 py-0.5 text-fg/70 break-all">{h.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="text-fg/30">{t("點一列查看訊息內容。")}</div>
          )}
        </div>
      </div>

      {producing && (
        <KafkaProduceDialog connId={connId} topic={topic} onClose={() => setProducing(false)} />
      )}
    </div>
  );
}
